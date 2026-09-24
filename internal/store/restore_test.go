package store

import (
	"errors"
	"testing"
)

/* ---------------------------------------------------------------- *
 * Restoring the vault to a uid (PLAN.md M5.5), at the store
 * ---------------------------------------------------------------- */

// restore plans the restore of v1 to uid and commits it as the operator, as
// `trewd restore -to-uid -apply` does.
func (h *harness) restore(t *testing.T, uid int64) (RestorePlan, OpResult) {
	t.Helper()
	plan, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: uid, Now: 7000})
	if err != nil {
		t.Fatalf("planning the restore to uid %d: %v", uid, err)
	}
	res, err := h.CommitOperation(h.restoreOp(plan))
	if err != nil {
		t.Fatalf("committing the restore to uid %d: %v", uid, err)
	}
	return plan, res
}

func (h *harness) restoreOp(plan RestorePlan) Operation {
	op := plan.Operation()
	op.Vault, op.ActorKind, op.ActorID, op.ActorLabel = "v1", ActorOperator, OperatorActorID, RestoreLabel
	op.RequestDigest, op.Epoch, op.Render, op.MaxResult = digestOf("restore"), h.Epoch(), renderJSON, 1<<20
	return op
}

// appendAs commits e as a device would, failing the test on a refusal.
func (h *harness) appendAs(t *testing.T, e Entry) Entry {
	t.Helper()
	if e.Chunks == nil {
		e.Chunks = []string{}
	}
	if e.Device == "" {
		e.Device = "d1"
	}
	uid, err := h.AppendEntry("v1", e)
	if err != nil {
		t.Fatalf("append %+v: %v", e, err)
	}
	e.UID = uid
	return e
}

