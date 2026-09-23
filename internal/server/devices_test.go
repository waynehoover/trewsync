package server

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// A device connects as itself, with its own token, and revoking one device
// means something (plan/protocol.md, "Device session" and "Devices and
// invites"). Basalt's version of this file opened with the vault credential
// that could not sync; protocol 1 has no vault credential, and the tests that
// were only about it went with it (plan/strip-ledger.md).

// devices_test.go:96. A device that is not registered and a device whose token
// is wrong get the same refusal, saying neither which. Telling them apart would
// tell a caller which half to keep guessing, and after a revoke it would
// confirm that this id was a device here yesterday.
func TestAnUnknownDeviceAndAWrongKeyAreOneRefusal(t *testing.T) {
	r := newRig(t)
	r.device("a")

	wrongKey := r.dial("wrong-key")
	wrongKey.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: deviceKey("somebody-else"), DeviceID: deviceID("a"), Device: "a"})
	one := wrongKey.expectErr(wire.CodeAuth)

	noRow := r.dial("no-row")
	noRow.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: deviceKey("ghost"), DeviceID: deviceID("ghost"), Device: "ghost"})
	two := noRow.expectErr(wire.CodeAuth)

	malformed := r.dial("malformed")
	malformed.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: "not a token", DeviceID: deviceID("a"), Device: "a"})
	three := malformed.expectErr(wire.CodeAuth)

	if one != two || two != three {
		t.Fatalf("the failures are distinguishable:\n  %q\n  %q\n  %q", one, two, three)
	}
}

// devices_test.go:121, the half that stays. A store with history and no
// devices at all is not a lost vault: the operator mints an invite on the
// server, a new device redeems it, and everything the old devices wrote is
// there. Basalt's way back was the recovery key; TrewSync's is this, and the
// control socket's `trewd invite` is the same CreateInvite.
func TestAStoreWithHistoryAndNoDevicesGetsOneBackFromAnInvite(t *testing.T) {
	r := newRig(t)
	first := r.dial("a")
	first.hello(0)
	uid := first.put("kept.md", "written before every device was lost")
	first.conn.CloseNow()
	// Every device is lost.
	if _, err := r.st.RevokeDevice(testVault, deviceID("a"), r.srv.now().UnixMilli()); err != nil {
		t.Fatalf("losing every device: %v", err)
	}

	inv := r.invite(time.Hour)
	r.dial("replacement").redeem(inv.Token)
	cl := r.dial("replacement")
	_, got := cl.hello(0)
	if len(got) != 1 || got[0].UID != uid || got[0].Path != "kept.md" {
		t.Fatalf("the replacement caught up on %+v, want the note written before", got)
	}
	ds := mustDevices(t, r)
	if len(ds) != 1 || ds[0].ID != deviceID("replacement") {
		t.Fatalf("devices after the recovery: %+v", ds)
	}
}

/* ---------------------------------------------------------------- *
 * Listing
 * ---------------------------------------------------------------- */

// devices_test.go:333. The list names every device with what a person reads it
// by, carries no credential, and is never null. Two devices may share a name,
// because the id is the identity: two laptops both called laptop is a person's
// problem to fix and not the server's to prevent.
func TestTheDeviceListIsUsableAndCarriesNoCredential(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)
	// A second device under the same name, registered straight into the store
	// so that the two really do collide.
	if err := r.st.RegisterDevice(testVault, "twin", "a", hashOf(deviceKey("twin")), 5); err != nil {
		t.Fatalf("registering a second device called a: %v", err)
	}
	// And an outstanding invite, whose token must not reach the list either.
	inv := r.invite(time.Hour)

	a.sendJSON(wire.In{Op: "devices", ID: 40})
	var got wire.DeviceList
	a.recvInto("devices", &got)
	if got.ID != 40 {
		t.Fatalf("the listing was %+v", got)
	}
	if len(got.Devices) != 3 {
		t.Fatalf("%d devices listed, want three: %+v", len(got.Devices), got.Devices)
	}
	names := map[string]int{}
	for _, d := range got.Devices {
		if d.ID == "" {
			t.Fatalf("a listed device has no id: %+v", d)
		}
		names[d.Name]++
	}
	if names["a"] != 2 {
		t.Fatalf("the two devices called a came back as %v", names)
	}

	// Nothing in the frame is a credential. The listing types have no field
	// for one, and this is what catches the day somebody adds it.
	raw := a.recvRawFor(t, wire.In{Op: "devices"})
	for _, secret := range []string{
		hashOf(deviceKey("a")), deviceKey("a"),
		store.EncodeToken(inv.Token), store.HashToken(inv.Token),
	} {
		if strings.Contains(raw, secret) {
			t.Fatalf("the device list carries a credential: %s", raw)
		}
	}

	// A vault with no devices lists as [] and not null, so a client that
	// iterates the result does not crash on exactly the vault it is for.
	// Asked of the parts handleDevices builds its reply from, because there
	// is no device left to ask over the wire.
	for _, id := range []string{deviceID("a"), "twin", deviceID("b")} {
		if _, err := r.st.RevokeDevice(testVault, id, 2); err != nil {
			t.Fatal(err)
		}
	}
	ds, err := r.st.Devices(testVault)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := json.Marshal(wire.DeviceList{Res: "devices", ID: 1, Devices: r.srv.hub.deviceStatus(testVault, ds)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame), `"devices":[]`) {
		t.Fatalf("a vault with no devices lists as %s", frame)
	}
}

