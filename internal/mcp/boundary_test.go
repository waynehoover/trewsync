package mcp

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

// The commit boundary is a build check, not a convention (PLAN.md sections
// 2.3 and 4.3, step 4). This test reads the package's own source and fails
// when any code reaches a method of the store, the server or the chunk store
// that is not listed below as safe outside the boundary, unless it does so
// directly inside the function passed to (*call).commit, which rechecks the
// credential under the commit lock. A method added to any of the three later
// is treated as a mutation until it is listed here. The write tools' two
// mutations, CommitOperation and the Broadcast of what it committed, are not
// listed, so both are held to the boundary: mutation.submit is their one call
// site, inside commit.
//
// Names are matched without types, so a field that shares a name with a
// method is held to the same rule; a false alarm is a nuisance, and a missed
// write is the failure this exists to prevent.

// outsideTheBoundary is every method of *store.Store, *server.Server and
// *chunks.Store that code in this package may reach outside commit.
var outsideTheBoundary = map[string]bool{
	// Reads of the log, as of a head or at the latest.
	"LatestUID": true, "CurrentUID": true, "Head": true, "Epoch": true,
	"EntryAsOf": true, "EachAsOf": true, "EntryByUID": true, "HistoryForPath": true,
	"Deleted": true, "PurgeGeneration": true, "Stats": true, "ChunkRefs": true,
	// Credentials, read at the door and again before the reply.
	"MatchMCPToken": true, "CheckMCPToken": true,
	// A token's last_used and used_count: bookkeeping about the token, written
	// outside the commit lock by design, and never a note or a credential.
	"NoteMCPTokenUse": true,
	// The operation log, read: a key's recorded reply before a retry is
	// prepared (a read, answered from the key's record; CommitOperation asks
	// again inside its transaction), and an operation by id for a lost reply.
	"Replay": true, "LookupOperation": true,
	// An undo's plan: reads of the log, the heads and the before-images,
	// which the commit checks all over again (store.PlanUndo).
	"PlanUndo": true,
	// Content: the chunk store is reached to read a body, and its own methods
	// are checked by name like the store's. PutAll stores a write's bodies
	// before its commit, as PLAN.md section 4.3, step 3 requires: content
	// addressed, named by nothing until an entry commits, and reclaimed by
	// purge when none does, so a revoked token's bodies change no note. Max is
	// the chunk size the devices are told, which a write chunks to.
	"Chunks": true, "Get": true, "Path": true, "Size": true, "PutAll": true, "Max": true,
	// The server: the store it holds (whose methods are checked by name), the
	// devices' delivery, and its identity.
	"Store": true, "DeliveryStatus": true, "Version": true, "Now": true,
}

func TestOnlyTheCommitBoundaryReachesAMutation(t *testing.T) {
	methods := methodNames((*store.Store)(nil), (*server.Server)(nil), (*chunks.Store)(nil))
	for name := range outsideTheBoundary {
		if !methods[name] {
			t.Errorf("%s is listed as safe outside the commit boundary, but no store, server or chunk store method has that name", name)
		}
	}
	fset, files := parsePackage(t, ".")
	if n := commitDecls(files); n != 1 {
		t.Errorf("found %d functions named commit; the boundary is exactly one, (*call).commit", n)
	}
	found, reads, inside := checkBoundary(fset, files, methods, outsideTheBoundary)
	for _, v := range found {
		t.Error(v)
	}
	if reads < 15 {
		t.Fatalf("only %d reads of the store were seen; the check is looking at the wrong files", reads)
	}
	// The write tools' mutations are reached, and only inside commit: were
	// either missing, the check above would be passing over code that no
	// longer commits through the boundary at all.
	for _, name := range []string{"CommitOperation", "Broadcast"} {
		if inside[name] == 0 {
			t.Errorf("%s is never reached inside commit; the write tools commit some other way", name)
		}
	}
}

