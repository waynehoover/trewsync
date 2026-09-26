package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/control"
	"github.com/waynehoover/trewsync/internal/dirlock"
	"github.com/waynehoover/trewsync/internal/doctor"
	"github.com/waynehoover/trewsync/internal/metrics"
	"github.com/waynehoover/trewsync/internal/search"
	"github.com/waynehoover/trewsync/internal/server"
	"github.com/waynehoover/trewsync/internal/store"
)

// Every server these tests start keeps its data in a temporary directory,
// which on some machines is a tmpfs; serve would rightly refuse an empty store
// there. The tests that are about that refusal set doctorStorage themselves.
func TestMain(m *testing.M) {
	doctorStorage = func(dir string) (doctor.Storage, error) {
		return doctor.Storage{Dir: dir, FSType: "ext4", MountPoint: "/"}, nil
	}
	os.Exit(m.Run())
}

/* ---------------------------------------------------------------- *
 * trewd doctor, against every fault it is meant to find
 * ---------------------------------------------------------------- */

// healthy is a data directory doctor finds nothing actionable in: the seeded
// vault, a backup and a rehearsal recorded an hour ago, and a server that
// stopped cleanly.
func healthy(t *testing.T) string {
	t.Helper()
	dir := seeded(t)
	// As serve makes one.
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ago := now.Add(-time.Hour).UnixMilli()
	for name, rec := range map[string]any{
		doctor.BackupRecordFile: doctor.BackupRecord{At: ago, OK: true, To: "/srv/trew-backups/trew.tar.age",
			Encrypted: true, LatestUID: 6, Verified: 7, LastOK: ago},
		doctor.RehearsalRecordFile: doctor.RehearsalRecord{At: ago, OK: true, Backup: "/srv/trew-backups/trew.tar.age",
			BackupAt: ago, TookMs: 1200, Versions: 6, Files: 3, LastOK: ago},
		doctor.RuntimeRecordFile: doctor.RuntimeRecord{Starts: []int64{now.Add(-48 * time.Hour).UnixMilli()},
			Version: "dev", CleanStop: true, StoppedAt: ago},
	} {
		if err := doctor.WriteRecord(dir, name, rec); err != nil {
			t.Fatal(err)
		}
	}
	// Room to spare, whatever the machine running the tests has left: a sound
	// directory on a nearly full disk is rightly a warning, and that is not what
	// the tests built on this one are about. The fault cases below that are
	// about space set their own.
	swap(t, &doctorSpace, func(string) (int64, int64) { return 50 << 30, 100 << 30 })
	return dir
}

// doctorOn runs `trewd doctor -json` and returns the report and whether it
// exited non-zero.
func doctorOn(t *testing.T, dir string, args ...string) (doctor.Report, bool) {
	t.Helper()
	out, err := trew(t, append([]string{"doctor", "-json", "-data", dir}, args...)...)
	var rep doctor.Report
	if jerr := json.Unmarshal([]byte(out), &rep); jerr != nil {
		t.Fatalf("doctor -json is not JSON (%v): %v\n%s", err, jerr, out)
	}
	if actionable := rep.Actionable() > 0; actionable != (err != nil) {
		t.Fatalf("doctor found %d actionable findings and exited with %v", rep.Actionable(), err)
	}
	return rep, err != nil
}

// finding is the report's finding for check.
func finding(t *testing.T, rep doctor.Report, check string) doctor.Finding {
	t.Helper()
	for _, f := range rep.Findings {
		if f.Check == check {
			return f
		}
	}
	t.Fatalf("doctor reported nothing for %s: %+v", check, rep.Findings)
	return doctor.Finding{}
}

