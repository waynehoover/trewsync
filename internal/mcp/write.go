package mcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/store"
)

// An MCP write is a durable operation (PLAN.md section 4.3), and this file is
// the part every write tool shares: the request's digest and idempotency key,
// the epoch its uids belong to, storing the bodies, the one commit through the
// boundary, and the result, which is rendered before the commit and recorded
// with it.
//
// The sequence, for every tool:
//
//  1. The arguments are read strictly, and the credential was checked at
//     dispatch.
//  2. begin: the epoch the agent read under is the store's (else stale), and
//     an idempotency key already used for this request answers with its
//     recorded reply, before anything is prepared (store.Replay): preparing a
//     retry again would read the heads its first attempt moved.
//  3. The tool reads the heads, computes the bytes, and stores their chunks
//     through one chunks.Writer, durable before anything names them (rule 1).
//  4. submit: under the commit lock, the credential again (call.commit), then
//     CommitOperation, which rechecks it, the epoch, the key, a preview's
//     snapshot head and every base in one transaction; then the broadcast,
//     still under the lock; then the reply that transaction recorded.
//
// A refusal before the commit writes nothing and says so (committed: false).
// An outcome the store cannot state is never reported as a refusal: it is
// committed "unknown", with the operation's id and key and what to do.

// The seams of a write, for Config.Seam: where the crash matrix (PLAN.md M5
// task 9) kills the server, and what each one leaves behind.
const (
	// SeamUploading is in the middle of storing the bodies of a write that
	// has more than one: the first is durable and the rest are not yet
	// written. A kill here leaves some of the operation's chunks and not the
	// others, named by nothing, which purge reclaims.
	SeamUploading = "uploading"
	// SeamBodies is after the bodies are durable and before the commit lock:
	// a kill here leaves chunks nothing names, which purge reclaims.
	SeamBodies = "bodies"
	// SeamCommitted is inside the commit lock, after the operation committed
	// and before the broadcast: the entries are durable and no device has
	// been told, which catch-up covers.
	SeamCommitted = "committed"
	// SeamBroadcast is after the broadcast and the lock, before the reply: the
	// agent never hears, and the idempotency key or lookup_operation is how
	// it finds out.
	SeamBroadcast = "broadcast"
)

func (h *Handler) at(point string) {
	if h.seam != nil {
		h.seam(point)
	}
}

// mutationResultBytes bounds a mutation's envelope, which CommitOperation
// holds its rendered reply to before anything is written. The reply that
// carries it holds it twice, as structured content and as a JSON string whose
// escaping at most doubles it (Normalize leaves no control character but tab,
// line feed and carriage return, and HTML is not escaped), so a quarter of
// MaxReplyBytes leaves room for the framing and can never become
// result_too_large after the commit (PLAN.md section 4.8). A mutation's reply
// is its paths and uids, a few kilobytes even for 32 paths of 1 KiB.
const mutationResultBytes = MaxReplyBytes / 4

// indexWait is how long a move or a deletion that rewrites backlinks waits for
// the link index to reach the head it plans at before it reads every note
// instead. The worker is nudged by every commit, so a moment is usually
// enough; a longer wait would only delay the scan it avoids.
const indexWait = 2 * time.Second

// mutation is one write tool's call in progress, from begin to its reply.
type mutation struct {
	c *call
	// key is the caller's idempotency key, or "", and digest the canonical
	// request's (requestDigest).
	key    string
	digest string
	// epoch is the store epoch the call's uids belong to: the one the agent
	// read under when it names uids, else the store's when the call began.
	epoch string
	// mine are the paths that are the caller's own arguments, which the path
	// rules accepted: a result may name them under trusted, as read_note's
	// does. Every other path a write meets was found in the vault.
	mine map[string]bool
}

// idempotencyKey and epoch are the two arguments every mutation takes.
func (a *args) idempotencyKey() string {
	key, present := a.text("idempotencyKey", store.MaxIdempotencyKeyLen)
	if present && key == "" {
		a.refuse(invalidArguments("idempotencyKey must not be empty; leave it out for none"))
	}
	for _, r := range key {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			a.refuse(invalidArguments("idempotencyKey must not hold control characters"))
			break
		}
	}
	return key
}

