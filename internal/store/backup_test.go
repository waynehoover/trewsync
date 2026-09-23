package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"encoding/json"
	"github.com/waynehoover/trew/internal/chunks"
)

// openBackup opens a backup directory the way the server would, which is the
// point of writing a backup as a data directory: restoring is copying it back.
func openBackup(t *testing.T, dir string) *Store {
	t.Helper()
	dbPath, chunkDir := DataDir(dir)
	s, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("opening the backup as a data directory: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// A backup has to be restorable, not merely written. This checks the whole
// round trip: every entry, every chunk list, every body, and a deep verify.
func TestABackupRestoresEverything(t *testing.T) {
	h := newTestStore(t)
	var want []Entry
	for i := 0; i < 5; i++ {
		want = append(want, h.file(t, fmt.Sprintf("f%d.md", i), "shared head", fmt.Sprintf("tail %d", i)))
	}
	// History, a folder, a deletion and an empty note, so the backup is not
	// only tested on the easy shape.
	want = append(want, h.file(t, "f0.md", "shared head", "a second version"))
	for _, e := range []Entry{
		{Path: "folder", Folder: true},
		{Path: "f1.md", Deleted: true, MTime: 9},
		{Path: "empty.md", Size: 0, MTime: 9},
	} {
		uid, err := h.AppendEntry("v1", e)
		if err != nil {
			t.Fatalf("append: %v", err)
		}
		e.UID = uid
		want = append(want, e)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	t.Log(rep)

	// The backup's own arithmetic. Six distinct bodies: one shared head plus
	// five tails, plus the second version's body.
	if rep.Vaults != 1 {
		t.Fatalf("Vaults = %d, want 1", rep.Vaults)
	}
	if rep.Copied != 7 {
		t.Fatalf("Copied = %d bodies, want 7", rep.Copied)
	}
	if rep.Verified != int(rep.Refs) {
		t.Fatalf("verified %d of %d references", rep.Verified, rep.Refs)
	}
	if rep.SourceBodies != rep.DestBodies {
		t.Fatalf("%d bodies at source, %d in the backup", rep.SourceBodies, rep.DestBodies)
	}

	restored := openBackup(t, dir)
	for _, e := range want {
		got, ok, err := restored.EntryByUID("v1", e.UID)
		if err != nil || !ok {
			t.Fatalf("uid %d missing from the backup: ok=%v err=%v", e.UID, ok, err)
		}
		if got.Path != e.Path || got.Size != e.Size || got.Deleted != e.Deleted || got.Folder != e.Folder {
			t.Fatalf("uid %d came back as %+v, want %+v", e.UID, got, e)
		}
		if len(got.Chunks) != len(e.Chunks) {
			t.Fatalf("uid %d has %d chunks, want %d", e.UID, len(got.Chunks), len(e.Chunks))
		}
		for i := range e.Chunks {
			if got.Chunks[i] != e.Chunks[i] {
				t.Fatalf("uid %d chunk %d differs", e.UID, i)
			}
			body, err := restored.Chunks().Get("v1", got.Chunks[i])
			if err != nil {
				t.Fatalf("uid %d chunk %d body: %v", e.UID, i, err)
			}
			srcBody, err := h.Chunks().Get("v1", e.Chunks[i])
			if err != nil {
				t.Fatalf("source body: %v", err)
			}
			if string(body) != string(srcBody) {
				t.Fatalf("uid %d chunk %d body differs", e.UID, i)
			}
		}
	}

	// The restored store must be usable, not just readable: uids continue from
	// where they left off rather than being reissued.
	next, err := restored.AppendEntry("v1", Entry{Path: "after.md", Size: 0, MTime: 10})
	if err != nil {
		t.Fatalf("appending to a restored backup: %v", err)
	}
	if next != want[len(want)-1].UID+1 {
		t.Fatalf("next uid after restore = %d, want %d", next, want[len(want)-1].UID+1)
	}
}

// The second backup into the same directory copies only what is missing. This is
// what makes a backup cheap enough to run often, and it works only because a
// body is named by its hash, so one already there is already correct.
func TestASecondBackupCopiesOnlyWhatIsNew(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 4; i++ {
		h.file(t, fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
	}
	dir := filepath.Join(t.TempDir(), "backup")

	first, err := h.Backup(dir, false)
	if err != nil {
		t.Fatalf("first backup: %v", err)
	}
	if first.Copied != 4 {
		t.Fatalf("first backup copied %d bodies, want 4", first.Copied)
	}

	second, err := h.Backup(dir, false)
	if err != nil {
		t.Fatalf("second backup: %v", err)
	}
	if second.Copied != 0 || second.Bytes != 0 {
		t.Fatalf("second backup copied %d bodies (%d bytes), want none",
			second.Copied, second.Bytes)
	}
	if second.Refs != first.Refs {
		t.Fatalf("second backup saw %d references, first saw %d", second.Refs, first.Refs)
	}

	// New work, then a third backup that copies exactly the new body.
	h.file(t, "new.md", "brand new body")
	third, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("third backup: %v", err)
	}
	if third.Copied != 1 {
		t.Fatalf("third backup copied %d bodies, want 1", third.Copied)
	}
	if third.Refs != first.Refs+1 {
		t.Fatalf("third backup saw %d references, want %d", third.Refs, first.Refs+1)
	}
}

// A commit landing while a backup runs must not make the backup inconsistent.
//
// The ordering that guarantees this is not enforced by a comment: the list of
// bodies to copy comes from the *snapshot*, so a body cannot be copied for an
// entry the snapshot does not have, and the snapshot cannot contain an entry
// whose bodies were not already durable. Copying bodies first is not merely
// wrong, it is unexpressible, because there would be no reference list yet.
//
// What is worth pinning down is the consequence: the backup contains exactly
// what its own database claims, and the entry committed mid-run is simply
// absent, because a backup is a point in time.
func TestABackupNeverHoldsAnEntryWithoutItsBodies(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 3; i++ {
		h.file(t, fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
	}

	dir := filepath.Join(t.TempDir(), "backup")
	// Commit while the backup is between its snapshot and its body copy. The
	// hook fires on every reference, and the first one is comfortably after the
	// snapshot was taken.
	var once bool
	h.duringBackup = func() {
		if once {
			return
		}
		once = true
		h.file(t, "raced.md", "committed mid backup")
	}

	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if !once {
		t.Fatal("the interleaving never happened, so this test proved nothing")
	}

	// The backup is self-consistent: everything its database claims, it holds.
	restored := openBackup(t, dir)
	faultsRep, err := restored.Verify(true)
	faults, checked := faultsRep.Faults, faultsRep.Chunks
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(faults) != 0 {
		t.Fatalf("the backup holds %d entries it cannot serve: %v", len(faults), faults[0])
	}
	if checked == 0 {
		t.Fatal("verify checked nothing")
	}
	// The raced entry is absent, and so is its body. A backup that copied
	// bodies for entries newer than its own snapshot would hold something its
	// database does not reference, which makes the backup's contents no longer
	// determined by the backup.
	if _, ok, err := restored.LatestForPath("v1", "raced.md"); err != nil {
		t.Fatalf("latest: %v", err)
	} else if ok {
		t.Fatal("an entry committed after the snapshot is in the backup")
	}
	if rep.DestBodies != 3 {
		t.Fatalf("the backup holds %d bodies for a 3 entry snapshot: it copied bodies "+
			"for work committed after the snapshot", rep.DestBodies)
	}
	if rep.SourceBodies != 4 {
		t.Fatalf("SourceBodies = %d, want 4: the raced commit added one", rep.SourceBodies)
	}
	t.Log(rep)
}

// The verify pass at the end of a backup is what turns "written" into
// "restorable". Without it a backup that lost a body between copying it and
// finishing would still be reported as a success, and nothing looks at a backup
// again until it is the only copy left.
//
// The body is removed from the *destination* after being copied, because a body
// missing at the source fails at the copy and never reaches the verify.
func TestABackupVerifiesWhatItWroteAndNotWhatItIntendedTo(t *testing.T) {
	h := newTestStore(t)
	var first Entry
	for i := 0; i < 4; i++ {
		e := h.file(t, fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
		if i == 0 {
			first = e
		}
	}

	dir := filepath.Join(t.TempDir(), "backup")
	_, destChunkDir := DataDir(dir)

	// On the third reference, delete the body copied on the first.
	calls := 0
	h.duringBackup = func() {
		calls++
		if calls != 3 {
			return
		}
		cs, err := chunks.New(destChunkDir, ChunkMax)
		if err != nil {
			t.Fatalf("opening the backup's chunk store: %v", err)
		}
		p, err := cs.Path("v1", first.Chunks[0])
		if err != nil {
			t.Fatalf("path: %v", err)
		}
		if err := os.Remove(p); err != nil {
			t.Fatalf("removing a copied body: %v", err)
		}
	}

	_, err := h.Backup(dir, false)
	if err == nil {
		t.Fatal("the backup reported success after losing a body it had already copied")
	}
	if !strings.Contains(err.Error(), "missing") {
		t.Fatalf("err = %v, want it to say what is missing", err)
	}
	if calls < 3 {
		t.Fatalf("the hook fired %d times, so the body was never removed", calls)
	}
}

// Bit rot at the source must fail the backup rather than being copied onward,
// and it must blame the source.
//
// The write end would refuse it anyway, since Put verifies what it is given. The
// value of reading through Get is the diagnosis: a body that rotted on the
// source disk reported as a fault at the destination sends someone to check the
// wrong disk.
func TestABackupRefusesACorruptBodyAndBlamesTheSource(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "the original bytes")
	p, err := h.Chunks().Path("v1", e.Chunks[0])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.WriteFile(p, []byte("something else entirely"), 0o600); err != nil {
		t.Fatalf("tamper: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	_, err = h.Backup(dir, false)
	if err == nil {
		t.Fatal("a corrupt body was copied into the backup and reported as a success")
	}
	if !strings.Contains(err.Error(), "reading") {
		t.Fatalf("the failure does not say the body was bad on the way out of the source, "+
			"so it points at the wrong disk: %v", err)
	}
}

// SnapshotInto never writes over an existing file. SQLite enforces this, not
// this package, so the test is here to notice if that ever stops being true
// rather than to cover a check of our own.
func TestSnapshotIntoRefusesAnExistingFile(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")

	target := filepath.Join(t.TempDir(), "snap.db")
	if err := h.SnapshotInto(target); err != nil {
		t.Fatalf("first snapshot: %v", err)
	}
	if err := h.SnapshotInto(target); err == nil {
		t.Fatal("the second snapshot overwrote the first")
	}
}

// A backup that cannot find a body it needs fails, loudly. Reporting success
// here is the one outcome that must never happen, because nothing looks at a
// backup again until it is the only copy left.
func TestABackupFailsWhenABodyIsMissing(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "will vanish")
	p, err := h.Chunks().Path("v1", e.Chunks[0])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatalf("remove: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, false); err == nil {
		t.Fatal("the backup reported success with a body missing from the source")
	}
}

// Backing up into the data directory would half work, which is worse than
// failing.
func TestABackupRefusesTheDataDirectoryItself(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")

	if _, err := h.Backup(h.dir, false); err == nil {
		t.Fatal("the backup accepted the data directory as its destination")
	} else if !strings.Contains(err.Error(), "data directory itself") {
		t.Fatalf("err = %v, want it to say why", err)
	}
}

// An interrupted backup must leave the previous database in place rather than a
// half-written one, so a failed run does not destroy the last good backup.
func TestAnInterruptedSnapshotLeavesThePreviousBackupIntact(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "the only copy")
	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, false); err != nil {
		t.Fatalf("first backup: %v", err)
	}

	// Debris from a run that died between the snapshot and the rename. The
	// staging name is per-operation now, so this is one of the shapes it takes
	// rather than the only one, and the next run sweeps every one of them.
	tmp := filepath.Join(dir, ".trew.db.snapshot.1234")
	if err := os.WriteFile(tmp, []byte("half a database"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// The previous backup still opens and still holds the note.
	restored := openBackup(t, dir)
	if _, ok, err := restored.LatestForPath("v1", "note.md"); err != nil || !ok {
		t.Fatalf("the previous backup was damaged: ok=%v err=%v", ok, err)
	}
	restored.Close()

	// And the next run clears the debris rather than tripping over it.
	if _, err := h.Backup(dir, true); err != nil {
		t.Fatalf("backup after an interrupted one: %v", err)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatalf("the snapshot temporary file survived: %v", err)
	}
	// And no staging file of any name is left behind by a run that finished.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read the backup: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".trew.db.snapshot") {
			t.Fatalf("a finished backup left staging debris: %s", e.Name())
		}
	}
}

// A backup holds full history, not just the current state. That is most of the
// reason to keep one: a deleted note is recoverable from the server only while
// the server still has the entry that deleted it.
func TestABackupKeepsHistoryAndDeletions(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "version one")
	h.file(t, "note.md", "version two")
	if _, err := h.AppendEntry("v1", Entry{Path: "note.md", Deleted: true, MTime: 9}); err != nil {
		t.Fatalf("delete: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, true); err != nil {
		t.Fatalf("backup: %v", err)
	}

	restored := openBackup(t, dir)
	history, err := restored.HistoryForPath("v1", "note.md", 0, 10)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(history) != 3 {
		t.Fatalf("the backup holds %d versions of note.md, want 3", len(history))
	}
	// The first version's body is still there, which is what makes it
	// recoverable.
	oldest := history[len(history)-1]
	body, err := restored.Chunks().Get("v1", oldest.Chunks[0])
	if err != nil {
		t.Fatalf("the oldest version's body is gone from the backup: %v", err)
	}
	if string(body) != "version one" {
		t.Fatalf("oldest body is %q", body)
	}
	del, _, err := restored.Deleted("v1", true, 0, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	if len(del) != 1 {
		t.Fatalf("the backup lists %d deletions, want 1", len(del))
	}
}

// Multiple vaults are namespaced in the backup exactly as they are at source, so
// one vault's backup cannot serve another vault's body.
func TestABackupKeepsVaultsSeparate(t *testing.T) {
	h := newTestStore(t)
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	h.file(t, "shared.md", "identical content")
	name := chunks.Name([]byte("identical content"))
	if err := h.Chunks().Put("v2", name, []byte("identical content")); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := h.AppendEntry("v2", Entry{
		Path: "shared.md", Size: 17, MTime: 1, Chunks: []string{name},
	}); err != nil {
		t.Fatalf("append: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if rep.Vaults != 2 {
		t.Fatalf("Vaults = %d, want 2", rep.Vaults)
	}
	// The same content in two vaults is two bodies, at source and in the backup,
	// because vaults do not share chunk storage.
	if rep.Copied != 2 {
		t.Fatalf("Copied = %d, want 2: vaults must not share bodies", rep.Copied)
	}

	restored := openBackup(t, dir)
	for _, v := range []string{"v1", "v2"} {
		if !restored.Chunks().Has(v, name) {
			t.Fatalf("vault %s lost its body in the backup", v)
		}
	}
}

// mustPath is used only by the mutation pass, to stand in for a copy that reads
// the body without checksumming it.
func mustPath(s *Store, vaultID, name string) string {
	p, err := s.Chunks().Path(vaultID, name)
	if err != nil {
		panic(err)
	}
	return p
}

// The body counts either side of a backup are what explain why the backup is
// smaller. A temporary file counted as a body makes that explanation wrong, and
// an unexplained discrepancy in a backup report is exactly what rule 5 is about.
func TestBackupCountsIgnoreInProgressWrites(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")

	// An upload in flight, or the debris of one that died.
	dir := filepath.Join(h.Chunks().VaultDir("v1"), "ab")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".tmp-inflight"), []byte("half"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	rep, err := h.Backup(filepath.Join(t.TempDir(), "backup"), true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if rep.SourceBodies != 1 {
		t.Fatalf("SourceBodies = %d, want 1: a temporary file was counted as a body",
			rep.SourceBodies)
	}
	if rep.DestBodies != 1 {
		t.Fatalf("DestBodies = %d, want 1", rep.DestBodies)
	}
}

// A different snapshot of the same size is caught (I16).
//
// The stamp was the database's size, which survives a copy and is why it was
// chosen, and which two snapshots of one store share about as often as not: an
// hour's worth of notes is usually the same number of pages. So a database
// republished into a backup directory by anything that does not rewrite
// backup.json left coverage that went on looking plausible while describing a
// snapshot that no longer existed, for ever, because nothing corrects it.
//
// SQLite's file change counter is four bytes at offset 24 of the header and
// moves on every transaction that modifies the database. It is inside the file,
// so it survives `cp -r` exactly as the size does.
func TestCoverageCatchesADifferentDatabaseOfTheSameSize(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "live")
	dbPath, chunkDir := DataDir(src)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(dir, "backup")
	if _, err := st.Backup(dest, false); err != nil {
		t.Fatalf("backup: %v", err)
	}
	if _, err := ReadBackupMeta(dest); err != nil {
		t.Fatalf("the backup this just took does not read: %v", err)
	}

	// A second snapshot of the same store, published over the first without
	// its coverage being rewritten. Same schema, same rows, same size.
	destDB, _ := DataDir(dest)
	before, err := os.Stat(destDB)
	if err != nil {
		t.Fatal(err)
	}
	// One more transaction, so the change counter moves and the page count does
	// not. Writing a vault row into an existing table adds no page.
	if err := st.SawDevice("default", "nobody", 2000); err != nil {
		// Not every build has a device to see; the point is a transaction.
		if err := st.EnsureVault("default", 2000); err != nil {
			t.Fatal(err)
		}
	}
	second := filepath.Join(dir, "second.db")
	if err := st.SnapshotInto(second); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(second)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destDB, body, 0o600); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(destDB)
	if err != nil {
		t.Fatal(err)
	}
	if before.Size() != after.Size() {
		t.Skipf("the two snapshots differ in size (%d then %d), so the size check "+
			"catches this one and the change counter is not what is under test here",
			before.Size(), after.Size())
	}

	_, err = ReadBackupMeta(dest)
	if err == nil {
		t.Fatal("coverage describing a database that was replaced read as valid")
	}
	if !strings.Contains(err.Error(), "change") {
		t.Fatalf("refused, but not for the reason it should be: %v", err)
	}
}

// Every backup taken before the change counter was stamped records zero, and
// zero means "not recorded" rather than "the counter is zero". Treating it as a
// mismatch would fail every backup anybody already has.
func TestCoverageWithNoChangeCounterStillReads(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "live")
	dbPath, chunkDir := DataDir(src)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "backup")
	if _, err := st.Backup(dest, false); err != nil {
		t.Fatal(err)
	}

	// Rewrite the sidecar as an older build would have: everything else the
	// same, no change counter.
	path := filepath.Join(dest, BackupMetaFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var meta BackupMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Database.Change == 0 {
		t.Fatal("the backup just taken recorded no change counter, so this proves nothing")
	}
	meta.Database.Change = 0
	out, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := ReadBackupMeta(dest); err != nil {
		t.Fatalf("a backup from before the counter was stamped was refused: %v", err)
	}
}

// Two completed backups of one store are told apart (R14).
//
// The sidecar carried the database's size and SQLite's file change counter,
// and neither identifies a snapshot. `VACUUM INTO` writes a fresh database, so
// its counter starts from the transactions that built it rather than carrying
// anything over: two backups of the same store, taken with a real edit between
// them, are the same size and at the same change. Swapping one database for
// the other while keeping the first's coverage was accepted, and the coverage
// then described a snapshot that no longer existed.
func TestCoverageTellsTwoCompletedBackupsApart(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "live")
	dbPath, chunkDir := DataDir(src)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}

	first := filepath.Join(dir, "first")
	if _, err := st.Backup(first, false); err != nil {
		t.Fatal(err)
	}
	// A real change through the ordinary API, then a second real backup.
	if err := st.EnsureVault("second", 2000); err != nil {
		t.Fatal(err)
	}
	second := filepath.Join(dir, "second")
	if _, err := st.Backup(second, false); err != nil {
		t.Fatal(err)
	}

	firstDB, _ := DataDir(first)
	secondDB, _ := DataDir(second)
	a, err := os.Stat(firstDB)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.Stat(secondDB)
	if err != nil {
		t.Fatal(err)
	}
	ac, err := sqliteChangeCounter(firstDB)
	if err != nil {
		t.Fatal(err)
	}
	bc, err := sqliteChangeCounter(secondDB)
	if err != nil {
		t.Fatal(err)
	}
	if a.Size() != b.Size() || ac != bc {
		t.Skipf("the two backups differ in size (%d, %d) or change counter (%d, %d), so the "+
			"cheap checks catch this one and the digest is not what is under test",
			a.Size(), b.Size(), ac, bc)
	}

	// The second database, under the first's coverage.
	body, err := os.ReadFile(secondDB)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(firstDB, body, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err = ReadBackupMeta(first)
	if err == nil {
		t.Fatal("coverage describing one backup was accepted beside a different one")
	}
	if !strings.Contains(err.Error(), "hash") {
		t.Fatalf("refused, but not because the contents differ: %v", err)
	}
}

// And a backup taken before the digest existed still reads.
func TestCoverageWithNoDigestStillReads(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "live")
	dbPath, chunkDir := DataDir(src)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "backup")
	if _, err := st.Backup(dest, false); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dest, BackupMetaFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var meta BackupMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Database.Digest == "" {
		t.Fatal("the backup just taken recorded no digest, so this proves nothing")
	}
	meta.Database.Digest = ""
	out, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBackupMeta(dest); err != nil {
		t.Fatalf("a backup from before the digest was stamped was refused: %v", err)
	}
}

