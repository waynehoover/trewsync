package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/store"
)

// The write tools through the official SDK client, as an agent calls them:
// what each one commits, the before-image of each (PLAN.md section 7), and
// the contract around them.

// Every write tool commits what it says, as the token's label, and every
// version it displaced reads back as its exact former bytes by previousUid,
// after the write and after a default purge.
func TestEveryWriteToolCommitsAndKeepsItsBeforeImage(t *testing.T) {
	r := newRig(t, withLimits(Limits{TokenBurst: 1000, TokenRate: 1000}))
	a := r.writer("Claude on Mac")
	epoch := r.epoch()
	call := func(tool string, args map[string]any) envelope { return invoke(t, a.cs, tool, args) }

	// create_note, with the folders it needs as folder entries of the same
	// operation, each a genuine create.
	w := wrote(t, call("create_note", map[string]any{"path": "projects/trew/plan.md", "content": "# Plan\n\nfirst\n"}))
	if len(w.Entries) != 3 || w.Entries[0].Kind != "folder" || w.Entries[1].Kind != "folder" ||
		w.Entries[2].Path != "projects/trew/plan.md" || w.Entries[2].Kind != "note" || w.Entries[2].Size != 14 {
		t.Fatalf("create_note wrote %+v", w.Entries)
	}
	for _, e := range w.Entries {
		if e.PreviousUID != nil {
			t.Fatalf("a genuine create names a previous uid: %+v", e)
		}
	}
	plan := w.Entries[2].UID
	if got := r.bytesAt(plan); got != "# Plan\n\nfirst\n" {
		t.Fatalf("the store holds %q", got)
	}

	// An empty note is a note of size 0, not a deletion or a folder.
	w = wrote(t, call("create_note", map[string]any{"path": "empty.md", "content": ""}))
	if w.Entries[0].Kind != "note" || w.Entries[0].Size != 0 {
		t.Fatalf("an empty note: %+v", w.Entries)
	}

	// create_directory: new, then a noop, then a file in the way.
	w = wrote(t, call("create_directory", map[string]any{"path": "archive/2026"}))
	if len(w.Entries) != 2 || w.Entries[1].Kind != "folder" || w.Noop {
		t.Fatalf("create_directory wrote %+v", w)
	}
	if w = wrote(t, call("create_directory", map[string]any{"path": "archive/2026"})); !w.Noop || len(w.Entries) != 0 {
		t.Fatalf("an existing folder: %+v", w)
	}
	if code := refused(t, call("create_directory", map[string]any{"path": "empty.md"})); code != "exists" {
		t.Fatalf("a file in the way: %s", code)
	}

	// edit_note, with its ctime carried and its mtime the server's.
	before := r.bytesAt(plan)
	w = wrote(t, call("edit_note", map[string]any{"path": "projects/trew/plan.md", "base": plan, "epoch": epoch,
		"edits": []any{map[string]any{"old": "first", "new": "second"}}}))
	edited := w.Entries[0]
	if edited.PreviousUID == nil || *edited.PreviousUID != plan || edited.Kind != "note" {
		t.Fatalf("edit_note wrote %+v", edited)
	}
	r.former(a.cs, "projects/trew/plan.md", plan, before)
	e1, _, _ := r.st.EntryByUID(testVault, plan)
	e2, _, _ := r.st.EntryByUID(testVault, edited.UID)
	if e2.CTime != e1.CTime || e2.MTime < time.Now().Add(-time.Minute).UnixMilli() || e2.Device != "Claude on Mac" {
		t.Fatalf("the edit's times and author: %+v after %+v", e2, e1)
	}

	// append_note and prepend_note, the prepend after a byte-order mark.
	w = wrote(t, call("append_note", map[string]any{"path": "projects/trew/plan.md", "base": edited.UID, "epoch": epoch,
		"text": "- appended\n"}))
	r.former(a.cs, "projects/trew/plan.md", edited.UID, "# Plan\n\nsecond\n")
	appended := w.Entries[0].UID
	bom := r.write("bom.md", "\ufeffbody\n")
	w = wrote(t, call("prepend_note", map[string]any{"path": "bom.md", "base": bom, "epoch": epoch, "text": "top\n"}))
	if got := r.bytesAt(w.Entries[0].UID); got != "\ufefftop\nbody\n" {
		t.Fatalf("prepend wrote %q", got)
	}
	r.former(a.cs, "bom.md", bom, "\ufeffbody\n")

	// Identical bytes are a noop, recorded and revalidated.
	w = wrote(t, call("edit_note", map[string]any{"path": "projects/trew/plan.md", "base": appended, "epoch": epoch,
		"edits": []any{map[string]any{"old": "second", "new": "second"}}}))
	if !w.Noop || len(w.Entries) != 0 || r.head("projects/trew/plan.md") != appended {
		t.Fatalf("a noop: %+v", w)
	}

	// move_note: preview, then apply, with a backlink rewritten in the same
	// operation.
	link := r.write("index.md", "see [[plan]] and [the plan](projects/trew/plan.md)\n")
	args := map[string]any{"path": "projects/trew/plan.md", "base": appended, "to": "done/plan.md", "epoch": epoch}
	p := previewed(t, call("move_note", args))
	if p.Count != 2 {
		t.Fatalf("the move's preview: %s", p.raw)
	}
	w = wrote(t, call("move_note", apply(args, p)))
	var moved, relinked row
	for _, e := range w.Entries {
		switch e.Path {
		case "done/plan.md":
			moved = e
		case "index.md":
			relinked = e
		}
	}
	if moved.PreviousPath != "projects/trew/plan.md" || moved.PreviousUID == nil || *moved.PreviousUID != appended {
		t.Fatalf("the move's row: %+v in %+v", moved, w.Entries)
	}
	if got := r.bytesAt(relinked.UID); got != "see [[done/plan]] and [the plan](done/plan.md)\n" {
		t.Fatalf("the backlink reads %q", got)
	}
	r.former(a.cs, "projects/trew/plan.md", appended, "# Plan\n\nsecond\n- appended\n")
	r.former(a.cs, "index.md", link, "see [[plan]] and [the plan](projects/trew/plan.md)\n")

	// delete_note: the preview lists the backlink that would break, and the
	// apply with markBroken strikes it through.
	indexUID := relinked.UID
	args = map[string]any{"path": "done/plan.md", "base": moved.UID, "epoch": epoch}
	p = previewed(t, call("delete_note", args))
	if p.BrokenLinksComplete == nil || !*p.BrokenLinksComplete || len(p.BrokenLinks) != 1 || p.BrokenLinks[0] != "index.md" {
		t.Fatalf("the deletion's preview: %s", p.raw)
	}
	args["markBroken"] = true
	p = previewed(t, call("delete_note", args))
	w = wrote(t, call("delete_note", apply(args, p)))
	var tomb row
	for _, e := range w.Entries {
		if e.Path == "done/plan.md" {
			tomb = e
		}
	}
	if tomb.Kind != "deletion" || tomb.PreviousUID == nil || *tomb.PreviousUID != moved.UID {
		t.Fatalf("the deletion's row: %+v", w.Entries)
	}
	r.former(a.cs, "done/plan.md", moved.UID, "# Plan\n\nsecond\n- appended\n")
	r.former(a.cs, "index.md", indexUID, "see [[done/plan]] and [the plan](done/plan.md)\n")
	if got := r.bytesAt(r.head("index.md")); !strings.Contains(got, "~~[[done/plan]]~~") {
		t.Fatalf("the backlink was not struck through: %q", got)
	}

	// restore_note: the deleted note's last content, at a new path.
	e := call("restore_note", map[string]any{"path": "done/plan.md", "uid": moved.UID, "to": "restored/plan.md",
		"epoch": epoch})
	w = wrote(t, e)
	var from struct {
		RestoredFrom struct {
			Path string `json:"path"`
			UID  int64  `json:"uid"`
		} `json:"restoredFrom"`
	}
	e.trusted(t, &from)
	if from.RestoredFrom.UID != moved.UID || r.bytesAt(r.head("restored/plan.md")) != "# Plan\n\nsecond\n- appended\n" {
		t.Fatalf("the restore: %s", e.raw)
	}

	// The tag tools: add, remove, manage and rename, each previewed and
	// applied.
	tagged := r.write("tags.md", "---\ntitle: x\n---\nbody #old\n")
	for _, step := range []struct {
		tool string
		args map[string]any
		want string
	}{
		{"add_tags", map[string]any{"paths": []any{"tags.md"}, "tags": []any{"new"}},
			"---\ntitle: x\ntags: [\"new\"]\n---\nbody #old\n"},
		{"remove_tags", map[string]any{"paths": []any{"tags.md"}, "tags": []any{"new"}, "location": "frontmatter"},
			"---\ntitle: x\ntags: []\n---\nbody #old\n"},
		{"manage_tags", map[string]any{"operation": "add", "paths": []any{"tags.md"}, "tags": []any{"more"}},
			"---\ntitle: x\ntags: [\"more\"]\n---\nbody #old\n"},
		{"rename_tag", map[string]any{"oldTag": "old", "newTag": "renamed"},
			"---\ntitle: x\ntags: [\"more\"]\n---\nbody #renamed\n"},
	} {
		was := r.bytesAt(tagged)
		p := previewed(t, call(step.tool, step.args))
		w := wrote(t, call(step.tool, apply(step.args, p)))
		if len(w.Entries) != 1 || w.Entries[0].PreviousUID == nil || *w.Entries[0].PreviousUID != tagged {
			t.Fatalf("%s wrote %+v", step.tool, w.Entries)
		}
		tagged = w.Entries[0].UID
		if got := r.bytesAt(tagged); got != step.want {
			t.Fatalf("%s wrote %q, want %q", step.tool, got, step.want)
		}
		r.former(a.cs, "tags.md", *w.Entries[0].PreviousUID, was)
	}
}

