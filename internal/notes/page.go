package notes

import "strings"

// PageTextBytes is read_note's page budget, in UTF-8 bytes of note text.
const PageTextBytes = 64 * 1024

// MaxPageLines is the most lines one read_note page may ask for.
const MaxPageLines = 1000

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER, the largest line
// number Basalt accepted.
const maxSafeInteger = 1<<53 - 1

// PageResult is one page of a note.
type PageResult struct {
	// Lines are the page's lines, each with its terminator exactly as stored.
	Lines []string
	// StartLine is the requested first line, 1-based, even past the end.
	StartLine int
	// EndLine is the last line on the page: StartLine-1 for an empty page.
	EndLine int
	// NextLine is where the next page starts, or 0 when this page reaches the
	// end of the note.
	NextLine int
	// Complete reports that the page reaches the end of the note.
	Complete bool
}

// Content is the page's text, the lines joined as they were stored.
func (p PageResult) Content() string { return strings.Join(p.Lines, "") }

// Page is Basalt's pageNote without the base check, which is a version UID
// comparison in the tool now. It decodes text as DecodeNote does, then returns
// at most maxLines lines from startLine whose UTF-8 sizes sum to at most
// budget bytes.
//
// A line ends after "\n" and keeps it, so "\r\n" stays whole and a lone "\r"
// is part of its line rather than a terminator; the pages of a note joined
// together are its text byte for byte, whatever its line endings. That is the
// rule mcp-read.ts applies with /[^\n]*\n|[^\n]+$/ and records only in a
// comment ("including a trailing CR"), so it is stated here and pinned by the
// fixtures. A final line without "\n" is a line only if it is not empty.
//
// Errors, in the order Basalt checked them: note_too_large, invalid_utf8,
// invalid_limit (startLine outside 1 to 2^53-1, maxLines outside 1 to
// MaxPageLines), and line_too_large when the first line alone exceeds budget,
// which would otherwise be a continuation that never makes progress.
func Page(text []byte, startLine, maxLines, budget int) (PageResult, error) {
	source, err := DecodeNote(text)
	if err != nil {
		return PageResult{}, err
	}
	if startLine < 1 || startLine > maxSafeInteger || maxLines < 1 || maxLines > MaxPageLines {
		return PageResult{}, refuse("invalid_limit", "the requested page limit is invalid")
	}
	lines := splitLines(source)
	index := min(startLine-1, len(lines))
	var page []string
	used := 0
	for ; index < len(lines) && len(page) < maxLines; index++ {
		size := len(lines[index])
		if used+size > budget {
			if len(page) == 0 {
				return PageResult{}, refuse("line_too_large", "this line exceeds the 64 KiB page budget")
			}
			break
		}
		page = append(page, lines[index])
		used += size
	}
	result := PageResult{
		Lines:     page,
		StartLine: startLine,
		EndLine:   startLine + len(page) - 1,
		Complete:  index >= len(lines),
	}
	if index < len(lines) {
		result.NextLine = index + 1
	}
	return result, nil
}

// splitLines splits s after every "\n", keeping it, with a final line that
// has none only if it is not empty. Basalt splits read_note pages and
// compare_versions lines this way.
func splitLines(s string) []string {
	var lines []string
	for len(s) > 0 {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			lines = append(lines, s)
			break
		}
		lines = append(lines, s[:i+1])
		s = s[i+1:]
	}
	return lines
}