// A damaged sidecar is an error, not a crash (R27).
//
// The digest came out of JSON, which is to say out of a file on a disk that may
// be the reason somebody is reading it, and the mismatch message sliced the
// first sixteen characters off it. A shorter value panicked, so a damaged
// sidecar took the diagnostic down with it at exactly the moment the tool has
// to keep working. Rule 2 in the small: an unreadable field is an unreadable
// field, not a crash.
func TestAMalformedDigestIsRefusedRatherThanPanicking(t *testing.T) {
	for _, digest := range []string{
		"x",
		"short",
		"nothex!!nothex!!nothex!!nothex!!nothex!!nothex!!nothex!!nothex!!",
		strings.Repeat("a", 63),
		strings.Repeat("a", 65),
		strings.Repeat("A", 64), // upper case is not what fileDigest writes
	} {
		t.Run(short(digest), func(t *testing.T) {
			dir := t.TempDir()
			src := filepath.Join(dir, "live")
			dbPath, chunkDir := DataDir(src)
			st, err := Open(dbPath, chunkDir)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = st.Close() }()
			if err := st.EnsureVault("default", 1000); err != nil {
				t.Fatal(err)
			}
			dest := filepath.Join(dir, "backup")
			if _, err := st.Backup(dest, false); err != nil {
				t.Fatal(err)
			}

			path := filepath.Join(dest, BackupMetaFile)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var meta BackupMeta
			if err := json.Unmarshal(raw, &meta); err != nil {
				t.Fatal(err)
			}
			meta.Database.Digest = digest
			out, err := json.Marshal(meta)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, out, 0o600); err != nil {
				t.Fatal(err)
			}

			// The assertion is as much that this returns at all as what it
			// returns: a panic here fails the test by crashing it.
			_, err = ReadBackupMeta(dest)
			if err == nil {
				t.Fatalf("a digest of %q was accepted", digest)
			}
			if !strings.Contains(err.Error(), "not a SHA-256") {
				t.Fatalf("refused, but not as a damaged digest: %v", err)
			}
		})
	}
}

