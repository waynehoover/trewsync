package store

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/chunks"
)

/* ---------------------------------------------------------------- *
 * Undo (PLAN.md section 4.5, M5 task 7), at the store
 * ---------------------------------------------------------------- */

// undo plans and commits the undo of opID as the operator, as `trewd undo`
// does, and returns the plan, the result and the error of whichever refused.
func (h *harness) undo(t *testing.T, opID string, toCopy bool) (UndoPlan, OpResult, error) {
	t.Helper()
	plan, err := h.PlanUndo(UndoRequest{Vault: "v1", OpID: opID, ToCopy: toCopy, Label: OperatorLabel, Now: 5000})
	if err != nil {
		return plan, OpResult{}, err
	}
	return plan, h.commitUndo(t, plan), nil
}

// commitUndo commits a plan as the operator, failing the test on a refusal.
func (h *harness) commitUndo(t *testing.T, plan UndoPlan) OpResult {
	t.Helper()
	res, err := h.CommitOperation(h.operatorOp(plan))
	if err != nil {
		t.Fatalf("committing the undo of %s: %v", plan.Target.ID, err)
	}
	return res
}

func (h *harness) operatorOp(plan UndoPlan) Operation {
	op := plan.Operation()
	op.Vault, op.ActorKind, op.ActorID, op.ActorLabel = "v1", ActorOperator, OperatorActorID, OperatorLabel
	op.RequestDigest, op.Epoch, op.Render, op.MaxResult = digestOf("undo "+plan.Target.ID), h.Epoch(), renderJSON, 1<<20
	return op
}

// folder is a folder entry the agent's operation creates, as the tools add
// the folders a new path needs.
func folder(a actor, path string) OpEntry {
	return OpEntry{Entry: Entry{Path: path, Folder: true, MTime: 42, Device: a.label, Chunks: []string{}}}
}

