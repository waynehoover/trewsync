# Maintain your TrewSync server

[Documentation](index.md) · [Server setup](server.md) · [Command reference](server-reference.md)

Keep independent backups, monitor available disk space, and test restoration
before you need it. These examples use `/var/lib/trew` for server data and
`/srv/trew-backups` for backups. Substitute your actual paths and run
`trewd` as an account with access to them. When something looks wrong, start
with `trewd doctor`; [Operating TrewSync](operations.md) is the guide for the
bad night.

## Backup

A backup is encrypted to an age key you make once, and keep somewhere the
server and its backups are not:

```bash
trewd backup-key -out ~/trew-backup-key     # on your own machine, not the server
scp ~/trew-backup-key.pub server:/etc/trew/backup-key.pub
```

Then back up the server while it is running:

```bash
trewd backup -data /var/lib/trew -to /srv/trew-backups/trew.tar.age \
  -recipients-file /etc/trew/backup-key.pub
```

`backup` copies the database and the stored content it refers to, including
history, verifies the copy, and writes it as one encrypted archive. Only the
archive leaves the data directory: the copy is staged in
`/var/lib/trew/backup-staging`, beside the notes it copies, which also makes
the next backup copy only new content. If the backup fails, the previous
archive at the destination stays in place. `trewd backup` refuses to write a
backup at all until it is told which kind: `-encrypt-to` or
`-recipients-file`, or `-plaintext-ok` for a plaintext data directory, which
anyone who can read it can read.

A backup carries the devices and no outstanding invite: restoring an old copy
must not bring back an invite that has since been used or cancelled, so
`backup` says how many it left out.

After `trewd update`, restart the server before the next backup. A backup
never upgrades the store it copies: it refuses a store an older build wrote,
since the server still running that build would then meet a store it no
longer reads, and says to restart the server, which upgrades it.

If a plaintext destination has unfinished SQLite recovery from an earlier
server run, backup refuses to replace it. Keep that directory intact and choose
a fresh backup directory; do not remove its journal files to bypass the
refusal.

For Compose:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/trew-backups
docker compose run --rm --no-deps -v /srv/trew-backups:/backup -v /etc/trew:/keys:ro \
  trewd backup -to /backup/trew.tar.age -recipients-file /keys/backup-key.pub
```

The destination must be outside the data directory; TrewSync refuses nested
backups. These commands use the image's default user, 65532. Adjust ownership
if your deployment uses another account. Copy the archive to another disk or
backup host as well: the `sha256` the backup prints lets you check the copy
without the key.

**Without encryption a backup is a readable copy of every note.** The server
holds notes and their history in plaintext, and so would a plaintext backup:
anyone who can read it can read the vault. That is why a backup is encrypted
unless you pass `-plaintext-ok`, including one that stays on the same machine.
Also back up the ordinary Markdown files on a device for a copy independent of
TrewSync.

### Schedule backups

A nightly job should run the backup, which verifies its copy, and then the
transfer, **in that order**, copying only after the backup succeeds. For
example, a cron job or systemd oneshot can run:

```bash
trewd backup -data /var/lib/trew -to /srv/trew-backups/trew.tar.age \
    -recipients-file /etc/trew/backup-key.pub && \
  rsync -a /srv/trew-backups/trew.tar.age offsite:/backups/trew/
