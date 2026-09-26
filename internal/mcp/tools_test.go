package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/waynehoover/trewsync/internal/server"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// listRow is a list_notes row as a test reads it.
type listRow struct {
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	UID     int64  `json:"uid"`
	Deleted bool   `json:"deleted"`
}

// listAll pages through list_notes with args, returning every page's rows
// and the head the first page pinned.
func listPages(t *testing.T, cs *sdk.ClientSession, args map[string]any, between func(page int)) ([][]listRow, int64) {
	t.Helper()
	var pages [][]listRow
	var head int64
	for page := 0; ; page++ {
		e := invoke(t, cs, "list_notes", args)
		if e.isError {
			t.Fatalf("list_notes: %s", e.raw)
		}
		var tr struct {
			Head      int64   `json:"head"`
			NextAfter *string `json:"nextAfter"`
		}
		e.trusted(t, &tr)
		var un struct {
			Entries []listRow `json:"entries"`
		}
		e.untrusted(t, &un)
		if page == 0 {
			head = tr.Head
		} else if tr.Head != head {
			t.Fatalf("page %d is of head %d, the first was of %d", page, tr.Head, head)
		}
		pages = append(pages, un.Entries)
		if tr.NextAfter == nil {
			return pages, head
		}
		if between != nil {
			between(page)
		}
		next := map[string]any{}
		for k, v := range args {
			next[k] = v
		}
		next["after"] = *tr.NextAfter
		args = next
		if page > 100 {
			t.Fatal("list_notes never ended")
		}
	}
}

func rowNames(pages [][]listRow) []string {
	var out []string
	for _, p := range pages {
		for _, r := range p {
			out = append(out, fmt.Sprintf("%s@%d", r.Path, r.UID))
		}
	}
	return out
}

// Paging across a concurrent create, deletion, edit and a rename whose source
// is on a later page and whose destination sorts before the cursor: every
// page reads the head the first one pinned, so no row is skipped, none is
// repeated, and the rename leaves no ghost (M4 tasks 7 and 11).
func TestListingPagesAcrossConcurrentCommitsWithoutGhosts(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{"a.md", "b.md", "c.md", "d.md", "e.md"} {
		r.write(p, "text of "+p)
	}
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)
	whole, head := listPages(t, cs, map[string]any{}, nil)

	pages, pinned := listPages(t, cs, map[string]any{"limit": 2}, func(page int) {
		if page != 0 {
			return
		}
		r.write("bb.md", "a create between the pages")
		r.remove("c.md")
		r.write("e.md", "an edit after the pin")
		r.rename("d.md", "a0.md", "moved behind the cursor")
	})
	if pinned != head {
		t.Fatalf("pinned %d, the whole listing was of %d", pinned, head)
	}
	if got, want := rowNames(pages), rowNames(whole); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("paged %v\nwhole %v", got, want)
	}
	if len(pages[0]) != 2 {
		t.Fatalf("the first page held %d rows", len(pages[0]))
	}

	// A fresh listing sees the new world, the rename's source gone from it.
	now, _ := listPages(t, cs, map[string]any{}, nil)
	var paths []string
	for _, r := range now[0] {
		paths = append(paths, r.Path)
	}
	if got := strings.Join(paths, ","); got != "a.md,a0.md,b.md,bb.md,e.md" {
		t.Fatalf("after the commits the vault lists %s", got)
	}
}

