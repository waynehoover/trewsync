package notes

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"unicode"
	"unicode/utf16"

	"github.com/waynehoover/telimus/internal/paths"
	"golang.org/x/text/unicode/norm"
)

// The oracle: mcp-fixtures.json holds what Basalt's TypeScript returned for a
// corpus (client/src/cli/mcp-oracle.run.ts wrote it), and every function here
// must return the same. Each section has a check that compares one vector and
// says how it differs; TestOracle runs every vector through its check, and
// TestOracleDetectsCorruption proves each check can fail.

var (
	fixtureOnce sync.Once
	fixtureData map[string]json.RawMessage
	fixtureErr  error
)

func loadFixture(t testing.TB) map[string]json.RawMessage {
	t.Helper()
	fixtureOnce.Do(func() {
		path := filepath.Join("..", "..", "mcp-fixtures.json")
		if alt := os.Getenv("MCP_FIXTURES"); alt != "" {
			path = alt // a deeper corpus from ORACLE_EXTRA, not committed
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			fixtureErr = err
			return
		}
		fixtureErr = json.Unmarshal(raw, &fixtureData)
	})
	if fixtureErr != nil {
		t.Fatal(fixtureErr)
	}
	return fixtureData
}

// section decodes one section of the fixture into a list of vectors.
func section[V any](t testing.TB, path ...string) []V {
	t.Helper()
	raw := loadFixture(t)[path[0]]
	for _, key := range path[1:] {
		var inner map[string]json.RawMessage
		if err := json.Unmarshal(raw, &inner); err != nil {
			t.Fatal(err)
		}
		raw = inner[key]
	}
	if raw == nil {
		t.Fatalf("mcp-fixtures.json has no %s", strings.Join(path, "."))
	}
	var out []V
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s: %v", strings.Join(path, "."), err)
	}
	return out
}

// text is an input as the fixture writes it: a string, base64 bytes, or a
// list of [string, count] pieces to repeat.
type fxText string

