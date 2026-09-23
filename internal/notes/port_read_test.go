package notes

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// The cases of client/src/cli/mcp-read.test.ts that exercise what this
// package ports: paging, the search page loop and the cursor codec. The
// others test the reader around them (the vault, symlinks, the inventory,
// concurrency, cancellation), which the server's tools own.

// searchNote is one note a ported search case holds.
type searchNote struct {
	path string
	body []byte
}

func textNote(path, body string) searchNote { return searchNote{path, []byte(body)} }

// searchCandidates is the notes in path order, as the reader visited them,
// less those before after.
func searchCandidates(notes []searchNote, after *Position) []Candidate {
	sort.Slice(notes, func(i, j int) bool { return notes[i].path < notes[j].path })
	var out []Candidate
	for _, n := range notes {
		if after != nil && n.path < after.Path {
			continue
		}
		body := n.body
		out = append(out, Candidate{Path: n.path, Load: func() ([]byte, error) { return body, nil }})
	}
	return out
}

func matchPaths(r SearchResult) []string {
	out := []string{}
	for _, m := range r.Matches {
		out = append(out, m.Path)
	}
	return out
}

// basaltQuery is a search as the reader defaulted it: content mode, children
// included, 50 matches a page.
func basaltQuery(text string) Query {
	return Query{Text: text, Mode: ModeContent, IncludeChildren: true}
}

const basaltLimit = 50

func TestPortedSearchesParsedTags(t *testing.T) {
	// "searches parsed tags without matching code, comments, or ordinary prose"
	notes := []searchNote{
		textNote("real.md", "---\r\ntags: [Project/Active]\r\n---\r\nbody\r\n"),
		textNote("inline.md", "#project/active\n"),
		textNote("prose.md", "project/active\n`#project/active`\n<!-- #project/active -->\n````\n```\n#project/active\n````\n"),
	}
	q := basaltQuery("project/active")
	q.Mode = ModeTag
	r, err := SearchPage(searchCandidates(notes, nil), q, nil, basaltLimit)
	if err != nil {
		t.Fatal(err)
	}
	if got := matchPaths(r); !reflect.DeepEqual(got, []string{"inline.md", "real.md"}) || !r.Complete {
		t.Errorf("got %q complete %v", got, r.Complete)
	}
}

