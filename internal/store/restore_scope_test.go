package store

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

/* ---------------------------------------------------------------- *
 * A device's restore of one folder, or of the vault's notes
 * ---------------------------------------------------------------- */

// restoreAsDevice plans r and commits it as a device does.
func (h *harness) restoreAsDevice(t *testing.T, r RestoreRequest) (RestorePlan, OpResult) {
	t.Helper()
	r.Vault, r.Now, r.NotesOnly = "v1", 7000, true
	plan, err := h.PlanRestore(r)
	if err != nil {
		t.Fatalf("planning %+v: %v", r, err)
	}
	res, err := h.CommitOperation(h.deviceRestoreOp(plan))
	if err != nil {
		t.Fatalf("committing %+v: %v", r, err)
	}
	return plan, res
}

func (h *harness) deviceRestoreOp(plan RestorePlan) Operation {
	// Registered on first use; a second registration of the same device is
	// refused, which is the state wanted anyway.
	_ = h.RegisterDevice("v1", "phone-id", "phone", strings.Repeat("ab", 32), 1000)
	op := plan.Operation()
	op.Vault, op.ActorKind, op.ActorID, op.ActorHash, op.ActorLabel = "v1", ActorDevice, "phone-id",
		strings.Repeat("ab", 32), "phone"
	op.RequestDigest, op.Epoch, op.Render, op.MaxResult = digestOf("restore"), h.Epoch(), renderJSON, 1<<20
	for i := range op.Entries {
		op.Entries[i].Entry.Device = "phone"
	}
	return op
}

func (h *harness) latest(t *testing.T) int64 {
	t.Helper()
	uid, err := h.LatestUID("v1")
	if err != nil {
		t.Fatal(err)
	}
	return uid
}

// A restore of one folder puts back what is in it, by name, and nothing
// outside it: not a note beside it, and not a folder whose name only starts
// with the same letters.
func TestARestoreOfAFolderChangesNothingOutsideIt(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "Projects/plan.md", "the plan on Tuesday")
	h.file(t, "Projects/gone.md", "deleted since")
	h.file(t, "Projects Archive/old.md", "the archive on Tuesday")
	h.file(t, "inbox.md", "inbox on Tuesday")
	at := h.latest(t)

	h.file(t, "Projects/plan.md", "the plan rewritten")
	h.appendAs(t, Entry{Path: "Projects/gone.md", Deleted: true, MTime: 43})
	h.file(t, "Projects/new.md", "made since")
	h.file(t, "Projects Archive/old.md", "the archive rewritten")
	h.file(t, "inbox.md", "inbox rewritten")
	outside := h.vaultAt(t, 0)

	h.restoreAsDevice(t, RestoreRequest{ToUID: at, Folder: "Projects"})
	got := h.vaultAt(t, 0)
	for _, p := range []string{"Projects Archive/old.md", "inbox.md"} {
		if got[p] != outside[p] {
			t.Errorf("%q outside the folder holds %q, and should still hold %q", p, got[p], outside[p])
		}
	}
	want := map[string]string{"Projects/plan.md": "the plan on Tuesday", "Projects/gone.md": "deleted since"}
	for p, w := range want {
		if got[p] != w {
			t.Errorf("%q holds %q, and should be back to %q", p, got[p], w)
		}
	}
	if _, ok := got["Projects/new.md"]; ok {
		t.Error("Projects/new.md, made in the folder since, is still there")
	}
	h.verified(t)
}