// A fault the source already has does not veto a faithful copy of it.
//
// Basalt met this with entries from before F20, which a migration gave an
// empty authenticator and `verifyEntries` then reported on every pass.
// `Backup` refused to publish while any fault existed, so on any vault old
// enough to have one, every backup failed for ever, and the message blamed the
// backup for a fault in the store it came from. The last good copy was never
// refreshed, and `purge -backup` could then never be satisfied either, so the
// safety net was cut by the thing holding it.
//
// Hazard 6: the authenticator is gone, so the fault seeded here is one the
// path policy names, a row written behind the policy's back.
func TestBackupPublishesOverAFaultItInherited(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "live")
	dbPath, chunkDir := DataDir(src)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}
	body := []byte("a note under a path no device would take")
	name := chunks.Name(body)
	if err := st.Chunks().Put("default", name, body); err != nil {
		t.Fatal(err)
	}
	uid, err := st.AppendEntry("default", Entry{
		Path: "old.md", Size: int64(len(body)), MTime: 1, Device: "d",
		Chunks: []string{name},
	})
	if err != nil {
		t.Fatal(err)
	}
	// A committed row under a path the policy refuses, and the live set
	// rebuilt from it the way `serve` would, so the path is the only fault.
	if _, err := st.db.Exec(`UPDATE entries SET path = '.obsidian/old.md' WHERE vault_id = ? AND uid = ?`,
		"default", uid); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RepairLive(); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(dir, "backup")
	rep, err := st.Backup(dest, true)
	if err != nil {
		t.Fatalf("a backup was refused for a fault in the store it copied: %v", err)
	}
	if len(rep.Inherited) != 1 || rep.Inherited[0].Reason != "badpath" || rep.Inherited[0].UID != uid {
		t.Errorf("the inherited fault was not reported: %v", rep.Inherited)
	}
	// And it really published: the coverage beside it describes this snapshot.
	if _, err := ReadBackupMeta(dest); err != nil {
		t.Fatalf("nothing was published: %v", err)
	}
	// A second one works too, which is the property that was actually lost.
	if _, err := st.Backup(dest, true); err != nil {
		t.Fatalf("the next backup was refused as well: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
}

// And a fault the source does not have still refuses.
//
// That is the whole of the distinction: a missing body in the destination is
// this operation's own work and no copy of anything.
func TestBackupStillRefusesAFaultOfItsOwn(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "live")
	dbPath, chunkDir := DataDir(src)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}
	body := []byte("a body the backup will lose")
	name := chunks.Name(body)
	if err := st.Chunks().Put("default", name, body); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendEntry("default", Entry{
		Path: "note.md", Size: int64(len(body)), MTime: 1, Device: "d",
		Chunks: []string{name},
	}); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(dir, "backup")
	// The body goes missing from the destination between the copy and the
	// verification, which is the shape of a copy that did not work.
	st.afterPublish = nil
	st.duringBackup = func() {
		st.duringBackup = nil
		_, destChunks := DataDir(dest)
		_ = os.RemoveAll(destChunks)
	}
	if _, err := st.Backup(dest, false); err == nil {
		t.Fatal("a backup missing the body it just copied was published")
	}
}
