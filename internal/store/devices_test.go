package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The devices table and the operations over it: registering, listing,
// revoking and last_seen, and the races between them. A device comes to exist
// by redeeming an invite (invites_test.go); these register rows directly,
// because what they pin is the table.

// Device auth hashes: hex SHA-256, the shape HashToken writes.
var (
	hashA = strings.Repeat("a", 64)
	hashB = strings.Repeat("b", 64)
	hashC = strings.Repeat("c", 64)
)

// revoke is RevokeDevice for the tests that do not count cancelled invites.
func revoke(h *harness, vaultID, deviceID string) error {
	_, err := h.RevokeDevice(vaultID, deviceID, 2000)
	return err
}

// ids returns the device ids of a vault's list, in the order it gave them.
func ids(t *testing.T, h *harness, vaultID string) []string {
	t.Helper()
	ds, err := h.Devices(vaultID)
	if err != nil {
		t.Fatalf("devices: %v", err)
	}
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.ID)
	}
	return out
}

/* ---------------------------------------------------------------- *
 * Registering
 * ---------------------------------------------------------------- */

func TestRegisteringADeviceStoresItAndRefusesADuplicateID(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatalf("register: %v", err)
	}

	d, hash, ok, err := h.DeviceByID("v1", "device-one")
	if err != nil || !ok {
		t.Fatalf("reading back the device just registered: ok=%v err=%v", ok, err)
	}
	if d.ID != "device-one" || d.Name != "laptop" || hash != hashA {
		t.Fatalf("the row came back as %+v with hash %q", d, hash)
	}
	if d.CreatedAt != 1000 {
		t.Fatalf("created_at = %d, want 1000", d.CreatedAt)
	}
	// Zero, not the epoch: a device that has never connected has to be
	// distinguishable from one that connected in 1970.
	if d.LastSeen != 0 {
		t.Fatalf("last_seen = %d on a device that has never connected, want 0", d.LastSeen)
	}

	// The same id again, with a different key, is refused and changes nothing.
	// This is the whole point of the primary key: whoever registered the id
	// owns it, and a second registration cannot quietly replace the credential
	// the first one is syncing under.
	err = h.RegisterDevice("v1", "device-one", "impostor", hashB, 2000)
	if !errors.Is(err, ErrDeviceExists) {
		t.Fatalf("err = %v, want ErrDeviceExists", err)
	}
	d, hash, _, _ = h.DeviceByID("v1", "device-one")
	if hash != hashA || d.Name != "laptop" {
		t.Fatalf("a refused registration overwrote the row: %+v hash %q", d, hash)
	}

	// Another vault may use the same id, because the identity is the pair.
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v2", "device-one", "laptop", hashB, 3000); err != nil {
		t.Fatalf("the same device id on another vault: %v", err)
	}
}

// A device row names a vault this store holds, and a registration onto one it
// does not is refused and writes nothing. (Basalt's version required a claimed
// vault; with no vault credential, existing is what a vault has to do.)
func TestRegisteringADeviceNeedsAVault(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("nosuchvault", "device-one", "laptop", hashA, 1000); !errors.Is(err, ErrUnknownVault) {
		t.Fatalf("err = %v on a vault with no row, want ErrUnknownVault", err)
	}
	if n := len(ids(t, h, "nosuchvault")); n != 0 {
		t.Fatalf("%d devices on a vault the registration was refused for", n)
	}
}

