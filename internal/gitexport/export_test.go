package gitexport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// awkward are paths the export must quote, escape or both: spaces, glob
// characters, quotes, a hash, non-ASCII, and a conflict copy's
// name as the plugin writes it.
var awkward = []string{
	"Inbox/a note.md",
	"Projects/[draft] plan*?.md",
	`Quotes/"quoted" and 'single'.md`,
	"#tags/#hash.md",
	"Café/naïve résumé.md",
	"日本語/メモ.md",
	"Journal/2026-09-01 (Conflicted copy Laptop 202609011130).md",
	"Deep/a/b/c/d/e.md",
}

// vaultOf writes a generated vault through r: notes, awkward names, two
// attachments over the test's LFS threshold, and a folder.
func vaultOf(r *rig, notesN int) {
	for i := range notesN {
		r.put("Laptop", fmt.Sprintf("Notes/%03d.md", i), []byte(fmt.Sprintf("# Note %d\n\nGenerated body %d.\n", i, i)))
	}
	for _, p := range awkward {
		r.put("Laptop", p, []byte("body of "+p+"\n"))
	}
	r.put("Laptop", "Attachments/photo [1].png", bytes.Repeat([]byte{0x89, 'P', 'N', 'G'}, 3000))
	r.put("Laptop", "Attachments/scan.pdf", bytes.Repeat([]byte("%PDF-1.7 "), 1000))
	r.put("Laptop", "empty.md", nil)
	r.folder("Laptop", "Empty folder")
}

// TestTheTipMatchesTheStore: a checkout of the export's tip holds exactly the
// store's live files at its head, each byte for byte, with every file over
// the threshold as an LFS pointer to its bytes and those bytes in the
// repository's LFS store, through renames, deletions, a device's edits and an
// agent's operation.
func TestTheTipMatchesTheStore(t *testing.T) {
	r := newRig(t)
	vaultOf(r, 40)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)
	r.clock.advance(10 * time.Minute)
	x.sync(t)

	r.put("Phone", "Notes/001.md", []byte("edited on the phone\n"))
	r.rename("Phone", "Notes/002.md", "Archive/002.md", []byte("# Note 2\n\nGenerated body 2.\n"))
	r.remove("Phone", "Notes/003.md")
	r.rename("Phone", "Attachments/scan.pdf", "Attachments/moved scan.pdf", bytes.Repeat([]byte("%PDF-1.7 "), 1000))
	r.clock.advance(time.Minute)
	opID := r.op("edit_note", map[string]string{"Notes/004.md": "the agent wrote this\n", "Agent/new.md": "new\n"})
	r.clock.advance(10 * time.Minute)
	x.sync(t)

	if s := x.Status(); s.Error != "" || s.Refused != "" {
		t.Fatalf("the export reports trouble:\n%s", statusJSON(s))
	}
	head, _ := r.st.LatestUID(vault)
	if s := x.Status(); s.ExportedThrough != head {
		t.Fatalf("exported through %d, and the head is %d", s.ExportedThrough, head)
	}

	work := filepath.Join(t.TempDir(), "work")
	git(t, filepath.Dir(work), "clone", "-q", "-b", "main", repo(out), work)
	lfs := map[string]bool{"Attachments/photo [1].png": true, "Attachments/moved scan.pdf": true}
	want := r.storeFiles()
	sameFiles(t, want, checkout(t, work), lfs)

	// Each LFS object is in the repository's LFS store, under its oid.
	for p := range lfs {
		sum := sha256.Sum256(want[p])
		oid := hex.EncodeToString(sum[:])
		b, err := os.ReadFile(filepath.Join(repo(out), "lfs", "objects", oid[:2], oid[2:4], oid))
		if err != nil || !bytes.Equal(b, want[p]) {
			t.Errorf("the LFS object for %s is not the file's bytes: %v", p, err)
		}
		if attr := git(t, work, "check-attr", "filter", "--", p); !strings.HasSuffix(attr, "filter: lfs") {
			t.Errorf("git does not read %s as an LFS file: %s", p, attr)
		}
	}
	if attr := git(t, work, "check-attr", "filter", "--", "Attachments/photo 1.png"); !strings.HasSuffix(attr, "unspecified") {
		t.Errorf("the pattern for a bracketed name matches another name: %s", attr)
	}

	// The agent's operation is one commit of its own, naming it.
	log := git(t, work, "log", "--format=%an%x00%B%x00", "-1", "--grep=Trew-Operation: "+opID)
	if !strings.HasPrefix(log, "Claude\x00edit_note by Claude: 2 files") || !strings.Contains(log, "Trew-Tool: edit_note") {
		t.Errorf("the operation's commit is not what it should be:\n%q", log)
	}
	if n := git(t, work, "rev-list", "--count", "--grep=Trew-Operation: "+opID, "HEAD"); n != "1" {
		t.Errorf("the operation is in %s commits", n)
	}
	if fsck, err := gitErr(repo(out), "fsck", "--strict", "--no-dangling"); err != nil {
		t.Errorf("git fsck refuses the repository: %v\n%s", err, fsck)
	}
}

