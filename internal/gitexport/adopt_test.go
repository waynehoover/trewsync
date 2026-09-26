package gitexport

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/config"
)

// oldHistory is a remote whose main already holds three commits made the way
// the obsidian-git plugin makes them: the vault's notes, its .obsidian/
// folder, a .gitattributes of its own, an attachment far over the LFS
// threshold committed as a plain blob, a symlink and an executable file, none
// of which the export ever writes. It returns the remote, its URL, the tip
// and the commit before it.
func oldHistory(t *testing.T) (remote, url, tipSHA, before string) {
	t.Helper()
	remote, url = bareRemote(t)
	work := filepath.Join(t.TempDir(), "vault")
	git(t, filepath.Dir(work), "init", "-q", "-b", "main", work)
	write := func(p string, b []byte) {
		t.Helper()
		full := filepath.Join(work, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Notes/000.md", []byte("the old first note\n"))
	write(".obsidian/app.json", []byte(`{"vimMode": true}`+"\n"))
	write(".gitattributes", []byte("*.md text\n"))
	git(t, work, "add", "-A")
	git(t, work, "commit", "-q", "-m", "vault backup: 2023-01-02 10:00:00")
	write("Attachments/old recording.m4a", bytes.Repeat([]byte("old audio "), 2000))
	if err := os.Symlink("Notes/000.md", filepath.Join(work, "link.md")); err != nil {
		t.Fatal(err)
	}
	write("run.sh", []byte("#!/bin/sh\n"))
	if err := os.Chmod(filepath.Join(work, "run.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, work, "add", "-A")
	git(t, work, "commit", "-q", "-m", "vault backup: 2024-06-01 08:30:00")
	write("Notes/000.md", []byte("the old first note, edited\n"))
	git(t, work, "add", "-A")
	git(t, work, "commit", "-q", "-m", "vault backup: 2026-09-20 21:15:00")
	git(t, work, "push", "-q", url, "main")
	return remote, url, git(t, remote, "rev-parse", "main"), git(t, remote, "rev-parse", "main~1")
}

// adoptedSettings are settings(t, dataDir, url) with sha adopted on main, as
// the configuration file holds them after `trewd git-export adopt`.
func adoptedSettings(t *testing.T, dataDir, url, sha string) Settings {
	t.Helper()
	threshold := int64(4096)
	c := config.GitExport{Enabled: true, Remote: url, LFSThreshold: &threshold, Quiet: "5m",
		Adopted: &config.GitExportAdopted{Remote: url, Branch: "main", Commit: sha}}
	s, err := Resolve(dataDir, c, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if s.Adopted != sha {
		t.Fatalf("the settings adopt %q", s.Adopted)
	}
	return s
}

// adopt is x.Adopt with a record that takes up the adopted settings, as the
// operator's does through the configuration file.
func adopt(t *testing.T, x *Exporter, dataDir, url, sha string) (Adoption, error) {
	t.Helper()
	x.mu.Lock()
	s := x.settings
	x.mu.Unlock()
	return x.Adopt(context.Background(), s, sha, func(commit string) error {
		x.Reconfigure(adoptedSettings(t, dataDir, url, commit), nil)
		return nil
	})
}

// TestAnAdoptedBranchContinuesItsHistory: without adoption the existing
// branch is refused, as before. `adopt` with no commit only shows the tip; a
// commit that is not the tip, or not a commit name, is refused and records
// nothing. Adopting the tip makes the export's first commit a child of it,
// whose message says so and whose tree is the store's files and nothing of
// the old tree's, and the push a fast-forward that keeps every old commit;
// the next push is a fast-forward too.
func TestAnAdoptedBranchContinuesItsHistory(t *testing.T) {
	r := newRig(t)
	remote, url, oldTip, before := oldHistory(t)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, url))
	vaultOf(r, 10)
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	x.sync(t)
	if st := x.Status(); st.Push == nil || !strings.Contains(st.Push.Refused, "the export did not make it") {
		t.Fatalf("an existing branch is not refused without adoption:\n%s", statusJSON(st))
	}
	if got := git(t, remote, "rev-parse", "main"); got != oldTip {
		t.Fatalf("the refused export moved the remote to %s", got)
	}
	unadopted := tip(t, out, "main")

	recorded := false
	never := func(string) error { recorded = true; return nil }
	s := settings(t, out, url)
	look, err := x.Adopt(context.Background(), s, "", never)
	if err != nil || look.Adopted || look.Commit != oldTip || look.Subject != "vault backup: 2026-09-20 21:15:00" ||
		look.Date == "" {
		t.Fatalf("looking at the branch: %+v, %v", look, err)
	}
	for _, bad := range []string{before, strings.Repeat("0", 40), oldTip[:12], "not a commit"} {
		if _, err := x.Adopt(context.Background(), s, bad, never); err == nil {
			t.Errorf("adopting %q is accepted", bad)
		}
	}
	if recorded {
		t.Fatal("a refused adoption recorded something")
	}
	if got := tip(t, out, "main"); got != unadopted {
		t.Fatal("a refused adoption changed the export's branch")
	}

	a, err := adopt(t, x, out, url, strings.ToUpper(oldTip))
	if err != nil || !a.Adopted || a.Commit != oldTip {
		t.Fatalf("adopting the tip: %+v, %v", a, err)
	}
	if a.Dropped != unadopted {
		t.Errorf("the unpushed branch at %s was not set aside: %+v", short(unadopted), a)
	}
	x.sync(t)
	x.sync(t)
	st := x.Status()
	if st.Push == nil || st.Push.Refused != "" || st.Push.LastError != "" || st.Push.Pushed != st.Commit ||
		st.Adopted != oldTip {
		t.Fatalf("the adopted branch was not pushed:\n%s", statusJSON(st))
	}
	if got := git(t, remote, "rev-parse", "main"); got != st.Commit {
		t.Fatalf("the remote is at %s, and the export at %s", got, st.Commit)
	}
	first := git(t, remote, "rev-list", "--reverse", oldTip+"..main")
	first = strings.SplitN(first, "\n", 2)[0]
	if parent := git(t, remote, "rev-parse", first+"^"); parent != oldTip {
		t.Fatalf("the first commit's parent is %s", parent)
	}
	if n := git(t, remote, "rev-list", "--count", "--parents", "--min-parents=2", "main"); n != "0" {
		t.Errorf("the history has %s merges", n)
	}
	if n := git(t, remote, "rev-list", "--count", oldTip); n != "3" {
		t.Errorf("the old history has %s commits", n)
	}
	msg := git(t, remote, "log", "-1", "--format=%B", first)
	for _, want := range []string{"TrewSync continues the history from obsidian-git at " + short(oldTip),
		"Trew-Continues: " + oldTip, "Laptop: ", "Trew-Device: Laptop"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the first commit's message lacks %q:\n%s", want, msg)
		}
	}
	if trailers := git(t, remote, "log", "-1", "--format=%(trailers:key=Trew-Continues,valueonly)", first); trailers != oldTip {
		t.Errorf("git reads the Trew-Continues trailer as %q", trailers)
	}
	sameFiles(t, r.storeFiles(), checkout(t, freshClone(t, url)), nil)

	// The next push is a fast-forward of the first.
	pushed := st.Commit
	r.put("Phone", "Notes/000.md", []byte("changed on the phone\n"))
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	x.sync(t)
	if got := git(t, remote, "rev-parse", "main"); got == pushed {
		t.Fatal("the second change was not pushed")
	}
	if _, err := gitErr(remote, "merge-base", "--is-ancestor", pushed, "main"); err != nil {
		t.Fatal("the second push is not a fast-forward of the first")
	}
	sameFiles(t, r.storeFiles(), checkout(t, freshClone(t, url)), nil)

	// Adopting again once pushed is refused.
	if _, err := x.Adopt(context.Background(), s, git(t, remote, "rev-parse", "main"), never); err == nil {
		t.Error("adopting the export's own pushed branch is accepted")
	}
}

// TestARemoteMovedAfterAdoptionIsRefused: a commit somebody else pushed on
// top of the adopted one before the export's first push, and the branch put
// back to the adopted commit after it, are both refused and left where they
// are.
func TestARemoteMovedAfterAdoptionIsRefused(t *testing.T) {
	r := newRig(t)
	remote, url, oldTip, _ := oldHistory(t)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, url))
	if _, err := adopt(t, x, out, url, oldTip); err != nil {
		t.Fatal(err)
	}

	// obsidian-git, still running on a laptop, pushes once more.
	work := filepath.Join(t.TempDir(), "laptop")
	git(t, filepath.Dir(work), "clone", "-q", "-b", "main", url, work)
	git(t, work, "commit", "-q", "--allow-empty", "-m", "vault backup: 2026-09-26 07:00:00")
	git(t, work, "push", "-q", "origin", "main")
	foreign := git(t, remote, "rev-parse", "main")

	r.put("Laptop", "a.md", []byte("a\n"))
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	x.sync(t)
	st := x.Status()
	if st.Push == nil || !strings.Contains(st.Push.Refused, "the export adopted it at "+short(oldTip)) {
		t.Fatalf("a remote moved after adoption is not refused:\n%s", statusJSON(st))
	}
	if got := git(t, remote, "rev-parse", "main"); got != foreign {
		t.Fatalf("the export moved the remote's branch to %s", got)
	}
	x.Reconfigure(adoptedSettings(t, out, url, oldTip), nil)
	x.sync(t)
	if got := git(t, remote, "rev-parse", "main"); got != foreign {
		t.Fatalf("after set, the export pushed over a foreign commit: %s", got)
	}

	// Put back at the adopted commit, the first push goes ahead.
	git(t, work, "push", "-q", "--force", "origin", oldTip+":refs/heads/main")
	x.Reconfigure(adoptedSettings(t, out, url, oldTip), nil)
	x.sync(t)
	pushed := tip(t, out, "main")
	if got := git(t, remote, "rev-parse", "main"); got != pushed {
		t.Fatalf("the export did not push once the remote was back at the adopted commit: %s\n%s", got,
			statusJSON(x.Status()))
	}

	// After it, the adopted commit is not the export's: a branch reset to it
	// is refused.
	git(t, work, "push", "-q", "--force", "origin", oldTip+":refs/heads/main")
	r.put("Laptop", "b.md", []byte("b\n"))
	r.clock.advance(10 * time.Minute)
	x.Reconfigure(adoptedSettings(t, out, url, oldTip), nil)
	x.sync(t)
	x.sync(t)
	if st := x.Status(); st.Push == nil || !strings.Contains(st.Push.Refused, "the export left it at "+short(pushed)) {
		t.Fatalf("a branch put back under the export's commits is not refused:\n%s", statusJSON(st))
	}
	if got := git(t, remote, "rev-parse", "main"); got != oldTip {
		t.Fatalf("the export moved the remote's branch to %s", got)
	}
}