func (x *fxText) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		err := json.Unmarshal(b, &s)
		*x = fxText(s)
		return err
	}
	var o struct {
		B64    *string             `json:"b64"`
		Repeat [][]json.RawMessage `json:"repeat"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		return err
	}
	if o.B64 != nil {
		raw, err := base64.StdEncoding.DecodeString(*o.B64)
		*x = fxText(raw)
		return err
	}
	var sb strings.Builder
	for _, part := range o.Repeat {
		var s string
		var n int
		if len(part) != 2 || json.Unmarshal(part[0], &s) != nil || json.Unmarshal(part[1], &n) != nil {
			return fmt.Errorf("bad repeat %s", b)
		}
		sb.WriteString(strings.Repeat(s, n))
	}
	*x = fxText(sb.String())
	return nil
}

// bigText is an output the fixture records whole, or by SHA-256 and UTF-16
// length when it is long.
type bigText struct {
	whole *string
	sum   string
	units int
}

func (x *bigText) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		err := json.Unmarshal(b, &s)
		x.whole = &s
		return err
	}
	var o struct {
		SHA256 string `json:"sha256"`
		Units  int    `json:"units"`
	}
	err := json.Unmarshal(b, &o)
	x.sum, x.units = o.SHA256, o.Units
	return err
}

func (x bigText) matches(got string) bool {
	if x.whole != nil {
		return *x.whole == got
	}
	sum := sha256.Sum256([]byte(got))
	return hex.EncodeToString(sum[:]) == x.sum && units(got) == x.units
}

func (x bigText) String() string {
	if x.whole != nil {
		return fmt.Sprintf("%q", *x.whole)
	}
	return fmt.Sprintf("sha256:%s (%d units)", x.sum[:12], x.units)
}

// failure is an expected error: {"error": code}.
type failure struct {
	Error string `json:"error"`
}

// either decodes a want that is an error or a value.
func either(raw json.RawMessage, value any) (code string, err error) {
	var f failure
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) && json.Unmarshal(raw, &f) == nil && f.Error != "" {
		return f.Error, nil
	}
	return "", json.Unmarshal(raw, value)
}

func codeOf(err error) string {
	if r, ok := err.(*Refusal); ok {
		return r.Code
	}
	if err != nil {
		return "unexpected " + err.Error()
	}
	return ""
}

func short(s string) string {
	if len(s) > 120 {
		return fmt.Sprintf("%q... (%d bytes)", s[:120], len(s))
	}
	return fmt.Sprintf("%q", s)
}

// ---------------------------------------------------------------------------
// read_note paging.

type pageVector struct {
	Text      fxText          `json:"text"`
	StartLine int             `json:"startLine"`
	MaxLines  int             `json:"maxLines"`
	Want      json.RawMessage `json:"want"`
}

func checkPage(v pageVector) error {
	var want struct {
		Content   bigText `json:"content"`
		StartLine int     `json:"startLine"`
		EndLine   int     `json:"endLine"`
		NextLine  *int    `json:"nextLine"`
		Complete  bool    `json:"complete"`
	}
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	got, gerr := Page([]byte(v.Text), v.StartLine, v.MaxLines, PageTextBytes)
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q", codeOf(gerr), code)
		}
		return nil
	}
	next := 0
	if want.NextLine != nil {
		next = *want.NextLine
	}
	if !want.Content.matches(got.Content()) || got.StartLine != want.StartLine || got.EndLine != want.EndLine ||
		got.NextLine != next || got.Complete != want.Complete {
		return fmt.Errorf("got %s %d-%d next %d complete %v, want %s %d-%d next %d complete %v",
			short(got.Content()), got.StartLine, got.EndLine, got.NextLine, got.Complete,
			want.Content, want.StartLine, want.EndLine, next, want.Complete)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Cursors.

type optionsJSON []Option

func (o *optionsJSON) UnmarshalJSON(b []byte) error {
	var pairs [][2]json.RawMessage
	if err := json.Unmarshal(b, &pairs); err != nil {
		return err
	}
	for _, p := range pairs {
		var key string
		if err := json.Unmarshal(p[0], &key); err != nil {
			return err
		}
		d := json.NewDecoder(bytes.NewReader(p[1]))
		d.UseNumber()
		var v any
		if err := d.Decode(&v); err != nil {
			return err
		}
		if n, ok := v.(json.Number); ok {
			i, err := n.Int64()
			if err != nil {
				return err
			}
			v = i
		}
		*o = append(*o, Option{Key: key, Value: v})
	}
	return nil
}

type fingerprintVector struct {
	Options optionsJSON `json:"options"`
	Want    string      `json:"want"`
}

func checkFingerprint(v fingerprintVector) error {
	if got := Fingerprint(v.Options); got != v.Want {
		return fmt.Errorf("got %s, want %s", got, v.Want)
	}
	return nil
}

type tokenVector struct {
	Options optionsJSON `json:"options"`
	Path    string      `json:"path"`
	Line    int64       `json:"line"`
	Column  int64       `json:"column"`
	Want    string      `json:"want"`
}

// basaltToken builds Basalt's cursor layout from this package's pieces:
// {"query":fingerprint,"at":{"path":base64url,"line":L,"column":C}}. Telimus
// uses its own layout; what carries over, and what this pins, is the
// fingerprint and the path encoding.
func basaltToken(options []Option, path string, line, column int64) string {
	b := []byte(`{"query":`)
	b = appendJSString(b, Fingerprint(options))
	b = append(b, `,"at":{"path":`...)
	b = appendJSString(b, encodeCursorPath(path))
	b = append(b, fmt.Sprintf(`,"line":%d,"column":%d}}`, line, column)...)
	return base64.RawURLEncoding.EncodeToString(b)
}

func checkToken(v tokenVector) error {
	if got := basaltToken(v.Options, v.Path, v.Line, v.Column); got != v.Want {
		return fmt.Errorf("got %s, want %s", got, v.Want)
	}
	return nil
}

type positionVector struct {
	Note      string          `json:"note"`
	Value     string          `json:"value"`
	PathField *string         `json:"pathField"`
	Want      json.RawMessage `json:"want"`
}

// checkPosition holds the path rule to Basalt's verdicts: the same fields
// accepted and refused, with one deliberate difference, the cap, which is the
// server's 1,024-byte path limit rather than Basalt's 4,096. Refusals of the
// rest of Basalt's layout are checked against the same defect in this
// package's own layout.
func checkPosition(v positionVector) error {
	var want struct {
		Path string `json:"path"`
	}
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	if v.PathField != nil {
		got, ok := decodeCursorPath(*v.PathField)
		basalt := code == ""
		if raw, err := base64.RawURLEncoding.Strict().DecodeString(*v.PathField); err == nil && basalt &&
			len(raw) > paths.MaxPathBytes && len(raw) <= 4096 {
			if ok {
				return fmt.Errorf("%s: accepted a path over the server's limit", v.Note)
			}
			return nil
		}
		if ok != basalt || (ok && got != want.Path) {
			return fmt.Errorf("%s: got %q ok=%v, Basalt %q accepted=%v", v.Note, got, ok, want.Path, basalt)
		}
		return nil
	}
	if code != "invalid_cursor" {
		return fmt.Errorf("%s: Basalt answered %s", v.Note, v.Want)
	}
	options := []Option{{"folder", ""}}
	good := EncodeSearchCursor(options, 3, Position{Path: "a.md", Line: 1, Column: 2})
	raw, _ := base64.RawURLEncoding.DecodeString(good)
	forge := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	fp := Fingerprint(options)
	path := encodeCursorPath("a.md")
	var bad string
	switch v.Note {
	case "other options":
		bad = EncodeSearchCursor([]Option{{"folder", "x"}}, 3, Position{Path: "a.md", Line: 1, Column: 2})
	case "negative line":
		bad = forge(fmt.Sprintf(`{"q":%q,"head":3,"path":%q,"line":-1,"column":2}`, fp, path))
	case "fractional line":
		bad = forge(fmt.Sprintf(`{"q":%q,"head":3,"path":%q,"line":1.5,"column":2}`, fp, path))
	case "unsafe line":
		bad = forge(fmt.Sprintf(`{"q":%q,"head":3,"path":%q,"line":9007199254740992,"column":0}`, fp, path))
	case "missing column":
		bad = forge(fmt.Sprintf(`{"q":%q,"head":3,"path":%q,"line":1}`, fp, path))
	case "path not a string":
		bad = forge(fmt.Sprintf(`{"q":%q,"head":3,"path":7,"line":1,"column":2}`, fp))
	case "not an object":
		bad = forge("[]")
	case "not JSON":
		bad = forge("{")
	case "empty":
		bad = ""
	case "outside the alphabet":
		bad = "a+b"
	case "too long":
		bad = strings.Repeat("A", MaxCursorLength+1)
	case "padding":
		bad = good + "="
	default:
		return fmt.Errorf("no counterpart for %q", v.Note)
	}
	if bytes.Equal(raw, nil) {
		return fmt.Errorf("could not decode a good cursor")
	}
	if _, _, err := DecodeSearchCursor(bad, options); codeOf(err) != "invalid_cursor" {
		return fmt.Errorf("%s: accepted by this package's layout", v.Note)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Search, replayed page by page over the fixture's vault.

type searchVault struct {
	Notes []struct {
		Path string `json:"path"`
		Text fxText `json:"text"`
	} `json:"notes"`
	Queries []searchQueryVector `json:"queries"`
}

type searchQueryVector struct {
	Input struct {
		Query           string `json:"query"`
		Mode            string `json:"mode"`
		CaseSensitive   bool   `json:"caseSensitive"`
		ContextLines    int    `json:"contextLines"`
		Limit           *int   `json:"limit"`
		IncludeChildren *bool  `json:"includeChildren"`
		Folder          string `json:"folder"`
	} `json:"input"`
	Pages []json.RawMessage `json:"pages"`
}

type searchPageWant struct {
	Matches []struct {
		Path    string   `json:"path"`
		Line    int      `json:"line"`
		Column  int      `json:"column"`
		Text    string   `json:"text"`
		Before  []string `json:"before"`
		After   []string `json:"after"`
		Clipped bool     `json:"clipped"`
		Kind    string   `json:"kind"`
	} `json:"matches"`
	Next *struct {
		Path   string `json:"path"`
		Line   int64  `json:"line"`
		Column int64  `json:"column"`
	} `json:"next"`
	Complete     bool `json:"complete"`
	Scanned      int  `json:"scanned"`
	ScannedBytes int  `json:"scannedBytes"`
	Skipped      struct {
		Count int `json:"count"`
		Items []struct {
			Path string `json:"path"`
			Why  string `json:"why"`
		} `json:"items"`
	} `json:"skipped"`
}

// utf16Less is JavaScript's string order, by UTF-16 code units, which Basalt
// sorted its inventory by.
func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}

func checkSearch(vault searchVault, v searchQueryVector) error {
	q := Query{
		Text: v.Input.Query, Mode: SearchMode(v.Input.Mode), CaseSensitive: v.Input.CaseSensitive,
		ContextLines: v.Input.ContextLines, IncludeChildren: true,
	}
	if q.Mode == "" {
		q.Mode = ModeContent
	}
	if v.Input.IncludeChildren != nil {
		q.IncludeChildren = *v.Input.IncludeChildren
	}
	limit := 50
	if v.Input.Limit != nil {
		limit = *v.Input.Limit
	}
	notes := append(vault.Notes[:0:0], vault.Notes...)
	sort.Slice(notes, func(i, j int) bool { return utf16Less(notes[i].Path, notes[j].Path) })
	var after *Position
	for n, raw := range v.Pages {
		var want searchPageWant
		code, err := either(raw, &want)
		if err != nil {
			return err
		}
		var candidates []Candidate
		for _, note := range notes {
			if !paths.Searchable(note.Path) || (v.Input.Folder != "" && !strings.HasPrefix(note.Path, v.Input.Folder+"/")) {
				continue
			}
			if after != nil && utf16Less(note.Path, after.Path) {
				continue
			}
			body := []byte(note.Text)
			candidates = append(candidates, Candidate{Path: note.Path, Load: func() ([]byte, error) { return body, nil }})
		}
		got, gerr := SearchPage(candidates, q, after, limit)
		if code != "" || gerr != nil {
			if codeOf(gerr) != code {
				return fmt.Errorf("page %d: error %q, want %q", n, codeOf(gerr), code)
			}
			return nil
		}
		if len(got.Matches) != len(want.Matches) {
			return fmt.Errorf("page %d: %d matches, want %d", n, len(got.Matches), len(want.Matches))
		}
		for i, m := range got.Matches {
			w := want.Matches[i]
			if m.Path != w.Path || m.Line != w.Line || m.Column != w.Column || m.Text != w.Text ||
				!reflect.DeepEqual(nonNil(m.Before), nonNil(w.Before)) || !reflect.DeepEqual(nonNil(m.After), nonNil(w.After)) ||
				m.Clipped != w.Clipped || m.Kind != w.Kind {
				return fmt.Errorf("page %d match %d: got %s:%d:%d %s %q %q clipped %v %q, want %s:%d:%d %s %q %q clipped %v %q",
					n, i, m.Path, m.Line, m.Column, short(m.Text), m.Before, m.After, m.Clipped, m.Kind,
					w.Path, w.Line, w.Column, short(w.Text), w.Before, w.After, w.Clipped, w.Kind)
			}
		}
		if (got.Next == nil) != (want.Next == nil) ||
			(got.Next != nil && (got.Next.Path != want.Next.Path || got.Next.Line != want.Next.Line || got.Next.Column != want.Next.Column)) {
			return fmt.Errorf("page %d: next %+v, want %+v", n, got.Next, want.Next)
		}
		if got.Complete != want.Complete || got.Scanned != want.Scanned || got.ScannedBytes != want.ScannedBytes {
			return fmt.Errorf("page %d: complete %v scanned %d/%d bytes, want %v %d/%d",
				n, got.Complete, got.Scanned, got.ScannedBytes, want.Complete, want.Scanned, want.ScannedBytes)
		}
		if len(got.Skipped) != want.Skipped.Count {
			return fmt.Errorf("page %d: skipped %v, want %d", n, got.Skipped, want.Skipped.Count)
		}
		for i, s := range want.Skipped.Items {
			if got.Skipped[i].Path != s.Path || got.Skipped[i].Why != s.Why {
				return fmt.Errorf("page %d: skipped %v, want %v", n, got.Skipped, want.Skipped.Items)
			}
		}
		after = got.Next
	}
	return nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ---------------------------------------------------------------------------
// compare_versions.

type compareVector struct {
	Before fxText `json:"before"`
	After  fxText `json:"after"`
	Want   struct {
		Coarse  bool         `json:"coarse"`
		Changes []changeWant `json:"changes"`
	} `json:"want"`
	Pages []struct {
		After int `json:"after"`
		Limit int `json:"limit"`
		Want  struct {
			Changes      []changeWant `json:"changes"`
			NextAfter    *int         `json:"nextAfter"`
			Complete     bool         `json:"complete"`
			TotalChanges int          `json:"totalChanges"`
			Identical    bool         `json:"identical"`
			Coarse       bool         `json:"coarse"`
		} `json:"want"`
	} `json:"pages"`
}

type changeWant struct {
	FromLine int     `json:"fromLine"`
	ToLine   int     `json:"toLine"`
	Old      bigText `json:"old"`
	New      bigText `json:"new"`
	OldLines int     `json:"oldLines"`
	NewLines int     `json:"newLines"`
	Clipped  *bool   `json:"clipped"`
}

func (w changeWant) check(c Change, clipped bool) error {
	if c.FromLine != w.FromLine || c.ToLine != w.ToLine || !w.Old.matches(c.Old) || !w.New.matches(c.New) ||
		c.OldLines != w.OldLines || c.NewLines != w.NewLines || (w.Clipped != nil && *w.Clipped != clipped) {
		return fmt.Errorf("got %d/%d %s -> %s (%d/%d lines), want %d/%d %s -> %s (%d/%d)",
			c.FromLine, c.ToLine, short(c.Old), short(c.New), c.OldLines, c.NewLines,
			w.FromLine, w.ToLine, w.Old, w.New, w.OldLines, w.NewLines)
	}
	return nil
}

func checkCompare(v compareVector) error {
	got := CompareLines(string(v.Before), string(v.After))
	if got.Coarse != v.Want.Coarse || len(got.Changes) != len(v.Want.Changes) {
		return fmt.Errorf("coarse %v with %d changes, want %v with %d", got.Coarse, len(got.Changes), v.Want.Coarse, len(v.Want.Changes))
	}
	for i, c := range got.Changes {
		if err := v.Want.Changes[i].check(c, false); err != nil {
			return fmt.Errorf("change %d: %v", i, err)
		}
	}
	for _, p := range v.Pages {
		page := PageChanges(got, p.After, p.Limit)
		w := p.Want
		next := -1
		if w.NextAfter != nil {
			next = *w.NextAfter
		}
		if len(page.Changes) != len(w.Changes) || page.NextAfter != next || page.Complete != w.Complete ||
			len(got.Changes) != w.TotalChanges || (v.Before == v.After) != w.Identical || got.Coarse != w.Coarse {
			return fmt.Errorf("page after %d limit %d: %d rows next %d complete %v, want %d rows next %d complete %v",
				p.After, p.Limit, len(page.Changes), page.NextAfter, page.Complete, len(w.Changes), next, w.Complete)
		}
		for i, row := range page.Changes {
			if err := w.Changes[i].check(row.Change, row.Clipped); err != nil {
				return fmt.Errorf("page after %d row %d: %v", p.After, i, err)
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Tags, frontmatter, hidden ranges.

type tagsVector struct {
	Source fxText          `json:"source"`
	Want   json.RawMessage `json:"want"`
}

// noteVector is everything the read side derives from one note.
type noteVector struct {
	Source      fxText              `json:"source"`
	Frontmatter json.RawMessage     `json:"frontmatter"`
	Tags        json.RawMessage     `json:"tags"`
	Hidden      [][]json.RawMessage `json:"hidden"`
	Links       json.RawMessage     `json:"links"`
}

// hiddenVectors unpacks a note's [start, protectLinks, ranges] triples.
func (v noteVector) hiddenVectors() ([]hiddenVector, error) {
	var out []hiddenVector
	for _, h := range v.Hidden {
		x := hiddenVector{Source: v.Source}
		if len(h) != 3 || json.Unmarshal(h[0], &x.Start) != nil || json.Unmarshal(h[1], &x.ProtectLinks) != nil ||
			json.Unmarshal(h[2], &x.Want) != nil {
			return nil, fmt.Errorf("bad hidden entry")
		}
		out = append(out, x)
	}
	return out, nil
}

func checkNoteHidden(v noteVector) error {
	hs, err := v.hiddenVectors()
	if err != nil {
		return err
	}
	for _, h := range hs {
		if err := checkHidden(h); err != nil {
			return err
		}
	}
	return nil
}

type tagWant struct {
	Tag      string `json:"tag"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Location string `json:"location"`
}

