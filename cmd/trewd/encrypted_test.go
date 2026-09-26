package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/doctor"
	"github.com/waynehoover/trewsync/internal/store"
)

// A backup has to say whether it is encrypted (PLAN.md section 3.6): with
// neither -encrypt-to nor -plaintext-ok it is refused before anything is
// written, since a plaintext copy made by default is how a vault becomes
// readable from a disk nobody thought of as sensitive; with both it is refused
// as a contradiction.
func TestABackupMustSayWhetherItIsEncrypted(t *testing.T) {
	dir := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	out, err := trew(t, "backup", "-data", dir, "-to", dest)
	if err == nil || !strings.Contains(err.Error(), "-encrypt-to") || !strings.Contains(err.Error(), "-plaintext-ok") {
		t.Fatalf("a backup that said neither: %v\n%s", err, out)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("the refused backup wrote %s (%v)", dest, err)
	}
	keyFile := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", keyFile)
	if _, err := trew(t, "backup", "-data", dir, "-to", dest, "-plaintext-ok", "-recipients-file", keyFile+".pub"); err == nil {
		t.Fatal("a backup both encrypted and plaintext was taken")
	}
}

// The encrypted path end to end: `trewd backup-key` makes an identity at mode
// 0600 and its recipient beside it, and never writes over either; `trewd
// backup -recipients-file` writes one archive in which no note is readable;
// the record doctor reads names it, its size and its digest; and `trewd
// unpack` with the identity gives back a data directory that verifies deeply
// and reads every note as it was.
func TestAnEncryptedBackupUnpacksToTheNotesItHeld(t *testing.T) {
	dir := seeded(t)
	keyFile := filepath.Join(t.TempDir(), "backup-key")
	out := mustRun(t, "backup-key", "-out", keyFile)
	if !strings.Contains(out, keyFile+".pub") {
		t.Fatalf("backup-key does not say where the recipient went:\n%s", out)
	}
	for _, f := range []string{keyFile, keyFile + ".pub"} {
		info, err := os.Stat(f)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", f, info, err)
		}
	}
	secret, _ := os.ReadFile(keyFile)
	if !strings.Contains(string(secret), "AGE-SECRET-KEY-PQ-") {
		t.Fatalf("the default key is not the post-quantum one:\n%s", secret)
	}
	if _, err := trew(t, "backup-key", "-out", keyFile); err == nil {
		t.Fatal("backup-key wrote over an identity")
	}
	if again, _ := os.ReadFile(keyFile); !bytes.Equal(again, secret) {
		t.Fatal("the identity changed")
	}

	archive := filepath.Join(t.TempDir(), "trew.tar.age")
	out = mustRun(t, "backup", "-data", dir, "-to", archive, "-recipients-file", keyFile+".pub")
	if !strings.Contains(out, "encrypted backup written to "+archive) {
		t.Fatalf("the encrypted backup says:\n%s", out)
	}
	raw, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	for _, words := range []string{"version three", "only version", "note.md"} {
		if bytes.Contains(raw, []byte(words)) {
			t.Fatalf("the archive holds %q in the clear", words)
		}
	}
	var rec doctor.BackupRecord
	if ok, err := doctor.ReadRecord(dir, doctor.BackupRecordFile, &rec); !ok || err != nil {
		t.Fatalf("no backup record: %v", err)
	}
	sum := sha256.Sum256(raw)
	if !rec.OK || !rec.Encrypted || rec.To != archive || rec.SHA256 != hex.EncodeToString(sum[:]) ||
		rec.Bytes != int64(len(raw)) || rec.LatestUID != 6 || rec.LastOK != rec.At {
		t.Fatalf("the record says %+v", rec)
	}

	restored := filepath.Join(t.TempDir(), "restored")
	out = mustRun(t, "unpack", "-from", archive, "-identity", keyFile, "-to", restored)
	if !strings.Contains(out, "0 faults") {
		t.Fatalf("unpack's verify says:\n%s", out)
	}
	for path, want := range map[string]string{
		"note.md": "version three", "other.md": "only version", "attachment.bin": "part one part two part three",
	} {
		if got := mustRun(t, "cat", "-data", restored, "-path", path); got != want {
			t.Fatalf("%s reads %q from the restore", path, got)
		}
	}
	if got := mustRun(t, "cat", "-data", restored, "-path", "note.md", "-uid", "1"); got != "version one" {
		t.Fatalf("the restore's history reads %q", got)
	}
	if _, err := trew(t, "unpack", "-from", archive, "-identity", keyFile, "-to", restored); err == nil {
		t.Fatal("an unpack wrote into a directory that already holds a store")
	}
}

