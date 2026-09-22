# Maintain your Telimus server

[Documentation](index.md) · [Server setup](server.md) · [Command reference](server-reference.md)

Keep independent backups, monitor available disk space, and test restoration
before you need it. These examples use `/var/lib/telimus` for server data and
`/srv/telimus-backup` for a backup. Substitute your actual paths and run
`telimus` as an account with access to them.

## Backup

Back up the server while it is running:

```bash
telimus backup -data /var/lib/telimus -to /srv/telimus-backup
telimus verify -deep -data /srv/telimus-backup
```

`backup` copies the database and required encrypted content, including history,
and verifies the result. Reusing a destination copies content incrementally and
replaces its database snapshot only after a successful copy. If copying fails,
the previous completed snapshot stays in place.

If a destination has unfinished SQLite recovery from an earlier server run,
backup refuses to replace it. Keep that directory intact and choose a fresh
backup directory; do not remove its journal files to bypass the refusal.

For Compose:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/telimus-backups
docker compose run --rm --no-deps -v /srv/telimus-backups:/backup \
  telimus backup -to /backup/snapshot
docker compose run --rm --no-deps -v /srv/telimus-backups:/backup \
  telimus verify -deep -data /backup/snapshot
```

The destination must be outside the data directory; Telimus refuses nested
backups. These commands use the image's default user, 65532. Adjust ownership
if your deployment uses another account. Copy the verified snapshot to another
disk or backup host as well.

**Keep the recovery key separately.** The server backup is encrypted. You need
a paired device or the recovery key to read it. Also back up the ordinary
Markdown files on a device for a readable copy independent of Telimus.

### Schedule backups

A nightly job should run backup, verification, and transfer **in that order**,
copying only after the earlier commands succeed. For example, a cron job or
systemd oneshot can run:

```bash
telimus backup -data /var/lib/telimus -to /srv/telimus-backup && \
  telimus verify -data /srv/telimus-backup && \
  rsync -a /srv/telimus-backup/ offsite:/backups/telimus/
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
purge generation. It helps identify a backup; `telimus verify -deep` checks
its actual contents. A newer date or matching version number alone does not
prove that an older note is recoverable.

## Restore rehearsal

Use a fresh directory and a separate port, keeping production devices pointed
at the live server:

```bash
rsync -a offsite:/backups/telimus/ /tmp/telimus-restore-test/
telimus verify -deep -data /tmp/telimus-restore-test
telimus stats -json -data /tmp/telimus-restore-test
telimus serve -data /tmp/telimus-restore-test -addr 127.0.0.1:3004
```

Proceed only if verification succeeds and the reported vault and version range
match the backup you intended to restore. Confirm that the server starts, then
stop the test server. Retain the backup; remove only the temporary rehearsal
copy when finished.

These checks cover storage and startup. A full recovery check also pairs a
throwaway client against a controlled test server and reads restored notes;
do not repoint a production device casually to a rehearsal copy. The project's
CI runs an automated restore-and-readback test, but cannot validate your disk or
offsite backup.

## Restore

Stop the server and pause client sync before replacing server data. Preserve
the failed directory, verify the restored copy, and check its ownership before
starting it. For a systemd installation:

```bash
sudo systemctl stop telimus
sudo mv /var/lib/telimus /var/lib/telimus.before-restore
sudo rsync -a offsite:/backups/telimus/ /var/lib/telimus/
sudo chown -R telimus:telimus /var/lib/telimus
sudo -u telimus /usr/local/bin/telimus verify -deep -data /var/lib/telimus
```

Use a new preservation path if `telimus.before-restore` already exists. Run the
commands one at a time and stop on an error. **Only after verification succeeds:**

```bash
sudo systemctl start telimus
```

For Docker, stop the container, preserve its existing data, and restore the
verified backup into its data volume. Restore ownership to `65532:65532` and
verify it with the same server image before starting. Do not restore over a
running server or delete its volume as part of the procedure.

A device that has seen newer versions than the backup may stop with a `cursor`
error. Preserve its local notes and take a backup of the restored server, then:

- In Obsidian, use **Rejoin this server** and confirm the positions shown.
- In the CLI, inspect with `telimus rebase`, then run
  `telimus rebase --backup-taken`.

Repeat for each affected device. Writable clients send locally held versions
back to the server and preserve disagreements as separate copies. Prefer this
to unlinking and pairing again. A read-only mirror does not upload its local
changes.

## Repair missing content

If notes repeatedly fail to download, inspect the server:

```bash
telimus verify -deep -data /var/lib/telimus
```

When content is missing, use **Send back what the server has lost** in the
plugin, or `telimus repair` on a client that still holds the notes. Repair resends
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
telimus stats -data /var/lib/telimus
```

Then stop the server, create a separate pre-purge backup, and verify it. For a
systemd installation, run each command in order and stop on any error:

```bash
sudo systemctl stop telimus
telimus backup -data /var/lib/telimus -to /srv/telimus-before-purge
telimus verify -deep -data /srv/telimus-before-purge
telimus purge -data /var/lib/telimus -confirm default -backup /srv/telimus-before-purge -grace 0
sudo systemctl start telimus
```

The backup path must be writable by the server account. Substitute the actual
vault name for `default`; use `-vault NAME -confirm NAME` for a custom vault.
Keep the pre-purge backup separate from the next scheduled backup.

With the repository's Compose setup, the equivalent maintenance commands reuse
its image and volume:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/telimus-backups
docker compose stop telimus
docker compose run --rm --no-deps -v /srv/telimus-backups:/backup \
  telimus backup -to /backup/before-purge
docker compose run --rm --no-deps -v /srv/telimus-backups:/backup \
  telimus verify -deep -data /backup/before-purge
docker compose run --rm --no-deps -v /srv/telimus-backups:/backup \
  telimus purge -confirm default -backup /backup/before-purge -grace 0
docker compose start telimus
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
| `telimus health` fails | Read the reason and server logs. Check disk space, mounts, and permissions. |
| `nospace` or growing disk usage | Add capacity, or plan a verified backup and purge. |
| `verify` reports missing/corrupt content | Repair from devices or restore from backup. |
| A device stays behind | Check its connection and status; compare the positions shown on devices. |
| Unrecognized device or invite | Review the device list and revoke or cancel it. |
| Service repeatedly fails | Read `journalctl -u telimus`. After fixing the cause, use `systemctl reset-failed telimus` if required. |
| `batch commit failed` in the log | The server refused a device's work and the device will keep retrying. On 0.8.4 this could repeat forever; 0.8.5 falls back to committing one entry at a time and logs `batch commit failed, committing one at a time` instead. Either line means something is wrong with the store: check disk space and permissions on the data directory. |

Use `telimus stats -json` for storage automation. Check `reclaimComplete` before
using the reclaim estimates; a partial scan cannot give a reliable total.
`store-busy` is temporary contention, not by itself a reason to restart the
server. [Health responses and flags](server-reference.md#health) are listed
in the reference.

## Rotating the vault secret

If the recovery key was exposed, replace it in the plugin or with
`telimus rotate --key-file /private/path/recovery.txt`. Save the new key and
review the device list afterwards.

Rotation keeps history and existing devices, while invalidating the old recovery
key and outstanding invites. It does not replace the data-encryption key or
remove a device. See [Security and privacy](security.md) for what revocation
and rotation can and cannot protect.
