package notes

import (
	"strings"
	"unicode/utf8"
)

// SearchMode is what search_notes matches against.
type SearchMode string

// The modes, as the tool's schema names them.
const (
	ModeContent  SearchMode = "content"
	ModeFilename SearchMode = "filename"
	ModeBoth     SearchMode = "both"
	ModeTag      SearchMode = "tag"
)

// The per-match clips mcp-read.ts applies, in UTF-16 code units.
const (
	hitLead     = 256  // an excerpt starts at most this far before its match
	hitUnits    = 1024 // and is at most this long
	contextUnit = 256  // each context line is at most this long
)

// MaxContextLines is the most lines of context a match may carry each side.
const MaxContextLines = 3

// SearchFiles and SearchBytes are Basalt's scan budget for one page: after
// this many notes, or once this many bytes of text have been read, the page
// ends and a cursor resumes it. SearchPage keeps them; the tool decides
// whether an index lets it propose fewer candidates.
const (
	SearchFiles = 512
	SearchBytes = 8 << 20
)

// MaxQueryBytes is the longest query, in UTF-8 bytes, as text(1024) allows.
const MaxQueryBytes = 1024

// MaxSearchLimit is the most matches one search page may ask for.
const MaxSearchLimit = 200

// Query is one search_notes request, as far as the matching is concerned.
type Query struct {
	Text            string
	Mode            SearchMode
	CaseSensitive   bool
	ContextLines    int
	IncludeChildren bool
}

// Match is one hit in a note. For content matches Line and Column (1-based,
// the column in UTF-16 code units, as Basalt counted it) locate the first
// character of the match, lines being split on "\n" alone. Text is the line it
// starts on, from at most 256 units before the match and at most 1,024 units
// long; Before and After are up to ContextLines neighbouring lines, each at
// most 256 units. A carriage return before the "\n" stays at the end of its
// line, as it did in Basalt. Clipped reports that any of those was cut.
//
// A file-name match has Line 0, Column 1, the whole path as Text and Kind
// "filename"; a tag match has Kind "tag" and locates the tag.
type Match struct {
	Line    int
	Column  int
	Text    string
	Before  []string
	After   []string
	Clipped bool
	Kind    string
}

// check is the validation mcp-read.ts applies to a query before it reads
// anything, in its order: text of at most MaxQueryBytes without unpaired
// surrogates (a Go string that is not UTF-8 is the only way to carry one), not
// empty, a page limit of 1 to MaxSearchLimit when limit is not 0, a context
// of 0 to MaxContextLines, a known mode, and in tag mode a valid tag, which
// it returns.
func (q Query) check(limit int) (string, error) {
	if !utf8.ValidString(q.Text) {
		return "", refuse("invalid_text", "text must contain valid Unicode without unpaired surrogates")
	}
	if len(q.Text) > MaxQueryBytes {
		return "", refuse("input_too_large", "the supplied text exceeds its byte limit")
	}
	if q.Text == "" {
		return "", refuse("invalid_query", "the search literal cannot be empty")
	}
	if limit != 0 && (limit < 1 || limit > MaxSearchLimit) {
		return "", refuse("invalid_limit", "the requested page limit is invalid")
	}
	if q.ContextLines < 0 || q.ContextLines > MaxContextLines {
		return "", refuse("invalid_limit", "the requested page limit is invalid")
	}
	switch q.Mode {
	case ModeContent, ModeFilename, ModeBoth:
		return "", nil
	case ModeTag:
		return ValidateTag(q.Text)
	}
	return "", refuse("invalid_query", "unknown search mode")
}

