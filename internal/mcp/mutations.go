package mcp

import (
	"strconv"

	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/store"
)

// The mutation tools of plan/mcp-tools.md, on the store, and the one read tool
// that resolves a lost reply (lookup_operation). Each is registered for write
// scope, which the dispatcher enforces at discovery and at dispatch, the commit
// boundary again under the commit lock (call.commit), and the store once more
// inside the transaction (CommitOperation's checkActor).
//
// Every one of them commits through mutation.submit and nothing else, and
// every result is an envelope: under trusted, that the operation committed,
// its id, its epoch and time, and the caller's own path arguments; under
// untrusted_content, the rows of what it wrote, and a preview's planned
// changes, which carry note text. A write tool never puts note-derived text in
// a result anywhere else, the preview half included (PLAN.md section 4.10).

// The properties every mutation shares.
var (
	epochProp = textProp(64, "the store epoch of the read the uids in this call came from, as that result's "+
		"trusted.epoch reports it; a uid names a version only within its epoch")
	keyProp = textProp(store.MaxIdempotencyKeyLen, "a name of your choosing for this request: repeating the same "+
		"request with it answers with the first result instead of writing again, which makes a retry after a lost "+
		"reply safe; a different request under a used key is refused with key_reused")
	baseProp = intProp(1, maxSafe, "the uid of the version you read, as read_note returned it; refused as stale, "+
		"with currentUid, if the note has changed since")
	headProp = intProp(0, maxSafe, "with changes: the head the preview reported, which the apply is bound to")
)

// optionalEpochProp is the epoch for a call that names no uid: when given, it
// is checked all the same.
var optionalEpochProp = textProp(64, "optional here, as nothing in the call is a uid: the store epoch of your reads, "+
	"refused as stale if the store has been restored since")

// changesProp is a preview's planned changes, passed back to apply them.
var changesProp = schema{
	"type": "array", "maxItems": notes.BatchFiles,
	"description": "the changes a preview returned, passed back exactly as shown to apply them; omit for a preview",
	"items": object([]string{"path", "base", "action", "edits"}, map[string]schema{
		"path":   textProp(paths.MaxPathBytes, "the note the change is to"),
		"base":   intProp(1, maxSafe, "the uid the change was planned against"),
		"action": enumProp("what the change does", "edit", "move", "delete"),
		"to":     textProp(paths.MaxPathBytes, "a move's destination"),
		"edits": schema{"type": "array", "maxItems": notes.PlanEdits, "items": object(
			[]string{"start", "end", "old", "text"}, map[string]schema{
				"start": intProp(0, notes.NoteBytes, "where the edit starts, in UTF-16 code units"),
				"end":   intProp(0, notes.NoteBytes, "where it ends, in UTF-16 code units"),
				"old":   textProp(notes.InputBytes, "the text it replaces"),
				"text":  textProp(notes.InputBytes, "the text it writes"),
			})},
	}),
}

func stringsProp(maxItems, maxBytes int, description string) schema {
	return schema{"type": "array", "minItems": 1, "maxItems": maxItems, "description": description,
		"items": schema{"type": "string", "minLength": 1, "maxLength": maxBytes}}
}

// previewSentence is what every preview-then-apply tool says of itself.
const previewSentence = " Without changes it returns a preview and writes nothing; to apply, call it again with the " +
	"same arguments and the preview's changes, head and epoch. The apply commits all of it or none, and only if " +
	"nothing in the vault changed since the preview (plan_changed otherwise)."

// resultSentence is what every mutation says about its result.
const resultSentence = " The result says committed with an opId and the entries written, each with the uid it " +
	"displaced as previousUid, readable with read_note. committed means durable on the server; delivery_status " +
	"says which devices have it. If the outcome is unknown, lookup_operation with the opId says what happened."