// TestARebuildMakesTheSameCommits: an export made step by step while the
// notes arrived, with the clock moving and the quiet window closing runs, has
// the same tip as one made from scratch afterwards, from the same store: every
// commit the same, byte for byte.
func TestARebuildMakesTheSameCommits(t *testing.T) {
	r := newRig(t)
	incremental := t.TempDir()
	x := r.exporter(incremental, settings(t, incremental, ""))

	vaultOf(r, 30)
	x.sync(t)
	for round := range 12 {
		device := []string{"Laptop", "Phone"}[round%2]
		for i := range 5 {
			r.put(device, fmt.Sprintf("Notes/%03d.md", (round*7+i)%30), []byte(fmt.Sprintf("round %d edit %d\n", round, i)))
			r.clock.advance(time.Duration(20+round) * time.Second)
			x.sync(t)
		}
		if round%3 == 0 {
			r.op("append_note", map[string]string{fmt.Sprintf("Agent/%d.md", round): "agent round\n"})
			x.sync(t)
		}
		if round%4 == 1 {
			r.remove(device, fmt.Sprintf("Notes/%03d.md", 29-round))
		}
		r.clock.advance(time.Duration(1+round%3) * 3 * time.Minute)
		x.sync(t)
	}
	r.clock.advance(time.Hour)
	x.sync(t)

	scratch := t.TempDir()
	y := r.exporter(scratch, settings(t, scratch, ""))
	y.sync(t)

	a, b := tip(t, incremental, "main"), tip(t, scratch, "main")
	if a != b {
		t.Fatalf("the incremental export is at %s and the rebuild at %s:\n%s\n---\n%s", a, b,
			git(t, repo(incremental), "log", "--format=%H %s", "-8"), git(t, repo(scratch), "log", "--format=%H %s", "-8"))
	}
	commits := git(t, repo(scratch), "rev-list", "--count", "main")
	if n := git(t, repo(scratch), "rev-list", "--count", "--merges", "main"); n != "0" {
		t.Errorf("the history has %s merges", n)
	}
	t.Logf("%s commits, the same in both", commits)
}

// T47. The export closes a device's run once its last version has been quiet
// for the window by the clock, and a version's time is taken before its
// commit lands, so a version given a time inside the window and landing just
// after the export read the store was a run of its own in the export and part
// of the first run in a rebuild, which decides from the times alone: two
// histories of one store, and the remote then refuses the documented remedy,
// rebuilding from scratch. A run is closed by the clock only a margin past
// its window now, which a write in flight does not outlast.
func TestAWriteLandingAsTheWindowClosesDoesNotSplitTheRun(t *testing.T) {
	r := newRig(t)
	incremental := t.TempDir()
	x := r.exporter(incremental, settings(t, incremental, ""))
	r.put("Laptop", "Journal.md", []byte("draft 1\n"))
	// The export reads the store as the window closes on the first draft...
	r.clock.advance(5 * time.Minute)
	x.sync(t)
	// ...while a second draft is in flight: its time was taken a second
	// before that, and its commit lands after the read. The clock is put back
	// to give it that time.
	r.clock.advance(-time.Second)
	r.put("Laptop", "Journal.md", []byte("draft 2\n"))
	r.clock.advance(time.Hour)
	x.sync(t)

	scratch := t.TempDir()
	y := r.exporter(scratch, settings(t, scratch, ""))
	y.sync(t)
	if a, b := tip(t, incremental, "main"), tip(t, scratch, "main"); a != b {
		t.Fatalf("the incremental export is at %s and the rebuild at %s:\n%s\n---\n%s", a, b,
			git(t, repo(incremental), "log", "--format=%H %s"), git(t, repo(scratch), "log", "--format=%H %s"))
	}
}

