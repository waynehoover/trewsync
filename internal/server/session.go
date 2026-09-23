package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/frame"
	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// Session is one connected device.
type Session struct {
	srv  *Server
	conn *websocket.Conn
	ctx  context.Context

	// All writes funnel through one goroutine draining out, which keeps frame
	// order without a mutex and stops a stalled peer from blocking whoever is
	// broadcasting to it.
	out chan outFrame
	// queued is the bytes and inflight the frames that have been enqueued and
	// not yet written, counted on every path into out (S8: trySend used to skip
	// the count, so the writer's decrements drove it negative and the byte bound
	// switched itself off). Both are reserved before the frame goes on the
	// channel and released after the write returns, so a zero means every frame
	// has reached the socket. drained wakes a waiter when the writer has taken
	// some away.
	queued    atomic.Int64
	inflight  atomic.Int64
	drained   chan struct{}
	dead      chan struct{}
	closeOnce sync.Once

	// reading is true only while the session goroutine is parked in conn.Read.
	// coder/websocket processes an incoming pong only inside a Reader call, and
	// this goroutine is the only reader, so a ping sent while it is busy sending
	// a fetch would go unanswered however alive the client is. keepalive uses it
	// twice: it pings only when this is set, and it treats a ping that went
	// unanswered while this was clear as no verdict. See keepalive.
	reading atomic.Bool

	vaultID string
	device  string
	remote  string
	joined  bool

	// deviceID is the row in the vault's device list this session
	// authenticated as. It is written before the session joins the fan-out
	// and read afterwards by whoever is revoking that device, so the hub's
	// lock is what publishes it; see Hub.detach.
	deviceID string
	// Captured at hello, so reusing a revoked ID with a new key cannot grant
	// its old session permission to mutate the vault.
	deviceHash string
	// Zero is unknown; otherwise the last applied cursor plus one.
	applied atomic.Int64

	// revoked is set by the revoke that deleted this session's device row,
	// under commitMu and in the same critical section that takes the session
	// out of the fan-out. From then on the writer sends nothing but the notice
	// saying so (see writeLoop), which is what makes "no live session of a
	// revoked device is sent anything more" true of frames that were already
	// queued, and of replies to requests already being served, and not only of
	// commits that come later (PLAN.md section 2.3.1).
	revoked atomic.Bool

	// reqID is the id of the request being served, echoed on its reply and on
	// any error refusing it, and zero between requests so that an error sent
	// then, the shutdown notice, is recognisably unsolicited. Only the session
	// goroutine touches it.
	reqID int64

	// saidSkewed is set once this session has reported a device writing
	// timestamps its own clock says are impossible. Once, because a first sync
	// commits thousands of entries and a per-entry warning is a log nobody
	// reads. Only the session goroutine touches it; see noteFutureMTime.
	saidSkewed bool

	// counted is true while this session is in the server's pre-auth count,
	// guarded by Server.sessMu (S19).
	counted bool

	// Guards the catch-up handover. Live changes buffer in pending until the
	// backlog is on the wire; see handleHello for why the order matters.
	// pendingBytes is their marshalled size, because 4096 entries naming 65536
	// chunks each is a quarter of a gigabyte, not a buffer.
	mu           sync.Mutex
	catchupDone  bool
	pending      []pendingChange
	pendingBytes int64

	// Shutdown state, guarded by stateMu. busy is set while the session is
	// inside a request, which is when a shutdown must wait for it: the store
	// may be about to commit and the client is owed the ack. closing is set by
	// Server.Shutdown and read by run between requests, so a session that was
	// busy ends itself, with a reason, as soon as its request completes.
	stateMu sync.Mutex
	busy    bool
	closing bool
}

type outFrame struct {
	typ  websocket.MessageType
	data []byte
	// final marks the one frame a revoked session is still sent: the notice
	// that it was revoked. See writeLoop.
	final bool
}

// pendingChange is a live batch held back during catch-up, already marshalled.
// Marshalling at delivery rather than at flush is what lets the buffer be
// bounded by the bytes it actually holds.
type pendingChange struct {
	uid   int64
	frame []byte
}

// Handle runs one connection to completion. The caller has already accepted the
// WebSocket.
func (s *Server) Handle(ctx context.Context, conn *websocket.Conn, remote string) {
	// Small until hello has been accepted, then raised to what an authenticated
	// peer may send; see ReadLimit.
	conn.SetReadLimit(HelloReadLimit)
	sess := &Session{
		srv: s, conn: conn, ctx: ctx, remote: remote,
		out:     make(chan outFrame, SendQueueDepth),
		drained: make(chan struct{}, 1),
		dead:    make(chan struct{}),
	}
	go sess.writeLoop()

	// Admission is the first thing a shutdown stops, and the pre-auth cap is
	// applied here too. A connection accepted between the listener closing and
	// the sessions being told, or one arriving while too many others have not
	// yet said hello, is refused with a reason rather than admitted. The
	// refusal carries no id, because it answers no request; a client reads an
	// error before `ready` as the reason the connection is closing, and `busy`
	// is the code.
	if err := s.admit(sess); err != nil {
		s.log.Info("session refused", "remote", remote, "why", err)
		_ = sess.fatalWith(wire.CodeBusy, err, ShutdownRetryAfter)
		sess.drain(2 * time.Second)
		sess.kill(nil)
		return
	}
	defer s.forget(sess)
	go sess.keepalive()

	err := sess.run()
	if err != nil {
		s.log.Info("session ended", "remote", remote, "vault", sess.vaultID, "err", err)
	}
	// run may have queued an explanatory error frame. Closing immediately drops
	// it, and the client then sees a bare disconnect instead of a reason, which
	// is the difference between a bug someone can fix and one they cannot.
	sess.drain(2 * time.Second)
	sess.kill(nil)
	if sess.joined {
		s.hub.leave(sess.vaultID, sess)
	}
}

func (s *Session) writeLoop() {
	for {
		select {
		case <-s.dead:
			return
		case f := <-s.out:
			// A revoked device's connection hears one thing after the revoke:
			// that it was revoked. Anything else still queued, a live batch, a
			// catch-up page, the reply to a request sent a moment before, is
			// dropped here, the last point before the socket, because the
			// revoke has already been answered as done (PLAN.md section 2.3.1).
			// It is still counted out below, so a drain waiting on it is not
			// left waiting.
			var err error
			if f.final || !s.revoked.Load() {
				ctx, cancel := context.WithTimeout(s.ctx, s.srv.writeWait)
				err = s.conn.Write(ctx, f.typ, f.data)
				cancel()
			}
			// Released only now, after the write returned, so a zero on either
			// counter means the frame has reached the socket rather than merely
			// left the channel. drain relies on that (S10).
			s.queued.Add(-int64(len(f.data)))
			s.inflight.Add(-1)
			// Non-blocking, and one pending wake is enough: a waiter rechecks
			// the counter rather than trusting the signal.
			select {
			case s.drained <- struct{}{}:
			default:
			}
			if err != nil {
				s.kill(err)
				return
			}
		}
	}
}

// kill closes the session once. CloseNow unblocks the read loop so the session
// goroutine notices and unwinds.
func (s *Session) kill(cause error) {
	s.closeOnce.Do(func() {
		if cause != nil {
			s.srv.log.Info("closing session", "remote", s.remote, "vault", s.publishedVaultID(), "cause", cause)
		}
		close(s.dead)
		_ = s.conn.CloseNow()
	})
}

// publishedVaultID is safe for the writer, timeout and keepalive goroutines.
// During hello the session may still be initializing vaultID; authenticated
// publishes it by releasing the pre-auth count under this mutex.
func (s *Session) publishedVaultID() string {
	s.srv.sessMu.Lock()
	defer s.srv.sessMu.Unlock()
	if s.counted {
		return ""
	}
	return s.vaultID
}

// drain waits, bounded, for every queued frame to finish being written, so a
// final error message is not lost to an immediate close.
//
// It waits on inflight, not on the channel being empty. The writer takes a
// frame off the channel and then spends up to WriteWait writing it, and a drain
// that returned once the channel was empty let Handle close the socket in the
// middle of the very frame it was trying to preserve (S10).
func (s *Session) drain(timeout time.Duration) {
	deadline := time.After(timeout)
	for s.inflight.Load() > 0 {
		select {
		case <-s.drained:
		case <-s.dead:
			return
		case <-deadline:
			return
		}
	}
}

// enqueue puts a frame on the queue if there is room for it, and says whether
// it did. It never blocks and never closes anything; the caller decides what
// "no room" means, which is different for a catch-up, a fan-out and a flush.
//
// Room is bytes as well as frames. handleFetch reads a body and sends it, over
// and over, as fast as the queue accepts them, and bounded only by frame count
// that let one peer hold a quarter of a gigabyte of chunk bodies in memory. A
// frame bigger than the whole budget is still accepted when nothing is queued
// ahead of it, or a single large chunk would wait for room that can never
// appear.
//
// The bytes are reserved before the frame is offered and given back if it is
// refused, so the counter is never below what the writer will subtract.
func (s *Session) enqueue(typ websocket.MessageType, data []byte) bool {
	return s.enqueueFrame(outFrame{typ: typ, data: data})
}

// enqueueFrame is enqueue for a frame already built, which is how the one
// frame marked final reaches the queue.
func (s *Session) enqueueFrame(f outFrame) bool {
	n := int64(len(f.data))
	if after := s.queued.Add(n); after > SendQueueBytes && after != n {
		s.queued.Add(-n)
		return false
	}
	s.inflight.Add(1)
	select {
	case s.out <- f:
		return true
	default:
		s.queued.Add(-n)
		s.inflight.Add(-1)
		return false
	}
}

// send blocks until the frame is queued.
//
// Only ever called from the session's own goroutine, where blocking is correct
// backpressure: a catch-up can be far larger than the queue, and dropping
// frames there would leave the client with gaps it has been told to expect.
// Waiting here is safe because the peer that is not reading is the one that
// waits.
func (s *Session) send(typ websocket.MessageType, data []byte) error {
	for !s.enqueue(typ, data) {
		select {
		case <-s.drained:
		case <-s.dead:
			return errors.New("session closed")
		case <-s.ctx.Done():
			return s.ctx.Err()
		}
	}
	return nil
}

// trySend never blocks. Used for fan-out from *other* sessions' goroutines,
// where waiting on a stalled peer would stall the pusher.
//
// Overflow drops the peer rather than the frame. Safe, because delivery here is
// not the durable channel: the entries table plus the uid cursor is, so a
// dropped peer receives everything it missed as catch-up on reconnect. Dropping
// the frame instead would leave a live peer permanently short one file.
func (s *Session) trySend(typ websocket.MessageType, data []byte) bool {
	return s.trySendFrame(outFrame{typ: typ, data: data})
}

// trySendFrame is trySend for a frame already built.
func (s *Session) trySendFrame(f outFrame) bool {
	select {
	case <-s.dead:
		return false
	default:
	}
	if !s.enqueueFrame(f) {
		s.kill(errors.New("send queue overflow, peer too slow"))
		return false
	}
	return true
}

func (s *Session) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.send(websocket.MessageText, b)
}

func (s *Session) writeBinary(b []byte) error {
	return s.send(websocket.MessageBinary, b)
}

// errFrame builds an error for this session: the id of the request being
// refused, or none for an unsolicited error, and the retryable verdict, which
// wire.Error fills in from the code. retryAfter is sent only when positive,
// which in practice means `busy`.
//
// Every error leaves here in one shape, including the ones sent before hello,
// so there is no moment in a connection's life when a client has to work out
// which fields an error will have.
func (s *Session) errFrame(id int64, code, msg string, retryAfter time.Duration) wire.Err {
	e := wire.Error(code, msg)
	e.ID = id
	if ms := retryAfter.Milliseconds(); ms > 0 {
		e.RetryAfterMs = ms
	}
	return e
}

// reject reports a refusal the session survives. docs/protocol.md: a rejected
// put returns an error and the session continues, because a protocol with no
// clean way to refuse a push has to close the connection to say no, and then
// every bad file costs a reconnect.
func (s *Session) reject(code string, cause error) error {
	s.srv.log.Warn("rejected", "vault", s.vaultID, "code", code, "err", cause)
	return s.writeJSON(s.errFrame(s.reqID, code, cause.Error(), 0))
}

