# Wire protocol, version 1 (draft for M1 and M2)

Derived from Basalt's protocol 7 (`basalt:docs/protocol.md`) by removing encryption.

**"Where silent, protocol 7 applies" is not a specification, and this document is not a freeze.** The earlier plan froze this draft and forked two implementation lanes off it; review found a field-name contradiction, an unspecified binary format, an incorrect port instruction, and an inexact budget in the frozen text. M0.5 in PLAN.md replaces the freeze with a working vertical slice plus executable cross-language fixtures, and requires each implementation to consume the other's vectors. Inherited operations are enumerated below rather than implied.

WebSocket. Text frames carry JSON control messages; binary frames carry chunk bodies. Contents, paths, sizes, timestamps, and device labels are readable by the server. TLS in front of the server is required.

**A text frame must be well-formed text** (settled in M1). A frame that is not valid UTF-8, or that carries a JSON `\u` escape naming half of a surrogate pair, is refused with `protostate` before it is decoded, and the session ends. Go's JSON decoder would otherwise substitute U+FFFD without a word, and for a path that is a silent rename: the note would be stored under a name its device does not hold. RFC 6455 already requires text frames to be UTF-8, so no correct client is refused.

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
-> {op:"hello", id, proto:1, vault, deviceId, token, device, cursor, epoch?}
<- {res:"ready", id, proto:1, minProto:1, serverVersion, epoch, cursor,
    perFileMax, chunkMax, maxChunks, maxBatchBytes, maxFetchBytes}
