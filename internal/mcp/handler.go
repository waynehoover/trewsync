package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

// MaxBodyBytes is the largest request body the endpoint reads: 8 MiB, the
// bound Basalt's HTTP transport had. A request's arguments are bounded far
// below it by the tools' own schemas; this is what an unread body cannot
// exceed.
const MaxBodyBytes = 8 << 20

// MaxReplyBytes is the largest reply the endpoint sends: 1 MiB. A tool result
// that would exceed it is replaced by result_too_large before anything is
// written, never cut short on the wire (plan/mcp-tools.md, "Authentication
// and authorship").
const MaxReplyBytes = 1 << 20

// ServerName is what the endpoint calls itself in initialize and discover.
const ServerName = "trew"

// Config is what a Handler serves and how.
type Config struct {
	Server *server.Server
	// Vault is the one vault the server serves.
	Vault string
	// Index is the search index, or nil, in which case search_notes scans.
	Index SearchIndex
	// AllowOrigins are the browser origins a request may come from, exactly
	// as the Origin header spells them. A request with no Origin, which is
	// every client that is not a browser, is allowed.
	AllowOrigins []string
	Limits       Limits
	Log          *slog.Logger
	// Version is the server's version, reported to authenticated clients.
	Version string
	// Now is the clock, time.Now when nil.
	Now func() time.Time
	// Seam, when set, is called at each named point of a write between its
	// preparation and its reply (SeamUploading, SeamBodies, SeamCommitted,
	// SeamBroadcast), which is where the crash matrix (PLAN.md M5 task 9)
	// kills the server. Nil in every production build: only a trewd built
	// with the crashmatrix tag sets it (cmd/trewd/testseam.go).
	Seam func(point string)
	// Conventions are the vault's daily-note and template settings, for
	// today_note, append_to_daily and create_from_template; the zero value
	// is Obsidian's defaults. `trewd serve` checks them (Conventions.Check)
	// before it starts.
	Conventions Conventions
}

// Handler is the MCP endpoint, mounted at /mcp by `trewd serve --mcp`.
type Handler struct {
	srv     *server.Server
	st      *store.Store
	vault   string
	index   SearchIndex
	origins map[string]bool
	limits  Limits
	log     *slog.Logger
	version string
	now     func() time.Time
	tools   []*Tool

	budgets *budgets
	usage   *usage
	search  search.Source

	// active is every request in flight, by token id, so a revoke can end
	// them at once; each would lose at its reply check anyway.
	activeMu sync.Mutex
	active   map[string]map[*context.CancelFunc]struct{}

	stop     chan struct{}
	stopOnce sync.Once
	flushed  sync.WaitGroup

	// seam is Config.Seam.
	seam func(point string)

	// conventions are Config.Conventions with their defaults filled in, or
	// what SetConventions last gave, under convMu.
	convMu      sync.Mutex
	conventions Conventions

	// Hooks for tests, nil otherwise: beforeReply runs after a tool has
	// produced its result and before the credential is checked again, which
	// is the window a revoke must still win; duringTool runs inside a tool
	// call, before the tool.
	beforeReply func()
	duringTool  func(tool string)
}

// New builds the endpoint and starts the minute flush of token use counts.
func New(cfg Config) *Handler {
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	h := &Handler{
		srv: cfg.Server, st: cfg.Server.Store(), vault: cfg.Vault, index: cfg.Index,
		origins: map[string]bool{}, limits: cfg.Limits.withDefaults(), log: log,
		version: cfg.Version, now: now, seam: cfg.Seam, conventions: cfg.Conventions.withDefaults(),
		active: map[string]map[*context.CancelFunc]struct{}{},
		stop:   make(chan struct{}),
	}
	if h.version == "" {
		h.version = cfg.Server.Version()
	}
	for _, o := range cfg.AllowOrigins {
		h.origins[o] = true
	}
	// The search search_notes shares with a device's (internal/search),
	// which reads the store only through search.Reader, an interface with
	// no method that writes.
	h.search = search.Source{Store: h.st, Bodies: h.st.Chunks(), Vault: h.vault, Log: log}
	if cfg.Index != nil {
		h.search.Index = cfg.Index
	}
	h.budgets = newBudgets(h.limits)
	h.usage = newUsage(h.st, h.vault, log)
	h.tools = append(append(append(readTools(), healthTools()...), writeTools()...), dailyTools()...)
	h.flushed.Add(1)
	go func() {
		defer h.flushed.Done()
		t := time.NewTicker(usageEvery)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				h.usage.flush()
			case <-h.stop:
				return
			}
		}
	}()
	return h
}

