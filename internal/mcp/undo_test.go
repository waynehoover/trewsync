package mcp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	wireframe "github.com/waynehoover/trew/internal/frame"
	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// undo_operation (PLAN.md section 4.5, M5 task 7) through the official SDK
// client: every kind of operation undone to its exact former bytes, which a
// freshly synced device then holds too; a person's edit refusing the whole
// undo; the copy; a purged before-image; a retry; and whose undo it is.

// state is the vault as the store holds it now: every live path, a note as
// its exact bytes and a folder as "<folder>".
func (r *rig) state() map[string]string {
	r.t.Helper()
	out := map[string]string{}
	if err := r.st.EachAsOf(testVault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		switch {
		case e.Deleted:
		case e.Folder:
			out[e.Path] = "<folder>"
		default:
			out[e.Path] = r.bytesAt(e.UID)
		}
		return true, nil
	}); err != nil {
		r.t.Fatal(err)
	}
	return out
}

// witness is a device paired now, with an empty vault, which syncs the whole
// history from uid 1 over the protocol and fetches every note it ends with:
// the vault as a device that was never there sees it.
func (r *rig) witness() map[string]string {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, idBytes := make([]byte, 32), make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		r.t.Fatal(err)
	}
	if _, err := rand.Read(idBytes); err != nil {
		r.t.Fatal(err)
	}
	id := store.EncodeToken(idBytes)
	if err := r.st.RegisterDevice(testVault, id, "witness", store.HashToken(raw), time.Now().UnixMilli()); err != nil {
		r.t.Fatal(err)
	}
	conn, _, err := websocket.Dial(ctx, "ws"+r.hs.URL[len("http"):], nil)
	if err != nil {
		r.t.Fatal(err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 20)
	send := func(v any) {
		b, _ := json.Marshal(v)
		if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
			r.t.Fatal(err)
		}
	}
	send(wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Vault: testVault, Token: store.EncodeToken(raw), DeviceID: id,
		Device: "witness"})
	live := map[string]store.Entry{}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			r.t.Fatalf("the witness's catch-up: %v", err)
		}
		var probe struct {
			Res, Op string
		}
		_ = json.Unmarshal(data, &probe)
		if probe.Op == "caught-up" {
			break
		}
		if probe.Op != "batch" {
			continue
		}
		var b wire.Batch
		if err := json.Unmarshal(data, &b); err != nil {
			r.t.Fatal(err)
		}
		// What a device applies: a rename leaves its source, a deletion
		// leaves its path, and anything else is the path's new version.
		for _, e := range b.Entries {
			if e.Prev != "" {
				delete(live, e.Prev)
			}
			if e.Deleted {
				delete(live, e.Path)
				continue
			}
			live[e.Path] = e
		}
	}
	out := map[string]string{}
	next := int64(2)
	for path, e := range live {
		if e.Folder {
			out[path] = "<folder>"
			continue
		}
		var body []byte
		if len(e.Chunks) > 0 {
			send(wire.In{Op: "fetch", ID: next, Chunks: e.Chunks})
			next++
			_, header, err := conn.Read(ctx)
			if err != nil || !strings.Contains(string(header), `"bodies"`) {
				r.t.Fatalf("fetching %s: %s %v", path, header, err)
			}
			for range e.Chunks {
				_, frame, err := conn.Read(ctx)
				if err != nil {
					r.t.Fatal(err)
				}
				b, err := wireframe.Decode(frame, store.ChunkMax)
				if err != nil {
					r.t.Fatal(err)
				}
				body = append(body, b...)
			}
		}
		out[path] = string(body)
	}
	return out
}

// sameVault fails the test when two states differ, naming every difference.
func sameVault(t *testing.T, what string, got, want map[string]string) {
	t.Helper()
	var diffs []string
	for p, w := range want {
		if g, ok := got[p]; !ok {
			diffs = append(diffs, fmt.Sprintf("%q is missing (was %q)", p, w))
		} else if g != w {
			diffs = append(diffs, fmt.Sprintf("%q reads %q, want %q", p, g, w))
		}
	}
	for p, g := range got {
		if _, ok := want[p]; !ok {
			diffs = append(diffs, fmt.Sprintf("%q is there (%q) and should not be", p, g))
		}
	}
	sort.Strings(diffs)
	if len(diffs) > 0 {
		t.Fatalf("%s:\n  %s", what, strings.Join(diffs, "\n  "))
	}
}

