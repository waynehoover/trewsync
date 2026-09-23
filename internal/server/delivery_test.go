package server

import (
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/wire"
)

func TestDeliveryRequiresConfirmationAndExpiresWithTheConnection(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)
	id, _ := r.device("b")
	uid := a.put("note.md", "complete note")
	read := func() wire.DeviceStatus {
		a.sendJSON(wire.In{Op: "devices"})
		var list wire.DeviceList
		a.recvInto("devices", &list)
		for _, d := range list.Devices {
			if d.ID == id {
				return d
			}
		}
		t.Fatal("device missing")
		return wire.DeviceStatus{}
	}
	if got := read(); !got.Online || got.Applied != nil {
		t.Fatalf("metadata receipt became delivery: %+v", got)
	}
	b.sendJSON(wire.In{Op: "applied", Applied: &uid})
	var ack wire.Applied
	b.recvInto("applied", &ack)
	if got := read(); got.Applied == nil || *got.Applied != uid {
		t.Fatalf("missing delivery: %+v", got)
	}
	for _, invalid := range []int64{-1, 0, uid + 1} {
		b.sendJSON(wire.In{Op: "applied", Applied: &invalid})
		b.expectErr(wire.CodeBadEntry)
	}
	b.sendJSON(wire.In{Op: "applied"})
	b.expectErr(wire.CodeBadEntry)
	if got := read(); got.Applied == nil || *got.Applied != uid {
		t.Fatal("invalid checkpoint replaced the confirmed one")
	}
	b.conn.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for read().Online {
		if time.Now().After(deadline) {
			t.Fatal("closed device still online")
		}
		time.Sleep(time.Millisecond)
	}
	if read().Applied != nil {
		t.Fatal("offline device retained a live confirmation")
	}
	b = r.dial("b")
	b.hello(uid)
	if got := read(); !got.Online || got.Applied != nil {
		t.Fatalf("reconnect trusted the metadata cursor: %+v", got)
	}
}
