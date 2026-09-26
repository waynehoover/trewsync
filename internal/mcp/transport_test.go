package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/waynehoover/trewsync/internal/store"
)

var readToolNames = []string{"backlinks", "broken_links", "compare_versions", "deleted_notes", "delivery_status",
	"list_notes", "lookup_operation", "note_history", "orphans", "outgoing_links", "read_note", "search_notes",
	"vault_status"}

// The official Go SDK's client, at every protocol version it speaks, reaches
// the endpoint, lists the tools and reads a note (PLAN.md M4 task 1): the
// interoperability of the hand-written transport is proven by an
// implementation that is not this one. The two versions before 2025-06-18 are
// answered with 2025-11-25, the newest this endpoint has a handshake for, and
// the SDK accepts it; 2026-07-28 is reached through server/discover and the
// per-request _meta, with no handshake at all.
func TestTheSDKClientSpeaksEveryVersionItSupports(t *testing.T) {
	r := newRig(t)
	uid := r.write("notes/hello.md", "hello from the store\nsecond line\n")
	token, _ := r.token(store.ScopeRead)

	want := map[string]string{
		"":              Version20260728,
		Version20260728: Version20260728,
		Version20251125: Version20251125,
		Version20250618: Version20250618,
		"2025-03-26":    Version20251125,
		"2024-11-05":    Version20251125,
	}
	versions := append([]string{""}, sdk.SupportedProtocolVersions()...)
	if len(versions) != 6 {
		t.Fatalf("the SDK speaks %v; this test was written for five versions", sdk.SupportedProtocolVersions())
	}
	for _, v := range versions {
		t.Run("asking for "+v, func(t *testing.T) {
			cs := r.mustConnect(token, v)
			if got := cs.InitializeResult().ProtocolVersion; got != want[v] {
				t.Fatalf("negotiated %q, want %q", got, want[v])
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			list, err := cs.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, tool := range list.Tools {
				names = append(names, tool.Name)
				if !strings.HasSuffix(tool.Description, Warning) {
					t.Errorf("%s's description does not carry the warning", tool.Name)
				}
				if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
					t.Errorf("%s is not annotated read-only", tool.Name)
				}
			}
			sort.Strings(names)
			if strings.Join(names, ",") != strings.Join(readToolNames, ",") {
				t.Fatalf("tools %v", names)
			}
			e := invoke(t, cs, "read_note", map[string]any{"path": "notes/hello.md"})
			var got struct {
				UID int64 `json:"uid"`
			}
			e.trusted(t, &got)
			var content struct {
				Content string `json:"content"`
			}
			e.untrusted(t, &content)
			if got.UID != uid || content.Content != "hello from the store\nsecond line\n" {
				t.Fatalf("read %d %q", got.UID, content.Content)
			}
			if err := cs.Close(); err != nil {
				t.Fatalf("closing: %v", err)
			}
		})
	}
	// The session-era client opens a standalone stream with GET, which is
	// refused as the stateless endpoint it is, and sends no DELETE because it
	// was never given a session.
	if r.method(http.MethodGet) == 0 {
		t.Error("the handshake-era clients never tried the standalone stream")
	}
	if n := r.method(http.MethodDelete); n != 0 {
		t.Errorf("%d DELETEs, but no session id was ever minted", n)
	}
}

