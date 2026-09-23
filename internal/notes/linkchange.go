package notes

import (
	"strings"
	"unicode/utf8"
)

// LinkResolver is changeLinks's name resolution: which notes of an inventory
// a link's name can mean, compared through canonical (the server's path
// fold, in production). A name may be the path, or the path without its .md
// or .txt extension; a wiki link may also be a bare file name, which is how a
// short name comes to mean several notes.
type LinkResolver struct {
	canonical func(string) string
	paths     map[string][]string
	short     map[string][]string
}

// NewLinkResolver indexes inventory, in order.
func NewLinkResolver(inventory []string, canonical func(string) string) *LinkResolver {
	r := &LinkResolver{canonical: canonical, paths: map[string][]string{}, short: map[string][]string{}}
	add := func(m map[string][]string, key, path string) {
		for _, p := range m[key] {
			if p == path {
				return
			}
		}
		m[key] = append(m[key], path)
	}
	for _, path := range inventory {
		names := []string{path}
		if trimmed := trimNoteExtension(path); trimmed != path {
			names = append(names, trimmed)
		}
		for _, name := range names {
			add(r.paths, canonical(name), path)
			add(r.short, canonical(posixBasename(name)), path)
		}
	}
	return r
}

// trimNoteExtension is path.replace(/\.(md|txt)$/iu, "").
func trimNoteExtension(p string) string {
	lower := asciiLowerString(p)
	for _, ext := range []string{".md", ".txt"} {
		if strings.HasSuffix(lower, ext) {
			return p[:len(p)-len(ext)]
		}
	}
	return p
}

func hasNoteExtension(p string) bool { return trimNoteExtension(p) != p }

