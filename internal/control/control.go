// Package control is the private socket `trew serve` answers the operator
// on, and the client the administrative commands use to reach it (PLAN.md
// section 2.3.1).
//
// Credentials are mutated through the running server, never around it. A
// command that wrote SQLite directly while `serve` ran would not be joined to
// the server's commit lock, would not see its sessions, and could not close
// them, so a revoke done that way leaves the revoked device receiving notes.
// The socket carries `invite`, `devices`, `revoke` and `uninvite` to the server,
// which does each through the same code a device's request goes through: the
// same commit lock, the same eviction.
//
// The socket is a unix socket in the data directory, mode 0600, so whoever can
// reach it can already read the database beside it: the socket is not a new
// authority, only the right way to use the one the file system gives. Each
// connection carries one request and one reply, a line of JSON each way.
package control

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SocketName is the socket's name inside the data directory.
const SocketName = "control.sock"

// maxRequest bounds one request line. Every request is a few hundred bytes.
const maxRequest = 64 << 10

// requestTimeout bounds how long one connection may take to ask and be
// answered, so a client that connects and says nothing does not hold a
// goroutine for ever.
const requestTimeout = 30 * time.Second

// Request is one operation the operator asks of the running server.
type Request struct {
	// Op is "invite", "devices", "revoke" or "uninvite".
	Op string `json:"op"`

	// invite. TTLMs is the lifetime, and Never says the invite does not
	// expire, which only the operator may ask for. URL, when set, is the
	// address the invite strings carry instead of the server's own.
	TTLMs int64  `json:"ttlMs,omitempty"`
	Never bool   `json:"never,omitempty"`
	Label string `json:"label,omitempty"`
	URL   string `json:"url,omitempty"`

	// Vault, when set, is the vault the operator means, and a server serving
	// another refuses rather than acting on the wrong one.
	Vault string `json:"vault,omitempty"`

	// revoke.
	DeviceID string `json:"deviceId,omitempty"`
	// uninvite.
	Invite string `json:"invite,omitempty"`
}

// Reply is the answer to one Request: exactly one of its parts is set, and
// Error when the request was refused.
type Reply struct {
	Error *ErrorReply `json:"error,omitempty"`

	Invited  *Invited  `json:"invited,omitempty"`
	Devices  *Devices  `json:"devices,omitempty"`
	Revoked  *Revoked  `json:"revoked,omitempty"`
	Canceled *Canceled `json:"uninvited,omitempty"`
}

// ErrorReply is a refused request: a code a script can match and a message a
// person can act on.
type ErrorReply struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

// Invited is a minted invite: its id, when it stops working (nil for never),
// the vault, and one invite string per address the server knows itself by.
// The strings are the credential, and reach nothing but the operator who
// asked.
type Invited struct {
	Invite    string   `json:"invite"`
	ExpiresAt *int64   `json:"expiresAt"`
	Vault     string   `json:"vault"`
	Strings   []string `json:"strings"`
}

// Devices is the device list and the outstanding invites, in the shapes the
// wire's `devices` reply carries them (json.RawMessage so this package does not
// depend on the wire's types).
type Devices struct {
	Devices json.RawMessage `json:"devices"`
	Invites json.RawMessage `json:"invites"`
}

// Revoked is a device taken off the vault, how many of its connections were
// closed, and how many invites it had issued were cancelled with it.
type Revoked struct {
	DeviceID         string `json:"deviceId"`
	Closed           int    `json:"closed"`
	InvitesCancelled int    `json:"invitesCancelled"`
}

// Canceled is an invite retired by its id.
type Canceled struct {
	Invite string `json:"invite"`
}

// Handler answers requests. The server implements it, so this package knows
// nothing of sessions, stores or commit locks, only of the protocol.
type Handler interface {
	Handle(ctx context.Context, req Request) Reply
}

// Refused builds the reply to a request that was not done.
func Refused(code, msg string) Reply { return Reply{Error: &ErrorReply{Code: code, Msg: msg}} }

