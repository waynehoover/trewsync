package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/telimus/internal/chunks"
	"github.com/waynehoover/telimus/internal/store"
)

// The escape hatch: a note straight out of the store. seeded holds note.md in
// three versions (uids 1 to 3), other.md, attachment.bin in three chunks, and
// gone.md as a deletion with no version before it.

func TestCatPrintsTheLiveVersionOrTheOneAskedFor(t *testing.T) {
	dir := seeded(t)
	if got := mustRun(t, "cat", "-data", dir, "-path", "note.md"); got != "version three" {
		t.Fatalf("cat printed %q, want the live version", got)
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "note.md", "-uid", "1"); got != "version one" {
		t.Fatalf("cat -uid 1 printed %q", got)
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "attachment.bin"); got != "part one part two part three" {
		t.Fatalf("a note in three chunks came out as %q", got)
	}
	for _, c := range []struct {
		args []string
		says string
	}{
		{[]string{"-path", "gone.md"}, "deleted"},
		{[]string{"-path", "never.md"}, "never held"},
		{[]string{"-path", "other.md", "-uid", "1"}, "not of"},
		{[]string{"-path", "note.md", "-uid", "999"}, "no uid"},
		{[]string{}, "-path"},
	} {
		out, err := telimus(t, append([]string{"cat", "-data", dir}, c.args...)...)
		if err == nil || !strings.Contains(err.Error(), c.says) {
			t.Errorf("cat %v: %v (printed %q), want a refusal saying %q", c.args, err, out, c.says)
		}
	}
}

// A deleted note is pointed at the versions that still have its contents.
func TestCatOfADeletedNoteNamesTheVersionsLeft(t *testing.T) {
	dir := seeded(t)
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendEntry("default", store.Entry{Path: "note.md", Deleted: true, MTime: 40}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	_, err = telimus(t, "cat", "-data", dir, "-path", "note.md")
	if err == nil || !strings.Contains(err.Error(), "uids 3, 2, 1") {
		t.Fatalf("cat of a deleted note said %v, want the versions with contents named", err)
	}
}

// What comes out is the version or an error: a body that rotted on disk is
// refused, not printed.
func TestCatRefusesABodyThatIsNotItsName(t *testing.T) {
	dir := seeded(t)
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p, err := st.Chunks().Path("default", chunks.Name([]byte("version three")))
	st.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("version thre3"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := telimus(t, "cat", "-data", dir, "-path", "note.md")
	if err == nil || strings.Contains(out, "thre3") {
		t.Fatalf("cat of a rotted body printed %q (%v)", out, err)
	}
}

// export writes one version to a new file, exactly, at 0600, and will not
// write over anything.
func TestExportWritesOneVersionToANewFileOnly(t *testing.T) {
	dir := seeded(t)
	to := filepath.Join(t.TempDir(), "recovered.md")
	out := mustRun(t, "export", "-data", dir, "-uid", "2", "-to", to)
	if !strings.Contains(out, "uid 2") {
		t.Fatalf("export said %q", out)
	}
	got, err := os.ReadFile(to)
	if err != nil || string(got) != "version two" {
		t.Fatalf("export wrote %q (%v)", got, err)
	}
	if info, err := os.Stat(to); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the exported file is %v (%v), want mode 600", info.Mode(), err)
	}
	if _, err := telimus(t, "export", "-data", dir, "-uid", "1", "-to", to); err == nil {
		t.Fatal("export wrote over a file that was there")
	}
	if got, _ := os.ReadFile(to); string(got) != "version two" {
		t.Fatalf("the refused export changed the file to %q", got)
	}
	// A deletion has no contents to export, and nothing is written for it.
	del := filepath.Join(t.TempDir(), "deletion")
	if _, err := telimus(t, "export", "-data", dir, "-uid", "6", "-to", del); err == nil {
		t.Fatal("a deletion was exported")
	}
	if _, err := os.Stat(del); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused export left a file: %v", err)
	}
	// And no temporary file is left beside the target.
	entries, _ := os.ReadDir(filepath.Dir(to))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".recovered.md.") {
			t.Fatalf("export left %s behind", e.Name())
		}
	}
}

// Both read beside a running server, since that is when a note is most likely
// to be wanted from it.
func TestTheEscapeHatchRunsBesideAServer(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()
	if got := mustRun(t, "cat", "-data", dir, "-path", "other.md"); got != "only version" {
		t.Fatalf("cat beside a server printed %q", got)
	}
	to := filepath.Join(t.TempDir(), "other.md")
	mustRun(t, "export", "-data", dir, "-uid", "4", "-to", to)
}
