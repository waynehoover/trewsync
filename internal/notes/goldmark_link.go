package notes

// This file is goldmark's link parser and link reference definition
// transformer (github.com/yuin/goldmark v1.8.6, parser/link.go and
// parser/link_ref.go), copied so that two things can change:
//
//  1. It records where each inline link, image and definition begins and
//     ends, and where its destination is, which goldmark's AST does not keep.
//  2. Its destinations and titles follow micromark, the parser Basalt used,
//     where goldmark is more lenient. Each patch is marked "micromark:" below
//     and has a divergence test in markdown_test.go.
//
// Everything else is goldmark's, so emphasis, bracket matching and
// references keep its CommonMark behaviour.
//
// goldmark's licence, which applies to the copied code:
//
// MIT License
//
// Copyright (c) 2019 Yusuke Inuzuka
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import (
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

var mdLinkLabelStateKey = parser.NewContextKey()

type mdLinkLabelState struct {
	ast.BaseInline

	Segment text.Segment

	IsImage bool

	Prev *mdLinkLabelState

	Next *mdLinkLabelState

	First *mdLinkLabelState

	Last *mdLinkLabelState
}

func newMDLinkLabelState(segment text.Segment, isImage bool) *mdLinkLabelState {
	return &mdLinkLabelState{
		Segment: segment,
		IsImage: isImage,
	}
}

func (s *mdLinkLabelState) Text(source []byte) []byte {
	return s.Segment.Value(source)
}

func (s *mdLinkLabelState) Dump(source []byte, level int) {}

var kindMDLinkLabelState = ast.NewNodeKind("TelimusLinkLabelState")

func (s *mdLinkLabelState) Kind() ast.NodeKind {
	return kindMDLinkLabelState
}

func mdLinkLabelStateLength(v *mdLinkLabelState) int {
	if v == nil || v.Last == nil || v.First == nil {
		return 0
	}
	return v.Last.Segment.Stop - v.First.Segment.Start
}

func pushMDLinkLabelState(pc parser.Context, v *mdLinkLabelState) {
	tlist := pc.Get(mdLinkLabelStateKey)
	var list *mdLinkLabelState
	if tlist == nil {
		list = v
		v.First = v
		v.Last = v
		pc.Set(mdLinkLabelStateKey, list)
	} else {
		list = tlist.(*mdLinkLabelState)
		l := list.Last
		list.Last = v
		l.Next = v
		v.Prev = l
	}
}

func removeMDLinkLabelState(pc parser.Context, d *mdLinkLabelState) {
	tlist := pc.Get(mdLinkLabelStateKey)
	var list *mdLinkLabelState
	if tlist == nil {
		return
	}
	list = tlist.(*mdLinkLabelState)

	if d.Prev == nil {
		list = d.Next
		if list != nil {
			list.First = d
			list.Last = d.Last
			list.Prev = nil
			pc.Set(mdLinkLabelStateKey, list)
		} else {
			pc.Set(mdLinkLabelStateKey, nil)
		}
	} else {
		d.Prev.Next = d.Next
		if d.Next != nil {
			d.Next.Prev = d.Prev
		}
	}
	if list != nil && d.Next == nil {
		list.Last = d.Prev
	}
	d.Next = nil
	d.Prev = nil
	d.First = nil
	d.Last = nil
}

type mdLinkParser struct{}

func (s *mdLinkParser) Trigger() []byte {
	return []byte{'!', '[', ']'}
}

var mdLinkBottom = parser.NewContextKey()

func (s *mdLinkParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, segment := block.PeekLine()
	if line[0] == '!' {
		if len(line) > 1 && line[1] == '[' {
			block.Advance(1)
			pushMDLinkBottom(pc)
			return processMDLinkLabelOpen(block, segment.Start+1, true, pc)
		}
		return nil
	}
	if line[0] == '[' {
		pushMDLinkBottom(pc)
		return processMDLinkLabelOpen(block, segment.Start, false, pc)
	}

	// line[0] == ']'
	tlist := pc.Get(mdLinkLabelStateKey)
	if tlist == nil {
		return nil
	}
	last := tlist.(*mdLinkLabelState).Last
	if last == nil {
		_ = popMDLinkBottom(pc)
		return nil
	}
	block.Advance(1)
	removeMDLinkLabelState(pc, last)
	// CommonMark spec says:
	//  > A link label can have at most 999 characters inside the square brackets.
	if mdLinkLabelStateLength(tlist.(*mdLinkLabelState)) > 998 {
		ast.MergeOrReplaceTextSegment(last.Parent(), last, last.Segment)
		_ = popMDLinkBottom(pc)
		return nil
	}

	if !last.IsImage && s.containsLink(last) { // a link in a link text is not allowed
		ast.MergeOrReplaceTextSegment(last.Parent(), last, last.Segment)
		_ = popMDLinkBottom(pc)
		return nil
	}

	c := block.Peek()
	l, pos := block.Position()
	var link *ast.Link
	var hasValue bool
	destination := byteRange{-1, -1}
	switch c {
	case '(':
		link, destination = s.parseLink(parent, last, block, pc)
	case '[':
		link, hasValue = s.parseReferenceLink(parent, last, block, pc)
		if link == nil && hasValue {
			ast.MergeOrReplaceTextSegment(last.Parent(), last, last.Segment)
			_ = popMDLinkBottom(pc)
			return nil
		}
	}

	if link == nil {
		// A reference link has no destination of its own: forget the one a
		// failed inline attempt may have read.
		destination = byteRange{-1, -1}
		// maybe shortcut reference link
		block.SetPosition(l, pos)
		ssegment := text.NewSegment(last.Segment.Stop, segment.Start)
		maybeReference := block.Value(ssegment)
		// CommonMark spec says:
		//  > A link label can have at most 999 characters inside the square brackets.
		if len(maybeReference) > 999 {
			ast.MergeOrReplaceTextSegment(last.Parent(), last, last.Segment)
			_ = popMDLinkBottom(pc)
			return nil
		}

		ref, ok := pc.Reference(util.ToLinkReference(maybeReference))
		if !ok {
			ast.MergeOrReplaceTextSegment(last.Parent(), last, last.Segment)
			_ = popMDLinkBottom(pc)
			return nil
		}
		link = ast.NewLink()
		s.processLinkLabel(parent, link, last, pc)
		link.Title = ref.Title()
		link.Destination = ref.Destination()
		link.Reference = ast.NewReferenceLink(ast.ReferenceLinkShortcut, maybeReference)
	}
	var n ast.Node
	if last.IsImage {
		last.Parent().RemoveChild(last.Parent(), last)
		n = ast.NewImage(link)
	} else {
		last.Parent().RemoveChild(last.Parent(), last)
		n = link
	}
	n.(interface{ SetPos(int) }).SetPos(last.Segment.Start)
	_, end := block.Position()
	recordLink(pc, n, byteRange{last.Segment.Start, end.Start}, destination)
	return n
}

func (s *mdLinkParser) containsLink(n ast.Node) bool {
	if n == nil {
		return false
	}
	for c := n; c != nil; c = c.NextSibling() {
		if _, ok := c.(*ast.Link); ok {
			return true
		}
		if s.containsLink(c.FirstChild()) {
			return true
		}
	}
	return false
}

func processMDLinkLabelOpen(block text.Reader, pos int, isImage bool, pc parser.Context) *mdLinkLabelState {
	start := pos
	if isImage {
		start--
	}
	state := newMDLinkLabelState(text.NewSegment(start, pos+1), isImage)
	pushMDLinkLabelState(pc, state)
	block.Advance(1)
	return state
}

func (s *mdLinkParser) processLinkLabel(parent ast.Node, link *ast.Link, last *mdLinkLabelState, pc parser.Context) {
	bottom := popMDLinkBottom(pc)
	parser.ProcessDelimiters(bottom, pc)
	for c := last.NextSibling(); c != nil; {
		next := c.NextSibling()
		parent.RemoveChild(parent, c)
		link.AppendChild(link, c)
		c = next
	}
}

var mdLinkFindClosureOptions text.FindClosureOptions = text.FindClosureOptions{
	Nesting: false,
	Newline: true,
	Advance: true,
}

func (s *mdLinkParser) parseReferenceLink(parent ast.Node, last *mdLinkLabelState,
	block text.Reader, pc parser.Context) (*ast.Link, bool) {
	_, orgpos := block.Position()
	block.Advance(1) // skip '['
	segments, found := block.FindClosure('[', ']', mdLinkFindClosureOptions)
	if !found {
		return nil, false
	}

	var maybeReference []byte
	refType := ast.ReferenceLinkFull
	if segments.Len() == 1 { // avoid allocate a new byte slice
		maybeReference = block.Value(segments.At(0))
	} else {
		maybeReference = []byte{}
		for i := range segments.Len() {
			s := segments.At(i)
			maybeReference = append(maybeReference, block.Value(s)...)
		}
	}
	if util.IsBlank(maybeReference) { // collapsed reference link
		s := text.NewSegment(last.Segment.Stop, orgpos.Start-1)
		maybeReference = block.Value(s)
		refType = ast.ReferenceLinkCollapsed
	}
	// CommonMark spec says:
	//  > A link label can have at most 999 characters inside the square brackets.
	if len(maybeReference) > 999 {
		return nil, true
	}

	ref, ok := pc.Reference(util.ToLinkReference(maybeReference))
	if !ok {
		return nil, true
	}

	link := ast.NewLink()
	s.processLinkLabel(parent, link, last, pc)
	link.Title = ref.Title()
	link.Destination = ref.Destination()
	link.Reference = ast.NewReferenceLink(refType, maybeReference)
	return link, true
}

func (s *mdLinkParser) parseLink(parent ast.Node, last *mdLinkLabelState, block text.Reader,
	pc parser.Context) (*ast.Link, byteRange) {
	block.Advance(1) // skip '('
	skipMDSpaces(block)
	var title []byte
	var destination []byte
	var ok bool
	span := byteRange{-1, -1}
	if block.Peek() == ')' { // empty link like '[link]()'
		block.Advance(1)
	} else {
		destination, span, ok = parseMDLinkDestination(block, 32)
		if !ok {
			return nil, span
		}
		spaces := skipMDSpaces(block)
		if block.Peek() == ')' {
			block.Advance(1)
		} else {
			// micromark: a title must be separated from the destination by
			// whitespace. goldmark accepts [a](<b>"t").
			if spaces == 0 {
				return nil, span
			}
			title, ok = parseMDLinkTitle(block)
			if !ok {
				return nil, span
			}
			skipMDSpaces(block)
			if block.Peek() == ')' {
				block.Advance(1)
			} else {
				return nil, span
			}
		}
	}

	link := ast.NewLink()
	s.processLinkLabel(parent, link, last, pc)
	link.Destination = destination
	link.Title = title
	return link, span
}

// parseMDLinkDestination is goldmark's parseLinkDestination with micromark's
// rules, and it also returns the absolute range of the destination string:
// inside the angle brackets of an enclosed destination (empty for "<>"), or
// the whole of a raw one. balanceMax limits the nesting of parentheses in a
// raw destination; micromark allows 32 levels in a link and any number in a
// definition (0 here).
func parseMDLinkDestination(block text.Reader, balanceMax int) ([]byte, byteRange, bool) {
	skipMDSpaces(block)
	line, segment := block.PeekLine()
	offset := segment.Start - segment.Padding
	if block.Peek() == '<' {
		i := 1
		for i < len(line) {
			c := line[i]
			// micromark: only <, > and \ are escaped inside angle brackets;
			// any other backslash is an ordinary character.
			if c == '\\' && i < len(line)-1 && (line[i+1] == '<' || line[i+1] == '>' || line[i+1] == '\\') {
				i += 2
				continue
			} else if c == '>' {
				block.Advance(i + 1)
				return line[1:i], byteRange{offset + 1, offset + i}, true
			} else if c == '<' || c == '\n' || c == '\r' {
				// micromark: an unescaped < or a line ending ends the attempt.
				return nil, byteRange{-1, -1}, false
			}
			i++
		}
		return nil, byteRange{-1, -1}, false
	}
	// micromark: a raw destination cannot start with a closing parenthesis
	// or an ASCII control character.
	if len(line) == 0 || line[0] == ')' || line[0] < 0x20 || line[0] == 0x7f {
		return nil, byteRange{-1, -1}, false
	}
	opened := 0
	i := 0
	for i < len(line) {
		c := line[i]
		if c == '\\' && i < len(line)-1 && (line[i+1] == '(' || line[i+1] == ')' || line[i+1] == '\\') {
			i += 2
			continue
		} else if c == '(' {
			// micromark: at most balanceMax unbalanced opening parentheses.
			if balanceMax > 0 && opened >= balanceMax {
				return nil, byteRange{-1, -1}, false
			}
			opened++
		} else if c == ')' {
			opened--
			if opened < 0 {
				break
			}
		} else if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			// micromark: whitespace inside unbalanced parentheses ends the
			// attempt rather than the destination.
			if opened > 0 {
				return nil, byteRange{-1, -1}, false
			}
			break
		} else if c < 0x20 || c == 0x7f {
			// micromark: ASCII control characters are not allowed.
			return nil, byteRange{-1, -1}, false
		}
		i++
	}
	if opened > 0 {
		return nil, byteRange{-1, -1}, false
	}
	block.Advance(i)
	return line[:i], byteRange{offset, offset + i}, len(line[:i]) != 0
}

