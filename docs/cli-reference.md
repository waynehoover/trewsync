# CLI reference

[Documentation](index.md) · [CLI quick start](../client/README.md)

This page covers the headless client, the `trew-sync` npm package, whose
command is `trew`. The server's binary has the same name; its commands are in
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
| `mcp [--listen [ADDR]]` | Serve notes over stdio or authenticated HTTP while syncing. |
| `mcp-token [--revoke]` | Issue, rotate, or revoke this directory's HTTP MCP credential. |
| `preview` | Show planned changes without writing notes; `--json` includes paths and counts. |
| `status` | Check connection, local state, refused paths, and recovery issues. |
| `history PATH [--before UID]` | Page through versions, newest first. |
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
| `--json` | Structured command output; invalid for `mcp` and `mcp-token`. |
| `--timeout MS` | Server wait; default `30000`. |
| `--vault NAME=DIR` | `mcp` only: repeat for up to ten separately paired absolute directories. Cannot combine with `--dir`. |
| `--listen [ADDR]` | `mcp` over HTTP; default `127.0.0.1:3010`. Requires an issued MCP credential. |
| `--writable` | Enable HTTP mutation tools; requires `--listen` and a writable device. |
| `--allow-origin ORIGIN` | Allow an exact HTTP origin; repeatable, requires `--listen`. |
| `--revoke` | `mcp-token` only: remove the credential without restarting the service. |
| `--read-only` | Hold back local sync changes; persisted by `pair`. For `mcp`, also omit mutation tools. |
| `--no-merge` | Keep conflicting versions separately for this invocation. |
| `--config-dir NAME` | Obsidian configuration folder; default `.obsidian`. |
| `--ignore NAME` | Exclude a file/folder name at any depth, local to this device; repeatable. |
| `--ttl DURATION` | Invite lifetime, such as `30m`; default `1h`, which is also the most a device can ask for. |
| `--uid N` | Exact version for `restore`. |
| `--to PATH` | Destination for `restore`. |
| `--limit N` | `history`: default 20; `deleted`: default all. |
| `--before UID` | Earlier page for `history` or `deleted`. |
| `--key-file PATH` | `pair` only: read the invite from a private file. |
| `--key-out PATH` | `mcp-token` only: save the new credential in a new `0600` file outside the vault, suppressing it on stdout. |
| `--force` | `unlock` only: clear a holder recorded on another machine after verifying it stopped. |
| `-v`, `--verbose` | Engine logging. |
| `--` | End options; remaining arguments are literal values. |

For `pair`, use `-` as the invite argument to read it from standard input.
`--key-out` refuses to overwrite an existing file and prints only the
credential id and output path.

## Pairing

An invite is a single-use `trew1i_` string carrying the server's address and
the vault's name, so `pair` needs nothing else. It works once and expires after
one hour by default; `invite --ttl` can ask for less, and the server makes one
that never expires only through `trew invite -ttl 0` on its own host.

`pair` saves the pairing before sending it. If the reply is lost, running the
same `pair` again in that directory finishes it as the same device, even after
the invite has expired. A refusal (an unknown, used, expired or cancelled
invite) leaves nothing saved.

## Device access

Any paired device can revoke any device, including itself and the last one,
and cancel any outstanding invite. Revoking stops that device receiving and
sending at once and cancels the invites it created. It does not erase the
device's local notes. When no paired device is left, `trew invite` on the
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

## MCP over stdio

