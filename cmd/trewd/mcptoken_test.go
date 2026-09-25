package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/control"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

// bearerIn is the one 43-character token in a minting's output.
var bearerIn = regexp.MustCompile(`(?m)^  ([A-Za-z0-9_-]{43})$`)

func mcpTokensJSON(t *testing.T, dir string) []store.MCPToken {
	t.Helper()
	var got control.MCPTokens
	out := mustRun(t, "mcp-token", "-data", dir, "-list", "-json")
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("mcp-token -list -json is not JSON: %v\n%s", err, out)
	}
	var tokens []store.MCPToken
	if err := json.Unmarshal(got.Tokens, &tokens); err != nil {
		t.Fatal(err)
	}
	return tokens
}

// The token commands, through the running server: a read token by default
// with the default lifetime, printed once; a write token written to a private
// file and printed nowhere; a listing that shows ids and fingerprints and no
// credential; and a revoke.
func TestMCPTokensAreMintedListedAndRevokedThroughTheServer(t *testing.T) {
	dir, _, _ := serving(t)

	out := mustRun(t, "mcp-token", "-data", dir, "-label", "Claude on Mac")
	m := bearerIn.FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("no token in:\n%s", out)
	}
	secret := m[1]
	if raw, ok := store.DecodeToken(secret, store.MCPTokenBytes); !ok || len(raw) != store.MCPTokenBytes {
		t.Fatalf("the printed token %q is not 32 bytes of base64url", secret)
	}
	if !strings.Contains(out, "reads the whole vault") || strings.Contains(out, "can change notes") {
		t.Fatalf("a default token is not described as read-only:\n%s", out)
	}

	keyFile := filepath.Join(t.TempDir(), "agent.key")
	out2 := mustRun(t, "mcp-token", "-data", dir, "-label", "writer", "-scope", "write", "-ttl", "0", "-key-out", keyFile)
	info, err := os.Stat(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the key file is %v, want 0600", info.Mode().Perm())
	}
	body, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	written := strings.TrimSpace(string(body))
	if _, ok := store.DecodeToken(written, store.MCPTokenBytes); !ok {
		t.Fatalf("the key file holds %q", body)
	}
	if strings.Contains(out2, written) || !strings.Contains(out2, "never expires") || !strings.Contains(out2, "can change notes") {
		t.Fatalf("a token written to a file was also printed, or misdescribed:\n%s", out2)
	}

	tokens := mcpTokensJSON(t, dir)
	if len(tokens) != 2 {
		t.Fatalf("listed %d tokens, want 2", len(tokens))
	}
	read, write := tokens[0], tokens[1]
	if read.Scope != store.ScopeRead || read.Label != "Claude on Mac" || write.Scope != store.ScopeWrite || write.ExpiresAt != nil {
		t.Fatalf("listed %+v", tokens)
	}
	want := time.Now().Add(server.DefaultMCPTokenTTL).UnixMilli()
	if read.ExpiresAt == nil || *read.ExpiresAt < want-60_000 || *read.ExpiresAt > want+60_000 {
		t.Fatalf("a default token expires at %v, want about %d", read.ExpiresAt, want)
	}
	text := mustRun(t, "mcp-token", "-data", dir, "-list")
	listing := text + mustRun(t, "mcp-token", "-data", dir, "-list", "-json")
	for _, s := range []string{secret, written} {
		if strings.Contains(listing, s) {
			t.Fatal("the listing carries a credential")
		}
	}
	if !strings.Contains(text, read.ID) || !strings.Contains(text, read.Fingerprint) {
		t.Fatalf("the listing does not name the token:\n%s", text)
	}

	out3 := mustRun(t, "mcp-token", "-data", dir, "-revoke", read.ID)
	if !strings.Contains(out3, "Revoked MCP token "+read.ID) {
		t.Fatalf("revoke said:\n%s", out3)
	}
	if left := mcpTokensJSON(t, dir); len(left) != 1 || left[0].ID != write.ID {
		t.Fatalf("after the revoke: %+v", left)
	}
	if _, err := trew(t, "mcp-token", "-data", dir, "-revoke", read.ID); err == nil || !strings.Contains(err.Error(), "no MCP token") {
		t.Fatalf("revoking twice: %v", err)
	}
}

// With no server running the same commands act on the store under the server
// lock, as `invite` does.
func TestMCPTokenCommandsWorkWithNoServerRunning(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	stop()

	out := mustRun(t, "mcp-token", "-data", dir, "-label", "offline")
	if bearerIn.FindStringSubmatch(out) == nil {
		t.Fatalf("no token in:\n%s", out)
	}
	tokens := mcpTokensJSON(t, dir)
	if len(tokens) != 1 || tokens[0].Label != "offline" {
		t.Fatalf("listed %+v", tokens)
	}
	mustRun(t, "mcp-token", "-data", dir, "-revoke", tokens[0].ID)
	if left := mcpTokensJSON(t, dir); len(left) != 0 {
		t.Fatalf("after the revoke: %+v", left)
	}
}

