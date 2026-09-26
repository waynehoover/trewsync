package server

import (
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/wire"
)

// `collision` through a real session (M1 task 11, PLAN.md section 4.1): a
// create whose folded key another live path has is refused with the code and
// the path it collides with, the session goes on, and nothing is committed.
func TestACollisionIsRefusedThroughASession(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.put("Notes/Idea.md", "first")

	for _, path := range []string{"notes/other.md", "Notes/idea.md", "NOTES/IDEA.md"} {
		names, size := chunkNames([]string{"second"})
		cl.sendJSON(wire.In{Op: "put", Path: path, Chunks: names,
			Meta: wire.PutMeta{Size: size, MTime: 2}})
		msg := cl.expectErr(wire.CodeCollision)
		if !strings.Contains(msg, "Notes") {
			t.Fatalf("the refusal of %q does not name what it collides with: %s", path, msg)
		}
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
	if st := r.mustStats(); st.Versions != 1 {
		t.Fatalf("%d versions, want only the first note", st.Versions)
	}

	// The same folder spelled the same way is not a collision.
	if uid := cl.put("Notes/another.md", "third"); uid == 0 {
		t.Fatal("a new note in the folder's own spelling was refused")
	}
}

// Inside a batch, each entry is checked against the state the earlier ones
// left, and a collision refuses its own slot and nothing else.
func TestACollisionInABatchRefusesItsOwnSlot(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	first, bodies := entryFor("Draft/one.md", "one")
	clash, more := entryFor("draft/two.md", "two")
	for k, v := range more {
		bodies[k] = v
	}
	fine, rest := entryFor("Draft/three.md", "three")
	for k, v := range rest {
		bodies[k] = v
	}
	acks := cl.putMany([]wire.PutEntry{first, clash, fine}, bodies)
	if acks.Results[0].UID == 0 || acks.Results[2].UID == 0 {
		t.Fatalf("the entries beside the collision were refused: %+v", acks.Results)
	}
	if acks.Results[1].Code != wire.CodeCollision {
		t.Fatalf("an entry colliding with one earlier in its own batch came back %+v", acks.Results[1])
	}
}

// An earlier entry of a batch that frees a folded key gives it to a later one,
// because each entry is checked against the state the earlier ones left
// (plan/protocol.md, "Paths"). A case-only rename a client found by scanning,
// rather than being told of, arrives as a deletion of Note.md and a create of
// NOTE.md. The collision question used to be asked of every entry before any
// committed, so the create was refused for colliding with a file the same
// batch was deleting, the deletion committed, and the note left every other
// device while its new name stayed on the one that renamed it.
func TestAnEntryThatFreesAKeyGivesItToALaterOneInTheBatch(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.put("Note.md", "the note")

	gone := wire.PutEntry{Path: "Note.md", Meta: wire.PutMeta{MTime: 6, Deleted: true}, Chunks: []string{}}
	renamed, bodies := entryFor("NOTE.md", "the note, renamed")
	acks := cl.putMany([]wire.PutEntry{gone, renamed}, bodies)
	if acks.Results[0].UID == 0 || acks.Results[1].UID == 0 {
		t.Fatalf("a deletion and the create it makes legal came back %+v", acks.Results)
	}
	if head := cl.head("NOTE.md"); head != acks.Results[1].UID {
		t.Fatalf("NOTE.md's head is %d, want the create's uid %d", head, acks.Results[1].UID)
	}

	// The other order is the same rule: the create is checked against a state
	// in which Note.md is still live, so it is refused, and the deletion after
	// it still commits on its own.
	r2 := newRig(t)
	c2 := r2.dial("a")
	c2.hello(0)
	c2.put("Note.md", "the note")
	created, more := entryFor("NOTE.md", "the note, renamed")
	acks = c2.putMany([]wire.PutEntry{created, gone}, more)
	if acks.Results[0].Code != wire.CodeCollision || acks.Results[1].UID == 0 {
		t.Fatalf("a create before the deletion that frees its key came back %+v", acks.Results)
	}
}

// A case-only rename is allowed, one move at a time, which is how a client
// renames a folder by case: each move keeps every folded key where it was.
func TestACaseOnlyRenameIsNotACollision(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.put("Folder/a.md", "a")
	cl.put("Folder/b.md", "b")

	for _, name := range []string{"a.md", "b.md"} {
		names, size := chunkNames([]string{name[:1]})
		cl.sendJSON(wire.In{Op: "put", Path: "folder/" + name, Chunks: names,
			Meta: wire.PutMeta{Size: size, MTime: 3, Prev: "Folder/" + name}, PrevBase: cl.head("Folder/" + name)})
		if m := cl.recv(); m["res"] != "have" {
			t.Fatalf("a case-only rename of %s was answered %v", name, m)
		}
	}
	// Mid-way or finished, a new file in either spelling the live set has is
	// fine; this is after, so only the new one is live.
	if uid := cl.put("folder/c.md", "c"); uid == 0 {
		t.Fatal("a new note under the new spelling was refused")
	}
}
