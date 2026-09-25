package main

import (
	"strings"
	"testing"
)

// `trewd history` answers "what did this note hold" from the shell: every
// version of the path, newest first, with its uid for `trewd cat`, and the
// agent operation that wrote one when an agent did. `trewd deleted` lists the
// deleted notes with the version to restore each from.
func TestHistoryAndDeletedAnswerFromTheShell(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "history", "-data", dir, "-path", "note.md")
	for _, want := range []string{
		`"note.md" in vault "default", newest first:`,
		"uid 3      13 bytes, by seed", "uid 1      11 bytes, by seed",
		`trewd cat -path "note.md" -uid N`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("history does not say %q:\n%s", want, out)
		}
	}
	if strings.Index(out, "uid 3 ") > strings.Index(out, "uid 1 ") {
		t.Fatalf("history is not newest first:\n%s", out)
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "note.md", "-uid", "2"); got != "version two" {
		t.Fatalf("the uid history named reads %q", got)
	}
	if _, err := trew(t, "history", "-data", dir, "-path", "Note.md"); err == nil {
		t.Fatal("history of a path the vault never held did not say so")
	}

	agentDir := t.TempDir()
	stop := serveInBackground(t, agentDir)
	stop()
	_, ops := agentWrote(t, agentDir)
	out = mustRun(t, "history", "-data", agentDir, "-path", "notes/plan.md")
	if !strings.Contains(out, "edit_note op "+ops[0]) || !strings.Contains(out, "by Claude on Mac") {
		t.Fatalf("history does not name the agent's operation:\n%s", out)
	}

	out = mustRun(t, "deleted", "-data", dir)
	if !strings.Contains(out, `"gone.md" deleted by`) || !strings.Contains(out, "nothing to restore it from") {
		t.Fatalf("deleted says:\n%s", out)
	}
}
