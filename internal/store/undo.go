package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/waynehoover/trew/internal/paths"
)

// Undo is a compensating operation, not a rollback (PLAN.md section 4.5, M5
// task 7). History is never rewritten: an undo appends new versions that put
// back what an earlier operation displaced, and it does so only if every path
// that operation changed still holds the version the operation left there. A
// person or a device that has edited any of them since has made the before-
// image and their work two different things, and the undo refuses rather
// than choose between them, as a unit: a move with its backlinks, or a tag
// rename over forty notes, is undone whole or not at all. What it offers
// instead is the copy (ToCopy): each before-image written to a new, free path
// beside its note, with nothing already in the vault touched.
//
// The before-images are the versions the operation pinned (op_pins), so for
// as long as the pin lasts an undo can always read them. After it expires a
// purge may take them, and an undo that needs one then refuses as gone,
// naming the path and the uid, rather than write anything less.
//
// An undo is an operation in its own right, committed through CommitOperation
// like any agent's: the same recheck at the boundary, pins of what it
// displaces (the undone operation's outputs), a row in the log recorded as
// UndoTool with the id of the operation it undoes, and an idempotency key when
// the caller has one. So an undo can itself be undone, which is a redo, and
// the second undo of one operation is refused: its first undo moved every head
// the second would need (ErrAlreadyUndone names which undo did it).

// The actor kinds besides an agent's (AuthorKindMCP). Neither is a sync peer:
// the operator has no device row at all, and a device is one already.
const (
	// ActorOperator is `trewd undo` on the server host, through the control
	// socket or, with no server running, on the store directly.
	ActorOperator = "operator"
	// ActorDevice is a device asking from the plugin's history panel.
	ActorDevice = "device"
)

// OperatorActorID is the actor id every operator operation is recorded
// under. There is one operator: whoever can reach the data directory.
const OperatorActorID = "operator"

// OperatorLabel is what the versions an operator's undo writes are recorded
// as, which note_history, `trewd audit` and the devices' history panels show.
const OperatorLabel = "trewd undo"

// The tools an undo is recorded as, whoever asked for it.
const (
	// UndoTool is an undo in place: the before-images written back.
	UndoTool = "undo"
	// UndoToCopyTool is the copy: the before-images written beside their
	// notes, nothing replaced.
	UndoToCopyTool = "undo_to_copy"
)

var (
	// ErrNoOperation is an operation id the vault has no operation under, or
	// none the caller may undo.
	ErrNoOperation = errors.New("no operation by that id")
	// ErrChangedSince is an undo in place refused because a path the
	// operation changed has been changed again since.
	ErrChangedSince = errors.New("a path the operation changed has been changed since")
	// ErrBeforeImageGone is a version the undo needs that is no longer in
	// the store: its pin expired and a purge took it.
	ErrBeforeImageGone = errors.New("a version the operation displaced is no longer in the store")
	// ErrNothingToUndo is an operation that wrote nothing, or a copy of one
	// whose paths held nothing before.
	ErrNothingToUndo = errors.New("there is nothing to put back")
)

// kind is the operation's actor kind, an agent's when unset.
func (op Operation) kind() string {
	if op.ActorKind == "" {
		return AuthorKindMCP
	}
	return op.ActorKind
}

// validActor is whether id is the shape of an actor of kind.
func validActor(kind, id string) bool {
	switch kind {
	case AuthorKindMCP:
		return ValidMCPTokenID(id)
	case ActorDevice:
		return ValidDeviceID(id)
	case ActorOperator:
		return id == OperatorActorID
	}
	return false
}

// UndoRequest asks for the undo of one operation.
type UndoRequest struct {
	Vault string
	// OpID is the operation to undo.
	OpID string
	// ToCopy asks for the copy rather than the undo in place.
	ToCopy bool
	// OnlyActor, when set, is the one MCP token whose operations may be
	// undone: an agent undoes its own and no other's (plan/mcp-tools.md,
	// undo_operation). Another's is not found, as lookup_operation answers.
	OnlyActor string
	// Label is what the undo's versions are written as: the actor's label.
	Label string
	// Now is the server's clock in milliseconds, every new version's mtime.
	Now int64
}

