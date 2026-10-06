package control

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// echo answers every request with the op it was asked, so a test can see the
// request arrived whole.
type echo struct{}

func (echo) Handle(_ context.Context, req Request) Reply {
	if req.Op == "refuse" {
		return Refused(CodeBadRequest, "refused as asked")
	}
	return Reply{Canceled: &Canceled{Invite: req.Op + ":" + req.Invite}}
}

func call(t *testing.T, dir string, req Request) Reply {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	reply, err := Call(ctx, dir, req)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	return reply
}

// The socket is a socket, mode 0600, in the data directory, and answers one
// request with one reply.
func TestTheSocketIsPrivateAndAnswers(t *testing.T) {
	dir := t.TempDir()
	srv, err := Listen(dir, echo{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	info, err := os.Lstat(filepath.Join(dir, SocketName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("the control socket is %v, want a socket at mode 600", info.Mode())
	}
	if got := call(t, dir, Request{Op: "uninvite", Invite: "abc"}); got.Canceled == nil || got.Canceled.Invite != "uninvite:abc" {
		t.Fatalf("the reply was %+v", got)
	}
	if got := call(t, dir, Request{Op: "refuse"}); got.Error == nil || got.Error.Code != CodeBadRequest {
		t.Fatalf("a refusal came back as %+v", got)
	}
}

// A data directory under a path longer than a unix socket may be is ordinary,
// and still gets a socket both ends can reach: each end goes through a short
// link of its own to the same directory.
func TestALongDataDirectoryStillGetsASocket(t *testing.T) {
	dir := filepath.Join(t.TempDir(), strings.Repeat("a-rather-long-directory-name-", 4))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if n := len(filepath.Join(dir, SocketName)); n <= maxSunPath {
		t.Fatalf("the path is %d bytes, which a socket can be bound at directly; the test proves nothing", n)
	}
	srv, err := Listen(dir, echo{}, nil)
	if err != nil {
		t.Fatalf("listening under a long path: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, SocketName)); err != nil {
		t.Fatalf("the socket is not in the data directory: %v", err)
	}
	if got := call(t, dir, Request{Op: "devices"}); got.Canceled == nil || got.Canceled.Invite != "devices:" {
		t.Fatalf("the reply was %+v", got)
	}
	if err := srv.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, SocketName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("closing left the socket behind: %v", err)
	}
}

// Nobody listening is ErrNotServing, whether there is no socket at all or only
// the one a server that died left behind; and a new server replaces the stale
// one rather than failing to bind.
func TestAStaleSocketIsNotAServer(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	if _, err := Call(ctx, dir, Request{Op: "devices"}); !errors.Is(err, ErrNotServing) {
		t.Fatalf("no socket: %v, want ErrNotServing", err)
	}
	// A socket whose server is gone: bound, then closed without being
	// unlinked, which is what a killed process leaves.
	var ln net.Listener
	if err := withShortPath(dir, func(path string) error {
		var err error
		ln, err = net.Listen("unix", path)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
	if _, err := os.Lstat(filepath.Join(dir, SocketName)); err != nil {
		t.Fatalf("the stale socket is not there to test against: %v", err)
	}
	if _, err := Call(ctx, dir, Request{Op: "devices"}); !errors.Is(err, ErrNotServing) {
		t.Fatalf("a stale socket: %v, want ErrNotServing", err)
	}
	srv, err := Listen(dir, echo{}, nil)
	if err != nil {
		t.Fatalf("a new server could not replace the stale socket: %v", err)
	}
	defer srv.Close()
	if got := call(t, dir, Request{Op: "devices"}); got.Canceled == nil {
		t.Fatalf("the new server did not answer: %+v", got)
	}
}

// T45. The socket is bound and then made 0600, so with a permissive umask
// and a data directory other accounts can traverse there was a moment when
// another account could connect, and nothing afterwards asked who had: the
// operator's powers, revoke and invite and the MCP tokens among them, went to
// whoever got in. Each connection's peer is now asked who it is, and one that
// is neither this server's account nor root is refused before its request is
// read. Here the server is made to believe it runs as another account, since
// a test cannot be one.
func TestAPeerOfAnotherAccountIsRefused(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, which every server lets in")
	}
	dir := t.TempDir()
	srv, err := Listen(dir, echo{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	was := ownUID
	ownUID = func() int { return os.Geteuid() + 1 }
	defer func() { ownUID = was }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if reply, err := Call(ctx, dir, Request{Op: "devices"}); err == nil {
		t.Fatalf("a peer of another account was answered: %+v", reply)
	}
}

// A request that is not JSON, or longer than any request, is refused with a
// reply rather than a dropped connection.
func TestAMalformedRequestIsRefusedInWords(t *testing.T) {
	dir := t.TempDir()
	srv, err := Listen(dir, echo{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	for _, body := range []string{"not json\n", strings.Repeat("x", maxRequest+10) + "\n"} {
		conn, err := dialAt(context.Background(), dir)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 4096)
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, _ := conn.Read(buf)
		conn.Close()
		if !strings.Contains(string(buf[:n]), `"code":"badrequest"`) {
			t.Fatalf("a malformed request of %d bytes was answered %q", len(body), buf[:n])
		}
	}
}
