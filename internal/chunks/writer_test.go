package chunks

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A batch is worth having only if it stores exactly what one-at-a-time storing
// did. Everything the single-chunk path guarantees is asserted again here,
// because the whole reason the batch exists is speed, and speed is the usual
// way a durability rule gets quietly dropped.

func TestABatchStoresEveryBodyItWasGiven(t *testing.T) {
	s := newTestStore(t)
	w := s.NewWriter("v1")

	bodies := make(map[string][]byte)
	for i := 0; i < 200; i++ {
		body := []byte(fmt.Sprintf("body number %d, distinct from the others", i))
		name := Name(body)
		bodies[name] = body
		if err := w.Add(name, body); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	for name, want := range bodies {
		if !s.Has("v1", name) {
			t.Fatalf("%s is not present after Close said the batch was durable", name)
		}
		got, err := s.Get("v1", name)
		if err != nil {
			t.Fatalf("get %s: %v", name, err)
		}
		if string(got) != string(want) {
			t.Fatalf("%s came back as %q, want %q", name, got, want)
		}
	}
}

// The name is a hash of the body, so a claim that does not match is either a
// broken client or a corrupted one. Storing it under either name corrupts the
// vault, and the batch must refuse it exactly as Put does.
func TestABatchRefusesABodyThatDoesNotMatchItsName(t *testing.T) {
	s := newTestStore(t)
	w := s.NewWriter("v1")

	honest := []byte("what it says it is")
	name := Name(honest)
	if err := w.Add(name, []byte("something else entirely")); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err = %v, want ErrCorrupt", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if s.Has("v1", name) {
		t.Fatal("a body that did not match its name was stored anyway")
	}
}

