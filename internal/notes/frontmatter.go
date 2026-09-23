package notes

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// Basalt parsed frontmatter with the npm yaml package (2.9, YAML 1.2, core
// schema) and refused anything that package reported an error or a warning
// for. This file parses it with gopkg.in/yaml.v3 and adds what yaml.v3 does
// not check, so that a frontmatter block is refused exactly when Basalt
// refused it. The differences it covers, each with a test in
// frontmatter_test.go:
//
//   - Line breaks. yaml.v3 (libyaml) ends a line at CR, NEL, U+2028 and
//     U+2029 as well as LF; npm yaml only at LF, so the others are ordinary
//     characters in a scalar.
//   - Characters libyaml's reader refuses (C0 controls other than tab, LF
//     and CR; DEL and the C1 controls; U+FFFE and U+FFFF) are ordinary
//     characters to npm yaml.
//     For both of these, yaml.v3 is given a copy in which each such character
//     is replaced by a private-use character absent from the text, one code
//     point for one, so columns are unchanged; values are mapped back.
//   - Scalar types. yaml.v3 resolves plain scalars by YAML 1.1 habits (a
//     date is a timestamp, 1_000 is an integer, "!" a request to resolve);
//     npm yaml's core schema does not, so types are resolved here from the
//     scalar's style and text.
//   - Tags. npm yaml warns about a tag it cannot resolve (!foo, !!int x,
//     !!str on a collection), and Basalt refused a warning; yaml.v3 accepts
//     any tag.
//   - Duplicate keys, anywhere in the document, compared by resolved value
//     (1 and 1.0 are one key, 1 and "1" are two): npm yaml refuses them,
//     yaml.v3 keeps both.
//   - Positions. yaml.v3 gives line and column; the tag's range is computed
//     from them and the text, as npm yaml's range: the value without its tag
//     or anchor, and without trailing spaces or comments.
//   - Anchor and alias names libyaml cannot read ("&k.x") are renamed before
//     it parses (renameAnchors), and lines of only spaces and tabs and tabs
//     after a block indicator are made spaces (prepareYAML); scanYAML, in
//     yamlscan.go, refuses what npm yaml refuses around those.
//   - Flow collections. A colon before a flow indicator ("[a:]") makes a key
//     to npm yaml and text to libyaml, which matters only for a tags item
//     (frontmatterTags); npm yaml refuses an implicit key over lines in a
//     flow sequence (scanYAML).
//   - Later documents. npm yaml, with its logging silenced as Basalt had it,
//     reads the first document and says nothing about the rest; libyaml's
//     scanner reads on into the next one and refuses what it cannot
//     tokenize there. Only the first document is given to it (firstDocument).
//     The write side found this: a tags property added after "--- b" is in a
//     second document.
//
// Two differences remain, and each refuses frontmatter Basalt read. The deep
// corpus found the first: npm yaml reads an implicit key over lines in a flow
// mapping ("{x\n  y: z}") and libyaml refuses it. The write side found the
// second: a document after a directive ("%YAML 1.2", "%TAG"), which npm yaml
// read by the schema the directive names and this port refuses
// (firstDocument). frontmatter_test.go records both.

// yamlPlaceholderBase is where the substitute characters are taken from:
// the top of plane 16, private use, and never legitimately in frontmatter.
const yamlPlaceholderBase = 0x10ff00

// yamlText is frontmatter prepared for yaml.v3.
type yamlText struct {
	original string
	parsed   string
	back     map[rune]rune // placeholder to the character it stands for
	bom      bool          // the text starts with U+FEFF, which yaml.v3 drops
	lines    []int         // byte offset of each line's start in original
	aliases  map[[2]int]bool
	renamed  []int // where renameAnchors renamed a property: its "&" or "*"
}

