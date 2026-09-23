# Server reference

[Documentation](index.md) · [Setup](server.md) · [Maintenance](server-operations.md)

`trew` runs the server and its maintenance commands. Commands that use a
store, plus `service`, accept `-data DIR`; the default is `$TREW_DATA`, then
`~/.trew`. `health` uses an address instead, and `version` needs neither.
Only `serve` creates a new server data directory. Use each subcommand's `-h`
for installed usage.

## Commands

| Command | Purpose | Can the server remain running? |
|---|---|---|
| `serve` | Serve one vault; also the default command. | One server per data directory. |
| `backup -to DIR` | Copy and verify a snapshot. | Yes. |
| `verify [-deep]` | Check stored entries and content. | Yes. |
| `stats [-json]` | Inspect storage and potential reclaimable space. | Yes. |
| `purge -confirm VAULT -backup DIR` | Remove old versions and unused content. | No. |
| `service` | Print a systemd unit and installation instructions. | Prints only. |
| `health` | Check a running server. | Yes. |
| `mcp-token -label L` | Mint, list (`-list`) or revoke (`-revoke ID`) a token for the MCP endpoint. | Yes; it goes through the running server. |
| `version` | Print version, platform, and toolchain. | Independent of serving. |

## serve

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `:3003` | Listen address. Use `127.0.0.1:3003` behind a local proxy. |
| `-localhost` | Off | Bind to loopback and print a `ws://` setup address. |
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

## The MCP endpoint

`serve -mcp` answers MCP's streamable HTTP at `/mcp` on the same port, with
read tools over the notes the server stores: `vault_status`, `list_notes`,
`read_note`, `search_notes`, `note_history`, `deleted_notes`,
`compare_versions` and `delivery_status`. A client authenticates with
`Authorization: Bearer <token>`:

```bash
trew mcp-token -label "Claude on Mac"                   # prints the token once
trew mcp-token -label "Claude on Mac" -key-out FILE     # or writes it, mode 0600
trew mcp-token -list                                    # ids, scopes, expiry, use counts
trew mcp-token -revoke ID
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

Useful `stats -json` fields:

| Field | Meaning |
|---|---|
| `files`, `folders`, `bytes` | Current live content. |
| `deleted`, `recoverable`, `purged` | Deleted paths and recovery availability. |
| `versions`, `history` | All versions and the older versions eligible for purge; required move/deletion history is retained. |
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

`trew health` requests `/health` and exits non-zero on failure. Its flags are
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
| Encrypted path | 4,096 bytes. |
| Entries per upload batch | 256. |
| Encoded upload batch and summed body budget | 16 MiB maximum. |
| Fetch body budget | 64 MiB default; configurable up to 256 MiB. |
| Post-handshake frame | 32 MiB. |
| Pre-handshake frame | 64 KiB. |
| Connections awaiting a handshake | 32. |
| Handshake timeout | 10 seconds. |
| Vault and device names | 64 bytes, no control characters. |
| Wrapped key or sealed invite | 256 bytes of base64url. |
| Invite lifetime | 10 minutes default; at most 1 hour. |
| Deleted entries per protocol page | 1,000, with continuation information. |

## Stopping it

Allow at least 15 seconds for graceful shutdown. The provided systemd unit and
Compose file allow 30 seconds. Keep that allowance in custom process managers
so requests in progress can finish before the process is killed.