func TestListingFiltersKindsAndBounds(t *testing.T) {
	r := newRig(t)
	r.write("f/x.md", "in a folder")
	r.write("f/y.txt", "plain text")
	r.write("f/pic.png", "\x89PNG")
	if _, err := writeEntry(r.st, store.Entry{Path: "f/sub", Folder: true}, nil); err != nil {
		t.Fatal(err)
	}
	r.write("fx/z.md", "a sibling folder whose name starts the same")
	r.write("gone.md", "deleted soon")
	r.remove("gone.md")
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20250618)

	pages, _ := listPages(t, cs, map[string]any{"folder": "f"}, nil)
	var got []string
	for _, row := range pages[0] {
		got = append(got, row.Path+":"+row.Kind)
	}
	if strings.Join(got, ",") != "f/pic.png:attachment,f/sub:folder,f/x.md:note,f/y.txt:note" {
		t.Fatalf("folder f: %v", got)
	}
	// The file name, not the folder: "fx/z.md" is not a match for "x".
	pages, _ = listPages(t, cs, map[string]any{"nameContains": "x"}, nil)
	if got := rowNames(pages); strings.Join(got, ",") != "f/x.md@1,f/y.txt@2" {
		t.Fatalf("nameContains x: %v", got)
	}
	if pages, _ = listPages(t, cs, map[string]any{"nameContains": "X"}, nil); len(pages[0]) != 0 {
		t.Fatalf("nameContains is case-sensitive: %+v", pages[0])
	}
	pages, _ = listPages(t, cs, map[string]any{"includeDeleted": true}, nil)
	var deleted []string
	for _, row := range pages[0] {
		if row.Deleted {
			deleted = append(deleted, row.Path)
		}
	}
	if strings.Join(deleted, ",") != "gone.md" {
		t.Fatalf("includeDeleted listed %v as deleted", deleted)
	}
	if pages, _ = listPages(t, cs, map[string]any{}, nil); strings.Contains(fmt.Sprint(pages), "gone.md") {
		t.Fatal("a deleted path was listed without includeDeleted")
	}
	for _, c := range []struct {
		args map[string]any
		code string
	}{
		{map[string]any{"limit": 0}, "invalid_limit"},
		{map[string]any{"limit": 501}, "invalid_limit"},
		{map[string]any{"limit": "5"}, "invalid_arguments"},
		{map[string]any{"folder": "../etc"}, "badpath"},
		{map[string]any{"folder": ".obsidian"}, "badpath"},
		{map[string]any{"after": "not a cursor"}, "invalid_cursor"},
		{map[string]any{"includeBackups": true}, "invalid_arguments"},
	} {
		if e := invoke(t, cs, "list_notes", c.args); e.errorCode() != c.code {
			t.Errorf("list_notes %v: %s, want %s", c.args, e.raw, c.code)
		}
	}
}

// A continuation is refused, saying why, when it was made for other options
// or for a history a purge has since changed: never read from a different
// world (M4 task 8).
func TestAListingCursorExpiresRatherThanChangingWorlds(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 5; i++ {
		r.write(fmt.Sprintf("n%d.md", i), "first")
		r.write(fmt.Sprintf("n%d.md", i), "second")
	}
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)
	e := invoke(t, cs, "list_notes", map[string]any{"limit": 2})
	var tr struct {
		NextAfter *string `json:"nextAfter"`
	}
	e.trusted(t, &tr)
	if tr.NextAfter == nil {
		t.Fatal("no continuation")
	}
	if e := invoke(t, cs, "list_notes", map[string]any{"limit": 2, "after": *tr.NextAfter, "nameContains": "n"}); e.errorCode() != "invalid_cursor" {
		t.Fatalf("a cursor for other options: %s", e.raw)
	}
	tampered := []byte(*tr.NextAfter)
	tampered[len(tampered)/2] ^= 1
	if e := invoke(t, cs, "list_notes", map[string]any{"limit": 2, "after": string(tampered)}); e.errorCode() != "invalid_cursor" {
		t.Fatalf("a tampered cursor: %s", e.raw)
	}
	if e := invoke(t, cs, "list_notes", map[string]any{"limit": 2, "after": *tr.NextAfter}); e.isError {
		t.Fatalf("the cursor as it was made: %s", e.raw)
	}
	if _, err := r.st.Purge(testVault, 0); err != nil {
		t.Fatal(err)
	}
	e = invoke(t, cs, "list_notes", map[string]any{"limit": 2, "after": *tr.NextAfter})
	if e.errorCode() != "invalid_cursor" || !strings.Contains(string(e.Trusted), "purge") {
		t.Fatalf("a cursor from before a purge: %s", e.raw)
	}
}