// A backup that fails is recorded as failed, with its error, and the record
// keeps when the last good one finished, so doctor can say how old the good
// copy is rather than only that the last try did not work.
func TestAFailedBackupIsRecordedWithTheLastGoodOne(t *testing.T) {
	dir := seeded(t)
	good := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", good)
	var first doctor.BackupRecord
	if _, err := doctor.ReadRecord(dir, doctor.BackupRecordFile, &first); err != nil || !first.OK {
		t.Fatalf("the good backup's record: %+v %v", first, err)
	}
	corruptOneBody(t, dir)
	if _, err := trew(t, "backup", "-plaintext-ok", "-data", dir, "-to", filepath.Join(t.TempDir(), "second"), "-deep"); err == nil {
		t.Fatal("a backup of a store with a rotted body succeeded")
	}
	var rec doctor.BackupRecord
	if _, err := doctor.ReadRecord(dir, doctor.BackupRecordFile, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.OK || rec.Error == "" || rec.LastOK != first.LastOK {
		t.Fatalf("the failed backup is recorded as %+v, after %+v", rec, first)
	}
}

// A rehearsal of a backup that is not of this data directory fails, says so,
// and is recorded as failed for doctor: every version the live store holds up
// to the backup's newest uid has to be in it, identical.
func TestARehearsalOfSomeOtherStoresBackupFails(t *testing.T) {
	live := seeded(t)
	other := t.TempDir()
	withStore(t, other, func(st *store.Store) {
		if err := st.EnsureVault("default", 1); err != nil {
			t.Fatal(err)
		}
	})
	appendOne(t, other, "somebody else's.md", "a different vault's first note")
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", other, "-to", backup)

	out, err := trew(t, "rehearse", "-data", live, "-backup", backup)
	if err == nil || !strings.Contains(out, "is this a backup of") || !strings.Contains(out, "THE REHEARSAL FAILED") {
		t.Fatalf("a rehearsal of another store's backup: %v\n%s", err, out)
	}
	var rec doctor.RehearsalRecord
	if _, err := doctor.ReadRecord(live, doctor.RehearsalRecordFile, &rec); err != nil || rec.OK || rec.Error == "" {
		t.Fatalf("the failed rehearsal is recorded as %+v (%v)", rec, err)
	}
	// And it leaves nothing of itself in the data directory.
	entries, _ := os.ReadDir(live)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "rehearsal-") {
			t.Fatalf("the rehearsal left %s behind", e.Name())
		}
	}
	if _, err := trew(t, "rehearse", "-data", live, "-backup", backup, "-work", live); err == nil {
		t.Fatal("a rehearsal was let loose on a -work directory that already exists")
	}
}

// A plaintext backup directory is rehearsed too, and a passing rehearsal is
// what doctor reports.
func TestARehearsalOfAPlaintextBackupPasses(t *testing.T) {
	live := seeded(t)
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", live, "-to", backup)
	out := mustRun(t, "rehearse", "-data", live, "-backup", backup)
	for _, want := range []string{"copied", "every one of the live store's 6 versions", "downloaded all 3 notes", "Recovery time:"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the rehearsal does not say %q:\n%s", want, out)
		}
	}
	var rec doctor.RehearsalRecord
	if _, err := doctor.ReadRecord(live, doctor.RehearsalRecordFile, &rec); err != nil || !rec.OK || rec.Files != 3 ||
		rec.Versions != 6 || rec.TookMs <= 0 {
		t.Fatalf("the rehearsal is recorded as %+v (%v)", rec, err)
	}
}

// A purge removes versions from the store, and the next encrypted backup's
// staging copy has to lose them too. The staging directory is an ordinary
// backup directory, and an ordinary backup keeps bodies its newest snapshot no
// longer references (S14), so a purged note stayed in plaintext in
// DATA/backup-staging for good: in no archive, and in no place a purge could
// reach. After a pack, staging holds exactly what the archive holds.
func TestAnEncryptedBackupDropsPurgedBodiesFromItsStaging(t *testing.T) {
	dir := seeded(t)
	keyFile := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", keyFile)
	offsite := t.TempDir()
	mustRun(t, "backup", "-data", dir, "-to", filepath.Join(offsite, "first.tar.age"), "-recipients-file", keyFile+".pub")
	staging := filepath.Join(dir, stagingDirName)
	if !stagingHolds(t, staging, "version one") {
		t.Fatal("the first backup did not stage the old version, so this test proves nothing")
	}

	mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	archive := filepath.Join(offsite, "second.tar.age")
	out := mustRun(t, "backup", "-data", dir, "-to", archive, "-recipients-file", keyFile+".pub")
	for _, gone := range []string{"version one", "version two"} {
		if stagingHolds(t, staging, gone) {
			t.Errorf("the purged %q is still in plaintext in %s:\n%s", gone, staging, out)
		}
	}
	if !strings.Contains(out, "purged bodies removed from the staging copy") {
		t.Errorf("the backup does not say it removed them:\n%s", out)
	}
	// What is left is what the archive restores, and it is whole.
	restored := filepath.Join(t.TempDir(), "restored")
	mustRun(t, "unpack", "-from", archive, "-identity", keyFile, "-to", restored)
	if got := mustRun(t, "cat", "-data", restored, "-path", "note.md"); got != "version three" {
		t.Fatalf("the restore reads %q", got)
	}
	if !stagingHolds(t, staging, "version three") || !stagingHolds(t, staging, "part two ") {
		t.Fatal("the staging copy lost a body its database references")
	}
	// And the staging copy still verifies, so the next run copies only what is new.
	if out, err := trew(t, "verify", "-data", staging, "-deep"); err != nil || !strings.Contains(out, "0 faults") {
		t.Fatalf("the pruned staging copy does not verify: %v\n%s", err, out)
	}
}

