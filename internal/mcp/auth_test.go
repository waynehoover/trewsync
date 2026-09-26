package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/store"
)

// A token for a tool that writes, registered only here, so the scope checks
// have a write tool to refuse before M5 brings real ones. It commits through
// the commit boundary, as every write tool must, and counts what it wrote.
func (r *rig) addWriteTool(beforeCommit func()) *atomic.Int64 {
	var wrote atomic.Int64
	r.h.tools = append(r.h.tools, &Tool{
		Name: "test_write", Title: "Test write", Scope: store.ScopeWrite,
		Description: "Writes nothing but a counter; exists to be refused.",
		Input:       object(nil, map[string]schema{}),
		Run: func(c *call, a *args) outcome {
			if err := a.finish(); err != nil {
				return c.fail(err)
			}
			if beforeCommit != nil {
				beforeCommit()
			}
			if err := c.commit(func() error { wrote.Add(1); return nil }); err != nil {
				return c.failErr(err)
			}
			return c.ok(struct {
				Committed bool `json:"committed"`
			}{true}, nil)
		},
	})
	return &wrote
}

func toolCall(name string) string {
	return `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":{}}}`
}

// Before authentication the replies say nothing: a fixed word, the realm,
// and no JSON, no version, no vault, no tool list, and no OAuth metadata of
// any kind, because a client told OAuth exists acts on it (Syncidian's
// lesson). Nothing is dispatched.
func TestUnauthenticatedRequestsGetAFixedRefusal(t *testing.T) {
	// A failure budget large enough that every refusal here is the 401
	// itself; TestFailedAuthenticationIsRateLimitedSeparately is about the
	// budget.
	r := newRig(t, withLimits(Limits{FailBurst: 1000}))
	dispatched := 0
	r.h.duringTool = func(string) { dispatched++ }
	token, _ := r.token(store.ScopeRead)
	expired := r.expiringToken(time.Now().Add(-time.Minute))
	revokedToken, revoked := r.token(store.ScopeRead)
	if err := r.srv.OperatorRevokeMCPToken(testVault, revoked.ID); err != nil {
		t.Fatal(err)
	}
	for _, auth := range []string{
		"", "Basic " + token, "Bearer", "Bearer " + token[:42], "Bearer " + token + "A", "bearer " + token,
		"Bearer  " + token, "Bearer " + strings.Repeat("A", 43), "Bearer " + strings.Repeat("!", 43),
		"Bearer " + expired, "Bearer " + revokedToken,
	} {
		status, h, body := r.post(rpc{body: toolCall("vault_status"), headers: map[string]string{
			"Authorization": auth, "Mcp-Protocol-Version": Version20251125}})
		if status != http.StatusUnauthorized || string(body) != "unauthorized" || h.Get("WWW-Authenticate") != `Bearer realm="trew"` {
			t.Errorf("Authorization %q: %d %q %q", auth, status, body, h.Get("WWW-Authenticate"))
		}
		all := string(body) + fmt.Sprint(h)
		for _, secret := range []string{token, "test-version", testVault, "vault_status", "resource_metadata", "oauth"} {
			if strings.Contains(strings.ToLower(all), strings.ToLower(secret)) && secret != "" {
				t.Errorf("a refusal for %q names %q: %s", auth, secret, all)
			}
		}
	}
	// Two Authorization headers are refused like none.
	req, _ := http.NewRequest(http.MethodPost, r.url, strings.NewReader(toolCall("vault_status")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Add("Authorization", "Bearer "+token)
	req.Header.Add("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("two Authorization headers: %d", resp.StatusCode)
	}
	if dispatched != 0 {
		t.Fatalf("%d tools ran for requests that never authenticated", dispatched)
	}
	// An expired token fails the SDK's connect as well.
	if _, err := r.connect(expired, Version20251125); err == nil {
		t.Fatal("an expired token connected")
	}
}

// Origin is checked before the credential: absent, which every non-browser
// client is, or exactly an allowed one.
func TestOriginsMustBeAllowedExactly(t *testing.T) {
	r := newRig(t, withOrigins("https://trusted.example"))
	token, _ := r.token(store.ScopeRead)
	for _, c := range []struct {
		origin string
		status int
	}{
		{"", http.StatusOK},
		{"https://trusted.example", http.StatusOK},
		{"null", http.StatusForbidden},
		{"https://evil.example", http.StatusForbidden},
		{"https://trusted.example.evil", http.StatusForbidden},
		{"https://trusted.example/", http.StatusForbidden},
		{"HTTPS://trusted.example", http.StatusForbidden},
	} {
		for _, auth := range []string{"Bearer " + token, ""} {
			want := c.status
			if auth == "" && want == http.StatusOK {
				want = http.StatusUnauthorized
			}
			status, _, body := r.post(rpc{body: toolCall("vault_status"), headers: map[string]string{
				"Authorization": auth, "Origin": c.origin, "Mcp-Protocol-Version": Version20251125}})
			if status != want {
				t.Errorf("origin %q, auth %v: %d, want %d", c.origin, auth != "", status, want)
			}
			if status == http.StatusForbidden && string(body) != "refused" {
				t.Errorf("a 403 said %q", body)
			}
		}
	}
}

// Bodies over 8 MiB are 413, whether declared or only arriving, and are
// never read into memory past the limit.
func TestBodiesOver8MiBAre413(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	big := `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"` + strings.Repeat("a", MaxBodyBytes) + `"}}`
	// Declared.
	status, _, _ := r.post(legacy(token, big))
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a declared 8 MiB body: %d", status)
	}
	// Chunked, with no length declared.
	req, _ := http.NewRequest(http.MethodPost, r.url, io.MultiReader(strings.NewReader(big)))
	req.ContentLength = -1
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Mcp-Protocol-Version", Version20251125)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("a streamed 8 MiB body: %d", resp.StatusCode)
	}
	// Just under the limit is read.
	ok := `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"` + strings.Repeat("a", MaxBodyBytes-100) + `"}}`
	if status, _, body := r.post(legacy(token, ok)); status != http.StatusOK {
		t.Fatalf("a body under the limit: %d %s", status, body)
	}
}

