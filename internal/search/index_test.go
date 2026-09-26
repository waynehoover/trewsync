package search

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/notes"
	"github.com/waynehoover/trewsync/internal/store"
)

const vault = "v1"

type rig struct {
	t   *testing.T
	dir string
	st  *store.Store
	x   *Index
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newRig(t *testing.T) *rig {
	t.Helper()
	dir := t.TempDir()
	dbPath, chunkDir := store.DataDir(dir)
	st, err := store.OpenWithSync(dbPath, chunkDir, store.SyncNormal)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.EnsureVault(vault, 1); err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, dir: dir, st: st}
	r.open()
	return r
}

// open opens the index on the rig's store and starts its worker.
func (r *rig) open() {
	r.t.Helper()
	x, err := Open(r.dir, r.st, vault, quiet())
	if err != nil {
		r.t.Fatal(err)
	}
	r.x = x
	x.Start()
	r.t.Cleanup(func() { x.Close() })
}

// write commits a note with this text, chunked as a device chunks it.
func (r *rig) write(path, text string) int64 {
	r.t.Helper()
	uid, err := writeNote(r.st, path, "", []byte(text), false)
	if err != nil {
		r.t.Fatalf("writing %s: %v", path, err)
	}
	return uid
}

func writeNote(st *store.Store, path, prev string, body []byte, folder bool) (int64, error) {
	var names []string
	if !folder {
		sizes := notes.SizesFor(int64(len(body)), notes.IsTextPath(path), store.ChunkMax)
		for _, c := range notes.ChunkBytes(body, sizes, notes.IsTextPath(path)) {
			name := chunks.Name(c.Bytes)
			if err := st.Chunks().Put(vault, name, c.Bytes); err != nil {
				return 0, err
			}
			names = append(names, name)
		}
	}
	if names == nil {
		names = []string{}
	}
	return st.AppendEntry(vault, store.Entry{Path: path, Prev: prev, Size: int64(len(body)), MTime: 1,
		Device: "test", Folder: folder, Chunks: names})
}

func (r *rig) rename(from, to, text string) int64 {
	r.t.Helper()
	uid, err := writeNote(r.st, to, from, []byte(text), false)
	if err != nil {
		r.t.Fatalf("renaming %s to %s: %v", from, to, err)
	}
	return uid
}

func (r *rig) remove(path string) int64 {
	r.t.Helper()
	uid, err := r.st.AppendEntry(vault, store.Entry{Path: path, Deleted: true, Device: "test", Chunks: []string{}})
	if err != nil {
		r.t.Fatal(err)
	}
	return uid
}

