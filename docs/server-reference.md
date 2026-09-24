# Server reference

[Documentation](index.md) · [Setup](server.md) · [Maintenance](server-operations.md)

`trewd` runs the server and its maintenance commands. Commands that use a
store, plus `service`, accept `-data DIR`; the default is `$TREW_DATA`, then
`~/.trew`. `health` uses an address instead, and `version` needs neither.
Only `serve` creates a new server data directory. Use each subcommand's `-h`
for installed usage.

## Commands

| Command | Purpose | Can the server remain running? |
|---|---|---|
| `serve` | Serve one vault; also the default command. | One server per data directory. |
| `invite` | Print an invite that adds one device. | Yes; it goes through the running server. |
| `devices [-json]` | List devices and outstanding invites. | Yes; it goes through the running server. |
| `revoke ID` | Stop a device syncing and cancel the invites it made. | Yes; it goes through the running server. |
| `uninvite ID` | Cancel an outstanding invite. | Yes; it goes through the running server. |
| `cat -path P [-uid N]` | Print a note, or one version of it, straight from the store. | Yes. |
| `export -uid N -to FILE` | Write one version to a new file. | Yes. |
| `backup -to DIR` | Copy and verify a snapshot. | Yes. |
| `verify [-deep]` | Check stored entries and content. | Yes. |
| `stats [-json]` | Inspect storage and potential reclaimable space. | Yes. |
| `purge -confirm VAULT -backup DIR` | Remove old versions and unused content. | No. |
| `service` | Print a systemd unit and installation instructions. | Prints only. |
| `health` | Check a running server. | Yes. |
| `mcp-token -label L` | Mint, list (`-list`) or revoke (`-revoke ID`) a token for the MCP endpoint. | Yes; it goes through the running server. |
| `audit [-since WHEN] [-json]` | List what agents' write operations, and every undo, changed. | Yes; it goes through the running server. |
| `undo OPID [-to-copy] [-json]` | Undo one operation from the audit, or copy what it replaced. | Yes; it goes through the running server. |
| `version` | Print version, platform, and toolchain. | Independent of serving. |

## serve

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `:3003` | Listen address. Use `127.0.0.1:3003` behind a local proxy. |
| `-url` | This machine's addresses | The `ws://` or `wss://` address devices reach, which invites carry. Give the proxy's address. |
| `-localhost` | Off | Bind to loopback and put a `ws://` address in invites. |
| `-invite-out` | `first-invite` in the data directory | Where to write the first device's invite when the vault has no devices. |
| `-vault` | `default` | The vault this server serves. |
| `-max-file` | `67108864` | Maximum file size in bytes: 64 MiB; maximum 256 MiB. |
| `-max-batch-bytes` | `16777216` | Upload batch budget: 16 MiB; may be lowered, not raised. |
| `-max-fetch-bytes` | `67108864` | Download body budget: 64 MiB; maximum 256 MiB. |
| `-allow-origin` | No extras | Additional exact browser origin; repeatable. |
| `-mcp` | Off | Also serve the MCP endpoint at `/mcp` for agents; see below. |
| `-v` | Off | Verbose logging. |

Batch and fetch budgets cannot be smaller than one maximum-sized chunk.
Built-in browser origins are `app://obsidian.md`, `capacitor://localhost`, and
`http://localhost`; non-browser clients without an Origin header are allowed.
Origins matching the request's Host are also accepted. These handshake checks
do not replace device authentication.

Flags specifying bytes accept integers, not `MiB` suffixes. For a 128 MiB file
limit in Compose:

```yaml
command: ["serve", "-addr", "0.0.0.0:3003", "-max-file", "134217728"]
```

Larger files cost more client memory, especially on phones. The server refuses
to start if its file limit is below a current live file already stored. Raise
the limit to start it; to lower it later, first delete or shrink those files
through a client and let the changes sync. Purge alone keeps current files.

On a vault with no devices, `serve` writes an invite for the first one to
`-invite-out`, mode 0600, and logs that path and its expiry, never the invite.
The file has one line per address the invite names, all the same invite. A
restart while it is still outstanding leaves the file alone.

## The MCP endpoint