// undone is an undo's result: its facts, and what it wrote.
type undone struct {
	written
	Undoes string `json:"undoes"`
	ToCopy bool   `json:"toCopy"`
	Steps  []struct {
		Action string `json:"action"`
		Path   string `json:"path"`
		From   string `json:"from"`
		Copy   string `json:"copy"`
		Before int64  `json:"before"`
		After  int64  `json:"after"`
	} `json:"-"`
}

func undid(t *testing.T, e envelope) undone {
	t.Helper()
	w := wrote(t, e)
	var u undone
	e.trusted(t, &u)
	u.written = w
	var rows struct {
		Steps json.RawMessage `json:"steps"`
	}
	e.untrusted(t, &rows)
	if err := json.Unmarshal(rows.Steps, &u.Steps); err != nil {
		t.Fatalf("the undo's steps: %v\n%s", err, e.raw)
	}
	return u
}

// Every kind of operation an agent can make, undone: each time the vault is
// exactly what it was before the operation, path for path and byte for byte,
// in the store and on a device paired afterwards; the undo is recorded as the
// token's, naming the operation, and what it displaced (the operation's
// output) reads back by uid as its exact bytes, after a default purge too.
func TestEveryKindOfOperationUndoesToItsFormerBytes(t *testing.T) {
	r := newRig(t, withLimits(Limits{TokenBurst: 1000, TokenRate: 1000}))
	a := r.writer("Claude on Mac")
	epoch := r.epoch()
	call := func(tool string, args map[string]any) envelope { return invoke(t, a.cs, tool, args) }
	r.write("index.md", "see [[plan]] and [the plan](projects/plan.md)\n")
	r.write("projects/plan.md", "# Plan\n\nfirst\n")
	r.write("tags/a.md", "---\ntitle: a\n---\nbody #old\n")
	r.write("tags/b.md", "#old and #old/child\n")
	r.write("tags/c.md", "no tags here\n")
	bom := r.write("bom.md", "\ufeffbody\n")

	head := func(path string) int64 { return r.head(path) }
	previewThen := func(tool string, args map[string]any) envelope {
		return call(tool, apply(args, previewed(t, call(tool, args))))
	}
	for _, c := range []struct {
		name string
		op   func() envelope
	}{
		{"create_note", func() envelope {
			return call("create_note", map[string]any{"path": "new/deep/note.md", "content": "a new note\n"})
		}},
		{"create_directory", func() envelope {
			return call("create_directory", map[string]any{"path": "archive/2026"})
		}},
		{"edit_note", func() envelope {
			return call("edit_note", map[string]any{"path": "projects/plan.md", "base": head("projects/plan.md"),
				"epoch": epoch, "edits": []any{map[string]any{"old": "first", "new": "second"}}})
		}},
		{"append_note", func() envelope {
			return call("append_note", map[string]any{"path": "projects/plan.md", "base": head("projects/plan.md"),
				"epoch": epoch, "text": "- appended\n"})
		}},
		{"prepend_note", func() envelope {
			return call("prepend_note", map[string]any{"path": "bom.md", "base": bom, "epoch": epoch, "text": "top\n"})
		}},
		{"move_note with backlinks", func() envelope {
			return previewThen("move_note", map[string]any{"path": "projects/plan.md",
				"base": head("projects/plan.md"), "to": "done/plan.md", "epoch": epoch})
		}},
		{"delete_note, striking its backlinks through", func() envelope {
			return previewThen("delete_note", map[string]any{"path": "projects/plan.md",
				"base": head("projects/plan.md"), "markBroken": true, "epoch": epoch})
		}},
		{"restore_note", func() envelope {
			// Deleted just now, because the purges before this one have
			// taken any older deletion's content, as purge does.
			gone := r.write("gone.md", "deleted, then restored somewhere else\n")
			r.remove("gone.md")
			return call("restore_note", map[string]any{"path": "gone.md", "uid": gone, "to": "back/gone.md",
				"epoch": epoch})
		}},
		{"add_tags over several notes", func() envelope {
			return previewThen("add_tags", map[string]any{"paths": []any{"tags/a.md", "tags/b.md", "tags/c.md"},
				"tags": []any{"added"}})
		}},
		{"remove_tags", func() envelope {
			return previewThen("remove_tags", map[string]any{"paths": []any{"tags/b.md"}, "tags": []any{"old"},
				"includeChildren": true})
		}},
		{"manage_tags", func() envelope {
			return previewThen("manage_tags", map[string]any{"operation": "add", "paths": []any{"tags/c.md"},
				"tags": []any{"managed"}, "location": "content"})
		}},
		{"rename_tag across the vault", func() envelope {
			return previewThen("rename_tag", map[string]any{"oldTag": "old", "newTag": "renamed", "includeChildren": true})
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			before := r.state()
			w := wrote(t, c.op())
			if len(w.Entries) == 0 {
				t.Fatalf("the operation wrote nothing: %+v", w)
			}
			after := r.state()
			if fmt.Sprint(after) == fmt.Sprint(before) {
				t.Fatal("the operation changed nothing the test can see")
			}
			u := undid(t, call("undo_operation", map[string]any{"opId": w.OpID, "epoch": epoch}))
			if u.Undoes != w.OpID || u.ToCopy || len(u.Entries) == 0 {
				t.Fatalf("the undo: %+v", u)
			}
			sameVault(t, "the store after the undo", r.state(), before)
			sameVault(t, "a device paired after the undo", r.witness(), before)

			rec, ok, err := r.st.LookupOperation(testVault, u.OpID)
			if err != nil || !ok || rec.Tool != store.UndoTool || rec.Undoes != w.OpID || rec.ActorLabel != a.label ||
				rec.ActorKind != store.AuthorKindMCP {
				t.Fatalf("the undo is recorded as %+v (%v)", rec, err)
			}
			// What the undo displaced is the operation's output, pinned and
			// readable as the operation wrote it.
			for _, e := range u.Entries {
				if e.PreviousUID == nil {
					continue
				}
				path := e.Path
				if e.PreviousPath != "" {
					path = e.PreviousPath
				}
				if want, ok := after[path]; ok && want != "<folder>" {
					r.former(a.cs, path, *e.PreviousUID, want)
				}
			}
		})
	}
}

