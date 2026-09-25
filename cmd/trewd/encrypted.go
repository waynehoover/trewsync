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

	"github.com/waynehoover/trew/internal/archive"
	"github.com/waynehoover/trew/internal/dirlock"
	"github.com/waynehoover/trew/internal/doctor"
	"github.com/waynehoover/trew/internal/store"
)

// The encrypted backup (PLAN.md section 3.6): `trewd backup -encrypt-to`,
// the key for it (`trewd backup-key`), and the way back (`trewd unpack`).

// stagingDirName is where an encrypted backup is staged: an ordinary backup
// directory inside the data directory, where the plaintext already is, kept
// between runs so the next one copies only new bodies. Only ciphertext
// leaves the data directory. It can be removed whenever no backup is running,
// with the server running or not; the next encrypted backup makes it again.
const stagingDirName = "backup-staging"

// backupEncrypted stages a verified backup inside the data directory and packs
// it as one age archive at to.
func backupEncrypted(st *store.Store, dataDir, to string, deep bool, recipients []age.Recipient, out io.Writer) (doctor.BackupRecord, error) {
	rec := doctor.BackupRecord{To: to, Deep: deep, Encrypted: true}
	if info, err := os.Stat(to); err == nil && info.IsDir() {
		return rec, fmt.Errorf("-to %s is a directory: an encrypted backup is one file, such as %s",
			to, filepath.Join(to, "trew-backup.tar.age"))
	}
	if err := store.RefuseSamePlace(filepath.Dir(to), dataDir); err != nil {
		return rec, fmt.Errorf("an encrypted backup inside the data directory is not a copy of it: %w", err)
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
	rec.Bytes, rec.SHA256 = packed.Bytes, packed.SHA256

	fmt.Fprintf(out, "encrypted backup written to %s\n", to)
	fmt.Fprintf(out, "  %d bodies (%s) and the database, verified in the staging copy at %s\n",
		packed.Manifest.Bodies, humanBytes(packed.Manifest.BodyBytes), staging)
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
func writeNewKeyFile(path, content string) error {
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("%s exists, and a key is never written over: choose another name", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeSecretFile(path, content)
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
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *from == "" || *identity == "" || *to == "" {
		return errors.New("unpack needs -from FILE, -identity KEY and -to NEW_DIRECTORY")
	}
	rep, err := unpackArchive(*from, *identity, *to)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "unpacked %s into %s: %d bodies (%s) and the database, each checked against the manifest\n",
		*from, *to, rep.Manifest.Bodies, humanBytes(rep.Manifest.BodyBytes))
	fmt.Fprintf(out, "  the snapshot was taken %s; the archive is %s, sha256 %s\n",
		rep.Manifest.TakenAt, humanBytes(rep.Bytes), rep.SHA256)
	return cmdVerify([]string{"-deep", "-data", *to}, out)
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