// TestAQuietWindowCoalescesADevicesRun: a device's saves within the window are
// one commit, dated by the server when the last was committed and never by the
// device's mtime; a pause of the window starts the next; another device, or an
// agent, starts its own.
func TestAQuietWindowCoalescesADevicesRun(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, ""))
	start := r.clock.Now()
	for i := range 4 {
		r.put("Laptop", "Journal.md", []byte(fmt.Sprintf("draft %d\n", i)))
		r.clock.advance(time.Minute)
	}
	x.sync(t)
	if _, err := revParseIn(repo(out), "main"); err == nil {
		t.Fatal("a run still inside its quiet window was committed")
	}
	r.clock.advance(5 * time.Minute)
	r.put("Phone", "Phone.md", []byte("from the phone\n"))
	r.clock.advance(6 * time.Minute)
	x.sync(t)

	log := git(t, repo(out), "log", "--reverse", "--format=%an|%at|%s", "main")
	want := fmt.Sprintf("Laptop|%d|Laptop: Journal.md\nPhone|%d|Phone: Phone.md",
		start.Add(3*time.Minute).Unix(), start.Add(9*time.Minute).Unix())
	if log != want {
		t.Errorf("the history is\n%s\nand should be\n%s", log, want)
	}
	if b := git(t, repo(out), "show", "main~1:Journal.md"); b != "draft 3" {
		t.Errorf("the run's commit holds %q, not its last version", b)
	}
}

func revParseIn(dir, ref string) (string, error) {
	out, err := gitErr(dir, "rev-parse", "--verify", "-q", "refs/heads/"+ref)
	return strings.TrimSpace(out), err
}

// TestAMovedBranchIsRefused: a branch somebody else moved, in the local
// repository, stops the export where it is. Nothing is moved back, the state
// does not advance, the status says why, and the export goes on only once the
// branch is back where it left it.
func TestAMovedBranchIsRefused(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, ""))
	r.put("Laptop", "a.md", []byte("a\n"))
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	ours := tip(t, out, "main")

	tree := git(t, repo(out), "rev-parse", "main^{tree}")
	foreign := git(t, repo(out), "commit-tree", tree, "-p", ours, "-m", "somebody else's commit")
	git(t, repo(out), "update-ref", "refs/heads/main", foreign)

	r.put("Laptop", "b.md", []byte("b\n"))
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	s := x.Status()
	if s.Refused == "" || !strings.Contains(s.Refused, "the export left it at") {
		t.Fatalf("a moved branch is not refused:\n%s", statusJSON(s))
	}
	if got := tip(t, out, "main"); got != foreign {
		t.Fatalf("the export moved the branch from %s to %s", foreign, got)
	}
	if s.Commit != ours {
		t.Fatalf("the state says %s and the export left the branch at %s", s.Commit, ours)
	}

	// Put back where the export left it, the export goes on.
	git(t, repo(out), "update-ref", "refs/heads/main", ours)
	x.sync(t)
	if s := x.Status(); s.Refused != "" || s.Commit == ours {
		t.Fatalf("the export did not go on once the branch was back:\n%s", statusJSON(s))
	}
}

