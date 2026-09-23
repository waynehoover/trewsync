package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// I23: single-use invites (plan/protocol.md, "Invite redemption" and "Devices
// and invites"). The server mints a token, keeps its digest, and lets it
// register exactly one device. Basalt's invite held a sealed data key the
// server could not open; the properties below are the ones that survive a
// bearer token in its place, and plan/strip-ledger.md says which is which.

// redeemRaw sends a redemption hello and returns the raw reply, checking that
// the connection closes behind it, as every redemption's does.
func redeemRaw(t *testing.T, r *rig, hello wire.In) map[string]any {
	t.Helper()
	cl := r.dial("newcomer")
	cl.sendJSON(hello)
	f := rawFields(t, cl.recvRaw())
	if !cl.closed() {
		t.Fatalf("the session stayed open after %v; a redemption always closes", f)
	}
	return f
}

// redeemAs redeems invite for the named device and returns the raw reply.
func redeemAs(t *testing.T, r *rig, invite []byte, name string) map[string]any {
	t.Helper()
	return redeemRaw(t, r, redeemHello(invite, name))
}

// issue asks for an invite from a device session and returns the reply.
func issue(t *testing.T, a *client, in wire.In) wire.Invited {
	t.Helper()
	in.Op = "invite"
	a.sendJSON(in)
	var got wire.Invited
	a.recvInto("invited", &got)
	return got
}

// tokenOf is the raw token an `invited` reply carries.
func tokenOf(t *testing.T, inv wire.Invited) []byte {
	t.Helper()
	raw, ok := store.DecodeToken(inv.Token, store.InviteTokenBytes)
	if !ok {
		t.Fatalf("invited carries token %q, which is not %d bytes of base64url", inv.Token, store.InviteTokenBytes)
	}
	return raw
}

/* ---------------------------------------------------------------- *
 * Seeing an invite, and cancelling one
 * ---------------------------------------------------------------- */

// invite_test.go:73 and hazard 1. An outstanding invite is visible beside the
// device list, by id, label and expiry, and by nothing that redeems it.
//
// It was the one authority on a vault that nothing could see: a string issued
// on a stolen laptop was invisible until somebody redeemed it. Basalt listed
// the redemption identifier itself, which was safe only because redeeming also
// needed a key that never reached the server; a Trew token is the whole
// credential, so the listing carries an id minted beside it, and this proves
// field by field that nothing listed redeems.
func TestOutstandingInvitesAreVisibleAndCarryNothingThatRedeems(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)

	a.sendJSON(wire.In{Op: "devices", ID: 1})
	empty := rawFields(t, a.recvRaw())
	if list, ok := empty["invites"].([]any); !ok || len(list) != 0 {
		t.Fatalf("invites is %v on a vault with none, want []: a client that iterates null crashes", empty["invites"])
	}

	issued := issue(t, a, wire.In{TTLMs: 60_000, Label: "for the tablet"})
	token := tokenOf(t, issued)

	a.sendJSON(wire.In{Op: "devices", ID: 2})
	raw := a.recv()
	list, _ := raw["invites"].([]any)
	if len(list) != 1 {
		t.Fatalf("the device list shows %v invites, want the one that was issued", raw["invites"])
	}
	row, _ := list[0].(map[string]any)
	if row["invite"] != issued.Invite || row["label"] != "for the tablet" || row["expiresAt"] != float64(*issued.ExpiresAt) {
		t.Fatalf("the invite row is %v, want the id, label and expiry that were answered", row)
	}
	// By those three and nothing else. Asserted over the raw frame rather than
	// a struct, because a field added to store.Invite would unmarshal into a
	// struct this test does not look at and reach every client that ever
	// serialises the list.
	if len(row) != 3 {
		t.Fatalf("the invite row carries fields beyond the id, label and expiry: %v", row)
	}
	// Nothing listed is, contains or hashes to the token, and nothing listed
	// redeems when offered as one.
	frame, _ := json.Marshal(raw)
	for _, secret := range []string{issued.Token, store.HashToken(token)} {
		if strings.Contains(string(frame), secret) {
			t.Fatalf("the device list carries the token or its digest: %s", frame)
		}
	}
	for key, value := range row {
		s, ok := value.(string)
		if !ok {
			continue
		}
		hello := redeemHello(token, "prober")
		hello.Invite = s
		if f := redeemRaw(t, r, hello); f["code"] != wire.CodeAuth {
			t.Fatalf("the listed %s redeemed or was not refused as a credential: %v", key, f)
		}
	}
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatal("offering listed fields as invites spent the invite")
	}

	// A redeemed invite is not outstanding: it is a device row now, and the
	// list would otherwise show a string that no longer works.
	if f := redeemAs(t, r, token, "phone"); f["res"] != "redeemed" {
		t.Fatalf("redeem was answered %v", f)
	}
	a.sendJSON(wire.In{Op: "devices", ID: 3})
	var after wire.DeviceList
	a.recvInto("devices", &after)
	if len(after.Invites) != 0 || len(after.Devices) != 2 {
		t.Fatalf("after redeeming: %d invites and %d devices", len(after.Invites), len(after.Devices))
	}
}

