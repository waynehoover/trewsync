package main

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/doctor"
	"github.com/waynehoover/trew/internal/store"
)

// ephemeralStorage is a data directory on a container's own writable layer.
func ephemeralStorage(dir string) (doctor.Storage, error) {
	return doctor.Storage{Dir: dir, FSType: "overlay", MountPoint: "/", Container: true, Ephemeral: true}, nil
}

// `serve` refuses to start an empty store on storage a container replacement
// erases (the check adapted from Syncidian): a server there would take every
// note and lose them all at the next upgrade, and nothing would say so. The
// refusal names the flag that says the loss is intended, and writes no
// database; with the flag it starts.
func TestServeRefusesAnEmptyStoreOnStorageARestartErases(t *testing.T) {
	swap(t, &doctorStorage, ephemeralStorage)
	dir := filepath.Join(t.TempDir(), "data")
	out, err := trew(t, "serve", "-data", dir, "-addr", "127.0.0.1:0")
	if err == nil || !strings.Contains(err.Error(), "-allow-ephemeral") || !strings.Contains(err.Error(), "writable layer") {
		t.Fatalf("serve on ephemeral storage: %v\n%s", err, out)
	}
	dbPath, _ := store.DataDir(dir)
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("the refused start made a database (%v)", err)
	}

	// An empty store that already exists there is refused the same way:
	// that is what a store looks like after its storage was erased and the
	// server started once more.
	withStore(t, dir, func(st *store.Store) {
		if err := st.EnsureVault("default", 1); err != nil {
			t.Fatal(err)
		}
	})
	if _, err := trew(t, "serve", "-data", dir, "-addr", "127.0.0.1:0"); err == nil ||
		!strings.Contains(err.Error(), "-allow-ephemeral") {
		t.Fatalf("serve on an empty store on ephemeral storage: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	buf := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", "127.0.0.1:0", "-allow-ephemeral"}, buf)
	}()
	waitFor(t, "the server to start with -allow-ephemeral", func() bool { return strings.Contains(buf.String(), "listening on") })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("serve -allow-ephemeral: %v", err)
	}
}

// A store that already holds notes on such storage is served, since refusing
// would save nothing, and the log says on every start that it is one restart
// from gone.
func TestServeSaysAStoreOnStorageARestartErasesIsOneRestartFromGone(t *testing.T) {
	dir := seeded(t)
	swap(t, &doctorStorage, ephemeralStorage)
	stderr, restore := captureStderr(t)
	stop := serveInBackground(t, dir)
	stop()
	restore()
	if !strings.Contains(stderr.String(), "every note here is lost with it") {
		t.Fatalf("serve said nothing about the storage:\n%s", stderr.String())
	}
}

// captureStderr sends the process's standard error into the buffer it
// returns until the returned function is called: serve logs there.
func captureStderr(t *testing.T) (*safeBuffer, func()) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	buf := &safeBuffer{}
	was := os.Stderr
	os.Stderr = w
	done := make(chan struct{})
	go func() {
		defer close(done)
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			buf.Write(b[:n])
			if err != nil {
				return
			}
		}
	}()
	restored := false
	restore := func() {
		if restored {
			return
		}
		restored = true
		os.Stderr = was
		w.Close()
		<-done
	}
	t.Cleanup(restore)
	return buf, restore
}

// Every start is recorded, and a run that returns records that it stopped
// cleanly, so doctor can tell a restart loop and a killed run apart from a
// server stopped and started by its operator.
func TestServeRecordsItsStartsAndACleanStop(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 2; i++ {
		stop := serveInBackground(t, dir)
		var rec doctor.RuntimeRecord
		if _, err := doctor.ReadRecord(dir, doctor.RuntimeRecordFile, &rec); err != nil {
			t.Fatal(err)
		}
		if len(rec.Starts) != i+1 || rec.CleanStop || rec.PID != os.Getpid() {
			t.Fatalf("while serving, start %d is recorded as %+v", i+1, rec)
		}
		stop()
		if _, err := doctor.ReadRecord(dir, doctor.RuntimeRecordFile, &rec); err != nil {
			t.Fatal(err)
		}
		if !rec.CleanStop || rec.StoppedAt == 0 {
			t.Fatalf("after a clean stop the record says %+v", rec)
		}
	}
}

