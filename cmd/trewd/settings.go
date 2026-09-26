package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"text/tabwriter"
	"time"

	"github.com/waynehoover/trewsync/internal/config"
	"github.com/waynehoover/trewsync/internal/control"
	"github.com/waynehoover/trewsync/internal/dirlock"
	"github.com/waynehoover/trewsync/internal/gitexport"
	"github.com/waynehoover/trewsync/internal/mcp"
	"github.com/waynehoover/trewsync/internal/store"
)

// The configuration file (internal/config) and the serve flags over it.
//
// Every key in the file has a serve flag, and the rule is the same for each:
// a flag given to `trewd serve` wins over the file for as long as that server
// runs, and the file wins over the built-in default. So a unit file or a
// compose file can carry no flags at all once `trewd config set` has written
// the file, and a flag is still there for a one-off run.

// keyFlag is a serve flag standing for a configuration key.
type keyFlag struct {
	key     config.Key
	value   string
	given   bool
	boolean bool
}

func (f *keyFlag) String() string     { return f.value }
func (f *keyFlag) Set(v string) error { f.value, f.given = v, true; return nil }
func (f *keyFlag) IsBoolFlag() bool   { return f.boolean }

// overlay is the flags serve was given over the configuration file.
type overlay struct{ flags []*keyFlag }

// settingsFlags adds a flag for every configuration key to fs.
func settingsFlags(fs *flag.FlagSet) *overlay {
	o := &overlay{}
	for _, k := range config.Keys {
		f := &keyFlag{key: k, boolean: k.Name == "git_export.enabled"}
		fs.Var(f, strings.TrimPrefix(k.Flag, "-"), fmt.Sprintf("%s (default: %s); overrides %s in %s",
			k.Help, k.Default, k.Name, config.FileName))
		o.flags = append(o.flags, f)
	}
	return o
}

// over is f with every flag that was given set over it, and which keys they
// were. A value a key cannot take is refused naming the flag.
func (o *overlay) over(f config.File) (config.File, map[string]bool, error) {
	given := map[string]bool{}
	if o == nil {
		return f, given, nil
	}
	for _, fl := range o.flags {
		if !fl.given {
			continue
		}
		if err := fl.key.Set(&f, fl.value); err != nil {
			return f, nil, fmt.Errorf("%s: %w", fl.key.Flag, err)
		}
		given[fl.key.Name] = true
	}
	return f, given, nil
}

// gitOverrides are the git export's flags, for gitexport.Resolve, which
// reports each setting's source.
func (o *overlay) gitOverrides() (gitexport.Overrides, error) {
	var ov gitexport.Overrides
	flags, given, err := o.over(config.File{})
	if err != nil {
		return ov, err
	}
	g := flags.GitExport
	str := func(key string, v string) *string {
		if !given[key] {
			return nil
		}
		return &v
	}
	if given["git_export.enabled"] {
		ov.Enabled = &g.Enabled
	}
	ov.Remote, ov.Key, ov.Token = str("git_export.remote", g.Remote), str("git_export.key", g.Key), str("git_export.token", g.Token)
	ov.KnownHosts, ov.Branch = str("git_export.known_hosts", g.KnownHosts), str("git_export.branch", g.Branch)
	if given["git_export.lfs_threshold"] {
		ov.LFSThreshold = g.LFSThreshold
	}
	if given["git_export.quiet"] {
		d, err := time.ParseDuration(g.Quiet)
		if err != nil {
			return ov, fmt.Errorf("-git-export-quiet: %w", err)
		}
		ov.Quiet = &d
	}
	return ov, nil
}

// conventionsOf is the daily section as the MCP tools take it, checked, each
// setting named in a refusal by its flag when a flag gave it and by its key
// otherwise.
func conventionsOf(d config.Daily, given map[string]bool) (mcp.Conventions, error) {
	c := mcp.Conventions{DailyFolder: d.Folder, DailyFormat: d.Format, DailyTemplate: d.Template,
		TemplatesFolder: d.TemplatesFolder, DateFormat: d.TemplateDateFormat, TimeFormat: d.TemplateTimeFormat}
	name := func(flag string) string {
		for _, k := range config.Keys {
			if k.Flag == flag && !given[k.Name] {
				return k.Name
			}
		}
		return flag
	}
	if d.Timezone != "" {
		loc, err := time.LoadLocation(d.Timezone)
		if err != nil {
			return c, fmt.Errorf("%s %q: %w", name("-timezone"), d.Timezone, err)
		}
		c.Location = loc
	}
	return c, c.CheckNamed(name)
}