// yamlSubstitute reports whether npm yaml reads the character r at text[i]
// as ordinary where libyaml would not: as a line break (a CR that does not
// start a CRLF, NEL, U+2028, U+2029) or as a character its reader refuses. A
// byte-order mark is substituted everywhere but the start, where both
// parsers take it as a byte-order mark.
func yamlSubstitute(text string, i int, r rune) bool {
	switch {
	case r == '\r':
		return i+1 >= len(text) || text[i+1] != '\n'
	case r == 0xfeff:
		return i > 0
	case r == '\t' || r == '\n':
		return false
	case r < 0x20, r == 0x7f, 0x80 <= r && r <= 0x9f:
		return true
	case r == 0x2028, r == 0x2029, r == 0xfffe, r == 0xffff:
		return true
	}
	return false
}

func prepareYAML(text string) (*yamlText, bool) {
	names, untab, refused := scanYAML(text)
	if refused {
		return nil, false
	}
	y := &yamlText{original: text, back: map[rune]rune{}}
	y.bom = strings.HasPrefix(text, "\ufeff")
	src, renamed, ok := renameAnchors(text, names)
	if !ok {
		return nil, false
	}
	y.renamed = renamed
	forward := map[rune]rune{}
	next := rune(yamlPlaceholderBase)
	var b strings.Builder
	b.Grow(len(src))
	for i, r := range src {
		if !yamlSubstitute(src, i, r) {
			b.WriteRune(r)
			continue
		}
		p, ok := forward[r]
		if !ok {
			for strings.ContainsRune(text, next) {
				next++
			}
			if next > 0x10fffd {
				return nil, false
			}
			p = next
			next++
			forward[r] = p
			y.back[p] = r
		}
		b.WriteRune(p)
	}
	// A line of nothing but spaces and tabs is usually blank to npm yaml,
	// and libyaml refuses one that starts with a tab. Spaces instead of those
	// tabs keep every offset; scanYAML catches the places npm yaml does
	// not see a blank line.
	// libyaml also refuses a tab in the space after a "-", "?" or ":"
	// indicator that starts a line, which npm yaml takes as separation.
	// So is a comment line whose indentation holds a tab where scanYAML
	// found npm yaml reading a comment (untab): the tabs before its "#"
	// become spaces.
	lines := strings.SplitAfter(b.String(), "\n")
	for _, n := range untab {
		l := lines[n]
		lead := len(l) - len(strings.TrimLeft(l, " \t"))
		lines[n] = strings.Repeat(" ", lead) + l[lead:]
	}
	for i, l := range lines {
		if !strings.Contains(l, "\t") {
			continue
		}
		if strings.TrimLeft(l, " \t\r\n") == "" {
			lines[i] = strings.ReplaceAll(l, "\t", " ")
			continue
		}
		lines[i] = untabIndicators(l)
	}
	y.parsed = strings.Join(lines, "")
	y.lines = []int{0}
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			y.lines = append(y.lines, i+1)
		}
	}
	return y, true
}

// anchorAlphabet is the characters libyaml reads in an anchor name.
const anchorAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

// renameAnchors gives every anchor and alias name that libyaml would read
// differently from npm yaml ("k.x", "k:x", or one with a character outside
// ASCII) a name libyaml reads whole: as many characters, so every column
// stays where it was, and the same new name wherever the old one appears.
// A new name is no name already in the text, nor any run of libyaml's name
// characters after an "&" or "*" (which is what libyaml would read there),
// so npm yaml would resolve the renamed text exactly as the original. It
// returns the renamed text and where each renamed property begins, which
// renamesVerified holds against what yaml.v3 read.
func renameAnchors(text string, names []byteRange) (string, []int, bool) {
	used := map[string]bool{}
	for _, r := range names {
		used[text[r.start:r.end]] = true
	}
	for i := 0; i < len(text); i++ {
		if text[i] == '&' || text[i] == '*' {
			j := i + 1
			for j < len(text) && strings.IndexByte(anchorAlphabet, text[j]) >= 0 {
				j++
			}
			used[text[i+1:j]] = true
		}
	}
	given := map[string]string{}
	var renamed []int
	tried := map[int]int{} // candidates tried so far, by width
	var b strings.Builder
	last := 0
	for _, r := range names {
		name := text[r.start:r.end]
		if strings.Trim(name, anchorAlphabet) == "" {
			continue // libyaml reads it as npm yaml does, or refuses it if empty
		}
		to, ok := given[name]
		for !ok {
			width := utf8.RuneCountInString(name)
			candidate, more := anchorName(tried[width], width)
			if !more {
				return "", nil, false
			}
			tried[width]++
			if !used[candidate] {
				to, ok = candidate, true
				used[to] = true
				given[name] = to
			}
		}
		renamed = append(renamed, r.start-1)
		b.WriteString(text[last:r.start])
		b.WriteString(to)
		last = r.end
	}
	b.WriteString(text[last:])
	return b.String(), renamed, true
}

