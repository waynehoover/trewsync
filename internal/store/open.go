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
	// the schema, and SQLite itself refuses writes through the handle. A store
	// older than this build is refused rather than read wrongly (T28).
	ReadOnly
	// Source opens a store a backup is taken from, beside a server that may
	// be running on it: it must already be there and at this build's schema,
	// and it is neither migrated nor given the schema (T37). The handle can
	// write, because SQLite refuses `VACUUM INTO` on a read-only one, and
	// nothing the backup asks of it writes to the store.
	Source
)

// ErrOlderSchema is a store at a schema older than this build's, opened by a
// command that may not upgrade it. OlderSchemaError carries which.
var ErrOlderSchema = errors.New("this store is at a schema older than this " + Program + "'s")

// OlderSchemaError is the refusal of a store older than this build, by a
// command that may not upgrade it: what the store is, why this command leaves
// it alone, and what does upgrade it. It is ErrOlderSchema.
//
// Two commands meet one. A backup's source (T37): the server running on it is
// the older build, which `trewd update` leaves running until it restarts, so
// the nightly backup is the first to meet it. And inspection (T28), which
// never migrates and used to open such a store anyway: every check that reads
// a table the older schema lacks then failed with an SQL error, `no such
// table: operations`, in place of an answer.
type OlderSchemaError struct {
	Path   string
	Schema int
	mode   Mode
}

func (e *OlderSchemaError) Unwrap() error { return ErrOlderSchema }

