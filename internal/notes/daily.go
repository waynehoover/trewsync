package notes

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yuin/goldmark/ast"
)

// Daily notes and templates (today_note, append_to_daily,
// create_from_template): the date formats Obsidian's daily notes and
// templates are named and filled with, the placeholders its core Templates
// plugin replaces, and adding text under a heading of a note.

// Obsidian's defaults: a daily note is named YYYY-MM-DD, and a template's
// {{date}} and {{time}} are YYYY-MM-DD and HH:mm.
const (
	DefaultDailyFormat = "YYYY-MM-DD"
	DefaultDateFormat  = "YYYY-MM-DD"
	DefaultTimeFormat  = "HH:mm"
)

// MaxFormatBytes is the longest date format accepted.
const MaxFormatBytes = 128

var (
	monthNames = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September",
		"October", "November", "December"}
	dayNames = []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}
)

// dateTokens are the moment.js tokens FormatDate writes, longest first so
// that "MMMM" is read before "MM". Every other letter moment reads as a token
// (a locale format, a week-year, an offset, a timestamp) is refused rather
// than written differently from how Obsidian would write it.
var dateTokens = []string{
	"YYYY", "YY", "Q",
	"MMMM", "MMM", "MM", "M",
	"DDDD", "DDD", "Do", "DD", "D",
	"dddd", "ddd", "dd", "d", "E",
	"GGGG", "WW", "W",
	"HH", "H", "hh", "h", "kk", "k",
	"mm", "m", "ss", "s", "A", "a",
}

// refusedLetters are letters moment reads as tokens that FormatDate does not
// write: g and w (locale weeks), Z (offsets), X and x (timestamps), S
// (fractions), N (eras), e (locale weekday), L and l (locale formats), y
// (era years), and Y or G alone or in another count.
const refusedLetters = "gwZXxSNeLlyYG"

// CheckDateFormat refuses a format FormatDate cannot write as Obsidian
// would (invalid_format), or one that is empty or longer than MaxFormatBytes.
func CheckDateFormat(format string) error {
	_, err := FormatDate(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), format)
	return err
}

// FormatDate writes t in a moment.js format, as Obsidian names daily notes
// and fills {{date:FORMAT}}: the tokens of dateTokens, English month and day
// names, text in [brackets] written as it is, and any other character as
// itself. A letter moment would read as a token this does not write is
// invalid_format.
func FormatDate(t time.Time, format string) (string, error) {
	if format == "" || len(format) > MaxFormatBytes {
		return "", refuse("invalid_format", "a date format is 1 to 128 bytes")
	}
	var b strings.Builder
	for i := 0; i < len(format); {
		if format[i] == '[' {
			end := strings.IndexByte(format[i+1:], ']')
			if end < 0 {
				return "", refuse("invalid_format", "a [ in the date format is never closed")
			}
			b.WriteString(format[i+1 : i+1+end])
			i += end + 2
			continue
		}
		token := ""
		for _, tok := range dateTokens {
			if strings.HasPrefix(format[i:], tok) {
				token = tok
				break
			}
		}
		if token == "" {
			if strings.IndexByte(refusedLetters, format[i]) >= 0 {
				return "", refuse("invalid_format", "the date format uses "+strconv.Quote(format[i:i+1])+
					", which this server does not write; see the supported tokens in docs/agent.md")
			}
			b.WriteByte(format[i])
			i++
			continue
		}
		b.WriteString(dateToken(t, token))
		i += len(token)
	}
	return b.String(), nil
}

func pad(n, width int) string {
	s := strconv.Itoa(n)
	for len(s) < width {
		s = "0" + s
	}
	return s
}

