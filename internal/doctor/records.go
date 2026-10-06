package doctor

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/waynehoover/trewsync/internal/fsync"
)

// Three small records the commands leave in the data directory, so a doctor
// run later can answer what the store itself does not know: when the last
// backup was taken and whether it verified, when a restore was last
// rehearsed, and how the server has been starting and stopping. Each is a
// file of its own beside the database, written whole and renamed into place,
// and none holds a path inside the vault, a chunk name or a credential: they
// say where a backup went, which is a path on the server's own disk, and how
// much it held.
//
// They are advisory. A missing or unreadable record is reported as what it
// is, "no backup is recorded", and never as a fault in the notes; the store
// is the truth about the notes, and these are the truth only about what the
// commands last did.

// The record files, in the data directory.
const (
	BackupRecordFile    = "last-backup.json"
	RehearsalRecordFile = "last-rehearsal.json"
	RuntimeRecordFile   = "runtime.json"
)

// BackupRecord is what `trewd backup` last did from this data directory.
type BackupRecord struct {
	// At is when it finished, in unix milliseconds, and OK whether it
	// succeeded: a backup that failed leaves the previous good one in place
	// at its destination, and this says so rather than letting its date move.
	At    int64  `json:"at"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	// To is the destination, as given, and Deep whether it re-read every
	// body already there.
	To   string `json:"to"`
	Deep bool   `json:"deep"`
	// Encrypted is an age archive rather than a plaintext directory, and
	// Bytes and SHA256 its size and digest, by which a copy of it elsewhere
	// can be checked without the key.
	Encrypted bool   `json:"encrypted"`
	Bytes     int64  `json:"bytes,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	// TakenAt is when the archive's snapshot was taken, as its manifest says
	// it, so unpack and rehearse can tell this backup from another archive
	// encrypted to the same recipient.
	TakenAt string `json:"takenAt,omitempty"`
	// LatestUID is the newest uid the backup holds of the vault, Verified how
	// many chunk references it checked in the copy, and Operations and Pins
	// the agents' log it carried.
	LatestUID  int64 `json:"latestUid"`
	Verified   int   `json:"verified"`
	Operations int64 `json:"operations"`
	Pins       int64 `json:"pins"`
	// LastOK is when the last backup that succeeded finished, kept across a
	// failure so doctor can say how old the good copy is.
	LastOK int64 `json:"lastOk,omitempty"`
	// LastArchive is the last encrypted archive a backup from here wrote
	// whole, kept across failed and plaintext runs, which write none: it is
	// what `unpack -record` and `rehearse` compare an archive with (T36).
	// SHA256 and TakenAt above describe this run only, and a failed run or a
	// plaintext one left them empty, which the comparison read as "no
	// encrypted backup recorded" and let any archive through.
	LastArchive *ArchiveRecord `json:"lastArchive,omitempty"`
}

// ArchiveRecord is one encrypted archive a backup wrote: its digest, its
// snapshot time as its manifest says it, where it went, and when the backup
// that wrote it finished.
type ArchiveRecord struct {
	SHA256  string `json:"sha256"`
	TakenAt string `json:"takenAt"`
	To      string `json:"to"`
	At      int64  `json:"at"`
}

// Archive is the last good encrypted archive the record knows of, or nil. A
// record written before LastArchive existed has it only in the run's own
// fields, when that run was an encrypted backup that succeeded.
func (r BackupRecord) Archive() *ArchiveRecord {
	if r.LastArchive != nil && r.LastArchive.SHA256 != "" {
		return r.LastArchive
	}
	if r.OK && r.Encrypted && r.SHA256 != "" {
		return &ArchiveRecord{SHA256: r.SHA256, TakenAt: r.TakenAt, To: r.To, At: r.At}
	}
	return nil
}

// RehearsalRecord is what `trewd rehearse` last did with a backup of this
// data directory.
type RehearsalRecord struct {
	At     int64  `json:"at"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Backup string `json:"backup"`
	// BackupAt is when the backup rehearsed was taken, and TookMs how long
	// the rehearsal's restore took, copy to served bytes: the recovery time.
	BackupAt int64 `json:"backupAt"`
	TookMs   int64 `json:"tookMs"`
	// What it proved: versions and bodies served to a freshly paired device
	// and compared, and the agents' log carried.
	Versions   int64 `json:"versions"`
	Files      int   `json:"files"`
	Bytes      int64 `json:"bytes"`
	Operations int64 `json:"operations"`
	Pins       int64 `json:"pins"`
	LastOK     int64 `json:"lastOk,omitempty"`
}

// RuntimeRecord is how `trewd serve` has been starting and stopping here.
type RuntimeRecord struct {
	// Starts are the most recent starts, oldest first, in unix milliseconds,
	// at most MaxStarts of them.
	Starts []int64 `json:"starts"`
	PID    int     `json:"pid"`
	// Version is the build that started last.
	Version string `json:"version"`
	// CleanStop says the last run returned, closing the store, whether it was
	// asked to stop or refused to start, and StoppedAt when. A start sets it
	// false and only a run that returns sets it true, so a run killed or
	// crashed leaves it false.
	CleanStop bool  `json:"cleanStop"`
	StoppedAt int64 `json:"stoppedAt,omitempty"`
}

// MaxStarts is how many starts the runtime record keeps.
const MaxStarts = 20

// ReadRecord reads one record into v. A record that is not there is
// (false, nil); one that is there and does not decode is an error.
func ReadRecord(dataDir, name string, v any) (bool, error) {
	b, err := os.ReadFile(filepath.Join(dataDir, name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return true, fmt.Errorf("%s is not a record this build reads: %w", name, err)
	}
	return true, nil
}

// WriteRecord writes one record, whole: a temporary file, synced, renamed
// over the old one, and the directory synced, so a crash leaves the old
// record or the new one and never half of either. Mode 0600, as everything
// in a data directory is.
func WriteRecord(dataDir, name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dataDir, "."+name+".tmp-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dataDir, name)); err != nil {
		return err
	}
	return fsync.Dir(dataDir)
}

// NoteStart records a start of `serve` now: the start appended, the oldest
// let go past MaxStarts, and CleanStop false until the run says otherwise.
func NoteStart(dataDir, version string, pid int, now int64) (RuntimeRecord, error) {
	var r RuntimeRecord
	if _, err := ReadRecord(dataDir, RuntimeRecordFile, &r); err != nil {
		// A record this build cannot read is replaced, not a reason not to
		// serve: it describes starts, not notes.
		r = RuntimeRecord{}
	}
	previous := r
	r.Starts = append(r.Starts, now)
	if len(r.Starts) > MaxStarts {
		r.Starts = r.Starts[len(r.Starts)-MaxStarts:]
	}
	r.PID, r.Version, r.CleanStop, r.StoppedAt = pid, version, false, 0
	return previous, WriteRecord(dataDir, RuntimeRecordFile, r)
}

// NoteCleanStop records that the run that started last stopped cleanly.
func NoteCleanStop(dataDir string, now int64) error {
	var r RuntimeRecord
	if _, err := ReadRecord(dataDir, RuntimeRecordFile, &r); err != nil {
		return err
	}
	r.CleanStop, r.StoppedAt = true, now
	return WriteRecord(dataDir, RuntimeRecordFile, r)
}