```

`token` is the device's random 32-byte credential, unpadded base64url (43 characters). The server decodes it, refuses anything that is not exactly 32 bytes, and compares SHA-256 of the 32 raw bytes against `devices.auth_hash` in constant time. A `deviceId` starting with `mcp:` is refused with `auth`.

`epoch` is the store's epoch (PLAN §2.8), an opaque string. A client stores it beside its cursor; when a later `ready` carries a different epoch, the server's history was restored or replaced, and the client discards its cursor and re-lists from 0 rather than trusting a UID sequence that may have been reissued.

**Settled in M1: the hello may carry the epoch its cursor was read under.** Without it, a client whose cursor is ahead of a restored store is refused with `cursor` before `ready`, and so never learns the epoch that would tell it why. When the hello's `epoch` is present and is not the store's, the server does not honour the cursor in either direction: it is not refused for being ahead, and it is not continued from, which would skip every version the new history holds below it. The whole vault is replayed from uid 1, `ready.cursor` is the store's latest, and `ready.epoch` is the store's, so the client resets its cursor and reconciles against everything. A hello without `epoch` has its cursor taken as it is, and one ahead of the store is refused as before. Every backup snapshot is given an epoch of its own, so restoring one is always a new epoch.

**Settled in M1: the order of the refusals, and what each says.** A hello's own shape is judged before anything about a vault is looked up: the vault and device names (`badname`), the cursor (`protostate`), and then, on this route, a missing device id (`auth`), a device id under the reserved `mcp:` prefix (`auth`, before its shape is judged), and a device id that is not base64url of at most 64 characters (`badname`). Only then is the served vault checked, and only then the credential. The served-vault refusal is the same `auth`, with the same message, as a wrong token: Basalt named the served vault in that refusal and made it before the shape checks, which told anyone on the port the one name worth aiming at. Every refusal before a credential matches is therefore a function of the request alone. A token that is not exactly 32 bytes in unpadded base64url is compared anyway, as the digest of what was sent, and gets the same refusal as a wrong one.

### Invite redemption

```text
-> {op:"hello", id, proto:1, vault, device, invite, deviceId, token}
<- {res:"redeemed", id, deviceId}
```

The field is **`token`**, everywhere. PLAN.md previously called it `auth` in the M1 and M2 task lists while this document called it `token`; that is resolved in favour of `token` and both task lists are corrected.

`invite` is the 16-byte invite token, base64url. `deviceId` is client-chosen (16 random bytes, base64url) and `token` is the new device's credential, which the server stores hashed.

**The client, settled in M0.5.** Before sending, the client generates `deviceId` and `token` and persists a *pending pairing*: server URL, vault, the invite token, `deviceId` and `token`. On `redeemed` it replaces the pending pairing with its device configuration, which no longer holds the invite token. On a definitive refusal (`auth`) it deletes the pending pairing, so nothing is left saved after a refusal; this is what the six client tests asserting "nothing is saved after a refusal" hold it to. On a lost reply (a closed connection or a timeout before any answer) it keeps the pending pairing and retries with the same `deviceId` and `token`.

**The server**, in one transaction and in this order:

1. Look the invite up by SHA-256 of its token. None: refuse.
2. If the invite was spent by this `deviceId`, and that device's `auth_hash` equals SHA-256 of this `token`, answer `redeemed` again. This is the retry of a redemption whose reply was lost, and it succeeds even if the invite has expired since, because the redemption it repeats did not.
3. If the invite is spent (by anybody else), cancelled, or expired: refuse.
4. If `deviceId` already names a device: refuse. An existing device id is refused only here, after step 2 has let the lost-reply retry through.
5. Insert the device row, mark the invite spent by `deviceId`, answer `redeemed`, then close the connection. The device reconnects as a device session.

Every refusal is the same `auth` error with the same message, so a probe cannot tell an unknown invite from a spent, expired or cancelled one, and a refusal writes nothing: in particular it never spends the invite.

**Settled in M1.** The refusals above, a malformed invite token, a vault this server does not serve and a `deviceId` under the reserved `mcp:` prefix are all that one `auth`. The request's own shape is named instead, because it says nothing about the vault and is checked before the invite is looked up: a `deviceId` that is not base64url of at most 64 characters is `badname`, a `token` that is not exactly 32 bytes in unpadded base64url is `badentry`, and a `device` name over 64 bytes or with a control character is `badname`. Step 2 compares the stored device digest in constant time, and a retry after the device was revoked has no row to recognise, so it is refused like any spent invite. The device row is named by the hello's `device`. The server keeps every spent invite row, since step 2 needs it; an unspent row that can no longer be redeemed is swept the next time an invite is created on the vault.

There is no registrar session, no claim, no bootstrap token, no `crypto` field, no wrapped key.

### The invite string

```text
trew1i_ <base64url( version=1 || token[16] || len(url) || url || len(vault) || vault || crc32 )>
```

Settled in M0.5, and pinned by the `invite` section of `protocol-fixtures.json` (vectors from `scripts/protocol-vectors.py`, consumed by `internal/invite` and `client/src/core/invite-string.ts`):

- `len(url)` and `len(vault)` are one byte each, so each field is at most 255 bytes.
- The CRC is IEEE CRC-32 over everything before it, the version byte included, stored big-endian.
- base64url is unpadded and canonical: a character outside the alphabet (including `=`, CR and LF), a dangling sextet, or unused bits that are not zero are refused. Go's decoder skips CR and LF inside its input, so the alphabet is checked before decoding.
- Nothing may follow the vault; trailing bytes inside the checksum are refused.
- `url` is canonical: `ws://` or `wss://`, printable ASCII only, no trailing slash. Encoders write that form and decoders refuse any other, rather than normalising, so both implementations accept exactly the same strings.
- `vault` is a name: 1 to 64 bytes of UTF-8, no control characters.
- A decoder trims ASCII space, tab, CR and LF at both ends, and nothing else.
- The prefix is derived from the product name, which is not final (PLAN §10); it lives in one constant on each side and in the fixtures.

Created by `trew invite` on the server host or by the wire `invite` op from a device. **Invites expire by default** (one hour, both routes), and `--ttl 0` is the deliberate, explicit way to make one that does not. Bootstrap credentials are written to a private path, not to stdout, because a never-expiring invite in a container log is a durable vault credential. The plugin renders it as a QR of `obsidian://trew?invite=<string>`.

