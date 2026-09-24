package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/waynehoover/trew/internal/control"
	"github.com/waynehoover/trew/internal/store"
)

// cmdRestore puts the vault back as it was at a uid (PLAN.md M5.5): one
// operation that writes a new version for every path whose head differs from
// what it held then, deletes what was created since, and pins every head it
// displaces, so `trewd undo` of it puts everything back again. History is
// appended to, never rewound, so every device receives the restore as
// ordinary new versions and none of them has to be told anything.
//
// A dry run unless -apply is given: it prints what the restore would do and
// the head it planned at, and `-head` with that number makes the apply refuse
// if anything has been written since, so what is applied is exactly what was
// read. Through the running server's control socket, or the store under the
// exclusive server lock when none is running, as `undo` is.
func cmdRestore(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	toUID := fs.Int64("to-uid", 0, "the uid to put the vault back to; `trewd audit` and a note's history name uids")
	head := fs.Int64("head", 0, "refuse unless the vault is still at this uid, the head a dry run printed")
	apply := fs.Bool("apply", false, "commit the restore; without it, nothing is written")
	asJSON := fs.Bool("json", false, "print the plan, or what was done, or why not, as JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("restore takes no arguments, and was given %q", fs.Args())
	}
	if *toUID <= 0 {
		return errors.New("restore needs -to-uid N, the uid to put the vault back to")
	}
	if *head < 0 {
		return errors.New("-head is a uid, and cannot be negative")
	}

	reply, err := administer(*dataDir, *vault, "restore", control.Request{
		Op: "restore", ToUID: *toUID, Head: *head, Apply: *apply})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	r := reply.Restore
	if r == nil {
		return errors.New("the server answered the restore with nothing")
	}
	if *asJSON {
		b, err := json.MarshalIndent(r, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n", b)
		if r.Code != "" {
			return fmt.Errorf("the restore to uid %d was refused: %s", r.ToUID, r.Code)
		}
		return nil
	}
	return writeRestore(out, r)
}

// writeRestore prints a restore's plan, what it did, or why it was refused.
func writeRestore(out io.Writer, r *control.Restore) error {
	if r.Code != "" {
		var gone []store.GonePath
		_ = json.Unmarshal(r.Gone, &gone)
		fmt.Fprintf(out, "Did not restore vault %q to uid %d: %s: %s\n", r.Vault, r.ToUID, r.Code, r.Reason)
		for _, line := range strings.Split(store.UndoPlan{Gone: gone}.UndoRefusalDetail(), "\n") {
			if line != "" {
				fmt.Fprintf(out, "  %s\n", line)
			}
		}
		fmt.Fprintln(out, "Nothing was written.")
		return fmt.Errorf("the restore to uid %d was refused: %s", r.ToUID, r.Code)
	}
	var steps []store.UndoStep
	if len(r.Steps) > 0 {
		if err := json.Unmarshal(r.Steps, &steps); err != nil {
			return err
		}
	}
	var entries []struct {
		Path string `json:"path"`
		UID  int64  `json:"uid"`
	}
	_ = json.Unmarshal(r.Entries, &entries)
	uidOf := map[string]int64{}
	for _, e := range entries {
		uidOf[e.Path] = e.UID
	}

	writes := 0
	for _, s := range steps {
		if s.Action != store.UndoKeepFolder {
			writes++
		}
	}
	switch {
	case writes == 0:
		fmt.Fprintf(out, "Vault %q already holds what it held at uid %d", r.Vault, r.ToUID)
		if r.Unchanged > 0 {
			fmt.Fprintf(out, " (%d paths changed since and changed back)", r.Unchanged)
		}
		fmt.Fprintln(out, ". Nothing to restore, and nothing was written.")
		return nil
	case r.Applied:
		fmt.Fprintf(out, "Restored vault %q to uid %d, as operation %s at %s:\n", r.Vault, r.ToUID, r.OpID, stamp(r.CommittedAt))
	default:
		fmt.Fprintf(out, "A restore of vault %q to uid %d, planned at uid %d, would:\n", r.Vault, r.ToUID, r.Head)
	}
	for _, s := range steps {
		fmt.Fprintf(out, "  %s\n", describeRestoreStep(s, uidOf))
	}
	if r.Unchanged > 0 {
		fmt.Fprintf(out, "%d paths changed since uid %d already hold what they held then, and are left alone.\n",
			r.Unchanged, r.ToUID)
	}
	if !r.Applied {
		fmt.Fprintf(out, "Nothing was written. To apply exactly this, and nothing if the vault moves meanwhile:\n"+
			"  trewd restore -to-uid %d -head %d -apply\n", r.ToUID, r.Head)
		return nil
	}
	fmt.Fprintf(out, "Every device receives these versions as it syncs. `trewd undo %s` puts back what this replaced.\n", r.OpID)
	return nil
}

// describeRestoreStep is one step of a restore as a person reads it.
func describeRestoreStep(s store.UndoStep, uidOf map[string]int64) string {
	now := ""
	if uid, ok := uidOf[s.Path]; ok {
		now = fmt.Sprintf(", now uid %d", uid)
	}
	switch s.Action {
	case store.UndoRestore:
		return fmt.Sprintf("put %q back as uid %d had it%s", s.Path, s.Before, now)
	case store.UndoRemove:
		return fmt.Sprintf("remove %q, created since as uid %d%s", s.Path, s.After, now)
	case store.UndoRemoveFolder:
		return fmt.Sprintf("remove the folder %q, created since%s", s.Path, now)
	case store.UndoKeepFolder:
		return fmt.Sprintf("keep the folder %q, created since: %s", s.Path, s.Why)
	}
	return fmt.Sprintf("%s %q", s.Action, s.Path)
}

// restore is the control socket's restore, for the operator. A refusal is an
// answer, with what the store found; only a request that is not one, or a
// store that failed, is an error reply.
func (o *operator) restore(req control.Request) control.Reply {
	if req.ToUID <= 0 || req.Head < 0 {
		return control.Refused(control.CodeBadRequest, "a restore names a uid to go back to, and a head that is a uid")
	}
	done, err := o.srv.OperatorRestore(o.vault, req.ToUID, req.Head, req.Apply)
	r := &control.Restore{Vault: o.vault, ToUID: req.ToUID, Head: done.Plan.Head, Unchanged: done.Plan.Unchanged}
	var oe *store.OpError
	switch {
	case errors.As(err, &oe) && oe.Outcome == store.OpUnknown:
		return control.Refused(control.CodeInternal, "the store could not confirm whether the restore committed: "+
			"`trewd audit -since 1h` says whether it is there; asking again is safe, because a restore that did "+
			"commit moved the vault's head and the next one is planned from there")
	case errors.As(err, &oe) && (oe.Outcome == store.OpFailed || oe.Code == store.OpCodeInternal):
		return control.Refused(control.CodeInternal, "the restore failed before it committed, and nothing was written: "+
			oe.Error())
	case errors.As(err, &oe):
		r.Code, r.Reason = oe.Code, oe.Err.Error()
		r.Gone, _ = json.Marshal(nonNilList(done.Plan.Gone))
		return control.Reply{Restore: r}
	case err != nil:
		return control.Refused(control.CodeInternal, err.Error())
	}
	r.Steps, _ = json.Marshal(nonNilList(done.Plan.Steps))
	if done.Applied {
		res := done.Result
		r.Applied, r.OpID, r.CommittedAt = true, res.OpID, res.CommittedAt
		entries := []map[string]any{}
		for _, e := range res.Entries {
			entries = append(entries, map[string]any{"path": e.Entry.Path, "uid": e.Entry.UID, "previousUid": e.PreviousUID})
		}
		r.Entries, _ = json.Marshal(entries)
	}
	return control.Reply{Restore: r}
}
