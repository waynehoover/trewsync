package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

const testVault = "v1"

// rig is an MCP endpoint on a fresh store, served over a real listener.
type rig struct {
	t   *testing.T
	dir string
	st  *store.Store
	srv *server.Server
	idx *search.Index
	h   *Handler
	hs  *httptest.Server
	url string

	// logs is everything the endpoint and the server logged.
	logs *syncBuffer
	// methods counts the HTTP methods the endpoint was sent.
	methods sync.Map

	clock atomic.Int64 // milliseconds; 0 means the wall clock
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type rigOption func(*Config, *rigSettings)

type rigSettings struct {
	noIndex bool
	dir     string
	// wrap, when set, is what the endpoint is given in place of the index.
	wrap func(*search.Index) SearchIndex
}

// at serves the data directory dir, a backup restored for instance, rather
// than a fresh one.
func at(dir string) rigOption { return func(_ *Config, s *rigSettings) { s.dir = dir } }

func withLimits(l Limits) rigOption { return func(c *Config, _ *rigSettings) { c.Limits = l } }

func withOrigins(o ...string) rigOption {
	return func(c *Config, _ *rigSettings) { c.AllowOrigins = o }
}

func withoutIndex() rigOption { return func(_ *Config, s *rigSettings) { s.noIndex = true } }

func newRig(t *testing.T, opts ...rigOption) *rig {
	t.Helper()
	var settings rigSettings
	for _, o := range opts {
		o(&Config{}, &settings)
	}
	dir := settings.dir
	if dir == "" {
		dir = t.TempDir()
	}
	dbPath, chunkDir := store.DataDir(dir)
	st, err := store.OpenWithSync(dbPath, chunkDir, store.SyncNormal)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.EnsureVault(testVault, 1); err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, dir: dir, st: st, logs: &syncBuffer{}}
	log := slog.New(slog.NewTextHandler(r.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	r.srv = server.New(st, log)
	r.srv.Serves(testVault)
	r.srv.SetVersion("test-version")
	// Registered before the listener's Close and so run after it, and before
	// the store's Close, registered first: httptest's Close does not wait for
	// a hijacked WebSocket session, and a device session still writing when
	// the store closed would outlive it. Shutdown waits for every session.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = r.srv.Shutdown(ctx)
	})

	cfg := Config{Server: r.srv, Vault: testVault, Log: log, Now: r.now}
	for _, o := range opts {
		o(&cfg, &settings)
	}
	if !settings.noIndex {
		idx, err := search.Open(dir, st, testVault, log)
		if err != nil {
			t.Fatal(err)
		}
		idx.Start()
		t.Cleanup(func() { idx.Close() })
		r.idx = idx
		cfg.Index = idx
		if settings.wrap != nil {
			cfg.Index = settings.wrap(idx)
		}
	}
	r.h = New(cfg)
	t.Cleanup(r.h.Close)
	mux := http.NewServeMux()
	mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		n, _ := r.methods.LoadOrStore(req.Method, new(atomic.Int64))
		n.(*atomic.Int64).Add(1)
		r.h.ServeHTTP(w, req)
	}))
	// The devices' protocol on the same listener, as serve mounts it, for the
	// tests in which a device and an agent write the same vault.
	mux.Handle("/", server.HTTPHandler(r.srv, log))
	r.hs = httptest.NewServer(mux)
	t.Cleanup(r.hs.Close)
	r.url = r.hs.URL + "/mcp"
	return r
}

func (r *rig) now() time.Time {
	if ms := r.clock.Load(); ms != 0 {
		return time.UnixMilli(ms)
	}
	return time.Now()
}

func (r *rig) method(m string) int64 {
	n, ok := r.methods.Load(m)
	if !ok {
		return 0
	}
	return n.(*atomic.Int64).Load()
}

// token mints a token of scope and returns its bearer string.
func (r *rig) token(scope store.MCPScope) (string, store.NewMCPToken) {
	r.t.Helper()
	tok, err := r.srv.OperatorMCPToken(testVault, "agent "+string(scope), scope, nil)
	if err != nil {
		r.t.Fatal(err)
	}
	return store.EncodeToken(tok.Token), tok
}