// refuse writes an error frame the caller already built, shaped for the
// session. The session continues, exactly as it does after reject.
func (s *Session) refuse(e *wire.Err) error {
	return s.writeJSON(s.errFrame(s.reqID, e.Code, e.Msg, 0))
}

// fatal reports a refusal that ends the session, writing the reason first. The
// id is the request's when one is being served, so a client can tell "your put
// was refused and the connection is closing" from "the connection is closing".
func (s *Session) fatal(code string, cause error) error {
	return s.fatalWith(code, cause, 0)
}

// fatalWith is fatal with a retryAfter hint, for the two `busy` refusals.
func (s *Session) fatalWith(code string, cause error, retryAfter time.Duration) error {
	_ = s.writeJSON(s.errFrame(s.reqID, code, cause.Error(), retryAfter))
	return cause
}

// takeID records the request id a message carries, or refuses one that has
// none or one out of range. Pings carry none, because they are answered by
// position and nothing else ever is.
//
// A missing id ends the session rather than refusing the one request: the
// client could not match the refusal to anything, and would read an error with
// no id as the connection closing anyway.
func (s *Session) takeID(m wire.In) error {
	s.reqID = 0
	if m.Op == "ping" {
		return nil
	}
	if m.ID < 1 || m.ID > wire.MaxRequestID {
		return s.fatal(wire.CodeProtoState, fmt.Errorf(
			"%s request carries id %d; every request carries an id from 1 to %d", m.Op, m.ID, wire.MaxRequestID))
	}
	s.reqID = m.ID
	return nil
}

// readMsg waits for the next frame, for as long as the connection lives.
//
// No deadline of its own. A read that timed out could not tell a connection that
// had died from one whose vault was simply settled, and closed both. What bounds
// this now is keepalive: a connection that stops answering pings is closed, and
// closing it is what ends this read.
//
// A client that answers pings and sends nothing else holds a session open. That
// is a slow-loris in a system built for one person's own devices behind a
// tunnel. Per-session queues and frame sizes are bounded.
func (s *Session) readMsg() (websocket.MessageType, []byte, error) {
	// A pong is processed only inside this Read, so keepalive may ping only
	// while it is running. The flag is cleared on the way out because the
	// goroutine's next move may be a long send, during which a ping would never
	// be seen.
	s.reading.Store(true)
	defer s.reading.Store(false)
	return s.conn.Read(s.ctx)
}

// keepalive asks a quiet connection whether it is still there.
//
// Runs for the life of the session. A ping that is not answered inside PongWait
// means the far end is gone however healthy the socket looks, which is what a
// laptop closing its lid produces: a connection that will never answer and never
// error either.
func (s *Session) keepalive() {
	ticker := time.NewTicker(s.srv.pingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.dead:
			return
		case <-ticker.C:
			// Only when the session is parked in a read with nothing queued
			// behind it (S1). A ping sent while the session is mid-send would be
			// answered by the client and never processed here, because only a
			// Read processes a pong. A ping sent with frames still queued goes
			// out behind them and reaches the client only once it has read
			// everything ahead of it, which on a slow link is longer than
			// PongWait however alive the client is. In both cases a peer that
			// has really gone is caught by the write timing out instead, so
			// skipping the tick costs nothing.
			if !s.reading.Load() || s.inflight.Load() > 0 {
				continue
			}
			if hook := s.srv.beforePing.Load(); hook != nil {
				(*hook)()
			}
			ctx, cancel := context.WithTimeout(s.ctx, s.srv.pongWait)
			err := s.conn.Ping(ctx)
			cancel()
			if err == nil {
				continue
			}
			if !s.reading.Load() {
				// The session left its read while the ping was in flight: a
				// request arrived just behind the ping and is being served,
				// and the pong is sitting unprocessed behind it. That is not a
				// verdict on the connection. The next tick asks again once the
				// session is back in a read.
				continue
			}
			// Closing the connection ends the read this session is parked on,
			// which ends the session. Logged at debug: a device going away is
			// ordinary.
			s.srv.log.Debug("connection stopped answering",
				"remote", s.remote, "vault", s.publishedVaultID(), "err", err)
			s.kill(nil)
			return
		}
	}
}

/* ---------------------------------------------------------------- *
 * Shutdown
 * ---------------------------------------------------------------- */

// enter marks the session busy with a request, or reports that the server is
// shutting down and the request must not start. Called between reading a
// message and acting on it, so a shutdown that arrives while a request is in
// flight waits for it, and one that arrives before it starts refuses it.
func (s *Session) enter() bool {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.closing {
		return false
	}
	s.busy = true
	return true
}

// leave marks the request finished and reports whether a shutdown is waiting.
func (s *Session) leave() (closing bool) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	s.busy = false
	return s.closing
}

// shutdown tells the session the server is stopping.
//
// An idle session is told why and closed here. A busy one is left to finish
// the request it is in: the store may be mid-commit and the client is owed an
// ack that means what it says, so the session ends itself, with the same
// reason, once run sees the flag. Server.Shutdown bounds how long that may
// take and kills whatever is left at the deadline.
//
// The read cannot simply be cancelled to interrupt an idle session: cancelling
// the context of a coder/websocket Read closes the connection, which is the
// bare disconnect a reason frame exists to avoid.
func (s *Session) shutdown() {
	s.stateMu.Lock()
	s.closing = true
	idle := !s.busy
	s.stateMu.Unlock()
	if !idle {
		return
	}
	// A refusal frame from a goroutine other than the session's, with no id
	// because no request asked for it. trySend rather than send, because this
	// must not wait on a peer that has stopped reading, and a peer whose queue
	// is full at shutdown is dropped as one.
	if b, err := json.Marshal(s.errFrame(0, wire.CodeBusy, errShuttingDown.Error(), ShutdownRetryAfter)); err == nil {
		s.trySend(websocket.MessageText, b)
	}
	s.drain(time.Second)
	s.kill(nil)
}

// evict closes this session from another goroutine because the device it
// authenticated as was revoked.
//
// The notice is unsolicited `auth`, the code a client already stops on, with a
// message that says what happened and what to do. It is marked final, so it is
// the one frame the writer still sends to a session the revoke has marked;
// everything queued ahead of it is dropped (see writeLoop).
func (s *Session) evict(msg string, cause error) {
	if s.srv.beforeEvict != nil {
		s.srv.beforeEvict()
	}
	if b, err := json.Marshal(s.errFrame(0, wire.CodeAuth, msg, 0)); err == nil {
		s.trySendFrame(outFrame{typ: websocket.MessageText, data: b, final: true})
	}
	s.drain(time.Second)
	s.kill(cause)
}

/* ---------------------------------------------------------------- *
 * Lifecycle
 * ---------------------------------------------------------------- */

func (s *Session) run() error {
	// A connection has HelloTimeout to say hello (S19). The timer, not a read
	// deadline: cancelling a coder/websocket Read closes the connection with
	// nothing said, and a reason frame is the difference between a client
	// that can be fixed and one that cannot. Stopped as soon as a frame has
	// arrived, so a slow authentication is never mistaken for a silent peer.
	deadline := time.AfterFunc(s.srv.helloTimeout, func() {
		if b, err := json.Marshal(s.errFrame(0, wire.CodeProtoState,
			fmt.Sprintf("no hello within %s of connecting", s.srv.helloTimeout), 0)); err == nil {
			s.trySend(websocket.MessageText, b)
		}
		s.drain(time.Second)
		s.kill(errors.New("no hello before the deadline"))
	})
	typ, data, err := s.readMsg()
	deadline.Stop()
	if err != nil {
		return err
	}
	if typ != websocket.MessageText {
		return s.fatal(wire.CodeProtoState,
			fmt.Errorf("first frame must be text hello, got %v", typ))
	}
	if err := wire.ValidText(data); err != nil {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("hello: %w", err))
	}
	var m wire.In
	if err := json.Unmarshal(data, &m); err != nil {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("hello parse: %w", err))
	}
	if m.Op != "hello" {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("first op must be hello, got %q", m.Op))
	}
	if !s.enter() {
		return s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
	}
	err = s.handleHello(m)
	s.reqID = 0
	if closing := s.leave(); err == nil && closing {
		err = s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
	}
	if err != nil {
		return err
	}

	for {
		typ, data, err := s.readMsg()
		if err != nil {
			return err
		}
		if typ == websocket.MessageBinary {
			// Bodies are only ever read inside handlePut, where the server
			// knows exactly how many to expect. A binary frame anywhere else
			// means the two ends disagree about protocol state, and continuing
			// would mean guessing what it was.
			return s.fatal(wire.CodeProtoState,
				fmt.Errorf("unexpected binary frame (%d bytes)", len(data)))
		}
		// Before decoding, because decoding would quietly repair what this
		// refuses: a path with invalid UTF-8 in it arrives as another path.
		if err := wire.ValidText(data); err != nil {
			return s.fatal(wire.CodeProtoState, err)
		}
		var m wire.In
		if err := json.Unmarshal(data, &m); err != nil {
			return s.fatal(wire.CodeProtoState, fmt.Errorf("parse: %w", err))
		}
		if err := s.takeID(m); err != nil {
			return err
		}
		// The shutdown check sits around the request, not around the read.
		// A request already in flight is finished, so a put that has stored
		// its bodies gets its commit and its ack; one that arrives after the
		// shutdown began is refused before it starts anything (S16).
		if !s.enter() {
			return s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
		}
		err = s.dispatch(m, len(data))
		// Cleared before the shutdown notice below, so that notice carries no
		// id: it answers no request.
		s.reqID = 0
		if closing := s.leave(); err == nil && closing {
			err = s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
		}
		if err != nil {
			return err
		}
	}
}

// dispatch routes one request. frameLen is the encoded size of the frame it
// arrived in, which is what maxBatchBytes bounds.
//
// Every session is a device's: the only way past hello is a device row whose
// token matched, so there is no second kind of session to route differently.
// Basalt had one, the registrar, which could administer the device list and
// not sync; protocol 1 has no vault credential for it to hold, and the
// operator's powers are the control socket's (PLAN.md section 2.3.1).
func (s *Session) dispatch(m wire.In, frameLen int) error {
	switch m.Op {
	case "hello":
		return s.fatal(wire.CodeProtoState, errors.New("hello sent twice"))
	case "ping":
		return s.writeJSON(wire.Pong{Res: "pong"})
	case "put":
		return s.handlePut(m)
	case "putmany":
		return s.handlePutMany(m, frameLen)
	case "resend":
		return s.handleResend(m)
	case "get":
		return s.handleGet(m)
	case "fetch":
		return s.handleFetch(m)
	case "history":
		return s.handleHistory(m)
	case "deleted":
		return s.handleDeleted(m)
	case "invite":
		return s.handleInvite(m)
	case "uninvite":
		return s.handleUninvite(m)
	case "devices":
		return s.handleDevices(m)
	case "applied":
		return s.handleApplied(m)
	case "revoke":
		return s.handleRevoke(m)
	case "rename":
		return s.handleRename(m)
	}
	// Named, not ignored. A client blocked waiting on a reply it will never
	// get looks exactly like a hung server. `register` and `rotate` land here
	// too: they were Basalt's, and protocol 1 has neither.
	return s.reject(wire.CodeProtoState, fmt.Errorf("unknown op %q", m.Op))
}