// The check itself, on code written to break it.
func TestTheCommitBoundaryCheckCatchesWhatItShould(t *testing.T) {
	methods := methodNames((*store.Store)(nil), (*server.Server)(nil), (*chunks.Store)(nil))
	later := map[string]bool{"CommitOperation": true}
	for name := range methods {
		later[name] = true
	}
	cases := []struct {
		name, body string
		methods    map[string]bool
		want       []string
	}{
		{"a read outside commit", `
func (c *call) f() { _, _ = c.h.st.LatestUID(c.h.vault) }`, methods, nil},
		{"a write outside commit", `
func (c *call) f(e store.Entry) error { return c.h.st.AppendEntry(e) }`, methods, []string{"AppendEntry"}},
		{"a write inside commit", `
func (c *call) f(e store.Entry) error {
	return c.commit(func() error { return c.h.st.AppendEntry(e) })
}`, methods, nil},
		{"a write through an alias", `
func (c *call) f(e store.Entry) error { st := c.h.st; return st.AppendEntry(e) }`, methods, []string{"escapes", "AppendEntry"}},
		{"a write started by commit and finished after it", `
func (c *call) f(e store.Entry) error {
	return c.commit(func() error { go c.h.st.AppendEntry(e); return nil })
}`, methods, []string{"AppendEntry"}},
		{"a write in a closure made inside commit", `
func (c *call) f(e store.Entry) (func() error, error) {
	var w func() error
	err := c.commit(func() error { w = func() error { return c.h.st.AppendEntry(e) }; return nil })
	return w, err
}`, methods, []string{"AppendEntry"}},
		{"the commit lock taken elsewhere", `
func (c *call) f() error { return c.h.srv.UnderCommitLock(func() error { return nil }) }`, methods, []string{"UnderCommitLock"}},
		{"the store handed to another package", `
func (c *call) f() error { return store.Rewrite(c.h.st) }`, methods, []string{"escapes"}},
		{"the chunk store kept aside", `
func (c *call) f() { c.bodies = c.h.st.Chunks() }`, methods, []string{"escapes"}},
		{"a method added later", `
func (c *call) f() error { return c.h.srv.CommitOperation() }`, later, []string{"CommitOperation"}},
		{"an operation committed outside commit", `
func (c *call) f(op store.Operation) error { _, err := c.h.st.CommitOperation(op); return err }`, methods, []string{"CommitOperation"}},
		{"an operation committed inside commit", `
func (c *call) f(op store.Operation) error {
	return c.commit(func() error { _, err := c.h.st.CommitOperation(op); return err })
}`, methods, nil},
		{"a broadcast outside commit", `
func (c *call) f(es []store.Entry) { c.h.srv.Broadcast(c.h.vault, es) }`, methods, []string{"Broadcast"}},
		{"a replay, which is a read", `
func (c *call) f() { _, _, _ = c.h.st.Replay(c.h.vault, "id", "key", "digest") }`, methods, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := "package mcp\n\nimport \"github.com/waynehoover/trew/internal/store\"\n\nvar _ store.Entry\n" + tc.body
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, "case.go", src, 0)
			if err != nil {
				t.Fatal(err)
			}
			found, _, _ := checkBoundary(fset, []*ast.File{f}, tc.methods, outsideTheBoundary)
			if len(found) != len(tc.want) {
				t.Fatalf("found %q, want one finding for each of %q", found, tc.want)
			}
			for i, w := range tc.want {
				if !strings.Contains(found[i], w) {
					t.Errorf("finding %d is %q, want it to mention %q", i, found[i], w)
				}
			}
		})
	}
}

// methodNames is the exported method names of the given pointer types.
func methodNames(values ...any) map[string]bool {
	names := map[string]bool{}
	for _, v := range values {
		typ := reflect.TypeOf(v)
		for i := 0; i < typ.NumMethod(); i++ {
			names[typ.Method(i).Name] = true
		}
	}
	return names
}

// parsePackage parses the non-test Go files in dir.
func parsePackage(t *testing.T, dir string) (*token.FileSet, []*ast.File) {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var files []*ast.File
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, path.Join(dir, name), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f)
	}
	if len(files) < 8 {
		t.Fatalf("only %d source files in %s", len(files), dir)
	}
	return fset, files
}

// commitDecls counts the functions and methods named commit.
func commitDecls(files []*ast.File) int {
	n := 0
	for _, f := range files {
		for _, d := range f.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == "commit" {
				if fd.Recv == nil || !receiverIs(fd, "call") {
					return -1
				}
				n++
			}
		}
	}
	return n
}