func (r *rig) expiringToken(at time.Time) string {
	r.t.Helper()
	ms := at.UnixMilli()
	tok, err := r.st.CreateMCPToken(testVault, "expiring", store.ScopeRead, &ms, time.Now().Add(-time.Hour).UnixMilli())
	if err != nil {
		r.t.Fatal(err)
	}
	return store.EncodeToken(tok.Token)
}

// write commits a note with this text at path, as a device would: chunked,
// bodies first, then the entry, conditional on whatever the head is.
func (r *rig) write(path, text string) int64 {
	r.t.Helper()
	uid, err := writeEntry(r.st, store.Entry{Path: path}, []byte(text))
	if err != nil {
		r.t.Fatalf("writing %s: %v", path, err)
	}
	return uid
}

func writeEntry(st *store.Store, e store.Entry, body []byte) (int64, error) {
	e.Chunks = []string{}
	if !e.Folder && !e.Deleted {
		sizes := notes.SizesFor(int64(len(body)), notes.IsTextPath(e.Path), store.ChunkMax)
		for _, c := range notes.ChunkBytes(body, sizes, notes.IsTextPath(e.Path)) {
			name := chunks.Name(c.Bytes)
			if err := st.Chunks().Put(testVault, name, c.Bytes); err != nil {
				return 0, err
			}
			e.Chunks = append(e.Chunks, name)
		}
		e.Size = int64(len(body))
	}
	if e.Device == "" {
		e.Device = "laptop"
	}
	if e.MTime == 0 {
		e.MTime = 1_700_000_000_000
	}
	return st.AppendEntry(testVault, e)
}

func (r *rig) rename(from, to, text string) int64 {
	r.t.Helper()
	uid, err := writeEntry(r.st, store.Entry{Path: to, Prev: from}, []byte(text))
	if err != nil {
		r.t.Fatalf("renaming %s to %s: %v", from, to, err)
	}
	return uid
}

func (r *rig) remove(path string) int64 {
	r.t.Helper()
	uid, err := writeEntry(r.st, store.Entry{Path: path, Deleted: true}, nil)
	if err != nil {
		r.t.Fatalf("deleting %s: %v", path, err)
	}
	return uid
}