// The schemas are strict and the path policies hold: an unknown argument, a
// missing epoch or base, a path the rules refuse, a format an agent may not
// edit, a reserved name, and the Syncidian fixture, a note created and moved
// into .obsidian/plugins as executable code (plan/research/README.md
// section 5). Each is refused and writes nothing.
func TestWriteArgumentsAreStrictAndThePathPoliciesHold(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	epoch := r.epoch()
	note := r.write("note.md", "text\n")
	r.write("drawing.excalidraw.md", "drawing\n")
	head := r.head("note.md")
	for _, c := range []struct {
		tool string
		args map[string]any
		want string
	}{
		{"create_note", map[string]any{"path": "a.md", "content": "x", "extra": 1}, "invalid_arguments"},
		{"create_note", map[string]any{"path": "a.md"}, "invalid_arguments"},
		{"edit_note", map[string]any{"path": "note.md", "base": note, "edits": []any{map[string]any{"old": "t", "new": "T"}}}, "invalid_arguments"},
		{"edit_note", map[string]any{"path": "note.md", "epoch": epoch, "edits": []any{map[string]any{"old": "t", "new": "T"}}}, "invalid_arguments"},
		{"edit_note", map[string]any{"path": "note.md", "base": note, "epoch": epoch, "edits": []any{map[string]any{"old": "t", "new": "T", "x": 1}}}, "invalid_arguments"},
		{"edit_note", map[string]any{"path": "note.md", "base": note, "epoch": epoch, "edits": []any{}}, "invalid_arguments"},
		{"append_note", map[string]any{"path": "note.md", "base": note, "epoch": epoch, "text": ""}, "invalid_text"},
		{"create_note", map[string]any{"path": ".obsidian/plugins/x/main.md", "content": "x"}, "badpath"},
		{"create_note", map[string]any{"path": "plugins/main.js", "content": "alert(1)"}, "unsupported_format"},
		{"create_note", map[string]any{"path": "a/x.trew-tmp-1.md", "content": "x"}, "reserved_name"},
		{"create_note", map[string]any{"path": "n (Conflicted copy phone 202609101200).md", "content": "x"}, "reserved_name"},
		{"create_note", map[string]any{"path": "note.md", "content": "x"}, "exists"},
		{"create_note", map[string]any{"path": "Note.md", "content": "x"}, "collision"},
		{"create_note", map[string]any{"path": "note.md/child.md", "content": "x"}, "exists"},
		{"edit_note", map[string]any{"path": "drawing.excalidraw.md", "base": 2, "epoch": epoch, "edits": []any{map[string]any{"old": "d", "new": "D"}}}, "unsupported_format"},
		{"move_note", map[string]any{"path": "note.md", "base": note, "to": ".obsidian/plugins/x/main.js", "epoch": epoch}, "badpath"},
		{"move_note", map[string]any{"path": "note.md", "base": note, "to": "plugins/x/main.js", "epoch": epoch}, "unsupported_format"},
		{"move_note", map[string]any{"path": "note.md", "base": note, "to": "note.md", "epoch": epoch}, "same_destination"},
		{"move_note", map[string]any{"path": "note.md", "base": note, "to": "x.md", "epoch": epoch, "changes": []any{}}, "invalid_arguments"},
		{"restore_note", map[string]any{"path": "note.md", "uid": note, "to": "Note.md", "epoch": epoch}, "same_destination"},
		{"add_tags", map[string]any{"paths": []any{"../x.md"}, "tags": []any{"t"}}, "badpath"},
		{"manage_tags", map[string]any{"operation": "add", "paths": []any{"note.md"}, "tags": []any{"t"}, "patterns": []any{"x*"}}, "invalid_arguments"},
		{"create_note", map[string]any{"path": "k.md", "content": "x", "idempotencyKey": "a\nb"}, "invalid_arguments"},
	} {
		e := invoke(t, a.cs, c.tool, c.args)
		if got := refused(t, e); got != c.want {
			t.Errorf("%s %v: %s, want %s: %s", c.tool, c.args, got, c.want, e.raw)
		}
	}
	if r.head("note.md") != head || r.operations() != 0 {
		t.Fatalf("a refused call wrote something: head %d, %d operations", r.head("note.md"), r.operations())
	}
}

