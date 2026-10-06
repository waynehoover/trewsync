package frame

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type fixtures struct {
	Frames struct {
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
	} `json:"frames"`
}

func load(t *testing.T) fixtures {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Frames.ChunkMax != 1<<20 || len(f.Frames.Good) < 5 || len(f.Frames.Bad) < 6 {
		t.Fatalf("the frames section is not a contract: %+v", f.Frames)
	}
	return f
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// sha256CTR is the fixture's generator: SHA-256(seed || counter) for counter
// 0, 1, 2 ..., big-endian, concatenated and cut to length.
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

func name(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestGoodFramesDecodeToTheirChunk(t *testing.T) {
	f := load(t)
	for _, g := range f.Frames.Good {
		raw, err := Decode(unhex(t, g.Frame), f.Frames.ChunkMax)
		if err != nil {
			t.Errorf("%s: %v", g.Why, err)
			continue
		}
		if !bytes.Equal(raw, unhex(t, g.Raw)) || name(raw) != g.Name {
			t.Errorf("%s: decoded to the wrong bytes", g.Why)
		}
	}
}

func TestBadFramesAreRefused(t *testing.T) {
	f := load(t)
	for _, b := range f.Frames.Bad {
		if raw, err := Decode(unhex(t, b.Frame), f.Frames.ChunkMax); err == nil {
			t.Errorf("%s: accepted, as %d bytes", b.Why, len(raw))
		}
	}
}

// The limit cases, generated rather than stored: a megabyte does not belong in
// a JSON file. The raw bytes are the reference's; the deflating is this
// package's own, and what is checked is what comes out.
func TestTheChunkLimitHoldsAtTheBoundary(t *testing.T) {
	f := load(t)
	for _, g := range f.Frames.Generated {
		var raw []byte
		switch g.Gen.Kind {
		case "sha256-ctr":
			raw = sha256CTR(g.Gen.Seed, g.Gen.Length)
		case "zeros":
			raw = make([]byte, g.Gen.Length)
		default:
			t.Fatalf("%s: unknown generator %q", g.Why, g.Gen.Kind)
		}
		if name(raw) != g.Name {
			t.Fatalf("%s: the generator does not reproduce the reference bytes", g.Why)
		}
		var framed []byte
		if g.Marker == MarkerDeflate {
			framed = Encode(raw)
			if framed[0] != MarkerDeflate {
				t.Fatalf("%s: Encode chose raw for bytes that compress", g.Why)
			}
		} else {
			framed = append([]byte{MarkerRaw}, raw...)
		}
		out, err := Decode(framed, f.Frames.ChunkMax)
		if g.Valid {
			if err != nil || name(out) != g.Name {
				t.Errorf("%s: %v", g.Why, err)
			}
		} else if err == nil || !errors.Is(err, ErrTooLarge) {
			t.Errorf("%s: want a limit refusal, got %v", g.Why, err)
		}
	}
}

func TestEncodeRoundTripsAndOnlyDeflatesWhenShorter(t *testing.T) {
	for _, raw := range [][]byte{
		[]byte("a"),
		bytes.Repeat([]byte("compressible "), 400),
		sha256CTR("incompressible", 4096),
		{0x00}, {0x01, 0x00},
	} {
		framed := Encode(raw)
		if len(framed) > len(raw)+1 {
			t.Errorf("a %d-byte chunk framed to %d bytes", len(raw), len(framed))
		}
		out, err := Decode(framed, 1<<20)
		if err != nil || !bytes.Equal(out, raw) {
			t.Errorf("a %d-byte chunk did not round-trip: %v", len(raw), err)
		}
	}
}

// An incompressible chunk skips the whole-chunk deflate, a compressible one does
// not, and a chunk whose head is incompressible but whose body compresses is
// sent raw: the probe only ever chooses raw, which is always a valid frame.
func TestTheProbeSkipsDeflatingIncompressibleChunks(t *testing.T) {
	noise := sha256CTR("probe", 64*1024)
	if f := Encode(noise); f[0] != MarkerRaw || len(f) != len(noise)+1 {
		t.Fatalf("an incompressible chunk was not sent raw")
	}
	text := bytes.Repeat([]byte("compressible text "), 4000)
	if f := Encode(text); f[0] != MarkerDeflate {
		t.Fatalf("a compressible chunk was not deflated")
	}
	mixed := append(append([]byte{}, noise[:probeBytes]...), text...)
	f := Encode(mixed)
	if f[0] != MarkerRaw {
		t.Fatalf("a chunk with an incompressible head was deflated whole")
	}
	if out, err := Decode(f, 1<<20); err != nil || !bytes.Equal(out, mixed) {
		t.Fatalf("the raw frame did not round-trip: %v", err)
	}
}

// prose is n bytes of text that deflates about as a note does.
func prose(n int) []byte {
	var buf bytes.Buffer
	for i := 0; buf.Len() < n; i++ {
		fmt.Fprintf(&buf, "Line %d of a note, with a [[link to %d]] and a #tag, then some words.\n", i, i%17)
	}
	return buf.Bytes()[:n]
}

// The pools hand a compressor and a decompressor from one body to the next,
// so nothing one body leaves behind may reach another: each frame decodes to
// exactly its own bytes whatever was framed before it on the same goroutine,
// after a frame the decoder refused, and on many goroutines at once, which
// -race watches.
func TestPooledFramingKeepsEveryBodyItsOwn(t *testing.T) {
	bodies := [][]byte{
		prose(1 << 10), sha256CTR("pool", 16<<10), prose(64 << 10), []byte("x"),
		make([]byte, 4096), sha256CTR("pool, again", 300<<10), prose(3000),
	}
	check := func(raw []byte) {
		framed := Encode(raw)
		if len(framed) > len(raw)+1 {
			t.Errorf("a %d-byte body framed to %d bytes", len(raw), len(framed))
		}
		out, err := Decode(framed, 1<<20)
		if err != nil || !bytes.Equal(out, raw) {
			t.Errorf("a %d-byte body did not come back as itself: %v", len(raw), err)
		}
	}
	for round := 0; round < 3; round++ {
		for _, raw := range bodies {
			check(raw)
		}
	}
	if _, err := Decode([]byte{MarkerDeflate, 0xff, 0xff, 0xff}, 1<<20); err == nil {
		t.Fatal("a broken deflate stream decoded")
	}
	check(prose(2048))

	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 40; i++ {
				check(bodies[(g+i)%len(bodies)])
			}
		}(g)
	}
	wg.Wait()
}