// Close stops the minute flush and writes the use counts still held. Call it
// after the listener has stopped and before the store closes.
func (h *Handler) Close() {
	h.stopOnce.Do(func() { close(h.stop) })
	h.flushed.Wait()
	h.usage.flush()
}

// FlushUsage writes the use counts held for every token, for a listing.
func (h *Handler) FlushUsage() { h.usage.flush() }

// Revoked ends the requests a revoked token has in flight and forgets its
// budgets and held counts.
func (h *Handler) Revoked(tokenID string) {
	h.activeMu.Lock()
	for cancel := range h.active[tokenID] {
		(*cancel)()
	}
	delete(h.active, tokenID)
	h.activeMu.Unlock()
	h.budgets.forget(tokenID)
	h.usage.forget(tokenID)
}

func (h *Handler) track(id string, cancel *context.CancelFunc) func() {
	h.activeMu.Lock()
	m := h.active[id]
	if m == nil {
		m = map[*context.CancelFunc]struct{}{}
		h.active[id] = m
	}
	m[cancel] = struct{}{}
	h.activeMu.Unlock()
	return func() {
		h.activeMu.Lock()
		if m := h.active[id]; m != nil {
			delete(m, cancel)
			if len(m) == 0 {
				delete(h.active, id)
			}
		}
		h.activeMu.Unlock()
	}
}

// plain answers a refusal with a fixed body and no JSON: the replies before
// authentication say nothing but the status, and nothing that names the
// server, the vault or the version (TestPreAuthRepliesSayNothing).
func plain(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func unauthorized(w http.ResponseWriter) {
	// The realm and nothing else: no resource_metadata, no error codes, and
	// no OAuth discovery document anywhere on the server, because a client
	// that is told OAuth exists acts on it after a 401 (Syncidian's lesson,
	// plan/research/README.md section 5).
	w.Header().Set("WWW-Authenticate", `Bearer realm="trew"`)
	plain(w, http.StatusUnauthorized, "unauthorized")
}

func tooMany(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(retryAfter(wait)))
	plain(w, http.StatusTooManyRequests, "busy")
}

