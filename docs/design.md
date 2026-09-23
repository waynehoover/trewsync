# Design and threat model

[Developer documentation](development.md) · [Plain-language privacy guide](security.md)

Trew serves one person's trusted devices through one server. The product
priorities are preserving notes, keeping deployment small, and reducing repeat
transfers. This is an engineering reference, not a setup guide.

## The durability rules

These rule numbers are stable because code comments cite them. The
[findings index](findings.md) links the implementation's review history.

1. **Acknowledge only after the write is durable.** Commit content and its
   version record before confirming an upload.
2. **A failed read is not an empty result.** Refuse unreadable state instead of
   replacing it with defaults. This prevents a failed read becoming a deletion.
3. **Never delete until a verified copy exists elsewhere.** Verify the copy
   before removing the source.
4. **Verify the outcome, not the exit code.** Check the written bytes and
   resulting state; a successful call alone is insufficient.
5. **Never write a result smaller than its input without proving that is
   right.** Merges, pruning, and rewrites must account for what they remove.
6. **Deletions are entries, not absences.** Retain a deletion record so clients
   can distinguish removal from an incomplete listing.
7. **A status describes the vault, not the filter.** Report exclusions,
   refusals, retries, and unresolved recovery alongside successful transfers.
8. **Trust the numbers, not the passes.** Investigate impossible counts and
   timings even when assertions pass.
9. **A fix without a test that failed first is not finished.** Demonstrate the
   failure without the fix and the pass with it.
10. **Assertions must check the property that matters.** Device agreement is
    insufficient if both devices lost an edit. Check the retained content.
11. **A recovery path tested only in docs is a rumour.** Exercise restore with
    the built server and read the restored versions and content back.

Writable server startup flushes the chunk directories and their ancestors
before reporting existing bodies as durable. This requires readable directory
ancestors and working directory `fsync`; a failed flush refuses startup or the
affected write. Inspection commands do not perform these flushes.

## Conflicts: keep both

Three-way merging uses the last reconciled content as its ancestor. The engine
checks overlap, merge-order agreement, patch application, and retained insertions.
Structured formats have additional validity checks. A refused merge keeps both
versions; a successful merge can update the original note.

In ordinary conflict handling, the incoming version takes the conflict name.
An edit detected during replacement can instead be preserved under a new name.
Neither rule provides mutual exclusion with the editor.

A read-only CLI device must record local reconciliation separately from
uploading. Otherwise a successfully preserved or merged remote version remains
eligible on every pass. Its local edit remains held back even after that remote
version has been handled.

## File replacement

Both adapters preserve existing content before replacing it. If preservation
fails, the write stops. Retained versions are visible files or have recovery
records that survive restart; unreadable inventory is an explicit incomplete
state.

The CLI uses local filesystem link/rename behavior. For new files and binary
replacements, the plugin stages content and relies on Obsidian's adapters
refusing occupied rename destinations, as inspected in Obsidian 1.13.7. The
mobile path also rechecks a destination before rename, which narrows a race
without proving exclusion.

Text replacements keep the original file at its path so open editors continue
showing that note. The plugin creates and verifies a visible backup, then uses
`DataAdapter.process()` to compare and write inside Obsidian's save queue. A
save that changes the text before that comparison is left alone. The backup
stays until the new text is verified; desktop also flushes the backup before
writing and the updated note before removing it. A failed or interrupted write
leaves the backup available under its conflict-copy name.

`process()` writes strings in place. Its queue serializes Obsidian's saves on
desktop and mobile; it does not make filesystem writes atomic or coordinate
external editors. The backup supplies recovery. It cannot replace the binary
write or deletion paths. Tests of the fake adapter need supplementing with
open-editor acceptance against supported Obsidian releases.

Desktop can flush through the filesystem; mobile does not expose an equivalent
flush primitive. Mobile crash/power-loss durability is therefore weaker. A
whole-file fallback can also exceed an older phone's memory on large attachments.
The 64 MiB default was informed by desktop measurements, not a measured bound
for every phone.

