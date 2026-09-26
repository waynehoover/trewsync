package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/frame"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

const testVault = "v1"

type rig struct {
	t    *testing.T
	srv  *Server
	st   *store.Store
	http *httptest.Server
	url  string
	// dir is the data directory the store is in.
	dir string

	// devices memoises the row each named client syncs as. A client is a
	// registered row plus the token its hash was made from, and two clients
	// dialled under one name are deliberately one device with two
	// connections: several tests want more peers than they want devices, and
	// a device with two sockets is a thing that happens anyway.
	devMu   sync.Mutex
	devices map[string]string // client name -> device id
}

// newRig is a server on a fresh store with the test vault in it.
func newRig(t *testing.T) *rig {
	t.Helper()
	dir := t.TempDir()
	dbPath, chunkDir := store.DataDir(dir)
	st, err := store.Open(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// Discard by default: a failing test prints what it asserts, and the
	// server's own log would bury it.
	var out io.Writer = io.Discard
	if os.Getenv("TREW_TEST_LOG") != "" {
		out = os.Stderr
	}
	log := slog.New(slog.NewTextHandler(out, nil))
	srv := New(st, log)

	// A device row and an invite both need the vault to exist, which is the
	// state `serve` leaves every vault it serves in.
	if err := st.EnsureVault(testVault, 1); err != nil {
		t.Fatalf("creating the test vault: %v", err)
	}

	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		srv.Handle(r.Context(), conn, r.RemoteAddr)
	}))

	r := &rig{t: t, srv: srv, st: st, http: hs, dir: dir,
		url: "ws" + strings.TrimPrefix(hs.URL, "http"), devices: map[string]string{}}
	// Registered after the store's close, so it runs first: every session has
	// ended before the store closes and t.TempDir removes the directory.
	t.Cleanup(r.stop)
	return r
}

// rigStopWait bounds how long stop waits for the sessions: Shutdown's own
// deadline, then as long again for what it killed to unwind. Every client has
// hung up by the time the cleanup runs, so a session still going after this is
// held by a test that failed before releasing it, and waiting on it for ever
// would turn that failure into a hang with nothing reported.
const rigStopWait = 5 * time.Second

// stop shuts the rig's server down the way serve does: the listener, then the
// sessions, and only then, in the cleanup before this one, the store.
//
// Closing the listener alone is not a stop. httptest's Close, like
// http.Server.Shutdown, waits for ordinary requests, and a WebSocket is a
// hijacked connection it no longer counts, so a session could outlive the rig.
// One did: a put refused for a repeated body was still inside readBodies,
// closing the writer that was placing its first body, when the store closed
// and t.TempDir began removing the shard that body was landing in, and the
// removal failed with "directory not empty" (TestARepeatedBodyIsRefused under
// a loaded -race run). Server.Shutdown is what waits for a session, so the rig
// stops with it, as serve does.
//
// Safe to call twice, and a test may stop the server itself first.
func (r *rig) stop() {
	r.http.Close()
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), rigStopWait)
		defer cancel()
		done <- r.srv.Shutdown(ctx)
	}()
	select {
	case err := <-done:
		if err != nil {
			r.t.Errorf("stopping the rig's server: %v", err)
		}
	case <-time.After(2 * rigStopWait):
		r.t.Errorf("%d sessions still running %s after the rig began stopping", r.srv.Sessions(), 2*rigStopWait)
	}
}

// deviceToken is the 32-byte credential the rig gives the device called name:
// the same bytes for the same name every time, and its wire spelling, which is
// what a hello carries.
func deviceToken(name string) (raw []byte, onWire string) {
	sum := sha256.Sum256([]byte("device-token-for-" + name))
	return sum[:], store.EncodeToken(sum[:])
}

// deviceKey is the wire spelling of the named device's token.
func deviceKey(name string) string {
	_, key := deviceToken(name)
	return key
}

