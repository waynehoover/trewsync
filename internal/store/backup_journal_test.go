package store

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
)

func TestBackupRefusesDestinationWithPendingRecovery(t *testing.T) {
	if dest := os.Getenv("TREW_TEST_BACKUP_WAL_DEST"); dest != "" {
		db, cs := DataDir(dest)
		s, err := Open(db, cs)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.EnsureVault("v1", 1); err != nil {
			t.Fatal(err)
		}
		body := []byte("old destination bytes")
		name := chunks.Name(body)
		if err := s.Chunks().Put("v1", name, body); err != nil {
			t.Fatal(err)
		}
		if _, err := s.AppendEntry("v1", Entry{Path: "old.md", Chunks: []string{name}, Size: int64(len(body)), Device: "old", Mac: testMac}); err != nil {
			t.Fatal(err)
		}
		os.Exit(0) // Simulate a process exit without SQLite's close/checkpoint.
	}
	h := newTestStore(t)
	h.file(t, "new.md", "new source bytes")
	dest := filepath.Join(t.TempDir(), "backup")
	child := exec.Command(os.Args[0], "-test.run=^TestBackupRefusesDestinationWithPendingRecovery$")
	child.Env = append(os.Environ(), "TREW_TEST_BACKUP_WAL_DEST="+dest)
	if out, err := child.CombinedOutput(); err != nil {
		t.Fatalf("child: %v %s", err, out)
	}
	db, _ := DataDir(dest)
	before := map[string][]byte{}
	for _, p := range []string{db, db + "-wal"} {
		b, err := os.ReadFile(p)
		if err != nil || len(b) == 0 {
			t.Fatalf("expected nonempty recovery file %s: %v", p, err)
		}
		before[p] = b
	}
	if _, err := h.Backup(dest, true); err == nil || !strings.Contains(err.Error(), "SQLite recovery") {
		t.Fatalf("backup should refuse pending destination recovery: %v", err)
	}
	for p, want := range before {
		got, err := os.ReadFile(p)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("refused backup changed recovery file %s: %v", p, err)
		}
	}
	checkBackupBody(t, dest, "old.md", "old destination bytes")
	// The documented remedy works without modifying the recovery copy.
	fresh := filepath.Join(t.TempDir(), "fresh-backup")
	if _, err := h.Backup(fresh, true); err != nil {
		t.Fatal(err)
	}
	checkBackupBody(t, fresh, "new.md", "new source bytes")
}

func TestBackupRefusesANonemptyRollbackJournal(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "new.md", "new source bytes")
	dest := t.TempDir()
	journal := filepath.Join(dest, dbFileName+"-journal")
	if err := os.WriteFile(journal, []byte("recovery evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Backup(dest, true); err == nil || !strings.Contains(err.Error(), "SQLite recovery") {
		t.Fatalf("backup should refuse a rollback journal: %v", err)
	}
	if got, err := os.ReadFile(journal); err != nil || string(got) != "recovery evidence" {
		t.Fatalf("journal was changed: %q %v", got, err)
	}
}

func checkBackupBody(t *testing.T, dir, path, body string) {
	t.Helper()
	db, cs := DataDir(dir)
	s, err := Open(db, cs)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, ok, err := s.EntryByUID("v1", 1)
	if err != nil || !ok || e.Path != path || len(e.Chunks) != 1 {
		t.Fatalf("wrong restored entry: %+v %v %v", e, ok, err)
	}
	got, err := s.Chunks().Get("v1", e.Chunks[0])
	if err != nil || string(got) != body {
		t.Fatalf("wrong restored bytes: %q %v", got, err)
	}
}
