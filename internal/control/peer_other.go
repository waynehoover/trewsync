//go:build !linux && !darwin && !freebsd

package control

import (
	"errors"
	"net"
)

// peerUID cannot ask who a peer is on a system trewd is not built for, so it
// says so, and every connection is refused rather than let in unasked.
func peerUID(net.Conn) (int, error) {
	return -1, errors.New("this system cannot say which account a control socket peer is")
}
