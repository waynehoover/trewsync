package mcp

import (
	"errors"

	"github.com/waynehoover/trew/internal/store"
)

// undo_operation, an agent's undo of its own writes (PLAN.md section 4.5, M5
// task 7): the compensating operation store.PlanUndo prepares, committed
// through mutation.submit like every other write, so it rechecks the
// credential, the epoch, the key and every head at the boundary, pins what it
// displaces, and is recorded as the token's undo of the operation it names.
//
// Only the token's own operations, as lookup_operation reads only the
// token's own. A write token may already write anything, so this is not about
// what one could do by hand; it is about what a note can talk it into. Text
// that tells an agent to undo another agent's work, or a person's undo, finds
// no tool that will, and an operation that is not the token's is answered
// exactly as one never committed. The operator (`trewd undo`) and the devices
// (the history panel) may undo any operation.

func undoTool() *Tool {
	return &Tool{
		Name: "undo_operation", Title: "Undo an operation", Scope: store.ScopeWrite,
		Description: "Undo one of this token's own writes, by the opId its result or lookup_operation gave: new " +
			"versions that put back what it replaced, deleted or created, as one operation, and only if every note it " +
			"changed still holds what it left there. A move comes back with the note's own links and the backlinks " +
			"it edited; a create is removed, with the folders it made while nothing else is in them. If any note was " +
			"changed since, the undo is refused as stale, naming those notes, and nothing is written: call it again " +
			"with toCopy to write each version it replaced beside its note, as \"name (restored UID).md\", changing " +
			"nothing already there. An operation already undone is refused; an undo is itself an operation, and can " +
			"be undone." + resultSentence,
		Input: object([]string{"opId", "epoch"}, map[string]schema{
			"opId": textProp(64, "the operation to undo: one of this token's, as its result or lookup_operation gave it"),
			"epoch": textProp(64, "the store epoch of the result that gave you the opId; an operation's uids name "+
				"versions only within its epoch"),
			"toCopy": boolProp("write each version the operation replaced beside its note instead, changing " +
				"nothing already in the vault"),
			"idempotencyKey": keyProp,
		}),
		Run: undoOperation,
	}
}

func undoOperation(c *call, a *args) outcome {
	id, present := a.text("opId", 64)
	toCopy := a.boolean("toCopy", false)
	epoch := a.epoch(true)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if !present {
		return c.failWrite(invalidArguments("opId is required"))
	}
	m, o, done := c.begin(a, key, epoch)
	if done {
		return o
	}
	plan, err := c.h.st.PlanUndo(store.UndoRequest{
		Vault: c.h.vault, OpID: id, ToCopy: toCopy, OnlyActor: c.cred.token.ID,
		Label: c.cred.token.Label, Now: c.h.now().UnixMilli(),
	})
	if err != nil {
		return m.undoRefused(err, plan)
	}
	return m.submit(plan.Operation(), func(r store.OpResult) (any, any) {
		return undoneTrusted{CommitFacts: committedFacts(r), Undoes: id, ToCopy: toCopy},
			undoneRows{Entries: entryRows(r), Steps: stepRows(plan.Steps)}
	})
}

// undoneTrusted is an undo's facts: that it committed, as what, the operation
// it undid, which is the caller's own argument, and whether it was the copy.
type undoneTrusted struct {
	CommitFacts
	Undoes string `json:"undoes"`
	ToCopy bool   `json:"toCopy"`
}

// undoneRows are what an undo wrote and what it did to each path, under
// untrusted_content, since the paths are the vault's.
type undoneRows struct {
	Entries []entryRow `json:"entries"`
	Steps   []stepRow  `json:"steps"`
}

// stepRow is one store.UndoStep as a result lists it.
type stepRow struct {
	Action Text  `json:"action"`
	Path   Text  `json:"path"`
	From   *Text `json:"from,omitempty"`
	Copy   *Text `json:"copy,omitempty"`
	Before int64 `json:"before,omitempty"`
	After  int64 `json:"after,omitempty"`
	Why    *Text `json:"why,omitempty"`
}

