// Package server speaks the Trew protocol over a WebSocket.
//
// It owns session state and message dispatch. Durability lives in the store and
// the chunk layer below it; this package's whole contribution to "do not lose a
// note" is ordering: bodies before entries, entries before acks, and catch-up
// before live changes.
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

const (
	// ReadLimit bounds one incoming frame once a session has authenticated, and
	// HelloReadLimit bounds the first frame, which has to be a hello.
	//
	// The rule is that every legal message is receivable (S22): a frame the
	// protocol allows must never die at the read limit, because a client whose
	// batch is dropped with no code retries the identical batch for ever. The
	// arithmetic, with every constant it depends on named:
	//
	//   - the largest legal text frame is a putmany at wire.MaxBatchBytes,
	//     16 MiB, enforced on the encoded frame after it is read (S18). A batch
	//     of 256 entries naming 65536 chunks each would be about 1.1 GB and is
	//     not legal, because it is over that cap; the client splits it;
	//   - a single put is one path of store.MaxPathLen plus
	//     store.MaxChunksPerEntry names at 67 bytes each, about 4.4 MB;
	//   - a fetch is at most store.MaxChunksPerEntry names, the same 4.4 MB;
	//   - a chunk body is at most store.ChunkMax, 1 MiB.
	//
	// 32 MiB is twice the largest of those, so a frame between the advertised
	// cap and the read limit is read in full and refused with `toolarge`, and
	// only a frame at twice the cap, which no client that read `ready` sends,
	// meets the bare disconnect. This bounds each session's incoming frame.
	//
	// Before hello nothing has been authenticated, so the limit is 64 KiB: a
	// hello is a vault and a device name of 64 bytes each, a device id of at
	// most 64, a 43-character token, a 22-character invite and an epoch, a few
	// hundred bytes in all. An unauthenticated connection therefore cannot make
	// the server allocate more than that, and MaxPreAuth bounds how many of
	// them there can be (S19).
	ReadLimit      = 32 << 20
	HelloReadLimit = 64 << 10

	// MaxPreAuth caps connections that have not completed hello, across every
	// vault, and HelloTimeout is how long one may take to send it (S19). The
	// cap applies before authentication: a port scanner opening
	// sockets held a goroutine and a buffer each for ever. Past the cap a new
	// connection is refused with `busy`; past the deadline a silent one is told
	// `protostate` and closed. Both are generous for anything that is a device.
	MaxPreAuth   = 32
	HelloTimeout = 10 * time.Second

	// ShutdownRetryAfter tells a device when to retry a restarting server.
	ShutdownRetryAfter = 5 * time.Second

	// DefaultInviteTTL is how long an invite lives when the issuing device does
	// not say, and MaxInviteTTL the most a device may ask for (plan/protocol.md,
	// "The invite string"). One hour for both: long enough to walk to the
	// other device and pair it, and short enough that an invite left in a chat
	// or a log is dead soon after. An invite token is a bearer credential for
	// the whole vault, so a device is not allowed to mint a longer one; the
	// operator can, with `trew invite -ttl`, including one that never
	// expires, on the server, where the choice is deliberate.
	DefaultInviteTTL = time.Hour
	MaxInviteTTL     = time.Hour

	// WriteWait bounds one frame write, so a peer that stops reading is
	// detected rather than pinning a goroutine forever.
	WriteWait = 30 * time.Second

	// PingInterval is how often the server checks that a quiet connection is
	// still there, by sending a WebSocket ping and waiting for the pong.
	//
	// Liveness used to be "said something in the last five minutes", which
	// confuses a dead connection with a settled one. A vault that has finished
	// syncing has nothing to say, so its connection was closed every five
	// minutes for ever, each time reconnecting and replaying the handshake to
	// discover it was already up to date. Nothing was lost and nothing said why.
	//
	// A ping asks the question directly, and asks it of the connection rather
	// than of the client's manners: it works for a client that never sends an
	// application message, and it notices a connection that died silently, which
	// a laptop closing its lid does, within a minute rather than five.
	PingInterval = 45 * time.Second

	// PongWait is how long a ping may go unanswered before the connection is
	// treated as gone.
	PongWait = 15 * time.Second

	// SendQueueDepth is buffered frames per peer before it is dropped as too
	// slow. Sized for a burst of fan-out, not for a catch-up: catch-up runs on
	// the session's own goroutine and blocks rather than buffering.
	SendQueueDepth = 256

	// SendQueueBytes bounds what one peer may have waiting in memory.
	//
	// The depth above bounds frames, and a frame carrying a chunk body can be a
	// megabyte, so a peer that stopped reading held 256 of them: measured at
	// 272 MB of heap for one stalled reader, and 2.2 GB at the default peer
	// limit. Chunks average a few kilobytes, so this never bites on prose; a
	// vault of incompressible attachments produces chunks at the ceiling, which
	// is exactly the vault that would find it.
	//
	// Eight mebibytes mirrors the client's own bound on queued file bytes. A
	// frame larger than this is still sent, because refusing it would be a
	// deadlock rather than a limit.
	SendQueueBytes = 8 << 20

	// CatchupBufferMax bounds live changes held while a session drains its
	// backlog. A session that cannot finish catch-up before this many commits
	// land is dropped and recovers on reconnect, which costs it nothing: the
	// entries table plus the uid cursor is the durable queue.
	CatchupBufferMax = 4096

	// CatchupBufferBytes bounds the same buffer by size. The entry count alone
	// let a peer hold 4096 marshalled batches of any size, and a batch naming
	// tens of thousands of chunks is megabytes: the same hole SendQueueBytes
	// closes for the send queue, so it gets the same figure.
	CatchupBufferBytes = SendQueueBytes

	// BatchSize is entries per catch-up batch. Small enough that a client sees
	// progress and can assert continuity often, large enough that a big vault
	// is not thousands of frames.
	BatchSize = 200
)

