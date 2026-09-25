package store

import (
	"errors"
	"strings"
	"testing"
)

// deleteAt sends one deletion through AppendCurrent at the path's current
// head, which is what a device that removed it sends.
func (h *harness) deleteAt(t *testing.T, path string) error {
	t.Helper()
	base, err := h.CurrentUID("v1", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.AppendCurrent("v1", Entry{Path: path, Deleted: true, MTime: 9}, base, 0)
	return err
}

// A folder is deleted only once nothing live is in it (ErrFolderNotEmpty):
// refused as stale, naming what is still there, while a file or a folder lies
// beneath, and taken once the device has deleted everything inside first,
// which is the order a device that removed the folder sends them in.
func TestAFolderIsDeletedOnlyOnceNothingLiveIsInIt(t *testing.T) {
	h := newTestStore(t)
	for _, p := range []string{"Projects", "Projects/sub"} {
		if err := h.writeAt(t, p, "", true); err != nil {
			t.Fatal(err)
		}
	}
	h.file(t, "Projects/a.md", "a")
	h.file(t, "Projects/sub/b.md", "b")

	for _, c := range []struct{ path, held string }{
		{"Projects", `"Projects/a.md"`},
		{"Projects/sub", `"Projects/sub/b.md"`},
	} {
		err := h.deleteAt(t, c.path)
		if !errors.Is(err, ErrStale) || !errors.Is(err, ErrFolderNotEmpty) {
			t.Fatalf("deleting %s with something in it was answered %v, want a stale refusal", c.path, err)
		}
		if !strings.Contains(err.Error(), c.held) {
			t.Fatalf("the refusal of %s does not name what is in it: %v", c.path, err)
		}
		if _, gone, _ := h.Head("v1", c.path); gone {
			t.Fatalf("a refused deletion of %s committed", c.path)
		}
	}

	// Deepest first, as the device sends them, and each is taken.
	for _, p := range []string{"Projects/sub/b.md", "Projects/sub", "Projects/a.md", "Projects"} {
		if err := h.deleteAt(t, p); err != nil {
			t.Fatalf("deleting %s after everything in it: %v", p, err)
		}
	}
	if diff, err := liveDifference(h.db, "v1"); err != nil || diff != "" {
		t.Fatalf("the live set disagrees with the entries: %s %v", diff, err)
	}
	if live := liveNow(t, h); len(live) != 0 {
		t.Fatalf("paths still live after the folder went: %v", live)
	}
}

// A batch applies its entries in order, each against the state the earlier
// ones left (plan/protocol.md, "Paths"), so the file deletions ahead of their
// folder's deletion let it through, and the same deletions after it do not.
func TestAFolderDeletionInABatchIsJudgedAfterTheEntriesAheadOfIt(t *testing.T) {
	for _, c := range []struct {
		name        string
		folderFirst bool
	}{{"files first", false}, {"folder first", true}} {
		t.Run(c.name, func(t *testing.T) {
			h := newTestStore(t)
			if err := h.writeAt(t, "Old", "", true); err != nil {
				t.Fatal(err)
			}
			a := h.file(t, "Old/a.md", "a")
			b := h.file(t, "Old/b.md", "b")
			folder, _ := h.CurrentUID("v1", "Old")
			entries := []Entry{
				{Path: "Old/a.md", Deleted: true, MTime: 9},
				{Path: "Old/b.md", Deleted: true, MTime: 9},
				{Path: "Old", Deleted: true, MTime: 9},
			}
			bases := []int64{a.UID, b.UID, folder}
			if c.folderFirst {
				entries = []Entry{entries[2], entries[0], entries[1]}
				bases = []int64{bases[2], bases[0], bases[1]}
			}
			res, err := h.AppendMany("v1", entries, bases, make([]int64, len(entries)))
			if err != nil {
				t.Fatal(err)
			}
			for i, r := range res {
				refused := c.folderFirst && i == 0
				if refused != (r.Err != nil) {
					t.Fatalf("entry %d (%s): %+v", i, entries[i].Path, r)
				}
				if refused && !errors.Is(r.Err, ErrFolderNotEmpty) {
					t.Fatalf("the folder deletion was refused with %v", r.Err)
				}
			}
			if _, gone, _ := h.Head("v1", "Old"); gone == c.folderFirst {
				t.Fatalf("folder gone = %v after %s", gone, c.name)
			}
		})
	}
}

// What is and is not beneath a folder. A sibling whose name only begins like
// the folder's is not in it, whatever byte follows; a path under a spelling
// that differs only in case is (TestAFolderMidCaseRenameIsNotEmptiedByItsOldSpelling);
// and a folder that has no entry of its own, only files, is still a folder
// those files are in.
func TestOnlyWhatIsInTheFolderKeepsItsDeletionBack(t *testing.T) {
	h := newTestStore(t)
	if err := h.writeAt(t, "F", "", true); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"F.md", "F-old/a.md", "F 2/a.md", "F0/a.md", "Fa/b.md"} {
		h.file(t, p, p)
	}
	if err := h.deleteAt(t, "F"); err != nil {
		t.Fatalf("siblings kept a folder's deletion back: %v", err)
	}

	h.file(t, "Implied/deep/x.md", "x")
	if err := h.deleteAt(t, "Implied"); !errors.Is(err, ErrFolderNotEmpty) {
		t.Fatalf("deleting a folder that only its files imply was answered %v", err)
	}
	if err := h.deleteAt(t, "Implied/deep"); !errors.Is(err, ErrFolderNotEmpty) {
		t.Fatalf("deleting the folder above a file was answered %v", err)
	}
}

