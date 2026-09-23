package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/waynehoover/trew/internal/control"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

// cmdUndo undoes one operation in the log `trewd audit` prints (PLAN.md
// section 4.5, M5 task 7): new versions that put back what the operation
// displaced, as one operation, and only if every path it changed still holds
// the version it left there. With -to-copy, each version it replaced is
// written beside its note instead, and nothing already in the vault changes.
//
// It is how a person rolls back an agent's overnight run, so it goes through
// the running server's control socket, whose commit lock orders it against
// every device's write and whose broadcast sends it to every device connected,
// and opens the store itself only when no server is running, under the
// exclusive server lock, as `revoke` does (PLAN.md section 2.3.1).
//
// The operator is the actor: recorded as such in the log, kind operator, and
// the versions it writes carry the label "trewd undo", which is what a
// device's history panel shows. The operator has no device row, so it is in
// no device list and no sync peer waits on it.
//
// What it prints says exactly what was put back, where each copy went, or,
// refused, why and what to do. A refusal exits non-zero.
func cmdUndo(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("undo", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	toCopy := fs.Bool("to-copy", false,
		"write each version the operation replaced beside its note, as \"name (restored UID).md\", changing nothing else")
	asJSON := fs.Bool("json", false, "print what was done, or why not, as JSON")
	ids, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	if len(ids) != 1 {
		return errors.New("undo takes one operation id; `trewd audit` lists them")
	}
	id := ids[0]
	if !store.ValidOperationID(id) {
		return fmt.Errorf("%q is not an operation id; `trewd audit` lists them", id)
	}

	reply, err := administer(*dataDir, *vault, "undo", control.Request{Op: "undo", OpID: id, ToCopy: *toCopy})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	u := reply.Undo
	if u == nil {
		return errors.New("the server answered the undo with nothing")
	}
	if *asJSON {
		b, err := json.MarshalIndent(u, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n", b)
		if !u.Committed {
			return fmt.Errorf("the undo of %s was refused: %s", id, u.Code)
		}
		return nil
	}
	return writeUndo(out, u)
}

// parseInterspersed parses flags wherever they are among the arguments, so
// `trewd undo OPID -to-copy` reads as it looks, and returns the arguments that
// are not flags. Go's flag package stops at the first one otherwise.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var rest []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return rest, nil
		}
		rest = append(rest, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

// writeUndo prints what an undo did, a line for each thing it did, or why it
// was refused, a line for each path it is about.
func writeUndo(out io.Writer, u *control.Undo) error {
	var target store.OperationRecord
	about := "operation " + u.Undoes
	if len(u.Target) > 0 && json.Unmarshal(u.Target, &target) == nil && target.ID != "" {
		about += fmt.Sprintf(" (%s by %s, %s)", target.Tool, actorOf(target), stamp(target.CommittedAt))
	}
	if !u.Committed {
		var changed []store.ChangedPath
		var gone []store.GonePath
		_ = json.Unmarshal(u.Changed, &changed)
		_ = json.Unmarshal(u.Gone, &gone)
		fmt.Fprintf(out, "Did not undo %s: %s: %s\n", about, u.Code, u.Reason)
		detail := store.UndoPlan{Changed: changed, Gone: gone}.UndoRefusalDetail()
		for _, line := range strings.Split(detail, "\n") {
			if line != "" {
				fmt.Fprintf(out, "  %s\n", line)
			}
		}
		fmt.Fprintln(out, "Nothing was written.")
		if u.Code == store.OpCodeStale && len(changed) > 0 && !u.ToCopy {
			fmt.Fprintf(out, "`trewd undo -to-copy %s` writes the versions it replaced beside their notes instead, "+
				"and changes nothing already there.\n", u.Undoes)
		}
		return fmt.Errorf("the undo of %s was refused: %s", u.Undoes, u.Code)
	}

	var steps []store.UndoStep
	if err := json.Unmarshal(u.Steps, &steps); err != nil {
		return err
	}
	var entries []struct {
		Path string `json:"path"`
		UID  int64  `json:"uid"`
	}
	_ = json.Unmarshal(u.Entries, &entries)
	uidOf := map[string]int64{}
	for _, e := range entries {
		uidOf[e.Path] = e.UID
	}
	verb := "Undid"
	if u.ToCopy {
		verb = "Copied what was replaced by"
	}
	fmt.Fprintf(out, "%s %s, as operation %s at %s:\n", verb, about, u.OpID, stamp(u.CommittedAt))
	for _, s := range steps {
		fmt.Fprintf(out, "  %s\n", describeStep(s, uidOf))
	}
	fmt.Fprintf(out, "Every device receives these versions as it syncs. `trewd undo %s` undoes this undo.\n", u.OpID)
	return nil
}

// describeStep is one step of an undo as a person reads it.
func describeStep(s store.UndoStep, uidOf map[string]int64) string {
	now := func(p string) string {
		if uid, ok := uidOf[p]; ok {
			return fmt.Sprintf(", now uid %d", uid)
		}
		return ""
	}
	switch s.Action {
	case store.UndoRestore:
		return fmt.Sprintf("restored %q as uid %d had it%s", s.Path, s.Before, now(s.Path))
	case store.UndoMoveBack:
		return fmt.Sprintf("moved %q back to %q, as uid %d had it%s", s.From, s.Path, s.Before, now(s.Path))
	case store.UndoRemove:
		return fmt.Sprintf("removed %q, which the operation created as uid %d", s.Path, s.After)
	case store.UndoRemoveFolder:
		return fmt.Sprintf("removed the folder %q, which the operation created", s.Path)
	case store.UndoKeepFolder:
		return fmt.Sprintf("kept the folder %q, which the operation created: %s", s.Path, s.Why)
	case store.UndoCopy:
		return fmt.Sprintf("copied uid %d of %q to %q%s", s.Before, s.Path, s.Copy, now(s.Copy))
	case store.UndoNothing:
		return fmt.Sprintf("nothing to copy at %q: %s", s.Path, s.Why)
	}
	return fmt.Sprintf("%s %q", s.Action, s.Path)
}

// actorOf is who made an operation, as the audit and undo print it.
func actorOf(o store.OperationRecord) string {
	switch o.ActorKind {
	case store.ActorOperator:
		return "the operator"
	case store.ActorDevice:
		return fmt.Sprintf("%q (device %s)", o.ActorLabel, o.ActorID)
	}
	return fmt.Sprintf("%q (token %s)", o.ActorLabel, o.ActorID)
}

// undo is the control socket's undo, for the operator: any operation of the
// vault. A refusal is an answer, with what the store found; only a request
// that is not one, or a store that failed, is an error reply.
func (o *operator) undo(req control.Request) control.Reply {
	if !store.ValidOperationID(req.OpID) {
		return control.Refused(control.CodeBadRequest, fmt.Sprintf(
			"%q is not an operation id; `trewd audit` lists them", req.OpID))
	}
	done, err := o.srv.OperatorUndo(o.vault, req.OpID, req.ToCopy)
	u := &control.Undo{Vault: o.vault, Undoes: req.OpID, ToCopy: req.ToCopy}
	if done.Plan.Target.ID != "" {
		if b, merr := json.Marshal(done.Plan.Target); merr == nil {
			u.Target = b
		}
	}
	var oe *store.OpError
	switch {
	case errors.As(err, &oe) && oe.Outcome == store.OpUnknown:
		return control.Refused(control.CodeInternal, "the store could not confirm whether the undo committed: "+
			"`trewd audit -since 1h` says whether an undo of "+req.OpID+" is there; asking again is safe, "+
			"because an undo that did commit is refused as already undone")
	case errors.As(err, &oe) && (oe.Outcome == store.OpFailed || oe.Code == store.OpCodeInternal):
		return control.Refused(control.CodeInternal, "the undo failed before it committed, and nothing was written: "+
			oe.Error())
	case errors.As(err, &oe):
		u.Code, u.Reason = oe.Code, oe.Err.Error()
		u.Changed, _ = json.Marshal(nonNilList(done.Plan.Changed))
		u.Gone, _ = json.Marshal(nonNilList(done.Plan.Gone))
		return control.Reply{Undo: u}
	case err != nil:
		return control.Refused(control.CodeInternal, err.Error())
	}
	res := done.Result
	u.Committed, u.OpID, u.CommittedAt = true, res.OpID, res.CommittedAt
	u.Steps, _ = json.Marshal(nonNilList(done.Plan.Steps))
	u.Entries, _ = json.Marshal(undoneEntries(done))
	return control.Reply{Undo: u}
}

// undoneEntries are the versions an undo wrote, as the wire's undone reply
// lists them.
func undoneEntries(done server.Undone) []map[string]any {
	out := []map[string]any{}
	for _, e := range done.Result.Entries {
		row := map[string]any{"path": e.Entry.Path, "uid": e.Entry.UID, "previousUid": e.PreviousUID}
		if e.Entry.Prev != "" {
			row["prev"] = e.Entry.Prev
		}
		out = append(out, row)
	}
	return out
}

// nonNilList keeps an empty list an empty JSON array.
func nonNilList[T any](v []T) []T {
	if v == nil {
		return []T{}
	}
	return v
}