// invite_test.go:129. An expired invite is not outstanding either, so the list
// shows what could still be redeemed rather than what was ever issued.
func TestAnExpiredInviteLeavesTheList(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	issue(t, a, wire.In{TTLMs: 60_000})

	r.srv.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	a.sendJSON(wire.In{Op: "devices"})
	var list wire.DeviceList
	a.recvInto("devices", &list)
	if len(list.Invites) != 0 {
		t.Fatalf("an expired invite is still listed as outstanding: %+v", list.Invites)
	}
}

// invite_test.go:147. Cancelling one, which is what seeing them is for: an
// invite issued on a device you have just lost is retired without waiting out
// the hour.
func TestAnOutstandingInviteCanBeCancelled(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	issued := issue(t, a, wire.In{})

	a.sendJSON(wire.In{Op: "uninvite", ID: 4, Invite: issued.Invite})
	var done wire.Uninvited
	a.recvInto("uninvited", &done)
	if done.Invite != issued.Invite {
		t.Fatalf("uninvited names %q, not the invite that was cancelled", done.Invite)
	}
	// Gone from the list, and gone from the server: the string somebody is
	// holding stops working, which is the whole point.
	a.sendJSON(wire.In{Op: "devices"})
	var list wire.DeviceList
	a.recvInto("devices", &list)
	if len(list.Invites) != 0 {
		t.Fatalf("a cancelled invite is still outstanding: %+v", list.Invites)
	}
	if f := redeemAs(t, r, tokenOf(t, issued), "phone"); f["code"] != wire.CodeAuth {
		t.Fatalf("a cancelled invite still redeems: %v", f)
	}
	if n := len(mustDevices(t, r)); n != 1 {
		t.Fatalf("%d devices after a cancelled invite was redeemed", n)
	}

	// Cancelling it again says there is nothing to cancel, and says it the
	// same way an unknown id and the token itself are answered: one refusal,
	// because telling them apart tells somebody guessing that they found one.
	answers := map[string]bool{}
	for _, id := range []string{issued.Invite, store.EncodeToken([]byte("unknown!")), issued.Token, "not base64!"} {
		a.sendJSON(wire.In{Op: "uninvite", Invite: id})
		answers[a.expectErr(wire.CodeBadEntry)] = true
	}
	if len(answers) != 1 {
		t.Fatalf("the refusals to cancel are distinguishable: %v", answers)
	}
	for msg := range answers {
		if !strings.Contains(msg, "device list") {
			t.Fatalf("the refusal does not say where to look instead: %q", msg)
		}
	}
	// The session survives, because nothing changed.
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// invite_test.go:215. Interrupted pairings remain visible without preventing
// another device joining: there is no device cap, and a redeemed row that never
// connected is a row like any other.
func TestCrashedPairingsDoNotPreventMoreDevicesJoining(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	for i := 0; i < 24; i++ {
		issued := issue(t, a, wire.In{})
		if f := redeemAs(t, r, tokenOf(t, issued), fmt.Sprintf("crashed-%d", i)); f["res"] != "redeemed" {
			t.Fatalf("redemption %d: %v", i, f)
		}
	}
	issued := issue(t, a, wire.In{})
	if f := redeemAs(t, r, tokenOf(t, issued), "phone"); f["res"] != "redeemed" {
		t.Fatalf("joining after crashed pairings: %v", f)
	}
	rows := mustDevices(t, r)
	if len(rows) != 26 {
		t.Fatalf("%d device rows, want 26", len(rows))
	}
	never := 0
	for _, row := range rows {
		if row.LastSeen == 0 {
			never++
		}
	}
	if never != 25 {
		t.Fatalf("%d unseen devices, want 25", never)
	}
}

// invite_test.go:244, the half that stays. The invite reply carries its id, its
// token and an expiry near now plus the ttl; the redemption answers with the
// device id and nothing else; and the second, an unknown and a malformed try
// all get one identical `auth`.
func TestI23AnInviteIsRedeemedExactlyOnce(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)

	a.sendJSON(wire.In{Op: "invite", ID: 21, TTLMs: 60_000})
	m := a.recv()
	if m["res"] != "invited" || m["id"] != float64(21) {
		t.Fatalf("invite was answered %v", m)
	}
	want := r.srv.now().Add(time.Minute).UnixMilli()
	if got := int64(m["expiresAt"].(float64)); got < want-2000 || got > want+2000 {
		t.Fatalf("expiresAt %d, wanted about %d", got, want)
	}
	id, _ := m["invite"].(string)
	token, _ := m["token"].(string)
	if !store.ValidInviteID(id) || id == token {
		t.Fatalf("invited carries id %q and token %q: the id must be its own, non-secret handle", id, token)
	}
	raw := tokenOf(t, wire.Invited{Token: token})

	f := redeemAs(t, r, raw, "newcomer")
	if f["res"] != "redeemed" || f["deviceId"] != deviceID("newcomer") || f["id"] == nil {
		t.Fatalf("redeem was answered %v", f)
	}
	// Nothing else: no key material, because there is none to hand over.
	if len(f) != 3 {
		t.Fatalf("redeemed carries fields beyond res, id and deviceId: %v", f)
	}

	// Once. The second try, an unknown one, and malformed ones all get the
	// same answer, so a guesser learns nothing.
	answers := map[string]bool{}
	for _, inv := range []string{token, store.EncodeToken([]byte("sixteen byte tok")), "not base64!", id} {
		hello := redeemHello(nil, "latecomer")
		hello.Invite = inv
		f := redeemRaw(t, r, hello)
		if f["res"] != "err" || f["code"] != wire.CodeAuth {
			t.Fatalf("redeeming %q was answered %v, want auth", inv, f)
		}
		answers[f["msg"].(string)] = true
	}
	if len(answers) != 1 {
		t.Fatalf("the refusals are distinguishable: %v", answers)
	}
	// The issuing session is untouched.
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// invite_test.go:293.
func TestI23AnExpiredInviteIsRefused(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	base := time.Now()
	r.srv.now = func() time.Time { return base }
	issued := issue(t, a, wire.In{TTLMs: 1000})

	r.srv.now = func() time.Time { return base.Add(2 * time.Second) }
	if f := redeemAs(t, r, tokenOf(t, issued), "newcomer"); f["code"] != wire.CodeAuth {
		t.Fatalf("an expired invite was answered %v", f)
	}
}

// Step 2 over the wire: a redemption whose reply was lost is retried with the
// same device id and token and answered `redeemed` again, even after the
// invite has expired, because the redemption it repeats did not
// (plan/protocol.md, "Invite redemption"). The client keeps a pending pairing
// for exactly this, and a refusal here would leave it holding a device row it
// can connect with and a pairing it deletes.
func TestALostReplyRetryIsRedeemedAgainEvenAfterExpiry(t *testing.T) {
	r := newRig(t)
	base := time.Now()
	r.srv.now = func() time.Time { return base }
	inv := r.invite(time.Minute)
	if f := redeemAs(t, r, inv.Token, "phone"); f["res"] != "redeemed" {
		t.Fatalf("the first redemption: %v", f)
	}

	r.srv.now = func() time.Time { return base.Add(2 * time.Hour) }
	if f := redeemAs(t, r, inv.Token, "phone"); f["res"] != "redeemed" || f["deviceId"] != deviceID("phone") {
		t.Fatalf("the retry after expiry was answered %v", f)
	}
	// And it wrote nothing: one row, the original, and a device that connects.
	if ds := mustDevices(t, r); len(ds) != 1 {
		t.Fatalf("the retry added a row: %v", ds)
	}
	cl := r.dial("phone")
	cl.hello(0)

	// The same token under another id is not a retry, and is refused.
	hello := redeemHello(inv.Token, "tablet")
	if f := redeemRaw(t, r, hello); f["code"] != wire.CodeAuth {
		t.Fatalf("another device retrying the invite was answered %v", f)
	}
}

// invite_test.go:307. The ttl defaults to an hour and a device may not ask for
// more, and a negative ttl is refused.
func TestI23TheTTLDefaultsAndIsCapped(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	base := time.Now()
	r.srv.now = func() time.Time { return base }

	for _, c := range []struct {
		ask  time.Duration
		want time.Duration
	}{
		{0, DefaultInviteTTL},
		{30 * time.Minute, 30 * time.Minute},
		{5 * time.Hour, MaxInviteTTL},
	} {
		inv := issue(t, a, wire.In{TTLMs: c.ask.Milliseconds()})
		if inv.ExpiresAt == nil || *inv.ExpiresAt != base.Add(c.want).UnixMilli() {
			t.Fatalf("a ttl of %s gave expiry %v, want %d", c.ask, inv.ExpiresAt, base.Add(c.want).UnixMilli())
		}
	}
	if DefaultInviteTTL != time.Hour || MaxInviteTTL != time.Hour {
		t.Fatalf("the invite lifetimes are %s and %s; plan/protocol.md says one hour for both",
			DefaultInviteTTL, MaxInviteTTL)
	}
	a.sendJSON(wire.In{Op: "invite", TTLMs: -1})
	a.expectErr(wire.CodeBadEntry)
	a.sendJSON(wire.In{Op: "invite", Label: "a\nb"})
	a.expectErr(wire.CodeBadName)
	if n, _ := r.st.OutstandingInvites(testVault, base.UnixMilli()); n != 3 {
		t.Fatalf("%d outstanding invites, want the three that were issued", n)
	}
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// invite_test.go:328, the subtest that stays: a vault with no invites has
// nothing to redeem, whatever is offered.
func TestAVaultWithNoInvitesHasNothingToRedeem(t *testing.T) {
	r := newRig(t)
	if f := redeemAs(t, r, []byte("sixteen byte tok"), "newcomer"); f["code"] != wire.CodeAuth {
		t.Fatalf("got %v", f)
	}
}

// invite_test.go:437. A hello carrying an existing device's own credential and
// an invite is refused, and leaves the invite redeemable.
//
// In protocol 1 a redemption carries a token by design, the one the joining
// device has chosen, so the shape Basalt refused as "both" is the ordinary one.
// What survives is the ambiguity it guarded against: a device already on the
// vault offering its own id and token with an invite must not be treated as
// connecting while the invite is quietly ignored, nor spend the invite on a row
// it already has. It is refused like any other redemption onto an existing id.
func TestAHelloWithADevicesCredentialAndAnInviteIsRefused(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	issued := issue(t, a, wire.In{})

	cl := r.dial("a")
	cl.sendJSON(redeemHello(tokenOf(t, issued), "a"))
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeAuth {
		t.Fatalf("a device's own credential with an invite was answered %v, want auth", f)
	}
	if !cl.closed() {
		t.Fatal("the session survived a hello that was refused")
	}

	// And the invite is untouched: neither redeemed nor burned by the refusal.
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatalf("%d outstanding invites after the refusal, want the one that was issued", n)
	}
	if fr := redeemAs(t, r, tokenOf(t, issued), "newcomer"); fr["res"] != "redeemed" {
		t.Fatalf("the invite no longer redeems: %v", fr)
	}
}

/* ---------------------------------------------------------------- *
 * Redeeming an invite is how a device is registered
 * ---------------------------------------------------------------- */

// invite_test.go:479, the half that stays. A device that has the vault issues
// an invite, the newcomer redeems it, and what the newcomer holds afterwards is
// a row of its own, which its token then connects to.
func TestARedeemedInviteRegistersTheDeviceThatRedeemedIt(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	issued := issue(t, a, wire.In{})

	hello := redeemHello(tokenOf(t, issued), "phone")
	hello.Device = "the phone"
	if f := redeemRaw(t, r, hello); f["res"] != "redeemed" {
		t.Fatalf("redeem was answered %v", f)
	}

	// The row is there, named after the hello's device name, and it is the
	// only one the redemption added.
	ds := mustDevices(t, r)
	var row *store.Device
	for i := range ds {
		if ds[i].ID == deviceID("phone") {
			row = &ds[i]
		}
	}
	if row == nil {
		t.Fatalf("the redemption registered no device: %v", ds)
	}
	if row.Name != "the phone" {
		t.Fatalf("the row is named %q, not the name the hello carried", row.Name)
	}
	if row.LastSeen != 0 {
		t.Fatalf("last_seen is %d before the device has ever connected", row.LastSeen)
	}
	if len(ds) != 2 {
		t.Fatalf("%d devices, want the one that invited and the one that redeemed: %v", len(ds), ds)
	}

	// And the token it registered is the token it connects with. The redeeming
	// connection proved nothing about holding it, so this hello is the proof.
	cl := r.dial("phone")
	cl.sendJSON(wire.In{Op: "hello", Vault: testVault,
		DeviceID: deviceID("phone"), Token: deviceKey("phone"), Device: "phone"})
	cl.recvInto("ready", &wire.Ready{})
	cl.recvInto("caught-up", &wire.CaughtUp{})

	// Basalt's register and rotate are gone: there is no such op to refuse.
	for _, op := range []string{"register", "rotate"} {
		cl.sendJSON(wire.In{Op: op, DeviceID: deviceID("another")})
		if msg := cl.expectErr(wire.CodeProtoState); !strings.Contains(msg, "unknown op") {
			t.Fatalf("%s was refused with %q, want an unknown op", op, msg)
		}
	}

	// The device that issued the invite is undisturbed by any of it.
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// invite_test.go:539. An invite redeemed twice registers one device, not two.
func TestAnInviteRedeemedTwiceRegistersOneDevice(t *testing.T) {
	r := newRig(t)
	inv := r.invite(time.Hour)
	if f := redeemAs(t, r, inv.Token, "phone"); f["res"] != "redeemed" {
		t.Fatalf("the first redeem was answered %v", f)
	}
	// A different device, so this is about the invite and not about the id.
	f := redeemAs(t, r, inv.Token, "tablet")
	if f["res"] != "err" || f["code"] != wire.CodeAuth {
		t.Fatalf("a second redemption was answered %v, want auth", f)
	}
	ds := mustDevices(t, r)
	if len(ds) != 1 || ds[0].ID != deviceID("phone") {
		t.Fatalf("devices after two redemptions: %v", ds)
	}
}

// invite_test.go:572 and hazard 3. A redemption onto an id the vault already
// holds is refused, changes nothing, and leaves the invite unspent, so the
// string in somebody's hand still works. It is the one `auth` refusal, like an
// unknown invite, so a probe cannot learn from the invite which ids exist.
func TestARedeemThatCannotRegisterLeavesTheInviteUnspent(t *testing.T) {
	r := newRig(t)
	r.device("a")
	inv := r.invite(time.Hour)

	hello := redeemHello(inv.Token, "phone")
	hello.DeviceID = deviceID("a")
	if f := redeemRaw(t, r, hello); f["res"] != "err" || f["code"] != wire.CodeAuth {
		t.Fatalf("redeeming onto an existing id was answered %v, want auth", f)
	}
	// Nothing was overwritten: that row is still the device it was.
	_, hash, ok, err := r.st.DeviceByID(testVault, deviceID("a"))
	if err != nil || !ok || hash != hashOf(deviceKey("a")) {
		t.Fatalf("the existing row was changed: ok=%v hash=%q err=%v", ok, hash, err)
	}
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatalf("%d outstanding invites after a refused redemption, want 1", n)
	}
	if f := redeemAs(t, r, inv.Token, "phone"); f["res"] != "redeemed" {
		t.Fatalf("the invite no longer redeems: %v", f)
	}
}

// mustDevices is the vault's device list or a failed test.
func mustDevices(t *testing.T, r *rig) []store.Device {
	t.Helper()
	ds, err := r.st.Devices(testVault)
	if err != nil {
		t.Fatalf("listing devices: %v", err)
	}
	return ds
}

// invite_test.go:617, with devices_test.go:270's rows. A redeeming hello has to
// say which device it is registering, and with what.
//
// These refusals are about the frame rather than about the vault, so they are
// named: an `auth` here would make the shape of a request look like the answer
// to whether the invite exists. None spends the invite, because the shape is
// checked before the store is asked.
func TestARedeemingHelloMustNameTheDeviceItRegisters(t *testing.T) {
	r := newRig(t)
	inv := r.invite(time.Hour)

	for _, c := range []struct {
		what   string
		change func(*wire.In)
		code   string
	}{
		{"no device id", func(in *wire.In) { in.DeviceID = "" }, wire.CodeBadName},
		{"a malformed device id", func(in *wire.In) { in.DeviceID = "not base64!" }, wire.CodeBadName},
		{"a device id over the bound", func(in *wire.In) { in.DeviceID = strings.Repeat("i", store.MaxDeviceIDLen+1) }, wire.CodeBadName},
		{"no token", func(in *wire.In) { in.Token = "" }, wire.CodeBadEntry},
		{"a token too short to be one", func(in *wire.In) { in.Token = "short" }, wire.CodeBadEntry},
		{"a name with a newline in it", func(in *wire.In) { in.Device = "a\nb" }, wire.CodeBadName},
		{"a name over the bound", func(in *wire.In) { in.Device = strings.Repeat("n", store.MaxDeviceLen+1) }, wire.CodeBadName},
	} {
		hello := redeemHello(inv.Token, "phone")
		c.change(&hello)
		if f := redeemRaw(t, r, hello); f["res"] != "err" || f["code"] != c.code {
			t.Fatalf("a redeem with %s was answered %v, want %s", c.what, f, c.code)
		}
	}
	// Every one of them left the invite alone, so the person holding the
	// string can fix their client and try again.
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatalf("%d outstanding invites after the refused redemptions, want 1", n)
	}
	if len(mustDevices(t, r)) != 0 {
		t.Fatal("a refused redemption registered a device")
	}
	if f := redeemAs(t, r, inv.Token, "phone"); f["res"] != "redeemed" {
		t.Fatalf("the invite no longer redeems: %v", f)
	}
}