// epoch is the store epoch the agent read under, as every read result's
// trusted.epoch says it. Required when the call names a uid: a uid means a
// version only within its epoch, and a restored store issues the uids above
// its snapshot again, to other versions (PLAN.md section 2.8).
func (a *args) epoch(required bool) string {
	e, present := a.text("epoch", 64)
	if !present && required {
		a.refuse(invalidArguments("epoch is required: pass the epoch the read that gave you these uids reported"))
	}
	return e
}

// uid is a version uid, required when required is set.
func (a *args) uid(key string, required bool) int64 {
	n := a.integer(key, 1, maxSafe, 0, "invalid_arguments")
	if n == 0 && required && a.fail == nil {
		a.refuse(invalidArguments(key + " is required"))
	}
	return n
}

// writable is a path a write names, of kind existingNote, newNote or
// newFolder: one the path rules accept (badpath, or reserved_name for the
// adapters' staging mark); a note's in an editable format, Markdown or plain
// text less Excalidraw drawings (unsupported_format), which is its own policy
// and not what a device chunks as text (PLAN.md section 4.3, step 2); and a
// new one's not shaped like a conflict copy (reserved_name). An existing note
// may have that shape: a person keeps the copy they want, and an agent may be
// asked to tidy it.
func (a *args) writable(key string, required bool, kind int) string {
	p, present := a.text(key, paths.MaxPathBytes)
	if a.fail != nil {
		return ""
	}
	if !present {
		if required {
			a.refuse(invalidArguments(key + " is required"))
		}
		return ""
	}
	switch r := paths.Check(p); {
	case r == paths.ReasonStaging:
		a.refuse(&ToolError{Code: "reserved_name", Message: key + ": the name holds " + paths.StagingMark +
			", which the devices use for files they are still writing"})
		return ""
	case r != "":
		a.refuse(&ToolError{Code: "badpath", Message: key + ": " + string(r) + ": the server refuses this path"})
		return ""
	case kind != newFolder && !paths.MCPEditable(p):
		a.refuse(&ToolError{Code: "unsupported_format", Message: key + ": agent notes must be Markdown or plain text, " +
			"excluding drawings"})
		return ""
	case kind != existingNote && paths.ConflictCopy(p):
		a.refuse(&ToolError{Code: "reserved_name", Message: key + ": the name is shaped like a conflict copy, " +
			"which the plugin offers a person to resolve; choose another"})
		return ""
	}
	return p
}

// begin starts a mutation whose arguments have all been read and accepted:
// it checks the epoch and answers a replayed key. done is set when o is the
// call's whole answer. mine are the paths among the arguments.
func (c *call) begin(a *args, key, epoch string, mine ...string) (m *mutation, o outcome, done bool) {
	m = &mutation{c: c, key: key, mine: map[string]bool{}}
	for _, p := range mine {
		if p != "" {
			m.mine[p] = true
		}
	}
	digest, err := requestDigest(c.tool.Name, a.fields)
	if err != nil {
		return nil, c.failWrite(err), true
	}
	m.digest = digest
	current := c.h.st.Epoch()
	switch {
	case epoch == "":
		m.epoch = current
	case epoch != current:
		return nil, m.fail(&ToolError{Code: "stale", Message: "the store was restored since the read that gave you " +
			"this epoch, so its uids may now name other versions; read again, and use the epoch that read reports"}), true
	default:
		m.epoch = epoch
	}
	if key != "" {
		res, found, err := c.h.st.Replay(c.h.vault, c.cred.token.ID, key, digest)
		if err != nil {
			return nil, m.failed(err), true
		}
		if found {
			return nil, outcome{raw: res.Result}, true
		}
	}
	return m, outcome{}, false
}