// TestARestoreIsOneMarkedCommit: a store restored from a backup has a new
// epoch, and the export does not rewrite the branch for it: one commit, marked
// in its message and trailers, puts the restored notes on top of the history,
// which is still there under it.
func TestARestoreIsOneMarkedCommit(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	r.put("Laptop", "kept.md", []byte("in the backup\n"))
	// Settings in the backup stay out of the restore's commit as they stay
	// out of every other (TestSettingsAreLeftOutOfTheExportQuietly).
	r.put("Laptop", ".obsidian/app.json", []byte("{}\n"))
	backup := filepath.Join(t.TempDir(), "backup")
	if _, err := r.st.Backup(backup, false); err != nil {
		t.Fatal(err)
	}
	r.put("Laptop", "later.md", []byte("after the backup\n"))
	r.clock.advance(10 * time.Minute)
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)
	before := tip(t, out, "main")
	x.Close()

	restored := openRig(t, backup, r.clock)
	if restored.st.Epoch() == r.st.Epoch() {
		t.Fatal("the backup has the store's epoch")
	}
	y := restored.exporter(out, settings(t, out, ""))
	y.sync(t)
	after := tip(t, out, "main")
	if _, err := gitErr(repo(out), "merge-base", "--is-ancestor", before, after); err != nil {
		t.Fatalf("the history before the restore is not under the restore's commit")
	}
	msg := git(t, repo(out), "log", "-1", "--format=%B", after)
	if !strings.HasPrefix(msg, "Restore: the store was restored from a backup") ||
		!strings.Contains(msg, "Trew-Previous-Epoch: "+r.st.Epoch()) || !strings.Contains(msg, "Trew-Epoch: "+restored.st.Epoch()) {
		t.Fatalf("the restore's commit is not marked:\n%s", msg)
	}
	if files := git(t, repo(out), "ls-tree", "-r", "--name-only", after); files != "kept.md" {
		t.Fatalf("the restore's commit holds %q", files)
	}
}

// rotChunks overwrites the store's bodies of path's live version, so a step
// that read them would fail.
func (r *rig) rotChunks(path string) {
	r.t.Helper()
	e, _, _, err := r.st.EntryAsOf(vault, path, 0)
	if err != nil {
		r.t.Fatal(err)
	}
	for _, name := range e.Chunks {
		p, err := r.st.Chunks().Path(vault, name)
		if err != nil {
			r.t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("rotted"), 0o600); err != nil {
			r.t.Fatal(err)
		}
	}
}

// A version whose bytes the repository already holds is named by its blob,
// not read from the store and streamed into fast-import again (ops review,
// performance). Renaming a 64 MiB attachment cost a full read, a temporary
// copy and an fsync under LFS (1.5 to 2.2 s here) and a full read and stream
// as a plain blob (5.1 to 6.3 s), for bytes the repository had. The moved
// notes' bodies are made unreadable in the store first, so a step that read
// them would fail; the export names them, and the commit holds them.
func TestARenameNamesTheBlobItAlreadyHas(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, ""))
	small := []byte("a note that moves\n")
	large := bytes.Repeat([]byte("an attachment over the LFS threshold\n"), 300)
	r.put("Laptop", "note.md", small)
	r.put("Laptop", "big.bin", large)
	r.clock.advance(time.Hour)
	x.sync(t)
	pointer := git(t, repo(out), "show", "main:big.bin")

	r.rename("Laptop", "note.md", "moved/note.md", small)
	r.rename("Laptop", "big.bin", "moved/big.bin", large)
	r.rotChunks("moved/note.md")
	r.rotChunks("moved/big.bin")
	r.clock.advance(time.Hour)
	x.sync(t)
	if got := git(t, repo(out), "show", "main:moved/note.md"); got+"\n" != string(small) {
		t.Fatalf("the moved note holds %q", got)
	}
	if got := git(t, repo(out), "show", "main:moved/big.bin"); got != pointer {
		t.Fatalf("the moved attachment's pointer is\n%s\nnot\n%s", got, pointer)
	}
}

