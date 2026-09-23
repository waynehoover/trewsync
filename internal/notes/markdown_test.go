package notes

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// kindTree writes the structure of a goldmark tree compactly: each node's
// kind, an HTML block with its type, children in parentheses, text left
// out.
func kindTree(n ast.Node) string {
	var b strings.Builder
	var walk func(n ast.Node)
	walk = func(n ast.Node) {
		b.WriteString(n.Kind().String())
		if h, ok := n.(*ast.HTMLBlock); ok {
			fmt.Fprintf(&b, "%d", h.HTMLBlockType)
		}
		var kids []ast.Node
		for c := n.FirstChild(); c != nil; c = c.NextSibling() {
			if c.Kind() != ast.KindText {
				kids = append(kids, c)
			}
		}
		if len(kids) > 0 {
			b.WriteString("(")
			for i, c := range kids {
				if i > 0 {
					b.WriteString(" ")
				}
				walk(c)
			}
			b.WriteString(")")
		}
	}
	walk(n)
	return b.String()
}

// stockTree is the structure goldmark's own CommonMark parser gives source.
func stockTree(source string) string {
	return kindTree(goldmark.DefaultParser().Parse(text.NewReader([]byte(source))))
}

// ourTree is the structure the parser markdown.go builds gives it.
func ourTree(t *testing.T, source string) string {
	t.Helper()
	d, err := parseMarkdown(source, 0)
	if err != nil {
		t.Fatal(err)
	}
	return kindTree(d.root)
}

// contentTags is the names of the tags in a note's body, in order.
func contentTags(t *testing.T, source string) []string {
	t.Helper()
	found, err := TagOccurrences(source)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, o := range found {
		if o.Location == "content" {
			names = append(names, o.Tag)
		}
	}
	return names
}

// linkURLs is the destinations of a note's links, in order.
func linkURLs(t *testing.T, source string) []string {
	t.Helper()
	spans, err := LinkSpans(source)
	if err != nil {
		t.Fatal(err)
	}
	urls := []string{}
	for _, s := range spans {
		urls = append(urls, s.URL)
	}
	return urls
}

