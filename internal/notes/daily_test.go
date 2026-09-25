package notes

import (
	"testing"
	"time"
)

func TestFormatDateWritesMomentTokens(t *testing.T) {
	at := time.Date(2026, 9, 5, 14, 7, 3, 0, time.UTC) // a Saturday, ISO week 36
	cases := []struct{ format, want string }{
		{"YYYY-MM-DD", "2026-09-05"},
		{"YY/M/D", "26/9/5"},
		{"dddd, MMMM Do YYYY", "Saturday, September 5th 2026"},
		{"ddd MMM DD", "Sat Sep 05"},
		{"dd d E", "Sa 6 6"},
		{"GGGG-[W]WW", "2026-W36"},
		{"DDDD DDD Q", "248 248 3"},
		{"HH:mm:ss", "14:07:03"},
		{"h:mm A, hh a, k kk", "2:07 PM, 02 pm, 14 14"},
		{"[Daily] YYYY", "Daily 2026"},
		{"YYYY/MM/YYYY-MM-DD", "2026/09/2026-09-05"},
		{"YYYY-MM-DDTHH", "2026-09-05T14"},
	}
	for _, c := range cases {
		got, err := FormatDate(at, c.format)
		if err != nil || got != c.want {
			t.Errorf("%q: %q, %v; want %q", c.format, got, err, c.want)
		}
	}
	for _, d := range []struct {
		day  int
		want string
	}{{1, "1st"}, {2, "2nd"}, {3, "3rd"}, {4, "4th"}, {11, "11th"}, {12, "12th"}, {13, "13th"}, {21, "21st"}, {22, "22nd"}, {23, "23rd"}, {31, "31st"}} {
		if got, _ := FormatDate(time.Date(2026, 1, d.day, 0, 0, 0, 0, time.UTC), "Do"); got != d.want {
			t.Errorf("day %d: %q", d.day, got)
		}
	}
	midnight, _ := FormatDate(time.Date(2026, 1, 1, 0, 30, 0, 0, time.UTC), "h A k")
	if midnight != "12 AM 24" {
		t.Errorf("midnight: %q", midnight)
	}
	for _, bad := range []string{"", "gggg", "wo", "YYYY Z", "X", "LL", "YYY", "Y", "[open", "SSS"} {
		if _, err := FormatDate(at, bad); refusalCode(err) != "invalid_format" {
			t.Errorf("%q: %v, want invalid_format", bad, err)
		}
	}
}

