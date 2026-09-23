package notes

import (
	"reflect"
	"strings"
	"testing"
)

// The cases of client/src/cli/mcp-markdown.test.ts, on the reading side: the
// tags each note holds, where they are, and the tag patterns and matching the
// edits select by. The edits themselves (changeTags) are the write tools'.

// tagRow is a tag occurrence as the cases below write it.
type tagRow struct {
	tag        string
	start, end int
	location   string
}

func tagRows(t *testing.T, source string) []tagRow {
	t.Helper()
	found, err := TagOccurrences(source)
	if err != nil {
		t.Fatalf("%q: %v", source, err)
	}
	rows := []tagRow{}
	for _, o := range found {
		rows = append(rows, tagRow{o.Tag, o.Start, o.End, o.Location})
	}
	return rows
}

func TestPortedTagsAroundYAMLBOMAndCRLF(t *testing.T) {
	// "edits only the tags value and retains unrelated YAML, BOM, CRLF, body
	// and comments": the tags the edit starts from, where Basalt found them.
	source := "\ufeff---\r\ntitle:  \"Keep these spaces\" # title comment\r\ntags: [old, Keep] # tag comment\r\n" +
		"other: &value {x: 1}\r\ncopy: *value\r\n---\r\nUNSENT caf\u00e9 \U0001f600\r\n"
	want := []tagRow{{"old", 58, 61, "frontmatter"}, {"Keep", 63, 67, "frontmatter"}}
	if got := tagRows(t, source); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestPortedTagsInABlockList(t *testing.T) {
	// "retains comments within a block tags list when removing a tag", before
	// and after the edit.
	before := "---\ntitle:  unchanged\ntags:\n  - old # first\n  # middle\n  - keep\nnext: unchanged\n---\nUNSENT\n"
	if got := tagRows(t, before); !reflect.DeepEqual(got, []tagRow{{"old", 32, 35, "frontmatter"}, {"keep", 59, 63, "frontmatter"}}) {
		t.Errorf("before: %+v", got)
	}
	after := "---\ntitle:  unchanged\ntags:\n  [\"keep\"]\n  # first\n  # middle\nnext: unchanged\n---\nUNSENT\n"
	if got := tagRows(t, after); len(got) != 1 || got[0].tag != "keep" {
		t.Errorf("after: %+v", got)
	}
}

func TestPortedFrontmatterWhereTagsAreAdded(t *testing.T) {
	// "adds frontmatter tags without rewriting the rest": where each note's
	// frontmatter is, which the addition writes into.
	for _, c := range []struct {
		source string
		want   Frontmatter
	}{
		{"\ufeffBody\r\n", Frontmatter{BOM: 1, Newline: "\r\n", Start: 1, End: 1, Body: 1}},
		{"---\ntitle: raw\n---", Frontmatter{Newline: "\n", Start: 4, End: 15, Body: 18, Present: true}},
		{"---\ntags:\n# keep\n---\nbody", Frontmatter{Newline: "\n", Start: 4, End: 17, Body: 21, Present: true}},
	} {
		if got, err := FindFrontmatter(c.source); err != nil || got != c.want {
			t.Errorf("%q: got %+v %v, want %+v", c.source, got, err, c.want)
		}
	}
	if got := tagRows(t, "---\ntags:\n# keep\n---\nbody"); len(got) != 0 {
		t.Errorf("an empty tags property: %+v", got)
	}
}

func TestPortedTagsSkipCodeCommentsAndLinks(t *testing.T) {
	// "does not touch code, comments, link destinations, escapes or numeric
	// hashtags"
	source := "#keep #\u5de5\u4f5c/\u5f53\u524d #\U0001f600\n`#ignore` ``#ignore ` nested``\n\\#ignore 123#ignore #123\n" +
		"<!-- #ignore\n#ignore -->\n%% #ignore %%\n[[note#ignore]] [note](note#ignore)\n````\n```\n#ignore\n````\n" +
		"~~~\n#ignore\n~~~\n    #ignore\n"
	if got := contentTags(t, source); !reflect.DeepEqual(got, []string{"keep", "\u5de5\u4f5c/\u5f53\u524d", "\U0001f600"}) {
		t.Errorf("got %q", got)
	}
}

func TestPortedURLFragmentsAreNotTags(t *testing.T) {
	// "never removes a URL fragment while changing tags"
	for _, source := range []string{
		"[link](https://example.test/a(b)#old)\nUNSENT\n",
		"[link]: https://example.test/a(b)#old\nUNSENT\n",
		"<https://example.test/a(b)#old>\nUNSENT\n",
	} {
		if got := tagRows(t, source); len(got) != 0 {
			t.Errorf("%q: %+v", source, got)
		}
	}
}

func TestPortedCodeStartsNoComment(t *testing.T) {
	// "does not start a comment from code"
	for _, source := range []string{"`%%`\n#old\n", "```\n%%\n```\n#old\n"} {
		if got := contentTags(t, source); !reflect.DeepEqual(got, []string{"old"}) {
			t.Errorf("%q: got %q", source, got)
		}
	}
}

func TestPortedNestedTagsMatchBySegment(t *testing.T) {
	// "matches nested tags by segment and preserves unselected descendants":
	// which of the note's tags each selection takes.
	source := "#old #OLD/child #older #keep\n"
	if got := contentTags(t, source); !reflect.DeepEqual(got, []string{"old", "OLD/child", "older", "keep"}) {
		t.Fatalf("got %q", got)
	}
	for _, c := range []struct {
		children bool
		want     []bool
	}{{false, []bool{true, false, false, false}}, {true, []bool{true, true, false, false}}} {
		var got []bool
		for _, tag := range []string{"old", "OLD/child", "older", "keep"} {
			got = append(got, MatchesTag(tag, "old", c.children))
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("children %v: got %v, want %v", c.children, got, c.want)
		}
	}
}

func TestPortedNormalizedParents(t *testing.T) {
	// "matches Unicode-normalized parents without leaving a combining mark in
	// a renamed child"
	if got := contentTags(t, "#cafe\u0301/child\n"); !reflect.DeepEqual(got, []string{"cafe\u0301/child"}) {
		t.Fatalf("got %q", got)
	}
	if !MatchesTag("cafe\u0301/child", "caf\u00e9", true) {
		t.Error("the decomposed child does not match the composed parent")
	}
}

func TestPortedTagPatterns(t *testing.T) {
	// "uses bounded wildcard selection without treating regex syntax as a glob"
	for _, c := range []struct {
		pattern, value string
		want           bool
	}{
		{"proj*/done", "Project/done", true},
		{"project/*", "project/a/b", true},
		{"project/*", "other/a", false},
	} {
		if got, err := TagPattern(c.pattern, c.value); err != nil || got != c.want {
			t.Errorf("%q %q: got %v %v, want %v", c.pattern, c.value, got, err, c.want)
		}
	}
	for _, pattern := range []string{"(a+)+$", "**"} {
		if _, err := TagPattern(pattern, "a"); err == nil {
			t.Errorf("%q: no refusal", pattern)
		}
	}
}

func TestPortedEmojiSequencesAreWholeTags(t *testing.T) {
	// "recognizes whole emoji sequences instead of amputating their modifiers"
	source := "#\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466 #\U0001f44d\U0001f3fd\n"
	want := []string{"\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466", "\U0001f44d\U0001f3fd"}
	if got := contentTags(t, source); !reflect.DeepEqual(got, want) {
		t.Errorf("got %q", got)
	}
	for _, selected := range []string{"\U0001f468", "\U0001f44d"} {
		for _, tag := range want {
			if MatchesTag(tag, selected, false) {
				t.Errorf("%q selects %q", selected, tag)
			}
		}
	}
}

func TestPortedAmbiguousFrontmatterIsRefused(t *testing.T) {
	// "refuses ambiguous or unsupported frontmatter without generating a
	// replacement": reading the tags refuses each of them too.
	for _, source := range []string{
		"---\ntags: [broken\n---\nbody",
		"---\ntags: [a]\ntags: [b]\n---\nbody",
		"---\ntags: &tags [a]\ncopy: *tags\n---\nbody",
		"---\nother: &tags [a]\ntags: *tags\n---\nbody",
		"---\ntags: {other: a}\n---\nbody",
		"---\ntags: [true]\n---\nbody",
		"---\ntitle: no closing delimiter",
	} {
		if _, err := TagOccurrences(source); codeOf(err) != "invalid_frontmatter" {
			t.Errorf("%q: got %v, want invalid_frontmatter", source, err)
		}
	}
}

func TestPortedExistingTagsCompareWithoutCase(t *testing.T) {
	// "does not create edits for an existing case-insensitive tag"
	if FoldTag("Work") != FoldTag("work") || !MatchesTag("Work", "work", false) {
		t.Error("Work and work differ")
	}
}

func TestPortedSourceEditsAreChecked(t *testing.T) {
	// "validates every exact span before returning changed content"
	for _, c := range []struct {
		edits []SourceEdit
		want  string
	}{
		{[]SourceEdit{{Start: 0, End: 6, Old: "WRONG!", Text: "lost"}}, "differ"},
		{[]SourceEdit{{Start: 0, End: 6, Old: "UNSENT", Text: "one"}, {Start: 3, End: 6, Old: "ENT", Text: "two"}}, "overlap"},
	} {
		if _, err := ApplySourceEdits("UNSENT keep", c.edits); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: got %v, want an error saying %q", c.edits, err, c.want)
		}
	}
}