func (s *Session) handleHello(m wire.In) error {
	// Version before credentials: refusing on proto is not a security answer
	// and a client on the wrong version deserves to be told so plainly. The
	// range is one version wide today and the check is written as a range on
	// purpose; see wire.Proto.
	//
	// Both numbers and nothing else. Nothing has authenticated yet, so this
	// refusal is what anyone on the internet gets for one JSON frame, and it
	// used to name the release: "this server (version 0.3.2) speaks 3 to 3".
	// Behind Caddy that is the port on the open internet handing a prober the
	// string a targeted exploit starts from. The version is in `ready`, after
	// auth, for the device that has proved it may ask; see docs/design.md, "What
	// a stranger on the port learns", and
	// TestAProtoRefusalDoesNotNameTheServerVersion.
	//
	// A Basalt plugin meeting this server says protocol 7 and is refused here,
	// as `proto` with both numbers, before any field it carries is read.
	if m.Proto < wire.MinProto || m.Proto > wire.Proto {
		return s.fatal(wire.CodeProto, fmt.Errorf(
			"protocol %d not supported, this server speaks %d to %d",
			m.Proto, wire.MinProto, wire.Proto))
	}
	if err := s.takeID(m); err != nil {
		return err
	}
	if m.Vault == "" {
		return s.fatal(wire.CodeAuth, errors.New("missing vault"))
	}
	// Both names are bounded and checked for control characters before either
	// is logged or looked up (S24, I6). They land in log lines and, for the
	// device, on every entry it writes, and a newline in a log line is a forged
	// log line.
	if err := checkName("vault", m.Vault, store.MaxVaultLen); err != nil {
		return s.fatal(wire.CodeBadName, err)
	}
	if err := checkName("device", m.Device, store.MaxDeviceLen); err != nil {
		return s.fatal(wire.CodeBadName, err)
	}
	if m.Cursor < 0 {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("negative cursor %d", m.Cursor))
	}

	// Two ways in, and each names its own credential (plan/protocol.md,
	// "Handshake"). A hello carrying an invite is a device joining: the invite
	// is the authority, and the deviceId and token beside it are the ones the
	// joining device has chosen and will connect with from then on. A hello
	// without one is a device connecting, and its token is checked against
	// that device's own row. There is no third: no vault credential, no claim,
	// no registrar session.
	//
	// There is exactly one place a syncing session is built, helloAsDevice,
	// and the only way into it is a device row whose hash matched. Redeeming
	// an invite writes such a row and then closes, rather than becoming that
	// session itself: the redeemer has proved it holds an invite, and its next
	// hello, with the token it has just registered, is the proof that it holds
	// that too.
	if m.Invite != "" {
		return s.helloAsInvite(m)
	}
	return s.helloAsDevice(m)
}

// errNotAuthorised is the one refusal every credential failure at hello gets:
// no device id, an unknown one, a wrong or malformed token, a reserved id, a
// vault this server does not serve, and an invite that is unknown, spent,
// cancelled or expired. Saying which would tell a caller which half to keep
// guessing, and after a revoke it would confirm that an id was a device here
// yesterday. The log says which, for the operator.
var errNotAuthorised = errors.New("not authorised for this vault")

// refuseUnserved is the served-vault check (F19), made on both routes once
// the request's own shape has been judged and before anything is looked up by
// the name the caller sent, so an invite for an unserved vault is refused
// without being spent.
//
// After the shape checks, not before them, and with the refusal every
// credential failure gets. Basalt named the served vault in this refusal, and
// made it before the shape checks, so a malformed hello was `badname` for the
// served vault and `auth` for any other: either way a prober could learn the
// one name worth aiming at. Now every pre-auth answer is a function of the
// request alone. TestNoPreAuthRefusalDependsOnWhetherTheVaultExists.
func (s *Session) refuseUnserved(m wire.In) error {
	if err := s.srv.refuseUnservedVault(m.Vault); err != nil {
		s.srv.log.Warn("hello for a vault this server does not serve", "remote", s.remote, "err", err)
		return s.fatal(wire.CodeAuth, errNotAuthorised)
	}
	return nil
}

// unmatchableHash is what a device with no row is compared against, so that an
// unregistered id and a wrong token take the same constant-time comparison. It
// has a digest's length and cannot be one: it is not hex.
var unmatchableHash = strings.Repeat("x", 64)

// helloAsDevice finishes a hello that named a device: the sync path, and the
// only one there is.
func (s *Session) helloAsDevice(m wire.In) error {
	// A hello carrying neither an invite nor a device id offers no credential
	// at all, and is refused as one that failed rather than as a malformed
	// id.
	if m.DeviceID == "" {
		s.srv.log.Warn("device auth failed", "remote", s.remote, "vault", m.Vault, "why", "no device id")
		return s.fatal(wire.CodeAuth, errNotAuthorised)
	}
	// An id the protocol reserves is refused as a credential, before its shape
	// is judged (plan/protocol.md, "Device session"), so no future row under
	// that prefix can ever be connected to as a device.
	if store.ReservedDeviceID(m.DeviceID) {
		s.srv.log.Warn("device auth failed", "remote", s.remote, "vault", m.Vault, "why", "reserved device id")
		return s.fatal(wire.CodeAuth, errNotAuthorised)
	}
	// Shape next, and as `badname` rather than `auth`, because it is a fact
	// about the request rather than about the vault: refusing a malformed id
	// as an authentication failure would make the shape of an id look like the
	// answer to whether that device exists.
	if !store.ValidDeviceID(m.DeviceID) {
		return s.fatal(wire.CodeBadName, fmt.Errorf(
			"device id is %d bytes and must be base64url of at most %d",
			len(m.DeviceID), store.MaxDeviceIDLen))
	}
	if err := s.refuseUnserved(m); err != nil {
		return err
	}
	_, stored, ok, err := s.srv.st.DeviceByID(m.Vault, m.DeviceID)
	if err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	// The token is the device's 32 random bytes in unpadded base64url, and
	// anything else is refused (plan/protocol.md, "Device session"). The
	// comparison is over the digests and in constant time, and it happens
	// whatever the token looked like and whether or not the row exists: a
	// malformed token is hashed as sent and a missing row is compared against
	// a digest that cannot match, so an unknown id, a wrong token and a
	// malformed one take the same path and get the same refusal.
	raw, wellFormed := store.DecodeToken(m.Token, store.DeviceTokenBytes)
	if !wellFormed {
		raw = []byte(m.Token)
	}
	offered := store.HashToken(raw)
	want := stored
	if !ok {
		want = unmatchableHash
	}
	if subtle.ConstantTimeCompare([]byte(offered), []byte(want)) != 1 || !ok || !wellFormed {
		s.srv.log.Warn("device auth failed", "remote", s.remote, "vault", m.Vault,
			"deviceId", m.DeviceID, "registered", ok, "wellFormed", wellFormed)
		return s.fatal(wire.CodeAuth, errNotAuthorised)
	}

	if s.srv.beforePublish != nil {
		s.srv.beforePublish()
	}
	s.vaultID = m.Vault
	s.device = m.Device
	s.deviceID = m.DeviceID
	s.deviceHash = offered
	// Authenticated: out of the pre-auth count, and allowed the full read
	// limit from here on. Taking sessMu here is also what publishes the fields
	// just written to any goroutine that later takes it.
	s.srv.authenticated(s)
	s.conn.SetReadLimit(ReadLimit)

	latest, err := s.srv.st.LatestUID(m.Vault)
	if err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	// The cursor belongs to a history, and the epoch says which (PLAN.md
	// section 2.8). A client that read its cursor under another epoch is
	// holding a position in a history this store no longer is: restored from
	// a backup, or replaced. Its cursor is not honoured, in either direction:
	// not refused for being ahead, which would leave a client that has not yet
	// seen the new epoch with no way to learn it, and not continued from,
	// which would skip every version the new history holds below it. The
	// whole vault is replayed instead, and `ready` carries the new epoch, so
	// the client discards its cursor and reconciles against everything
	// (plan/protocol.md, "Device session"). A client that sends no epoch has
	// its cursor taken as it is, as before.
	cursor := m.Cursor
	if m.Epoch != "" && m.Epoch != s.srv.st.Epoch() {
		s.srv.log.Warn("device cursor is from another history, replaying the vault from the start",
			"remote", s.remote, "vault", m.Vault, "deviceId", m.DeviceID, "cursor", m.Cursor, "latest", latest)
		cursor = 0
	}
	// A client ahead of the server is refused, loudly.
	//
	// Under one epoch it means the server lost history the client has already
	// applied, which a restore is supposed to announce by changing the epoch
	// and which something else did without it. Left alone, the server reissues
	// uids the client already used for other content, and the two diverge
	// with both sides reporting success. Refusing costs a manual intervention;
	// not refusing costs the vault.
	if cursor > latest {
		return s.fatal(wire.CodeCursor, fmt.Errorf(
			"client cursor %d is ahead of this server's %d: the server is missing history "+
				"the client has already applied, so it would reissue those uids for other files",
			cursor, latest))
	}

	// Join before the backlog is read, not after.
	//
	// Everything committed from this moment reaches us as a broadcast, and
	// deliver buffers those until the replay below is on the wire. There is
	// therefore no interval in which an entry is neither in the backlog query
	// nor in the fan-out, which is the window a check-then-join ordering leaves
	// open and which loses exactly one file when it is hit.
	if s.srv.beforeJoin != nil {
		s.srv.beforeJoin()
	}
	s.srv.hub.join(m.Vault, s)
	s.joined = true

	// Recheck the credential and stamp it as seen after joining, under the
	// same lock as revocation. A prior revoke is refused even if its device ID
	// has since been reused with another key. A later revoke finds this joined
	// session when it collects sockets to close.
	seenAt := s.srv.now().UnixMilli()
	if err := s.authorizedMutation(func() error {
		return s.srv.st.SawDevice(m.Vault, m.DeviceID, seenAt)
	}); err != nil {
		if errors.Is(err, store.ErrUnknownDevice) || errors.Is(err, errSessionRevoked) {
			s.srv.log.Warn("device revoked mid-handshake", "remote", s.remote,
				"vault", m.Vault, "deviceId", m.DeviceID)
			return s.fatal(wire.CodeAuth, errNotAuthorised)
		}
		return s.fatal(wire.CodeInternal, err)
	}

	// Limits first, so a client knows every ceiling before its first put rather
	// than discovering one by being rejected.
	if err := s.writeJSON(s.srv.ready(s.reqID, latest)); err != nil {
		return err
	}
	s.srv.log.Info("session ready", "remote", s.remote, "vault", m.Vault,
		"device", m.Device, "deviceId", m.DeviceID, "cursor", cursor, "latest", latest, "peers", s.srv.hub.peerCount(m.Vault))

	cursor, sent, err := s.replay(m.Vault, cursor)
	if err != nil {
		return err
	}
	if s.srv.afterReplay != nil {
		s.srv.afterReplay()
	}
	// Release anything committed while the replay was running, in uid order and
	// skipping what the replay already covered. flushPending also queues the
	// caught-up frame, under the same lock, so a broadcast cannot slip in ahead
	// of it; see flushPending.
	cursor = s.flushPending(cursor)

	if sent > 0 {
		s.srv.log.Info("catch-up sent", "vault", m.Vault, "entries", sent, "cursor", cursor)
	}
	return nil
}