// hashOf is what the store keeps for a device token given in its wire
// spelling. A string that is not one is hashed as it stands, which is what a
// hello offering it is compared as, so it matches nothing.
func hashOf(key string) string {
	if raw, ok := store.DecodeToken(key, store.DeviceTokenBytes); ok {
		return store.HashToken(raw)
	}
	return store.HashToken([]byte(key))
}

// deviceID is a base64url id for a client name, since a device id is bounded
// and base64url and a test name is neither.
func deviceID(name string) string {
	id := make([]byte, 0, len(name))
	for i := 0; i < len(name) && i < store.MaxDeviceIDLen-2; i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
			id = append(id, c)
		default:
			id = append(id, '_')
		}
	}
	return "d-" + string(id)
}

// device registers the row the named client syncs as, once, and returns its id
// and the wire spelling of its token.
//
// Seeded straight through the store rather than over the wire, the way r.seed
// puts an entry there: what a test wants is a device that exists, and making
// every one of them redeem an invite first would put the redemption path
// inside every unrelated test. The tests about redemption redeem.
func (r *rig) device(name string) (id, key string) {
	r.t.Helper()
	r.devMu.Lock()
	defer r.devMu.Unlock()
	raw, key := deviceToken(name)
	id = deviceID(name)
	if _, done := r.devices[name]; done {
		return id, key
	}
	err := r.st.RegisterDevice(testVault, id, name, store.HashToken(raw), 1)
	if err != nil && !errors.Is(err, store.ErrDeviceExists) {
		r.t.Fatalf("registering device %q: %v", name, err)
	}
	r.devices[name] = id
	return id, key
}

// invite mints an invite on the test vault through the store, as `trewd
// invite` on the server would, living ttl from the rig's clock.
func (r *rig) invite(ttl time.Duration) store.NewInvite {
	r.t.Helper()
	now := r.srv.now()
	expires := now.Add(ttl).UnixMilli()
	inv, err := r.st.CreateInvite(testVault, "", "", &expires, now.UnixMilli())
	if err != nil {
		r.t.Fatalf("minting an invite: %v", err)
	}
	return inv
}

// redeemHello is the hello a device joining with an invite sends: the invite
// token, and the device id and token it has chosen and will connect with.
func redeemHello(invite []byte, name string) wire.In {
	return wire.In{
		Op: "hello", Vault: testVault, Device: name,
		Invite: store.EncodeToken(invite), DeviceID: deviceID(name), Token: deviceKey(name),
	}
}

// redeem joins the named device with the invite over this connection, which
// then closes, as the protocol says it does.
func (c *client) redeem(invite []byte) wire.Redeemed {
	c.t.Helper()
	c.sendJSON(redeemHello(invite, c.name))
	var got wire.Redeemed
	c.recvInto("redeemed", &got)
	if got.DeviceID != deviceID(c.name) {
		c.t.Fatalf("%s: redeemed names device %q, not the one that asked", c.name, got.DeviceID)
	}
	return got
}

// incompressible is n bytes that deflate will not shrink, the same n bytes for
// the same seed.
//
// What a test that is about bytes on the wire has to carry. The fetch path
// deflates a body whenever that is shorter, so a megabyte of one repeated byte
// crosses the wire as a kilobyte, and a test built to fill the send queue with
// it fills nothing. Basalt's harness learned the same thing about dedup:
// generators cycling a few words faked 80% of it and hid the defects they were
// meant to find.
func incompressible(seed, n int) []byte {
	b := make([]byte, n)
	rand.New(rand.NewSource(int64(seed))).Read(b)
	return b
}

