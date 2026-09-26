// Package control is the private socket `trewd serve` answers the operator
// on, and the client the administrative commands use to reach it (PLAN.md
// section 2.3.1).
//
// Credentials are mutated through the running server, never around it. A
// command that wrote SQLite directly while `serve` ran would not be joined to
// the server's commit lock, would not see its sessions, and could not close
// them, so a revoke done that way leaves the revoked device receiving notes.
// The socket carries `invite`, `devices`, `revoke` and `uninvite` to the server,
// which does each through the same code a device's request goes through: the
// same commit lock, the same eviction. It carries the MCP token commands too
// (`mcp-token`, `mcp-tokens`, `mcp-revoke`), under the same lock, the read of
// the agents' operation log (`audit`), so the log a person reads is the one
// the running server is writing, the undo of an operation in it (`undo`) and
// the restore of the vault to a uid (`restore`), each committed and broadcast
// to the devices by the server that holds the commit lock, as every other
// write is, and what `trewd doctor` asks of a running server (`status`). It
// carries the configuration file's changes too (`config-show`, `config-set`,
// `config-unset` and `git-export`), so the server that uses a setting is the
// one that checks it, writes it and takes it up.
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

// adoptTimeout bounds `trewd git-export adopt`, which fetches a branch's
// whole history from the remote while the operator waits.
const adoptTimeout = 20 * time.Minute

// Timeout is how long req may take to be answered, once asked.
func Timeout(req Request) time.Duration {
	if req.Op == "git-export" && req.Action == "adopt" {
		return adoptTimeout
	}
	return requestTimeout
}

// Request is one operation the operator asks of the running server.
type Request struct {
	// Op is "invite", "devices", "revoke", "uninvite", "mcp-token",
	// "mcp-tokens", "mcp-revoke", "audit", "undo", "restore", "status",
	// "config-show", "config-set", "config-unset" or "git-export".
	Op string `json:"op"`

	// invite and mcp-token. TTLMs is the lifetime, and Never says the
	// credential does not expire, which only the operator may ask for. URL,
	// when set, is the address the invite strings carry instead of the
	// server's own. Label names the invite, or the token and the author its
	// writes are recorded as.
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

	// mcp-token: "read", the default, or "write".
	Scope string `json:"scope,omitempty"`
	// mcp-revoke.
	TokenID string `json:"tokenId,omitempty"`

	// audit: operations committed at or after Since, in milliseconds, and
	// after the one with sequence number After, which pages.
	Since int64 `json:"since,omitempty"`
	After int64 `json:"after,omitempty"`

	// undo: the operation to undo, and whether as the copy.
	OpID   string `json:"opId,omitempty"`
	ToCopy bool   `json:"toCopy,omitempty"`

	// restore: the uid to put the vault back to, the head a dry run was
	// planned at (zero for none), and whether to commit it.
	ToUID int64 `json:"toUid,omitempty"`
	Head  int64 `json:"head,omitempty"`
	Apply bool  `json:"apply,omitempty"`

	// config-set and config-unset: the key, as section.name, and the value.
	Key   string `json:"key,omitempty"`
	Value string `json:"value,omitempty"`

	// git-export: "set", "status", "disable" or "adopt", and for set the
	// change, for adopt the commit, in internal/gitexport's shape.
	Action    string          `json:"action,omitempty"`
	GitExport json.RawMessage `json:"gitExport,omitempty"`
}

// Reply is the answer to one Request: exactly one of its parts is set, and
// Error when the request was refused.
type Reply struct {
	Error *ErrorReply `json:"error,omitempty"`

	Invited  *Invited  `json:"invited,omitempty"`
	Devices  *Devices  `json:"devices,omitempty"`
	Revoked  *Revoked  `json:"revoked,omitempty"`
	Canceled *Canceled `json:"uninvited,omitempty"`

	MCPToken   *MCPToken   `json:"mcpToken,omitempty"`
	MCPTokens  *MCPTokens  `json:"mcpTokens,omitempty"`
	MCPRevoked *MCPRevoked `json:"mcpRevoked,omitempty"`

	Audit   *Audit   `json:"audit,omitempty"`
	Undo    *Undo    `json:"undo,omitempty"`
	Restore *Restore `json:"restore,omitempty"`
	Status  *Status  `json:"status,omitempty"`

	// Config is the configuration as the server uses it, after a
	// config-show, config-set or config-unset; GitExport is the export's
	// status after a git-export. Each in its producer's shape.
	Config    json.RawMessage `json:"config,omitempty"`
	GitExport json.RawMessage `json:"gitExport,omitempty"`
}