// What an undo does, step by step (UndoStep.Action).
const (
	// UndoRestore writes a before-image back at its path: an edit undone, a
	// deletion undone, a folder put back.
	UndoRestore = "restore"
	// UndoMoveBack moves a note back from where a move put it (From) to
	// where it was (Path), with the bytes it had there, which also undoes
	// the move's rewrite of its own links.
	UndoMoveBack = "move_back"
	// UndoRemove deletes what the operation created, that exact version.
	UndoRemove = "remove"
	// UndoRemoveFolder deletes a folder the operation created, which is
	// empty once the rest of the undo is written.
	UndoRemoveFolder = "remove_folder"
	// UndoKeepFolder leaves a folder the operation created, because
	// something the operation did not put there is in it now.
	UndoKeepFolder = "keep_folder"
	// UndoMakeFolder creates a folder a restore needs and the vault lacks.
	UndoMakeFolder = "make_folder"
	// UndoCopy writes a before-image to Copy, a new path beside Path.
	UndoCopy = "copy"
	// UndoNothing is, in a copy, a path with nothing to copy: it held
	// nothing, or a folder, before the operation.
	UndoNothing = "nothing"
)

// UndoStep is one thing an undo does, in the order it does them.
type UndoStep struct {
	Action string `json:"action"`
	Path   string `json:"path"`
	// From, on a move back, is where the note moves back from.
	From string `json:"from,omitempty"`
	// Copy, on a copy, is where the before-image goes.
	Copy string `json:"copy,omitempty"`
	// Before is the version put back or copied, and After the version the
	// operation left, which an undo in place requires to be the head still.
	Before int64 `json:"before,omitempty"`
	After  int64 `json:"after,omitempty"`
	// Why says why a folder is kept or a path has nothing to copy.
	Why string `json:"why,omitempty"`
}

// ChangedPath is a path the operation changed that holds another version now.
type ChangedPath struct {
	Path string `json:"path"`
	// After is the version the operation left; Head the one there now, zero
	// when the path holds nothing; By and At who wrote the head and when, by
	// their clock, when the head is still in the store.
	After int64  `json:"after"`
	Head  int64  `json:"head"`
	By    string `json:"by,omitempty"`
	At    int64  `json:"at,omitempty"`
}

// GonePath is a before-image the undo needs and the store no longer holds.
type GonePath struct {
	Path   string `json:"path"`
	Before int64  `json:"before"`
	// PinnedUntil is when its pin expired, when the pin row is still there
	// to say.
	PinnedUntil int64  `json:"pinnedUntil,omitempty"`
	Why         string `json:"why"`
}

// UndoPlan is the compensating operation for one earlier operation, prepared
// outside the write lock, and what it found. Entries and Checks are what
// CommitOperation commits, as Operation gives them; Steps say what each does.
//
// On a refusal the plan still says what was found: Changed, the paths edited
// since (an undo in place refuses when there is any), and Gone, the before-
// images a purge took (either kind refuses when there is any).
type UndoPlan struct {
	Target  OperationRecord
	ToCopy  bool
	Entries []OpEntry
	Checks  []OpCheck
	Steps   []UndoStep
	Changed []ChangedPath
	Gone    []GonePath
}

// Operation is the plan as an operation: its tool, the operation it undoes,
// and its entries and checks. The caller adds the actor, the digest, the
// epoch and the rendering.
func (p UndoPlan) Operation() Operation {
	tool := UndoTool
	if p.ToCopy {
		tool = UndoToCopyTool
	}
	return Operation{Tool: tool, Undoes: p.Target.ID, Entries: p.Entries, Checks: p.Checks}
}

