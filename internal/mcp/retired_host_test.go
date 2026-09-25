package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/store"
)

// The guarantees of the headless client's retired MCP server (`trew mcp`,
// client/src/node/mcp*.test.ts) that no Go test held when it was deleted,
// ported to the server's /mcp. docs/development.md, "Retiring trew mcp",
// is the ledger that names where each of its cases went.

// A store that cannot be read at the door is 503 "unavailable" and nothing
// else: no tool runs, the reply names no vault, token or store, and the log
// says the store failed without carrying the token or the data directory.
// The same token works once the store can be read again, so the refusal was
// the store's and not the credential's. From mcp-http.test.ts, "an unreadable
// credential refuses HTTP with 503 before any tool runs", whose credential
// was a file.
func TestAStoreThatCannotBeReadAnswers503BeforeAnyTool(t *testing.T) {
	r := newRig(t)
	var dispatched atomic.Int64
	r.h.duringTool = func(string) { dispatched.Add(1) }
	token, _ := r.token(store.ScopeRead)
	if err := r.st.ExecForTest(`ALTER TABLE mcp_tokens RENAME TO mcp_tokens_unreadable`); err != nil {
		t.Fatal(err)
	}
	status, h, body := r.post(legacy(token, toolCall("vault_status")))
	if status != http.StatusServiceUnavailable || string(body) != "unavailable" {
		t.Fatalf("a store that cannot be read: %d %q", status, body)
	}
	all := string(body) + fmt.Sprint(h)
	for _, secret := range []string{token, testVault, "vault_status", "mcp_tokens", r.dir} {
		if strings.Contains(all, secret) {
			t.Errorf("the 503 names %q: %s", secret, all)
		}
	}
	if n := dispatched.Load(); n != 0 {
		t.Fatalf("%d tools ran behind a store that could not authenticate", n)
	}
	logs := r.logs.String()
	if !strings.Contains(logs, "MCP authentication could not read the store") {
		t.Errorf("the log does not say the store failed:\n%s", logs)
	}
	for _, secret := range []string{token, r.dir} {
		if strings.Contains(logs, secret) {
			t.Errorf("the log carries %q:\n%s", secret, logs)
		}
	}
	if err := r.st.ExecForTest(`ALTER TABLE mcp_tokens_unreadable RENAME TO mcp_tokens`); err != nil {
		t.Fatal(err)
	}
	if status, _, body := r.post(legacy(token, toolCall("vault_status"))); status != http.StatusOK {
		t.Fatalf("the same token once the store reads: %d %s", status, body)
	}
	if n := dispatched.Load(); n != 1 {
		t.Fatalf("dispatched %d, want the one call after the store came back", n)
	}
}

// The endpoint is exactly /mcp: another path, a trailing slash, another case
// or any query string, an empty one included, is 404 with an empty body and
// nothing dispatched, even with a valid token, so no credential or argument
// is ever taken from a URL, where proxies log it. Driven through the handler
// itself, because a mux in front of it would refuse most of these before the
// handler's own check ran. From mcp-http.test.ts, "checks exact origins
// before auth and refuses every other route without exposing state".
func TestOnlyExactlySlashMCPIsServed(t *testing.T) {
	r := newRig(t)
	var dispatched atomic.Int64
	r.h.duringTool = func(string) { dispatched.Add(1) }
	token, _ := r.token(store.ScopeRead)
	send := func(target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(toolCall("vault_status")))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Mcp-Protocol-Version", Version20251125)
		w := httptest.NewRecorder()
		r.h.ServeHTTP(w, req)
		return w
	}
	for _, target := range []string{
		"/mcp?key=" + token, "/mcp?", "/mcp?x=1", "/mcp/", "/MCP", "/mcp/tools", "/", "/.trew/mcp-token.json",
	} {
		if w := send(target); w.Code != http.StatusNotFound || w.Body.Len() != 0 {
			t.Errorf("%s: %d %q", target, w.Code, w.Body.String())
		}
	}
	if n := dispatched.Load(); n != 0 {
		t.Fatalf("%d tools ran for a route other than /mcp", n)
	}
	if w := send("/mcp"); w.Code != http.StatusOK || dispatched.Load() != 1 {
		t.Fatalf("/mcp itself: %d, dispatched %d: %s", w.Code, dispatched.Load(), w.Body.String())
	}
	if strings.Contains(r.logs.String(), token) {
		t.Fatalf("the log carries the token from a query string:\n%s", r.logs.String())
	}
}

