package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/waynehoover/trewsync/internal/chunks"
)

// SchemaVersion is what this binary's schema is, recorded in the store's
// identity row and in SQLite's `user_version` (I15, PLAN.md section 2.8).
//
// The number exists so an older binary can refuse a database a newer one
// wrote, instead of opening it and being wrong quietly. `CREATE TABLE IF NOT
// EXISTS` does nothing to a table that is already there, so a build that had
// never heard of a column would start cleanly on a database full of them, read
// the columns it did know, and write rows missing the rest. Every one of those
// rows is somebody's note, and no message would have appeared anywhere.
//
// It is the identity row that is checked, not `user_version`. Basalt's schema
// is also version 1 in `user_version`, which is exactly the collision the
// identity row exists for: a bare version number cannot tell this product's
// first schema from another product's.
//
// Raise it when a change makes a database unreadable by the build before it,
// and add the step to `migrations`. The upgrade discipline outlives the fresh
// first schema: the second one must arrive tested.
//
// Version 2 is the operation log (oplogSchema, PLAN.md M5). It is a version
// and not only a table because the build before it is dangerous on a store
// that has one, not merely ignorant of it: that build's purge keeps heads and
// rename records and nothing else, so run on a store where agents have pinned
// the versions they displaced, it would drop every before-image on the spot
// (PLAN.md section 4.5). A new table alone reaches an older store through
// `CREATE TABLE IF NOT EXISTS` and fences nothing; the version is what makes
// the older build refuse, with ErrFutureSchema, before its purge can run.
//
// Version 3 is undo (PLAN.md section 4.5): operations made by the operator and
// by devices, and the operation an undo undoes. The build at version 2 would
// read an operator's undo as an agent's, fail to verify it, and let an undo be
// undone as though it were the operation it compensated for, so it is fenced
// off the same way.
//
// Version 4 is the restore to a uid (PLAN.md M5.5): the operator's restore
// operations, which the build at version 3 would report as malformed undos,
// and the purge mark (purge_marks), which that build's purge would not move.
// A restore trusts the mark to say which uids a purge cannot have taken
// history below, so a purge that left it behind would make a restore read a
// path's state from a history with a hole in it; the version fences that
// build off before its purge can run.
const SchemaVersion = 4

// migrations are the steps from one schema version to the next, keyed by the
// version they upgrade from. Each step runs inside the transaction that
// records the new version, so a store is at one version or the next and never
// between them.
var migrations = map[int]func(q execer) error{
	// 1 to 2: the operation log. A store at version 1 has never committed an
	// agent operation, because no build at version 1 could, so the tables
	// start empty and nothing already stored changes meaning.
	1: func(q execer) error {
		_, err := q.Exec(oplogSchema)
		return err
	},
	// 2 to 3: operations and op_entries rebuilt for undo, every row kept.
	2: rebuildOplog,
	// 3 to 4: the purge mark, set for a vault already purged to its newest
	// uid, since nothing recorded how far each earlier purge reached.
	3: addPurgeMarks,
}

// withoutForeignKeys are the steps that rebuild a table other tables refer
// to, which SQLite's procedure runs with foreign keys off (rebuildOplog).
var withoutForeignKeys = map[int]bool{2: true}

// execer is what a migration or an initialisation needs from a transaction.
type execer interface {
	querier
	Exec(string, ...any) (sql.Result, error)
}

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
	// Source opens a store a backup is taken from, beside a server that may
	// be running on it: it must already be there and at this build's schema,
	// and it is neither migrated nor given the schema (T37). The handle can
	// write, because SQLite refuses `VACUUM INTO` on a read-only one, and
	// nothing the backup asks of it writes to the store.
	Source
)

// ErrOlderSchema is a store at a schema older than this build's, opened by a
// command that may not upgrade it.
var ErrOlderSchema = errors.New("this store is at a schema older than this " + Program + "'s")

// olderSchema is the refusal of a store older than this build, for a command
// that may not upgrade it: what the store is, why this command leaves it
// alone, and what does upgrade it.
//
// A backup's source (T37): the server running on it is the older build,
// which `trewd update` leaves running until it restarts, so the backup is the
// one command that would meet it, every night.
func olderSchema(dbPath string, have int) error {
	return fmt.Errorf("%w: %s is schema %d and this %s writes %d. A server running on it is the older "+
		"build, and a backup that upgraded the store under it would leave that build refusing its own "+
		"store, and the rollback to it too. Restart the server with this build (systemctl restart trew), "+
		"which upgrades the store when it opens it, and run this again; nothing was changed",
		ErrOlderSchema, dbPath, have, Program, SchemaVersion)
}

