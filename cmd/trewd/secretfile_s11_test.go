package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// S11: a file holding a credential is written atomically, durably, at 0600,
// and verified. Basalt's was the auth token; Trew writes the first device's
// invite (and, with `-out`, any invite), which adds a device to the vault, so
// the writer and its two tests stay (plan/strip-ledger.md, unique guarantee
// 11). The third test, the token copied into a backup, went with the token.

// token_s11_test.go:14. A fresh write lands as exactly the content given, at
// 0600, with no temporary file left beside it.
func TestS11WriteSecretFileIsExactAndPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, firstInviteFile)
	if err := writeSecretFile(path, "trew1i_the-invite\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "trew1i_the-invite\n" {
		t.Fatalf("content is %q", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode is %o, want 600", perm)
	}
	assertNoSecretDebris(t, dir)
}

// token_s11_test.go:40. Overwriting a file an older copy, or a careless one,
// left at 0644 leaves it 0600. os.WriteFile leaves an existing file's mode
// alone, which is the hole this closes.
func TestS11OverwritingA0644FileTightensItTo0600(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, firstInviteFile)
	if err := os.WriteFile(path, []byte("old permissive\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := writeSecretFile(path, "new-invite\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode is %o after overwriting a 0644 file, want 600", perm)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "new-invite\n" {
		t.Fatalf("content is %q", got)
	}
	assertNoSecretDebris(t, dir)
}

// assertNoSecretDebris fails if a temporary file was left in dir, which is what
// an atomic write must not do once it has finished.
func assertNoSecretDebris(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "."+firstInviteFile+".") {
			t.Fatalf("a temporary file was left behind: %s", e.Name())
		}
	}
}
