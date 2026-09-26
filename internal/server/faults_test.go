package server

import (
	"fmt"
	"os"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

/* ---------------------------------------------------------------- *
 * Faults beyond SIGKILL (PLAN.md M5.5)
 * ---------------------------------------------------------------- */

// Each of these is a disk or a network misbehaving in a way a SIGKILL does
// not model, injected deterministically, with the two things M5.5 asks of
// each: the fault produces a status someone can act on, and nothing
// acknowledged is lost; and the recovery path, run, gives back exactly the
// bytes that went in.

// putOnce sends one put of body at path against base and returns the reply
// frame after the body, whatever it is: an ack (`have` when the server held
// every body already), or a refusal.
func putOnce(t *testing.T, cl *client, id, base int64, path, body string) map[string]any {
	t.Helper()
	names, size := chunkNames([]string{body})
	cl.sendJSON(wire.In{Op: "put", ID: id, Path: path, Chunks: names, Base: base,
		Meta: wire.PutMeta{Size: size, MTime: 1}})
	m := cl.recv()
	if m["res"] == "want" {
		cl.sendBinary([]byte(body))
		m = cl.recv()
	}
	return m
}

// acked is whether a put's reply says it committed.
func acked(m map[string]any) bool { return m["res"] == "ack" || m["res"] == "have" }

// readBack is the newest version of path and its bytes, as a device that
// fetches it gets them.
func readBack(t *testing.T, r *rig, cl *client, path string) (int64, string) {
	t.Helper()
	e, state, _, err := r.st.EntryAsOf(testVault, path, 0)
	if err != nil || state != store.PathLive {
		t.Fatalf("%s is %s (%v)", path, state, err)
	}
	var got string
	for _, b := range cl.fetch(e.Chunks...) {
		got += string(b)
	}
	return e.UID, got
}

// A disk that fills while a body is being stored: the put is refused as
// `nospace`, retryable, and the session ends with it, since the exchange it
// was in cannot go on; nothing is committed and nothing acknowledged. Once
// there is room the device reconnects and the same put commits, and the bytes
// read back are the bytes that went in.
func TestADiskFullWhileStoringABodyIsNospaceAndCommitsNothing(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	r.st.Chunks().FaultForTest(&chunks.Fault{Write: func(*os.File, []byte) error {
		return fmt.Errorf("writing a body: %w", syscall.ENOSPC)
	}})
	m := putOnce(t, cl, 3, 0, "note.md", "the words that did not fit")
	if m["res"] != "err" || m["code"] != wire.CodeNoSpace || m["retryable"] != true {
		t.Fatalf("a put onto a full disk was answered %v", m)
	}
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("a put onto a full disk committed %d versions", st.Versions)
	}
	r.st.Chunks().FaultForTest(nil)
	cl = r.dial("a")
	cl.hello(0)
	if m := putOnce(t, cl, 4, 0, "note.md", "the words that did not fit"); !acked(m) {
		t.Fatalf("the retry once there was room: %v", m)
	}
	if _, got := readBack(t, r, cl, "note.md"); got != "the words that did not fit" {
		t.Fatalf("the note reads %q", got)
	}
	if r.mustVerify() == 0 {
		t.Fatal("verify checked nothing")
	}
}

// A directory fsync that fails: the body's name is not durable, so the put is
// refused, retryable, with the session, and never acknowledged; the body the
// store cannot vouch for reads as absent, so the retry on the next connection
// sends it again. Nothing already acknowledged changes.
func TestAFailedDirectoryFsyncIsNeverAcknowledged(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	if m := putOnce(t, cl, 2, 0, "kept.md", "acknowledged before the fault"); !acked(m) {
		t.Fatalf("the first put: %v", m)
	}
	var failing atomic.Bool
	failing.Store(true)
	r.st.Chunks().FaultForTest(&chunks.Fault{Sync: func(string) error {
		if failing.Load() {
			return fmt.Errorf("fsync: %w", syscall.EIO)
		}
		return nil
	}})
	m := putOnce(t, cl, 3, 0, "note.md", "a body whose directory would not flush")
	if m["res"] != "err" || m["retryable"] != true {
		t.Fatalf("a put whose fsync failed was answered %v", m)
	}
	if st := r.mustStats(); st.Versions != 1 {
		t.Fatalf("after the failed fsync the vault holds %d versions, and one was acknowledged", st.Versions)
	}
	failing.Store(false)
	cl = r.dial("a")
	cl.hello(0)
	if m := putOnce(t, cl, 4, 0, "note.md", "a body whose directory would not flush"); m["res"] != "ack" {
		t.Fatalf("the retry once fsync worked: %v", m)
	}
	for path, want := range map[string]string{
		"kept.md": "acknowledged before the fault", "note.md": "a body whose directory would not flush",
	} {
		if _, got := readBack(t, r, cl, path); got != want {
			t.Fatalf("%s reads %q", path, got)
		}
	}
}

// fullError is SQLite's SQLITE_FULL as the driver reports it: a database that
// cannot grow. (A real one, from a database at its page limit, is
// internal/store's TestADatabaseThatCannotGrowCommitsNothing.)
type fullError struct{}

func (fullError) Error() string { return "database or disk is full (13)" }
func (fullError) Code() int     { return 13 }