// A blob the repository has lost, to a gc somebody ran in it for instance,
// fails the step that names it; the export then forgets every blob it
// remembered, and the next step streams the bytes again.
func TestABlobTheRepositoryLostIsStreamedAgain(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	x := r.exporter(out, settings(t, out, ""))
	body := []byte("a note copied somewhere else\n")
	r.put("Laptop", "a.md", body)
	r.clock.advance(time.Hour)
	x.sync(t)
	e, _, _, err := r.st.EntryAsOf(vault, "a.md", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.Exec(`UPDATE blobs SET sha = ? WHERE content = ?`, strings.Repeat("1", 40), contentKey(e)); err != nil {
		t.Fatal(err)
	}

	r.put("Laptop", "copy.md", body)
	r.clock.advance(time.Hour)
	if _, _, err := x.cycle(context.Background()); err == nil {
		t.Fatal("a step naming a blob the repository does not have succeeded")
	}
	x.sync(t)
	if got := git(t, repo(out), "show", "main:copy.md"); got+"\n" != string(body) {
		t.Fatalf("the copy holds %q", got)
	}
}

// TestAPathGitCannotHoldIsLeftOutAndSaid: git~1 is Windows' short name for
// .git, and git fsck refuses it in any tree. The export leaves it out, says so,
// and exports the rest.
func TestAPathGitCannotHoldIsLeftOutAndSaid(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	r.put("Laptop", "GIT~1/config", []byte("x\n"))
	r.put("Laptop", "fine.md", []byte("y\n"))
	r.clock.advance(10 * time.Minute)
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)
	s := x.Status()
	if s.Excluded != 1 || len(s.ExcludedPaths) != 1 || s.ExcludedPaths[0] != "GIT~1/config" {
		t.Fatalf("the path is not reported:\n%s", statusJSON(s))
	}
	if files := git(t, repo(out), "ls-tree", "-r", "--name-only", "main"); files != "fine.md" {
		t.Fatalf("the tree holds %q", files)
	}
}

// TestPathsGitRefusesAreLeftOut: a note may name .git, .gitmodules or
// .gitattributes the way NTFS reads a name (a short name, a stream, trailing
// dots and spaces, any case). fast-import refuses some of them and git fsck
// the rest, so a remote checking what it receives refuses the push. The export
// leaves each out, says so, and the tree it writes passes fsck --strict. Names
// merely like those are kept. The HFS+ forms, which the store now refuses as
// new names, are TestGitSafeAgreesWithGit's.
func TestPathsGitRefusesAreLeftOut(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	submodule := []byte("[submodule \"x\"]\n\tpath = x\n\turl = --upload-pack=evil\n")
	bad := []string{
		"git~1:x/y.md",
		"a/GIT~1 ./y.md",
		"git~1.:x",
		"gitmod~1",
		"Notes/GITMOD~4.",
		"gi7eba~1",
		"gitmod~1:x",
		"gitatt~1",
	}
	for _, p := range bad {
		r.put("Laptop", p, submodule)
	}
	kept := []string{"fine.md", "git~2/x.md", "my gitmodules.md", "gitmod~1x.md", "Notes/github~1.md"}
	for _, p := range kept {
		r.put("Laptop", p, []byte("y\n"))
	}
	r.clock.advance(10 * time.Minute)
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)
	if got, err := gitErr(repo(out), "fsck", "--strict"); err != nil {
		t.Fatalf("git fsck refuses the export: %v\n%s", err, got)
	}
	s := x.Status()
	if s.Excluded != len(bad) {
		t.Fatalf("%d of %d paths are reported:\n%s", s.Excluded, len(bad), statusJSON(s))
	}
	files := strings.Split(git(t, repo(out), "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "main"), "\n")
	slices.Sort(files)
	want := slices.Sorted(slices.Values(kept))
	if !slices.Equal(files, want) {
		t.Fatalf("the tree holds %q, want %q", files, want)
	}
}

// TestGitSafeAgreesWithGit: each name gitSafe refuses is one real Git refuses,
// by fast-import (verify_path, with core.protectHFS on as on a Mac) or by git
// fsck --strict with core.protectHFS off as on Linux, where the HFS+ forms
// import and fail fsck as hasDotgit. Each name it lets through, Git takes.
// Run with the body of a hostile .gitmodules, which fsck reads in any file it
// takes for one.
func TestGitSafeAgreesWithGit(t *testing.T) {
	needGit(t)
	body := "[submodule \"x\"]\n\tpath = x\n\turl = --upload-pack=evil\n"
	refused := []string{
		"git~1:x/y.md", "a/GIT~1 ./y.md", "git~1.:x", `git~1\x.md`, "a/.GIT/x",
		"\u200c.git/x.md", "a/\u200f.Git/x.md", "\ufeff.GIT/x.md", ".gi\u200dt/x.md",
		"gitmod~1", "Notes/GITMOD~4.", "gi7eba~1", "gitmod~1:x", "\u200c.gitmodules", ".gitmodules",
	}
	taken := []string{"fine.md", "git~2/x.md", "my gitmodules.md", "gitmod~1x.md", "Notes/github~1.md",
		"\u200cgit/x.md", "\U0001f468\u200d\U0001f469 family.md"}
	// git refuses each of these, as gitSafe does, by the bytes of the files
	// fsck checks; gitSafe leaves them out as well, as the export's own
	// .gitattributes would otherwise have a twin on a Windows checkout.
	alsoLeftOut := []string{"gitatt~1", "\u202a.gitattributes"}
	gitTakes := func(p string) bool {
		for _, protectHFS := range []string{"true", "false"} {
			dir := t.TempDir()
			git(t, dir, "init", "--bare", "-q")
			stream := fmt.Sprintf("commit refs/heads/main\nauthor A <a@b.invalid> 1 +0000\n"+
				"committer A <a@b.invalid> 1 +0000\ndata 2\nm\nM 100644 inline %s\ndata %d\n%s\n\ndone\n",
				cQuote(p), len(body), body)
			cmd := exec.Command("git", "-c", "core.protectHFS="+protectHFS, "fast-import", "--done", "--quiet", "--force")
			cmd.Dir, cmd.Stdin = dir, strings.NewReader(stream)
			cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "HOME="+dir)
			if err := cmd.Run(); err != nil {
				return false
			}
			if _, err := gitErr(dir, "fsck", "--strict"); err != nil {
				return false
			}
		}
		return true
	}
	for _, p := range refused {
		if gitSafe(p) {
			t.Errorf("gitSafe lets %+q through", p)
		}
		if gitTakes(p) {
			t.Errorf("git takes %+q, so the case tests nothing", p)
		}
	}
	for _, p := range taken {
		if !gitSafe(p) {
			t.Errorf("gitSafe refuses %+q", p)
		}
		if !gitTakes(p) {
			t.Errorf("git refuses %+q", p)
		}
	}
	for _, p := range alsoLeftOut {
		if gitSafe(p) {
			t.Errorf("gitSafe lets %+q through", p)
		}
	}
}