## Paths

Every `path` and `prev` on the wire is the plaintext vault-relative path, `/`-separated, NFC-normalized UTF-8. The server refuses with `badpath`:

- empty, or longer than 1024 bytes
- any segment longer than 255 bytes, because ext4 and f2fs, which Android and Linux use, hold no more; refusing it where it is made shows the reason there, instead of every Android and Linux device failing to write it later (added 2026-09-22 from the platform probe work)
- invalid UTF-8, or not in NFC
- any control character (U+0000 to U+001F, U+007F)
- leading or trailing `/`, or an empty segment
- a segment equal to `.` or `..`
- a segment beginning with `.`
- a segment containing the staging mark `.trew-tmp-`
- U+00A0 or U+202F anywhere, because Obsidian's `normalizePath` turns them into ordinary spaces and the server's keyspace is Obsidian's (PLAN §4.1)
- a backslash anywhere, because `normalizePath` turns it into a slash

With the NFC, slash and empty-segment rules, these are exactly the paths `normalizePath` leaves unchanged. Each refusal has a reason code, and both implementations must report the same one, checked in this order: `utf8`, `empty`, `toolong`, `segmenttoolong`, `control`, `nfc`, `nbsp`, `backslash`, `slash`, `emptysegment`, `dotsegment`, `dotprefix`, `staging`. The wire code is `badpath` for all of them; the reason travels in the message and reaches the person (PLAN §4.9). **Settled in M1:** the message begins with the reason code, the field and a colon-separated explanation, as in `dotprefix: the path has a segment that begins with a dot, ...` or `toolong: the prev is 1030 bytes of UTF-8, ...`, so a client reads the reason as the text before the first colon. The field is `path` or `prev`: a rename's source is checked by the same rules as its destination, and so are folders and deletions.

**Collisions**, refused with `collision`. The fold is `fold(s) = NFC(table(NFC(s)))`, where the table is Unicode full case folding (CaseFolding.txt statuses C and F) at Unicode 15.1, generated into `internal/paths/fold_table.go` and `client/src/core/fold-table.ts` and proven identical by digest. Under full folding `Straße.md` and `STRASSE.md` collide, as do `İ.md` and `i̇.md`. For a create, or the destination of a move:

1. A move whose source and destination fold alike is a case-only rename: always allowed, because it moves no folded key. This is what lets a case-only folder rename proceed one move at a time, across batches.
2. Creating a path that is already live, spelled identically, is an update, not a create.
3. Refused if another live path (file or folder) has the same folded key but a different spelling.
4. Refused if a directory prefix of the new path folds like the folded key of a live *file* (a file where a folder is needed).
5. Refused if a directory prefix of the new path folds like a live directory but is spelled like none of the live spellings of it. Accepting any live spelling, rather than one canonical one, is what keeps creates working in the middle of a case-only folder rename.
6. Refused if the new path is a file whose folded key is a live directory, or a folder entry whose folded key is a live directory spelled differently.

Deleted paths never collide. A batch applies its entries in order, each checked against the state the earlier ones left. **Settled in M1:** the server checks at commit, under the write lock, against a live set it keeps beside the entries (the live paths with their folded keys, and every folder spelling they imply with a reference count), written in each entry's own transaction, so a refused entry's savepoint takes its changes with it. It also asks the same question read-only before requesting any body, so a create that already collides is refused before it uploads anything; the commit's answer is the one that stands. The message names the live path the new one collides with. `verify` reports a live set that disagrees with the entries as a `livekeys` fault, and `serve` rebuilds it from the entries at startup. The reference implementation is `scripts/protocol-vectors.py`; `internal/paths.Collides` and `collides` in `client/src/core/path-policy.ts` are the quadratic references the store's indexed check is tested against.

