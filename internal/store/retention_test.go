package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/chunks"
)

/* ---------------------------------------------------------------- *
 * Retention is by reference, pinned at the operation (PLAN.md 4.5)
 * ---------------------------------------------------------------- */

// agedNote writes a note whose content was last touched a year ago, by the
// client's clock and on disk: its entry's mtime and ctime, and its bodies'
// modification times, which are what purge's grace window reads.
func (h *harness) agedNote(t *testing.T, path, body string) Entry {
	t.Helper()
	yearAgo := time.Now().Add(-365 * 24 * time.Hour)
	e := h.entryFor(t, path, body)
	e.MTime, e.CTime = yearAgo.UnixMilli(), yearAgo.UnixMilli()
	uid, err := h.AppendEntry("v1", e)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	e.UID = uid
	h.age(t, e, yearAgo)
	return e
}

// age sets the modification time of every body of e, so a default purge's
// grace window does not spare them for being new: the property under test is
// the pin, and a body written a moment ago would survive without one.
func (h *harness) age(t *testing.T, e Entry, at time.Time) {
	t.Helper()
	for _, n := range e.Chunks {
		p, err := h.Chunks().Path("v1", n)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
}

// PLAN.md M5 task 10, and the test the -keep-since design fails: a note
// untouched for a year, edited by an agent today, purged immediately with the
// defaults, and the server restarted. The version the agent displaced is
// neither a head nor newer than any age cutoff, so only the pin keeps it; the
// exact former bytes must still read back by uid.
//
// Checked against the failure too: with the pin deleted, the same purge drops
// the version, which is what makes the first half evidence rather than luck.
func TestAYearOldNoteEditedTodaySurvivesAnImmediatePurgeAndARestart(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	const former = "what the note said for a year, before the agent"
	old := h.agedNote(t, "old.md", former)

	res, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "old.md", old.UID, "what the agent made of it")))
	if err != nil {
		t.Fatal(err)
	}
	if res.Entries[0].PreviousUID != old.UID {
		t.Fatalf("previousUid %d, want %d", res.Entries[0].PreviousUID, old.UID)
	}

	rep, err := h.Purge("v1", chunks.DefaultGrace)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if rep.VersionsRemoved != 0 || rep.VersionsPinned != 1 {
		t.Fatalf("purge removed %d and kept %d for their pins, want 0 and 1: %+v", rep.VersionsRemoved, rep.VersionsPinned, rep)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}

	again := openAt(t, h.dir)
	if got := again.bytesOf(t, again.Store, old.UID); got != former {
		t.Fatalf("after the purge and a restart the before-image reads %q", got)
	}
	// And a purge on the restarted server keeps it too.
	if rep, err := again.Purge("v1", chunks.DefaultGrace); err != nil || rep.VersionsRemoved != 0 {
		t.Fatalf("a second purge: %+v %v", rep, err)
	}
	if got := again.bytesOf(t, again.Store, old.UID); got != former {
		t.Fatalf("after a second purge the before-image reads %q", got)
	}

	// Without the pin, the same purge takes it: the pin is the whole reason.
	if err := again.ExecForTest(`DELETE FROM op_pins`); err != nil {
		t.Fatal(err)
	}
	if rep, err := again.Purge("v1", chunks.DefaultGrace); err != nil || rep.VersionsRemoved != 1 || rep.ChunksDeleted != 1 {
		t.Fatalf("an unpinned purge: %+v %v", rep, err)
	}
	if _, ok, _ := again.EntryByUID("v1", old.UID); ok {
		t.Fatal("the unpinned version survived, so the pinned case proved nothing")
	}
}

