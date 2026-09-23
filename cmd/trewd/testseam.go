//go:build crashmatrix

// The crash matrix's hold on a real server (PLAN.md M5 task 9).
//
// Compiled only into a trewd built with `-tags crashmatrix`, which the crash
// matrix builds for itself (client/src/stress/mcp-crash.stress.ts and
// cmd/trewd/crash_test.go). No release, image or `go install` passes the tag,
// so a trewd anybody runs has none of this: not the variable's name, not the
// hold, and nothing a request could reach. TestAProductionBuildHasNoTestSeam
// builds trewd as a release does and checks both.
//
// TREW_TEST_SEAM names one of the write's seams (internal/mcp, write.go).
// Every time a write reaches it, the server says so on stderr, one line, and
// reads a line from stdin: "go" lets the write go on, and anything else,
// the end of stdin included, holds it there until the process is killed. So
// a test can stop the world inside a write, change something and let it
// finish, or SIGKILL the server with the write exactly there. One write is
// held at a time: another reaching the seam waits behind it, unannounced,
// until it is let go.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/waynehoover/trew/internal/mcp"
)

// testSeamMark is the line a held write writes, followed by the seam's name.
const testSeamMark = "trewd test seam: holding at "

func init() {
	point := os.Getenv("TREW_TEST_SEAM")
	if point == "" {
		return
	}
	switch point {
	case mcp.SeamUploading, mcp.SeamBodies, mcp.SeamCommitted, mcp.SeamBroadcast:
	default:
		// A misspelt seam would hold nothing, and the test would wait for a
		// hold that never comes, or pass without one.
		fmt.Fprintf(os.Stderr, "TREW_TEST_SEAM=%q is none of the write's seams\n", point)
		os.Exit(2)
	}
	var mu sync.Mutex
	in := bufio.NewReader(os.Stdin)
	testSeam = func(at string) {
		if at != point {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(os.Stderr, "%s%s\n", testSeamMark, at)
		line, err := in.ReadString('\n')
		if err == nil && strings.TrimSpace(line) == "go" {
			return
		}
		select {} // held until the test kills the process
	}
}