// A person's edit to one note of a batch refuses the whole undo: nothing is
// written, the refusal names the note, its head and the device that wrote it
// (under untrusted_content), and the copy then writes every version the batch
// replaced beside its note, leaving the person's edit and everything else as
// it is.
func TestAPersonsEditRefusesTheWholeUndoAndTheCopyTouchesNothing(t *testing.T) {
	r := newRig(t, withLimits(Limits{TokenBurst: 1000, TokenRate: 1000}))
	a := r.writer("agent")
	epoch := r.epoch()
	for _, p := range []string{"a.md", "b.md", "c.md"} {
		r.write(p, "#old in "+p+"\n")
	}
	args := map[string]any{"oldTag": "old", "newTag": "new"}
	w := wrote(t, invoke(t, a.cs, "rename_tag", apply(args, previewed(t, invoke(t, a.cs, "rename_tag", args)))))
	if len(w.Entries) != 3 {
		t.Fatalf("the rename wrote %+v", w.Entries)
	}
	phone := r.device("phone")
	mine := phone.put("b.md", "the phone's own words\n", r.head("b.md"))

	latest, _ := r.st.LatestUID(testVault)
	ops := r.operations()
	e := invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": epoch})
	if code := refused(t, e); code != "stale" {
		t.Fatalf("refused %s: %s", code, e.raw)
	}
	var about struct {
		Changed []struct {
			Path string `json:"path"`
			Head int64  `json:"head"`
			By   string `json:"by"`
		} `json:"changed"`
	}
	e.untrusted(t, &about)
	if len(about.Changed) != 1 || about.Changed[0].Path != "b.md" || about.Changed[0].Head != mine ||
		about.Changed[0].By != "phone" || strings.Contains(string(e.Trusted), "b.md") {
		t.Fatalf("the refusal: %s", e.raw)
	}
	if now, _ := r.st.LatestUID(testVault); now != latest || r.operations() != ops {
		t.Fatalf("a refused undo wrote something: head %d to %d, %d operations to %d", latest, now, ops, r.operations())
	}

	before := r.state()
	u := undid(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": epoch, "toCopy": true}))
	if !u.ToCopy || len(u.Steps) != 3 {
		t.Fatalf("the copy: %+v", u)
	}
	want := map[string]string{}
	for k, v := range before {
		want[k] = v
	}
	for _, s := range u.Steps {
		if s.Action != store.UndoCopy || s.Copy != strings.TrimSuffix(s.Path, ".md")+" (restored "+fmt.Sprint(s.Before)+").md" {
			t.Fatalf("a step of the copy: %+v", s)
		}
		want[s.Copy] = "#old in " + s.Path + "\n"
	}
	sameVault(t, "the vault after the copy", r.state(), want)
	sameVault(t, "a device paired after the copy", r.witness(), want)
}

// A move undoes as a unit or not at all: with the moved note moved again by a
// device, the undo is refused and the backlink the move rewrote is left
// rewritten, the folder it made left made.
func TestAMoveWithBacklinksUndoesAsAUnitOrNotAtAll(t *testing.T) {
	r := newRig(t, withLimits(Limits{TokenBurst: 1000, TokenRate: 1000}))
	a := r.writer("agent")
	epoch := r.epoch()
	r.write("index.md", "see [[plan]]\n")
	plan := r.write("projects/plan.md", "the plan\n")
	args := map[string]any{"path": "projects/plan.md", "base": plan, "to": "done/plan.md", "epoch": epoch}
	w := wrote(t, invoke(t, a.cs, "move_note", apply(args, previewed(t, invoke(t, a.cs, "move_note", args)))))
	r.rename("done/plan.md", "done/final.md", "the plan\n")

	before := r.state()
	e := invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": epoch})
	if code := refused(t, e); code != "stale" {
		t.Fatalf("refused %s: %s", code, e.raw)
	}
	sameVault(t, "the vault after a refused undo", r.state(), before)
	if before["index.md"] != "see [[done/plan]]\n" {
		t.Fatalf("the backlink reads %q", before["index.md"])
	}
}

// After the pin's window and a purge, the before-image is gone, and the undo
// says so, naming the note and the uid, and writes nothing.
func TestUndoAfterThePinExpiredAndPurgeRanIsRefusedAsGone(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	t0 := time.Now()
	clock := t0
	r.st.SetClock(func() time.Time { return clock })
	old := r.write("old.md", "the before-image\n")
	w := wrote(t, invoke(t, a.cs, "edit_note", map[string]any{"path": "old.md", "base": old, "epoch": r.epoch(),
		"edits": []any{map[string]any{"old": "before-image", "new": "agent's edit"}}}))
	clock = t0.Add(store.MinPinRetention + time.Hour)
	if rep, err := r.st.Purge(testVault, 0); err != nil || rep.VersionsRemoved == 0 {
		t.Fatalf("the purge: %+v %v", rep, err)
	}

	latest, _ := r.st.LatestUID(testVault)
	e := invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": r.epoch()})
	if code := refused(t, e); code != "gone" {
		t.Fatalf("refused %s: %s", code, e.raw)
	}
	var about struct {
		Gone []struct {
			Path   string `json:"path"`
			Before int64  `json:"before"`
			Why    string `json:"why"`
		} `json:"gone"`
	}
	e.untrusted(t, &about)
	if len(about.Gone) != 1 || about.Gone[0].Path != "old.md" || about.Gone[0].Before != old ||
		!strings.Contains(about.Gone[0].Why, "pin expired") {
		t.Fatalf("the refusal: %s", e.raw)
	}
	if now, _ := r.st.LatestUID(testVault); now != latest {
		t.Fatal("a refused undo wrote something")
	}
	if got := r.bytesAt(r.head("old.md")); got != "the agent's edit\n" {
		t.Fatalf("old.md reads %q after a refused undo", got)
	}
}

// Idempotent under retry: the same undo with the same key answers with the
// first one's bytes and writes nothing; the same key for another request is
// refused; the same undo without a key is refused as already undone.
func TestAnUndoIsIdempotentUnderRetry(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	note := r.write("note.md", "before\n")
	w := wrote(t, invoke(t, a.cs, "edit_note", map[string]any{"path": "note.md", "base": note, "epoch": r.epoch(),
		"edits": []any{map[string]any{"old": "before", "new": "after"}}}))
	args := map[string]any{"opId": w.OpID, "epoch": r.epoch(), "idempotencyKey": "undo-1"}
	first := invoke(t, a.cs, "undo_operation", args)
	undid(t, first)
	ops := r.operations()
	again := invoke(t, a.cs, "undo_operation", args)
	if string(again.raw) != string(first.raw) || r.operations() != ops {
		t.Fatalf("a retry was not the first undo's answer:\n%s\n%s", first.raw, again.raw)
	}
	other := map[string]any{"opId": w.OpID, "epoch": r.epoch(), "idempotencyKey": "undo-1", "toCopy": true}
	if code := refused(t, invoke(t, a.cs, "undo_operation", other)); code != "key_reused" {
		t.Fatalf("the key for another request: %s", code)
	}
	if code := refused(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": r.epoch()})); code != "already_undone" {
		t.Fatalf("undoing it again: %s", code)
	}
	if got := r.bytesAt(r.head("note.md")); got != "before\n" {
		t.Fatalf("note.md reads %q", got)
	}
}

// An agent undoes its own operations and no other token's, which it is told
// were never committed, and a read token cannot undo at all. Its own undo it
// may undo, which is a redo, and the operation then cannot be undone again.
func TestAnAgentUndoesItsOwnOperationsOnly(t *testing.T) {
	r := newRig(t, withLimits(Limits{TokenBurst: 1000, TokenRate: 1000}))
	a, b := r.writer("a"), r.writer("b")
	note := r.write("note.md", "before\n")
	w := wrote(t, invoke(t, a.cs, "edit_note", map[string]any{"path": "note.md", "base": note, "epoch": r.epoch(),
		"edits": []any{map[string]any{"old": "before", "new": "a's"}}}))
	if code := refused(t, invoke(t, b.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": r.epoch()})); code != "not_found" {
		t.Fatalf("b undoing a's operation: %s", code)
	}
	reader, _ := r.token(store.ScopeRead)
	rc := r.mustConnect(reader, "")
	if e := invoke(t, rc, "undo_operation", map[string]any{"opId": w.OpID, "epoch": r.epoch()}); !e.isError {
		t.Fatalf("a read token undid something: %s", e.raw)
	}

	u := undid(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": r.epoch()}))
	undo := wrote(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": u.OpID, "epoch": r.epoch()}))
	if got := r.bytesAt(r.head("note.md")); got != "a's\n" {
		t.Fatalf("the redo put %q back", got)
	}
	if code := refused(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": r.epoch()})); code != "already_undone" {
		t.Fatalf("undoing the original after a redo: %s", code)
	}
	if code := refused(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": undo.OpID, "epoch": "another epoch"})); code != "stale" {
		t.Fatalf("an undo under another epoch: %s", code)
	}
}

// lookup_operation names what an undo undid and which undo undid an
// operation, and reads a token's own operations by kind as well as by id: a
// device may choose any base64url id, a token's included, and its undo is
// still not that token's to look up.
func TestLookupOperationNamesTheUndoAndOnlyTheTokensOwn(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	note := r.write("note.md", "before\n")
	w := wrote(t, invoke(t, a.cs, "edit_note", map[string]any{"path": "note.md", "base": note, "epoch": r.epoch(),
		"edits": []any{map[string]any{"old": "before", "new": "after"}}}))
	u := undid(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": w.OpID, "epoch": r.epoch()}))
	type facts struct {
		Found    bool   `json:"found"`
		Tool     string `json:"tool"`
		Undoes   string `json:"undoes"`
		UndoneBy string `json:"undoneBy"`
	}
	var of, uf facts
	invoke(t, a.cs, "lookup_operation", map[string]any{"opId": w.OpID}).trusted(t, &of)
	invoke(t, a.cs, "lookup_operation", map[string]any{"opId": u.OpID}).trusted(t, &uf)
	if !of.Found || of.UndoneBy != u.OpID || of.Undoes != "" {
		t.Fatalf("the edit looked up: %+v", of)
	}
	if !uf.Found || uf.Tool != store.UndoTool || uf.Undoes != w.OpID || uf.UndoneBy != "" {
		t.Fatalf("the undo looked up: %+v", uf)
	}

	// A device whose id spells the token's undoes the undo, which is a redo.
	hash := strings.Repeat("ab", 32)
	if err := r.st.RegisterDevice(testVault, a.tok.ID, "phone", hash, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	plan, err := r.st.PlanUndo(store.UndoRequest{Vault: testVault, OpID: u.OpID, Label: "phone",
		Now: time.Now().UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	op := plan.Operation()
	op.Vault, op.Epoch, op.MaxResult = testVault, r.epoch(), 1<<10
	op.ActorKind, op.ActorID, op.ActorHash, op.ActorLabel = store.ActorDevice, a.tok.ID, hash, "phone"
	op.RequestDigest = strings.Repeat("0", 64)
	op.Render = func(store.OpResult) ([]byte, error) { return []byte(`{}`), nil }
	redo, err := r.st.CommitOperation(op)
	if err != nil {
		t.Fatalf("the device's undo: %v", err)
	}
	var df facts
	e := invoke(t, a.cs, "lookup_operation", map[string]any{"opId": redo.OpID})
	e.trusted(t, &df)
	if e.isError || df.Found || bytes.Contains(e.raw, []byte("note.md")) {
		t.Fatalf("the agent looked up a device's undo: %s", e.raw)
	}
	if code := refused(t, invoke(t, a.cs, "undo_operation", map[string]any{"opId": redo.OpID,
		"epoch": r.epoch()})); code != "not_found" {
		t.Fatalf("the agent undoing a device's undo: %s", code)
	}
}