// expect asserts check has status, a summary saying each of says, and, when
// it is actionable, a remedy.
func expect(t *testing.T, rep doctor.Report, check string, status doctor.Status, says ...string) {
	t.Helper()
	f := finding(t, rep, check)
	if f.Status != status {
		t.Fatalf("%s is %s, want %s: %s", check, f.Status, status, f.Summary)
	}
	text := f.Summary + " " + strings.Join(f.Detail, " ")
	for _, s := range says {
		if !strings.Contains(text, s) {
			t.Fatalf("%s does not say %q: %s", check, s, text)
		}
	}
	if (status == doctor.Warn || status == doctor.Fail) && f.Remedy == "" {
		t.Fatalf("%s is %s with no remedy: %s", check, status, f.Summary)
	}
}

// The baseline every fault below is measured against: a sound directory is
// reported sound, doctor exits zero, and it changes nothing it examined, byte
// for byte, apart from the lock file a reader takes.
func TestDoctorFindsNothingInASoundDirectoryAndChangesNothing(t *testing.T) {
	dir := healthy(t)
	before := treeDigest(t, dir)
	rep, failed := doctorOn(t, dir)
	if failed {
		t.Fatalf("doctor found a sound directory wanting: %+v", rep.Findings)
	}
	for _, check := range []string{doctor.CheckDataDir, doctor.CheckStorage, doctor.CheckIdentity, doctor.CheckStore,
		doctor.CheckChunks, doctor.CheckSpace, doctor.CheckBackup, doctor.CheckRehearsal, doctor.CheckRestarts} {
		expect(t, rep, check, doctor.OK)
	}
	expect(t, rep, doctor.CheckServer, doctor.Note, "no server is running")
	if rep.Sizes == nil || rep.Sizes.Bodies == 0 || rep.Sizes.Database == 0 {
		t.Fatalf("doctor reports no sizes: %+v", rep.Sizes)
	}
	if after := treeDigest(t, dir); after != before {
		t.Fatalf("doctor changed the directory it examined:\nbefore %s\nafter  %s", before, after)
	}
}

