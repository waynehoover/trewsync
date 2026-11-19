package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Security review L2: serve's HTTP server closes a keep-alive connection
// left idle, and leaves a websocket alone however long it is quiet.
func TestIdleKeepAliveConnectionsCloseAndWebsocketsStay(t *testing.T) {
	hs := newHTTPServer("127.0.0.1:0")
	if hs.IdleTimeout != 2*time.Minute {
		t.Fatalf("IdleTimeout is %v, want 2m", hs.IdleTimeout)
	}
	// The same server, with the wait shortened so the test can see it.
	hs.IdleTimeout = 200 * time.Millisecond
	hs.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" {
			_, _ = io.WriteString(w, "ok\n")
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			typ, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, b); err != nil {
				return
			}
		}
	})
	ln, err := net.Listen("tcp", hs.Addr)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = hs.Serve(ln) }()
	t.Cleanup(func() { _ = hs.Close() })
	addr := ln.Addr().String()

	// A keep-alive connection: one request answered, then nothing.
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := br.ReadByte(); err != io.EOF {
		t.Fatalf("an idle keep-alive connection was not closed: %v", err)
	}

	// A websocket quiet for longer than the idle timeout still answers.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://"+addr+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	time.Sleep(4 * hs.IdleTimeout)
	if err := ws.Write(ctx, websocket.MessageText, []byte("still here")); err != nil {
		t.Fatalf("writing to a quiet websocket: %v", err)
	}
	if _, b, err := ws.Read(ctx); err != nil || string(b) != "still here" {
		t.Fatalf("a quiet websocket was closed: %q %v", b, err)
	}
}