// seed commits an entry straight through the store, as though another device
// had pushed it before this test's client connected.
func (r *rig) seed(path string, bodies ...string) store.Entry {
	r.t.Helper()
	names := make([]string, 0, len(bodies))
	size := 0
	for _, b := range bodies {
		n := chunks.Name([]byte(b))
		if err := r.st.Chunks().Put(testVault, n, []byte(b)); err != nil {
			r.t.Fatalf("seed chunk: %v", err)
		}
		names = append(names, n)
		size += len(b)
	}
	if err := r.st.EnsureVault(testVault, 1); err != nil {
		r.t.Fatalf("ensure vault: %v", err)
	}
	e := store.Entry{Path: path, Size: int64(size), MTime: 1, Device: "seed", Chunks: names}
	uid, err := r.st.AppendEntry(testVault, e)
	if err != nil {
		r.t.Fatalf("seed append: %v", err)
	}
	e.UID = uid
	return e
}

/* ---------------------------------------------------------------- *
 * A protocol client, written to the doc rather than to the server.
 * ---------------------------------------------------------------- */

// client demultiplexes the connection the way a real one has to.
//
// A batch can arrive at any moment, because another device can commit while
// this one is waiting on a reply. So reads are split: batches queue up in
// batches, and everything else is the answer to the request in flight. A test
// client that assumed the next frame was its reply would be testing a client
// nobody can write.
//
// Every request it sends gets a fresh id, the ids of requests still awaiting
// their final reply are kept in order in pending, and every reply is checked
// against the oldest: a reply carrying an id the client did not issue, or none
// where one is owed, is a protocol violation and fails the test.
type client struct {
	t       *testing.T
	rig     *rig
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	name    string
	batches []wire.Batch
	nextID  int64
	pending []int64
}

func (r *rig) dial(name string) *client { return r.dialWith(name, nil) }

// dialWith is dial with the library's options exposed, for the tests that need
// to see a ping arrive or to act before the pong goes back.
func (r *rig) dialWith(name string, opts *websocket.DialOptions) *client {
	r.t.Helper()
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 20*time.Second)
	conn, _, err := websocket.Dial(dialCtx, r.url, opts)
	dialCancel()
	if err != nil {
		r.t.Fatalf("dial: %v", err)
	}
	// The connection's own context bounds no single operation: each read and
	// write takes its own deadline below (opTimeout), which is what catches a
	// server that stopped answering. It used to be the dial's 20 seconds,
	// kept for the whole connection, so every test's total work had to fit
	// in them however steadily it progressed. TestHistoryPaginatesBackwards
	// makes 503 durable puts, three fsyncs each, in 6 to 8 s on an idle
	// disk; six copies at once, as overlapping suites load it, all failed at
	// 21 s while still committing. It ends when the test does, or at the
	// test binary's own deadline, for the few tests that use it directly.
	ctx, cancel := context.WithCancel(context.Background())
	if deadline, ok := r.t.Deadline(); ok {
		cancel()
		ctx, cancel = context.WithDeadline(context.Background(), deadline)
	}
	conn.SetReadLimit(ReadLimit)
	c := &client{t: r.t, rig: r, conn: conn, ctx: ctx, cancel: cancel, name: name}
	r.t.Cleanup(func() { conn.CloseNow(); cancel() })
	return c
}

// sendJSON writes one frame. A wire.In with no id gets the next one when the
// op expects a reply; a test that wants to send a particular id, or none, sets
// ID itself and uses sendRaw.
func (c *client) sendJSON(v any) {
	c.t.Helper()
	if in, ok := v.(wire.In); ok {
		if in.Op != "ping" && in.ID == 0 {
			c.nextID++
			in.ID = c.nextID
		}
		if in.Proto == 0 && in.Op == "hello" {
			in.Proto = wire.Proto
		}
		if in.ID != 0 {
			c.pending = append(c.pending, in.ID)
		}
		v = in
	}
	c.sendRaw(v)
}

// sendRaw writes a frame exactly as given, tracking nothing.
func (c *client) sendRaw(v any) {
	c.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		c.t.Fatalf("%s: marshal: %v", c.name, err)
	}
	if err := c.write(websocket.MessageText, b); err != nil {
		c.t.Fatalf("%s: write: %v", c.name, err)
	}
}

