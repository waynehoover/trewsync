package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/control"
	"github.com/waynehoover/trewsync/internal/store"
)

// restoreFixture is a data directory where the vault held two notes at uid 2,
// and then one was rewritten and a third created: what `trewd restore
// -to-uid 2` has to put back.
func restoreFixture(t *testing.T, dir string) {
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
	put := func(path, body string) {
		n := chunks.Name([]byte(body))
		if err := st.Chunks().Put("default", n, []byte(body)); err != nil {
			t.Fatal(err)
		}
		if _, err := st.AppendEntry("default", store.Entry{Path: path, Size: int64(len(body)), MTime: 10,
			Device: "laptop", Chunks: []string{n}}); err != nil {
			t.Fatal(err)
		}
	}
	put("notes/plan.md", "the plan at uid 1")
	put("notes/keep.md", "never touched")
	put("notes/plan.md", "the plan an agent rewrote overnight")
	put("notes/new.md", "made since")
}

// `trewd restore` is a dry run until -apply: it prints what it would do and
// the head it planned at, and writes nothing. -apply with that head goes
// through the running server's control socket, puts the vault back, is in the
// audit as the operator's, and is undone by `trewd undo` to exactly the heads
// it replaced. A head that has moved refuses the apply, and says so.
func TestRestoreIsADryRunUntilApplyAndIsUndoable(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	stop()
	restoreFixture(t, dir)

	out := mustRun(t, "restore", "-data", dir, "-to-uid", "2")
	for _, want := range []string{
		`A restore of vault "default" to uid 2, planned at uid 4, would:`,
		`put "notes/plan.md" back as uid 1 had it`,
		`remove "notes/new.md", created since as uid 4`,
		"Nothing was written.",
		"trewd restore -to-uid 2 -head 4 -apply",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("the dry run does not say %q:\n%s", want, out)
		}
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/plan.md"); got != "the plan an agent rewrote overnight" {
		t.Fatalf("the dry run changed the note: %q", got)
	}

	stop = serveInBackground(t, dir)
	defer stop()

	out, err := trew(t, "restore", "-data", dir, "-to-uid", "2", "-head", "3", "-apply")
	if err == nil || !strings.Contains(out, "plan_changed") || !strings.Contains(out, "Nothing was written.") {
		t.Fatalf("an apply at a head the vault has moved past: %v\n%s", err, out)
	}

	out = mustRun(t, "restore", "-data", dir, "-to-uid", "2", "-head", "4", "-apply", "-json")
	var r control.Restore
	if err := json.Unmarshal([]byte(out), &r); err != nil || !r.Applied || r.OpID == "" || r.Head != 4 {
		t.Fatalf("restore -apply -json: %+v %v\n%s", r, err, out)
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/plan.md"); got != "the plan at uid 1" {
		t.Fatalf("after the restore the note reads %q", got)
	}
	if _, err := trew(t, "cat", "-data", dir, "-path", "notes/new.md"); err == nil {
		t.Fatal("the note created since is still there after the restore")
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/keep.md"); got != "never touched" {
		t.Fatalf("the untouched note reads %q", got)
	}
	audit := mustRun(t, "audit", "-data", dir)
	if !strings.Contains(audit, "restore_to_uid  committed  by the operator  op "+r.OpID) {
		t.Fatalf("the audit does not record the restore as the operator's:\n%s", audit)
	}

	mustRun(t, "undo", "-data", dir, r.OpID)
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/plan.md"); got != "the plan an agent rewrote overnight" {
		t.Fatalf("after undoing the restore the note reads %q", got)
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/new.md"); got != "made since" {
		t.Fatalf("after undoing the restore the created note reads %q", got)
	}
	if out := mustRun(t, "verify", "-deep", "-data", dir); !strings.Contains(out, "0 faults") {
		t.Fatalf("verify after the restore and its undo:\n%s", out)
	}
}
