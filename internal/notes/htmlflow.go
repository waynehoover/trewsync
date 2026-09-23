package notes

import (
	"bytes"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// HTML blocks start where micromark says they start. goldmark's start
// conditions differ from micromark's (html-flow.js) in ways the oracle
// found, and an HTML block hides everything in it, so goldmark's own HTML
// block parser is asked only to continue and close blocks this file opens.
// The differences, each with a test in markdown_test.go:
//
//   - A closing tag of a raw element (</script>, </pre>, </style>) alone on
//     its line starts a type 7 block to micromark; goldmark refuses those
//     names for type 7 whether opening or closing.
//   - <script/> and the other raw names written self-closing are type 7 to
//     micromark and type 1 (ended only by a closing tag) to goldmark.
//   - A declaration may begin with any ASCII letter (<!doctype); goldmark
//     wants a capital.
//   - A tab may follow the tag name of a type 6 block; goldmark wants a
//     space.
//   - "</ div>" starts nothing to micromark and a type 6 block to goldmark.
//   - "meta" is not a type 6 name to micromark.

// htmlRawNames and htmlBlockNames are micromark-util-html-tag-name's lists.
var (
	htmlRawNames   = map[string]bool{"pre": true, "script": true, "style": true, "textarea": true}
	htmlBlockNames = map[string]bool{}
)

func init() {
	for _, n := range strings.Fields(`address article aside base basefont blockquote body caption center col
		colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset
		h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol
		optgroup option p param search section summary table tbody td tfoot th thead title tr track ul`) {
		htmlBlockNames[n] = true
	}
}

func asciiAlpha(c byte) bool { return 'a' <= c|0x20 && c|0x20 <= 'z' }
func asciiAlnum(c byte) bool { return asciiAlpha(c) || '0' <= c && c <= '9' }

// htmlFlowKind is micromark's html-flow start: which kind of HTML block (1 to
// 7, CommonMark's numbering) a line opens when s is the line from its "<",
// or 0. When interrupting a paragraph a complete tag (kind 7) opens nothing.
func htmlFlowKind(s []byte, interrupt bool) int {
	s = bytes.TrimRight(s, "\r\n")
	if len(s) < 2 || s[0] != '<' {
		return 0
	}
	switch {
	case s[1] == '!':
		switch {
		case len(s) > 3 && s[2] == '-' && s[3] == '-':
			return 2
		case bytes.HasPrefix(s[2:], []byte("[CDATA[")):
			return 5
		case len(s) > 2 && asciiAlpha(s[2]):
			return 4
		}
		return 0
	case s[1] == '?':
		return 3
	}
	i, closing := 1, false
	if s[1] == '/' {
		i, closing = 2, true
	}
	if i >= len(s) || !asciiAlpha(s[i]) {
		return 0
	}
	start := i
	for i < len(s) && (asciiAlnum(s[i]) || s[i] == '-') {
		i++
	}
	if i < len(s) && s[i] != '/' && s[i] != '>' && s[i] != ' ' && s[i] != '\t' {
		return 0
	}
	name := strings.ToLower(string(s[start:i]))
	slash := i < len(s) && s[i] == '/'
	if !slash && !closing && htmlRawNames[name] {
		return 1
	}
	if htmlBlockNames[name] {
		if slash && !(i+1 < len(s) && s[i+1] == '>') {
			return 0
		}
		return 6
	}
	if interrupt {
		return 0
	}
	if closing {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		return completeTagEnd(s, i)
	}
	return completeAttributes(s, i)
}

// completeAttributes is micromark's attribute states for a complete open tag,
// from completeAttributeNameBefore at s[i], state for state.
func completeAttributes(s []byte, i int) int {
	space := func(c byte) bool { return c == ' ' || c == '\t' }
	const (
		nameBefore = iota
		nameAfter
		valueBefore
	)
	state := nameBefore
	for {
		switch state {
		case nameBefore:
			for i < len(s) && space(s[i]) {
				i++
			}
			if i < len(s) && s[i] == '/' {
				return completeTagEnd(s, i+1)
			}
			if i >= len(s) || !(s[i] == ':' || s[i] == '_' || asciiAlpha(s[i])) {
				return completeTagEnd(s, i)
			}
			for i < len(s) && (s[i] == '-' || s[i] == '.' || s[i] == ':' || s[i] == '_' || asciiAlnum(s[i])) {
				i++
			}
			state = nameAfter
		case nameAfter:
			for i < len(s) && space(s[i]) {
				i++
			}
			if i < len(s) && s[i] == '=' {
				i++
				state = valueBefore
			} else {
				state = nameBefore
			}
		case valueBefore:
			for i < len(s) && space(s[i]) {
				i++
			}
			if i >= len(s) || strings.IndexByte("<=>`", s[i]) >= 0 {
				return 0
			}
			if q := s[i]; q == '"' || q == '\'' {
				end := bytes.IndexByte(s[i+1:], q)
				if end < 0 {
					return 0
				}
				i += end + 2
				// completeAttributeValueQuotedAfter
				if i >= len(s) || (s[i] != '/' && s[i] != '>' && !space(s[i])) {
					return 0
				}
				state = nameBefore
				continue
			}
			for i < len(s) && strings.IndexByte("\"'/<=>` \t", s[i]) < 0 {
				i++
			}
			state = nameAfter
		}
	}
}

// completeTagEnd is micromark's completeEnd and completeAfter: ">" at s[i],
// then only spaces and tabs to the end of the line.
func completeTagEnd(s []byte, i int) int {
	if i >= len(s) || s[i] != '>' {
		return 0
	}
	for i++; i < len(s); i++ {
		if s[i] != ' ' && s[i] != '\t' {
			return 0
		}
	}
	return 7
}

// htmlFlowParser opens HTML blocks by micromark's rules and leaves goldmark's
// parser to continue and close them, which it does by kind, as micromark
// does.
type htmlFlowParser struct{ parser.BlockParser }

func (h htmlFlowParser) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	line, segment := reader.PeekLine()
	pos := pc.BlockOffset()
	if pos < 0 || pos >= len(line) {
		return nil, parser.NoChildren
	}
	interrupt := ast.IsParagraph(pc.LastOpenedBlock().Node)
	kind := htmlFlowKind(line[pos:], interrupt)
	if kind == 0 {
		return nil, parser.NoChildren
	}
	node := ast.NewHTMLBlock(ast.HTMLBlockType(kind))
	reader.AdvanceToEOL()
	node.Lines().Append(segment)
	return node, parser.NoChildren
}

