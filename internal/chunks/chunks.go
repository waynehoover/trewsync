// Package chunks is a content-addressed store for chunk bodies.
//
// It is deliberately free of any dependency on the entry store, the wire
// protocol or SQLite: a chunk is bytes under a name, and everything this
// package does can be exercised with nothing but a temp directory. That
// boundary is the one worth keeping clean, because it is where "do not lose a
// note" turns into fsync ordering.
//
// The bytes here are the raw chunks of the vault's files, in the clear, and a
// chunk's name is the SHA-256 of them, so the server can recompute every name
// from what it holds (PLAN.md section 2.2). How a chunk crossed the wire, raw or
// deflated, is the transport's business and never reaches this package.
package chunks

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/waynehoover/trewsync/internal/fsync"
)

// NameLen is the length of a chunk name in characters.
//
// A chunk name is the lowercase hex SHA-256 of the raw chunk bytes, for two
// reasons.
//
// The first is verification. If the server cannot recompute the name from the
// body, it cannot tell a correct chunk from a corrupt one, and "stored" becomes
// a claim rather than a fact. Rule 4 of the philosophy doc is about exactly
// this: verify the outcome, not the exit code.
//
// The second is that a fixed-width hex name makes path traversal impossible by
// construction. An arbitrary client-supplied string used as a filename is a
// directory traversal waiting to happen, and defending against it by re-hashing
// the string would throw away verification to buy back the safety the fixed
// format already provides.
const NameLen = sha256.Size * 2

var (
	// ErrBadName is a name that is not a lowercase hex SHA-256.
	ErrBadName = errors.New("chunk name is not a hex sha-256")
	// ErrCorrupt is a body whose hash does not match the name it is stored
	// under. It is never a normal condition and never retried away: the chunk
	// on disk is not the chunk the client uploaded.
	ErrCorrupt = errors.New("chunk body does not match its name")
	// ErrTooLarge is a body above the store's configured chunk ceiling.
	ErrTooLarge = errors.New("chunk exceeds chunkMax")
	// ErrNotFound is a chunk this vault does not hold.
	ErrNotFound = errors.New("chunk not found")
)

// Name returns the chunk name for a body: what the client is required to have
// computed. Used by Put to verify, and by tests to build realistic inputs.
func Name(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// ValidName reports whether s is a well-formed chunk name.
//
// Case matters. Accepting both cases would give one chunk two names, two
// files on disk, and a dedup miss that looks like a bandwidth mystery rather
// than a bug. The wire format has one spelling.
func ValidName(s string) bool {
	if len(s) != NameLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}

// Store holds chunk bodies under dir, namespaced per vault.
type Store struct {
	dir string
	max int64

	// mkdirMu serialises directory creation, so that a directory another
	// writer can see is a directory whose own name is already durable. See
	// mkdirAll for the race it closes.
	mkdirMu sync.Mutex
	// A directory is cached only after its parent flush succeeds. Failed
	// publications remain unknown and are flushed again on the next write.
	publishedDirs map[string]struct{}
	// Publishers share this lock only while renaming a verified temp file.
	// Quarantine holds it exclusively across revalidation and removal, so a
	// stale corruption observation cannot set aside a newly repaired body.
	publicationMu sync.RWMutex

	// unproven is the chunk names this process has placed and cannot yet
	// prove durable: renamed into the directory, and that directory not
	// successfully flushed since. Visible and durable are two different
	// states, a stat cannot tell them apart, and the difference is the one
	// server-side fault a client cannot detect (F05, R05, R06).
	//
	// This is not a presence table, and the distinction is the whole reason it
	// is safe to have. A table that *asserts* presence drifts from the disk and
	// eventually claims a chunk that is gone, which is how an entry becomes
	// unserveable while everything reports healthy; that is why there is no
	// such table here and never should be. This one only ever *withholds*
	// presence. Presence is still a stat; a name in here is reported absent on
	// top of that. Every way it can be wrong ends in a client being asked for a
	// body the server already had, which costs an upload and loses nothing.
	//
	// A name stays here after a failed flush, deliberately. This process cannot
	// prove that name durable and will not pretend otherwise: the chunk reads
	// as absent, the next put writes and flushes it again, and success is what
	// takes it out. Writable startup flushes every existing directory before
	// an empty map can let presence depend on the stat again.
	//
	// It replaced a per-name publication claim that made the second writer of a
	// chunk wait for the first. That closed the same window and introduced a
	// worse one: a batch held every claim until Close, so two batches wanting
	// the same two chunks in opposite orders each held one and waited for the
	// other, for ever (R05). Nothing waits now. Two writers may place the same
	// body at once, which is safe because a name is the hash of its bytes and
	// the rename is atomic, and wasteful only in the rare case that they
	// overlap.
	unprovenMu sync.Mutex
	unproven   map[string]struct{}

	// sync flushes one directory and is fsync.Dir in every non-test build. A
	// test replaces it to see which directories were flushed, because the one
	// fault this package guards against, a name that is not durable, leaves
	// no trace on a disk that did not lose power.
	sync func(dir string) error
	// write puts a body into its temp file and is the plain write in every
	// non-test build. A test replaces it with one that stops short, to prove
	// the size check after it refuses the body (S25).
	write func(f *os.File, body []byte) error

	// fault is a disk that fails, for the tests of another package (PLAN.md
	// M5.5), and nil in every non-test build: see FaultForTest.
	fault atomic.Pointer[Fault]
}

// Fault is a disk that fails, as FaultForTest injects it: Write stands in for
// putting a body into its file (a full disk, a short write), and Sync runs
// before each directory flush and fails it when it returns an error. Either
// may be nil.
type Fault struct {
	Write func(f *os.File, body []byte) error
	Sync  func(dir string) error
}

// FaultForTest makes this store's disk fail as f says, or stops it failing
// with nil. It is for the tests of the server and the commands, which cannot
// fill a disk or fail an fsync on demand; nothing but a test calls it, and
// its name says so, as store.ExecForTest's does. Safe to call while the store
// is in use.
func (s *Store) FaultForTest(f *Fault) { s.fault.Store(f) }

// New opens (and creates) a chunk store rooted at dir.
//
// max is the chunkMax advertised in the handshake. It lives on the store rather
// than being checked by callers so that there is exactly one place a body's
// size is bounded, and no path into Put that forgets to bound it.
func New(dir string, max int64) (*Store, error) {
	return open(dir, max, true)
}

// OpenExisting opens an existing chunk directory without creating storage.
// Diagnostic commands use it so a missing mount stays missing and visible.
func OpenExisting(dir string, max int64) (*Store, error) {
	return open(dir, max, false)
}

func open(dir string, max int64, create bool) (*Store, error) {
	return openWithSync(dir, max, create, fsync.Dir)
}

func openWithSync(dir string, max int64, create bool, syncDir func(string) error) (*Store, error) {
	if max <= 0 {
		return nil, fmt.Errorf("chunks: max must be positive, got %d", max)
	}
	var err error
	dir, err = filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if create {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	} else {
		info, err := os.Stat(dir)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("chunk storage is missing at %s: %w", dir, err)
			}
			return nil, err
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("chunks: %s is not a directory", dir)
		}
	}
	s := &Store{dir: dir, max: max, publishedDirs: map[string]struct{}{}}
	s.sync = func(d string) error {
		if f := s.fault.Load(); f != nil && f.Sync != nil {
			if err := f.Sync(d); err != nil {
				return err
			}
		}
		return syncDir(d)
	}
	s.write = func(f *os.File, body []byte) error {
		if ft := s.fault.Load(); ft != nil && ft.Write != nil {
			return ft.Write(f, body)
		}
		return writeAll(f, body)
	}
	if create {
		if err := s.establishDirectories(); err != nil {
			return nil, fmt.Errorf("flushing chunk directories: %w", err)
		}
	}
	return s, nil
}