// check is the client-side half of request ids, run on every reply. It is the
// rule docs/protocol.md gives a client: a reply whose id it does not recognise
// ends the session, an error with no id is the reason the connection is about
// to close. Here both fail the test instead.
func (c *client) check(data []byte) {
	c.t.Helper()
	var probe struct {
		Res       string `json:"res"`
		ID        *int64 `json:"id"`
		Retryable *bool  `json:"retryable"`
	}
	if err := json.Unmarshal(data, &probe); err != nil || probe.Res == "" {
		return
	}
	switch probe.Res {
	case "pong":
		if probe.ID != nil {
			c.t.Fatalf("%s: a pong carried an id: %s", c.name, data)
		}
		return
	case "err":
		// Every error carries the verdict, including the ones sent before the
		// handshake got far enough to say anything else.
		if probe.Retryable == nil {
			c.t.Fatalf("%s: an error carries no retryable: %s", c.name, data)
		}
		if probe.ID == nil {
			return // unsolicited: the reason the connection is closing
		}
	case "ready":
		if probe.ID == nil {
			c.t.Fatalf("%s: ready carries no id: %s", c.name, data)
		}
	default:
		if probe.ID == nil {
			c.t.Fatalf("%s: reply %q carries no id: %s", c.name, probe.Res, data)
		}
	}
	if len(c.pending) == 0 {
		c.t.Fatalf("%s: reply carries id %d with no request outstanding: %s", c.name, *probe.ID, data)
	}
	if *probe.ID != c.pending[0] {
		c.t.Fatalf("%s: reply carries id %d, the oldest request in flight is %d: %s",
			c.name, *probe.ID, c.pending[0], data)
	}
	// `want` is answered again by the ack, so its request stays in flight.
	if probe.Res != "want" {
		c.pending = c.pending[1:]
	}
}

// sendBinary sends one chunk body as a protocol 1 body frame: the raw marker
// and the bytes (plan/protocol.md, "Chunk bodies"). A client may deflate or
// not, and raw is the one that tests every path of the server's decoder
// except inflation, which the frame tests exercise by sending frames exactly.
func (c *client) sendBinary(b []byte) {
	c.t.Helper()
	c.sendFrame(append([]byte{frame.MarkerRaw}, b...))
}

// sendFrame sends a binary frame exactly as given, marker and all, for the
// tests that are about what a frame may be.
func (c *client) sendFrame(b []byte) {
	c.t.Helper()
	if err := c.write(websocket.MessageBinary, b); err != nil {
		c.t.Fatalf("%s: write body: %v", c.name, err)
	}
}

// opTimeout bounds one read or one write of the harness's client, so a server
// that stops answering fails the test at the operation it stopped at, however
// long the test has already run.
const opTimeout = 10 * time.Second

func (c *client) read() (websocket.MessageType, []byte, error) {
	ctx, cancel := context.WithTimeout(c.ctx, opTimeout)
	defer cancel()
	return c.conn.Read(ctx)
}

func (c *client) write(typ websocket.MessageType, b []byte) error {
	ctx, cancel := context.WithTimeout(c.ctx, opTimeout)
	defer cancel()
	return c.conn.Write(ctx, typ, b)
}

// pump reads exactly one text frame. A batch is queued and nil is returned;
// anything else is a reply and is returned as-is.
//
// One frame per call is the point. A pump that kept reading until it found a
// reply would block forever on a connection whose only pending frame is a
// batch, which is most of them.
func (c *client) pump() []byte {
	c.t.Helper()
	typ, data, err := c.read()
	if err != nil {
		c.t.Fatalf("%s: read: %v", c.name, err)
	}
	if typ != websocket.MessageText {
		c.t.Fatalf("%s: expected a text frame, got binary (%d bytes)", c.name, len(data))
	}
	var probe struct {
		Op string `json:"op"`
	}
	_ = json.Unmarshal(data, &probe)
	if probe.Op != "batch" {
		c.check(data)
		return data
	}
	var b wire.Batch
	if err := json.Unmarshal(data, &b); err != nil {
		c.t.Fatalf("%s: batch: %v", c.name, err)
	}
	c.batches = append(c.batches, b)
	return nil
}

