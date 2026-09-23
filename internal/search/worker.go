package search

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/store"
)

// The worker: one goroutine that owns every write to the index.

// batchEntries is how many store entries one incremental batch reads, and
// batchNotes how many notes one snapshot batch indexes. Each batch is one
// transaction of the index's database, so a restart loses at most one.
const (
	batchEntries = 200
	batchNotes   = 64
)

// pollEvery is how often an idle worker looks at the store even when no
// commit has nudged it, which covers a nudge lost to a restart.
const pollEvery = 5 * time.Second

func (x *Index) run() {
	defer close(x.done)
	lastVerify := time.Now()
	var retry time.Duration
	for {
		select {
		case <-x.stop:
			return
		default:
		}
		progressed, err := x.step()
		x.mu.Lock()
		if err != nil {
			x.failed = err.Error()
		} else if progressed {
			x.failed = ""
		}
		x.mu.Unlock()
		if err != nil {
			// A failing batch is retried after a pause that doubles to a
			// minute, and commits do not cut it short: on a busy vault they
			// would otherwise retry it, and log it, once per commit.
			retry = min(max(2*retry, 50*time.Millisecond), time.Minute)
			x.log.Warn("the search index worker failed a batch; it will try again", "err", err, "in", retry)
			select {
			case <-x.stop:
				return
			case <-time.After(retry):
			}
			continue
		}
		retry = 0
		if progressed {
			continue
		}
		if time.Since(lastVerify) >= x.verifyEvery {
			lastVerify = time.Now()
			x.verifyActive()
			continue
		}
		select {
		case <-x.stop:
			return
		case <-x.sub.C:
		case <-x.wake:
		case <-time.After(pollEvery):
		}
	}
}

// step does one batch of whatever is owed, and reports whether it did any.
func (x *Index) step() (bool, error) {
	x.mu.Lock()
	active, building, distrust := x.active, x.building, x.distrust
	x.mu.Unlock()

	if building == nil && (active == nil || distrust != "" || active.version != IndexVersion) {
		x.mu.Lock()
		if x.building == nil {
			x.building = &generation{}
		}
		building = x.building
		x.mu.Unlock()
	}
	if building != nil {
		if building.gen == 0 && time.Now().Before(x.retryBuild) {
			// A build that failed its check waits before the next attempt,
			// which doubles each time, so a fault that makes every build fail
			// is a line in the log every few minutes rather than a loop.
			if active != nil && distrust == "" {
				return x.incrementalStep(active)
			}
			return false, nil
		}
		return x.buildStep(building)
	}
	return x.incrementalStep(active)
}

// buildStep advances a build by one batch: start it, index one batch of its
// snapshot, replay one batch of what came after, or verify it and switch.
func (x *Index) buildStep(b *generation) (bool, error) {
	if b.gen == 0 {
		return true, x.startBuild(b)
	}
	switch b.phase {
	case "snapshot":
		return true, x.snapshotBatch(b)
	case "replay":
		progressed, err := x.incrementalStep(b)
		if err != nil || progressed {
			return true, err
		}
		return true, x.finishBuild(b)
	}
	return false, fmt.Errorf("generation %d is in phase %q", b.gen, b.phase)
}

