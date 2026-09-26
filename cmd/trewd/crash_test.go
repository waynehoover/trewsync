package main

// A real trewd killed inside an agent's write, and a real trewd whose storage
// fails inside one (PLAN.md M5 task 9 and its done-when), against the built
// binary rather than run() in this process: a SIGKILL has to take a process
// away, and this test's process has to survive it to make the assertions.
//
// The whole crash matrix, every tool at every seam with a freshly paired
// headless client as the witness, is client/src/stress/mcp-crash.stress.ts.
// What is here is what `go test ./...` should hold on its own: that the hold
// the matrix kills the server at exists only in a build made for it, that a
// kill after an append resolves on retry into exactly one result, and that a
// storage error anywhere in a write leaves nothing of it committed.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/mcp"
)

// seamMark is the line testseam.go writes when a write reaches its seam,
// followed by the seam's name. Spelt out here because that file is not in
// this build.
const seamMark = "trewd test seam: holding at "

// builtTrewd is trewd built as a release builds it (scripts/release.sh, the
// Dockerfile), with tags added, into a directory of the test's own.
func builtTrewd(t *testing.T, tags string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "trewd")
	args := []string{"build", "-trimpath", "-ldflags", "-s -w"}
	if tags != "" {
		args = append(args, "-tags", tags)
	}
	cmd := exec.Command("go", append(args, "-o", out, "./cmd/trewd")...)
	cmd.Dir = filepath.Join("..", "..")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building trewd with tags %q: %v\n%s", tags, err, b)
	}
	return out
}

// served is one `trewd serve -mcp` process: its output, the pipe to its
// stdin, which a held write reads, and how it ended.
type served struct {
	t         *testing.T
	binary    string
	dir, addr string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	out       *safeBuffer
	done      chan struct{}
	exited    bool
	// held is how many writes holdAt has seen held.
	held int
}

