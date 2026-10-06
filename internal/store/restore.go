package store

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Restoring the vault to a uid (PLAN.md M5.5, decided 2026-09-22).
//
// A restore puts every path back as it stood at a uid, as one operation: a
// new version for each path whose head differs from its state then, a
// deletion for each path created since, and nothing for a path that already
// holds what it held. History is never rewritten or rewound. PKV Sync's
// force-moved branch broke per-file history and every device's checkpoint
// (plan/research/pkv-sync.md); here the restore is appended after everything
// it undoes, so every device reads it as ordinary new versions, and every head
// it displaces is pinned by the operation (section 4.5), so the restore is
// itself undoable, as any operation is (PlanUndo).
//
// It is the operator's, through `trewd restore -to-uid` on the control
// socket, and not an agent's: a whole-vault rewind is not a tool text in a
// note should be able to reach.
//
// What the vault held at a uid is read from the history the store still has,
// and a purge takes history. A path's state at N is exact when N is at or
// after the vault's purge mark, the newest uid the last purge that removed
// anything had reached (PurgedThrough), or when nothing was purged between
// the version it held at N and N itself: the uids are handed out without gaps
// (a transaction that rolls back gives its uid back), so a gap in that range
// is a version a purge took, and it may have been this path's. A path whose
// state cannot be read exactly refuses the whole restore as gone, naming it,
// rather than restore a guess (rule 2): the remedy is a backup taken before
// the purge.

// RestoreTool is what a restore to a uid is recorded as in the log.
const RestoreTool = "restore_to_uid"

// RestoreLabel is what a restore's versions are recorded as, which history
// panels, note_history and `trewd audit` show.
const RestoreLabel = "trewd restore"

// ErrNoSuchUID is a restore to a uid the vault has not reached.
var ErrNoSuchUID = errors.New("the vault has no such uid")

// RestoreRequest asks for the plan that puts the vault back as it was at ToUID.
type RestoreRequest struct {
	Vault string
	ToUID int64
	// Head, when not zero, is the vault head the restore was previewed at,
	// and the plan is refused as plan_changed if the vault has moved since:
	// what is applied is then exactly what the dry run showed.
	Head int64
	// Now is the server's clock in milliseconds, every new version's mtime.
	Now int64
}

// RestorePlan is the restore as an operation, and what it found.
type RestorePlan struct {
	ToUID int64
	// Head is the vault's latest uid the plan was made at. The operation
	// commits only if the vault is still there (SnapshotHead), because a
	// restore is a statement about the whole vault and any commit in between
	// makes it about a different one.
	Head    int64
	Entries []OpEntry
	Checks  []OpCheck
	// Steps say what each entry does, in UndoStep's vocabulary: restore (a
	// version put back, Before its uid at ToUID, After the head it replaces),
	// remove (a path created since), remove_folder, and keep_folder (a folder
	// created since that something restored lands in).
	Steps []UndoStep
	// Unchanged is how many paths changed since ToUID already hold what they
	// held then, and are left alone.
	Unchanged int
	// Gone is every path whose state at ToUID the store can no longer give
	// back exactly. Any refuses the restore.
	Gone []GonePath
}

// Operation is the plan as an operation. The caller adds the actor, the
// digest, the epoch and the rendering.
func (p RestorePlan) Operation() Operation {
	head := p.Head
	return Operation{Tool: RestoreTool, Entries: p.Entries, Checks: p.Checks, SnapshotHead: &head}
}

// restoreRow is one path as the planner reads it: its version at ToUID and
// its version now, either possibly absent.
type restoreRow struct {
	path       string
	then, now  Entry
	hadThen    bool // a version (live or a deletion) at ToUID
	hasNow     bool // a version (live or a deletion) now
	thenLive   bool
	nowLive    bool
	thenFolder bool
	nowFolder  bool
	// sameBytes is two files, then and now, of the same bytes.
	sameBytes bool
}

