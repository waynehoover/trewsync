package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/waynehoover/trewsync/internal/paths"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// Restored is what a restore to a uid planned and, applied, committed.
type Restored struct {
	Plan    store.RestorePlan
	Applied bool
	Result  store.OpResult
}

// restoreResultBytes bounds the reply a restore records. The record is its
// facts; the paths are in op_entries, where the audit reads them.
const restoreResultBytes = 4 << 10

// OperatorRestore plans the restore of the vault to toUID (PLAN.md M5.5) and,
// with apply, commits it as the operator. head, when not zero, is the head a
// dry run was planned at, and a vault that has moved since is refused, so what
// is applied is what was shown. With no server running, `trewd restore` runs
// this against a Server built on the store it opened, under the exclusive
// server lock, so the rules are the same either way.
//
// The plan is made outside every lock; the commit is under the commit lock,
// where CommitOperation checks the vault is still at the head the plan read,
// and what committed is broadcast before the lock is released, so every
// device connected receives it in order, as ordinary new versions.
func (s *Server) OperatorRestore(vaultID string, toUID, head int64, apply bool) (Restored, error) {
	epoch := s.st.Epoch()
	plan, err := s.st.PlanRestore(store.RestoreRequest{Vault: vaultID, ToUID: toUID, Head: head, Now: s.now().UnixMilli()})
	if err != nil || !apply || len(plan.Entries) == 0 {
		return Restored{Plan: plan}, err
	}
	op := plan.Operation()
	op.Vault, op.Epoch = vaultID, epoch
	op.ActorKind, op.ActorID, op.ActorLabel = store.ActorOperator, store.OperatorActorID, store.RestoreLabel
	op.RequestDigest = restoreDigest(toUID, plan.Head)
	op.MaxResult = restoreResultBytes
	op.Render = func(r store.OpResult) ([]byte, error) {
		return json.Marshal(struct {
			Committed   bool   `json:"committed"`
			OpID        string `json:"opId"`
			ToUID       int64  `json:"toUid"`
			Head        int64  `json:"head"`
			CommittedAt int64  `json:"committedAt"`
			Count       int    `json:"count"`
		}{true, r.OpID, toUID, plan.Head, r.CommittedAt, len(r.Entries)})
	}

	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	res, err := s.st.CommitOperation(op)
	s.countOperation(err)
	if err != nil {
		return Restored{Plan: plan}, err
	}
	s.broadcastAs(vaultID, res.Committed(), store.ActorOperator)
	s.log.Info("restore committed", "vault", vaultID, "op", res.OpID, "toUid", toUID, "head", plan.Head,
		"entries", len(res.Entries))
	return Restored{Plan: plan, Applied: true, Result: res}, nil
}

