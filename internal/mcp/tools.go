package mcp

import (
	"bytes"
	"context"
	"errors"
	"strings"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/store"
)

// The read tools of plan/mcp-tools.md, on the store.
//
// Every result is an envelope. Server facts go under trusted: uids, sizes,
// counts, times, the head, the epoch, cursors the server minted, and a path
// only when it is the caller's own argument, which the path rules have just
// accepted. Everything that came from a note or a device goes under
// untrusted_content, through Normalize: note text, match context and diff
// text, and the paths, names and device labels a listing finds in the vault,
// which any device, web clipper or earlier agent could have chosen. A row
// about such a path is kept whole under untrusted_content rather than split,
// so an agent reads a path beside its facts.

// SearchIndex is what the tools ask of the search index; *search.Index is
// one. Nil means there is none, and search scans, and a move or a deletion
// that rewrites backlinks reads every note.
type SearchIndex interface {
	Status() search.Status
	Propose(ctx context.Context, q notes.Query, folder, from string) (search.Proposal, error)
	Backlinks(ctx context.Context, head int64, keys []string) (search.Backlinks, error)
	Await(ctx context.Context, head int64) bool
}

// maxSafe is JavaScript's Number.MAX_SAFE_INTEGER, the largest uid.
const maxSafe = 1<<53 - 1

// PageRowsBytes bounds a listing page's rows, as JSON, and HistoryPageBytes a
// history, deletions or comparison page's (plan/mcp-tools.md).
const (
	PageRowsBytes    = 192 * 1024
	HistoryPageBytes = 128 * 1024
)

