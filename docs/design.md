# Design and threat model

[Developer documentation](development.md) · [Plain-language privacy guide](security.md)

TrewSync serves one person's trusted devices through one server. The product
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

A conflict copy is named after the author of the bytes it holds, as
`<name> (Conflicted copy <author> <stamp>)`. For an incoming version that is
the device the server recorded on it: another device's name, or an MCP
token's label for an agent's write. For bytes that were on this disk (an edit
a download or a deletion displaced, or one saved while a conflict review was
applied) and for a merge this device made, it is this device's name, which is
also the fallback for a version with no recorded author, such as one kept in
an index saved before 2026-09-23. Until then every copy carried the name of the
device that made it, so a phone keeping the Mac's text named it after the
phone. The author is made safe as a filename component: characters a platform
refuses become `-`, other whitespace and control characters one space (spaces
themselves stay), direction overrides are removed, the adapters' staging mark
is broken up, a `(Conflicted copy ` inside it loses its bracket so the copy
still pairs with its note, and it is cut to 32 characters; the whole path is
kept within the protocol's segment and path limits by shortening the author
first. What recognises a copy, the conflict review and the name MCP refuses to
create, reads any author, and the pattern is the one it always was.

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
without proving exclusion. A staged copy renamed into place is missing from
Obsidian's index until its file watcher reports it, so the plugin lists each
name it renamed onto from the adapter until the index has it. Listing from the
index alone read a file just downloaded as a local deletion.

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

## Folders

A folder's deletion travels, and it never takes a file with it. Until
2026-09-23 it did not travel at all, a rule inherited from Basalt: renaming
`Projects Old` to `Projects New` left an empty `Projects Old` on every other
device, and an empty folder deleted on one device stayed on the rest.

The device that removes a folder it synced sends the folder's deletion at the
end of the pass, after the deletions and moves of everything that was in it
have committed, deepest folder first, and only while the server holds nothing
live beneath it. Files still travel one by one, exactly as before.

A device receiving a folder's deletion removes the folder at the end of its
pass, once that pass's own deletions have landed, and only if the folder is
empty on its disk at that moment. The headless client's removal is `rmdir`,
which the kernel refuses for a directory holding anything. Neither Obsidian
adapter can remove only an empty folder (read out of 1.13.7: desktop `rmdir`
refuses a directory unless told to recurse, and mobile `rmdir` always
recurses), so the plugin moves the folder to a hidden name, looks again there,
and removes only what it has just seen to be empty; anything saved into it
before the move is still in it, and the folder goes back. The move is written
in the displaced ledger first, so a kill between the move and the second look
leaves a record, and the next scan puts back whatever the hidden folder holds.
Nothing in a folder is deleted or trashed for the folder's sake, except
operating system metadata this device never syncs (`.DS_Store`, and
`Thumbs.db` or `desktop.ini` where they are ignored), which does not keep a
folder and is removed with it when nothing else is inside.

What is still in the folder decides what happens to it:

- **Kept, and put back on the server**: a file this device has not sent or
  has edited, a note written after the deletion, a folder inside it that
  stays, and anything else the listing never shows, such as a dot-prefixed
  file other than that metadata, a file this device ignores, or one two names
  claim. The folder goes back as a live folder based on the deletion it
  answers, and the device that deleted it creates it again.
- **Waiting**: a file whose deletion this device has received and not yet
  applied, and a synced, unchanged file whose server version is older than
  the folder's deletion, whose own deletion is therefore still to come. The
  folder is removed once they have gone.

So a folder's deletion arriving before, with or after the deletions of its
files, in one pass or across a reconnect, ends in the same place, and a folder
deleted on one device while another writes a note into it ends with the note on
every device and the folder live, whichever syncs first.

