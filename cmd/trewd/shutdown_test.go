package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/waynehoover/trewsync/internal/invite"
	"github.com/waynehoover/trewsync/internal/store"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/frame"
	"github.com/waynehoover/trewsync/internal/wire"
)

// S16: SIGTERM in the middle of an upload ends in one of two states, an ack
// that is durable or a cut-off that committed nothing, and never in a session
// left open on a closed store.
//
// http.Server.Shutdown does not own a hijacked WebSocket, so serve used to
// return from a SIGTERM with every session still connected and then close the
// store under them. The client saw nothing at all: no ack, no error, no close,
// a connection that simply stopped answering.
func TestS16ATerminatedServerEndsAnUploadAsAnAckOrACleanRetry(t *testing.T) {
	for _, tc := range []struct {
		name   string
		finish bool
	}{
		{"the upload finishes during the shutdown and is acked", true},
		{"the upload stalls and is cut off unacked at the deadline", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			port := freeTestPort(t)

			// The test takes the signal too, so a real SIGTERM reaches serve's
			// handler instead of ending the test binary.
			sigs := make(chan os.Signal, 1)
			signal.Notify(sigs, syscall.SIGTERM)
			defer signal.Stop(sigs)

			out := &safeBuffer{}
			done := make(chan error, 1)
			go func() {
				done <- run(context.Background(),
					[]string{"serve", "-data", dir, "-addr", fmt.Sprintf("127.0.0.1:%d", port)}, out)
			}()
			addr := fmt.Sprintf("127.0.0.1:%d", port)
			waitForServer(t, addr, out)

			cl := dialFirstDevice(t, "ws://"+addr, readFirstInvite(t, dir))
			bodies := [][]byte{[]byte("the first half"), []byte("the second half")}
			names := []string{chunks.Name(bodies[0]), chunks.Name(bodies[1])}
			cl.write(wire.In{
				Op: "put", ID: 2, Path: "note.md", Chunks: names,
				Meta: wire.PutMeta{Size: int64(len(bodies[0]) + len(bodies[1])), MTime: 5},
			})
			if res := cl.readJSON(); res["res"] != "want" {
				t.Fatalf("wanted a want, got %v", res)
			}
			cl.writeBinary(bodies[0])

			// One body in, one to go: the server is told to stop.
			terminate(t)

			if tc.finish {
				cl.writeBinary(bodies[1])
				ack := cl.readJSON()
				if ack["res"] != "ack" {
					t.Fatalf("an upload that completed during shutdown was not acked: %v", ack)
				}
				if e := cl.readJSON(); e["res"] != "err" || e["code"] != wire.CodeBusy {
					t.Fatalf("after the ack, wanted the shutdown reason, got %v", e)
				}
			}
			// Either way the connection is closed, within the shutdown deadline
			// plus a margin, and no further reply arrives. Before the fix this
			// read hung until its own timeout.
			if frame, err := cl.readRaw(9 * time.Second); err == nil {
				t.Fatalf("the server kept the session open and sent %s", frame)
			} else if strings.Contains(err.Error(), "deadline") {
				t.Fatal("the connection was still open long after the server was told to stop")
			}

			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("serve ended with: %v\n%s", err, out.String())
				}
			case <-time.After(10 * time.Second):
				t.Fatal("serve did not stop after SIGTERM")
			}

			// The store says the same thing the client was told.
			st, err := openExisting(dir, "inspect")
			if err != nil {
				t.Fatalf("reopening the data directory: %v", err)
			}
			defer st.Close()
			stats, err := st.Stats("default")
			if err != nil {
				t.Fatalf("stats: %v", err)
			}
			if tc.finish && stats.Versions != 1 {
				t.Fatalf("the ack was given but the store holds %d versions", stats.Versions)
			}
			if !tc.finish && stats.Versions != 0 {
				t.Fatalf("no ack was given but the store holds %d versions", stats.Versions)
			}
			faultsRep, err := st.Verify(true)
			faults := faultsRep.Faults
			if err != nil || len(faults) != 0 {
				t.Fatalf("the data directory does not verify after the shutdown: %v %v", err, faults)
			}
		})
	}
}

// terminate sends this process a real SIGTERM. Safe because the test has
// registered for it too, and sufficient because serve installs its handler
// before it starts listening, and waitForServer has seen it listen.
func terminate(t *testing.T) {
	t.Helper()
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM: %v", err)
	}
}

