package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/waynehoover/trewsync/internal/control"
	"github.com/waynehoover/trewsync/internal/dirlock"
	"github.com/waynehoover/trewsync/internal/gitexport"
	"github.com/waynehoover/trewsync/internal/mcp"
	"github.com/waynehoover/trewsync/internal/search"
	"github.com/waynehoover/trewsync/internal/server"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// operator answers the control socket's requests for one served vault, and is
// also what the administrative commands run in their own process when no
// server is running, so the two ways of asking share one set of rules.
type operator struct {
	srv   *server.Server
	vault string
	// urls are the addresses the server knows itself by, which invite
	// strings carry unless a request names its own.
	urls []string
	// mcp is the running MCP endpoint, or nil when `serve` runs without
	// --mcp or no server is running at all.
	mcp mcpHooks
	// index is the search index the endpoint keeps, or nil, and started when
	// `serve` started: what `status` reports beside the server's own.
	index   *search.Index
	started time.Time
	// dataDir is where the configuration file is, flags what serve was
	// given over it, and export the running git export, nil with no server.
	dataDir string
	flags   *overlay
	export  *gitexport.Exporter
}

// mcpHooks is what the token commands tell a running MCP endpoint.
type mcpHooks interface {
	// FlushUsage writes the use counts it is holding, so a listing shows
	// every request made until now.
	FlushUsage()
	// Revoked ends the requests a revoked token has in flight. Each would
	// lose at its own recheck anyway; this makes it lose now.
	Revoked(tokenID string)
	// SetConventions gives the daily-note tools the settings `trewd config
	// set daily.*` wrote.
	SetConventions(mcp.Conventions)
}

// Handle does one request.
func (o *operator) Handle(ctx context.Context, req control.Request) control.Reply {
	if req.Vault != "" && req.Vault != o.vault {
		return control.Refused(control.CodeBadRequest, fmt.Sprintf(
			"this server serves vault %q, not %q", o.vault, req.Vault))
	}
	switch req.Op {
	case "invite":
		return o.invite(req)
	case "devices":
		ds, invites, err := o.srv.OperatorDevices(o.vault)
		if err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
		dj, err := json.Marshal(ds)
		if err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
		ij, err := json.Marshal(invites)
		if err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
		return control.Reply{Devices: &control.Devices{Devices: dj, Invites: ij}}
	case "revoke":
		if !store.ValidDeviceID(req.DeviceID) {
			return control.Refused(control.CodeBadRequest, fmt.Sprintf(
				"%q is not a device id; `trewd devices` lists them", req.DeviceID))
		}
		rev, err := o.srv.OperatorRevoke(o.vault, req.DeviceID)
		switch {
		case errors.Is(err, store.ErrUnknownDevice):
			return control.Refused(control.CodeNoDevice, fmt.Sprintf(
				"vault %q has no device %q; `trewd devices` lists the ones it has", o.vault, req.DeviceID))
		case err != nil:
			return control.Refused(control.CodeInternal, err.Error())
		}
		return control.Reply{Revoked: &control.Revoked{
			DeviceID: req.DeviceID, Closed: rev.Closed, InvitesCancelled: rev.InvitesCancelled,
		}}
	case "uninvite":
		err := o.srv.OperatorUninvite(o.vault, req.Invite)
		switch {
		case errors.Is(err, store.ErrNoInvite):
			return control.Refused(control.CodeNoInvite, fmt.Sprintf(
				"vault %q has no outstanding invite %q: it may have expired, or been redeemed, in which "+
					"case it is a device now; `trewd devices` lists both", o.vault, req.Invite))
		case err != nil:
			return control.Refused(control.CodeInternal, err.Error())
		}
		return control.Reply{Canceled: &control.Canceled{Invite: req.Invite}}
	case "mcp-token":
		return o.mcpToken(req)
	case "mcp-tokens":
		if o.mcp != nil {
			o.mcp.FlushUsage()
		}
		list, err := o.srv.OperatorMCPTokens(o.vault)
		if err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
		b, err := json.Marshal(list)
		if err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
		return control.Reply{MCPTokens: &control.MCPTokens{Tokens: b, Vault: o.vault}}
	case "mcp-revoke":
		if !store.ValidMCPTokenID(req.TokenID) {
			return control.Refused(control.CodeBadRequest, fmt.Sprintf(
				"%q is not an MCP token id; `trewd mcp-token -list` lists them", req.TokenID))
		}
		err := o.srv.OperatorRevokeMCPToken(o.vault, req.TokenID)
		switch {
		case errors.Is(err, store.ErrUnknownMCPToken):
			return control.Refused(control.CodeNoToken, fmt.Sprintf(
				"vault %q has no MCP token %q; `trewd mcp-token -list` lists the ones it has", o.vault, req.TokenID))
		case err != nil:
			return control.Refused(control.CodeInternal, err.Error())
		}
		if o.mcp != nil {
			o.mcp.Revoked(req.TokenID)
		}
		return control.Reply{MCPRevoked: &control.MCPRevoked{TokenID: req.TokenID}}
	case "audit":
		if req.Since < 0 || req.After < 0 {
			return control.Refused(control.CodeBadRequest, "an audit starts at a time and a sequence number, neither negative")
		}
		ops, more, epoch, err := o.srv.OperatorAudit(o.vault, req.Since, req.After)
		if err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
		b, err := json.Marshal(ops)
		if err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
		return control.Reply{Audit: &control.Audit{Operations: b, More: more, Vault: o.vault, Epoch: epoch}}
	case "undo":
		return o.undo(req)
	case "restore":
		return o.restore(req)
	case "status":
		return o.status()
	case "config-show", "config-set", "config-unset", "git-export":
		return o.configure(ctx, req)
	}
	return control.Refused(control.CodeBadRequest, fmt.Sprintf("unknown request %q", req.Op))
}

