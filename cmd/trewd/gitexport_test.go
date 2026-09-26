package main

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/config"
	"github.com/waynehoover/trewsync/internal/doctor"
	"github.com/waynehoover/trewsync/internal/gitexport"
)

// gitStatus is `trewd git-export status -json`.
func gitStatus(t *testing.T, dir string) gitexport.Status {
	t.Helper()
	var st gitexport.Status
	if err := json.Unmarshal([]byte(mustRun(t, "git-export", "status", "-data", dir, "-json")), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// TestAFailingPushLeavesSyncAloneAndDoctorSaysSo: a server exporting to a
// remote it cannot reach takes an agent's write at once, commits it to the
// local repository, and reports the push's failure in its status and in
// doctor, which exits non-zero on it; the credential's contents appear in
// neither.
func TestAFailingPushLeavesSyncAloneAndDoctorSaysSo(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(t.TempDir(), "token")
	secret := "github_pat_never_printed_0123456789"
	if err := os.WriteFile(token, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	mustRun(t, "git-export", "set", "-data", dir, "-remote", "https://127.0.0.1:1/owner/repo.git", "-token", token,
		"-quiet", "0s")
	addr := serveMCPOn(t, dir)
	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "mcp-token", "-data", dir, "-label", "agent", "-scope", "write", "-key-out", key)
	bearer, err := os.ReadFile(key)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	status, _, body := postMCP(t, "http://"+addr+"/mcp", strings.TrimSpace(string(bearer)),
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_note","arguments":{"path":"n.md","content":"kept\n"}}}`)
	if status != http.StatusOK || !strings.Contains(string(body), `\"committed\":true`) {
		t.Fatalf("create_note: %d %s", status, body)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("a write took %s with the push failing", d)
	}

	deadline := time.Now().Add(60 * time.Second)
	var st gitexport.Status
	for {
		st = gitStatus(t, dir)
		if st.ExportedThrough > 0 && st.Push != nil && st.Push.LastError != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the export did not commit and report the failed push: %+v", st)
		}
		time.Sleep(100 * time.Millisecond)
	}
	out, err := trew(t, "doctor", "-data", dir, "-json")
	if err == nil {
		t.Fatalf("doctor exits 0 with the push failing:\n%s", out)
	}
	var rep doctor.Report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("%v:\n%s", err, out)
	}
	found := false
	for _, f := range rep.Findings {
		if f.Check == doctor.CheckGitExport {
			found = true
			if f.Status != doctor.Warn || !strings.Contains(f.Summary, "the last push") {
				t.Errorf("doctor says %s: %s", f.Status, f.Summary)
			}
		}
	}
	if !found {
		t.Fatalf("doctor has no git-export finding:\n%s", out)
	}
	human := mustRun(t, "git-export", "status", "-data", dir)
	for _, text := range []string{out, human} {
		if strings.Contains(text, secret) {
			t.Fatalf("the token is printed:\n%s", text)
		}
	}
	if !strings.Contains(human, "last push error") || !strings.Contains(human, token) {
		t.Errorf("the status does not name the error and the token's path:\n%s", human)
	}
}

// TestTheConfigFileAndItsFlags: `trewd config set` writes the file, mode
// 0600, refusing a value the feature could not use and a key it does not
// know; serve reads the file, and a flag given to serve wins over it, which
// `config show` says through the running server.
func TestTheConfigFileAndItsFlags(t *testing.T) {
	dir := t.TempDir()
	mustRun(t, "config", "set", "-data", dir, "daily.folder", "Journal")
	mustRun(t, "config", "set", "-data", dir, "daily.timezone", "UTC")
	info, err := os.Stat(config.Path(dir))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the file is %v (%v)", info, err)
	}
	if _, err := trew(t, "config", "set", "-data", dir, "daily.format", "gggg"); err == nil ||
		!strings.Contains(err.Error(), "daily.format") {
		t.Errorf("a format the tools cannot write is accepted: %v", err)
	}
	if _, err := trew(t, "config", "set", "-data", dir, "daily.nonsense", "x"); err == nil {
		t.Error("an unknown key is accepted")
	}
	if _, err := trew(t, "config", "set", "-data", dir, "git_export.enabled", "maybe"); err == nil {
		t.Error("a bool that is not one is accepted")
	}

	serveMCPOn(t, dir, "-daily-format", "YYYY-[day]-DDD")
	var v configView
	if err := json.Unmarshal([]byte(mustRun(t, "config", "show", "-data", dir, "-json")), &v); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"daily.folder": "Journal file", "daily.format": "YYYY-[day]-DDD flag",
		"daily.timezone": "UTC file", "daily.templates_folder": "Templates default"}
	for _, s := range v.Settings {
		if w, ok := want[s.Key]; ok && s.Value+" "+s.Source != w {
			t.Errorf("%s is %s %s, and should be %s", s.Key, s.Value, s.Source, w)
		}
	}
	if !v.Server {
		t.Error("config show did not ask the running server")
	}

	// A change through the running server is taken up at once and says the
	// flag still wins where one was given.
	out := mustRun(t, "config", "set", "-data", dir, "daily.format", "YYYY-MM-DD")
	if !strings.Contains(out, "-daily-format, which wins over the file") {
		t.Errorf("config set does not say the flag wins:\n%s", out)
	}
	out = mustRun(t, "config", "set", "-data", dir, "daily.folder", "Daily")
	if !strings.Contains(out, "uses it now") {
		t.Errorf("config set does not say the server took it up:\n%s", out)
	}
}