func compareTags(got []TagOccurrence, want []tagWant) error {
	if len(got) != len(want) {
		return fmt.Errorf("got %+v, want %+v", got, want)
	}
	for i, g := range got {
		if w := want[i]; g.Tag != w.Tag || g.Start != w.Start || g.End != w.End || g.Location != w.Location {
			return fmt.Errorf("tag %d: got %+v, want %+v", i, g, w)
		}
	}
	return nil
}

func checkTags(v tagsVector) error {
	var want []tagWant
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	got, gerr := TagOccurrences(string(v.Source))
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q (got %+v)", codeOf(gerr), code, got)
		}
		return nil
	}
	return compareTags(got, want)
}

func checkFrontmatter(v tagsVector) error {
	var want Frontmatter
	var w struct {
		BOM     int    `json:"bom"`
		Newline string `json:"newline"`
		Start   int    `json:"start"`
		End     int    `json:"end"`
		Body    int    `json:"body"`
		Present bool   `json:"present"`
	}
	code, err := either(v.Want, &w)
	if err != nil {
		return err
	}
	want = Frontmatter{BOM: w.BOM, Newline: w.Newline, Start: w.Start, End: w.End, Body: w.Body, Present: w.Present}
	got, gerr := FindFrontmatter(string(v.Source))
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q", codeOf(gerr), code)
		}
		return nil
	}
	if got != want {
		return fmt.Errorf("got %+v, want %+v", got, want)
	}
	return nil
}