// requestDigest is the hex SHA-256 of the canonical request (PLAN.md section
// 4.8), which is what makes "the same request" a comparison: the tool's name
// and its arguments, idempotencyKey left out, re-encoded as JSON with object
// keys sorted, no insignificant whitespace, strings in encoding/json's escaping
// with HTML left alone, and integral numbers as integers (5, 5.0 and 5e0 are
// one number, as the tools read them). A top-level argument given as null is
// left out, as the tools treat it as absent. An explicit default and an
// omitted one are not the same spelling and do not digest alike; a retry
// sends the same arguments, and the key is the retry's.
func requestDigest(tool string, fields map[string]json.RawMessage) (string, error) {
	arguments := map[string]any{}
	for k, raw := range fields {
		if k == "idempotencyKey" || string(raw) == "null" {
			continue
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		var v any
		if err := d.Decode(&v); err != nil {
			return "", err
		}
		arguments[k] = canonicalNumbers(v)
	}
	b, err := encode(struct {
		Tool      string         `json:"tool"`
		Arguments map[string]any `json:"arguments"`
	}{tool, arguments})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func canonicalNumbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		f, err := x.Float64()
		if err != nil {
			return x.String()
		}
		if f == math.Trunc(f) && math.Abs(f) <= 1<<53 {
			return int64(f)
		}
		return f
	case []any:
		for i := range x {
			x[i] = canonicalNumbers(x[i])
		}
	case map[string]any:
		for k := range x {
			x[k] = canonicalNumbers(x[k])
		}
	}
	return v
}

// newEntry is a version this call writes: the token's label as its device,
// which is how note_history, the audit and the batches a device receives name
// the agent (PLAN.md section 2.4; a device names a conflict copy after itself,
// plan/mcp-tools.md, "Authentication and authorship"), and the server's clock
// as its mtime (section 4.11).
func (c *call) newEntry(path string) store.Entry {
	now := c.h.now().UnixMilli()
	return store.Entry{Path: path, CTime: now, MTime: now, Device: c.cred.token.Label, Chunks: []string{}}
}

// content fills e with the chunks of body, chunked exactly as a device chunks
// the same bytes (internal/notes, chunk.go), and returns their bodies for
// storeBodies.
func (c *call) content(e *store.Entry, body []byte) [][]byte {
	isText := notes.IsTextPath(e.Path)
	sizes := notes.SizesFor(int64(len(body)), isText, c.h.st.Chunks().Max())
	var bodies [][]byte
	e.Chunks = []string{}
	for _, ch := range notes.ChunkBytes(body, sizes, isText) {
		e.Chunks = append(e.Chunks, chunks.Name(ch.Bytes))
		bodies = append(bodies, ch.Bytes)
	}
	e.Size = int64(len(body))
	return bodies
}

// storeBodies makes every body durable before the commit that names them
// (PLAN.md section 4.3, step 3). Outside every lock: bodies are content
// addressed, named by nothing until an entry commits, and reclaimed by purge
// if none ever does.
//
// The first body is stored on its own and the rest after it, so that a write
// of several has a moment at which some of its bodies are durable and the
// others are not written: SeamUploading, where the crash matrix kills an
// upload in the middle. It costs one more directory flush, at an agent's pace.
func (c *call) storeBodies(bodies [][]byte) error {
	if len(bodies) > 0 {
		if err := c.h.st.Chunks().PutAll(c.h.vault, bodies[:1]); err != nil {
			return err
		}
	}
	if len(bodies) > 1 {
		c.h.at(SeamUploading)
		if err := c.h.st.Chunks().PutAll(c.h.vault, bodies[1:]); err != nil {
			return err
		}
	}
	c.h.at(SeamBodies)
	return nil
}

// folders is what path's folders need: a check that each live folder is still
// there, and a folder entry for each one the vault lacks, created in the same
// operation (plan/mcp-tools.md, create_note). A file where a folder has to be
// is exists; a spelling that folds onto another folder's is the store's
// collision rule's to refuse.
func (c *call) folders(path string) ([]store.OpEntry, []store.OpCheck, error) {
	var entries []store.OpEntry
	var checks []store.OpCheck
	for i := 0; i < len(path); i++ {
		if path[i] != '/' {
			continue
		}
		dir := path[:i]
		e, state, _, err := c.h.st.EntryAsOf(c.h.vault, dir, 0)
		if err != nil {
			return nil, nil, err
		}
		switch {
		case state == store.PathLive && e.Folder:
			checks = append(checks, store.OpCheck{Path: dir, Base: e.UID})
		case state == store.PathLive:
			uid := e.UID
			return nil, nil, &ToolError{Code: "exists", Message: "a file is at " + dir + ", where this path needs a folder",
				Path: dir, CurrentUID: &uid}
		default:
			f := c.newEntry(dir)
			f.Folder = true
			entries = append(entries, store.OpEntry{Entry: f})
		}
	}
	return entries, checks, nil
}

