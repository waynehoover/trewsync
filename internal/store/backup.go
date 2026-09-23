package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"github.com/waynehoover/trew/internal/fsync"
	"io"
)

// BackupReport says what a backup copied.
//
// Every number is here because a backup is the one operation whose failure is
// invisible until you need it. Rule 8: an implausible figure is what catches
// this class of fault, and a backup that reports only "done" has told you
// nothing you can check.
type BackupReport struct {
	Dir string

	Vaults int
	// Refs is chunk references walked, including repeats: a chunk shared by
	// twenty versions is twenty references to one body.
	Refs int64
	// Copied is bodies actually written, which is distinct by construction
	// because a body present after the first copy is skipped.
	Copied int64
	Bytes  int64

	// SourceBodies and DestBodies are file counts either side. The destination
	// is expected to be the smaller of the two: it holds what committed entries
	// reference, and the source may also hold bodies from a push that has not
	// committed yet or one that died. Rule 5 says a smaller result is a bug
	// until it is explained, so both numbers are reported and the difference is
	// the explanation.
	SourceBodies int
	DestBodies   int

	// Retained is destination bodies the newest snapshot does not reference.
	// A backup accumulates history on purpose: after the source purges old
	// versions, the next snapshot stops referencing their bodies, but those
	// bodies are the very history the backup exists to keep, so they are left
	// in place rather than swept. See Backup for why deleting them would be the
	// one thing a backup must never do (S14).
	Retained int

	// Verified is chunk references checked in the backup after writing it.
	Verified int

	// InvitesLeftOut is invites the source still had outstanding, which the
	// backup does not carry; see Backup for why a restore must not bring one
	// back.
	InvitesLeftOut int

	// Oplog is the agent operations, before-image pins and idempotency keys
	// the snapshot carries, counted in the snapshot itself. All three travel
	// with the database, because a restore that lost the pins would let the
	// next purge drop every before-image an agent's writes displaced (PLAN.md
	// section 4.5), and one that lost the operations would leave writes nobody
	// can explain. The keys travel too, and are not replayed across the
	// restore's new epoch; see Replay.
	Oplog OplogCounts

	// Inherited is faults the finished backup has that the source has too.
	//
	// A copy cannot be better than what it copied. A row the store should
	// never have taken, a path the policy refuses for instance, is copied
	// faithfully by `VACUUM INTO`, and `verifyEntries` reports it on every
	// pass. Refusing to publish over that vetoed every backup for ever on any
	// vault holding one, and the message blamed the backup for a fault in the
	// store it came from: the last good copy was never refreshed, and `purge
	// -backup` could then never be satisfied either, so the safety net was cut
	// by the thing holding it. (Basalt met it with entries whose authenticator
	// predated F20; Trew has no authenticator and keeps the mechanism.)
	//
	// So a fault the source has as well is reported and does not block. A
	// fault the source does not have is the copy being wrong, and that still
	// refuses.
	Inherited []Fault

	// Meta is what was written to backup.json beside the database: the uid
	// range each vault covers and the purge generation it was taken at.
	Meta BackupMeta
}

// BackupMetaFile is the name of the coverage file a backup writes beside its
// database, so a script can ask what a backup directory holds without opening
// SQLite.
const BackupMetaFile = "backup.json"

// BackupMetaFormat is the version of backup.json this build writes and reads.
// Format 1 carried no Database stamp, so a file at that version cannot be
// checked against the database beside it and is not accepted.
const BackupMetaFormat = 2

// BackupMeta is what backup.json says about the snapshot beside it.
//
// It exists because the runbook after a purge is to start a fresh backup
// directory, keep the old one for its history, and delete it whole later, and a
// directory of hashes gives nothing to decide that on. A retention script, or a
// person with jq, needs three things per vault: which uids the snapshot holds,
// when it was taken, and which side of a purge it was taken on. The database is
// the authority and this is a summary of it.
//
// It used to say it could "lag behind the database by one run but never claim
// more than the database holds", and that was false. A crash between the
// rename and this file left the previous run's coverage beside a new database,
// and after a purge the previous run's coverage is the *larger*, older range:
// backup.json saying uids 1 to 5, 5 versions, purge generation 0, beside a
// database holding 4 to 5, 2 versions, generation 1. The retention query in
// docs/server.md then picks a directory that does not cover the uid it was
// asked for. Two things fix it, and both are needed because they cover
// different failures: the old file is removed before the database is
// published, so a crash leaves no coverage rather than the wrong coverage
// (rule 2, absent and unreadable are not the same state, and neither is
// absent and wrong); and Database stamps the file against the database it
// describes, so a republish by any build that does not write this file, a
// rollback for instance, is detectable rather than silently stale for ever.
// TestBackupLeavesNoCoverageRatherThanStaleCoverage and
// TestCoverageIsStampedAgainstTheDatabaseBesideIt.
type BackupMeta struct {
	// Format is 2. A script checks it before trusting the field names.
	// Format 1 had no Database stamp.
	//
	// Still 2 after `Database.Change` was added, deliberately. The field is
	// additive: an older build ignores it and reads everything else correctly,
	// and a newer build treats its absence as "not recorded" rather than as a
	// mismatch. Bumping would make every older trew refuse a backup it can
	// read perfectly well, which is a worse failure than the one it would
	// announce.
	Format int `json:"format"`
	// TakenAt is when the snapshot was taken, RFC 3339 in UTC.
	TakenAt string `json:"takenAt"`
	// Database ties this file to the trew.db published beside it.
	Database Snapshot        `json:"database"`
	Vaults   []VaultCoverage `json:"vaults"`
}