// A process restart does not imply a power cycle: visible names may still be
// awaiting the old process's failed fsync. Flush the root and its ancestors,
// then the existing vault/fan-out directories before admitting stored bodies.
// This visits directories only, never enumerating or rereading chunk files.
// Inspection opens deliberately skip it.
func (s *Store) establishDirectories() error {
	for dir := s.dir; ; dir = filepath.Dir(dir) {
		if err := s.sync(dir); err != nil {
			return err
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	vaults, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, vault := range vaults {
		if !vault.IsDir() {
			continue
		}
		vaultDir := filepath.Join(s.dir, vault.Name())
		if err := s.sync(vaultDir); err != nil {
			return err
		}
		s.publishedDirs[vaultDir] = struct{}{}
		leaves, err := os.ReadDir(vaultDir)
		if err != nil {
			return err
		}
		for _, leaf := range leaves {
			if !leaf.IsDir() {
				continue
			}
			leafDir := filepath.Join(vaultDir, leaf.Name())
			if err := s.sync(leafDir); err != nil {
				return err
			}
			s.publishedDirs[leafDir] = struct{}{}
		}
	}
	return nil
}

// writeAll writes the whole body or reports why it could not.
//
// os.File.Write already loops to the full length and reports a short write as
// an error, so this is the plain call. What it exists for is the check in
// place after it, which asks the file how long it is rather than trusting the
// count: a body renamed into place at the wrong length would satisfy Has for
// ever, and the client, told the chunk was held, would never send it again.
func writeAll(f *os.File, body []byte) error {
	n, err := f.Write(body)
	if err != nil {
		return err
	}
	if n != len(body) {
		return fmt.Errorf("short write: %d of %d bytes", n, len(body))
	}
	return nil
}

// Max is the largest body this store accepts, for the handshake to advertise.
func (s *Store) Max() int64 { return s.max }

// Root is the directory every vault's bodies live under.
//
// Exposed so the health check can stat the filesystem the bodies are on, which
// is the one that runs out of room and the one that goes away when a volume
// unmounts.
func (s *Store) Root() string { return s.dir }

// vaultKey derives a fixed-width directory name from a vault id.
//
// Unlike chunk names, a vault id is an arbitrary client-supplied string, so it
// is hashed before it touches the filesystem. There is nothing to verify about
// a vault id, so hashing costs nothing here.
func vaultKey(vaultID string) string {
	sum := sha256.Sum256([]byte(vaultID))
	return hex.EncodeToString(sum[:])
}

// path locates a chunk.
//
// Chunks are namespaced by vault and deliberately NOT shared across vaults.
// Sharing by content would let one vault read another's file by claiming its
// chunk name, and overwrite that content by uploading different bytes under the
// same name. Deduplication stays inside a vault (PLAN.md section 2.2): a
// chunk name is the SHA-256 of plaintext, so sharing names across vaults would
// make one vault a presence oracle for another's content.
func (s *Store) path(vaultID, name string) string {
	// The two-character fan-out keeps directory sizes reasonable on filesystems
	// that degrade with very wide directories.
	return filepath.Join(s.dir, vaultKey(vaultID), name[:2], name)
}

// VaultDir is the root of one vault's chunk storage. Exported for the sweep and
// for tests that need to corrupt a body on purpose.
func (s *Store) VaultDir(vaultID string) string {
	return filepath.Join(s.dir, vaultKey(vaultID))
}

// Path is the on-disk location of a chunk, whether or not it exists.
func (s *Store) Path(vaultID, name string) (string, error) {
	if !ValidName(name) {
		return "", fmt.Errorf("%w: %q", ErrBadName, name)
	}
	return s.path(vaultID, name), nil
}

// Has reports whether this vault already holds the chunk.
//
// Presence is a file on disk and nothing else. There is deliberately no
// presence table: two records of the same fact drift, and a table that claims a
// chunk the disk has lost is how an entry becomes unserveable while everything
// reports healthy.
//
// An unreadable directory is not an absent chunk, but Has cannot say so in its
// signature; it reports false and the caller then asks for the body, which
// fails loudly. Rule 2 says absent and unreadable are different states, and the
// place that distinction has to survive is Put and Get, which return errors.
func (s *Store) Has(vaultID, name string) bool {
	_, ok := s.Size(vaultID, name)
	return ok
}

// Size is Has plus the stored size, from the same stat.
//
// The size matters because an entry declares a size that must be the sum of
// its chunks' lengths, and the stored length is the raw length. A caller
// checking presence is already paying for the stat, so it may as well learn
// what it is admitting.
func (s *Store) Size(vaultID, name string) (int64, bool) {
	if !ValidName(name) {
		return 0, false
	}
	st, err := os.Stat(s.path(vaultID, name))
	if err != nil || !st.Mode().IsRegular() {
		return 0, false
	}
	// A body that is renamed into place and not yet flushed is on the disk and
	// is not stored, and every caller of this asks the second question: the
	// want list a client uploads against, and the reference check a commit is
	// admitted on. Answering from the stat alone let one session skip an
	// upload, and its entry be committed, against a body another session had
	// not made durable yet (R06).
	if !s.held(vaultID, name) {
		return 0, false
	}
	return st.Size(), true
}

// Missing returns the subset of names this vault does not hold, in the order
// given and without repeats. It is the answer to a `put`: the `want` list.
//
// Every name is validated. A malformed name is an error rather than a silent
// omission, because dropping it would produce a shorter want list, the client
// would upload nothing for it, and the entry would then reference a chunk that
// can never arrive. Rule 5: a result smaller than its input is a bug until
// proven otherwise, and here the proof is that the name was well-formed and the
// chunk was genuinely present.
func (s *Store) Missing(vaultID string, names []string) ([]string, map[string]int64, error) {
	seen := make(map[string]struct{}, len(names))
	held := make(map[string]int64, len(names))
	var out []string
	for _, n := range names {
		if !ValidName(n) {
			return nil, nil, fmt.Errorf("%w: %q", ErrBadName, n)
		}
		if _, dup := seen[n]; dup {
			continue
		}
		seen[n] = struct{}{}
		// The size comes from the same stat that answers whether it is there,
		// so handing it back costs nothing and saves the caller a second pass
		// over the same chunks. An already-held batch was stat'ing each chunk
		// three times: here, again to total the bytes, and again at commit.
		// That is the entire server cost of a batch where nothing is new, which
		// is what a folder rename looks like.
		if size, ok := s.Size(vaultID, n); ok {
			held[n] = size
		} else {
			out = append(out, n)
		}
	}
	return out, held, nil
}

func (s *Store) placing(vaultID string, names ...string) {
	s.unprovenMu.Lock()
	defer s.unprovenMu.Unlock()
	if s.unproven == nil {
		s.unproven = map[string]struct{}{}
	}
	for _, n := range names {
		key := vaultID + "/" + n
		if _, waiting := s.unproven[key]; !waiting && s.onDisk(vaultID, n) {
			// Already durable: somebody flushed it, and this write can only
			// arrive at the same bytes.
			continue
		}
		s.unproven[key] = struct{}{}
	}
}

// onDisk is the stat alone, with no opinion about durability. Only `placing`
// and `Size` use it; everything else asks `Size`, which is the honest question.
func (s *Store) onDisk(vaultID, name string) bool {
	st, err := os.Stat(s.path(vaultID, name))
	return err == nil && st.Mode().IsRegular()
}

// proven records that these names are durable: their bodies are on disk and
// every directory holding them has been flushed since.
//
// Only ever called after a successful flush. A failed one leaves the names
// where they are, so they go on reading as absent until somebody writes them
// again, which is the safe direction and the whole point of the map.
func (s *Store) proven(vaultID string, names ...string) {
	s.unprovenMu.Lock()
	defer s.unprovenMu.Unlock()
	for _, n := range names {
		delete(s.unproven, vaultID+"/"+n)
	}
}

// held is whether this name may be treated as durably stored: on the disk, and
// not something this process is part way through publishing.
func (s *Store) held(vaultID, name string) bool {
	s.unprovenMu.Lock()
	_, waiting := s.unproven[vaultID+"/"+name]
	s.unprovenMu.Unlock()
	return !waiting
}

// Put stores a body under its own name, verifying that the two agree.
//
// The write is a temp file, an fsync, a rename, and an fsync of the directory.
// Every step earns its keep:
//
//   - Writing in place would let a crash leave a half-written body that Has
//     then reports as present, and no later push would ever replace it, because
//     the client is told the server already holds that chunk.
//   - Renaming without fsyncing the file means the rename can be durable while
//     the bytes are not.
//   - Renaming without fsyncing the *directory* means the bytes can be durable
//     while the name is not, which is the one server-side fault a client cannot
//     detect: it acked, so it will never send that chunk again.
//
// Put returns once the body is durable. Nothing above it may acknowledge a push
// before that; the entry commit that follows is what makes the ack truthful.
// A name is marked unproven before the body can become visible and proven only
// once the directory flush has succeeded, so nothing anywhere treats a renamed
// body as a stored one (F05, R06).
//
// A body becomes *visible* when it is renamed into place and *durable* when
// the directory it landed in is flushed, and those are two different moments.
// placing records that a name is being written and cannot yet be treated as
// held. Call it before the body can become visible.
//
// A name that is already held is left alone, and that is not an optimisation.
// Withholding it would take a chunk somebody else has already made durable and
// report it absent for the length of this write, which refuses a concurrent
// commit that references it perfectly legitimately. Two devices pushing notes
// that share a chunk do this constantly, and the store's own stress test found
// it within a hundred pushes.
//
// Re-publishing a body that is already durable cannot un-durable it: the bytes
// are the hash of the name, so whatever is written is what is already there,
// and the rename is atomic. The worst case is that the same body is written
// twice.
func (s *Store) Put(vaultID, name string, body []byte) error {
	if !ValidName(name) {
		return fmt.Errorf("%w: %q", ErrBadName, name)
	}
	if int64(len(body)) > s.max {
		return fmt.Errorf("%w: %d > %d", ErrTooLarge, len(body), s.max)
	}
	// Withheld across the write *and* the flush below, which is what makes
	// `Has` mean "durable" rather than "renamed" (F05, R06). Not released on
	// the way out: only a successful flush proves this name, and a failed one
	// must leave it reading as absent so the next put writes it again.
	s.placing(vaultID, name)

	// The name-against-body check is place's, so that it happens on whichever
	// goroutine is about to do the write. Storing a body under a claimed name
	// would corrupt the vault invisibly, and storing it under the computed name
	// would leave the entry pointing at a chunk that does not exist.
	dirs, err := s.place(vaultID, name, body)
	if err != nil {
		return err
	}
	for _, dir := range dirs {
		if err := s.sync(dir); err != nil {
			return err
		}
	}
	s.proven(vaultID, name)
	return nil
}

// place does everything Put does except the fsync of the directory the body
// landed in, which it returns. Nothing means the chunk was already there and
// nothing was written.
//
// Split out because a batch of chunks landing in the same directory needs that
// fsync once rather than once each, and because the file fsyncs in a batch can
// then run at the same time. Neither changes what has to be true before an ack:
// every body durable, every name durable. It changes only how many times the
// same directory is flushed to make that so.
//
// The directories on the way to it are flushed by mkdirAll, as they are
// created, rather than being returned here. That is S17: the first chunk of a
// vault creates <root>/<vault>/<ab>/, and flushing <ab>/ makes the body's name
// durable inside a directory whose own name was not, so a crash could lose the
// <ab> entry from <vault>/, or <vault>/ from the root, and take the flushed
// body with it. A directory entry is durable when its parent is flushed, the
// same rule the body follows.
func (s *Store) place(vaultID, name string, body []byte) ([]string, error) {
	// Re-hashed here rather than trusted from the caller, because in a batch the
	// caller and the writer are different goroutines: whoever handed this over
	// has moved on, and if the bytes ever came from a buffer that gets reused,
	// the wrong body would be filed under a correct name and served to a device
	// that could only report it as a chunk that does not match its name.
	//
	// coder/websocket's Conn.Read allocates per message today (io.ReadAll), so
	// this is closing the class rather than a live fault. One SHA-256 over data
	// already in hand, on a server that has the cores.
	if got := Name(body); got != name {
		return nil, fmt.Errorf("%w: claimed %s, computed %s", ErrCorrupt, name, got)
	}

	p := s.path(vaultID, name)
	// A chunk already present is already correct: the name is a hash of the
	// body and the body was verified on the way in. Re-writing it would be a
	// window in which the chunk is a temp file rather than itself.
	if s.Has(vaultID, name) {
		return nil, nil
	}
	dir := filepath.Dir(p)
	if err := s.mkdirAll(dir); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(dir, tmpPrefix+"*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name()) // no-op once the rename has succeeded
	if err := s.write(tmp, body); err != nil {
		tmp.Close()
		return nil, err
	}
	// Ask the file, not the writer (S25). Rule 4: verify the outcome, not the
	// exit code. A body renamed into place at the wrong length would count as
	// held for ever and never be asked for again.
	info, err := tmp.Stat()
	if err != nil {
		tmp.Close()
		return nil, err
	}
	if info.Size() != int64(len(body)) {
		tmp.Close()
		return nil, fmt.Errorf("wrote %d bytes of %d for %s; the body is not stored", info.Size(), len(body), name)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	s.publicationMu.RLock()
	err = os.Rename(tmp.Name(), p)
	s.publicationMu.RUnlock()
	if err != nil {
		return nil, err
	}
	// Only the leaf: every directory above it was flushed by mkdirAll before
	// this body was written into it.
	return []string{dir}, nil
}

// mkdirAll creates dir and any missing ancestors under the store root, and
// flushes the parent of every level it creates before it returns. Once it has
// returned, every directory on the path has a durable name, so the caller has
// nothing left to flush but the one its body lands in.
//
// The creation is serialised, and the flush happens inside that section,
// because "whoever created it is flushing it" was not something the loser of
// the race could rely on. Two sessions each storing the first chunk of a vault
// race on the same Mkdir: the loser got ErrExist, had nothing to flush, flushed
// its leaf and acked, while the winner had not necessarily reached its own
// fsync of <vault>/. A crash in that window loses both bodies with one of them
// acknowledged, which is the one server-side fault a client cannot detect
// (rule 1). Doing the flush before the directory is visible to anyone else
// makes the loser's assumption true instead of hopeful.
//
// The cost is one mutex around two or three syscalls per body, and one fsync
// per directory ever created, which for a vault is its own directory plus 256
// fan-out directories, once each in its life.
func (s *Store) mkdirAll(dir string) error {
	rel, err := filepath.Rel(s.dir, dir)
	if err != nil {
		return err
	}
	s.mkdirMu.Lock()
	defer s.mkdirMu.Unlock()
	cur := s.dir
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		next := filepath.Join(cur, part)
		err := os.Mkdir(next, 0o700)
		switch {
		case err == nil:
			delete(s.publishedDirs, next)
		case errors.Is(err, os.ErrExist):
			// Existence alone is insufficient: a previous parent fsync may
			// have failed after creating this directory.
		default:
			return err
		}
		if _, proven := s.publishedDirs[next]; !proven {
			if err := s.sync(cur); err != nil {
				return err
			}
			s.publishedDirs[next] = struct{}{}
		}
		cur = next
	}
	return nil
}

// Writers is how many chunks a batch fsyncs at once.
//
// An fsync is almost entirely waiting, so doing them one at a time left the
// wire and most of the disk idle: a first sync of a seventeen megabyte vault
// spent twenty-nine of its thirty seconds here.
//
// Sixteen is past the knee on both platforms measured, and this is a server
// somebody runs for their own devices, so there is no other load to protect.
// BenchmarkWriterWidth has the figures and how they were taken.
const Writers = 16

// A Writer stores many bodies at once and reports them durable only when every
// one of them is.
//
// The guarantee is the same one Put makes and it is made at the same moment:
// nothing above this may acknowledge a push until Close returns nil. What the
// batch buys is that the waiting happens in parallel and that a directory is
// flushed once rather than once per chunk it received.
type Writer struct {
	store   *Store
	vaultID string

	work chan writeJob
	wg   sync.WaitGroup

	mu   sync.Mutex
	dirs map[string]struct{}
	err  error
	// Every name this batch placed, so Close can mark them durable once every
	// directory they landed in has been flushed. All of them or none: a batch
	// with one failed flush has proved nothing about any of its names, and
	// working out which names were in which directory to be exact about it
	// would be more machinery for a case that ends in a retry either way.
	placed []string
	// The names this batch has already placed, so a body repeated inside one
	// batch is written once. A chunk name is the hash of its bytes, so the
	// second copy has nothing to add. See run.
	claimed map[string]struct{}
}

type writeJob struct {
	name string
	body []byte
}

// NewWriter starts a batch. Close must be called, and its error is the batch's.
func (s *Store) NewWriter(vaultID string) *Writer {
	return s.newWriterWidth(vaultID, Writers)
}

func (s *Store) newWriterWidth(vaultID string, width int) *Writer {
	w := &Writer{
		store:   s,
		vaultID: vaultID,
		// Bounded, so a fast reader cannot queue the whole upload in memory
		// while the disk is still on the first few chunks.
		work:    make(chan writeJob, width),
		dirs:    map[string]struct{}{},
		claimed: map[string]struct{}{},
	}
	for i := 0; i < width; i++ {
		w.wg.Add(1)
		go w.run()
	}
	return w
}

func (w *Writer) run() {
	defer w.wg.Done()
	for job := range w.work {
		if w.failed() {
			// Something already went wrong and Close will report it. Draining
			// rather than returning, because the sender is still writing to
			// this channel and would block on a closed pool for ever.
			continue
		}
		// Once per name per batch. Two bodies in one batch can share a name,
		// because a chunk name is a hash of its bytes, and the second copy has
		// nothing to add.
		w.mu.Lock()
		_, already := w.claimed[job.name]
		if !already {
			w.claimed[job.name] = struct{}{}
			w.placed = append(w.placed, job.name)
		}
		w.mu.Unlock()
		if already {
			continue
		}

		// Withheld before the write and proven by Close, after the flush: a
		// batch's body becomes visible on `place` and durable pages later, so
		// this is the widest window in the store (F05).
		//
		// Nothing waits here. It used to: each name was claimed and every claim
		// held until Close, so two batches wanting the same two chunks in
		// opposite orders each held one and waited for the other for ever
		// (R05). Two batches may now place the same body at once, which the
		// content-addressed name and the atomic rename make harmless.
		w.store.placing(w.vaultID, job.name)
		dirs, err := w.store.place(w.vaultID, job.name, job.body)
		w.mu.Lock()
		if err != nil && w.err == nil {
			w.err = err
		}
		for _, dir := range dirs {
			w.dirs[dir] = struct{}{}
		}
		w.mu.Unlock()
	}
}

func (w *Writer) failed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err != nil
}

// Add hands one body to the batch. It blocks while every writer is busy, which
// is the backpressure that keeps an upload from being buffered in memory.
//
// The error it returns is a failure from an *earlier* body, reported here so a
// caller reading frames off a socket can stop early. Add returning nil is not a
// promise about this body; only Close is.
//
// It does not hash the body. place does, on the writer that stores it, and a
// body that is not what its name says fails the batch there and is never
// filed under the name. Add hashed it too, on the caller's goroutine, which
// for an upload is the one reading frames off the socket and had hashed every
// body already to know its name: three SHA-256 passes over each body where
// two do.
func (w *Writer) Add(name string, body []byte) error {
	if !ValidName(name) {
		return fmt.Errorf("%w: %q", ErrBadName, name)
	}
	if int64(len(body)) > w.store.max {
		return fmt.Errorf("%w: %d > %d", ErrTooLarge, len(body), w.store.max)
	}
	w.mu.Lock()
	err := w.err
	w.mu.Unlock()
	if err != nil {
		return err
	}
	w.work <- writeJob{name: name, body: body}
	return nil
}

// syncDirs flushes every directory the batch wrote into, bounded the same way
// the bodies are, and returns the first failure after all of them have
// finished. Waiting for the rest matters: a directory left mid-flush while the
// caller unwinds is a name whose durability nobody knows.
func (w *Writer) syncDirs() error {
	dirs := make([]string, 0, len(w.dirs))
	for dir := range w.dirs {
		dirs = append(dirs, dir)
	}
	width := Writers
	if len(dirs) < width {
		width = len(dirs)
	}
	if width == 0 {
		return nil
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	next := make(chan string)
	for i := 0; i < width; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for dir := range next {
				if err := w.store.sync(dir); err != nil {
					mu.Lock()
					if first == nil {
						first = err
					}
					mu.Unlock()
				}
			}
		}()
	}
	for _, dir := range dirs {
		next <- dir
	}
	close(next)
	wg.Wait()
	return first
}

// Close waits for every body and flushes every directory they landed in.
//
// Until this returns nil, no chunk in the batch may be treated as stored. The
// bodies are durable when the workers finish; the *names* are durable only
// after these fsyncs, and a name that is not durable is the one server-side
// fault a client cannot detect, because it was told the chunk arrived.
func (w *Writer) Close() error {
	close(w.work)
	w.wg.Wait()
	if w.err != nil {
		return w.err
	}
	// In parallel, for the reason the bodies are: an fsync is almost entirely
	// waiting. A batch of 256 uniformly distributed names touches about 162 of
	// the 256 shards, and flushing those one at a time put the whole batch's
	// directory latency end to end in front of the acknowledgement, once per
	// batch, for the length of a first sync.
	//
	// Every one of them still completes before this returns, so the barrier is
	// exactly where it was: the names are durable, together, before `proven`
	// and before anything above this acknowledges the push.
	if err := w.syncDirs(); err != nil {
		return err
	}
	// Only here, and only on the way out clean. A batch that failed leaves its
	// names unproven, so they read as absent and the next put writes them
	// again; nothing is stuck waiting on this batch, because nothing waits.
	w.store.proven(w.vaultID, w.placed...)
	return nil
}

// PutAll stores every body under its own name through one Writer, and returns
// once all of them are durable, names included: Close's guarantee, for a
// caller that has the bodies in hand. It is how an MCP write stores the chunks
// of the bytes it computed before it commits the entry that names them
// (PLAN.md section 4.3, step 3), so a body is never referenced before it is
// durable (rule 1). A body the store already holds is written again, which the
// content-addressed name makes harmless.
func (s *Store) PutAll(vaultID string, bodies [][]byte) error {
	w := s.NewWriter(vaultID)
	var first error
	for _, b := range bodies {
		if err := w.Add(Name(b), b); err != nil {
			first = err
			break
		}
	}
	// Close even after a failed Add: it waits for the bodies already handed
	// over, which must not be left mid-write.
	if err := w.Close(); err != nil && first == nil {
		first = err
	}
	return first
}

// Quarantine moves a body that failed verification out of the way.
//
// Presence here is a stat, not a hash: Missing reports a chunk that exists as
// held, so a body that rotted on disk is one the server tells every client it
// already has. The entry referencing it was acknowledged, no client will ever
// send it again, and Get fails for ever. Nothing in an ordinary sync could heal
// that, because healing requires the server to admit it needs the chunk.
//
// So the body is renamed rather than deleted. Renamed, it stops satisfying Has,
// the next put asks for it, and a client that still holds the note sends it
// back. Deleted, the evidence of what went wrong would be gone too, and
// docs/design.md rule 3 is that nothing is destroyed until a verified copy
// exists elsewhere: for a body that fails its own hash there is no copy, only a
// name that no longer means anything.
func (s *Store) Quarantine(vaultID, name string) error {
	if !ValidName(name) {
		return fmt.Errorf("%w: %q", ErrBadName, name)
	}
	// The caller's failed Get may precede another reader's quarantine and a
	// successful repair. Inspect the current body, excluding all publishers
	// until its fate is decided. A correct or already absent body needs no work.
	s.publicationMu.Lock()
	defer s.publicationMu.Unlock()
	_, err := s.Get(vaultID, name)
	if err == nil || errors.Is(err, ErrNotFound) {
		return nil
	}
	if !errors.Is(err, ErrCorrupt) {
		return err
	}
	p := s.path(vaultID, name)
	aside := p + corruptSuffix
	if err := os.Rename(p, aside); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // already gone, which is the state this wanted
		}
		return err
	}
	return s.sync(filepath.Dir(p))
}

