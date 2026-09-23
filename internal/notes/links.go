package notes

import (
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark/util"
)

// LinkSpan is one link a note makes to a path, as Basalt's changeLinks found
// it: a Markdown link, image or reference definition with a destination, or
// a wiki link or embed. Offsets are UTF-16 code units into the note.
type LinkSpan struct {
	// Start and End bound the destination as written: inside the angle
	// brackets of <...>, or the target of [[target#heading|alias]] before
	// any "|".
	Start, End int
	// WholeStart and WholeEnd bound the whole link, label and all.
	WholeStart, WholeEnd int
	// URL is the destination with its escapes and character references
	// decoded; for a wiki link it is the target as written.
	URL  string
	Wiki bool
	// FragmentAt is where the destination's "#" is, written literally, as
	// "\#" or as a character reference, or -1. Wiki links do not set it.
	FragmentAt int
}

// linkSpan is a LinkSpan in byte offsets.
type linkSpan struct {
	start, end           int
	wholeStart, wholeEnd int
	url                  string
	wiki                 bool
	fragmentAt           int
}

// LinkSpans is the reading half of Basalt's changeLinks: every link in the
// body, Markdown ones first in document order, then wiki links. Links inside
// code, inline code, HTML or %% comments are not links; a wiki link that is
// escaped, or that overlaps a Markdown link, is not either. A note whose
// frontmatter has no closing delimiter is invalid_frontmatter, as it was for
// changeLinks.
func LinkSpans(source string) ([]LinkSpan, error) {
	spans, err := linkSpans(source)
	if err != nil {
		return nil, err
	}
	x := newUnitIndex(source)
	out := make([]LinkSpan, len(spans))
	for i, s := range spans {
		out[i] = LinkSpan{
			Start: x.at(s.start), End: x.at(s.end),
			WholeStart: x.at(s.wholeStart), WholeEnd: x.at(s.wholeEnd),
			URL: s.url, Wiki: s.wiki, FragmentAt: -1,
		}
		if s.fragmentAt >= 0 {
			out[i].FragmentAt = x.at(s.fragmentAt)
		}
	}
	return out, nil
}

func linkSpans(source string) ([]linkSpan, error) {
	f, err := findFrame(source)
	if err != nil {
		return nil, err
	}
	body := f.body
	hidden, err := markdownHidden(source, body, false)
	if err != nil {
		return nil, err
	}
	blocked := func(start, end int) bool {
		for _, r := range hidden {
			if start < r.end && end > r.start {
				return true
			}
		}
		return false
	}
	d, err := parseMarkdown(source, body)
	if err != nil {
		return nil, err
	}
	var spans []linkSpan
	records := append([]linkRecord(nil), d.record.links...)
	sortLinkRecords(records)
	for _, l := range records {
		if l.dest.start < 0 || l.dest.end <= l.dest.start || !d.present(l.node) || d.whole(l).start < 0 {
			continue
		}
		start, end := l.dest.start+d.offset, l.dest.end+d.offset
		if blocked(start, end) {
			continue
		}
		whole := d.wholeOf(l)
		spans = append(spans, linkSpan{
			start: start, end: end,
			wholeStart: whole.start + d.offset, wholeEnd: whole.end + d.offset,
			url:        decodeString(source[start:end]),
			fragmentAt: fragmentAt(source, start, end),
		})
	}
	markdown := spans
	for _, w := range wikiMatches(source[body:]) {
		at, end := body+w.start, body+w.end
		if escaped(source, at) || blocked(at, end) {
			continue
		}
		overlaps := false
		for _, s := range markdown {
			if at < s.wholeEnd && end > s.wholeStart {
				overlaps = true
				break
			}
		}
		if overlaps {
			continue
		}
		start := at + 2
		if source[at] == '!' {
			start++
		}
		target := source[start : end-2]
		if bar := strings.IndexByte(target, '|'); bar >= 0 {
			target = target[:bar]
		}
		spans = append(spans, linkSpan{
			start: start, end: start + len(target), wholeStart: at, wholeEnd: end,
			url: target, wiki: true, fragmentAt: -1,
		})
	}
	return spans, nil
}

// wholeOf is a link record's extent including a definition's, whichever kind
// of node it is; reference links have no destination and never get here.
func (d *markdownDocument) wholeOf(l linkRecord) byteRange {
	if d.record.definitions[l.node] {
		return d.whole(l)
	}
	return l.whole
}

func sortLinkRecords(r []linkRecord) {
	for i := 1; i < len(r); i++ {
		for j := i; j > 0 && r[j].dest.start < r[j-1].dest.start; j-- {
			r[j], r[j-1] = r[j-1], r[j]
		}
	}
}