// hangUp posts body to handler at /mcp with token and hangs up once reached
// is closed, returning when the handler has finished with the request.
// whileHeld, if not nil, runs on the test's goroutine after reached and
// before the hang-up, while the handler is still held. release is closed
// after the client is gone, so what the handler does next it does for a
// client that is no longer there.
func hangUp(t *testing.T, handler http.Handler, token, body string, reached, release chan struct{}, whileHeld func()) {
	t.Helper()
	done := make(chan struct{})
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		defer close(done)
		handler.ServeHTTP(w, req)
	}))
	defer hs.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hs.URL+"/mcp", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Mcp-Protocol-Version", Version20251125)
	answered := make(chan error, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		answered <- err
	}()
	select {
	case <-reached:
	case err := <-answered:
		t.Fatalf("the request was answered before it was held: %v", err)
	case <-time.After(30 * time.Second):
		t.Fatal("the request never reached its hold")
	}
	if whileHeld != nil {
		whileHeld()
	}
	cancel()
	if err := <-answered; err == nil {
		t.Fatal("the client hung up and still had a reply")
	}
	close(release)
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the handler did not finish after its client hung up")
	}
}

// A client that hangs up in the middle of a read gives its slot back once
// the handler has finished, so the token's next call is served rather than
// refused 429 for ever. From mcp.test.ts, "serves a cancelled search without
// losing the next request", and the surviving half of mcp-protocol.test.ts's
// cancellation cases, whose admission queue the server does not have.
func TestAClientThatHangsUpMidReadGivesItsSlotBack(t *testing.T) {
	r := newRig(t, withLimits(Limits{TokenInFlight: 1}))
	token, _ := r.token(store.ScopeRead)
	r.write("n.md", "text\n")
	reached, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var held atomic.Bool
	r.h.duringTool = func(tool string) {
		if tool != "read_note" {
			return
		}
		once.Do(func() {
			held.Store(true)
			close(reached)
			<-release
		})
	}
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"n.md"}}}`
	// While the read is held its token's one slot is taken: the cap is real,
	// so the slot coming back below is the held call's. The probe runs
	// inside hangUp's hold, before the hang-up, not beside it: a probe that
	// lands after the release sees the slot already given back.
	hangUp(t, r.h, token, body, reached, release, func() {
		if status, _, reply := r.post(legacy(token, toolCall("vault_status"))); status != http.StatusTooManyRequests {
			t.Fatalf("a second call while the first is held: %d %s, want 429", status, reply)
		}
	})
	if !held.Load() {
		t.Fatal("the read was never held")
	}
	// hangUp returns only after the handler's ServeHTTP has, and its deferred
	// release gives the slot back before that, so the very next call is
	// served: no retrying, no waiting.
	if status, _, reply := r.post(legacy(token, toolCall("vault_status"))); status != http.StatusOK {
		t.Fatalf("the token's next call after a hang-up: %d %s", status, reply)
	}
}

// A client that hangs up during an admitted write, at each seam of it, while
// the server keeps running: the write commits once or not at all, never
// twice and never in part, and the retry under the same key is one result,
// the same bytes each time, with the displaced version still readable. From
// mcp-http-process.test.ts, "a dropped connection and SIGTERM ... retain the
// lock and both versions until the write drains", and
// mcp-http-concurrency.test.ts, "ending a session ... lets its admitted
// transaction finish". A killed server is cmd/trewd/crash_test.go.
func TestAClientThatHangsUpMidWriteCommitsAtMostOnce(t *testing.T) {
	for _, seam := range []string{SeamBodies, SeamCommitted, SeamBroadcast} {
		t.Run(seam, func(t *testing.T) {
			r := newRig(t)
			a := r.writer("agent")
			base := r.write("log.md", "start\n")
			args := map[string]any{"path": "log.md", "base": base, "epoch": r.epoch(), "text": "one line\n",
				"idempotencyKey": "hang-up-" + seam}
			encoded, err := json.Marshal(args)
			if err != nil {
				t.Fatal(err)
			}
			body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"append_note","arguments":` +
				string(encoded) + `}}`
			reached, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			r.h.seam = func(point string) {
				if point == seam {
					once.Do(func() {
						close(reached)
						<-release
					})
				}
			}
			hangUp(t, r.h, a.token, body, reached, release, nil)
			switch got, ops := r.bytesAt(r.head("log.md")), r.operations(); {
			case got == "start\n" && ops == 0:
			case got == "start\none line\n" && ops == 1:
			default:
				t.Fatalf("after a hang-up at %s the note is %q with %d operations", seam, got, ops)
			}
			retry := invoke(t, a.cs, "append_note", args)
			w := wrote(t, retry)
			if got := r.bytesAt(r.head("log.md")); got != "start\none line\n" || r.operations() != 1 {
				t.Fatalf("the retry after a hang-up at %s: %q with %d operations", seam, got, r.operations())
			}
			if again := invoke(t, a.cs, "append_note", args); !bytes.Equal(again.raw, retry.raw) {
				t.Fatalf("a second retry differs:\n%s\n%s", retry.raw, again.raw)
			}
			if len(w.Entries) != 1 || w.Entries[0].PreviousUID == nil || *w.Entries[0].PreviousUID != base {
				t.Fatalf("the retry's entries: %+v", w.Entries)
			}
			r.former(a.cs, "log.md", base, "start\n")
		})
	}
}