// TestARebuildOfAnAdoptedBranchMakesTheSameCommits: an export made from
// scratch, in a data directory with no repository and no state but the same
// settings, the adopted commit among them, fetches that commit again and
// makes the same commits, byte for byte, and the remote takes it as the
// history it already has.
func TestARebuildOfAnAdoptedBranchMakesTheSameCommits(t *testing.T) {
	r := newRig(t)
	remote, url, oldTip, _ := oldHistory(t)
	incremental := t.TempDir()
	x := r.exporter(incremental, settings(t, incremental, url))
	if _, err := adopt(t, x, incremental, url, oldTip); err != nil {
		t.Fatal(err)
	}
	vaultOf(r, 12)
	x.sync(t)
	for round := range 4 {
		r.put([]string{"Laptop", "Phone"}[round%2], "Notes/001.md", []byte{byte('a' + round), '\n'})
		r.clock.advance(7 * time.Minute)
		x.sync(t)
		x.sync(t)
	}
	r.clock.advance(time.Hour)
	x.sync(t)
	x.sync(t)
	pushed := git(t, remote, "rev-parse", "main")
	if pushed != tip(t, incremental, "main") {
		t.Fatalf("the incremental export is not pushed:\n%s", statusJSON(x.Status()))
	}

	scratch := t.TempDir()
	y := r.exporter(scratch, adoptedSettings(t, scratch, url, oldTip))
	y.sync(t)
	y.sync(t)
	if b := tip(t, scratch, "main"); b != pushed {
		t.Fatalf("the incremental export is at %s and the rebuild at %s", pushed, b)
	}
	if st := y.Status(); st.Push == nil || st.Push.Refused != "" || st.Push.LastError != "" || st.Push.Pushed != pushed {
		t.Fatalf("the remote does not take the rebuild as its own history:\n%s", statusJSON(st))
	}
	if got := git(t, remote, "rev-parse", "main"); got != pushed {
		t.Fatalf("the rebuild moved the remote to %s", got)
	}

	// With the old history's remote gone, a rebuild that cannot fetch the
	// adopted commit stops with an error and makes no commit.
	gone := t.TempDir()
	missing := "file://" + filepath.Join(t.TempDir(), "missing.git")
	z := r.exporter(gone, adoptedSettings(t, gone, missing, oldTip))
	if _, _, err := z.cycle(context.Background()); err == nil || !strings.Contains(err.Error(), "adopted commit") {
		t.Fatalf("a rebuild without the adopted commit: %v", err)
	}
	if _, err := gitErr(repo(gone), "rev-parse", "--verify", "refs/heads/main"); err == nil {
		t.Fatal("a rebuild without the adopted commit made a branch")
	}
}

// TestAStateDatabaseFromBeforeAdoptionOpens: a state database made before the
// adopted column, read by status, gains the column and keeps its rows.
func TestAStateDatabaseFromBeforeAdoptionOpens(t *testing.T) {
	dir := filepath.Join(t.TempDir(), Dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, StateFile))
	if err != nil {
		t.Fatal(err)
	}
	old := strings.Replace(stateSchema, ",\n  adopted         TEXT    NOT NULL DEFAULT ''", "", 1)
	if old == stateSchema {
		t.Fatal("the test no longer finds the adopted column in the schema")
	}
	if _, err := db.Exec(old); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO branches (branch, vault, epoch, through, last_at, commit_sha, updated_at)
	  VALUES ('main', 'v1', 'e', 7, 1, 'abc', 1)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	ro, err := openState(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	defer ro.Close()
	b, found, err := loadBranch(ro, "main")
	if err != nil || !found || b.through != 7 || b.commit != "abc" || b.adopted != "" {
		t.Fatalf("the old row reads as %+v, %v, %v", b, found, err)
	}
}
