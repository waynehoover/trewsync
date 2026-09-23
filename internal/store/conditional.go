package store

import (
	"database/sql"
	"errors"
	"fmt"
)

type headReader interface{ QueryRow(string, ...any) *sql.Row }

// Queries whose current entry is aliased as e must also account for a rename
// retiring that path. A later incarnation of the path is not retired by an
// older rename, so comparing UIDs is essential.
const notRetiredByRename = `NOT EXISTS (
  SELECT 1 FROM entries moved
   WHERE moved.vault_id = e.vault_id AND moved.prev_path = e.path AND moved.uid > e.uid)`

// TODO(PLAN.md section 4.5): this is today's survivor set, heads and the rename
// records they need, which is all Basalt and a device-only Trew have. Once
// MCP operations exist they pin the versions they displace (op_pins), and purge
// must keep every unexpired pin as well, in this set, so its preview and its
// execution still agree; until then purge removes exactly what it always has.
//
// Keep current paths and rename retirements. Deleted also needs the latest
// rename and, for a reused name, its predecessor after that rename: removing
// this evidence makes a genuine deletion look like a legacy rename's tail.
// A retained predecessor with content remains recoverable, including its bodies.
// Purge and its preview use exactly the same survivor set.
const purgeSurvivorUIDs = `
WITH heads AS (
 SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path
), renames AS (
 SELECT prev_path AS path, MAX(uid) AS uid FROM entries
  WHERE vault_id = ? AND prev_path <> '' GROUP BY prev_path
), deletions AS (
 SELECT e.path, e.uid, r.uid AS rename_uid FROM entries e
  JOIN heads h ON h.path = e.path AND h.uid = e.uid
  JOIN renames r ON r.path = e.path
  WHERE e.vault_id = ? AND e.deleted = 1
)
SELECT uid FROM heads
UNION
SELECT r.uid FROM renames r LEFT JOIN heads h ON h.path = r.path
 WHERE h.uid IS NULL OR h.uid < r.uid
UNION
SELECT rename_uid FROM deletions
UNION
SELECT MAX(p.uid) FROM entries p JOIN deletions d ON d.path = p.path
 WHERE p.vault_id = ? AND p.uid < d.uid AND p.uid > d.rename_uid
 GROUP BY p.path`

// A rename is also a tombstone for its previous path at the same UID.
func pathHead(q headReader, vault, path string) (uid int64, deleted bool, err error) {
	var moved int64
	var gone sql.NullBool
	err = q.QueryRow(`SELECT
	  (SELECT COALESCE(MAX(uid), 0) FROM entries WHERE vault_id = ? AND path = ?),
	  (SELECT COALESCE(MAX(uid), 0) FROM entries WHERE vault_id = ? AND prev_path = ?),
	  (SELECT deleted FROM entries WHERE vault_id = ? AND path = ? ORDER BY uid DESC LIMIT 1)`,
		vault, path, vault, path, vault, path).Scan(&uid, &moved, &gone)
	if moved > uid {
		return moved, true, err
	}
	return uid, gone.Bool, err
}

// Head is the uid of a path's newest version, counting a rename away from it,
// and whether that version left the path with no file: a deletion, or a
// rename's source. Zero when the vault has never held the path.
func (s *Store) Head(vault, path string) (uid int64, gone bool, err error) {
	return pathHead(s.db, vault, path)
}

// CurrentUID is Head's uid alone, the base a conditional write names.
func (s *Store) CurrentUID(vault, path string) (int64, error) {
	uid, _, err := pathHead(s.db, vault, path)
	return uid, err
}

var ErrStale = errors.New("the path changed since this write was prepared; reconcile before retrying")

func ValidateBase(base int64) error {
	if base < 0 || base > 9007199254740991 {
		return fmt.Errorf("%w: base must be a non-negative safe integer", ErrBadEntry)
	}
	return nil
}