// parseMDLinkTitle is micromark's factoryTitle: from the opener to the first
// closer not escaped by a backslash, over any number of lines. micromark:
// a parenthesised title may hold an unescaped "(", which CommonMark and
// goldmark refuse, so that "[r]: u (()" is a definition to Basalt.
func parseMDLinkTitle(block text.Reader) ([]byte, bool) {
	skipMDSpaces(block)
	opener := block.Peek()
	if opener != '"' && opener != '\'' && opener != '(' {
		return nil, false
	}
	closer := opener
	if opener == '(' {
		closer = ')'
	}
	block.Advance(1)
	return scanMDTitle(block, closer)
}

// scanMDTitle reads a title from just after its opener to its closer.
func scanMDTitle(block text.Reader, closer byte) ([]byte, bool) {
	var title []byte
	for {
		line, _ := block.PeekLine()
		if line == nil {
			return nil, false
		}
		for i := 0; i < len(line); i++ {
			switch c := line[i]; {
			case c == '\\' && i+1 < len(line) && (line[i+1] == closer || line[i+1] == '\\'):
				title = append(title, c, line[i+1])
				i++
			case c == closer:
				block.Advance(i + 1)
				return title, true
			default:
				title = append(title, c)
			}
		}
		block.AdvanceLine()
	}
}