// TestServeRefusesAConfigFileItCannotRead: a key this build does not know
// stops serve, naming the file, rather than being ignored.
func TestServeRefusesAConfigFileItCannotRead(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(config.Path(dir), []byte(`{"daily": {"folderr": "Journal"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	err := run(t.Context(), []string{"serve", "-data", dir, "-addr", "127.0.0.1:0"}, &safeBuffer{})
	if err == nil || !strings.Contains(err.Error(), config.FileName) || !strings.Contains(err.Error(), "folderr") {
		t.Fatalf("serve with an unknown key: %v", err)
	}
}

// runGit runs git in dir with no user or system configuration.
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "HOME="+dir,
		"GIT_AUTHOR_NAME=obsidian-git", "GIT_AUTHOR_EMAIL=o@example.com",
		"GIT_COMMITTER_NAME=obsidian-git", "GIT_COMMITTER_EMAIL=o@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// TestAdoptingABranchThroughTheCommand: `trewd git-export adopt` with no
// server shows the remote's tip and changes nothing; a commit that is not the
// tip is refused; through the running server, `adopt SHA` records it in the
// file, and the export's first push is a fast-forward of it.
func TestAdoptingABranchThroughTheCommand(t *testing.T) {
	dir := t.TempDir()
	base := t.TempDir()
	remote := filepath.Join(base, "remote.git")
	runGit(t, base, "init", "-q", "--bare", remote)
	work := filepath.Join(base, "vault")
	runGit(t, base, "init", "-q", "-b", "main", work)
	if err := os.WriteFile(filepath.Join(work, "old.md"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, work, "add", "-A")
	runGit(t, work, "commit", "-q", "-m", "vault backup: 2026-09-20 21:15:00")
	runGit(t, work, "push", "-q", remote, "main")
	sha := runGit(t, remote, "rev-parse", "main")

	mustRun(t, "git-export", "set", "-data", dir, "-remote", "file://"+remote, "-quiet", "0s")
	look := mustRun(t, "git-export", "adopt", "-data", dir)
	if !strings.Contains(look, sha) || !strings.Contains(look, "vault backup: 2026-09-20 21:15:00") ||
		!strings.Contains(look, "trewd git-export adopt "+sha) {
		t.Fatalf("adopt does not show the tip:\n%s", look)
	}
	if f, _, _ := config.Load(dir); f.GitExport.Adopted != nil {
		t.Fatalf("looking adopted %+v", f.GitExport.Adopted)
	}
	if out, err := trew(t, "git-export", "adopt", "-data", dir, strings.Repeat("1", 40)); err == nil ||
		!strings.Contains(err.Error(), "nothing was adopted") {
		t.Fatalf("adopting a commit that is not the tip: %v\n%s", err, out)
	}

	addr := serveMCPOn(t, dir)
	out := mustRun(t, "git-export", "adopt", sha, "-data", dir)
	if !strings.Contains(out, "adopted:") || !strings.Contains(out, "continues the history adopted at "+sha) {
		t.Fatalf("adopt through the server:\n%s", out)
	}
	f, _, err := config.Load(dir)
	if err != nil || f.GitExport.Adopted == nil || f.GitExport.Adopted.Commit != sha || f.GitExport.Adopted.Branch != "main" {
		t.Fatalf("the file holds %+v (%v)", f.GitExport.Adopted, err)
	}

	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "mcp-token", "-data", dir, "-label", "agent", "-scope", "write", "-key-out", key)
	bearer, err := os.ReadFile(key)
	if err != nil {
		t.Fatal(err)
	}
	status, _, body := postMCP(t, "http://"+addr+"/mcp", strings.TrimSpace(string(bearer)),
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_note","arguments":{"path":"new.md","content":"new\n"}}}`)
	if status != http.StatusOK || !strings.Contains(string(body), `\"committed\":true`) {
		t.Fatalf("create_note: %d %s", status, body)
	}
	deadline := time.Now().Add(60 * time.Second)
	var st gitexport.Status
	for {
		st = gitStatus(t, dir)
		if st.Push != nil && st.Push.Pushed != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the adopted branch was not pushed: %+v", st)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if got := runGit(t, remote, "rev-parse", "main~1"); got != sha {
		t.Fatalf("the first pushed commit's parent is %s, and the adopted commit %s", got, sha)
	}
	if files := runGit(t, remote, "ls-tree", "--name-only", "main"); files != "new.md" {
		t.Fatalf("the first commit holds %q", files)
	}
}