// treeDigest is every file under dir, with its bytes, but the lock files a
// reader takes and SQLite's own companions to a database any reader opens: its
// shared-memory index, which holds no data, and an empty write-ahead log. A
// write-ahead log with anything in it is a write, and counts.
func treeDigest(t *testing.T, dir string) string {
	t.Helper()
	var lines []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(p, ".lock") || strings.HasSuffix(p, "-shm") {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if strings.HasSuffix(p, "-wal") && len(b) == 0 {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		lines = append(lines, fmt.Sprintf("%s %x", rel, sha256.Sum256(b)))
		return nil
	})
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// Each fault, injected into a sound directory, is reported by the check that
// owns it, with the status it deserves and a remedy, and makes doctor exit
// non-zero.
func TestDoctorReportsEveryInjectedFault(t *testing.T) {
	for _, c := range []struct {
		name   string
		inject func(t *testing.T, dir string) (dataDir string, args []string)
		check  string
		status doctor.Status
		says   []string
	}{
		{"no data directory", func(t *testing.T, dir string) (string, []string) {
			return filepath.Join(dir, "no such place"), nil
		}, doctor.CheckDataDir, doctor.Fail, []string{"there is no directory"}},

		{"another product's directory", func(t *testing.T, dir string) (string, []string) {
			other := t.TempDir()
			if err := os.WriteFile(filepath.Join(other, "basalt.db"), []byte("SQLite format 3\x00"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(other, "trew.db"), []byte("SQLite format 3\x00"), 0o600); err != nil {
				t.Fatal(err)
			}
			return other, nil
		}, doctor.CheckDataDir, doctor.Fail, []string{"not a trewd data directory"}},

		{"a directory other accounts can read", func(t *testing.T, dir string) (string, []string) {
			if err := os.Chmod(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			return dir, nil
		}, doctor.CheckDataDir, doctor.Warn, []string{"0755"}},

		{"storage a container replacement erases", func(t *testing.T, dir string) (string, []string) {
			swap(t, &doctorStorage, func(d string) (doctor.Storage, error) {
				return doctor.Storage{Dir: d, FSType: "overlay", MountPoint: "/", Container: true, Ephemeral: true}, nil
			})
			return dir, nil
		}, doctor.CheckStorage, doctor.Fail, []string{"writable layer"}},

		{"a server that holds the directory and does not answer", func(t *testing.T, dir string) (string, []string) {
			held, err := dirlock.Exclusive(dir, dirlock.Server, "serve")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { held.Release() })
			return dir, nil
		}, doctor.CheckServer, doctor.Fail, []string{"does not answer"}},

		{"a restart loop", func(t *testing.T, dir string) (string, []string) {
			now := time.Now()
			var starts []int64
			for i := 5; i > 0; i-- {
				starts = append(starts, now.Add(-time.Duration(i)*time.Minute).UnixMilli())
			}
			writeRecord(t, dir, doctor.RuntimeRecordFile, doctor.RuntimeRecord{Starts: starts, CleanStop: true})
			return dir, nil
		}, doctor.CheckRestarts, doctor.Fail, []string{"restart loop"}},

		{"a run that was killed", func(t *testing.T, dir string) (string, []string) {
			writeRecord(t, dir, doctor.RuntimeRecordFile, doctor.RuntimeRecord{
				Starts: []int64{time.Now().Add(-time.Hour).UnixMilli()}, Version: "dev", CleanStop: false})
			return dir, nil
		}, doctor.CheckRestarts, doctor.Warn, []string{"did not stop cleanly"}},

		{"a missing body", func(t *testing.T, dir string) (string, []string) {
			removeOneBody(t, dir)
			return dir, nil
		}, doctor.CheckStore, doctor.Fail, []string{"missing"}},

		{"a corrupt body, found by the sample", func(t *testing.T, dir string) (string, []string) {
			corruptOneBody(t, dir)
			return dir, nil
		}, doctor.CheckChunks, doctor.Fail, []string{"1 corrupt"}},

		{"a corrupt body, found by the deep pass", func(t *testing.T, dir string) (string, []string) {
			corruptOneBody(t, dir)
			return dir, []string{"-deep"}
		}, doctor.CheckStore, doctor.Fail, []string{"corrupt"}},

		{"a quarantined body", func(t *testing.T, dir string) (string, []string) {
			p := bodyPaths(t, dir)[0]
			if err := os.WriteFile(p+".extra.corrupt", []byte("what failed its hash"), 0o600); err != nil {
				t.Fatal(err)
			}
			return dir, nil
		}, doctor.CheckChunks, doctor.Warn, []string{"quarantined"}},

		{"a disk nearly full", func(t *testing.T, dir string) (string, []string) {
			swap(t, &doctorSpace, func(string) (int64, int64) { return 512 << 20, 100 << 30 })
			return dir, nil
		}, doctor.CheckSpace, doctor.Warn, []string{"little room"}},

		{"a disk full", func(t *testing.T, dir string) (string, []string) {
			swap(t, &doctorSpace, func(string) (int64, int64) { return 10 << 20, 100 << 30 })
			return dir, nil
		}, doctor.CheckSpace, doctor.Fail, []string{"refuses every write"}},

		{"an expired MCP token", func(t *testing.T, dir string) (string, []string) {
			withStore(t, dir, func(st *store.Store) {
				past := time.Now().Add(-time.Hour).UnixMilli()
				if _, err := st.CreateMCPToken("default", "Old agent", store.ScopeRead, &past, past-1000); err != nil {
					t.Fatal(err)
				}
			})
			return dir, nil
		}, doctor.CheckTokens, doctor.Warn, []string{"1 expired", "Old agent"}},

		{"a device quiet for two months", func(t *testing.T, dir string) (string, []string) {
			withStore(t, dir, func(st *store.Store) {
				raw := sha256.Sum256([]byte("a phone in a drawer"))
				if err := st.RegisterDevice("default", "cGhvbmVwaG9uZXBob25lMQ", "Phone", store.HashToken(raw[:]), 1); err != nil {
					t.Fatal(err)
				}
				if err := st.SawDevice("default", "cGhvbmVwaG9uZXBob25lMQ", time.Now().Add(-60*24*time.Hour).UnixMilli()); err != nil {
					t.Fatal(err)
				}
			})
			return dir, nil
		}, doctor.CheckDevices, doctor.Warn, []string{"quiet for over a month", "Phone"}},

		{"no backup recorded", func(t *testing.T, dir string) (string, []string) {
			if err := os.Remove(filepath.Join(dir, doctor.BackupRecordFile)); err != nil {
				t.Fatal(err)
			}
			return dir, nil
		}, doctor.CheckBackup, doctor.Warn, []string{"no backup"}},

		{"a failed backup", func(t *testing.T, dir string) (string, []string) {
			ok := time.Now().Add(-26 * time.Hour).UnixMilli()
			writeRecord(t, dir, doctor.BackupRecordFile, doctor.BackupRecord{At: time.Now().UnixMilli(), OK: false,
				Error: "no space left on device", To: "/srv/b", LastOK: ok})
			return dir, nil
		}, doctor.CheckBackup, doctor.Fail, []string{"failed", "no space left on device", "the last good one"}},

		{"an old backup", func(t *testing.T, dir string) (string, []string) {
			old := time.Now().Add(-72 * time.Hour).UnixMilli()
			writeRecord(t, dir, doctor.BackupRecordFile, doctor.BackupRecord{At: old, OK: true, To: "/srv/b", LastOK: old})
			return dir, nil
		}, doctor.CheckBackup, doctor.Warn, []string{"older than two days"}},

		{"no rehearsal", func(t *testing.T, dir string) (string, []string) {
			if err := os.Remove(filepath.Join(dir, doctor.RehearsalRecordFile)); err != nil {
				t.Fatal(err)
			}
			return dir, nil
		}, doctor.CheckRehearsal, doctor.Warn, []string{"no restore"}},

		{"a failed rehearsal", func(t *testing.T, dir string) (string, []string) {
			writeRecord(t, dir, doctor.RehearsalRecordFile, doctor.RehearsalRecord{At: time.Now().UnixMilli(), OK: false,
				Backup: "/srv/b", Error: "the restored store has 1 faults"})
			return dir, nil
		}, doctor.CheckRehearsal, doctor.Fail, []string{"failed", "1 faults"}},

		{"an origin nothing answers at", func(t *testing.T, dir string) (string, []string) {
			return dir, []string{"-url", fmt.Sprintf("ws://127.0.0.1:%d", freeTestPort(t))}
		}, doctor.CheckOrigin, doctor.Fail, []string{"cannot reach"}},

		{"an origin that answers not ok", func(t *testing.T, dir string) (string, []string) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "disk-full", http.StatusServiceUnavailable)
			}))
			t.Cleanup(s.Close)
			return dir, []string{"-url", "ws" + strings.TrimPrefix(s.URL, "http")}
		}, doctor.CheckOrigin, doctor.Fail, []string{"503", "disk-full"}},

		{"a purge holding the directory", func(t *testing.T, dir string) (string, []string) {
			held, err := dirlock.Exclusive(dir, dirlock.Data, "purge")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { held.Release() })
			return dir, nil
		}, doctor.CheckStore, doctor.Warn, []string{"purge pid", "not examined"}},

		{"a search index that cannot be read", func(t *testing.T, dir string) (string, []string) {
			if err := os.WriteFile(filepath.Join(dir, search.FileName), []byte("this is not a database at all"), 0o600); err != nil {
				t.Fatal(err)
			}
			return dir, nil
		}, doctor.CheckIndex, doctor.Warn, []string{"cannot be read"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir, args := c.inject(t, healthy(t))
			rep, failed := doctorOn(t, dir, args...)
			expect(t, rep, c.check, c.status, c.says...)
			if !failed {
				t.Fatal("doctor exited zero with a fault injected")
			}
		})
	}
}

