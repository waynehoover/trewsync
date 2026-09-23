package notes

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// yamlAlone is what yaml.v3, given frontmatter as it is, makes of it: its
// error, or each entry of the root mapping as key=tag:value@line:column, with
// the items of a collection value after it in brackets.
func yamlAlone(body string) string {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(body), &doc); err != nil {
		return "error: " + err.Error()
	}
	var parts []string
	m := doc.Content[0]
	for i := 0; i+1 < len(m.Content); i += 2 {
		k, v := m.Content[i], m.Content[i+1]
		parts = append(parts, fmt.Sprintf("%s=%s:%q@%d:%d", k.Value, v.Tag, v.Value, v.Line, v.Column))
		for _, c := range v.Content {
			parts = append(parts, fmt.Sprintf("[%s:%q@%d:%d]", c.Tag, c.Value, c.Line, c.Column))
		}
	}
	return strings.Join(parts, " ")
}

// frontmatterAnswer is TagOccurrences for a note, as Basalt's answer is
// written below: the frontmatter tags with their UTF-16 ranges, or the
// refusal.
func frontmatterAnswer(source string) string {
	found, err := TagOccurrences(source)
	if err != nil {
		return codeOf(err)
	}
	var parts []string
	for _, o := range found {
		if o.Location == "frontmatter" {
			parts = append(parts, fmt.Sprintf("%s %d-%d", o.Tag, o.Start, o.End))
		}
	}
	return strings.Join(parts, ", ")
}