// TestAPathFastImportRefusesIsLeftOut: a path gitSafe lets through and
// fast-import refuses stops the stream. The export learns the path from
// fast-import's "invalid path", leaves it out and exports the rest, instead
// of writing the same stream for ever and nothing after it. gitSafe is
// stood in for by one that lets everything through, so a path it would have
// caught plays a rule of Git's it does not know.
func TestAPathFastImportRefusesIsLeftOut(t *testing.T) {
	pathOK = func(string) bool { return true }
	t.Cleanup(func() { pathOK = gitSafe })
	r := newRig(t)
	out := t.TempDir()
	r.put("Laptop", "a/git~1:x/b.md", []byte("x\n"))
	r.put("Laptop", "fine.md", []byte("y\n"))
	r.clock.advance(10 * time.Minute)
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)
	s := x.Status()
	if s.Excluded != 1 || s.ExcludedPaths[0] != "a/git~1:x/b.md" {
		t.Fatalf("the path is not reported:\n%s", statusJSON(s))
	}
	if files := git(t, repo(out), "ls-tree", "-r", "--name-only", "main"); files != "fine.md" {
		t.Fatalf("the tree holds %q", files)
	}
	r.put("Laptop", "later.md", []byte("z\n"))
	r.clock.advance(10 * time.Minute)
	x.sync(t)
	if files := git(t, repo(out), "ls-tree", "-r", "--name-only", "main"); files != "fine.md\nlater.md" {
		t.Fatalf("a later note is not exported: the tree holds %q", files)
	}
}