// The same across a backup and a restore: the backup carries the operation and
// its pin, and the restored store's own default purge keeps the before-image.
// Restoring is serving the backup's directory, so that is what is opened.
func TestTheBeforeImageSurvivesABackupAndARestore(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	const former = "the year-old words"
	old := h.agedNote(t, "old.md", former)
	res, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "old.md", old.UID, "the agent's words")))
	if err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if rep.Oplog != (OplogCounts{Operations: 1, Pins: 1}) {
		t.Fatalf("the backup carries %+v", rep.Oplog)
	}

	restored := &harness{Store: openBackup(t, dir), dir: dir}
	checked, err := restored.Verify(true)
	if err != nil || len(checked.Faults) != 0 || checked.Operations != 1 {
		t.Fatalf("verifying the restore: %+v %v", checked, err)
	}
	restored.age(t, old, time.Now().Add(-365*24*time.Hour))
	prep, err := restored.Purge("v1", chunks.DefaultGrace)
	if err != nil || prep.VersionsRemoved != 0 || prep.VersionsPinned != 1 {
		t.Fatalf("purging the restore: %+v %v", prep, err)
	}
	if err := restored.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openAt(t, dir)
	if got := reopened.bytesOf(t, reopened.Store, old.UID); got != former {
		t.Fatalf("the restored before-image reads %q", got)
	}
	rec, ok, err := reopened.LookupOperation("v1", res.OpID)
	if err != nil || !ok || rec.ActorLabel != "agent" || len(rec.Pins) != 1 || rec.Pins[0].UID != old.UID {
		t.Fatalf("the restored audit: %+v ok=%v err=%v", rec, ok, err)
	}
	if rec.Epoch == reopened.Epoch() {
		t.Fatal("the restore did not start a new epoch")
	}
}

// Inside its window a pin holds against every default purge, and after it the
// version is ordinary history: the next purge drops it, lets the pin row go,
// and keeps the operation's audit. The clock is the store's, injected.
func TestAPinHoldsInsideItsWindowAndNotAfter(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	t0 := time.Now()
	clock := t0
	h.SetClock(func() time.Time { return clock })
	old := h.agedNote(t, "old.md", "the before-image")
	res, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "old.md", old.UID, "the edit")))
	if err != nil {
		t.Fatal(err)
	}
	// The edit's own body is new, and aged too, so the grace window spares
	// nothing either side of the expiry.
	h.age(t, res.Entries[0].Entry, t0.Add(-time.Hour*24))

	for _, at := range []time.Duration{0, time.Hour, 29 * 24 * time.Hour, MinPinRetention - time.Millisecond} {
		clock = t0.Add(at)
		rec, err := h.Reclaimable("v1", chunks.DefaultGrace)
		if err != nil || rec.Versions != 0 || rec.Pinned != 1 || rec.Bodies != 0 {
			t.Fatalf("at +%s the preview says %+v %v", at, rec, err)
		}
		rep, err := h.Purge("v1", chunks.DefaultGrace)
		if err != nil || rep.VersionsRemoved != 0 || rep.VersionsPinned != 1 || rep.ChunksDeleted != 0 || rep.PinsExpired != 0 {
			t.Fatalf("at +%s a default purge: %+v %v", at, rep, err)
		}
		if _, ok, _ := h.EntryByUID("v1", old.UID); !ok {
			t.Fatalf("at +%s the pinned version is gone", at)
		}
	}

	clock = t0.Add(MinPinRetention)
	rec, err := h.Reclaimable("v1", chunks.DefaultGrace)
	if err != nil || rec.Versions != 1 || rec.Pinned != 0 || rec.Bodies != 1 {
		t.Fatalf("after the window the preview says %+v %v", rec, err)
	}
	rep, err := h.Purge("v1", chunks.DefaultGrace)
	if err != nil {
		t.Fatal(err)
	}
	if rep.VersionsRemoved != 1 || rep.VersionsPinned != 0 || rep.PinsExpired != 1 || rep.ChunksDeleted != rec.Bodies ||
		rep.BytesDeleted != rec.Bytes {
		t.Fatalf("after the window a purge did %+v, and its preview said %+v", rep, rec)
	}
	if _, ok, _ := h.EntryByUID("v1", old.UID); ok {
		t.Fatal("an expired pin still held its version")
	}
	audit, ok, err := h.LookupOperation("v1", res.OpID)
	if err != nil || !ok || len(audit.Pins) != 0 || len(audit.Paths) != 1 || *audit.Paths[0].BeforeUID != old.UID {
		t.Fatalf("the audit after the pin went: %+v ok=%v err=%v", audit, ok, err)
	}
	if got := h.bytesOf(t, h.Store, res.Entries[0].Entry.UID); got != "the edit" {
		t.Fatalf("the head reads %q", got)
	}
}