**The server refuses a folder's deletion while anything live is beneath it**,
as `stale` (`ErrFolderNotEmpty` in `internal/store/collision.go`). Accepting it
and leaving the next device to put the folder back was the alternative, and
it would leave histories in which a folder went while a note in it stayed. A
device reading one cannot tell a note written in the race, which should keep
the folder, from a file deletion still to come, which should let it go.
Refused, a folder's deletion in the history always comes after everything in
the folder has gone, so whatever a device finds in a deleted folder is either
something it has not sent or something written afterwards, and both keep the
folder. The deleting device reads what arrived and decides again, as it does
for any stale write. A rename's retirement of its source is not a deletion and
is not refused, which is what lets a case-only folder rename move its entry
and its files one move at a time.

A case-only folder rename still travels as a move (plan/protocol.md, "Paths",
collision rule 1). On a disk that folds case the two spellings are one folder,
so neither is read as a deletion there: nothing sends a deletion for either,
and nothing removes the folder. On a disk that keeps case apart the old
spelling is an empty folder of its own, and it goes.

A folder another device put back after this one removed it is created again
here. A read-only device sends no folder deletions and reports each as held
back. The deletion review asks once, about the files a folder's deletion
removes; the folder's own deletion adds no second question, and a device
receiving it is not asked. The deleted-notes list leaves folders out: nothing
in one can be restored, and every file that was in it is listed by its own
deletion.

**History from before the change is not migrated.** Folder entries left live
by a removal under the old rule stay live on the server. A device that made
such a removal and still has its record of the folder, which it keeps for as
long as the server holds the folder live, sends the deletion on its first
pass under the new rule; every other device then removes its copy only if it
is empty there. A folder no device has that record of stays until someone
deletes it again.

## The agent endpoint

`trewd serve -mcp` answers MCP at `/mcp` on the devices' listener. The user
guide is [Connect an agent](agent.md); the tool contract is
[plan/mcp-tools.md](../plan/mcp-tools.md). The principles it holds to:

- **Tools work on the store, not on files.** A read assembles a version's
  chunks; a write chunks the new bytes, stores the bodies durably, and
  appends entries through the same write path a device's `put` takes, under
  the same commit lock, then broadcasts through the same hub. There is no
  second copy of the vault, no filesystem lock and no before-image file: the
  version an agent's write displaces stays in history, pinned.
- **An agent's write is one operation.** `CommitOperation` commits every entry
  of a write or none of them, beside a device's `putmany`, which stays
  deliberately partial. The operation row, its entries, its pins and its
  recorded reply are written in the same transaction. Preparation (reading
  heads, computing bytes, storing bodies) happens outside the lock; the
  credential, its scope, the store epoch and every base are checked again
  inside it, so a token revoked in between loses there.
- **Every write names what it read.** A mutation's `base` is the uid the agent
  read, the same precondition a device's `put` carries, bound to the store
  epoch. A move, a deletion and a tag change are previewed, and the apply is
  bound to the vault head the preview read, which catches a new backlink or a
  changed namespace that no per-note base can see. That is conservative: any
  write in between refuses the apply.
- **No whole-file writer.** Exact unique spans, append, prepend and create.
  Exact edits are not a semantic safety boundary (a whole small note can be
  one span), which is why retention, audit and undo carry the weight.
- **What a write displaces is pinned.** Every displaced version is pinned for
  at least 30 days from the operation's commit, by the server's clock, and
  purge's survivor set includes unexpired pins. An age cutoff on the version
  would not do: a note last edited a year ago has an old previous version, and
  its before-image would be purgeable the day the agent edited it.
- **Undo is a compensating operation.** It appends new versions, and only if
  every path the operation changed still holds what the operation left there;
  otherwise it refuses, or writes the earlier versions beside their notes.
  History is never rewritten. An agent undoes only its own token's
  operations; a device and the operator may undo any.
- **Committed, delivered and known are three facts.** `committed: true` is
  durable, not delivered: delivery is what devices confirm through applied
  checkpoints. A reply lost after a commit is resolved by the idempotency key
  or `lookup_operation`, and an outcome the server cannot determine is
  reported as `committed: "unknown"`, never as a refusal.