// anchorName is the index-th name of width characters from anchorAlphabet,
// or false when there are not that many.
func anchorName(index, width int) (string, bool) {
	b := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		b[i] = anchorAlphabet[index%len(anchorAlphabet)]
		index /= len(anchorAlphabet)
	}
	return string(b), index == 0
}

// renamesVerified reports whether yaml.v3 read an anchor or an alias at every
// place renameAnchors renamed one. A rename anywhere else took text inside a
// scalar for a property (a continuation line of a plain scalar can look like
// the start of a node) and changed the value, so the text is refused.
func (d *yamlDoc) renamesVerified() bool {
	y := d.text
	if len(y.renamed) == 0 {
		return true
	}
	if d.root == nil {
		return false
	}
	read := map[int]bool{}
	for p := range y.aliases {
		read[y.offset(p[0], p[1])] = true // aliases dropAlias replaced
	}
	var walk func(n *yaml.Node)
	walk = func(n *yaml.Node) {
		at := y.offset(n.Line, n.Column)
		if n.Kind == yaml.AliasNode {
			read[at] = true
		} else if n.Anchor != "" {
			// A node's position is its first property's; the anchor is
			// among the properties that begin there.
			for at >= 0 && at < len(y.original) && (y.original[at] == '!' || y.original[at] == '&') {
				if y.original[at] == '&' {
					read[at] = true
				}
				at = propertyEnd(y.original, at)
				for at < len(y.original) && isYAMLSpace(y.original[at]) {
					at++
				}
			}
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(d.root)
	for _, at := range y.renamed {
		if !read[at] {
			return false
		}
	}
	return true
}

// untabIndicators replaces with spaces the tabs in the whitespace after the
// block indicators ("-", "?" or ":") a line starts with, one for one.
func untabIndicators(line string) string {
	b := []byte(line)
	i := 0
	for i < len(b) && b[i] == ' ' {
		i++
	}
	for i < len(b) && (b[i] == '-' || b[i] == '?' || b[i] == ':') && i+1 < len(b) && (b[i+1] == ' ' || b[i+1] == '\t') {
		for i++; i < len(b) && (b[i] == ' ' || b[i] == '\t'); i++ {
			b[i] = ' '
		}
	}
	return string(b)
}

// dropAlias replaces every alias to name that starts a node with "~" and
// spaces, one character for each character it replaces, and records where
// each was. It reports whether it found any.
func (y *yamlText) dropAlias(name string) bool {
	alias := "*" + name
	s := y.parsed
	var b strings.Builder
	found := false
	last := 0
	for i := 0; i < len(s); i++ {
		if !strings.HasPrefix(s[i:], alias) || !yamlNodeStart(s, i) {
			continue
		}
		end := i + len(alias)
		if end < len(s) && !isYAMLSpace(s[end]) && strings.IndexByte(",[]{}", s[end]) < 0 {
			continue
		}
		b.WriteString(s[last:i])
		b.WriteString("~" + strings.Repeat(" ", utf8.RuneCountInString(name)))
		last = end
		found = true
		if y.aliases == nil {
			y.aliases = map[[2]int]bool{}
		}
		line := strings.Count(s[:i], "\n") + 1
		column := utf8.RuneCountInString(s[strings.LastIndexByte(s[:i], '\n')+1:i]) + 1
		if line == 1 && y.bom {
			column-- // yaml.v3 does not count the byte-order mark
		}
		y.aliases[[2]int{line, column}] = true
		i = end - 1
	}
	b.WriteString(s[last:])
	y.parsed = b.String()
	return found
}

// yamlNodeStart reports whether a node could begin at s[i]: at the start of a
// line after indentation, after a mapping, sequence or explicit-key
// indicator and a space, or directly after [, { or ,.
func yamlNodeStart(s string, i int) bool {
	j := i
	for j > 0 && (s[j-1] == ' ' || s[j-1] == '\t') {
		j--
	}
	if j == 0 || s[j-1] == '\n' {
		return true
	}
	switch s[j-1] {
	case '[', '{', ',':
		return true
	case ':', '-', '?':
		return j < i
	}
	return false
}

// isAlias reports whether a node is an alias dropAlias replaced.
func (y *yamlText) isAlias(n *yaml.Node) bool { return y.aliases[[2]int{n.Line, n.Column}] }

// restore maps placeholders in a value back to the characters they replaced.
func (y *yamlText) restore(s string) string {
	if len(y.back) == 0 {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		if o, ok := y.back[r]; ok {
			r = o
		}
		b.WriteRune(r)
	}
	return b.String()
}

// offset is the byte offset in the original text of yaml.v3's 1-based line
// and column (columns count characters).
func (y *yamlText) offset(line, column int) int {
	if line < 1 || line > len(y.lines) {
		return -1
	}
	at := y.lines[line-1]
	skip := column - 1
	if line == 1 && y.bom {
		at += len("\ufeff")
	}
	for ; skip > 0 && at < len(y.original); skip-- {
		_, size := utf8.DecodeRuneInString(y.original[at:])
		at += size
	}
	return at
}

// yamlValue is a scalar resolved as npm yaml's core schema resolves it.
type yamlValue struct {
	kind string // "null", "bool", "number", "string", or "other"
	str  string
	num  float64
}

var (
	yamlNull     = regexp.MustCompile(`^(?:~|[Nn]ull|NULL)?$`)
	yamlBool     = regexp.MustCompile(`^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$`)
	yamlIntOct   = regexp.MustCompile(`^0o[0-7]+$`)
	yamlInt      = regexp.MustCompile(`^[-+]?[0-9]+$`)
	yamlIntHex   = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)
	yamlFloatNaN = regexp.MustCompile(`^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$`)
	yamlFloatExp = regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$`)
	yamlFloat    = regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$`)
	yamlDate     = regexp.MustCompile(`^[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?`)
)