// TestAnLFSPathTooLongForGitattributesIsLeftOut: Git ignores a .gitattributes
// line of 2048 bytes or more and fsck refuses the file, and escaping can
// double a path. An LFS file whose line would be that long is left out; the
// other LFS file is still tracked, and the tree passes fsck --strict.
func TestAnLFSPathTooLongForGitattributesIsLeftOut(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	long := strings.Join([]string{strings.Repeat("[", 250), strings.Repeat("[", 250), strings.Repeat("[", 250),
		strings.Repeat("[", 250)}, "/")
	big := bytes.Repeat([]byte("0123456789abcdef"), 512) // over the test's 4096-byte threshold
	r.put("Laptop", long, big)
	r.put("Laptop", "small "+strings.Repeat("[", 200)+".md", []byte("y\n"))
	r.put("Laptop", "big.bin", big)
	r.clock.advance(10 * time.Minute)
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)
	if got, err := gitErr(repo(out), "fsck", "--strict"); err != nil {
		t.Fatalf("git fsck refuses the export: %v\n%s", err, got)
	}
	s := x.Status()
	if s.Excluded != 1 || s.ExcludedPaths[0] != long {
		t.Fatalf("the path is not reported:\n%s", statusJSON(s))
	}
	attrs := git(t, repo(out), "show", "main:"+attributesPath)
	if !strings.Contains(attrs, `"/big.bin"`+lfsAttributes) || strings.Count(attrs, lfsAttributes) != 1 {
		t.Fatalf("the attributes are\n%s", attrs)
	}
	if n := len(strings.Split(git(t, repo(out), "ls-tree", "-r", "--name-only", "main"), "\n")); n != 3 {
		t.Fatalf("the tree holds %d files", n)
	}
}

// Settings are a device's, not the vault's history (plan/settings-sync.md,
// section 7), and the store holds them from protocol 3. The export leaves them
// out without calling them excluded, because nothing is wrong with them: the
// export's report of excluded paths is for a path Git cannot hold.
func TestSettingsAreLeftOutOfTheExportQuietly(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	r.put("Laptop", ".obsidian/app.json", []byte("{}\n"))
	r.put("Phone", ".obsidian-mobile/snippets/wide.css", []byte("body {}\n"))
	r.put("Laptop", "note.md", []byte("y\n"))
	r.clock.advance(10 * time.Minute)
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)
	if s := x.Status(); s.Excluded != 0 {
		t.Fatalf("settings are reported as excluded:\n%s", statusJSON(s))
	}
	if files := git(t, repo(out), "ls-tree", "-r", "--name-only", "main"); files != "note.md" {
		t.Fatalf("the tree holds %q", files)
	}
}

// A setting is left out of the plan as well as the tree: a phone saving one
// between two of the laptop's note edits does not split the laptop's run into
// two commits, and a setting saved last does not move the commit's time. The
// export's position still covers the settings, so doctor does not read a
// settings save at the head as a version not exported, and a save alone at
// the head moves it at once, with no commit.
func TestSettingsShapeNoCommit(t *testing.T) {
	r := newRig(t)
	out := t.TempDir()
	r.put("Laptop", "a.md", []byte("one\n"))
	r.clock.advance(time.Minute)
	r.put("Phone", ".obsidian-mobile/app.json", []byte("{}\n"))
	r.clock.advance(time.Minute)
	r.put("Laptop", "b.md", []byte("two\n"))
	noteAt := r.clock.Now().Unix()
	r.clock.advance(time.Minute)
	r.put("Laptop", ".obsidian/app.json", []byte("{}\n"))
	r.clock.advance(10 * time.Minute)
	x := r.exporter(out, settings(t, out, ""))
	x.sync(t)

	if n := git(t, repo(out), "rev-list", "--count", "main"); n != "1" {
		t.Fatalf("the laptop's two edits are %s commits:\n%s", n, git(t, repo(out), "log", "--format=%s", "main"))
	}
	if at := git(t, repo(out), "log", "-1", "--format=%ct", "main"); at != fmt.Sprint(noteAt) {
		t.Fatalf("the commit is dated %s, and the laptop's last note at %d", at, noteAt)
	}
	head, _ := r.st.LatestUID(vault)
	if s := x.Status(); s.ExportedThrough != head {
		t.Fatalf("exported through %d, and the head is a setting at %d", s.ExportedThrough, head)
	}

	saved := r.put("Phone", ".obsidian-mobile/app.json", []byte(`{"a":1}`+"\n"))
	x.sync(t)
	if s := x.Status(); s.ExportedThrough != saved {
		t.Fatalf("exported through %d, and a settings save alone is at %d", s.ExportedThrough, saved)
	}
	if n := git(t, repo(out), "rev-list", "--count", "main"); n != "1" {
		t.Fatalf("a settings save made a commit: %s commits", n)
	}
}
