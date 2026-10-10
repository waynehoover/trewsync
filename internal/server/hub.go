package server

import (
	"encoding/json"
	"sync"

	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// Hub fans committed entries out to every device on a vault.
//
// The origin session is included in the fan-out, and receives the range with an
// empty entry list. It needs the cursor advance, so skipping it would leave its
// cursor behind by one for every file it pushes; it does not need the payload,
// so sending it would ask it to recognise its own echo.
type Hub struct {
	mu      sync.RWMutex
	byVault map[string]map[*Session]struct{}
}

// NewHub is an empty fan-out.
func NewHub() *Hub {
	return &Hub{byVault: make(map[string]map[*Session]struct{})}
}

// join adds an authenticated session before its backlog is read.
func (h *Hub) join(vaultID string, s *Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.byVault[vaultID]
	if m == nil {
		m = make(map[*Session]struct{})
		h.byVault[vaultID] = m
	}
	m[s] = struct{}{}
}

func (h *Hub) leave(vaultID string, s *Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.byVault[vaultID]
	if m == nil {
		return
	}
	delete(m, s)
	if len(m) == 0 {
		delete(h.byVault, vaultID)
	}
}

// broadcast delivers one committed entry to every session on the vault.
//
// A failing peer is skipped rather than aborting the fan-out: one wedged device
// must not stop the others converging. Nothing is lost by the skip, because
// delivery here is not the durable channel. The entries table plus the uid
// cursor is, and a dropped peer receives everything it missed as catch-up when
// it reconnects.
func (h *Hub) broadcast(vaultID string, e store.Entry, origin *Session) {
	h.mu.RLock()
	peers := make([]*Session, 0, len(h.byVault[vaultID]))
	for s := range h.byVault[vaultID] {
		peers = append(peers, s)
	}
	h.mu.RUnlock()

	// Encoded frames are immutable. Each peer accounts for its own queue even
	// when the backing bytes are shared with other live or catching-up peers.
	// Encode lazily: an origin-only update does not need the full entry at all.
	//
	// A session of protocol 1 or 2 is sent a settings entry the way the origin
	// is sent its own: the range, with no entry in it, so its cursor moves
	// past a path it never sees. Reading s.proto here is safe for the reason
	// reading deviceID in detach is: it is written at hello, before the
	// session joins, and joining takes the lock the peer list was read under.
	settings := e.IsConfig()
	var full, own []byte
	for _, s := range peers {
		elide := s == origin || (settings && s.proto < wire.ProtoConfig)
		frame := &full
		if elide {
			frame = &own
		}
		if *frame == nil {
			var err error
			*frame, err = json.Marshal(liveBatch(e, elide))
			if err != nil {
				return
			}
		}
		s.deliverFrame(e.UID, *frame)
	}
}

// detach takes every session on the vault belonging to one device, except
// origin, out of the fan-out and returns them, for a revoke to close.
//
// Deleting the row is not enough on its own. A live stream does not check the
// credential again for each notification, so it would go on receiving every
// note pushed to the vault for as long as it stayed up: a revocation the revoked
// device never notices. Removing the sessions here, inside the revoke's hold on
// commitMu, is what closes that window: every broadcast runs under the same
// lock, so none after the revoke can find them (PLAN.md section 2.3.1).
//
// A device may have more than one session, so this is a list rather than a
// lookup, and origin is left out because the caller is about to answer it.
// Reading deviceID here is safe without any lock of its own: it is written
// before the session joins, and joining takes the same mutex this holds.
func (h *Hub) detach(vaultID, deviceID string, origin *Session) []*Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.byVault[vaultID]
	var out []*Session
	for s := range m {
		if s != origin && s.deviceID == deviceID {
			out = append(out, s)
			delete(m, s)
		}
	}
	if m != nil && len(m) == 0 {
		delete(h.byVault, vaultID)
	}
	return out
}

func (h *Hub) peerCount(vaultID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.byVault[vaultID])
}
