package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Health is what can be learned about a store cheaply enough to ask on every
// probe (I17).
//
// The distinction it exists to draw is between a process that answers and a
// server that can still take a note. Those came apart in exactly one way and
// nothing could see it: /health returned "ok" from an http handler that touched
// nothing, so a full disk, a database that had gone read-only, or a chunk
// directory that had lost its mount all looked identical to a healthy server
// for as long as nobody tried to save anything. A monitor cannot alert on that
// and an operator finds out from a phone that will not sync.
//
// Cheap on purpose. One indexed read and one statfs, both of which a probe can
// afford every few seconds; the deep verification lives in `trewd verify`,
// where it is asked for. A health check that costs real work is a health check
// somebody turns off, and one that walks the store competes with the thing it
// is reporting on.
type Health struct {
	// CanPersist is the one that decides the status code. False means a note
	// arriving now would not be stored.
	CanPersist bool

	// Why is a short machine-readable reason, from a fixed vocabulary, or empty
	// when all is well. Fixed so that a monitor can match on it and so that it
	// never carries a path, a vault name or an error string from the OS.
	Why HealthReason

	// FreeBytes and TotalBytes describe the filesystem holding the store, or
	// zero where it could not be asked. Not reported over the network: a
	// stranger on the port learns nothing from this package, and these are for
	// `trewd stats` and the log.
	FreeBytes  int64
	TotalBytes int64

	// Took is how long the check itself needed, which is the thing to look at
	// when a probe starts timing out: a store whose fsync has gone slow answers
	// this correctly and slowly, and "correct and slow" is its own failure.
	//
	// Filled by a deferred assignment to a named return. It was a plain return
	// with a defer writing to a local, so callers received zero every time.
	Took time.Duration
}

// HealthReason is the fixed vocabulary. A monitor matches these; they are part
// of the interface and are not sentences.
type HealthReason string

const (
	HealthOK HealthReason = ""
	// HealthUnreadable is the database not answering a trivial query.
	HealthUnreadable HealthReason = "store-unreadable"
	// HealthNoSpace is a filesystem with no room to write a note into.
	HealthNoSpace HealthReason = "disk-full"
	// HealthNoChunkDir is the body directory gone: an unmounted volume, most
	// likely, which SQLite on another filesystem will not notice at all.
	HealthNoChunkDir HealthReason = "chunks-unreachable"
	// HealthUnwritable is a database that answers reads and refuses writes: a
	// connection opened read-only, a file whose permissions have gone, or a
	// filesystem remounted read-only after an error, which is how Linux
	// reacts to a disk that is failing. A read-only store is the case a
	// `SELECT 1` cannot see and the one most likely to be true (R15).
	HealthUnwritable HealthReason = "store-read-only"
	// HealthChunksUnwritable is the body directory refusing a write while the
	// database takes them: permissions gone on that tree, or a separate volume
	// remounted read-only.
	//
	// Its own word, because the two send an operator to different places and
	// the vocabulary is what a monitor pages on. Both used to answer
	// `store-read-only`, which says SQLite, and the person woken up would have
	// inspected a database that was working perfectly (R28).
	HealthChunksUnwritable HealthReason = "chunks-read-only"
	// HealthBusy is a store that could not be written to inside the timeout
	// because something else is writing. Not a fault: a long transaction, a
	// backup, a purge. It is here because a slow answer used to be reported as
	// a filesystem that had gone read-only, and an orchestrator restarts a
	// server over that.
	HealthBusy HealthReason = "store-busy"
	// HealthUnchecked is an inspection handle: this process opened the store
	// read-only on purpose, so it cannot ask whether a write would land and
	// must not answer as though it had. Everything else in the report is real.
	HealthUnchecked HealthReason = "not-checked"
	// HealthClosing is a server draining its sessions. Set by the server rather
	// than by anything here; it is in this list so the vocabulary is in one
	// place, which is what a monitor matching on it needs.
	HealthClosing HealthReason = "shutting-down"
)

