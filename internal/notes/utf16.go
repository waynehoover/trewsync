package notes

import (
	"unicode/utf8"
)

// The helpers in this file translate between Go's UTF-8 strings and the UTF-16
// code units JavaScript counts in. Every string they are given is valid UTF-8:
// note text is decoded fatally before anything here sees it.

// runeUnits is how many UTF-16 code units r occupies.
func runeUnits(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

// units is the length of s as JavaScript measures it.
func units(s string) int {
	n := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			n++
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		n += runeUnits(r)
		i += size
	}
	return n
}

// clipUnits is Basalt's clip(): the first max code units of s, less a high
// surrogate the cut would leave unpaired. An astral character straddling the
// limit is dropped whole, so the result is always valid UTF-8.
func clipUnits(s string, max int) string {
	n := 0
	for i, r := range s {
		w := runeUnits(r)
		if n+w > max {
			return s[:i]
		}
		n += w
	}
	return s
}

// byteAtUnit is the byte offset in s of UTF-16 offset u, moved forward to the
// next character boundary when u falls between the two halves of a surrogate
// pair. That forward move is what mcp-read.ts does when a search excerpt would
// otherwise begin with a lone low surrogate.
func byteAtUnit(s string, u int) int {
	n := 0
	for i, r := range s {
		if n >= u {
			return i
		}
		n += runeUnits(r)
	}
	return len(s)
}

// unitIndex converts byte offsets in one string to UTF-16 offsets without
// rescanning the string from its start for every conversion.
type unitIndex struct {
	s     string
	marks []unitMark // the first rune boundary at or after each unitBlock bytes
}

type unitMark struct{ b, u int }

const unitBlock = 256

func newUnitIndex(s string) *unitIndex {
	x := &unitIndex{s: s, marks: make([]unitMark, 0, len(s)/unitBlock+2)}
	n, next := 0, 0
	for i := 0; i < len(s); {
		for next <= i {
			x.marks = append(x.marks, unitMark{i, n})
			next += unitBlock
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		n += runeUnits(r)
		i += size
	}
	x.marks = append(x.marks, unitMark{len(s), n})
	return x
}

// at is the UTF-16 offset of byte offset b, which must be a character
// boundary or len(s).
func (x *unitIndex) at(b int) int {
	k := b / unitBlock
	if k >= len(x.marks) {
		k = len(x.marks) - 1
	}
	for k > 0 && x.marks[k].b > b {
		k--
	}
	m := x.marks[k]
	return m.u + units(x.s[m.b:b])
}
