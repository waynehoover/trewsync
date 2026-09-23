package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/telimus/internal/chunks"
	"github.com/waynehoover/telimus/internal/frame"
	"github.com/waynehoover/telimus/internal/store"
)

// protocol-transcripts.json, replayed against a real server on a fresh store
// (PLAN.md M1 task 12). The file's note is the format; scripts/protocol-
// transcripts.py writes it. The TypeScript client's fake socket plays the same
// file's server side back to the client, so a transcript that passes here is
// the server's behaviour and the client's contract at once.

type transcriptFile struct {
	Format       int                         `json:"format"`
	Vault        string                      `json:"vault"`
	Placeholders map[string]transcriptHolder `json:"placeholders"`
	Devices      map[string]transcriptDevice `json:"devices"`
	Transcripts  []transcript                `json:"transcripts"`
}

type transcriptHolder struct {
	Kind    string          `json:"kind"`
	Same    bool            `json:"same"`
	Example json.RawMessage `json:"example"`
	About   string          `json:"about"`
}

type transcriptDevice struct {
	DeviceID  string `json:"deviceId"`
	Token     string `json:"token"`
	Device    string `json:"device"`
	CreatedAt int64  `json:"createdAt"`
}

type transcript struct {
	Name   string           `json:"name"`
	Covers string           `json:"covers"`
	Steps  []transcriptStep `json:"steps"`
}

type transcriptStep struct {
	Conn         string          `json:"conn,omitempty"`
	Send         json.RawMessage `json:"send,omitempty"`
	SendBinary   string          `json:"sendBinary,omitempty"`
	Expect       json.RawMessage `json:"expect,omitempty"`
	ExpectBinary string          `json:"expectBinary,omitempty"`
	ExpectClose  bool            `json:"expectClose,omitempty"`
	Close        bool            `json:"close,omitempty"`
	Store        *transcriptSeed `json:"store,omitempty"`
}

type transcriptSeed struct {
	Op     string   `json:"op"`
	Path   string   `json:"path"`
	Bodies []string `json:"bodies"`
	MTime  int64    `json:"mtime"`
	Chunk  string   `json:"chunk"`
}

func loadTranscripts(t *testing.T) transcriptFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-transcripts.json"))
	if err != nil {
		t.Fatalf("the transcripts are not beside the source: %v", err)
	}
	var f transcriptFile
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var probe struct {
		Note []string `json:"note"`
		transcriptFile
	}
	if err := dec.Decode(&probe); err != nil {
		t.Fatalf("protocol-transcripts.json: %v", err)
	}
	f = probe.transcriptFile
	if f.Format != 1 {
		t.Fatalf("transcript format %d, and this replayer reads 1", f.Format)
	}
	return f
}

// replayer drives one transcript and reports the first frame that differs.
type replayer struct {
	f     transcriptFile
	r     *rig
	conns map[string]*websocket.Conn
	done  map[string]bool
	binds map[string]any
	ctx   context.Context
}

func newReplayer(ctx context.Context, f transcriptFile, r *rig) *replayer {
	return &replayer{f: f, r: r, conns: map[string]*websocket.Conn{}, done: map[string]bool{},
		binds: map[string]any{}, ctx: ctx}
}

// replay runs every step, and then asks every connection still open whether
// the server sent it anything no step expected.
func (p *replayer) replay(tr transcript) error {
	for _, d := range sortedDevices(p.f.Devices) {
		raw, ok := store.DecodeToken(d.Token, store.DeviceTokenBytes)
		if !ok {
			return fmt.Errorf("device %s: the token is not 32 bytes of base64url", d.DeviceID)
		}
		if err := p.r.st.RegisterDevice(p.f.Vault, d.DeviceID, d.Device, store.HashToken(raw), d.CreatedAt); err != nil {
			return fmt.Errorf("device %s: %v", d.DeviceID, err)
		}
	}
	for i, st := range tr.Steps {
		if err := p.step(st); err != nil {
			return fmt.Errorf("step %d (%s): %w", i+1, describe(st), err)
		}
	}
	for name, c := range p.conns {
		if p.done[name] {
			continue
		}
		ctx, cancel := context.WithTimeout(p.ctx, 200*time.Millisecond)
		_, data, err := c.Read(ctx)
		cancel()
		if err == nil {
			return fmt.Errorf("after the last step, %s was sent a frame nothing expected: %s", name, data)
		}
	}
	return nil
}