// A note moved into the folder since is left where it arrived, even after a
// rename inside the folder: a restore of one folder removes no note that only
// came from elsewhere. A note moved out since is put back, so it is then in
// both places, which loses nothing. A rename within the folder is undone
// like any other change.
func TestARestoreOfAFolderKeepsNotesMovedInAndPutsBackThoseMovedOut(t *testing.T) {
	h := newTestStore(t)
	body := func(s string) []string { return h.put(t, "v1", s) }
	h.file(t, "Projects/out.md", "moved out later")
	h.file(t, "Projects/within.md", "renamed within later")
	h.file(t, "elsewhere.md", "moved in later")
	at := h.latest(t)

	h.appendAs(t, Entry{Path: "Archive/out.md", Prev: "Projects/out.md", Size: int64(len("moved out later")),
		Chunks: body("moved out later"), MTime: 44})
	h.appendAs(t, Entry{Path: "Projects/within2.md", Prev: "Projects/within.md",
		Size: int64(len("renamed within later")), Chunks: body("renamed within later"), MTime: 45})
	h.appendAs(t, Entry{Path: "Projects/in.md", Prev: "elsewhere.md", Size: int64(len("moved in later")),
		Chunks: body("moved in later"), MTime: 46})
	h.appendAs(t, Entry{Path: "Projects/in renamed.md", Prev: "Projects/in.md", Size: int64(len("moved in later")),
		Chunks: body("moved in later"), MTime: 47})

	plan, _ := h.restoreAsDevice(t, RestoreRequest{ToUID: at, Folder: "Projects"})
	if len(plan.KeptMovedIn) != 1 || plan.KeptMovedIn[0] != "Projects/in renamed.md" {
		t.Errorf("kept as moved in: %q", plan.KeptMovedIn)
	}
	sameVault(t, "after restoring Projects", h.vaultAt(t, 0), map[string]string{
		"Archive/out.md":         "moved out later",
		"Projects/out.md":        "moved out later",
		"Projects/within.md":     "renamed within later",
		"Projects/in renamed.md": "moved in later",
	})
	h.verified(t)
}

// A device's restore leaves settings as they are, and a settings save
// between its preview and its apply leaves the preview standing. A note's
// does not.
func TestADeviceRestoreLeavesSettingsAndIsBoundToTheNotes(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "then")
	h.file(t, ".obsidian/app.json", `{"then":true}`)
	at := h.latest(t)
	h.file(t, "note.md", "now")
	h.file(t, ".obsidian/app.json", `{"now":true}`)

	r := RestoreRequest{Vault: "v1", ToUID: at, Now: 7000, NotesOnly: true}
	plan, err := h.PlanRestore(r)
	if err != nil {
		t.Fatal(err)
	}
	h.file(t, ".obsidian/app.json", `{"saved again":true}`)
	if _, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: at, Now: 7000, NotesOnly: true,
		Head: plan.Head}); err != nil {
		t.Fatalf("a settings save expired the preview: %v", err)
	}
	if _, err := h.CommitOperation(h.deviceRestoreOp(plan)); err != nil {
		t.Fatalf("a settings save refused the apply: %v", err)
	}
	got := h.vaultAt(t, 0)
	if got["note.md"] != "then" || got[".obsidian/app.json"] != `{"saved again":true}` {
		t.Fatalf("after the restore: %q", got)
	}

	plan, err = h.PlanRestore(r)
	if err != nil {
		t.Fatal(err)
	}
	h.file(t, "note.md", "a note saved between")
	before := h.footprint(t)
	_, err = h.CommitOperation(h.deviceRestoreOp(plan))
	h.refusedWith(t, err, OpCodePlanChanged, before)
}

// A device's restore is recorded as the device's, and undone as one
// operation like any other.
func TestADeviceRestoreIsTheDevicesAndUndoes(t *testing.T) {
	h := newTestStore(t)
	at, _ := h.seedForRestore(t)
	before := h.vaultAt(t, 0)
	_, res := h.restoreAsDevice(t, RestoreRequest{ToUID: at})
	rec, ok, err := h.LookupOperation("v1", res.OpID)
	if err != nil || !ok || rec.Tool != RestoreTool || rec.ActorKind != ActorDevice || rec.ActorLabel != "phone" {
		t.Fatalf("recorded as %+v (%v)", rec, err)
	}
	h.verified(t)
	if _, _, err := h.undo(t, res.OpID, false); err != nil {
		t.Fatalf("undoing it: %v", err)
	}
	sameVault(t, "after the restore and its undo", h.vaultAt(t, 0), before)
	h.verified(t)
}