// submit commits op, a mutation's prepared operation, through the boundary:
// under the commit lock, the credential is checked (call.commit), the store
// commits or refuses the whole operation, and a committed one is broadcast
// before the lock is released, so a device connected now receives it before
// the reply is sent. render builds the result from what committed; it is
// called before the lock with every uid at its widest and inside the
// transaction with the real ones, and the second is recorded and returned.
func (m *mutation) submit(op store.Operation, render func(store.OpResult) (trusted, untrusted any)) outcome {
	c := m.c
	op.Vault = c.h.vault
	op.ActorID, op.ActorHash, op.ActorLabel = c.cred.token.ID, c.cred.hash, c.cred.token.Label
	op.Tool, op.IdempotencyKey, op.RequestDigest, op.Epoch = c.tool.Name, m.key, m.digest, m.epoch
	op.ClientName, op.ClientVersion = c.client.Name, c.client.Version
	op.MaxResult = mutationResultBytes
	op.Render = func(r store.OpResult) ([]byte, error) {
		trusted, untrusted := render(r)
		env, err := NewResult(c.tool.Name, trusted, untrusted)
		if err != nil {
			return nil, err
		}
		return Marshal(env)
	}
	var res store.OpResult
	err := c.commit(func() error {
		r, err := c.h.st.CommitOperation(op)
		if err != nil {
			return err
		}
		res = r
		c.h.at(SeamCommitted)
		if !r.Replayed {
			c.h.srv.Broadcast(c.h.vault, r.Committed())
		}
		return nil
	})
	if err != nil {
		return m.failed(err)
	}
	c.h.at(SeamBroadcast)
	if !res.Replayed {
		c.h.log.Info("MCP operation committed", "tool", c.tool.Name, "op", res.OpID, "entries", len(res.Entries),
			"noop", res.Noop, "token", c.cred.token.ID)
	}
	return outcome{raw: res.Result}
}

// committedTrusted is what every committed mutation's result says under
// trusted: that it committed (durable, not delivered: PLAN.md section 4.8),
// its operation id, whether it wrote nothing, the epoch its uids belong to,
// the server's time of commit, and how many paths it wrote.
type committedTrusted struct {
	Committed   bool   `json:"committed"`
	OpID        string `json:"opId"`
	Noop        bool   `json:"noop"`
	Epoch       string `json:"epoch"`
	CommittedAt int64  `json:"committedAt"`
	Count       int    `json:"count"`
}

func committedFacts(r store.OpResult) committedTrusted {
	return committedTrusted{Committed: true, OpID: r.OpID, Noop: r.Noop, Epoch: r.Epoch, CommittedAt: r.CommittedAt,
		Count: len(r.Entries)}
}

// entryRow is one path a mutation wrote, as its result lists it. Under
// untrusted_content whole, as M4's listings keep a row about a path: an
// operation's paths include ones found in the vault (a backlink, a note in a
// folder a tag was renamed across), and one place for all of them is simpler
// for an agent than two.
//
// kind is what the path holds now: "note" (a file with content, empty
// included, which size 0 says), "folder", or "deletion". previousUid is the
// version this one displaced, readable with read_note {path: previousPath or
// path, uid: previousUid} for as long as its pin lasts; null when nothing
// readable was displaced, which is a genuine create (the path held nothing,
// or a deletion). previousPath is set for a move, whose displaced version is
// the source's.
type entryRow struct {
	Path         Text   `json:"path"`
	UID          int64  `json:"uid"`
	PreviousUID  *int64 `json:"previousUid"`
	PreviousPath *Text  `json:"previousPath,omitempty"`
	Kind         Text   `json:"kind"`
	Size         int64  `json:"size"`
}

