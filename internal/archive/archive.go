// Package archive is the encrypted backup (PLAN.md section 3.6): a verified
// backup directory packed as one tar stream, encrypted with age
// (filippo.io/age) to recipients the operator names, and unpacked again into
// a fresh data directory.
//
// The rule it exists for is that a backup is encrypted, including a backup
// that stays on the same machine: the server reads every note in the clear,
// so a plaintext copy anywhere is the vault for whoever can read that place.
// `trewd backup -encrypt-to` stages an ordinary backup inside the data
// directory, where the plaintext already is, and only ciphertext ever leaves
// it. age because it is small, audited, has no configuration to get wrong, and
// its format authenticates every 64 KiB of payload, so a damaged archive
// fails to decrypt rather than restoring wrong bytes.
//
// The archive holds exactly a data directory: MANIFEST.json first, then every
// body the snapshot references, verified against its name as it is read, then
// backup.json and the database last. Last, and renamed into place only once
// its digest matches the manifest, so an unpack that stops part way has
// written no database, and a directory without one is not a data directory
// any command will serve or report as whole.
//
// What an archive does not prove is who made it. age encrypts to a public
// recipient, and the recipient is meant to sit on the server, so anyone who
// can read it can make an archive the identity opens, holding whatever store
// they like. An archive that decrypts is not one this server wrote: the
// callers compare an archive with the backup its data directory recorded
// (SHA256 here, TakenAt in the manifest) before trusting it as that backup.
package archive

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/config"
	"github.com/waynehoover/trewsync/internal/fsync"
	"github.com/waynehoover/trewsync/internal/store"
)

// ManifestFile is the archive's first entry.
const ManifestFile = "MANIFEST.json"

// Format is the archive layout this build writes and reads.
const Format = 1

// Manifest says what an archive holds, so an unpack can tell a whole one from
// a truncated one before anything is trusted.
type Manifest struct {
	Format  int    `json:"format"`
	Product string `json:"product"`
	// TakenAt is when the snapshot was taken, RFC 3339 in UTC.
	TakenAt string `json:"takenAt"`
	// Bodies is how many chunk bodies follow, and BodyBytes their total.
	Bodies    int   `json:"bodies"`
	BodyBytes int64 `json:"bodyBytes"`
	// Database is the SHA-256 of the database the archive ends with.
	Database string `json:"database"`
	// Settings is the configuration file (trewd.json) the staged backup
	// carried, byte for byte, when there was one: paths and choices, never a
	// secret (T38). In the manifest rather than an entry of its own, because
	// a build from before it reads every other entry as a body and would
	// refuse the archive; this way it unpacks it all the same, without the
	// settings. Unpack hands it back in the report and writes nothing of it:
	// whether to use it is the caller's decision.
	Settings []byte `json:"settings,omitempty"`
}

// maxSettings bounds the settings a manifest carries, well inside what an
// unpack reads of a manifest. trewd.json is a few hundred bytes.
const maxSettings = 256 << 10

// Report is what a pack or an unpack did.
type Report struct {
	Manifest Manifest
	// Bytes is the archive's size, ciphertext, and SHA256 its digest, by
	// which an offsite copy can be compared without the key.
	Bytes  int64
	SHA256 string
}

// dbFileName is the database's name in a data directory, and so in the
// archive.
var dbFileName = func() string {
	db, _ := store.DataDir(".")
	return filepath.Base(db)
}()

// maxSmallEntry bounds the manifest and backup.json, which are a few hundred
// bytes each.
const maxSmallEntry = 1 << 20

// ParseRecipients reads age recipients: each argument one recipient, age1...
// or a post-quantum age1pq1..., and each file a recipients file, one per line,
// # comments allowed, as `age -R` reads.
func ParseRecipients(recipients []string, files []string) ([]age.Recipient, error) {
	var out []age.Recipient
	for _, r := range recipients {
		rs, err := age.ParseRecipients(strings.NewReader(r))
		if err != nil {
			return nil, fmt.Errorf("-encrypt-to %q is not an age recipient: %w", r, err)
		}
		out = append(out, rs...)
	}
	for _, f := range files {
		b, err := os.Open(f)
		if err != nil {
			return nil, err
		}
		rs, err := age.ParseRecipients(b)
		b.Close()
		if err != nil {
			return nil, fmt.Errorf("the recipients in %s: %w", f, err)
		}
		out = append(out, rs...)
	}
	if len(out) == 0 {
		return nil, errors.New("no age recipient was given")
	}
	return out, nil
}

