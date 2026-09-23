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

## invite, devices, revoke, uninvite

These administer the vault's devices. While `serve` runs they go through its
control socket, a private socket in the data directory, so a revoke takes
effect in the running server at once; with no server running they open the
store directly. All take `-data DIR` and `-vault NAME`, which go before an ID:
`trew revoke -data /var/lib/trew DEVICE_ID`.

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
created; the last device can be revoked too, and `trew invite` pairs a new one.

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
| Path | 1,024 bytes of UTF-8; each file or folder name at most 255 bytes. |
| Entries per upload batch | 256. |
| Encoded upload batch and summed body budget | 16 MiB maximum. |
| Fetch body budget | 64 MiB default; configurable up to 256 MiB. |
| Post-handshake frame | 32 MiB. |
| Pre-handshake frame | 64 KiB. |
| Connections awaiting a handshake | 32. |
| Handshake timeout | 10 seconds. |
| Vault and device names | 64 bytes, no control characters. |
| Invite lifetime | One hour by default, and at most one hour when a device asks; `trew invite -ttl 0` on the server makes one that never expires. |
| Deleted entries per protocol page | 1,000, with continuation information. |

## Stopping it

Allow at least 15 seconds for graceful shutdown. The provided systemd unit and
Compose file allow 30 seconds. Keep that allowance in custom process managers
so requests in progress can finish before the process is killed.
