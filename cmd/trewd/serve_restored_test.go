package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/waynehoover/trewsync/internal/store"
)

// journalMode is the journal mode the database in dir records, read by a
// connection of its own.
func journalMode(t *testing.T, dir string) string {
	t.Helper()
	dbPath, _ := store.DataDir(dir)
	var mode string
	onDisk(t, dbPath, func(db *sql.DB) {
		if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
			t.Fatal(err)
		}
	})
	return mode
}

// T26. A backup's database is what `VACUUM INTO` writes, a rollback-journal
// file, and only a store created empty was ever put in WAL mode, so every
// restored store was served in rollback-journal mode. There a reader holding a
// read transaction, a backup's snapshot or a verify, blocks the server's
// commits, and one held past the busy timeout fails them: `database is
// locked` after five seconds, where the original store committed in 0.3 ms,
// and an agent told its operation's outcome was unknown when it had not
// committed. Serving a store now puts it in WAL mode, as a new one is.
func TestARestoredStoreIsServedInWALMode(t *testing.T) {
	source := seeded(t)
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", backup)
	restored := filepath.Join(t.TempDir(), "restored")
	copyTree(t, backup, restored)
	if mode := journalMode(t, restored); mode != "delete" {
		t.Fatalf("the restored copy is in %s mode before it is served, so this proves nothing", mode)
	}

	stop := serveInBackground(t, restored)
	defer stop()
	if mode := journalMode(t, restored); mode != "wal" {
		t.Fatalf("the restored store is served in %s mode", mode)
	}
}
