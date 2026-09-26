package notes

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"

	"github.com/waynehoover/trewsync/internal/paths"
)

// The bounds on one operation, as Basalt's mcp-operations.ts and mcp-batch.ts
// set them (plan/mcp-tools.md, "Preview and apply"). Counts are of notes and
// edits; sizes are UTF-8 bytes.
const (
	// ScanNotes and ScanBytes bound what a preview over a folder or the
	// vault reads: at most this many notes, and this many bytes of their
	// text, or scan_incomplete.
	ScanNotes = 512
	ScanBytes = 8 * NoteBytes
	// PlanBytes is the most a plan's changes may take, serialised as
	// JSON.stringify writes them (PlanSize), or plan_too_large.
	PlanBytes = 64 << 10
	// PlanEdits is the most edits one planned change may carry.
	PlanEdits = 4096
	// BatchFiles and BatchPathBytes bound the notes one operation touches:
	// at most this many paths, a move's destination counted as well, and
	// this many bytes of them as a JSON array, or batch_too_large.
	BatchFiles     = 32
	BatchPathBytes = 16 << 10
)

// PlannedChange is one note's part in a tag, move or delete operation: what a
// preview shows and what an apply must pass back unchanged. Base is the uid of
// the version the plan read; Start and End of each edit are UTF-16 offsets
// into that version's text. Action is "edit", "move" (to To, with the moved
// note's own link rewrites as its edits) or "delete".
type PlannedChange struct {
	Path   string       `json:"path"`
	Base   int64        `json:"base"`
	Action string       `json:"action"`
	To     string       `json:"to,omitempty"`
	Edits  []SourceEdit `json:"edits"`
}

// Version is one live note as a plan reads it: its bytes, and the uid of the
// version they are.
type Version struct {
	UID   int64
	Bytes []byte
}

// View is the vault as a plan reads it: every live file as of one head. The
// tool layer backs it with the store at the snapshot head a preview binds (PLAN.md
// section 4.3), tests with a map. Nothing here writes through it.
type View interface {
	// Files lists the path of every live file at the head, notes and
	// attachments, in any order. Folders and deletions are not files.
	Files() ([]string, error)
	// Read is the live file at path. A path with no live file is a
	// *Refusal with the code not_found; a file over NoteBytes may be refused
	// with note_too_large before its bytes are assembled.
	Read(path string) (Version, error)
}

// LinkIndex is what a View may also be: one that can rule a note out of the
// scan a move or a deletion with markBroken makes of the vault's links
// (PLAN.md M5 task 6). The tool layer backs it with the search index's link
// keys (LinkKeys), and only when the index has indexed exactly the head the
// View reads; a View that is not one is scanned whole, as Basalt did.
//
// The index narrows which notes are read and nothing else: every note the
// plan then reads is read through Read, from the store, and its links are
// resolved against the whole inventory, so what a plan edits is decided by
// authoritative content alone.
type LinkIndex interface {
	// MayLinkTo reports whether the note at path, in the version Read returns
	// for it, may hold a link that resolves to target. It answers false only
	// when it can prove the note holds none; for a note it knows nothing
	// about, or could not parse, it answers true, and the note is read.
	MayLinkTo(path, target string) bool
}

// Plan is an operation's changes, as a preview returns them and an apply
// recomputes them, with the text each change was planned from.
type Plan struct {
	Changes []PlannedChange
	// AmbiguousLinks counts the links left alone because their names meant
	// several notes (ChangeLinks).
	AmbiguousLinks int
	texts          map[string]string
}

// PlannedWrite is what one planned change commits: for an edit, Content at
// Path; for a move, Content at To and Path retired; for a deletion, Path
// retired and no Content.
type PlannedWrite struct {
	Change  PlannedChange
	Content []byte
}

// Writes are the plan's changes with the bytes each writes, in the plan's
// order: every edit applied, by ApplySourceEdits, to the text the change was
// planned from. A result over NoteBytes is input_too_large.
func (p Plan) Writes() ([]PlannedWrite, error) {
	out := make([]PlannedWrite, 0, len(p.Changes))
	for _, c := range p.Changes {
		w := PlannedWrite{Change: c}
		if c.Action != "delete" {
			text, err := ApplySourceEdits(p.texts[c.Path], c.Edits)
			if err != nil {
				return nil, err
			}
			w.Content = []byte(text)
		}
		out = append(out, w)
	}
	return out, nil
}

// TagScope is which notes a tag operation changes: Paths when it is not nil,
// each of which must be an editable note; otherwise every editable note
// beneath Folder, or in the whole vault when Folder is empty. A tool passes
// Folder only when the caller named one, and both at once is invalid_scope.
type TagScope struct {
	Paths  []string
	Folder string
}

