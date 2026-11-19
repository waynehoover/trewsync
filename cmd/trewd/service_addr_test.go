package main

import (
	"strings"
	"testing"
)

// Security review L9: the unit `trewd service` prints listens on loopback
// unless told otherwise. The server speaks no TLS, and a unit on every
// interface sent tokens and notes across the LAN in the clear.
func TestServiceUnitListensOnLoopbackByDefault(t *testing.T) {
	out := mustRun(t, "service", "-data", t.TempDir(), "-user", "trew", "-binary", "/usr/local/bin/trewd")
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "ExecStart=") {
			if !strings.Contains(line, " -addr 127.0.0.1:3003 ") {
				t.Fatalf("the unit runs %q, want -addr 127.0.0.1:3003", line)
			}
			return
		}
	}
	t.Fatalf("no ExecStart in:\n%s", out)
}
