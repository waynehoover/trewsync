// Package search keeps the index search_notes uses to propose candidate
// notes: a derived view of the store, maintained outside the write path
// (PLAN.md section 2.5).
//
// Three rules shape it.
//
// It can never refuse or delay a device's write. The index lives in its own
// database file beside the store's, written by one worker goroutine that reads
// committed entries and never takes the store's write lock or the server's
// commit lock. What it owes is recorded durably as indexed_through_uid, in the
// same transaction as the index changes it covers, so a restart resumes from
// where the last committed batch ended and the store's entries are the only
// work queue. A commit only nudges the worker, without waiting; a note the
// parser chokes on is recorded with its reason and passed over.
//
// It only proposes. Literal search stays literal: internal/notes decides every
// match, and the index is used only where it cannot omit one. It holds each
// note's text folded character by character through the same case fold the
// matcher uses, in an FTS5 table with the trigram tokenizer and its own case
// folding off, so a query of three characters or more finds every note whose
// folded text contains the folded query, a superset of the notes the matcher
// will accept, exactly or without regard to case. A shorter query, a note
// indexed at a different version than the one being searched, and a note that
// could not be indexed are always scanned. So a lagging index costs speed and
// never a result.
//
// It is generational and checked. A rebuild captures a head, indexes the
// vault as it stood then in bounded batches, replays the entries after it,
// verifies the result against the store, and only then becomes the generation
// queries use; the previous one stays queryable meanwhile with its own
// indexed head. Corruption is detected by the index's own counters and digest,
// checked on every query, and by comparing it with the store, at open and
// periodically, never by trusting a version number: a table truncated under a
// matching index_version is exactly the failure the checks exist for.
package search

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/store"

	_ "modernc.org/sqlite"
)

// IndexVersion is what this build's index is: the tokenizer, the fold and
// the tag parser together. A generation of another version is not trusted to
// propose candidates, and is rebuilt.
const IndexVersion = 1

// FileName is the index's database, in the data directory beside the store.
// It is derived and never backed up: a lost or damaged one is rebuilt from the
// store.
const FileName = "search.db"

// Index is one vault's search index.
type Index struct {
	db    *sql.DB
	st    *store.Store
	vault string
	log   *slog.Logger

	mu       sync.Mutex
	active   *generation // what queries use, or nil before the first build
	building *generation // a build in progress, or nil
	distrust string      // why the active generation is not trusted, or ""
	failed   string      // the last error the worker met, or ""

	sub  store.Committed
	wake chan struct{}
	stop chan struct{}
	done chan struct{}
	once sync.Once

	// backoff and retryBuild pace builds that fail their check; only the
	// worker reads or writes them.
	backoff    time.Duration
	retryBuild time.Time

	// Test hooks, nil otherwise. beforeBatch runs before each batch the
	// worker commits, with the phase it is in; an error from it stands in for
	// the batch failing.
	beforeBatch func(phase string) error
	// verifyEvery is how often an idle worker compares the index with the
	// store.
	verifyEvery time.Duration
}

// generation is one generation's row in the generations table.
type generation struct {
	gen     int64
	version int
	state   string // building, active or retired
	phase   string // snapshot, replay or done
	// builtHead is the head a building generation's snapshot is of, and
	// cursor the last path its snapshot has indexed.
	builtHead int64
	cursor    string
	// through is indexed_through_uid: every entry at or below it is in.
	through int64
	// The counters and the digest the checks compare the tables against.
	notes, fts, tags        int64
	digest                  string
	unreadable, tagFailures int64
	createdAt               int64
}