// listStartParser is goldmark's list parser with micromark's rule for a list
// that interrupts: it may not start empty, nor with an ordered number other
// than a single 1. CommonMark and goldmark apply that rule to a list that
// interrupts a paragraph in the same container. micromark applies it more
// widely, and Basalt's answer is the specification:
//
//   - to a list that starts inside a container opened on the same line
//     (">-" after a paragraph line is a quote holding the text "-", not an
//     empty list);
//   - to a list that starts while an indented code block is still open, on
//     the next line or after blank lines, until a line that is not indented.
type listStartParser struct{ parser.BlockParser }

func (l listStartParser) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	if line, _ := reader.PeekLine(); interruptedFlow(parent, reader) {
		if pos := pc.BlockOffset(); pos >= 0 && pos < len(line) && !listMayInterrupt(line[pos:]) {
			return nil, parser.NoChildren
		}
	}
	return l.BlockParser.Open(parent, reader, pc)
}

// interruptedFlow reports whether a block opening on this line interrupts,
// as micromark sees it: the last block before this line, in the containers
// this line continued, is an indented code block, or a paragraph whose last
// line is the line before. Containers opened on this line are looked
// through.
func interruptedFlow(parent ast.Node, reader text.Reader) bool {
	_, seg := reader.PeekLine()
	src := reader.Source()
	if seg.Start < 0 || seg.Start > len(src) {
		return false
	}
	lineStart := bytes.LastIndexByte(src[:seg.Start], '\n') + 1
	c := parent
	var prev ast.Node
	for c != nil && c.Kind() != ast.KindDocument && c.Pos() >= lineStart {
		if p := c.PreviousSibling(); p != nil {
			prev = p
			break
		}
		c = c.Parent()
	}
	if prev == nil && c != nil {
		prev = c.LastChild()
	}
	switch b := prev.(type) {
	case *ast.CodeBlock:
		return true
	case *ast.Paragraph:
		lines := b.Lines()
		return lines.Len() > 0 && lines.At(lines.Len()-1).Stop >= lineStart
	}
	return false
}

// listMayInterrupt is whether a list item that starts s may interrupt: it is
// not empty, and an ordered one is numbered with the single digit 1.
func listMayInterrupt(s []byte) bool {
	i := 0
	switch {
	case s[0] == '*' || s[0] == '+' || s[0] == '-':
		i = 1
	case '0' <= s[0] && s[0] <= '9':
		if s[0] != '1' || len(s) < 2 || (s[1] != '.' && s[1] != ')') {
			return false
		}
		i = 2
	default:
		return true
	}
	return len(bytes.TrimSpace(s[i:])) > 0
}