// The name is a label, and it is bounded and control-character free exactly the
// way the `device` name on a hello is, because it is the same name: it defaults
// to what the client already sends and it lands in the same places. One rule,
// in store.CheckName, called from both.
func TestADeviceNameIsOptionalFreeTextBoundedLikeTheWireOne(t *testing.T) {
	h := newTestStore(t)

	// Optional.
	if err := h.RegisterDevice("v1", "device-one", "", hashA, 1000); err != nil {
		t.Fatalf("a device with no name: %v", err)
	}
	// Exactly at the limit, and one byte over it.
	if err := h.RegisterDevice("v1", "device-two", strings.Repeat("n", MaxDeviceLen), hashB, 1001); err != nil {
		t.Fatalf("a name of exactly %d bytes: %v", MaxDeviceLen, err)
	}
	err := h.RegisterDevice("v1", "device-three", strings.Repeat("n", MaxDeviceLen+1), hashC, 1002)
	if !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v for a name of %d bytes, want ErrBadEntry", err, MaxDeviceLen+1)
	}
	// A newline in a name is a forged log line, and this is the same refusal
	// the wire gives.
	if err := h.RegisterDevice("v1", "device-three", "laptop\ninjected", hashC, 1003); !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v for a name with a newline, want ErrBadEntry", err)
	}
	if want := CheckName("device", "laptop\ninjected", MaxDeviceLen); want == nil {
		t.Fatal("store.CheckName accepts a control character, so the wire does too")
	}
	// Never unique. Two laptops both called laptop is a person's problem and
	// not the server's to prevent, and the list stays usable because the id is
	// the identity.
	if err := h.RegisterDevice("v1", "device-four", "laptop", hashC, 1004); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "device-five", "laptop", hashC, 1005); err != nil {
		t.Fatalf("a second device with the same name: %v", err)
	}
	if got := ids(t, h, "v1"); len(got) != 4 {
		t.Fatalf("devices = %v, want the four that were accepted", got)
	}
}

func TestRegisteringADeviceRefusesAMalformedIDOrHash(t *testing.T) {
	h := newTestStore(t)
	for _, c := range []struct {
		why, id, hash string
	}{
		{"empty id", "", hashA},
		{"id that is not base64url", "device one", hashA},
		{"id over the bound", strings.Repeat("d", MaxDeviceIDLen+1), hashA},
		{"empty hash", "device-one", ""},
		{"hash that is not hex", "device-one", strings.Repeat("z", 64)},
		{"hash of the wrong length", "device-one", strings.Repeat("a", 63)},
	} {
		if err := h.RegisterDevice("v1", c.id, "laptop", c.hash, 1000); !errors.Is(err, ErrBadEntry) {
			t.Fatalf("%s: err = %v, want ErrBadEntry", c.why, err)
		}
	}
	if n := len(ids(t, h, "v1")); n != 0 {
		t.Fatalf("%d devices registered by refused calls", n)
	}
}

/* ---------------------------------------------------------------- *
 * Listing
 * ---------------------------------------------------------------- */

// Rule 7: a list a person reads has to be the same list twice. created_at is a
// millisecond, so registrations that share one need a tiebreak or the order is
// the query plan's opinion. What this can see is that the order is total and
// repeatable; it cannot see the tiebreak itself, because today's plan scans the
// primary key and sorts stably over it. See Devices.
func TestDevicesListsInAStableOrderAndNeverReturnsNil(t *testing.T) {
	h := newTestStore(t)

	// A vault with no devices is an empty list and not an error, and not nil
	// either: nil marshals to JSON null and a client that iterates it crashes
	// on exactly the vault it has to handle.
	empty, err := h.Devices("v1")
	if err != nil {
		t.Fatalf("devices of a vault with none: %v", err)
	}
	if empty == nil {
		t.Fatal("a vault with no devices returned a nil slice, which is null on the wire")
	}
	if b, _ := json.Marshal(empty); string(b) != "[]" {
		t.Fatalf("a vault with no devices marshals to %s, want []", b)
	}

	// Registered newest first, and five of the six sharing one millisecond, so
	// that created_at alone cannot order them: without the tiebreak they come
	// back in whatever order the sorter happened to leave them, which here is
	// the order they were written in.
	for i, id := range []string{"zulu", "yankee", "xray", "whisky", "victor"} {
		if err := h.RegisterDevice("v1", id, "same millisecond", hashA, 1000); err != nil {
			t.Fatalf("register %s: %v", id, err)
		}
		_ = i
	}
	if err := h.RegisterDevice("v1", "alfa", "later", hashB, 2000); err != nil {
		t.Fatal(err)
	}
	want := []string{"victor", "whisky", "xray", "yankee", "zulu", "alfa"} // created_at, then id
	for i := 0; i < 5; i++ {
		got := ids(t, h, "v1")
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("call %d listed %v, want %v", i, got, want)
		}
	}
}

