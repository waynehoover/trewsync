package notes

import "strings"

// scanYAML is a pass over frontmatter, before yaml.v3 sees it, for the
// places where npm yaml refuses text libyaml would accept once prepared, or
// reads text libyaml would read differently. It reports whether the
// frontmatter must be refused, where its anchor and alias names are, and which
// of its comment lines prepareYAML must untab. The oracle found each rule;
// frontmatter_test.go has a case for every one.
//
// Anchor and alias names. libyaml reads a name as letters, digits, "_" and "-"
// only; npm yaml, as YAML allows, reads up to a space or a flow indicator, and
// refuses a name that ends in ":" as ambiguous. So "*k:" is an alias named
// "k:" to one, and an alias followed by a colon to the other; npm yaml refuses
// it, and so does this pass. Other names libyaml cannot read, such as "k.x",
// are renamed by prepareYAML.
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
// Other lines that start with a tab. npm yaml refuses a line of a quoted
// scalar, or a line with content in a flow collection, that starts with a
// tab, and libyaml reads both. It reads a comment line whose indentation
// holds a tab as a comment, where libyaml refuses the tab; prepareYAML turns
// those tabs into spaces (the untab lines), except on the line that ends a
// block scalar, which npm yaml refuses: it takes a tab there for the
// scalar's own, too little indented.
//
// Comments. npm yaml refuses a comment that no space or tab separates from
// the token before it: after a quoted scalar, or after a flow indicator.
// libyaml reads it.
//
// Quoted scalars, plain scalars, comments and block scalars are skipped, so
// text inside them is not taken for a property. A plain scalar is skipped to
// the ": " that makes it a key, a comment, or in a flow collection a flow
// indicator; when it runs to the end of its line, the lines after it that
// are indented more than its parent node continue it. Anything this misreads
// fails safe: a property it misses is refused by libyaml, and a name it takes
// from inside a scalar is refused by renamesVerified.
func scanYAML(s string) (names []byteRange, untab []int, refused bool) {
	lines := strings.SplitAfter(s, "\n")
	var quote byte     // the quote of a scalar that runs past its line
	block := -1        // the header indentation of a block scalar being skipped
	content := -1      // that scalar's content indentation, once known
	var flow []byte    // the flow collections open, innermost last: '[' or '{'
	open := -1         // where the parent of a plain scalar that may continue begins
	flowPlain := false // a plain scalar in a flow collection ran to the end of its line
	key := -1          // the indentation of a key whose value has not begun
	valuePending, pendingIndent := false, 0
	closed := -1 // where a token ends that a comment must not touch
	next := 0    // where the next line starts in s
	for n, raw := range lines {
		at := next
		next += len(raw)
		line := strings.TrimRight(raw, "\r\n")
		lead := len(line) - len(strings.TrimLeft(line, " "))
		blank := strings.Trim(line, " \t") == ""
		tabbed := blank && strings.Contains(line, "\t")
		indentTab := strings.Contains(line[:len(line)-len(strings.TrimLeft(line, " \t"))], "\t")
		comment := !blank && strings.TrimLeft(line, " \t")[0] == '#'
		start := 0
		closed = -1
		if quote == 0 && len(flow) > 0 && !blank && !comment && line[0] == '\t' {
			return nil, nil, true
		}
		if open >= 0 && !blank {
			if lead > open && line[lead] != '#' {
				// A line that continues the plain scalar is text, not nodes;
				// a comment ends the scalar.
				if plainEnd(line, lead, false) < len(line) {
					open = -1
				}
				valuePending = false
				continue
			}
			open = -1
		}
		if flowPlain && !blank {
			// The scalar goes on at the start of this line, to whatever ends
			// it in a flow collection.
			flowPlain = false
			c := line[lead]
			indicator := c == ':' && (lead+1 == len(line) || strings.IndexByte(" \t,[]{}", line[lead+1]) >= 0)
			if strings.IndexByte(",[]{}#", c) < 0 && !indicator {
				start = plainEnd(line, lead, true)
				if start < len(line) && line[start] == ':' && len(flow) > 0 && flow[len(flow)-1] == '[' {
					// npm yaml refuses an implicit key in a flow sequence
					// that runs over lines, and libyaml can read its colon
					// as part of the scalar.
					return nil, nil, true
				}
				flowPlain = start == len(line)
			}
		}
		if quote != 0 {
			if line != "" && line[0] == '\t' {
				return nil, nil, true
			}
			end := closeQuote(line, 0, quote)
			if end < 0 {
				continue
			}
			quote, start, closed = 0, end+1, end+1
		} else if block >= 0 {
			if blank {
				if tabbed {
					c := content
					if c < 0 {
						c = nextIndent(lines[n+1:])
					}
					if c <= block || lead < c {
						return nil, nil, true
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
			if indentTab {
				return nil, nil, true
			}
			block, content = -1, -1
		}
		if blank {
			if tabbed && valuePending && siblingFollows(lines[n+1:], pendingIndent) {
				return nil, nil, true
			}
			valuePending = false
			continue
		}
		if comment && indentTab && start == 0 && len(flow) == 0 {
			untab = append(untab, n)
		}
		after := -1  // where the node that properties precede begins
		parent := -1 // where the last node begun that is not a property begins
		if start == 0 && len(flow) == 0 {
			parent = key // a key on an earlier line, whose value this may be
		}
		for i := start; i < len(line); i++ {
			c := line[i]
			if c == '#' && i == closed {
				return nil, nil, true
			}
			if len(flow) > 0 && strings.IndexByte("[]{}", c) >= 0 {
				if c == '[' || c == '{' {
					flow = append(flow, c)
				} else {
					flow = flow[:len(flow)-1]
					closed = i + 1
				}
				continue
			}
			if i != after && !yamlNodeStart(line, i) {
				if c == '#' && i > 0 && (line[i-1] == ' ' || line[i-1] == '\t') {
					break
				}
				continue
			}
			switch c {
			case ' ', '\t':
				// Separation before the node.
			case '#':
				if i > 0 && line[i-1] != ' ' && line[i-1] != '\t' {
					return nil, nil, true // directly after "[", "{" or ","
				}
				i = len(line)
			case '"', '\'':
				parent = i
				end := closeQuote(line, i+1, c)
				if end < 0 {
					quote = c
					i = len(line)
				} else {
					i, closed = end, end+1
				}
			case '|', '>':
				block, content = lead, -1
				i = len(line)
			case '[', '{':
				flow = append(flow, c)
			case ']', '}', ',', '%', '@', '`':
				// Nothing begins here that matters: both parsers refuse it
				// outside a flow collection.
			case '&', '*', '!':
				end := propertyEnd(line, i)
				if c != '!' {
					if end > i+1 && line[end-1] == ':' {
						return nil, nil, true
					}
					names = append(names, byteRange{at + i + 1, at + end})
				}
				if c != '*' {
					// A tag or an anchor is followed by more properties or by
					// the node they belong to.
					after = end
					for after < len(line) && (line[after] == ' ' || line[after] == '\t') {
						after++
					}
				}
				i = end - 1
			default:
				if (c == '-' || c == '?' || c == ':') && (i+1 == len(line) || line[i+1] == ' ' || line[i+1] == '\t') {
					parent = i // a block indicator
					continue
				}
				// A plain scalar, to its end on this line.
				end := plainEnd(line, i, len(flow) > 0)
				if end == len(line) {
					if len(flow) > 0 {
						flowPlain = true
					} else if parent >= 0 {
						open = parent
					}
				}
				parent = i
				i = end - 1
			}
		}
		valuePending = quote == 0 && block < 0 && awaitsValue(line)
		pendingIndent = lead
		if !strings.HasPrefix(line[lead:], "#") {
			key = -1
			if valuePending && len(flow) == 0 {
				key = lead
			}
		}
	}
	return names, untab, false
}

// plainEnd is where a plain scalar that starts at line[i] ends on its line:
// at a ":" that makes it a key, at a comment, or in a flow collection at a
// flow indicator.
func plainEnd(line string, i int, flow bool) int {
	for j := i + 1; j < len(line); j++ {
		c := line[j]
		switch {
		case c == ':' && (j+1 == len(line) || line[j+1] == ' ' || line[j+1] == '\t' ||
			flow && strings.IndexByte(",[]{}", line[j+1]) >= 0):
			return j
		case c == '#' && (line[j-1] == ' ' || line[j-1] == '\t'):
			return j
		case flow && strings.IndexByte(",[]{}", c) >= 0:
			return j
		}
	}
	return len(line)
}

// propertyEnd is where the tag, anchor or alias that starts line[i] ends, as
// npm yaml reads it: a verbatim tag at its ">", anything else at a space or a
// flow indicator.
func propertyEnd(line string, i int) int {
	if strings.HasPrefix(line[i:], "!<") {
		if close := strings.IndexByte(line[i:], '>'); close >= 0 {
			return i + close + 1
		}
	}
	end := i + 1
	for end < len(line) && !isYAMLSpace(line[end]) && strings.IndexByte(",[]{}", line[end]) < 0 {
		end++
	}
	return end
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
