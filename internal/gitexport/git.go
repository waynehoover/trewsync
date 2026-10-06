package gitexport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The export shells out to the system's git and git-lfs (docs/development.md,
// "Git export", says why rather than go-git). Every call goes through run:
// an argument vector and never a shell, an environment built from nothing
// but PATH, a deadline, and stderr kept for the error with any credential
// taken out of it.

// The oldest versions this relies on. Git 2.36 is the first with core.fsync,
// which is what makes a ref update durable before the export records it
// (exporter.go); git-lfs 3.0 has push --object-id and the file:// transfer
// the tests use.
const (
	MinGit = "2.36"
	MinLFS = "3.0"
)

// remoteName is the one remote the bare repository has, which the export
// writes into its config from the settings on every start.
const remoteName = "trew"

// scratchRef is where fast-import leaves its commits before the export
// moves the branch to them itself, under its own check (exporter.go).
const scratchRef = "refs/trew/import"

// Timeouts for the calls that reach a network, and for the rest.
const (
	localTimeout  = 2 * time.Minute
	importTimeout = 30 * time.Minute
	remoteTimeout = 10 * time.Minute
	lfsTimeout    = 60 * time.Minute
)

// stderrLimit bounds the stderr kept for an error.
const stderrLimit = 16 << 10

// knownGitHubHosts are GitHub's published SSH host keys, from
// https://api.github.com/meta and docs.github.com ("GitHub's SSH key
// fingerprints"), as of 2026-09-25. SHA256 fingerprints: ed25519
// +DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU, ecdsa
// p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM, rsa
// uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s. Written to the export's own
// known_hosts for a github.com remote given no -known-hosts, so the host is
// checked strictly from the first connection. If GitHub ever rotates them,
// the push fails on the host key, doctor says so, and docs/git-export.md
// says how to give -known-hosts instead.
const knownGitHubHosts = `github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
`

// Tools is what the export found of the binaries it runs.
type Tools struct {
	Git        string `json:"git,omitempty"`
	GitVersion string `json:"gitVersion,omitempty"`
	LFS        string `json:"lfs,omitempty"`
	LFSVersion string `json:"lfsVersion,omitempty"`
	SSH        string `json:"ssh,omitempty"`
	// Missing names what is absent or too old, each with why.
	Missing []string `json:"missing,omitempty"`
}

// lookPath is exec.LookPath, a seam for the test that takes git away.
var lookPath = exec.LookPath

// FindTools looks for git, git-lfs and ssh on PATH and checks their versions.
// ssh is needed only for an SSH remote, and git-lfs only once a file is over
// the threshold or a remote is set; the caller decides what is fatal.
func FindTools(ctx context.Context) Tools {
	var t Tools
	var err error
	if t.Git, err = lookPath("git"); err != nil {
		t.Missing = append(t.Missing, "git is not on PATH")
		return t
	}
	out, err := exec.CommandContext(ctx, t.Git, "version").Output()
	if err != nil {
		t.Missing = append(t.Missing, "git does not run: "+err.Error())
		return t
	}
	t.GitVersion = versionIn(string(out), `git version (\d+\.\d+(?:\.\d+)?)`)
	if !atLeast(t.GitVersion, MinGit) {
		t.Missing = append(t.Missing, fmt.Sprintf("git is %s and the export needs %s or later", orUnknown(t.GitVersion), MinGit))
	}
	if t.LFS, err = lookPath("git-lfs"); err != nil {
		t.LFS = ""
		t.Missing = append(t.Missing, "git-lfs is not on PATH")
	} else if out, err := exec.CommandContext(ctx, t.LFS, "version").Output(); err != nil {
		t.Missing = append(t.Missing, "git-lfs does not run: "+err.Error())
	} else {
		t.LFSVersion = versionIn(string(out), `git-lfs/(\d+\.\d+(?:\.\d+)?)`)
		if !atLeast(t.LFSVersion, MinLFS) {
			t.Missing = append(t.Missing, fmt.Sprintf("git-lfs is %s and the export needs %s or later",
				orUnknown(t.LFSVersion), MinLFS))
		}
	}
	if t.SSH, err = lookPath("ssh"); err != nil {
		t.SSH = ""
	}
	return t
}

func orUnknown(v string) string {
	if v == "" {
		return "of an unknown version"
	}
	return v
}

func versionIn(out, pattern string) string {
	m := regexp.MustCompile(pattern).FindStringSubmatch(out)
	if m == nil {
		return ""
	}
	return m[1]
}

// atLeast compares dotted versions numerically.
func atLeast(have, want string) bool {
	if have == "" {
		return false
	}
	h, w := strings.Split(have, "."), strings.Split(want, ".")
	for i := range w {
		var a, b int
		if i < len(h) {
			a, _ = strconv.Atoi(h[i])
		}
		b, _ = strconv.Atoi(w[i])
		if a != b {
			return a > b
		}
	}
	return true
}

// runner runs git against one bare repository, with one remote's credential.
type runner struct {
	git    string
	gitDir string
	home   string
	s      Settings
}

// errTimeout wraps a call that ran out of time.
var errTimeout = errors.New("timed out")

// shellQuote quotes s for a POSIX shell, which is what reads GIT_SSH_COMMAND
// and a credential helper.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// sshCommand is the ssh git and git-lfs run for an SSH remote: this key and
// no other, no agent and none forwarded, no user or system ssh config, the
// host checked strictly against the one known_hosts file, and never a prompt.
func (r *runner) sshCommand() string {
	return strings.Join([]string{
		"ssh", "-F", "/dev/null",
		"-i", shellQuote(r.s.Key),
		"-o", "IdentitiesOnly=yes",
		"-o", "IdentityAgent=none",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"-o", "PasswordAuthentication=no",
		"-o", "KbdInteractiveAuthentication=no",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + shellQuote(r.s.KnownHosts),
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "UpdateHostKeys=no",
		"-o", "ConnectTimeout=30",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
	}, " ")
}