// A stale base is refused with the path's own current uid, and a commit to
// another note never makes a write stale (plan/research/README.md section 5).
func TestAStaleBaseIsRefusedWithThePathsOwnUID(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	first := r.write("a.md", "one\n")
	second := r.write("a.md", "two\n")
	r.write("b.md", "elsewhere\n")
	e := invoke(t, a.cs, "append_note", map[string]any{"path": "a.md", "base": first, "epoch": r.epoch(), "text": "x"})
	var f struct {
		Error ToolError `json:"error"`
	}
	e.trusted(t, &f)
	if refused(t, e) != "stale" || f.Error.CurrentUID == nil || *f.Error.CurrentUID != second || f.Error.Path != "a.md" {
		t.Fatalf("a stale base: %s", e.raw)
	}
	if w := wrote(t, invoke(t, a.cs, "append_note", map[string]any{"path": "a.md", "base": second, "epoch": r.epoch(),
		"text": "x"})); w.Entries[0].UID <= second {
		t.Fatalf("the current base: %+v", w)
	}
	if got := r.bytesAt(r.head("a.md")); got != "two\nx" {
		t.Fatalf("a.md reads %q", got)
	}
}

// Seventeen agents edit one note from one base at once: exactly one commits,
// and the other sixteen are stale with nothing written (plan/mcp-tools.md,
// "Tests the port must carry").
func TestSeventeenCompetingEditsOneSucceedsSixteenAreStale(t *testing.T) {
	r := newRig(t, withLimits(Limits{InFlight: 64, TokenInFlight: 32, TokenBurst: 100, TokenRate: 100}))
	a := r.writer("agent")
	base := r.write("race.md", "the line\n")
	epoch := r.epoch()
	var wg sync.WaitGroup
	results := make([]envelope, 17)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = invoke(t, a.cs, "edit_note", map[string]any{"path": "race.md", "base": base, "epoch": epoch,
				"edits": []any{map[string]any{"old": "the line", "new": fmt.Sprintf("edit %d", i)}}})
		}(i)
	}
	wg.Wait()
	won, stale := 0, 0
	for _, e := range results {
		switch {
		case !e.isError:
			won++
		case e.errorCode() == "stale":
			stale++
		default:
			t.Errorf("an edit ended %s", e.raw)
		}
	}
	if won != 1 || stale != 16 {
		t.Fatalf("%d won and %d were stale", won, stale)
	}
	history, err := r.st.HistoryForPath(testVault, "race.md", 0, 100)
	if err != nil || len(history) != 2 {
		t.Fatalf("race.md has %d versions: %v", len(history), err)
	}
	if r.operations() != 1 {
		t.Fatalf("%d operations were recorded", r.operations())
	}
}

