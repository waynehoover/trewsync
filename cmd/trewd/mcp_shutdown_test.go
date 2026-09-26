package main

import (
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/mcp"
)

// Two guarantees of the headless client's retired MCP server (`trew mcp`)
// that no Go test held when it was deleted, ported to `trewd serve -mcp`.
// docs/development.md, "Retiring trew mcp", is the ledger.

// SIGTERM lets an MCP write already admitted finish before serve exits: the
// write held at a seam when the signal arrives commits once, its caller hears
// that it did, serve exits 0, and after a restart the note holds the line
// once and the log the one operation. From mcp-bin.test.ts and
// mcp-vault-process.test.ts, whose `trew mcp` drained an admitted edit
// before it gave up the vault. A kill instead of a stop is
// TestAKillAroundAnAppendResolvesOnRetryToOneResult.
func TestSIGTERMLetsAnAdmittedMCPWriteFinish(t *testing.T) {
	crash := builtTrewd(t, "crashmatrix")
	for _, seam := range []string{mcp.SeamBodies, mcp.SeamCommitted} {
		t.Run(seam, func(t *testing.T) {
			dir, addr := t.TempDir(), fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
			s := serveBinary(t, crash, dir, addr)
			token, _ := s.writeToken("agent")
			created := s.mustCall(token, "create_note", map[string]any{"path": "log.md", "content": "start\n"})
			_, rows := commits(t, "create_note", created)
			base, epoch := rows[0].UID, created.trusted["epoch"]
			s.stop()

			s = serveBinary(t, crash, dir, addr, "TREW_TEST_SEAM="+seam)
			args := map[string]any{"path": "log.md", "base": base, "epoch": epoch, "text": "one line\n",
				"idempotencyKey": "append-1"}
			type answer struct {
				reply toolReply
				err   error
			}
			answered := make(chan answer, 1)
			go func() {
				r, err := s.call(token, "append_note", args)
				answered <- answer{r, err}
			}()
			s.holdAt(seam)
			if err := s.cmd.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(10 * time.Second)
			for !strings.Contains(s.out.String(), "shutting down") {
				if time.Now().After(deadline) {
					t.Fatalf("serve never began to stop:\n%s", s.out.String())
				}
				time.Sleep(5 * time.Millisecond)
			}
			select {
			case <-s.done:
				t.Fatalf("serve exited with a write still held:\n%s", s.out.String())
			case <-time.After(200 * time.Millisecond):
			}
			s.release()
			a := <-answered
			if a.err != nil {
				t.Fatalf("the admitted write was cut off by the stop: %v", a.err)
			}
			opID, rows := commits(t, "append_note", a.reply)
			select {
			case <-s.done:
			case <-time.After(30 * time.Second):
				t.Fatalf("serve did not stop after the write finished:\n%s", s.out.String())
			}
			s.exited = true
			if !s.cmd.ProcessState.Success() {
				t.Fatalf("serve stopped with %v:\n%s", s.cmd.ProcessState, s.out.String())
			}

			s = serveBinary(t, crash, dir, addr)
			s.verified()
			uid, content := s.read(token, "log.md")
			if content != "start\none line\n" || uid != rows[0].UID {
				t.Fatalf("after the stop, uid %d reads %q; the write said uid %d", uid, content, rows[0].UID)
			}
			ops := s.audit()
			if held := keyed(ops, "append-1"); len(held) != 1 || held[0].ID != opID || len(ops) != 2 {
				t.Fatalf("after the stop the log holds %+v", ops)
			}
			again := s.mustCall(token, "append_note", args)
			if again.raw != a.reply.raw {
				t.Fatalf("the retry after a restart differs:\n%s\n%s", a.reply.raw, again.raw)
			}
		})
	}
}

// A connection that never finishes its request headers is closed after the
// server's ten seconds, on the listener /mcp shares with devices, and what it
// is sent, if anything, names nothing of the vault. From mcp-http.test.ts,
// "times out unfinished headers near ten seconds without exposing
// diagnostics".
func TestServeCutsOffUnfinishedHeaders(t *testing.T) {
	t.Parallel()
	binary := builtTrewd(t, "")
	dir, addr := t.TempDir(), fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	s := serveBinary(t, binary, dir, addr)
	token, _ := s.writeToken("agent")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	started := time.Now()
	if _, err := io.WriteString(conn, "POST /mcp HTTP/1.1\r\nHost: "+addr+"\r\nAuthorization: Bearer "+token+
		"\r\nX-Unfinished: "); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(conn)
	took := time.Since(started)
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("the connection was still open after %v", took)
	}
	if took < 9*time.Second || took > 15*time.Second {
		t.Fatalf("unfinished headers were cut off after %v, want about ten seconds", took)
	}
	if len(got) > 0 && !strings.HasPrefix(string(got), "HTTP/1.1 4") {
		t.Fatalf("an unfinished request was answered %q", got)
	}
	for _, secret := range []string{token, "default", dir, "mcp"} {
		if strings.Contains(string(got), secret) {
			t.Fatalf("the reply to an unfinished request names %q: %q", secret, got)
		}
	}
	s.stop()
}
