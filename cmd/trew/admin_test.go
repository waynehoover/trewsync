package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/dirlock"
	"github.com/waynehoover/trew/internal/invite"
	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// The administrative commands (PLAN.md section 2.3.1): `trew invite`,
// `devices`, `revoke` and `uninvite`, through the running server's control
// socket when it runs and against the store under the server lock when it
// does not. The first are the operator's powers of last resort, which Basalt
// gave to the recovery key (plan/strip-ledger.md, unique guarantee 21).

// serving starts `serve` on a fresh directory and returns the directory, the
// address, and the first device connected through the first invite.
func serving(t *testing.T) (dir, addr string, first *wsClient) {
	t.Helper()
	dir = t.TempDir()
	addr = fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- run(ctx, []string{"serve", "-data", dir, "-addr", addr}, out) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("the server did not stop")
		}
	})
	waitForServer(t, addr, out)
	return dir, addr, dialFirstDevice(t, "ws://"+addr, readFirstInvite(t, dir))
}

// parseInvite finds the invite string in `trew invite`'s output.
func parseInvite(t *testing.T, out string) invite.Invite {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if s := strings.TrimSpace(line); strings.HasPrefix(s, invite.Prefix) {
			inv, err := invite.Parse(s)
			if err != nil {
				t.Fatalf("the printed invite does not parse: %v", err)
			}
			return inv
		}
	}
	t.Fatalf("no invite in:\n%s", out)
	return invite.Invite{}
}

// redeemAs redeems an invite over the wire for a device of the given name and
// returns the raw reply.
func redeemAs(t *testing.T, url string, inv invite.Invite, name string) map[string]any {
	t.Helper()
	raw := sha256.Sum256([]byte("token of " + name))
	cl := dialWS(t, url)
	cl.write(wire.In{
		Op: "hello", ID: 1, Proto: wire.Proto, Vault: inv.Vault, Device: name,
		Invite: store.EncodeToken(inv.Token), DeviceID: name, Token: store.EncodeToken(raw[:]),
	})
	return cl.readJSON()
}

// devicesJSON is `trew devices -json`, decoded.
func devicesJSON(t *testing.T, dir string) (devices []wire.DeviceStatus, invites []store.Invite) {
	t.Helper()
	var got struct {
		Devices []wire.DeviceStatus `json:"devices"`
		Invites []store.Invite      `json:"invites"`
	}
	out := mustRun(t, "devices", "-data", dir, "-json")
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("devices -json is not JSON: %v\n%s", err, out)
	}
	return got.Devices, got.Invites
}

// Through the running server: an invite that pairs, the list that shows it and
// the device it made, an uninvite that retires another, and a revoke that
// closes the revoked device's live connection, which then hears nothing but
// the notice.
func TestTheAdminCommandsGoThroughTheRunningServer(t *testing.T) {
	dir, addr, first := serving(t)

	out := mustRun(t, "invite", "-data", dir, "-label", "for the tablet")
	if !strings.Contains(out, "works once") {
		t.Fatalf("the invite says nothing of how long it lasts:\n%s", out)
	}
	inv := parseInvite(t, out)
	if res := redeemAs(t, "ws://"+addr, inv, "tablet"); res["res"] != "redeemed" {
		t.Fatalf("the invite from `trew invite` was answered %v", res)
	}

	spare := parseInvite(t, mustRun(t, "invite", "-data", dir))
	devices, invites := devicesJSON(t, dir)
	if len(devices) != 2 || len(invites) != 1 {
		t.Fatalf("devices lists %d devices and %d invites, want 2 and the spare: %+v %+v",
			len(devices), len(invites), devices, invites)
	}
	online := 0
	for _, d := range devices {
		if d.Online {
			online++
		}
	}
	if online != 1 {
		t.Fatalf("%d devices shown as connected, want the first device only: %+v", online, devices)
	}
	mustRun(t, "uninvite", "-data", dir, invites[0].ID)
	if res := redeemAs(t, "ws://"+addr, spare, "spare"); res["code"] != wire.CodeAuth {
		t.Fatalf("an invite the operator cancelled was answered %v", res)
	}

	// The revoke, through the server, so the first device's open connection
	// is closed rather than left receiving.
	out = mustRun(t, "revoke", "-data", dir, firstDevID)
	if !strings.Contains(out, "closed 1 connections") {
		t.Fatalf("the revoke did not close the device's connection:\n%s", out)
	}
	for {
		data, err := first.readRaw(5 * time.Second)
		if err != nil {
			break
		}
		var f map[string]any
		_ = json.Unmarshal(data, &f)
		if f["res"] != "err" || f["code"] != wire.CodeAuth || !strings.Contains(fmt.Sprint(f["msg"]), "revoked") {
			t.Fatalf("the revoked device was sent %s", data)
		}
	}
	back := dialWS(t, "ws://"+addr)
	back.write(wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Vault: inv.Vault,
		Token: firstDevKey, DeviceID: firstDevID, Device: "test-device"})
	if res := back.readJSON(); res["code"] != wire.CodeAuth {
		t.Fatalf("a device the operator revoked connected again: %v", res)
	}

	// And the commands refuse what they cannot do, in words.
	for _, c := range []struct{ args []string }{
		{[]string{"revoke", "-data", dir, "no-such-device"}},
		{[]string{"uninvite", "-data", dir, "no-such-invite"}},
		{[]string{"invite", "-data", dir, "-vault", "another"}},
	} {
		if out, err := trew(t, c.args...); err == nil {
			t.Errorf("trew %s succeeded:\n%s", strings.Join(c.args, " "), out)
		}
	}
}