// Server is the protocol handler. One per process; sessions are per connection.
type Server struct {
	st  *store.Store
	hub *Hub
	log *slog.Logger

	// servedVault is the one vault this server answers for, or empty when it
	// has not been told (which is every test that builds a server directly).
	//
	// Both hello routes enforce it before they look anything up by the name
	// the caller sent. Basalt enforced it on one route and not the other, so a
	// device registered to another vault in the same store connected to it
	// while this server was configured to serve one name and had logged every
	// other as "not served" (F19). Scope, not access: the caller still needs
	// that vault's own credentials.
	servedVault string

	// version is what `ready.serverVersion` says and what the startup line
	// logs: the stamped release, or "dev". It is sent only after a hello has
	// authenticated; a refusal before that names the protocol range and nothing
	// about the build, see handleHello.
	version string

	// maxPreAuth and helloTimeout are MaxPreAuth and HelloTimeout unless a test
	// lowers them. preAuth counts connections between accept and a completed
	// hello, guarded by sessMu.
	maxPreAuth   int
	helloTimeout time.Duration
	preAuth      int

	// maxBatchBytes and maxFetchBytes are the wire constants unless a test
	// lowers them. One field each for advertising and enforcing, for the same
	// reason as perFileMax.
	maxBatchBytes int64
	maxFetchBytes int64

	// perFileMax is advertised in `ready` and enforced on every put. One field
	// for both, because advertising a limit that is not enforced, or enforcing
	// one that is not advertised, is how a client ends up retrying a put that
	// can never succeed.
	perFileMax int64

	// now is injectable so tests do not have to sleep to reach a timeout.
	now func() time.Time

	// pingEvery and pongWait are the constants unless a test lowers them, which
	// is the only way to reach the keepalive without a test that sleeps for
	// minutes.
	pingEvery time.Duration
	pongWait  time.Duration

	// writeWait is WriteWait unless a test lowers it. It is what bounds the
	// detection of a peer that has gone while the server is sending to it,
	// which is a case the keepalive deliberately leaves alone (S1).
	writeWait time.Duration

	// batchSize is BatchSize unless a test lowers it. Lowering it is how the
	// catch-up path can be made to span many frames without seeding a vault
	// large enough to do it honestly.
	batchSize int

	// afterReplayBatch and afterReplay run at known points inside the handshake,
	// and are nil in every non-test build.
	//
	// They exist because the orders that matter most in this package are
	// "backlog first, live changes after" and "join the fan-out before reading
	// the backlog, not after", and both are about a window a few microseconds
	// wide. A test that tried to hit either by timing would be a test that
	// passes when the machine is busy.
	//
	// afterReplayBatch runs once per catch-up batch, so a test can interrupt the
	// middle of a replay. afterReplay runs after the last batch and before the
	// buffered live changes are released, which is the window in which an entry
	// is in neither the backlog nor the flush unless the session joined the
	// fan-out first.
	afterReplayBatch func(n int)
	afterReplay      func()

	// beforePublish runs inside a device's hello, after its token has been
	// checked and before the fields it establishes are published to the other
	// goroutines that read them, and is nil in every non-test build. A test
	// uses it to kill the connection at that moment, which -race then checks
	// is safe.
	beforePublish func()

	// beforeJoin runs inside a hello, after the device's token has been checked
	// and before the session joins the fan-out, and is nil in every non-test
	// build. It exists for the same reason as the two above: the window between
	// authenticating and joining is a few microseconds wide, and a revoke
	// landing in it must still end the session. A test that tried to hit it by
	// timing would be a test that passes when the machine is busy.
	beforeJoin func()

	// afterFlush runs once flushPending has released its lock, and is nil in
	// every non-test build. By then caught-up is already queued, so a broadcast
	// triggered here must land after it; a test uses that to prove caught-up is
	// enqueued under the lock rather than written afterwards.
	afterFlush func()

	// beforePing runs just before keepalive sends a ping, and is unset in every
	// non-test build. A test uses it to check what the queue held at that
	// moment, because the symptom of pinging behind queued data depends on how
	// much the kernel buffers, which differs by platform.
	//
	// Atomic because the test that sets it cannot set it before the session
	// exists: the hook closes over the peer, and the peer is the thing dialling
	// creates. So the write lands while a keepalive goroutine is already
	// reading the field, and `-race` caught it, intermittently, which is how a
	// test-only race reaches CI and stays.
	beforePing atomic.Pointer[func()]

	// beforeEvict runs at the top of each eviction a revoke causes, and is nil
	// in every non-test build. A test uses it to see that the evictions
	// overlap, which is the whole of what parallelising them buys and is not
	// otherwise observable: how long an eviction takes depends on whether the
	// peer is reading, which a test cannot arrange honestly.
	beforeEvict func()

	// afterRevoke runs once a revoke has committed and taken the device's
	// sessions out of the fan-out, while it still holds commitMu, and is nil in
	// every non-test build. A test uses it to commit from another device at
	// the one moment a revoked session could still have been sent something.
	afterRevoke func()

	// beforeAppend runs just before an entry is committed, and is nil in every
	// non-test build. An error from it stands in for the database failing the
	// commit, which no test can arrange honestly on a working disk, so that the
	// session's answer to that fault can be pinned (S27).
	beforeAppend func(e store.Entry) error
	// failBatch makes the batched commit report a failure without attempting
	// one, so the per-entry fallback can be exercised. Nil in every non-test
	// build, like beforeAppend above.
	failBatch error

	// afterAppend runs between assigning a uid and announcing it, and is nil in
	// every non-test build.
	//
	// It exists because the window commitMu closes cannot otherwise be observed:
	// AppendEntry ends in an fsync, so the goroutine that gets the lower uid has
	// only a log line and a channel send left to do while the next one still has
	// a whole durable commit ahead of it. The reorder is real and the lock is
	// what rules it out, but no amount of concurrency reliably produces it, and
	// an invariant that holds only because a disk is slow is not one to rely on.
	afterAppend func(uid int64)

	// abandonBodies runs when readBodies gives up on an exchange part way,
	// after the refusal has been queued and before the batch writer is closed,
	// and is nil in every non-test build.
	//
	// The refusal leaves first, so a client can read it while a body it sent
	// earlier in the exchange is still on its way to the disk. That window is
	// as wide as one body write and there is no telling from outside when it
	// has closed, so a test holds it open here to see that nothing treats the
	// session as over, Shutdown included, until the writer has been closed.
	abandonBodies func()

	// commitMu makes appending an entry and announcing it one step.
	//
	// Without it two devices can commit uid 5 and uid 6 and reach the hub in
	// the opposite order, because AppendEntry releases the store's write lock
	// before the fan-out runs. A peer would then receive [6,6] before [5,5] and
	// its continuity check would fire on a vault that is perfectly healthy,
	// which is worse than not checking: an assertion that cries wolf gets
	// switched off. Live batches leave here in uid order, so a gap a client
	// sees is always real.
	//
	// The cost is that commits to *any* vault serialise. That is already true
	// one layer down, where the store holds a single write mutex for the same
	// ordering reason, so this adds a fan-out of a few non-blocking channel
	// sends to a section that was serial anyway.
	// Credential retirement and registry mutations use this same lock, so a
	// session's credential check remains valid until its mutation commits, and
	// a revoke takes the device's sessions out of the fan-out before it lets
	// go, so no commit after it can reach them (PLAN.md section 2.3.1). Socket
	// replies and eviction are kept outside this section.
	commitMu sync.Mutex

	// sessions is every connection Handle is running, joined to a vault or not,
	// and closing is set once Shutdown has begun. http.Server.Shutdown stops
	// the listener and waits for ordinary requests, but a hijacked WebSocket is
	// not its connection any more, so without this list a shutdown returned
	// while every session was still open and the store was closed under them.
	sessMu   sync.Mutex
	sessions map[*Session]struct{}
	// Closed when the current group of admitted sessions has finished.
	sessionsDone chan struct{}
	closing      bool
}