func entryRows(r store.OpResult) []entryRow {
	rows := make([]entryRow, 0, len(r.Entries))
	for _, e := range r.Entries {
		kind := "note"
		switch {
		case e.Entry.Folder:
			kind = "folder"
		case e.Entry.Deleted:
			kind = "deletion"
		}
		row := entryRow{Path: text(e.Entry.Path), UID: e.Entry.UID, Kind: text(kind), Size: e.Entry.Size}
		switch {
		case e.Entry.Prev != "":
			prev := text(e.Entry.Prev)
			row.PreviousPath = &prev
			if e.SourceUID != 0 && !e.SourceGone {
				uid := e.SourceUID
				row.PreviousUID = &uid
			}
		case e.PreviousUID != 0 && !e.PreviousGone:
			uid := e.PreviousUID
			row.PreviousUID = &uid
		}
		rows = append(rows, row)
	}
	return rows
}

// entries is the untrusted half of a committed mutation's result.
type entries struct {
	Entries []entryRow `json:"entries"`
}

// plainResult is the result of a mutation that says nothing more than what it
// wrote.
func plainResult(r store.OpResult) (any, any) { return committedFacts(r), entries{entryRows(r)} }

// writeFailure is a failed mutation's envelope: committed false (or
// "unknown"), the error, and, when the error is about a path found in the
// vault rather than one the caller named, that path under untrusted_content.
type writeFailure struct {
	Committed any        `json:"committed"`
	OpID      string     `json:"opId,omitempty"`
	Key       string     `json:"idempotencyKey,omitempty"`
	Error     *ToolError `json:"error"`
}

type aboutPath struct {
	Path Text `json:"path"`
}

// failWrite is a write tool's failure before it had a mutation: an argument
// refused, or an error of any kind, nothing written.
func (c *call) failWrite(err error) outcome {
	m := &mutation{c: c, mine: map[string]bool{}}
	return m.failed(err)
}

// fail is a refusal the tool made before the commit.
func (m *mutation) fail(te *ToolError) outcome { return m.failed(te) }

// failed is err as a mutation reports it, keeping apart what calls for
// different actions (PLAN.md section 4.8): refused before commit (a
// precondition said no; nothing written, and this request as it stands never
// will be), failed (the store erred and rolled back; nothing written, and the
// same request may succeed later), and an outcome nobody can state, which is
// never reported as either.
func (m *mutation) failed(err error) outcome {
	c := m.c
	var oe *store.OpError
	var r *notes.Refusal
	var te *ToolError
	out := writeFailure{Committed: false}
	var about string
	switch {
	case errors.As(err, &oe) && oe.Outcome == store.OpUnknown:
		c.h.log.Error("an MCP operation's outcome is unknown", "tool", c.tool.Name, "op", oe.OpID, "err", oe.Err)
		out.Committed, out.OpID, out.Key = "unknown", oe.OpID, m.key
		message := "the store could not confirm the commit, and it may have happened. Do not repeat the request blindly: " +
			"lookup_operation with this opId says whether it committed and what it changed"
		if m.key != "" {
			message += "; or repeat it exactly, with the same idempotencyKey, which answers with the recorded result " +
				"if it committed and commits it once if it did not"
		} else {
			message += "; this call carried no idempotencyKey, so repeating it could apply it twice"
		}
		out.Error = &ToolError{Code: "outcome_unknown", Message: message}
	case errors.As(err, &oe) && oe.Outcome == store.OpFailed:
		c.h.log.Error("an MCP operation failed before it committed", "tool", c.tool.Name, "err", oe.Err)
		out.Error = &ToolError{Code: "internal", Message: "the store failed before committing, and nothing was written; " +
			"the same request may succeed later, and the server's log says why"}
	case errors.As(err, &oe):
		out.Error = &ToolError{Code: oe.Code, Message: opMessage(oe)}
		if oe.CurrentUID != 0 {
			uid := oe.CurrentUID
			out.Error.CurrentUID = &uid
		}
		about = oe.Path
		if oe.Code == store.OpCodeInternal {
			// A malformed entry is the tool's own bug, not the agent's.
			c.h.log.Error("the store refused an MCP operation the tool built", "tool", c.tool.Name, "err", oe.Err)
		}
	case errors.As(err, &r):
		out.Error = &ToolError{Code: r.Code, Message: r.Message}
		about = r.Path
	case errors.As(err, &te):
		cp := *te
		out.Error = &cp
		about, cp.Path = cp.Path, ""
	default:
		out.Error = toolError(err)
		c.h.log.Error("MCP tool failed", "tool", c.tool.Name, "err", err)
	}
	var untrusted any
	switch {
	case about == "":
	case m.mine[about]:
		out.Error.Path = about
	default:
		untrusted = aboutPath{text(about)}
	}
	res, rerr := NewResult(c.tool.Name, out, untrusted)
	if rerr != nil {
		panic(rerr) // unreachable: a ToolError holds no Text, and the path is one
	}
	return outcome{env: res, isError: true}
}