// swap replaces a seam for the length of a test.
func swap[T any](t *testing.T, seam *T, with T) {
	t.Helper()
	was := *seam
	*seam = with
	t.Cleanup(func() { *seam = was })
}

func writeRecord(t *testing.T, dir, name string, v any) {
	t.Helper()
	if err := doctor.WriteRecord(dir, name, v); err != nil {
		t.Fatal(err)
	}
}

// withStore opens the store in dir, runs fn, and closes it.
func withStore(t *testing.T, dir string, fn func(*store.Store)) {
	t.Helper()
	st, err := store.Open(store.DataDir(dir))
	if err != nil {
		t.Fatal(err)
	}
	fn(st)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
}

// A condition the operator has decided on (backups deferred, the owner's
// choice of 2026-09-22) can be accepted by name: it is still printed, as
// accepted, and doctor exits zero when nothing else needs attention.
func TestAnAcceptedCheckIsPrintedAndDoesNotFail(t *testing.T) {
	dir := healthy(t)
	if err := os.Remove(filepath.Join(dir, doctor.BackupRecordFile)); err != nil {
		t.Fatal(err)
	}
	rep, failed := doctorOn(t, dir, "-accept", "backup")
	if failed {
		t.Fatalf("an accepted warning failed doctor: %+v", rep.Findings)
	}
	expect(t, rep, doctor.CheckBackup, doctor.Accepted, "no backup")
	if _, err := trew(t, "doctor", "-data", dir, "-accept", "nonsense"); err == nil {
		t.Fatal("an unknown check was accepted")
	}
}

