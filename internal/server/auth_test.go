package server

import (
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/telimus/internal/store"
	"github.com/waynehoover/telimus/internal/wire"
)

// The credentials: a device's 32-byte token and an invite's 16-byte token,
// each stored as the SHA-256 of its raw bytes and never in the clear. Basalt's
// auth_test.go was about the claim and the bootstrap token, and the four tests
// that were only about those went with them (plan/strip-ledger.md); these are
// the rules that survive.

// auth_test.go:98. The server keeps digests and never a credential. A server
// that held a device's token could be that device, and one that held an
// invite's could redeem it; a copy of the database is not a place either
// should be.
func TestTheServerStoresAHashAndNotTheKey(t *testing.T) {
	r := newRig(t)
	inv := r.invite(time.Hour)
	r.dial("phone").redeem(inv.Token)

	raw, onWire := deviceToken("phone")
	_, stored, ok, err := r.st.DeviceByID(testVault, deviceID("phone"))
	if err != nil || !ok {
		t.Fatalf("the redeemed device: ok=%v err=%v", ok, err)
	}
	if stored != store.HashToken(raw) {
		t.Fatalf("the device row holds %q, want the SHA-256 of the 32 raw bytes %q", stored, store.HashToken(raw))
	}
	if strings.Contains(stored, onWire) || stored == store.HashToken([]byte(onWire)) {
		t.Fatalf("the device row holds the token, or the digest of its spelling rather than its bytes: %q", stored)
	}

	// And the invite: every column of its row, read back, and none of them the
	// token or anything that would let a reader present it.
	db := openRaw(t, r)
	rows, err := db.Query(`SELECT * FROM invites`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	sawHash := false
	for rows.Next() {
		vals := make([]sql.NullString, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		for i, v := range vals {
			if strings.Contains(v.String, store.EncodeToken(inv.Token)) || v.String == string(inv.Token) {
				t.Fatalf("column %s of the invite row holds the token", cols[i])
			}
			sawHash = sawHash || v.String == store.HashToken(inv.Token)
		}
	}
	if !sawHash {
		t.Fatal("the invite row does not hold the token's digest, so nothing could ever redeem it")
	}
}

// openRaw opens the rig's database directly, read only, for the tests that
// have to look at rows no API returns.
func openRaw(t *testing.T, r *rig) *sql.DB {
	t.Helper()
	path, _ := store.DataDir(r.dir)
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// auth_test.go:122. A server serves one vault. A hello for any other, on
// either route, is refused and creates nothing: a typo in the name must fail
// here rather than quietly creating a second, empty vault that reports itself
// as fully synced.
func TestOnlyTheServedVaultCanBeReached(t *testing.T) {
	r := newRig(t)
	r.srv.Serves(testVault)
	inv := r.invite(time.Hour)

	device := r.dial("phone")
	_, key := r.device("phone")
	device.sendJSON(wire.In{Op: "hello", Vault: "typo", DeviceID: deviceID("phone"), Token: key, Device: "phone"})
	device.expectErr(wire.CodeAuth)

	joiner := r.dial("tablet")
	hello := redeemHello(inv.Token, "tablet")
	hello.Vault = "typo"
	joiner.sendJSON(hello)
	joiner.expectErr(wire.CodeAuth)

	vaults, err := r.st.Vaults()
	if err != nil {
		t.Fatalf("vaults: %v", err)
	}
	for _, v := range vaults {
		if v == "typo" {
			t.Fatal("a refused hello created the vault anyway")
		}
	}
}

// auth_test.go:140. A redemption registers the token the joining device will
// connect with, so it is refused unless that token is exactly 32 bytes in the
// one spelling: a short one would be a guessable credential bound to the vault
// for ever, and a refusal the device can see is better than a weak key it
// cannot. The floor replaces Basalt's MinClaimLength. No refusal registers
// anything or spends the invite.
func TestARedemptionWillNotRegisterAGuessableToken(t *testing.T) {
	r := newRig(t)
	inv := r.invite(time.Hour)
	for _, token := range []string{
		"",
		"short",
		store.EncodeToken(make([]byte, store.DeviceTokenBytes-1)),
		store.EncodeToken(make([]byte, store.DeviceTokenBytes+1)),
		store.EncodeToken(make([]byte, store.DeviceTokenBytes)) + "=",
		strings.Repeat("k", 43) + "!",
	} {
		cl := r.dial("tablet")
		hello := redeemHello(inv.Token, "tablet")
		hello.Token = token
		cl.sendJSON(hello)
		msg := cl.expectErr(wire.CodeBadEntry)
		if !strings.Contains(msg, "32 random bytes") {
			t.Fatalf("a token of %d characters was refused without saying what one is: %q", len(token), msg)
		}
		if !cl.closed() {
			t.Fatal("a refused redemption left the connection open")
		}
	}
	if ds, _ := r.st.Devices(testVault); len(ds) != 0 {
		t.Fatalf("a refused redemption registered %v", ds)
	}
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatal("a refused redemption spent the invite")
	}
	// And a proper one is not refused.
	r.dial("tablet").redeem(inv.Token)
}

// auth_test.go:177. An empty credential never matches, whatever is stored: a
// device hello with no token, one with no device id, and a row whose digest
// happens to be the digest of nothing.
func TestAnEmptyCredentialOpensNothing(t *testing.T) {
	r := newRig(t)
	// A row nobody should have, of the one digest an empty token has.
	if err := r.st.RegisterDevice(testVault, deviceID("hollow"), "hollow", store.HashToken(nil), 1); err != nil {
		t.Fatal(err)
	}
	for _, hello := range []wire.In{
		{Op: "hello", Vault: testVault, DeviceID: deviceID("hollow"), Token: "", Device: "hollow"},
		{Op: "hello", Vault: testVault, DeviceID: "", Token: "", Device: "hollow"},
		{Op: "hello", Vault: testVault, DeviceID: deviceID("hollow"), Token: "", Invite: "", Device: "hollow"},
	} {
		cl := r.dial("hollow")
		cl.sendJSON(hello)
		if msg := cl.expectErr(wire.CodeAuth); msg != errNotAuthorised.Error() {
			t.Fatalf("an empty credential was refused with %q", msg)
		}
	}
}