type hiddenVector struct {
	Source       fxText   `json:"source"`
	Start        int      `json:"start"`
	ProtectLinks bool     `json:"protectLinks"`
	Want         [][2]int `json:"want"`
}

// coverage is the set of UTF-16 offsets ranges cover, less the whitespace
// ones: markdown.go says why range ends inside whitespace are not compared.
func coverage(source string, ranges [][2]int) map[int]bool {
	u := utf16.Encode([]rune(source))
	out := map[int]bool{}
	for _, r := range ranges {
		for i := r[0]; i < r[1] && i < len(u); i++ {
			switch u[i] {
			case ' ', '\t', '\n', '\r':
				continue
			}
			out[i] = true
		}
	}
	return out
}

func checkHidden(v hiddenVector) error {
	got := MarkdownHidden(string(v.Source), v.Start, v.ProtectLinks)
	var pairs [][2]int
	for _, r := range got {
		pairs = append(pairs, [2]int{r.Start, r.End})
	}
	g, w := coverage(string(v.Source), pairs), coverage(string(v.Source), v.Want)
	if !reflect.DeepEqual(g, w) {
		var only, missing []int
		for i := range g {
			if !w[i] {
				only = append(only, i)
			}
		}
		for i := range w {
			if !g[i] {
				missing = append(missing, i)
			}
		}
		sort.Ints(only)
		sort.Ints(missing)
		return fmt.Errorf("start %d links %v: got %v, want %v; hidden only here at %v, only in Basalt at %v",
			v.Start, v.ProtectLinks, pairs, v.Want, only, missing)
	}
	return nil
}

