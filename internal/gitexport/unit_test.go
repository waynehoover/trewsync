package gitexport

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/config"
	"github.com/waynehoover/trewsync/internal/store"
)

// TestQuotingRoundTrips: every path the store can hold survives cQuote and
// cUnquote, and a .gitattributes the export writes reads back as the same
// set of paths.
func TestQuotingRoundTrips(t *testing.T) {
	paths := append([]string{"plain.md", "tab\there.md", `back\slash`, "x\x7fy"}, awkward...)
	for _, p := range paths {
		got, err := cUnquote(cQuote(p))
		if err != nil || got != p {
			t.Errorf("%q quoted and unquoted is %q (%v)", p, got, err)
		}
	}
	lfs, err := parseAttributes(attributesFor(paths))
	if err != nil {
		t.Fatal(err)
	}
	if len(lfs) != len(paths) {
		t.Fatalf("%d paths read back from %d", len(lfs), len(paths))
	}
	for _, p := range paths {
		if !lfs[p] {
			t.Errorf("%q did not read back", p)
		}
	}
	if _, err := parseAttributes([]byte("*.png filter=lfs\n")); err == nil {
		t.Error("a line the export does not write is read as one")
	}
}

// TestGitReadsTheAttributesAsTheExportMeantThem: git check-attr, the reader
// that decides what a clone smudges, finds each awkward name the export wrote
// a pattern for, and nothing beside it.
func TestGitReadsTheAttributesAsTheExportMeantThem(t *testing.T) {
	needGit(t)
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	if err := os.WriteFile(filepath.Join(dir, attributesPath), attributesFor(awkward), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range awkward {
		if got := git(t, dir, "check-attr", "filter", "--", p); !strings.HasSuffix(got, ": filter: lfs") {
			t.Errorf("git reads %q as %s", p, got)
		}
	}
	for _, p := range []string{"Projects/d plan.md", "Projects/[draft] planXY.md", "Inbox/a note.mdx", "a note.md"} {
		if got := git(t, dir, "check-attr", "filter", "--", p); !strings.HasSuffix(got, ": filter: unspecified") {
			t.Errorf("a pattern matches %q too: %s", p, got)
		}
	}
}

func TestParseRemote(t *testing.T) {
	good := map[string]Transport{
		"git@github.com:waynehoover/trewsync-git-export-test.git": TransportSSH,
		"ssh://git@example.com:2222/srv/notes.git":                TransportSSH,
		"https://github.com/owner/repo.git":                       TransportHTTPS,
		"file:///srv/git/notes.git":                               TransportFile,
	}
	for remote, want := range good {
		if got, _, err := ParseRemote(remote); err != nil || got != want {
			t.Errorf("%s is %q (%v), not %q", remote, got, err, want)
		}
	}
	for _, remote := range []string{
		"https://x-access-token:ghp_secret@github.com/o/r.git", // a token in the URL
		"https://user@github.com/o/r.git",
		"http://example.com/o/r.git", // plaintext
		"git://example.com/o/r.git",
		"/srv/git/notes.git", // a bare path: say file://
		"-oProxyCommand=evil:x",
		"github.com",
		"file://host/srv/x.git",
	} {
		if _, _, err := ParseRemote(remote); err == nil {
			t.Errorf("%s is accepted", remote)
		}
	}
	if _, _, err := ParseRemote("https://x-access-token:ghp_secret@github.com/o/r.git"); err != nil &&
		strings.Contains(err.Error(), "ghp_secret") {
		t.Errorf("the refusal repeats the token: %v", err)
	}
}

// TestACredentialReadableByOthersIsRefused: a key or token file anyone but its
// owner can read is refused when it is set, and again before every push.
func TestACredentialReadableByOthersIsRefused(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "key")
	if err := os.WriteFile(key, []byte("private"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := CheckSecretFile("-key", key); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("a 0640 key is accepted: %v", err)
	}
	if err := os.Chmod(key, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckSecretFile("-key", key); err != nil {
		t.Fatalf("a 0600 key is refused: %v", err)
	}
	if err := CheckSecretFile("-key", "relative/key"); err == nil {
		t.Fatal("a relative path is accepted")
	}
	c := config.GitExport{Enabled: true, Remote: "git@github.com:o/r.git", Key: key}
	if err := os.Chmod(key, 0o604); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(dir, c, Overrides{}); err == nil {
		t.Fatal("settings with a world-readable key resolve")
	}
}

func TestCheckBranch(t *testing.T) {
	for _, b := range []string{"main", "trew/export", "vault-2026"} {
		if err := CheckBranch(b); err != nil {
			t.Errorf("%q: %v", b, err)
		}
	}
	for _, b := range []string{"", "-x", "a..b", "a b", "a~1", "x.lock", "/a", "a/", ".hidden", "a@{1}", "HEAD", "a:b"} {
		if err := CheckBranch(b); err == nil {
			t.Errorf("%q is accepted", b)
		}
	}
}

// TestFlagsWinOverTheFile: a serve flag replaces the file's setting, setting
// by setting, and Source says which is which.
func TestFlagsWinOverTheFile(t *testing.T) {
	threshold := int64(1 << 20)
	c := config.GitExport{Enabled: true, Branch: "from-file", LFSThreshold: &threshold, Quiet: "10m"}
	branch := "from-flag"
	s, err := Resolve(t.TempDir(), c, Overrides{Branch: &branch})
	if err != nil {
		t.Fatal(err)
	}
	if s.Branch != "from-flag" || s.Source["branch"] != "flag" || s.LFSThreshold != 1<<20 ||
		s.Source["lfs_threshold"] != "file" || s.Quiet != 10*time.Minute {
		t.Fatalf("resolved to %+v", s)
	}
	off := false
	if s, _ := Resolve(t.TempDir(), c, Overrides{Enabled: &off}); s.Enabled {
		t.Fatal("-git-export=false does not turn the file's export off")
	}
	if s, _ := Resolve(t.TempDir(), config.GitExport{}, Overrides{Branch: &branch}); !s.Enabled {
		t.Fatal("a git-export flag with no file does not turn the export on")
	}
}

// TestThePlan checks the grouping rules on their own: a run within the quiet
// window is one group, a pause, another device or an operation starts the
// next, an operation is one group however its versions were read, and a
// version with no recorded time starts a new group only where its path
// repeats.
func TestThePlan(t *testing.T) {
	min := int64(time.Minute / time.Millisecond)
	e := func(uid int64, device, path string) store.Entry {
		return store.Entry{UID: uid, Device: device, Path: path}
	}
	op := &store.OpStamp{ID: "op1", Tool: "edit_note", CommittedAt: 100 * min, LastUID: 6}
	p := &planner{quiet: 5 * time.Minute}
	p.add(e(1, "Laptop", "a"), 1*min, true, nil)
	p.add(e(2, "Laptop", "a"), 4*min, true, nil) // within the window
	p.add(e(3, "Laptop", "b"), 9*min, true, nil) // five minutes of quiet
	p.add(e(4, "Phone", "b"), 10*min, true, nil) // another device
	p.add(e(5, "Claude", "c"), 100*min, true, op)
	p.add(e(6, "Claude", "d"), 100*min, true, op)
	p.add(e(7, "Laptop", "a"), 50*min, true, nil) // a clock stepped back
	p.finish(106 * min)
	var got []string
	for _, g := range p.closed {
		var uids []string
		for _, x := range g.entries {
			uids = append(uids, string(rune('0'+x.UID)))
		}
		got = append(got, strings.Join(uids, ""))
	}
	if strings.Join(got, " ") != "12 3 4 56 7" {
		t.Fatalf("grouped as %v", got)
	}
	if p.closed[4].at != 100*min {
		t.Errorf("a version with an earlier clock is dated %d, before the one before it", p.closed[4].at)
	}

	// Without recorded times: one run, broken where a path repeats.
	q := &planner{quiet: 5 * time.Minute, fallback: 7}
	for i, path := range []string{"a", "b", "a", "c"} {
		q.add(e(int64(i+1), "Laptop", path), 0, false, nil)
	}
	q.finish(1 << 50)
	if len(q.closed) != 2 || len(q.closed[0].entries) != 2 || q.closed[0].at != 7 {
		t.Fatalf("untimed versions grouped as %d groups", len(q.closed))
	}

	// A run whose window has not passed stays open, and says when it closes:
	// its window and the margin for a write in flight after it (T47), and
	// not before.
	o := &planner{quiet: 5 * time.Minute}
	o.add(e(1, "Laptop", "a"), 1*min, true, nil)
	o.finish(6*min + inFlight.Milliseconds() - 1)
	if len(o.closed) != 0 || o.openUntil() != 6*min+inFlight.Milliseconds() {
		t.Fatalf("an open run closed early, or closes at %d", o.openUntil())
	}
}

// TestSSHIsRunWithOnlyTheKeyAndTheKnownHosts: git's ssh is given this key and
// no other, no agent, no config, and strict checking against the one
// known_hosts file. A stand-in ssh on PATH records what it was run with.
func TestSSHIsRunWithOnlyTheKeyAndTheKnownHosts(t *testing.T) {
	tools := needGit(t)
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(dir, "ssh.args")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '" + record + "'\n" +
		"env >> '" + record + "'\necho 'Permission denied (publickey).' >&2\nexit 255\n"
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	key := filepath.Join(dir, "deploy key's")
	kh := filepath.Join(dir, "known_hosts")
	for _, f := range []string{key, kh} {
		if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Resolve(dir, config.GitExport{Enabled: true, Remote: "git@example.test:o/r.git", Key: key, KnownHosts: kh}, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	r := &runner{git: tools.Git, gitDir: filepath.Join(dir, "repo.git"), home: dir, s: s}
	if _, err := r.run(context.Background(), time.Minute, nil, "init", "--bare", "-q"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.run(context.Background(), time.Minute, nil, "config", "remote.trew.url", s.Remote); err != nil {
		t.Fatal(err)
	}
	_, err = lsRemote(context.Background(), r, "main")
	if err == nil || !strings.Contains(err.Error(), "Permission denied") {
		t.Fatalf("ls-remote through the stand-in: %v", err)
	}
	b, rerr := os.ReadFile(record)
	if rerr != nil {
		t.Fatal(rerr)
	}
	got := string(b)
	for _, want := range []string{"-F\n/dev/null\n", "-i\n" + key + "\n", "IdentitiesOnly=yes", "IdentityAgent=none",
		"ForwardAgent=no", "BatchMode=yes", "StrictHostKeyChecking=yes", "UserKnownHostsFile=" + kh + "\n",
		"GlobalKnownHostsFile=/dev/null", "git@example.test"} {
		if !strings.Contains(got, want) {
			t.Errorf("ssh was not given %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "SSH_AUTH_SOCK") {
		t.Error("ssh was given the agent's socket")
	}
}

// T44. Every git call runs under a context the export cancels when it
// stops, and exec.CommandContext answers a cancel with SIGKILL, which gives
// git no chance to remove the lock files it holds while it writes: a config,
// a symbolic-ref or an update-ref killed mid-write leaves a .lock that stops
// the export until somebody deletes it by hand. The comments said the
// export let git finish. git is now told to stop with SIGTERM, which it
// answers by removing its locks, and killed only if it has not ended soon
// after. The stand-in git here records the signal it was given.
func TestStoppingTheExportLetsGitCleanUp(t *testing.T) {
	dir := t.TempDir()
	mark := filepath.Join(dir, "mark")
	script := "#!/bin/sh\ntrap 'echo term > \"" + mark + ".term\"; exit 143' TERM\n" +
		"echo started > \"" + mark + ".started\"\nwhile :; do sleep 0.05; done\n"
	git := filepath.Join(dir, "git")
	if err := os.WriteFile(git, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	r := &runner{git: git, gitDir: filepath.Join(dir, "repo.git"), home: dir}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := r.run(ctx, time.Minute, nil, "config", "remote.trew.url", "git@example.test:o/r.git")
		done <- err
	}()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if _, err := os.Stat(mark + ".started"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the stand-in git never started")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("git was not stopped")
	}
	if _, err := os.Stat(mark + ".term"); err != nil {
		t.Fatalf("git was killed rather than told to stop, so a lock it held would be left: %v", err)
	}
}

// TestTheTokenIsReadFromItsFileAndNeverShown: git asks the export's
// credential helper for the HTTPS token, which reads it from the file when
// asked; an error that echoes it has it redacted.
func TestTheTokenIsReadFromItsFileAndNeverShown(t *testing.T) {
	tools := needGit(t)
	dir := t.TempDir()
	token := filepath.Join(dir, "it's a token")
	secret := "github_pat_0123456789abcdef"
	if err := os.WriteFile(token, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Resolve(dir, config.GitExport{Enabled: true, Remote: "https://github.com/o/r.git", Token: token}, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	r := &runner{git: tools.Git, gitDir: filepath.Join(dir, "repo.git"), home: dir, s: s}
	if _, err := r.run(context.Background(), time.Minute, nil, "init", "--bare", "-q"); err != nil {
		t.Fatal(err)
	}
	out, err := r.run(context.Background(), time.Minute, strings.NewReader("protocol=https\nhost=github.com\npath=o/r.git\n\n"),
		"credential", "fill")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "password="+secret+"\n") || !strings.Contains(string(out), "username=x-access-token") {
		t.Fatalf("git's credential fill got %q", out)
	}
	for _, arg := range r.config() {
		if strings.Contains(arg, secret) {
			t.Fatal("the token is in git's arguments")
		}
	}
	for _, v := range r.env() {
		if strings.Contains(v, secret) {
			t.Fatal("the token is in git's environment")
		}
	}
	if red := r.redact("fatal: could not read from https://x:" + secret + "@github.com: " + secret); strings.Contains(red, secret) {
		t.Fatalf("redacted to %q", red)
	}
}

// TestAMissingGitIsReportedAndStopsNothing: without git on PATH the export's
// step fails with a message saying so, and the status carries it.
func TestAMissingGitIsReportedAndStopsNothing(t *testing.T) {
	r := newRig(t)
	defer func(f func(string) (string, error)) { lookPath = f }(lookPath)
	lookPath = func(string) (string, error) { return "", os.ErrNotExist }
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, ""))
	_, _, err := x.cycle(context.Background())
	if err == nil || !strings.Contains(err.Error(), "git is not on PATH") {
		t.Fatalf("a missing git gives %v", err)
	}
	if s := x.Status(); s.Tools == nil || len(s.Tools.Missing) == 0 {
		t.Fatalf("the status does not say git is missing:\n%s", statusJSON(s))
	}
	r.put("Laptop", "still.md", []byte("writes go on\n"))
}
