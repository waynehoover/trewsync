# Maintain your TrewSync server

[Documentation](index.md) · [Server setup](server.md) · [Command reference](server-reference.md)

Three habits keep a server safe: keep independent backups, watch disk space,
and test a restore before you need one.

The examples use `/var/lib/trew` for server data and `/srv/trew-backups` for
backups. Substitute your own paths and run `trewd` as an account with access
to them. When something looks wrong, start with `trewd doctor`;
[Operating TrewSync](operations.md) is the guide for the bad night.

## Backup

A backup is encrypted to an age key. Make the key once, and keep it somewhere
the server and its backups are not:

```bash
trewd backup-key -out ~/trew-backup-key     # on your own machine, not the server
scp ~/trew-backup-key.pub server:
ssh -t server sudo mkdir -p /etc/trew
ssh -t server sudo install -m 644 trew-backup-key.pub /etc/trew/backup-key.pub
```

Without `trewd` on your own machine, Docker makes the key just as well, into
a folder of your own:

```bash
mkdir -p ~/trew-keys
docker run --rm --user "$(id -u):$(id -g)" -v ~/trew-keys:/out \
  ghcr.io/waynehoover/trewsync backup-key -out /out/trew-backup-key
```

It writes `trew-backup-key` and `trew-backup-key.pub` into `~/trew-keys`, as
you, so use those paths in the commands below.

The two halves of the key:

- **The recipient** (`.pub`) is public. The account that runs backups (the
  server's, or the container's 65532) has to read it, hence mode 644 on the
  server.
- **The identity** stays mode 0600 and off the server. A rehearsal and a
  restore need it on the server only while they run: copy it over
  (`scp ~/trew-backup-key server:`), give its path to `-identity`, and remove
  it when they finish. Under `sudo`, `~` still means your own home, not
  root's.

`backup-key` writes both files mode 0600.

Then back up the server while it is running:

```bash
trewd backup -data /var/lib/trew -to /srv/trew-backups/trew.tar.age \
  -recipients-file /etc/trew/backup-key.pub
```

`backup` copies the database and the stored content it refers to, history
included, verifies the copy, and writes it as one encrypted archive. What to
know:

- **A failed backup leaves the previous archive in place.**
- **You must say which kind.** `trewd backup` refuses to write anything
  without `-encrypt-to` or `-recipients-file`, or `-plaintext-ok` for a
  plaintext backup directory.
- **Only the archive leaves the data directory.** The copy is staged in
  `/var/lib/trew/backup-staging`, beside the notes, so the next backup copies
  only new content.
- **Devices are included, outstanding invites are not.** Restoring an old
  copy must not bring back an invite that has since been used or cancelled.
  `backup` says how many it left out.
- **After `trewd update`, restart the server before the next backup.** A
  backup never upgrades the store it copies. It refuses a store an older
  build wrote, because the server still running that build would then meet a
  store it no longer reads. Restarting the server upgrades the store.
- **Unfinished SQLite recovery.** If a plaintext destination has unfinished
  SQLite recovery from an earlier server run, backup refuses to replace it.
  Keep that directory intact and choose a fresh backup directory. Do not
  remove its journal files to get past the refusal.

For Compose:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/trew-backups
docker compose run --rm --no-deps -v /srv/trew-backups:/backup -v /etc/trew:/keys:ro \
  trew backup -to /backup/trew.tar.age -recipients-file /keys/backup-key.pub
```

The destination must be outside the data directory; TrewSync refuses nested
backups. These commands use the image's default user, 65532; adjust ownership
if your deployment uses another account.

Copy the archive to another disk or backup host as well. The `sha256` the
backup prints lets you check the copy without the key.

**Without encryption a backup is a readable copy of every note.** The server
holds notes and their history in plaintext, and so would a plaintext backup:
anyone who can read it can read the vault. That is why a backup is encrypted
unless you pass `-plaintext-ok`, even one that stays on the same machine.

Also back up the ordinary Markdown files on a device, for a copy independent
of TrewSync.

### Schedule backups

A nightly job should run the backup, which verifies its copy, and then the
transfer, **in that order**, copying only after the backup succeeds. A cron
job or systemd oneshot can run:

```bash
trewd backup -data /var/lib/trew -to /srv/trew-backups/trew.tar.age \
    -recipients-file /etc/trew/backup-key.pub && \
  rsync -a /srv/trew-backups/trew.tar.age offsite:/backups/trew/
