package mcp

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/waynehoover/trewsync/internal/notes"
	"github.com/waynehoover/trewsync/internal/paths"
	"github.com/waynehoover/trewsync/internal/search"
	"github.com/waynehoover/trewsync/internal/store"
)

// The vault-health read tools (plan/ideas.md, "Backlinks and vault health"):
// backlinks, outgoing_links, broken_links and orphans. Each finds links with
// the span reader and resolves them with the resolver a move's backlink
// rewrite uses (notes.NoteLinks over notes.LinkResolver), so wiki names,
// aliases, embeds, relative Markdown links and percent-encoded paths count
// here exactly as they would be rewritten there, and a name several notes
// share is ambiguous, reported apart from the links that resolve.
//
// Every page is read at one head, which the first page pins and every
// continuation keeps, and is bounded as a search page is: at most
// notes.SearchFiles notes and notes.SearchBytes of their text read, then a
// cursor resumes it. The link index (note_links) narrows which notes are read,
// and only when it is provably current: trusted, of this build's version, and
// indexed through exactly the pinned head, checked in the same read as its
// keys, as a move's plan uses it. Otherwise every note is read, and what that
// cannot cover says so: complete false with a cursor, or for orphans, which
// needs every note's links at once, scan_incomplete.

// maxCandidates is the most candidates an ambiguous link's row lists; the
// rest are counted in candidatesTotal.
const maxCandidates = 16

func healthTools() []*Tool {
	cursorProp := textProp(notes.MaxCursorLength, "the nextCursor of the previous page")
	return []*Tool{
		{
			Name: "backlinks", Title: "Backlinks", Scope: store.ScopeRead,
			Description: "List every link to a note (or an attachment) from other notes, with the linking note, " +
				"line, column and the link as written: wiki links and embeds by name, path or alias, and relative " +
				"or percent-encoded Markdown links, resolved as move_note resolves them. Links whose name several " +
				"notes share are listed apart, under ambiguous. Follow nextCursor; complete is false until the last page.",
			Input: object([]string{"path"}, map[string]schema{
				"path":   textProp(paths.MaxPathBytes, "the note or attachment linked to"),
				"cursor": cursorProp,
				"limit":  intProp(1, notes.MaxSearchLimit, "the most links on a page, 50 by default"),
			}),
			Run: backlinks,
		},
		{
			Name: "outgoing_links", Title: "Outgoing links", Scope: store.ScopeRead,
			Description: "List every link a note makes into the vault, with where it is, what it names, and whether " +
				"it resolves to one file (resolved), none (unresolved) or several (ambiguous), with the candidates. " +
				"Links to URLs and to the note's own headings are not listed.",
			Input: object([]string{"path"}, map[string]schema{
				"path":   textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"cursor": cursorProp,
				"limit":  intProp(1, 500, "the most links on a page, 100 by default"),
			}),
			Run: outgoingLinks,
		},
		{
			Name: "broken_links", Title: "Broken links", Scope: store.ScopeRead,
			Description: "List links whose target is not in the vault (reason missing), and unless includeAmbiguous " +
				"is false those whose name several files share (reason ambiguous), with the linking note, line and " +
				"column. Follow nextCursor; complete is false until the last page.",
			Input: object(nil, map[string]schema{
				"folder":           textProp(paths.MaxPathBytes, "only links in notes beneath this folder"),
				"includeAmbiguous": boolProp("also list ambiguous links, true by default"),
				"cursor":           cursorProp,
				"limit":            intProp(1, notes.MaxSearchLimit, "the most links on a page, 50 by default"),
			}),
			Run: brokenLinks,
		},
		{
			Name: "orphans", Title: "Orphan notes", Scope: store.ScopeRead,
			Description: "List notes no other note links to, even ambiguously, sorted by path; attachments too with " +
				"includeAttachments. It reads the whole vault's links, through the link index when it is current; " +
				"a vault too large to read in one call while the index is behind is scan_incomplete.",
			Input: object(nil, map[string]schema{
				"folder":             textProp(paths.MaxPathBytes, "only notes beneath this folder (links from anywhere count)"),
				"includeAttachments": boolProp("also list attachments nothing links to or embeds"),
				"cursor":             cursorProp,
				"limit":              intProp(1, 500, "the most notes on a page, 100 by default"),
			}),
			Run: orphans,
		},
	}
}

