package notes

import (
	"bytes"
	"fmt"
	"math"
	"strings"
	"testing"
	"unicode/utf8"
)

// prose is deterministic prose-like ASCII, so that failures reproduce: the
// same generator chunk.test.ts uses, a pronounceable nonsense word at a time.
func prose(n int, seed uint32) []byte {
	s := seed
	rnd := func() uint32 {
		s = (s*1103515245 + 12345) & 0x7fffffff
		return s
	}
	var b strings.Builder
	words := 0
	for b.Len() < n {
		for range 3 + rnd()%8 {
			b.WriteByte(byte('a' + rnd()%26))
		}
		words++
		switch {
		case words%13 == 0:
			b.WriteString(".\n")
		case words%41 == 0:
			b.WriteString("\n\n## Heading\n\n")
		default:
			b.WriteByte(' ')
		}
	}
	return []byte(b.String()[:n])
}

// multilingual is text dense in two-, three- and four-byte characters.
func multilingual(repeats int) []byte {
	var b strings.Builder
	for i := range repeats {
		fmt.Fprintf(&b, "日本語のノート🗿 %d ünïcödé 𝄞 ", i)
	}
	return []byte(b.String())
}

// checkCovers fails unless chunks are data, in order, with nothing empty and
// nothing missing.
func checkCovers(t *testing.T, data []byte, chunks []Chunk) {
	t.Helper()
	at := 0
	for i, c := range chunks {
		if c.Offset != at {
			t.Fatalf("chunk %d starts at %d, not where the last ended (%d)", i, c.Offset, at)
		}
		if len(c.Bytes) == 0 {
			t.Fatalf("chunk %d at %d is empty", i, c.Offset)
		}
		if !bytes.Equal(c.Bytes, data[c.Offset:c.Offset+len(c.Bytes)]) {
			t.Fatalf("chunk %d does not hold the bytes it claims to", i)
		}
		at += len(c.Bytes)
	}
	if at != len(data) {
		t.Fatalf("the chunks cover %d of %d bytes", at, len(data))
	}
}

// The numbers chunk.ts states, hard-coded here rather than read from anywhere,
// because the point is to notice when either side's copy moves. Every one of
// them decides where every chunk in every vault ends.
func TestTheConstantsAreChunkTSs(t *testing.T) {
	if Window != 48 {
		t.Errorf("Window = %d, chunk.ts WINDOW is 48", Window)
	}
	if TextSizes != (ChunkSizes{Min: 512, Avg: 1024, Max: 4096}) {
		t.Errorf("TextSizes = %+v, chunk.ts TEXT_SIZES is 512 / 1024 / 4096", TextSizes)
	}
	if BinarySizes != (ChunkSizes{Min: 128 << 10, Avg: 256 << 10, Max: 1 << 20}) {
		t.Errorf("BinarySizes = %+v, chunk.ts BINARY_SIZES is 128 KiB / 256 KiB / 1 MiB", BinarySizes)
	}
	// The server's chunkMax, store.ChunkMax, hard-coded for the same reason
	// chunk.test.ts hard-codes it: the binary maximum must fit under it
	// without relying on a clamp.
	if BinarySizes.Max > 1<<20 {
		t.Errorf("BinarySizes.Max = %d is over the server's 1 MiB chunkMax", BinarySizes.Max)
	}
	if TextAsBinaryAbove != 4<<20 {
		t.Errorf("TextAsBinaryAbove = %d, chunk.ts TEXT_AS_BINARY_ABOVE is 4 MiB", TextAsBinaryAbove)
	}
	if prime != 31 || boundaryResidue != 1 || nameBytes != 64 {
		t.Errorf("prime %d, residue %d, name bytes %d: chunk.ts has 31, 1 and 64", prime, boundaryResidue, nameBytes)
	}
	if textAvgMin != TextSizes.Avg || textAvgMax != 64<<10 {
		t.Errorf("the text average band is %d to %d, chunk.ts has TEXT_SIZES.avg to 64 KiB", textAvgMin, textAvgMax)
	}
}