// helloAsInvite finishes a hello that carried an invite: the one way a device
// is added.
//
// The invite is the authority, and it is the authority to register exactly one
// device: the one this hello names, under the token this hello carries. It is
// unguessable, single use, server tracked and expiring, which is every property
// a registration credential needs and is why the spend and the registration
// are one call into the store rather than two; see store.RedeemInvite for the
// five steps and their order.
//
// What goes back is the id of the row just written, and then the session
// closes. It is not a device session: nothing here has proved that anybody
// holds the token that was just registered. The device's next hello is the
// proof, and helloAsDevice stays the only place a syncing session is built.
//
// A retry of a redemption whose reply was lost is answered `redeemed` again,
// even after the invite has expired, because the redemption it repeats did not
// (plan/protocol.md, "Invite redemption", step 2).
//
// Refusals. Anything about the invite, unknown, spent, cancelled, expired or
// malformed, and a device id the vault already has, is the one `auth` refusal
// every credential failure gets, and writes nothing. The request's own shape
// is named instead, because it says nothing about the vault and is checked
// before the invite is looked up: a device id that is not base64url is
// `badname`, and a token that is not 32 bytes is `badentry`. None of them
// spends the invite.
func (s *Session) helloAsInvite(m wire.In) error {
	if store.ReservedDeviceID(m.DeviceID) {
		s.srv.log.Warn("invite refused", "remote", s.remote, "vault", m.Vault, "why", "reserved device id")
		return s.fatal(wire.CodeAuth, errNotAuthorised)
	}
	if !store.ValidDeviceID(m.DeviceID) {
		return s.fatal(wire.CodeBadName, fmt.Errorf(
			"redeeming an invite registers the device redeeming it, so this hello must carry the "+
				"device id it is registering; this one is %d bytes and it must be base64url of at most %d",
			len(m.DeviceID), store.MaxDeviceIDLen))
	}
	token, ok := store.DecodeToken(m.Token, store.DeviceTokenBytes)
	if !ok {
		return s.fatal(wire.CodeBadEntry, fmt.Errorf(
			"redeeming an invite registers the device redeeming it, so this hello must carry the token "+
				"that device will connect with: %d random bytes in unpadded base64url, %d characters, "+
				"and this one is %d characters that are not that",
			store.DeviceTokenBytes, store.EncodedTokenLen(store.DeviceTokenBytes), len(m.Token)))
	}
	if err := s.refuseUnserved(m); err != nil {
		return err
	}
	secret, ok := store.DecodeToken(m.Invite, store.InviteTokenBytes)
	if !ok {
		s.srv.log.Warn("invite refused", "remote", s.remote, "vault", m.Vault,
			"deviceId", m.DeviceID, "why", "malformed invite token")
		return s.fatal(wire.CodeAuth, errNotAuthorised)
	}

	retried, err := s.srv.st.RedeemInvite(m.Vault, secret, m.DeviceID, m.Device,
		store.HashToken(token), s.srv.now().UnixMilli())
	switch {
	case err == nil:
	case errors.Is(err, store.ErrNoInvite), errors.Is(err, store.ErrUnknownVault):
		s.srv.log.Warn("invite refused", "remote", s.remote, "vault", m.Vault,
			"deviceId", m.DeviceID, "err", err)
		return s.fatal(wire.CodeAuth, errNotAuthorised)
	case errors.Is(err, store.ErrBadEntry):
		return s.fatal(wire.CodeBadEntry, err)
	default:
		s.srv.log.Error("redeem failed", "vault", m.Vault, "err", err)
		return s.fatal(wire.CodeInternal, errors.New("the invite could not be redeemed: "+err.Error()))
	}

	s.srv.log.Info("invite redeemed", "remote", s.remote, "vault", m.Vault,
		"device", m.Device, "deviceId", m.DeviceID, "retried", retried)
	if err := s.writeJSON(wire.Redeemed{Res: "redeemed", ID: s.reqID, DeviceID: m.DeviceID}); err != nil {
		return err
	}
	return errRedeemed
}

// errRedeemed ends a session that connected only to redeem an invite. It is not
// a fault, so no error frame follows the reply; Handle drains and closes.
var errRedeemed = errors.New("invite redeemed, closing")

// errRevokedSelf ends a session that revoked its own device, which is what
// unlinking is. Like errRedeemed it is not a fault: the reply saying so has
// already gone, and Handle drains and closes behind it.
var errRevokedSelf = errors.New("this device revoked itself, closing")

// checkName bounds a vault or device name and refuses control characters in it.
//
// The rule itself moved to store.CheckName when device names became rows in the
// devices table as well as fields on a hello: a name written by a path that
// does not come through here has to be bounded the same way, and two copies of
// a validation is how the two layers come to disagree about what a name is.
// This stays as the name this file has always called it, so the refusals a
// client sees are the same strings they were.
func checkName(what, name string, max int) error { return store.CheckName(what, name, max) }

// replay sends the backlog as batches and returns the cursor it reached.
func (s *Session) replay(vaultID string, cursor int64) (int64, int, error) {
	sent := 0
	for {
		b, ok, err := s.srv.st.NextBatch(vaultID, cursor, s.srv.batchSize)
		if err != nil {
			return cursor, sent, s.fatal(wire.CodeInternal, err)
		}
		if !ok {
			return cursor, sent, nil
		}
		if b.From != cursor+1 {
			// The store computes From as cursor+1, so this can only fire if
			// that ever stops being true. It is checked because the whole
			// point of From is that a client can trust it.
			return cursor, sent, s.fatal(wire.CodeInternal, fmt.Errorf(
				"batch from %d does not continue cursor %d", b.From, cursor))
		}
		entries := b.Entries
		if entries == nil {
			entries = []store.Entry{}
		}
		if err := s.writeJSON(wire.Batch{
			Op: "batch", From: b.From, To: b.To, Entries: entries,
		}); err != nil {
			return cursor, sent, err
		}
		cursor = b.To
		sent += len(b.Entries)
		if s.srv.afterReplayBatch != nil {
			s.srv.afterReplayBatch(sent)
		}
	}
}

/* ---------------------------------------------------------------- *
 * Live delivery
 * ---------------------------------------------------------------- */

// deliverFrame is the non-blocking path used by the hub. Its encoded frame is
// immutable and may also be queued by other sessions.
//
// While this session is still replaying its backlog the change is buffered
// rather than written. Writing it immediately would let a newer uid overtake an
// older catch-up frame in the same queue, and a client that advances its cursor
// to a batch's To would then step past files it has not received.
func (s *Session) deliverFrame(uid int64, b []byte) {
	s.mu.Lock()
	if !s.catchupDone {
		// Bounded in bytes as well as entries (S8). The entry bound alone let
		// a peer hold 4096 marshalled batches of any size, and a batch naming
		// tens of thousands of chunks is megabytes.
		if len(s.pending) >= CatchupBufferMax || s.pendingBytes+int64(len(b)) > CatchupBufferBytes {
			s.mu.Unlock()
			s.kill(errors.New("catch-up buffer overflow, peer too slow"))
			return
		}
		s.pending = append(s.pending, pendingChange{uid: uid, frame: b})
		s.pendingBytes += int64(len(b))
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	s.trySend(websocket.MessageText, b)
}

// liveBatch wraps one committed entry as a single-uid covered range, so live
// changes and catch-up are the same message and the client has one code path.
func liveBatch(e store.Entry, elide bool) wire.Batch {
	// Empty, never nil. A nil slice marshals to JSON null, and a client that
	// iterates entries would then crash on precisely the batches it is meant to
	// handle silently: its own echoes, which are the common case.
	b := wire.Batch{Op: "batch", From: e.UID, To: e.UID, Entries: []store.Entry{}}
	if !elide {
		b.Entries = []store.Entry{e}
	}
	return b
}

// flushPending releases buffered live changes, queues caught-up, and switches
// to direct delivery. Returns the highest uid written.
//
// The sort matters. Two entries can commit in uid order and reach the hub in
// the opposite order, because AppendEntry releases the store's write lock
// before the broadcast runs. The flush, the caught-up frame, and the flag flip
// all happen under one lock so a change arriving mid-flush cannot slip in ahead
// of any of them.
//
// caught-up is queued here, before catchupDone is set, rather than by the
// caller afterwards (S2). Set the flag first and a broadcast from another
// session reaches s.out through deliver before caught-up does, carrying a uid
// above the cursor caught-up will announce. The real client
// (client/src/core/transport.ts) treats a batch after caught-up whose range is
// below caught-up's cursor as fatal protostate, so that reordering drops a
// healthy device.
//
// When the queue has no room, the lock is released and the session waits for
// the writer, then tries again. The queue is often nearly full here, because
// the replay that just finished fills it as fast as the client drains it, and
// the alternative of dropping the peer for that would turn every catch-up over
// a slow link into a reconnect loop. Waiting *inside* the lock is not an
// option either: deliver takes it, so one slow peer would stall every other
// session's fan-out. Changes that land while the lock is released go into
// pending and are picked up on the next pass, still in uid order.
func (s *Session) flushPending(cursor int64) int64 {
	for {
		done, next := s.flushPendingOnce(cursor)
		cursor = next
		if done {
			break
		}
		select {
		case <-s.drained:
		case <-s.dead:
			return cursor
		case <-s.ctx.Done():
			return cursor
		}
	}
	if s.srv.afterFlush != nil {
		s.srv.afterFlush()
	}
	return cursor
}

// flushPendingOnce queues as much of pending as the queue has room for, then
// caught-up. It reports done once caught-up is queued and the handover is
// complete; otherwise what did not fit stays in pending for the next pass.
func (s *Session) flushPendingOnce(cursor int64) (bool, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sort.Slice(s.pending, func(i, j int) bool {
		return s.pending[i].uid < s.pending[j].uid
	})
	for len(s.pending) > 0 {
		p := s.pending[0]
		if p.uid <= cursor {
			// The replay already covered it.
			s.pending = s.pending[1:]
			s.pendingBytes -= int64(len(p.frame))
			continue
		}
		if !s.enqueue(websocket.MessageText, p.frame) {
			return false, cursor
		}
		s.pending = s.pending[1:]
		s.pendingBytes -= int64(len(p.frame))
		cursor = p.uid
	}
	// Same queue, same lock, so nothing can be enqueued between the last
	// buffered change and caught-up.
	b, err := json.Marshal(wire.CaughtUp{Op: "caught-up", Cursor: cursor})
	if err != nil || !s.enqueue(websocket.MessageText, b) {
		return false, cursor
	}
	s.pending = nil
	s.pendingBytes = 0
	s.catchupDone = true
	return true, cursor
}

/* ---------------------------------------------------------------- *
 * put
 * ---------------------------------------------------------------- */

// checkEntry runs every refusal a single put makes, without writing one.
//
// Split out of handlePut so a batch can decide per entry and carry on. The
// order matters: the named refusals first, because the protocol gives badpath
// and toolarge their own codes and a client acts on them differently, then
// Validate, which is the enforcer.
//
// The path first of all, for every kind of entry and for a rename's source as
// well as its destination, since the server is the last line of defence
// against a client that sends a path Obsidian would never hold (PLAN.md
// section 4.1). The reason code leads the message.
func (s *Session) checkEntry(e store.Entry) *wire.Err {
	if err := e.CheckPaths(); err != nil {
		refusal := wire.Error(wire.CodeBadPath, err.Error())
		return &refusal
	}
	if e.Size > s.srv.perFileMax {
		err := wire.Error(wire.CodeToolarge,
			fmt.Sprintf("file is %d bytes, limit is %d", e.Size, s.srv.perFileMax))
		return &err
	}
	if len(e.Chunks) > store.MaxChunksPerEntry {
		err := wire.Error(wire.CodeToolarge,
			fmt.Sprintf("%d chunks, limit is %d", len(e.Chunks), store.MaxChunksPerEntry))
		return &err
	}
	if err := e.Validate(); err != nil {
		code := wire.CodeBadEntry
		if errors.Is(err, store.ErrBadPath) {
			code = wire.CodeBadPath
		}
		refusal := wire.Error(code, err.Error())
		return &refusal
	}
	return nil
}

// handlePutMany is handlePut for several entries and one round trip.
//
// The shape is the same: work out what is missing, ask for it once, read the
// bodies, commit. What changes is that the want list is the union across every
// entry and the answer is one result per entry, so a batch of two hundred
// paths costs one exchange rather than two hundred.
//
// Nothing is committed until every body has arrived, and each entry is then
// committed on its own, so an ack still means what it has always meant: this
// entry and its bodies are durable.
func (s *Session) handlePutMany(m wire.In, frameLen int) error {
	if len(m.Entries) == 0 {
		return s.reject(wire.CodeBadEntry, errors.New("a batched put with no entries in it"))
	}
	if len(m.Entries) > wire.MaxBatchEntries {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("%d entries in one put, limit is %d", len(m.Entries), wire.MaxBatchEntries))
	}
	// The two bounds maxBatchBytes names (S18). The frame, so that a batch
	// naming enough chunks to matter is refused with a code rather than dying
	// at the read limit; and the declared sizes summed over every entry, which
	// is the raw budget of plan/protocol.md ("Limits"), so that one exchange
	// can never be allowed to upload more than the cap however many files it
	// carries. It is summed over every entry rather than over what the server
	// lacks, because that is the figure a client can compute for itself before
	// sending.
	if int64(frameLen) > s.srv.maxBatchBytes {
		return s.reject(wire.CodeToolarge, fmt.Errorf(
			"the putmany frame is %d bytes, limit is %d; split the batch", frameLen, s.srv.maxBatchBytes))
	}
	// Summed over sizes the peer chose, so a size the peer chose cannot make
	// the sum smaller.
	//
	// `Meta.Size` is an `int64` straight off the wire and is only refused as
	// negative much later, inside `prepare`. One entry declaring `-(1<<40)`
	// dragged this total below zero, the cap passed, and the entries that
	// *were* valid then handed `readBodies` their full combined allowance:
	// 255 files at the per-file ceiling is about 16 GiB against the 16 MiB
	// this frame is allowed, read onto the disk before anything is committed.
	// `MaxInt64` did it by overflow instead. A cap summed from unvalidated
	// numbers is not a cap.
	var budgets int64
	for _, in := range m.Entries {
		spend := in.Meta.Size
		// A size the peer chose cannot make the sum smaller. Nothing is
		// refused here for it: an entry with an impossible size is refused on
		// its own by `prepare`, and the rest of the batch still commits, which
		// is the contract this exchange has. What it must not do is *buy*
		// budget for the entries beside it.
		if spend < 0 {
			spend = 0
		}
		// And the sum saturates rather than wrapping, for the same reason from
		// the other end.
		if budgets > math.MaxInt64-spend {
			budgets = math.MaxInt64
			break
		}
		budgets += spend
	}
	if budgets > s.srv.maxBatchBytes {
		return s.reject(wire.CodeToolarge, fmt.Errorf(
			"the entries in this batch could upload %d bytes between them, limit is %d; "+
				"split the batch, and send a file over the limit on its own with put",
			budgets, s.srv.maxBatchBytes))
	}

	items := make([]preparedEntry, len(m.Entries))

	// The union, in the order the entries name them, without repeats: two files
	// sharing a chunk ask for it once, which is the whole of what dedup buys on
	// a first sync.
	var want []string
	asked := map[string]struct{}{}
	var allowance int64

	// Whether an earlier entry of this batch takes a path out of the live set:
	// a deletion, or a move, which retires its source. The collision question
	// `prepare` asks is asked of the store as it stands, before any entry of
	// the batch commits, and one of those entries can free exactly the key a
	// later one needs: a rename the client found by scanning arrives as a
	// deletion of Note.md and a create of NOTE.md. The commit checks each entry
	// against the state the earlier ones left (plan/protocol.md, "Paths"), so
	// after such an entry only the commit may refuse one for colliding; asking
	// early would refuse a create the batch itself makes legal.
	freed := false
	for i, in := range m.Entries {
		e := in.Entry(s.device)
		missing, spend, refusal := s.prepare(e, in.Base, in.PrevBase, !freed)
		if refusal != nil {
			// One entry's refusal is one entry's result in the acks, and the
			// rest of the batch still commits, so it is carried rather than
			// written. Unlike handlePut, nothing is logged here.
			items[i] = preparedEntry{entry: e, refusal: refusal}
			continue
		}

		items[i] = preparedEntry{entry: e}
		if e.Deleted || e.Prev != "" {
			freed = true
		}
		for _, name := range missing {
			if _, seen := asked[name]; seen {
				continue
			}
			asked[name] = struct{}{}
			want = append(want, name)
		}
		allowance += spend
	}

	if len(want) > 0 {
		if err := s.writeJSON(wire.Want{Res: "want", ID: s.reqID, Chunks: want}); err != nil {
			return err
		}
		if err := s.readBodies(want, allowance); err != nil {
			return err
		}
	}

	results, err := s.commitMany(items, m.Entries)
	if err != nil {
		return err
	}
	return s.writeJSON(wire.Acks{Res: "acks", ID: s.reqID, Results: results})
}