// headBytes is what path holds now: its head's exact bytes, and the head.
func (h *harness) headBytes(t *testing.T, path string) (string, Entry) {
	t.Helper()
	e, state, _, err := h.EntryAsOf("v1", path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if state != PathLive {
		t.Fatalf("%s is %s, not live", path, state)
	}
	return h.bytesOf(t, h.Store, e.UID), e
}

// gone asserts path holds nothing live.
func (h *harness) gone(t *testing.T, path string) {
	t.Helper()
	if _, state, _, err := h.EntryAsOf("v1", path, 0); err != nil || state == PathLive {
		t.Fatalf("%s is %s (%v), and it should hold nothing", path, state, err)
	}
}

// verified asserts the store verifies clean, the log included.
func (h *harness) verified(t *testing.T) {
	t.Helper()
	v, err := h.Verify(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Faults) > 0 {
		t.Fatalf("verify found %v", v.Faults)
	}
}

// Undo of an edit writes the exact former bytes back, several chunks of them,
// as a new version at the edit's output: the log records it as the operator's
// undo of that edit, and it pins what it displaced, which is the edit's
// output, so the undo can itself be undone within the window.
func TestUndoOfAnEditWritesTheFormerBytesBack(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	former := h.file(t, "note.md", "first chunk, ", "second chunk, ", "third")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", former.UID, "the agent's rewrite")))
	if err != nil {
		t.Fatal(err)
	}

	plan, res, err := h.undo(t, edit.OpID, false)
	if err != nil {
		t.Fatalf("undo: %v", err)
	}
	if len(plan.Steps) != 1 || plan.Steps[0].Action != UndoRestore || plan.Steps[0].Before != former.UID {
		t.Fatalf("steps %+v", plan.Steps)
	}
	got, head := h.headBytes(t, "note.md")
	if got != "first chunk, second chunk, third" || head.UID != res.Entries[0].Entry.UID || head.Device != OperatorLabel {
		t.Fatalf("after the undo note.md reads %q at %+v", got, head)
	}
	if len(head.Chunks) != 3 || head.Chunks[1] != former.Chunks[1] {
		t.Fatalf("the restored version names %v, and the former one %v", head.Chunks, former.Chunks)
	}
	rec, ok, err := h.LookupOperation("v1", res.OpID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	if rec.Tool != UndoTool || rec.Undoes != edit.OpID || rec.ActorKind != ActorOperator || rec.ActorID != OperatorActorID ||
		rec.ActorLabel != OperatorLabel || len(rec.Pins) != 1 || rec.Pins[0].UID != edit.Entries[0].Entry.UID {
		t.Fatalf("the undo is recorded as %+v", rec)
	}
	if orig, _, _ := h.LookupOperation("v1", edit.OpID); orig.UndoneBy != res.OpID {
		t.Fatalf("the edit is recorded as undone by %q, not %q", orig.UndoneBy, res.OpID)
	}
	h.verified(t)
}

// Undo of a create is the deletion of that exact version, and of the folders
// the create made for it, deepest first, because nothing else is in them.
func TestUndoOfACreateRemovesItAndTheFoldersItMade(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	create, err := h.CommitOperation(h.op(a, "create",
		folder(a, "a"), folder(a, "a/b"), h.change(t, a, "a/b/note.md", 0, "a new note")))
	if err != nil {
		t.Fatal(err)
	}
	plan, res, err := h.undo(t, create.OpID, false)
	if err != nil {
		t.Fatalf("undo: %v", err)
	}
	var actions []string
	for _, s := range plan.Steps {
		actions = append(actions, s.Action+" "+s.Path)
	}
	if want := "remove a/b/note.md,remove_folder a/b,remove_folder a"; strings.Join(actions, ",") != want {
		t.Fatalf("steps %v, want %s", actions, want)
	}
	for i, p := range []string{"a/b/note.md", "a/b", "a"} {
		h.gone(t, p)
		if e := res.Entries[i].Entry; e.Path != p || !e.Deleted || res.Entries[i].PreviousUID != create.Entries[2-i].Entry.UID {
			t.Fatalf("entry %d is %+v, displacing %d", i, e, res.Entries[i].PreviousUID)
		}
	}
	h.verified(t)
}

// A folder the operation made is removed only if it is empty: one that holds
// a note a person put there since is kept, the note with it, and the note the
// operation made is still removed.
func TestUndoKeepsAFolderSomeoneElseFilled(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	create, err := h.CommitOperation(h.op(a, "create", folder(a, "a"), h.change(t, a, "a/agent.md", 0, "the agent's")))
	if err != nil {
		t.Fatal(err)
	}
	h.file(t, "a/mine.md", "a person's note beside it")

	plan, _, err := h.undo(t, create.OpID, false)
	if err != nil {
		t.Fatalf("undo: %v", err)
	}
	h.gone(t, "a/agent.md")
	if got, _ := h.headBytes(t, "a/mine.md"); got != "a person's note beside it" {
		t.Fatalf("the person's note reads %q", got)
	}
	if _, f := h.headBytes(t, "a"); !f.Folder {
		t.Fatal("the folder is gone")
	}
	last := plan.Steps[len(plan.Steps)-1]
	if last.Action != UndoKeepFolder || last.Path != "a" || !strings.Contains(last.Why, "1 paths") {
		t.Fatalf("the last step is %+v", last)
	}
}

// A note put in the folder between the plan and the commit is caught at the
// commit, where the folder's own head has not moved: the whole undo is
// refused, the operation's note is left where it is, and nothing is written.
func TestAFolderFilledAfterThePlanRefusesTheUndoAtTheCommit(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	create, err := h.CommitOperation(h.op(a, "create", folder(a, "a"), h.change(t, a, "a/agent.md", 0, "the agent's")))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := h.PlanUndo(UndoRequest{Vault: "v1", OpID: create.OpID, Label: OperatorLabel, Now: 5000})
	if err != nil {
		t.Fatal(err)
	}
	h.file(t, "a/late.md", "put there while the undo was being prepared")
	before := h.footprint(t)
	_, err = h.CommitOperation(h.operatorOp(plan))
	oe := h.refusedWith(t, err, OpCodeNotEmpty, before)
	if oe.Path != "a" || !errors.Is(err, ErrFolderFilled) {
		t.Fatalf("refused %v", err)
	}
	if got, _ := h.headBytes(t, "a/agent.md"); got != "the agent's" {
		t.Fatalf("the operation's note reads %q", got)
	}
}

// Undo of a delete writes the note it deleted back, exact bytes, at the path
// it had, even with the folder it was in deleted by a person since: the undo
// puts back what the operation displaced, not the folder entry, which a
// device makes on disk for the note it writes into it.
func TestUndoOfADeleteWritesTheNoteBack(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	dir, err := h.AppendEntry("v1", Entry{Path: "notes", Folder: true, Device: "d1", Chunks: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	note := h.file(t, "notes/keep.md", "what the agent deleted")
	del, err := h.CommitOperation(h.op(a, "delete", OpEntry{
		Entry: Entry{Path: "notes/keep.md", Deleted: true, Device: a.label, Chunks: []string{}}, Base: note.UID}))
	if err != nil {
		t.Fatal(err)
	}
	h.remove(t, "notes")
	_ = dir

	plan, _, err := h.undo(t, del.OpID, false)
	if err != nil {
		t.Fatalf("undo: %v", err)
	}
	if len(plan.Steps) != 1 || plan.Steps[0].Action != UndoRestore || plan.Steps[0].Before != note.UID {
		t.Fatalf("steps %+v", plan.Steps)
	}
	if got, _ := h.headBytes(t, "notes/keep.md"); got != "what the agent deleted" {
		t.Fatalf("the note reads %q", got)
	}
	h.gone(t, "notes")
	h.verified(t)
}

// movedWithBacklinks is a move_note as the tool commits one: the folder the
// destination needs, the rename with its own links rewritten, and a backlink
// in another note edited, all one operation.
func movedWithBacklinks(t *testing.T, h *harness, a actor) (OpResult, Entry, Entry) {
	t.Helper()
	source := h.file(t, "old.md", "see [[other]] from the old place")
	backlink := h.file(t, "other.md", "a link to [[old]]")
	mv := h.change(t, a, "moved/new.md", 0, "see [[../other]] from the new place")
	mv.Entry.Prev, mv.PrevBase = "old.md", source.UID
	res, err := h.CommitOperation(h.op(a, "move",
		folder(a, "moved"), mv, h.change(t, a, "other.md", backlink.UID, "a link to [[moved/new]]")))
	if err != nil {
		t.Fatal(err)
	}
	return res, source, backlink
}

// Undo of a move moves the note back, with the bytes it had before the move
// rewrote its links, puts the backlink edited with it back, and removes the
// folder the move made: one operation, all of it.
func TestUndoOfAMoveMovesItBackWithItsLinksAndBacklinks(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	move, _, _ := movedWithBacklinks(t, h, a)

	plan, res, err := h.undo(t, move.OpID, false)
	if err != nil {
		t.Fatalf("undo: %v", err)
	}
	if got, _ := h.headBytes(t, "old.md"); got != "see [[other]] from the old place" {
		t.Fatalf("old.md reads %q", got)
	}
	if got, _ := h.headBytes(t, "other.md"); got != "a link to [[old]]" {
		t.Fatalf("other.md reads %q", got)
	}
	h.gone(t, "moved/new.md")
	h.gone(t, "moved")
	back := res.Entries[0].Entry
	if back.Path != "old.md" || back.Prev != "moved/new.md" {
		t.Fatalf("the move back is %+v", back)
	}
	if len(res.Entries) != 3 || plan.Steps[0].Action != UndoMoveBack {
		t.Fatalf("the undo wrote %d entries in steps %+v", len(res.Entries), plan.Steps)
	}
	// The move back is one rename, so the history of old.md continues from
	// the move and the deleted list shows no phantom deletion.
	if uid, gone, _ := h.Head("v1", "moved/new.md"); !gone || uid != back.UID {
		t.Fatalf("moved/new.md is at %d gone=%v", uid, gone)
	}
	h.verified(t)
}

// A person's edit to any one path refuses the whole undo, a batch over three
// notes as much as one: zero entries, no row, no uid, and the plan names the
// path, its head now, and who wrote it.
func TestAnEditSinceRefusesTheWholeUndoAndWritesNothing(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	var entries []OpEntry
	for _, p := range []string{"a.md", "b.md", "c.md"} {
		e := h.file(t, p, "#old tag in "+p)
		entries = append(entries, h.change(t, a, p, e.UID, "#new tag in "+p))
	}
	rename, err := h.CommitOperation(h.op(a, "rename_tag", entries...))
	if err != nil {
		t.Fatal(err)
	}
	mine, err := h.write("b.md", "a person rewrote b since")
	if err != nil {
		t.Fatal(err)
	}

	before := h.footprint(t)
	plan, _, err := h.undo(t, rename.OpID, false)
	oe := h.refusedWith(t, err, OpCodeStale, before)
	if oe.Path != "b.md" || oe.CurrentUID != mine.UID || !errors.Is(err, ErrChangedSince) {
		t.Fatalf("refused %v", err)
	}
	if len(plan.Changed) != 1 || plan.Changed[0].Path != "b.md" || plan.Changed[0].By != "d1" || plan.Changed[0].Head != mine.UID {
		t.Fatalf("changed %+v", plan.Changed)
	}
	if !strings.Contains(plan.UndoRefusalDetail(), `written by "d1"`) {
		t.Fatalf("the detail says %q", plan.UndoRefusalDetail())
	}
	for _, p := range []string{"a.md", "c.md"} {
		if got, _ := h.headBytes(t, p); got != "#new tag in "+p {
			t.Fatalf("%s reads %q after a refused undo", p, got)
		}
	}
}

// A move undoes as a unit or not at all: with the moved note moved again by a
// person, neither the backlink nor the folder is touched.
func TestAMovedPathRefusesTheMoveUndoAsAUnit(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	move, _, _ := movedWithBacklinks(t, h, a)
	h.rename(t, "moved/new.md", "moved/again.md", "see [[../other]] from the new place")

	before := h.footprint(t)
	_, _, err := h.undo(t, move.OpID, false)
	h.refusedWith(t, err, OpCodeStale, before)
	if got, _ := h.headBytes(t, "other.md"); got != "a link to [[moved/new]]" {
		t.Fatalf("the backlink reads %q after a refused undo", got)
	}
	h.gone(t, "old.md")
}

// The copy writes each before-image the operation displaced to a new, free
// path beside its note and touches nothing already there, the person's edit
// least of all; a second copy finds the first one's name taken.
func TestTheCopyWritesTheBeforeImagesBesideTheirNotes(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	if _, err := h.AppendEntry("v1", Entry{Path: "dir", Folder: true, Device: "d1", Chunks: []string{}}); err != nil {
		t.Fatal(err)
	}
	former := h.file(t, "dir/note.md", "before the agent")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "dir/note.md", former.UID, "the agent's")))
	if err != nil {
		t.Fatal(err)
	}
	mine, err := h.write("dir/note.md", "a person's edit after the agent")
	if err != nil {
		t.Fatal(err)
	}

	plan, res, err := h.undo(t, edit.OpID, true)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	copyPath := "dir/note (restored " + fmtUID(former.UID) + ").md"
	if len(plan.Steps) != 1 || plan.Steps[0].Action != UndoCopy || plan.Steps[0].Copy != copyPath {
		t.Fatalf("steps %+v", plan.Steps)
	}
	if got, _ := h.headBytes(t, copyPath); got != "before the agent" {
		t.Fatalf("the copy reads %q", got)
	}
	if got, head := h.headBytes(t, "dir/note.md"); got != "a person's edit after the agent" || head.UID != mine.UID {
		t.Fatalf("the note reads %q at %d", got, head.UID)
	}
	if res.Entries[0].PreviousUID != 0 {
		t.Fatalf("the copy displaced %d", res.Entries[0].PreviousUID)
	}
	rec, _, _ := h.LookupOperation("v1", res.OpID)
	if rec.Tool != UndoToCopyTool || rec.Undoes != edit.OpID {
		t.Fatalf("recorded as %+v", rec)
	}
	if orig, _, _ := h.LookupOperation("v1", edit.OpID); orig.UndoneBy != "" {
		t.Fatalf("a copy marked the edit undone by %s", orig.UndoneBy)
	}

	second, _, err := h.undo(t, edit.OpID, true)
	if err != nil {
		t.Fatalf("second copy: %v", err)
	}
	if want := "dir/note (restored " + fmtUID(former.UID) + ") 2.md"; second.Steps[0].Copy != want {
		t.Fatalf("the second copy went to %q, want %q", second.Steps[0].Copy, want)
	}
	h.verified(t)
}

// A copy of an operation that only created things has nothing to copy, and
// says so rather than committing an empty operation.
func TestACopyOfACreateHasNothingToCopy(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	create, err := h.CommitOperation(h.op(a, "create", h.change(t, a, "new.md", 0, "new")))
	if err != nil {
		t.Fatal(err)
	}
	before := h.footprint(t)
	_, _, err = h.undo(t, create.OpID, true)
	h.refusedWith(t, err, OpCodeNothingToUndo, before)
}

// The second undo of an operation is refused: the first moved every head the
// second would need, and the log says which undo did it. Two undos prepared at
// once meet the same refusal at the commit, where the first to commit wins.
func TestUndoingTwiceIsRefused(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "before")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", note.UID, "after")))
	if err != nil {
		t.Fatal(err)
	}
	first, err := h.PlanUndo(UndoRequest{Vault: "v1", OpID: edit.OpID, Label: OperatorLabel, Now: 5000})
	if err != nil {
		t.Fatal(err)
	}
	racing, err := h.PlanUndo(UndoRequest{Vault: "v1", OpID: edit.OpID, Label: OperatorLabel, Now: 5000})
	if err != nil {
		t.Fatal(err)
	}
	undone := h.commitUndo(t, first)

	before := h.footprint(t)
	_, err = h.CommitOperation(h.operatorOp(racing))
	h.refusedWith(t, err, OpCodeAlreadyUndone, before)
	_, _, err = h.undo(t, edit.OpID, false)
	oe := h.refusedWith(t, err, OpCodeAlreadyUndone, before)
	if !strings.Contains(oe.Error(), undone.OpID) {
		t.Fatalf("the refusal does not name the undo that did it: %v", oe)
	}
}