// The same request under the same key is answered with the recorded result,
// byte for byte, and writes nothing more; the same key for a different request
// is key_reused. A retry after the reply was lost is exactly this.
func TestAnIdempotencyKeyReplaysTheRecordedResult(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	base := r.write("log.md", "start\n")
	args := map[string]any{"path": "log.md", "base": base, "epoch": r.epoch(), "text": "one line\n",
		"idempotencyKey": "append-1"}
	first := invoke(t, a.cs, "append_note", args)
	w := wrote(t, first)
	// The reply is lost; the agent sends the same request again, spelled
	// differently: the digest is of the canonical request.
	respelled := map[string]any{"text": "one line\n", "idempotencyKey": "append-1", "epoch": r.epoch(),
		"base": float64(base), "path": "log.md"}
	again := invoke(t, a.cs, "append_note", respelled)
	if !bytes.Equal(first.raw, again.raw) {
		t.Fatalf("the replay differs:\n%s\n%s", first.raw, again.raw)
	}
	if got := r.bytesAt(r.head("log.md")); got != "start\none line\n" || r.operations() != 1 {
		t.Fatalf("the replay wrote again: %q, %d operations", got, r.operations())
	}
	args["text"] = "another line\n"
	if code := refused(t, invoke(t, a.cs, "append_note", args)); code != "key_reused" {
		t.Fatalf("a reused key: %s", code)
	}
	// Without a key the retry is a new request, and the base stops it.
	delete(args, "idempotencyKey")
	args["text"] = "one line\n"
	if code := refused(t, invoke(t, a.cs, "append_note", args)); code != "stale" {
		t.Fatalf("a keyless retry: %s", code)
	}
	if w.Entries[0].UID != r.head("log.md") {
		t.Fatal("something else committed")
	}
}

