package gitexport

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// bareRemote is an empty bare repository to push to, as a file:// URL: git-lfs
// sends LFS objects to one with its standalone file transfer, into the
// remote's own lfs/objects, which is what a test without a network can check.
func bareRemote(t *testing.T) (dir, url string) {
	t.Helper()
	dir = filepath.Join(t.TempDir(), "remote.git")
	git(t, filepath.Dir(dir), "init", "-q", "--bare", dir)
	return dir, "file://" + dir
}

// freshClone clones the remote's branch and pulls its LFS objects, as a person
// reading the export would.
func freshClone(t *testing.T, url string) string {
	t.Helper()
	work := filepath.Join(t.TempDir(), "clone")
	git(t, filepath.Dir(work), "clone", "-q", "-b", "main", url, work)
	git(t, work, "lfs", "install", "--local")
	git(t, work, "lfs", "pull")
	return work
}

// TestAPushSendsTheBranchAndItsLFSObjects: the remote's branch is the export's
// tip, and a fresh clone of it, with its LFS objects pulled, holds the store's
// files byte for byte, attachments included.
func TestAPushSendsTheBranchAndItsLFSObjects(t *testing.T) {
	r := newRig(t)
	remote, url := bareRemote(t)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, url))
	vaultOf(r, 25)
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	x.sync(t)
	if s := x.Status(); s.Push == nil || s.Push.LastError != "" || s.Push.Pushed != s.Commit {
		t.Fatalf("the push did not happen:\n%s", statusJSON(s))
	}
	if got := git(t, remote, "rev-parse", "main"); got != tip(t, out, "main") {
		t.Fatalf("the remote is at %s", got)
	}
	sameFiles(t, r.storeFiles(), checkout(t, freshClone(t, url)), nil)

	// And again after more changes, a fast-forward of the first push.
	first := tip(t, out, "main")
	r.put("Phone", "Notes/000.md", []byte("changed\n"))
	r.rename("Phone", "Attachments/photo [1].png", "Attachments/renamed.png", r.storeFiles()["Attachments/photo [1].png"])
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	x.sync(t)
	if _, err := gitErr(remote, "merge-base", "--is-ancestor", first, "main"); err != nil {
		t.Fatal("the second push is not a fast-forward of the first")
	}
	sameFiles(t, r.storeFiles(), checkout(t, freshClone(t, url)), nil)
}

// TestARemoteChangedOutsideIsRefused: a commit somebody else pushed to the
// remote's branch is never overwritten. The export refuses, says so, and goes
// on refusing after `set` if the branch is still somebody else's; put back at
// a commit the export made, it pushes again.
func TestARemoteChangedOutsideIsRefused(t *testing.T) {
	r := newRig(t)
	remote, url := bareRemote(t)
	out := t.TempDir()
	s := settings(t, out, url)
	x := r.exporter(out, s)
	r.put("Laptop", "a.md", []byte("a\n"))
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	x.sync(t)
	pushed := git(t, remote, "rev-parse", "main")

	// Somebody commits to the remote directly.
	work := filepath.Join(t.TempDir(), "other")
	git(t, filepath.Dir(work), "clone", "-q", "-b", "main", url, work)
	git(t, work, "commit", "-q", "--allow-empty", "-m", "a commit the export did not make")
	git(t, work, "push", "-q", "origin", "main")
	foreign := git(t, remote, "rev-parse", "main")

	r.put("Laptop", "b.md", []byte("b\n"))
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	x.sync(t)
	st := x.Status()
	if st.Push == nil || !strings.Contains(st.Push.Refused, "the export left it at "+short(pushed)) {
		t.Fatalf("the changed remote is not refused:\n%s", statusJSON(st))
	}
	if got := git(t, remote, "rev-parse", "main"); got != foreign {
		t.Fatalf("the export moved the remote's branch to %s", got)
	}
	if st.Commit == pushed {
		t.Fatal("a refused push stopped the local export")
	}

	// `set` asks the export to look again; the branch is still foreign.
	x.Reconfigure(s, nil)
	x.sync(t)
	if st := x.Status(); st.Push.Refused == "" || git(t, remote, "rev-parse", "main") != foreign {
		t.Fatalf("after set, the export pushed over a foreign commit:\n%s", statusJSON(st))
	}

	// Put back at the export's commit, and set again: it pushes.
	git(t, work, "push", "-q", "--force", "origin", pushed+":refs/heads/main")
	x.Reconfigure(s, nil)
	x.sync(t)
	if got := git(t, remote, "rev-parse", "main"); got != tip(t, out, "main") {
		t.Fatalf("the export did not push once the remote was back: it is at %s\n%s", got, statusJSON(x.Status()))
	}
}

// TestAFailingPushLeavesTheStoreAndTheExportAlone: with the remote
// unreachable, every write still commits at once, the local export still
// catches up with the head, and the status carries the push's error, retried
// later.
func TestAFailingPushLeavesTheStoreAndTheExportAlone(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	missing := "file://" + filepath.Join(t.TempDir(), "missing.git")
	x := r.exporter(out, settings(t, out, missing))
	x.Start()
	for i := range 50 {
		start := time.Now()
		r.put("Laptop", fmt.Sprintf("n%02d.md", i), []byte("x\n"))
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("a write took %s while the push was failing", d)
		}
	}
	r.clock.advance(10 * time.Minute)
	x.nudge()
	head, _ := r.st.LatestUID(vault)
	deadline := time.Now().Add(30 * time.Second)
	for {
		s := x.Status()
		if s.ExportedThrough == head && s.Push != nil && s.Push.LastError != "" {
			if s.Push.NextAttemptAt == 0 {
				t.Errorf("a failed push has no next attempt:\n%s", statusJSON(s))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the export did not catch up and report the push's failure:\n%s", statusJSON(s))
		}
		time.Sleep(20 * time.Millisecond)
	}
}