func writeTools() []*Tool {
	tagLocation := enumProp("where tags are changed: the frontmatter's tags property, inline #tags in the text, or both",
		"frontmatter", "content", "both")
	return []*Tool{
		{
			Name: "create_note", Title: "Create a note", Scope: store.ScopeWrite, Additive: true,
			Description: "Create a Markdown or plain-text note at a path that holds nothing, with any folders it " +
				"needs. It never replaces anything: a path that holds a file or a folder is refused with exists." +
				resultSentence,
			Input: object([]string{"path", "content"}, map[string]schema{
				"path":           textProp(paths.MaxPathBytes, "the new note's path in the vault, ending .md or .txt"),
				"content":        textProp(notes.NoteBytes, "the note's text, at most 1 MiB, written exactly as given"),
				"epoch":          optionalEpochProp,
				"idempotencyKey": keyProp,
			}),
			Run: createNote,
		},
		{
			Name: "create_directory", Title: "Create a folder", Scope: store.ScopeWrite, Additive: true,
			Description: "Create a folder, with any folders above it that are missing. An existing folder is a noop; " +
				"a file at the path is refused with exists." + resultSentence,
			Input: object([]string{"path"}, map[string]schema{
				"path":           textProp(paths.MaxPathBytes, "the folder's path in the vault"),
				"epoch":          optionalEpochProp,
				"idempotencyKey": keyProp,
			}),
			Run: createDirectory,
		},
		{
			Name: "edit_note", Title: "Edit a note", Scope: store.ScopeWrite,
			Description: "Make 1 to 32 exact edits to a note, each replacing text that occurs exactly once in the " +
				"version you read (base) with new text. Refused as stale if the note changed since: read it again and " +
				"reconsider, never substitute a newer base without reading it. Identical bytes are a noop." + resultSentence,
			Input: object([]string{"path", "base", "epoch", "edits"}, map[string]schema{
				"path": textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"base": baseProp,
				"edits": schema{"type": "array", "minItems": 1, "maxItems": notes.MaxEdits,
					"description": "the edits, each found in the version read, not in another edit's result; 64 KiB in all",
					"items": object([]string{"old", "new"}, map[string]schema{
						"old": textProp(notes.EditBytes, "text that occurs exactly once in the note"),
						"new": textProp(notes.EditBytes, "what replaces it"),
					})},
				"epoch":          epochProp,
				"idempotencyKey": keyProp,
			}),
			Run: editNote,
		},
		{
			Name: "append_note", Title: "Append to a note", Scope: store.ScopeWrite, Additive: true,
			Description: "Append text to the end of a note, exactly as given: no separator or newline is added. " +
				"Refused as stale if the note changed since the version you read (base)." + resultSentence,
			Input: object([]string{"path", "base", "epoch", "text"}, map[string]schema{
				"path":           textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"base":           baseProp,
				"text":           textProp(notes.InputBytes, "the text to add, at most 64 KiB"),
				"epoch":          epochProp,
				"idempotencyKey": keyProp,
			}),
			Run: func(c *call, a *args) outcome { return insertNote(c, a, notes.AppendNote) },
		},
		{
			Name: "prepend_note", Title: "Prepend to a note", Scope: store.ScopeWrite, Additive: true,
			Description: "Insert text at the start of a note, after a byte-order mark if it has one, exactly as given: " +
				"supply your own separator. Refused as stale if the note changed since the version you read (base)." +
				resultSentence,
			Input: object([]string{"path", "base", "epoch", "text"}, map[string]schema{
				"path":           textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"base":           baseProp,
				"text":           textProp(notes.InputBytes, "the text to add, at most 64 KiB"),
				"epoch":          epochProp,
				"idempotencyKey": keyProp,
			}),
			Run: func(c *call, a *args) outcome { return insertNote(c, a, notes.PrependNote) },
		},
		{
			Name: "delete_note", Title: "Delete a note", Scope: store.ScopeWrite,
			Description: "Delete a note, recoverably: the deletion is a version, the note's last content stays in its " +
				"history (deleted_notes lists it as restorable) and is pinned against purge. The preview lists the " +
				"backlinks that would break; with markBroken, they are struck through in the same operation." +
				previewSentence + resultSentence,
			Input: object([]string{"path", "base", "epoch"}, map[string]schema{
				"path":           textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"base":           baseProp,
				"markBroken":     boolProp("strike through every link to the note in other notes"),
				"changes":        changesProp,
				"head":           headProp,
				"epoch":          epochProp,
				"idempotencyKey": keyProp,
			}),
			Run: deleteNote,
		},
		{
			Name: "move_note", Title: "Move a note", Scope: store.ScopeWrite,
			Description: "Move or rename a note to a path that holds nothing, rewriting its own relative links for " +
				"the new place and, unless updateLinks is false, every other note's unambiguous links to it. Links whose " +
				"names mean several notes are counted in ambiguousLinks and left alone." + previewSentence + resultSentence,
			Input: object([]string{"path", "base", "to", "epoch"}, map[string]schema{
				"path":           textProp(paths.MaxPathBytes, "the note's path in the vault"),
				"base":           baseProp,
				"to":             textProp(paths.MaxPathBytes, "where it moves to, ending .md or .txt"),
				"updateLinks":    boolProp("rewrite other notes' links to it, true by default"),
				"changes":        changesProp,
				"head":           headProp,
				"epoch":          epochProp,
				"idempotencyKey": keyProp,
			}),
			Run: moveNote,
		},
		{
			Name: "restore_note", Title: "Restore a version", Scope: store.ScopeWrite, Additive: true,
			Description: "Write an earlier version of a note, from note_history or deleted_notes, as a new note at a " +
				"path that holds nothing. It never overwrites; restoring onto the original path is create_note after " +
				"reading the version." + resultSentence,
			Input: object([]string{"path", "uid", "to", "epoch"}, map[string]schema{
				"path":           textProp(paths.MaxPathBytes, "the path the version belongs to"),
				"uid":            intProp(1, maxSafe, "the version to restore"),
				"to":             textProp(paths.MaxPathBytes, "the new note's path, which must hold nothing"),
				"epoch":          epochProp,
				"idempotencyKey": keyProp,
			}),
			Run: restoreNote,
		},
		{
			Name: "add_tags", Title: "Add tags", Scope: store.ScopeWrite,
			Description: "Add tags to the named notes, rewriting only the frontmatter's tags value or adding #tags on " +
				"a line of their own, and nothing else in the note." + previewSentence + resultSentence,
			Input: object([]string{"paths", "tags"}, addTagProps(tagLocation, false)),
			Run:   func(c *call, a *args) outcome { return tagNotes(c, a, "add") },
		},
		{
			Name: "remove_tags", Title: "Remove tags", Scope: store.ScopeWrite,
			Description: "Remove tags from the named notes, by name, with their nested tags when includeChildren, or " +
				"by a pattern with one *." + previewSentence + resultSentence,
			Input: object([]string{"paths"}, removeTagProps(tagLocation, false)),
			Run:   func(c *call, a *args) outcome { return tagNotes(c, a, "remove") },
		},
		{
			Name: "manage_tags", Title: "Add or remove tags", Scope: store.ScopeWrite,
			Description: "add_tags or remove_tags, chosen by operation, with that tool's arguments." +
				previewSentence + resultSentence,
			Input: manageTagsSchema(tagLocation),
			Run:   func(c *call, a *args) outcome { return tagNotes(c, a, "") },
		},
		{
			Name: "rename_tag", Title: "Rename a tag", Scope: store.ScopeWrite,
			Description: "Rename a tag across the vault or beneath one folder, in frontmatter and inline, with its " +
				"nested tags when includeChildren. It reads at most 512 notes and 8 MiB of them, else scan_incomplete: " +
				"name a folder." + previewSentence + resultSentence,
			Input: object([]string{"oldTag", "newTag"}, map[string]schema{
				"oldTag":          textProp(notes.MaxTagBytes, "the tag to rename, with or without its #"),
				"newTag":          textProp(notes.MaxTagBytes, "its new name"),
				"folder":          textProp(paths.MaxPathBytes, "only notes beneath this folder"),
				"includeChildren": boolProp("also rename nested tags (tag/child)"),
				"location":        tagLocation,
				"changes":         changesProp,
				"head":            headProp,
				"epoch":           textProp(64, "with changes: the epoch the preview reported"),
				"idempotencyKey":  keyProp,
			}),
			Run: renameTag,
		},
		{
			Name: "lookup_operation", Title: "Look up an operation", Scope: store.ScopeRead,
			Description: "Say what one of this token's own writes did, by the opId its result, or an unknown outcome, " +
				"named: whether it committed, when, and every path it changed with the uid before and after. This is " +
				"how a reply that never arrived is resolved. found false means no write of this token committed under " +
				"that id.",
			Input: object([]string{"opId"}, map[string]schema{
				"opId": textProp(64, "the operation's id"),
			}),
			Run: lookupOperation,
		},
	}
}

