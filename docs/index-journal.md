# Client index journal

[Developer documentation](development.md) · [Design](design.md)

The client stores a snapshot and an append-only journal through one shared
implementation, [index-journal-store.ts](../client/src/core/index-journal-store.ts).
The CLI and plugin provide the file operations. This page describes the current
implementation rather than the proposal it replaced.

## The invariant everything rests on

Notes are made durable before the index recording their application is saved,
to the extent each platform supports durability. Recovering an older index can
repeat work; inventing a newer or empty state can make incorrect sync decisions.
Unreadable state is therefore not treated as a fresh vault.

## Files

| File | Contents |
|---|---|
| `index.json` | `StoredState` snapshot plus its sequence number, `seq`. |
| `index.log` | Changes after that snapshot. |

These live in the CLI's `.trew/` folder or the plugin's state folder. Older
snapshots without `seq` can load, but no journal is applied to them. The first
subsequent save writes a sequenced snapshot before journaling can begin.

## File interface

The shared store uses six operations: read/write snapshot, read/append/truncate
log, and inspect stamps. Stamps include the size and modification time of both
files and detect changes made outside this store instance.

The adapters own staged snapshot publication and flushing where available.
The store owns sequencing, replay, delta computation, and snapshot policy.

## Record format

Each newline-terminated record has this form:

```text
<sequence> <crc32> <json>
```

The CRC covers the JSON text. Deltas contain absolute values, not increments:
`cursor`, changed entries in `set`, removed names in `del`, changed remote state
in `remote`, removed remote names in `unremote`, and a complete `pending` list
when needed. Replaying the same assignment does not apply a change twice.

The codec validates framing, checksum, JSON, and sequence continuity. A damaged
record ends the usable prefix of the journal. The sequence ties records to the
snapshot; it is not sufficient to apply an otherwise valid log to an unrelated
base.

## Save

1. Compare current state with the last saved state.
2. If there is no delta, normally write nothing.
3. Choose a fresh snapshot when required by recovery or snapshot policy.
4. Otherwise append the delta and verify the resulting log size.

Comparison uses detached, JSON-normalized snapshots of individual records.
Unchanged records compare structurally without serialization; changed records
are copied. Mutable engine entries and chunk arrays never serve as the saved
baseline. This changes memory and CPU costs, not the durable format or write order.

If either file's stamp changed unexpectedly, report it and write a complete
snapshot rather than append a delta over an unknown base. This is detection and
recovery, not a substitute for single-writer exclusion.

## Snapshot

Publish and make the new snapshot durable **before** truncating the journal.
A crash between those operations leaves redundant records, which replay skips
using the snapshot's sequence number.

The default policy snapshots at **1,000 records**, or when the log is at least
**64 KiB** and exceeds **25%** of snapshot size. The record-count limit is
independent of the byte floor. The [source](../client/src/core/index-journal-store.ts)
records the measurements behind these thresholds.

## Load

Read the snapshot and journal, then reconstruct the last usable state. The
engine validates the returned state and reports invalid fields. The store also
validates when deciding whether replay must fall back to the snapshot.

| Situation | Behavior |
|---|---|
| No snapshot and no nonempty log | Fresh state. |
| Nonempty log without a snapshot | Refuse; the base is missing. |
| Unreadable or invalid JSON snapshot | Refuse. |
| Snapshot without `seq` | Ignore an unbound journal; require a snapshot on the next save. |
| Records already included in the snapshot | Skip them. |
| Torn record, bad CRC, invalid JSON, or sequence gap | Stop replay at the last usable state and report the problem. |
| Replay produces invalid state but the snapshot is valid | Fall back to the snapshot. |
| Invalid state after loading | Engine refuses it rather than overwriting it with defaults. |

## Limits

- Mobile adapters cannot offer the same flush guarantees as desktop.
- One writer is required. Stamps can detect foreign writes but do not serialize
  them.
- Older clients that ignore the journal can redo work from an older snapshot;
  do not downgrade casually.
- The index cannot reconstruct note content whose only copy has been lost.

A journal keeps one storage implementation across both clients. SQLite or
IndexedDB would add platform-specific integration; the historical cost
comparison is in [engineering notes](research.md#client-index).

## Verification

The codec, store, adapter, and stress tests cover torn records, CRC failures,
padding, sequence gaps, snapshot/truncate interruption, unreadable snapshots,
no-op saves, compaction, identical output from both adapters, and old snapshot
compatibility. See
[index-journal.test.ts](../client/src/core/index-journal.test.ts),
[index-journal-store.test.ts](../client/src/core/index-journal-store.test.ts), and
[index-journal-shells.test.ts](../client/src/index-journal-shells.test.ts).