// A body read with a spare byte in front frames as Encode frames it, and a
// raw frame of it is the buffer it was read into, not a copy. The spare byte is
// never written: a buffer whose first byte is not the raw marker is framed by
// copying instead, and left as it was.
func TestEncodeWithHeadroomFramesInPlace(t *testing.T) {
	for _, raw := range [][]byte{prose(1 << 10), sha256CTR("headroom", 300<<10), []byte("x")} {
		buf := append([]byte{MarkerRaw}, raw...)
		framed := EncodeWithHeadroom(buf)
		if want := Encode(raw); !bytes.Equal(framed, want) {
			t.Errorf("a %d-byte body framed differently with headroom than without", len(raw))
		}
		if framed[0] == MarkerRaw && &framed[0] != &buf[0] {
			t.Errorf("a %d-byte raw frame was copied rather than framed in place", len(raw))
		}
		if out, err := Decode(framed, 1<<20); err != nil || !bytes.Equal(out, raw) {
			t.Errorf("a %d-byte body did not come back as itself: %v", len(raw), err)
		}
	}
	noise := sha256CTR("not zero", 64<<10)
	buf := append([]byte{7}, noise...)
	framed := EncodeWithHeadroom(buf)
	if buf[0] != 7 || &framed[0] == &buf[0] || !bytes.Equal(framed[1:], noise) || framed[0] != MarkerRaw {
		t.Fatal("a buffer whose spare byte was not the raw marker was written to or sent as it was")
	}
}

// What framing a body costs, which is what the pools are for.
//
//	go test ./internal/frame -run '^$' -bench . -benchmem
func BenchmarkEncode(b *testing.B) {
	for _, c := range []struct {
		name string
		raw  []byte
	}{
		{"text-1KiB", prose(1 << 10)},
		{"text-64KiB", prose(64 << 10)},
		{"incompressible-256KiB", sha256CTR("bench", 256<<10)},
	} {
		b.Run(c.name, func(b *testing.B) {
			b.SetBytes(int64(len(c.raw)))
			b.ReportAllocs()
			for b.Loop() {
				Encode(c.raw)
			}
		})
	}
}

func BenchmarkDecode(b *testing.B) {
	raw := prose(1 << 10)
	framed := Encode(raw)
	b.SetBytes(int64(len(raw)))
	b.ReportAllocs()
	for b.Loop() {
		if _, err := Decode(framed, 1<<20); err != nil {
			b.Fatal(err)
		}
	}
}

// A corrupted vector must fail on the consuming side (PLAN.md M0.5).
func TestACorruptedVectorIsCaught(t *testing.T) {
	f := load(t)
	g := f.Frames.Good[0]
	damaged := unhex(t, g.Frame)
	damaged[len(damaged)-1] ^= 0xff
	if raw, err := Decode(damaged, f.Frames.ChunkMax); err == nil && name(raw) == g.Name {
		t.Error("a damaged frame still decoded to the chunk its name promises")
	}
}
