package server

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// The protocol, server side. plan/protocol.md is the contract; every test here
// reads a shape off the wire rather than trusting a struct, because the point
// of most of them is which fields are and are not present.

// rawFields decodes a frame into a map so a test can ask which keys it has.
func rawFields(t *testing.T, frame string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(frame), &m); err != nil {
		t.Fatalf("parse %q: %v", frame, err)
	}
	return m
}

/* ---------------------------------------------------------------- *
 * I1: request ids
 * ---------------------------------------------------------------- */

// Every reply echoes the id of the request it answers, and so does an error
// refusing that request. The harness checks this on every frame it reads; this
// test sends chosen ids so the echo is visible rather than merely consistent.
func TestI1RepliesAndRefusalsEchoTheRequestId(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "body")
	cl := r.dial("a")
	cl.hello(0)

	cl.sendJSON(wire.In{Op: "get", ID: 4242, UID: e.UID})
	if m := cl.recv(); m["res"] != "chunks" || m["id"] != float64(4242) {
		t.Fatalf("get with id 4242 was answered %v", m)
	}
	cl.sendJSON(wire.In{Op: "get", ID: 77, UID: 999})
	m := cl.recv()
	if m["res"] != "err" || m["code"] != wire.CodeNoUID || m["id"] != float64(77) {
		t.Fatalf("a refused get did not carry its id: %v", m)
	}
	if m["retryable"] != false {
		t.Fatalf("nouid is not retryable, got %v", m["retryable"])
	}
	cl.sendJSON(wire.In{Op: "history", ID: 9, Path: "note.md"})
	if m := cl.recv(); m["res"] != "history" || m["id"] != float64(9) {
		t.Fatalf("history was answered %v", m)
	}
	cl.sendJSON(wire.In{Op: "deleted", ID: 10})
	if m := cl.recv(); m["res"] != "deleted" || m["id"] != float64(10) {
		t.Fatalf("deleted was answered %v", m)
	}
	// A put is answered twice, want then ack, and both carry the id.
	names, size := chunkNames([]string{"fresh"})
	cl.sendJSON(wire.In{Op: "put", ID: 11, Path: "b.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 1}})
	if m := cl.recv(); m["res"] != "want" || m["id"] != float64(11) {
		t.Fatalf("want was %v", m)
	}
	cl.sendBinary([]byte("fresh"))
	if m := cl.recv(); m["res"] != "ack" || m["id"] != float64(11) {
		t.Fatalf("ack was %v", m)
	}
}

// The server never sends an id it was not given: batches, caught-up and pongs
// are unsolicited and carry none.
func TestI1UnsolicitedFramesCarryNoId(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "one")
	cl := r.dial("a")
	cl.sendJSON(cl.deviceHello(0))
	// ready, one batch, caught-up: read raw so absent and present are visible.
	for _, want := range []string{"ready", "batch", "caught-up"} {
		f := rawFields(t, cl.recvRaw())
		name := f["res"]
		if name == nil {
			name = f["op"]
		}
		if name != want {
			t.Fatalf("wanted %s, got %v", want, f)
		}
		_, hasID := f["id"]
		if want == "ready" && !hasID {
			t.Fatalf("ready carries no id: %v", f)
		}
		if want != "ready" && hasID {
			t.Fatalf("%s carries an id it was never given: %v", want, f)
		}
	}
	// A live change from another device: also unsolicited.
	other := r.dial("b")
	other.hello(1)
	other.put("b.md", "two")
	if f := rawFields(t, cl.recvRaw()); f["op"] != "batch" || f["id"] != nil {
		t.Fatalf("a live batch was %v", f)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	if f := rawFields(t, cl.recvRaw()); f["res"] != "pong" || f["id"] != nil {
		t.Fatalf("pong was %v", f)
	}
}

// A request with no id, or one out of range, cannot be answered in a
// way the client could match, so the session ends with a reason.
func TestI1ARequestWithoutAnIdEndsTheSession(t *testing.T) {
	for _, tc := range []struct {
		why string
		id  int64
	}{
		{"no id", 0},
		{"above 2^32-1", wire.MaxRequestID + 1},
		{"negative", -1},
	} {
		t.Run(tc.why, func(t *testing.T) {
			r := newRig(t)
			cl := r.dial("a")
			cl.hello(0)
			cl.sendRaw(wire.In{Op: "deleted", ID: tc.id})
			msg := cl.expectErr(wire.CodeProtoState)
			if !strings.Contains(msg, "id") {
				t.Fatalf("the refusal does not mention the id: %q", msg)
			}
			if !cl.closed() {
				t.Fatal("the session survived a request it could not answer")
			}
		})
	}
}

// A fetch is answered by a `bodies` header saying exactly how many
// frames follow, or by an error and no frames, never bodies then an error.
func TestI1FetchIsAnsweredByABodiesHeaderOrAnError(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "one", "two", "three")
	cl := r.dial("a")
	cl.hello(0)

	cl.sendJSON(wire.In{Op: "fetch", ID: 5, Chunks: e.Chunks})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "bodies" || f["id"] != float64(5) || f["count"] != float64(3) {
		t.Fatalf("fetch was answered %v, want bodies id 5 count 3", f)
	}
	for i, want := range []string{"one", "two", "three"} {
		if got := cl.recvBinary(); string(got) != want {
			t.Fatalf("body %d is %q", i, got)
		}
	}
	// Exactly three: the next frame is the pong, not a stray body.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})

	// One missing chunk refuses the whole fetch with the id and sends nothing.
	absent := chunks.Name([]byte("never uploaded"))
	cl.sendJSON(wire.In{Op: "fetch", ID: 6, Chunks: []string{e.Chunks[0], absent}})
	f = rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeNoChunk || f["id"] != float64(6) {
		t.Fatalf("a fetch of a missing chunk was answered %v", f)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// A body that rotted on disk is found before the header, not halfway through
// the stream.
//
// Presence was checked with a stat, which a rotted body passes, and each body
// was verified as it was read. So the third of five going bad meant a header
// promising five, two bodies, and then a fatal refusal: a client that had
// pre-allocated five is left waiting for frames that are not coming, and the
// count in the header was a promise the server had already broken. Every body
// is read and checked before the header now, so this is a refusal the session
// survives and the client can act on.
func TestI1AFetchWithARottedBodyIsRefusedBeforeTheHeader(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "one", "two", "three")
	cl := r.dial("a")
	cl.hello(0)

	// The middle body rots. It still stats, so nothing short of reading it
	// notices.
	p, err := r.st.Chunks().Path(testVault, e.Chunks[1])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.WriteFile(p, []byte("bytes this name does not describe"), 0o600); err != nil {
		t.Fatalf("rot the body: %v", err)
	}

	cl.sendJSON(wire.In{Op: "fetch", ID: 9, Chunks: e.Chunks})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeNoChunk || f["id"] != float64(9) {
		t.Fatalf("a fetch over a rotted body was answered %v, want an error and no bodies", f)
	}

	// The session survives it, so the client can ask for what it can still have.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})

	// And the bad body is set aside, so the next put asks for it again.
	if r.st.Chunks().Has(testVault, e.Chunks[1]) {
		t.Fatal("the rotted body is still present under its name, so no device will ever be asked for it")
	}
	got := cl.fetch(e.Chunks[0], e.Chunks[2])
	if string(got[0]) != "one" || string(got[1]) != "three" {
		t.Fatalf("the chunks that are still good fetched as %q and %q", got[0], got[1])
	}
}

/* ---------------------------------------------------------------- *
 * I2: retryable
 * ---------------------------------------------------------------- */

// Every error says whether reconnecting later can help, per the
// table in docs/protocol.md, and `busy` says how long to wait.
func TestI2ErrorsCarryRetryablePerTheTable(t *testing.T) {
	t.Run("busy before authentication is retryable with a hint", func(t *testing.T) {
		r := newRig(t)
		r.srv.maxPreAuth = 0
		late := r.dial("b")
		f := rawFields(t, late.recvRaw())
		if f["code"] != wire.CodeBusy || f["retryable"] != true {
			t.Fatalf("pre-authentication refusal: %v", f)
		}
		if ms, _ := f["retryAfterMs"].(float64); ms <= 0 {
			t.Fatalf("busy carries no retryAfterMs: %v", f)
		}
	})
	t.Run("auth, cursor and proto are not", func(t *testing.T) {
		r := newRig(t)
		r.seed("a.md", "one")
		id, key := r.device("x")
		for _, tc := range []struct {
			code string
			msg  wire.In
		}{
			{wire.CodeAuth, wire.In{Op: "hello", Vault: testVault, Token: deviceKey("guess"), DeviceID: id, Device: "x"}},
			{wire.CodeCursor, wire.In{Op: "hello", Vault: testVault,
				Token: key, DeviceID: id, Device: "x", Cursor: 99}},
			{wire.CodeProto, wire.In{Op: "hello", Proto: wire.Proto + 1,
				Vault: testVault, Token: key, DeviceID: id}},
		} {
			cl := r.dial("x")
			cl.sendJSON(tc.msg)
			f := rawFields(t, cl.recvRaw())
			if f["code"] != tc.code {
				t.Fatalf("wanted %s, got %v", tc.code, f)
			}
			if f["retryable"] != false {
				t.Fatalf("%s must not be retryable: %v", tc.code, f)
			}
			if _, has := f["retryAfterMs"]; has {
				t.Fatalf("%s carries a retryAfterMs: %v", tc.code, f)
			}
		}
	})
	t.Run("request refusals are not", func(t *testing.T) {
		r := newRig(t)
		cl := r.dial("a")
		cl.hello(0)
		for _, tc := range []struct {
			code string
			msg  wire.In
		}{
			{wire.CodeProtoState, wire.In{Op: "reticulate"}},
			{wire.CodeNoUID, wire.In{Op: "get", UID: 999}},
			{wire.CodeBadChunk, wire.In{Op: "fetch", Chunks: []string{"nope"}}},
			{wire.CodeBadPath, wire.In{Op: "put"}},
			{wire.CodeBadPath, wire.In{Op: "put", Path: ".obsidian/app.json"}},
			{wire.CodeBadName, wire.In{Op: "rename", Name: "a\nb"}},
			{wire.CodeBadEntry, wire.In{Op: "putmany"}},
			{wire.CodeToolarge, wire.In{Op: "put", Path: "x",
				Meta: wire.PutMeta{Size: store.PerFileMax + 1}}},
		} {
			cl.sendJSON(tc.msg)
			f := rawFields(t, cl.recvRaw())
			if f["code"] != tc.code || f["retryable"] != false {
				t.Fatalf("wanted %s not retryable, got %v", tc.code, f)
			}
		}
	})
}

// The shutdown notice is the one error a client did not ask for: no id,
// retryable, and a hint for how soon to come back.
func TestI2TheShutdownNoticeIsRetryableWithAHint(t *testing.T) {
	r := newRig(t)
	cl := r.dial("idle")
	cl.hello(0)
	shutdownRig(t, r)
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeBusy {
		t.Fatalf("shutdown notice was %v", f)
	}
	if f["id"] != nil {
		t.Fatalf("an unsolicited error carries an id: %v", f)
	}
	if f["retryable"] != true {
		t.Fatalf("the shutdown notice is not retryable: %v", f)
	}
	if ms, _ := f["retryAfterMs"].(float64); ms <= 0 {
		t.Fatalf("the shutdown notice has no retryAfterMs: %v", f)
	}
}

/* ---------------------------------------------------------------- *
 * I3: caps in ready
 * ---------------------------------------------------------------- */

// ready carries every ceiling the session enforces, the protocol range the
// server speaks, what it calls itself, and the store's epoch; and no wrapped
// data key, which protocol 1 has none of.
func TestI3ReadyAdvertisesTheCapsAndTheVersion(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion("9.8.7")
	probe := r.dial("a")
	probe.sendJSON(probe.deviceHello(0))
	raw := rawFields(t, probe.recvRaw())
	if _, has := raw["wrapped"]; has {
		t.Fatalf("ready still carries a wrapped key: %v", raw)
	}
	if raw["epoch"] != r.st.Epoch() || r.st.Epoch() == "" {
		t.Fatalf("ready carries epoch %v, and the store's is %q", raw["epoch"], r.st.Epoch())
	}
	ready, _ := r.dial("a").hello(0)
	if ready.MaxBatchBytes != wire.MaxBatchBytes || ready.MaxFetchBytes != wire.MaxFetchBytes {
		t.Fatalf("caps advertised %d and %d, enforced %d and %d",
			ready.MaxBatchBytes, ready.MaxFetchBytes, wire.MaxBatchBytes, wire.MaxFetchBytes)
	}
	if ready.MinProto != wire.MinProto || ready.Proto != wire.Proto {
		t.Fatalf("proto range advertised %d to %d, server speaks %d to %d",
			ready.MinProto, ready.Proto, wire.MinProto, wire.Proto)
	}
	if ready.ServerVersion != "9.8.7" {
		t.Fatalf("serverVersion = %q", ready.ServerVersion)
	}
	// And a lowered cap is what is advertised, so the two cannot drift.
	r2 := newRig(t)
	r2.srv.maxFetchBytes = 1234
	if ready, _ := r2.dial("a").hello(0); ready.MaxFetchBytes != 1234 {
		t.Fatalf("advertised %d, enforcing 1234", ready.MaxFetchBytes)
	}
}

/* ---------------------------------------------------------------- *
 * Revoking every session of a device at once
 * ---------------------------------------------------------------- */

// The sessions a revoke ends are evicted at the same time, not one after
// another (strip ledger, unique guarantee 19).
//
// Each eviction gives its peer up to a second to read the notice before the
// connection is closed. Basalt ran them in parallel for a rotation and tested
// that; its revoke ran the same loop and had no test, so a device with several
// connections open could hold a revoke's reply for a second a connection.
func TestARevokeEvictsEverySessionOfTheDeviceAtOnce(t *testing.T) {
	r := newRig(t)
	phone := r.dial("phone")
	phone.hello(0)
	peers := []*client{r.dial("laptop"), r.dial("laptop"), r.dial("laptop")}
	for _, p := range peers {
		p.hello(0)
	}
	waitFor(t, "every laptop session to join", func() bool { return r.srv.Peers(testVault) == 4 })

	// Each eviction reports in and waits for the others. In series the first
	// one waits for peers that have not started, so nothing but the timeout
	// gets past this.
	arrived := make(chan struct{}, len(peers))
	together := make(chan struct{})
	var once sync.Once
	r.srv.beforeEvict = func() {
		arrived <- struct{}{}
		if len(arrived) == len(peers) {
			once.Do(func() { close(together) })
		}
		select {
		case <-together:
		case <-time.After(3 * time.Second):
		}
	}

	start := time.Now()
	phone.sendJSON(wire.In{Op: "revoke", ID: 41, DeviceID: deviceID("laptop")})
	if m := phone.recv(); m["res"] != "revoked" || m["id"] != float64(41) {
		t.Fatalf("revoke was answered %v", m)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the revoke took %s: the evictions did not overlap", took.Round(time.Millisecond))
	}
	if n := len(arrived); n != len(peers) {
		t.Fatalf("%d of %d sessions were evicted", n, len(peers))
	}
	for _, p := range peers {
		if !p.closed() {
			t.Fatal("a session of the revoked device stayed open")
		}
	}
}

/* ---------------------------------------------------------------- *
 * I6, S24: field bounds
 * ---------------------------------------------------------------- */

// vault and device are bounded at 64 bytes and may not contain control
// characters, because both land in logs and file paths. Either fault is badname
// and ends the session at hello, before any credential is looked at.
func TestS24VaultAndDeviceAreBoundedAndFreeOfControlCharacters(t *testing.T) {
	for _, tc := range []struct {
		why    string
		vault  string
		device string
	}{
		{"vault over 64", strings.Repeat("v", store.MaxVaultLen+1), "a"},
		{"vault with a newline", "v1\nlooks like another log line", "a"},
		{"device with a NUL", testVault, "phone\x00"},
		{"device with DEL", testVault, "phone\x7f"},
	} {
		t.Run(tc.why, func(t *testing.T) {
			r := newRig(t)
			cl := r.dial("a")
			cl.sendJSON(wire.In{Op: "hello", Vault: tc.vault, Device: tc.device,
				DeviceID: deviceID("a"), Token: deviceKey("a")})
			cl.expectErr(wire.CodeBadName)
			if !cl.closed() {
				t.Fatal("the session survived a name it must not log")
			}
		})
	}
	// Exactly at the bound is fine, in every field a hello carries: the vault,
	// the device name and the device id.
	longVault := strings.Repeat("v", store.MaxVaultLen)
	longName := strings.Repeat("d", store.MaxDeviceLen)
	longID := strings.Repeat("i", store.MaxDeviceIDLen)
	r := newRig(t)
	if err := r.st.EnsureVault(longVault, 1); err != nil {
		t.Fatal(err)
	}
	if err := r.st.RegisterDevice(longVault, longID, longName, hashOf(deviceKey("a")), 1); err != nil {
		t.Fatalf("registering a device with names at the bound: %v", err)
	}
	cl := r.dial("a")
	cl.sendJSON(wire.In{Op: "hello", Vault: longVault, Token: deviceKey("a"), DeviceID: longID, Device: longName})
	cl.recvInto("ready", &wire.Ready{})
}

// A device id over the bound is refused at hello, and as `badname` rather than
// as `auth`: it is a fact about the request rather than about the vault, and
// answering it with `auth` would make the shape of an id look like the answer
// to whether that device is registered.
//
// An id under the reserved prefix is the exception, and is `auth` (plan/
// protocol.md, "Device session"): it is refused as a credential, before its
// shape is judged, so no row under the prefix can ever be connected to.
func TestADeviceIDIsBoundedAndBase64URL(t *testing.T) {
	for _, id := range []string{strings.Repeat("i", store.MaxDeviceIDLen+1), "not base64url!", "has/slash"} {
		r := newRig(t)
		cl := r.dial("a")
		cl.sendJSON(wire.In{Op: "hello", Vault: testVault, Token: deviceKey("a"), DeviceID: id, Device: "a"})
		cl.expectErr(wire.CodeBadName)
		if !cl.closed() {
			t.Fatalf("a hello naming device id %q was refused and left open", id)
		}
	}
	for _, id := range []string{store.ReservedDeviceIDPrefix + "claude", store.ReservedDeviceIDPrefix} {
		r := newRig(t)
		cl := r.dial("a")
		cl.sendJSON(wire.In{Op: "hello", Vault: testVault, Token: deviceKey("a"), DeviceID: id, Device: "a"})
		if msg := cl.expectErr(wire.CodeAuth); msg != errNotAuthorised.Error() {
			t.Fatalf("a reserved id was refused with %q, not the one refusal every credential gets", msg)
		}
		if !cl.closed() {
			t.Fatalf("a hello naming reserved id %q was refused and left open", id)
		}
		// And a redemption cannot register one either, nor spend the invite
		// trying.
		inv := r.invite(time.Hour)
		joiner := r.dial("joiner")
		hello := redeemHello(inv.Token, "joiner")
		hello.DeviceID = id
		joiner.sendJSON(hello)
		joiner.expectErr(wire.CodeAuth)
		if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
			t.Fatalf("a redemption naming reserved id %q spent the invite", id)
		}
	}
}