// A database that cannot grow refuses the put as `nospace` rather than
// `internal`, so the device says the server's disk is full, the commit is
// counted as failed where doctor reads it, and nothing is committed.
func TestADatabaseThatCannotGrowIsNospaceAndCounted(t *testing.T) {
	r := newRig(t)
	var full atomic.Bool
	full.Store(true)
	r.srv.beforeAppend = func(store.Entry) error {
		if full.Load() {
			return fmt.Errorf("committing: %w", fullError{})
		}
		return nil
	}
	cl := r.dial("a")
	cl.hello(0)
	m := putOnce(t, cl, 3, 0, "note.md", "no room in the database")
	if m["res"] != "err" || m["code"] != wire.CodeNoSpace || m["retryable"] != true {
		t.Fatalf("a put into a full database was answered %v", m)
	}
	if got := r.srv.Snapshot(); got.CommitFailures != 1 || got.ConsecutiveCommitFailures != 1 {
		t.Fatalf("the metrics say %+v", got)
	}
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("a put into a full database committed %d versions", st.Versions)
	}
	full.Store(false)
	if m := putOnce(t, cl, 4, 0, "note.md", "no room in the database"); !acked(m) {
		t.Fatalf("the retry: %v", m)
	}
	if got := r.srv.Snapshot(); got.ConsecutiveCommitFailures != 0 || got.Commits != 1 {
		t.Fatalf("after the retry the metrics say %+v", got)
	}
}

// A peer too slow to read what it is sent is dropped, so it cannot hold the
// server's memory or the others' fan-out, and is counted; the others go on
// receiving; and the slow one, reconnecting from the cursor it had, catches up
// with every version committed meanwhile, nothing skipped.
func TestASlowPeerIsDroppedCountedAndCatchesUp(t *testing.T) {
	r := newRig(t)
	slow := r.dial("slow")
	slow.hello(0)
	fast := r.dial("fast")
	fast.hello(0)
	var peer *Session
	r.srv.hub.mu.RLock()
	for s := range r.srv.hub.byVault[testVault] {
		if s.device == "slow" {
			peer = s
		}
	}
	r.srv.hub.mu.RUnlock()
	if peer == nil {
		t.Fatal("no session for the slow peer")
	}

	// Frames of about four megabytes each, which the slow peer never reads:
	// three are more than SendQueueBytes.
	names := make([]string, 60_000)
	for i := range names {
		names[i] = chunks.Name([]byte(fmt.Sprint(i)))
	}
	for i := 0; i < 3; i++ {
		peer.deliver(store.Entry{UID: int64(1000 + i), Path: "big.md", Size: 1, MTime: 1, Chunks: names}, false)
	}
	select {
	case <-peer.dead:
	case <-time.After(5 * time.Second):
		t.Fatal("a peer that read nothing was not dropped")
	}
	if got := r.srv.Snapshot().EvictedPeers; got != 1 {
		t.Fatalf("%d slow peers counted", got)
	}

	// The others are served as before.
	for i := 0; i < 3; i++ {
		if m := putOnce(t, fast, int64(10+i), 0, fmt.Sprintf("n%d.md", i), fmt.Sprintf("written while it was gone %d", i)); !acked(m) {
			t.Fatalf("a put after the drop: %v", m)
		}
	}

	back := r.dial("slow")
	_, got := back.hello(0)
	if len(got) != 3 {
		t.Fatalf("the slow peer caught up with %d versions, and 3 were committed", len(got))
	}
	for i := 0; i < 3; i++ {
		if _, text := readBack(t, r, back, fmt.Sprintf("n%d.md", i)); text != fmt.Sprintf("written while it was gone %d", i) {
			t.Fatalf("n%d.md reads %q", i, text)
		}
	}
}

// A reply lost after its commit: the device never hears its put was
// acknowledged. The version is committed once, and only once: the device's
// retry against the base it had is refused as stale, naming the version its
// own write made, and its next connection's catch-up carries that version with
// the bytes it sent, which is how the engine learns the write landed.
func TestAReplyLostAfterItsCommitIsOneVersionAndAStaleRetry(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	names, size := chunkNames([]string{"the reply to this was lost"})
	cl.sendJSON(wire.In{Op: "put", ID: 3, Path: "note.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 1}})
	cl.recvInto("want", &wire.Want{})
	cl.sendBinary([]byte("the reply to this was lost"))
	// The ack is never read: the connection is gone as far as the device
	// knows.
	waitFor(t, "the commit", func() bool { return r.mustStats().Versions == 1 })
	cl.conn.CloseNow()

	again := r.dial("a")
	_, got := again.hello(0)
	if len(got) != 1 || got[0].Path != "note.md" {
		t.Fatalf("the reconnecting device's catch-up holds %+v", got)
	}
	m := putOnce(t, again, 4, 0, "note.md", "the reply to this was lost")
	if m["res"] != "err" || m["code"] != wire.CodeStale {
		t.Fatalf("the blind retry was answered %v", m)
	}
	if st := r.mustStats(); st.Versions != 1 {
		t.Fatalf("the lost reply and its retry made %d versions", st.Versions)
	}
	if uid, text := readBack(t, r, again, "note.md"); uid != got[0].UID || text != "the reply to this was lost" {
		t.Fatalf("the note is uid %d reading %q", uid, text)
	}
}