// The listing is what a list op sends to every device. A credential hash that
// lives in the listing type reaches all of them the first time somebody
// serialises it, so the type does not have the field: this fails the moment one
// is added.
func TestADeviceListingCarriesNoCredential(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	ds, err := h.Devices("v1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(ds)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), hashA) {
		t.Fatalf("the device listing carries the auth hash: %s", b)
	}
}

func TestDeviceByIDCarriesTheHashAndSaysWhenThereIsNoRow(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	// Not there is not an error: a revoked device connecting is the system
	// working, and the caller turns both into one refusal.
	d, hash, ok, err := h.DeviceByID("v1", "device-two")
	if err != nil {
		t.Fatalf("unknown device: %v", err)
	}
	if ok {
		t.Fatalf("an unregistered device came back as %+v", d)
	}
	if hash != "" {
		t.Fatalf("an unregistered device came back with hash %q", hash)
	}
	// Nor is a vault that does not exist.
	if _, _, ok, err := h.DeviceByID("nosuchvault", "device-one"); ok || err != nil {
		t.Fatalf("unknown vault: ok=%v err=%v", ok, err)
	}
	// And the id is scoped to its vault.
	if _, _, ok, _ := h.DeviceByID("v2", "device-one"); ok {
		t.Fatal("a device registered on v1 was found on v2")
	}
	if _, hash, ok, _ := h.DeviceByID("v1", "device-one"); !ok || hash != hashA {
		t.Fatalf("the registered device: ok=%v hash=%q", ok, hash)
	}
}

/* ---------------------------------------------------------------- *
 * Revoking
 * ---------------------------------------------------------------- */