// OpenMode opens a store with an explicit contract about what it may change.
//
// The store's identity is checked in every mode and before anything is
// written or created, including the directory, the chunk tree and the
// database file (PLAN.md section 2.8). A Basalt directory, another product's
// database, one with no identity, a newer schema, and a chunk tree with no
// database are all refused with the directory left exactly as it was. Being
// asked only to look does not make reading a database this binary cannot
// interpret safe, and refusing is the whole point.
func OpenMode(dbPath, chunkDir string, mode Mode, sync SyncMode) (*Store, error) {
	if sync != SyncFull && sync != SyncNormal {
		return nil, fmt.Errorf("invalid sync mode %q", sync)
	}

	// Before anything is created. Every check in here only reads.
	exists, err := checkDirectory(dbPath, chunkDir)
	if err != nil {
		return nil, err
	}
	switch mode {
	case Create:
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
			return nil, err
		}
	case Existing, ReadOnly, Source:
		// Named rather than created. `trewd verify -data /typo` used to make
		// an empty store and report it healthy, which is a true statement about
		// a directory nobody wanted and a false answer to the question asked.
		if !exists {
			return nil, fmt.Errorf("no database at %s", dbPath)
		}
	}

	openChunks := chunks.New
	if mode == ReadOnly || mode == Source {
		openChunks = chunks.OpenExisting
	}
	cs, err := openChunks(chunkDir, ChunkMax)
	if err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite", dsn(dbPath, sync, mode == ReadOnly))
	if err != nil {
		return nil, err
	}

	// Again, through the handle that will be used, because this one reads the
	// write-ahead log and the probe above deliberately did not. A newer schema
	// recorded only in the log is refused here, before migrate or the schema
	// has run.
	id, empty, err := readIdentity(db, dbPath)
	if err != nil {
		db.Close()
		return nil, err
	}
	if empty && mode != Create {
		db.Close()
		return nil, fmt.Errorf("%s holds no store: it has no tables, so it was never initialised", dbPath)
	}
	if mode == Source && id.SchemaVersion < SchemaVersion {
		db.Close()
		return nil, olderSchema(dbPath, id.SchemaVersion)
	}

	if mode != ReadOnly && mode != Source {
		if empty {
			id, err = initialise(db, dbPath)
		} else {
			id, err = migrate(db, dbPath, id)
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}

	return &Store{
		db: db, chunks: cs, dbPath: dbPath, identity: id, readOnly: mode == ReadOnly,
		retention: DefaultRetention,
	}, nil
}

// dsn is the connection string every handle on a store uses.
//
// The pragmas are here rather than in the schema because a pragma in a
// statement applies to the one connection that ran it, and database/sql keeps
// a pool.
//
// `temp_store = MEMORY` (2) is the one that has cost something. SQLite writes a
// statement journal whenever a statement inside a transaction may have to be
// rolled back on its own, which is what a SAVEPOINT is for, and it puts that
// journal in a temp directory. The shipped container mounts only /data and is
// read-only everywhere else, so there is no temp directory to have: Basalt's
// batched commit asked for one and got SQLITE_IOERR_GETTEMPPATH (6410) on
// every batch large enough to need it, twenty-two thousand times in a day on
// the author's own server, rescued only by a fallback to one commit per entry.
// MEMORY is right rather than a workaround: the transactions hold one batch,
// which the protocol bounds, so the journal is small.
//
// The pragma used to be a statement in the schema, and so reached only the
// connection that ran the schema. Measured against the pinned driver, every
// other connection in the pool reported 0, the default, which is the temp
// directory again. In the DSN the driver runs it on every connection it opens,
// and TestEveryConnectionKeepsItsTempStoreInMemory holds it there.
//
// SQLite and its driver parse URI parameters. The filesystem path is escaped
// first so a literal '?' cannot truncate it or inject connection options.
func dsn(dbPath string, sync SyncMode, readOnly bool) string {
	absPath, err := filepath.Abs(dbPath)
	if err != nil {
		absPath = dbPath
	}
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(absPath)}
	s := u.String() + "?_pragma=busy_timeout(5000)" +
		"&_pragma=synchronous(" + string(sync) + ")" +
		"&_pragma=foreign_keys(1)" +
		"&_pragma=temp_store(2)"
	if readOnly {
		// The driver's own read-only open, so this is enforced below the code
		// rather than by the code remembering. A write through this handle is
		// an error from SQLite, which is what makes "inspection does not
		// modify" a fact rather than a convention.
		s += "&_pragma=query_only(1)&mode=ro"
	}
	return s
}