```

- Configure the remote path and credentials for the account running the job.
- Prevent overlapping jobs, and do not modify the backup while it is being
  transferred.
- Do not copy the live database with ordinary file-copy tools.
- **Run `-deep` periodically** to check existing content for corruption. A
  deep backup replaces a body that has rotted in the backup since an earlier
  run with the source's copy, keeps the rotted one aside as quarantined, and
  says so. A shallow backup does not read what the backup already holds.
- **Keep generations** when you need older snapshots, with dated or otherwise
  separate names such as `trew-$(date +%F).tar.age`. Replacing one archive is
  not a retention policy for old ones.

`trewd doctor` warns when the last good backup is more than two days old, and
fails when the last one failed.

### Preserve history before a purge

Before purging, make a **separate backup** and leave it untouched for as long
as you want the old history. An encrypted archive taken before the purge
keeps that history whole. Purge itself checks a plaintext backup directory,
so the pre-purge copy it checks is taken with `-plaintext-ok`, onto encrypted
storage, and kept as its own directory.

Do not reuse that directory after the purge: the next backup into it
replaces its database with the post-purge snapshot. Old content files may
remain, but without the old version records they are not a usable history
archive. Old history needs the pre-purge database and its content together.

`backup.json` records the snapshot date, database identity, version range,
and purge generation. It helps identify a backup; `trewd verify -deep` checks
its actual contents. A newer date or a matching version number alone does not
prove that an older note is recoverable.

## Restore rehearsal

A backup nobody has restored is a rumour. `trewd rehearse` restores one where
no production device can reach it, and proves it:

```bash
trewd rehearse -data /var/lib/trew -backup /srv/trew-backups/trew.tar.age -identity ~/trew-backup-key
```

What it does:

1. Compares the archive's SHA-256 with the last backup the data directory
   recorded, before decrypting anything. It refuses any other archive unless
   `-not-last-backup` says it is meant to be another (an older backup, say),
   which it then warns about.
2. Decrypts the archive into a directory of its own inside the data
   directory, and verifies it deeply.
3. Compares it with every version the live store holds, up to the backup's
   newest version.
4. Serves it on a loopback port and pairs a new device to it, which downloads
   every note and compares each byte for byte.
5. Rebuilds the search index.
6. Prints how long it all took and how old the backup is.

The backup is never touched. The work directory is removed afterwards, also
when the rehearsal is stopped with Ctrl-C or SIGTERM, which records nothing.
One that a rehearsal killed outright leaves behind is removed by the next.
The result is recorded for `trewd doctor`, which warns when no rehearsal has
passed in 90 days.

For Compose, leave the server running and copy the identity to the server for
the run. The container runs as 65532, so on a Linux host the copy has to be
readable by that account. Remove it afterwards:

```bash
sudo install -m 400 -o 65532 -g 65532 ~/trew-backup-key /run/trew-backup-key
docker compose run --rm --no-deps -v /srv/trew-backups:/backup:ro \
  -v /run/trew-backup-key:/run/secrets/backup-key:ro \
  trew rehearse -data /data -backup /backup/trew.tar.age -identity /run/secrets/backup-key