// pinHead is the head a first page reads at: the latest, after a moment's wait
// for the link index to reach it, taking a newer head if the vault moves on
// meanwhile, as a move's preview does (linkHead).
func (c *call) pinHead() (int64, error) {
	head, err := c.h.st.LatestUID(c.h.vault)
	if err != nil || c.h.index == nil || !c.h.index.Status().Usable {
		return head, err
	}
	ctx, cancel := context.WithTimeout(c.ctx, indexWait)
	defer cancel()
	for attempt := 0; attempt < 3; attempt++ {
		c.h.index.Await(ctx, head)
		latest, err := c.h.st.LatestUID(c.h.vault)
		if err != nil || latest == head {
			return head, err
		}
		head = latest
	}
	return head, nil
}

// healthView is the vault at a pinned head as the vault-health reads see it:
// every live file, the resolver over them, and the notes links are looked for
// in, sorted.
type healthView struct {
	*storeView
	resolve *notes.LinkResolver
	sources []string
	// scanned and bytes are what this page has read.
	scanned, bytes int
}

func (c *call) healthAt(head int64) (*healthView, error) {
	v, err := c.viewAt(head)
	if err != nil {
		return nil, err
	}
	sort.Strings(v.files)
	hv := &healthView{storeView: v, resolve: notes.NewLinkResolver(v.files, paths.Fold)}
	for _, p := range v.files {
		if notes.SourceNote(p) {
			hv.sources = append(hv.sources, p)
		}
	}
	return hv, nil
}

// spent reports whether the page's scan budget binds: search's, at most
// notes.SearchFiles notes, and no new note once notes.SearchBytes have been
// read and the page has made progress.
func (v *healthView) spent(progress bool) bool {
	return v.scanned >= notes.SearchFiles || (v.bytes >= notes.SearchBytes && progress)
}

// links reads the note at path and its links. A note that cannot be read as
// text (too large, not UTF-8, frontmatter never closed, a body the server
// cannot assemble) is a skip, with its code, and never fails the page.
func (v *healthView) links(path string) (links []notes.NoteLink, skip string, err error) {
	ver, err := v.Read(path)
	if err == nil {
		v.scanned++
		v.bytes += len(ver.Bytes)
		var text string
		if text, err = notes.DecodeNote(ver.Bytes); err == nil {
			links, err = notes.NoteLinks(text, path, v.resolve)
		}
	}
	var r *notes.Refusal
	var te *ToolError
	switch {
	case err == nil:
		return links, "", nil
	case errors.As(err, &r):
		return nil, r.Code, nil
	case errors.As(err, &te):
		return nil, te.Code, nil
	}
	return nil, "", err
}

// healthOptions are what a vault-health continuation binds: the tool, the
// store's epoch and purge generation (so a restore or a purge between pages
// expires it), and the tool's own options.
func (c *call) healthOptions(tool string, more ...notes.Option) ([]notes.Option, error) {
	purges, err := c.h.st.PurgeGeneration(c.h.vault)
	if err != nil {
		return nil, err
	}
	return append([]notes.Option{{Key: "tool", Value: tool}, {Key: "epoch", Value: c.h.st.Epoch()},
		{Key: "purges", Value: purges}}, more...), nil
}

// linkRow is one link as a vault-health page lists it, whole under
// untrusted_content: its note's path was found in the vault and its text is
// note text.
type linkRow struct {
	Path    Text  `json:"path"`
	UID     int64 `json:"uid"`
	Line    int   `json:"line"`
	Column  int   `json:"column"`
	Text    Text  `json:"text"`
	Clipped bool  `json:"clipped"`
	Target  Text  `json:"target"`
	Wiki    bool  `json:"wiki"`
	Embed   bool  `json:"embed"`
	// Reason is broken_links's: missing or ambiguous.
	Reason *Text `json:"reason,omitempty"`
	// Candidates are an ambiguous link's files, at most maxCandidates of
	// CandidatesTotal.
	Candidates      []Text `json:"candidates,omitempty"`
	CandidatesTotal int    `json:"candidatesTotal,omitempty"`
}

func rowOf(path string, uid int64, l notes.NoteLink, candidates bool) linkRow {
	r := linkRow{Path: text(path), UID: uid, Line: l.Line, Column: l.Column, Text: text(l.Text), Clipped: l.Clipped,
		Target: text(l.Target), Wiki: l.Wiki, Embed: l.Embed}
	if candidates {
		list := l.Candidates
		if len(list) > maxCandidates {
			list = list[:maxCandidates]
		}
		r.Candidates, r.CandidatesTotal = texts(list), len(l.Candidates)
	}
	return r
}