func readTools() []*Tool {
	return []*Tool{
		{
			Name: "vault_status", Title: "Vault status", Scope: store.ScopeRead,
			Description: "What the vault holds and how the server is doing: its head uid and epoch, counts of notes, " +
				"attachments, folders and deletions, the search index's state, and the devices that sync it. Store facts only.",
			Input: object(nil, map[string]schema{}),
			Run:   vaultStatus,
		},
		{
			Name: "list_notes", Title: "List notes", Scope: store.ScopeRead,
			Description: "List the vault's paths, sorted, with each one's kind (note, attachment or folder), size, mtime and " +
				"current uid. Follow nextAfter for the next page; every page is read as of the head the first one pinned.",
			Input: object(nil, map[string]schema{
				"folder":         textProp(paths.MaxPathBytes, "only paths beneath this folder"),
				"nameContains":   textProp(1024, "only paths whose file name contains this, case-sensitively"),
				"after":          textProp(notes.MaxCursorLength, "the nextAfter of the previous page"),
				"limit":          intProp(1, 500, "the most rows on a page, 100 by default"),
				"includeDeleted": boolProp("also list paths whose newest version is a deletion"),
			}),
			Run: listNotes,
		},
		{
			Name: "read_note", Title: "Read a note", Scope: store.ScopeRead,
			Description: "Read a page of a note's text, lines with their terminators. The uid in the result is the version the " +
				"text came from: pass it as base to read the next page of the same version, or to a later edit. With uid, " +
				"read that version from history instead of the head.",
			Input: object([]string{"path"}, map[string]schema{
				"path":      textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"uid":       intProp(1, maxSafe, "a version of this note to read instead of the head"),
				"startLine": intProp(1, maxSafe, "the first line of the page, 1 by default"),
				"maxLines":  intProp(1, notes.MaxPageLines, "the most lines on the page, 200 by default"),
				"base":      intProp(1, maxSafe, "refuse with stale if the note's head is no longer this uid"),
			}),
			Run: readNote,
		},
		{
			Name: "search_notes", Title: "Search notes", Scope: store.ScopeRead,
			Description: "Search for a literal string in notes' text, file names, both, or for a tag. Matches are exact " +
				"substrings, case-insensitive unless caseSensitive. Follow nextCursor; complete is false while a page " +
				"budget binds or a note could not be searched, which skipped says.",
			Input: object([]string{"query"}, map[string]schema{
				"query":           textProp(notes.MaxQueryBytes, "the literal text, or the tag in tag mode"),
				"mode":            enumProp("what to match against, content by default", "content", "filename", "both", "tag"),
				"includeChildren": boolProp("in tag mode, also match nested tags (tag/child), true by default"),
				"folder":          textProp(paths.MaxPathBytes, "only notes beneath this folder"),
				"caseSensitive":   boolProp("match case exactly"),
				"cursor":          textProp(notes.MaxCursorLength, "the nextCursor of the previous page"),
				"limit":           intProp(1, notes.MaxSearchLimit, "the most matches on a page, 50 by default"),
				"contextLines":    intProp(0, notes.MaxContextLines, "lines of context before and after each match"),
			}),
			Run: searchNotes,
		},
		{
			Name: "note_history", Title: "Note history", Scope: store.ScopeRead,
			Description: "List the versions of one path, newest first: uid, size, times, the device label that wrote " +
				"each, and whether it was a deletion, a folder or a rename. Device labels are what devices reported, not proof.",
			Input: object([]string{"path"}, map[string]schema{
				"path":   textProp(paths.MaxPathBytes, "the path in the vault"),
				"before": intProp(1, maxSafe, "the nextBefore of the previous page"),
				"limit":  intProp(1, 100, "the most versions on a page, 20 by default"),
			}),
			Run: noteHistory,
		},
		{
			Name: "deleted_notes", Title: "Deleted notes", Scope: store.ScopeRead,
			Description: "List paths whose newest version is a deletion, newest first, with restorable, the newest uid " +
				"that still holds content (0 when none does). Renames are not listed as deletions.",
			Input: object(nil, map[string]schema{
				"before": intProp(1, maxSafe, "the nextBefore of the previous page"),
				"limit":  intProp(1, 200, "the most rows on a page, 50 by default"),
			}),
			Run: deletedNotes,
		},
		{
			Name: "compare_versions", Title: "Compare versions", Scope: store.ScopeRead,
			Description: "Compare two versions of a note line by line. Without toUid, compare with the head, and pass the " +
				"to.uid the first page reports as toUid on every later page. coarse means the difference was too large to " +
				"compare line by line and is one change.",
			Input: object([]string{"path", "fromUid"}, map[string]schema{
				"path":    textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"fromUid": intProp(1, maxSafe, "the earlier version"),
				"toUid":   intProp(1, maxSafe, "the later version, the head by default"),
				"after":   intProp(0, 1_000_000, "the nextAfter of the previous page"),
				"limit":   intProp(1, 100, "the most changes on a page, 20 by default"),
			}),
			Run: compareVersions,
		},
		{
			Name: "delivery_status", Title: "Delivery status", Scope: store.ScopeRead,
			Description: "Which devices are connected and which uid each has confirmed applying. received means the " +
				"device has applied the head; a commit is durable when it is made, and delivered only when this says so.",
			Input: object(nil, map[string]schema{}),
			Run:   deliveryStatus,
		},
	}
}

// observe is when and where this result was read.
func (c *call) observe() (Observed, error) {
	head, err := c.h.st.LatestUID(c.h.vault)
	if err != nil {
		return Observed{}, err
	}
	return Observed{Head: head, Epoch: c.h.st.Epoch(), ObservedAt: c.now.UnixMilli()}, nil
}

// text is note-derived text for untrusted_content.
func text(s string) Text { return Normalize(s) }

func texts(ss []string) []Text {
	out := make([]Text, len(ss))
	for i, s := range ss {
		out[i] = Normalize(s)
	}
	return out
}

// jsonSize is how many bytes v is as JSON, which is what pages are bounded
// by.
func jsonSize(v any) int {
	b, err := encode(v)
	if err != nil {
		return 0
	}
	return len(b)
}

// kindOf is what list_notes calls a path.
func kindOf(e store.Entry) string {
	switch {
	case e.Folder:
		return "folder"
	case paths.MCPReadable(e.Path):
		return "note"
	}
	return "attachment"
}

