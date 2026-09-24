package store

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

// An agent's write is a durable operation, not a put with a different caller
// (PLAN.md section 4.3). A device's `putmany` is deliberately partial: it
// refuses one stale entry and commits the rest, which is right for a device
// catching up and wrong for an agent's four-file refactor. So there are two
// APIs, and this file is the second: CommitOperation, all or nothing, with the
// record that makes an unattended write explainable afterwards (the oplog),
// answerable after a lost reply (idempotency, section 4.8), and recoverable
// after a purge (retention pins, section 4.5).

// oplogSchema is the record of every agent operation: what it was and who made
// it, the paths it changed with their versions before and after, the versions
// it displaced and until when they are pinned, and the reply it gave.
//
// # operations
//
// One row per committed operation, noops included (see CommitOperation). The
// actor's id and label are copied in rather than joined, because revoking a
// token deletes its row and its author row (RevokeMCPToken), and the question
// "who did this" must outlive the credential that did it. committed_at is the
// server's clock at commit, never a client's mtime, since retention is counted
// from it (section 4.5) and a device clock can say anything.
//
// actor_kind says what the actor is. An agent's MCP token ('mcp') makes every
// operation but one kind: an undo (PLAN.md section 4.5, undo.go) may also be
// asked for by the operator through `trewd undo` ('operator', whose id is
// OperatorActorID) or by a device from the plugin's history panel ('device',
// whose id is the device's own). None of the three is a device row that
// syncs, except the device, which already was one.
//
// undoes, on an undo, is the operation it compensates for. An undo is an
// operation like any other, with its own paths and pins, so an undo can be
// undone in its turn.
//
// seq orders the log. The id is random, so it cannot, and committed_at can tie
// within a millisecond; seq is what an audit listing pages by. AUTOINCREMENT so
// a sequence number is never handed out twice, even if a row ever went.
//
// Never recorded, anywhere in these tables: a bearer token, a token's hash, or
// a note's body. The request is a digest, the paths are paths, and the result
// is the reply the caller rendered, which for a mutation is uids and paths.
// Client name and version come from the MCP client and are untrusted, so they
// are capped and stripped of control characters before they are stored
// (plan/research/README.md section 5, Syncidian).
//
// result is kept until result_expires_at and cleared by the next purge after;
// the row itself is kept for as long as the store is. An audit row is a few
// hundred bytes, and "what did the agent do" is not a question that expires.
//
// # op_entries
//
// Every path an operation changed, with its head before and the uid that
// changed it. A move is two rows sharing one after_uid: the destination, role
// 'write', and the source it retired, role 'source'. before_uid is NULL where
// the path had never held a version.
//
// before_state is what the path held at before_uid: 'none' (no version),
// 'gone' (a deletion, or a rename away from it) or 'live' (a note or a
// folder, which the operation pinned). Recorded because an undo has to know
// what to put back, and once a pin has expired and purge has taken the
// version, the uid alone cannot say whether there was anything there. NULL
// only on a row schema 3 carried over from schema 2 whose version was
// already gone, where nothing can say; an undo refuses such a path rather
// than guess (undo.go).
//
// # op_pins
//
// The versions an operation displaced, each held against purge until
// expires_at: committed_at plus the pin window, fixed when the operation
// commits, so a later change to the window cannot shorten a promise already
// made. See Purge for what an expired pin means.
//
// # op_keys
//
// An actor's idempotency keys and the operation each one names, until the key
// expires with the operation's result. The digest the key was used with is the
// operation's own request_digest, joined rather than copied, so the two cannot
// disagree. Keyed by actor, as PLAN.md section 3.3 has it: an actor id is a
// random 16-byte token id and unique across vaults, and two agents using one
// key are two keys.
const oplogSchema = operationsSchema + opEntriesSchema + `

CREATE TABLE IF NOT EXISTS op_pins (
  op_id      TEXT    NOT NULL REFERENCES operations(id),
  vault_id   TEXT    NOT NULL,
  uid        INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (op_id, uid)
);
CREATE INDEX IF NOT EXISTS op_pins_by_vault ON op_pins(vault_id, expires_at, uid);

CREATE TABLE IF NOT EXISTS op_keys (
  actor_id        TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  vault_id        TEXT    NOT NULL,
  op_id           TEXT    NOT NULL REFERENCES operations(id),
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key)
);
`

// operationsSchema is the operations table and its indexes, apart from the
// rest of the log because schema 3 rebuilds it (rebuildOperations) and the
// rebuilt table must be exactly the one a new store is made with.
const operationsSchema = `
CREATE TABLE IF NOT EXISTS operations (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT    NOT NULL UNIQUE,
  vault_id          TEXT    NOT NULL,
  actor_id          TEXT    NOT NULL,
  actor_kind        TEXT    NOT NULL CHECK (actor_kind IN ('mcp', 'operator', 'device')),
  actor_label       TEXT    NOT NULL,
  tool              TEXT    NOT NULL,
  undoes            TEXT    REFERENCES operations(id),
  request_digest    TEXT    NOT NULL,
  idempotency_key   TEXT,
  epoch             TEXT    NOT NULL,
  committed_at      INTEGER NOT NULL,
  outcome           TEXT    NOT NULL CHECK (outcome IN ('committed', 'noop')),
  snapshot_head     INTEGER,
  client_name       TEXT    NOT NULL DEFAULT '',
  client_version    TEXT    NOT NULL DEFAULT '',
  result            BLOB,
  result_expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_by_time ON operations(vault_id, committed_at);
CREATE INDEX IF NOT EXISTS operations_by_undoes ON operations(undoes);
`

// opEntriesSchema is op_entries, which schema 3 rebuilds to add before_state.
const opEntriesSchema = `
CREATE TABLE IF NOT EXISTS op_entries (
  op_id        TEXT    NOT NULL REFERENCES operations(id),
  ord          INTEGER NOT NULL,
  role         TEXT    NOT NULL CHECK (role IN ('write', 'source')),
  path         TEXT    NOT NULL,
  before_uid   INTEGER,
  before_state TEXT    CHECK (before_state IN ('none', 'gone', 'live')),
  after_uid    INTEGER NOT NULL,
  PRIMARY KEY (op_id, ord)
);
CREATE INDEX IF NOT EXISTS op_entries_by_after ON op_entries(after_uid);
`

// rebuildOplog is schema 2 to 3: the operations table with the actor kinds an
// undo brings (the operator, a device) and the undoes column, and op_entries
// with before_state. SQLite cannot widen a CHECK constraint or put a column
// anywhere but last in place, so each table is made again, exactly as a new
// store makes it, and every row copied into it, sequence numbers included, so
// no audit listing's order or page changes. op_pins and op_keys are untouched:
// they name operations by id, and every id is still there.
//
// A schema 2 row's before_state is worked out from what schema 2 kept: no
// before_uid is 'none'; a pinned one was live, because schema 2 pinned exactly
// the versions that were; an unpinned one still in the store is what that
// version says it is. One that is neither pinned nor present had its pin
// expire and its version purged, or was a deletion purge was free to take,
// and nothing left can say which, so it is NULL, and an undo refuses that path
// rather than guess.
//
// It runs with foreign keys off, on the connection that runs it, which is the
// procedure SQLite documents for changing a table other tables refer to
// (lang_altertable.html, "Making Other Kinds Of Table Schema Changes"), and
// with legacy_alter_table on, so renaming an old table out of the way leaves
// the other tables' REFERENCES naming "operations" rather than following it.
// PRAGMA foreign_key_check then proves every reference still lands before the
// transaction commits (open.go, rebuilding).
func rebuildOplog(q execer) error {
	for _, stmt := range []string{
		`ALTER TABLE operations RENAME TO operations_schema2`,
		`DROP INDEX IF EXISTS operations_by_time`,
		`DROP INDEX IF EXISTS operations_by_undoes`,
		operationsSchema,
		`INSERT INTO operations (seq, id, vault_id, actor_id, actor_kind, actor_label, tool, request_digest,
		                         idempotency_key, epoch, committed_at, outcome, snapshot_head, client_name,
		                         client_version, result, result_expires_at)
		 SELECT seq, id, vault_id, actor_id, actor_kind, actor_label, tool, request_digest, idempotency_key,
		        epoch, committed_at, outcome, snapshot_head, client_name, client_version, result,
		        result_expires_at
		   FROM operations_schema2 ORDER BY seq`,
		`DROP TABLE operations_schema2`,

		`ALTER TABLE op_entries RENAME TO op_entries_schema2`,
		opEntriesSchema,
		`INSERT INTO op_entries (op_id, ord, role, path, before_uid, before_state, after_uid)
		 SELECT p.op_id, p.ord, p.role, p.path, p.before_uid,
		        CASE
		          WHEN p.before_uid IS NULL THEN 'none'
		          WHEN EXISTS (SELECT 1 FROM op_pins k WHERE k.op_id = p.op_id AND k.uid = p.before_uid) THEN 'live'
		          ELSE (SELECT CASE WHEN e.path = p.path AND e.deleted = 0 THEN 'live' ELSE 'gone' END
		                  FROM entries e JOIN operations o ON o.vault_id = e.vault_id
		                 WHERE o.id = p.op_id AND e.uid = p.before_uid)
		        END,
		        p.after_uid
		   FROM op_entries_schema2 p`,
		`DROP TABLE op_entries_schema2`,
	} {
		if _, err := q.Exec(stmt); err != nil {
			return fmt.Errorf("rebuilding the operation log: %w", err)
		}
	}
	return nil
}

