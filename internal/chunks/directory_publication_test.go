package chunks

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/waynehoover/trewsync/internal/fsync"
)

func TestRetryFlushesFailedDirectoryPublication(t *testing.T) {
	for _, failAt := range []string{"root", "vault"} {
		for _, batched := range []bool{false, true} {
			name := failAt + "-put"
			if batched {
				name = failAt + "-writer"
			}
			t.Run(name, func(t *testing.T) {
				st := newTestStore(t)
				body := []byte("the first chunk while a directory flush fails")
				hash := Name(body)
				target := st.dir
				if failAt == "vault" {
					target = st.VaultDir("v1")
				}
				realSync := st.sync
				boom := errors.New("injected fsync failure")
				var mu sync.Mutex
				failed := false
				published := false
				st.sync = func(dir string) error {
					mu.Lock()
					defer mu.Unlock()
					if dir == target && !failed {
						failed = true
						return boom
					}
					err := realSync(dir)
					if dir == target && err == nil {
						published = true
					}
					return err
				}
				put := func() error {
					if !batched {
						return st.Put("v1", hash, body)
					}
					w := st.NewWriter("v1")
					if err := w.Add(hash, body); err != nil {
						_ = w.Close()
						return err
					}
					return w.Close()
				}
				if err := put(); !errors.Is(err, boom) {
					t.Fatalf("first put got %v", err)
				}
				if err := put(); err != nil {
					t.Fatalf("retry got %v", err)
				}
				mu.Lock()
				durable := published
				mu.Unlock()
				if !durable {
					t.Fatalf("retry acknowledged body (Has=%v) without ever successfully flushing its %s directory publication", st.Has("v1", hash), failAt)
				}
			})
		}
	}
}

func TestWritableReopenFlushesExistingDirectoriesBeforeReportingBodiesHeld(t *testing.T) {
	st := newTestStore(t)
	body := []byte("already fsynced file in an unflushed directory")
	name := Name(body)
	leaf := filepath.Dir(st.path("v1", name))
	if err := st.mkdirAll(leaf); err != nil {
		t.Fatal(err)
	}
	realSync := st.sync
	boom := errors.New("leaf flush failed after publishing the file")
	st.sync = func(dir string) error {
		if dir == leaf {
			return boom
		}
		return realSync(dir)
	}
	if err := st.Put("v1", name, body); !errors.Is(err, boom) {
		t.Fatalf("first put: %v", err)
	}
	if st.Has("v1", name) {
		t.Fatal("failed publication already looks durable")
	}

	flushed := map[string]bool{}
	reopened, err := openWithSync(st.dir, st.max, true, func(dir string) error {
		err := fsync.Dir(dir)
		if err == nil {
			flushed[dir] = true
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Dir(st.dir), st.dir, st.VaultDir("v1"), leaf} {
		if !flushed[dir] {
			t.Errorf("reopen trusted existing names without flushing %s", dir)
		}
	}
	if !reopened.Has("v1", name) {
		t.Fatal("reopen did not make the existing body available")
	}
	got, err := reopened.Get("v1", name)
	if err != nil || string(got) != string(body) {
		t.Fatalf("wrong recovered body: %q err=%v", got, err)
	}
	// Startup proved the existing directory names. The next write into the
	// same leaf only needs the normal flush after publishing its own body.
	next := append([]byte(nil), body...)
	for Name(next) == name || Name(next)[:2] != name[:2] {
		next = append(next, 'x')
	}
	flushed = map[string]bool{}
	if err := reopened.Put("v1", Name(next), next); err != nil {
		t.Fatal(err)
	}
	if len(flushed) != 1 || !flushed[leaf] {
		t.Fatalf("steady-state write needlessly reflushed ancestors: %v", flushed)
	}
}

func TestWritableOpenRefusesUntilEveryDirectoryFlushSucceeds(t *testing.T) {
	st := newTestStore(t)
	body := []byte("a stored chunk")
	name := Name(body)
	if err := st.Put("v1", name, body); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{filepath.Dir(st.dir), st.dir, st.VaultDir("v1"), filepath.Dir(st.path("v1", name))} {
		t.Run(filepath.Base(target), func(t *testing.T) {
			boom := errors.New("startup flush failed")
			for range 2 {
				reopened, err := openWithSync(st.dir, st.max, true, func(dir string) error {
					if dir == target {
						return boom
					}
					return fsync.Dir(dir)
				})
				if !errors.Is(err, boom) || reopened != nil {
					t.Fatalf("startup accepted an unflushed directory: store=%v err=%v", reopened, err)
				}
			}
			reopened, err := New(st.dir, st.max)
			if err != nil || !reopened.Has("v1", name) {
				t.Fatalf("startup did not recover after the fault cleared: %v", err)
			}
		})
	}
}

func TestInspectionOpenDoesNotFlushDirectories(t *testing.T) {
	st := newTestStore(t)
	calls := 0
	if _, err := openWithSync(st.dir, st.max, false, func(string) error { calls++; return errors.New("must not write") }); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("inspection flushed %d directories", calls)
	}
}
