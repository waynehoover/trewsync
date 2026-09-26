package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/wire"
)

// What a revoke means, all three parts of it (PLAN.md section 2.3.1): no later
// mutation from the device commits, no mutation it has in flight completes, and
// no live connection of it is sent anything more. The last is the one Basalt
// got wrong: its revoke deleted the row, released the commit lock, and only
// then went looking for the device's sessions, so a commit from another device
// landing in between was broadcast to a device already reported revoked.

// rest reads every frame left on the connection until the server closes it,
// and fails the test if it does not close.
func (c *client) rest() []string {
	c.t.Helper()
	var out []string
	for {
		ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
		typ, data, err := c.conn.Read(ctx)
		timedOut := ctx.Err() != nil
		cancel()
		if err != nil {
			if timedOut {
				c.t.Fatalf("%s: the connection stayed open after %d frames: %v", c.name, len(out), out)
			}
			return out
		}
		if typ == websocket.MessageBinary {
			out = append(out, fmt.Sprintf("<binary %d bytes>", len(data)))
			continue
		}
		out = append(out, string(data))
	}
}

// onlyTheNotice fails unless frames is exactly the revocation notice: an
// unsolicited `auth` saying the device was revoked.
func onlyTheNotice(t *testing.T, who string, frames []string) {
	t.Helper()
	if len(frames) != 1 {
		t.Fatalf("%s heard %d frames after the revoke, want only the notice: %v", who, len(frames), frames)
	}
	var f struct {
		Res  string `json:"res"`
		Code string `json:"code"`
		ID   *int64 `json:"id"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal([]byte(frames[0]), &f); err != nil || f.Res != "err" || f.Code != wire.CodeAuth ||
		f.ID != nil || !strings.Contains(f.Msg, "revoked") {
		t.Fatalf("%s heard %s after the revoke, want the unsolicited notice", who, frames[0])
	}
}

// A revoke landing in the middle of an upload: the bodies have arrived, the
// commit has not. The commit is refused, nothing is stored, no other device is
// told of it, and all the uploading connection hears afterwards is that it was
// revoked. Its own refusal is not among it: that is a reply to a revoked
// device, and the revoke has already been answered as done.
func TestARevokeRacingAnUploadCommitsNothingAndSendsNothingElse(t *testing.T) {
	r := newRig(t)
	victim := r.dial("victim")
	victim.hello(0)
	owner := r.dial("owner")
	owner.hello(0)
	watcher := r.dial("watcher")
	watcher.hello(0)

	release := pauseNextMutationClock(t, r)
	body := "uploaded while the device was being revoked"
	names, size := chunkNames([]string{body})
	victim.sendJSON(wire.In{Op: "put", Path: "raced.md", Chunks: names, Meta: wire.PutMeta{Size: size, MTime: 1}})
	var want wire.Want
	victim.recvInto("want", &want)
	victim.sendBinary([]byte(body))
	release.afterEntered(func() {
		owner.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("victim")})
		owner.recvInto("revoked", &wire.Revoked{})
	})

	onlyTheNotice(t, "the uploading device", victim.rest())
	if uid, err := r.st.CurrentUID(testVault, "raced.md"); err != nil || uid != 0 {
		t.Fatalf("the revoked device's upload committed as uid %d (%v)", uid, err)
	}
	// And nobody was told of a commit that did not happen.
	watcher.sendJSON(wire.In{Op: "ping"})
	watcher.recvInto("pong", &wire.Pong{})
	for _, b := range watcher.drainBatches() {
		for _, e := range b.Entries {
			if e.Path == "raced.md" {
				t.Fatalf("another device was sent the revoked device's write: %+v", b)
			}
		}
	}
}

// A revoke landing while the device is minting an invite: no invite, and the
// minting connection hears only the notice, not the refusal of its request.
func TestARevokeRacingAnInviteLeavesNoInviteAndSendsNothingElse(t *testing.T) {
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
	onlyTheNotice(t, "the minting device", victim.rest())
	if n, err := r.st.OutstandingInvites(testVault, time.Now().UnixMilli()); err != nil || n != 0 {
		t.Fatalf("%d invites outstanding after the revoke (%v)", n, err)
	}
}

// And the one Basalt got wrong: a commit from another device, landing the
// moment after the revoke committed and before the revoked device's
// connection was closed, is not sent to it.
//
// The hooks make the window as wide as it can be. The commit is started from
// inside the revoke, while it still holds the commit lock, so it runs the
// instant the lock is released; the eviction waits until that commit has been
// acknowledged, so the broadcast is certain to have happened while the revoked
// connection was still open. Under Basalt's order, which took the sessions out
// of the fan-out only when it came to close them, the broadcast reached the
// revoked device, and this test fails.
func TestNothingCommittedAfterARevokeReachesTheRevokedConnection(t *testing.T) {
	r := newRig(t)
	victim := r.dial("victim")
	victim.hello(0)
	owner := r.dial("owner")
	owner.hello(0)
	writer := r.dial("writer")
	writer.hello(0)

	acked := make(chan error, 1)
	r.srv.afterRevoke = func() {
		r.srv.afterRevoke = nil
		go func() { acked <- putWithoutFailing(writer, "after-the-revoke.md", "not for the revoked device") }()
	}
	r.srv.beforeEvict = func() {
		select {
		case err := <-acked:
			acked <- err
		case <-time.After(5 * time.Second):
		}
	}

	owner.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("victim")})
	owner.recvInto("revoked", &wire.Revoked{})
	if err := <-acked; err != nil {
		t.Fatalf("the other device's write failed: %v", err)
	}
	if uid, _ := r.st.CurrentUID(testVault, "after-the-revoke.md"); uid == 0 {
		t.Fatal("the write the test is about never committed, so it proves nothing")
	}
	onlyTheNotice(t, "the revoked device", victim.rest())
}

// putWithoutFailing is client.put for a goroutine that is not the test's: it
// reports a failure rather than failing the test, which only the test's own
// goroutine may do.
func putWithoutFailing(c *client, path, body string) error {
	names, size := chunkNames([]string{body})
	in := wire.In{Op: "put", ID: 9001, Path: path, Chunks: names, Meta: wire.PutMeta{Size: size, MTime: 5}}
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	if err := c.conn.Write(c.ctx, websocket.MessageText, b); err != nil {
		return err
	}
	for {
		_, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return err
		}
		var m struct {
			Res  string `json:"res"`
			Op   string `json:"op"`
			Code string `json:"code"`
		}
		if err := json.Unmarshal(data, &m); err != nil {
			return err
		}
		switch {
		case m.Op == "batch":
			continue
		case m.Res == "want":
			if err := c.conn.Write(c.ctx, websocket.MessageBinary, append([]byte{0}, body...)); err != nil {
				return err
			}
		case m.Res == "ack" || m.Res == "have":
			return nil
		default:
			return errors.New("the put was answered " + string(data))
		}
	}
}