// Bounds on what an operation carries.
const (
	// OperationIDBytes is an operation's id: 16 random bytes, 22 characters of
	// base64url, minted before the transaction so a commit whose outcome is
	// unknown still has a name to be looked up by.
	OperationIDBytes = 16
	// MaxOperationEntries bounds one operation's entries. Far above anything
	// an MCP tool builds (a move with its backlinks is a few dozen), because
	// a restore to a uid (PLAN.md M5.5) is one operation over every path that
	// changed, and a bound that refused it would be refusing the recovery.
	MaxOperationEntries = 1 << 16
	// MaxIdempotencyKeyLen bounds a key, in bytes. A UUID is 36; the bound is
	// there so a client cannot park kilobytes in a primary key.
	MaxIdempotencyKeyLen = 128
	// MaxToolNameLen bounds the tool name an operation is recorded under.
	MaxToolNameLen = 64
	// MaxClientInfoLen bounds the client name and version an MCP client says
	// it is, which are stored truncated rather than refused: a write is not
	// worth losing over what a client calls itself.
	MaxClientInfoLen = 64
	// MaxUID is the largest uid a version can have, the largest integer a
	// JavaScript client holds exactly. The worst case a reply is bounded at.
	MaxUID = 9007199254740991
)

// Retention is how long an operation's two kinds of record last (PLAN.md
// section 4.5). There are three retention policies, kept apart because they
// answer different questions, and two of them are here:
//
//   - PinFor is how long a version an operation displaced is pinned against
//     purge, counted from the operation's commit. It is the before-image: the
//     only copy of what a note said before the agent touched it, whatever age
//     the content itself was.
//   - ResultFor is how long an operation's recorded reply is kept, and with
//     it the idempotency key that replays it (section 4.8).
//
// The third is ordinary history, which is not here because it is not a
// window: purge keeps every head and the rename records the heads need, drops
// the rest when the operator runs it, and spares bodies written within its
// -grace (chunks.DefaultGrace). A version no operation displaced is ordinary
// history from the moment it is superseded.
type Retention struct {
	PinFor    time.Duration
	ResultFor time.Duration
}

// The retention floors and defaults.
const (
	// MinPinRetention is the shortest pin a store will make: thirty days
	// after the operation, the figure PLAN.md section 4.5 requires. A longer
	// window may be configured; a shorter one is refused.
	MinPinRetention = 30 * 24 * time.Hour
	// MinResultRetention is the shortest time a reply is kept. Shorter than a
	// restart, and the crash between commit and reply (PLAN.md M5 task 9)
	// would have nothing to replay.
	MinResultRetention = time.Hour
)

// DefaultRetention pins displaced versions for the thirty days PLAN.md
// requires, and keeps replies for seven.
//
// Seven days for a reply because what a reply is for is a retry: the agent
// whose connection dropped, the session resumed the next morning, the crash
// matrix's kill between commit and reply. A week covers every one of those
// with a weekend to spare. Beyond it an unanswered request is not a retry but
// a new request, and it is treated as one: its bases are checked like any
// other's, so an edit replayed after its key has gone meets the head its first
// commit made and is refused as stale rather than applied twice. The audit row
// and the operation lookup still say what the first one did.
var DefaultRetention = Retention{PinFor: MinPinRetention, ResultFor: 7 * 24 * time.Hour}