func (e *OlderSchemaError) Error() string {
	why := "Opened only to be looked at it is not upgraded, and this build would read tables it does not have " +
		"yet. A store a server runs on: restart the server with this build (systemctl restart trew), which " +
		"upgrades it when it opens it. A backup directory: copy it to a new directory and start this build's " +
		"`trewd serve` there once, or `trewd unpack` an archive, which upgrades what it unpacks"
	if e.mode == Source {
		why = "A server running on it is the older build, and a backup that upgraded the store under it would " +
			"leave that build refusing its own store, and the rollback to it too. Restart the server with this " +
			"build (systemctl restart trew), which upgrades the store when it opens it, and run this again"
	}
	return fmt.Sprintf("%v: %s is schema %d and this %s works with %d. %s; nothing was changed",
		ErrOlderSchema, e.Path, e.Schema, Program, SchemaVersion, why)
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
	if (mode == Source || mode == ReadOnly) && id.SchemaVersion < SchemaVersion {
		db.Close()
		return nil, &OlderSchemaError{Path: dbPath, Schema: id.SchemaVersion, mode: mode}
	}

	if mode != ReadOnly && mode != Source {
		legacy := false
		if empty {
			id, err = initialise(db, dbPath)
		} else if legacy, err = snapshotFromBeforeTheMark(db, dbPath); err == nil {
			id, err = migrate(db, dbPath, id)
		}
		if err == nil && legacy {
			// The mark it would have had, for GoLive (T27).
			_, err = db.Exec(`INSERT OR IGNORE INTO snapshot (id, served) VALUES (1, 0)`)
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

// Live is what GoLive did to a store about to be served.
type Live struct {
	// Journal is the journal mode the store is in now, "wal" unless the
	// switch could not be made, and JournalErr why it could not.
	Journal    string
	JournalErr error
	// Renewed says the store was a backup's snapshot no server had served,
	// and is now served under an epoch of its own; Was is the epoch the
	// snapshot carried.
	Renewed bool
	Was     string
}

// snapshotSchema records whether this database is a backup's snapshot that no
// server has taken up yet (T27). Backup writes the row into its snapshot with
// served 0, and the first serve sets it to 1 as it gives the store an epoch of
// its own. A store that was never a snapshot has no row.
//
// A table rather than a schema version: a build that does not know it serves
// the snapshot under the epoch the backup gave it, which is what every build
// before it did, and refusing the store would make a rollback refuse every
// backup taken since.
const snapshotSchema = `
CREATE TABLE IF NOT EXISTS snapshot (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  served INTEGER NOT NULL CHECK (served IN (0, 1))
);
`

// GoLive readies a store `serve` is about to serve, before anything reads it.
//
// WAL mode (T26). Only a store created empty was ever put in it: a backup's
// database is what `VACUUM INTO` writes, a rollback-journal file, so every
// restored store, unpacked, copied back or served where the backup put it,
// ran in rollback-journal mode. There a reader holding a read transaction
// blocks every commit, and one held past the busy timeout fails it, and the
// readers are exactly the commands that run beside a server: a backup's
// snapshot, a verify walking every reference, doctor. Measured on a restored
// store: a device's commit under a six-second reader failed with `database is
// locked` after 5.1 s where the original committed in 0.3 ms, and an agent's
// operation was answered "unknown" when it had not committed. `immediate`'s
// reasoning about busy waits assumes WAL too.
//
// The mode is a property of the file, so it is set once and stays, and
// setting it again does nothing. Not in Open: Backup opens its staged snapshot
// with Open, writes the new epoch into it and publishes the file by renaming
// it, and in WAL mode those writes would sit in a log beside the staged name
// that the rename leaves behind. A switch that cannot be made, because a
// reader in another process held on past the busy timeout, leaves the mode as
// it was and is returned in Live for the caller to say: the store serves
// correctly in either mode, only more slowly beside a long reader.
//
// An epoch of its own, for a backup's snapshot served for the first time
// (T27). A backup used to give its snapshot a new epoch once, when it was
// taken, and a restore copies the database byte for byte, so the same archive
// restored twice, a second attempt or a disk that died before the next backup,
// served one epoch twice. A device whose cursor had followed the first restore
// past the snapshot was then, once other devices had written past that cursor,
// served from it without an error: reproduced, a laptop at uid 11 of the first
// restore was given only uid 12 of the second, never 7 to 11, and never sent
// back the notes it had written into the first. So a snapshot starts an epoch
// of its own at the moment it becomes a live store, here, every time, wherever
// it was unpacked or copied to; a restart of that store keeps it. Fatal when it
// cannot be done, since serving the snapshot's epoch is the fault.
func (s *Store) GoLive() (Live, error) {
	var live Live
	unserved, err := s.unservedSnapshot()
	if err != nil {
		return live, err
	}
	if err := s.db.QueryRow(`PRAGMA journal_mode = WAL`).Scan(&live.Journal); err != nil {
		live.JournalErr = err
		if qerr := s.db.QueryRow(`PRAGMA journal_mode`).Scan(&live.Journal); qerr != nil {
			return live, qerr
		}
	} else if live.Journal != "wal" {
		live.JournalErr = fmt.Errorf("SQLite left the store in %s mode", live.Journal)
	}
	if unserved {
		live.Was = s.identity.Epoch
		if err := s.claimSnapshot(); err != nil {
			return live, fmt.Errorf("giving the restored snapshot an epoch of its own: %w", err)
		}
		live.Renewed = true
	}
	return live, nil
}

// unservedSnapshot reports whether this store is a backup's snapshot no server
// has served yet, by its mark (snapshotSchema).
func (s *Store) unservedSnapshot() (bool, error) {
	var served int
	err := s.db.QueryRow(`SELECT served FROM snapshot WHERE id = 1`).Scan(&served)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil && served == 0, err
}

// snapshotFromBeforeTheMark reports whether the database at dbPath is a
// backup's snapshot a build from before the mark took (T27), never written to
// since: it has no snapshot table, and the backup.json beside it still
// describes it byte for byte, which stops being true at its first write.
//
// Asked before migrate, which adds the table and so changes the very file the
// description is of; OpenMode then marks it, so the first serve, whenever it
// comes, gives it an epoch of its own like any other snapshot. Only of a
// database at its data-directory name: backup.json describes that file, and
// Backup's staging copy, under another name, is marked by Backup itself.
func snapshotFromBeforeTheMark(q querier, dbPath string) (bool, error) {
	dir := filepath.Dir(dbPath)
	if filepath.Base(dbPath) != dbFileName {
		return false, nil
	}
	var tables int
	if err := q.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'snapshot'`).
		Scan(&tables); err != nil {
		return false, err
	}
	if tables > 0 {
		return false, nil
	}
	_, err := ReadBackupMeta(dir)
	return err == nil, nil
}

// claimSnapshot gives a snapshot being served for the first time a new epoch
// and marks it served, in one transaction, so a crash leaves it a snapshot
// still to be claimed or a live store under its own epoch, never a live store
// under the snapshot's.
func (s *Store) claimSnapshot() error {
	epoch, err := newEpoch()
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := immediate(s.db, func(q execer) error {
		res, err := q.Exec(`UPDATE store_identity SET epoch = ? WHERE id = 1`, epoch)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			return fmt.Errorf("the identity row was not updated (%d rows, %v)", n, err)
		}
		_, err = q.Exec(`INSERT INTO snapshot (id, served) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET served = 1`)
		return err
	}); err != nil {
		return err
	}
	s.identity.Epoch = epoch
	return nil
}

// markSnapshot marks this store as a backup's snapshot no server has served,
// for the first serve to give it an epoch of its own (T27). Only Backup calls
// it, on its staging copy.
func (s *Store) markSnapshot() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.Exec(`INSERT INTO snapshot (id, served) VALUES (1, 0) ON CONFLICT(id) DO UPDATE SET served = 0`)
	return err
}

// Identity is what this store says about itself, as read when it was opened.
func (s *Store) Identity() Identity { return s.identity }

// Epoch is this store's epoch, which `ready` carries: the uid sequence a
// device's cursor belongs to.
func (s *Store) Epoch() string { return s.identity.Epoch }

// renewEpoch gives this store a new epoch. Only a backup snapshot is given
// one here, in its staging copy, before it is published; see Backup. It is
// given another each time it is first served, wherever it was restored to
// (GoLive, T27).
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
