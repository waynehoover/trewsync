// The commands, run.
//
// This package had no tests. Everything under internal/ is exercised heavily and
// the four things a person actually types were not, including the two that can
// destroy data. `backup` promises that restoring is copying the directory back,
// and nothing had ever copied one back.
//
// These call run() rather than a subprocess, so a failure points at a line.

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/waynehoover/trewsync/internal/invite"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/dirlock"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/server"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
)

// seeded builds a data directory with some history in it, the way a server
// would have, and returns its path.
func seeded(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}

	put := func(path string, bodies ...string) store.Entry {
		t.Helper()
		names := make([]string, 0, len(bodies))
		size := 0
		for _, b := range bodies {
			n := chunks.Name([]byte(b))
			if err := st.Chunks().Put("default", n, []byte(b)); err != nil {
				t.Fatalf("put chunk: %v", err)
			}
			names = append(names, n)
			size += len(b)
		}
		e := store.Entry{Path: path, Size: int64(size), MTime: 10, Device: "seed", Chunks: names}
		uid, err := st.AppendEntry("default", e)
		if err != nil {
			t.Fatalf("append %s: %v", path, err)
		}
		e.UID = uid
		return e
	}

	put("note.md", "version one")
	put("note.md", "version two")
	put("note.md", "version three")
	put("other.md", "only version")
	put("attachment.bin", "part one ", "part two ", "part three")
	if _, err := st.AppendEntry("default", store.Entry{Path: "gone.md", Deleted: true, MTime: 20}); err != nil {
		t.Fatalf("append deletion: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return dir
}

// appendOne adds one more version to an existing store, so a backup taken
// before it is legitimately behind.
func appendOne(t *testing.T, dir, path, body string) {
	t.Helper()
	st, err := store.Open(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() {
		if err := st.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}()
	name := chunks.Name([]byte(body))
	if err := st.Chunks().Put("default", name, []byte(body)); err != nil {
		t.Fatalf("put chunk: %v", err)
	}
	if _, err := st.AppendEntry("default", store.Entry{
		Path: path, Size: int64(len(body)), MTime: 30, Device: "seed",
		Chunks: []string{name},
	}); err != nil {
		t.Fatalf("append %s: %v", path, err)
	}
}

// trew runs a trewd command and returns what it printed.
func trew(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(context.Background(), args, &out)
	return out.String(), err
}

func mustRun(t *testing.T, args ...string) string {
	t.Helper()
	out, err := trew(t, args...)
	if err != nil {
		t.Fatalf("trewd %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

/* ---------------------------------------------------------------- *
 * verify
 * ---------------------------------------------------------------- */

func TestVerifyIsQuietOnAGoodDirectory(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "verify", "-data", dir, "-deep")
	if !strings.Contains(out, "0 faults") {
		t.Fatalf("verify said:\n%s", out)
	}
}

// The whole point of naming chunks by their hash: a body that has rotted can be
// found rather than served.
func TestVerifyDeepFindsARottedBody(t *testing.T) {
	dir := seeded(t)
	corruptOneBody(t, dir)

	// The shallow pass only asks whether the file is there, and it is.
	shallow := mustRun(t, "verify", "-data", dir)
	if !strings.Contains(shallow, "0 faults") {
		t.Fatalf("a shallow verify should not have read the bytes:\n%s", shallow)
	}

	out, err := trew(t, "verify", "-data", dir, "-deep")
	if err == nil {
		t.Fatalf("a deep verify passed over a corrupt body:\n%s", out)
	}
	if !strings.Contains(out, "corrupt") {
		t.Fatalf("deep verify said:\n%s", out)
	}
}

func TestVerifyFindsAMissingBody(t *testing.T) {
	dir := seeded(t)
	removeOneBody(t, dir)
	out, err := trew(t, "verify", "-data", dir)
	if err == nil {
		t.Fatalf("verify passed over a missing body:\n%s", out)
	}
	if !strings.Contains(out, "missing") {
		t.Fatalf("verify said:\n%s", out)
	}
}

// I2. `verify -deep` opens the registry too, and says how much of it it opened.
//
// A device row whose auth hash has rotted is one device refused with "not
// authorised", which is what the server says to a stranger, and until this
// nothing on the machine ever said the registry was the reason. It is not
// reachable from the entries walk, because it is not an entry.
func TestVerifyDeepChecksTheRegistryAndSaysWhatItChecked(t *testing.T) {
	dir := seeded(t)
	registryOn(t, dir)

	out := mustRun(t, "verify", "-data", dir, "-deep")
	// Rule 8: the count, not only the pass. A registry that was never walked
	// and a registry with nothing wrong with it read identically otherwise.
	if !strings.Contains(out, "2 registry rows") || !strings.Contains(out, "0 faults") {
		t.Fatalf("verify -deep said:\n%s", out)
	}
	// The shallow pass does not open them, so it must not mention them: "0
	// registry rows" would read as a registry looked at and found empty.
	if shallow := mustRun(t, "verify", "-data", dir); strings.Contains(shallow, "registry") {
		t.Fatalf("a shallow verify claims to have read the registry:\n%s", shallow)
	}

	// Now rot the one field a device is recognised by.
	execSQL(t, dir, `UPDATE devices SET auth_hash = 'nonsense'`)
	if shallow := mustRun(t, "verify", "-data", dir); !strings.Contains(shallow, "0 faults") {
		t.Fatalf("a shallow verify read the registry after all:\n%s", shallow)
	}
	out, err := trew(t, "verify", "-data", dir, "-deep")
	if err == nil {
		t.Fatalf("a deep verify passed over a device nothing can authenticate:\n%s", out)
	}
	for _, want := range []string{"baddevice", `device "alfa"`, "not authorised"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the fault does not mention %q:\n%s", want, out)
		}
	}
}

// registryOn puts a device and an outstanding invite on the seeded vault, which
// is what a vault anybody is using has.
func registryOn(t *testing.T, dir string) {
	t.Helper()
	st, err := store.Open(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	if err := st.RegisterDevice("default", "alfa", "laptop", strings.Repeat("b", 64), 1000); err != nil {
		t.Fatalf("register: %v", err)
	}
	expires := time.Now().Add(time.Hour).UnixMilli()
	if _, err := st.CreateInvite("default", "", "", &expires, time.Now().UnixMilli()); err != nil {
		t.Fatalf("invite: %v", err)
	}
}

// execSQL damages the database the third way a data directory can be damaged,
// after a missing body and a rotted one: a row that no longer decodes. There is
// no store call that writes one, which is the point.
func execSQL(t *testing.T, dir, query string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(dir, "trew.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(query); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

/* helpers that damage a directory in the two ways it can be damaged */

func bodyPaths(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(filepath.Join(dir, "chunks"), func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk chunks: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("no chunk bodies to damage")
	}
	return out
}

func corruptOneBody(t *testing.T, dir string) {
	t.Helper()
	p := bodyPaths(t, dir)[0]
	body, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	body[0] ^= 0xff
	if err := os.WriteFile(p, body, 0o600); err != nil {
		t.Fatalf("write body: %v", err)
	}
}

func removeOneBody(t *testing.T, dir string) {
	t.Helper()
	if err := os.Remove(bodyPaths(t, dir)[0]); err != nil {
		t.Fatalf("remove body: %v", err)
	}
}

func countBodies(t *testing.T, dir string) int {
	t.Helper()
	return len(bodyPaths(t, dir))
}

func fmtInt(n int) string { return fmt.Sprintf("%d", n) }

/* ---------------------------------------------------------------- *
 * backup
 * ---------------------------------------------------------------- */

// The promise the whole design rests on: a backup is a data directory, so
// restoring is copying it back. Nothing had ever copied one back.
func TestABackupIsADataDirectoryYouCanRestoreByCopying(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	out := mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", dest)
	if !strings.Contains(out, "backed up to") {
		t.Fatalf("backup said:\n%s", out)
	}

	// Restoring, in full: a copy of the directory, opened as itself.
	restored := filepath.Join(t.TempDir(), "restored")
	copyTree(t, dest, restored)

	before := readEverything(t, source)
	after := readEverything(t, restored)
	if len(before) == 0 {
		t.Fatal("the source had nothing in it, so this proves nothing")
	}
	if len(before) != len(after) {
		t.Fatalf("source holds %d versions, the restored copy holds %d", len(before), len(after))
	}
	for path, content := range before {
		if after[path] != content {
			t.Fatalf("%s reads as %q in the restored copy and %q in the source", path, after[path], content)
		}
	}

	// And it stands up to the tool whose job is saying so.
	if v := mustRun(t, "verify", "-data", restored, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the restored copy does not verify:\n%s", v)
	}
}

// Incremental, because chunk names are content hashes. A second backup into the
// same directory should copy nothing.
func TestASecondBackupCopiesNothingNew(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")

	first := mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", dest)
	if strings.Contains(first, "0 bodies copied") {
		t.Fatalf("the first backup copied nothing:\n%s", first)
	}
	second := mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", dest)
	if !strings.Contains(second, "0 bodies copied") {
		t.Fatalf("a repeat backup copied bodies it already had:\n%s", second)
	}
	if v := mustRun(t, "verify", "-data", dest, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the backup does not verify after a second run:\n%s", v)
	}
}

// A backup taken from a damaged source must not report success. It is the one
// moment somebody is relying on the answer.
func TestBackupRefusesWhenTheSourceIsMissingABody(t *testing.T) {
	source := seeded(t)
	removeOneBody(t, source)
	dest := filepath.Join(t.TempDir(), "backup")

	out, err := trew(t, "backup", "-plaintext-ok", "-data", source, "-to", dest)
	if err == nil {
		t.Fatalf("backup reported success from a source with a body missing:\n%s", out)
	}
}

func TestBackupNeedsSomewhereToPutIt(t *testing.T) {
	source := seeded(t)
	if _, err := trew(t, "backup", "-plaintext-ok", "-data", source); err == nil {
		t.Fatal("backup with no -to should refuse")
	}
}

// A backup captures history, so it is the thing that survives a purge.
func TestABackupTakenBeforeAPurgeStillHasTheHistory(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", dest)

	beforeVersions := len(readEverything(t, dest))
	mustRun(t, "purge", "-data", source, "-confirm", "default", "-no-backup-check")
	afterVersions := len(readEverything(t, source))

	if afterVersions >= beforeVersions {
		t.Fatalf("purge removed nothing: %d versions before, %d after", beforeVersions, afterVersions)
	}
	// The backup is untouched, which is the whole reason to take one.
	if len(readEverything(t, dest)) != beforeVersions {
		t.Fatal("purging the source changed the backup")
	}
	if v := mustRun(t, "verify", "-data", dest, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the backup stopped verifying when the source was purged:\n%s", v)
	}
}

/* ---------------------------------------------------------------- *
 * reading a data directory back, without going through a server
 * ---------------------------------------------------------------- */

// readEverything returns every version in a directory, keyed by uid and path,
// with its reassembled ciphertext. It is deliberately not "the newest version
// of each path": a backup that kept only the newest would pass a check that
// asked only about the newest.
func readEverything(t *testing.T, dir string) map[string]string {
	t.Helper()
	st, err := store.Open(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open %s: %v", dir, err)
	}
	defer st.Close()

	vaults, err := st.Vaults()
	if err != nil {
		t.Fatalf("vaults: %v", err)
	}
	out := map[string]string{}
	for _, v := range vaults {
		cursor := int64(0)
		for {
			batch, ok, err := st.NextBatch(v, cursor, 500)
			if err != nil {
				t.Fatalf("batch: %v", err)
			}
			if !ok {
				break
			}
			for _, e := range batch.Entries {
				var body strings.Builder
				for _, name := range e.Chunks {
					b, err := st.Chunks().Get(v, name)
					if err != nil {
						t.Fatalf("get %s for %s: %v", name, e.Path, err)
					}
					body.Write(b)
				}
				out[v+"/"+fmtInt(int(e.UID))+"/"+e.Path] = body.String()
			}
			cursor = batch.To
		}
	}
	return out
}

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	err := filepath.Walk(from, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, p)
		if err != nil {
			return err
		}
		target := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, body, 0o600)
	})
	if err != nil {
		t.Fatalf("copy %s to %s: %v", from, to, err)
	}
}

/* ---------------------------------------------------------------- *
 * purge
 * ---------------------------------------------------------------- */

// Purge is the only thing here that destroys data on purpose, so what survives
// matters more than what goes.
func TestPurgeKeepsTheNewestOfEachPathAndNothingElse(t *testing.T) {
	dir := seeded(t)
	before := newestByPath(t, dir)
	if len(before) == 0 {
		t.Fatal("nothing to purge")
	}

	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	if !strings.Contains(out, "versions") || !strings.Contains(out, "removed") {
		t.Fatalf("purge did not print its arithmetic:\n%s", out)
	}

	after := newestByPath(t, dir)
	if len(after) != len(before) {
		t.Fatalf("purge left %d paths, want %d", len(after), len(before))
	}
	for path, content := range before {
		if after[path] != content {
			t.Fatalf("the newest %s reads as %q after the purge and %q before", path, after[path], content)
		}
	}
	// And the bodies the survivors need are still there.
	if v := mustRun(t, "verify", "-data", dir, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the vault does not verify after a purge:\n%s", v)
	}
}

// Rule 5: an operation that makes a list smaller reports its arithmetic, so an
// implausible figure is visible rather than inferred from a success message.
func TestPurgeArithmeticAddsUp(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")

	var before, after, removed int
	if _, err := fmt.Sscanf(out, "versions %d -> %d (removed %d)", &before, &after, &removed); err != nil {
		t.Fatalf("could not read the arithmetic from:\n%s", out)
	}
	if before-removed != after {
		t.Fatalf("%d - %d != %d", before, removed, after)
	}
	if removed == 0 {
		t.Fatalf("a vault with three versions of one note purged nothing:\n%s", out)
	}
}

// Twice in a row is a no-op, which is what "keeps only the newest" means.
func TestPurgingTwiceRemovesNothingTheSecondTime(t *testing.T) {
	dir := seeded(t)
	mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	if !strings.Contains(out, "(removed 0)") {
		t.Fatalf("a second purge removed something:\n%s", out)
	}
}

// Bodies no entry references any more are the space a purge is for.
func TestPurgeCollectsBodiesNothingReferences(t *testing.T) {
	dir := seeded(t)
	before := countBodies(t, dir)
	// Grace spares anything recent, and everything here was just written, so a
	// purge with the default window collects nothing. That is correct, and it
	// is also why this passes zero.
	out := mustRun(t, "purge", "-data", dir, "-grace", "0", "-confirm", "default", "-no-backup-check")
	after := countBodies(t, dir)
	if after >= before {
		t.Fatalf("purge collected nothing: %d bodies before, %d after\n%s", before, after, out)
	}
	if v := mustRun(t, "verify", "-data", dir, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("purge collected a body something still needed:\n%s", v)
	}
}

// The grace window exists because a body can be uploaded moments before the
// entry that references it is committed. Collecting it in between starves the
// push, which is a livelock this project has already had once.
func TestPurgeSparesBodiesTooRecentToCollect(t *testing.T) {
	dir := seeded(t)
	before := countBodies(t, dir)
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	if countBodies(t, dir) != before {
		t.Fatalf("purge collected a body written moments ago:\n%s", out)
	}
	if !strings.Contains(out, "spared") {
		t.Fatalf("purge did not say what it spared:\n%s", out)
	}
}

func newestByPath(t *testing.T, dir string) map[string]string {
	t.Helper()
	everything := readEverything(t, dir)
	newest := map[string]int{}
	out := map[string]string{}
	for key, content := range everything {
		parts := strings.SplitN(key, "/", 3)
		uid := 0
		fmt.Sscanf(parts[1], "%d", &uid)
		path := parts[0] + "/" + parts[2]
		if uid >= newest[path] {
			newest[path] = uid
			out[path] = content
		}
	}
	return out
}

/* ---------------------------------------------------------------- *
 * serve, and the locks that keep maintenance off a running server
 * ---------------------------------------------------------------- */

// A server holds the data directory, and purge deletes chunk bodies. The two
// together would let a sweep delete a body a live push had just written, which
// is what the lock is for.
func TestPurgeRefusesWhileAServerIsRunning(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	out, err := trew(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	if err == nil {
		t.Fatalf("purge ran against a live server:\n%s", out)
	}
	// And says what to do about it, rather than only that it failed.
	if !strings.Contains(err.Error(), "purge") && !strings.Contains(err.Error(), "running") {
		t.Fatalf("the refusal does not explain itself: %v", err)
	}
}

// Backup only reads, so it is allowed alongside a server. Refusing would mean
// the only safe time to back up is while sync is off.
func TestBackupRunsWhileAServerIsRunning(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	dest := filepath.Join(t.TempDir(), "backup")
	out := mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)
	if !strings.Contains(out, "backed up to") {
		t.Fatalf("backup said:\n%s", out)
	}
}

// Verify only reads too.
func TestVerifyRunsWhileAServerIsRunning(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()
	if out := mustRun(t, "verify", "-data", dir); !strings.Contains(out, "0 faults") {
		t.Fatalf("verify said:\n%s", out)
	}
}

// Stats only reads, but a purge is deleting the bodies it counts. It takes the
// shared lock like verify and backup, and used to take none.
func TestStatsRefusesWhileAPurgeHoldsTheDirectory(t *testing.T) {
	dir := seeded(t)
	lock, err := dirlock.Exclusive(dir, dirlock.Data, "purge")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()

	out, err := trew(t, "stats", "-data", dir)
	if err == nil {
		t.Fatalf("stats ran while a purge held the data directory:\n%s", out)
	}
	if !strings.Contains(err.Error(), "purge") {
		t.Fatalf("the refusal does not say a purge is the reason: %v", err)
	}
}

// Two servers on one directory would each believe they were the only writer.
func TestASecondServerRefusesTheSameDirectory(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	_, err := trew(t, "serve", "-data", dir, "-addr", "127.0.0.1:0")
	if err == nil {
		t.Fatal("a second server took a directory that was already served")
	}
}

// main_test.go:671, the half that stays. A first run on an empty store writes
// the first device's invite, and a restart inside its hour leaves it as it
// was: replacing it would invalidate an invite somebody had already copied,
// and the failure would look like a typo.
func TestARestartKeepsTheFirstInviteItWrote(t *testing.T) {
	dir := t.TempDir()

	first, stop := serveCapturing(t, dir)
	stop()
	path := filepath.Join(dir, firstInviteFile)
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the first run wrote no invite: %v\n%s", err, first)
	}
	if !strings.Contains(first, path) {
		t.Fatalf("the first run did not say where the invite is:\n%s", first)
	}
	// The invite itself is never printed: stdout is a log under systemd.
	if strings.Contains(first, strings.TrimSpace(string(written))) {
		t.Fatalf("serve printed the invite it wrote:\n%s", first)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the invite file is %v (%v), want mode 600", info.Mode(), err)
	}

	second, stop2 := serveCapturing(t, dir)
	stop2()
	again, err := os.ReadFile(path)
	if err != nil || string(again) != string(written) {
		t.Fatalf("a restart replaced the first device's invite:\n%s\n%s", written, again)
	}
	if !strings.Contains(second, "still outstanding") {
		t.Fatalf("the restart did not say an invite is outstanding:\n%s", second)
	}
}

/* helpers for running a server inside a test */

// safeBuffer is written by the serving goroutine and read by the test.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// serveInBackground starts a server and returns a function that stops it.
//
// It waits for the server lock to be taken rather than for a port to answer,
// because the lock is what the tests around it are about and because the port
// is chosen by the operating system and never printed.
func serveInBackground(t *testing.T, dir string) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", "127.0.0.1:0"}, out)
	}()

	// Waited for by the line it prints once it is serving, not by its lock.
	//
	// The lock this used to watch is the *server* lock, and serve takes that
	// one first and the shared *data* lock second. Purge is held off by the
	// data lock, so watching the server lock released the test into the window
	// between the two: purge took the data lock exclusively, ran, and the
	// server then failed to start behind it. That is a sound refusal from a
	// sound lock, reported as this test failing, and it took a machine busy
	// with a benchmark to widen the window enough to see once.
	//
	// "listening on" is printed after both locks and after the store opens, so
	// a server that has said it is serving is holding everything this helper's
	// callers assume it holds.
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(out.String(), "listening on") {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the server never started serving:\n%s", out.String())
		}
		select {
		case err := <-done:
			cancel()
			t.Fatalf("the server stopped before it started: %v\n%s", err, out.String())
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}

	stopped := false
	return func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("the server ended with: %v", err)
			}
		case <-time.After(15 * time.Second):
			t.Error("the server did not stop when it was told to")
		}
	}
}