```

Configure the remote path and credentials for the account running the job.
Prevent overlapping jobs, and do not modify the backup while it is being
transferred. Use `-deep` periodically to check existing content for corruption:
a deep backup replaces a body that has rotted in the backup since an earlier
run with the source's copy, keeps the rotted one aside as quarantined, and
says so. A shallow backup does not read what the backup already holds.
Do not copy the live database with ordinary file-copy tools.

Keep dated or otherwise separate backup generations when you need older
snapshots, such as `trew-$(date +%F).tar.age`. Replacing one archive is not a
retention policy for old ones. `trewd doctor` warns when the last good backup
is more than two days old, and fails when the last one failed.

### Preserve history before a purge

Before purging, make a **separate backup** and leave it untouched for as long
as you want the old history. An encrypted archive taken before the purge keeps
that history whole. Purge itself checks a plaintext backup directory, so the
pre-purge copy it checks is taken with `-plaintext-ok`, onto encrypted
storage, and kept as its own directory.

Reusing a backup directory after a purge replaces its database with the
post-purge snapshot. Old content files may remain there, but without the old
version records they are not a usable history archive. Retaining a complete
pre-purge database and its content together is what preserves restoration.

`backup.json` records the snapshot date, database identity, version range, and
purge generation. It helps identify a backup; `trewd verify -deep` checks
its actual contents. A newer date or matching version number alone does not
prove that an older note is recoverable.

## Restore rehearsal

A backup nobody has restored is a rumour. `trewd rehearse` restores one where
no production device can reach it and proves it:

```bash
trewd rehearse -data /var/lib/trew -backup /srv/trew-backups/trew.tar.age -identity ~/trew-backup-key
```

It decrypts the archive into a directory of its own inside the data
directory, verifies it deeply, compares it with every version the live store
holds up to the backup's newest version, serves it on a loopback port, pairs a
new device to it that downloads every note and compares each byte for byte,
rebuilds the search index, and prints how long it all took and how old the
backup is. Before it decrypts anything it compares the archive's SHA-256 with
the last backup the data directory recorded, and refuses any other archive
unless `-not-last-backup` says it is meant to be another (an older backup,
say), which it then warns about. The work directory is removed afterwards; the
backup is never touched. The result is recorded for `trewd doctor`, which warns when no
rehearsal has passed in 90 days.

[Operating TrewSync](operations.md#rehearse-a-restore) has the steps to do it
by hand once, which is worth doing: a rehearsal you have watched is the one you
will trust at 2am. The project's CI rehearses an encrypted backup on every
change, but cannot validate your disk, your key or your offsite copy.

## Restore

Stop the server and pause client sync before replacing server data. Preserve
the failed directory, unpack the backup into a fresh one (unpack verifies it
deeply), and check its ownership before starting it. For a systemd
installation:

```bash
sudo systemctl stop trew
sudo mv /var/lib/trew /var/lib/trew.before-restore
sudo trewd unpack -from /srv/trew-backups/trew.tar.age -identity ~/trew-backup-key -to /var/lib/trew \
  -record /var/lib/trew.before-restore
sudo cp -a /var/lib/trew.before-restore/git-export /var/lib/trew/   # with the Git export on
sudo chown -R trew:trew /var/lib/trew
sudo -u trew /usr/local/bin/trewd verify -deep -data /var/lib/trew
```

From a plaintext backup directory, copy it into place instead of unpacking
(`sudo rsync -a offsite:/backups/trew/ /var/lib/trew/`). Never start the server
on the backup directory itself: it would be a live store, and the next backup
into it is refused.

A backup carries the server's settings (`trewd.json`): the Git export's and
the daily notes'. A copied plaintext backup brings them back as they were, and
so does unpack when `-record` shows the archive is the recorded backup.
Without that check, unpack sets them aside as `trewd.json.from-backup`, unused,
because settings name where the Git export pushes every note: read them,
the remote above all, and rename the file to `trewd.json` to use them.

The [Git export](git-export.md)'s own repository is not in a backup. Copy
`git-export/` across from the preserved directory, as above, before the first
start, and the export adds one commit marked `Restore:` and goes on. Without
it the export starts a new repository, and its first push is refused, since the
remote's branch holds commits it did not make: copy it across then (with the
server stopped, replacing the new one), or export to a new branch with `trewd
git-export set -branch NAME`.

**An archive that decrypts is not proof that this server wrote it.** The
recipient is public by design and sits on the server, so anyone who can read
it can make an archive your identity opens, holding whatever notes they
choose. Check the archive is the backup you took before restoring from it:
pass `-record /var/lib/trew.before-restore` (the preserved directory, or a
copy of its `last-backup.json`) and unpack refuses an archive whose digest is
not the last good one recorded there, unless `-not-last-backup` is given, and
refuses a `-record` that names no record. Without a record, unpack prints the
archive's SHA-256: compare it with the one `trewd backup` printed, or with a
copy of `last-backup.json` kept offsite.

Use a new preservation path if `trew.before-restore` already exists. Run the
commands one at a time and stop on an error. **Only after verification succeeds:**

```bash
sudo systemctl start trew
```

For Docker, stop the container, preserve its existing data, and restore the
verified backup into its data volume. Restore ownership to `65532:65532` and
verify it with the same server image before starting. Do not restore over a
running server or delete its volume as part of the procedure.

A store restored from a `trewd backup` snapshot starts a store epoch of its
own the first time it is served, every time a snapshot is restored, the same
one twice included, so restoring one starts a new history as far as the
devices are concerned. The server's log says so at that start. Each device
notices at its next connection and, with nothing asked of anybody, reads the
restored history as a fresh listing: files that match agree, files that differ
are kept both ways as a conflict copy, files only that device holds are sent
back, and nothing is deleted because the restored history lacks it. Two
consequences to expect: a note deleted after the backup was taken can come
back, and a device revoked after it was taken is back in the device list.
Check `trewd devices` after a restore and revoke that device again. A read-only
mirror does not upload its local changes.

A data directory copied back some other way, such as a filesystem snapshot or
a copy of the live directory, keeps its old epoch with an older history. A
device that has seen newer versions stops with a `cursor` error only while the
copied-back store is behind its cursor: once other devices have written past
that cursor, it is served from there without an error and never receives the
versions in between. So pause sync on every device before starting a store
copied back this way, and before any device writes to it, preserve each
device's local notes, take a backup of the server, then:

- In Obsidian, use **Rejoin this server** and confirm the positions shown.
- In the CLI, run `trew unlink`, then pair again with a new invite.

Repeat for each affected device. Writable clients send locally held versions
back to the server and preserve disagreements as separate copies. Prefer
restoring from `trewd backup` snapshots, which need neither step.

## Repair missing content

If notes repeatedly fail to download, inspect the server:

```bash
trewd verify -deep -data /var/lib/trew
```

When content is missing, use **Send back what the server has lost** in the
plugin, or `trew repair` on a client that still holds the notes. Repair resends
missing content without creating new versions. Repeat on other devices, then
verify the server again.

A device can supply only content it still has. Restore unavailable historical
content from a suitable backup when possible. Purge cannot recreate it and is
not the first recovery step.

## Purge

**Purge permanently removes older versions from the live server.** It keeps
current files and enough history to track moves and deletions, then removes
unused content. Some deleted notes remain recoverable when that history is
needed. Nothing purges automatically.

First inspect how much space it could reclaim:

```bash
trewd stats -data /var/lib/trew
```

Then stop the server, create a separate pre-purge backup, and verify it. For a
systemd installation, run each command in order and stop on any error:

```bash
sudo systemctl stop trew
trewd backup -plaintext-ok -data /var/lib/trew -to /srv/trew-before-purge
trewd verify -deep -data /srv/trew-before-purge
trewd purge -data /var/lib/trew -confirm default -backup /srv/trew-before-purge -grace 0
sudo systemctl start trew
```

The backup path must be writable by the server account. Substitute the actual
vault name for `default`; use `-vault NAME -confirm NAME` for a custom vault.
Keep the pre-purge backup separate from the next scheduled backup.

With the repository's Compose setup, the equivalent maintenance commands reuse
its image and volume:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/trew-backups
docker compose stop trew
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trewd backup -plaintext-ok -to /backup/before-purge
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trew verify -deep -data /backup/before-purge
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trew purge -confirm default -backup /backup/before-purge -grace 0
docker compose start trew
```