type skipRow struct {
	Path Text `json:"path"`
	Why  Text `json:"why"`
}

// linkPage is a page of link rows as it fills: at most limit rows and
// PageRowsBytes of them.
type linkPage struct {
	limit, used, rows int
}

func (p *linkPage) fit(r any) bool {
	size := jsonSize(r)
	if p.rows >= p.limit || p.used+size > PageRowsBytes {
		return false
	}
	p.rows++
	p.used += size
	return true
}

// after reports whether a link at line and column of path comes after the
// position a continuation resumes from.
func after(from *notes.Position, path string, line, column int) bool {
	return from == nil || path != from.Path || int64(line) > from.Line ||
		int64(line) == from.Line && int64(column) > from.Column
}

// pagePosition is where a page of links resumes: a cursor, or where the first
// page starts.
func (c *call) resumeAt(options []notes.Option, cursor string, resuming bool) (int64, *notes.Position, error) {
	if !resuming {
		head, err := c.pinHead()
		return head, nil, err
	}
	latest, err := c.h.st.LatestUID(c.h.vault)
	if err != nil {
		return 0, nil, err
	}
	head, pos, err := notes.DecodeSearchCursor(cursor, options)
	if err != nil || head > latest {
		return 0, nil, expired()
	}
	return head, &pos, nil
}

// healthFacts are what every vault-health page says under trusted.
type healthFacts struct {
	NextCursor   *string  `json:"nextCursor"`
	Complete     bool     `json:"complete"`
	Count        int      `json:"count"`
	Scan         scanInfo `json:"scan"`
	Scanned      int      `json:"scanned"`
	ScannedBytes int      `json:"scannedBytes"`
	SkippedCount int      `json:"skippedCount"`
	Observed
}

func (c *call) healthFacts(v *healthView, scan scanInfo, next *string, count int, skipped []skipRow) healthFacts {
	return healthFacts{NextCursor: next, Complete: next == nil && len(skipped) == 0, Count: count, Scan: scan,
		Scanned: v.scanned, ScannedBytes: v.bytes, SkippedCount: len(skipped),
		Observed: Observed{Head: v.head, Epoch: c.h.st.Epoch(), ObservedAt: c.now.UnixMilli()}}
}

