package notes

import (
	"reflect"
	"strings"
	"testing"
)

// The cases of client/src/node/mcp-markdown.test.ts on the writing side:
// what ChangeTags does to each note, applied with ApplySourceEdits.
// port_markdown_test.go has the reading side of the same cases.

// retagged is the TypeScript suite's helper: the note with the change applied.
func retagged(t *testing.T, source string, c TagChange) string {
	t.Helper()
	te, err := ChangeTags(source, c)
	if err != nil {
		t.Fatalf("%q %+v: %v", source, c, err)
	}
	out, err := ApplySourceEdits(source, te.Edits)
	if err != nil {
		t.Fatalf("%q %+v: %v", source, c, err)
	}
	return out
}

func TestPortedTagEditKeepsYAMLBOMAndCRLF(t *testing.T) {
	// "edits only the tags value and retains unrelated YAML, BOM, CRLF, body
	// and comments"
	before := "\ufeff---\r\ntitle:  \"Keep these spaces\" # title comment\r\ntags: [old, Keep] # tag comment\r\n" +
		"other: &value {x: 1}\r\ncopy: *value\r\n---\r\nUNSENT caf\u00e9 \U0001f600\r\n"
	if got := retagged(t, before, TagChange{Operation: "add", Tags: []string{"new"}}); got != strings.Replace(before, "[old, Keep]", `["old","Keep","new"]`, 1) {
		t.Errorf("add: got %q", got)
	}
	if got := retagged(t, before, TagChange{Operation: "remove", Tags: []string{"OLD"}}); got != strings.Replace(before, "[old, Keep]", `["Keep"]`, 1) {
		t.Errorf("remove: got %q", got)
	}
}

