package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Reading the vault as it stood at a uid.
//
// The MCP listing and search pin a head so that a page and the next one are
// read from the same world: a commit landing between them can neither skip a
// row nor show one twice (plan/mcp-tools.md, list_notes). A version at or
// below the head never changes, because entries are append-only and purge
// cannot run beside a server (it takes the data lock exclusively), so an
// as-of read needs no transaction to be consistent with the one before it.
//
// The state of a path at head H is its newest version with uid <= H, unless a
// rename with uid in (that version, H] took it away (M4 task 7). The second
// half is what the plain "latest row at or below the head" predicate misses:
// with A.md at uid 1 renamed to B.md at uid 2, it leaves A.md visible at head
// 2 beside B.md, which is a ghost row. notRetiredByRename is the same rule
// without the cap, for the current state.

// PathState is what a path holds at a head.
type PathState int

// The states a path can be in.
const (
	// PathAbsent is a path with no version at or below the head.
	PathAbsent PathState = iota
	// PathLive is a path whose version at the head is a file or a folder.
	PathLive
	// PathDeleted is a path whose version at the head is a deletion.
	PathDeleted
	// PathMoved is a path a rename took away at or below the head.
	PathMoved
)

// asOfCols names an entry's columns as an as-of query reads them, from the
// entries table aliased e, in scanEntry's order.
const asOfCols = `e.uid, e.path, e.size, e.ctime, e.mtime, e.folder, e.deleted, e.device, e.prev_path, e.n_chunks`

// EntryAsOf is one path at head: the version it holds and its state. head 0
// or less means the latest uid, which is the current state. For a live file
// the entry carries its chunk list; for a moved path the entry is the version
// the rename took away and movedAt is the rename's uid.
func (s *Store) EntryAsOf(vaultID, path string, head int64) (e Entry, state PathState, movedAt int64, err error) {
	if head <= 0 {
		head = maxSafeUID
	}
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Entry{}, PathAbsent, 0, err
	}
	defer tx.Rollback()

	e, err = scanEntry(tx.QueryRow(`SELECT `+asOfCols+` FROM entries e
	  WHERE e.vault_id = ? AND e.path = ? AND e.uid <= ? ORDER BY e.uid DESC LIMIT 1`, vaultID, path, head))
	if errors.Is(err, sql.ErrNoRows) {
		return Entry{}, PathAbsent, 0, nil
	}
	if err != nil {
		return Entry{}, PathAbsent, 0, err
	}
	var moved sql.NullInt64
	if err := tx.QueryRow(`SELECT MIN(uid) FROM entries
	  WHERE vault_id = ? AND prev_path = ? AND uid > ? AND uid <= ?`, vaultID, path, e.UID, head).Scan(&moved); err != nil {
		return Entry{}, PathAbsent, 0, err
	}
	one := []Entry{e}
	if err := attachChunks(tx, vaultID, one); err != nil {
		return Entry{}, PathAbsent, 0, err
	}
	e = one[0]
	switch {
	case moved.Valid:
		return e, PathMoved, moved.Int64, nil
	case e.Deleted:
		return e, PathDeleted, 0, nil
	}
	return e, PathLive, 0, nil
}

// maxSafeUID is the largest uid the protocol allows, which stands for "no
// cap" in an as-of read.
const maxSafeUID = 1<<53 - 1

// AsOfRange bounds an as-of listing to a range of paths, in the byte order
// SQLite's BINARY collation compares them in.
type AsOfRange struct {
	// After, when not empty, starts the listing at the first path greater
	// than it: a page's continuation.
	After string
	// From, when not empty, starts it at the first path at or after it: a
	// continuation that resumes inside the path it stopped at.
	From string
	// Folder, when not empty, keeps only paths beneath it, at any depth, and
	// not the folder's own entry: the paths beginning "Folder/".
	Folder string
}

