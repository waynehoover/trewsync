package notes

import (
	"sort"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Basalt found code, HTML and links with micromark (through
// mdast-util-from-markdown, CommonMark with no extensions). This file finds the
// same things with goldmark, also plain CommonMark. goldmark's AST records
// where most nodes start but not where they end, so the parsers that produce
// the nodes Basalt hides are wrapped (or, for links, copied) to record both
// ends as they consume the source.
//
// Where the two parsers disagree about what is code, HTML or a link, Basalt's
// answer is the specification. The known disagreements, each with a test in
// markdown_test.go:
//
//   - A lone carriage return ends a line for micromark and not for goldmark,
//     so goldmark is given a copy with each lone CR turned into LF. The byte
//     offsets are unchanged.
//   - Link destinations and titles: see goldmark_link.go.
//
// Range ends inside trailing whitespace are not always where micromark puts
// them (it sometimes keeps a closing line ending in a code block, and a
// definition's trailing spaces). No consumer can tell: every use asks whether
// a "#", a "%%" or a link begins inside a range, and none of those begins
// with whitespace.

// markdownRecord is what the wrapped parsers write down during one parse.
type markdownRecord struct {
	spans       map[ast.Node]byteRange // inline nodes: code spans, autolinks, raw HTML
	fenceStarts map[ast.Node]int       // fenced code blocks: where the opening fence starts
	fenceEnds   map[ast.Node]int       // fenced code blocks: end of the last line they hold
	links       []linkRecord           // inline links, images and definitions
	definitions map[ast.Node]bool
	lazyChains  map[ast.Node][]ast.Node // HTML blocks opened on a lazy line: the containers it left
}

// linkRecord is one link, image or definition: its whole extent and its
// destination string (start < 0 when it has none).
type linkRecord struct {
	node        ast.Node
	whole, dest byteRange
}

var markdownRecordKey = parser.NewContextKey()

func recordOf(pc parser.Context) *markdownRecord {
	if r, ok := pc.Get(markdownRecordKey).(*markdownRecord); ok {
		return r
	}
	return nil
}

func recordLink(pc parser.Context, n ast.Node, whole, dest byteRange) {
	if r := recordOf(pc); r != nil {
		r.links = append(r.links, linkRecord{node: n, whole: whole, dest: dest})
	}
}

func recordDefinition(pc parser.Context, n ast.Node, start int, dest byteRange) {
	if r := recordOf(pc); r != nil {
		r.definitions[n] = true
		r.links = append(r.links, linkRecord{node: n, whole: byteRange{start, -1}, dest: dest})
	}
}

// spanParser wraps an inline parser and records the extent of every node of
// the kinds Basalt hides that it returns.
type spanParser struct{ parser.InlineParser }

func (s spanParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	_, before := block.Position()
	n := s.InlineParser.Parse(parent, block, pc)
	switch n.(type) {
	case *ast.CodeSpan, *ast.AutoLink, *ast.RawHTML:
		if r := recordOf(pc); r != nil {
			_, after := block.Position()
			r.spans[n] = byteRange{before.Start, after.Start}
		}
	}
	return n
}

// fenceParser wraps the fenced code block parser and records where each
// block's opening fence starts and where the last line it holds ends, the
// closing fence's when there is one; goldmark keeps only the lines between
// the fences, and its Pos for a fence that follows part of a tab consumed by
// a container is off by the rest of the tab.
type fenceParser struct{ parser.BlockParser }

func (f fenceParser) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	_, seg := reader.PeekLine()
	offset := pc.BlockOffset()
	n, state := f.BlockParser.Open(parent, reader, pc)
	if n != nil {
		if r := recordOf(pc); r != nil {
			r.fenceStarts[n] = seg.Start + max(offset, 0) - seg.Padding
			r.fenceEnds[n] = lineEnd(reader.Source(), seg)
		}
	}
	return n, state
}

func (f fenceParser) Continue(node ast.Node, reader text.Reader, pc parser.Context) parser.State {
	_, seg := reader.PeekLine()
	state := f.BlockParser.Continue(node, reader, pc)
	if r := recordOf(pc); r != nil && seg.Start >= 0 {
		r.fenceEnds[node] = max(r.fenceEnds[node], lineEnd(reader.Source(), seg))
	}
	return state
}

// lineEnd is where the text of a line segment ends, before its line ending
// and trailing spaces.
func lineEnd(source []byte, seg text.Segment) int {
	end := seg.Stop
	for end > seg.Start && util.IsSpace(source[end-1]) {
		end--
	}
	return end
}

var markdownParser = newMarkdownParser()

func newMarkdownParser() parser.Parser {
	var blocks []util.PrioritizedValue
	for _, b := range parser.DefaultBlockParsers() {
		switch p := b.Value.(parser.BlockParser); p {
		case parser.NewFencedCodeBlockParser():
			b.Value = fenceParser{p}
		case parser.NewHTMLBlockParser():
			b.Value = htmlFlowParser{p}
		case parser.NewListParser():
			b.Value = listStartParser{p}
		}
		blocks = append(blocks, b)
	}
	inlines := []util.PrioritizedValue{
		util.Prioritized(spanParser{parser.NewCodeSpanParser()}, 100),
		util.Prioritized(&mdLinkParser{}, 200),
		util.Prioritized(spanParser{parser.NewAutoLinkParser()}, 300),
		util.Prioritized(spanParser{parser.NewRawHTMLParser()}, 400),
		util.Prioritized(parser.NewEmphasisParser(), 500),
	}
	return parser.NewParser(
		parser.WithBlockParsers(blocks...),
		parser.WithInlineParsers(inlines...),
		parser.WithParagraphTransformers(util.Prioritized(&mdDefinitionTransformer{}, 100)),
	)
}

// markdownDocument is one parse of a note's body.
type markdownDocument struct {
	src    []byte // the body as goldmark saw it
	orig   string // the body as it is
	offset int    // where the body starts in the note, in bytes
	root   ast.Node
	record *markdownRecord
}

// parseMarkdown parses source[start:] as CommonMark.
func parseMarkdown(source string, start int) *markdownDocument {
	// micromark drops a byte-order mark at the start of what it parses, and
	// Basalt parsed a note's body alone, so a body that begins with one (after
	// frontmatter) is parsed as if it did not. goldmark would read the mark as
	// text and could miss a fence or a heading on that line. Parsing from
	// after it gives micromark's structure at the true offsets (micromark's
	// are one unit short there: see oracleBugs in oracle_test.go).
	if strings.HasPrefix(source[start:], "\ufeff") {
		start += len("\ufeff")
	}
	src := []byte(source[start:])
	// micromark ends a line at a lone CR, and takes CRLF as one line ending;
	// goldmark ends lines only at LF and reads the CR of a CRLF as a character
	// of the line, so that "-\r\n" is not an empty list item to it. A lone CR
	// becomes LF and the CR of a CRLF a space: one byte for one, so offsets
	// are unchanged, and a trailing space is nothing to any block rule.
	for i, c := range src {
		if c == '\r' {
			if i+1 < len(src) && src[i+1] == '\n' {
				src[i] = ' '
			} else {
				src[i] = '\n'
			}
		}
	}
	rec := &markdownRecord{
		spans:       map[ast.Node]byteRange{},
		fenceStarts: map[ast.Node]int{},
		fenceEnds:   map[ast.Node]int{},
		definitions: map[ast.Node]bool{},
		lazyChains:  map[ast.Node][]ast.Node{},
	}
	pc := parser.NewContext()
	pc.Set(markdownRecordKey, rec)
	root := markdownParser.Parse(text.NewReader(src), parser.WithContext(pc))
	return &markdownDocument{src: src, orig: source[start:], offset: start, root: root, record: rec}
}

// hidden returns the extents, in note byte offsets, of the nodes Basalt's
// markdownHidden hides: code blocks, inline code and HTML, and with
// protectLinks inline links, images and definitions too.
func (d *markdownDocument) hidden(protectLinks bool) []byteRange {
	var out []byteRange
	add := func(r byteRange) {
		if r.start >= 0 && r.end >= r.start {
			out = append(out, byteRange{r.start + d.offset, r.end + d.offset})
		}
	}
	_ = ast.Walk(d.root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n := n.(type) {
		case *ast.FencedCodeBlock:
			add(byteRange{d.record.fenceStarts[n], d.record.fenceEnds[n]})
		case *ast.CodeBlock:
			add(linesRange(d.src, n.Lines()))
		case *ast.HTMLBlock:
			r := linesRange(d.src, n.Lines())
			if n.HasClosure() {
				r.end = max(r.end, lineEnd(d.src, n.ClosureLine))
			}
			add(r)
		case *ast.CodeSpan, *ast.RawHTML:
			if r, ok := d.record.spans[n]; ok {
				add(r)
			}
		case *ast.AutoLink:
			// An autolink is a link node to mdast, hidden only with links.
			if r, ok := d.record.spans[n]; ok && protectLinks {
				add(r)
			}
		}
		return ast.WalkContinue, nil
	})
	if protectLinks {
		for _, l := range d.record.links {
			if w := d.whole(l); w.start >= 0 && d.present(l.node) {
				add(w)
			}
		}
	}
	return out
}