/* ---------------------------------------------------------------- *
 * Alerts
 * ---------------------------------------------------------------- */

// An alert is logged when it is raised, not again while it stands unchanged,
// again when it changes, once a day while it stands, and once when it clears:
// a line repeated on every check is a line nobody reads.
func TestAnAlertIsLoggedOnceUntilItChangesOrClears(t *testing.T) {
	var buf bytes.Buffer
	now := time.Now()
	a := &alerter{log: slog.New(slog.NewTextHandler(&buf, nil)), now: func() time.Time { return now },
		raised: map[string]raisedAlert{}}
	report := func(fs ...doctor.Finding) doctor.Report { return doctor.Report{Findings: fs} }
	full := doctor.Finding{Check: doctor.CheckSpace, Status: doctor.Warn, Summary: "little room", Remedy: "grow it"}
	fuller := doctor.Finding{Check: doctor.CheckSpace, Status: doctor.Fail, Summary: "no room", Remedy: "grow it now"}
	lines := func() int { return strings.Count(buf.String(), "\n") }

	a.observe(report(full))
	if lines() != 1 || !strings.Contains(buf.String(), "msg=alert check=space status=warn") ||
		!strings.Contains(buf.String(), "remedy=\"grow it\"") {
		t.Fatalf("raising an alert logged:\n%s", buf.String())
	}
	for i := 0; i < 10; i++ {
		a.observe(report(full))
	}
	if lines() != 1 {
		t.Fatalf("a standing alert was logged again:\n%s", buf.String())
	}
	a.observe(report(fuller))
	if lines() != 2 || !strings.Contains(buf.String(), `msg="alert changed" check=space status=fail`) {
		t.Fatalf("a changed alert logged:\n%s", buf.String())
	}
	now = now.Add(25 * time.Hour)
	a.observe(report(fuller))
	if lines() != 3 || !strings.Contains(buf.String(), `msg="alert still standing"`) {
		t.Fatalf("a day later the alert logged:\n%s", buf.String())
	}
	a.observe(report(doctor.Finding{Check: doctor.CheckSpace, Status: doctor.OK}))
	if lines() != 4 || !strings.Contains(buf.String(), `msg="alert cleared" check=space`) {
		t.Fatalf("clearing the alert logged:\n%s", buf.String())
	}
	// Not every check raises one: a rehearsal is a person's to do.
	a.observe(report(doctor.Finding{Check: doctor.CheckRehearsal, Status: doctor.Warn, Summary: "none"}))
	if lines() != 4 {
		t.Fatalf("a rehearsal raised an alert:\n%s", buf.String())
	}
}

// A running server checks itself and says so in its log: with no backup
// recorded, the alert names the backup, its remedy, and is not repeated.
func TestAServerLogsAnAlertWithItsRemedy(t *testing.T) {
	dir := seeded(t)
	stderr, restore := captureStderr(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", "127.0.0.1:0", "-alert-every", "50ms"}, &safeBuffer{})
	}()
	deadline := time.Now().Add(20 * time.Second)
	for !strings.Contains(stderr.String(), "msg=alert check=backup") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond) // several more checks
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("serve: %v", err)
	}
	restore()
	log := stderr.String()
	if n := strings.Count(log, "msg=alert check=backup"); n != 1 {
		t.Fatalf("the backup alert was logged %d times:\n%s", n, log)
	}
	if !strings.Contains(log, "trewd backup") {
		t.Fatalf("the alert has no remedy:\n%s", log)
	}
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
