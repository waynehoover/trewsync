// chunk.go is a port of client/src/core/chunk.ts. chunk-fixtures.json at the
// repository root pins the two together, and each language checks the cut
// points the other one produced. The package documentation, in doc.go, says
// why a server chunk boundary must fall exactly where a device's does.

package notes

import (
	"math"
	"strings"

	"github.com/waynehoover/trew/internal/paths"
)

// Window is the rolling hash window in bytes: how much of the preceding content
// decides whether a chunk ends. chunk.ts WINDOW, which is LiveSync's 48. It is
// not a tunable: changing it moves every boundary in every vault.
const Window = 48

// prime is the rolling hash multiplier. chunk.ts PRIME.
const prime = 31

// boundaryResidue is the hash residue that ends a chunk. chunk.ts BOUNDARY,
// whose comment records why this value was kept with a power-of-two average:
// measured, the poor low-bit mixing of 31 = 32 - 1 costs 3.7% more chunks, and
// diverging from the reference implementation was judged worth more than that.
const boundaryResidue = 1

// ChunkSizes bounds the chunks ChunkBytes cuts. chunk.ts ChunkSizes.
type ChunkSizes struct {
	// Min is the length below which the rolling hash is not consulted. A chunk
	// can still be shorter: the last one is whatever remains, and a cut that
	// backs off an incomplete UTF-8 character gives up to three bytes.
	Min int
	// Avg sets how often the hash ends a chunk: past Min, each position does
	// so with probability 1/Avg.
	Avg int
	// Max is the longest chunk. One that reaches it is cut there whatever the
	// hash says.
	Max int
}

// The size tables as constants, so that textAvgMin can be one of them.
const (
	textMin = 512
	textAvg = 1024
	textMax = 4096

	binaryMin = 128 << 10
	binaryAvg = 256 << 10
	binaryMax = 1 << 20
)

// TextSizes are the base sizes for text, 512 B / 1 KiB / 4 KiB. chunk.ts
// TEXT_SIZES, where the measurement they come from is recorded.
var TextSizes = ChunkSizes{Min: textMin, Avg: textAvg, Max: textMax}

// BinarySizes are the sizes for attachments, 128 KiB / 256 KiB / 1 MiB.
// chunk.ts BINARY_SIZES. Max is the server's chunkMax (store.ChunkMax), and
// under protocol 1 a raw chunk may be exactly that long.
var BinarySizes = ChunkSizes{Min: binaryMin, Avg: binaryAvg, Max: binaryMax}

// TextAsBinaryAbove is the file size from which a text file is chunked with
// BinarySizes: chunk.ts TEXT_AS_BINARY_ABOVE, LiveSync's 4 MiB. Text sizes
// apply strictly below it, so a text file of exactly 4 MiB is chunked as
// binary.
const TextAsBinaryAbove = 4 << 20

// nameBytes is what one chunk name costs on the wire, 64 hex characters: the
// per-chunk overhead TextSizesFor trades against. chunk.ts NAME_BYTES.
const nameBytes = 64

// textAvgMin and textAvgMax are the band TextSizesFor keeps the average in.
// chunk.ts TEXT_AVG_MIN and TEXT_AVG_MAX.
//
// The upper one cannot bind through SizesFor. Text sizes apply only below
// TextAsBinaryAbove, where the ideal average is at most 16 KiB, so only a
// direct call with a larger size ever meets it.
const (
	textAvgMin = textAvg
	textAvgMax = 64 << 10
)

// TextSizesFor scales text chunk sizes to the file. chunk.ts textSizesFor.
//
// A put carries every chunk name of the file, so an edit costs about one chunk
// body plus nameBytes for each chunk the file has, which is least when the
// average is sqrt(nameBytes * size). The average is rounded to a multiple of
// 512 and kept between 1 KiB and 64 KiB; Min is half of it but never below
// TextSizes.Min, and Max is four times it.
//
// The arithmetic is float64, as it is in TypeScript. math.Round rounds half
// away from zero and Math.round rounds half up, which is the same rule for the
// positive quotient here, and it is not hypothetical: at a size of 50176 the
// quotient is exactly 3.5, and both take 4.
func TextSizesFor(size int64) ChunkSizes {
	ideal := math.Sqrt(nameBytes * float64(max(size, 1)))
	avg := int(math.Min(textAvgMax, math.Max(textAvgMin, math.Round(ideal/512)*512)))
	return ChunkSizes{Min: max(textMin, avg/2), Avg: avg, Max: avg * 4}
}

