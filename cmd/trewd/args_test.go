package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// T41. Go's flag package stops at the first argument that is not a flag and
// leaves the rest unread, and most commands never looked at what was left: so
// `trewd verify -data big extra -deep` ran a shallow verify and exited 0,
// unpack dropped -record, the one check of an archive's origin, and purge
// dropped -grace. Every command that takes no arguments now refuses one, and
// does nothing else.
func TestAStrayArgumentIsRefusedRatherThanDroppingTheFlagsAfterIt(t *testing.T) {
	dir := seeded(t)
	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", key)
	archive := filepath.Join(t.TempDir(), "trew.tar.age")
	mustRun(t, "backup", "-data", dir, "-to", archive, "-recipients-file", key+".pub")
	plain := filepath.Join(t.TempDir(), "plain")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", plain)
	scratch := t.TempDir()
	before := treeDigest(t, dir)

	for _, args := range [][]string{
		{"verify", "-data", dir, "extra", "-deep"},
		{"stats", "-data", dir, "extra", "-json"},
		{"backup", "-data", dir, "-to", filepath.Join(scratch, "b"), "-plaintext-ok", "extra", "-deep"},
		{"backup-key", "-out", filepath.Join(scratch, "k"), "extra", "-x25519"},
		{"unpack", "-from", archive, "-identity", key, "-to", filepath.Join(scratch, "u"), "extra", "-record", dir},
		{"rehearse", "-data", dir, "-backup", plain, "extra", "-keep"},
		{"purge", "-data", dir, "-confirm", "default", "-no-backup-check", "extra", "-grace", "0"},
		{"cat", "-data", dir, "-path", "note.md", "extra", "-uid", "1"},
		{"export", "-data", dir, "-uid", "1", "-to", filepath.Join(scratch, "e"), "extra", "-vault", "default"},
		{"history", "-data", dir, "-path", "note.md", "extra", "-limit", "1"},
		{"deleted", "-data", dir, "extra", "-limit", "1"},
		{"devices", "-data", dir, "extra", "-json"},
		{"service", "-data", dir, "extra", "-mcp"},
		{"health", "-addr", "127.0.0.1:1", "extra", "-timeout", "1s"},
		{"serve", "-data", dir, "-addr", "256.0.0.1:1", "extra", "-mcp"},
	} {
		out, err := trew(t, args...)
		if err == nil || !strings.Contains(err.Error(), "takes no arguments") {
			t.Errorf("trewd %s: a stray argument was not refused: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	if after := treeDigest(t, dir); after != before {
		t.Fatalf("a refused command changed the data directory:\nbefore\n%s\nafter\n%s", before, after)
	}
	if entries, _ := os.ReadDir(scratch); len(entries) != 0 {
		t.Fatalf("a refused command wrote %v", entries)
	}
}

// Go's flag package reads a backquoted name in a flag's usage as the name of
// the flag's argument, so a usage that quoted a command printed it as one:
// `trewd -h` listed "-mcp trewd mcp-token", a switch shown taking two words,
// and restore listed "-to-uid trewd audit". A flag's line in every command's
// help names one argument at most.
func TestHelpShowsNoFlagTakingAQuotedCommand(t *testing.T) {
	for _, args := range [][]string{
		{"serve"}, {"invite"}, {"devices"}, {"revoke"}, {"uninvite"}, {"mcp-token"}, {"audit"},
		{"undo"}, {"restore"}, {"cat"}, {"history"}, {"deleted"}, {"export"}, {"backup"},
		{"backup-key"}, {"unpack"}, {"rehearse"}, {"verify"}, {"purge"}, {"stats"}, {"doctor"},
		{"config", "show"}, {"service"}, {"health"}, {"update"}, {"git-export", "set"},
	} {
		stderr, restore := captureStderr(t)
		_, err := trew(t, append(args, "-h")...)
		restore()
		if err == nil || !strings.Contains(err.Error(), "help requested") {
			t.Fatalf("trewd %s -h: %v", strings.Join(args, " "), err)
		}
		for _, line := range strings.Split(stderr.String(), "\n") {
			// "  -name" and the argument's name, if it takes one; a
			// one-letter flag's usage follows on the same line after a tab.
			head, _, _ := strings.Cut(line, "\t")
			if strings.HasPrefix(head, "  -") && len(strings.Fields(head)) > 2 {
				t.Errorf("trewd %s -h: %q", strings.Join(args, " "), head)
			}
		}
	}
}
