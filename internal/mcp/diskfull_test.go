package mcp

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/store"
)

// sqliteFull stands in for the driver's SQLITE_FULL, by the interface
// store.IsDiskFull reads: a result code whose primary part is 13. A real one
// needs a database at its page limit, which internal/store's own tests use to
// show the driver answers this way; here what matters is what the tool says.
type sqliteFull struct{}

func (sqliteFull) Error() string { return "database or disk is full (13)" }
func (sqliteFull) Code() int     { return 13 }

// A full disk at the COMMIT is still an outcome nobody can state, and says so
// with the opId and key as any other; it also says the cause is `nospace`, so
// the agent and the operator see a full disk rather than an unexplained
// failure, as a device is told `nospace` (internal/server, commitCode).
// Nothing committed, and once there is room the same key commits once.
func TestAFullDiskAtCommitIsUnknownAndSaysNospace(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	base := r.write("n.md", "one\n")
	r.st.FailOperationCommitForTest(fmt.Errorf("committing: %w", sqliteFull{}))
	args := map[string]any{"path": "n.md", "base": base, "epoch": r.epoch(), "text": "two\n", "idempotencyKey": "k"}
	e := invoke(t, a.cs, "append_note", args)
	var f struct {
		Committed any        `json:"committed"`
		OpID      string     `json:"opId"`
		Key       string     `json:"idempotencyKey"`
		Error     *ToolError `json:"error"`
	}
	e.trusted(t, &f)
	if !e.isError || f.Committed != "unknown" || f.OpID == "" || f.Key != "k" || f.Error == nil ||
		f.Error.Code != "outcome_unknown" || f.Error.Cause != "nospace" ||
		!strings.Contains(f.Error.Message, "lookup_operation") || !strings.Contains(f.Error.Message, "disk is full") {
		t.Fatalf("a full disk at COMMIT: %s", e.raw)
	}

	r.st.FailOperationCommitForTest(nil)
	w := wrote(t, invoke(t, a.cs, "append_note", args))
	if got := r.bytesAt(w.Entries[0].UID); got != "one\ntwo\n" || r.operations() != 1 {
		t.Fatalf("the retry: %q, %d operations", got, r.operations())
	}
}

// A full disk that refuses the write before any commit is `nospace`, not
// `internal`, committed false: whether the bodies could not be stored or a
// statement of the operation's transaction could not grow the database. An
// unknown outcome is the only answer that carries the cause beside another
// code; these have nothing to hedge. Once there is room the same call commits
// the bytes it was given.
func TestAFullDiskBeforeCommitIsNospace(t *testing.T) {
	for _, tc := range []struct {
		name string
		fill func(r *rig)
	}{
		{"storing a body", func(r *rig) {
			r.st.Chunks().FaultForTest(&chunks.Fault{Write: func(*os.File, []byte) error {
				return fmt.Errorf("writing a body: %w", syscall.ENOSPC)
			}})
		}},
		{"a statement of the operation", func(r *rig) {
			r.st.FailOperationStepForTest("operation", fmt.Errorf("recording the operation: %w", sqliteFull{}))
		}},
		{"an exceeded quota", func(r *rig) {
			r.st.Chunks().FaultForTest(&chunks.Fault{Write: func(*os.File, []byte) error {
				return fmt.Errorf("writing a body: %w", syscall.EDQUOT)
			}})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			a := r.writer("agent")
			tc.fill(r)
			args := map[string]any{"path": "n.md", "content": "the words that did not fit\n"}
			e := invoke(t, a.cs, "create_note", args)
			if code := refused(t, e); code != "nospace" {
				t.Fatalf("a full disk before commit answered %q: %s", code, e.raw)
			}
			if !strings.Contains(string(e.raw), "disk is full") {
				t.Fatalf("the answer does not say the disk is full: %s", e.raw)
			}
			if _, state, _, _ := r.st.EntryAsOf(testVault, "n.md", 0); state != store.PathAbsent || r.operations() != 0 {
				t.Fatalf("the refused write left %s and %d operations", state, r.operations())
			}

			r.st.Chunks().FaultForTest(nil)
			r.st.FailOperationStepForTest("", nil)
			w := wrote(t, invoke(t, a.cs, "create_note", args))
			if got := r.bytesAt(w.Entries[len(w.Entries)-1].UID); got != "the words that did not fit\n" {
				t.Fatalf("once there was room: %q", got)
			}
		})
	}
}
