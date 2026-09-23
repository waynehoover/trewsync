package server

import (
	"errors"
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/wire"
)

func TestInviteTTLIsClampedBeforeDurationConversion(t *testing.T) {
	for _, ttl := range []int64{math.MaxInt64, (1 << 53) - 1, math.MaxInt64/int64(time.Millisecond) + 1} {
		t.Run(fmt.Sprint(ttl), func(t *testing.T) {
			r := newRigDerived(t)
			base := time.Unix(1_800_000_000, 0)
			r.srv.now = func() time.Time { return base }
			a := claimed(t, r, "a")
			a.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: testSealed, TTLMs: ttl})
			var inv wire.Invited
			a.recvInto("invited", &inv)
			if want := base.Add(MaxInviteTTL).UnixMilli(); inv.ExpiresAt != want {
				t.Fatalf("ttl %d gave expiry %d, want the cap %d", ttl, inv.ExpiresAt, want)
			}
			if reply := redeem(t, r, testInvite, "phone"); reply["res"] != "redeemed" {
				t.Fatalf("capped invite could not add a device: %v", reply)
			}
		})
	}
}

func TestRegistrarPublicationMayRaceConnectionFailure(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "first")
	stopped := make(chan struct{})
	r.srv.beforeRegistrarPublish = func() {
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
			t.Error("no pending registrar")
			close(stopped)
			return
		}
		// A socket failure can close and log a session as hello initializes
		// its fields. The race detector checks that the log respects the same
		// publication boundary as rotation's session scan.
		go func() {
			joining.kill(errors.New("connection failed during hello"))
			close(stopped)
		}()
	}
	late := r.dial("interrupted-recovery")
	late.sendJSON(vaultHello(testVault, longKey, "interrupted-recovery", 0))
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the interrupted handshake did not close")
	}
}

func TestRotationDoesNotInspectAnUnpublishedHandshake(t *testing.T) {
	srv := New(nil, nil, nil)
	joining := &Session{}
	if err := srv.admit(joining); err != nil {
		t.Fatal(err)
	}
	defer srv.forget(joining)
	// Hello initializes these fields before authenticated publishes them.
	// Until then, a rotation on another session must not read or evict it.
	joining.registrar = true
	joining.vaultID = testVault
	if got := srv.registrarsOn(testVault, nil); len(got) != 0 {
		t.Fatalf("rotation selected %d handshakes before authentication was published", len(got))
	}
	srv.authenticated(joining)
	if got := srv.registrarsOn(testVault, nil); len(got) != 1 || got[0] != joining {
		t.Fatalf("rotation missed the authenticated registrar: %v", got)
	}
}

func TestRotationBeforeRegistrarPublicationRetiresTheOldCredential(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "first")
	newKey := "new-vault-root-auth-key-00000000000000000"
	r.srv.beforeRegistrarPublish = func() {
		if err := r.st.Rotate(testVault, hashOf(longKey), hashOf(newKey), testWrapped); err != nil {
			t.Error(err)
		}
		// This is the other half of a rotation: a hello that is still being
		// published is not yet visible to its eviction scan.
		if victims := r.srv.registrarsOn(testVault, nil); len(victims) != 0 {
			t.Errorf("unexpected published registrars: %d", len(victims))
		}
	}
	late := r.dial("late-recovery")
	late.sendJSON(vaultHello(testVault, longKey, "late-recovery", 0))
	late.expectErr(wire.CodeAuth)
	if !late.closed() {
		t.Fatal("the retired credential kept a live registrar session")
	}
}
