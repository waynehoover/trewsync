package server

import (
	"testing"

	"github.com/waynehoover/trew/internal/wire"
)

func TestOverlappingSessionDelivery(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)
	id, _ := r.device("b")
	uid := a.put("note.md", "latest content")
	b.sendJSON(wire.In{Op: "applied", Applied: &uid})
	var ack wire.Applied
	b.recvInto("applied", &ack)
	// Same device reconnects before the server notices its old connection died.
	b2 := r.dial("b")
	b2.hello(0)
	a.sendJSON(wire.In{Op: "devices"})
	var list wire.DeviceList
	a.recvInto("devices", &list)
	for _, d := range list.Devices {
		if d.ID == id && d.Applied != nil {
			t.Fatalf("device reported applied=%d although its replacement session has never confirmed delivery", *d.Applied)
		}
	}
}