func TestRevokingADeviceLeavesEveryOtherDeviceAlone(t *testing.T) {
	h := newTestStore(t)
	for i, id := range []string{"alfa", "bravo", "charlie"} {
		if err := h.RegisterDevice("v1", id, id, hashA, int64(1000+i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.SawDevice("v1", "charlie", 5000); err != nil {
		t.Fatal(err)
	}
	if err := revoke(h, "v1", "bravo"); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	if _, _, ok, _ := h.DeviceByID("v1", "bravo"); ok {
		t.Fatal("the revoked device still has a row, so it can still connect")
	}
	if got := ids(t, h, "v1"); strings.Join(got, ",") != "alfa,charlie" {
		t.Fatalf("after revoking bravo the list is %v", got)
	}
	// Nothing else moved: not the names, not created_at, not last_seen.
	d, hash, ok, err := h.DeviceByID("v1", "charlie")
	if err != nil || !ok {
		t.Fatalf("charlie: ok=%v err=%v", ok, err)
	}
	if d.Name != "charlie" || d.CreatedAt != 1002 || d.LastSeen != 5000 || hash != hashA {
		t.Fatalf("revoking bravo disturbed charlie: %+v hash %q", d, hash)
	}
	// And it is a delete, so revoking it again is unknown rather than a
	// second success.
	if err := revoke(h, "v1", "bravo"); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v revoking an already revoked device, want ErrUnknownDevice", err)
	}
}

// The spec's claim that a delete loses nothing rests on the audit trail being
// somewhere else. It is: entries.device is a column on rows revocation never
// touches, so what a revoked device wrote is still attributed to it.
func TestRevokingADeviceDoesNotTouchTheHistoryItWrote(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	e := h.file(t, "note.md", "written by the device about to be revoked")
	if err := h.RegisterDevice("v1", "device-two", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := revoke(h, "v1", "device-one"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	got, ok, err := h.EntryByUID("v1", e.UID)
	if err != nil || !ok {
		t.Fatalf("the entry after revoking its writer: ok=%v err=%v", ok, err)
	}
	if got.Device != "d1" || len(got.Chunks) != 1 {
		t.Fatalf("revoking rewrote history: %+v", got)
	}
}

// Hazard 4, decided: revoking the last device is allowed (plan/protocol.md,
// "Devices and invites"). Basalt refused it, because what it left was a vault
// only the recovery key opened; Trew has no key a device holds that the
// server cannot reissue, and the way back is an invite from the server. So the
// last revoke succeeds, the history it leaves is untouched, and the vault can
// still be given a device.
func TestRevokingTheLastDeviceIsAllowed(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	e := h.file(t, "note.md", "still here")
	if err := revoke(h, "v1", "alfa"); err != nil {
		t.Fatalf("revoking the last device: %v", err)
	}
	if n := len(ids(t, h, "v1")); n != 0 {
		t.Fatalf("%d devices left after revoking the last one", n)
	}
	if got, ok, err := h.EntryByUID("v1", e.UID); err != nil || !ok || got.Path != "note.md" {
		t.Fatalf("revoking the last device touched the history: %+v %v %v", got, ok, err)
	}
	expires := int64(9000)
	inv, err := h.CreateInvite("v1", "", "", &expires, 3000)
	if err != nil {
		t.Fatalf("an invite for a vault with no devices: %v", err)
	}
	if err := redeem(h, "v1", inv.Token, "bravo", "phone", hashB, 3000); err != nil {
		t.Fatalf("the way back: %v", err)
	}
}

// "There is no such device" is its own answer, and never a quiet success: a
// revoke that reported done for a typo would have somebody believing a device
// was gone that is still connected.
func TestRevokingAnUnknownDeviceIsUnknown(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := revoke(h, "v1", "typo"); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v, want ErrUnknownDevice", err)
	}
	if err := revoke(h, "nosuchvault", "alfa"); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v on an unknown vault, want ErrUnknownDevice", err)
	}
	if n := len(ids(t, h, "v1")); n != 1 {
		t.Fatalf("%d devices after two refused revokes, want 1", n)
	}
}

/* ---------------------------------------------------------------- *
 * last_seen
 * ---------------------------------------------------------------- */

func TestSawDeviceMovesLastSeenAndNothingElse(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 4242); err != nil {
		t.Fatalf("saw: %v", err)
	}
	d, hash, ok, err := h.DeviceByID("v1", "alfa")
	if err != nil || !ok {
		t.Fatalf("alfa: ok=%v err=%v", ok, err)
	}
	if d.LastSeen != 4242 {
		t.Fatalf("last_seen = %d, want 4242", d.LastSeen)
	}
	if d.ID != "alfa" || d.Name != "laptop" || d.CreatedAt != 1000 || hash != hashA {
		t.Fatalf("SawDevice changed something else: %+v hash %q", d, hash)
	}
	// And nothing on any other device.
	other, otherHash, _, _ := h.DeviceByID("v1", "bravo")
	if other.LastSeen != 0 || other.Name != "phone" || other.CreatedAt != 1001 || otherHash != hashB {
		t.Fatalf("SawDevice on alfa moved bravo: %+v hash %q", other, otherHash)
	}
}

// Rule 8: the number is what gets believed. The clock is the server's, so an
// NTP step or two calls landing out of order is all it takes, and a last_seen
// that goes backwards reads as "that laptop has not been here since Tuesday"
// about a device that was here a minute ago.
func TestSawDeviceNeverMovesLastSeenBackwards(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 9000); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 5000); err != nil {
		t.Fatalf("a late call is not an error, it is just late: %v", err)
	}
	d, _, _, _ := h.DeviceByID("v1", "alfa")
	if d.LastSeen != 9000 {
		t.Fatalf("last_seen went back to %d, want it held at 9000", d.LastSeen)
	}
	if err := h.SawDevice("v1", "alfa", 9001); err != nil {
		t.Fatal(err)
	}
	if d, _, _, _ := h.DeviceByID("v1", "alfa"); d.LastSeen != 9001 {
		t.Fatalf("last_seen = %d after a later sighting, want 9001", d.LastSeen)
	}
}

