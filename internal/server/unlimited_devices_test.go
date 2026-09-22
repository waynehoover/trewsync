package server

import (
	"fmt"
	"testing"

	"github.com/waynehoover/telimus/internal/wire"
)

func TestMoreThanEightDevicesCanRegister(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "first")
	reg := registrarWith(t, r, "recovery-key", longKey)
	for i := 1; i < 24; i++ {
		name := fmt.Sprintf("many-%d", i)
		reg.sendJSON(wire.In{Op: "register", DeviceID: deviceID(name), Auth: deviceKey(name)})
		reg.recvInto("registered", &wire.Registered{})
	}
	if rows := mustDevices(t, r); len(rows) != 24 {
		t.Fatalf("registered %d devices, want 24", len(rows))
	}
}

func TestMoreThanEightConnectionsReceiveCommits(t *testing.T) {
	r := newRig(t)
	var peers []*client
	for i := 0; i < 24; i++ {
		peer := r.dial(fmt.Sprintf("many-%d", i))
		peer.hello(0)
		peers = append(peers, peer)
	}
	if n := r.srv.Peers(testVault); n != len(peers) {
		t.Fatalf("connected %d devices, want %d", n, len(peers))
	}
	uid := peers[0].put("shared.md", "preserved across every device")
	for _, peer := range peers[1:] {
		batch := peer.nextBatch()
		if batch.To != uid || len(batch.Entries) != 1 {
			t.Fatalf("%s received %+v", peer.name, batch)
		}
		bodies := peer.fetch(batch.Entries[0].Chunks...)
		if len(bodies) != 1 || string(bodies[0]) != "preserved across every device" {
			t.Fatalf("%s fetched %q", peer.name, bodies)
		}
	}
}