// undoPath is one of the operation's paths as the planner reads it.
type undoPath struct {
	OperationPath
	// head is the path's head now, and changed whether it is not the
	// operation's output.
	head    int64
	changed bool
	// after is the operation's output at this path.
	after Entry
	// before is the before-image, when the path held a note or a folder
	// before the operation and the store still has it; live says it held one.
	before Entry
	live   bool
	// partner is, for a move, the index of the move's other half: the
	// destination's row for its source's and the other way round, else -1.
	partner int
}

// PlanUndo prepares the undo of r.OpID, or refuses it. It only reads, so it
// runs outside the write lock, and CommitOperation checks everything it relied
// on again at the boundary: every head (each entry's base), the folders it
// removes still empty, the operation not undone meanwhile.
//
// Every refusal is an *OpError, refused, with nothing prepared: not_found,
// stale (the store restored since the operation, or, in place, a path changed
// since), already_undone, gone, nothing_to_undo, exists (a file where a
// restore needs a folder) or badpath (a copy's name the path rules refuse).
func (s *Store) PlanUndo(r UndoRequest) (UndoPlan, error) {
	plan := UndoPlan{ToCopy: r.ToCopy}
	notFound := refused("", OpCodeNotFound, "", 0, fmt.Errorf("%w: %q", ErrNoOperation, r.OpID))
	if !ValidOperationID(r.OpID) {
		return plan, notFound
	}
	rec, ok, err := s.LookupOperation(r.Vault, r.OpID)
	if err != nil {
		return plan, failed("", err)
	}
	if !ok || (r.OnlyActor != "" && (rec.ActorKind != AuthorKindMCP || rec.ActorID != r.OnlyActor)) {
		return plan, notFound
	}
	rec.Result = nil
	plan.Target = rec
	switch {
	case rec.Epoch != s.Epoch():
		return plan, refused("", OpCodeStale, "", 0, fmt.Errorf(
			"%w: operation %s was recorded in epoch %q and the store is at %q, so the uids it names may be other "+
				"versions now", ErrEpochChanged, rec.ID, rec.Epoch, s.Epoch()))
	case rec.Outcome == "noop" || len(rec.Paths) == 0:
		return plan, refused("", OpCodeNothingToUndo, "", 0, fmt.Errorf(
			"%w: operation %s changed nothing", ErrNothingToUndo, rec.ID))
	case !r.ToCopy && rec.UndoneBy != "":
		return plan, refused("", OpCodeAlreadyUndone, "", 0, fmt.Errorf(
			"%w: operation %s undid it", ErrAlreadyUndone, rec.UndoneBy))
	case rec.PathsTotal > len(rec.Paths):
		return plan, failed("", fmt.Errorf("operation %s changed %d paths and %d were read", rec.ID, rec.PathsTotal, len(rec.Paths)))
	}

	ps, err := s.readUndoPaths(r.Vault, rec, &plan)
	if err != nil {
		return plan, err
	}
	if len(plan.Gone) > 0 {
		g := plan.Gone[0]
		return plan, refused("", OpCodeGone, g.Path, 0, fmt.Errorf(
			"%w: %s (uid %d at %q%s)", ErrBeforeImageGone, g.Why, g.Before, g.Path, andMore(len(plan.Gone))))
	}

	b := undoBuilder{s: s, r: r, plan: &plan, ps: ps, taken: map[string]bool{}}
	if r.ToCopy {
		err = b.copies()
	} else {
		if len(plan.Changed) > 0 {
			c := plan.Changed[0]
			return plan, refused("", OpCodeStale, c.Path, c.Head, fmt.Errorf(
				"%w: %q is at uid %d, and the operation left uid %d%s. Nothing was written; the copy writes "+
					"the versions the operation replaced beside the notes instead", ErrChangedSince,
				c.Path, c.Head, c.After, andMore(len(plan.Changed))))
		}
		err = b.inPlace()
	}
	if err != nil {
		return plan, err
	}
	if len(plan.Entries) == 0 {
		why := "every folder the operation made holds something it did not put there"
		if r.ToCopy {
			why = "no path the operation changed held a note before it; undo it in place to remove what it created"
		}
		return plan, refused("", OpCodeNothingToUndo, "", 0, fmt.Errorf("%w: %s", ErrNothingToUndo, why))
	}
	return plan, nil
}