// ParseIdentities reads an age identity file, as `age -d -i` reads one.
func ParseIdentities(file string) ([]age.Identity, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	ids, err := age.ParseIdentities(f)
	if err != nil {
		return nil, fmt.Errorf("the identity in %s: %w", file, err)
	}
	return ids, nil
}

type body struct{ vault, name string }

// Pack writes the backup directory staged at dir to out as one age-encrypted
// archive: a temporary file beside out, synced, renamed over it, the directory
// synced. A pack that fails leaves any earlier archive at out as it was.
func Pack(dir, out string, recipients []age.Recipient) (Report, error) {
	var rep Report
	dbPath, chunkDir := store.DataDir(dir)
	meta, err := store.ReadBackupMeta(dir)
	if err != nil {
		return rep, fmt.Errorf("the staged backup at %s: %w", dir, err)
	}
	digest, err := fileDigest(dbPath)
	if err != nil {
		return rep, err
	}
	if meta.Database.Digest != "" && meta.Database.Digest != digest {
		return rep, fmt.Errorf("the staged backup's %s does not describe the database beside it", store.BackupMetaFile)
	}
	bodies, err := referenced(dbPath, chunkDir)
	if err != nil {
		return rep, err
	}
	cs, err := chunks.OpenExisting(chunkDir, store.ChunkMax)
	if err != nil {
		return rep, err
	}
	man := Manifest{Format: Format, Product: store.Product, TakenAt: meta.TakenAt, Bodies: len(bodies), Database: digest}
	switch settings, err := os.ReadFile(config.Path(dir)); {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return rep, fmt.Errorf("reading the staged backup's settings: %w", err)
	case len(settings) > maxSettings:
		return rep, fmt.Errorf("the staged backup's %s is %d bytes, more than settings ever are", config.FileName,
			len(settings))
	default:
		man.Settings = settings
	}
	for _, b := range bodies {
		size, ok := cs.Size(b.vault, b.name)
		if !ok {
			return rep, fmt.Errorf("the staged backup is missing body %s, which its database names", b.name)
		}
		man.BodyBytes += size
	}

	f, err := os.CreateTemp(filepath.Dir(out), "."+filepath.Base(out)+".tmp-")
	if err != nil {
		return rep, err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // a no-op once the rename has consumed it
	fail := func(err error) (Report, error) {
		f.Close()
		return rep, err
	}
	if err := f.Chmod(0o600); err != nil {
		return fail(err)
	}
	sum := sha256.New()
	counted := &countingWriter{w: io.MultiWriter(f, sum)}
	enc, err := age.Encrypt(counted, recipients...)
	if err != nil {
		return fail(fmt.Errorf("encrypting: %w", err))
	}
	tw := tar.NewWriter(enc)

	manifest, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		return fail(err)
	}
	if err := writeEntry(tw, ManifestFile, manifest); err != nil {
		return fail(err)
	}
	for _, b := range bodies {
		// Get verifies the body against its name: a rotted body in the
		// staging copy stops the pack rather than being sealed in.
		data, err := cs.Get(b.vault, b.name)
		if err != nil {
			return fail(fmt.Errorf("reading body %s: %w", b.name, err))
		}
		p, err := cs.Path(b.vault, b.name)
		if err != nil {
			return fail(err)
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return fail(err)
		}
		if err := writeEntry(tw, filepath.ToSlash(rel), data); err != nil {
			return fail(err)
		}
	}
	metaBytes, err := os.ReadFile(filepath.Join(dir, store.BackupMetaFile))
	if err != nil {
		return fail(err)
	}
	if err := writeEntry(tw, store.BackupMetaFile, metaBytes); err != nil {
		return fail(err)
	}
	// The database streamed rather than read whole, and hashed on the way
	// in: it is the one entry that can be large.
	if got, err := streamEntry(tw, dbFileName, dbPath); err != nil {
		return fail(err)
	} else if got != digest {
		return fail(errors.New("the staged database changed while it was being packed"))
	}
	if err := tw.Close(); err != nil {
		return fail(err)
	}
	if err := enc.Close(); err != nil {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return rep, err
	}
	// Again at the rename, which is what replaces the file: the caller asked
	// before staging, and a pack can take a while.
	if err := CheckDestination(out); err != nil {
		return rep, err
	}
	if err := os.Rename(tmp, out); err != nil {
		return rep, err
	}
	if err := fsync.Dir(filepath.Dir(out)); err != nil {
		return rep, err
	}
	rep.Manifest, rep.Bytes, rep.SHA256 = man, counted.n, hex.EncodeToString(sum.Sum(nil))
	return rep, nil
}

