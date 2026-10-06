package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/waynehoover/trewsync/internal/archive"
	"github.com/waynehoover/trewsync/internal/dirlock"
	"github.com/waynehoover/trewsync/internal/doctor"
	"github.com/waynehoover/trewsync/internal/store"
)

// The encrypted backup (PLAN.md section 3.6): `trewd backup -encrypt-to`,
// the key for it (`trewd backup-key`), and the way back (`trewd unpack`).

// stagingDirName is where an encrypted backup is staged: an ordinary backup
// directory inside the data directory, where the plaintext already is, kept
// between runs so the next one copies only new bodies. Only ciphertext
// leaves the data directory. After each pack it holds only what the archive
// holds (archive.Prune), so a purge reaches it at the next backup. It can be
// removed whenever no backup is running, with the server running or not; the
// next encrypted backup makes it again.
const stagingDirName = "backup-staging"

// backupEncrypted stages a verified backup inside the data directory and packs
// it as one age archive at to.
func backupEncrypted(st *store.Store, dataDir, to string, deep bool, recipients []age.Recipient, out io.Writer) (doctor.BackupRecord, error) {
	rec := doctor.BackupRecord{To: to, Deep: deep, Encrypted: true}
	// Nothing but an earlier archive is written over (T35), and that is asked
	// before anything is staged.
	if err := archive.CheckDestination(to); err != nil {
		return rec, err
	}
	if err := store.RefuseInside(to, dataDir); err != nil {
		return rec, err
	}
	staging := filepath.Join(dataDir, stagingDirName)
	if err := store.CheckBackupDestination(staging); err != nil {
		return rec, err
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return rec, err
	}
	lock, err := dirlock.Exclusive(staging, dirlock.Data, "backup")
	if err != nil {
		return rec, locked(err, staging, "backup", "Another encrypted backup is running from this data directory.")
	}
	defer lock.Release()

	rep, err := st.Backup(staging, deep)
	if err != nil {
		fmt.Fprintln(out, rep)
		return rec, fmt.Errorf("staging the backup: %w", err)
	}
	packed, err := archive.Pack(staging, to, recipients)
	if err != nil {
		return rec, fmt.Errorf("packing the encrypted backup: %w", err)
	}
	rec.Verified, rec.Operations, rec.Pins = rep.Verified, rep.Oplog.Operations, rep.Oplog.Pins
	for _, v := range rep.Meta.Vaults {
		rec.LatestUID = max(rec.LatestUID, v.LatestUID)
	}
	rec.Bytes, rec.SHA256, rec.TakenAt = packed.Bytes, packed.SHA256, packed.Manifest.TakenAt

	fmt.Fprintf(out, "encrypted backup written to %s\n", to)
	fmt.Fprintf(out, "  %d bodies (%s) and the database, verified in the staging copy at %s\n",
		packed.Manifest.Bodies, humanBytes(packed.Manifest.BodyBytes), staging)
	// The archive is written; now the staging copy drops what it did not
	// archive, which after a purge is the purged history in plaintext. A
	// failure here does not undo a good archive, so it is said loudly rather
	// than recorded as a failed backup.
	if pruned, err := archive.Prune(staging); err != nil {
		fmt.Fprintf(out, "  WARNING: %v\n  bodies the archive does not hold may be left in plaintext in %s: "+
			"remove that directory while no backup runs (the next backup makes it again)\n", err, staging)
	} else if pruned.Bodies > 0 {
		fmt.Fprintf(out, "  %d purged bodies removed from the staging copy (%s)\n", pruned.Bodies, humanBytes(pruned.Bytes))
	}
	fmt.Fprintf(out, "  %s of ciphertext to %d recipients, sha256 %s\n", humanBytes(packed.Bytes), len(recipients), packed.SHA256)
	for _, v := range rep.Meta.Vaults {
		fmt.Fprintf(out, "  vault %q holds uids %d to %d (%d versions), purge generation %d\n",
			v.Vault, v.OldestUID, v.LatestUID, v.Versions, v.Purges)
	}
	if rep.InvitesLeftOut > 0 {
		fmt.Fprintf(out, "  (%d outstanding invites were left out: make a new one after restoring)\n", rep.InvitesLeftOut)
	}
	if o := rep.Oplog; o.Operations > 0 {
		fmt.Fprintf(out, "  %d agent operations carried, with %d before-image pins\n", o.Operations, o.Pins)
	}
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Only the holder of the identity for one of those recipients can read it. Keep that identity")
	fmt.Fprintln(out, "somewhere the backup is not: a backup whose key is lost with it restores nothing.")
	fmt.Fprintf(out, "\nTo restore: trewd unpack -from %s -identity KEY -to NEW_DIRECTORY\n", to)
	return rec, nil
}