func addTagProps(location schema, manage bool) map[string]schema {
	props := map[string]schema{
		"paths":         stringsProp(notes.BatchFiles, paths.MaxPathBytes, "the notes to change, 1 to 32"),
		"tags":          stringsProp(notes.MaxTagsPerCall, notes.MaxTagBytes, "the tags to add, with or without #"),
		"location":      location,
		"position":      enumProp("where inline tags go, at the end by default", "start", "end"),
		"normalization": enumProp("how added tags are written", "preserve", "lowercase", "kebab"),
		"changes":       changesProp,
		"head":          headProp,
		"epoch": textProp(64, "with changes: the epoch the preview reported; optional for a preview, "+
			"which names no uid"),
		"idempotencyKey": keyProp,
	}
	if manage {
		props["operation"] = enumProp("which tool this is", "add")
	}
	return props
}

func removeTagProps(location schema, manage bool) map[string]schema {
	props := addTagProps(location, false)
	delete(props, "position")
	delete(props, "normalization")
	props["tags"] = stringsProp(notes.MaxTagsPerCall, notes.MaxTagBytes, "the tags to remove, with or without #")
	props["patterns"] = stringsProp(notes.MaxTagsPerCall, notes.MaxTagBytes, "tags to remove by a pattern with one *")
	props["includeChildren"] = boolProp("also remove nested tags (tag/child)")
	if manage {
		props["operation"] = enumProp("which tool this is", "remove")
	}
	return props
}

func manageTagsSchema(location schema) schema {
	return schema{"oneOf": []schema{
		object([]string{"operation", "paths", "tags"}, addTagProps(location, true)),
		object([]string{"operation", "paths"}, removeTagProps(location, true)),
	}, "type": "object"}
}

