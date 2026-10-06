package main

import (
	"context"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/doctor"
)

// rehearsalDirs are the rehearsal work directories in dir.
func rehearsalDirs(t *testing.T, dir string) []string {
	t.Helper()
	found, err := filepath.Glob(filepath.Join(dir, "rehearsal-*"))
	if err != nil {
		t.Fatal(err)
	}
	return found
}

// T39. A rehearsal restores a whole backup, in plaintext, into a directory
// inside the data directory, and only a deferred remove took it away again; no
// command but serve handled a signal, so a SIGTERM or a Ctrl-C after the copy
// ended the process there and left the copy for good (17 MB of a 4,000-note
// store in the reproduction), where no purge reaches it and doctor said
// nothing. A rehearsal told to stop now stops at its next step, removes its
// work directory and records nothing, since an interrupted rehearsal proved
// nothing either way.
func TestAnInterruptedRehearsalStopsAndLeavesNothing(t *testing.T) {
	live := seeded(t)
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", live, "-to", backup)

	// The test takes SIGTERM too, so a real one reaches the rehearsal's
	// handler, or nothing, instead of ending the test binary.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM)
	defer signal.Stop(sigs)
	signalled := false
	swap(t, &duringRehearsal, func(ctx context.Context) {
		if signalled {
			return
		}
		signalled = true
		terminate(t)
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	})

	out, err := trew(t, "rehearse", "-data", live, "-backup", backup)
	if err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("a rehearsal told to stop went on: %v\n%s", err, out)
	}
	if left := rehearsalDirs(t, live); len(left) != 0 {
		t.Fatalf("the interrupted rehearsal left %v, a plaintext copy of the backup", left)
	}
	if _, err := os.Stat(filepath.Join(live, doctor.RehearsalRecordFile)); !os.IsNotExist(err) {
		t.Fatalf("an interrupted rehearsal was recorded (%v)", err)
	}
}

// T39. A rehearsal killed outright (SIGKILL, a crash, the power) cannot clean
// up after itself, so the next one does: a work directory whose rehearsal
// took its lock and never let it go, and that nothing holds now, is removed.
// One kept with -keep let its lock go and stays; doctor names every copy.
func TestARehearsalSweepsTheCopyAKilledOneLeft(t *testing.T) {
	live := seeded(t)
	if err := os.Chmod(live, 0o700); err != nil { // as serve makes one
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", live, "-to", backup)
	killed := filepath.Join(live, "rehearsal-20260101T000000Z")
	kept := filepath.Join(live, "rehearsal-20260102T000000Z")
	for dir, lock := range map[string]string{killed: "rehearse pid 99999\n", kept: ""} {
		copyTree(t, backup, filepath.Join(dir, "restore"))
		if err := os.WriteFile(filepath.Join(dir, "data.lock"), []byte(lock), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rep, _ := doctorOn(t, live)
	expect(t, rep, doctor.CheckDataDir, doctor.Warn, "rehearsal-20260101T000000Z", "rehearsal-20260102T000000Z")

	out := mustRun(t, "rehearse", "-data", live, "-backup", backup)
	if _, err := os.Stat(killed); !os.IsNotExist(err) {
		t.Fatalf("the copy a killed rehearsal left is still there (%v):\n%s", err, out)
	}
	if !strings.Contains(out, killed) {
		t.Fatalf("the rehearsal does not say what it removed:\n%s", out)
	}
	if _, err := os.Stat(kept); err != nil {
		t.Fatalf("a work directory kept with -keep was removed: %v", err)
	}
}
