package frame

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