// versionBytes is one version's bytes, every chunk checked against its name
// and the whole against the declared size. A failure names the uid and never
// a chunk, which is metadata the logs and results must not carry (PLAN.md
// section 2.2).
func (c *call) versionBytes(e store.Entry) ([]byte, error) {
	if e.Size > notes.NoteBytes {
		return nil, &ToolError{Code: "note_too_large", Message: "notes are read up to 1 MiB, and this version is larger"}
	}
	out := make([]byte, 0, e.Size)
	for _, name := range e.Chunks {
		body, err := c.h.st.Chunks().Get(c.h.vault, name)
		if err != nil {
			why := "unreadable"
			switch {
			case errors.Is(err, chunks.ErrNotFound):
				why = "missing"
			case errors.Is(err, chunks.ErrCorrupt):
				why = "damaged"
			}
			c.h.log.Error("a version's chunk could not be read", "uid", e.UID, "why", why)
			return nil, &ToolError{Code: "internal", Message: "a chunk of this version is " + why +
				" on the server; `trewd verify -deep` says which"}
		}
		out = append(out, body...)
	}
	if int64(len(out)) != e.Size {
		return nil, &ToolError{Code: "internal", Message: "this version's chunks do not add up to its size; `trewd verify -deep` reports it"}
	}
	return out, nil
}

// headNote is the note at path now: a live file, or not_found.
func (c *call) headNote(path string) (store.Entry, error) {
	e, state, _, err := c.h.st.EntryAsOf(c.h.vault, path, 0)
	if err != nil {
		return store.Entry{}, err
	}
	if state != store.PathLive || e.Folder {
		return store.Entry{}, &ToolError{Code: "not_found", Message: "no note is at that path now; deleted_notes and note_history say what was"}
	}
	return e, nil
}

// version is uid, which must be a version of path with content.
func (c *call) version(path string, uid int64) (store.Entry, error) {
	e, ok, err := c.h.st.EntryByUID(c.h.vault, uid)
	switch {
	case err != nil:
		return store.Entry{}, err
	case !ok:
		return store.Entry{}, &ToolError{Code: "version_not_found", Message: "the vault has no version with that uid"}
	case e.Path != path:
		return store.Entry{}, &ToolError{Code: "path_mismatch", Message: "that uid is a version of another path"}
	case e.Folder || e.Deleted:
		return store.Entry{}, &ToolError{Code: "not_note_content", Message: "that version records a folder or a deletion, not note content"}
	}
	return e, nil
}

func (c *call) readable(path string) error {
	if !paths.MCPReadable(path) {
		return &ToolError{Code: "unsupported_format", Message: "only Markdown and plain-text notes are read; attachments are listed, not read"}
	}
	return nil
}

func vaultStatus(c *call, a *args) outcome {
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	type index struct {
		Fresh       bool   `json:"fresh"`
		IndexedHead int64  `json:"indexedHead"`
		Generation  int64  `json:"generation"`
		Usable      bool   `json:"usable"`
		Rebuilding  bool   `json:"rebuilding"`
		Notes       int64  `json:"notes"`
		Unreadable  int64  `json:"unreadable"`
		TagFailures int64  `json:"tagFailures"`
		Why         string `json:"why,omitempty"`
		Failing     bool   `json:"failing"`
	}
	out := struct {
		Vault string `json:"vault"`
		Observed
		Entries       int64  `json:"entries"`
		Notes         int64  `json:"notes"`
		Attachments   int64  `json:"attachments"`
		Folders       int64  `json:"folders"`
		Deleted       int64  `json:"deleted"`
		Bodies        int64  `json:"bodies"`
		Bytes         int64  `json:"bytes"`
		Index         index  `json:"index"`
		ServerVersion string `json:"serverVersion"`
	}{Vault: c.h.vault, Observed: obs, ServerVersion: c.h.version}
	err = c.h.st.EachAsOf(c.h.vault, obs.Head, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		switch {
		case e.Deleted:
			out.Deleted++
		case e.Folder:
			out.Folders++
		case paths.MCPReadable(e.Path):
			out.Notes++
			out.Bytes += e.Size
		default:
			out.Attachments++
			out.Bytes += e.Size
		}
		return c.ctx.Err() == nil, nil
	})
	if err != nil {
		return c.failErr(err)
	}
	st, err := c.h.st.Stats(c.h.vault)
	if err != nil {
		return c.failErr(err)
	}
	out.Entries, out.Bodies = st.Versions, st.ChunkRefs
	if c.h.index != nil {
		s := c.h.index.Status()
		out.Index = index{
			IndexedHead: s.IndexedHead, Generation: s.Generation, Usable: s.Usable, Rebuilding: s.Rebuilding,
			Notes: s.Notes, Unreadable: s.Unreadable, TagFailures: s.TagFailures, Why: s.Distrust, Failing: s.Error != "",
		}
		out.Index.Fresh = s.Usable && !s.Rebuilding && s.IndexedHead >= obs.Head
	} else {
		out.Index.Why = "this server keeps no search index; search scans"
	}
	devices, err := c.devices(obs.Head)
	if err != nil {
		return c.failErr(err)
	}
	return c.ok(out, struct {
		Devices []deviceRow `json:"devices"`
	}{devices})
}