// whole is a link record's extent, or start -1 for a reference link, which
// Basalt neither hides nor rewrites. A definition runs to the end of its last
// line, trailing spaces and tabs included as micromark includes them, which
// goldmark only knows once the paragraph transformer has run.
func (d *markdownDocument) whole(l linkRecord) byteRange {
	if !d.record.definitions[l.node] {
		if link, ok := l.node.(*ast.Link); ok && link.Reference != nil {
			return byteRange{-1, -1}
		}
		if image, ok := l.node.(*ast.Image); ok && image.Reference != nil {
			return byteRange{-1, -1}
		}
		return l.whole
	}
	lines := l.node.Lines()
	if lines.Len() == 0 {
		return byteRange{-1, -1}
	}
	end := lineEnd(d.src, lines.At(lines.Len()-1))
	for end < len(d.orig) && (d.orig[end] == ' ' || d.orig[end] == '\t') {
		end++
	}
	return byteRange{l.whole.start, end}
}

// present reports whether a recorded node survived into the final tree;
// goldmark can build a link and later drop it.
func (d *markdownDocument) present(n ast.Node) bool {
	for p := n; p != nil; p = p.Parent() {
		if p == d.root {
			return true
		}
	}
	return false
}

// linesRange is the extent of a block's lines, from the first line's first
// character to the last line's last non-space character.
func linesRange(src []byte, lines *text.Segments) byteRange {
	if lines == nil || lines.Len() == 0 {
		return byteRange{-1, -1}
	}
	first, last := lines.At(0), lines.At(lines.Len()-1)
	return byteRange{first.Start, max(first.Start, lineEnd(src, last))}
}