// waitForServer polls the health endpoint, so the listener and the signal
// handler, which is installed before it, are both known to be in place.
func waitForServer(t *testing.T, addr string, out *safeBuffer) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := trew(t, "health", "-addr", addr, "-timeout", "500ms"); err == nil {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("the server never answered:\n%s", out.String())
}

// readFirstInvite reads the invite `serve` wrote for the first device and says
// what it holds. The first line is enough: every line carries the same token,
// under a different address of this server.
func readFirstInvite(t *testing.T, dir string) invite.Invite {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, firstInviteFile))
	if err != nil {
		t.Fatalf("the first device's invite: %v", err)
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(b)), "\n")
	inv, err := invite.Parse(line)
	if err != nil {
		t.Fatalf("the first device's invite does not parse: %v", err)
	}
	return inv
}

// wsClient is the least a device needs to speak the protocol from this package.
type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
	ctx  context.Context
	// ready is the handshake reply this client was given, kept because the
	// caps a flag sets are advertised there and one test is entirely about
	// what it says.
	ready map[string]any
}

// The first device's own credentials, as a device chooses them: a base64url id
// and 32 random bytes of token, fixed here so a test can connect as it again.
var (
	firstDevID  = "first-device"
	firstDevRaw = sha256.Sum256([]byte("the first device's token"))
	firstDevKey = store.EncodeToken(firstDevRaw[:])
)

func dialWS(t *testing.T, url string) *wsClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return &wsClient{t: t, conn: conn, ctx: ctx}
}

// dialFirstDevice runs the whole of what a first device does against the real
// binary: redeem the invite `serve` wrote, for an id and a token of its own,
// then connect as that device and drain the empty catch-up. Two connections,
// because a redemption closes behind its reply: the redeemer has proved it
// holds an invite, and the next hello proves it holds the token it registered.
func dialFirstDevice(t *testing.T, url string, inv invite.Invite) *wsClient {
	t.Helper()
	joiner := dialWS(t, url)
	joiner.write(wire.In{
		Op: "hello", ID: 1, Proto: wire.Proto, Vault: inv.Vault, Device: "test-device",
		Invite: store.EncodeToken(inv.Token), DeviceID: firstDevID, Token: firstDevKey,
	})
	if res := joiner.readJSON(); res["res"] != "redeemed" {
		t.Fatalf("wanted redeemed, got %v", res)
	}
	joiner.conn.CloseNow()

	cl := dialWS(t, url)
	cl.write(wire.In{
		Op: "hello", ID: 1, Proto: wire.Proto, Vault: inv.Vault,
		Token: firstDevKey, DeviceID: firstDevID, Device: "test-device",
	})
	cl.ready = cl.readJSON()
	if cl.ready["res"] != "ready" {
		t.Fatalf("wanted ready, got %v", cl.ready)
	}
	if res := cl.readJSON(); res["op"] != "caught-up" {
		t.Fatalf("wanted caught-up, got %v", res)
	}
	return cl
}

func (c *wsClient) write(v any) {
	c.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.conn.Write(c.ctx, websocket.MessageText, b); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// writeBinary sends one chunk body as a protocol 1 body frame, raw marker and
// bytes (plan/protocol.md, "Chunk bodies").
func (c *wsClient) writeBinary(b []byte) {
	c.t.Helper()
	if err := c.conn.Write(c.ctx, websocket.MessageBinary, append([]byte{frame.MarkerRaw}, b...)); err != nil {
		c.t.Fatalf("write body: %v", err)
	}
}

func (c *wsClient) readRaw(timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(c.ctx, timeout)
	defer cancel()
	_, data, err := c.conn.Read(ctx)
	return data, err
}

// readJSON returns the next reply, skipping batches. A device's own write
// comes back to it as an empty batch before the ack does, and a client that
// took the next frame for its reply would be a client nobody can write.
func (c *wsClient) readJSON() map[string]any {
	c.t.Helper()
	for {
		data, err := c.readRaw(10 * time.Second)
		if err != nil {
			c.t.Fatalf("read: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			c.t.Fatalf("parse %q: %v", data, err)
		}
		if m["op"] == "batch" {
			continue
		}
		return m
	}
}