// deviceRow is a device as the status tools show it. It is a device's own
// claims, for display and never for authorisation, so it is untrusted as a
// whole.
type deviceRow struct {
	ID       Text   `json:"id"`
	Name     Text   `json:"name"`
	Online   bool   `json:"online"`
	Applied  *int64 `json:"applied"`
	LastSeen int64  `json:"lastSeen"`
	State    Text   `json:"state"`
}

// devices is every device registered to the vault, never an author, with
// whether it has applied head: received when it is connected and its
// confirmed checkpoint is at or past the head, waiting when it is connected
// and behind, and unconfirmed otherwise (plan/mcp-tools.md, delivery_status).
func (c *call) devices(head int64) ([]deviceRow, error) {
	ds, err := c.h.srv.DeliveryStatus(c.h.vault)
	if err != nil {
		return nil, err
	}
	out := make([]deviceRow, 0, len(ds))
	for _, d := range ds {
		state := "unconfirmed"
		if d.Online && d.Applied != nil {
			state = "waiting"
			if *d.Applied >= head {
				state = "received"
			}
		}
		out = append(out, deviceRow{
			ID: text(d.ID), Name: text(d.Name), Online: d.Online, Applied: d.Applied, LastSeen: d.LastSeen,
			State: text(state),
		})
	}
	return out, nil
}

func deliveryStatus(c *call, a *args) outcome {
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	devices, err := c.devices(obs.Head)
	if err != nil {
		return c.failErr(err)
	}
	return c.ok(struct {
		Observed
		Scope string `json:"scope"`
	}{obs, "A connected device's confirmed checkpoint, not a receipt for any one call. Names are what the devices reported."},
		struct {
			Devices []deviceRow `json:"devices"`
		}{devices})
}

// expired is invalid_cursor for a continuation that does not match, which
// says both things it can mean.
func expired() *ToolError {
	return &ToolError{Code: "invalid_cursor", Message: "this continuation was made for other options, or for the vault's " +
		"history before a restore or a purge changed it; start again without it"}
}

func listNotes(c *call, a *args) outcome {
	folder := a.folder("folder")
	nameContains, _ := a.text("nameContains", 1024)
	after, resuming := a.text("after", notes.MaxCursorLength)
	limit := int(a.integer("limit", 1, 500, 100, "invalid_limit"))
	includeDeleted := a.boolean("includeDeleted", false)
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	purges, err := c.h.st.PurgeGeneration(c.h.vault)
	if err != nil {
		return c.failErr(err)
	}
	options := []notes.Option{{Key: "tool", Value: "list_notes"}, {Key: "epoch", Value: obs.Epoch},
		{Key: "purges", Value: purges}, {Key: "folder", Value: folder}, {Key: "nameContains", Value: nameContains},
		{Key: "includeDeleted", Value: includeDeleted}}
	head, from := obs.Head, ""
	if resuming {
		h, p, err := notes.DecodeListCursor(after, options)
		if err != nil || h > obs.Head {
			return c.fail(expired())
		}
		head, from = h, p
	}

	type row struct {
		Path    Text  `json:"path"`
		Kind    Text  `json:"kind"`
		Size    int64 `json:"size"`
		MTime   int64 `json:"mtime"`
		UID     int64 `json:"uid"`
		Deleted bool  `json:"deleted,omitempty"`
	}
	rows := []row{}
	used, more, last := 0, false, ""
	err = c.h.st.EachAsOf(c.h.vault, head, store.AsOfRange{After: from, Folder: folder}, func(e store.Entry) (bool, error) {
		if e.Deleted && !includeDeleted {
			return true, nil
		}
		if nameContains != "" && !strings.Contains(e.Path[strings.LastIndexByte(e.Path, '/')+1:], nameContains) {
			return true, nil
		}
		kind := kindOf(e)
		if e.Deleted {
			kind = "deleted"
		}
		r := row{Path: text(e.Path), Kind: text(kind), Size: e.Size, MTime: e.MTime, UID: e.UID, Deleted: e.Deleted}
		size := jsonSize(r)
		if len(rows) >= limit || used+size > PageRowsBytes {
			more = true
			return false, nil
		}
		rows = append(rows, r)
		used += size
		last = e.Path
		return c.ctx.Err() == nil, nil
	})
	if err != nil {
		return c.failErr(err)
	}
	var next *string
	if more {
		s := notes.EncodeListCursor(options, head, last)
		next = &s
	}
	obs.Head = head
	return c.ok(struct {
		Observed
		NextAfter *string `json:"nextAfter"`
		Count     int     `json:"count"`
	}{obs, next, len(rows)}, struct {
		Entries []row `json:"entries"`
	}{rows})
}

