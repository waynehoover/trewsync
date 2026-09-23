package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/store"
)

// A Basalt data directory, as a stopped Basalt server leaves one: its
// database, a body in the chunk tree whose name the two products share, both
// lock files under the names they share (the server lock still naming its last
// holder, as a crash leaves it), and the bootstrap token.
func basaltDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "basalt.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`PRAGMA journal_mode = WAL`,
		`CREATE TABLE vaults (vault_id TEXT PRIMARY KEY, next_uid INTEGER NOT NULL DEFAULT 1,
		   created_at INTEGER NOT NULL, auth_hash TEXT NOT NULL DEFAULT '', wrapped TEXT NOT NULL DEFAULT '')`,
		`CREATE TABLE entries (vault_id TEXT NOT NULL, uid INTEGER NOT NULL, path TEXT NOT NULL,
		   mac TEXT NOT NULL DEFAULT '', PRIMARY KEY (vault_id, uid))`,
		`CREATE TABLE entry_chunks (vault_id TEXT NOT NULL, uid INTEGER NOT NULL, ord INTEGER NOT NULL,
		   name TEXT NOT NULL, PRIMARY KEY (vault_id, uid, ord))`,
		`INSERT INTO vaults (vault_id, created_at, auth_hash) VALUES ('default', 1000, 'abab')`,
		`PRAGMA user_version = 1`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	cs, err := chunks.New(filepath.Join(dir, "chunks"), store.ChunkMax)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("ciphertext nobody here can read")
	if err := cs.Put("default", chunks.Name(body), body); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"server.lock": "serve pid 4242\n",
		"data.lock":   "",
		"auth-token":  "ABCDEFGH-IJKLMNOPQRSTUVWXYZ012345\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// dirDigest is every file under dir with a hash of its bytes, and every
// directory, sorted, so two calls are equal exactly when nothing changed.
func dirDigest(t *testing.T, dir string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if d.IsDir() {
			lines = append(lines, "dir "+rel)
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		lines = append(lines, "file "+rel+" "+hex.EncodeToString(sum[:8]))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// `serve` pointed at a Basalt directory refuses before it takes a lock, so
// the directory is byte for byte what Basalt left, lock files included.
//
// Taking the lock first would have been enough to change it: the server lock
// is truncated and rewritten by whoever takes it exclusively, and the data
// directory's lock files are the same two names in both products.
func TestServeRefusesABasaltDirectoryAndChangesNothing(t *testing.T) {
	dir := basaltDataDir(t)
	before := dirDigest(t, dir)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out safeBuffer
	err := run(ctx, []string{"serve", "-data", dir, "-addr", "127.0.0.1:0"}, &out)
	if !errors.Is(err, store.ErrForeignStore) {
		t.Fatalf("serve on a Basalt directory returned %v, want ErrForeignStore\n%s", err, out.String())
	}
	if !strings.Contains(err.Error(), "Basalt") {
		t.Errorf("the refusal does not say whose directory it is: %v", err)
	}
	if after := dirDigest(t, dir); after != before {
		t.Fatalf("the refusal changed the directory:\nbefore\n%s\nafter\n%s", before, after)
	}
}

// And every other command refuses it the same way: none of them creates a
// store, and none of them takes a lock on a directory that is not theirs.
func TestEveryCommandRefusesABasaltDirectoryAndChangesNothing(t *testing.T) {
	dir := basaltDataDir(t)
	// The same database under this product's name, which is the case that
	// gets past "there is no trew data directory here".
	b, err := os.ReadFile(filepath.Join(dir, "basalt.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "trew.db"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	before := dirDigest(t, dir)
	for _, args := range [][]string{
		{"verify", "-data", dir},
		{"verify", "-deep", "-data", dir},
		{"stats", "-data", dir},
		{"backup", "-data", dir, "-to", filepath.Join(t.TempDir(), "backup")},
		{"purge", "-data", dir, "-vault", "default", "-confirm", "default", "-no-backup-check"},
		{"service", "-data", dir},
	} {
		_, err := trew(t, args...)
		if !errors.Is(err, store.ErrForeignStore) {
			t.Errorf("trew %s: %v, want ErrForeignStore", strings.Join(args, " "), err)
		}
		if after := dirDigest(t, dir); after != before {
			t.Fatalf("trew %s changed the directory:\nbefore\n%s\nafter\n%s",
				strings.Join(args, " "), before, after)
		}
	}
}

// A backup is not written into a Basalt directory either: a snapshot
// published beside Basalt's database would adopt its chunk tree, and purging
// the result would sweep every Basalt body as unreferenced.
func TestABackupIsNotWrittenIntoABasaltDirectory(t *testing.T) {
	source := seeded(t)
	dest := basaltDataDir(t)
	before := dirDigest(t, dest)
	_, err := trew(t, "backup", "-data", source, "-to", dest)
	if !errors.Is(err, store.ErrForeignStore) {
		t.Fatalf("a backup into a Basalt directory returned %v", err)
	}
	if after := dirDigest(t, dest); after != before {
		t.Fatalf("the refused backup changed the destination:\nbefore\n%s\nafter\n%s", before, after)
	}
}
