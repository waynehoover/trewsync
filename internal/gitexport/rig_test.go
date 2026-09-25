package gitexport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/config"
	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/store"
)

const vault = "v1"

// clock is a store clock a test moves by hand.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// rig is a store, its clock, and an export of it into its own directory.
type rig struct {
	t     *testing.T
	dir   string // the store's data directory
	st    *store.Store
	clock *clock
	agent agent
}

// agent is an MCP token an operation is made with.
type agent struct{ id, hash, label string }

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// needGit fails a test on a machine without git and git-lfs: the export is
// nothing without them, and a skip would read as a pass (scripts/check.sh).
func needGit(t *testing.T) Tools {
	t.Helper()
	tools := FindTools(context.Background())
	if len(tools.Missing) > 0 {
		t.Fatalf("these tests run the export's git and git-lfs, and: %s", strings.Join(tools.Missing, "; "))
	}
	return tools
}

func newRig(t *testing.T) *rig {
	t.Helper()
	needGit(t)
	dir := t.TempDir()
	return openRig(t, dir, &clock{now: time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)})
}

func openRig(t *testing.T, dir string, c *clock) *rig {
	t.Helper()
	dbPath, chunkDir := store.DataDir(dir)
	st, err := store.OpenWithSync(dbPath, chunkDir, store.SyncNormal)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.SetClock(c.Now)
	if err := st.EnsureVault(vault, c.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	return &rig{t: t, dir: dir, st: st, clock: c}
}

// put stores body at path as device writes it, chunked as a device chunks it.
func (r *rig) put(device, path string, body []byte) int64 {
	r.t.Helper()
	uid, err := r.st.AppendEntry(vault, r.entry(device, path, "", body))
	if err != nil {
		r.t.Fatalf("writing %s: %v", path, err)
	}
	return uid
}

func (r *rig) entry(device, path, prev string, body []byte) store.Entry {
	r.t.Helper()
	names := []string{}
	sizes := notes.SizesFor(int64(len(body)), notes.IsTextPath(path), store.ChunkMax)
	for _, c := range notes.ChunkBytes(body, sizes, notes.IsTextPath(path)) {
		name := chunks.Name(c.Bytes)
		if err := r.st.Chunks().Put(vault, name, c.Bytes); err != nil {
			r.t.Fatal(err)
		}
		names = append(names, name)
	}
	return store.Entry{Path: path, Prev: prev, Size: int64(len(body)), MTime: 1, Device: device, Chunks: names}
}

func (r *rig) rename(device, from, to string, body []byte) int64 {
	r.t.Helper()
	uid, err := r.st.AppendEntry(vault, r.entry(device, to, from, body))
	if err != nil {
		r.t.Fatalf("renaming %s: %v", from, err)
	}
	return uid
}

func (r *rig) remove(device, path string) int64 {
	r.t.Helper()
	uid, err := r.st.AppendEntry(vault, store.Entry{Path: path, Deleted: true, Device: device, Chunks: []string{}})
	if err != nil {
		r.t.Fatal(err)
	}
	return uid
}

func (r *rig) folder(device, path string) int64 {
	r.t.Helper()
	uid, err := r.st.AppendEntry(vault, store.Entry{Path: path, Folder: true, Device: device, Chunks: []string{}})
	if err != nil {
		r.t.Fatal(err)
	}
	return uid
}

// head is path's live uid, or zero.
func (r *rig) head(path string) int64 {
	r.t.Helper()
	e, state, _, err := r.st.EntryAsOf(vault, path, 0)
	if err != nil {
		r.t.Fatal(err)
	}
	if state != store.PathLive {
		return 0
	}
	return e.UID
}

// op commits one agent operation writing each path's body.
func (r *rig) op(tool string, writes map[string]string) string {
	r.t.Helper()
	if r.agent.id == "" {
		tok, err := r.st.CreateMCPToken(vault, "Claude", store.ScopeWrite, nil, r.clock.Now().UnixMilli())
		if err != nil {
			r.t.Fatal(err)
		}
		r.agent = agent{id: tok.ID, hash: store.MCPTokenHash(tok.Token), label: "Claude"}
	}
	paths := make([]string, 0, len(writes))
	for p := range writes {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	var entries []store.OpEntry
	for _, p := range paths {
		e := r.entry(r.agent.label, p, "", []byte(writes[p]))
		entries = append(entries, store.OpEntry{Entry: e, Base: r.head(p)})
	}
	sum := sha256.Sum256([]byte(tool + strings.Join(paths, ",")))
	res, err := r.st.CommitOperation(store.Operation{
		Vault: vault, ActorID: r.agent.id, ActorHash: r.agent.hash, ActorLabel: r.agent.label, Tool: tool,
		RequestDigest: hex.EncodeToString(sum[:]), Epoch: r.st.Epoch(), Entries: entries,
		Render: func(store.OpResult) ([]byte, error) { return []byte(`{}`), nil }, MaxResult: 1 << 20,
	})
	if err != nil {
		r.t.Fatalf("committing %s: %v", tool, err)
	}
	return res.OpID
}

// settings are a local export with a small LFS threshold, so a test's
// attachments go to LFS without being large.
func settings(t *testing.T, dataDir string, remote string) Settings {
	t.Helper()
	threshold := int64(4096)
	c := config.GitExport{Enabled: true, Remote: remote, LFSThreshold: &threshold, Quiet: "5m"}
	s, err := Resolve(dataDir, c, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// exporter is an export of r's store into dataDir, not started: a test runs
// its steps itself with sync.
func (r *rig) exporter(dataDir string, s Settings) *Exporter {
	r.t.Helper()
	x := Open(dataDir, r.st, vault, s, nil, quiet())
	r.t.Cleanup(func() { x.Close() })
	return x
}

// sync runs the export's steps until one makes no progress, and the push.
func (x *Exporter) sync(t *testing.T) {
	t.Helper()
	for i := 0; ; i++ {
		progressed, _, err := x.cycle(context.Background())
		if err != nil {
			t.Fatalf("an export step: %v", err)
		}
		if !progressed {
			return
		}
		if i > 10000 {
			t.Fatal("the export never stops making progress")
		}
	}
}

// git runs git in dir with a clean environment, and fails the test if it fails.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := gitErr(dir, args...)
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(out)
}

func gitErr(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "HOME="+dir,
		"GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME=Someone", "GIT_AUTHOR_EMAIL=someone@example.com",
		"GIT_COMMITTER_NAME=Someone", "GIT_COMMITTER_EMAIL=someone@example.com")
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

// repo is the export's bare repository in dataDir.
func repo(dataDir string) string { return filepath.Join(dataDir, Dir, RepoDir) }

// tip is the export's branch.
func tip(t *testing.T, dataDir, branch string) string {
	t.Helper()
	return git(t, repo(dataDir), "rev-parse", "refs/heads/"+branch)
}

// storeFiles is every live file at the store's head, and its bytes.
func (r *rig) storeFiles() map[string][]byte {
	r.t.Helper()
	out := map[string][]byte{}
	err := r.st.EachAsOf(vault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if e.Deleted || e.Folder {
			return true, nil
		}
		full, _, err := r.st.EntryByUID(vault, e.UID)
		if err != nil {
			return false, err
		}
		var b bytes.Buffer
		for _, n := range full.Chunks {
			body, err := r.st.Chunks().Get(vault, n)
			if err != nil {
				return false, err
			}
			b.Write(body)
		}
		out[e.Path] = b.Bytes()
		return true, nil
	})
	if err != nil {
		r.t.Fatal(err)
	}
	return out
}

// checkout is every file of a working tree, apart from .git.
func checkout(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if d.IsDir() {
			if rel == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = b
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// sameFiles fails unless a checkout holds exactly the store's files, byte for
// byte, beside the .gitattributes the export writes: the witness inventory's
// comparison (plan/cutover.md), for a Git tree.
func sameFiles(t *testing.T, want, got map[string][]byte, lfsAsPointers map[string]bool) {
	t.Helper()
	for p, b := range want {
		g, ok := got[p]
		switch {
		case !ok:
			t.Errorf("%s is in the store and not in the checkout", p)
		case lfsAsPointers[p]:
			sum := sha256.Sum256(b)
			if ptr := lfsPointer(hex.EncodeToString(sum[:]), int64(len(b))); !bytes.Equal(g, ptr) {
				t.Errorf("%s is not the LFS pointer to its bytes:\n%s", p, g)
			}
		case !bytes.Equal(g, b):
			t.Errorf("%s differs: the store has %d bytes, the checkout %d", p, len(b), len(g))
		}
	}
	for p := range got {
		if _, ok := want[p]; !ok && p != attributesPath {
			t.Errorf("%s is in the checkout and not in the store", p)
		}
	}
}

// statusJSON is s as the socket carries it, for a failure message.
func statusJSON(s Status) string {
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}
