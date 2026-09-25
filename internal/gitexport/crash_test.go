package gitexport

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// The crash matrix: the export's process is killed with SIGKILL at each point
// of a step, in the first step and in a later one, and a restarted export
// finishes with exactly the commits an export that was never killed makes. A
// duplicate commit or a missing one would change the tip.

// crashPoints are the named points of a step (exporter.go, "The step"):
// mid-stream, with fast-import still reading; after fast-import and before
// the pending row; after the pending row and before the branch moved; after
// the branch moved and before the row said so; and after all of it.
var crashPoints = []string{"streamed", "imported", "pending", "moved", "recorded"}

const (
	envCrashDir   = "TREW_GITEXPORT_CRASH_DIR"
	envCrashOut   = "TREW_GITEXPORT_CRASH_OUT"
	envCrashPoint = "TREW_GITEXPORT_CRASH_POINT"
	envCrashNth   = "TREW_GITEXPORT_CRASH_NTH"
	envCrashNow   = "TREW_GITEXPORT_CRASH_NOW"
)

// crashStep is the steps' size in the matrix: small, so one export is many
// steps and a crash in a later one resumes on top of a commit.
const crashStep = 40

// TestCrashChild is the process the matrix kills. It does nothing unless the
// matrix started it.
func TestCrashChild(t *testing.T) {
	dir := os.Getenv(envCrashDir)
	if dir == "" {
		return
	}
	nth, _ := strconv.Atoi(os.Getenv(envCrashNth))
	now, _ := strconv.ParseInt(os.Getenv(envCrashNow), 10, 64)
	stepEntries = crashStep
	r := openRig(t, dir, &clock{now: time.UnixMilli(now)})
	out := os.Getenv(envCrashOut)
	x := r.exporter(out, settings(t, out, ""))
	seen := 0
	x.crash = func(point string) {
		if point != os.Getenv(envCrashPoint) {
			return
		}
		if seen++; seen == nth {
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			time.Sleep(time.Minute)
		}
	}
	x.sync(t)
	// Reaching the end means the point never came: the matrix fails on it.
	os.Exit(3)
}

// TestAKilledExportResumesWithTheSameCommits is the matrix.
func TestAKilledExportResumesWithTheSameCommits(t *testing.T) {
	needGit(t)
	dir := t.TempDir()
	c := &clock{now: time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)}
	r := openRig(t, dir, c)
	vaultOf(r, 60)
	for i := range 90 {
		r.clock.advance(6 * time.Minute)
		r.put([]string{"Laptop", "Phone", "Tablet"}[i%3], fmt.Sprintf("Notes/%03d.md", i%60), []byte(fmt.Sprintf("edit %d\n", i)))
		if i%10 == 0 {
			r.op("edit_note", map[string]string{fmt.Sprintf("Agent/%d.md", i): "agent\n"})
		}
	}
	r.clock.advance(time.Hour)
	r.st.Close()

	stepEntries = crashStep
	t.Cleanup(func() { stepEntries = 5000 })
	reference := t.TempDir()
	{
		r := openRig(t, dir, c)
		x := r.exporter(reference, settings(t, reference, ""))
		x.sync(t)
		x.Close()
		r.st.Close()
	}
	want := tip(t, reference, "main")
	commits := git(t, repo(reference), "rev-list", "--count", "main")

	for _, point := range crashPoints {
		for _, nth := range []int{1, 3} {
			t.Run(fmt.Sprintf("%s/%d", point, nth), func(t *testing.T) {
				out := t.TempDir()
				cmd := exec.Command(os.Args[0], "-test.run=^TestCrashChild$", "-test.count=1")
				cmd.Env = append(os.Environ(), envCrashDir+"="+dir, envCrashOut+"="+out, envCrashPoint+"="+point,
					envCrashNth+"="+strconv.Itoa(nth), envCrashNow+"="+strconv.FormatInt(c.Now().UnixMilli(), 10))
				outb, err := cmd.CombinedOutput()
				var ee *exec.ExitError
				if err == nil || !asExit(err, &ee) || ee.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
					t.Fatalf("the export was not killed at %s #%d: %v\n%s", point, nth, err, outb)
				}
				r := openRig(t, dir, c)
				x := r.exporter(out, settings(t, out, ""))
				x.sync(t)
				if got := tip(t, out, "main"); got != want {
					t.Fatalf("resumed at %s, and an export never killed is at %s:\n%s", got, want,
						git(t, repo(out), "log", "--format=%H %s", "-6"))
				}
				if n := git(t, repo(out), "rev-list", "--count", "main"); n != commits {
					t.Fatalf("%s commits, and %s without the crash", n, commits)
				}
				b, _, err := loadBranch(x.db, "main")
				if err != nil || b.pendingSHA != "" || b.commit != want {
					t.Fatalf("the state row is %+v (%v)", b, err)
				}
				x.Close()
				r.st.Close()
			})
		}
	}
}

func asExit(err error, target **exec.ExitError) bool {
	ee, ok := err.(*exec.ExitError)
	if ok {
		*target = ee
	}
	return ok
}
