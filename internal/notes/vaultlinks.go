package notes

import (
	"sort"

	"github.com/waynehoover/trew/internal/paths"
)

// The vault-health reads (backlinks, outgoing_links, broken_links, orphans):
// every link a note makes, where it is, and which notes it means, found by the
// same span reader and resolved by the same resolver a move's backlink rewrite
// uses (ChangeLinks), so a link these tools report is a link a move would
// rewrite, and a note they call unlinked is one no move would find a link to.

// linkTextUnits is how much of a link's text a row carries, in UTF-16 code
// units: a link is rarely longer, and one that is is Clipped.
const linkTextUnits = 256

// NoteLink is one link in a note to something in the vault: a Markdown link,
// image or reference definition with a destination, or a wiki link or embed.
// A link to a URL, to a heading of the same note alone ("#heading",
// "[[#heading]]"), or whose destination does not decode is not one: it names
// nothing in the vault, and ChangeLinks passes over it too.
type NoteLink struct {
	// Line and Column locate the link's first character (the "!" of an
	// embed, else the "["), as a search match is located: 1-based, the
	// column in UTF-16 code units, lines split on "\n" alone.
	Line, Column int
	// Text is the whole link as written, from Line and Column, at most 256
	// units of it; Clipped says it was cut.
	Text    string
	Clipped bool
	// Target is the name the link resolves by: its destination before any
	// "#", percent escapes decoded, which for a wiki link is the part before
	// any "|" (the alias is display text and names nothing).
	Target string
	Wiki   bool
	// Embed is set for a wiki embed (![[...]]) and a Markdown image.
	Embed bool
	// Candidates are the vault's files the link can mean, in inventory
	// order: none for a link to nothing, one for a link that resolves, and
	// several for a name several files share (an ambiguous short name).
	Candidates []string
}

// NoteLinks is every link in source, the note at owner, resolved against r,
// in document order. It refuses a note as LinkSpans does (a frontmatter
// block with no closing delimiter is invalid_frontmatter).
func NoteLinks(source, owner string, r *LinkResolver) ([]NoteLink, error) {
	spans, err := linkSpans(source)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].wholeStart < spans[j].wholeStart })
	lines := lineStarts(source)
	var out []NoteLink
	for _, s := range spans {
		name, _, ok := s.name()
		if !ok {
			continue
		}
		if full, short := linkLookups(name, s.wiki, owner); len(full) == 0 && short == "" {
			continue
		}
		line := sort.Search(len(lines), func(i int) bool { return lines[i] > s.wholeStart }) - 1
		whole := source[s.wholeStart:s.wholeEnd]
		clipped := clipUnits(whole, linkTextUnits)
		out = append(out, NoteLink{
			Line: line + 1, Column: units(source[lines[line]:s.wholeStart]) + 1,
			Text: clipped, Clipped: len(clipped) < len(whole),
			Target: name, Wiki: s.wiki, Embed: source[s.wholeStart] == '!',
			Candidates: r.Resolve(name, s.wiki, owner),
		})
	}
	return out, nil
}

// lineStarts is the byte offset of every line of s, lines split on "\n".
func lineStarts(s string) []int {
	out := []int{0}
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, i+1)
		}
	}
	return out
}

// LinksTo reports whether a link's candidates include path, compared through
// the fold the resolver resolves with.
func (l NoteLink) LinksTo(path string, canonical func(string) string) bool {
	want := canonical(path)
	for _, c := range l.Candidates {
		if canonical(c) == want {
			return true
		}
	}
	return false
}

// SourceNote is whether path is a note the vault-health reads look for links
// in: the notes a move reads for backlinks, Markdown and plain text less
// Excalidraw drawings, at a path the server accepts.
func SourceNote(path string) bool {
	return editableFormat(path) && paths.Check(path) == ""
}
