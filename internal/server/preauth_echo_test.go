package server

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/wire"
)

// Security review L1: before a connection authenticates, what it sends is
// clipped before it is logged or echoed. A 60 KiB op came back through %q,
// JSON and the log's quoting as about 210 KiB, to the socket and to the log.
func TestAPreAuthOpIsClippedInTheReplyAndTheLog(t *testing.T) {
	r, logs := newRigLogging(t)
	c := r.dial("a")
	op := strings.Repeat("\u0080", 30000)
	c.sendRaw(map[string]any{"op": op})
	msg := c.expectErr(wire.CodeProtoState)
	if len(msg) > 200 || !strings.Contains(msg, "...") {
		t.Fatalf("the refusal echoes %d bytes of the op: %.80q", len(msg), msg)
	}
	waitFor(t, "the refusal in the log", func() bool { return strings.Contains(logs.String(), "first op must be hello") })
	if n := len(logs.String()); n > 2048 {
		t.Fatalf("the log grew %d bytes for one refused hello", n)
	}
}

// And a refused Origin is logged once, clipped, however long it is.
func TestARefusedOriginIsLoggedOnceAndClipped(t *testing.T) {
	r := newRig(t)
	logs := &syncBuffer{}
	hs := httptest.NewServer(HTTPHandler(r.srv, slog.New(slog.NewTextHandler(logs, nil))))
	t.Cleanup(hs.Close)

	origin := "https://" + strings.Repeat("a", 64<<10) + ".example"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	header := http.Header{}
	header.Set("Origin", origin)
	conn, _, err := websocket.Dial(ctx, "ws"+hs.URL[len("http"):], &websocket.DialOptions{HTTPHeader: header})
	if err == nil {
		conn.CloseNow()
		t.Fatal("a foreign origin was allowed to connect")
	}
	waitFor(t, "the refusal in the log", func() bool { return strings.Contains(logs.String(), "websocket accept refused") })
	out := logs.String()
	if len(out) > 1024 {
		t.Fatalf("the log grew %d bytes for one refused origin", len(out))
	}
	if n := strings.Count(out, origin[:maxLoggedOrigin-1]); n != 1 {
		t.Fatalf("the origin is in the log %d times, want once: %s", n, out)
	}
}