// recordBackup writes the backup record, keeping when the last good one
// finished across a failure. A record that cannot be written is said and does
// not fail the backup, which has already succeeded or failed on its own.
func recordBackup(dataDir string, rec doctor.BackupRecord, err error, out io.Writer) {
	var prev doctor.BackupRecord
	_, _ = doctor.ReadRecord(dataDir, doctor.BackupRecordFile, &prev)
	rec.At = time.Now().UnixMilli()
	rec.OK = err == nil
	if err != nil {
		rec.Error = firstLine(err.Error())
		rec.LastOK = prev.LastOK
	} else {
		rec.LastOK = rec.At
	}
	if werr := doctor.WriteRecord(dataDir, doctor.BackupRecordFile, rec); werr != nil {
		fmt.Fprintf(out, "(the backup record in %s could not be written, so `trewd doctor` will not see this run: %v)\n",
			dataDir, werr)
	}
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

/* ---------------------------------------------------------------- *
 * backup-key
 * ---------------------------------------------------------------- */

// cmdBackupKey makes the age identity an encrypted backup is read with, and
// prints the recipient to encrypt to. Post-quantum (ML-KEM-768 with X25519)
// by default, because a backup may be read years after it is taken; -x25519
// makes the classic key, whose recipient is short enough to type.
func cmdBackupKey(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("backup-key", flag.ContinueOnError)
	outFile := fs.String("out", "", "where to write the identity, mode 0600; the recipient goes beside it as FILE.pub")
	classic := fs.Bool("x25519", false, "make a classic X25519 key rather than a post-quantum one")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *outFile == "" {
		return errors.New("backup-key needs -out FILE, where the identity is written")
	}
	var secret, recipient string
	if *classic {
		id, err := age.GenerateX25519Identity()
		if err != nil {
			return err
		}
		secret, recipient = id.String(), id.Recipient().String()
	} else {
		id, err := age.GenerateHybridIdentity()
		if err != nil {
			return err
		}
		secret, recipient = id.String(), id.Recipient().String()
	}
	body := fmt.Sprintf("# created: %s\n# public key: %s\n%s\n", time.Now().UTC().Format(time.RFC3339), recipient, secret)
	if err := writeNewKeyFile(*outFile, body); err != nil {
		return err
	}
	pub := *outFile + ".pub"
	if err := writeNewKeyFile(pub, recipient+"\n"); err != nil {
		return fmt.Errorf("the identity is at %s, and its recipient could not be written: %w", *outFile, err)
	}
	fmt.Fprintf(out, "wrote the identity to %s and its recipient to %s\n", *outFile, pub)
	fmt.Fprintf(out, "  trewd backup -to /srv/trew-backups/trew.tar.age -recipients-file %s\n", pub)
	fmt.Fprintln(out, "Keep the identity off this server, and a second copy somewhere else: it is the only thing")
	fmt.Fprintln(out, "that reads the backups, and nothing can recover it.")
	return nil
}

// writeNewKeyFile writes content as writeSecretFile does, atomically at mode
// 0600 and read back, and refuses a path that already holds a file:
// overwriting an identity would make every backup encrypted to it unreadable.
// The write itself is exclusive too (writeNewSecretFile), so a file that
// appears after the check is refused rather than replaced.
func writeNewKeyFile(path, content string) error {
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("%s exists, and a key is never written over: choose another name", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeNewSecretFile(path, content)
}

/* ---------------------------------------------------------------- *
 * unpack
 * ---------------------------------------------------------------- */

// cmdUnpack decrypts an encrypted backup into a new data directory and
// verifies it deeply: the first step of every restore from one, and of the
// rehearsal. It writes only into a directory that is new or empty.
func cmdUnpack(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("unpack", flag.ContinueOnError)
	from := fs.String("from", "", "the encrypted backup, as `trewd backup -encrypt-to` wrote it")
	identity := fs.String("identity", "", "the age identity file the backup is read with")
	to := fs.String("to", "", "a new or empty directory to write the data directory into")
	record := fs.String("record", "", "a data directory (or its last-backup.json) whose last backup this archive must be")
	other := fs.Bool("not-last-backup", false, "unpack an archive that is not the recorded last backup, with a warning")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *from == "" || *identity == "" || *to == "" {
		return errors.New("unpack needs -from FILE, -identity KEY and -to NEW_DIRECTORY")
	}
	origin, err := checkArchiveOrigin(*from, *record, *other, out)
	if err != nil {
		return err
	}
	rep, err := unpackArchive(*from, *identity, *to)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "unpacked %s into %s: %d bodies (%s) and the database, each checked against the manifest\n",
		*from, *to, rep.Manifest.Bodies, humanBytes(rep.Manifest.BodyBytes))
	fmt.Fprintf(out, "  the snapshot was taken %s; the archive is %s, sha256 %s\n",
		rep.Manifest.TakenAt, humanBytes(rep.Bytes), rep.SHA256)
	if err := origin.after(rep, out); err != nil {
		return err
	}
	if err := upgradeCopy(*to); err != nil {
		return err
	}
	return cmdVerify([]string{"-deep", "-data", *to}, out)
}

// upgradeCopy brings a store this command has just made, by unpacking or
// copying a backup into a new directory, to this build's schema before it is
// checked (T28).
//
// Inspection never migrates, and refuses a store older than this build rather
// than read it wrongly, so an archive an older build made could not be
// verified at all: unpack ended in `no such table: operations` on a store
// that serve upgrades without a word. The copy is this command's own, nothing
// serves it and nothing else has it open, so upgrading it is what serve would
// do to it first anyway, done before rather than after the check.
func upgradeCopy(dir string) error {
	dbPath, chunkDir := store.DataDir(dir)
	st, err := store.OpenMode(dbPath, chunkDir, store.Existing, store.SyncFull)
	if err != nil {
		return fmt.Errorf("upgrading the store unpacked into %s to this build's schema: %w", dir, err)
	}
	return st.Close()
}

// archiveOrigin is what checkArchiveOrigin found out about an archive before
// it was decrypted, for after to finish once the manifest can be read.
type archiveOrigin struct {
	digest  string
	rec     doctor.BackupRecord
	known   bool // there was an encrypted backup on record to compare with
	matched bool // and the archive is it
}

// checkArchiveOrigin compares an archive with the backup a data directory
// last recorded, before anything is decrypted.
//
// The recipient an archive is encrypted to is public by design, and sits on
// the server, so an archive that opens with the identity may have been made
// by anyone who could read it, holding whatever store they chose. The backup
// record holds the digest and snapshot time of the archive this server did
// write. The same digest is that archive. Another is refused unless other
// says it is meant (an older backup, say), and then warned about; no record
// to compare with is said, since a restore after a disaster may have lost the
// directory the record was in.
func checkArchiveOrigin(from, recordAt string, other bool, out io.Writer) (archiveOrigin, error) {
	var o archiveOrigin
	digest, err := archive.FileSHA256(from)
	if err != nil {
		return o, err
	}
	o.digest = digest
	unchecked := func(why string) {
		fmt.Fprintf(out, "NOTE: %s (sha256 %s) is not compared with any backup record%s. Anyone holding its recipient "+
			"can make an archive this identity opens: check that digest against the one `trewd backup` printed, "+
			"or pass -record DATA_DIR.\n", from, digest, why)
	}
	if recordAt == "" {
		unchecked("")
		return o, nil
	}
	dir, name := recordAt, doctor.BackupRecordFile
	if info, err := os.Stat(recordAt); err == nil && !info.IsDir() {
		dir, name = filepath.Dir(recordAt), filepath.Base(recordAt)
	}
	found, err := doctor.ReadRecord(dir, name, &o.rec)
	if err != nil {
		return o, fmt.Errorf("the backup record in %s: %w", dir, err)
	}
	if !found || !o.rec.Encrypted || o.rec.SHA256 == "" {
		unchecked(": " + dir + " records no encrypted backup")
		return o, nil
	}
	o.known = true
	if digest == o.rec.SHA256 {
		o.matched = true
		fmt.Fprintf(out, "%s is the backup this data directory last recorded (sha256 %s, snapshot taken %s)\n",
			from, digest, o.rec.TakenAt)
		return o, nil
	}
	why := fmt.Sprintf("%s is not the backup this data directory last recorded: its sha256 is %s, and %s records "+
		"%s, written to %s, snapshot taken %s. Anyone holding the recipient can make an archive the identity opens",
		from, digest, dir, o.rec.SHA256, o.rec.To, o.rec.TakenAt)
	if !other {
		return o, errors.New(why + ". If it is another backup of this server you mean to use (an older one, say), " +
			"pass -not-last-backup")
	}
	fmt.Fprintf(out, "WARNING: %s; going ahead because -not-last-backup was given.\n", why)
	return o, nil
}

// after finishes the check once the archive has been read: the bytes
// decrypted are the bytes compared, and the snapshot time agrees with the
// record's (or, for an archive let through as another, is said beside it).
func (o archiveOrigin) after(rep archive.Report, out io.Writer) error {
	if rep.SHA256 != o.digest {
		return fmt.Errorf("the archive changed while it was being read: sha256 %s before, %s as unpacked", o.digest, rep.SHA256)
	}
	switch {
	case o.matched && o.rec.TakenAt != "" && rep.Manifest.TakenAt != o.rec.TakenAt:
		return fmt.Errorf("the archive has the recorded digest, and its manifest says the snapshot was taken %s "+
			"where the record says %s: the record does not describe it", rep.Manifest.TakenAt, o.rec.TakenAt)
	case o.known && !o.matched:
		fmt.Fprintf(out, "WARNING: this archive's snapshot was taken %s; the recorded backup's was taken %s\n",
			rep.Manifest.TakenAt, o.rec.TakenAt)
	}
	return nil
}

// unpackArchive is unpack without the printing, for the rehearsal.
func unpackArchive(from, identity, to string) (archive.Report, error) {
	ids, err := archive.ParseIdentities(identity)
	if err != nil {
		return archive.Report{}, err
	}
	f, err := os.Open(from)
	if err != nil {
		return archive.Report{}, err
	}
	defer f.Close()
	rep, err := archive.Unpack(f, ids, to)
	if err != nil {
		return rep, fmt.Errorf("unpacking %s: %w", from, err)
	}
	return rep, nil
}
