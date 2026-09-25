package gitexport

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// What the export writes into Git, apart from the notes' bytes: the quoting
// of a path, the LFS pointer and the .gitattributes that names the LFS files,
// and a commit's identity and message.

// attributesPath is the file at the root of every tree that has an LFS file
// in it. A store path can never be it: a segment starting with a dot is never
// stored (plan/protocol.md, "Paths").
const attributesPath = ".gitattributes"

// attributesHeader opens the generated .gitattributes, so a person who finds
// it knows who wrote it and that it is not theirs to edit.
const attributesHeader = "# Written by TrewSync's Git export: each file named here is over the export's LFS\n" +
	"# threshold and is stored in Git LFS. The export rewrites this file; edits are not read back.\n"

// lfsAttributes are the attributes an LFS file is given, as `git lfs track`
// gives them.
const lfsAttributes = " filter=lfs diff=lfs merge=lfs -text"

// blobRef is a path's content in a tree: its blob's name, and whether that
// blob is an LFS pointer.
type blobRef struct {
	sha string
	lfs bool
}

// cQuote quotes s the way Git quotes a path, and the way fast-import and a
// .gitattributes pattern read one: in double quotes, with a backslash before a
// quote or a backslash and every control byte in octal. Bytes above ASCII go
// as they are, which Git reads back as the same bytes.
func cQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		case c < 0x20 || c == 0x7f:
			fmt.Fprintf(&b, "\\%03o", c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// cUnquote reverses cQuote, and the rest of Git's C quoting.
func cUnquote(s string) (string, error) {
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return "", fmt.Errorf("%q is not quoted", s)
	}
	s = s[1 : len(s)-1]
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' {
			b.WriteByte(c)
			continue
		}
		i++
		if i >= len(s) {
			return "", errors.New("a quoted string ends in a backslash")
		}
		switch s[i] {
		case '"', '\\':
			b.WriteByte(s[i])
		case 'a':
			b.WriteByte('\a')
		case 'b':
			b.WriteByte('\b')
		case 't':
			b.WriteByte('\t')
		case 'n':
			b.WriteByte('\n')
		case 'v':
			b.WriteByte('\v')
		case 'f':
			b.WriteByte('\f')
		case 'r':
			b.WriteByte('\r')
		default:
			if i+3 > len(s) {
				return "", errors.New("a short octal escape")
			}
			n, err := strconv.ParseUint(s[i:i+3], 8, 8)
			if err != nil {
				return "", fmt.Errorf("a bad escape: %w", err)
			}
			b.WriteByte(byte(n))
			i += 2
		}
	}
	return b.String(), nil
}

// globEscape escapes the characters a gitattributes pattern reads as a
// wildcard, so the pattern matches exactly one path.
func globEscape(p string) string {
	var b strings.Builder
	for _, r := range p {
		switch r {
		case '*', '?', '[', ']', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func globUnescape(p string) string {
	var b strings.Builder
	for i := 0; i < len(p); i++ {
		if p[i] == '\\' && i+1 < len(p) {
			i++
		}
		b.WriteByte(p[i])
	}
	return b.String()
}

// attributesFor is the .gitattributes naming each LFS path, sorted, or nil
// when there is none. Each pattern is anchored at the root and escaped, so it
// names that one file and nothing beside it.
func attributesFor(lfs []string) []byte {
	if len(lfs) == 0 {
		return nil
	}
	sorted := append([]string(nil), lfs...)
	sort.Strings(sorted)
	var b bytes.Buffer
	b.WriteString(attributesHeader)
	for _, p := range sorted {
		b.WriteString(cQuote("/" + globEscape(p)))
		b.WriteString(lfsAttributes)
		b.WriteByte('\n')
	}
	return b.Bytes()
}

// parseAttributes reads the LFS paths back out of a .gitattributes the export
// wrote. A line it did not write is an error: the file is the export's, and a
// tree whose file says something else was not made by it.
func parseAttributes(b []byte) (map[string]bool, error) {
	out := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		pattern, ok := strings.CutSuffix(line, lfsAttributes)
		if !ok {
			return nil, fmt.Errorf("the .gitattributes line %q is not one the export writes", line)
		}
		p, err := cUnquote(pattern)
		if err != nil {
			return nil, fmt.Errorf("the .gitattributes line %q: %w", line, err)
		}
		if !strings.HasPrefix(p, "/") {
			return nil, fmt.Errorf("the .gitattributes line %q is not anchored", line)
		}
		out[globUnescape(p[1:])] = true
	}
	return out, nil
}

// lfsPointer is the pointer file Git holds in place of an LFS object.
func lfsPointer(oid string, size int64) []byte {
	return fmt.Appendf(nil, "version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n", oid, size)
}

// gitSafe reports whether Git can hold p as a path. The store's own rules
// already refuse a segment starting with a dot, so .git and every name
// derived from it never arrive; what is left is git~1, the short name
// Windows gives .git, which git fsck refuses in any tree and GitHub refuses
// on push.
func gitSafe(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		s := strings.ToLower(strings.TrimRight(seg, ". "))
		if s == "git~1" {
			return false
		}
	}
	return true
}

// identName is a label as a Git author name: no angle brackets, no control
// characters and no newline, which would end the identity line, and never
// empty.
func identName(label, fallback string) string {
	var b strings.Builder
	for _, r := range label {
		switch {
		case r == '<' || r == '>':
		case r == utf8.RuneError, unicode.IsControl(r):
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	name := strings.Join(strings.Fields(b.String()), " ")
	if name == "" {
		return fallback
	}
	return name
}

// oneLine is s as one line, for a message subject or a trailer value.
func oneLine(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == utf8.RuneError || unicode.IsControl(r) {
			b.WriteRune(' ')
			continue
		}
		b.WriteRune(r)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// The identities a commit carries. The e-mail addresses are in .invalid,
// which no mail is ever delivered to (RFC 2606), because the export knows a
// device's name and nothing else about it.
const (
	committerIdent = "TrewSync <export@trewsync.invalid>"
	deviceEmail    = "device@trewsync.invalid"
	agentEmail     = "agent@trewsync.invalid"
	operatorEmail  = "operator@trewsync.invalid"
)

// change is one path a commit changes, for its message.
type change struct {
	kind byte // 'A', 'M' or 'D'
	path string
}

// maxListed is how many changed paths a message lists before it says how
// many more there were.
const maxListed = 100

// listChanges is the body lines naming what a commit changed.
func listChanges(cs []change) string {
	var b strings.Builder
	for i, c := range cs {
		if i == maxListed {
			fmt.Fprintf(&b, "... and %d more\n", len(cs)-maxListed)
			break
		}
		fmt.Fprintf(&b, "%c %s\n", c.kind, oneLine(c.path))
	}
	return b.String()
}

// summary is a subject's description of the changes: the one path, or how
// many.
func summary(cs []change) string {
	if len(cs) == 1 {
		return oneLine(cs[0].path)
	}
	return fmt.Sprintf("%d files", len(cs))
}

// uidRange is "12" or "12-40".
func uidRange(first, last int64) string {
	if first == last {
		return strconv.FormatInt(first, 10)
	}
	return fmt.Sprintf("%d-%d", first, last)
}