func TestTextSizesFor(t *testing.T) {
	floor := ChunkSizes{Min: 512, Avg: 1024, Max: 4096}
	for _, c := range []struct {
		why  string
		size int64
		want ChunkSizes
	}{
		// The three chunk-sizes.test.ts pins.
		{"a 4 KiB note: sqrt(64 * 4096) is 512, under the floor", 4096, floor},
		{"a 64 KiB note: sqrt(64 * 65536) is 2048", 65536, ChunkSizes{Min: 1024, Avg: 2048, Max: 8192}},
		{"a one-byte note", 1, floor},
		// Sizes below one are treated as one, as Math.max(size, 1) does.
		{"an empty note", 0, floor},
		{"a negative size", -5, floor},
		// Math.round rounds half up. math.Round rounds half away from zero,
		// which is the same rule for positive numbers; these are the sizes
		// where the quotient is exactly a half and the two would part if it
		// were not.
		{"quotient exactly 2.5", 25600, ChunkSizes{Min: 768, Avg: 1536, Max: 6144}},
		{"quotient just under 3.5", 50175, ChunkSizes{Min: 768, Avg: 1536, Max: 6144}},
		{"quotient exactly 3.5", 50176, ChunkSizes{Min: 1024, Avg: 2048, Max: 8192}},
		// The largest text sizes SizesFor can ask for.
		{"a note one byte under the binary threshold", TextAsBinaryAbove - 1, ChunkSizes{Min: 8192, Avg: 16384, Max: 65536}},
		// The ceiling on the average, reachable only by asking directly.
		{"a gigabyte", 1 << 30, ChunkSizes{Min: 32768, Avg: 65536, Max: 262144}},
		{"the largest size there is", math.MaxInt64, ChunkSizes{Min: 32768, Avg: 65536, Max: 262144}},
	} {
		if got := TextSizesFor(c.size); got != c.want {
			t.Errorf("%s: TextSizesFor(%d) = %+v, want %+v", c.why, c.size, got, c.want)
		}
	}
}