type readResult struct {
	Path      string `json:"path"`
	UID       int64  `json:"uid"`
	Source    string `json:"source"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	NextLine  *int   `json:"nextLine"`
	Complete  bool   `json:"complete"`
	Size      int64  `json:"size"`
	Head      int64  `json:"head"`
}

func readPage(t *testing.T, cs *sdk.ClientSession, args map[string]any) (readResult, string, envelope) {
	t.Helper()
	e := invoke(t, cs, "read_note", args)
	var tr readResult
	var un struct {
		Content string `json:"content"`
	}
	if !e.isError {
		e.trusted(t, &tr)
		e.untrusted(t, &un)
	}
	return tr, un.Content, e
}

func TestReadNotePagesVersionsAndRefusals(t *testing.T) {
	r := newRig(t)
	body := "line one\r\nline two\nthird line with a lone \r inside\nlast line without an end"
	v1 := r.write("notes/page.md", body)
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)

	// Pages keep every terminator, and the pages of a note are its bytes.
	var got strings.Builder
	args := map[string]any{"path": "notes/page.md", "maxLines": 2}
	for i := 0; ; i++ {
		tr, content, e := readPage(t, cs, args)
		if e.isError {
			t.Fatalf("page %d: %s", i, e.raw)
		}
		if tr.UID != v1 || tr.Source != "head" {
			t.Fatalf("page %d from uid %d (%s)", i, tr.UID, tr.Source)
		}
		got.WriteString(content)
		if tr.NextLine == nil {
			break
		}
		args = map[string]any{"path": "notes/page.md", "maxLines": 2, "startLine": *tr.NextLine, "base": tr.UID}
	}
	if got.String() != body {
		t.Fatalf("the pages joined are %q, want %q", got.String(), body)
	}

	// A device edit between two pages: the base refuses with the path's own
	// current uid, and the uid reads on in the version the first page was.
	first, _, _ := readPage(t, cs, map[string]any{"path": "notes/page.md", "maxLines": 1})
	v2 := r.write("notes/page.md", "an edit between the pages\n")
	r.write("elsewhere.md", "a commit to another path")
	_, _, stale := readPage(t, cs, map[string]any{"path": "notes/page.md", "startLine": 2, "base": first.UID})
	var sErr struct {
		Error ToolError `json:"error"`
	}
	stale.trusted(t, &sErr)
	if sErr.Error.Code != "stale" || sErr.Error.CurrentUID == nil || *sErr.Error.CurrentUID != v2 || sErr.Error.Path != "notes/page.md" {
		t.Fatalf("a base the head moved past: %s", stale.raw)
	}
	tr, content, _ := readPage(t, cs, map[string]any{"path": "notes/page.md", "startLine": 2, "uid": first.UID})
	if tr.UID != v1 || tr.Source != "history" || content != "line two\nthird line with a lone \r inside\nlast line without an end" {
		t.Fatalf("reading on in the first version: %+v %q", tr, content)
	}
	// A commit to another path never makes a read stale.
	if _, _, e := readPage(t, cs, map[string]any{"path": "notes/page.md", "base": v2}); e.isError {
		t.Fatalf("a base still current: %s", e.raw)
	}

	folder, _ := writeEntry(r.st, store.Entry{Path: "notes/folder", Folder: true}, nil)
	r.write("gone.md", "soon deleted")
	gone := r.remove("gone.md")
	r.write("big.md", strings.Repeat("x", 1<<20+1))
	r.write("wide.md", strings.Repeat("y", 64<<10+1)+"\nshort\n")
	r.write("bad.md", "\xed\xa0\x80 a lone surrogate, encoded")
	r.write("pic.png", "\x89PNG")
	for _, c := range []struct {
		args map[string]any
		code string
	}{
		{map[string]any{"path": "missing.md"}, "not_found"},
		{map[string]any{"path": "gone.md"}, "not_found"},
		{map[string]any{"path": "notes/folder"}, "unsupported_format"},
		{map[string]any{"path": "notes/page.md", "uid": 999999}, "version_not_found"},
		{map[string]any{"path": "elsewhere.md", "uid": v1}, "path_mismatch"},
		{map[string]any{"path": "gone.md", "uid": gone}, "not_note_content"},
		{map[string]any{"path": "big.md"}, "note_too_large"},
		{map[string]any{"path": "wide.md"}, "line_too_large"},
		{map[string]any{"path": "bad.md"}, "invalid_utf8"},
		{map[string]any{"path": "pic.png"}, "unsupported_format"},
		{map[string]any{"path": ".obsidian/app.md"}, "badpath"},
		{map[string]any{"path": "notes/page.md", "maxLines": 1001}, "invalid_limit"},
		{map[string]any{"path": "notes/page.md", "startLine": 0}, "invalid_limit"},
		{map[string]any{}, "invalid_arguments"},
		{map[string]any{"path": strings.Repeat("a", 1025)}, "input_too_large"},
	} {
		if _, _, e := readPage(t, cs, c.args); e.errorCode() != c.code {
			t.Errorf("read_note %v: %s, want %s", c.args, short(string(e.raw)), c.code)
		}
	}
	_ = folder
	// A path past the end is an empty, complete page.
	tr, content, _ = readPage(t, cs, map[string]any{"path": "notes/page.md", "startLine": 50})
	if !tr.Complete || content != "" || tr.EndLine != 49 {
		t.Fatalf("past the end: %+v %q", tr, content)
	}
	// A lone surrogate in an argument is refused, not replaced.
	status, _, raw := r.post(legacy(token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"a\ud800.md"}}}`))
	if e := toolReply(t, raw); status != http.StatusOK || e.errorCode() != "invalid_text" {
		t.Fatalf("a lone surrogate in a path: %s", raw)
	}
}