// A restore bigger than the device's cap is refused whole, never cut short.
func TestARestoreOverTheCapIsRefusedWhole(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "a.md", "one")
	at := h.latest(t)
	for _, p := range []string{"b.md", "c.md", "d.md"} {
		h.file(t, p, "made since")
	}
	_, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: at, Now: 7000, NotesOnly: true, MaxEntries: 2})
	if !errors.Is(err, ErrResultTooLarge) {
		t.Fatalf("a restore of three versions under a cap of two: %v", err)
	}
}

// A time means the newest version the server had committed by then, by the
// server's clock and never a device's; a time before any recorded history is
// refused rather than guessed.
func TestATimeIsTheNewestVersionCommittedByThen(t *testing.T) {
	h := newTestStore(t)
	clock := time.UnixMilli(1_000_000)
	h.SetClock(func() time.Time { return clock })
	first := h.appendAs(t, Entry{Path: "a.md", Chunks: h.put(t, "v1", "one"), Size: 3, MTime: 1})
	clock = clock.Add(time.Hour)
	second := h.appendAs(t, Entry{Path: "a.md", Chunks: h.put(t, "v1", "two"), Size: 3, MTime: 9_999_999_999})

	for _, c := range []struct {
		at   time.Time
		want int64
	}{
		{time.UnixMilli(1_000_000), first.UID},
		{time.UnixMilli(1_000_000).Add(59 * time.Minute), first.UID},
		{clock, second.UID},
		{clock.Add(24 * time.Hour), second.UID},
	} {
		uid, at, err := h.UIDAt("v1", c.at.UnixMilli())
		if err != nil || uid != c.want || at > c.at.UnixMilli() {
			t.Errorf("at %s: uid %d committed %d (%v), and want uid %d", c.at, uid, at, err, c.want)
		}
	}
	if _, _, err := h.UIDAt("v1", 999_999); !errors.Is(err, ErrBeforeHistory) {
		t.Errorf("a time before any history: %v", err)
	}
}

// move appends a rename of the note at from to to, carrying body.
func (h *harness) move(t *testing.T, from, to, body string) Entry {
	t.Helper()
	return h.appendAs(t, Entry{Path: to, Prev: from, Size: int64(len(body)), Chunks: h.put(t, "v1", body), MTime: 50})
}

// A note moved in from outside onto a name a note held at the point is the
// note that arrived, not the one that held the name: it is kept, and so is it
// after a rename inside the folder. Found by review, 2026-10-23: the first
// was written over with the old note's bytes and the second removed.
func TestANoteMovedOntoAnOldNameIsStillOneThatArrived(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "Projects/old.md", "held the name at the point")
	h.file(t, "outside.md", "arrives later")
	at := h.latest(t)
	h.appendAs(t, Entry{Path: "Projects/old.md", Deleted: true, MTime: 43})
	h.move(t, "outside.md", "Projects/old.md", "arrives later")

	plan, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: at, Now: 7000, Folder: "Projects", NotesOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.KeptMovedIn) != 1 || len(plan.Entries) != 0 {
		t.Fatalf("kept %q and wrote %+v; the note that arrived is kept and nothing written", plan.KeptMovedIn, plan.Entries)
	}

	h.move(t, "Projects/old.md", "Projects/new.md", "arrives later")
	h.restoreAsDevice(t, RestoreRequest{ToUID: at, Folder: "Projects"})
	if got := h.vaultAt(t, 0)["Projects/new.md"]; got != "arrives later" {
		t.Fatalf("after the restore Projects/new.md holds %q", got)
	}
	h.verified(t)
}

