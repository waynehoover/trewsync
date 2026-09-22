package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Product is what a Telimus data directory says it is, in its store_identity
// row (PLAN.md section 2.8), and the stem of every file name this package
// gives a data directory.
//
// Derived names come from it rather than being spelled out, because the
// product name is not final (PLAN.md section 10) and a rename should be one
// constant.
const Product = "telimus"

// basaltDatabase is the database file a Basalt data directory holds. A
// directory with one is Basalt's, whatever else it contains, and is refused
// before anything is created in it: the two products share the chunk tree's
// name and the lock files' names, so a fresh telimus.db beside a basalt.db
// would adopt Basalt's bodies, and a later purge would sweep every one of
// them as unreferenced.
const basaltDatabase = "basalt.db"

// ErrForeignStore is a data directory or a database this build will not
// adopt: Basalt's, another product's, one with no identity at all, or a chunk
// tree with no database beside it. It is refused before anything is written,
// and the directory is left as it was found.
var ErrForeignStore = errors.New("this is not a " + Product + " data directory")

// ErrFutureSchema is a database written by a newer telimus.
var ErrFutureSchema = errors.New("this database was written by a newer " + Product)

// Identity is what a store says about itself: which product wrote it, which
// schema it is in, and which epoch its uid sequence belongs to.
//
// The epoch is minted when the store is created and again for every backup
// snapshot, so a database served from a backup never shares an epoch with
// the store it was copied from. A device keeps the epoch beside its cursor,
// and a different one in `ready` means the uid sequence it was following may
// have been reissued: it lists again from zero rather than trusting a cursor
// into a history that is not the one it read (plan/protocol.md, "Device
// session").
type Identity struct {
	Product       string
	SchemaVersion int
	Epoch         string
	CreatedAt     int64
}

// identitySchema creates the identity table. One row, enforced by the key,
// because two rows would be two answers to "what is this directory".
const identitySchema = `
CREATE TABLE IF NOT EXISTS store_identity (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  product        TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  epoch          TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);
`