`trew mcp --dir /absolute/path/to/agent-vault` starts one local MCP server
and keeps that paired directory in sync. Pair it separately with `pair`;
MCP has no pairing or device-administration tools. Use Node 22 or newer and a
dedicated headless directory on local macOS or Linux storage. See the
[host configuration](../client/README.md#connect-a-local-agent).

The process holds the same vault lock as `sync --watch`. Stop the watcher before
starting the host, and use one host process per directory. Root aliases do not
bypass the lock. EOF, SIGINT and SIGTERM stop admission and drain work before
releasing it. An admitted edit can finish after cancellation or disconnection;
inspect the note if its response was lost.

Stdout contains only MCP messages; diagnostics and verbose logs go to stderr.
`--json`, `--watch` and `--verify` are invalid for this command.
`--read-only`, `--no-merge`, `--timeout`, `--config-dir` and `--ignore` apply.
`--listen` selects the separate [HTTP transport](#mcp-over-http).

### Several vaults

To expose several separately paired headless directories, name each one explicitly:

```bash
trew mcp --vault personal=/srv/personal --vault work=/srv/work
```

Names begin with a lowercase letter and contain lowercase letters, digits,
underscores or hyphens, up to 32 characters. Up to ten distinct, non-nested
roots are allowed. `list_vaults` returns their names, access modes and connection
readiness, without host paths. With more than one vault, every other tool
requires `vault`, for example `{"vault":"work","path":"daily.md"}`. There is
no shared current-vault setting. A single vault keeps the selector optional;
`--dir` uses the name `default`.

Each vault keeps its own sync connection, credential, history, read queue and
mutation queue. The process acquires all vault locks before starting and keeps every lock
until all admitted work drains. Saved read-only settings apply per vault; shared
launch flags such as `--ignore`, `--no-merge` and `--read-only` apply to every vault.

For HTTP, add `--listen` and issue the credential with `mcp-token --dir` for the
**first configured vault**. That credential grants access to the entire explicit
vault set in this process, in its launch mode. Other vaults' tokens do not grant
access. Rotating or revoking the first vault's token applies to the whole endpoint.
Store any exported token outside every exposed vault. Use separate endpoints and
credentials if the clients should have different vault access. `--writable`
refuses startup if any selected pairing is read-only.

### Tools and bounds

Arguments below are JSON objects supplied to MCP tools, not shell commands.
Unknown arguments are refused. Paths are relative to the vault, with a maximum
of 4096 UTF-8 bytes. Excluded paths, child symlinks, non-regular files and ambiguous
Unicode/case spellings are refused. A symlink for the vault root itself may
resolve to its canonical local directory.

| Tool | Arguments and behavior |
|---|---|
| `list_vaults` | No arguments. Lists only configured aliases, access modes and readiness. |
| `list_notes` | Optional `folder`, `nameContains`, `after`, `limit` (default 100, max 500), `includeBackups` (default false). Lists notes, attachment metadata and folders. `nameContains` is a case-sensitive filename substring. |
| `read_note` | Required `path`; optional `uid`, `startLine` (default 1), `maxLines` (default 200, max 1000), `base`. Returns exact text, the complete note's SHA-256 `base`, and `nextLine`. `uid` selects a version from server history. |
| `search_notes` | Required `query` (max 1024 bytes); optional `mode` (`content`, `filename`, `both`, `tag`; default `content`), `folder`, `caseSensitive` (default false), `cursor`, `limit` (default 50, max 200), `contextLines` (default 0, max 3), `includeBackups`. Tag mode matches case-insensitive tags and their nested descendants; `includeChildren:false` selects only the exact tag. It reads frontmatter and body text, excluding code, comments and link syntax. Filename rows have line 0. Returns explicit skipped/omitted counts. |
| `note_history` | Required `path`; optional `before`, `limit` (default 20, max 100). Returns versions newest first and `nextBefore`. Device names are labels, not proof of authorship. |
| `compare_versions` | Required `path`, historical `fromUid`; optional historical `toUid` (defaults to current local bytes), `after`, `limit` (default 20, max 100), `fromBase`, `toBase`. Returns bounded line differences and both complete bases. |
| `delivery_status` | No arguments. Reports live device checkpoints and whether receipt is received, waiting or unconfirmed. Omits device IDs and pairing invitations. |
| `deleted_notes` | Optional `before`, `limit` (default 50, max 200). Returns deleted notes, their latest recoverable version UID (`restorable`, or 0) and `nextBefore`. |
| `sync_status` | Optional `preview:true`, then optional `after` and `limit` (default 100, max 500). Basic status includes connection, write readiness, last pass/failure, exclusions and recovery inventory. Preview is an observing estimate. |
| `edit_note` | Required `path`, current `base`, and 1 to 32 `{old,new}` edits. Each nonempty `old` must occur exactly once. Edits must not overlap and all refer to the original source. Each `old`/`new` is at most 8 KiB; combined input is at most 64 KiB. |
| `append_note` | Required `path`, current `base`, and nonempty `text` (max 64 KiB). Appends exactly those bytes to an existing note. Include any wanted newline yourself. |
| `prepend_note` | Same arguments as append. Inserts exact text at the start, after an existing UTF-8 BOM. Include any wanted newline yourself. Preserves a verified before-image and refuses stale retries. |
| `create_note` | Required `path` and `content` (max 1 MiB). Exclusively creates a note at a free path. |
| `create_directory` | Required `path`. Creates and flushes a checked directory; an existing directory is a no-op. |
| `add_tags` | `paths` and `tags`, optional `location` (`frontmatter`, `content`, `both`), `position` (`start`, `end`) and `normalization` (`preserve`, `lowercase`, `kebab`). Returns an exact preview unless `changes` is supplied. |
| `remove_tags` | `paths`, exact `tags` and/or single-`*` wildcard `patterns`, optional `includeChildren` and `location`. Uses the same preview/apply workflow. |
| `manage_tags` | The add/remove fields plus `operation: "add"` or `"remove"`. |
| `rename_tag` | `oldTag`, `newTag`, optional `folder`, `includeChildren` and `location`. Scans the selected scope, omitting immutable recovery copies. |
| `move_note` | `path`, free destination `to`, optional `updateLinks` (default true). Previews the move and exact link edits; maintains relative outbound links even when incoming backlink updates are disabled. |
| `delete_note` | `path`, optional `markBroken` (default false). Previews recoverable deletion and optional backlink strike-through edits. |
| `restore_note` | Required source `path`, inspected version `uid`, and distinct explicit destination `to`. Exclusively creates that destination; an occupied path gives `exists`. Repeating a request never invents another filename. |

Content reads and searches accept UTF-8 `.md` and `.txt` notes up to 1 MiB.
Mutations also require those formats and refuse `.excalidraw.md` drawings and
MCP backup/recovery names. Attachments can be listed but not read or changed.
There is no whole-file replacement, permanent deletion or backup-cleanup tool.

Every read page is at most 64 KiB. A single line larger than that gives
`line_too_large`; reducing `maxLines` cannot split it. Follow `nextLine` with
`startLine` and the same returned `base` to detect changes between pages.
A history base identifies historical bytes, not the current local version.
Follow `nextAfter` as `after`, `nextCursor` as `cursor`, and `nextBefore` as
`before` until null. Keep query options unchanged. Listings/searches are live
observations, not a frozen inventory; rerun if a concurrent edit matters.

Search bounds content scanning to 512 candidate files and approximately 8 MiB
per call (the final file can exceed that work budget). It still walks the full
inventory. A page can have no matches and still have `nextCursor`.
Inspect `skipped` and `complete`; no matches does not prove absence from
unreadable notes or ambiguous paths. Ambiguous paths in the requested folder
appear in `skipped` with `why: "ambiguous_path"` on every page and keep
`complete:false`. Counts include blocked paths, which can represent entire
unexamined folders, and samples are limited to 20 paths. Deleted pages may be
empty after filtering and still have `nextBefore`. A historical lookup stops after 5000 versions with
`lookup_incomplete`, which does not establish absence. Purged, missing and
unverifiable content cannot be restored.

### Readiness and write results

Initialization does not wait for initial sync. Local read/list/search and basic
status remain available while connecting or offline, and may reflect an older
local copy. A missing local path gives `not_found_local`, not proof of deletion
from the server. History and sync preview require a settled server connection.
Tag and namespace previews inspect local files and can run while offline.
Mutations require `writeReady:true`; a queued mutation waits at most five seconds
to start and otherwise returns `busy`. An admitted mutation finishes in the
owning sync client's serial queue even if its connection subsequently drops.

`--read-only`, including a saved read-only pairing, removes all mutation
tools. It still permits incoming sync to change local files. It is a local
process policy, not a restricted server credential.

Before any mutation changes or removes existing bytes, it creates a visible sibling,
reads it back, compares every byte and flushes it. Failure stops the edit before
touching the original. Creation and restore have no before-image because their
destinations must be absent. An unchanged edit returns `noop:true` without a write.

Inspect the structured tool result, including on errors:

| Field | Meaning |
|---|---|
| `applied` | `true`: intended bytes were verified at the destination; `false`: they did not land; `"unknown"`: inspect before deciding. |
| `durable` | `true`: the reported local result was flushed. This can describe retained recovery content even when `applied:false`. Absent, false or unknown does not establish a durable intended result. |
| `base` | Digest of the verified result, when available. |
| `beforeImage` | Verified before-image of the note, when one was completed. |
| `preserved` | Other recovery paths to inspect. A failed write may leave an incomplete attempted copy here. |
| `sync.state` | `pending`: ordinary sync was scheduled. It is not a server acknowledgement. |

An error can accompany `applied:true`. A race may preserve another writer's
bytes under a conflict name or keep the proposed edit in an MCP recovery copy.
Read every reported recovery path. On `stale`, cancellation, a lost response or
an unknown result, reread and reconsider the change. Never automatically replace
the base or repeat an append. `localWritesSincePass` says whether a pass scanned
since the local commit; zero does not prove server delivery. Inspect the last
pass, pending work and recovery state, and read from a second device when
delivery matters.

### Tag, move and delete previews

Call the tool without `changes` to inspect its plan. The result has `phase:
"preview"`, `applied:false`, and a `changes` array. Each row contains the note's
complete base, its action and exact source edits. Offsets count JavaScript UTF-16
code units; `old` and `text` carry the actual removed and inserted text.

To apply, resubmit the same tool arguments with the complete returned `changes`
array. Trew recomputes the operation and refuses `plan_changed` if an affected
note, base or edit differs, including a new affected note. Inspect a new preview
and reconsider before retrying. Never replace bases automatically.

Tag edits preserve unrelated YAML and body bytes. They ignore code, comments and
link destinations. Add defaults to frontmatter; remove and rename default to both
frontmatter and inline tags. Nested selection is opt-in for mutations. Wildcards
match tag names, not filesystem paths. Malformed or ambiguous frontmatter refuses
the operation instead of being rewritten.

An apply validates all bases and edits, then creates, reads, compares and flushes
every required before-image before changing any original. It rechecks bases before
publication and before each file. A later race or I/O failure stops the batch.
Inspect every `results` row, including `attempted`, `applied`, `durable`,
`beforeImage` and `preserved`; `complete:false` can accompany completed local
changes. Trew does not roll those changes back over other writers.

A move creates and verifies the destination, updates approved backlinks, then
retires the source last. It is a recoverable copy and deletion, not an atomic
rename across devices. The destination starts its own history. A failure can
leave both names, and a crash can leave some backlinks updated; the before-images
remain available. Short links with multiple possible targets stay unchanged and
are counted in `ambiguousLinks`. Labels, aliases, titles and fragment syntax are
preserved. Deleted backlinks stay as they were unless `markBroken:true` requests
visible strike-through markers. Deletion always keeps its synced before-image.

Plans are bounded to 32 affected paths (including a move destination), 16 KiB of
JSON-encoded paths and 64 KiB of exact changes. Scans read at most 512 notes or
8 MiB; unreadable or ambiguous notes refuse the plan rather than authorize an
incomplete global edit. Narrow `paths` or `folder` when a limit is reached.

### Compare versions and inspect delivery

Use `compare_versions` with a UID from `note_history` to see what changed since
that version. Supply `toUid` to compare two retained versions. Follow `nextAfter`
with both returned bases; a changed local note refuses continuation. Comparisons
never modify notes. Each hunk clips old/new text to 2048 characters and reports
`clipped`; `detailClipped` reports clipping on that page. A deterministic work
limit may return a broader hunk with `coarse:true`. `complete` means all hunks
were paginated, not that clipped text was shown. Read complete versions before
using them for an edit or restore.

`delivery_status` requires a live connection. `received` means an online device
reported applying at least the observed server checkpoint while the local client
remained settled. Pending local work, a changing connection, offline devices or
missing checkpoints produce `unconfirmed`. It is not a receipt for a particular
tool call. Device names are reported labels. The response includes at most 100
devices and counts any omitted rows.

### Inspect and recover

After an edit, pass the returned `beforeImage` path to `read_note`. To find older
copies, use `list_notes` with `includeBackups:true`; backup rows include `backupOf`.
Names look like `daily (MCP backup 20260915T120000Z 0123456789abcdef).md`.
They are ordinary synced files and remain until the owner deliberately removes
them outside MCP. To recover one locally, read every page with a pinned base,
then pass the exact content to `create_note` at a new path.

For server history, first call `note_history` with `{"path":"daily.md"}`.
Choose a returned version with content and inspect it. If its UID is 42, the
following tool calls recover it without changing the current source:

```text
read_note    {"path":"daily.md","uid":42}
restore_note {"path":"daily.md","uid":42,"to":"Recovered/daily.md"}
read_note    {"path":"Recovered/daily.md"}
```

Use the actual returned UID, follow any `nextLine` before choosing the version,
and check `applied` and `durable`. The destination must be unused. After a lost
restore response, read that destination before retrying; `exists` does not
create a second recovery copy. A deleted note follows the same path: discover it
with `deleted_notes`, inspect `note_history` and `read_note(uid)`, then restore
to a free name. `restorable:0` means no content remains available.

## MCP over HTTP

Use the same separately paired headless directory, tools and preservation rules
as stdio, including [explicitly named vaults](#several-vaults). Issue a credential before starting the listener:

```bash
trew mcp-token --dir /srv/vault --key-out /private/path/trew-mcp.key
trew mcp --dir /srv/vault --listen 127.0.0.1:3010
```

The output file's parent must exist and the file must be new, private and outside
the vault, including through directory aliases. Without `--key-out`, issuance
prints the 43-character token once to stdout. The directory stores only its
SHA-256 hash, short id and issue time in `.trew/mcp-token.json` at mode `0600`.
That state never syncs and cannot be read by MCP. The token is independent of
the device's own credential. It grants access to this one process's tools; the
sync server does not accept it.

Every request to `/mcp`, including loopback requests, needs
`Authorization: Bearer TOKEN`. Configure the token in the client's authentication
field. This is static bearer authentication, without OAuth discovery or a login
flow. A client requiring OAuth needs a separate integration. There is no
credential-management tool or unauthenticated health endpoint.

HTTP starts with read-only tools. Add `--writable` to enable mutation
tools. It cannot override a saved read-only pairing or `--read-only`; those
combinations exit 2. HTTP's default only restricts MCP tools: ordinary sync
still uploads local changes on a writable device. `--read-only` also restricts
ordinary sync uploads.

`--listen` alone selects `127.0.0.1:3010`; `--listen :3010` also means loopback.
Use an IP literal or `localhost`, with brackets for IPv6, such as `[::1]:3010`.
Wildcard addresses are refused. A named non-loopback interface prints a warning
because the listener carries plaintext notes and credentials. Put TLS in front
of it for network use; see the [service and Tailscale example](../client/README.md#connect-over-http).

A request carrying `Origin` is refused unless that exact canonical HTTP or HTTPS
origin was supplied with `--allow-origin`, for example `https://app.example.com`.
Paths, trailing slashes and wildcard origins are invalid. No origins are allowed
by default. Forwarded headers supply bounded log metadata only and grant no access.
Wrong or absent credentials return 401; an unreadable or malformed credential
returns 503. Refusals contain no vault details. Other paths return empty 404;
unsupported methods return empty 405.

Rotate by running `mcp-token` again, using a new output filename if exporting:

```bash
trew mcp-token --dir /srv/vault --key-out /private/path/trew-mcp-next.key
trew mcp-token --dir /srv/vault --revoke
```

These commands work while the service holds the vault lock. Each request reads
the current hash. Observing rotation or revocation cancels old-key work still
waiting to start and ends old sessions. An already admitted note transaction
finishes and preserves its before-image. Old tokens receive 401; legacy clients
initialize a new session with the new token. Revocation leaves the listener
refusing requests until a new credential is issued. It also prevents a new
listener from starting.

The pinned SDK supports legacy `2025-11-25` sessions and sessionless `2026-07-28`
requests. Legacy sessions expire after 30 minutes idle, with at most 16 sessions,
8 requests and one GET stream per session. Both modes share a 32-request process
cap. Requests selecting the same vault share its reader and mutation queues. Overflow returns 429 with
`Retry-After`, or a tool-level `busy` refusal. Bodies are limited to 8 MiB before
parsing; headers time out after 10 seconds and request bodies after 30 seconds.
Tool responses are bounded to 1 MiB. GET streams have no write timeout.
Cancellation or an interrupted request ends its legacy session; reconnect and
inspect any uncertain mutation before deciding whether to retry.

HTTP ignores stdin EOF and keeps stdout empty. SIGINT and SIGTERM close admission,
cancel queued work and drain admitted transactions before releasing the shared
vault locks. One process serves all clients and handles ongoing sync. The proxy
stand-in and real child have been tested locally; actual Tailscale and phone-client
acceptance remain unverified.

## Files and locking

Local state lives under `.trew/`: private credentials, `index.json`,
`index.log`, lock records, and the displaced-version recovery log. Keep recovery
material until you have inspected the retained files. Use `unlink` to remove a
pairing; do not treat deleting state as routine repair.

Supported local macOS and Linux setups release CLI exclusion when the process
exits. Where Trew reports a fallback, `unlock` refuses a running local holder.
Neither manual recovery nor `--force` makes a shared network filesystem supported.
