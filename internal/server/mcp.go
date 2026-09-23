package server

import (
	"time"

	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// What the MCP endpoint needs from the server that the store alone cannot
// give it: the commit lock, the live delivery state, and the operator's
// token commands ordered against both (PLAN.md sections 2.3 and 2.3.1).

// DefaultMCPTokenTTL is how long an MCP token works unless the operator says
// otherwise (PLAN.md section 2.3). A token read from a config file on a laptop
// is a credential for the whole vault, and one nobody remembers minting should
// stop working on its own.
const DefaultMCPTokenTTL = 90 * 24 * time.Hour

// OperatorMCPToken mints an MCP token and its author row, under the commit
// lock, so the new credential is ordered against every commit and every
// revoke like a device's.
func (s *Server) OperatorMCPToken(vaultID, label string, scope store.MCPScope, expiresAt *int64) (store.NewMCPToken, error) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	return s.st.CreateMCPToken(vaultID, label, scope, expiresAt, s.now().UnixMilli())
}

// OperatorMCPTokens lists a vault's MCP tokens.
func (s *Server) OperatorMCPTokens(vaultID string) ([]store.MCPToken, error) {
	return s.st.MCPTokens(vaultID)
}

// OperatorRevokeMCPToken deletes an MCP token and its author row under the
// commit lock.
//
// Under the lock because that is what a revoke has to mean (PLAN.md section
// 2.3.1): every mutation from the credential rechecks it under the same lock
// before it commits, so one either commits before the revoke or is refused
// after it. A read in flight is rechecked before its reply is sent, and loses
// there.
func (s *Server) OperatorRevokeMCPToken(vaultID, id string) error {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	return s.st.RevokeMCPToken(vaultID, id)
}

// UnderCommitLock runs fn holding the lock every commit and every credential
// change takes. It is the commit boundary an MCP write rechecks its
// credential at (PLAN.md section 4.3, step 4), exported so that the check and
// the write it guards cannot be separated by a revoke.
func (s *Server) UnderCommitLock(fn func() error) error {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	return fn()
}

// DeliveryStatus is every device registered to the vault with whether it is
// connected and the checkpoint its connection has confirmed: what a device's
// `devices` request is answered with, less the invites. Authors are not
// devices and are not in it.
func (s *Server) DeliveryStatus(vaultID string) ([]wire.DeviceStatus, error) {
	ds, err := s.st.Devices(vaultID)
	if err != nil {
		return nil, err
	}
	return s.hub.deviceStatus(vaultID, ds), nil
}

// Now is the server's clock, which tests move.
func (s *Server) Now() time.Time { return s.now() }