func dateToken(t time.Time, token string) string {
	isoYear, isoWeek := t.ISOWeek()
	hour12 := t.Hour() % 12
	if hour12 == 0 {
		hour12 = 12
	}
	isoDay := int(t.Weekday())
	if isoDay == 0 {
		isoDay = 7
	}
	switch token {
	case "YYYY":
		return pad(t.Year(), 4)
	case "YY":
		return pad(t.Year()%100, 2)
	case "Q":
		return strconv.Itoa((int(t.Month())-1)/3 + 1)
	case "MMMM":
		return monthNames[t.Month()-1]
	case "MMM":
		return monthNames[t.Month()-1][:3]
	case "MM":
		return pad(int(t.Month()), 2)
	case "M":
		return strconv.Itoa(int(t.Month()))
	case "DDDD":
		return pad(t.YearDay(), 3)
	case "DDD":
		return strconv.Itoa(t.YearDay())
	case "Do":
		return ordinal(t.Day())
	case "DD":
		return pad(t.Day(), 2)
	case "D":
		return strconv.Itoa(t.Day())
	case "dddd":
		return dayNames[t.Weekday()]
	case "ddd":
		return dayNames[t.Weekday()][:3]
	case "dd":
		return dayNames[t.Weekday()][:2]
	case "d":
		return strconv.Itoa(int(t.Weekday()))
	case "E":
		return strconv.Itoa(isoDay)
	case "GGGG":
		return pad(isoYear, 4)
	case "WW":
		return pad(isoWeek, 2)
	case "W":
		return strconv.Itoa(isoWeek)
	case "HH":
		return pad(t.Hour(), 2)
	case "H":
		return strconv.Itoa(t.Hour())
	case "hh":
		return pad(hour12, 2)
	case "h":
		return strconv.Itoa(hour12)
	case "kk":
		return pad(hour24(t), 2)
	case "k":
		return strconv.Itoa(hour24(t))
	case "mm":
		return pad(t.Minute(), 2)
	case "m":
		return strconv.Itoa(t.Minute())
	case "ss":
		return pad(t.Second(), 2)
	case "s":
		return strconv.Itoa(t.Second())
	case "A":
		if t.Hour() < 12 {
			return "AM"
		}
		return "PM"
	case "a":
		if t.Hour() < 12 {
			return "am"
		}
		return "pm"
	}
	return token
}

// hour24 is moment's k: the hour from 1 to 24, midnight being 24.
func hour24(t time.Time) int {
	if t.Hour() == 0 {
		return 24
	}
	return t.Hour()
}

