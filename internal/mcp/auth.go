package mcp

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/waynehoover/trew/internal/store"
)

// credential is a request's token as it was authenticated.
type credential struct {
	token store.MCPToken
	hash  string
}

// bearer reads "Authorization: Bearer <token>", exactly: one header, the
// scheme spelled "Bearer" with one space, and 43 characters of unpadded
// base64url that decode to 32 bytes with no stray bits. Anything else is no
// credential, which is answered like a wrong one.
func bearer(r *http.Request) ([]byte, bool) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return nil, false
	}
	token, ok := strings.CutPrefix(values[0], "Bearer ")
	if !ok {
		return nil, false
	}
	return store.DecodeToken(token, store.MCPTokenBytes)
}

// authenticate is the check at the door: a token this vault holds, not
// expired. It reads the store every time rather than a cache, because a
// revoke has to be seen by the next request without anybody remembering to
// invalidate anything.
func (h *Handler) authenticate(r *http.Request, now time.Time) (*credential, error) {
	raw, ok := bearer(r)
	if !ok {
		return nil, nil
	}
	tok, ok, err := h.st.MatchMCPToken(h.vault, raw)
	if err != nil || !ok {
		return nil, err
	}
	if tok.Expired(now.UnixMilli()) {
		return nil, nil
	}
	return &credential{token: tok, hash: store.MCPTokenHash(raw)}, nil
}

// current is the credential as it stands now, for the rechecks after the
// door: before a tool is dispatched, before its reply is sent, and, for a
// write, under the commit lock (PLAN.md section 2.3). It returns the token row
// as it now reads, or nil when the token was revoked or has expired since.
func (h *Handler) current(c *credential, now time.Time) (*store.MCPToken, error) {
	tok, ok, err := h.st.CheckMCPToken(h.vault, c.token.ID, c.hash)
	if err != nil || !ok || tok.Expired(now.UnixMilli()) {
		return nil, err
	}
	return &tok, nil
}

// remoteHost is the address a failed authentication is counted against: the
// connection's own, never a forwarded header a client can write.
func remoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// usage counts each token's authenticated requests and writes them to the
// store at most once a minute per token, with last_used: a write a minute per
// token in use rather than one per request, on the store's write lock beside
// every device's commit. The first request in a minute is written before it
// is answered; the rest are held and written by the next one, by the minute
// flush, before a listing and at shutdown. A crash loses at most the held
// counts, which is at most a minute of them.
type usage struct {
	mu      sync.Mutex
	st      *store.Store
	vault   string
	log     *slog.Logger
	pending map[string]*tokenUse
}

type tokenUse struct {
	held    int64
	last    int64 // milliseconds
	written int64 // milliseconds, when the counts were last written
}

// usageEvery is how often a token's use is written.
const usageEvery = time.Minute

func newUsage(st *store.Store, vault string, log *slog.Logger) *usage {
	return &usage{st: st, vault: vault, log: log, pending: map[string]*tokenUse{}}
}

// note counts one request by the token at now.
func (u *usage) note(id string, now time.Time) {
	at := now.UnixMilli()
	u.mu.Lock()
	t := u.pending[id]
	if t == nil {
		t = &tokenUse{}
		u.pending[id] = t
	}
	t.held++
	if at > t.last {
		t.last = at
	}
	if at-t.written < usageEvery.Milliseconds() {
		u.mu.Unlock()
		return
	}
	count, last := t.held, t.last
	t.held, t.written = 0, at
	u.mu.Unlock()
	u.write(id, last, count)
}

func (u *usage) write(id string, last, count int64) {
	if err := u.st.NoteMCPTokenUse(u.vault, id, last, count); err != nil {
		// Held again, for the next flush: a count lost to a full disk is a
		// count that could have shown a stolen token.
		u.mu.Lock()
		if t := u.pending[id]; t != nil {
			t.held += count
		}
		u.mu.Unlock()
		u.log.Warn("could not record an MCP token's use", "token", id, "err", err)
	}
}

// flush writes every held count.
func (u *usage) flush() {
	u.mu.Lock()
	type due struct {
		id          string
		last, count int64
	}
	var all []due
	for id, t := range u.pending {
		if t.held > 0 {
			all = append(all, due{id, t.last, t.held})
			t.held = 0
		}
	}
	u.mu.Unlock()
	for _, d := range all {
		u.write(d.id, d.last, d.count)
	}
}

// forget drops a revoked token's held counts, which have no row to go to.
func (u *usage) forget(id string) {
	u.mu.Lock()
	delete(u.pending, id)
	u.mu.Unlock()
}
