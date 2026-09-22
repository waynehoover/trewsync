package notes

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxTagBytes is the longest tag, in UTF-8 bytes.
const MaxTagBytes = 200

// Tag characters, as mcp-markdown.ts's regular expressions define them. The
// Extended_Pictographic and Emoji_Modifier tables are generated from the
// JavaScript runtime (emoji_table.go); the oracle sweeps every code point
// through these four classes against that runtime.

// tagChar is [\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d_/-].
func tagChar(r rune) bool {
	switch r {
	case '_', '/', '-', 0x200d:
		return true
	}
	return unicode.In(r, unicode.L, unicode.M, unicode.N, extendedPictographic, emojiModifier)
}

// tagLetter is [\p{L}\p{M}\p{Extended_Pictographic}_-]: a tag needs one, so
// that "#123" is ordinary text.
func tagLetter(r rune) bool {
	switch r {
	case '_', '-':
		return true
	}
	return unicode.In(r, unicode.L, unicode.M, extendedPictographic)
}

// tagBoundary is [^\p{L}\p{M}\p{N}_/#\\]: the character a hashtag may follow.
func tagBoundary(r rune) bool {
	switch r {
	case '_', '/', '#', '\\':
		return false
	}
	return !unicode.In(r, unicode.L, unicode.M, unicode.N)
}

// patternChar is tagChar plus the * wildcard, the alphabet of tag patterns.
func patternChar(r rune) bool { return r == '*' || tagChar(r) }

// ValidateTag is Basalt's validateTag: the tag without one leading "#", or
// invalid_tag unless it is at most MaxTagBytes of tag characters with at least
// one that is not a digit, and neither starts nor ends with "/" nor holds an
// empty nested segment.
func ValidateTag(input string) (string, error) {
	tag := strings.TrimPrefix(input, "#")
	letter := false
	for _, r := range tag {
		if !tagChar(r) {
			return "", invalidTag()
		}
		letter = letter || tagLetter(r)
	}
	if tag == "" || len(tag) > MaxTagBytes || !letter || strings.HasPrefix(tag, "/") ||
		strings.HasSuffix(tag, "/") || strings.Contains(tag, "//") {
		return "", invalidTag()
	}
	return tag, nil
}

func invalidTag() error {
	return refuse("invalid_tag", "tags must be at most 200 bytes, contain a non-number, and use letters, numbers, emoji, _, -, or nested / segments")
}

// FoldTag is the key two tags match by: NFC, then JavaScript's lowercase.
func FoldTag(tag string) string { return foldTag(tag) }

// MatchesTag is Basalt's matchesTag: candidate is selected, or with children
// one of its nested tags, comparing folded forms.
func MatchesTag(candidate, selected string, children bool) bool {
	c, s := foldTag(candidate), foldTag(selected)
	return c == s || (children && strings.HasPrefix(c, s+"/"))
}

// TagPattern is Basalt's tagPattern: whether value matches a glob in which *
// stands for any run of characters, comparing folded forms. A pattern is
// refused (invalid_tag) unless it is at most MaxTagBytes of tag characters and
// single asterisks: the bounded matcher is what keeps a vault-wide tag
// operation from becoming an unbounded regular expression.
func TagPattern(pattern, value string) (bool, error) {
	if pattern == "" || len(pattern) > MaxTagBytes || strings.Contains(pattern, "**") {
		return false, invalidPattern()
	}
	for _, r := range pattern {
		if !patternChar(r) {
			return false, invalidPattern()
		}
	}
	target := []rune(foldTag(value))
	wanted := []rune(foldTag(strings.TrimPrefix(pattern, "#")))
	p, t, star, retry := 0, 0, -1, 0
	at := func(s []rune, i int) rune {
		if i < len(s) {
			return s[i]
		}
		return -1
	}
	for t < len(target) {
		switch {
		case at(wanted, p) == target[t]:
			p++
			t++
		case at(wanted, p) == '*':
			star = p
			p++
			retry = t
		case star >= 0:
			p = star + 1
			retry++
			t = retry
		default:
			return false, nil
		}
	}
	for at(wanted, p) == '*' {
		p++
	}
	return p == len(wanted), nil
}

func invalidPattern() error {
	return refuse("invalid_tag", "tag patterns use at most 200 bytes and single * wildcards")
}