// skipMDSpaces is block.SkipSpaces with micromark's idea of whitespace in a
// link: spaces, tabs and line endings. goldmark also skips vertical tabs and
// form feeds, which micromark treats as ordinary control characters, so that
// "[a](\vb)" would be a link to goldmark and text to micromark. It returns how
// many characters it skipped.
func skipMDSpaces(block text.Reader) int {
	n := 0
	for {
		switch block.Peek() {
		case ' ', '\t', '\n', '\r':
			block.Advance(1)
			n++
		default:
			return n
		}
	}
}

func pushMDLinkBottom(pc parser.Context) {
	bottoms := pc.Get(mdLinkBottom)
	b := pc.LastDelimiter()
	if bottoms == nil {
		pc.Set(mdLinkBottom, b)
		return
	}
	if s, ok := bottoms.([]ast.Node); ok {
		pc.Set(mdLinkBottom, append(s, b))
		return
	}
	pc.Set(mdLinkBottom, []ast.Node{bottoms.(ast.Node), b})
}

func popMDLinkBottom(pc parser.Context) ast.Node {
	bottoms := pc.Get(mdLinkBottom)
	if bottoms == nil {
		return nil
	}
	if v, ok := bottoms.(ast.Node); ok {
		pc.Set(mdLinkBottom, nil)
		return v
	}
	s := bottoms.([]ast.Node)
	v := s[len(s)-1]
	n := s[0 : len(s)-1]
	switch len(n) {
	case 0:
		pc.Set(mdLinkBottom, nil)
	case 1:
		pc.Set(mdLinkBottom, n[0])
	default:
		pc.Set(mdLinkBottom, s[0:len(s)-1])
	}
	return v
}