// resolveTest is findScalarTagByTest for the core schema: the first of null,
// bool, int (octal, decimal, hex) and float (special, exponent, decimal) whose
// expression matches, else a string.
func resolveTest(v string) (yamlValue, bool) {
	switch {
	case yamlNull.MatchString(v):
		return yamlValue{kind: "null"}, true
	case yamlBool.MatchString(v):
		return yamlValue{kind: "bool", str: strconv.FormatBool(v[0] == 't' || v[0] == 'T')}, true
	case yamlIntOct.MatchString(v):
		return yamlValue{kind: "number", num: parseJSInt(v[2:], 8)}, true
	case yamlInt.MatchString(v):
		return yamlValue{kind: "number", num: parseJSInt(v, 10)}, true
	case yamlIntHex.MatchString(v):
		return yamlValue{kind: "number", num: parseJSInt(v[2:], 16)}, true
	case yamlFloatNaN.MatchString(v):
		if strings.HasSuffix(strings.ToLower(v), "nan") {
			return yamlValue{kind: "number", num: math.NaN()}, true
		}
		if v[0] == '-' {
			return yamlValue{kind: "number", num: math.Inf(-1)}, true
		}
		return yamlValue{kind: "number", num: math.Inf(1)}, true
	case yamlFloatExp.MatchString(v), yamlFloat.MatchString(v):
		f, _ := strconv.ParseFloat(v, 64)
		return yamlValue{kind: "number", num: f}, true
	}
	return yamlValue{kind: "string", str: v}, false
}

// parseJSInt is JavaScript's parseInt for digits already checked, sign
// included: the nearest double, as parseInt returns.
func parseJSInt(s string, base int) float64 {
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	f := 0.0
	if base == 10 {
		f, _ = strconv.ParseFloat(s, 64)
	} else {
		for _, c := range s {
			d := strings.IndexRune("0123456789abcdef", c|0x20)
			f = f*float64(base) + float64(d)
		}
	}
	if neg {
		return -f
	}
	return f
}