func ordinal(n int) string {
	suffix := "th"
	if n%100 < 11 || n%100 > 13 {
		switch n % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return strconv.Itoa(n) + suffix
}

// ParseDay is the day a date argument names, in loc: "today", "yesterday",
// "tomorrow", or YYYY-MM-DD, relative to now. The result is that day's
// midnight in loc. Anything else is invalid_arguments.
func ParseDay(s string, now time.Time, loc *time.Location) (time.Time, error) {
	now = now.In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	switch s {
	case "", "today":
		return today, nil
	case "yesterday":
		return today.AddDate(0, 0, -1), nil
	case "tomorrow":
		return today.AddDate(0, 0, 1), nil
	}
	d, err := time.ParseInLocation("2006-01-02", s, loc)
	if err != nil || d.Format("2006-01-02") != s {
		return time.Time{}, refuse("invalid_arguments", "date must be YYYY-MM-DD, today, yesterday or tomorrow")
	}
	return d, nil
}

// Template is what RenderTemplate fills a template with.
type Template struct {
	// Title is {{title}}: the new note's file name without its extension.
	Title string
	// Date is what {{date}} and {{date:FORMAT}} write: the daily note's day
	// for a daily note, else Now.
	Date time.Time
	// Now is what {{time}} and {{time:FORMAT}} write.
	Now time.Time
	// DateFormat and TimeFormat are {{date}}'s and {{time}}'s formats.
	DateFormat, TimeFormat string
	// Variables are {{name}}'s values, for names other than date, time and
	// title.
	Variables map[string]string
}

// placeholder is {{name}} or {{name:format}}, with spaces allowed inside the
// braces around the name, as Obsidian's core Templates plugin reads it.
var placeholder = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_-]+)\s*(?::([^{}\r\n]*?))?\s*\}\}`)

// VariableName is the shape of a variable's name: what a placeholder can
// name.
var VariableName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ReservedVariable reports whether name is one of the placeholders every
// template has (date, time, title, compared without regard to case), which a
// caller's variables may not redefine.
func ReservedVariable(name string) bool {
	switch strings.ToLower(name) {
	case "date", "time", "title":
		return true
	}
	return false
}

// RenderTemplate fills text's placeholders as Obsidian's core Templates plugin
// does: {{date}} and {{time}} in t's formats, {{date:FORMAT}} and
// {{time:FORMAT}} in their own, {{title}}, each name compared without regard
// to case; and {{name}} for each of t's variables, exactly. A placeholder
// naming nothing it knows, or a variable given a format, is left as it is, so
// another plugin's syntax survives. A format FormatDate refuses is
// invalid_template, and nothing is written.
func RenderTemplate(text string, t Template) (string, error) {
	var failed error
	out := placeholder.ReplaceAllStringFunc(text, func(m string) string {
		if failed != nil {
			return m
		}
		sub := placeholder.FindStringSubmatch(m)
		name, format := sub[1], sub[2]
		hasFormat := strings.Contains(m, ":")
		switch strings.ToLower(name) {
		case "date", "time":
			when, def := t.Date, t.DateFormat
			if strings.ToLower(name) == "time" {
				when, def = t.Now, t.TimeFormat
			}
			if !hasFormat {
				format = def
			}
			s, err := FormatDate(when, strings.TrimSpace(format))
			if err != nil {
				failed = refuse("invalid_template", "the template's "+m+" has a date format this server does not write: "+
					err.(*Refusal).Message)
				return m
			}
			return s
		case "title":
			if hasFormat {
				return m
			}
			return t.Title
		}
		if v, ok := t.Variables[name]; ok && !hasFormat {
			return v
		}
		return m
	})
	if failed != nil {
		return "", failed
	}
	return out, nil
}

// Title is a note's {{title}}: its file name without the .md or .txt
// extension.
func Title(path string) string { return trimNoteExtension(posixBasename(path)) }

// sectionHeading is one heading of a note's body at the top level of the
// document, which is where Obsidian's outline takes sections from: its level,
// where its first line starts, and for an ATX heading the line as written.
type sectionHeading struct {
	level int
	start int // the byte offset of its first line
	atx   bool
}

var atxLine = regexp.MustCompile(`^ {0,3}(#{1,6})(?:[ \t].*)?$`)

// CheckHeading refuses a heading argument that is not one ATX heading line:
// up to three spaces, one to six #, and then the end or a space or tab and
// the heading's text, with no line break.
func CheckHeading(h string) error {
	if strings.ContainsAny(h, "\r\n") || !atxLine.MatchString(h) {
		return refuse("invalid_arguments", "heading must be one ATX heading line exactly as the note has it, "+
			"such as \"## Tasks\"")
	}
	return nil
}

// sectionHeadings is every top-level heading of source's body, in order: ATX
// and setext, found by the Markdown parser, so a "#" line inside code, HTML,
// a list or a quote is not one. The parser places a heading by its text; one
// with no text ("##" alone) is placed at the first line after the block
// before it that has that shape.
func sectionHeadings(source string) ([]sectionHeading, error) {
	f, err := findFrame(source)
	if err != nil {
		return nil, err
	}
	d, err := parseMarkdown(source, f.body)
	if err != nil {
		return nil, err
	}
	lines := lineStarts(source)
	lineOf := func(at int) int {
		i := sort.Search(len(lines), func(i int) bool { return lines[i] > at }) - 1
		return lines[i]
	}
	var out []sectionHeading
	cursor := d.offset
	for n := d.root.FirstChild(); n != nil; n = n.NextSibling() {
		h, ok := n.(*ast.Heading)
		switch {
		case ok && h.Lines().Len() > 0:
			start := lineOf(h.Lines().At(0).Start + d.offset)
			out = append(out, sectionHeading{level: h.Level, start: start, atx: atxLine.MatchString(lineText(source, start))})
		case ok:
			for _, start := range lines {
				text := lineText(source, start)
				if start >= cursor && atxLine.MatchString(text) && strings.Trim(text, " \t#") == "" {
					out = append(out, sectionHeading{level: h.Level, start: start, atx: true})
					cursor = start + len(text)
					break
				}
			}
		}
		cursor = max(cursor, d.lastStop(n)+d.offset)
	}
	return out, nil
}

// lastStop is the end of the last byte body n or anything in it holds, a
// fenced block's closing fence included.
func (d *markdownDocument) lastStop(n ast.Node) int {
	end := 0
	if f, ok := n.(*ast.FencedCodeBlock); ok {
		end = d.record.fenceEnds[f]
	}
	if n.Type() == ast.TypeBlock && n.Lines() != nil && n.Lines().Len() > 0 {
		end = max(end, n.Lines().At(n.Lines().Len()-1).Stop)
	}
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		if c.Type() == ast.TypeBlock {
			end = max(end, d.lastStop(c))
		}
	}
	return end
}

