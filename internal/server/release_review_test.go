package server

import (
	"errors"
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/wire"
)

// release_review_test.go:13. A ttl near the int64 limit is clamped to the cap
// in milliseconds, before it is turned into a Duration that would overflow into
// a past expiry, and the capped invite still adds a device.
func TestInviteTTLIsClampedBeforeDurationConversion(t *testing.T) {
	for _, ttl := range []int64{math.MaxInt64, (1 << 53) - 1, math.MaxInt64/int64(time.Millisecond) + 1} {
		t.Run(fmt.Sprint(ttl), func(t *testing.T) {
			r := newRig(t)
			base := time.Unix(1_800_000_000, 0)
			r.srv.now = func() time.Time { return base }
			a := r.dial("a")
			a.hello(0)
			inv := issue(t, a, wire.In{TTLMs: ttl})
			if want := base.Add(MaxInviteTTL).UnixMilli(); inv.ExpiresAt == nil || *inv.ExpiresAt != want {
				t.Fatalf("ttl %d gave expiry %v, want the cap %d", ttl, inv.ExpiresAt, want)
			}
			if reply := redeemAs(t, r, tokenOf(t, inv), "phone"); reply["res"] != "redeemed" {
				t.Fatalf("capped invite could not add a device: %v", reply)
			}
		})
	}
}

// release_review_test.go:33, the half that stays. A socket failure that kills a
// device hello while it is publishing what it authenticated is race-free under
// -race. Basalt tested this for the registrar's hello only; helloAsDevice
// publishes the same fields the same way and had no such test.
func TestDevicePublicationMayRaceConnectionFailure(t *testing.T) {
	r := newRig(t)
	r.device("first")
	stopped := make(chan struct{})
	r.srv.beforePublish = func() {
		var joining *Session
		r.srv.sessMu.Lock()
		for sess := range r.srv.sessions {
			if sess.counted {
				joining = sess
				break
			}
		}
		r.srv.sessMu.Unlock()
		if joining == nil {
			t.Error("no pending hello")
			close(stopped)
			return
		}
		// A socket failure can close and log a session as hello initializes
		// its fields. The race detector checks that the log respects the
		// publication boundary.
		go func() {
			joining.kill(errors.New("connection failed during hello"))
			close(stopped)
		}()
	}
	late := r.dial("first")
	late.sendJSON(late.deviceHello(0))
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the interrupted handshake did not close")
	}
}
