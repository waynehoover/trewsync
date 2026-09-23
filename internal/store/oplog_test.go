package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

/* ---------------------------------------------------------------- *
 * An agent, and the operations it makes
 * ---------------------------------------------------------------- */

// actor is an MCP token as an operation names it, with the raw token kept so
// a test can look for it where it must not be.
type actor struct {
	id, hash, label string
	raw             []byte
}

// writer mints a write-scope token on v1 and returns it as an actor.
func (h *harness) writer(t *testing.T, label string) actor {
	t.Helper()
	tok, err := h.CreateMCPToken("v1", label, ScopeWrite, nil, 1000)
	if err != nil {
		t.Fatalf("minting a token: %v", err)
	}
	return actor{id: tok.ID, hash: MCPTokenHash(tok.Token), label: label, raw: tok.Token}
}

// digestOf is a request digest: the SHA-256 of whatever names the request.
func digestOf(request string) string {
	sum := sha256.Sum256([]byte(request))
	return hex.EncodeToString(sum[:])
}

// renderJSON renders the mutation result plan/mcp-tools.md gives, which is the
// shape the tool layer will send.
func renderJSON(r OpResult) ([]byte, error) {
	type entry struct {
		Path        string `json:"path"`
		UID         int64  `json:"uid"`
		PreviousUID *int64 `json:"previousUid"`
	}
	out := struct {
		Committed bool    `json:"committed"`
		OpID      string  `json:"opId"`
		Entries   []entry `json:"entries"`
		Noop      bool    `json:"noop"`
	}{Committed: true, OpID: r.OpID, Entries: []entry{}, Noop: r.Noop}
	for _, e := range r.Entries {
		ent := entry{Path: e.Entry.Path, UID: e.Entry.UID}
		if e.PreviousUID != 0 && !e.PreviousGone {
			p := e.PreviousUID
			ent.PreviousUID = &p
		}
		out.Entries = append(out.Entries, ent)
	}
	return json.Marshal(out)
}

// op is an operation by a, prepared under the store's epoch.
func (h *harness) op(a actor, request string, entries ...OpEntry) Operation {
	return Operation{
		Vault: "v1", ActorID: a.id, ActorHash: a.hash, ActorLabel: a.label, Tool: "edit_note",
		RequestDigest: digestOf(request), Epoch: h.Epoch(), Entries: entries,
		Render: renderJSON, MaxResult: 1 << 20,
	}
}

// change is an entry writing body at path, prepared against base, with its
// bodies already stored.
func (h *harness) change(t *testing.T, a actor, path string, base int64, body string) OpEntry {
	t.Helper()
	e := h.entryFor(t, path, body)
	e.Device = a.label
	return OpEntry{Entry: e, Base: base}
}

// bytesOf is the exact content of a version, read back by uid.
func (h *harness) bytesOf(t *testing.T, s *Store, uid int64) string {
	t.Helper()
	e, ok, err := s.EntryByUID("v1", uid)
	if err != nil || !ok {
		t.Fatalf("uid %d cannot be read: ok=%v err=%v", uid, ok, err)
	}
	var b bytes.Buffer
	for _, n := range e.Chunks {
		body, err := s.Chunks().Get("v1", n)
		if err != nil {
			t.Fatalf("uid %d chunk %s: %v", uid, n, err)
		}
		b.Write(body)
	}
	return b.String()
}

// footprint is everything an operation can leave behind: the uid counter, the
// versions, and a row in each oplog table.
type footprint struct {
	allocated, versions, ops, paths, pins, keys int64
}

func (h *harness) footprint(t *testing.T) footprint {
	t.Helper()
	var f footprint
	if err := h.db.QueryRow(`SELECT next_uid - 1, (SELECT COUNT(*) FROM entries WHERE vault_id = 'v1'),
	        (SELECT COUNT(*) FROM operations), (SELECT COUNT(*) FROM op_entries),
	        (SELECT COUNT(*) FROM op_pins), (SELECT COUNT(*) FROM op_keys)
	   FROM vaults WHERE vault_id = 'v1'`).Scan(&f.allocated, &f.versions, &f.ops, &f.paths, &f.pins, &f.keys); err != nil {
		t.Fatalf("footprint: %v", err)
	}
	return f
}

// refusedWith asserts err is an operation refused before commit with code, and
// that nothing was written.
func (h *harness) refusedWith(t *testing.T, err error, code string, before footprint) *OpError {
	t.Helper()
	var oe *OpError
	if !errors.As(err, &oe) {
		t.Fatalf("got %v, want an *OpError", err)
	}
	if oe.Code != code || !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v (outcome %s), want %s refused before commit", err, oe.Outcome, code)
	}
	if after := h.footprint(t); after != before {
		t.Fatalf("a refused operation left something behind: before %+v, after %+v", before, after)
	}
	return oe
}