func writeJSON(w http.ResponseWriter, status int, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// ServeHTTP answers one request, in the order that keeps each check cheap for
// what it refuses: the route and the method, the origin, the endpoint's
// capacity, the credential, the token's own budgets, and only then the body.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := h.now()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Exactly /mcp: a query string is refused, so no credential or argument
	// ever travels in a URL, where proxies log it (plan/research/README.md
	// section 5).
	if r.URL.Path != "/mcp" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		plain(w, http.StatusNotFound, "")
		return
	}
	if r.Method != http.MethodPost {
		// GET and DELETE are how the session-era transport opened a stream
		// and ended a session; this endpoint has neither (2026-07-28
		// basic/transports, "Backward Compatibility").
		w.Header().Set("Allow", http.MethodPost)
		plain(w, http.StatusMethodNotAllowed, "")
		return
	}
	if origins := r.Header.Values("Origin"); len(origins) > 0 {
		if len(origins) != 1 || !h.origins[origins[0]] {
			plain(w, http.StatusForbidden, "refused")
			return
		}
	}
	release, ok := h.budgets.admit()
	if !ok {
		h.srv.Metrics().RateLimited()
		tooMany(w, time.Second)
		return
	}
	defer release()

	cred, err := h.authenticate(r, start)
	if err != nil {
		h.log.Error("MCP authentication could not read the store", "err", err)
		plain(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	if cred == nil {
		host := remoteHost(r)
		h.srv.Metrics().AuthFailed()
		if within, wait := h.budgets.failed(host, start); !within {
			h.srv.Metrics().RateLimited()
			tooMany(w, wait)
			return
		}
		h.log.Warn("MCP authorization refused", "remote", host)
		unauthorized(w)
		return
	}
	h.usage.note(cred.token.ID, start)
	releaseToken, wait, ok := h.budgets.admitToken(cred.token.ID, start)
	if !ok {
		h.srv.Metrics().RateLimited()
		tooMany(w, wait)
		return
	}
	defer releaseToken()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	untrack := h.track(cred.token.ID, &cancel)
	defer untrack()

	status, reply, tool := h.serve(ctx, w, r, cred)
	if status == 0 {
		return // answered already
	}
	h.budgets.sent(cred.token.ID, len(reply), h.now())
	h.log.Debug("MCP request", "tool", tool, "token", cred.token.ID, "status", status,
		"bytes", len(reply), "took", h.now().Sub(start))
}

// serve reads, dispatches and answers an authenticated request. It returns
// the status and the body it wrote, and the tool it called, for the log, or 0
// when it wrote a reply that is not JSON.
func (h *Handler) serve(ctx context.Context, w http.ResponseWriter, r *http.Request, cred *credential) (int, []byte, string) {
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		body := errorResponse(nil, &rpcError{code: codeInvalidRequest, message: "the body must be application/json"})
		writeJSON(w, http.StatusUnsupportedMediaType, body)
		return http.StatusUnsupportedMediaType, body, ""
	}
	if !acceptsJSON(r.Header.Values("Accept")) {
		body := errorResponse(nil, &rpcError{code: codeInvalidRequest, message: "the client must accept application/json"})
		writeJSON(w, http.StatusNotAcceptable, body)
		return http.StatusNotAcceptable, body, ""
	}
	body, status := h.readBody(w, r)
	if status != 0 {
		refused := errorResponse(nil, &rpcError{code: codeInvalidRequest, message: http.StatusText(status)})
		if status == http.StatusRequestEntityTooLarge {
			refused = errorResponse(nil, &rpcError{code: codeInvalidRequest, message: "the request body is over 8 MiB"})
		}
		writeJSON(w, status, refused)
		return status, refused, ""
	}
	if !utf8.Valid(body) {
		reply := errorResponse(nil, &rpcError{code: codeParseError, message: "the body is not valid UTF-8"})
		writeJSON(w, http.StatusBadRequest, reply)
		return http.StatusBadRequest, reply, ""
	}
	f, rerr := parseFrame(body)
	if rerr != nil {
		reply := errorResponse(nil, rerr)
		writeJSON(w, rerr.status, reply)
		return rerr.status, reply, ""
	}
	n, rerr := negotiate(r, f)
	if rerr != nil {
		if !f.isRequest() {
			plain(w, rerr.status, "")
			return 0, nil, ""
		}
		reply := errorResponse(f.id, rerr)
		writeJSON(w, rerr.status, reply)
		return rerr.status, reply, ""
	}
	if !f.isRequest() {
		// A notification: initialized, cancelled, or anything else, all of
		// which a stateless endpoint accepts and has nothing to do about. A
		// cancelled request is ended by its client closing the connection.
		plain(w, http.StatusAccepted, "")
		return 0, nil, ""
	}

	result, rerr, tool := h.dispatch(ctx, r, cred, f, n)
	if h.beforeReply != nil {
		h.beforeReply()
	}
	// The credential as it stands now, before anything it was answered is
	// sent: a token revoked while its request ran loses here, and the result
	// is dropped (M4 task 11, "a token revoked mid-request").
	if tok, err := h.current(cred, h.now()); err != nil || tok == nil {
		if err != nil {
			h.log.Error("MCP authentication could not read the store", "err", err)
		}
		unauthorized(w)
		return 0, nil, tool
	}
	status = http.StatusOK
	var reply []byte
	if rerr != nil {
		if n.era == stateless || rerr.status >= 400 && rerr.code != codeMethodNotFound && rerr.code != codeInvalidParams {
			status = rerr.status
		}
		reply = errorResponse(f.id, rerr)
	} else {
		var err error
		reply, err = encode(rpcResponse{JSONRPC: "2.0", ID: f.id, Result: result})
		if err == nil && len(reply) > MaxReplyBytes {
			reply, err = h.tooLarge(f.id, n, tool)
		}
		if err != nil {
			h.log.Error("an MCP reply could not be encoded", "tool", tool, "err", err)
			reply = errorResponse(f.id, &rpcError{code: codeInternalError, message: "the reply could not be encoded"})
		}
	}
	writeJSON(w, status, reply)
	return status, reply, tool
}