// vaultAt is every live path at head and what it holds: its bytes, or "/" for
// a folder, read through the as-of listing and the bodies.
func (h *harness) vaultAt(t *testing.T, head int64) map[string]string {
	t.Helper()
	out := map[string]string{}
	if err := h.EachAsOf("v1", head, AsOfRange{}, func(e Entry) (bool, error) {
		switch {
		case e.Deleted:
		case e.Folder:
			out[e.Path] = "/"
		default:
			out[e.Path] = h.bytesOf(t, h.Store, e.UID)
		}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func sameVault(t *testing.T, what string, got, want map[string]string) {
	t.Helper()
	for p, w := range want {
		if g, ok := got[p]; !ok || g != w {
			t.Errorf("%s: %q holds %q (present %v), and should hold %q", what, p, g, ok, w)
		}
	}
	for p, g := range got {
		if _, ok := want[p]; !ok {
			t.Errorf("%s: %q holds %q, and should not be there", what, p, g)
		}
	}
}

// seedForRestore is a vault with something of every kind in it by uid 6, and
// every kind of change after it: an edit, a deletion, a note created in a
// folder created since, a rename, a deleted folder, a note whose edit was
// edited back to the same bytes, and a note nobody touched.
func (h *harness) seedForRestore(t *testing.T) (at int64, want map[string]string) {
	t.Helper()
	h.file(t, "edited.md", "the words at the restore point, ", "in two chunks")
	h.file(t, "deleted.md", "a note deleted later")
	h.file(t, "renamed.md", "a note renamed later")
	h.appendAs(t, Entry{Path: "kept folder", Folder: true, MTime: 42})
	h.file(t, "same.md", "edited and edited back")
	h.file(t, "untouched.md", "nobody touched this")
	at, err := h.LatestUID("v1")
	if err != nil {
		t.Fatal(err)
	}
	want = h.vaultAt(t, at)

	h.file(t, "edited.md", "an agent's overnight rewrite")
	h.appendAs(t, Entry{Path: "deleted.md", Deleted: true, MTime: 43})
	h.appendAs(t, Entry{Path: "new folder", Folder: true, MTime: 44})
	h.file(t, "new folder/created since.md", "made after the restore point")
	h.file(t, "created since.md", "also made after")
	h.appendAs(t, Entry{Path: "moved away.md", Prev: "renamed.md", Size: int64(len("a note renamed later")),
		Chunks: h.put(t, "v1", "a note renamed later"), MTime: 45})
	h.appendAs(t, Entry{Path: "kept folder", Deleted: true, MTime: 46})
	h.file(t, "same.md", "a change")
	h.file(t, "same.md", "edited and edited back")
	return at, want
}

// A restore puts every path back as it stood at the uid, as one operation
// recorded as the operator's: edits undone to their exact bytes, a deletion
// undone, notes and a folder created since removed, a rename undone by the
// note at its old path and nothing at its new one, a deleted folder back, and
// a note edited back to the same bytes and a note nobody touched left alone.
// Every head it displaced is pinned, and the store verifies clean.
func TestARestorePutsEveryPathBackAsItWas(t *testing.T) {
	h := newTestStore(t)
	at, want := h.seedForRestore(t)
	before, err := h.LatestUID("v1")
	if err != nil {
		t.Fatal(err)
	}

	plan, res := h.restore(t, at)
	sameVault(t, "after the restore", h.vaultAt(t, 0), want)
	if plan.Unchanged != 1 {
		t.Errorf("%d paths were already as they were, and same.md is one", plan.Unchanged)
	}
	for _, e := range res.Entries {
		if e.Entry.UID <= before || e.Entry.Device != RestoreLabel {
			t.Errorf("the restore wrote %+v, and history is appended to, never rewound", e.Entry)
		}
	}
	for p := range map[string]bool{"untouched.md": true, "same.md": true} {
		for _, e := range res.Entries {
			if e.Entry.Path == p {
				t.Errorf("the restore wrote %q, which already held what it held", p)
			}
		}
	}

	rec, ok, err := h.LookupOperation("v1", res.OpID)
	if err != nil || !ok {
		t.Fatalf("the restore is not in the log: %v", err)
	}
	if rec.Tool != RestoreTool || rec.ActorKind != ActorOperator || rec.ActorLabel != RestoreLabel || rec.Undoes != "" {
		t.Fatalf("the restore is recorded as %+v", rec)
	}
	// Displaced heads that held something: edited.md's rewrite, the two
	// notes created since, moved away.md and the new folder.
	if len(rec.Pins) != 5 {
		t.Fatalf("the restore pinned %+v, and it displaced five heads that held something", rec.Pins)
	}
	h.verified(t)
}

// Restore then undo gives back byte-identical heads: the vault as it stood
// before the restore, every path, so a restore to the wrong uid costs nothing.
func TestARestoreThenItsUndoGivesBackTheHeadsItReplaced(t *testing.T) {
	h := newTestStore(t)
	at, _ := h.seedForRestore(t)
	before := h.vaultAt(t, 0)

	_, res := h.restore(t, at)
	if _, _, err := h.undo(t, res.OpID, false); err != nil {
		t.Fatalf("undoing the restore: %v", err)
	}
	sameVault(t, "after the restore and its undo", h.vaultAt(t, 0), before)
	h.verified(t)
}

// A restore previewed at one head and applied at another is refused: a
// restore is a statement about the whole vault, and a device's write in
// between makes it about a different one. The preview's head is checked when
// it is planned again, and the plan's own head at the commit.
func TestARestoreIsRefusedWhenTheVaultMovedSinceItWasPlanned(t *testing.T) {
	h := newTestStore(t)
	at, _ := h.seedForRestore(t)
	head, _ := h.LatestUID("v1")

	if _, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: at, Head: head - 1, Now: 7000}); !errors.Is(err, ErrPlanChanged) {
		t.Fatalf("a preview of another head planned: %v", err)
	}

	plan, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: at, Head: head, Now: 7000})
	if err != nil {
		t.Fatal(err)
	}
	h.file(t, "untouched.md", "a device's write between the plan and the commit")
	before := h.footprint(t)
	_, err = h.CommitOperation(h.restoreOp(plan))
	h.refusedWith(t, err, OpCodePlanChanged, before)
}

// A uid the vault has not reached, or zero, is not a point to restore to.
func TestARestoreToAUidTheVaultHasNotReachedIsRefused(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "a.md", "one")
	for _, uid := range []int64{0, -1, 2} {
		if _, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: uid, Now: 7000}); !errors.Is(err, ErrNoSuchUID) {
			t.Errorf("a restore to uid %d planned: %v", uid, err)
		}
	}
}

