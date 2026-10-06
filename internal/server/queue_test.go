package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/frame"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// The send queue, the keepalive that has to live alongside it, and the
// handover from catch-up to live delivery. Review findings S1, S2, S8 and S10.

// seedBodies puts n one-mebibyte bodies in the vault and returns their names,
// so a fetch can be made to carry several times the send budget. They are
// incompressible, so each one crosses the wire as a mebibyte.
func seedBodies(t *testing.T, r *rig, n int) []string {
	t.Helper()
	names := make([]string, n)
	for i := range names {
		b := incompressible(i+1, 1<<20)
		names[i] = chunks.Name(b)
		if err := r.st.Chunks().Put(testVault, names[i], b); err != nil {
			t.Fatalf("seed body: %v", err)
		}
	}
	return names
}

// readBodiesSlowly reads n binary frames, pausing after each, the way a client
// on a slow link would, and fails on anything else.
func readBodiesSlowly(t *testing.T, cl *client, names []string, pause time.Duration) {
	t.Helper()
	cl.expectBodies(len(names))
	for i, want := range names {
		typ, data, err := cl.read()
		if err != nil {
			t.Fatalf("cut off after %d of %d bodies: %v", i, len(names), err)
		}
		if typ != websocket.MessageBinary {
			t.Fatalf("body %d: got a text frame instead: %s", i, data)
		}
		raw, err := frame.Decode(data, store.ChunkMax)
		if err != nil {
			t.Fatalf("body %d is not a frame a client can decode: %v", i, err)
		}
		if got := chunks.Name(raw); got != want {
			t.Fatalf("body %d is %s, want %s", i, got, want)
		}
		time.Sleep(pause)
	}
}