## Agent edits in the headless client

The MCP process is a local author on each explicitly configured paired directory. Its writes
run in the owning client's serial queue alongside sync, and its vault lock
remains held until admitted work drains. Offline inspection is allowed; a new
mutation requires a settled live writable client. Read-only launch omits mutation
tools while still allowing incoming synchronization.

A matching content base proves which bytes an edit starts from, not whether a
model's replacement preserves their meaning. MCP therefore exposes exact unique
old-to-new edits, exact append and prepend, with no whole-file writer. Prepend
retains an existing UTF-8 BOM at the start. Before changing an
existing note it creates an independent visible before-image, reads and compares
its bytes, and flushes it. Failure stops before touching the original. Backups
remain ordinary synced files, immutable through MCP. Creation and restore publish
only to absent destinations; restore requires an authenticated version belonging
to the requested path and an explicit different destination.

Tag and namespace tools first return a bounded preview. Applying requires every
affected base and exact source edit as input; recomputing a different plan refuses
the request. A batch validates all inputs and verifies and flushes all required
before-images before publishing its first change. It then rechecks each source
and reports per-file results. A later failure retains completed work and all
recovery copies, without rollback over another author's save.

Moves publish a verified destination, update approved links, then recoverably
delete the source last. This deliberately uses ordinary sync create/delete
semantics. It does not promise atomic remote visibility or move history across
paths. Permanent deletion and mutation of recovery copies remain unavailable.

Success distinguishes a verified, flushed local result from server delivery.
Cancellation or connection loss cannot roll back an admitted write; unknown
outcomes require inspection before retry. Checked access refuses existing child
symlinks and ambiguous names. This is not isolation from a hostile local OS user
continually swapping directories or editing open descriptors. The supported
storage and cooperating-owner assumptions still apply, and a host receiving
notes has access to their plaintext.

A multi-vault endpoint exposes only its explicit, non-overlapping root set.
Every call selects a vault when more than one is configured. Session closures
keep clients, keys, bases, queues and history separate. All root locks remain
held until every session drains. The HTTP credential belongs to the first
configured directory and authorizes the whole configured endpoint, not a
per-vault subset. Separate access scopes require separate endpoints.

Version comparisons authenticate both historical selections through the chosen
vault and path. Local comparison pagination pins full content bases. Device
receipt reports require settled local state before and after reading server
checkpoints; they cannot establish delivery of a particular tool call.

## Fast, because it sends less

Files are divided into content-defined chunks, compressed, then encrypted.
Unchanged chunks are reused across versions. Compressing before chunking would
move boundaries after edits; compressing ciphertext would not save space.

The compression implementation and chunking parameters affect content names.
Changing them can trigger re-upload or require a migration. See
[historical measurements and evaluations](research.md) before changing them.

## Sync scheduling

Local events and remote arrivals schedule sync on the next event-loop turn.
Events delivered together share a pass; there is no fixed 50 ms wait. An arrival
pass first finishes checking the metadata already received, without waiting for
future frames. Initial sync waits for the complete catch-up history. Notes and
other recognized text formats (including canvases) have no per-file cooldown,
regardless of size.
Repeat binary uploads wait 1 second for files up to 10 KiB, 2 seconds up to
100 KiB, and 5 seconds above that, measured from the previous successful sync.
New files and incoming reconciliation have no upload cooldown. “Sync now”
bypasses the binary upload cooldown.

Each pass reports the earliest deferred upload or transient retry deadline.
A running client wakes at that deadline, replaces it when an earlier one appears,
and cancels it when the work clears or the client closes. All passes use the
existing serial queue.
The 30-second scan and keepalive remain a fallback; they do not set the normal
cadence. One-shot and inspection clients do not start deadline timers.

“Sync now” and content verification retry transient failures immediately. A file
change also releases that file's retry delay. Failed retries retain exponential
backoff; permanent refusals still require the reported problem to be corrected.

