package store

import (
	"errors"
	"syscall"
)

// sqliteFull is SQLite's primary result code for a database that cannot grow:
// the disk is full, a quota is reached, or the database is at its page limit.
const sqliteFull = 13

// IsDiskFull reports whether err is a write refused for want of room: the
// filesystem's ENOSPC or EDQUOT, or SQLite's SQLITE_FULL, which is how a full
// disk reaches a commit (PLAN.md M5.5, faults beyond SIGKILL).
//
// It matters because the two answers send people to different places. A
// device told `internal` retries and says the server failed; told `nospace`
// it says the server's disk is full, which is the one thing its operator can
// fix, and `trewd doctor` says the same thing from the other side.
func IsDiskFull(err error) bool {
	if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
		return true
	}
	var coded interface{ Code() int }
	return errors.As(err, &coded) && coded.Code()&0xff == sqliteFull
}