// Purge's preview and purge agree with pins in play, on a vault where some
// history is pinned and some is not, and one pinned body is shared with a
// version that goes: the prediction against the outcome, as
// TestReclaimablePredictsExactlyWhatAPurgeThenFrees does without pins.
func TestReclaimableAgreesWithPurgeWhenPinsHold(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	// Ordinary history nobody pinned.
	h.agedNote(t, "plain.md", "plain one")
	h.agedNote(t, "plain.md", "plain two")
	// History an agent displaced.
	h.agedNote(t, "pinned.md", "pinned one")
	pinned := h.agedNote(t, "pinned.md", "pinned two")
	if _, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "pinned.md", pinned.UID, "pinned three"))); err != nil {
		t.Fatal(err)
	}
	// And an agent's delete and move, whose sources are pinned too.
	gone := h.agedNote(t, "deleted.md", "deleted by the agent")
	away := h.agedNote(t, "away.md", "moved by the agent")
	del := OpEntry{Entry: Entry{Path: "deleted.md", Deleted: true, MTime: 1, Device: a.label}, Base: gone.UID}
	mv := h.change(t, a, "arrived.md", 0, "moved by the agent")
	mv.Entry.Prev, mv.PrevBase = "away.md", away.UID
	if _, err := h.CommitOperation(h.op(a, "delete and move", del, mv)); err != nil {
		t.Fatal(err)
	}

	predicted, err := h.Reclaimable("v1", chunks.DefaultGrace)
	if err != nil || !predicted.Complete {
		t.Fatalf("reclaimable: %+v %v", predicted, err)
	}
	// plain one and pinned one are ordinary history, and go. Pinned two and
	// the deleted note's content survive only by their pins. The moved note's
	// source is pinned too, and survives without it: it is still the newest
	// row of its own path, which purge keeps as it always has, so it is not
	// counted as kept by a pin.
	if predicted.Versions != 2 || predicted.Pinned != 2 || predicted.Bodies != 2 {
		t.Fatalf("predicted %+v, want 2 versions and their 2 bodies to go and 2 kept by pins", predicted)
	}
	rep, err := h.Purge("v1", chunks.DefaultGrace)
	if err != nil {
		t.Fatal(err)
	}
	if rep.VersionsRemoved != predicted.Versions || rep.VersionsPinned != predicted.Pinned ||
		rep.ChunksDeleted != predicted.Bodies || rep.BytesDeleted != predicted.Bytes {
		t.Fatalf("predicted %+v, purge did %+v", predicted, rep)
	}
	for uid, want := range map[int64]string{pinned.UID: "pinned two", gone.UID: "deleted by the agent", away.UID: "moved by the agent"} {
		if got := h.bytesOf(t, h.Store, uid); got != want {
			t.Fatalf("uid %d reads %q, want %q", uid, got, want)
		}
	}
	// The deleted note is still listed as restorable from the pinned version.
	dels, _, err := h.Deleted("v1", true, 0, 0)
	if err != nil || len(dels) != 1 || dels[0].Path != "deleted.md" || dels[0].RestorableUID != gone.UID {
		t.Fatalf("deleted list %+v %v", dels, err)
	}
	if v, err := h.Verify(true); err != nil || len(v.Faults) != 0 {
		t.Fatalf("verify after the purge: %+v %v", v.Faults, err)
	}
}

// PKV Sync's second bug shape (plan/research/README.md section 5): an
// operation that stored its bodies and was then refused as stale leaves bodies
// nothing references, and a later purge reclaims them rather than keeping them
// for ever.
func TestARefusedOperationsBodiesAreReclaimed(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "v1")
	h.file(t, "note.md", "v2 from a device")
	op := h.op(a, "late edit", h.change(t, a, "note.md", note.UID, "an edit that lost"))
	if _, err := h.CommitOperation(op); !errors.Is(err, ErrStale) {
		t.Fatalf("got %v, want stale", err)
	}
	rep, err := h.Purge("v1", 0)
	if err != nil {
		t.Fatal(err)
	}
	orphan := op.Entries[0].Entry.Chunks[0]
	if h.Chunks().Has("v1", orphan) {
		t.Fatalf("the refused operation's body survived a purge: %+v", rep)
	}
}