// andMore is ", and n-1 more" for a list of n refusals, or "".
func andMore(n int) string {
	if n <= 1 {
		return ""
	}
	return fmt.Sprintf(", and %d more", n-1)
}

// readUndoPaths reads every path of rec: its head now, the operation's output,
// the before-image, and a move's two halves paired. Paths changed since go to
// plan.Changed, before-images the store no longer holds to plan.Gone.
func (s *Store) readUndoPaths(vault string, rec OperationRecord, plan *UndoPlan) ([]undoPath, error) {
	pinned := map[int64]int64{}
	for _, p := range rec.Pins {
		pinned[p.UID] = p.ExpiresAt
	}
	ps := make([]undoPath, len(rec.Paths))
	for i, p := range rec.Paths {
		u := undoPath{OperationPath: p, partner: -1}
		head, _, err := s.Head(vault, p.Path)
		if err != nil {
			return nil, failed("", err)
		}
		u.head = head
		u.changed = head != p.AfterUID
		after, ok, err := s.EntryByUID(vault, p.AfterUID)
		if err != nil {
			return nil, failed("", err)
		}
		if !ok {
			// A head is never purged, so an output that is gone is one that
			// stopped being the head long ago.
			u.changed = true
		}
		u.after = after
		if u.changed {
			c := ChangedPath{Path: p.Path, After: p.AfterUID, Head: head}
			if h, ok, err := s.EntryByUID(vault, head); err != nil {
				return nil, failed("", err)
			} else if ok && head != 0 {
				c.By, c.At = h.Device, h.MTime
			}
			plan.Changed = append(plan.Changed, c)
		}

		gone := func(why string) {
			g := GonePath{Path: p.Path, Why: why}
			if p.BeforeUID != nil {
				g.Before = *p.BeforeUID
			}
			if until, ok := pinned[g.Before]; ok {
				g.PinnedUntil = until
			}
			plan.Gone = append(plan.Gone, g)
		}
		switch {
		case p.BeforeUID == nil || p.BeforeState == BeforeNone || p.BeforeState == BeforeGone:
		default:
			be, ok, err := s.EntryByUID(vault, *p.BeforeUID)
			if err != nil {
				return nil, failed("", err)
			}
			switch {
			case !ok && p.BeforeState == BeforeLive:
				if until, pin := pinned[*p.BeforeUID]; pin && until > s.clock().UnixMilli() {
					gone("the version is pinned and missing, which `trewd verify` reports as lostpin; restore it " +
						"from a backup taken after the operation")
				} else {
					gone("its pin expired and a purge removed it")
				}
			case !ok:
				gone("a purge removed it, and this operation was recorded before the store kept what each path " +
					"held, so nothing can say whether it held a note")
			case be.Path != p.Path || be.Deleted:
				// Recorded before before_state was, and not live after all.
			default:
				missing := false
				for _, n := range be.Chunks {
					if _, ok := s.chunks.Size(vault, n); !ok {
						missing = true
						break
					}
				}
				if missing {
					gone("a body of the version is missing from the chunk store; `trewd verify -deep` says more")
				} else {
					u.before, u.live = be, true
				}
			}
		}
		ps[i] = u
	}
	// A move is two rows sharing one output: the destination, whose output
	// names the source as its previous path, and the source.
	for i := range ps {
		if ps[i].Role != "source" {
			continue
		}
		for j := range ps {
			if ps[j].Role == "write" && ps[j].AfterUID == ps[i].AfterUID && ps[j].after.Prev == ps[i].Path {
				ps[i].partner, ps[j].partner = j, i
				break
			}
		}
		if ps[i].partner < 0 {
			return nil, failed("", fmt.Errorf("operation %s retired %q at uid %d and wrote no destination for it",
				rec.ID, ps[i].Path, ps[i].AfterUID))
		}
	}
	return ps, nil
}