func readNote(c *call, a *args) outcome {
	path := a.path("path", true)
	uid := a.integer("uid", 1, maxSafe, 0, "invalid_arguments")
	startLine := a.integer("startLine", 1, maxSafe, 1, "invalid_limit")
	maxLines := a.integer("maxLines", 1, notes.MaxPageLines, 200, "invalid_limit")
	base := a.integer("base", 1, maxSafe, 0, "invalid_arguments")
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	if err := c.readable(path); err != nil {
		return c.failErr(err)
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	if base != 0 {
		head, err := c.h.st.CurrentUID(c.h.vault, path)
		if err != nil {
			return c.failErr(err)
		}
		if head != base {
			// currentUid is this path's, never the vault's: a commit to
			// another note never makes this read stale (research section 5).
			return c.fail(&ToolError{Code: "stale", Message: "the note changed since that base; read it again and reconsider",
				Path: path, CurrentUID: &head})
		}
	}
	var e store.Entry
	source := "head"
	if uid == 0 {
		e, err = c.headNote(path)
	} else {
		e, err = c.version(path, uid)
		source = "history"
	}
	if err != nil {
		return c.failErr(err)
	}
	body, err := c.versionBytes(e)
	if err != nil {
		return c.failErr(err)
	}
	page, err := notes.Page(body, int(startLine), int(maxLines), notes.PageTextBytes)
	if err != nil {
		return c.failErr(err)
	}
	var next *int
	if !page.Complete {
		n := page.NextLine
		next = &n
	}
	return c.ok(struct {
		Path      string `json:"path"`
		UID       int64  `json:"uid"`
		Source    string `json:"source"`
		StartLine int    `json:"startLine"`
		EndLine   int    `json:"endLine"`
		NextLine  *int   `json:"nextLine"`
		Complete  bool   `json:"complete"`
		Size      int64  `json:"size"`
		Observed
	}{path, e.UID, source, page.StartLine, page.EndLine, next, page.Complete, e.Size, obs},
		struct {
			Content Text `json:"content"`
		}{text(page.Content())})
}

func noteHistory(c *call, a *args) outcome {
	path := a.path("path", true)
	before := a.integer("before", 1, maxSafe, 0, "invalid_arguments")
	limit := int(a.integer("limit", 1, 100, 20, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	versions, err := c.h.st.HistoryForPath(c.h.vault, path, before, limit+1)
	if err != nil {
		return c.failErr(err)
	}
	type row struct {
		UID          int64 `json:"uid"`
		Size         int64 `json:"size"`
		MTime        int64 `json:"mtime"`
		CTime        int64 `json:"ctime"`
		Device       Text  `json:"device"`
		Deleted      bool  `json:"deleted"`
		Folder       bool  `json:"folder"`
		PreviousPath *Text `json:"previousPath,omitempty"`
	}
	rows := []row{}
	used := 0
	more := false
	for _, v := range versions {
		r := row{UID: v.UID, Size: v.Size, MTime: v.MTime, CTime: v.CTime, Device: text(v.Device),
			Deleted: v.Deleted, Folder: v.Folder}
		if v.Prev != "" {
			p := text(v.Prev)
			r.PreviousPath = &p
		}
		size := jsonSize(r)
		if len(rows) >= limit || used+size > HistoryPageBytes {
			more = true
			break
		}
		rows = append(rows, r)
		used += size
	}
	var next *int64
	if more && len(rows) > 0 {
		n := rows[len(rows)-1].UID
		next = &n
	}
	return c.ok(struct {
		Path       string `json:"path"`
		NextBefore *int64 `json:"nextBefore"`
		Observed
	}{path, next, obs}, struct {
		Versions []row `json:"versions"`
	}{rows})
}

func deletedNotes(c *call, a *args) outcome {
	before := a.integer("before", 1, maxSafe, 0, "invalid_arguments")
	limit := int(a.integer("limit", 1, 200, 50, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	dels, more, err := c.h.st.Deleted(c.h.vault, true, limit, before)
	if err != nil {
		return c.failErr(err)
	}
	type row struct {
		Path       Text  `json:"path"`
		UID        int64 `json:"uid"`
		MTime      int64 `json:"mtime"`
		Device     Text  `json:"device"`
		Restorable int64 `json:"restorable"`
	}
	rows := []row{}
	used := 0
	for _, d := range dels {
		r := row{Path: text(d.Path), UID: d.UID, MTime: d.MTime, Device: text(d.Device), Restorable: d.RestorableUID}
		size := jsonSize(r)
		if used+size > HistoryPageBytes {
			more = true
			break
		}
		rows = append(rows, r)
		used += size
	}
	var next *int64
	if more && len(rows) > 0 {
		n := rows[len(rows)-1].UID
		next = &n
	}
	return c.ok(struct {
		More       bool   `json:"more"`
		NextBefore *int64 `json:"nextBefore"`
		Observed
	}{more, next, obs}, struct {
		Notes []row `json:"notes"`
	}{rows})
}

func compareVersions(c *call, a *args) outcome {
	path := a.path("path", true)
	fromUID := a.integer("fromUid", 1, maxSafe, 0, "invalid_arguments")
	toUID := a.integer("toUid", 1, maxSafe, 0, "invalid_arguments")
	after := int(a.integer("after", 0, 1_000_000, 0, "invalid_limit"))
	limit := int(a.integer("limit", 1, 100, 20, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	if fromUID == 0 {
		return c.fail(invalidArguments("fromUid is required"))
	}
	if after > 0 && toUID == 0 {
		// Resolving the head again on a later page could compare against a
		// newer head than the first page did (M4 task 8).
		return c.fail(&ToolError{Code: "invalid_cursor", Message: "a later page names toUid, the to.uid the first page reported"})
	}
	if err := c.readable(path); err != nil {
		return c.failErr(err)
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	from, err := c.version(path, fromUID)
	if err != nil {
		return c.failErr(err)
	}
	var to store.Entry
	if toUID == 0 {
		to, err = c.headNote(path)
	} else {
		to, err = c.version(path, toUID)
	}
	if err != nil {
		return c.failErr(err)
	}
	fromBytes, err := c.versionBytes(from)
	if err != nil {
		return c.failErr(err)
	}
	toBytes, err := c.versionBytes(to)
	if err != nil {
		return c.failErr(err)
	}
	before, err := notes.DecodeNote(fromBytes)
	if err != nil {
		return c.failErr(err)
	}
	later, err := notes.DecodeNote(toBytes)
	if err != nil {
		return c.failErr(err)
	}
	cmp := notes.CompareLines(before, later)
	page := notes.PageChanges(cmp, after, limit)
	type change struct {
		FromLine int  `json:"fromLine"`
		ToLine   int  `json:"toLine"`
		Old      Text `json:"old"`
		New      Text `json:"new"`
		OldLines int  `json:"oldLines"`
		NewLines int  `json:"newLines"`
		Clipped  bool `json:"clipped"`
	}
	changes := make([]change, len(page.Changes))
	for i, ch := range page.Changes {
		changes[i] = change{ch.FromLine, ch.ToLine, text(ch.Old), text(ch.New), ch.OldLines, ch.NewLines, ch.Clipped}
	}
	var next *int
	if page.NextAfter >= 0 {
		n := page.NextAfter
		next = &n
	}
	type ref struct {
		UID int64 `json:"uid"`
	}
	return c.ok(struct {
		Path         string `json:"path"`
		From         ref    `json:"from"`
		To           ref    `json:"to"`
		Identical    bool   `json:"identical"`
		Coarse       bool   `json:"coarse"`
		TotalChanges int    `json:"totalChanges"`
		NextAfter    *int   `json:"nextAfter"`
		Complete     bool   `json:"complete"`
		Observed
	}{path, ref{from.UID}, ref{to.UID}, bytes.Equal(fromBytes, toBytes), cmp.Coarse, len(cmp.Changes), next, page.Complete, obs},
		struct {
			Changes []change `json:"changes"`
		}{changes})
}

func searchNotes(c *call, a *args) outcome {
	query, hasQuery := a.text("query", notes.MaxQueryBytes)
	mode := a.oneOf("mode", "content", "invalid_query", "content", "filename", "both", "tag")
	includeChildren := a.boolean("includeChildren", true)
	folder := a.folder("folder")
	caseSensitive := a.boolean("caseSensitive", false)
	cursor, resuming := a.text("cursor", notes.MaxCursorLength)
	limit := int(a.integer("limit", 1, notes.MaxSearchLimit, 50, "invalid_limit"))
	contextLines := int(a.integer("contextLines", 0, notes.MaxContextLines, 0, "invalid_limit"))
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	if !hasQuery {
		return c.fail(invalidArguments("query is required"))
	}
	q := notes.Query{Text: query, Mode: notes.SearchMode(mode), CaseSensitive: caseSensitive,
		ContextLines: contextLines, IncludeChildren: includeChildren}
	// The one search both doors share (internal/search); what is left here
	// is the envelope.
	res, err := c.h.search.Search(c.ctx, search.Request{Tool: "search_notes", Query: q, Folder: folder,
		Cursor: cursor, Resuming: resuming, Limit: limit})
	if errors.Is(err, search.ErrExpired) {
		return c.fail(expired())
	}
	if err != nil {
		return c.failErr(err)
	}
	obs := Observed{Head: res.Head, Epoch: res.Epoch, ObservedAt: c.now.UnixMilli()}
	proposal := res.Proposal

	type match struct {
		Path    Text   `json:"path"`
		UID     int64  `json:"uid"`
		Line    int    `json:"line"`
		Column  int    `json:"column"`
		Text    Text   `json:"text"`
		Before  []Text `json:"before"`
		After   []Text `json:"after"`
		Clipped bool   `json:"clipped"`
		Kind    *Text  `json:"kind,omitempty"`
	}
	matches := make([]match, len(res.Hits))
	for i, m := range res.Hits {
		row := match{Path: text(m.Path), UID: m.UID, Line: m.Line, Column: m.Column, Text: text(m.Text),
			Before: texts(m.Before), After: texts(m.After), Clipped: m.Clipped}
		if m.Kind != "" {
			k := text(m.Kind)
			row.Kind = &k
		}
		matches[i] = row
	}
	type skip struct {
		Path Text `json:"path"`
		Why  Text `json:"why"`
	}
	skipped := make([]skip, len(res.Skipped))
	for i, s := range res.Skipped {
		skipped[i] = skip{text(s.Path), text(s.Why)}
	}
	type index struct {
		Generation int64  `json:"generation"`
		Usable     bool   `json:"usable"`
		Why        string `json:"why,omitempty"`
	}
	return c.ok(struct {
		NextCursor   *string `json:"nextCursor"`
		Complete     bool    `json:"complete"`
		IndexedHead  int64   `json:"indexedHead"`
		Index        index   `json:"index"`
		Scanned      int     `json:"scanned"`
		ScannedBytes int     `json:"scannedBytes"`
		SkippedCount int     `json:"skippedCount"`
		Observed
	}{res.NextCursor, res.Complete, proposal.IndexedHead, index{proposal.Generation, proposal.Usable, proposal.Why},
		res.Scanned, res.ScannedBytes, len(res.Skipped), obs},
		struct {
			Matches []match `json:"matches"`
			Skipped []skip  `json:"skipped"`
		}{matches, skipped})
}

// The search index is a SearchIndex.
var _ SearchIndex = (*search.Index)(nil)
