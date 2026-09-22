package store

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/waynehoover/telimus/internal/chunks"
)

// SchemaVersion is what this binary's schema is, written into the database as
// SQLite's `user_version` (I15).
//
// The number exists so an older binary can refuse a database a newer one wrote,
// instead of opening it and being wrong quietly. Nothing checked before this:
// `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there,
// so a build that had never heard of a column would start cleanly on a database
// full of them, read the columns it did know, and write rows missing the rest.
// Every one of those rows is somebody's note, and no message would have
// appeared anywhere.
//
// Raise it when a change makes a database unreadable by the build before it.
// Adding a table or a nullable column is not that: `migrate` handles those
// forwards and an older binary ignores them, which is why every database this
// project has ever written is version 1. What would need a 2 is a column whose
// meaning changed, a row an old build would misread, or anything that makes
// going back destructive.
const SchemaVersion = 1

// ErrFutureSchema is a database written by a newer telimus.
var ErrFutureSchema = errors.New("this database was written by a newer telimus")

// Mode says what opening a store is allowed to do to it.
//
// The distinction is for the administrative commands. `verify`, `stats` and the
// coverage a backup reports are questions, and they all used the same opening
// path as `serve`: it creates the directory if it is not there, runs the
// migrations and executes the schema. So a typo in `-data` produced an empty
// store rather than an error, and inspecting a backup from an older build
// migrated it, which is a diagnostic command modifying the thing it was asked
// to look at.
type Mode int

const (
	// Create is what `serve` does: make the directory if needed, migrate, and
	// bring the schema up to date.
	Create Mode = iota
	// Existing opens a store that must already be there, and still migrates.
	Existing
	// ReadOnly opens without creating, without migrating and without writing
	// the schema, and SQLite itself refuses writes through the handle.
	ReadOnly
)

// OpenMode opens a store with an explicit contract about what it may change.
//
// The schema version is checked in every mode, including ReadOnly: a database
// from the future is one this binary cannot read correctly, and being asked
// only to look at it does not make that safe. Refusing is the whole point.
func OpenMode(dbPath, chunkDir string, mode Mode, sync SyncMode) (*Store, error) {
	if sync != SyncFull && sync != SyncNormal {
		return nil, fmt.Errorf("invalid sync mode %q", sync)
	}

	switch mode {
	case Create:
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
			return nil, err
		}
	case Existing, ReadOnly:
		// Named rather than created. `telimus verify -data /typo` used to make
		// an empty store and report it healthy, which is a true statement about
		// a directory nobody wanted and a false answer to the question asked.
		if _, err := os.Stat(dbPath); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("no database at %s", dbPath)
			}
			return nil, err
		}
	}

	openChunks := chunks.New
	if mode == ReadOnly {
		openChunks = chunks.OpenExisting
	}
	cs, err := openChunks(chunkDir, ChunkMax)
	if err != nil {
		return nil, err
	}

	// SQLite and its driver parse URI parameters. Escape the filesystem path
	// first so a literal '?' cannot truncate it or inject connection options.
	absPath, err := filepath.Abs(dbPath)
	if err != nil {
		return nil, err
	}
	dbURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(absPath)}
	dsn := dbURL.String() + "?_pragma=busy_timeout(5000)" +
		"&_pragma=synchronous(" + string(sync) + ")" +
		"&_pragma=foreign_keys(1)"
	if mode == ReadOnly {
		// The driver's own read-only open, so this is enforced below the code
		// rather than by the code remembering. A write through this handle is
		// an error from SQLite, which is what makes "inspection does not
		// modify" a fact rather than a convention.
		dsn += "&_pragma=query_only(1)&mode=ro"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}

	if err := checkSchemaVersion(db, dbPath); err != nil {
		db.Close()
		return nil, err
	}

	if mode != ReadOnly {
		if err := migrate(db); err != nil {
			db.Close()
			return nil, fmt.Errorf("migrating: %w", err)
		}
		if _, err := db.Exec(schema); err != nil {
			db.Close()
			return nil, fmt.Errorf("schema: %w", err)
		}
		if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", SchemaVersion)); err != nil {
			db.Close()
			return nil, fmt.Errorf("recording the schema version: %w", err)
		}
	}

	// Asked rather than assumed: a read-only open does not migrate, so a
	// backup from before `n_chunks` existed is read exactly as it is (R48).
	counted, err := hasColumn(db, "entries", "n_chunks")
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{
		db: db, chunks: cs, dbPath: dbPath,
		hasChunkCount: counted, readOnly: mode == ReadOnly,
	}, nil
}

// checkSchemaVersion refuses a database this binary is too old to read.
//
// Zero is every database written before the version existed, and it is
// accepted: those are readable, and refusing them would mean an upgrade that
// cannot open the store it is upgrading. Anything above SchemaVersion is a
// newer telimus's, and the refusal names both numbers because the answer is
// always "run the newer one" and a message that does not say which is which
// leaves somebody guessing at their own data.
func checkSchemaVersion(db *sql.DB, dbPath string) error {
	var got int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&got); err != nil {
		return fmt.Errorf("reading the schema version: %w", err)
	}
	if got > SchemaVersion {
		return fmt.Errorf(
			"%w: %s is schema %d and this telimus understands %d. "+
				"Run the newer telimus, or restore a backup taken before the upgrade. "+
				"Opening it with this one would read rows it does not understand and write rows "+
				"the newer one would not",
			ErrFutureSchema, dbPath, got, SchemaVersion)
	}
	return nil
}