// errShuttingDown is the reason a peer is given when the server is stopping.
// Reported as busy, which the client already treats as "not now, reconnect",
// because that is exactly what it means.
var errShuttingDown = errors.New("this server is shutting down, reconnect in a moment")

// errTooManyPreAuth is the reason a connection is refused when too many others
// have connected and not yet said hello (S19).
var errTooManyPreAuth = errors.New("too many connections are waiting to authenticate, try again in a moment")

// admit registers a session, unless the server is shutting down or too many
// sessions are still waiting to say hello. The reason is returned so the
// refusal can say which.
func (s *Server) admit(sess *Session) error {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if s.closing {
		return errShuttingDown
	}
	if s.preAuth >= s.maxPreAuth {
		return errTooManyPreAuth
	}
	if s.sessions == nil {
		s.sessions = make(map[*Session]struct{})
	}
	if len(s.sessions) == 0 {
		s.sessionsDone = make(chan struct{})
	}
	s.sessions[sess] = struct{}{}
	sess.counted = true
	s.preAuth++
	return nil
}

// authenticated moves a session out of the pre-auth count. Called once, when
// its hello has been accepted; a session that never gets there is released by
// forget.
func (s *Server) authenticated(sess *Session) {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if !sess.counted {
		return
	}
	sess.counted = false
	s.preAuth--
}