// serveCapturing starts a server, waits for it, and hands back what it printed.
func serveCapturing(t *testing.T, dir string) (string, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", "127.0.0.1:0"}, out)
	}()

	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(out.String(), "listening on") {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the server never said it was listening:\n%s", out.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	text := out.String()
	stopped := false
	return text, func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		<-done
	}
}

/* ---------------------------------------------------------------- *
 * a mistyped -data
 * ---------------------------------------------------------------- */

// Only `serve` has any business creating a data directory. For the others a
// path that is not there means somebody mistyped it, and creating an empty one
// turns the typo into a success message.
//
// Backup is the dangerous one. A person who rotates their backups on the
// strength of "backed up to ..." has now thrown away the copy that had their
// notes in it.
func TestCommandsRefuseADataDirectoryThatIsNotThere(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "typo")

	for _, args := range [][]string{
		{"backup", "-plaintext-ok", "-data", missing, "-to", filepath.Join(t.TempDir(), "backup")},
		{"verify", "-data", missing},
		{"verify", "-data", missing, "-deep"},
		{"purge", "-data", missing, "-confirm", "default", "-no-backup-check"},
	} {
		out, err := trew(t, args...)
		if err == nil {
			t.Fatalf("trewd %s succeeded against a directory that does not exist:\n%s",
				strings.Join(args, " "), out)
		}
		if !strings.Contains(err.Error(), "no trewd data directory") {
			t.Fatalf("trewd %s refused unhelpfully: %v", strings.Join(args, " "), err)
		}
	}

	// And nothing was created by asking.
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("a refused command created %s anyway", missing)
	}
}