func sortedDevices(m map[string]transcriptDevice) []transcriptDevice {
	out := make([]transcriptDevice, 0, len(m))
	for _, d := range m {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

func describe(st transcriptStep) string {
	switch {
	case st.Store != nil:
		return "store " + st.Store.Op
	case st.Send != nil:
		return st.Conn + " sends " + string(st.Send)
	case st.SendBinary != "":
		return st.Conn + " sends a binary frame"
	case st.Expect != nil:
		return st.Conn + " expects " + string(st.Expect)
	case st.ExpectBinary != "":
		return st.Conn + " expects a body"
	case st.ExpectClose:
		return st.Conn + " expects the server to close"
	case st.Close:
		return st.Conn + " closes"
	}
	return "an empty step"
}

func (p *replayer) conn(name string) (*websocket.Conn, error) {
	if p.done[name] {
		return nil, fmt.Errorf("connection %s was already closed", name)
	}
	if c, ok := p.conns[name]; ok {
		return c, nil
	}
	c, _, err := websocket.Dial(p.ctx, p.r.url, nil)
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(ReadLimit)
	p.conns[name] = c
	return c, nil
}

func (p *replayer) step(st transcriptStep) error {
	if st.Store != nil {
		return p.seed(*st.Store)
	}
	c, err := p.conn(st.Conn)
	if err != nil {
		return err
	}
	switch {
	case st.Send != nil:
		return c.Write(p.ctx, websocket.MessageText, st.Send)
	case st.SendBinary != "":
		b, err := hex.DecodeString(st.SendBinary)
		if err != nil {
			return err
		}
		return c.Write(p.ctx, websocket.MessageBinary, b)
	case st.Expect != nil:
		typ, data, err := p.read(c)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			return fmt.Errorf("got a binary frame of %d bytes", len(data))
		}
		var want, got any
		if err := json.Unmarshal(st.Expect, &want); err != nil {
			return fmt.Errorf("the expectation is not JSON: %w", err)
		}
		if err := json.Unmarshal(data, &got); err != nil {
			return fmt.Errorf("the server sent %q, which is not JSON", data)
		}
		if err := p.match("", want, got); err != nil {
			return fmt.Errorf("%w\n  server sent %s", err, data)
		}
		return nil
	case st.ExpectBinary != "":
		want, err := hex.DecodeString(st.ExpectBinary)
		if err != nil {
			return err
		}
		typ, data, err := p.read(c)
		if err != nil {
			return err
		}
		if typ != websocket.MessageBinary {
			return fmt.Errorf("got the text frame %s", data)
		}
		got, err := frame.Decode(data, store.ChunkMax)
		if err != nil {
			return fmt.Errorf("the body frame does not decode: %w", err)
		}
		if !bytes.Equal(got, want) {
			return fmt.Errorf("the body is %q, want %q", got, want)
		}
		return nil
	case st.ExpectClose:
		typ, data, err := p.read(c)
		if err == nil {
			return fmt.Errorf("the connection stayed open and sent a frame (%v): %s", typ, data)
		}
		p.done[st.Conn] = true
		return nil
	case st.Close:
		p.done[st.Conn] = true
		c.CloseNow()
		// Let the server see it go before the next step, which is usually a
		// commit this connection must not be the one to hear about.
		deadline := time.Now().Add(5 * time.Second)
		for p.r.srv.Sessions() >= len(p.conns)-len(p.done)+1 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		return nil
	}
	return fmt.Errorf("a step that does nothing")
}

func (p *replayer) read(c *websocket.Conn) (websocket.MessageType, []byte, error) {
	ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
	defer cancel()
	return c.Read(ctx)
}

// seed does a store step: what the transcript says happened on the server
// rather than on a connection.
func (p *replayer) seed(s transcriptSeed) error {
	st := p.r.st
	switch s.Op {
	case "put":
		names := make([]string, 0, len(s.Bodies))
		var size int64
		for _, h := range s.Bodies {
			b, err := hex.DecodeString(h)
			if err != nil {
				return err
			}
			n := chunks.Name(b)
			if err := st.Chunks().Put(p.f.Vault, n, b); err != nil {
				return err
			}
			names = append(names, n)
			size += int64(len(b))
		}
		_, err := st.AppendEntry(p.f.Vault, store.Entry{
			Path: s.Path, Size: size, MTime: s.MTime, Device: "seed", Chunks: names,
		})
		return err
	case "loseChunk":
		path, err := st.Chunks().Path(p.f.Vault, s.Chunk)
		if err != nil {
			return err
		}
		return os.Remove(path)
	}
	return fmt.Errorf("unknown store step %q", s.Op)
}

// match compares a frame against an expectation: the same keys, no others,
// equal values, and placeholders matching their kind.
func (p *replayer) match(where string, want, got any) error {
	if s, ok := want.(string); ok && strings.HasPrefix(s, "$") {
		return p.placeholder(where, s, got)
	}
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: want an object, got %v", where, got)
		}
		for k := range g {
			if _, ok := w[k]; !ok {
				return fmt.Errorf("%s: the server sent a field %q the transcript does not have", where, k)
			}
		}
		for k, wv := range w {
			gv, ok := g[k]
			if !ok {
				return fmt.Errorf("%s: the server did not send %q", where, k)
			}
			if err := p.match(where+"."+k, wv, gv); err != nil {
				return err
			}
		}
		return nil
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Errorf("%s: want %d items, got %v", where, len(w), got)
		}
		for i := range w {
			if err := p.match(fmt.Sprintf("%s[%d]", where, i), w[i], g[i]); err != nil {
				return err
			}
		}
		return nil
	}
	if !reflect.DeepEqual(want, got) {
		return fmt.Errorf("%s: want %v, got %v", where, want, got)
	}
	return nil
}

