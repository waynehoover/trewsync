package gitexport

import (
	"database/sql"
	"errors"
	"net/url"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// StateFile is the export's own database, inside Dir. It is derived: the
// repository is what it describes, and both are rebuilt from the store when
// both are moved aside.
const StateFile = "state.db"

// RepoDir is the bare repository, inside Dir.
const RepoDir = "repo.git"

// stateSchema is the export's durable state.
//
// # branches
//
// One row per branch the export has written: the vault and store epoch it was
// exported from, how far (through, the last uid a commit covers), the
// planner's effective time there (last_at, see plan.go), and the commit the
// branch is at. pending_* is a commit written to the repository and not yet
// on the branch: recorded before the branch is moved, so a crash between the
// two is recognised as the export's own step and not as somebody else's
// change (exporter.go, "The step").
//
// # lfs_objects and lfs_pushed
//
// Every LFS object a commit has referenced, and which of them each remote
// has been sent. An object is sent before the commit that names it is pushed.
//
// # remotes
//
// Per remote and branch: the commit last pushed there, when the last attempt
// was and the last that worked, the last error, and, when the remote's branch
// is somewhere the export did not put it, why the export will not push until
// `trewd git-export set` is run again.
//
// # branches.adopted
//
// The commit the branch's first export commit has as its parent, when the
// branch was adopted (adopt.go), and empty when the export made it from nothing.
// Added after the first release of the table, so openState adds the column to
// a database made before it.
const stateSchema = `
CREATE TABLE IF NOT EXISTS branches (
  branch          TEXT    PRIMARY KEY,
  vault           TEXT    NOT NULL,
  epoch           TEXT    NOT NULL,
  through         INTEGER NOT NULL,
  last_at         INTEGER NOT NULL,
  commit_sha      TEXT    NOT NULL,
  pending_sha     TEXT    NOT NULL DEFAULT '',
  pending_through INTEGER NOT NULL DEFAULT 0,
  pending_last_at INTEGER NOT NULL DEFAULT 0,
  pending_epoch   TEXT    NOT NULL DEFAULT '',
  updated_at      INTEGER NOT NULL,
  adopted         TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lfs_objects (
  oid  TEXT    PRIMARY KEY,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lfs_pushed (
  remote TEXT NOT NULL,
  oid    TEXT NOT NULL,
  PRIMARY KEY (remote, oid)
);
CREATE TABLE IF NOT EXISTS remotes (
  remote          TEXT    NOT NULL,
  branch          TEXT    NOT NULL,
  pushed_sha      TEXT    NOT NULL DEFAULT '',
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_ok_at      INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT    NOT NULL DEFAULT '',
  refused         TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (remote, branch)
);
`

// branchState is a branches row.
type branchState struct {
	branch, vault, epoch string
	through, lastAt      int64
	commit               string
	pendingSHA           string
	pendingThrough       int64
	pendingLastAt        int64
	pendingEpoch         string
	updatedAt            int64
	adopted              string
}

// remoteState is a remotes row.
type remoteState struct {
	remote, branch string
	pushed         string
	lastAttemptAt  int64
	lastOKAt       int64
	lastError      string
	refused        string
}

// openState opens, or creates, the state database. FULL, unlike the search
// index's NORMAL: the pending row must be on disk before the branch moves.
// Read-only, a database made before a column was added is first opened
// writable once to add it, so the columns read are always there.
func openState(dir string, readOnly bool) (*sql.DB, error) {
	if readOnly {
		db, err := openStateAs(dir, true)
		if err != nil {
			return nil, err
		}
		var n int
		err = db.QueryRow(`SELECT count(*) FROM pragma_table_info('branches') WHERE name = 'adopted'`).Scan(&n)
		if err != nil {
			db.Close()
			return nil, err
		}
		if n > 0 {
			return db, nil
		}
		db.Close()
		rw, err := openStateAs(dir, false)
		if err != nil {
			return nil, err
		}
		rw.Close()
	}
	return openStateAs(dir, readOnly)
}

func openStateAs(dir string, readOnly bool) (*sql.DB, error) {
	path, err := filepath.Abs(filepath.Join(dir, StateFile))
	if err != nil {
		return nil, err
	}
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	params := "?_pragma=busy_timeout(5000)&_pragma=synchronous(FULL)"
	if readOnly {
		u.RawQuery = "mode=ro"
		params = "&_pragma=busy_timeout(5000)"
	} else {
		params += "&_pragma=journal_mode(WAL)"
	}
	db, err := sql.Open("sqlite", u.String()+params)
	if err != nil {
		return nil, err
	}
	if !readOnly {
		if _, err := db.Exec(stateSchema); err != nil {
			db.Close()
			return nil, err
		}
		if err := addColumn(db, "branches", "adopted", `TEXT NOT NULL DEFAULT ''`); err != nil {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}

// addColumn adds a column to a table made before it, when it is not there.
func addColumn(db *sql.DB, table, column, decl string) error {
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info(?) WHERE name = ?`, table, column).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + decl)
	return err
}

const branchCols = `branch, vault, epoch, through, last_at, commit_sha, pending_sha, pending_through,
  pending_last_at, pending_epoch, updated_at, adopted`

func loadBranch(q querier, branch string) (branchState, bool, error) {
	var b branchState
	err := q.QueryRow(`SELECT `+branchCols+` FROM branches WHERE branch = ?`, branch).Scan(&b.branch, &b.vault,
		&b.epoch, &b.through, &b.lastAt, &b.commit, &b.pendingSHA, &b.pendingThrough, &b.pendingLastAt,
		&b.pendingEpoch, &b.updatedAt, &b.adopted)
	if errors.Is(err, sql.ErrNoRows) {
		return branchState{branch: branch}, false, nil
	}
	return b, err == nil, err
}

func saveBranch(q execer, b branchState) error {
	_, err := q.Exec(`INSERT INTO branches (`+branchCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	  ON CONFLICT(branch) DO UPDATE SET vault = excluded.vault, epoch = excluded.epoch, through = excluded.through,
	    last_at = excluded.last_at, commit_sha = excluded.commit_sha, pending_sha = excluded.pending_sha,
	    pending_through = excluded.pending_through, pending_last_at = excluded.pending_last_at,
	    pending_epoch = excluded.pending_epoch, updated_at = excluded.updated_at, adopted = excluded.adopted`,
		b.branch, b.vault, b.epoch, b.through, b.lastAt, b.commit, b.pendingSHA, b.pendingThrough,
		b.pendingLastAt, b.pendingEpoch, b.updatedAt, b.adopted)
	return err
}

const remoteCols = `remote, branch, pushed_sha, last_attempt_at, last_ok_at, last_error, refused`

func loadRemote(q querier, remote, branch string) (remoteState, error) {
	r := remoteState{remote: remote, branch: branch}
	err := q.QueryRow(`SELECT `+remoteCols+` FROM remotes WHERE remote = ? AND branch = ?`, remote, branch).Scan(
		&r.remote, &r.branch, &r.pushed, &r.lastAttemptAt, &r.lastOKAt, &r.lastError, &r.refused)
	if errors.Is(err, sql.ErrNoRows) {
		return r, nil
	}
	return r, err
}

func saveRemote(q execer, r remoteState) error {
	_, err := q.Exec(`INSERT INTO remotes (`+remoteCols+`) VALUES (?, ?, ?, ?, ?, ?, ?)
	  ON CONFLICT(remote, branch) DO UPDATE SET pushed_sha = excluded.pushed_sha,
	    last_attempt_at = excluded.last_attempt_at, last_ok_at = excluded.last_ok_at,
	    last_error = excluded.last_error, refused = excluded.refused`,
		r.remote, r.branch, r.pushed, r.lastAttemptAt, r.lastOKAt, r.lastError, r.refused)
	return err
}

type querier interface {
	QueryRow(string, ...any) *sql.Row
}

type execer interface {
	querier
	Exec(string, ...any) (sql.Result, error)
}

func inTx(db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