// Snapshot is how backup.json names the database it describes.
//
// Size survives a plain `cp -r` of the whole directory, which is a thing people
// legitimately do to a backup, and that is why it is here. It is a weak
// identifier on its own: two different databases of the same size are not
// unlikely at all, because a snapshot taken an hour later is usually the same
// number of pages. So a second database could be republished into a directory
// and the coverage beside it would go on looking plausible while describing a
// snapshot that no longer exists (I16).
//
// Change is what makes the binding real: SQLite's file change counter, four
// bytes at offset 24 of the header, incremented on every transaction that
// modifies the database. Two snapshots of one store differ in it even when they
// are byte-identical in length, and it survives a copy exactly as the size
// does, because it is inside the file.
//
// ModifiedAt is recorded for a script looking at a directory nobody has copied,
// where it is stronger than either, and is not checked here because a copy
// moves it and a moved mtime is not a stale file.
type Snapshot struct {
	Bytes int64 `json:"bytes"`
	// Change is SQLite's file change counter. Zero in a Format 2 file, which is
	// why reading one is not an error: it means "not recorded", not "zero".
	//
	// It is a cheap first look and not an identifier, which is what it was
	// briefly taken for (R14). `VACUUM INTO` writes a *fresh* database, so its
	// counter starts from the handful of transactions that built it rather
	// than carrying anything over from the source: two backups of the same
	// store taken an hour apart are both at three, and swapping one database
	// for the other was accepted. What it still does is catch a file that has
	// been written to in place, which is worth a stat and a four-byte read.
	Change int64 `json:"change"`
	// Digest is the SHA-256 of the database file, and is what actually
	// identifies this snapshot. Empty in a file written before it, which reads
	// as "not recorded" rather than as a mismatch.
	Digest     string `json:"digest,omitempty"`
	ModifiedAt string `json:"modifiedAt"`
}

// sqliteChangeCounter reads the file change counter out of a SQLite header.
//
// Four bytes, big-endian, at offset 24. Read from the file rather than asked of
// a connection, because the point is to identify the bytes on disk: opening the
// database to ask would recover its write-ahead log and change the very thing
// being identified.
//
// A file too short to have a header is not an error here. This is used to stamp
// and to compare, and both callers have better things to say about a database
// that is not one than this function does.
func sqliteChangeCounter(path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	var head [28]byte
	if _, err := io.ReadFull(f, head[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
			return 0, nil
		}
		return 0, err
	}
	return int64(binary.BigEndian.Uint32(head[24:28])), nil
}

// DatabaseStamp describes the database in a backup directory, for writing into
// backup.json and for checking one that was written earlier.
func DatabaseStamp(dir string) (Snapshot, error) {
	dbPath, _ := DataDir(dir)
	info, err := os.Stat(dbPath)
	if err != nil {
		return Snapshot{}, err
	}
	change, err := sqliteChangeCounter(dbPath)
	if err != nil {
		return Snapshot{}, err
	}
	digest, err := fileDigest(dbPath)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		Bytes:      info.Size(),
		Change:     change,
		Digest:     digest,
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
	}, nil
}