/* ---------------------------------------------------------------- *
 * I9: version negotiation
 * ---------------------------------------------------------------- */

// 1 and 2 are the protocols. A client asking for anything else is refused at
// hello with both numbers in the message, which is the whole of what the
// negotiation machinery is kept for: this is how a client on the wrong version
// learns which end to upgrade. The server's version is not in this message,
// because nothing has authenticated when it is sent; see disclosure_test.go.
//
// Hazard 7: the probe is a Basalt plugin, protocol 7 with Basalt's crypto
// field and a bootstrap token, so a Basalt device meeting a TrewSync server is
// refused as `proto`, naming both numbers, and not as `auth`.
func TestAHelloOutsideTheRangeIsRefusedNamingBothNumbers(t *testing.T) {
	for _, proto := range []int{7, 3, 0} {
		r := newRig(t)
		r.srv.SetVersion("4.5.6")
		cl := r.dial("old-phone")
		cl.sendRaw(map[string]any{
			"op": "hello", "id": 1, "proto": proto, "crypto": "basalt/hkdf-aes-gcm/1",
			"vault": testVault, "token": "ABCD1234-EFGH5678JKMNPQRS", "device": "old-phone",
		})
		msg := cl.expectErr(wire.CodeProto)
		for _, want := range []string{
			fmt.Sprintf("protocol %d", proto),
			fmt.Sprintf("%d to %d", wire.MinProto, wire.Proto),
		} {
			if !strings.Contains(msg, want) {
				t.Fatalf("the refusal of protocol %d does not name %q: %q", proto, want, msg)
			}
		}
		if !cl.closed() {
			t.Fatalf("a client on protocol %d was refused and left open", proto)
		}
	}
}