// The protocol 1 rule, unit by unit. chunk-fixtures.json carries the same rule
// as the sizesForV1 table, which TestSizesForV1Fixtures checks and which the
// TypeScript side adopts in M2 task 2; these are the cases worth naming here.
func TestSizesForProtocolOne(t *testing.T) {
	const big = 10 << 20

	t.Run("nothing is reserved below the ceiling", func(t *testing.T) {
		// chunk.ts subtracts SEAL_OVERHEAD, 29 bytes, and gets 1048547 here.
		// Protocol 1 ceilings raw bytes, so the whole MiB is usable.
		if got := SizesFor(big, false, 1<<20); got != BinarySizes {
			t.Fatalf("SizesFor(10 MiB, binary, 1 MiB) = %+v, want %+v", got, BinarySizes)
		}
	})

	t.Run("a raw chunk may be exactly chunkMax long", func(t *testing.T) {
		for _, ceiling := range []int64{193, 4096, 65536, 200000, 262144, 1 << 20} {
			if got := SizesFor(big, false, ceiling).Max; int64(got) != ceiling {
				t.Errorf("under a ceiling of %d the maximum is %d", ceiling, got)
			}
		}
		if got := SizesFor(1000, true, 4096).Max; got != 4096 {
			t.Errorf("a text ceiling at the table's own maximum gives %d, want 4096", got)
		}
		if got := SizesFor(1000, true, 4095).Max; got != 4095 {
			t.Errorf("a text ceiling one under the table's maximum gives %d, want 4095", got)
		}
	})

	t.Run("a ceiling above the table's maximum is not reached for", func(t *testing.T) {
		if got := SizesFor(big, false, 64<<20); got != BinarySizes {
			t.Errorf("SizesFor(10 MiB, binary, 64 MiB) = %+v, want %+v", got, BinarySizes)
		}
		if got := SizesFor(1000, true, 64<<20); got != TextSizes {
			t.Errorf("SizesFor(1000, text, 64 MiB) = %+v, want %+v", got, TextSizes)
		}
	})

	t.Run("no ceiling means the server has not said", func(t *testing.T) {
		for _, ceiling := range []int64{0, -1, math.MinInt64} {
			if got := SizesFor(big, false, ceiling); got != BinarySizes {
				t.Errorf("SizesFor(10 MiB, binary, %d) = %+v, want %+v", ceiling, got, BinarySizes)
			}
			if got := SizesFor(1000, true, ceiling); got != TextSizes {
				t.Errorf("SizesFor(1000, text, %d) = %+v, want %+v", ceiling, got, TextSizes)
			}
		}
	})

	t.Run("a ceiling under a window's worth is raised to 192", func(t *testing.T) {
		clamped := ChunkSizes{Min: 192, Avg: 192, Max: 192}
		for _, ceiling := range []int64{1, 8, 191, 192} {
			for _, isText := range []bool{true, false} {
				if got := SizesFor(big, isText, ceiling); got != clamped {
					t.Errorf("SizesFor(10 MiB, text %v, %d) = %+v, want %+v", isText, ceiling, got, clamped)
				}
			}
		}
		if got := SizesFor(big, false, 193); got != (ChunkSizes{Min: 193, Avg: 193, Max: 193}) {
			t.Errorf("a ceiling of 193 gives %+v, want it honoured", got)
		}
	})

	t.Run("minimum and average are clamped to the maximum", func(t *testing.T) {
		if got := SizesFor(big, false, 200000); got != (ChunkSizes{Min: 131072, Avg: 200000, Max: 200000}) {
			t.Errorf("under 200000: %+v", got)
		}
		if got := SizesFor(big, false, 65536); got != (ChunkSizes{Min: 65536, Avg: 65536, Max: 65536}) {
			t.Errorf("under 64 KiB: %+v", got)
		}
		// Scaled text keeps its own minimum and average when only the
		// maximum is over the ceiling.
		if got := SizesFor(3<<20, true, 32768); got != (ChunkSizes{Min: 7168, Avg: 14336, Max: 32768}) {
			t.Errorf("3 MiB of text under 32 KiB: %+v", got)
		}
	})

	t.Run("text sizes stop at the binary threshold", func(t *testing.T) {
		if got, want := SizesFor(TextAsBinaryAbove-1, true, 1<<20), TextSizesFor(TextAsBinaryAbove-1); got != want {
			t.Errorf("one byte under the threshold: %+v, want text sizes %+v", got, want)
		}
		if got := SizesFor(TextAsBinaryAbove, true, 1<<20); got != BinarySizes {
			t.Errorf("at the threshold: %+v, want binary sizes", got)
		}
		if got := SizesFor(1000, false, 1<<20); got != BinarySizes {
			t.Errorf("a small file that is not text: %+v, want binary sizes", got)
		}
	})
}

// Whatever it is asked, SizesFor answers inside the ceiling, in order, and
// inside the range chunk.ts's boundary arithmetic is proven for.
func TestSizesForStaysInsideItsBounds(t *testing.T) {
	sizes := []int64{-1, 0, 1, 1000, 4095, 4096, 25600, 50175, 50176, 1 << 20, TextAsBinaryAbove - 1, TextAsBinaryAbove, 1 << 30}
	ceilings := []int64{math.MinInt64, -1, 0, 1, 191, 192, 193, 4095, 4096, 65536, 200000, 1 << 20, 1 << 26, math.MaxInt64}
	for _, size := range sizes {
		for _, ceiling := range ceilings {
			for _, isText := range []bool{true, false} {
				got := SizesFor(size, isText, ceiling)
				effective := ceiling
				if effective <= 0 {
					effective = 1 << 20
				}
				where := fmt.Sprintf("SizesFor(%d, %v, %d) = %+v", size, isText, ceiling, got)
				if got.Min < 1 || got.Min > got.Avg || got.Avg > got.Max {
					t.Errorf("%s: not 1 <= min <= avg <= max", where)
				}
				if int64(got.Max) > max(effective, Window*4) || got.Max < Window*4 {
					t.Errorf("%s: max outside [%d, ceiling]", where, Window*4)
				}
				// chunk.ts proves its division-free boundary test for avg up
				// to 2^18, and atBoundary's comment leans on that proof.
				if got.Avg > 1<<18 {
					t.Errorf("%s: avg over 2^18", where)
				}
			}
		}
	}
}