type inlineVector struct {
	Source fxText    `json:"source"`
	Start  int       `json:"start"`
	Want   []tagWant `json:"want"`
}

func checkInline(v inlineVector) error {
	return compareTags(InlineTags(string(v.Source), v.Start), v.Want)
}

type validateVector struct {
	Input string          `json:"input"`
	Want  json.RawMessage `json:"want"`
}

func checkValidate(v validateVector) error {
	var want string
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	got, gerr := ValidateTag(v.Input)
	if codeOf(gerr) != code || (code == "" && got != want) {
		return fmt.Errorf("got %q %q, want %q %q", got, codeOf(gerr), want, code)
	}
	return nil
}

type matchesVector struct {
	Candidate string `json:"candidate"`
	Selected  string `json:"selected"`
	Children  bool   `json:"children"`
	Want      bool   `json:"want"`
}

func checkMatches(v matchesVector) error {
	if got := MatchesTag(v.Candidate, v.Selected, v.Children); got != v.Want {
		return fmt.Errorf("got %v, want %v", got, v.Want)
	}
	return nil
}

type patternVector struct {
	Pattern string          `json:"pattern"`
	Value   string          `json:"value"`
	Want    json.RawMessage `json:"want"`
}

func checkPattern(v patternVector) error {
	var want bool
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	got, gerr := TagPattern(v.Pattern, v.Value)
	if codeOf(gerr) != code || (code == "" && got != want) {
		return fmt.Errorf("got %v %q, want %v %q", got, codeOf(gerr), want, code)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Links.

type spanWant struct {
	Start      int    `json:"start"`
	End        int    `json:"end"`
	WholeStart int    `json:"wholeStart"`
	WholeEnd   int    `json:"wholeEnd"`
	URL        string `json:"url"`
	Wiki       bool   `json:"wiki"`
	FragmentAt *int   `json:"fragmentAt"`
}

func checkSpans(v tagsVector) error {
	var want []spanWant
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	got, gerr := LinkSpans(string(v.Source))
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q", codeOf(gerr), code)
		}
		return nil
	}
	if len(got) != len(want) {
		return fmt.Errorf("got %+v, want %+v", got, want)
	}
	for i, g := range got {
		w := want[i]
		fragment := -1
		if w.FragmentAt != nil {
			fragment = *w.FragmentAt
		}
		if g.Start != w.Start || g.End != w.End || g.WholeStart != w.WholeStart || g.WholeEnd != w.WholeEnd ||
			g.URL != w.URL || g.Wiki != w.Wiki || g.FragmentAt != fragment {
			return fmt.Errorf("span %d: got %+v, want %+v (fragment %d)", i, g, w, fragment)
		}
	}
	return nil
}

// testCanonical is the canonical fold the TypeScript tests used.
func testCanonical(p string) string { return jsLower(norm.NFC.String(p)) }

type resolveVector struct {
	Inventory []string `json:"inventory"`
	Queries   []struct {
		Name  string   `json:"name"`
		Wiki  bool     `json:"wiki"`
		Owner string   `json:"owner"`
		Want  []string `json:"want"`
	} `json:"queries"`
}

func checkResolve(v resolveVector) error {
	r := NewLinkResolver(v.Inventory, testCanonical)
	for _, q := range v.Queries {
		if got := r.Resolve(q.Name, q.Wiki, q.Owner); !reflect.DeepEqual(nonNil(got), nonNil(q.Want)) {
			return fmt.Errorf("%q wiki %v from %q: got %q, want %q", q.Name, q.Wiki, q.Owner, got, q.Want)
		}
	}
	return nil
}

