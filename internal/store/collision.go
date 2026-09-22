package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/waynehoover/telimus/internal/paths"
)

// ErrCollision is a create, or the destination of a move, that would leave two
// live paths a case-folding disk holds as one file or one folder (PLAN.md
// section 4.1, plan/protocol.md "Paths"), answered `collision`. It rejects the
// entry; a batch commits the rest.
var ErrCollision = errors.New("collision")

// liveSchema is the live set, kept beside the entries so the collision rule can
// be answered with a few indexed reads rather than a scan of history.
//
// # Why derived tables, and what keeps them true
//
// The rule is about live paths: those whose newest version is not a deletion
// and that no later rename retired, which is pathHead's definition. Asking
// that of the entries directly is a query per candidate path over every
// version it ever had, and the rule has to ask it for every directory prefix
// of every entry of a 256-entry batch, inside the commit lock. So the answer
// is kept instead, in two tables:
//
//   - live_paths: one row per live path, with its folded key and whether it is
//     a folder entry.
//   - live_dirs: one row per directory spelling the live set implies, with a
//     count of the live paths that imply it (every path beneath it, and a
//     folder entry at it). A spelling is a directory while its count is
//     positive; the row goes when it reaches zero.
//
// They are written in the same transaction as the entry that changes them,
// by writeEntry and nowhere else, so they cannot be ahead of or behind the
// entries: a refused entry's savepoint rolls its table changes back with it,
// and a batch's later entries see what its earlier ones left, which is the
// order the protocol specifies.
//
// What it costs, measured on the author's laptop without an fsync: a batch of
// 256 new notes three folders deep commits in 34 ms with the rule and its
// tables, against 13 ms without them, which is SQLite statement overhead, about
// six statements more per entry. BenchmarkABatchOfNewNotes measures it.
//
// Purge never changes the live set, because it
// keeps every head and every rename that retires a path. `verify` recomputes
// both tables from the entries and reports any difference as a `livekeys`
// fault, and TestTheLiveSetIsExactlyWhatTheEntriesSay rebuilds them from
// scratch against a history of every kind of write.
const liveSchema = `
CREATE TABLE IF NOT EXISTS live_paths (
  vault_id TEXT    NOT NULL,
  path     TEXT    NOT NULL,
  fold     TEXT    NOT NULL,
  folder   INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);
CREATE INDEX IF NOT EXISTS live_paths_by_fold ON live_paths(vault_id, fold);

CREATE TABLE IF NOT EXISTS live_dirs (
  vault_id TEXT    NOT NULL,
  path     TEXT    NOT NULL,
  fold     TEXT    NOT NULL,
  refs     INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);
CREATE INDEX IF NOT EXISTS live_dirs_by_fold ON live_dirs(vault_id, fold);
`

// liveRow is a path's place in the live set: whether it is there, and whether
// as a folder entry.
type liveRow struct {
	live, folder bool
}

// liveState reads one path's row of the live set.
func liveState(q querier, vaultID, path string) (liveRow, error) {
	var folder int
	err := q.QueryRow(`SELECT folder FROM live_paths WHERE vault_id = ? AND path = ?`,
		vaultID, path).Scan(&folder)
	if errNoRow(err) {
		return liveRow{}, nil
	}
	if err != nil {
		return liveRow{}, err
	}
	return liveRow{live: true, folder: folder != 0}, nil
}

// dirsOf is every directory a live path implies, with how many times: each of
// its proper prefixes once, and the path itself once more when it is a folder
// entry.
func dirsOf(path string, folder bool, into map[string]int) {
	for i := 0; i < len(path); i++ {
		if path[i] == '/' {
			into[path[:i]]++
		}
	}
	if folder {
		into[path]++
	}
}