// preparedEntry is one entry of a batch after `prepare`: either a store entry
// ready to commit, or the refusal that stands in its place.
type preparedEntry struct {
	entry   store.Entry
	refusal *wire.Err
}

// commitMany commits every entry of a batch that prepare did not already
// refuse, in one transaction (R083-23).
//
// One fsync for the batch rather than one per entry, which is what a folder
// rename or a bulk delete is made of: those batches carry no bodies, so the
// syncs were the whole cost of them. The per-entry answers are unchanged,
// because the store rolls back a savepoint for a stale or malformed entry and
// leaves the rest of the batch committed.
//
// The broadcast moves to the end, after the transaction is durable. It used to
// go out as each entry committed, which meant a peer could be told about entry
// three of five before entries four and five existed; now nothing is announced
// that is not on the disk.
func (s *Session) commitMany(items []preparedEntry, sent []wire.PutEntry) ([]wire.AckResult, error) {
	results := make([]wire.AckResult, len(items))
	entries := make([]store.Entry, 0, len(items))
	bases := make([]int64, 0, len(items))
	prevBases := make([]int64, 0, len(items))
	at := make([]int, 0, len(items))
	for i, item := range items {
		if item.refusal != nil {
			results[i] = wire.AckResult{Code: item.refusal.Code, Msg: item.refusal.Msg}
			continue
		}
		s.noteFutureMTime(item.entry)
		entries = append(entries, item.entry)
		bases = append(bases, sent[i].Base)
		prevBases = append(prevBases, sent[i].PrevBase)
		at = append(at, i)
	}
	if len(entries) == 0 {
		return results, nil
	}

	s.srv.commitMu.Lock()
	defer s.srv.commitMu.Unlock()
	if err := s.currentCredential(); err != nil {
		code := wire.CodeInternal
		if errors.Is(err, errSessionRevoked) {
			code = wire.CodeAuth
		}
		for _, i := range at {
			results[i] = wire.AckResult{Code: code, Msg: err.Error()}
		}
		return results, nil
	}

	if s.srv.beforeAppend != nil {
		for k, e := range entries {
			if err := s.srv.beforeAppend(e); err != nil {
				// The same answer the per-entry path gave: this is a test hook
				// standing in for a commit failure, so it refuses this entry
				// and the batch goes on without it.
				results[at[k]] = wire.AckResult{
					Code: wire.CodeInternal,
					Msg:  "the entry could not be committed: " + err.Error(),
				}
				entries[k].Path = ""
			}
		}
	}

	var out []store.ManyResult
	var err error
	if s.srv.failBatch != nil {
		err = s.srv.failBatch
	} else {
		out, err = s.srv.st.AppendMany(s.vaultID, entries, bases, prevBases)
	}
	if err != nil {
		// One transaction per batch is an optimisation, and an optimisation
		// that can stop a vault syncing is worse than the fsyncs it saves.
		//
		// The batched commit arrived in 0.8.4 and inside a day was failing on a
		// real vault with "disk I/O error (6410)" on every batch a device sent:
		// it connected, its batch was refused, the session ended, and it tried
		// again three seconds later, twenty-two thousand times in a day.
		// Nothing was lost, because nothing was acknowledged, and nothing
		// synced either. The server said the same line each time and never
		// tried the path that had worked for every release before it.
		//
		// So it falls back to that path: one entry at a time, one fsync each,
		// available whenever the batch is not. A vault that syncs slowly is a
		// working vault; this is the difference.
		s.srv.log.Warn("batch commit failed, committing one at a time",
			"vault", s.vaultID, "entries", len(entries), "err", err)
		out = make([]store.ManyResult, len(entries))
		for k, e := range entries {
			if e.Path == "" {
				continue // refused by beforeAppend above
			}
			uid, single := s.srv.st.AppendCurrent(s.vaultID, e, bases[k], prevBases[k])
			out[k] = store.ManyResult{UID: uid, Err: single}
		}
	}

	// Durable, so now it can be said out loud.
	for k, r := range out {
		i := at[k]
		if results[i].Code != "" {
			continue // refused by beforeAppend above
		}
		if r.Err != nil {
			code := commitCode(r.Err)
			if code == "" {
				s.srv.log.Error("commit failed", "vault", s.vaultID, "err", r.Err)
				code = wire.CodeInternal
			} else {
				s.srv.log.Warn("refused at commit", "vault", s.vaultID,
					"path", len(entries[k].Path), "code", code, "err", r.Err)
			}
			results[i] = wire.AckResult{Code: code, Msg: r.Err.Error()}
			continue
		}
		e := entries[k]
		e.UID = r.UID
		if s.srv.afterAppend != nil {
			s.srv.afterAppend(r.UID)
		}
		s.srv.log.Info("committed", "vault", s.vaultID, "uid", r.UID,
			"size", e.Size, "chunks", len(e.Chunks),
			"folder", e.Folder, "deleted", e.Deleted)
		s.srv.hub.broadcast(s.vaultID, e, s)
		results[i] = wire.AckResult{UID: r.UID}
	}
	return results, nil
}

// prepare runs every refusal a put makes before a single body is read, and
// returns the chunks the server lacks along with what this entry is still
// allowed to upload.
//
// The same refusals, in the same order, for a single put and for one entry of a
// batch. One list, so the two puts cannot drift apart on what they refuse (S6).
//
// The refusal is returned rather than written, because the two callers report
// differently and deliberately: handlePut sends an error frame and logs it,
// while one entry of a batch is only a result in the acks and the rest of the
// batch still commits.
//
// askCollision says whether the collision rule may be asked now, of the store
// as it stands. A single put always may. An entry of a batch may not once an
// earlier entry of that batch deletes or moves a path, since the answer now
// could differ from the commit's, which is the one that stands; see
// handlePutMany.
func (s *Session) prepare(e store.Entry, base, prevBase int64, askCollision bool) (missing []string, allowance int64, refusal *wire.Err) {
	if e.Prev == "" && prevBase != 0 {
		r := wire.Error(wire.CodeBadEntry, "prevBase requires a previous path")
		return nil, 0, &r
	}
	if err := store.ValidateBase(prevBase); err != nil {
		r := wire.Error(wire.CodeBadEntry, err.Error())
		return nil, 0, &r
	}
	if err := store.ValidateBase(base); err != nil {
		r := wire.Error(wire.CodeBadEntry, err.Error())
		return nil, 0, &r
	}
	if r := s.checkEntry(e); r != nil {
		return nil, 0, r
	}
	// The collision rule, asked before any body is: an entry that collides
	// now is refused before its bytes are sent. The commit asks again under
	// the lock, and that answer is the one that stands.
	if askCollision {
		if err := s.srv.st.Collides(s.vaultID, e); errors.Is(err, store.ErrCollision) {
			r := wire.Error(wire.CodeCollision, err.Error())
			return nil, 0, &r
		}
	}

	missing, sizes, err := s.srv.st.Chunks().Missing(s.vaultID, e.Chunks)
	if err != nil {
		// The only failure Missing has is a malformed name, which Validate
		// should already have caught. Reported rather than assumed away.
		r := wire.Error(wire.CodeBadChunk, err.Error())
		return nil, 0, &r
	}

	// What this entry may still upload: its declared size, less what the
	// chunks the server already holds account for. The declared size must be
	// the sum of the raw chunk lengths (plan/protocol.md, "Chunk bodies"), so
	// an entry whose held chunks alone exceed it can never be committed, and
	// is refused as `badentry` before any body is asked for.
	//
	// The store re-checks the sum at commit and is the authority; the point of
	// bounding it here too is that the commit happens *after* the upload, so
	// relying on it alone would let a client write the disk full and only then
	// be told no. Refusing before the want list goes out costs nothing.
	held := heldBytes(e.Chunks, missing, sizes)
	if held > e.Size {
		r := wire.Error(wire.CodeBadEntry, fmt.Sprintf(
			"the chunks named already hold %d bytes for a declared size of %d, and the size of an "+
				"entry is the sum of its chunks' lengths", held, e.Size))
		return nil, 0, &r
	}
	return missing, e.Size - held, nil
}