// restore_note's own refusals write nothing: a version that is a folder or a
// deletion, a version of another path, a version too large or not UTF-8 to
// be a note, and a destination that holds a live note. From mcp-history.test.ts,
// "rejects non-content, oversized, corrupt and invalid UTF-8 historical
// bodies before publication", and mcp.test.ts's restore onto a taken path.
func TestRestoreNoteRefusesWhatIsNotANoteAndWritesNothing(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	epoch := r.epoch()
	note := r.write("note.md", "text\n")
	r.write("other.md", "someone else's\n")
	folder, err := writeEntry(r.st, store.Entry{Path: "folder", Folder: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.write("gone.md", "was here\n")
	gone := r.remove("gone.md")
	big := r.write("big.md", strings.Repeat("x", 1<<20+1))
	bad := r.write("bad.md", "\xff\xfe not text\n")
	heads := map[string]int64{}
	for _, p := range []string{"note.md", "other.md", "big.md", "bad.md"} {
		heads[p] = r.head(p)
	}
	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"path": "folder", "uid": folder, "to": "from-folder.md", "epoch": epoch}, "not_note_content"},
		{map[string]any{"path": "gone.md", "uid": gone, "to": "from-deletion.md", "epoch": epoch}, "not_note_content"},
		{map[string]any{"path": "other.md", "uid": note, "to": "from-another-path.md", "epoch": epoch}, "path_mismatch"},
		{map[string]any{"path": "big.md", "uid": big, "to": "from-big.md", "epoch": epoch}, "note_too_large"},
		{map[string]any{"path": "bad.md", "uid": bad, "to": "from-bad.md", "epoch": epoch}, "invalid_utf8"},
		{map[string]any{"path": "note.md", "uid": note, "to": "other.md", "epoch": epoch}, "exists"},
	} {
		e := invoke(t, a.cs, "restore_note", c.args)
		if got := refused(t, e); got != c.want {
			t.Errorf("restore_note %v: %s, want %s: %s", c.args, got, c.want, e.raw)
		}
	}
	for p, uid := range heads {
		if r.head(p) != uid {
			t.Errorf("a refused restore changed %s", p)
		}
	}
	if got := r.bytesAt(r.head("other.md")); got != "someone else's\n" {
		t.Errorf("the occupied destination now reads %q", got)
	}
	for _, p := range []string{"from-folder.md", "from-deletion.md", "from-another-path.md", "from-big.md", "from-bad.md"} {
		if r.head(p) != 0 {
			t.Errorf("a refused restore created %s", p)
		}
	}
	if r.operations() != 0 {
		t.Fatalf("a refused restore recorded %d operations", r.operations())
	}
}

// append_note and prepend_note need a base, as edit_note does: a call
// without one is invalid_arguments and writes nothing, rather than a write
// against whatever the head happens to be. From mcp-tools-process.test.ts,
// whose prepend without a base was a tool error.
func TestAppendAndPrependNeedABase(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	r.write("note.md", "text\n")
	head := r.head("note.md")
	for _, tool := range []string{"append_note", "prepend_note"} {
		e := invoke(t, a.cs, tool, map[string]any{"path": "note.md", "epoch": r.epoch(), "text": "x\n"})
		if got := refused(t, e); got != "invalid_arguments" {
			t.Errorf("%s without a base: %s: %s", tool, got, e.raw)
		}
	}
	if r.head("note.md") != head || r.operations() != 0 {
		t.Fatal("a call without a base wrote something")
	}
}
