# CLI reference

[Documentation](index.md) · [CLI guide](client.md)

This page covers the headless client, the `trew-sync` npm package, whose
command is `trew`. The server's command is `trewd`, and its commands are in
the [server reference](server-reference.md). The client operates on a local
vault. Commands use the current directory unless `--dir` is set. Run
`trew --help` for the installed version's usage.

## Commands

| Command | Purpose |
|---|---|
| `pair INVITE` | Join a vault with an invite. Run the same command again to finish a pairing whose reply was lost. |
| `invite [--ttl 1h]` | Create an invite, valid once. |
| `devices` | List device IDs, labels, activity, and outstanding invites. |
| `rename NAME` | Change this device's label. |
| `revoke ID` | Revoke a device, including this one or the last one, and close its connections. |
| `uninvite ID` | Cancel an outstanding invite. |
| `sync [--watch]` | Sync once, or keep syncing. |
| `preview` | Show planned changes without writing notes; `--json` includes paths and counts. |
| `status` | Check connection, local state, refused paths, and recovery issues. |
| `history PATH [--before UID]` | Page through versions, newest first. |
| `search QUERY` | Search the vault's notes on the server for literal text, file names or a tag. |
| `deleted` | List deleted notes and recovery availability. |
| `restore PATH` | Restore the newest version with content, or use `--uid`. |
| `repair` | Resend missing server content available on this device. |
| `unlink` | Forget the local pairing and index; retain notes. |
| `unlock` | Recover a lock when manual intervention is required. |
| `--version` | Print the CLI version. |

## Options

| Option | Applies to / meaning |
|---|---|
| `--verify` | `sync` only, without `--watch`: re-read all file contents before syncing. |
| `--dir DIR` | Local vault directory. |
| `--device NAME` | Device label at pairing; default is hostname plus a random suffix. |
| `--json` | Structured command output. |
| `--timeout MS` | Server wait; default `30000`. |
| `--read-only` | Hold back local sync changes; persisted by `pair`. |
| `--no-merge` | Keep conflicting versions separately for this invocation. |
| `--config-dir NAME` | Obsidian configuration folder; default `.obsidian`. |
| `--ignore NAME` | Exclude a file/folder name at any depth, local to this device; repeatable. |
| `--ttl DURATION` | Invite lifetime, such as `30m`; default `1h`, which is also the most a device can ask for. |
| `--uid N` | Exact version for `restore`. |
| `--to PATH` | Destination for `restore`. |
| `--limit N` | `history`: default 20; `deleted`: default all; `search`: matches a page, default 50, at most 200. |
| `--before UID` | Earlier page for `history` or `deleted`. |
| `--key-file PATH` | `pair` only: read the invite from a private file. |
| `--mode MODE` | `search`: `content` (default), `filename`, `both`, or `tag`. |
| `--folder F` | `search`: only notes beneath this folder. |
| `--case-sensitive` | `search`: match case exactly. |
| `--context N` | `search`: 0 to 3 lines of context around each match. |
| `--all` | `search`: every page of matches, not only the first. |
| `--after CURSOR` | `search`: the page after the one that ended with this cursor. |
| `--force` | `unlock` only: clear a holder recorded on another machine after verifying it stopped. |
| `-v`, `--verbose` | Engine logging. |
| `--` | End options; remaining arguments are literal values. |

For `pair`, use `-` as the invite argument to read it from standard input.

`mcp` and `mcp-token`, the headless client's own MCP server inherited from
Basalt Sync, are gone with their options (`--listen`, `--writable`,
`--allow-origin`, `--vault`, `--key-out`, `--revoke`). Both exit 2 and say
where MCP went: the server's `/mcp` under `trewd serve -mcp`, with a token from
`trewd mcp-token` ([Connect an agent](agent.md)).

## Pairing

An invite is a single-use `trew1i_` string carrying the server's address and
the vault's name, so `pair` needs nothing else. It works once and expires after
one hour by default; `invite --ttl` can ask for less, and the server makes one
that never expires only through `trewd invite -ttl 0` on its own host.

`pair` saves the pairing before sending it. If the reply is lost, running the
same `pair` again in that directory finishes it as the same device, even after
the invite has expired. A refusal (an unknown, used, expired or cancelled
invite) leaves nothing saved.

## Device access

Any paired device can revoke any device, including itself and the last one,
and cancel any outstanding invite. Revoking stops that device receiving and
sending at once and cancels the invites it created. It does not erase the
device's local notes. When no paired device is left, `trewd invite` on the
server host pairs a new one; see the [server reference](server-reference.md).
These commands target the directory's saved server address. See
[Security and privacy](security.md).