// recvRaw returns the next text frame exactly as it came off the wire, without
// demultiplexing. Used where the test is about the JSON itself, since decoding
// into a struct is what hides the difference between [] and null.
func (c *client) recvRaw() string {
	c.t.Helper()
	typ, data, err := c.read()
	if err != nil {
		c.t.Fatalf("%s: read: %v", c.name, err)
	}
	if typ != websocket.MessageText {
		c.t.Fatalf("%s: expected a text frame, got binary (%d bytes)", c.name, len(data))
	}
	c.check(data)
	return string(data)
}

// recvFrame returns the next reply, queueing any batches that arrive first.
func (c *client) recvFrame() []byte {
	c.t.Helper()
	for {
		if data := c.pump(); data != nil {
			return data
		}
	}
}

// recv reads the next reply as a generic map, so a test can assert on `res`
// without knowing which type to expect.
func (c *client) recv() map[string]any {
	c.t.Helper()
	data := c.recvFrame()
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatalf("%s: parse %q: %v", c.name, data, err)
	}
	return m
}

// recvBinary reads one body frame and returns the raw chunk it carries,
// decoded the way a client decodes it, at the transport boundary. A frame the
// decoder refuses fails the test: the server sent something no client can
// read.
func (c *client) recvBinary() []byte {
	c.t.Helper()
	raw, err := frame.Decode(c.recvFrameBytes(), store.ChunkMax)
	if err != nil {
		c.t.Fatalf("%s: the server sent a body frame no client can decode: %v", c.name, err)
	}
	return raw
}

// recvFrameBytes reads one binary frame and returns it undecoded, for the tests
// that are about how the server framed it.
func (c *client) recvFrameBytes() []byte {
	c.t.Helper()
	typ, data, err := c.read()
	if err != nil {
		c.t.Fatalf("%s: read body: %v", c.name, err)
	}
	if typ != websocket.MessageBinary {
		c.t.Fatalf("%s: expected a body, got text %q", c.name, data)
	}
	return data
}

// fetch asks for the named chunks and returns their bodies in the order asked,
// consuming the `bodies` header sent first and checking it promises exactly as
// many frames as were asked for.
func (c *client) fetch(names ...string) [][]byte {
	c.t.Helper()
	c.sendJSON(wire.In{Op: "fetch", Chunks: names})
	c.expectBodies(len(names))
	out := make([][]byte, 0, len(names))
	for range names {
		out = append(out, c.recvBinary())
	}
	return out
}

// expectBodies reads the `bodies` header a fetch is answered with.
func (c *client) expectBodies(n int) {
	c.t.Helper()
	var b wire.Bodies
	c.recvInto("bodies", &b)
	if b.Count != n {
		c.t.Fatalf("%s: bodies header promises %d frames, %d were asked for", c.name, b.Count, n)
	}
}

