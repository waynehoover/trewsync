package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/store"
)

/*
 * A health check that can tell "the process answered" from "your notes are
 * safe" (I17).
 *
 * /health used to write "ok" from a handler that touched nothing. A full disk,
 * a database gone read-only and a chunk directory whose volume had unmounted
 * were all indistinguishable from a healthy server, for as long as nobody tried
 * to save anything, and every monitor pointed at it said everything was fine
 * while notes were being refused. That is rule 7 one layer out: a status must
 * distinguish the cases it collapses.
 */

func healthOf(t *testing.T, r *rig) (int, string) {
	t.Helper()
	hs := httptest.NewServer(HTTPHandler(r.srv, testLogger()))
	t.Cleanup(hs.Close)
	res, err := http.Get(hs.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("reading /health: %v", err)
	}
	return res.StatusCode, strings.TrimSpace(string(body))
}

func TestHealthIsOKOnAStoreThatWorks(t *testing.T) {
	r := newRig(t)
	code, body := healthOf(t, r)
	if code != http.StatusOK || body != "ok" {
		t.Fatalf("a working server answered %d %q", code, body)
	}
}

// The case the old handler could not see. The database is closed under it,
// which is what a store that has stopped answering looks like from here, and
// the handler has to notice rather than reporting the process.
func TestHealthRefusesWhenTheStoreCannotAnswer(t *testing.T) {
	r := newRig(t)
	if err := r.st.Close(); err != nil {
		t.Fatalf("closing the store: %v", err)
	}

	code, body := healthOf(t, r)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("a server whose store is gone answered %d %q, wanted 503", code, body)
	}
	if body != string(store.HealthUnreadable) {
		t.Fatalf("the reason was %q, wanted %q", body, store.HealthUnreadable)
	}
}

// A volume that unmounted. SQLite keeps its handle and goes on answering, so
// this is the failure that a database check alone reports as healthy: entries
// commit and every body they name is unwritable.
func TestHealthRefusesWhenTheBodyDirectoryIsGone(t *testing.T) {
	r := newRig(t)
	if err := os.RemoveAll(r.st.Chunks().Root()); err != nil {
		t.Fatalf("removing the chunk directory: %v", err)
	}

	code, body := healthOf(t, r)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("a server with no chunk directory answered %d %q, wanted 503", code, body)
	}
	if body != string(store.HealthNoChunkDir) {
		t.Fatalf("the reason was %q, wanted %q", body, store.HealthNoChunkDir)
	}
	// And the database is still perfectly readable, which is the point: a
	// check that only asked SQLite would have said "ok" here.
	if h := r.st.CheckHealth(context.Background()); h.Why != store.HealthNoChunkDir {
		t.Fatalf("the store said %q", h.Why)
	}
}

// A restart in progress. A checker that keeps calling a draining server healthy
// is one that keeps sending devices to it, which is the whole thing a health
// check is for during a restart.
func TestHealthRefusesWhileShuttingDown(t *testing.T) {
	r := newRig(t)
	if err := r.srv.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	code, body := healthOf(t, r)
	if code != http.StatusServiceUnavailable || body != string(store.HealthClosing) {
		t.Fatalf("a draining server answered %d %q", code, body)
	}
}

// The endpoint needs no credential and behind a tunnel the port is on the
// internet. TestNoPreAuthSurfaceNamesTheServerVersion covers the build string;
// this covers everything else a health body could be tempted to carry.
func TestHealthNamesNothingAboutThisServer(t *testing.T) {
	r := newRig(t)
	// Both answers, because the failing one is where a reason gets written and
	// where an OS error string would escape if one were ever passed through.
	bodies := []string{}
	_, ok := healthOf(t, r)
	bodies = append(bodies, ok)
	if err := os.RemoveAll(r.st.Chunks().Root()); err != nil {
		t.Fatalf("removing the chunk directory: %v", err)
	}
	_, bad := healthOf(t, r)
	bodies = append(bodies, bad)

	root := r.st.Chunks().Root()
	for _, body := range bodies {
		for what, secret := range map[string]string{
			"the vault name":       testVault,
			"a path":               root,
			"the parent directory": filepath.Dir(root),
			"a device's token":     deviceKey("a"),
		} {
			if secret != "" && strings.Contains(body, secret) {
				t.Errorf("/health said %q, which names %s", body, what)
			}
		}
		// A fixed vocabulary, so a monitor can match it and so nothing that is
		// not in the list can reach the wire.
		switch store.HealthReason(body) {
		case store.HealthOK, store.HealthUnreadable, store.HealthNoSpace,
			store.HealthNoChunkDir, store.HealthClosing:
		default:
			if body != "ok" {
				t.Errorf("/health said %q, which is not one of the reasons", body)
			}
		}
	}
}