// An undo can be undone, which is a redo: the operation's own bytes come back
// as a new version, and the original then cannot be undone again, because its
// undo is on record and its outputs are no longer the heads.
func TestAnUndoCanBeUndone(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	move, _, _ := movedWithBacklinks(t, h, a)
	_, undo, err := h.undo(t, move.OpID, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.undo(t, undo.OpID, false); err != nil {
		t.Fatalf("undoing the undo: %v", err)
	}
	if got, _ := h.headBytes(t, "moved/new.md"); got != "see [[../other]] from the new place" {
		t.Fatalf("the redo put %q at moved/new.md", got)
	}
	if got, _ := h.headBytes(t, "other.md"); got != "a link to [[moved/new]]" {
		t.Fatalf("the redo put %q in the backlink", got)
	}
	if _, f := h.headBytes(t, "moved"); !f.Folder {
		t.Fatal("the redo did not put the folder back")
	}
	h.gone(t, "old.md")

	before := h.footprint(t)
	_, _, err = h.undo(t, move.OpID, false)
	h.refusedWith(t, err, OpCodeAlreadyUndone, before)
	h.verified(t)
}

// After the pin expired and a purge took the before-image, an undo in place
// and a copy both refuse, naming the path, the uid and the expired pin, and
// write nothing.
func TestUndoAfterThePinExpiredAndPurgeRanRefusesAsGone(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	t0 := time.Now()
	clock := t0
	h.SetClock(func() time.Time { return clock })
	old := h.agedNote(t, "old.md", "the before-image")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "old.md", old.UID, "the edit")))
	if err != nil {
		t.Fatal(err)
	}
	h.age(t, edit.Entries[0].Entry, t0.Add(-24*time.Hour))
	clock = t0.Add(MinPinRetention)
	if rep, err := h.Purge("v1", chunks.DefaultGrace); err != nil || rep.VersionsRemoved != 1 {
		t.Fatalf("purge: %+v %v", rep, err)
	}

	for _, toCopy := range []bool{false, true} {
		before := h.footprint(t)
		plan, _, err := h.undo(t, edit.OpID, toCopy)
		oe := h.refusedWith(t, err, OpCodeGone, before)
		if oe.Path != "old.md" || !errors.Is(err, ErrBeforeImageGone) || !strings.Contains(err.Error(), "pin expired") ||
			len(plan.Gone) != 1 || plan.Gone[0].Before != old.UID {
			t.Fatalf("copy=%v refused %v with %+v", toCopy, err, plan.Gone)
		}
	}
	if got, _ := h.headBytes(t, "old.md"); got != "the edit" {
		t.Fatalf("old.md reads %q", got)
	}
}