// lineText is the line starting at start, without its "\n" or "\r\n".
func lineText(s string, start int) string {
	end := strings.IndexByte(s[start:], '\n')
	if end < 0 {
		end = len(s) - start
	}
	return strings.TrimSuffix(s[start:start+end], "\r")
}

// AppendLines is append_to_daily's write without a heading: text at the end
// of the note, on lines of its own. A line break is written before it when
// the note does not end with one, in the note's own line ending (CRLF when the
// note has any, else LF); the text is otherwise written exactly as given.
// Refusals are AppendNote's.
func AppendLines(before []byte, text string) (Revision, error) {
	if err := checkInsertion(before, text); err != nil {
		return Revision{}, err
	}
	return insertLines(before, len(before), text)
}

// AppendUnderHeading is append_to_daily's write with a heading: text added to
// the end of the section the heading starts, which runs to the next heading
// of the same or a higher level (fewer #) or to the end of the note. It goes
// after the section's last line that is not blank, so the blank lines before
// the next heading stay before it, and on lines of its own: a line break
// before it when that line has none, and after it when it does not end with
// one and more of the note follows. heading must be exactly one ATX heading
// line of the note, compared without its line ending and with no other
// normalisation: no_match when no heading of the note is that line,
// ambiguous_edit when more than one is. Headings are the note's top-level
// ones, so a "#" line in a code block, a list or a quote is not one.
func AppendUnderHeading(before []byte, heading, text string) (Revision, error) {
	if err := CheckHeading(heading); err != nil {
		return Revision{}, err
	}
	if err := checkInsertion(before, text); err != nil {
		return Revision{}, err
	}
	source := string(before)
	all, err := sectionHeadings(source)
	if err != nil {
		return Revision{}, err
	}
	found := -1
	for i, h := range all {
		if h.atx && lineText(source, h.start) == heading {
			if found >= 0 {
				return Revision{}, refuse("ambiguous_edit", "the note has that heading more than once; "+
					"edit it with edit_note instead")
			}
			found = i
		}
	}
	if found < 0 {
		return Revision{}, refuse("no_match", "the note has no heading that is exactly that line")
	}
	end := len(source)
	for _, h := range all[found+1:] {
		if h.level <= all[found].level {
			end = h.start
			break
		}
	}
	// The end of the heading's own line, and of the section's last line that
	// is not blank after it.
	body := strings.IndexByte(source[all[found].start:], '\n')
	at := len(source)
	if body >= 0 {
		at = all[found].start + body + 1
	}
	for _, start := range lineStarts(source[:end]) {
		if start < at || start >= end {
			continue
		}
		if strings.Trim(lineText(source, start), " \t") == "" {
			continue
		}
		next := strings.IndexByte(source[start:end], '\n')
		if next < 0 {
			at = end
		} else {
			at = start + next + 1
		}
	}
	if at > end {
		at = end
	}
	return insertLines(before, at, text)
}

// insertLines puts text at at on lines of its own (AppendUnderHeading).
func insertLines(before []byte, at int, text string) (Revision, error) {
	newline := "\n"
	if strings.Contains(string(before), "\r\n") {
		newline = "\r\n"
	}
	add := text
	if at > 0 && before[at-1] != '\n' {
		add = newline + add
	}
	if at < len(before) && !strings.HasSuffix(text, "\n") {
		add += newline
	}
	return inserted(before, at, add)
}