// credentialHelper answers git's and git-lfs's request for the HTTPS token
// by reading the token file when it is asked, so the token is in no argument,
// no environment variable and no file but its own.
func (r *runner) credentialHelper() string {
	return `!f() { test "$1" = get || exit 0; printf 'username=x-access-token\npassword=%s\n' "$(cat ` +
		shellQuote(r.s.Token) + `)"; }; f`
}

// env is the whole environment a git process gets.
func (r *runner) env() []string {
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + r.home,
		"XDG_CONFIG_HOME=" + r.home,
		"GIT_DIR=" + r.gitDir,
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"GIT_LFS_SKIP_SMUDGE=1",
		"LC_ALL=C",
		"TZ=UTC",
	}
	if tmp := os.Getenv("TMPDIR"); tmp != "" {
		env = append(env, "TMPDIR="+tmp)
	}
	if r.s.Transport == TransportSSH {
		env = append(env, "GIT_SSH_COMMAND="+r.sshCommand(), "GIT_SSH_VARIANT=ssh")
	}
	return env
}

// config are the -c options every call carries: fsync everything, run no
// hook, never gc behind the export's back, ask no credential helper but the
// export's own, and do not ask an LFS server about locks.
func (r *runner) config() []string {
	c := []string{
		"-c", "core.fsync=all",
		"-c", "core.fsyncMethod=fsync",
		"-c", "core.hooksPath=/dev/null",
		"-c", "gc.auto=0",
		"-c", "maintenance.auto=false",
		"-c", "credential.helper=",
		"-c", "lfs.locksverify=false",
		"-c", "lfs.activitytimeout=120",
		"-c", "advice.pushUpdateRejected=false",
	}
	if r.s.Transport == TransportHTTPS {
		c = append(c, "-c", "credential.helper="+r.credentialHelper())
	}
	return c
}

// run runs git with args, stdin when not nil, and a deadline. It returns
// stdout, or an error carrying git's stderr with the credential redacted.
func (r *runner) run(ctx context.Context, timeout time.Duration, stdin io.Reader, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.git, append(r.config(), args...)...)
	cmd.Env = r.env()
	cmd.Dir = r.home
	cmd.Stdin = stdin
	var stdout bytes.Buffer
	stderr := &limited{max: stderrLimit}
	cmd.Stdout, cmd.Stderr = &stdout, stderr
	stopGently(cmd)
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return stdout.Bytes(), fmt.Errorf("git %s: %w after %s", verb(args), errTimeout, timeout)
	}
	if err != nil {
		return stdout.Bytes(), &gitError{args: verb(args), err: err, stderr: r.redact(stderr.String())}
	}
	return stdout.Bytes(), nil
}

// stopGently has cmd told to stop with SIGTERM when its context ends, and
// killed only if it has not ended ten seconds later, which also gives up on an
// ssh that outlives git holding the pipes (T44).
//
// exec.CommandContext kills by default, and every git call runs under the
// context the export cancels when the server stops, so a stop killed whatever
// git was doing. git removes the lock files it holds while it writes when it
// is sent SIGTERM, and a kill leaves them: a config, a symbolic-ref or an
// update-ref killed mid-write left a .lock that stopped the export until
// somebody deleted it by hand, while the comments said the export let git
// finish.
func stopGently(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 10 * time.Second
}

// gitError is a git call that failed.
type gitError struct {
	args   string
	err    error
	stderr string
}

func (e *gitError) Error() string {
	msg := strings.TrimSpace(e.stderr)
	if msg == "" {
		return fmt.Sprintf("git %s: %v", e.args, e.err)
	}
	return fmt.Sprintf("git %s: %v: %s", e.args, e.err, msg)
}

func (e *gitError) Unwrap() error { return e.err }

// verb names a call by its subcommand, for an error: never its arguments,
// which can carry a URL.
func verb(args []string) string {
	if len(args) >= 2 && args[0] == "lfs" {
		return "lfs " + args[1]
	}
	if len(args) >= 1 {
		return args[0]
	}
	return ""
}

var userinfo = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)[^/@\s]+@`)

// redact takes the credential out of s: the token's own bytes, whatever the
// token file holds now, and any user information in a URL.
func (r *runner) redact(s string) string {
	s = userinfo.ReplaceAllString(s, "${1}[redacted]@")
	if r.s.Token != "" {
		if b, err := os.ReadFile(r.s.Token); err == nil {
			if tok := strings.TrimSpace(string(b)); len(tok) >= 4 {
				s = strings.ReplaceAll(s, tok, "[redacted]")
			}
		}
	}
	return s
}

// limited keeps the first max bytes written to it, and counts the rest.
type limited struct {
	buf     bytes.Buffer
	max     int
	dropped int
}

func (l *limited) Write(p []byte) (int, error) {
	room := l.max - l.buf.Len()
	if room > 0 {
		if len(p) <= room {
			l.buf.Write(p)
		} else {
			l.buf.Write(p[:room])
			l.dropped += len(p) - room
		}
	} else {
		l.dropped += len(p)
	}
	return len(p), nil
}

func (l *limited) String() string {
	if l.dropped > 0 {
		return l.buf.String() + fmt.Sprintf("\n[%d more bytes of stderr]", l.dropped)
	}
	return l.buf.String()
}