// Renames back and forth are traced once each, never once per path through
// them. Found by review: five renames between two names took seconds.
func TestRenamesBackAndForthAreTracedOnce(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "elsewhere.md", "x")
	at := h.latest(t)
	h.file(t, "Projects/a.md", "made since")
	names := []string{"Projects/a.md", "Projects/b.md"}
	for i := 0; i < 40; i++ {
		h.move(t, names[i%2], names[(i+1)%2], "made since")
	}
	start := time.Now()
	plan, err := h.PlanRestore(RestoreRequest{Vault: "v1", ToUID: at, Now: 7000, Folder: "Projects", NotesOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("planning took %s", took)
	}
	if len(plan.KeptMovedIn) != 0 || len(plan.Entries) != 1 {
		t.Fatalf("kept %q and wrote %d; a note made in the folder since is removed", plan.KeptMovedIn, len(plan.Entries))
	}
}

// A note moved out and renamed again outside is put back in the folder and
// left where it went: two copies, nothing lost, nothing outside touched.
func TestANoteMovedOutTwiceIsPutBackBeside(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "Projects/out.md", "moved out")
	at := h.latest(t)
	h.move(t, "Projects/out.md", "Archive/out.md", "moved out")
	h.move(t, "Archive/out.md", "Archive/final.md", "moved out")
	h.restoreAsDevice(t, RestoreRequest{ToUID: at, Folder: "Projects"})
	sameVault(t, "after the restore", h.vaultAt(t, 0), map[string]string{
		"Archive/final.md": "moved out",
		"Projects/out.md":  "moved out",
	})
}

// A device's restore below the purge mark is refused: the history there is
// not whole, so neither a time nor a folder's moves can be read from it, and
// a purge between a preview and its apply always moves the mark past it.
// Found by review: a purge in between changed what the same uid and head
// applied, and a time resolved to an earlier point.
func TestADeviceRestoreBelowThePurgeMarkIsRefused(t *testing.T) {
	h := newTestStore(t)
	// The point is the vault's first version, which a purge always keeps, so
	// no gap below it shows what the purge took above it.
	at := h.file(t, "anchor.md", "unchanged").UID
	h.file(t, "outside.md", "arrives later")
	h.move(t, "outside.md", "Projects/in.md", "arrives later")
	h.file(t, "Projects/in.md", "arrived, then edited")
	h.file(t, "outside.md", "a new note under the old name")
	h.file(t, "Projects/new.md", "made since")
	r := RestoreRequest{Vault: "v1", ToUID: at, Now: 7000, Folder: "Projects", NotesOnly: true, AbovePurgeMark: true}
	plan, err := h.PlanRestore(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.KeptMovedIn) != 1 {
		t.Fatalf("the preview kept %q", plan.KeptMovedIn)
	}
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatal(err)
	}
	r.Head = plan.Head
	_, err = h.PlanRestore(r)
	var oe *OpError
	if !errors.As(err, &oe) || oe.Code != OpCodeGone {
		t.Fatalf("an apply after a purge planned, or was refused otherwise: %v", err)
	}
}

// A restore of a case-only rename is undone as one operation: the undo
// removes the name the restore put back before it writes the other, which
// folds onto it. Found by review: the undo wrote first and was refused as a
// collision, so the restore could not be undone.
func TestARestoreOfACaseOnlyRenameUndoes(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "Projects/Note.md", "body")
	h.move(t, "Projects/Note.md", "Projects/note.md", "body")
	before := h.vaultAt(t, 0)
	_, res := h.restoreAsDevice(t, RestoreRequest{ToUID: e.UID, Folder: "Projects"})
	if _, _, err := h.undo(t, res.OpID, false); err != nil {
		t.Fatalf("undoing the restore of a case-only rename: %v", err)
	}
	sameVault(t, "after the restore and its undo", h.vaultAt(t, 0), before)
	h.verified(t)
}