// Replies and keys go at their window's end, in the purge after it, and the
// operation stays; a replay after that is a new request.
func TestAPurgeLetsExpiredRepliesAndKeysGo(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	t0 := time.Now()
	clock := t0
	h.SetClock(func() time.Time { return clock })
	op := h.op(a, "create", h.change(t, a, "a.md", 0, "a"))
	op.IdempotencyKey = "k"
	res, err := h.CommitOperation(op)
	if err != nil {
		t.Fatal(err)
	}
	if rep, err := h.Purge("v1", chunks.DefaultGrace); err != nil || rep.RepliesExpired != 0 || rep.KeysExpired != 0 {
		t.Fatalf("a purge inside the window: %+v %v", rep, err)
	}
	clock = t0.Add(DefaultRetention.ResultFor)
	rep, err := h.Purge("v1", chunks.DefaultGrace)
	if err != nil || rep.RepliesExpired != 1 || rep.KeysExpired != 1 {
		t.Fatalf("a purge after the window: %+v %v", rep, err)
	}
	rec, ok, err := h.LookupOperation("v1", res.OpID)
	if err != nil || !ok || rec.Result != nil {
		t.Fatalf("the operation after its reply went: %+v ok=%v err=%v", rec, ok, err)
	}
	if f := h.footprint(t); f.ops != 1 || f.keys != 0 {
		t.Fatalf("footprint %+v", f)
	}
}

/* ---------------------------------------------------------------- *
 * Replays across a restore
 * ---------------------------------------------------------------- */

// A restore starts a new epoch (PLAN.md section 2.8), and a key recorded
// before it does not replay after it: the reply names uids of the history
// before the restore, which the restored store will issue again to other
// versions. The operation itself is still on record.
func TestAKeyFromBeforeARestoreIsNotReplayed(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	op := h.op(a, "create", h.change(t, a, "a.md", 0, "a"))
	op.IdempotencyKey = "k"
	res, err := h.CommitOperation(op)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, false); err != nil {
		t.Fatal(err)
	}
	restored := &harness{Store: openBackup(t, dir), dir: dir}

	_, found, err := restored.Replay("v1", a.id, "k", op.RequestDigest)
	if found || !errors.Is(err, ErrReplayFromEarlierEpoch) || !errors.Is(err, ErrRefused) {
		t.Fatalf("Replay across the restore: found=%v err=%v", found, err)
	}
	retry := op
	retry.Epoch = restored.Epoch()
	before := restored.footprint(t)
	_, err = restored.CommitOperation(retry)
	restored.refusedWith(t, err, OpCodeStale, before)
	if !errors.Is(err, ErrReplayFromEarlierEpoch) {
		t.Fatalf("refused, but not for the epoch: %v", err)
	}
	rec, ok, err := restored.LookupOperation("v1", res.OpID)
	if err != nil || !ok || rec.Epoch != h.Epoch() {
		t.Fatalf("the operation across the restore: %+v ok=%v err=%v", rec, ok, err)
	}
	// And the source, still in its own epoch, replays it as ever.
	if got, found, err := h.Replay("v1", a.id, "k", op.RequestDigest); err != nil || !found || got.OpID != res.OpID {
		t.Fatalf("the source's replay: %+v found=%v err=%v", got, found, err)
	}
}

// Verify decodes the log, on every pass: an unexpired pin whose version is
// gone is the fault that matters, and a damaged row is named by its operation.
func TestVerifyReportsALostPinAndABadOperation(t *testing.T) {
	h := newTestStore(t)
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "before")
	res, err := h.CommitOperation(h.op(a, "edit", h.change(t, a, "note.md", note.UID, "after")))
	if err != nil {
		t.Fatal(err)
	}
	clean, err := h.Verify(false)
	if err != nil || len(clean.Faults) != 0 || clean.Operations != 1 {
		t.Fatalf("a sound log: %+v %v", clean, err)
	}

	if err := h.ExecForTest(`DELETE FROM entries WHERE vault_id = 'v1' AND uid = ?`, note.UID); err != nil {
		t.Fatal(err)
	}
	if err := h.ExecForTest(`UPDATE operations SET request_digest = 'nope' WHERE id = ?`, res.OpID); err != nil {
		t.Fatal(err)
	}
	got, err := h.Verify(false)
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]bool{}
	for _, f := range got.Faults {
		reasons[f.Reason] = true
		if !strings.Contains(f.Row, res.OpID) {
			t.Fatalf("a fault does not name its operation: %v", f)
		}
	}
	if !reasons["lostpin"] || !reasons["badop"] {
		t.Fatalf("faults %v", got.Faults)
	}
}