// opMessage is a store refusal's message for the agent: what happened and
// what to do, without the store's internals.
func opMessage(oe *store.OpError) string {
	switch {
	case errors.Is(oe.Err, store.ErrEpochChanged), errors.Is(oe.Err, store.ErrReplayFromEarlierEpoch):
		return "the store was restored since this request was prepared, and its uids may now name other versions; " +
			"read again, and use a new idempotencyKey"
	case oe.Code == store.OpCodeStale:
		return "a note changed since the version this was prepared against; read it again and reconsider. Nothing was written"
	case oe.Code == store.OpCodeExists:
		return "something is at that path now; nothing was written"
	case oe.Code == store.OpCodePlanChanged:
		return "the vault changed since the preview; preview again and pass the new changes back. Nothing was written"
	case oe.Code == store.OpCodeReadOnly:
		return "this token was revoked, expired or cannot write; nothing was written"
	case oe.Code == store.OpCodeCollision:
		return "a path that a case-folding disk would hold as the same file or folder is already in the vault; nothing was written"
	case oe.Code == store.OpCodeKeyReused:
		return "this idempotencyKey was already used for a different request; use a new key for a new request"
	case oe.Code == store.OpCodeDuplicatePath:
		return "the operation names one path twice; nothing was written"
	case oe.Code == store.OpCodeBadPath:
		return "the server refuses this path; nothing was written"
	case oe.Code == store.OpCodeResultTooLarge:
		return "the result would be larger than a reply can carry; nothing was written"
	}
	return "the server refused the operation it built, and nothing was written; its log says why"
}

// liveNote is the note at path, which must be live at base: stale when the
// path has moved on (its currentUid is the path's own, never the vault's), and
// not_found when base is its head but that is not a note.
func (c *call) liveNote(path string, base int64) (store.Entry, error) {
	head, _, err := c.h.st.Head(c.h.vault, path)
	if err != nil {
		return store.Entry{}, err
	}
	if head != base {
		return store.Entry{}, &ToolError{Code: "stale", Message: "the note changed since that base; read it again and reconsider",
			Path: path, CurrentUID: &head}
	}
	e, state, _, err := c.h.st.EntryAsOf(c.h.vault, path, 0)
	switch {
	case err != nil:
		return store.Entry{}, err
	case state != store.PathLive || e.UID != base:
		return store.Entry{}, &ToolError{Code: "not_found", Message: "no note is at that path now; deleted_notes and note_history say what was"}
	case e.Folder:
		return store.Entry{}, &ToolError{Code: "not_note_content", Message: "that path is a folder"}
	}
	return e, nil
}

// storeView is the vault at one head as a plan reads it (notes.View): every
// live file, and a version's bytes from the store.
type storeView struct {
	c     *call
	head  int64
	files []string
	live  map[string]store.Entry
}

func (c *call) viewAt(head int64) (*storeView, error) {
	v := &storeView{c: c, head: head, live: map[string]store.Entry{}}
	err := c.h.st.EachAsOf(c.h.vault, head, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if !e.Folder && !e.Deleted {
			v.files = append(v.files, e.Path)
			v.live[e.Path] = e
		}
		return c.ctx.Err() == nil, nil
	})
	if err == nil {
		err = c.ctx.Err()
	}
	return v, err
}

func (v *storeView) Files() ([]string, error) { return v.files, nil }

