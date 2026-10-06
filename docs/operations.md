# Operating TrewSync

[Documentation](index.md) · [Server maintenance](server-operations.md) · [Command reference](server-reference.md)

This is the page for the bad night: a note that seems to be gone, an agent
that did something overnight, a server that will not start, a disk that is
full. Every answer here uses `trewd` and nothing else, and every command that
only reads can be run while the server is running. The examples use
`/var/lib/trew` for the data directory; with Docker, put
`docker compose exec trew /trewd` in front of each command instead of
`trewd`, and drop `-data`.

## First, ask doctor

```bash
trewd doctor -data /var/lib/trew
```

`doctor` looks at everything this page talks about and writes nothing, so it
is safe to run while worried. Each line is one check: `OK`, `NOTE` (something
worth knowing that asks nothing of you), `WARN` or `FAIL`, and under each
`WARN` and `FAIL` an arrow with what to do. It exits non-zero when anything
needs attention, so a timer or a monitor can run it and alert on the exit code
alone. `-json` prints the same report, with the running server's counters, for
a script.

With the server running, `doctor` also asks it over its private control
socket: whether it can take a note, how its commits are going, which devices
are connected and how far each has applied, and how the search index is
doing. The server runs the same checks on itself every five minutes and logs
`msg=alert` with the check, what is wrong and the remedy, once when it starts,
again if it changes, once a day while it stands, and `msg="alert cleared"`
when it is fixed.

A condition you have decided to live with can be accepted by name, so it stops
failing the run and stays printed:

```bash
trewd doctor -data /var/lib/trew -accept encryption -accept backup
```

What each check means, and what to do:

| Check | A `WARN` or `FAIL` means | Do this |
|---|---|---|
| `data-dir` | The directory is missing, is another product's, was written by a newer `trewd`, or other accounts can read into it. | Check `-data`. A newer schema needs the newer `trewd`. `chmod 700` the directory. |
| `storage` | The data is on a tmpfs or a container's own layer: gone at the next restart or upgrade. | Mount a persistent volume at the data directory and move the store onto it with the server stopped. `serve` refuses to start an empty store there without `-allow-ephemeral`. |
| `encryption` | Always a note: doctor can see a LUKS volume by its device name and nothing else. | See [Encryption at rest](#encryption-at-rest). |
| `server` | A server holds the directory and does not answer, or it answers and cannot take a note (`disk-full`, `store-read-only`, `chunks-read-only`, `chunks-unreachable`). | Read the remedy for the word it gives; a hung server is restarted after reading its log. |
| `restarts` | Five starts in ten minutes (a restart loop), or the last run was killed or crashed. | Read one run's log: a refusal at startup says why, and restarting will not change it. After a crash, `trewd verify -deep`. |
| `identity` | The store is at an older schema, or does not hold the vault named. | Restart the server with this build, which upgrades the store; until then this build's `backup` refuses it rather than upgrade it under the older server. Use `-vault`. |
| `store` | Verify's pass found faults: a body missing, a row malformed, a pinned before-image gone. Or a purge holds the directory. | See [Something is wrong with the store](#something-is-wrong-with-the-store). |
| `chunks` | A sampled body is missing or does not hash to its name, or some are quarantined. | `trew repair` on a device that still holds those notes; `trewd verify -deep` names them. |
| `space` | Under 1 GiB or 5% free warns; under 64 MiB fails, and the store refuses every write. Or the write-ahead log is over 512 MiB. | Free space or grow the volume. `trewd stats` says whether a purge would help. A huge write-ahead log means a long read is holding checkpoints back: let it finish, or restart. |
| `index` | The search index cannot be read, is not trusted with no rebuild running, its worker failed, or it is more than 500 versions behind. | Search stays correct meanwhile, only slower. See [When the index is behind](#when-the-index-is-behind). |
| `git-export` | The [Git export](git-export.md)'s settings cannot be used, git or git-lfs is missing, its branch was moved in the repository or on the remote outside the export (fails), or a push failed, or versions have waited more than fifteen minutes past the quiet window (warns). Off is a note. | Sync is not affected. See [The Git export](#the-git-export). |
| `tokens` | An MCP token has expired, or expires within two weeks. | `trewd mcp-token -label NAME` mints a new one; `trewd mcp-token -revoke ID` removes the old. |
| `devices` | A device has not been seen for a month, or is connected and has applied nothing for fifteen minutes while behind. | A lost device: `trewd revoke ID`. A stuck one: open it; its panel or `trew status` says what it is stuck on. |
| `commits` | Commits have failed since the server started; three in a row fails. | Read the log for `commit failed`; check free space and that the volume is writable. Devices keep what they could not send. |
| `backup` | No backup is recorded, the last one failed, or the last good one is over two days old. | `trewd backup`; see [Backups](#backups). |
| `rehearsal` | No restore has been rehearsed, the last one failed, or it was more than 90 days ago. | [Rehearse a restore](#rehearse-a-restore). |
| `origin` | The address devices use does not answer `/health`. Checked with `-url`, or the running server's own addresses. | Check the tunnel (`tailscale serve status`, or Caddy's log) and that invites name the address it serves. |

## Is a note lost?

Probably not. Every version the server has taken is kept until a purge, and
every device keeps its own copy. Look in this order.

1. **Ask for it by its path.** Paths are exact: case, spaces and folders count.

   ```bash
   trewd cat -data /var/lib/trew -path "Projects/Plan.md"
   ```

   If it was deleted or renamed away, `cat` says so and names the versions
   that still have words in them.

2. **Read its history.** Every version, newest first, with who wrote it, when
   by their clock, and the agent operation that wrote it if an agent did:

   ```bash
   trewd history -data /var/lib/trew -path "Projects/Plan.md"
   ```

   And every deleted note with the version to restore it from:

   ```bash
   trewd deleted -data /var/lib/trew
   ```

3. **Take any version out.** `cat` prints it, `export` writes it to a new file,
   and nothing else is needed: no device, no plugin, no running server.

   ```bash
   trewd cat -data /var/lib/trew -path "Projects/Plan.md" -uid 4182
   trewd export -data /var/lib/trew -uid 4182 -to ~/Plan-as-it-was.md
   ```

   Every body is checked against its name as it is read, so what comes out is
   that version or an error, never something close to it.

4. **If the server holds no version with the words** (`trewd deleted` says a
   purge took them), look on the devices: the note may be there, or in a
   conflict copy beside it (`Plan (Conflicted copy Phone 202609241130).md`).
   Then look in a backup taken before the purge: unpack it into a scratch
   directory and read it the same way. The unpacked copy is every note in the
   clear, so unpack it where the data directory already is, and remove it
   afterwards.

   ```bash
   trewd unpack -from /srv/trew-backups/trew-2026-09-01.tar.age -identity ~/trew-backup-key \
     -to /var/lib/trew/restore-2026-09-01
   trewd cat -data /var/lib/trew/restore-2026-09-01 -path "Projects/Plan.md"
   ```

   Unpack prints the archive's SHA-256 and says it was not compared with a
   record: an older archive is not the last backup, and anyone holding the
   recipient can make one your identity opens. Compare that digest with the
   one the backup printed on the night it was taken.

5. **If the server has the version but not its body** (`doctor` or `verify`
   says `missing`), run `trew repair`, or "Send back what the server has lost"
   in the plugin, on a device that still has the note.

## Roll back an agent's overnight run

Every write an agent makes is an operation in the log, with what it changed
and the versions it replaced, and each of those versions is kept for 30 days
whatever a purge does.

```bash
trewd audit -data /var/lib/trew -since 12h
```

Undo one operation, which puts back exactly what it replaced, across every
note it changed, or refuses as a whole if anyone has edited one of them since:

```bash
trewd undo -data /var/lib/trew OPID
```

A refusal names each note changed since and who changed it, and writes
nothing. Then `-to-copy` writes each version the operation replaced beside its
note, as `Plan (restored 4182).md`, and changes nothing already there:

```bash
trewd undo -data /var/lib/trew -to-copy OPID
```

To put the whole vault back as it was before the run, find the last uid before
it (the audit's first operation says the uid each path held before it), and
restore to it. Without `-apply` it only shows what it would do:

```bash
trewd restore -data /var/lib/trew -to-uid 4180
trewd restore -data /var/lib/trew -to-uid 4180 -head 4260 -apply   # the -head the dry run printed
```

A restore writes new versions and rewrites no history, so every device
receives it as ordinary changes, a phone that was offline included, and `trewd
undo` of the restore's own operation puts everything back again. Then stop the
agent: `trewd mcp-token -list` and `trewd mcp-token -revoke ID`.

## What `badpath` in the logs means

The server refused a path it will not store: a segment starting with a dot
(`.obsidian`, `.trash`, a `.attachments` folder), a path over 1,024 bytes, a
control character, a non-breaking space, a name not in Unicode NFC, or a name
that differs only by case from one already there (`collision`). The server's
keyspace is Obsidian's, and a name that a Mac or a phone would fold onto
another would lose one of the two there.

Nothing is lost: the file stays on the device that has it, and the device
shows it with its reason, in the plugin's list of notes that cannot sync and
in `trew status`. Rename it on that device and it syncs. A `badpath` line in
the log is a device telling you it has such a file, not the server losing it.

## When the index is behind

The search index is derived from the store and never refuses or delays a
write. A lagging or broken index costs speed and never a search result: search
scans whatever the index has not reached. So there is nothing urgent about it.

- **Behind, and catching up.** Run `doctor` again in a few minutes; the lag
  should shrink.
- **The worker failed, or the index is not trusted.** Read the server's log
  for the search index's error. A restart checks the index and rebuilds it.
- **Rebuild from scratch.** Stop the server, move `search.db` (and its `-wal`
  and `-shm`) aside, and start it again. It builds a new index from the store
  while search scans.

## The Git export

With a [Git history](git-export.md) configured, `trewd git-export status`
says what the export has done and what it is waiting on, and doctor's
`git-export` check reads the same. None of it can delay or lose a note: the
export only reads what the store has committed.

- **A push fails.** The status and doctor show the error with the credential
  named only by its path. The export keeps committing locally and retries on
  its own, every half minute at first and at most every half hour. Fix the
  network, the deploy key or the token; nothing else is needed.
- **The remote's branch was changed outside the export.** It will not push
  over a commit it did not make. Find out who changed the branch. Put it back
  at the commit status names and run `trewd git-export set` to look again, or
  export to a new branch with `trewd git-export set -branch NAME`. A branch
  that held backups before the export can be continued once with `trewd
  git-export adopt` ([Continue an existing backup branch](git-export.md#continue-an-existing-backup-branch)).
- **The local repository's branch was moved.** The export stops where it is.
  Put the branch back, or stop the server and move `git-export/` aside to
  export again from the store; with the store unpurged and the settings
  unchanged the rebuild makes the same commits, so the remote accepts it.
- **The store was restored from a backup.** The export adds one commit marked
  `Restore:` holding the restored notes and goes on; it never rewrites the
  branch.
- **git or git-lfs is missing or too old.** Install git 2.36 or later and
  git-lfs 3.0 or later on the server's PATH; the container image and the Nix
  package carry both.

`trewd purge` does not reach the Git history. What was pushed stays readable
by whoever hosts the remote until the repository itself is deleted.

## Something is wrong with the store

Run the full check, which reads and hashes every body:

```bash
trewd verify -deep -data /var/lib/trew
```

- `missing` or `corrupt`: a body is gone or damaged. `trew repair` on a device
  that holds the note sends it back; a corrupt body is quarantined, not
  deleted, and replaced when the real one arrives. Anything no device holds
  comes from a backup.
- `lostpin`: a before-image an agent's operation pinned is gone. Restore it
  from a backup taken after the operation.
- `livekeys`: an index the collision rule reads has drifted from the entries.
  Restarting `serve` rebuilds it and says so in the log.
- Anything else, or a store that will not open: keep the directory exactly as
  it is, take a backup of it, restore the last good backup into a fresh
  directory ([Restore](server-operations.md#restore)), and read notes out of
  either with `trewd cat`.

## When the server will not start

It says why, once, and in words: read the last lines of its log
(`journalctl -u trew -n 50`, or `docker compose logs trew`). The refusals
people meet:

- **Another server holds the directory.** Only one runs per data directory.
- **The directory is not a trewd data directory, or a newer build wrote it.**
  Nothing was changed; check `-data`, or run the newer `trewd`.
- **An empty store on storage a restart erases.** Mount a volume, or pass
  `-allow-ephemeral` for a trial you mean to throw away.
- **`-max-file` below a file the vault holds.** Start with the larger limit;
  the message says how to lower it properly.

A server that restarts over and over is reported by `doctor` as a restart
loop. The unit gives up after a few tries (`systemctl reset-failed trew`
after fixing the cause).

## Backups

A backup is one archive, encrypted to an age key, and taken with the server
running:

```bash
trewd backup-key -out ~/trew-backup-key        # once, on your own machine
trewd backup -data /var/lib/trew -to /srv/trew-backups/trew.tar.age -recipients-file /etc/trew/backup-key.pub
```

Keep the identity (`~/trew-backup-key`) where the server and its backups are
not, and a second copy somewhere else: nothing reads the backups without it.
The server needs only the recipient (`backup-key.pub`). A plaintext backup
directory is still available with `-plaintext-ok`, for encrypted storage, and
it is what `purge -backup` checks.

An encrypted backup is packed from a plaintext copy inside the data directory,
`backup-staging/`, kept between runs so the next one copies only new bodies.
After each archive is written, the copy drops every body its database no
longer references, so it holds exactly what the archive holds: a note you
purge leaves the staging copy at the next encrypted backup, not before. Until
then it is still there, in the clear, beside the store; if a purge has to take
effect at once, remove `backup-staging/` while no backup runs (the next backup
makes it again, copying every body). A backup that cannot drop them says so
with a `WARNING` line and still counts as taken, since its archive is good.
A plaintext backup directory is different: it keeps purged history on purpose,
because it is the one copy of it.

The window a restore would lose is the time since the last backup: with one a
night, up to a day, plus however long the backup takes. Devices shrink it in
practice: each keeps its own copy, and after a restore every device sends back
what the restored server lacks when it next connects, so what is lost is what
was written on a device that has since been lost too. The owner deferred
choosing an offsite destination on 2026-09-22; until there is one, a backup on
the same machine protects against a damaged store and not against losing the
machine.

## Rehearse a restore

`trewd rehearse` does the whole restore where no production device can reach
it, and records the result for `doctor`:

```bash
trewd rehearse -data /var/lib/trew -backup /srv/trew-backups/trew.tar.age -identity ~/trew-backup-key
```

The archive has to be the last backup this data directory recorded (in
`last-backup.json`), compared by its SHA-256 before anything is decrypted:
the recipient is public, so anyone who can read it can make an archive the
identity opens, and a rehearsal that passes on such an archive proves nothing
about your backups. To rehearse an older archive of your own, add
`-not-last-backup`; it then goes ahead with a warning naming both snapshot
times.

It needs the identity on the machine for as long as it runs; bring it over for
the rehearsal and remove it afterwards, or rehearse on a copy of the data
directory on your own machine.

**Do one by hand, once.** A restore you have watched is the one you will trust
at 2am, and it is how you learn how long yours takes. On the Mac, against a
scratch server, it takes about fifteen minutes:

```bash
# 1. A scratch server, with a few notes in it.
mkdir -p ~/trew-rehearsal/offsite
trewd serve -data ~/trew-rehearsal/live -localhost -addr 127.0.0.1:3480 & SERVER=$!
#    Pair a new, empty Obsidian vault ("Trew Rehearsal Source") with the
#    invite in ~/trew-rehearsal/live/first-invite, and write three or four
#    notes in it, one with an attachment. Delete one, rename one.

# 2. A key, and an encrypted backup. Note the sha256 it prints.
trewd backup-key -out ~/trew-rehearsal/key
trewd backup -data ~/trew-rehearsal/live -to ~/trew-rehearsal/offsite/trew.tar.age \
  -recipients-file ~/trew-rehearsal/key.pub

# 3. The disaster: the server and its data are gone.
kill $SERVER
mv ~/trew-rehearsal/live ~/trew-rehearsal/live.gone

# 4. The restore, by hand, timed.
date
trewd unpack -from ~/trew-rehearsal/offsite/trew.tar.age -identity ~/trew-rehearsal/key \
  -to ~/trew-rehearsal/live
trewd stats -data ~/trew-rehearsal/live
trewd deleted -data ~/trew-rehearsal/live
trewd serve -data ~/trew-rehearsal/live -localhost -addr 127.0.0.1:3480 & SERVER=$!
trewd invite -data ~/trew-rehearsal/live -url ws://127.0.0.1:3480
#    Pair a second new, empty vault ("Trew Rehearsal Witness") with that
#    invite and let it sync.
date

# 5. Compare: the witness must hold exactly what the source held (use the
#    folders where you made the two vaults).
diff -r --exclude .obsidian "$HOME/Documents/Trew Rehearsal Source" "$HOME/Documents/Trew Rehearsal Witness"
trewd cat -data ~/trew-rehearsal/live -path "the deleted note's path.md" -uid N   # from `trewd deleted`

# 6. Record it, and see doctor say so. (It will also say no backup is
#    recorded for this restored directory, which is true of it.)
trewd rehearse -data ~/trew-rehearsal/live -backup ~/trew-rehearsal/offsite/trew.tar.age \
  -identity ~/trew-rehearsal/key
trewd doctor -data ~/trew-rehearsal/live

# 7. Clean up: stop the server, remove both vaults through Obsidian, then
kill $SERVER
rm -rf ~/trew-rehearsal
```

What to check as you go: the backup's archive holds no note's words
(`grep -c "a phrase from a note" ~/trew-rehearsal/offsite/trew.tar.age` is
0); `unpack` ends with `0 faults`; `stats` shows the deletion as recoverable;
the witness vault matches the source except `.obsidian`; the two `date` lines
are your recovery time.

## Encryption at rest

The server holds every note and its whole history in the clear, and so does
every copy of the data directory: the database and its write-ahead log, the
chunk tree, the search index, `backup-staging`, a filesystem snapshot, a
copied volume. Encrypted storage underneath (LUKS, FileVault, ZFS native
encryption) is what keeps a stolen disk from being the vault. Write down where
its key lives and how an unattended restart unlocks it (a TPM, a key file on
separate storage, a passphrase typed at boot), because a server that cannot
unlock itself after a power cut is down until someone arrives.

`doctor` recognises a LUKS volume by its device name and cannot see the rest,
so it reports a note either way. The owner's homelab volume is not encrypted,
an accepted risk recorded as S1 in the [threat model](threat-model.md); accept
the check (`-accept encryption`) only once that decision is made. Encryption
at rest does nothing against a compromised running server, an agent holding a
token, or a model provider reading what the agent reads.

## What is in the data directory

| Path | What it is | Safe to remove? |
|---|---|---|
| `trew.db` (and `-wal`, `-shm`) | Every version's record, devices, tokens, the agents' log. | Never. |
| `chunks/` | Every note's bytes, named by their SHA-256. | Never. |
| `search.db` | The search index, derived from the store. | With the server stopped; it is rebuilt. |
| `trewd.json` | The [configuration file](server-reference.md#configuration-file): the Git export's and the daily-note tools' settings. | Yes; every setting returns to its default. |
| `git-export/` | The [Git export](git-export.md)'s bare repository (`repo.git`, with its LFS objects), its state, and the known_hosts it wrote. | With the server stopped; it is exported again from the store, and a remote it pushed to keeps its history. |
| `backup-staging/` | The plaintext copy an encrypted backup is packed from, pruned to what the last archive holds. | Whenever no backup is running; the next one makes it again. |
| `last-backup.json`, `last-rehearsal.json`, `runtime.json` | What the last backup, rehearsal and starts did, for `doctor`. | Yes; `doctor` then says nothing is recorded. |
| `first-invite` | The first device's invite, mode 0600. | Once the first device is paired. |
| `control.sock`, `server.lock`, `data.lock` | The operator's socket and the locks. | Never while a server runs; a stale socket is replaced at start. |