// Preview-then-apply is bound to the preview's head: a backlink a device
// writes between the two refuses the whole apply, as does a namespace change,
// and changes the agent did not preview; the apply after a fresh preview
// commits.
func TestAnApplyIsBoundToItsPreviewsHead(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	epoch := r.epoch()
	src := r.write("topic.md", "the topic\n")
	r.write("one.md", "see [[topic]]\n")
	args := map[string]any{"path": "topic.md", "base": src, "to": "subject.md", "epoch": epoch}

	p := previewed(t, invoke(t, a.cs, "move_note", args))
	r.write("two.md", "also [[topic]]\n") // a new backlink after the preview
	if code := refused(t, invoke(t, a.cs, "move_note", apply(args, p))); code != "plan_changed" {
		t.Fatalf("a new backlink: %s", code)
	}

	p = previewed(t, invoke(t, a.cs, "move_note", args))
	r.write("elsewhere/topic.md", "a second topic, so [[topic]] means two notes\n") // a namespace change
	if code := refused(t, invoke(t, a.cs, "move_note", apply(args, p))); code != "plan_changed" {
		t.Fatalf("a namespace change: %s", code)
	}

	// Now both backlinks are ambiguous, left alone and counted, and the plan
	// is the move alone. Changes other than the preview's are refused.
	p = previewed(t, invoke(t, a.cs, "move_note", args))
	if p.Count != 1 || p.AmbiguousLinks != 3 {
		t.Fatalf("the preview after the namespace change: %s", p.raw)
	}
	tampered := apply(args, p)
	change := map[string]any{}
	for k, v := range p.Changes[0].(map[string]any) {
		change[k] = v
	}
	change["to"] = "somewhere/else.md"
	tampered["changes"] = []any{change}
	if code := refused(t, invoke(t, a.cs, "move_note", tampered)); code != "plan_changed" {
		t.Fatalf("changes the preview did not show: %s", code)
	}
	if r.head("topic.md") != src || r.operations() != 0 {
		t.Fatal("a refused apply wrote something")
	}
	w := wrote(t, invoke(t, a.cs, "move_note", apply(args, p)))
	if w.Count != 1 || w.Entries[0].Path != "subject.md" {
		t.Fatalf("the apply wrote %+v", w.Entries)
	}
}