// Restore is a restore to a uid the server planned, committed or refused. A
// dry run is a plan with Applied false; a refusal, like an undo's, is an
// answer with the store's code and reason and the paths it is about.
type Restore struct {
	Vault string `json:"vault"`
	ToUID int64  `json:"toUid"`
	// Head is the vault head the plan was made at, which a dry run's
	// `-head` names so the apply is refused if the vault moves.
	Head      int64           `json:"head"`
	Applied   bool            `json:"applied"`
	Unchanged int             `json:"unchanged"`
	Steps     json.RawMessage `json:"steps,omitempty"`

	// Applied: the restore's operation id and commit time, and the versions
	// it wrote.
	OpID        string          `json:"opId,omitempty"`
	CommittedAt int64           `json:"committedAt,omitempty"`
	Entries     json.RawMessage `json:"entries,omitempty"`

	// Refused.
	Code   string          `json:"code,omitempty"`
	Reason string          `json:"reason,omitempty"`
	Gone   json.RawMessage `json:"gone,omitempty"`
}

// Status is what a running server knows that its data directory does not:
// its version, the addresses it names in invites, what /health would answer,
// the search index's state, which devices are connected and how far each has
// applied, and its metrics. Each part is the producing package's own shape.
type Status struct {
	Vault     string          `json:"vault"`
	Version   string          `json:"version"`
	StartedAt int64           `json:"startedAt"`
	URLs      []string        `json:"urls"`
	Health    json.RawMessage `json:"health"`
	Index     json.RawMessage `json:"index,omitempty"`
	Devices   json.RawMessage `json:"devices"`
	Metrics   json.RawMessage `json:"metrics"`
	GitExport json.RawMessage `json:"gitExport,omitempty"`
}

// Undo is an undo the server did or refused. Refused is an answer, not an
// error reply: what was found (the paths changed since and who changed them,
// the before-images a purge took) is what the operator acts on, and it travels
// in the store's shapes, as the audit's operations do.
type Undo struct {
	Vault  string `json:"vault"`
	Undoes string `json:"undoes"`
	ToCopy bool   `json:"toCopy"`
	// Target is the operation undone, as the log records it, when there is
	// one by that id.
	Target json.RawMessage `json:"target,omitempty"`

	// Committed, with the undo's own operation id and commit time, what each
	// step did and the versions it wrote.
	Committed   bool            `json:"committed"`
	OpID        string          `json:"opId,omitempty"`
	CommittedAt int64           `json:"committedAt,omitempty"`
	Steps       json.RawMessage `json:"steps,omitempty"`
	Entries     json.RawMessage `json:"entries,omitempty"`

	// Refused: the store's code and reason, and the paths it is about.
	Code    string          `json:"code,omitempty"`
	Reason  string          `json:"reason,omitempty"`
	Changed json.RawMessage `json:"changed,omitempty"`
	Gone    json.RawMessage `json:"gone,omitempty"`
}

// Audit is one page of a vault's operation log, in the store's shape, the
// vault's epoch beside it so an operation from before a restore can be told
// apart, and whether there is more after it.
type Audit struct {
	Operations json.RawMessage `json:"operations"`
	More       bool            `json:"more"`
	Vault      string          `json:"vault"`
	Epoch      string          `json:"epoch"`
}

// MCPToken is a minted MCP token: the listing row and, once, the token itself.
// The token reaches nothing but the operator who asked, over this socket.
type MCPToken struct {
	Token json.RawMessage `json:"token"` // the listing row, in the store's shape
	// Secret is the bearer credential, 43 characters of base64url.
	Secret string `json:"secret"`
	Vault  string `json:"vault"`
}

// MCPTokens is a vault's MCP tokens, in the store's listing shape.
type MCPTokens struct {
	Tokens json.RawMessage `json:"tokens"`
	Vault  string          `json:"vault"`
}

// MCPRevoked is an MCP token taken off the vault.
type MCPRevoked struct {
	TokenID string `json:"tokenId"`
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
	CodeNoToken    = "notoken"
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
		t := Timeout(req)
		_ = conn.SetDeadline(time.Now().Add(t))
		ctx, cancel := context.WithTimeout(context.Background(), t)
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
