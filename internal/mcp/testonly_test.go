package mcp

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The official SDK is a test dependency and never reaches the binary (PLAN.md
// M4 task 1): no file the server is built from imports it. Only non-test
// files are linked, so checking their imports is the whole question.
func TestTheSDKIsImportedOnlyByTests(t *testing.T) {
	root := filepath.Join("..", "..")
	checked := 0
	for _, dir := range []string{"cmd", "internal"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			checked++
			for _, imp := range f.Imports {
				p, _ := strconv.Unquote(imp.Path.Value)
				if strings.HasPrefix(p, "github.com/modelcontextprotocol/") {
					t.Errorf("%s imports %s, which would link the SDK into the server", path, p)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if checked < 50 {
		t.Fatalf("only %d source files were checked; the walk is looking in the wrong place", checked)
	}
}