// The kinds of path a write names, which writable holds to different rules.
const (
	// existingNote is a note the call changes or deletes: the path rules, and
	// an editable format.
	existingNote = iota
	// newNote is a note the call creates: those, and not a reserved name.
	newNote
	// newFolder is a folder the call creates: the path rules, and not a
	// reserved name.
	newFolder
)

// CommitFacts is what every committed mutation's result says under trusted;
// see committedFacts. Exported only so that results embedding it keep its
// fields at their top level.
type CommitFacts = committedTrusted

// pathResult is a committed mutation of the caller's own path.
type pathResult struct {
	CommitFacts
	Path string `json:"path"`
	To   string `json:"to,omitempty"`
	// RestoredFrom is a restore's source, the caller's own arguments.
	RestoredFrom *restoredFrom `json:"restoredFrom,omitempty"`
}

type restoredFrom struct {
	Path string `json:"path"`
	UID  int64  `json:"uid"`
}

func pathRender(path, to string, from *restoredFrom) func(store.OpResult) (any, any) {
	return func(r store.OpResult) (any, any) {
		return pathResult{CommitFacts: committedFacts(r), Path: path, To: to, RestoredFrom: from}, entries{entryRows(r)}
	}
}

func createNote(c *call, a *args) outcome {
	path := a.writable("path", true, newNote)
	content, hasContent := a.text("content", notes.NoteBytes)
	epoch := a.epoch(false)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if !hasContent {
		return c.failWrite(invalidArguments("content is required"))
	}
	body, err := notes.NoteContent(content)
	if err != nil {
		return c.failWrite(err)
	}
	m, o, done := c.begin(a, key, epoch, path)
	if done {
		return o
	}
	return m.create(path, body, nil)
}

// create writes body as a new note at path, which must hold nothing live, in
// one operation with the folders it lacks. Its base is zero, which the store
// reads as "nothing live here" at the commit: an exclusive create.
func (m *mutation) create(path string, body []byte, from *restoredFrom) outcome {
	c := m.c
	head, gone, err := c.h.st.Head(c.h.vault, path)
	if err != nil {
		return m.failed(err)
	}
	if head != 0 && !gone {
		return m.fail(&ToolError{Code: "exists", Message: "something is at that path already, and this never replaces it",
			Path: path, CurrentUID: &head})
	}
	folders, checks, err := c.folders(path)
	if err != nil {
		return m.failed(err)
	}
	e := c.newEntry(path)
	if err := c.storeBodies(c.content(&e, body)); err != nil {
		return m.failed(err)
	}
	op := store.Operation{Entries: append(folders, store.OpEntry{Entry: e}), Checks: checks}
	return m.submit(op, pathRender(path, "", from))
}

func createDirectory(c *call, a *args) outcome {
	path := a.writable("path", true, newFolder)
	epoch := a.epoch(false)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	m, o, done := c.begin(a, key, epoch, path)
	if done {
		return o
	}
	e, state, _, err := c.h.st.EntryAsOf(c.h.vault, path, 0)
	if err != nil {
		return m.failed(err)
	}
	switch {
	case state == store.PathLive && e.Folder:
		// A noop, revalidated at the commit boundary like any other.
		return m.submit(store.Operation{Checks: []store.OpCheck{{Path: path, Base: e.UID}}}, pathRender(path, "", nil))
	case state == store.PathLive:
		uid := e.UID
		return m.fail(&ToolError{Code: "exists", Message: "a file is at that path", Path: path, CurrentUID: &uid})
	}
	folders, checks, err := c.folders(path)
	if err != nil {
		return m.failed(err)
	}
	f := c.newEntry(path)
	f.Folder = true
	return m.submit(store.Operation{Entries: append(folders, store.OpEntry{Entry: f}), Checks: checks},
		pathRender(path, "", nil))
}

func editNote(c *call, a *args) outcome {
	path := a.writable("path", true, existingNote)
	base := a.uid("base", true)
	epoch := a.epoch(true)
	key := a.idempotencyKey()
	items, present := a.objects("edits", 1, notes.MaxEdits)
	edits := make([]notes.Edit, len(items))
	for i, item := range items {
		old, hasOld := item.text("old", notes.EditBytes)
		replacement, hasNew := item.text("new", notes.EditBytes)
		switch {
		case !hasOld:
			item.refuse(invalidArguments("old is required"))
		case !hasNew:
			item.refuse(invalidArguments("new is required"))
		}
		a.adopt(item, "edits["+strconv.Itoa(i)+"]")
		edits[i] = notes.Edit{Old: old, New: replacement}
	}
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if !present {
		return c.failWrite(invalidArguments("edits is required"))
	}
	m, o, done := c.begin(a, key, epoch, path)
	if done {
		return o
	}
	return m.rewrite(path, base, func(b []byte) (notes.Revision, error) { return notes.EditNote(b, edits) })
}

