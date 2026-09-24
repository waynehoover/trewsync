package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/waynehoover/trew/internal/store"
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