// corruptSuffix marks a body that did not match its own name. It is outside the
// hex alphabet, so a quarantined file can never be mistaken for a chunk.
const corruptSuffix = ".corrupt"

// tmpPrefix marks in-progress writes so the sweep leaves them alone.
const tmpPrefix = ".tmp-"

// probeName is the file CheckWritable makes and removes.
//
// Under tmpPrefix on purpose: every walk in this file already skips that, so
// the probe cannot be counted as a body or swept as one, and the debris of a
// crash inside CheckWritable is debris the store already knows how to describe.
const probeName = tmpPrefix + "health"

// CheckWritable says whether a body could be stored here right now (R28).
//
// `statfs` says the volume is mounted and has room. It says nothing about
// whether this process may write to it: a chunk root whose permissions have
// gone, or one on a mount the kernel turned read-only after an I/O error,
// answers `statfs` perfectly and refuses every upload. The only way to know is
// the thing an upload does.
//
// One file created, written and removed, which is one inode for the length of
// the call. The root is not created if it is missing: a health check that
// makes the store it is describing would report a mounted volume where there
// is none.
func (s *Store) CheckWritable() error {
	probe := filepath.Join(s.dir, probeName)
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write([]byte("ok"))
	closeErr := f.Close()
	// Whatever happened above. A probe left behind would be counted by nothing
	// and swept by nothing, but it would still be a file this created and did
	// not clean up.
	_ = os.Remove(probe)
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

// Get returns a chunk body, verified against its name.
//
// Verifying on every read costs one SHA-256 over data that was just read from
// disk, and it is the difference between a client receiving a chunk that will
// fail its own check for reasons it cannot diagnose and the server saying which
// chunk of which vault went bad. Bit rot and a truncated restore both land
// here.
func (s *Store) Get(vaultID, name string) ([]byte, error) {
	if !ValidName(name) {
		return nil, fmt.Errorf("%w: %q", ErrBadName, name)
	}
	body, err := os.ReadFile(s.path(vaultID, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	if err != nil {
		return nil, err
	}
	if got := Name(body); got != name {
		return nil, fmt.Errorf("%w: stored as %s, hashes to %s", ErrCorrupt, name, got)
	}
	return body, nil
}

// GetWithHeadroom is Get with one spare byte, zero, in front of the body: it
// returns buf with the verified body at buf[1:]. A fetch frames every body it
// sends, and a raw frame is one marker byte and then the body, so reading the
// body one byte in lets the marker go in front of it where it already is
// (frame.EncodeWithHeadroom) rather than copying a megabyte to make room.
func (s *Store) GetWithHeadroom(vaultID, name string) ([]byte, error) {
	if !ValidName(name) {
		return nil, fmt.Errorf("%w: %q", ErrBadName, name)
	}
	f, err := os.Open(s.path(vaultID, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	// The size the file has, read to its end, as os.ReadFile reads it: a body
	// that has grown or shrunk on the disk is found by its hash below, exactly
	// as Get finds it.
	buf := make([]byte, 1, 1+info.Size()+1)
	for {
		n, err := f.Read(buf[len(buf):cap(buf)])
		buf = buf[:len(buf)+n]
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(buf) == cap(buf) {
			buf = append(buf, 0)[:len(buf)]
		}
	}
	if got := Name(buf[1:]); got != name {
		return nil, fmt.Errorf("%w: stored as %s, hashes to %s", ErrCorrupt, name, got)
	}
	return buf, nil
}

// Check verifies a stored chunk without returning it. Used by the store's
// deep verify, which walks every entry and must not hold whole files in memory.
func (s *Store) Check(vaultID, name string) error {
	_, err := s.Get(vaultID, name)
	return err
}

// DefaultGrace is how long a chunk is protected from the sweep after it is
// written, regardless of whether anything references it yet.
//
// This exists because of a real livelock, found by running a purge loop against
// concurrent pushes. A push uploads its bodies and only then commits the entry
// that references them, so between those two steps its bodies are unreferenced
// and a sweep will collect them. The entry commit then fails, the client
// re-uploads, and the next sweep takes them again: under any sustained purge
// activity, pushes never complete. Two thirds of the pushes in that test
// starved.
//
// An hour is far longer than any single push and short enough that debris from a
// crashed one is collected on the next purge rather than never. The cost of the
// window is disk; the cost of not having it is a vault that cannot be written
// to while it is being tidied.
const DefaultGrace = time.Hour

// Sweep deletes this vault's chunks that are neither in live nor recently
// written.
//
// live must be the complete set of chunk names referenced by committed entries,
// computed by the caller while holding whatever lock keeps new entries from
// being committed. That lock is load-bearing and this package cannot take it,
// which is why this is a documented precondition rather than something Sweep
// works out for itself.
//
// cutoff is the grace boundary: a chunk whose body was written at or after it is
// kept even when nothing references it, because an in-flight push may be about
// to. The caller passes time.Now().Add(-DefaultGrace). A zero cutoff disables
// the protection and is only correct where nothing can be in flight.
//
// Sweep never reports success it has not verified: a body it fails to remove is
// an error, not a silent omission from the count.
//
// Quarantined counts bodies Quarantine set aside because they failed their own
// hash. They are left in place on purpose, so the sweep reports them rather than
// aborting on them: aborting is how one quarantined body turned every later
// purge into a failure that deleted history and reclaimed nothing.
//
// Complete says whether the walk reached the end of the tree. WalkDir stops at
// the first error, so anything that aborts it leaves counts that describe how
// far it got and not what the vault holds, and a caller must not print them
// (rule 7). One stray file in the first shard used to produce a full report
// reading "0 spared as too recent to collect (0 B)" with every collectible
// orphan in the tree unexamined, followed by advice to re-run with -grace 0,
// which aborts at the same file. TestSweepReportsNothingItDidNotFinishLookingAt
// and TestPurgeDoesNotPrintAReportTheSweepDidNotFinish.
func (s *Store) Sweep(vaultID string, live map[string]struct{}, cutoff time.Time) (SweepReport, error) {
	return s.walk(vaultID, live, cutoff, true)
}

// Reclaimable is Sweep with the deleting taken out: the same walk under the
// same rules, reporting what a sweep would take and touching nothing.
//
// It exists so `stats` and the startup line can say how many bytes a purge
// would give back. An unpurged server grows until `nospace` refuses uploads,
// and the documented answer is the heaviest ceremony there is: stop, back up,
// purge, start. That should happen because somebody was told, not because the
// disk filled.
//
// One walk and not two. A second copy of this loop would be a second set of
// rules about what counts as a body, and on the day they disagreed the preview
// would promise space a purge does not free. So Deleted and DeletedBytes here
// mean "would delete", every other field means what it means after a real
// sweep, and the two cannot drift because there is only one of them.
// TestReclaimablePredictsExactlyWhatAPurgeThenFrees.
//
// Nothing is deleted here, so this does not need the lock a sweep needs. What
// that costs is that a body committed between the caller reading its live set
// and this walk reaching it is counted as reclaimable when it is not: a
// snapshot rather than a promise, which is what a report is.
func (s *Store) Reclaimable(vaultID string, live map[string]struct{}, cutoff time.Time) (SweepReport, error) {
	return s.walk(vaultID, live, cutoff, false)
}

// walk is the body of both Sweep and Reclaimable. remove says which: false
// counts a collectible body and leaves it where it is.
func (s *Store) walk(vaultID string, live map[string]struct{}, cutoff time.Time, remove bool) (SweepReport, error) {
	var rep SweepReport
	root := s.VaultDir(vaultID)
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		// Nothing here to describe, which the walk below would have said too.
		rep.Complete = true
		return rep, nil
	}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory is not an empty one. Aborting leaves the
			// chunks in place; continuing would report a clean sweep of a tree
			// it could not read.
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, tmpPrefix) {
			// An in-progress Put, or the debris of a crashed one. Leaving it
			// costs a little disk; deleting it can pull the file out from under
			// a live upload. Counted rather than skipped in silence: nothing
			// removes these at any grace, so they are space the purge did not
			// reclaim, and saying what was not reclaimed is what this report
			// is for.
			info, statErr := d.Info()
			if statErr != nil {
				// Gone between the readdir and the stat, which for a temporary
				// name is a Put finishing its rename underneath the walk: it
				// is the expected outcome, not a fault, and it is what
				// TestPushesCompleteWhileAPurgeIsRunning produces. Nothing here
				// is about to be deleted on the strength of this stat, so the
				// rule-2 answer below does not apply; only a failure that is
				// not "it is not there" is a failure.
				if os.IsNotExist(statErr) {
					return nil
				}
				return statErr
			}
			rep.Temp++
			rep.TempBytes += info.Size()
			return nil
		}
		if strings.HasSuffix(name, corruptSuffix) {
			// A body Quarantine renamed aside because it did not match its name.
			// It is meant to stay until a client resends the real chunk, so it
			// is counted and skipped, not deleted and not treated as an
			// unexpected file. See Quarantine.
			info, statErr := d.Info()
			if statErr != nil {
				// Same as the temporary names above: this one is counted, not
				// deleted, so a body that has gone between the readdir and the
				// stat is one less thing to report rather than a reason to
				// abandon the sweep.
				if os.IsNotExist(statErr) {
					return nil
				}
				return statErr
			}
			rep.Quarantined++
			rep.QuarantinedBytes += info.Size()
			return nil
		}
		if !ValidName(name) {
			// Not a chunk, not a quarantined body, not an in-progress write:
			// nothing this package puts here. Report it rather than deleting it,
			// because an unexplained file in the blob tree is evidence.
			return fmt.Errorf("unexpected file in chunk store: %s", p)
		}
		if _, keep := live[name]; keep {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			// The body was there a moment ago and now cannot be described.
			// Deleting on the strength of a failed stat is exactly rule 2.
			return statErr
		}
		if !info.ModTime().Before(cutoff) {
			rep.Spared++
			rep.SparedBytes += info.Size()
			return nil
		}
		if remove {
			if rmErr := os.Remove(p); rmErr != nil {
				return rmErr
			}
		}
		rep.Deleted++
		rep.DeletedBytes += info.Size()
		return nil
	})
	rep.Complete = err == nil
	return rep, err
}

// SweepReport is what a sweep did and did not do, in bodies and in bytes.
//
// The bytes are there because the counts alone hid the figure an operator
// purging for space came for. A purge on a server stopped a moment ago spares
// every body it would otherwise take, and "2 spared" reads the same whether the
// window kept back two kilobytes or two gigabytes. Rule 8: the number that says
// what did not happen is as much a number as the one that says what did.
type SweepReport struct {
	Deleted     int
	Spared      int
	Quarantined int
	// Temp is `.tmp-` debris: an in-progress Put, or what a crashed one left.
	// Nothing removes these at any grace, so they are counted here rather than
	// skipped in silence, for the same reason the spared bytes are.
	Temp int

	DeletedBytes int64
	SparedBytes  int64
	// QuarantinedBytes and TempBytes are the same figure for the two kinds of
	// file a sweep walks past. A count with no bytes beside it is the thing
	// this type's own doc comment says is not enough.
	QuarantinedBytes int64
	TempBytes        int64

	// Complete says the walk reached the end of the tree. False means every
	// number above describes how far it got, not what the vault holds, and
	// none of them may be reported as a status (rule 7). See Sweep.
	Complete bool
}

// CountBodies counts the chunk files this store holds, across every vault.
//
// It exists so a backup can report how many bodies are either side of it. A
// backup is expected to hold fewer, because it holds what committed entries
// reference and the source may also hold bodies from a push that has not
// committed; reporting both numbers is what turns that from a discrepancy into
// an explanation.
func (s *Store) CountBodies() (int, error) {
	n := 0
	err := filepath.WalkDir(s.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), tmpPrefix) || strings.HasSuffix(d.Name(), corruptSuffix) {
			// A quarantined body is not a body: it is a chunk the store no
			// longer serves, kept only as evidence until the real one returns.
			// Counting it would overstate what the store holds.
			return nil
		}
		n++
		return nil
	})
	if os.IsNotExist(err) {
		return 0, nil
	}
	return n, err
}