func (s *Server) forget(sess *Session) {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if _, ok := s.sessions[sess]; !ok {
		return
	}
	delete(s.sessions, sess)
	if len(s.sessions) == 0 {
		close(s.sessionsDone)
	}
	if sess.counted {
		sess.counted = false
		s.preAuth--
	}
}

func (s *Server) Health(ctx context.Context) store.Health {
	s.sessMu.Lock()
	closing := s.closing
	s.sessMu.Unlock()
	if closing {
		return store.Health{CanPersist: false, Why: store.HealthClosing}
	}
	return s.st.CheckHealth(ctx)
}

// Sessions is how many connections are being handled, joined or not.
// Health is what /health answers with (I17).
//
// Shutting down is reported as unable to persist, deliberately. A server
// draining its sessions will refuse new work in a moment, and a checker that
// keeps calling it healthy is one that keeps sending devices to it: the whole
// use of a health check during a restart is to stop that.
func (s *Server) Sessions() int {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	return len(s.sessions)
}

// Shutdown stops admitting connections, tells every session to finish, and
// waits for them to go, bounded by ctx (S16).
//
// A session between requests is closed with a reason at once. One inside a
// request is left to finish it: a put that has stored its bodies gets its
// commit and its ack, because an ack means stored and a shutdown must not
// turn one into a lie in either direction. Whatever is still running when ctx
// expires is killed, which a client experiences as a dropped connection with
// nothing acknowledged, and retries. Call this before closing the store; a
// session that outlives the store would fail its commit and could not say why.
//
// It returns only once no session is left, deadline or no deadline. The error
// says how many were cut off; it does not mean any of them is still running.
func (s *Server) Shutdown(ctx context.Context) error {
	s.sessMu.Lock()
	s.closing = true
	peers := make([]*Session, 0, len(s.sessions))
	for sess := range s.sessions {
		peers = append(peers, sess)
	}
	done := s.sessionsDone
	s.sessMu.Unlock()
	if len(peers) == 0 {
		return nil
	}

	// In parallel, because each idle peer is given a moment to read its reason
	// and eight of them in series would spend the whole budget on the first.
	var wg sync.WaitGroup
	for _, sess := range peers {
		wg.Add(1)
		go func(sess *Session) {
			defer wg.Done()
			sess.shutdown()
		}(sess)
	}
	wg.Wait()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		// Out of time. What is left is mid-request; it is cut off, unacked, and
		// the client retries. The count is taken here, under the lock and at
		// the moment of the kill, so what is reported is what was actually
		// still running rather than a number from before the wait.
		s.sessMu.Lock()
		left := make([]*Session, 0, len(s.sessions))
		for sess := range s.sessions {
			left = append(left, sess)
		}
		s.sessMu.Unlock()
		if len(left) == 0 {
			return nil
		}
		for _, sess := range left {
			sess.kill(errors.New("shutdown deadline reached with a request in flight"))
		}
		// Then wait for every one of them to unwind, with no second deadline.
		// The kill has already closed the socket, so what remains is a request
		// finishing, usually a commit, and this is the one thing the caller
		// cannot be allowed to race: main closes the store as soon as this
		// returns, and a commit that meets a closed store fails with `internal`
		// on a put the client was told nothing about. Returning after a second
		// whether or not the sessions had gone is what made that possible.
		//
		// A session that never unwinds hangs the stop, which systemd ends with
		// SIGKILL; that leaves the database to recover from its journal, which
		// it is built to do, and is the safer of the two failures.
		<-done
		return fmt.Errorf("shutdown: %d sessions cut off mid-request", len(left))
	}
}