// recvRawFor sends one request and returns its reply exactly as it came off
// the wire, since decoding into a struct is what hides the difference between
// [] and null, and hides a field nobody meant to add.
func (c *client) recvRawFor(t *testing.T, m wire.In) string {
	t.Helper()
	c.sendJSON(m)
	return c.recvRaw()
}

/* ---------------------------------------------------------------- *
 * Revoking
 * ---------------------------------------------------------------- */

// devices_test.go:407. A revoked device cannot connect, and the refusal is the
// ordinary one: a revoked device connecting is the system working, not a
// fault.
func TestARevokedDeviceCannotConnect(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)

	b.sendJSON(wire.In{Op: "revoke", ID: 12, DeviceID: deviceID("a")})
	var done wire.Revoked
	b.recvInto("revoked", &done)
	if done.ID != 12 || done.DeviceID != deviceID("a") || done.Self {
		t.Fatalf("revoke was answered %+v", done)
	}

	again := r.dial("a-again")
	again.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: deviceKey("a"), DeviceID: deviceID("a"), Device: "a"})
	again.expectErr(wire.CodeAuth)
	if !again.closed() {
		t.Fatal("a revoked device connected")
	}
}

// devices_test.go:437. Revoking closes the live session the revoked device is
// holding, and says why in words a person can act on.
//
// Deleting the row alone would be a revocation the revoked device never
// notices: it holds an authenticated connection and nothing on a live session
// is re-checked, so a stolen laptop would go on receiving every note pushed to
// the vault for as long as it stayed up, while the panel said it was gone.
func TestRevokingClosesTheRevokedDevicesLiveSession(t *testing.T) {
	r := newRig(t)
	victim := r.dial("a")
	victim.hello(0)
	other := r.dial("b")
	other.hello(0)
	waitFor(t, "both devices to join", func() bool { return r.srv.Peers(testVault) == 2 })

	other.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("a")})
	other.recvInto("revoked", &wire.Revoked{})

	f := rawFields(t, victim.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeAuth || f["id"] != nil {
		t.Fatalf("the revoked device was told %v, want an unsolicited auth error", f)
	}
	msg, _ := f["msg"].(string)
	if !strings.Contains(msg, "revoked") || !strings.Contains(msg, "invite") {
		t.Fatalf("the notice does not say what happened or what to do: %q", msg)
	}
	if !victim.closed() {
		t.Fatal("a revoked device kept its connection and went on receiving")
	}
	waitFor(t, "the revoked session to leave", func() bool { return r.srv.Peers(testVault) == 1 })
}

// devices_test.go:465. Revoking one device disturbs no other device's session
// or sync: the answer to a stolen laptop is not re-pairing the phone, the
// desktop and the NAS.
func TestRevokingOneDeviceDisturbsNoOther(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)
	c := r.dial("c")
	c.hello(0)
	waitFor(t, "three devices to join", func() bool { return r.srv.Peers(testVault) == 3 })

	a.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("c")})
	a.recvInto("revoked", &wire.Revoked{})
	waitFor(t, "the revoked session to leave", func() bool { return r.srv.Peers(testVault) == 2 })

	// a and b are still syncing to each other, mid-session.
	uid := a.put("after-the-revoke.md", "still here")
	if got := b.nextBatch(); got.To != uid || len(got.Entries) != 1 {
		t.Fatalf("the untouched device saw %+v", got)
	}
	// And b's own row is untouched, so it reconnects.
	again := r.dial("b-again")
	again.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: deviceKey("b"), DeviceID: deviceID("b"), Device: "b"})
	again.recvInto("ready", &wire.Ready{})
}

