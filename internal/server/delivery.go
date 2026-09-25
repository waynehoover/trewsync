package server

import (
	"errors"

	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// handleApplied records a device's claim after its local files and index are saved.
// Receipts are advisory, scoped to the authenticated connection, and never used
// to purge history. Losing a connection or restarting the server makes them unknown.
func (s *Session) handleApplied(m wire.In) error {
	if m.Applied == nil || *m.Applied < 0 || *m.Applied > 9007199254740991 {
		return s.reject(wire.CodeBadEntry, errors.New("applied must be a non-negative safe integer"))
	}
	latest, err := s.srv.st.LatestUID(s.vaultID)
	if err != nil {
		return s.reject(wire.CodeInternal, err)
	}
	if *m.Applied > latest || *m.Applied+1 < s.applied.Load() {
		return s.reject(wire.CodeBadEntry, errors.New("applied checkpoint is ahead of the server or moved backwards"))
	}
	if s.applied.Swap(*m.Applied+1) != *m.Applied+1 {
		s.appliedAt.Store(s.srv.now().UnixMilli())
	}
	return s.writeJSON(wire.Applied{Res: "applied", ID: s.reqID, Cursor: *m.Applied})
}

// deviceStatus adds live delivery information without writing a database row per edit.
func (h *Hub) deviceStatus(vaultID string, devices []store.Device) []wire.DeviceStatus {
	h.mu.RLock()
	defer h.mu.RUnlock()
	status := make(map[string]wire.DeviceStatus, len(devices))
	unconfirmed := make(map[string]bool)
	for _, d := range devices {
		status[d.ID] = wire.DeviceStatus{Device: d}
	}
	for s := range h.byVault[vaultID] {
		select {
		case <-s.dead:
			continue
		default:
		}
		d, ok := status[s.deviceID]
		if !ok {
			continue
		}
		d.Online = true
		if value := s.applied.Load(); value > 0 {
			cursor := value - 1
			if d.Applied == nil || cursor < *d.Applied {
				d.Applied = &cursor
			}
		} else {
			unconfirmed[s.deviceID] = true
		}
		status[s.deviceID] = d
	}
	rows := make([]wire.DeviceStatus, 0, len(devices))
	for _, d := range devices {
		row := status[d.ID]
		if unconfirmed[d.ID] {
			row.Applied = nil
		}
		rows = append(rows, row)
	}
	return rows
}