func (s *Session) handlePut(m wire.In) error {
	// The session's device, never the message's, and the same call the batched
	// put makes. wire.In.Entry has no way to reach the message's device now, so
	// a put under another device's name is unexpressible rather than commented.
	e := m.Entry(s.device)

	missing, allowance, refusal := s.prepare(e, m.Base, m.PrevBase, true)
	if refusal != nil {
		// reject rather than refuse: a single put's refusal is logged, where one
		// entry of a batch is only a line in the acks.
		return s.reject(refusal.Code, errors.New(refusal.Msg))
	}

	if len(missing) == 0 {
		uid, refusal := s.commit(e, m.Base, m.PrevBase)
		if refusal != nil {
			return s.refuse(refusal)
		}
		return s.writeJSON(wire.Have{Res: "have", ID: s.reqID, UID: uid})
	}

	if err := s.writeJSON(wire.Want{Res: "want", ID: s.reqID, Chunks: missing}); err != nil {
		return err
	}
	if err := s.readBodies(missing, allowance); err != nil {
		return err
	}

	uid, refusal := s.commit(e, m.Base, m.PrevBase)
	if refusal != nil {
		return s.refuse(refusal)
	}
	// Only now is the ack truthful: every body is durable and so is the entry.
	return s.writeJSON(wire.Ack{Res: "ack", ID: s.reqID, UID: uid})
}

// heldBytes totals what the named chunks already occupy, from the sizes Missing
// gathered rather than by stat'ing them again.
//
// Once per reference, not once per distinct chunk: an entry naming the same
// chunk twice is charged for it twice, which is what the declared size counts
// and what TestTheSizeCountsRepeatedChunksOncePerReference is about.
//
// A name that is neither missing nor sized was present when Missing looked and
// is not now. The sweep can do that; the commit will refuse and the client
// retries, so it is counted as nothing here rather than treated as a fault.
func heldBytes(all, missing []string, sizes map[string]int64) int64 {
	absent := make(map[string]struct{}, len(missing))
	for _, n := range missing {
		absent[n] = struct{}{}
	}
	var held int64
	for _, n := range all {
		if _, gone := absent[n]; gone {
			continue
		}
		held += sizes[n]
	}
	return held
}

// readBodies reads one binary frame per wanted chunk and stores each, refusing
// once the uploads pass what the entry's declared size can account for.
//
// Each frame is decoded first, here, at the transport boundary
// (plan/protocol.md, "Chunk bodies"): a marker byte, then the raw chunk or
// its raw DEFLATE, inflated with a bound so a small payload cannot expand
// without limit. Everything after this line sees raw bytes and nothing else:
// the name is the SHA-256 of the raw chunk, the allowance counts raw bytes,
// and the chunk store holds raw bytes. How a client chose to encode a body
// never reaches identity.
//
// Frames are matched to names by hashing the decoded body, not by position.
// That is only possible because a chunk name *is* the hash of its body, and it
// is strictly better than trusting order: a client that reorders, repeats or
// skips a frame is caught here rather than storing one body under another's
// name.
//
// Every failure in here ends the session. Mid-stream there is no way to tell
// the client "skip that one and carry on" without both ends agreeing how many
// frames remain, and guessing is how two ends desync silently.
func (s *Session) readBodies(want []string, allowance int64) error {
	outstanding := make(map[string]struct{}, len(want))
	for _, n := range want {
		outstanding[n] = struct{}{}
	}

	// The bodies go to disk through one batch writer rather than one at a time.
	// An fsync is almost all waiting, and doing them in series left the wire and
	// most of the disk idle for the length of a first sync. Nothing is treated
	// as stored until Close returns, which is before the entry is committed and
	// so before anything is acknowledged.
	w := s.srv.st.Chunks().NewWriter(s.vaultID)
	closed := false
	defer func() {
		if !closed {
			if s.srv.abandonBodies != nil {
				s.srv.abandonBodies()
			}
			// The caller is abandoning this exchange. The chunks that did land
			// are harmless: a chunk no entry references is what the sweep
			// collects, and one that is referenced later is one fewer to send.
			//
			// Closed here, on the session goroutine, and not left to finish on
			// its own: Close is what joins the writers, and Handle forgets the
			// session only after this returns, so Server.Shutdown cannot return
			// while a body of this exchange is still being written. A backup
			// or a restart that follows a stop sees every body whole or not at
			// all, never a temp file some goroutine is still filling.
			_ = w.Close()
		}
	}()

	var uploaded int64
	for len(outstanding) > 0 {
		typ, body, err := s.readMsg()
		if err != nil {
			// Includes the client hanging up mid-upload. Nothing is committed:
			// the entry is appended only after this returns cleanly.
			return err
		}
		if typ != websocket.MessageBinary {
			return s.fatal(wire.CodeProtoState, fmt.Errorf(
				"expected a chunk body, got a text frame with %d chunks still wanted",
				len(outstanding)))
		}

		raw, err := frame.Decode(body, int(s.srv.st.Chunks().Max()))
		if err != nil {
			code := wire.CodeBadChunk
			if errors.Is(err, frame.ErrTooLarge) {
				code = wire.CodeToolarge
			}
			return s.fatal(code, fmt.Errorf("a %d byte body frame could not be read, with %d chunks still wanted: %w",
				len(body), len(outstanding), err))
		}
		name := chunks.Name(raw)
		if _, wanted := outstanding[name]; !wanted {
			// Either a body nobody asked for, or one sent twice. Both mean the
			// remaining frame count is no longer agreed.
			return s.fatal(wire.CodeBadChunk, fmt.Errorf(
				"received a %d byte body hashing to %s, which was not among the %d chunks still wanted",
				len(raw), name, len(outstanding)))
		}
		// Checked before the write, not after. The point of the bound is that
		// the bytes never reach the disk.
		uploaded += int64(len(raw))
		if uploaded > allowance {
			return s.fatal(wire.CodeToolarge, fmt.Errorf(
				"uploads reached %d bytes with %d chunks still wanted, and this entry's "+
					"declared size allows %d",
				uploaded, len(outstanding), allowance))
		}
		if err := w.Add(name, raw); err != nil {
			return s.fatal(putErrorCode(err), err)
		}
		delete(outstanding, name)
	}

	closed = true
	if err := w.Close(); err != nil {
		return s.fatal(putErrorCode(err), err)
	}
	return nil
}

// commitCode names the entry-level refusals AppendEntry can return. An empty
// string means the fault is not attributable to the entry, and a session that
// cannot commit for reasons of its own has nothing useful left to say.
func commitCode(err error) string {
	if errors.Is(err, store.ErrStale) {
		return wire.CodeStale
	}
	switch {
	case errors.Is(err, store.ErrBadPath):
		return wire.CodeBadPath
	case errors.Is(err, store.ErrCollision):
		return wire.CodeCollision
	case errors.Is(err, store.ErrBadEntry):
		return wire.CodeBadEntry
	case errors.Is(err, store.ErrChunkMissing):
		// A body was swept between the upload and the commit. The client is
		// told which entry and re-uploads; see chunks.DefaultGrace for why this
		// is rare.
		return wire.CodeNoChunk
	}
	return ""
}

// putErrorCode classifies a failure to store a body.
//
// It is a function rather than an inline switch so the classification can be
// tested directly: a full disk is not something a test can arrange, and before
// this it arrived as an unexplained internal fault while `nospace` sat in the
// protocol's code list and was never sent by anything.
func putErrorCode(err error) string {
	switch {
	case errors.Is(err, chunks.ErrTooLarge):
		return wire.CodeToolarge
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return wire.CodeNoSpace
	default:
		return wire.CodeInternal
	}
}

// commit appends an entry and returns the uid it was given.
//
// A refusal the entry itself caused comes back as a *wire.Err with nothing
// written to the socket, because the caller decides what that means. For a
// single put it is an error frame and the session continues; for a batch it is
// one entry's result and the other entries still commit. Killing the session
// instead would leave a batch half committed and every entry in it unacked,
// which is the failure batching exists to avoid.
//
// A fault that is the server's rather than the entry's, the database refusing
// the commit, comes back as an `internal` refusal and the session continues
// (S27). Nothing was committed, the bodies on disk are harmless, and the client
// retries the put; the error table says `internal` ends a session only during
// the handshake and catch-up, where there is nothing to continue with. Ending
// it here used to cost a reconnect and a replayed handshake for a fault the
// next put might not even see.
func (s *Session) commit(e store.Entry, base, prevBase int64) (int64, *wire.Err) {
	s.noteFutureMTime(e)

	s.srv.commitMu.Lock()
	defer s.srv.commitMu.Unlock()
	if err := s.currentCredential(); err != nil {
		code := wire.CodeInternal
		if errors.Is(err, errSessionRevoked) {
			code = wire.CodeAuth
		}
		refusal := wire.Error(code, err.Error())
		return 0, &refusal
	}

	var uid int64
	var err error
	if s.srv.beforeAppend != nil {
		err = s.srv.beforeAppend(e)
	}
	if err == nil {
		uid, err = s.srv.st.AppendCurrent(s.vaultID, e, base, prevBase)
	}
	if err != nil {
		if code := commitCode(err); code != "" {
			s.srv.log.Warn("refused at commit",
				"vault", s.vaultID, "path", len(e.Path), "code", code, "err", err)
			refusal := wire.Error(code, err.Error())
			return 0, &refusal
		}
		s.srv.log.Error("commit failed", "vault", s.vaultID, "err", err)
		refusal := wire.Error(wire.CodeInternal, "the entry could not be committed: "+err.Error())
		return 0, &refusal
	}
	e.UID = uid
	if s.srv.afterAppend != nil {
		s.srv.afterAppend(uid)
	}
	s.srv.log.Info("committed", "vault", s.vaultID, "uid", uid,
		"size", e.Size, "chunks", len(e.Chunks),
		"folder", e.Folder, "deleted", e.Deleted)

	s.srv.hub.broadcast(s.vaultID, e, s)
	return uid, nil
}

// fetchKeepBytes is how much of a fetch's verified bodies the session holds on
// to between verifying them and sending them (I09).
//
// Eight mebibytes because that is most fetches whole. The client asks in sets
// bounded by its own batching, and a set larger than this is an attachment
// being fetched in one go, where the double read is a smaller share of the cost
// than the network is anyway. What this must not become is MaxFetchBytes: 64
// MiB held per session, for the length of a send over whatever link the device
// is on, is a worse trade than reading the tail of a large fetch twice.
const fetchKeepBytes = 8 << 20

// clockSkewTolerance is how far ahead of the server a device's timestamps may
// be before it is reported as having a wrong clock.
//
// Wide on purpose, and one-sided. A past mtime is ordinary: every note written
// before the vault was paired has one, and a vault full of 2015 files is not a
// fault. A *future* mtime cannot be produced by a correct clock, so that is the
// only direction worth reporting.
//
// A day rather than an hour because both clocks are suspects here. A device an
// hour out is more likely to be a server that has not synced its own time than
// a device with the wrong date, and naming somebody's phone as broken when it
// is not is worse than saying nothing. A device with a genuinely wrong clock is
// out by days.
const clockSkewTolerance = 24 * time.Hour

// noteFutureMTime says so, once, when a device declares a modification time
// this server's clock says has not happened yet.
//
// `ctime` and `mtime` are the client's, and never checked against anything:
// the server has no business overruling what a device says about its own
// files. A device with a
// wrong clock therefore writes entries whose timestamps are wrong, and both
// shells print those timestamps beside every version in a history list.
//
// Nothing is at risk. Merging is by hash, the cursor is by uid, and history is
// ordered `uid DESC`, which is arrival order and involves no clock at all, so
// what a skewed device costs is a label that reads oddly next to a list that is
// correctly ordered. TestHistoryIsOrderedByArrivalAndNotByAnyClock.
//
// What was proposed instead was a server-stamped arrival time that the UI would
// prefer over the client's. Basalt declined it because its server could write
// nothing a key did not cover. A Trew server holds the notes in the clear,
// so that reason is gone, and PLAN.md section 4.5 gives operations a server
// commit time for retention; the label a device shows stays the device's own.
// Saying the clock is wrong costs nothing and fixes the cause.
//
// Once per session, because a first sync commits thousands of entries.
// TestASkewedDeviceIsReportedOncePerSession.
func (s *Session) noteFutureMTime(e store.Entry) {
	if s.saidSkewed || e.MTime <= 0 {
		return
	}
	ahead := time.Duration(e.MTime-s.srv.now().UnixMilli()) * time.Millisecond
	if ahead <= clockSkewTolerance {
		return
	}
	s.saidSkewed = true
	s.srv.log.Warn("a device is writing timestamps from the future, so its clock or this server's is wrong",
		"vault", s.vaultID, "device", s.device, "deviceId", s.deviceID,
		"ahead", ahead.Round(time.Minute),
		"hint", "history is ordered by arrival and is unaffected; the times shown beside each version are not")
}

