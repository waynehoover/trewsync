package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/store"
)

// T40. -limit is "the most versions to list, up to 500", and the store
// answers a page of more than 500 with 100, so `-limit 1000` on a note of 150
// versions listed 100 and no "older versions may follow", since 100 is not
// the 1,000 asked for: a history that looked whole and was not. A limit
// outside what one page can be is now refused, saying how to page, and the
// hint is given whenever a page is full.
func TestHistorySaysWhenThereIsMoreThanItListed(t *testing.T) {
	dir := seeded(t)
	withStore(t, dir, func(st *store.Store) {
		for i := 0; i < 150; i++ {
			body := fmt.Sprintf("v%d", i)
			n := chunks.Name([]byte(body))
			if err := st.Chunks().Put("default", n, []byte(body)); err != nil {
				t.Fatal(err)
			}
			if _, err := st.AppendEntry("default", store.Entry{Path: "many.md", Size: int64(len(body)), MTime: 1,
				Device: "d", Chunks: []string{n}}); err != nil {
				t.Fatal(err)
			}
		}
	})
	listed := func(out string) int { return strings.Count(out, "  uid ") }
	const more = "older versions may follow"

	for _, limit := range []string{"1000", "501", "0", "-5"} {
		out, err := trew(t, "history", "-data", dir, "-path", "many.md", "-limit", limit)
		if err == nil {
			t.Fatalf("-limit %s listed %d versions without a word:\n%s", limit, listed(out), out)
		}
		if !strings.Contains(err.Error(), "500") || !strings.Contains(err.Error(), "-before") {
			t.Fatalf("-limit %s is refused without saying how to page: %v", limit, err)
		}
	}
	if out := mustRun(t, "history", "-data", dir, "-path", "many.md", "-limit", "500"); listed(out) != 150 ||
		strings.Contains(out, more) {
		t.Fatalf("-limit 500 on 150 versions listed %d:\n%s", listed(out), out)
	}
	if out := mustRun(t, "history", "-data", dir, "-path", "many.md", "-limit", "100"); listed(out) != 100 ||
		!strings.Contains(out, more) {
		t.Fatalf("a full page of 100 does not say more may follow:\n%s", out)
	}
}

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