func (s *mdLinkParser) CloseBlock(parent ast.Node, block text.Reader, pc parser.Context) {
	pc.Set(mdLinkBottom, nil)
	tlist := pc.Get(mdLinkLabelStateKey)
	if tlist == nil {
		return
	}
	for s := tlist.(*mdLinkLabelState); s != nil; {
		next := s.Next
		removeMDLinkLabelState(pc, s)
		s.Parent().ReplaceChild(s.Parent(), s, ast.NewTextSegment(s.Segment))
		s = next
	}
}

// mdDefinitionTransformer is goldmark's linkReferenceParagraphTransformer.
type mdDefinitionTransformer struct{}

func (p *mdDefinitionTransformer) Transform(node *ast.Paragraph, reader text.Reader, pc parser.Context) {
	lines := node.Lines()
	block := text.NewBlockReader(reader.Source(), lines)
	removes := [][2]int{}
	for {
		ref, start, end := parseMDLinkReferenceDefinition(block, pc)
		if start > -1 {
			if start == 0 {
				ref.SetBlankPreviousLines(node.HasBlankPreviousLines())
			}
			node.Parent().InsertBefore(node.Parent(), node, ref)
			for i := start + 1; i < end; i++ {
				ref.Lines().Append(lines.At(i))
			}
			seg := ref.Lines().At(ref.Lines().Len() - 1)
			ref.Lines().Set(ref.Lines().Len()-1, seg.TrimRightSpace(reader.Source()))
			if start == end {
				end++
			}
			removes = append(removes, [2]int{start, end})
			continue
		}
		break
	}

	offset := 0
	for _, remove := range removes {
		if lines.Len() == 0 {
			break
		}
		s := lines.Sliced(remove[1]-offset, lines.Len())
		lines.SetSliced(0, remove[0]-offset)
		lines.AppendAll(s)
		offset = remove[1]
	}

	if lines.Len() == 0 {
		node.Parent().RemoveChild(node.Parent(), node)
		return
	}

	node.SetLines(lines)
}