// A flood of /health asks the store once (T62). The endpoint needs no
// credential, and every request ran the whole probe: the database's write
// lock, a statfs, and a file created, written and removed in the chunk root.
// Requests that arrive together now share one probe, and its failure is
// logged once rather than once per request.
func TestAFloodOfHealthChecksProbesTheStoreOnce(t *testing.T) {
	r := newRig(t)
	var logged bytes.Buffer
	hs := httptest.NewServer(HTTPHandler(r.srv, slog.New(slog.NewTextHandler(&logged, nil))))
	t.Cleanup(hs.Close)
	// A fault, so that every probe that runs says so in the log.
	if err := os.RemoveAll(r.st.Chunks().Root()); err != nil {
		t.Fatalf("removing the chunk directory: %v", err)
	}

	const flood = 16
	start := make(chan struct{})
	answers := make(chan string, flood)
	var wg sync.WaitGroup
	for range flood {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			res, err := http.Get(hs.URL + "/health")
			if err != nil {
				answers <- err.Error()
				return
			}
			defer func() { _ = res.Body.Close() }()
			body, _ := io.ReadAll(res.Body)
			answers <- res.Status + " " + strings.TrimSpace(string(body))
		}()
	}
	close(start)
	wg.Wait()
	close(answers)

	want := "503 Service Unavailable " + string(store.HealthNoChunkDir)
	for got := range answers {
		if got != want {
			t.Errorf("a request in the flood was answered %q, want %q", got, want)
		}
	}
	if probes := strings.Count(logged.String(), "health check failed"); probes != 1 {
		t.Fatalf("%d requests at once probed the store %d times, want once:\n%s", flood, probes, logged.String())
	}
}

// And a shared answer is never older than healthFresh: a fault that appears
// after one probe is what the first request after that window hears.
func TestASharedHealthAnswerExpires(t *testing.T) {
	r := newRig(t)
	hs := httptest.NewServer(HTTPHandler(r.srv, testLogger()))
	t.Cleanup(hs.Close)
	get := func() string {
		t.Helper()
		res, err := http.Get(hs.URL + "/health")
		if err != nil {
			t.Fatalf("GET /health: %v", err)
		}
		defer func() { _ = res.Body.Close() }()
		body, _ := io.ReadAll(res.Body)
		return strings.TrimSpace(string(body))
	}
	if got := get(); got != "ok" {
		t.Fatalf("a working server answered %q", got)
	}
	if err := os.RemoveAll(r.st.Chunks().Root()); err != nil {
		t.Fatalf("removing the chunk directory: %v", err)
	}
	time.Sleep(healthFresh + 100*time.Millisecond)
	if got := get(); got != string(store.HealthNoChunkDir) {
		t.Fatalf("%v after the fault /health answered %q, want %q", healthFresh, got, store.HealthNoChunkDir)
	}
}

// The free-space threshold, checked as arithmetic rather than by filling a
// disk. What it must not be is zero: SQLite needs room for its journal before
// it can commit, so a store with nothing left has already failed and a report
// then is a post-mortem.
func TestALowSpaceThresholdLeavesRoomToActOn(t *testing.T) {
	if store.LowSpaceBytes() <= 0 {
		t.Fatal("a threshold of zero reports a full disk only once it is too late")
	}
	h := store.Health{}
	if h.CanPersist {
		t.Fatal("the zero Health reads as healthy, so a check that never ran looks like a pass")
	}
}