// An upsert here would hand a revoked device its row back, which is the one
// thing revocation has to mean. It says so instead, so a session can tell it
// was revoked while connected and stop rather than retry.
func TestSawDeviceOnARevokedDeviceSaysSoAndDoesNotRecreateIt(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := revoke(h, "v1", "bravo"); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "bravo", 7000); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v, want ErrUnknownDevice", err)
	}
	if _, _, ok, _ := h.DeviceByID("v1", "bravo"); ok {
		t.Fatal("SawDevice put a revoked device's row back")
	}
	if got := ids(t, h, "v1"); strings.Join(got, ",") != "alfa" {
		t.Fatalf("devices = %v, want just alfa", got)
	}
}

/* ---------------------------------------------------------------- *
 * Races
 * ---------------------------------------------------------------- */

// Registration and revocation race with live sessions and with each other, and
// the store is opened by more than one process (`trew backup` and `trew
// purge` run against a live server's directory), so the guarantees have to be
// in the SQL rather than in this process's mutex.

func TestConcurrentRegistrationsOfOneIDProduceOneRow(t *testing.T) {
	h := newTestStore(t)
	const racers = 8
	errs := make([]error, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = h.RegisterDevice("v1", "contested", "laptop", hashA, int64(1000+i))
		}(i)
	}
	wg.Wait()

	won := 0
	for i, err := range errs {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrDeviceExists):
		default:
			t.Fatalf("racer %d: %v, want nil or ErrDeviceExists", i, err)
		}
	}
	if won != 1 {
		t.Fatalf("%d of %d registrations of one id succeeded, want exactly 1", won, racers)
	}
	if got := ids(t, h, "v1"); len(got) != 1 {
		t.Fatalf("devices = %v, want one row", got)
	}
}

// Two devices registering the same id under *different* keys at the same
// moment, which is the other half of the race above.
//
// TestConcurrentRegistrationsOfOneIDProduceOneRow races eight registrations of
// one id under one key. That is the crash-and-retry case, and it cannot see a
// flip: every racer wants the same row, so a row that changed hands would look
// exactly like a row that did not. This is the case where the two callers want
// different rows under one name. The loser must change nothing, because a
// registration that overwrote auth_hash would hand somebody else's device this
// id and this credential, and both callers would be told they had succeeded.
//
// Two handles on one directory, or writeMu would be what makes it true rather
// than the insert's ON CONFLICT DO NOTHING; see
// TestConcurrentRevokesCannotEmptyTheVault.
//
// The lost-reply retry of a redemption, which does succeed under the same key,
// is recognised by the invite that was spent on the row rather than by the
// row alone; see TestALostReplyRetrySucceedsEvenAfterExpiry.
//
// Checked to fail rather than assumed to: with the insert's ON CONFLICT clause
// changed to DO UPDATE SET auth_hash = excluded.auth_hash, both racers win and
// this reports it on the first attempt.
func TestConcurrentRegistrationsOfOneIDUnderTwoKeysCannotFlipTheRow(t *testing.T) {
	hashes := [2]string{hashA, hashB}
	names := [2]string{"laptop", "somebody-elses"}
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if err := one.EnsureVault("v1", 1000); err != nil {
			t.Fatal(err)
		}
		two := openAt(t, dir)

		var errs [2]error
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i, h := range [2]*harness{one, two} {
			wg.Add(1)
			go func(i int, h *harness) {
				defer wg.Done()
				<-start
				errs[i] = h.RegisterDevice("v1", "contested", names[i], hashes[i], int64(1000+i))
			}(i, h)
		}
		close(start)
		wg.Wait()

		won, winner := 0, -1
		for i, err := range errs {
			switch {
			case err == nil:
				won++
				winner = i
			case errors.Is(err, ErrDeviceExists):
			default:
				t.Fatalf("attempt %d: racer %d got %v, want nil or ErrDeviceExists", attempt, i, err)
			}
		}
		if won != 1 {
			t.Fatalf("attempt %d: %d of 2 registrations of one id succeeded, want exactly 1 (%v)",
				attempt, won, errs)
		}
		if got := ids(t, one, "v1"); len(got) != 1 || got[0] != "contested" {
			t.Fatalf("attempt %d: devices = %v, want the one contested row", attempt, got)
		}
		// The credential, which is the whole of what a flip would take: the
		// loser's key on the winner's row is the loser holding this device.
		_, hash, ok, err := one.DeviceByID("v1", "contested")
		if err != nil || !ok {
			t.Fatalf("attempt %d: reading the row back: ok=%v err=%v", attempt, ok, err)
		}
		if hash != hashes[winner] {
			t.Fatalf("attempt %d: racer %d won and the row holds %q, which is the loser's key",
				attempt, winner, hash)
		}
		ds, err := one.Devices("v1")
		if err != nil {
			t.Fatal(err)
		}
		if ds[0].Name != names[winner] {
			t.Fatalf("attempt %d: the refused registration renamed the row to %q", attempt, ds[0].Name)
		}

		one.Close()
		two.Close()
	}
}