The same rules live in `protocol-fixtures.json` with positive and negative examples; both implementations test against them.

## Format policies

Five policies, kept separate even where two agree today (PLAN M0.5 task 3), pinned by the `formats` section:

| Policy | Rule | Used by |
|---|---|---|
| `syncable` | the path rules above | the server, on every entry |
| `chunkingText` | extension, in ASCII lower case, in the text list | chunk sizes only; a wrong answer costs efficiency, never correctness |
| `searchable` | syncable, ending `.md` or `.txt` in any ASCII case, drawings included | the search index |
| `mcpReadable` | the same as `searchable` today | MCP read tools |
| `mcpEditable` | readable and not ending `.excalidraw.md` | MCP write tools |

## Chunk bodies

A chunk's **name** is the lowercase hex SHA-256 of its raw bytes. A **body frame** is one binary WebSocket frame:

```text
byte 0      marker: 0 = raw, 1 = raw deflate (RFC 1951)
bytes 1..   payload
```

The receiver refuses a frame longer than `chunkMax + 1` bytes before inflating anything, refuses a payload that inflates past `chunkMax` (bounded as it inflates, not after), refuses a chunk of zero bytes (no file has an empty chunk), then hashes the raw bytes and matches the name. Bytes after the final deflate block are ignored: they cannot change the decoded bytes, which the name checks. A sender uses marker `1` only when the deflated payload is shorter than the raw bytes, which is what keeps every frame within `chunkMax + 1`. So `chunkMax` bounds raw bytes, and the frame bound is one more. Deflate output need not be identical across implementations. The server stores raw bytes. **Settled in M1:** a frame over the bound, or one that inflates past `chunkMax`, ends the upload with `toolarge`; any other frame the decoder refuses, and a decoded body that is not a chunk still wanted, ends it with `badchunk`. The per-entry upload allowance counts decoded bytes, so a small deflate stream cannot buy an entry more than its declared size. Pinned by the `frames` section of the fixtures, consumed by `internal/frame` and `client/src/core/frame.ts`.

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
<- {res:"devices", id, devices:[{id, name, createdAt, lastSeen, online, applied}], invites:[{invite, label, expiresAt}]}

-> {op:"rename", id, name}          <- {res:"renamed", id, name}
-> {op:"revoke", id, deviceId}      <- {res:"revoked", id, deviceId, self}
-> {op:"invite", id, ttlMs?, label?} <- {res:"invited", id, invite, token, expiresAt}
-> {op:"uninvite", id, invite}      <- {res:"uninvited", id, invite}
```

**Settled in M1.** A label is at most 64 bytes with no control characters (`badname`). `ttlMs` of 0 or absent is the one-hour default, anything above an hour is clamped to it before it is converted, so no value overflows into a past expiry, and a negative one is `badentry`. `invited.expiresAt` is null only for an invite that never expires, which only `trew invite -ttl 0` on the server can make. `uninvite` of an id that is unknown, malformed, spent, cancelled or expired is one `badentry` naming the device list. **Revoking a device cancels the invites it issued**, in the same transaction as the delete: an invite a laptop minted before it was stolen would otherwise add the thief's next device after the laptop was revoked. Invites the operator made name no device and are untouched. **A backup does not carry an outstanding invite**: restoring an old copy must not revive an invite that has since been used or cancelled, so the snapshot keeps only spent rows, and `trew backup` prints how many it left out.

**Settled in M1: what a revoke means on the server** (PLAN §2.3.1). The row is deleted and the device's sessions are taken out of the fan-out inside one hold on the commit lock, which every mutation and every broadcast also takes, so no commit after the revoke can reach them and no mutation they have in flight can commit (each rechecks the row under that lock). Those sessions are also marked, and their writer sends nothing more but the unsolicited `auth` notice: a batch already queued, a catch-up page, or the reply to a request sent a moment before is dropped at the socket. Basalt deleted the row, released the lock, and only then looked for the sessions, so a commit from another device landing in that window was broadcast to a device already reported revoked.

`invite` in a listing, in `invited` and in `uninvite` is the invite's **id**: 8 random bytes, base64url, minted with the invite and stored beside it. It is not the token and not derived from it. Basalt listed the redemption identifier itself, which was safe only because redeeming also needed a key that never reached the server; with a bearer token that listing would hand every paired device a working invite. Nothing in any listing can redeem an invite, and a test proves it field by field. `token` appears once, in `invited`, to the device that asked; the device formats the string with its own server URL and vault.

**The first device.** `trew serve` on a store with no devices and no outstanding invite mints one invite (one-hour TTL) and writes its string atomically, mode 0600, to `<data>/first-invite` (or `-invite-out FILE`). It logs that path and the expiry, never the string, because a container log is not a private place. `trew invite` on the server host (through the control socket while `serve` runs) prints a fresh invite to stdout, or writes it to `-out FILE`.

**Settled in M1: the address an invite carries.** `-url` when given, which must be canonical `ws://` or `wss://`, and is checked before the port opens. Otherwise `-localhost` gives `ws://127.0.0.1:PORT`. Otherwise each address of this machine a device could dial, as Basalt's pairing lines named them, with `wss://`, which is what those lines meant without a scheme. The first-invite file holds one invite string per address, one per line, all carrying the same token: a device redeems whichever it can reach and the others die with it. When no address can be found, no invite is minted, and `serve` says to start it with `-url`. A restart inside the hour leaves the file alone, since its invite is still outstanding.

