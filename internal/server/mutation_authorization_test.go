package server

import (
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/wire"
)

func TestRevokedDeviceCannotFinishMintingAnInvite(t *testing.T) {
	r := newRig(t)
	victim := r.dial("victim")
	victim.hello(0)
	owner := r.dial("owner")
	owner.hello(0)
	release := pauseNextMutationClock(t, r)
	victim.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: testSealed})
	release.afterEntered(func() {
		owner.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("victim")})
		owner.recvInto("revoked", &wire.Revoked{})
	})
	waitFor(t, "revoked handler to unwind", func() bool { return r.srv.Peers(testVault) == 1 })
	if got := redeem(t, r, testInvite, "replacement"); got["res"] == "redeemed" {
		t.Fatalf("revoked device minted an invite after revocation was acknowledged and regained access: %v", got)
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
		Chunks: newer.Chunks, Mac: testMac, Base: old.UID})
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
			issue(t, owner, testInvite)
			// Keep the old socket in the exact window between removing its row
			// and eviction, then recreate its ID under an unrelated credential.
			if err := r.st.RevokeDevice(testVault, deviceID("victim"), "", false); err != nil {
				t.Fatal(err)
			}
			if err := r.st.RegisterDevice(testVault, deviceID("victim"), "replacement",
				hashOf(deviceKey("replacement")), hashOf(testToken), 1); err != nil {
				t.Fatal(err)
			}
			request := wire.In{Op: op}
			switch op {
			case "invite":
				request.Invite, request.Sealed = "another-invite", testSealed
			case "uninvite":
				request.Invite = testInvite
			case "rename":
				request.Name = "stale label"
			case "revoke":
				request.DeviceID = deviceID("owner")
			case "put":
				request.Path, request.Chunks, request.Mac = "new.md", []string{}, testMac
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
			if err != nil || len(invites) != 1 || invites[0].ID != testInvite {
				t.Fatalf("old session changed invitations: %+v %v", invites, err)
			}
			if latest, err := r.st.LatestUID(testVault); err != nil || latest != 0 {
				t.Fatalf("old session wrote history: uid=%d err=%v", latest, err)
			}
		})
	}
}

func TestRetiredRegistrarCannotCancelANewInvite(t *testing.T) {
	r := newRigDerived(t)
	device := claimed(t, r, "owner")
	leaked := registrarWith(t, r, "retired-root", longKey)
	// Retire the credential while its socket still exists, as an in-flight
	// handler can outlive the rotation's notification and connection close.
	if err := r.st.Rotate(testVault, hashOf(longKey), hashOf(newKey), newWrapped); err != nil {
		t.Fatal(err)
	}
	issue(t, device, testInvite)
	leaked.sendJSON(wire.In{Op: "uninvite", Invite: testInvite})
	leaked.expectErr(wire.CodeRotated)
	if got := redeem(t, r, testInvite, "new-device"); got["res"] != "redeemed" {
		t.Fatalf("the retired root cancelled a new invite: %v", got)
	}
}

type mutationPause struct {
	t       *testing.T
	entered chan struct{}
	resume  chan struct{}
	once    sync.Once
}

func pauseNextMutationClock(t *testing.T, r *rig) *mutationPause {
	p := &mutationPause{t: t, entered: make(chan struct{}), resume: make(chan struct{})}
	var enterOnce sync.Once
	r.srv.now = func() time.Time {
		enterOnce.Do(func() { close(p.entered); <-p.resume })
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
