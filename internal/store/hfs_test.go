package store

import (
	"errors"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/paths"
)

// storedBeforeTheRule commits e the way a store that predates a path rule
// holds it: applied, with none of the write's checks.
func (h *harness) storedBeforeTheRule(t *testing.T, path, body string) {
	t.Helper()
	n := chunks.Name([]byte(body))
	if err := h.Chunks().Put("v1", n, []byte(body)); err != nil {
		t.Fatal(err)
	}
	e := Entry{Path: path, Size: int64(len(body)), MTime: 1, Device: "old", Chunks: []string{n}}
	if err := immediate(h.db, func(q execer) error {
		_, err := applyEntry(q, "v1", e, 1)
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func refusedAsDotPrefix(t *testing.T, what string, err error) {
	t.Helper()
	var pe *PathError
	if !errors.As(err, &pe) || pe.Reason != paths.ReasonDotPrefix || !errors.Is(err, ErrBadPath) {
		t.Fatalf("%s: got %v, want a dotprefix refusal", what, err)
	}
}

// An HFS+ disk opens "\u200c.obsidian" as .obsidian (paths.HiddenOnHFS), so
// a peer could write a plugin into a Mac's settings as an ordinary note. The
// store refuses such a name as a new one: a create, a folder, a rename's
// destination. A note stored under one before the rule is kept, and can still
// be changed, deleted or renamed away, so nothing is stranded.
func TestANameHFSReadsAsDotPrefixedIsRefusedOnlyWhenNew(t *testing.T) {
	h := newTestStore(t)
	_, err := h.write("\u200c.obsidian/plugins/evil/main.js", "code")
	refusedAsDotPrefix(t, "a create", err)
	_, err = h.AppendEntry("v1", Entry{Path: "\ufeff.trash", Folder: true, MTime: 1, Chunks: []string{}})
	refusedAsDotPrefix(t, "a folder", err)
	h.file(t, "a.md", "a")
	names := h.put(t, "v1", "a")
	_, err = h.AppendEntry("v1", Entry{Path: "Notes/\u200e.a.md", Prev: "a.md", Size: 1, MTime: 2, Chunks: names})
	refusedAsDotPrefix(t, "a rename onto one", err)

	// Ordinary uses of the same code points are not names HFS+ hides.
	h.file(t, "\U0001f468\u200d\U0001f469\u200d\U0001f467 family.md", "f")
	h.file(t, "\u200cnotes.md", "n")

	h.storedBeforeTheRule(t, "\u200c.notes/kept.md", "kept")
	h.storedBeforeTheRule(t, "\u200c.notes/moved.md", "moved")
	h.storedBeforeTheRule(t, "\u200c.notes/gone.md", "gone")
	if _, err := h.write("\u200c.notes/kept.md", "kept, edited"); err != nil {
		t.Fatalf("an update of a stored note: %v", err)
	}
	names = h.put(t, "v1", "moved")
	if _, err := h.AppendEntry("v1", Entry{Path: "notes/moved.md", Prev: "\u200c.notes/moved.md", Size: 5,
		MTime: 2, Chunks: names}); err != nil {
		t.Fatalf("a rename away: %v", err)
	}
	if _, err := h.AppendEntry("v1", Entry{Path: "\u200c.notes/gone.md", Deleted: true, MTime: 2,
		Chunks: []string{}}); err != nil {
		t.Fatalf("a deletion: %v", err)
	}
	_, err = h.write("\u200c.notes/new.md", "new")
	refusedAsDotPrefix(t, "a new note beside them", err)

	uid, gone, err := h.Head("v1", "\u200c.notes/kept.md")
	if err != nil || gone {
		t.Fatalf("the stored note is gone (%v)", err)
	}
	if e, ok, err := h.EntryByUID("v1", uid); err != nil || !ok || e.Size != int64(len("kept, edited")) {
		t.Fatalf("the stored note is %+v, %v, %v", e, ok, err)
	}
}
