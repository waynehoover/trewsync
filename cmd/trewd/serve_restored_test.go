package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// serveAt runs `trewd serve` on dir at a port of its own, naming that address
// in invites, and returns the address devices dial and how to stop it.
func serveAt(t *testing.T, dir string) (url string, stop func()) {
	t.Helper()
	addr := fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- run(ctx, []string{"serve", "-data", dir, "-addr", addr, "-url", "ws://" + addr}, out) }()
	waitForServer(t, addr, out)
	stopped := false
	return "ws://" + addr, func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("the server did not stop")
		}
	}
}

// appendBeside commits notes to dir's store through a handle of its own while
// a server serves it, as other devices' writes would arrive, and returns their
// uids.
func appendBeside(t *testing.T, dir string, notes ...string) []int64 {
	t.Helper()
	var uids []int64
	withStore(t, dir, func(st *store.Store) {
		for _, n := range notes {
			name := chunks.Name([]byte(n))
			if err := st.Chunks().Put("default", name, []byte(n)); err != nil {
				t.Fatal(err)
			}
			uid, err := st.AppendEntry("default", store.Entry{Path: n + ".md", Size: int64(len(n)), MTime: 1,
				Device: "another device", Chunks: []string{name}})
			if err != nil {
				t.Fatal(err)
			}
			uids = append(uids, uid)
		}
	})
	return uids
}

// syncOnce connects as d with a cursor and an epoch, as a device that has
// synced before does, reads the backlog, and returns the epoch `ready` named,
// the uids delivered and the cursor reached.
func syncOnce(t *testing.T, url string, d pairedDevice, cursor int64, epoch string) (string, []int64, int64) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	d.addr = url
	conn, err := d.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := sendJSON(ctx, conn, wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Vault: d.vault, Device: "laptop",
		DeviceID: d.id, Token: d.token, Cursor: cursor, Epoch: epoch}); err != nil {
		t.Fatal(err)
	}
	var ready wire.Ready
	if err := readJSON(ctx, conn, &ready); err != nil {
		t.Fatalf("hello with cursor %d: %v", cursor, err)
	}
	var uids []int64
	at := cursor
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var probe struct {
			Op string `json:"op"`
		}
		_ = json.Unmarshal(b, &probe)
		if probe.Op == "caught-up" {
			break
		}
		if probe.Op != "batch" {
			continue
		}
		var batch wire.Batch
		if err := json.Unmarshal(b, &batch); err != nil {
			t.Fatal(err)
		}
		for _, e := range batch.Entries {
			uids = append(uids, e.UID)
		}
		at = batch.To
	}
	_ = conn.Close(websocket.StatusNormalClosure, "")
	return ready.Epoch, uids, at
}

// T27. A backup gave its snapshot an epoch of its own once, when it was
// taken, and a restore copied that epoch byte for byte, so restoring the same
// archive twice (a second attempt, or a disk that died before the next
// backup) served one epoch twice. A device whose cursor had followed the first
// restore past the snapshot was then, once other devices had written past
// that cursor, served from it without a word: it never got the second
// restore's versions under its cursor, and never sent back the notes it had
// written into the first. Every time a snapshot becomes a live store it now
// starts an epoch of its own, and a restart of that store keeps it.
func TestRestoringOneSnapshotTwiceStartsTwoEpochs(t *testing.T) {
	live := seeded(t)
	url, stop := serveAt(t, live)
	inv := parseInvite(t, mustRun(t, "invite", "-data", live, "-url", url))
	laptop := pairedDevice{vault: "default", addr: url}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := laptop.pair(ctx, inv.Token); err != nil {
		t.Fatal(err)
	}
	epochLive, _, cursor := syncOnce(t, url, laptop, 0, "")
	stop()

	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", key)
	archive := filepath.Join(t.TempDir(), "trew.tar.age")
	mustRun(t, "backup", "-data", live, "-to", archive, "-recipients-file", key+".pub")

	// The first restore: a new epoch, so the laptop reads it whole; then the
	// laptop follows five versions written into it.
	first := filepath.Join(t.TempDir(), "first")
	mustRun(t, "unpack", "-from", archive, "-identity", key, "-to", first)
	url1, stop1 := serveAt(t, first)
	epoch1, _, cursor := syncOnce(t, url1, laptop, cursor, epochLive)
	if epoch1 == epochLive {
		t.Fatal("the first restore kept the live store's epoch")
	}
	appendBeside(t, first, "first life 1", "first life 2", "first life 3", "first life 4", "first life 5")
	_, _, cursor = syncOnce(t, url1, laptop, cursor, epoch1)
	stop1()
	// A restart of the same restored store is the same history.
	url1, stop1 = serveAt(t, first)
	if again, _, _ := syncOnce(t, url1, laptop, cursor, epoch1); again != epoch1 {
		t.Fatalf("restarting the restored store moved its epoch from %s to %s", epoch1, again)
	}
	stop1()

	// The same archive restored again, and other devices write past the
	// laptop's cursor.
	second := filepath.Join(t.TempDir(), "second")
	mustRun(t, "unpack", "-from", archive, "-identity", key, "-to", second)
	url2, stop2 := serveAt(t, second)
	defer stop2()
	written := appendBeside(t, second, "second life 1", "second life 2", "second life 3", "second life 4",
		"second life 5", "second life 6")
	epoch2, got, _ := syncOnce(t, url2, laptop, cursor, epoch1)
	if epoch2 == epoch1 {
		t.Fatalf("the second restore of one archive served the first restore's epoch %s", epoch1)
	}
	for _, uid := range written {
		if !slices.Contains(got, uid) {
			t.Fatalf("the laptop was not given uid %d of the second restore's history: it received %v", uid, got)
		}
	}
}

// T27, for a plaintext backup copied back twice, the other documented restore.
func TestCopyingOnePlaintextBackupBackTwiceStartsTwoEpochs(t *testing.T) {
	source := seeded(t)
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", backup)
	epochs := map[string]bool{}
	for i := 0; i < 2; i++ {
		restored := filepath.Join(t.TempDir(), "restored")
		copyTree(t, backup, restored)
		stop := serveInBackground(t, restored)
		stop()
		dbPath, chunkDir := store.DataDir(restored)
		st, err := store.OpenForInspection(dbPath, chunkDir)
		if err != nil {
			t.Fatal(err)
		}
		epochs[st.Epoch()] = true
		st.Close()
	}
	if len(epochs) != 2 {
		t.Fatalf("two copies of one backup were served under %d epochs", len(epochs))
	}
}

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