// devices_test.go:494. A device may revoke itself, which is what unlinking is,
// and the session ends: a revoked device does not stay connected, including
// when it is the one that asked.
func TestADeviceMayRevokeItselfAndTheSessionEnds(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)

	a.sendJSON(wire.In{Op: "revoke", ID: 3, DeviceID: deviceID("a")})
	var done wire.Revoked
	a.recvInto("revoked", &done)
	if !done.Self {
		t.Fatalf("a device unlinking itself was not told so: %+v", done)
	}
	if !a.closed() {
		t.Fatal("a device revoked itself and stayed connected")
	}
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("a")); ok {
		t.Fatal("the row survived the device revoking itself")
	}
	// The other device is untouched.
	b.sendJSON(wire.In{Op: "ping"})
	b.recvInto("pong", &wire.Pong{})
}

// devices_test.go:532, decided (hazard 4). A device may revoke the last device
// on the vault, itself included (plan/protocol.md, "Devices and invites").
// Basalt refused it, because what it left was a vault only the recovery key
// opened. TrewSync has no key a device holds that the server cannot reissue, so
// the way back from an empty device list is an invite from the server, and a
// refusal would protect nothing and strand a person who meant it.
func TestADeviceMayRevokeTheLastDevice(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	uid := a.put("still-here.md", "the vault keeps its notes")

	a.sendJSON(wire.In{Op: "revoke", ID: 7, DeviceID: deviceID("a")})
	var done wire.Revoked
	a.recvInto("revoked", &done)
	if !done.Self || done.ID != 7 {
		t.Fatalf("revoking the last device was answered %+v", done)
	}
	if ds := mustDevices(t, r); len(ds) != 0 {
		t.Fatalf("%d devices after the last one was revoked", len(ds))
	}
	// And the way back works, onto the history that was there.
	inv := r.invite(time.Hour)
	r.dial("b").redeem(inv.Token)
	b := r.dial("b")
	if _, got := b.hello(0); len(got) != 1 || got[0].UID != uid {
		t.Fatalf("the device that came back caught up on %+v", got)
	}
}

// devices_test.go:617. A revoke naming a device that is not there is its own
// code: the list the caller was reading is stale and wants refreshing, which is
// a different act from every other refusal a revoke can get.
func TestRevokingADeviceThatIsNotThere(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	a.sendJSON(wire.In{Op: "revoke", ID: 8, DeviceID: "never-registered"})
	m := a.recv()
	if m["res"] != "err" || m["code"] != wire.CodeNoDevice || m["id"] != float64(8) {
		t.Fatalf("revoking an unknown device was answered %v", m)
	}
	if m["retryable"] != false {
		t.Fatalf("nodevice is retryable, so a client would keep asking: %v", m)
	}
	a.sendJSON(wire.In{Op: "revoke", DeviceID: "not base64url!"})
	a.expectErr(wire.CodeBadName)
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// devices_test.go:643. A revoke racing a connect comes out right whichever
// order they land in.
//
// The revoke deletes the row and takes the device's sessions out of the fan-out
// under one lock, and a connecting device joins the fan-out and only then
// stamps itself as seen, under the same lock. So either the delete is first,
// and the stamp finds no row, or the join is first, and the revoke finds the
// session. Here the revoke lands in the narrower of the two windows: after the
// credential has been checked and before the session is in anybody's list.
func TestARevokeRacingAConnectAlwaysWins(t *testing.T) {
	r := newRig(t)
	keeper := r.dial("keeper")
	keeper.hello(0)
	r.device("racer") // registered, so the hello below gets past the credential check

	var once sync.Once
	r.srv.beforeJoin = func() {
		once.Do(func() {
			if _, err := r.st.RevokeDevice(testVault, deviceID("racer"), 2); err != nil {
				t.Errorf("revoking between the credential check and the join: %v", err)
			}
		})
	}

	racer := r.dial("racer")
	racer.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: deviceKey("racer"), DeviceID: deviceID("racer"), Device: "racer"})
	racer.expectErr(wire.CodeAuth)
	if !racer.closed() {
		t.Fatal("a device revoked during its own handshake was served anyway")
	}
	waitFor(t, "the refused session to leave the fan-out",
		func() bool { return r.srv.Peers(testVault) == 1 })
}

