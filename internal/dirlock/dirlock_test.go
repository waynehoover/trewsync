package dirlock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Two servers on one data directory would each have their own fan-out and their
// own commit ordering, so neither would see the other's live changes.
func TestExclusiveExcludesExclusive(t *testing.T) {
	dir := t.TempDir()
	first, err := Exclusive(dir, Server, "serve")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	defer first.Release()

	_, err = Exclusive(dir, Server, "serve")
	if !errors.Is(err, ErrHeld) {
		t.Fatalf("second exclusive lock: err = %v, want ErrHeld", err)
	}
	// The refusal names what is in the way, so the message is actionable.
	if !strings.Contains(err.Error(), "by serve") || !strings.Contains(err.Error(), "pid") {
		t.Fatalf("the refusal does not say who holds it: %v", err)
	}
}

// A backup has to run without stopping the server, which is the whole reason
// the data lock is shared rather than exclusive.
func TestSharedLocksCoexist(t *testing.T) {
	dir := t.TempDir()
	server, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	defer server.Release()

	backup, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("a backup could not run alongside a server: %v", err)
	}
	defer backup.Release()

	verify, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("verify could not run alongside both: %v", err)
	}
	verify.Release()
}

// Purge deletes chunk bodies, so it must not run while anything is reading them.
func TestExclusiveIsRefusedWhileSharedIsHeld(t *testing.T) {
	dir := t.TempDir()
	reader, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("reader: %v", err)
	}

	if _, err := Exclusive(dir, Data, "purge"); !errors.Is(err, ErrHeld) {
		t.Fatalf("purge took the lock while a reader held it: err = %v", err)
	}

	// And once the reader is done, purge can proceed.
	if err := reader.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	purge, err := Exclusive(dir, Data, "purge")
	if err != nil {
		t.Fatalf("purge could not take the lock after the reader left: %v", err)
	}
	purge.Release()
}

// And the other way round: a read cannot start while a purge is sweeping.
func TestSharedIsRefusedWhileExclusiveIsHeld(t *testing.T) {
	dir := t.TempDir()
	purge, err := Exclusive(dir, Data, "purge")
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	defer purge.Release()

	if _, err := Shared(dir, Data); !errors.Is(err, ErrHeld) {
		t.Fatalf("a backup started while a purge was sweeping: err = %v", err)
	}
}

// The two locks are independent, so holding the server lock does not stop a
// backup from taking the data lock.
func TestTheTwoLocksAreIndependent(t *testing.T) {
	dir := t.TempDir()
	server, err := Exclusive(dir, Server, "serve")
	if err != nil {
		t.Fatalf("server lock: %v", err)
	}
	defer server.Release()

	data, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("the data lock was blocked by the server lock: %v", err)
	}
	data.Release()
}

// Release must actually release. A lock held past its command means the next run
// of a scheduled backup fails for no reason anyone can see.
func TestReleaseFreesTheLock(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		l, err := Exclusive(dir, Data, fmt.Sprintf("run-%d", i))
		if err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
		if err := l.Release(); err != nil {
			t.Fatalf("run %d release: %v", i, err)
		}
	}
}

// Locking creates the directory if it is not there, because the first thing the
// server does on a fresh box is take its lock.
func TestLockingCreatesTheDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not", "yet", "there")
	l, err := Exclusive(dir, Server, "serve")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	defer l.Release()
	if _, err := os.Stat(filepath.Join(dir, Server)); err != nil {
		t.Fatalf("lock file not created: %v", err)
	}
}

// A shared holder writes nothing, so the file must not be truncated out from
// under an exclusive holder's message by a later reader.
func TestSharedHoldersDoNotOverwriteTheHolderRecord(t *testing.T) {
	dir := t.TempDir()
	a, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("a: %v", err)
	}
	defer a.Release()
	b, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("b: %v", err)
	}
	defer b.Release()

	if info, err := os.Stat(filepath.Join(dir, Data)); err != nil {
		t.Fatalf("stat: %v", err)
	} else if info.Size() != 0 {
		t.Fatalf("a shared holder wrote %d bytes to the lock file", info.Size())
	}
}