// undoBuilder turns the paths of an operation into the entries of its undo.
type undoBuilder struct {
	s    *Store
	r    UndoRequest
	plan *UndoPlan
	ps   []undoPath
	// taken are the paths the plan writes or checks, so a folder a restore
	// needs is made once and never also checked.
	taken map[string]bool
	// made are the folders the plan makes (restores and new ones), and moved
	// the paths it removes or moves away, for the emptiness of a folder.
	made  map[string]bool
	moved map[string]bool
}

func (b *undoBuilder) entry(path string) Entry {
	return Entry{Path: path, CTime: b.r.Now, MTime: b.r.Now, Device: b.r.Label, Chunks: []string{}}
}

// restored is the before-image as a new version at path.
func (b *undoBuilder) restored(path string, be Entry) Entry {
	e := b.entry(path)
	e.CTime, e.Folder, e.Size = be.CTime, be.Folder, be.Size
	e.Chunks = append([]string{}, be.Chunks...)
	return e
}

func (b *undoBuilder) add(oe OpEntry, step UndoStep) {
	b.plan.Entries = append(b.plan.Entries, oe)
	b.plan.Steps = append(b.plan.Steps, step)
	b.taken[oe.Entry.Path] = true
	if oe.Entry.Prev != "" {
		b.taken[oe.Entry.Prev] = true
	}
}

func (b *undoBuilder) check(path string, base int64) {
	if b.taken[path] {
		return
	}
	b.taken[path] = true
	b.plan.Checks = append(b.plan.Checks, OpCheck{Path: path, Base: base})
}