func insertNote(c *call, a *args, insert func([]byte, string) (notes.Revision, error)) outcome {
	path := a.writable("path", true, existingNote)
	base := a.uid("base", true)
	t, present := a.text("text", notes.InputBytes)
	epoch := a.epoch(true)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if !present {
		return c.failWrite(invalidArguments("text is required"))
	}
	m, o, done := c.begin(a, key, epoch, path)
	if done {
		return o
	}
	return m.rewrite(path, base, func(b []byte) (notes.Revision, error) { return insert(b, t) })
}

// rewrite writes the note at path, read at base, as change makes it, with its
// ctime carried and its mtime the server's now. Identical bytes are a noop,
// which still revalidates the base at the commit boundary (PLAN.md section
// 4.3).
func (m *mutation) rewrite(path string, base int64, change func([]byte) (notes.Revision, error)) outcome {
	c := m.c
	e, err := c.liveNote(path, base)
	if err != nil {
		return m.failed(err)
	}
	before, err := c.versionBytes(e)
	if err != nil {
		return m.failed(err)
	}
	rev, err := change(before)
	if err != nil {
		return m.failed(err)
	}
	if rev.Noop {
		return m.submit(store.Operation{Checks: []store.OpCheck{{Path: path, Base: base}}}, pathRender(path, "", nil))
	}
	w := c.newEntry(path)
	w.CTime = e.CTime
	if err := c.storeBodies(c.content(&w, rev.Bytes)); err != nil {
		return m.failed(err)
	}
	return m.submit(store.Operation{Entries: []store.OpEntry{{Entry: w, Base: base}}}, pathRender(path, "", nil))
}

func restoreNote(c *call, a *args) outcome {
	path := a.path("path", true)
	uid := a.uid("uid", true)
	to := a.writable("to", true, newNote)
	epoch := a.epoch(true)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if paths.Fold(to) == paths.Fold(path) {
		return c.failWrite(&ToolError{Code: "same_destination", Message: "restore to a different path, so the original's " +
			"history stays where it is; to restore onto it, read the version and create_note"})
	}
	m, o, done := c.begin(a, key, epoch, path, to)
	if done {
		return o
	}
	e, err := c.version(path, uid)
	if err != nil {
		return m.failed(err)
	}
	b, err := c.versionBytes(e)
	if err != nil {
		return m.failed(err)
	}
	if _, err := notes.DecodeNote(b); err != nil {
		return m.failed(err)
	}
	return m.create(to, b, &restoredFrom{Path: path, UID: uid})
}

// planned is a tag, move or delete operation's plan, made at one head through
// the view it read.
type planned struct {
	plan notes.Plan
	view *storeView
	scan scanInfo
}

// planFunc makes an operation's plan at head, or at the vault's head for a
// preview (head 0).
type planFunc func(head int64) (planned, error)

// applyArgs are the arguments that turn a preview into an apply.
type applyArgs struct {
	changes  []notes.PlannedChange
	applying bool
	head     int64
}

// keyFor is the idempotency key a call is begun with: the caller's for an
// apply, and none for a preview, which commits and records nothing, so a key
// an agent sends with both is the apply's alone and a preview is never
// answered with an apply's result or refused for its key.
func (p applyArgs) keyFor(key string) string {
	if !p.applying {
		return ""
	}
	return key
}

func (a *args) apply() applyArgs {
	var p applyArgs
	p.changes, p.applying = a.changes()
	p.head = a.integer("head", 0, maxSafe, 0, "invalid_arguments")
	if a.fail == nil && p.applying != (p.head != 0) {
		a.refuse(invalidArguments("changes and head go together: pass both to apply a preview, neither for a preview"))
	}
	return p
}

// operate is a tag, move or delete tool once its request is read: without
// changes, the preview of its plan at the vault's head; with them, the plan
// made again at the head the preview named, compared with the changes passed
// back, and committed bound to that head (PLAN.md section 4.3,
// "Preview-then-apply needs more than matching bases"). What commits is the
// plan made now from the store's bytes; the changes passed back are the
// agent's approval of it.
func (m *mutation) operate(p applyArgs, plan planFunc, render func(store.OpResult) (any, any),
	preview func(planned) (any, any, error)) outcome {
	c := m.c
	if !p.applying {
		made, err := plan(0)
		if err != nil {
			return m.failed(err)
		}
		trusted, untrusted, err := preview(made)
		if err != nil {
			return m.failed(err)
		}
		return c.ok(trusted, untrusted)
	}
	if err := notes.PlanTooLarge(p.changes); err != nil {
		return m.failed(err)
	}
	// A vault that moved since the preview refuses the apply before the plan
	// is made again: the commit would refuse it anyway, bound to that head.
	latest, err := c.h.st.LatestUID(c.h.vault)
	if err != nil {
		return m.failed(err)
	}
	if latest != p.head {
		return m.fail(&ToolError{Code: "plan_changed", Message: "the vault changed since the preview (its head was " +
			strconv.FormatInt(p.head, 10) + "); preview again and pass the new changes back. Nothing was written",
			CurrentUID: &latest})
	}
	made, err := plan(p.head)
	if err != nil {
		return m.failed(err)
	}
	if !samePlan(p.changes, made.plan.Changes) {
		return m.fail(&ToolError{Code: "plan_changed", Message: "the changes passed back are not the plan made now; " +
			"preview again and pass its changes back exactly as shown. Nothing was written"})
	}
	writes, err := made.plan.Writes()
	if err != nil {
		return m.failed(err)
	}
	op, err := m.planOperation(made.view, writes)
	if err != nil {
		return m.failed(err)
	}
	head := p.head
	op.SnapshotHead = &head
	return m.submit(op, render)
}

