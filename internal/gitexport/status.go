package gitexport

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/waynehoover/trewsync/internal/config"
)

// Status is what the export says about itself: for `trewd git-export
// status`, the control socket's status, and `trewd doctor`. It never holds a
// credential: the key and token are named by their paths, and the remote was
// refused at set time if it carried one.
type Status struct {
	Enabled bool `json:"enabled"`
	// SettingsError is why the settings cannot be used, when they cannot.
	SettingsError string            `json:"settingsError,omitempty"`
	Remote        string            `json:"remote,omitempty"`
	Transport     Transport         `json:"transport,omitempty"`
	Key           string            `json:"key,omitempty"`
	Token         string            `json:"token,omitempty"`
	KnownHosts    string            `json:"knownHosts,omitempty"`
	Branch        string            `json:"branch"`
	LFSThreshold  int64             `json:"lfsThreshold"`
	Quiet         string            `json:"quiet"`
	Source        map[string]string `json:"source,omitempty"`
	Repository    string            `json:"repository"`

	// Tools is what was found of git, git-lfs and ssh, by the server running
	// the export, or by the command asking when no server runs.
	Tools *Tools `json:"tools,omitempty"`

	// ExportedThrough is the last uid a commit on the branch covers, Commit
	// the commit the branch is at, and Epoch the store epoch it was exported
	// from.
	ExportedThrough int64  `json:"exportedThrough"`
	Commit          string `json:"commit,omitempty"`
	Epoch           string `json:"epoch,omitempty"`
	LastExportAt    int64  `json:"lastExportAt,omitempty"`
	// Error is the last error a step met, which it retries.
	Error string `json:"error,omitempty"`
	// Refused is why the export will not go on with the local repository:
	// its branch is somewhere the export did not put it.
	Refused string `json:"refused,omitempty"`
	// Excluded are paths Git cannot hold, which the export leaves out.
	Excluded      int      `json:"excluded,omitempty"`
	ExcludedPaths []string `json:"excludedPaths,omitempty"`

	Push *PushStatus `json:"push,omitempty"`
}

