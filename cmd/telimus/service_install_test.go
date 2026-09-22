package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestServiceInstallKeepsReviewedUnit(t *testing.T) {
	if os.Getenv("TELIMUS_SERVICE_INSTALL_HELPER") == "1" {
		for i, arg := range os.Args {
			if arg == "--" {
				if err := run(context.Background(), os.Args[i+1:], os.Stdout); err != nil {
					fmt.Fprintln(os.Stderr, err)
					os.Exit(1)
				}
				os.Exit(0)
			}
		}
		os.Exit(2)
	}

	dir := t.TempDir()
	reviewed := mustRun(t, "service", "-data", filepath.Join(dir, "my notes"),
		"-addr", "127.0.0.1:4312", "-vault", "personal notes", "-user", "telimus",
		"-binary", "/opt/my tools/telimus", "-max-file", "134217728")
	if err := os.WriteFile(filepath.Join(dir, "telimus.service"), []byte(reviewed), 0o600); err != nil {
		t.Fatal(err)
	}
	// Follow the printed command, changing only the privileged destination.
	// A regenerated service uses the real command through a subprocess helper.
	installed := filepath.Join(dir, "installed.service")
	command := ""
	for _, line := range strings.Split(reviewed, "\n") {
		if strings.HasPrefix(line, "#   ") && strings.Contains(line, "/etc/systemd/system/telimus.service") {
			command = strings.ReplaceAll(strings.TrimPrefix(line, "#   "), "/etc/systemd/system/telimus.service", shellQuote(installed))
			break
		}
	}
	if command == "" {
		t.Fatal("no installation command in the generated instructions")
	}
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nexec \"$TELIMUS_SERVICE_TEST_BINARY\" -test.run=^TestServiceInstallKeepsReviewedUnit$ -- \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "telimus"), []byte(wrapper), 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", command)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"TELIMUS_SERVICE_TEST_BINARY="+os.Args[0], "TELIMUS_SERVICE_INSTALL_HELPER=1", "TELIMUS_DATA="+filepath.Join(dir, "default-data"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("installation example: %v\n%s", err, out)
	}
	got, err := os.ReadFile(installed)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != reviewed {
		t.Fatalf("installation discarded the reviewed configuration:\n%s", got)
	}
}
