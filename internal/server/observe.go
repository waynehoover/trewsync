package server

import (
	"errors"
	"sync"
	"time"

	"github.com/waynehoover/trewsync/internal/metrics"
	"github.com/waynehoover/trewsync/internal/store"
)

// What the server tells `trewd doctor` and its own alerts about itself
// (PLAN.md M5.5): its metrics, and how far each connected device has applied,
// which only a running server knows.

// commitLock is the commit lock, timed: how long each taker waited for it and
// how long it held it, which for a commit is its latency, fsync included. A
// lock that is waited on for seconds is a server that answers /health and
// takes notes slowly, and nothing else measures that.
type commitLock struct {
	mu      sync.Mutex
	metrics *metrics.Registry
	// held is when the holder took the lock, written and read only by the
	// holder.
	held time.Time
}

func (l *commitLock) Lock() {
	if l.metrics == nil {
		l.mu.Lock()
		return
	}
	start := time.Now()
	l.mu.Lock()
	l.held = time.Now()
	l.metrics.LockWait.Observe(l.held.Sub(start))
}

func (l *commitLock) Unlock() {
	if l.metrics != nil {
		l.metrics.CommitHold.Observe(time.Since(l.held))
	}
	l.mu.Unlock()
}

// Metrics is this server's metrics.
func (s *Server) Metrics() *metrics.Registry { return s.metrics }

// Snapshot is the server's metrics now, with the peers connected.
func (s *Server) Snapshot() metrics.Snapshot {
	snap := s.metrics.Snapshot()
	s.hub.mu.RLock()
	for _, m := range s.hub.byVault {
		snap.ActivePeers += int64(len(m))
	}
	s.hub.mu.RUnlock()
	return snap
}

// DeviceDelivery is one device as the operator sees it: its row, whether it
// is connected, the checkpoint its connections have confirmed applying, and
// when that last moved.
type DeviceDelivery struct {
	store.Device
	Online bool `json:"online"`
	// Applied is the lowest checkpoint the device's live connections have
	// confirmed, or nil when none has confirmed one.
	Applied *int64 `json:"applied"`
	// AppliedAt is when that checkpoint last moved, in unix milliseconds, or
	// zero; ConnectedAt when the oldest of its connections authenticated.
	AppliedAt   int64 `json:"appliedAt,omitempty"`
	ConnectedAt int64 `json:"connectedAt,omitempty"`
}

// Delivery is every device registered to the vault, with how far each has
// applied: what `trewd doctor` reads to find a device that has stopped
// advancing while the vault moves on.
func (s *Server) Delivery(vaultID string) ([]DeviceDelivery, error) {
	ds, err := s.st.Devices(vaultID)
	if err != nil {
		return nil, err
	}
	rows := make(map[string]*DeviceDelivery, len(ds))
	out := make([]DeviceDelivery, len(ds))
	for i, d := range ds {
		out[i] = DeviceDelivery{Device: d}
		rows[d.ID] = &out[i]
	}
	unconfirmed := map[string]bool{}
	s.hub.mu.RLock()
	for sess := range s.hub.byVault[vaultID] {
		select {
		case <-sess.dead:
			continue
		default:
		}
		row, ok := rows[sess.deviceID]
		if !ok {
			continue
		}
		row.Online = true
		if at := sess.connectedAt.Load(); at > 0 && (row.ConnectedAt == 0 || at < row.ConnectedAt) {
			row.ConnectedAt = at
		}
		value := sess.applied.Load()
		if value == 0 {
			unconfirmed[sess.deviceID] = true
			continue
		}
		cursor := value - 1
		if row.Applied == nil || cursor < *row.Applied {
			row.Applied = &cursor
			row.AppliedAt = sess.appliedAt.Load()
		}
	}
	s.hub.mu.RUnlock()
	for id := range unconfirmed {
		// A connection that has confirmed nothing yet holds the device's
		// checkpoint at unknown, as the wire's device list does.
		rows[id].Applied, rows[id].AppliedAt = nil, 0
	}
	return out, nil
}

// countOperation counts an operation's commit in the metrics: committed, or
// failed when the store failed it or cannot say, and not at all when a
// precondition refused it, which is the store working.
func (s *Server) countOperation(err error) {
	var oe *store.OpError
	switch {
	case err == nil:
		s.metrics.Committed()
	case errors.As(err, &oe) && oe.Outcome == store.OpRefused:
		if oe.Code == store.OpCodeStale {
			s.metrics.Stale()
		}
	default:
		s.metrics.CommitFailed()
	}
}
