package control

import (
	"net"

	"golang.org/x/sys/unix"
)

// peerUID is the account of the process at the other end of conn, as the
// kernel recorded it when that process connected (SO_PEERCRED).
func peerUID(conn net.Conn) (int, error) {
	return fromRawConn(conn, func(fd int) (int, error) {
		cred, err := unix.GetsockoptUcred(fd, unix.SOL_SOCKET, unix.SO_PEERCRED)
		if err != nil {
			return -1, err
		}
		return int(cred.Uid), nil
	})
}