// invite_test.go:691. A device revoked a moment ago can be added again with an
// invite, and it is a different row: the id it had is not the id it comes back
// with.
func TestARevokedDeviceComesBackWithAnInvite(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	phone := r.dial("phone")
	phone.hello(0)

	a.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("phone")})
	a.recvInto("revoked", &wire.Revoked{})
	waitFor(t, "the revoked device to be closed", func() bool { return phone.closed() })

	issued := issue(t, a, wire.In{})
	if f := redeemAs(t, r, tokenOf(t, issued), "phone-again"); f["res"] != "redeemed" {
		t.Fatalf("a revoked device could not be added again: %v", f)
	}
	cl := r.dial("phone-again")
	cl.sendJSON(wire.In{Op: "hello", Vault: testVault,
		DeviceID: deviceID("phone-again"), Token: deviceKey("phone-again"), Device: "phone"})
	cl.recvInto("ready", &wire.Ready{})
	cl.recvInto("caught-up", &wire.CaughtUp{})

	// The old id stays gone. Coming back is a new row, so the revocation is
	// not undone by it and the list says which is which.
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("phone")); ok {
		t.Fatal("the revoked row came back")
	}
}

// Revoking a device cancels the invites it issued, over the wire: the invite a
// stolen laptop minted before it was revoked does not add the thief's next
// device afterwards (PLAN.md section 2.3.1). One the revoking device issued is
// untouched.
func TestRevokingADeviceCancelsTheInvitesItIssued(t *testing.T) {
	r := newRig(t)
	laptop := r.dial("laptop")
	laptop.hello(0)
	phone := r.dial("phone")
	phone.hello(0)
	stolen := issue(t, laptop, wire.In{})
	mine := issue(t, phone, wire.In{})

	phone.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("laptop")})
	phone.recvInto("revoked", &wire.Revoked{})

	if f := redeemAs(t, r, tokenOf(t, stolen), "thief"); f["code"] != wire.CodeAuth {
		t.Fatalf("an invite the revoked device issued was answered %v", f)
	}
	if f := redeemAs(t, r, tokenOf(t, mine), "tablet"); f["res"] != "redeemed" {
		t.Fatalf("an invite the revoking device issued was answered %v", f)
	}
}
