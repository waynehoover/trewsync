package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// Invites at the store: the table, the five steps of a redemption and their
// order, single use under real concurrency, and what a backup carries. Most of
// these were Basalt's keys_test.go, whose invites held a sealed data key; the
// properties are the same with a bearer token in its place, and the ledger
// (plan/strip-ledger.md) says which assertion each one keeps.

// A device's auth hash: a digest of a token the server never holds.
var (
	devHash1 = HashToken([]byte("device-one-token"))
	devHash2 = HashToken([]byte("device-two-token"))
)

// mint issues an invite on v1 expiring at expires, issued by the operator.
func mint(t *testing.T, h *harness, vaultID string, expires, now int64) NewInvite {
	t.Helper()
	inv, err := h.CreateInvite(vaultID, "", "", &expires, now)
	if err != nil {
		t.Fatalf("create invite: %v", err)
	}
	return inv
}

// redeem is RedeemInvite for a test that does not care whether it was a retry.
func redeem(h *harness, vaultID string, token []byte, deviceID, name, hash string, now int64) error {
	_, err := h.RedeemInvite(vaultID, token, deviceID, name, hash, now)
	return err
}

// otherToken is a well-formed invite token that no invite was minted with.
func otherToken() []byte { return []byte("sixteen byte tok") }

// spent reports whether the invite with this id is marked redeemed.
func spent(t *testing.T, h *harness, id string) bool {
	t.Helper()
	var usedAt sql.NullInt64
	if err := h.db.QueryRow(`SELECT used_at FROM invites WHERE id = ?`, id).Scan(&usedAt); err != nil {
		t.Fatalf("reading invite %s: %v", id, err)
	}
	return usedAt.Valid
}

// keys_test.go:107. Single use, expiry, and one refusal for everything else.
func TestI23InvitesAreSingleUseAndExpire(t *testing.T) {
	h := newTestStore(t)
	expires := int64(2000)
	// No vault: nothing to invite to.
	if _, err := h.CreateInvite("nosuchvault", "", "", &expires, 1000); !errors.Is(err, ErrUnknownVault) {
		t.Fatalf("err = %v, want ErrUnknownVault", err)
	}
	inv := mint(t, h, "v1", 2000, 1000)
	if len(inv.Token) != InviteTokenBytes || !ValidInviteID(inv.ID) {
		t.Fatalf("minted %+v, want a %d-byte token and a well-formed id", inv, InviteTokenBytes)
	}
	// An expiry in the past is refused at insert.
	past := int64(500)
	if _, err := h.CreateInvite("v1", "", "", &past, 1000); !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v, want ErrBadEntry", err)
	}
	// Redeemed once, which registers the device that redeemed it.
	if err := redeem(h, "v1", inv.Token, "dev-one", "one", devHash1, 1500); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if ds, err := h.Devices("v1"); err != nil || len(ds) != 1 || ds[0].ID != "dev-one" || ds[0].Name != "one" {
		t.Fatalf("the redemption registered %v, %v", ds, err)
	}
	if err := redeem(h, "v1", inv.Token, "dev-two", "two", devHash2, 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("an invite was redeemed twice: %v", err)
	}
	// Expired, unknown and malformed are the same refusal.
	stale := mint(t, h, "v1", 2000, 1000)
	for _, c := range []struct {
		what  string
		token []byte
		now   int64
	}{
		{"expired", stale.Token, 2001},
		{"unknown", otherToken(), 1500},
		{"malformed", []byte("short"), 1500},
		{"empty", nil, 1500},
	} {
		if err := redeem(h, "v1", c.token, "dev-two", "two", devHash2, c.now); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("an %s invite was answered %v, want ErrNoInvite", c.what, err)
		}
	}
	// Another vault's invite does not open this one.
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatal(err)
	}
	theirs := mint(t, h, "v2", 5000, 1000)
	if err := redeem(h, "v1", theirs.Token, "dev-two", "two", devHash2, 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("an invite was redeemed against the wrong vault: %v", err)
	}
	// Not one of the refusals wrote a row, and none of them spent the invite
	// on v2 either: a redemption is both halves or neither.
	if ds, _ := h.Devices("v1"); len(ds) != 1 {
		t.Fatalf("a refused redemption registered a device: %v", ds)
	}
	if n, _ := h.OutstandingInvites("v2", 1500); n != 1 {
		t.Fatalf("%d outstanding invites on v2, want the one that was issued", n)
	}
	// And the stale one was not spent by being tried after it expired.
	if spent(t, h, stale.ID) {
		t.Fatal("an expired invite that was refused is marked spent")
	}
}