// The codes a refusal carries.
const (
	CodeBadRequest = "badrequest"
	CodeNoDevice   = "nodevice"
	CodeNoInvite   = "noinvite"
	CodeInternal   = "internal"
)

// Server is the listening socket.
type Server struct {
	ln   net.Listener
	path string
	log  *slog.Logger
	h    Handler
	wg   sync.WaitGroup

	mu     sync.Mutex
	closed bool
}

// Listen binds the socket in dataDir, mode 0600, removing a stale one first.
//
// Stale means left by a server that died: the caller holds the server lock,
// which is what makes it this directory's only server, so no other process can
// be answering on the socket being removed.
func Listen(dataDir string, h Handler, log *slog.Logger) (*Server, error) {
	if log == nil {
		log = slog.Default()
	}
	path := filepath.Join(dataDir, SocketName)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("removing a stale control socket at %s: %w", path, err)
	}
	ln, err := listenAt(dataDir)
	if err != nil {
		return nil, err
	}
	// The mode is set on the file the bind made and then read back, rather
	// than trusted to the umask: a socket anybody could connect to would be
	// the operator's powers handed to every account on the machine.
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("making the control socket private: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		ln.Close()
		return nil, fmt.Errorf("reading back the control socket: %w", err)
	}
	if info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSocket == 0 {
		ln.Close()
		return nil, fmt.Errorf("the control socket at %s is %v, not a private socket", path, info.Mode())
	}
	s := &Server{ln: ln, path: path, log: log, h: h}
	s.wg.Add(1)
	go s.serve()
	return s, nil
}

// Path is where the socket is.
func (s *Server) Path() string { return s.path }

// Close stops accepting, waits for requests in flight, and removes the socket.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	err := s.ln.Close()
	s.wg.Wait()
	if rerr := os.Remove(s.path); rerr != nil && !errors.Is(rerr, os.ErrNotExist) && err == nil {
		err = rerr
	}
	return err
}

func (s *Server) serve() {
	defer s.wg.Done()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				s.log.Warn("the control socket stopped accepting", "err", err)
			}
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.answer(conn)
		}()
	}
}

// answer reads one request and writes one reply.
func (s *Server) answer(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(requestTimeout))
	line, err := bufio.NewReader(io.LimitReader(conn, maxRequest+1)).ReadBytes('\n')
	var reply Reply
	var req Request
	switch {
	case len(line) > maxRequest:
		reply = Refused(CodeBadRequest, "the request is longer than any request")
	case err != nil && len(line) == 0:
		// Connected and said nothing: there is nobody to answer.
		return
	default:
		if err := json.Unmarshal(line, &req); err != nil {
			reply = Refused(CodeBadRequest, "the request is not JSON: "+err.Error())
			break
		}
		ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
		reply = s.h.Handle(ctx, req)
		cancel()
		s.log.Info("control request", "op", req.Op, "refused", reply.Error != nil)
	}
	b, err := json.Marshal(reply)
	if err != nil {
		b, _ = json.Marshal(Refused(CodeInternal, err.Error()))
	}
	_, _ = conn.Write(append(b, '\n'))
}

// ErrNotServing is Call's answer when no server is listening on the socket:
// the command may then act on the store itself, under an exclusive lock.
var ErrNotServing = errors.New("no server is answering on the control socket")

// Call sends one request to the server serving dataDir and returns its reply.
// ErrNotServing means there was nobody to ask.
func Call(ctx context.Context, dataDir string, req Request) (Reply, error) {
	conn, err := dialAt(ctx, dataDir)
	if err != nil {
		return Reply{}, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(requestTimeout))
	}
	b, err := json.Marshal(req)
	if err != nil {
		return Reply{}, err
	}
	if _, err := conn.Write(append(b, '\n')); err != nil {
		return Reply{}, fmt.Errorf("asking the server: %w", err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return Reply{}, fmt.Errorf("reading the server's answer: %w", err)
	}
	var reply Reply
	if err := json.Unmarshal(line, &reply); err != nil {
		return Reply{}, fmt.Errorf("the server's answer is not JSON: %w", err)
	}
	return reply, nil
}