- **Note content is untrusted.** Every result separates what the server
  vouches for (`trusted`) from everything drawn from note bytes
  (`untrusted_content`), passes the second through one normalisation
  function, and repeats the warning in every tool's description. The
  boundary is in the data rather than in a convention a client must follow.
- **Scope is enforced three times.** A read token is shown only the read tools
  (presentation), a write tool it calls is refused at dispatch (enforcement,
  whatever the client was shown), and a write re-checks the credential under
  the commit lock. `TestOnlyTheCommitBoundaryReachesAMutation` fails the build
  when any mutation is reachable outside that boundary.
- **An author is not a device.** Each token has an author row of its own
  kind, named by its label: it appears in history and in conflict-copy names,
  never in the device list, and no device waits on it as an offline peer.
- **Search is derived and cannot refuse a write.** The index is maintained by
  a worker outside the commit path, from a durable `indexed_through_uid`, and
  literal search stays literal: the index only proposes candidates where it
  cannot omit a match, and the matcher decides.

### No MCP in the headless client

Basalt Sync's headless client had an MCP server of its own, because its server
could not read notes: it wrote through a paired directory, kept before-image
files beside each note, and held the vault's lock while a write drained. On a
server that holds the notes, that design is a second writer with weaker
guarantees than the one above: no commit boundary, no audit, no undo, and a
before-image a device could edit. It is removed (PLAN.md M2 task 10), once the
server's tools passed the fixtures its note functions were ported against.
Those functions stay in `client/src/node/mcp-*.ts` as the oracle
(`mcp-oracle.run.ts` regenerates `mcp-fixtures.json`), reachable from neither
bundle.

## Fast, because it sends less

Files are divided into content-defined chunks, each named by the SHA-256 of
its raw bytes. Unchanged chunks are reused across versions, and the server can
recompute every name from the bytes it holds. Compression happens on the wire,
one chunk at a time: a body frame is marked raw or deflated, and the receiver
inflates it before checking the name. Compressing before chunking would move
boundaries after edits.

The chunking parameters affect content names; changing them re-uploads existing
content. The compression implementation does not, because names are over raw
bytes. See [historical measurements and evaluations](research.md) before
changing the chunker.

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
Restored paths trigger one forced listing that names every one of them, instead
of trusting a cached absence. The CLI walks the disk for it; the plugin, asked
for a forced listing on every periodic pass, reads the named paths from the
adapter rather than walking, because Obsidian's index can be behind the disk
when another program deletes a file and writes it again. This happens before
writes, so case-only renames and file/folder transitions retain their normal
ordering.

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
or batch count, and body bytes sent or received, as framed on the wire. Reused chunks are
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

Joining an existing vault checks the filesystem before invite redemption;
unreadable folders refuse pairing. Empty vaults proceed directly.
Populated vaults require confirmation before their files are combined with the
synced vault. Cancelling does not consume the invite. This is a setup step, not
a lasting merge preference: paired devices use normal two-way sync.

## Refusals

Current scope excludes a second server backend, peer-to-peer sync, teams/shared
vaults, and a server web interface. Obsidian configuration sync is also absent:
settings and workspace files have different ownership and failure consequences
from notes, and the configuration folder contains device credentials.

The server's `/mcp` endpoint is an agent API, not a web interface: it serves
no pages and has no browser login. It has no OAuth, no per-note or per-folder
read control (a token reads the whole vault), and no whole-file writer.
Per-token path scoping for writes is deferred, and would not restrict reads.

The plugin does not update itself. Obsidian installs and updates community
plugins from the directory, reading the release that matches the manifest and
`versions.json`, and the directory's guidelines forbid a plugin that downloads
and runs code of its own; PKV Sync does, and it is the pattern this refuses. An
updater inside the plugin would also be a second way for code to arrive on
every device, one Obsidian's review and the release attestations never see.
The server is different: `trewd update` replaces a binary the operator
installed by hand, only after verifying the release manifest, and never
replaces one a package manager owns.

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
| Two TrewSync writers to one local vault | Unsupported; CLI exclusion enforces one CLI writer. |

