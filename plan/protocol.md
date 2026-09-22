# Wire protocol, version 1 (draft for M1 and M2)

Derived from Basalt's protocol 7 (`basalt:docs/protocol.md`) by removing encryption.

**"Where silent, protocol 7 applies" is not a specification, and this document is not a freeze.** The earlier plan froze this draft and forked two implementation lanes off it; review found a field-name contradiction, an unspecified binary format, an incorrect port instruction, and an inexact budget in the frozen text. M0.5 in PLAN.md replaces the freeze with a working vertical slice plus executable cross-language fixtures, and requires each implementation to consume the other's vectors. Inherited operations are enumerated below rather than implied.

WebSocket. Text frames carry JSON control messages; binary frames carry chunk bodies. Contents, paths, sizes, timestamps, and device labels are readable by the server. TLS in front of the server is required.

## Design rules

Kept from protocol 7, numbered as there because code comments cite them:

1. Name outcomes explicitly: `have`, `want`, `ack`, `err`.
2. Acknowledge a device's own writes without requiring it to download an echo.
3. Carry covered version ranges so clients can check stream continuity.
4. Derive sync decisions from state rather than a persisted "initial sync" flag.
5. Validate structure and limits before accepting content. The server also validates paths.
6. (Retired: version the wire separately from the encryption construction. There is no construction.)

## Handshake

Two session types.

### Device session

```text
-> {op:"hello", id, proto:1, vault, deviceId, token, device, cursor}
<- {res:"ready", id, proto:1, minProto:1, serverVersion, cursor,
    perFileMax, chunkMax, maxChunks, maxBatchBytes, maxFetchBytes}
```

`token` is the device's random 32-byte credential, base64url. The server compares SHA-256 of it against `devices.auth_hash` in constant time. A `deviceId` starting with `mcp:` is refused with `auth`.

### Invite redemption

```text
-> {op:"hello", id, proto:1, vault, device, invite, deviceId, token}
<- {res:"redeemed", id, deviceId}
```

The field is **`token`**, everywhere. PLAN.md previously called it `auth` in the M1 and M2 task lists while this document called it `token`; that is resolved in favour of `token` and both task lists are corrected.

`invite` is the 16-byte invite token, base64url. `deviceId` is client-chosen (16 random bytes, base64url) and `token` is the new device's credential, which the server stores hashed. The client **generates and persists its credential before sending redemption**, so that a redemption which commits but whose reply is lost can be recovered by retry rather than stranding a device row. Redemption inserts the device row and marks the invite used in one transaction, then closes the connection. The device reconnects as a device session. Unknown, expired, or used invites return `auth`.

A retry of a redemption whose reply was lost either recovers the paired device or returns an explicitly recoverable result. It does not silently fail.

There is no registrar session, no claim, no bootstrap token, no `crypto` field, no wrapped key.

### The invite string

```text
telimus1i_ <base64url( version=1 || token[16] || len(url) || url || len(vault) || vault || crc32 )>
```

**This layout is not yet complete enough to implement, and M0.5 finishes it before either side writes code.** Unspecified and required: the width and endianness of `len(url)` and `len(vault)` (one byte each, or two big-endian?); the byte order of the CRC-32; exactly which bytes the CRC covers (everything before it, including the version byte); whether base64url is padded; and what a decoder does with trailing bytes. Fix each with a positive and a negative vector in `protocol-fixtures.json`.

Created by `telimus invite` on the server host or by the wire `invite` op from a device. **Invites expire by default** (one hour, both routes), and `--ttl 0` is the deliberate, explicit way to make one that does not. Bootstrap credentials are written to a private path, not to stdout, because a never-expiring invite in a container log is a durable vault credential. The plugin renders it as a QR of `obsidian://telimus?invite=<string>`.

## Paths

Every `path` and `prev` on the wire is the plaintext vault-relative path, `/`-separated, NFC-normalized UTF-8. The server refuses with `badpath`:

- empty, or longer than 1024 bytes
- invalid UTF-8, or not in NFC
- any control character (U+0000 to U+001F, U+007F)
- leading or trailing `/`, or an empty segment
- a segment equal to `.` or `..`
- a segment beginning with `.`
- a segment containing the staging mark `.telimus-tmp-`
- U+00A0 or U+202F anywhere, because Obsidian's `normalizePath` turns them into ordinary spaces and the server's keyspace is Obsidian's (PLAN §4.1)

And with `collision`: a create, or the destination of a move, whose folded key equals the folded key of a different live path, including a directory prefix that differs only by case from a live one. A rename that changes only case is the same path and is allowed; deleted paths do not collide; a batch is checked against its resulting state, so a case-only folder rename is not refused move by move. The fold (NFC, then a named case-folding table) is pinned in `protocol-fixtures.json` with vectors for U+0130, `ß` and final sigma.

The same rules live in `protocol-fixtures.json` with positive and negative examples; both implementations test against them.

## Chunk bodies

A chunk's **name** is the lowercase hex SHA-256 of its raw bytes. A **body frame** is one binary WebSocket frame:

```text
byte 0      marker: 0 = raw, 1 = raw deflate (RFC 1951)
bytes 1..   payload
```

The receiver decodes, refuses payloads that inflate beyond `chunkMax`, hashes the raw bytes, and matches the name. Either side may send raw. Deflate output need not be identical across implementations. The server stores raw bytes.

