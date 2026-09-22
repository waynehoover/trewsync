// Package paths is the protocol 1 path contract: which paths the server
// accepts, the case fold that decides which two paths are one file, and the
// format policies that decide what a path is for.
//
// Everything here is pure and is the reference the store, the session and the
// MCP tools call. It is checked against protocol-fixtures.json, whose vectors
// come from scripts/protocol-vectors.py rather than from this package, and the
// TypeScript client checks itself against the same file (PLAN.md M0.5).
//
// The rule behind all of it (PLAN.md section 4.1): the server's keyspace is
// Obsidian's. A path Obsidian's normalizePath would rewrite is refused, because
// the plugin can never send it and a second client that did would be naming a
// file the plugin cannot see.
package paths

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// MaxPathBytes is the longest path, in bytes of UTF-8, the server accepts.
const MaxPathBytes = 1024

// MaxSegmentBytes is the longest single name in a path, in bytes of UTF-8:
// ext4 and f2fs, which Android and Linux use, hold no more. A longer name made
// on a Mac would be accepted and then fail on every Android and Linux device,
// so it is refused where it is made, with its reason, instead.
const MaxSegmentBytes = 255

// StagingMark is the name the adapters give files they are staging. A path
// containing it is one of theirs mid-write, never a note.
//
// Derived from the product name, which is not final (PLAN.md section 10).
const StagingMark = ".telimus-tmp-"

// Reason is why a path is refused. The values are the fixture's, and both
// implementations must report the same one for the same path, so a refusal
// cannot be right for the wrong reason.
type Reason string

// The reasons, in the order Check tests them. A path that breaks several rules
// reports the first.
const (
	ReasonUTF8         Reason = "utf8"
	ReasonEmpty        Reason = "empty"
	ReasonTooLong      Reason = "toolong"
	ReasonSegmentLong  Reason = "segmenttoolong"
	ReasonControl      Reason = "control"
	ReasonNFC          Reason = "nfc"
	ReasonNBSP         Reason = "nbsp"
	ReasonBackslash    Reason = "backslash"
	ReasonSlash        Reason = "slash"
	ReasonEmptySegment Reason = "emptysegment"
	ReasonDotSegment   Reason = "dotsegment"
	ReasonDotPrefix    Reason = "dotprefix"
	ReasonStaging      Reason = "staging"
)

// Check returns why the server refuses p, or "" when it accepts it.
//
// Go's utf8.ValidString refuses the encoded surrogates U+D800 to U+DFFF as
// well as malformed sequences, which is what the fixture's "utf8" means.
func Check(p string) Reason {
	if !utf8.ValidString(p) {
		return ReasonUTF8
	}
	if p == "" {
		return ReasonEmpty
	}
	if len(p) > MaxPathBytes {
		return ReasonTooLong
	}
	for _, s := range strings.Split(p, "/") {
		if len(s) > MaxSegmentBytes {
			return ReasonSegmentLong
		}
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return ReasonControl
		}
	}
	if !norm.NFC.IsNormalString(p) {
		return ReasonNFC
	}
	if strings.ContainsRune(p, '\u00a0') || strings.ContainsRune(p, '\u202f') {
		return ReasonNBSP
	}
	if strings.ContainsRune(p, '\\') {
		return ReasonBackslash
	}
	if strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") {
		return ReasonSlash
	}
	segments := strings.Split(p, "/")
	for _, s := range segments {
		if s == "" {
			return ReasonEmptySegment
		}
	}
	for _, s := range segments {
		if s == "." || s == ".." {
			return ReasonDotSegment
		}
	}
	for _, s := range segments {
		if strings.HasPrefix(s, ".") {
			return ReasonDotPrefix
		}
	}
	if strings.Contains(p, StagingMark) {
		return ReasonStaging
	}
	return ""
}

// Fold returns the key two paths share when a case-folding disk would hold
// them as one file: NFC, then Unicode full case folding code point by code
// point, then NFC again.
//
// The table is generated (fold_table.go) rather than taken from Go's own
// unicode package, because the TypeScript client has to fold identically and
// Go and JavaScript do not lower-case alike (U+0130 is the famous case). Both
// sides carry the same generated table and prove it by digest.
func Fold(s string) string {
	nfc := norm.NFC.String(s)
	var b strings.Builder
	b.Grow(len(nfc))
	for _, r := range nfc {
		if to, ok := foldTable[r]; ok {
			b.WriteString(to)
		} else {
			b.WriteRune(r)
		}
	}
	return norm.NFC.String(b.String())
}