Editing on separate devices is supported. Running the plugin and CLI against
the same local directory is a different case and must be avoided. Filesystem
support depends on the concrete mount and adapter, not just an OS label.

## Threat model: the server is trusted

**The server is trusted with everything.** It stores every note, every earlier
version, every filename and every chunk in plaintext, with the device, invite
and MCP credential hashes and all the readable metadata: sizes, timestamps,
device labels, update activity and the agents' audit log. That is the decision
the product rests on (PLAN.md section 3.6): it is what lets the agent endpoint
read and write the store. The [threat model](threat-model.md) lists each
requirement it creates and what enforces it.

**The readable surface is larger than the notes.** Current notes, every
deleted version still in history, chunks from abandoned uploads, filenames,
search terms and tags in the index, and audit context. And not only the files
meant: the SQLite write-ahead log, `search.db`, temporary files, backup
staging, filesystem snapshots, crash dumps and any copied volume.

**What that requires of the deployment**, stated as requirements rather than
advice:

- The data volume sits on encrypted storage, with its key's location and the
  unattended-restart unlock written down.
- Backups are encrypted, including those that stay on the same machine. A
  backup is a complete readable copy of the vault and its history.
  (`trewd backup` itself writes plaintext; encrypting its destination is the
  operator's.)
- TLS in front of the server. Device tokens, MCP tokens and note contents all
  cross the network.
- `/mcp` behind Tailscale or an identity-aware proxy. The bearer token is the
  only thing between whoever can reach the port and the whole vault.

**What encryption at rest does not buy.** Nothing against a compromised
running host, nothing against an agent holding a valid token, nothing against
a model provider receiving tool results, and nothing when a logical snapshot is
taken from an already-unlocked filesystem. If protection from a live server
compromise ever becomes a requirement, dropping end-to-end encryption has to be
reopened; no amount of at-rest work substitutes for it.

**The agent is a new reader and a new writer.** A token's read scope is the
whole vault, by design, and everything it reads reaches the agent's model
provider. A write token can change any note the path rules allow. What bounds
the damage is not access control but recovery: every write is audited,
displaced versions are pinned, and undo is a unit. Note content is treated as
hostile input to the agent ([above](#the-agent-endpoint)), because an
instruction-shaped sentence a write commits would reach every device and the
next session.

What plaintext buys: the server checks every chunk against its name and every
entry's declared size against its chunks, can rebuild derived views from its
own history, and can serve history without a paired device. What it costs,
beyond the notes themselves:

- **Writer authenticity is gone.** Basalt's entry authenticator, a MAC under a
  key the server never had, let a device refuse content the server made up.
  TrewSync has none. SHA-256 chunk names give consistency, not authorship: devices
  trust the server's word about what a note says and which device wrote it.
- **Chunk names are a presence oracle.** A name is the SHA-256 of plaintext, so
  anyone holding a chunk inventory can confirm guessed content. Names must
  therefore stay out of logs, metrics and unauthenticated endpoints, and
  deduplication stays scoped to the vault.

**Ordering and completeness remain trusted**, as they were in Basalt. The
server assigns UIDs. It can replay an older version under a newer UID, causing
an unchanged local note to revert, or withhold entries. A newly paired device
has no retained checkpoint to challenge an old history.

Do not describe this as protection from any malicious-server action. Server
availability and honest ordering are part of the deployment assumptions. A
backup protects against some operational failures; it does not prove freshness.

### What a stranger on the port learns

Unauthenticated callers can reach health, the initial handshake, and protocol
refusals. These can reveal that TrewSync is present, supported protocol numbers,
and a bounded readiness reason. They do not include vault contents, paths, or
the server release. The release is advertised after authentication.

Authentication failures avoid distinguishing unknown vaults, device rows, or
invites. Format errors remain distinct because they describe the request;
capacity details requiring vault state are checked after authorization.

### Why a loopback bind is not a credential

A reverse proxy forwards remote traffic to loopback. A local bind therefore
cannot authorize the first device. Every device, the first included, pairs by
redeeming an invite, on every bind including `-localhost`; the first one is
written to a private file in the data directory, never to the log.

## Credentials, and who holds which

Every credential is random, and whatever checks it stores only its SHA-256.
These are random keys, not user-chosen passwords.

| Credential | Held by | Purpose |
|---|---|---|
| Device token, 32 bytes | That device, which made it when it redeemed its invite | Connect and sync; list, rename and revoke devices; issue and cancel invites. |
| Invite token, 16 bytes | Whoever was handed the `trew1i_` string, until it is used or expires | Redeem once, adding one device. |
| MCP token, 32 bytes | The operator who ran `trewd mcp-token`, and the MCP client given it | Read the whole vault at `/mcp`; with write scope, change notes as the token's label. Expires after 90 days by default. |

There is no vault key, root secret or recovery key. Administration beyond what
a device can do is shell access to the server's data directory: `trewd invite`,
`trewd devices`, `trewd revoke` and `trewd uninvite` there go through the running
server's private control socket, so a revoke from the host takes effect in the
server at once. Losing every device loses no synced note, because the notes and
their history are on the server; `trewd invite` pairs a new device.

A server MCP token is minted, listed and revoked through the control socket,
like devices. Its row holds the hash, a generated id, the label, the scope,
the expiry, and a use count beside the last-used time, so a stolen token used
once between legitimate uses still shows.

## What a device can do to another device

Paired devices are trusted with all vault content. Clients still reject paths
outside the vault, traversal, unsafe symlink destinations, and excluded paths
such as the Obsidian configuration folder.

A device **can issue an invite and thereby add another device**. Device and
invite listings make that authority visible; they do not prevent a compromised
authorized device from using it. Any device can revoke any device, itself and
the last one included; the way back into a vault with no devices is
`trewd invite` on the server.

CLI read-only mode restricts ordinary sync behavior. It does not change the
server credential or prevent explicit repair and administration requests.

## A lost or stolen device

Revoke its device ID to remove access through the server and close its live
connections. Revoking also cancels, in the same transaction, the invites that
device issued, so an invite minted on a stolen laptop cannot add another device
afterwards. Review the other devices and outstanding invites. Operator steps
are in [Security and privacy](security.md).

### What a revoked device can still do

Read everything it already synced. Revocation stops a device receiving and
writing at once; it does not erase local notes, which are ordinary readable
files, and nothing in TrewSync can. A restore from a backup taken before the
revocation brings the device's row back, so revoke it again after restoring.

## Provenance

Release workflows rebuild assets from tags and generate provenance attestations.
Verify the published asset and its checksums; do not infer its contents from a
local build. [Developer documentation](development.md#releases) covers the tools.
Provenance identifies a build; it does not establish that the code is secure.

## What is not claimed

- Confidentiality from the server, its host, or anyone holding its data
  directory or a backup of it.
- Detection of content the server altered or made up, of replay, of withheld
  history, or of a server refusing service.
- Cryptographic attribution of a version to a particular device.
- Erasing notes from a revoked device.
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

Protocol 1, like Basalt's protocol 7 before it, appends only when the writer's
target UID and, for a rename, source UID still match. A refused writer reads intervening metadata and reconciles
before retrying. Merged local text retains the remote ancestor it incorporated,
even if publishing that merge is refused. Renames retire their source at the
same UID; a concurrent source edit prevents that retirement and is preserved.
See [conditional writes](protocol.md#conditional-writes) and the
[multi-device regression cases](../client/src/stress/preservation.stress.ts).