// keys_test.go:177, and hazard 1. Invites lists what could still be redeemed,
// in a stable order, and carries nothing that would let a reader redeem one.
//
// The listing type has an id, a label and an expiry, which is the property and
// not an accident of what this test asks for. A Trew invite token is the
// whole credential, so a listing that carried it, or its digest, or anything
// derived from it, would hand a working invite to every paired device.
func TestInvitesListsWhatCanStillBeRedeemed(t *testing.T) {
	h := newTestStore(t)
	if got, err := h.Invites("v1", 1000); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("a vault with no invites answered %#v, %v; never nil", got, err)
	}
	// Issued out of expiry order, so the ordering is the function's rather
	// than the insertion's, with one that never expires, which lists last.
	late := mint(t, h, "v1", 9000, 1000)
	soon := mint(t, h, "v1", 3000, 1000)
	mid := mint(t, h, "v1", 6000, 1000)
	never, err := h.CreateInvite("v1", "the tablet", "", nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	got, err := h.Invites("v1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	at := func(v int64) *int64 { return &v }
	want := []Invite{
		{ID: soon.ID, ExpiresAt: at(3000)},
		{ID: mid.ID, ExpiresAt: at(6000)},
		{ID: late.ID, ExpiresAt: at(9000)},
		{ID: never.ID, Label: "the tablet"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Invites = %+v, want %+v, soonest to expire first and never last", got, want)
	}

	// Nothing in it redeems, field by field: no listed value is, contains or
	// hashes to a token, and the listed id redeems nothing when offered as one.
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, inv := range []NewInvite{late, soon, mid, never} {
		for _, secret := range []string{EncodeToken(inv.Token), HashToken(inv.Token), string(inv.Token)} {
			if strings.Contains(string(b), secret) {
				t.Fatalf("the listing carries a token or its digest: %s", b)
			}
		}
	}
	for _, listed := range got {
		for _, field := range []string{listed.ID, listed.Label} {
			if raw, ok := DecodeToken(field, InviteTokenBytes); ok {
				if err := redeem(h, "v1", raw, "prober", "prober", devHash2, 1000); !errors.Is(err, ErrNoInvite) {
					t.Fatalf("a listed field redeemed an invite: %q, %v", field, err)
				}
			}
			if err := redeem(h, "v1", []byte(field), "prober", "prober", devHash2, 1000); !errors.Is(err, ErrNoInvite) {
				t.Fatalf("a listed field redeemed an invite: %q, %v", field, err)
			}
		}
	}

	// Spent and expired are not outstanding: a list that showed either would
	// be showing strings that no longer work.
	if err := redeem(h, "v1", soon.Token, "dev-one", "one", devHash1, 1500); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	got, _ = h.Invites("v1", 6500)
	if len(got) != 2 || got[0].ID != late.ID || got[1].ID != never.ID {
		t.Fatalf("after a redemption and an expiry: %+v", got)
	}
	// Another vault's invites are not this one's.
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatal(err)
	}
	mint(t, h, "v2", 9000, 1000)
	if got, _ := h.Invites("v1", 1000); len(got) != 3 {
		t.Fatalf("v1 shows %+v, which includes another vault's", got)
	}
}

// keys_test.go:240. Cancelling an invite retires the string somebody is
// holding, before it expires.
//
// Unknown, expired, already redeemed and malformed are one error, the same
// ErrNoInvite a redemption gets and for the same reason: saying which would
// tell somebody guessing ids that they had found a real one.
func TestCancellingAnInviteRetiresTheString(t *testing.T) {
	h := newTestStore(t)
	inv := mint(t, h, "v1", 9000, 1000)
	if err := h.CancelInvite("v1", inv.ID, 1500); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if got, _ := h.Invites("v1", 1500); len(got) != 0 {
		t.Fatalf("a cancelled invite is still outstanding: %+v", got)
	}
	// It no longer redeems, which is the whole point.
	if err := redeem(h, "v1", inv.Token, "dev-one", "one", devHash1, 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("a cancelled invite redeemed: %v", err)
	}
	if ds, _ := h.Devices("v1"); len(ds) != 0 {
		t.Fatalf("a cancelled invite registered a device: %v", ds)
	}

	// The ones that are one refusal.
	expiring := mint(t, h, "v1", 2000, 1000)
	spent := mint(t, h, "v1", 9000, 1000)
	if err := redeem(h, "v1", spent.Token, "dev-two", "two", devHash2, 1500); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	for _, c := range []struct {
		what, id string
		now      int64
	}{
		{"cancelled twice", inv.ID, 1500},
		{"expired", expiring.ID, 2001},
		{"already redeemed", spent.ID, 1500},
		{"unknown", EncodeToken([]byte("12345678")), 1500},
		{"malformed", "not base64!", 1500},
		{"a token rather than an id", EncodeToken(expiring.Token), 1500},
	} {
		if err := h.CancelInvite("v1", c.id, c.now); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("cancelling an %s invite answered %v, want ErrNoInvite", c.what, err)
		}
	}
	// A cancel names its own vault: another vault's invite is not this one's
	// to retire.
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatal(err)
	}
	theirs := mint(t, h, "v2", 9000, 1000)
	if err := h.CancelInvite("v1", theirs.ID, 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("a vault cancelled another vault's invite: %v", err)
	}
	if n, _ := h.OutstandingInvites("v2", 1500); n != 1 {
		t.Fatalf("%d outstanding invites on v2, want the one that was issued", n)
	}
}