// joined pairs the named device the way a real one pairs: an invite from the
// server, a redemption on one connection, then a device hello on the next. It
// returns the device connected and caught up.
func joined(t *testing.T, r *rig, name string) *client {
	t.Helper()
	inv := r.invite(time.Hour)
	r.dial(name).redeem(inv.Token)
	cl := r.dial(name)
	cl.hello(0)
	return cl
}

// Two devices against one server, each paired through an invite: each sees the
// other's write with its payload and its own as an empty range, and the harness
// checks the id on every reply either of them gets.
func TestI9TwoClientsAgainstTheSameServer(t *testing.T) {
	r := newRig(t)
	one := joined(t, r, "one")
	two := joined(t, r, "two")
	a := one.put("a.md", "from one")
	b := two.put("b.md", "from two")
	if got := two.nextBatch(); got.From != a || len(got.Entries) != 1 {
		t.Fatalf("two saw %+v for one's write", got)
	}
	// one sees its own write as an empty range first, then two's with the
	// payload: a device never has to recognise its own echo.
	if echo := one.nextBatch(); echo.To != a || len(echo.Entries) != 0 {
		t.Fatalf("one's echo of its own write was %+v", echo)
	}
	if got := one.nextBatch(); got.To != b || len(got.Entries) != 1 {
		t.Fatalf("one saw %+v for two's write", got)
	}
}