// SizesFor chooses chunk sizes for a file, clamped to the ceiling a server
// advertises as chunkMax. chunk.ts sizesFor, under the protocol 1 rule.
//
// The rule differs from chunk.ts in one place, deliberately. chunk.ts subtracts
// SEAL_OVERHEAD from the ceiling, because Basalt's ceiling is on the sealed
// chunk. Protocol 1 has no sealing: chunkMax bounds the raw bytes, and a body
// frame's marker byte sits on top of it (plan/protocol.md, "Chunk bodies"), so
// Max is simply the smaller of the size table's own maximum and serverChunkMax.
// The TypeScript client adopts this rule when it drops encryption (PLAN M2 task
// 2); until then the sizesForV1 cases in chunk-fixtures.json are the contract.
//
// A serverChunkMax of zero or less means the server has not said, and stands
// for BinarySizes.Max, as a missing or nonsensical value does in chunk.ts. Max
// is then raised to at least Window*4, however small the ceiling: below a
// window's worth every cut would be a forced one and the rolling hash
// pointless. Min and Avg are clamped to Max.
//
// That raise is the one place the result can exceed the ceiling. A server
// advertising less than 192 gets chunks longer than it accepts, which is
// exactly the refused put the ceiling exists to prevent. chunk.ts does the
// same, and cutting where it cuts matters more here than second-guessing an
// absurd ceiling; this server's own is store.ChunkMax, 1 MiB.
func SizesFor(size int64, isText bool, serverChunkMax int64) ChunkSizes {
	if serverChunkMax <= 0 {
		serverChunkMax = binaryMax
	}
	// From the constants rather than BinarySizes, which is a variable and so
	// something a caller could assign to.
	base := ChunkSizes{Min: binaryMin, Avg: binaryAvg, Max: binaryMax}
	if isText && size < TextAsBinaryAbove {
		base = TextSizesFor(size)
	}
	// Protocol 1: the ceiling is on raw bytes, so nothing is reserved below it.
	ceiling := int(min(int64(base.Max), serverChunkMax))
	ceiling = max(ceiling, Window*4)
	return ChunkSizes{
		Min: min(base.Min, ceiling),
		Avg: min(base.Avg, ceiling),
		Max: ceiling,
	}
}

// atBoundary reports whether the rolling hash ends a chunk. chunk.ts
// atBoundary.
//
// chunk.ts writes `(hash >>> 0) % avg === BOUNDARY` in floating point, as
// Math.floor(u / avg) * avg === u - BOUNDARY, to avoid a slow modulo on V8. For
// a 32-bit u and any integer avg of at least 1 that is exactly the remainder:
// the double quotient is never rounded up to the next integer, because its
// rounding error is under 2^-21 / avg while a non-zero remainder keeps the true
// quotient at least 1/avg below it. For avg of zero or less the TypeScript form
// is never true, and Go's remainder would panic or answer something else, so
// that case is spelled out rather than divided.
func atBoundary(hash uint32, avg int) bool {
	if avg <= 0 {
		return false
	}
	return uint64(hash)%uint64(avg) == boundaryResidue
}

// trimIncompleteCharacter moves a cut back off an incomplete UTF-8 character.
// chunk.ts trimIncompleteCharacter.
//
// It asks whether data[start:end] ends part way through a sequence, which the
// trailing bytes alone decide, and if so returns the offset of that sequence's
// lead byte. Backing off rather than extending keeps the chunk within Max,
// which is the server's chunkMax.
//
// Malformed input is classified exactly as chunk.ts classifies it, because a
// file named .md can hold any bytes at all. A lead byte 0xC0 to 0xDF expects
// two bytes, 0xE0 to 0xEF three, and 0xF0 to 0xF7 four, including 0xF5 to 0xF7
// though no valid sequence starts there. Anything else expects one: ASCII, 0xF8
// to 0xFF, and a continuation byte with no lead before it in the chunk, which is
// how a run of continuation bytes is never trimmed.
//
// It returns end unchanged when backing off would empty the chunk, which only a
// maximum shorter than one character can cause.
func trimIncompleteCharacter(data []byte, start, end int) int {
	// Find the lead byte of the last sequence.
	lead := end - 1
	for lead > start && data[lead]&0xc0 == 0x80 {
		lead--
	}
	if lead < start {
		// Only when end <= start, which ChunkBytes never passes. Kept so this
		// answers what the TypeScript does for every input.
		return end
	}

	var expected int
	switch b := data[lead]; {
	case b < 0x80:
		expected = 1
	case b&0xe0 == 0xc0:
		expected = 2
	case b&0xf0 == 0xe0:
		expected = 3
	case b&0xf8 == 0xf0:
		expected = 4
	default:
		expected = 1
	}
	if end-lead >= expected {
		return end // complete, nothing to do
	}
	if lead > start {
		return lead
	}
	return end
}

// Chunk is one chunk of a file: where it starts, and its bytes. chunk.ts Chunk.
type Chunk struct {
	// Offset is where Bytes starts in the input.
	Offset int
	// Bytes aliases the input rather than copying it. Its capacity ends where
	// the chunk does, so appending to it cannot overwrite the next chunk.
	Bytes []byte
}