// EachAsOf calls fn with every path's version at head, in path order, for
// every path in r that is not absent and was not moved away at the head:
// live files and folders, and deletions, which the caller keeps or skips.
// head 0 or less means the latest uid. fn returns false to stop.
//
// It streams: the query walks the path index in order and fn sees each path
// as it is found, so a page that fills after a hundred rows reads about a
// hundred paths, not the vault. Chunk lists are not attached; EntryAsOf or
// EntryByUID reads them for a path the caller goes on to read.
func (s *Store) EachAsOf(vaultID string, head int64, r AsOfRange, fn func(Entry) (bool, error)) error {
	if head <= 0 {
		head = maxSafeUID
	}
	lo, hi := "", ""
	if r.Folder != "" {
		// Every path beginning "Folder/" sorts at or after "Folder/" and
		// before "Folder0", because '0' is the byte after '/'.
		lo, hi = r.Folder+"/", r.Folder+"0"
	}
	q := `SELECT ` + asOfCols + ` FROM entries e
	  WHERE e.vault_id = ?1
	    AND e.path > ?3
	    AND e.path >= ?6
	    AND (?4 = '' OR (e.path >= ?4 AND e.path < ?5))
	    AND e.uid = (SELECT MAX(x.uid) FROM entries x
	                  WHERE x.vault_id = ?1 AND x.path = e.path AND x.uid <= ?2)
	    AND NOT EXISTS (SELECT 1 FROM entries moved
	                     WHERE moved.vault_id = ?1 AND moved.prev_path = e.path
	                       AND moved.uid > e.uid AND moved.uid <= ?2)
	  ORDER BY e.path`
	rows, err := s.db.Query(q, vaultID, head, r.After, lo, hi, r.From)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return err
		}
		e.Chunks = []string{}
		more, err := fn(e)
		if err != nil || !more {
			return err
		}
	}
	return rows.Err()
}

// PurgeGeneration is how many purges have dropped history from a vault: the
// counter a cursor into its history binds to, because a purge can remove a
// version that was a path's state at a pinned head and a listing resumed
// across it would silently be of a different world. Zero for a vault that has
// never been purged, or that does not exist.
func (s *Store) PurgeGeneration(vaultID string) (int64, error) {
	var n sql.NullInt64
	err := s.db.QueryRow(`SELECT purges FROM vaults WHERE vault_id = ?`, vaultID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n.Int64, err
}

// Committed is how a reader that keeps a view derived from the entries, the
// search index, learns that there is more to read, without the commit waiting
// for it: each commit that appends entries sends one value on every channel
// Subscribe handed out, and a channel whose value is still unread is skipped
// rather than waited on. A reader is told "something changed", never what,
// and a restart loses the nudges, so the entries table and the reader's own
// durable position are the truth and this only saves it polling.
type Committed struct {
	C      <-chan struct{}
	cancel func()
}

// Stop ends the subscription.
func (c Committed) Stop() { c.cancel() }

// Subscribe starts a subscription to commits.
func (s *Store) Subscribe() Committed {
	ch := make(chan struct{}, 1)
	s.subMu.Lock()
	if s.subs == nil {
		s.subs = map[chan struct{}]struct{}{}
	}
	s.subs[ch] = struct{}{}
	s.subMu.Unlock()
	return Committed{C: ch, cancel: func() {
		s.subMu.Lock()
		delete(s.subs, ch)
		s.subMu.Unlock()
	}}
}

// notifyCommitted tells every subscriber that entries were committed. It
// never blocks: a subscriber that has not read the last nudge already knows.
func (s *Store) notifyCommitted() {
	s.subMu.Lock()
	defer s.subMu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// String is the state as a word, for errors and tests.
func (p PathState) String() string {
	switch p {
	case PathAbsent:
		return "absent"
	case PathLive:
		return "live"
	case PathDeleted:
		return "deleted"
	case PathMoved:
		return "moved"
	}
	return fmt.Sprintf("PathState(%d)", int(p))
}