// Frontmatter is where a note's YAML frontmatter is, as Basalt's frontmatter
// found it. Offsets are UTF-16 code units into the note.
type Frontmatter struct {
	// BOM is 1 when the note starts with a byte-order mark.
	BOM int
	// Newline is "\r\n" when the note holds one anywhere, "\n" otherwise: the
	// line ending an edit to the frontmatter writes.
	Newline string
	// Start and End bound the YAML between the delimiters; Body is where the
	// Markdown after the closing delimiter begins. Without frontmatter all
	// three are BOM.
	Start, End, Body int
	Present          bool
}

// frame is Frontmatter in byte offsets.
type frame struct {
	bom, start, end, body int
	newline               string
	present               bool
}

// FindFrontmatter locates the frontmatter as Basalt did: an opening "---"
// line at the very start (after a byte-order mark), and the first later line
// that is "---" followed by spaces or tabs to the end of the line. JavaScript's
// multiline anchors treat CR, LF, U+2028 and U+2029 all as line ends, so a
// closing delimiter may follow any of them. An opening delimiter with no
// closing one is invalid_frontmatter.
func FindFrontmatter(source string) (Frontmatter, error) {
	f, err := findFrame(source)
	if err != nil {
		return Frontmatter{}, err
	}
	x := newUnitIndex(source)
	return Frontmatter{
		BOM: x.at(f.bom), Newline: f.newline, Start: x.at(f.start), End: x.at(f.end),
		Body: x.at(f.body), Present: f.present,
	}, nil
}

func findFrame(source string) (frame, error) {
	f := frame{newline: "\n"}
	if strings.HasPrefix(source, "\ufeff") {
		f.bom = len("\ufeff")
	}
	if strings.Contains(source, "\r\n") {
		f.newline = "\r\n"
	}
	f.start, f.end, f.body = f.bom, f.bom, f.bom
	rest := source[f.bom:]
	if !strings.HasPrefix(rest, "---") {
		return f, nil
	}
	i := 3 + spacesOrTabs(rest[3:])
	switch {
	case strings.HasPrefix(rest[i:], "\r\n"):
		i += 2
	case strings.HasPrefix(rest[i:], "\n"):
		i++
	default:
		return f, nil
	}
	f.start = f.bom + i
	yaml := source[f.start:]
	for p := 0; p <= len(yaml); p++ {
		if p > 0 && !afterLineTerminator(yaml, p) {
			continue
		}
		if !strings.HasPrefix(yaml[p:], "---") {
			continue
		}
		q := p + 3 + spacesOrTabs(yaml[p+3:])
		n := -1
		switch {
		case strings.HasPrefix(yaml[q:], "\r\n"):
			n = q + 2 - p
		case strings.HasPrefix(yaml[q:], "\n"):
			n = q + 1 - p
		case q == len(yaml) || lineTerminatorAt(yaml, q):
			n = q - p
		}
		if n < 0 {
			continue
		}
		f.end = f.start + p
		f.body = f.end + n
		f.present = true
		return f, nil
	}
	return frame{}, refuse("invalid_frontmatter", "the opening frontmatter delimiter has no closing delimiter")
}

func spacesOrTabs(s string) int {
	n := 0
	for n < len(s) && (s[n] == ' ' || s[n] == '\t') {
		n++
	}
	return n
}

// lineTerminatorAt reports whether a JavaScript LineTerminator starts at s[i]:
// LF, CR, U+2028 or U+2029.
func lineTerminatorAt(s string, i int) bool {
	if i >= len(s) {
		return false
	}
	switch s[i] {
	case '\n', '\r':
		return true
	}
	return strings.HasPrefix(s[i:], "\u2028") || strings.HasPrefix(s[i:], "\u2029")
}

// afterLineTerminator reports whether s[i] immediately follows one.
func afterLineTerminator(s string, i int) bool {
	if i >= 1 && (s[i-1] == '\n' || s[i-1] == '\r') {
		return true
	}
	return i >= 3 && (s[i-3:i] == "\u2028" || s[i-3:i] == "\u2029")
}

// TagOccurrence is one tag in a note: from the frontmatter's tags property or
// a hashtag in the body. Start and End are UTF-16 offsets into the note: a
// hashtag's span from its "#", or the whole YAML scalar a frontmatter tag was
// read from (several tags can share one scalar).
type TagOccurrence struct {
	Tag      string
	Start    int
	End      int
	Location string
}

// tagOcc is a TagOccurrence in byte offsets.
type tagOcc struct {
	Tag        string
	start, end int
	location   string
}

