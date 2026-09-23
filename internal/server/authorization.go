package server

import (
	"crypto/subtle"
	"errors"

	"github.com/waynehoover/trew/internal/store"
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

// currentCredential is called while commitMu is held. Compare the key as well
// as the ID: a newly registered device can reuse an ID from an older session.
func (s *Session) currentCredential() error {
	if s.registrar {
		hash, err := s.srv.st.AuthHash(s.vaultID)
		if err != nil {
			return err
		}
		if s.authHash == "" || subtle.ConstantTimeCompare([]byte(hash), []byte(s.authHash)) != 1 {
			return store.ErrRotated
		}
		return nil
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