// Serve does create one, because on a first run there is nothing there yet and
// that is the whole point.
func TestServeCreatesADataDirectoryOnItsFirstRun(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	out, stop := serveCapturing(t, dir)
	stop()
	if !strings.Contains(out, "No device is paired with this vault yet") {
		t.Fatalf("a first run should have said how to pair its first device:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(dir, firstInviteFile)); err != nil {
		t.Fatalf("a first run wrote no invite for its first device: %v", err)
	}
	// Started without -url, the invite's addresses are guesses no device behind
	// a proxy can use, and the message says so instead of telling a newcomer to
	// paste one (found by the newcomer walkthrough of 2026-10-08).
	if !strings.Contains(out, "started without -url") || !strings.Contains(out, "trewd invite -url wss://NAME") ||
		strings.Contains(out, "use the one the device can reach") {
		t.Fatalf("a first run without -url presented its guessed addresses as the ones to paste:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(dir, "trew.db")); err != nil {
		t.Fatalf("serve did not create the database: %v", err)
	}
}

// With -url the server knows the name devices reach, so the message points at
// the invite it wrote as the one to paste.
func TestAFirstInviteWithAKnownAddressIsTheOneToPaste(t *testing.T) {
	var out strings.Builder
	printPairing(&out, "127.0.0.1:3003", "default", firstInvite{Written: true, Path: "/data/first-invite", ExpiresAt: time.Now()})
	if !strings.Contains(out.String(), "use the one the device can reach") || strings.Contains(out.String(), "started without -url") {
		t.Fatalf("an invite made with -url was not offered as the one to paste:\n%s", out.String())
	}
}

/* ---------------------------------------------------------------- *
 * service
 * ---------------------------------------------------------------- */

// The unit is printed rather than installed. Writing into /etc needs root, and
// a program that asks for root to do something you could read first is one that
// gets run as root for the rest of its life.
func TestServicePrintsAUnitWithRealPathsInIt(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "service", "-data", dir, "-addr", "127.0.0.1:3010", "-vault", "notes", "-user", "trew")

	for _, want := range []string{
		"[Unit]",
		"[Service]",
		"[Install]",
		"User=trew",
		"-addr 127.0.0.1:3010",
		"-vault notes",
		"ReadWritePaths=" + dir,
		"WantedBy=multi-user.target",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("the unit has no %q in it:\n%s", want, out)
		}
	}
	// No placeholders. A unit with one in it fails on first start with a
	// message about a path nobody typed.
	for _, bad := range []string{"<", "PATH_TO", "CHANGEME", "%%"} {
		if strings.Contains(out, bad) {
			t.Fatalf("the unit still has %q in it:\n%s", bad, out)
		}
	}
	if !strings.Contains(out, "-data "+dir) {
		t.Fatalf("ExecStart does not name the data directory:\n%s", out)
	}
}

// This process holds every note somebody has and needs one directory and one
// socket. The unit says so to the kernel, so a defect in it has somewhere it
// cannot reach.
func TestTheUnitIsHardened(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "service", "-data", dir)

	for _, want := range []string{
		"NoNewPrivileges=true",
		"ProtectSystem=strict",
		"PrivateTmp=true",
		"CapabilityBoundingSet=",
		"RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
		"SystemCallFilter=@system-service",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("the unit is missing %q:\n%s", want, out)
		}
	}
}

/**
 * The hardening line that looks most obviously right is the one that would stop
 * the server starting. The default data directory is inside a home directory,
 * and ProtectHome=true makes that unreadable to the unit.
 */
func TestProtectHomeIsOnlySetWhenItWouldNotBreakTheService(t *testing.T) {
	inHome := mustRun(t, "service", "-data", "/home/somebody/.trew")
	if strings.Contains(inHome, "\nProtectHome=true") {
		t.Fatalf("ProtectHome was set on a data directory inside a home:\n%s", inHome)
	}
	if !strings.Contains(inHome, "ProtectHome is left off") {
		t.Fatalf("nothing said why ProtectHome was missing:\n%s", inHome)
	}

	elsewhere := mustRun(t, "service", "-data", "/var/lib/trew")
	if !strings.Contains(elsewhere, "\nProtectHome=true") {
		t.Fatalf("ProtectHome was left off where it would have been safe:\n%s", elsewhere)
	}
}

