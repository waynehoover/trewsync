package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// heldReader opens dir's database on a connection of its own and holds a read
// transaction on it until the returned function is called, as a backup's
// snapshot or a verify in another process does.
func heldReader(t *testing.T, dir string) (release func()) {
	t.Helper()
	db, err := sql.Open("sqlite", dsn(filepath.Join(dir, dbFileName), SyncFull, true))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM entries").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return func() {
		_, _ = conn.ExecContext(ctx, "ROLLBACK")
		_ = conn.Close()
		_ = db.Close()
	}
}

// T26. What WAL mode is for, on a store served from a backup: GoLive, which
// serve runs on every store it opens, then a commit while another process
// holds a read transaction. In the rollback-journal mode a backup's database
// used to be served in, that commit waited out the busy timeout and failed.
func TestAStoreServedFromABackupCommitsUnderAHeldReader(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "a.md", "x")
	bk := t.TempDir()
	if _, err := h.Backup(bk, false); err != nil {
		t.Fatal(err)
	}
	r := openAt(t, bk)
	live, err := r.GoLive()
	if err != nil || live.JournalErr != nil || live.Journal != "wal" {
		t.Fatalf("going live: %+v %v", live, err)
	}

	release := heldReader(t, bk)
	start := time.Now()
	_, err = r.write("b.md", "written under a reader")
	took := time.Since(start)
	release()
	if err != nil {
		t.Fatalf("a commit under a held reader failed after %v: %v", took, err)
	}
	if took > time.Second {
		t.Fatalf("a commit under a held reader waited %v for it", took)
	}
}