func backlinks(c *call, a *args) outcome {
	target := a.path("path", true)
	cursor, resuming := a.text("cursor", notes.MaxCursorLength)
	limit := int(a.integer("limit", 1, notes.MaxSearchLimit, 50, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	options, err := c.healthOptions("backlinks", notes.Option{Key: "path", Value: target})
	if err != nil {
		return c.failErr(err)
	}
	head, from, err := c.resumeAt(options, cursor, resuming)
	if err != nil {
		return c.failErr(err)
	}
	v, err := c.healthAt(head)
	if err != nil {
		return c.failErr(err)
	}
	t, ok := v.live[target]
	if !ok {
		return c.fail(&ToolError{Code: "not_found", Message: "no file is at that path at this page's head; " +
			"deleted_notes and note_history say what was"})
	}
	scan := scanInfo{Method: "vault", Why: "this server keeps no link index"}
	var index search.Backlinks
	if c.h.index != nil {
		if index, err = c.h.index.Backlinks(c.ctx, head, notes.TargetKeys(target)); err != nil {
			c.h.log.Warn("the link index could not be read; reading every note", "err", err)
			index = search.Backlinks{Why: "the link index could not be read"}
		}
		scan = scanInfo{Method: "vault", IndexedHead: index.IndexedHead, Why: index.Why}
		if index.Current {
			scan = scanInfo{Method: "index", IndexedHead: index.IndexedHead}
		}
	}
	page := linkPage{limit: limit}
	found, ambiguous, skipped := []linkRow{}, []linkRow{}, []skipRow{}
	var last *notes.Position
	more := false
sources:
	for _, s := range v.sources {
		if from != nil && s < from.Path || paths.Fold(s) == paths.Fold(target) {
			continue
		}
		if from != nil && s == from.Path && from.Line == notes.MaxSafeLine {
			continue
		}
		uid := v.live[s].UID
		if !index.MayLink(s, uid) {
			continue
		}
		if v.spent(last != nil) {
			more = true
			break
		}
		links, skip, err := v.links(s)
		if err != nil {
			return c.failErr(err)
		}
		if skip != "" {
			skipped = append(skipped, skipRow{text(s), text(skip)})
			last = &notes.Position{Path: s, Line: notes.MaxSafeLine}
			continue
		}
		for _, l := range links {
			if !l.LinksTo(target, paths.Fold) || !after(from, s, l.Line, l.Column) {
				continue
			}
			row := rowOf(s, uid, l, len(l.Candidates) > 1)
			if !page.fit(row) {
				more = true
				break sources
			}
			if len(l.Candidates) > 1 {
				ambiguous = append(ambiguous, row)
			} else {
				found = append(found, row)
			}
			last = &notes.Position{Path: s, Line: int64(l.Line), Column: int64(l.Column)}
		}
		last = &notes.Position{Path: s, Line: notes.MaxSafeLine}
	}
	var next *string
	if more && last != nil {
		n := notes.EncodeSearchCursor(options, head, *last)
		next = &n
	}
	return c.ok(struct {
		Path           string `json:"path"`
		UID            int64  `json:"uid"`
		AmbiguousCount int    `json:"ambiguousCount"`
		healthFacts
	}{target, t.UID, len(ambiguous), c.healthFacts(v, scan, next, len(found), skipped)},
		struct {
			Backlinks []linkRow `json:"backlinks"`
			Ambiguous []linkRow `json:"ambiguous"`
			Skipped   []skipRow `json:"skipped"`
		}{found, ambiguous, skipped})
}

func outgoingLinks(c *call, a *args) outcome {
	path := a.path("path", true)
	cursor, resuming := a.text("cursor", notes.MaxCursorLength)
	limit := int(a.integer("limit", 1, 500, 100, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	if err := c.readable(path); err != nil {
		return c.failErr(err)
	}
	options, err := c.healthOptions("outgoing_links", notes.Option{Key: "path", Value: path})
	if err != nil {
		return c.failErr(err)
	}
	var head int64
	var from *notes.Position
	if resuming {
		head, from, err = c.resumeAt(options, cursor, true)
	} else {
		// One note is read, so the index has nothing to narrow: the head is
		// the latest, without waiting for it.
		head, err = c.h.st.LatestUID(c.h.vault)
	}
	if err != nil {
		return c.failErr(err)
	}
	v, err := c.healthAt(head)
	if err != nil {
		return c.failErr(err)
	}
	e, ok := v.live[path]
	if !ok {
		return c.fail(&ToolError{Code: "not_found", Message: "no note is at that path at this page's head; " +
			"deleted_notes and note_history say what was"})
	}
	ver, err := v.Read(path)
	if err != nil {
		return c.failErr(err)
	}
	source, err := notes.DecodeNote(ver.Bytes)
	if err != nil {
		return c.failErr(err)
	}
	links, err := notes.NoteLinks(source, path, v.resolve)
	if err != nil {
		return c.failErr(err)
	}
	type row struct {
		Line            int    `json:"line"`
		Column          int    `json:"column"`
		Text            Text   `json:"text"`
		Clipped         bool   `json:"clipped"`
		Target          Text   `json:"target"`
		Wiki            bool   `json:"wiki"`
		Embed           bool   `json:"embed"`
		Status          Text   `json:"status"`
		Candidates      []Text `json:"candidates"`
		CandidatesTotal int    `json:"candidatesTotal"`
	}
	var resolved, unresolved, ambiguous int
	rows := []row{}
	page := linkPage{limit: limit}
	var last *notes.Position
	more := false
	for _, l := range links {
		status := "resolved"
		switch {
		case len(l.Candidates) == 0:
			status = "unresolved"
			unresolved++
		case len(l.Candidates) > 1:
			status = "ambiguous"
			ambiguous++
		default:
			resolved++
		}
		if more || !after(from, path, l.Line, l.Column) {
			continue
		}
		list := l.Candidates
		if len(list) > maxCandidates {
			list = list[:maxCandidates]
		}
		r := row{Line: l.Line, Column: l.Column, Text: text(l.Text), Clipped: l.Clipped, Target: text(l.Target),
			Wiki: l.Wiki, Embed: l.Embed, Status: text(status), Candidates: texts(list), CandidatesTotal: len(l.Candidates)}
		if !page.fit(r) {
			more = true
			continue
		}
		rows = append(rows, r)
		last = &notes.Position{Path: path, Line: int64(l.Line), Column: int64(l.Column)}
	}
	var next *string
	if more && last != nil {
		n := notes.EncodeSearchCursor(options, head, *last)
		next = &n
	}
	return c.ok(struct {
		Path       string  `json:"path"`
		UID        int64   `json:"uid"`
		NextCursor *string `json:"nextCursor"`
		Complete   bool    `json:"complete"`
		Count      int     `json:"count"`
		Total      int     `json:"total"`
		Resolved   int     `json:"resolved"`
		Unresolved int     `json:"unresolved"`
		Ambiguous  int     `json:"ambiguous"`
		Observed
	}{path, e.UID, next, next == nil, len(rows), len(links), resolved, unresolved, ambiguous,
		Observed{Head: head, Epoch: c.h.st.Epoch(), ObservedAt: c.now.UnixMilli()}},
		struct {
			Links []row `json:"links"`
		}{rows})
}

// linkGraph is the link index for a page at head, and how the page reads the
// vault because of it.
func (c *call) linkGraph(head int64) (search.LinkGraph, scanInfo) {
	if c.h.index == nil {
		return search.LinkGraph{}, scanInfo{Method: "vault", Why: "this server keeps no link index"}
	}
	g, err := c.h.index.LinkGraph(c.ctx, head)
	if err != nil {
		c.h.log.Warn("the link index could not be read; reading every note", "err", err)
		return search.LinkGraph{}, scanInfo{Method: "vault", Why: "the link index could not be read"}
	}
	if !g.Current {
		return g, scanInfo{Method: "vault", IndexedHead: g.IndexedHead, Why: g.Why}
	}
	return g, scanInfo{Method: "index", IndexedHead: g.IndexedHead}
}

func beneath(path, folder string) bool { return folder == "" || strings.HasPrefix(path, folder+"/") }

func brokenLinks(c *call, a *args) outcome {
	folder := a.folder("folder")
	includeAmbiguous := a.boolean("includeAmbiguous", true)
	cursor, resuming := a.text("cursor", notes.MaxCursorLength)
	limit := int(a.integer("limit", 1, notes.MaxSearchLimit, 50, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	options, err := c.healthOptions("broken_links", notes.Option{Key: "folder", Value: folder},
		notes.Option{Key: "includeAmbiguous", Value: includeAmbiguous})
	if err != nil {
		return c.failErr(err)
	}
	head, from, err := c.resumeAt(options, cursor, resuming)
	if err != nil {
		return c.failErr(err)
	}
	v, err := c.healthAt(head)
	if err != nil {
		return c.failErr(err)
	}
	graph, scan := c.linkGraph(head)
	page := linkPage{limit: limit}
	rows, skipped := []linkRow{}, []skipRow{}
	var last *notes.Position
	more := false
	missing, ambiguous := text("missing"), text("ambiguous")
sources:
	for _, s := range v.sources {
		if !beneath(s, folder) || from != nil && s < from.Path ||
			from != nil && s == from.Path && from.Line == notes.MaxSafeLine {
			continue
		}
		uid := v.live[s].UID
		// A note the index proves has no link has no broken one.
		if !graph.HasLinks(s, uid) {
			continue
		}
		if v.spent(last != nil) {
			more = true
			break
		}
		links, skip, err := v.links(s)
		if err != nil {
			return c.failErr(err)
		}
		if skip != "" {
			skipped = append(skipped, skipRow{text(s), text(skip)})
			last = &notes.Position{Path: s, Line: notes.MaxSafeLine}
			continue
		}
		for _, l := range links {
			if len(l.Candidates) == 1 || len(l.Candidates) > 1 && !includeAmbiguous || !after(from, s, l.Line, l.Column) {
				continue
			}
			row := rowOf(s, uid, l, len(l.Candidates) > 1)
			row.Reason = &missing
			if len(l.Candidates) > 1 {
				row.Reason = &ambiguous
			}
			if !page.fit(row) {
				more = true
				break sources
			}
			rows = append(rows, row)
			last = &notes.Position{Path: s, Line: int64(l.Line), Column: int64(l.Column)}
		}
		last = &notes.Position{Path: s, Line: notes.MaxSafeLine}
	}
	var next *string
	if more && last != nil {
		n := notes.EncodeSearchCursor(options, head, *last)
		next = &n
	}
	return c.ok(struct {
		Folder string `json:"folder"`
		healthFacts
	}{folder, c.healthFacts(v, scan, next, len(rows), skipped)},
		struct {
			Links   []linkRow `json:"links"`
			Skipped []skipRow `json:"skipped"`
		}{rows, skipped})
}

func orphans(c *call, a *args) outcome {
	folder := a.folder("folder")
	includeAttachments := a.boolean("includeAttachments", false)
	cursor, resuming := a.text("cursor", notes.MaxCursorLength)
	limit := int(a.integer("limit", 1, 500, 100, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	options, err := c.healthOptions("orphans", notes.Option{Key: "folder", Value: folder},
		notes.Option{Key: "includeAttachments", Value: includeAttachments})
	if err != nil {
		return c.failErr(err)
	}
	var head int64
	from := ""
	if resuming {
		latest, err := c.h.st.LatestUID(c.h.vault)
		if err != nil {
			return c.failErr(err)
		}
		h, p, err := notes.DecodeListCursor(cursor, options)
		if err != nil || h > latest {
			return c.fail(expired())
		}
		head, from = h, p
	} else if head, err = c.pinHead(); err != nil {
		return c.failErr(err)
	}
	v, err := c.healthAt(head)
	if err != nil {
		return c.failErr(err)
	}
	graph, scan := c.linkGraph(head)

	// linkedBy is, for each note read, the fold of every file its links can
	// mean; a skipped note has none, and is listed.
	linkedBy := map[string]map[string]bool{}
	skipped := []skipRow{}
	read := func(s string) error {
		if _, done := linkedBy[s]; done {
			return nil
		}
		if v.spent(true) {
			return errScanBound
		}
		links, skip, err := v.links(s)
		if err != nil {
			return err
		}
		set := map[string]bool{}
		if skip != "" {
			skipped = append(skipped, skipRow{text(s), text(skip)})
		}
		for _, l := range links {
			for _, p := range l.Candidates {
				set[paths.Fold(p)] = true
			}
		}
		linkedBy[s] = set
		return nil
	}
	// The notes the index cannot speak for are read for every target.
	var unproven []string
	for _, s := range v.sources {
		if !graph.Proven(s, v.live[s].UID) {
			unproven = append(unproven, s)
		}
	}
	scanBound := func() outcome {
		return c.fail(&ToolError{Code: "scan_incomplete", Message: "deciding whether a note is linked means reading " +
			"every note that may link to it, and that is more than one call reads (512 notes or 8 MiB) while the " +
			"link index is not current for this head; try again once vault_status reports the index fresh, or " +
			"ask for a smaller limit"})
	}
	type row struct {
		Path  Text  `json:"path"`
		UID   int64 `json:"uid"`
		Kind  Text  `json:"kind"`
		Size  int64 `json:"size"`
		MTime int64 `json:"mtime"`
	}
	rows := []row{}
	page := linkPage{limit: limit}
	examined, last, more := 0, "", false
	for _, t := range v.files {
		if t <= from && from != "" || !beneath(t, folder) {
			continue
		}
		note := paths.MCPReadable(t)
		if !note && !includeAttachments {
			continue
		}
		candidates := unproven
		if graph.Current {
			share := graph.Sharing(notes.TargetKeys(t))
			candidates = append([]string(nil), unproven...)
			for s := range share {
				if notes.SourceNote(s) && v.live[s].UID != 0 && graph.Proven(s, v.live[s].UID) {
					candidates = append(candidates, s)
				}
			}
			sort.Strings(candidates)
		}
		linked := false
		for _, s := range candidates {
			if paths.Fold(s) == paths.Fold(t) {
				continue
			}
			if err := read(s); err != nil {
				if !errors.Is(err, errScanBound) {
					return c.failErr(err)
				}
				if examined == 0 {
					return scanBound()
				}
				more = true
				break
			}
			if linkedBy[s][paths.Fold(t)] {
				linked = true
				break
			}
		}
		if more {
			break
		}
		if !linked {
			kind := "note"
			if !note {
				kind = "attachment"
			}
			e := v.live[t]
			r := row{Path: text(t), UID: e.UID, Kind: text(kind), Size: e.Size, MTime: e.MTime}
			if !page.fit(r) {
				more = true
				break
			}
			rows = append(rows, r)
		}
		examined++
		last = t
	}
	var next *string
	if more && last != "" {
		n := notes.EncodeListCursor(options, head, last)
		next = &n
	}
	return c.ok(struct {
		Folder             string `json:"folder"`
		IncludeAttachments bool   `json:"includeAttachments"`
		Examined           int    `json:"examined"`
		healthFacts
	}{folder, includeAttachments, examined, c.healthFacts(v, scan, next, len(rows), skipped)},
		struct {
			Orphans []row     `json:"orphans"`
			Skipped []skipRow `json:"skipped"`
		}{rows, skipped})
}

// errScanBound is a page's scan budget binding where orphans must stop.
var errScanBound = errors.New("the scan budget binds")