// What a device does once another device's deletion reached it: a note made
// in the folder afterwards is taken, the folder is put back as a live folder
// against the deletion it answers, and the second device to put it back is
// told it is stale, as any second writer is. A rename that changes only a
// folder's case still moves it with its files live beneath, which is the one
// retirement of a folder that is not a deletion.
func TestAFolderDeletedElsewhereCanBeWrittenIntoAndPutBack(t *testing.T) {
	h := newTestStore(t)
	if err := h.writeAt(t, "Shared", "", true); err != nil {
		t.Fatal(err)
	}
	if err := h.deleteAt(t, "Shared"); err != nil {
		t.Fatal(err)
	}
	tombstone, gone, _ := h.Head("v1", "Shared")
	if !gone {
		t.Fatal("the empty folder was not deleted")
	}
	h.file(t, "Shared/written offline.md", "kept")
	uid, err := h.AppendCurrent("v1", Entry{Path: "Shared", Folder: true, MTime: 10}, tombstone, 0)
	if err != nil {
		t.Fatalf("putting the folder back against its deletion: %v", err)
	}
	if _, err := h.AppendCurrent("v1", Entry{Path: "Shared", Folder: true, MTime: 11}, tombstone, 0); !errors.Is(err, ErrStale) {
		t.Fatalf("a second put-back against the same deletion was answered %v", err)
	}
	if head, gone, _ := h.Head("v1", "Shared"); gone || head != uid {
		t.Fatalf("the folder is at %d (gone %v), want live at %d", head, gone, uid)
	}

	if err := h.writeAt(t, "Notes", "", true); err != nil {
		t.Fatal(err)
	}
	h.file(t, "Notes/a.md", "a")
	if err := h.writeAt(t, "NOTES", "Notes", true); err != nil {
		t.Fatalf("a case-only folder rename with a file still under the old spelling: %v", err)
	}
	if diff, err := liveDifference(h.db, "v1"); err != nil || diff != "" {
		t.Fatalf("the live set disagrees with the entries: %s %v", diff, err)
	}
}

