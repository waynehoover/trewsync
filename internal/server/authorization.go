package server

import (
	"crypto/subtle"
	"errors"
)

var errSessionRevoked = errors.New("this device's credential was revoked; add this device again with an invite")

// authorizedMutation orders credential retirement and persistent mutations
// under the same lock as entry commits. Closing a socket does not interrupt a
// handler already waiting for storage. Replies and eviction run after unlock.
func (s *Session) authorizedMutation(fn func() error) error {
	s.srv.commitMu.Lock()
	defer s.srv.commitMu.Unlock()
	if err := s.currentCredential(); err != nil {
		return err
	}
	return fn()
}

// currentCredential is called while commitMu is held, and is the check that
// makes a revoke stop the mutations a device has in flight: the row is read
// again, under the lock the revoke takes, so a mutation either commits before
// the revoke or is refused after it (PLAN.md section 2.3.1).
//
// The token's digest is compared as well as the id: a device registered later
// under a revoked device's id must not revive an old session of it.
func (s *Session) currentCredential() error {
	if s.revoked.Load() {
		return errSessionRevoked
	}
	_, hash, exists, err := s.srv.st.DeviceByID(s.vaultID, s.deviceID)
	if err != nil {
		return err
	}
	if !exists || s.deviceHash == "" || subtle.ConstantTimeCompare([]byte(hash), []byte(s.deviceHash)) != 1 {
		return errSessionRevoked
	}
	return nil
}
