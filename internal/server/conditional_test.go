package server

import (
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/wire"
)

func TestConditionalWriteChecksAgainAfterReceivingBodies(t *testing.T) {
	r := newRig(t)
	a, b := r.dial("a"), r.dial("b")
	a.hello(0)
	b.hello(0)
	base := a.put("note.md", "original")
	body := []byte("stale draft")
	b.sendJSON(wire.In{Op: "put", Path: "note.md", Base: base,
		Chunks: []string{chunks.Name(body)}, Meta: wire.PutMeta{Size: int64(len(body)), MTime: 2}})
	var want wire.Want
	b.recvInto("want", &want)
	winner := a.put("note.md", "newer edit")
	b.sendBinary(body)
	var refusal wire.Err
	b.recvInto("err", &refusal)
	if refusal.Code != wire.CodeStale || b.head("note.md") != winner {
		t.Fatalf("stale write replaced the head: refusal=%+v, head=%d", refusal, b.head("note.md"))
	}
	b.sendJSON(wire.In{Op: "devices"})
	b.recvInto("devices", nil)
}

func TestConditionalBatchKeepsIndependentWritesAndTombstones(t *testing.T) {
	r := newRig(t)
	c := r.dial("a")
	c.hello(0)
	base := c.put("note.md", "keep this")
	c.sendJSON(wire.In{Op: "putmany", Entries: []wire.PutEntry{
		{Path: "note.md", Base: 0, Meta: wire.PutMeta{Deleted: true, MTime: 2}},
		{Path: "new-folder", Base: 0, Meta: wire.PutMeta{Folder: true}},
	}})
	var acks wire.Acks
	c.recvInto("acks", &acks)
	if len(acks.Results) != 2 || acks.Results[0].Code != wire.CodeStale || acks.Results[1].UID == 0 || c.head("note.md") != base {
		t.Fatalf("unexpected partial batch: %+v", acks)
	}
	c.sendJSON(wire.In{Op: "put", Path: "note.md", Base: base,
		Meta: wire.PutMeta{Deleted: true, MTime: 3}})
	var deleted wire.Have
	c.recvInto("have", &deleted)
	c.sendJSON(wire.In{Op: "put", Path: "note.md", Base: base,
		Meta: wire.PutMeta{MTime: 4}})
	var refusal wire.Err
	c.recvInto("err", &refusal)
	if refusal.Code != wire.CodeStale || c.head("note.md") != deleted.UID {
		t.Fatal("an older write replaced a tombstone")
	}
	// After applying a deletion, clients may discard its local metadata.
	// A deliberate new file can occupy the now-empty path.
	c.sendJSON(wire.In{Op: "put", Path: "note.md", Base: 0, Meta: wire.PutMeta{MTime: 5}})
	c.recvInto("have", nil)
}

func TestConditionalRenameGuardsItsSource(t *testing.T) {
	r := newRig(t)
	c := r.dial("a")
	c.hello(0)
	original := c.put("from.md", "original")
	newer := c.put("from.md", "new source edit")
	c.sendJSON(wire.In{Op: "put", Path: "to.md", Base: 0, PrevBase: original,
		Meta: wire.PutMeta{Prev: "from.md", MTime: 2}})
	var refusal wire.Err
	c.recvInto("err", &refusal)
	if refusal.Code != wire.CodeStale || c.head("from.md") != newer || c.head("to.md") != 0 {
		t.Fatalf("rename retired an unseen source edit: %+v", refusal)
	}
	uid := c.rename("to.md", "from.md", "new source edit")
	if c.head("from.md") != uid || c.head("to.md") != uid {
		t.Fatal("rename must establish both logical heads at the same UID")
	}
}