// inPlace is the undo proper, in five passes, each one's entries written
// before the next's so every entry meets the state it needs: the folders the
// operation removed, put back; the folders the restores need and the vault
// lacks, made; the notes the operation edited, deleted or moved, put back;
// the notes it created, removed; and the folders it created, removed, deepest
// first, when nothing is left in them.
func (b *undoBuilder) inPlace() error {
	b.made, b.moved = map[string]bool{}, map[string]bool{}
	var folders, notes, removals, removeFolders []int
	for i, u := range b.ps {
		switch {
		case u.Role == "source":
			notes = append(notes, i)
		case u.partner >= 0:
			// The destination of a move, undone with its source.
		case u.live && u.before.Folder:
			folders = append(folders, i)
		case u.live:
			notes = append(notes, i)
		case u.after.Deleted:
			// Nothing before and nothing after: nothing to undo here.
		case u.after.Folder:
			removeFolders = append(removeFolders, i)
		default:
			removals = append(removals, i)
		}
	}

	// 1. Folders the operation removed.
	sort.SliceStable(folders, func(a, c int) bool { return depth(b.ps[folders[a]].Path) < depth(b.ps[folders[c]].Path) })
	for _, i := range folders {
		u := b.ps[i]
		b.made[u.Path] = true
		b.add(OpEntry{Entry: b.restored(u.Path, u.before), Base: u.AfterUID},
			UndoStep{Action: UndoRestore, Path: u.Path, Before: u.before.UID, After: u.AfterUID})
	}

	// 2. The folders every restore lands in.
	for _, i := range notes {
		if err := b.parents(b.ps[i].Path); err != nil {
			return err
		}
	}

	// 3. Notes put back, and moves reversed.
	for _, i := range notes {
		u := b.ps[i]
		if u.Role == "source" {
			dest := b.ps[u.partner]
			if !u.live {
				return refused("", OpCodeInternal, u.Path, 0, fmt.Errorf(
					"the move from %q held no note before it, so it cannot be moved back", u.Path))
			}
			if dest.live {
				// The tools only move onto a free path, so this is an
				// operation no tool made: its destination's before-image and
				// the move back would name one path twice.
				return refused("", OpCodeInternal, dest.Path, 0, fmt.Errorf(
					"the move onto %q replaced a version there, which one undo cannot both move away and put back",
					dest.Path))
			}
			e := b.restored(u.Path, u.before)
			e.Prev = dest.Path
			b.moved[dest.Path] = true
			b.add(OpEntry{Entry: e, Base: u.AfterUID, PrevBase: dest.AfterUID},
				UndoStep{Action: UndoMoveBack, Path: u.Path, From: dest.Path, Before: u.before.UID, After: u.AfterUID})
			continue
		}
		b.add(OpEntry{Entry: b.restored(u.Path, u.before), Base: u.AfterUID},
			UndoStep{Action: UndoRestore, Path: u.Path, Before: u.before.UID, After: u.AfterUID})
	}

	// 4. Notes the operation created.
	for _, i := range removals {
		u := b.ps[i]
		e := b.entry(u.Path)
		e.Deleted = true
		b.moved[u.Path] = true
		b.add(OpEntry{Entry: e, Base: u.AfterUID}, UndoStep{Action: UndoRemove, Path: u.Path, After: u.AfterUID})
	}

	// 5. Folders the operation created, deepest first, each only if it is
	// empty once everything above is written. A kept folder's head is still
	// checked, so a folder moved or replaced meanwhile refuses the undo.
	sort.SliceStable(removeFolders, func(a, c int) bool {
		return depth(b.ps[removeFolders[a]].Path) > depth(b.ps[removeFolders[c]].Path)
	})
	for _, i := range removeFolders {
		u := b.ps[i]
		left, err := b.leftInside(u.Path)
		if err != nil {
			return err
		}
		if left > 0 {
			b.plan.Steps = append(b.plan.Steps, UndoStep{Action: UndoKeepFolder, Path: u.Path, After: u.AfterUID,
				Why: fmt.Sprintf("%d paths the operation did not put there are inside it", left)})
			b.check(u.Path, u.AfterUID)
			continue
		}
		e := b.entry(u.Path)
		e.Deleted = true
		b.moved[u.Path] = true
		b.add(OpEntry{Entry: e, Base: u.AfterUID, EmptyFolder: true},
			UndoStep{Action: UndoRemoveFolder, Path: u.Path, After: u.AfterUID})
	}
	return nil
}

// copies is the copy: each before-image of a note written to a new, free path
// beside the path it belongs to, and nothing already in the vault changed.
func (b *undoBuilder) copies() error {
	b.made, b.moved = map[string]bool{}, map[string]bool{}
	for _, u := range b.ps {
		switch {
		case !u.live:
			b.plan.Steps = append(b.plan.Steps, UndoStep{Action: UndoNothing, Path: u.Path, After: u.AfterUID,
				Why: "it held nothing before the operation"})
			continue
		case u.before.Folder:
			b.plan.Steps = append(b.plan.Steps, UndoStep{Action: UndoNothing, Path: u.Path, After: u.AfterUID,
				Why: "it was a folder before the operation, and a folder has no content to copy"})
			continue
		}
		to, err := b.freeCopy(u.Path, u.before.UID)
		if err != nil {
			return err
		}
		if err := b.parents(to); err != nil {
			return err
		}
		b.add(OpEntry{Entry: b.restored(to, u.before)},
			UndoStep{Action: UndoCopy, Path: u.Path, Copy: to, Before: u.before.UID, After: u.AfterUID})
	}
	return nil
}

