package gitexport

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Adopting a branch. The export refuses a remote branch it did not make, and
// that stays the rule. Adoption is the one explicit exception, for a branch
// that already holds a history the owner wants kept, such as the one the
// obsidian-git plugin wrote: `trewd git-export adopt` fetches the branch and
// shows its tip, and `trewd git-export adopt SHA`, given that same commit
// back, records it as the adopted commit, in the configuration file
// (git_export.adopted) and in the branch's state row. The export's first
// commit on the branch is then a child of it, with a tree that is the store's
// notes and nothing of the adopted tree's, so the old history is kept under
// it and the first push is a fast-forward.
//
// Nothing about the rest changes. The adopted commit is part of the
// deterministic input: the first commit's parent and message name it, so a
// rebuild from scratch, which fetches that exact commit again, makes the same
// commits. The push accepts the remote's branch at the adopted commit only
// before the export has pushed there, and at the export's own commits after;
// anything else on the branch is refused as before, and the adopted history
// is never pushed over or rewritten.

// adoptedRef names the adopted commit in the export's repository, so it is
// kept whatever the branch does.
const adoptedRef = "refs/trew/adopted"

// fetchRef is where a fetch of the remote's branch lands, to be looked at.
const fetchRef = "refs/trew/fetched"

// Adoption is what `trewd git-export adopt` found, and did.
type Adoption struct {
	Remote string `json:"remote"`
	Branch string `json:"branch"`
	// Commit is the remote's branch's tip, with its subject and committer
	// date, as fetched.
	Commit  string `json:"commit"`
	Subject string `json:"subject"`
	Date    string `json:"date"`
	// Adopted says the commit was recorded as the adopted parent; false is
	// a look that changed nothing.
	Adopted bool `json:"adopted"`
	// Dropped is the commit the server's own repository had the branch at,
	// made by the export and never pushed, which adoption set aside so the
	// export makes the branch again on top of the adopted commit.
	Dropped string `json:"dropped,omitempty"`
	Status  Status `json:"status"`
}