/* ---------------------------------------------------------------- *
 * All or nothing
 * ---------------------------------------------------------------- */

// The whole of a committed operation: every entry, in order and under
// consecutive uids, the audit row with the actor as it was, a path row for
// every path including a move's source, a pin for every version displaced, and
// the reply rendered from the real uids and stored as it was returned.
func TestAnOperationCommitsEveryEntryAndItsRecord(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "Claude on Mac")
	edited := h.file(t, "edited.md", "before the agent")
	moved := h.file(t, "moved.md", "moving along")

	op := h.op(a, "refactor",
		h.change(t, a, "edited.md", edited.UID, "after the agent"),
		h.change(t, a, "new.md", 0, "a brand new note"),
	)
	mv := h.change(t, a, "renamed.md", 0, "moving along")
	mv.Entry.Prev, mv.PrevBase = "moved.md", moved.UID
	op.Entries = append(op.Entries, mv)

	res, err := h.CommitOperation(op)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if res.Replayed || res.Noop || len(res.Entries) != 3 {
		t.Fatalf("result %+v", res)
	}
	for i, e := range res.Entries {
		if want := moved.UID + 1 + int64(i); e.Entry.UID != want {
			t.Fatalf("entry %d committed at uid %d, want %d", i, e.Entry.UID, want)
		}
	}
	if res.Entries[0].PreviousUID != edited.UID || res.Entries[1].PreviousUID != 0 || res.Entries[2].SourceUID != moved.UID {
		t.Fatalf("predecessors %+v", res.Entries)
	}
	if got := h.bytesOf(t, h.Store, res.Entries[0].Entry.UID); got != "after the agent" {
		t.Fatalf("the edit reads %q", got)
	}
	if uid, gone, _ := h.Head("v1", "moved.md"); !gone || uid != res.Entries[2].Entry.UID {
		t.Fatalf("the move's source is at %d gone=%v", uid, gone)
	}

	rec, ok, err := h.LookupOperation("v1", res.OpID)
	if err != nil || !ok {
		t.Fatalf("lookup: ok=%v err=%v", ok, err)
	}
	if rec.ActorID != a.id || rec.ActorLabel != a.label || rec.Tool != "edit_note" || rec.Outcome != "committed" ||
		rec.Epoch != h.Epoch() || rec.RequestDigest != op.RequestDigest || rec.CommittedAt != res.CommittedAt {
		t.Fatalf("recorded %+v", rec)
	}
	if !bytes.Equal(rec.Result, res.Result) {
		t.Fatalf("the recorded reply is %s and the returned one %s", rec.Result, res.Result)
	}
	var reply struct {
		OpID    string `json:"opId"`
		Entries []struct {
			UID int64 `json:"uid"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(res.Result, &reply); err != nil || reply.OpID != res.OpID || reply.Entries[2].UID != res.Entries[2].Entry.UID {
		t.Fatalf("the reply was not rendered from the real uids: %s", res.Result)
	}
	wantPaths := []OperationPath{
		{Role: "write", Path: "edited.md", BeforeUID: &edited.UID, AfterUID: res.Entries[0].Entry.UID},
		{Role: "write", Path: "new.md", AfterUID: res.Entries[1].Entry.UID},
		{Role: "write", Path: "renamed.md", AfterUID: res.Entries[2].Entry.UID},
		{Role: "source", Path: "moved.md", BeforeUID: &moved.UID, AfterUID: res.Entries[2].Entry.UID},
	}
	if len(rec.Paths) != len(wantPaths) || rec.PathsTotal != len(wantPaths) {
		t.Fatalf("recorded paths %+v", rec.Paths)
	}
	for i, p := range rec.Paths {
		w := wantPaths[i]
		if p.Role != w.Role || p.Path != w.Path || p.AfterUID != w.AfterUID || (p.BeforeUID == nil) != (w.BeforeUID == nil) ||
			(p.BeforeUID != nil && *p.BeforeUID != *w.BeforeUID) {
			t.Fatalf("path %d recorded as %+v, want %+v", i, p, w)
		}
	}
	// The two versions the operation displaced, and nothing for the create.
	if len(rec.Pins) != 2 || rec.Pins[0].UID != edited.UID || rec.Pins[1].UID != moved.UID {
		t.Fatalf("pins %+v, want uids %d and %d", rec.Pins, edited.UID, moved.UID)
	}
	if want := res.CommittedAt + DefaultRetention.PinFor.Milliseconds(); rec.Pins[0].ExpiresAt != want {
		t.Fatalf("pinned until %d, want thirty days after the commit (%d)", rec.Pins[0].ExpiresAt, want)
	}
}

// PLAN.md M5's first done-when: one stale slot among several leaves zero
// entries committed for the operation. The first two entries were fine, and
// are not written; the refusal names the path that moved and where it is now,
// which is what the agent reads again from.
func TestOneStaleSlotAmongSeveralCommitsNothing(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	one := h.file(t, "one.md", "one")
	two := h.file(t, "two.md", "two")
	three := h.file(t, "three.md", "three")
	moved := h.file(t, "three.md", "a device got there first")

	op := h.op(a, "batch",
		h.change(t, a, "one.md", one.UID, "one, edited"),
		h.change(t, a, "two.md", two.UID, "two, edited"),
		h.change(t, a, "three.md", three.UID, "three, edited"),
		h.change(t, a, "four.md", 0, "four, created"),
	)
	before := h.footprint(t)
	_, err := h.CommitOperation(op)
	oe := h.refusedWith(t, err, OpCodeStale, before)
	if oe.Path != "three.md" || oe.CurrentUID != moved.UID || !errors.Is(err, ErrStale) {
		t.Fatalf("refused %+v, want three.md at %d", oe, moved.UID)
	}
	for path, want := range map[string]int64{"one.md": one.UID, "two.md": two.UID, "four.md": 0} {
		if uid, _, _ := h.Head("v1", path); uid != want {
			t.Fatalf("%s is at %d, want %d: an entry before or after the stale one committed", path, uid, want)
		}
	}

	// And the same batch against the current head commits whole, from the
	// uid the refusal did not consume.
	op.Entries[2].Base = moved.UID
	res, err := h.CommitOperation(op)
	if err != nil {
		t.Fatalf("the batch against the current head: %v", err)
	}
	if res.Entries[0].Entry.UID != before.allocated+1 {
		t.Fatalf("the retry committed from uid %d, want %d", res.Entries[0].Entry.UID, before.allocated+1)
	}
}

// A create over a live path is `exists`, not `stale`: the agent was told the
// path was free and it is not, which is a different thing to read again for.
func TestACreateOverALivePathIsExists(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	there := h.file(t, "taken.md", "already here")

	before := h.footprint(t)
	_, err := h.CommitOperation(h.op(a, "create", h.change(t, a, "free.md", 0, "fine"), h.change(t, a, "taken.md", 0, "mine now")))
	oe := h.refusedWith(t, err, OpCodeExists, before)
	if oe.Path != "taken.md" || oe.CurrentUID != there.UID || !errors.Is(err, ErrExists) {
		t.Fatalf("refused %+v", oe)
	}

	// A deleted path is free again, and a create over it is a create.
	if _, err := h.AppendEntry("v1", Entry{Path: "taken.md", Deleted: true, MTime: 5}); err != nil {
		t.Fatal(err)
	}
	res, err := h.CommitOperation(h.op(a, "recreate", h.change(t, a, "taken.md", 0, "mine now")))
	if err != nil {
		t.Fatalf("recreating a deleted path: %v", err)
	}
	if !res.Entries[0].PreviousGone {
		t.Fatalf("a create over a deletion does not say so: %+v", res.Entries[0])
	}
}

// Preview-then-apply binds a snapshot head (PLAN.md section 4.3): a device
// writing anywhere in the vault, to a path the operation never names, refuses
// it with plan_changed and the vault's new head.
func TestAChangedSnapshotHeadCommitsNothing(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "linked from elsewhere")
	head, err := h.LatestUID("v1")
	if err != nil {
		t.Fatal(err)
	}
	op := h.op(a, "move with backlinks", h.change(t, a, "note.md", note.UID, "rewritten links"))
	op.SnapshotHead = &head

	moved := h.file(t, "elsewhere.md", "a new backlink the preview never saw")
	before := h.footprint(t)
	_, err = h.CommitOperation(op)
	oe := h.refusedWith(t, err, OpCodePlanChanged, before)
	if oe.CurrentUID != moved.UID || !errors.Is(err, ErrPlanChanged) {
		t.Fatalf("refused %+v, want the vault's head %d", oe, moved.UID)
	}

	op.SnapshotHead = &moved.UID
	if _, err := h.CommitOperation(op); err != nil {
		t.Fatalf("against the current head: %v", err)
	}
}

// PLAN.md section 2.3: scope and credential are checked again at the commit
// boundary, against the credential as it stands then. Each way a token can
// stop being able to write between prepare and commit leaves nothing written.
func TestAnActorThatChangedSincePrepareCommitsNothing(t *testing.T) {
	cases := []struct {
		name   string
		change func(t *testing.T, h *harness, a actor)
	}{
		{"revoked", func(t *testing.T, h *harness, a actor) {
			if err := h.RevokeMCPToken("v1", a.id); err != nil {
				t.Fatal(err)
			}
		}},
		{"downgraded to read", func(t *testing.T, h *harness, a actor) {
			if err := h.ExecForTest(`UPDATE mcp_tokens SET scope = 'read' WHERE id = ?`, a.id); err != nil {
				t.Fatal(err)
			}
		}},
		{"expired", func(t *testing.T, h *harness, a actor) {
			at := time.Now().Add(time.Minute).UnixMilli()
			if err := h.ExecForTest(`UPDATE mcp_tokens SET expires_at = ? WHERE id = ?`, at, a.id); err != nil {
				t.Fatal(err)
			}
			h.SetClock(func() time.Time { return time.UnixMilli(at) })
		}},
		{"a different token under the same id", func(t *testing.T, h *harness, a actor) {
			if err := h.ExecForTest(`UPDATE mcp_tokens SET token_hash = ? WHERE id = ?`, digestOf("another"), a.id); err != nil {
				t.Fatal(err)
			}
		}},
		{"relabelled", func(t *testing.T, h *harness, a actor) {
			if err := h.ExecForTest(`UPDATE authors SET name = 'someone else' WHERE id = ?`, a.id); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newTestStore(t)
			a := h.writer(t, "agent")
			note := h.file(t, "note.md", "the note")
			op := h.op(a, "edit", h.change(t, a, "note.md", note.UID, "an edit"), h.change(t, a, "b.md", 0, "b"))
			c.change(t, h, a)
			before := h.footprint(t)
			_, err := h.CommitOperation(op)
			h.refusedWith(t, err, OpCodeReadOnly, before)
			if !errors.Is(err, ErrActorCannotWrite) {
				t.Fatalf("refused, but not as the actor: %v", err)
			}
		})
	}
}

// A request prepared in one epoch is not committed in another: its uids were
// read from a history a restore may have replaced (PLAN.md section 2.8).
func TestAWrongEpochCommitsNothing(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "the note")
	op := h.op(a, "edit", h.change(t, a, "note.md", note.UID, "an edit"))
	op.Epoch = "an-epoch-this-store-never-had"
	before := h.footprint(t)
	_, err := h.CommitOperation(op)
	h.refusedWith(t, err, OpCodeStale, before)
	if !errors.Is(err, ErrEpochChanged) {
		t.Fatalf("refused, but not for the epoch: %v", err)
	}
}

// The collision rule meets an operation's entries as it meets a device
// batch's, and an operation refuses all of them for one that collides.
func TestACollisionCommitsNothing(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	h.file(t, "Notes/Plan.md", "a note in a folder")

	before := h.footprint(t)
	_, err := h.CommitOperation(h.op(a, "two creates",
		h.change(t, a, "fine.md", 0, "no collision here"),
		h.change(t, a, "notes/other.md", 0, "a folder spelled another way"),
	))
	oe := h.refusedWith(t, err, OpCodeCollision, before)
	if oe.Path != "notes/other.md" || !errors.Is(err, ErrCollision) {
		t.Fatalf("refused %+v", oe)
	}

	// And a batch is checked against the state its earlier entries left: the
	// second create collides with the first, not with anything stored.
	_, err = h.CommitOperation(h.op(a, "two spellings",
		h.change(t, a, "Twice.md", 0, "one"),
		h.change(t, a, "twice.md", 0, "two"),
	))
	h.refusedWith(t, err, OpCodeCollision, before)
}

// Rule 1, the other way round: an operation whose storage fails at any step of
// its transaction, after any number of rows are written, leaves none of them.
// And the failure is not a refusal: nothing was wrong with the request, and
// the same request commits once the store works, from the same uid.
func TestAStorageErrorAnywhereInTheOperationCommitsNothing(t *testing.T) {
	steps := []string{"entry 0", "entry 1", "operation", "op_entries", "pins", "keys"}
	for _, step := range steps {
		t.Run(step, func(t *testing.T) {
			h := newTestStore(t)
			a := h.writer(t, "agent")
			note := h.file(t, "note.md", "the note")
			op := h.op(a, "edit", h.change(t, a, "note.md", note.UID, "edited"), h.change(t, a, "new.md", 0, "new"))
			op.IdempotencyKey = "k-" + step
			boom := errors.New("disk I/O error (injected)")
			h.duringOperation = func(s string) error {
				if s == step {
					return boom
				}
				return nil
			}
			before := h.footprint(t)
			_, err := h.CommitOperation(op)
			var oe *OpError
			if !errors.As(err, &oe) || oe.Outcome != OpFailed || oe.Code != OpCodeInternal || !errors.Is(err, boom) {
				t.Fatalf("got %v, want a failure before commit carrying the injected error", err)
			}
			if errors.Is(err, ErrRefused) || errors.Is(err, ErrOutcomeUnknown) {
				t.Fatalf("a failure before COMMIT was reported as %s", oe.Outcome)
			}
			if after := h.footprint(t); after != before {
				t.Fatalf("a failed operation left something: before %+v, after %+v", before, after)
			}
			if _, ok, _ := h.LookupOperation("v1", oe.OpID); ok {
				t.Fatal("the failed operation can be looked up")
			}

			h.duringOperation = nil
			res, err := h.CommitOperation(op)
			if err != nil {
				t.Fatalf("the same operation on a working store: %v", err)
			}
			if res.Entries[0].Entry.UID != before.allocated+1 {
				t.Fatalf("committed from uid %d after the failure, want %d", res.Entries[0].Entry.UID, before.allocated+1)
			}
		})
	}
}

// A COMMIT that fails is the one error whose outcome is not known, and it says
// so, with the operation's id to find out by. Here the commit did not happen,
// and the lookup is what says so.
func TestAFailedCommitIsAnUnknownOutcomeWithAnIDToAsk(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "the note")
	h.failOperationCommit = errors.New("fsync failed (injected)")
	_, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", note.UID, "edited")))
	var oe *OpError
	if !errors.As(err, &oe) || oe.Outcome != OpUnknown || !errors.Is(err, ErrOutcomeUnknown) || errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want an unknown outcome", err)
	}
	if !ValidOperationID(oe.OpID) {
		t.Fatalf("the unknown outcome carries no id to ask about: %q", oe.OpID)
	}
	if _, ok, err := h.LookupOperation("v1", oe.OpID); err != nil || ok {
		t.Fatalf("lookup of a commit that did not happen: ok=%v err=%v", ok, err)
	}
}

// A reply too large to send is refused before anything is written, both when
// it is too large at its widest and when only the real rendering is: the
// second check is what makes the first an optimisation rather than the proof.
func TestAReplyTooLargeIsRefusedBeforeAnythingIsWritten(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "the note")

	op := h.op(a, "edit", h.change(t, a, "note.md", note.UID, "edited"))
	op.MaxResult = 16
	before := h.footprint(t)
	_, err := h.CommitOperation(op)
	h.refusedWith(t, err, OpCodeResultTooLarge, before)

	// A render that is small at its widest and large for real.
	op.MaxResult = 1024
	op.Render = func(r OpResult) ([]byte, error) {
		if r.CommittedAt == MaxUID {
			return []byte("{}"), nil
		}
		return bytes.Repeat([]byte("x"), 2048), nil
	}
	_, err = h.CommitOperation(op)
	h.refusedWith(t, err, OpCodeResultTooLarge, before)
	if !errors.Is(err, ErrResultTooLarge) {
		t.Fatalf("refused, but not for the size: %v", err)
	}
}

// A noop writes nothing and still revalidates at the boundary (PLAN.md
// section 4.3): identical bytes decided against a head that has moved since
// are not sound, and neither is a noop from a token revoked since.
func TestANoopRechecksItsPreconditions(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "identical")

	noop := h.op(a, "identical edit")
	noop.Checks = []OpCheck{{Path: "note.md", Base: note.UID}}
	res, err := h.CommitOperation(noop)
	if err != nil {
		t.Fatalf("noop: %v", err)
	}
	if !res.Noop || len(res.Entries) != 0 {
		t.Fatalf("result %+v", res)
	}
	rec, ok, err := h.LookupOperation("v1", res.OpID)
	if err != nil || !ok || rec.Outcome != "noop" || len(rec.Paths) != 0 || len(rec.Pins) != 0 {
		t.Fatalf("recorded %+v ok=%v err=%v", rec, ok, err)
	}
	if latest, _ := h.LatestUID("v1"); latest != note.UID {
		t.Fatalf("a noop wrote a version: latest %d", latest)
	}

	moved := h.file(t, "note.md", "a device changed it meanwhile")
	before := h.footprint(t)
	_, err = h.CommitOperation(noop)
	oe := h.refusedWith(t, err, OpCodeStale, before)
	if oe.Path != "note.md" || oe.CurrentUID != moved.UID {
		t.Fatalf("refused %+v", oe)
	}

	noop.Checks[0].Base = moved.UID
	if err := h.RevokeMCPToken("v1", a.id); err != nil {
		t.Fatal(err)
	}
	_, err = h.CommitOperation(noop)
	h.refusedWith(t, err, OpCodeReadOnly, before)
}

// What an operation is refused for before it reaches the lock: two writes to
// one path, a path the policy refuses, a body that is not stored, and an entry
// recorded under a name that is not its actor's.
func TestAnOperationIsValidatedBeforeTheLock(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "a note")
	before := h.footprint(t)

	_, err := h.CommitOperation(h.op(a, "twice", h.change(t, a, "a.md", 0, "one"), h.change(t, a, "a.md", 0, "two")))
	h.refusedWith(t, err, OpCodeDuplicatePath, before)

	mv := h.change(t, a, "b.md", 0, "moved")
	mv.Entry.Prev, mv.PrevBase = "note.md", note.UID
	_, err = h.CommitOperation(h.op(a, "move and edit the source", mv, h.change(t, a, "note.md", note.UID, "edited")))
	h.refusedWith(t, err, OpCodeDuplicatePath, before)

	_, err = h.CommitOperation(h.op(a, "dot", h.change(t, a, ".obsidian/app.json", 0, "{}")))
	if oe := h.refusedWith(t, err, OpCodeBadPath, before); oe.Path != ".obsidian/app.json" || !errors.Is(err, ErrBadPath) {
		t.Fatalf("refused %+v", oe)
	}

	missing := OpEntry{Entry: Entry{Path: "c.md", Size: 5, Device: a.label, Chunks: []string{digestOf("never stored")}}}
	_, err = h.CommitOperation(h.op(a, "missing body", missing))
	h.refusedWith(t, err, OpCodeInternal, before)
	if !errors.Is(err, ErrChunkMissing) {
		t.Fatalf("refused, but not for the body: %v", err)
	}

	other := h.change(t, a, "d.md", 0, "d")
	other.Entry.Device = "somebody else"
	_, err = h.CommitOperation(h.op(a, "wrong name", other))
	h.refusedWith(t, err, OpCodeInternal, before)
}

// The device path keeps its partial semantics beside all of this: the test
// that holds it is TestAppendManyRefusesOneEntryAndCommitsTheRest, unchanged.
// This one holds the other half, that a device's batch committed beside an
// operation records nothing in the oplog.
func TestADeviceBatchIsNotAnOperation(t *testing.T) {
	h := newTestStore(t)
	before := h.footprint(t)
	out, err := h.AppendMany("v1", []Entry{h.entryFor(t, "a.md", "a"), h.entryFor(t, "b.md", "b")}, []int64{0, 0}, []int64{0, 0})
	if err != nil || out[0].Err != nil || out[1].Err != nil {
		t.Fatalf("device batch: %+v %v", out, err)
	}
	after := h.footprint(t)
	if after.ops != before.ops || after.pins != before.pins || after.versions != before.versions+2 {
		t.Fatalf("before %+v after %+v", before, after)
	}
}

/* ---------------------------------------------------------------- *
 * Idempotency
 * ---------------------------------------------------------------- */

// PLAN.md section 4.8: a replay of the same key and request returns the
// recorded reply, byte for byte, and writes nothing. Asked before the
// request is prepared again (Replay) and inside the commit (CommitOperation),
// which is the retry that races its original.
func TestAReplayReturnsTheRecordedReplyAndWritesNothing(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "the note")
	op := h.op(a, "append", h.change(t, a, "note.md", note.UID, "the note, appended"))
	op.IdempotencyKey = "retry-me"
	first, err := h.CommitOperation(op)
	if err != nil {
		t.Fatal(err)
	}
	after := h.footprint(t)

	got, found, err := h.Replay("v1", a.id, "retry-me", op.RequestDigest)
	if err != nil || !found || !got.Replayed || got.OpID != first.OpID || !bytes.Equal(got.Result, first.Result) {
		t.Fatalf("Replay: %+v found=%v err=%v", got, found, err)
	}

	// The retry prepared again: its base is the note as the first attempt
	// left it, and it would append a second time. The key answers it.
	again := h.op(a, "append", h.change(t, a, "note.md", first.Entries[0].Entry.UID, "the note, appended, appended"))
	again.IdempotencyKey = "retry-me"
	replayed, err := h.CommitOperation(again)
	if err != nil || !replayed.Replayed || !bytes.Equal(replayed.Result, first.Result) || len(replayed.Entries) != 0 {
		t.Fatalf("the retry: %+v err=%v", replayed, err)
	}
	if now := h.footprint(t); now != after {
		t.Fatalf("a replay wrote something: %+v then %+v", after, now)
	}
	if got := h.bytesOf(t, h.Store, first.Entries[0].Entry.UID); got != "the note, appended" {
		t.Fatalf("the note reads %q", got)
	}
}

// The same key for a different request is refused, both ways it can be asked.
func TestTheSameKeyForADifferentRequestIsRefused(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	op := h.op(a, "create one", h.change(t, a, "one.md", 0, "one"))
	op.IdempotencyKey = "k"
	if _, err := h.CommitOperation(op); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.Replay("v1", a.id, "k", digestOf("create two")); !errors.Is(err, ErrKeyReused) || !errors.Is(err, ErrRefused) {
		t.Fatalf("Replay with another request: %v", err)
	}
	other := h.op(a, "create two", h.change(t, a, "two.md", 0, "two"))
	other.IdempotencyKey = "k"
	before := h.footprint(t)
	_, err := h.CommitOperation(other)
	h.refusedWith(t, err, OpCodeKeyReused, before)
}

// A key is the actor's: another token using the same string is another key.
func TestAKeyBelongsToItsActor(t *testing.T) {
	h := newTestStore(t)
	a, b := h.writer(t, "first"), h.writer(t, "second")
	one := h.op(a, "same words", h.change(t, a, "a.md", 0, "a"))
	one.IdempotencyKey = "shared"
	two := h.op(b, "same words", h.change(t, b, "b.md", 0, "b"))
	two.IdempotencyKey = "shared"
	if _, err := h.CommitOperation(one); err != nil {
		t.Fatal(err)
	}
	res, err := h.CommitOperation(two)
	if err != nil || res.Replayed || len(res.Entries) != 1 {
		t.Fatalf("the second actor's key was answered from the first's: %+v %v", res, err)
	}
}

// Eight retries of one request racing each other commit it once; the other
// seven are answered with its reply.
func TestConcurrentRetriesOfOneRequestCommitItOnce(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	var wg sync.WaitGroup
	results := make([]OpResult, 8)
	errs := make([]error, 8)
	for i := range results {
		op := h.op(a, "create", h.change(t, a, "once.md", 0, "created once"))
		op.IdempotencyKey = "one-request"
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = h.CommitOperation(op)
		}(i)
	}
	wg.Wait()
	committed := 0
	for i, r := range results {
		if errs[i] != nil {
			t.Fatalf("retry %d: %v", i, errs[i])
		}
		if !r.Replayed {
			committed++
		}
		if !bytes.Equal(r.Result, results[0].Result) {
			t.Fatalf("retry %d answered %s and retry 0 %s", i, r.Result, results[0].Result)
		}
	}
	if committed != 1 {
		t.Fatalf("%d of the retries committed", committed)
	}
	if f := h.footprint(t); f.ops != 1 || f.versions != 1 {
		t.Fatalf("footprint %+v", f)
	}
}

// After its window, a key replays nothing: the request is new, and its bases
// are checked like any other's. An append retried after the key has gone
// meets the head its first commit made, and is refused rather than applied a
// second time.
func TestAnExpiredKeyNoLongerReplays(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	t0 := time.Now()
	clock := t0
	h.SetClock(func() time.Time { return clock })
	note := h.file(t, "note.md", "the note")
	op := h.op(a, "append", h.change(t, a, "note.md", note.UID, "the note, appended"))
	op.IdempotencyKey = "k"
	first, err := h.CommitOperation(op)
	if err != nil {
		t.Fatal(err)
	}

	clock = t0.Add(DefaultRetention.ResultFor + time.Minute)
	if _, found, err := h.Replay("v1", a.id, "k", op.RequestDigest); err != nil || found {
		t.Fatalf("an expired key replayed: found=%v err=%v", found, err)
	}
	before := h.footprint(t)
	_, err = h.CommitOperation(op)
	oe := h.refusedWith(t, err, OpCodeStale, before)
	if oe.CurrentUID != first.Entries[0].Entry.UID {
		t.Fatalf("refused %+v", oe)
	}
	// The operation is still on record, without its reply.
	rec, ok, err := h.LookupOperation("v1", first.OpID)
	if err != nil || !ok || rec.Result != nil {
		t.Fatalf("lookup after the window: %+v ok=%v err=%v", rec, ok, err)
	}
	// And the key's name is free for a new request.
	fresh := h.op(a, "a new request", h.change(t, a, "other.md", 0, "other"))
	fresh.IdempotencyKey = "k"
	if res, err := h.CommitOperation(fresh); err != nil || res.Replayed {
		t.Fatalf("reusing an expired key: %+v %v", res, err)
	}
}

/* ---------------------------------------------------------------- *
 * The audit
 * ---------------------------------------------------------------- */

// PLAN.md M5 task 2: the audit lists operations since a time, and revoking the
// actor erases none of it. What it never holds is also checked: every column
// of every oplog table is searched for the bearer token, in both its forms,
// its hash, and the bodies the operations wrote.
func TestTheAuditOutlivesItsActorAndHoldsNoSecretOrBody(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "Claude on Mac")
	t0 := time.Now()
	clock := t0
	h.SetClock(func() time.Time { return clock })

	var ids []string
	var bodies []string
	for i := 0; i < 3; i++ {
		body := fmt.Sprintf("secret-looking body number %d", i)
		bodies = append(bodies, body)
		op := h.op(a, fmt.Sprintf("create %d", i), h.change(t, a, fmt.Sprintf("n%d.md", i), 0, body))
		op.IdempotencyKey = fmt.Sprintf("key-%d", i)
		op.ClientName, op.ClientVersion = "claude-code\n\x1b[31m", "1.0"
		res, err := h.CommitOperation(op)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, res.OpID)
		clock = clock.Add(time.Hour)
	}
	if err := h.RevokeMCPToken("v1", a.id); err != nil {
		t.Fatal(err)
	}

	all, more, err := h.Operations("v1", 0, 0, 0)
	if err != nil || more || len(all) != 3 {
		t.Fatalf("listed %d more=%v err=%v", len(all), more, err)
	}
	for i, o := range all {
		if o.ID != ids[i] || o.ActorID != a.id || o.ActorLabel != "Claude on Mac" || o.ActorKind != AuthorKindMCP {
			t.Fatalf("operation %d listed as %+v", i, o)
		}
		if o.ClientName != "claude-code[31m" {
			t.Fatalf("the client name was stored as %q", o.ClientName)
		}
		if o.Result != nil {
			t.Fatal("a listing carries replies")
		}
	}
	since, _, err := h.Operations("v1", t0.Add(90*time.Minute).UnixMilli(), 0, 0)
	if err != nil || len(since) != 1 || since[0].ID != ids[2] {
		t.Fatalf("since: %+v %v", since, err)
	}
	page, more, err := h.Operations("v1", 0, 0, 2)
	if err != nil || !more || len(page) != 2 {
		t.Fatalf("first page: %d more=%v err=%v", len(page), more, err)
	}
	rest, more, err := h.Operations("v1", 0, page[1].Seq, 2)
	if err != nil || more || len(rest) != 1 || rest[0].ID != ids[2] {
		t.Fatalf("second page: %+v more=%v err=%v", rest, more, err)
	}

	needles := []string{EncodeToken(a.raw), string(a.raw), a.hash}
	needles = append(needles, bodies...)
	for _, table := range []string{"operations", "op_entries", "op_pins", "op_keys"} {
		rows, err := h.db.Query(`SELECT * FROM ` + table)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			for i, v := range vals {
				text := fmt.Sprint(v)
				if b, ok := v.([]byte); ok {
					text = string(b)
				}
				for _, n := range needles {
					if strings.Contains(text, n) {
						t.Fatalf("%s.%s holds %q", table, cols[i], n)
					}
				}
			}
		}
		rows.Close()
	}
}

// committed_at is the server's clock and never goes backwards (PLAN.md
// section 4.11): a clock stepped back an hour cannot make a pin expire before
// one made before it.
func TestCommitTimeNeverGoesBackwards(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	t0 := time.Now()
	clock := t0
	h.SetClock(func() time.Time { return clock })
	first, err := h.CommitOperation(h.op(a, "one", h.change(t, a, "a.md", 0, "a")))
	if err != nil {
		t.Fatal(err)
	}
	clock = t0.Add(-time.Hour)
	second, err := h.CommitOperation(h.op(a, "two", h.change(t, a, "b.md", 0, "b")))
	if err != nil {
		t.Fatal(err)
	}
	if first.CommittedAt != t0.UnixMilli() || second.CommittedAt != first.CommittedAt {
		t.Fatalf("committed at %d then %d, with the clock at %d then an hour earlier",
			first.CommittedAt, second.CommittedAt, t0.UnixMilli())
	}
}

// The retention floors, and that SetRetention governs only what commits after
// it.
func TestRetentionHasFloorsAndAppliesToNewOperations(t *testing.T) {
	h := newTestStore(t)
	if err := h.SetRetention(Retention{PinFor: 29 * 24 * time.Hour, ResultFor: time.Hour}); err == nil {
		t.Fatal("a pin shorter than thirty days was accepted")
	}
	if err := h.SetRetention(Retention{PinFor: MinPinRetention, ResultFor: time.Minute}); err == nil {
		t.Fatal("a reply kept a minute was accepted")
	}
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "before")
	if err := h.SetRetention(Retention{PinFor: 90 * 24 * time.Hour, ResultFor: 2 * time.Hour}); err != nil {
		t.Fatal(err)
	}
	op := h.op(a, "edit", h.change(t, a, "note.md", note.UID, "after"))
	op.IdempotencyKey = "k"
	res, err := h.CommitOperation(op)
	if err != nil {
		t.Fatal(err)
	}
	rec, _, _ := h.LookupOperation("v1", res.OpID)
	if rec.Pins[0].ExpiresAt != res.CommittedAt+(90*24*time.Hour).Milliseconds() ||
		rec.ResultExpiresAt != res.CommittedAt+(2*time.Hour).Milliseconds() {
		t.Fatalf("recorded %+v", rec)
	}
}
