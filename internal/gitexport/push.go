package gitexport

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Pushing. The remote is written to only by `git push` with a lease: the
// branch moves only from the commit the export last saw there, so a push can
// never overwrite a commit somebody else put on it. A remote branch found
// anywhere but where the export left it, or at a commit the export made, is
// refused, reported, and left alone until the operator runs `trewd git-export
// set` again, and even then a branch at a commit the export did not make is
// refused again. LFS objects go first, so the remote never holds a pointer to
// an object it does not have.

// errRefusedRemote is a push the export will not make.
var errRefusedRemote = errors.New("the remote was changed outside the export")

// lfsBatch is how many objects one `git lfs push` names.
const lfsBatch = 100

// pushStep pushes the branch when it has moved since the last push and the
// retry pace allows, and returns when it next wants to try.
func (x *Exporter) pushStep(ctx context.Context, r *runner, s Settings) time.Time {
	if s.Remote == "" {
		return time.Time{}
	}
	b, _, err := loadBranch(x.db, s.Branch)
	if err != nil || b.commit == "" {
		return time.Time{}
	}
	rs, err := loadRemote(x.db, s.Remote, s.Branch)
	if err != nil || rs.refused != "" || rs.pushed == b.commit {
		return time.Time{}
	}
	x.mu.Lock()
	next := x.nextPushAt
	x.mu.Unlock()
	if time.Now().Before(next) {
		return next
	}
	err = x.push(ctx, r, s, b.commit, &rs)
	now := x.st.Now().UnixMilli()
	rs.lastAttemptAt = now
	x.mu.Lock()
	defer x.mu.Unlock()
	switch {
	case err == nil:
		rs.pushed, rs.lastOKAt, rs.lastError = b.commit, now, ""
		x.pushBackoff, x.nextPushAt = 0, time.Time{}
		x.log.Info("the git export pushed", "branch", s.Branch, "commit", short(b.commit))
	case errors.Is(err, errRefusedRemote):
		rs.lastError = ""
		x.log.Error("the git export will not push: the remote's branch was changed outside the export",
			"why", rs.refused, "hint", "`trewd doctor` says what to do")
	default:
		rs.lastError = err.Error()
		x.pushBackoff = min(max(2*x.pushBackoff, pushRetryFirst), pushRetryMax)
		x.nextPushAt = time.Now().Add(x.pushBackoff)
		x.log.Warn("the git export could not push; sync is not affected, and it will try again", "err", err,
			"in", x.pushBackoff)
	}
	if serr := saveRemote(x.db, rs); serr != nil {
		x.log.Warn("the git export could not record its push", "err", serr)
	}
	return x.nextPushAt
}

// push sends tip, and every LFS object not yet sent, to the remote.
func (x *Exporter) push(ctx context.Context, r *runner, s Settings, tip string, rs *remoteState) error {
	switch s.Transport {
	case TransportSSH:
		if x.tools.SSH == "" {
			return errors.New("ssh is not on PATH, and the remote is reached over SSH")
		}
		if err := CheckSecretFile("-key", s.Key); err != nil {
			return err
		}
	case TransportHTTPS:
		if err := CheckSecretFile("-token", s.Token); err != nil {
			return err
		}
	}
	there, err := lsRemote(ctx, r, s.Branch)
	if err != nil {
		return err
	}
	expected := there
	switch {
	case there == rs.pushed:
	case there == "":
		rs.refused = fmt.Sprintf("the branch %s was deleted from the remote after the export pushed %s to it",
			s.Branch, short(rs.pushed))
		return errRefusedRemote
	case x.ours(ctx, r, there, tip):
		// A commit the export made, which a push it could not record put
		// there, or one pushed under an earlier configuration: moving on from
		// it overwrites nothing.
	case rs.pushed == "":
		rs.refused = fmt.Sprintf("the remote already has a branch %s, at %s, and the export did not make it",
			s.Branch, short(there))
		return errRefusedRemote
	default:
		rs.refused = fmt.Sprintf("the remote's branch %s is at %s, and the export left it at %s",
			s.Branch, short(there), short(rs.pushed))
		return errRefusedRemote
	}
	if err := x.pushLFS(ctx, r, s); err != nil {
		return err
	}
	x.point("lfs-pushed")
	_, err = r.run(ctx, remoteTimeout, nil, "push", "--porcelain", "--no-verify", "--quiet", remoteName,
		tip+":"+branchRef(s.Branch), "--force-with-lease="+branchRef(s.Branch)+":"+expected)
	return err
}

// ours reports whether sha is a commit on the branch the export made, at or
// before tip.
func (x *Exporter) ours(ctx context.Context, r *runner, sha, tip string) bool {
	_, err := r.run(ctx, localTimeout, nil, "merge-base", "--is-ancestor", sha, tip)
	return err == nil
}

// lsRemote is the commit the remote's branch is at, or "" when it has none.
func lsRemote(ctx context.Context, r *runner, branch string) (string, error) {
	out, err := r.run(ctx, remoteTimeout, nil, "ls-remote", "--refs", remoteName, branchRef(branch))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(out), "\n") {
		sha, ref, ok := strings.Cut(line, "\t")
		if ok && ref == branchRef(branch) {
			return sha, nil
		}
	}
	return "", nil
}

// pushLFS sends the objects this remote has not been sent.
func (x *Exporter) pushLFS(ctx context.Context, r *runner, s Settings) error {
	rows, err := x.db.Query(`SELECT oid FROM lfs_objects
	  WHERE oid NOT IN (SELECT oid FROM lfs_pushed WHERE remote = ?) ORDER BY oid`, s.Remote)
	if err != nil {
		return err
	}
	var oids []string
	for rows.Next() {
		var oid string
		if err := rows.Scan(&oid); err != nil {
			rows.Close()
			return err
		}
		oids = append(oids, oid)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(oids) == 0 {
		return nil
	}
	if x.tools.LFS == "" || !atLeast(x.tools.LFSVersion, MinLFS) {
		return fmt.Errorf("%d files are over the LFS threshold and git-lfs %s or later is not on PATH", len(oids), MinLFS)
	}
	for len(oids) > 0 {
		n := min(len(oids), lfsBatch)
		args := append([]string{"lfs", "push", "--object-id", remoteName}, oids[:n]...)
		if _, err := r.run(ctx, lfsTimeout, nil, args...); err != nil {
			return err
		}
		err := inTx(x.db, func(tx *sql.Tx) error {
			for _, oid := range oids[:n] {
				if _, err := tx.Exec(`INSERT INTO lfs_pushed (remote, oid) VALUES (?, ?) ON CONFLICT DO NOTHING`,
					s.Remote, oid); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		oids = oids[n:]
	}
	return nil
}

// exitCode is the exit status of a failed git call, or -1.
func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