const metaSchema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generations (
  gen          INTEGER PRIMARY KEY,
  version      INTEGER NOT NULL,
  state        TEXT    NOT NULL,
  phase        TEXT    NOT NULL,
  built_head   INTEGER NOT NULL,
  cursor       TEXT    NOT NULL DEFAULT '',
  through      INTEGER NOT NULL DEFAULT 0,
  notes        INTEGER NOT NULL DEFAULT 0,
  fts          INTEGER NOT NULL DEFAULT 0,
  tags         INTEGER NOT NULL DEFAULT 0,
  digest       TEXT    NOT NULL DEFAULT '',
  unreadable   INTEGER NOT NULL DEFAULT 0,
  tag_failures INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
`

// tables are one generation's table names.
type tables struct{ notes, tags, fts string }

func tablesOf(gen int64) tables {
	p := fmt.Sprintf("g%d_", gen)
	return tables{notes: p + "notes", tags: p + "tags", fts: p + "fts"}
}

func (t tables) create(q execer) error {
	_, err := q.Exec(`
CREATE TABLE IF NOT EXISTS ` + t.notes + ` (
  id         INTEGER PRIMARY KEY,
  path       TEXT    NOT NULL UNIQUE,
  uid        INTEGER NOT NULL,
  content_ok INTEGER NOT NULL,
  reason     TEXT    NOT NULL,
  tag_error  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS ` + t.tags + ` (
  note_id INTEGER NOT NULL,
  tag     TEXT    NOT NULL,
  PRIMARY KEY (note_id, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ` + t.tags + `_by_tag ON ` + t.tags + `(tag);
CREATE VIRTUAL TABLE IF NOT EXISTS ` + t.fts + ` USING fts5(body, content='', contentless_delete=1,
  tokenize='trigram case_sensitive 1');
`)
	return err
}

func (t tables) drop(q execer) error {
	_, err := q.Exec(`DROP TABLE IF EXISTS ` + t.fts + `; DROP TABLE IF EXISTS ` + t.tags + `; DROP TABLE IF EXISTS ` + t.notes + `;`)
	return err
}

type execer interface {
	Exec(string, ...any) (sql.Result, error)
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}

// Open opens, or creates, the index for vault in dataDir, and checks it. It
// does not start the worker; Start does.
func Open(dataDir string, st *store.Store, vault string, log *slog.Logger) (*Index, error) {
	if log == nil {
		log = slog.Default()
	}
	path, err := filepath.Abs(filepath.Join(dataDir, FileName))
	if err != nil {
		return nil, err
	}
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	// NORMAL, not FULL: a commit lost to a power cut takes its own
	// indexed_through with it, so the worker indexes those entries again.
	// The index is derived, and nothing is acknowledged on its strength.
	db, err := sql.Open("sqlite", u.String()+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"+
		"&_pragma=synchronous(NORMAL)&_pragma=temp_store(2)")
	if err != nil {
		return nil, err
	}
	x := &Index{
		db: db, st: st, vault: vault, log: log,
		wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{}),
		verifyEvery: 10 * time.Minute,
	}
	if err := x.load(); err != nil {
		db.Close()
		return nil, fmt.Errorf("opening the search index: %w", err)
	}
	return x, nil
}

// load reads the generations, dropping everything when the index was built
// for another store, and checks the active one.
func (x *Index) load() error {
	if _, err := x.db.Exec(metaSchema); err != nil {
		return err
	}
	belongs := x.st.Epoch() + "\x00" + x.vault
	var owner string
	err := x.db.QueryRow(`SELECT value FROM meta WHERE key = 'owner'`).Scan(&owner)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if owner != belongs {
		// Another store's index, or a restored store's (a restore mints a
		// new epoch, PLAN.md section 2.8): none of it describes these notes.
		if err := x.dropAll(); err != nil {
			return err
		}
		if _, err := x.db.Exec(`INSERT INTO meta (key, value) VALUES ('owner', ?)
		  ON CONFLICT(key) DO UPDATE SET value = excluded.value`, belongs); err != nil {
			return err
		}
	}
	gens, err := x.generations()
	if err != nil {
		return err
	}
	for _, g := range gens {
		switch g.state {
		case "active":
			x.active = g
		case "building":
			x.building = g
		default:
			if err := x.retire(g.gen); err != nil {
				return err
			}
		}
	}
	if x.active != nil {
		if why := x.checkDeep(x.active); why != "" {
			x.distrusted(why)
		}
	}
	return nil
}

func (x *Index) dropAll() error {
	gens, err := x.generations()
	if err != nil {
		return err
	}
	for _, g := range gens {
		if err := x.retire(g.gen); err != nil {
			return err
		}
	}
	return nil
}

// retire drops a generation's tables and its row.
func (x *Index) retire(gen int64) error {
	if err := tablesOf(gen).drop(x.db); err != nil {
		return err
	}
	_, err := x.db.Exec(`DELETE FROM generations WHERE gen = ?`, gen)
	return err
}

func (x *Index) generations() ([]*generation, error) {
	rows, err := x.db.Query(`SELECT ` + genCols + ` FROM generations ORDER BY gen`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*generation
	for rows.Next() {
		g, err := scanGeneration(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

const genCols = `gen, version, state, phase, built_head, cursor, through, notes, fts, tags, digest,
  unreadable, tag_failures, created_at`

type scanner interface{ Scan(...any) error }

func scanGeneration(r scanner) (*generation, error) {
	g := &generation{}
	err := r.Scan(&g.gen, &g.version, &g.state, &g.phase, &g.builtHead, &g.cursor, &g.through,
		&g.notes, &g.fts, &g.tags, &g.digest, &g.unreadable, &g.tagFailures, &g.createdAt)
	return g, err
}

func (g *generation) save(q execer) error {
	_, err := q.Exec(`UPDATE generations SET state = ?, phase = ?, built_head = ?, cursor = ?, through = ?,
	  notes = ?, fts = ?, tags = ?, digest = ?, unreadable = ?, tag_failures = ? WHERE gen = ?`,
		g.state, g.phase, g.builtHead, g.cursor, g.through, g.notes, g.fts, g.tags, g.digest,
		g.unreadable, g.tagFailures, g.gen)
	return err
}

// distrusted records why the active generation is not to be trusted, and
// asks for a new one.
func (x *Index) distrusted(why string) {
	x.log.Warn("the search index is not trusted; search scans until it is rebuilt", "why", why)
	x.mu.Lock()
	x.distrust = why
	x.mu.Unlock()
	x.nudge()
}

func (x *Index) nudge() {
	select {
	case x.wake <- struct{}{}:
	default:
	}
}

// Start starts the worker.
func (x *Index) Start() {
	x.sub = x.st.Subscribe()
	go x.run()
}

// Close stops the worker, waiting for the batch it is in, and closes the
// index.
func (x *Index) Close() error {
	started := x.sub.C != nil
	x.once.Do(func() { close(x.stop) })
	if started {
		<-x.done
		x.sub.Stop()
	}
	return x.db.Close()
}

// Rebuild starts a new generation while the current one keeps answering.
func (x *Index) Rebuild() {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.building == nil {
		x.building = &generation{} // started by the worker
	}
	x.nudge()
}

// Status is what vault_status reports about the index.
type Status struct {
	// Generation is the generation queries use, 0 before the first is built.
	Generation int64 `json:"generation"`
	// IndexedHead is its indexed_through_uid.
	IndexedHead int64 `json:"indexedHead"`
	// Usable says the generation may propose candidates. When it may not,
	// every search scans, and Distrust says why.
	Usable   bool   `json:"usable"`
	Distrust string `json:"distrust,omitempty"`
	// Rebuilding says a new generation is being built, and BuildingHead how
	// far it has got.
	Rebuilding   bool  `json:"rebuilding"`
	BuildingHead int64 `json:"buildingHead,omitempty"`
	// Notes is how many notes the generation holds; Unreadable how many of
	// them it could not read the text of, and TagFailures how many whose tags
	// it could not read. Each is still searched, by scanning, and reported
	// by the search that meets it.
	Notes       int64 `json:"notes"`
	Unreadable  int64 `json:"unreadable"`
	TagFailures int64 `json:"tagFailures"`
	// Error is the last error the worker met, or empty.
	Error string `json:"error,omitempty"`
}

// Status says what the index is doing.
func (x *Index) Status() Status {
	x.mu.Lock()
	defer x.mu.Unlock()
	s := Status{Distrust: x.distrust, Error: x.failed}
	if g := x.active; g != nil {
		s.Generation, s.IndexedHead = g.gen, g.through
		s.Notes, s.Unreadable, s.TagFailures = g.notes, g.unreadable, g.tagFailures
		s.Usable = x.distrust == "" && g.version == IndexVersion
		if g.version != IndexVersion && s.Distrust == "" {
			s.Distrust = fmt.Sprintf("the index is version %d and this build reads version %d", g.version, IndexVersion)
		}
	} else if s.Distrust == "" {
		s.Distrust = "the index has not been built yet"
	}
	if b := x.building; b != nil {
		s.Rebuilding = true
		s.BuildingHead = b.through
		if b.phase == "snapshot" {
			s.BuildingHead = 0
		}
	}
	return s
}

// indexed is one note as the index holds it.
type indexed struct {
	uid       int64
	contentOK bool
	tagError  string
}

// Proposal is what the index says about one search page's candidates.
type Proposal struct {
	// Generation and IndexedHead are the generation that proposed, and how
	// far it had indexed.
	Generation  int64
	IndexedHead int64
	// Usable says the index narrowed the candidates. When it did not, Why
	// says why, and every note is a candidate.
	Usable bool
	Why    string
	mode   notes.SearchMode
	notes  map[string]indexed
	hits   map[string]bool
}

// Candidate reports whether the note at path, in its version uid, must be
// scanned for q: always, unless the index holds that very version and knows
// its text or tags cannot match. nameMatches is whether the file name
// matches, which in both mode makes it a candidate on its own.
func (p Proposal) Candidate(path string, uid int64, nameMatches bool) bool {
	switch p.mode {
	case notes.ModeFilename:
		return nameMatches
	case notes.ModeBoth:
		if nameMatches {
			return true
		}
	}
	if !p.Usable {
		return true
	}
	ix, ok := p.notes[path]
	if !ok || ix.uid != uid || !ix.contentOK {
		return true
	}
	if p.mode == notes.ModeTag && ix.tagError != "" {
		return true
	}
	return p.hits[path]
}

// Propose asks the index which notes may hold matches of q, among the paths
// in folder (all when empty) from from onwards. The proposal is checked
// against the generation's own counters in the same read, so an index whose
// tables no longer add up proposes nothing and is rebuilt.
func (x *Index) Propose(ctx context.Context, q notes.Query, folder, from string) (Proposal, error) {
	p := Proposal{mode: q.Mode}
	if q.Mode == notes.ModeFilename {
		return p, nil
	}
	// A copy, taken under the lock: the worker rewrites the generation in
	// place as its batches commit.
	x.mu.Lock()
	var g *generation
	if x.active != nil {
		copied := *x.active
		g = &copied
	}
	distrust := x.distrust
	x.mu.Unlock()
	switch {
	case g == nil:
		p.Why = "the index has not been built yet"
		return p, nil
	case distrust != "":
		p.Why = distrust
		return p, nil
	case g.version != IndexVersion:
		p.Why = "the index is of another version"
		return p, nil
	}
	var match string
	if q.Mode == notes.ModeTag {
		tag, err := notes.ValidateTag(q.Text)
		if err != nil {
			return p, err
		}
		match = notes.FoldTag(tag)
	} else {
		match = indexText(q.Text)
		if len([]rune(match)) < 3 {
			p.Why = "a query of one or two characters is shorter than any the index can look up"
			return p, nil
		}
	}

	tx, err := x.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return p, err
	}
	defer tx.Rollback()
	var now generation
	row := tx.QueryRow(`SELECT `+genCols+` FROM generations WHERE gen = ?`, g.gen)
	current, err := scanGeneration(row)
	if err != nil {
		// Switched away since it was read: this page scans.
		p.Why = "the index generation changed while it was being read"
		return p, nil
	}
	now = *current
	t := tablesOf(now.gen)
	if why := cheapCheck(tx, t, &now); why != "" {
		x.distrusted(why)
		p.Why = why
		return p, nil
	}

	lo, hi := from, ""
	if folder != "" {
		lo, hi = max(from, folder+"/"), folder+"0"
	}
	p.notes = map[string]indexed{}
	rows, err := tx.Query(`SELECT path, uid, content_ok, tag_error FROM `+t.notes+`
	  WHERE path >= ?1 AND (?2 = '' OR path < ?2)`, lo, hi)
	if err != nil {
		return p, err
	}
	for rows.Next() {
		var path, tagError string
		var ix indexed
		if err := rows.Scan(&path, &ix.uid, &ix.contentOK, &tagError); err != nil {
			rows.Close()
			return p, err
		}
		ix.tagError = tagError
		p.notes[path] = ix
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return p, err
	}

	p.hits = map[string]bool{}
	if q.Mode == notes.ModeTag {
		rows, err = tx.Query(`SELECT n.path FROM `+t.tags+` g JOIN `+t.notes+` n ON n.id = g.note_id
		  WHERE g.tag = ?1 OR (?2 AND g.tag >= ?3 AND g.tag < ?4)`,
			match, q.IncludeChildren, match+"/", match+"0")
	} else {
		rows, err = tx.Query(`SELECT n.path FROM `+t.fts+` f JOIN `+t.notes+` n ON n.id = f.rowid
		  WHERE `+t.fts+` MATCH ?`, ftsPhrase(match))
	}
	if err != nil {
		return p, err
	}
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return p, err
		}
		p.hits[path] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return p, err
	}
	p.Generation, p.IndexedHead, p.Usable = now.gen, now.through, true
	return p, nil
}

// indexText is what the index holds for a note's text, and what a query is
// looked up as: every character through the matcher's case fold, and NUL,
// which FTS5 cannot take inside a query, as U+FFFF. Both maps take one
// character to one character, so a text containing a query still contains it
// after the map, which is the whole of why a proposal cannot omit a match.
func indexText(s string) string {
	return strings.ReplaceAll(notes.FoldLiteral(s), "\x00", "\uffff")
}

// ftsPhrase is the query as one FTS5 phrase: quoted, with its quotes doubled,
// so no character in it is FTS5 syntax.
func ftsPhrase(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// cheapCheck compares a generation's table sizes with the counters it
// recorded, inside the caller's read, so a truncated table is caught by the
// next query whatever its version says.
func cheapCheck(q execer, t tables, g *generation) string {
	var notesN, ftsN, tagsN int64
	if err := q.QueryRow(`SELECT (SELECT COUNT(*) FROM `+t.notes+`), (SELECT COUNT(*) FROM `+t.fts+`),
	  (SELECT COUNT(*) FROM `+t.tags+`)`).Scan(&notesN, &ftsN, &tagsN); err != nil {
		return "the index tables cannot be read: " + err.Error()
	}
	if notesN != g.notes || ftsN != g.fts || tagsN != g.tags {
		return fmt.Sprintf("the index holds %d notes, %d texts and %d tags where it recorded %d, %d and %d",
			notesN, ftsN, tagsN, g.notes, g.fts, g.tags)
	}
	return ""
}

// digestOf is one note's share of a generation's digest: the SHA-256 of its
// path and uid, which are XORed together so a row can be added or taken away
// in any order.
func digestOf(path string, uid int64) [32]byte {
	return sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d", path, uid)))
}

func xorDigest(hexed string, d [32]byte) string {
	cur := digestValue(hexed)
	for i := range cur {
		cur[i] ^= d[i]
	}
	return hex.EncodeToString(cur[:])
}

// digestValue is a recorded digest, the empty one for no notes at all.
func digestValue(hexed string) [32]byte {
	var cur [32]byte
	if b, err := hex.DecodeString(hexed); err == nil && len(b) == 32 {
		copy(cur[:], b)
	}
	return cur
}

func sameDigest(a, b string) bool { return digestValue(a) == digestValue(b) }

// searchable is whether an entry is a note the index holds: a file, not a
// folder or a deletion, at a path search reads (internal/paths.Searchable).
func searchable(e store.Entry) bool {
	return !e.Folder && !e.Deleted && paths.Searchable(e.Path)
}
