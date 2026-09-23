package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/telimus/internal/chunks"
	"github.com/waynehoover/telimus/internal/frame"
	"github.com/waynehoover/telimus/internal/store"
	"github.com/waynehoover/telimus/internal/wire"
)

// frameVectors is the `frames` section of protocol-fixtures.json, which the
// frame package and the TypeScript client also consume. The vectors are the
// reference's (scripts/protocol-vectors.py), not this server's.
type frameVectors struct {
	ChunkMax int `json:"chunkMax"`
	Good     []struct {
		Why   string `json:"why"`
		Frame string `json:"frame"`
		Raw   string `json:"raw"`
		Name  string `json:"name"`
	} `json:"good"`
	Generated []struct {
		Why    string `json:"why"`
		Marker byte   `json:"marker"`
		Valid  bool   `json:"valid"`
		Name   string `json:"name"`
		Gen    struct {
			Kind   string `json:"kind"`
			Seed   string `json:"seed"`
			Length int    `json:"length"`
		} `json:"gen"`
	} `json:"generated"`
	Bad []struct {
		Why   string `json:"why"`
		Frame string `json:"frame"`
	} `json:"bad"`
}

func loadFrameVectors(t *testing.T) frameVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Frames frameVectors `json:"frames"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Frames.ChunkMax != store.ChunkMax || len(f.Frames.Good) < 5 || len(f.Frames.Bad) < 6 {
		t.Fatalf("the frames section is not the contract this server enforces: chunkMax %d, %d good, %d bad",
			f.Frames.ChunkMax, len(f.Frames.Good), len(f.Frames.Bad))
	}
	return f.Frames
}

// sha256CTR is the fixture's generator for bytes too large to store in it,
// the same function the frame package's test and the reference use.
func sha256CTR(seed string, length int) []byte {
	out := make([]byte, 0, length+sha256.Size)
	var counter [4]byte
	for i := uint32(0); len(out) < length; i++ {
		binary.BigEndian.PutUint32(counter[:], i)
		sum := sha256.Sum256(append([]byte(seed), counter[:]...))
		out = append(out, sum[:]...)
	}
	return out[:length]
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// uploadFrame puts one entry naming one chunk and answers its want with the
// frame given, exactly, and returns the reply.
func uploadFrame(t *testing.T, cl *client, path, name string, size int64, framed []byte) map[string]any {
	t.Helper()
	cl.sendJSON(wire.In{Op: "put", Path: path, Chunks: []string{name},
		Meta: wire.PutMeta{Size: size, MTime: 1}})
	if m := cl.recv(); m["res"] != "want" {
		t.Fatalf("%s: the put was answered %v before any body was sent", path, m)
	}
	cl.sendFrame(framed)
	return cl.recv()
}

// Every frame the fixtures call good is accepted by a real session, however
// it was encoded, and what the store keeps is the raw chunk: a frame's marker
// and its deflate stream are the wire's business and never reach a file. The
// generated vectors are the boundaries, a raw chunk at exactly chunkMax with
// the marker on top and a deflate stream that inflates to exactly chunkMax.
func TestEveryGoodFrameIsAcceptedAndStoredRaw(t *testing.T) {
	f := loadFrameVectors(t)
	type vector struct {
		why    string
		framed []byte
		raw    []byte
		name   string
	}
	var vectors []vector
	for _, g := range f.Good {
		vectors = append(vectors, vector{g.Why, mustHex(t, g.Frame), mustHex(t, g.Raw), g.Name})
	}
	for _, g := range f.Generated {
		if !g.Valid {
			continue
		}
		raw := make([]byte, g.Gen.Length)
		if g.Gen.Kind == "sha256-ctr" {
			raw = sha256CTR(g.Gen.Seed, g.Gen.Length)
		}
		framed := append([]byte{frame.MarkerRaw}, raw...)
		if g.Marker == frame.MarkerDeflate {
			framed = frame.Encode(raw)
		}
		vectors = append(vectors, vector{g.Why, framed, raw, g.Name})
	}
	for _, v := range vectors {
		t.Run(v.why, func(t *testing.T) {
			if chunks.Name(v.raw) != v.name {
				t.Fatalf("the vector's raw bytes are not its name's: the fixture or the generator moved")
			}
			r := newRig(t)
			cl := r.dial("a")
			cl.hello(0)
			if m := uploadFrame(t, cl, "note.md", v.name, int64(len(v.raw)), v.framed); m["res"] != "ack" {
				t.Fatalf("a good frame was answered %v", m)
			}
			stored, err := r.st.Chunks().Get(testVault, v.name)
			if err != nil || !bytes.Equal(stored, v.raw) {
				t.Fatalf("the store holds %d bytes (%v), not the %d raw bytes the frame carried", len(stored), err, len(v.raw))
			}
			if got := cl.fetch(v.name); !bytes.Equal(got[0], v.raw) {
				t.Fatal("fetching it back did not give the raw bytes")
			}
		})
	}
}

// Every frame the fixtures call bad ends the upload with badchunk, and a frame
// over the limit, before inflating or while inflating, ends it with toolarge.
// Mid-upload there is no way to carry on without both ends agreeing how many
// frames remain, so the session closes. Nothing is stored and nothing
// commits. This is the frame decoder's bounds held at the one place a hostile
// client meets them.
func TestEveryBadFrameEndsTheUploadWithItsCode(t *testing.T) {
	f := loadFrameVectors(t)
	want := []byte("hello\n")
	name := chunks.Name(want)
	type bad struct {
		why     string
		framed  []byte
		code    string
		decoder bool // refused by the frame decoder, not by the name check after it
	}
	var cases []bad
	for _, b := range f.Bad {
		cases = append(cases, bad{b.Why, mustHex(t, b.Frame), wire.CodeBadChunk, true})
	}
	for _, g := range f.Generated {
		if g.Valid {
			continue
		}
		raw := make([]byte, g.Gen.Length)
		if g.Gen.Kind == "sha256-ctr" {
			raw = sha256CTR(g.Gen.Seed, g.Gen.Length)
		}
		framed := append([]byte{frame.MarkerRaw}, raw...)
		if g.Marker == frame.MarkerDeflate {
			framed = frame.Encode(raw)
		}
		cases = append(cases, bad{g.Why, framed, wire.CodeToolarge, true})
	}
	// A frame that decodes perfectly well to a body nobody asked for: the
	// name is checked against the decoded bytes.
	cases = append(cases, bad{"a good frame of another chunk", frame.Encode([]byte("goodbye\n")), wire.CodeBadChunk, false})
	for _, c := range cases {
		t.Run(c.why, func(t *testing.T) {
			r := newRig(t)
			cl := r.dial("a")
			cl.hello(0)
			m := uploadFrame(t, cl, "note.md", name, int64(len(want)), c.framed)
			if m["res"] != "err" || m["code"] != c.code {
				t.Fatalf("a bad frame was answered %v, want %s", m, c.code)
			}
			// Refused for the right reason: a server that hashed the frame
			// as it arrived, marker and all, would also answer badchunk,
			// and a limit on the frame is not a limit on what it inflates to.
			if msg, _ := m["msg"].(string); c.decoder != strings.Contains(msg, "frame: ") {
				t.Fatalf("refused, but not by the decoder as it should have been: %s", msg)
			}
			if !cl.closed() {
				t.Fatal("the session carried on after a frame it could not read")
			}
			if r.st.Chunks().Has(testVault, name) {
				t.Fatal("a body was stored from a frame that was refused")
			}
			if st := r.mustStats(); st.Versions != 0 {
				t.Fatalf("%d versions committed", st.Versions)
			}
		})
	}
}

// The allowance counts what a frame inflates to, not what crossed the wire: a
// few bytes of deflate that expand past what the entry declares are cut off
// with toolarge, and the same frame is fine under an honest size.
func TestTheUploadAllowanceCountsInflatedBytes(t *testing.T) {
	big := make([]byte, 200_000)
	name := chunks.Name(big)
	framed := frame.Encode(big)
	if framed[0] != frame.MarkerDeflate || len(framed) > 1000 {
		t.Fatalf("zeros did not deflate to a small frame (%d bytes), so this proves nothing", len(framed))
	}

	r := newRig(t)
	liar := r.dial("a")
	liar.hello(0)
	liar.sendJSON(wire.In{Op: "put", Path: "lie.md", Chunks: []string{name},
		Meta: wire.PutMeta{Size: 1000, MTime: 1}})
	liar.recvInto("want", nil)
	liar.sendFrame(framed)
	if msg := liar.expectErr(wire.CodeToolarge); msg == "" {
		t.Fatal("no message")
	}
	if r.st.Chunks().Has(testVault, name) {
		t.Fatal("the body that outran its entry's size was stored")
	}

	honest := r.dial("a")
	honest.hello(0)
	if m := uploadFrame(t, honest, "real.md", name, int64(len(big)), framed); m["res"] != "ack" {
		t.Fatalf("an honestly sized deflated upload was answered %v", m)
	}
}

// A fetch frames each body the way the protocol says a sender must: deflated
// only when that is shorter, raw otherwise, so no frame is ever more than one
// byte longer than its chunk, and every one decodes to the stored bytes.
func TestFetchDeflatesOnlyWhenItIsShorter(t *testing.T) {
	r := newRig(t)
	compressible := bytes.Repeat([]byte("the same sentence, over and over. "), 2000)
	incompressibleBody := incompressible(7, 64<<10)
	var names []string
	for _, b := range [][]byte{compressible, incompressibleBody} {
		n := chunks.Name(b)
		if err := r.st.Chunks().Put(testVault, n, b); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	cl := r.dial("a")
	cl.hello(0)
	cl.sendJSON(wire.In{Op: "fetch", Chunks: names})
	cl.expectBodies(2)
	for i, want := range [][]byte{compressible, incompressibleBody} {
		framed := cl.recvFrameBytes()
		raw, err := frame.Decode(framed, store.ChunkMax)
		if err != nil || !bytes.Equal(raw, want) {
			t.Fatalf("body %d did not decode to what the store holds: %v", i, err)
		}
		if len(framed) > len(want)+1 {
			t.Fatalf("body %d is a %d byte frame for a %d byte chunk", i, len(framed), len(want))
		}
		switch i {
		case 0:
			if framed[0] != frame.MarkerDeflate || len(framed) >= len(want) {
				t.Fatalf("a body that compresses went out as marker %d, %d bytes", framed[0], len(framed))
			}
		case 1:
			if framed[0] != frame.MarkerRaw {
				t.Fatalf("a body that does not compress went out as marker %d", framed[0])
			}
		}
	}
}

// A repair is an upload (plan/protocol.md, "resend is an upload path"): its
// bodies arrive as frames and go through the same decoder, so a deflated
// repair body is stored raw and a bad frame ends it the same way.
func TestAResendReadsFrames(t *testing.T) {
	r := newRig(t)
	body := bytes.Repeat([]byte("a note that compresses well. "), 400)
	e := r.seed("note.md", string(body))
	path, err := r.st.Chunks().Path(testVault, e.Chunks[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	bad := r.dial("a")
	bad.hello(0)
	bad.sendJSON(wire.In{Op: "resend", Chunks: e.Chunks})
	bad.recvInto("want", nil)
	bad.sendFrame([]byte{2, 'x'})
	bad.expectErr(wire.CodeBadChunk)

	cl := r.dial("a")
	cl.hello(0)
	cl.sendJSON(wire.In{Op: "resend", Chunks: e.Chunks})
	cl.recvInto("want", nil)
	framed := frame.Encode(body)
	if framed[0] != frame.MarkerDeflate {
		t.Fatal("the repair body did not deflate, so this proves nothing about inflating")
	}
	cl.sendFrame(framed)
	var got wire.Resent
	cl.recvInto("resent", &got)
	if got.Stored != 1 || got.Missing != 0 {
		t.Fatalf("resent %+v", got)
	}
	stored, err := r.st.Chunks().Get(testVault, e.Chunks[0])
	if err != nil || !bytes.Equal(stored, body) {
		t.Fatalf("the repaired body is not the raw chunk: %v", err)
	}
}
