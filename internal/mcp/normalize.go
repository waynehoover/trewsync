// Package mcp holds what every MCP tool result shares: the envelope that
// separates what the server vouches for from what came out of a note, and
// the one function every string drawn from note bytes passes through on its
// way into a result.
//
// A note is attacker-influenced data (PLAN.md section 4.10): a web clipping,
// a shared file or an earlier agent can put a sentence shaped like an
// instruction into it, and because agents also write notes, such a sentence
// persists and spreads. The defence is structural. Server facts go under
// "trusted", note-derived text under "untrusted_content" and nowhere else,
// every tool description carries Warning, and Normalize removes what would
// let text hide from a person reviewing it or pass itself off as the
// envelope. The design follows asciimoo/hister's untrusted-content envelope;
// no code of it is used.
package mcp

import (
	"strings"
	"unicode/utf8"
)

// MaxTextBytes is the most UTF-8 bytes one untrusted string may carry into a
// result, after normalisation. Every tool clips its text well below this
// already (a read_note page is at most 64 KiB of the note); the cap is the
// backstop that holds whatever a tool does.
const MaxTextBytes = 1 << 20

// Text is a string from note bytes that has been through Normalize. It is
// the only way a string can enter a result's untrusted_content (NewResult
// refuses any other), and it marshals to JSON as the plain string.
type Text struct {
	s       string
	changes Changes
}

// Changes counts what Normalize altered in a string, so that a result can
// say its untrusted content differs from the stored bytes.
type Changes struct {
	// Replaced is how many characters, and runs of invalid UTF-8, became
	// U+FFFD.
	Replaced int `json:"replaced"`
	// Neutralized is how many imitations of the envelope's framing were
	// defused.
	Neutralized int `json:"neutralized"`
	// Truncated is how many strings were cut at MaxTextBytes.
	Truncated int `json:"truncated"`
}

func (c *Changes) add(o Changes) {
	c.Replaced += o.Replaced
	c.Neutralized += o.Neutralized
	c.Truncated += o.Truncated
}

// String is the normalised text.
func (t Text) String() string { return t.s }

// Changes is what Normalize altered to make t.
func (t Text) Changes() Changes { return t.changes }

// replacement stands in for everything Normalize removes, so a reader sees
// that something was there.
const replacement = '\ufffd'

// Normalize is the one function every untrusted string passes through before
// it enters a result. In order:
//
//  1. Invalid UTF-8 becomes U+FFFD, one for each maximal invalid run. Go
//     cannot hold a lone surrogate as a character, so this is where one
//     arrives (encoded, as in CESU-8, or cut short), and it is replaced, not
//     refused: note bodies are refused as invalid_utf8 before they get here,
//     so anything that does is a path or a tool's bug, and one stray byte
//     should not deny the agent the whole result. The count says it
//     happened.
//  2. Characters that hide or reorder text become U+FFFD, one for each:
//     the C0 controls other than tab, line feed and carriage return (which
//     note text needs, CRLF included), DEL and the C1 controls; the
//     bidirectional embeddings, overrides and isolates (U+202A to U+202E,
//     U+2066 to U+2069), which can make text read differently from how it
//     is stored; the tag characters (U+E0000 to U+E007F), which render as
//     nothing and can carry a whole invisible sentence, except inside an
//     emoji tag sequence (a black flag, tag letters or digits, and a cancel
//     tag, as in the flag of Scotland); and a variation selector directly
//     after another, since a character takes at most one and runs of them
//     can carry arbitrary bytes. The left-to-right and right-to-left marks,
//     the zero-width joiners and a single variation selector stay: scripts
//     and emoji need them.
//  3. Imitations of the envelope's framing are defused: a reserved name
//     (schema_version, tool, security, trusted, untrusted_content, in any
//     case) written as a JSON key, in double quotes followed by a colon
//     after any JSON whitespace, has its quotes replaced by U+FF02; written
//     as a tag ("<trusted>", "</untrusted_content"), its "<" becomes U+FF1C.
//     The text still reads the same to a person; it no longer looks like the
//     envelope to a model. Other text, instruction-shaped or not, is left
//     alone: the envelope, not a filter, is what keeps it from being taken as
//     instructions.
//  4. The result is cut to MaxTextBytes, at a character boundary.
//
// Normalizing a normalised string changes nothing.
func Normalize(s string) Text {
	var c Changes
	s = replaceHidden(s, &c)
	s = neutralize(s, &c)
	if len(s) > MaxTextBytes {
		cut := MaxTextBytes
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		// A cut through an emoji tag sequence leaves tag characters that
		// no longer end in a cancel tag; they go as any others would.
		s = replaceHidden(s[:cut], &c)
		c.Truncated++
	}
	return Text{s: s, changes: c}
}