// FileSHA256 is the SHA-256 of the file at p, the digest a Report's SHA256
// gives an archive, so an archive can be compared with a record of one
// before it is decrypted.
func FileSHA256(p string) (string, error) { return fileDigest(p) }

// ageHeader is how every binary age file starts, and so every archive Pack
// writes.
const ageHeader = "age-encryption.org/v1\n"

// CheckDestination says whether Pack may write its archive at out: nothing is
// there, or an age file is, which is what an earlier archive is (T35).
//
// Pack renames its archive over whatever out names, and only a directory used
// to be refused, so a -to that named the age identity (the two flags are easy
// to mix up during a rehearsal, which needs the identity on the machine)
// replaced the one key that opens every archive with an archive it opens.
// Reproduced: the identity began "# created:" before the backup and
// "age-encryption.org/v1" after. A file that does not start as an age file
// does is not an earlier backup, whatever its name, and nothing is written
// over it. Followed through a symlink, since the rename replaces the link and
// not what it names.
func CheckDestination(out string) error {
	info, err := os.Stat(out)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("-to %s is a directory: an encrypted backup is one file, such as %s",
			out, filepath.Join(out, "trew-backup.tar.age"))
	}
	head := make([]byte, len(ageHeader))
	n := 0
	if info.Mode().IsRegular() {
		f, err := os.Open(out)
		if err != nil {
			return err
		}
		n, _ = io.ReadFull(f, head)
		f.Close()
	}
	if string(head[:n]) != ageHeader {
		return fmt.Errorf("-to %s exists and is not an age archive, so it is not an earlier backup to replace: "+
			"it could be the identity, or anything else. An encrypted backup writes over nothing but an earlier "+
			"archive; choose another name. Nothing was backed up", out)
	}
	return nil
}

// Pruned is what Prune removed.
type Pruned struct {
	Bodies int
	Bytes  int64
}

// Prune removes from the staged backup at dir every file in its chunk tree
// that its database does not reference, so the staging copy holds exactly what
// a Pack of it archives.
//
// An ordinary backup directory keeps such bodies on purpose (S14): they are
// the history the source has purged, and that directory is the one copy of it.
// A staging directory is not a copy of anything. Its archive holds only what
// the database references, so a body left here is in no archive, and it is in
// plaintext inside the data directory, beyond the reach of the purge that
// removed it from the store: a purged note would survive there for good.
// Called only after a Pack has succeeded, under the staging directory's lock.
func Prune(dir string) (Pruned, error) {
	var rep Pruned
	dbPath, chunkDir := store.DataDir(dir)
	bodies, err := referenced(dbPath, chunkDir)
	if err != nil {
		return rep, err
	}
	cs, err := chunks.OpenExisting(chunkDir, store.ChunkMax)
	if err != nil {
		return rep, err
	}
	keep := make(map[string]bool, len(bodies))
	for _, b := range bodies {
		p, err := cs.Path(b.vault, b.name)
		if err != nil {
			return rep, err
		}
		keep[p] = true
	}
	touched := map[string]bool{}
	err = filepath.WalkDir(chunkDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || keep[p] {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if err := os.Remove(p); err != nil {
			return err
		}
		touched[filepath.Dir(p)] = true
		rep.Bodies++
		rep.Bytes += info.Size()
		return nil
	})
	if err != nil {
		return rep, fmt.Errorf("removing unreferenced bodies from the staged backup: %w", err)
	}
	for d := range touched {
		if err := fsync.Dir(d); err != nil {
			return rep, err
		}
	}
	return rep, nil
}