// keys_test.go:307. Rows that can no longer be redeemed are swept whenever an
// invite is created on the vault, and spent rows are kept: they are how a
// redemption whose reply was lost is recognised.
func TestI23ExpiredInvitesAreSweptAtInsert(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 3; i++ {
		mint(t, h, "v1", int64(2000+i), 1000)
	}
	cancelled := mint(t, h, "v1", 9000, 1000)
	spent := mint(t, h, "v1", 9000, 1000)
	if err := h.CancelInvite("v1", cancelled.ID, 1500); err != nil {
		t.Fatal(err)
	}
	if err := redeem(h, "v1", spent.Token, "dev-one", "one", devHash1, 1500); err != nil {
		t.Fatal(err)
	}
	if n, _ := h.InviteRows("v1"); n != 5 {
		t.Fatalf("%d rows, want 5", n)
	}
	// Time passes; the next insert sweeps the three expired ones and the
	// cancelled one, and keeps the spent one.
	mint(t, h, "v1", 9000, 5000)
	if n, _ := h.InviteRows("v1"); n != 2 {
		t.Fatalf("%d rows after the sweep, want the spent one and the new one", n)
	}
	if n, _ := h.OutstandingInvites("v1", 5000); n != 1 {
		t.Fatalf("%d outstanding, want 1", n)
	}
}

// keys_test.go:334, decided against the restore epoch (PLAN.md section 2.8).
// A backup carries the devices and the spent invites, and no invite that could
// still be redeemed: restoring an old copy must not revive an invite that has
// been used or cancelled since, each of which would add a device.
func TestABackupCarriesTheDevicesAndNoOutstandingInvite(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	spent := mint(t, h, "v1", 9000, 1000)
	if err := redeem(h, "v1", spent.Token, "dev-one", "one", devHash1, 1500); err != nil {
		t.Fatal(err)
	}
	outstanding := mint(t, h, "v1", nowMillis()+3_600_000, 1000)
	dest := filepath.Join(t.TempDir(), "backup")
	rep, err := h.Backup(dest, false)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if rep.InvitesLeftOut != 1 {
		t.Fatalf("the report says %d invites were left out, want the one outstanding", rep.InvitesLeftOut)
	}
	restored := openAt(t, dest)
	if err := redeem(restored, "v1", outstanding.Token, "dev-two", "two", devHash2, 2000); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("an invite outstanding at the backup redeemed from the restore: %v", err)
	}
	if n, _ := restored.OutstandingInvites("v1", 2000); n != 0 {
		t.Fatalf("the restore has %d outstanding invites", n)
	}
	// The device the spent one added is there, with its credential, so a
	// restore needs no re-pairing.
	if _, hash, ok, _ := restored.DeviceByID("v1", "dev-one"); !ok || hash != devHash1 {
		t.Fatalf("the restored store has dev-one ok=%v hash=%q", ok, hash)
	}
	// And the source still has its invite: leaving it out of the copy is not
	// cancelling it.
	if n, _ := h.OutstandingInvites("v1", 2000); n != 1 {
		t.Fatalf("the source has %d outstanding invites after a backup, want 1", n)
	}
}