func (v *storeView) Read(path string) (notes.Version, error) {
	e, ok := v.live[path]
	if !ok {
		return notes.Version{}, &notes.Refusal{Code: "not_found", Message: "no note is at that path now"}
	}
	if e.Size > notes.NoteBytes {
		return notes.Version{}, &notes.Refusal{Code: "note_too_large", Message: "the note is too large for this read"}
	}
	full, ok, err := v.c.h.st.EntryByUID(v.c.h.vault, e.UID)
	if err != nil {
		return notes.Version{}, err
	}
	if !ok {
		return notes.Version{}, &notes.Refusal{Code: "version_not_found", Message: "the version is gone"}
	}
	b, err := v.c.versionBytes(full)
	if err != nil {
		return notes.Version{}, err
	}
	return notes.Version{UID: e.UID, Bytes: b}, nil
}

// linkedView is a storeView narrowed by the link index (notes.LinkIndex), for
// the one target its keys were asked about.
type linkedView struct {
	*storeView
	target string
	links  search.Backlinks
}

func (v *linkedView) MayLinkTo(path, target string) bool {
	if target != v.target {
		return true
	}
	e, ok := v.live[path]
	return !ok || v.links.MayLink(path, e.UID)
}

// scanInfo is how a plan read the vault, for its preview: "index" when the
// link index narrowed it, "vault" when every editable note was read, and
// "none" when the plan reads only the notes it names.
type scanInfo struct {
	Method      string `json:"method"`
	IndexedHead int64  `json:"indexedHead,omitempty"`
	Why         string `json:"why,omitempty"`
}

// linkHead is the head a move or a deletion that rewrites backlinks plans at,
// and the view narrowed by the link index when the index has indexed exactly
// it. A preview (fixed == 0) takes the vault's head, waiting a moment for the
// index to reach it, and takes a newer head if the vault moves on meanwhile;
// an apply plans at the head its preview named.
func (c *call) linkHead(target string, fixed int64) (notes.View, *storeView, scanInfo, error) {
	ctx, cancel := context.WithTimeout(c.ctx, indexWait)
	defer cancel()
	var why string
	for attempt := 0; ; attempt++ {
		head := fixed
		if head == 0 {
			var err error
			if head, err = c.h.st.LatestUID(c.h.vault); err != nil {
				return nil, nil, scanInfo{}, err
			}
		}
		view, err := c.viewAt(head)
		if err != nil {
			return nil, nil, scanInfo{}, err
		}
		if c.h.index == nil {
			return view, view, scanInfo{Method: "vault", Why: "this server keeps no link index"}, nil
		}
		// Waiting helps only an index that is answering and behind; one being
		// built from nothing, or distrusted, would only make the scan later.
		if c.h.index.Status().Usable {
			c.h.index.Await(ctx, head)
		}
		b, err := c.h.index.Backlinks(c.ctx, head, notes.TargetKeys(target))
		if err != nil {
			c.h.log.Warn("the link index could not be read; reading every note", "err", err)
			return view, view, scanInfo{Method: "vault", Why: "the link index could not be read"}, nil
		}
		if b.Current {
			return &linkedView{storeView: view, target: target, links: b},
				view, scanInfo{Method: "index", IndexedHead: b.IndexedHead}, nil
		}
		why = b.Why
		if fixed != 0 || b.IndexedHead <= head || attempt >= 2 || ctx.Err() != nil {
			return view, view, scanInfo{Method: "vault", IndexedHead: b.IndexedHead, Why: why}, nil
		}
		// The vault moved on while the index caught up: plan at its new head.
	}
}

// normalizedChanges is a plan as its preview showed it: every string through
// Normalize.
func normalizedChanges(changes []notes.PlannedChange) []notes.PlannedChange {
	out := make([]notes.PlannedChange, len(changes))
	for i, c := range changes {
		n := notes.PlannedChange{Path: Normalize(c.Path).String(), Base: c.Base, Action: c.Action, Edits: make([]notes.SourceEdit, len(c.Edits))}
		if c.To != "" {
			n.To = Normalize(c.To).String()
		}
		for j, e := range c.Edits {
			n.Edits[j] = notes.SourceEdit{Start: e.Start, End: e.End, Old: Normalize(e.Old).String(), Text: Normalize(e.Text).String()}
		}
		out[i] = n
	}
	return out
}