// referenced is every body the database at dbPath names, once each, in a
// stable order.
func referenced(dbPath, chunkDir string) ([]body, error) {
	st, err := store.OpenForInspection(dbPath, chunkDir)
	if err != nil {
		return nil, fmt.Errorf("opening the staged backup: %w", err)
	}
	defer st.Close()
	seen := map[body]bool{}
	var out []body
	if err := st.ChunkRefs(func(vault, name string) error {
		b := body{vault, name}
		if !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].vault != out[j].vault {
			return out[i].vault < out[j].vault
		}
		return out[i].name < out[j].name
	})
	return out, nil
}

func header(name string, size int64) *tar.Header {
	return &tar.Header{Name: name, Mode: 0o600, Size: size, Typeflag: tar.TypeReg,
		ModTime: time.Unix(0, 0), Format: tar.FormatPAX}
}

func writeEntry(tw *tar.Writer, name string, b []byte) error {
	if err := tw.WriteHeader(header(name, int64(len(b)))); err != nil {
		return err
	}
	_, err := tw.Write(b)
	return err
}

// streamEntry writes the file at p as the entry name, and returns the
// SHA-256 of what it wrote.
func streamEntry(tw *tar.Writer, name, p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if err := tw.WriteHeader(header(name, info.Size())); err != nil {
		return "", err
	}
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(tw, sum), f)
	if err != nil {
		return "", err
	}
	if n != info.Size() {
		return "", fmt.Errorf("%s changed size while it was being packed", p)
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// Unpack decrypts the archive in src with identities and writes the data
// directory it holds into dir, which must not exist or must be empty. Every
// body is checked against its name and the database against the manifest; the
// database is written last, under a temporary name renamed into place only
// once it is the one the manifest names, so a directory an unpack did not
// finish holds no database and no command treats it as a data directory.
// Nothing is removed on failure: what was written is a copy of what the
// archive, left untouched, still holds.
func Unpack(src io.Reader, identities []age.Identity, dir string) (Report, error) {
	var rep Report
	if err := emptyOrAbsent(dir); err != nil {
		return rep, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return rep, err
	}
	sum := sha256.New()
	counted := &countingReader{r: io.TeeReader(src, sum)}
	plain, err := age.Decrypt(counted, identities...)
	if err != nil {
		return rep, fmt.Errorf("decrypting: %w", err)
	}
	tr := tar.NewReader(plain)
	var man Manifest
	first, dbDone := true, false
	bodies := 0
	var bodyBytes int64
	dirs := map[string]bool{dir: true}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return rep, fmt.Errorf("reading the archive: %w", err)
		}
		switch {
		case h.Typeflag != tar.TypeReg:
			return rep, fmt.Errorf("the archive holds %q, which is not a regular file", h.Name)
		case dbDone:
			return rep, fmt.Errorf("the archive has %q after its database, which a whole archive never has", h.Name)
		case first:
			if h.Name != ManifestFile || h.Size > maxSmallEntry {
				return rep, fmt.Errorf("the archive starts with %q, not %s: it is not a trewd backup", h.Name, ManifestFile)
			}
			b, err := io.ReadAll(tr)
			if err != nil {
				return rep, fmt.Errorf("reading the archive's manifest: %w", err)
			}
			if err := json.Unmarshal(b, &man); err != nil {
				return rep, fmt.Errorf("the archive's manifest: %w", err)
			}
			if man.Format != Format || man.Product != store.Product {
				return rep, fmt.Errorf("the archive is format %d of %q, and this build reads format %d of %q",
					man.Format, man.Product, Format, store.Product)
			}
			first = false
		case h.Name == store.BackupMetaFile:
			if h.Size > maxSmallEntry {
				return rep, fmt.Errorf("the archive's %s is %d bytes, more than one can be", h.Name, h.Size)
			}
			b, err := io.ReadAll(tr)
			if err != nil {
				return rep, fmt.Errorf("reading %q from the archive: %w", h.Name, err)
			}
			if err := writeFile(filepath.Join(dir, h.Name), b, dirs); err != nil {
				return rep, err
			}
		case h.Name == dbFileName:
			if bodies != man.Bodies || bodyBytes != man.BodyBytes {
				return rep, fmt.Errorf("the archive holds %d bodies of %d bytes, and its manifest says %d of %d",
					bodies, bodyBytes, man.Bodies, man.BodyBytes)
			}
			tmp := filepath.Join(dir, "."+dbFileName+".unpack")
			got, err := streamFile(tmp, tr, h.Size)
			if err != nil {
				return rep, err
			}
			if got != man.Database {
				os.Remove(tmp)
				return rep, errors.New("the archive's database is not the one its manifest names")
			}
			if err := os.Rename(tmp, filepath.Join(dir, dbFileName)); err != nil {
				return rep, err
			}
			dbDone = true
		default:
			if h.Size < 0 || h.Size > store.ChunkMax {
				return rep, fmt.Errorf("the archive's %q is %d bytes, more than a body can be", h.Name, h.Size)
			}
			b, err := io.ReadAll(tr)
			if err != nil {
				return rep, fmt.Errorf("reading %q from the archive: %w", h.Name, err)
			}
			if err := checkBodyPath(h.Name, b); err != nil {
				return rep, err
			}
			bodies++
			bodyBytes += int64(len(b))
			if err := writeFile(filepath.Join(dir, filepath.FromSlash(h.Name)), b, dirs); err != nil {
				return rep, err
			}
		}
	}
	if !dbDone {
		return rep, errors.New("the archive ends before its database: it is truncated, and the directory is not a data directory")
	}
	// Past the tar's end there may be padding; the age stream is read to its
	// authenticated end so a damaged tail is not passed over.
	if _, err := io.Copy(io.Discard, plain); err != nil {
		return rep, fmt.Errorf("the archive's end does not decrypt: %w", err)
	}
	for d := range dirs {
		if err := fsync.Dir(d); err != nil {
			return rep, err
		}
	}
	rep.Manifest, rep.Bytes, rep.SHA256 = man, counted.n, hex.EncodeToString(sum.Sum(nil))
	return rep, nil
}