// keys_test.go:468, the half that stays. The base64url shape check still
// guards every device id, through ValidDeviceID.
//
// It used to allow "=" anywhere in the last two positions, so "ab=c" passed:
// padding is the end of a base64 string, not a character that may appear near
// it. A shape check that admits a shape no encoder produces is not doing its
// job.
func TestValidBase64URLTakesPaddingOnlyAtTheEnd(t *testing.T) {
	good := []string{"abc", "ab-_", "abc=", "ab==", "abcd", "a==", "ab="}
	for _, s := range good {
		if !validBase64URL(s, 80) {
			t.Errorf("%q was refused and is base64url", s)
		}
	}
	bad := []string{"", "ab=c", "a=bc", "a=b", "===a", "ab=_", "ab c", "ab+c", "ab/c", "ab==x"}
	for _, s := range bad {
		if validBase64URL(s, 80) {
			t.Errorf("%q was accepted and is not base64url", s)
		}
	}
	if validBase64URL("aaaa", 3) {
		t.Error("a string over the maximum was accepted")
	}
	if ValidDeviceID("ab=c") || ValidDeviceID(ReservedDeviceIDPrefix+"x") {
		t.Error("ValidDeviceID accepted a shape validBase64URL refuses")
	}
}

// The strict decoder a credential is read with: one spelling per token.
func TestDecodeTokenTakesOneSpellingOnly(t *testing.T) {
	raw := []byte("0123456789abcdef")
	good := EncodeToken(raw)
	if got, ok := DecodeToken(good, 16); !ok || string(got) != string(raw) {
		t.Fatalf("the canonical spelling was refused: %v", ok)
	}
	for _, s := range []string{
		good + "=",                         // padding
		good[:len(good)-1],                 // a sextet short
		good + "A",                         // one too many
		good[:len(good)-1] + "B",           // nonzero unused bits
		strings.Replace(good, "M", "+", 1), // the other alphabet
		" " + good,                         // whitespace
		"",
	} {
		if _, ok := DecodeToken(s, 16); ok {
			t.Errorf("%q decoded, and is not the one spelling of a 16-byte token", s)
		}
	}
}

/* ---------------------------------------------------------------- *
 * Spending an invite and registering a device are one commit
 * ---------------------------------------------------------------- */

// keys_test.go:508. A crash between registering the device and marking the
// invite spent leaves neither.
//
// This is the partial state RedeemInvite exists to make unreachable, and it
// has two bad halves. An invite spent with no row behind it is a string that
// stopped working and a device that was never added. A row under an invite
// still marked live is a device registered by a string that can register
// another.
//
// Injected rather than timed: the window is a few microseconds wide and a test
// that tried to hit it by racing would be a test that passes when the machine
// is busy. An error returned from inside the transaction is what a process
// dying there leaves behind, because SQLite rolls an uncommitted transaction
// back either way.
func TestACrashBetweenRegisteringAndSpendingLeavesNeither(t *testing.T) {
	h := newTestStore(t)
	inv := mint(t, h, "v1", 9000, 1000)

	boom := errors.New("the power went off here")
	betweenRedeemWrites = func() error { return boom }
	_, err := h.RedeemInvite("v1", inv.Token, "dev-one", "one", devHash1, 1500)
	betweenRedeemWrites = nil
	if !errors.Is(err, boom) {
		t.Fatalf("the redemption returned %v, want the injected failure", err)
	}

	// Neither half happened.
	if ds, _ := h.Devices("v1"); len(ds) != 0 {
		t.Fatalf("a device was registered under an invite that was not spent: %v", ds)
	}
	if n, _ := h.OutstandingInvites("v1", 1500); n != 1 {
		t.Fatalf("%d outstanding invites, want the one that was issued: the invite was spent "+
			"with nothing to show for it", n)
	}
	// And the same string still works, which is what makes the crash cost
	// nothing but a retry.
	if err := redeem(h, "v1", inv.Token, "dev-one", "one", devHash1, 1500); err != nil {
		t.Fatalf("the invite did not survive the crash: %v", err)
	}
	if ids := ids(t, h, "v1"); len(ids) != 1 || ids[0] != "dev-one" {
		t.Fatalf("devices after the retry: %v", ids)
	}
}