The CLI reuses file listings only while a healthy watcher is active. Known file
edits refresh individual stats; namespace changes and uncertain events invalidate
the listing. Periodic scans, content verification, and inspection use a full walk.
Recovery inventory remains fresh on every pass. The plugin uses Obsidian's file
inventory instead of this filesystem cache.
Before reconciling, the engine checks missing paths that were previously synced.
A restored path triggers a full scan instead of trusting a cached absence. This
happens before writes, so case-only renames and file/folder transitions retain
their normal ordering.

Foreground, focus, and network-online events check the socket immediately and
interrupt local reconnect backoff. An idle socket gets a two-second probe;
active transfers keep their normal progress timeouts. Sync passes remain serial.
Folders and text files are processed before binary attachments, and queued
notes are transferred before attachment reading and chunking starts.

Large uploads use a temporary authenticated connection while the owning engine
can send independent saved text edits through the main connection between chunks.
This path is limited to existing notes up to 512 KiB; conflicts, renames, and
overlapping paths use ordinary reconciliation. The engine remains the sole index
writer. Before recording an auxiliary upload, a main-connection ping and metadata
drain establish ordering with that upload's broadcast. Both connections close
with the client; the temporary connection also closes when the sync finishes.

A completed local checkpoint is reported only after a clean pass flushes files
and saves the index. The device list exposes this separately from metadata
receipt. Visible panels share one delivery request: every 250 ms while online
peers are behind, every two seconds for offline peers or errors, and every ten
seconds when settled. State changes invalidate the result immediately. Hidden
or closed panels do not poll. Receipts expire with the connection and are not
stored in SQLite, avoiding a database write per edit.

Version history keeps only the selected preview in memory, sharing an in-flight
download and reusing it when switching between text and changes. Comparisons
always reread the local note. Closing the window discards the preview and stops
late page responses from starting further downloads. Repeated Restore taps
cannot start another restore while the first is running. Deleted-note recovery
uses the same busy behavior, and refreshing Settings disposes the previous panel.

Manual sync interrupts reconnect backoff when offline. Repeated requests share
the same work, and the panel shows a disabled busy action while connecting,
loading, or visibly syncing. Automatic passes shorter than 200 ms keep the last
status; sustained work updates at most five times per second, including scanning
and saving the index.

Open setup panels follow pairing changes without replacing unfinished inputs on
routine updates. Activity updates on the next visible animation frame. Status
icons retain their elements during progress updates, and history pagination
preserves keyboard focus. Preview opens with a loading state while its scan runs.

During sync transfers, the panel reports upload or download activity, the file
or batch count, and encrypted body bytes sent or received. Reused chunks are
excluded. Upload counts subtract the socket buffer when the adapter exposes it;
otherwise they measure handoff to the socket. There is no percentage or ETA:
compression and deduplication change the wire size, and downloads do not know
that size in advance. Counters span split fetches within a batch. Receiving
bytes does not imply verification or a saved file; only the completed pass can
report reconciliation. Display callbacks cannot interrupt an exchange.

## Simplicity

Keep sync decisions in the shared engine. Adapters provide file operations;
the CLI and plugin expose outcomes and user actions. Shared state transitions
and outcome rendering reduce differences between the two clients.

The plugin has actions rather than a general settings screen. Server flags and
CLI options still form a configuration surface and need explicit documentation
and combination testing. Avoid adding a second implementation where the same
behavior can be shared.

Joining an existing vault checks the filesystem before registration or invite
redemption; unreadable folders refuse pairing. Empty vaults proceed directly.
Populated vaults require confirmation before their files are combined with the
synced vault. Cancelling does not consume the invite. This is a setup step, not
a lasting merge preference: paired devices use normal two-way sync.

## Refusals

Current scope excludes a second server backend, peer-to-peer sync, teams/shared
vaults, and a server web interface. Obsidian configuration sync is also absent:
settings and workspace files have different ownership and failure consequences
from notes, and the configuration folder contains device credentials.