// checkBodyPath refuses an entry that is not a chunk body at its own name:
// chunks/<vault key>/<first two of the name>/<name>, and bytes whose SHA-256
// is that name. A path that escapes, or a body that is not what it is named,
// is refused before it is written.
func checkBodyPath(name string, b []byte) error {
	parts := strings.Split(name, "/")
	_, chunkDir := store.DataDir(".")
	if len(parts) != 4 || parts[0] != filepath.Base(chunkDir) || path.Clean(name) != name ||
		!isHex64(parts[1]) || !chunks.ValidName(parts[3]) || parts[2] != parts[3][:2] {
		return fmt.Errorf("the archive holds %q, which is not a body's place in a data directory", name)
	}
	if chunks.Name(b) != parts[3] {
		return fmt.Errorf("the body %s in the archive does not hash to its name", parts[3])
	}
	return nil
}

func isHex64(s string) bool {
	if len(s) != 64 || strings.ToLower(s) != s {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// writeFile writes b at target, new and mode 0600, synced, making its parent
// directories at 0700 and remembering them for the final directory sync.
func writeFile(target string, b []byte, dirs map[string]bool) error {
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	for d := parent; !dirs[d]; d = filepath.Dir(d) {
		dirs[d] = true
	}
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// streamFile writes size bytes from r to a new file at target, synced, and
// returns their SHA-256.
func streamFile(target string, r io.Reader, size int64) (string, error) {
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, sum), r)
	if err == nil && n != size {
		err = fmt.Errorf("the archive's database is %d bytes, and its header says %d", n, size)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(target)
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// emptyOrAbsent refuses a destination that already holds anything: an unpack
// never writes over a directory, least of all a live data directory.
func emptyOrAbsent(dir string) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return fmt.Errorf("%s is not empty: an unpack writes only into a new directory", dir)
	}
	return nil
}

func fileDigest(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
