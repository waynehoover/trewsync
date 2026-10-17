package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/wire"
)

// Community plugins' settings are protocol 4's (plan/settings-sync.md,
// section 6). A session of 4 may write, and is sent, each plugin's data.json
// that paths.CheckPlugins accepts, and never a plugin's code. A session of 3
// or less is held to the rule it always was and never sees a plugin entry,
// while its cursor still moves past each one.

// pluginVector is one case of the `config` section of protocol-fixtures.json
// with protocol 3's reason and protocol 4's.
type pluginVector struct {
	configVector
	IsPlugin bool    `json:"isPlugin"`
	Plugins  *string `json:"plugins"`
}

func pluginVectors(t *testing.T) []pluginVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Config struct {
			Cases []pluginVector `json:"cases"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	plugins := 0
	for _, v := range f.Config.Cases {
		if v.IsPlugin {
			plugins++
		}
	}
	if plugins < 15 {
		t.Fatalf("only %d plugin vectors, which is not a matrix", plugins)
	}
	return f.Config.Cases
}

// Every settings vector through a session of protocol 4, and through one of
// protocol 3. Protocol 4 commits what CheckPlugins accepts and refuses the
// rest with its reason; protocol 3 gets exactly the answers it always got.
func TestThePluginMatrixThroughASession(t *testing.T) {
	r := newRig(t)
	now := r.dial("now")
	helloAt(now, wire.ProtoPlugins)
	old := r.dial("old")
	helloAt(old, wire.ProtoPlugins-1)
	body := "{}"
	names, size := chunkNames([]string{body})

	expect := func(c *client, v pluginVector, reason *string) {
		t.Helper()
		p := v.path(t)
		c.sendJSON(wire.In{Op: "put", Path: p, Chunks: names, Base: c.head(p),
			Meta: wire.PutMeta{Size: size, MTime: 1}})
		if reason == nil {
			switch m := c.recv(); {
			case m["res"] == "want":
				c.sendBinary([]byte(body))
				c.recvInto("ack", nil)
			case m["res"] != "have":
				t.Fatalf("%s: protocol %d answered a legal path with %v", v.Name, c.proto, m)
			}
			// Deleted again, so a later vector that folds onto this one is
			// judged by the settings rule rather than the collision rule.
			c.sendJSON(wire.In{Op: "put", Path: p, Base: c.head(p), Meta: wire.PutMeta{Deleted: true, MTime: 2}})
			if m := c.recv(); m["res"] != "have" {
				t.Fatalf("%s: deleting it again was answered %v", v.Name, m)
			}
			return
		}
		msg := c.expectErr(wire.CodeBadPath)
		if want := *reason + ": the path "; !strings.HasPrefix(msg, want) {
			t.Fatalf("%s: protocol %d refused it as %q, want it to lead with %q", v.Name, c.proto, msg, want)
		}
	}
	for _, v := range pluginVectors(t) {
		expect(old, v, v.Config)
		expect(now, v, v.Plugins)
	}
}

// A rename never crosses between a plugin's files and the other settings: a
// session of 3 would see a setting appear from, or vanish into, a path it is
// never sent.
func TestAPluginMoveToOrFromTheOtherSettingsIsRefused(t *testing.T) {
	r := newRig(t)
	c := r.dial("desk")
	helloAt(c, wire.ProtoPlugins)
	c.put(".obsidian/plugins/dataview/data.json", "{}")
	c.put(".obsidian/app.json", "{}")
	names, size := chunkNames([]string{"{}"})
	for _, m := range []struct{ from, to string }{
		{".obsidian/plugins/dataview/data.json", ".obsidian/dataview.json"},
		{".obsidian/app.json", ".obsidian/plugins/other/data.json"},
	} {
		c.sendJSON(wire.In{Op: "put", Path: m.to, Chunks: names,
			Meta: wire.PutMeta{Size: size, MTime: 2, Prev: m.from}, PrevBase: c.head(m.from)})
		if msg := c.expectErr(wire.CodeBadPath); !strings.HasPrefix(msg, "configmove: the prev ") {
			t.Fatalf("a move from %s to %s was refused as %q", m.from, m.to, msg)
		}
	}
	// Between plugins, a rename is an ordinary one.
	c.sendJSON(wire.In{Op: "put", Path: ".obsidian/plugins/dataview-old/data.json", Chunks: names,
		Meta:     wire.PutMeta{Size: size, MTime: 3, Prev: ".obsidian/plugins/dataview/data.json"},
		PrevBase: c.head(".obsidian/plugins/dataview/data.json")})
	if m := c.recv(); m["res"] != "have" {
		t.Fatalf("a rename between plugins' settings was answered %v", m)
	}
}

// A session of protocol 3 or less is sent no plugin entry, in its catch-up or
// live, and its cursor reaches the same uid a session of 4 does: each one is
// covered by its batch's range, as a device's own echo is. A session of 3
// still gets the other settings.
func TestAnOlderSessionNeverSeesAPluginEntry(t *testing.T) {
	for _, tc := range []struct {
		proto int
		want  []string
	}{
		{wire.ProtoPlugins - 1, []string{".obsidian/app.json", "note.md"}},
		{wire.ProtoConfig - 1, []string{"note.md"}},
		{wire.ProtoPlugins, []string{".obsidian/app.json", ".obsidian/plugins/dataview/data.json", "note.md",
			".obsidian/plugins/quickadd/data.json"}},
	} {
		r := newRig(t)
		desk := r.dial("desk")
		helloAt(desk, wire.ProtoPlugins)
		desk.put(".obsidian/app.json", `{"a":1}`)
		desk.put(".obsidian/plugins/dataview/data.json", `{"refresh":2500}`)
		desk.put("note.md", "a note")
		last := desk.put(".obsidian/plugins/quickadd/data.json", `{"choices":[]}`)

		c := r.dial("other")
		c.proto = tc.proto
		ready, got := c.hello(0)
		if ready.Proto != tc.proto {
			t.Fatalf("asked for protocol %d and was answered in %d", tc.proto, ready.Proto)
		}
		var paths []string
		for _, e := range got {
			paths = append(paths, e.Path)
		}
		if strings.Join(paths, ",") != strings.Join(tc.want, ",") {
			t.Fatalf("protocol %d caught up with %v, want %v", tc.proto, paths, tc.want)
		}
		next := desk.put(".obsidian/plugins/templater/data.json", "{}")
		b := c.nextBatch()
		if b.From != last+1 || b.To != next {
			t.Fatalf("protocol %d: the live batch covers %d to %d, want %d to %d",
				tc.proto, b.From, b.To, last+1, next)
		}
		if sent := len(b.Entries) == 1; sent != (tc.proto >= wire.ProtoPlugins) {
			t.Fatalf("protocol %d: a live plugin entry sent is %v", tc.proto, sent)
		}
		note := desk.put("later.md", "a later note")
		if b := c.nextBatch(); b.To != note || len(b.Entries) != 1 {
			t.Fatalf("protocol %d: the note after it came as %+v", tc.proto, b)
		}
	}
}

// A session of protocol 3 is not sent a plugin path by any other route
// either: its history of one is refused as protocol 3's rule refuses the
// path, and a plugin version's uid is no entry at all to it. A session of 4
// gets both.
func TestAnOlderSessionCannotReadAPluginVersion(t *testing.T) {
	r := newRig(t)
	desk := r.dial("desk")
	helloAt(desk, wire.ProtoPlugins)
	const p = ".obsidian/plugins/dataview/data.json"
	uid := desk.put(p, `{"apiKey":"secret"}`)

	old := r.dial("old")
	helloAt(old, wire.ProtoPlugins-1)
	old.sendJSON(wire.In{Op: "history", Path: p})
	if msg := old.expectErr(wire.CodeBadPath); !strings.HasPrefix(msg, "configscope: ") {
		t.Fatalf("protocol 3's history of a plugin's settings was refused as %q", msg)
	}
	old.sendJSON(wire.In{Op: "get", UID: uid})
	old.expectErr(wire.CodeNoUID)

	desk.sendJSON(wire.In{Op: "history", Path: p})
	var h wire.HistoryV2
	desk.recvInto("history", &h)
	if len(h.Entries) != 1 {
		t.Fatalf("protocol 4's history of a plugin's settings has %d versions", len(h.Entries))
	}
	desk.sendJSON(wire.In{Op: "get", UID: uid})
	desk.recvInto("chunks", nil)
}

// An operator's restore can put a plugin's files back. A device of protocol 3
// cannot undo it, because that would write files it never syncs; the refusal
// names why, and nothing is written.
func TestAnOlderSessionCannotUndoAnOperationThatChangedPlugins(t *testing.T) {
	r := newRig(t)
	desk := r.dial("desk")
	helloAt(desk, wire.ProtoPlugins)
	desk.put("note.md", "one")
	at := desk.put(".obsidian/plugins/dataview/data.json", `{"v":1}`)
	desk.put("note.md", "two")
	desk.put(".obsidian/plugins/dataview/data.json", `{"v":2}`)
	done, err := r.srv.OperatorRestore(testVault, at, 0, true)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	before := r.mustStats().Versions

	old := r.dial("old")
	helloAt(old, wire.ProtoPlugins-1)
	old.sendJSON(wire.In{Op: "undo", OpID: done.Result.OpID})
	if msg := old.expectErr(wire.CodeNoUndo); !strings.Contains(msg, "community plugins") {
		t.Fatalf("protocol 3's undo of a restore that changed plugins was refused as %q", msg)
	}
	if got := r.mustStats().Versions; got != before {
		t.Fatalf("a refused undo wrote %d versions", got-before)
	}
	desk.sendJSON(wire.In{Op: "undo", OpID: done.Result.OpID})
	desk.recvInto("undone", nil)
}
