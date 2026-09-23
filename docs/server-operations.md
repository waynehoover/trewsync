# Maintain your Trew server

[Documentation](index.md) · [Server setup](server.md) · [Command reference](server-reference.md)

Keep independent backups, monitor available disk space, and test restoration
before you need it. These examples use `/var/lib/trew` for server data and
`/srv/trew-backup` for a backup. Substitute your actual paths and run
`trew` as an account with access to them.

## Backup

Back up the server while it is running:

```bash
trewd backup -data /var/lib/trew -to /srv/trew-backup
trewd verify -deep -data /srv/trew-backup
```

`backup` copies the database and the stored content it refers to, including
history, and verifies the result. Reusing a destination copies content
incrementally and replaces its database snapshot only after a successful copy.
If copying fails, the previous completed snapshot stays in place.

A backup carries the devices and no outstanding invite: restoring an old copy
must not bring back an invite that has since been used or cancelled, so
`backup` says how many it left out.

If a destination has unfinished SQLite recovery from an earlier server run,
backup refuses to replace it. Keep that directory intact and choose a fresh
backup directory; do not remove its journal files to bypass the refusal.

For Compose:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/trew-backups
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trewd backup -to /backup/snapshot
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trewd verify -deep -data /backup/snapshot
```

The destination must be outside the data directory; Trew refuses nested
backups. These commands use the image's default user, 65532. Adjust ownership
if your deployment uses another account. Copy the verified snapshot to another
disk or backup host as well.

**A backup is a readable copy of every note.** The server holds notes and
their history in plaintext, and so does every backup of it: anyone who can read
the backup directory can read the vault. Keep backups on encrypted storage,
including backups that stay on the same machine, and treat the backup host
like the server. Also back up the ordinary Markdown files on a device for a
copy independent of Trew.

### Schedule backups

A nightly job should run backup, verification, and transfer **in that order**,
copying only after the earlier commands succeed. For example, a cron job or
systemd oneshot can run:

```bash
trewd backup -data /var/lib/trew -to /srv/trew-backup && \
  trewd verify -data /srv/trew-backup && \
  rsync -a /srv/trew-backup/ offsite:/backups/trew/
```

Configure the remote path and credentials for the account running the job.
Prevent overlapping jobs, and do not modify the backup while it is being
transferred. Use `-deep` periodically to check existing content for corruption.
Do not copy the live database with ordinary file-copy tools.

Keep dated or otherwise separate backup generations when you need older
snapshots. Updating one destination is not a retention policy for old databases.

### Preserve history before a purge

Before purging, make a **separate backup directory** and leave it untouched for
as long as you want the old history.

Reusing a backup directory after a purge replaces its database with the
post-purge snapshot. Old content files may remain there, but without the old
version records they are not a usable history archive. Retaining a complete
pre-purge database and its content together is what preserves restoration.

`backup.json` records the snapshot date, database identity, version range, and
purge generation. It helps identify a backup; `trewd verify -deep` checks
its actual contents. A newer date or matching version number alone does not
prove that an older note is recoverable.

## Restore rehearsal

Use a fresh directory and a separate port, keeping production devices pointed
at the live server:

```bash
rsync -a offsite:/backups/trew/ /tmp/trew-restore-test/
trewd verify -deep -data /tmp/trew-restore-test
trewd stats -json -data /tmp/trew-restore-test
trewd serve -data /tmp/trew-restore-test -addr 127.0.0.1:3004
```

Proceed only if verification succeeds and the reported vault and version range
match the backup you intended to restore. Confirm that the server starts, then
stop the test server. Retain the backup; remove only the temporary rehearsal
copy when finished.

These checks cover storage and startup. A full recovery check also pairs a
throwaway client against the rehearsal server and reads restored notes: while
it runs, `trewd invite -data /tmp/trew-restore-test -url ws://127.0.0.1:3004`
prints an invite for it. Do not repoint a production device casually to a
rehearsal copy. You can also read one note without any client:
`trewd cat -data /tmp/trew-restore-test -path "Notes/Meeting.md"`. The project's
CI runs an automated restore-and-readback test, but cannot validate your disk or
offsite backup.

## Restore

Stop the server and pause client sync before replacing server data. Preserve
the failed directory, verify the restored copy, and check its ownership before
starting it. For a systemd installation:

```bash
sudo systemctl stop trew
sudo mv /var/lib/trew /var/lib/trew.before-restore
sudo rsync -a offsite:/backups/trew/ /var/lib/trew/
sudo chown -R trew:trew /var/lib/trew
sudo -u trew /usr/local/bin/trewd verify -deep -data /var/lib/trew
```

Use a new preservation path if `trew.before-restore` already exists. Run the
commands one at a time and stop on an error. **Only after verification succeeds:**

```bash
sudo systemctl start trew
```

For Docker, stop the container, preserve its existing data, and restore the
verified backup into its data volume. Restore ownership to `65532:65532` and
verify it with the same server image before starting. Do not restore over a
running server or delete its volume as part of the procedure.

A snapshot made by `trewd backup` has a store epoch of its own, so restoring
one starts a new history as far as the devices are concerned. Each device
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
device that has seen newer versions then stops with a `cursor` error. Preserve
its local notes and take a backup of the server, then:

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
trewd backup -data /var/lib/trew -to /srv/trew-before-purge
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
  trewd backup -to /backup/before-purge
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trewd verify -deep -data /backup/before-purge
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trewd purge -confirm default -backup /backup/before-purge -grace 0
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

| Signal | Action |
|---|---|
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