type changeLinksVector struct {
	Source fxText `json:"source"`
	Change struct {
		Path      string   `json:"path"`
		From      string   `json:"from"`
		To        *string  `json:"to"`
		Inventory []string `json:"inventory"`
	} `json:"change"`
	Want json.RawMessage `json:"want"`
}

func checkChangeLinks(v changeLinksVector) error {
	var want struct {
		Edits []struct {
			Start int    `json:"start"`
			End   int    `json:"end"`
			Old   string `json:"old"`
			Text  string `json:"text"`
		} `json:"edits"`
		Ambiguous int `json:"ambiguous"`
	}
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	change := LinkChange{Path: v.Change.Path, From: v.Change.From, Inventory: v.Change.Inventory, Canonical: testCanonical}
	if v.Change.To == nil {
		change.Delete = true
	} else {
		change.To = *v.Change.To
	}
	edits, ambiguous, gerr := ChangeLinks(string(v.Source), change)
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q", codeOf(gerr), code)
		}
		return nil
	}
	if ambiguous != want.Ambiguous || len(edits) != len(want.Edits) {
		return fmt.Errorf("got %+v ambiguous %d, want %+v ambiguous %d", edits, ambiguous, want.Edits, want.Ambiguous)
	}
	for i, e := range edits {
		if w := want.Edits[i]; e.Start != w.Start || e.End != w.End || e.Old != w.Old || e.Text != w.Text {
			return fmt.Errorf("edit %d: got %+v, want %+v", i, e, w)
		}
	}
	return nil
}

type decodeVector struct {
	Input string `json:"input"`
	Want  string `json:"want"`
}