func parseMDLinkReferenceDefinition(block text.Reader, pc parser.Context) (*ast.LinkReferenceDefinition, int, int) {
	block.SkipSpaces()
	line, _ := block.PeekLine()
	if line == nil {
		return nil, -1, -1
	}
	startLine, _ := block.Position()
	width, pos := util.IndentWidth(line, 0)
	if width > 3 {
		return nil, -1, -1
	}
	if width != 0 {
		pos++
	}
	if line[pos] != '[' {
		return nil, -1, -1
	}
	_, startPos := block.Position()
	block.Advance(pos + 1)
	segments, found := block.FindClosure('[', ']', mdLinkFindClosureOptions)
	if !found {
		return nil, -1, -1
	}
	var label []byte
	if segments.Len() == 1 {
		label = block.Value(segments.At(0))
	} else {
		for i := range segments.Len() {
			s := segments.At(i)
			label = append(label, block.Value(s)...)
		}
	}
	if util.IsBlank(label) {
		return nil, -1, -1
	}
	if block.Peek() != ':' {
		return nil, -1, -1
	}
	block.Advance(1)
	skipMDSpaces(block)
	destination, span, ok := parseMDLinkDestination(block, 0)
	if !ok {
		return nil, -1, -1
	}
	line, _ = block.PeekLine()
	isNewLine := line == nil || util.IsBlank(line)

	endLine, _ := block.Position()
	spaces := skipMDSpaces(block)
	opener := block.Peek()
	if opener != '"' && opener != '\'' && opener != '(' {
		if !isNewLine {
			return nil, -1, -1
		}
		ref := ast.NewLinkReferenceDefinition(label, destination, nil)
		ref.Lines().Append(startPos)
		pc.AddReference(parser.NewReference(label, destination, nil))
		recordDefinition(pc, ref, startPos.Start, span)
		return ref, startLine, endLine + 1
	}
	if spaces == 0 {
		return nil, -1, -1
	}
	block.Advance(1)
	closer := opener
	if opener == '(' {
		closer = ')'
	}
	// micromark: the title's own rules, not goldmark's FindClosure.
	title, found := scanMDTitle(block, closer)
	if !found {
		if !isNewLine {
			return nil, -1, -1
		}
		ref := ast.NewLinkReferenceDefinition(label, destination, nil)
		ref.Lines().Append(startPos)
		pc.AddReference(parser.NewReference(label, destination, nil))
		recordDefinition(pc, ref, startPos.Start, span)
		block.AdvanceLine()
		return ref, startLine, endLine + 1
	}

	line, _ = block.PeekLine()
	if line != nil && !util.IsBlank(line) {
		if !isNewLine {
			return nil, -1, -1
		}
		ref := ast.NewLinkReferenceDefinition(label, destination, title)
		ref.Lines().Append(startPos)
		pc.AddReference(parser.NewReference(label, destination, title))
		recordDefinition(pc, ref, startPos.Start, span)
		return ref, startLine, endLine
	}

	endLine, _ = block.Position()
	ref := ast.NewLinkReferenceDefinition(label, destination, title)
	ref.Lines().Append(startPos)
	pc.AddReference(parser.NewReference(label, destination, title))
	recordDefinition(pc, ref, startPos.Start, span)
	return ref, startLine, endLine + 1
}
