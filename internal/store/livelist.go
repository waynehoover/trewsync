package store

import (
	"context"
	"database/sql"
)

// EachLive calls fn with the newest version of every live path of a vault,
// files and folders, in path order, and returns the head the listing is of:
// what EachAsOf lists at that head, less the deletions, read from the live
// set (live_paths) instead of from every version. A read-only addition for
// the MCP tools' listings of the vault (internal/mcp, viewAt).
//
// EachAsOf asks every version whether it is its path's newest at the head,
// so its cost grows with the history: for ten thousand notes it took 24 ms
// at one version each and 470 ms at forty, where a listing driven by the
// live set took 26 to 34 ms at every depth (the 2026-10-06 review). The live
// set holds one row per live path, and is written in the same transaction
// as each entry that changes it (liveSchema), so read in one transaction
// with the head it is exactly the vault at that head. Only at the latest
// head: a caller that wants another head, or was given a newer one than it
// asked for, lists that head with EachAsOf.
//
// Chunk lists are not attached, as EachAsOf attaches none. fn returns false
// to stop.
func (s *Store) EachLive(vaultID string, fn func(Entry) (bool, error)) (head int64, err error) {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var latest sql.NullInt64
	if err := tx.QueryRow(`SELECT MAX(uid) FROM entries WHERE vault_id = ?`, vaultID).Scan(&latest); err != nil {
		return 0, err
	}
	rows, err := tx.Query(`SELECT `+asOfCols+` FROM live_paths l JOIN entries e
	    ON e.vault_id = l.vault_id
	   AND e.uid = (SELECT x.uid FROM entries x WHERE x.vault_id = l.vault_id AND x.path = l.path
	                 ORDER BY x.uid DESC LIMIT 1)
	 WHERE l.vault_id = ?
	 ORDER BY l.path`, vaultID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return 0, err
		}
		e.Chunks = []string{}
		more, err := fn(e)
		if err != nil || !more {
			return latest.Int64, err
		}
	}
	return latest.Int64, rows.Err()
}