// mcpToken mints an MCP token: read scope unless write is asked for, and the
// default lifetime unless another, or none, is.
func (o *operator) mcpToken(req control.Request) control.Reply {
	scope := store.MCPScope(req.Scope)
	if scope == "" {
		scope = store.ScopeRead
	}
	if !scope.Valid() {
		return control.Refused(control.CodeBadRequest, fmt.Sprintf("-scope %q: a token's scope is read or write", req.Scope))
	}
	if req.Label == "" {
		return control.Refused(control.CodeBadRequest,
			"a token needs -label: it names the token in the list and is what its writes are recorded as")
	}
	if err := store.CheckName("token", req.Label, store.MaxMCPLabelLen); err != nil {
		return control.Refused(control.CodeBadRequest, err.Error())
	}
	var expiresAt *int64
	switch {
	case req.Never:
	case req.TTLMs < 0:
		return control.Refused(control.CodeBadRequest, "a token cannot expire before it is issued")
	default:
		ttl := time.Duration(req.TTLMs) * time.Millisecond
		if req.TTLMs == 0 {
			ttl = server.DefaultMCPTokenTTL
		}
		at := o.srv.Now().Add(ttl).UnixMilli()
		expiresAt = &at
	}
	tok, err := o.srv.OperatorMCPToken(o.vault, req.Label, scope, expiresAt)
	switch {
	case errors.Is(err, store.ErrBadEntry):
		return control.Refused(control.CodeBadRequest, err.Error())
	case err != nil:
		return control.Refused(control.CodeInternal, err.Error())
	}
	row, err := json.Marshal(tok.MCPToken)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	return control.Reply{MCPToken: &control.MCPToken{Token: row, Secret: store.EncodeToken(tok.Token), Vault: o.vault}}
}