/* ---------------------------------------------------------------- *
 * get and fetch
 * ---------------------------------------------------------------- */

// handleHistory answers with every version of one path, newest first.
//
// The path is a key in a table here, nothing more, and one that no entry has
// ever had simply has no versions. It is not held to the path policy, because
// a question is not a write: a path the policy refuses is one the vault cannot
// hold, and the honest answer for it is the empty list.
//
// An empty list is not an error. The server cannot tell a path that never
// existed from one whose history was purged, because both are absent, and
// inventing a distinction it cannot support would be a lie in a recovery tool.
func (s *Session) handleHistory(m wire.In) error {
	if m.Path == "" {
		return s.reject(wire.CodeBadPath, errors.New("empty: history needs a path"))
	}
	if m.Before < 0 {
		return s.reject(wire.CodeProtoState, fmt.Errorf("negative before %d", m.Before))
	}

	entries, err := s.srv.st.HistoryForPath(s.vaultID, m.Path, m.Before, m.Limit)
	if err != nil {
		s.srv.log.Error("history", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("could not read history"))
	}
	return s.writeJSON(wire.History{Res: "history", ID: s.reqID, Path: m.Path, Entries: nonNil(entries)})
}

// handleDeleted answers with every path whose newest version is a deletion.
//
// This is the list somebody reads when they have lost a note and do not know
// what it was called, so the ordering is newest first and renames are
// suppressed. See wire.Deleted for why suppression is not optional.
func (s *Session) handleDeleted(m wire.In) error {
	if m.Before < 0 {
		return s.reject(wire.CodeBadEntry, fmt.Errorf("before %d is not a uid", m.Before))
	}
	entries, more, err := s.srv.st.Deleted(s.vaultID, true, m.Limit, m.Before)
	if err != nil {
		s.srv.log.Error("deleted", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("could not list deletions"))
	}
	return s.writeJSON(wire.Deleted{Res: "deleted", ID: s.reqID, Entries: nonNil(entries), More: more})
}

// nonNil keeps an empty result an empty array rather than JSON null.
//
// The same reasoning as Batch's entries, and the same bug: a client iterating
// null crashes on exactly the answers it exists to handle, and "no deleted
// notes" is the answer it will see most often.
func nonNil[T any](entries []T) []T {
	if entries == nil {
		return []T{}
	}
	return entries
}

// handleResend takes bodies for chunks this vault refers to and has lost (I14).
//
// A body can go missing without a single row changing: a disk rots one and
// `verify` quarantines it, or a restore brings back a database whose chunk tree
// is not quite the same age. Every version that names it then downloads
// forever, which presents as a sync that never finishes.
//
// Nothing in ordinary reconciliation fixes that. A device whose copy of the
// note has not changed considers it synced, because it is: the entry is
// committed and the hashes agree. It has the bytes and no reason to send them,
// and the only way to make it send them was to edit the note, which puts a
// version nobody wrote into the history of a vault that is already damaged.
//
// So: a put with no entry. The client names chunks, the server says which of
// them it wants, and the bodies arrive and are stored. No uid is allocated, no
// entry is written, and the vault afterwards is exactly the vault the backup
// should have been.
//
// Two things make it safe to let a device write bodies with no entry:
//
//   - a body is content-addressed, so `chunks.Put` hashes what arrives and
//     refuses anything that is not the body its name claims. A device cannot
//     put the wrong bytes under a name however much it would like to.
//   - a name no committed entry refers to is refused outright. Correct bytes
//     under an unreferenced name are still a paired device writing into the
//     store for ever, and repair is for bodies the vault is missing.
func (s *Session) handleResend(m wire.In) error {
	if len(m.Chunks) == 0 {
		return s.reject(wire.CodeBadChunk, errors.New("resend named no chunks"))
	}
	if len(m.Chunks) > store.MaxChunksPerEntry {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("%d chunks, limit is %d; ask in smaller sets",
				len(m.Chunks), store.MaxChunksPerEntry))
	}
	for _, n := range m.Chunks {
		if !chunks.ValidName(n) {
			return s.reject(wire.CodeBadChunk, fmt.Errorf("%q is not a chunk name", n))
		}
	}

	referenced, err := s.srv.st.ReferencedChunks(s.vaultID, m.Chunks)
	if err != nil {
		return s.reject(wire.CodeInternal, err)
	}
	// Named rather than silently dropped. A device offering a body for a name
	// this vault does not use has an index that disagrees with the server, and
	// telling it so is how that gets found; accepting it quietly would be the
	// server storing something nothing will read.
	for _, n := range m.Chunks {
		if _, ok := referenced[n]; !ok {
			return s.reject(wire.CodeNoChunk, fmt.Errorf(
				"no entry in this vault refers to %s, so there is nothing here for it to repair", n))
		}
	}

	missing, sizes, err := s.srv.st.Chunks().Missing(s.vaultID, m.Chunks)
	if err != nil {
		return s.reject(wire.CodeInternal, err)
	}
	_ = sizes
	if len(missing) == 0 {
		// Nothing to do, said plainly. A device runs repair without knowing
		// whether anything is wrong, and "the server already had all of them"
		// is the answer it is usually hoping for.
		return s.writeJSON(wire.Resent{Res: "resent", ID: s.reqID, Stored: 0, Missing: 0})
	}

	if err := s.writeJSON(wire.Want{Res: "want", ID: s.reqID, Chunks: missing}); err != nil {
		return err
	}
	// These are bodies of versions the vault already holds, which may be larger
	// than today's file ceiling: the ceiling can come down after a large file
	// was stored. Bound them by the chunk ceiling, never by the per-file limit,
	// or the one body that can heal an old version would be refused for a
	// limit that version predates.
	if err := s.readBodies(missing, s.srv.st.Chunks().Max()*int64(len(missing))); err != nil {
		return err
	}

	// Asked again rather than assumed. readBodies returning is not the same
	// statement as "the store now holds them", and rule 4 is that the outcome
	// is what gets checked. It is also how `Missing` in the reply is honest:
	// anything still absent after this is a body the store would not take.
	stillMissing, _, err := s.srv.st.Chunks().Missing(s.vaultID, m.Chunks)
	if err != nil {
		return s.reject(wire.CodeInternal, err)
	}
	return s.writeJSON(wire.Resent{
		Res: "resent", ID: s.reqID,
		Stored:  len(missing) - len(stillMissing),
		Missing: len(stillMissing),
	})
}

func (s *Session) handleGet(m wire.In) error {
	if m.UID <= 0 {
		return s.reject(wire.CodeNoUID, fmt.Errorf("uid %d is not a uid", m.UID))
	}
	e, ok, err := s.srv.st.EntryByUID(s.vaultID, m.UID)
	if err != nil {
		return s.reject(wire.CodeInternal, err)
	}
	if !ok {
		return s.reject(wire.CodeNoUID, fmt.Errorf("no entry %d in this vault", m.UID))
	}
	if !e.HasBody() {
		// The entry exists and has nothing to download. Distinct from an
		// unknown uid, and distinct from an empty chunk list, which is a real
		// zero-byte file.
		return s.reject(wire.CodeNoContent,
			fmt.Errorf("entry %d is a %s", m.UID, kindOf(e)))
	}
	return s.writeJSON(wire.Chunks{
		Res: "chunks", ID: s.reqID, UID: e.UID, Size: e.Size, Chunks: e.Chunks,
	})
}

func kindOf(e store.Entry) string {
	if e.Folder {
		return "folder"
	}
	return "deletion"
}

// handleFetch streams the requested chunk bodies as binary frames, in the order
// requested, each one framed by frame.Encode.
//
// Every chunk is checked to be present, and then read and checked against its
// own name, before any frame is sent. Discovering the third of five is missing
// halfway through leaves the client unable to tell which bodies it received;
// refusing the whole fetch up front leaves it able to ask again for a smaller
// set.
//
// Reading every body twice is what that costs, once to verify and once to send.
// Measured warm, a full 64 MiB fetch of 16 KiB chunks spends about 78 ms on the
// extra pass and one of 1 MiB chunks about 28 ms; a note is a handful of chunks
// and spends tens of microseconds. The pages are in cache for the second read,
// so what is doubled is the hashing rather than the disk. That buys a header
// whose count is the number of bodies that follow, which is the only thing a
// client can pre-allocate against.
func (s *Session) handleFetch(m wire.In) error {
	if len(m.Chunks) == 0 {
		return s.reject(wire.CodeBadChunk, errors.New("fetch names no chunks"))
	}
	if len(m.Chunks) > store.MaxChunksPerEntry {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("%d chunks, limit is %d", len(m.Chunks), store.MaxChunksPerEntry))
	}
	// Presence and size from one stat per chunk. The sum is bounded by
	// maxFetchBytes (S21): a fetch naming every chunk of a large vault would
	// otherwise be one request that the server answers for as long as the
	// client cares to read, and the client was told the cap at hello.
	var total int64
	for _, n := range m.Chunks {
		if !chunks.ValidName(n) {
			return s.reject(wire.CodeBadChunk, fmt.Errorf("%q is not a chunk name", n))
		}
		size, ok := s.srv.st.Chunks().Size(s.vaultID, n)
		if !ok {
			return s.reject(wire.CodeNoChunk, fmt.Errorf("this vault does not hold %s", n))
		}
		total += size
	}
	if total > s.srv.maxFetchBytes {
		return s.reject(wire.CodeToolarge, fmt.Errorf(
			"the %d chunks asked for hold %d bytes, limit for one fetch is %d; ask in smaller sets",
			len(m.Chunks), total, s.srv.maxFetchBytes))
	}
	// Then every body is read and checked against its name, before the header
	// promises how many are coming. A chunk that rotted on disk passes the stat
	// above, so without this the failure was found mid-stream, after some
	// bodies had gone out under a count that could no longer be met. Checking
	// here turns that into a refusal the session survives and the client can
	// act on: it asks again for a smaller set, or for the ones it still needs
	// once a device has resent the bad one. After the size cap, so a fetch that
	// is refused for being too large is refused without reading anything.
	//
	// The bodies this pass read are kept while they fit in fetchKeepBytes, so
	// the send below does not read and hash them a second time (I09). Measured
	// at exactly twice the work, in `BenchmarkFetch`: the page cache makes the
	// second read cheap and the second SHA-256 and the second allocation are
	// paid in full, 17.9 ms and 34.7 MB of garbage for a 16 MiB fetch against
	// 9.0 ms and 17.4 MB.
	//
	// Bounded, and it re-reads whatever did not fit. A map of every body in a
	// fetch would be up to MaxFetchBytes, 64 MiB, held per session for as long
	// as the send takes, which is trading a cost that is paid to a cost that is
	// merely held. The guarantee is untouched either way: every body is
	// verified before the header, and nothing here decides whether to verify,
	// only whether to remember.
	kept := make(map[string][]byte, len(m.Chunks))
	var keptBytes int64
	for i, n := range m.Chunks {
		body, err := s.srv.st.Chunks().Get(s.vaultID, n)
		if err != nil {
			s.quarantineIfCorrupt(n, err)
			return s.reject(wire.CodeNoChunk,
				fmt.Errorf("chunk %d of %d (%s): %w", i+1, len(m.Chunks), n, err))
		}
		if _, already := kept[n]; !already && keptBytes+int64(len(body)) <= fetchKeepBytes {
			kept[n] = body
			keptBytes += int64(len(body))
		}
	}

	// The client is told how many frames follow before the first one, so the
	// answer to a fetch is either this header and exactly that many bodies or
	// an error, never bodies and then an error.
	if err := s.writeJSON(wire.Bodies{Res: "bodies", ID: s.reqID, Count: len(m.Chunks)}); err != nil {
		return err
	}

	for i, n := range m.Chunks {
		body, ok := kept[n]
		if !ok {
			// Did not fit in the budget above, so it is read again. Get
			// verifies the body against its name, so a chunk that rotted on
			// disk is reported here rather than shipped to a device that would
			// refuse it for reasons it cannot diagnose.
			var err error
			body, err = s.srv.st.Chunks().Get(s.vaultID, n)
			if err != nil {
				s.quarantineIfCorrupt(n, err)
				// It verified a moment ago and cannot be read now, so the disk
				// went bad between the two passes. Frames are already on the
				// wire under a count this fetch can no longer meet, so the
				// session ends: the close is what tells the client the count
				// was not kept.
				return s.fatal(wire.CodeNoChunk,
					fmt.Errorf("chunk %d of %d (%s): %w", i+1, len(m.Chunks), n, err))
			}
		}
		// Framed here and nowhere else, at the transport boundary: deflated
		// when that is shorter, raw otherwise, so every frame is at most one
		// byte longer than the chunk it carries.
		if err := s.writeBinary(frame.Encode(body)); err != nil {
			return err
		}
	}
	return nil
}

