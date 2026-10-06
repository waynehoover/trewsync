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

// goLive opens dir as serve does and returns what GoLive did.
func goLive(t *testing.T, dir string) Live {
	t.Helper()
	s := openAt(t, dir)
	live, err := s.GoLive()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	return live
}

// onFile runs statements against the database in dir on a plain connection,
// as a build that knows nothing of this one's tables would.
func onFile(t *testing.T, dir string, statements ...string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(dir, dbFileName))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, s := range statements {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

// T27, for a snapshot a build from before the mark took: no snapshot table,
// and a backup.json that still describes the database beside it, which is
// what such a snapshot looks like until something writes to it. It is given
// an epoch of its own the first time it is served, and not again; and a store
// whose backup.json no longer describes it, one written to since, is not taken
// for a snapshot at all.
func TestASnapshotFromBeforeTheMarkStartsAnEpochOnce(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "a.md", "x")
	legacy := func() string {
		bk := t.TempDir()
		if _, err := h.Backup(bk, false); err != nil {
			t.Fatal(err)
		}
		onFile(t, bk, `DROP TABLE snapshot`)
		meta, err := ReadBackupMeta(bk)
		if err == nil {
			t.Fatal("backup.json still describes the database the mark was taken out of")
		}
		if meta.Database, err = DatabaseStamp(bk); err != nil {
			t.Fatal(err)
		}
		if err := writeBackupMeta(bk, meta); err != nil {
			t.Fatal(err)
		}
		return bk
	}

	bk := legacy()
	first := goLive(t, bk)
	if !first.Renewed || first.Was == "" {
		t.Fatalf("a snapshot from before the mark was served under its snapshot's epoch: %+v", first)
	}
	if again := goLive(t, bk); again.Renewed {
		t.Fatalf("a restart gave the restored store another epoch: %+v", again)
	}

	// Written to since, by a build that did not know the mark: no longer the
	// snapshot its backup.json describes.
	written := legacy()
	onFile(t, written, `UPDATE store_identity SET created_at = created_at + 1 WHERE id = 1`)
	if live := goLive(t, written); live.Renewed {
		t.Fatalf("a store written to since its backup.json was taken for an unserved snapshot: %+v", live)
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