// SetRetention changes the windows operations committed from now on are
// recorded with. Pins and replies already recorded keep the expiry they were
// given.
func (s *Store) SetRetention(r Retention) error {
	if r.PinFor < MinPinRetention {
		return fmt.Errorf("a before-image pin lasts at least %s after its operation, and %s is shorter",
			MinPinRetention, r.PinFor)
	}
	if r.ResultFor < MinResultRetention {
		return fmt.Errorf("an operation's reply is kept at least %s, and %s is shorter", MinResultRetention, r.ResultFor)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.retention = r
	return nil
}

// SetClock replaces the clock the store reads the time from: when an
// operation commits, whether a token has expired at the commit, and which pins
// and replies a purge finds expired. Nil restores the system clock. For a
// server whose own clock a test moves, so the two agree.
func (s *Store) SetClock(now func() time.Time) {
	if now == nil {
		now = time.Now
	}
	s.now.Store(&now)
}

// clock is the store's time. Held atomically rather than under writeMu,
// because the readers that ask it (a replay, a lookup, a purge's preview)
// take no lock.
func (s *Store) clock() time.Time {
	if now := s.now.Load(); now != nil {
		return (*now)()
	}
	return time.Now()
}

/* ---------------------------------------------------------------- *
 * The operation and its answer
 * ---------------------------------------------------------------- */

// Operation is one agent write, prepared and ready to commit (PLAN.md section
// 4.3, steps 1 to 3).
//
// Everything the caller could do outside the write lock is done: the actor
// authenticated, the request validated, the new bytes computed, chunked, and
// stored through chunks.Writer with Close, so every body an entry names is
// durable before anything names it (rule 1). What is left is what only the
// commit boundary can answer, and CommitOperation answers it.
type Operation struct {
	Vault string

	// ActorKind is what the actor is: ActorMCP, the default when empty, or,
	// for an undo alone, ActorOperator or ActorDevice (see oplogSchema).
	ActorKind string
	// ActorID is the MCP token's id, which is also its author id, and
	// ActorHash the stored hash of the token it authenticated with
	// (MCPTokenHash). The hash is compared, not recorded: a token minted
	// later under the same id cannot carry a request made with the old one.
	// For a device they are its device id and the hash of its token, checked
	// the same way; for the operator, OperatorActorID and no hash, because
	// reaching the control socket is the operator's credential.
	ActorID   string
	ActorHash string
	// ActorLabel is the name the request was prepared under, which every
	// entry's Device must be and which the audit records. A token whose
	// author row says otherwise at commit is not the credential the request
	// was prepared with.
	ActorLabel string

	// Tool is what the operation is recorded as: the MCP tool's name, or
	// UndoTool or UndoToCopyTool for an undo, whoever asked for it.
	Tool string
	// Undoes is, for an undo, the id of the operation it undoes, which the
	// log records beside it. An undo in place (UndoTool) commits only if no
	// other undo in place of the same operation has (ErrAlreadyUndone).
	Undoes string
	// IdempotencyKey is the caller's name for this request, or empty. The
	// same key with the same RequestDigest replays the recorded reply; with a
	// different one it is refused (PLAN.md section 4.8).
	IdempotencyKey string
	// RequestDigest is the hex SHA-256 of the canonical request, which is
	// what makes "the same request" a comparison rather than a guess. It is
	// the tool layer's to define; the store needs only its shape.
	RequestDigest string
	// Epoch is the store epoch the request was prepared under (Store.Epoch).
	// Every uid in it belongs to that epoch's history, and a restore mints
	// another (PLAN.md section 2.8).
	Epoch string
	// SnapshotHead, when set, is the vault head a preview was computed at,
	// and the operation commits only if the vault's latest uid is still that
	// (preview-then-apply, section 4.3): conservative, and honest about what
	// a preview read that no base covers.
	SnapshotHead *int64

	// Entries are the writes, in order. Each is checked against the state the
	// earlier ones left, as a device batch is (plan/protocol.md, "Paths"), and
	// any refusal refuses them all.
	Entries []OpEntry
	// Checks are preconditions with no write: a path that must still be at a
	// version. A noop (the caller found the bytes identical) is an operation
	// with checks and no entries, and still revalidates at the boundary.
	Checks []OpCheck

	// ClientName and ClientVersion are what the MCP client said it is, stored
	// capped and untrusted.
	ClientName    string
	ClientVersion string

	// Render builds the reply from what committed. It is called before the
	// lock with every number at its widest (MaxUID), so an oversized reply is
	// refused before anything is written, and again inside the transaction
	// with the real ones; the second rendering is what is recorded and
	// returned, and it is held to MaxResult too. It must not put a note's body
	// in the reply: the reply is stored for the retention window.
	Render func(OpResult) ([]byte, error)
	// MaxResult is the largest reply, in bytes, the caller can send.
	MaxResult int
}

// OpEntry is one write of an operation and the version it was prepared
// against.
//
// Base is the path's head as the caller read it, and zero asserts that the
// path holds nothing live: an exclusive create, as AppendCurrent's zero base
// is. PrevBase, for a move (Entry.Prev set), is the source's head.
//
// EmptyFolder, on a deletion of a folder, commits it only if nothing live is
// left inside the folder once the entries before it are written: an undo
// removes a folder its operation made only when the folder is empty (PLAN.md
// M5 task 7), and a note someone put in it since the plan was made must stop
// the whole operation rather than be left inside a folder that is gone.
type OpEntry struct {
	Entry       Entry
	Base        int64
	PrevBase    int64
	EmptyFolder bool
}

// OpCheck is a precondition with no write: Path must still be at Base, or,
// with Base zero, hold nothing live.
type OpCheck struct {
	Path string
	Base int64
}

// OpResult is what an operation committed, which Render turns into a reply.
type OpResult struct {
	OpID  string
	Epoch string
	// CommittedAt is the server's clock at commit, in milliseconds, never
	// earlier than any operation committed before it on the vault.
	CommittedAt int64
	// Noop is an operation that wrote nothing and revalidated its checks.
	Noop bool
	// Entries are the writes as committed, in order.
	Entries []OpResultEntry

	// Result is the rendered reply, as recorded. Set on return, and never
	// passed to Render.
	Result []byte
	// Replayed says this is an earlier operation's recorded reply, returned
	// for the same idempotency key and request: nothing was written by this
	// call. Entries is empty on a replay; Result is the answer.
	Replayed bool
}

// OpResultEntry is one committed write.
type OpResultEntry struct {
	// Entry is the version as committed, with its uid. What a caller
	// broadcasts to the devices, after the commit (PLAN.md section 4.3, step
	// 6).
	Entry Entry
	// PreviousUID is the path's head before this write, zero when the path
	// had never held a version, and PreviousGone says that head left the
	// path with nothing in it: a deletion, or a rename away. A create over
	// either is still a create.
	PreviousUID  int64
	PreviousGone bool
	// SourceUID is, for a move, the source's head before it: the version the
	// move displaced from the old name. SourceGone says that head had
	// already left the source empty, which a device's move may meet and an
	// agent's should not.
	SourceUID  int64
	SourceGone bool
}

// Committed is the entries an operation wrote, uids set, for the broadcast.
func (r OpResult) Committed() []Entry {
	out := make([]Entry, len(r.Entries))
	for i, e := range r.Entries {
		out[i] = e.Entry
	}
	return out
}

/* ---------------------------------------------------------------- *
 * Why an operation did not commit
 * ---------------------------------------------------------------- */

// OpOutcome says what is known about an operation that returned an error.
//
// Three answers, because they call for three different actions from the agent
// and from the person reading the log at 2am (PLAN.md section 4.8). Refused
// and failed both mean nothing was written, and one is the request's fault
// and the other the store's; unknown means the store cannot say, and the
// operation's id or idempotency key is how to find out.
type OpOutcome int

const (
	// OpRefused is a precondition or a validation saying no before anything
	// was written: stale, exists, a changed plan, a revoked actor. Nothing is
	// committed and the request, as it stands, never will be.
	OpRefused OpOutcome = iota + 1
	// OpFailed is the store failing before it committed: a statement erred
	// and the transaction rolled back. Nothing is committed; the same request
	// may succeed later.
	OpFailed
	// OpUnknown is the commit itself failing. SQLite may have made the
	// transaction durable before it reported the failure, so the operation
	// may or may not have happened. LookupOperation with the error's OpID, or
	// Replay with the idempotency key, says which.
	OpUnknown
)

func (o OpOutcome) String() string {
	switch o {
	case OpRefused:
		return "refused"
	case OpFailed:
		return "failed"
	case OpUnknown:
		return "unknown"
	}
	return fmt.Sprintf("outcome(%d)", int(o))
}

// The codes an operation's refusal carries: plan/mcp-tools.md's vocabulary
// ("Error codes"), which the tool layer answers with. Two are not in that
// list yet: `collision`, which PLAN.md section 4.1 gives the case-fold rule
// for MCP creates and moves as it does for devices, and `key_reused`, the
// refusal section 4.8 asks for and the list does not name.
const (
	OpCodeStale          = "stale"
	OpCodeExists         = "exists"
	OpCodePlanChanged    = "plan_changed"
	OpCodeReadOnly       = "read_only"
	OpCodeBadPath        = "badpath"
	OpCodeCollision      = "collision"
	OpCodeDuplicatePath  = "duplicate_path"
	OpCodeKeyReused      = "key_reused"
	OpCodeResultTooLarge = "result_too_large"
	OpCodeInternal       = "internal"

	// The refusals only an undo earns (undo.go). already_undone is an
	// operation an undo in place has already compensated for; not_empty is
	// a folder the operation made that holds something it did not; gone is a
	// before-image purge has removed; nothing_to_undo is an operation that
	// wrote nothing an undo could put back, or a copy with nothing to copy;
	// not_found is an operation id this vault, or this caller, has no
	// operation under.
	OpCodeAlreadyUndone = "already_undone"
	OpCodeNotEmpty      = "not_empty"
	OpCodeGone          = "gone"
	OpCodeNothingToUndo = "nothing_to_undo"
	OpCodeNotFound      = "not_found"
)

var (
	// ErrRefused matches every OpError whose outcome is OpRefused: refused
	// before commit, nothing written.
	ErrRefused = errors.New("the operation was refused before it committed; nothing was written")
	// ErrOutcomeUnknown matches every OpError whose outcome is OpUnknown.
	ErrOutcomeUnknown = errors.New("the operation's commit failed, and it may or may not have committed")

	// ErrExists is a write whose base said the path holds nothing live, onto
	// a path that does.
	ErrExists = errors.New("the path already holds a file or folder")
	// ErrPlanChanged is an operation bound to a snapshot head the vault has
	// moved past.
	ErrPlanChanged = errors.New("the vault changed since this operation was previewed")
	// ErrActorCannotWrite is an actor that cannot write at the commit
	// boundary: revoked, expired, read scope, or no longer the credential the
	// request was prepared with (PLAN.md section 2.3).
	ErrActorCannotWrite = errors.New("this token was revoked, expired or cannot write")
	// ErrEpochChanged is an operation prepared under another epoch: the store
	// was restored since, and the uids it names may mean other versions.
	ErrEpochChanged = errors.New("the store was restored since this operation was prepared")
	// ErrKeyReused is an idempotency key this actor already used for a
	// different request.
	ErrKeyReused = errors.New("this idempotency key was already used for a different request")
	// ErrReplayFromEarlierEpoch is an idempotency key whose recorded
	// operation belongs to the history before a restore. Its reply describes
	// uids that history issued, and the restored store may issue them again
	// to other versions, so it is not replayed as though it described this
	// one; see Replay.
	ErrReplayFromEarlierEpoch = errors.New("this idempotency key names an operation from before the store was restored")
	// ErrResultTooLarge is a reply over MaxResult, found before anything was
	// written.
	ErrResultTooLarge = errors.New("the operation's reply would be larger than the caller can send")
	// ErrDuplicatePath is an operation naming one path twice.
	ErrDuplicatePath = errors.New("the operation names one path twice")
	// ErrAlreadyUndone is an undo in place of an operation another undo in
	// place has already compensated for.
	ErrAlreadyUndone = errors.New("this operation has already been undone")
	// ErrFolderFilled is a folder deletion marked EmptyFolder whose folder
	// still holds something live at the commit. Every deletion is refused
	// then (ErrFolderNotEmpty, which is stale); an undo's is refused first,
	// and as not_empty, because its answer is not a device's: asked again,
	// the undo keeps the folder rather than reconcile anything.
	ErrFolderFilled = errors.New("the folder is not empty")
)

// OpError is why an operation did not commit, or why nobody can say whether it
// did.
type OpError struct {
	Outcome OpOutcome
	// Code is the refusal's code; OpCodeInternal for a failure and an unknown
	// outcome.
	Code string
	// Path is the path the refusal is about, when it is about one.
	Path string
	// CurrentUID is that path's head as it stands, for stale and exists, and
	// the vault's head for plan_changed: what the agent reads again from.
	CurrentUID int64
	// OpID is the id this operation had. For OpUnknown it is the id to look
	// the operation up by.
	OpID string
	Err  error
}

func (e *OpError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s (%s)", e.Code, e.Outcome)
	if e.Path != "" {
		fmt.Fprintf(&b, " at %q", e.Path)
	}
	if e.CurrentUID != 0 {
		fmt.Fprintf(&b, ", now at uid %d", e.CurrentUID)
	}
	if e.Err != nil {
		fmt.Fprintf(&b, ": %v", e.Err)
	}
	return b.String()
}

func (e *OpError) Unwrap() error { return e.Err }

// Is makes errors.Is(err, ErrRefused) and errors.Is(err, ErrOutcomeUnknown)
// answer from the outcome, whatever the cause underneath.
func (e *OpError) Is(target error) bool {
	switch target {
	case ErrRefused:
		return e.Outcome == OpRefused
	case ErrOutcomeUnknown:
		return e.Outcome == OpUnknown
	}
	return false
}

func refused(opID, code, path string, current int64, err error) *OpError {
	return &OpError{Outcome: OpRefused, Code: code, Path: path, CurrentUID: current, OpID: opID, Err: err}
}

func failed(opID string, err error) *OpError {
	return &OpError{Outcome: OpFailed, Code: OpCodeInternal, OpID: opID, Err: err}
}

// refusalOf is the refusal a validation error earns: badpath for the path
// policy, internal for everything else an entry got wrong, because an MCP
// entry is built by the server's own tool code and a malformed one is that
// code's fault, not the agent's.
func refusalOf(opID string, e Entry, err error) *OpError {
	var pe *PathError
	if errors.As(err, &pe) {
		path := e.Path
		if pe.Field == "prev" {
			path = e.Prev
		}
		return refused(opID, OpCodeBadPath, path, 0, err)
	}
	return refused(opID, OpCodeInternal, e.Path, 0, err)
}

/* ---------------------------------------------------------------- *
 * CommitOperation
 * ---------------------------------------------------------------- */

// errReplayed rolls back the transaction of an operation answered from its
// idempotency record: there is nothing to write.
var errReplayed = errors.New("replayed")

// CommitOperation commits an agent's operation all or nothing, with its audit
// record, its pins and its reply, in one transaction (PLAN.md section 4.3,
// steps 4 and 5).
//
// Under writeMu, the lock every device commit and every credential change in
// this store takes, and inside one transaction begun IMMEDIATE, it rechecks
// everything that could have changed since the request was prepared:
//
//  1. The credential as it stands now: the token row still there, its hash
//     the one the request authenticated with, write scope, not expired, and
//     its author still named ActorLabel. RevokeMCPToken takes the same lock,
//     so a revoke either lands before this check and the operation is
//     refused, or after the commit (section 2.3.1).
//  2. The epoch.
//  3. The idempotency key: the same request is answered from its record, a
//     different one refused.
//  4. The snapshot head, when the operation is bound to one.
//  5. Every check and every entry's base and prevBase, and the path and
//     collision rules as a device batch meets them (writeEntry, the function
//     a device put runs).
//
// Then it writes the entries, the operations row, op_entries, a pin for every
// version the operation displaced, the key, and the rendered reply. Any
// refusal or failure rolls every one of them back: zero entries committed,
// no uid consumed, nothing recorded. There is no fallback to committing one
// entry at a time, which is what separates this from AppendMany.
//
// A noop, an operation with no entries, runs the same checks and records an
// operation with outcome "noop" and no entries or pins. Recorded, so a key
// names one outcome for as long as it lasts: replayed, a noop's key answers
// "nothing changed" rather than being computed again against a head that may
// have moved since.
//
// The caller broadcasts OpResult.Committed after this returns, under the
// commit lock it holds around this call (server.UnderCommitLock), and replies
// with OpResult.Result. An error is always an *OpError; see OpOutcome for
// what each outcome means.
func (s *Store) CommitOperation(op Operation) (OpResult, error) {
	opID, err := newOperationID()
	if err != nil {
		return OpResult{}, failed("", err)
	}
	if err := op.validate(opID); err != nil {
		return OpResult{}, err
	}

	// The widest the reply can be, before any lock: a reply that cannot be
	// sent is refused before anything is written, and before a device waits
	// on the lock for it (PLAN.md section 4.3, step 5).
	widest := OpResult{OpID: opID, Epoch: op.Epoch, CommittedAt: MaxUID, Noop: len(op.Entries) == 0}
	for _, oe := range op.Entries {
		e := oe.Entry
		e.UID = MaxUID
		var source int64
		if e.Prev != "" {
			source = MaxUID
		}
		widest.Entries = append(widest.Entries, OpResultEntry{Entry: e, PreviousUID: MaxUID, SourceUID: source})
	}
	if b, err := op.Render(widest); err != nil {
		return OpResult{}, failed(opID, fmt.Errorf("rendering the reply: %w", err))
	} else if len(b) > op.MaxResult {
		return OpResult{}, refused(opID, OpCodeResultTooLarge, "", 0,
			fmt.Errorf("%w: up to %d bytes, and the limit is %d", ErrResultTooLarge, len(b), op.MaxResult))
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	// Presence and sizes under the lock, for the reason appendEntry gives:
	// checked anywhere else, they race the chunk sweep.
	for _, oe := range op.Entries {
		if err := s.sizeAccountedFor(op.Vault, oe.Entry); err != nil {
			return OpResult{}, refused(opID, OpCodeInternal, oe.Entry.Path, 0, err)
		}
	}
	if s.betweenCheckAndCommit != nil {
		s.betweenCheckAndCommit()
	}

	var res OpResult
	done, err := s.operationTx(func(q execer) error {
		var err error
		res, err = s.commitOperationTx(q, op, opID)
		return err
	})
	switch {
	case errors.Is(err, errReplayed):
		return res, nil
	case err != nil && done:
		// The transaction was complete and the COMMIT is what failed.
		return OpResult{}, &OpError{Outcome: OpUnknown, Code: OpCodeInternal, OpID: opID,
			Err: fmt.Errorf("%w: %v", ErrOutcomeUnknown, err)}
	case err != nil:
		var oe *OpError
		if errors.As(err, &oe) {
			return OpResult{}, oe
		}
		return OpResult{}, failed(opID, err)
	}
	if len(res.Entries) > 0 {
		s.notifyCommitted()
	}
	return res, nil
}

// commitOperationTx is the transaction's body: every recheck, then every
// write, in the order CommitOperation gives.
func (s *Store) commitOperationTx(q execer, op Operation, opID string) (OpResult, error) {
	now := s.clock().UnixMilli()

	// 1. The credential, as it stands under the lock.
	if err := checkActor(q, op, now); err != nil {
		return OpResult{}, refused(opID, OpCodeReadOnly, "", 0, err)
	}

	// 2. The epoch, from the row rather than the handle, because the row is
	// what a restore changed.
	var epoch string
	if err := q.QueryRow(`SELECT epoch FROM store_identity WHERE id = 1`).Scan(&epoch); err != nil {
		return OpResult{}, fmt.Errorf("reading the store epoch: %w", err)
	}
	if epoch != op.Epoch {
		return OpResult{}, refused(opID, OpCodeStale, "", 0, fmt.Errorf(
			"%w: it names epoch %q and the store is at %q, so the uids it was prepared against may "+
				"now be other versions; read again and prepare it afresh", ErrEpochChanged, op.Epoch, epoch))
	}

	// 3. The idempotency key. A replay writes nothing, so it leaves by
	// rolling back.
	if op.IdempotencyKey != "" {
		rec, found, err := lookupKey(q, true, op.Vault, op.ActorID, op.IdempotencyKey, op.RequestDigest, epoch, now)
		if err != nil {
			return OpResult{}, err
		}
		if found {
			return rec, errReplayed
		}
	}

	// 4. The snapshot a preview was computed at.
	if op.SnapshotHead != nil {
		var head int64
		if err := q.QueryRow(`SELECT COALESCE(MAX(uid), 0) FROM entries WHERE vault_id = ?`, op.Vault).Scan(&head); err != nil {
			return OpResult{}, err
		}
		if head != *op.SnapshotHead {
			return OpResult{}, refused(opID, OpCodePlanChanged, "", head, fmt.Errorf(
				"%w: previewed at uid %d, and the vault is at uid %d", ErrPlanChanged, *op.SnapshotHead, head))
		}
	}

	// 4b. What an undo undoes: an operation of this vault and its epoch and,
	// for an undo in place, one no other undo in place has compensated for.
	// Two undos of one operation prepared at once both find the heads it
	// left; the first to commit moves them, so the second's bases refuse it
	// too, and this names the reason rather than leaving it to a stale path.
	if op.Undoes != "" {
		var vault, epochOf string
		var undoneBy sql.NullString
		err := q.QueryRow(
			`SELECT o.vault_id, o.epoch,
			        (SELECT u.id FROM operations u WHERE u.undoes = o.id AND u.tool = ? ORDER BY u.seq LIMIT 1)
			   FROM operations o WHERE o.id = ?`, UndoTool, op.Undoes).Scan(&vault, &epochOf, &undoneBy)
		switch {
		case errors.Is(err, sql.ErrNoRows) || (err == nil && vault != op.Vault):
			return OpResult{}, refused(opID, OpCodeNotFound, "", 0, fmt.Errorf(
				"%w: no operation %s on this vault", ErrNoOperation, op.Undoes))
		case err != nil:
			return OpResult{}, err
		case epochOf != epoch:
			return OpResult{}, refused(opID, OpCodeStale, "", 0, fmt.Errorf(
				"%w: operation %s was recorded before the store was restored", ErrEpochChanged, op.Undoes))
		case op.Tool == UndoTool && undoneBy.Valid:
			return OpResult{}, refused(opID, OpCodeAlreadyUndone, "", 0, fmt.Errorf(
				"%w: operation %s undid it", ErrAlreadyUndone, undoneBy.String))
		}
	}

	// 5. The checks, then the entries, each against the state the earlier
	// ones left.
	for _, c := range op.Checks {
		head, gone, err := pathHead(q, op.Vault, c.Path)
		if err != nil {
			return OpResult{}, err
		}
		if head != c.Base && !(c.Base == 0 && gone) {
			return OpResult{}, refused(opID, OpCodeStale, c.Path, head, fmt.Errorf(
				"%w: prepared against uid %d, and the path is at uid %d", ErrStale, c.Base, head))
		}
	}

	res := OpResult{OpID: opID, Epoch: epoch, Noop: len(op.Entries) == 0}
	for i, oe := range op.Entries {
		e := oe.Entry
		head, gone, err := pathHead(q, op.Vault, e.Path)
		if err != nil {
			return OpResult{}, err
		}
		switch {
		case oe.Base == 0 && head != 0 && !gone:
			return OpResult{}, refused(opID, OpCodeExists, e.Path, head, fmt.Errorf(
				"%w: it was to be created, and uid %d is there", ErrExists, head))
		case head != oe.Base && !(oe.Base == 0 && gone):
			return OpResult{}, refused(opID, OpCodeStale, e.Path, head, fmt.Errorf(
				"%w: prepared against uid %d, and the path is at uid %d", ErrStale, oe.Base, head))
		}
		var source int64
		var sourceGone bool
		if e.Prev != "" {
			source, sourceGone, err = pathHead(q, op.Vault, e.Prev)
			if err != nil {
				return OpResult{}, err
			}
			if source != oe.PrevBase && !(oe.PrevBase == 0 && sourceGone) {
				return OpResult{}, refused(opID, OpCodeStale, e.Prev, source, fmt.Errorf(
					"%w: the move's source was prepared against uid %d, and is at uid %d", ErrStale, oe.PrevBase, source))
			}
		}
		if oe.EmptyFolder {
			// A live folder counts itself once in live_dirs and once more for
			// every live path beneath it (dirsOf), with the entries before
			// this one already applied, so one is empty.
			var refs int64
			if err := q.QueryRow(`SELECT COALESCE((SELECT refs FROM live_dirs WHERE vault_id = ? AND path = ?), 0)`,
				op.Vault, e.Path).Scan(&refs); err != nil {
				return OpResult{}, err
			}
			if refs > 1 {
				return OpResult{}, refused(opID, OpCodeNotEmpty, e.Path, head, fmt.Errorf(
					"%w: %d live paths are inside it", ErrFolderFilled, refs-1))
			}
		}

		base := oe.Base
		uid, err := writeEntry(q, op.Vault, e, &base, oe.PrevBase)
		switch {
		case errors.Is(err, ErrCollision):
			return OpResult{}, refused(opID, OpCodeCollision, e.Path, 0, err)
		case errors.Is(err, ErrStale):
			// The base checks above are writeEntry's own, so this is reached
			// only by a folder deletion with something live still in it
			// (ErrFolderNotEmpty), one not marked EmptyFolder: an undo's is
			// refused above as not_empty.
			return OpResult{}, refused(opID, OpCodeStale, e.Path, head, err)
		case errors.Is(err, ErrBadEntry), errors.Is(err, ErrUnknownVault):
			return OpResult{}, refused(opID, OpCodeInternal, e.Path, 0, err)
		case err != nil:
			return OpResult{}, err
		}
		e.UID = uid
		res.Entries = append(res.Entries, OpResultEntry{
			Entry: e, PreviousUID: head, PreviousGone: gone, SourceUID: source, SourceGone: sourceGone,
		})
		if err := s.operationFault(fmt.Sprintf("entry %d", i)); err != nil {
			return OpResult{}, err
		}
	}

	// The commit time: the server's clock, and never earlier than the last
	// operation's, so a clock stepped backwards cannot make a pin expire
	// sooner than one made before it (PLAN.md section 4.11).
	var last sql.NullInt64
	if err := q.QueryRow(`SELECT MAX(committed_at) FROM operations WHERE vault_id = ?`, op.Vault).Scan(&last); err != nil {
		return OpResult{}, err
	}
	res.CommittedAt = max(now, last.Int64)

	// The reply, from the real uids, bounded again: Render was only asked to
	// be no wider for smaller numbers, and a reply over the limit is refused
	// here with the entries still uncommitted.
	reply, err := op.Render(res)
	if err != nil {
		return OpResult{}, fmt.Errorf("rendering the reply: %w", err)
	}
	if len(reply) > op.MaxResult {
		return OpResult{}, refused(opID, OpCodeResultTooLarge, "", 0,
			fmt.Errorf("%w: %d bytes, and the limit is %d", ErrResultTooLarge, len(reply), op.MaxResult))
	}
	res.Result = reply

	outcome := "committed"
	if res.Noop {
		outcome = "noop"
	}
	resultUntil := res.CommittedAt + s.retention.ResultFor.Milliseconds()
	pinUntil := res.CommittedAt + s.retention.PinFor.Milliseconds()
	if _, err := q.Exec(
		`INSERT INTO operations (id, vault_id, actor_id, actor_kind, actor_label, tool, undoes, request_digest,
		                         idempotency_key, epoch, committed_at, outcome, snapshot_head,
		                         client_name, client_version, result, result_expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		opID, op.Vault, op.ActorID, op.kind(), op.ActorLabel, op.Tool, nullableText(op.Undoes), op.RequestDigest,
		nullableText(op.IdempotencyKey), epoch, res.CommittedAt, outcome, nullableInt(op.SnapshotHead),
		clientInfo(op.ClientName), clientInfo(op.ClientVersion), reply, resultUntil); err != nil {
		return OpResult{}, fmt.Errorf("recording the operation: %w", err)
	}
	if err := s.operationFault("operation"); err != nil {
		return OpResult{}, err
	}

	// Every path it changed, with its version before and after, and a pin for
	// each version it displaced. A pin is made only where the path held
	// something: over a deletion or a rename away there is nothing to keep,
	// and pinning the tombstone would keep a row that restores nothing.
	ord := 0
	pins := map[int64]bool{}
	record := func(role, path string, before int64, beforeGone bool, after int64) error {
		state := BeforeLive
		switch {
		case before == 0:
			state = BeforeNone
		case beforeGone:
			state = BeforeGone
		}
		if _, err := q.Exec(
			`INSERT INTO op_entries (op_id, ord, role, path, before_uid, before_state, after_uid)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			opID, ord, role, path, nullableUID(before), state, after); err != nil {
			return fmt.Errorf("recording the paths the operation changed: %w", err)
		}
		ord++
		if before != 0 && !beforeGone {
			pins[before] = true
		}
		return nil
	}
	for _, r := range res.Entries {
		if err := record("write", r.Entry.Path, r.PreviousUID, r.PreviousGone, r.Entry.UID); err != nil {
			return OpResult{}, err
		}
		if r.Entry.Prev != "" {
			if err := record("source", r.Entry.Prev, r.SourceUID, r.SourceGone, r.Entry.UID); err != nil {
				return OpResult{}, err
			}
		}
	}
	if err := s.operationFault("op_entries"); err != nil {
		return OpResult{}, err
	}
	for uid := range pins {
		if _, err := q.Exec(`INSERT INTO op_pins (op_id, vault_id, uid, expires_at) VALUES (?, ?, ?, ?)`,
			opID, op.Vault, uid, pinUntil); err != nil {
			return OpResult{}, fmt.Errorf("pinning the versions the operation displaced: %w", err)
		}
	}
	if err := s.operationFault("pins"); err != nil {
		return OpResult{}, err
	}

	if op.IdempotencyKey != "" {
		// An expired key under the same name was released by lookupKey,
		// inside this transaction, so this insert is its replacement.
		if _, err := q.Exec(
			`INSERT INTO op_keys (actor_id, idempotency_key, vault_id, op_id, expires_at) VALUES (?, ?, ?, ?, ?)`,
			op.ActorID, op.IdempotencyKey, op.Vault, opID, resultUntil); err != nil {
			return OpResult{}, fmt.Errorf("recording the idempotency key: %w", err)
		}
	}
	if err := s.operationFault("keys"); err != nil {
		return OpResult{}, err
	}
	return res, nil
}

// operationFault is the test seam inside an operation's transaction: an error
// from it stands in for the statement just run failing. Nil in every non-test
// build.
func (s *Store) operationFault(step string) error {
	if s.duringOperation == nil {
		return nil
	}
	return s.duringOperation(step)
}

// operationTx runs fn in a transaction begun IMMEDIATE on one pinned
// connection, as immediate does, and reports whether fn completed: an error
// with done set is the COMMIT failing, which is the one error whose outcome
// nobody can state. A failed commit's effects may be in the log already, and
// recovered on the next open, so it is not reported as "nothing written".
func (s *Store) operationTx(fn func(q execer) error) (done bool, err error) {
	ctx := context.Background()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return false, err
	}
	abandon := func() {
		if _, err := conn.ExecContext(ctx, "ROLLBACK"); err != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}
	if err := fn(pinned{conn, ctx}); err != nil {
		abandon()
		return false, err
	}
	if s.failOperationCommit != nil {
		// Standing in for COMMIT failing. Rolled back, so what the test then
		// observes is the harder of the two cases: the caller told "unknown"
		// and the operation in fact absent.
		abandon()
		return true, s.failOperationCommit
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		abandon()
		return true, err
	}
	return true, nil
}

