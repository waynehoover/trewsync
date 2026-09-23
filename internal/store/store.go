// Package store persists vault metadata in SQLite and delegates chunk bodies to
// the chunks package.
//
// Paths are plaintext vault-relative paths, checked against the protocol's
// path policy before anything is stored, and chunk names are the SHA-256 of
// the raw bytes the chunk store holds, so the server can recompute every name
// and every size from what it has (PLAN.md section 2.2).
//
// Entries are append-only. A change, a rename and a delete each add a row rather
// than mutating one, which is what makes the uid sequence usable as a resume
// cursor and what makes a deletion a record instead of an absence.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/paths"

	_ "modernc.org/sqlite"
)

// Limits the server enforces and the handshake advertises.
//
// These are constants, not settings. Per the philosophy doc, a question with a
// right answer is answered once in the source with the reasoning next to it,
// rather than becoming a row in a screen that multiplies the untested state
// space.
const (
	// ChunkMax bounds a single chunk body. Content-defined chunking aims for an
	// average far below this; the ceiling exists so that a stretch of content
	// where the rolling hash never fires still produces a chunk the server will
	// accept, and so that one frame can never be arbitrarily large.
	ChunkMax = 1 << 20 // 1 MiB

	// PerFileMax is the largest file this store will ever accept, whatever a
	// server is configured to advertise. It is the bound Validate enforces, and
	// a server's own limit may be lower but never higher.
	//
	// Separate from that limit because they answer different questions. This one
	// is "what can the format hold"; the server's is "what is worth carrying",
	// which depends on the vault and on the devices syncing it.
	PerFileMax = 1 << 28 // 256 MiB

	// DefaultPerFileMax is what a server advertises unless told otherwise.
	//
	// The cost is the client's, not the server's: a download assembles the
	// whole file in one buffer, about twice the file at peak. Basalt measured
	// its encrypting client at about 210 MB plus 2.7 MB per MiB of file, so 64
	// MiB cost about 430 MB and the 256 MiB ceiling about 900 MB; the plaintext
	// client has not been measured again yet, and does less work per byte.
	//
	// 64 MiB by default because the smallest device syncing a vault sets the
	// limit and the plugin has never run on a phone. It covers images, PDFs and
	// an hour of recorded audio, refuses long video loudly with the number in
	// the message, and -max-file raises it as far as the ceiling for a vault
	// that really does hold video on devices that can carry it.
	DefaultPerFileMax = 1 << 26 // 64 MiB

	// MaxChunksPerEntry bounds the chunk list on a put. At PerFileMax with an
	// 8 KiB chunking average a real file needs about 32k chunks, so this is
	// twice the honest worst case. It is bounded because the count is
	// client-supplied and arrives before any body does: without a ceiling a
	// client could claim millions of chunks and park the session.
	MaxChunksPerEntry = 1 << 16 // 65536

	// MaxPathLen bounds a path, in bytes of UTF-8: the protocol's bound, which
	// the path policy in internal/paths enforces (plan/protocol.md, "Paths").
	// Named here too because the read limit's arithmetic is written against
	// the store's constants.
	MaxPathLen = paths.MaxPathBytes

	// MaxDeviceLen bounds a device name.
	//
	// It is a label somebody reads next to a version, nothing more, and it was
	// unbounded: an authenticated client could send megabytes of it, and the
	// server would store a copy on every entry that device ever wrote and put
	// another copy in every broadcast frame. 64 bytes is more than any name
	// anybody would type.
	MaxDeviceLen = 64

	// MaxDeviceIDLen bounds a device identifier, which is the primary key of a
	// devices row and, unlike the name, the device's identity.
	//
	// A device chooses its own: 16 random bytes, 22 characters of base64url.
	// The bound is generous, leaving room for a longer id without letting a
	// client park kilobytes in a primary key. There is no lower bound, because
	// the server cannot check that the bytes were random and pretending to
	// would be a check that passes on "AAAAAAAAAAAAAAAAAAAAAA". What makes a
	// collision safe is the redemption refusing an id the vault already has,
	// not the length.
	MaxDeviceIDLen = 64

	// MaxVaultLen bounds a vault id, for the same reason as MaxDeviceLen and
	// one more: it lands in log lines on every refusal, and it was unbounded
	// (S24). It is hashed before it touches the filesystem, so the bound is
	// about logs and memory rather than paths. 64 is the device bound, and a
	// vault name is the same kind of thing.
	MaxVaultLen = 64
)

var (
	// ErrUnknownVault is a write against a vault id with no row. Callers must
	// EnsureVault first; failing here rather than creating one on the fly means
	// a typo cannot silently become a new empty vault.
	ErrUnknownVault = errors.New("unknown vault")

	// ErrChunkMissing is an entry whose chunks are not all on disk. The entry is
	// not committed. This is the invariant that stops a dangling reference from
	// existing at all: an entry the server cannot serve would make the client
	// retry that download forever, which presents as a sync that never
	// finishes rather than as an error.
	ErrChunkMissing = errors.New("entry references a chunk the server does not hold")

	// ErrBadPath is a path the protocol refuses (plan/protocol.md, "Paths"),
	// answered `badpath`. Every refusal is a *PathError carrying the rule that
	// refused it, which both implementations report identically.
	ErrBadPath = errors.New("path refused")

	// ErrBadEntry is a structurally invalid entry, rejected on the way in.
	// docs/protocol.md: validate at put, with a reason, rather than discovering
	// it on download when it is too late to refuse.
	ErrBadEntry = errors.New("invalid entry")

	// ErrSizeMismatch is an entry whose declared size is not the sum of its
	// chunks' lengths (plan/protocol.md, "Chunk bodies"). It is ErrBadEntry as
	// well, so it is refused as `badentry` like every other shape the entry
	// itself got wrong. See sizeAccountedFor.
	ErrSizeMismatch = fmt.Errorf("%w: the declared size is not the sum of its chunks' lengths", ErrBadEntry)

	// ErrDeviceExists is a registration for a device id this vault already
	// holds. It is its own error because the caller has to be able to tell it
	// from a server fault: a fault is worth retrying and this never is. The one
	// production path that registers a device is an invite's redemption, which
	// refuses an existing id as ErrNoInvite; this is RegisterDevice's, which
	// the tests use to seed a device.
	ErrDeviceExists = errors.New("this vault already has a device with that id")

	// ErrUnknownDevice is an operation naming a device row that is not there,
	// which after revocation is the ordinary state rather than a fault. It is
	// distinct so that a session can tell "you were revoked while connected"
	// from "the database is broken", and stop rather than retry.
	ErrUnknownDevice = errors.New("no such device on this vault")
)

// Entry is one version of one file.
//
// There is no user or owner field. Trew syncs one person's devices, so
// identity would be a column that is always the same value, and the philosophy
// doc refuses teams outright rather than half-building them.
type Entry struct {
	UID     int64  `json:"uid"`
	Path    string `json:"path"`  // plaintext NFC path, checked by the path policy
	Size    int64  `json:"size"`  // bytes, the sum of the chunks' raw lengths
	CTime   int64  `json:"ctime"` // milliseconds, client clock
	MTime   int64  `json:"mtime"`
	Folder  bool   `json:"folder"`
	Deleted bool   `json:"deleted"`
	Device  string `json:"device"`

	// Prev is the previous path on a rename, so a rename is one operation
	// rather than an unrelated delete plus add. It is also what lets the
	// deleted-files list suppress the phantom deletion a rename leaves behind.
	Prev string `json:"prev,omitempty"`

	// nChunks is how many chunk rows this entry was written with, read back
	// from the row.
	//
	// Unexported, so it never reaches the wire: it is not the client's
	// business. It exists so `attachChunks` can tell a chunk list that lost
	// its tail from one that was always that long, which neither the ord
	// sequence nor the size check can see.
	nChunks int

	// Chunks names the raw chunks of this version, in order. Empty for a
	// folder, a deletion, and a zero-byte file, and empty rather than absent:
	// there is no omitempty here, and the read paths fill in an empty slice, so
	// the field is always an array on the wire. A nil slice marshals to JSON
	// null, and a client that iterates it crashes on exactly the entries it is
	// meant to handle without noticing.
	Chunks []string `json:"chunks"`
}

// HasBody reports whether this entry is expected to have chunk bodies behind it.
func (e Entry) HasBody() bool { return !e.Folder && !e.Deleted }

// SyncMode controls SQLite's durability/throughput trade.
//
// FULL fsyncs the WAL on every commit, so a power cut cannot lose an
// acknowledged write. NORMAL is faster and can lose the last few commits, which
// for a sync server means acking a push and then forgetting it. FULL is the
// default because losing a note is worse than a slower write; NORMAL exists for
// tests and benchmarks and is never the shipped setting.
type SyncMode string

const (
	SyncFull   SyncMode = "FULL"
	SyncNormal SyncMode = "NORMAL"
)

// schema is every table and index a store has, as statements that are safe to
// run again on a store that already has them.
//
// No pragmas. A pragma in a statement applies to the one pooled connection
// that ran it, so the ones every connection needs (`busy_timeout`,
// `synchronous`, `foreign_keys` and `temp_store`) are in the connection string
// in open.go, and the one that is a property of the file, `journal_mode`, is set
// once when the store is initialised. `temp_store = MEMORY` in particular is
// load-bearing: see dsn for the production incident behind it and for why it
// used to reach only one connection.
const schema = `
CREATE TABLE IF NOT EXISTS vaults (
  vault_id   TEXT    PRIMARY KEY,
  next_uid   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  -- How many purges have dropped history from this vault. Bumped inside the
  -- purge transaction, and only when the purge removed something, so it moves
  -- exactly when versions leave the store for good.
  --
  -- It exists for backups. A backup directory never deletes a body, so after a
  -- purge it holds history the source no longer has, and the runbook is to
  -- start a fresh directory and keep the old one. Deciding which directory is
  -- the one with the history in it needs a number that says which side of a
  -- purge each was taken on, and this is that number; backup.json records it.
  purges     INTEGER NOT NULL DEFAULT 0
);

-- One row per device that may reach this vault. The device chooses its own
-- device_id (16 random bytes, base64url) and its own 32-byte token, and the
-- row holds only the token's hash (HashToken), so the server can recognise a
-- device and can never be one. name is a label a person reads; device_id is
-- the identity.
--
-- Revoking is a DELETE and not a revoked_at flag. A tombstone invites the
-- question "is this row still checked", and the answer must never be "it
-- depends on a flag": the whole value of revocation is that it is obvious
-- from the outside whether a device can still connect. Gone is gone. Nothing
-- is lost by it either, because the audit trail is elsewhere and untouched:
-- entries.device records which device wrote every version, and revoking does
-- not rewrite history.
CREATE TABLE IF NOT EXISTS devices (
  vault_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,   -- 16 random bytes, base64url, chosen by the device
  name       TEXT    NOT NULL DEFAULT '',
  auth_hash  TEXT    NOT NULL,   -- hex SHA-256 of the device's 32 raw token bytes
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, device_id)
);
` + invitesSchema + `
CREATE TABLE IF NOT EXISTS entries (
  vault_id  TEXT    NOT NULL,
  uid       INTEGER NOT NULL,
  path      TEXT    NOT NULL,
  size      INTEGER NOT NULL DEFAULT 0,
  ctime     INTEGER NOT NULL DEFAULT 0,
  mtime     INTEGER NOT NULL DEFAULT 0,
  folder    INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  device    TEXT    NOT NULL DEFAULT '',
  prev_path TEXT    NOT NULL DEFAULT '',
  -- How many chunk rows this entry was written with.
  --
  -- The ord sequence catches a gap in the middle and the size check catches a
  -- list that lost every row, and between them sits the case neither sees: a
  -- truncated tail. Three chunks becoming two passes both, and the entry then
  -- reads as a complete shorter file. Nothing recorded what the writer wrote,
  -- so nothing could tell. Always written, so there is no "unknown" value.
  n_chunks  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, uid)
);

-- One row per chunk reference, ordered. A serialised list on the entry would be
-- smaller, but the live set for the chunk sweep would then have to be recovered
-- by parsing every row, and a parse failure there deletes data.
CREATE TABLE IF NOT EXISTS entry_chunks (
  vault_id TEXT    NOT NULL,
  uid      INTEGER NOT NULL,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (vault_id, uid, ord),
  FOREIGN KEY (vault_id, uid) REFERENCES entries(vault_id, uid) ON DELETE CASCADE
);

-- Serves "latest version of path" and the per-path grouping behind Deleted,
-- Stats and Purge. "Everything newer than my cursor" is the primary key.
CREATE INDEX IF NOT EXISTS entries_by_path ON entries(vault_id, path, uid DESC);

-- Makes the live-set query for the chunk sweep an index scan rather than a
-- table scan, and makes "is this chunk still referenced" answerable.
CREATE INDEX IF NOT EXISTS entry_chunks_by_name ON entry_chunks(vault_id, name);

-- Deleted() suppresses a deletion whose path was reused by a later rename, and
-- that subquery matches on prev_path, which was in no index. It scanned every
-- entry newer than the deletion and filtered in memory, once per deleted path:
-- 112 ms against 5.6 ms with this, and the write it costs is 5 us against a
-- chunk fsync of 7.8 ms.
CREATE INDEX IF NOT EXISTS entries_by_prev ON entries(vault_id, prev_path, uid);
` + liveSchema + mcpTokensSchema + oplogSchema

