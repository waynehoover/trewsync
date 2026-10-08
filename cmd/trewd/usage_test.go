package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A bare `trewd` used to mean `trewd serve`: somebody typing it to see what it
// did, or `trewd -h` to read its help, started a server on every interface at
// :3003 with a data directory in ~/.trew. It now prints the commands, and
// serving is asked for by name (2026-10-08).
func TestTrewdWithNoCommandListsTheCommandsAndServesNothing(t *testing.T) {
	data := filepath.Join(t.TempDir(), "never-made")
	t.Setenv("TREW_DATA", data)

	for _, args := range [][]string{nil, {"-h"}, {"-help"}, {"--help"}, {"help"}} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		var out strings.Builder
		err := run(ctx, args, &out)
		cancel()
		if err != nil {
			t.Fatalf("trewd %s failed: %v\n%s", strings.Join(args, " "), err, out.String())
		}
		got := out.String()
		for _, want := range []string{"trewd serve", "invite", "mcp-token", "backup", "doctor"} {
			if !strings.Contains(got, want) {
				t.Errorf("trewd %s did not mention %q:\n%s", strings.Join(args, " "), want, got)
			}
		}
		if strings.Contains(got, "listening on") {
			t.Fatalf("trewd %s started a server:\n%s", strings.Join(args, " "), got)
		}
	}
	if _, err := os.Stat(data); !os.IsNotExist(err) {
		t.Fatalf("asking for help made the data directory %s (%v)", data, err)
	}
}

// Flags with no command were serve's flags. Serving the way they read is the
// old surprise again, so they are refused, and the refusal names the command
// that serves.
func TestFlagsWithNoCommandAreRefusedNotServed(t *testing.T) {
	data := filepath.Join(t.TempDir(), "never-made")
	t.Setenv("TREW_DATA", data)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out strings.Builder
	err := run(ctx, []string{"-addr", "127.0.0.1:0"}, &out)
	if err == nil || !strings.Contains(err.Error(), "trewd serve -addr") {
		t.Fatalf("trewd -addr was answered %v, want a refusal naming trewd serve:\n%s", err, out.String())
	}
	if _, err := os.Stat(data); !os.IsNotExist(err) {
		t.Fatalf("a refused invocation made the data directory %s (%v)", data, err)
	}
}