// planOperation is the operation a plan's writes commit: each edit at its
// planned base, a named note the plan leaves unchanged as a check of its base,
// a move as one rename entry at its destination with the source's base as its
// prevBase and the folders the destination lacks, and a deletion as a
// tombstone at its base.
func (m *mutation) planOperation(v *storeView, writes []notes.PlannedWrite) (store.Operation, error) {
	c := m.c
	var op store.Operation
	var bodies [][]byte
	for _, w := range writes {
		ch := w.Change
		switch ch.Action {
		case "edit":
			if len(ch.Edits) == 0 {
				op.Checks = append(op.Checks, store.OpCheck{Path: ch.Path, Base: ch.Base})
				continue
			}
			e := c.newEntry(ch.Path)
			e.CTime = v.live[ch.Path].CTime
			bodies = append(bodies, c.content(&e, w.Content)...)
			op.Entries = append(op.Entries, store.OpEntry{Entry: e, Base: ch.Base})
		case "move":
			folders, checks, err := c.folders(ch.To)
			if err != nil {
				return op, err
			}
			op.Entries = append(op.Entries, folders...)
			op.Checks = append(op.Checks, checks...)
			e := c.newEntry(ch.To)
			e.Prev, e.CTime = ch.Path, v.live[ch.Path].CTime
			bodies = append(bodies, c.content(&e, w.Content)...)
			op.Entries = append(op.Entries, store.OpEntry{Entry: e, PrevBase: ch.Base})
		case "delete":
			e := c.newEntry(ch.Path)
			e.Deleted = true
			op.Entries = append(op.Entries, store.OpEntry{Entry: e, Base: ch.Base})
		}
	}
	return op, c.storeBodies(bodies)
}

// previewResult is a preview's envelope: its facts under trusted, its planned
// changes, and anything more it lists, under untrusted_content.
func (m *mutation) previewFacts(made planned) previewTrusted {
	return previewTrusted{Phase: "preview", Head: made.view.head, Epoch: m.epoch, Complete: true,
		AmbiguousLinks: made.plan.AmbiguousLinks, Count: len(made.plan.Changes), Scan: made.scan,
		Instructions: previewInstructions}
}

type planChanges struct {
	Changes []changeRow `json:"changes"`
}

func (m *mutation) plainPreview(made planned) (any, any, error) {
	return m.previewFacts(made), planChanges{changeRows(made.plan.Changes)}, nil
}

// sourceAt is the check a move or a deletion makes of its source at the head
// it plans at: the version the agent read (base), else stale.
func (c *call) sourceAt(v *storeView, path string, base int64) error {
	e, ok := v.live[path]
	if !ok || e.UID != base {
		head, _, err := c.h.st.Head(c.h.vault, path)
		if err != nil {
			return err
		}
		return &ToolError{Code: "stale", Message: "the note changed since that base; read it again and reconsider",
			Path: path, CurrentUID: &head}
	}
	return nil
}

func moveNote(c *call, a *args) outcome {
	path := a.writable("path", true, existingNote)
	base := a.uid("base", true)
	to := a.writable("to", true, newNote)
	updateLinks := a.boolean("updateLinks", true)
	p := a.apply()
	epoch := a.epoch(true)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	m, o, done := c.begin(a, p.keyFor(key), epoch, path, to)
	if done {
		return o
	}
	plan := func(head int64) (planned, error) {
		var view notes.View
		var v *storeView
		var scan scanInfo
		var err error
		if updateLinks {
			view, v, scan, err = c.linkHead(path, head)
		} else {
			v, err = c.headView(head)
			view, scan = v, scanInfo{Method: "none"}
		}
		if err != nil {
			return planned{}, err
		}
		if err := c.sourceAt(v, path, base); err != nil {
			return planned{}, err
		}
		made, err := notes.PlanMove(view, path, to, updateLinks)
		return planned{plan: made, view: v, scan: scan}, err
	}
	return m.operate(p, plan, pathRender(path, to, nil), m.plainPreview)
}