// restoreDigest is the request digest a restore is recorded with: the tool and
// what was asked, as the other operations digest theirs.
func restoreDigest(toUID, head int64) string {
	type arguments struct {
		ToUID int64 `json:"toUid"`
		Head  int64 `json:"head"`
	}
	b, _ := json.Marshal(struct {
		Arguments arguments `json:"arguments"`
		Tool      string    `json:"tool"`
	}{arguments{toUID, head}, store.RestoreTool})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// deviceRestoreMax bounds what one restore from a device writes: a folder, or
// a vault's notes, of ten thousand changed paths. Over it the restore is
// refused whole, never cut short, and a folder at a time goes through; the
// operator's `trewd restore` has the store's own bound.
const deviceRestoreMax = 10_000

// deviceRestore plans the restore of the device's vault, or one folder of it,
// to toUID, leaving settings alone, and with apply commits it as the device,
// as one operation `undo` reverses. head, on an apply, is the head its
// preview answered with, so what is applied is what was shown.
//
// A device's restore is of notes only (RestoreRequest.NotesOnly). Settings
// are applied with a reload, per profile, and a restore that rewound them
// would rewind every device's at once; the operator's restore still can.
func (s *Server) deviceRestore(origin *Session, folder string, toUID, head int64, apply bool) (Restored, error) {
	vaultID := origin.vaultID
	epoch := s.st.Epoch()
	plan, err := s.st.PlanRestore(store.RestoreRequest{Vault: vaultID, ToUID: toUID, Head: head,
		Now: s.now().UnixMilli(), Folder: folder, NotesOnly: true, MaxEntries: deviceRestoreMax, AbovePurgeMark: true})
	if err != nil || !apply || len(plan.Entries) == 0 {
		return Restored{Plan: plan}, err
	}
	op := plan.Operation()
	op.Vault, op.Epoch = vaultID, epoch
	op.ActorKind, op.ActorID, op.ActorHash, op.ActorLabel = store.ActorDevice, origin.deviceID, origin.deviceHash,
		origin.device
	for i := range op.Entries {
		op.Entries[i].Entry.Device = origin.device
	}
	op.RequestDigest = deviceRestoreDigest(folder, toUID, plan.Head)
	op.MaxResult = restoreResultBytes
	op.Render = func(r store.OpResult) ([]byte, error) {
		return json.Marshal(struct {
			Committed   bool   `json:"committed"`
			OpID        string `json:"opId"`
			Folder      string `json:"folder"`
			ToUID       int64  `json:"toUid"`
			Head        int64  `json:"head"`
			CommittedAt int64  `json:"committedAt"`
			Count       int    `json:"count"`
		}{true, r.OpID, folder, toUID, plan.Head, r.CommittedAt, len(r.Entries)})
	}

	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if err := origin.currentCredential(); err != nil {
		return Restored{Plan: plan}, err
	}
	res, err := s.st.CommitOperation(op)
	s.countOperation(err)
	if err != nil {
		return Restored{Plan: plan}, err
	}
	s.broadcastAs(vaultID, res.Committed(), store.ActorDevice)
	s.log.Info("restore committed", "vault", vaultID, "op", res.OpID, "folder", folder, "toUid", toUID,
		"head", plan.Head, "entries", len(res.Entries), "by", store.ActorDevice, "actor", origin.deviceID)
	return Restored{Plan: plan, Applied: true, Result: res}, nil
}

// deviceRestoreDigest is the request digest a device's restore is recorded
// with: the tool and what was asked.
func deviceRestoreDigest(folder string, toUID, head int64) string {
	type arguments struct {
		Folder string `json:"folder"`
		ToUID  int64  `json:"toUid"`
		Head   int64  `json:"head"`
	}
	b, _ := json.Marshal(struct {
		Arguments arguments `json:"arguments"`
		Tool      string    `json:"tool"`
	}{arguments{folder, toUID, head}, store.RestoreTool})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// handleRestore is protocol 5's restore (plan/protocol.md, "Restore"). A
// preview names a time and is answered with the plan; an apply names the
// uid and head that preview answered with, and is answered after the
// broadcast that carries the versions to every device, this one included.
func (s *Session) handleRestore(m wire.In) error {
	if m.Folder != "" {
		if len(m.Folder) > paths.MaxPathBytes {
			return s.reject(wire.CodeBadPath, errors.New("the folder is longer than a path this vault can hold"))
		}
		if r := paths.Check(m.Folder); r != "" {
			return s.reject(wire.CodeBadPath, fmt.Errorf("%s: the folder is not a path this vault can hold", r))
		}
	}
	toUID, head := m.UID, int64(0)
	if m.Apply {
		if m.UID < 1 || m.Head < 1 {
			return s.reject(wire.CodeBadEntry, errors.New("an apply names the uid and the head its preview answered with"))
		}
		head = m.Head
	} else {
		if m.At < 1 {
			return s.reject(wire.CodeBadEntry, errors.New("a preview names a time, in milliseconds"))
		}
		uid, _, err := s.srv.st.UIDAt(s.vaultID, m.At)
		if errors.Is(err, store.ErrBeforeHistory) {
			return s.reject(wire.CodeNoRestore, fmt.Errorf("before_history: %w", err))
		}
		if err != nil {
			s.srv.log.Error("restore", "vault", s.vaultID, "err", err)
			return s.reject(wire.CodeInternal, errors.New("the restore could not be prepared, and nothing was written"))
		}
		toUID = uid
	}
	done, err := s.srv.deviceRestore(s, m.Folder, toUID, head, m.Apply)
	if err != nil {
		return s.restoreRefused(err)
	}
	times, err := s.srv.st.CommitTimes(s.vaultID, toUID, toUID)
	if err != nil {
		s.srv.log.Error("restore", "vault", s.vaultID, "err", err)
	}
	plan := done.Plan
	reply := wire.Restored{Res: "restored", ID: s.reqID, Applied: done.Applied, Folder: m.Folder, ToUID: toUID,
		At: times[toUID], Head: plan.Head, Unchanged: plan.Unchanged, Steps: []store.UndoStep{},
		KeptMovedIn: []string{}, KeptMovedOut: []string{}}
	rows := wire.RestoreRows
	for _, st := range plan.Steps {
		switch st.Action {
		case store.UndoRestore:
			reply.Restore++
		case store.UndoRemove:
			reply.Remove++
		case store.UndoRemoveFolder:
			reply.RemoveFolder++
		}
		if rows > 0 {
			reply.Steps = append(reply.Steps, st)
			rows--
		} else {
			reply.More++
		}
	}
	for _, kept := range []struct {
		from []string
		to   *[]string
	}{{plan.KeptMovedIn, &reply.KeptMovedIn}, {plan.KeptMovedOut, &reply.KeptMovedOut}} {
		for _, p := range kept.from {
			if rows > 0 {
				*kept.to = append(*kept.to, p)
				rows--
			} else {
				reply.More++
			}
		}
	}
	if done.Applied {
		reply.OpID, reply.CommittedAt = done.Result.OpID, done.Result.CommittedAt
	}
	return s.writeJSON(reply)
}

// restoreRefused answers a restore that did not commit, as undoRefused does
// an undo: a vault that moved since the preview is `stale`, and what no retry
// changes is `norestore`, whose message begins with the store's reason.
func (s *Session) restoreRefused(err error) error {
	if errors.Is(err, errSessionRevoked) {
		return s.fatal(wire.CodeAuth, err)
	}
	var oe *store.OpError
	if !errors.As(err, &oe) {
		s.srv.log.Error("restore", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the restore could not be prepared, and nothing was written"))
	}
	msg := oe.Code + ": " + oe.Err.Error()
	switch {
	case oe.Outcome == store.OpUnknown:
		s.srv.log.Error("a restore's outcome is unknown", "vault", s.vaultID, "op", oe.OpID, "err", oe.Err)
		return s.reject(wire.CodeInternal, errors.New("the store could not confirm whether the restore committed; "+
			"the version history of the folder says whether it did"))
	case oe.Outcome == store.OpFailed || oe.Code == store.OpCodeInternal:
		s.srv.log.Error("restore", "vault", s.vaultID, "err", oe)
		return s.reject(wire.CodeInternal, errors.New("the restore failed before it committed, and nothing was written; "+
			"the server's log says why"))
	case oe.Code == store.OpCodeReadOnly:
		return s.fatal(wire.CodeAuth, errSessionRevoked)
	case oe.Code == store.OpCodePlanChanged, oe.Code == store.OpCodeStale:
		return s.reject(wire.CodeStale, errors.New(msg))
	}
	return s.reject(wire.CodeNoRestore, errors.New(msg))
}