sudo rm /run/trew-backup-key
```

[Operating TrewSync](operations.md#rehearse-a-restore) has the steps to do it
by hand once, which is worth doing: a rehearsal you have watched is the one
you will trust at 2am. The project's CI rehearses an encrypted backup on
every change, but it cannot validate your disk, your key or your offsite
copy.

## Restore

Stop the server and pause client sync before replacing server data. Keep the
failed directory, unpack the backup into a fresh one (unpack verifies it
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

Use a new preservation path if `trew.before-restore` already exists. Run the
commands one at a time and stop on an error. **Only after verification
succeeds:**

```bash
sudo systemctl start trew
```

**An archive that decrypts is not proof that this server wrote it.** The
recipient is public by design and sits on the server, so anyone who can read
it can make an archive your identity opens, holding whatever notes they
choose. Check the archive is the backup you took before restoring from it:

- **With a record:** pass `-record /var/lib/trew.before-restore` (the
  preserved directory, or a copy of its `last-backup.json`). Unpack refuses
  an archive whose digest is not the last good one recorded there, unless
  `-not-last-backup` is given, and refuses a `-record` that names no record.
- **Without one:** unpack prints the archive's SHA-256. Compare it with the
  one `trewd backup` printed, or with a copy of `last-backup.json` kept
  offsite.

**From a plaintext backup directory** (one made with `-plaintext-ok`), copy
it into place instead of unpacking
(`sudo rsync -a offsite:/backups/trew-plain/ /var/lib/trew/`), naming the
directory itself, not where the encrypted archives are kept. Never start the
server on the backup directory itself: it would be a live store, and the next
backup into it is refused.

**Settings.** A backup carries the server's settings (`trewd.json`): the Git
export's and the daily notes'. A copied plaintext backup brings them back as
they were, and so does unpack when `-record` shows the archive is the
recorded backup. Without that check, unpack sets them aside as
`trewd.json.from-backup`, unused, because settings name where the Git export
pushes every note. Read them, the remote above all, and rename the file to
`trewd.json` to use them.

**The Git export.** The [Git export](git-export.md)'s own repository is not
in a backup. Copy `git-export/` across from the preserved directory, as
above, before the first start, and the export adds one commit marked
`Restore:` and goes on. Without it the export starts a new repository, and
its first push is refused, since the remote's branch holds commits it did not
make. Copy it across then (with the server stopped, replacing the new one),
or export to a new branch with `trewd git-export set -branch NAME`.

### Restore with Compose

The data directory is the root of a named volume, and unpack needs an empty
directory, so the volume's contents are kept on the host first and then
cleared. The image has no shell, so `busybox` does the copying. The volume is
the one Compose made, `<folder>_trew-data`, which `docker volume ls` lists;
`trewsync_trew-data` below is for a checkout named `trewsync`. Run from the
folder holding `compose.yaml`, one command at a time, and stop on an error:

```bash
docker compose stop trew
sudo mkdir /srv/trew-before-restore
docker run --rm -v trewsync_trew-data:/data:ro -v /srv/trew-before-restore:/keep \
  busybox:1.37 cp -a /data/. /keep/
docker run --rm -v trewsync_trew-data:/data busybox:1.37 find /data -mindepth 1 -delete
sudo install -m 400 -o 65532 -g 65532 ~/trew-backup-key /run/trew-backup-key
docker compose run --rm --no-deps -v /srv/trew-backups:/backup:ro \
  -v /srv/trew-before-restore:/keep:ro -v /run/trew-backup-key:/run/secrets/backup-key:ro \
  trew unpack -from /backup/trew.tar.age -identity /run/secrets/backup-key -to /data -record /keep
sudo rm /run/trew-backup-key
docker compose run --rm --no-deps trew verify -deep -data /data
```

With the Git export on, copy its repository back before the first start:

```bash
docker run --rm -v trewsync_trew-data:/data -v /srv/trew-before-restore:/keep:ro \
  busybox:1.37 cp -a /keep/git-export /data/
