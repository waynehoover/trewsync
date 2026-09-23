package notes

import (
	"strings"
	"testing"
)

// The cases of client/src/node/mcp-notes.test.ts that are about the bytes an
// edit produces, through EditNote, AppendNote and PrependNote. The rest of
// that suite is about the before-image file, the replace, the flush and the
// races around them on a filesystem; on the server a base is a version uid, a
// before-image is the pinned previous version and a write is one
// CommitOperation, so those are the store's and the tools' to carry
// (docs/development.md, "The MCP write side's note functions").

const daily = "# Daily\r\n\r\n- [ ] Book tickets\r\n- [ ] Pack bags\r\n\r\nUNSENT: call the school\r\n"

func TestPortedPrependKeepsTheBOM(t *testing.T) {
	// "prepends exact bytes without moving the BOM or losing unsent CRLF
	// content"
	got, err := PrependNote([]byte("\ufeffUNSENT original\r\n"), "Heading\r\n")
	if err != nil || string(got.Bytes) != "\ufeffHeading\r\nUNSENT original\r\n" || got.Noop {
		t.Errorf("got %q %v %v", got.Bytes, got.Noop, err)
	}
}

func TestPortedTwoExactEditsTogether(t *testing.T) {
	// "changes two exact tasks together while preserving every unrelated
	// byte"
	input := "\ufeff---\r\ntags: [daily]\r\n---\r\n[[Family]] cafe\u0301 \U0001f600\r\n- [ ] Book tickets\r\n- [ ] Pack bags\r\nUNSENT end\r\n"
	got, err := EditNote([]byte(input), []Edit{
		{Old: "- [ ] Pack bags", New: "- [x] Pack bags"},
		{Old: "- [ ] Book tickets", New: "- [x] Book tickets"},
	})
	want := strings.NewReplacer("- [ ] Pack bags", "- [x] Pack bags", "- [ ] Book tickets", "- [x] Book tickets").Replace(input)
	if err != nil || string(got.Bytes) != want {
		t.Errorf("got %q %v, want %q", got.Bytes, err, want)
	}
}

func TestPortedRemovedProse(t *testing.T) {
	// "keeps explicitly removed unsent prose in the before-image": the edit
	// removes exactly that line. That the former bytes stay readable is the
	// pinned previous version's (M5 task 2).
	got, err := EditNote([]byte(daily), []Edit{{Old: "UNSENT: call the school\r\n", New: ""}})
	if err != nil || strings.Contains(string(got.Bytes), "UNSENT:") || string(got.Bytes) != strings.TrimSuffix(daily, "UNSENT: call the school\r\n") {
		t.Errorf("got %q %v", got.Bytes, err)
	}
}

func TestPortedEditsAreValidatedFirst(t *testing.T) {
	// "validates every edit before writing: $code", "counts overlapping
	// occurrences of an old span" and "rejects an aggregate edit budget even
	// with individually valid replacements".
	many := func(n int, old, text string) []Edit {
		out := make([]Edit, n)
		for i := range out {
			out[i] = Edit{Old: old, New: text}
		}
		return out
	}
	var budget []Edit
	var nine []string
	for i := range 9 {
		nine = append(nine, "unique-"+string(rune('0'+i)))
		budget = append(budget, Edit{Old: nine[i], New: strings.Repeat("x", EditBytes)})
	}
	for _, c := range []struct {
		name, note string
		edits      []Edit
		code       string
	}{
		{"no_match", daily, []Edit{{"- [ ] Book tickets", "done"}, {"missing", "lost"}}, "no_match"},
		{"ambiguous_edit", daily, []Edit{{"[ ]", "[x]"}}, "ambiguous_edit"},
		{"overlapping_edits", daily, []Edit{{"Book tickets", "Booked"}, {"tickets", "seats"}}, "overlapping_edits"},
		{"an empty old", daily, []Edit{{"", "blank"}}, "invalid_edits"},
		{"no edits", daily, nil, "invalid_edits"},
		{"33 edits", daily, many(33, "Book", "done"), "invalid_edits"},
		{"a new over 8 KiB", daily, []Edit{{"Book", strings.Repeat("x", EditBytes+1)}}, "input_too_large"},
		{"a lone surrogate", daily, []Edit{{"Book", "\xed\xa0\x80"}}, "invalid_text"},
		{"overlapping occurrences", "aaaa", []Edit{{"aaa", "b"}}, "ambiguous_edit"},
		{"the aggregate budget", strings.Join(nine, "\n"), budget, "input_too_large"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := EditNote([]byte(c.note), c.edits)
			if codeOf(err) != c.code || got.Bytes != nil {
				t.Errorf("got %q %v, want %s", got.Bytes, err, c.code)
			}
		})
	}
}