// initialise writes the schema and the identity row into a database that has
// no tables, in one transaction, so a store either has an identity and every
// table or has nothing and is initialised again on the next open.
//
// The journal mode goes first and on its own, because SQLite will not change
// it inside a transaction. A crash between the two leaves a database with no
// tables, which is exactly the state this function starts from.
func initialise(db *sql.DB, dbPath string) (Identity, error) {
	if _, err := db.Exec(`PRAGMA journal_mode = WAL`); err != nil {
		return Identity{}, fmt.Errorf("schema: %w", err)
	}
	epoch, err := newEpoch()
	if err != nil {
		return Identity{}, err
	}
	var id Identity
	err = immediate(db, func(q execer) error {
		// Another handle may have initialised it while this one waited for
		// the lock. Its identity is the one that stands.
		existing, empty, err := readIdentity(q, dbPath)
		if err != nil {
			return err
		}
		if !empty {
			id = existing
			return nil
		}
		if _, err := q.Exec(identitySchema + schema); err != nil {
			return fmt.Errorf("schema: %w", err)
		}
		id = Identity{Product: Product, SchemaVersion: SchemaVersion, Epoch: epoch, CreatedAt: nowMillis()}
		if _, err := q.Exec(
			`INSERT INTO store_identity (id, product, schema_version, epoch, created_at) VALUES (1, ?, ?, ?, ?)`,
			id.Product, id.SchemaVersion, id.Epoch, id.CreatedAt); err != nil {
			return fmt.Errorf("recording the store identity: %w", err)
		}
		if _, err := q.Exec(fmt.Sprintf("PRAGMA user_version = %d", SchemaVersion)); err != nil {
			return fmt.Errorf("recording the schema version: %w", err)
		}
		return nil
	})
	return id, err
}

// migrate brings a store from the schema version it records to this binary's,
// one step at a time, each step and its new version in one transaction, and
// then makes sure every table the current schema names is there.
//
// The second half is `CREATE TABLE IF NOT EXISTS` and costs nothing on a
// store that is current. It stays because it is idempotent and because a
// table added to the schema reaches an existing store through it; a column
// does not, and needs a step, and so does a table the build before would be
// wrong to ignore (see SchemaVersion).
func migrate(db *sql.DB, dbPath string, id Identity) (Identity, error) {
	for id.SchemaVersion < SchemaVersion {
		step, ok := migrations[id.SchemaVersion]
		if !ok {
			return id, fmt.Errorf("%s is schema %d and this build has no step from it to %d",
				dbPath, id.SchemaVersion, id.SchemaVersion+1)
		}
		next := id.SchemaVersion + 1
		run := immediate
		if withoutForeignKeys[id.SchemaVersion] {
			run = rebuilding
		}
		if err := run(db, func(q execer) error {
			if err := step(q); err != nil {
				return err
			}
			if _, err := q.Exec(`UPDATE store_identity SET schema_version = ? WHERE id = 1`, next); err != nil {
				return err
			}
			_, err := q.Exec(fmt.Sprintf("PRAGMA user_version = %d", next))
			return err
		}); err != nil {
			return id, fmt.Errorf("migrating %s from schema %d: %w", dbPath, id.SchemaVersion, err)
		}
		id.SchemaVersion = next
	}
	if _, err := db.Exec(schema); err != nil {
		return id, fmt.Errorf("schema: %w", err)
	}
	// The header copy of the version, restamped when it has drifted from the
	// identity row, so a tool that reads only the header is not misled. The
	// identity row is the authority and nothing here trusts the header.
	var header int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&header); err != nil {
		return id, fmt.Errorf("reading the schema version: %w", err)
	}
	if header != id.SchemaVersion {
		if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", id.SchemaVersion)); err != nil {
			return id, fmt.Errorf("recording the schema version: %w", err)
		}
	}
	return id, nil
}