// TestFrontmatterDivergences holds frontmatter to Basalt's answers where
// yaml.v3 alone reads it differently from npm yaml: one or more cases for
// each difference frontmatter.go and yamlscan.go list. stock is what yaml.v3
// makes of the frontmatter, and basalt is Basalt's answer for the note,
// taken from the TypeScript (the oracle holds it too: every note here is
// among the generator's DIVERGENCES or is generated). A case where yaml.v3
// refuses as Basalt did, for a reason of its own, shows that the pass that
// replaces its reason still refuses.
func TestFrontmatterDivergences(t *testing.T) {
	cases := []struct {
		name, body    string
		stock, basalt string
	}{
		// Line breaks.
		{"a lone CR is text", "tags: a\rb: c\n",
			`tags=!!str:"a"@1:7 b=!!str:"c"@2:4`, "invalid_frontmatter"},
		{"U+2028 is text", "tags: a\u2028b\n",
			`error: yaml: line 2: could not find expected ':'`, "a 10-13, b 10-13"},
		{"NEL is text, and no tag", "tags: a\u0085b\n",
			`error: yaml: line 2: could not find expected ':'`, "invalid_tag"},

		// Characters libyaml's reader refuses.
		{"a C0 control", "tags: [a]\nx: p\x01q\n", `error: yaml: control characters are not allowed`, "a 11-12"},
		{"DEL", "tags: [a]\nx: p\x7fq\n", `error: yaml: control characters are not allowed`, "a 11-12"},
		{"U+FFFE", "tags: [a]\nx: p\ufffeq\n", `error: yaml: control characters are not allowed`, "a 11-12"},

		// Scalar types.
		{"a date is a string", "tags: [2024-01-01]\n",
			`tags=!!seq:""@1:7 [!!timestamp:"2024-01-01"@1:8]`, "2024-01-01 11-21"},
		{"1_000 is a string", "tags: [1_000]\n", `tags=!!seq:""@1:7 [!!int:"1_000"@1:8]`, "1_000 11-16"},
		{"! makes a string", "tags: ! 12\n", `tags=!!int:"12"@1:7`, "invalid_tag"},

		// Tags npm yaml warns about.
		{"an unknown tag", "tags: !foo a\n", `tags=!foo:"a"@1:7`, "invalid_frontmatter"},
		{"a tag the value does not fit", "tags: !!int x\n", `tags=!!int:"x"@1:7`, "invalid_frontmatter"},
		{"a scalar tag on a collection", "tags: !!str [a]\n", `tags=!!str:""@1:7 [!!str:"a"@1:14]`, "invalid_frontmatter"},

		// Duplicate keys, compared by resolved value.
		{"a repeated key", "tags: a\ntags: b\n", `tags=!!str:"a"@1:7 tags=!!str:"b"@2:7`, "invalid_frontmatter"},
		{"1 and 1.0 are one key", "1: a\n1.0: b\ntags: c\n",
			`1=!!str:"a"@1:4 1.0=!!str:"b"@2:6 tags=!!str:"c"@3:7`, "invalid_frontmatter"},
		{"1 and '1' are two", "1: a\n'1': b\ntags: c\n",
			`1=!!str:"a"@1:4 1=!!str:"b"@2:6 tags=!!str:"c"@3:7`, "c 22-23"},
		{"a repeated key in a flow mapping", "tags: a\nx: {k: 1, k: 2}\n",
			`tags=!!str:"a"@1:7 x=!!map:""@2:4 [!!str:"k"@2:5] [!!int:"1"@2:8] [!!str:"k"@2:11] [!!int:"2"@2:14]`,
			"invalid_frontmatter"},

		// Positions: yaml.v3 places a node at its properties.
		{"a range leaves out the tag and the comment", "tags: !!str a # c\n", `tags=!!str:"a"@1:7`, "a 16-17"},
		{"and so in a sequence", "tags:\n  - !!str b   # c\n  - 'q' \n",
			`tags=!!seq:""@2:3 [!!str:"b"@2:5] [!!str:"q"@3:5]`, "b 20-21, q 32-35"},

		// Anchor and alias names.
		{"a name with a dot", "tags: [a]\nb: &k.x c\nd: *k.x\n",
			`error: yaml: line 2: did not find expected alphabetic or numeric character`, "a 11-12"},
		{"a name with a colon inside", "tags: [a]\nb: &k:x c\n",
			`tags=!!seq:""@1:7 [!!str:"a"@1:8] b=!!str:":x c"@2:4`, "a 11-12"},
		{"a name outside ASCII", "tags: [a]\nb: &\u00e9 c\nd: [*\u00e9]\n",
			`error: yaml: line 2: did not find expected alphabetic or numeric character`, "a 11-12"},
		{"an anchor after a tag", "tags: [a]\nb: !!str &k.x c\n",
			`error: yaml: line 2: did not find expected alphabetic or numeric character`, "a 11-12"},
		{"an anchor ending in a colon, both refuse", "tags: [a]\nb: &k: c\n",
			`error: yaml: line 2: mapping values are not allowed in this context`, "invalid_frontmatter"},
		{"an alias ending in a colon, both refuse", "tags: [a]\nb: &k c\nd: *k:\n",
			`error: yaml: line 3: mapping values are not allowed in this context`, "invalid_frontmatter"},

		// Lines of only spaces and tabs.
		{"a tab-only line is blank", "tags: [a]\n\t\nb: c\n",
			`error: yaml: line 2: found character that cannot start any token`, "a 11-12"},
		{"but not in a quoted scalar", "tags: [x]\na: \"p\n\t\n q\"\n",
			`tags=!!seq:""@1:7 [!!str:"x"@1:8] a=!!str:"p\nq"@2:4`, "invalid_frontmatter"},
		{"nor less indented in a block scalar, both refuse", "tags: [a]\nb: |\n  x\n\t\n  y\n",
			`error: yaml: line 2: found a tab character where an indentation space is expected`, "invalid_frontmatter"},
		{"nor as an empty value's indentation, both refuse", "a:\n\t\nb: c\ntags: [x]\n",
			`error: yaml: line 2: found character that cannot start any token`, "invalid_frontmatter"},

		// A tab after a block indicator.
		{"after -", "tags:\n-\ta\n", `error: yaml: line 2: found character that cannot start any token`, "a 12-13"},
		{"after ? and :", "?\ttags\n:\t[a]\n", `error: yaml: found character that cannot start any token`, "a 14-15"},

		// Flow collections.
		{"a colon before a flow indicator is a key", "tags: [x:]\n",
			`tags=!!seq:""@1:7 [!!str:"x:"@1:8]`, "invalid_frontmatter"},
		{"an implicit key over lines in a sequence", "a: [x\n  y:]\ntags: [t]\n",
			`a=!!seq:""@1:4 [!!str:"x y:"@1:5] tags=!!seq:""@3:7 [!!str:"t"@3:8]`, "invalid_frontmatter"},

		// Text the scan must not take for properties, which yaml.v3 reads
		// as npm yaml does.
		{"a continuation line", "tags: [a]\ndescription: a long\n  *important* note\n",
			`tags=!!seq:""@1:7 [!!str:"a"@1:8] description=!!str:"a long *important* note"@2:14`, "a 11-12"},
		{"after a comma in a plain scalar", "tags: [a]\ntitle: Notes, *draft*\n",
			`tags=!!seq:""@1:7 [!!str:"a"@1:8] title=!!str:"Notes, *draft*"@2:8`, "a 11-12"},
		{"a continuation line in a flow sequence", "tags: [a]\nb: [c\n  *d.e]\n",
			`tags=!!seq:""@1:7 [!!str:"a"@1:8] b=!!seq:""@2:4 [!!str:"c *d.e"@2:5]`, "a 11-12"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := yamlAlone(c.body); got != c.stock {
				t.Errorf("yaml.v3 alone: got %s, want %s", got, c.stock)
			}
			if got := frontmatterAnswer("---\n" + c.body + "---\n"); got != c.basalt {
				t.Errorf("got %q, Basalt %q", got, c.basalt)
			}
		})
	}
}