// PlanTags is Basalt's planOperation for a tag operation: ChangeTags on each
// note of the scope. With Paths, every note named is in the plan, changed or
// not, so that an apply revalidates each base; over a folder, only those that
// change. The same note named twice is duplicate_path.
//
// Refusals besides ChangeTags's: invalid_scope; batch_too_large for more
// than BatchFiles paths or BatchPathBytes of them, before anything is read;
// each read's (planReader.read); and the plan's bounds (PlanTooLarge).
func PlanTags(view View, change TagChange, scope TagScope) (Plan, error) {
	if scope.Paths != nil && scope.Folder != "" {
		return Plan{}, refuse("invalid_scope", "supply paths or a folder, not both")
	}
	r := newPlanReader(view)
	list := scope.Paths
	if list != nil {
		if err := BatchBounds(list); err != nil {
			return Plan{}, err
		}
	} else {
		var err error
		if list, err = r.scan(scope.Folder); err != nil {
			return Plan{}, err
		}
	}
	var changes []PlannedChange
	seen := map[string]bool{}
	for _, path := range list {
		text, v, err := r.read(path)
		if err != nil {
			return Plan{}, err
		}
		key := paths.Fold(path)
		if seen[key] {
			return Plan{}, refuse("duplicate_path", "each selected note must be distinct")
		}
		seen[key] = true
		te, err := ChangeTags(text, change)
		if err != nil {
			return Plan{}, about(err, path)
		}
		if len(te.Edits) > 0 || scope.Paths != nil {
			changes = append(changes, PlannedChange{Path: path, Base: v.UID, Action: "edit", Edits: nonNilEdits(te.Edits)})
		}
	}
	return r.finish(changes, 0)
}

// PlanMove is Basalt's planOperation for move_note: the move of path to to,
// with its own relative links rewritten for the new place, and with
// updateLinks every other note's links to it (ChangeLinks over the vault,
// which reads every editable note, or with a LinkIndex every one that may link
// to it). Links whose names mean several notes are left alone and counted.
//
// The destination must be an editable format (unsupported_format) and a
// path the server accepts (badpath), not the source itself
// (same_destination), and free: no live file that a case-folding disk would
// hold as the same file, other than the source (exists). A case-only rename
// is a move, as the store allows. The store's collision rule, which also
// sees folders, still has the last word at the commit.
func PlanMove(view View, path, to string, updateLinks bool) (Plan, error) {
	r := newPlanReader(view)
	_, source, err := r.read(path)
	if err != nil {
		return Plan{}, err
	}
	if !editableFormat(to) {
		return Plan{}, unsupportedFormat()
	}
	if reason := paths.Check(to); reason != "" {
		return Plan{}, refuse("badpath", string(reason)+": the server refuses this path")
	}
	if to == path {
		return Plan{}, refuse("same_destination", "move to a distinct unoccupied path")
	}
	list, err := r.scan("")
	if err != nil {
		return Plan{}, err
	}
	for _, p := range r.inventory {
		if p != path && paths.Fold(p) == paths.Fold(to) {
			return Plan{}, refuse("exists", "the destination is already occupied")
		}
	}
	return r.links(list, path, source, to, false, !updateLinks)
}

// PlanDelete is Basalt's planOperation for delete_note: the deletion of
// path, and with markBroken every other note's links to it struck through
// (ChangeLinks over the vault, which reads every editable note, or with a
// LinkIndex every one that may link to it).
func PlanDelete(view View, path string, markBroken bool) (Plan, error) {
	r := newPlanReader(view)
	_, source, err := r.read(path)
	if err != nil {
		return Plan{}, err
	}
	var list []string
	if markBroken {
		if list, err = r.scan(""); err != nil {
			return Plan{}, err
		}
	}
	return r.links(list, path, source, "", true, false)
}

