package server

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Security review L3: a refused hello held its pre-auth slot until its
// session was forgotten, after up to two seconds spent draining the refusal
// to a peer that might not read it. A connection that has spoken is never
// closed to make room, so a few of these, topped up, refused every new
// device busy. The slot is now given back as soon as the hello is refused.
//
// The first connection's writes are held, as a peer with a closed receive
// window would hold them, so its drain lasts the full two seconds; the slot
// must be free well before that.
func TestARefusedHelloReleasesItsSlotBeforeTheDrain(t *testing.T) {
	r := newRig(t)
	r.srv.maxPreAuth = 1

	gate := make(chan struct{})
	var held atomic.Bool
	hs := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		r.srv.Handle(req.Context(), conn, req.RemoteAddr)
	}))
	hs.Listener = &firstConnGated{Listener: hs.Listener, gate: gate, held: &held}
	hs.Start()
	var open sync.Once
	t.Cleanup(func() {
		open.Do(func() { close(gate) })
		hs.Close()
	})
	r.url = "ws" + strings.TrimPrefix(hs.URL, "http")

	stalled := r.dial("stalled")
	waitFor(t, "one pre-auth session", func() bool { return r.srv.PreAuth() == 1 })
	held.Store(true)
	stalled.sendRaw(map[string]any{"op": "not-hello"})

	deadline := time.Now().Add(time.Second)
	for r.srv.PreAuth() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("a refused hello still holds its pre-auth slot a second later")
		}
		time.Sleep(5 * time.Millisecond)
	}
	honest := r.dial("honest")
	honest.hello(0)
	open.Do(func() { close(gate) })
}

// firstConnGated holds every write to the first connection it accepts, once
// held is set, until gate is closed.
type firstConnGated struct {
	net.Listener
	gate  chan struct{}
	held  *atomic.Bool
	first sync.Once
}

func (l *firstConnGated) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return c, err
	}
	gated := false
	l.first.Do(func() { gated = true })
	if !gated {
		return c, nil
	}
	return &gatedConn{Conn: c, gate: l.gate, held: l.held}, nil
}

type gatedConn struct {
	net.Conn
	gate chan struct{}
	held *atomic.Bool
}

func (c *gatedConn) Write(b []byte) (int, error) {
	if c.held.Load() {
		<-c.gate
	}
	return c.Conn.Write(b)
}