// Two processes revoking one device at the same moment. Exactly one deletes
// it; the other is told it is not there, rather than both reporting a revoke
// that happened once, and the invites the device issued are cancelled once,
// in the transaction that deleted it.
//
// Through two Store handles on one directory, because that is the shape the
// guarantee has to survive: writeMu makes a read-then-write atomic within one
// process, and the store is opened by more than one process (`trew
// backup` and `trew purge` run against a live server's directory, and
// `trew revoke` does when no server is running).
//
// Basalt's version of this raced two devices revoking each other and asserted
// that the vault never ended empty. With the last-device rule gone (hazard 4)
// that is a legal outcome, so what is pinned is the delete's own atomicity.
func TestConcurrentRevokesOfOneDeviceDeleteItOnce(t *testing.T) {
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if err := one.EnsureVault("v1", 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
			t.Fatal(err)
		}
		expires := int64(9000)
		if _, err := one.CreateInvite("v1", "", "alfa", &expires, 1000); err != nil {
			t.Fatal(err)
		}
		two := openAt(t, dir)

		errs := make([]error, 2)
		cancelled := make([]int, 2)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i, h := range []*harness{one, two} {
			wg.Add(1)
			go func(i int, h *harness) {
				defer wg.Done()
				<-start
				cancelled[i], errs[i] = h.RevokeDevice("v1", "alfa", 2000)
			}(i, h)
		}
		close(start)
		wg.Wait()

		gone, unknown := 0, 0
		for _, err := range errs {
			switch {
			case err == nil:
				gone++
			case errors.Is(err, ErrUnknownDevice):
				unknown++
			default:
				t.Fatalf("attempt %d: %v, want nil or ErrUnknownDevice", attempt, err)
			}
		}
		if gone != 1 || unknown != 1 {
			t.Fatalf("attempt %d: %d revoked and %d unknown, want one of each", attempt, gone, unknown)
		}
		if cancelled[0]+cancelled[1] != 1 {
			t.Fatalf("attempt %d: the invites were cancelled %d times, want once", attempt, cancelled[0]+cancelled[1])
		}
		if survivors := ids(t, one, "v1"); strings.Join(survivors, ",") != "bravo" {
			t.Fatalf("attempt %d: devices %v after revoking alfa twice, want bravo", attempt, survivors)
		}
		if err := one.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
		if err := two.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}
}

// A device being revoked while its session is still calling SawDevice. Neither
// call may resurrect the row or corrupt the other, and -race says so about the
// store's own locking.
func TestRevokingRacesASessionsHeartbeatWithoutResurrectingIt(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			// Either it is still registered or it is not; both are answers.
			if err := h.SawDevice("v1", "bravo", int64(2000+i)); err != nil && !errors.Is(err, ErrUnknownDevice) {
				t.Errorf("saw: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		if err := revoke(h, "v1", "bravo"); err != nil {
			t.Errorf("revoke: %v", err)
		}
	}()
	wg.Wait()

	if _, _, ok, _ := h.DeviceByID("v1", "bravo"); ok {
		t.Fatal("a heartbeat racing a revoke put the row back")
	}
	if got := ids(t, h, "v1"); strings.Join(got, ",") != "alfa" {
		t.Fatalf("devices = %v, want just alfa", got)
	}
}

/* ---------------------------------------------------------------- *
 * Durability
 * ---------------------------------------------------------------- */