// TagOccurrences is Basalt's tagOccurrences: the frontmatter's tags, then the
// body's hashtags. Frontmatter that is not an unambiguous YAML mapping, or a
// tags property that is not a string or a list of strings without anchors or
// aliases, is invalid_frontmatter; a frontmatter tag that is not a valid tag
// is invalid_tag. A hashtag that is not a valid tag is ordinary text, as it is
// to Obsidian.
func TagOccurrences(source string) ([]TagOccurrence, error) {
	found, err := tagOccurrences(source)
	if err != nil {
		return nil, err
	}
	return tagOccurrencesInUnits(source, found), nil
}

func tagOccurrencesInUnits(source string, found []tagOcc) []TagOccurrence {
	x := newUnitIndex(source)
	out := make([]TagOccurrence, len(found))
	for i, o := range found {
		out[i] = TagOccurrence{Tag: o.Tag, Start: x.at(o.start), End: x.at(o.end), Location: o.location}
	}
	return out
}

func tagOccurrences(source string) ([]tagOcc, error) {
	f, err := findFrame(source)
	if err != nil {
		return nil, err
	}
	found, err := frontmatterTags(source, f)
	if err != nil {
		return nil, err
	}
	return append(found, inlineTags(source, f.body)...), nil
}

// InlineTags is Basalt's inlineTags: the hashtags in the body from UTF-16
// offset start, outside code, inline code, HTML, links, images, reference
// definitions, %% comments and wiki links.
func InlineTags(source string, start int) []TagOccurrence {
	return tagOccurrencesInUnits(source, inlineTags(source, byteAtUnit(source, start)))
}

func inlineTags(source string, start int) []tagOcc {
	body := source[start:]
	hidden := markdownHidden(source, start, true)
	for _, w := range wikiMatches(body) {
		hidden = append(hidden, byteRange{start + w.start, start + w.end})
	}
	blocked := mergeRanges(hidden)
	var found []tagOcc
	index := 0
	for _, m := range hashtags(body) {
		at := start + m.hash
		for index < len(blocked) && blocked[index].end <= at {
			index++
		}
		if index < len(blocked) && at >= blocked[index].start {
			continue
		}
		name := body[m.hash+1 : m.end]
		if tag, err := ValidateTag(name); err == nil {
			found = append(found, tagOcc{Tag: tag, start: at, end: start + m.end, location: "content"})
		}
	}
	return found
}

// hashtagMatch is one match of Basalt's hashtag expression
// /(^|[^\p{L}\p{M}\p{N}_/#\\])#([tag characters]+)/gu: hash is the offset of
// the "#", end the offset after the last tag character.
type hashtagMatch struct{ hash, end int }

// hashtags runs that expression over body as String.prototype.matchAll would:
// at each position the start-of-input alternative is tried first, then a
// boundary character before the "#"; a match consumes its boundary character,
// so the next search starts after the tag.
func hashtags(body string) []hashtagMatch {
	var out []hashtagMatch
	for i := 0; i < len(body); {
		hash := -1
		if i == 0 && body[0] == '#' && tagRun(body[1:]) > 0 {
			hash = 0
		} else {
			r, size := utf8.DecodeRuneInString(body[i:])
			if tagBoundary(r) && i+size < len(body) && body[i+size] == '#' && tagRun(body[i+size+1:]) > 0 {
				hash = i + size
			}
			if hash < 0 {
				i += size
				continue
			}
		}
		end := hash + 1 + tagRun(body[hash+1:])
		out = append(out, hashtagMatch{hash: hash, end: end})
		i = end
	}
	return out
}

// tagRun is the length in bytes of the run of tag characters s starts with.
func tagRun(s string) int {
	for i, r := range s {
		if !tagChar(r) {
			return i
		}
	}
	return len(s)
}

// byteRange is a half-open range of byte offsets.
type byteRange struct{ start, end int }

// mergeRanges is Basalt's intervals(): sorted by start, overlapping or
// touching ranges merged.
func mergeRanges(ranges []byteRange) []byteRange {
	sorted := append([]byteRange(nil), ranges...)
	sortRanges(sorted)
	var merged []byteRange
	for _, r := range sorted {
		if n := len(merged); n > 0 && r.start <= merged[n-1].end {
			merged[n-1].end = max(merged[n-1].end, r.end)
			continue
		}
		merged = append(merged, r)
	}
	return merged
}