// serveBinary starts binary on dir at addr, with env added to this process's
// environment less any TREW_TEST_SEAM of its own, and waits for it to answer.
func serveBinary(t *testing.T, binary, dir, addr string, env ...string) *served {
	t.Helper()
	s := &served{t: t, binary: binary, dir: dir, addr: addr, out: &safeBuffer{}, done: make(chan struct{})}
	s.cmd = exec.Command(binary, "serve", "-data", dir, "-addr", addr, "-url", "ws://"+addr, "-mcp", "-allow-ephemeral")
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "TREW_TEST_SEAM=") {
			s.cmd.Env = append(s.cmd.Env, kv)
		}
	}
	s.cmd.Env = append(s.cmd.Env, env...)
	s.cmd.Stdout, s.cmd.Stderr = s.out, s.out
	stdin, err := s.cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	s.stdin = stdin
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = s.cmd.Wait()
		close(s.done)
	}()
	t.Cleanup(func() {
		if !s.exited {
			_ = s.cmd.Process.Kill()
			<-s.done
		}
		if t.Failed() {
			t.Logf("trewd on %s said:\n%s", addr, s.out.String())
		}
	})
	deadline := time.Now().Add(30 * time.Second)
	for {
		if resp, err := http.Get("http://" + addr + "/health"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return s
			}
		}
		select {
		case <-s.done:
			s.exited = true
			t.Fatalf("trewd exited before it answered:\n%s", s.out.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("trewd never answered on %s:\n%s", addr, s.out.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// holdAt waits for the next write to reach the seam point and be held there.
func (s *served) holdAt(point string) {
	s.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for strings.Count(s.out.String(), seamMark+point+"\n") <= s.held {
		if time.Now().After(deadline) {
			s.t.Fatalf("no write reached the %s seam:\n%s", point, s.out.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.held++
}

// release lets the held write go on.
func (s *served) release() {
	s.t.Helper()
	if _, err := io.WriteString(s.stdin, "go\n"); err != nil {
		s.t.Fatal(err)
	}
}

// kill takes the process away without asking, as a power cut or the OOM
// killer does, and checks that SIGKILL is what ended it.
func (s *served) kill() {
	s.t.Helper()
	if err := s.cmd.Process.Signal(syscall.SIGKILL); err != nil {
		s.t.Fatal(err)
	}
	<-s.done
	s.exited = true
	ws, ok := s.cmd.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() || ws.Signal() != syscall.SIGKILL {
		s.t.Fatalf("trewd ended with %v, not by SIGKILL", s.cmd.ProcessState)
	}
}

// stop asks the process to stop, and requires a clean exit.
func (s *served) stop() {
	s.t.Helper()
	if err := s.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		s.t.Fatal(err)
	}
	select {
	case <-s.done:
	case <-time.After(30 * time.Second):
		s.t.Fatalf("trewd did not stop:\n%s", s.out.String())
	}
	s.exited = true
	if !s.cmd.ProcessState.Success() {
		s.t.Fatalf("trewd stopped with %v:\n%s", s.cmd.ProcessState, s.out.String())
	}
}

// cli runs one of the binary's commands on the data directory, through the
// running server's control socket where it has one, and fails the test when
// the command does.
func (s *served) cli(command string, args ...string) string {
	s.t.Helper()
	out, err := exec.Command(s.binary, append([]string{command, "-data", s.dir}, args...)...).CombinedOutput()
	if err != nil {
		s.t.Fatalf("trewd %s %s: %v\n%s", command, strings.Join(args, " "), err, out)
	}
	return string(out)
}

var mintedID = regexp.MustCompile(`Id ([A-Za-z0-9_-]+), fingerprint`)

// writeToken mints a write token labelled label through the running server,
// and returns its bearer string and its id.
func (s *served) writeToken(label string) (token, id string) {
	s.t.Helper()
	keyFile := filepath.Join(s.t.TempDir(), "agent.key")
	out := s.cli("mcp-token", "-label", label, "-scope", "write", "-key-out", keyFile)
	m := mintedID.FindStringSubmatch(out)
	key, err := os.ReadFile(keyFile)
	if err != nil || m == nil {
		s.t.Fatalf("mcp-token: %v\n%s", err, out)
	}
	return strings.TrimSpace(string(key)), m[1]
}

// toolReply is a tools/call's result: the envelope exactly as the reply
// carried it, and its halves.
type toolReply struct {
	raw       string
	isError   bool
	trusted   map[string]any
	untrusted map[string]any
}

// call makes one tools/call over HTTP, stateless at 2025-11-25, and returns
// an error when no reply came, which is how a killed server answers.
func (s *served) call(token, tool string, args map[string]any) (toolReply, error) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": args}})
	if err != nil {
		return toolReply{}, err
	}
	req, err := http.NewRequest(http.MethodPost, "http://"+s.addr+"/mcp", bytes.NewReader(body))
	if err != nil {
		return toolReply{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return toolReply{}, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return toolReply{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return toolReply{}, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}
	var frame struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(b, &frame); err != nil || len(frame.Result.Content) != 1 {
		return toolReply{}, fmt.Errorf("not a tool result: %v %s", err, b)
	}
	r := toolReply{raw: frame.Result.Content[0].Text, isError: frame.Result.IsError}
	var env struct {
		Trusted   map[string]any `json:"trusted"`
		Untrusted map[string]any `json:"untrusted_content"`
	}
	if err := json.Unmarshal([]byte(r.raw), &env); err != nil {
		return toolReply{}, err
	}
	r.trusted, r.untrusted = env.Trusted, env.Untrusted
	return r, nil
}

func (s *served) mustCall(token, tool string, args map[string]any) toolReply {
	s.t.Helper()
	r, err := s.call(token, tool, args)
	if err != nil {
		s.t.Fatalf("%s: %v", tool, err)
	}
	return r
}

// committedRow is one path a committed write names.
type committedRow struct {
	Path        string `json:"path"`
	UID         int64  `json:"uid"`
	PreviousUID *int64 `json:"previousUid"`
}

// commits is the committed result r must be: its operation id and rows.
func commits(t *testing.T, tool string, r toolReply) (opID string, rows []committedRow) {
	t.Helper()
	if r.isError || r.trusted["committed"] != true {
		t.Fatalf("%s did not commit: %s", tool, r.raw)
	}
	b, _ := json.Marshal(r.untrusted["entries"])
	if err := json.Unmarshal(b, &rows); err != nil || len(rows) == 0 {
		t.Fatalf("%s named no entries: %s", tool, r.raw)
	}
	opID, _ = r.trusted["opId"].(string)
	return opID, rows
}

// refusal is the error code of r, which must say it committed nothing.
func refusal(t *testing.T, tool string, r toolReply) string {
	t.Helper()
	if !r.isError || r.trusted["committed"] != false {
		t.Fatalf("%s was not refused with nothing written: %s", tool, r.raw)
	}
	e, _ := r.trusted["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

// auditOp is an operation as `trewd audit -json` lists it.
type auditOp struct {
	ID             string `json:"id"`
	Tool           string `json:"tool"`
	Outcome        string `json:"outcome"`
	IdempotencyKey string `json:"idempotencyKey"`
	Paths          []struct {
		Path     string `json:"path"`
		AfterUID int64  `json:"afterUid"`
	} `json:"paths"`
}

// audit is every operation the store recorded, through the running server.
func (s *served) audit() []auditOp {
	s.t.Helper()
	var out struct {
		Operations []auditOp `json:"operations"`
	}
	if err := json.Unmarshal([]byte(s.cli("audit", "-json")), &out); err != nil {
		s.t.Fatal(err)
	}
	return out.Operations
}

func keyed(ops []auditOp, key string) []auditOp {
	var out []auditOp
	for _, o := range ops {
		if o.IdempotencyKey == key {
			out = append(out, o)
		}
	}
	return out
}

// verified requires `trewd verify -deep` to pass: every entry's every body
// present and matching its name, which is what a dangling entry fails.
func (s *served) verified() {
	s.t.Helper()
	out := s.cli("verify", "-deep")
	if !strings.Contains(out, " 0 faults") {
		s.t.Fatalf("verify -deep: %s", out)
	}
}

// read is a note's head as read_note gives it: its uid and its bytes.
func (s *served) read(token, path string) (uid int64, content string) {
	s.t.Helper()
	r := s.mustCall(token, "read_note", map[string]any{"path": path, "maxLines": 1000})
	if r.isError {
		s.t.Fatalf("read_note %s: %s", path, r.raw)
	}
	n, _ := r.trusted["uid"].(float64)
	c, _ := r.untrusted["content"].(string)
	return int64(n), c
}

// Only a trewd built with the crashmatrix tag can be held at a seam. A
// release build holds no trace of the variable that arms it, and with the
// variable set it writes straight through; the tagged build, given the same
// variable, holds the same write, so the first half is not looking at a
// binary that could never have held anything. Nothing a request carries
// reaches the seam in either: the variable is read once, when the process
// starts.
func TestAProductionBuildHasNoTestSeam(t *testing.T) {
	if testSeam != nil {
		t.Fatal("this test binary was built with the seam set")
	}
	prod := builtTrewd(t, "")
	crash := builtTrewd(t, "crashmatrix")
	for _, b := range []struct {
		path string
		has  bool
	}{{prod, false}, {crash, true}} {
		bin, err := os.ReadFile(b.path)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range []string{"TREW_TEST_SEAM", seamMark} {
			if bytes.Contains(bin, []byte(s)) != b.has {
				t.Fatalf("%s holds %q: %v, want %v", b.path, s, !b.has, b.has)
			}
		}
	}

	arm := "TREW_TEST_SEAM=" + mcp.SeamCommitted
	s := serveBinary(t, prod, t.TempDir(), fmt.Sprintf("127.0.0.1:%d", freeTestPort(t)), arm)
	token, _ := s.writeToken("agent")
	commits(t, "create_note", s.mustCall(token, "create_note", map[string]any{"path": "n.md", "content": "through\n"}))
	if _, content := s.read(token, "n.md"); content != "through\n" || strings.Contains(s.out.String(), seamMark) {
		t.Fatalf("the release build with %s: %q\n%s", arm, content, s.out.String())
	}
	s.stop()

	c := serveBinary(t, crash, t.TempDir(), fmt.Sprintf("127.0.0.1:%d", freeTestPort(t)), arm)
	token, _ = c.writeToken("agent")
	replied := make(chan error, 1)
	go func() {
		_, err := c.call(token, "create_note", map[string]any{"path": "n.md", "content": "held\n"})
		replied <- err
	}()
	c.holdAt(mcp.SeamCommitted)
	select {
	case err := <-replied:
		t.Fatalf("the held write replied: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	c.kill()
	if err := <-replied; err == nil {
		t.Fatal("a killed server replied")
	}
}

// SIGKILL around an append, restart on the same directory, retry with the
// same key (PLAN.md M5 done-when: "SIGKILL after append yields exactly one
// discoverable result on retry"). Before the commit the version is absent and
// the retry commits it; after, it is present with every body, and the retry
// is its recorded reply, the same bytes each time; either way one operation
// holds the key, lookup_operation finds it, and the line is in the note
// exactly once.
func TestAKillAroundAnAppendResolvesOnRetryToOneResult(t *testing.T) {
	crash := builtTrewd(t, "crashmatrix")
	for _, c := range []struct {
		seam      string
		committed bool
	}{{mcp.SeamBodies, false}, {mcp.SeamCommitted, true}, {mcp.SeamBroadcast, true}} {
		t.Run(c.seam, func(t *testing.T) {
			dir, addr := t.TempDir(), fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
			s := serveBinary(t, crash, dir, addr)
			token, _ := s.writeToken("agent")
			created := s.mustCall(token, "create_note", map[string]any{"path": "log.md", "content": "start\n"})
			_, rows := commits(t, "create_note", created)
			base, epoch := rows[0].UID, created.trusted["epoch"]
			s.stop()

			s = serveBinary(t, crash, dir, addr, "TREW_TEST_SEAM="+c.seam)
			args := map[string]any{"path": "log.md", "base": base, "epoch": epoch, "text": "one line\n",
				"idempotencyKey": "append-1"}
			replied := make(chan error, 1)
			go func() {
				_, err := s.call(token, "append_note", args)
				replied <- err
			}()
			s.holdAt(c.seam)
			s.kill()
			if err := <-replied; err == nil {
				t.Fatal("the agent heard from a server killed before its reply")
			}

			s = serveBinary(t, crash, dir, addr)
			s.verified()
			ops := s.audit()
			held := keyed(ops, "append-1")
			uid, content := s.read(token, "log.md")
			switch {
			case c.committed && (len(held) != 1 || len(held[0].Paths) != 1 || held[0].Paths[0].AfterUID != uid ||
				content != "start\none line\n"):
				t.Fatalf("after a kill past the commit: %+v, uid %d reads %q", ops, uid, content)
			case !c.committed && (len(held) != 0 || uid != base || content != "start\n"):
				t.Fatalf("after a kill before the commit: %+v, uid %d reads %q", ops, uid, content)
			case len(ops) != 1+len(held):
				t.Fatalf("the log holds %d operations: %+v", len(ops), ops)
			}

			first := s.mustCall(token, "append_note", args)
			again := s.mustCall(token, "append_note", args)
			opID, rows := commits(t, "append_note", first)
			if first.raw != again.raw {
				t.Fatalf("two retries of one request differ:\n%s\n%s", first.raw, again.raw)
			}
			uid, content = s.read(token, "log.md")
			if rows[0].UID != uid || content != "start\none line\n" || (c.committed && opID != held[0].ID) {
				t.Fatalf("the retry: %s, and uid %d reads %q", first.raw, uid, content)
			}
			ops = s.audit()
			if held = keyed(ops, "append-1"); len(held) != 1 || held[0].ID != opID || len(ops) != 2 {
				t.Fatalf("after the retries the log holds %+v", ops)
			}
			look := s.mustCall(token, "lookup_operation", map[string]any{"opId": opID})
			paths, _ := look.untrusted["paths"].([]any)
			if look.trusted["found"] != true || look.trusted["outcome"] != "committed" || len(paths) != 1 ||
				paths[0].(map[string]any)["afterUid"] != float64(uid) {
				t.Fatalf("lookup_operation %s: %s", opID, look.raw)
			}
			// Without the key, the same request is a new one, and the base it
			// names has moved: refused, never applied a second time.
			delete(args, "idempotencyKey")
			if code := refusal(t, "append_note", s.mustCall(token, "append_note", args)); code != "stale" {
				t.Fatalf("a retry without the key: %s", code)
			}
			if _, content := s.read(token, "log.md"); content != "start\none line\n" {
				t.Fatalf("the note reads %q", content)
			}
		})
	}
}

// What loses at the commit boundary loses whole, end to end (PLAN.md M5
// done-when): an agent's write held at SeamBodies, prepared and its bodies
// stored, while a device changes the vault or the operator revokes the
// token, and then let go. A slot of several that has moved, a new backlink, a
// changed namespace and a revoked actor each leave zero entries of the
// operation committed: the vault's head is the device's last write, no path
// the operation named has moved, and the log holds nothing. What the device
// wrote is intact, and a fresh preview then applies over it.
//
// Through the tools, a preview's apply is bound to the preview's head, which
// is what refuses it first when one of its slots moves (plan_changed); the
// store's check of each slot's base, behind it, has its unit test
// (TestOneStaleSlotAmongSeveralCommitsNothing). A create has no preview, so
// its second slot, the note after the folder it needs, is refused by that
// check itself.
func TestAWriteThatLosesAtItsCommitCommitsNothingEndToEnd(t *testing.T) {
	crash := builtTrewd(t, "crashmatrix")
	type world struct {
		s              *served
		token, tokenID string
		reader         string
		dev            *device
		heads          map[string]int64
		last           int64
		epoch          any
		previewed      bool
		tool           string
		args           map[string]any
		deviceWrote    map[string]string
		wouldWrite     []string
		wouldCreate    []string
	}
	put := func(w *world, path, text string) {
		uid, err := w.dev.put(path, text, w.heads[path])
		if err != nil {
			t.Fatalf("the device's put of %s: %v", path, err)
		}
		w.heads[path], w.last = uid, uid
		w.deviceWrote[path] = text
	}
	// preview previews tool with args and sets the apply as the call.
	preview := func(w *world, tool string, args map[string]any) {
		p := w.s.mustCall(w.token, tool, args)
		if p.isError || p.trusted["phase"] != "preview" {
			t.Fatalf("%s's preview: %s", tool, p.raw)
		}
		apply := map[string]any{"changes": p.untrusted["changes"], "head": p.trusted["head"], "epoch": p.trusted["epoch"]}
		for k, v := range args {
			apply[k] = v
		}
		w.tool, w.args, w.previewed = tool, apply, true
	}
	moveTopic := func(w *world) {
		preview(w, "move_note", map[string]any{"path": "topic.md", "base": w.heads["topic.md"], "to": "subject.md",
			"epoch": w.epoch, "idempotencyKey": "move-1"})
		w.wouldWrite, w.wouldCreate = []string{"topic.md", "one.md"}, []string{"subject.md"}
	}
	for _, c := range []struct {
		name      string
		seed      map[string]string
		write     func(w *world)
		meanwhile func(w *world)
		code      string
	}{
		{
			name: "one slot of three has moved",
			seed: map[string]string{"a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n"},
			write: func(w *world) {
				preview(w, "add_tags", map[string]any{"paths": []any{"a.md", "b.md", "c.md"}, "tags": []any{"held"},
					"idempotencyKey": "tags-1"})
				w.wouldWrite = []string{"a.md", "b.md", "c.md"}
			},
			meanwhile: func(w *world) { put(w, "b.md", "beta, as the phone has it now\n") },
			code:      "plan_changed",
		},
		{
			name: "the second of two slots has moved",
			seed: map[string]string{"elsewhere.md": "unrelated\n"},
			write: func(w *world) {
				w.tool, w.args = "create_note", map[string]any{"path": "notes/new.md", "content": "the agent's\n",
					"epoch": w.epoch, "idempotencyKey": "create-1"}
				w.wouldCreate = []string{"notes"}
			},
			meanwhile: func(w *world) { put(w, "notes/new.md", "the phone's\n") },
			code:      "exists",
		},
		{
			name:      "a new backlink",
			seed:      map[string]string{"topic.md": "# Topic\n", "one.md": "see [[topic]]\n"},
			write:     moveTopic,
			meanwhile: func(w *world) { put(w, "three.md", "a backlink in the last moment: [[topic]]\n") },
			code:      "plan_changed",
		},
		{
			name:      "a changed namespace",
			seed:      map[string]string{"topic.md": "# Topic\n", "one.md": "see [[topic]]\n"},
			write:     moveTopic,
			meanwhile: func(w *world) { put(w, "elsewhere/topic.md", "a second topic, so [[topic]] means two notes\n") },
			code:      "plan_changed",
		},
		{
			name: "a revoked actor",
			seed: map[string]string{"n.md": "before\n"},
			write: func(w *world) {
				w.tool, w.args = "append_note", map[string]any{"path": "n.md", "base": w.heads["n.md"], "epoch": w.epoch,
					"text": "after\n", "idempotencyKey": "append-1"}
				w.wouldWrite = []string{"n.md"}
			},
			meanwhile: func(w *world) { w.s.cli("mcp-token", "-revoke", w.tokenID) },
			code:      "401",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir, addr := t.TempDir(), fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
			w := &world{heads: map[string]int64{}, deviceWrote: map[string]string{}}
			w.s = serveBinary(t, crash, dir, addr, "TREW_TEST_SEAM="+mcp.SeamBodies)
			w.token, w.tokenID = w.s.writeToken("agent")
			keyFile := filepath.Join(t.TempDir(), "observer.key")
			w.s.cli("mcp-token", "-label", "observer", "-key-out", keyFile)
			key, err := os.ReadFile(keyFile)
			if err != nil {
				t.Fatal(err)
			}
			w.reader = strings.TrimSpace(string(key))
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			dialFirstDevice(t, "ws://"+addr, readFirstInvite(t, dir)).conn.CloseNow()
			if w.dev, err = connectDevice(ctx, addr); err != nil {
				t.Fatal(err)
			}
			defer w.dev.conn.CloseNow()
			for path, text := range c.seed {
				put(w, path, text)
			}
			w.deviceWrote = map[string]string{} // what it writes while the agent's write is held
			w.epoch = w.s.mustCall(w.reader, "vault_status", nil).trusted["epoch"]
			c.write(w)

			type answer struct {
				r   toolReply
				err error
			}
			replied := make(chan answer, 1)
			go func() {
				r, err := w.s.call(w.token, w.tool, w.args)
				replied <- answer{r, err}
			}()
			w.s.holdAt(mcp.SeamBodies)
			c.meanwhile(w)
			w.s.release()
			got := <-replied
			switch {
			case c.code == "401":
				if got.err == nil || !strings.Contains(got.err.Error(), "HTTP 401") {
					t.Fatalf("a write revoked while held: %v %s", got.err, got.r.raw)
				}
			case got.err != nil:
				t.Fatal(got.err)
			default:
				if code := refusal(t, w.tool, got.r); code != c.code {
					t.Fatalf("refused with %s, want %s: %s", code, c.code, got.r.raw)
				}
			}

			// Zero entries of the operation: the head is the device's last
			// write, every path the operation named is where it was, and the
			// log is empty.
			if head := w.s.mustCall(w.reader, "vault_status", nil).trusted["head"]; head != float64(w.last) {
				t.Fatalf("the vault's head is %v, and the device's last write was %d", head, w.last)
			}
			for _, p := range w.wouldWrite {
				if uid, _ := w.s.read(w.reader, p); uid != w.heads[p] {
					t.Fatalf("%s is at uid %d, want %d", p, uid, w.heads[p])
				}
			}
			for _, p := range w.wouldCreate {
				h := w.s.mustCall(w.reader, "note_history", map[string]any{"path": p})
				if versions, _ := h.untrusted["versions"].([]any); len(versions) != 0 {
					t.Fatalf("%s has a history: %s", p, h.raw)
				}
			}
			for p, text := range w.deviceWrote {
				if _, content := w.s.read(w.reader, p); content != text {
					t.Fatalf("the device's %s reads %q, want %q", p, content, text)
				}
			}
			if ops := w.s.audit(); len(ops) != 0 {
				t.Fatalf("the log holds %+v", ops)
			}
			w.s.verified()

			if c.code == "401" {
				// A revoke is proven by the credential's next write failing,
				// not by the reply to the one it caught (PLAN.md section 7).
				if _, err := w.s.call(w.token, "create_note", map[string]any{"path": "later.md", "content": "x"}); err == nil ||
					!strings.Contains(err.Error(), "HTTP 401") {
					t.Fatalf("a later write from the revoked token: %v", err)
				}
				return
			}
			// The same request, prepared again over what the device wrote,
			// commits: released at the seam this time, and the device's
			// bytes are in what it writes or beside it.
			if w.previewed {
				args := map[string]any{}
				for k, v := range w.args {
					if k != "changes" && k != "head" && k != "epoch" && k != "idempotencyKey" {
						args[k] = v
					}
				}
				if base, ok := args["base"]; ok && base != nil {
					args["epoch"] = w.epoch
				}
				preview(w, w.tool, args)
				go func() {
					r, err := w.s.call(w.token, w.tool, w.args)
					replied <- answer{r, err}
				}()
				w.s.holdAt(mcp.SeamBodies)
				w.s.release()
				got = <-replied
				if got.err != nil {
					t.Fatal(got.err)
				}
				commits(t, w.tool, got.r)
				for p, text := range w.deviceWrote {
					// Up to its first link, which the move may rewrite.
					words, _, _ := strings.Cut(strings.TrimSuffix(text, "\n"), "[[")
					if _, content := w.s.read(w.reader, p); !strings.Contains(content, words) {
						t.Fatalf("after the retry %s reads %q, which lost the device's %q", p, content, text)
					}
				}
			}
		})
	}
}

// A storage error anywhere in an agent's write leaves nothing of it
// committed, end to end through the tools of a real server (PLAN.md M5
// done-when): the chunk store refusing a body, a statement inside the
// operation's transaction failing after its entries are written, and the
// COMMIT itself failing, which is an unknown outcome and never a refusal. A
// tag batch over three notes each time, so "nothing" is three heads unmoved;
// and after the fault is gone the same request, with the same key, commits
// once.
func TestAStorageErrorInAWriteCommitsNothingEndToEnd(t *testing.T) {
	prod := builtTrewd(t, "")
	paths := []string{"a.md", "b.md", "c.md"}
	for _, c := range []struct {
		name    string
		fault   func(t *testing.T, dir string) (undo func(t *testing.T, dir string))
		stopped bool
		code    string
	}{
		{"the chunk store refuses a body", readOnlyChunks, false, "internal"},
		{"a statement in the transaction fails", failingPins, true, "internal"},
		{"the commit fails", failingCommit, true, "outcome_unknown"},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir, addr := t.TempDir(), fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
			s := serveBinary(t, prod, dir, addr)
			token, _ := s.writeToken("agent")
			heads := map[string]int64{}
			for _, p := range paths {
				_, rows := commits(t, "create_note", s.mustCall(token, "create_note",
					map[string]any{"path": p, "content": "# " + p + "\n\nbody of " + p + "\n"}))
				heads[p] = rows[0].UID
			}
			tagArgs := map[string]any{"paths": []any{"a.md", "b.md", "c.md"}, "tags": []any{"stored"},
				"idempotencyKey": "tags-1"}
			preview := s.mustCall(token, "add_tags", tagArgs)
			if preview.isError || preview.trusted["phase"] != "preview" {
				t.Fatalf("the preview: %s", preview.raw)
			}
			applyArgs := map[string]any{"changes": preview.untrusted["changes"], "head": preview.trusted["head"],
				"epoch": preview.trusted["epoch"]}
			for k, v := range tagArgs {
				applyArgs[k] = v
			}
			if c.stopped {
				s.stop()
			}
			undo := c.fault(t, dir)
			if c.stopped {
				s = serveBinary(t, prod, dir, addr)
			}

			failed := s.mustCall(token, "add_tags", applyArgs)
			if c.code == "outcome_unknown" {
				if !failed.isError || failed.trusted["committed"] != "unknown" || failed.trusted["idempotencyKey"] != "tags-1" {
					t.Fatalf("a failed commit: %s", failed.raw)
				}
				e, _ := failed.trusted["error"].(map[string]any)
				look := s.mustCall(token, "lookup_operation", map[string]any{"opId": failed.trusted["opId"]})
				if e["code"] != c.code || look.trusted["found"] != false {
					t.Fatalf("a failed commit: %s, and its lookup: %s", failed.raw, look.raw)
				}
			} else if code := refusal(t, "add_tags", failed); code != c.code {
				t.Fatalf("the write under the fault: %s", failed.raw)
			}
			for _, p := range paths {
				if uid, content := s.read(token, p); uid != heads[p] || strings.Contains(content, "stored") {
					t.Fatalf("%s moved to uid %d under the fault: %q", p, uid, content)
				}
			}
			if ops := s.audit(); len(ops) != len(paths) {
				t.Fatalf("the log holds %d operations, the three creates and nothing else: %+v", len(ops), ops)
			}

			if c.stopped {
				s.stop()
			}
			undo(t, dir)
			if c.stopped {
				s = serveBinary(t, prod, dir, addr)
			}
			s.verified()
			first := s.mustCall(token, "add_tags", applyArgs)
			opID, rows := commits(t, "add_tags", first)
			if again := s.mustCall(token, "add_tags", applyArgs); again.raw != first.raw || len(rows) != len(paths) {
				t.Fatalf("the retry after the fault: %s\nand again: %s", first.raw, again.raw)
			}
			for _, p := range paths {
				if _, content := s.read(token, p); !strings.Contains(content, "stored") ||
					!strings.HasSuffix(content, "# "+p+"\n\nbody of "+p+"\n") {
					t.Fatalf("%s after the retry: %q", p, content)
				}
			}
			if held := keyed(s.audit(), "tags-1"); len(held) != 1 || held[0].ID != opID {
				t.Fatalf("the key is held by %+v, want the one operation %s", held, opID)
			}
		})
	}
}

// readOnlyChunks makes every directory of the chunk store unwritable, so the
// next body stored fails as a full or read-only disk would, and returns what
// puts them back.
func readOnlyChunks(t *testing.T, dir string) func(*testing.T, string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Fatal("run as root, a read-only directory is still writable, and this fault would be no fault")
	}
	var dirs []string
	root := filepath.Join(dir, "chunks")
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	})
	if err != nil || len(dirs) < 2 {
		t.Fatalf("the chunk store at %s: %v, %d directories", root, err, len(dirs))
	}
	for _, d := range dirs {
		if err := os.Chmod(d, 0o555); err != nil {
			t.Fatal(err)
		}
	}
	undo := func(t *testing.T, _ string) {
		for _, d := range dirs {
			if err := os.Chmod(d, 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Cleanup(func() { undo(t, dir) })
	return undo
}

// failingPins makes the operation's transaction fail after its entries are
// written: a trigger refuses the first before-image pin it records.
func failingPins(t *testing.T, dir string) func(*testing.T, string) {
	t.Helper()
	execSQL(t, dir, `CREATE TRIGGER test_fault_pins BEFORE INSERT ON op_pins
		BEGIN SELECT RAISE(ABORT, 'injected storage error'); END`)
	return func(t *testing.T, dir string) { execSQL(t, dir, `DROP TRIGGER test_fault_pins`) }
}

// failingCommit makes the COMMIT fail with the transaction complete: a
// deferred foreign key that every recorded operation breaks, checked only
// when the transaction commits (as TestAnUnknownOutcomeIsNeverReportedAsARefusal
// does in the process).
func failingCommit(t *testing.T, dir string) func(*testing.T, string) {
	t.Helper()
	for _, stmt := range []string{
		`CREATE TABLE test_fault_parent (id TEXT PRIMARY KEY)`,
		`CREATE TABLE test_fault (op TEXT REFERENCES test_fault_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
		`CREATE TRIGGER test_fault_commit AFTER INSERT ON operations BEGIN INSERT INTO test_fault VALUES (NEW.id); END`,
	} {
		execSQL(t, dir, stmt)
	}
	return func(t *testing.T, dir string) {
		execSQL(t, dir, `DROP TRIGGER test_fault_commit`)
		execSQL(t, dir, `DROP TABLE test_fault`)
		execSQL(t, dir, `DROP TABLE test_fault_parent`)
	}
}