// Device rows are the answer to "every device is lost", so a backup without
// them is a backup that restores a vault nobody can connect to. They are rows
// in the database and VACUUM INTO copies the database, which is why this
// works; checked rather than assumed.
func TestDeviceRowsSurviveBackupAndRestore(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 5000); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dest, false); err != nil {
		t.Fatalf("backup: %v", err)
	}
	restored := openAt(t, dest)

	got, err := restored.Devices("v1")
	if err != nil {
		t.Fatalf("devices of the restored store: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("the restored store has %d devices, want 2", len(got))
	}
	if got[0].ID != "alfa" || got[0].Name != "laptop" || got[0].LastSeen != 5000 {
		t.Fatalf("alfa came back as %+v", got[0])
	}
	// The credential too, or every restored device is refused at hello.
	if _, hash, ok, _ := restored.DeviceByID("v1", "bravo"); !ok || hash != hashB {
		t.Fatalf("bravo came back with ok=%v hash=%q", ok, hash)
	}
}

/* ---------------------------------------------------------------- *
 * No cap
 * ---------------------------------------------------------------- */

// Adding devices preserves every existing credential and last-seen value.
func TestRegisteringMoreDevicesPreservesExistingDevices(t *testing.T) {
	h := newTestStore(t)
	// Seed existing registrations before adding another.
	const over = 24
	for i := 0; i < over; i++ {
		id := fmt.Sprintf("device-%d", i)
		if err := h.RegisterDevice("v1", id, id, hashA, int64(1000+i)); err != nil {
			t.Fatalf("seeding device %d: %v", i, err)
		}
	}
	if err := h.RegisterDevice("v1", "another", "phone", hashB, 2000); err != nil {
		t.Fatalf("adding another device: %v", err)
	}
	got := ids(t, h, "v1")
	if len(got) != over+1 {
		t.Fatalf("%d devices after the refusal, want %d", len(got), over+1)
	}
	for i := 0; i < over; i++ {
		id := fmt.Sprintf("device-%d", i)
		if _, hash, ok, _ := h.DeviceByID("v1", id); !ok || hash != hashA {
			t.Fatalf("%s stopped being a device: ok=%v hash=%q", id, ok, hash)
		}
		if err := h.SawDevice("v1", id, 5000); err != nil {
			t.Fatalf("%s could not connect: %v", id, err)
		}
	}
}