func TestChunkBytesReassembles(t *testing.T) {
	random := make([]byte, 200_000)
	for i := range random {
		random[i] = byte((uint32(i) * 2654435761) >> 24)
	}
	inputs := map[string][]byte{"multilingual text": multilingual(400), "incompressible bytes": random}
	for _, n := range []int{0, 1, 47, 48, 49, 127, 128, 1000, 10_000, 100_000} {
		inputs[fmt.Sprintf("%d bytes of prose", n)] = prose(n, 1)
	}
	for name, data := range inputs {
		for _, sizes := range []ChunkSizes{TextSizes, {Min: 61, Avg: 97, Max: 131}, {Min: 1, Avg: 2, Max: 7}, {Min: 1024, Avg: 4096, Max: 16384}} {
			for _, isUTF8 := range []bool{true, false} {
				t.Run(fmt.Sprintf("%s at %+v utf8 %v", name, sizes, isUTF8), func(t *testing.T) {
					chunks := ChunkBytes(data, sizes, isUTF8)
					checkCovers(t, data, chunks)
					for i, c := range chunks {
						if len(c.Bytes) > sizes.Max {
							t.Fatalf("chunk %d is %d bytes, over the maximum of %d", i, len(c.Bytes), sizes.Max)
						}
					}
				})
			}
		}
	}
}

func TestChunkBytesCutsNothingFromNothing(t *testing.T) {
	// Not one empty chunk: the protocol says a file has chunks if and only if
	// it has content.
	if got := ChunkBytes(nil, TextSizes, true); len(got) != 0 {
		t.Fatalf("nil input gave %d chunks", len(got))
	}
	if got := ChunkBytes([]byte{}, BinarySizes, false); len(got) != 0 {
		t.Fatalf("empty input gave %d chunks", len(got))
	}
}

func TestChunkBytesKeepsChunksBetweenMinAndMax(t *testing.T) {
	// ASCII cannot be trimmed, so every chunk but the last was cut on purpose
	// and is at least Min.
	data := prose(200_000, 1)
	chunks := ChunkBytes(data, TextSizes, true)
	for i, c := range chunks {
		if len(c.Bytes) > TextSizes.Max {
			t.Errorf("chunk %d is %d bytes, over the maximum", i, len(c.Bytes))
		}
		if i < len(chunks)-1 && len(c.Bytes) < TextSizes.Min {
			t.Errorf("chunk %d is %d bytes, under the minimum", i, len(c.Bytes))
		}
	}
	// Rule 8: the figure is the evidence. A mean far from the target means
	// the boundary test is not firing as designed.
	if mean := len(data) / len(chunks); mean < TextSizes.Min || mean > TextSizes.Max {
		t.Errorf("the mean chunk is %d bytes, outside %d to %d", mean, TextSizes.Min, TextSizes.Max)
	}

	// A cut that backs off a character gives up at most three bytes, so with
	// trimming a deliberate cut can come in just under Min. Not a bug, and not
	// reachable from SizesFor's point of view either, but worth pinning:
	// "every chunk is at least Min" is not a promise ChunkBytes makes.
	text := multilingual(3000)
	sizes := ChunkSizes{Min: 64, Avg: 128, Max: 512}
	chunks = ChunkBytes(text, sizes, true)
	for i, c := range chunks[:len(chunks)-1] {
		if len(c.Bytes) < sizes.Min-3 {
			t.Errorf("chunk %d is %d bytes, more than three under the minimum", i, len(c.Bytes))
		}
	}
}

func TestChunkBytesCutsAtMaxWhenTheContentOffersNothing(t *testing.T) {
	// A repeated byte gives the rolling hash nothing to vary: without a forced
	// cut this would be one 100 KB chunk, which the server would refuse.
	data := bytes.Repeat([]byte{'A'}, 100_000)
	chunks := ChunkBytes(data, TextSizes, true)
	checkCovers(t, data, chunks)
	for i, c := range chunks[:len(chunks)-1] {
		if len(c.Bytes) != TextSizes.Max {
			t.Fatalf("chunk %d is %d bytes, want every one forced at %d", i, len(c.Bytes), TextSizes.Max)
		}
	}
}