// TestMarkdownDivergences holds the Markdown reading to Basalt's where
// goldmark's own differs: one case for each difference markdown.go,
// htmlflow.go and goldmark_link.go list. stock is the structure goldmark
// alone gives the note, ours the structure after the handling, and tags and
// links are Basalt's answers, taken from the TypeScript (the oracle holds
// them too: every note here is among the generator's DIVERGENCES). A case
// whose two structures agree marks the edge of a rule rather than a
// difference.
func TestMarkdownDivergences(t *testing.T) {
	cases := []struct {
		name, source string
		stock, ours  string
		tags, links  []string
	}{
		// markdown.go
		{"a lone CR ends a line", "x\r\r    #a",
			"Document(Paragraph)", "Document(Paragraph CodeBlock)", nil, nil},
		{"a CRLF ends a line, CR and all", "- a\r\n-\r\n      #b",
			"Document(List(ListItem(TextBlock)))", "Document(List(ListItem(TextBlock) ListItem(CodeBlock)))", nil, nil},
		{"a declaration may start lowercase", "x <!z #u> #t",
			"Document(Paragraph)", "Document(Paragraph(RawHTML))", []string{"t"}, nil},

		// htmlflow.go: where HTML blocks start
		{"a closing raw tag starts a type 7 block", "</script>\n#a",
			"Document(Paragraph(RawHTML))", "Document(HTMLBlock7)", nil, nil},
		{"a self-closing raw tag is type 7, not 1", "<script/>\n\n#a",
			"Document(HTMLBlock1)", "Document(HTMLBlock7 Paragraph)", []string{"a"}, nil},
		{"a declaration block may start lowercase", "<!doctype\n\n#a",
			"Document(Paragraph Paragraph)", "Document(HTMLBlock4)", nil, nil},
		{"a tab may follow a type 6 name", "x\n<div\t\n#a",
			"Document(Paragraph)", "Document(Paragraph HTMLBlock6)", nil, nil},
		{"no space after </", "</ div>\n#a",
			"Document(HTMLBlock6)", "Document(Paragraph)", []string{"a"}, nil},
		{"meta is not a type 6 name", "x\n<meta>\n#a",
			"Document(Paragraph HTMLBlock6)", "Document(Paragraph(RawHTML))", []string{"a"}, nil},

		// htmlflow.go: a complete tag on a lazy line
		{"lazy HTML stays in the quote", "> a\n<b>\n> #t",
			"Document(Blockquote(Paragraph(RawHTML)))", "Document(Blockquote(Paragraph HTMLBlock7))", nil, nil},
		{"lazy HTML ends with the quote", "> a\n<b>\n#c",
			"Document(Blockquote(Paragraph(RawHTML)))", "Document(Blockquote(Paragraph HTMLBlock7) Paragraph)", []string{"c"}, nil},
		{"lazy HTML takes the item's next line", "- a\n<b>\n  c #t",
			"Document(List(ListItem(TextBlock(RawHTML))))", "Document(List(ListItem(TextBlock HTMLBlock7)))", nil, nil},
		{"the item outlives the lazy HTML", "2) a\n<b>\n\n\t#t",
			"Document(List(ListItem(Paragraph(RawHTML) Paragraph)))", "Document(List(ListItem(Paragraph HTMLBlock7 Paragraph)))",
			[]string{"t"}, nil},
		{"lazy HTML in nested items", "- - c\n<b>\n  <e>\n#t",
			"Document(List(ListItem(List(ListItem(TextBlock(RawHTML RawHTML))))))",
			"Document(List(ListItem(List(ListItem(TextBlock HTMLBlock7)) HTMLBlock7)) Paragraph)", []string{"t"}, nil},

		// htmlflow.go: lists that interrupt
		{"a list opened with its container may not start empty", "a\n>-\n    #b",
			"Document(Paragraph Blockquote(List(ListItem)) CodeBlock)", "Document(Paragraph Blockquote(Paragraph))", []string{"b"}, nil},
		{"open indented code interrupts a list from 2", "    code\n2) x\n\n    #b",
			"Document(CodeBlock List(ListItem(Paragraph Paragraph)))", "Document(CodeBlock Paragraph CodeBlock)", nil, nil},
		{"code begun on a closing line does not", ">\n    >\n2) x\n\n    #e",
			"Document(Blockquote CodeBlock List(ListItem(Paragraph Paragraph)))",
			"Document(Blockquote CodeBlock List(ListItem(Paragraph Paragraph)))", []string{"e"}, nil},
		{"nor after blank lines", "> <!--\n    x\n\n2) a\n\n    #t",
			"Document(Blockquote(HTMLBlock2) CodeBlock List(ListItem(Paragraph Paragraph)))",
			"Document(Blockquote(HTMLBlock2) CodeBlock List(ListItem(Paragraph Paragraph)))", []string{"t"}, nil},
		{"a definition is content a list may not interrupt empty", "[r]: u\n-",
			"Document(LinkReferenceDefinition List(ListItem))", "Document(LinkReferenceDefinition Paragraph)", nil, []string{"u"}},
		{"a nested empty item closes only its own list", "- -\n\n    #t",
			"Document(List(ListItem(List(ListItem))) CodeBlock)", "Document(List(ListItem(List(ListItem) Paragraph)))", []string{"t"}, nil},

		// goldmark_link.go
		{"a title needs whitespace before it", `[a](<b>"t") #x`,
			"Document(Paragraph(Link))", "Document(Paragraph(RawHTML))", []string{"x"}, nil},
		{"an unescaped < ends a bracketed destination", "[a](<b<c>) #x",
			"Document(Paragraph(Link))", "Document(Paragraph(RawHTML))", []string{"x"}, nil},
		{"no control characters in a destination", "[a](b\x01c) #x",
			"Document(Paragraph(Link))", "Document(Paragraph)", []string{"x"}, nil},
		{"at most 32 open parentheses", "[a](" + strings.Repeat("(", 33) + "b" + strings.Repeat(")", 33) + ") #x",
			"Document(Paragraph(Link))", "Document(Paragraph)", []string{"x"}, nil},
		{"32 open parentheses are a link", "[a](" + strings.Repeat("(", 32) + "b" + strings.Repeat(")", 32) + ") #x",
			"Document(Paragraph(Link))", "Document(Paragraph(Link))", []string{"x"},
			[]string{strings.Repeat("(", 32) + "b" + strings.Repeat(")", 32)}},
		{"a space inside open parentheses ends the attempt", `[a](b( "t") #x`,
			"Document(Paragraph(Link))", "Document(Paragraph)", []string{"x"}, nil},
		{"so does a line ending", "[a](b(\n) #x",
			"Document(Paragraph(Link))", "Document(Paragraph)", []string{"x"}, nil},
		{"a parenthesised title may hold ( in a definition", "[r]: u (#x()",
			"Document(Paragraph)", "Document(LinkReferenceDefinition)", nil, []string{"u"}},
		{"and in a link", "[a](b (#x()) #y",
			"Document(Paragraph)", "Document(Paragraph(Link))", []string{"y"}, []string{"b"}},
		{"only spaces, tabs and line endings separate", "[a](\fb) #x",
			"Document(Paragraph(Link))", "Document(Paragraph)", []string{"x"}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := stockTree(c.source); got != c.stock {
				t.Errorf("goldmark alone: got %s, want %s", got, c.stock)
			}
			if got := ourTree(t, c.source); got != c.ours {
				t.Errorf("with the handling: got %s, want %s", got, c.ours)
			}
			if got := contentTags(t, c.source); !reflect.DeepEqual(got, append([]string{}, c.tags...)) {
				t.Errorf("tags: got %q, Basalt %q", got, c.tags)
			}
			if got := linkURLs(t, c.source); !reflect.DeepEqual(got, append([]string{}, c.links...)) {
				t.Errorf("links: got %q, Basalt %q", got, c.links)
			}
		})
	}
}