// escaped is Basalt's: whether an odd number of backslashes precedes s[at].
func escaped(s string, at int) bool {
	n := 0
	for at > 0 && s[at-1] == '\\' {
		n++
		at--
	}
	return n%2 == 1
}

// wikiMatch is one [[...]] or ![[...]] in a body, in byte offsets.
type wikiMatch struct{ start, end int }

// wikiMatches runs /!?\[\[[^\]\n]*\]\]/gu over s, as inlineTags does. The
// lazy form changeLinks uses matches the same text, because the class cannot
// hold "]".
func wikiMatches(s string) []wikiMatch {
	var out []wikiMatch
	for i := 0; i < len(s); {
		j := i
		if s[j] == '!' {
			j++
		}
		if strings.HasPrefix(s[j:], "[[") {
			k := j + 2
			for k < len(s) && s[k] != ']' && s[k] != '\n' {
				k++
			}
			if strings.HasPrefix(s[k:], "]]") {
				out = append(out, wikiMatch{i, k + 2})
				i = k + 2
				continue
			}
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	return out
}

// fragmentAt is where the first "#" of a destination string is, counting a
// "\#" escape or a character reference that decodes to "#" as one, the way
// micromark's tokens let changeLinks find it; -1 when there is none.
func fragmentAt(s string, start, end int) int {
	for i := start; i < end; {
		switch s[i] {
		case '\\':
			if i+1 < end && asciiPunct(s[i+1]) {
				if s[i+1] == '#' {
					return i
				}
				i += 2
				continue
			}
		case '&':
			if n, value := characterReference(s[i:end]); n > 0 {
				if value == "#" {
					return i
				}
				i += n
				continue
			}
		case '#':
			return i
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	return -1
}

func asciiPunct(c byte) bool {
	return '!' <= c && c <= '/' || ':' <= c && c <= '@' || '[' <= c && c <= '`' || '{' <= c && c <= '~'
}

// decodeString is micromark's decodeString: backslash escapes of ASCII
// punctuation and character references decoded, in one left-to-right pass.
func decodeString(s string) string {
	if !strings.ContainsAny(s, `\&`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		switch s[i] {
		case '\\':
			if i+1 < len(s) && asciiPunct(s[i+1]) {
				b.WriteByte(s[i+1])
				i += 2
				continue
			}
		case '&':
			if n, value := characterReference(s[i:]); n > 0 {
				b.WriteString(value)
				i += n
				continue
			}
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// characterReference reads a reference at the start of s the way
// decodeString's expression does, /&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/i:
// its length and value, or 0 when s does not start with one. A named
// reference must name an HTML entity; a numeric one that names no character
// micromark allows decodes to U+FFFD.
func characterReference(s string) (int, string) {
	if len(s) < 3 || s[0] != '&' {
		return 0, ""
	}
	if s[1] == '#' {
		digits, base, at := 7, 10, 2
		if s[2] == 'x' || s[2] == 'X' {
			digits, base, at = 6, 16, 3
		}
		n := 0
		for at+n < len(s) && n < digits && digitIn(s[at+n], base) {
			n++
		}
		if n == 0 || at+n >= len(s) || s[at+n] != ';' {
			return 0, ""
		}
		code, _ := strconv.ParseInt(s[at:at+n], base, 64)
		return at + n + 1, numericReference(code)
	}
	n := 0
	for 1+n < len(s) && n < 31 && (digitIn(s[1+n], 10) || 'a' <= s[1+n]|0x20 && s[1+n]|0x20 <= 'z') {
		n++
	}
	if n == 0 || 1+n >= len(s) || s[1+n] != ';' {
		return 0, ""
	}
	name := s[1 : 1+n]
	if value, ok := entityGaps[name]; ok {
		return n + 2, value
	}
	entity, ok := util.LookUpHTML5EntityByName(name)
	if !ok {
		return 0, ""
	}
	return n + 2, string(entity.Characters)
}

// entityGaps are the HTML named character references goldmark's table
// (v1.8.6) lacks and micromark's has. The oracle sweeps all 2,125 of
// micromark's through decodeString, which is how this one was found.
var entityGaps = map[string]string{"Abreve": "\u0102"}

func digitIn(c byte, base int) bool {
	if '0' <= c && c <= '9' {
		return true
	}
	return base == 16 && ('a' <= c|0x20 && c|0x20 <= 'f')
}

// numericReference is micromark's decodeNumericCharacterReference.
func numericReference(code int64) string {
	if code < 9 || code == 11 || code > 13 && code < 32 || code > 126 && code < 160 ||
		code > 0xd7ff && code < 0xe000 || code > 0xfdcf && code < 0xfdf0 ||
		code&0xffff == 0xffff || code&0xffff == 0xfffe || code > 0x10ffff {
		return "\ufffd"
	}
	return string(rune(code))
}
