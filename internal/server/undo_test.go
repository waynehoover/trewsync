package server

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// agentEdit commits an agent's edit of path, from base to body, through the
// store's commit boundary as the MCP tools do, and broadcasts it: what a
// device on the vault meets when an agent writes.
func (r *rig) agentEdit(path string, base int64, body string) store.OpResult {
	r.t.Helper()
	tok, err := r.st.CreateMCPToken(testVault, "agent", store.ScopeWrite, nil, 1)
	if err != nil {
		r.t.Fatal(err)
	}
	n := chunks.Name([]byte(body))
	if err := r.st.Chunks().Put(testVault, n, []byte(body)); err != nil {
		r.t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(path + body))
	op := store.Operation{
		Vault: testVault, ActorID: tok.ID, ActorHash: store.MCPTokenHash(tok.Token), ActorLabel: "agent",
		Tool: "edit_note", RequestDigest: hex.EncodeToString(sum[:]), Epoch: r.st.Epoch(),
		Entries: []store.OpEntry{{Entry: store.Entry{Path: path, Size: int64(len(body)), MTime: 2, Device: "agent",
			Chunks: []string{n}}, Base: base}},
		Render: func(store.OpResult) ([]byte, error) { return []byte(`{}`), nil }, MaxResult: 1 << 10,
	}
	var res store.OpResult
	if err := r.srv.UnderCommitLock(func() error {
		var err error
		res, err = r.st.CommitOperation(op)
		if err == nil {
			r.srv.Broadcast(testVault, res.Committed())
		}
		return err
	}); err != nil {
		r.t.Fatalf("the agent's edit: %v", err)
	}
	return res
}

// historyOf asks for a path's history on this connection.
func (c *client) historyOf(path string) []wire.HistoryEntry {
	c.t.Helper()
	c.sendJSON(wire.In{Op: "history", Path: path})
	var h wire.HistoryV2
	c.recvInto("history", &h)
	return h.Entries
}

// bytesAt fetches a version's bytes over the connection, as a device reads them.
func (c *client) bytesAt(e store.Entry) string {
	c.t.Helper()
	var b strings.Builder
	for _, body := range c.fetch(e.Chunks...) {
		b.Write(body)
	}
	return b.String()
}