// PushStatus is the remote's side.
type PushStatus struct {
	// Pushed is the commit last pushed to the remote's branch.
	Pushed        string `json:"pushed,omitempty"`
	LastAttemptAt int64  `json:"lastAttemptAt,omitempty"`
	LastOKAt      int64  `json:"lastOkAt,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	// Refused is why the export will not push: the remote's branch is
	// somewhere the export did not put it.
	Refused       string `json:"refused,omitempty"`
	NextAttemptAt int64  `json:"nextAttemptAt,omitempty"`
}

// describe fills the settings half of a Status.
func describe(dataDir string, s Settings, settingsErr string) Status {
	st := Status{Enabled: s.Enabled, SettingsError: settingsErr, Remote: s.Remote, Transport: s.Transport,
		Key: s.Key, Token: s.Token, KnownHosts: s.KnownHosts, Branch: s.Branch, LFSThreshold: s.LFSThreshold,
		Quiet: s.Quiet.String(), Source: s.Source, Repository: filepath.Join(dataDir, Dir, RepoDir)}
	return st
}

// fillState reads the branch's and the remote's rows into st.
func fillState(db *sql.DB, st *Status) error {
	b, found, err := loadBranch(db, st.Branch)
	if err != nil {
		return err
	}
	if found {
		st.ExportedThrough, st.Commit, st.Epoch = b.through, b.commit, b.epoch
	}
	if st.Remote == "" {
		return nil
	}
	rs, err := loadRemote(db, st.Remote, st.Branch)
	if err != nil {
		return err
	}
	st.Push = &PushStatus{Pushed: rs.pushed, LastAttemptAt: rs.lastAttemptAt, LastOKAt: rs.lastOKAt,
		LastError: rs.lastError, Refused: rs.refused}
	return nil
}

// Status is the running export's status.
func (x *Exporter) Status() Status {
	x.mu.Lock()
	s, bad, ws := x.settings, x.settingsErr, x.status
	excluded := sortedKeys(ws.excluded, 20)
	x.mu.Unlock()
	st := describe(x.dataDir, s, bad)
	if ws.tools.Git != "" || len(ws.tools.Missing) > 0 {
		t := ws.tools
		st.Tools = &t
	}
	st.LastExportAt, st.Error, st.Refused = ws.lastExportAt, ws.lastError, ws.refused
	st.Excluded, st.ExcludedPaths = len(ws.excluded), excluded
	if s.Enabled && bad == "" {
		if db, err := openStateIfThere(x.dataDir); err == nil && db != nil {
			if err := fillState(db, &st); err != nil && st.Error == "" {
				st.Error = "reading the export's state: " + err.Error()
			}
			db.Close()
		}
	}
	// Read after the rows: a push records its error in the row while it
	// holds mu, having set the next attempt first, so a row with an error
	// is never paired with a next attempt from before it.
	x.mu.Lock()
	nextPush := x.nextPushAt
	x.mu.Unlock()
	if st.Push != nil && !nextPush.IsZero() {
		st.Push.NextAttemptAt = nextPush.UnixMilli()
	}
	return st
}

// openStateIfThere opens the state database read-only, or nil when there is
// none yet.
func openStateIfThere(dataDir string) (*sql.DB, error) {
	dir := filepath.Join(dataDir, Dir)
	if _, err := os.Stat(filepath.Join(dir, StateFile)); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return openState(dir, true)
}

// Inspect is the export's status read from the data directory alone, without
// a running server and without writing: the configuration, the state rows,
// and the tools this process finds. The worker's last error and a refusal of
// the local repository are known only to a running server; Inspect checks the
// branch itself, read-only, for the second.
func Inspect(dataDir string) (Status, error) {
	f, _, err := config.Load(dataDir)
	if err != nil {
		return Status{SettingsError: err.Error(), Repository: filepath.Join(dataDir, Dir, RepoDir)}, nil
	}
	s, rerr := Resolve(dataDir, f.GitExport, Overrides{})
	bad := ""
	if rerr != nil {
		bad = rerr.Error()
	}
	st := describe(dataDir, s, bad)
	if !s.Enabled {
		return st, nil
	}
	db, err := openStateIfThere(dataDir)
	if err != nil {
		return st, err
	}
	if db != nil {
		defer db.Close()
		if err := fillState(db, &st); err != nil {
			return st, err
		}
		b, _, err := loadBranch(db, st.Branch)
		if err != nil {
			return st, err
		}
		st.Refused = checkRef(dataDir, st.Branch, b)
	}
	return st, nil
}

// checkRef is why the repository's branch is not where the state row left
// it, read without a server and without writing, or "" when it is, or when
// git is not here to ask.
func checkRef(dataDir, branch string, b branchState) string {
	gitPath, err := lookPath("git")
	if err != nil || b.commit == "" && b.pendingSHA == "" {
		return ""
	}
	dir := filepath.Join(dataDir, Dir)
	r := &runner{git: gitPath, gitDir: filepath.Join(dir, RepoDir), home: filepath.Join(dir, "home")}
	if _, err := os.Stat(r.home); err != nil {
		r.home = os.TempDir()
	}
	ref, err := revParse(context.Background(), r, branchRef(branch))
	if err != nil || ref == b.commit || (b.pendingSHA != "" && ref == b.pendingSHA) {
		return ""
	}
	if ref == "" {
		return fmt.Sprintf("the branch %s was deleted from the repository; the export had it at %s", branch, short(b.commit))
	}
	return fmt.Sprintf("the branch %s is at %s, and the export left it at %s", branch, short(ref), short(b.commit))
}

// Stamp formats a millisecond time for a person.
func Stamp(ms int64) string {
	if ms == 0 {
		return "never"
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}