func TestPortedTagEditKeepsBlockListComments(t *testing.T) {
	// "retains comments within a block tags list when removing a tag"
	before := "---\ntitle:  unchanged\ntags:\n  - old # first\n  # middle\n  - keep\nnext: unchanged\n---\nUNSENT\n"
	want := "---\ntitle:  unchanged\ntags:\n  [\"keep\"]\n  # first\n  # middle\nnext: unchanged\n---\nUNSENT\n"
	if got := retagged(t, before, TagChange{Operation: "remove", Tags: []string{"old"}}); got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedTagEditAddsFrontmatter(t *testing.T) {
	// "adds frontmatter tags without rewriting the rest: %s"
	for _, c := range []struct{ before, after string }{
		{"\ufeffBody\r\n", "\ufeff---\r\ntags: [\"new\"]\r\n---\r\nBody\r\n"},
		{"---\ntitle: raw\n---", "---\ntitle: raw\ntags: [\"new\"]\n---"},
		{"---\ntags:\n# keep\n---\nbody", "---\ntags: [\"new\"]\n# keep\n---\nbody"},
	} {
		if got := retagged(t, c.before, TagChange{Operation: "add", Tags: []string{"new"}}); got != c.after {
			t.Errorf("%q: got %q, want %q", c.before, got, c.after)
		}
	}
}

func TestPortedTagEditSkipsCodeCommentsAndLinks(t *testing.T) {
	// "does not touch code, comments, link destinations, escapes or numeric
	// hashtags"
	source := "#keep #\u5de5\u4f5c/\u5f53\u524d #\U0001f600\n`#ignore` ``#ignore ` nested``\n\\#ignore 123#ignore #123\n" +
		"<!-- #ignore\n#ignore -->\n%% #ignore %%\n[[note#ignore]] [note](note#ignore)\n````\n```\n#ignore\n````\n" +
		"~~~\n#ignore\n~~~\n    #ignore\n"
	want := strings.Replace(source, "#keep #\u5de5\u4f5c/\u5f53\u524d #\U0001f600", "  ", 1)
	if got := retagged(t, source, TagChange{Operation: "remove", Patterns: []string{"*"}}); got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedTagEditKeepsURLFragments(t *testing.T) {
	// "never removes a URL fragment while changing tags"
	for _, source := range []string{
		"[link](https://example.test/a(b)#old)\nUNSENT\n",
		"[link]: https://example.test/a(b)#old\nUNSENT\n",
		"<https://example.test/a(b)#old>\nUNSENT\n",
	} {
		if got := retagged(t, source, TagChange{Operation: "remove", Tags: []string{"old"}}); got != source {
			t.Errorf("%q: got %q", source, got)
		}
	}
}

func TestPortedTagEditAfterCodeWithPercents(t *testing.T) {
	// "does not start a comment from code"
	for _, source := range []string{"`%%`\n#old\n", "```\n%%\n```\n#old\n"} {
		if got := retagged(t, source, TagChange{Operation: "rename", OldTag: "old", NewTag: "new"}); got != strings.Replace(source, "#old", "#new", 1) {
			t.Errorf("%q: got %q", source, got)
		}
	}
}

func TestPortedTagEditNestedTags(t *testing.T) {
	// "matches nested tags by segment and preserves unselected descendants"
	source := "#old #OLD/child #older #keep\n"
	for _, c := range []struct {
		change TagChange
		want   string
	}{
		{TagChange{Operation: "remove", Tags: []string{"old"}}, " #OLD/child #older #keep\n"},
		{TagChange{Operation: "remove", Tags: []string{"old"}, IncludeChildren: true}, "  #older #keep\n"},
		{TagChange{Operation: "rename", OldTag: "old", NewTag: "new", IncludeChildren: true}, "#new #new/child #older #keep\n"},
	} {
		if got := retagged(t, source, c.change); got != c.want {
			t.Errorf("%+v: got %q, want %q", c.change, got, c.want)
		}
	}
}

func TestPortedTagEditNormalizedParent(t *testing.T) {
	// "matches Unicode-normalized parents without leaving a combining mark in
	// a renamed child"
	got := retagged(t, "#cafe\u0301/child\n", TagChange{Operation: "rename", OldTag: "caf\u00e9", NewTag: "new", IncludeChildren: true})
	if got != "#new/child\n" {
		t.Errorf("got %q", got)
	}
}

func TestPortedTagEditBodyAtEitherEnd(t *testing.T) {
	// "preserves the body byte-for-byte when adding inline tags at either end"
	source := "\ufeff---\r\ntitle: unchanged\r\n---\r\nUNSENT"
	start := TagChange{Operation: "add", Tags: []string{"New_Tag"}, Location: "content", Position: "start", Normalization: "kebab"}
	if got := retagged(t, source, start); got != strings.Replace(source, "UNSENT", "#new-tag\r\nUNSENT", 1) {
		t.Errorf("start: got %q", got)
	}
	if got := retagged(t, source, TagChange{Operation: "add", Tags: []string{"new"}, Location: "content"}); got != source+"\r\n#new\r\n" {
		t.Errorf("end: got %q", got)
	}
}

func TestPortedTagEditRefusesHiddenInsertions(t *testing.T) {
	// "refuses an inline addition hidden inside an unterminated fenced
	// block" and "checks the requested tag location even when another
	// location already contains that tag"
	for _, source := range []string{"body\n```\ncode\n", "---\ntags: [new]\n---\n```\ncode\n"} {
		_, err := ChangeTags(source, TagChange{Operation: "add", Tags: []string{"new"}, Location: "content"})
		if codeOf(err) != "invalid_tag_location" || !strings.Contains(err.Error(), "inside code") {
			t.Errorf("%q: got %v", source, err)
		}
	}
}

func TestPortedTagEditWholeEmoji(t *testing.T) {
	// "recognizes whole emoji sequences instead of amputating their
	// modifiers"
	source := "#\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466 #\U0001f44d\U0001f3fd\n"
	if got := retagged(t, source, TagChange{Operation: "remove", Tags: []string{"\U0001f468", "\U0001f44d"}}); got != source {
		t.Errorf("remove: got %q", got)
	}
	got := retagged(t, source, TagChange{Operation: "rename", OldTag: "\U0001f44d\U0001f3fd", NewTag: "done"})
	if want := "#\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466 #done\n"; got != want {
		t.Errorf("rename: got %q", got)
	}
}

func TestPortedTagEditRefusesAmbiguousFrontmatter(t *testing.T) {
	// "refuses ambiguous or unsupported frontmatter without generating a
	// replacement"
	for _, source := range []string{
		"---\ntags: [broken\n---\nbody",
		"---\ntags: [a]\ntags: [b]\n---\nbody",
		"---\ntags: &tags [a]\ncopy: *tags\n---\nbody",
		"---\nother: &tags [a]\ntags: *tags\n---\nbody",
		"---\ntags: {other: a}\n---\nbody",
		"---\ntags: [true]\n---\nbody",
		"---\ntitle: no closing delimiter",
	} {
		if te, err := ChangeTags(source, TagChange{Operation: "add", Tags: []string{"new"}}); err == nil {
			t.Errorf("%q: no refusal, edits %+v", source, te.Edits)
		}
	}
}

func TestPortedTagEditExistingTag(t *testing.T) {
	// "does not create edits for an existing case-insensitive tag"
	te, err := ChangeTags("---\ntags: [Work]\n---\nbody", TagChange{Operation: "add", Tags: []string{"work"}})
	if err != nil || len(te.Edits) != 0 || len(te.Changed) != 0 {
		t.Errorf("got %+v %v", te, err)
	}
}

func TestTagEditChanged(t *testing.T) {
	// Changed names each tag once, in the order met: a rename's old
	// spellings, then an addition's new tags.
	te, err := ChangeTags("---\ntags: [old, OLD/x]\n---\n#old #Old/y\n",
		TagChange{Operation: "rename", OldTag: "old", NewTag: "new", IncludeChildren: true})
	if err != nil || !reflect.DeepEqual(te.Changed, []string{"old", "OLD/x", "Old/y"}) {
		t.Errorf("rename: got %q %v", te.Changed, err)
	}
	te, err = ChangeTags("#a\n", TagChange{Operation: "add", Tags: []string{"b", "a", "c"}, Location: "both"})
	if err != nil || !reflect.DeepEqual(te.Changed, []string{"b", "a", "c"}) {
		t.Errorf("add: got %q %v", te.Changed, err)
	}
}