// indexed waits for the search index to have indexed everything.
func (r *rig) indexed() {
	r.t.Helper()
	if r.idx == nil {
		return
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		latest, _ := r.st.LatestUID(testVault)
		s := r.idx.Status()
		if s.Usable && !s.Rebuilding && s.IndexedHead == latest {
			return
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("the index did not reach %d: %+v", latest, s)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// bearerTransport adds a bearer token to every request.
type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (b bearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	if b.token != "" {
		req.Header.Set("Authorization", "Bearer "+b.token)
	}
	return b.base.RoundTrip(req)
}

// connect is the official Go SDK's client, connected with token at version
// ("" is the SDK's own choice, its newest).
func (r *rig) connect(token, version string) (*sdk.ClientSession, error) {
	client := sdk.NewClient(&sdk.Implementation{Name: "trew-test", Version: "1"}, nil)
	transport := &sdk.StreamableClientTransport{
		Endpoint:   r.url,
		HTTPClient: &http.Client{Transport: bearerTransport{token: token, base: http.DefaultTransport}},
		MaxRetries: -1,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return client.Connect(ctx, transport, &sdk.ClientSessionOptions{ProtocolVersion: version})
}

func (r *rig) mustConnect(token, version string) *sdk.ClientSession {
	r.t.Helper()
	cs, err := r.connect(token, version)
	if err != nil {
		r.t.Fatalf("connecting at %q: %v", version, err)
	}
	r.t.Cleanup(func() { cs.Close() })
	return cs
}

// envelope is a tool result's envelope, decoded from its structured content.
type envelope struct {
	SchemaVersion int             `json:"schema_version"`
	Tool          string          `json:"tool"`
	Security      Security        `json:"security"`
	Trusted       json.RawMessage `json:"trusted"`
	Untrusted     json.RawMessage `json:"untrusted_content"`
	raw           []byte
	isError       bool
}

func (e envelope) errorCode() string {
	var t struct {
		Error *ToolError `json:"error"`
	}
	if json.Unmarshal(e.Trusted, &t) != nil || t.Error == nil {
		return ""
	}
	return t.Error.Code
}

// invoke calls a tool through an SDK session and decodes its envelope,
// checking the text content and the structured content are the same object.
func invoke(t *testing.T, cs *sdk.ClientSession, tool string, args map[string]any) envelope {
	t.Helper()
	if args == nil {
		args = map[string]any{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := cs.CallTool(ctx, &sdk.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	if len(res.Content) != 1 {
		t.Fatalf("%s: %d content blocks", tool, len(res.Content))
	}
	tc, ok := res.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("%s: content is %T", tool, res.Content[0])
	}
	structured, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	if json.Unmarshal([]byte(tc.Text), &a) != nil || json.Unmarshal(structured, &b) != nil || !jsonEqual(a, b) {
		t.Fatalf("%s: the text and the structured content differ:\n%s\n%s", tool, tc.Text, structured)
	}
	return readEnvelope(t, []byte(tc.Text), res.IsError)
}

func readEnvelope(t *testing.T, raw []byte, isError bool) envelope {
	t.Helper()
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("not an envelope: %v\n%s", err, raw)
	}
	var top map[string]json.RawMessage
	_ = json.Unmarshal(raw, &top)
	if len(top) != 5 || e.SchemaVersion != SchemaVersion || e.Security.Notice != Warning {
		t.Fatalf("an envelope with keys %v: %s", keysOf(top), raw)
	}
	e.raw, e.isError = raw, isError
	if (e.errorCode() != "") != isError {
		t.Fatalf("isError %v with trusted %s", isError, e.Trusted)
	}
	return e
}

func keysOf(m map[string]json.RawMessage) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func (e envelope) trusted(t *testing.T, into any) {
	t.Helper()
	if err := json.Unmarshal(e.Trusted, into); err != nil {
		t.Fatalf("trusted %s: %v", e.Trusted, err)
	}
}

func (e envelope) untrusted(t *testing.T, into any) {
	t.Helper()
	if err := json.Unmarshal(e.Untrusted, into); err != nil {
		t.Fatalf("untrusted %s: %v", e.Untrusted, err)
	}
}

// rpc is one hand-built request: its body and headers, as a client that is
// not the SDK might send them.
type rpc struct {
	body    string
	headers map[string]string
}

// legacy is a request at 2025-11-25, after initialize.
func legacy(token, body string) rpc {
	return rpc{body: body, headers: map[string]string{
		"Authorization": "Bearer " + token, "Mcp-Protocol-Version": Version20251125,
	}}
}

// modern is a 2026-07-28 request for method, with the _meta and the headers
// that version requires. params is the rest of params as a JSON object's
// members, or empty.
func modern(token string, id int, method, name, params string) rpc {
	meta := `"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}`
	if params != "" {
		params += ","
	}
	h := map[string]string{
		"Authorization": "Bearer " + token, "Mcp-Protocol-Version": Version20260728, "Mcp-Method": method,
	}
	if name != "" {
		h["Mcp-Name"] = name
	}
	return rpc{body: `{"jsonrpc":"2.0","id":` + strconv.Itoa(id) + `,"method":"` + method + `","params":{` + params + meta + `}}`, headers: h}
}

// post sends a hand-built request and returns the status, the headers and the
// body.
func (r *rig) post(q rpc) (int, http.Header, []byte) {
	r.t.Helper()
	req, err := http.NewRequest(http.MethodPost, r.url, strings.NewReader(q.body))
	if err != nil {
		r.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range q.headers {
		if v == "" {
			req.Header.Del(k)
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		r.t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, body
}

// rpcReply is a JSON-RPC response as a test reads it.
type rpcReply struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	} `json:"error"`
}

func parseReply(t *testing.T, body []byte) rpcReply {
	t.Helper()
	var r rpcReply
	if err := json.Unmarshal(body, &r); err != nil {
		t.Fatalf("not a JSON-RPC reply: %v\n%s", err, body)
	}
	return r
}

// toolReply decodes a hand-built tools/call's result into its envelope.
func toolReply(t *testing.T, body []byte) envelope {
	t.Helper()
	r := parseReply(t, body)
	if r.Error != nil {
		t.Fatalf("a JSON-RPC error where a tool result was wanted: %+v", r.Error)
	}
	var res struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(r.Result, &res); err != nil || len(res.Content) != 1 {
		t.Fatalf("a tool result %s: %v", r.Result, err)
	}
	return readEnvelope(t, []byte(res.Content[0].Text), res.IsError)
}