// A reply over 1 MiB is replaced by result_too_large before anything is
// written.
func TestARepliesOver1MiBAreRefusedBeforeTheyAreSent(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	r.h.tools = append(r.h.tools, &Tool{
		Name: "test_big", Scope: store.ScopeRead, Input: object(nil, map[string]schema{}),
		Run: func(c *call, a *args) outcome {
			return c.ok(nil, struct {
				Text Text `json:"text"`
			}{Normalize(strings.Repeat("x", 700<<10))})
		},
	})
	status, _, body := r.post(legacy(token, toolCall("test_big")))
	if status != http.StatusOK || len(body) > MaxReplyBytes {
		t.Fatalf("%d, %d bytes", status, len(body))
	}
	if e := toolReply(t, body); !e.isError || e.errorCode() != "result_too_large" {
		t.Fatalf("got %s", e.raw)
	}
}

// Budgets answer 429 with Retry-After: the endpoint's own cap, one token's
// requests in flight and its rate, and its reply bytes, while another token
// and a device's sync are not starved (PLAN.md section 2.3).
func TestBudgetsAnswer429WithoutStarvingAnotherToken(t *testing.T) {
	t.Run("in flight", func(t *testing.T) {
		r := newRig(t, withLimits(Limits{TokenInFlight: 1, InFlight: 3}))
		loud, _ := r.token(store.ScopeRead)
		quiet, _ := r.token(store.ScopeRead)
		entered := make(chan struct{}, 4)
		release := make(chan struct{})
		r.h.duringTool = func(string) { entered <- struct{}{}; <-release }
		done := make(chan int, 1)
		go func() {
			status, _, _ := r.post(legacy(loud, toolCall("vault_status")))
			done <- status
		}()
		<-entered
		status, h, _ := r.post(legacy(loud, toolCall("vault_status")))
		if status != http.StatusTooManyRequests || h.Get("Retry-After") == "" {
			t.Fatalf("a second request in flight for one token: %d, Retry-After %q", status, h.Get("Retry-After"))
		}
		go func() {
			status, _, _ := r.post(legacy(quiet, toolCall("vault_status")))
			done <- status
		}()
		<-entered // the other token was admitted while the first was busy
		close(release)
		for i := 0; i < 2; i++ {
			if s := <-done; s != http.StatusOK {
				t.Fatalf("an admitted request ended %d", s)
			}
		}
	})
	t.Run("rate", func(t *testing.T) {
		r := newRig(t, withLimits(Limits{TokenRate: 0.001, TokenBurst: 3}))
		loud, _ := r.token(store.ScopeRead)
		quiet, _ := r.token(store.ScopeRead)
		for i := 0; i < 3; i++ {
			if status, _, body := r.post(legacy(loud, toolCall("vault_status"))); status != http.StatusOK {
				t.Fatalf("request %d: %d %s", i, status, body)
			}
		}
		status, h, _ := r.post(legacy(loud, toolCall("vault_status")))
		wait, _ := strconv.Atoi(h.Get("Retry-After"))
		if status != http.StatusTooManyRequests || wait < 1 {
			t.Fatalf("past the burst: %d, Retry-After %q", status, h.Get("Retry-After"))
		}
		if status, _, _ := r.post(legacy(quiet, toolCall("vault_status"))); status != http.StatusOK {
			t.Fatalf("another token was starved: %d", status)
		}
	})
	t.Run("bytes", func(t *testing.T) {
		r := newRig(t, withLimits(Limits{TokenBytesRate: 1, TokenBytesBurst: 100}))
		loud, _ := r.token(store.ScopeRead)
		if status, _, _ := r.post(legacy(loud, toolCall("vault_status"))); status != http.StatusOK {
			t.Fatal(status)
		}
		if status, h, _ := r.post(legacy(loud, toolCall("vault_status"))); status != http.StatusTooManyRequests || h.Get("Retry-After") == "" {
			t.Fatalf("past the byte budget: %d", status)
		}
	})
	t.Run("endpoint", func(t *testing.T) {
		r := newRig(t, withLimits(Limits{InFlight: 1}))
		a, _ := r.token(store.ScopeRead)
		entered := make(chan struct{}, 1)
		release := make(chan struct{})
		r.h.duringTool = func(string) { entered <- struct{}{}; <-release }
		done := make(chan int, 1)
		go func() {
			status, _, _ := r.post(legacy(a, toolCall("vault_status")))
			done <- status
		}()
		<-entered
		// Even a request with no credential is refused by capacity first, so a
		// flood cannot make the endpoint check tokens without bound.
		if status, h, _ := r.post(legacy("", toolCall("vault_status"))); status != http.StatusTooManyRequests || h.Get("Retry-After") != "1" {
			t.Fatalf("over the endpoint's cap: %d %q", status, h.Get("Retry-After"))
		}
		close(release)
		if s := <-done; s != http.StatusOK {
			t.Fatal(s)
		}
	})
}