// The prefixes are a guess. The run-as user's real home is the answer, and a
// home somewhere unusual used to get ProtectHome=true and a unit that could
// not read its own data directory.
func TestProtectHomeKnowsWhereTheUsersHomeActuallyIs(t *testing.T) {
	if !underHome("/srv/people/wayne/.trew", "/srv/people/wayne") {
		t.Fatal("a data directory inside an unusual home was not recognised as such")
	}
	if !underHome("/srv/people/wayne", "/srv/people/wayne/") {
		t.Fatal("the home directory itself, with a trailing slash on the home, was not recognised")
	}
	if underHome("/srv/people/wayne-data", "/srv/people/wayne") {
		t.Fatal("a sibling that merely shares a prefix was taken for the home")
	}
	if !underHome("/home/somebody/.trew", "") {
		t.Fatal("the well-known prefixes stopped working when the home is unknown")
	}
	if underHome("/var/lib/trew", "/") {
		t.Fatal("a home of / would mark every path as inside it")
	}
}

// Restarting must not be something a person has to notice. A sync server that
// stays down after one bad night is one you find out about from a device that
// has been quietly not syncing.
func TestTheUnitComesBackByItself(t *testing.T) {
	out := mustRun(t, "service", "-data", "/var/lib/trew")
	if !strings.Contains(out, "Restart=always") {
		t.Fatalf("the unit does not restart:\n%s", out)
	}
	// And stops the way serve is written to be stopped, which is what makes an
	// ack mean stored across a restart.
	if !strings.Contains(out, "KillSignal=SIGTERM") {
		t.Fatalf("the unit does not stop with SIGTERM:\n%s", out)
	}
}

func TestServiceTellsYouHowToInstallIt(t *testing.T) {
	out := mustRun(t, "service", "-data", "/var/lib/trew")
	for _, want := range []string{"systemctl daemon-reload", "systemctl enable --now trew", "journalctl"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the notes do not mention %q:\n%s", want, out)
		}
	}
	// Purge needs the server stopped and backup does not. Getting that wrong is
	// a purge that refuses, or worse, a habit of stopping sync to back up.
	if !strings.Contains(out, "systemctl stop trew && ") {
		t.Fatalf("the notes do not say purge needs the server stopped:\n%s", out)
	}
	if strings.Contains(out, "systemctl stop trew && ") && !strings.Contains(out, "Backups do not need the server stopped") {
		t.Fatalf("the notes do not say backup does not:\n%s", out)
	}
	// And what they say to run works as printed. A backup has to say which
	// kind it is, and the notes' named neither; an invite with no -url names
	// this machine's own addresses as wss://, where nothing speaks TLS; and
	// both run as the service user, so nothing in the data directory ends up
	// owned by root.
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.Contains(line, " backup -data "):
			if !strings.Contains(line, " -recipients-file ") && !strings.Contains(line, " -plaintext-ok") {
				t.Errorf("the notes' backup would be refused: %s", line)
			}
		case strings.Contains(line, " invite -data "):
			if !strings.Contains(line, " -url ") {
				t.Errorf("the notes' invite names no address a device behind a proxy can reach: %s", line)
			}
		}
		if (strings.Contains(line, " backup -data ") || strings.Contains(line, " purge -data ")) &&
			!strings.Contains(line, "sudo -u ") {
			t.Errorf("the notes run this as root, in the service's data directory: %s", line)
		}
	}
}

/* ---------------------------------------------------------------- *
 * stats and health
 * ---------------------------------------------------------------- */

// The numbers are separate rather than summed. "1.2 GB" says nothing about
// whether a purge would help; versions against files says exactly that.
//
// The seeded vault's deletion has no earlier version with content, so it is
// deleted and not recoverable, and stats has to say both. It said "1 deleted
// and still recoverable" for as long as this test existed, and this test
// asserted that string.
func TestStatsSaysWhatIsThereAndWhatAPurgeWouldDrop(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "stats", "-data", dir)

	for _, want := range []string{"files", "versions in all", "history",
		"1 deleted: 0 still recoverable, 1 purged and gone for good"} {
		if !strings.Contains(out, want) {
			t.Fatalf("stats does not mention %q:\n%s", want, out)
		}
	}

	// After a purge there is no history left, and it stops saying there is.
	mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	after := mustRun(t, "stats", "-data", dir)
	if strings.Contains(after, "would drop") {
		t.Fatalf("stats still offers a purge with nothing left to drop:\n%s", after)
	}
}