func TestPortedAppendAddsNoNewline(t *testing.T) {
	// "appends the supplied bytes without inventing a newline"
	got, err := AppendNote([]byte("source"), "suffix")
	if err != nil || string(got.Bytes) != "sourcesuffix" {
		t.Errorf("got %q %v", got.Bytes, err)
	}
}

func TestPortedInvalidInsertions(t *testing.T) {
	// "refuses invalid %s before writing": the source, the suffix and an
	// oversized result. The base, a digest in Basalt, is a uid the tool
	// checks against the store.
	for _, c := range []struct {
		name, note, text, code string
	}{
		{"source", "\xff\xfe", "suffix", "invalid_utf8"},
		{"suffix", "original", "\xed\xbf\xbf", "invalid_text"},
		{"oversized", strings.Repeat("x", NoteBytes), "suffix", "note_too_large"},
	} {
		for name, insert := range map[string]func([]byte, string) (Revision, error){"append": AppendNote, "prepend": PrependNote} {
			if got, err := insert([]byte(c.note), c.text); codeOf(err) != c.code || got.Bytes != nil {
				t.Errorf("%s %s: got %q %v, want %s", name, c.name, got.Bytes, err, c.code)
			}
		}
	}
}

func TestPortedNoop(t *testing.T) {
	// "reports a no-op without a backup, flush, or timestamp change": the
	// bytes are the note's own, and Noop says so, which is what lets the tool
	// write nothing.
	got, err := EditNote([]byte("unchanged"), []Edit{{Old: "unchanged", New: "unchanged"}})
	if err != nil || !got.Noop || string(got.Bytes) != "unchanged" {
		t.Errorf("got %q noop %v %v", got.Bytes, got.Noop, err)
	}
}

func TestPortedCreateContent(t *testing.T) {
	// "creates and verifies once": the content is written as given, a
	// byte-order mark and CRLF included. Refusing the retry is the store's
	// exclusive create.
	got, err := NoteContent("\ufeffnew\r\n")
	if err != nil || string(got) != "\ufeffnew\r\n" {
		t.Errorf("got %q %v", got, err)
	}
	for content, code := range map[string]string{
		"\xed\xa0\x80":                   "invalid_text",
		strings.Repeat("x", NoteBytes+1): "input_too_large",
	} {
		if _, err := NoteContent(content); codeOf(err) != code {
			t.Errorf("%s: got %v", code, err)
		}
	}
}

func TestEditResultOverOneMiB(t *testing.T) {
	// plan/mcp-tools.md: an edit whose result is over 1 MiB is
	// note_too_large. Basalt said input_too_large, and the oracle records
	// that (oracle_write_test.go, editResultTooLarge); one byte under is
	// written.
	note := strings.Repeat("x", NoteBytes-10) + "END"
	if _, err := EditNote([]byte(note), []Edit{{Old: "END", New: "END" + strings.Repeat("y", 8)}}); codeOf(err) != "note_too_large" {
		t.Errorf("one byte over: got %v", err)
	}
	got, err := EditNote([]byte(note), []Edit{{Old: "END", New: "END" + strings.Repeat("y", 7)}})
	if err != nil || len(got.Bytes) != NoteBytes {
		t.Errorf("exactly 1 MiB: got %d bytes, %v", len(got.Bytes), err)
	}
}
