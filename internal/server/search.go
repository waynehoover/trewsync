package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trew/internal/budget"
	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/wire"
)

// A device's search (protocol 2; plan/protocol.md, "Search"): `trew search`
// in the headless client, answered by the same literal search as MCP's
// search_notes (internal/search), over the vault this session authenticated
// to, with the same query rules, page caps and continuation. What is a
// device's own is the reply, a plain protocol frame rather than the MCP
// envelope, and the budget.
//
// The budget. A search reads notes from the store, and a session serves one
// request at a time, so a device searching delays only its own requests; but
// the store and the disk are every device's, and a device that searched
// without pause would slow the sync of all the others. So searches are
// admitted three ways before anything is read: a few at once across the
// whole server, fewer at once for one device, and one device's requests and
// reply bytes through token buckets with MCP's per-token figures. Past any of
// them the request is refused `toomany` with the wait, and the session goes
// on. Nothing else a device does passes through these budgets, and a search
// never takes the commit lock.

// SearchLimits are the device searches' budgets. The zero value of a field
// means its default.
type SearchLimits struct {
	// InFlight is how many device searches the server runs at once, for
	// every device together: 4.
	InFlight int
	// DeviceInFlight is how many one device may have at once, over all its
	// sessions: 2.
	DeviceInFlight int
	// Rate and Burst are one device's sustained searches per second and how
	// many it may make at once from rest: 5 and 30, as an MCP token's.
	Rate  float64
	Burst float64
	// BytesRate and BytesBurst are the same for the bytes of the replies it
	// is sent: 4 MiB a second and 16 MiB, as an MCP token's.
	BytesRate  float64
	BytesBurst float64
	// Deadline bounds how long one search may work: 30 seconds, as an MCP
	// tool's.
	Deadline time.Duration
}

func (l SearchLimits) withDefaults() SearchLimits {
	def := func(v *float64, d float64) {
		if *v <= 0 {
			*v = d
		}
	}
	if l.InFlight <= 0 {
		l.InFlight = 4
	}
	if l.DeviceInFlight <= 0 {
		l.DeviceInFlight = 2
	}
	def(&l.Rate, 5)
	def(&l.Burst, 30)
	def(&l.BytesRate, 4<<20)
	def(&l.BytesBurst, 16<<20)
	if l.Deadline <= 0 {
		l.Deadline = 30 * time.Second
	}
	return l
}

// searchBudgets are every device's, by vault and device id.
type searchBudgets struct {
	mu       sync.Mutex
	limits   SearchLimits
	inFlight int
	devices  map[string]*deviceSearch
}

type deviceSearch struct {
	inFlight int
	requests *budget.Bucket
	bytes    *budget.Bucket
}

func newSearchBudgets(l SearchLimits) *searchBudgets {
	return &searchBudgets{limits: l.withDefaults(), devices: map[string]*deviceSearch{}}
}

// admit takes a slot of the server's and of the device's, and one of its
// requests, if all are there and its byte budget is out of debt; otherwise it
// says what was short and how long to wait.
func (b *searchBudgets) admit(key string, now time.Time) (release func(), wait time.Duration, why string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.devices[key]
	if d == nil {
		d = &deviceSearch{
			requests: budget.New(b.limits.Rate, b.limits.Burst, now),
			bytes:    budget.New(b.limits.BytesRate, b.limits.BytesBurst, now),
		}
		b.devices[key] = d
	}
	switch {
	case b.inFlight >= b.limits.InFlight:
		return nil, time.Second, "the server is running as many searches as it runs at once"
	case d.inFlight >= b.limits.DeviceInFlight:
		return nil, time.Second, "this device has as many searches running as it may"
	}
	if ok, w := d.bytes.Ready(now); !ok {
		return nil, w, "this device has been sent as many search results as it may be for now"
	}
	if ok, w := d.requests.Take(now, 1); !ok {
		return nil, w, "this device has searched as often as it may for now"
	}
	b.inFlight++
	d.inFlight++
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			b.inFlight--
			d.inFlight--
			b.mu.Unlock()
		})
	}, 0, ""
}

// sent charges a device for the bytes of a reply.
func (b *searchBudgets) sent(key string, n int, now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if d := b.devices[key]; d != nil {
		d.bytes.Charge(now, float64(n))
	}
}

// forget drops a revoked device's budget.
func (b *searchBudgets) forget(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.devices, key)
}

// SetSearchLimits replaces the device searches' budgets; the budgets already
// held are dropped.
func (s *Server) SetSearchLimits(l SearchLimits) { s.searches.Store(newSearchBudgets(l)) }

// indexFor is the index device searches of vault ask for candidates.
type indexFor struct {
	vault string
	ix    search.Proposer
}

// SetSearchIndex gives device searches of vault the search index, which
// `serve -mcp` keeps. Without one, a search scans every note, which costs
// speed and never a match. A nil ix takes it away.
func (s *Server) SetSearchIndex(vault string, ix search.Proposer) {
	if ix == nil {
		s.searchIndex.Store(nil)
		return
	}
	s.searchIndex.Store(&indexFor{vault: vault, ix: ix})
}

