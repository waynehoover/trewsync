package notes

import (
	"bytes"
	"sort"
	"strings"
	"unicode/utf8"
)

// The bounds on what an agent writes, in UTF-8 bytes (plan/mcp-tools.md,
// "Schema primitives"), as Basalt's mcp-notes.ts set them.
const (
	// EditBytes is the most one exact edit's old or new text may hold.
	EditBytes = 8 << 10
	// InputBytes is the most the edits of one edit_note call may hold
	// together, and the most text append_note or prepend_note inserts.
	InputBytes = 64 << 10
	// MaxEdits is the most exact edits one edit_note call makes.
	MaxEdits = 32
)

// Edit is one exact edit: Old must occur exactly once in the note, and New
// replaces it.
type Edit struct {
	Old string `json:"old"`
	New string `json:"new"`
}

// Revision is a note's new bytes. Noop reports that they are the bytes it
// already had: nothing is written, though the tool still revalidates the base
// at the commit boundary (PLAN.md section 4.3).
type Revision struct {
	Bytes []byte
	Noop  bool
}

// CheckText is Basalt's inputText: text an agent supplied, refused as
// invalid_text unless it is UTF-8, and as input_too_large when it is over
// limit bytes. JSON can carry a lone surrogate and UTF-8 cannot, so one
// reaches Go only as bytes that are not UTF-8, which is what this refuses.
func CheckText(text string, limit int) error {
	if !utf8.ValidString(text) {
		return refuse("invalid_text", "text must contain valid Unicode without unpaired surrogates")
	}
	if len(text) > limit {
		return refuse("input_too_large", "the supplied text exceeds its byte limit")
	}
	return nil
}

// NoteContent is create_note's check on a new note's content: text of at most
// NoteBytes, as CheckText refuses it.
func NoteContent(content string) ([]byte, error) {
	if err := CheckText(content, NoteBytes); err != nil {
		return nil, err
	}
	return []byte(content), nil
}

// EditNote is Basalt's replacement, for edit_note: the note with every edit
// applied, each Old located in the note as it was read, so one edit never
// sees another's result.
//
// Refusals, in the order Basalt checked them: the note (note_too_large,
// invalid_utf8, as DecodeNote); between 1 and MaxEdits edits (invalid_edits);
// then edit by edit, its Old and New as CheckText refuses them with EditBytes
// as the limit, an empty Old (invalid_edits), an Old that does not occur
// (no_match) or occurs more than once, overlapping occurrences included
// (ambiguous_edit); every Old and New together over InputBytes
// (input_too_large); two edits whose spans overlap (overlapping_edits; spans
// that only touch do not); and a result over NoteBytes (note_too_large).
//
// That last code is plan/mcp-tools.md's, where Basalt reported
// input_too_large; oracle_test.go holds the fixture to Basalt's code and this
// function to the spec's.
func EditNote(before []byte, edits []Edit) (Revision, error) {
	source, err := DecodeNote(before)
	if err != nil {
		return Revision{}, err
	}
	if len(edits) < 1 || len(edits) > MaxEdits {
		return Revision{}, refuse("invalid_edits", "supply between 1 and 32 exact edits")
	}
	type span struct {
		start, end int
		text       string
	}
	spans := make([]span, 0, len(edits))
	input := 0
	for _, e := range edits {
		if err := CheckText(e.Old, EditBytes); err != nil {
			return Revision{}, err
		}
		if err := CheckText(e.New, EditBytes); err != nil {
			return Revision{}, err
		}
		input += len(e.Old) + len(e.New)
		if e.Old == "" {
			return Revision{}, refuse("invalid_edits", "an old span cannot be empty")
		}
		start := strings.Index(source, e.Old)
		if start < 0 {
			return Revision{}, refuse("no_match", "an old span does not occur in the source; read and reconsider")
		}
		// Searching again from the next byte finds an overlapping second
		// occurrence ("aaa" in "aaaa"): Old begins with a whole character,
		// so it can only match where one begins, as it did from the next
		// UTF-16 unit in Basalt.
		if indexFrom(source, e.Old, start+1) >= 0 {
			return Revision{}, refuse("ambiguous_edit", "an old span occurs more than once; include unique surrounding text")
		}
		spans = append(spans, span{start, start + len(e.Old), e.New})
	}
	if input > InputBytes {
		return Revision{}, refuse("input_too_large", "the combined edit input exceeds 64 KiB")
	}
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	for i := 1; i < len(spans); i++ {
		if spans[i].start < spans[i-1].end {
			return Revision{}, refuse("overlapping_edits", "the edits overlap in the original source")
		}
	}
	var b bytes.Buffer
	at := 0
	for _, s := range spans {
		b.WriteString(source[at:s.start])
		b.WriteString(s.text)
		at = s.end
	}
	b.WriteString(source[at:])
	if b.Len() > NoteBytes {
		return Revision{}, tooLargeResult()
	}
	return revision(before, b.Bytes()), nil
}

// AppendNote is append_note's write: the note's bytes and then text, with no
// separator added. The note is refused as DecodeNote refuses it, text as
// CheckText refuses it with InputBytes as the limit or when it is empty
// (invalid_text), and a result over NoteBytes is note_too_large.
func AppendNote(before []byte, text string) (Revision, error) {
	if err := checkInsertion(before, text); err != nil {
		return Revision{}, err
	}
	return inserted(before, len(before), text)
}

// PrependNote is prepend_note's write: text before the note's bytes, after a
// leading byte-order mark when the note has one, so the mark stays first.
// Refusals are AppendNote's.
func PrependNote(before []byte, text string) (Revision, error) {
	if err := checkInsertion(before, text); err != nil {
		return Revision{}, err
	}
	at := 0
	if bytes.HasPrefix(before, []byte("\ufeff")) {
		at = len("\ufeff")
	}
	return inserted(before, at, text)
}

func checkInsertion(before []byte, text string) error {
	if _, err := DecodeNote(before); err != nil {
		return err
	}
	if err := CheckText(text, InputBytes); err != nil {
		return err
	}
	if text == "" {
		return refuse("invalid_text", "inserted text cannot be empty")
	}
	return nil
}

func inserted(before []byte, at int, text string) (Revision, error) {
	if len(before)+len(text) > NoteBytes {
		return Revision{}, tooLargeResult()
	}
	out := make([]byte, 0, len(before)+len(text))
	out = append(out, before[:at]...)
	out = append(out, text...)
	out = append(out, before[at:]...)
	return revision(before, out), nil
}

func tooLargeResult() error {
	return refuse("note_too_large", "the resulting note exceeds 1 MiB")
}

func revision(before, after []byte) Revision {
	return Revision{Bytes: after, Noop: bytes.Equal(before, after)}
}