// yamlTagName expands a tag property the way the directives of a document
// with none do: "!!x" is tag:yaml.org,2002:x, a verbatim tag is itself, and
// "!" and a local tag are themselves. A named handle is an error without a
// %TAG directive, which frontmatter cannot have.
func yamlTagName(tag string) (string, bool) {
	switch {
	case tag == "!":
		return "!", true
	case strings.HasPrefix(tag, "!<") && strings.HasSuffix(tag, ">"):
		return tag[2 : len(tag)-1], true
	case strings.HasPrefix(tag, "!!"):
		return "tag:yaml.org,2002:" + tag[2:], true
	case strings.Count(tag, "!") > 1:
		return "", false
	}
	return tag, true
}

const yamlCore = "tag:yaml.org,2002:"

// resolveScalar is composeScalar: the value of a scalar with this style,
// text and explicit tag ("" for none), or false where npm yaml reports an
// error or a warning.
func resolveScalar(plain bool, value, tag string) (yamlValue, bool) {
	if tag == "" {
		if !plain {
			return yamlValue{kind: "string", str: value}, true
		}
		v, _ := resolveTest(value)
		return v, true
	}
	name, ok := yamlTagName(tag)
	if !ok {
		return yamlValue{}, false
	}
	switch name {
	case "!", yamlCore + "str":
		return yamlValue{kind: "string", str: value}, true
	case yamlCore + "null":
		if yamlNull.MatchString(value) {
			return yamlValue{kind: "null"}, true
		}
	case yamlCore + "bool":
		if yamlBool.MatchString(value) {
			return resolveTest(value)
		}
	case yamlCore + "int":
		if yamlIntOct.MatchString(value) || yamlInt.MatchString(value) || yamlIntHex.MatchString(value) {
			v, _ := resolveTest(value)
			return v, true
		}
	case yamlCore + "float":
		if yamlFloatNaN.MatchString(value) || yamlFloatExp.MatchString(value) || yamlFloat.MatchString(value) {
			v, _ := resolveTest(value)
			return v, true
		}
	case yamlCore + "binary":
		return yamlValue{kind: "other"}, true
	case yamlCore + "timestamp":
		if yamlDate.MatchString(value) {
			return yamlValue{kind: "other"}, true
		}
	}
	return yamlValue{}, false
}

// yamlCollectionTagOK is whether npm yaml resolves an explicit tag on a
// collection without complaint.
func yamlCollectionTagOK(kind yaml.Kind, tag string) bool {
	name, ok := yamlTagName(tag)
	if !ok {
		return false
	}
	switch name {
	case "!":
		return true
	case yamlCore + "seq", yamlCore + "omap", yamlCore + "pairs":
		return kind == yaml.SequenceNode
	case yamlCore + "map", yamlCore + "set":
		return kind == yaml.MappingNode
	}
	return false
}

// yamlDoc is one parsed frontmatter block.
type yamlDoc struct {
	text *yamlText
	root *yaml.Node // the document's content, or nil when it has none
}

// props reads the tag and anchor properties that begin at byte offset at,
// returning the tag ("" for none), the anchor ("" for none) and where the
// node's own text begins.
func (y *yamlText) props(at int) (tag, anchor string, start int) {
	s := y.original
	if at < 0 {
		return "", "", 0
	}
	for at < len(s) && (s[at] == '!' || s[at] == '&') {
		end := at + 1
		if strings.HasPrefix(s[at:], "!<") {
			if close := strings.IndexByte(s[at:], '>'); close >= 0 {
				end = at + close + 1
			}
		} else {
			for end < len(s) && !isYAMLSpace(s[end]) && strings.IndexByte(",[]{}", s[end]) < 0 {
				end++
			}
		}
		if s[at] == '!' {
			tag = s[at:end]
		} else {
			anchor = s[at+1 : end]
		}
		at = end
		for at < len(s) && (s[at] == ' ' || s[at] == '\t' || s[at] == '\n' || s[at] == '\r') {
			at++
		}
	}
	return tag, anchor, at
}