func TestHistoryDeletionsAndComparisons(t *testing.T) {
	r := newRig(t)
	v1 := r.write("a.md", "one\ntwo\nthree\n")
	v2 := r.write("a.md", "one\n2\nthree\nfour\n")
	moved := r.rename("a.md", "b.md", "one\n2\nthree\nfour\n")
	v4 := r.write("a.md", "reused\n")
	r.write("c.md", "c")
	gone := r.remove("c.md")
	r.write("d.md", "d")
	r.rename("d.md", "e.md", "d")
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)

	e := invoke(t, cs, "note_history", map[string]any{"path": "a.md", "limit": 2})
	var tr struct {
		NextBefore *int64 `json:"nextBefore"`
	}
	e.trusted(t, &tr)
	var un struct {
		Versions []struct {
			UID          int64   `json:"uid"`
			Device       string  `json:"device"`
			PreviousPath *string `json:"previousPath"`
		} `json:"versions"`
	}
	e.untrusted(t, &un)
	if len(un.Versions) != 2 || un.Versions[0].UID != v4 || un.Versions[1].UID != v2 || tr.NextBefore == nil || *tr.NextBefore != v2 {
		t.Fatalf("the first history page: %s", e.raw)
	}
	e = invoke(t, cs, "note_history", map[string]any{"path": "a.md", "before": *tr.NextBefore})
	un.Versions = nil
	e.untrusted(t, &un)
	tr.NextBefore = nil
	e.trusted(t, &tr)
	if len(un.Versions) != 1 || un.Versions[0].UID != v1 || un.Versions[0].Device != "laptop" || tr.NextBefore != nil {
		t.Fatalf("the second history page: %s", e.raw)
	}
	e = invoke(t, cs, "note_history", map[string]any{"path": "b.md"})
	un.Versions = nil
	e.untrusted(t, &un)
	if len(un.Versions) != 1 || un.Versions[0].UID != moved || un.Versions[0].PreviousPath == nil || *un.Versions[0].PreviousPath != "a.md" {
		t.Fatalf("a rename's history: %s", e.raw)
	}

	// Deletions list c.md, restorable from its content, and not the renames.
	e = invoke(t, cs, "deleted_notes", nil)
	var del struct {
		Notes []struct {
			Path       string `json:"path"`
			UID        int64  `json:"uid"`
			Restorable int64  `json:"restorable"`
		} `json:"notes"`
	}
	e.untrusted(t, &del)
	if len(del.Notes) != 1 || del.Notes[0].Path != "c.md" || del.Notes[0].UID != gone || del.Notes[0].Restorable != gone-1 {
		t.Fatalf("deleted_notes: %s", e.raw)
	}

	// Comparing across the rename's history, and paging it with toUid
	// carried from the first page.
	e = invoke(t, cs, "compare_versions", map[string]any{"path": "a.md", "fromUid": v1, "toUid": v2, "limit": 1})
	var cmp struct {
		From         struct{ UID int64 } `json:"from"`
		To           struct{ UID int64 } `json:"to"`
		Identical    bool                `json:"identical"`
		TotalChanges int                 `json:"totalChanges"`
		NextAfter    *int                `json:"nextAfter"`
	}
	e.trusted(t, &cmp)
	var changes struct {
		Changes []struct {
			FromLine int    `json:"fromLine"`
			Old      string `json:"old"`
			New      string `json:"new"`
		} `json:"changes"`
	}
	e.untrusted(t, &changes)
	if cmp.TotalChanges != 2 || cmp.NextAfter == nil || len(changes.Changes) != 1 || changes.Changes[0].Old != "two\n" || changes.Changes[0].New != "2\n" {
		t.Fatalf("the first comparison page: %s", e.raw)
	}
	e = invoke(t, cs, "compare_versions", map[string]any{"path": "a.md", "fromUid": v1, "toUid": v2, "after": *cmp.NextAfter})
	changes.Changes = nil
	e.untrusted(t, &changes)
	if len(changes.Changes) != 1 || changes.Changes[0].New != "four\n" {
		t.Fatalf("the second comparison page: %s", e.raw)
	}
	// Against the head, which the result names so later pages can.
	e = invoke(t, cs, "compare_versions", map[string]any{"path": "a.md", "fromUid": v4})
	cmp = struct {
		From         struct{ UID int64 } `json:"from"`
		To           struct{ UID int64 } `json:"to"`
		Identical    bool                `json:"identical"`
		TotalChanges int                 `json:"totalChanges"`
		NextAfter    *int                `json:"nextAfter"`
	}{}
	e.trusted(t, &cmp)
	if !cmp.Identical || cmp.To.UID != v4 || cmp.TotalChanges != 0 {
		t.Fatalf("a version against the head it is: %s", e.raw)
	}
	for _, c := range []struct {
		args map[string]any
		code string
	}{
		{map[string]any{"path": "a.md", "fromUid": v1, "after": 1}, "invalid_cursor"},
		{map[string]any{"path": "a.md"}, "invalid_arguments"},
		{map[string]any{"path": "a.md", "fromUid": moved}, "path_mismatch"},
		{map[string]any{"path": "c.md", "fromUid": gone}, "not_note_content"},
		{map[string]any{"path": "c.md", "fromUid": gone - 1}, "not_found"},
		{map[string]any{"path": "a.md", "fromUid": v1, "limit": 101}, "invalid_limit"},
		{map[string]any{"path": "a.md", "fromUid": v1, "after": 1_000_001, "toUid": v2}, "invalid_limit"},
	} {
		if e := invoke(t, cs, "compare_versions", c.args); e.errorCode() != c.code {
			t.Errorf("compare_versions %v: %s, want %s", c.args, e.raw, c.code)
		}
	}

	// A comparison too large for the line table is one coarse change.
	var before, after strings.Builder
	for i := 0; i < 1100; i++ {
		fmt.Fprintf(&before, "old %d\n", i)
		fmt.Fprintf(&after, "new %d\n", i)
	}
	c1 := r.write("coarse.md", before.String())
	c2 := r.write("coarse.md", after.String())
	e = invoke(t, cs, "compare_versions", map[string]any{"path": "coarse.md", "fromUid": c1, "toUid": c2})
	var coarse struct {
		Coarse       bool `json:"coarse"`
		TotalChanges int  `json:"totalChanges"`
	}
	e.trusted(t, &coarse)
	if !coarse.Coarse || coarse.TotalChanges != 1 {
		t.Fatalf("a difference over the cell cap: %s", short(string(e.raw)))
	}
}