Use a fresh backup name and stop on any error. The backup must be outside
`/data`; a path such as `/data/before-purge` is refused. Copy it off the server
as well. These commands use the included Compose installation's data volume.

Purge refuses a running server, a mismatched confirmation, or a backup that does
not meet its checks. The default one-hour grace period retains recent
unreferenced content; `-grace 0` removes that delay on a stopped server. Review
the result for content it could not collect. Do not bypass the backup check
just to make a refusal disappear.

## Monitor the server

`trewd doctor` checks all of this at once and says what to do about each
finding; it exits non-zero when anything needs attention, so a timer can run
it. The running server checks itself too, and logs `msg=alert` with the
remedy when something needs attention.

| Signal | Action |
|---|---|
| `trewd doctor` exits non-zero | Read each `WARN` and `FAIL` line and its `->` remedy. |
| `msg=alert` in the log | The same finding, from the server itself; `msg="alert cleared"` follows when it is fixed. |
| `trewd health` fails | Read the reason and server logs. Check disk space, mounts, and permissions. |
| `nospace` or growing disk usage | Add capacity, or plan a verified backup and purge. |
| `verify` reports missing/corrupt content | Repair from devices or restore from backup. |
| A device stays behind | Check its connection and status; compare the positions shown on devices. |
| Unrecognized device or invite | Review the device list and revoke or cancel it. |
| Service repeatedly fails | Read `journalctl -u trew`. After fixing the cause, use `systemctl reset-failed trew` if required. |
| `batch commit failed` in the log | The server refused a device's work and the device will keep retrying. On 0.8.4 this could repeat forever; 0.8.5 falls back to committing one entry at a time and logs `batch commit failed, committing one at a time` instead. Either line means something is wrong with the store: check disk space and permissions on the data directory. |

Use `trewd stats -json` for storage automation. Check `reclaimComplete` before
using the reclaim estimates; a partial scan cannot give a reliable total.
`store-busy` is temporary contention, not by itself a reason to restart the
server. [Health responses and flags](server-reference.md#health) are listed
in the reference.

## Devices and invites from the server

The server host can do everything a device's panel can, which is also the way
back in when no device is left:

```bash
trewd devices -data /var/lib/trew
trewd revoke -data /var/lib/trew DEVICE_ID
trewd uninvite -data /var/lib/trew INVITE_ID
trewd invite -data /var/lib/trew -url wss://homelab.example.ts.net
```

While the server runs these go through it, so a revoke stops that device at
once. Revoking also cancels the invites that device created. It cannot erase
what the device already holds; see [Security and privacy](security.md).