var unknownAnchor = regexp.MustCompile(`unknown anchor '([^']*)' referenced`)

// firstDocument is frontmatter's first YAML document: the text before the
// line that starts a second one, a "---" marker once the first has begun
// (with content or a marker of its own), or that ends the first, a "..."
// marker after it has begun. A marker is three dashes or dots at the start of
// a line, followed by a space, a tab or the end of the line. Comment lines,
// blank lines and directives come before a document without beginning it.
//
// It is false for a document that follows a directive, which is refused:
// npm yaml read "%YAML 1.1" as a request for YAML 1.1's schema, in which
// "yes" is a boolean, and yaml.v3 refuses "%YAML 1.2" and reads %TAG
// handles its own way. Frontmatter that needs a directive is refused rather
// than read by a schema this port does not model (TestFrontmatterKnownDivergence).
func firstDocument(text string) (string, bool) {
	begun, directive := false, false
	for at := 0; at < len(text); {
		end := len(text)
		if nl := strings.IndexByte(text[at:], '\n'); nl >= 0 {
			end = at + nl + 1
		}
		line := strings.TrimRight(text[at:end], "\r\n")
		marker := func(m string) bool {
			return strings.HasPrefix(line, m) && (len(line) == 3 || line[3] == ' ' || line[3] == '\t')
		}
		switch trimmed := strings.TrimLeft(line, " \t"); {
		case marker("---"):
			if begun {
				return text[:at], !directive
			}
			begun = true
		case marker("..."):
			if begun {
				return text[:at], !directive
			}
		case trimmed == "", trimmed[0] == '#':
		case !begun && line[0] == '%':
			directive = true
		default:
			begun = true
		}
		at = end
	}
	return text, !(directive && begun)
}

// parseFrontmatterYAML parses text, or reports false wherever npm yaml would
// have reported an error or a warning.
//
// One more difference is handled here: an alias to an anchor that is never
// defined (or only later) is an error to yaml.v3 and nothing to npm yaml,
// which resolves aliases only when a value is converted. Each such alias is
// replaced by a null scalar of the same width, remembered, and the text
// parsed again, so a tags property that is one still counts as an alias.
func parseFrontmatterYAML(text string) (*yamlDoc, bool) {
	text, ok := firstDocument(text)
	if !ok {
		return nil, false
	}
	y, ok := prepareYAML(text)
	if !ok {
		return nil, false
	}
	var doc yaml.Node
	for attempt := 0; ; attempt++ {
		err := yaml.Unmarshal([]byte(y.parsed), &doc)
		if err == nil {
			break
		}
		m := unknownAnchor.FindStringSubmatch(err.Error())
		if m == nil || attempt == 16 || !y.dropAlias(m[1]) {
			return nil, false
		}
		doc = yaml.Node{}
	}
	d := &yamlDoc{text: y}
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		d.root = doc.Content[0]
	}
	if !d.renamesVerified() || d.root != nil && !d.check(d.root) {
		return nil, false
	}
	return d, true
}

// check walks a node and everything under it for the conditions npm yaml
// reports and yaml.v3 does not.
func (d *yamlDoc) check(n *yaml.Node) bool {
	switch n.Kind {
	case yaml.AliasNode:
		return true
	case yaml.ScalarNode:
		_, ok := d.scalar(n)
		return ok
	case yaml.SequenceNode, yaml.MappingNode:
		// A collection's position is its first key's or item's when it has
		// no properties of its own, so its tag is taken from yaml.v3, which
		// marks an explicit one with TaggedStyle.
		if n.Style&yaml.TaggedStyle != 0 && !yamlCollectionTagOK(n.Kind, n.Tag) {
			return false
		}
		for _, c := range n.Content {
			if !d.check(c) {
				return false
			}
		}
		if n.Kind == yaml.MappingNode {
			return d.uniqueKeys(n)
		}
		return true
	}
	return false
}

