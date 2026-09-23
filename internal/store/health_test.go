package store

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
)

/*
 * Health says what it means (R15).
 *
 * The field is called CanPersist and the question asked was `SELECT 1`, which
 * succeeds against a database opened read-only, one whose file has lost write
 * permission, and one on a filesystem the kernel remounted read-only after an
 * I/O error, which is the ordinary way a Linux box reacts to a failing disk.
 * So the one case an operator most needs to hear about read as healthy, and an
 * immediate write then failed with "attempt to write a readonly database".
 *
 * And `Took` was assigned in a deferred function after an unnamed return had
 * already been copied, so every caller received zero: the figure to look at
 * when a probe starts timing out was the one figure guaranteed to be wrong.
 */

func healthOf(t *testing.T, st *Store) Health {
	t.Helper()
	return st.CheckHealth(context.Background())
}

func TestHealthOnAStoreThatWorks(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	h := healthOf(t, st)
	if !h.CanPersist || h.Why != HealthOK {
		t.Fatalf("a working store reported %v, %q", h.CanPersist, h.Why)
	}
	if h.Took <= 0 {
		t.Error("the check reported that it took no time at all, which is the one thing it cannot have")
	}
	if h.TotalBytes <= 0 {
		t.Error("no filesystem figures came back")
	}
}

// The case a read cannot see: a database that refuses writes.
//
// `SELECT 1` succeeds against one, which is why the probe writes (R15). The
// production shape is a filesystem remounted read-only under a running server,
// which no unit test can produce: the kernel refuses writes on fds SQLite
// already holds, and a chmod after the open changes nothing. A connection
// opened `mode=ro` is what that looks like to SQLite from inside, so the
// branch is driven with one, on a handle that believes it is writable.
//
// It used to be driven with `OpenForInspection`, and that stand-in was the
// confusion itself: every inspection command opens that way, so `trew
// stats` reported every healthy server as unable to take a note. The two
// answers are told apart here and in the test below.
func TestHealthNoticesADatabaseThatRefusesWrites(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	if st, err := Open(dbPath, chunkDir); err != nil {
		t.Fatal(err)
	} else if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)&_pragma=query_only(1)&mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	cs, err := chunks.New(chunkDir, ChunkMax)
	if err != nil {
		t.Fatal(err)
	}
	// readOnly stays false: this handle is supposed to take writes and does
	// not, which is the fault. An inspection handle is the next test.
	st := &Store{db: db, chunks: cs, dbPath: dbPath}

	// The premise: reads work.
	var one int
	if err := st.db.QueryRow(`SELECT 1`).Scan(&one); err != nil || one != 1 {
		t.Fatalf("the store cannot even read, so this proves nothing: %v", err)
	}
	// And a write does not, which is what health has to notice.
	if err := st.EnsureVault("default", 1000); err == nil {
		t.Fatal("the store took a write, so this proves nothing")
	}

	h := healthOf(t, st)
	if h.CanPersist {
		t.Fatal("a store that cannot be written to reported that it can take a note")
	}
	if h.Why != HealthUnwritable {
		t.Errorf("the reason was %q, wanted %q", h.Why, HealthUnwritable)
	}
	// And not the chunk store's word: this is the database refusing writes.
	if h.Why == HealthChunksUnwritable {
		t.Error("a read-only database was reported as a chunk-directory fault")
	}
	if h.Took <= 0 {
		t.Error("the check reported that it took no time at all")
	}
}

