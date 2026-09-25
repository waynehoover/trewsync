package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
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
// A new token is printed once, or written to -key-out, mode 0600, and printed
// nowhere. It reads the whole vault, and with -scope write it changes notes
// too, so it goes to the operator who asked and to nothing else: not the log,
// not the listing.
func cmdMCPToken(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("mcp-token", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	label := fs.String("label", "", "a name for the token: shown in the list, and what its writes are recorded as")
	scope := fs.String("scope", string(store.ScopeRead), "read, the default, or write")
	ttl := fs.Duration("ttl", server.DefaultMCPTokenTTL, "how long the token works; 0 means it never expires")
	keyOut := fs.String("key-out", "", "write the token to this file, mode 0600, instead of printing it")
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
		reply, err := administer(*dataDir, *vault, "revoke an MCP token", control.Request{Op: "mcp-revoke", TokenID: *revoke})
		if err != nil {
			return err
		}
		if err := refused(reply); err != nil {
			return err
		}
		fmt.Fprintf(out, "Revoked MCP token %s. A request it has in flight is refused before it is answered.\n",
			reply.MCPRevoked.TokenID)
		return nil
	}

	if *label == "" {
		return errors.New("mcp-token needs -label, a name for the token, such as -label \"Claude on Mac\"")
	}
	if *ttl < 0 {
		return fmt.Errorf("-ttl %s: a token cannot expire before it is issued", *ttl)
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
		// that cannot be written leaves a credential nobody holds. Say which,
		// and how to end it, rather than an error that names only the path.
		if err := writeSecretFile(*keyOut, reply.MCPToken.Secret+"\n"); err != nil {
			return fmt.Errorf("minted MCP token %s, and could not write it to %s: %w. Nothing holds "+
				"that token now: revoke it with `trewd mcp-token -revoke %s`, and mint another",
				tok.ID, *keyOut, err, tok.ID)
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
