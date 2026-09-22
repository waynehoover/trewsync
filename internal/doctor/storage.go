// Package doctor holds the checks `telimus doctor` runs (PLAN.md M5.5):
// diagnoses that read the system and the store and never repair anything, so
// they are safe to run while worried.
package doctor

import (
	"bufio"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Storage is what the filesystem under a data directory is, as far as the
// mount table says.
type Storage struct {
	// Dir is the data directory, absolute and with symlinks resolved.
	Dir string
	// MountPoint and FSType are the mount the directory lives on. Both are
	// empty when the platform has no mount table to read (macOS, Windows).
	MountPoint string
	FSType     string
	// Container reports whether this process looks like it runs in one.
	Container bool
	// Ephemeral reports whether the data is lost when the container is
	// replaced or the machine restarts: a RAM-backed filesystem anywhere, or
	// a container's own writable layer.
	Ephemeral bool
}

// ramBacked filesystems lose their contents at the next restart, container or
// not. layered are a container's copy-on-write root: they survive a restart
// of the same container but not its replacement, which is every upgrade.
var (
	ramBacked = map[string]bool{"tmpfs": true, "ramfs": true}
	layered   = map[string]bool{"overlay": true, "overlay2": true, "aufs": true}
)

// ephemeral reports whether data on a filesystem of this type is lost when the
// container is replaced or the machine restarts.
func ephemeral(fsType string, container bool) bool {
	return ramBacked[fsType] || (container && layered[fsType])
}

// StorageOf reports the storage under dir, reading /proc/self/mounts.
//
// Adapted from Syncidian's persistence check (github.com/shangeethsivan/Syncidian,
// internal/config/persist.go, MIT licence, copyright 2026 Shangeeth Sivan),
// with three changes: symlinks are resolved before the mount lookup, every
// octal escape in the mount table is decoded rather than four, and a
// RAM-backed filesystem is ephemeral outside a container as well as inside one.
func StorageOf(dir string) (Storage, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Storage{}, err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	s := Storage{Dir: abs, Container: inContainer()}
	f, err := os.Open("/proc/self/mounts")
	if errors.Is(err, os.ErrNotExist) {
		return s, nil // no mount table on this platform: nothing to say
	}
	if err != nil {
		return s, err
	}
	defer f.Close()
	mounts, err := parseMounts(f)
	if err != nil {
		return s, err
	}
	s.MountPoint, s.FSType = mountOf(abs, mounts)
	s.Ephemeral = ephemeral(s.FSType, s.Container)
	return s, nil
}

type mount struct{ point, fsType string }

// parseMounts reads a /proc/self/mounts table: device, mount point, type,
// options, dump, pass, with the mount point's special bytes octal-escaped.
func parseMounts(r io.Reader) ([]mount, error) {
	var out []mount
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		out = append(out, mount{point: unescapeOctal(fields[1]), fsType: fields[2]})
	}
	return out, sc.Err()
}

// mountOf is the mount a path lives on: the longest mount point that is the
// path or one of its ancestors, component by component. Of two mounts at the
// same point the later one wins, because it is the one stacked on top.
func mountOf(path string, mounts []mount) (point, fsType string) {
	best := -1
	for _, m := range mounts {
		p := m.point
		covers := p == "/" || path == p || strings.HasPrefix(path, strings.TrimRight(p, "/")+"/")
		if covers && len(p) >= best {
			best, point, fsType = len(p), p, m.fsType
		}
	}
	return point, fsType
}

// unescapeOctal decodes the \NNN escapes the kernel writes for any byte in a
// mount point that would break the table's format.
func unescapeOctal(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && isOctal(s, i+1) {
			b.WriteByte((s[i+1]-'0')<<6 | (s[i+2]-'0')<<3 | (s[i+3] - '0'))
			i += 3
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isOctal(s string, at int) bool {
	if at+3 > len(s) {
		return false
	}
	for _, c := range []byte(s[at : at+3]) {
		if c < '0' || c > '7' {
			return false
		}
	}
	return s[at] <= '3' // three octal digits above \377 are not a byte
}

// inContainer reports whether this process looks like it runs in a container.
func inContainer() bool {
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return os.Getenv("KUBERNETES_SERVICE_HOST") != ""
}
