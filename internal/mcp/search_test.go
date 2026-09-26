package mcp

import (
	"fmt"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/notes"
	"github.com/waynehoover/trewsync/internal/store"
)

type searchPage struct {
	NextCursor   *string `json:"nextCursor"`
	Complete     bool    `json:"complete"`
	Head         int64   `json:"head"`
	Scanned      int     `json:"scanned"`
	SkippedCount int     `json:"skippedCount"`
}

type searchRow struct {
	Path string `json:"path"`
	UID  int64  `json:"uid"`
	Line int    `json:"line"`
}

// A search pages as of the head its first page pinned, like a listing: a
// commit, an edit and a rename between two pages change nothing the
// continuation returns, and each match names the version it was found in.
func TestSearchPagesAsOfThePinnedHead(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{"a.md", "b.md", "c.md", "d.md", "e.md"} {
		r.write(p, "a needle in "+p+"\n")
	}
	r.indexed()
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)

	all := func(args map[string]any, between func()) ([]searchRow, int64) {
		var rows []searchRow
		var head int64
		for page := 0; ; page++ {
			e := invoke(t, cs, "search_notes", args)
			if e.isError {
				t.Fatalf("search: %s", e.raw)
			}
			var tr searchPage
			e.trusted(t, &tr)
			var un struct {
				Matches []searchRow `json:"matches"`
			}
			e.untrusted(t, &un)
			if page == 0 {
				head = tr.Head
			} else if tr.Head != head {
				t.Fatalf("page %d of head %d, the first of %d", page, tr.Head, head)
			}
			rows = append(rows, un.Matches...)
			if tr.NextCursor == nil {
				return rows, head
			}
			if page == 0 && between != nil {
				between()
			}
			args = map[string]any{"query": args["query"], "limit": args["limit"], "cursor": *tr.NextCursor}
		}
	}
	whole, _ := all(map[string]any{"query": "needle"}, nil)
	paged, _ := all(map[string]any{"query": "needle", "limit": 2}, func() {
		r.write("b2.md", "a new needle between the pages\n")
		r.write("d.md", "no longer here\n")
		r.rename("e.md", "a1.md", "a needle in e.md\n")
	})
	if fmt.Sprint(paged) != fmt.Sprint(whole) {
		t.Fatalf("paged %v\nwhole %v", paged, whole)
	}
	for i, row := range whole {
		if row.UID != int64(i+1) {
			t.Fatalf("match %d names uid %d", i, row.UID)
		}
	}
	now, _ := all(map[string]any{"query": "needle"}, nil)
	var paths []string
	for _, row := range now {
		paths = append(paths, row.Path)
	}
	if strings.Join(paths, ",") != "a.md,a1.md,b.md,b2.md,c.md" {
		t.Fatalf("after the commits the search finds %v", paths)
	}
}

// A page that reaches the scan budget says so: complete is false, and the
// continuation finds what lies beyond. A two-character query is one the
// index cannot narrow, so every note is scanned.
func TestSearchIsIncompleteWhenTheBudgetBinds(t *testing.T) {
	r := newRig(t)
	n := notes.SearchFiles + 8
	for i := 0; i < n; i++ {
		text := "nothing to see\n"
		if i == n-1 {
			text = "the last one holds qz\n"
		}
		r.write(fmt.Sprintf("n%04d.md", i), text)
	}
	r.indexed()
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)
	e := invoke(t, cs, "search_notes", map[string]any{"query": "qz"})
	var tr searchPage
	e.trusted(t, &tr)
	var un struct {
		Matches []searchRow `json:"matches"`
	}
	e.untrusted(t, &un)
	if tr.Complete || tr.NextCursor == nil || tr.Scanned != notes.SearchFiles || len(un.Matches) != 0 {
		t.Fatalf("the first page: %s", e.Trusted)
	}
	e = invoke(t, cs, "search_notes", map[string]any{"query": "qz", "cursor": *tr.NextCursor})
	tr = searchPage{}
	e.trusted(t, &tr)
	un.Matches = nil
	e.untrusted(t, &un)
	if !tr.Complete || tr.NextCursor != nil || len(un.Matches) != 1 || un.Matches[0].Path != fmt.Sprintf("n%04d.md", n-1) {
		t.Fatalf("the second page: %s %s", e.Trusted, e.Untrusted)
	}
	// A longer query the index narrows finds it on the first page.
	e = invoke(t, cs, "search_notes", map[string]any{"query": "holds qz"})
	tr = searchPage{}
	e.trusted(t, &tr)
	if !tr.Complete || tr.Scanned != 1 {
		t.Fatalf("an indexed query scanned %d notes: %s", tr.Scanned, e.Trusted)
	}
}

func TestSearchRefusals(t *testing.T) {
	r := newRig(t)
	r.write("a.md", "text")
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)
	e := invoke(t, cs, "search_notes", map[string]any{"query": "text", "limit": 1})
	var tr searchPage
	e.trusted(t, &tr)
	for _, c := range []struct {
		args map[string]any
		code string
	}{
		{map[string]any{}, "invalid_arguments"},
		{map[string]any{"query": ""}, "invalid_query"},
		{map[string]any{"query": strings.Repeat("x", 1025)}, "input_too_large"},
		{map[string]any{"query": "x", "mode": "regex"}, "invalid_query"},
		{map[string]any{"query": "#", "mode": "tag"}, "invalid_tag"},
		{map[string]any{"query": "123", "mode": "tag"}, "invalid_tag"},
		{map[string]any{"query": "x", "limit": 0}, "invalid_limit"},
		{map[string]any{"query": "x", "limit": 201}, "invalid_limit"},
		{map[string]any{"query": "x", "contextLines": 4}, "invalid_limit"},
		{map[string]any{"query": "x", "cursor": "AAAA"}, "invalid_cursor"},
		{map[string]any{"query": "x", "folder": "a/../b"}, "badpath"},
		{map[string]any{"query": "x", "includeBackups": true}, "invalid_arguments"},
	} {
		if e := invoke(t, cs, "search_notes", c.args); e.errorCode() != c.code {
			t.Errorf("search_notes %v: %s, want %s", c.args, short(string(e.raw)), c.code)
		}
	}
	if tr.NextCursor != nil {
		// A cursor carried into a search for something else is refused.
		if e := invoke(t, cs, "search_notes", map[string]any{"query": "other", "cursor": *tr.NextCursor}); e.errorCode() != "invalid_cursor" {
			t.Errorf("a cursor for another query: %s", e.raw)
		}
	}
}
