// Package metrics is what a running trewd counts about itself (PLAN.md M5.5):
// how long commits wait for the commit lock and hold it, how many fail, how
// many writes are refused as stale, how many requests fail authentication or
// are told to slow down, and how many slow peers are dropped.
//
// A package of its own, as asciimoo/hister keeps server/metrics beside its
// diagnostics, rather than numbers scattered through log lines: `/health` says
// the process is listening, which says nothing about whether notes are
// arriving, and a log line is read by nobody until somebody is already
// worried. These are read by `trewd doctor` over the control socket, which is
// local and private, and by the server's own alerts.
//
// Every metric is a fixed name with no labels at all. A label is where a
// path, a chunk name, a device's token or a note's words would leak into
// whatever scrapes the numbers (PLAN.md section 2.2), and a label taken from
// input is also how a metric set grows without bound; with none, neither can
// happen, and TestASnapshotCarriesNothingFromTheVault holds it. What is per
// device (how far each has applied) is in the device list the status reply
// carries, not here.
package metrics

import (
	"sync/atomic"
	"time"
)

// Registry is one server's metrics. The zero value is not usable; New makes
// one. Every method is safe on a nil Registry and does nothing, so a server
// built without one (a test's, or the one an administrative command builds
// on a stopped store) needs no special case.
type Registry struct {
	started time.Time

	// LockWait is how long each taker of the commit lock waited for it, and
	// CommitHold how long each held it: a commit's latency, with its fsync.
	LockWait   Histogram
	CommitHold Histogram

	commits        atomic.Int64
	commitFailures atomic.Int64
	// consecutive is commit failures since the last commit that succeeded,
	// which is what separates one bad moment from a store that has stopped
	// taking notes.
	consecutive    atomic.Int64
	lastFailure    atomic.Int64 // unix ms
	batchFallbacks atomic.Int64
	stale          atomic.Int64
	authFailures   atomic.Int64
	rateLimited    atomic.Int64
	evicted        atomic.Int64
}

// New is an empty registry, started now.
func New() *Registry { return &Registry{started: time.Now()} }

// Committed counts a commit that succeeded: a device's entry or an
// operation's, however many versions it wrote.
func (r *Registry) Committed() {
	if r == nil {
		return
	}
	r.commits.Add(1)
	r.consecutive.Store(0)
}

// CommitFailed counts a commit the store failed, not one it refused: a
// statement or a COMMIT that did not complete, or an outcome it could not
// confirm.
func (r *Registry) CommitFailed() {
	if r == nil {
		return
	}
	r.commitFailures.Add(1)
	r.consecutive.Add(1)
	r.lastFailure.Store(time.Now().UnixMilli())
}

// BatchFellBack counts a device batch whose one transaction failed and was
// committed one entry at a time instead.
func (r *Registry) BatchFellBack() {
	if r != nil {
		r.batchFallbacks.Add(1)
	}
}

// Stale counts a write refused because its path moved since it was prepared.
func (r *Registry) Stale() {
	if r != nil {
		r.stale.Add(1)
	}
}

// AuthFailed counts a request or a hello refused for its credential.
func (r *Registry) AuthFailed() {
	if r != nil {
		r.authFailures.Add(1)
	}
}

// RateLimited counts a request told to come back later.
func (r *Registry) RateLimited() {
	if r != nil {
		r.rateLimited.Add(1)
	}
}

// Evicted counts a peer dropped for being too slow to keep up.
func (r *Registry) Evicted() {
	if r != nil {
		r.evicted.Add(1)
	}
}