func TestChunkBytesKeepsCharactersWhole(t *testing.T) {
	data := multilingual(4000)
	for _, sizes := range []ChunkSizes{{Min: 64, Avg: 128, Max: 512}, {Min: 61, Avg: 97, Max: 131}, {Min: 192, Avg: 192, Max: 192}} {
		chunks := ChunkBytes(data, sizes, true)
		checkCovers(t, data, chunks)
		for i, c := range chunks {
			// Valid on its own is what makes a chunk something a person can
			// look at, and a minimum of at least four is what guarantees it:
			// a cut that must back off always has somewhere to back off to.
			if !utf8.Valid(c.Bytes) {
				t.Fatalf("at %+v chunk %d at %d is not valid UTF-8 on its own", sizes, i, c.Offset)
			}
			if len(c.Bytes) > sizes.Max {
				t.Fatalf("at %+v chunk %d is %d bytes, over the maximum", sizes, i, len(c.Bytes))
			}
		}
	}
}

// Whether a file is treated as text is decided by its name, so bytes that are
// not UTF-8 reach the UTF-8 path routinely, and backing off to the start of a
// chunk would rewind the loop to where it already was. chunk.test.ts has the
// same cases for the same reason: the consequence of getting it wrong is a
// server that hangs on a note.
func TestChunkBytesTerminatesOnMalformedUTF8(t *testing.T) {
	everyByte := make([]byte, 4096)
	for i := range everyByte {
		everyByte[i] = byte(i)
	}
	truncated := make([]byte, 2048)
	for i := range truncated {
		truncated[i] = 0x80
		if i%2 == 0 {
			truncated[i] = 0xf0
		}
	}
	for name, data := range map[string][]byte{
		"a run of continuation bytes":        bytes.Repeat([]byte{0x80}, 4096),
		"truncated sequences end to end":     truncated,
		"every byte value repeated":          everyByte,
		"a single continuation byte":         {0x80},
		"one lead byte and nothing after it": {0xf0},
	} {
		t.Run(name, func(t *testing.T) {
			checkCovers(t, data, ChunkBytes(data, ChunkSizes{Min: 8, Avg: 16, Max: 64}, true))
		})
	}
}

func TestChunkBytesChunksCannotOverwriteEachOther(t *testing.T) {
	data := prose(20_000, 3)
	want := bytes.Clone(data)
	chunks := ChunkBytes(data, TextSizes, true)
	if len(chunks) < 2 {
		t.Fatalf("only %d chunks", len(chunks))
	}
	_ = append(chunks[0].Bytes, "overwritten"...)
	if !bytes.Equal(data, want) {
		t.Fatal("appending to one chunk wrote over the next")
	}
}

func TestChunkBytesWithoutAPositiveAverageCutsOnlyAtMax(t *testing.T) {
	// chunk.ts's floating-point boundary test is never true for avg <= 0, so
	// there the only cuts are forced ones. Go's remainder would panic on zero.
	data := prose(10_000, 5)
	for _, avg := range []int{0, -1, -1024} {
		chunks := ChunkBytes(data, ChunkSizes{Min: 1, Avg: avg, Max: 100}, true)
		checkCovers(t, data, chunks)
		for i, c := range chunks[:len(chunks)-1] {
			if len(c.Bytes) != 100 {
				t.Fatalf("avg %d: chunk %d is %d bytes, want every cut forced at 100", avg, i, len(c.Bytes))
			}
		}
	}
}