func TestGETAndDELETEAre405(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	for _, m := range []string{http.MethodGet, http.MethodDelete, http.MethodPut, http.MethodPatch} {
		req, _ := http.NewRequest(m, r.url, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != http.MethodPost {
			t.Errorf("%s: %d, Allow %q", m, resp.StatusCode, resp.Header.Get("Allow"))
		}
		if resp.Header.Get("Mcp-Session-Id") != "" {
			t.Errorf("%s minted a session", m)
		}
	}
}

// A notification is accepted with 202 and no body, in either era.
func TestNotificationsAreAcceptedWithNoBody(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	for _, q := range []rpc{
		legacy(token, `{"jsonrpc":"2.0","method":"notifications/initialized"}`),
		legacy(token, `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}`),
		{body: `{"jsonrpc":"2.0","method":"notifications/something","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`,
			headers: map[string]string{"Authorization": "Bearer " + token, "Mcp-Protocol-Version": Version20260728}},
	} {
		status, h, body := r.post(q)
		if status != http.StatusAccepted || len(body) != 0 {
			t.Errorf("%s: %d %q", q.body, status, body)
		}
		if h.Get("Mcp-Session-Id") != "" {
			t.Error("a notification minted a session")
		}
	}
}

// Malformed frames are JSON-RPC errors, refused before any method runs: the
// non-object frame Basalt's transport refused, batches, which MCP dropped,
// repeated keys, responses sent to the server, bad ids and bad params.
func TestMalformedFramesAreJSONRPCErrors(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	for _, c := range []struct {
		name, body string
		code       int
	}{
		{"an array", `[]`, codeInvalidRequest},
		{"a batch", `[{"jsonrpc":"2.0","id":1,"method":"ping"}]`, codeInvalidRequest},
		{"a string", `"ping"`, codeInvalidRequest},
		{"a number", `1`, codeInvalidRequest},
		{"null", `null`, codeInvalidRequest},
		{"not JSON", `{"jsonrpc":`, codeParseError},
		{"empty", ``, codeParseError},
		{"a repeated key", `{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/list"}`, codeInvalidRequest},
		{"no jsonrpc", `{"id":1,"method":"ping"}`, codeInvalidRequest},
		{"another jsonrpc", `{"jsonrpc":"1.0","id":1,"method":"ping"}`, codeInvalidRequest},
		{"no method", `{"jsonrpc":"2.0","id":1}`, codeInvalidRequest},
		{"a method that is not a string", `{"jsonrpc":"2.0","id":1,"method":7}`, codeInvalidRequest},
		{"a null id", `{"jsonrpc":"2.0","id":null,"method":"ping"}`, codeInvalidRequest},
		{"a fractional id", `{"jsonrpc":"2.0","id":1.5,"method":"ping"}`, codeInvalidRequest},
		{"an object id", `{"jsonrpc":"2.0","id":{},"method":"ping"}`, codeInvalidRequest},
		{"a response", `{"jsonrpc":"2.0","id":1,"result":{}}`, codeInvalidRequest},
		{"an unknown member", `{"jsonrpc":"2.0","id":1,"method":"ping","trusted":true}`, codeInvalidRequest},
		{"params that are an array", `{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}`, codeInvalidParams},
		{"an id of megabytes", `{"jsonrpc":"2.0","id":"` + strings.Repeat("x", 2<<20) + `","method":"ping"}`, codeInvalidRequest},
	} {
		t.Run(c.name, func(t *testing.T) {
			status, _, body := r.post(legacy(token, c.body))
			if status != http.StatusBadRequest {
				t.Fatalf("status %d: %s", status, body)
			}
			reply := parseReply(t, body)
			if reply.Error == nil || reply.Error.Code != c.code {
				t.Fatalf("reply %s, want code %d", body, c.code)
			}
			if len(reply.ID) != 0 {
				t.Fatalf("a malformed frame's id was echoed: %s", body)
			}
			if len(body) > 4096 {
				t.Fatalf("a refusal of %d bytes", len(body))
			}
		})
	}
	// Invalid UTF-8, which a lenient decoder would quietly replace.
	status, _, body := r.post(legacy(token, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{\"x\":\"\xff\"}}"))
	if status != http.StatusBadRequest || parseReply(t, body).Error.Code != codeParseError {
		t.Fatalf("invalid UTF-8: %d %s", status, body)
	}
}

// An unknown method is a JSON-RPC error, 404 in the stateless era as
// 2026-07-28 requires; ping is gone from that era and answered in the other.
func TestUnknownMethodsAreJSONRPCErrors(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	status, _, body := r.post(legacy(token, `{"jsonrpc":"2.0","id":3,"method":"resources/list"}`))
	if reply := parseReply(t, body); status != http.StatusOK || reply.Error == nil || reply.Error.Code != codeMethodNotFound || string(reply.ID) != "3" {
		t.Fatalf("handshake era: %d %s", status, body)
	}
	status, _, body = r.post(legacy(token, `{"jsonrpc":"2.0","id":"p","method":"ping"}`))
	if reply := parseReply(t, body); status != http.StatusOK || reply.Error != nil || string(reply.Result) != "{}" || string(reply.ID) != `"p"` {
		t.Fatalf("ping: %d %s", status, body)
	}
	for _, method := range []string{"resources/list", "ping", "initialize"} {
		status, _, body = r.post(modern(token, 4, method, "", ""))
		if reply := parseReply(t, body); status != http.StatusNotFound || reply.Error == nil || reply.Error.Code != codeMethodNotFound {
			t.Fatalf("stateless era %s: %d %s", method, status, body)
		}
	}
}

// Ids are repeated exactly as they were sent, including the ones Basalt's
// transport had to protect: zero, the empty string, and a string of digits.
func TestIDsAreRepeatedAsSent(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	for _, id := range []string{`0`, `""`, `"0"`, `-5`, `9007199254740991`, `"a\u00e9b"`} {
		_, _, body := r.post(legacy(token, `{"jsonrpc":"2.0","id":`+id+`,"method":"ping"}`))
		if got := string(parseReply(t, body).ID); got != id {
			t.Errorf("sent id %s, got %s", id, got)
		}
	}
}

// A tool that fails reports it in its own result, isError set; a call that
// names no tool the server has is a protocol error.
func TestToolFailuresAreResultsAndUnknownToolsAreErrors(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	cs := r.mustConnect(token, Version20251125)
	e := invoke(t, cs, "read_note", map[string]any{"path": "missing.md"})
	if !e.isError || e.errorCode() != "not_found" {
		t.Fatalf("a missing note: %s", e.raw)
	}
	e = invoke(t, cs, "read_note", map[string]any{"path": "a.md", "surprise": 1})
	if !e.isError || e.errorCode() != "invalid_arguments" {
		t.Fatalf("an unknown argument: %s", e.raw)
	}
	status, _, body := r.post(legacy(token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope","arguments":{}}}`))
	if reply := parseReply(t, body); status != http.StatusOK || reply.Error == nil || reply.Error.Code != codeInvalidParams {
		t.Fatalf("an unknown tool: %d %s", status, body)
	}
	status, _, body = r.post(modern(token, 1, "tools/call", "nope", `"name":"nope","arguments":{}`))
	if reply := parseReply(t, body); status != http.StatusBadRequest || reply.Error == nil || reply.Error.Code != codeInvalidParams {
		t.Fatalf("an unknown tool, stateless: %d %s", status, body)
	}
}

// Two requests carrying one id are two requests: each is answered on its own
// connection with its own result, so the lesson of Basalt's session
// transport, where a duplicate rerouted the first reply, cannot arise here.
func TestDuplicateIDsAreAnsweredEachOnItsOwn(t *testing.T) {
	r := newRig(t)
	r.write("first.md", "the first note\n")
	r.write("second.md", "the second note\n")
	token, _ := r.token(store.ScopeRead)

	firstEntered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	r.h.duringTool = func(string) {
		// Hold only the first call, until the second has been answered.
		entered := false
		once.Do(func() { entered = true; close(firstEntered) })
		if entered {
			<-release
		}
	}
	read := func(path string) []byte {
		_, _, body := r.post(legacy(token, `{"jsonrpc":"2.0","id":"same","method":"tools/call","params":{"name":"read_note","arguments":{"path":"`+path+`"}}}`))
		return body
	}
	first := make(chan []byte, 1)
	go func() { first <- read("first.md") }()
	<-firstEntered
	second := read("second.md")
	close(release)
	firstBody := <-first
	for _, c := range []struct {
		body []byte
		want string
	}{{firstBody, "the first note\n"}, {second, "the second note\n"}} {
		if id := string(parseReply(t, c.body).ID); id != `"same"` {
			t.Fatalf("id %s", id)
		}
		var content struct {
			Content string `json:"content"`
		}
		toolReply(t, c.body).untrusted(t, &content)
		if content.Content != c.want {
			t.Fatalf("got %q, want %q", content.Content, c.want)
		}
	}
}

// The stateless era's headers must mirror the body (SEP-2243), and its
// version must be one this server speaks (SEP-2575).
func TestStatelessRequestsMustMirrorTheirBody(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	good := modern(token, 1, "tools/call", "vault_status", `"name":"vault_status","arguments":{}`)
	if status, _, body := r.post(good); status != http.StatusOK {
		t.Fatalf("a good request: %d %s", status, body)
	}
	with := func(q rpc, key, value string) rpc {
		h := map[string]string{}
		for k, v := range q.headers {
			h[k] = v
		}
		h[key] = value
		return rpc{body: q.body, headers: h}
	}
	encoded := with(good, "Mcp-Name", "=?base64?dmF1bHRfc3RhdHVz?=")
	if status, _, body := r.post(encoded); status != http.StatusOK {
		t.Fatalf("a base64 Mcp-Name: %d %s", status, body)
	}
	for _, c := range []struct {
		name string
		q    rpc
		code int
	}{
		{"no version header", with(good, "Mcp-Protocol-Version", ""), codeHeaderMismatch},
		{"another version in the header", with(good, "Mcp-Protocol-Version", Version20251125), codeHeaderMismatch},
		{"no Mcp-Method", with(good, "Mcp-Method", ""), codeHeaderMismatch},
		{"another method", with(good, "Mcp-Method", "tools/list"), codeHeaderMismatch},
		{"no Mcp-Name", with(good, "Mcp-Name", ""), codeHeaderMismatch},
		{"another name", with(good, "Mcp-Name", "read_note"), codeHeaderMismatch},
		{"a bad base64 name", with(good, "Mcp-Name", "=?base64?!!?="), codeHeaderMismatch},
		{"no capabilities", rpc{body: strings.Replace(good.body, `,"io.modelcontextprotocol/clientCapabilities":{}`, "", 1), headers: good.headers}, codeInvalidParams},
		{"an unsupported version", rpc{body: strings.ReplaceAll(good.body, "2026-07-28", "2027-01-01"),
			headers: with(good, "Mcp-Protocol-Version", "2027-01-01").headers}, codeUnsupportedVersion},
	} {
		t.Run(c.name, func(t *testing.T) {
			status, _, body := r.post(c.q)
			reply := parseReply(t, body)
			if status != http.StatusBadRequest || reply.Error == nil || reply.Error.Code != c.code {
				t.Fatalf("%d %s, want 400 and %d", status, body, c.code)
			}
			if c.code == codeUnsupportedVersion {
				var data struct {
					Supported []string `json:"supported"`
					Requested string   `json:"requested"`
				}
				if json.Unmarshal(reply.Error.Data, &data) != nil || data.Requested != "2027-01-01" ||
					strings.Join(data.Supported, ",") != strings.Join(Versions, ",") {
					t.Fatalf("data %s", reply.Error.Data)
				}
			}
		})
	}
	// A 2026-07-28 result says what it is and who answered.
	_, _, body := r.post(good)
	var res struct {
		ResultType string `json:"resultType"`
		Meta       struct {
			ServerInfo implementation `json:"io.modelcontextprotocol/serverInfo"`
		} `json:"_meta"`
	}
	if json.Unmarshal(parseReply(t, body).Result, &res) != nil || res.ResultType != "complete" || res.Meta.ServerInfo.Name != ServerName {
		t.Fatalf("a stateless result %s", body)
	}
}

// After initialize, a handshake-era request names its version, which must be
// one this server negotiates; the versions before 2025-06-18, which had no
// such header, are not spoken, so a request without one is refused.
func TestHandshakeRequestsNameTheirVersion(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	list := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	for _, c := range []struct {
		version string
		status  int
	}{{Version20251125, http.StatusOK}, {Version20250618, http.StatusOK}, {"", http.StatusBadRequest}, {"2025-03-26", http.StatusBadRequest}} {
		q := rpc{body: list, headers: map[string]string{"Authorization": "Bearer " + token, "Mcp-Protocol-Version": c.version}}
		if status, _, body := r.post(q); status != c.status {
			t.Errorf("version %q: %d %s", c.version, status, body)
		}
	}
	for _, c := range []struct{ asked, want string }{
		{Version20251125, Version20251125}, {Version20250618, Version20250618}, {"2025-03-26", Version20251125},
		{"2024-11-05", Version20251125}, {Version20260728, Version20251125}, {"", Version20251125},
	} {
		q := rpc{body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"` + c.asked +
			`","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}`, headers: map[string]string{"Authorization": "Bearer " + token}}
		status, h, body := r.post(q)
		var res struct {
			ProtocolVersion string         `json:"protocolVersion"`
			ServerInfo      implementation `json:"serverInfo"`
			Instructions    string         `json:"instructions"`
		}
		if status != http.StatusOK || json.Unmarshal(parseReply(t, body).Result, &res) != nil || res.ProtocolVersion != c.want {
			t.Errorf("initialize asking %q: %d %s", c.asked, status, body)
		}
		if h.Get("Mcp-Session-Id") != "" {
			t.Error("initialize minted a session")
		}
		if !strings.Contains(res.Instructions, Warning) {
			t.Error("the instructions do not carry the warning")
		}
	}
}

// server/discover answers what initialize used to, for 2026-07-28: private
// to this authorisation, and not cached.
func TestDiscoverDescribesTheServer(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	status, _, body := r.post(modern(token, 1, "server/discover", "", ""))
	var res struct {
		ResultType        string         `json:"resultType"`
		SupportedVersions []string       `json:"supportedVersions"`
		Capabilities      map[string]any `json:"capabilities"`
		TTLMs             *int           `json:"ttlMs"`
		CacheScope        string         `json:"cacheScope"`
	}
	if status != http.StatusOK || json.Unmarshal(parseReply(t, body).Result, &res) != nil ||
		res.ResultType != "complete" || strings.Join(res.SupportedVersions, ",") != strings.Join(Versions, ",") ||
		res.Capabilities["tools"] == nil || res.TTLMs == nil || *res.TTLMs != 0 || res.CacheScope != "private" {
		t.Fatalf("discover: %d %s", status, body)
	}
	status, _, body = r.post(modern(token, 2, "tools/list", "", ""))
	var list struct {
		Tools      []listedTool `json:"tools"`
		TTLMs      *int         `json:"ttlMs"`
		CacheScope string       `json:"cacheScope"`
	}
	if status != http.StatusOK || json.Unmarshal(parseReply(t, body).Result, &list) != nil || len(list.Tools) != len(readToolNames) ||
		list.TTLMs == nil || list.CacheScope != "private" {
		t.Fatalf("tools/list: %d %s", status, body)
	}
	for i := 1; i < len(list.Tools); i++ {
		if list.Tools[i-1].Name >= list.Tools[i].Name {
			t.Fatal("tools are not listed in a deterministic order")
		}
	}
}