// hidden reports whether r is one of the characters step 2 replaces wherever
// it appears.
func hidden(r rune) bool {
	switch {
	case r < 0x20:
		return r != '\t' && r != '\n' && r != '\r'
	case 0x7f <= r && r <= 0x9f:
		return true
	case 0x202a <= r && r <= 0x202e, 0x2066 <= r && r <= 0x2069:
		return true
	}
	return false
}

func tagChar(r rune) bool { return 0xe0000 <= r && r <= 0xe007f }

func variationSelector(r rune) bool {
	return 0xfe00 <= r && r <= 0xfe0f || 0xe0100 <= r && r <= 0xe01ef
}

// emojiTagSequence is the length in bytes of the tag characters that follow a
// black flag at the start of s, when they form an emoji tag sequence: one or
// more tag letters or digits and a cancel tag. It is 0 otherwise.
func emojiTagSequence(s string) int {
	n, i := 0, 0
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case 0xe0030 <= r && r <= 0xe0039, 0xe0061 <= r && r <= 0xe007a:
			n++
		case r == 0xe007f && n > 0:
			return i + size
		default:
			return 0
		}
		i += size
	}
	return 0
}

func replaceHidden(s string, c *Changes) string {
	clean := true
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 || hidden(r) || tagChar(r) || variationSelector(r) {
			clean = false
			break
		}
		i += size
	}
	if clean {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	previous := rune(-1)
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			for i < len(s) {
				if r, size := utf8.DecodeRuneInString(s[i:]); r != utf8.RuneError || size != 1 {
					break
				}
				i++
			}
			b.WriteRune(replacement)
			c.Replaced++
			previous = replacement
			continue
		case r == 0x1f3f4:
			if n := emojiTagSequence(s[i+size:]); n > 0 {
				b.WriteString(s[i : i+size+n])
				i += size + n
				previous = 0xe007f
				continue
			}
		case hidden(r), tagChar(r), variationSelector(r) && variationSelector(previous):
			b.WriteRune(replacement)
			c.Replaced++
			i += size
			// A replaced selector still counts as one, so that a run of
			// them loses all but the first.
			if !variationSelector(r) {
				previous = replacement
			}
			continue
		}
		b.WriteString(s[i : i+size])
		previous = r
		i += size
	}
	return b.String()
}

// reservedNames are the envelope's own keys.
var reservedNames = []string{"schema_version", "tool", "security", "trusted", "untrusted_content"}

// reservedAt is the length of the longest reserved name at the start of s,
// compared without regard to ASCII case, or 0.
func reservedAt(s string) int {
	best := 0
	for _, name := range reservedNames {
		if len(s) >= len(name) && strings.EqualFold(s[:len(name)], name) && len(name) > best {
			best = len(name)
		}
	}
	return best
}

func neutralize(s string, c *Changes) string {
	if !strings.ContainsAny(s, `"<`) {
		return s
	}
	var b strings.Builder
	last := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			n := reservedAt(s[i+1:])
			if n == 0 || i+1+n >= len(s) || s[i+1+n] != '"' {
				continue
			}
			// Any JSON whitespace may come before the colon: a key with a
			// line break before it is as much a key as one with a space,
			// and passed until only spaces and tabs were skipped (T54).
			j := i + 2 + n
			for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n' || s[j] == '\r') {
				j++
			}
			if j >= len(s) || s[j] != ':' {
				continue
			}
			b.WriteString(s[last:i])
			b.WriteString("\uff02" + s[i+1:i+1+n] + "\uff02")
			last = i + 2 + n
			i = last - 1
			c.Neutralized++
		case '<':
			j := i + 1
			if j < len(s) && s[j] == '/' {
				j++
			}
			n := reservedAt(s[j:])
			if n == 0 || j+n < len(s) && !strings.ContainsRune(" \t\r\n/>", rune(s[j+n])) {
				continue
			}
			b.WriteString(s[last:i])
			b.WriteString("\uff1c")
			last = i + 1
			c.Neutralized++
		}
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}