// serveSettings are what serve reads of the file and its flags: the
// daily-note conventions, which must be usable or serve does not start, and
// the git export's settings, whose trouble is the export's status and never
// a reason not to serve.
type serveSettings struct {
	conventions mcp.Conventions
	git         gitexport.Settings
	gitErr      error
}

func readSettings(dataDir string, o *overlay) (serveSettings, error) {
	var s serveSettings
	f, _, err := config.Load(dataDir)
	if err != nil {
		return s, err
	}
	merged, given, err := o.over(f)
	if err != nil {
		return s, err
	}
	if s.conventions, err = conventionsOf(merged.Daily, given); err != nil {
		return s, err
	}
	ov, err := o.gitOverrides()
	if err != nil {
		return s, err
	}
	s.git, s.gitErr = gitexport.Resolve(dataDir, f.GitExport, ov)
	return s, nil
}

// startGitExport starts the export's worker, which idles while the export
// is off: `trewd config set git_export.enabled true` turns it on without a
// restart.
func startGitExport(dataDir string, st *store.Store, vault string, s serveSettings, log *slog.Logger) *gitexport.Exporter {
	x := gitexport.Open(dataDir, st, vault, s.git, s.gitErr, log)
	switch {
	case s.gitErr != nil && s.git.Enabled:
		log.Error("the git export's settings cannot be used; the export is off until they are fixed",
			"err", s.gitErr, "hint", "`trewd git-export status` says more")
	case s.git.Enabled:
		log.Info("keeping a git history of the vault", "remote", s.git.Remote, "branch", s.git.Branch,
			"repository", gitexport.Dir+"/"+gitexport.RepoDir)
	}
	x.Start()
	return x
}

/* ---------------------------------------------------------------- *
 * Changing the file, through the server or without one
 * ---------------------------------------------------------------- */

// configMu serialises changes to the file within one process.
var configMu sync.Mutex

// change applies mutate to the file, checks the result as the export and the
// MCP tools would read it at the next start, writes it, and has a running
// server take it up.
func (o *operator) change(mutate func(*config.File) error) (config.File, error) {
	configMu.Lock()
	defer configMu.Unlock()
	f, _, err := config.Load(o.dataDir)
	if err != nil {
		return f, err
	}
	if err := mutate(&f); err != nil {
		return f, err
	}
	if _, err := gitexport.Resolve(o.dataDir, f.GitExport, gitexport.Overrides{}); err != nil {
		return f, fmt.Errorf("git_export: %w", err)
	}
	if _, err := conventionsOf(f.Daily, nil); err != nil {
		return f, err
	}
	if err := config.Save(o.dataDir, f); err != nil {
		return f, err
	}
	o.takeUp(f)
	return f, nil
}

// takeUp gives a running server's export and MCP tools the file's settings,
// with serve's flags still over them.
func (o *operator) takeUp(f config.File) {
	if o.export != nil {
		ov, err := o.flags.gitOverrides()
		s, rerr := gitexport.Resolve(o.dataDir, f.GitExport, ov)
		o.export.Reconfigure(s, errors.Join(err, rerr))
	}
	if o.mcp != nil {
		merged, given, err := o.flags.over(f)
		if err == nil {
			if conv, err := conventionsOf(merged.Daily, given); err == nil {
				o.mcp.SetConventions(conv)
			}
		}
	}
}

// configSetting is one key as `trewd config show` prints it.
type configSetting struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Source  string `json:"source"`
	InFile  string `json:"inFile,omitempty"`
	Flag    string `json:"flag"`
	Default string `json:"default"`
	Help    string `json:"help"`
}

// configView is the configuration as a server uses it, or as one would.
type configView struct {
	File     string          `json:"file"`
	Server   bool            `json:"server"`
	Settings []configSetting `json:"settings"`
	Note     string          `json:"note,omitempty"`
}