// PlanRestore prepares the restore of r.Vault to r.ToUID. It only reads, so it
// runs outside the write lock, and CommitOperation checks at the boundary that
// the vault is still at the head it read, and every base.
//
// Refusals are *OpError: not_found for a uid the vault has not reached,
// plan_changed for a preview whose head has moved, gone for a path whose state
// at the uid a purge has made unreadable or whose body is missing.
func (s *Store) PlanRestore(r RestoreRequest) (RestorePlan, error) {
	plan := RestorePlan{ToUID: r.ToUID}
	head, err := s.LatestUID(r.Vault)
	if err != nil {
		return plan, failed("", err)
	}
	plan.Head = head
	switch {
	case r.ToUID < 1 || r.ToUID > head:
		return plan, refused("", OpCodeNotFound, "", head, fmt.Errorf(
			"%w: uid %d, and the vault's uids run from 1 to %d", ErrNoSuchUID, r.ToUID, head))
	case r.Head != 0 && r.Head != head:
		return plan, refused("", OpCodePlanChanged, "", head, fmt.Errorf(
			"%w: previewed at uid %d, and the vault is at uid %d; preview it again", ErrPlanChanged, r.Head, head))
	}

	rows, err := s.restoreRows(r.Vault, r.ToUID)
	if err != nil {
		return plan, err
	}
	marked, err := s.PurgedThrough(r.Vault)
	if err != nil {
		return plan, failed("", err)
	}
	// Below the mark, the newest uid a purge took at or before ToUID, read
	// once for every path exactAt asks about.
	var gap int64
	if r.ToUID < marked {
		if gap, err = s.newestGap(r.Vault, r.ToUID); err != nil {
			return plan, failed("", err)
		}
	}

	// The paths that will be live once the restore is written, for whether a
	// folder created since can go.
	final := map[string]bool{}
	for _, row := range rows {
		if (row.nowLive && !row.changed()) || row.thenLive {
			final[row.path] = true
		}
	}

	var fileRemovals, folderRemovals, folderRestores, fileRestores []restoreRow
	for _, row := range rows {
		if !row.changed() && !row.unseenAt(r.ToUID, marked) {
			continue
		}
		// Before anything is decided from the state at ToUID, including that
		// the path already holds it: a guess that happens to match is still
		// a guess.
		if why := exactAt(row, r.ToUID, marked, gap); why != "" {
			g := GonePath{Path: row.path, Why: why}
			if row.hadThen {
				g.Before = row.then.UID
			}
			plan.Gone = append(plan.Gone, g)
			continue
		}
		if row.sameContent() {
			plan.Unchanged++
			continue
		}
		switch {
		case !row.thenLive && row.nowFolder:
			folderRemovals = append(folderRemovals, row)
		case !row.thenLive:
			fileRemovals = append(fileRemovals, row)
		case row.thenFolder:
			folderRestores = append(folderRestores, row)
		default:
			fileRestores = append(fileRestores, row)
		}
	}

	// The bodies of every version put back, before anything is planned from
	// them: a restore that wrote an entry whose body is gone would give back
	// an empty note under the right name.
	for i, row := range fileRestores {
		e, ok, err := s.EntryByUID(r.Vault, row.then.UID)
		if err != nil {
			return plan, failed("", err)
		}
		if !ok {
			plan.Gone = append(plan.Gone, GonePath{Path: row.path, Before: row.then.UID,
				Why: "the version is no longer in the store"})
			continue
		}
		for _, n := range e.Chunks {
			if _, ok := s.chunks.Size(r.Vault, n); !ok {
				plan.Gone = append(plan.Gone, GonePath{Path: row.path, Before: row.then.UID,
					Why: "a body of the version is missing from the chunk store; `trewd verify -deep` says more"})
				break
			}
		}
		fileRestores[i].then = e
	}
	if len(plan.Gone) > 0 {
		g := plan.Gone[0]
		return plan, refused("", OpCodeGone, g.Path, 0, fmt.Errorf(
			"%w: %s (%q at uid %d%s)", ErrBeforeImageGone, g.Why, g.Path, r.ToUID, andMore(len(plan.Gone))))
	}

	entry := func(path string) Entry {
		return Entry{Path: path, CTime: r.Now, MTime: r.Now, Device: RestoreLabel, Chunks: []string{}}
	}
	add := func(oe OpEntry, step UndoStep) {
		plan.Entries = append(plan.Entries, oe)
		plan.Steps = append(plan.Steps, step)
	}

	// In four passes, each one's entries written before the next's, so every
	// entry meets the state it needs: files created since, removed; folders
	// created since, removed deepest first when nothing restored lands in
	// them; folders put back, shallowest first; files put back.
	for _, row := range fileRemovals {
		e := entry(row.path)
		e.Deleted = true
		add(OpEntry{Entry: e, Base: row.now.UID}, UndoStep{Action: UndoRemove, Path: row.path, After: row.now.UID})
	}
	sort.SliceStable(folderRemovals, func(a, b int) bool {
		return depth(folderRemovals[a].path) > depth(folderRemovals[b].path)
	})
	for _, row := range folderRemovals {
		if n := liveUnder(final, row.path); n > 0 {
			plan.Steps = append(plan.Steps, UndoStep{Action: UndoKeepFolder, Path: row.path, After: row.now.UID,
				Why: fmt.Sprintf("%d paths the restore keeps or puts back are inside it", n)})
			plan.Checks = append(plan.Checks, OpCheck{Path: row.path, Base: row.now.UID})
			continue
		}
		e := entry(row.path)
		e.Deleted = true
		add(OpEntry{Entry: e, Base: row.now.UID, EmptyFolder: true},
			UndoStep{Action: UndoRemoveFolder, Path: row.path, After: row.now.UID})
	}
	sort.SliceStable(folderRestores, func(a, b int) bool {
		return depth(folderRestores[a].path) < depth(folderRestores[b].path)
	})
	for _, row := range folderRestores {
		e := entry(row.path)
		e.Folder, e.CTime = true, row.then.CTime
		add(OpEntry{Entry: e, Base: row.headNow()},
			UndoStep{Action: UndoRestore, Path: row.path, Before: row.then.UID, After: row.headNow()})
	}
	for _, row := range fileRestores {
		e := entry(row.path)
		e.CTime, e.Size = row.then.CTime, row.then.Size
		e.Chunks = append([]string{}, row.then.Chunks...)
		add(OpEntry{Entry: e, Base: row.headNow()},
			UndoStep{Action: UndoRestore, Path: row.path, Before: row.then.UID, After: row.headNow()})
	}
	if len(plan.Entries) > MaxOperationEntries {
		return plan, refused("", OpCodeResultTooLarge, "", 0, fmt.Errorf(
			"%w: the restore would write %d versions, and one operation writes at most %d",
			ErrResultTooLarge, len(plan.Entries), MaxOperationEntries))
	}
	return plan, nil
}