// Live is one live entry, as the collision rule sees it.
type Live struct {
	Path   string
	Folder bool
}

// Op is one create or move, as the collision rule sees it. Prev is the source
// of a move and empty for a create.
type Op struct {
	Path   string
	Prev   string
	Move   bool
	Folder bool
}

// Collides reports whether op would leave two live paths that a case-folding
// disk holds as one file or one folder (plan/protocol.md, "Paths"). It is the
// reference the store's indexed check is tested against, not the check the
// store runs: this is quadratic in the number of live paths.
//
// A move whose source and destination fold alike is a case-only rename and
// never collides, because it keeps every folded key where it was; that is also
// what lets a case-only folder rename spread across several batches.
func Collides(live []Live, op Op) bool {
	if op.Move && Fold(op.Prev) == Fold(op.Path) {
		return false
	}
	if !op.Move {
		for _, e := range live {
			if e.Path == op.Path {
				return false // an update of a live path, not a create
			}
		}
	}
	var others []Live
	for _, e := range live {
		if e.Path == op.Path || (op.Move && e.Path == op.Prev) {
			continue
		}
		others = append(others, e)
	}
	key := Fold(op.Path)
	for _, e := range others {
		if Fold(e.Path) == key {
			return true
		}
	}
	dirs := map[string]bool{}
	var files []string
	for _, e := range others {
		segs := strings.Split(e.Path, "/")
		for k := 1; k < len(segs); k++ {
			dirs[strings.Join(segs[:k], "/")] = true
		}
		if e.Folder {
			dirs[e.Path] = true
		} else {
			files = append(files, e.Path)
		}
	}
	spellings := func(folded string) map[string]bool {
		out := map[string]bool{}
		for d := range dirs {
			if Fold(d) == folded {
				out[d] = true
			}
		}
		return out
	}
	segs := strings.Split(op.Path, "/")
	for k := 1; k < len(segs); k++ {
		d := strings.Join(segs[:k], "/")
		fd := Fold(d)
		if s := spellings(fd); len(s) > 0 && !s[d] {
			return true
		}
		for _, f := range files {
			if Fold(f) == fd {
				return true
			}
		}
	}
	if s := spellings(key); len(s) > 0 && (!op.Folder || !s[op.Path]) {
		return true
	}
	return false
}

// TextExtensions are the extensions whose files are chunked as text. It only
// picks chunk sizes: a wrong answer costs efficiency, never correctness.
var TextExtensions = []string{
	"md", "txt", "canvas", "json", "csv", "yml", "yaml", "base", "xml",
	"html", "css", "js", "ts", "svg", "bib", "tex",
}

// Syncable reports whether a path may be stored at all.
func Syncable(p string) bool { return Check(p) == "" }

// ChunkingText reports whether a path is chunked with the text sizes: its
// extension, in ASCII lower case, is one of TextExtensions.
func ChunkingText(p string) bool {
	dot := strings.LastIndexByte(p, '.')
	if dot < 0 || dot < strings.LastIndexByte(p, '/') {
		return false
	}
	ext := asciiLower(p[dot+1:])
	for _, e := range TextExtensions {
		if e == ext {
			return true
		}
	}
	return false
}

// Searchable reports whether a note's text is searched: Markdown or plain
// text, drawings included.
func Searchable(p string) bool { return mcpText(p) }

// MCPReadable reports whether an agent may read a note's text. The same list
// as Searchable today, and a separate policy on purpose (PLAN.md M0.5 task 3).
func MCPReadable(p string) bool { return mcpText(p) }

// MCPEditable reports whether an agent may change a note: readable, and not an
// Excalidraw drawing, whose Markdown is a container an edit would corrupt.
func MCPEditable(p string) bool {
	return mcpText(p) && !strings.HasSuffix(asciiLower(p), ".excalidraw.md")
}

func mcpText(p string) bool {
	if !Syncable(p) {
		return false
	}
	lower := asciiLower(p)
	return strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".txt")
}

// asciiLower lowers A to Z and nothing else, so no Unicode rule is involved in
// an answer TypeScript has to reach too.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}