func TestTrimIncompleteCharacter(t *testing.T) {
	for _, c := range []struct {
		why        string
		data       string
		start, end int
		want       int
	}{
		{"ASCII is always complete", "ab", 0, 2, 2},
		{"a complete two-byte character", "aé", 0, 3, 3},
		{"a complete four-byte character", "a🗿", 0, 5, 5},
		{"a two-byte lead with nothing after it", "a\xc3", 0, 2, 1},
		{"a three-byte character one short", "a\xe6\x97", 0, 3, 1},
		{"a four-byte character one short", "a\xf0\x9f\x97", 0, 4, 1},
		{"a four-byte character three short", "ab\xf0", 0, 3, 2},
		{"only an incomplete character: backing off would empty the chunk", "\xf0\x9f", 0, 2, 2},
		{"a run of continuation bytes has no lead to back off to", "\x80\x80\x80", 0, 3, 3},
		{"continuation bytes after a complete character are too many, not too few", "a\xe6\x97\xa5\x80", 0, 5, 5},
		{"0xF8 counts as a single byte", "a\xf8", 0, 2, 2},
		{"0xFF counts as a single byte", "a\xff", 0, 2, 2},
		{"0xF5 counts as a four-byte lead", "a\xf5\x80", 0, 3, 1},
		{"0xC0 counts as a two-byte lead", "a\xc0", 0, 2, 1},
		{"an encoded surrogate is a three-byte shape", "a\xed\xa0", 0, 3, 1},
		{"the lead at start cannot be backed off", "日本", 3, 5, 5},
		{"the lead after start can", "日本", 0, 5, 3},
	} {
		if got := trimIncompleteCharacter([]byte(c.data), c.start, c.end); got != c.want {
			t.Errorf("%s: trim(%q, %d, %d) = %d, want %d", c.why, c.data, c.start, c.end, got, c.want)
		}
	}
}

func TestIsTextPathLowercasesASCIIOnly(t *testing.T) {
	// The trap the comment on IsTextPath describes, sprung on purpose: with
	// Unicode lowercasing this path is text, and in the TypeScript client it
	// is not.
	path := "refs.B" + string(rune(0x130)) + "B"
	ext := path[strings.LastIndexByte(path, '.')+1:]
	if !textExtensions[strings.ToLower(ext)] {
		t.Fatalf("strings.ToLower(%q) = %q, no longer a listed extension, so this test proves nothing", ext, strings.ToLower(ext))
	}
	if IsTextPath(path) {
		t.Fatalf("IsTextPath(%q) is true; looksLikeText says false", path)
	}
	for _, p := range []string{"note.md", "Notes/A Note.MD", "a.Md", "folder/.md"} {
		if !IsTextPath(p) {
			t.Errorf("IsTextPath(%q) is false", p)
		}
	}
	for _, p := range []string{"photo.png", "no-extension", "folder.md/readme", "trailing.", ""} {
		if IsTextPath(p) {
			t.Errorf("IsTextPath(%q) is true", p)
		}
	}
}

// FuzzChunkBytes holds ChunkBytes to what it promises for any input and any
// sizes: it terminates, it covers the input exactly once in order, it never
// cuts an empty chunk or one over the maximum, and with a minimum and maximum
// of at least four it keeps valid UTF-8 valid chunk by chunk.
func FuzzChunkBytes(f *testing.F) {
	f.Add([]byte("hello, world"), uint16(4), uint16(8), uint16(16), true)
	f.Add(multilingual(20), uint16(8), uint16(16), uint16(64), true)
	f.Add([]byte{0xf0, 0x80, 0xf0, 0x80, 0xc3}, uint16(1), uint16(2), uint16(3), true)
	f.Add(bytes.Repeat([]byte{0x80}, 300), uint16(8), uint16(16), uint16(64), true)
	f.Add(prose(3000, 9), uint16(0), uint16(0), uint16(0), false)
	f.Fuzz(func(t *testing.T, data []byte, minSize, avg, maxSize uint16, isUTF8 bool) {
		sizes := ChunkSizes{Min: int(minSize), Avg: int(avg), Max: int(maxSize)}
		chunks := ChunkBytes(data, sizes, isUTF8)
		checkCovers(t, data, chunks)
		for i, c := range chunks {
			if len(c.Bytes) > max(sizes.Max, 1) {
				t.Fatalf("chunk %d is %d bytes, over the maximum of %d", i, len(c.Bytes), sizes.Max)
			}
			if isUTF8 && sizes.Min >= 4 && sizes.Max >= 4 && utf8.Valid(data) && !utf8.Valid(c.Bytes) {
				t.Fatalf("chunk %d of valid UTF-8 at %+v is not valid on its own", i, sizes)
			}
		}
	})
}