// invite mints one, and formats it for every address it can name, refusing
// before minting anything if there is no address to name.
func (o *operator) invite(req control.Request) control.Reply {
	urls := o.urls
	if req.URL != "" {
		if err := checkInviteURL(req.URL); err != nil {
			return control.Refused(control.CodeBadRequest, fmt.Sprintf("-url %q: %v", req.URL, err))
		}
		urls = []string{req.URL}
	}
	if len(urls) == 0 {
		return control.Refused(control.CodeBadRequest,
			"this server does not know an address devices reach it at, so an invite could name none; "+
				"pass -url wss://your-host:port")
	}
	if err := store.CheckName("invite", req.Label, store.MaxDeviceLen); err != nil {
		return control.Refused(control.CodeBadRequest, err.Error())
	}
	var expiresAt *int64
	switch {
	case req.Never:
	case req.TTLMs < 0:
		return control.Refused(control.CodeBadRequest, "an invite cannot expire before it is issued")
	default:
		ttl := time.Duration(req.TTLMs) * time.Millisecond
		if req.TTLMs == 0 {
			ttl = server.DefaultInviteTTL
		}
		at := time.Now().Add(ttl).UnixMilli()
		expiresAt = &at
	}
	inv, err := o.srv.OperatorInvite(o.vault, req.Label, expiresAt)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	lines, err := formatInvites(inv.Token, urls, o.vault)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	return control.Reply{Invited: &control.Invited{
		Invite: inv.ID, ExpiresAt: inv.ExpiresAt, Vault: o.vault, Strings: lines,
	}}
}

// directURLs is what an invite made without a server carries when -url is not
// given: this machine's addresses on the port `serve` listens on by default.
func directURLs() []string {
	urls, _ := inviteURLs("", ":3003", false)
	return urls
}