func deleteNote(c *call, a *args) outcome {
	path := a.writable("path", true, existingNote)
	base := a.uid("base", true)
	markBroken := a.boolean("markBroken", false)
	p := a.apply()
	epoch := a.epoch(true)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	m, o, done := c.begin(a, p.keyFor(key), epoch, path)
	if done {
		return o
	}
	plan := func(head int64) (planned, error) {
		var view notes.View
		var v *storeView
		var scan scanInfo
		var err error
		if markBroken {
			view, v, scan, err = c.linkHead(path, head)
		} else {
			v, err = c.headView(head)
			view, scan = v, scanInfo{Method: "none"}
		}
		if err != nil {
			return planned{}, err
		}
		if err := c.sourceAt(v, path, base); err != nil {
			return planned{}, err
		}
		made, err := notes.PlanDelete(view, path, markBroken)
		return planned{plan: made, view: v, scan: scan}, err
	}
	preview := m.plainPreview
	if !markBroken {
		preview = func(made planned) (any, any, error) { return m.brokenLinks(made, path) }
	}
	return m.operate(p, plan, pathRender(path, "", nil), preview)
}

// brokenLinks is the preview of a deletion without markBroken, which lists the
// notes whose links to it would break (plan/mcp-tools.md, delete_note): those
// the struck-through plan would edit, found through the link index when it is
// current and by reading every note otherwise. A vault too large to read says
// the list is incomplete and why, rather than refusing a deletion that does
// not need the list to be right.
func (m *mutation) brokenLinks(made planned, path string) (any, any, error) {
	type facts struct {
		previewTrusted
		BrokenLinksComplete bool   `json:"brokenLinksComplete"`
		BrokenLinksWhy      string `json:"brokenLinksWhy,omitempty"`
	}
	type listed struct {
		Changes     []changeRow `json:"changes"`
		BrokenLinks []Text      `json:"brokenLinks"`
	}
	out := facts{previewTrusted: m.previewFacts(made), BrokenLinksComplete: true}
	broken := []Text{}
	view, _, scan, err := m.c.linkHead(path, made.view.head)
	if err != nil {
		return nil, nil, err
	}
	out.Scan = scan
	marked, err := notes.PlanDelete(view, path, true)
	if err != nil {
		code := toolError(err).Code
		if code == "internal" {
			return nil, nil, err
		}
		out.BrokenLinksComplete, out.BrokenLinksWhy = false, code
	}
	for _, ch := range marked.Changes {
		if ch.Action == "edit" {
			broken = append(broken, text(ch.Path))
		}
	}
	return out, listed{changeRows(made.plan.Changes), broken}, nil
}

// headView is the vault at head, or at its latest uid for 0.
func (c *call) headView(head int64) (*storeView, error) {
	if head == 0 {
		var err error
		if head, err = c.h.st.LatestUID(c.h.vault); err != nil {
			return nil, err
		}
	}
	return c.viewAt(head)
}

// pathList is an array of vault paths the path rules accept, between min and
// max of them.
func (a *args) pathList(key string, min, max int) ([]string, bool) {
	list, present := a.texts(key, min, max, 1, paths.MaxPathBytes)
	for i, p := range list {
		if r := paths.Check(p); r != "" {
			a.refuse(&ToolError{Code: "badpath", Message: key + "[" + strconv.Itoa(i) + "]: " + string(r) +
				": the server refuses this path"})
			return nil, false
		}
	}
	return list, present
}

// tagNotes is add_tags, remove_tags and manage_tags: operation is "add" or
// "remove", or "" to read it from the arguments.
func tagNotes(c *call, a *args, operation string) outcome {
	if operation == "" {
		operation = a.oneOf("operation", "", "invalid_arguments", "add", "remove")
		if operation == "" && a.fail == nil {
			a.refuse(invalidArguments("operation is required: add or remove"))
		}
	}
	list, _ := a.pathList("paths", 1, notes.BatchFiles)
	change := notes.TagChange{Operation: operation}
	var hasTags bool
	change.Tags, hasTags = a.texts("tags", 1, notes.MaxTagsPerCall, 1, notes.MaxTagBytes)
	change.Location = a.oneOf("location", "", "invalid_arguments", "frontmatter", "content", "both")
	switch operation {
	case "add":
		change.Position = a.oneOf("position", "", "invalid_arguments", "start", "end")
		change.Normalization = a.oneOf("normalization", "", "invalid_arguments", "preserve", "lowercase", "kebab")
		if !hasTags && a.fail == nil {
			a.refuse(invalidArguments("tags is required"))
		}
	case "remove":
		change.Patterns, _ = a.texts("patterns", 1, notes.MaxTagsPerCall, 1, notes.MaxTagBytes)
		change.IncludeChildren = a.boolean("includeChildren", false)
	}
	p := a.apply()
	epoch := a.epoch(p.applying)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if list == nil {
		return c.failWrite(invalidArguments("paths is required"))
	}
	m, o, done := c.begin(a, p.keyFor(key), epoch, list...)
	if done {
		return o
	}
	plan := func(head int64) (planned, error) {
		v, err := c.headView(head)
		if err != nil {
			return planned{}, err
		}
		made, err := notes.PlanTags(v, change, notes.TagScope{Paths: list})
		return planned{plan: made, view: v, scan: scanInfo{Method: "none"}}, err
	}
	return m.operate(p, plan, plainResult, m.plainPreview)
}