func stepRows(steps []store.UndoStep) []stepRow {
	out := make([]stepRow, 0, len(steps))
	opt := func(s string) *Text {
		if s == "" {
			return nil
		}
		t := text(s)
		return &t
	}
	for _, s := range steps {
		out = append(out, stepRow{Action: text(s.Action), Path: text(s.Path), From: opt(s.From), Copy: opt(s.Copy),
			Before: s.Before, After: s.After, Why: opt(s.Why)})
	}
	return out
}

// undoRefused is a refused undo: committed false, the store's code, a message
// that says what to do, and the paths it is about under untrusted_content,
// each changed one with its head now and the label of whoever wrote it, which
// a device chose and so is the vault's text too.
func (m *mutation) undoRefused(err error, plan store.UndoPlan) outcome {
	var oe *store.OpError
	if !errors.As(err, &oe) || oe.Outcome != store.OpRefused || oe.Code == store.OpCodeInternal {
		return m.failed(err)
	}
	messages := map[string]string{
		store.OpCodeStale: "a note this operation changed has been changed since, so undoing it would overwrite that " +
			"change; nothing was written. changed says which, and who changed them. Call undo_operation again with " +
			"toCopy true to write the versions it replaced beside their notes instead",
		store.OpCodeAlreadyUndone: "this operation has already been undone; nothing was written. lookup_operation " +
			"on it names the undo, which can itself be undone",
		store.OpCodeGone: "a version this operation replaced is no longer in the store: its pin expired and a purge " +
			"removed it, so nothing can put it back; nothing was written. gone says which",
		store.OpCodeNothingToUndo: "there is nothing to put back: the operation changed nothing, or, for a copy, " +
			"only created notes; nothing was written",
		store.OpCodeNotFound: "no write of this token committed under this opId; nothing was written. Only a token's " +
			"own writes can be undone with it",
		store.OpCodeNotEmpty: "a folder this operation created was filled while the undo was being prepared; nothing " +
			"was written. Call it again: the folder is then kept",
	}
	msg, ok := messages[oe.Code]
	if !ok {
		return m.failed(err)
	}
	if oe.Code == store.OpCodeStale && errors.Is(oe.Err, store.ErrEpochChanged) {
		msg = "the store was restored since this operation, so its uids may now name other versions; nothing was " +
			"written, and it cannot be undone"
	}
	out := writeFailure{Committed: false, Error: &ToolError{Code: oe.Code, Message: msg}}
	type changedRow struct {
		Path  Text  `json:"path"`
		After int64 `json:"after"`
		Head  int64 `json:"head"`
		By    *Text `json:"by,omitempty"`
		At    int64 `json:"at,omitempty"`
	}
	type goneRow struct {
		Path        Text   `json:"path"`
		Before      int64  `json:"before"`
		Why         Text   `json:"why"`
		PinnedUntil *int64 `json:"pinnedUntil,omitempty"`
	}
	type about struct {
		Changed []changedRow `json:"changed"`
		Gone    []goneRow    `json:"gone"`
	}
	u := about{Changed: []changedRow{}, Gone: []goneRow{}}
	for _, c := range plan.Changed {
		row := changedRow{Path: text(c.Path), After: c.After, Head: c.Head, At: c.At}
		if c.By != "" {
			by := text(c.By)
			row.By = &by
		}
		u.Changed = append(u.Changed, row)
	}
	for _, g := range plan.Gone {
		row := goneRow{Path: text(g.Path), Before: g.Before, Why: text(g.Why)}
		if g.PinnedUntil != 0 {
			until := g.PinnedUntil
			row.PinnedUntil = &until
		}
		u.Gone = append(u.Gone, row)
	}
	res, rerr := NewResult(m.c.tool.Name, out, u)
	if rerr != nil {
		return m.failed(err)
	}
	return outcome{env: res, isError: true}
}