// checkActor is the credential as it stands in the caller's transaction.
//
// The operator has none to check: whoever reaches the control socket, mode
// 0600 in the data directory, can already read the database beside it
// (PLAN.md section 2.3.1). A device is checked as every device mutation is
// under the commit lock, its row still there with the hash it connected with,
// so a device revoked between asking and committing loses here.
func checkActor(q querier, op Operation, now int64) error {
	switch op.kind() {
	case ActorOperator:
		return nil
	case ActorDevice:
		var hash string
		err := q.QueryRow(`SELECT auth_hash FROM devices WHERE vault_id = ? AND device_id = ?`,
			op.Vault, op.ActorID).Scan(&hash)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return fmt.Errorf("%w: the device was revoked", ErrActorCannotWrite)
		case err != nil:
			return err
		case subtle.ConstantTimeCompare([]byte(hash), []byte(op.ActorHash)) != 1:
			return fmt.Errorf("%w: the device under this id is not the one the request was made by", ErrActorCannotWrite)
		}
		return nil
	}
	var hash, scope string
	var expires sql.NullInt64
	var author sql.NullString
	err := q.QueryRow(
		`SELECT t.token_hash, t.scope, t.expires_at, a.name
		   FROM mcp_tokens t
		   LEFT JOIN authors a ON a.vault_id = t.vault_id AND a.id = t.id AND a.kind = ?
		  WHERE t.vault_id = ? AND t.id = ?`,
		AuthorKindMCP, op.Vault, op.ActorID).Scan(&hash, &scope, &expires, &author)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("%w: the token was revoked", ErrActorCannotWrite)
	case err != nil:
		return err
	case subtle.ConstantTimeCompare([]byte(hash), []byte(op.ActorHash)) != 1:
		return fmt.Errorf("%w: the token under this id is not the one the request was made with", ErrActorCannotWrite)
	case expires.Valid && now >= expires.Int64:
		return fmt.Errorf("%w: the token expired", ErrActorCannotWrite)
	case !MCPScope(scope).Allows(ScopeWrite):
		return fmt.Errorf("%w: the token has %s scope", ErrActorCannotWrite, scope)
	case !author.Valid:
		return fmt.Errorf("%w: the token has no author row, so its writes would be recorded as nobody", ErrActorCannotWrite)
	case author.String != op.ActorLabel:
		return fmt.Errorf("%w: the token's author is %q, and the request was prepared as %q",
			ErrActorCannotWrite, author.String, op.ActorLabel)
	}
	return nil
}