Read-only mode governs ordinary synchronization. It is not an access restriction
on the server, and an explicit `repair` can upload missing content.
Repair leaves local notes and the sync index unchanged; it does not run an
ordinary sync when other devices send changes.

## Exit status and JSON

| Exit | Meaning |
|---|---|
| `0` | Successful command. Sync may have preserved conflicts or held back local changes. |
| `1` | Failure or an unresolved issue. Read the error and relevant paths. |
| `2` | Invalid command-line arguments. |

For sync and restore, the overall `outcome.kind` is one of:

| Kind | Meaning |
|---|---|
| `synced` | No outstanding issue reported for this pass. |
| `conflicted` | Both versions were preserved. |
| `retrying` | Paths need another attempt. |
| `refused` | Paths need intervention. |
| `recoveryUnknown` | The recovery inventory is incomplete or unreadable. |
| `recoveryNeeded` | Preserved versions remain at hidden paths and need recovery. |
| `passFailed` | The sync pass did not finish. |
| `offline` | No usable server connection. |

Only `synced` and `conflicted` give exit 0. Other command schemas differ; do not
assume every command returns a sync report. Restore's `restored` flag describes
local restoration separately from overall `ok`; `sent` says whether that copy
was acknowledged by the server. After `restored: true`, retry `sync` if needed
instead of restoring again. Sync counters include uploads,
downloads, merges, conflicts, ignored paths, and changes held back on this device.

For history, `--before UID` selects versions older than that UID. JSON output
includes `nextBefore`; use it for the next page until it is `null` (an exactly
full final page may require one empty request):

```bash
trew history "Notes/Meeting.md" --limit 100 --json
trew history "Notes/Meeting.md" --limit 100 --before 1234 --json
trew preview --dir ~/vault --json
trew sync --dir ~/vault --verify
```

Command-specific flags used on another command are refused with exit 2.
Preview leaves notes, staging files, and the recovery ledger unchanged, so it
can run while a watcher holds the vault. Sync checks the plan again before writing.

## Search

`trew search QUERY` asks the server, not the local copy: it searches the notes
as the server holds them, with the same literal search an agent's
`search_notes` uses, and needs the server to speak protocol 2. Matching is
exact text, case-insensitive unless `--case-sensitive`; `--mode tag` finds a
tag and its nested tags, and `--mode filename` matches file names. Only
Markdown and text notes are searched. A query that starts with `-` goes after
`--`: `trew search -- -draft`.

Matches go to standard output, one line each, as `path:line:column: line`;
context lines are `path-line- text`, with `--` between groups. The match is
highlighted only when standard output is a terminal and `NO_COLOR` is not set.
Note text is untrusted, so every control character in it, escape sequences
included, is printed spelled out (`\u{1b}`) and never reaches the terminal as
a control. Notes about the search go to standard error: that the server kept
no search index or that it is still catching up (the search then reads every
note, so nothing is missed, only slower), that more matches follow and how to
see them, and which notes could not be searched.

One page holds at most 50 matches by default (`--limit`, at most 200). When
more follow, the command says so and prints the cursor for `--after`; `--all`
fetches every page. Every page of one search is read at the vault's version
when the first page was asked for.

| Exit | `search` |
|---|---|
| `0` | The search answered, with matches or none, including a first page with more after it. |
| `1` | A note could not be searched (so a match may be missing), or the search failed or was refused. |
| `2` | Invalid arguments, such as `--limit 201` or `--context 4`. |

`--json` prints one object: `ok` (false when a note was skipped), `matches`
(each with `path`, `uid`, `line`, `column`, `text`, `before`, `after`,
`clipped`, `kind`), `skipped`, `complete`, `nextAfter`, `head`, `indexedHead`,
`index`, `pages`, `scanned` and `scannedBytes`. The text is exactly the note's;
characters a terminal acts on are JSON escapes, so the output is safe to show.
With `--all` the object holds every page.

```bash
trew search "meeting notes" --dir ~/vault
trew search project --mode tag --context 1
trew search TODO --case-sensitive --folder Work --all --json
```

A server searching without an index reads every note, 512 notes or 8 MiB a
page. `trewd serve -mcp` keeps a search index, which narrows the notes a search
reads. Searches have a budget on the server so they cannot slow other devices'
sync; a search over it waits and asks again, a few times, before it fails.

## Files and locking

Local state lives under `.trew/`: private credentials, `index.json`,
`index.log`, lock records, and the displaced-version recovery log. Keep recovery
material until you have inspected the retained files. Use `unlink` to remove a
pairing; do not treat deleting state as routine repair.

Supported local macOS and Linux setups release CLI exclusion when the process
exits. Where TrewSync reports a fallback, `unlock` refuses a running local holder.
Neither manual recovery nor `--force` makes a shared network filesystem supported.