// The other half: a deletion that can be restored from says so, and in the
// short form, because that is the ordinary case and it should stay one number.
func TestStatsKeepsTheShortLineWhenEveryDeletionIsRecoverable(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}
	body := "something worth getting back"
	name := chunks.Name([]byte(body))
	if err := st.Chunks().Put("default", name, []byte(body)); err != nil {
		t.Fatalf("put chunk: %v", err)
	}
	if _, err := st.AppendEntry("default", store.Entry{
		Path: "gone.md", Size: int64(len(body)), MTime: 10, Chunks: []string{name},
	}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := st.AppendEntry("default", store.Entry{
		Path: "gone.md", Deleted: true, MTime: 20,
	}); err != nil {
		t.Fatalf("append deletion: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	out := mustRun(t, "stats", "-data", dir)
	if !strings.Contains(out, "1 deleted and still recoverable") {
		t.Fatalf("a recoverable deletion did not read as one:\n%s", out)
	}
	if strings.Contains(out, "gone for good") {
		t.Fatalf("a recoverable deletion was called gone:\n%s", out)
	}
}

func TestStatsRunsAgainstALiveServer(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()
	if out := mustRun(t, "stats", "-data", dir); !strings.Contains(out, "vault") {
		t.Fatalf("stats said:\n%s", out)
	}
}

func TestStatsRefusesADirectoryThatIsNotThere(t *testing.T) {
	if _, err := trew(t, "stats", "-data", filepath.Join(t.TempDir(), "typo")); err == nil {
		t.Fatal("stats reported on a directory that does not exist")
	}
}

// The container image is a single static binary on an empty filesystem, so
// there is no curl in there to write a HEALTHCHECK with, and adding a shell to
// get one would undo the reason for the image being empty.
func TestHealthAsksARunningServer(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	// The port is chosen by the operating system and never printed, so this
	// checks the shape of the answer rather than a live one: a server that is
	// not there must fail rather than pass.
	if _, err := trew(t, "health", "-addr", "127.0.0.1:1", "-timeout", "2s"); err == nil {
		t.Fatal("health passed against a port with nothing on it")
	}
}

func TestHealthAgainstAServerOnAKnownPort(t *testing.T) {
	dir := seeded(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	port := freeTestPort(t)
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", fmt.Sprintf("127.0.0.1:%d", port)}, out)
	}()
	defer func() { cancel(); <-done }()

	deadline := time.Now().Add(15 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		if _, err := trew(t, "health", "-addr", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			return
		} else {
			lastErr = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("health never passed against a running server: %v\n%s", lastErr, out.String())
}

// A bare port is what a bind address looks like, and asking about ":3003" must
// mean this machine rather than being a parse error inside a container.
func TestHealthUnderstandsABareBindAddress(t *testing.T) {
	_, err := trew(t, "health", "-addr", ":1", "-timeout", "2s")
	if err == nil {
		t.Fatal("health passed against a port with nothing on it")
	}
	if strings.Contains(err.Error(), "not a host and port") {
		t.Fatalf("a bare bind address was not understood: %v", err)
	}
}

func freeTestPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// The builder image has to be new enough for the module.
//
// A mismatch is a build that fails only once somebody tries to make an image,
// which is later than it should be found, and the two versions live in
// different files with nothing tying them together. This is the tie.
func TestTheDockerfileBuildsWithAGoNewEnoughForTheModule(t *testing.T) {
	// Tests run in the package directory, and the module root is the
	// repository root, two up, where the Dockerfile lives too.
	root := filepath.Join("..", "..")
	dockerfile, err := os.ReadFile(filepath.Join(root, "Dockerfile"))
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	gomod, err := os.ReadFile(filepath.Join("..", "..", "go.mod"))
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}

	wanted := majorMinor(findAfter(t, string(gomod), "go "))
	builder := majorMinor(findAfter(t, string(dockerfile), "ARG GO_VERSION="))
	if builder != wanted {
		t.Fatalf("go.mod needs Go %s and the Dockerfile builds with %s", wanted, builder)
	}
}

func findAfter(t *testing.T, text, prefix string) string {
	t.Helper()
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	t.Fatalf("no line starting %q", prefix)
	return ""
}

func majorMinor(v string) string {
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return v
	}
	return parts[0] + "." + parts[1]
}

// main_test.go:1189. A bind address is not an address. Binding to every
// interface is the normal way to run this, because a phone cannot reach a
// server on loopback, but an invite naming "0.0.0.0:3003" asks a device to
// connect to nothing at all, and the failure looks like a server that is down.
// Whatever addresses the first invite carries, none is a wildcard, and each is
// one the codec takes.
func TestTheFirstInviteNamesSomethingADeviceCanDial(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:3003", ":3003", "[::]:3003"} {
		urls, err := inviteURLs("", addr, false)
		if err != nil {
			t.Fatalf("%s: %v", addr, err)
		}
		for _, u := range urls {
			for _, wildcard := range []string{"0.0.0.0", "[::]", "://:", placeholderHost} {
				if strings.Contains(u, wildcard) {
					t.Errorf("listening on %s put %q in an invite", addr, u)
				}
			}
			if err := checkInviteURL(u); err != nil {
				t.Errorf("listening on %s gave %q, which no invite can carry: %v", addr, u, err)
			}
		}
	}
}

// main_test.go:1207. An explicit address goes into the invite unchanged, and
// -url overrides whatever the bind would have said: it is already the answer.
func TestAnExplicitAddressIsWrittenAsGiven(t *testing.T) {
	urls, err := inviteURLs("", "vault.example.ts.net:3003", false)
	if err != nil || len(urls) != 1 || urls[0] != "wss://vault.example.ts.net:3003" {
		t.Fatalf("an explicit bind became %v, %v", urls, err)
	}
	urls, err = inviteURLs("wss://notes.example.com", "0.0.0.0:3003", false)
	if err != nil || len(urls) != 1 || urls[0] != "wss://notes.example.com" {
		t.Fatalf("-url became %v, %v", urls, err)
	}
	for _, bad := range []string{"notes.example.com", "https://notes.example.com", "wss://notes.example.com/"} {
		if _, err := inviteURLs(bad, "0.0.0.0:3003", false); err == nil {
			t.Errorf("-url %q was accepted, and no invite can carry it", bad)
		}
	}
}

// main_test.go:1218. A store with devices mints no first invite and prints
// none, and says how a device is added instead.
func TestAPairedVaultWritesNoFirstInvite(t *testing.T) {
	dir := seeded(t)
	registryOn(t, dir)
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	path := filepath.Join(t.TempDir(), firstInviteFile)
	first, err := mintFirstInvite(st, "default", []string{"wss://vault.example.ts.net"}, path, time.Now())
	if err != nil || !first.Paired || first.Written {
		t.Fatalf("a paired vault's first invite: %+v %v", first, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a paired vault wrote an invite file: %v", err)
	}
	var out bytes.Buffer
	printPairing(&out, "vault.example.ts.net:3003", "default", first)
	if !strings.Contains(out.String(), "trewd invite") {
		t.Errorf("a paired vault did not say how to add a device:\n%s", out.String())
	}
	if strings.Contains(out.String(), invite.Prefix) {
		t.Errorf("a paired vault printed an invite:\n%s", out.String())
	}
}

// main_test.go:1252. Through the shipped binary: the first-run invite redeems
// once, a second use is refused as `auth`, not retryable, and the device that
// used it still connects.
func TestTheFirstInviteWorksOnce(t *testing.T) {
	dir := t.TempDir()
	addr := fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := &safeBuffer{}
	done := make(chan struct{})
	go func() { defer close(done); _ = run(ctx, []string{"serve", "-data", dir, "-addr", addr}, out) }()
	// Stopped and waited for before the directory is removed: a server
	// still closing writes into it.
	defer func() { cancel(); <-done }()
	waitForServer(t, addr, out)

	inv := readFirstInvite(t, dir)
	dialFirstDevice(t, "ws://"+addr, inv)

	// The same invite, a device of its own, and nothing else different.
	stranger := dialWS(t, "ws://"+addr)
	strangerRaw := sha256.Sum256([]byte("a stranger's token"))
	stranger.write(wire.In{
		Op: "hello", ID: 1, Proto: wire.Proto, Vault: inv.Vault, Device: "stranger",
		Invite: store.EncodeToken(inv.Token), DeviceID: "stranger", Token: store.EncodeToken(strangerRaw[:]),
	})
	res := stranger.readJSON()
	if res["res"] != "err" || res["code"] != wire.CodeAuth {
		t.Fatalf("a spent first invite answered a second redemption with %v", res)
	}
	if retryable, _ := res["retryable"].(bool); retryable {
		t.Errorf("a refused redemption was marked retryable, so a stranger is invited to keep trying: %v", res)
	}

	// And the vault is still the first device's.
	back := dialWS(t, "ws://"+addr)
	back.write(wire.In{
		Op: "hello", ID: 1, Proto: wire.Proto, Vault: inv.Vault,
		Token: firstDevKey, DeviceID: firstDevID, Device: "test-device",
	})
	if res := back.readJSON(); res["res"] != "ready" {
		t.Fatalf("the first device was locked out by the redemption that failed: %v", res)
	}
}

// main_test.go:1294. -localhost exists so that trying this out on one machine
// needs no thought about schemes: under it the first invite carries a ws://
// loopback address, and that address, dialled as it stands, pairs a device.
func TestLocalhostWritesAnInviteThatWorksAsIs(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := &safeBuffer{}
	go func() {
		_ = run(ctx, []string{"serve", "-data", dir, "-addr", fmt.Sprintf(":%d", freeTestPort(t)), "-localhost"}, out)
	}()
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(out.String(), "listening on") {
		if time.Now().After(deadline) {
			t.Fatalf("the server never started:\n%s", out.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	inv := readFirstInvite(t, dir)
	if !strings.HasPrefix(inv.URL, "ws://127.0.0.1:") {
		t.Fatalf("-localhost wrote an invite for %q", inv.URL)
	}
	dialFirstDevice(t, inv.URL, inv)
}

/* ---------------------------------------------------------------- *
 * I25: the caps are flags, and what the flag says is what ready says
 * ---------------------------------------------------------------- */

// -max-batch-bytes and -max-fetch-bytes reach ready, so a client test can lower
// the caps against the real binary. Out-of-range values are clamped and the
// clamped value is what is advertised, because advertised must equal enforced.
func TestI25TheCapFlagsReachReady(t *testing.T) {
	readyWith := func(t *testing.T, flags ...string) map[string]any {
		t.Helper()
		dir := t.TempDir()
		port := freeTestPort(t)
		addr := fmt.Sprintf("127.0.0.1:%d", port)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		out := &safeBuffer{}
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = run(ctx, append([]string{"serve", "-data", dir, "-addr", addr}, flags...), out)
		}()
		// Stopped and waited for before the directory is removed: a server
		// still closing writes into it.
		defer func() { cancel(); <-done }()
		waitForServer(t, addr, out)

		// The ceilings are in `ready`, which only a registered device is
		// given, so the probe has to be one: redeem the first invite, then
		// connect.
		return dialFirstDevice(t, "ws://"+addr, readFirstInvite(t, dir)).ready
	}

	lowered := readyWith(t, "-max-batch-bytes", "2097152", "-max-fetch-bytes", "3145728")
	if lowered["maxBatchBytes"] != float64(2<<20) || lowered["maxFetchBytes"] != float64(3<<20) {
		t.Fatalf("lowered caps did not reach ready: batch %v fetch %v", lowered["maxBatchBytes"], lowered["maxFetchBytes"])
	}

	// Out of range both ways: clamped, and the clamp is what is advertised.
	clamped := readyWith(t, "-max-batch-bytes", "1", "-max-fetch-bytes", "999999999999")
	if clamped["maxBatchBytes"] != float64(store.ChunkMax) {
		t.Fatalf("a batch cap below one chunk was advertised as %v", clamped["maxBatchBytes"])
	}
	if clamped["maxFetchBytes"] != float64(store.PerFileMax) {
		t.Fatalf("a fetch cap above the file ceiling was advertised as %v", clamped["maxFetchBytes"])
	}
	raised := readyWith(t, "-max-batch-bytes", fmt.Sprint(server.ReadLimit))
	if raised["maxBatchBytes"] != float64(server.ReadLimit/2) {
		t.Fatalf("a batch cap at the read limit was advertised as %v, want half the read limit", raised["maxBatchBytes"])
	}
}

// A backup that has kept history the source purged holds more bodies than the
// source does, and the line about the difference has to survive that.
//
// It used to print source minus destination with the words "were not copied",
// which is a negative number of bodies as soon as retention is doing its job.
// The backup's numbers are the only evidence anyone has that a backup is
// sound, so one of them reading as nonsense costs more than the line is worth.
func TestBackupNeverPrintsANegativeBodyCount(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", dest)

	// The source drops its history and the bodies only the old versions
	// referenced; the backup keeps them.
	mustRun(t, "purge", "-data", source, "-grace", "0", "-confirm", "default", "-no-backup-check")

	out := mustRun(t, "backup", "-plaintext-ok", "-data", source, "-to", dest)
	if countBodies(t, dest) <= countBodies(t, source) {
		t.Fatalf("the backup does not hold more bodies than the purged source, so this proves nothing:\n%s", out)
	}
	if strings.Contains(out, "(-") {
		t.Fatalf("backup printed a negative body count:\n%s", out)
	}
	// And says what they are: bodies of purged versions, which the snapshot
	// it just published no longer records. It used to call them "history it
	// kept", which they are not once the database beside them has moved on.
	if !strings.Contains(out, "left from versions a purge took") || !strings.Contains(out, "cannot give them back") ||
		strings.Contains(out, "history it kept") {
		t.Fatalf("backup does not say why it holds more bodies than the source, and what they are:\n%s", out)
	}
	if strings.Contains(out, "were not copied") {
		t.Fatalf("backup says bodies were not copied when it holds more than the source:\n%s", out)
	}
}

/* ---------------------------------------------------------------- *
 * the backup a purge is allowed to trust (F04)
 * ---------------------------------------------------------------- */

// Purge is the one command that destroys something no device holds a copy of,
// and -backup is what authorises it. The check used to compare two maximum
// uids, which is satisfied by the store itself, by an unrelated vault of the
// same name that counted higher, and by a database with none of its bodies.
// Each of those printed that the history it had just destroyed was safely
// held somewhere.

func TestPurgeRefusesItsOwnDirectoryAsABackup(t *testing.T) {
	dir := seeded(t)
	out, err := trew(t, "purge", "-data", dir, "-backup", dir, "-confirm", "default")
	if err == nil {
		t.Fatalf("purge accepted its own data directory as a backup:\n%s", out)
	}
	if !strings.Contains(err.Error(), "own data directory") {
		t.Fatalf("the refusal does not say what is wrong: %v", err)
	}
	// And nothing was destroyed on the way to refusing.
	if v := mustRun(t, "verify", "-data", dir); !strings.Contains(v, "0 faults") {
		t.Fatalf("the store was changed by a refused purge:\n%s", v)
	}
	if s := mustRun(t, "stats", "-data", dir); !strings.Contains(s, "6 versions") {
		t.Fatalf("versions went missing during a refused purge:\n%s", s)
	}
}

func TestPurgeRefusesABackupThatIsAnAliasOfTheSourceDirectory(t *testing.T) {
	dir := seeded(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(dir, alias); err != nil {
		t.Skipf("this filesystem will not make a symlink: %v", err)
	}
	out, err := trew(t, "purge", "-data", dir, "-backup", alias, "-confirm", "default")
	if err == nil {
		t.Fatalf("purge accepted a symlink to its own data directory:\n%s", out)
	}
	if !strings.Contains(err.Error(), "own data directory") {
		t.Fatalf("the refusal does not say what is wrong: %v", err)
	}
}

func TestPurgeRefusesAnUnrelatedVaultThatCountedHigher(t *testing.T) {
	dir := seeded(t)
	// A different vault that happens to share the name and to have counted
	// higher. Same name, more versions, none of them the same versions: this
	// is what a second server, or a data directory that was started again,
	// leaves behind, and its uids satisfy every comparison the old check made.
	other := t.TempDir()
	st, err := store.Open(filepath.Join(other, "trew.db"), filepath.Join(other, "chunks"))
	if err != nil {
		t.Fatalf("open other: %v", err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}
	for i := 0; i < 10; i++ {
		if _, err := st.AppendEntry("default", store.Entry{
			Path: "elsewhere.md", MTime: 30, Device: "other",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close other: %v", err)
	}

	out, err := trew(t, "purge", "-data", dir, "-backup", other, "-confirm", "default")
	if err == nil {
		t.Fatalf("purge accepted an unrelated vault as a backup:\n%s", out)
	}
	if !strings.Contains(err.Error(), "some other vault") {
		t.Fatalf("the refusal does not say what is wrong: %v", err)
	}
}

func TestPurgeRefusesABackupWithNoChunkBodies(t *testing.T) {
	dir := seeded(t)
	backup := t.TempDir()
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", backup)
	// The database, and none of the contents. This is what a copy that got
	// part way, or a retention policy that swept the bodies, leaves behind:
	// every version recorded and nothing to restore.
	if err := os.RemoveAll(filepath.Join(backup, "chunks")); err != nil {
		t.Fatalf("remove bodies: %v", err)
	}

	out, err := trew(t, "purge", "-data", dir, "-backup", backup, "-confirm", "default")
	if err == nil {
		t.Fatalf("purge accepted a backup holding no bodies:\n%s", out)
	}
	if !strings.Contains(err.Error(), "chunk storage is missing") {
		t.Fatalf("the refusal does not say what is wrong: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(backup, "chunks")); !os.IsNotExist(statErr) {
		t.Fatalf("checking the backup recreated its missing chunk directory: %v", statErr)
	}
}

func TestPurgeAcceptsARealBackup(t *testing.T) {
	dir := seeded(t)
	backup := t.TempDir()
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", backup)

	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-backup", backup)
	if !strings.Contains(out, "gone for good") {
		t.Fatalf("a purge against a real backup removed nothing:\n%s", out)
	}
	// And the backup still verifies with the history the source no longer has.
	if v := mustRun(t, "verify", "-data", backup); !strings.Contains(v, "0 faults") {
		t.Fatalf("the backup does not verify after the purge:\n%s", v)
	}
}

/* ---------------------------------------------------------------- *
 * the destination a backup is allowed to write (F06)
 * ---------------------------------------------------------------- */

// Only the source was locked, so a backup would replace the database of a
// directory something else was using as a live store: a server serving from
// it, a purge, or another backup. The destination now takes the same exclusive
// data lock those hold, so all three are refused by one primitive.

func TestBackupRefusesADestinationInUse(t *testing.T) {
	dir := seeded(t)
	dest := seeded(t) // a different store, with its own history

	// What a server serving from that directory holds.
	held, err := dirlock.Shared(dest, dirlock.Data)
	if err != nil {
		t.Fatalf("hold the destination: %v", err)
	}
	defer held.Release()

	out, err := trew(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)
	if err == nil {
		t.Fatalf("backup replaced a store that was in use:\n%s", out)
	}
	if !strings.Contains(err.Error(), "locked") {
		t.Fatalf("the refusal does not say the destination is busy: %v", err)
	}
	// And that store still has its own history, unreplaced.
	if s := mustRun(t, "stats", "-data", dest); !strings.Contains(s, "6 versions") {
		t.Fatalf("the destination was changed by a refused backup:\n%s", s)
	}
}

func TestBackupRefusesASecondBackupIntoTheSameDirectory(t *testing.T) {
	dir := seeded(t)
	dest := t.TempDir()
	// The lock a backup in progress holds.
	held, err := dirlock.Exclusive(dest, dirlock.Data, "backup")
	if err != nil {
		t.Fatalf("hold the destination: %v", err)
	}
	defer held.Release()

	out, err := trew(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)
	if err == nil {
		t.Fatalf("two backups wrote the same directory at once:\n%s", out)
	}
}

func TestBackupStillWorksWhenTheDestinationIsFree(t *testing.T) {
	dir := seeded(t)
	dest := t.TempDir()
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)
	// Twice, because the second run takes the lock the first one released and
	// sweeps the staging file the first one used.
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)
	if v := mustRun(t, "verify", "-data", dest); !strings.Contains(v, "0 faults") {
		t.Fatalf("the backup does not verify:\n%s", v)
	}
}

// The port is open before the startup summary runs (I10).
//
// The summary walks the served vault's chunk tree to say how much a purge would
// reclaim, which is 56 ms over ten thousand bodies and seconds over a few
// hundred thousand. All of it used to happen before the socket existed, so a
// device reconnecting during a restart got "connection refused" and reported
// the server as down, and the log said "starting" and then nothing for as long
// as the walk took. It is not a hang and it is indistinguishable from one.
//
// Asserted through a seam rather than by timing a large vault: what is wrong is
// an ordering, and an ordering is a fact rather than a measurement. A test that
// built a vault big enough for the delay to show would be slow, would still be
// a race, and would pass on a fast disk.
func TestThePortAnswersBeforeTheStartupSummaryRuns(t *testing.T) {
	dir := seeded(t)

	type answer struct {
		status int
		err    error
	}
	got := make(chan answer, 1)
	afterListening = func(addr string) {
		// Inside the window: Serve is running and logStartup has not been
		// called. If the listener were still inside ListenAndServe behind the
		// summary, there would be nothing here to connect to.
		res, err := http.Get("http://" + addr + "/health")
		if err != nil {
			got <- answer{err: err}
			return
		}
		defer func() { _ = res.Body.Close() }()
		got <- answer{status: res.StatusCode}
	}
	t.Cleanup(func() { afterListening = nil })

	stop := serveInBackground(t, dir)
	defer stop()

	select {
	case a := <-got:
		if a.err != nil {
			t.Fatalf("the port was not answering before the startup summary: %v", a.err)
		}
		if a.status != http.StatusOK {
			t.Fatalf("/health answered %d before the startup summary, wanted 200", a.status)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the server never reached the point where the port is open")
	}
}

// Every deadline that can kill this process outlasts its own shutdown (I17).
//
// A stop drains in two halves of shutdownTimeout each and then closes the
// store. Two managers impose their own deadline on top of that and neither
// knows the arithmetic: systemd's TimeoutStopSec, written by `trewd service`,
// and Docker's stop grace, which defaults to ten seconds if compose does not
// say otherwise. Ten seconds is exactly the two halves with nothing left for
// closing the store, so a busy shutdown under compose was killed partway
// through one.
//
// Nothing is lost when that happens: an unacked put is retried and the
// write-ahead log recovers. What is lost is the ability to tell a clean stop
// from a killed one, and a margin that is exactly zero is not a margin.
//
// Asserted rather than written down because the number lives in three files in
// two languages, and the one that is easiest to change is the one in Go.
func TestEveryStopDeadlineOutlastsTheShutdownBudget(t *testing.T) {
	// Both halves, plus room to close the store. The store close is not
	// budgeted anywhere, so this asks for at least as long again as one half,
	// which is the smallest honest way to say "and then some".
	budget := 2*shutdownTimeout + shutdownTimeout

	written := unit(unitArgs{
		Binary: "/usr/local/bin/trewd", Data: "/var/lib/trew", User: "trew",
		Addr: ":3003", Vault: "default",
	})
	var systemdStop time.Duration
	for _, line := range strings.Split(written, "\n") {
		if after, ok := strings.CutPrefix(strings.TrimSpace(line), "TimeoutStopSec="); ok {
			secs, err := strconv.Atoi(after)
			if err != nil {
				t.Fatalf("TimeoutStopSec is %q, which is not a number of seconds", after)
			}
			systemdStop = time.Duration(secs) * time.Second
		}
	}
	if systemdStop == 0 {
		t.Fatal("the systemd unit sets no TimeoutStopSec, so systemd's own default decides")
	}
	if systemdStop < budget {
		t.Errorf("TimeoutStopSec is %s and a stop can take %s", systemdStop, budget)
	}

	// And compose, which is the one with a default that used to be too short.
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	compose, err := os.ReadFile(filepath.Join(root, "compose.yaml"))
	if err != nil {
		t.Fatalf("reading compose.yaml: %v", err)
	}
	grace := ""
	for _, line := range strings.Split(string(compose), "\n") {
		if after, ok := strings.CutPrefix(strings.TrimSpace(line), "stop_grace_period:"); ok {
			grace = strings.TrimSpace(after)
		}
	}
	if grace == "" {
		t.Fatal("compose.yaml sets no stop_grace_period, so Docker's ten-second default decides, " +
			"which is both halves of a stop and nothing for closing the store")
	}
	d, err := time.ParseDuration(grace)
	if err != nil {
		t.Fatalf("stop_grace_period is %q, which is not a duration: %v", grace, err)
	}
	if d < budget {
		t.Errorf("stop_grace_period is %s and a stop can take %s", d, budget)
	}
}

// `trewd health` says which kind of unwell (I17).
//
// /health answers one word naming its case, and reporting only "503 Service
// Unavailable" would collapse "the disk is full" and "we are shutting down"
// into a sentence that says neither. That is rule 7 in the place an operator
// reads: this command is what the container healthcheck runs and what somebody
// types when a device says it cannot sync.
func TestHealthCommandSaysWhyNotJustThatItFailed(t *testing.T) {
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("disk-full\n"))
	}))
	defer hs.Close()

	var out bytes.Buffer
	err := cmdHealth([]string{"-addr", strings.TrimPrefix(hs.URL, "http://")}, &out)
	if err == nil {
		t.Fatal("a 503 was reported as healthy")
	}
	if !strings.Contains(err.Error(), "disk-full") {
		t.Errorf("the failure said %q, which does not say which kind of unwell", err)
	}
}

/*
 * What purge accepts as proof that history is safe (R04).
 *
 * Purge is the one command that destroys something no device holds, so the
 * backup it insists on has to be one that could actually give the history back.
 * It used to check that a row with the same uid existed and carried the same
 * MAC string, and that a file of the right name existed in the chunk tree.
 * Neither is the thing it was proof of: the MAC is the client's authenticator
 * over what the client signed and says nothing about the rest of the row this
 * database stores, and a file's name says nothing about its contents.
 */

// A backup whose body is the right size and the wrong bytes. This is a failing
// disk, and it is indistinguishable from a good backup until somebody restores
// it: the moment to find out is the moment before the only other copy is gone.
func TestPurgeRefusesABackupWhoseBodyIsCorrupt(t *testing.T) {
	dir := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	if out := mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest); !strings.Contains(out, "backed up to") {
		t.Fatalf("backup said:\n%s", out)
	}

	// Corrupt one body in the backup, keeping its filename and length, which
	// is what a rotted sector leaves behind.
	victim := ""
	root := filepath.Join(dest, "chunks")
	if err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || victim != "" {
			return err
		}
		victim = p
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if victim == "" {
		t.Fatal("the backup has no bodies, so this proves nothing")
	}
	was, err := os.ReadFile(victim)
	if err != nil {
		t.Fatal(err)
	}
	rotted := make([]byte, len(was))
	copy(rotted, was)
	rotted[0] ^= 0xff
	if err := os.WriteFile(victim, rotted, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err = trew(t, "purge", "-data", dir, "-vault", "default", "-confirm", "default", "-backup", dest)
	if err == nil {
		t.Fatal("purge accepted a backup holding a body that will not decrypt")
	}
	if !strings.Contains(err.Error(), "will not decrypt") && !strings.Contains(err.Error(), "cannot serve") {
		t.Fatalf("purge refused, but not for the corrupt body: %v", err)
	}
	// And nothing was dropped on the way to refusing.
	if out := mustRun(t, "stats", "-data", dir, "-json"); !strings.Contains(out, "\"versions\"") {
		t.Fatalf("stats after the refusal:\n%s", out)
	}
}

// A backup whose row differs from the source in a field the MAC does not
// cover here: same uid, same authenticator string, different stored path.
// Restoring it would put the note back under the wrong name.
func TestPurgeRefusesABackupWhoseRecordDiffers(t *testing.T) {
	dir := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)

	// Reach into the backup and move one row's path, leaving everything else
	// including the MAC exactly as it was.
	bkDB, bkChunks := store.DataDir(dest)
	bk, err := store.Open(bkDB, bkChunks)
	if err != nil {
		t.Fatal(err)
	}
	if err := bk.ExecForTest(
		`UPDATE entries SET path = path || '-moved' WHERE vault_id = 'default' AND uid = 1`); err != nil {
		t.Fatal(err)
	}
	if err := bk.Close(); err != nil {
		t.Fatal(err)
	}

	_, err = trew(t, "purge", "-data", dir, "-vault", "default", "-confirm", "default", "-backup", dest)
	if err == nil {
		t.Fatal("purge accepted a backup whose record of a version differs from this store's")
	}
	if !strings.Contains(err.Error(), "different path") {
		t.Fatalf("purge refused, but not for the changed record: %v", err)
	}
}

// The ordinary case still works, or the checks above are just a way of
// refusing everything.
func TestPurgeStillAcceptsAGoodBackup(t *testing.T) {
	dir := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)
	out := mustRun(t, "purge", "-data", dir, "-vault", "default", "-confirm", "default", "-backup", dest)
	if !strings.Contains(out, "versions") {
		t.Fatalf("purge said:\n%s", out)
	}
}

// The backup stays locked through the deletion it authorises (R23).
//
// The exclusion used to be taken and released inside the check, so it was gone
// by the time the check returned and before any history had been deleted.
// Everything the check established was then true of a directory nothing was
// protecting: another backup could replace it, or a purge could run against
// it, in the gap. A verification that does not outlive itself authorises
// nothing.
func TestThePurgeHoldsItsBackupUntilItIsDone(t *testing.T) {
	dir := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)

	// Between the successful check and the deletion, which is exactly where
	// the protection has to still be there.
	var heldDuringPurge bool
	beforePurge = func() {
		lock, err := dirlock.Exclusive(dest, dirlock.Data, "a competing backup")
		if err != nil {
			heldDuringPurge = true
			return
		}
		lock.Release()
	}
	t.Cleanup(func() { beforePurge = func() {} })

	mustRun(t, "purge", "-data", dir, "-vault", "default", "-confirm", "default", "-backup", dest)

	if !heldDuringPurge {
		t.Fatal("the backup could be taken exclusively between its verification and the purge, " +
			"so nothing was protecting what the check had just established")
	}
}

// And it is let go afterwards, or one purge would wedge every later backup.
func TestThePurgeReleasesItsBackupAfterwards(t *testing.T) {
	dir := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)
	mustRun(t, "purge", "-data", dir, "-vault", "default", "-confirm", "default", "-backup", dest)

	lock, err := dirlock.Exclusive(dest, dirlock.Data, "a later backup")
	if err != nil {
		t.Fatalf("the backup is still locked after the purge finished: %v", err)
	}
	lock.Release()
}

