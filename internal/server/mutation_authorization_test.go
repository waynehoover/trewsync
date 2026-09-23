package server

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/wire"
)

// A revoke landing while a device is minting an invite, after the request is
// in and before the invite is stored, leaves no invite: the mint rechecks the
// device's row under the lock the revoke takes, so an acknowledged revoke is
// never followed by an invite the revoked device made.
func TestRevokedDeviceCannotFinishMintingAnInvite(t *testing.T) {
	r := newRig(t)
	victim := r.dial("victim")
	victim.hello(0)
	owner := r.dial("owner")
	owner.hello(0)
	release := pauseNextMutationClock(t, r)
	victim.sendJSON(wire.In{Op: "invite"})
	release.afterEntered(func() {
		owner.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("victim")})
		owner.recvInto("revoked", &wire.Revoked{})
	})
	waitFor(t, "revoked handler to unwind", func() bool { return r.srv.Peers(testVault) == 1 })
	if n, err := r.st.OutstandingInvites(testVault, time.Now().UnixMilli()); err != nil || n != 0 {
		t.Fatalf("revoked device minted %d invites after revocation was acknowledged (%v)", n, err)
	}
}

func TestRevokedWriterCannotCommitAfterTheRevocationReply(t *testing.T) {
	r := newRig(t)
	old := r.seed("note.md", "the preserved version")
	newer := r.seed("prepared.md", "a revoked replacement")
	victim := r.dial("victim")
	victim.hello(0)
	owner := r.dial("owner")
	owner.hello(0)
	release := pauseNextMutationClock(t, r)
	victim.sendJSON(wire.In{Op: "put", Path: old.Path, Meta: wire.PutMeta{Size: newer.Size, MTime: 1},
		Chunks: newer.Chunks, Base: old.UID})
	release.afterEntered(func() {
		owner.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("victim")})
		owner.recvInto("revoked", &wire.Revoked{})
	})
	waitFor(t, "revoked writer to unwind", func() bool { return r.srv.Peers(testVault) == 1 })
	history, err := r.st.HistoryForPath(testVault, old.Path, 0, 10)
	if err != nil || len(history) != 1 || history[0].UID != old.UID {
		t.Fatalf("revoked writer changed note history after the successful revocation: %+v %v", history, err)
	}
	body, err := r.st.Chunks().Get(testVault, old.Chunks[0])
	if err != nil || string(body) != "the preserved version" {
		t.Fatalf("accepted note was not preserved: %q %v", body, err)
	}
}

func TestReusedDeviceIDDoesNotAuthorizeItsOldSession(t *testing.T) {
	for _, op := range []string{"invite", "uninvite", "rename", "revoke", "put"} {
		t.Run(op, func(t *testing.T) {
			r := newRig(t)
			victim := r.dial("victim")
			victim.hello(0)
			owner := r.dial("owner")
			owner.hello(0)
			issued := issue(t, owner, wire.In{})
			// Keep the old socket in the exact window between removing its row
			// and eviction, then recreate its ID under an unrelated credential.
			if _, err := r.st.RevokeDevice(testVault, deviceID("victim"), 2); err != nil {
				t.Fatal(err)
			}
			if err := r.st.RegisterDevice(testVault, deviceID("victim"), "replacement",
				hashOf(deviceKey("replacement")), 1); err != nil {
				t.Fatal(err)
			}
			request := wire.In{Op: op}
			switch op {
			case "uninvite":
				request.Invite = issued.Invite
			case "rename":
				request.Name = "stale label"
			case "revoke":
				request.DeviceID = deviceID("owner")
			case "put":
				request.Path, request.Chunks = "new.md", []string{}
			}
			victim.sendJSON(request)
			victim.expectErr(wire.CodeAuth)
			row, _, ok, err := r.st.DeviceByID(testVault, deviceID("victim"))
			if err != nil || !ok || row.Name != "replacement" {
				t.Fatalf("old session changed its replacement: %+v %v", row, err)
			}
			if _, _, ok, err := r.st.DeviceByID(testVault, deviceID("owner")); err != nil || !ok {
				t.Fatalf("old session revoked the owner: %v", err)
			}
			invites, err := r.st.Invites(testVault, time.Now().UnixMilli())
			if err != nil || len(invites) != 1 || invites[0].ID != issued.Invite {
				t.Fatalf("old session changed invitations: %+v %v", invites, err)
			}
			if latest, err := r.st.LatestUID(testVault); err != nil || latest != 0 {
				t.Fatalf("old session wrote history: uid=%d err=%v", latest, err)
			}
		})
	}
}

type mutationPause struct {
	t       *testing.T
	entered chan struct{}
	resume  chan struct{}
	once    sync.Once
}

// pauseNextMutationClock holds the first caller of the server's clock until the
// test says go, and lets every later caller straight through: the revoke the
// test then sends reads the clock too, and must not queue behind the handler it
// is racing.
func pauseNextMutationClock(t *testing.T, r *rig) *mutationPause {
	p := &mutationPause{t: t, entered: make(chan struct{}), resume: make(chan struct{})}
	var first atomic.Bool
	r.srv.now = func() time.Time {
		if first.CompareAndSwap(false, true) {
			close(p.entered)
			<-p.resume
		}
		return time.Now()
	}
	t.Cleanup(func() { p.once.Do(func() { close(p.resume) }) })
	return p
}

func (p *mutationPause) afterEntered(fn func()) {
	p.t.Helper()
	select {
	case <-p.entered:
	case <-time.After(5 * time.Second):
		p.t.Fatal("mutation did not reach its pre-store boundary")
	}
	fn()
	p.once.Do(func() { close(p.resume) })
}