// Snapshot is every metric at one moment, as `trewd doctor` reads it.
type Snapshot struct {
	StartedAt int64 `json:"startedAt"`
	// Commits and CommitFailures are totals since the server started;
	// ConsecutiveCommitFailures is failures since the last success, and
	// LastCommitFailureAt when the last one was, in unix milliseconds.
	Commits                   int64 `json:"commits"`
	CommitFailures            int64 `json:"commitFailures"`
	ConsecutiveCommitFailures int64 `json:"consecutiveCommitFailures"`
	LastCommitFailureAt       int64 `json:"lastCommitFailureAt,omitempty"`
	BatchFallbacks            int64 `json:"batchFallbacks"`
	StaleRefusals             int64 `json:"staleRefusals"`
	AuthFailures              int64 `json:"authFailures"`
	RateLimited               int64 `json:"rateLimited"`
	EvictedPeers              int64 `json:"evictedPeers"`
	// ActivePeers is filled in by the server, which knows its sessions.
	ActivePeers int64             `json:"activePeers"`
	LockWait    HistogramSnapshot `json:"lockWait"`
	CommitHold  HistogramSnapshot `json:"commitHold"`
}

// Snapshot reads every metric. Each is read atomically on its own; the set is
// not one instant, which for counters that only rise is no loss.
func (r *Registry) Snapshot() Snapshot {
	if r == nil {
		return Snapshot{}
	}
	return Snapshot{
		StartedAt:                 r.started.UnixMilli(),
		Commits:                   r.commits.Load(),
		CommitFailures:            r.commitFailures.Load(),
		ConsecutiveCommitFailures: r.consecutive.Load(),
		LastCommitFailureAt:       r.lastFailure.Load(),
		BatchFallbacks:            r.batchFallbacks.Load(),
		StaleRefusals:             r.stale.Load(),
		AuthFailures:              r.authFailures.Load(),
		RateLimited:               r.rateLimited.Load(),
		EvictedPeers:              r.evicted.Load(),
		LockWait:                  r.LockWait.Snapshot(),
		CommitHold:                r.CommitHold.Snapshot(),
	}
}

/* ---------------------------------------------------------------- *
 * Histograms
 * ---------------------------------------------------------------- */

// Bounds are a histogram's bucket upper bounds, fixed so a snapshot's shape
// never depends on what was observed: 1 ms to 10 s, and a last bucket for
// anything longer.
var Bounds = []time.Duration{
	time.Millisecond, 5 * time.Millisecond, 10 * time.Millisecond, 50 * time.Millisecond,
	100 * time.Millisecond, 500 * time.Millisecond, time.Second, 5 * time.Second, 10 * time.Second,
}

// Histogram counts durations into Bounds, with their count, sum and maximum.
// The zero value is ready.
type Histogram struct {
	buckets [10]atomic.Int64 // len(Bounds) + 1
	count   atomic.Int64
	sumUs   atomic.Int64
	maxUs   atomic.Int64
}

// Observe records one duration.
func (h *Histogram) Observe(d time.Duration) {
	if h == nil {
		return
	}
	i := len(Bounds)
	for j, b := range Bounds {
		if d <= b {
			i = j
			break
		}
	}
	h.buckets[i].Add(1)
	h.count.Add(1)
	us := d.Microseconds()
	h.sumUs.Add(us)
	for {
		cur := h.maxUs.Load()
		if us <= cur || h.maxUs.CompareAndSwap(cur, us) {
			return
		}
	}
}

// HistogramSnapshot is a histogram at one moment: Buckets[i] counts
// durations at most BoundsMs[i] and above the bound before it, and the last
// bucket everything above the last bound.
type HistogramSnapshot struct {
	Count    int64   `json:"count"`
	SumMs    float64 `json:"sumMs"`
	MaxMs    float64 `json:"maxMs"`
	BoundsMs []int64 `json:"boundsMs"`
	Buckets  []int64 `json:"buckets"`
}

// Snapshot reads the histogram.
func (h *Histogram) Snapshot() HistogramSnapshot {
	s := HistogramSnapshot{BoundsMs: make([]int64, len(Bounds)), Buckets: make([]int64, len(Bounds)+1)}
	if h == nil {
		return s
	}
	for i, b := range Bounds {
		s.BoundsMs[i] = b.Milliseconds()
	}
	for i := range s.Buckets {
		s.Buckets[i] = h.buckets[i].Load()
	}
	s.Count = h.count.Load()
	s.SumMs = float64(h.sumUs.Load()) / 1000
	s.MaxMs = float64(h.maxUs.Load()) / 1000
	return s
}