// isSHA256Hex is whether a string is what fileDigest produces, and nothing
// else (R27).
func isSHA256Hex(s string) bool {
	if len(s) != sha256.Size*2 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// short is the first few characters of a digest, for a message, and never
// panics on one that is shorter than that.
func short(digest string) string {
	if len(digest) <= 16 {
		return digest
	}
	return digest[:16]
}

// fileDigest is the SHA-256 of a file, streamed.
//
// One pass over the database, which is metadata only: the bodies are files
// beside it and are not read here. Against what a backup costs to take, and
// against what a purge costs to verify, this is not a figure anybody will
// notice, and it is the only thing in the sidecar that actually says *which*
// snapshot it describes (R14).
func fileDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// VaultCoverage is the uid range one vault's snapshot covers.
//
// OldestUID to LatestUID is the span; Versions against that span says whether
// there are holes in it, which a purge leaves. AllocatedTo is the uid counter,
// which purge never rewinds, and Purges is the generation: a snapshot at a
// lower generation than the live store holds history the live store has since
// dropped, and is the one to keep.
type VaultCoverage struct {
	Vault       string `json:"vault"`
	OldestUID   int64  `json:"oldestUid"`
	LatestUID   int64  `json:"latestUid"`
	AllocatedTo int64  `json:"allocatedTo"`
	Versions    int64  `json:"versions"`
	Purges      int64  `json:"purges"`
}

// coverage describes the vaults this store holds, in the shape backup.json
// records. Called on the snapshot, never on the live store, so the numbers are
// the file's own.
func (s *Store) coverage(vaults []string, now time.Time) (BackupMeta, error) {
	meta := BackupMeta{Format: BackupMetaFormat, TakenAt: now.UTC().Format(time.RFC3339), Vaults: []VaultCoverage{}}
	for _, v := range vaults {
		st, err := s.Stats(v)
		if err != nil {
			return meta, err
		}
		meta.Vaults = append(meta.Vaults, VaultCoverage{
			Vault: v, OldestUID: st.OldestUID, LatestUID: st.LatestUID,
			AllocatedTo: st.AllocatedTo, Versions: st.Versions, Purges: st.Purges,
		})
	}
	return meta, nil
}

// writeBackupMeta publishes meta as backup.json in destDir, the same careful
// way as everything else in a backup: a temporary file, flushed, renamed into
// place, and the directory flushed, so a crash leaves the old file or the new
// one and never half of either.
func writeBackupMeta(destDir string, meta BackupMeta) error {
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	final := filepath.Join(destDir, BackupMetaFile)
	tmp, err := os.CreateTemp(destDir, "."+BackupMetaFile+".*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // a no-op once the rename has consumed it
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, final); err != nil {
		return err
	}
	return fsync.Dir(destDir)
}

// removeBackupMeta unpublishes the coverage file, durably, so that the moment
// between here and writeBackupMeta has no coverage in it rather than the
// previous run's. Absent is a state a reader handles; wrong is not.
func removeBackupMeta(destDir string) error {
	if err := os.Remove(filepath.Join(destDir, BackupMetaFile)); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return fsync.Dir(destDir)
}

// ReadBackupMeta reads a backup directory's backup.json. A directory written
// by a build before the file existed has none, and that is reported as an
// error rather than an empty summary: rule 2, absent and unreadable are
// different states, and an empty coverage would read as a backup of nothing.
func ReadBackupMeta(dir string) (BackupMeta, error) {
	var meta BackupMeta
	b, err := os.ReadFile(filepath.Join(dir, BackupMetaFile))
	if err != nil {
		return meta, err
	}
	if err := json.Unmarshal(b, &meta); err != nil {
		return meta, fmt.Errorf("%s: %w", BackupMetaFile, err)
	}
	if meta.Format != BackupMetaFormat {
		return meta, fmt.Errorf("%s: format %d, this build reads %d", BackupMetaFile, meta.Format, BackupMetaFormat)
	}
	// The file has to describe the database beside it. It can stop doing so
	// without anything here running: a build that does not write this file can
	// republish the database into the same directory, and the coverage left
	// behind then describes a snapshot that is gone, for ever, because nothing
	// corrects it. Checked on every read, so the mismatch is an error at the
	// moment someone relies on it rather than a wrong answer.
	stamp, err := DatabaseStamp(dir)
	if err != nil {
		return meta, fmt.Errorf("%s: describing the database beside it: %w", BackupMetaFile, err)
	}
	if stamp.Bytes != meta.Database.Bytes {
		return meta, fmt.Errorf(
			"%s describes a %d byte database and the one beside it is %d bytes, so it is not a summary of "+
				"this snapshot: something republished the database without rewriting the coverage. "+
				"Run `trew backup` into this directory again, or read the database itself",
			BackupMetaFile, meta.Database.Bytes, stamp.Bytes)
	}
	// The change counter, which catches a database written to in place. Skipped
	// when the file records zero: "not recorded" is not "zero", and treating it
	// as a mismatch would fail every backup taken before it was stamped.
	if meta.Database.Change != 0 && stamp.Change != meta.Database.Change {
		return meta, fmt.Errorf(
			"%s describes a database at change %d and the one beside it is at change %d. They are the same "+
				"size, so this is a different snapshot of the same store rather than a truncated file: "+
				"something republished the database without rewriting the coverage. "+
				"Run `trew backup` into this directory again, or read the database itself",
			BackupMetaFile, meta.Database.Change, stamp.Change)
	}
	// And the digest, which is what actually identifies the snapshot (R14).
	//
	// The two checks above are a size and a counter, and `VACUUM INTO` writes a
	// fresh database whose counter starts from the transactions that built it:
	// two backups of one store, taken an hour apart, are the same size and at
	// the same change, and swapping one for the other passed both. Nothing
	// short of the contents can tell those apart.
	if meta.Database.Digest != "" {
		// The shape first, and then the value (R27).
		//
		// This came out of JSON, which is to say out of a file on a disk that
		// may be the reason somebody is reading it. A short one made the
		// mismatch message slice past the end of it and panic, so a damaged
		// sidecar took the diagnostic down with it: exactly the moment the
		// tool has to keep working, and rule 2 in the small, an unreadable
		// field being reported as a crash rather than as an unreadable field.
		if !isSHA256Hex(meta.Database.Digest) {
			return meta, fmt.Errorf(
				"%s records a database digest of %q, which is not a SHA-256. The file is damaged; "+
					"take a fresh backup, or read the database itself",
				BackupMetaFile, short(meta.Database.Digest))
		}
		if stamp.Digest != meta.Database.Digest {
			return meta, fmt.Errorf(
				"%s describes a database whose contents hash to %s and the one beside it hashes to %s, "+
					"so it is a different snapshot: something republished the database without "+
					"rewriting the coverage. Run `trew backup` into this directory again, or read "+
					"the database itself",
				BackupMetaFile, short(meta.Database.Digest), short(stamp.Digest))
		}
	}
	return meta, nil
}

func (r BackupReport) String() string {
	return fmt.Sprintf(
		"%s: %d vaults, %d chunk references, %d bodies copied (%d bytes), "+
			"%d bodies at source and %d in the backup (%d retained history), %d references verified",
		r.Dir, r.Vaults, r.Refs, r.Copied, r.Bytes,
		r.SourceBodies, r.DestBodies, r.Retained, r.Verified)
}

// SnapshotInto writes a consistent copy of the database to path, which must not
// exist.
//
// SQLite's VACUUM INTO takes a read transaction, so the copy is a single point
// in time even with writers active, and it produces one clean file rather than a
// database plus a write-ahead log. Copying the files with cp instead is how you
// get a backup that opens fine and is missing the last few commits.
//
// There is no check here that path is absent, because SQLite refuses an existing
// target itself, with "output file already exists". A check in front of it would
// be a second opinion on a question already answered, and one more thing to keep
// in step.
//
// The path is a bound parameter, not interpolated. A path is exactly the kind of
// string that contains a quote one day.
func (s *Store) SnapshotInto(path string) error {
	_, err := s.db.Exec(`VACUUM INTO ?`, path)
	return err
}

// ChunkRefs calls fn for every chunk reference a committed entry holds, oldest
// vault first.
//
// It streams rather than returning a slice: a vault with a lot of history has
// millions of references, and the caller only ever needs one at a time. Repeats
// are not filtered, because filtering needs the whole set in memory and the
// caller's own presence check already makes a repeat cheap.
func (s *Store) ChunkRefs(fn func(vaultID, name string) error) error {
	rows, err := s.db.Query(
		// Ordered by vault only, which is the whole of the documented contract:
		// oldest vault first. Adding uid and ord to it asked for a sort the
		// covering index cannot provide, so this scanned the primary key and
		// looked up every row: 10 ms over 20k rows against under 1 ms. The
		// order of names within a vault was never promised and nothing reads
		// it: this is a set of names to copy.
		`SELECT vault_id, name FROM entry_chunks ORDER BY vault_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var vaultID, name string
		if err := rows.Scan(&vaultID, &name); err != nil {
			return err
		}
		if err := fn(vaultID, name); err != nil {
			return err
		}
	}
	return rows.Err()
}

// stagedPrefix names a snapshot being written but not yet published. Every
// file under it in a backup directory is this operation's or a dead one's.
const stagedPrefix = "." + dbFileName + ".snapshot"

// Backup writes everything this store holds into destDir, which becomes a data
// directory in its own right: restoring is copying it back, and checking it is
// running verify against it.
//
// The new snapshot is published over the previous one only at the very end,
// after every body it references has been copied and the whole thing verified
// (S7). The obvious order, renaming the snapshot into place first and copying
// bodies after, has two failures that arrive together: a missing source body or
// a full disk leaves the destination database claiming content it does not
// hold, and it has already overwritten the last good backup to do it. So the
// snapshot is staged under a temporary name, its bodies are copied into the
// shared chunk tree, it is verified against that tree, and only then is it
// renamed over the live database. A run that fails anywhere before that rename
// leaves the previous backup exactly as it was, still openable and still
// verifiable. The bodies copied before a failure are harmless: a body is named
// by its hash, so it is either already correct or referenced by no database.
//
// The order within a run is also database first, then bodies, and that is the
// opposite of the obvious one for a second reason. Copying bodies first would
// let an entry commit in between, and the snapshot taken afterwards would
// reference a body the copy never saw. Taken this way round, every body the
// snapshot references was already durable when the snapshot was taken, because
// an entry is only committed once its bodies are.
//
// Bodies are copied through Get and Put, so each one is hashed on the way out of
// the source and again on the way into the backup. Rule 3 asks for both ends,
// and it is worth being precise about what the second one adds: Put alone would
// already refuse a corrupt body, because it verifies what it is given. Reading
// through Get changes the *diagnosis*, not the outcome. Rot at the source is
// reported against the source, rather than surfacing as a mismatch at the
// destination and sending someone to check the wrong disk.
//
// Repeat backups into the same directory copy only what is missing, because a
// body is named by its hash and a body already there is already correct. They
// also never delete: a backup accumulates history on purpose. Once the source
// has purged old versions, the next snapshot stops referencing their bodies,
// but those bodies are the history the backup exists to hold, and the source
// no longer has them. Sweeping them here would destroy the one copy of exactly
// what a backup is for, so they are counted as Retained and left alone (S14).
//
// deep re-reads every body already in the backup as well as the ones just
// written. The bodies just written are always checksummed; deep is for finding
// bit rot in a backup that has been sitting on a disk for a year.
func (s *Store) Backup(destDir string, deep bool) (BackupReport, error) {
	rep := BackupReport{Dir: destDir}

	// Refuse a destination that would write into the store being backed up. The
	// data directory itself, the chunk tree, or anywhere under them: each would
	// half work, corrupting the source before the command failed (S15). Checked
	// before the destination is created (S26): a refused destination inside the
	// chunk tree used to be created on the way to being refused, leaving a
	// directory in the tree that nothing put there.
	if err := s.refuseOverlap(destDir); err != nil {
		return rep, err
	}
	if err := refuseDestinationRecovery(destDir); err != nil {
		return rep, err
	}
	if err := os.MkdirAll(destDir, 0o700); err != nil {
		return rep, err
	}

	dbPath := filepath.Join(destDir, dbFileName)
	chunkDir := filepath.Join(destDir, chunkDirName)
	// Staged, not published. The rename over dbPath is the last thing this
	// function does, so until it succeeds the previous backup is what dbPath
	// still names.
	//
	// The staging name is this operation's own (F06). It used to be a fixed
	// `.trew.db.snapshot`, removed on the way in, so two backups into one
	// directory each deleted the other's half-written snapshot and one of them
	// published a database the other was still writing. The destination lock
	// above makes that unreachable from this binary; the name makes it
	// unreachable at all, and it means an interrupted backup leaves a file
	// nothing else will pick up rather than one the next backup adopts.
	//
	// Anything left from a run that died is swept first. The caller holds this
	// directory's lock, so a staging file here belongs to nobody: the process
	// that made it is gone. Sweeping rather than reusing, because a half-written
	// snapshot adopted as a starting point is the fault this whole staging
	// dance exists to avoid.
	if entries, err := os.ReadDir(destDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), stagedPrefix) {
				continue
			}
			if err := os.Remove(filepath.Join(destDir, e.Name())); err != nil && !os.IsNotExist(err) {
				return rep, err
			}
		}
	}
	staged, err := os.CreateTemp(destDir, stagedPrefix+"*")
	if err != nil {
		return rep, err
	}
	stagedDB := staged.Name()
	if err := staged.Close(); err != nil {
		return rep, err
	}
	// SnapshotInto writes its own file, so the placeholder has to go first.
	if err := os.Remove(stagedDB); err != nil && !os.IsNotExist(err) {
		return rep, err
	}
	// Whatever happens below, the staging file does not outlive this call. A
	// no-op once the rename at the end has consumed it.
	defer func() { _ = os.Remove(stagedDB) }()
	if err := s.SnapshotInto(stagedDB); err != nil {
		return rep, fmt.Errorf("snapshotting the database: %w", err)
	}
	// VACUUM INTO does not fsync its output, so the snapshot's bytes can still
	// be in the page cache. Flush it before anything relies on it being on disk.
	if err := syncFile(stagedDB); err != nil {
		return rep, fmt.Errorf("flushing the snapshot: %w", err)
	}

	// Open the staged snapshot against the shared chunk tree, so the bodies it
	// references are copied into the tree the published database will read.
	// Adding bodies here cannot harm the previous backup: it references a subset
	// of what the tree holds, and a content-addressed body is either already
	// present or new.
	dest, err := Open(stagedDB, chunkDir)
	if err != nil {
		return rep, fmt.Errorf("opening the staged snapshot: %w", err)
	}
	// A new epoch for the copy, before anything is verified or published, so a
	// database served from this backup is never mistaken for the store it was
	// taken from. Restoring is serving the backup's database, and a device that
	// followed the source's uid sequence past this snapshot must be told that
	// the sequence it is holding a cursor into may be reissued (PLAN.md section
	// 2.8): a different epoch in `ready` is how it is told.
	if err := dest.renewEpoch(); err != nil {
		dest.Close()
		return rep, fmt.Errorf("giving the snapshot its own epoch: %w", err)
	}
	// Nor is an outstanding invite carried into it. An invite is a bearer
	// credential that lives an hour, and the backup is for notes: restoring a
	// week-old copy would otherwise revive every invite that was outstanding
	// then, including the ones cancelled or spent since, each of which adds a
	// device (plan/astra-critique.md: a restore can resurrect retired
	// credentials). Spent rows stay, because a device row that came from one
	// is in the copy too, and they redeem nothing. Counted, because this makes
	// a list smaller (rule 5).
	left, err := dest.dropUnspentInvites()
	if err != nil {
		dest.Close()
		return rep, fmt.Errorf("leaving outstanding invites out of the snapshot: %w", err)
	}
	rep.InvitesLeftOut = left
	if rep.Oplog, err = dest.oplogCounts(); err != nil {
		dest.Close()
		return rep, fmt.Errorf("counting the operations the snapshot carries: %w", err)
	}

	vaults, err := dest.Vaults()
	if err != nil {
		dest.Close()
		return rep, err
	}
	rep.Vaults = len(vaults)

	// The references come from the *snapshot*, not from the live store, so the
	// set of bodies copied is exactly the set the backup's own database claims.
	err = dest.ChunkRefs(func(vaultID, name string) error {
		rep.Refs++
		if s.duringBackup != nil {
			s.duringBackup()
		}
		if dest.chunks.Has(vaultID, name) {
			return nil
		}
		body, err := s.chunks.Get(vaultID, name)
		if err != nil {
			return fmt.Errorf("reading %s from vault %s: %w", name, vaultID, err)
		}
		if err := dest.chunks.Put(vaultID, name, body); err != nil {
			return fmt.Errorf("writing %s to the backup: %w", name, err)
		}
		rep.Copied++
		rep.Bytes += int64(len(body))
		return nil
	})
	if err != nil {
		dest.Close()
		return rep, err
	}

	if rep.SourceBodies, err = s.chunks.CountBodies(); err != nil {
		dest.Close()
		return rep, err
	}
	if rep.DestBodies, err = dest.chunks.CountBodies(); err != nil {
		dest.Close()
		return rep, err
	}
	// Bodies the new snapshot does not reference are retained history, not a
	// discrepancy: Refs counts references with repeats, so the distinct
	// referenced set is what the destination needs, and anything beyond it is
	// what earlier snapshots left behind. Never negative: every referenced body
	// is present, because the copy above just made sure of it.
	referenced, err := dest.distinctChunkCount()
	if err != nil {
		dest.Close()
		return rep, err
	}
	if rep.Retained = rep.DestBodies - referenced; rep.Retained < 0 {
		rep.Retained = 0
	}

	// Verify the staged snapshot against the bodies now in the tree, before it
	// is published. A backup reported as successful and then found unreadable is
	// the failure this whole function exists to prevent, and publishing an
	// unverified snapshot over the last good one would be that failure with the
	// safety net cut.
	checked, err := dest.Verify(deep)
	if err != nil {
		dest.Close()
		return rep, err
	}
	rep.Verified = checked.Chunks
	// Told apart before either is acted on: what this copy got wrong, and what
	// it faithfully copied.
	//
	// `Backup`'s own reasoning about rot at the source says to report it
	// against the source "rather than sending someone to check the wrong
	// disk", and that was applied to bodies and not to entries.
	inherited, blocking, err := s.splitInheritedFaults(checked.Faults, deep)
	if err != nil {
		dest.Close()
		return rep, err
	}
	rep.Inherited = inherited
	if len(blocking) > 0 {
		dest.Close()
		// Not "missing chunk references": a deep pass also decodes the device
		// rows and the invites, and a backup that published with a rotted
		// registry would restore into a vault whose devices are locked out.
		return rep, fmt.Errorf("the backup has %d faults over %d chunk references and %d "+
			"registry rows, first: %s",
			len(blocking), checked.Chunks, checked.Rows, blocking[0])
	}
	// What the snapshot covers, read from the snapshot itself so backup.json
	// describes the file beside it and not the live store, which may have
	// moved on while the bodies were copied.
	meta, err := dest.coverage(vaults, time.Now())
	dest.Close()
	if err != nil {
		return rep, err
	}

	// The previous run's coverage goes first, before the database it describes
	// stops being the one here. From here until the new coverage lands there
	// is no backup.json, which is the only honest thing this directory can say
	// in that window: the previous file describes a snapshot that is about to
	// be replaced, and after a purge it describes a *larger*, older uid range
	// than the database beside it, so a retention query would pick this
	// directory for a uid it no longer holds.
	if err := removeBackupMeta(destDir); err != nil {
		return rep, fmt.Errorf("removing the previous %s: %w", BackupMetaFile, err)
	}

	// Everything the snapshot names is present and checked. Publish it: rename
	// over the previous database, then fsync the directory so the rename is
	// durable. This is the first and only moment the previous backup stops
	// being the one dbPath names.
	if err := os.Rename(stagedDB, dbPath); err != nil {
		return rep, err
	}
	if err := fsync.Dir(destDir); err != nil {
		return rep, fmt.Errorf("flushing the backup directory: %w", err)
	}

	// Where a crash costs a coverage file and nothing else. The database is
	// published and verified; what is missing is the summary of it, and the
	// next run writes that. The test uses this hook rather than a real crash.
	if s.afterPublish != nil {
		if err := s.afterPublish(); err != nil {
			return rep, err
		}
	}

	// The stamp is taken from the published database, so backup.json names the
	// file it is actually beside.
	stamp, err := DatabaseStamp(destDir)
	if err != nil {
		return rep, fmt.Errorf("describing the published snapshot: %w", err)
	}
	meta.Database = stamp
	if err := writeBackupMeta(destDir, meta); err != nil {
		return rep, fmt.Errorf("writing %s: %w", BackupMetaFile, err)
	}
	rep.Meta = meta
	return rep, nil
}

// A destination once served by a process that crashed may still need its WAL
// or rollback journal. Publishing a new database beside those files lets
// SQLite replay old pages over a snapshot we just verified. Keep the recovery
// copy intact; the caller holds its exclusive data lock throughout this check
// and publication, so another Trew process cannot create a journal here.
func refuseDestinationRecovery(destDir string) error {
	dbPath, _ := DataDir(destDir)
	for _, suffix := range []string{"-wal", "-journal"} {
		p := dbPath + suffix
		info, err := os.Stat(p)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("checking destination SQLite recovery state: %w", err)
		}
		if !info.Mode().IsRegular() || info.Size() > 0 {
			return fmt.Errorf("backup destination has SQLite recovery state at %s; "+
				"keep this directory intact and choose a fresh backup directory", p)
		}
	}
	return nil
}

// distinctChunkCount is how many distinct bodies this store's entries
// reference, across every vault. It is what a backup's chunk tree needs to
// hold; anything beyond it is retained history rather than a fault.
func (s *Store) distinctChunkCount() (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM (SELECT DISTINCT vault_id, name FROM entry_chunks)`).Scan(&n)
	return n, err
}

// syncFile flushes a file's contents to disk. The counterpart to fsync.Dir,
// which flushes the name: a backup's database needs both, because VACUUM INTO
// leaves it unsynced. It stays here because this is its only caller; the
// directory flush moved out when three packages wanted it.
func syncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// refuseOverlap refuses a backup destination that would write into the store
// being backed up (S15).
//
// A string comparison is not enough. `data`, `data/`, a relative path, or a
// symlink can all name the same place, and the destination need not equal the
// data directory to do harm: a destination inside the chunk tree, or one that
// contains it, pollutes the live store with a snapshot and copied bodies before
// the command fails. So both paths are resolved to their real, absolute form
// and checked for containment either way. A path can be resolved even when it
// does not exist yet, by resolving the deepest ancestor that does. An ordinary
// child of the data directory, such as data/backup, is fine and is allowed: it
// overlaps neither the database nor the chunk tree.
func (s *Store) refuseOverlap(destDir string) error {
	dest, err := resolvePath(destDir)
	if err != nil {
		return err
	}
	dataDir := filepath.Dir(s.dbPath)
	resolvedData, err := resolvePath(dataDir)
	if err != nil {
		return err
	}
	// The whole data directory, named exactly, gets its own message: it is the
	// mistake someone actually makes, and "is the data directory itself" says
	// more than "overlaps" would. A child of the data directory is not this and
	// is allowed below.
	if dest == resolvedData {
		return fmt.Errorf("backup destination %s is the data directory itself", destDir)
	}
	// The pieces a backup must not touch. A child of the data directory such as
	// data/backup overlaps none of these and is fine; the chunk tree, the
	// database and the two lock files are what a destination inside the data
	// directory could still collide with. The lock names are dirlock's; they
	// are spelled out rather than imported to keep this package free of that
	// dependency, and a test would catch them drifting.
	for _, live := range []struct{ path, what string }{
		{filepath.Join(dataDir, chunkDirName), "the live chunk tree"},
		{s.dbPath, "the live database"},
		{filepath.Join(dataDir, "server.lock"), "the server lock"},
		{filepath.Join(dataDir, "data.lock"), "the data lock"},
	} {
		resolved, err := resolvePath(live.path)
		if err != nil {
			return err
		}
		if overlaps(dest, resolved) {
			return fmt.Errorf("backup destination %s overlaps %s (%s)", destDir, live.what, resolved)
		}
	}
	return nil
}

// ResolveForLock returns a path's real, absolute form, so a directory cannot be
// locked under one name and written under another. A destination that does not
// exist yet resolves to the place it will be.
func ResolveForLock(path string) (string, error) { return resolvePath(path) }

// RefuseSamePlace refuses a backup directory that is, contains, or is contained
// by a data directory, following symlinks and relative paths on both sides.
//
// `refuseOverlap` above answers this for a backup being written. The same
// question has to be asked of a backup being *read* as proof that a purge is
// safe, and it was not: `trew purge -backup` accepted the store's own data
// directory, compared its maximum uid against itself, found it equal, and
// reported that the history it had just destroyed was safely held by the
// directory it had destroyed it in. Aliases do it too, so this resolves rather
// than compares strings.
func RefuseSamePlace(backupDir, dataDir string) error {
	backup, err := resolvePath(backupDir)
	if err != nil {
		return err
	}
	data, err := resolvePath(dataDir)
	if err != nil {
		return err
	}
	if backup == data {
		return fmt.Errorf(
			"the backup at %s is this store's own data directory, so it is not a backup of "+
				"anything; nothing was purged", backupDir)
	}
	if overlaps(backup, data) {
		return fmt.Errorf(
			"the backup at %s and the data directory %s contain one another, so one is not an "+
				"independent copy of the other; nothing was purged", backupDir, dataDir)
	}
	return nil
}

// overlaps reports whether either path is the other or contains it.
func overlaps(a, b string) bool {
	return a == b || isUnder(a, b) || isUnder(b, a)
}

// isUnder reports whether child is inside parent, by path segments rather than
// by prefix, so /data-backup is not taken to be under /data.
func isUnder(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolvePath returns path's real, absolute form, following symlinks. When the
// path itself does not exist yet, its deepest existing ancestor is resolved and
// the missing tail appended, so a not-yet-created destination is still compared
// as the place it will be.
func resolvePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	rest := ""
	for {
		resolved, err := filepath.EvalSymlinks(abs)
		if err == nil {
			return filepath.Join(resolved, rest), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			// Reached the root without finding anything that exists, which on a
			// normal filesystem cannot happen. Fall back to the lexical path.
			return filepath.Join(abs, rest), nil
		}
		rest = filepath.Join(filepath.Base(abs), rest)
		abs = parent
	}
}

// Names of the two things a data directory holds, so the backup writes a
// directory the server can be pointed straight at.
const (
	dbFileName   = Product + ".db"
	chunkDirName = "chunks"
)

// DataDir returns the paths a data directory is made of. One definition, so a
// backup cannot write a layout the server does not read.
func DataDir(dir string) (dbPath, chunkDir string) {
	return filepath.Join(dir, dbFileName), filepath.Join(dir, chunkDirName)
}

// splitInheritedFaults says which of a backup's faults its source has too.
//
// Only the metadata ones can be inherited: an entry row and a registry row are
// copied verbatim by `VACUUM INTO`, so a malformed one in the destination was
// malformed in the source and no backup can mend it. A missing or corrupt body
// is this operation's own work and is never excused.
//
// Matched on vault, uid, row and reason rather than on the whole fault,
// because the path is the only other field and a copy cannot have changed it
// without the digest check upstream already refusing; the detail is a
// sentence, and a sentence that names a time is not the same in both.
func (s *Store) splitInheritedFaults(found []Fault, deep bool) (inherited, blocking []Fault, err error) {
	if len(found) == 0 {
		return nil, nil, nil
	}
	source := map[string]struct{}{}
	entryFaults, _, err := s.verifyEntries()
	if err != nil {
		return nil, nil, err
	}
	for _, f := range entryFaults {
		source[faultKey(f)] = struct{}{}
	}
	// The operation log is rows too, copied as verbatim as the entries are,
	// and every pass reads it; a pin whose version the source had already
	// lost is lost in the copy for the same reason.
	opFaults, _, err := s.verifyOplog()
	if err != nil {
		return nil, nil, err
	}
	for _, f := range opFaults {
		source[faultKey(f)] = struct{}{}
	}
	if deep {
		registryFaults, _, err := s.verifyRegistry()
		if err != nil {
			return nil, nil, err
		}
		for _, f := range registryFaults {
			source[faultKey(f)] = struct{}{}
		}
	}
	for _, f := range found {
		if _, same := source[faultKey(f)]; same {
			inherited = append(inherited, f)
			continue
		}
		blocking = append(blocking, f)
	}
	return inherited, blocking, nil
}

// faultKey names a fault for that match. The row is part of it: the faults
// that name no entry, a registry row's or an operation's, all have uid zero,
// and without the row one operation's fault in the source would excuse a
// different operation's in the copy.
func faultKey(f Fault) string {
	return fmt.Sprintf("%s\x00%d\x00%s\x00%s", f.VaultID, f.UID, f.Row, f.Reason)
}