// checkCollision applies the collision rule of plan/protocol.md, "Paths", to
// one entry, against the live set as it stands in the caller's transaction.
//
// The six rules, numbered as there. Deletions never collide, so they are not
// asked. A move whose source and destination fold alike is a case-only
// rename and always allowed (1); a create of a path that is already live,
// spelled the same, is an update (2). Otherwise the destination is compared
// with every other live path: the destination and a move's source are left
// out of "every other", exactly as internal/paths.Collides, the quadratic
// reference this is tested against, leaves them out.
func checkCollision(q querier, vaultID string, e Entry) error {
	if e.Deleted {
		return nil
	}
	move := e.Prev != ""
	if move && paths.Fold(e.Prev) == paths.Fold(e.Path) {
		return nil // rule 1
	}
	dest, err := liveState(q, vaultID, e.Path)
	if err != nil {
		return err
	}
	if !move && dest.live {
		return nil // rule 2
	}

	// What the destination and a move's source contribute to the directory
	// counts, subtracted before a spelling is judged live: the rule compares
	// the new path with the other live paths, and a count they alone hold up
	// is not one another path holds.
	excluded := map[string]int{}
	if dest.live {
		dirsOf(e.Path, dest.folder, excluded)
	}
	if move {
		src, err := liveState(q, vaultID, e.Prev)
		if err != nil {
			return err
		}
		if src.live {
			dirsOf(e.Prev, src.folder, excluded)
		}
	}
	other := func(p string) bool { return p != e.Path && !(move && p == e.Prev) }

	// Every key the rule asks about, read in one query per table rather than
	// two per segment: the new path's own, and each of its folders'. The rule
	// runs for every entry of a batch inside the write lock, and at depth
	// three this is four statements where it was eleven.
	key := paths.Fold(e.Path)
	var dirs, dirKeys []string
	for i := 0; i < len(e.Path); i++ {
		if e.Path[i] == '/' {
			dirs = append(dirs, e.Path[:i])
			dirKeys = append(dirKeys, paths.Fold(e.Path[:i]))
		}
	}
	keys := append([]string{key}, dirKeys...)
	byKey, err := livePathsWithFolds(q, vaultID, keys)
	if err != nil {
		return err
	}
	spelled, err := liveDirSpellings(q, vaultID, keys, excluded)
	if err != nil {
		return err
	}

	// Rule 3: another live path, file or folder entry, with the same key.
	for _, p := range byKey[key] {
		if other(p.path) {
			return collision(e, "it folds like the live %s %q", kindName(p.folder), p.path)
		}
	}
	// Rules 4 and 5, for every folder the new path needs.
	for k, dir := range dirs {
		for _, f := range byKey[dirKeys[k]] {
			if !f.folder && other(f.path) {
				return collision(e, "it needs a folder %q where the live file %q is", dir, f.path)
			}
		}
		if s := spelled[dirKeys[k]]; len(s) > 0 && !s[dir] {
			return collision(e, "its folder %q folds like the live folder %q", dir, anyKey(s))
		}
	}
	// Rule 6: the new path's own key against the live folders.
	if s := spelled[key]; len(s) > 0 && (!e.Folder || !s[e.Path]) {
		if e.Folder {
			return collision(e, "it folds like the live folder %q", anyKey(s))
		}
		return collision(e, "a live folder %q is where this file would be", anyKey(s))
	}
	return nil
}

// Collides reports whether an entry would collide with the live set as it
// stands now, as ErrCollision, and changes nothing.
//
// A hint for the session, which asks it before any body is uploaded so a
// write that cannot be committed is refused before its bytes cross the wire.
// It is not the check: the live set can change while the bodies arrive, and
// the commit asks again under the write lock, which is the answer that
// stands.
func (s *Store) Collides(vaultID string, e Entry) error {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	return checkCollision(tx, vaultID, e)
}

// collision builds the refusal: which path, and why a case-folding disk would
// hold it and another as one.
func collision(e Entry, format string, args ...any) error {
	return fmt.Errorf("%w: %q cannot be created, because %s", ErrCollision, e.Path, fmt.Sprintf(format, args...))
}

func kindName(folder bool) string {
	if folder {
		return "folder"
	}
	return "file"
}

// anyKey is the smallest key of a set, so a message names one spelling and
// the same one every time.
func anyKey(set map[string]bool) string {
	best := ""
	for k := range set {
		if best == "" || k < best {
			best = k
		}
	}
	return best
}

// livePath is one row of live_paths, as the rule reads it.
type livePath struct {
	path   string
	folder bool
}

