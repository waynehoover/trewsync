package notes

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// FuzzNotes feeds arbitrary text to every read-side function and checks what
// must hold whatever the input: nothing panics or is refused as internal,
// pages join back into the note, ranges are ordered and inside the note,
// comparisons rebuild the later text, and link edits apply to the source they
// were made from. Seeded with the oracle corpus:
//
//	go test -run '^$' -fuzz FuzzNotes -fuzztime 60s ./internal/notes/
func FuzzNotes(f *testing.F) {
	var notes []struct {
		Source fxText `json:"source"`
	}
	if err := json.Unmarshal(loadFixture(f)["notes"], &notes); err != nil {
		f.Fatal(err)
	}
	for i, n := range notes {
		if i%3 == 0 {
			f.Add(string(n.Source))
		}
	}
	f.Fuzz(func(t *testing.T, s string) {
		if len(s) > 1<<16 {
			return
		}
		page, err := Page([]byte(s), 1, MaxPageLines, PageTextBytes)
		if !utf8.ValidString(s) {
			if codeOf(err) != "invalid_utf8" {
				t.Fatalf("invalid UTF-8 paged: %v", err)
			}
			return
		}
		var joined strings.Builder
		for next := 1; err == nil; {
			joined.WriteString(page.Content())
			if page.Complete {
				break
			}
			next = page.NextLine
			page, err = Page([]byte(s), next, 3, PageTextBytes)
		}
		if err == nil && joined.String() != s {
			t.Fatalf("pages rebuilt %q", joined.String())
		}
		total := units(s)
		for _, protect := range []bool{false, true} {
			ranges, err := MarkdownHidden(s, 0, protect)
			if err != nil {
				t.Fatalf("hidden: %v", err)
			}
			for i, r := range ranges {
				if r.Start < 0 || r.End > total || r.Start > r.End || (i > 0 && r.Start <= ranges[i-1].End) {
					t.Fatalf("hidden range %d out of order or bounds: %v", i, ranges)
				}
			}
		}
		tags, err := TagOccurrences(s)
		if code := codeOf(err); code != "" && code != "invalid_frontmatter" && code != "invalid_tag" {
			t.Fatalf("tags: %v", err)
		}
		for _, o := range tags {
			if o.Start < 0 || o.End > total || o.Start > o.End {
				t.Fatalf("tag out of bounds: %+v", o)
			}
		}
		spans, err := LinkSpans(s)
		if code := codeOf(err); code != "" && code != "invalid_frontmatter" {
			t.Fatalf("links: %v", err)
		}
		for _, l := range spans {
			if l.WholeStart > l.Start || l.Start > l.End || l.End > l.WholeEnd || l.WholeEnd > total {
				t.Fatalf("link span out of order: %+v", l)
			}
		}
		for _, q := range []Query{
			{Text: "a", Mode: ModeContent},
			{Text: "\u00e9", Mode: ModeContent, ContextLines: 2},
			{Text: "tag", Mode: ModeTag, IncludeChildren: true},
		} {
			if _, err := NoteMatches(s, q); err != nil && q.Mode != ModeTag {
				t.Fatalf("search: %v", err)
			}
		}
		lines := splitLines(s)
		reversed := make([]string, len(lines))
		for i, l := range lines {
			reversed[len(lines)-1-i] = l
		}
		after := strings.Join(reversed, "")
		rebuilt := lines
		c := CompareLines(s, after)
		for i := len(c.Changes) - 1; i >= 0; i-- {
			ch := c.Changes[i]
			rebuilt = append(append(append([]string{}, rebuilt[:ch.FromLine-1]...), splitLines(ch.New)...), rebuilt[ch.FromLine-1+ch.OldLines:]...)
		}
		if strings.Join(rebuilt, "") != after {
			t.Fatalf("changes do not rebuild the later text")
		}
		for _, del := range []bool{false, true} {
			change := LinkChange{Path: "Index.md", From: "Old.md", To: "Folder/New.md", Delete: del,
				Inventory: []string{"Index.md", "Old.md", "b", "d.md"}, Canonical: testCanonical}
			edits, _, err := ChangeLinks(s, change)
			if code := codeOf(err); code != "" && code != "invalid_frontmatter" && code != "ambiguous_link" {
				t.Fatalf("change links: %v", err)
			}
			if _, err := ApplySourceEdits(s, edits); err != nil && err == nil {
				t.Fatal("unreachable")
			} else if err != nil && codeOf(err) != "input_too_large" {
				t.Fatalf("edits do not apply: %v %+v", err, edits)
			}
		}
	})
}