// immediate runs fn in a transaction begun with BEGIN IMMEDIATE, on one pinned
// connection.
//
// Immediate rather than deferred, for any transaction that reads and then
// decides to write. A deferred transaction takes the write lock only at its
// first write, and in WAL mode a read snapshot older than the latest commit
// cannot be upgraded: SQLite answers SQLITE_BUSY at once instead of waiting,
// because retrying would not refresh what the transaction already read. Taking
// the lock at BEGIN means the busy timeout waits for it, and every read inside
// sees the latest commit. That is what several store handles on one directory
// need, and `trewd backup`, `purge` and the admin commands are exactly that.
//
// database/sql has no way to ask for it, so the statements are sent by hand on
// a pinned connection. A connection whose rollback failed is discarded rather
// than returned to the pool with a transaction still open on it.
func immediate(db *sql.DB, fn func(q execer) error) error {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	abandon := func() {
		if _, err := conn.ExecContext(ctx, "ROLLBACK"); err != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}
	if err := fn(pinned{conn, ctx}); err != nil {
		abandon()
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		abandon()
		return err
	}
	return nil
}

// rebuilding is immediate for a migration step that rebuilds a table other
// tables refer to: foreign keys off and legacy_alter_table on, both set on the
// pinned connection before the transaction begins, because SQLite ignores a
// change to either inside one. Before the commit, PRAGMA foreign_key_check
// must find no reference that lands nowhere, or the step is rolled back. Both
// pragmas are put back on the connection whatever happened, and a connection
// that cannot be put back is discarded rather than returned to the pool with
// its foreign keys off.
func rebuilding(db *sql.DB, fn func(q execer) error) error {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	restore := func() {
		_, e1 := conn.ExecContext(ctx, "PRAGMA legacy_alter_table = OFF")
		_, e2 := conn.ExecContext(ctx, "PRAGMA foreign_keys = ON")
		if e1 != nil || e2 != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}
	defer restore()
	for _, p := range []string{"PRAGMA foreign_keys = OFF", "PRAGMA legacy_alter_table = ON", "BEGIN IMMEDIATE"} {
		if _, err := conn.ExecContext(ctx, p); err != nil {
			return err
		}
	}
	abandon := func() {
		if _, err := conn.ExecContext(ctx, "ROLLBACK"); err != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}
	q := pinned{conn, ctx}
	if err := fn(q); err != nil {
		abandon()
		return err
	}
	rows, err := q.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		abandon()
		return err
	}
	var dangling []string
	for rows.Next() {
		var table, parent string
		var rowid sql.NullInt64
		var fk int
		if err := rows.Scan(&table, &rowid, &parent, &fk); err != nil {
			rows.Close()
			abandon()
			return err
		}
		dangling = append(dangling, fmt.Sprintf("%s row %d names a %s that is not there", table, rowid.Int64, parent))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		abandon()
		return err
	}
	if len(dangling) > 0 {
		abandon()
		return fmt.Errorf("the rebuilt tables do not hold together: %v", dangling)
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		abandon()
		return err
	}
	return nil
}

// pinned adapts a pinned connection to the statement methods a transaction
// has, for code shared with *sql.Tx.
type pinned struct {
	c   *sql.Conn
	ctx context.Context
}

func (p pinned) QueryRow(q string, args ...any) *sql.Row {
	return p.c.QueryRowContext(p.ctx, q, args...)
}

func (p pinned) Query(q string, args ...any) (*sql.Rows, error) {
	return p.c.QueryContext(p.ctx, q, args...)
}

func (p pinned) Exec(q string, args ...any) (sql.Result, error) {
	return p.c.ExecContext(p.ctx, q, args...)
}

// Identity is what this store says about itself, as read when it was opened.
func (s *Store) Identity() Identity { return s.identity }

// Epoch is this store's epoch, which `ready` carries: the uid sequence a
// device's cursor belongs to.
func (s *Store) Epoch() string { return s.identity.Epoch }

// renewEpoch gives this store a new epoch. Only a backup snapshot is given
// one, in its staging copy, before it is published; see Backup.
func (s *Store) renewEpoch() error {
	epoch, err := newEpoch()
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	res, err := s.db.Exec(`UPDATE store_identity SET epoch = ? WHERE id = 1`, epoch)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		return fmt.Errorf("the identity row was not updated (%d rows, %v)", n, err)
	}
	s.identity.Epoch = epoch
	return nil
}

// nowMillis is the server's clock in milliseconds, for the identity row.
func nowMillis() int64 { return time.Now().UnixMilli() }