// A write token revoked after its call is prepared and before it commits
// loses at the commit boundary: nothing is committed and the reply is 401
// (PLAN.md section 2.3.1).
func TestATokenRevokedMidFlightLosesAtTheCommitBoundary(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	base := r.write("n.md", "before\n")
	r.h.seam = func(point string) {
		if point == SeamBodies {
			if err := r.srv.OperatorRevokeMCPToken(testVault, a.tok.ID); err != nil {
				t.Error(err)
			}
		}
	}
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"append_note","arguments":` +
		`{"path":"n.md","base":` + fmt.Sprint(base) + `,"epoch":"` + r.epoch() + `","text":"after"}}}`
	status, _, reply := r.post(legacy(a.token, body))
	if status != http.StatusUnauthorized {
		t.Fatalf("a revoked writer's reply: %d %s", status, reply)
	}
	if r.head("n.md") != base || r.operations() != 0 {
		t.Fatal("a write committed for a token revoked before its commit")
	}
}

// A device connected while the agent writes receives the batch before the
// tool's reply is sent: the broadcast is inside the commit lock, and the
// reply after it.
func TestADeviceReceivesTheWriteBeforeTheReply(t *testing.T) {
	r := newRig(t)
	a := r.writer("Claude on Mac")
	d := r.device("phone")
	var got store.Entry
	var gotErr error
	r.h.beforeReply = func() {
		uid, _ := r.st.LatestUID(testVault)
		got, gotErr = d.batchWith(uid, 10*time.Second)
	}
	w := wrote(t, invoke(t, a.cs, "create_note", map[string]any{"path": "from-agent.md", "content": "hello\n"}))
	r.h.beforeReply = nil
	if gotErr != nil {
		t.Fatalf("the device had not received the write when the reply was sent: %v", gotErr)
	}
	if got.UID != w.Entries[0].UID || got.Device != "Claude on Mac" || got.Path != "from-agent.md" {
		t.Fatalf("the device received %+v", got)
	}
}

// The token's label is the author of what it writes: note_history lists it,
// the entries a device receives carry it (which is what a conflict copy on
// the device is named after), and the author is never a device, in
// delivery_status or vault_status (PLAN.md M5 task 8).
func TestTheAgentsLabelIsTheAuthorAndNeverADevice(t *testing.T) {
	r := newRig(t)
	a := r.writer("Claude on Mac")
	r.device("phone")
	base := r.write("n.md", "one\n")
	wrote(t, invoke(t, a.cs, "append_note", map[string]any{"path": "n.md", "base": base, "epoch": r.epoch(), "text": "two\n"}))
	e := invoke(t, a.cs, "note_history", map[string]any{"path": "n.md"})
	var h struct {
		Versions []struct {
			Device string `json:"device"`
		} `json:"versions"`
	}
	e.untrusted(t, &h)
	if len(h.Versions) != 2 || h.Versions[0].Device != "Claude on Mac" || h.Versions[1].Device != "laptop" {
		t.Fatalf("note_history: %s", e.raw)
	}
	for _, tool := range []string{"delivery_status", "vault_status"} {
		e := invoke(t, a.cs, tool, nil)
		var s struct {
			Devices []struct {
				Name string `json:"name"`
			} `json:"devices"`
		}
		e.untrusted(t, &s)
		if len(s.Devices) != 1 || s.Devices[0].Name != "phone" {
			t.Fatalf("%s lists %s", tool, e.Untrusted)
		}
	}
}

// lookup_operation says what one of the token's own operations did, and knows
// nothing of another token's.
func TestLookupOperationResolvesAnOperationByItsID(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	other := r.writer("other")
	base := r.write("n.md", "one\n")
	w := wrote(t, invoke(t, a.cs, "append_note", map[string]any{"path": "n.md", "base": base, "epoch": r.epoch(),
		"text": "two\n", "idempotencyKey": "k1"}))
	e := invoke(t, a.cs, "lookup_operation", map[string]any{"opId": w.OpID})
	var found struct {
		Found           bool   `json:"found"`
		Tool            string `json:"tool"`
		Outcome         string `json:"outcome"`
		ReplayableUntil int64  `json:"replayableUntil"`
		IdempotencyKey  string `json:"idempotencyKey"`
	}
	e.trusted(t, &found)
	var paths struct {
		Paths []struct {
			Role      string `json:"role"`
			Path      string `json:"path"`
			BeforeUID *int64 `json:"beforeUid"`
			AfterUID  int64  `json:"afterUid"`
		} `json:"paths"`
	}
	e.untrusted(t, &paths)
	if !found.Found || found.Tool != "append_note" || found.Outcome != "committed" || found.ReplayableUntil == 0 ||
		found.IdempotencyKey != "k1" || len(paths.Paths) != 1 || *paths.Paths[0].BeforeUID != base ||
		paths.Paths[0].AfterUID != w.Entries[0].UID {
		t.Fatalf("lookup_operation: %s", e.raw)
	}
	for _, q := range []struct {
		who *agent
		id  string
	}{{other, w.OpID}, {a, "not-an-id"}, {a, strings.Repeat("A", 22)}} {
		e := invoke(t, q.who.cs, "lookup_operation", map[string]any{"opId": q.id})
		e.trusted(t, &found)
		if e.isError || found.Found || bytes.Contains(e.raw, []byte("n.md")) {
			t.Fatalf("lookup_operation of %q by %s: %s", q.id, q.who.label, e.raw)
		}
	}
}

// An outcome the store cannot state is reported as unknown, with the
// operation's id and key and what to do, and never as a refusal. The COMMIT
// itself is made to fail, by a deferred foreign key a trigger breaks, so the
// transaction is complete and rolled back: the harder case, the agent told
// "unknown" and nothing in fact committed. lookup_operation then finds
// nothing, and a retry with the same key commits once.
func TestAnUnknownOutcomeIsNeverReportedAsARefusal(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	base := r.write("n.md", "one\n")
	for _, stmt := range []string{
		`CREATE TABLE commit_fault_parent (id TEXT PRIMARY KEY)`,
		`CREATE TABLE commit_fault (op TEXT REFERENCES commit_fault_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
		`CREATE TRIGGER commit_fault_on_op AFTER INSERT ON operations BEGIN INSERT INTO commit_fault VALUES (NEW.id); END`,
	} {
		if err := r.st.ExecForTest(stmt); err != nil {
			t.Fatal(err)
		}
	}
	args := map[string]any{"path": "n.md", "base": base, "epoch": r.epoch(), "text": "two\n", "idempotencyKey": "k"}
	e := invoke(t, a.cs, "append_note", args)
	var f struct {
		Committed any        `json:"committed"`
		OpID      string     `json:"opId"`
		Key       string     `json:"idempotencyKey"`
		Error     *ToolError `json:"error"`
	}
	e.trusted(t, &f)
	if !e.isError || f.Committed != "unknown" || f.Error.Code != "outcome_unknown" || f.OpID == "" || f.Key != "k" ||
		!strings.Contains(f.Error.Message, "lookup_operation") {
		t.Fatalf("an unknown outcome: %s", e.raw)
	}
	look := invoke(t, a.cs, "lookup_operation", map[string]any{"opId": f.OpID})
	var found struct {
		Found bool `json:"found"`
	}
	look.trusted(t, &found)
	if found.Found {
		t.Fatalf("the operation is recorded: %s", look.raw)
	}
	if err := r.st.ExecForTest(`DROP TRIGGER commit_fault_on_op`); err != nil {
		t.Fatal(err)
	}
	w := wrote(t, invoke(t, a.cs, "append_note", args))
	if got := r.bytesAt(w.Entries[0].UID); got != "one\ntwo\n" || r.operations() != 1 {
		t.Fatalf("the retry: %q, %d operations", got, r.operations())
	}
}

