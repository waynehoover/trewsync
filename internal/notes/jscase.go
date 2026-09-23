package notes

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Basalt folded case with JavaScript's String.prototype.toLowerCase and
// matched case-insensitively with /iu regular expressions. Neither is Go's
// strings.ToLower, so this file reimplements both, and the oracle checks them
// against the JavaScript runtime code point by code point (the case sweeps in
// mcp-fixtures.json). Go's unicode tables and the runtime Basalt ran on agree
// on the Unicode version, 17.0, which the sweeps also prove.

// jsLower is String.prototype.toLowerCase: the Unicode default lowercase
// mapping, which is Go's simple mapping except for U+0130, whose full mapping
// is "i" and a combining dot above, and capital sigma, which becomes final
// sigma at the end of a word (the Final_Sigma condition). Go's
// strings.ToLower does neither.
func jsLower(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToLower(s)
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch r {
		case 0x130:
			b.WriteString("i\u0307")
		case 0x3a3:
			if finalSigma(s, i, i+size) {
				b.WriteRune(0x3c2)
			} else {
				b.WriteRune(0x3c3)
			}
		default:
			b.WriteRune(unicode.ToLower(r))
		}
		i += size
	}
	return b.String()
}

// finalSigma is the Final_Sigma casing context for a sigma at s[at:end]: a
// cased letter before it, then only case-ignorable characters, and no cased
// letter after it past case-ignorable ones. A character that is both cased
// and case-ignorable (U+0345 is one) counts as ignorable, which is what ICU,
// and so every JavaScript engine, does.
func finalSigma(s string, at, end int) bool {
	before := false
	for i := at; i > 0; {
		r, size := utf8.DecodeLastRuneInString(s[:i])
		i -= size
		if caseIgnorable(r) {
			continue
		}
		before = cased(r)
		break
	}
	if !before {
		return false
	}
	for i := end; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		if caseIgnorable(r) {
			continue
		}
		return !cased(r)
	}
	return true
}

// cased is the Unicode Cased property: Lowercase, Uppercase or titlecase.
func cased(r rune) bool {
	return unicode.In(r, unicode.Lu, unicode.Ll, unicode.Lt, unicode.Other_Lowercase, unicode.Other_Uppercase)
}

// caseIgnorable is the Unicode Case_Ignorable property: nonspacing and
// enclosing marks, format characters, modifier letters and symbols, and the
// characters whose Word_Break is MidLetter, MidNumLet or Single_Quote.
func caseIgnorable(r rune) bool {
	switch r {
	case 0x27, 0x2e, 0x3a, 0xb7, 0x387, 0x55f, 0x5f4, 0x2018, 0x2019, 0x2024, 0x2027,
		0xfe13, 0xfe52, 0xfe55, 0xff07, 0xff0e, 0xff1a:
		return true
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk)
}

// foldTag is Basalt's fold for tags: NFC, then toLowerCase.
func foldTag(s string) string { return jsLower(norm.NFC.String(s)) }

// foldRune is the key two characters share when a /iu regular expression
// matches one against the other. JavaScript canonicalises both through the
// simple and common case foldings (CaseFolding.txt statuses C and S); two
// characters with the same folding are exactly the members of one of Go's
// unicode.SimpleFold orbits, and the smallest member names the orbit.
func foldRune(r rune) rune {
	if r < utf8.RuneSelf {
		// Every ASCII letter's orbit has its capital as its least member,
		// including k and s, whose orbits also hold U+212A and U+017F.
		if 'a' <= r && r <= 'z' {
			return r - ('a' - 'A')
		}
		return r
	}
	least := r
	for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
		least = min(least, f)
	}
	return least
}

// jsSpace is \s in a JavaScript regular expression: WhiteSpace and
// LineTerminator, which are tab, line feed, vertical tab, form feed, carriage
// return, U+FEFF, the Zs separators, and U+2028 and U+2029.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', 0xfeff, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}