// keys_test.go:557, the half that stands. A redemption racing a revoke never
// leaves one half of a redemption behind, whichever way it lands.
//
// The never-empty half is gone with the last-device rule (plan/protocol.md,
// "Devices and invites": revoking the last device is allowed, and `trewd
// invite` on the server is the way back). What remains is the one that
// matters: the invite is spent exactly when a device row came of it. The
// invite is the revoked device's own, so the race has two real outcomes: the
// redemption lands first and adds its device, or the revoke lands first,
// cancels the invite, and the redemption is refused.
//
// Two handles, because the guarantee has to be in the SQL rather than in
// writeMu: `trewd backup` and `trewd purge` run against a live server's
// directory, so the store is opened by more than one process.
func TestARedeemRacingARevokeLeavesTheVaultConsistent(t *testing.T) {
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if err := one.EnsureVault("v1", 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
			t.Fatal(err)
		}
		expires := int64(9000)
		inv, err := one.CreateInvite("v1", "", "alfa", &expires, 1000)
		if err != nil {
			t.Fatal(err)
		}
		two := openAt(t, dir)

		var redeemErr, revokeErr error
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			redeemErr = redeem(one, "v1", inv.Token, "bravo", "phone", hashB, 2000)
		}()
		go func() {
			defer wg.Done()
			<-start
			_, revokeErr = two.RevokeDevice("v1", "alfa", 2000)
		}()
		close(start)
		wg.Wait()

		if revokeErr != nil {
			t.Fatalf("attempt %d: the revoke failed with %v", attempt, revokeErr)
		}
		if redeemErr != nil && !errors.Is(redeemErr, ErrNoInvite) {
			t.Fatalf("attempt %d: the redemption failed with %v", attempt, redeemErr)
		}
		left := ids(t, one, "v1")
		registered := len(left) == 1 && left[0] == "bravo"
		if registered != (redeemErr == nil) || registered != spent(t, one, inv.ID) {
			t.Fatalf("attempt %d: the redemption returned %v, left devices %v, and the invite spent=%v",
				attempt, redeemErr, left, spent(t, one, inv.ID))
		}
		// Whichever way it landed, the invite redeems nothing more.
		if n, _ := one.OutstandingInvites("v1", 2000); n != 0 {
			t.Fatalf("attempt %d: %d invites outstanding after the race", attempt, n)
		}
		one.Close()
		two.Close()
	}
}

// keys_test.go:679. A vault this store does not hold has no invites, so a
// redemption against one is the same refusal an unknown invite gets.
func TestAnUnknownVaultHasNothingToRedeem(t *testing.T) {
	h := newTestStore(t)
	mint(t, h, "v1", 9000, 1000)
	if err := redeem(h, "nosuchvault", otherToken(), "bravo", "phone", hashB, 1000); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("redeeming against an unknown vault returned %v, want ErrNoInvite", err)
	}
}

// keys_test.go:695 and hazard 3. A redemption onto an id the vault already
// holds is refused and changes nothing, including the invite; the one
// exception is the retry of a redemption whose reply was lost, which is
// recognised by its own row and answered as redeemed again.
func TestARedemptionOntoAnExistingIdChangesNothing(t *testing.T) {
	h := newTestStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	inv := mint(t, h, "v1", 9000, 1000)
	// Somebody else's id, with a token of the redeemer's own: the same one
	// refusal as an unknown invite, so the invite's state is not the answer to
	// whether that device exists.
	if err := redeem(h, "v1", inv.Token, "alfa", "impostor", hashB, 2000); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("a redemption onto an existing id returned %v, want ErrNoInvite", err)
	}
	// Even with that device's own token: an id already on the vault is not a
	// new device, and only the device the invite was spent on can retry it.
	if err := redeem(h, "v1", inv.Token, "alfa", "laptop", hashA, 2000); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("a redemption naming an existing device and its own token returned %v", err)
	}
	_, hash, ok, err := h.DeviceByID("v1", "alfa")
	if err != nil || !ok || hash != hashA {
		t.Fatalf("the existing row was changed: ok=%v hash=%q err=%v", ok, hash, err)
	}
	if ds, _ := h.Devices("v1"); len(ds) != 1 || ds[0].Name != "laptop" {
		t.Fatalf("the existing row was overwritten: %v", ds)
	}
	if n, _ := h.OutstandingInvites("v1", 2000); n != 1 {
		t.Fatalf("%d outstanding invites after a refused redemption, want 1", n)
	}
	// And the invite still works for a device of its own.
	if err := redeem(h, "v1", inv.Token, "bravo", "phone", hashB, 2000); err != nil {
		t.Fatalf("the invite did not survive the refusals: %v", err)
	}
}