// scalar resolves a scalar node. yaml.v3 marks an explicit tag with
// TaggedStyle except the non-specific "!", which it resolves away, so that
// one is read from the source.
func (d *yamlDoc) scalar(n *yaml.Node) (yamlValue, bool) {
	tag := ""
	if n.Style&yaml.TaggedStyle != 0 {
		tag = n.Tag
	} else if t, _, _ := d.text.props(d.text.offset(n.Line, n.Column)); t == "!" {
		tag = t
	}
	style := n.Style &^ yaml.TaggedStyle
	return resolveScalar(style == 0, d.text.restore(n.Value), tag)
}

// uniqueKeys is npm yaml's uniqueKeys check: no two scalar keys of a mapping
// resolve to the same value. Collections and aliases as keys are compared by
// identity, so never collide.
func (d *yamlDoc) uniqueKeys(m *yaml.Node) bool {
	var seen []yamlValue
	for i := 0; i+1 < len(m.Content); i += 2 {
		k := m.Content[i]
		if k.Kind != yaml.ScalarNode || d.text.isAlias(k) {
			continue
		}
		v, ok := d.scalar(k)
		if !ok {
			return false
		}
		for _, s := range seen {
			if yamlEqual(s, v) {
				return false
			}
		}
		seen = append(seen, v)
	}
	return true
}

// yamlEqual is JavaScript's === on two resolved scalars.
func yamlEqual(a, b yamlValue) bool {
	if a.kind != b.kind || a.kind == "other" {
		return false
	}
	switch a.kind {
	case "null":
		return true
	case "number":
		return a.num == b.num
	}
	return a.str == b.str
}

// tagsProperty is the root mapping's tags property, its key and its value, or
// two nils.
func (d *yamlDoc) tagsProperty() (key, value *yaml.Node) {
	if d.root == nil || d.root.Kind != yaml.MappingNode {
		return nil, nil
	}
	for i := 0; i+1 < len(d.root.Content); i += 2 {
		k := d.root.Content[i]
		if k.Kind != yaml.ScalarNode || d.text.isAlias(k) {
			continue
		}
		if v, ok := d.scalar(k); ok && v.kind == "string" && v.str == "tags" {
			return k, d.root.Content[i+1]
		}
	}
	return nil, nil
}

// frontTags is what Basalt's frontTags read from a note's frontmatter: the
// tags, and for an edit, the parsed frontmatter and its tags property (nil
// when there is no frontmatter, or no such property).
type frontTags struct {
	tags      []tagOcc
	doc       *yamlDoc
	key, node *yaml.Node
}

// frontmatterTags is Basalt's frontTags over byte offsets.
func frontmatterTags(source string, f frame) ([]tagOcc, error) {
	ft, err := readFrontTags(source, f)
	return ft.tags, err
}

func readFrontTags(source string, f frame) (frontTags, error) {
	if !f.present {
		return frontTags{}, nil
	}
	d, ok := parseFrontmatterYAML(source[f.start:f.end])
	if !ok || (d.root != nil && d.root.Kind != yaml.MappingNode) {
		return frontTags{}, refuse("invalid_frontmatter", "frontmatter must be an unambiguous YAML mapping")
	}
	key, node := d.tagsProperty()
	if node == nil {
		return frontTags{doc: d}, nil
	}
	items := []*yaml.Node{node}
	if node.Kind == yaml.SequenceNode {
		items = node.Content
	}
	if (node.Kind == yaml.ScalarNode || node.Kind == yaml.SequenceNode) && node.Anchor != "" {
		return frontTags{}, refuse("invalid_frontmatter", "an anchored tags property needs an explicit note edit")
	}
	var found []tagOcc
	for _, item := range items {
		if item.Kind != yaml.ScalarNode || item.Anchor != "" || d.text.isAlias(item) {
			return frontTags{}, invalidTagsProperty()
		}
		if node.Style&yaml.FlowStyle != 0 && item.Style&^yaml.TaggedStyle == 0 && strings.HasSuffix(item.Value, ":") {
			// A colon before a flow indicator ("[a:]") is a key to npm yaml,
			// which makes the item a mapping, and text to libyaml.
			return frontTags{}, invalidTagsProperty()
		}
		v, ok := d.scalar(item)
		if !ok || (v.kind != "null" && v.kind != "string") {
			return frontTags{}, invalidTagsProperty()
		}
		if v.kind == "null" {
			continue
		}
		start, end := d.scalarRange(item, v.str)
		for _, value := range splitTags(v.str) {
			tag, err := ValidateTag(value)
			if err != nil {
				return frontTags{}, err
			}
			found = append(found, tagOcc{Tag: tag, start: f.start + start, end: f.start + end, location: "frontmatter"})
		}
	}
	return frontTags{tags: found, doc: d, key: key, node: node}, nil
}

