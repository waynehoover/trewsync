package server

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/wire"
)

// pathVector is one case of the `paths` section of protocol-fixtures.json:
// UTF-8 bytes in hex, whether the protocol accepts them, and the first rule
// they break. The vectors come from scripts/protocol-vectors.py, not from the
// server, and the TypeScript client reads the same file.
type pathVector struct {
	Name   string  `json:"name"`
	Hex    string  `json:"hex"`
	Valid  bool    `json:"valid"`
	Reason *string `json:"reason"`
}

func pathVectors(t *testing.T) []pathVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Paths struct {
			Cases []pathVector `json:"cases"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Paths.Cases) < 20 {
		t.Fatalf("only %d path vectors, which is not a matrix", len(f.Paths.Cases))
	}
	return f.Paths.Cases
}

func (v pathVector) path(t *testing.T) string {
	t.Helper()
	b, err := hex.DecodeString(v.Hex)
	if err != nil {
		t.Fatalf("%s: %v", v.Name, err)
	}
	return string(b)
}

// expectBadPath reads a refusal and requires it to be `badpath` for the given
// field, leading with the vector's reason: the code a client acts on and the
// rule the person reads, both of which the two implementations must agree on.
func expectBadPath(t *testing.T, c *client, v pathVector, field string) {
	t.Helper()
	msg := c.expectErr(wire.CodeBadPath)
	want := *v.Reason + ": the " + field + " "
	if !strings.HasPrefix(msg, want) {
		t.Fatalf("%s: refused as %q, want it to lead with %q", v.Name, msg, want)
	}
}

// The badpath matrix, through a real session (M1 task 11).
//
// Every vector the fixtures carry, as each kind of entry a client can send:
// a file, a folder, a deletion, and the source of a rename. A refused one is
// `badpath` with the fixture's reason leading the message, the session goes
// on, and nothing of it is committed; an accepted one commits as all four.
// Folders and deletions are in it on purpose: a rule that checked only files
// is exactly the shape F20 was, and the strip ledger names this test as where
// that guarantee now lives.
//
// The vectors that are not UTF-8 cannot be said in JSON at all, and the
// decoder would quietly turn them into U+FFFD, which is a different path. So
// they go on the wire as the raw bytes a hostile client would send, and the
// frame is refused before it is decoded.
//
// At protocol 2, because these are the notes rule's verdicts, which every
// session of 1 or 2 is held to. Protocol 3 admits settings inside a profile
// root, and its matrix is TestTheSettingsMatrixThroughASession.
func TestTheBadpathMatrixThroughASession(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.proto = wire.ProtoConfig - 1
	cl.hello(0)
	body := "a body"
	names, size := chunkNames([]string{body})

	committed := 0
	var notText []pathVector
	for i, v := range pathVectors(t) {
		p := v.path(t)
		if !utf8.ValidString(p) {
			notText = append(notText, v)
			continue
		}
		if !v.Valid {
			for _, in := range []wire.In{
				{Op: "put", Path: p, Chunks: names, Meta: wire.PutMeta{Size: size, MTime: 1}},
				{Op: "put", Path: p, Meta: wire.PutMeta{Folder: true, MTime: 1}},
				{Op: "put", Path: p, Meta: wire.PutMeta{Deleted: true, MTime: 1}},
			} {
				cl.sendJSON(in)
				expectBadPath(t, cl, v, "path")
			}
			// An empty prev is not a rename at all, so that vector has no
			// rename to refuse.
			if p != "" {
				cl.sendJSON(wire.In{Op: "put", Path: fmt.Sprintf("moved/%d.md", i), Chunks: names,
					Meta: wire.PutMeta{Size: size, MTime: 1, Prev: p}})
				expectBadPath(t, cl, v, "prev")
			}
			continue
		}

		// Accepted as every kind, in an order that is legal throughout: a
		// folder, the same path becoming a file, deleted, made again, then
		// renamed away.
		for _, in := range []wire.In{
			{Op: "put", Path: p, Meta: wire.PutMeta{Folder: true, MTime: 1}},
			{Op: "put", Path: p, Chunks: names, Meta: wire.PutMeta{Size: size, MTime: 2}},
			{Op: "put", Path: p, Meta: wire.PutMeta{Deleted: true, MTime: 3}},
			{Op: "put", Path: p, Chunks: names, Meta: wire.PutMeta{Size: size, MTime: 4}},
		} {
			in.Base = cl.head(p)
			cl.sendJSON(in)
			switch m := cl.recv(); {
			case m["res"] == "want":
				cl.sendBinary([]byte(body))
				cl.recvInto("ack", nil)
			case m["res"] != "have":
				t.Fatalf("%s: a legal path was answered %v", v.Name, m)
			}
			committed++
		}
		dest := fmt.Sprintf("moved/%d.md", i)
		cl.sendJSON(wire.In{Op: "put", Path: dest, Chunks: names,
			Meta: wire.PutMeta{Size: size, MTime: 5, Prev: p}, PrevBase: cl.head(p)})
		if m := cl.recv(); m["res"] != "have" {
			t.Fatalf("%s: a rename from a legal path was answered %v", v.Name, m)
		}
		committed++
	}
	if len(notText) == 0 {
		t.Fatal("no vector is invalid UTF-8, so the frame check was never tried")
	}
	if got := r.mustStats().Versions; got != int64(committed) {
		t.Fatalf("%d versions in the store after %d accepted writes: a refused path was committed", got, committed)
	}

	// The same refusals inside one batch, slot by slot, beside an entry that
	// commits: badpath refuses the entry, never the batch.
	var entries []wire.PutEntry
	var refused []pathVector
	for _, v := range pathVectors(t) {
		if p := v.path(t); !v.Valid && utf8.ValidString(p) {
			entries = append(entries, wire.PutEntry{Path: p, Chunks: names,
				Meta: wire.PutMeta{Size: size, MTime: 6}})
			refused = append(refused, v)
		}
	}
	entries = append(entries, wire.PutEntry{Path: "batch-ok.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 6}})
	acks := cl.putMany(entries, map[string]string{names[0]: body})
	for k, v := range refused {
		got := acks.Results[k]
		if got.Code != wire.CodeBadPath || !strings.HasPrefix(got.Msg, *v.Reason+": ") {
			t.Fatalf("%s in a batch came back as %+v, want badpath leading with %q", v.Name, got, *v.Reason)
		}
	}
	if last := acks.Results[len(entries)-1]; last.UID == 0 {
		t.Fatalf("the legal entry beside them was refused: %+v", last)
	}

	// Not text: the raw bytes, and the same thing escaped as JSON would carry
	// half a surrogate pair. Each ends the session with protostate, and none
	// is ever a stored path.
	before := r.mustStats().Versions
	frames := [][]byte{[]byte(`{"op":"put","id":1,"path":"a\ud800.md","meta":{"size":0},"chunks":[]}`)}
	for _, v := range notText {
		raw, _ := hex.DecodeString(v.Hex)
		frames = append(frames, append(append([]byte(`{"op":"put","id":1,"path":"`), raw...),
			[]byte(`","meta":{"size":0},"chunks":[]}`)...))
	}
	for _, frame := range frames {
		c := r.dial("a")
		c.hello(0)
		if err := c.conn.Write(c.ctx, websocket.MessageText, frame); err != nil {
			t.Fatal(err)
		}
		if m := c.recv(); m["res"] != "err" || m["code"] != wire.CodeProtoState {
			t.Fatalf("a frame that is not text (%q) was answered %v, want protostate", frame, m)
		}
		if !c.closed() {
			t.Fatalf("the session survived a frame that is not text: %q", frame)
		}
	}
	if after := r.mustStats().Versions; after != before {
		t.Fatalf("%d versions committed from frames that are not text", after-before)
	}
}