// A refusal on the shared lock has nothing to name, because shared holders
// record nothing. The server lock next to it does, which is what makes the
// message useful.
func TestHolderReadsTheRecordWithoutTakingTheLock(t *testing.T) {
	dir := t.TempDir()
	if got := Holder(dir, Server); got != "" {
		t.Fatalf("Holder on an untouched directory = %q", got)
	}

	server, err := Exclusive(dir, Server, "serve")
	if err != nil {
		t.Fatalf("server lock: %v", err)
	}
	defer server.Release()

	got := Holder(dir, Server)
	if !strings.Contains(got, "serve") || !strings.Contains(got, "pid") {
		t.Fatalf("Holder = %q, want it to name serve and a pid", got)
	}
	// Reading must not have taken the lock: the holder still owns it, and
	// another exclusive attempt is still refused.
	if _, err := Exclusive(dir, Server, "other"); !errors.Is(err, ErrHeld) {
		t.Fatalf("Holder released the lock it read: err = %v", err)
	}
}

// A released lock must stop claiming a holder. A refusal that names a process
// which finished hours ago is worse than one that names none: it sends someone
// to kill something that is not running.
func TestReleaseClearsTheHolderRecord(t *testing.T) {
	dir := t.TempDir()
	l, err := Exclusive(dir, Data, "purge")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if got := Holder(dir, Data); !strings.Contains(got, "purge") {
		t.Fatalf("Holder while held = %q", got)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if got := Holder(dir, Data); got != "" {
		t.Fatalf("Holder after release = %q, want empty", got)
	}

	// And a later shared holder is not misreported as the old exclusive one.
	reader, err := Shared(dir, Data)
	if err != nil {
		t.Fatalf("shared: %v", err)
	}
	defer reader.Release()

	_, err = Exclusive(dir, Data, "purge")
	var held *HeldError
	if !errors.As(err, &held) {
		t.Fatalf("err = %v, want a HeldError", err)
	}
	if held.Holder != "" {
		t.Fatalf("a shared holder was reported as %q", held.Holder)
	}
}

// A plaintext backup on read-only media, a mount or a snapshot, is still read
// under the shared lock: `trewd rehearse -backup` and purge read it, and only
// reading needs nothing written (Fable review #3). A lock file that is there
// is locked through a read-only descriptor, which still holds off an
// exclusive holder; one that is not there, in a directory nobody can write,
// has nothing that could be writing beside it. The exclusive lock, which
// records its holder, still needs to write.
func TestSharedWorksOnAReadOnlyDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes through any mode")
	}
	readOnly := func(t *testing.T, dir string) {
		t.Helper()
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(dir, 0o700) })
	}

	withFile := t.TempDir()
	writer, err := Exclusive(withFile, Data, "backup")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(withFile, Data), 0o400); err != nil {
		t.Fatal(err)
	}
	readOnly(t, withFile)
	if _, err := Shared(withFile, Data); !errors.Is(err, ErrHeld) {
		t.Fatalf("a shared lock on a read-only directory taken while a writer holds it: err = %v, want ErrHeld", err)
	}
	writer.Release()
	reader, err := Shared(withFile, Data)
	if err != nil {
		t.Fatalf("a shared lock on a read-only directory with its lock file: %v", err)
	}
	second, err := Shared(withFile, Data)
	if err != nil {
		t.Fatalf("a second shared lock beside it: %v", err)
	}
	second.Release()
	if err := reader.Release(); err != nil {
		t.Fatalf("releasing it: %v", err)
	}
	if _, err := Exclusive(withFile, Data, "purge"); err == nil {
		t.Fatal("an exclusive lock was taken on a read-only lock file")
	}

	without := t.TempDir()
	readOnly(t, without)
	reader, err = Shared(without, Data)
	if err != nil {
		t.Fatalf("a shared lock on a read-only directory with no lock file: %v", err)
	}
	if err := reader.Release(); err != nil {
		t.Fatalf("releasing it: %v", err)
	}
	if _, err := Exclusive(without, Data, "purge"); err == nil {
		t.Fatal("an exclusive lock was taken in a read-only directory")
	}
}