// searchKey is a device's key in the budgets.
func searchKey(vault, device string) string { return vault + "\x00" + device }

// handleSearch answers one page of a search for this device.
func (s *Session) handleSearch(m wire.In) error {
	key := searchKey(s.vaultID, s.deviceID)
	budgets := s.srv.searches.Load()
	release, wait, why := budgets.admit(key, s.srv.now())
	if release == nil {
		s.srv.metrics.RateLimited()
		return s.writeJSON(s.errFrame(s.reqID, wire.CodeTooMany, "toomany: "+why+"; ask again after the wait", max(wait, time.Millisecond)))
	}
	defer release()
	// A revoked device is refused before anything is read, and its session
	// ends, as it does for a mutation. The revoke has usually ended the
	// session already; this is the moment between.
	if err := s.currentCredential(); err != nil {
		if errors.Is(err, errSessionRevoked) {
			return s.fatal(wire.CodeAuth, err)
		}
		s.srv.log.Error("search", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("could not check this device's credential"))
	}

	mode := m.Mode
	if mode == "" {
		mode = string(notes.ModeContent)
	}
	includeChildren := true
	if m.IncludeChildren != nil {
		includeChildren = *m.IncludeChildren
	}
	if m.Limit < 0 {
		return s.refuseSearch(&notes.Refusal{Code: "invalid_limit", Message: "the requested page limit is invalid"})
	}
	limit := m.Limit
	if limit == 0 {
		limit = 50
	}
	if len(m.After) > notes.MaxCursorLength {
		return s.refuseSearch(&notes.Refusal{Code: "input_too_large", Message: "the supplied text exceeds its byte limit"})
	}
	if m.Folder != "" {
		if len(m.Folder) > paths.MaxPathBytes {
			return s.refuseSearch(&notes.Refusal{Code: "input_too_large", Message: "the supplied text exceeds its byte limit"})
		}
		if r := paths.Check(m.Folder); r != "" {
			return s.reject(wire.CodeBadPath, fmt.Errorf("%s: the folder is not a path this vault can hold", r))
		}
	}
	q := notes.Query{Text: m.Query, Mode: notes.SearchMode(mode), CaseSensitive: m.CaseSensitive,
		ContextLines: m.ContextLines, IncludeChildren: includeChildren}

	src := search.Source{Store: s.srv.st, Bodies: s.srv.st.Chunks(), Vault: s.vaultID, Log: s.srv.log}
	if f := s.srv.searchIndex.Load(); f != nil && f.vault == s.vaultID {
		src.Index = f.ix
	}
	deadline := budgets.limits.Deadline
	ctx, cancel := context.WithTimeout(s.ctx, deadline)
	defer cancel()
	page, err := src.Search(ctx, search.Request{Tool: "search", Query: q, Folder: m.Folder,
		Cursor: m.After, Resuming: m.After != "", Limit: limit})
	if err != nil {
		var r *notes.Refusal
		switch {
		case errors.As(err, &r):
			return s.refuseSearch(r)
		case errors.Is(err, search.ErrExpired):
			return s.reject(wire.CodeStale, fmt.Errorf("expired: %w", err))
		case errors.Is(err, context.DeadlineExceeded) && s.ctx.Err() == nil:
			return s.writeJSON(s.errFrame(s.reqID, wire.CodeTooMany, fmt.Sprintf(
				"deadline: the search took longer than %s; narrow it with a folder or a longer query",
				deadline), time.Second))
		}
		s.srv.log.Error("search", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the search could not be completed; the server's log says why"))
	}

	reply := wire.Searched{Res: "searched", ID: s.reqID, Matches: make([]wire.SearchMatch, len(page.Hits)),
		Skipped: make([]wire.SearchSkipped, len(page.Skipped)), NextAfter: page.NextCursor, Complete: page.Complete,
		Head: page.Head, IndexedHead: page.Proposal.IndexedHead,
		Index:   wire.SearchIndex{Usable: page.Proposal.Usable, Why: page.Proposal.Why},
		Scanned: page.Scanned, ScannedBytes: page.ScannedBytes}
	for i, h := range page.Hits {
		reply.Matches[i] = wire.SearchMatch{Path: h.Path, UID: h.UID, Line: h.Line, Column: h.Column, Text: h.Text,
			Before: nonNil(h.Before), After: nonNil(h.After), Clipped: h.Clipped, Kind: h.Kind}
	}
	for i, k := range page.Skipped {
		reply.Skipped[i] = wire.SearchSkipped{Path: k.Path, Why: k.Why}
	}
	b, err := json.Marshal(reply)
	if err != nil {
		return err
	}
	budgets.sent(key, len(b), s.srv.now())
	return s.send(websocket.MessageText, b)
}

// refuseSearch answers a query the matcher refuses: `badentry`, the reason
// first and a colon, as `invalid_query: the search literal cannot be empty`.
// A refusal about the query is a fact about the request, which the session
// survives.
func (s *Session) refuseSearch(r *notes.Refusal) error {
	return s.reject(wire.CodeBadEntry, errors.New(r.Code+": "+r.Message))
}