// links finishes a move or a deletion: ChangeLinks over list, then the
// source's own change. With onlySource, the other notes are not read.
func (r *planReader) links(list []string, path string, source Version, to string, deletion, onlySource bool) (Plan, error) {
	var changes []PlannedChange
	var own []SourceEdit
	ambiguous := 0
	index, narrowed := r.view.(LinkIndex)
	for _, p := range list {
		if deletion && paths.Fold(p) == paths.Fold(path) {
			continue
		}
		if onlySource && p != path {
			continue
		}
		// The moved note is always read: its own relative links move with it,
		// which no key of the target describes.
		if narrowed && p != path && !index.MayLinkTo(p, path) {
			continue
		}
		text, v, err := r.read(p)
		if err != nil {
			return Plan{}, err
		}
		edits, n, err := ChangeLinks(text, LinkChange{
			Path: p, From: path, To: to, Delete: deletion, Inventory: r.inventory, Canonical: paths.Fold,
		})
		if err != nil {
			return Plan{}, about(err, p)
		}
		ambiguous += n
		switch {
		case p == path:
			own = edits
		case len(edits) > 0:
			changes = append(changes, PlannedChange{Path: p, Base: v.UID, Action: "edit", Edits: edits})
		}
	}
	action := "move"
	if deletion {
		action = "delete"
	}
	changes = append(changes, PlannedChange{Path: path, Base: source.UID, Action: action, To: to, Edits: nonNilEdits(own)})
	return r.finish(changes, ambiguous)
}

// planReader reads a plan's notes, each once, within the scan bounds.
type planReader struct {
	view      View
	inventory []string // every live file, once scan has listed them
	versions  map[string]Version
	texts     map[string]string
	bytes     int
}

func newPlanReader(view View) *planReader {
	return &planReader{view: view, versions: map[string]Version{}, texts: map[string]string{}}
}

// read is one note of the plan, as Basalt's read() took it: an editable
// format (unsupported_format), a path the server accepts (badpath), live (the
// view's refusal), at most NoteBytes (note_too_large), within the scan bounds
// (scan_incomplete: a note more than ScanNotes, or text past ScanBytes), and
// UTF-8 (invalid_utf8). A note read before is not read or counted again.
func (r *planReader) read(path string) (string, Version, error) {
	if !editableFormat(path) {
		return "", Version{}, about(unsupportedFormat(), path)
	}
	if reason := paths.Check(path); reason != "" {
		return "", Version{}, about(refuse("badpath", string(reason)+": the server refuses this path"), path)
	}
	if v, ok := r.versions[path]; ok {
		return r.texts[path], v, nil
	}
	v, err := r.view.Read(path)
	if err != nil {
		return "", Version{}, about(err, path)
	}
	if len(v.Bytes) > NoteBytes {
		return "", Version{}, about(refuse("note_too_large", "the note is too large for this read"), path)
	}
	r.bytes += len(v.Bytes)
	if len(r.versions) >= ScanNotes || r.bytes > ScanBytes {
		return "", Version{}, refuse("scan_incomplete", "the operation exceeds 512 notes or 8 MiB; narrow its scope")
	}
	text, err := DecodeNote(v.Bytes)
	if err != nil {
		return "", Version{}, about(err, path)
	}
	r.versions[path], r.texts[path] = v, text
	return text, v, nil
}

// scan lists every live file as the inventory links resolve against, and
// returns the editable notes beneath folder ("" for the whole vault), sorted.
func (r *planReader) scan(folder string) ([]string, error) {
	files, err := r.view.Files()
	if err != nil {
		return nil, err
	}
	r.inventory = append([]string(nil), files...)
	sort.Strings(r.inventory)
	var out []string
	for _, p := range r.inventory {
		if (folder == "" || strings.HasPrefix(p, folder+"/")) && editableFormat(p) && paths.Check(p) == "" {
			out = append(out, p)
		}
	}
	return out, nil
}

// finish sorts a plan's changes by path and holds it to its bounds.
func (r *planReader) finish(changes []PlannedChange, ambiguous int) (Plan, error) {
	sortChanges(changes)
	if err := PlanTooLarge(changes); err != nil {
		return Plan{}, err
	}
	texts := map[string]string{}
	for _, c := range changes {
		texts[c.Path] = r.texts[c.Path]
	}
	return Plan{Changes: changes, AmbiguousLinks: ambiguous, texts: texts}, nil
}

// PlanTooLarge holds changes to a plan's bounds, as Basalt did both to the
// plan it computed and to the one an apply passed back: batch_too_large for
// more than BatchFiles changes or BatchBounds's refusal of their paths, a
// move's destination included; plan_too_large for a change with more than
// PlanEdits edits or changes over PlanBytes.
func PlanTooLarge(changes []PlannedChange) error {
	if len(changes) > BatchFiles {
		return batchTooLarge()
	}
	var list []string
	for _, c := range changes {
		if len(c.Edits) > PlanEdits {
			return planTooLarge()
		}
		list = append(list, c.Path)
		if c.To != "" {
			list = append(list, c.To)
		}
	}
	if err := BatchBounds(list); err != nil {
		return err
	}
	if PlanSize(changes) > PlanBytes {
		return planTooLarge()
	}
	return nil
}