// quarantineIfCorrupt sets aside a body that failed its own hash.
//
// A body that is not the body its name says is not a body. Left in place it
// would keep satisfying the presence check, so every client would keep being
// told the server already holds it and none would ever send it again. Moved
// aside, the next put asks for it and a device that still has the note heals
// the vault. Anything else, a permission or an IO error, is left alone: it is
// the disk's problem and the body may be perfectly good.
func (s *Session) quarantineIfCorrupt(name string, err error) {
	if !errors.Is(err, chunks.ErrCorrupt) {
		return
	}
	s.srv.log.Error("quarantining a corrupt chunk", "vault", s.vaultID, "chunk", name, "err", err)
	// Through the store, so this takes the lock a commit holds: a body removed
	// between `AppendEntry`'s presence check and its commit is an entry
	// referencing something the server does not have, and the client that was
	// told to skip the upload will not send it again.
	if qerr := s.srv.st.Quarantine(s.vaultID, name); qerr != nil {
		s.srv.log.Error("could not quarantine it", "vault", s.vaultID, "chunk", name, "err", qerr)
	}
}

/* ---------------------------------------------------------------- *
 * The device list
 * ---------------------------------------------------------------- */

// handleDevices answers with every device that may reach this vault and every
// invite that could still add one: the only way to answer "what is still
// connected to my notes".
//
// The invites are in the same reply because they are the same question. A row
// is what has been added and an outstanding invite is what is about to be, and
// an invite issued on a stolen laptop is invisible until somebody redeems it
// unless it is listed. Each is listed by its id, label and expiry, and by
// nothing that redeems it: the id is minted beside the token and is not derived
// from it (plan/protocol.md, "Devices and invites"; store.Invite).
func (s *Session) handleDevices(m wire.In) error {
	ds, err := s.srv.st.Devices(s.vaultID)
	if err != nil {
		s.srv.log.Error("listing devices failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the device list could not be read: "+err.Error()))
	}
	invites, err := s.srv.st.Invites(s.vaultID, s.srv.now().UnixMilli())
	if err != nil {
		s.srv.log.Error("listing invites failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the invite list could not be read: "+err.Error()))
	}
	return s.writeJSON(wire.DeviceList{
		Res: "devices", ID: s.reqID, Devices: s.srv.hub.deviceStatus(s.vaultID, ds), Invites: invites,
	})
}

// handleRename changes this device's own label, and only its own.
//
// There is no field naming the row: it is `s.deviceID`, the device this session
// authenticated as. That is the whole authorisation story, and it is deliberate.
// A device renaming another would need a rule for who may relabel whom, and the
// only reason to want one is tidying somebody else's device list, which is not
// worth an authorisation question.
//
// The name is checked with the same CheckName that invite redemption uses, so a
// name that could not have been chosen at pairing cannot arrive by renaming
// either. `badname` rather than `badentry`, matching every other refusal about a
// name's shape.
//
// Nothing about the vault's content moves, no uid is spent and no entry is
// written, so this is not part of the sync stream and nothing replays it. A
// device that renames itself while another device is mid-pass affects that pass
// not at all; the other device sees the new label the next time it lists.
func (s *Session) handleRename(m wire.In) error {
	if err := store.CheckName("device", m.Name, store.MaxDeviceLen); err != nil {
		return s.reject(wire.CodeBadName, err)
	}
	// Empty is refused rather than accepted as "no name". A blank label in a
	// device list is a row that says nothing, which is the state the suggested
	// name at pairing exists to avoid, and a rename is not the place to reach
	// it by another route.
	if m.Name == "" {
		return s.reject(wire.CodeBadName, errors.New(
			"a device name cannot be empty: it is what the device list, history and conflict "+
				"copies are read by"))
	}
	if err := s.authorizedMutation(func() error {
		return s.srv.st.RenameDevice(s.vaultID, s.deviceID, m.Name)
	}); err != nil {
		if errors.Is(err, errSessionRevoked) {
			return s.fatal(wire.CodeAuth, err)
		}
		if errors.Is(err, store.ErrUnknownDevice) {
			// This session authenticated against a row that has since gone,
			// which is a revocation landing between the hello and this. Fatal
			// for the same reason a revoked device's next op is: retrying
			// cannot succeed, and the connection is no longer one the vault
			// recognises.
			return s.fatal(wire.CodeNoDevice, errors.New(
				"this device is no longer on the vault, so it was not renamed; it was revoked "+
					"while this connection was open"))
		}
		s.srv.log.Error("renaming a device failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the device could not be renamed: "+err.Error()))
	}
	s.srv.log.Info("device renamed", "vault", s.vaultID, "device", s.deviceID, "name", m.Name)
	return s.writeJSON(wire.Renamed{Res: "renamed", ID: s.reqID, Name: m.Name})
}

// handleRevoke deletes a device's row and ends everything that device has open,
// and only then answers, so the reply means all of it (PLAN.md section 2.3.1).
// A device may revoke another and may revoke itself, which is what unlinking
// is.
//
// Including the last one (plan/protocol.md, "Devices and invites"). Basalt
// refused that from a device, because what it left was a vault only the
// recovery key opened. Trew has no key a device holds and the server cannot
// reissue, so the way back from an empty device list is `trew invite` on the
// server, and a refusal would protect nothing.
//
// The work is Server.revoke, shared with the control socket, so the rules are
// one set whichever end asks.
func (s *Session) handleRevoke(m wire.In) error {
	if !store.ValidDeviceID(m.DeviceID) {
		return s.reject(wire.CodeBadName, fmt.Errorf(
			"device id is %d bytes and must be base64url of at most %d",
			len(m.DeviceID), store.MaxDeviceIDLen))
	}
	rev, err := s.srv.revoke(s.vaultID, m.DeviceID, s)
	switch {
	case err == nil:
	case errors.Is(err, errSessionRevoked):
		return s.fatal(wire.CodeAuth, err)
	case errors.Is(err, store.ErrUnknownDevice):
		return s.reject(wire.CodeNoDevice, err)
	default:
		s.srv.log.Error("revoke failed", "vault", s.vaultID, "deviceId", m.DeviceID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the device could not be revoked: "+err.Error()))
	}

	self := m.DeviceID == s.deviceID
	s.srv.log.Info("device revoked", "vault", s.vaultID, "deviceId", m.DeviceID,
		"by", s.deviceID, "closed", rev.Closed, "invitesCancelled", rev.InvitesCancelled, "self", self)
	if err := s.writeJSON(wire.Revoked{
		Res: "revoked", ID: s.reqID, DeviceID: m.DeviceID, Self: self,
	}); err != nil {
		return err
	}
	if self {
		// A device that revoked itself is revoked, and a revoked device does
		// not stay connected. It left the fan-out with the delete; the reply
		// has already gone, and Handle drains and closes behind this.
		return errRevokedSelf
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * invite
 * ---------------------------------------------------------------- */

// handleInvite mints a single-use invite and answers with its id, its token and
// when it expires (plan/protocol.md, "Devices and invites"). The token is the
// whole credential: it appears in this reply, to the device that asked, and
// nowhere else, and the server keeps only its digest. The device formats it
// into an invite string with its own server URL and vault.
//
// The ttl defaults to DefaultInviteTTL and is capped at MaxInviteTTL rather
// than refused above it, because the reply says when the invite actually
// expires and a client asking for longer has nothing to do differently. A
// negative ttl is refused: an invite cannot expire before it is issued. The
// operator can mint a longer one, or one that never expires, with `trew
// invite` on the server, where the choice is deliberate.
//
// The invite is recorded as this device's, so revoking the device cancels it
// too: an invite minted on a laptop before the laptop was stolen is exactly
// the authority the revoke is for (see store.RevokeDevice).
func (s *Session) handleInvite(m wire.In) error {
	if m.TTLMs < 0 {
		return s.reject(wire.CodeBadEntry, fmt.Errorf("ttlMs is %d, and an invite cannot expire before it is issued", m.TTLMs))
	}
	if err := store.CheckName("invite", m.Label, store.MaxDeviceLen); err != nil {
		return s.reject(wire.CodeBadName, err)
	}
	// Clamp milliseconds before converting to nanoseconds: a large positive
	// wire value can overflow time.Duration and become a past expiry.
	ttlMs := m.TTLMs
	if ttlMs == 0 {
		ttlMs = DefaultInviteTTL.Milliseconds()
	}
	if ttlMs > MaxInviteTTL.Milliseconds() {
		ttlMs = MaxInviteTTL.Milliseconds()
	}
	now := s.srv.now()
	expiresAt := now.Add(time.Duration(ttlMs) * time.Millisecond).UnixMilli()
	var inv store.NewInvite
	if err := s.authorizedMutation(func() error {
		var err error
		inv, err = s.srv.st.CreateInvite(s.vaultID, m.Label, s.deviceID, &expiresAt, now.UnixMilli())
		return err
	}); err != nil {
		if errors.Is(err, errSessionRevoked) {
			return s.fatal(wire.CodeAuth, err)
		}
		if errors.Is(err, store.ErrBadEntry) || errors.Is(err, store.ErrUnknownVault) {
			return s.reject(wire.CodeBadEntry, err)
		}
		s.srv.log.Error("invite failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the invite could not be stored: "+err.Error()))
	}
	s.srv.log.Info("invite issued", "vault", s.vaultID, "device", s.deviceID,
		"invite", inv.ID, "expiresAt", expiresAt)
	return s.writeJSON(wire.Invited{
		Res: "invited", ID: s.reqID,
		Invite: inv.ID, Token: store.EncodeToken(inv.Token), ExpiresAt: inv.ExpiresAt,
	})
}

// handleUninvite cancels an invite that is still outstanding, by the id a
// listing shows, so a string somebody is holding stops working before it
// expires.
//
// `nodevice` would be the wrong code and there is deliberately no `noinvite`:
// an unknown, expired, already redeemed or malformed id are one refusal,
// `badentry`, saying which of the four it was to nobody. Saying more would tell
// somebody guessing ids that they had found a real one, and after a redemption
// it would confirm that this vault had an invite out a moment ago. The message
// says what to do instead, which is to look at the device list.
func (s *Session) handleUninvite(m wire.In) error {
	now := s.srv.now().UnixMilli()
	if err := s.authorizedMutation(func() error {
		return s.srv.st.CancelInvite(s.vaultID, m.Invite, now)
	}); err != nil {
		if errors.Is(err, errSessionRevoked) {
			return s.fatal(wire.CodeAuth, err)
		}
		if errors.Is(err, store.ErrNoInvite) {
			return s.reject(wire.CodeBadEntry, errNoSuchInvite)
		}
		s.srv.log.Error("uninvite failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the invite could not be cancelled: "+err.Error()))
	}
	s.srv.log.Info("invite cancelled", "vault", s.vaultID, "device", s.deviceID, "invite", m.Invite)
	return s.writeJSON(wire.Uninvited{Res: "uninvited", ID: s.reqID, Invite: m.Invite})
}

// errNoSuchInvite is the one answer to cancelling an invite that cannot be
// cancelled, whichever reason it is; see handleUninvite.
var errNoSuchInvite = errors.New(
	"this vault has no outstanding invite under that id: it may have expired, " +
		"or been redeemed already, in which case it is a device row now; check the device list")
