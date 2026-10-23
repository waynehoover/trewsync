package store

import (
	"errors"
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

// A note moved out of the folder since is left where it went, and one moved
// in is left where it arrived, even after a rename inside the folder: a
// restore of one folder neither copies a note back that lives on elsewhere
// nor removes one that only came from elsewhere. A rename within the folder
// is undone like any other change.
func TestARestoreOfAFolderLeavesNotesMovedAcrossItsEdge(t *testing.T) {
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
	if len(plan.KeptMovedOut) != 1 || plan.KeptMovedOut[0] != "Projects/out.md" {
		t.Errorf("kept as moved out: %q", plan.KeptMovedOut)
	}
	if len(plan.KeptMovedIn) != 1 || plan.KeptMovedIn[0] != "Projects/in renamed.md" {
		t.Errorf("kept as moved in: %q", plan.KeptMovedIn)
	}
	sameVault(t, "after restoring Projects", h.vaultAt(t, 0), map[string]string{
		"Archive/out.md":         "moved out later",
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
