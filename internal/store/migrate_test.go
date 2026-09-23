package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
)

/* ---------------------------------------------------------------- *
 * A database written by an older build
 * ---------------------------------------------------------------- */

// oldSchema is a database in the shape a build before protocol 1 left: Basalt's
// tables, from before the columns Basalt later added, and no store identity.
//
// Basalt's migrations added those columns in place, and two tests held them
// to losing nothing (strip ledger, `migrate_test.go:107` and `:268`, both
// obsolete with the fresh schema of PLAN.md section 3.3). What replaces them is
// the refusal: a database this build did not write is not adopted and not
// migrated, and it is left byte for byte as it was, which
// TestADatabaseFromAnOlderBuildIsRefusedAndLeftAsItWas holds.
const oldSchema = `
CREATE TABLE vaults (
  vault_id   TEXT    PRIMARY KEY,
  next_uid   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE entries (
  vault_id  TEXT    NOT NULL,
  uid       INTEGER NOT NULL,
  path      TEXT    NOT NULL,
  size      INTEGER NOT NULL DEFAULT 0,
  ctime     INTEGER NOT NULL DEFAULT 0,
  mtime     INTEGER NOT NULL DEFAULT 0,
  folder    INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  device    TEXT    NOT NULL DEFAULT '',
  prev_path TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (vault_id, uid)
);

CREATE TABLE entry_chunks (
  vault_id TEXT    NOT NULL,
  uid      INTEGER NOT NULL,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (vault_id, uid, ord),
  FOREIGN KEY (vault_id, uid) REFERENCES entries(vault_id, uid) ON DELETE CASCADE
);

CREATE INDEX entries_by_path ON entries(vault_id, path, uid DESC);
CREATE INDEX entry_chunks_by_name ON entry_chunks(vault_id, name);
`

// writeOldDatabase makes a database in the shape an older build left, with a
// vault, three versions of one note, a folder, a deletion and a rename in it,
// so a refusal has something to leave alone.
func writeOldDatabase(t *testing.T, dbPath string) {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(oldSchema); err != nil {
		t.Fatalf("old schema: %v", err)
	}
	if _, err := db.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatalf("stamping Basalt's schema version: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO vaults (vault_id, next_uid, created_at) VALUES ('v1', 7, 1000)`); err != nil {
		t.Fatalf("insert vault: %v", err)
	}
	rows := []struct {
		uid                    int64
		path                   string
		size                   int64
		folder, deleted        int
		device, prevPath, body string
	}{
		{1, "sealed-note", 11, 0, 0, "old-device", "", "version one"},
		{2, "sealed-note", 11, 0, 0, "old-device", "", "version two"},
		{3, "sealed-note", 13, 0, 0, "old-device", "", "version three"},
		{4, "sealed-folder", 0, 1, 0, "old-device", "", ""},
		{5, "sealed-gone", 0, 0, 1, "old-device", "", ""},
		{6, "sealed-new-name", 5, 0, 0, "old-device", "sealed-old-name", "moved"},
	}
	for _, r := range rows {
		if _, err := db.Exec(
			`INSERT INTO entries (vault_id, uid, path, size, ctime, mtime, folder, deleted, device, prev_path)
			 VALUES ('v1', ?, ?, ?, 0, 10, ?, ?, ?, ?)`,
			r.uid, r.path, r.size, r.folder, r.deleted, r.device, r.prevPath); err != nil {
			t.Fatalf("insert entry %d: %v", r.uid, err)
		}
		if r.body != "" {
			if _, err := db.Exec(
				`INSERT INTO entry_chunks (vault_id, uid, ord, name) VALUES ('v1', ?, 0, ?)`,
				r.uid, chunks.Name([]byte(r.body))); err != nil {
				t.Fatalf("insert chunk ref %d: %v", r.uid, err)
			}
		}
	}
}

// A database from a build before protocol 1 is refused in every mode, and the
// directory holding it is exactly as it was afterwards.
//
// Its schema version is 1, which is this build's too: the collision PLAN.md
// section 2.8 names. Before the identity row, this build would have found a
// version it accepts, migrated the tables in place and served another
// product's history under protocol 1.
func TestADatabaseFromAnOlderBuildIsRefusedAndLeftAsItWas(t *testing.T) {
	dir := t.TempDir()
	dbPath, chunkDir := DataDir(dir)
	writeOldDatabase(t, dbPath)
	before := treeDigest(t, dir)

	for _, mode := range []Mode{Create, Existing, ReadOnly} {
		st, err := OpenMode(dbPath, chunkDir, mode, SyncFull)
		if err == nil {
			st.Close()
			t.Fatalf("mode %d: a database from an older build was opened", mode)
		}
		if !errors.Is(err, ErrForeignStore) {
			t.Fatalf("mode %d: refused, but not as a foreign store: %v", mode, err)
		}
		if after := treeDigest(t, dir); after != before {
			t.Fatalf("mode %d: the refusal changed the directory:\nbefore\n%s\nafter\n%s", mode, before, after)
		}
	}
}

// Idempotent, because it runs on every open. The second pass must find every
// table already there and change nothing: a step that ran twice would fail the
// open, and a server that starts once and not again is worse than one that
// never started. The identity, epoch included, is untouched by it too.
func TestMigratingTwiceChangesNothing(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "trew.db")

	first, err := Open(dbPath, filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if err := first.EnsureVault("v1", 1000); err != nil {
		t.Fatal(err)
	}
	h := &harness{Store: first, dir: dir}
	h.file(t, "note.md", "one version")
	before := schemaOf(t, first.db)
	identity := first.Identity()
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	for pass := 0; pass < 2; pass++ {
		again, err := Open(dbPath, filepath.Join(dir, "chunks"))
		if err != nil {
			t.Fatalf("reopen %d of a current database: %v", pass, err)
		}
		if after := schemaOf(t, again.db); after != before {
			again.Close()
			t.Fatalf("reopening changed the schema:\nfirst:\n%s\nlater:\n%s", before, after)
		}
		if got := again.Identity(); got != identity {
			again.Close()
			t.Fatalf("reopening changed the identity from %+v to %+v", identity, got)
		}
		st, err := again.Stats("v1")
		if err != nil || st.Versions != 1 {
			again.Close()
			t.Fatalf("stats after reopening: %+v %v", st, err)
		}
		again.Close()
	}
}

// Every schema version this build knows how to leave has a step, and the steps
// end at this build's version: a version bumped without its migration is a
// store that stops opening on upgrade.
func TestEveryOlderSchemaHasAStep(t *testing.T) {
	for v := 1; v < SchemaVersion; v++ {
		if migrations[v] == nil {
			t.Errorf("no migration from schema %d", v)
		}
	}
	for v := range migrations {
		if v < 1 || v >= SchemaVersion {
			t.Errorf("a migration from schema %d, which is not before this build's %d", v, SchemaVersion)
		}
	}
}

// schemaOf is every table and index definition, in a stable order, so two
// opens can be compared as strings.
func schemaOf(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.Query(
		`SELECT type, name, IFNULL(sql, '') FROM sqlite_master ORDER BY type, name`)
	if err != nil {
		t.Fatalf("reading the schema: %v", err)
	}
	defer rows.Close()
	var out string
	for rows.Next() {
		var typ, name, def string
		if err := rows.Scan(&typ, &name, &def); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out += typ + " " + name + ": " + def + "\n"
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}