// Step 2, and the lost-reply retry after expiry the brief names. A redemption
// retried by the device it registered, under the same token, is answered
// redeemed again and writes nothing, even after the invite has expired,
// because the redemption it repeats did not expire. A different token under
// that id, or another id, is refused as an unknown invite would be.
func TestALostReplyRetrySucceedsEvenAfterExpiry(t *testing.T) {
	h := newTestStore(t)
	inv := mint(t, h, "v1", 2000, 1000)
	retried, err := h.RedeemInvite("v1", inv.Token, "bravo", "phone", hashB, 1500)
	if err != nil || retried {
		t.Fatalf("the first redemption: retried=%v err=%v", retried, err)
	}
	for _, now := range []int64{1600, 2001, 99999} {
		retried, err := h.RedeemInvite("v1", inv.Token, "bravo", "phone", hashB, now)
		if err != nil || !retried {
			t.Fatalf("the retry at %d: retried=%v err=%v, want a recognised retry", now, retried, err)
		}
	}
	for _, c := range []struct{ what, id, hash string }{
		{"the same id under another token", "bravo", hashC},
		{"another id under the same token", "charlie", hashB},
	} {
		if err := redeem(h, "v1", inv.Token, c.id, "phone", c.hash, 1600); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("%s returned %v, want ErrNoInvite", c.what, err)
		}
	}
	// One device, the original row, untouched by any of the retries.
	d, hash, ok, _ := h.DeviceByID("v1", "bravo")
	if !ok || hash != hashB || d.CreatedAt != 1500 {
		t.Fatalf("the device after the retries: %+v ok=%v hash=%q", d, ok, hash)
	}
	if got := ids(t, h, "v1"); len(got) != 1 {
		t.Fatalf("devices after the retries: %v", got)
	}
	// Revoked since: the retry has no row to recognise and is refused, so a
	// retry cannot bring a revoked device back.
	if _, err := h.RevokeDevice("v1", "bravo", 1700); err != nil {
		t.Fatal(err)
	}
	if err := redeem(h, "v1", inv.Token, "bravo", "phone", hashB, 1800); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("a retry after the device was revoked returned %v, want ErrNoInvite", err)
	}
	if got := ids(t, h, "v1"); len(got) != 0 {
		t.Fatalf("a retry brought a revoked device back: %v", got)
	}
}

