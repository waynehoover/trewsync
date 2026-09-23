package search

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/store"
)

// The link index (PLAN.md M5 task 6): the keys it holds, when it may narrow a
// plan's scan, and that it narrows nothing it cannot vouch for.

// backlinks is the index's answer for target at the store's head now.
func (r *rig) backlinks(target string) Backlinks {
	r.t.Helper()
	head, err := r.st.LatestUID(vault)
	if err != nil {
		r.t.Fatal(err)
	}
	b, err := r.x.Backlinks(context.Background(), head, notes.TargetKeys(target))
	if err != nil {
		r.t.Fatal(err)
	}
	return b
}

// mayLink is, for every live note, whether the answer lets a plan skip it.
func (r *rig) mayLink(b Backlinks) map[string]bool {
	r.t.Helper()
	out := map[string]bool{}
	if err := r.st.EachAsOf(vault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if searchable(e) {
			out[e.Path] = b.MayLink(e.Path, e.UID)
		}
		return true, nil
	}); err != nil {
		r.t.Fatal(err)
	}
	return out
}

// linksTo is, by ChangeLinks itself over the store's own bytes, every note
// with a link a move of target would rewrite: what the index must never rule
// out.
func (r *rig) linksTo(target string) map[string]bool {
	r.t.Helper()
	var inventory []string
	var live []store.Entry
	if err := r.st.EachAsOf(vault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if !e.Folder && !e.Deleted {
			inventory = append(inventory, e.Path)
			live = append(live, e)
		}
		return true, nil
	}); err != nil {
		r.t.Fatal(err)
	}
	out := map[string]bool{}
	for _, e := range live {
		if !paths.MCPEditable(e.Path) || e.Path == target {
			continue
		}
		full, _, _, err := r.st.EntryAsOf(vault, e.Path, 0)
		if err != nil {
			r.t.Fatal(err)
		}
		body, err := r.x.assemble(full)
		if err != nil {
			r.t.Fatal(err)
		}
		edits, ambiguous, err := notes.ChangeLinks(string(body), notes.LinkChange{Path: e.Path, From: target,
			To: "elsewhere/moved.md", Inventory: inventory, Canonical: paths.Fold})
		if len(edits) > 0 || ambiguous > 0 || err != nil {
			out[e.Path] = true
		}
	}
	return out
}

// The keys follow every kind of write, and at the head they were indexed at
// the answer rules out exactly the notes that cannot link to the target:
// every note ChangeLinks would touch is kept, and the rest are not read.
func TestTheLinkIndexKeepsEveryBacklinkAndRulesOutTheRest(t *testing.T) {
	r := newRig(t)
	r.write("target.md", "# Target\n")
	r.write("a.md", "see [[target]]\n")
	r.write("b.md", "see [the target](target.md#part)\n")
	r.write("c/d.md", "see [up](../Target.MD) and [[unrelated]]\n")
	r.write("e.md", "nothing here, `[[target]]` is code\n")
	r.write("f.md", "see [[other]]\n")
	r.write("broken.md", "---\ntags: [a\nno closing delimiter and [[target]]")
	r.write("bad.md", "\xff\xfe [[target]]")
	r.write("pic.png", "[[target]] in an attachment")
	s := r.caughtUp()
	if s.LinkFailures != 1 || s.Unreadable != 1 {
		t.Fatalf("status %+v, want one link failure and one unreadable note", s)
	}
	check := func(when string, unlinked ...string) {
		t.Helper()
		b := r.backlinks("target.md")
		if !b.Current {
			t.Fatalf("%s: the index is not current at its own head: %s", when, b.Why)
		}
		may := r.mayLink(b)
		for path := range r.linksTo("target.md") {
			if !may[path] {
				t.Errorf("%s: %s links to the target and the index ruled it out", when, path)
			}
		}
		for _, path := range []string{"broken.md", "bad.md"} {
			if !may[path] {
				t.Errorf("%s: %s could not be read by the index and was ruled out", when, path)
			}
		}
		for _, path := range unlinked {
			if may[path] {
				t.Errorf("%s: %s has no link to the target and was kept: %v", when, path, may)
			}
		}
	}
	check("after the first writes", "e.md", "f.md")

	// A backlink appears, one goes, a linking note is renamed and a note is
	// deleted: the keys follow.
	r.write("f.md", "now see [[Target]]\n")
	r.write("a.md", "no longer linked\n")
	r.rename("b.md", "g/b.md", "see [the target](../target.md)\n")
	r.remove("c/d.md")
	r.caughtUp()
	check("after the edits", "e.md", "a.md")
	may := r.mayLink(r.backlinks("target.md"))
	if !may["f.md"] || may["a.md"] || !may["g/b.md"] {
		t.Fatalf("the keys did not follow the writes: %v", may)
	}
	if why := r.x.checkDeep(r.x.active); why != "" {
		t.Fatalf("the deep check fails on a correct index: %s", why)
	}
}

