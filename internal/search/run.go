package search

import (
	"context"
	"errors"
	"log/slog"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/store"
)

// One search, two doors. MCP's search_notes and a device's `search` (protocol
// 2; plan/protocol.md, "Search") both come here, so an agent and a person
// asking the same question of the same vault get the same matches, the same
// pages and the same verdict on completeness. What differs is only how each
// door dresses the page: the MCP envelope for an agent, with every string
// normalized and marked untrusted, and a plain protocol reply for a device,
// whose client makes note text safe for a terminal itself.

// Proposer is what a search asks for candidates: the index, or nothing, in
// which case every note is scanned.
type Proposer interface {
	Propose(ctx context.Context, q notes.Query, folder, from string) (Proposal, error)
}

// The index proposes.
var _ Proposer = (*Index)(nil)

// Reader is the part of the store a search reads, and all of it: the log as
// of a head, and the epoch and purge generation a continuation binds. It
// holds no method that writes, so a Source cannot change a note whoever
// builds it (internal/mcp's commit boundary check, which cannot follow the
// store into this package, relies on it). *store.Store is one.
type Reader interface {
	LatestUID(vaultID string) (int64, error)
	Epoch() string
	PurgeGeneration(vaultID string) (int64, error)
	EachAsOf(vaultID string, head int64, r store.AsOfRange, fn func(store.Entry) (bool, error)) error
	EntryByUID(vaultID string, uid int64) (store.Entry, bool, error)
}

// Bodies is where a search reads a version's chunks: the chunk store's Get,
// and nothing else of it.
type Bodies interface {
	Get(vaultID, name string) ([]byte, error)
}

// The store reads, and the chunk store gets.
var (
	_ Reader = (*store.Store)(nil)
	_ Bodies = (*chunks.Store)(nil)
)

// Source is the vault a search reads: the store and its chunks, the vault's
// name in it, the index when there is one, and the log a candidate that
// cannot be read is reported to.
type Source struct {
	Store  Reader
	Bodies Bodies
	Vault  string
	// Index is nil when the server keeps no index.
	Index Proposer
	Log   *slog.Logger
}

// Request is one page of a search. Tool names the door, and is bound into
// the continuation, so a cursor one door made is not accepted by the other.
// Cursor is the previous page's continuation when Resuming. Folder has been
// checked against the path rules by the caller, which is where its refusal is
// worded. Limit is 1 to notes.MaxSearchLimit.
type Request struct {
	Tool     string
	Query    notes.Query
	Folder   string
	Cursor   string
	Resuming bool
	Limit    int
}

// Hit is a match and the version of the note it is in.
type Hit struct {
	notes.PathMatch
	UID int64
}

// Page is one page of matches, with what the page says about itself.
type Page struct {
	Hits    []Hit
	Skipped []notes.Skipped
	// NextCursor resumes the search, or is nil when no page follows.
	NextCursor *string
	// Complete reports that no page follows and no note was skipped.
	Complete bool
	// Proposal says whether the index narrowed the candidates, and how far
	// it had indexed.
	Proposal     Proposal
	Scanned      int
	ScannedBytes int
	// Head is the version of the vault the pages are read at: the head when
	// the first page was asked for, which every continuation keeps.
	Head  int64
	Epoch string
}

// ErrExpired is a cursor this search cannot continue: made for other
// options, or for the vault's history before a restore or a purge changed
// it. The answer is to start again without it.
var ErrExpired = errors.New("this continuation was made for other options, or for the vault's " +
	"history before a restore or a purge changed it; start again without it")