// changed is whether the path's version now is not the one it held at ToUID.
func (row restoreRow) changed() bool {
	switch {
	case row.hadThen != row.hasNow:
		// Moved away since, or created since.
		return row.thenLive || row.nowLive
	case !row.hadThen:
		return false
	}
	return row.then.UID != row.now.UID
}

// unseenAt is a path with no version at toUID that has one now, below the
// purge mark. Absent then and deleted now reads as unchanged, but the as-of
// listing at toUID is missing any path whose versions there a purge took, so
// below the mark it may have been live then: exactAt decides, and a path it
// cannot read exactly refuses the restore instead of being left out of it.
func (row restoreRow) unseenAt(toUID, marked int64) bool {
	return toUID < marked && !row.hadThen && row.hasNow
}

// sameContent is whether what the path holds now is what it held at ToUID,
// by another version: both absent or deleted, both a folder, or files of the
// same bytes (by chunk names, which are the bytes' hashes).
func (row restoreRow) sameContent() bool {
	switch {
	case !row.thenLive && !row.nowLive:
		return true
	case row.thenLive != row.nowLive, row.thenFolder != row.nowFolder:
		return false
	case row.thenFolder:
		return true
	}
	return row.sameBytes
}

// headNow is the path's head uid now, which a write's base names: its version
// now, or the rename that retired it.
func (row restoreRow) headNow() int64 { return row.now.UID }

