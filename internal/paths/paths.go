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
	"regexp"
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
const StagingMark = ".trew-tmp-"

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
	// Protocol 3's, for a path inside a profile root (CheckConfig): one
	// device's own state, which never syncs, and a file settings sync does not
	// carry.
	ReasonDeviceLocal Reason = "devicelocal"
	ReasonConfigScope Reason = "configscope"
)

// SyncPluginID is the plugin's id, so the name of its folder in a profile
// root. That folder holds one device's pairing and index and never syncs.
const SyncPluginID = "trew-sync"

// configRoot is a profile root: Obsidian's configuration folder, or one a
// device chose with Obsidian's "Override config folder" as .obsidian-<name>
// (plan/settings-sync.md, section 1). A fixed pattern keeps .git, .trash and
// .trew out without a list of them.
var configRoot = regexp.MustCompile(`^\.obsidian(?:-[a-z0-9][a-z0-9-]{0,31})?$`)

// IsConfig reports whether p begins with a profile root, whatever follows it.
func IsConfig(p string) bool {
	first, _, _ := strings.Cut(p, "/")
	return configRoot.MatchString(first)
}

// Check returns why the server refuses p as a note, or "" when it accepts it.
// It is the rule for notes, for MCP, and for every session of protocol 1 or 2.
//
// Go's utf8.ValidString refuses the encoded surrogates U+D800 to U+DFFF as
// well as malformed sequences, which is what the fixture's "utf8" means.
func Check(p string) Reason { return check(p, false) }

// CheckConfig is protocol 3's rule: Check, except that a profile root may
// begin the path, and then what follows it must be what settings sync carries
// (configScope). A path outside every profile root gets Check's answer.
func CheckConfig(p string) Reason { return check(p, true) }

func check(p string, config bool) Reason {
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
	root := config && IsConfig(p)
	inner := segments
	if root {
		inner = segments[1:]
	}
	for _, s := range inner {
		if strings.HasPrefix(s, ".") {
			return ReasonDotPrefix
		}
	}
	if strings.Contains(p, StagingMark) {
		return ReasonStaging
	}
	if root {
		return configScope(segments[1:])
	}
	return ""
}

// configScope says why a path inside a profile root does not sync, given its
// segments after the root, or "" when it does. Settings sync carries
// Obsidian's own settings, every JSON file at the top of the root, and themes
// and CSS snippets. Community plugins wait for a later phase, so their list
// and the plugins folder are out of scope; the sync plugin's folder and the
// workspace files never sync. Compared in ASCII lower case, so a case-folding
// disk cannot spell its way past the device-local rule.
func configScope(rest []string) Reason {
	lower := make([]string, len(rest))
	for i, s := range rest {
		lower[i] = asciiLower(s)
	}
	switch {
	case len(lower) >= 2 && lower[0] == "plugins" && lower[1] == SyncPluginID:
		return ReasonDeviceLocal
	case len(lower) == 1 && (lower[0] == "workspace.json" || lower[0] == "workspace-mobile.json"):
		return ReasonDeviceLocal
	case len(lower) == 1 && strings.HasSuffix(lower[0], ".json") && lower[0] != "community-plugins.json":
		return ""
	case len(lower) == 3 && lower[0] == "themes":
		return ""
	case len(lower) == 2 && lower[0] == "snippets" && strings.HasSuffix(lower[1], ".css"):
		return ""
	}
	return ReasonConfigScope
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

// FolderNotEmpty reports whether op would make a live folder entry a file while
// a live path is still in it, under any spelling that folds alike: by an
// update of the folder's own path, which rule 2 lets past Collides, or by a
// move that changes only its case, which rule 1 does (T58). The server refuses
// it as `stale`, as it refuses deleting that folder, and judges it before the
// collision rule (plan/protocol.md, "Paths"). Like Collides, it is the
// reference the store's check is tested against.
func FolderNotEmpty(live []Live, op Op) bool {
	if op.Folder {
		return false
	}
	folder := op.Path
	if op.Move {
		if Fold(op.Prev) != Fold(op.Path) {
			return false
		}
		folder = op.Prev
	}
	isFolder := false
	for _, e := range live {
		isFolder = isFolder || (e.Path == folder && e.Folder)
	}
	if !isFolder {
		return false
	}
	inside := Fold(folder) + "/"
	for _, e := range live {
		if strings.HasPrefix(e.Path, folder+"/") || strings.HasPrefix(Fold(e.Path), inside) {
			return true
		}
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

// conflictCopy is the name the engine gives the copy it keeps when a merge is
// abandoned, as conflictOriginal in client/src/core/conflicts.ts reads it
// back: "<name> (Conflicted copy <author> <twelve digits>)", with an optional
// " <n>" when that name was taken, and then the extension. The author is
// whoever wrote the copy's bytes (conflictCopyPath in client/src/core/merge.ts):
// any device's name or a token's label, spaces included, so anything but a
// slash stands between "copy " and the stamp. JavaScript's \d is ASCII without
// the u flag, as it is here.
var conflictCopy = regexp.MustCompile(`^(.*) \(Conflicted copy [^/]+ [0-9]{12}\)(?: [0-9]+)?(\.[^/]*)?$`)

// ConflictCopy reports whether p has the shape of a conflict copy's name.
// The MCP tools refuse to create one (reserved_name): the plugin's conflict
// review lists every such path as a copy of its original and offers to
// resolve it, so an agent's note with that name would be offered to a person
// as a conflict to throw away.
func ConflictCopy(p string) bool { return conflictCopy.MatchString(p) }

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