// lowSpaceBytes is the point below which this reports a full disk.
//
// Not zero, because a store that fills completely is one that has already
// failed: SQLite needs room for its write-ahead log and a rollback journal
// before it can commit anything, and a chunk write needs room for the body plus
// the directory entry. Reporting trouble with a little room left is what makes
// the report actionable rather than a post-mortem.
//
// 64 MiB is one maximum fetch, which is a rough stand-in for "enough for the
// work in flight to finish".
const lowSpaceBytes = 64 << 20

// LowSpaceBytes is the threshold, exposed so a test can assert it is not zero
// without this package having to be the one that says why.
func LowSpaceBytes() int64 { return lowSpaceBytes }

// CheckHealth answers whether this store could take a note right now.
//
// The context bounds it: a probe should time out rather than hang, and a
// database whose disk has stopped answering will hang rather than fail.
func (s *Store) CheckHealth(ctx context.Context) (h Health) {
	started := time.Now()
	h = Health{CanPersist: true}
	// A *named* return, and that is the whole of the fix for this line (R15).
	// Assigning to a local in a deferred function after an unnamed return has
	// already copied it changes nothing the caller sees, so every probe was
	// told the check took no time at all, which is exactly the figure to look
	// at when one starts timing out.
	defer func() { h.Took = time.Since(started) }()

	// Whether the database can be *written*, which is what this promises
	// (R15).
	//
	// It used to be `SELECT 1`. That succeeds against a database opened
	// read-only, one whose file has lost write permission, and one on a
	// filesystem remounted read-only after an error, which is the ordinary way
	// a Linux box reacts to a failing disk. So the field called CanPersist was
	// answered by a question about reading, and an immediate AppendEntry then
	// failed with "attempt to write a readonly database" while health said all
	// was well.
	//
	// A transaction that is begun and rolled back is the cheapest thing that
	// asks the real question: SQLite takes the write lock and refuses here if
	// it cannot, and nothing is committed, so the store is not touched. It
	// costs no page writes and does not grow the write-ahead log.
	// Except from a handle that was opened read-only on purpose, where the
	// answer would be about this process rather than about the store.
	//
	// Every inspection command opens that way (I15), and this probe refuses on
	// exactly such a connection by design (R15), so the two together made
	// `trewd stats` say `canPersist: false, reason: store-read-only` about
	// every healthy server, and return before the statfs, leaving the
	// free-space numbers that command exists to print at zero. Two correct
	// changes; one wrong answer. The rest of the report is still worth having,
	// so the probe is skipped and the reason says which question was not
	// asked.
	writable := !s.readOnly
	if writable {
		if failed := s.probeWrite(ctx, &h); failed {
			return h
		}
	}

	// The chunk directory, which is on the same filesystem as the database in
	// every supported layout and is the half that goes missing when a volume
	// unmounts. Statting it answers both questions at once: whether it is
	// there, and how much room is left.
	dir := s.chunks.Root()
	if dir == "" {
		dir = filepath.Dir(s.dbPath)
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(dir, &fs); err != nil {
		h.CanPersist = false
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR) {
			h.Why = HealthNoChunkDir
			return h
		}
		// Something else is wrong with the filesystem and a note is not going
		// to land on it. Reported as unreadable rather than invented into a
		// reason of its own: the vocabulary is fixed and this is not one of it.
		h.Why = HealthUnreadable
		return h
	}
	//nolint:unconvert // Bavail is uint64 on Linux and uint32 on some others.
	h.FreeBytes = int64(fs.Bavail) * int64(fs.Bsize)
	h.TotalBytes = int64(fs.Blocks) * int64(fs.Bsize)
	if h.FreeBytes < lowSpaceBytes {
		h.CanPersist = false
		h.Why = HealthNoSpace
		return h
	}

	// And whether a body can actually be written there (R28).
	//
	// `statfs` says the volume is mounted and has room, which is not the same
	// as this process being allowed to write to it: a chunk root whose
	// permissions have gone, or one on a mount the kernel turned read-only
	// after an I/O error, answers `statfs` perfectly and refuses every upload.
	// That is the same mistake the database side made with `SELECT 1`, one
	// directory over, and the field is still called CanPersist.
	//
	// Asked of the chunk store, which owns the name the probe takes: it goes
	// under the prefix a half-written body carries, so every walk over the
	// tree already skips it. A name of its own would have been counted as a
	// body by `CountBodies` for as long as it existed, and a backup comparing
	// its count with the source's would report that file as a discrepancy.
	if writable {
		if err := s.chunks.CheckWritable(); err != nil {
			h.CanPersist = false
			// Its own word (R28). Both sides answering `store-read-only` sent
			// whoever was paged to inspect a database that was working.
			h.Why = HealthChunksUnwritable
		}
		return h
	}
	// Read-only inspection: the space and the chunk directory above are real
	// answers and the writability question was never put. Saying so is the
	// difference between "this server cannot take a note" and "this command
	// did not ask"; `/health` on the running server is what asks.
	h.CanPersist = false
	h.Why = HealthUnchecked
	return h
}