func asciiLowerString(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// hasScheme is /^[a-z][a-z0-9+.-]*:/iu: a URL scheme, the letters matched
// case-insensitively the way /iu does, so U+017F and U+212A count as s and k.
func hasScheme(name string) bool {
	letter := func(r rune) bool { f := foldRune(r); return 'A' <= f && f <= 'Z' }
	for i, r := range name {
		switch {
		case i == 0:
			if !letter(r) {
				return false
			}
		case r == ':':
			return true
		case !letter(r) && !('0' <= r && r <= '9') && r != '+' && r != '.' && r != '-':
			return false
		}
	}
	return false
}

// Resolve is the notes a link names: nothing for an empty name, a URL or a
// protocol-relative "//"; for "/name" the vault path; for a wiki link the
// name as a path, relative to the owner's folder, and (without a "/") any
// note of that file name; for a Markdown link the name relative to the
// owner's folder. Each in inventory order, without repeats.
func (r *LinkResolver) Resolve(name string, wiki bool, owner string) []string {
	if name == "" || hasScheme(name) || strings.HasPrefix(name, "//") {
		return nil
	}
	var candidates []string
	seen := map[string]bool{}
	take := func(list []string) {
		for _, p := range list {
			if !seen[p] {
				seen[p] = true
				candidates = append(candidates, p)
			}
		}
	}
	add := func(n string) { take(r.paths[r.canonical(posixNormalize(n))]) }
	switch {
	case strings.HasPrefix(name, "/"):
		add(name[1:])
	case wiki:
		add(name)
		add(posixJoin(posixDirname(owner), name))
		if !strings.Contains(name, "/") {
			take(r.short[r.canonical(name)])
		}
	default:
		add(posixJoin(posixDirname(owner), name))
	}
	return candidates
}

// decodeURIComponent is JavaScript's: percent escapes decoded as UTF-8, or
// false where it would throw a URIError (a bad escape, or bytes that are not
// the UTF-8 of one character).
func decodeURIComponent(s string) (string, bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	var b strings.Builder
	// hex reads the two digits after the "%" at s[i].
	hex := func(i int) (byte, bool) {
		if i+2 >= len(s) {
			return 0, false
		}
		h, ok1 := unhex(s[i+1])
		l, ok2 := unhex(s[i+2])
		return h<<4 | l, ok1 && ok2
	}
	for k := 0; k < len(s); k++ {
		if s[k] != '%' {
			b.WriteByte(s[k])
			continue
		}
		first, ok := hex(k)
		if !ok {
			return "", false
		}
		k += 2
		if first < 0x80 {
			b.WriteByte(first)
			continue
		}
		n := 0
		for n < 8 && first&(0x80>>n) != 0 {
			n++
		}
		if n == 1 || n > 4 {
			return "", false
		}
		octets := []byte{first}
		for j := 1; j < n; j++ {
			k++
			if k >= len(s) || s[k] != '%' {
				return "", false
			}
			o, ok := hex(k)
			if !ok || o&0xc0 != 0x80 {
				return "", false
			}
			k += 2
			octets = append(octets, o)
		}
		if !utf8.Valid(octets) {
			return "", false
		}
		b.Write(octets)
	}
	return b.String(), true
}

func unhex(c byte) (byte, bool) {
	switch {
	case '0' <= c && c <= '9':
		return c - '0', true
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10, true
	case 'A' <= c && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// encodeURIComponent is JavaScript's: every byte of the UTF-8 escaped as %XX
// except A to Z, a to z, 0 to 9 and the marks - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string { return percentEncode(s, "-_.!~*'()") }

// percentEncode escapes every byte of s except ASCII letters, digits and the
// bytes in keep, with upper-case hex digits.
func percentEncode(s, keep string) string {
	const upper = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(upper[c>>4])
		b.WriteByte(upper[c&0xf])
	}
	return b.String()
}

// SourceEdit is one exact replacement: Old is the source from Start to End
// (UTF-16 offsets) as it was read, Text what replaces it. The JSON names are
// a planned change's, as a preview shows it and an apply passes it back.
type SourceEdit struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Old   string `json:"old"`
	Text  string `json:"text"`
}

// LinkChange is a move or deletion whose links changeLinks rewrites in one
// note: Path is the note, From the note moved or deleted, To its new path
// unless Delete is set, Inventory every note path, and Canonical the fold
// paths are compared through.
type LinkChange struct {
	Path      string
	From      string
	To        string
	Delete    bool
	Inventory []string
	Canonical func(string) string
}

// ChangeLinks is Basalt's changeLinks: the exact edits that retarget, in the
// note at change.Path, every link to change.From (and when the note itself is
// the one moving, its own relative links), or with change.Delete strike them
// through; and how many links were left alone because their names meant
// several notes. A rewrite that would leave a link naming a different note
// than intended is ambiguous_link, and nothing is edited.
func ChangeLinks(source string, change LinkChange) ([]SourceEdit, int, error) {
	spans, err := linkSpans(source)
	if err != nil {
		return nil, 0, err
	}
	canonical := change.Canonical
	resolve := NewLinkResolver(change.Inventory, canonical)
	afterInventory := change.Inventory
	if !change.Delete {
		afterInventory = nil
		for _, p := range change.Inventory {
			if canonical(p) != canonical(change.From) {
				afterInventory = append(afterInventory, p)
			}
		}
		afterInventory = append(afterInventory, change.To)
	}
	after := NewLinkResolver(afterInventory, canonical)
	sorted := append([]linkSpan(nil), spans...)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j].start < sorted[j-1].start; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	x := newUnitIndex(source)
	edit := func(start, end int, text string) SourceEdit {
		return SourceEdit{Start: x.at(start), End: x.at(end), Old: source[start:end], Text: text}
	}
	var edits []SourceEdit
	ambiguous := 0
	outbound := !change.Delete && canonical(change.Path) == canonical(change.From)
	for _, span := range sorted {
		hash := strings.IndexByte(span.url, '#')
		encoded := span.url
		if hash >= 0 {
			encoded = span.url[:hash]
		}
		name, ok := decodeURIComponent(encoded)
		if !ok {
			continue
		}
		candidates := resolve.Resolve(name, span.wiki, change.Path)
		wasMissing := len(candidates) == 0
		sourceMatch := false
		for _, p := range candidates {
			if canonical(p) == canonical(change.From) {
				sourceMatch = true
			}
		}
		if wasMissing && outbound && !span.wiki && name != "" && !hasScheme(name) && !strings.HasPrefix(name, "/") {
			previous := posixNormalize(posixJoin(posixDirname(change.Path), name))
			if previous != ".." && !strings.HasPrefix(previous, "../") {
				candidates = append(candidates, previous)
			}
		}
		if !sourceMatch && !outbound {
			continue
		}
		if len(candidates) != 1 {
			if len(candidates) > 1 {
				ambiguous++
			}
			continue
		}
		if sourceMatch && change.Delete {
			whole := source[span.wholeStart:span.wholeEnd]
			edits = append(edits, edit(span.wholeStart, span.wholeEnd, "~~"+whole+"~~"))
			continue
		}
		destination := candidates[0]
		if sourceMatch {
			destination = change.To
		}
		owner := change.Path
		if outbound {
			owner = change.To
		}
		reference := func(target string) string {
			switch {
			case span.wiki:
				return target
			case strings.HasPrefix(name, "/"):
				return "/" + target
			}
			return posixRelative(posixDirname(owner), target)
		}
		target := destination
		if !hasNoteExtension(name) {
			shortened := trimNoteExtension(target)
			found := after.Resolve(reference(shortened), span.wiki, owner)
			if len(found) == 1 && canonical(found[0]) == canonical(destination) {
				target = shortened
			}
		}
		target = reference(target)
		resolved := after.Resolve(target, span.wiki, owner)
		if !wasMissing && (len(resolved) != 1 || canonical(resolved[0]) != canonical(destination)) {
			return nil, 0, refuse("ambiguous_link", "the generated destination would not identify the intended note; choose an unambiguous destination")
		}
		var escapedTarget string
		if span.wiki {
			var b strings.Builder
			for _, r := range target {
				if strings.ContainsRune("%#|[]\r\n", r) {
					b.WriteString(encodeURIComponent(string(r)))
				} else {
					b.WriteRune(r)
				}
			}
			escapedTarget = b.String()
		} else {
			// encodeURIComponent, then ! ' ( ) * escaped as well: every
			// byte but letters, digits and - _ . ~.
			parts := strings.Split(target, "/")
			for i, part := range parts {
				parts[i] = percentEncode(part, "-_.~")
			}
			escapedTarget = strings.Join(parts, "/")
		}
		raw := source[span.start:span.end]
		fragment := ""
		switch {
		case hash < 0:
		case span.fragmentAt >= 0:
			fragment = source[span.fragmentAt:span.end]
		case span.wiki:
			fragment = raw[strings.IndexByte(raw, '#'):]
		default:
			fragment = span.url[hash:]
		}
		if text := escapedTarget + fragment; text != raw {
			edits = append(edits, edit(span.start, span.end, text))
		}
	}
	var disjoint []SourceEdit
	for i, e := range edits {
		inside := false
		for j, o := range edits {
			if i != j && o.Start <= e.Start && o.End >= e.End && (o.Start < e.Start || o.End > e.End) {
				inside = true
				break
			}
		}
		if !inside {
			disjoint = append(disjoint, e)
		}
	}
	return disjoint, ambiguous, nil
}

