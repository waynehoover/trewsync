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
	y := &yamlText{original: text, back: map[rune]rune{}}
	y.bom = strings.HasPrefix(text, "\ufeff")
	forward := map[rune]rune{}
	next := rune(yamlPlaceholderBase)
	var b strings.Builder
	b.Grow(len(text))
	for i, r := range text {
		if !yamlSubstitute(text, i, r) {
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
	// A line of nothing but spaces and tabs is blank to npm yaml; libyaml
	// refuses one that starts with a tab. Spaces instead of those tabs keep
	// every offset.
	lines := strings.SplitAfter(b.String(), "\n")
	for i, l := range lines {
		if strings.Contains(l, "\t") && strings.TrimLeft(l, " \t\r\n") == "" {
			lines[i] = strings.ReplaceAll(l, "\t", " ")
		}
	}
	y.parsed = strings.Join(lines, "")
	y.lines = []int{0}
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			y.lines = append(y.lines, i+1)
		}
	}
	// libyaml reads anchor and alias names as letters, digits, "_" and "-"
	// only; npm yaml, as YAML allows, reads any characters up to a space or
	// a flow indicator, so "*k:" is an alias named "k:" to one and an alias
	// then a colon to the other. Where the two would read a name
	// differently the frontmatter is refused rather than read wrongly.
	if yamlUnusualProperty(text) {
		return nil, false
	}
	return y, true
}

// yamlUnusualProperty reports whether an anchor or alias that begins a node
// has a name libyaml would read differently from npm yaml. Quoted scalars,
// comments and block scalars are skipped, so text inside them is not taken
// for a property.
func yamlUnusualProperty(s string) bool {
	blockIndent := -1 // the indentation of a block scalar's header line
	for i := 0; i < len(s); i++ {
		if i == 0 || s[i-1] == '\n' {
			end := strings.IndexByte(s[i:], '\n')
			if end < 0 {
				end = len(s) - i
			}
			line := s[i : i+end]
			indent := len(line) - len(strings.TrimLeft(line, " "))
			if blockIndent >= 0 && (strings.TrimSpace(line) == "" || indent > blockIndent) {
				i += end
				continue
			}
			blockIndent = -1
		}
		c := s[i]
		if !yamlNodeStart(s, i) {
			if c == '#' && i > 0 && (s[i-1] == ' ' || s[i-1] == '\t') {
				i = skipToLineEnd(s, i)
			}
			continue
		}
		switch c {
		case '#':
			i = skipToLineEnd(s, i)
		case '"', '\'':
			for i++; i < len(s); i++ {
				if c == '"' && s[i] == '\\' {
					i++
				} else if s[i] == c {
					if c == '\'' && i+1 < len(s) && s[i+1] == '\'' {
						i++
						continue
					}
					break
				}
			}
		case '|', '>':
			line := s[strings.LastIndexByte(s[:i], '\n')+1:]
			blockIndent = len(line) - len(strings.TrimLeft(line, " "))
			i = skipToLineEnd(s, i)
		case '&', '*':
			for i++; i < len(s) && !isYAMLSpace(s[i]) && strings.IndexByte(",[]{}", s[i]) < 0; i++ {
				if !asciiAlnum(s[i]) && s[i] != '_' && s[i] != '-' {
					return true
				}
			}
			i--
		}
	}
	return false
}

// skipToLineEnd is the offset of the last character before the line ending
// of the line s[i] is on, so that a loop's increment lands on the ending.
func skipToLineEnd(s string, i int) int {
	if nl := strings.IndexByte(s[i:], '\n'); nl >= 0 {
		return i + nl - 1
	}
	return len(s) - 1
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

// parseFrontmatterYAML parses text, or reports false wherever npm yaml would
// have reported an error or a warning.
//
// One more difference is handled here: an alias to an anchor that is never
// defined (or only later) is an error to yaml.v3 and nothing to npm yaml,
// which resolves aliases only when a value is converted. Each such alias is
// replaced by a null scalar of the same width, remembered, and the text
// parsed again, so a tags property that is one still counts as an alias.
func parseFrontmatterYAML(text string) (*yamlDoc, bool) {
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
	if d.root != nil && !d.check(d.root) {
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

// tagsNode is the value of the root mapping's tags property, or nil.
func (d *yamlDoc) tagsNode() *yaml.Node {
	if d.root == nil || d.root.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(d.root.Content); i += 2 {
		k := d.root.Content[i]
		if k.Kind != yaml.ScalarNode || d.text.isAlias(k) {
			continue
		}
		if v, ok := d.scalar(k); ok && v.kind == "string" && v.str == "tags" {
			return d.root.Content[i+1]
		}
	}
	return nil
}

// frontmatterTags is Basalt's frontTags over byte offsets.
func frontmatterTags(source string, f frame) ([]tagOcc, error) {
	if !f.present {
		return nil, nil
	}
	d, ok := parseFrontmatterYAML(source[f.start:f.end])
	if !ok || (d.root != nil && d.root.Kind != yaml.MappingNode) {
		return nil, refuse("invalid_frontmatter", "frontmatter must be an unambiguous YAML mapping")
	}
	node := d.tagsNode()
	if node == nil {
		return nil, nil
	}
	items := []*yaml.Node{node}
	if node.Kind == yaml.SequenceNode {
		items = node.Content
	}
	if (node.Kind == yaml.ScalarNode || node.Kind == yaml.SequenceNode) && node.Anchor != "" {
		return nil, refuse("invalid_frontmatter", "an anchored tags property needs an explicit note edit")
	}
	var found []tagOcc
	for _, item := range items {
		if item.Kind != yaml.ScalarNode || item.Anchor != "" || d.text.isAlias(item) {
			return nil, invalidTagsProperty()
		}
		v, ok := d.scalar(item)
		if !ok || (v.kind != "null" && v.kind != "string") {
			return nil, invalidTagsProperty()
		}
		if v.kind == "null" {
			continue
		}
		start, end := d.scalarRange(item, v.str)
		for _, value := range splitTags(v.str) {
			tag, err := ValidateTag(value)
			if err != nil {
				return nil, err
			}
			found = append(found, tagOcc{Tag: tag, start: f.start + start, end: f.start + end, location: "frontmatter"})
		}
	}
	return found, nil
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
