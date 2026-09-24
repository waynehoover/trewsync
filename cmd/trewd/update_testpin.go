//go:build updatetest

package main

import "os"

// Only in a binary built with -tags updatetest, which no release is: the
// goreleaser config and the Dockerfile build without tags, and
// scripts/goreleaser-check.sh asserts it of every binary it builds.
//
// scripts/packslip-check.sh signs a fake release feed with a key it has just
// made, because the release's real signer is a GitHub workflow and cannot sign
// anything on a laptop. This lets a binary built for that script trust the key
// instead, so the whole of `trewd update`, packslip included, runs against a
// feed it can serve. The pin it replaces is the only thing that changes;
// every other check runs as in a release.
func init() {
	if key := os.Getenv("TREWD_UPDATE_TEST_PUBKEY"); key != "" {
		releasePolicy = updatePolicy{
			args:   []string{"--pubkey", key, "--allow-unlogged"},
			scheme: "sigstore-key",
		}
	}
}