`devices` includes MCP author rows so the panel shows agents. **Not as `id` starting with `mcp:`**, because `ValidDeviceID` accepts base64url (`basalt:server/internal/store/store.go:2595`), which has no colon, so that scheme is not the unchanged devices table it was described as. Author rows carry their own `kind` and a valid id, and they are refused as `hello` credentials. An author row must not present as an offline sync peer whose applied checkpoint other devices wait on. Revoking the last real device is allowed from a device session; recovery is `trew invite` on the server, so `allowLast` is gone (settled in M0.5: without a vault key, no device holds anything the server cannot reissue). `register` and `rotate` are gone.

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
| `nouid` | a `get` for a uid this vault does not have | no | rejects |
| `nocontent` | a `get` for a folder or a deletion, which has no body | no | rejects |
| `nochunk` | a `fetch` or `resend` naming a body the server does not hold or no entry refers to | no | rejects |
| `nodevice` | a `revoke` for a device id this vault does not have | no | rejects |
| `internal` | server fault, not committed | yes | ends in handshake, else rejects |

`rotated` is removed.

## Limits

Unchanged: `perFileMax` default 64 MiB, `chunkMax` 1 MiB, `maxChunks` 65,536, `maxBatchBytes` 16 MiB, `maxFetchBytes` 64 MiB, 256 entries per batch, request ids 1 to 2^32-1, hello read limit 64 KiB, post-auth read limit 32 MiB, ping every 45 s with a 15 s pong wait.

The four upload budgets, stated separately: **raw** bytes, the sum of declared sizes in one `putmany`, at most `maxBatchBytes`; **frame** bytes on the wire, one binary frame per chunk of at most `chunkMax + 1`; **control** bytes, one text frame at most the post-auth read limit (the hello at most 64 KiB); and the **aggregate** per request, the raw budget, since a frame's marker byte is the only overhead and is bounded per frame. Each is pinned at its boundary by a fixture in M1.

## MCP over HTTP

Not part of the WebSocket protocol, listed here because it shares the listener. `POST`/`GET`/`DELETE /mcp` per MCP streamable HTTP, `Authorization: Bearer <43 base64url chars>`, `WWW-Authenticate: Bearer realm="trew"` on 401. Every other path without `Upgrade: websocket` is 426 as today, except `/health`.