// TestDefinitionEndsWithItsDestination: when a title on its own line has
// text after it, the title belongs to the paragraph and the definition ends
// with its destination's line. goldmark ends the definition a line early, so
// the destination is left in the paragraph, where "#u" would be a tag.
func TestDefinitionEndsWithItsDestination(t *testing.T) {
	source := "[r]:\n#u\n'' x"
	firstLine := func(root ast.Node) string {
		for n := root.FirstChild(); n != nil; n = n.NextSibling() {
			if p, ok := n.(*ast.Paragraph); ok {
				s := p.Lines().At(0)
				return string(s.Value([]byte(source)))
			}
		}
		return ""
	}
	stock := goldmark.DefaultParser().Parse(text.NewReader([]byte(source)))
	if got := firstLine(stock); got != "#u\n" {
		t.Errorf("goldmark alone: the paragraph starts %q, want the destination's line", got)
	}
	d, err := parseMarkdown(source, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := firstLine(d.root); got != "'' x" {
		t.Errorf("with the handling: the paragraph starts %q, want \"'' x\"", got)
	}
	if got := contentTags(t, source); len(got) != 0 {
		t.Errorf("tags: got %q, Basalt none", got)
	}
	if got := linkURLs(t, source); !reflect.DeepEqual(got, []string{"#u"}) {
		t.Errorf("links: got %q, Basalt [\"#u\"]", got)
	}
}

// TestFenceAfterPartOfATab: a quote marker followed by a tab consumes one
// column of the tab, and the fence starts after the rest of it. goldmark's
// position for that fence is off by the rest of the tab, so the fence's
// range is taken from the line instead.
func TestFenceAfterPartOfATab(t *testing.T) {
	source := ">\t```\n>\t#a\n>\t```"
	stock := goldmark.DefaultParser().Parse(text.NewReader([]byte(source)))
	var fence *ast.FencedCodeBlock
	_ = ast.Walk(stock, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if f, ok := n.(*ast.FencedCodeBlock); ok && entering {
			fence = f
		}
		return ast.WalkContinue, nil
	})
	if fence == nil || fence.Pos() == 2 {
		t.Fatalf("goldmark alone now places the fence right (%v); fenceParser may not need its correction", fence)
	}
	got, err := MarkdownHidden(source, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := []Range{{2, 16}}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, Basalt %v", got, want)
	}
}

// TestEntityGoldmarkLacks: micromark knows every HTML named character
// reference; goldmark's table (v1.8.6) lacks one, which entityGaps adds.
func TestEntityGoldmarkLacks(t *testing.T) {
	for name, want := range entityGaps {
		if _, ok := util.LookUpHTML5EntityByName(name); ok {
			t.Errorf("goldmark now knows &%s;; drop it from entityGaps", name)
		}
		if got := decodeString("&" + name + ";"); got != want {
			t.Errorf("&%s;: got %q, want %q", name, got, want)
		}
	}
	if got := linkURLs(t, "&Abreve; [a](&Abreve;.md)"); !reflect.DeepEqual(got, []string{"\u0102.md"}) {
		t.Errorf("links: got %q, Basalt [\"\\u0102.md\"]", got)
	}
}

// TestMarkdownRegressions holds inputs the fuzz test found, with Basalt's
// answers: a reference link that kept a failed inline attempt's destination,
// and a definition that ended a line early.
func TestMarkdownRegressions(t *testing.T) {
	for _, c := range []struct {
		source string
		links  []string
	}{
		{"[](0[0](0 0\r* [0]:00000000000000000000(000)0", []string{"00000000000000000000(000)0"}},
		{"[0]:\n0\n''0", []string{"0"}},
	} {
		if got := linkURLs(t, c.source); !reflect.DeepEqual(got, c.links) {
			t.Errorf("%q: got %q, Basalt %q", c.source, got, c.links)
		}
		spans, _ := LinkSpans(c.source)
		for _, s := range spans {
			if s.WholeStart > s.Start || s.End > s.WholeEnd {
				t.Errorf("%q: span out of order: %+v", c.source, s)
			}
		}
	}
}