// Only the operator restores the vault: an agent's token cannot commit a
// restore, whatever its scope, because a whole-vault rewind is not something
// text in a note should be able to ask for.
func TestOnlyTheOperatorRestores(t *testing.T) {
	h := newTestStore(t)
	at, _ := h.seedForRestore(t)
	plan, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: at, Now: 7000})
	if err != nil {
		t.Fatal(err)
	}
	a := h.writer(t, "agent")
	op := plan.Operation()
	op.Vault, op.ActorID, op.ActorHash, op.ActorLabel = "v1", a.id, a.hash, a.label
	op.RequestDigest, op.Epoch, op.Render, op.MaxResult = digestOf("restore"), h.Epoch(), renderJSON, 1<<20
	for i := range op.Entries {
		op.Entries[i].Entry.Device = a.label
	}
	before := h.footprint(t)
	_, err = h.CommitOperation(op)
	h.refusedWith(t, err, OpCodeInternal, before)
}

// After a purge, what a path held at a uid before the purge's mark may have
// been taken, and the restore refuses as gone rather than restore a guess
// (rule 2), naming the path. At or after the mark the state is exact and the
// restore goes ahead. The fixture is the shape that would otherwise be a
// silent loss: a note whose version at the restore point was purged, so the
// as-of read finds an older version with other bytes.
func TestARestoreRefusesToGuessPastAPurge(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "the oldest words")         // uid 1, purged
	h.file(t, "note.md", "the words at the point")   // uid 2, purged
	h.file(t, "other.md", "another note")            // uid 3
	h.file(t, "note.md", "the words when it purged") // uid 4, the head at the purge
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatal(err)
	}
	if mark, err := h.PurgedThrough("v1"); err != nil || mark != 4 {
		t.Fatalf("the purge mark is %d (%v), and the purge reached uid 4", mark, err)
	}
	h.file(t, "note.md", "written after the purge") // uid 5

	_, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: 3, Now: 7000})
	var oe *OpError
	if !errors.As(err, &oe) || oe.Code != OpCodeGone || oe.Path != "note.md" {
		t.Fatalf("a restore to a purged point planned, or refused otherwise: %v", err)
	}

	// At the mark, the state is exact: note.md held what it held when purged.
	h.restore(t, 4)
	if got, _ := h.headBytes(t, "note.md"); got != "the words when it purged" {
		t.Fatalf("after the restore to the mark note.md reads %q", got)
	}
}

// Schema 3 to 4 gives a store the purge mark: exactly the table a new store
// has, and for a vault already purged a mark at its newest uid, because how
// far those purges reached was never recorded and that is the one mark that
// cannot be too low. A vault never purged has none.
func TestASchemaThreeStoreGainsThePurgeMark(t *testing.T) {
	fresh := t.TempDir()
	want := func() string {
		st := openAt(t, fresh)
		defer st.Close()
		return schemaOf(t, st.db)
	}()

	dir := t.TempDir()
	h := openAt(t, dir)
	for _, v := range []string{"v1", "v2"} {
		if err := h.EnsureVault(v, 1000); err != nil {
			t.Fatal(err)
		}
	}
	h.file(t, "note.md", "one")
	h.file(t, "note.md", "two")
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatal(err)
	}
	h.file(t, "note.md", "three")
	for _, stmt := range []string{
		`DROP TABLE purge_marks`, `UPDATE store_identity SET schema_version = 3`, `PRAGMA user_version = 3`,
	} {
		if err := h.ExecForTest(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}

	up := openAt(t, dir)
	if got := schemaOf(t, up.db); got != want {
		t.Fatalf("an upgraded store's schema is not a new store's:\nupgraded:\n%s\nnew:\n%s", got, want)
	}
	if got := up.Identity().SchemaVersion; got != SchemaVersion {
		t.Fatalf("the upgraded store is at schema %d", got)
	}
	if mark, err := up.PurgedThrough("v1"); err != nil || mark != 3 {
		t.Fatalf("the purged vault's mark is %d (%v), and its newest uid is 3", mark, err)
	}
	if mark, err := up.PurgedThrough("v2"); err != nil || mark != 0 {
		t.Fatalf("the vault never purged has mark %d (%v)", mark, err)
	}
}
