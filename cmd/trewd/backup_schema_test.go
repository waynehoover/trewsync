package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"

	"github.com/waynehoover/trewsync/internal/archive"
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

// olderArchive is an encrypted backup an older build made: the seeded store's
// backup with its database put back to schema 1, before the operation log,
// packed the way Pack lays an archive out. Packed by hand, because this
// build's Pack, rightly, reads only a staging copy at its own schema.
func olderArchive(t *testing.T, recipientsFile string) string {
	t.Helper()
	staged := filepath.Join(t.TempDir(), "staged")
	mustRun(t, "backup", "-plaintext-ok", "-data", seeded(t), "-to", staged)
	dbPath, chunkDir := store.DataDir(staged)
	onDisk(t, dbPath, func(db *sql.DB) {
		for _, q := range []string{`DROP TABLE op_keys`, `DROP TABLE op_pins`, `DROP TABLE op_entries`,
			`DROP TABLE operations`, `DROP TABLE purge_marks`, `UPDATE store_identity SET schema_version = 1 WHERE id = 1`,
			`PRAGMA user_version = 1`} {
			if _, err := db.Exec(q); err != nil {
				t.Fatalf("%s: %v", q, err)
			}
		}
	})
	// backup.json describes the database beside it, as the older build's did.
	meta, err := os.ReadFile(filepath.Join(staged, store.BackupMetaFile))
	if err != nil {
		t.Fatal(err)
	}
	var m store.BackupMeta
	if err := json.Unmarshal(meta, &m); err != nil {
		t.Fatal(err)
	}
	if m.Database, err = store.DatabaseStamp(staged); err != nil {
		t.Fatal(err)
	}
	if meta, err = json.Marshal(m); err != nil {
		t.Fatal(err)
	}
	dbBytes, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	type entry struct {
		name string
		data []byte
	}
	var bodies []entry
	var bodyBytes int64
	if err := filepath.WalkDir(chunkDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(staged, p)
		bodies = append(bodies, entry{filepath.ToSlash(rel), b})
		bodyBytes += int64(len(b))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(dbBytes)
	man, _ := json.Marshal(archive.Manifest{Format: archive.Format, Product: store.Product, TakenAt: m.TakenAt,
		Bodies: len(bodies), BodyBytes: bodyBytes, Database: hex.EncodeToString(sum[:])})
	recipients, err := archive.ParseRecipients(nil, []string{recipientsFile})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	enc, err := age.Encrypt(&buf, recipients...)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	entries := append(append([]entry{{archive.ManifestFile, man}}, bodies...),
		entry{store.BackupMetaFile, meta}, entry{filepath.Base(dbPath), dbBytes})
	for _, e := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: e.name, Mode: 0o600, Size: int64(len(e.data)),
			Typeflag: tar.TypeReg, Format: tar.FormatPAX}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "older.tar.age")
	if err := os.WriteFile(out, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return out
}

// T28. A store opened only to be looked at is never migrated, and nothing
// refused one older than this build either, so the checks that read the newer
// tables failed with SQL errors: unpacking an archive an older build made
// "failed verification" with `no such table: operations`, though serve
// upgrades such a store without a word, and a rehearsal of it failed the same
// way. unpack and rehearse now upgrade the copy they made, which nothing else
// is using, before checking it; inspecting an older store is refused in
// words, saying what upgrades it, and leaves it as it was.
func TestAnArchiveAnOlderBuildMadeUnpacksAndRehearses(t *testing.T) {
	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", key)
	older := olderArchive(t, key+".pub")

	restored := filepath.Join(t.TempDir(), "restored")
	out, err := trew(t, "unpack", "-from", older, "-identity", key, "-to", restored)
	if err != nil || !strings.Contains(out, "0 faults") {
		t.Fatalf("unpacking an older build's archive: %v\n%s", err, out)
	}
	if got := schemaOnDisk(t, restored); got != store.SchemaVersion {
		t.Fatalf("the unpacked store is at schema %d", got)
	}
	if got := mustRun(t, "cat", "-data", restored, "-path", "note.md", "-uid", "1"); got != "version one" {
		t.Fatalf("the unpacked store's history reads %q", got)
	}

	out, err = trew(t, "rehearse", "-data", seeded(t), "-backup", older, "-identity", key, "-not-last-backup")
	if err != nil || !strings.Contains(out, "Recovery time:") {
		t.Fatalf("rehearsing an older build's archive: %v\n%s", err, out)
	}

	// Looking at an older store is refused in words, and changes nothing.
	dir := seeded(t)
	atSchemaThree(t, dir)
	before := treeDigest(t, dir)
	for _, args := range [][]string{{"verify", "-deep"}, {"stats"}, {"history", "-path", "note.md"}} {
		out, err := trew(t, append(args, "-data", dir)...)
		if err == nil {
			t.Fatalf("%s of a schema 3 store succeeded:\n%s", args[0], out)
		}
		if !strings.Contains(err.Error(), "schema 3") || !strings.Contains(err.Error(), "upgrades") ||
			strings.Contains(err.Error(), "no such") {
			t.Fatalf("%s of a schema 3 store: %v", args[0], err)
		}
	}
	if after := treeDigest(t, dir); after != before {
		t.Fatalf("inspecting an older store changed it:\nbefore\n%s\nafter\n%s", before, after)
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