// validate is every refusal an operation earns before the lock.
func (op Operation) validate(opID string) *OpError {
	bad := func(format string, args ...any) *OpError {
		return refused(opID, OpCodeInternal, "", 0, fmt.Errorf("%w: "+format, append([]any{ErrBadEntry}, args...)...))
	}
	switch kind := op.kind(); {
	case op.Vault == "":
		return bad("an operation names its vault")
	case kind == AuthorKindMCP && !ValidMCPTokenID(op.ActorID):
		return bad("the actor id %q is not an MCP token id", op.ActorID)
	case kind == ActorDevice && !ValidDeviceID(op.ActorID):
		return bad("the actor id %q is not a device id", op.ActorID)
	case kind == ActorOperator && (op.ActorID != OperatorActorID || op.ActorHash != ""):
		return bad("the operator is recorded as %q, with no credential", OperatorActorID)
	case kind != AuthorKindMCP && kind != ActorDevice && kind != ActorOperator:
		return bad("the actor kind %q is not one an operation has", kind)
	case kind != ActorOperator && !isHex64(op.ActorHash):
		return bad("the actor's token hash is a 64 character hex digest")
	case kind != AuthorKindMCP && op.Undoes == "":
		// The operator and the devices make undos and nothing else: every
		// other agent operation is an MCP tool's.
		return bad("only an undo is recorded as the %s's", kind)
	case op.Undoes != "" && !ValidOperationID(op.Undoes):
		return bad("the operation undone, %q, is not an operation id", op.Undoes)
	case op.Undoes != "" && op.Tool != UndoTool && op.Tool != UndoToCopyTool:
		return bad("an operation that undoes another is recorded as %q or %q", UndoTool, UndoToCopyTool)
	case op.Undoes == "" && (op.Tool == UndoTool || op.Tool == UndoToCopyTool):
		return bad("an undo names the operation it undoes")
	case op.ActorLabel == "":
		return bad("an operation's actor has a label, which its writes are recorded as")
	case op.Tool == "":
		return bad("an operation names the tool it is recorded as")
	case !isHex64(op.RequestDigest):
		return bad("the request digest is a 64 character hex SHA-256")
	case op.Epoch == "":
		return bad("an operation names the epoch it was prepared under")
	case len(op.Entries) > MaxOperationEntries:
		return bad("%d entries, and an operation has at most %d", len(op.Entries), MaxOperationEntries)
	case op.Render == nil:
		return bad("an operation renders its reply")
	case op.MaxResult <= 0:
		return bad("an operation bounds its reply")
	case len(op.IdempotencyKey) > MaxIdempotencyKeyLen:
		return bad("the idempotency key is %d bytes, and at most %d", len(op.IdempotencyKey), MaxIdempotencyKeyLen)
	case op.SnapshotHead != nil && ValidateBase(*op.SnapshotHead) != nil:
		return bad("the snapshot head %d is not a uid", *op.SnapshotHead)
	}
	if err := CheckName("actor", op.ActorLabel, MaxMCPLabelLen); err != nil {
		return bad("%v", err)
	}
	if err := CheckName("tool", op.Tool, MaxToolNameLen); err != nil {
		return bad("%v", err)
	}
	if err := checkKey(op.IdempotencyKey); err != nil {
		return bad("%v", err)
	}

	// One path once. Two writes to one path cannot both name its head as
	// their base, and a path that is a move's source and another write's
	// destination is two operations, not one.
	named := map[string]bool{}
	name := func(p string) *OpError {
		if named[p] {
			return refused(opID, OpCodeDuplicatePath, p, 0, fmt.Errorf("%w: %q", ErrDuplicatePath, p))
		}
		named[p] = true
		return nil
	}
	for _, c := range op.Checks {
		if r := checkPath(c.Path); r != nil {
			return refusalOf(opID, Entry{Path: c.Path}, r)
		}
		if err := ValidateBase(c.Base); err != nil {
			return refused(opID, OpCodeInternal, c.Path, 0, err)
		}
		if err := name(c.Path); err != nil {
			return err
		}
	}
	for _, oe := range op.Entries {
		e := oe.Entry
		if err := checkConditional(e, oe.Base, oe.PrevBase); err != nil {
			return refused(opID, OpCodeInternal, e.Path, 0, err)
		}
		if err := e.Validate(); err != nil {
			return refusalOf(opID, e, err)
		}
		if e.Device != op.ActorLabel {
			return bad("the entry for %q is recorded as %q, and the operation's actor is %q", e.Path, e.Device, op.ActorLabel)
		}
		if oe.EmptyFolder && !e.Deleted {
			return bad("the entry for %q commits only if its folder is empty, and deletes nothing", e.Path)
		}
		if err := name(e.Path); err != nil {
			return err
		}
		if e.Prev != "" {
			if err := name(e.Prev); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkPath is the path policy on a bare path, as Entry.CheckPaths applies
// it to an entry's.
func checkPath(p string) error { return Entry{Path: p}.CheckPaths() }

// checkKey is an idempotency key's shape: empty for none, or text with no
// control characters. Not a name, but held to the same rule, because it lands
// in the audit and a newline in it would forge a line of `trewd audit`.
func checkKey(key string) error {
	if key == "" {
		return nil
	}
	if !utf8.ValidString(key) {
		return errors.New("the idempotency key is not valid UTF-8")
	}
	return CheckName("idempotency key", key, MaxIdempotencyKeyLen)
}

// clientInfo is a client's self-description as it is stored: valid UTF-8, no
// control characters, at most MaxClientInfoLen bytes, cut at a character.
func clientInfo(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	for len(s) > MaxClientInfoLen {
		_, n := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-n]
	}
	return s
}

// newOperationID mints an operation id: 16 random bytes, base64url.
func newOperationID() (string, error) {
	b := make([]byte, OperationIDBytes)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", fmt.Errorf("minting an operation id: %w", err)
	}
	return EncodeToken(b), nil
}

// ValidOperationID reports whether s is an operation id's shape.
func ValidOperationID(s string) bool {
	_, ok := DecodeToken(s, OperationIDBytes)
	return ok
}

func nullableText(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableUID(uid int64) any {
	if uid == 0 {
		return nil
	}
	return uid
}

/* ---------------------------------------------------------------- *
 * Idempotency
 * ---------------------------------------------------------------- */

// Replay is the recorded reply to an earlier operation by actorID under key,
// when there is one to give: the same request, recorded in this epoch, its key
// not yet expired (PLAN.md section 4.8).
//
// The tool layer asks this before it prepares anything. A retry cannot be
// prepared again and then matched, because preparing it again reads the heads
// its first attempt moved: an append retried would append twice, and an edit
// retried would be refused as stale for the first attempt's own write. So the
// key is answered first, and CommitOperation asks again inside its transaction
// for the retry that races the original.
//
// found is false for a key that was never used, or has expired: the request is
// then new. The same key for a different request is ErrKeyReused, and a key
// whose operation was recorded before the store was restored is
// ErrReplayFromEarlierEpoch, both as refusals.
//
// It does not check the credential. The caller authenticated the request, and
// a reply is a read: a token revoked since loses at the recheck the caller
// makes before any reply is sent, as it does for every other read.
//
// # Why a replay across a restore is refused
//
// A backup's database is given a new epoch, and restoring is serving it. The
// operations it carries were recorded under the old epoch, and their replies
// name uids of the old history. The restored store reissues every uid above
// the snapshot to whatever is written next, so a reply replayed there would be
// describing versions that are not the ones its uids now name, to an agent that
// would go on to use them as bases. The agent has to read again, and it is
// told so. The operation itself stays in the audit and in LookupOperation, with
// its epoch, so what it did before the restore is still on record.
func (s *Store) Replay(vaultID, actorID, key, digest string) (OpResult, bool, error) {
	if key == "" {
		return OpResult{}, false, nil
	}
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return OpResult{}, false, err
	}
	defer tx.Rollback()
	var epoch string
	if err := tx.QueryRow(`SELECT epoch FROM store_identity WHERE id = 1`).Scan(&epoch); err != nil {
		return OpResult{}, false, err
	}
	return lookupKey(tx, false, vaultID, actorID, key, digest, epoch, s.clock().UnixMilli())
}

// lookupKey answers an idempotency key in the caller's transaction. A key
// that has expired is released when release is set, which is the committing
// transaction's case, so the insert that follows can reuse its name; a read
// leaves it for that insert to meet.
func lookupKey(q execer, release bool, vaultID, actorID, key, digest, epoch string, now int64) (OpResult, bool, error) {
	var opID, recordedDigest, recordedEpoch, outcome string
	var expires, committedAt int64
	var result []byte
	err := q.QueryRow(
		`SELECT k.op_id, k.expires_at, o.request_digest, o.epoch, o.outcome, o.committed_at, o.result
		   FROM op_keys k JOIN operations o ON o.id = k.op_id
		  WHERE k.actor_id = ? AND k.idempotency_key = ? AND k.vault_id = ?`,
		actorID, key, vaultID).Scan(&opID, &expires, &recordedDigest, &recordedEpoch, &outcome, &committedAt, &result)
	if errors.Is(err, sql.ErrNoRows) {
		return OpResult{}, false, nil
	}
	if err != nil {
		return OpResult{}, false, err
	}
	if now >= expires {
		if release {
			if _, err := q.Exec(`DELETE FROM op_keys WHERE actor_id = ? AND idempotency_key = ?`, actorID, key); err != nil {
				return OpResult{}, false, err
			}
		}
		return OpResult{}, false, nil
	}
	if subtle.ConstantTimeCompare([]byte(recordedDigest), []byte(digest)) != 1 {
		return OpResult{}, false, refused("", OpCodeKeyReused, "", 0, fmt.Errorf(
			"%w: operation %s was committed under it; use a new key for a new request", ErrKeyReused, opID))
	}
	if recordedEpoch != epoch {
		return OpResult{}, false, refused("", OpCodeStale, "", 0, fmt.Errorf(
			"%w: operation %s was recorded in epoch %q and the store is at %q. Its reply names versions "+
				"of the history before the restore; read again, and use a new key", ErrReplayFromEarlierEpoch,
			opID, recordedEpoch, epoch))
	}
	if result == nil {
		// Rule 2: a reply that should be there and is not is not an empty
		// reply. Keys and replies expire together, so this is a store that
		// has lost one without the other.
		return OpResult{}, false, failed("", fmt.Errorf("operation %s has an unexpired key and no recorded reply", opID))
	}
	return OpResult{OpID: opID, Epoch: recordedEpoch, CommittedAt: committedAt, Noop: outcome == "noop",
		Result: result, Replayed: true}, true, nil
}

/* ---------------------------------------------------------------- *
 * The audit
 * ---------------------------------------------------------------- */

// OperationRecord is one operation as the audit shows it and as a lost reply
// is resolved from.
type OperationRecord struct {
	Seq        int64  `json:"seq"`
	ID         string `json:"id"`
	ActorID    string `json:"actorId"`
	ActorKind  string `json:"actorKind"`
	ActorLabel string `json:"actorLabel"`
	Tool       string `json:"tool"`
	// Undoes is, for an undo, the operation it undoes; UndoneBy is, for any
	// operation, the undo in place that undid it, if one has.
	Undoes         string `json:"undoes,omitempty"`
	UndoneBy       string `json:"undoneBy,omitempty"`
	RequestDigest  string `json:"requestDigest"`
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
	Epoch          string `json:"epoch"`
	CommittedAt    int64  `json:"committedAt"`
	// Outcome is "committed" or "noop". A refused operation is not recorded:
	// it wrote nothing, and its transaction took the record with it.
	Outcome       string `json:"outcome"`
	SnapshotHead  *int64 `json:"snapshotHead,omitempty"`
	ClientName    string `json:"clientName,omitempty"`
	ClientVersion string `json:"clientVersion,omitempty"`

	Paths []OperationPath `json:"paths"`
	// PathsTotal is how many paths the operation changed, which is more than
	// Paths holds when a listing capped them (AuditPathsMax).
	PathsTotal int   `json:"pathsTotal"`
	Pins       []Pin `json:"pins"`

	// ResultExpiresAt is when the recorded reply goes, and Result the reply
	// until it has. LookupOperation fills Result; a listing never does.
	ResultExpiresAt int64  `json:"resultExpiresAt"`
	Result          []byte `json:"-"`
}

// OperationPath is one path an operation changed.
type OperationPath struct {
	// Role is "write" for a path the operation wrote, and "source" for the
	// path a move retired.
	Role string `json:"role"`
	Path string `json:"path"`
	// BeforeUID is the path's head before, nil when it had none, and
	// AfterUID the version that changed it.
	BeforeUID *int64 `json:"beforeUid"`
	AfterUID  int64  `json:"afterUid"`
	// BeforeState is what the path held at BeforeUID: BeforeNone,
	// BeforeGone or BeforeLive, or "" where nothing can say (a row carried
	// over from schema 2 whose version was already gone; see op_entries).
	BeforeState string `json:"beforeState,omitempty"`
}

// What a path held before an operation changed it, as op_entries records it.
const (
	BeforeNone = "none"
	BeforeGone = "gone"
	BeforeLive = "live"
)

// Pin is a version an operation displaced and until when purge keeps it.
type Pin struct {
	UID       int64 `json:"uid"`
	ExpiresAt int64 `json:"expiresAt"`
}

// The audit's page bounds.
const (
	// AuditMax is the most operations one listing returns.
	AuditMax = 200
	// AuditPathsMax is the most paths a listing shows for one operation; a
	// restore can change thousands, and PathsTotal says how many there were.
	AuditPathsMax = 1000
)

// operationCols are an operation's columns, read from operations as o. The
// undo that undid it is the first undo in place naming it, which the commit
// makes the only one (ErrAlreadyUndone).
const operationCols = `o.seq, o.id, o.actor_id, o.actor_kind, o.actor_label, o.tool, o.undoes,
  (SELECT u.id FROM operations u WHERE u.undoes = o.id AND u.tool = '` + UndoTool + `' ORDER BY u.seq LIMIT 1),
  o.request_digest, o.idempotency_key, o.epoch, o.committed_at, o.outcome, o.snapshot_head, o.client_name,
  o.client_version, o.result_expires_at`

func scanOperation(r scannable) (OperationRecord, error) {
	var o OperationRecord
	var key, undoes, undoneBy sql.NullString
	var head sql.NullInt64
	err := r.Scan(&o.Seq, &o.ID, &o.ActorID, &o.ActorKind, &o.ActorLabel, &o.Tool, &undoes, &undoneBy,
		&o.RequestDigest, &key, &o.Epoch, &o.CommittedAt, &o.Outcome, &head, &o.ClientName, &o.ClientVersion,
		&o.ResultExpiresAt)
	o.IdempotencyKey = key.String
	o.Undoes, o.UndoneBy = undoes.String, undoneBy.String
	if head.Valid {
		v := head.Int64
		o.SnapshotHead = &v
	}
	return o, err
}

// operationDetail fills an operation's paths, capped at limit, and its pins.
func operationDetail(q querier, o *OperationRecord, limit int) error {
	if err := q.QueryRow(`SELECT COUNT(*) FROM op_entries WHERE op_id = ?`, o.ID).Scan(&o.PathsTotal); err != nil {
		return err
	}
	rows, err := q.Query(
		`SELECT role, path, before_uid, before_state, after_uid FROM op_entries WHERE op_id = ? ORDER BY ord LIMIT ?`,
		o.ID, limit)
	if err != nil {
		return err
	}
	o.Paths = []OperationPath{}
	for rows.Next() {
		var p OperationPath
		var before sql.NullInt64
		var state sql.NullString
		if err := rows.Scan(&p.Role, &p.Path, &before, &state, &p.AfterUID); err != nil {
			rows.Close()
			return err
		}
		p.BeforeState = state.String
		if before.Valid {
			v := before.Int64
			p.BeforeUID = &v
		}
		o.Paths = append(o.Paths, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = q.Query(`SELECT uid, expires_at FROM op_pins WHERE op_id = ? ORDER BY uid`, o.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	o.Pins = []Pin{}
	for rows.Next() {
		var p Pin
		if err := rows.Scan(&p.UID, &p.ExpiresAt); err != nil {
			return err
		}
		o.Pins = append(o.Pins, p)
	}
	return rows.Err()
}

// LookupOperation is one operation by its id, with every path it changed, its
// pins and, until it expires, its recorded reply: what resolves a reply that
// never arrived (PLAN.md section 4.8), and what an OpUnknown is resolved by.
// ok is false for an id this vault never committed.
//
// The epoch is on the record. One from before a restore still says what it
// did; its uids belong to that history.
func (s *Store) LookupOperation(vaultID, id string) (OperationRecord, bool, error) {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return OperationRecord{}, false, err
	}
	defer tx.Rollback()
	o, err := scanOperation(tx.QueryRow(`SELECT `+operationCols+` FROM operations o WHERE o.vault_id = ? AND o.id = ?`, vaultID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return OperationRecord{}, false, nil
	}
	if err != nil {
		return OperationRecord{}, false, err
	}
	if err := operationDetail(tx, &o, MaxOperationEntries*2); err != nil {
		return OperationRecord{}, false, err
	}
	if o.ResultExpiresAt > s.clock().UnixMilli() {
		if err := tx.QueryRow(`SELECT result FROM operations WHERE id = ?`, id).Scan(&o.Result); err != nil {
			return OperationRecord{}, false, err
		}
	}
	return o, true, nil
}

// Operations lists a vault's operations committed at or after since, in
// milliseconds, oldest first, starting after the one with sequence number
// after (zero for the first page), and whether there are more. At most limit,
// and never more than AuditMax. Revoked actors' operations are listed like any
// other: revoking ends what a token can do, not the record of what it did.
func (s *Store) Operations(vaultID string, since, after int64, limit int) ([]OperationRecord, bool, error) {
	if limit <= 0 || limit > AuditMax {
		limit = AuditMax
	}
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(
		`SELECT `+operationCols+` FROM operations o
		  WHERE o.vault_id = ? AND o.committed_at >= ? AND o.seq > ?
		  ORDER BY o.seq LIMIT ?`, vaultID, since, after, limit+1)
	if err != nil {
		return nil, false, err
	}
	out := []OperationRecord{}
	for rows.Next() {
		o, err := scanOperation(rows)
		if err != nil {
			rows.Close()
			return nil, false, err
		}
		out = append(out, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	for i := range out {
		if err := operationDetail(tx, &out[i], AuditPathsMax); err != nil {
			return nil, false, err
		}
	}
	return out, more, nil
}

/* ---------------------------------------------------------------- *
 * Verification
 * ---------------------------------------------------------------- */

// verifyOplog decodes the operation log, which a backup carries and a restore
// serves (PLAN.md section 4.5), and reports what cannot be what the store
// wrote: an operation with an impossible field, a path or pin or key naming an
// operation that is not there, and, the one that matters most, an unexpired
// pin whose version is gone. That is a before-image the store promised to keep
// and did not, so an undo or a person restoring from it would find nothing,
// and nothing else in the store would say so.
//
// Part of every verify, shallow included, because it reads only rows and a
// backup's own check of its snapshot is a shallow one. Returns the number of
// operations checked.
func (s *Store) verifyOplog() ([]Fault, int, error) {
	var faults []Fault
	fault := func(vault, id, reason, detail string) {
		faults = append(faults, Fault{VaultID: vault, Row: fmt.Sprintf("operation %q", id), Reason: reason, Detail: detail})
	}
	rows, err := s.db.Query(
		`SELECT o.vault_id, o.id, o.actor_id, o.actor_kind, o.actor_label, o.tool, o.undoes, o.request_digest,
		        o.idempotency_key, o.epoch, o.committed_at, o.outcome, o.result_expires_at,
		        (SELECT COUNT(*) FROM vaults v WHERE v.vault_id = o.vault_id),
		        COALESCE((SELECT u.vault_id FROM operations u WHERE u.id = o.undoes), '')
		   FROM operations o ORDER BY o.seq`)
	if err != nil {
		return nil, 0, err
	}
	checked := 0
	for rows.Next() {
		var vault, id, actor, kind, label, tool, digest, epoch, outcome, undoneVault string
		var key, undoes sql.NullString
		var committed, resultUntil int64
		var vaults int
		if err := rows.Scan(&vault, &id, &actor, &kind, &label, &tool, &undoes, &digest, &key, &epoch,
			&committed, &outcome, &resultUntil, &vaults, &undoneVault); err != nil {
			rows.Close()
			return faults, checked, err
		}
		checked++
		switch {
		case !ValidOperationID(id):
			fault(vault, id, "badop", fmt.Sprintf("the id is not %d bytes of base64url", OperationIDBytes))
		case !validActor(kind, actor):
			fault(vault, id, "badop", fmt.Sprintf("the actor %q of kind %q is not an MCP token, a device or the operator",
				actor, kind))
		case undoes.Valid != (tool == UndoTool || tool == UndoToCopyTool):
			fault(vault, id, "badop", fmt.Sprintf("recorded as %q, undoing %q: an undo, and only an undo, names "+
				"the operation it undoes", tool, undoes.String))
		case kind != AuthorKindMCP && !undoes.Valid:
			fault(vault, id, "badop", fmt.Sprintf("recorded as the %s's, which makes undos and nothing else", kind))
		case undoes.Valid && undoneVault != vault:
			fault(vault, id, "badop", fmt.Sprintf("undoes %q, which is not an operation on this vault", undoes.String))
		case label == "" || CheckName("actor", label, MaxMCPLabelLen) != nil:
			fault(vault, id, "badop", "the actor's label is empty or not a name")
		case tool == "" || CheckName("tool", tool, MaxToolNameLen) != nil:
			fault(vault, id, "badop", "the tool is empty or not a name")
		case !isHex64(digest):
			fault(vault, id, "badop", "the request digest is not a SHA-256")
		case key.Valid && (key.String == "" || checkKey(key.String) != nil):
			fault(vault, id, "badop", "the idempotency key is not one a request could carry")
		case epoch == "":
			fault(vault, id, "badop", "no epoch is recorded")
		case committed <= 0 || resultUntil <= 0:
			fault(vault, id, "badop", fmt.Sprintf("committed at %d with a reply kept until %d, which are not times",
				committed, resultUntil))
		case outcome != "committed" && outcome != "noop":
			fault(vault, id, "badop", fmt.Sprintf("the outcome %q is not one an operation has", outcome))
		case vaults == 0:
			fault(vault, id, "novault", "names a vault this database does not hold")
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return faults, checked, err
	}

	rows, err = s.db.Query(
		`SELECT p.op_id, COALESCE(o.vault_id, ''), o.id IS NULL, p.role, p.path, p.before_uid, p.before_state,
		        p.after_uid
		   FROM op_entries p LEFT JOIN operations o ON o.id = p.op_id
		  ORDER BY p.op_id, p.ord`)
	if err != nil {
		return faults, checked, err
	}
	for rows.Next() {
		var id, vault, role, path string
		var orphan bool
		var before sql.NullInt64
		var state sql.NullString
		var after int64
		if err := rows.Scan(&id, &vault, &orphan, &role, &path, &before, &state, &after); err != nil {
			rows.Close()
			return faults, checked, err
		}
		switch {
		case orphan:
			fault(vault, id, "badop", fmt.Sprintf("the path %q is recorded for an operation that is not there", path))
		case checkPath(path) != nil:
			fault(vault, id, "badop", fmt.Sprintf("the recorded path %q is one the policy refuses", path))
		case after <= 0 || (before.Valid && before.Int64 <= 0):
			fault(vault, id, "badop", fmt.Sprintf("the path %q is recorded as uid %v to %d", path, before.Int64, after))
		case state.Valid && (state.String == BeforeNone) == before.Valid:
			fault(vault, id, "badop", fmt.Sprintf("the path %q held %q before, at uid %v", path, state.String, before.Int64))
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return faults, checked, err
	}

	now := s.clock().UnixMilli()
	rows, err = s.db.Query(
		`SELECT p.op_id, p.vault_id, o.id IS NULL, p.uid, p.expires_at,
		        EXISTS (SELECT 1 FROM entries e WHERE e.vault_id = p.vault_id AND e.uid = p.uid)
		   FROM op_pins p LEFT JOIN operations o ON o.id = p.op_id
		  ORDER BY p.op_id, p.uid`)
	if err != nil {
		return faults, checked, err
	}
	for rows.Next() {
		var id, vault string
		var orphan, present bool
		var uid, expires int64
		if err := rows.Scan(&id, &vault, &orphan, &uid, &expires, &present); err != nil {
			rows.Close()
			return faults, checked, err
		}
		switch {
		case orphan:
			fault(vault, id, "badop", fmt.Sprintf("uid %d is pinned for an operation that is not there", uid))
		case uid <= 0 || expires <= 0:
			fault(vault, id, "badop", fmt.Sprintf("a pin of uid %d until %d is not a pin", uid, expires))
		case !present && expires > now:
			fault(vault, id, "lostpin", fmt.Sprintf(
				"uid %d is pinned until %s and is not in the store: the before-image this operation displaced "+
					"is gone. Restore it from a backup taken after the operation", uid,
				time.UnixMilli(expires).UTC().Format(time.RFC3339)))
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return faults, checked, err
	}

	rows, err = s.db.Query(
		`SELECT k.op_id, k.vault_id, o.id IS NULL, k.idempotency_key, k.expires_at
		   FROM op_keys k LEFT JOIN operations o ON o.id = k.op_id
		  ORDER BY k.op_id`)
	if err != nil {
		return faults, checked, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, vault, key string
		var orphan bool
		var expires int64
		if err := rows.Scan(&id, &vault, &orphan, &key, &expires); err != nil {
			return faults, checked, err
		}
		switch {
		case orphan:
			fault(vault, id, "badop", "an idempotency key names an operation that is not there")
		case key == "" || checkKey(key) != nil || expires <= 0:
			fault(vault, id, "badop", "an idempotency key is not one a request could carry")
		}
	}
	return faults, checked, rows.Err()
}

/* ---------------------------------------------------------------- *
 * Counts, for a backup's report
 * ---------------------------------------------------------------- */

// OplogCounts is how many operations, pins and idempotency keys a store holds,
// across its vaults.
type OplogCounts struct {
	Operations int64
	Pins       int64
	Keys       int64
}

func (s *Store) oplogCounts() (OplogCounts, error) {
	var c OplogCounts
	err := s.db.QueryRow(`SELECT (SELECT COUNT(*) FROM operations), (SELECT COUNT(*) FROM op_pins),
	                             (SELECT COUNT(*) FROM op_keys)`).Scan(&c.Operations, &c.Pins, &c.Keys)
	return c, err
}