// With a server running, doctor asks it over the control socket: it serves,
// can take a note, its commits are counted, and the address its invites name
// answers /health.
func TestDoctorAsksARunningServer(t *testing.T) {
	dir := healthy(t)
	addr := fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = run(ctx, []string{"serve", "-data", dir, "-addr", addr, "-url", "ws://" + addr}, out)
	}()
	defer func() { cancel(); <-done }()
	waitForServer(t, addr, out)
	rep, failed := doctorOn(t, dir)
	if failed {
		t.Fatalf("doctor found a running sound server wanting: %+v", rep.Findings)
	}
	expect(t, rep, doctor.CheckServer, doctor.OK, "can take a note")
	expect(t, rep, doctor.CheckCommits, doctor.OK, "none failed")
	expect(t, rep, doctor.CheckRestarts, doctor.OK)
	expect(t, rep, doctor.CheckOrigin, doctor.OK, "ws://"+addr)
	if !rep.Running || rep.Metrics == nil {
		t.Fatalf("doctor did not read the server's metrics: %+v", rep)
	}
}

// A running server whose chunk tree has stopped taking writes, the way a
// volume remounted read-only after an I/O error does, is reported by what it
// says of itself: it answers, and it cannot take a note.
func TestDoctorReportsARunningServerThatCannotTakeANote(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes through a read-only mode")
	}
	dir := healthy(t)
	stop := serveInBackground(t, dir)
	defer stop()
	_, chunkDir := store.DataDir(dir)
	if err := os.Chmod(chunkDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(chunkDir, 0o700) })
	rep, failed := doctorOn(t, dir, "-accept", "origin")
	expect(t, rep, doctor.CheckServer, doctor.Fail, "cannot take a note", string(store.HealthChunksUnwritable))
	if !failed {
		t.Fatal("doctor exited zero")
	}
}

