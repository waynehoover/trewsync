# Use TrewSync without Obsidian

[Documentation](index.md) · [Command reference](cli-reference.md) · [Security and privacy](security.md)

The headless client, `trew`, is a paired device that is a folder rather than
an Obsidian vault. Use it to keep a copy of your notes on a NAS or another
machine without Obsidian, as a read-only mirror or as a two-way peer, with
note history and recovery from the terminal. It runs the same sync engine as
the plugin. The server can read what it stores: see
[Security and privacy](security.md).

**Experimental.** Use macOS or Linux, Node **22 or newer**, and a local
filesystem that has hard links, such as APFS, ext4, btrfs or XFS. TrewSync
replaces a note through a hard link so that nothing is lost if the note
changes at that moment, and refuses to sync a folder on exFAT or FAT, which
have none. Run one TrewSync process that writes to each directory, and keep
other sync tools and the Obsidian plugin off that same directory. For everyday
editing, use the [Obsidian plugin](plugin.md).

The npm package is `trew-sync` and installs a command called `trew`. The
server's command is `trewd`, so a machine can have both on its path.

## Set up a mirror

Create an invite on an existing device, using **Add another device → Create
invite** in the plugin or `trew invite` on a paired client. Then, on the mirror
machine:

```bash
npm install -g trew-sync
mkdir -p ~/trew-mirror
cd ~/trew-mirror
trew pair 'INVITE' --read-only
trew sync --watch
```

Replace `INVITE` with the string you created. It starts `trew1i_` and carries
the server's address and the vault's name, so there is nothing else to type.
An invite works once and expires after one hour by default. `--read-only` is
saved during pairing, so subsequent syncs keep local changes from being
uploaded even without the flag.

Keep the process running for continuous sync. For a scheduled job, use
`trew sync --dir /path/to/trew-mirror` instead.

If pairing is interrupted after the invite was sent, for example by a dropped
connection, run the same `trew pair` command again in that directory. The
client saved the pairing before sending it, and finishes it as the same device,
even if the invite has expired since. A refused invite (unknown, already used,
expired or cancelled) leaves nothing saved; ask for a new one.

## The first device on a new server

The first device pairs from an invite too. Make one on the server host with
`trewd invite -url wss://your-host`, naming the address devices reach, or use
the one a server with no devices writes to `first-invite` in its data
directory. Copy it to this machine privately, then pair, without `--read-only`
if this device should write:

```bash
mkdir -p ~/vault
trew pair --dir ~/vault --key-file /private/path/invite.txt
trew sync --dir ~/vault
```

A `first-invite` file holds one line per server address, each the same invite;
give `--key-file` a file holding just the line this machine can reach.

