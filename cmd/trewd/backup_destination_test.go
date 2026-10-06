package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/doctor"
)

// T35. A plaintext backup publishes its snapshot over whatever database its
// destination holds, and the checks in front of that let a stopped server's
// own data directory through: it is a trewd store, nothing holds its locks,
// and a clean stop leaves no write-ahead log. The backup's own advice to
// restore by pointing the server at the backup directory, followed by the
// unchanged nightly job, or one mistyped -to between two data directories,
// replaced a live store's notes with another's. A directory serve has used is
// refused as a destination, and left exactly as it was.
func TestAPlaintextBackupRefusesAStoppedServersDataDirectory(t *testing.T) {
	a := seeded(t)
	b := seeded(t)
	appendOne(t, b, "only in b.md", "written on the other server")
	// b has been served: serve's own record of its starts is there.
	now := time.Now().UnixMilli()
	if _, err := doctor.NoteStart(b, "0.3.0", 4242, now); err != nil {
		t.Fatal(err)
	}
	if err := doctor.NoteCleanStop(b, now+1000); err != nil {
		t.Fatal(err)
	}
	before := treeDigest(t, b)

	out, err := trew(t, "backup", "-plaintext-ok", "-data", a, "-to", b)
	if err == nil {
		t.Fatalf("a backup was published over a stopped server's data directory:\n%s", out)
	}
	if !strings.Contains(err.Error(), "live data directory") {
		t.Fatalf("the refusal does not say what the destination is: %v", err)
	}
	if after := treeDigest(t, b); after != before {
		t.Fatalf("the refused backup changed the directory:\nbefore\n%s\nafter\n%s", before, after)
	}
	if got := mustRun(t, "cat", "-data", b, "-path", "only in b.md"); got != "written on the other server" {
		t.Fatalf("the other server's note reads %q", got)
	}

	// A directory a backup made stays a destination it can write again.
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", a, "-to", dest)
	out = mustRun(t, "backup", "-plaintext-ok", "-data", a, "-to", dest)
	if strings.Contains(out, "point the server at it") {
		t.Fatalf("the backup still says to serve the backup directory itself:\n%s", out)
	}
}

// T35. An encrypted backup renames its archive over whatever file -to names,
// and only a directory was refused, so `-to` naming the age identity (the two
// flags are easy to mix up during a rehearsal, which needs the identity on
// the machine) replaced the one key that opens every archive. An existing -to
// has to be an age file, which is what an earlier archive there is.
func TestAnEncryptedBackupReplacesOnlyAnArchive(t *testing.T) {
	dir := seeded(t)
	keyDir := t.TempDir()
	key := filepath.Join(keyDir, "trew-backup-key")
	mustRun(t, "backup-key", "-x25519", "-out", key)
	identity, err := os.ReadFile(key)
	if err != nil {
		t.Fatal(err)
	}
	out, err := trew(t, "backup", "-data", dir, "-to", key, "-recipients-file", key+".pub")
	if err == nil {
		t.Fatalf("an encrypted backup was written over the identity:\n%s", out)
	}
	if !strings.Contains(err.Error(), "not an age archive") {
		t.Fatalf("the refusal does not say why: %v", err)
	}
	if after, _ := os.ReadFile(key); !bytes.Equal(after, identity) {
		t.Fatal("the identity changed")
	}

	// The archive a backup wrote is replaced by the next one, as every
	// nightly job needs.
	archive := filepath.Join(t.TempDir(), "trew.tar.age")
	mustRun(t, "backup", "-data", dir, "-to", archive, "-recipients-file", key+".pub")
	first, _ := os.ReadFile(archive)
	appendOne(t, dir, "later.md", "after the first archive")
	mustRun(t, "backup", "-data", dir, "-to", archive, "-recipients-file", key+".pub")
	if second, _ := os.ReadFile(archive); bytes.Equal(first, second) {
		t.Fatal("the second backup did not replace the first archive")
	}
}
