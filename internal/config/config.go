// Package config is the server's configuration file: the settings `trewd
// serve` reads at start that are not about the store, kept in the data
// directory so a unit file or a compose file does not have to carry them as
// flags.
//
// The file is DATA/trewd.json, mode 0600, one object with a section per
// feature:
//
//	{
//	  "git_export": {"enabled": true, "remote": "git@github.com:me/notes.git", ...},
//	  "daily": {"folder": "Journal", "timezone": "Europe/London", ...}
//	}
//
// It is written by `trewd config set KEY VALUE` and `trewd config unset
// KEY` (and `trewd git-export set`, which writes the git_export section),
// through the running server's control socket when a server runs, so the
// server checks the value and uses it at once, and directly otherwise. A
// person may edit it by hand with the server stopped; a key this build does
// not know is refused when the file is read, never ignored, so a typo is said.
//
// Precedence, setting by setting: a flag given to `trewd serve` wins over the
// file for as long as that server runs, and the file wins over the built-in
// default. A secret is never in the file: the Git export's credential is
// named by its path.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/waynehoover/trewsync/internal/fsync"
)

// FileName is the configuration file in the data directory.
const FileName = "trewd.json"

// File is the configuration file.
type File struct {
	GitExport GitExport `json:"git_export,omitzero"`
	Daily     Daily     `json:"daily,omitzero"`
}

// GitExport is the git_export section (internal/gitexport). Every field but
// Enabled may be absent, and then takes its default.
type GitExport struct {
	Enabled bool `json:"enabled,omitempty"`
	// Remote is the repository pushed to; empty keeps the export local.
	Remote string `json:"remote,omitempty"`
	// Key is the path to the SSH deploy key's private half, and Token the
	// path to a file holding an HTTPS access token. Paths, never secrets.
	Key        string `json:"key,omitempty"`
	Token      string `json:"token,omitempty"`
	KnownHosts string `json:"known_hosts,omitempty"`
	Branch     string `json:"branch,omitempty"`
	// LFSThreshold is the size in bytes above which a file goes to Git LFS,
	// 0 for never; nil is the default.
	LFSThreshold *int64 `json:"lfs_threshold,omitempty"`
	// Quiet is a Go duration ("5m").
	Quiet string `json:"quiet,omitempty"`
}

// Daily is the daily section: the vault's daily-note and template settings
// for the MCP tools today_note, append_to_daily and create_from_template,
// which Obsidian keeps in .obsidian/ where the server cannot read them.
type Daily struct {
	Folder             string `json:"folder,omitempty"`
	Format             string `json:"format,omitempty"`
	Template           string `json:"template,omitempty"`
	TemplatesFolder    string `json:"templates_folder,omitempty"`
	TemplateDateFormat string `json:"template_date_format,omitempty"`
	TemplateTimeFormat string `json:"template_time_format,omitempty"`
	Timezone           string `json:"timezone,omitempty"`
}

// Path is the configuration file in dataDir.
func Path(dataDir string) string { return filepath.Join(dataDir, FileName) }

// Load reads the file. Absent is (File{}, false, nil). A file that cannot be
// read, is not JSON, or holds a key this build does not know is an error,
// never taken as empty.
func Load(dataDir string) (File, bool, error) {
	b, err := os.ReadFile(Path(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return File{}, false, nil
	}
	if err != nil {
		return File{}, false, err
	}
	var f File
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return File{}, true, fmt.Errorf("%s: %w (`trewd config show` lists the keys)", Path(dataDir), err)
	}
	return f, true, nil
}

// Save writes the file whole, mode 0600: a temporary file, synced, renamed
// over the old one, and the directory synced.
func Save(dataDir string, f File) error {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, "."+FileName+".tmp-")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, Path(dataDir)); err != nil {
		return err
	}
	return fsync.Dir(dataDir)
}

// Key is one setting `trewd config set` takes.
type Key struct {
	// Name is section.key, as the file spells it.
	Name string
	// Flag is the serve flag that overrides it.
	Flag string
	// Default is what an unset key means, for a person.
	Default string
	// Help says what it is.
	Help string
	get  func(*File) (string, bool)
	set  func(*File, string) error
	// Path says the value is a file path, made absolute when it is set.
	Path bool
}

func str(p func(*File) *string) (func(*File) (string, bool), func(*File, string) error) {
	return func(f *File) (string, bool) { v := *p(f); return v, v != "" },
		func(f *File, v string) error { *p(f) = v; return nil }
}