// Failed authentication has a budget of its own, per address: past it the
// refusals are 429 and are no longer logged one by one, and a valid token
// from the same address is never locked out by them.
func TestFailedAuthenticationIsRateLimitedSeparately(t *testing.T) {
	r := newRig(t, withLimits(Limits{FailRate: 0.001, FailBurst: 2}))
	token, _ := r.token(store.ScopeRead)
	var statuses []int
	for i := 0; i < 5; i++ {
		status, _, _ := r.post(legacy("wrong-"+strconv.Itoa(i), toolCall("vault_status")))
		statuses = append(statuses, status)
	}
	if fmt.Sprint(statuses) != "[401 401 429 429 429]" {
		t.Fatalf("statuses %v", statuses)
	}
	if n := strings.Count(r.logs.String(), "MCP authorization refused"); n != 2 {
		t.Fatalf("%d refusals logged, want the 2 within budget", n)
	}
	if status, _, _ := r.post(legacy(token, toolCall("vault_status"))); status != http.StatusOK {
		t.Fatalf("a valid token was locked out by failures from its address: %d", status)
	}
}

// A token revoked while its request runs loses at the check before the
// reply: the result it computed is never sent.
func TestATokenRevokedMidRequestLosesBeforeItsReply(t *testing.T) {
	r := newRig(t)
	r.write("secret.md", "the reply to a revoked token must not carry this\n")
	token, tok := r.token(store.ScopeRead)
	r.h.beforeReply = func() {
		if err := r.srv.OperatorRevokeMCPToken(testVault, tok.ID); err != nil {
			t.Error(err)
		}
		r.h.Revoked(tok.ID)
	}
	status, h, body := r.post(legacy(token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"secret.md"}}}`))
	if status != http.StatusUnauthorized || h.Get("WWW-Authenticate") == "" {
		t.Fatalf("%d %s", status, body)
	}
	if bytes.Contains(body, []byte("must not carry")) {
		t.Fatal("the result reached a revoked token")
	}
	r.h.beforeReply = nil
	if status, _, _ := r.post(legacy(token, toolCall("vault_status"))); status != http.StatusUnauthorized {
		t.Fatalf("the next request with the revoked token: %d", status)
	}
}

// A read token never sees a write tool, and a hand-built call to one is
// refused at dispatch whatever the tool list said; a write token sees it and
// may call it (PLAN.md section 2.3).
func TestAReadTokenCannotCallAWriteTool(t *testing.T) {
	r := newRig(t)
	wrote := r.addWriteTool(nil)
	read, _ := r.token(store.ScopeRead)
	write, _ := r.token(store.ScopeWrite)

	names := func(token string) string {
		_, _, body := r.post(legacy(token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		var res struct {
			Tools []listedTool `json:"tools"`
		}
		if err := json.Unmarshal(parseReply(t, body).Result, &res); err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, tool := range res.Tools {
			out = append(out, tool.Name)
			if tool.Name == "test_write" && (tool.Annotations.ReadOnlyHint || !tool.Annotations.DestructiveHint) {
				t.Errorf("the write tool is annotated %+v", tool.Annotations)
			}
		}
		return strings.Join(out, ",")
	}
	if strings.Contains(names(read), "test_write") {
		t.Fatal("a read token was shown the write tool")
	}
	if !strings.Contains(names(write), "test_write") {
		t.Fatal("a write token was not shown the write tool")
	}
	for _, q := range []rpc{
		legacy(read, toolCall("test_write")),
		modern(read, 1, "tools/call", "test_write", `"name":"test_write","arguments":{}`),
	} {
		status, _, body := r.post(q)
		if e := toolReply(t, body); status != http.StatusOK || !e.isError || e.errorCode() != "read_only" {
			t.Fatalf("a read token calling the write tool: %d %s", status, body)
		}
	}
	if wrote.Load() != 0 {
		t.Fatal("the write happened for a read token")
	}
	if status, _, body := r.post(legacy(write, toolCall("test_write"))); status != http.StatusOK || toolReply(t, body).isError {
		t.Fatalf("a write token: %d %s", status, body)
	}
	if wrote.Load() != 1 {
		t.Fatalf("wrote %d times", wrote.Load())
	}
}

// A write token revoked after its call was dispatched loses at the commit
// boundary, under the commit lock, and the mutation never runs: the check
// M5's writes will pass through.
func TestAWriteLosesAtTheCommitBoundaryToARevoke(t *testing.T) {
	r := newRig(t)
	write, tok := r.token(store.ScopeWrite)
	wrote := r.addWriteTool(func() {
		if err := r.srv.OperatorRevokeMCPToken(testVault, tok.ID); err != nil {
			t.Error(err)
		}
	})
	status, _, _ := r.post(legacy(write, toolCall("test_write")))
	if status != http.StatusUnauthorized {
		t.Fatalf("a revoked writer's reply: %d", status)
	}
	if wrote.Load() != 0 {
		t.Fatal("a write committed for a token revoked before its commit")
	}
}

// The authorization matrix, generated from the tool registry, so a tool
// added later is enforced without a test written for it (research section 5):
// every tool, called by every kind of credential, with a hand-built request.
// No token, an expired one and a revoked one never reach the tool; a read
// token reaches the read tools and is refused the others; a write token
// reaches every one.
func TestTheAuthorizationMatrixCoversEveryTool(t *testing.T) {
	r := newRig(t, withLimits(Limits{FailBurst: 1000, TokenBurst: 1000}))
	r.addWriteTool(nil)
	read, _ := r.token(store.ScopeRead)
	write, _ := r.token(store.ScopeWrite)
	expired := r.expiringToken(time.Now().Add(-time.Second))
	revokedToken, revoked := r.token(store.ScopeWrite)
	if err := r.srv.OperatorRevokeMCPToken(testVault, revoked.ID); err != nil {
		t.Fatal(err)
	}
	var reached sync.Map
	r.h.duringTool = func(tool string) { reached.Store(tool, true) }

	sawWrite := false
	for _, tool := range r.h.tools {
		sawWrite = sawWrite || tool.Scope == store.ScopeWrite
		if tool.ReadOnly() != (tool.Scope == store.ScopeRead) {
			t.Errorf("%s: its annotations and its scope disagree", tool.Name)
		}
		for _, c := range []struct {
			who, token string
			reaches    bool
		}{
			{"no token", "", false},
			{"expired", expired, false},
			{"revoked", revokedToken, false},
			{"read", read, tool.Scope == store.ScopeRead},
			{"write", write, true},
		} {
			reached.Delete(tool.Name)
			status, _, body := r.post(legacy(c.token, toolCall(tool.Name)))
			_, ran := reached.Load(tool.Name)
			switch {
			case c.token == read && !c.reaches:
				if e := toolReply(t, body); status != http.StatusOK || e.errorCode() != "read_only" || ran {
					t.Errorf("%s by a %s token: %d %s, ran %v", tool.Name, c.who, status, body, ran)
				}
			case !c.reaches:
				if status != http.StatusUnauthorized || ran {
					t.Errorf("%s with %s: %d, ran %v", tool.Name, c.who, status, ran)
				}
			default:
				if status != http.StatusOK || !ran {
					t.Errorf("%s by a %s token: %d %s, ran %v", tool.Name, c.who, status, body, ran)
				}
			}
		}
	}
	if !sawWrite {
		t.Fatal("the matrix saw no write tool, so it proved nothing about scope")
	}
}

// Every authenticated request is counted, and last_used is written at most
// once a minute, with the counts held between written by the next write or a
// flush: so a stolen token used once between two uses is still counted.
func TestTokenUseIsCountedAndWrittenAtMostOnceAMinute(t *testing.T) {
	r := newRig(t)
	token, tok := r.token(store.ScopeRead)
	start := time.Now()
	r.clock.Store(start.UnixMilli())
	listed := func() store.MCPToken {
		list, err := r.st.MCPTokens(testVault)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range list {
			if l.ID == tok.ID {
				return l
			}
		}
		t.Fatal("the token is gone")
		return store.MCPToken{}
	}
	for i := 0; i < 5; i++ {
		r.post(legacy(token, toolCall("vault_status")))
	}
	first := listed()
	if first.UsedCount != 1 || first.LastUsed != start.UnixMilli() {
		t.Fatalf("after five requests in a second the row says %d uses, last %d", first.UsedCount, first.LastUsed)
	}
	r.h.FlushUsage()
	if got := listed(); got.UsedCount != 5 {
		t.Fatalf("after a flush %d uses, want 5", got.UsedCount)
	}
	r.clock.Store(start.Add(61 * time.Second).UnixMilli())
	r.post(legacy(token, toolCall("vault_status")))
	if got := listed(); got.UsedCount != 6 || got.LastUsed != start.Add(61*time.Second).UnixMilli() {
		t.Fatalf("a minute later %d uses, last %d", got.UsedCount, got.LastUsed)
	}
}

// Nothing secret reaches the log: tokens, note text, and the paths and
// names of notes, which are the vault's metadata (PLAN.md section 2.2).
func TestTheLogCarriesNoTokenNoteTextOrPath(t *testing.T) {
	r := newRig(t)
	r.write("private/diary-2026.md", "a sentence nobody else should read\n")
	r.write("private/broken.md", "\xff\xfe")
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"read_note", map[string]any{"path": "private/diary-2026.md"}},
		{"read_note", map[string]any{"path": "private/broken.md"}},
		{"read_note", map[string]any{"path": "private/missing-secret.md"}},
		{"search_notes", map[string]any{"query": "nobody else"}},
		{"list_notes", map[string]any{}},
		{"note_history", map[string]any{"path": "private/diary-2026.md"}},
		{"compare_versions", map[string]any{"path": "private/diary-2026.md", "fromUid": 1}},
	} {
		invoke(t, cs, c.tool, c.args)
	}
	r.post(legacy("not-a-token", toolCall("vault_status")))
	logs := r.logs.String()
	for _, secret := range []string{token, "nobody else should read", "diary-2026", "broken.md", "missing-secret", "private/"} {
		if strings.Contains(logs, secret) {
			t.Errorf("the log carries %q:\n%s", secret, logs)
		}
	}
}

// remoteHost is the connection's address, never a forwarded header.
func TestFailuresAreCountedAgainstTheConnectionNotAHeader(t *testing.T) {
	req := &http.Request{RemoteAddr: net.JoinHostPort("10.0.0.7", "5000"), Header: http.Header{"X-Forwarded-For": {"1.2.3.4"}}}
	if got := remoteHost(req); got != "10.0.0.7" {
		t.Fatalf("remote host %q", got)
	}
}