// tooLarge replaces a tool result that would exceed MaxReplyBytes with
// result_too_large, decided before anything was written.
func (h *Handler) tooLarge(id json.RawMessage, n negotiated, tool string) ([]byte, error) {
	if tool == "" {
		return errorResponse(id, &rpcError{code: codeInternalError, message: "the reply is over 1 MiB"}), nil
	}
	o := failure(tool, &ToolError{Code: "result_too_large", Message: "the result is over 1 MiB; ask for a smaller page"})
	content, err := contentOf(o)
	if err != nil {
		return nil, err
	}
	if n.era == stateless {
		content.ResultType, content.Meta = "complete", h.resultMeta()
	}
	return encode(rpcResponse{JSONRPC: "2.0", ID: id, Result: content})
}

// readBody reads at most MaxBodyBytes within the body deadline, answering
// 413 for a body over the limit, whether it is declared or only arrives.
func (h *Handler) readBody(w http.ResponseWriter, r *http.Request) ([]byte, int) {
	if r.ContentLength > MaxBodyBytes {
		return nil, http.StatusRequestEntityTooLarge
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(h.limits.BodyDeadline))
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		return nil, http.StatusRequestEntityTooLarge
	case err != nil:
		return nil, http.StatusBadRequest
	}
	return body, 0
}

// acceptsJSON reports whether an Accept header admits application/json. No
// header admits everything.
func acceptsJSON(values []string) bool {
	if len(values) == 0 {
		return true
	}
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			mt, _, err := mime.ParseMediaType(strings.TrimSpace(part))
			if err != nil {
				continue
			}
			switch mt {
			case "application/json", "application/*", "*/*":
				return true
			}
		}
	}
	return false
}

// resultMeta is the _meta a 2026-07-28 result carries: who answered.
func (h *Handler) resultMeta() map[string]any {
	return map[string]any{metaServerInfo: implementation{Name: ServerName, Version: h.version}}
}

type implementation struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// instructions is what initialize and discover tell a model about this
// server, with the warning every tool carries.
const instructions = "TrewSync serves one Obsidian vault from the server's own store. Paths are vault-relative. " +
	"Every tool result is an envelope: what the server vouches for is under \"trusted\", and everything " +
	"drawn from notes (their text, and the names and paths found in the vault) is under " +
	"\"untrusted_content\". " + Warning

// dispatch runs one request's method. A failure of the request itself is a
// JSON-RPC error; a tool that fails reports it in its own result.
func (h *Handler) dispatch(ctx context.Context, r *http.Request, cred *credential, f frame, n negotiated) (any, *rpcError, string) {
	switch {
	case n.era == handshake && f.method == "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if f.params != nil && json.Unmarshal(f.params, &p) != nil {
			return nil, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams, message: "initialize params are malformed"}, ""
		}
		return struct {
			ProtocolVersion string         `json:"protocolVersion"`
			Capabilities    map[string]any `json:"capabilities"`
			ServerInfo      implementation `json:"serverInfo"`
			Instructions    string         `json:"instructions"`
		}{negotiateInitialize(p.ProtocolVersion), map[string]any{"tools": struct{}{}},
			implementation{ServerName, h.version}, instructions}, nil, ""
	case n.era == handshake && f.method == "ping":
		return struct{}{}, nil, ""
	case n.era == stateless && f.method == "server/discover":
		return struct {
			ResultType        string         `json:"resultType"`
			SupportedVersions []string       `json:"supportedVersions"`
			Capabilities      map[string]any `json:"capabilities"`
			Instructions      string         `json:"instructions"`
			TTLMs             int            `json:"ttlMs"`
			CacheScope        string         `json:"cacheScope"`
			Meta              map[string]any `json:"_meta"`
		}{"complete", Versions, map[string]any{"tools": struct{}{}}, instructions, 0, "private", h.resultMeta()}, nil, ""
	case f.method == "tools/list":
		var p struct {
			Cursor string `json:"cursor"`
		}
		if f.params != nil && json.Unmarshal(f.params, &p) != nil || p.Cursor != "" {
			// Every tool is on the first page, so there is no cursor to
			// continue from.
			return nil, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams, message: "tools/list has one page and no cursor"}, ""
		}
		// Discovery shows the credential's scope as it stands now.
		tok, err := h.current(cred, h.now())
		if err != nil || tok == nil {
			return nil, &rpcError{status: http.StatusUnauthorized, code: codeInvalidRequest, message: "unauthorized"}, ""
		}
		tools := h.listed(tok.Scope)
		if n.era == stateless {
			// The list depends on the token's scope, so it is private to this
			// authorization, and not cached: a token's scope never changes,
			// but its revocation should be met at once (SEP-2549).
			return struct {
				ResultType string         `json:"resultType"`
				Tools      []listedTool   `json:"tools"`
				TTLMs      int            `json:"ttlMs"`
				CacheScope string         `json:"cacheScope"`
				Meta       map[string]any `json:"_meta"`
			}{"complete", tools, 0, "private", h.resultMeta()}, nil, ""
		}
		return struct {
			Tools []listedTool `json:"tools"`
		}{tools}, nil, ""
	case f.method == "tools/call":
		return h.callTool(ctx, r, cred, f, n)
	}
	status := http.StatusOK
	if n.era == stateless {
		status = http.StatusNotFound
	}
	return nil, &rpcError{status: status, code: codeMethodNotFound, message: "method not found: " + quoteKey(f.method)}, ""
}

