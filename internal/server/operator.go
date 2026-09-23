package server

import (
	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// The operator's powers, for the control socket (PLAN.md section 2.3.1): the
// same four operations a device may ask for over the wire, done through the
// same commit lock and the same eviction, with the operator in place of a
// device session. The operator authenticates by being able to reach the
// socket, which is mode 0600 in the data directory, so there is no credential
// to check under the lock; every mutation still takes it, so an operator's
// change is ordered against every commit exactly as a device's is.

// OperatorInvite mints an invite on a vault. expiresAt is milliseconds, or nil
// for one that never expires, which only the operator may ask for; the invite
// names no issuing device, so no revoke cancels it.
func (s *Server) OperatorInvite(vaultID, label string, expiresAt *int64) (store.NewInvite, error) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	return s.st.CreateInvite(vaultID, label, "", expiresAt, s.now().UnixMilli())
}

// OperatorDevices is the device list, with which devices are connected now,
// and the invites that could still be redeemed: what a device's `devices`
// request is answered with.
func (s *Server) OperatorDevices(vaultID string) ([]wire.DeviceStatus, []store.Invite, error) {
	ds, err := s.st.Devices(vaultID)
	if err != nil {
		return nil, nil, err
	}
	invites, err := s.st.Invites(vaultID, s.now().UnixMilli())
	if err != nil {
		return nil, nil, err
	}
	return s.hub.deviceStatus(vaultID, ds), invites, nil
}

// OperatorRevoke revokes a device the way a device's `revoke` does, sessions,
// in-flight mutations and issued invites included.
func (s *Server) OperatorRevoke(vaultID, deviceID string) (Revocation, error) {
	return s.revoke(vaultID, deviceID, nil)
}

// OperatorAudit is one page of the vault's operation log (PLAN.md M5 task 2):
// operations committed at or after since, in milliseconds, after the one with
// sequence number after, and the store's epoch to read them against. A read,
// so it takes no lock; the log is written only inside an operation's own
// commit, and a page is one read transaction.
func (s *Server) OperatorAudit(vaultID string, since, after int64) ([]store.OperationRecord, bool, string, error) {
	ops, more, err := s.st.Operations(vaultID, since, after, store.AuditMax)
	return ops, more, s.st.Epoch(), err
}

// OperatorUninvite cancels an outstanding invite by its id.
func (s *Server) OperatorUninvite(vaultID, id string) error {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	return s.st.CancelInvite(vaultID, id, s.now().UnixMilli())
}
