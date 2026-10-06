package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
)

// T33. A backup copies only what its directory lacks, and a body is "had" by
// a stat, so a body that rotted where an earlier backup put it was never
// replaced: every -deep backup into that directory failed on it for ever, and
// a shallow one went on publishing snapshots that referenced it, while the
// source held a good copy all along. A deep backup now sets the rotted body
// aside, quarantined rather than deleted, copies it again from the source,
// and checks it again.
func TestADeepBackupReplacesABodyThatRottedInTheBackup(t *testing.T) {
	h := newTestStore(t)
	body := "the only copy that matters"
	h.file(t, "a.md", body)
	bk := t.TempDir()
	if _, err := h.Backup(bk, true); err != nil {
		t.Fatal(err)
	}
	name := chunks.Name([]byte(body))
	bkChunks, err := chunks.OpenExisting(filepath.Join(bk, chunkDirName), ChunkMax)
	if err != nil {
		t.Fatal(err)
	}
	p, err := bkChunks.Path("v1", name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body+"X"), 0o600); err != nil {
		t.Fatal(err)
	}

	rep, err := h.Backup(bk, true)
	if err != nil {
		t.Fatalf("a deep backup over a body that rotted in its own directory failed: %v", err)
	}
	if rep.Healed != 1 {
		t.Fatalf("the backup says it replaced %d rotted bodies, and one had rotted", rep.Healed)
	}
	if err := bkChunks.Check("v1", name); err != nil {
		t.Fatalf("the published backup still references a rotted body: %v", err)
	}
	// The rotted bytes are kept beside it as evidence, never deleted (rule 3).
	entries, err := os.ReadDir(filepath.Dir(p))
	if err != nil {
		t.Fatal(err)
	}
	aside := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), name) && e.Name() != name {
			aside++
		}
	}
	if aside != 1 {
		t.Fatalf("the rotted body was not set aside: %v", entries)
	}
}
