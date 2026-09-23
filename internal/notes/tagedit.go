package notes

import (
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

// MaxTagsPerCall is the most tags, and separately the most patterns, one tag
// operation names.
const MaxTagsPerCall = 100

// TagChange is one add_tags, remove_tags, manage_tags or rename_tag request
// as it applies to a note, the input of Basalt's changeTags.
type TagChange struct {
	// Operation is "add", "remove" or "rename".
	Operation string
	// Tags are the tags to add or to remove.
	Tags []string
	// Patterns select tags to remove by single-* globs, as TagPattern
	// matches them.
	Patterns []string
	// OldTag and NewTag are a rename's.
	OldTag, NewTag string
	// Location is "frontmatter", "content" or "both". Empty is
	// "frontmatter" for an addition and "both" otherwise.
	Location string
	// IncludeChildren makes a removal or a rename take the nested tags of
	// those it names ("a/b" for "a") as well.
	IncludeChildren bool
	// Position is where an addition writes content tags: "start", just after
	// the frontmatter, or "end" (the default).
	Position string
	// Normalization is how added tags and a rename's new tag are written:
	// "preserve" (the default), "lowercase" (NFC and lower case), or
	// "kebab" (a hyphen between a lower-case letter or a digit and the
	// capital after it, underscores as hyphens, then lower case).
	Normalization string
}

// TagEdit is what ChangeTags would do to one note.
type TagEdit struct {
	// Edits are the exact source edits, in UTF-16 offsets, frontmatter
	// first; applied with ApplySourceEdits they give the changed note.
	Edits []SourceEdit
	// Changed are the tags added, removed or renamed (a rename's old
	// spelling), each once, in the order they were met.
	Changed []string
}

// ChangeTags is Basalt's changeTags: the exact edits that add, remove or
// rename tags in one note, touching nothing else.
//
// In the frontmatter only the tags property's value is rewritten: its source
// range, as npm yaml gave it, becomes a flow sequence of JSON strings, and the
// comments inside that range move to the lines after it at the same
// indentation, so unrelated properties, comments, the byte-order mark and
// CRLF line endings are kept byte for byte. A tags property that does not
// exist is added at the end of the frontmatter, and frontmatter that does not
// exist is created after a byte-order mark. In the body, hashtags are those
// InlineTags finds, outside code, inline code, HTML, %% comments and links;
// an added content tag goes on a line of its own at the start of the body or
// at its end.
//
// Tags compare as MatchesTag compares them, NFC and lower case. The changed
// note is read again, and an addition refused (invalid_tag_location) unless
// every added tag is then found in each place asked for: text appended after
// an unclosed code fence is inside the code.
//
// Refusals, in Basalt's order: a tag that ValidateTag refuses, more than
// MaxTagsPerCall tags or patterns, a pattern TagPattern refuses, an addition
// with no tags or a removal with neither tags nor patterns, and a rename's
// old or new tag (all invalid_tag); then the note's frontmatter, as
// TagOccurrences refuses it (invalid_frontmatter, invalid_tag); a renamed tag
// that is no longer valid (invalid_tag); a changed note over NoteBytes
// (input_too_large); the changed note's frontmatter; and
// invalid_tag_location.
func ChangeTags(source string, c TagChange) (TagEdit, error) {
	normalize := func(value string) (string, error) {
		tag, err := ValidateTag(value)
		if err != nil {
			return "", err
		}
		switch c.Normalization {
		case "lowercase":
			return foldTag(tag), nil
		case "kebab":
			return kebabTag(tag), nil
		}
		return tag, nil
	}
	tags := make([]string, 0, len(c.Tags))
	for _, value := range c.Tags {
		tag, err := normalize(value)
		if err != nil {
			return TagEdit{}, err
		}
		tags = append(tags, tag)
	}
	if len(tags) > MaxTagsPerCall || len(c.Patterns) > MaxTagsPerCall {
		return TagEdit{}, refuse("invalid_tag", "at most 100 tags or patterns may be supplied")
	}
	for _, p := range c.Patterns {
		if _, err := TagPattern(p, ""); err != nil {
			return TagEdit{}, err
		}
	}
	add, remove, rename := c.Operation == "add", c.Operation == "remove", c.Operation == "rename"
	if add && len(tags) == 0 {
		return TagEdit{}, refuse("invalid_tag", "supply tags to add")
	}
	if remove && len(tags) == 0 && len(c.Patterns) == 0 {
		return TagEdit{}, refuse("invalid_tag", "supply tags or patterns to remove")
	}
	var old, next string
	if rename {
		var err error
		if old, err = ValidateTag(c.OldTag); err != nil {
			return TagEdit{}, err
		}
		if next, err = normalize(c.NewTag); err != nil {
			return TagEdit{}, err
		}
	}
	var changed []string
	seen := map[string]bool{}
	mark := func(tag string) {
		if !seen[tag] {
			seen[tag] = true
			changed = append(changed, tag)
		}
	}
	// transform is a tag after the change: its new spelling, or false when
	// it is removed.
	transform := func(tag string) (string, bool, error) {
		if rename && MatchesTag(tag, old, c.IncludeChildren) {
			mark(tag)
			renamed := next
			if children := strings.Split(tag, "/")[len(strings.Split(old, "/")):]; len(children) > 0 {
				renamed += "/" + strings.Join(children, "/")
			}
			t, err := ValidateTag(renamed)
			return t, true, err
		}
		if remove {
			hit := false
			for _, value := range tags {
				if MatchesTag(tag, value, c.IncludeChildren) {
					hit = true
					break
				}
			}
			for _, p := range c.Patterns {
				if hit {
					break
				}
				hit, _ = TagPattern(p, tag)
			}
			if hit {
				mark(tag)
				return "", false, nil
			}
		}
		return tag, true, nil
	}
	location := c.Location
	if location == "" {
		location = "both"
		if add {
			location = "frontmatter"
		}
	}
	f, err := findFrame(source)
	if err != nil {
		return TagEdit{}, err
	}
	fm, err := readFrontTags(source, f)
	if err != nil {
		return TagEdit{}, err
	}
	type byteEdit struct {
		start, end int
		text       string
	}
	var edits []byteEdit
	if location != "content" {
		var after, before []string
		for _, o := range fm.tags {
			before = append(before, o.Tag)
			t, kept, err := transform(o.Tag)
			if err != nil {
				return TagEdit{}, err
			}
			if kept {
				after = append(after, t)
			}
		}
		if add {
			for _, tag := range tags {
				present := false
				for _, value := range after {
					if MatchesTag(value, tag, false) {
						present = true
						break
					}
				}
				if !present {
					after = append(after, tag)
					mark(tag)
				}
			}
		}
		if !equalStrings(after, before) {
			value := string(appendJSStrings(nil, after))
			switch {
			case !f.present:
				text := "---" + f.newline + "tags: " + value + f.newline + "---" + f.newline
				edits = append(edits, byteEdit{f.bom, f.bom, text})
			case fm.node == nil:
				edits = append(edits, byteEdit{f.end, f.end, "tags: " + value + f.newline})
			default:
				start, end, comments, ok := fm.doc.valueSpan(fm.key, fm.node)
				if !ok {
					return TagEdit{}, refuse("invalid_frontmatter", "the tags source range is unavailable")
				}
				a, b := f.start+start, f.start+end
				// Serializing the whole frontmatter would rewrite unrelated
				// properties. Only the tags value changes; comments within
				// a block list stay beside it.
				line := strings.LastIndexByte(source[:a], '\n') + 1
				indent := source[line : line+spacesOrTabs(source[line:a])]
				suffix := ""
				for _, comment := range comments {
					suffix += f.newline + indent + comment
				}
				if strings.HasSuffix(source[a:b], "\n") {
					suffix += f.newline
				}
				text := value + suffix
				if a == b {
					text = " " + text
				}
				edits = append(edits, byteEdit{a, b, text})
			}
		}
	}
	if location != "frontmatter" {
		occurrences, err := inlineTags(source, f.body)
		if err != nil {
			return TagEdit{}, err
		}
		if add {
			var added []string
			for _, tag := range tags {
				present := false
				for _, o := range occurrences {
					if MatchesTag(o.Tag, tag, false) {
						present = true
						break
					}
				}
				if !present {
					added = append(added, tag)
				}
			}
			if len(added) > 0 {
				for _, tag := range added {
					mark(tag)
				}
				text := "#" + strings.Join(added, " #") + f.newline
				at := len(source)
				if c.Position == "start" {
					at = f.body
				}
				if at > f.body && !strings.HasSuffix(source, "\n") {
					text = f.newline + text
				}
				edits = append(edits, byteEdit{at, at, text})
			}
		} else {
			for _, o := range occurrences {
				t, kept, err := transform(o.Tag)
				if err != nil {
					return TagEdit{}, err
				}
				switch {
				case !kept:
					edits = append(edits, byteEdit{o.start, o.end, ""})
				case t != o.Tag:
					edits = append(edits, byteEdit{o.start, o.end, "#" + t})
				}
			}
		}
	}
	x := newUnitIndex(source)
	out := TagEdit{Changed: changed, Edits: make([]SourceEdit, len(edits))}
	for i, e := range edits {
		out.Edits[i] = SourceEdit{Start: x.at(e.start), End: x.at(e.end), Old: source[e.start:e.end], Text: e.text}
	}
	result, err := ApplySourceEdits(source, out.Edits)
	if err != nil {
		return TagEdit{}, err
	}
	actual, err := tagOccurrences(result)
	if err != nil {
		return TagEdit{}, err
	}
	if add {
		for _, tag := range tags {
			for _, place := range []string{"frontmatter", "content"} {
				if location != "both" && location != place {
					continue
				}
				found := false
				for _, o := range actual {
					if o.location == place && MatchesTag(o.Tag, tag, false) {
						found = true
						break
					}
				}
				if !found {
					return TagEdit{}, refuse("invalid_tag_location", "the insertion would place tags inside code or a comment; choose another position")
				}
			}
		}
	}
	return out, nil
}

// kebabTag is Basalt's kebab normalization,
// tag.replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1-$2").replace(/_+/gu, "-").toLowerCase():
// \d is an ASCII digit under the u flag, and each replacement consumes its
// two characters before the search goes on.
func kebabTag(tag string) string {
	rs := []rune(tag)
	var b strings.Builder
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		b.WriteRune(r)
		if i+1 < len(rs) && (unicode.Is(unicode.Ll, r) || '0' <= r && r <= '9') && unicode.Is(unicode.Lu, rs[i+1]) {
			b.WriteByte('-')
			b.WriteRune(rs[i+1])
			i++
		}
	}
	s := b.String()
	b.Reset()
	for i := 0; i < len(s); i++ {
		if s[i] != '_' {
			b.WriteByte(s[i])
			continue
		}
		b.WriteByte('-')
		for i+1 < len(s) && s[i+1] == '_' {
			i++
		}
	}
	return jsLower(b.String())
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// appendJSStrings appends JSON.stringify of a list of strings.
func appendJSStrings(b []byte, list []string) []byte {
	b = append(b, '[')
	for i, s := range list {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendJSString(b, s)
	}
	return append(b, ']')
}

// valueSpan is npm yaml's range for the tags property's value, the part of
// the frontmatter an edit rewrites: range[0] and range[1] as byte offsets in
// the frontmatter's YAML, and the source of every comment token that begins
// inside it (from its "#" to the end of its line, less a CR before the LF,
// as npm yaml's lexer cuts it). It is false where the value is not one npm
// yaml would have given a range to here.
//
// The range, by kind of value:
//
//   - An empty value is where npm yaml puts an empty scalar: after the ":"
//     indicator, the value's tag if it has one, and the spaces and tabs after
//     them. The range is empty.
//   - Any other scalar is scalarRange: its text, after its properties.
//   - A flow sequence runs from its "[" to after its "]".
//   - A block sequence runs from its first "-" to the end of its last item,
//     which npm yaml takes as that item's range[2]: after the spaces, the
//     comment and the line break that follow the item's text, or for an
//     empty item after its "-", unless the item's own start holds a comment,
//     when it runs over the blank and comment lines after it.
//
// Comments can begin only between the items, and in a block scalar's header.
func (d *yamlDoc) valueSpan(key, node *yaml.Node) (start, end int, comments []string, ok bool) {
	y := d.text
	s := y.original
	switch node.Kind {
	case yaml.ScalarNode:
		value := y.restore(node.Value)
		if emptyScalar(node, value) {
			p := d.emptyAfterKey(key)
			return p, p, nil, p >= 0
		}
		start, end = d.scalarRange(node, value)
		return start, end, commentsIn(s, start, end, d.itemRanges([]*yaml.Node{node})), true
	case yaml.SequenceNode:
		_, _, at := y.props(y.offset(node.Line, node.Column))
		items := d.itemRanges(node.Content)
		if node.Style&yaml.FlowStyle != 0 {
			if at < 0 || at >= len(s) || s[at] != '[' {
				return 0, 0, nil, false
			}
			end = flowSequenceEnd(s, at, items)
		} else {
			if at < 0 || at >= len(s) || s[at] != '-' {
				return 0, 0, nil, false
			}
			end = d.blockSequenceEnd(at, node.Content)
		}
		if end < 0 {
			return 0, 0, nil, false
		}
		return at, end, commentsIn(s, at, end, items), true
	}
	return 0, 0, nil, false
}

// emptyScalar reports whether a scalar node stands for no text at all: a
// plain scalar with an empty value, which yaml.v3 gives an absent value,
// tagged or not.
func emptyScalar(n *yaml.Node, value string) bool {
	return n.Style&^yaml.TaggedStyle == 0 && value == ""
}

// itemRanges are where the text of each item of a sequence is, to be skipped
// when looking for comments: a block scalar's from the line after its header,
// whose comment is the one a scalar can hold. Empty items have no text.
func (d *yamlDoc) itemRanges(items []*yaml.Node) []byteRange {
	s := d.text.original
	var out []byteRange
	for _, item := range items {
		value := d.text.restore(item.Value)
		if item.Kind != yaml.ScalarNode || emptyScalar(item, value) {
			continue
		}
		start, end := d.scalarRange(item, value)
		if style := item.Style &^ yaml.TaggedStyle; style == yaml.LiteralStyle || style == yaml.FoldedStyle {
			if nl := strings.IndexByte(s[start:end], '\n'); nl >= 0 {
				start += nl + 1
			} else {
				start = end
			}
		}
		out = append(out, byteRange{start, end})
	}
	return out
}

// commentsIn finds the comments that begin in s[from:to] outside skip, the
// sorted ranges of scalar text within it.
func commentsIn(s string, from, to int, skip []byteRange) []string {
	var out []string
	k := 0
	for i := from; i < to && i < len(s); {
		for k < len(skip) && skip[k].end <= i {
			k++
		}
		if k < len(skip) && skip[k].start <= i {
			i = skip[k].end
			continue
		}
		if s[i] != '#' {
			i++
			continue
		}
		end := commentEnd(s, i)
		out = append(out, s[i:end])
		i = end
	}
	return out
}

// commentEnd is where the comment that begins at s[i] ends: before the line
// feed that ends its line, and before a CR just ahead of that line feed.
func commentEnd(s string, i int) int {
	end := len(s)
	if nl := strings.IndexByte(s[i:], '\n'); nl >= 0 {
		end = i + nl
		if end > i && s[end-1] == '\r' {
			end--
		}
	}
	return end
}

// lineBreakAt is the length of the line break at s[i]: 2 for CRLF, 1 for LF,
// otherwise 0.
func lineBreakAt(s string, i int) int {
	switch {
	case strings.HasPrefix(s[i:], "\r\n"):
		return 2
	case strings.HasPrefix(s[i:], "\n"):
		return 1
	}
	return 0
}

// flowSequenceEnd is the offset after the "]" that closes the flow sequence
// opened at s[open], stepping over its items and its comments, or -1.
func flowSequenceEnd(s string, open int, items []byteRange) int {
	k := 0
	for i := open + 1; i < len(s); {
		for k < len(items) && items[k].end <= i {
			k++
		}
		if k < len(items) && items[k].start <= i {
			i = items[k].end
			continue
		}
		switch s[i] {
		case '#':
			i = commentEnd(s, i)
			continue
		case ']':
			return i + 1
		case '[', '{', '}':
			return -1
		}
		i++
	}
	return -1
}

// blockSequenceEnd is range[1] of the block sequence whose first "-" is at
// s[first]: its last item's range[2]. An empty item's "-" is found after the
// item before it, over blank lines and comments.
func (d *yamlDoc) blockSequenceEnd(first int, items []*yaml.Node) int {
	s := d.text.original
	indent := first - (strings.LastIndexByte(s[:first], '\n') + 1)
	end := first
	for i, item := range items {
		value := d.text.restore(item.Value)
		if item.Kind != yaml.ScalarNode {
			return -1
		}
		if !emptyScalar(item, value) {
			_, e := d.scalarRange(item, value)
			if style := item.Style &^ yaml.TaggedStyle; style == yaml.LiteralStyle || style == yaml.FoldedStyle {
				end = e
				continue
			}
			end = afterSpaces(s, e)
			if end < len(s) && s[end] == '#' {
				end = commentEnd(s, end)
			}
			end = indentedComments(s, end+lineBreakAt(s, end), indent)
			continue
		}
		// The item's start runs from the end of the item before, so a
		// comment between that and this "-" is in it.
		dash := first
		if i > 0 {
			dash = skipBlankAndComments(s, end)
		}
		if dash >= len(s) || s[dash] != '-' {
			return -1
		}
		comment := strings.IndexByte(s[end:dash], '#') >= 0
		end = afterProperties(s, afterSpaces(s, dash+1))
		// A comment in the item's start makes npm yaml end the item after
		// the blank and comment lines that follow, all of which that start
		// holds.
		at := end
		for {
			j := afterSpaces(s, at)
			if j < len(s) && s[j] == '#' {
				comment = true
				j = commentEnd(s, j)
			}
			if n := lineBreakAt(s, j); n > 0 {
				at = j + n
				continue
			}
			break
		}
		if comment {
			end = at
		}
	}
	return end
}

// indentedComments is where npm yaml ends a sequence item's text when comment
// lines indented further than the sequence (whose "-" is at column indent)
// follow it, from at, the end of the item's own line: after the last such
// line, and the blank lines before it. npm yaml's parser gives each such
// comment to the item before it (atIndentedComment), and the line break after
// a comment goes with the comment. Indentation counts the spaces before any
// tab, as npm yaml's does.
func indentedComments(s string, at, indent int) int {
	end := at
	for i := at; i < len(s); {
		next := len(s)
		if nl := strings.IndexByte(s[i:], '\n'); nl >= 0 {
			next = i + nl + 1
		}
		line := strings.TrimRight(s[i:next], "\r\n")
		text := strings.TrimLeft(line, " \t")
		switch {
		case text == "":
			i = next
			continue
		case text[0] == '#' && len(line)-len(strings.TrimLeft(line, " ")) > indent:
			c := commentEnd(s, i+len(line)-len(text))
			end = c + lineBreakAt(s, c)
			i = end
			continue
		}
		break
	}
	return end
}

// emptyAfterKey is where npm yaml puts the empty value of the mapping entry
// whose key is key: after the ":" indicator that follows the key (over line
// breaks and comments, for an explicit key), the spaces and tabs after it,
// and any tag or anchor on the same line with its spaces. It is -1 when no
// indicator follows the key.
func (d *yamlDoc) emptyAfterKey(key *yaml.Node) int {
	s := d.text.original
	_, i := d.scalarRange(key, d.text.restore(key.Value))
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\n', '\r':
			i++
			continue
		case '#':
			i = commentEnd(s, i)
			continue
		}
		break
	}
	if i >= len(s) || s[i] != ':' {
		return -1
	}
	return afterProperties(s, afterSpaces(s, i+1))
}

// afterProperties is the offset after the tags and anchors that begin at
// s[i] on one line, each with the spaces and tabs after it.
func afterProperties(s string, i int) int {
	for i < len(s) && (s[i] == '!' || s[i] == '&') {
		i = afterSpaces(s, propertyEnd(s, i))
	}
	return i
}

func afterSpaces(s string, i int) int { return i + spacesOrTabs(s[i:]) }

// skipBlankAndComments is the offset of the first character at or after
// s[i] that is not a space, a tab, a line break or part of a comment.
func skipBlankAndComments(s string, i int) int {
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\n', '\r':
			i++
			continue
		case '#':
			i = commentEnd(s, i)
			continue
		}
		break
	}
	return i
}