func TestParseDay(t *testing.T) {
	loc := time.FixedZone("plus10", 10*3600)
	now := time.Date(2026, 9, 5, 20, 0, 0, 0, time.UTC) // 06:00 on the 6th at +10
	for in, want := range map[string]string{"": "2026-09-06", "today": "2026-09-06", "yesterday": "2026-09-05",
		"tomorrow": "2026-09-07", "2024-02-29": "2024-02-29"} {
		got, err := ParseDay(in, now, loc)
		if err != nil || got.Format("2006-01-02") != want || got.Location() != loc || got.Hour() != 0 {
			t.Errorf("%q: %v %v, want %s", in, got, err, want)
		}
	}
	for _, bad := range []string{"2026-02-30", "2026-9-5", "05/09/2026", "now"} {
		if _, err := ParseDay(bad, now, loc); refusalCode(err) != "invalid_arguments" {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestRenderTemplateFillsObsidiansPlaceholders(t *testing.T) {
	tpl := Template{
		Title: "Standup", Date: time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC),
		Now: time.Date(2026, 9, 6, 9, 30, 0, 0, time.UTC), DateFormat: DefaultDateFormat, TimeFormat: DefaultTimeFormat,
		Variables: map[string]string{"project": "Trew", "who": "{{title}}"},
	}
	cases := []struct{ in, want string }{
		{"# {{title}}\n", "# Standup\n"},
		{"{{date}} {{time}}", "2026-09-05 09:30"},
		{"{{DATE}} {{ Time }}", "2026-09-05 09:30"},
		{"{{date:dddd}} {{time:h A}}", "Saturday 9 AM"},
		{"{{ date : YYYY }}", "2026"},
		{"{{project}} by {{who}}", "Trew by {{title}}"},
		{"{{Project}} {{unknown}} {{project:x}} <% tp.date %>", "{{Project}} {{unknown}} {{project:x}} <% tp.date %>"},
		{"{{title:upper}} {{", "{{title:upper}} {{"},
	}
	for _, c := range cases {
		got, err := RenderTemplate(c.in, tpl)
		if err != nil || got != c.want {
			t.Errorf("%q: %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	if _, err := RenderTemplate("{{date:gggg}}", tpl); refusalCode(err) != "invalid_template" {
		t.Errorf("an unsupported format: %v", err)
	}
	if Title("daily/2026-09-05.md") != "2026-09-05" || Title("a.b.txt") != "a.b" {
		t.Error("Title")
	}
}

func TestAppendUnderHeading(t *testing.T) {
	cases := []struct {
		name, note, heading, text, want string
	}{
		{"before the next heading of the same level", "# Day\n## Tasks\n- a\n## Notes\nx\n", "## Tasks", "- b",
			"# Day\n## Tasks\n- a\n- b\n## Notes\nx\n"},
		{"the blank lines before the next heading stay there", "## Tasks\n- a\n\n\n## Notes\n", "## Tasks", "- b\n",
			"## Tasks\n- a\n- b\n\n\n## Notes\n"},
		{"past a deeper heading", "## Tasks\n- a\n### Later\n- c\n## Notes\n", "## Tasks", "- b",
			"## Tasks\n- a\n### Later\n- c\n- b\n## Notes\n"},
		{"to a higher heading", "## Tasks\n- a\n# Next\n", "## Tasks", "- b", "## Tasks\n- a\n- b\n# Next\n"},
		{"at the end of the note", "## Tasks\n- a\n", "## Tasks", "- b\n", "## Tasks\n- a\n- b\n"},
		{"at the end of a note with no final newline", "## Tasks\n- a", "## Tasks", "- b", "## Tasks\n- a\n- b"},
		{"an empty section", "## Tasks\n## Notes\n", "## Tasks", "- b", "## Tasks\n- b\n## Notes\n"},
		{"a heading on the last line", "# Day\n## Tasks", "## Tasks", "- b", "# Day\n## Tasks\n- b"},
		{"a heading-shaped line in code is not a heading", "## Tasks\n```\n## Notes\n```\n## Notes\n", "## Tasks", "- b",
			"## Tasks\n```\n## Notes\n```\n- b\n## Notes\n"},
		{"a setext heading ends the section", "## Tasks\n- a\n\nNotes\n=====\n", "## Tasks", "- b",
			"## Tasks\n- a\n- b\n\nNotes\n=====\n"},
		{"a setext heading of a lower level does not", "# Day\nx\n\nSub\n---\ny\n# Next\n", "# Day", "- b",
			"# Day\nx\n\nSub\n---\ny\n- b\n# Next\n"},
		{"an empty heading ends the section", "## Tasks\n- a\n##\nx\n", "## Tasks", "- b", "## Tasks\n- a\n- b\n##\nx\n"},
		{"CRLF", "## Tasks\r\n- a\r\n## Notes\r\n", "## Tasks", "- b", "## Tasks\r\n- a\r\n- b\r\n## Notes\r\n"},
		{"after frontmatter", "---\ntitle: x\n---\n## Tasks\n", "## Tasks", "- b", "---\ntitle: x\n---\n## Tasks\n- b"},
		{"a closing sequence is part of the line", "## Tasks ##\n- a\n", "## Tasks ##", "- b", "## Tasks ##\n- a\n- b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rev, err := AppendUnderHeading([]byte(c.note), c.heading, c.text)
			if err != nil || string(rev.Bytes) != c.want {
				t.Fatalf("%q, %v\nwant %q", rev.Bytes, err, c.want)
			}
		})
	}
	refusals := []struct{ name, note, heading, code string }{
		{"absent", "## Tasks\n", "## Notes", "no_match"},
		{"not exact", "## Tasks  \n", "## Tasks", "no_match"},
		{"another level", "### Tasks\n", "## Tasks", "no_match"},
		{"only in code", "```\n## Tasks\n```\n", "## Tasks", "no_match"},
		{"only in a list", "- ## Tasks\n", "## Tasks", "no_match"},
		{"twice", "## Tasks\n## Tasks\n", "## Tasks", "ambiguous_edit"},
		{"not a heading", "Tasks\n", "Tasks", "invalid_arguments"},
		{"two lines", "## A\n", "## A\n## B", "invalid_arguments"},
		{"unclosed frontmatter", "---\ntitle: x\n## Tasks\n", "## Tasks", "invalid_frontmatter"},
	}
	for _, c := range refusals {
		if _, err := AppendUnderHeading([]byte(c.note), c.heading, "- b"); refusalCode(err) != c.code {
			t.Errorf("%s: %v, want %s", c.name, err, c.code)
		}
	}
}

func TestAppendLines(t *testing.T) {
	for _, c := range []struct{ note, text, want string }{
		{"", "- a", "- a"},
		{"x\n", "- a", "x\n- a"},
		{"x", "- a\n", "x\n- a\n"},
		{"x\r\ny", "- a", "x\r\ny\r\n- a"},
	} {
		rev, err := AppendLines([]byte(c.note), c.text)
		if err != nil || string(rev.Bytes) != c.want {
			t.Errorf("%q + %q: %q, %v", c.note, c.text, rev.Bytes, err)
		}
	}
}

func TestNoteLinksLocatesAndResolves(t *testing.T) {
	inventory := []string{"a.md", "sub/b.md", "other/b.md", "img.png", "dir/c.md"}
	r := NewLinkResolver(inventory, func(s string) string { return s })
	source := "---\ntags: [x]\n---\nsee [[a]] and [[b|the b]] ![[img.png]]\n" +
		"é [md](dir/c.md#h) [web](https://x.y) [[#here]] [[gone]] `[[code]]`\n" +
		"![pic](img.png) [enc](dir%2Fc.md)\n"
	links, err := NoteLinks(source, "dir/c.md", r)
	if err != nil {
		t.Fatal(err)
	}
	type want struct {
		line, col int
		text      string
		n         int
		embed     bool
	}
	wants := []want{
		{4, 5, "[[a]]", 1, false}, {4, 15, "[[b|the b]]", 2, false}, {4, 27, "![[img.png]]", 1, true},
		{5, 3, "[md](dir/c.md#h)", 0, false}, {5, 49, "[[gone]]", 0, false},
		{6, 1, "![pic](img.png)", 0, true}, {6, 17, "[enc](dir%2Fc.md)", 0, false},
	}
	if len(links) != len(wants) {
		t.Fatalf("%d links: %+v", len(links), links)
	}
	for i, w := range wants {
		l := links[i]
		if l.Line != w.line || l.Column != w.col || l.Text != w.text || len(l.Candidates) != w.n || l.Embed != w.embed {
			t.Errorf("link %d: %+v, want %+v", i, l, w)
		}
	}
	// Markdown links are relative to the note: from dir/, dir/c.md is
	// dir/dir/c.md, which is not there, and img.png is dir/img.png.
	if links[1].Target != "b" || !links[1].LinksTo("sub/b.md", func(s string) string { return s }) {
		t.Errorf("the alias is display text: %+v", links[1])
	}
	top, _ := NoteLinks("[md](dir/c.md) [[sub/b]]", "top.md", r)
	if len(top) != 2 || len(top[0].Candidates) != 1 || top[1].Candidates[0] != "sub/b.md" {
		t.Errorf("from the root: %+v", top)
	}
}
