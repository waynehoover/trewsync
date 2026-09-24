package main

import (
	"strings"
	"testing"
)

// A server run by hand with -mcp and then installed as a service must come back
// up still serving /mcp, or every agent pointed at it gets a 404 and the
// journal says nothing. The unit carries the flag when asked, and only then:
// an unasked-for MCP endpoint is an endpoint nobody decided to expose.
func TestServiceCarriesMCPIntoTheUnitOnlyWhenAsked(t *testing.T) {
	dir := t.TempDir()
	execStart := func(out string) string {
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, "ExecStart=") {
				return line
			}
		}
		t.Fatalf("no ExecStart in:\n%s", out)
		return ""
	}

	with := execStart(mustRun(t, "service", "-data", dir, "-user", "trew", "-binary", "/usr/local/bin/trewd", "-mcp"))
	if !strings.HasSuffix(with, " -mcp") {
		t.Errorf("asked for -mcp, and the unit runs %q", with)
	}
	without := execStart(mustRun(t, "service", "-data", dir, "-user", "trew", "-binary", "/usr/local/bin/trewd"))
	if strings.Contains(without, "-mcp") {
		t.Errorf("not asked for -mcp, and the unit runs %q", without)
	}
	if strings.TrimSuffix(with, " -mcp") != without {
		t.Errorf("-mcp changed more than the one flag:\n%s\n%s", with, without)
	}
}
