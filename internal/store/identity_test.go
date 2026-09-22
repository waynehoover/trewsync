package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/waynehoover/telimus/internal/chunks"
)

// treeDigest is every file and directory under dir with its contents' hash
// and its mode, one per line, sorted: two calls that return the same string
// saw the same bytes in the same files.
func treeDigest(t *testing.T, dir string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		info, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			lines = append(lines, fmt.Sprintf("dir  %s %v", rel, info.Mode()))
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		lines = append(lines, fmt.Sprintf("file %s %v %s", rel, info.Mode(), hex.EncodeToString(sum[:8])))
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", dir, err)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// basaltSchema is Basalt 0.10.0's schema, from basalt:server/internal/store/
// store.go at 664a963, comments removed.
const basaltSchema = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS vaults (
  vault_id   TEXT    PRIMARY KEY,
  next_uid   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  auth_hash  TEXT    NOT NULL DEFAULT '',
  wrapped    TEXT    NOT NULL DEFAULT '',
  rotations  INTEGER NOT NULL DEFAULT 0,
  purges     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS devices (
  vault_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  auth_hash  TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, device_id)
);
CREATE TABLE IF NOT EXISTS invites (
  vault_id   TEXT    NOT NULL,
  invite     TEXT    NOT NULL,
  sealed     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, invite)
);
CREATE TABLE IF NOT EXISTS entries (
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
  mac       TEXT    NOT NULL DEFAULT '',
  parent    TEXT    NOT NULL DEFAULT '',
  n_chunks  INTEGER NOT NULL DEFAULT -1,
  PRIMARY KEY (vault_id, uid)
);
CREATE TABLE IF NOT EXISTS entry_chunks (
  vault_id TEXT    NOT NULL,
  uid      INTEGER NOT NULL,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (vault_id, uid, ord),
  FOREIGN KEY (vault_id, uid) REFERENCES entries(vault_id, uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS entries_by_path ON entries(vault_id, path, uid DESC);
CREATE INDEX IF NOT EXISTS entry_chunks_by_name ON entry_chunks(vault_id, name);
CREATE INDEX IF NOT EXISTS entries_by_prev ON entries(vault_id, prev_path, uid);
PRAGMA user_version = 1;
`

// writeBasaltDirectory builds what a stopped Basalt server leaves: its
// database under the given name, a chunk body in the tree the two products
// both call chunks, both lock files (one naming its last holder, as a crash
// leaves it), and the bootstrap token. The database is closed cleanly, so no
// log is left beside it, unless hot is set, in which case the directory is
// copied while a connection still has uncheckpointed rows in the log: a Basalt
// server that crashed.
func writeBasaltDirectory(t *testing.T, dir, dbName string, hot bool) {
	t.Helper()
	build := dir
	if hot {
		build = t.TempDir()
	}
	dbPath := filepath.Join(build, dbName)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(basaltSchema); err != nil {
		t.Fatalf("basalt schema: %v", err)
	}
	body := []byte("ciphertext of somebody's note")
	name := chunks.Name(body)
	if _, err := db.Exec(`INSERT INTO vaults (vault_id, next_uid, created_at, auth_hash, wrapped)
	                      VALUES ('default', 2, 1000, ?, 'AAAA')`, strings.Repeat("ab", 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO entries (vault_id, uid, path, size, mac, n_chunks)
	                      VALUES ('default', 1, 'c2VhbGVk', 20, ?, 1)`, strings.Repeat("cd", 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO entry_chunks VALUES ('default', 1, 0, ?)`, name); err != nil {
		t.Fatal(err)
	}
	if hot {
		// Checkpointed once, so the tables are in the main file, and then
		// written again, so the log has rows the main file does not.
		if _, err := db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO entries (vault_id, uid, path, size, mac, n_chunks)
		                      VALUES ('default', 2, 'bW9yZQ', 0, ?, 0)`, strings.Repeat("ef", 32)); err != nil {
			t.Fatal(err)
		}
		for _, suffix := range []string{"", "-wal", "-shm"} {
			b, err := os.ReadFile(dbPath + suffix)
			if err != nil {
				t.Fatalf("copying the crashed database: %v", err)
			}
			if err := os.WriteFile(filepath.Join(dir, dbName+suffix), b, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	cs, err := chunks.New(filepath.Join(dir, "chunks"), ChunkMax)
	if err != nil {
		t.Fatal(err)
	}
	if err := cs.Put("default", name, body); err != nil {
		t.Fatal(err)
	}
	for file, content := range map[string]string{
		"server.lock": "serve pid 4242\n",
		"data.lock":   "",
		"auth-token":  "ABCDEFGH-IJKLMNOPQRSTUVWXYZ012345\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// refusedUnchanged opens dir in every mode and requires each one to be refused
// as want, with every byte and every file in the directory as it was.
func refusedUnchanged(t *testing.T, dir string, want error) {
	t.Helper()
	before := treeDigest(t, dir)
	if err := CheckDataDir(dir); !errors.Is(err, want) {
		t.Fatalf("CheckDataDir: %v, want %v", err, want)
	}
	if after := treeDigest(t, dir); after != before {
		t.Fatalf("checking the directory changed it:\nbefore\n%s\nafter\n%s", before, after)
	}
	dbPath, chunkDir := DataDir(dir)
	for _, mode := range []Mode{Create, Existing, ReadOnly} {
		st, err := OpenMode(dbPath, chunkDir, mode, SyncFull)
		if err == nil {
			st.Close()
			t.Fatalf("mode %d: opened a directory that should have been refused", mode)
		}
		if !errors.Is(err, want) {
			t.Fatalf("mode %d: refused with %v, want %v", mode, err, want)
		}
		// Named, so the person reading it knows it was left alone.
		if !strings.Contains(err.Error(), "changed") {
			t.Errorf("mode %d: the refusal does not say whether anything was changed: %v", mode, err)
		}
		if after := treeDigest(t, dir); after != before {
			t.Fatalf("mode %d: the refusal changed the directory:\nbefore\n%s\nafter\n%s", mode, before, after)
		}
	}
}

// A Basalt data directory is refused, every byte of it left as it was: the
// database, the chunk tree whose name the two products share, the lock files
// whose names they share, and the bootstrap token.
//
// The one that matters most is Create, which is `serve`. Before this, `serve`
// pointed at a Basalt directory found no telimus.db, made one, and adopted
// Basalt's chunk tree: every body in it unreferenced by the new store, so the
// first purge afterwards would have deleted all of them.
func TestABasaltDirectoryIsRefusedAndLeftByteIdentical(t *testing.T) {
	dir := t.TempDir()
	writeBasaltDirectory(t, dir, basaltDatabase, false)
	refusedUnchanged(t, dir, ErrForeignStore)
	if _, err := os.Stat(filepath.Join(dir, dbFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a %s was created in a Basalt directory: %v", dbFileName, err)
	}
}

// Basalt's database renamed to this product's name is still Basalt's, and so
// is the same database left by a crash with rows only in its log. The log is
// the case a normal open would have changed: closing it checkpoints the log
// into the main file, measured against this driver before the probe became an
// immutable read.
func TestABasaltDatabaseUnderThisNameIsRefusedAndLeftByteIdentical(t *testing.T) {
	for _, hot := range []bool{false, true} {
		t.Run(fmt.Sprintf("hot=%v", hot), func(t *testing.T) {
			dir := t.TempDir()
			writeBasaltDirectory(t, dir, dbFileName, hot)
			if hot {
				if info, err := os.Stat(filepath.Join(dir, dbFileName+"-wal")); err != nil || info.Size() == 0 {
					t.Fatalf("the fixture has no log to leave alone: %v", err)
				}
			}
			refusedUnchanged(t, dir, ErrForeignStore)
		})
	}
}

// A store naming another product, and one from a newer schema, are refused
// the same way, before anything is written.
func TestAnotherProductOrANewerSchemaIsRefusedAndLeftByteIdentical(t *testing.T) {
	for _, c := range []struct {
		name, statement string
		want            error
		mentions        []string
	}{
		{"another product", `UPDATE store_identity SET product = 'lyell'`, ErrForeignStore, []string{"lyell"}},
		{"a newer schema", fmt.Sprintf(`UPDATE store_identity SET schema_version = %d`, SchemaVersion+1),
			ErrFutureSchema, []string{fmt.Sprint(SchemaVersion + 1), "newer " + Product}},
		{"no epoch", `UPDATE store_identity SET epoch = ''`, ErrForeignStore, []string{"epoch"}},
		{"no identity row", `DELETE FROM store_identity`, ErrForeignStore, []string{"0 identity rows"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			dbPath, chunkDir := DataDir(dir)
			st, err := Open(dbPath, chunkDir)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := st.db.Exec(c.statement); err != nil {
				t.Fatal(err)
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			refusedUnchanged(t, dir, c.want)
			_, err = Open(dbPath, chunkDir)
			for _, word := range c.mentions {
				if err == nil || !strings.Contains(err.Error(), word) {
					t.Errorf("the refusal does not mention %q: %v", word, err)
				}
			}
		})
	}
}

// A chunk tree with bodies in it and no database beside it is not a place to
// start a store: the store would adopt bodies it knows nothing about, and the
// first purge would delete them.
func TestAChunkTreeWithNoDatabaseIsRefused(t *testing.T) {
	dir := t.TempDir()
	cs, err := chunks.New(filepath.Join(dir, "chunks"), ChunkMax)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("a body whose database is gone")
	if err := cs.Put("default", chunks.Name(body), body); err != nil {
		t.Fatal(err)
	}
	refusedUnchanged(t, dir, ErrForeignStore)
}

// Directories with nothing in them are not bodies. A server killed after it
// made its chunk tree and before its database leaves exactly this, and the
// next start is its first real one.
func TestAnEmptyChunkTreeIsNoReasonToRefuse(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "chunks", "abcd", "ef"), 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := Open(DataDir(dir))
	if err != nil {
		t.Fatalf("an empty chunk tree was refused: %v", err)
	}
	st.Close()
}

// Something that is not SQLite at all, under the database's name, is refused
// rather than overwritten or reported as corrupt data of ours.
func TestAFileThatIsNotADatabaseIsRefused(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, dbFileName), []byte(strings.Repeat("not sqlite ", 50)), 0o600); err != nil {
		t.Fatal(err)
	}
	refusedUnchanged(t, dir, ErrForeignStore)
}

// A new store records what it is before it holds anything, and keeps it: the
// same epoch on every open, and a different one in every other store.
func TestANewStoreRecordsItsIdentityAndKeepsIt(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(DataDir(dir))
	if err != nil {
		t.Fatal(err)
	}
	id := st.Identity()
	st.Close()
	if id.Product != Product || id.SchemaVersion != SchemaVersion || id.Epoch == "" || id.CreatedAt <= 0 {
		t.Fatalf("a new store says %+v", id)
	}
	for _, mode := range []Mode{Create, Existing, ReadOnly} {
		dbPath, chunkDir := DataDir(dir)
		again, err := OpenMode(dbPath, chunkDir, mode, SyncFull)
		if err != nil {
			t.Fatalf("mode %d: %v", mode, err)
		}
		if got := again.Identity(); got != id {
			t.Fatalf("mode %d: reopening says %+v, it was created as %+v", mode, got, id)
		}
		again.Close()
	}
	other, err := Open(DataDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if other.Epoch() == id.Epoch {
		t.Fatalf("two stores share the epoch %q", id.Epoch)
	}
}

// A store whose creation is still only in its log, because the server died
// before the first checkpoint, is still this product's and still opens. The
// immutable probe sees an empty main file, and the log is read to find out.
func TestAStoreWhoseCreationIsOnlyInItsLogStillOpens(t *testing.T) {
	src := t.TempDir()
	st, err := Open(DataDir(src))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureVault("v1", 1000); err != nil {
		t.Fatal(err)
	}
	want := st.Identity()
	dir := t.TempDir()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		b, err := os.ReadFile(filepath.Join(src, dbFileName+suffix))
		if err != nil {
			t.Fatalf("copying the live store: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, dbFileName+suffix), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	st.Close()
	if info, err := os.Stat(filepath.Join(dir, dbFileName+"-wal")); err != nil || info.Size() == 0 {
		t.Fatalf("the copy has no log, so this proves nothing: %v", err)
	}
	if _, _, err := readIdentityWith(filepath.Join(dir, dbFileName), "mode=ro&immutable=1"); err != nil {
		t.Fatalf("the immutable probe failed outright: %v", err)
	}
	got, err := Open(DataDir(dir))
	if err != nil {
		t.Fatalf("a store whose creation is in its log was refused: %v", err)
	}
	defer got.Close()
	if got.Identity() != want {
		t.Fatalf("it opened as %+v, it was created as %+v", got.Identity(), want)
	}
}

// Checking a directory that is not there creates nothing: it is what every
// command runs before its lock, and a typo in -data must stay a typo.
func TestCheckingADirectoryCreatesNothing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "typo")
	if err := CheckDataDir(missing); err != nil {
		t.Fatalf("a directory that is not there was refused: %v", err)
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("checking it created it: %v", err)
	}
}

// Every connection the pool opens keeps statement journals in memory, not the
// one that happened to run the schema.
//
// Checked to fail before the pragma moved into the connection string: the
// first connection said 2 and the other three said 0, which is a temp
// directory, which the shipped image does not have (see dsn).
func TestEveryConnectionKeepsItsTempStoreInMemory(t *testing.T) {
	st, err := Open(DataDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	var conns []*sql.Conn
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	for i := 0; i < 4; i++ {
		c, err := st.db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
		var mode int
		if err := c.QueryRowContext(ctx, `PRAGMA temp_store`).Scan(&mode); err != nil {
			t.Fatal(err)
		}
		if mode != 2 {
			t.Fatalf("connection %d has temp_store %d, want 2 (MEMORY)", i, mode)
		}
	}
}

// A backup's database has an epoch of its own, and taking one leaves the
// source's alone: serving the backup is a restore, and a device that followed
// the source past the snapshot is told so by the epoch changing.
func TestABackupHasAnEpochOfItsOwn(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	before := h.Epoch()
	dest := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dest, false); err != nil {
		t.Fatalf("backup: %v", err)
	}
	if h.Epoch() != before {
		t.Fatalf("taking a backup changed the source's epoch from %q to %q", before, h.Epoch())
	}
	restored := openAt(t, dest)
	if restored.Epoch() == before {
		t.Fatalf("the backup has the source's epoch %q", before)
	}
	if restored.Identity().Product != Product {
		t.Fatalf("the backup says %+v", restored.Identity())
	}
	// And the backup's coverage still describes the database beside it: the
	// epoch was renewed before the digest was taken.
	if _, err := ReadBackupMeta(dest); err != nil {
		t.Fatalf("backup.json does not describe the database it is beside: %v", err)
	}
}