`serve -mcp` answers MCP's streamable HTTP at `/mcp` on the same port, with
read tools over the notes the server stores: `vault_status`, `list_notes`,
`read_note`, `search_notes`, `note_history`, `deleted_notes`,
`compare_versions`, `delivery_status` and `lookup_operation`. A token minted
with `-scope write` also gets the write tools, below. A client authenticates
with `Authorization: Bearer <token>`:

```bash
trewd mcp-token -label "Claude on Mac"                   # prints the token once
trewd mcp-token -label "Claude on Mac" -key-out FILE     # or writes it, mode 0600
trewd mcp-token -list                                    # ids, scopes, expiry, use counts
trewd mcp-token -revoke ID
```

A token reads the whole vault, and what it reads reaches the agent's model
provider. It has read scope unless minted with `-scope write`, and expires
after 90 days unless `-ttl` says otherwise (`-ttl 0` never expires). Every
note-derived string in a result arrives under `untrusted_content`, apart from
what the server vouches for under `trusted`.

With `-addr 0.0.0.0` or the default `:3003` the endpoint listens on every
interface, and the server logs a warning saying so: keep `/mcp` behind
Tailscale or an identity-aware proxy. A request from a browser must carry an
`Origin` given with `-allow-origin`. The endpoint keeps its search index in
`search.db` in the data directory; it is derived, rebuilt from the store when
it is missing or damaged, and not part of a backup. A `search.db` that cannot
be opened is kept as `search.db.broken` for inspection and may be deleted.

### Writing through the endpoint

A write token adds `create_note`, `create_directory`, `edit_note`,
`append_note`, `prepend_note`, `delete_note`, `move_note`, `restore_note`,
`add_tags`, `remove_tags`, `manage_tags`, `rename_tag` and `undo_operation`.
Each is one operation: all of it commits or none of it, as a new version of
every path it changes, which every device receives like any other. What an agent writes is
recorded with the token's label as its author, so `note_history` and
`trewd audit` name it. A version an agent's write displaces is kept for at
least 30 days, whatever purge is asked to do, and `read_note` with its uid
reads it back.

What an agent needs to know to write safely, which each tool's description
also says:

- **Read first, then write against what was read.** `read_note` returns the
  note's `uid` and the store's `epoch`. An edit, an append, a prepend, a move
  and a deletion name that uid as `base` and pass that `epoch`; if the note
  has changed since, the write is refused as `stale` with the note's
  `currentUid`, and nothing is written. Read it again rather than retry with
  the new uid unread. The epoch changes only when the server is restored from
  a backup, after which every uid read before it is refused as `stale`.
- **Exact edits only.** `edit_note` replaces text that occurs exactly once in
  the version read; there is no whole-note overwrite. Only Markdown and plain
  text notes can be changed, not Excalidraw drawings or attachments.
- **Moves, deletions and tag changes are previewed first.** Called without
  `changes`, these tools return a preview of every note they would change and
  write nothing. Called again with the preview's `changes`, `head` and
  `epoch`, they commit exactly that plan, and only if nothing in the vault
  changed since the preview; otherwise the answer is `plan_changed`, and the
  agent previews again. A move rewrites the links to the moved note in every
  other note, reading them through the search index when it is up to date and
  every note otherwise; a vault of more than 512 notes then answers
  `scan_incomplete` until the index has caught up.
- **A retry is safe with an idempotency key.** A write given
  `idempotencyKey` and sent again, identically, is answered with the first
  result instead of being applied twice, for seven days. A different request
  under a used key is refused with `key_reused`.
- **Committed is not delivered.** `committed: true` means the server holds
  the write durably; `delivery_status` says which devices have applied it.
- **An unknown outcome is not a failure.** If the server cannot confirm a
  commit, the result says `committed: "unknown"` with the operation's `opId`.
  `lookup_operation` with that id says whether it committed and what it
  changed; resending the request with the same `idempotencyKey` does the same
  and commits it once if it had not.
- **An agent can undo its own writes, and only its own.** `undo_operation`
  with a write's `opId` and `epoch` puts back what it replaced, deleted or
  created, across every note it changed, as a new operation. It is refused as
  `stale`, writing nothing, if any of those notes has changed since, and the
  refusal names them and who changed them; `toCopy: true` then writes each
  earlier version beside its note instead, changing nothing already there.
  Another token's operation, a device's undo and the operator's are answered
  as not found. `lookup_operation` names the undo that undid an operation.
