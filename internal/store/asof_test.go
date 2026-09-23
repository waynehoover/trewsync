package store

import (
	"reflect"
	"strconv"
	"testing"
	"time"
)

// listAsOf is every path EachAsOf yields at head in r, with its state, as
// "path@uid" or "path@uid(deleted)".
func listAsOf(t *testing.T, h *harness, head int64, r AsOfRange) []string {
	t.Helper()
	var out []string
	if err := h.EachAsOf("v1", head, r, func(e Entry) (bool, error) {
		row := e.Path + "@" + fmtUID(e.UID)
		if e.Deleted {
			row += "(deleted)"
		}
		out = append(out, row)
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func fmtUID(uid int64) string { return strconv.FormatInt(uid, 10) }

func (h *harness) rename(t *testing.T, from, to string, bodies ...string) Entry {
	t.Helper()
	names := h.put(t, "v1", bodies...)
	size := 0
	for _, b := range bodies {
		size += len(b)
	}
	e := Entry{Path: to, Prev: from, Size: int64(size), MTime: 43, Device: "d1", Chunks: names}
	uid, err := h.AppendEntry("v1", e)
	if err != nil {
		t.Fatalf("rename %s to %s: %v", from, to, err)
	}
	e.UID = uid
	return e
}

func (h *harness) remove(t *testing.T, path string) Entry {
	t.Helper()
	e := Entry{Path: path, Deleted: true, MTime: 44, Device: "d1", Chunks: []string{}}
	uid, err := h.AppendEntry("v1", e)
	if err != nil {
		t.Fatalf("delete %s: %v", path, err)
	}
	e.UID = uid
	return e
}

// The ghost row M4 task 7 names: with A.md at uid 1 renamed to B.md at uid 2,
// "the newest row at or below the head" leaves A.md listed at head 2. The
// rename is capped at the head as well, so each head lists one of them.
func TestAnAsOfListingRetiresRenameSourcesAtTheHead(t *testing.T) {
	h := newTestStore(t)
	a := h.file(t, "A.md", "text")
	b := h.rename(t, "A.md", "B.md", "text")
	if got, want := listAsOf(t, h, a.UID, AsOfRange{}), []string{"A.md@1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("at the first head: %v, want %v", got, want)
	}
	if got, want := listAsOf(t, h, b.UID, AsOfRange{}), []string{"B.md@2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after the rename: %v, want %v (a ghost of the source?)", got, want)
	}

	// The source path used again later is live again, from its new version
	// on, and not before.
	c := h.file(t, "A.md", "new text")
	if got, want := listAsOf(t, h, c.UID, AsOfRange{}), []string{"A.md@3", "B.md@2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after reusing the name: %v, want %v", got, want)
	}
	if got, want := listAsOf(t, h, b.UID, AsOfRange{}), []string{"B.md@2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the pinned head moved with the commit: %v, want %v", got, want)
	}

	for _, c := range []struct {
		path  string
		head  int64
		state PathState
		uid   int64
		moved int64
	}{
		{"A.md", 1, PathLive, 1, 0},
		{"A.md", 2, PathMoved, 1, 2},
		{"A.md", 3, PathLive, 3, 0},
		{"A.md", 0, PathLive, 3, 0},
		{"B.md", 1, PathAbsent, 0, 0},
		{"B.md", 2, PathLive, 2, 0},
		{"C.md", 0, PathAbsent, 0, 0},
	} {
		e, state, moved, err := h.EntryAsOf("v1", c.path, c.head)
		if err != nil || state != c.state || e.UID != c.uid || moved != c.moved {
			t.Errorf("%s at %d: %v uid %d moved at %d (%v), want %v uid %d moved at %d",
				c.path, c.head, state, e.UID, moved, err, c.state, c.uid, c.moved)
		}
		if state == PathLive && len(e.Chunks) != 1 {
			t.Errorf("%s at %d: a live file read without its chunks", c.path, c.head)
		}
	}
}

// A commit after the head changes nothing a pinned listing returns, which is
// what lets a continuation neither skip nor repeat a row.
func TestAPinnedListingIgnoresLaterCommits(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "a.md", "a")
	h.file(t, "c.md", "c")
	head := h.file(t, "e.md", "e").UID
	before := listAsOf(t, h, head, AsOfRange{})

	h.file(t, "b.md", "b")      // a create that sorts inside the listing
	h.remove(t, "c.md")         // a deletion
	h.rename(t, "e.md", "d.md") // a rename across the page boundary
	h.file(t, "a.md", "a2")     // an edit
	if after := listAsOf(t, h, head, AsOfRange{}); !reflect.DeepEqual(before, after) {
		t.Fatalf("pinned at %d: %v, then %v", head, before, after)
	}
	if now, want := listAsOf(t, h, 0, AsOfRange{}), []string{"a.md@7", "b.md@4", "c.md@5(deleted)", "d.md@6"}; !reflect.DeepEqual(now, want) {
		t.Fatalf("the current state: %v, want %v", now, want)
	}
}

func TestAnAsOfListingKeepsToItsRange(t *testing.T) {
	h := newTestStore(t)
	for _, p := range []string{"notes", "notes/a.md", "notes/sub/b.md", "notes0.md", "notesX/c.md", "note.md", "zz.md"} {
		if p == "notes" {
			if _, err := h.AppendEntry("v1", Entry{Path: p, Folder: true, Chunks: []string{}}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		h.file(t, p, p)
	}
	if got, want := listAsOf(t, h, 0, AsOfRange{Folder: "notes"}), []string{"notes/a.md@2", "notes/sub/b.md@3"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("folder notes: %v, want %v", got, want)
	}
	if got, want := listAsOf(t, h, 0, AsOfRange{Folder: "notes", After: "notes/a.md"}), []string{"notes/sub/b.md@3"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after notes/a.md: %v, want %v", got, want)
	}
	if got, want := listAsOf(t, h, 0, AsOfRange{After: "notesX/c.md"}), []string{"zz.md@7"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after notesX/c.md: %v, want %v", got, want)
	}

	// Stopping early stops.
	n := 0
	if err := h.EachAsOf("v1", 0, AsOfRange{}, func(Entry) (bool, error) { n++; return n < 2, nil }); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("the callback ran %d times after asking to stop at 2", n)
	}
}

// A subscriber is told about a commit and never makes one wait.
func TestACommitNudgesSubscribersWithoutWaitingForThem(t *testing.T) {
	h := newTestStore(t)
	sub := h.Subscribe()
	defer sub.Stop()
	idle := h.Subscribe() // never read
	defer idle.Stop()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 20; i++ {
			if err := h.push("n.md", "body "+strconv.Itoa(i)); err != nil {
				t.Error(err)
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("commits waited for a subscriber that never read")
	}
	select {
	case <-sub.C:
	case <-time.After(5 * time.Second):
		t.Fatal("no nudge after twenty commits")
	}

	gen, err := h.PurgeGeneration("v1")
	if err != nil || gen != 0 {
		t.Fatalf("purge generation of an unpurged vault: %d %v", gen, err)
	}
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatal(err)
	}
	if gen, _ := h.PurgeGeneration("v1"); gen != 1 {
		t.Fatalf("purge generation after a purge that removed history: %d", gen)
	}
}