// isBusy is whether a write failed because something else holds the lock.
//
// SQLite says so in the message rather than in a type this driver exposes, so
// this matches on it. Getting the match wrong costs the more alarming of the
// two words, which is the safe direction: a busy store reported as read-only
// is what this exists to stop, and a read-only one reported as busy would be
// worse.
func isBusy(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "database is locked") || strings.Contains(text, "busy")
}

// probeWrite takes the write lock and gives it back, and reports whether that
// failed. It sets the reason on `h` when it did.
//
// A transaction that is begun and rolled back is the cheapest thing that asks
// the real question: SQLite takes the write lock and refuses here if it
// cannot, and nothing is committed, so the store is not touched. It costs no
// page writes and does not grow the write-ahead log.
//
// Under writeMu, which every commit in this process holds across its
// transaction, so the probe never takes SQLite's write lock beside a device's
// commit (T29). /health needs no credential, and the probe took that lock with
// nothing ordering it against the commits: a put that met it failed. The
// mutex is tried rather than waited on, so a probe never queues ahead of a
// device's commit, and it keeps trying until the probe's deadline, or for as
// long as SQLite's own busy timeout (dsn) would have waited for its lock when
// the caller set none, before it answers busy. A commit holds the mutex for
// milliseconds, so an ordinary busy moment still answers ok, which is what the
// reference promises: busy is contention that outlasted the check's wait.
func (s *Store) probeWrite(ctx context.Context, h *Health) bool {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for !s.writeMu.TryLock() {
		select {
		case <-wait.Done():
			h.CanPersist = false
			h.Why = HealthBusy
			return true
		case <-time.After(time.Millisecond):
		}
	}
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		h.CanPersist = false
		h.Why = HealthUnreadable
		return true
	}
	// `PRAGMA user_version` is a write to the header and SQLite refuses it on
	// a read-only connection, which is the refusal being looked for; setting
	// it to what it already is means the rollback has nothing to undo.
	_, writeErr := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", SchemaVersion))
	rollbackErr := tx.Rollback()
	if writeErr == nil && (rollbackErr == nil || errors.Is(rollbackErr, sql.ErrTxDone)) {
		return false
	}
	h.CanPersist = false
	// Busy is not read-only, and the vocabulary is what a monitor pages on. A
	// long transaction, a backup or a purge holding the write lock past the
	// timeout answered `store-read-only`, which says the filesystem has gone,
	// and an orchestrator restarts a server over that.
	h.Why = HealthUnwritable
	if isBusy(writeErr) {
		h.Why = HealthBusy
	}
	return true
}