// Store is the server's whole persistent state: entries in SQLite, bodies in a
// chunk store.
type Store struct {
	db     *sql.DB
	chunks *chunks.Store
	dbPath string

	// identity is the store's identity row, read and validated when it was
	// opened, before anything was written (PLAN.md section 2.8).
	identity Identity

	// readOnly is whether this handle was opened for inspection.
	//
	// The health check writes, deliberately, because a `SELECT 1` cannot see a
	// store that answers reads and refuses them (R15). Every inspection
	// command opens read-only, deliberately, because a diagnostic that
	// modifies what it is diagnosing is not one (I15). Both are right and
	// together they made `trew stats` report every healthy server as unable
	// to take a note, with the free-space numbers it exists to print left at
	// zero because the probe returned before reaching them.
	readOnly bool

	// writeMu serialises writes.
	//
	// It does two things that are not interchangeable with a transaction. It
	// makes uids both allocated and *visible* in order, because a uid that
	// became visible out of order would make a client using it as a cursor skip
	// a file. And it spans the gap between "these chunks are on disk" and "this
	// entry is committed", which is a filesystem check followed by a SQL commit
	// and therefore cannot be one transaction. The chunk sweep takes the same
	// lock, which is what makes that pair atomic with respect to deletion.
	writeMu sync.Mutex

	// betweenCheckAndCommit runs inside AppendEntry, after the chunks have been
	// found and before the transaction opens, and is nil in every non-test
	// build.
	//
	// It exists because that gap is the whole of the "committed implies
	// serveable" argument and it is a few microseconds wide. A test that tried
	// to reach it by timing would be one that passes when the machine is busy.
	betweenCheckAndCommit func()

	// duringBackup runs once per chunk reference while a backup copies bodies,
	// and is nil in every non-test build.
	//
	// It exists because the order inside Backup is the whole correctness
	// argument, and the window it protects is a few microseconds wide. A test
	// that tried to commit inside it by timing would be a test that passes when
	// the machine is busy.
	duringBackup func()

	// afterPublish runs inside Backup, after the snapshot has been renamed over
	// the previous one and before backup.json is written, and is nil in every
	// non-test build. Returning an error from it stands in for a crash in that
	// window, which is the window the coverage file's whole ordering argument
	// is about.
	afterPublish func() error

	// afterPurgeDelete runs inside Purge's transaction, after the DELETE and
	// before the checks, and is nil in every non-test build. Returning an error
	// from it stands in for any post-delete query failing, so a test can prove
	// the delete rolls back rather than standing with the history already gone.
	afterPurgeDelete func() error

	// duringOperation runs inside CommitOperation's transaction after each
	// step that writes, named by the step, and is nil in every non-test
	// build. Returning an error stands in for that statement failing, so a
	// test can prove a failure anywhere in the operation leaves nothing of it
	// behind. failOperationCommit, when set, replaces the COMMIT with a
	// rollback and this error, standing in for the one failure whose outcome
	// cannot be stated.
	duringOperation     func(step string) error
	failOperationCommit error

	// now is the clock operations are committed and pins expire by, and
	// retention the windows a new operation's pins and reply are given; see
	// SetClock and SetRetention. The clock is read without writeMu, so it is
	// held atomically; the retention is read and written only under it.
	now       atomic.Pointer[func() time.Time]
	retention Retention

	// subs are the channels Subscribe handed out, nudged after every commit
	// that appends entries; see Committed. Guarded by subMu, never by writeMu,
	// so a subscriber can never hold up a commit.
	subMu sync.Mutex
	subs  map[chan struct{}]struct{}
}

// Open uses SyncFull. Use OpenWithSync only to trade durability for speed in a
// test or a benchmark.
func Open(dbPath, chunkDir string) (*Store, error) {
	return OpenWithSync(dbPath, chunkDir, SyncFull)
}

// OpenWithSync is Open with a chosen durability mode. Both create what is not
// there and migrate what is; see OpenMode in open.go for the other contracts
// and for why there are any.
func OpenWithSync(dbPath, chunkDir string, mode SyncMode) (*Store, error) {
	return OpenMode(dbPath, chunkDir, Create, mode)
}

// OpenForInspection opens a store to be looked at and not changed (I15).
//
// What `verify`, `stats` and a backup's coverage report want. It refuses a
// directory that is not already a store rather than creating one, does not
// migrate, and the handle itself is read-only, so "this command does not modify
// what it inspects" is enforced by SQLite rather than remembered by the caller.
func OpenForInspection(dbPath, chunkDir string) (*Store, error) {
	return OpenMode(dbPath, chunkDir, ReadOnly, SyncFull)
}

func (s *Store) Close() error { return s.db.Close() }

// ExecForTest runs one statement against the database.
//
// A seam for tests that have to produce a store in a state no code path can
// reach: a backup whose row differs from the source in a field nothing here
// would ever change on its own, for instance, which is what proves the purge's
// comparison looks at every field (R04). Named so that its one legitimate use
// is obvious and any other is not.
func (s *Store) ExecForTest(statement string, args ...any) error {
	_, err := s.db.Exec(statement, args...)
	return err
}

// Chunks exposes the chunk store for the put/get paths, which upload and serve
// bodies without touching an entry.
func (s *Store) Chunks() *chunks.Store { return s.chunks }

// EnsureVault creates the vault row if it is absent. now is milliseconds.
func (s *Store) EnsureVault(vaultID string, now int64) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.ensureVaultLocked(vaultID, now)
}

// ensureVaultLocked is EnsureVault for a caller already holding writeMu.
func (s *Store) ensureVaultLocked(vaultID string, now int64) error {
	if vaultID == "" {
		return fmt.Errorf("%w: empty vault id", ErrBadEntry)
	}
	_, err := s.db.Exec(
		`INSERT INTO vaults (vault_id, next_uid, created_at) VALUES (?, 1, ?)
		 ON CONFLICT(vault_id) DO NOTHING`, vaultID, now)
	return err
}

/* ---------------------------------------------------------------- *
 * Writing
 * ---------------------------------------------------------------- */

