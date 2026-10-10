package server

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/wire"
)

// Settings sync is protocol 3's (plan/settings-sync.md). A session of 3 may
// write, and is sent, paths inside a profile root that paths.CheckConfig
// accepts. A session of 1 or 2 is held to the notes rule as it always was and
// never sees a settings entry, while its cursor still moves past each one.

// configVector is one case of the `config` section of protocol-fixtures.json:
// the path, the notes rule's reason and protocol 3's.
type configVector struct {
	Name   string  `json:"name"`
	Hex    string  `json:"hex"`
	Notes  *string `json:"notes"`
	Config *string `json:"config"`
}

func configVectors(t *testing.T) []configVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Config struct {
			Cases []configVector `json:"cases"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Config.Cases) < 30 {
		t.Fatalf("only %d settings vectors, which is not a matrix", len(f.Config.Cases))
	}
	return f.Config.Cases
}

func (v configVector) path(t *testing.T) string {
	t.Helper()
	b, err := hex.DecodeString(v.Hex)
	if err != nil {
		t.Fatalf("%s: %v", v.Name, err)
	}
	return string(b)
}

// helloAt is hello for a client that asks for proto.
func helloAt(c *client, proto int) {
	c.t.Helper()
	c.proto = proto
	c.hello(0)
}

// Every settings vector through a session of protocol 3, and through one of
// protocol 2. Protocol 3 commits what CheckConfig accepts and refuses the rest
// with its reason; protocol 2 refuses every one of them with the notes rule's
// reason, which is the one it always gave.
func TestTheSettingsMatrixThroughASession(t *testing.T) {
	r := newRig(t)
	now := r.dial("now")
	helloAt(now, wire.ProtoConfig)
	old := r.dial("old")
	helloAt(old, wire.ProtoConfig-1)
	body := "{}"
	names, size := chunkNames([]string{body})

	expect := func(c *client, v configVector, reason *string) {
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
			return
		}
		msg := c.expectErr(wire.CodeBadPath)
		if want := *reason + ": the path "; !strings.HasPrefix(msg, want) {
			t.Fatalf("%s: protocol %d refused it as %q, want it to lead with %q", v.Name, c.proto, msg, want)
		}
	}
	for _, v := range configVectors(t) {
		expect(old, v, v.Notes)
		expect(now, v, v.Config)
	}
}

// A rename never crosses between a settings folder and the vault: a session
// of 1 or 2 would see a note appear from, or vanish into, a path it is never
// sent.
func TestASettingsMoveToOrFromTheVaultIsRefused(t *testing.T) {
	r := newRig(t)
	c := r.dial("desk")
	helloAt(c, wire.ProtoConfig)
	c.put(".obsidian/app.json", "{}")
	c.put("note.md", "a note")
	names, size := chunkNames([]string{"{}"})
	for _, m := range []struct{ from, to string }{
		{".obsidian/app.json", "app.json"},
		{"note.md", ".obsidian/note.json"},
	} {
		c.sendJSON(wire.In{Op: "put", Path: m.to, Chunks: names,
			Meta: wire.PutMeta{Size: size, MTime: 2, Prev: m.from}, PrevBase: c.head(m.from)})
		if msg := c.expectErr(wire.CodeBadPath); !strings.HasPrefix(msg, "configmove: the prev ") {
			t.Fatalf("a move from %s to %s was refused as %q", m.from, m.to, msg)
		}
	}
	// Within a profile root, a rename is an ordinary one.
	c.sendJSON(wire.In{Op: "put", Path: ".obsidian/graph.json", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 3, Prev: ".obsidian/app.json"}, PrevBase: c.head(".obsidian/app.json")})
	if m := c.recv(); m["res"] != "have" {
		t.Fatalf("a rename inside the settings folder was answered %v", m)
	}
}

// A session of protocol 2 is sent no settings entry, in its catch-up or
// live, and its cursor reaches the same uid a session of 3 does: each one is
// covered by its batch's range, as a device's own echo is.
func TestAnOlderSessionNeverSeesASettingsEntry(t *testing.T) {
	for _, tc := range []struct {
		proto int
		want  []string
	}{
		{wire.ProtoConfig - 1, []string{"note.md"}},
		{1, []string{"note.md"}},
		{wire.ProtoConfig, []string{".obsidian/app.json", "note.md", ".obsidian/hotkeys.json"}},
	} {
		r := newRig(t)
		desk := r.dial("desk")
		helloAt(desk, wire.ProtoConfig)
		desk.put(".obsidian/app.json", `{"a":1}`)
		desk.put("note.md", "a note")
		last := desk.put(".obsidian/hotkeys.json", "{}")

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
		// hello checked that every batch continued the one before, so the
		// cursor reached the newest uid through the ranges alone. A live
		// write is the next uid, covered whether or not it is sent.
		next := desk.put(".obsidian/appearance.json", "{}")
		b := c.nextBatch()
		if b.From != last+1 || b.To != next {
			t.Fatalf("protocol %d: the live batch covers %d to %d, want %d to %d",
				tc.proto, b.From, b.To, last+1, next)
		}
		if sent := len(b.Entries) == 1; sent != (tc.proto >= wire.ProtoConfig) {
			t.Fatalf("protocol %d: a live settings entry sent is %v", tc.proto, sent)
		}
		note := desk.put("later.md", "a later note")
		if b := c.nextBatch(); b.To != note || len(b.Entries) != 1 {
			t.Fatalf("protocol %d: the note after it came as %+v", tc.proto, b)
		}
	}
}