**Framing lives at the transport boundary.** Everything above that boundary (`assemble`, the engine, the MCP tools) receives verified raw chunks and never sees a marker byte. The earlier plan had both the transport and `assemble` decoding frames, which leaves the layer contract ambiguous; it is unambiguous now. Repair uploads follow the same rule.

Fixture cases: an empty body; a raw payload whose first byte happens to be `0` or `1`; a chunk at exactly `chunkMax` with the marker on top; truncated deflate; an unknown marker; a payload that inflates past the limit.

`size` on an entry must equal the sum of the raw lengths of its chunks; the server checks this at commit and refuses with `badentry`. Empty files, folders, and deletions have `chunks: []` and `size: 0`.

## Writing

```text
-> {op:"put", id, path, meta:{size, ctime, mtime, folder, deleted, prev?}, chunks:[h1,h2], base, prevBase?}
<- {res:"want", id, chunks:[h2]}
-> body frame for h2
<- {res:"ack", id, uid}
```

`have` when all bodies exist. `putmany` with up to 256 entries and `acks` per slot, as in protocol 7. No `mac`, no `parent`.

Conditional writes are unchanged: `base` is the UID of the target version the write was prepared against, 0 for no live entry; a rename carries `prevBase`; a mismatch is `stale` for that entry and the session stays usable. MCP writes use the same rule with the same code path.

The batch budget is **not** `size + 64` per entry. That is not an exact wire-memory bound for an entry carrying many chunk frames, and a single aggregate number cannot serve four different resources. Four limits, stated separately: raw bytes accepted, encoded frame bytes on the wire (including one marker byte per chunk, at maximum chunk size), control-message bytes, and the aggregate per-request cap. Pin each with a fixture at its boundary.

## Reading, deleting, repairing, recovery

`get`, `fetch` (bodies are frames), `resend`, `history`, `deleted`, `applied`, `ping`: unchanged from protocol 7 except that paths are plaintext. M0.5 writes an exchange transcript for each rather than leaving "unchanged" to carry the weight, including `have`/`want`, a mixed-success device batch, a stale rename source and a stale rename destination, reconnect continuity, repair, and applied receipts.

**`resend` is an upload path.** It receives repair bodies through `readBodies` (`basalt:server/internal/server/session.go:2161`, esp. `:2209`); it is not a download handler and does not encode outgoing frames. PLAN M1 said otherwise and was wrong.

## Devices and invites

```text
-> {op:"devices", id}
<- {res:"devices", id, devices:[{id, name, createdAt, lastSeen, online, applied}], invites:[{id, label, expiresAt}]}

-> {op:"rename", id, name}          <- {res:"renamed", id, name}
-> {op:"revoke", id, deviceId}      <- {res:"revoked", id, deviceId, self}
-> {op:"invite", id, ttlMs?, label?} <- {res:"invited", id, token, expiresAt}
-> {op:"uninvite", id, invite}      <- {res:"uninvited", id, invite}
```

`devices` includes MCP author rows so the panel shows agents. **Not as `id` starting with `mcp:`**, because `ValidDeviceID` accepts base64url (`basalt:server/internal/store/store.go:2595`), which has no colon, so that scheme is not the unchanged devices table it was described as. Author rows carry their own `kind` and a valid id, and they are refused as `hello` credentials. An author row must not present as an offline sync peer whose applied checkpoint other devices wait on. Revoking the last real device is allowed from a device session; recovery is `telimus invite` on the server, so `allowLast` is gone. `register` and `rotate` are gone.

## Errors

| code | meaning | retryable | session |
|---|---|---|---|
| `proto` | unsupported protocol number | no | ends at hello |
| `auth` | bad credential, unknown invite, or operation not allowed | no | ends at hello, else rejects the op |
| `cursor` | client ahead of server history | no | ends |
| `busy` | admission pressure or shutdown, with `retryAfterMs` | yes | ends |
| `protostate` | unexpected message or framing | no | generally ends |
| `badchunk` | invalid name, undecodable frame, or hash mismatch | no | ends mid-upload, else rejects |
| `badpath` | path refused by the rules above | no | rejects the entry |
| `collision` | another live path has the same folded key (PLAN §4.1) | no | rejects the entry |
| `stale` | target or rename source changed | no | keeps the session |
| `badentry` | invalid entry, including `size ≠ Σ chunks` | no | rejects |
| `badname` | invalid vault or device name | no | ends at hello, else rejects |
| `toolarge` | limit exceeded | no | ends if framing cannot continue |
| `nospace` | storage exhausted | yes | ends during upload |
| `nouid`, `nocontent`, `nochunk`, `nodevice` | as protocol 7 | no | rejects |
| `internal` | server fault, not committed | yes | ends in handshake, else rejects |

`rotated` is removed.

## Limits

Unchanged: `perFileMax` default 64 MiB, `chunkMax` 1 MiB, `maxChunks` 65,536, `maxBatchBytes` 16 MiB, `maxFetchBytes` 64 MiB, 256 entries per batch, request ids 1 to 2^32−1, hello read limit 64 KiB, post-auth read limit 32 MiB, ping every 45 s with a 15 s pong wait.

## MCP over HTTP

Not part of the WebSocket protocol, listed here because it shares the listener. `POST`/`GET`/`DELETE /mcp` per MCP streamable HTTP, `Authorization: Bearer <43 base64url chars>`, `WWW-Authenticate: Bearer realm="telimus"` on 401. Every other path without `Upgrade: websocket` is 426 as today, except `/health`.