// callTool runs tools/call: the named tool, if the token's scope allows it
// now, within the tool deadline.
func (h *Handler) callTool(ctx context.Context, r *http.Request, cred *credential, f frame, n negotiated) (any, *rpcError, string) {
	var p struct {
		Name      json.RawMessage `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	fields, err := objectFields(f.params)
	if f.params == nil || err != nil {
		return nil, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams, message: "tools/call params must be an object naming the tool"}, ""
	}
	p.Name, p.Arguments = fields["name"], fields["arguments"]
	var name string
	if len(p.Name) == 0 || p.Name[0] != '"' || json.Unmarshal(p.Name, &name) != nil || name == "" {
		return nil, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams, message: "tools/call names the tool as a string"}, ""
	}
	if n.era == stateless {
		if rerr := checkName(r, name); rerr != nil {
			return nil, rerr, ""
		}
	}
	tool := h.lookup(name)
	if tool == nil {
		return nil, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams, message: "unknown tool " + quoteKey(name)}, ""
	}
	now := h.now()
	c := &call{h: h, cred: cred, tool: tool, now: now}
	if n.era == stateless {
		c.client = clientInfo(f.params)
	}
	var o outcome
	// Dispatch: the scope of the credential as it stands now, whatever the
	// tool list the client was shown.
	switch tok, err := h.current(cred, now); {
	case err != nil:
		h.log.Error("MCP authentication could not read the store", "err", err)
		o = c.fail(&ToolError{Code: "internal", Message: "the server could not check this token"})
	case tok == nil:
		return nil, &rpcError{status: http.StatusUnauthorized, code: codeInvalidRequest, message: "unauthorized"}, tool.Name
	case !tok.Scope.Allows(tool.Scope):
		o = c.fail(&ToolError{Code: "read_only", Message: "this token has read scope and " + tool.Name +
			" changes notes; mint one with `trewd mcp-token -scope write` to use it"})
	default:
		cctx, cancel := context.WithTimeout(ctx, h.limits.ToolDeadline)
		c.ctx = cctx
		if h.duringTool != nil {
			h.duringTool(tool.Name)
		}
		o = tool.Run(c, parseArgs(p.Arguments))
		// Never over a mutation's reply (raw), committed or replayed: the
		// deadline cannot take a commit back, and busy would tell the agent
		// nothing was written, with no opId to ask about.
		if cctx.Err() != nil && !o.isError && o.raw == nil {
			o = c.fail(&ToolError{Code: "busy", Message: "the call ran out of time or was cancelled; try a smaller page"})
		}
		cancel()
	}
	content, err := contentOf(o)
	if err != nil {
		h.log.Error("an MCP result could not be encoded", "tool", tool.Name, "err", err)
		return nil, &rpcError{status: http.StatusInternalServerError, code: codeInternalError, message: "the result could not be encoded"}, tool.Name
	}
	if n.era == stateless {
		content.ResultType, content.Meta = "complete", h.resultMeta()
	}
	return content, nil, tool.Name
}