// keys_test.go:743. Eight devices redeeming one invite at the same moment,
// which is the claim the whole design of an invite rests on.
//
// Single use is proven sequentially by TestI23InvitesAreSingleUseAndExpire,
// and both of those redeem one after the other. The property neither can see
// is that the read and the mark are in one transaction that holds the write
// lock from its start, so eight callers cannot all find a live invite and all
// spend it. An invite is the authority to register exactly one device, and two
// of them getting through is a device the vault's owner never admitted.
//
// Through eight Store handles on one directory rather than one: writeMu makes a
// read then a write atomic within one process, so a single-handle version of
// this passes against an implementation that reads the invite in a deferred
// transaction and then marks it. The store is opened by more than one process
// in earnest anyway, since `trewd backup` and `trewd purge` run against a
// live server's directory.
func TestConcurrentRedemptionsOfOneInviteRegisterExactlyOneDevice(t *testing.T) {
	const racers = 8
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if err := one.EnsureVault("v1", 1000); err != nil {
			t.Fatal(err)
		}
		inv := mint(t, one, "v1", 9000, 1000)
		hands := make([]*harness, racers)
		for i := range hands {
			hands[i] = openAt(t, dir)
		}

		errs := make([]error, racers)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := 0; i < racers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				id := fmt.Sprintf("racer-%d", i)
				<-start
				errs[i] = redeem(hands[i], "v1", inv.Token, id, id, fmt.Sprintf("%064x", i), 2000)
			}(i)
		}
		close(start)
		wg.Wait()

		won, winner := 0, -1
		for i, err := range errs {
			switch {
			case err == nil:
				won++
				winner = i
			case errors.Is(err, ErrNoInvite):
			default:
				t.Fatalf("attempt %d: racer %d got %v, want nil or ErrNoInvite", attempt, i, err)
			}
		}
		if won != 1 {
			t.Fatalf("attempt %d: %d of %d racers redeemed one invite, want exactly 1 (%v)",
				attempt, won, racers, errs)
		}
		// One row, and it is the winner's. A redemption is both halves or
		// neither, so a loser must not have left a device behind either.
		got := ids(t, one, "v1")
		if len(got) != 1 || got[0] != fmt.Sprintf("racer-%d", winner) {
			t.Fatalf("attempt %d: devices %v after racer %d won", attempt, got, winner)
		}
		if _, hash, ok, err := one.DeviceByID("v1", got[0]); err != nil || !ok ||
			hash != fmt.Sprintf("%064x", winner) {
			t.Fatalf("attempt %d: the row holds hash %q, not the winner's", attempt, hash)
		}
		// Spent, and spent once: nothing may redeem it afterwards either.
		if n, err := one.OutstandingInvites("v1", 2000); err != nil || n != 0 {
			t.Fatalf("attempt %d: %d invites still outstanding (%v)", attempt, n, err)
		}
		if err := redeem(one, "v1", inv.Token, "latecomer", "late", devHash1, 2001); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("attempt %d: the invite redeemed again afterwards: %v", attempt, err)
		}

		one.Close()
		for _, h := range hands {
			h.Close()
		}
	}
}

// Revoking a device cancels the invites it issued and nothing else: an invite
// minted on a laptop before the laptop was stolen must not add the thief's
// next device after the laptop is revoked (PLAN.md section 2.3.1).
func TestRevokingADeviceCancelsTheInvitesItIssued(t *testing.T) {
	h := newTestStore(t)
	for _, id := range []string{"alfa", "bravo"} {
		if err := h.RegisterDevice("v1", id, id, hashA, 1000); err != nil {
			t.Fatal(err)
		}
	}
	expires := int64(9000)
	fromAlfa, err := h.CreateInvite("v1", "", "alfa", &expires, 1000)
	if err != nil {
		t.Fatal(err)
	}
	spentByAlfa, err := h.CreateInvite("v1", "", "alfa", &expires, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err := redeem(h, "v1", spentByAlfa.Token, "charlie", "charlie", hashC, 1100); err != nil {
		t.Fatal(err)
	}
	fromBravo, err := h.CreateInvite("v1", "", "bravo", &expires, 1000)
	if err != nil {
		t.Fatal(err)
	}
	fromOperator := mint(t, h, "v1", 9000, 1000)

	cancelled, err := h.RevokeDevice("v1", "alfa", 1200)
	if err != nil || cancelled != 1 {
		t.Fatalf("revoke: cancelled %d invites, %v; want the one alfa had outstanding", cancelled, err)
	}
	if err := redeem(h, "v1", fromAlfa.Token, "thief", "thief", hashB, 1300); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("an invite the revoked device issued still redeems: %v", err)
	}
	// The device alfa's invite already added stays: a revoke is about alfa.
	if _, _, ok, _ := h.DeviceByID("v1", "charlie"); !ok {
		t.Fatal("revoking alfa removed the device alfa had invited")
	}
	for _, other := range []NewInvite{fromBravo, fromOperator} {
		if err := h.CancelInvite("v1", other.ID, 1300); err != nil {
			t.Fatalf("an invite alfa did not issue was not outstanding after the revoke: %v", err)
		}
	}
	// And a device that is not there cancels nothing and says so.
	if n, err := h.RevokeDevice("v1", "alfa", 1400); !errors.Is(err, ErrUnknownDevice) || n != 0 {
		t.Fatalf("revoking alfa again: %d, %v", n, err)
	}
}