func TestPortedFilenamePagesBindTheMode(t *testing.T) {
	// "paginates filename matches independently from content and binds the
	// search mode"
	notes := []searchNote{
		textNote("a-needle.md", "no content match"),
		textNote("b-needle.md", "no content match"),
		textNote("c.md", "needle"),
	}
	q := basaltQuery("needle")
	q.Mode = ModeFilename
	options := func(mode SearchMode) []Option {
		return []Option{{"query", "needle"}, {"mode", string(mode)}, {"includeChildren", true}}
	}
	first, err := SearchPage(searchCandidates(notes, nil), q, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := matchPaths(first); !reflect.DeepEqual(got, []string{"a-needle.md"}) || first.Next == nil {
		t.Fatalf("first page: %q, next %v", got, first.Next)
	}
	cursor := EncodeSearchCursor(options(ModeFilename), 0, *first.Next)
	_, at, err := DecodeSearchCursor(cursor, options(ModeFilename))
	if err != nil {
		t.Fatal(err)
	}
	second, err := SearchPage(searchCandidates(notes, &at), q, &at, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := matchPaths(second); !reflect.DeepEqual(got, []string{"b-needle.md"}) {
		t.Errorf("second page: %q", got)
	}
	if _, _, err := DecodeSearchCursor(cursor, options(ModeContent)); codeOf(err) != "invalid_cursor" {
		t.Errorf("a filename cursor in content mode: %v, want invalid_cursor", err)
	}
}

func TestPortedNestedTags(t *testing.T) {
	// "finds nested tags by default and can restrict tag search to the exact
	// parent"
	notes := []searchNote{
		textNote("child.md", "#project/active\n"),
		textNote("parent.md", "#Project\n"),
		textNote("prefix.md", "#projectile\n"),
	}
	q := basaltQuery("project")
	q.Mode = ModeTag
	for _, c := range []struct {
		children bool
		want     []string
	}{{true, []string{"child.md", "parent.md"}}, {false, []string{"parent.md"}}} {
		q.IncludeChildren = c.children
		r, err := SearchPage(searchCandidates(notes, nil), q, nil, basaltLimit)
		if err != nil {
			t.Fatal(err)
		}
		if got := matchPaths(r); !reflect.DeepEqual(got, c.want) {
			t.Errorf("children %v: got %q, want %q", c.children, got, c.want)
		}
	}
}

func TestPortedFilenameHitsSurviveAnUndecodableBody(t *testing.T) {
	// "keeps filename hits when combined search cannot decode the note body"
	notes := []searchNote{{"unreadable-needle.md", []byte{0xff}}}
	q := basaltQuery("needle")
	q.Mode = ModeBoth
	r, err := SearchPage(searchCandidates(notes, nil), q, nil, basaltLimit)
	if err != nil {
		t.Fatal(err)
	}
	if got := matchPaths(r); !reflect.DeepEqual(got, []string{"unreadable-needle.md"}) || len(r.Skipped) != 1 || r.Complete {
		t.Errorf("got %q, skipped %v, complete %v", got, r.Skipped, r.Complete)
	}
}

func TestPortedNoDuplicateScalarTagCoordinates(t *testing.T) {
	// "does not return duplicate scalar-tag coordinates that pagination cannot
	// resume"
	q := basaltQuery("old")
	q.Mode = ModeTag
	r, err := SearchPage(searchCandidates([]searchNote{textNote("note.md", "---\ntags: old old\n---\n")}, nil), q, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Matches) != 1 || r.Next != nil || !r.Complete {
		t.Errorf("got %d matches, next %v, complete %v", len(r.Matches), r.Next, r.Complete)
	}
}

func TestPortedListCursorWithAnExpensivePath(t *testing.T) {
	// "accepts its own continuation when a legal path needs extensive JSON
	// escaping". Basalt's paths reached 4,096 bytes; the server's reach
	// paths.MaxPathBytes, so the longest is used, of the character JSON
	// escapes most expensively.
	options := []Option{{"folder", ""}, {"includeBackups", false}}
	path := strings.Repeat("\u0001", 1024)
	cursor := EncodeListCursor(options, 7, path)
	if len(cursor) > MaxCursorLength {
		t.Fatalf("the cursor is %d characters, over the cap", len(cursor))
	}
	head, got, err := DecodeListCursor(cursor, options)
	if err != nil || head != 7 || got != path {
		t.Errorf("round trip: %d %q %v", head, got, err)
	}
	if _, _, err := DecodeListCursor(EncodeListCursor(options, 7, path+"x"), options); codeOf(err) != "invalid_cursor" {
		t.Errorf("a path past the limit: %v, want invalid_cursor", err)
	}
}

func TestPortedEscapedContextStillMakesProgress(t *testing.T) {
	// "makes progress when escaping search context would otherwise consume the
	// entire page"
	long := strings.Repeat("\u0001", 2048)
	body := strings.Join([]string{long, long, long, "needle" + long, long, long, long}, "\n")
	q := basaltQuery("needle")
	q.ContextLines = 3
	r, err := SearchPage(searchCandidates([]searchNote{textNote("note.md", body)}, nil), q, nil, basaltLimit)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Matches) != 1 || !r.Matches[0].Clipped || r.Next != nil {
		t.Fatalf("got %d matches, next %v", len(r.Matches), r.Next)
	}
	// The rows serialise as a JSON array: brackets, and commas between.
	if size := MatchSize("note.md", r.Matches[0].Match) + 2; size > PageTextBytes {
		t.Errorf("the page is %d bytes, over %d", size, PageTextBytes)
	}
}

func TestPortedPagesKeepBOMAndCRLF(t *testing.T) {
	// "returns complete-source bases and preserves BOM and CRLF across pages"
	// (the base and its staleness belong to the tool).
	source := "\ufeff---\r\ntitle: Daily\r\n---\r\n\r\n- [ ] Task\r\n"
	var joined strings.Builder
	start, pages := 1, []int{2, 2, 200}
	var last PageResult
	for _, max := range pages {
		p, err := Page([]byte(source), start, max, PageTextBytes)
		if err != nil {
			t.Fatal(err)
		}
		joined.WriteString(p.Content())
		last = p
		start = p.NextLine
	}
	if joined.String() != source || !last.Complete {
		t.Errorf("pages joined to %q, complete %v", joined.String(), last.Complete)
	}
}

func TestPortedLineLargerThanThePage(t *testing.T) {
	// "refuses a line larger than the page budget instead of returning a stuck
	// continuation"
	if _, err := Page([]byte(strings.Repeat("x", PageTextBytes+1)), 1, 200, PageTextBytes); codeOf(err) != "line_too_large" {
		t.Errorf("got %v, want line_too_large", err)
	}
}

func TestPortedPagesByBytes(t *testing.T) {
	// "pages by bytes even when the line-count limit has room"
	source := strings.Repeat(strings.Repeat("x", 1023)+"\n", 1024)
	p, err := Page([]byte(source), 1, 1000, PageTextBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Content()) != PageTextBytes || p.NextLine != 65 {
		t.Errorf("got %d bytes, next line %d", len(p.Content()), p.NextLine)
	}
}

func TestPortedSearchContinuesAfterAFullPage(t *testing.T) {
	// "continues through later hits after an early page fills"
	notes := []searchNote{textNote("a.md", "needle needle\nneedle\n"), textNote("b.md", "later needle\n")}
	var seen []string
	var after *Position
	for page := 0; page < 8; page++ {
		r, err := SearchPage(searchCandidates(notes, after), basaltQuery("needle"), after, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range r.Matches {
			seen = append(seen, fmt.Sprintf("%s:%d:%d", m.Path, m.Line, m.Column))
		}
		if r.Next == nil {
			if !r.Complete {
				t.Error("the last page is not complete")
			}
			break
		}
		if after != nil && *r.Next == *after {
			t.Fatal("the page did not move")
		}
		after = r.Next
	}
	if want := []string{"a.md:1:1", "a.md:1:8", "a.md:2:1", "b.md:1:7"}; !reflect.DeepEqual(seen, want) {
		t.Errorf("got %q, want %q", seen, want)
	}
}

func TestPortedLiteralSearch(t *testing.T) {
	// "searches literal syntax and multiline literals without interpreting a
	// regex"
	source := "Literal [a-z]+?\nsecond line\n"
	if m, err := NoteMatches(source, basaltQuery("[a-z]+?")); err != nil || len(m) != 1 {
		t.Errorf("got %v %v, want one match", m, err)
	}
	m, err := NoteMatches(source, basaltQuery("+?\nsecond"))
	if err != nil || len(m) != 1 || m[0].Line != 1 || m[0].Column != 14 {
		t.Errorf("got %+v %v, want line 1 column 14", m, err)
	}
}

func TestPortedUnreadableNotesKeepTheSearchIncomplete(t *testing.T) {
	// "reports unreadable or unsupported content without calling the search
	// complete" (the reader leaves unsupported formats out before the loop).
	notes := []searchNote{{"bad.md", []byte{0xff}}, textNote("good.md", "needle")}
	r, err := SearchPage(searchCandidates(notes, nil), basaltQuery("needle"), nil, basaltLimit)
	if err != nil {
		t.Fatal(err)
	}
	if got := matchPaths(r); !reflect.DeepEqual(got, []string{"good.md"}) || len(r.Skipped) != 1 || r.Complete || r.Next != nil {
		t.Errorf("got %q, skipped %v, complete %v, next %v", got, r.Skipped, r.Complete, r.Next)
	}
}