// New is a server for the store, logging to log (the default logger when nil).
func New(st *store.Store, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{
		st: st, hub: NewHub(), log: log,
		perFileMax: store.DefaultPerFileMax,
		version:    "dev",
		pingEvery:  PingInterval, pongWait: PongWait, writeWait: WriteWait,
		maxPreAuth: MaxPreAuth, helloTimeout: HelloTimeout,
		maxBatchBytes: wire.MaxBatchBytes, maxFetchBytes: wire.MaxFetchBytes,
		now: time.Now, batchSize: BatchSize,
	}
}

// Serves names the one vault this server answers for, so every hello route
// enforces it. Empty means unrestricted, which is what a test that builds a
// server directly gets.
func (s *Server) Serves(vaultID string) { s.servedVault = vaultID }

// refuseUnservedVault is the check every hello route makes before it looks a
// vault up by the name the caller sent.
func (s *Server) refuseUnservedVault(vaultID string) error {
	if s.servedVault == "" || vaultID == s.servedVault {
		return nil
	}
	return fmt.Errorf("this server serves %q, not %q", s.servedVault, vaultID)
}

// SetVersion names the release this server is, for `ready` and the log. Empty
// is left as "dev" rather than advertised as nothing.
func (s *Server) SetVersion(v string) {
	if v != "" {
		s.version = v
	}
}

// Version is what this server calls itself.
func (s *Server) Version() string { return s.version }

