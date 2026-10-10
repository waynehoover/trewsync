package mcp

import (
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/store"
)

// Settings are a device's, never the vault's notes, and no tool sees them
// (plan/settings-sync.md, section 7): not as a note, an attachment, an orphan,
// a count or a deletion, and no tool reads, writes or moves into one. A
// settings file is a device's Obsidian configuration and, from phase 2, other
// plugins' keys, which must not reach a model provider.
func TestNoToolSeesSettings(t *testing.T) {
	r := newRig(t)
	note := r.write("note.md", "a note that mentions nothing")
	r.write(".obsidian/app.json", `{"spellcheck":true}`)
	r.write(".obsidian-mobile/appearance.json", `{"theme":"obsidian"}`)
	r.write(".obsidian/snippets/wide.css", "body { max-width: none }")
	r.write(".obsidian/hotkeys.json", "{}")
	r.remove(".obsidian/hotkeys.json")
	r.indexed()
	read, _ := r.token(store.ScopeRead)
	write, _ := r.token(store.ScopeWrite)
	cs := r.mustConnect(read, "")
	ws := r.mustConnect(write, "")

	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"list_notes", map[string]any{"includeDeleted": true}},
		{"orphans", map[string]any{"includeAttachments": true}},
		{"deleted_notes", nil},
		{"search_notes", map[string]any{"query": "max-width"}},
		{"search_notes", map[string]any{"query": "spellcheck"}},
	} {
		if e := invoke(t, cs, c.tool, c.args); e.isError || strings.Contains(string(e.raw), ".obsidian") {
			t.Fatalf("%s %v answered %s", c.tool, c.args, e.raw)
		}
	}

	var status struct {
		Notes       int64 `json:"notes"`
		Attachments int64 `json:"attachments"`
		Deleted     int64 `json:"deleted"`
		Bytes       int64 `json:"bytes"`
	}
	invoke(t, cs, "vault_status", nil).trusted(t, &status)
	if status.Notes != 1 || status.Attachments != 0 || status.Deleted != 0 ||
		status.Bytes != int64(len("a note that mentions nothing")) {
		t.Fatalf("vault_status counts settings: %+v", status)
	}

	// Asked for by name, a settings file is not a path the tools take: the
	// path rule refuses it, as it refuses every dot path.
	for _, c := range []struct {
		write bool
		tool  string
		args  map[string]any
	}{
		{false, "read_note", map[string]any{"path": ".obsidian/app.json"}},
		{false, "note_history", map[string]any{"path": ".obsidian/app.json"}},
		{true, "create_note", map[string]any{"path": ".obsidian/new.json", "content": "{}"}},
		{true, "move_note", map[string]any{"path": "note.md", "base": note, "to": ".obsidian/note.json"}},
	} {
		session := cs
		if c.write {
			session = ws
		}
		if e := invoke(t, session, c.tool, c.args); e.errorCode() != "badpath" {
			t.Fatalf("%s %v was answered %s", c.tool, c.args, e.raw)
		}
	}
	for _, p := range []string{".obsidian/new.json", ".obsidian/note.json"} {
		if uid, _, err := r.st.Head(testVault, p); err != nil || uid != 0 {
			t.Fatalf("a tool wrote %s (uid %d, %v)", p, uid, err)
		}
	}
}