/* ---------------------------------------------------------------- *
 * F19: the served vault
 * ---------------------------------------------------------------- */

// F19. Every hello route enforces the served vault.
//
// Basalt enforced it on the route that claimed and not on the others, so a
// device registered to another vault in the same store connected to a server
// that had logged that vault as "not served" at startup. Scope, not access:
// the caller still needs that vault's own credentials.
//
// The refusal is the one every credential failure gets, byte for byte. Basalt's
// named the vault this server serves, which told anybody on the port the name
// to aim at, and differed from a wrong token's, which told them by elimination.
func TestADeviceOfAnUnservedVaultIsRefused(t *testing.T) {
	r := newRig(t)
	r.srv.Serves(testVault)

	// A second vault in the same store, with a device of its own. This is what
	// a data directory that has served two vaults over its life looks like.
	other := otherVault(t, r)
	if err := r.st.RegisterDevice(other, deviceID("theirs"), "theirs", hashOf(deviceKey("theirs")),
		r.srv.now().UnixMilli()); err != nil {
		t.Fatalf("register a device on the other vault: %v", err)
	}

	cl := r.dial("theirs")
	cl.sendJSON(wire.In{Op: "hello", Vault: other, DeviceID: deviceID("theirs"),
		Token: deviceKey("theirs"), Device: "theirs"})
	unserved := cl.recvFrame()

	wrong := r.dial("guesser")
	wrong.sendJSON(wire.In{Op: "hello", Vault: testVault, DeviceID: deviceID("theirs"),
		Token: deviceKey("theirs"), Device: "theirs"})
	refused := wrong.recvFrame()
	if string(unserved) != string(refused) {
		t.Fatalf("an unserved vault is refused differently from a wrong token:\n  unserved: %s\n  wrong:    %s",
			unserved, refused)
	}
	if !strings.Contains(string(unserved), `"code":"auth"`) || strings.Contains(string(unserved), testVault+`"`) {
		t.Fatalf("the refusal is not the plain auth refusal: %s", unserved)
	}

	// And the served vault still works from the same server.
	device := r.dial("mine")
	device.hello(0)
	device.put("note.md", "still fine")
}

