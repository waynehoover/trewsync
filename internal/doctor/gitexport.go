package doctor

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/waynehoover/trew/internal/gitexport"
)

// GitExportLagAfter is how long past its quiet window a version may wait to be
// committed before the export is behind rather than busy.
const GitExportLagAfter = 15 * time.Minute

// gitExport checks the Git export: that its settings and its tools are
// usable, that neither the repository's branch nor the remote's was moved
// outside it, how far it trails the vault, and whether the last push worked.
// It reads the running server's report when a server answered, and the data
// directory otherwise; it never runs a git that writes, and it never prints a
// credential, only the path to one.
func (r *run) gitExport() {
	var st gitexport.Status
	live := false
	if r.status != nil && len(r.status.GitExport) > 0 && json.Unmarshal(r.status.GitExport, &st) == nil {
		live = true
	} else {
		var err error
		if st, err = gitexport.Inspect(r.opt.DataDir); err != nil {
			r.bad(Warn, CheckGitExport, fmt.Sprintf("the git export's state cannot be read: %v", err),
				"It is derived: stop the server, move the data directory's "+gitexport.Dir+" aside, and `trewd serve` exports again.")
			return
		}
		if st.Enabled {
			t := gitexport.FindTools(context.Background())
			st.Tools = &t
		}
	}
	if !st.Enabled {
		if st.SettingsError != "" {
			r.bad(Warn, CheckGitExport, "the configuration file cannot be read: "+st.SettingsError,
				"`trewd config show` names the file; fix or remove the key it names.")
			return
		}
		r.note(CheckGitExport, "the git export is off; `trewd git-export set` keeps a Git history of the vault (docs/git-export.md)")
		return
	}
	where := st.Repository
	if st.Remote != "" {
		where = st.Remote
	}
	switch {
	case st.SettingsError != "":
		r.bad(Fail, CheckGitExport, "the git export's settings cannot be used: "+st.SettingsError,
			"Nothing is exported until they are fixed. `trewd git-export set` with the setting it names checks it again.")
		return
	case st.Tools != nil && (st.Tools.Git == "" || !gitToolOK(st.Tools)):
		r.bad(Fail, CheckGitExport, "the git export cannot run: "+strings.Join(st.Tools.Missing, "; "),
			fmt.Sprintf("Install git %s or later (and git-lfs %s or later for a remote) on the server's PATH; the "+
				"container image and the Nix package carry both. Sync is not affected.", gitexport.MinGit, gitexport.MinLFS))
		return
	case st.Refused != "":
		r.bad(Fail, CheckGitExport, "the git export stopped: "+st.Refused,
			"The export never moves a branch back. If the change was a mistake, put the branch back at the commit the "+
				"export left it at and it goes on. Otherwise export to another branch with `trewd git-export set -branch "+
				"NAME`, or stop the server and move "+gitexport.Dir+" aside to export again from the start.")
		return
	case st.Push != nil && st.Push.Refused != "":
		r.bad(Fail, CheckGitExport, "the git export will not push: "+st.Push.Refused,
			"Somebody changed the remote's branch, and the export never pushes over a commit it did not make. Find out "+
				"what changed it. To push to a new branch instead, `trewd git-export set -branch NAME`; once the branch "+
				"is back at a commit the export made, `trewd git-export set` with no flags pushes again.")
		return
	}
	var problems []string
	status := OK
	worse := func(s Status, line string) {
		problems = append(problems, line)
		if s == Warn {
			status = Warn
		}
	}
	if st.Error != "" && live {
		worse(Warn, "its last step failed and is retried: "+st.Error)
	}
	if lag := r.gitLag(st); lag != "" {
		worse(Warn, lag)
	}
	if st.Tools != nil && st.Remote != "" && (st.Tools.LFS == "" || !atLeastLFS(st.Tools)) {
		worse(Warn, "git-lfs is missing or too old, so files over the LFS threshold cannot be pushed")
	}
	if p := st.Push; p != nil && p.LastError != "" {
		worse(Warn, fmt.Sprintf("the last push, at %s, failed: %s", stampOf(p.LastAttemptAt), p.LastError))
	}
	if st.Excluded > 0 {
		problems = append(problems, fmt.Sprintf("%d paths Git cannot hold are left out: %s", st.Excluded,
			strings.Join(st.ExcludedPaths, ", ")))
	}
	summary := fmt.Sprintf("exported to %s, branch %s, through uid %d of %d", where, st.Branch, st.ExportedThrough, r.latest)
	if p := st.Push; p != nil {
		if p.Pushed == st.Commit && p.Pushed != "" {
			summary += ", all of it pushed"
		} else {
			summary += fmt.Sprintf(", the remote at %s", orNothing(p.Pushed))
		}
	}
	if status == OK {
		r.add(Finding{Check: CheckGitExport, Status: OK, Summary: summary, Detail: problems})
		return
	}
	r.bad(Warn, CheckGitExport, summary+"; "+problems[0],
		"Sync is not affected: the export only reads what the store has committed. A push that fails is retried on "+
			"its own; check the remote, the credential (its path is in `trewd git-export status`) and the log.",
		problems[1:]...)
}

// gitLag is why the export is behind, or "": a version older than the quiet
// window and GitExportLagAfter that is not in a commit.
func (r *run) gitLag(st gitexport.Status) string {
	if r.st == nil || r.latest <= st.ExportedThrough {
		return ""
	}
	batch, ok, err := r.st.NextBatch(r.opt.Vault, st.ExportedThrough, 1)
	if err != nil || !ok || len(batch.Entries) == 0 {
		return ""
	}
	uid := batch.Entries[0].UID
	times, err := r.st.CommitTimes(r.opt.Vault, uid, uid)
	if err != nil {
		return ""
	}
	at, timed := times[uid]
	quiet, _ := time.ParseDuration(st.Quiet)
	behind := r.latest - st.ExportedThrough
	if !timed {
		if behind > IndexLagUIDs {
			return fmt.Sprintf("%d versions are not exported yet", behind)
		}
		return ""
	}
	if age := r.now.Sub(time.UnixMilli(at)); age > quiet+GitExportLagAfter {
		return fmt.Sprintf("%d versions are not exported yet, the oldest committed %s ago", behind, age.Round(time.Minute))
	}
	return ""
}

func gitToolOK(t *gitexport.Tools) bool {
	for _, m := range t.Missing {
		if strings.HasPrefix(m, "git ") {
			return false
		}
	}
	return true
}

func atLeastLFS(t *gitexport.Tools) bool {
	for _, m := range t.Missing {
		if strings.HasPrefix(m, "git-lfs") {
			return false
		}
	}
	return true
}

func orNothing(sha string) string {
	if sha == "" {
		return "nothing yet"
	}
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}