// A refused check holds nothing: it authorised no deletion, so it has no
// business keeping the directory.
func TestARefusedBackupCheckDoesNotKeepTheLock(t *testing.T) {
	dir := seeded(t)
	dest := t.TempDir() // not a backup at all
	if _, err := trew(t, "purge", "-data", dir, "-vault", "default",
		"-confirm", "default", "-backup", dest); err == nil {
		t.Fatal("purge accepted a directory that is not a backup")
	}
	lock, err := dirlock.Exclusive(dest, dirlock.Data, "afterwards")
	if err != nil {
		t.Fatalf("a refused check left the directory locked: %v", err)
	}
	lock.Release()
}

// And the same for a refusal that happens *after* the lock has been taken.
//
// The test above proves less than it reads: an empty directory is turned away
// by the `trew.db` stat, which is several steps before `dirlock.Shared`, so
// the error-path release the R23 fix added is never reached. Removing that
// release entirely left the whole suite green. This one refuses on a check
// that only happens once the backup is open, which is the branch in question.
func TestABackupRefusedAfterItIsLockedIsStillReleased(t *testing.T) {
	dir := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", dest)

	// One more version in the source than the backup holds, which `purge`
	// refuses only after opening and reading the backup under its lock.
	appendOne(t, dir, "later.md", "written after the backup")

	if _, err := trew(t, "purge", "-data", dir, "-vault", "default",
		"-confirm", "default", "-backup", dest); err == nil {
		t.Fatal("purge accepted a backup that is behind the store")
	}
	lock, err := dirlock.Exclusive(dest, dirlock.Data, "afterwards")
	if err != nil {
		t.Fatalf("a check that refused after taking the lock kept it: %v", err)
	}
	lock.Release()
}