// startBuild creates a new generation, of the head as it is now.
func (x *Index) startBuild(b *generation) error {
	head, err := x.st.LatestUID(x.vault)
	if err != nil {
		return err
	}
	// Generations retired by an earlier switch are dropped only now, so a
	// query that was still reading one when it was retired was never reading
	// a table that had gone.
	gens, err := x.generations()
	if err != nil {
		return err
	}
	var next int64 = 1
	for _, g := range gens {
		if g.gen >= next {
			next = g.gen + 1
		}
		if g.state == "retired" {
			if err := x.retire(g.gen); err != nil {
				return err
			}
		}
	}
	fresh := generation{gen: next, version: IndexVersion, state: "building", phase: "snapshot",
		builtHead: head, createdAt: time.Now().UnixMilli()}
	err = x.inTx(func(tx *sql.Tx) error {
		if err := tablesOf(fresh.gen).create(tx); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO generations (gen, version, state, phase, built_head, created_at)
		  VALUES (?, ?, ?, ?, ?, ?)`, fresh.gen, fresh.version, fresh.state, fresh.phase, fresh.builtHead, fresh.createdAt)
		return err
	})
	if err != nil {
		return err
	}
	x.mu.Lock()
	*b = fresh
	x.mu.Unlock()
	x.log.Info("building a search index generation", "generation", fresh.gen, "head", head)
	return nil
}

// snapshotBatch indexes the next batch of the notes live at the build's head.
func (x *Index) snapshotBatch(b *generation) error {
	if err := x.hook("snapshot"); err != nil {
		return err
	}
	var batch []store.Entry
	err := x.st.EachAsOf(x.vault, b.builtHead, store.AsOfRange{After: b.cursor}, func(e store.Entry) (bool, error) {
		if searchable(e) {
			batch = append(batch, e)
		}
		return len(batch) < batchNotes, nil
	})
	if err != nil {
		return err
	}
	next := *b
	if len(batch) == 0 {
		// The snapshot is complete: everything at or below its head is in.
		next.phase, next.through, next.cursor = "replay", b.builtHead, ""
		return x.commit(b, &next, func(*sql.Tx) error { return nil })
	}
	docs := make([]doc, len(batch))
	for i, e := range batch {
		full, state, _, err := x.st.EntryAsOf(x.vault, e.Path, b.builtHead)
		if err != nil {
			return err
		}
		if state != store.PathLive || full.UID != e.UID {
			return fmt.Errorf("uid %d changed while the index was reading it", e.UID)
		}
		docs[i] = x.prepare(full)
	}
	next.cursor = batch[len(batch)-1].Path
	return x.commit(b, &next, func(tx *sql.Tx) error {
		t := tablesOf(next.gen)
		for i, e := range batch {
			if err := put(tx, t, &next, e.Path, e.UID, docs[i]); err != nil {
				return err
			}
		}
		return nil
	})
}

// incrementalStep applies the next batch of entries after g's
// indexed_through. It reports whether there was a batch.
func (x *Index) incrementalStep(g *generation) (bool, error) {
	batch, ok, err := x.st.NextBatch(x.vault, g.through, batchEntries)
	if err != nil || !ok {
		return false, err
	}
	if err := x.hook(g.phase); err != nil {
		return false, err
	}
	// The state each touched path is left in by the batch, in order: a later
	// entry supersedes an earlier one, and a rename takes its source away.
	type final struct {
		entry  store.Entry
		remove bool
	}
	finals := map[string]final{}
	var order []string
	touch := func(path string, f final) {
		if _, seen := finals[path]; !seen {
			order = append(order, path)
		}
		finals[path] = f
	}
	for _, e := range batch.Entries {
		if e.Prev != "" {
			touch(e.Prev, final{remove: true})
		}
		touch(e.Path, final{entry: e, remove: !searchable(e)})
	}
	docs := map[string]doc{}
	for _, path := range order {
		if f := finals[path]; !f.remove {
			docs[path] = x.prepare(f.entry)
		}
	}
	next := *g
	next.through = batch.To
	return true, x.commit(g, &next, func(tx *sql.Tx) error {
		t := tablesOf(next.gen)
		for _, path := range order {
			f := finals[path]
			if f.remove {
				if err := remove(tx, t, &next, path); err != nil {
					return err
				}
				continue
			}
			if err := put(tx, t, &next, path, f.entry.UID, docs[path]); err != nil {
				return err
			}
		}
		return nil
	})
}

// finishBuild verifies a caught-up build against the store and makes it the
// generation queries use.
func (x *Index) finishBuild(b *generation) error {
	if why := x.checkDeep(b); why != "" {
		// A generation that does not match the store it was just built from
		// is not switched to. Built again from the start, it either comes out
		// right or keeps saying why it cannot.
		x.log.Warn("a new search index generation failed its check; building again", "generation", b.gen, "why", why)
		if err := x.retire(b.gen); err != nil {
			return err
		}
		x.backoff = min(max(2*x.backoff, 10*time.Second), 10*time.Minute)
		x.retryBuild = time.Now().Add(x.backoff)
		x.mu.Lock()
		*b = generation{}
		x.mu.Unlock()
		return fmt.Errorf("the new index generation failed its check: %s", why)
	}
	x.backoff = 0
	x.mu.Lock()
	old := x.active
	x.mu.Unlock()
	next := *b
	next.state, next.phase = "active", "done"
	err := x.inTx(func(tx *sql.Tx) error {
		if old != nil {
			if _, err := tx.Exec(`UPDATE generations SET state = 'retired' WHERE gen = ?`, old.gen); err != nil {
				return err
			}
		}
		return next.save(tx)
	})
	if err != nil {
		return err
	}
	x.mu.Lock()
	x.active, x.building, x.distrust = &next, nil, ""
	x.mu.Unlock()
	x.log.Info("the search index switched generation", "generation", next.gen, "indexedHead", next.through, "notes", next.notes)
	return nil
}

// verifyActive compares the active generation with the store, and distrusts
// it if the two disagree.
func (x *Index) verifyActive() {
	x.mu.Lock()
	g, distrust := x.active, x.distrust
	x.mu.Unlock()
	if g == nil || distrust != "" {
		return
	}
	if why := x.checkDeep(g); why != "" {
		x.distrusted(why)
	}
}

func (x *Index) hook(phase string) error {
	x.mu.Lock()
	h := x.beforeBatch
	x.mu.Unlock()
	if h != nil {
		return h(phase)
	}
	return nil
}

func (x *Index) inTx(fn func(*sql.Tx) error) error {
	tx, err := x.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// commit runs one batch's changes and saves next, the generation as they
// leave it, in one transaction, and only then makes next the generation's
// state in memory: a batch that fails leaves both as they were.
func (x *Index) commit(g, next *generation, fn func(*sql.Tx) error) error {
	err := x.inTx(func(tx *sql.Tx) error {
		if err := fn(tx); err != nil {
			return err
		}
		return next.save(tx)
	})
	if err != nil {
		return err
	}
	x.mu.Lock()
	*g = *next
	x.mu.Unlock()
	return nil
}

// doc is one note as the index is about to hold it.
type doc struct {
	text      string
	contentOK bool
	reason    string
	tags      []string
	tagError  string
}

// prepare reads a note's text and tags for the index. Nothing here fails the
// batch: a note that cannot be read is held as unreadable with its reason, and
// one whose tags cannot be read as such, and both are scanned by every search
// that could match them, which reports what it met (PLAN.md section 2.5).
func (x *Index) prepare(e store.Entry) (d doc) {
	if e.Size > notes.NoteBytes {
		return doc{reason: "note_too_large"}
	}
	body, err := x.assemble(e)
	if err != nil {
		return doc{reason: "unreadable"}
	}
	source, err := notes.DecodeNote(body)
	if err != nil {
		var r *notes.Refusal
		if errors.As(err, &r) {
			return doc{reason: r.Code}
		}
		return doc{reason: "unreadable"}
	}
	d = doc{text: indexText(source), contentOK: true}
	defer func() {
		// The parser is new code on hostile input. A panic in it limits
		// this note's tags, as a parse failure does, and stops nothing else.
		if p := recover(); p != nil {
			x.log.Error("the tag parser failed on a note", "uid", e.UID, "panic", fmt.Sprint(p))
			d.tags, d.tagError = nil, "internal"
		}
	}()
	occ, err := notes.TagOccurrences(source)
	if err != nil {
		var r *notes.Refusal
		d.tagError = "invalid_frontmatter"
		if errors.As(err, &r) {
			d.tagError = r.Code
		}
		return d
	}
	seen := map[string]bool{}
	for _, o := range occ {
		if tag := notes.FoldTag(o.Tag); !seen[tag] {
			seen[tag] = true
			d.tags = append(d.tags, tag)
		}
	}
	return d
}

// assemble is a version's bytes, each chunk checked against its name as the
// chunk store reads it.
func (x *Index) assemble(e store.Entry) ([]byte, error) {
	out := make([]byte, 0, e.Size)
	for _, name := range e.Chunks {
		body, err := x.st.Chunks().Get(x.vault, name)
		if err != nil {
			return nil, err
		}
		out = append(out, body...)
	}
	if int64(len(out)) != e.Size {
		return nil, fmt.Errorf("uid %d assembles to %d bytes and declares %d", e.UID, len(out), e.Size)
	}
	return out, nil
}

// put replaces path's row with this version, inside tx, keeping g's counters
// and digest.
func put(tx *sql.Tx, t tables, g *generation, path string, uid int64, d doc) error {
	if err := remove(tx, t, g, path); err != nil {
		return err
	}
	res, err := tx.Exec(`INSERT INTO `+t.notes+` (path, uid, content_ok, reason, tag_error) VALUES (?, ?, ?, ?, ?)`,
		path, uid, d.contentOK, d.reason, d.tagError)
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	g.notes++
	g.digest = xorDigest(g.digest, digestOf(path, uid))
	if !d.contentOK {
		g.unreadable++
		return nil
	}
	if _, err := tx.Exec(`INSERT INTO `+t.fts+` (rowid, body) VALUES (?, ?)`, id, d.text); err != nil {
		return err
	}
	g.fts++
	if d.tagError != "" {
		g.tagFailures++
	}
	for _, tag := range d.tags {
		if _, err := tx.Exec(`INSERT INTO `+t.tags+` (note_id, tag) VALUES (?, ?)`, id, tag); err != nil {
			return err
		}
		g.tags++
	}
	return nil
}

// remove takes path's row out, if it has one.
func remove(tx *sql.Tx, t tables, g *generation, path string) error {
	var id, uid int64
	var contentOK bool
	var tagError string
	err := tx.QueryRow(`SELECT id, uid, content_ok, tag_error FROM `+t.notes+` WHERE path = ?`, path).
		Scan(&id, &uid, &contentOK, &tagError)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if contentOK {
		if _, err := tx.Exec(`DELETE FROM `+t.fts+` WHERE rowid = ?`, id); err != nil {
			return err
		}
		g.fts--
		if tagError != "" {
			g.tagFailures--
		}
	} else {
		g.unreadable--
	}
	res, err := tx.Exec(`DELETE FROM `+t.tags+` WHERE note_id = ?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	g.tags -= n
	if _, err := tx.Exec(`DELETE FROM `+t.notes+` WHERE id = ?`, id); err != nil {
		return err
	}
	g.notes--
	g.digest = xorDigest(g.digest, digestOf(path, uid))
	return nil
}

// checkDeep compares a generation with the store it describes: the notes it
// holds must be exactly the searchable files live at its indexed_through, at
// their versions there, and its tables must add up to its counters and its
// digest. It returns why not, or "".
func (x *Index) checkDeep(g *generation) string {
	if g.phase == "snapshot" {
		return ""
	}
	t := tablesOf(g.gen)
	tx, err := x.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return "the index cannot be read: " + err.Error()
	}
	defer tx.Rollback()
	current, err := scanGeneration(tx.QueryRow(`SELECT `+genCols+` FROM generations WHERE gen = ?`, g.gen))
	if err != nil {
		return "the index has no record of its own generation"
	}
	if why := cheapCheck(tx, t, current); why != "" {
		return why
	}
	held := map[string]int64{}
	digest := ""
	var unreadable, tagFailures int64
	rows, err := tx.Query(`SELECT path, uid, content_ok, tag_error FROM ` + t.notes)
	if err != nil {
		return "the index notes cannot be read: " + err.Error()
	}
	for rows.Next() {
		var path, tagError string
		var uid int64
		var ok bool
		if err := rows.Scan(&path, &uid, &ok, &tagError); err != nil {
			rows.Close()
			return "the index notes cannot be read: " + err.Error()
		}
		held[path] = uid
		digest = xorDigest(digest, digestOf(path, uid))
		if !ok {
			unreadable++
		} else if tagError != "" {
			tagFailures++
		}
	}
	rows.Close()
	if !sameDigest(digest, current.digest) {
		return "the index notes do not add up to the digest it recorded"
	}
	if unreadable != current.unreadable || tagFailures != current.tagFailures {
		return "the index's counts of unreadable notes do not match its rows"
	}
	var orphans int64
	if err := tx.QueryRow(`SELECT COUNT(*) FROM ` + t.notes + ` n WHERE n.content_ok = 1
	  AND NOT EXISTS (SELECT 1 FROM ` + t.fts + ` f WHERE f.rowid = n.id)`).Scan(&orphans); err != nil {
		return "the index texts cannot be read: " + err.Error()
	}
	if orphans != 0 {
		return fmt.Sprintf("%d indexed notes have no text in the index", orphans)
	}
	if _, err := tx.Exec(`INSERT INTO ` + t.fts + ` (` + t.fts + `) VALUES ('integrity-check')`); err != nil {
		return "the full-text index fails its own integrity check: " + err.Error()
	}

	missing, extra, wrong := 0, 0, 0
	seen := 0
	err = x.st.EachAsOf(x.vault, current.through, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if !searchable(e) {
			return true, nil
		}
		seen++
		uid, ok := held[e.Path]
		switch {
		case !ok:
			missing++
		case uid != e.UID:
			wrong++
		}
		return true, nil
	})
	if err != nil {
		return "the store cannot be read to check the index: " + err.Error()
	}
	extra = len(held) - (seen - missing)
	if missing+extra+wrong > 0 {
		return fmt.Sprintf("the index disagrees with the store at uid %d: %d notes missing, %d it should not hold, %d at the wrong version",
			current.through, missing, extra, wrong)
	}
	return ""
}