// Footprint is what the chunk tree holds on disk, across every vault: bodies
// and their bytes, bodies quarantined for failing their own hash, and
// unfinished uploads. For `trewd doctor`, which reports the store's size and
// every quarantined body, since each is a note some device has to send again.
type Footprint struct {
	Bodies, Quarantined, Temp          int
	Bytes, QuarantinedBytes, TempBytes int64
}

// Measure walks the chunk tree and counts it. It changes nothing.
func (s *Store) Measure() (Footprint, error) { return s.measure(true) }

// Tally is Measure without the bytes of the bodies, for a check that runs
// every few minutes (doctor's quick mode, which the server's alerts run): a
// listing of each directory, and a stat of only the quarantined and unfinished
// files, the few it reports with their bytes. Measured over a hundred thousand
// bodies at 80 ms against Measure's 280 ms, which stats every one. Bytes is
// zero.
func (s *Store) Tally() (Footprint, error) { return s.measure(false) }

func (s *Store) measure(bodyBytes bool) (Footprint, error) {
	var f Footprint
	err := filepath.WalkDir(s.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		temp, quarantined := strings.HasPrefix(name, tmpPrefix), strings.HasSuffix(name, corruptSuffix)
		var size int64
		if bodyBytes || temp || quarantined {
			info, err := d.Info()
			if err != nil {
				return err
			}
			size = info.Size()
		}
		switch {
		case temp:
			f.Temp++
			f.TempBytes += size
		case quarantined:
			f.Quarantined++
			f.QuarantinedBytes += size
		default:
			f.Bodies++
			f.Bytes += size
		}
		return nil
	})
	if os.IsNotExist(err) {
		return Footprint{}, nil
	}
	return f, err
}