// An index behind the head a plan reads, or past it, narrows nothing: a
// backlink written after the index's last batch is never ruled out, because
// no note is.
func TestAnIndexNotAtThePlansHeadNarrowsNothing(t *testing.T) {
	r := newRig(t)
	r.write("target.md", "# Target\n")
	r.write("a.md", "unrelated\n")
	r.caughtUp()

	release := make(chan struct{})
	r.x.mu.Lock()
	r.x.beforeBatch = func(string) error {
		<-release
		return nil
	}
	r.x.mu.Unlock()
	defer close(release)
	r.write("a.md", "a new backlink: [[target]]\n")
	b := r.backlinks("target.md")
	if b.Current || !strings.Contains(b.Why, "indexed through") {
		t.Fatalf("an index behind the head narrowed: %+v", b)
	}
	for path, may := range r.mayLink(b) {
		if !may {
			t.Fatalf("%s was ruled out by an index behind the head", path)
		}
	}

	head, _ := r.st.LatestUID(vault)
	ahead, err := r.x.Backlinks(context.Background(), head-2, notes.TargetKeys("target.md"))
	if err != nil {
		t.Fatal(err)
	}
	if ahead.Current {
		t.Fatalf("an index past the plan's head narrowed: %+v", ahead)
	}
}

// Await is how the tools give a busy index the moment it needs: it returns
// once the index reaches the head, and gives up when its context does.
func TestAwaitWaitsForTheIndexAndGivesUp(t *testing.T) {
	r := newRig(t)
	r.write("a.md", "one")
	r.caughtUp()
	release := make(chan struct{})
	r.x.mu.Lock()
	r.x.beforeBatch = func(string) error {
		<-release
		return nil
	}
	r.x.mu.Unlock()
	head := r.write("a.md", "two")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if r.x.Await(ctx, head) {
		t.Fatal("Await returned true for a head the blocked worker has not reached")
	}
	done := make(chan bool, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		done <- r.x.Await(ctx, head)
	}()
	close(release)
	if !<-done {
		t.Fatal("Await gave up although the worker caught up")
	}
	if b := r.backlinks("a.md"); !b.Current || b.IndexedHead != head {
		t.Fatalf("after Await: %+v", b)
	}
}

// Link keys taken out under a matching version are caught by the next
// question, which narrows nothing, and the worker builds a generation that is
// right again.
func TestATruncatedLinkTableIsCaught(t *testing.T) {
	r := newRig(t)
	r.write("target.md", "# Target\n")
	for i := 0; i < 6; i++ {
		r.write(fmt.Sprintf("n%d.md", i), "see [[target]]\n")
	}
	before := r.caughtUp()
	if _, err := r.x.db.Exec(`DELETE FROM ` + tablesOf(before.Generation).links + ` WHERE note_id IN (SELECT id FROM ` +
		tablesOf(before.Generation).notes + ` WHERE path = 'n3.md')`); err != nil {
		t.Fatal(err)
	}
	if b := r.backlinks("target.md"); b.Current {
		t.Fatal("a truncated link table still narrowed")
	}
	after := r.caughtUp()
	if after.Generation <= before.Generation {
		t.Fatalf("no new generation after the corruption: %+v", after)
	}
	if may := r.mayLink(r.backlinks("target.md")); !may["n3.md"] {
		t.Fatalf("the rebuilt index rules out n3.md: %v", may)
	}
}

// An index built before the link keys existed is dropped and rebuilt with
// them, whatever its generations said about themselves.
func TestAnIndexWithoutLinkKeysIsBuiltAgain(t *testing.T) {
	r := newRig(t)
	r.write("target.md", "# Target\n")
	r.write("a.md", "see [[target]]\n")
	r.caughtUp()
	r.x.Close()

	// The generations table as version 1 made it: no link counters.
	path, err := filepath.Abs(filepath.Join(r.dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String())
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`ALTER TABLE generations DROP COLUMN links`, `ALTER TABLE generations DROP COLUMN link_failures`,
		`UPDATE generations SET version = 1`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	db.Close()

	r.open()
	r.caughtUp()
	r.x.mu.Lock()
	version := r.x.active.version
	r.x.mu.Unlock()
	if version != IndexVersion {
		t.Fatalf("after reopening, queries use a generation of version %d", version)
	}
	if b := r.backlinks("target.md"); !b.Current || !r.mayLink(b)["a.md"] {
		t.Fatalf("the rebuilt index: %+v", b)
	}
}
