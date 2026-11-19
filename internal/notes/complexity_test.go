package notes

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// complexityCeiling is how long one parser may take over one crafted note
// of NoteBytes. The parsers once took minutes over some of these
// (security review M1); linear ones take well under a second, and the
// ceiling is generous so that a slow CI machine does not fail it. The race
// detector, which the gate and CI run with, multiplies it by raceSlowdown:
// still far below the minutes a quadratic parser takes.
const complexityCeiling = 2 * time.Second * raceSlowdown

// craftedNotes are 1 MiB notes built to make a quadratic parser slow.
func craftedNotes() map[string]string {
	const n = NoteBytes
	fill := func(prefix, unit, suffix string) string {
		var b strings.Builder
		b.WriteString(prefix)
		for i := 0; b.Len()+len(unit)+len(suffix) <= n; i++ {
			b.WriteString(strings.ReplaceAll(unit, "%d", fmt.Sprint(i)))
		}
		b.WriteString(suffix)
		return b.String()
	}
	return map[string]string{
		"open brackets":  strings.Repeat("[", n),
		"open wikilinks": strings.Repeat("[[", n/2),
		"quote nesting":  strings.Repeat("> ", n/2),
		"list nesting":   strings.Repeat("- ", n/2),
		"lazy lines":     fill(strings.Repeat("> ", maxNesting)+"a\n", "a\n", ""),
		"nested lines":   fill("", strings.Repeat("> ", maxNesting)+"a\n", ""),
		"lazy tags":      fill("", strings.Repeat("> ", maxNesting)+"a\n<b>\n", ""),
		"indented items": indentedItems(n),
		// cmark's pathological inputs (test/pathological_tests.py).
		"nested strong":      fill("", "*a **a ", ""),
		"emphasis closers":   fill("", "a_ ", ""),
		"emphasis openers":   fill("", "_a ", ""),
		"link closers":       fill("", "a]", ""),
		"link openers":       fill("", "[a", ""),
		"mismatched":         fill("", "*a_ ", ""),
		"nested brackets":    strings.Repeat("[", n/2-1) + "a" + strings.Repeat("]", n/2-1),
		"backtick runs":      backtickRuns(n),
		"unclosed angle":     fill("", "[a](<b", ""),
		"unclosed links":     fill("", "[a](b", ""),
		"reference uses":     fill("[a]: u\n\n", "[a]", ""),
		"unclosed comments":  fill("", "<!-- ", ""),
		"unclosed decls":     fill("", "<!A ", ""),
		"unclosed cdata":     fill("", "<![CDATA[", ""),
		"unclosed PIs":       fill("", "<?", ""),
		"tabbed quotes":      strings.Repeat(">\t", n/2),
		"deep then wide":     deepThenWide(n),
		"frontmatter scalar": fill("---\ntags: ", "t%d ", "\n---\nbody\n"),
		"block tags":         fill("---\ntags:\n", "  - t%d\n", "---\nbody\n"),
		"hashtags":           fill("", "#t%d ", ""),
		"wikilinks":          fill("", "[[n%d]] ", ""),
		"links and wikis":    fill("", "[a](b) [[c]] `d` ", ""),
		"flow tags":          fill("---\ntags: [", "t%d,", "]\n---\nbody\n"),
		"many keys":          fill("---\n", "k%d: v\n", "---\nbody\n"),
		"definitions":        fill("", "[a]: b\n", ""),
		"distinct defs":      fill("", "[a%d]: b\n", ""),
		"open images":        strings.Repeat("![", n/2),
		"brackets and text":  strings.Repeat("[a ", n/3),
		"links deep inside":  fill(strings.Repeat("> ", maxNesting-1), "[a](b) ", ""),
	}
}

// indentedItems nests each list item in the one before by indentation alone:
// one marker a line, and as deep as the note is long.
func indentedItems(n int) string {
	var b strings.Builder
	for i := 0; b.Len()+2*i+4 <= n; i++ {
		b.WriteString(strings.Repeat("  ", i) + "- a\n")
	}
	return b.String()
}

// backtickRuns is code span openers of every length, each a run of
// backticks one longer than the last, none closed.
func backtickRuns(n int) string {
	var b strings.Builder
	for i := 1; b.Len()+i+1 <= n; i++ {
		b.WriteString("e" + strings.Repeat("`", i))
	}
	return b.String()
}

// deepThenWide nests list items by indentation as deep as maxNesting allows
// (a list and its item are two), then fills the note with lines that
// continue them all.
func deepThenWide(n int) string {
	const depth = maxNesting / 2
	var b strings.Builder
	for i := 0; i < depth; i++ {
		b.WriteString(strings.Repeat("  ", i) + "- a\n")
	}
	line := strings.Repeat("  ", depth) + "a\n"
	for b.Len()+len(line) <= n {
		b.WriteString(line)
	}
	return b.String()
}

func TestCraftedNotesParseInLinearTime(t *testing.T) {
	if testing.Short() {
		t.Skip("parses several 1 MiB notes")
	}
	parsers := map[string]func(string) error{
		"TagOccurrences": func(s string) error { _, err := TagOccurrences(s); return err },
		"LinkKeys":       func(s string) error { _, err := LinkKeys(s, "a.md"); return err },
		"LinkSpans":      func(s string) error { _, err := LinkSpans(s); return err },
	}
	for name, src := range craftedNotes() {
		for pname, parse := range parsers {
			t.Run(name+"/"+pname, func(t *testing.T) {
				done := make(chan struct{})
				start := time.Now()
				go func() {
					defer close(done)
					_ = parse(src)
				}()
				select {
				case <-done:
					if took := time.Since(start); took > complexityCeiling {
						t.Fatalf("%s over %q took %v, ceiling %v", pname, name, took, complexityCeiling)
					}
				case <-time.After(complexityCeiling):
					t.Fatalf("%s over %q still running after %v", pname, name, complexityCeiling)
				}
			})
		}
	}
}

// Quotes and lists nested past maxNesting are refused as too_complex, and
// nesting up to it still reads: a tag inside is found.
func TestDeepNestingIsRefusedAsTooComplex(t *testing.T) {
	deep := strings.Repeat("> ", maxNesting+1) + "#tag\n"
	for name, parse := range map[string]func(string) error{
		"TagOccurrences": func(s string) error { _, err := TagOccurrences(s); return err },
		"LinkSpans":      func(s string) error { _, err := LinkSpans(s); return err },
	} {
		r, ok := parse(deep).(*Refusal)
		if !ok || r.Code != "too_complex" {
			t.Errorf("%s over %d nested quotes: %v, want too_complex", name, maxNesting+1, r)
		}
	}
	for _, src := range []string{
		strings.Repeat("> ", maxNesting) + "#tag\n",
		strings.Repeat("- ", maxNesting/2) + "#tag\n",
	} {
		occ, err := TagOccurrences(src)
		if err != nil || len(occ) != 1 || occ[0].Tag != "tag" {
			t.Errorf("at the limit: %v, %v", occ, err)
		}
	}
}
