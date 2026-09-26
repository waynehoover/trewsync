package main

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/waynehoover/trewsync/internal/doctor"
	"github.com/waynehoover/trewsync/internal/store"
)

// The server's alerts (PLAN.md M5.5): a running server checks itself and logs
// an alert, with its remedy, when something needs attention: the disk filling,
// a backup failing or growing old, a body missing or quarantined, commits
// failing again and again, the search index falling behind, a device that has
// stopped advancing. They are doctor's own checks, the cheap ones, run in the
// server's process, so what the log says and what `trewd doctor` says are one
// judgement in one place.
//
// An alert is logged when it is raised, again when it changes, once a day
// while it stands, and once when it clears. Never on every check: Basalt's
// server once logged one failure 22,000 times in a day (plan/research/
// basalt-lessons.md, 452eb72), and a line repeated that often is a line
// nobody reads, which is the same as none.

// defaultAlertEvery is how often the server checks itself.
const defaultAlertEvery = 5 * time.Minute

// alertRemindEvery is how often a standing alert is logged again.
const alertRemindEvery = 24 * time.Hour

// alertSample is how many chunk references each check reads and hashes: a
// few, every few minutes, so a disk that is rotting is noticed within hours
// without the check competing with the devices for it.
const alertSample = 32

// alertChecks are the checks an alert is raised from. Not the ones that are
// about how the server was set up (storage, encryption, data-dir, which
// `serve` says at startup), what only the operator knows the answer to (the
// origin, which a server cannot always reach from inside its own container),
// or a rehearsal, which is a person's to do.
var alertChecks = map[string]bool{
	doctor.CheckServer: true, doctor.CheckSpace: true, doctor.CheckBackup: true, doctor.CheckChunks: true,
	doctor.CheckStore: true, doctor.CheckCommits: true, doctor.CheckIndex: true, doctor.CheckDevices: true,
	doctor.CheckTokens: true,
}

// alerter is the state the alerts keep between checks.
type alerter struct {
	log    *slog.Logger
	now    func() time.Time
	raised map[string]raisedAlert
}

type raisedAlert struct {
	status  doctor.Status
	summary string
	logged  time.Time
}

// observe logs what changed since the last check, and returns the alerts
// standing now, by check.
func (a *alerter) observe(rep doctor.Report) map[string]doctor.Finding {
	now := a.now()
	standing := map[string]doctor.Finding{}
	for _, f := range rep.Findings {
		if !alertChecks[f.Check] || (f.Status != doctor.Warn && f.Status != doctor.Fail) {
			continue
		}
		standing[f.Check] = f
		prev, was := a.raised[f.Check]
		level := slog.LevelWarn
		if f.Status == doctor.Fail {
			level = slog.LevelError
		}
		switch {
		case !was:
			a.log.Log(context.Background(), level, "alert", "check", f.Check, "status", f.Status, "what", f.Summary,
				"remedy", f.Remedy)
		case prev.status != f.Status || prev.summary != f.Summary:
			a.log.Log(context.Background(), level, "alert changed", "check", f.Check, "status", f.Status,
				"what", f.Summary, "remedy", f.Remedy)
		case now.Sub(prev.logged) >= alertRemindEvery:
			a.log.Log(context.Background(), level, "alert still standing", "check", f.Check, "status", f.Status,
				"since", prev.logged.UTC().Format(time.RFC3339), "what", f.Summary, "remedy", f.Remedy)
		default:
			continue
		}
		a.raised[f.Check] = raisedAlert{status: f.Status, summary: f.Summary, logged: now}
	}
	for check := range a.raised {
		if _, ok := standing[check]; !ok {
			a.log.Info("alert cleared", "check", check)
			delete(a.raised, check)
		}
	}
	return standing
}

// watchAlerts checks the server every period until the returned stop is
// called, which waits for a check in progress.
func watchAlerts(dataDir, vault string, period time.Duration, log *slog.Logger) (stop func()) {
	a := &alerter{log: log, now: time.Now, raised: map[string]raisedAlert{}}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(period)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			a.observe(doctor.Run(ctx, doctor.Options{
				DataDir: dataDir, Vault: vault, Quick: true, Sample: alertSample, Storage: doctorStorage,
				Space: doctorSpace,
			}))
		}
	}()
	return func() {
		cancel()
		wg.Wait()
	}
}

/* ---------------------------------------------------------------- *
 * Storage a restart erases
 * ---------------------------------------------------------------- */

// ephemeralRefusal is serve's refusal of an empty store on storage a restart
// or a container replacement erases.
func ephemeralRefusal(dataDir string, s doctor.Storage) error {
	why := "a RAM-backed filesystem, erased at the next restart"
	if s.FSType != "tmpfs" && s.FSType != "ramfs" {
		why = "the container's own writable layer, erased when the container is replaced, which every upgrade does"
	}
	return fmt.Errorf("the data directory %s is on %s (%s mounted at %s), and it holds no notes yet: a server "+
		"started here would take every note and lose them all at once.\n"+
		"Mount a persistent volume at it (compose.yaml mounts ./trew/data at /data), or pass -allow-ephemeral to "+
		"start anyway, for a trial whose notes you mean to throw away", dataDir, why, s.FSType, s.MountPoint)
}

// storeIsEmpty is whether the store holds no version and no device in any
// vault: what a store newly made, or made again after its storage was
// erased, looks like.
func storeIsEmpty(st *store.Store) (bool, error) {
	vaults, err := st.Vaults()
	if err != nil {
		return false, err
	}
	for _, v := range vaults {
		latest, err := st.LatestUID(v)
		if err != nil {
			return false, err
		}
		devices, err := st.Devices(v)
		if err != nil {
			return false, err
		}
		if latest > 0 || len(devices) > 0 {
			return false, nil
		}
	}
	return true, nil
}