// An invite for a vault this server does not serve is refused before it is
// looked up, so the refusal cannot spend it.
func TestAnInviteForAnUnservedVaultIsRefusedWithoutBeingSpent(t *testing.T) {
	r := newRig(t)
	r.srv.Serves(testVault)

	other := otherVault(t, r)
	now := r.srv.now().UnixMilli()
	expires := now + 600_000
	inv, err := r.st.CreateInvite(other, "", "", &expires, now)
	if err != nil {
		t.Fatalf("an invite on the other vault: %v", err)
	}

	cl := r.dial("stranger")
	hello := redeemHello(inv.Token, "stranger")
	hello.Vault = other
	cl.sendJSON(hello)
	cl.expectErr(wire.CodeAuth)

	// Unspent: a refusal for the wrong vault must not burn somebody's invite.
	if n, err := r.st.OutstandingInvites(other, now); err != nil || n != 1 {
		t.Fatalf("the invite was consumed by a refusal: %d left, %v", n, err)
	}
	if ds, _ := r.st.Devices(other); len(ds) != 0 {
		t.Fatalf("a refused redemption registered %v", ds)
	}
}

// otherVault is a second vault in the same store, which is what a data
// directory that has served two vaults over its life looks like.
func otherVault(t *testing.T, r *rig) string {
	t.Helper()
	const other = "the-other-vault"
	if err := r.st.EnsureVault(other, 1); err != nil {
		t.Fatalf("ensure the other vault: %v", err)
	}
	return other
}
