package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// serve's daily-note flags reach the tools, and settings the tools could
// never use stop serve before it starts, saying which flag.
func TestServeGivesTheDailyNoteSettingsToTheTools(t *testing.T) {
	dir := t.TempDir()
	addr := serveMCPOn(t, dir, "-daily-folder", "Journal", "-daily-format", "YYYY-[day]-DDD", "-timezone", "UTC")
	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "mcp-token", "-data", dir, "-label", "daily", "-scope", "write", "-key-out", key)
	token, err := os.ReadFile(key)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	status, _, body := postMCP(t, "http://"+addr+"/mcp", strings.TrimSpace(string(token)),
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"today_note","arguments":{"date":"2026-02-03"}}}`)
	if status != http.StatusOK || !strings.Contains(string(body), `"path":"Journal/2026-day-34.md"`) {
		t.Fatalf("today_note at %s: %d %s", now, status, body)
	}

	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"-daily-format", "gggg"}, "-daily-format"},
		{[]string{"-daily-folder", ".obsidian"}, "-daily-folder"},
		{[]string{"-template-time-format", "X"}, "-template-time-format"},
		{[]string{"-timezone", "Nowhere/Else"}, "-timezone"},
	} {
		out := &safeBuffer{}
		err := run(context.Background(), append([]string{"serve", "-data", t.TempDir(), "-addr", "127.0.0.1:0"}, c.args...), out)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v", c.args, err)
		}
	}
}