// checkBoundary returns, in source order, a finding for every place in files
// that reaches a guarded method (one in methods and not in allowed) outside a
// commit callback, takes the commit lock outside (*call).commit, or lets the
// store, the server or the chunk store escape to where this check cannot
// follow it. reads counts the allowed methods it saw reached, and inside the
// guarded ones reached inside commit, by name, so a caller can tell the check
// looked at something.
func checkBoundary(fset *token.FileSet, files []*ast.File, methods, allowed map[string]bool) (found []string, reads int, inside map[string]int) {
	inside = map[string]int{}
	local := map[string]bool{}
	for _, f := range files {
		for _, d := range f.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && fd.Recv == nil {
				local[fd.Name.Name] = true
			}
		}
	}
	report := func(n ast.Node, format string, args ...any) {
		found = append(found, fset.Position(n.Pos()).String()+": "+fmt.Sprintf(format, args...))
	}
	for _, f := range files {
		packages := map[string]bool{}
		for _, imp := range f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			name := path.Base(p)
			if imp.Name != nil {
				name = imp.Name.Name
			}
			packages[name] = true
		}
		qualified := func(sel *ast.SelectorExpr) bool {
			id, ok := sel.X.(*ast.Ident)
			return ok && packages[id.Name]
		}
		var stack []ast.Node
		ast.Inspect(f, func(n ast.Node) bool {
			if n == nil {
				stack = stack[:len(stack)-1]
				return true
			}
			parents := stack
			stack = append(stack, n)
			switch n := n.(type) {
			case *ast.SelectorExpr:
				if qualified(n) {
					return true
				}
				name := n.Sel.Name
				switch {
				case name == "UnderCommitLock":
					if fd := enclosingDecl(parents); fd == nil || fd.Name.Name != "commit" || !receiverIs(fd, "call") {
						report(n, "takes the commit lock with UnderCommitLock outside (*call).commit")
					}
				case methods[name] && allowed[name]:
					reads++
				case methods[name]:
					if !inCommit(parents) {
						report(n, "reaches %s outside (*call).commit, where no credential is rechecked", name)
					} else {
						inside[name]++
					}
				}
				if name == "st" || name == "srv" || name == "Server" {
					checkEscape(n, parents, local, report)
				}
			case *ast.CallExpr:
				if sel, ok := n.Fun.(*ast.SelectorExpr); ok && !qualified(sel) && (sel.Sel.Name == "Store" || sel.Sel.Name == "Chunks") {
					checkEscape(n, parents, local, report)
				}
			}
			return true
		})
	}
	return found, reads, inside
}

// checkEscape reports a store, server or chunk store value that goes
// anywhere but the receiver of a method, a function of this package, the
// construction in New, or a commit callback.
func checkEscape(n ast.Node, parents []ast.Node, local map[string]bool, report func(ast.Node, string, ...any)) {
	if len(parents) == 0 {
		return
	}
	switch p := parents[len(parents)-1].(type) {
	case *ast.SelectorExpr:
		if p.X == n {
			return
		}
	case *ast.CallExpr:
		if id, ok := p.Fun.(*ast.Ident); ok && local[id.Name] {
			return
		}
	}
	if fd := enclosingDecl(parents); fd != nil && fd.Recv == nil && fd.Name.Name == "New" {
		return
	}
	if inCommit(parents) {
		return
	}
	report(n, "the store, the server or the chunk store escapes here, where the commit boundary check cannot follow it")
}

// inCommit reports whether the innermost function around the node is a
// function literal passed to a method named commit, with no go statement in
// between: code that runs while commit holds the lock.
func inCommit(parents []ast.Node) bool {
	for i := len(parents) - 1; i > 0; i-- {
		switch p := parents[i].(type) {
		case *ast.GoStmt:
			return false
		case *ast.FuncLit:
			call, ok := parents[i-1].(*ast.CallExpr)
			if !ok {
				return false
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "commit" {
				return false
			}
			for _, a := range call.Args {
				if a == p {
					return true
				}
			}
			return false
		case *ast.FuncDecl:
			return false
		}
	}
	return false
}

// enclosingDecl is the function declaration the node is in, if any.
func enclosingDecl(parents []ast.Node) *ast.FuncDecl {
	for i := len(parents) - 1; i >= 0; i-- {
		if fd, ok := parents[i].(*ast.FuncDecl); ok {
			return fd
		}
	}
	return nil
}

// receiverIs reports whether fd is a method on *name.
func receiverIs(fd *ast.FuncDecl, name string) bool {
	if fd.Recv == nil || len(fd.Recv.List) != 1 {
		return false
	}
	star, ok := fd.Recv.List[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	id, ok := star.X.(*ast.Ident)
	return ok && id.Name == name
}