// -out writes the invite to a file at 0600 and prints only where it went, and
// -ttl 0 makes one that never expires, which only the operator can.
func TestAnInviteWrittenToAFileIsPrivateAndUnprinted(t *testing.T) {
	dir, addr, _ := serving(t)
	path := filepath.Join(t.TempDir(), "invite")
	out := mustRun(t, "invite", "-data", dir, "-out", path, "-ttl", "0")
	if strings.Contains(out, invite.Prefix) {
		t.Fatalf("an invite written to a file was printed too:\n%s", out)
	}
	if !strings.Contains(out, path) || !strings.Contains(out, "does not expire") {
		t.Fatalf("the command did not say where the invite went or that it never expires:\n%s", out)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the invite file is %v (%v), want mode 600", info.Mode(), err)
	}
	body, _ := os.ReadFile(path)
	inv := parseInvite(t, string(body))
	_, invites := devicesJSON(t, dir)
	if len(invites) != 1 || invites[0].ExpiresAt != nil {
		t.Fatalf("a never-expiring invite lists as %+v", invites)
	}
	if res := redeemAs(t, "ws://"+addr, inv, "tablet"); res["res"] != "redeemed" {
		t.Fatalf("the written invite was answered %v", res)
	}
}

// With no server, the same commands act on the store, under the server lock
// that keeps one from starting underneath. This is the way back into a vault
// whose devices are all gone: history is kept, an invite is minted, a new
// device redeems it when the server starts, and catches up on everything.
func TestTheAdminCommandsWorkWithNoServerRunning(t *testing.T) {
	dir := seeded(t)
	registryOn(t, dir)
	devices, invites := devicesJSON(t, dir)
	if len(devices) != 1 || len(invites) != 1 {
		t.Fatalf("the seeded registry lists %+v and %+v", devices, invites)
	}
	mustRun(t, "uninvite", "-data", dir, invites[0].ID)
	mustRun(t, "revoke", "-data", dir, devices[0].ID)
	if devices, invites := devicesJSON(t, dir); len(devices) != 0 || len(invites) != 0 {
		t.Fatalf("after the revoke and the uninvite: %+v %+v", devices, invites)
	}

	addr := fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	inv := parseInvite(t, mustRun(t, "invite", "-data", dir, "-url", "ws://"+addr))
	if inv.URL != "ws://"+addr {
		t.Fatalf("-url was not what the invite carries: %q", inv.URL)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := &safeBuffer{}
	go func() { _ = run(ctx, []string{"serve", "-data", dir, "-addr", addr}, out) }()
	waitForServer(t, addr, out)
	if strings.Contains(out.String(), "wrote an invite") {
		t.Fatalf("serve minted a first invite over the operator's outstanding one:\n%s", out.String())
	}
	cl := dialFirstDevice(t, inv.URL, inv)
	if cursor, _ := cl.ready["cursor"].(float64); cursor != 6 {
		t.Fatalf("the device that came back sees cursor %v, want the six versions kept", cl.ready["cursor"])
	}
}

// With no server and the data directory held by a purge, the commands refuse
// rather than wait or write around it.
func TestTheAdminCommandsRefuseWhileAPurgeHoldsTheDirectory(t *testing.T) {
	dir := seeded(t)
	lock, err := dirlock.Exclusive(dir, dirlock.Data, "purge")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if out, err := trew(t, "invite", "-data", dir); err == nil {
		t.Fatalf("an invite was minted while a purge held the directory:\n%s", out)
	}
}