// BatchBounds is Basalt's batchBounds: at most BatchFiles paths, and at most
// BatchPathBytes of them as JSON.stringify writes the list, or
// batch_too_large. Control characters count as the escapes they become.
func BatchBounds(list []string) error {
	if len(list) > BatchFiles || jsStringsSize(list) > BatchPathBytes {
		return batchTooLarge()
	}
	return nil
}

func batchTooLarge() error {
	return refuse("batch_too_large", "use at most 32 notes and 16 KiB of encoded paths per batch")
}

func planTooLarge() error {
	return refuse("plan_too_large", "the exact changes exceed 64 KiB; narrow the operation")
}

// PlanSize is the size in bytes of changes as JSON.stringify writes them,
// which is what PlanBytes bounds: each change's path, base, action, to when it
// has one, and edits of start, end, old and text, in that order. Basalt's base
// was a 64-character digest; a uid is written as the number it is, so the
// same plan is smaller here.
func PlanSize(changes []PlannedChange) int { return len(appendPlan(nil, changes, false)) }

// SamePlan is Basalt's samePlan: whether a plan passed back to apply is the
// plan computed now. Both are normalised (each change's path, base, action,
// to or null, and edits, sorted by path) and compared exactly; anything else a
// caller adds is ignored, and edits compare in order.
func SamePlan(supplied, current []PlannedChange) bool {
	return string(planKey(supplied)) == string(planKey(current))
}

// PlanDigest is the SHA-256 of a plan's normalised form, in hex: the same for
// two plans exactly when SamePlan holds, for a caller that keeps a digest in
// place of the plan.
func PlanDigest(changes []PlannedChange) string {
	sum := sha256.Sum256(planKey(changes))
	return hex.EncodeToString(sum[:])
}

func planKey(changes []PlannedChange) []byte {
	sorted := append([]PlannedChange(nil), changes...)
	sortChanges(sorted)
	return appendPlan(nil, sorted, true)
}

// sortChanges orders changes by path, in byte order (which is code point
// order; Basalt compared UTF-16 units, which differ only between U+E000 to
// U+FFFF and the characters beyond, as M4 recorded for listings), keeping
// the order of changes to one path.
func sortChanges(changes []PlannedChange) {
	sort.SliceStable(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
}

// appendPlan appends JSON.stringify of changes, or with normalized of
// Basalt's normalised form, in which to is always present and null when a
// change has none.
func appendPlan(b []byte, changes []PlannedChange, normalized bool) []byte {
	b = append(b, '[')
	for i, c := range changes {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"path":`...)
		b = appendJSString(b, c.Path)
		b = append(b, `,"base":`...)
		b = strconv.AppendInt(b, c.Base, 10)
		b = append(b, `,"action":`...)
		b = appendJSString(b, c.Action)
		switch {
		case c.To != "":
			b = append(b, `,"to":`...)
			b = appendJSString(b, c.To)
		case normalized:
			b = append(b, `,"to":null`...)
		}
		b = append(b, `,"edits":[`...)
		for j, e := range c.Edits {
			if j > 0 {
				b = append(b, ',')
			}
			b = append(b, `{"start":`...)
			b = strconv.AppendInt(b, int64(e.Start), 10)
			b = append(b, `,"end":`...)
			b = strconv.AppendInt(b, int64(e.End), 10)
			b = append(b, `,"old":`...)
			b = appendJSString(b, e.Old)
			b = append(b, `,"text":`...)
			b = appendJSString(b, e.Text)
			b = append(b, '}')
		}
		b = append(b, "]}"...)
	}
	return append(b, ']')
}

// editableFormat is Basalt's noteFormat for a mutation: Markdown or plain
// text, and not an Excalidraw drawing, by extension in ASCII lower case
// (paths.MCPEditable, before the path rules, which Basalt checked second).
func editableFormat(p string) bool {
	lower := asciiLowerString(p)
	return (strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".txt")) &&
		!strings.HasSuffix(lower, ".excalidraw.md")
}

func unsupportedFormat() error {
	return refuse("unsupported_format", "agent notes must be Markdown or plain text, excluding drawings")
}

// about is err with the note it concerns, when it is a refusal that does not
// already name one.
func about(err error, path string) error {
	if r, ok := err.(*Refusal); ok && r.Path == "" {
		c := *r
		c.Path = path
		return &c
	}
	return err
}

func nonNilEdits(edits []SourceEdit) []SourceEdit {
	if edits == nil {
		return []SourceEdit{}
	}
	return edits
}