// placeholders is n comma-separated question marks, for an IN list.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// livePathsWithFolds is every live path whose folded key is one of keys,
// grouped by key.
func livePathsWithFolds(q querier, vaultID string, keys []string) (map[string][]livePath, error) {
	args := []any{vaultID}
	for _, k := range keys {
		args = append(args, k)
	}
	rows, err := q.Query(`SELECT fold, path, folder FROM live_paths
	                       WHERE vault_id = ? AND fold IN (`+placeholders(len(keys))+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]livePath{}
	for rows.Next() {
		var fold string
		var p livePath
		var folder int
		if err := rows.Scan(&fold, &p.path, &folder); err != nil {
			return nil, err
		}
		p.folder = folder != 0
		out[fold] = append(out[fold], p)
	}
	return out, rows.Err()
}

// liveDirSpellings is every spelling of a live folder whose folded key is one
// of keys, grouped by key, not counting what excluded holds up.
func liveDirSpellings(q querier, vaultID string, keys []string, excluded map[string]int) (map[string]map[string]bool, error) {
	args := []any{vaultID}
	for _, k := range keys {
		args = append(args, k)
	}
	rows, err := q.Query(`SELECT fold, path, refs FROM live_dirs
	                       WHERE vault_id = ? AND fold IN (`+placeholders(len(keys))+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]bool{}
	for rows.Next() {
		var fold, p string
		var refs int
		if err := rows.Scan(&fold, &p, &refs); err != nil {
			return nil, err
		}
		if refs-excluded[p] > 0 {
			if out[fold] == nil {
				out[fold] = map[string]bool{}
			}
			out[fold][p] = true
		}
	}
	return out, rows.Err()
}

// applyLive moves the live set on by one committed entry, in the caller's
// transaction: a rename retires its source, and then the destination is
// live, as a file or a folder, or not live, if the entry is a deletion. This
// is pathHead's definition, applied one write at a time.
func applyLive(q execer, vaultID string, e Entry) error {
	if e.Prev != "" {
		if err := leaveLive(q, vaultID, e.Prev); err != nil {
			return err
		}
	}
	if e.Deleted {
		return leaveLive(q, vaultID, e.Path)
	}
	was, err := liveState(q, vaultID, e.Path)
	if err != nil {
		return err
	}
	switch {
	case !was.live:
		if _, err := q.Exec(`INSERT INTO live_paths (vault_id, path, fold, folder) VALUES (?, ?, ?, ?)`,
			vaultID, e.Path, paths.Fold(e.Path), boolToInt(e.Folder)); err != nil {
			return err
		}
		counts := map[string]int{}
		dirsOf(e.Path, e.Folder, counts)
		return addDirs(q, vaultID, counts, +1)
	case was.folder != e.Folder:
		// The same path, now the other kind: only its own directory count
		// changes, because its prefixes are held up either way.
		if _, err := q.Exec(`UPDATE live_paths SET folder = ? WHERE vault_id = ? AND path = ?`,
			boolToInt(e.Folder), vaultID, e.Path); err != nil {
			return err
		}
		delta := +1
		if !e.Folder {
			delta = -1
		}
		return addDirs(q, vaultID, map[string]int{e.Path: 1}, delta)
	}
	return nil
}

// leaveLive takes a path out of the live set, if it is there.
func leaveLive(q execer, vaultID, path string) error {
	was, err := liveState(q, vaultID, path)
	if err != nil || !was.live {
		return err
	}
	if _, err := q.Exec(`DELETE FROM live_paths WHERE vault_id = ? AND path = ?`, vaultID, path); err != nil {
		return err
	}
	counts := map[string]int{}
	dirsOf(path, was.folder, counts)
	return addDirs(q, vaultID, counts, -1)
}

// errLiveDrift is the live set disagreeing with the entries, found while
// moving it on: a directory being taken away that was never counted.
var errLiveDrift = errors.New("the live set disagrees with the entries")