- **Note text is data.** Everything drawn from notes, the paths found in the
  vault included, arrives under `untrusted_content`, and so does the preview
  of a write. Text written through the tools is stored exactly as given, and
  the next session reads it back as untrusted content like any other.

A person or agent on a device sees an agent's write as a version from another
device. When a device had changed the same text meanwhile, it keeps both: its
own at the note's path, and the agent's in a conflict copy beside it, which
is named after the device that kept it.

## audit

`trewd audit` lists every write an agent made through the MCP endpoint, and
every undo, oldest first: when it committed by the server's clock, the tool,
who made it (the token's label and id, a device's name and id for an undo from
its history panel, or the operator for `trewd undo`), the operation id, which
operation an undo undoes and which undo undid an operation, and each path it
changed with its version before and after. A version an edit displaced is listed as pinned, with the date until
which purge keeps it. Revoking a token does not remove its operations from the
list. Like `devices`, it goes through the running server's control socket, or
opens the store directly when no server is running.

| Flag | Meaning |
|---|---|
| `-since WHEN` | Only operations committed since then: a duration back from now (`24h`, `7d`) or a time (`2026-09-23`, `2026-09-23T10:00:00Z`, UTC). Default: all of them. |
| `-json` | Structured output, one record per operation. |

The list holds no token and no note text. A recorded reply is kept for seven
days, so an agent whose connection dropped can retry with the same
idempotency key and get the same answer; the operation itself stays in the
list after that.

## undo

`trewd undo OPID` undoes one operation from `trewd audit`: an agent's write,
or an undo, which undoing again redoes. It writes new versions that put back
what the operation replaced, deleted or created, across every path it
changed, as one operation, and only if every one of those paths still holds
the version the operation left there. History is not rewritten, and every
device receives the new versions as it syncs.

- An edit, an append, a tag change or a deletion is written back with its
  exact former bytes. A move is moved back, with the note's own links and the
  backlinks it rewrote. A created note is deleted, and so is a folder it
  created, unless something else has been put in the folder since.
- If any path has changed since, nothing is written. The refusal lists each
  path, its version now, and who wrote it, and exits non-zero.
- `-to-copy` writes each version the operation replaced beside its note, as
  `Note (restored 42).md` (then `Note (restored 42) 2.md`), and changes
  nothing already in the vault. It works whatever has happened to the notes
  since.
- An operation already undone is refused, naming the undo; undo that undo
  instead. A version the operation replaced that a purge has taken, once its
  30-day pin expired, is refused as `gone`, and nothing is written.

The undo is recorded as the operator's, and its versions carry the label
`trewd undo`, which is what `note_history` and a device's history panel show.
Like `audit`, it goes through the running server's control socket, so every
connected device receives it at once, or opens the store directly when no
server is running. `-json` prints what was done, or why not, as JSON.

