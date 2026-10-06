package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/store"
)

// atSchemaThree turns a seeded store into one the build before the purge mark
// wrote: schema 3, without the purge_marks table.
func atSchemaThree(t *testing.T, dir string) {
	t.Helper()
	dbPath, _ := store.DataDir(dir)
	onDisk(t, dbPath, func(db *sql.DB) {
		for _, q := range []string{
			`DROP TABLE purge_marks`,
			`UPDATE store_identity SET schema_version = 3 WHERE id = 1`,
			`PRAGMA user_version = 3`,
		} {
			if _, err := db.Exec(q); err != nil {
				t.Fatalf("%s: %v", q, err)
			}
		}
	})
}

// schemaOnDisk is the schema the store's identity row records, read from the
// file without the store package, which may not open an older one.
func schemaOnDisk(t *testing.T, dir string) int {
	t.Helper()
	dbPath, _ := store.DataDir(dir)
	var v int
	onDisk(t, dbPath, func(db *sql.DB) {
		if err := db.QueryRow(`SELECT schema_version FROM store_identity WHERE id = 1`).Scan(&v); err != nil {
			t.Fatal(err)
		}
	})
	return v
}

// T37. `trewd backup` runs beside the server, and opened the store the way
// serve does, which migrates it. `trewd update` leaves the old server running
// until it restarts, so the nightly backup, now the new binary, upgraded the
// schema underneath the old server: the version fence exists to stop exactly
// that build writing to a store it no longer understands, and the documented
// rollback, reinstalling the older binary, then met a store it refuses. A
// backup now opens its source without migrating, and refuses one older than
// itself, both kinds, with the remedy, leaving the store as it was.
func TestABackupNeverUpgradesTheStoreItCopies(t *testing.T) {
	dir := seeded(t)
	atSchemaThree(t, dir)
	before := treeDigest(t, dir)
	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", key)

	for _, args := range [][]string{
		{"backup", "-plaintext-ok", "-data", dir, "-to", filepath.Join(t.TempDir(), "plain")},
		{"backup", "-data", dir, "-to", filepath.Join(t.TempDir(), "trew.tar.age"), "-recipients-file", key + ".pub"},
	} {
		out, err := trew(t, args...)
		if err == nil {
			t.Fatalf("a backup of a schema 3 store succeeded:\n%s", out)
		}
		for _, want := range []string{"schema 3", "restart"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("the refusal does not say %q: %v", want, err)
			}
		}
		if got := schemaOnDisk(t, dir); got != 3 {
			t.Fatalf("the backup moved the store it copies to schema %d", got)
		}
	}
	// Byte for byte, apart from the backup record and the staging directory
	// a refused backup never reaches.
	if after := withoutRecords(before, treeDigest(t, dir)); after != before {
		t.Fatalf("the refused backups changed the store:\nbefore\n%s\nafter\n%s", before, after)
	}
}

// withoutRecords is after with the lines a backup command may write anyway,
// its record of the attempt, dropped where before has none, so a comparison
// is about the store.
func withoutRecords(before, after string) string {
	var kept []string
	for _, line := range strings.Split(after, "\n") {
		if strings.HasPrefix(line, "last-backup.json ") && !strings.Contains(before, "last-backup.json ") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}
