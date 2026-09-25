package store

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"
)

// A database that cannot grow, for real: SQLite at its page limit answers
// SQLITE_FULL exactly as it does on a full disk. The handle is swapped for
// one whose every connection has the limit, so the whole pool sees it.
func (h *harness) limitPages(t *testing.T, extra int) {
	t.Helper()
	var pages int
	if err := h.db.QueryRow(`PRAGMA page_count`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	h.swapDB(t, fmt.Sprintf("&_pragma=max_page_count(%d)", pages+extra))
}

func (h *harness) swapDB(t *testing.T, pragmas string) {
	t.Helper()
	if err := h.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dsn(h.dbPath, SyncFull, false)+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	h.db = db
}

// A database that fills refuses the write that would grow it with an error
// IsDiskFull recognises, which the server answers as `nospace`, and commits
// nothing of it: no version, no uid, and an operation's every entry and row
// rolled back. Once it has room the same writes commit and read back.
func TestADatabaseThatCannotGrowCommitsNothing(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "kept.md", "acknowledged before the disk filled")
	h.limitPages(t, 0)

	var failed error
	var last int64
	for i := 0; i < 5000 && failed == nil; i++ {
		var e Entry
		e, failed = h.write(fmt.Sprintf("n%04d.md", i), fmt.Sprintf("a note that takes room %04d", i))
		if failed == nil {
			last = e.UID
		}
	}
	if failed == nil {
		t.Fatal("the database never filled")
	}
	if !IsDiskFull(failed) {
		t.Fatalf("a full database failed with %v, which IsDiskFull does not recognise", failed)
	}
	latest, err := h.LatestUID("v1")
	if err != nil {
		t.Fatal(err)
	}
	if latest != max(last, 1) {
		t.Fatalf("after the refused write the vault is at uid %d, and the last that committed was %d", latest, last)
	}

	a := h.writer(t, "agent")
	before := h.footprint(t)
	_, err = h.CommitOperation(h.op(a, "create", h.change(t, a, "made by the agent.md", 0, "an agent's note")))
	var oe *OpError
	if !errors.As(err, &oe) || oe.Outcome == OpRefused {
		t.Fatalf("an operation into a full database was %v", err)
	}
	if after := h.footprint(t); after != before {
		t.Fatalf("the failed operation left %+v, was %+v", after, before)
	}

	h.swapDB(t, "")
	if _, err := h.write("after.md", "written once there was room"); err != nil {
		t.Fatalf("a write once there was room: %v", err)
	}
	if got, _ := h.headBytes(t, "kept.md"); got != "acknowledged before the disk filled" {
		t.Fatalf("kept.md reads %q", got)
	}
	if got, _ := h.headBytes(t, "after.md"); got != "written once there was room" {
		t.Fatalf("after.md reads %q", got)
	}
	h.verified(t)
}