The HTTP MCP endpoint is an agent transport on a paired device, outside the
excluded server web interface scope.

Notes and ordinary attachments are the target. Large media libraries, arbitrary
filesystem layouts, and untrusted collaborators require a different product
scope. These are scope decisions, not claims that alternatives cannot solve them.

## Where this is supported

| Environment | Status |
|---|---|
| Obsidian on macOS/Linux, local storage | Supported product scope; real-app acceptance remains necessary. |
| Obsidian on Android, local storage | In use; foreground sync only, with mobile durability limits. |
| CLI on macOS/Linux, local storage | Experimental; intended primarily for mirrors. |
| iOS | Untested. |
| Windows | Unsupported. |
| NFS, SMB, or other network filesystems | Unsupported. |
| A vault spanning several mounts | Outside the tested setup. |
| Another sync tool on the same local vault | Unsupported. |
| Two Trew writers to one local vault | Unsupported; CLI exclusion enforces one CLI writer. |

Editing on separate devices is supported. Running the plugin and CLI against
the same local directory is a different case and must be avoided. Filesystem
support depends on the concrete mount and adapter, not just an OS label.

## What the server can and cannot do

The server stores encrypted content and paths. It does not hold the plaintext
data key, but does hold wrapped keys, credential hashes, and readable metadata.
It sees sizes, timestamps, device labels, update activity, and repeated chunks.
It also sees the byte length of every filename, and which filenames are the same
length as each other: `sealPath` is AES-GCM over the UTF-8 path with a fixed
28-byte overhead, so a sealed name is exactly 28 bytes longer than the name
(R083-25). Padding names to a bucket would hide it, and would change every
sealed path in every vault, so it is a migration rather than a fix and is
recorded here instead.

The entry authenticator covers the sealed path, size, timestamps, folder and
deleted flags, previous path, ordered chunk list, and parent. Clients verify it
before applying or restoring content and check assembly sizes and ancestors.
A server without the data key cannot forge arbitrary authenticated content.

**Ordering and completeness remain trusted.** The server assigns UIDs, which
are not authenticated. It can replay an older valid version under a newer UID,
causing an unchanged local note to revert, or withhold entries. The signed
`parent` is not currently checked as an ancestry chain. A newly paired device
has no retained checkpoint to challenge an old but valid history.

Do not describe this as protection from every malicious-server action. Server
availability and honest ordering are part of the deployment assumptions. A
backup protects against some operational failures; it does not prove freshness.

### What a stranger on the port learns

Unauthenticated callers can reach health, the initial handshake, and protocol
refusals. These can reveal that Trew is present, supported protocol numbers,
and a bounded readiness reason. They do not include vault contents, paths, or
the server release. The release is advertised after authentication.

Authentication failures avoid distinguishing unknown vaults, device rows, or
invites. Format errors remain distinct because they describe the request;
capacity details requiring vault state are checked after authorization.

### Why a loopback bind is not the token

A reverse proxy forwards remote traffic to loopback. A local bind therefore
cannot authorize the first claim. The bootstrap token is required on every bind,
including `-localhost`; a successful claim binds the vault once and subsequent
claims cannot replace it.

## The keys

A vault begins with a random 256-bit root secret and a random 256-bit data key.
The root derives an authentication key for registrar operations and a wrapping
key for the data key. The data key derives separate path, content, nonce, and
metadata-authentication keys through HKDF-SHA256.