// The per-token budgets answer 429 for writes as for reads, and a device's
// sync, which never passes through the endpoint, keeps committing meanwhile.
func TestWritesPastTheirBudgetGet429AndDevicesKeepSyncing(t *testing.T) {
	r := newRig(t, withLimits(Limits{TokenRate: 0.001, TokenBurst: 3}))
	token, _ := r.token(store.ScopeWrite)
	d := r.device("phone")
	epoch := r.epoch()
	for i := 0; i < 3; i++ {
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_note","arguments":`+
			`{"path":"n%d.md","content":"x","epoch":"%s"}}}`, i, epoch)
		if status, _, reply := r.post(legacy(token, body)); status != http.StatusOK || toolReply(t, reply).isError {
			t.Fatalf("write %d: %d %s", i, status, reply)
		}
	}
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_note","arguments":{"path":"over.md","content":"x"}}}`
	status, h, _ := r.post(legacy(token, body))
	if status != http.StatusTooManyRequests || h.Get("Retry-After") == "" {
		t.Fatalf("a write past the budget: %d", status)
	}
	for i := 0; i < 5; i++ {
		d.put(fmt.Sprintf("phone-%d.md", i), "from the phone\n", 0)
	}
	if _, state, _, _ := r.st.EntryAsOf(testVault, "over.md", 0); state != store.PathAbsent {
		t.Fatal("the refused write committed")
	}
}