// `verify` reporting no faults over nothing at all is not a clean bill of
// health, and the exit code is what a retention script reads.
//
// The printed line already told the two apart and the status did not, so
// `trewd verify -deep -data DIR && rm -rf OLD` -- the step docs/server.md
// documents, written the natural way -- passed over an empty store and deleted
// the last copy of the history a purge had just dropped.
func TestVerifyRefusesAStoreItCheckedNothingIn(t *testing.T) {
	// A store that exists and holds nothing, which is what a restore that
	// copied the database before it was populated leaves behind, and what a
	// path typo produces the first time anything opens it.
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	out, verifyErr := trew(t, "verify", "-deep", "-data", dir)
	if verifyErr == nil {
		t.Fatalf("verify passed a store it checked nothing in:\n%s", out)
	}
	if !strings.Contains(out, "checked 0 entries") {
		t.Errorf("the count of what was checked is not in the output:\n%s", out)
	}
}

// And it still passes a store that holds something.
func TestVerifyPassesAStoreWithEntriesInIt(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "verify", "-deep", "-data", dir)
	if strings.Contains(out, "checked 0 entries") {
		t.Fatalf("a seeded store reported no entries:\n%s", out)
	}
}

// `trewd stats` reports the numbers it exists to report.
//
// Two correct changes made it report none of them. Inspection commands open
// the store read-only (I15); the health probe writes, because a `SELECT 1`
// cannot see a store that answers reads and refuses them (R15). So the probe
// refused on every healthy server, and returned before the statfs, leaving
// `freeBytes` and `totalBytes` at zero under a `canPersist: false` that named
// the filesystem. The question it cannot ask from here is now said to be
// unasked, and the answers it can give are given.
func TestStatsReportsTheDiskItIsAskedAbout(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "stats", "-data", dir, "-json")

	var report struct {
		Health struct {
			CanPersist bool   `json:"canPersist"`
			Reason     string `json:"reason"`
			FreeBytes  int64  `json:"freeBytes"`
			TotalBytes int64  `json:"totalBytes"`
		} `json:"health"`
	}
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatalf("parse %s: %v", out, err)
	}
	if report.Health.FreeBytes <= 0 || report.Health.TotalBytes <= 0 {
		t.Errorf("no filesystem figures: free=%d total=%d",
			report.Health.FreeBytes, report.Health.TotalBytes)
	}
	// And it says which question it did not put, rather than answering it.
	if report.Health.Reason != string(store.HealthUnchecked) {
		t.Errorf("reason was %q, wanted %q", report.Health.Reason, store.HealthUnchecked)
	}
	if report.Health.Reason == string(store.HealthUnwritable) {
		t.Error("a healthy server was reported as a store that refuses writes")
	}

	// And the text form does not shout about it.
	text := mustRun(t, "stats", "-data", dir)
	if strings.Contains(text, "CANNOT TAKE A NOTE") {
		t.Errorf("stats raised an alarm about a healthy server:\n%s", text)
	}
	if !strings.Contains(text, "not checked from here") {
		t.Errorf("stats does not say the question was not put:\n%s", text)
	}
}

