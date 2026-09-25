package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/config"
	"github.com/waynehoover/trew/internal/doctor"
	"github.com/waynehoover/trew/internal/gitexport"
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