// recvInto reads a text frame and decodes it into v, after checking that its
// res or op is what the caller expected.
func (c *client) recvInto(want string, v any) {
	c.t.Helper()
	data := c.recvFrame()
	var probe struct {
		Res  string `json:"res"`
		Op   string `json:"op"`
		Code string `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(data, &probe)
	got := probe.Res
	if got == "" {
		got = probe.Op
	}
	if got != want {
		c.t.Fatalf("%s: wanted %q, got %q (code %q, msg %q)", c.name, want, got, probe.Code, probe.Msg)
	}
	if v != nil {
		if err := json.Unmarshal(data, v); err != nil {
			c.t.Fatalf("%s: decode %q: %v", c.name, data, err)
		}
	}
}

// expectErr reads a frame, requires it to be an error with the given code, and
// returns the human message so a test can assert it says something useful.
func (c *client) expectErr(code string) string {
	c.t.Helper()
	m := c.recv()
	if m["res"] != "err" {
		c.t.Fatalf("%s: wanted an error, got %v", c.name, m)
	}
	if m["code"] != code {
		c.t.Fatalf("%s: wanted code %q, got %q (%v)", c.name, code, m["code"], m["msg"])
	}
	msg, _ := m["msg"].(string)
	if strings.TrimSpace(msg) == "" {
		// Every rejection carries a code for the client and a message for the
		// human. One without the other is how a silent failure starts.
		c.t.Fatalf("%s: error %q carried no message", c.name, code)
	}
	return msg
}

// deviceHello builds a hello for this client's own registered device, which is
// what a hello has to be to sync.
//
// Proto is left zero so that sendJSON fills in the client's own, and the id
// likewise.
func (c *client) deviceHello(cursor int64) wire.In {
	c.t.Helper()
	id, key := c.rig.device(c.name)
	return wire.In{
		Op: "hello", Vault: testVault, Token: key, DeviceID: id, Device: c.name, Cursor: cursor,
	}
}

// hello performs the handshake and drains catch-up, returning the ready frame
// and every entry the backlog delivered.
func (c *client) hello(cursor int64) (wire.Ready, []store.Entry) {
	c.t.Helper()
	c.sendJSON(c.deviceHello(cursor))

	var ready wire.Ready
	c.recvInto("ready", &ready)

	var got []store.Entry
	for {
		typ, data, err := c.read()
		if err != nil {
			c.t.Fatalf("%s: catch-up: %v", c.name, err)
		}
		if typ != websocket.MessageText {
			c.t.Fatalf("%s: body frame during catch-up", c.name)
		}
		var probe struct {
			Op string `json:"op"`
		}
		_ = json.Unmarshal(data, &probe)
		switch probe.Op {
		case "batch":
			var b wire.Batch
			if err := json.Unmarshal(data, &b); err != nil {
				c.t.Fatalf("%s: batch: %v", c.name, err)
			}
			// The client-side continuity check, performed for real rather than
			// asserted about. A gap here means a file was skipped.
			if b.From != cursor+1 {
				c.t.Fatalf("%s: batch from %d, cursor %d: gap", c.name, b.From, cursor)
			}
			got = append(got, b.Entries...)
			cursor = b.To
		case "caught-up":
			var cu wire.CaughtUp
			if err := json.Unmarshal(data, &cu); err != nil {
				c.t.Fatalf("%s: caught-up: %v", c.name, err)
			}
			if cu.Cursor != cursor {
				c.t.Fatalf("%s: caught-up at %d, batches reached %d", c.name, cu.Cursor, cursor)
			}
			return ready, got
		default:
			c.t.Fatalf("%s: unexpected frame during catch-up: %s", c.name, data)
		}
	}
}

// nextBatch returns the next batch, reading more frames if none are queued.
func (c *client) nextBatch() wire.Batch {
	c.t.Helper()
	for len(c.batches) == 0 {
		// A reply here is one nobody asked for, which is worth failing on
		// rather than skipping past.
		if data := c.pump(); data != nil {
			c.t.Fatalf("%s: wanted a batch, got %s", c.name, data)
		}
	}
	b := c.batches[0]
	c.batches = c.batches[1:]
	return b
}

// drainBatches returns everything queued so far without reading.
func (c *client) drainBatches() []wire.Batch {
	out := c.batches
	c.batches = nil
	return out
}

// put runs a whole put and returns the assigned uid. bodies are the chunks,
// named by their hash as a client names them.
func (c *client) put(path string, bodies ...string) int64 {
	c.t.Helper()
	names, size := chunkNames(bodies)
	c.sendJSON(wire.In{
		Op: "put", Path: path, Chunks: names, Base: c.head(path),
		Meta: wire.PutMeta{Size: size, MTime: 5},
	})

	m := c.recv()
	switch m["res"] {
	case "have":
		return int64(m["uid"].(float64))
	case "want":
		wanted := toStrings(c.t, m["chunks"])
		for _, n := range wanted {
			c.sendBinary([]byte(bodyFor(c.t, bodies, n)))
		}
		var ack wire.Ack
		c.recvInto("ack", &ack)
		return ack.UID
	default:
		c.t.Fatalf("%s: put %s: unexpected reply %v", c.name, path, m)
		return 0
	}
}

// head prepares a current-version precondition for ordinary fixture writes.
// Stale-write tests use explicit bases on raw put/putmany messages instead.
func (c *client) head(path string) int64 {
	c.t.Helper()
	uid, err := c.rig.st.CurrentUID(testVault, path)
	if err != nil {
		c.t.Fatal(err)
	}
	return uid
}

func chunkNames(bodies []string) ([]string, int64) {
	names := make([]string, 0, len(bodies))
	var size int64
	for _, b := range bodies {
		names = append(names, chunks.Name([]byte(b)))
		size += int64(len(b))
	}
	return names, size
}

func bodyFor(t *testing.T, bodies []string, name string) string {
	t.Helper()
	for _, b := range bodies {
		if chunks.Name([]byte(b)) == name {
			return b
		}
	}
	t.Fatalf("server wanted %s, which is not one of %v", name, bodies)
	return ""
}

func toStrings(t *testing.T, v any) []string {
	t.Helper()
	raw, ok := v.([]any)
	if !ok {
		t.Fatalf("expected a list of chunk names, got %T (%v)", v, v)
	}
	out := make([]string, len(raw))
	for i, e := range raw {
		s, ok := e.(string)
		if !ok {
			t.Fatalf("chunk name %d is %T", i, e)
		}
		out[i] = s
	}
	return out
}

// closed reports whether the server has hung up, which is how a fatal refusal
// is distinguished from one the session survives.
// closed reports whether the server hung up. It must be the last thing a test
// does with this client: it waits on a read, and cancelling a read is what
// closes a websocket, so a session that was alive is not alive afterwards. Where
// the question is "did this survive", send a ping and expect a pong instead.
func (c *client) closed() bool {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(c.ctx, 3*time.Second)
	defer cancel()
	for {
		_, _, err := c.conn.Read(ctx)
		if err == nil {
			// Something still queued. Only the hang-up settles it.
			continue
		}
		// A read that failed because this side stopped waiting is not a
		// hang-up. Reporting it as one made every assertion of "the session
		// closed" pass whether it did or not, including for a server that
		// stayed open and idle.
		return ctx.Err() == nil
	}
}

// onlyPeer is the one session joined to the test vault, for tests that drive
// the queue from the server side. It waits, because a client's hello has
// returned before the server has necessarily finished joining it.
func (r *rig) onlyPeer() *Session {
	r.t.Helper()
	var peer *Session
	waitFor(r.t, "the session to join", func() bool {
		r.srv.hub.mu.RLock()
		defer r.srv.hub.mu.RUnlock()
		m := r.srv.hub.byVault[testVault]
		if len(m) != 1 {
			return false
		}
		for s := range m {
			peer = s
		}
		return true
	})
	return peer
}

func (r *rig) mustStats() store.Stats {
	r.t.Helper()
	st, err := r.st.Stats(testVault)
	if err != nil {
		r.t.Fatalf("stats: %v", err)
	}
	return st
}

func (r *rig) mustVerify() int {
	r.t.Helper()
	faultsRep, err := r.st.Verify(true)
	faults, checked := faultsRep.Faults, faultsRep.Chunks
	if err != nil {
		r.t.Fatalf("verify: %v", err)
	}
	if len(faults) != 0 {
		r.t.Fatalf("%d unserveable entries: %v", len(faults), faults[0])
	}
	return checked
}

var _ = fmt.Sprintf

// waitFor polls until cond holds, so a test that depends on the server noticing
// something does not have to guess how long that takes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// putAsync runs a put and discards the uid, tolerating the batches that arrive
// from other devices while it waits. Used where several clients push at once.
func (c *client) putAsync(path string, bodies ...string) {
	c.t.Helper()
	c.put(path, bodies...)
}