// -key-out never writes over a file: one already at the name, or a name no
// file can be made at, is refused before a token exists, so the refusal costs
// nothing and leaves nothing live. The file that was there is untouched.
func TestAKeyOutThatExistsIsRefusedBeforeATokenIsMinted(t *testing.T) {
	dir, _, _ := serving(t)
	existing := filepath.Join(t.TempDir(), "agent.key")
	if err := os.WriteFile(existing, []byte("a key somebody still uses\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := trew(t, "mcp-token", "-data", dir, "-label", "clobber", "-key-out", existing)
	if err == nil || !strings.Contains(err.Error(), "exists") || !strings.Contains(err.Error(), "no token was minted") {
		t.Fatalf("-key-out over an existing file: %v", err)
	}
	if got, _ := os.ReadFile(existing); string(got) != "a key somebody still uses\n" {
		t.Fatalf("the existing file now holds %q", got)
	}

	// Under a regular file, which no file can be made at.
	notADirectory := filepath.Join(t.TempDir(), "a file")
	if err := os.WriteFile(notADirectory, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = trew(t, "mcp-token", "-data", dir, "-label", "unheld", "-key-out", filepath.Join(notADirectory, "agent.key"))
	if err == nil || !strings.Contains(err.Error(), "No token was minted") {
		t.Fatalf("-key-out under a regular file: %v", err)
	}
	if tokens := mcpTokensJSON(t, dir); len(tokens) != 0 {
		t.Fatalf("a refused -key-out minted %+v", tokens)
	}
}

// A token is minted before -key-out writes it, so a file that cannot be
// written would leave a live token nobody holds. It is revoked at once, and
// the error says nothing usable was left. `trew mcp-token --key-out`, retired
// with the headless client's MCP server, never printed or kept a credential it
// could not make durable (docs/development.md, "Retiring trew mcp").
func TestAKeyOutThatCannotBeWrittenRevokesTheTokenItMinted(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, where a directory of mode 500 stops nothing")
	}
	dir, _, _ := serving(t)
	readOnly := filepath.Join(t.TempDir(), "keys")
	if err := os.Mkdir(readOnly, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readOnly, 0o700) })

	_, err := trew(t, "mcp-token", "-data", dir, "-label", "unheld", "-key-out", filepath.Join(readOnly, "agent.key"))
	if err == nil {
		t.Fatal("writing a key into a read-only directory succeeded")
	}
	if !strings.Contains(err.Error(), "was revoked") || !strings.Contains(err.Error(), "nothing usable was left") {
		t.Fatalf("the error does not say the token was revoked:\n%v", err)
	}
	if tokens := mcpTokensJSON(t, dir); len(tokens) != 0 {
		t.Fatalf("a token whose key file could not be written is still live: %+v", tokens)
	}
	if entries, _ := os.ReadDir(readOnly); len(entries) != 0 {
		t.Fatalf("the failed write left %v", entries)
	}
}

// When the key file cannot be written and the revoke fails too, the token is
// live and nobody holds it. The error says so loudly, names the id, and gives
// the exact command that revokes it, which works.
func TestARevokeThatFailsAfterTheKeyOutFailedSaysSoLoudly(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, where a directory of mode 500 stops nothing")
	}
	dir, _, _ := serving(t)
	readOnly := filepath.Join(t.TempDir(), "keys")
	if err := os.Mkdir(readOnly, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readOnly, 0o700) })
	was := revokeUnheldMCPToken
	revokeUnheldMCPToken = func(string, string, string) (string, error) {
		return "", errors.New("the control socket went away")
	}
	t.Cleanup(func() { revokeUnheldMCPToken = was })

	_, err := trew(t, "mcp-token", "-data", dir, "-label", "unheld", "-key-out", filepath.Join(readOnly, "agent.key"))
	if err == nil {
		t.Fatal("writing a key into a read-only directory succeeded")
	}
	tokens := mcpTokensJSON(t, dir)
	if len(tokens) != 1 || tokens[0].Label != "unheld" {
		t.Fatalf("listed %+v", tokens)
	}
	id := tokens[0].ID
	command := "trewd mcp-token -data " + shellQuote(dir) + " -revoke " + id
	for _, want := range []string{"REVOKING IT FAILED TOO", "the control socket went away", "STILL LIVE", id, command} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the error does not say %q:\n%v", want, err)
		}
	}
	mustRun(t, "mcp-token", "-data", dir, "-revoke", id)
	if left := mcpTokensJSON(t, dir); len(left) != 0 {
		t.Fatalf("after the revoke the error named: %+v", left)
	}
}

func TestMCPTokenRefusesWhatItCannotDo(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	defer stop()
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{}, "needs -label"},
		{[]string{"-label", "a", "-scope", "admin"}, "read or write"},
		{[]string{"-label", "a\x01b"}, "control character"},
		{[]string{"-label", "a", "-ttl", "-1h"}, "cannot expire"},
		{[]string{"-list", "-label", "a"}, "-label is for minting"},
		{[]string{"-list", "-revoke", "x"}, "two different commands"},
		{[]string{"-revoke", "not an id"}, "not an MCP token id"},
		{[]string{"-json"}, "-json goes with -list"},
		{[]string{"stray"}, "takes no arguments"},
	} {
		_, err := trew(t, append([]string{"mcp-token", "-data", dir}, c.args...)...)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("mcp-token %q: %v, want an error saying %q", c.args, err, c.want)
		}
	}
	if left := mcpTokensJSON(t, dir); len(left) != 0 {
		t.Fatalf("a refused command minted %+v", left)
	}
}