// devices_test.go:669. A handshake whose row was revoked and registered again
// under another token does not complete, and the replacement works.
func TestReusingARevokedDeviceIDDoesNotCompleteItsOldHandshake(t *testing.T) {
	r := newRig(t)
	keeper := r.dial("keeper")
	keeper.hello(0)
	r.device("racer")
	freshKey := deviceKey("replacement")
	var once sync.Once
	r.srv.beforeJoin = func() {
		once.Do(func() {
			if _, err := r.st.RevokeDevice(testVault, deviceID("racer"), 2); err != nil {
				t.Errorf("revoke before join: %v", err)
			}
			if err := r.st.RegisterDevice(testVault, deviceID("racer"), "replacement", hashOf(freshKey), 1); err != nil {
				t.Errorf("reuse revoked id: %v", err)
			}
		})
	}
	racer := r.dial("racer")
	racer.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: deviceKey("racer"), DeviceID: deviceID("racer"), Device: "racer"})
	racer.expectErr(wire.CodeAuth)
	if !racer.closed() {
		t.Fatal("the retired credential completed its handshake under a replacement device's id")
	}
	waitFor(t, "the retired session to leave the fan-out", func() bool { return r.srv.Peers(testVault) == 1 })
	d, _, exists, err := r.st.DeviceByID(testVault, deviceID("racer"))
	if err != nil || !exists || d.LastSeen != 0 {
		t.Fatalf("the refused hello marked the replacement as connected: %+v %v %v", d, exists, err)
	}
	// The replacement credential remains usable after the old one is refused.
	replacement := r.dial("replacement")
	replacement.sendJSON(wire.In{Op: "hello", Vault: testVault,
		Token: freshKey, DeviceID: deviceID("racer"), Device: "replacement"})
	replacement.recvInto("ready", &wire.Ready{})
}

/* ---------------------------------------------------------------- *
 * last_seen
 * ---------------------------------------------------------------- */

// devices_test.go:716. last_seen moves on connect and not otherwise. It is the
// only thing that answers "is that laptop still syncing", so a number that
// moved because somebody listed the devices would be a number that always
// looks fine.
func TestLastSeenMovesOnConnectAndNotOtherwise(t *testing.T) {
	r := newRig(t)
	base := r.srv.now()
	r.device("a")
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("a")); !ok {
		t.Fatal("the device was not registered")
	}
	if d, _, _, _ := r.st.DeviceByID(testVault, deviceID("a")); d.LastSeen != 0 {
		t.Fatalf("a device that has never connected has last_seen %d", d.LastSeen)
	}

	cl := r.dial("a")
	cl.hello(0)
	d, _, _, _ := r.st.DeviceByID(testVault, deviceID("a"))
	if d.LastSeen < base.UnixMilli() {
		t.Fatalf("last_seen is %d after connecting, want at least %d", d.LastSeen, base.UnixMilli())
	}
	seen := d.LastSeen

	// Working on the connection does not move it: only a connect does.
	cl.put("note.md", "a body")
	cl.sendJSON(wire.In{Op: "devices"})
	cl.recvInto("devices", &wire.DeviceList{})
	if after, _, _, _ := r.st.DeviceByID(testVault, deviceID("a")); after.LastSeen != seen {
		t.Fatalf("last_seen moved from %d to %d without a connect", seen, after.LastSeen)
	}
}

// devices_test.go:754. A device relabels itself, and only itself.
//
// The gap this closes: a device name was chosen once at pairing and there was
// no way to change it afterwards short of unlinking and pairing again, which
// makes a new row. The name is what the device list, history and conflict copy
// filenames are read by, so a typo or a repurposed laptop was permanent. There
// is no field naming the row: rename is always this device, which is why no
// authorisation rule was needed.
func TestADeviceRenamesItself(t *testing.T) {
	r := newRig(t)
	device := joined(t, r, "a")

	device.sendJSON(wire.In{Op: "rename", ID: 7, Name: "the-good-laptop"})
	var done wire.Renamed
	device.recvInto("renamed", &done)
	if done.Name != "the-good-laptop" {
		t.Fatalf("renamed echoed %q", done.Name)
	}

	// The list is the authority, so it is what is checked.
	device.sendJSON(wire.In{Op: "devices", ID: 8})
	var list wire.DeviceList
	device.recvInto("devices", &list)
	found := ""
	for _, d := range list.Devices {
		if d.ID == deviceID("a") {
			found = d.Name
		}
	}
	if found != "the-good-laptop" {
		t.Fatalf("the device list says %q", found)
	}

	// Again, to a different name, because a rename that only works once is a
	// rename somebody has to be careful with.
	device.sendJSON(wire.In{Op: "rename", Name: "laptop"})
	device.recvInto("renamed", &wire.Renamed{})

	// A name that could not have been chosen at pairing cannot arrive here
	// either: the same CheckName, and the same code every other name refusal
	// uses.
	for _, bad := range []string{"", strings.Repeat("x", store.MaxDeviceLen+1), "two\nlines"} {
		device.sendJSON(wire.In{Op: "rename", Name: bad})
		if msg := device.expectErr(wire.CodeBadName); msg == "" {
			t.Fatalf("a device name of %q was accepted", bad)
		}
	}

	// And the row is still the one it was: a refused rename changes nothing.
	device.sendJSON(wire.In{Op: "devices"})
	list = wire.DeviceList{}
	device.recvInto("devices", &list)
	for _, d := range list.Devices {
		if d.ID == deviceID("a") && d.Name != "laptop" {
			t.Fatalf("a refused rename left the name as %q", d.Name)
		}
	}
}