func (p *replayer) placeholder(where, name string, got any) error {
	if rest, ok := strings.CutPrefix(name, "$prefix:"); ok {
		s, isString := got.(string)
		if !isString || !strings.HasPrefix(s, rest) {
			return fmt.Errorf("%s: want a string beginning %q, got %v", where, rest, got)
		}
		return nil
	}
	h, ok := p.f.Placeholders[name]
	if !ok {
		return fmt.Errorf("%s: %s is not a placeholder the file defines", where, name)
	}
	switch h.Kind {
	case "string":
		if s, ok := got.(string); !ok || s == "" {
			return fmt.Errorf("%s: %s wants a non-empty string, got %v", where, name, got)
		}
	case "number":
		if _, ok := got.(float64); !ok {
			return fmt.Errorf("%s: %s wants a number, got %v", where, name, got)
		}
	default:
		return fmt.Errorf("%s: %s has the unknown kind %q", where, name, h.Kind)
	}
	if h.Same {
		if bound, ok := p.binds[name]; ok && !reflect.DeepEqual(bound, got) {
			return fmt.Errorf("%s: %s was %v earlier in this transcript and is %v here", where, name, bound, got)
		}
		p.binds[name] = got
	}
	return nil
}

// replayOne runs one transcript against a fresh server and returns its first
// difference.
func replayOne(t *testing.T, f transcriptFile, tr transcript) error {
	t.Helper()
	r := newRig(t)
	if f.Vault != testVault {
		t.Fatalf("the transcripts' vault is %q and the rig's is %q", f.Vault, testVault)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	p := newReplayer(ctx, f, r)
	defer func() {
		for _, c := range p.conns {
			c.CloseNow()
		}
	}()
	return p.replay(tr)
}

// Every transcript, and the ones the brief names must all be there.
func TestTheTranscriptsAreWhatTheServerDoes(t *testing.T) {
	f := loadTranscripts(t)
	names := map[string]bool{}
	for _, tr := range f.Transcripts {
		names[tr.Name] = true
		t.Run(tr.Name, func(t *testing.T) {
			if err := replayOne(t, f, tr); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, want := range []string{"have", "want", "mixed-success putmany", "stale rename source",
		"stale rename destination", "reconnect continuity", "resend repair", "applied receipts"} {
		if !names[want] {
			t.Errorf("no transcript covers %q", want)
		}
	}
}

// A replayer that passes whatever it is given proves nothing, so the same
// transcripts, each damaged one way, must each fail: a value changed, a field
// added or removed, a body changed, an expected frame dropped, and a
// placeholder that must hold one value holding two.
func TestACorruptedTranscriptIsCaught(t *testing.T) {
	f := loadTranscripts(t)
	find := func(name string) transcript {
		for _, tr := range f.Transcripts {
			if tr.Name == name {
				return tr
			}
		}
		t.Fatalf("no transcript %q", name)
		return transcript{}
	}
	edit := func(tr transcript, i int, fn func(map[string]any)) transcript {
		var m map[string]any
		if err := json.Unmarshal(tr.Steps[i].Expect, &m); err != nil {
			t.Fatalf("step %d of %s is not an expectation: %v", i, tr.Name, err)
		}
		fn(m)
		b, _ := json.Marshal(m)
		steps := append([]transcriptStep(nil), tr.Steps...)
		steps[i].Expect = b
		tr.Steps = steps
		return tr
	}
	lastExpect := func(tr transcript, res string) int {
		for i := len(tr.Steps) - 1; i >= 0; i-- {
			var m map[string]any
			if json.Unmarshal(tr.Steps[i].Expect, &m) == nil && m["res"] == res {
				return i
			}
		}
		t.Fatalf("%s has no step expecting %s", tr.Name, res)
		return -1
	}

	have := find("have")
	haveAt := lastExpect(have, "have")
	want := find("want")
	for _, c := range []struct {
		what string
		tr   transcript
	}{
		{"a uid changed", edit(have, haveAt, func(m map[string]any) { m["uid"] = 99 })},
		{"a field the server does not send", edit(have, haveAt, func(m map[string]any) { m["wrapped"] = "x" })},
		{"a field the server sends, removed", edit(have, haveAt, func(m map[string]any) { delete(m, "uid") })},
		{"a string changed", edit(have, haveAt, func(m map[string]any) { m["res"] = "ack" })},
		{"a body changed", func() transcript {
			tr := want
			steps := append([]transcriptStep(nil), tr.Steps...)
			for i := range steps {
				if steps[i].ExpectBinary != "" {
					steps[i].ExpectBinary = hex.EncodeToString([]byte("not the body"))
					break
				}
			}
			tr.Steps = steps
			return tr
		}()},
		{"an expected frame dropped", func() transcript {
			tr := have
			steps := append([]transcriptStep(nil), tr.Steps[:haveAt-1]...)
			steps = append(steps, tr.Steps[haveAt:]...)
			tr.Steps = steps
			return tr
		}()},
		{"a frame expected that never comes", func() transcript {
			tr := have
			tr.Steps = append(append([]transcriptStep(nil), tr.Steps...),
				transcriptStep{Conn: tr.Steps[len(tr.Steps)-1].Conn, Expect: json.RawMessage(`{"res":"pong"}`)})
			return tr
		}()},
	} {
		t.Run(c.what, func(t *testing.T) {
			if err := replayOne(t, f, c.tr); err == nil {
				t.Fatal("the damaged transcript replayed clean")
			}
		})
	}
}

// A placeholder marked same holds one value for the whole transcript, and one
// that is not may differ each time it appears. Tested on the matcher itself,
// because one store has one epoch, so no real replay can show the first.
func TestAPlaceholderMarkedSameHoldsOneValue(t *testing.T) {
	f := loadTranscripts(t)
	p := newReplayer(context.Background(), f, nil)
	if err := p.match("ready.epoch", "$epoch", "one epoch"); err != nil {
		t.Fatal(err)
	}
	if err := p.match("ready.epoch", "$epoch", "another epoch"); err == nil {
		t.Fatal("$epoch matched two values in one transcript")
	}
	for _, msg := range []string{"one message", "another message"} {
		if err := p.match("err.msg", "$msg", msg); err != nil {
			t.Fatalf("$msg is not bound, and refused a second value: %v", err)
		}
	}
	for _, c := range []struct {
		want, got any
	}{
		{"$time", "not a number"},
		{"$msg", ""},
		{"$prefix:dotprefix: ", "nfc: the path is not"},
		{"$undefined", "anything"},
	} {
		if err := p.match("x", c.want, c.got); err == nil {
			t.Errorf("%v matched %v", c.want, c.got)
		}
	}
}