// addDirs moves each directory spelling's count one step, up (sign +1) or
// down (sign -1), creating a spelling at its first reference and removing it
// at its last. Each is one step, because one path holds each spelling at most
// once, and the whole set is two or three statements whatever its size.
// Taking away a count that is not there is errLiveDrift.
func addDirs(q execer, vaultID string, counts map[string]int, sign int) error {
	if len(counts) == 0 {
		return nil
	}
	dirs := make([]string, 0, len(counts))
	for d, n := range counts {
		if n != 1 {
			return fmt.Errorf("%w: folder %q moved by %d in one write", errLiveDrift, d, n)
		}
		dirs = append(dirs, d)
	}
	if sign > 0 {
		args := make([]any, 0, 3*len(dirs))
		for _, d := range dirs {
			args = append(args, vaultID, d, paths.Fold(d))
		}
		_, err := q.Exec(`INSERT INTO live_dirs (vault_id, path, fold, refs) VALUES `+
			strings.TrimSuffix(strings.Repeat("(?, ?, ?, 1),", len(dirs)), ",")+`
			ON CONFLICT(vault_id, path) DO UPDATE SET refs = refs + 1`, args...)
		return err
	}
	args := []any{vaultID}
	for _, d := range dirs {
		args = append(args, d)
	}
	in := placeholders(len(dirs))
	res, err := q.Exec(`UPDATE live_dirs SET refs = refs - 1 WHERE vault_id = ? AND path IN (`+in+`)`, args...)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != int64(len(dirs)) {
		return fmt.Errorf("%w: %d of %d folders a path left were counted", errLiveDrift, n, len(dirs))
	}
	var negative int
	if err := q.QueryRow(`SELECT COUNT(*) FROM live_dirs WHERE vault_id = ? AND refs < 0 AND path IN (`+in+`)`,
		args...).Scan(&negative); err != nil {
		return err
	}
	if negative > 0 {
		return fmt.Errorf("%w: a folder was counted fewer times than paths left it", errLiveDrift)
	}
	_, err = q.Exec(`DELETE FROM live_dirs WHERE vault_id = ? AND refs = 0 AND path IN (`+in+`)`, args...)
	return err
}

// rebuildLive replaces a vault's live set with the one its entries say, in the
// caller's transaction.
//
// The entries are the truth and the tables are derived from them, so when the
// two are found to disagree the tables are rebuilt rather than trusted, and
// rather than refused: a refusal would turn every later write touching those
// paths into a retryable `internal` that a device retries for ever, which
// loses nothing and syncs nothing either. `verify` reports any disagreement it
// finds, so drift that heals here is still drift somebody can see if it
// recurs.
func rebuildLive(q execer, vaultID string) error {
	if _, err := q.Exec(`DELETE FROM live_paths WHERE vault_id = ?`, vaultID); err != nil {
		return err
	}
	if _, err := q.Exec(`DELETE FROM live_dirs WHERE vault_id = ?`, vaultID); err != nil {
		return err
	}
	live, dirs, err := liveFromEntries(q, vaultID)
	if err != nil {
		return err
	}
	for p, folder := range live {
		if _, err := q.Exec(`INSERT INTO live_paths (vault_id, path, fold, folder) VALUES (?, ?, ?, ?)`,
			vaultID, p, paths.Fold(p), boolToInt(folder)); err != nil {
			return err
		}
	}
	for d, n := range dirs {
		if _, err := q.Exec(`INSERT INTO live_dirs (vault_id, path, fold, refs) VALUES (?, ?, ?, ?)`,
			vaultID, d, paths.Fold(d), n); err != nil {
			return err
		}
	}
	return nil
}

// RepairLive compares each vault's live set with its entries and rebuilds the
// ones that disagree, reporting which vaults it rebuilt and why.
//
// `serve` runs it at startup, so an operator who sees a `livekeys` fault in
// verify has a remedy that needs no tool: restart the server. The comparison
// is one grouped read of each vault's heads, the same shape of query `stats`
// makes, and it takes the write lock only for a vault that needs rebuilding.
func (s *Store) RepairLive() (map[string]string, error) {
	vaults, err := s.Vaults()
	if err != nil {
		return nil, err
	}
	repaired := map[string]string{}
	for _, v := range vaults {
		diff, err := liveDifference(s.db, v)
		if err != nil {
			return repaired, err
		}
		if diff == "" {
			continue
		}
		s.writeMu.Lock()
		err = immediate(s.db, func(q execer) error { return rebuildLive(q, v) })
		s.writeMu.Unlock()
		if err != nil {
			return repaired, fmt.Errorf("rebuilding the live set of vault %q: %w", v, err)
		}
		repaired[v] = diff
	}
	return repaired, nil
}