func checkDecode(v decodeVector) error {
	if got := decodeString(v.Input); got != v.Want {
		return fmt.Errorf("got %q, want %q", got, v.Want)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Sweeps.

type sweepVector struct {
	Name string
	Want [][2]rune
}

// sweepClasses are the character classes the JavaScript runtime was swept
// through, and the Go predicate each must equal on every code point.
var sweepClasses = map[string]func(rune) bool{
	"tagChar":              tagChar,
	"tagLetter":            tagLetter,
	"tagBoundary":          tagBoundary,
	"jsSpace":              jsSpace,
	"extendedPictographic": func(r rune) bool { return unicode.Is(extendedPictographic, r) },
	"emojiModifier":        func(r rune) bool { return unicode.Is(emojiModifier, r) },
	"cased":                func(r rune) bool { return cased(r) && !caseIgnorable(r) },
	"ignorable":            caseIgnorable,
}

// privateUse reports whether r is a private-use character. Unicode gives
// them no case properties, and JavaScript runtimes disagree about some
// anyway: Bun on macOS uses Apple's ICU, which makes U+F870 to U+F8B8 case
// ignorable, where Node's bundled ICU (the runtime Basalt's MCP shipped on)
// and Go follow Unicode. The casing sweeps skip them; every other code point
// must agree.
func privateUse(r rune) bool { return 0xe000 <= r && r <= 0xf8ff || r >= 0xf0000 }

func checkSweep(v sweepVector) error {
	test := sweepClasses[v.Name]
	in := func(r rune) bool {
		i := sort.Search(len(v.Want), func(i int) bool { return v.Want[i][1] >= r })
		return i < len(v.Want) && v.Want[i][0] <= r
	}
	var bad []string
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if 0xd800 <= r && r <= 0xdfff || (v.Name == "ignorable" || v.Name == "cased") && privateUse(r) {
			continue
		}
		if test(r) != in(r) {
			bad = append(bad, fmt.Sprintf("U+%04X (go %v)", r, test(r)))
			if len(bad) == 10 {
				break
			}
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("%s differs at %v", v.Name, bad)
	}
	return nil
}

func checkLower(want [][2]json.RawMessage) error {
	lowered := map[rune]string{}
	for _, pair := range want {
		var r rune
		var s string
		if json.Unmarshal(pair[0], &r) != nil || json.Unmarshal(pair[1], &s) != nil {
			return fmt.Errorf("bad lower entry")
		}
		lowered[r] = s
	}
	var bad []string
	for r := rune(0); r <= unicode.MaxRune && len(bad) < 10; r++ {
		if 0xd800 <= r && r <= 0xdfff {
			continue
		}
		w, ok := lowered[r]
		if !ok {
			w = string(r)
		}
		if got := jsLower(string(r)); got != w {
			bad = append(bad, fmt.Sprintf("U+%04X %q want %q", r, got, w))
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("toLowerCase differs at %v", bad)
	}
	return nil
}

func checkCaseClasses(want [][]rune) error {
	jsClass := map[rune]int{}
	for i, class := range want {
		for _, r := range class {
			jsClass[r] = i
		}
	}
	goClasses := map[rune][]rune{}
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if 0xd800 <= r && r <= 0xdfff {
			continue
		}
		k := foldRune(r)
		goClasses[k] = append(goClasses[k], r)
	}
	for _, class := range goClasses {
		if len(class) < 2 {
			if i, ok := jsClass[class[0]]; ok {
				return fmt.Errorf("U+%04X folds alone here but with %U under /iu", class[0], want[i])
			}
			continue
		}
		i, ok := jsClass[class[0]]
		if !ok || !reflect.DeepEqual(class, want[i]) {
			var w []rune
			if ok {
				w = want[i]
			}
			return fmt.Errorf("case class %U, /iu has %U", class, w)
		}
	}
	return nil
}

func checkEntities(want [][2]string) error {
	for _, e := range want {
		if got := decodeString("&" + e[0] + ";"); got != e[1] {
			return fmt.Errorf("&%s; decodes to %q, want %q", e[0], got, e[1])
		}
	}
	return nil
}

// ---------------------------------------------------------------------------

// oracleCase is one vector and the check it must pass.
type oracleCase struct {
	name  string
	check func() error
}

// oracleBug is a vector whose recorded answer is Basalt's bug, which this
// package deliberately does not reproduce. For it the fixture comparison must
// still fail (so a regenerated fixture that no longer shows the bug is
// noticed) and check must pass: the right answer, worked out by hand.
type oracleBug struct {
	kind, source string
	why          string
	check        func() error
}

// bomBody is Basalt's one wrong answer in the corpus. micromark drops a
// byte-order mark at the start of what it parses without counting it in its
// offsets, and Basalt parsed a note's body alone, so when the body begins with
// U+FEFF (after frontmatter, or when markdownHidden is asked to start at 0)
// every range and destination it reports is one unit early. Hidden ranges
// then miss their last character, and changeLinks reads the destination
// "(Old.m" for "Old.md" and leaves the link unchanged
// (client/src/cli/mcp-markdown.ts:191, client/src/cli/mcp-links.ts:38).
const bomBody = "micromark does not count a leading byte-order mark in its offsets"

var oracleBugs = []oracleBug{
	{"hidden", "---\ntags: [a]\n---\n\ufeff`#x` [y](Old.md) #z\n", bomBody, func() error {
		return wantHidden("---\ntags: [a]\n---\n\ufeff`#x` [y](Old.md) #z\n", 18,
			[]Range{{19, 23}}, []Range{{19, 23}, {24, 35}})
	}},
	{"linkSpans", "---\ntags: [a]\n---\n\ufeff`#x` [y](Old.md) #z\n", bomBody, func() error {
		return wantSpans("---\ntags: [a]\n---\n\ufeff`#x` [y](Old.md) #z\n",
			LinkSpan{Start: 28, End: 34, WholeStart: 24, WholeEnd: 35, URL: "Old.md", FragmentAt: -1})
	}},
	{"hidden", "\ufeff`#x` #y", bomBody, func() error {
		return wantHidden("\ufeff`#x` #y", 0, []Range{{1, 5}}, []Range{{1, 5}})
	}},
	{"hidden", "\ufeff[Old.md](Old.md \"Old.md\")\r\n![[Old#Section|Old]] [[Old.md#^block]]\r\nUNSENT body\r\n", bomBody, func() error {
		return wantHidden("\ufeff[Old.md](Old.md \"Old.md\")\r\n![[Old#Section|Old]] [[Old.md#^block]]\r\nUNSENT body\r\n", 0,
			nil, []Range{{1, 26}})
	}},
	{"hidden", "---\ntags: [a]\n---\n\ufeff[x](Old.md) [[Old]]", bomBody, func() error {
		return wantHidden("---\ntags: [a]\n---\n\ufeff[x](Old.md) [[Old]]", 18, nil, []Range{{19, 30}})
	}},
	{"linkSpans", "---\ntags: [a]\n---\n\ufeff[x](Old.md) [[Old]]", bomBody, func() error {
		return wantSpans("---\ntags: [a]\n---\n\ufeff[x](Old.md) [[Old]]",
			LinkSpan{Start: 23, End: 29, WholeStart: 19, WholeEnd: 30, URL: "Old.md", FragmentAt: -1},
			LinkSpan{Start: 33, End: 36, WholeStart: 31, WholeEnd: 38, URL: "Old", Wiki: true, FragmentAt: -1})
	}},
	{"changeLinks", "---\ntags: [a]\n---\n\ufeff[x](Old.md) [[Old]]", bomBody, func() error {
		source := "---\ntags: [a]\n---\n\ufeff[x](Old.md) [[Old]]"
		inventory := []string{"Index.md", "Old.md", "b", "d.md", "Other.md"}
		moved, _, err := ChangeLinks(source, LinkChange{Path: "Index.md", From: "Old.md", To: "Folder/New.md", Inventory: inventory, Canonical: testCanonical})
		if err != nil {
			return err
		}
		want := []SourceEdit{{23, 29, "Old.md", "Folder/New.md"}, {33, 36, "Old", "Folder/New"}}
		if !reflect.DeepEqual(moved, want) {
			return fmt.Errorf("move: got %+v, want %+v", moved, want)
		}
		deleted, _, err := ChangeLinks(source, LinkChange{Path: "Index.md", From: "Old.md", Delete: true, Inventory: []string{"Index.md", "Old.md", "b"}, Canonical: testCanonical})
		if err != nil {
			return err
		}
		want = []SourceEdit{{19, 30, "[x](Old.md)", "~~[x](Old.md)~~"}, {31, 38, "[[Old]]", "~~[[Old]]~~"}}
		if !reflect.DeepEqual(deleted, want) {
			return fmt.Errorf("delete: got %+v, want %+v", deleted, want)
		}
		return nil
	}},
}

func wantHidden(source string, start int, plain, links []Range) error {
	if got := MarkdownHidden(source, start, false); plain != nil && !reflect.DeepEqual(got, plain) {
		return fmt.Errorf("without links: got %v, want %v", got, plain)
	}
	if got := MarkdownHidden(source, start, true); !reflect.DeepEqual(got, links) {
		return fmt.Errorf("with links: got %v, want %v", got, links)
	}
	return nil
}

func wantSpans(source string, want ...LinkSpan) error {
	got, err := LinkSpans(source)
	if err != nil || !reflect.DeepEqual(got, want) {
		return fmt.Errorf("got %+v %v, want %+v", got, err, want)
	}
	return nil
}

// withBugs routes a case through oracleBugs when its vector is one.
func withBugs(kind, source string, c func() error) func() error {
	for _, b := range oracleBugs {
		if b.kind == kind && b.source == source {
			return func() error {
				if c() == nil {
					return fmt.Errorf("the fixture no longer shows Basalt's bug (%s); remove it from oracleBugs", b.why)
				}
				return b.check()
			}
		}
	}
	return c
}

func oracleCases(t testing.TB) []oracleCase {
	var cases []oracleCase
	add := func(name string, check func() error) { cases = append(cases, oracleCase{name, check}) }
	for i, v := range section[pageVector](t, "page") {
		add(fmt.Sprintf("page/%d", i), func() error { return checkPage(v) })
	}
	for i, v := range section[fingerprintVector](t, "cursor", "fingerprints") {
		add(fmt.Sprintf("cursor/fingerprints/%d", i), func() error { return checkFingerprint(v) })
	}
	for i, v := range section[tokenVector](t, "cursor", "tokens") {
		add(fmt.Sprintf("cursor/tokens/%d", i), func() error { return checkToken(v) })
	}
	for i, v := range section[positionVector](t, "cursor", "positions") {
		add(fmt.Sprintf("cursor/positions/%d", i), func() error { return checkPosition(v) })
	}
	for i, vault := range section[searchVault](t, "search") {
		for j, q := range vault.Queries {
			add(fmt.Sprintf("search/%d/%d %q", i, j, q.Input.Query), func() error { return checkSearch(vault, q) })
		}
	}
	for i, v := range section[compareVector](t, "compare") {
		add(fmt.Sprintf("compare/%d", i), func() error { return checkCompare(v) })
	}
	for i, v := range section[noteVector](t, "notes") {
		name := fmt.Sprintf("%d %s", i, short(string(v.Source)))
		src := string(v.Source)
		add("frontmatter/"+name, withBugs("frontmatter", src, func() error { return checkFrontmatter(tagsVector{v.Source, v.Frontmatter}) }))
		add("tags/"+name, withBugs("tags", src, func() error { return checkTags(tagsVector{v.Source, v.Tags}) }))
		add("hidden/"+name, withBugs("hidden", src, func() error { return checkNoteHidden(v) }))
		add("linkSpans/"+name, withBugs("linkSpans", src, func() error { return checkSpans(tagsVector{v.Source, v.Links}) }))
	}
	for i, v := range section[inlineVector](t, "inline") {
		add(fmt.Sprintf("inline/%d", i), func() error { return checkInline(v) })
	}
	for i, v := range section[validateVector](t, "validateTag") {
		add(fmt.Sprintf("validateTag/%d %q", i, v.Input), func() error { return checkValidate(v) })
	}
	for i, v := range section[matchesVector](t, "matchesTag") {
		add(fmt.Sprintf("matchesTag/%d", i), func() error { return checkMatches(v) })
	}
	for i, v := range section[patternVector](t, "tagPattern") {
		add(fmt.Sprintf("tagPattern/%d", i), func() error { return checkPattern(v) })
	}
	for i, v := range section[resolveVector](t, "resolve") {
		add(fmt.Sprintf("resolve/%d", i), func() error { return checkResolve(v) })
	}
	for i, v := range section[changeLinksVector](t, "changeLinks") {
		add(fmt.Sprintf("changeLinks/%d %s", i, short(string(v.Source))),
			withBugs("changeLinks", string(v.Source), func() error { return checkChangeLinks(v) }))
	}
	for i, v := range section[decodeVector](t, "decodeString") {
		add(fmt.Sprintf("decodeString/%d", i), func() error { return checkDecode(v) })
	}
	var sweeps map[string]json.RawMessage
	if err := json.Unmarshal(loadFixture(t)["sweeps"], &sweeps); err != nil {
		t.Fatal(err)
	}
	for name := range sweepClasses {
		var ranges [][2]rune
		if err := json.Unmarshal(sweeps[name], &ranges); err != nil {
			t.Fatal(name, err)
		}
		v := sweepVector{Name: name, Want: ranges}
		add("sweeps/"+name, func() error { return checkSweep(v) })
	}
	var lower [][2]json.RawMessage
	var classes [][]rune
	var entities [][2]string
	if json.Unmarshal(sweeps["lower"], &lower) != nil || json.Unmarshal(sweeps["caseClasses"], &classes) != nil ||
		json.Unmarshal(sweeps["entities"], &entities) != nil {
		t.Fatal("bad sweeps")
	}
	add("sweeps/lower", func() error { return checkLower(lower) })
	add("sweeps/caseClasses", func() error { return checkCaseClasses(classes) })
	add("sweeps/entities", func() error { return checkEntities(entities) })
	return cases
}

func TestOracle(t *testing.T) {
	cases := oracleCases(t)
	failed := map[string]int{}
	var failing []string
	for _, c := range cases {
		if err := c.check(); err != nil {
			kind := strings.SplitN(c.name, "/", 2)[0]
			failed[kind]++
			failing = append(failing, c.name)
			if failed[kind] <= 8 {
				t.Errorf("%s: %v", c.name, err)
			}
		}
	}
	if out := os.Getenv("ORACLE_FAILURES"); out != "" {
		// A debugging aid: the names of every failing vector.
		_ = os.WriteFile(out, []byte(strings.Join(failing, "\n")), 0o644)
	}
	for kind, n := range failed {
		t.Errorf("%s: %d vectors differ from Basalt", kind, n)
	}
	t.Logf("%d oracle vectors", len(cases))
}
