package store

import (
	"strings"
	"testing"
)

// pairing.test.ts:605 in plan/strip-ledger.md, which came here with the
// minting: no invite id begins with "-".
//
// An invite id is what a person types to cancel an invite, as `trew uninvite
// ID`, and Go's flag package takes arguments as flags until the first
// positional one. An id beginning with a dash therefore never becomes the
// positional argument: it is refused as an unknown flag, and the invite
// cannot be cancelled from the command line except by waiting out its expiry.
// Basalt met exactly this with its own invite ids, found by a test that
// flaked rather than by anything asserting it.
//
// Two thousand, because "never" over a random generator is not a thing one
// sample can show. Base64url's alphabet has a dash in it, so without the rule
// one id in 64 begins with one, and two thousand clean ids by chance is about
// one in 10^13.
func TestNoInviteIDBeginsWithADash(t *testing.T) {
	h := newTestStore(t)
	expires := int64(1) << 40
	const many = 2000
	var bad []string
	for i := 0; i < many; i++ {
		inv, err := h.CreateInvite("v1", "", "", &expires, 1000)
		if err != nil {
			t.Fatalf("create invite %d: %v", i, err)
		}
		if !ValidInviteID(inv.ID) {
			t.Fatalf("invite %d has the id %q, which is not an invite id's shape", i, inv.ID)
		}
		if strings.HasPrefix(inv.ID, "-") {
			bad = append(bad, inv.ID)
		}
	}
	if len(bad) > 0 {
		t.Fatalf("%d of %d invite ids began with a dash, which `trew uninvite` reads as a flag: %q",
			len(bad), many, bad)
	}
}
