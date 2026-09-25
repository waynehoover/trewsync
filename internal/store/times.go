package store

import (
	"database/sql"
	"strings"
	"time"
)

// entryTimesSchema records when each version was committed, by the server's
// clock.
//
// An entry carries only the client's ctime and mtime, which a wrong device
// clock can set to anything (PLAN.md section 3.3), and an agent's operation
// has its committed_at in the operation log, but a device's version had no
// server time anywhere. The Git export needs one: it dates its commits by
// the server and coalesces a device's versions by the quiet between them, and
// a from-scratch export must come out the same as the one made as the notes
// arrived, so the time has to be in the store rather than in the exporter's
// memory of when it happened to look (internal/gitexport).
//
// A table beside the entries rather than a column on them, so that nothing
// that reads an entry changes and no schema version is needed: a table
// reaches an existing store through `CREATE TABLE IF NOT EXISTS`, and a build
// that does not know it writes entries without a row here, which a reader
// takes as "no time recorded" (CommitTimes), never as an error. The rows go
// with their entries, by the cascade, so a purge that drops a version drops
// its time too, whichever build runs it.
const entryTimesSchema = `
CREATE TABLE IF NOT EXISTS entry_times (
  vault_id     TEXT    NOT NULL,
  uid          INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, uid),
  FOREIGN KEY (vault_id, uid) REFERENCES entries(vault_id, uid) ON DELETE CASCADE
);
`

// Now is the store's clock: what it commits operations and entries by.
func (s *Store) Now() time.Time { return s.clock() }

// CommitTimes is the server time, in milliseconds, each version from uid
// from to uid to was committed at. A version with no time recorded (written
// before this table existed, or by a build that did not know it) is absent
// from the map, and so is every version of a store opened for inspection
// that predates the table.
func (s *Store) CommitTimes(vaultID string, from, to int64) (map[int64]int64, error) {
	rows, err := s.db.Query(
		`SELECT uid, committed_at FROM entry_times WHERE vault_id = ? AND uid BETWEEN ? AND ?`,
		vaultID, from, to)
	if err != nil {
		if noSuchTable(err) {
			return map[int64]int64{}, nil
		}
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var uid, at int64
		if err := rows.Scan(&uid, &at); err != nil {
			return nil, err
		}
		out[uid] = at
	}
	return out, rows.Err()
}

// OpStamp is the operation a version was written by, as the Git export names
// it: one commit per operation.
type OpStamp struct {
	ID          string
	Tool        string
	ActorKind   string
	ActorLabel  string
	CommittedAt int64
	// LastUID is the last version the operation wrote, so a reader that has
	// reached it knows it has seen all of the operation's versions.
	LastUID int64
}

// OperationStamps is, for every version from uid from to uid to that an
// operation wrote, that operation. A version a device wrote is absent. A
// move is two rows of op_entries sharing one version, which is one key here.
func (s *Store) OperationStamps(vaultID string, from, to int64) (map[int64]OpStamp, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT oe.after_uid, o.id, o.tool, o.actor_kind, o.actor_label, o.committed_at,
		        (SELECT MAX(x.after_uid) FROM op_entries x WHERE x.op_id = o.id)
		   FROM op_entries oe JOIN operations o ON o.id = oe.op_id
		  WHERE o.vault_id = ? AND oe.after_uid BETWEEN ? AND ?`, vaultID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]OpStamp{}
	for rows.Next() {
		var uid int64
		var o OpStamp
		var last sql.NullInt64
		if err := rows.Scan(&uid, &o.ID, &o.Tool, &o.ActorKind, &o.ActorLabel, &o.CommittedAt, &last); err != nil {
			return nil, err
		}
		o.LastUID = last.Int64
		out[uid] = o
	}
	return out, rows.Err()
}

// noSuchTable reports whether err is SQLite saying a table is not there.
func noSuchTable(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no such table")
}