// NoteMatches is the per-note half of Basalt's search: every content or tag
// match of q in one note's text, in order. It returns nothing in filename
// mode, where only NameMatches applies. In tag mode it returns the errors
// TagOccurrences does, which Basalt reported as a skipped note.
//
// Content matching is Basalt's: the query is an escaped literal, matched
// left to right without overlaps, case-insensitively unless CaseSensitive,
// with the simple case folding JavaScript's /iu flags use. The search index
// only proposes candidate notes; this function decides what matches.
func NoteMatches(source string, q Query) ([]Match, error) {
	tag, err := q.check(0)
	if err != nil {
		return nil, err
	}
	var starts []int
	switch q.Mode {
	case ModeFilename:
		return nil, nil
	case ModeTag:
		occurrences, err := tagOccurrences(source)
		if err != nil {
			return nil, err
		}
		seen := map[int]bool{}
		for _, o := range occurrences {
			if !seen[o.start] && MatchesTag(o.Tag, tag, q.IncludeChildren) {
				seen[o.start] = true
				starts = append(starts, o.start)
			}
		}
	default:
		starts = literalMatches(source, q.Text, q.CaseSensitive)
	}
	if len(starts) == 0 {
		return nil, nil
	}
	lines := strings.Split(source, "\n")
	lineStart := make([]int, len(lines))
	for i, at := 1, 0; i < len(lines); i++ {
		at += len(lines[i-1]) + 1
		lineStart[i] = at
	}
	kind := ""
	if q.Mode == ModeTag {
		kind = "tag"
	}
	matches := make([]Match, 0, len(starts))
	line := 0
	for _, at := range starts {
		for line+1 < len(lines) && lineStart[line+1] <= at {
			line++
		}
		raw := lines[line]
		col := units(raw[:at-lineStart[line]])
		from := byteAtUnit(raw, max(0, col-hitLead))
		m := Match{
			Line:   line + 1,
			Column: col + 1,
			Text:   clipUnits(raw[from:], hitUnits),
			Kind:   kind,
		}
		m.Clipped = from > 0 || len(m.Text) < len(raw)
		for _, l := range lines[max(0, line-q.ContextLines):line] {
			c := clipUnits(l, contextUnit)
			m.Clipped = m.Clipped || len(c) < len(l)
			m.Before = append(m.Before, c)
		}
		for _, l := range lines[line+1 : min(len(lines), line+1+q.ContextLines)] {
			c := clipUnits(l, contextUnit)
			m.Clipped = m.Clipped || len(c) < len(l)
			m.After = append(m.After, c)
		}
		matches = append(matches, m)
	}
	return matches, nil
}

// NameMatches reports whether the query matches the last segment of path, the
// file-name half of filename and both modes.
func NameMatches(path string, q Query) bool {
	if _, err := q.check(0); err != nil || (q.Mode != ModeFilename && q.Mode != ModeBoth) {
		return false
	}
	name := path[strings.LastIndexByte(path, '/')+1:]
	return len(literalMatches(name, q.Text, q.CaseSensitive)) > 0
}

// literalMatches is String.prototype.matchAll with an escaped literal: the
// byte offset of every match, leftmost first, each search resuming where the
// previous match ended.
func literalMatches(source, query string, caseSensitive bool) []int {
	var starts []int
	if caseSensitive {
		for at := 0; at <= len(source); {
			i := strings.Index(source[at:], query)
			if i < 0 {
				break
			}
			starts = append(starts, at+i)
			at += i + len(query)
		}
		return starts
	}
	// Fold both sides character by character, remembering where each folded
	// character came from; folding keeps the character count but not always
	// the byte count (U+212A KELVIN SIGN folds to K).
	needle := foldString(query, nil)
	var origin []int
	hay := foldString(source, &origin)
	for at := 0; at <= len(hay); {
		i := strings.Index(hay[at:], needle)
		if i < 0 {
			break
		}
		starts = append(starts, origin[at+i])
		at += i + len(needle)
	}
	return starts
}

// foldString maps every character of s through foldRune. When origin is not
// nil it receives, for every byte of the result, the offset in s of the
// character that byte came from.
func foldString(s string, origin *[]int) string {
	var b strings.Builder
	b.Grow(len(s))
	for i, r := range s {
		f := foldRune(r)
		n := b.Len()
		b.WriteRune(f)
		if origin != nil {
			for k := n; k < b.Len(); k++ {
				*origin = append(*origin, i)
			}
		}
	}
	if origin != nil {
		*origin = append(*origin, len(s))
	}
	return b.String()
}

// MatchSize is Buffer.byteLength(JSON.stringify(row)) for the row Basalt built
// from a match: {path, line, column, text, before, after, clipped, kind?}.
// Pages are bounded by it, so it has to be measured the way Basalt measured.
func MatchSize(path string, m Match) int {
	n := len(`{"path":,"line":,"column":,"text":,"before":,"after":,"clipped":}`) +
		jsStringSize(path) + jsIntSize(m.Line) + jsIntSize(m.Column) + jsStringSize(m.Text) +
		jsStringsSize(m.Before) + jsStringsSize(m.After) + jsBoolSize(m.Clipped)
	if m.Kind != "" {
		n += len(`,"kind":`) + jsStringSize(m.Kind)
	}
	return n
}

