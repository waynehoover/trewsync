package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// Undo for the two actors that are not agents (PLAN.md section 4.5, M5 task
// 7): the operator, through `trewd undo`, and a device, through the plugin's
// history panel over protocol 2's `undo`. An agent's undo is the MCP tool
// undo_operation, which commits through the same store calls from its own
// commit boundary (internal/mcp).
//
// Who may undo what. The operator may undo any operation of the vault, being
// whoever can already read the database. A device may too: an agent's, the
// operator's undo, another device's undo. The vault is one person's, and a
// device could write the same bytes back by hand; what an undo adds is doing
// it as one operation, only against the heads the operation left, and saying
// so in the log. An agent may undo only its own operations, so a note that
// talks one agent into undoing another's work, or a person's undo, has no
// tool to do it with (plan/mcp-tools.md, undo_operation).

// Undone is what an undo did: the plan it committed, with what each step did,
// and what committed.
type Undone struct {
	Plan   store.UndoPlan
	Result store.OpResult
}

// undoResultBytes bounds the reply an operator's or a device's undo records.
// The record is its facts, not its paths: the caller is answered from the
// plan and the result, and the audit reads the paths from op_entries.
const undoResultBytes = 4 << 10

// OperatorUndo undoes an operation as the operator. With no server running,
// `trewd undo` runs it against a Server built on the store it opened, under
// the exclusive server lock, so the rules are the same either way.
func (s *Server) OperatorUndo(vaultID, opID string, toCopy bool) (Undone, error) {
	return s.undo(vaultID, opID, toCopy, nil)
}

// undo plans the undo outside every lock, then commits it under the commit
// lock, rechecking a device's credential there as every device mutation does,
// and broadcasts what committed before the lock is released, so a device
// connected now receives it in order with every other commit. origin is the
// device session asking, or nil for the operator.
func (s *Server) undo(vaultID, opID string, toCopy bool, origin *Session) (Undone, error) {
	kind, id, hash, label := store.ActorOperator, store.OperatorActorID, "", store.OperatorLabel
	if origin != nil {
		kind, id, hash, label = store.ActorDevice, origin.deviceID, origin.deviceHash, origin.device
	}
	epoch := s.st.Epoch()
	plan, err := s.st.PlanUndo(store.UndoRequest{
		Vault: vaultID, OpID: opID, ToCopy: toCopy, Label: label, Now: s.now().UnixMilli(),
	})
	if err != nil {
		return Undone{Plan: plan}, err
	}
	op := plan.Operation()
	op.Vault, op.Epoch = vaultID, epoch
	op.ActorKind, op.ActorID, op.ActorHash, op.ActorLabel = kind, id, hash, label
	op.RequestDigest = undoDigest(opID, toCopy)
	op.MaxResult = undoResultBytes
	op.Render = func(r store.OpResult) ([]byte, error) {
		return json.Marshal(struct {
			Committed   bool   `json:"committed"`
			OpID        string `json:"opId"`
			Undoes      string `json:"undoes"`
			ToCopy      bool   `json:"toCopy"`
			CommittedAt int64  `json:"committedAt"`
			Count       int    `json:"count"`
		}{true, r.OpID, opID, toCopy, r.CommittedAt, len(r.Entries)})
	}

	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if origin != nil {
		if err := origin.currentCredential(); err != nil {
			return Undone{Plan: plan}, err
		}
	}
	res, err := s.st.CommitOperation(op)
	s.countOperation(err)
	if err != nil {
		return Undone{Plan: plan}, err
	}
	s.broadcastAs(vaultID, res.Committed(), kind)
	s.log.Info("undo committed", "vault", vaultID, "op", res.OpID, "undoes", opID, "toCopy", toCopy,
		"entries", len(res.Entries), "by", kind, "actor", id)
	return Undone{Plan: plan, Result: res}, nil
}

