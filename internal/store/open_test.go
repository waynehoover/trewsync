package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
 * Opening a store says what it is allowed to do to it (I15).
 *
 * There was one opening path and every command used it: it created the
 * directory if it was missing, ran the migrations and executed the schema. So
 * `trew verify -data /typo` made an empty store and pronounced it healthy,
 * and inspecting a database from an older build silently upgraded it. Neither
 * is catastrophic on its own; both are a command doing something other than
 * what it says, to the directory holding somebody's notes.
 *
 * And nothing recorded a schema version at all, which is the one that could
 * lose a note. `CREATE TABLE IF NOT EXISTS` does nothing to a table that is
 * already there, so an older binary opened a newer database without complaint,
 * read the columns it happened to know about and wrote rows missing the rest.
 */

func newStore(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath, chunkDir := DataDir(dir)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return dbPath, chunkDir
}

func TestANewStoreRecordsItsSchemaVersion(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := OpenMode(dbPath, chunkDir, Existing, SyncFull)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = st.Close() }()

	var got int
	if err := st.db.QueryRow(`PRAGMA user_version`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != SchemaVersion {
		t.Fatalf("the database says schema %d and this binary is %d", got, SchemaVersion)
	}
}

// The one that matters. An older trew must stop rather than proceed.
func TestADatabaseFromTheFutureIsRefused(t *testing.T) {
	dbPath, chunkDir := newStore(t)

	// Stamp a version this binary has never heard of, which is what a newer
	// trew would have left behind. In the identity row, which is what is
	// checked: the header's copy alone is not, because Basalt's header says 1
	// too (PLAN.md section 2.8).
	bump, err := OpenMode(dbPath, chunkDir, Existing, SyncFull)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bump.db.Exec(`UPDATE store_identity SET schema_version = 9999`); err != nil {
		t.Fatal(err)
	}
	if err := bump.Close(); err != nil {
		t.Fatal(err)
	}

	for _, mode := range []struct {
		name string
		open func() (*Store, error)
	}{
		{"serve", func() (*Store, error) { return Open(dbPath, chunkDir) }},
		{"an existing store", func() (*Store, error) {
			return OpenMode(dbPath, chunkDir, Existing, SyncFull)
		}},
		// Read-only too. Being asked only to look does not make reading a
		// database this binary cannot interpret safe, and a `verify` that
		// pronounced a future database healthy would be the worst of the three.
		{"inspection", func() (*Store, error) { return OpenForInspection(dbPath, chunkDir) }},
	} {
		t.Run(mode.name, func(t *testing.T) {
			st, err := mode.open()
			if err == nil {
				_ = st.Close()
				t.Fatal("a database from the future opened without complaint")
			}
			if !errors.Is(err, ErrFutureSchema) {
				t.Fatalf("refused, but not as a future schema: %v", err)
			}
			// Both numbers, because the answer is always "run the newer one"
			// and a message that does not say which is which leaves somebody
			// guessing at their own data.
			for _, want := range []string{"9999", "newer trew"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("the refusal does not mention %q: %v", want, err)
				}
			}
		})
	}
}

// The header's copy of the version is not what identifies a store, the
// identity row is, so a header that lost it does not make a store unopenable:
// refusing would be an upgrade that cannot open the store it is upgrading. And
// opening it restamps the header, so a tool reading only the header is not
// misled for long.
func TestAHeaderThatLostItsVersionIsRestamped(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	back, err := OpenMode(dbPath, chunkDir, Existing, SyncFull)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := back.db.Exec(`PRAGMA user_version = 0`); err != nil {
		t.Fatal(err)
	}
	if err := back.Close(); err != nil {
		t.Fatal(err)
	}

	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("a store whose header lost its version was refused: %v", err)
	}
	defer func() { _ = st.Close() }()
	var got int
	if err := st.db.QueryRow(`PRAGMA user_version`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != SchemaVersion {
		t.Fatalf("opening it left the header at %d", got)
	}
}

func TestOnlyServeCreatesAStore(t *testing.T) {
	dir := t.TempDir()
	dbPath, chunkDir := DataDir(filepath.Join(dir, "typo"))

	for _, mode := range []struct {
		name string
		m    Mode
	}{{"an existing store", Existing}, {"inspection", ReadOnly}} {
		t.Run(mode.name, func(t *testing.T) {
			st, err := OpenMode(dbPath, chunkDir, mode.m, SyncFull)
			if err == nil {
				_ = st.Close()
				t.Fatal("a directory that is not a store was opened as one")
			}
			if _, statErr := os.Stat(dbPath); statErr == nil {
				t.Fatal("it created the database it was told not to create")
			}
		})
	}

	// And Create does, because on a first run there is nothing there and that
	// is the normal case.
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("serve could not create a store: %v", err)
	}
	_ = st.Close()
}

// Inspection cannot write, and it is SQLite that stops it rather than this
// package remembering not to. A convention holds until somebody adds a call.
func TestInspectionCannotWrite(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := OpenForInspection(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("open for inspection: %v", err)
	}
	defer func() { _ = st.Close() }()

	if err := st.EnsureVault("default", 1000); err == nil {
		t.Fatal("a read-only store took a write")
	}
	if _, err := st.db.Exec(`PRAGMA user_version = 5`); err == nil {
		t.Fatal("a read-only store let the schema version be changed")
	}
}

// Inspecting a store leaves it byte for byte as it was, which is the property
// the mode exists for and the one a caller is relying on when they point
// `verify` at a backup they are about to trust.
func TestInspectionChangesNothingOnDisk(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	seed, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}

	before, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}

	st, err := OpenForInspection(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("open for inspection: %v", err)
	}
	if _, err := st.Stats("default"); err != nil {
		t.Fatalf("stats: %v", err)
	}
	if _, err := st.Verify(false); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	after, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("inspecting the store changed it: %d bytes before, %d after",
			len(before), len(after))
	}
}

func TestInspectionDoesNotRecreateMissingChunkStorage(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	// A missing mount or incomplete restore is a fault to inspect, not an
	// instruction for a diagnostic command to create replacement storage.
	if err := os.Remove(chunkDir); err != nil {
		t.Fatal(err)
	}
	st, err := OpenForInspection(dbPath, chunkDir)
	if st != nil {
		_ = st.Close()
	}
	if _, statErr := os.Stat(chunkDir); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("inspection recreated the missing chunk directory: %v", statErr)
	}
	if err == nil {
		t.Fatal("inspection accepted missing chunk storage")
	}
}