func (o *operator) view(f config.File, note string) control.Reply {
	merged, given, _ := o.flags.over(f)
	v := configView{File: config.Path(o.dataDir), Server: o.srv != nil, Note: note}
	for _, k := range config.Keys {
		s := configSetting{Key: k.Name, Flag: k.Flag, Default: k.Default, Help: k.Help, Source: "default", Value: k.Default}
		if val, ok := k.Get(&f); ok {
			s.InFile, s.Source, s.Value = val, "file", val
		}
		if given[k.Name] {
			val, _ := k.Get(&merged)
			s.Source, s.Value = "flag", val
		}
		v.Settings = append(v.Settings, s)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	return control.Reply{Config: b}
}

// configure answers the configuration requests.
func (o *operator) configure(ctx context.Context, req control.Request) control.Reply {
	switch req.Op {
	case "config-show":
		f, _, err := config.Load(o.dataDir)
		if err != nil {
			return control.Refused(control.CodeBadRequest, err.Error())
		}
		return o.view(f, "")
	case "config-set", "config-unset":
		k, ok := config.Lookup(req.Key)
		if !ok {
			return control.Refused(control.CodeBadRequest, fmt.Sprintf("%q is not a key; the keys are %s", req.Key, config.Names()))
		}
		f, err := o.change(func(f *config.File) error {
			if req.Op == "config-unset" {
				k.Unset(f)
				return nil
			}
			return k.Set(f, req.Value)
		})
		if err != nil {
			return control.Refused(control.CodeBadRequest, err.Error())
		}
		return o.view(f, o.noteFor(k))
	case "git-export":
		return o.gitExport(ctx, req)
	}
	return control.Refused(control.CodeBadRequest, fmt.Sprintf("unknown request %q", req.Op))
}

// noteFor says when a change to k takes effect.
func (o *operator) noteFor(k config.Key) string {
	_, given, _ := o.flags.over(config.File{})
	switch {
	case o.srv == nil:
		return "No server is running; `trewd serve` reads it when it starts."
	case given[k.Name]:
		return fmt.Sprintf("The running server was started with %s, which wins over the file until it is started without it.", k.Flag)
	case strings.HasPrefix(k.Name, "daily.") && o.mcp == nil:
		return "The running server serves no MCP endpoint; it is used once `trewd serve -mcp` runs."
	}
	return "The running server uses it now."
}

// gitExport is `trewd git-export set`, `status` and `disable`.
func (o *operator) gitExport(ctx context.Context, req control.Request) control.Reply {
	switch req.Action {
	case "set":
		var ch gitexport.Change
		if err := json.Unmarshal(req.GitExport, &ch); err != nil {
			return control.Refused(control.CodeBadRequest, "the change is not JSON: "+err.Error())
		}
		if _, err := o.change(func(f *config.File) error {
			g, err := gitexport.Apply(f.GitExport, ch)
			f.GitExport = g
			return err
		}); err != nil {
			return control.Refused(control.CodeBadRequest, err.Error())
		}
	case "disable":
		if _, err := o.change(func(f *config.File) error {
			f.GitExport.Enabled = false
			return nil
		}); err != nil {
			return control.Refused(control.CodeBadRequest, err.Error())
		}
	case "adopt":
		return o.adopt(ctx, req)
	case "status":
	default:
		return control.Refused(control.CodeBadRequest, fmt.Sprintf("git-export does %q? It does set, status, disable and adopt", req.Action))
	}
	st, err := o.gitStatus()
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	b, err := json.Marshal(st)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	return control.Reply{GitExport: b}
}

// adoptRequest is what `trewd git-export adopt` sends: the commit to adopt,
// or "" to look at the remote's branch.
type adoptRequest struct {
	Commit string `json:"commit,omitempty"`
}

// adopt is `trewd git-export adopt [SHA]`, done by the running export or,
// with no server, by one made for it here.
func (o *operator) adopt(ctx context.Context, req control.Request) control.Reply {
	var in adoptRequest
	if len(req.GitExport) > 0 {
		if err := json.Unmarshal(req.GitExport, &in); err != nil {
			return control.Refused(control.CodeBadRequest, "the request is not JSON: "+err.Error())
		}
	}
	f, _, err := config.Load(o.dataDir)
	if err != nil {
		return control.Refused(control.CodeBadRequest, err.Error())
	}
	ov, err := o.flags.gitOverrides()
	if err != nil {
		return control.Refused(control.CodeBadRequest, err.Error())
	}
	s, err := gitexport.Resolve(o.dataDir, f.GitExport, ov)
	if err != nil {
		return control.Refused(control.CodeBadRequest, "git_export: "+err.Error())
	}
	x := o.export
	if x == nil {
		x = gitexport.Open(o.dataDir, nil, "", s, nil, nil)
		defer x.Close()
	}
	a, err := x.Adopt(ctx, s, in.Commit, func(commit string) error {
		_, err := o.change(func(f *config.File) error {
			f.GitExport.Adopted = &config.GitExportAdopted{Remote: s.Remote, Branch: s.Branch, Commit: commit}
			return nil
		})
		return err
	})
	if err != nil {
		return control.Refused(control.CodeBadRequest, err.Error())
	}
	if a.Status, err = o.gitStatus(); err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	b, err := json.Marshal(a)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	return control.Reply{GitExport: b}
}

// gitStatus is the running export's status, or what the data directory says
// without one, with the tools this process finds.
func (o *operator) gitStatus() (gitexport.Status, error) {
	if o.export != nil {
		return o.export.Status(), nil
	}
	st, err := gitexport.Inspect(o.dataDir)
	if err != nil {
		return st, err
	}
	if st.Enabled {
		t := gitexport.FindTools(context.Background())
		st.Tools = &t
	}
	return st, nil
}

// configure sends a configuration request to the server serving dataDir or,
// when nothing is serving it, does it here, under the server lock taken
// exclusively so no server starts meanwhile. Unlike the credential commands it
// needs no store: the file is written before the first `serve` too, so a
// directory `mkdir` made is enough, provided it is not another product's.
func configure(dataDir string, req control.Request) (control.Reply, error) {
	info, err := os.Stat(dataDir)
	if err != nil || !info.IsDir() {
		return control.Reply{}, fmt.Errorf("there is no data directory at %s: make it, or check -data", dataDir)
	}
	if err := store.CheckDataDir(dataDir); err != nil {
		return control.Reply{}, err
	}
	// The server's own deadline, and a little more to hear its answer.
	ctx, cancel := context.WithTimeout(context.Background(), control.Timeout(req)+5*time.Second)
	defer cancel()
	reply, err := control.Call(ctx, dataDir, req)
	if err == nil || !errors.Is(err, control.ErrNotServing) {
		return reply, err
	}
	lock, err := dirlock.Exclusive(dataDir, dirlock.Server, "configure")
	if err != nil {
		return control.Reply{}, locked(err, dataDir, "configure",
			"A server holds this data directory and did not answer on its control socket.\n"+
				"Check that it is running, and run this again.")
	}
	defer lock.Release()
	return (&operator{dataDir: dataDir}).configure(ctx, req), nil
}

/* ---------------------------------------------------------------- *
 * trewd config
 * ---------------------------------------------------------------- */

// cmdConfig is `trewd config show`, `set KEY VALUE` and `unset KEY`.
func cmdConfig(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("config", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	asJSON := fs.Bool("json", false, "print the configuration as JSON")
	words, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	usage := errors.New("config takes show, set KEY VALUE, or unset KEY; the keys are " + config.Names())
	if len(words) == 0 {
		return usage
	}
	req := control.Request{Op: "config-show"}
	switch {
	case words[0] == "show" && len(words) == 1:
	case words[0] == "set" && len(words) == 3:
		req = control.Request{Op: "config-set", Key: words[1], Value: words[2]}
		// A path is made absolute here, against this shell's directory: the
		// server that writes it runs somewhere else.
		if k, ok := config.Lookup(req.Key); ok && k.Path && req.Value != "" {
			abs, err := filepath.Abs(req.Value)
			if err != nil {
				return err
			}
			req.Value = abs
		}
	case words[0] == "unset" && len(words) == 2:
		req = control.Request{Op: "config-unset", Key: words[1]}
	default:
		return usage
	}
	reply, err := configure(*dataDir, req)
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	var v configView
	if err := json.Unmarshal(reply.Config, &v); err != nil {
		return err
	}
	if *asJSON {
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n", b)
		return nil
	}
	if req.Op != "config-show" {
		for _, s := range v.Settings {
			if s.Key == req.Key {
				fmt.Fprintf(out, "%s is %s (%s), in %s\n", s.Key, s.Value, s.Source, v.File)
			}
		}
		if v.Note != "" {
			fmt.Fprintln(out, v.Note)
		}
		return nil
	}
	who := "no server is running"
	if v.Server {
		who = "as the running server uses it"
	}
	fmt.Fprintf(out, "%s, %s; a serve flag wins over the file, the file over the default\n\n", v.File, who)
	tw := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	for _, s := range v.Settings {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", s.Key, s.Value, s.Source)
	}
	return tw.Flush()
}

/* ---------------------------------------------------------------- *
 * trewd git-export
 * ---------------------------------------------------------------- */

// cmdGitExport is `trewd git-export set`, `status`, `disable` and `adopt`: the
// git_export section of the configuration file, and what the export is doing.
func cmdGitExport(args []string, out io.Writer) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return errors.New("git-export takes set, status, disable or adopt (docs/git-export.md)")
	}
	action, rest := args[0], args[1:]
	fs := flag.NewFlagSet("git-export "+action, flag.ContinueOnError)
	dataDir := dataFlags(fs)
	asJSON := fs.Bool("json", false, "print the export's status as JSON")
	var ch gitexport.Change
	var remote, key, token, knownHosts, branch, quiet, threshold *string
	if action == "set" {
		remote = fs.String("remote", "", "the repository to push to: git@github.com:owner/repo.git, ssh://, https:// or file:///")
		key = fs.String("key", "", "path to the SSH deploy key's private half, mode 0600")
		token = fs.String("token", "", "path to a file holding an access token for an HTTPS remote, mode 0600")
		knownHosts = fs.String("known-hosts", "", "path to the known_hosts file for an SSH remote (default for github.com: GitHub's published keys)")
		branch = fs.String("branch", "", "the branch to write and push (default main)")
		threshold = fs.String("lfs-threshold", "", "size above which a file goes to Git LFS, in bytes or with KiB, MiB or GiB; 0 for never (default 10MiB)")
		quiet = fs.String("quiet", "", "how long a device must stop writing before its versions are committed together (default 5m)")
		fs.BoolVar(&ch.Local, "local", false, "keep the export in the local repository only, clearing the remote and its credential")
	}
	words, err := parseInterspersed(fs, rest)
	if err != nil {
		return err
	}
	if action == "adopt" {
		return adoptCommand(*dataDir, words, *asJSON, out)
	}
	if len(words) != 0 {
		return fmt.Errorf("git-export %s takes no arguments, and was given %q", action, words)
	}
	req := control.Request{Op: "git-export", Action: action}
	switch action {
	case "set":
		var bad error
		// Paths are made absolute here, against this shell's directory: the
		// server that writes them runs somewhere else.
		abs := func(p *string) *string {
			if *p == "" {
				return p
			}
			v, err := filepath.Abs(*p)
			if err != nil {
				bad = err
			}
			return &v
		}
		fs.Visit(func(f *flag.Flag) {
			switch f.Name {
			case "remote":
				ch.Remote = remote
			case "key":
				ch.Key = abs(key)
			case "token":
				ch.Token = abs(token)
			case "known-hosts":
				ch.KnownHosts = abs(knownHosts)
			case "branch":
				ch.Branch = branch
			case "quiet":
				ch.Quiet = quiet
			case "lfs-threshold":
				n, err := config.ParseSize(*threshold)
				if err != nil {
					bad = fmt.Errorf("-lfs-threshold: %w", err)
				}
				ch.LFSThreshold = &n
			}
		})
		if bad != nil {
			return bad
		}
		b, err := json.Marshal(ch)
		if err != nil {
			return err
		}
		req.GitExport = b
	case "status", "disable":
	default:
		return fmt.Errorf("git-export does %q? It does set, status, disable and adopt", action)
	}
	reply, err := configure(*dataDir, req)
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	var st gitexport.Status
	if err := json.Unmarshal(reply.GitExport, &st); err != nil {
		return err
	}
	if *asJSON {
		b, err := json.MarshalIndent(st, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n", b)
		return nil
	}
	writeGitExport(out, st)
	return nil
}

// adoptCommand is `trewd git-export adopt [SHA]`: with no commit, fetch the
// remote's branch and show its tip; with the tip's commit given back, adopt
// it, so the export continues that history rather than refuse the branch.
func adoptCommand(dataDir string, words []string, asJSON bool, out io.Writer) error {
	if len(words) > 1 {
		return fmt.Errorf("git-export adopt takes at most one commit, and was given %q", words)
	}
	var in adoptRequest
	if len(words) == 1 {
		in.Commit = words[0]
	}
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	reply, err := configure(dataDir, control.Request{Op: "git-export", Action: "adopt", GitExport: b})
	if err != nil {
		return err
	}
	if err := refused(reply); err != nil {
		return err
	}
	var a gitexport.Adoption
	if err := json.Unmarshal(reply.GitExport, &a); err != nil {
		return err
	}
	if asJSON {
		b, err := json.MarshalIndent(a, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n", b)
		return nil
	}
	fmt.Fprintf(out, "the remote's branch %s (%s) is at\n  commit  %s\n  date    %s\n  subject %s\n",
		a.Branch, a.Remote, a.Commit, a.Date, a.Subject)
	if !a.Adopted {
		fmt.Fprintf(out, "\nNothing was changed. To keep this history and continue it, check that this is the\n"+
			"commit you expect, then run:\n\n  trewd git-export adopt %s\n", a.Commit)
		return nil
	}
	fmt.Fprintf(out, "\nadopted: the export's first commit on %s will be a child of %s, and its push a\n"+
		"fast-forward; the history under it is kept as it is.\n", a.Branch, a.Commit)
	if a.Dropped != "" {
		fmt.Fprintf(out, "The export's own branch here, at %s and never pushed, was set aside to be made\n"+
			"again on top of the adopted commit.\n", a.Dropped)
	}
	fmt.Fprintln(out)
	writeGitExport(out, a.Status)
	return nil
}

// writeGitExport prints the export's status for a person.
func writeGitExport(out io.Writer, st gitexport.Status) {
	if !st.Enabled {
		fmt.Fprintln(out, "the git export is off; `trewd git-export set` turns it on")
		if st.SettingsError != "" {
			fmt.Fprintln(out, "  its settings:", st.SettingsError)
		}
		return
	}
	src := func(key string) string {
		if s := st.Source[key]; s != "" && s != "file" {
			return " (" + s + ")"
		}
		return ""
	}
	fmt.Fprintf(out, "git export to %s, branch %s%s\n", st.Repository, st.Branch, src("branch"))
	if st.Remote != "" {
		cred := st.Key
		if st.Token != "" {
			cred = st.Token
		}
		fmt.Fprintf(out, "  remote %s%s, credential %s\n", st.Remote, src("remote"), cred)
	} else {
		fmt.Fprintln(out, "  no remote: the repository stays on this machine")
	}
	fmt.Fprintf(out, "  LFS above %s%s, quiet window %s%s\n", lfsThreshold(st.LFSThreshold), src("lfs_threshold"), st.Quiet, src("quiet"))
	if st.Adopted != "" {
		fmt.Fprintf(out, "  continues the history adopted at %s\n", st.Adopted)
	}
	if st.SettingsError != "" {
		fmt.Fprintln(out, "  the settings cannot be used:", st.SettingsError)
	}
	if st.Tools != nil && len(st.Tools.Missing) > 0 {
		fmt.Fprintln(out, "  missing:", strings.Join(st.Tools.Missing, "; "))
	}
	fmt.Fprintf(out, "  exported through uid %d, commit %s, last export %s\n", st.ExportedThrough, orNone(st.Commit),
		gitexport.Stamp(st.LastExportAt))
	if st.Refused != "" {
		fmt.Fprintln(out, "  REFUSED:", st.Refused)
	}
	if st.Error != "" {
		fmt.Fprintln(out, "  last error:", st.Error)
	}
	if st.Excluded > 0 {
		fmt.Fprintf(out, "  left out, as Git cannot hold them: %d paths (%s)\n", st.Excluded, strings.Join(st.ExcludedPaths, ", "))
	}
	if p := st.Push; p != nil {
		fmt.Fprintf(out, "  pushed %s, last attempt %s, last success %s\n", orNone(p.Pushed), gitexport.Stamp(p.LastAttemptAt),
			gitexport.Stamp(p.LastOKAt))
		if p.Refused != "" {
			fmt.Fprintln(out, "  PUSH REFUSED:", p.Refused)
		}
		if p.LastError != "" {
			fmt.Fprintln(out, "  last push error:", p.LastError)
		}
	}
}

func lfsThreshold(n int64) string {
	if n == 0 {
		return "nothing (LFS off)"
	}
	return humanBytes(n)
}

func orNone(s string) string {
	if s == "" {
		return "none yet"
	}
	return s
}