```

**Only after verification succeeds:** `docker compose start trew`. Never
delete the volume as part of this, and keep `/srv/trew-before-restore` until
the restored server has run for a while.

### What your devices do after a restore

**After a restore from a `trewd backup` snapshot, devices need nothing from
you.** The restored store starts a new history as far as the devices are
concerned (a new store epoch, the first time it is served, every time a
snapshot is restored, the same one twice included). The server's log says so
at that start. Each device notices at its next connection and reads the
restored history as a fresh listing:

- Files that match agree.
- Files that differ are kept both ways, as a conflict copy.
- Files only that device holds are sent back.
- Nothing is deleted because the restored history lacks it.

Two consequences to expect:

- A note deleted after the backup was taken can come back.
- A device revoked after the backup was taken is back in the device list.
  Check `trewd devices` after a restore and revoke that device again.

A read-only mirror does not upload its local changes.

**A data directory copied back some other way needs care.** A filesystem
snapshot, or a copy of the live directory, keeps its old epoch with an older
history. A device that has seen newer versions stops with a `cursor` error
only while the copied-back store is behind its cursor. Once other devices
have written past that cursor, it is served from there without an error and
never receives the versions in between.

So pause sync on every device before starting a store copied back this way.
Before any device writes to it, preserve each device's local notes, take a
backup of the server, then:

- In Obsidian, use **Rejoin this server** and confirm the positions shown.
- In the CLI, run `trew unlink`, then pair again with a new invite.

Repeat for each affected device. Writable clients send locally held versions
back to the server and keep disagreements as separate copies. Prefer
restoring from `trewd backup` snapshots, which need neither step.

## Repair missing content

If notes repeatedly fail to download, inspect the server:

```bash
trewd verify -deep -data /var/lib/trew
```

When content is missing, use **Send back what the server has lost** in the
plugin, or `trew repair` on a client that still holds the notes. Repair
resends missing content without creating new versions. Repeat on other
devices, then verify the server again.

A device can supply only content it still has. Restore unavailable historical
content from a suitable backup when possible. Purge cannot recreate it and is
not the first recovery step.

## Purge

**Purge permanently removes older versions from the live server.** It keeps
current files and enough history to track moves and deletions, then removes
unused content. Some deleted notes remain recoverable when that history is
needed. Nothing purges automatically.

First see how much space it could reclaim:

```bash
trewd stats -data /var/lib/trew
```

Then stop the server, make a separate pre-purge backup, and verify it. For a
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

With the repository's Compose setup, the same steps reuse its image and
volume:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/trew-backups
docker compose stop trew
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trew backup -plaintext-ok -to /backup/before-purge
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trew verify -deep -data /backup/before-purge
docker compose run --rm --no-deps -v /srv/trew-backups:/backup \
  trew purge -confirm default -backup /backup/before-purge -grace 0
docker compose start trew
```

Use a fresh backup name and stop on any error. The backup must be outside
`/data`; a path such as `/data/before-purge` is refused. Copy it off the
server as well.

Purge refuses a running server, a mismatched confirmation, or a backup that
does not meet its checks. Do not bypass the backup check just to make a
refusal disappear. The default one-hour grace period retains recent
unreferenced content; `-grace 0` removes that delay on a stopped server.
Review the result for content it could not collect.

## Monitor the server

`trewd doctor` checks all of this at once and says what to do about each
finding. It exits non-zero when anything needs attention, so a timer can run
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
| `batch commit failed, committing one at a time` or `commit failed` in the log | The server could not commit a device's work. It falls back to one entry at a time, and the device keeps what it could not send and retries. Either line means something is wrong with the store: check disk space and permissions on the data directory. |

Use `trewd stats -json` for storage automation. Check `reclaimComplete`
before using the reclaim estimates; a partial scan cannot give a reliable
total. `store-busy` is temporary contention, not by itself a reason to
restart the server. [Health responses and flags](server-reference.md#health)
are listed in the reference.

## Devices and invites from the server

The server host can do everything a device's panel can. It is also the way
back in when no device is left:

```bash
trewd devices -data /var/lib/trew
trewd revoke -data /var/lib/trew DEVICE_ID
trewd uninvite -data /var/lib/trew INVITE_ID
trewd invite -data /var/lib/trew -url wss://homelab.example.ts.net
```

While the server runs, these go through it, so a revoke stops that device at
once. Revoking also cancels the invites that device created. It cannot erase
what the device already holds; see [Security and privacy](security.md).