// stagingHolds says whether any file under dir holds words.
func stagingHolds(t *testing.T, dir, words string) bool {
	t.Helper()
	found := false
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(p) == ".db" || strings.Contains(d.Name(), ".db-") {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		found = found || bytes.Contains(b, []byte(words))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

// Anyone holding the recipient, which is public by design, can make an archive
// that decrypts with the identity: an archive is not proof that this server
// wrote it. unpack and rehearse used to take any such archive without a word.
// Now each compares the archive's digest, and the snapshot time in its
// manifest, with the backup the data directory last recorded, and refuses
// one that is not it unless told it is meant to be another.
func TestUnpackAndRehearseCompareTheArchiveWithTheLastRecordedBackup(t *testing.T) {
	live := seeded(t)
	keyFile := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", keyFile)
	offsite := t.TempDir()
	older := filepath.Join(offsite, "older.tar.age")
	mustRun(t, "backup", "-data", live, "-to", older, "-recipients-file", keyFile+".pub")
	appendOne(t, live, "later.md", "written after the first backup")
	newest := filepath.Join(offsite, "newest.tar.age")
	mustRun(t, "backup", "-data", live, "-to", newest, "-recipients-file", keyFile+".pub")
	var rec doctor.BackupRecord
	if _, err := doctor.ReadRecord(live, doctor.BackupRecordFile, &rec); err != nil || rec.TakenAt == "" {
		t.Fatalf("the backup record does not carry the snapshot time: %+v (%v)", rec, err)
	}

	// rehearse -data LIVE: the last backup is rehearsed as before, and says so.
	out := mustRun(t, "rehearse", "-data", live, "-backup", newest, "-identity", keyFile)
	if !strings.Contains(out, "is the backup this data directory last recorded") {
		t.Fatalf("the rehearsal does not say the archive is the recorded one:\n%s", out)
	}
	// Any other archive is refused before anything is decrypted.
	out, err := trew(t, "rehearse", "-data", live, "-backup", older, "-identity", keyFile)
	if err == nil || !strings.Contains(err.Error(), "is not the backup this data directory last recorded") ||
		!strings.Contains(err.Error(), "-not-last-backup") {
		t.Fatalf("a rehearsal of an archive that is not the recorded one: %v\n%s", err, out)
	}
	if strings.Contains(out, "decrypted and unpacked") {
		t.Fatalf("the refused archive was decrypted:\n%s", out)
	}
	// Unless it is meant: then it goes ahead, warning, with both snapshot times.
	out = mustRun(t, "rehearse", "-data", live, "-backup", older, "-identity", keyFile, "-not-last-backup")
	if !strings.Contains(out, "WARNING") || !strings.Contains(out, rec.TakenAt) {
		t.Fatalf("an accepted other archive is not warned about:\n%s", out)
	}

	// unpack -record DIR does the same.
	to := filepath.Join(t.TempDir(), "restored")
	out, err = trew(t, "unpack", "-from", older, "-identity", keyFile, "-to", to, "-record", live)
	if err == nil || !strings.Contains(err.Error()+out, "is not the backup") {
		t.Fatalf("unpack of an archive that is not the recorded one: %v\n%s", err, out)
	}
	if _, err := os.Stat(to); !os.IsNotExist(err) {
		t.Fatalf("the refused unpack wrote %s (%v)", to, err)
	}
	out = mustRun(t, "unpack", "-from", newest, "-identity", keyFile, "-to", to, "-record", live)
	if !strings.Contains(out, "is the backup this data directory last recorded") {
		t.Fatalf("unpack does not say the archive is the recorded one:\n%s", out)
	}
	// Without a record to compare with, unpack still restores (a disaster
	// may have taken the data directory), and says what it could not check.
	out = mustRun(t, "unpack", "-from", older, "-identity", keyFile, "-to", filepath.Join(t.TempDir(), "r2"))
	if !strings.Contains(out, "Anyone holding its recipient") {
		t.Fatalf("unpack without a record does not say the archive is unchecked:\n%s", out)
	}
}
