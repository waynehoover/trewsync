package gitexport

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/waynehoover/trew/internal/config"
)

// Dir is the export's own directory inside the data directory: the bare
// repository, the state database, the known_hosts file it made, and an empty
// home for the git processes it runs.
const Dir = "git-export"

// The defaults a setting takes when neither the file nor a flag gives it.
const (
	DefaultBranch       = "main"
	DefaultLFSThreshold = 10 << 20 // 10 MiB
	DefaultQuiet        = 5 * time.Minute
	// MaxQuiet bounds the quiet window: a day already makes a commit per day
	// of steady writing.
	MaxQuiet = 24 * time.Hour
)

// Change is what `trewd git-export set` asks for: each field given replaces
// the file's, and the rest are kept. Local clears the remote and its
// credential, keeping the export in the local repository only.
type Change struct {
	Remote       *string `json:"remote,omitempty"`
	Key          *string `json:"key,omitempty"`
	Token        *string `json:"token,omitempty"`
	KnownHosts   *string `json:"known_hosts,omitempty"`
	Branch       *string `json:"branch,omitempty"`
	LFSThreshold *int64  `json:"lfs_threshold,omitempty"`
	Quiet        *string `json:"quiet,omitempty"`
	Local        bool    `json:"local,omitempty"`
}

// Overrides are the settings `serve` was given as flags, each nil when the
// flag was not given. A flag wins over the file, setting by setting, for as
// long as that server runs.
type Overrides struct {
	Enabled      *bool
	Remote       *string
	Key          *string
	Token        *string
	KnownHosts   *string
	Branch       *string
	LFSThreshold *int64
	Quiet        *time.Duration
}

// Any reports whether any flag was given.
func (o Overrides) Any() bool {
	return o.Enabled != nil || o.Remote != nil || o.Key != nil || o.Token != nil || o.KnownHosts != nil ||
		o.Branch != nil || o.LFSThreshold != nil || o.Quiet != nil
}

// Transport is how a remote is reached.
type Transport string

const (
	TransportNone  Transport = ""
	TransportSSH   Transport = "ssh"
	TransportHTTPS Transport = "https"
	TransportFile  Transport = "file"
)

// Settings are the export's effective settings: the file, then the flags, then
// the defaults, checked. Source says where each came from ("file", "flag" or
// "default"), for `trewd git-export status`.
type Settings struct {
	Enabled      bool
	Remote       string
	Transport    Transport
	Host         string
	Key          string
	Token        string
	KnownHosts   string
	Branch       string
	LFSThreshold int64
	Quiet        time.Duration
	Source       map[string]string
}

// Apply returns c changed by ch and enabled, with the paths made absolute. It
// does not check the result; Resolve does.
func Apply(c config.GitExport, ch Change) (config.GitExport, error) {
	abs := func(p *string) (string, error) {
		if *p == "" {
			return "", nil
		}
		return filepath.Abs(*p)
	}
	var err error
	if ch.Local {
		c.Remote, c.Key, c.Token, c.KnownHosts = "", "", "", ""
	}
	if ch.Remote != nil {
		c.Remote = strings.TrimSpace(*ch.Remote)
	}
	if ch.Key != nil {
		if c.Key, err = abs(ch.Key); err != nil {
			return c, err
		}
	}
	if ch.Token != nil {
		if c.Token, err = abs(ch.Token); err != nil {
			return c, err
		}
	}
	if ch.KnownHosts != nil {
		if c.KnownHosts, err = abs(ch.KnownHosts); err != nil {
			return c, err
		}
	}
	if ch.Branch != nil {
		c.Branch = *ch.Branch
	}
	if ch.LFSThreshold != nil {
		v := *ch.LFSThreshold
		c.LFSThreshold = &v
	}
	if ch.Quiet != nil {
		c.Quiet = *ch.Quiet
	}
	c.Enabled = true
	return c, nil
}