// newEpoch mints an epoch: 16 random bytes, unpadded base64url. Opaque to
// every reader; only equality means anything.
func newEpoch() (string, error) {
	var b [16]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return "", fmt.Errorf("minting a store epoch: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// CheckDataDir says whether dir can be served by this build, touching nothing.
//
// It is what every command runs before it takes a lock, because taking a lock
// creates the lock file, and a Basalt directory has lock files of the same
// names: refusing after the lock would already have written to the directory
// it is refusing. A directory that does not exist, or exists and holds no
// store yet, is fine; the caller decides whether it may create one.
func CheckDataDir(dir string) error {
	dbPath, chunkDir := DataDir(dir)
	_, err := checkDirectory(dbPath, chunkDir)
	return err
}

// CheckBackupDestination is CheckDataDir for a directory a backup is about to
// be written into, touching nothing.
//
// The same refusals except one. A Basalt directory and a database this build
// did not write are refused, because a backup published beside them would
// adopt their chunk tree exactly as a new store would. Bodies with no database
// are not: they are what a first backup that failed before publishing leaves,
// and the next run is meant to reuse them.
func CheckBackupDestination(dir string) error {
	dbPath, _ := DataDir(dir)
	if _, err := os.Stat(dbPath); err == nil {
		_, err := probeIdentity(dbPath)
		return err
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return refuseBasalt(dir)
}

// refuseBasalt refuses a directory holding a Basalt database.
func refuseBasalt(dir string) error {
	for _, name := range []string{basaltDatabase, basaltDatabase + "-wal"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return fmt.Errorf("%w: %s holds %s, so it is a Basalt data directory. "+
				"Basalt's history is encrypted and cannot be read here; start %s on a new, empty "+
				"directory and pair the devices again (PLAN.md section 2.8). Nothing in %s was changed",
				ErrForeignStore, dir, name, Product, dir)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// checkDirectory is CheckDataDir for a database path and a chunk tree, and
// reports whether a database file is already there.
//
// Nothing here writes. A database that exists is probed through an immutable
// open, which takes no lock and creates no journal; a directory with no
// database is searched for another product's database and for chunk bodies
// with nothing to own them.
func checkDirectory(dbPath, chunkDir string) (exists bool, err error) {
	switch _, statErr := os.Stat(dbPath); {
	case statErr == nil:
		if _, err := probeIdentity(dbPath); err != nil {
			return true, err
		}
		return true, nil
	case !errors.Is(statErr, os.ErrNotExist):
		return false, statErr
	}

	if err := refuseBasalt(filepath.Dir(dbPath)); err != nil {
		return false, err
	}
	if body, err := firstFile(chunkDir); err != nil {
		return false, err
	} else if body != "" {
		return false, fmt.Errorf("%w: %s holds chunk bodies (%s) and there is no %s beside it, so "+
			"a new store here would adopt bodies it knows nothing about and a purge would delete "+
			"them. Restore the database from a backup, or move %s aside if you mean to start "+
			"again. Nothing was changed",
			ErrForeignStore, chunkDir, body, filepath.Base(dbPath), chunkDir)
	}
	return false, nil
}

// firstFile is the first regular file under dir, or "" when there is none or
// dir does not exist. The walk stops at the first one, so a large tree costs
// no more than a small one.
func firstFile(dir string) (string, error) {
	found := ""
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			found = p
			return fs.SkipAll
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return found, err
}

// probeIdentity reads a database's identity without writing to the database,
// its write-ahead log or the directory. It returns the zero Identity for a
// database with no tables at all, which is one this build may initialise.
//
// Immutable first: SQLite takes no lock, opens no journal and reads only the
// main file, which is the one open that leaves every byte where it was. A
// normal open is not that. Closing the last connection checkpoints a hot
// write-ahead log into the main file and deletes it, and a read-only open
// leaves a -wal and a -shm behind in a directory that had neither, both
// measured against the pinned driver before this was written.
//
// The main file's verdict is final when it is one. A store is created in one
// transaction, identity row and tables together, so a main file with tables
// and no identity is not a store this build wrote, and one with an identity
// says what it is; the log cannot change a product or lower a schema.
//
// Two cases need the log, and are read through a read-only open, which takes
// SQLite's locks, cannot checkpoint, and so leaves the database and its log
// unchanged (it may rewrite the -shm index of the log it reads, which is
// derived state SQLite rebuilds from the log on every open):
//
//   - a main file with no tables beside a log that is not empty, since the
//     whole store may be in the log;
//   - a main file that could not be read, when there is a log. A reader that
//     takes no lock can see a page half copied by a running server's
//     checkpoint, which is what `backup` and `verify` against a live server
//     would meet. With no log there is no checkpoint to race, and a main
//     file that cannot be read is the answer.
func probeIdentity(dbPath string) (Identity, error) {
	id, empty, err := readIdentityWith(dbPath, "mode=ro&immutable=1")
	switch {
	case err == nil && !empty:
		return id, nil
	case errors.Is(err, ErrForeignStore), errors.Is(err, ErrFutureSchema):
		return Identity{}, err
	}
	info, statErr := os.Stat(dbPath + "-wal")
	switch {
	case errors.Is(statErr, os.ErrNotExist) || (statErr == nil && info.Size() == 0 && err == nil):
		if err != nil {
			return Identity{}, err
		}
		return Identity{}, nil
	case statErr != nil:
		return Identity{}, statErr
	}
	id, _, err = readIdentityWith(dbPath, "mode=ro")
	return id, err
}

// readIdentityWith opens dbPath with the given URI parameters and reads its
// identity, reporting whether the database has no tables at all.
func readIdentityWith(dbPath, params string) (Identity, bool, error) {
	absPath, err := filepath.Abs(dbPath)
	if err != nil {
		return Identity{}, false, err
	}
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(absPath)}
	db, err := sql.Open("sqlite", u.String()+"?"+params+"&_pragma=query_only(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return Identity{}, false, err
	}
	defer db.Close()
	return readIdentity(db, dbPath)
}

// querier is what readIdentity needs from a handle or a transaction.
type querier interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}

// readIdentity reads and validates the identity row, reporting whether the
// database has no tables at all. Every refusal names the directory and says
// that nothing was changed, because the person reading it is deciding what to
// do with their data.
func readIdentity(q querier, dbPath string) (Identity, bool, error) {
	var tables int
	if err := q.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'`).Scan(&tables); err != nil {
		if strings.Contains(err.Error(), "not a database") {
			return Identity{}, false, fmt.Errorf("%w: %s is not a SQLite database; nothing was changed",
				ErrForeignStore, dbPath)
		}
		return Identity{}, false, fmt.Errorf("reading %s: %w", dbPath, err)
	}
	if tables == 0 {
		return Identity{}, true, nil
	}

	var hasIdentity int
	if err := q.QueryRow(`SELECT COUNT(*) FROM sqlite_master
	                       WHERE type = 'table' AND name = 'store_identity'`).Scan(&hasIdentity); err != nil {
		return Identity{}, false, err
	}
	if hasIdentity == 0 {
		return Identity{}, false, foreignWithoutIdentity(q, dbPath)
	}

	rows, err := q.Query(`SELECT product, schema_version, epoch, created_at FROM store_identity`)
	if err != nil {
		return Identity{}, false, err
	}
	defer rows.Close()
	var found []Identity
	for rows.Next() {
		var id Identity
		if err := rows.Scan(&id.Product, &id.SchemaVersion, &id.Epoch, &id.CreatedAt); err != nil {
			return Identity{}, false, err
		}
		found = append(found, id)
	}
	if err := rows.Err(); err != nil {
		return Identity{}, false, err
	}
	if len(found) != 1 {
		return Identity{}, false, fmt.Errorf("%w: %s has %d identity rows and a store has exactly one; "+
			"nothing was changed", ErrForeignStore, dbPath, len(found))
	}
	id := found[0]
	switch {
	case id.Product != Product:
		return Identity{}, false, fmt.Errorf("%w: %s was written by %q, not %s; nothing was changed",
			ErrForeignStore, dbPath, id.Product, Product)
	case id.SchemaVersion > SchemaVersion:
		return Identity{}, false, fmt.Errorf(
			"%w: %s is schema %d and this %s understands %d. Run the newer %s, or restore a backup "+
				"taken before the upgrade. Opening it with this one would read rows it does not "+
				"understand and write rows the newer one would not; nothing was changed",
			ErrFutureSchema, dbPath, id.SchemaVersion, Product, SchemaVersion, Product)
	case id.SchemaVersion < 1:
		return Identity{}, false, fmt.Errorf("%w: %s says it is schema %d, which no %s has written; "+
			"nothing was changed", ErrForeignStore, dbPath, id.SchemaVersion, Product)
	case id.Epoch == "":
		return Identity{}, false, fmt.Errorf("%w: %s has no epoch in its identity; nothing was changed",
			ErrForeignStore, dbPath)
	}
	return id, false, nil
}

// foreignWithoutIdentity names what a database with tables and no identity
// row is, as far as its tables can say.
//
// Basalt's is the one worth recognising by name, because it is the directory
// somebody migrating is most likely to point this at, and its schema version
// is 1: the same number this build's first schema has, which is exactly why
// the identity row exists (PLAN.md section 2.8). A Telimus build from before
// protocol 1 wrote Basalt's schema too, and gets the same answer.
func foreignWithoutIdentity(q querier, dbPath string) error {
	rows, err := q.Query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	names := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return err
		}
		names[n] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if names["vaults"] && names["entries"] && names["entry_chunks"] {
		return fmt.Errorf("%w: %s has Basalt's tables and no store identity, so it was written by "+
			"Basalt or by a %s build from before protocol 1. Its history cannot be served by this "+
			"build; start on a new, empty directory and pair the devices again (PLAN.md section "+
			"2.8). Nothing was changed", ErrForeignStore, dbPath, Product)
	}
	return fmt.Errorf("%w: %s is a SQLite database with no store identity, so it is not one this "+
		"build wrote; nothing was changed", ErrForeignStore, dbPath)
}
