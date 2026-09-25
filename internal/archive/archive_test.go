package archive

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/store"
)

// staged is a verified backup directory with a vault in it: two notes, one of
// them of several chunks, a superseded version, and a deletion.
func staged(t *testing.T) (dir string, notes map[string]string) {
	t.Helper()
	src := t.TempDir()
	st, err := store.Open(store.DataDir(src))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatal(err)
	}
	notes = map[string]string{}
	put := func(path string, bodies ...string) {
		var names []string
		var size int64
		for _, b := range bodies {
			n := chunks.Name([]byte(b))
			if err := st.Chunks().Put("default", n, []byte(b)); err != nil {
				t.Fatal(err)
			}
			names = append(names, n)
			size += int64(len(b))
		}
		if _, err := st.AppendEntry("default", store.Entry{Path: path, Size: size, MTime: 1, Device: "d",
			Chunks: names}); err != nil {
			t.Fatal(err)
		}
		notes[path] = strings.Join(bodies, "")
	}
	put("a.md", "the first version")
	put("a.md", "the second version, ", "in two chunks")
	put("b.md", "another note")
	if _, err := st.AppendEntry("default", store.Entry{Path: "gone.md", Deleted: true, Device: "d", Chunks: []string{}}); err != nil {
		t.Fatal(err)
	}
	dir = filepath.Join(t.TempDir(), "staged")
	if _, err := st.Backup(dir, false); err != nil {
		t.Fatalf("staging: %v", err)
	}
	return dir, notes
}

func key(t *testing.T) (*age.X25519Identity, []age.Recipient) {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	return id, []age.Recipient{id.Recipient()}
}