// undoDigest is the request digest an undo is recorded with: what was asked,
// as the MCP tools digest their requests, the tool and its arguments.
func undoDigest(opID string, toCopy bool) string {
	type arguments struct {
		OpID   string `json:"opId"`
		ToCopy bool   `json:"toCopy"`
	}
	b, _ := json.Marshal(struct {
		Arguments arguments `json:"arguments"`
		Tool      string    `json:"tool"`
	}{arguments{opID, toCopy}, store.UndoTool})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// handleUndo is protocol 2's undo, for this device (plan/protocol.md, "Undo").
// The reply is `undone` with what each step did, sent after the broadcast
// that carries the versions to every device, this one included: the undo was
// written by the server, so unlike a put's echo this device has not got them.
func (s *Session) handleUndo(m wire.In) error {
	if !store.ValidOperationID(m.OpID) {
		return s.reject(wire.CodeBadEntry, fmt.Errorf("%q is not an operation id: a history entry's op names one", m.OpID))
	}
	done, err := s.srv.undo(s.vaultID, m.OpID, m.ToCopy, s)
	if err != nil {
		return s.undoRefused(err, done.Plan)
	}
	res := done.Result
	reply := wire.Undone{Res: "undone", ID: s.reqID, OpID: res.OpID, Undoes: m.OpID, ToCopy: m.ToCopy,
		CommittedAt: res.CommittedAt, Steps: done.Plan.Steps, Entries: make([]wire.UndoneEntry, 0, len(res.Entries))}
	if reply.Steps == nil {
		reply.Steps = []store.UndoStep{}
	}
	for _, e := range res.Entries {
		reply.Entries = append(reply.Entries, wire.UndoneEntry{
			Path: e.Entry.Path, UID: e.Entry.UID, PreviousUID: e.PreviousUID, Prev: e.Entry.Prev})
	}
	return s.writeJSON(reply)
}

// undoRefused answers an undo that did not commit. A note changed since is
// `stale`, which the panel answers by offering the copy; everything else an
// undo can meet that no retry changes is `noundo`, with the store's reason and
// the paths it is about; a revoked device is told so and the session ends.
func (s *Session) undoRefused(err error, plan store.UndoPlan) error {
	if errors.Is(err, errSessionRevoked) {
		return s.fatal(wire.CodeAuth, err)
	}
	var oe *store.OpError
	if !errors.As(err, &oe) {
		s.srv.log.Error("undo", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the undo could not be prepared, and nothing was written"))
	}
	msg := oe.Code + ": " + oe.Err.Error()
	if detail := plan.UndoRefusalDetail(); detail != "" {
		msg += ". " + strings.ReplaceAll(detail, "\n", "; ")
	}
	switch {
	case oe.Outcome == store.OpUnknown:
		s.srv.log.Error("an undo's outcome is unknown", "vault", s.vaultID, "op", oe.OpID, "err", oe.Err)
		return s.reject(wire.CodeInternal, errors.New("the store could not confirm whether the undo committed. "+
			"Ask again: an undo that did commit is refused as already undone, naming the undo that did it"))
	case oe.Outcome == store.OpFailed || oe.Code == store.OpCodeInternal:
		s.srv.log.Error("undo", "vault", s.vaultID, "err", oe)
		return s.reject(wire.CodeInternal, errors.New("the undo failed before it committed, and nothing was written; "+
			"the server's log says why"))
	case oe.Code == store.OpCodeReadOnly:
		return s.fatal(wire.CodeAuth, errSessionRevoked)
	case oe.Code == store.OpCodeStale:
		return s.reject(wire.CodeStale, errors.New(msg))
	case oe.Code == store.OpCodeCollision:
		return s.reject(wire.CodeCollision, errors.New(msg))
	}
	return s.reject(wire.CodeNoUndo, errors.New(msg))
}

// broadcastAs is Broadcast with the kind of author the log line names.
func (s *Server) broadcastAs(vaultID string, entries []store.Entry, author string) {
	for _, e := range entries {
		s.log.Info("committed", "vault", vaultID, "uid", e.UID,
			"size", e.Size, "chunks", len(e.Chunks),
			"folder", e.Folder, "deleted", e.Deleted, "author", author)
		s.hub.broadcast(vaultID, e, nil)
	}
}