func invalidTagsProperty() error {
	return refuse("invalid_frontmatter", "tags must be a string or a list of strings without aliases or anchors")
}

// splitTags is String(value).split(/[\s,]+/u).filter(Boolean).
func splitTags(v string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || jsSpace(r) }) {
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

// scalarRange is npm yaml's range[0] and range[1] for a scalar: where its
// text begins, after any tag or anchor, and where its value ends.
func (d *yamlDoc) scalarRange(n *yaml.Node, value string) (int, int) {
	y := d.text
	_, _, start := y.props(y.offset(n.Line, n.Column))
	s := y.original
	switch n.Style &^ yaml.TaggedStyle {
	case yaml.DoubleQuotedStyle:
		for i := start + 1; i < len(s); i++ {
			if s[i] == '\\' {
				i++
			} else if s[i] == '"' {
				return start, i + 1
			}
		}
	case yaml.SingleQuotedStyle:
		for i := start + 1; i < len(s); i++ {
			if s[i] == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
					continue
				}
				return start, i + 1
			}
		}
	case yaml.LiteralStyle, yaml.FoldedStyle:
		return start, blockScalarEnd(s, start)
	default:
		return start, plainScalarEnd(s, start, value)
	}
	return start, len(s)
}

// plainScalarEnd walks a plain scalar's value against its source: a value
// character is the same character in the source, and a folded line break
// (a space, or "\n" for each empty line) is a run of whitespace holding line
// breaks.
func plainScalarEnd(s string, start int, value string) int {
	i, j := start, 0
	for j < len(value) && i < len(s) {
		if isYAMLSpace(s[i]) {
			k := i
			for k < len(s) && isYAMLSpace(s[k]) {
				k++
			}
			if strings.IndexByte(s[i:k], '\n') >= 0 {
				i = k
				for j < len(value) && (value[j] == ' ' || value[j] == '\n') {
					j++
				}
				continue
			}
		}
		if s[i] != value[j] {
			return i
		}
		i++
		j++
	}
	return i
}

func isYAMLSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// blockScalarEnd is where npm yaml ends a block scalar's range: after the
// line break of its last line with content, or with keep chomping ("+")
// after its trailing empty lines too, or at the end of the text.
func blockScalarEnd(s string, start int) int {
	header := strings.IndexByte(s[start:], '\n')
	if header < 0 {
		return len(s)
	}
	keep := strings.Contains(s[start:start+header], "+")
	parent := lineIndent(s, lineStartOf(s, start))
	end := start + header + 1
	contentEnd := end
	indent := -1
	for at := end; at < len(s); {
		nl := strings.IndexByte(s[at:], '\n')
		lineEnd := len(s)
		if nl >= 0 {
			lineEnd = at + nl + 1
		}
		line := s[at:lineEnd]
		if strings.TrimRight(line, " \t\r\n") == "" {
			at = lineEnd
			if keep {
				contentEnd = at
			}
			continue
		}
		ind := lineIndent(s, at)
		if indent < 0 {
			indent = ind
		}
		if ind < indent || ind <= parent {
			break
		}
		at = lineEnd
		contentEnd = at
	}
	return contentEnd
}

func lineStartOf(s string, at int) int {
	return strings.LastIndexByte(s[:at], '\n') + 1
}

func lineIndent(s string, at int) int {
	n := 0
	for at+n < len(s) && s[at+n] == ' ' {
		n++
	}
	return n
}