// moveLive is applyLive with drift healed: the entry is already written, so a
// rebuild from the entries is the live set after it, exactly.
func moveLive(q execer, vaultID string, e Entry) error {
	err := applyLive(q, vaultID, e)
	if errors.Is(err, errLiveDrift) {
		return rebuildLive(q, vaultID)
	}
	return err
}

// errNoRow reports whether err is sql.ErrNoRows.
func errNoRow(err error) bool { return errors.Is(err, sql.ErrNoRows) }

// liveFromEntries is the live set recomputed from the entries alone, for
// verify and the tests: every path whose head is not a deletion and that no
// later rename retired, and the directory counts it implies.
func liveFromEntries(q querier, vaultID string) (map[string]bool, map[string]int, error) {
	rows, err := q.Query(
		`SELECT e.path, e.folder FROM entries e
		   JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) h
		     ON h.path = e.path AND h.uid = e.uid
		  WHERE e.vault_id = ? AND e.deleted = 0 AND `+notRetiredByRename, vaultID, vaultID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	live := map[string]bool{}
	dirs := map[string]int{}
	for rows.Next() {
		var p string
		var folder int
		if err := rows.Scan(&p, &folder); err != nil {
			return nil, nil, err
		}
		live[p] = folder != 0
		dirsOf(p, folder != 0, dirs)
	}
	return live, dirs, rows.Err()
}

// liveFromTables is the live set as the two tables hold it.
func liveFromTables(q querier, vaultID string) (map[string]bool, map[string]int, error) {
	live := map[string]bool{}
	rows, err := q.Query(`SELECT path, folder, fold FROM live_paths WHERE vault_id = ?`, vaultID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var p, fold string
		var folder int
		if err := rows.Scan(&p, &folder, &fold); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if fold != paths.Fold(p) {
			rows.Close()
			return nil, nil, fmt.Errorf("live path %q is filed under the key %q, and folds to %q", p, fold, paths.Fold(p))
		}
		live[p] = folder != 0
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	dirs := map[string]int{}
	rows, err = q.Query(`SELECT path, refs, fold FROM live_dirs WHERE vault_id = ?`, vaultID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p, fold string
		var refs int
		if err := rows.Scan(&p, &refs, &fold); err != nil {
			return nil, nil, err
		}
		if fold != paths.Fold(p) {
			return nil, nil, fmt.Errorf("live folder %q is filed under the key %q, and folds to %q", p, fold, paths.Fold(p))
		}
		dirs[p] = refs
	}
	return live, dirs, rows.Err()
}

// liveDifference describes how the tables differ from the entries, or "" when
// they agree, naming at most a few paths so a fault stays readable.
func liveDifference(q querier, vaultID string) (string, error) {
	wantLive, wantDirs, err := liveFromEntries(q, vaultID)
	if err != nil {
		return "", err
	}
	gotLive, gotDirs, err := liveFromTables(q, vaultID)
	if err != nil {
		return err.Error(), nil
	}
	var diffs []string
	note := func(format string, args ...any) {
		if len(diffs) < 5 {
			diffs = append(diffs, fmt.Sprintf(format, args...))
		}
	}
	for p, folder := range wantLive {
		if got, ok := gotLive[p]; !ok {
			note("%q is live and not in the live set", p)
		} else if got != folder {
			note("%q is filed as the wrong kind", p)
		}
	}
	for p := range gotLive {
		if _, ok := wantLive[p]; !ok {
			note("%q is in the live set and not live", p)
		}
	}
	for d, n := range wantDirs {
		if gotDirs[d] != n {
			note("folder %q is counted %d times and %d paths hold it", d, gotDirs[d], n)
		}
	}
	for d, n := range gotDirs {
		if _, ok := wantDirs[d]; !ok {
			note("folder %q is counted %d times and no live path holds it", d, n)
		}
	}
	return strings.Join(diffs, "; "), nil
}