// A restore of a case-only rename of a folder is undone too: the undo
// removes the folder the restore put back before it writes the other
// spelling. Found by review, 2026-10-23.
func TestARestoreOfACaseOnlyFolderRenameUndoes(t *testing.T) {
	h := newTestStore(t)
	h.appendAs(t, Entry{Path: "Projects/Sub", Folder: true})
	at := h.file(t, "Projects/Sub/note.md", "precious").UID
	h.appendAs(t, Entry{Path: "Projects/sub", Prev: "Projects/Sub", Folder: true})
	h.move(t, "Projects/Sub/note.md", "Projects/sub/note.md", "precious")
	before := h.vaultAt(t, 0)
	_, res := h.restoreAsDevice(t, RestoreRequest{ToUID: at, Folder: "Projects"})
	if _, _, err := h.undo(t, res.OpID, false); err != nil {
		t.Fatalf("undoing the restore of a case-only folder rename: %v", err)
	}
	sameVault(t, "after the restore and its undo", h.vaultAt(t, 0), before)
	h.verified(t)
}

// The note followed out of the folder is the one the name held at the
// point, not another note that later took the name and left too. Found by
// review, 2026-10-23: the original was reported kept and never put back.
func TestAReusedNameIsAnotherNote(t *testing.T) {
	h := newTestStore(t)
	at := h.file(t, "Projects/note.md", "original").UID
	h.move(t, "Projects/note.md", "Archive/original.md", "original")
	h.appendAs(t, Entry{Path: "Archive/original.md", Deleted: true, MTime: 43})
	h.file(t, "Projects/note.md", "different note")
	h.move(t, "Projects/note.md", "Archive/different.md", "different note")
	h.restoreAsDevice(t, RestoreRequest{ToUID: at, Folder: "Projects"})
	if got := h.vaultAt(t, 0)["Projects/note.md"]; got != "original" {
		t.Fatalf("Projects/note.md holds %q after the restore", got)
	}
}

// A rename onto a name that was live is the note that arrived, not the one
// it replaced. Found by review, 2026-10-23: the incoming note was removed.
func TestARenameOntoALiveNameIsTheNoteThatArrived(t *testing.T) {
	h := newTestStore(t)
	at := h.file(t, "anchor.md", "anchor").UID
	dest := h.file(t, "Projects/note.md", "made since")
	src := h.file(t, "outside.md", "incoming")
	if _, err := h.AppendCurrent("v1", Entry{Path: "Projects/note.md", Prev: "outside.md", Device: "d1", Size: 8,
		Chunks: h.put(t, "v1", "incoming")}, dest.UID, src.UID); err != nil {
		t.Fatal(err)
	}
	h.restoreAsDevice(t, RestoreRequest{ToUID: at, Folder: "Projects"})
	if got := h.vaultAt(t, 0)["Projects/note.md"]; got != "incoming" {
		t.Fatalf("Projects/note.md holds %q after the restore", got)
	}
}

// Opening a store at an older schema migrates it and says from which, so the
// server can log what made a rollback impossible; opening it again, or
// opening a new one, says nothing.
func TestAnUpgradeSaysWhichSchemaItCameFrom(t *testing.T) {
	dir := t.TempDir()
	st := openAt(t, dir)
	if got := st.UpgradedFrom(); got != 0 {
		t.Fatalf("a new store says it was upgraded from %d", got)
	}
	older := SchemaVersion - 1
	for _, stmt := range []string{
		fmt.Sprintf(`UPDATE store_identity SET schema_version = %d`, older),
		fmt.Sprintf(`PRAGMA user_version = %d`, older),
	} {
		if err := st.ExecForTest(stmt); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	up := openAt(t, dir)
	if got := up.UpgradedFrom(); got != older {
		t.Fatalf("an upgrade from schema %d says %d", older, got)
	}
	if err := up.Close(); err != nil {
		t.Fatal(err)
	}
	again := openAt(t, dir)
	defer again.Close()
	if got := again.UpgradedFrom(); got != 0 {
		t.Fatalf("a store already current says it was upgraded from %d", got)
	}
}