// A folder's deletion is not a note's, and the deleted-notes list leaves it
// out: nothing in it can be restored, and the note that was in it is listed
// by its own deletion. A file deleted at a path that was once a folder is
// still a note, and still listed.
func TestTheDeletedListLeavesOutFolders(t *testing.T) {
	h := newTestStore(t)
	if err := h.writeAt(t, "Old", "", true); err != nil {
		t.Fatal(err)
	}
	h.file(t, "Old/note.md", "note")
	for _, p := range []string{"Old/note.md", "Old"} {
		if err := h.deleteAt(t, p); err != nil {
			t.Fatal(err)
		}
	}
	// A path that was a folder, deleted, and then a note that was deleted too.
	if err := h.writeAt(t, "Was a folder", "", true); err != nil {
		t.Fatal(err)
	}
	if err := h.deleteAt(t, "Was a folder"); err != nil {
		t.Fatal(err)
	}
	h.file(t, "Was a folder", "now a note")
	if err := h.deleteAt(t, "Was a folder"); err != nil {
		t.Fatal(err)
	}

	for _, suppress := range []bool{true, false} {
		got, _, err := h.Deleted("v1", suppress, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		var listed []string
		for _, d := range got {
			listed = append(listed, d.Path)
		}
		if strings.Join(listed, ",") != "Was a folder,Old/note.md" {
			t.Fatalf("suppressRenames=%v listed %v, want the two notes and no folder", suppress, listed)
		}
	}
}

// A case-only folder rename moves the folder entry and its files one move at
// a time, so between the moves the folder's new spelling is live while its
// files are still live under the old one. Those files are in the folder all
// the same, on every disk that folds case, and its deletion is refused while
// they are: as a device's deletion (ErrFolderNotEmpty) and as an undo's or a
// restore's removal of an empty folder (not_empty), neither of which may take
// a folder a note is still in.
func TestAFolderMidCaseRenameIsNotEmptiedByItsOldSpelling(t *testing.T) {
	h := newTestStore(t)
	if err := h.writeAt(t, "Notes", "", true); err != nil {
		t.Fatal(err)
	}
	h.file(t, "Notes/a.md", "a note in the folder")
	if err := h.writeAt(t, "notes", "Notes", true); err != nil {
		t.Fatalf("the case-only rename of the folder entry: %v", err)
	}

	if err := h.deleteAt(t, "notes"); !errors.Is(err, ErrFolderNotEmpty) || !strings.Contains(err.Error(), `"Notes/a.md"`) {
		t.Fatalf("deleting notes while Notes/a.md is live was answered %v", err)
	}
	if _, gone, _ := h.Head("v1", "notes"); gone {
		t.Fatal("the refused deletion committed")
	}

	head, err := h.CurrentUID("v1", "notes")
	if err != nil {
		t.Fatal(err)
	}
	latest, err := h.LatestUID("v1")
	if err != nil {
		t.Fatal(err)
	}
	op := Operation{Vault: "v1", ActorKind: ActorOperator, ActorID: OperatorActorID, ActorLabel: OperatorLabel,
		Tool: RestoreTool, SnapshotHead: &latest, RequestDigest: digestOf("remove notes"), Epoch: h.Epoch(), Render: renderJSON, MaxResult: 1 << 20,
		Entries: []OpEntry{{Entry: Entry{Path: "notes", Deleted: true, MTime: 9, Device: OperatorLabel, Chunks: []string{}},
			Base: head, EmptyFolder: true}}}
	before := h.footprint(t)
	_, err = h.CommitOperation(op)
	if oe := h.refusedWith(t, err, OpCodeNotEmpty, before); oe.Path != "notes" || !errors.Is(err, ErrFolderFilled) {
		t.Fatalf("removing notes as an empty folder was refused %v", err)
	}
	if got, _ := h.headBytes(t, "Notes/a.md"); got != "a note in the folder" {
		t.Fatalf("the note in the folder reads %q", got)
	}

	// Once the file has moved too, the folder is emptied as usual.
	if err := h.writeAt(t, "notes/a.md", "Notes/a.md", false); err != nil {
		t.Fatal(err)
	}
	if err := h.deleteAt(t, "notes/a.md"); err != nil {
		t.Fatal(err)
	}
	if err := h.deleteAt(t, "notes"); err != nil {
		t.Fatalf("deleting the folder once nothing is in it: %v", err)
	}
}