// A create over a deleted path undoes to nothing there, even once a purge has
// taken the deletion it displaced, which was never pinned: the log recorded
// that the path held nothing live, so the missing version is not mistaken for
// a lost before-image.
func TestACreateOverADeletionUndoesAfterThePurgeTookTheDeletion(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	h.file(t, "gone.md", "deleted long ago")
	tomb := h.remove(t, "gone.md")
	create, err := h.CommitOperation(h.op(a, "create", h.change(t, a, "gone.md", 0, "the agent's new note")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := h.EntryByUID("v1", tomb.UID); ok {
		t.Fatal("purge kept the deletion, and the case this test is about is not reached")
	}
	if _, _, err := h.undo(t, create.OpID, false); err != nil {
		t.Fatalf("undo: %v", err)
	}
	h.gone(t, "gone.md")
}

// Undo is for the operation's actor only when the caller says so: an MCP
// token's undo finds another token's operation not there, and an unknown or
// malformed id is not found either.
func TestAnAgentUndoesOnlyItsOwnOperations(t *testing.T) {
	h := newTestStore(t)
	a, b := h.writer(t, "a"), h.writer(t, "b")
	note := h.file(t, "note.md", "before")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", note.UID, "a's edit")))
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []UndoRequest{
		{Vault: "v1", OpID: edit.OpID, OnlyActor: b.id, Label: b.label},
		{Vault: "v1", OpID: "AAAAAAAAAAAAAAAAAAAAAA", Label: b.label},
		{Vault: "v1", OpID: "not an id", Label: b.label},
		{Vault: "v2", OpID: edit.OpID, Label: b.label},
	} {
		_, err := h.PlanUndo(r)
		var oe *OpError
		if !errors.As(err, &oe) || oe.Code != OpCodeNotFound || !errors.Is(err, ErrNoOperation) {
			t.Fatalf("%+v: %v", r, err)
		}
	}
	if _, err := h.PlanUndo(UndoRequest{Vault: "v1", OpID: edit.OpID, OnlyActor: a.id, Label: a.label}); err != nil {
		t.Fatalf("a's own: %v", err)
	}
}

// A device's undo is checked at the commit like any device mutation: revoked
// between the plan and the commit, it writes nothing.
func TestARevokedDevicesUndoLosesAtTheCommit(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	if err := h.RegisterDevice("v1", "phone-id", "phone", strings.Repeat("ab", 32), 1000); err != nil {
		t.Fatal(err)
	}
	note := h.file(t, "note.md", "before")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", note.UID, "after")))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := h.PlanUndo(UndoRequest{Vault: "v1", OpID: edit.OpID, Label: "phone", Now: 5000})
	if err != nil {
		t.Fatal(err)
	}
	op := plan.Operation()
	op.Vault, op.ActorKind, op.ActorID, op.ActorHash, op.ActorLabel = "v1", ActorDevice, "phone-id", strings.Repeat("ab", 32), "phone"
	op.RequestDigest, op.Epoch, op.Render, op.MaxResult = digestOf("undo"), h.Epoch(), renderJSON, 1<<20
	if _, err := h.RevokeDevice("v1", "phone-id", 2000); err != nil {
		t.Fatal(err)
	}
	before := h.footprint(t)
	_, err = h.CommitOperation(op)
	h.refusedWith(t, err, OpCodeReadOnly, before)

	if err := h.RegisterDevice("v1", "phone-id", "phone", strings.Repeat("ab", 32), 3000); err != nil {
		t.Fatal(err)
	}
	res, err := h.CommitOperation(op)
	if err != nil {
		t.Fatalf("the device's undo: %v", err)
	}
	if rec, _, _ := h.LookupOperation("v1", res.OpID); rec.ActorKind != ActorDevice || rec.ActorID != "phone-id" ||
		rec.ActorLabel != "phone" {
		t.Fatalf("recorded as %+v", rec)
	}
	h.verified(t)
}

// The operator and the devices make undos and nothing else, and an undo names
// what it undoes: every other shape is the caller's bug, refused before the
// lock.
func TestOnlyAnUndoIsRecordedAsTheOperatorsOrADevices(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	e := h.change(t, a, "note.md", 0, "x")
	e.Entry.Device = OperatorLabel
	for name, op := range map[string]Operation{
		"an operator's edit": {ActorKind: ActorOperator, ActorID: OperatorActorID, ActorLabel: OperatorLabel, Tool: "edit_note"},
		"an undo naming nothing": {ActorKind: ActorOperator, ActorID: OperatorActorID, ActorLabel: OperatorLabel,
			Tool: UndoTool},
		"an operator with a hash": {ActorKind: ActorOperator, ActorID: OperatorActorID, ActorHash: strings.Repeat("0", 64),
			ActorLabel: OperatorLabel, Tool: UndoTool, Undoes: "AAAAAAAAAAAAAAAAAAAAAA"},
		"another kind": {ActorKind: "robot", ActorID: OperatorActorID, ActorLabel: OperatorLabel, Tool: UndoTool,
			Undoes: "AAAAAAAAAAAAAAAAAAAAAA"},
	} {
		op.Vault, op.RequestDigest, op.Epoch, op.Render, op.MaxResult = "v1", digestOf(name), h.Epoch(), renderJSON, 1<<20
		op.Entries = []OpEntry{e}
		before := h.footprint(t)
		_, err := h.CommitOperation(op)
		if oe := h.refusedWith(t, err, OpCodeInternal, before); !errors.Is(oe, ErrBadEntry) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

// An operation recorded before the store was restored is not undone: its uids
// belong to the old history, which the restored store may have issued again.
func TestAnOperationFromBeforeARestoreIsNotUndone(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "before")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", note.UID, "after")))
	if err != nil {
		t.Fatal(err)
	}
	if err := h.renewEpoch(); err != nil {
		t.Fatal(err)
	}
	before := h.footprint(t)
	_, _, err = h.undo(t, edit.OpID, false)
	h.refusedWith(t, err, OpCodeStale, before)
	if !errors.Is(err, ErrEpochChanged) {
		t.Fatalf("refused %v", err)
	}
}

// WrittenBy names the operation behind each version it wrote, and the undo
// that undid it, and nothing for a device's version.
func TestWrittenByNamesTheOperationBehindAVersion(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "a device wrote this")
	edit, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", note.UID, "an agent wrote this")))
	if err != nil {
		t.Fatal(err)
	}
	_, undo, err := h.undo(t, edit.OpID, false)
	if err != nil {
		t.Fatal(err)
	}
	edited, restored := edit.Entries[0].Entry.UID, undo.Entries[0].Entry.UID
	refs, err := h.WrittenBy("v1", []int64{note.UID, edited, restored})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := refs[note.UID]; ok || len(refs) != 2 {
		t.Fatalf("refs %+v", refs)
	}
	if r := refs[edited]; r.ID != edit.OpID || r.Tool != "edit_note" || r.Kind != AuthorKindMCP || r.UndoneBy != undo.OpID {
		t.Fatalf("the edit's ref is %+v", r)
	}
	if r := refs[restored]; r.ID != undo.OpID || r.Tool != UndoTool || r.Kind != ActorOperator || r.UndoneBy != "" {
		t.Fatalf("the undo's ref is %+v", r)
	}
}
