package mcp

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/coder/websocket"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/waynehoover/trewsync/internal/chunks"
	wireframe "github.com/waynehoover/trewsync/internal/frame"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// What the write tools' tests share: an agent with a write token, the facts a
// mutation's result carries, the before-image check every mutation test makes
// (PLAN.md section 7), and a device on the same server.

// agent is a write token with its label, and an SDK session using it.
type agent struct {
	label string
	token string
	tok   store.NewMCPToken
	cs    *sdk.ClientSession
}

// writer mints a write token labelled label and connects the SDK client with
// it at the SDK's own newest version.
func (r *rig) writer(label string) *agent {
	r.t.Helper()
	tok, err := r.srv.OperatorMCPToken(testVault, label, store.ScopeWrite, nil)
	if err != nil {
		r.t.Fatal(err)
	}
	a := &agent{label: label, token: store.EncodeToken(tok.Token), tok: tok}
	a.cs = r.mustConnect(a.token, "")
	return a
}

func (r *rig) epoch() string { return r.st.Epoch() }

// written is a committed mutation's result.
type written struct {
	Committed   any    `json:"committed"`
	OpID        string `json:"opId"`
	Noop        bool   `json:"noop"`
	Epoch       string `json:"epoch"`
	CommittedAt int64  `json:"committedAt"`
	Count       int    `json:"count"`
	Path        string `json:"path"`
	To          string `json:"to"`
	Entries     []row  `json:"-"`
}

type row struct {
	Path         string `json:"path"`
	UID          int64  `json:"uid"`
	PreviousUID  *int64 `json:"previousUid"`
	PreviousPath string `json:"previousPath"`
	Kind         string `json:"kind"`
	Size         int64  `json:"size"`
}

// wrote is the committed result of a call, failing the test for anything else.
func wrote(t *testing.T, e envelope) written {
	t.Helper()
	if e.isError {
		t.Fatalf("%s failed: %s", e.Tool, e.raw)
	}
	var w written
	e.trusted(t, &w)
	if w.Committed != true || w.OpID == "" {
		t.Fatalf("%s did not commit: %s", e.Tool, e.raw)
	}
	var u struct {
		Entries []row `json:"entries"`
	}
	e.untrusted(t, &u)
	w.Entries = u.Entries
	return w
}

// refused is the error code of a failed call, and that it wrote nothing.
func refused(t *testing.T, e envelope) string {
	t.Helper()
	if !e.isError {
		t.Fatalf("%s succeeded: %s", e.Tool, e.raw)
	}
	var f struct {
		Committed any `json:"committed"`
	}
	e.trusted(t, &f)
	if f.Committed != false {
		t.Fatalf("%s failed without saying nothing was written: %s", e.Tool, e.raw)
	}
	return e.errorCode()
}

// preview is a preview's facts and changes, the changes as the apply passes
// them back.
type preview struct {
	Phase          string `json:"phase"`
	Head           int64  `json:"head"`
	Epoch          string `json:"epoch"`
	AmbiguousLinks int    `json:"ambiguousLinks"`
	Count          int    `json:"count"`
	Scan           struct {
		Method      string `json:"method"`
		IndexedHead int64  `json:"indexedHead"`
		Why         string `json:"why"`
	} `json:"scan"`
	BrokenLinksComplete *bool  `json:"brokenLinksComplete"`
	Changes             []any  `json:"-"`
	BrokenLinks         []any  `json:"-"`
	raw                 []byte `json:"-"`
}

func previewed(t *testing.T, e envelope) preview {
	t.Helper()
	if e.isError {
		t.Fatalf("%s's preview failed: %s", e.Tool, e.raw)
	}
	var p preview
	e.trusted(t, &p)
	if p.Phase != "preview" {
		t.Fatalf("not a preview: %s", e.raw)
	}
	var u struct {
		Changes     []any `json:"changes"`
		BrokenLinks []any `json:"brokenLinks"`
	}
	e.untrusted(t, &u)
	p.Changes, p.BrokenLinks, p.raw = u.Changes, u.BrokenLinks, e.raw
	return p
}

// apply is args with a preview's changes, head and epoch added.
func apply(args map[string]any, p preview) map[string]any {
	out := map[string]any{}
	for k, v := range args {
		out[k] = v
	}
	out["changes"], out["head"], out["epoch"] = p.Changes, p.Head, p.Epoch
	return out
}

// head is the uid of path's newest version.
func (r *rig) head(path string) int64 {
	r.t.Helper()
	uid, err := r.st.CurrentUID(testVault, path)
	if err != nil {
		r.t.Fatal(err)
	}
	return uid
}

// bytesAt is the store's own bytes for uid, assembled without the tools.
func (r *rig) bytesAt(uid int64) string {
	r.t.Helper()
	e, ok, err := r.st.EntryByUID(testVault, uid)
	if err != nil || !ok {
		r.t.Fatalf("uid %d: %v %v", uid, ok, err)
	}
	var out []byte
	for _, name := range e.Chunks {
		b, err := r.st.Chunks().Get(testVault, name)
		if err != nil {
			r.t.Fatal(err)
		}
		out = append(out, b...)
	}
	return string(out)
}