// clamp holds a limit inside the range the code below it can actually serve.
//
// Zero or negative means the flag was not set, and an unset flag is the shipped
// default rather than the floor: silently serving the smallest legal value
// because nobody asked for one would be a limit nobody chose. Everything else
// is pulled to the nearest end of the range, and the caller advertises what
// came back, because advertised has to equal enforced.
func clamp(n, lo, hi, def int64) int64 {
	if n <= 0 {
		n = def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// SetPerFileMax changes the largest file this server accepts and advertises.
func (s *Server) SetPerFileMax(max int64) {
	s.perFileMax = ClampPerFileMax(max)
}

// ClampPerFileMax is what a -max-file value actually becomes.
//
// Clamped to what the store can hold, because a limit above that would be
// advertised, attempted, and then refused by Validate: the client would have
// read and chunked the file to find out. There is no floor beyond one byte: a
// ceiling set low only refuses files, and refusing is the safe direction.
//
// Exported because `trew service` writes the flag into a unit and has to
// check it against the vault first, and two copies of this arithmetic would be
// two answers to "what will this unit actually run with".
func ClampPerFileMax(max int64) int64 {
	return clamp(max, 1, store.PerFileMax, store.DefaultPerFileMax)
}

// PerFileMax is what this server advertises and enforces.
func (s *Server) PerFileMax() int64 { return s.perFileMax }

// SetMaxBatchBytes changes the batch cap this server advertises and enforces
// (I25). Clamped to what makes sense: no lower than one chunk, or no batch
// could carry a body, and no higher than half the read limit, which is the
// default, so that a frame over the cap is still read in full and refused with
// a code rather than dying at the socket (S22). The flag exists to lower the
// cap, for a client test against the real binary; it cannot raise it.
func (s *Server) SetMaxBatchBytes(n int64) {
	s.maxBatchBytes = clamp(n, store.ChunkMax, ReadLimit/2, wire.MaxBatchBytes)
}

// MaxBatchBytes is what this server advertises and enforces.
func (s *Server) MaxBatchBytes() int64 { return s.maxBatchBytes }

// SetMaxFetchBytes changes the fetch cap this server advertises and enforces
// (I25). Bodies go out, not in, so the read limit does not bound them; the
// clamp is one chunk at the bottom and the largest file the store can hold at
// the top, so one fetch can always carry one file and never has to.
func (s *Server) SetMaxFetchBytes(n int64) {
	s.maxFetchBytes = clamp(n, store.ChunkMax, store.PerFileMax, wire.MaxFetchBytes)
}

// MaxFetchBytes is what this server advertises and enforces.
func (s *Server) MaxFetchBytes() int64 { return s.maxFetchBytes }

// Store is the persistence this server is serving. Exposed for the command line
// tools that verify and purge, which must go through the same code the sessions
// do rather than opening the database a second time.
func (s *Server) Store() *store.Store { return s.st }

// ready is the handshake reply, built from the same constants the store and
// the session enforce. Advertising a limit that is not enforced, or enforcing
// one that is not advertised, is how a client ends up retrying a put that can
// never succeed.
//
// The epoch is the store's, so a client can tell a history it has followed
// from one that has been restored under it. The protocol range is sent whole
// even though it is one version wide, because that is what a client names when
// the next bump refuses it; see wire.Proto.
func (s *Server) ready(id, cursor int64) wire.Ready {
	return wire.Ready{
		Res:           "ready",
		ID:            id,
		Proto:         wire.Proto,
		MinProto:      wire.MinProto,
		ServerVersion: s.version,
		Epoch:         s.st.Epoch(),
		Cursor:        cursor,
		PerFileMax:    s.perFileMax,
		ChunkMax:      s.st.Chunks().Max(),
		MaxChunks:     store.MaxChunksPerEntry,
		MaxBatchBytes: s.maxBatchBytes,
		MaxFetchBytes: s.maxFetchBytes,
	}
}

// Revocation is what a revoke did, for the reply and the log.
type Revocation struct {
	// Closed is how many of the device's sessions were ended.
	Closed int
	// InvitesCancelled is how many invites the device had issued that could
	// still have been redeemed; see store.RevokeDevice.
	InvitesCancelled int
}

// revoke deletes a device's row, cancels the invites it issued, and ends
// everything that device has open.
//
// A revoke means three things (PLAN.md section 2.3.1): no later mutation from
// the device commits, no mutation it has in flight completes, and no live
// session of it is sent anything more. The first two are the row being gone,
// checked under commitMu by every mutation (see currentCredential). The third
// is here: the device's sessions leave the fan-out inside the same critical
// section as the delete, so there is no moment after the revoke commits and
// before its sessions close at which a commit from another device can be
// broadcast to them. They are marked revoked too, so a frame already queued,
// a catch-up still being written or a reply to a request they sent a moment
// ago is dropped at the socket, and the only thing such a connection hears
// after the revoke is the notice that it was revoked.
//
// origin is the session asking, or nil when the operator asks through the
// control socket. A session revoking its own device keeps its connection just
// long enough to hear the reply, and leaves the fan-out with the rest.
//
// The notices are sent and the sockets closed after the lock is released, in
// parallel, because each peer is given a moment to read its notice and eight
// of them in series would spend a second each.
func (s *Server) revoke(vaultID, deviceID string, origin *Session) (Revocation, error) {
	s.commitMu.Lock()
	if origin != nil {
		if err := origin.currentCredential(); err != nil {
			s.commitMu.Unlock()
			return Revocation{}, err
		}
	}
	cancelled, err := s.st.RevokeDevice(vaultID, deviceID, s.now().UnixMilli())
	if err != nil {
		s.commitMu.Unlock()
		return Revocation{}, err
	}
	victims := s.hub.detach(vaultID, deviceID, origin)
	for _, peer := range victims {
		peer.revoked.Store(true)
	}
	if origin != nil && origin.deviceID == deviceID {
		s.hub.leave(vaultID, origin)
	}
	if s.afterRevoke != nil {
		s.afterRevoke()
	}
	s.commitMu.Unlock()

	var wg sync.WaitGroup
	for _, peer := range victims {
		wg.Add(1)
		go func(peer *Session) {
			defer wg.Done()
			peer.evict("this device was revoked and may no longer sync this vault; "+
				"pair it again with a new invite", errors.New("device revoked"))
		}(peer)
	}
	wg.Wait()
	return Revocation{Closed: len(victims), InvitesCancelled: cancelled}, nil
}
