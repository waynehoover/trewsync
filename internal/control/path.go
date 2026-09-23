package control

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

// maxSunPath is the longest unix socket path both kernels this runs on take:
// sun_path is 104 bytes on macOS and the BSDs and 108 on Linux, the terminating
// NUL included, so 103 serves both.
const maxSunPath = 103

// aliasName is the link, inside a short temporary directory, that stands for
// the data directory when the real socket path is too long to bind or dial.
const aliasName = "d"

// withShortPath runs fn with a path that reaches the socket in dataDir and fits
// in sun_path.
//
// A data directory under a long path is ordinary (a home directory, a Docker
// volume under /var/lib, a test's temporary directory), and the kernel refuses
// a socket path past its limit outright. So when the real path is too long,
// the same socket is reached through a symlink to the data directory, made in
// a short temporary directory and removed when fn returns. Binding through the
// link creates the socket in the data directory itself, and dialling through
// another link reaches that same file, so the two ends need not share an alias,
// only a data directory.
func withShortPath(dataDir string, fn func(path string) error) error {
	path := filepath.Join(dataDir, SocketName)
	if len(path) <= maxSunPath {
		return fn(path)
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	tmp, err := os.MkdirTemp("", "tlm")
	if err != nil {
		return fmt.Errorf("making a short path to the control socket: %w", err)
	}
	defer os.RemoveAll(tmp)
	link := filepath.Join(tmp, aliasName)
	if err := os.Symlink(abs, link); err != nil {
		return fmt.Errorf("making a short path to the control socket: %w", err)
	}
	short := filepath.Join(link, SocketName)
	if len(short) > maxSunPath {
		return fmt.Errorf("the control socket at %s is too long a path for a unix socket, and so is "+
			"the temporary directory %s; set TMPDIR to a shorter one", path, tmp)
	}
	return fn(short)
}

// listenAt binds the socket in dataDir.
func listenAt(dataDir string) (net.Listener, error) {
	var ln net.Listener
	err := withShortPath(dataDir, func(path string) error {
		var err error
		ln, err = net.Listen("unix", path)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("listening on the control socket: %w", err)
	}
	// The listener would unlink the socket through the alias on Close, and
	// the alias is gone by then; the Server removes the real path itself.
	if u, ok := ln.(*net.UnixListener); ok {
		u.SetUnlinkOnClose(false)
	}
	return ln, nil
}

// dialAt connects to the socket in dataDir. No socket, or a socket nothing is
// listening on, is ErrNotServing: a server that died leaves its socket behind.
func dialAt(ctx context.Context, dataDir string) (net.Conn, error) {
	var conn net.Conn
	err := withShortPath(dataDir, func(path string) error {
		var d net.Dialer
		var err error
		conn, err = d.DialContext(ctx, "unix", path)
		return err
	})
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENOENT) {
			return nil, ErrNotServing
		}
		return nil, fmt.Errorf("connecting to the control socket: %w", err)
	}
	return conn, nil
}