// S1: a ping that reaches the client just ahead of a request must not count
// against it when serving that request keeps the session out of its read for
// longer than PongWait.
//
// The sequence is ordinary. The server pings an idle session; at the same
// moment the client asks for a large fetch; the client's pong follows its
// request onto the wire. The server reads the request first and spends the
// next second sending bodies, during which nothing reads the pong, so the ping
// times out. Skipping pings while the session is sending does not cover this,
// because the ping was sent while it was reading. What covers it is treating a
// timeout the session was not reading for as no verdict.
//
// The client's ping hook writes the fetch before the library answers the ping,
// which puts the request ahead of the pong exactly as described.
func TestS1APingAnsweredBehindARequestIsNotHeldAgainstTheClient(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = 50 * time.Millisecond
	r.srv.pongWait = 400 * time.Millisecond
	// 32 MiB at 40 ms per body is over a second of sending, most of it blocked
	// on the byte budget, and all of it longer than the pong window.
	names := seedBodies(t, r, 32)

	var cl *client
	var armed atomic.Bool
	var fetched atomic.Bool
	cl = r.dialWith("slow-but-alive", &websocket.DialOptions{
		OnPingReceived: func(ctx context.Context, payload []byte) bool {
			// Runs on the goroutine that called Read, before the pong is
			// written. Armed only after the handshake so a ping during hello
			// does not start the fetch early.
			if armed.Load() && fetched.CompareAndSwap(false, true) {
				cl.sendJSON(wire.In{Op: "fetch", Chunks: names})
			}
			return true
		},
	})
	cl.hello(0)
	armed.Store(true)

	readBodiesSlowly(t, cl, names, 40*time.Millisecond)
	if !fetched.Load() {
		t.Fatal("no ping arrived before the bodies did, so the sequence under test never happened")
	}

	// Still there, and the keepalive is still running against a session that is
	// back in its read.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// S1: no ping goes out behind frames the client has not read yet.
//
// A ping is a frame like any other and lands behind whatever is queued. When
// the queue holds the tail of a fetch, the client reaches the ping only after
// reading all of it, which on a slow link is longer than PongWait however
// promptly it then answers. Skipping pings while the session is sending misses
// this too: the session has finished sending and is back in its read, with
// eight mebibytes still queued behind it.
//
// Asserted at the decision rather than by waiting for the symptom, because the
// symptom depends on how much the kernel buffers, which differs by platform.
func TestS1NoPingIsSentWhileFramesAreStillQueued(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = 20 * time.Millisecond
	r.srv.pongWait = 5 * time.Second // never the reason for a failure here
	names := seedBodies(t, r, 24)

	cl := r.dial("slow-link")
	cl.hello(0)
	peer := r.onlyPeer()

	var pings, pingsBehindData atomic.Int64
	hook := func() {
		pings.Add(1)
		if peer.inflight.Load() > 0 {
			pingsBehindData.Add(1)
		}
	}
	r.srv.beforePing.Store(&hook)

	cl.sendJSON(wire.In{Op: "fetch", Chunks: names})
	// 60 ms per body: the last eight are queued for half a second after the
	// session has enqueued them and returned to its read.
	readBodiesSlowly(t, cl, names, 60*time.Millisecond)

	// Idle again and answering, so pings resume once the queue is empty.
	waitFor(t, "a ping to be sent once the queue is empty", func() bool { return pings.Load() > 0 })
	if n := pingsBehindData.Load(); n != 0 {
		t.Fatalf("%d pings were sent with frames still queued ahead of them", n)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// S1: leaving a sending session alone is only safe because something else
// bounds it. A peer that stops reading in the middle of a fetch is reaped by
// the write timing out, within writeWait of the socket filling.
func TestS1APeerThatStopsReadingMidFetchIsStillReaped(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = time.Hour // so only the write path can end this
	r.srv.writeWait = 300 * time.Millisecond
	names := seedBodies(t, r, 24)

	cl := r.dial("gone")
	cl.hello(0)
	if got := r.srv.hub.peerCount(testVault); got != 1 {
		t.Fatalf("%d peers after connecting, want 1", got)
	}
	// Ask for 24 MiB and read none of it. The socket fills, the write blocks,
	// and writeWait later the session is gone.
	cl.sendJSON(wire.In{Op: "fetch", Chunks: names})

	waitFor(t, "the stalled peer to be reaped", func() bool {
		return r.srv.hub.peerCount(testVault) == 0
	})
}

// throttledProxy forwards connections to target, passing what the client sends
// at rate bytes a second, an uplink, and what the server sends at full speed.
// Setting stall stops the uplink altogether, as a link that dies does, while
// the socket stays open.
func throttledProxy(t *testing.T, target string, rate int, stall *atomic.Bool) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	// Released at the end, so a stalled forwarder finds its sockets closed and
	// returns rather than outliving the test.
	t.Cleanup(func() { stall.Store(false) })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s, err := net.Dial("tcp", target)
			if err != nil {
				c.Close()
				return
			}
			t.Cleanup(func() { c.Close(); s.Close() })
			go func() { _, _ = io.Copy(c, s); c.Close() }()
			go func() {
				defer s.Close()
				buf := make([]byte, 4096)
				tick := time.Duration(float64(time.Second) * float64(len(buf)) / float64(rate))
				for {
					n, err := c.Read(buf)
					for stall.Load() {
						time.Sleep(10 * time.Millisecond)
					}
					if n > 0 {
						if _, err := s.Write(buf[:n]); err != nil {
							return
						}
						time.Sleep(tick)
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	return ln.Addr().String()
}

// uploadThrough dials the rig through a throttled proxy, says hello, puts one
// file of the given bodies and sends them, with a reader running the whole
// time, as every client has, so that each ping is answered as it arrives and
// the pong goes out behind whatever the client has already written. It returns
// the reply that ended the put, or the error that ended the connection.
func uploadThrough(t *testing.T, r *rig, addr string, bodies [][]byte) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, "ws://"+addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	conn.SetReadLimit(ReadLimit)
	cl := &client{t: t, rig: r, conn: conn, ctx: ctx, cancel: cancel, name: "phone"}
	cl.hello(0)

	names := make([]string, len(bodies))
	var size int64
	for i, b := range bodies {
		names[i] = chunks.Name(b)
		size += int64(len(b))
	}
	cl.sendJSON(wire.In{Op: "put", Path: "big.pdf", Chunks: names, Meta: wire.PutMeta{Size: size, MTime: 5}})
	cl.recvInto("want", &wire.Want{})

	replies := make(chan string, 1)
	failed := make(chan error, 1)
	go func() {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				failed <- err
				return
			}
			if !strings.Contains(string(data), `"op":"batch"`) {
				replies <- string(data)
				return
			}
		}
	}()
	for _, b := range bodies {
		if err := conn.Write(ctx, websocket.MessageBinary, append([]byte{frame.MarkerRaw}, b...)); err != nil {
			return "", err
		}
	}
	select {
	case reply := <-replies:
		return reply, nil
	case err := <-failed:
		return "", err
	}
}

// T56: a device uploading over a slow link is alive, though its pong is late.
//
// During an upload the session waits in its read for the next body, so the
// keepalive pings it, and the client's pong is written behind the bodies it
// has already handed its socket: Node's WebSocket queues it there, and so does
// coder/websocket once the frame it is writing is out. Waiting the pong out
// took the uplink as dead, though bytes were arriving the whole time: below
// about 2.2 Mbit/s a large upload was cut off a minute into every connection,
// and below about 150 kbit/s a 1 MiB body could not arrive inside one, so that
// file never uploaded. The timings are scaled down together: each body takes
// a second to cross the link, and a pong is given 300 ms.
func TestASlowUplinkUploadIsNotTakenForADeadPeer(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = 100 * time.Millisecond
	r.srv.pongWait = 300 * time.Millisecond
	var stall atomic.Bool
	addr := throttledProxy(t, strings.TrimPrefix(r.http.URL, "http://"), 256<<10, &stall)

	bodies := [][]byte{incompressible(100, 256<<10), incompressible(101, 256<<10), incompressible(102, 256<<10)}
	start := time.Now()
	reply, err := uploadThrough(t, r, addr, bodies)
	if err != nil {
		t.Fatalf("the server hung up %v into a live upload: %v", time.Since(start).Round(time.Millisecond), err)
	}
	if !strings.Contains(reply, `"res":"ack"`) {
		t.Fatalf("the upload was answered %s", reply)
	}
}

// And an upload whose bytes stop arriving is still a dead peer: what keeps a
// session alive past an unanswered ping is bytes arriving, not a read in
// progress. Here the link stops a quarter of the way into the body, the
// socket stays open, and the session is reaped within a ping or two.
func TestAnUploadThatStopsArrivingIsStillReaped(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = 100 * time.Millisecond
	r.srv.pongWait = 300 * time.Millisecond
	var stall atomic.Bool
	addr := throttledProxy(t, strings.TrimPrefix(r.http.URL, "http://"), 256<<10, &stall)
	time.AfterFunc(time.Second, func() { stall.Store(true) })

	start := time.Now()
	if reply, err := uploadThrough(t, r, addr, [][]byte{incompressible(200, 1<<20)}); err == nil {
		t.Fatalf("a stalled upload was answered %s", reply)
	}
	// Not before the link stalled, while the body was still arriving, and not
	// long after it.
	if took := time.Since(start); took < time.Second || took > 10*time.Second {
		t.Fatalf("the upload was reaped %v in, and its link stalled at 1s", took.Round(time.Millisecond))
	}
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d versions from an upload that never finished", st.Versions)
	}
}

// A commit on another device does not drop a peer that is downloading (T55).
//
// A fetch keeps its peer's send queue full on purpose: send waits for room,
// and that is the backpressure. A live batch from another device's commit goes
// through trySend instead, which drops a peer it finds no room for, and small
// chunks fill the queue's frames long before its bytes, so a fetch larger than
// the socket buffers kept it full from end to end. A save anywhere else then
// cut a phone off in the middle of its first sync, and a vault somebody kept
// typing into could keep it from ever finishing. Modelled by not reading until
// the fetch has filled the queue, the steady state of any fetch over a link
// slower than the disk, and then committing the largest batch an exchange may
// carry, every entry of it a broadcast to the phone at once.
func TestACommitElsewhereDoesNotDropAPeerMidFetch(t *testing.T) {
	r := newRig(t)
	const n = 800
	names := make([]string, n)
	bodies := make([][]byte, n)
	for i := range names {
		bodies[i] = incompressible(1000+i, 8<<10)
		names[i] = chunks.Name(bodies[i])
	}
	if err := r.st.Chunks().PutAll(testVault, bodies); err != nil {
		t.Fatal(err)
	}

	phone := r.dial("phone")
	phone.hello(0)
	peer := r.onlyPeer()
	laptop := r.dial("laptop")
	laptop.hello(0)

	phone.sendJSON(wire.In{Op: "fetch", Chunks: names})
	phone.expectBodies(n)
	waitFor(t, "the phone's queue to fill with its own fetch", func() bool {
		return peer.inflight.Load() >= SendQueueDepth
	})

	entries := make([]wire.PutEntry, 0, wire.MaxBatchEntries)
	saved := map[string]string{}
	for i := 0; i < wire.MaxBatchEntries; i++ {
		e, b := entryFor(fmt.Sprintf("saved/%d.md", i), fmt.Sprintf("a line typed on the laptop, %d", i))
		entries = append(entries, e)
		for k, v := range b {
			saved[k] = v
		}
	}
	for i, res := range laptop.putMany(entries, saved).Results {
		if res.UID == 0 {
			t.Fatalf("entry %d of the laptop's batch: %+v", i, res)
		}
	}

	got, batches := 0, 0
	for got < n || batches < wire.MaxBatchEntries {
		typ, data, err := phone.read()
		if err != nil {
			t.Fatalf("the phone was cut off after %d of %d bodies and %d of %d batches, %d peers evicted: %v",
				got, n, batches, wire.MaxBatchEntries, r.srv.Metrics().Snapshot().EvictedPeers, err)
		}
		if typ == websocket.MessageBinary {
			got++
			continue
		}
		if !strings.Contains(string(data), `"op":"batch"`) {
			t.Fatalf("an unexpected text frame mid-fetch: %s", data)
		}
		batches++
	}
	if ev := r.srv.Metrics().Snapshot().EvictedPeers; ev != 0 {
		t.Fatalf("%d peers were evicted", ev)
	}
}

// S2: the handover from catch-up to live delivery waits for room in the queue
// rather than dropping the peer.
//
// The queue is often full at that moment: the replay that just finished fills
// it as fast as the client drains it. Queueing the buffered changes and
// caught-up with a non-blocking send would drop every slow client at the end of
// every catch-up, and its reconnect would replay and hit the same wall.
// Waiting under the handover lock is not an option either, because deliver
// takes that lock, so the wait releases it and retries.
func TestS2AHandoverIntoAFullQueueWaitsForRoomInsteadOfDroppingThePeer(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "backlog one")
	r.seed("b.md", "backlog two")

	// Fill the byte budget from inside the handshake, on the session's own
	// goroutine, so the flush that follows finds no room. A late change is
	// committed too, so there is something in pending to flush.
	filler := bytes.Repeat([]byte{7}, 1<<20)
	var filled atomic.Int64
	var late store.Entry
	r.srv.afterReplay = func() {
		peer := r.onlyPeer()
		late = r.seed("late.md", "landed during the replay")
		r.srv.hub.broadcast(testVault, late, nil)
		for peer.enqueue(websocket.MessageBinary, filler) {
			filled.Add(1)
		}
	}

	cl := r.dial("slow")
	cl.sendJSON(cl.deviceHello(0))

	// Read everything: filler, batches and caught-up. The filler is skipped,
	// the batches are checked for continuity, and caught-up must name the late
	// change's uid.
	var cursor int64
	for {
		typ, data, err := cl.read()
		if err != nil {
			t.Fatalf("the peer was dropped during the handover (after %d filler frames): %v", filled.Load(), err)
		}
		if typ == websocket.MessageBinary {
			continue
		}
		var probe struct {
			Res    string `json:"res"`
			Op     string `json:"op"`
			From   int64  `json:"from"`
			To     int64  `json:"to"`
			Cursor int64  `json:"cursor"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			t.Fatalf("decode %q: %v", data, err)
		}
		if probe.Res == "ready" {
			continue
		}
		switch probe.Op {
		case "batch":
			if probe.From != cursor+1 {
				t.Fatalf("gap: batch [%d,%d] after cursor %d", probe.From, probe.To, cursor)
			}
			cursor = probe.To
			continue
		case "caught-up":
			if probe.Cursor != cursor || cursor != late.UID {
				t.Fatalf("caught-up at %d, batches reached %d, the late change is %d",
					probe.Cursor, cursor, late.UID)
			}
		default:
			t.Fatalf("unexpected frame: %s", data)
		}
		break
	}
	if filled.Load() == 0 {
		t.Fatal("the queue was never filled, so this proved nothing")
	}

	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// S8: fan-out frames are counted against the byte budget like every other
// frame, and the counter never goes below zero.
//
// trySend used to put a frame on the queue without adding its size, while the
// writer subtracted every frame it wrote. Three fan-out frames later the
// counter read minus a few hundred bytes, and from then on the byte bound was
// off: a fetch could queue until the frame limit, which is the quarter of a
// gigabyte SendQueueBytes exists to prevent.
func TestS8FanOutFramesAreCountedAndBounded(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	peer := r.onlyPeer()

	// Counted: after three fan-out frames have been read, the counter is back
	// at zero, not below it.
	pong, _ := json.Marshal(wire.Pong{Res: "pong"})
	for i := 0; i < 3; i++ {
		if !peer.trySend(websocket.MessageText, pong) {
			t.Fatalf("frame %d refused on an empty queue", i)
		}
	}
	for i := 0; i < 3; i++ {
		cl.recvInto("pong", nil)
	}
	waitFor(t, "the frames to be written", func() bool { return peer.inflight.Load() <= 0 })
	if q, f := peer.queued.Load(), peer.inflight.Load(); q != 0 || f != 0 {
		t.Fatalf("queued = %d bytes and inflight = %d frames after every frame was written, want 0 and 0", q, f)
	}

	// Bounded: the client stops reading, and mebibyte fan-out frames are
	// refused, and the peer dropped, long before the frame limit would have
	// let 256 of them through.
	big := bytes.Repeat([]byte{9}, 1<<20)
	accepted := 0
	for i := 0; i < 32; i++ {
		if !peer.trySend(websocket.MessageBinary, big) {
			break
		}
		accepted++
	}
	if accepted >= 32 {
		t.Fatalf("%d MiB of fan-out was queued for a peer that is not reading", accepted)
	}
	select {
	case <-peer.dead:
	case <-time.After(5 * time.Second):
		t.Fatal("the peer was not dropped when the byte budget ran out")
	}
	if q := peer.queued.Load(); q < 0 {
		t.Fatalf("queued = %d, below zero", q)
	}
}

// S8: the catch-up buffer is bounded in bytes as well as entries.
//
// Four thousand entries sounds like a bound until one of them names sixty
// thousand chunks. Three such batches are more than the whole send budget, and
// they must drop the peer rather than sit in memory waiting for a replay to
// finish.
func TestS8TheCatchUpBufferIsBoundedInBytesAsWellAsEntries(t *testing.T) {
	r := newRig(t)
	r.seed("seed.md", "backlog")

	entered := make(chan struct{})
	hold := make(chan struct{})
	var once sync.Once
	r.srv.afterReplay = func() {
		once.Do(func() { close(entered) })
		<-hold
	}
	defer func() {
		select {
		case <-hold:
		default:
			close(hold)
		}
	}()

	cl := r.dial("a")
	cl.sendJSON(cl.deviceHello(0))
	<-entered
	peer := r.onlyPeer()

	names := make([]string, 60_000)
	for i := range names {
		names[i] = chunks.Name([]byte(fmt.Sprint(i)))
	}
	// Each marshals to about four megabytes; three exceed CatchupBufferBytes
	// and are nowhere near CatchupBufferMax.
	for i := 0; i < 3; i++ {
		peer.deliver(store.Entry{
			UID: int64(1000 + i), Path: "big.md", Size: 1, MTime: 1, Chunks: names,
		}, false)
	}
	select {
	case <-peer.dead:
	case <-time.After(5 * time.Second):
		t.Fatal("a session buffering more than the byte bound during catch-up was not dropped")
	}
	close(hold)
}

// S10: drain waits for the last frame to finish being written, not merely to
// leave the channel.
//
// Handle drains and then closes. The writer takes a frame off the channel and
// then spends as long as the write takes, up to WriteWait, and the old drain
// considered the job done twenty milliseconds after the channel emptied. A
// client that was slow to read the final frame had the socket closed under it
// halfway through, which for a fatal error frame means a bare disconnect and
// for a body means a truncated download.
func TestS10DrainWaitsForTheLastFrameToFinishWriting(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.conn.SetReadLimit(32 << 20)
	peer := r.onlyPeer()

	// A marker first, then a frame too large for any socket buffer, so the
	// write of the last frame cannot complete until the client reads it.
	marker := []byte{1}
	big := bytes.Repeat([]byte{2}, 16<<20)
	if err := peer.send(websocket.MessageBinary, marker); err != nil {
		t.Fatalf("send marker: %v", err)
	}
	if err := peer.send(websocket.MessageBinary, big); err != nil {
		t.Fatalf("send big: %v", err)
	}

	got := make(chan int, 1)
	go func() {
		if _, _, err := cl.conn.Read(cl.ctx); err != nil {
			got <- -1
			return
		}
		// Slow to get to the last frame.
		time.Sleep(300 * time.Millisecond)
		_, data, err := cl.conn.Read(cl.ctx)
		if err != nil {
			got <- -1
			return
		}
		got <- len(data)
	}()

	// What Handle does once run has returned.
	start := time.Now()
	peer.drain(5 * time.Second)
	waited := time.Since(start)
	peer.kill(nil)

	if n := <-got; n != len(big) {
		t.Fatalf("the client received %d bytes of the last frame; drain returned after %v "+
			"and the socket was closed mid-write", n, waited)
	}
}