Each device has its own random secret for connection authentication. The server
stores credential hashes. These are random keys, not user-chosen passwords.
See the [protocol's crypto section](protocol.md#crypto) for the construction.

Sealing uses AES-GCM with an HMAC-derived 96-bit nonce. Equal plaintext under a
key produces equal ciphertext, enabling deduplication. This is not AES-GCM-SIV;
a collision between distinct plaintexts would reuse a GCM nonce. The birthday
scale is about 2^48 distinct inputs, a probabilistic bound rather than an
impossibility. Do not present deterministic sealing as revealing no information.

## Four credentials, and who holds which

| Credential/key | Held by | Purpose |
|---|---|---|
| Recovery key/root secret | Owner's separate recovery copy; transiently during setup/rotation | Register devices, rotate the root, administer device access. |
| Device secret | That device | Connect, sync, list/revoke devices, issue/cancel invites. |
| Data key | Every paired device | Encrypt, decrypt, and authenticate vault content. |
| MCP bearer token | Owner and configured MCP client; serving device stores only its hash | Authenticate to one device's HTTP MCP endpoint in its launch mode. |

A paired device does not normally retain the root. An incomplete initialization
can retain it until device registration finishes, so an error must preserve and
explain that recovery state.

The MCP token is independently random, not derived from another vault key.
Its hash lives in unsynced `.trew` state. Rotating or revoking it does not
change device registration, recovery access or encryption keys.

## What a device can do to another device

Paired devices are trusted with all vault content. Clients still reject paths
outside the vault, traversal, unsafe symlink destinations, and excluded paths
such as the Obsidian configuration folder.

A device cannot directly register with the root or rotate it, but **can issue
an invite and thereby add another device**. Device and invite listings make
that authority visible; they do not prevent a compromised authorized device
from using it. Any device can revoke another except the final device, whose
revocation requires the recovery key.

CLI read-only mode restricts ordinary sync behavior. It does not change the
server credential or prevent explicit repair and administration requests.

## A lost or stolen device

Revoke its device ID to remove access through the server and close its live
connections. Review other devices and outstanding invites. If the root may be
exposed, rotate it and save the new recovery key.

Rotation changes the root and the wrapping of the **same data key**, cancels
invites, and leaves existing devices and history intact. It does not remove
access granted to other already-registered devices; inspect and revoke those
separately. Operator steps are in [Security and privacy](security.md).

### What a revoked device can still do

Revocation does not erase local notes or the data key. It also does not prevent
decryption of future ciphertext obtained from another device, backup, or other
source. Rotation does not change that. Trew does not provide forward secrecy
through device revocation.

### What the authenticator proves, and what it does not

| Property | Current guarantee |
|---|---|
| Content authenticity | A holder of the shared data key authenticated the protected fields. |
| Device attribution | Not provided. The free-text device label is not covered by `macEntry`, and there are no per-device content signatures. |
| Freshness | Not provided by the MAC; the server-assigned UID is not covered. |
| Completeness | Withholding is not fully detected. |

## Provenance

Release workflows rebuild assets from tags and generate provenance attestations.
Verify the published asset and its checksums; do not infer its contents from a
local build. [Developer documentation](development.md#releases) covers the tools.
Provenance identifies a build; it does not establish that the code is secure.

## What is not claimed

- Full detection of replay, withheld history, or a server refusing service.
- Cryptographic attribution of a version to a particular device.
- Erasing keys from a revoked device or forward secrecy after revocation.
- Mobile persistence guarantees equivalent to desktop flushing.
- Safe coexistence with another sync engine or arbitrary network filesystems.
- Complete semantic validation of every merged format. For example, valid
  canvas JSON can contain an edge whose node another device removed.

A change to the deployment model should revisit these assumptions before adding
mechanisms intended to cover it.

## Concurrent branch preservation

For honest devices, every independent edit must remain in a current note or an
accessible preserved copy after reconciliation, including when an author goes
offline after its first accepted write. Agreement among clients is insufficient.

Protocol 7 appends only when the writer's target UID and, for a rename, source
UID still match. A refused writer reads intervening metadata and reconciles
before retrying. Merged local text retains the remote ancestor it incorporated,
even if publishing that merge is refused. Renames retire their source at the
same UID; a concurrent source edit prevents that retirement and is preserved.
See [conditional writes](protocol.md#conditional-writes) and the
[multi-device regression cases](../client/src/stress/preservation.stress.ts).