// Candidate is one note a search page may scan, in the order the page visits
// them. Load returns its bytes, or the refusal that stands for them (the
// store's failure to assemble a note, say); it is called only when the page
// reaches the note and needs its text.
type Candidate struct {
	Path string
	Load func() ([]byte, error)
}

// PathMatch is a match and the note it is in.
type PathMatch struct {
	Path string
	Match
}

// Skipped is a note a page could not search, and why.
type Skipped struct {
	Path string
	Why  string
}

// SearchResult is one page of matches.
type SearchResult struct {
	Matches []PathMatch
	// Next is where the next page resumes, or nil when there is none.
	Next         *Position
	Scanned      int
	ScannedBytes int
	Skipped      []Skipped
	// Complete reports that no page follows and no candidate was skipped.
	Complete bool
}

// SearchPage is the page loop of Basalt's search over candidates the caller
// has already chosen and ordered: notes whose path is not before after.Path,
// excluding folders and formats that are not searched. It keeps Basalt's rules
// exactly: a page holds at most limit matches and PageTextBytes of serialised
// rows; it scans at most SearchFiles notes, and stops reading new notes after
// SearchBytes once it has made progress; a note that cannot be decoded (or,
// in tag mode, whose frontmatter cannot be parsed) is skipped with its reason
// and never stops the page; and resuming from after skips what the previous
// page returned in that note, including its file-name row.
func SearchPage(candidates []Candidate, q Query, after *Position, limit int) (SearchResult, error) {
	var result SearchResult
	if limit == 0 {
		limit = -1
	}
	if _, err := q.check(limit); err != nil {
		return result, err
	}
	used := 0
	last := after
	more := false
	fit := func(path string, m Match) bool {
		size := MatchSize(path, m)
		if len(result.Matches) >= limit || used+size > PageTextBytes {
			return false
		}
		result.Matches = append(result.Matches, PathMatch{Path: path, Match: m})
		used += size
		return true
	}
files:
	for _, c := range candidates {
		resuming := after != nil && after.Path == c.Path
		if resuming && after.Line == MaxSafeLine {
			continue
		}
		if result.Scanned >= SearchFiles || (result.ScannedBytes >= SearchBytes && last != nil) {
			more = true
			break
		}
		result.Scanned++
		if !resuming && NameMatches(c.Path, q) {
			m := Match{Line: 0, Column: 1, Text: c.Path, Kind: "filename"}
			if !fit(c.Path, m) {
				more = true
				break
			}
			last = &Position{Path: c.Path, Line: 0, Column: 1}
		}
		var matches []Match
		if q.Mode != ModeFilename {
			source, err := loadNote(c)
			if err == nil {
				result.ScannedBytes += len(source)
				matches, err = NoteMatches(source, q)
			}
			if err != nil {
				result.Skipped = append(result.Skipped, Skipped{Path: c.Path, Why: refusalCode(err)})
				last = &Position{Path: c.Path, Line: MaxSafeLine}
				continue
			}
		}
		for _, m := range matches {
			if resuming && (int64(m.Line) < after.Line || int64(m.Line) == after.Line && int64(m.Column) <= after.Column) {
				continue
			}
			if !fit(c.Path, m) {
				more = true
				break files
			}
			last = &Position{Path: c.Path, Line: int64(m.Line), Column: int64(m.Column)}
		}
		last = &Position{Path: c.Path, Line: MaxSafeLine}
	}
	if more && last != nil {
		result.Next = last
	}
	result.Complete = !more && len(result.Skipped) == 0
	return result, nil
}

func loadNote(c Candidate) (string, error) {
	b, err := c.Load()
	if err != nil {
		return "", err
	}
	return DecodeNote(b)
}

// refusalCode is the code a skipped note is reported with: the refusal's own,
// or io_error for any other failure.
func refusalCode(err error) string {
	if r, ok := err.(*Refusal); ok {
		return r.Code
	}
	return "io_error"
}