// headBytes reads a note's newest bytes out of the data directory at dir.
func headBytes(t *testing.T, dir, path string) string {
	t.Helper()
	st, err := store.OpenForInspection(store.DataDir(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	e, state, _, err := st.EntryAsOf("default", path, 0)
	if err != nil || state != store.PathLive {
		t.Fatalf("%s is %s (%v)", path, state, err)
	}
	var b strings.Builder
	for _, n := range e.Chunks {
		body, err := st.Chunks().Get("default", n)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(body)
	}
	return b.String()
}

// A pack, unpacked with the identity, is the data directory it was packed
// from: every note's bytes, every version, and a deep verify with no fault.
// The archive is ciphertext: none of the notes' words appear in it.
func TestAnArchiveUnpacksToTheDataDirectoryItWasPackedFrom(t *testing.T) {
	dir, notes := staged(t)
	id, rcpt := key(t)
	out := filepath.Join(t.TempDir(), "trew.tar.age")
	rep, err := Pack(dir, out, rcpt)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if sum := sha256.Sum256(raw); hex.EncodeToString(sum[:]) != rep.SHA256 || int64(len(raw)) != rep.Bytes {
		t.Fatalf("the report says %d bytes, sha256 %s, and the file is %d bytes", rep.Bytes, rep.SHA256, len(raw))
	}
	for _, words := range []string{"the second version", "another note", "a.md"} {
		if bytes.Contains(raw, []byte(words)) {
			t.Fatalf("the archive holds %q in the clear", words)
		}
	}
	if info, _ := os.Stat(out); info.Mode().Perm() != 0o600 {
		t.Fatalf("the archive is mode %v", info.Mode().Perm())
	}

	to := filepath.Join(t.TempDir(), "restored")
	f, _ := os.Open(out)
	defer f.Close()
	got, err := Unpack(f, []age.Identity{id}, to)
	if err != nil {
		t.Fatalf("unpack: %v", err)
	}
	if got.Manifest.Bodies != rep.Manifest.Bodies || got.SHA256 != rep.SHA256 {
		t.Fatalf("unpacked %+v, packed %+v", got, rep)
	}
	for path, want := range notes {
		if b := headBytes(t, to, path); b != want {
			t.Fatalf("%s reads %q after the round trip, was %q", path, b, want)
		}
	}
	st, err := store.OpenForInspection(store.DataDir(to))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	v, err := st.Verify(true)
	if err != nil || len(v.Faults) != 0 || v.Entries != 4 {
		t.Fatalf("the unpacked directory verifies with %+v (%v)", v, err)
	}
	if err := store.CheckDataDir(to); err != nil {
		t.Fatalf("the unpacked directory is not a data directory: %v", err)
	}
}

// Only an identity of a recipient reads it; the wrong key is refused before
// anything is written.
func TestTheWrongIdentityReadsNothing(t *testing.T) {
	dir, _ := staged(t)
	_, rcpt := key(t)
	other, _ := key(t)
	out := filepath.Join(t.TempDir(), "trew.tar.age")
	if _, err := Pack(dir, out, rcpt); err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(out)
	defer f.Close()
	to := filepath.Join(t.TempDir(), "restored")
	if _, err := Unpack(f, []age.Identity{other}, to); err == nil {
		t.Fatal("the wrong identity unpacked the archive")
	}
	if entries, _ := os.ReadDir(to); len(entries) != 0 {
		t.Fatalf("the wrong identity wrote %d files", len(entries))
	}
}

// A damaged archive or a truncated one never becomes a data directory: age
// refuses a flipped byte, and an archive that stops before its database has
// written no database, so nothing will serve the half that arrived.
func TestADamagedOrTruncatedArchiveIsNeverADataDirectory(t *testing.T) {
	dir, _ := staged(t)
	id, rcpt := key(t)
	out := filepath.Join(t.TempDir(), "trew.tar.age")
	if _, err := Pack(dir, out, rcpt); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(out)
	for name, damaged := range map[string][]byte{
		"a flipped byte": func() []byte {
			b := append([]byte{}, raw...)
			b[len(b)/2] ^= 0x40
			return b
		}(),
		"cut short": raw[:len(raw)*2/3],
	} {
		to := filepath.Join(t.TempDir(), "restored")
		if _, err := Unpack(bytes.NewReader(damaged), []age.Identity{id}, to); err == nil {
			t.Fatalf("%s: the archive unpacked", name)
		}
		if _, err := os.Stat(filepath.Join(to, dbFileName)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s: a database was written from a damaged archive (%v)", name, err)
		}
	}
}

// An archive that decrypts but is not what it claims is refused: an entry
// whose path escapes the directory, a body that does not hash to its name, a
// database that is not the manifest's, and an archive with no manifest.
func TestAnArchiveThatIsNotWhatItClaimsIsRefused(t *testing.T) {
	id, rcpt := key(t)
	body := []byte("a body")
	name := chunks.Name(body)
	vaultDir := strings.Repeat("a", 64)
	db := []byte("not really a database")
	dbSum := sha256.Sum256(db)
	man := func(bodies int, bodyBytes int64, digest string) []byte {
		b, _ := json.Marshal(Manifest{Format: Format, Product: store.Product, Bodies: bodies, BodyBytes: bodyBytes, Database: digest})
		return b
	}
	type entry struct {
		name string
		data []byte
	}
	pack := func(entries ...entry) []byte {
		var buf bytes.Buffer
		enc, err := age.Encrypt(&buf, rcpt...)
		if err != nil {
			t.Fatal(err)
		}
		tw := tar.NewWriter(enc)
		for _, e := range entries {
			if err := writeEntry(tw, e.name, e.data); err != nil {
				t.Fatal(err)
			}
		}
		tw.Close()
		enc.Close()
		return buf.Bytes()
	}
	good := entry{"chunks/" + vaultDir + "/" + name[:2] + "/" + name, body}
	for what, archive := range map[string][]byte{
		"a path that escapes": pack(entry{ManifestFile, man(1, int64(len(body)), hex.EncodeToString(dbSum[:]))},
			entry{"chunks/../../escaped", body}),
		"a body under another name": pack(entry{ManifestFile, man(1, int64(len(body)), hex.EncodeToString(dbSum[:]))},
			entry{"chunks/" + vaultDir + "/" + name[:2] + "/" + strings.Repeat("0", 64), body}),
		"a database the manifest does not name": pack(entry{ManifestFile, man(1, int64(len(body)), strings.Repeat("0", 64))},
			good, entry{dbFileName, db}),
		"fewer bodies than the manifest": pack(entry{ManifestFile, man(2, int64(len(body)), hex.EncodeToString(dbSum[:]))},
			good, entry{dbFileName, db}),
		"no manifest": pack(good, entry{dbFileName, db}),
	} {
		parent := t.TempDir()
		to := filepath.Join(parent, "restored")
		if _, err := Unpack(bytes.NewReader(archive), []age.Identity{id}, to); err == nil {
			t.Errorf("%s: unpacked", what)
		}
		if _, err := os.Stat(filepath.Join(to, dbFileName)); err == nil {
			t.Errorf("%s: a database was written", what)
		}
		if _, err := os.Stat(filepath.Join(parent, "escaped")); err == nil {
			t.Errorf("%s: a file was written outside the directory", what)
		}
	}
}

// An unpack writes only into a new or empty directory: never over a data
// directory, a live one least of all.
func TestAnUnpackNeverWritesIntoADirectoryThatHoldsAnything(t *testing.T) {
	dir, _ := staged(t)
	id, rcpt := key(t)
	out := filepath.Join(t.TempDir(), "trew.tar.age")
	if _, err := Pack(dir, out, rcpt); err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(out)
	defer f.Close()
	if _, err := Unpack(f, []age.Identity{id}, dir); err == nil {
		t.Fatal("an unpack wrote into the staged data directory")
	}
}

// A pack that fails leaves the archive already at the destination as it was:
// a staged copy with a rotted body refuses to be sealed, and the previous
// archive is still the one there.
func TestAFailedPackLeavesTheLastArchiveInPlace(t *testing.T) {
	dir, _ := staged(t)
	_, rcpt := key(t)
	out := filepath.Join(t.TempDir(), "trew.tar.age")
	if _, err := Pack(dir, out, rcpt); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(out)

	// Rot one body in the staged copy.
	_, chunkDir := store.DataDir(dir)
	var rotted bool
	_ = filepath.WalkDir(chunkDir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && !rotted {
			rotted = os.WriteFile(p, []byte("rot"), 0o600) == nil
		}
		return nil
	})
	if !rotted {
		t.Fatal("no body to rot")
	}
	if _, err := Pack(dir, out, rcpt); err == nil {
		t.Fatal("a staged copy with a rotted body was packed")
	}
	after, _ := os.ReadFile(out)
	if !bytes.Equal(before, after) {
		t.Fatal("the failed pack replaced the archive that was there")
	}
	entries, _ := os.ReadDir(filepath.Dir(out))
	if len(entries) != 1 {
		t.Fatalf("the failed pack left %d files beside the archive", len(entries))
	}
}