// deviceSession connects a registered device over the real WebSocket and
// confirms it has applied through uid, so delivery status has a live peer.
func deviceSession(t *testing.T, r *rig, name string, applied int64) {
	t.Helper()
	raw := sha256.Sum256([]byte("device token for " + name))
	id := "dev-" + name
	if err := r.st.RegisterDevice(testVault, id, name, store.HashToken(raw[:]), 1); err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(server.HTTPHandler(r.srv, slogDiscard()))
	t.Cleanup(hs.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(hs.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	conn.SetReadLimit(server.ReadLimit)
	send := func(v any) {
		b, _ := json.Marshal(v)
		if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	read := func(want string) {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %s: %v", want, err)
			}
			var m struct {
				Res string `json:"res"`
				Op  string `json:"op"`
			}
			_ = json.Unmarshal(data, &m)
			if m.Res == want || m.Op == want {
				return
			}
		}
	}
	send(wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Vault: testVault, Device: name, DeviceID: id, Token: store.EncodeToken(raw[:])})
	read("ready")
	read("caught-up")
	send(wire.In{Op: "applied", ID: 2, Applied: &applied})
	read("applied")
}

// Delivery status comes from the hub's live checkpoints and lists devices,
// never an MCP token's author row (PLAN.md section 3.3).
func TestDeliveryStatusIsTheDevicesAndNeverAnAgent(t *testing.T) {
	r := newRig(t)
	head := r.write("a.md", "a")
	token, _ := r.token(store.ScopeRead)
	if err := r.st.RegisterDevice(testVault, "dev-offline", "offline phone", store.HashToken([]byte("0123456789abcdef0123456789abcdef")), 1); err != nil {
		t.Fatal(err)
	}
	deviceSession(t, r, "laptop", head)
	deviceSession(t, r, "behind", head-1)
	cs := r.mustConnect(token, Version20251125)
	for _, tool := range []string{"delivery_status", "vault_status"} {
		e := invoke(t, cs, tool, nil)
		var un struct {
			Devices []struct {
				ID      string `json:"id"`
				Name    string `json:"name"`
				Online  bool   `json:"online"`
				Applied *int64 `json:"applied"`
				State   string `json:"state"`
			} `json:"devices"`
		}
		e.untrusted(t, &un)
		states := map[string]string{}
		for _, d := range un.Devices {
			states[d.Name] = d.State
			if strings.HasPrefix(d.Name, "agent") {
				t.Errorf("%s lists an MCP author as a device: %+v", tool, d)
			}
		}
		if states["laptop"] != "received" || states["behind"] != "waiting" || states["offline phone"] != "unconfirmed" || len(states) != 3 {
			t.Fatalf("%s: %s", tool, e.Untrusted)
		}
	}
}