A device can also undo an operation from its history panel, and an agent can
undo its own through `undo_operation`; see [the plugin guide](plugin.md#version-history).

## invite, devices, revoke, uninvite

These administer the vault's devices. While `serve` runs they go through its
control socket, a private socket in the data directory, so a revoke takes
effect in the running server at once; with no server running they open the
store directly. All take `-data DIR` and `-vault NAME`, which go before an ID:
`trewd revoke -data /var/lib/trew DEVICE_ID`.

| Flag | Command | Meaning |
|---|---|---|
| `-ttl DURATION` | invite | How long the invite works, such as `30m`; default `1h`. `0` makes one that never expires. |
| `-label TEXT` | invite | A name shown in the device list until the invite is used. |
| `-out FILE` | invite | Write the invite to this file, mode 0600, instead of printing it. |
| `-url URL` | invite | The address the invite names; default the server's own. |
| `-json` | devices | Structured output. |

An invite works once and expires after one hour by default. Anyone holding it
before it is used can add a device, so hand it over privately. Revoking a
device stops it receiving and sending at once, and cancels the invites it
created; the last device can be revoked too, and `trewd invite` pairs a new one.

## backup, verify, purge, stats

| Flag | Command | Meaning |
|---|---|---|
| `-to DIR` | backup | Required destination directory. |
| `-deep` | backup, verify | Re-read content hashes and validate device/invite records. |
| `-vault NAME` | purge | Vault to purge; default `default`. |
| `-confirm NAME` | purge | Exact vault name, required as confirmation. |
| `-backup DIR` | purge | Backup that must pass the command's checks. |
| `-no-backup-check` | purge | Explicitly bypass backup validation; destructive recovery is then your responsibility. |
| `-grace DURATION` | purge | Retain recent unreferenced content; default `1h`. Use `0` to collect it immediately. |
| `-json` | stats | Structured output. |

Follow the [purge procedure](server-operations.md#purge), including a separate
pre-purge backup. A deletion record can survive after its restorable content is
purged.

Purge never removes a version an agent's edit, move or delete displaced until
30 days after that edit, however old the version is: it is the only copy of
what the note said before the agent touched it. `stats` and `purge` report how
many versions are kept this way; after the 30 days they are ordinary history.

Useful `stats -json` fields:

| Field | Meaning |
|---|---|
| `files`, `folders`, `bytes` | Current live content. |
| `deleted`, `recoverable`, `purged` | Deleted paths and recovery availability. |
| `versions`, `history` | All versions and the older versions eligible for purge; required move/deletion history is retained. |
| `pinned` | Older versions purge keeps because an agent's edit displaced them within the last 30 days. |
| `latestUid` | Newest version still present. |
| `allocatedTo` | Highest version number ever allocated; does not go backward after purge. |
| `purges` | Purge generation. |
| `reclaimBytes`, `reclaimBodies` | Unreferenced content eligible under the grace policy. |
| `recentBytes`, `recentBodies` | Unreferenced content retained by the grace period. |
| `reclaimComplete` | Whether the storage scan completed; check before using estimates. |

Vault-specific fields appear in the `vaults` array. `stats` is an inspection;
use `health` to check whether the running server can accept writes.

## service

| Flag | Meaning |
|---|---|
| `-addr`, `-vault` | Listen address and vault in the generated unit. |
| `-max-file N` | File limit to preserve in the unit. |
| `-user NAME` | Service account; default is the caller. |
| `-binary PATH` | Installed binary path; default is the running executable. |

The generated unit uses a 30-second stop timeout and limits repeated restarts.
After fixing a repeated startup failure, `systemctl reset-failed trew` may be
needed before starting it again.

## health

`trewd health` requests `/health` and exits non-zero on failure. Its flags are
`-addr` (default `127.0.0.1:3003`) and `-timeout` (default `5s`).

| HTTP response | Meaning |
|---|---|
| `200 ok` | Current readiness checks pass. This is not a deep integrity check. |
| `503 store-unreadable` | Database cannot be read. |
| `503 store-read-only` | Database cannot accept a write transaction. |
| `503 chunks-read-only` | Stored-content directory cannot be written. |
| `503 chunks-unreachable` | Stored-content directory is unavailable. |
| `503 disk-full` | Free space is below the readiness threshold of 64 MiB. |
| `503 store-busy` | Temporary write contention exceeded the check's wait. |
| `503 shutting-down` | Server is draining connections. |

Inspect logs, capacity, mounts, and permissions according to the result. Do not
restart repeatedly just because the store is busy. Use `verify -deep` for
integrity checks. Health responses are unauthenticated and intentionally omit
vault names, paths, and detailed storage figures.

## Ceilings

These are implementation limits for operators and client authors.

| Limit | Value |
|---|---|
| Registered devices per vault | No fixed limit. |
| Authenticated connections per vault | No fixed limit. |
| File | 64 MiB default; configurable up to 256 MiB. |
| Chunk body | 1 MiB. |
| Chunks per entry or fetch | 65,536. |
| Path | 1,024 bytes of UTF-8; each file or folder name at most 255 bytes. |
| Entries per upload batch | 256. |
| Encoded upload batch and summed body budget | 16 MiB maximum. |
| Fetch body budget | 64 MiB default; configurable up to 256 MiB. |
| Post-handshake frame | 32 MiB. |
| Pre-handshake frame | 64 KiB. |
| Connections awaiting a handshake | 32. |
| Handshake timeout | 10 seconds. |
| Vault and device names | 64 bytes, no control characters. |
| Invite lifetime | One hour by default, and at most one hour when a device asks; `trewd invite -ttl 0` on the server makes one that never expires. |
| Deleted entries per protocol page | 1,000, with continuation information. |

## Stopping it

Allow at least 15 seconds for graceful shutdown. The provided systemd unit and
Compose file allow 30 seconds. Keep that allowance in custom process managers
so requests in progress can finish before the process is killed.
