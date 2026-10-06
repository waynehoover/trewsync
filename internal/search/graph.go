package search

import (
	"context"
	"database/sql"
)

// LinkGraph is the whole link index: every note's version and link keys, for
// the vault-health tools that ask about many targets at once (broken_links,
// orphans), where Backlinks answers for one. The rules are Backlinks's: it
// narrows only when Usable, which it is only when the generation queries use
// is trusted, of this version, and agreed with its counters in the one read
// that takes the keys; it answers for each note only in the version it holds,
// whatever head a page reads (T51); and it only rules notes out, so a note it
// knows nothing about, or holds at another version, or could not read the
// links of, is always read.
type LinkGraph struct {
	Generation  int64
	IndexedHead int64
	Usable      bool
	Why         string
	notes       map[string]graphNote
	byKey       map[string][]string
}

type graphNote struct {
	uid  int64
	ok   bool
	keys []string
}

// Proven reports whether the graph can speak for the note at path in version
// uid: it is usable, holds that very version, and read its links.
func (g LinkGraph) Proven(path string, uid int64) bool {
	if !g.Usable {
		return false
	}
	n, ok := g.notes[path]
	return ok && n.uid == uid && n.ok
}

// HasLinks reports whether the note at path, in version uid, may hold a link
// at all: always, unless the graph can speak for it and it holds no key.
func (g LinkGraph) HasLinks(path string, uid int64) bool {
	return !g.Proven(path, uid) || len(g.notes[path].keys) > 0
}

// MayLinkTo reports whether the note at path, in version uid, may hold a link
// that resolves to a note with these keys (notes.TargetKeys): always, unless
// the graph can speak for it and it shares none of them.
func (g LinkGraph) MayLinkTo(path string, uid int64, keys []string) bool {
	if !g.Proven(path, uid) {
		return true
	}
	for _, have := range g.notes[path].keys {
		for _, k := range keys {
			if have == k {
				return true
			}
		}
	}
	return false
}

// Sharing is every note the graph holds that has one of keys, for a caller
// that then adds the notes the graph cannot speak for. A path here may be one
// the caller's head does not hold, or holds at another version: the caller
// keeps only those it can prove (Proven).
func (g LinkGraph) Sharing(keys []string) map[string]bool {
	out := map[string]bool{}
	for _, k := range keys {
		for _, p := range g.byKey[k] {
			out[p] = true
		}
	}
	return out
}

// LinkGraph reads the whole link index, for a read of the vault at any head.
func (x *Index) LinkGraph(ctx context.Context) (LinkGraph, error) {
	var g LinkGraph
	x.mu.Lock()
	var active *generation
	if x.active != nil {
		copied := *x.active
		active = &copied
	}
	distrust := x.distrust
	x.mu.Unlock()
	switch {
	case active == nil:
		g.Why = "the index has not been built yet"
		return g, nil
	case distrust != "":
		g.Why = distrust
		return g, nil
	case active.version != IndexVersion:
		g.Why = "the index is of another version"
		return g, nil
	}
	tx, err := x.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return g, err
	}
	defer tx.Rollback()
	now, err := scanGeneration(tx.QueryRow(`SELECT `+genCols+` FROM generations WHERE gen = ?`, active.gen))
	if err != nil {
		g.Why = "the index generation changed while it was being read"
		return g, nil
	}
	g.Generation, g.IndexedHead = now.gen, now.through
	t := tablesOf(now.gen)
	if why := cheapCheck(tx, t, now); why != "" {
		x.distrusted(why)
		g.Why = why
		return g, nil
	}
	g.notes = map[string]graphNote{}
	ids := map[int64]string{}
	rows, err := tx.Query(`SELECT id, path, uid, content_ok, link_error FROM ` + t.notes)
	if err != nil {
		return g, err
	}
	for rows.Next() {
		var id int64
		var path, linkError string
		var n graphNote
		var contentOK bool
		if err := rows.Scan(&id, &path, &n.uid, &contentOK, &linkError); err != nil {
			rows.Close()
			return g, err
		}
		n.ok = contentOK && linkError == ""
		g.notes[path] = n
		ids[id] = path
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return g, err
	}
	g.byKey = map[string][]string{}
	rows, err = tx.Query(`SELECT note_id, key FROM ` + t.links)
	if err != nil {
		return g, err
	}
	for rows.Next() {
		var id int64
		var key string
		if err := rows.Scan(&id, &key); err != nil {
			rows.Close()
			return g, err
		}
		path, ok := ids[id]
		if !ok {
			continue
		}
		n := g.notes[path]
		n.keys = append(n.keys, key)
		g.notes[path] = n
		g.byKey[key] = append(g.byKey[key], path)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return g, err
	}
	if err := ctx.Err(); err != nil {
		return g, err
	}
	g.Usable = true
	return g, nil
}