// Resolve is the effective settings: the file's section c, ov over it, the
// defaults under both, and every check a setting must pass. The error names
// the setting and what to do.
func Resolve(dataDir string, c config.GitExport, ov Overrides) (Settings, error) {
	s := Settings{Source: map[string]string{}}
	pick := func(name string, file string, flag *string, def string) string {
		switch {
		case flag != nil:
			s.Source[name] = "flag"
			return *flag
		case file != "":
			s.Source[name] = "file"
			return file
		}
		s.Source[name] = "default"
		return def
	}
	s.Enabled = c.Enabled
	s.Source["enabled"] = "file"
	if ov.Enabled != nil {
		s.Enabled, s.Source["enabled"] = *ov.Enabled, "flag"
	} else if ov.Any() {
		// A git-export flag given to serve asks for the export.
		s.Enabled, s.Source["enabled"] = true, "flag"
	}
	s.Remote = pick("remote", c.Remote, ov.Remote, "")
	s.Key = pick("key", c.Key, ov.Key, "")
	s.Token = pick("token", c.Token, ov.Token, "")
	s.KnownHosts = pick("known_hosts", c.KnownHosts, ov.KnownHosts, "")
	s.Branch = pick("branch", c.Branch, ov.Branch, DefaultBranch)

	switch {
	case ov.LFSThreshold != nil:
		s.LFSThreshold, s.Source["lfs_threshold"] = *ov.LFSThreshold, "flag"
	case c.LFSThreshold != nil:
		s.LFSThreshold, s.Source["lfs_threshold"] = *c.LFSThreshold, "file"
	default:
		s.LFSThreshold, s.Source["lfs_threshold"] = DefaultLFSThreshold, "default"
	}
	switch {
	case ov.Quiet != nil:
		s.Quiet, s.Source["quiet"] = *ov.Quiet, "flag"
	case c.Quiet != "":
		d, err := time.ParseDuration(c.Quiet)
		if err != nil {
			return s, fmt.Errorf("git_export.quiet %q is not a duration like 5m: %w", c.Quiet, err)
		}
		s.Quiet, s.Source["quiet"] = d, "file"
	default:
		s.Quiet, s.Source["quiet"] = DefaultQuiet, "default"
	}
	if !s.Enabled {
		return s, nil
	}
	return s, s.check(dataDir)
}

// check is every rule a setting must pass before anything is exported with it.
func (s *Settings) check(dataDir string) error {
	if err := CheckBranch(s.Branch); err != nil {
		return err
	}
	if s.LFSThreshold < 0 {
		return fmt.Errorf("the LFS threshold is %d bytes; it is a size, or 0 to keep every file out of LFS", s.LFSThreshold)
	}
	if s.Quiet < 0 || s.Quiet > MaxQuiet {
		return fmt.Errorf("the quiet window is %s; it is between 0 and %s", s.Quiet, MaxQuiet)
	}
	if s.Remote == "" {
		if s.Key != "" || s.Token != "" {
			return errors.New("a credential is set and no remote is: give -remote, or leave the credential out for a local export")
		}
		return nil
	}
	t, host, err := ParseRemote(s.Remote)
	if err != nil {
		return err
	}
	s.Transport, s.Host = t, host
	switch t {
	case TransportSSH:
		if s.Token != "" {
			return errors.New("an SSH remote takes -key, the deploy key's private half, not -token")
		}
		if s.Key == "" {
			return errors.New("an SSH remote needs -key, the private half of a deploy key that can write to it")
		}
		if err := CheckSecretFile("-key", s.Key); err != nil {
			return err
		}
		if s.KnownHosts == "" {
			if host != "github.com" {
				return fmt.Errorf("the host %s is not one this build knows the keys of: give -known-hosts, a "+
					"known_hosts file holding its key, checked against the fingerprints its operator publishes", host)
			}
			s.KnownHosts = filepath.Join(dataDir, Dir, "known_hosts")
			s.Source["known_hosts"] = "default"
		} else if _, err := os.Stat(s.KnownHosts); err != nil {
			return fmt.Errorf("-known-hosts %s: %w", s.KnownHosts, err)
		}
		if strings.ContainsAny(s.Key+s.KnownHosts, "\x00\n") {
			return errors.New("the key and known_hosts paths cannot hold a newline")
		}
	case TransportHTTPS:
		if s.Key != "" {
			return errors.New("an HTTPS remote takes -token, a file holding an access token, not -key")
		}
		if s.Token == "" {
			return errors.New("an HTTPS remote needs -token, a file holding an access token for that one repository")
		}
		if err := CheckSecretFile("-token", s.Token); err != nil {
			return err
		}
		if strings.ContainsAny(s.Token, "\x00\n") {
			return errors.New("the token path cannot hold a newline")
		}
	case TransportFile:
		if s.Key != "" || s.Token != "" {
			return errors.New("a file:// remote takes no credential")
		}
	}
	return nil
}