func TestABatchRefusesABadNameAndAnOversizedBody(t *testing.T) {
	s := newTestStore(t)
	w := s.NewWriter("v1")

	if err := w.Add("not-a-chunk-name", []byte("x")); !errors.Is(err, ErrBadName) {
		t.Fatalf("err = %v, want ErrBadName", err)
	}
	big := make([]byte, ChunkMaxForTest+1)
	if err := w.Add(Name(big), big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// A batch that could not write must say so, because the caller is about to
// acknowledge everything in it. Reporting the failure from Add would only
// catch it if another body followed, and the last body in a batch has none.
func TestCloseReportsAFailureNoAddWouldHaveShown(t *testing.T) {
	s := newTestStore(t)
	w := s.NewWriter("v1")

	body := []byte("this cannot be written")
	name := Name(body)
	// The directory this chunk needs, occupied by a file. Every write into it
	// fails with ENOTDIR, which is not something a retry improves.
	dir := filepath.Dir(s.path("v1", name))
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if err := os.WriteFile(dir, []byte("in the way"), 0o600); err != nil {
		t.Fatalf("prepare: %v", err)
	}

	if err := w.Add(name, body); err != nil {
		// Allowed: the failure may already have been seen. What is not allowed
		// is Close saying the batch is fine.
		t.Logf("add reported it early: %v", err)
	}
	if err := w.Close(); err == nil {
		t.Fatal("Close said the batch was durable when nothing could be written")
	}
	if s.Has("v1", name) {
		t.Fatal("the chunk is present after a write that failed")
	}
}

// Every chunk becomes itself or nothing. A body left as a temp file would be
// invisible to Has, and so would be re-sent; a temp file left behind after a
// successful batch is the sweep's problem for ever.
func TestABatchLeavesNoTemporaryFilesBehind(t *testing.T) {
	s := newTestStore(t)
	w := s.NewWriter("v1")
	for i := 0; i < 50; i++ {
		body := []byte(fmt.Sprintf("body %d", i))
		if err := w.Add(Name(body), body); err != nil {
			t.Fatalf("add: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	var strays []string
	err := filepath.WalkDir(s.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasPrefix(d.Name(), tmpPrefix) {
			strays = append(strays, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(strays) > 0 {
		t.Fatalf("%d temporary files survived the batch: %v", len(strays), strays)
	}
}

// The same chunk from two files in one batch. Sixteen writers racing on one
// name is the case the single-chunk path never had, and the store's answer has
// to be one correct chunk rather than a torn one.
func TestABatchToleratesTheSameChunkTwice(t *testing.T) {
	s := newTestStore(t)
	w := s.NewWriter("v1")

	body := []byte("shared by everything")
	name := Name(body)
	for i := 0; i < 64; i++ {
		if err := w.Add(name, body); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	got, err := s.Get("v1", name)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("the chunk came back as %q", got)
	}
}

// The batch verifies on the goroutine that writes, not on the one that handed
// the body over.
//
// Add and the write happen on different goroutines, so anything that reuses a
// buffer between them would file the wrong bytes under a correct name. Nothing
// does today, and the check is what keeps that true: a chunk that fails to
// decrypt is the one fault a device cannot diagnose, because the server told it
// the chunk arrived.
func TestABatchVerifiesTheBodyItIsAboutToWrite(t *testing.T) {
	s := newTestStore(t)

	honest := []byte("the bytes this name is for")
	name := Name(honest)
	// What a reused buffer would look like from inside place: the right name,
	// the wrong bytes.
	if _, err := s.place("v1", name, []byte("something else entirely")); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err = %v, want ErrCorrupt", err)
	}
	if s.Has("v1", name) {
		t.Fatal("a body that did not match its name reached the disk")
	}

	if _, err := s.place("v1", name, honest); err != nil {
		t.Fatalf("the honest body was refused: %v", err)
	}
	got, err := s.Get("v1", name)
	if err != nil || string(got) != string(honest) {
		t.Fatalf("get = %q, %v", got, err)
	}
}

// Presence is a stat, so a body that rotted on disk still answers Has, and
// Missing therefore tells every client the server already holds it. The entry
// was acknowledged, no client will send it again, and Get fails for ever.
// Nothing in an ordinary sync heals that unless the server can admit it needs
// the chunk back.
func TestACorruptBodyStopsCountingAsHeld(t *testing.T) {
	s := newTestStore(t)
	body := []byte("what this chunk is supposed to be")
	name := Name(body)
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}

	// Rot, of the kind a disk produces and a stat cannot see.
	if err := os.WriteFile(s.path("v1", name), []byte("not that at all, but the same name"), 0o600); err != nil {
		t.Fatalf("corrupt: %v", err)
	}
	if !s.Has("v1", name) {
		t.Fatal("the premise is wrong: a corrupt body should still stat as present")
	}
	if _, err := s.Get("v1", name); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("get = %v, want ErrCorrupt", err)
	}

	if err := s.Quarantine("v1", name); err != nil {
		t.Fatalf("quarantine: %v", err)
	}

	if s.Has("v1", name) {
		t.Fatal("a quarantined body still counts as held, so no client will ever replace it")
	}
	missing, _, err := s.Missing("v1", []string{name})
	if err != nil {
		t.Fatalf("missing: %v", err)
	}
	if len(missing) != 1 || missing[0] != name {
		t.Fatalf("missing = %v, want the chunk back on the want list", missing)
	}

	// And it is set aside rather than destroyed, so somebody can see what
	// happened to it.
	if _, err := os.Stat(s.path("v1", name) + corruptSuffix); err != nil {
		t.Fatalf("the corrupt body was not kept: %v", err)
	}

	// The vault heals: a client that still holds the note sends it back.
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("re-put: %v", err)
	}
	got, err := s.Get("v1", name)
	if err != nil || string(got) != string(body) {
		t.Fatalf("get after healing = %q, %v", got, err)
	}
}

// A chunk is *visible* when it is renamed into place and *durable* when the
// directory it landed in is flushed, and those are two different moments (F05).
//
// `place` used to short-circuit on a stat, which answers from visibility. A
// second writer of the same chunk arriving in that window found it there, wrote
// nothing, flushed nothing, and returned success. The version it then committed
// referenced a chunk whose directory entry was not durable, which is the one
// server-side fault a client cannot detect: it was told the chunk arrived and
// will never send it again.
//
// These two tests once asserted that the second writer *waits*, which is how it
// was fixed and was the wrong answer: a batch held every name it had claimed
// until Close, so two batches wanting the same chunks in opposite orders each
// held one and waited for the other for ever (R05). What matters is not that
// the second writer waits, it is that when it returns nil the name is durable.
// It now gets there by doing the work rather than by queueing behind somebody
// else's, and that is what these assert.
func TestASecondPutOfTheSameChunkDoesNotInheritAnUnflushedName(t *testing.T) {
	s := newTestStore(t)
	body := []byte("the body both writers have")
	name := Name(body)

	// The first writer is held inside its directory flush, which is the exact
	// window: the body is renamed into place and its name is not yet durable.
	// The leaf directory only. `mkdirAll` flushes the directories on the way
	// down before the body is written, and holding one of those would stop the
	// story before the part that matters.
	leaf := filepath.Dir(s.path("v1", name))
	inFlush := make(chan struct{})
	release := make(chan struct{})
	realSync := s.sync
	var flushes int32
	s.sync = func(dir string) error {
		if dir == leaf && atomic.AddInt32(&flushes, 1) == 1 {
			close(inFlush)
			<-release
		}
		return realSync(dir)
	}

	first := make(chan error, 1)
	go func() { first <- s.Put("v1", name, body) }()
	<-inFlush

	// Visible, and that is the whole trap: the file is there and the name is
	// not durable, so nothing may report it as held.
	if _, err := os.Stat(s.path("v1", name)); err != nil {
		t.Fatalf("the body was not renamed into place before its flush, so this proves nothing: %v", err)
	}
	if s.Has("v1", name) {
		t.Fatal("a body that is renamed and not flushed is reported as held")
	}

	second := make(chan error, 1)
	go func() { second <- s.Put("v1", name, body) }()

	// The second put does not wait for the first. It writes and flushes the
	// name itself, and its own flush is what makes its return truthful.
	select {
	case err := <-second:
		if err != nil {
			t.Fatalf("the second put failed: %v", err)
		}
		if !s.Has("v1", name) {
			t.Fatal("a put returned nil for a chunk that is still not held")
		}
		if atomic.LoadInt32(&flushes) < 2 {
			t.Fatal("the second put returned without flushing the name itself")
		}
	case <-time.After(10 * time.Second):
		close(release)
		t.Fatal("the second put is waiting for the first, which is how two batches deadlock")
	}

	close(release)
	if err := <-first; err != nil {
		t.Fatalf("first put: %v", err)
	}
	if got, err := s.Get("v1", name); err != nil || string(got) != string(body) {
		t.Fatalf("the chunk came back as %q, %v", got, err)
	}
}

// The same window, one level up: a batch publishes on `place` and flushes at
// Close, so the gap between visible and durable is the whole of the batch.
func TestAPutDoesNotInheritABatchesUnflushedChunk(t *testing.T) {
	s := newTestStore(t)
	body := []byte("shared between a batch and a put")
	name := Name(body)

	leaf := filepath.Dir(s.path("v1", name))
	inFlush := make(chan struct{})
	release := make(chan struct{})
	realSync := s.sync
	var flushes int32
	s.sync = func(dir string) error {
		if dir == leaf && atomic.AddInt32(&flushes, 1) == 1 {
			close(inFlush)
			<-release
		}
		return realSync(dir)
	}

	w := s.NewWriter("v1")
	if err := w.Add(name, body); err != nil {
		t.Fatalf("add: %v", err)
	}
	closed := make(chan error, 1)
	go func() { closed <- w.Close() }()
	<-inFlush

	if s.Has("v1", name) {
		t.Fatal("a batch's body is reported as held before the batch has flushed it")
	}

	put := make(chan error, 1)
	go func() { put <- s.Put("v1", name, body) }()
	select {
	case err := <-put:
		if err != nil {
			t.Fatalf("the put failed: %v", err)
		}
		if !s.Has("v1", name) {
			t.Fatal("a put returned nil for a chunk that is still not held")
		}
	case <-time.After(10 * time.Second):
		close(release)
		t.Fatal("a put is waiting for a batch, which is how two of them deadlock")
	}

	close(release)
	if err := <-closed; err != nil {
		t.Fatalf("close: %v", err)
	}
}
