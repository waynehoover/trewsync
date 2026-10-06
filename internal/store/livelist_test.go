package store

import (
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/chunks"
)

// liveAt is EachAsOf's listing at head without the deletions, which is what
// EachLive must list at the head it returns. Head 0 is a vault with nothing
// in it, where EachAsOf would read 0 as the latest head.
func liveAt(t testing.TB, s *Store, head int64) []Entry {
	t.Helper()
	var out []Entry
	if head == 0 {
		return out
	}
	if err := s.EachAsOf("v1", head, AsOfRange{}, func(e Entry) (bool, error) {
		if !e.Deleted {
			out = append(out, e)
		}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func eachLive(t testing.TB, s *Store) ([]Entry, int64) {
	t.Helper()
	var out []Entry
	head, err := s.EachLive("v1", func(e Entry) (bool, error) {
		out = append(out, e)
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out, head
}

// EachLive is EachAsOf at the latest head, less the deletions, after every
// kind of write there is and after a purge: the steps the live set's own test
// takes (TestTheLiveSetIsExactlyWhatTheEntriesSay).
func TestEachLiveIsEachAsOfAtTheHead(t *testing.T) {
	h := newTestStore(t)
	check := func(what string) {
		t.Helper()
		got, head := eachLive(t, h.Store)
		latest, err := h.LatestUID("v1")
		if err != nil {
			t.Fatal(err)
		}
		if want := liveAt(t, h.Store, latest); head != latest || !reflect.DeepEqual(got, want) {
			t.Fatalf("after %s, at %d (latest %d):\n got %+v\nwant %+v", what, head, latest, got, want)
		}
	}
	check("nothing")
	steps := []struct {
		what, path, prev string
		folder, deleted  bool
	}{
		{what: "a create", path: "notes/a.md"},
		{what: "a second file in the folder", path: "notes/b.md"},
		{what: "an update", path: "notes/a.md"},
		{what: "a folder entry above files", path: "notes", folder: true},
		{what: "a folder entry of its own", path: "empty", folder: true},
		{what: "a path becoming a folder", path: "notes/b.md", folder: true},
		{what: "and a file again", path: "notes/b.md"},
		{what: "a deletion", path: "notes/a.md", deleted: true},
		{what: "a recreation", path: "notes/a.md"},
		{what: "a rename to a new path", path: "moved/a.md", prev: "notes/a.md"},
		{what: "a rename onto a live path", path: "notes/b.md", prev: "moved/a.md"},
		{what: "a chain of renames", path: "c/one.md", prev: "notes/b.md"},
		{what: "and another link", path: "c/two.md", prev: "c/one.md"},
		{what: "a case-only rename", path: "C/two.md", prev: "c/two.md"},
		{what: "a folder entry deleted", path: "notes", deleted: true},
		{what: "a folder renamed", path: "gone", prev: "empty", folder: true},
		{what: "a path renamed away recreated", path: "moved/a.md"},
	}
	for _, s := range steps {
		base, _ := h.CurrentUID("v1", s.path)
		var prevBase int64
		if s.prev != "" {
			prevBase, _ = h.CurrentUID("v1", s.prev)
		}
		if _, err := h.AppendCurrent("v1", Entry{Path: s.path, Prev: s.prev, Folder: s.folder, Deleted: s.deleted,
			MTime: 1}, base, prevBase); err != nil {
			t.Fatalf("%s: %v", s.what, err)
		}
		check(s.what)
	}
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}
	check("a purge")

	// fn stops it.
	n := 0
	if _, err := h.EachLive("v1", func(Entry) (bool, error) { n++; return false, nil }); err != nil || n != 1 {
		t.Fatalf("a listing told to stop read %d entries: %v", n, err)
	}
}

// The head EachLive returns is the head its listing is of, however the vault
// moves while it reads: both come from one transaction. A device writes,
// renames and deletes notes while the listing is taken again and again, and
// each must be EachAsOf at the head it names.
func TestEachLiveListsTheHeadItReturns(t *testing.T) {
	// Without a full sync at each commit, so the writes keep up with the
	// listings, which on a vault this small take microseconds.
	dir := t.TempDir()
	st, err := OpenWithSync(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"), SyncNormal)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.EnsureVault("v1", 1); err != nil {
		t.Fatal(err)
	}
	h := &harness{Store: st, dir: dir}
	stop, done := make(chan struct{}), make(chan error, 1)
	defer func() {
		select {
		case <-stop:
		default:
			close(stop)
		}
	}()
	go func() {
		// Each of forty notes is created, edited, renamed and its new path
		// deleted, over and over: every kind of change to the live set.
		for i := 0; ; i++ {
			select {
			case <-stop:
				done <- nil
				return
			default:
			}
			k := (i / 4) % 40
			p, q := fmt.Sprintf("d%d/n%d.md", k%5, k), fmt.Sprintf("moved/n%d.md", k)
			base, err := h.CurrentUID("v1", p)
			if err != nil {
				done <- err
				return
			}
			gone, err := h.CurrentUID("v1", q)
			if err != nil {
				done <- err
				return
			}
			switch i % 4 {
			case 0, 1:
				_, err = h.AppendCurrent("v1", Entry{Path: p, MTime: int64(i)}, base, 0)
			case 2:
				_, err = h.AppendCurrent("v1", Entry{Path: q, Prev: p, MTime: int64(i)}, gone, base)
			case 3:
				_, err = h.AppendCurrent("v1", Entry{Path: q, Deleted: true, MTime: int64(i)}, gone, 0)
			}
			if err != nil {
				done <- fmt.Errorf("write %d: %w", i, err)
				return
			}
		}
	}()
	listings, moved := 0, 0
	var last int64
	for until := time.Now().Add(30 * time.Second); moved < 100 && time.Now().Before(until); listings++ {
		got, head := eachLive(t, h.Store)
		if want := liveAt(t, h.Store, head); !reflect.DeepEqual(got, want) {
			t.Fatalf("listing %d is not the vault at %d:\n got %+v\nwant %+v", listings, head, got, want)
		}
		if head != last {
			moved++
			last = head
		}
	}
	close(stop)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if moved < 100 {
		t.Fatalf("the vault moved under only %d of %d listings", moved, listings)
	}
}

// Listing ten thousand notes as EachAsOf does and as EachLive does, with one
// version a note and with twenty: the first grows with the history and the
// second does not.
//
//	go test -run XXX -bench BenchmarkListingTheVault -benchtime 20x ./internal/store/
func BenchmarkListingTheVault(b *testing.B) {
	for _, versions := range []int{1, 20} {
		b.Run(fmt.Sprintf("%d versions a note", versions), func(b *testing.B) {
			dir := b.TempDir()
			st, err := OpenWithSync(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"), SyncNormal)
			if err != nil {
				b.Fatal(err)
			}
			defer st.Close()
			if err := st.EnsureVault("v1", 1); err != nil {
				b.Fatal(err)
			}
			body := []byte("x")
			name := chunks.Name(body)
			if err := st.Chunks().Put("v1", name, body); err != nil {
				b.Fatal(err)
			}
			heads := map[string]int64{}
			for v := 0; v < versions; v++ {
				for start := 0; start < 10000; start += 1000 {
					var es []Entry
					var bases []int64
					for i := start; i < start+1000; i++ {
						p := fmt.Sprintf("area-%02d/note-%05d.md", i%50, i)
						es = append(es, Entry{Path: p, Size: 1, MTime: int64(v + 1), Device: "d", Chunks: []string{name}})
						bases = append(bases, heads[p])
					}
					res, err := st.AppendMany("v1", es, bases, make([]int64, len(es)))
					if err != nil {
						b.Fatal(err)
					}
					for k, r := range res {
						if r.Err != nil {
							b.Fatal(r.Err)
						}
						heads[es[k].Path] = r.UID
					}
				}
			}
			for _, method := range []struct {
				name string
				list func() int
			}{
				{"EachAsOf", func() int { latest, _ := st.LatestUID("v1"); return len(liveAt(b, st, latest)) }},
				{"EachLive", func() int { got, _ := eachLive(b, st); return len(got) }},
			} {
				b.Run(method.name, func(b *testing.B) {
					for b.Loop() {
						if n := method.list(); n != 10000 {
							b.Fatalf("%d paths", n)
						}
					}
				})
			}
		})
	}
}