// I2. A rotted registry row is one device locked out with "not authorised" and
// nothing anywhere that ever says the registry is unsound.
//
// `verify -deep` re-read every chunk body against its name and walked past the
// devices and invites tables entirely, so a vault whose device row had lost a
// character from its auth hash verified clean, deeply, right up until somebody
// tried to connect. These are the same predicates the writes use, so a row
// that would be refused today is a fault however it came to be there.
func TestDeepVerifyDecodesTheRegistry(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	if err := h.RegisterDevice("v1", "sound", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	inv := mint(t, h, "v1", 9000, 1000)
	row := `invite "` + inv.ID + `"`
	where := ` WHERE id = '` + inv.ID + `'`

	// Clean, and the numbers say what was opened rather than only that nothing
	// was wrong with it (rule 8): one chunk reference, one device, one invite.
	sound, err := h.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(sound.Faults) != 0 {
		t.Fatalf("a sound vault reported %v", sound.Faults)
	}
	if sound.Chunks != 1 || sound.Rows != 2 {
		t.Fatalf("checked %d chunk references and %d registry rows, want 1 and 2",
			sound.Chunks, sound.Rows)
	}
	// A shallow pass does not open them, and must not report that it did.
	shallow, err := h.Verify(false)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if shallow.Rows != 0 {
		t.Fatalf("a shallow pass claims %d registry rows checked", shallow.Rows)
	}

	exec := func(t *testing.T, query string) {
		t.Helper()
		if _, err := h.db.Exec(query); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	for _, c := range []struct{ what, rot, undo, reason, row, detail string }{
		{
			"a device whose auth hash lost most of itself",
			`UPDATE devices SET auth_hash = '0123' WHERE device_id = 'sound'`,
			`UPDATE devices SET auth_hash = '` + hashA + `' WHERE device_id = 'sound'`,
			"baddevice", `device "sound"`, "not authorised",
		},
		{
			"a device id that is not base64url",
			`UPDATE devices SET device_id = 'not base64!' WHERE device_id = 'sound'`,
			`UPDATE devices SET device_id = 'sound' WHERE device_id = 'not base64!'`,
			"baddevice", `device "not base64!"`, "base64url",
		},
		{
			"a device made at the epoch",
			`UPDATE devices SET created_at = 0 WHERE device_id = 'sound'`,
			`UPDATE devices SET created_at = 1000 WHERE device_id = 'sound'`,
			"baddevice", `device "sound"`, "not a time",
		},
		{
			"a device name with a control character in it",
			`UPDATE devices SET name = 'lap` + "\x07" + `top' WHERE device_id = 'sound'`,
			`UPDATE devices SET name = 'laptop' WHERE device_id = 'sound'`,
			"baddevice", `device "sound"`, "control character",
		},
		{
			"a device row on a vault this database does not hold",
			`INSERT INTO devices (vault_id, device_id, name, auth_hash, created_at, last_seen)
			 VALUES ('ghost', 'stray', 'phone', '` + hashB + `', 1000, 0)`,
			`DELETE FROM devices WHERE vault_id = 'ghost'`,
			"novault", `device "stray"`, "names a vault this database does not hold",
		},
		{
			"an invite whose token hash lost most of itself",
			`UPDATE invites SET token_hash = '0123'` + where,
			`UPDATE invites SET token_hash = '` + HashToken(inv.Token) + `'` + where,
			"badinvite", row, "nothing can ever redeem it",
		},
		{
			"an invite that expires at a time nothing could have issued it with",
			`UPDATE invites SET expires_at = 0` + where,
			`UPDATE invites SET expires_at = 9000` + where,
			"badinvite", row, "not a time",
		},
		{
			"an invite marked spent without saying by whom",
			`UPDATE invites SET used_at = 1500` + where,
			`UPDATE invites SET used_at = NULL` + where,
			"badinvite", row, "without saying by whom",
		},
		{
			"an invite cancelled and spent at once",
			`UPDATE invites SET used_at = 1500, used_by = 'sound', cancelled_at = 1500` + where,
			`UPDATE invites SET used_at = NULL, used_by = NULL, cancelled_at = NULL` + where,
			"badinvite", row, "cancelled and spent at once",
		},
		{
			"an invite issued by a device id that cannot be one",
			`UPDATE invites SET issued_by = 'not base64!'` + where,
			`UPDATE invites SET issued_by = NULL` + where,
			"badinvite", row, "impossible device id",
		},
	} {
		t.Run(c.what, func(t *testing.T) {
			exec(t, c.rot)
			defer exec(t, c.undo)

			rotted, err := h.Verify(true)
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			if len(rotted.Faults) != 1 {
				t.Fatalf("verify -deep found %d faults, want 1: %v", len(rotted.Faults), rotted.Faults)
			}
			f := rotted.Faults[0]
			if f.Reason != c.reason || f.Row != c.row || !strings.Contains(f.Detail, c.detail) {
				t.Fatalf("the fault is %+v, want reason %q on %s mentioning %q",
					f, c.reason, c.row, c.detail)
			}
			// It names the row, and it names it in words: a fault printed as
			// uid 0 would send somebody looking for an entry.
			if !strings.Contains(f.String(), c.row) {
				t.Fatalf("printed as %q, which does not name the row", f.String())
			}
			// And a shallow pass still reports nothing, so this is what -deep
			// buys rather than something the cheap pass was doing all along.
			shallow, err := h.Verify(false)
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			if len(shallow.Faults) != 0 {
				t.Fatalf("a shallow pass reported %v", shallow.Faults)
			}
		})
	}

	// Undone, and clean again: every case above put the row back.
	after, err := h.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(after.Faults) != 0 || after.Rows != 2 {
		t.Fatalf("after putting every row back: %d faults over %d rows (%v)",
			len(after.Faults), after.Rows, after.Faults)
	}
}