// restoreRows reads every path whose version at toUID and version now are not
// both nothing, from two as-of listings merged by path.
func (s *Store) restoreRows(vault string, toUID int64) ([]restoreRow, error) {
	byPath := map[string]*restoreRow{}
	var order []string
	row := func(p string) *restoreRow {
		r, ok := byPath[p]
		if !ok {
			r = &restoreRow{path: p}
			byPath[p] = r
			order = append(order, p)
		}
		return r
	}
	if err := s.EachAsOf(vault, toUID, AsOfRange{}, func(e Entry) (bool, error) {
		r := row(e.Path)
		r.then, r.hadThen = e, true
		r.thenLive, r.thenFolder = !e.Deleted, !e.Deleted && e.Folder
		return true, nil
	}); err != nil {
		return nil, failed("", err)
	}
	if err := s.EachAsOf(vault, 0, AsOfRange{}, func(e Entry) (bool, error) {
		r := row(e.Path)
		r.now, r.hasNow = e, true
		r.nowLive, r.nowFolder = !e.Deleted, !e.Deleted && e.Folder
		return true, nil
	}); err != nil {
		return nil, failed("", err)
	}
	sort.Strings(order)
	out := make([]restoreRow, 0, len(order))
	for _, p := range order {
		r := *byPath[p]
		if r.hadThen && !r.hasNow {
			// Moved away since: its head is the rename that retired it.
			head, _, err := s.Head(vault, p)
			if err != nil {
				return nil, failed("", err)
			}
			r.now = Entry{UID: head, Path: p}
		}
		if !r.hadThen && r.hasNow {
			// Absent at toUID, or moved away by then: a version at or below
			// toUID, if any, is what exactAt measures from.
			e, state, movedAt, err := s.EntryAsOf(vault, p, toUID)
			if err != nil {
				return nil, failed("", err)
			}
			if state == PathMoved {
				r.then = Entry{UID: movedAt, Path: p}
			} else if state != PathAbsent {
				r.then = e
			}
		}
		if r.changed() && r.thenLive && r.nowLive && !r.thenFolder && !r.nowFolder {
			same, err := s.sameBytes(vault, r.then.UID, r.now.UID)
			if err != nil {
				return nil, err
			}
			r.sameBytes = same
		}
		out = append(out, r)
	}
	return out, nil
}

// sameBytes is whether two versions are files of the same bytes, compared by
// their chunk lists and sizes.
func (s *Store) sameBytes(vault string, a, b int64) (bool, error) {
	ea, okA, err := s.EntryByUID(vault, a)
	if err != nil {
		return false, failed("", err)
	}
	eb, okB, err := s.EntryByUID(vault, b)
	if err != nil {
		return false, failed("", err)
	}
	if !okA || !okB || ea.Size != eb.Size || len(ea.Chunks) != len(eb.Chunks) {
		return false, nil
	}
	for i := range ea.Chunks {
		if ea.Chunks[i] != eb.Chunks[i] {
			return false, nil
		}
	}
	return true, nil
}

