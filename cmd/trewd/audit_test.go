package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/store"
)

// agentWrote commits two operations on the default vault of dir, straight
// through the store: an edit of a note that already existed, which pins the
// version it displaced, and a create. There are no MCP write tools yet to
// make them over HTTP; the store's CommitOperation is what those tools will
// call, so this is the record they will leave. Returns the token id and the
// two operation ids.
func agentWrote(t *testing.T, dir string) (tokenID string, ops []string) {
	t.Helper()
	dbPath, chunkDir := store.DataDir(dir)
	st, err := store.Open(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatal(err)
	}
	tok, err := st.CreateMCPToken("default", "Claude on Mac", store.ScopeWrite, nil, time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	entry := func(path, body string) store.Entry {
		n := chunks.Name([]byte(body))
		if err := st.Chunks().Put("default", n, []byte(body)); err != nil {
			t.Fatal(err)
		}
		return store.Entry{Path: path, Size: int64(len(body)), MTime: 10, Device: "Claude on Mac", Chunks: []string{n}}
	}
	seed := entry("notes/plan.md", "the plan, before the agent")
	seed.Device = "laptop"
	uid, err := st.AppendEntry("default", seed)
	if err != nil {
		t.Fatal(err)
	}
	render := func(r store.OpResult) ([]byte, error) {
		return json.Marshal(map[string]any{"committed": true, "opId": r.OpID})
	}
	for i, oe := range []store.OpEntry{
		{Entry: entry("notes/plan.md", "the plan, after the agent"), Base: uid},
		{Entry: entry("notes/new.md", "a note the agent made")},
	} {
		sum := sha256.Sum256([]byte{byte(i)})
		res, err := st.CommitOperation(store.Operation{
			Vault: "default", ActorID: tok.ID, ActorHash: store.MCPTokenHash(tok.Token), ActorLabel: "Claude on Mac",
			Tool: "edit_note", IdempotencyKey: "retry-" + string(rune('a'+i)), RequestDigest: hex.EncodeToString(sum[:]),
			Epoch: st.Epoch(), Entries: []store.OpEntry{oe}, ClientName: "claude-code", ClientVersion: "2.1",
			Render: render, MaxResult: 1 << 20,
		})
		if err != nil {
			t.Fatalf("operation %d: %v", i, err)
		}
		ops = append(ops, res.OpID)
	}
	return tok.ID, ops
}

// `trewd audit` lists every operation with who made it, what it changed and
// what it pinned, with no server running and through a running one, and it
// still lists a revoked token's operations under the name they were made
// with. -since narrows it; -json carries the same records.
func TestAuditListsWhatAgentsDid(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	stop()
	tokenID, ops := agentWrote(t, dir)

	check := func(out string) {
		t.Helper()
		for _, want := range []string{
			"2 agent operations on vault \"default\"", `by "Claude on Mac"`, "token " + tokenID, ops[0], ops[1],
			`"notes/plan.md"  uid 1 -> uid 2`, `"notes/new.md"  new -> uid 3`, "pinned uid 1 until",
			`key "retry-a"`, `client "claude-code 2.1"`,
		} {
			if !strings.Contains(out, want) {
				t.Fatalf("the audit does not say %q:\n%s", want, out)
			}
		}
	}
	check(mustRun(t, "audit", "-data", dir))

	stop = serveInBackground(t, dir)
	defer stop()
	check(mustRun(t, "audit", "-data", dir))
	mustRun(t, "mcp-token", "-data", dir, "-revoke", tokenID)
	check(mustRun(t, "audit", "-data", dir, "-since", "1h"))

	if out := mustRun(t, "audit", "-data", dir, "-since", time.Now().Add(time.Hour).UTC().Format(time.RFC3339)); !strings.Contains(out, "0 agent operations") {
		t.Fatalf("an audit since the future:\n%s", out)
	}

	var got struct {
		Vault      string                  `json:"vault"`
		Epoch      string                  `json:"epoch"`
		Operations []store.OperationRecord `json:"operations"`
	}
	out := mustRun(t, "audit", "-data", dir, "-json", "-since", "7d")
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("audit -json is not JSON: %v\n%s", err, out)
	}
	if got.Vault != "default" || got.Epoch == "" || len(got.Operations) != 2 || got.Operations[0].ID != ops[0] ||
		len(got.Operations[0].Pins) != 1 || got.Operations[1].Paths[0].BeforeUID != nil {
		t.Fatalf("audit -json: %+v", got)
	}
}

// What -since takes, and what it refuses.
func TestAuditSinceReadsDurationsAndTimes(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	for in, want := range map[string]time.Time{
		"":                     time.UnixMilli(0),
		"24h":                  now.Add(-24 * time.Hour),
		"7d":                   now.Add(-7 * 24 * time.Hour),
		"90m":                  now.Add(-90 * time.Minute),
		"2026-09-01":           time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		"2026-09-01T10:30":     time.Date(2026, 9, 1, 10, 30, 0, 0, time.UTC),
		"2026-09-01T10:30:00Z": time.Date(2026, 9, 1, 10, 30, 0, 0, time.UTC),
	} {
		got, err := parseSince(in, now)
		if err != nil || got != want.UnixMilli() {
			t.Errorf("-since %q = %d (%v), want %d", in, got, err, want.UnixMilli())
		}
	}
	for _, bad := range []string{"-3d", "-1h", "yesterday", "7 days"} {
		if _, err := parseSince(bad, now); err == nil {
			t.Errorf("-since %q was accepted", bad)
		}
	}
}

// The pins show up where an operator decides whether to purge: `stats` says
// how many versions a purge keeps for them, `purge` says it kept them, and
// `verify` counts the operations it decoded. A backup says it carried them.
func TestPinsAreReportedByStatsPurgeVerifyAndBackup(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	stop()
	agentWrote(t, dir)

	if out := mustRun(t, "stats", "-data", dir); !strings.Contains(out, "1 of those versions are what agents' edits displaced") ||
		!strings.Contains(out, "the only history is pinned") {
		t.Fatalf("stats:\n%s", out)
	}
	if out := mustRun(t, "verify", "-data", dir); !strings.Contains(out, "2 agent operations, 0 faults") {
		t.Fatalf("verify:\n%s", out)
	}
	backup := filepath.Join(t.TempDir(), "backup")
	if out := mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", backup); !strings.Contains(out, "2 agent operations carried, with 1 before-image pins and 2 idempotency keys") {
		t.Fatalf("backup:\n%s", out)
	}
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-backup", backup, "-grace", "0")
	if !strings.Contains(out, "removed 0") || !strings.Contains(out, "kept 1 versions agents' edits displaced") {
		t.Fatalf("purge:\n%s", out)
	}
	if out := mustRun(t, "cat", "-data", dir, "-path", "notes/plan.md", "-uid", "1"); out != "the plan, before the agent" {
		t.Fatalf("the before-image after the purge reads %q", out)
	}
}