// isHex64 is the shape of a SHA-256 digest written out, which is what a stored
// credential is.
func isHex64(v string) bool {
	if len(v) != 64 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// PathError is a path the protocol refuses, and which of its rules refused it.
//
// The message begins with the reason code and a colon, "dotprefix: the path
// ...", because the reason has to reach the person whose file will not sync
// (PLAN.md section 4.9) and the wire has one code for all of them. A client
// reads the reason as the text before the first colon. The codes and their
// order are the fixture's, shared with the TypeScript client.
type PathError struct {
	// Field is "path" or "prev": which of the entry's two paths it is.
	Field  string
	Reason paths.Reason
	// Len is the length in bytes the reason is about, which the message gives
	// so the number that is wrong is in front of the person: the whole path's
	// for "toolong", the first segment over the limit for "segmenttoolong".
	Len int
}

// pathError is the PathError for p, refused by paths.Check with reason r.
func pathError(field, p string, r paths.Reason) *PathError {
	n := len(p)
	if r == paths.ReasonSegmentLong {
		for _, seg := range strings.Split(p, "/") {
			if len(seg) > paths.MaxSegmentBytes {
				n = len(seg)
				break
			}
		}
	}
	return &PathError{Field: field, Reason: r, Len: n}
}

func (e *PathError) Error() string {
	var why string
	switch e.Reason {
	case paths.ReasonUTF8:
		why = "is not valid UTF-8"
	case paths.ReasonEmpty:
		why = "is empty"
	case paths.ReasonTooLong:
		why = fmt.Sprintf("is %d bytes of UTF-8, and a path is at most %d", e.Len, paths.MaxPathBytes)
	case paths.ReasonSegmentLong:
		why = fmt.Sprintf("has a file or folder name of %d bytes of UTF-8, and a name is at most %d "+
			"on the disks Obsidian runs on", e.Len, paths.MaxSegmentBytes)
	case paths.ReasonControl:
		why = "contains a control character"
	case paths.ReasonNFC:
		why = "is not in Unicode normal form C"
	case paths.ReasonNBSP:
		why = "contains a no-break space (U+00A0 or U+202F), which Obsidian turns into an ordinary space"
	case paths.ReasonBackslash:
		why = "contains a backslash, which Obsidian turns into a slash"
	case paths.ReasonSlash:
		why = "begins or ends with a slash"
	case paths.ReasonEmptySegment:
		why = "has an empty segment"
	case paths.ReasonDotSegment:
		why = "has a segment that is . or .."
	case paths.ReasonDotPrefix:
		why = "has a segment that begins with a dot, and such a path never syncs: it is where " +
			".obsidian, .trash and a client's own state live"
	case paths.ReasonStaging:
		why = "contains " + paths.StagingMark + ", which only a client's half-written file carries"
	default:
		why = "is refused"
	}
	return fmt.Sprintf("%s: the %s %s", e.Reason, e.Field, why)
}

// Unwrap makes a PathError an ErrBadPath.
func (e *PathError) Unwrap() error { return ErrBadPath }

// CheckPaths applies the path policy to an entry's path and, on a rename, to
// the path it came from: the rules of plan/protocol.md, "Paths", through
// internal/paths, which is where they are written down once for the server.
func (e Entry) CheckPaths() error {
	if r := paths.Check(e.Path); r != "" {
		return pathError("path", e.Path, r)
	}
	if e.Prev != "" {
		if r := paths.Check(e.Prev); r != "" {
			return pathError("prev", e.Prev, r)
		}
	}
	return nil
}

// Validate checks an entry's shape. Exported so the session can reject a put
// before reading any body, and so the reason is the same one in both places.
//
// The paths first, and for every kind of entry: a folder and a deletion carry
// a path like any file, and a check that skipped them would store a folder no
// client can create or delete. F20 was exactly that shape: a rule applied to
// files alone, and rows every reader then refused.
func (e Entry) Validate() error {
	if err := e.CheckPaths(); err != nil {
		return err
	}
	if e.Prev == e.Path && e.Prev != "" {
		return fmt.Errorf("%w: prev path equals path", ErrBadEntry)
	}
	if e.Folder && e.Deleted {
		// The client has to decide which one it means; a row that is both is a
		// row nothing can reconstruct a vault from.
		return fmt.Errorf("%w: entry is both a folder and a deletion", ErrBadEntry)
	}
	if e.Size < 0 || e.Size > PerFileMax {
		return fmt.Errorf("%w: size %d outside [0, %d]", ErrBadEntry, e.Size, PerFileMax)
	}
	if len(e.Chunks) > MaxChunksPerEntry {
		return fmt.Errorf("%w: %d chunks, max %d", ErrBadEntry, len(e.Chunks), MaxChunksPerEntry)
	}
	for i, n := range e.Chunks {
		if !chunks.ValidName(n) {
			return fmt.Errorf("%w: chunk %d: %q is not a chunk name", ErrBadEntry, i, n)
		}
	}

	if !e.HasBody() {
		// A folder or a deletion with chunks attached is a client bug, and
		// accepting it would put bodies into the live set that nothing serves.
		if len(e.Chunks) > 0 {
			return fmt.Errorf("%w: folder or deletion carries %d chunks", ErrBadEntry, len(e.Chunks))
		}
		if e.Size != 0 {
			return fmt.Errorf("%w: folder or deletion declares size %d", ErrBadEntry, e.Size)
		}
		return nil
	}

	// A file has chunks if and only if it has content.
	//
	// The forward half: an entry with a size and no chunks reads exactly like an
	// empty file, so a push that lost its chunk list would present as the note
	// having been emptied. That is the silent failure this whole layer exists to
	// refuse.
	if e.Size > 0 && len(e.Chunks) == 0 {
		return fmt.Errorf("%w: size %d with no chunks", ErrBadEntry, e.Size)
	}
	// The reverse half: a zero-byte file carries no chunks. Both shapes were
	// legal, which made an empty note two different things on the wire and a
	// trap for whoever writes the client. The biconditional means the server
	// can check the relationship completely, and an empty note costs no body.
	if e.Size == 0 && len(e.Chunks) > 0 {
		return fmt.Errorf("%w: zero-byte file carries %d chunks; an empty file has none",
			ErrBadEntry, len(e.Chunks))
	}

	return nil
}

// AppendEntry validates the entry, confirms every chunk is already durable, and
// commits it with the next uid.
//
// The order is the durability rule: bodies first, entry second, ack last. The
// caller must have completed every Put before calling this, and must not
// acknowledge the push until this returns. An ack sent earlier means "stored"
// was a claim a crash can expose.
func (s *Store) AppendEntry(vaultID string, e Entry) (int64, error) {
	return s.appendEntry(vaultID, e, nil, 0)
}

// AppendCurrent commits only if this path still has the writer's base version.
// A base of zero asserts there is no live entry (new file or recreation).
func (s *Store) AppendCurrent(vaultID string, e Entry, base, prevBase int64) (int64, error) {
	if e.Prev == "" && prevBase != 0 {
		return 0, fmt.Errorf("%w: prevBase requires a previous path", ErrBadEntry)
	}
	if err := ValidateBase(base); err != nil {
		return 0, err
	}
	if err := ValidateBase(prevBase); err != nil {
		return 0, err
	}
	return s.appendEntry(vaultID, e, &base, prevBase)
}

// ManyResult is one entry's outcome inside an AppendMany, in the order the
// entries were given. Exactly one of UID and Err is set.
type ManyResult struct {
	UID int64
	Err error
}

// AppendMany commits a batch of conditional writes in one transaction, keeping
// each entry's own refusal (R083-23).
//
// The cost this exists to remove is fsync. Every commit is a transaction under
// `synchronous=FULL`, so a batch of N entries was N fsyncs, and research.md
// measured a 2,000-note folder rename at 549 ms of almost nothing else: the
// batch carries no bodies, so the syncs are the whole of it. The same document
// records one-transaction-per-batch as saving 0.7% of an *upload*, which is
// true and is a different shape of batch, one dominated by the chunk bodies
// that were already written before any of this runs.
//
// A savepoint per entry is what keeps the two properties from fighting. The
// outer transaction pays one fsync; the inner savepoint is rolled back for an
// entry that is stale or malformed, so that entry is refused by itself and the
// rest of the batch still commits, which is what the acks promise. A rolled
// back savepoint also gives back the uid it took, because the base checks run
// before the sequence is touched.
//
// All or nothing on infrastructure failure, and per entry on the client's own
// mistakes. That is the same division the per-entry version had: a disk error
// took the whole batch down there too, because it took the connection with it.
func (s *Store) AppendMany(vaultID string, entries []Entry, bases, prevBases []int64) ([]ManyResult, error) {
	if len(bases) != len(entries) || len(prevBases) != len(entries) {
		return nil, fmt.Errorf("%d entries with %d bases and %d prevBases", len(entries), len(bases), len(prevBases))
	}
	out := make([]ManyResult, len(entries))

	// Every refusal that needs no transaction, before one is opened. These are
	// the same checks `AppendCurrent` makes and in the same order, so a batch
	// of one refuses exactly what a single put refuses.
	pending := make([]int, 0, len(entries))
	for i, e := range entries {
		if err := checkConditional(e, bases[i], prevBases[i]); err != nil {
			out[i] = ManyResult{Err: err}
			continue
		}
		if err := e.Validate(); err != nil {
			out[i] = ManyResult{Err: err}
			continue
		}
		pending = append(pending, i)
	}
	if len(pending) == 0 {
		return out, nil
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	// Presence under the lock, for the reason `appendEntry` gives: checking it
	// earlier would race the chunk sweep, and holding the lock across the check
	// and the commit is what makes "committed implies serveable" true rather
	// than likely.
	still := pending[:0]
	for _, i := range pending {
		if err := s.sizeAccountedFor(vaultID, entries[i]); err != nil {
			out[i] = ManyResult{Err: err}
			continue
		}
		still = append(still, i)
	}
	pending = still
	if len(pending) == 0 {
		return out, nil
	}

	if s.betweenCheckAndCommit != nil {
		s.betweenCheckAndCommit()
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	committed := 0
	for _, i := range pending {
		name := fmt.Sprintf("%s_entry_%d", Product, i)
		if _, err := tx.Exec("SAVEPOINT " + name); err != nil {
			return nil, err
		}
		uid, err := writeEntry(tx, vaultID, entries[i], &bases[i], prevBases[i])
		if err == nil {
			if _, err := tx.Exec("RELEASE SAVEPOINT " + name); err != nil {
				return nil, err
			}
			out[i] = ManyResult{UID: uid}
			committed++
			continue
		}
		// A refusal this entry earned, rolled back on its own. Anything else is
		// the database itself, and a batch that cannot talk to its database has
		// no per-entry answer to give.
		if !errors.Is(err, ErrStale) && !errors.Is(err, ErrBadEntry) && !errors.Is(err, ErrUnknownVault) &&
			!errors.Is(err, ErrCollision) {
			return nil, err
		}
		if _, rerr := tx.Exec("ROLLBACK TO SAVEPOINT " + name); rerr != nil {
			return nil, rerr
		}
		if _, rerr := tx.Exec("RELEASE SAVEPOINT " + name); rerr != nil {
			return nil, rerr
		}
		out[i] = ManyResult{Err: err}
	}

	// The one fsync. Nothing above has been acknowledged and nothing has been
	// broadcast: the caller does both from the results, after this returns.
	if committed > 0 {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		s.notifyCommitted()
	}
	return out, nil
}

// checkConditional is the argument check `AppendCurrent` makes before it looks
// at the entry, kept in one place so a batch refuses what a single put refuses.
func checkConditional(e Entry, base, prevBase int64) error {
	if e.Prev == "" && prevBase != 0 {
		return fmt.Errorf("%w: prevBase requires a previous path", ErrBadEntry)
	}
	if err := ValidateBase(base); err != nil {
		return err
	}
	return ValidateBase(prevBase)
}

// sizeAccountedFor is the presence check and the size invariant, which the
// caller must hold writeMu across: every chunk is a durable body, and the
// declared size is exactly the sum of their lengths (PLAN.md section 2.2).
//
// # Why the sum costs nothing
//
// The size check runs on the hot path of every write, inside the commit lock,
// for up to 256 entries of up to 65,536 chunks each, so its cost was decided
// rather than inherited (PLAN.md section 2.2 asks that it be written down).
// It adds no work: the presence check already stats every chunk under this
// lock, which it must, because presence answered anywhere else races the
// chunk sweep. That stat returns the body's length, and the chunk store holds
// raw chunk bytes named by their SHA-256 and verified when stored, so the
// length on disk is the raw length. Summing what the stat already returned is
// the whole check. No metadata table carries lengths beside the files, so
// there is no second record of a length that could disagree with the file it
// describes.
//
// Every reference counts, repeats included: the declared size counts a
// repeated block once per occurrence, and the sum has to count the same
// thing. Chunks already held are counted exactly like ones uploaded a moment
// ago, which is what makes this the authority: an entry pointing at bodies the
// server has, with nothing uploaded, is checked here and nowhere else.
func (s *Store) sizeAccountedFor(vaultID string, e Entry) error {
	var sum int64
	for i, n := range e.Chunks {
		size, ok := s.chunks.Size(vaultID, n)
		if !ok {
			return fmt.Errorf("%w: chunk %d of %d: %s", ErrChunkMissing, i+1, len(e.Chunks), n)
		}
		// No overflow to guard: 65,536 chunks of at most ChunkMax each is
		// 2^36 bytes, far inside an int64.
		sum += size
	}
	if sum != e.Size {
		return fmt.Errorf("%w: %d chunks holding %d bytes for a declared size of %d",
			ErrSizeMismatch, len(e.Chunks), sum, e.Size)
	}
	return nil
}

// writeEntry is the conditional check and the three inserts, inside whatever
// transaction or savepoint the caller has opened: a device's put and batch,
// and each entry of an agent's operation (CommitOperation), so the three
// cannot come to different conclusions about one write.
func writeEntry(tx execer, vaultID string, e Entry, base *int64, prevBase int64) (int64, error) {
	if base != nil {
		head, deleted, err := pathHead(tx, vaultID, e.Path)
		if err != nil {
			return 0, err
		}
		if head != *base && !(*base == 0 && deleted) {
			return 0, ErrStale
		}
		if e.Prev != "" {
			previous, gone, err := pathHead(tx, vaultID, e.Prev)
			if err != nil {
				return 0, err
			}
			if previous != prevBase && !(prevBase == 0 && gone) {
				return 0, ErrStale
			}
		}
	}

	// The collision rule, after the preconditions so a stale write is told it
	// is stale first, and before a uid is taken so a refused entry gives its
	// uid back with its savepoint.
	if err := checkCollision(tx, vaultID, e); err != nil {
		return 0, err
	}

	var uid int64
	err := tx.QueryRow(
		`UPDATE vaults SET next_uid = next_uid + 1 WHERE vault_id = ?
		 RETURNING next_uid - 1`, vaultID).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("%w: %q", ErrUnknownVault, vaultID)
	}
	if err != nil {
		return 0, err
	}

	if _, err := tx.Exec(
		`INSERT INTO entries (vault_id, uid, path, size, ctime, mtime, folder, deleted, device, prev_path, n_chunks)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		vaultID, uid, e.Path, e.Size, e.CTime, e.MTime,
		boolToInt(e.Folder), boolToInt(e.Deleted), e.Device, e.Prev,
		len(e.Chunks)); err != nil {
		return 0, err
	}

	for i, n := range e.Chunks {
		if _, err := tx.Exec(
			`INSERT INTO entry_chunks (vault_id, uid, ord, name) VALUES (?,?,?,?)`,
			vaultID, uid, i, n); err != nil {
			return 0, err
		}
	}
	// The live set moves with the entry, in the same transaction or savepoint,
	// so the next entry of a batch is checked against the state this one left.
	if err := moveLive(tx, vaultID, e); err != nil {
		return 0, err
	}
	return uid, nil
}

func (s *Store) appendEntry(vaultID string, e Entry, base *int64, prevBase int64) (int64, error) {
	if err := e.Validate(); err != nil {
		return 0, err
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	// Presence is checked here, under the lock, and not by the caller. A caller
	// that checked earlier would be racing the chunk sweep; holding the lock
	// across the check and the commit is what makes "committed implies
	// serveable" true rather than likely.
	//
	// The same stat yields each body's size, and the total must be the size
	// the entry declares. This is the authoritative check: the session bounds
	// uploads as they arrive so a hostile client cannot write the disk full
	// before being refused, but that pre-check can be bypassed by referencing
	// chunks the server already holds, and this one cannot be bypassed at all.
	if err := s.sizeAccountedFor(vaultID, e); err != nil {
		return 0, err
	}

	// The gap the lock exists to cover: the bodies have been found and nothing
	// is committed yet. Nil in every non-test build.
	if s.betweenCheckAndCommit != nil {
		s.betweenCheckAndCommit()
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// The same function `AppendMany` runs inside a savepoint, so a single put
	// and one entry of a batch cannot come to different conclusions about the
	// same write.
	uid, err := writeEntry(tx, vaultID, e, base, prevBase)
	if err != nil {
		return 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	s.notifyCommitted()
	return uid, nil
}

// Quarantine sets a corrupt body aside, under the lock a commit holds.
//
// `AppendEntry` checks that every chunk is present and then commits, both
// inside `writeMu`, and its comment says that is what makes "committed implies
// serveable" true rather than likely. The sweep takes the same lock. It was not
// the only remover of bodies: `Quarantine` is the second, it took no lock, and
// it is the one that runs on a live server.
//
// Without this, A could hold `writeMu`, stat chunk C and get a yes; B could
// serve a fetch of C for another device, find it fails its hash, and rename it
// aside; A would then commit an entry referencing a body the server does not
// hold, and the pushing client -- told the server already had C -- would never
// resend it. Half a second earlier and `AppendEntry` would have answered
// `ErrChunkMissing` and got the good bytes back.
// The chunk store also revalidates under its publication lock: another fetch
// may already have quarantined the bad bytes and a client repaired them.
func (s *Store) Quarantine(vaultID, name string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.chunks.Quarantine(vaultID, name)
}

/* ---------------------------------------------------------------- *
 * Reading
 * ---------------------------------------------------------------- */

// entryCols names every column an entry is read from.
func (s *Store) entryCols() string {
	return `uid, path, size, ctime, mtime, folder, deleted, device, prev_path, n_chunks`
}

// Batch is a covered range of the uid sequence, in the shape the wire protocol
// sends it.
//
// From and To are a *range*, not the first and last uid present. Every entry
// that exists with From <= uid <= To is in Entries, and a client that has
// applied up to From-1 can apply this batch and set its cursor to To. The
// distinction matters because Purge removes history, so the sequence has holes;
// treating From/To as "the uids in this batch" would make every purged hole look
// like a lost file.
type Batch struct {
	From    int64   `json:"from"`
	To      int64   `json:"to"`
	Entries []Entry `json:"entries"`
}

// NextBatch returns the next batch after cursor, or ok=false when the client is
// caught up.
//
// Both queries run in one read transaction so the entries and their chunk lists
// come from the same snapshot. Reading them separately would let a concurrent
// Purge drop the chunk rows of an entry already read, and the entry would then
// be delivered with an empty chunk list: a note that reads as emptied rather
// than as an error.
func (s *Store) NextBatch(vaultID string, cursor int64, limit int) (Batch, bool, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if cursor < 0 {
		return Batch{}, false, fmt.Errorf("%w: negative cursor %d", ErrBadEntry, cursor)
	}

	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Batch{}, false, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(
		`SELECT `+s.entryCols()+` FROM entries
		  WHERE vault_id = ? AND uid > ? ORDER BY uid ASC LIMIT ?`,
		vaultID, cursor, limit)
	if err != nil {
		return Batch{}, false, err
	}
	entries, err := scanEntries(rows)
	rows.Close()
	if err != nil {
		return Batch{}, false, err
	}
	if len(entries) == 0 {
		return Batch{}, false, nil
	}

	b := Batch{From: cursor + 1, To: entries[len(entries)-1].UID, Entries: entries}
	if err := attachChunks(tx, vaultID, b.Entries); err != nil {
		return Batch{}, false, err
	}
	return b, true, nil
}

// EntryByUID returns one version, with its chunk list.
func (s *Store) EntryByUID(vaultID string, uid int64) (Entry, bool, error) {
	return s.oneEntry(vaultID,
		`SELECT `+s.entryCols()+` FROM entries WHERE vault_id = ? AND uid = ?`,
		vaultID, uid)
}

func (s *Store) oneEntry(vaultID, query string, args ...any) (Entry, bool, error) {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Entry{}, false, err
	}
	defer tx.Rollback()

	e, err := scanEntry(tx.QueryRow(query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return Entry{}, false, nil
	}
	if err != nil {
		return Entry{}, false, err
	}
	one := []Entry{e}
	if err := attachChunks(tx, vaultID, one); err != nil {
		return Entry{}, false, err
	}
	return one[0], true, nil
}

// HistoryForPath returns versions of one path, newest first.
//
// beforeUID paginates: pass the oldest uid already held to fetch the page before
// it. Zero starts from the newest.
func (s *Store) HistoryForPath(vaultID, path string, beforeUID int64, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT ` + s.entryCols() + ` FROM entries WHERE vault_id = ? AND path = ?`
	args := []any{vaultID, path}
	if beforeUID > 0 {
		q += ` AND uid < ?`
		args = append(args, beforeUID)
	}
	q += ` ORDER BY uid DESC LIMIT ?`
	args = append(args, limit)

	return s.manyEntries(vaultID, q, args...)
}

// DeletedMax is the most deletions one call will return.
//
// Bounded because a vault accumulates deletions for as long as it exists, and
// an unbounded answer is a single frame that grows without limit. The caller is
// told when it was truncated rather than being handed a short list that looks
// complete: rule 7, and a recovery list quietly missing the note somebody is
// looking for is the worst version of it.
const DeletedMax = 1000

// Deletion is a deleted path, and whether anything survives to restore it from.
//
// The two are separate facts. Purge may remove every content version behind a
// deletion, or retain one as evidence that a moved-away name was reused. The
// list alone therefore says nothing about whether its notes remain recoverable.
type Deletion struct {
	Entry
	// RestorableUID is the newest version of this path with content in it, or
	// zero when purge has taken them all.
	RestorableUID int64 `json:"restorable"`
}

// Deleted returns paths whose newest version is a deletion, newest first, and
// whether there were more than it returned.
//
// suppressRenames drops deletions that were really the source side of a rename.
// Without it every rename shows up as a phantom deletion of a file that still
// exists under another name, and a recovery list that is mostly noise is one
// nobody reads.
//
// # Recognising the tail of a rename
//
// Older history represents a rename with two entries: the new path carrying
// prev, and an explicit deletion at the old path. Current writers retire the
// source through prev alone. For those older deletion records, the test for
// "this deletion is a rename" cannot be "some later entry names this path as
// its prev", because older clients did the two halves in whichever order
// their scans reached them, and the natural order was to publish
// the new path first. That version of this query suppressed one order and not
// the other, and the only test it had used the order clients do not produce.
//
// Nor can the ordering be dropped altogether. A path can be renamed away and
// then used again by a new file, and the deletion of *that* file is real and
// must be listed; a bare "anything ever named this as its prev" would hide it
// forever.
//
// So the test is whether the rename happened after the version of this path
// that is now being deleted, rather than after the deletion record itself:
// there is no intervening incarnation of the path between the rename and the
// deletion. That holds for both orders of the two halves, and stops holding as
// soon as the path is reused.
// beforeUID pages: zero starts at the newest, and any other value asks for
// deletions older than that uid (F21).
//
// The list was capped at DeletedMax with no way past it, and the two clients
// both tried to get past it anyway: the panel doubled the limit it asked for
// and the CLI told people to raise `--limit`, both of which stop working at
// the cap and neither of which said so. The uid is the cursor because that is
// what the rows are ordered by, so a page is stable even while deletions are
// still arriving: a newer one changes what the first page holds and never
// what comes after a given uid.
func (s *Store) Deleted(
	vaultID string,
	suppressRenames bool,
	limit int,
	beforeUID int64,
) ([]Deletion, bool, error) {
	q := `SELECT e.uid, e.path, e.size, e.ctime, e.mtime, e.folder, e.deleted, e.device, e.prev_path,
	             COALESCE((SELECT MAX(r.uid) FROM entries r
	                        WHERE r.vault_id = e.vault_id AND r.path = e.path
	                          AND r.deleted = 0 AND r.folder = 0 AND r.uid < e.uid), 0)
	        FROM entries e
	        JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
	          ON e.path = latest.path AND e.uid = latest.uid
	       WHERE e.vault_id = ? AND e.deleted = 1`
	args := []any{vaultID, vaultID}
	if beforeUID > 0 {
		q += ` AND e.uid < ?`
		args = append(args, beforeUID)
	}
	if suppressRenames {
		q += ` AND NOT EXISTS (
		         SELECT 1 FROM entries r
		          WHERE r.vault_id = e.vault_id
		            AND r.prev_path = e.path
		            AND r.uid > COALESCE(
		                  (SELECT MAX(p.uid) FROM entries p
		                    WHERE p.vault_id = e.vault_id AND p.path = e.path AND p.uid < e.uid),
		                  0))`
	}
	if limit <= 0 || limit > DeletedMax {
		limit = DeletedMax
	}
	// One more than asked for, so "there are more" is a fact rather than a
	// guess from a full page.
	q += ` ORDER BY e.uid DESC LIMIT ?`

	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(q, append(args, limit+1)...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	out := []Deletion{}
	for rows.Next() {
		var d Deletion
		var prev sql.NullString
		if err := rows.Scan(&d.UID, &d.Path, &d.Size, &d.CTime, &d.MTime,
			&d.Folder, &d.Deleted, &d.Device, &prev, &d.RestorableUID); err != nil {
			return nil, false, err
		}
		d.Prev = prev.String
		// A deletion carries no bodies of its own, and the field is an array on
		// the wire for the same reason every other entry list is.
		d.Chunks = []string{}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(out) > limit {
		return out[:limit], true, nil
	}
	return out, false, nil
}

func (s *Store) manyEntries(vaultID, query string, args ...any) ([]Entry, error) {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	out, err := scanEntries(rows)
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err := attachChunks(tx, vaultID, out); err != nil {
		return nil, err
	}
	return out, nil
}

// listedUIDsMax bounds the IN list, because a parameter list is not free and
// SQLite has its own ceiling on how many it will take. Above it the range read
// is the better shape anyway: that many entries at once is a batch.
const listedUIDsMax = 500

// attachChunks fills in Chunks for every entry, in one query.
//
// It reads the whole uid span rather than one query per entry so that a batch of
// 200 entries is two round trips, not 201.
func attachChunks(tx *sql.Tx, vaultID string, entries []Entry) error {
	if len(entries) == 0 {
		return nil
	}
	byUID := make(map[int64]int, len(entries))
	lo, hi := entries[0].UID, entries[0].UID
	for i, e := range entries {
		byUID[e.UID] = i
		if e.UID < lo {
			lo = e.UID
		}
		if e.UID > hi {
			hi = e.UID
		}
		// Empty, not nil: see Entry.Chunks. Every entry leaving this package
		// carries an array, even when it carries no chunks.
		entries[i].Chunks = []string{}
	}

	// A range for a batch, a list for anything scattered.
	//
	// A catch-up batch is contiguous, so BETWEEN reads exactly the rows it
	// wants. A page of one file's history is not: version 1 and version 5 of a
	// note sit thousands of uids apart, so the same range read nearly every
	// chunk row in the vault and threw almost all of it away. Measured at 6.1 ms
	// for a 100 row page over 10k entries, and 83 ms over 100k, against 0.07 ms
	// and 0.3 ms keyed on the uids actually wanted. It grew with the vault's
	// history rather than with the page, and history is paged.
	span := hi - lo + 1
	useList := len(entries) <= listedUIDsMax && span > int64(len(entries))*4

	var rows *sql.Rows
	var err error
	if useList {
		args := make([]any, 0, len(entries)+1)
		args = append(args, vaultID)
		marks := make([]byte, 0, len(entries)*2)
		for i, e := range entries {
			if i > 0 {
				marks = append(marks, ',')
			}
			marks = append(marks, '?')
			args = append(args, e.UID)
		}
		rows, err = tx.Query(
			`SELECT uid, ord, name FROM entry_chunks
			  WHERE vault_id = ? AND uid IN (`+string(marks)+`) ORDER BY uid ASC, ord ASC`,
			args...)
	} else {
		rows, err = tx.Query(
			`SELECT uid, ord, name FROM entry_chunks
			  WHERE vault_id = ? AND uid BETWEEN ? AND ? ORDER BY uid ASC, ord ASC`,
			vaultID, lo, hi)
	}
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var uid, ord int64
		var name string
		if err := rows.Scan(&uid, &ord, &name); err != nil {
			return err
		}
		i, ok := byUID[uid]
		if !ok {
			continue // a uid inside the span that this result set does not cover
		}
		// ord is the wire order of the chunks and the order the client
		// reassembles in. A gap here would concatenate the file wrongly, so it
		// is checked rather than assumed.
		if int(ord) != len(entries[i].Chunks) {
			return fmt.Errorf("entry %d: chunk ord %d out of sequence at position %d",
				uid, ord, len(entries[i].Chunks))
		}
		entries[i].Chunks = append(entries[i].Chunks, name)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	// The property that matters is not "the query returned rows", it is that no
	// entry leaves this layer without the content it claims to have. An entry
	// with a size and no chunks is byte-identical on the wire to an empty file,
	// so a lost chunk list would present to every device as the note having
	// been emptied. Checking it here rather than in each caller means no read
	// path can be added that forgets to.
	for _, e := range entries {
		if e.HasBody() && e.Size > 0 && len(e.Chunks) == 0 {
			return fmt.Errorf("entry %d of vault %q declares size %d and has no chunk rows",
				e.UID, vaultID, e.Size)
		}
		// And as many as it was written with. The ord sequence sees a gap in
		// the middle and the check above sees a list that lost every row; a
		// tail that went missing passes both, and the entry then reads as a
		// complete shorter file.
		if len(e.Chunks) != e.nChunks {
			return fmt.Errorf("entry %d of vault %q was written with %d chunks and has %d",
				e.UID, vaultID, e.nChunks, len(e.Chunks))
		}
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * Vault-level facts
 * ---------------------------------------------------------------- */

func (s *Store) ReferencedChunks(vaultID string, names []string) (map[string]struct{}, error) {
	found := make(map[string]struct{}, len(names))
	if len(names) == 0 {
		return found, nil
	}
	// In batches, because SQLite has a limit on how many parameters one
	// statement may bind and a vault has more chunks than that.
	const batch = 400
	for start := 0; start < len(names); start += batch {
		end := min(start+batch, len(names))
		chunk := names[start:end]
		args := make([]any, 0, len(chunk)+1)
		args = append(args, vaultID)
		holes := make([]byte, 0, len(chunk)*2)
		for i, n := range chunk {
			if i > 0 {
				holes = append(holes, ',')
			}
			holes = append(holes, '?')
			args = append(args, n)
		}
		rows, err := s.db.Query(
			`SELECT DISTINCT name FROM entry_chunks WHERE vault_id = ? AND name IN (`+
				string(holes)+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				return nil, err
			}
			found[name] = struct{}{}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return found, nil
}

// LatestUID is the newest uid in the vault, or 0 if it holds nothing. This is
// the server's cursor in the handshake.
// ReferencedChunks reports which of the given names some committed entry in
// this vault refers to (I14).
//
// The gate on `resend`. A body is content-addressed, so a device cannot put the
// wrong bytes under a name: `chunks.Put` hashes what arrives and refuses it
// otherwise. What it could do without this is put *correct* bytes under names
// nothing refers to, for ever, which is a paired device filling the disk with
// data no vault will ever read and no purge will ever collect until the grace
// window passes. Repair is for bodies the vault is missing, and a name no entry
// mentions is not one of those.
//
// Returned as a set rather than checked one at a time, because repair asks
// about every chunk of every note it holds and a query per name would be one
// round trip through SQLite per body in the vault.
func (s *Store) LatestUID(vaultID string) (int64, error) {
	var uid sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT MAX(uid) FROM entries WHERE vault_id = ?`, vaultID).Scan(&uid); err != nil {
		return 0, err
	}
	return uid.Int64, nil
}

// Stats describes what the vault holds.
//
// Every count is separate on purpose. "Fully synced" has twice meant something
// other than synced, once at cursor 0 against a vault of 4,030 files and once
// with files silently excluded, so this type refuses to collapse into a single
// number or a boolean. A caller that wants a headline
// figure has to choose which of these it means.
type Stats struct {
	Files   int64 // live, non-deleted, non-folder
	Folders int64
	Deleted int64 // paths whose newest version is a deletion
	// Recoverable is how many of those still have a version with content
	// behind them. Purge keeps the newest version per path, and for a
	// deleted note that is the deletion record, so a purge can leave a path
	// deleted and unrecoverable. Reporting only Deleted said "still
	// recoverable" over those, which is rule 7: the two are separate facts.
	Recoverable int64
	Bytes       int64 // sum of declared plaintext sizes of live files
	Versions    int64 // entry rows, including superseded ones
	ChunkRefs   int64 // distinct chunk names referenced by any entry
	LatestUID   int64
	// OldestUID is the smallest uid still present, or 0 for an empty vault.
	// With LatestUID it is the range a backup of this vault covers; a purge
	// moves it up as the oldest versions go.
	OldestUID   int64
	AllocatedTo int64 // next_uid - 1: uids handed out, including purged ones
	// Purges is how many purges have dropped history from this vault; see the
	// column's comment in the schema.
	Purges int64
}

func (s *Store) Stats(vaultID string) (Stats, error) {
	var st Stats
	row := s.db.QueryRow(
		`SELECT
		   COALESCE(SUM(CASE WHEN e.deleted = 0 AND e.folder = 0 THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.folder = 1 THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.deleted = 1 THEN 1 ELSE 0 END), 0),
		   -- The same "is there anything behind it" question Deleted() asks, and
		   -- for the same reason. A deletion with no earlier version holding
		   -- content cannot be restored from, whatever the list says.
		   COALESCE(SUM(CASE WHEN e.deleted = 1 AND EXISTS (
		       SELECT 1 FROM entries r
		        WHERE r.vault_id = e.vault_id AND r.path = e.path
		          AND r.deleted = 0 AND r.folder = 0 AND r.uid < e.uid)
		     THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.deleted = 0 AND e.folder = 0 THEN e.size ELSE 0 END), 0)
		 FROM entries e
		 JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
		   ON e.path = latest.path AND e.uid = latest.uid
		 WHERE e.vault_id = ? AND `+notRetiredByRename, vaultID, vaultID)
	if err := row.Scan(&st.Files, &st.Folders, &st.Deleted, &st.Recoverable, &st.Bytes); err != nil {
		return st, err
	}
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&st.Versions); err != nil {
		return st, err
	}
	if err := s.db.QueryRow(
		`SELECT COUNT(DISTINCT name) FROM entry_chunks WHERE vault_id = ?`,
		vaultID).Scan(&st.ChunkRefs); err != nil {
		return st, err
	}
	var next, purges sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT next_uid, purges FROM vaults WHERE vault_id = ?`, vaultID).Scan(&next, &purges); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return st, err
		}
	}
	st.AllocatedTo = next.Int64 - 1
	st.Purges = purges.Int64
	var oldest sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT MIN(uid) FROM entries WHERE vault_id = ?`, vaultID).Scan(&oldest); err != nil {
		return st, err
	}
	st.OldestUID = oldest.Int64
	var err error
	st.LatestUID, err = s.LatestUID(vaultID)
	return st, err
}

// Oversize is a live file whose declared size is above some ceiling: the uid
// of its newest version, its path and that size.
type Oversize struct {
	UID  int64
	Path string
	Size int64
}

// FilesOver lists the files a device syncing this vault today would download
// and could not, if the server advertised limit as its file ceiling: the
// newest version of each path that is neither deleted nor a folder, where the
// declared size is over limit. Largest first.
//
// Only the newest version per path counts. A superseded version over the
// ceiling is history nobody is sent on a first sync, and a deleted file's
// newest version is its deletion record, which has no size. Counting either
// would mean a ceiling could never be lowered after one large upload without
// a purge, which is a stricter rule than "do not strand a file" needs.
func (s *Store) FilesOver(vaultID string, limit int64) ([]Oversize, error) {
	rows, err := s.db.Query(
		`SELECT e.uid, e.path, e.size
		   FROM entries e
		   JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
		     ON e.path = latest.path AND e.uid = latest.uid
		  WHERE e.vault_id = ? AND `+notRetiredByRename+` AND e.deleted = 0 AND e.folder = 0 AND e.size > ?
		  ORDER BY e.size DESC, e.uid ASC`, vaultID, vaultID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Oversize
	for rows.Next() {
		var o Oversize
		if err := rows.Scan(&o.UID, &o.Path, &o.Size); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Vaults lists every vault id, oldest first.
func (s *Store) Vaults() ([]string, error) {
	rows, err := s.db.Query(`SELECT vault_id FROM vaults ORDER BY created_at ASC, vault_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

/* ---------------------------------------------------------------- *
 * Maintenance
 * ---------------------------------------------------------------- */

// PurgeReport says what a purge did. Rule 5: an operation that makes a list
// smaller reports its arithmetic, so an implausible figure is visible rather
// than inferred from a success message.
type PurgeReport struct {
	VersionsBefore  int64
	VersionsRemoved int64
	VersionsAfter   int64
	ChunksDeleted   int
	ChunksLive      int
	// ChunksSpared were unreferenced but newer than the grace window, so they
	// were kept in case an in-flight push is about to reference them. Reported
	// rather than folded into the deleted count so the numbers add up and a
	// grace window that is doing nothing is visible.
	ChunksSpared int
	// BytesDeleted is what the sweep reclaimed and BytesSpared what the grace
	// window kept from it. Counts alone hid the one figure an operator purging
	// for space came for: "2 spared" is two kilobytes or two gigabytes, and a
	// purge on a just-stopped server spares everything it would otherwise take.
	BytesDeleted int64
	BytesSpared  int64
	// ChunksQuarantined were set aside because they failed their own hash. They
	// are kept until a client resends the real chunk, so a purge counts them
	// rather than collecting them, and reports the count so a body that has gone
	// bad is visible rather than silently sitting in the tree.
	//
	// ChunksTemp is `.tmp-` debris, which nothing removes at any grace. Both
	// carry their bytes, because both are space the purge did not reclaim and
	// a count without bytes is the figure an operator purging for space cannot
	// use.
	ChunksQuarantined int
	ChunksTemp        int
	BytesQuarantined  int64
	BytesTemp         int64

	// SweepComplete says the chunk sweep reached the end of the tree. When it
	// is false every chunk figure above describes how far the walk got rather
	// than what the vault holds, and a caller must not print them as a status
	// (rule 7). The version figures are unaffected: they come from a committed
	// transaction that ran before the sweep.
	SweepComplete bool

	// VersionsPinned is how many of VersionsAfter survived only because an
	// agent's operation pinned them (PLAN.md section 4.5): history this purge
	// would otherwise have dropped, kept as some note's before-image until its
	// pin expires. Its own figure, so a purge that reclaimed less than the
	// operator expected says why (rule 8).
	VersionsPinned int64
	// PinsExpired, RepliesExpired and KeysExpired are the operation records
	// this purge found past their windows and let go: pins that no longer
	// hold a version, recorded replies cleared from their operations, and the
	// idempotency keys that replayed them. The operations themselves stay.
	PinsExpired    int64
	RepliesExpired int64
	KeysExpired    int64
}

// Purge drops version history, keeping current paths, source retirements and
// the versions agents' operations have pinned, then deletes chunk bodies that
// no surviving entry references and that are older than grace.
//
// grace protects bodies belonging to a push that has uploaded but not yet
// committed; pass chunks.DefaultGrace, and see its comment for the livelock that
// makes it necessary. Zero is only correct where nothing can be in flight.
//
// The write lock is held across the sweep as well as the delete. Releasing it in
// between would let a push store a chunk after the live set was computed but
// before the walk reached it, and the walk would delete a chunk a
// just-committed entry references. Purge is a rare manual operation, so blocking
// writes for its duration is the right trade.
//
// The delete, every invariant that proves it right, and the live set the sweep
// uses are all one transaction (S9). The delete is irreversible history loss,
// so it must not be left standing when a check that would have caught a mistake
// cannot even run. Before this, the DELETE ran in autocommit and a later query
// failing returned an error with the history already gone. Now a failure in any
// of those steps rolls the whole thing back, so the versions are still there to
// try again. The transaction commits before the filesystem sweep, because the
// sweep is not reversible SQL and a body it removes is unreferenced by the
// committed result; a chunk link goes with its entry by ON DELETE CASCADE, so
// the live set read inside the transaction is exactly what survives.
//
// The report describes what committed. A transaction that rolls back returns a
// zeroed one, because its counts were read inside a delete that no longer
// stands.
//
// # Pins, and what happens when one expires
//
// A version an agent's operation displaced survives every purge until its pin
// expires, whatever age the version is (PLAN.md section 4.5): the grace starts
// when the version was displaced, counted on the server's clock from the
// operation's commit, not from a client's mtime. Once the pin has expired the
// version is ordinary history again, and this purge drops it exactly as it
// would have had no agent touched it, unless it is a head or a rename record
// for its own reasons. The expired pin row goes in the same transaction, since
// it holds nothing; the operation and the paths it recorded stay, naming the
// uids, so the audit still says what the operation displaced after the bytes
// are gone. Expired replies and the keys that replayed them are let go here
// too, which is the retention ResultFor promises and nothing longer.
//
// The time is the store's clock, read once, so the set the purge captures, the
// set it deletes against and the grace its sweep applies are all one moment.
func (s *Store) Purge(vaultID string, grace time.Duration) (PurgeReport, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var rep PurgeReport
	var live map[string]struct{}
	now := s.clock()
	survivors := survivorArgs(vaultID, now.UnixMilli())

	// Everything that reads or writes the entries, in one transaction, so the
	// history is only gone once the proof that the purge was right has passed.
	err := s.inTx(func(tx *sql.Tx) error {
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&rep.VersionsBefore); err != nil {
			return err
		}

		// Capture the required UIDs before deleting. Counting distinct paths
		// afterward cannot detect a lost retirement record, or a whole path
		// removed by a faulty delete predicate.
		rows, err := tx.Query(purgeSurvivorUIDs, survivors...)
		if err != nil {
			return err
		}
		required := map[int64]struct{}{}
		for rows.Next() {
			var uid int64
			if err := rows.Scan(&uid); err != nil {
				rows.Close()
				return err
			}
			required[uid] = struct{}{}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// How many of those only a pin is keeping, counted before the delete
		// against the same moment.
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM entries WHERE vault_id = ?
			    AND uid IN (`+pinnedUIDs+`) AND uid NOT IN (`+baseSurvivorUIDs+`)`,
			append([]any{vaultID, vaultID, now.UnixMilli()}, survivors[:4]...)...).Scan(&rep.VersionsPinned); err != nil {
			return err
		}

		res, err := tx.Exec(
			`DELETE FROM entries
			  WHERE vault_id = ?
			    AND uid NOT IN (`+purgeSurvivorUIDs+`)`,
			append([]any{vaultID}, survivors...)...)
		if err != nil {
			return err
		}
		rep.VersionsRemoved, _ = res.RowsAffected()

		if s.afterPurgeDelete != nil {
			if err := s.afterPurgeDelete(); err != nil {
				return err
			}
		}

		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&rep.VersionsAfter); err != nil {
			return err
		}
		if rep.VersionsAfter != int64(len(required)) {
			return fmt.Errorf("purge left %d versions, want %d required entries in vault %q",
				rep.VersionsAfter, len(required), vaultID)
		}
		rows, err = tx.Query(`SELECT uid FROM entries WHERE vault_id = ?`, vaultID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var uid int64
			if err := rows.Scan(&uid); err != nil {
				rows.Close()
				return err
			}
			if _, ok := required[uid]; !ok {
				rows.Close()
				return fmt.Errorf("purge retained unexpected UID %d in vault %q", uid, vaultID)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if rep.VersionsBefore-rep.VersionsRemoved != rep.VersionsAfter {
			return fmt.Errorf("purge arithmetic: %d - %d != %d",
				rep.VersionsBefore, rep.VersionsRemoved, rep.VersionsAfter)
		}

		// The generation moves with the history, in the same transaction, and
		// only when history actually left: a purge that found nothing to drop
		// changes what a backup taken before it is the last copy of not at
		// all. See the column's comment in the schema, and
		// TestAPurgeThatDropsNothingDoesNotMoveTheGeneration.
		if rep.VersionsRemoved > 0 {
			if _, err := tx.Exec(
				`UPDATE vaults SET purges = purges + 1 WHERE vault_id = ?`, vaultID); err != nil {
				return err
			}
		}

		// The operation records past their windows, in the same transaction
		// as the history they no longer protect. See the section above.
		if rep.PinsExpired, err = affected(tx.Exec(
			`DELETE FROM op_pins WHERE vault_id = ? AND expires_at <= ?`, vaultID, now.UnixMilli())); err != nil {
			return err
		}
		if rep.KeysExpired, err = affected(tx.Exec(
			`DELETE FROM op_keys WHERE vault_id = ? AND expires_at <= ?`, vaultID, now.UnixMilli())); err != nil {
			return err
		}
		if rep.RepliesExpired, err = affected(tx.Exec(
			`UPDATE operations SET result = NULL
			  WHERE vault_id = ? AND result IS NOT NULL AND result_expires_at <= ?`, vaultID, now.UnixMilli())); err != nil {
			return err
		}

		// The live set is read here, after the delete and inside the same
		// transaction, so it is exactly what the committed result references.
		live, err = liveChunks(tx, vaultID)
		return err
	})
	if err != nil {
		// Nothing was removed: the delete rolled back with everything else in
		// the transaction. The counts were filled in inside it, and
		// VersionsRemoved comes from RowsAffected on a statement that no longer
		// stands, so reporting them would print history as gone that is still
		// there. A destructive command's own arithmetic has to describe what
		// committed (rule 8), and on this path nothing did.
		return PurgeReport{}, err
	}

	rep.ChunksLive = len(live)
	swept, err := s.chunks.Sweep(vaultID, live, now.Add(-grace))
	rep.ChunksDeleted, rep.ChunksSpared = swept.Deleted, swept.Spared
	rep.ChunksQuarantined, rep.ChunksTemp = swept.Quarantined, swept.Temp
	rep.BytesDeleted, rep.BytesSpared = swept.DeletedBytes, swept.SparedBytes
	rep.BytesQuarantined, rep.BytesTemp = swept.QuarantinedBytes, swept.TempBytes
	rep.SweepComplete = swept.Complete
	return rep, err
}

// affected is a statement's row count, for the counts a report carries.
func affected(res sql.Result, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// inTx runs fn in a transaction, committing if it returns nil and rolling back
// otherwise. It is the shape a purge needs: an irreversible delete and the
// checks that prove it right have to stand or fall together.
func (s *Store) inTx(fn func(*sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		// Rollback's own error is not worth returning over fn's: fn's is why
		// the purge is being abandoned, and it is the one a caller can act on.
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Reclaimable is what a purge of this vault would give back, worked out
// without deleting anything.
//
// It exists because the ceremony is heavy and the trigger was wrong. An
// unpurged server grows until `nospace` refuses uploads, and the documented
// remedy is stop, back up, purge, start; under Docker, a multi-container
// dance. Nothing said when it was worth doing, so the answer arrived as a
// refused upload. These numbers are what `stats` and the startup line print,
// so a purge happens because somebody was told.
//
// Deliberately only the visibility half. Nothing here deletes, nothing here
// runs on a timer, and there is still no online purge: purge is the one
// command that destroys something no device holds, and it stays a deliberate
// ceremony on a stopped server.
type Reclaimable struct {
	// Versions is the history a purge would drop after retaining current
	// paths, the rename records that still retire their sources, and the
	// versions an unexpired pin holds.
	Versions int64
	// Bodies and Bytes are the chunk bodies that no surviving version
	// references and that are older than the grace window, which is what a
	// purge at that grace would actually collect.
	Bodies int
	Bytes  int64
	// RecentBodies and RecentBytes are unreferenced too, but inside the
	// window, so a purge at this grace would spare them. Separate rather than
	// summed, for the reason SweepReport keeps them separate: on a server
	// stopped a moment ago they are the whole figure, and folding them in
	// would promise space that purge then reports as spared. Rule 8.
	RecentBodies int
	RecentBytes  int64
	// Pinned is history a purge would drop and does not, because an agent's
	// operation displaced it and its pin has not expired: PurgeReport's
	// VersionsPinned, predicted. Not in Versions, and its bodies not in
	// Bodies, because a purge now frees neither.
	Pinned int64
	// Complete says the walk reached the end of the chunk tree. False means
	// every figure above describes how far it got rather than what the vault
	// holds, and a caller must not print them as a status (rule 7), exactly as
	// for a sweep that stopped.
	Complete bool
}

// Reclaimable reports what a purge at this grace would free. It deletes
// nothing and takes no lock, so it runs against a live server, and its numbers
// are a snapshot that the next commit can move.
//
// The survivor query below is the exact inverse of Purge's DELETE predicate,
// written with the same subquery so the mirroring is visible rather than
// remembered. If the two ever disagree this preview promises space a purge
// does not free, which is the failure this whole feature exists to avoid, so
// it is pinned by a test that predicts, purges, and compares:
// TestReclaimablePredictsExactlyWhatAPurgeThenFrees.
func (s *Store) Reclaimable(vaultID string, grace time.Duration) (Reclaimable, error) {
	var r Reclaimable
	// One moment for every question, as Purge takes one, so a pin expiring
	// between two of them cannot make the figures disagree with each other.
	now := s.clock()
	survivors := survivorArgs(vaultID, now.UnixMilli())
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM entries WHERE vault_id = ? AND uid NOT IN (`+purgeSurvivorUIDs+`)`,
		append([]any{vaultID}, survivors...)...).Scan(&r.Versions); err != nil {
		return r, err
	}
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM entries WHERE vault_id = ?
		    AND uid IN (`+pinnedUIDs+`) AND uid NOT IN (`+baseSurvivorUIDs+`)`,
		append([]any{vaultID, vaultID, now.UnixMilli()}, survivors[:4]...)...).Scan(&r.Pinned); err != nil {
		return r, err
	}

	rows, err := s.db.Query(
		`SELECT DISTINCT name FROM entry_chunks
		  WHERE vault_id = ?
		    AND uid IN (`+purgeSurvivorUIDs+`)`,
		append([]any{vaultID}, survivors...)...)
	if err != nil {
		return r, err
	}
	names := map[string]struct{}{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return r, err
		}
		names[n] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return r, err
	}

	rep, err := s.chunks.Reclaimable(vaultID, names, now.Add(-grace))
	r.Bodies, r.Bytes = rep.Deleted, rep.DeletedBytes
	r.RecentBodies, r.RecentBytes = rep.Spared, rep.SparedBytes
	r.Complete = rep.Complete
	return r, err
}

// liveChunks is every chunk name referenced by a committed entry of this vault,
// read within the caller's transaction so it matches the rest of that snapshot.
func liveChunks(tx *sql.Tx, vaultID string) (map[string]struct{}, error) {
	rows, err := tx.Query(
		`SELECT DISTINCT name FROM entry_chunks WHERE vault_id = ?`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	live := map[string]struct{}{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		live[n] = struct{}{}
	}
	return live, rows.Err()
}

// Fault is something stored that will not do what it is stored for: an entry
// whose bodies do not back it up, or a registry row nothing could ever
// authenticate against.
type Fault struct {
	VaultID string
	UID     int64
	Path    string
	// Chunk is empty for a fault about the entry itself rather than a body.
	Chunk string
	// Row names a registry row instead of an entry: `device "alfa"`, `invite
	// "AAAAAAAAAAA"`. Empty for an entry fault, which UID and Path name. The two
	// cannot both be set, and String prints whichever there is: a fault about
	// a device row has no uid to print, and printing uid 0 for it would send
	// somebody looking for an entry.
	Row string
	// Reason is one of a fixed vocabulary, because things match on it:
	// "missing", "corrupt", "badsize", "nochunks", "straychunks",
	// "shortchunks", "chunkorder", "badpath", "baddevice", "badinvite",
	// "novault", "livekeys", "badop", "lostpin".
	//
	// Kept complete on purpose. It was written as though it were the whole
	// list and then fell behind the code twice, so anything reading it to
	// decide what a fault can be was reading a shorter answer than the
	// verifier gives.
	Reason string
	Detail string
}

// String is the fault as a person reads it. The path is quoted: paths are in
// the clear now, and one the policy refuses may hold a character that would
// otherwise forge a line of the report it is printed in.
func (f Fault) String() string {
	switch {
	case f.Row != "":
		return fmt.Sprintf("vault %s %s: %s (%s)", f.VaultID, f.Row, f.Reason, f.Detail)
	case f.Chunk == "":
		return fmt.Sprintf("vault %s uid %d %q: %s (%s)", f.VaultID, f.UID, f.Path, f.Reason, f.Detail)
	default:
		return fmt.Sprintf("vault %s uid %d %q chunk %s: %s (%s)",
			f.VaultID, f.UID, f.Path, f.Chunk, f.Reason, f.Detail)
	}
}

// Verification is what a pass looked at and what it found.
//
// Two counts rather than one, and both are printed, because rule 8 says to
// trust the numbers rather than the pass: zero faults over zero checks is not
// a healthy vault, and a registry that was never walked is not a sound one.
type Verification struct {
	Faults []Fault
	// Chunks is chunk references checked, repeats included.
	Chunks int
	// Entries is live entries walked, folders and deletions included.
	//
	// The measure of whether anything was looked at, which `Chunks` is not: a
	// vault of nothing but folders has no chunk references and is perfectly
	// healthy. Without this, an empty store and a whole one that came back
	// clean are the same two numbers.
	Entries int
	// Rows is device and invite rows decoded, and zero unless deep, because a
	// shallow pass does not look at them and must not report that it did.
	Rows int
	// Operations is agent operations decoded, with their paths, pins and
	// keys: every pass reads them, because a backup's check of its own
	// snapshot is a shallow one and a restore serves what it carries.
	Operations int
}

// Verify walks every live entry and checks that its chunks exist. With deep, it
// also reads each distinct vault/chunk body once and checks it against its name,
// and checks every entry's declared size against the sum of its chunks'
// lengths. Counts and faults still include every reference to that body.
//
// A dangling reference makes a client retry one download forever, which presents
// as a sync that never finishes rather than as an error, so it is surfaced
// explicitly. The store holds raw chunks named by their SHA-256, so deep
// verification is complete for the bytes and for the sizes: every name and
// every declared size can be recomputed from what is on disk.
//
// Deep also decodes the registry: see verifyRegistry. Every pass decodes the
// operation log: see verifyOplog.
//
// Returns what was checked as well as what was found. Both matter: zero faults
// out of zero checks is not a healthy vault, and rule 8 says to trust the
// numbers rather than the pass.
func (s *Store) Verify(deep bool) (Verification, error) {
	var v Verification
	var err error
	v.Faults, v.Chunks, err = s.verifyChunkRefs(deep)
	if err != nil {
		return v, err
	}

	entryFaults, entries, err := s.verifyEntries()
	v.Faults = append(v.Faults, entryFaults...)
	v.Entries = entries
	if err != nil {
		return v, err
	}
	liveFaults, err := s.verifyLive()
	v.Faults = append(v.Faults, liveFaults...)
	if err != nil {
		return v, err
	}
	opFaults, ops, err := s.verifyOplog()
	v.Faults = append(v.Faults, opFaults...)
	v.Operations = ops
	if err != nil || !deep {
		return v, err
	}

	// The size invariant, from what is on the disk, for every version whose
	// chunks are all present and sound: a chunk already reported missing or
	// corrupt has no length worth comparing, and a second fault for it would
	// be noise on the one report somebody reads to find the first.
	unsound := map[entryKey]bool{}
	for _, f := range v.Faults {
		if f.Chunk != "" {
			unsound[entryKey{f.VaultID, f.UID}] = true
		}
	}
	sizeFaults, err := s.verifySizes(unsound)
	v.Faults = append(v.Faults, sizeFaults...)
	if err != nil {
		return v, err
	}

	registryFaults, rowsChecked, err := s.verifyRegistry()
	v.Faults = append(v.Faults, registryFaults...)
	v.Rows = rowsChecked
	return v, err
}

// entryKey names one version across vaults.
type entryKey struct {
	vault string
	uid   int64
}

// verifySizes is the size invariant, checked again from what is on the disk:
// every version with a body declares exactly the sum of its chunks' lengths
// (plan/protocol.md, "Chunk bodies"). The commit refuses one that does not
// (ErrSizeMismatch), so a fault here is a row written behind the store's back,
// or a body that is not the one its version was committed with, and a reader
// assembling it gets a file of the wrong length.
//
// Lengths are stat sizes, once per distinct chunk: the deep pass before this
// has read and hashed every body, so a body whose length is wrong is also a
// body that failed its hash, and the stat is enough. The map is one entry per
// distinct chunk, which is what a deep verify already walks.
func (s *Store) verifySizes(skip map[entryKey]bool) ([]Fault, error) {
	rows, err := s.db.Query(
		`SELECT e.vault_id, e.uid, e.path, e.size, c.name
		   FROM entries e JOIN entry_chunks c
		     ON c.vault_id = e.vault_id AND c.uid = e.uid
		  WHERE e.folder = 0 AND e.deleted = 0
		  ORDER BY e.vault_id, e.uid, c.ord`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type chunkKey struct{ vault, name string }
	sizes := map[chunkKey]int64{}
	var faults []Fault
	var cur Fault
	var declared, sum int64
	unknown, open := false, false
	flush := func() {
		if open && !unknown && !skip[entryKey{cur.VaultID, cur.UID}] && sum != declared {
			f := cur
			f.Reason = "badsize"
			f.Detail = fmt.Sprintf("declares %d bytes and its chunks hold %d, so it assembles to a file of "+
				"the wrong length", declared, sum)
			faults = append(faults, f)
		}
	}
	for rows.Next() {
		var vault, path, name string
		var uid, size int64
		if err := rows.Scan(&vault, &uid, &path, &size, &name); err != nil {
			return faults, err
		}
		if !open || vault != cur.VaultID || uid != cur.UID {
			flush()
			cur = Fault{VaultID: vault, UID: uid, Path: path}
			declared, sum, unknown, open = size, 0, false, true
		}
		k := chunkKey{vault, name}
		n, ok := sizes[k]
		if !ok {
			if n, ok = s.chunks.Size(vault, name); !ok {
				// Missing, which the deep pass has reported already.
				unknown = true
				continue
			}
			sizes[k] = n
		}
		sum += n
	}
	flush()
	return faults, rows.Err()
}

func (s *Store) verifyChunkRefs(deep bool) (faults []Fault, count int, err error) {
	order := "e.vault_id, e.uid, c.ord"
	if deep {
		// The name index groups references without retaining a cache of every
		// healthy body. Only failures need storage proportional to history.
		order = "c.vault_id, c.name"
	}
	rows, err := s.db.Query(
		`SELECT e.vault_id, e.uid, e.path, c.name, c.ord
		   FROM entries e JOIN entry_chunks c
		     ON c.vault_id = e.vault_id AND c.uid = e.uid
		  ORDER BY ` + order)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	type orderedFault struct {
		Fault
		ordinal int64
	}
	var found []orderedFault
	defer func() {
		// Grouping by body must not change the diagnostic order operators see.
		if deep {
			sort.Slice(found, func(i, j int) bool {
				a, b := found[i], found[j]
				if a.VaultID != b.VaultID {
					return a.VaultID < b.VaultID
				}
				if a.UID != b.UID {
					return a.UID < b.UID
				}
				return a.ordinal < b.ordinal
			})
		}
		if len(found) > 0 {
			faults = make([]Fault, len(found))
			for i, f := range found {
				faults[i] = f.Fault
			}
		}
	}()

	var last Fault
	haveLast := false
	for rows.Next() {
		var f orderedFault
		if err := rows.Scan(&f.VaultID, &f.UID, &f.Path, &f.Chunk, &f.ordinal); err != nil {
			return nil, count, err
		}
		count++
		if !deep || !haveLast || f.VaultID != last.VaultID || f.Chunk != last.Chunk {
			last = f.Fault
			haveLast = true
			if !s.chunks.Has(f.VaultID, f.Chunk) {
				last.Reason = "missing"
			} else if deep {
				if err := s.chunks.Check(f.VaultID, f.Chunk); err != nil {
					last.Reason = "corrupt"
					last.Detail = err.Error()
				}
			}
		}
		if last.Reason != "" {
			f.Reason, f.Detail = last.Reason, last.Detail
			found = append(found, f)
		}
	}
	return nil, count, rows.Err()
}

// verifyRegistry decodes every device row and every invite, which nothing else
// does until the moment one of them is needed.
//
// A rotted body is a note that will not open and says so. A rotted registry
// row is quieter: a device whose auth_hash has lost a character can never
// match a credential again, so that device is refused with "not authorised",
// which is the same thing the server says to a stranger, and no check anywhere
// ever said the registry was unsound. An invite whose token hash is damaged is
// an invite nobody can redeem, listed as though somebody could. Neither is
// reachable from the entries walk above, because neither is an entry.
//
// What it checks is what the writes check, by calling the same predicates
// rather than restating them: a row that would be refused today is a fault
// however it came to be there. Lengths and shapes for the identifiers and the
// digests, the names, the timestamps that are not times at all, an invite's
// spent and cancelled marks against each other, and that the vault each row
// names is a vault this database holds.
//
// Deep only, and the count comes back so `verify` can print it. A shallow pass
// leaves Rows at zero and says nothing about the registry rather than
// reporting a clean one it never opened (rule 7).
//
// What it deliberately cannot check:
//
//   - **Whether a credential is the right one.** The server holds digests of
//     tokens it has never kept. A hash of the correct shape that is not the
//     hash of any token anybody holds is indistinguishable from one that is.
//   - **Timestamps against each other.** They come from the server's clock,
//     and a clock that went backwards would make an ordering check fire on a
//     vault that is perfectly sound. Only the impossible values are refused.
//   - **Rows that are missing.** Nothing here can tell a device that was
//     revoked from one that was lost, because a revocation is a delete and
//     leaves nothing behind. Rule 6 is about entries and does not reach the
//     registry; what answers a lost row is `trew backup`.
//
// TestDeepVerifyDecodesTheRegistry.
func (s *Store) verifyRegistry() ([]Fault, int, error) {
	var faults []Fault
	checked := 0

	rows, err := s.db.Query(
		`SELECT d.vault_id, d.device_id, d.name, d.auth_hash, d.created_at, d.last_seen,
		        (SELECT COUNT(*) FROM vaults v WHERE v.vault_id = d.vault_id)
		   FROM devices d
		  ORDER BY d.vault_id, d.device_id`)
	if err != nil {
		return nil, checked, err
	}
	for rows.Next() {
		var vaultID, deviceID, name, authHash string
		var createdAt, lastSeen int64
		var vaults int
		if err := rows.Scan(&vaultID, &deviceID, &name, &authHash, &createdAt, &lastSeen, &vaults); err != nil {
			rows.Close()
			return faults, checked, err
		}
		checked++
		fault := func(reason, detail string) {
			faults = append(faults, Fault{
				VaultID: vaultID,
				Row:     fmt.Sprintf("device %q", deviceID),
				Reason:  reason,
				Detail:  detail,
			})
		}
		switch {
		case !ValidDeviceID(deviceID):
			fault("baddevice", fmt.Sprintf(
				"device id is %d bytes and must be base64url of at most %d",
				len(deviceID), MaxDeviceIDLen))
		case !isHex64(authHash):
			fault("baddevice", fmt.Sprintf(
				"auth hash is %q, not a 64 character hex digest, so nothing this device sends "+
					"can ever match it and it is locked out with \"not authorised\"", authHash))
		case createdAt <= 0:
			fault("baddevice", fmt.Sprintf("was created at %d, which is not a time", createdAt))
		case lastSeen < 0:
			fault("baddevice", fmt.Sprintf("was last seen at %d, which is not a time", lastSeen))
		case vaults == 0:
			fault("novault", "names a vault this database does not hold")
		default:
			if err := CheckName("device", name, MaxDeviceLen); err != nil {
				fault("baddevice", err.Error())
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return faults, checked, err
	}

	rows, err = s.db.Query(
		`SELECT i.vault_id, i.id, i.token_hash, i.label, i.created_at, i.expires_at,
		        i.used_at, i.used_by, i.cancelled_at, i.issued_by,
		        (SELECT COUNT(*) FROM vaults v WHERE v.vault_id = i.vault_id)
		   FROM invites i
		  ORDER BY i.vault_id, i.id`)
	if err != nil {
		return faults, checked, err
	}
	defer rows.Close()
	for rows.Next() {
		var vaultID, id, tokenHash, label string
		var createdAt int64
		var expiresAt, usedAt, cancelledAt sql.NullInt64
		var usedBy, issuedBy sql.NullString
		var vaults int
		if err := rows.Scan(&vaultID, &id, &tokenHash, &label, &createdAt, &expiresAt,
			&usedAt, &usedBy, &cancelledAt, &issuedBy, &vaults); err != nil {
			return faults, checked, err
		}
		checked++
		fault := func(reason, detail string) {
			faults = append(faults, Fault{
				VaultID: vaultID,
				Row:     fmt.Sprintf("invite %q", id),
				Reason:  reason,
				Detail:  detail,
			})
		}
		switch {
		case !ValidInviteID(id):
			fault("badinvite", fmt.Sprintf("the invite id is %q, which is not %d bytes of base64url",
				id, InviteIDBytes))
		case !isHex64(tokenHash):
			fault("badinvite", "the token hash is not a 64 character hex digest, so nothing can ever redeem it")
		case createdAt <= 0:
			fault("badinvite", fmt.Sprintf("was created at %d, which is not a time", createdAt))
		case expiresAt.Valid && expiresAt.Int64 <= 0:
			fault("badinvite", fmt.Sprintf("expires at %d, which is not a time", expiresAt.Int64))
		case usedAt.Valid != usedBy.Valid:
			fault("badinvite", "is marked spent without saying by whom, or by whom without saying when")
		case usedAt.Valid && (usedAt.Int64 <= 0 || !ValidDeviceID(usedBy.String)):
			fault("badinvite", "is marked spent at an impossible time or by an impossible device id")
		case cancelledAt.Valid && (cancelledAt.Int64 <= 0 || usedAt.Valid):
			fault("badinvite", "is marked cancelled at an impossible time, or cancelled and spent at once")
		case issuedBy.Valid && !ValidDeviceID(issuedBy.String):
			fault("badinvite", "was issued by an impossible device id")
		case vaults == 0:
			fault("novault", "names a vault this database does not hold")
		default:
			if err := CheckName("invite", label, MaxDeviceLen); err != nil {
				fault("badinvite", err.Error())
			}
		}
	}
	return faults, checked, rows.Err()
}

// verifyLive recomputes each vault's live set from its entries and reports a
// `livekeys` fault where the tables the collision rule reads say otherwise.
//
// The tables are derived, written in the same transaction as every entry, and
// rebuilt from the entries if a write finds them disagreeing; see liveSchema.
// A fault here is drift that nothing has healed yet: the collision rule is
// answering from a live set that is not the vault's, so it may refuse a path
// it should accept or accept one it should refuse. Nothing is lost either
// way, and the next write that meets the disagreement rebuilds them.
func (s *Store) verifyLive() ([]Fault, error) {
	vaults, err := s.Vaults()
	if err != nil {
		return nil, err
	}
	var faults []Fault
	for _, v := range vaults {
		diff, err := liveDifference(s.db, v)
		if err != nil {
			return faults, err
		}
		if diff != "" {
			faults = append(faults, Fault{VaultID: v, Row: "live set", Reason: "livekeys",
				Detail: "the live set the collision rule reads disagrees with the entries: " + diff})
		}
	}
	return faults, nil
}

// verifyEntries checks the entries themselves, rather than the bodies they name.
//
// The loop above joins entries to their chunk rows, so an entry whose chunk rows
// are gone is not examined at all: it has nothing to join to. That is the worst
// thing this tool could miss. An entry declaring a size with no chunks behind it
// is a note that reads as empty rather than as an error, which is the failure
// this whole project is arranged against, and `verify` reported the vault clean.
//
// Both directions are checked, because the invariant is a biconditional and the
// opposite fault, chunks attached to something that should have none, means a
// folder or a deletion carrying content nobody will ever read.
func (s *Store) verifyEntries() (faults []Fault, entries int, err error) {
	rows, err := s.db.Query(
		`SELECT e.vault_id, e.uid, e.path, e.prev_path, e.size, e.folder, e.deleted,
		        (SELECT COUNT(*) FROM entry_chunks c WHERE c.vault_id = e.vault_id AND c.uid = e.uid),
		        (SELECT COALESCE(MAX(c.ord), -1) FROM entry_chunks c
		          WHERE c.vault_id = e.vault_id AND c.uid = e.uid),
		        (SELECT COALESCE(MIN(c.ord), 0) FROM entry_chunks c
		          WHERE c.vault_id = e.vault_id AND c.uid = e.uid),
		        e.n_chunks
		   FROM entries e
		  ORDER BY e.vault_id, e.uid`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	for rows.Next() {
		entries++
		var f Fault
		var size int64
		var folder, deleted bool
		var prev string
		var chunkCount, topOrd, lowOrd, declared int
		if err := rows.Scan(&f.VaultID, &f.UID, &f.Path, &prev, &size, &folder, &deleted,
			&chunkCount, &topOrd, &lowOrd, &declared); err != nil {
			return faults, entries, err
		}
		// The path policy, on every kind of entry and on a rename's source
		// (hazard 6 of the strip ledger). Validate refuses such a path at the
		// door, so a store can hold one only if it was written some other way,
		// and every reader that meets it declines it; naming it here with the
		// vault and the uid is the only way an operator finds out.
		if err := (Entry{Path: f.Path, Prev: prev}).CheckPaths(); err != nil {
			f.Reason = "badpath"
			f.Detail = err.Error() + ", so no device will accept this version. Delete it with a " +
				"newer write of the same path, or restore from a backup taken before it."
			faults = append(faults, f)
			continue
		}
		wantsChunks := size > 0 && !folder && !deleted
		switch {
		case wantsChunks && chunkCount == 0:
			f.Reason = "nochunks"
			f.Detail = fmt.Sprintf("declares %d bytes and names no chunks, so it would read as empty", size)
			faults = append(faults, f)
		case !wantsChunks && chunkCount > 0:
			f.Reason = "straychunks"
			f.Detail = fmt.Sprintf("names %d chunks but should have none", chunkCount)
			faults = append(faults, f)
		// The two structural checks the read path makes, made here as well
		// (R47). `EntryByUID` refused a truncated list with "was written with
		// 3 chunks and has 2" while `verify -deep` printed `0 faults` over the
		// same row: the same binary calling a vault clean and then declining
		// to serve it. A verifier that knows less than the reader is a clean
		// bill of health nobody should act on, and rule 3 has an operator
		// deleting the last copy on the strength of it.
		//
		case chunkCount != declared:
			f.Reason = "shortchunks"
			f.Detail = fmt.Sprintf(
				"was written with %d chunks and has %d, so it would assemble to the wrong "+
					"bytes", declared, chunkCount)
			faults = append(faults, f)
		// Both ends, not just the top (R51). The primary key makes the
		// ordinals distinct, so distinct integers with the right count, a
		// maximum of count-1 and a minimum of 0 can only be 0..count-1. One
		// end alone proves nothing: `[-1, 1, 2]` has three rows and a maximum
		// of 2, and the reader refuses it with "chunk ord -1 out of sequence
		// at position 0" while the verifier called the vault clean.
		case chunkCount > 0 && (topOrd != chunkCount-1 || lowOrd != 0):
			f.Reason = "chunkorder"
			f.Detail = fmt.Sprintf(
				"has %d chunk rows running from ord %d to %d, and a chunk list is 0 to %d, "+
					"so this one has a gap in it", chunkCount, lowOrd, topOrd, chunkCount-1)
			faults = append(faults, f)
		}
	}
	return faults, entries, rows.Err()
}

/* ---------------------------------------------------------------- */

type scannable interface {
	Scan(dest ...any) error
}

func scanEntry(r scannable) (Entry, error) {
	var e Entry
	var folder, deleted int
	err := r.Scan(&e.UID, &e.Path, &e.Size, &e.CTime, &e.MTime, &folder, &deleted,
		&e.Device, &e.Prev, &e.nChunks)
	e.Folder = folder != 0
	e.Deleted = deleted != 0
	return e, err
}

func scanEntries(rows *sql.Rows) ([]Entry, error) {
	var out []Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

/* ---------------------------------------------------------------- *
 * Who may write to a vault
 * ---------------------------------------------------------------- */

// ValidDeviceID is the shape of a device identifier: base64url of at most
// MaxDeviceIDLen characters, so the session can refuse a malformed one at hello
// with the same rule a redemption applies, rather than reporting the shape of
// an id as a failure to authenticate. There is no minimum length; see
// MaxDeviceIDLen.
func ValidDeviceID(s string) bool { return validBase64URL(s, MaxDeviceIDLen) }

// ReservedDeviceIDPrefix begins device ids the protocol reserves, and a hello
// naming one is refused as a credential (plan/protocol.md, "Device session").
// It can never be a registered device's today, because a colon is not
// base64url; the refusal is there so that no later row under the prefix, an
// MCP author for instance, can ever be connected to as a sync device.
const ReservedDeviceIDPrefix = "mcp:"

// ReservedDeviceID reports whether id is one the protocol reserves.
func ReservedDeviceID(id string) bool { return strings.HasPrefix(id, ReservedDeviceIDPrefix) }

func validBase64URL(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	padded := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '=':
			// Padding is the end of the string and at most two characters of
			// it. Allowing "=" anywhere in the last two positions accepted
			// "ab=c", which is not base64 of anything. Nothing here is ever
			// decoded, so this is shape only, but a shape check that admits a
			// string no encoder produces is not checking the shape.
			if i < len(s)-2 {
				return false
			}
			padded = true
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
			if padded {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// EachEntry calls fn for every entry of a vault, oldest first, with its chunks.
//
// For comparing one store against another. A purge's backup check used to
// compare two maximum uids, which is satisfied by any store that happens to
// have counted as high: another vault of the same name, or the same vault
// restored and moved on. Walking the entries is what turns "a store with a
// big number in it" into "a store holding these exact versions".
//
// The whole vault is read before the first callback, despite the callback:
// `attachChunks` works over a set, and doing it a page at a time would give up
// the checks below for a saving on a command that is already O(versions). The
// shape stays a callback because that is what the caller wants and because
// paging it later changes nothing here.
func (s *Store) EachEntry(vaultID string, fn func(Entry) error) error {
	// One transaction, and `scanEntry` and `attachChunks` rather than a second
	// hand-written pair.
	//
	// This built its own chunk lists, so it had neither the ord-sequence check
	// nor the size and count checks that every other read path gets, and it is
	// the *source* side of the purge's backup check while `EntryByUID` reads
	// the backup: a source entry with a chunk row missing was reported as the
	// backup holding a different version, and the operator was sent to inspect
	// the healthy disk while the damage sat in the store about to be purged.
	// Reading them separately also let a concurrent purge drop the chunk rows
	// of an entry already read, which is the reason `NextBatch` uses one.
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.Query(
		`SELECT `+s.entryCols()+` FROM entries WHERE vault_id = ? ORDER BY uid`, vaultID)
	if err != nil {
		return err
	}
	var entries []Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if err := attachChunks(tx, vaultID, entries); err != nil {
		return err
	}
	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		return err
	}

	for _, e := range entries {
		if err := fn(e); err != nil {
			return err
		}
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * Devices
 * ---------------------------------------------------------------- */

// CheckName bounds a vault or device name and refuses control characters in it.
//
// Exported so that there is one of it. It was the session's, bounding the two
// names a hello carries (S24, I6): a name lands in log lines and, for a
// device, on every entry it writes, and a newline in a log line is a forged log
// line. A device name is now also a column in the devices table, written by a
// path that does not go through hello, and a second copy of a validation is how
// the wire and the store come to disagree about what a name is. The session
// still calls it under its own name, so every refusal a client can see is byte
// for byte the one it was.
//
// The empty device name is allowed, because it always was and a device that
// gives none is only harder to tell apart in a listing. An empty vault id is
// refused before this is reached, as an auth failure, so that an attacker
// probing the server learns nothing from the difference.
func CheckName(what, name string, max int) error {
	if len(name) > max {
		return fmt.Errorf("%s name is %d bytes, limit is %d", what, len(name), max)
	}
	for i := 0; i < len(name); i++ {
		if c := name[i]; c < 0x20 || c == 0x7f {
			return fmt.Errorf("%s name contains a control character (byte %d at position %d)", what, c, i)
		}
	}
	return nil
}

// Device is one registered device, in the shape a person reads it in a list.
//
// The hash of the device's auth key is deliberately not a field. This is what
// a list op returns, and a credential hash that lives in the listing type is
// one that reaches every device the first time somebody serialises it.
// DeviceByID hands the hash back separately, to the one caller that has to
// compare it.
//
// The JSON tags are here because this is what the list op sends in step 4, and
// naming the fields once is cheaper than renaming them later.
type Device struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	LastSeen  int64  `json:"lastSeen"` // 0 until the device has connected
}

// RegisterDevice adds a device to a vault. created_at is now, in
// milliseconds, and last_seen starts at zero, which reads as "has not connected
// yet" rather than as "was here at the epoch".
//
// deviceHash is HashToken of that device's own raw token, never the token: a
// server holding a token could be a device rather than merely recognise one.
//
// Not a path any client reaches. A device comes to exist by redeeming an
// invite, which is RedeemInvite; this is the same insert, for the tests and
// tools that need a device without first making an invite for it.
//
// A device id this vault already holds is ErrDeviceExists, not a constraint
// error, because a bare insert surfaces as `internal`, which is retryable.
func (s *Store) RegisterDevice(vaultID, deviceID, name, deviceHash string, now int64) error {
	if err := checkDeviceFields(deviceID, name, deviceHash); err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return immediate(s.db, func(q execer) error {
		return insertDeviceTx(q, vaultID, deviceID, name, deviceHash, now)
	})
}

// checkDeviceFields is the shape a device row has to have, wherever the
// authority to write one came from: one copy of these three rules, because
// two copies is how two paths come to disagree about what a device id is, and
// the one that disagreed would be the one nobody was looking at.
func checkDeviceFields(deviceID, name, deviceHash string) error {
	if !validBase64URL(deviceID, MaxDeviceIDLen) {
		return fmt.Errorf("%w: device id is %d bytes and must be base64url of at most %d",
			ErrBadEntry, len(deviceID), MaxDeviceIDLen)
	}
	if err := CheckName("device", name, MaxDeviceLen); err != nil {
		return fmt.Errorf("%w: %s", ErrBadEntry, err)
	}
	if !isHex64(deviceHash) {
		return fmt.Errorf("%w: a device's auth hash is a 64 character hex digest", ErrBadEntry)
	}
	return nil
}

// insertDeviceTx is the conditional insert both registration paths run, inside
// the caller's transaction: the vault must exist, and a device id it already
// holds is ErrDeviceExists.
//
// Rule 4: the row count is checked rather than the absence of an error,
// because an insert whose WHERE is false is a successful statement that wrote
// nothing. Which of the refusals it was is then read inside the same
// transaction, so the answer describes the rows the insert was refused against.
func insertDeviceTx(q execer, vaultID, deviceID, name, deviceHash string, now int64) error {
	res, err := q.Exec(
		`INSERT INTO devices (vault_id, device_id, name, auth_hash, created_at, last_seen)
		 SELECT ?, ?, ?, ?, ?, 0
		  WHERE EXISTS (SELECT 1 FROM vaults WHERE vault_id = ?)
		 ON CONFLICT(vault_id, device_id) DO NOTHING`,
		vaultID, deviceID, name, deviceHash, now, vaultID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 1 {
		return nil
	}
	var vaults int
	if err := q.QueryRow(`SELECT COUNT(*) FROM vaults WHERE vault_id = ?`, vaultID).Scan(&vaults); err != nil {
		return err
	}
	if vaults == 0 {
		return fmt.Errorf("%w: %q", ErrUnknownVault, vaultID)
	}
	var exists int
	switch err := q.QueryRow(
		`SELECT 1 FROM devices WHERE vault_id = ? AND device_id = ?`,
		vaultID, deviceID).Scan(&exists); {
	case err == nil:
		return fmt.Errorf("%w: %q", ErrDeviceExists, deviceID)
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}
	return fmt.Errorf("registration did not insert or find device %q", deviceID)
}

// Devices is every device registered to a vault, oldest first, for the list op
// and for `trew devices`. A vault with none is an empty slice, not an error:
// a new vault has no devices until its first invite is redeemed, and that is not
// a fault.
//
// Ordered by created_at and then by device_id. created_at is a millisecond, so
// two devices registered inside the same one need a tiebreak or the order
// between them belongs to the query plan rather than to this function, and a
// list that reshuffles between two calls is one a person cannot trust they read
// the same way twice (rule 7).
//
// Honestly: no test can see the tiebreak today. The only scan available is the
// primary key, which is already in device_id order, and SQLite's sort is
// stable, so the order comes out right without it. Reverting the tiebreak
// leaves TestDevicesListsInAStableOrderAndNeverReturnsNil passing, which was
// checked rather than assumed. It stays because that is an accident of the
// plan and this is the property, in the same belt and braces spirit as the
// duplicated index statement in migrate.
//
// The slice is never nil, so it marshals to [] rather than to null, which is
// the same rule Entry.Chunks has and for the same reason: a client that
// iterates the result crashes on exactly the vault it is meant to handle, the
// one with no devices.
func (s *Store) Devices(vaultID string) ([]Device, error) {
	rows, err := s.db.Query(
		`SELECT device_id, name, created_at, last_seen FROM devices
		  WHERE vault_id = ? ORDER BY created_at, device_id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// DeviceByID is one device row and the hash of its auth key, which is the pair
// the connect check needs: no row and a hash that does not match are the same
// refusal to a client, and it has to be able to tell them apart internally to
// produce that refusal at all.
//
// ok is false for a device that is not registered, including one revoked a
// moment ago. That is not an error: a revoked device connecting is the system
// working.
//
// The hash is returned beside the Device rather than inside it so that the
// listing type cannot grow a credential field by accident; see Device. Callers
// comparing it must do so in constant time over the hashes.
func (s *Store) DeviceByID(vaultID, deviceID string) (d Device, authHash string, ok bool, err error) {
	err = s.db.QueryRow(
		`SELECT device_id, name, created_at, last_seen, auth_hash FROM devices
		  WHERE vault_id = ? AND device_id = ?`, vaultID, deviceID).
		Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeen, &authHash)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, "", false, nil
	}
	if err != nil {
		return Device{}, "", false, err
	}
	return d, authHash, true, nil
}

// RevokeDevice deletes a device's row, and cancels every invite that device
// issued which could still be redeemed, in one transaction, and returns how
// many invites it cancelled. That device cannot connect again, and no other
// device is disturbed.
//
// The invites go with it because an invite is a bearer credential the device
// minted: one issued on a laptop before the laptop was stolen would otherwise
// add the thief's next device after the laptop itself was revoked. That is the
// shape of authority a revoke exists to end (PLAN.md section 2.3.1), and the
// owner who meant to use one of those invites asks for another. Invites the
// operator issued on the server name no device and are untouched.
//
// It is a delete rather than a revoked_at flag, for the reason in the table's
// comment: a flag makes "can this device connect" a question about how many
// places remember to check it. What is not lost is the history, because
// entries.device is a separate column on rows this never touches.
//
// Revoking the last device is allowed (plan/protocol.md, "Devices and
// invites"): no device holds anything the server cannot reissue, and the way
// back is `trew invite` on the server. An unknown device is
// ErrUnknownDevice, the ordinary state after a revoke rather than a fault.
//
// Closing that device's sessions is the server's half, under the same lock as
// every commit, so a revoke also stops the mutations and the deliveries it has
// in flight (PLAN.md section 2.3.1); see server.Server.revoke.
func (s *Store) RevokeDevice(vaultID, deviceID string, now int64) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	cancelled := 0
	err := immediate(s.db, func(q execer) error {
		res, err := q.Exec(`DELETE FROM devices WHERE vault_id = ? AND device_id = ?`, vaultID, deviceID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return fmt.Errorf("%w: %q on vault %q", ErrUnknownDevice, deviceID, vaultID)
		}
		res, err = q.Exec(`UPDATE invites SET cancelled_at = ?
		                    WHERE vault_id = ? AND issued_by = ? AND used_at IS NULL AND cancelled_at IS NULL`,
			now, vaultID, deviceID)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		cancelled = int(n)
		return err
	})
	if err != nil {
		return 0, err
	}
	return cancelled, nil
}

// RenameDevice changes the label on one device's row, and nothing else.
//
// A device renames itself: the caller is the authenticated device, so there is
// no authorisation question to answer here beyond the row existing. `name` is a
// label a person reads and `device_id` is the identity, which is what makes
// this a one-column update rather than anything to migrate; verifyRegistry
// reads the name and checks the row around it. A device relabelling itself
// destroys nothing, cannot affect another device, and is undone by doing it
// again.
//
// An unknown row is ErrUnknownDevice rather than a silent success, because the
// case it covers is a device renaming itself after being revoked, and "renamed"
// would be a lie told to a device that is no longer on the vault.
func (s *Store) RenameDevice(vaultID, deviceID, name string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	return s.inTx(func(tx *sql.Tx) error {
		res, err := tx.Exec(
			`UPDATE devices SET name = ? WHERE vault_id = ? AND device_id = ?`,
			name, vaultID, deviceID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrUnknownDevice
		}
		return nil
	})
}

// SawDevice moves a device's last_seen to at, in milliseconds, and touches
// nothing else. It is what a connect calls; the name, the id and the auth hash
// are not its business, and a device that is not registered is ErrUnknownDevice
// rather than a row this quietly creates. An upsert here would hand a revoked
// device its row back, which is the one thing revocation has to mean.
//
// last_seen never moves backwards. The value is the server's clock, so it takes
// an NTP step or two calls landing out of order to invert, and both happen; a
// last_seen that goes backwards is a number a person reads as "that laptop has
// not been here since Tuesday" when it was here a minute ago. Rule 8: the
// numbers are what get believed, so they have to be true.
// TestSawDeviceNeverMovesLastSeenBackwards.
func (s *Store) SawDevice(vaultID, deviceID string, at int64) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	res, err := s.db.Exec(
		`UPDATE devices SET last_seen = MAX(last_seen, ?) WHERE vault_id = ? AND device_id = ?`,
		at, vaultID, deviceID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("%w: %q on vault %q", ErrUnknownDevice, deviceID, vaultID)
	}
	return nil
}