// A device undoes an agent's edit (protocol 2): its history names the
// operation, the undo writes the former bytes back as a new version recorded
// as the device's, and every device on the vault, the one that asked
// included, receives that version in an ordinary batch before the reply.
func TestADeviceUndoesAnAgentsEditAndEveryDeviceHasIt(t *testing.T) {
	r := newRig(t)
	note := r.seed("note.md", "what the note said before the agent")
	laptop, phone := r.dial("laptop"), r.dial("phone")
	laptop.hello(0)
	phone.hello(0)
	edit := r.agentEdit("note.md", note.UID, "what the agent wrote")
	laptop.nextBatch()
	phone.nextBatch()

	h := phone.historyOf("note.md")
	if len(h) != 2 || h[0].Op == nil || h[0].Op.ID != edit.OpID || h[0].Op.Tool != "edit_note" ||
		h[0].Op.Kind != store.AuthorKindMCP || h[1].Op != nil {
		t.Fatalf("the history is %+v", h)
	}

	phone.sendJSON(wire.In{Op: "undo", OpID: edit.OpID})
	var done wire.Undone
	phone.recvInto("undone", &done)
	if done.Undoes != edit.OpID || done.ToCopy || len(done.Entries) != 1 || len(done.Steps) != 1 ||
		done.Steps[0].Action != store.UndoRestore || done.Entries[0].PreviousUID != edit.Entries[0].Entry.UID {
		t.Fatalf("undone %+v", done)
	}
	for _, c := range []*client{phone, laptop} {
		b := c.nextBatch()
		if len(b.Entries) != 1 || b.Entries[0].UID != done.Entries[0].UID || b.Entries[0].Device != "phone" {
			t.Fatalf("%s received %+v", c.name, b)
		}
		if got := c.bytesAt(b.Entries[0]); got != "what the note said before the agent" {
			t.Fatalf("%s reads %q", c.name, got)
		}
	}
	rec, ok, err := r.st.LookupOperation(testVault, done.OpID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	id, _ := r.device("phone")
	if rec.Tool != store.UndoTool || rec.Undoes != edit.OpID || rec.ActorKind != store.ActorDevice ||
		rec.ActorID != id || rec.ActorLabel != "phone" {
		t.Fatalf("recorded as %+v", rec)
	}
	if h := phone.historyOf("note.md"); h[0].Op == nil || h[0].Op.ID != done.OpID || h[1].Op.UndoneBy != done.OpID {
		t.Fatalf("the history after the undo is %+v", h)
	}
	// Undoing it again is refused, naming the undo that did it.
	phone.sendJSON(wire.In{Op: "undo", OpID: edit.OpID})
	if msg := phone.expectErr(wire.CodeNoUndo); !strings.HasPrefix(msg, "already_undone:") || !strings.Contains(msg, done.OpID) {
		t.Fatalf("the second undo: %q", msg)
	}
}

// A note changed since refuses the undo as stale, naming the path and who
// changed it, and writes nothing; the copy then writes the version the agent
// replaced beside the note and leaves the person's edit where it is.
func TestAnUndoOfAChangedNoteIsStaleAndTheCopyIsNot(t *testing.T) {
	r := newRig(t)
	note := r.seed("note.md", "before the agent")
	laptop, phone := r.dial("laptop"), r.dial("phone")
	laptop.hello(0)
	phone.hello(0)
	edit := r.agentEdit("note.md", note.UID, "the agent's")
	laptop.nextBatch()
	phone.nextBatch()
	mine := laptop.put("note.md", "the laptop's edit after the agent")
	laptop.nextBatch() // its own range, which carries no entries
	phone.nextBatch()

	latest, _ := r.st.LatestUID(testVault)
	phone.sendJSON(wire.In{Op: "undo", OpID: edit.OpID})
	msg := phone.expectErr(wire.CodeStale)
	if !strings.Contains(msg, `"note.md"`) || !strings.Contains(msg, `written by "laptop"`) {
		t.Fatalf("the refusal says %q", msg)
	}
	if now, _ := r.st.LatestUID(testVault); now != latest {
		t.Fatalf("a refused undo moved the vault from %d to %d", latest, now)
	}

	phone.sendJSON(wire.In{Op: "undo", OpID: edit.OpID, ToCopy: true})
	var done wire.Undone
	phone.recvInto("undone", &done)
	want := "note (restored " + strconv.FormatInt(note.UID, 10) + ").md"
	if !done.ToCopy || len(done.Steps) != 1 || done.Steps[0].Copy != want {
		t.Fatalf("the copy: %+v", done)
	}
	b := laptop.nextBatch()
	if len(b.Entries) != 1 || b.Entries[0].Path != want || laptop.bytesAt(b.Entries[0]) != "before the agent" {
		t.Fatalf("the laptop received %+v", b)
	}
	if head := laptop.head("note.md"); head != mine {
		t.Fatalf("the copy moved note.md from %d to %d", mine, head)
	}
	phone.nextBatch()
}

// Refusals that no retry changes: an operation the vault never committed is
// noundo, and an id that is not one is badentry. The session goes on.
func TestAnUndoOfNothingIsRefusedAndTheSessionGoesOn(t *testing.T) {
	r := newRig(t)
	phone := r.dial("phone")
	phone.hello(0)
	phone.sendJSON(wire.In{Op: "undo", OpID: "AAAAAAAAAAAAAAAAAAAAAA"})
	if msg := phone.expectErr(wire.CodeNoUndo); !strings.HasPrefix(msg, "not_found:") {
		t.Fatalf("an unknown operation: %q", msg)
	}
	phone.sendJSON(wire.In{Op: "undo", OpID: "not an id"})
	phone.expectErr(wire.CodeBadEntry)
	phone.sendJSON(wire.In{Op: "ping"})
	phone.recvInto("pong", nil)
}

// A session of protocol 1 is answered as protocol 1 was: its ready says 1,
// undo is an unknown op that rejects the request and not the session, and a
// history entry carries no operation, exactly the shape protocol 1 has.
func TestAProtocolOneSessionIsAnsweredAsProtocolOneWas(t *testing.T) {
	r := newRig(t)
	note := r.seed("note.md", "before")
	edit := r.agentEdit("note.md", note.UID, "after")
	old := r.dial("old-plugin")
	hello := old.deviceHello(0)
	hello.Proto = 1
	old.sendJSON(hello)
	var ready wire.Ready
	old.recvInto("ready", &ready)
	if ready.Proto != 1 || ready.MinProto != 1 {
		t.Fatalf("ready %+v", ready)
	}
	old.nextBatch()
	old.recvInto("caught-up", nil)

	old.sendJSON(wire.In{Op: "history", Path: "note.md"})
	if raw := old.recvRaw(); strings.Contains(raw, `"op"`) {
		t.Fatalf("a protocol 1 history carries an operation: %s", raw)
	}
	old.sendJSON(wire.In{Op: "undo", OpID: edit.OpID})
	if msg := old.expectErr(wire.CodeProtoState); !strings.Contains(msg, `unknown op "undo"`) {
		t.Fatalf("undo at protocol 1: %q", msg)
	}
	old.sendJSON(wire.In{Op: "ping"})
	old.recvInto("pong", nil)
	if rec, _, _ := r.st.LookupOperation(testVault, edit.OpID); rec.UndoneBy != "" {
		t.Fatal("a protocol 1 undo undid something")
	}
}

// The operator's undo, the control socket's, reaches every connected device
// as the operator's version, and the log records it as the operator's.
func TestTheOperatorsUndoReachesTheDevices(t *testing.T) {
	r := newRig(t)
	note := r.seed("note.md", "before the agent")
	phone := r.dial("phone")
	phone.hello(0)
	edit := r.agentEdit("note.md", note.UID, "the agent's")
	phone.nextBatch()

	done, err := r.srv.OperatorUndo(testVault, edit.OpID, false)
	if err != nil {
		t.Fatalf("the operator's undo: %v", err)
	}
	b := phone.nextBatch()
	if len(b.Entries) != 1 || b.Entries[0].Device != store.OperatorLabel || phone.bytesAt(b.Entries[0]) != "before the agent" {
		t.Fatalf("the phone received %+v", b)
	}
	rec, _, _ := r.st.LookupOperation(testVault, done.Result.OpID)
	if rec.ActorKind != store.ActorOperator || rec.ActorID != store.OperatorActorID || rec.ActorLabel != store.OperatorLabel {
		t.Fatalf("recorded as %+v", rec)
	}
	// The operator is not a device: it is in no device list.
	ds, err := r.srv.DeliveryStatus(testVault)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range ds {
		if d.Name == store.OperatorLabel || d.ID == store.OperatorActorID {
			t.Fatalf("the operator is listed as a device: %+v", d)
		}
	}
}