// ParseRemote says how a remote is reached, and its host. Accepted are an SSH
// remote in either spelling (git@github.com:owner/repo.git or
// ssh://git@host[:port]/path), https://, and file:/// for a repository on this
// machine. A URL that carries a password or a token is refused: the
// configuration file names the credential's path and never holds it, and the
// remote is printed by status and doctor.
func ParseRemote(remote string) (Transport, string, error) {
	if strings.ContainsAny(remote, " \t\n\r\x00") {
		return "", "", fmt.Errorf("the remote %q has whitespace in it", remote)
	}
	if strings.HasPrefix(remote, "-") {
		return "", "", fmt.Errorf("the remote %q starts with a dash", remote)
	}
	if !strings.Contains(remote, "://") {
		// The scp-like SSH form: [user@]host:path, with the colon before
		// any slash.
		colon := strings.Index(remote, ":")
		slash := strings.Index(remote, "/")
		if colon <= 0 || (slash >= 0 && slash < colon) {
			return "", "", fmt.Errorf("the remote %q is not a URL; for a repository on this machine use file:///path", remote)
		}
		host := remote[:colon]
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		if host == "" || remote[colon+1:] == "" {
			return "", "", fmt.Errorf("the remote %q names no host or no repository", remote)
		}
		return TransportSSH, strings.ToLower(host), nil
	}
	u, err := url.Parse(remote)
	if err != nil {
		return "", "", fmt.Errorf("the remote %q is not a URL: %w", remote, err)
	}
	if _, has := u.User.Password(); has {
		return "", "", errors.New("the remote carries a password or a token in its URL; give the token in a file with -token")
	}
	switch u.Scheme {
	case "ssh":
		if u.Hostname() == "" || strings.Trim(u.Path, "/") == "" {
			return "", "", fmt.Errorf("the remote %q names no host or no repository", remote)
		}
		return TransportSSH, strings.ToLower(u.Hostname()), nil
	case "https":
		if u.User != nil {
			return "", "", errors.New("the remote carries a user name in its URL; give the token in a file with -token")
		}
		if u.Hostname() == "" || strings.Trim(u.Path, "/") == "" {
			return "", "", fmt.Errorf("the remote %q names no host or no repository", remote)
		}
		return TransportHTTPS, strings.ToLower(u.Hostname()), nil
	case "file":
		if u.Host != "" || !filepath.IsAbs(u.Path) {
			return "", "", fmt.Errorf("the remote %q is not file:///absolute/path", remote)
		}
		return TransportFile, "", nil
	case "http", "git":
		return "", "", fmt.Errorf("the remote %q would send every note unencrypted; use ssh or https", remote)
	}
	return "", "", fmt.Errorf("the remote %q is not ssh, https or file", remote)
}

// CheckSecretFile refuses a credential file that is missing, is not a regular
// file, or can be read by anyone but its owner. The file itself is never read
// here, and never copied.
func CheckSecretFile(flag, path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("%s %s: the path must be absolute", flag, path)
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("%s %s: %w", flag, path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s %s is not a regular file", flag, path)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("%s %s is mode %04o, readable by others than its owner; chmod 600 it and run this again",
			flag, path, perm)
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("%s %s cannot be read by this server: %w", flag, path, err)
	}
	return f.Close()
}

// CheckBranch refuses a branch name Git would refuse, or would read as
// something other than a branch: the rules of git check-ref-format, applied
// here so a bad name is refused when it is set rather than when the first
// commit is made.
func CheckBranch(b string) error {
	bad := func(why string) error { return fmt.Errorf("the branch %q %s", b, why) }
	switch {
	case b == "":
		return bad("is empty")
	case len(b) > 200:
		return bad("is longer than 200 bytes")
	case strings.HasPrefix(b, "-"):
		return bad("starts with a dash")
	case b == "HEAD" || b == "@":
		return bad("is a name Git reserves")
	case strings.HasPrefix(b, "/") || strings.HasSuffix(b, "/") || strings.Contains(b, "//"):
		return bad("has an empty path component")
	case strings.HasSuffix(b, ".") || strings.Contains(b, "..") || strings.Contains(b, "@{"):
		return bad("has a sequence Git refuses (.., @{, or a trailing dot)")
	case strings.ContainsAny(b, " ~^:?*[\\\x7f"):
		return bad("has a character Git refuses in a branch name")
	}
	for _, r := range b {
		if r < 0x20 {
			return bad("has a control character")
		}
	}
	for _, part := range strings.Split(b, "/") {
		if strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return bad("has a component starting with a dot or ending in .lock")
		}
	}
	return nil
}
