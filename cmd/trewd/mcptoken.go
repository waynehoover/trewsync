package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/waynehoover/trew/internal/control"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

// cmdMCPToken mints, lists and revokes the bearer tokens agents use on /mcp,
// through the running server's control socket or, with no server running,
// against the store under the server lock, exactly as `invite` does (PLAN.md
// section 2.3.1).
//
// A new token is printed once, or written to -key-out, a new file at mode
// 0600, and printed nowhere. It reads the whole vault, and with -scope write it changes notes
// too, so it goes to the operator who asked and to nothing else: not the log,
// not the listing.
func cmdMCPToken(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("mcp-token", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	label := fs.String("label", "", "a name for the token: shown in the list, and what its writes are recorded as")
	scope := fs.String("scope", string(store.ScopeRead), "read, the default, or write")
	ttl := fs.Duration("ttl", server.DefaultMCPTokenTTL, "how long the token works; 0 means it never expires")
	keyOut := fs.String("key-out", "", "write the token to this new file, mode 0600, instead of printing it; an existing file is refused")
	list := fs.Bool("list", false, "list the vault's tokens instead of minting one")
	revoke := fs.String("revoke", "", "revoke the token with this id instead of minting one")
	asJSON := fs.Bool("json", false, "with -list, print the list as JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("mcp-token takes no arguments, and was given %q", fs.Args())
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	switch {
	case *list && *revoke != "":
		return errors.New("-list and -revoke are two different commands; give one")
	case *list || *revoke != "":
		for _, minting := range []string{"label", "scope", "ttl", "key-out"} {
			if set[minting] {
				return fmt.Errorf("-%s is for minting a token, not for -list or -revoke", minting)
			}
		}
	}
	if *asJSON && !*list {
		return errors.New("-json goes with -list")
	}

	switch {
	case *list:
		reply, err := administer(*dataDir, *vault, "list MCP tokens", control.Request{Op: "mcp-tokens"})
		if err != nil {
			return err
		}
		if err := refused(reply); err != nil {
			return err
		}
		return printMCPTokens(out, reply.MCPTokens, *asJSON)
	case *revoke != "":
		id, err := revokeMCPToken(*dataDir, *vault, *revoke)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Revoked MCP token %s. A request it has in flight is refused before it is answered.\n", id)
		return nil
	}

	if *label == "" {
		return errors.New("mcp-token needs -label, a name for the token, such as -label \"Claude on Mac\"")
	}
	if *ttl < 0 {
		return fmt.Errorf("-ttl %s: a token cannot expire before it is issued", *ttl)
	}
	if *keyOut != "" {
		// Refused before a token exists, so a name already taken costs
		// nothing. The write below is exclusive as well, for a file that
		// appears in between.
		if _, err := os.Lstat(*keyOut); err == nil {
			return fmt.Errorf("-key-out %s: that file exists, and a key file is never written over. "+
				"Choose another name, or remove it first; no token was minted", *keyOut)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("-key-out %s: %w. No token was minted", *keyOut, err)
		}
	}
	reply, err := administer(*dataDir, *vault, "mint an MCP token", control.Request{
		Op: "mcp-token", Label: *label, Scope: *scope, TTLMs: ttl.Milliseconds(), Never: *ttl == 0,
	})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	var tok store.MCPToken
	if err := json.Unmarshal(reply.MCPToken.Token, &tok); err != nil {
		return err
	}
	when := "never expires; revoke it when it is no longer used"
	if tok.ExpiresAt != nil {
		when = "expires at " + time.UnixMilli(*tok.ExpiresAt).UTC().Format(time.RFC3339)
	}
	what := "reads the whole vault"
	if tok.Scope == store.ScopeWrite {
		what = "reads the whole vault and can change notes"
	}
	if *keyOut != "" {
		// The token is live from the moment the server minted it, so a file
		// that cannot be written would leave a credential nobody holds. It is
		// revoked at once, the way -revoke does it; only when that fails too
		// is it left live, and then the error says so and how to end it.
		if err := writeNewSecretFile(*keyOut, reply.MCPToken.Secret+"\n"); err != nil {
			if _, rerr := revokeUnheldMCPToken(*dataDir, *vault, tok.ID); rerr != nil {
				return fmt.Errorf("could not write the new MCP token to %s: %v.\n"+
					"REVOKING IT FAILED TOO: %v.\n"+
					"MCP token %s IS STILL LIVE, AND NOTHING HOLDS IT. Revoke it now:\n\n  %s\n",
					*keyOut, err, rerr, tok.ID, revokeCommand(*dataDir, *vault, tok.ID))
			}
			return fmt.Errorf("could not write the new MCP token to %s: %w. The token, %s, was revoked, "+
				"so nothing usable was left; mint another", *keyOut, err, tok.ID)
		}
		fmt.Fprintf(out, "Wrote an MCP token for vault %q to %s. It %s, and %s.\n", reply.MCPToken.Vault, *keyOut, what, when)
	} else {
		fmt.Fprintf(out, "An MCP token for vault %q. It %s, and %s. It is shown once.\n\n  %s\n\n",
			reply.MCPToken.Vault, what, when, reply.MCPToken.Secret)
		fmt.Fprintln(out, "Give it to the MCP client as the header  Authorization: Bearer <token>.")
	}
	fmt.Fprintf(out, "Id %s, fingerprint %s, label %q, scope %s. `trewd mcp-token -revoke %s` revokes it.\n",
		tok.ID, tok.Fingerprint, tok.Label, tok.Scope, tok.ID)
	return nil
}

// revokeMCPToken revokes one MCP token through the control socket, or with no
// server running against the store, and returns the id it revoked.
func revokeMCPToken(dataDir, vault, id string) (string, error) {
	reply, err := administer(dataDir, vault, "revoke an MCP token", control.Request{Op: "mcp-revoke", TokenID: id})
	if err != nil {
		return "", err
	}
	if err := refused(reply); err != nil {
		return "", err
	}
	return reply.MCPRevoked.TokenID, nil
}

// revokeUnheldMCPToken is how a token minted for a key file that could not be
// written is revoked: revokeMCPToken, the path -revoke takes. Tests replace it
// to make the revoke fail.
var revokeUnheldMCPToken = revokeMCPToken

// revokeCommand is the command that revokes id, with the flags that name the
// data directory and vault this one was run against, so it can be pasted as
// it stands.
func revokeCommand(dataDir, vault, id string) string {
	cmd := "trewd mcp-token -data " + shellQuote(dataDir)
	if vault != "" {
		cmd += " -vault " + shellQuote(vault)
	}
	return cmd + " -revoke " + id
}

func printMCPTokens(out io.Writer, reply *control.MCPTokens, asJSON bool) error {
	if asJSON {
		b, err := json.MarshalIndent(reply, "", "  ")
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "%s\n", b)
		return err
	}
	var tokens []store.MCPToken
	if err := json.Unmarshal(reply.Tokens, &tokens); err != nil {
		return err
	}
	fmt.Fprintf(out, "%d MCP tokens on vault %q\n", len(tokens), reply.Vault)
	now := time.Now().UnixMilli()
	for _, t := range tokens {
		var notes []string
		switch {
		case t.ExpiresAt == nil:
			notes = append(notes, "never expires")
		case t.Expired(now):
			notes = append(notes, "expired "+time.UnixMilli(*t.ExpiresAt).UTC().Format(time.RFC3339))
		default:
			notes = append(notes, "expires "+time.UnixMilli(*t.ExpiresAt).UTC().Format(time.RFC3339))
		}
		if t.LastUsed > 0 {
			notes = append(notes, fmt.Sprintf("used %d times, last %s", t.UsedCount,
				time.UnixMilli(t.LastUsed).UTC().Format(time.RFC3339)))
		} else {
			notes = append(notes, "never used")
		}
		fmt.Fprintf(out, "  %s  %s  %-5s  %q  %s\n", t.ID, t.Fingerprint, t.Scope, t.Label, strings.Join(notes, ", "))
	}
	return nil
}