// The canonical request's digest is the same for the same request however it
// is spelled, and different for a different one; the key is not part of it.
func TestTheRequestDigestIsCanonical(t *testing.T) {
	digest := func(tool, args string) string {
		t.Helper()
		fields, err := objectFields([]byte(args))
		if err != nil {
			t.Fatal(err)
		}
		d, err := requestDigest(tool, fields)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	a := digest("append_note", `{"path":"a.md","base":5,"text":"x\u00e9","idempotencyKey":"k1"}`)
	for _, same := range []string{
		`{"text":"xé","base":5.0,"path":"a.md"}`,
		`{ "base" : 5e0 , "path" : "a.md", "text": "x\u00E9", "idempotencyKey": "other", "epoch": null }`,
	} {
		if got := digest("append_note", same); got != a {
			t.Errorf("%s digests differently", same)
		}
	}
	for _, other := range []string{
		`{"path":"a.md","base":6,"text":"xé"}`,
		`{"path":"a.md","base":5,"text":"xé","epoch":"e"}`,
	} {
		if got := digest("append_note", other); got == a {
			t.Errorf("%s digests the same", other)
		}
	}
	if digest("prepend_note", `{"path":"a.md","base":5,"text":"xé"}`) == a {
		t.Error("the tool is not part of the digest")
	}
	var nested map[string]any
	_ = json.Unmarshal([]byte(`{"b":1,"a":[{"y":2.0,"x":"s"}]}`), &nested)
	if digest("t", `{"b":1,"a":[{"y":2.0,"x":"s"}]}`) != digest("t", `{"a":[{"x":"s","y":2}],"b":1}`) {
		t.Error("nested objects are not canonical")
	}
}