func renameTag(c *call, a *args) outcome {
	change := notes.TagChange{Operation: "rename"}
	var hasOld, hasNew bool
	change.OldTag, hasOld = a.text("oldTag", notes.MaxTagBytes)
	change.NewTag, hasNew = a.text("newTag", notes.MaxTagBytes)
	folder := a.folder("folder")
	change.IncludeChildren = a.boolean("includeChildren", false)
	change.Location = a.oneOf("location", "", "invalid_arguments", "frontmatter", "content", "both")
	p := a.apply()
	epoch := a.epoch(p.applying)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if !hasOld || !hasNew {
		return c.failWrite(invalidArguments("oldTag and newTag are required"))
	}
	m, o, done := c.begin(a, p.keyFor(key), epoch, folder)
	if done {
		return o
	}
	plan := func(head int64) (planned, error) {
		v, err := c.headView(head)
		if err != nil {
			return planned{}, err
		}
		made, err := notes.PlanTags(v, change, notes.TagScope{Folder: folder})
		return planned{plan: made, view: v, scan: scanInfo{Method: "vault"}}, err
	}
	return m.operate(p, plan, plainResult, m.plainPreview)
}

// lookupOperation resolves a reply that never arrived (PLAN.md section 4.8):
// one of this token's operations, by id, as the oplog recorded it. Only the
// token's own: another agent's operations are the operator's to read, with
// `trewd audit`, and an id that is not this token's is answered exactly as one
// that was never committed.
func lookupOperation(c *call, a *args) outcome {
	id, present := a.text("opId", 64)
	if err := a.finish(); err != nil {
		return c.fail(err)
	}
	if !present {
		return c.fail(invalidArguments("opId is required"))
	}
	obs, err := c.observe()
	if err != nil {
		return c.failErr(err)
	}
	type facts struct {
		Found bool   `json:"found"`
		OpID  string `json:"opId"`
		// The operation as recorded, when found.
		Tool            string `json:"tool,omitempty"`
		Outcome         string `json:"outcome,omitempty"`
		CommittedAt     int64  `json:"committedAt,omitempty"`
		OperationEpoch  string `json:"operationEpoch,omitempty"`
		IdempotencyKey  string `json:"idempotencyKey,omitempty"`
		SnapshotHead    *int64 `json:"snapshotHead,omitempty"`
		ReplayableUntil int64  `json:"replayableUntil,omitempty"`
		PathsTotal      int    `json:"pathsTotal"`
		Message         string `json:"message"`
		Observed
	}
	type pathRow struct {
		Role      Text   `json:"role"`
		Path      Text   `json:"path"`
		BeforeUID *int64 `json:"beforeUid"`
		AfterUID  int64  `json:"afterUid"`
	}
	type listed struct {
		Paths []pathRow `json:"paths"`
	}
	out := facts{OpID: id, Observed: obs}
	rows := []pathRow{}
	var rec store.OperationRecord
	ok := false
	if store.ValidOperationID(id) {
		rec, ok, err = c.h.st.LookupOperation(c.h.vault, id)
		if err != nil {
			return c.failErr(err)
		}
	}
	if !ok || rec.ActorID != c.cred.token.ID {
		out.Message = "no write of this token committed under this id. After an unknown outcome this means it did " +
			"not commit; if the server restarted in between, look again once it is back"
		return c.ok(out, listed{rows})
	}
	out.Found, out.Tool, out.Outcome, out.CommittedAt = true, rec.Tool, rec.Outcome, rec.CommittedAt
	out.OperationEpoch, out.IdempotencyKey, out.SnapshotHead = rec.Epoch, rec.IdempotencyKey, rec.SnapshotHead
	out.PathsTotal = rec.PathsTotal
	out.Message = "the operation committed; its uids belong to operationEpoch"
	if rec.Epoch != obs.Epoch {
		out.Message = "the operation committed before the store was restored, so its uids belong to that history, " +
			"and may now name other versions"
	}
	if rec.ResultExpiresAt > c.now.UnixMilli() && rec.IdempotencyKey != "" && rec.Epoch == obs.Epoch {
		out.ReplayableUntil = rec.ResultExpiresAt
		out.Message += "; repeating the request with its idempotencyKey until replayableUntil answers with its result"
	}
	used := 0
	for _, p := range rec.Paths {
		row := pathRow{Role: text(p.Role), Path: text(p.Path), BeforeUID: p.BeforeUID, AfterUID: p.AfterUID}
		size := jsonSize(row)
		if used+size > PageRowsBytes {
			break
		}
		rows = append(rows, row)
		used += size
	}
	return c.ok(out, listed{rows})
}