// exactAt says why the path's state at toUID cannot be read exactly, or "".
//
// At or after the vault's purge mark (PurgedThrough) every path's state is
// exact: a purge keeps each path's head, and the version a path held at a uid
// the purge had already reached was either that head or came after it. Below
// the mark, a uid missing from the range between the version the path held
// then and toUID is a version a purge took, which may have been this path's.
//
// gap is the newest such uid at or below toUID (newestGap), so a missing uid
// lies in that range exactly when gap is above the version held then. It used
// to be found by counting the range's rows once per path, which made a
// restore below the mark quadratic: 45 s for 40,000 paths.
func exactAt(row restoreRow, toUID, marked, gap int64) string {
	from := row.then.UID
	if toUID >= marked || from >= gap {
		return ""
	}
	return fmt.Sprintf("a purge removed versions between uid %d and uid %d, the newest of them uid %d, so what "+
		"this path held at uid %d cannot be read exactly; restore a backup taken before the purge, or choose a "+
		"later uid", from, toUID, gap, toUID)
}

// newestGap is the newest uid from 1 to toUID the vault no longer holds, or
// zero when it holds every one of them: one descending read, which stops at the
// first uid missing. The uids are handed out without gaps (a transaction that
// rolls back gives its uid back), so a missing one is a version a purge took.
func (s *Store) newestGap(vault string, toUID int64) (int64, error) {
	rows, err := s.db.Query(`SELECT uid FROM entries WHERE vault_id = ? AND uid <= ? ORDER BY uid DESC`,
		vault, toUID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	want := toUID
	for rows.Next() {
		var uid int64
		if err := rows.Scan(&uid); err != nil {
			return 0, err
		}
		if uid != want {
			return want, nil
		}
		want--
	}
	return want, rows.Err()
}

// liveUnder is how many of the paths in final are inside folder.
func liveUnder(final map[string]bool, folder string) int {
	n := 0
	for p := range final {
		if strings.HasPrefix(p, folder+"/") {
			n++
		}
	}
	return n
}

// purgeMarksSchema is the purge mark: per vault, the newest uid of the vault
// when a purge last removed history from it. A table of its own rather than a
// column on vaults, so a store upgraded to schema 4 has exactly the tables a
// new one has.
const purgeMarksSchema = `
CREATE TABLE IF NOT EXISTS purge_marks (
  vault_id       TEXT    PRIMARY KEY,
  purged_through INTEGER NOT NULL
);
`

// addPurgeMarks is schema 3 to 4. A vault some purge has already removed
// history from is marked at its newest uid: how far those purges reached was
// never recorded, and the newest uid is the one mark that cannot be too low.
func addPurgeMarks(q execer) error {
	if _, err := q.Exec(purgeMarksSchema); err != nil {
		return err
	}
	_, err := q.Exec(`INSERT INTO purge_marks (vault_id, purged_through)
	  SELECT v.vault_id, COALESCE((SELECT MAX(uid) FROM entries e WHERE e.vault_id = v.vault_id), 0)
	    FROM vaults v WHERE v.purges > 0`)
	return err
}

// markPurged moves the vault's purge mark to its newest uid, inside the purge
// transaction that removed history.
func markPurged(q execer, vaultID string) error {
	_, err := q.Exec(`INSERT INTO purge_marks (vault_id, purged_through)
	  VALUES (?, COALESCE((SELECT MAX(uid) FROM entries WHERE vault_id = ?), 0))
	  ON CONFLICT(vault_id) DO UPDATE SET purged_through = MAX(purged_through, excluded.purged_through)`,
		vaultID, vaultID)
	return err
}

// PurgedThrough is the vault's purge mark: the newest uid the vault held when
// a purge last removed history from it, or zero when none has. Every path's
// state at a uid at or after it is exactly what the store holds.
func (s *Store) PurgedThrough(vaultID string) (int64, error) {
	var n int64
	err := s.db.QueryRow(`SELECT COALESCE((SELECT purged_through FROM purge_marks WHERE vault_id = ?), 0)`,
		vaultID).Scan(&n)
	return n, err
}
