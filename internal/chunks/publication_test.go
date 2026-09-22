package chunks

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

/*
 * Publication: visible is not durable, and nothing waits to find out (R05/R06).
 *
 * A body becomes visible when it is renamed into its directory and durable when
 * that directory is flushed, and those are two different moments. F05 closed the
 * window by making the second writer of a name wait for the first, which worked
 * and cost more than it bought: a batch held every claim until Close, so two
 * batches wanting the same two chunks in opposite orders each held one and
 * waited for the other for ever.
 *
 * The window is closed by withholding presence instead. A name being published
 * reads as absent, so no negotiation offers it and no commit is admitted on it,
 * and nobody has to block for that to be true.
 */

func bodyN(n int) []byte {
	return []byte(fmt.Sprintf("body number %d, long enough to be a body", n))
}

func newStore(t *testing.T) *Store {
	t.Helper()
	st, err := New(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

/*
 * Two batches, the same two chunks, opposite orders.
 *
 * The exact schedule the review reproduced. With one worker each the order is
 * deterministic: A places X and B places Y, then A wants Y and B wants X. Under
 * the claim-and-hold design both Close calls blocked for ever and the test had
 * to reach into the store to free them.
 */
func TestOverlappingBatchesInOppositeOrdersBothFinish(t *testing.T) {
	st := newStore(t)
	x, y := bodyN(1), bodyN(2)
	nx, ny := Name(x), Name(y)

	// One worker each, so "A has placed X and not yet Y" is a state the
	// schedule actually passes through rather than one it might.
	a := st.newWriterWidth("v", 1)
	b := st.newWriterWidth("v", 1)

	if err := a.Add(nx, x); err != nil {
		t.Fatal(err)
	}
	if err := b.Add(ny, y); err != nil {
		t.Fatal(err)
	}
	// Both bodies are placed by now or will be; either way the claims that
	// used to deadlock are taken before the crossed adds below.
	if err := a.Add(ny, y); err != nil {
		t.Fatal(err)
	}
	if err := b.Add(nx, x); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 2)
	go func() { done <- a.Close() }()
	go func() { done <- b.Close() }()

	for i := 0; i < 2; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("a batch failed: %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("a batch never finished: two batches wanting the same chunks in " +
				"opposite orders are waiting for each other")
		}
	}

	for _, n := range []string{nx, ny} {
		if !st.Has("v", n) {
			t.Errorf("%s is not held after both batches closed", n)
		}
	}
}

// The same, wider: many batches over an overlapping pool, which is what a first
// sync from two devices at once looks like.
func TestManyOverlappingBatchesAllFinish(t *testing.T) {
	st := newStore(t)
	const bodies = 8
	names := make([]string, bodies)
	blobs := make([][]byte, bodies)
	for i := range names {
		blobs[i] = bodyN(i)
		names[i] = Name(blobs[i])
	}

	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for b := 0; b < 6; b++ {
		wg.Add(1)
		go func(b int) {
			defer wg.Done()
			w := st.newWriterWidth("v", 2)
			// Each batch walks the pool from a different offset, so their
			// orders cross in every direction.
			for i := 0; i < bodies; i++ {
				j := (i + b*3) % bodies
				if err := w.Add(names[j], blobs[j]); err != nil {
					errs <- err
					return
				}
			}
			errs <- w.Close()
		}(b)
	}

	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(30 * time.Second):
		t.Fatal("overlapping batches did not all finish")
	}
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a batch failed: %v", err)
		}
	}
	for _, n := range names {
		if !st.Has("v", n) {
			t.Errorf("%s is not held", n)
		}
	}
}

/*
 * A body another batch has placed and not flushed is not held.
 *
 * This is what a second session asks before deciding whether to upload, and
 * what the entry commit asks before admitting a reference. Answering from the
 * stat let a commit be admitted against a body whose name was not durable: the
 * one server-side fault a client cannot detect, because it was told the chunk
 * arrived and will never send it again.
 */
