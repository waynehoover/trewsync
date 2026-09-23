package notes

import "strings"

// yamlRefused is a pass over frontmatter, before yaml.v3 sees it, for the
// places where npm yaml refuses text libyaml would accept once prepared, or
// reads text libyaml would read differently. It reports whether the
// frontmatter must be refused. The oracle found each rule; frontmatter_test.go
// has a case for every one.
//
// Anchor and alias names. libyaml reads a name as letters, digits, "_" and "-"
// only; npm yaml, as YAML allows, reads up to a space or a flow indicator. So
// "*k:" is an alias named "k:" (which npm yaml then warns about) to one, and
// an alias followed by a colon to the other. A name the two would read
// differently is refused rather than read wrongly.
//
// Lines of only spaces and tabs. prepareYAML turns their tabs into spaces,
// because libyaml refuses a tab where npm yaml sees a blank line. npm yaml
// does not always see a blank line, and refuses one that contains a tab:
//
//   - inside a block scalar, when it is indented less than the scalar's
//     content (or the scalar has no content);
//   - directly after a mapping key whose value has not begun ("a:", or
//     "a: &x # c"), when another entry of that mapping or an outer one
//     follows, so that the tab would be the empty value's indentation;
//   - inside a quoted scalar that runs over several lines, when it starts
//     with the tab.
//
// Quoted scalars, comments and block scalars are skipped, so text inside them
// is not taken for a property.
func yamlRefused(s string) bool {
	lines := strings.SplitAfter(s, "\n")
	var quote byte // the quote of a scalar that runs past its line
	block := -1    // the header indentation of a block scalar being skipped
	content := -1  // that scalar's content indentation, once known
	valuePending, pendingIndent := false, 0
	for n, raw := range lines {
		line := strings.TrimRight(raw, "\r\n")
		lead := len(line) - len(strings.TrimLeft(line, " "))
		blank := strings.Trim(line, " \t") == ""
		tabbed := blank && strings.Contains(line, "\t")
		start := 0
		if quote != 0 {
			if tabbed && line[0] == '\t' {
				return true
			}
			end := closeQuote(line, 0, quote)
			if end < 0 {
				continue
			}
			quote, start = 0, end+1
		} else if block >= 0 {
			if blank {
				if tabbed {
					c := content
					if c < 0 {
						c = nextIndent(lines[n+1:])
					}
					if c <= block || lead < c {
						return true
					}
				}
				continue
			}
			if lead > block {
				if content < 0 {
					content = lead
				}
				continue
			}
			block, content = -1, -1
		}
		if blank {
			if tabbed && valuePending && siblingFollows(lines[n+1:], pendingIndent) {
				return true
			}
			valuePending = false
			continue
		}
		for i := start; i < len(line); i++ {
			c := line[i]
			if !yamlNodeStart(line, i) {
				if c == '#' && i > 0 && (line[i-1] == ' ' || line[i-1] == '\t') {
					break
				}
				continue
			}
			switch c {
			case '#':
				i = len(line)
			case '"', '\'':
				end := closeQuote(line, i+1, c)
				if end < 0 {
					quote = c
					i = len(line)
				} else {
					i = end
				}
			case '|', '>':
				block, content = lead, -1
				i = len(line)
			case '&', '*':
				for i++; i < len(line) && !isYAMLSpace(line[i]) && strings.IndexByte(",[]{}", line[i]) < 0; i++ {
					if !asciiAlnum(line[i]) && line[i] != '_' && line[i] != '-' {
						return true
					}
				}
				i--
			}
		}
		valuePending = quote == 0 && block < 0 && awaitsValue(line)
		pendingIndent = lead
	}
	return false
}

// siblingFollows reports whether the next line with content after an empty
// value is another entry of the mapping it belongs to, or of one outside it:
// neither a comment, nor a "-" entry, nor indented more than the key at
// indent. That is when npm yaml takes a tab on the blank line between for the
// value's indentation.
func siblingFollows(lines []string, indent int) bool {
	for _, l := range lines {
		t := strings.TrimLeft(strings.TrimRight(l, "\r\n"), " ")
		if strings.Trim(t, " \t") == "" {
			continue
		}
		lead := len(strings.TrimRight(l, "\r\n")) - len(t)
		if t[0] == '#' || lead > indent || t == "-" || strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "-\t") {
			return false
		}
		return true
	}
	return false
}

// closeQuote is the offset in line of the quote that closes a scalar opened
// with q, searching from from, or -1 when the scalar runs past the line.
func closeQuote(line string, from int, q byte) int {
	for i := from; i < len(line); i++ {
		switch {
		case q == '"' && line[i] == '\\':
			i++
		case line[i] == q:
			if q == '\'' && i+1 < len(line) && line[i+1] == '\'' {
				i++
				continue
			}
			return i
		}
	}
	return -1
}

// nextIndent is the indentation of the first line with content among lines.
func nextIndent(lines []string) int {
	for _, l := range lines {
		if strings.Trim(l, " \t\r\n") != "" {
			return len(l) - len(strings.TrimLeft(l, " "))
		}
	}
	return -1
}

// awaitsValue reports whether a line ends a mapping key whose value has not
// begun: after its comment and any trailing anchors and tags are removed, it
// ends with the ":" indicator.
func awaitsValue(line string) bool {
	for i := 1; i < len(line); i++ {
		if line[i] == '#' && (line[i-1] == ' ' || line[i-1] == '\t') {
			line = line[:i]
			break
		}
	}
	line = strings.TrimRight(line, " \t")
	for {
		cut := strings.LastIndexAny(line, " \t")
		last := line[cut+1:]
		if cut < 0 || last == "" || (last[0] != '&' && last[0] != '!') {
			break
		}
		line = strings.TrimRight(line[:cut], " \t")
	}
	return strings.HasSuffix(line, ":")
}