// TestFrontmatterKnownDivergence records the one place the deep corpus found
// where the port still answers otherwise than Basalt: npm yaml reads an
// implicit key that runs over lines in a flow mapping, and yaml.v3 refuses
// it, so the port refuses frontmatter Basalt read. It errs by refusing, so a
// tool reports invalid_frontmatter rather than a wrong answer.
func TestFrontmatterKnownDivergence(t *testing.T) {
	body := "a: {x\n  y: z}\ntags: [t]\n"
	if got := yamlAlone(body); got != `error: yaml: line 1: did not find expected ',' or '}'` {
		t.Errorf("yaml.v3 alone: got %s; if it now reads this, the port may too", got)
	}
	if got := frontmatterAnswer("---\n" + body + "---\n"); got != "invalid_frontmatter" {
		t.Errorf("got %q; Basalt read \"t 25-26\"", got)
	}
}

// TestFrontmatterFrame: Basalt found the closing delimiter with a JavaScript
// expression in multiline mode, where "^" also matches after a lone CR,
// U+2028 and U+2029. Go's (?m) matches only after LF.
func TestFrontmatterFrame(t *testing.T) {
	for _, source := range []string{"---\ntags: a\r---\n#b", "---\ntags: a\u2028---\n#b"} {
		if regexp.MustCompile(`(?m)^---[ \t]*(?:\r?\n|$)`).FindStringIndex(source[4:]) != nil {
			t.Errorf("%q: Go's multiline anchor now matches there", source)
		}
		f, err := FindFrontmatter(source)
		if err != nil || !f.Present || f.End != 12 || f.Body != 16 {
			t.Errorf("%q: got %+v %v, want the frontmatter to end at 12 and the body to start at 16", source, f, err)
		}
		if got := frontmatterAnswer(source); got != "a 10-12" {
			t.Errorf("%q: got %q, Basalt \"a 10-12\"", source, got)
		}
		if got := contentTags(t, source); len(got) != 1 || got[0] != "b" {
			t.Errorf("%q: content tags %q, Basalt [\"b\"]", source, got)
		}
	}
}