func TestABodyPlacedButNotFlushedIsNotHeld(t *testing.T) {
	st := newStore(t)
	body := bodyN(7)
	name := Name(body)

	// Hold the batch open between the rename and the flush, which is exactly
	// the window under test. Only that flush: mkdirAll flushes the directories
	// on the way down as it creates them, and those happen before the body
	// exists, so pausing on the first flush would pause before there is
	// anything to look at.
	flushed := make(chan struct{})
	release := make(chan struct{})
	realSync := st.sync
	var once sync.Once
	st.sync = func(dir string) error {
		if _, err := os.Stat(st.path("v", name)); err == nil {
			once.Do(func() { close(flushed) })
			<-release
		}
		return realSync(dir)
	}

	w := st.newWriterWidth("v", 1)
	if err := w.Add(name, body); err != nil {
		t.Fatal(err)
	}
	closed := make(chan error, 1)
	go func() { closed <- w.Close() }()
	<-flushed

	// The file is on the disk...
	if _, err := os.Stat(st.path("v", name)); err != nil {
		t.Fatalf("the body is not even visible, so this proves nothing: %v", err)
	}
	// ...and must not be reported as held, to anyone.
	if st.Has("v", name) {
		t.Error("a body renamed into place and not yet flushed reported as held")
	}
	if _, ok := st.Size("v", name); ok {
		t.Error("Size answered for a body that is not durable yet")
	}
	missing, _, err := st.Missing("v", []string{name})
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 1 {
		t.Error("Missing left out a body that is not durable yet, so a client would not send it")
	}

	close(release)
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	// And afterwards it is held, or the withholding never lifts.
	if !st.Has("v", name) {
		t.Error("a flushed body is still not held")
	}
}

/*
 * A publication whose flush failed stays unheld, and the retry really writes.
 *
 * The old code short-circuited on a stat, so the retry found the body visible,
 * wrote nothing, flushed nothing and returned success: the name was never made
 * durable and nothing would ever try again.
 */
func TestAFailedFlushLeavesTheBodyUnheldAndTheRetryFlushes(t *testing.T) {
	st := newStore(t)
	body := bodyN(11)
	name := Name(body)

	// The directory exists first, so the injected failure lands on the flush
	// after the body is published rather than on directory creation.
	if err := st.mkdirAll(st.path("v", name)[:len(st.path("v", name))-len(name)-1]); err != nil {
		t.Fatal(err)
	}

	var flushes int
	boom := errors.New("the disk said no")
	realSync := st.sync
	failNext := true
	st.sync = func(dir string) error {
		flushes++
		if failNext {
			failNext = false
			return boom
		}
		return realSync(dir)
	}

	if err := st.Put("v", name, body); !errors.Is(err, boom) {
		t.Fatalf("the first put reported %v, wanted the flush failure", err)
	}
	if st.Has("v", name) {
		t.Fatal("a body whose flush failed is reported as held, so nothing will ever send it again")
	}

	after := flushes
	if err := st.Put("v", name, body); err != nil {
		t.Fatalf("the retry failed: %v", err)
	}
	if flushes == after {
		t.Error("the retry returned success without flushing anything")
	}
	if !st.Has("v", name) {
		t.Error("the body is still not held after a successful retry")
	}
}

// Presence never outlives the disk. The map withholds and must not assert: a
// name marked proven whose file is gone is still absent.
func TestTheDiskIsStillTheAuthorityOnPresence(t *testing.T) {
	st := newStore(t)
	body := bodyN(13)
	name := Name(body)
	if err := st.Put("v", name, body); err != nil {
		t.Fatal(err)
	}
	if !st.Has("v", name) {
		t.Fatal("the body was not stored, so this proves nothing")
	}
	if err := os.Remove(st.path("v", name)); err != nil {
		t.Fatal(err)
	}
	if st.Has("v", name) {
		t.Error("a chunk the disk has lost is still reported as held")
	}
}