// Search answers one page. A query the matcher refuses is a *notes.Refusal,
// checked before anything is read; a cursor it cannot continue is
// ErrExpired; the store failing, or ctx ending, is that error.
func (s Source) Search(ctx context.Context, r Request) (Page, error) {
	q := r.Query
	// The query's own refusals first, before anything is read.
	if _, err := notes.SearchPage(nil, q, nil, r.Limit); err != nil {
		return Page{}, err
	}
	head, err := s.Store.LatestUID(s.Vault)
	if err != nil {
		return Page{}, err
	}
	epoch := s.Store.Epoch()
	purges, err := s.Store.PurgeGeneration(s.Vault)
	if err != nil {
		return Page{}, err
	}
	// The cursor binds the world the matches depend on: the store's epoch,
	// its purge generation and the head. Not the index generation: the index
	// only proposes, and a page's matches are the same whichever generation
	// proposed its candidates, so a rebuild between pages changes nothing a
	// continuation returns.
	options := []notes.Option{{Key: "tool", Value: r.Tool}, {Key: "epoch", Value: epoch},
		{Key: "purges", Value: purges}, {Key: "query", Value: q.Text}, {Key: "mode", Value: string(q.Mode)},
		{Key: "includeChildren", Value: q.IncludeChildren}, {Key: "folder", Value: r.Folder},
		{Key: "caseSensitive", Value: q.CaseSensitive}, {Key: "contextLines", Value: q.ContextLines}}
	var after *notes.Position
	if r.Resuming {
		h, pos, err := notes.DecodeSearchCursor(r.Cursor, options)
		if err != nil || h > head {
			return Page{}, ErrExpired
		}
		head, after = h, &pos
	}
	from := ""
	if after != nil {
		from = after.Path
	}

	var proposal Proposal
	proposal.Why = "this server keeps no search index"
	if s.Index != nil {
		p, err := s.Index.Propose(ctx, q, r.Folder, from)
		if err != nil {
			// The index failing costs this page its speed and nothing
			// else: every note is scanned.
			s.Log.Warn("the search index could not propose candidates; scanning", "err", err)
			p = Proposal{Why: "the search index could not be read"}
		}
		proposal = p
	}
	uids := map[string]int64{}
	var candidates []notes.Candidate
	err = s.Store.EachAsOf(s.Vault, head, store.AsOfRange{From: from, Folder: r.Folder}, func(e store.Entry) (bool, error) {
		if e.Deleted || e.Folder || !paths.Searchable(e.Path) {
			return true, nil
		}
		if !proposal.Candidate(e.Path, e.UID, notes.NameMatches(e.Path, q)) {
			return true, nil
		}
		version := e
		uids[e.Path] = e.UID
		candidates = append(candidates, notes.Candidate{Path: e.Path, Load: func() ([]byte, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return s.noteBytes(version)
		}})
		// One page scans at most SearchFiles notes; two more than that is
		// enough for it to know whether another page follows.
		return len(candidates) < notes.SearchFiles+2 && ctx.Err() == nil, nil
	})
	if err != nil {
		return Page{}, err
	}
	// A search cut short by its deadline would otherwise read as a complete
	// page of fewer candidates.
	if err := ctx.Err(); err != nil {
		return Page{}, err
	}
	res, err := notes.SearchPage(candidates, q, after, r.Limit)
	if err != nil {
		return Page{}, err
	}
	if err := ctx.Err(); err != nil {
		return Page{}, err
	}
	page := Page{Skipped: res.Skipped, Complete: res.Complete, Proposal: proposal,
		Scanned: res.Scanned, ScannedBytes: res.ScannedBytes, Head: head, Epoch: epoch}
	page.Hits = make([]Hit, len(res.Matches))
	for i, m := range res.Matches {
		page.Hits[i] = Hit{PathMatch: m, UID: uids[m.Path]}
	}
	if res.Next != nil {
		c := notes.EncodeSearchCursor(options, head, *res.Next)
		page.NextCursor = &c
	}
	return page, nil
}

// noteBytes is a candidate's bytes for the matcher: the version searched, or
// the refusal that stands for it, which the page reports as skipped.
func (s Source) noteBytes(e store.Entry) ([]byte, error) {
	if e.Size > notes.NoteBytes {
		return nil, &notes.Refusal{Code: "note_too_large", Message: "notes must be at most 1 MiB"}
	}
	full, ok, err := s.Store.EntryByUID(s.Vault, e.UID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &notes.Refusal{Code: "version_not_found", Message: "the version is gone"}
	}
	out := make([]byte, 0, full.Size)
	for _, name := range full.Chunks {
		body, err := s.Bodies.Get(s.Vault, name)
		if err != nil {
			why := "unreadable"
			switch {
			case errors.Is(err, chunks.ErrNotFound):
				why = "missing"
			case errors.Is(err, chunks.ErrCorrupt):
				why = "damaged"
			}
			s.Log.Error("a version's chunk could not be read", "uid", full.UID, "why", why)
			return nil, &notes.Refusal{Code: "unreadable", Message: "a chunk of this version is " + why +
				" on the server; `trewd verify -deep` says which"}
		}
		out = append(out, body...)
	}
	if int64(len(out)) != full.Size {
		return nil, &notes.Refusal{Code: "unreadable",
			Message: "this version's chunks do not add up to its size; `trewd verify -deep` reports it"}
	}
	return out, nil
}