// IsCommitName reports whether s is a full commit name: 40 lowercase
// hexadecimal digits.
func IsCommitName(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Adopt fetches the remote's branch under settings s and returns its tip.
// With sha "" that is all it does. With sha given, which must be that tip
// exactly, it records it as the adopted commit: record writes the
// configuration, and runs while the export's worker is held, so no step runs
// between the state and the file.
func (x *Exporter) Adopt(ctx context.Context, s Settings, sha string, record func(commit string) error) (Adoption, error) {
	a := Adoption{Remote: s.Remote, Branch: s.Branch}
	switch {
	case !s.Enabled:
		return a, errors.New("the git export is off; set it up with `trewd git-export set -remote URL ...` first")
	case s.Remote == "":
		return a, errors.New("the export has no remote to adopt a branch of; give it one with `trewd git-export set -remote URL ...`")
	}
	sha = strings.ToLower(strings.TrimSpace(sha))
	if sha != "" && !IsCommitName(sha) {
		return a, fmt.Errorf("%q is not a full commit name; give the 40 hexadecimal digits `trewd git-export adopt` printed", sha)
	}
	select {
	case x.step <- struct{}{}:
	case <-ctx.Done():
		return a, fmt.Errorf("the export is busy with a step: %w", ctx.Err())
	}
	defer func() { <-x.step }()

	// These settings into the repository's config, whatever was there, and
	// the worker's own again at its next step. No generation is 0.
	x.configured = 0
	r, err := x.prepare(ctx, s, -1)
	x.configured = 0
	if err != nil {
		return a, err
	}
	there, err := lsRemote(ctx, r, s.Branch)
	if err != nil {
		return a, err
	}
	if there == "" {
		return a, fmt.Errorf("the remote has no branch %s, so there is nothing to adopt: the export makes the branch itself", s.Branch)
	}
	if _, err := r.run(ctx, remoteTimeout, nil, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remoteName,
		"+"+branchRef(s.Branch)+":"+fetchRef); err != nil {
		return a, err
	}
	tipSHA, err := revParse(ctx, r, fetchRef)
	if err != nil {
		return a, err
	}
	if a.Subject, a.Date, err = describeCommit(ctx, r, tipSHA); err != nil {
		return a, err
	}
	a.Commit = tipSHA
	if sha == "" {
		return a, nil
	}
	if sha != tipSHA {
		return a, fmt.Errorf("the remote's branch %s is at %s (%s, %s), not %s; nothing was adopted. "+
			"Run `trewd git-export adopt` to look again", s.Branch, tipSHA, a.Subject, a.Date, sha)
	}

	rs, err := loadRemote(x.db, s.Remote, s.Branch)
	if err != nil {
		return a, err
	}
	if rs.pushed != "" {
		return a, fmt.Errorf("the export has already pushed %s to the remote's branch %s; there is nothing to adopt",
			short(rs.pushed), s.Branch)
	}
	b, found, err := loadBranch(x.db, s.Branch)
	if err != nil {
		return a, err
	}
	if found && b.commit != "" && x.ours(ctx, r, tipSHA, b.commit, "") {
		return a, fmt.Errorf("the remote's branch %s is at %s, a commit the export made; there is nothing to adopt",
			s.Branch, short(tipSHA))
	}
	ref, err := revParse(ctx, r, branchRef(s.Branch))
	if err != nil {
		return a, err
	}
	switch {
	case !found && ref != "":
		return a, fmt.Errorf("the server's repository has a branch %s at %s that the export did not make; "+
			"nothing was adopted", s.Branch, short(ref))
	case found && b.adopted != sha && (b.commit != "" || b.pendingSHA != ""):
		// The export made the branch here on its own and never pushed it
		// anywhere: set it aside, to be made again on top of the adopted
		// commit, identically but for the parent.
		var pushed string
		if err := x.db.QueryRow(`SELECT remote FROM remotes WHERE branch = ? AND pushed_sha != '' LIMIT 1`,
			s.Branch).Scan(&pushed); err == nil {
			return a, fmt.Errorf("the export has already pushed its branch %s to %s; adopt into another branch "+
				"(`trewd git-export set -branch NAME`) rather than make a second history of this one", s.Branch, pushed)
		}
		if ref != b.commit && (b.pendingSHA == "" || ref != b.pendingSHA) {
			return a, fmt.Errorf("the server's repository has the branch %s at %s, and the export left it at %s; "+
				"nothing was adopted", s.Branch, short(ref), short(b.commit))
		}
		if ref != "" {
			if _, err := r.run(ctx, localTimeout, nil, "update-ref", "-d", branchRef(s.Branch), ref); err != nil {
				return a, err
			}
		}
		if _, err := x.db.Exec(`DELETE FROM branches WHERE branch = ?`, s.Branch); err != nil {
			return a, err
		}
		x.tree, x.treeOf = nil, ""
		a.Dropped = ref
		x.log.Warn("the git export set aside its own unpushed branch to make it again on the adopted commit",
			"branch", s.Branch, "was", short(ref), "adopted", short(sha))
	}
	if _, err := r.run(ctx, localTimeout, nil, "update-ref", adoptedRef, sha); err != nil {
		return a, err
	}
	if _, err := x.db.Exec(`UPDATE remotes SET refused = '', last_error = '' WHERE remote = ? AND branch = ?`,
		s.Remote, s.Branch); err != nil {
		return a, err
	}
	if err := record(sha); err != nil {
		return a, err
	}
	a.Adopted = true
	x.log.Info("the git export adopted the remote's branch", "branch", s.Branch, "commit", sha, "subject", a.Subject)
	return a, nil
}

// describeCommit is a commit's subject and committer date.
func describeCommit(ctx context.Context, r *runner, sha string) (subject, date string, err error) {
	out, err := r.run(ctx, localTimeout, nil, "show", "-s", "--format=%cI%x00%s", sha)
	if err != nil {
		return "", "", err
	}
	date, subject, _ = strings.Cut(strings.TrimRight(string(out), "\n"), "\x00")
	return subject, date, nil
}

// hasCommit reports whether the repository holds the commit sha.
func hasCommit(ctx context.Context, r *runner, sha string) bool {
	_, err := r.run(ctx, localTimeout, nil, "cat-file", "-e", sha+"^{commit}")
	return err == nil
}

// haveAdopted makes sure the repository holds the adopted commit before the
// first commit is written on top of it: in a repository made again from
// scratch it is fetched again, that exact commit, from the remote's branch,
// which holds it under the export's own commits, or by its name.
func (x *Exporter) haveAdopted(ctx context.Context, r *runner, s Settings, sha string) error {
	if !hasCommit(ctx, r, sha) {
		if s.Remote == "" {
			return fmt.Errorf("the adopted commit %s is not in the repository, and there is no remote to fetch it from", short(sha))
		}
		_, err := r.run(ctx, remoteTimeout, nil, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remoteName,
			"+"+branchRef(s.Branch)+":"+fetchRef)
		if err != nil || !hasCommit(ctx, r, sha) {
			if _, err2 := r.run(ctx, remoteTimeout, nil, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
				remoteName, sha+":"+fetchRef); err2 != nil && err == nil {
				err = err2
			}
		}
		if !hasCommit(ctx, r, sha) {
			return fmt.Errorf("the adopted commit %s is not in the repository, and the remote did not give it: %v", short(sha), err)
		}
	}
	_, err := r.run(ctx, localTimeout, nil, "update-ref", adoptedRef, sha)
	return err
}

// continuation is the message of the first commit on top of an adopted
// commit: what it continues, then the commit's own message, with a trailer
// naming the adopted commit.
func continuation(adopted, msg string) string {
	return fmt.Sprintf("TrewSync continues the history from obsidian-git at %s\n\n"+
		"The commits before this one were made by obsidian-git, or by whatever wrote\n"+
		"this branch before TrewSync, and are kept as they were. From this commit on,\n"+
		"TrewSync's git export writes the branch from the notes its server stores.\n"+
		"This commit's tree is the vault as TrewSync holds it, so its diff against\n"+
		"%s also shows what TrewSync does not sync, such as .obsidian/.\n\n"+
		"%sTrew-Continues: %s\n", short(adopted), short(adopted), msg, adopted)
}

func orNothing(sha string) string {
	if sha == "" {
		return "nothing"
	}
	return short(sha)
}
