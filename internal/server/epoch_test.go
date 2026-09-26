package server

import (
	"encoding/json"
	"testing"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/wire"
)

// The epoch a hello may carry (plan/protocol.md, "Device session"). A cursor
// belongs to a history, and the store's epoch says which: one read under
// another epoch is a position in a history this store no longer is, so the
// whole vault is replayed rather than the cursor being trusted in either
// direction, and `ready` names the store's epoch so the client knows to
// reconcile against all of it.

// helloWithEpoch sends a device hello carrying cursor and epoch, and returns
// ready and the uids the catch-up replayed, checking continuity from where the
// replay says it starts.
func helloWithEpoch(t *testing.T, cl *client, cursor int64, epoch string) (wire.Ready, []int64) {
	t.Helper()
	in := cl.deviceHello(cursor)
	in.Epoch = epoch
	cl.sendJSON(in)
	var ready wire.Ready
	cl.recvInto("ready", &ready)
	var uids []int64
	next := int64(-1)
	for {
		data := cl.recvFrameOrBatch()
		var probe struct {
			Op     string `json:"op"`
			From   int64  `json:"from"`
			To     int64  `json:"to"`
			Cursor int64  `json:"cursor"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			t.Fatal(err)
		}
		switch probe.Op {
		case "batch":
			if next >= 0 && probe.From != next {
				t.Fatalf("a replay batch from %d after one ending at %d: a gap", probe.From, next-1)
			}
			var b wire.Batch
			if err := json.Unmarshal(data, &b); err != nil {
				t.Fatal(err)
			}
			for _, e := range b.Entries {
				uids = append(uids, e.UID)
			}
			next = probe.To + 1
		case "caught-up":
			return ready, uids
		default:
			t.Fatalf("unexpected frame during catch-up: %s", data)
		}
	}
}

// recvFrameOrBatch reads the next text frame whatever it is, batches included.
func (c *client) recvFrameOrBatch() []byte {
	c.t.Helper()
	typ, data, err := c.read()
	if err != nil {
		c.t.Fatalf("%s: read: %v", c.name, err)
	}
	if typ != websocket.MessageText {
		c.t.Fatalf("%s: a binary frame during catch-up", c.name)
	}
	return data
}

func TestACursorFromAnotherHistoryReplaysTheVaultFromTheStart(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{"a.md", "b.md", "c.md"} {
		r.seed(p, "body of "+p)
	}
	epoch := r.st.Epoch()

	// Under this store's epoch, a cursor is a cursor: the replay starts after
	// it, and one ahead of the history is refused.
	ready, uids := helloWithEpoch(t, r.dial("a"), 2, epoch)
	if ready.Epoch != epoch || len(uids) != 1 || uids[0] != 3 {
		t.Fatalf("a cursor under the store's epoch replayed %v, ready epoch %q", uids, ready.Epoch)
	}
	ahead := r.dial("a")
	in := ahead.deviceHello(99)
	in.Epoch = epoch
	ahead.sendJSON(in)
	ahead.expectErr(wire.CodeCursor)

	// Under another epoch it is not: the whole vault comes back, from uid 1,
	// whether the cursor was behind the history or ahead of it, and ready says
	// which epoch it is now.
	for _, cursor := range []int64{2, 99} {
		ready, uids := helloWithEpoch(t, r.dial("a"), cursor, "an epoch this store never had")
		if ready.Epoch != epoch || ready.Cursor != 3 {
			t.Fatalf("cursor %d under another epoch: ready %+v", cursor, ready)
		}
		if len(uids) != 3 || uids[0] != 1 || uids[2] != 3 {
			t.Fatalf("cursor %d under another epoch replayed %v, want the whole vault", cursor, uids)
		}
	}

	// And a client that sends no epoch keeps the behaviour it had: its cursor
	// is taken as it is, and one ahead is refused.
	noEpoch := r.dial("a")
	noEpoch.sendJSON(noEpoch.deviceHello(99))
	noEpoch.expectErr(wire.CodeCursor)
}