// markdownHidden is Basalt's markdownHidden over byte offsets: the merged
// ranges of source, from start, that hidden nodes and %% comments cover. A
// %% that begins inside code or HTML (or, with protectLinks, a link) opens
// no comment; a comment runs to the next %% wherever that is, or to the end.
func markdownHidden(source string, start int, protectLinks bool) []byteRange {
	d := parseMarkdown(source, start)
	hidden := d.hidden(protectLinks)
	protected := mergeRanges(hidden)
	index := 0
	for at := indexFrom(source, "%%", start); at >= 0; {
		for index < len(protected) && protected[index].end <= at {
			index++
		}
		if index < len(protected) && at >= protected[index].start {
			at = indexFrom(source, "%%", at+2)
			continue
		}
		end := len(source)
		if close := indexFrom(source, "%%", at+2); close >= 0 {
			end = close + 2
		}
		hidden = append(hidden, byteRange{at, end})
		at = indexFrom(source, "%%", end)
	}
	return mergeRanges(hidden)
}

// indexFrom is String.prototype.indexOf(sub, from).
func indexFrom(s, sub string, from int) int {
	if from > len(s) {
		return -1
	}
	i := strings.Index(s[from:], sub)
	if i < 0 {
		return -1
	}
	return from + i
}

// Range is a half-open range of UTF-16 offsets into a note.
type Range struct{ Start, End int }

// MarkdownHidden is Basalt's markdownHidden: the ranges of the note, from
// UTF-16 offset start, that tags and links are not looked for in, merged and
// in order.
func MarkdownHidden(source string, start int, protectLinks bool) []Range {
	x := newUnitIndex(source)
	ranges := markdownHidden(source, byteAtUnit(source, start), protectLinks)
	out := make([]Range, len(ranges))
	for i, r := range ranges {
		out[i] = Range{x.at(r.start), x.at(r.end)}
	}
	return out
}

func sortRanges(r []byteRange) {
	sort.SliceStable(r, func(i, j int) bool { return r[i].start < r[j].start })
}