// caughtUp waits until the index is usable and has indexed everything.
func (r *rig) caughtUp() Status {
	r.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		latest, err := r.st.LatestUID(vault)
		if err != nil {
			r.t.Fatal(err)
		}
		s := r.x.Status()
		if s.Usable && !s.Rebuilding && s.IndexedHead == latest {
			return s
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("the index did not catch up to %d: %+v", latest, s)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// held is every note the active generation holds, as path@uid.
func (r *rig) held() []string {
	r.t.Helper()
	r.x.mu.Lock()
	gen := r.x.active.gen
	r.x.mu.Unlock()
	rows, err := r.x.db.Query(`SELECT path, uid FROM ` + tablesOf(gen).notes + ` ORDER BY path`)
	if err != nil {
		r.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		var uid int64
		if err := rows.Scan(&p, &uid); err != nil {
			r.t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%s@%d", p, uid))
	}
	return out
}

// live is every searchable note live in the store now, as path@uid.
func (r *rig) live() []string {
	r.t.Helper()
	var out []string
	if err := r.st.EachAsOf(vault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if searchable(e) {
			out = append(out, fmt.Sprintf("%s@%d", e.Path, e.UID))
		}
		return true, nil
	}); err != nil {
		r.t.Fatal(err)
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The index follows every kind of write: an edit, a rename away and onto, a
// deletion, a folder, a file search does not read, and the same path used
// again, ending exactly where the store is.
func TestTheIndexFollowsEveryKindOfWrite(t *testing.T) {
	r := newRig(t)
	r.write("a.md", "alpha one")
	r.write("b.md", "bravo")
	r.write("pic.png", "not text")
	if _, err := writeNote(r.st, "folder", "", nil, true); err != nil {
		t.Fatal(err)
	}
	r.caughtUp()
	if got, want := r.held(), r.live(); !equal(got, want) {
		t.Fatalf("after the first writes the index holds %v, the store %v", got, want)
	}

	r.write("a.md", "alpha two")
	r.rename("b.md", "c.md", "bravo moved")
	r.remove("a.md")
	r.write("a.md", "alpha again")
	r.rename("c.md", "c.txt", "now plain text")
	r.rename("c.txt", "c.png", "now an image")
	s := r.caughtUp()
	if got, want := r.held(), r.live(); !equal(got, want) {
		t.Fatalf("the index holds %v, the store %v", got, want)
	}
	if s.Notes != 1 {
		t.Fatalf("status counts %d notes, want 1: %+v", s.Notes, s)
	}
	if why := r.x.checkDeep(r.x.active); why != "" {
		t.Fatalf("the deep check fails on a correct index: %s", why)
	}
}

// proposals is whether each note is a candidate for q.
func (r *rig) candidates(q notes.Query) map[string]bool {
	r.t.Helper()
	p, err := r.x.Propose(context.Background(), q, "", "")
	if err != nil {
		r.t.Fatal(err)
	}
	out := map[string]bool{}
	if err := r.st.EachAsOf(vault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if searchable(e) {
			out[e.Path] = p.Candidate(e.Path, e.UID, notes.NameMatches(e.Path, q))
		}
		return true, nil
	}); err != nil {
		r.t.Fatal(err)
	}
	return out
}

// The property the index exists under: for every query it proposes a
// superset of the notes the literal matcher finds, exactly and without regard
// to case, over text chosen to be hard: case pairs whose folds differ in
// length, NUL, lone carriage returns, emoji, combining marks and quotes,
// which are FTS5 syntax outside a phrase.
func TestAProposalNeverOmitsANoteTheMatcherFinds(t *testing.T) {
	r := newRig(t)
	alphabet := []string{"a", "A", "b", "B", "k", "\u212a", "s", "\u017f", "S", "\u03c3", "\u03c2", "\u03a3",
		"\u00df", "\u1e9e", "\x00", "\r", "\n", "\r\n", " ", "\"", "*", "\U0001f600", "e\u0301", "\u00e9", "\uffff",
		"\u0130", "i", "\u0131", ":", "(", "-", "^"}
	rng := rand.New(rand.NewSource(7))
	texts := map[string]string{}
	for i := 0; i < 40; i++ {
		var b strings.Builder
		for j := 0; j < 5+rng.Intn(60); j++ {
			b.WriteString(alphabet[rng.Intn(len(alphabet))])
		}
		path := fmt.Sprintf("n%02d.md", i)
		texts[path] = b.String()
		r.write(path, texts[path])
	}
	r.caughtUp()

	checked := 0
	for i := 0; i < 400; i++ {
		// A query cut from one of the texts, so most have matches, with its
		// case changed about half the time.
		src := texts[fmt.Sprintf("n%02d.md", rng.Intn(40))]
		runes := []rune(src)
		if len(runes) < 3 {
			continue
		}
		n := 3 + rng.Intn(min(6, len(runes)-2))
		start := rng.Intn(len(runes) - n + 1)
		query := string(runes[start : start+n])
		if rng.Intn(2) == 0 {
			query = strings.ToUpper(query)
		}
		if !utf8Valid(query) {
			continue
		}
		for _, caseSensitive := range []bool{false, true} {
			q := notes.Query{Text: query, Mode: notes.ModeContent, CaseSensitive: caseSensitive}
			got := r.candidates(q)
			for path, text := range texts {
				m, err := notes.NoteMatches(text, q)
				if err != nil {
					t.Fatal(err)
				}
				if len(m) > 0 && !got[path] {
					t.Fatalf("query %q (case-sensitive %v) matches %s and was not proposed", query, caseSensitive, path)
				}
			}
			checked++
		}
	}
	if checked < 300 {
		t.Fatalf("only %d queries were checked", checked)
	}

	// And it does narrow: a query in no note proposes nothing.
	if got := r.candidates(notes.Query{Text: "zzz-not-there", Mode: notes.ModeContent}); anyTrue(got) {
		t.Fatalf("a query nothing holds proposed %v", got)
	}
}

func utf8Valid(s string) bool { return utf8.ValidString(s) }

func anyTrue(m map[string]bool) bool {
	for _, v := range m {
		if v {
			return true
		}
	}
	return false
}

// A query of one or two characters is more than the trigram index can look
// up, so it proposes every note rather than none.
func TestAShortQueryScansEverything(t *testing.T) {
	r := newRig(t)
	r.write("a.md", "xy")
	r.write("b.md", "nothing")
	r.caughtUp()
	p, err := r.x.Propose(context.Background(), notes.Query{Text: "xy", Mode: notes.ModeContent}, "", "")
	if err != nil || p.Usable {
		t.Fatalf("a two-character query was narrowed: %+v %v", p, err)
	}
	if got := r.candidates(notes.Query{Text: "xy", Mode: notes.ModeContent}); !got["a.md"] || !got["b.md"] {
		t.Fatalf("candidates %v", got)
	}
}

// A note is trusted to the index only at the version the index holds: a
// write the worker has not reached yet is scanned.
func TestANoteTheIndexHasNotReachedIsScanned(t *testing.T) {
	r := newRig(t)
	r.write("a.md", "old words")
	r.caughtUp()
	hold := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	r.x.mu.Lock()
	r.x.beforeBatch = func(phase string) error {
		once.Do(func() { close(hold) })
		<-release
		return nil
	}
	r.x.mu.Unlock()
	uid := r.write("a.md", "new words")
	<-hold
	p, err := r.x.Propose(context.Background(), notes.Query{Text: "new words", Mode: notes.ModeContent}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Usable || p.IndexedHead >= uid {
		t.Fatalf("expected a usable proposal from before the edit: %+v", p)
	}
	if !p.Candidate("a.md", uid, false) {
		t.Fatal("a note edited after the index's head was not scanned")
	}
	close(release)
	r.caughtUp()
}

// A frontmatter the tag parser refuses limits that note's tags, is counted,
// and changes nothing about the write, which was committed before the index
// ever saw it, or about searching its text.
func TestATagParseFailureIsReportedAndNeverRejectsTheNote(t *testing.T) {
	r := newRig(t)
	r.write("broken.md", "---\ntags: [a\nno closing delimiter, and #inline text")
	r.write("fine.md", "#tagged body")
	r.write("bad.md", "\xff\xfe not UTF-8")
	s := r.caughtUp()
	if s.TagFailures != 1 || s.Unreadable != 1 {
		t.Fatalf("status %+v, want one tag failure and one unreadable note", s)
	}
	content := r.candidates(notes.Query{Text: "closing", Mode: notes.ModeContent})
	if !content["broken.md"] || content["fine.md"] {
		t.Fatalf("content candidates %v", content)
	}
	tags := r.candidates(notes.Query{Text: "tagged", Mode: notes.ModeTag, IncludeChildren: true})
	if !tags["fine.md"] || !tags["broken.md"] || !tags["bad.md"] {
		t.Fatalf("tag candidates %v: the note whose tags failed and the unreadable one must be scanned", tags)
	}
}

// Corruption is caught whatever index_version says: rows taken out of the
// tables under a matching version are noticed by the next query, which scans
// instead, and the worker builds a generation that is right again.
func TestATruncatedIndexWithAMatchingVersionIsCaught(t *testing.T) {
	for _, table := range []string{"fts", "notes", "tags"} {
		t.Run(table, func(t *testing.T) {
			r := newRig(t)
			for i := 0; i < 10; i++ {
				r.write(fmt.Sprintf("n%d.md", i), fmt.Sprintf("needle %d #tag%d", i, i))
			}
			before := r.caughtUp()
			tb := tablesOf(before.Generation)
			var stmt string
			switch table {
			case "fts":
				stmt = `DELETE FROM ` + tb.fts + ` WHERE rowid IN (SELECT id FROM ` + tb.notes + ` LIMIT 3)`
			case "notes":
				stmt = `DELETE FROM ` + tb.notes + ` WHERE path = 'n4.md'`
			case "tags":
				stmt = `DELETE FROM ` + tb.tags
			}
			var version int
			if err := r.x.db.QueryRow(`SELECT version FROM generations WHERE gen = ?`, before.Generation).Scan(&version); err != nil || version != IndexVersion {
				t.Fatalf("version %d %v", version, err)
			}
			if _, err := r.x.db.Exec(stmt); err != nil {
				t.Fatal(err)
			}
			p, err := r.x.Propose(context.Background(), notes.Query{Text: "needle", Mode: notes.ModeContent}, "", "")
			if err != nil {
				t.Fatal(err)
			}
			if p.Usable {
				t.Fatal("a truncated index still proposed candidates")
			}
			for i := 0; i < 10; i++ {
				if !p.Candidate(fmt.Sprintf("n%d.md", i), int64(i+1), false) {
					t.Fatalf("n%d.md is not scanned while the index is distrusted", i)
				}
			}
			after := r.caughtUp()
			if after.Generation <= before.Generation {
				t.Fatalf("no new generation after the corruption: %+v", after)
			}
			if got, want := r.held(), r.live(); !equal(got, want) {
				t.Fatalf("the rebuilt index holds %v, the store %v", got, want)
			}
		})
	}
}

// Rows removed with the counters and digest rewritten to match pass the
// cheap check, and the comparison with the store still finds them: the
// check does not trust anything the index says about itself.
func TestTheStoreComparisonCatchesWhatTheCountersCannot(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 5; i++ {
		r.write(fmt.Sprintf("n%d.md", i), "text")
	}
	s := r.caughtUp()
	g := *r.x.active
	tb := tablesOf(s.Generation)
	tx, err := r.x.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := remove(tx, tb, &g, "n2.md"); err != nil {
		t.Fatal(err)
	}
	if err := g.save(tx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if why := cheapCheck(r.x.db, tb, &g); why != "" {
		t.Fatalf("the consistent tampering was caught by the cheap check already: %s", why)
	}
	why := r.x.checkDeep(&g)
	if !strings.Contains(why, "1 notes missing") {
		t.Fatalf("the deep check said %q", why)
	}

	// Reopening runs the same check and rebuilds.
	r.x.Close()
	r.open()
	after := r.caughtUp()
	if after.Generation <= s.Generation {
		t.Fatalf("reopening a tampered index kept it: %+v", after)
	}
	if got, want := r.held(), r.live(); !equal(got, want) {
		t.Fatalf("the rebuilt index holds %v, the store %v", got, want)
	}
}

// A rebuild runs while the previous generation keeps answering, with its own
// indexed head, and while device writes carry on undelayed; it replays what
// they wrote and switches only once it matches the store.
func TestARebuildRunsBesideWritesAndTheOldGenerationAnswersMeanwhile(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 150; i++ {
		r.write(fmt.Sprintf("n%03d.md", i), fmt.Sprintf("needle %d", i))
	}
	before := r.caughtUp()

	paused := make(chan struct{})
	resume := make(chan struct{})
	var once sync.Once
	r.x.mu.Lock()
	r.x.beforeBatch = func(phase string) error {
		if phase == "snapshot" {
			once.Do(func() { close(paused) })
			<-resume
		}
		return nil
	}
	r.x.mu.Unlock()
	r.x.Rebuild()
	<-paused

	// Writes are not held up by the paused build.
	start := time.Now()
	for i := 0; i < 20; i++ {
		r.write(fmt.Sprintf("late%02d.md", i), "needle late")
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("twenty writes took %v beside a paused index build", time.Since(start))
	}
	s := r.x.Status()
	if !s.Rebuilding || s.Generation != before.Generation || !s.Usable {
		t.Fatalf("during the rebuild: %+v", s)
	}
	p, err := r.x.Propose(context.Background(), notes.Query{Text: "needle", Mode: notes.ModeContent}, "", "")
	if err != nil || !p.Usable || p.Generation != before.Generation || p.IndexedHead != before.IndexedHead {
		t.Fatalf("the previous generation did not answer: %+v %v", p, err)
	}
	if !p.Candidate("late00.md", 151, false) {
		t.Fatal("a note written after the previous generation's head is not scanned")
	}

	r.x.mu.Lock()
	r.x.beforeBatch = nil
	r.x.mu.Unlock()
	close(resume)
	after := r.caughtUp()
	if after.Generation != before.Generation+1 {
		t.Fatalf("after the rebuild: %+v", after)
	}
	if got, want := r.held(), r.live(); !equal(got, want) {
		t.Fatalf("the new generation holds %d notes, the store %d", len(got), len(want))
	}
}

// The worker failing never touches a write: every batch refused, the store
// still commits, and the index says what went wrong until it recovers.
func TestAFailingIndexNeverRefusesAWrite(t *testing.T) {
	r := newRig(t)
	r.write("a.md", "first")
	r.caughtUp()
	var fail sync.Mutex
	failing := true
	r.x.mu.Lock()
	r.x.beforeBatch = func(string) error {
		fail.Lock()
		defer fail.Unlock()
		if failing {
			return errors.New("the index disk is full")
		}
		return nil
	}
	r.x.mu.Unlock()
	for i := 0; i < 10; i++ {
		r.write(fmt.Sprintf("n%d.md", i), "written while the index fails")
	}
	deadline := time.Now().Add(10 * time.Second)
	for r.x.Status().Error == "" {
		if time.Now().After(deadline) {
			t.Fatal("the index never reported its failure")
		}
		time.Sleep(5 * time.Millisecond)
	}
	fail.Lock()
	failing = false
	fail.Unlock()
	r.caughtUp()
	if got, want := r.held(), r.live(); !equal(got, want) {
		t.Fatalf("after recovering the index holds %v, the store %v", got, want)
	}
	if r.x.Status().Error != "" {
		t.Fatalf("the error outlived the recovery: %+v", r.x.Status())
	}
}

// indexed_through is durable: a reopened index resumes where it stopped, and
// one opened for a restored store, whose epoch is new, starts again.
func TestTheIndexResumesAndStartsAgainForAnotherStore(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 5; i++ {
		r.write(fmt.Sprintf("n%d.md", i), "text")
	}
	s := r.caughtUp()
	r.x.Close()
	r.write("after.md", "written while the index was closed")
	r.open()
	s2 := r.caughtUp()
	if s2.Generation != s.Generation {
		t.Fatalf("reopening rebuilt a sound index: %+v then %+v", s, s2)
	}
	if got, want := r.held(), r.live(); !equal(got, want) {
		t.Fatalf("after reopening the index holds %v, the store %v", got, want)
	}

	// The same file under a store with another epoch is not this store's.
	r.x.Close()
	other := t.TempDir()
	dbPath, chunkDir := store.DataDir(other)
	st2, err := store.OpenWithSync(dbPath, chunkDir, store.SyncNormal)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	if err := st2.EnsureVault(vault, 1); err != nil {
		t.Fatal(err)
	}
	copyFile(t, filepath.Join(r.dir, FileName), filepath.Join(other, FileName))
	x2, err := Open(other, st2, vault, quiet())
	if err != nil {
		t.Fatal(err)
	}
	defer x2.Close()
	if st := x2.Status(); st.Generation != 0 || st.Usable {
		t.Fatalf("another store's index was adopted: %+v", st)
	}
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// The map the index applies keeps containment and removes NUL, which FTS5
// cannot take in a query.
func TestIndexTextPreservesContainment(t *testing.T) {
	cases := []struct{ text, query string }{
		{"a\x00bc", "\x00bc"}, {"K\u212a", "\u212a"}, {"STRASSE", "strasse"}, {"x\"y\"z", "\"y\""},
	}
	for _, c := range cases {
		if !strings.Contains(indexText(c.text), indexText(c.query)) {
			t.Errorf("%q no longer contains %q once mapped", c.text, c.query)
		}
		if strings.ContainsRune(indexText(c.text), 0) {
			t.Errorf("%q keeps a NUL", c.text)
		}
	}
}