// `trewd service` reads the store and does not write to it.
//
// It opens one to run a single `SELECT` and was using the writable open, which
// creates the directory, runs `migrate`, applies the schema and stamps
// `user_version`. So printing a unit silently migrated an older store, and
// could not be done at all against read-only media. It was the last inspection
// command still writing to what it inspects (I15).
func TestServicePrintsAUnitAgainstAReadOnlyStore(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, where a mode of 444 stops nothing")
	}
	dir := seeded(t)
	dbPath, _ := store.DataDir(dir)
	if err := os.Chmod(dbPath, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dbPath, 0o600) })

	out, err := trew(t, "service", "-data", dir)
	if err != nil {
		t.Fatalf("service could not print a unit against a store it only reads: %v\n%s", err, out)
	}
	if !strings.Contains(out, "ExecStart=") {
		t.Errorf("no unit came out:\n%s", out)
	}
}

// And `serve` says "listening on" only once it is.
//
// The line and the pairing string went out seventeen statements before the
// bind. Under systemd both streams land in one journal, so the line an
// operator greps said the server was up, and handed them a setup string, for a
// server that exited 1 with "address already in use". Rule 4.
func TestServeSaysNothingAboutListeningWhenItCannotBind(t *testing.T) {
	dir := seeded(t)
	// A port somebody else already has.
	held, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Close() }()

	out, err := trew(t, "serve", "-data", dir, "-addr", held.Addr().String())
	if err == nil {
		t.Fatalf("serve started on a port that was taken:\n%s", out)
	}
	if strings.Contains(out, "listening on") {
		t.Errorf("serve announced a listener it never opened:\n%s", out)
	}
	// And it did not hand anybody a pairing string for it either.
	if strings.Contains(out, "#") && strings.Contains(out, "ws://") {
		t.Errorf("serve printed a setup string for a server that did not start:\n%s", out)
	}
}

// `verify -deep` sees a truncated chunk list, because the reader does (R47).
//
// The count and the ord sequence were added to the read path and not to the
// verifier, so the same binary printed `0 faults` over a row and then refused
// to serve it. A verifier that knows less than the reader is a clean bill of
// health nobody should act on, and rule 3 has an operator deleting the last
// copy on the strength of it.
func TestVerifyDeepSeesATruncatedChunkList(t *testing.T) {
	for _, c := range []struct {
		name    string
		remove  int64 // the ord to delete, or -1 to renumber instead
		rewrite [2]int64
		fault   string
	}{
		{name: "a missing tail", remove: 2, fault: "shortchunks"},
		{name: "an interior gap", remove: 1, fault: "shortchunks"},
		// The count and the maximum both still look right here, which is why
		// checking one end proved nothing (R51).
		{name: "a negative ordinal in place of zero", remove: -1,
			rewrite: [2]int64{0, -1}, fault: "chunkorder"},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			dbPath, chunkDir := store.DataDir(dir)
			st, err := store.Open(dbPath, chunkDir)
			if err != nil {
				t.Fatal(err)
			}
			if err := st.EnsureVault("default", 1); err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, body := range []string{"one ", "two ", "three"} {
				n := chunks.Name([]byte(body))
				if err := st.Chunks().Put("default", n, []byte(body)); err != nil {
					t.Fatal(err)
				}
				names = append(names, n)
			}
			uid, err := st.AppendEntry("default", store.Entry{
				Path: "note.md", Size: 13, MTime: 1, Device: "d", Chunks: names,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			// The damage, done to the file rather than through the store,
			// because the store is what is being asked to notice it.
			onDisk(t, dbPath, func(db *sql.DB) {
				if c.remove >= 0 {
					if _, err := db.Exec(
						`DELETE FROM entry_chunks WHERE vault_id = ? AND uid = ? AND ord = ?`,
						"default", uid, c.remove); err != nil {
						t.Fatal(err)
					}
					return
				}
				if _, err := db.Exec(
					`UPDATE entry_chunks SET ord = ? WHERE vault_id = ? AND uid = ? AND ord = ?`,
					c.rewrite[1], "default", uid, c.rewrite[0]); err != nil {
					t.Fatal(err)
				}
			})

			out, err := trew(t, "verify", "-deep", "-data", dir)
			if err == nil {
				t.Fatalf("verify passed a version it will not serve:\n%s", out)
			}
			if !strings.Contains(out, c.fault) {
				t.Errorf("the fault was not named as %s:\n%s", c.fault, out)
			}
		})
	}
}

// And an ordinary vault still verifies clean, so the check is not a blanket no.
func TestVerifyDeepStillPassesAWholeVault(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "verify", "-deep", "-data", dir)
	if !strings.Contains(out, "0 faults") {
		t.Fatalf("a healthy vault reported faults:\n%s", out)
	}
}

// onDisk runs raw SQL against a store's database file, for fixtures that have
// to be shaped the way a damaged or older store is shaped rather than the way
// this build would write one.
func onDisk(t *testing.T, dbPath string, fn func(*sql.DB)) {
	t.Helper()
	// Without foreign keys, because these fixtures rebuild tables the schema
	// cascades from: turning them on would make dropping `entries` delete the
	// chunk rows the fixture is trying to keep.
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
	}()
	fn(db)
}