// ApplySourceEdits is Basalt's applySourceEdits: the source with every edit
// applied, refusing (invalid_edits) edits that overlap or whose Old is not
// what the source holds at their range, and a result over NoteBytes
// (input_too_large).
func ApplySourceEdits(source string, edits []SourceEdit) (string, error) {
	sorted := append([]SourceEdit(nil), edits...)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && (sorted[j].Start < sorted[j-1].Start ||
			sorted[j].Start == sorted[j-1].Start && sorted[j].End < sorted[j-1].End); j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	x := newUnitIndex(source)
	total := x.at(len(source))
	var b strings.Builder
	at := 0
	for _, e := range sorted {
		if e.Start < at || e.End < e.Start || e.End > total {
			return "", invalidEdits()
		}
		start, end := byteAtUnit(source, e.Start), byteAtUnit(source, e.End)
		if x.at(start) != e.Start || x.at(end) != e.End || source[start:end] != e.Old {
			return "", invalidEdits()
		}
		b.WriteString(source[byteAtUnit(source, at):start])
		b.WriteString(e.Text)
		at = e.End
	}
	b.WriteString(source[byteAtUnit(source, at):])
	if b.Len() > NoteBytes {
		return "", refuse("input_too_large", "the supplied text exceeds its byte limit")
	}
	return b.String(), nil
}

func invalidEdits() error {
	return refuse("invalid_edits", "source edits overlap or differ from the inspected bytes")
}