// freeCopy is where a copy of version uid of path goes: "name (restored
// uid).md" beside it, as the plugin names a restore that finds its path
// taken (restoredCopyPath in client/src/core/client.ts), or "name (restored
// uid) 2.md" and so on when that is taken too. Free means no live path there
// or folding onto it, and not already a copy in this plan.
func (b *undoBuilder) freeCopy(path string, uid int64) (string, error) {
	stem, ext := splitName(path)
	base := stem + " (restored " + strconv.FormatInt(uid, 10) + ")"
	for n := 1; n < 1000; n++ {
		candidate := base + ext
		if n > 1 {
			candidate = base + " " + strconv.Itoa(n) + ext
		}
		if r := paths.Check(candidate); r != "" {
			return "", refused("", OpCodeBadPath, path, 0, fmt.Errorf(
				"%w: a copy beside %q would be named %q, which the path rules refuse (%s)", ErrBadPath, path, candidate, r))
		}
		if b.taken[candidate] {
			continue
		}
		head, gone, err := b.s.Head(b.r.Vault, candidate)
		if err != nil {
			return "", failed("", err)
		}
		if head != 0 && !gone {
			continue
		}
		if err := b.s.Collides(b.r.Vault, Entry{Path: candidate}); errors.Is(err, ErrCollision) {
			continue
		} else if err != nil {
			return "", failed("", err)
		}
		return candidate, nil
	}
	return "", refused("", OpCodeExists, path, 0, fmt.Errorf("%w: every name for a copy beside %q is taken", ErrExists, path))
}

// parents are the folders above path: a check of each one that is a live
// folder, a folder made for each one that holds nothing live now (a restore
// into a folder removed since), and a refusal where a file is in the way. A
// folder this plan puts back or makes is neither, and nor is one that other
// live paths hold up without a folder entry of its own: a device makes that
// on disk for what it writes into it, as it did for them.
func (b *undoBuilder) parents(path string) error {
	for i := 0; i < len(path); i++ {
		if path[i] != '/' {
			continue
		}
		dir := path[:i]
		if b.made[dir] {
			continue
		}
		e, state, _, err := b.s.EntryAsOf(b.r.Vault, dir, 0)
		if err != nil {
			return failed("", err)
		}
		held, err := b.s.dirHeld(b.r.Vault, dir)
		if err != nil {
			return failed("", err)
		}
		switch {
		case state == PathLive && e.Folder:
			b.check(dir, e.UID)
		case state == PathLive:
			return refused("", OpCodeExists, dir, e.UID, fmt.Errorf(
				"%w: a file is at %q, where %q needs a folder", ErrExists, dir, path))
		case held:
		default:
			b.made[dir] = true
			f := b.entry(dir)
			f.Folder = true
			b.add(OpEntry{Entry: f}, UndoStep{Action: UndoMakeFolder, Path: dir})
		}
	}
	return nil
}

// dirHeld is whether any live path is inside dir, which a device then holds
// as a folder on disk whether or not the folder has an entry of its own.
func (s *Store) dirHeld(vault, dir string) (bool, error) {
	var refs int64
	err := s.db.QueryRow(`SELECT COALESCE((SELECT refs FROM live_dirs WHERE vault_id = ? AND path = ?), 0)`,
		vault, dir).Scan(&refs)
	return refs > 0, err
}

// leftInside is how many live paths will be inside folder once the plan so
// far is written: those there now, less the ones it removes or moves away,
// plus the ones it puts there.
func (b *undoBuilder) leftInside(folder string) (int, error) {
	inside := map[string]bool{}
	tx, err := b.s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, failed("", err)
	}
	defer tx.Rollback()
	// Byte order, as the paths are stored: everything from "folder/" up to
	// "folder0", '0' being the byte after '/'.
	rows, err := tx.Query(`SELECT path FROM live_paths WHERE vault_id = ? AND path > ? AND path < ?`,
		b.r.Vault, folder+"/", folder+"0")
	if err != nil {
		return 0, failed("", err)
	}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return 0, failed("", err)
		}
		inside[p] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, failed("", err)
	}
	for p := range b.moved {
		delete(inside, p)
	}
	for _, oe := range b.plan.Entries {
		if !oe.Entry.Deleted && strings.HasPrefix(oe.Entry.Path, folder+"/") {
			inside[oe.Entry.Path] = true
		}
	}
	return len(inside), nil
}