// Keys are every setting, in the order `trewd config show` prints them.
var Keys = func() []Key {
	var keys []Key
	add := func(k Key, get func(*File) (string, bool), set func(*File, string) error) {
		k.get, k.set = get, set
		keys = append(keys, k)
	}
	g, s := str(func(f *File) *string { return &f.GitExport.Remote })
	add(Key{Name: "git_export.enabled", Flag: "-git-export", Default: "false",
		Help: "keep a Git history of the vault (docs/git-export.md)"},
		func(f *File) (string, bool) { return strconv.FormatBool(f.GitExport.Enabled), f.GitExport.Enabled },
		func(f *File, v string) error {
			b, err := strconv.ParseBool(v)
			if err != nil {
				return fmt.Errorf("git_export.enabled is true or false, not %q", v)
			}
			f.GitExport.Enabled = b
			return nil
		})
	add(Key{Name: "git_export.remote", Flag: "-git-export-remote", Default: "none: the repository stays local",
		Help: "the repository to push to: git@host:owner/repo.git, ssh://, https:// or file:///"}, g, s)
	g, s = str(func(f *File) *string { return &f.GitExport.Key })
	add(Key{Name: "git_export.key", Flag: "-git-export-key", Default: "none", Path: true,
		Help: "path to the SSH deploy key's private half, mode 0600, for an SSH remote"}, g, s)
	g, s = str(func(f *File) *string { return &f.GitExport.Token })
	add(Key{Name: "git_export.token", Flag: "-git-export-token", Default: "none", Path: true,
		Help: "path to a file holding an access token, mode 0600, for an HTTPS remote"}, g, s)
	g, s = str(func(f *File) *string { return &f.GitExport.KnownHosts })
	add(Key{Name: "git_export.known_hosts", Flag: "-git-export-known-hosts", Default: "GitHub's published keys, for github.com",
		Path: true, Help: "path to the known_hosts file an SSH remote's host key is checked against"}, g, s)
	g, s = str(func(f *File) *string { return &f.GitExport.Branch })
	add(Key{Name: "git_export.branch", Flag: "-git-export-branch", Default: "main",
		Help: "the branch the export writes and pushes"}, g, s)
	add(Key{Name: "git_export.lfs_threshold", Flag: "-git-export-lfs-threshold", Default: "10485760 (10 MiB)",
		Help: "size in bytes above which a file is stored in Git LFS; 0 never uses LFS"},
		func(f *File) (string, bool) {
			if f.GitExport.LFSThreshold == nil {
				return "", false
			}
			return strconv.FormatInt(*f.GitExport.LFSThreshold, 10), true
		},
		func(f *File, v string) error {
			n, err := ParseSize(v)
			if err != nil {
				return fmt.Errorf("git_export.lfs_threshold: %w", err)
			}
			f.GitExport.LFSThreshold = &n
			return nil
		})
	add(Key{Name: "git_export.quiet", Flag: "-git-export-quiet", Default: "5m",
		Help: "how long a device must stop writing before its versions are committed together"},
		func(f *File) (string, bool) { return f.GitExport.Quiet, f.GitExport.Quiet != "" },
		func(f *File, v string) error {
			if _, err := time.ParseDuration(v); err != nil {
				return fmt.Errorf("git_export.quiet is a duration like 5m, not %q", v)
			}
			f.GitExport.Quiet = v
			return nil
		})
	daily := []struct {
		name, flag, def, help string
		field                 func(*File) *string
	}{
		{"daily.folder", "-daily-folder", "the vault's root", "the folder daily notes are in (Obsidian's Daily notes \"New file location\")",
			func(f *File) *string { return &f.Daily.Folder }},
		{"daily.format", "-daily-format", "YYYY-MM-DD", "a daily note's name, as a moment.js date format",
			func(f *File) *string { return &f.Daily.Format }},
		{"daily.template", "-daily-template", "none", "the vault path of the note a new daily note is made from",
			func(f *File) *string { return &f.Daily.Template }},
		{"daily.templates_folder", "-templates-folder", "Templates", "the folder create_from_template finds templates in",
			func(f *File) *string { return &f.Daily.TemplatesFolder }},
		{"daily.template_date_format", "-template-date-format", "YYYY-MM-DD", "what a template's {{date}} writes",
			func(f *File) *string { return &f.Daily.TemplateDateFormat }},
		{"daily.template_time_format", "-template-time-format", "HH:mm", "what a template's {{time}} writes",
			func(f *File) *string { return &f.Daily.TemplateTimeFormat }},
		{"daily.timezone", "-timezone", "the server's local zone", "the IANA time zone \"today\" and {{time}} are read in",
			func(f *File) *string { return &f.Daily.Timezone }},
	}
	for _, d := range daily {
		g, s := str(d.field)
		add(Key{Name: d.name, Flag: d.flag, Default: d.def, Help: d.help}, g, s)
	}
	return keys
}()

// Lookup is the key named name, or false.
func Lookup(name string) (Key, bool) {
	for _, k := range Keys {
		if k.Name == name {
			return k, true
		}
	}
	return Key{}, false
}

// Names are every key's name, for a refusal.
func Names() string {
	names := make([]string, len(Keys))
	for i, k := range Keys {
		names[i] = k.Name
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// Get is the key's value in f, and whether it is set.
func (k Key) Get(f *File) (string, bool) { return k.get(f) }

// Set sets the key in f from its text, a path made absolute. The value's
// type is checked here; what it means is checked by the feature it belongs
// to, before the file is written (the caller's job).
func (k Key) Set(f *File, value string) error {
	if k.Path && value != "" {
		abs, err := filepath.Abs(value)
		if err != nil {
			return err
		}
		value = abs
	}
	return k.set(f, value)
}

// Unset returns the key to its default.
func (k Key) Unset(f *File) {
	if k.Name == "git_export.lfs_threshold" {
		f.GitExport.LFSThreshold = nil
		return
	}
	switch k.Name {
	case "git_export.enabled":
		f.GitExport.Enabled = false
	case "git_export.quiet":
		f.GitExport.Quiet = ""
	default:
		_ = k.set(f, "")
	}
}

// ParseSize reads a size in bytes: a number, or one with a KiB, MiB or GiB
// suffix.
func ParseSize(v string) (int64, error) {
	mult := int64(1)
	for _, u := range []struct {
		suffix string
		n      int64
	}{{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}} {
		if s, ok := strings.CutSuffix(v, u.suffix); ok {
			v, mult = strings.TrimSpace(s), u.n
			break
		}
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%q is not a size in bytes (or with KiB, MiB or GiB)", v)
	}
	return n * mult, nil
}