// And an inspection handle says it did not ask, rather than answering.
//
// `stats`, `verify` and `service` all open read-only on purpose (I15), and the
// probe refuses on exactly such a connection by design (R15). Both are right;
// together they made `stats` print `canPersist: false, reason: store-read-only`
// about every healthy server, and return before the statfs, so the free-space
// figures that command exists to print were always zero.
func TestHealthSaysWhenItDidNotAsk(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	if st, err := Open(dbPath, chunkDir); err != nil {
		t.Fatal(err)
	} else if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err := OpenForInspection(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	h := healthOf(t, st)
	if h.Why != HealthUnchecked {
		t.Errorf("the reason was %q, wanted %q", h.Why, HealthUnchecked)
	}
	// The rest of the report is real, and is the half `stats` is there for.
	if h.TotalBytes <= 0 || h.FreeBytes <= 0 {
		t.Errorf("no filesystem figures came back: free=%d total=%d", h.FreeBytes, h.TotalBytes)
	}
	if h.Took <= 0 {
		t.Error("the check reported that it took no time at all")
	}
}

// A closed database is unreadable, and that is a different word from
// unwritable: one is a server that is broken and the other is a disk that has
// gone read-only, and they are fixed differently.
func TestHealthTellsUnreadableFromUnwritable(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	h := healthOf(t, st)
	if h.CanPersist {
		t.Fatal("a closed store reported that it can take a note")
	}
	if h.Why != HealthUnreadable {
		t.Errorf("the reason was %q, wanted %q", h.Why, HealthUnreadable)
	}
}

// The check must not leave anything behind: it is run every few seconds.
func TestHealthWritesNothing(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}

	before, err := DatabaseStamp(strings.TrimSuffix(dbPath, "/trew.db"))
	if err != nil {
		// DataDir layout differs; fall back to hashing the file directly.
		before.Digest, err = fileDigest(dbPath)
		if err != nil {
			t.Fatal(err)
		}
	}
	for range 20 {
		if h := healthOf(t, st); !h.CanPersist {
			t.Fatalf("health failed on a working store: %q", h.Why)
		}
	}
	after, err := fileDigest(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if before.Digest != "" && before.Digest != after {
		t.Error("twenty health checks changed the database")
	}
}

// Health means the chunk store can be written to, not that it has room (R28).
//
// The database side was corrected to exercise a real write; the chunk side
// stayed a `statfs`, which says the volume is mounted and has space and says
// nothing about whether this process may write to it. A chunk root whose
// permissions have gone, or one on a mount the kernel turned read-only after
// an I/O error, answers `statfs` perfectly and refuses every upload. Same
// mistake, one directory over, under a field still called CanPersist.
func TestHealthNoticesAChunkStoreItCannotWriteTo(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, where a mode of 500 stops nothing")
	}
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// Readable and not writable, which is what a permissions accident and a
	// read-only remount both look like from here.
	if err := os.Chmod(chunkDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(chunkDir, 0o700) })

	// The premise: the database is still perfectly writable, so anything that
	// only asks SQLite reports a healthy server.
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatalf("the database is not writable either, so this proves nothing: %v", err)
	}
	// And a body genuinely cannot be stored.
	body := []byte("a chunk that will not land")
	if err := st.Chunks().Put("default", chunks.Name(body), body); err == nil {
		t.Fatal("the chunk store took a write, so this proves nothing")
	}

	h := healthOf(t, st)
	if h.CanPersist {
		t.Fatal("a server that cannot store a body reported that it can take a note")
	}
	// Its own word, not the database's: the two send an operator to different
	// places, and a monitor pages on the word (R28).
	if h.Why != HealthChunksUnwritable {
		t.Errorf("the reason was %q, wanted %q", h.Why, HealthChunksUnwritable)
	}
	if h.Why == HealthUnwritable {
		t.Error("a chunk-directory fault was reported as a read-only database")
	}
}

// And the probe leaves nothing behind, because it runs every few seconds.
func TestHealthLeavesNoProbeFileBehind(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	for range 5 {
		if h := healthOf(t, st); !h.CanPersist {
			t.Fatalf("health failed on a working store: %q", h.Why)
		}
	}
	left, err := os.ReadDir(chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range left {
		if strings.Contains(e.Name(), "health") {
			t.Errorf("the health probe left %s behind", e.Name())
		}
	}
}