// samePlan is whether changes passed back are the plan made now: exactly, or
// as the preview showed it, every string through Normalize. What commits is
// always the plan made now, from the store's bytes, bound to the preview's
// head; the changes passed back are the agent's approval of it, and a plan
// whose text Normalize altered can only be passed back as it was shown.
func samePlan(supplied, current []notes.PlannedChange) bool {
	return notes.SamePlan(supplied, current) || notes.SamePlan(supplied, normalizedChanges(current))
}

// changeRow is a planned change as a preview shows it, whole under
// untrusted_content: its paths may be ones the plan found in the vault, and
// its edits are note text.
type changeRow struct {
	Path   Text      `json:"path"`
	Base   int64     `json:"base"`
	Action Text      `json:"action"`
	To     *Text     `json:"to,omitempty"`
	Edits  []editRow `json:"edits"`
}

type editRow struct {
	Start int  `json:"start"`
	End   int  `json:"end"`
	Old   Text `json:"old"`
	Text  Text `json:"text"`
}

func changeRows(changes []notes.PlannedChange) []changeRow {
	out := make([]changeRow, len(changes))
	for i, c := range changes {
		row := changeRow{Path: text(c.Path), Base: c.Base, Action: text(c.Action), Edits: make([]editRow, len(c.Edits))}
		if c.To != "" {
			to := text(c.To)
			row.To = &to
		}
		for j, e := range c.Edits {
			row.Edits[j] = editRow{e.Start, e.End, text(e.Old), text(e.Text)}
		}
		out[i] = row
	}
	return out
}

// previewInstructions is what a preview tells the agent to do with it.
const previewInstructions = "Nothing has been written. To apply, call this tool again with the same arguments and " +
	"changes set to these changes exactly as shown, head set to this head and epoch to this epoch. " +
	"If anything in the vault changes first, the apply is refused with plan_changed and nothing is written; preview again."

// previewTrusted is what a preview says under trusted: that it is one, the
// head and epoch its plan read and its apply is bound to, how it read the
// vault, and what to do next.
type previewTrusted struct {
	Phase          string   `json:"phase"`
	Committed      bool     `json:"committed"`
	Head           int64    `json:"head"`
	Epoch          string   `json:"epoch"`
	Complete       bool     `json:"complete"`
	AmbiguousLinks int      `json:"ambiguousLinks"`
	Count          int      `json:"count"`
	Scan           scanInfo `json:"scan"`
	Instructions   string   `json:"instructions"`
}

// readChanges is the changes argument of an apply: at most notes.BatchFiles
// planned changes, strictly shaped.
func (a *args) changes() ([]notes.PlannedChange, bool) {
	items, present := a.objects("changes", 0, notes.BatchFiles)
	if !present {
		return nil, false
	}
	out := make([]notes.PlannedChange, len(items))
	for i, item := range items {
		where := "changes[" + strconv.Itoa(i) + "]"
		var c notes.PlannedChange
		c.Path, _ = item.text("path", paths.MaxPathBytes)
		c.Base = item.uid("base", true)
		c.Action = item.oneOf("action", "", "invalid_arguments", "edit", "move", "delete")
		c.To, _ = item.text("to", paths.MaxPathBytes)
		edits, _ := item.objects("edits", 0, notes.PlanEdits)
		c.Edits = make([]notes.SourceEdit, len(edits))
		for j, e := range edits {
			ew := where + ".edits[" + strconv.Itoa(j) + "]"
			c.Edits[j].Start = int(e.integer("start", 0, notes.NoteBytes, -1, "invalid_edits"))
			c.Edits[j].End = int(e.integer("end", 0, notes.NoteBytes, -1, "invalid_edits"))
			c.Edits[j].Old, _ = e.text("old", notes.InputBytes)
			c.Edits[j].Text, _ = e.text("text", notes.InputBytes)
			for _, k := range []string{"start", "end", "old", "text"} {
				if _, ok := e.fields[k]; !ok && e.fail == nil {
					e.refuse(invalidArguments(k + " is required"))
				}
			}
			item.adopt(e, ew)
		}
		for _, k := range []string{"path", "action", "edits"} {
			if _, ok := item.fields[k]; !ok && item.fail == nil {
				item.refuse(invalidArguments(k + " is required"))
			}
		}
		a.adopt(item, where)
		out[i] = c
	}
	return out, true
}