There is no separate command for starting a vault, and no recovery key to
save: the notes and their history are on the server, and `trewd invite` on the
server pairs a new device whenever you need one. See
[server setup](server.md#the-first-device)
for TLS and the first invite.

## Everyday commands

Commands use the current directory unless you pass `--dir DIR`.

| Command | Use it to… |
|---|---|
| `trew pair INVITE` | Join a vault with an invite; run it again to finish an interrupted pairing. |
| `trew sync` | Sync once and exit. |
| `trew sync --watch` | Keep syncing and reconnect after temporary outages. |
| `trew status` | Check connection, local changes, refused paths, and recovery issues. |
| `trew invite` | Add another device with a single-use invite. |
| `trew devices` | List devices and outstanding invites. |
| `trew revoke ID` | Stop a device syncing, this one and the last one included. |
| `trew uninvite ID` | Cancel an outstanding invite. |
| `trew rename NAME` | Rename this device's label. |
| `trew history "Note.md"` | View a note's versions, newest first. |
| `trew search "text"` | Search the notes on the server for literal text, a tag or a file name. |
| `trew deleted` | List deleted notes and whether they can be restored. |
| `trew restore "Note.md"` | Restore the newest version with content. |
| `trew unlink` | Remove local pairing and index while keeping notes. |

The [command reference](cli-reference.md)
covers all flags, device access, repair, and recovery.

## Search your notes

`trew search` asks the server, so it searches every note in the vault as the
server holds it, whether or not this device has synced lately. The server
keeps a search index, so a search reads only the notes that may match:

```bash
trew search "harbour"                 # text, ignoring case
trew search harbour --case-sensitive
trew search project --mode tag        # the tag and its nested tags
trew search meeting --mode filename   # file names
trew search harbour --folder Journal --context 2
trew search harbour --all --json      # every page, for a script
```

Each match prints as `path:line:column: the line`, highlighted on a terminal.
Anything a note holds that a terminal would act on, such as an escape
sequence, is shown spelled out instead, so a note cannot change what your
terminal displays. When more matches follow the first page the command says
so; `--all` shows them all. If a note could not be searched it is named and
the command exits 1, since a match may be missing. The
[command reference](cli-reference.md#search) has every flag, the JSON shape and
the exit codes.

## An agent

An agent reads and edits notes through the [server's MCP endpoint](agent.md),
`/mcp` under `trewd serve -mcp`, with a token from `trewd mcp-token`. It reads
the store directly, keeps what an agent replaced in the server's history, and
needs no copy of the vault on the agent's machine. The command-line client has
no MCP server of its own: `trew mcp` and `trew mcp-token`, inherited from
Basalt Sync, are gone, and say so if run.
[Moving from `trew mcp`](agent.md#moving-from-trew-mcp) covers an agent that
used one.

## A mirror, and turning merging off

`--read-only` stops ordinary sync from uploading local edits, deletions, and
conflict copies. It still downloads and changes local files. Preserve local
edits you care about separately; this mode does not make the local directory
immutable.

The setting is a client behavior, **not a server-enforced permission**. The
client keeps an ordinary device credential, and explicit administrative
commands still work. In particular, `trew repair` can resend missing content.
Use this mode on a machine you trust.

`pair` persists `--read-only`; passing it to `sync` applies it to that
invocation. There is no flag to turn a persisted setting off.

To review conflicting edits yourself instead of merging them:

```bash
trew sync --no-merge
trew sync --watch --no-merge
```

Pass `--no-merge` on each invocation that should use it. TrewSync keeps both
versions when a merge would otherwise be needed.

## Recovery

```bash
trew history "Quarterly plan.md"
trew restore "Quarterly plan.md" --uid 42
trew restore "Quarterly plan.md" --uid 42 --to "Recovered plan.md"
```

Restore never overwrites an existing file. If the target is occupied, it writes
a copy such as `Quarterly plan (restored 42).md`. On a writable client, it then
attempts to send that copy. On a read-only mirror, the copy stays local.

When the server is restored from a `trewd backup` snapshot, this client needs
nothing from you. The restored server has a new history, and at its next
connection the client reads that history as a fresh listing: files that match agree, files
that differ are kept both ways as a conflict copy, files only this device holds
are sent back (unless it is read-only), and nothing is deleted because the
restored history lacks it. A note deleted after that backup was taken can
therefore come back; delete it again if you still want it gone.

If the server's data directory was instead copied back by hand, the client
stops with a `cursor` error. Back up the server, then `trew unlink` and pair
again with a new invite. Local files are kept, and what only this device holds
is sent back. Either way the next edit made on two devices at once keeps both
versions instead of merging them, because the last agreed version is gone.

If a command reports a version kept at a hidden path, preserve that file and
`.trew/`. Copy the retained version to a new visible filename and inspect it
before removing recovery material. An unreadable recovery inventory needs
attention even when other transfers succeed.

## Automation and output

Use `--json` for structured command output.
Exit **0** means the command succeeded,
**1** means a failure or unresolved issue, and **2** means invalid arguments.
For sync, `outcome` explains the result and the counters describe the work.

A name can hold characters a terminal would act on, from a file on this disk,
a note another device or an agent wrote, or a device's name. Every command
prints those spelled out, as `\u{1b}` for an escape, so nothing it prints can
change what your terminal displays. `--json` escapes them the way JSON does,
and parses back to the exact names.

A conflict exits 0 because both versions were preserved. Ignored files and
changes held back by read-only mode also do not make a sync fail. Inspect those
fields if your job needs a stricter condition. Hidden versions awaiting recovery
and an unreadable recovery inventory make sync fail until addressed.

Restore separates `restored` (the local file was written), `sent` (that copy was
acknowledged by the server), and `ok` (the overall operation succeeded). If the
copy was restored but sync failed, retry `trew sync` to avoid creating another copy.

To keep invites out of command arguments, use an existing private file or
standard input:

```bash
trew pair --key-file /private/path/invite.txt --read-only
trew pair - --read-only < /private/path/invite.txt
```

`trew invite` prints the new invite, so protect its output and logs.

## Files and local state

TrewSync stores this device's credential and the sync index in `.trew/`, which
never syncs. Protect this directory: a copy of it can connect as this device
until you revoke the device. Unlink through the command rather than deleting
state files by hand.

The CLI excludes dot-prefixed files and folders, `node_modules`, and the
Obsidian configuration folder. Use `--config-dir NAME` if yours differs from
`.obsidian`. Add `--ignore NAME` for a file or folder name to exclude at every
depth; repeat the flag for more names. These choices apply to this device only.

A name that starts with a dot never syncs from any device, at any depth, so a
folder such as `.attachments` stays on this machine. The server also refuses
paths Obsidian could not hold: longer than 1,024 bytes, a file or folder name
longer than 255 bytes, control characters, backslashes, no-break spaces, and a
few more. Two paths that differ only in letter case, such as `Notes/a.md` and
`notes/a.md`, cannot both sync either, because a case-insensitive disk would
hold them as one. A refused path stays on this device and `trew status` lists
it with the reason; rename it and sync again.

Equivalent Unicode filename spellings are normalized. If two distinct files
would become the same name, TrewSync blocks those paths and identifies them;
rename one yourself. Keep clients updated together to avoid older clients
reintroducing obsolete spellings. Filesystem renames can appear as a deletion
of the old path and a creation of the new one; both names retain their history.

## A command says the vault is locked

Stop an existing watcher before starting another command that writes to the
vault. On supported local macOS and Linux setups, process exit releases the
lock automatically, including after a crash.

If TrewSync reports that manual recovery is required, run `trew unlock` after
confirming the previous process has stopped. It refuses a TrewSync on this
machine that still holds the vault, `--force` or not. `--force` is for what
this machine cannot check: a holder recorded on another machine, which you
must verify has stopped, or a running process here that holds nothing, which is
what a process id reused after a restart looks like; check what that process
is first. Shared network vaults remain unsupported.

## Preview and verify

`trew preview --dir ~/vault` shows planned changes without writing notes.
Add `--json` for file actions and counts. Run `trew sync --verify --dir ~/vault`
to re-read every file when an external edit may have preserved its timestamps.
History supports `--before UID` for older pages; see the
[CLI reference](cli-reference.md).