// former checks the before-image PLAN.md section 7 asks every mutation test
// to: read_note {path, uid: previousUid} returns the exact former bytes, and
// still does after a default purge.
func (r *rig) former(cs *sdk.ClientSession, path string, uid int64, want string) {
	r.t.Helper()
	read := func(when string) {
		e := invoke(r.t, cs, "read_note", map[string]any{"path": path, "uid": uid, "maxLines": 1000})
		if e.isError {
			r.t.Fatalf("%s: reading uid %d of %s: %s", when, uid, path, e.raw)
		}
		var u struct {
			Content string `json:"content"`
		}
		e.untrusted(r.t, &u)
		if u.Content != want {
			r.t.Fatalf("%s: uid %d of %s reads %q, want the former bytes %q", when, uid, path, u.Content, want)
		}
	}
	read("after the write")
	if _, err := r.st.Purge(testVault, chunks.DefaultGrace); err != nil {
		r.t.Fatal(err)
	}
	read("after a default purge")
}

// operations is how many operations the vault has recorded.
func (r *rig) operations() int {
	r.t.Helper()
	ops, _, err := r.st.Operations(testVault, 0, 0, store.AuditMax)
	if err != nil {
		r.t.Fatal(err)
	}
	return len(ops)
}

// device is a device session on the rig's server: registered in the store,
// connected over the protocol, and reading every frame it is sent.
type device struct {
	t      *testing.T
	conn   *websocket.Conn
	ctx    context.Context
	next   int64
	frames chan map[string]any
}

func (r *rig) device(name string) *device {
	r.t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		r.t.Fatal(err)
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		r.t.Fatal(err)
	}
	id := store.EncodeToken(idBytes)
	if err := r.st.RegisterDevice(testVault, id, name, store.HashToken(raw), time.Now().UnixMilli()); err != nil {
		r.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	conn, _, err := websocket.Dial(ctx, "ws"+r.hs.URL[len("http"):], nil)
	if err != nil {
		cancel()
		r.t.Fatal(err)
	}
	conn.SetReadLimit(64 << 20)
	d := &device{t: r.t, conn: conn, ctx: ctx, next: 1, frames: make(chan map[string]any, 1024)}
	r.t.Cleanup(func() {
		cancel()
		conn.CloseNow()
	})
	go func() {
		defer close(d.frames)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
				d.frames <- m
			}
		}
	}()
	d.send(wire.In{Op: "hello", ID: d.id(), Proto: wire.Proto, Vault: testVault, Token: store.EncodeToken(raw),
		DeviceID: id, Device: name})
	d.until("ready")
	d.until("caught-up")
	return d
}

func (d *device) id() int64 { d.next++; return d.next - 1 }

func (d *device) send(v any) {
	d.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		d.t.Fatal(err)
	}
	if err := d.conn.Write(d.ctx, websocket.MessageText, b); err != nil {
		d.t.Fatal(err)
	}
}

// until is the next frame whose res or op is one of want.
func (d *device) until(want ...string) map[string]any {
	d.t.Helper()
	m, err := d.await(10*time.Second, want...)
	if err != nil {
		d.t.Fatal(err)
	}
	return m
}

func (d *device) await(wait time.Duration, want ...string) (map[string]any, error) {
	timeout := time.After(wait)
	for {
		select {
		case m, ok := <-d.frames:
			if !ok {
				return nil, fmt.Errorf("the device's connection closed")
			}
			for _, w := range want {
				if m["res"] == w || m["op"] == w {
					return m, nil
				}
			}
			if m["res"] == "err" {
				return nil, fmt.Errorf("refused: %v", m)
			}
		case <-timeout:
			return nil, fmt.Errorf("no %v within %s", want, wait)
		}
	}
}

// batchWith waits for a live batch carrying the entry uid, and returns it.
func (d *device) batchWith(uid int64, wait time.Duration) (store.Entry, error) {
	deadline := time.Now().Add(wait)
	for {
		m, err := d.await(time.Until(deadline), "batch")
		if err != nil {
			return store.Entry{}, err
		}
		b, _ := json.Marshal(m)
		var batch wire.Batch
		if err := json.Unmarshal(b, &batch); err != nil {
			return store.Entry{}, err
		}
		for _, e := range batch.Entries {
			if e.UID == uid {
				return e, nil
			}
		}
	}
}

// put writes one note as a device does, conditional on base.
func (d *device) put(path, text string, base int64) int64 {
	d.t.Helper()
	body := []byte(text)
	names := []string{}
	if len(body) > 0 {
		names = []string{chunks.Name(body)}
	}
	d.send(wire.In{Op: "put", ID: d.id(), Path: path, Chunks: names, Base: base,
		Meta: wire.PutMeta{Size: int64(len(body)), MTime: time.Now().UnixMilli()}})
	m := d.until("want", "ack", "have")
	if m["res"] == "want" {
		if err := d.conn.Write(d.ctx, websocket.MessageBinary, append([]byte{wireframe.MarkerRaw}, body...)); err != nil {
			d.t.Fatal(err)
		}
		m = d.until("ack", "have")
	}
	uid, _ := m["uid"].(float64)
	if uid == 0 {
		d.t.Fatalf("the put of %s was not acknowledged: %v", path, m)
	}
	return int64(uid)
}
