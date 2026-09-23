package notes

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// TestASTDump prints goldmark's tree for the inputs in $AST_DUMP (a JSON list
// of strings), with the ranges this package derives. A debugging aid.
func TestASTDump(t *testing.T) {
	file := os.Getenv("AST_DUMP")
	if file == "" {
		t.Skip("AST_DUMP not set")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var inputs []string
	if err := json.Unmarshal(raw, &inputs); err != nil {
		t.Fatal(err)
	}
	for _, in := range inputs {
		d, err := parseMarkdown(in, 0)
		if err != nil {
			t.Fatal(err)
		}
		var b strings.Builder
		_ = ast.Walk(d.root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
			if !entering {
				return ast.WalkContinue, nil
			}
			depth := 0
			for p := n.Parent(); p != nil; p = p.Parent() {
				depth++
			}
			extra := ""
			if n.Type() == ast.TypeBlock && n.Lines() != nil && n.Lines().Len() > 0 {
				extra = fmt.Sprintf(" lines %d-%d", n.Lines().At(0).Start, n.Lines().At(n.Lines().Len()-1).Stop)
			}
			if r, ok := d.record.spans[n]; ok {
				extra += fmt.Sprintf(" span %v", r)
			}
			fmt.Fprintf(&b, "%s%s pos %d%s\n", strings.Repeat("  ", depth), n.Kind(), n.Pos(), extra)
			return ast.WalkContinue, nil
		})
		stock := parser.NewParser(parser.WithBlockParsers(parser.DefaultBlockParsers()...),
			parser.WithInlineParsers(parser.DefaultInlineParsers()...),
			parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...))
		root := stock.Parse(text.NewReader([]byte(in)))
		var s strings.Builder
		_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
			if entering {
				depth := 0
				for p := n.Parent(); p != nil; p = p.Parent() {
					depth++
				}
				fmt.Fprintf(&s, "%s%s\n", strings.Repeat("  ", depth), n.Kind())
			}
			return ast.WalkContinue, nil
		})
		t.Logf("=== %q\n%s hidden %v\nstock goldmark:\n%s", in, b.String(), mustHidden(t, in, 0, true), s.String())
	}
}

func mustHidden(t *testing.T, source string, start int, protectLinks bool) []Range {
	t.Helper()
	r, err := MarkdownHidden(source, start, protectLinks)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