// What only a running server knows, reported from what it says: repeated
// commit failures, a device that has stopped advancing, and a search index
// that has fallen behind or failed. The server here is a stand-in answering
// the control socket with a status, because none of the three can be made to
// happen on a working machine on demand.
func TestDoctorReadsWhatARunningServerKnows(t *testing.T) {
	now := time.Now()
	stuck := int64(3)
	for _, c := range []struct {
		name   string
		status func(*control.Status)
		check  string
		want   doctor.Status
		says   []string
	}{
		{"commits failing again and again", func(s *control.Status) {
			s.Metrics = mustMarshal(t, metrics.Snapshot{Commits: 40, CommitFailures: 5, ConsecutiveCommitFailures: 4,
				LastCommitFailureAt: now.UnixMilli()})
		}, doctor.CheckCommits, doctor.Fail, []string{"the last 4 commits failed"}},
		{"a commit failure since the start", func(s *control.Status) {
			s.Metrics = mustMarshal(t, metrics.Snapshot{Commits: 40, CommitFailures: 1, LastCommitFailureAt: now.UnixMilli()})
		}, doctor.CheckCommits, doctor.Warn, []string{"1 of 41 commits failed"}},
		{"a device that has stopped advancing", func(s *control.Status) {
			s.Devices = mustMarshal(t, []server.DeviceDelivery{{Device: store.Device{ID: "cGhvbmVwaG9uZXBob25lMQ", Name: "Phone"},
				Online: true, Applied: &stuck, AppliedAt: now.Add(-time.Hour).UnixMilli()}})
		}, doctor.CheckDevices, doctor.Warn, []string{"stopped advancing", "Phone"}},
		{"a search index far behind", func(s *control.Status) {
			s.Index = mustMarshal(t, search.Status{Generation: 2, IndexedHead: 0, Usable: true})
		}, doctor.CheckIndex, doctor.Warn, []string{"behind the head"}},
		{"a search index whose worker failed", func(s *control.Status) {
			s.Index = mustMarshal(t, search.Status{Generation: 2, IndexedHead: 6, Usable: true, Error: "disk I/O error"})
		}, doctor.CheckIndex, doctor.Warn, []string{"disk I/O error"}},
		{"a server that cannot take a note", func(s *control.Status) {
			s.Health = mustMarshal(t, map[string]any{"canPersist": false, "reason": "disk-full", "freeBytes": 1, "totalBytes": 1 << 40})
		}, doctor.CheckServer, doctor.Fail, []string{"disk-full"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := healthy(t)
			if c.check == doctor.CheckDevices {
				withStore(t, dir, func(st *store.Store) {
					raw := sha256.Sum256([]byte("phone"))
					if err := st.RegisterDevice("default", "cGhvbmVwaG9uZXBob25lMQ", "Phone", store.HashToken(raw[:]), 1); err != nil {
						t.Fatal(err)
					}
				})
			}
			if c.check == doctor.CheckIndex {
				// Enough history for the lag to be real.
				withStore(t, dir, func(st *store.Store) {
					for i := 0; i < doctor.IndexLagUIDs+1; i++ {
						if _, err := st.AppendEntry("default", store.Entry{Path: fmt.Sprintf("n%d.md", i),
							Device: "seed", Chunks: []string{}}); err != nil {
							t.Fatal(err)
						}
					}
				})
			}
			s := control.Status{Vault: "default", Version: "dev", StartedAt: now.Add(-time.Hour).UnixMilli(),
				Health:  mustMarshal(t, map[string]any{"canPersist": true, "freeBytes": 1 << 40, "totalBytes": 1 << 41}),
				Devices: mustMarshal(t, []server.DeviceDelivery{}), Metrics: mustMarshal(t, metrics.Snapshot{Commits: 9})}
			c.status(&s)
			fakeServer(t, dir, s)
			rep, failed := doctorOn(t, dir)
			expect(t, rep, c.check, c.want, c.says...)
			if !failed {
				t.Fatal("doctor exited zero")
			}
		})
	}
}

// fakeServer answers dir's control socket with status, as a running server
// would, for the length of the test.
func fakeServer(t *testing.T, dir string, s control.Status) {
	t.Helper()
	ctl, err := control.Listen(dir, statusOnly{s}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ctl.Close() })
}

type statusOnly struct{ s control.Status }

func (h statusOnly) Handle(_ context.Context, req control.Request) control.Reply {
	if req.Op != "status" {
		return control.Refused(control.CodeBadRequest, "only status")
	}
	s := h.s
	return control.Reply{Status: &s}
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