// depth is how many folders a path is inside.
func depth(p string) int { return strings.Count(p, "/") }

// splitName is a path's name less its extension, and the extension, as the
// client's splitName has them: a leading dot starts no extension.
func splitName(p string) (stem, ext string) {
	slash := strings.LastIndexByte(p, '/')
	dot := strings.LastIndexByte(p, '.')
	if dot <= slash+1 {
		return p, ""
	}
	return p[:dot], p[dot:]
}

// UndoRefusalDetail is the part of a refused undo a person reads to decide
// what to do next: which paths were changed since and by whom, and which
// before-images are gone. Empty for every other refusal.
func (p UndoPlan) UndoRefusalDetail() string {
	var lines []string
	for _, c := range p.Changed {
		what := fmt.Sprintf("%q is at uid %d, and the operation left uid %d", c.Path, c.Head, c.After)
		switch {
		case c.Head == 0:
			what = fmt.Sprintf("%q holds nothing, and the operation left uid %d", c.Path, c.After)
		case c.By != "":
			what += fmt.Sprintf(" (written by %q at %s)", c.By, time.UnixMilli(c.At).UTC().Format(time.RFC3339))
		}
		lines = append(lines, what)
	}
	for _, g := range p.Gone {
		what := fmt.Sprintf("%q: uid %d is gone: %s", g.Path, g.Before, g.Why)
		if g.PinnedUntil != 0 {
			what += fmt.Sprintf("; it was pinned until %s", time.UnixMilli(g.PinnedUntil).UTC().Format(time.RFC3339))
		}
		lines = append(lines, what)
	}
	// Bounded, because it travels in one refusal and a tag rename can span
	// hundreds of notes; the first few are what a person acts on.
	if len(lines) > undoDetailLines {
		lines = append(lines[:undoDetailLines], fmt.Sprintf("and %d more", len(lines)-undoDetailLines))
	}
	return strings.Join(lines, "\n")
}

// undoDetailLines is the most paths UndoRefusalDetail names.
const undoDetailLines = 10

/* ---------------------------------------------------------------- *
 * Which operation wrote a version
 * ---------------------------------------------------------------- */

// OperationRef is the operation that wrote a version, as a device's history
// shows it (plan/protocol.md, protocol 2's `history`): its id, which the
// device's undo names, what it was, who made it, and the undo in place that
// undid it, if one has.
type OperationRef struct {
	ID       string `json:"id"`
	Tool     string `json:"tool"`
	Kind     string `json:"kind"`
	UndoneBy string `json:"undoneBy,omitempty"`
}

// WrittenBy is, for each of uids an operation wrote, that operation. A version
// a device wrote is not in it.
func (s *Store) WrittenBy(vault string, uids []int64) (map[int64]OperationRef, error) {
	out := map[int64]OperationRef{}
	if len(uids) == 0 {
		return out, nil
	}
	args := []any{vault}
	for _, u := range uids {
		args = append(args, u)
	}
	rows, err := s.db.Query(
		`SELECT DISTINCT p.after_uid, o.id, o.tool, o.actor_kind,
		        (SELECT u.id FROM operations u WHERE u.undoes = o.id AND u.tool = ? ORDER BY u.seq LIMIT 1)
		   FROM op_entries p JOIN operations o ON o.id = p.op_id
		  WHERE o.vault_id = ? AND p.after_uid IN (`+placeholders(len(uids))+`)`,
		append([]any{UndoTool}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid int64
		var ref OperationRef
		var undone sql.NullString
		if err := rows.Scan(&uid, &ref.ID, &ref.Tool, &ref.Kind, &undone); err != nil {
			return nil, err
		}
		ref.UndoneBy = undone.String
		out[uid] = ref
	}
	return out, rows.Err()
}