func TestVaultStatusCountsTheVault(t *testing.T) {
	r := newRig(t)
	r.write("a.md", "12345")
	r.write("b.txt", "123")
	r.write("pic.png", "1234567")
	if _, err := writeEntry(r.st, store.Entry{Path: "folder", Folder: true}, nil); err != nil {
		t.Fatal(err)
	}
	r.write("gone.md", "x")
	r.remove("gone.md")
	r.rename("b.txt", "c.txt", "123")
	r.indexed()
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20260728)
	e := invoke(t, cs, "vault_status", nil)
	var tr struct {
		Vault         string `json:"vault"`
		Head          int64  `json:"head"`
		Epoch         string `json:"epoch"`
		Entries       int64  `json:"entries"`
		Notes         int64  `json:"notes"`
		Attachments   int64  `json:"attachments"`
		Folders       int64  `json:"folders"`
		Deleted       int64  `json:"deleted"`
		Bytes         int64  `json:"bytes"`
		ServerVersion string `json:"serverVersion"`
		Index         struct {
			Fresh       bool  `json:"fresh"`
			IndexedHead int64 `json:"indexedHead"`
			Usable      bool  `json:"usable"`
		} `json:"index"`
	}
	e.trusted(t, &tr)
	if tr.Vault != testVault || tr.Head != 7 || tr.Epoch != r.st.Epoch() || tr.Entries != 7 || tr.Notes != 2 ||
		tr.Attachments != 1 || tr.Folders != 1 || tr.Deleted != 1 || tr.Bytes != 15 || tr.ServerVersion != "test-version" {
		t.Fatalf("vault_status %s", e.Trusted)
	}
	if !tr.Index.Fresh || !tr.Index.Usable || tr.Index.IndexedHead != 7 {
		t.Fatalf("the index of a caught-up vault: %s", e.Trusted)
	}
}

func slogDiscard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