// ChunkBytes splits data into content-defined chunks. chunk.ts chunkBytes, the
// in-memory splitter, with the same cut points to the byte.
//
// A chunk ends where a Rabin-Karp hash of its last Window bytes (all of them,
// while it is shorter than that) leaves boundaryResidue modulo sizes.Avg, once
// it holds at least sizes.Min bytes, or at sizes.Max whatever the hash says.
// With isUTF8 set, a cut that would end part way through a UTF-8 sequence backs
// off to the start of that sequence, and the bytes backed over open the next
// chunk. The last chunk is whatever remains and is never trimmed: there is no
// next character to protect.
//
// This is the in-memory splitter, and the streaming one in chunk.ts,
// chunkStream, does not quite agree with it: after a trim it rehashes the
// carried bytes without testing them for a boundary, which chunkBytes does, so
// the two part ways when sizes.Min is under four. SizesFor never goes below
// 192, where they agree; the fixtures pin this function's behaviour for the
// small minimums too.
//
// Empty input yields no chunks, because a file has chunks if and only if it has
// content. The chunks alias data.
//
// Every detail below is the TypeScript loop's, including the ones that look
// incidental: the hash restarts from zero at each cut, the first Window bytes of
// a chunk are hashed without rolling, and a trimmed cut rewinds so the bytes it
// gave back are hashed again as the next chunk's first. Any difference moves a
// boundary, and a moved boundary renames a chunk.
func ChunkBytes(data []byte, sizes ChunkSizes, isUTF8 bool) []Chunk {
	var chunks []Chunk

	// PRIME^(WINDOW-1), for taking out the byte leaving the window. uint32
	// arithmetic wraps modulo 2^32, which is what Math.imul and `| 0` do in
	// chunk.ts. The bits are the same and only the sign convention differs,
	// and atBoundary reads them unsigned, as `hash >>> 0` does.
	pPowW := uint32(1)
	for range Window - 1 {
		pPowW *= prime
	}

	start := 0
	var hash uint32
	for pos := 0; pos < len(data); pos++ {
		b := uint32(data[pos])
		if pos >= start+Window {
			// Roll: drop the byte that has left the window, take in the new one.
			hash -= uint32(data[pos-Window]) * pPowW
			hash = hash*prime + b
		} else {
			// Still filling the first window of this chunk.
			hash = hash*prime + b
		}

		size := pos - start + 1
		boundary := size >= sizes.Min && atBoundary(hash, sizes.Avg)
		// A forced cut at the maximum. Without it a file with no boundary in
		// it is one chunk however large, which the server would refuse.
		if size >= sizes.Max {
			boundary = true
		}
		if !boundary {
			continue
		}

		end := pos + 1
		if isUTF8 {
			end = trimIncompleteCharacter(data, start, end)
		}
		chunks = append(chunks, Chunk{Offset: start, Bytes: data[start:end:end]})
		start = end
		hash = 0
		// The bytes backed over have not been hashed into the new chunk, so
		// rewind to read them again. end > start always holds, so this makes
		// progress.
		pos = end - 1
	}

	if start < len(data) {
		chunks = append(chunks, Chunk{Offset: start, Bytes: data[start:len(data):len(data)]})
	}
	return chunks
}

// textExtensions are the extensions IsTextPath treats as text. The list lives
// once, in internal/paths (TextExtensions, pinned by protocol-fixtures.json),
// and chunk-fixtures.json lists it again, so a change on one side only fails a
// test. Built from that list rather than written out here, so there is no
// second copy to drift.
var textExtensions = func() map[string]bool {
	m := make(map[string]bool, len(paths.TextExtensions))
	for _, e := range paths.TextExtensions {
		m[e] = true
	}
	return m
}()

// IsTextPath guesses whether a path holds text, for choosing chunk sizes and
// whether cuts keep UTF-8 characters whole. chunk.ts looksLikeText.
//
// Getting it wrong costs efficiency and never correctness, because both kinds
// of chunking reassemble byte for byte; getting it different from the client
// costs deduplication, so it follows chunk.ts exactly. The extension is
// everything after the last dot anywhere in the path, so "a.md/b" has the
// extension "md/b" and is not text, while "notes/.md" is.
//
// The extension is lowercased in ASCII only. chunk.ts calls toLowerCase, and
// strings.ToLower looks like the same thing and is not: it maps U+0130, a
// capital I with a dot, to a plain "i", so "refs.B" + U+0130 + "B" would be
// text here, while toLowerCase gives an "i" plus a combining dot and does not
// match. Every listed extension is ASCII, and the only other character
// toLowerCase turns into a lone ASCII letter is U+212A KELVIN SIGN, which
// becomes "k". No listed extension has a k in it, so for today's list the two
// give the same answer on every path. Add one with a k and this needs
// revisiting.
func IsTextPath(path string) bool {
	dot := strings.LastIndexByte(path, '.')
	if dot < 0 {
		return false
	}
	return textExtensions[asciiLower(path[dot+1:])]
}

// asciiLower maps A to Z to a to z and leaves every other byte alone.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}