// administer sends a request to the server serving dataDir or, when nothing is
// serving it, does it against the store directly.
//
// Directly only under the server lock, taken exclusively, which is what keeps
// a server from starting underneath and is what `serve` itself holds: a
// credential changed behind a running server's back is the failure the socket
// exists to prevent (PLAN.md section 2.3.1). The data lock is taken shared,
// as `serve` takes it, so a purge holds this off and a backup does not.
func administer(dataDir, vault, verb string, req control.Request) (control.Reply, error) {
	if err := requireDataDir(dataDir, verb); err != nil {
		return control.Reply{}, err
	}
	req.Vault = vault
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	reply, err := control.Call(ctx, dataDir, req)
	if err == nil || !errors.Is(err, control.ErrNotServing) {
		return reply, err
	}

	serverLock, err := dirlock.Exclusive(dataDir, dirlock.Server, verb)
	if err != nil {
		return control.Reply{}, locked(err, dataDir, verb,
			"A server holds this data directory and did not answer on its control socket.\n"+
				"Check that it is running, and run this again.")
	}
	defer serverLock.Release()
	dataLock, err := dirlock.Shared(dataDir, dirlock.Data)
	if err != nil {
		return control.Reply{}, locked(err, dataDir, verb, stopFirst)
	}
	defer dataLock.Release()
	st, err := openExisting(dataDir, verb)
	if err != nil {
		return control.Reply{}, err
	}
	defer st.Close()
	if vault == "" {
		vault = defaultVault
	}
	if err := requireVault(st, vault); err != nil {
		return control.Reply{}, err
	}
	srv := server.New(st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv.Serves(vault)
	return (&operator{srv: srv, vault: vault, urls: directURLs()}).Handle(ctx, req), nil
}

// refused turns a refusal into the command's error.
func refused(reply control.Reply) error {
	if reply.Error == nil {
		return nil
	}
	return errors.New(reply.Error.Msg)
}

// adminFlags are the flags every administrative command shares.
func adminFlags(fs *flag.FlagSet) (dataDir, vault *string) {
	return dataFlags(fs), fs.String("vault", "",
		"the vault to administer (default: the one the server serves, or \""+defaultVault+"\" with no server)")
}

/* ---------------------------------------------------------------- *
 * invite
 * ---------------------------------------------------------------- */

// cmdInvite mints an invite and prints it, or writes it to -out and prints
// where. The printed string is the credential: it goes to the operator who
// asked, on the terminal they asked from, and to nothing else.
func cmdInvite(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("invite", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	ttl := fs.Duration("ttl", server.DefaultInviteTTL, "how long the invite works; 0 means it never expires")
	label := fs.String("label", "", "a name for the invite, shown in the device list until it is used")
	outFile := fs.String("out", "", "write the invite to this file, mode 0600, instead of printing it")
	url := fs.String("url", "", "the address the invite names, ws:// or wss:// (default: the server's own)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *ttl < 0 {
		return fmt.Errorf("-ttl %s: an invite cannot expire before it is issued", *ttl)
	}
	reply, err := administer(*dataDir, *vault, "invite", control.Request{
		Op: "invite", TTLMs: ttl.Milliseconds(), Never: *ttl == 0, Label: *label, URL: *url,
	})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	inv := reply.Invited
	when := "does not expire; `trewd uninvite " + inv.Invite + "` cancels it"
	if inv.ExpiresAt != nil {
		when = "expires at " + time.UnixMilli(*inv.ExpiresAt).UTC().Format(time.RFC3339)
	}
	if *outFile != "" {
		if err := writeSecretFile(*outFile, strings.Join(inv.Strings, "\n")+"\n"); err != nil {
			return err
		}
		fmt.Fprintf(out, "Wrote an invite for vault %q to %s. It works once, and %s.\n", inv.Vault, *outFile, when)
		return nil
	}
	fmt.Fprintf(out, "An invite for vault %q. It works once, and %s.\n\n", inv.Vault, when)
	for _, s := range inv.Strings {
		fmt.Fprintf(out, "  %s\n", s)
	}
	if len(inv.Strings) > 1 {
		fmt.Fprintln(out, "\nEach line names one address of this server; use the one the device can reach.")
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * devices
 * ---------------------------------------------------------------- */

// cmdDevices lists the devices that may reach the vault and the invites that
// could still add one, which is the answer to "what can reach my notes".
func cmdDevices(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("devices", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	asJSON := fs.Bool("json", false, "print the list as JSON")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	reply, err := administer(*dataDir, *vault, "list devices", control.Request{Op: "devices"})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	if *asJSON {
		b, err := json.MarshalIndent(reply.Devices, "", "  ")
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "%s\n", b)
		return err
	}
	var devices []wire.DeviceStatus
	var invites []store.Invite
	if err := json.Unmarshal(reply.Devices.Devices, &devices); err != nil {
		return err
	}
	if err := json.Unmarshal(reply.Devices.Invites, &invites); err != nil {
		return err
	}
	fmt.Fprintf(out, "%d devices\n", len(devices))
	for _, d := range devices {
		seen := "never connected"
		if d.LastSeen > 0 {
			seen = "last seen " + time.UnixMilli(d.LastSeen).UTC().Format(time.RFC3339)
		}
		online := ""
		if d.Online {
			online = ", connected now"
		}
		fmt.Fprintf(out, "  %s  %q  %s%s\n", d.ID, d.Name, seen, online)
	}
	fmt.Fprintf(out, "%d outstanding invites\n", len(invites))
	for _, inv := range invites {
		when := "never expires"
		if inv.ExpiresAt != nil {
			when = "expires " + time.UnixMilli(*inv.ExpiresAt).UTC().Format(time.RFC3339)
		}
		fmt.Fprintf(out, "  %s  %q  %s\n", inv.ID, inv.Label, when)
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * revoke and uninvite
 * ---------------------------------------------------------------- */

// cmdRevoke takes a device off the vault: its row, its open connections and
// the invites it issued, the same as a device's revoke.
func cmdRevoke(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("revoke", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("revoke takes one device id; `trewd devices` lists them")
	}
	reply, err := administer(*dataDir, *vault, "revoke", control.Request{Op: "revoke", DeviceID: fs.Arg(0)})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	r := reply.Revoked
	fmt.Fprintf(out, "Revoked %s: closed %d connections, cancelled %d invites it had issued.\n",
		r.DeviceID, r.Closed, r.InvitesCancelled)
	return nil
}

// cmdUninvite cancels an outstanding invite by the id `trewd devices` lists.
func cmdUninvite(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("uninvite", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("uninvite takes one invite id; `trewd devices` lists them")
	}
	reply, err := administer(*dataDir, *vault, "uninvite", control.Request{Op: "uninvite", Invite: fs.Arg(0)})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	fmt.Fprintf(out, "Cancelled invite %s.\n", reply.Canceled.Invite)
	return nil
}
