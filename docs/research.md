# Engineering notes and measurements

[Developer documentation](development.md) · [Product comparison](compared.md)

This page records dated measurements and design evaluations. Results describe
specific fixtures, not a speed ranking against another product. The original
transfer tables remain in `git show 573617c:docs/compared.md`.

## MCP tool expansion, September 16, 2026

The requested tool coverage follows
[StevenStavrakis/obsidian-mcp at bd90097](https://github.com/StevenStavrakis/obsidian-mcp/tree/bd900974adc6d7451f1f9d0f09d46b14307714f8).
Its read/create/edit, search, tag, directory, namespace and explicit vault-selection tools informed the
scope. Trew retains mandatory revision bases, exact edits and independent
verified before-images. Whole-file replacement and permanent deletion remain
outside this contract. Namespace and batch tools expand the original MCP plan's
deliberately narrower first release. Multi-vault selection also expands that
plan: it composes separately paired clients without changing one server per
vault or one writer per local directory.

Trew adds authenticated history comparison and device checkpoint inspection
on top of its existing history, deleted-note discovery, safe restore and sync
preview tools. Comparison uses a deterministic bounded line diff so pagination
does not change with machine timing. Device checkpoint reports fail closed to
unconfirmed when local state changes during the query.

Tag parsing uses pinned `yaml` and `mdast-util-from-markdown` packages in the
CLI only. Markdown parsing supplies code, comment and link boundaries; YAML
source ranges restrict changes to the tags property. Re-serializing all
frontmatter would change unrelated properties. Tests retain BOM, CRLF, comments,
unrelated YAML formatting and note bodies byte-for-byte outside explicit spans.
Malformed or aliased tag properties are refused. Tag search reports such
unreadable semantics as skipped, never as a complete negative result.

Review reproduced two parser errors before fixing them: a URL fragment after
balanced parentheses was mistaken for a tag, and a literal `%%` inside code
hid later body tags. Regression tests cover inline links, reference definitions,
autolinks and both inline and fenced code. Source-span tests also exposed a
Unicode-normalization error that left a combining mark in renamed nested tags.

## Post-0.8.2 performance work — September 10, 2026

Local changes based on `aba03b4`; Node 22.23.2, Apple M4 Pro, macOS.
The CLI measurements use real filesystem adapters and the released 0.8.2 server.
Five samples per mode after warm-up, with exact local and server contents checked
after every sample:

| 10,000-note CLI pass | Full listing | Healthy watcher |
|---|---:|---:|
| No changes | 102.18 ms | 33.03 ms |
| One edited note | 119.10 ms | 50.61 ms |
| File listing during edited pass | 66.97 ms | 0.39 ms |

These compare modes on the final implementation. An earlier run measured
127.56 / 54.62 ms for the edited pass; filesystem timing varies. A healthy watcher avoids
relisting unchanged files; namespace changes, uncertain events and periodic
verification still require full scans. This does not measure cold startup or
mobile performance. Engine reconciliation still visits the full index.

#### Where a pass spends its time, at 10,000 and 50,000 notes

`BENCH_SIZES=10000,50000 BENCH_REPEATS=5 bun run bench:pass`, bun 1.4.2, Apple
M4 Pro, median of five after two warm-ups, at `8521092`. Desktop: a `NodeVault`
on APFS and a `JsonIndexStore`, both wrapped so the adapter and the journal
report their own time.

The four phase columns partition a pass. `fs` is an overlay across all four,
not a fifth term, and `compare` is inside `save`.

**Nothing changed**, the pass that happens most:

| notes | total | list | decide | save | of which compare | fs |
|---|---:|---:|---:|---:|---:|---:|
| 10,000 | 50.2 ms | 27.5 | 13.4 | 10.0 | 6.8 | 26.6 |
| 50,000 | 310.0 ms | 145.2 | 88.2 | 80.1 | 60.0 | 140.6 |

**One note changed:**

| notes | total | list | decide | transfer | save | of which compare |
|---|---:|---:|---:|---:|---:|---:|
| 10,000 | 116.4 ms | 54.3 | 28.1 | 11.9 | 21.3 | 13.6 |
| 50,000 | 638.0 ms | 286.8 | 180.8 | 13.0 | 151.0 | 110.0 |

**A folder renamed**, 50,000 notes: 6,633 ms, of which decide 2,527 and the
adapter 1,408. **Catching up**, 50,000 notes: 1,392 ms.

That rename figure is the **CLI's**, and the two shells differ here more than
anywhere else. Obsidian fires a rename event and the plugin forwards it to
`noteRename`, which carries the entry and its chunk list to the new path. The
CLI has no such event, so every moved note is a new path with no entry and is
read, chunked and sealed again to rediscover a list it was already holding.
At 10,000 notes, measured the same way:

| a folder renamed | before | after |
|---|---:|---:|
| not reported, the CLI's path | 1,178 ms | 1,171 ms |
| reported, the plugin's path | 1,081 ms | **832 ms** |

The improvement is in `planUpload`: a file whose chunk list the pass did not
have to recompute does not need reading at all. The names go out from the
index, and a body is produced only if the server asks for one, checked against
the name it was promised under. A rename changes no byte, so the server holds
every chunk and asks for none. Decide falls from 441 ms to 229 ms.

The CLI's row does not move, and cannot on this evidence: without a rename
event it genuinely does not know the content is the same.

One thing was tried here and reverted, which is worth recording because the
argument for it was persuasive and wrong. A rename moves an inode's change
time without touching a byte, so `changeId` differs across a move and defeats
the carried chunk list; the proposal was to excuse that when the device,
inode, modification time and size all agree. They can all agree for an
in-place edit too, if the editor restores the modification time, and then the
change time is the only witness left. `preservation.stress.ts` failed within
one run of trying it. That is the R071-03 incident, and the stress suite
exists for exactly this.

Three things these say, and one they do not.

- **Listing is about half of a quiet pass on a desktop**, and it is almost
  entirely adapter time: 145.2 ms of list against 140.6 ms of filesystem at
  50,000. That term is a directory walk here and is *not* one in the Obsidian
  plugin, whose `list()` reads `getAllLoadedFiles()` out of memory. So the
  desktop split cannot be carried over to a phone, which is the whole reason
  the Android measurement exists.
- **Decide plus compare is 40% of a quiet pass at 10,000 and 48% at 50,000.**
  Growing, and on this runtime still under the half that
  [open work](open-work.md) set as its threshold.
- **A single edited note costs 625 ms at 50,000 once transfer is taken out.**
  That is over the 200 ms half of the same threshold by a wide margin, on a
  laptop.
- What they do not say is anything about a phone. Both halves of the threshold
  are written against Android numbers, and the term that dominates here is the
  one most likely to behave differently there.

### First Android numbers, at 500 notes

`bun run bench:android`, Pixel 9 Pro XL, Android 17, Obsidian 1.13.8, plugin
built at `2b3d611` with pass timing on. A disposable `trew` on a laptop,
reached over `adb reverse` on the phone's own loopback; the live server was
never involved. A separate `Bench` vault, seeded with the same corpus
`bench-pass` uses, so these files and the desktop rows above are byte for byte
the same notes.

Five hundred notes is a shakeout, not the measurement. It is recorded because
it is the first Android data this project has, and because getting it exposed
five defects in the harness that would have quietly corrupted a larger run.

| 500 notes, quiet pass | ms |
|---|---:|
| total | 33.5 |
| list | 17.8 |
| decide | 6.6 |
| save | 7.0 |
| of which journal compare | 5.2 |

decide plus compare is **38.1%** of a quiet pass. The threshold in
[open work](open-work.md) is half, at fifty thousand notes; on the desktop the
share grew from 40% at ten thousand to 48% at fifty thousand, so the figure
that decides anything is still unmeasured.

Save to verified content on a peer, over five samples: **p50 368 ms, p95
791 ms**. Both timestamps are taken on the laptop, and a sample completes only
when a fresh read of the peer's own file matches the exact bytes; a pass
report or an applied cursor does not end it.

The first pass after pairing, which reconciles every file against the server,
took **22.5 seconds** at five hundred notes. It is excluded from the quiet
figures above and is its own cost.

**What went wrong getting these, because it bears on how much to trust them.**
Every defect was in reading the measurements, not in taking them:

- The line held a reference to the filesystem collector and cleared it before
  serialising, so every `filesystemMs` was `{}`.
- The harness read the compare time from the engine's field, which is always
  zero because the engine cannot see inside the store. The number was in the
  journal's own record throughout.
- Each timed sample checked that Obsidian was in the foreground *before*
  sending the URI that brings Obsidian to the foreground, so every sample of
  one run was skipped.
- The `&` in that URI reached the phone's shell unquoted and split the command
  into three. `adb shell` is a second shell, which is the case CLAUDE.md's rule
  about inlining payloads exists for.
- The collection window read the log after three and a half minutes in which
  the phone had been asleep. Android suspends a backgrounded WebView and
  Trew does not sync there, so the window gathered nothing. The harness now
  brings Obsidian forward first and reads the whole log at the end.

Two figures were reported from this phone before these were fixed, 66% and
29%, and neither is sound: the first came from passes taken before the vault
had settled, the second from a single sample. Only the 38.1% above comes from
settled passes with the overlay working.

### Ten thousand notes on the phone was attempted and not obtained

The figure the threshold is written against is fifty thousand. Ten thousand was
the step toward it and it did not produce a number, so nothing here revises the
share above.

Seeding the phone with ten thousand notes took **543 seconds** over `adb push`
of a tar, before Trew was involved at all. The phone then had every file on
disk and had to hash and reconcile them against the server on its first pass.
After **thirty minutes** it had not finished and the harness gave up.

That is not a measurement of Trew, because the run is confounded: the phone
entered `mWakefulness=Dozing` partway through, and a dozing phone is not
syncing. The harness now holds the screen on and brings Obsidian forward, but
the run was not repeated. What can be said is narrow: nothing establishes that
a phone completes a first reconcile of ten thousand notes in a usable time, and
the first pass at five hundred notes took 22.5 seconds, which extrapolates to
about seven and a half minutes at ten thousand if it is linear. Whether it is
linear is exactly what was not shown.

So [open work](open-work.md) keeps its threshold unresolved. The decision it
gates is still waiting on a phone number at fifty thousand notes, and the
honest state is that this project has one Android data point, at five hundred.

### Listing is the biggest term, and half of it was avoidable

The phase breakdown put listing at 47% of a quiet pass on a desktop at 50,000
notes and 53% on a phone at 500. That was not the expected answer: the
proposal in [open work](open-work.md) attacks reconciliation, which is the
second biggest.

The plugin's `list()` reads Obsidian's own index rather than walking a
directory, so its cost is per item and can be measured without a phone.
`BENCH_LIST=1 bunx vitest run src/plugin/list-bench.test.ts`, bun 1.4.2,
Apple M4 Pro, median of nine after two warm-ups, against a `FakeVaultIndex`:

| plugin `list()` | before | after |
|---|---:|---:|
| 10,000 notes | 7.8 ms | 6.7 ms |
| 50,000 notes | 37.9 ms | 21.1 ms |

Two changes, both of which leave the output identical:

- Every path was given a `Set`, a mapped array and a sort, to decide whether
  two names in the index claimed it. Two claim approximately none of them in
  any real vault, and the single-spelling case now allocates nothing.
- `normalizePath` normalises to NFC and was called for every file on every
  pass. It is a pure function of the string and the same names recur, so the
  answer is kept, bounded against the listing it serves.

This is a laptop's JavaScript engine, not a phone's, so the absolute figures
do not transfer. The proportion should: the work removed is allocation and
Unicode normalisation, and neither gets cheaper on a phone.

## What a pass costs at 0.8.4

`bun run bench:pass`, 4,000 notes, bun 1.4.2, Apple M4 Pro, two samples of the
median of seven. Measured against `dbbe4a4`, the commit before the 0.8.3 review
round, on the same machine in the same session.

| 4,000-note pass | dbbe4a4 | 0.8.4 | 0.8.6 |
|---|---:|---:|---:|
| Nothing changed | 19.5, 19.6 ms | 20.1, 19.9 ms | 18.4 ms |
| One note changed | 52.5, 50.6 ms | 50.1, 52.1 ms | 49.2 ms |
| A folder renamed | 545.5, 580.9 ms | 451.8, 458.4 ms | 424.0 ms |
| Catching up | 155.6, 154.4 ms | 129.6, 134.5 ms | 121.8 ms |

The 0.8.6 column was taken to answer whether the two fixes after 0.8.4 cost
anything. They do not: every row is at or below 0.8.4, by margins inside the
few percent this benchmark moves between runs, and it is one sample against
two. Read it as no regression rather than as an improvement.

Neither fix is in this benchmark's path, which is why that is the expected
answer and not a reassuring one. The client change moves when a backoff
resets, and a benchmark that never loses its connection never reaches it. The
server changes are not measured here at all: `bench-pass` times the engine.
For those, `bun run bench:sync` at loopback, 20 ms and 100 ms delivered 2,000
of 2,000 files with none wrong, none missing and none refused, in 21 round
trips for the upload. That is a correctness result. The batched commit's cost
is one `fsync` per batch, and the fallback's is one per entry, which is the
trade being made deliberately in the case where the alternative is refusing
the write.

The two that moved came from a CPU profile of the same benchmark rather than
from reading the code, and three changes account for them:

- `prune` walks the whole index twice on every pass and in the ordinary case
  deletes nothing, so what it cost per record was the whole of what it cost.
  Destructuring a Map entry allocates a two-element array per record; reading
  the key and looking the value up does not.
- `canonical`, which builds the bytes an entry's authenticator is computed
  over, allocated an array, a mapped copy of it and a joined string per entry.
  One string built in place produces the same bytes, which
  `protocol-fixtures.test.ts` holds it to.
- The refusal check added for R083-04 ran for every path in the vault. A path
  the vault listed cannot be non-canonical, so it now runs only for names that
  came from the server.

The first two profiles also showed the cost of the check *before* it was gated,
and `sendInteractiveEdit` walking the whole index between every body of a
transfer. Both are fixed; the second is now bounded to one look per 200 ms.

What did not move is the shape: "nothing changed" still scales at about 1.9x
per doubling, because reconciliation still visits the whole index and `save`
still repacks every entry for the journal to diff. That is the finding recorded
in [open work](open-work.md), and it is the only thing left here that is worth
a large number.

For 10,000 local and 10,000 remote records, detached journal comparisons took
**7.36 ms**, down from **13.78 ms** (25 samples). Retained comparison state grew
from about **5.0 MB to 8.8 MB**. The durable journal format and flushing are
unchanged. Whole CLI edited-pass journal saves fell from the earlier **24.38 ms**
to **16.66 ms** in the final unwatched fixture.

Server microbenchmarks, median of three runs:

| Work | Before | After |
|---|---:|---:|
| Deep verification: 500 references to one 64 KiB body | 25.83 ms | 1.87 ms |
| Encode and queue a 512-chunk update for 32 connections | 727 µs | 25.7 µs |

Verification checks each distinct body once per invocation and still reports
every affected reference. Broadcast shares immutable encoded frames while
charging each connection its full queue budget. Two-connection fan-out is
unchanged within measurement noise. These are maintenance and encoding costs,
not end-to-end sync latency.

The existing end-to-end cadence benchmark stayed broadly unchanged: two-client
repeat-edit medians were **21 / 33 / 99 ms** with **0 / 2,000 / 10,000** baseline
notes (previously **20 / 34 / 99 ms**). These use memory adapters, 10 / 10 / 5
samples and a 10 ms observation interval. Eight-client results were mixed, so
they do not establish a general latency improvement. All runs checked exact
contents on every receiver.

Large uploads now use a temporary connection. A real-server regression holds an
attachment after its first body and verifies three successive saved note edits
reach another client before that attachment completes. Additional checks cover
interrupted uploads, close, concurrent note edits and delayed main-stream
metadata. The fast path serves existing independent text files up to 512 KiB;
conflicts and namespace changes retain normal reconciliation. Downloads and
attachment preparation are not preempted. Run
`bun run test src/core/responsive-upload.test.ts src/core/upload-ordering.test.ts`
from `client/` to exercise this ordering without a latency threshold.

## Protocol 7 measurements — September 10, 2026

Protocol 7 changes originally measured on top of `920324c`; Node 22.23.2, Go 1.27.1,
Apple M4 Pro, macOS arm64. [Raw results](reviews/0.7.1-metrics.json) include
sample arrays and environment details. Benchmarks ran sequentially, outside
the test gate.

| Saved-file event → content at every receiver | 2 clients p50 / p95 | 5 clients p50 / p95 |
|---|---:|---:|
| New note | 21 / 22 ms | 21 / 22 ms |
| Repeat edit | 22 / 33 ms | 31 / 32 ms |
| Note alongside an attachment with a 500 ms read | 21 / 32 ms | 21 / 33 ms |
| Active note alongside another note with a 500 ms read | 21 / 31 ms | 31 / 33 ms |

Twenty samples per row, real local server and encryption, in-memory client
vaults and simulated Obsidian events. A 200-note burst reached every receiver
in 1.49 / 1.59 seconds (one burst each). The benchmark polls for completion,
so these values include observation granularity. They exclude editor autosave,
network latency, and phone filesystem writes.

Five fresh clients replayed 1,000 versions of one path in **11–23 ms**;
including the newest content took **12–25 ms**. This fixture does not justify
adding a snapshot protocol. Measure much larger histories and actual mobile
resume before revisiting that decision.

On Node with real client filesystems, median of three passes after warm-up:

| Workload | 500 notes | 2,000 notes |
|---|---:|---:|
| No changes | 8.3 ms | 21.6 ms |
| One changed note | 27.4 ms | 55.5 ms |
| Folder rename | 98.4 ms | 549.2 ms |
| Catch-up | 340.3 ms | 386.9 ms |

Keep fallback scans for missed events. Dirty-path invalidation prevents stale
hash reuse; active-note work can resume between background files, and active
sessions use smaller batches. A binary exchange already in progress remains
serialized. No filesystem flush or compare-before-write check was removed.

Native Obsidian's twelve-update editor check also passed split views, cursor
stability, disjoint unsaved typing, and undo/redo. Local application took
**30.1–65.0 ms**. This is separate from the network benchmark. Android runtime,
TalkBack, keyboard-open layouts, and phone delivery timings remain unmeasured
in this pass.

```bash
cd client
TREW_BENCH_CLIENTS=2 TREW_BENCH_SAMPLES=20 node --experimental-transform-types bench-cadence.ts
TREW_BENCH_CLIENTS=5 TREW_BENCH_SAMPLES=20 node --experimental-transform-types bench-cadence.ts
TREW_BENCH_HISTORY=1000 node --experimental-transform-types bench-history.ts
BENCH_NODE=1 BENCH_SIZES=500,2000 BENCH_REPEATS=3 node --experimental-transform-types bench-pass.ts
```

The [September 9 prior-art review](reviews/0.7.1.md#what-to-borrow-from-other-plugins)
records the inspected official Sync, Remotely Save, and LiveSync source revisions.
Its activity log, conflict review, and preview recommendations are implemented
in the [follow-up](reviews/0.7.1-fixes.md).

## Reproduce before making a claim

From `client/`:

```bash
bun run bench          # chunking, sealing, transfer sizes
bun run bench:sync     # complete sync with latency and bandwidth controls
bun run bench:cadence  # saved-edit latency with production sync timers
bun run scale          # larger note collections
bun run dedup          # reuse across files and versions
```

Record the source commit, runtime, hardware, corpus, latency, bandwidth, and
byte-for-byte correctness alongside timings. Check that the proxy applies
back-pressure in both directions. The benchmark fixtures and their output are
the starting point; a past table is not a substitute for a new run.

## Interactive sync cadence

Measured after plugin 0.6.5 with Bun 1.4.2 on an Apple M4 Pro.
`bench:cadence` uses a real local Go server, real encryption, in-memory vaults,
and simulated Obsidian events. It verifies complete contents at both ends.
Five samples per case, in milliseconds:

| Saved edit → receiving client | Initial timing fix | No note cooldown |
|---|---:|---:|
| New note | 121–138 | 121–139 |
| Repeat edit, 100 ms after the preceding version arrived | 906–922 | 124–129 |
| Incoming update, sender forced to isolate reception | 70–75 | 73–76 |

An earlier 0.6.5 reproduction took 28.6 seconds for a repeat edit and 28.4
seconds for an incoming update, despite a 16 ms upload. It exposed an upload
cooldown applied to downloads and deferred work waiting for the 30-second poll.
The first fix reduced repeat-upload intervals to 1/2/5 seconds and scheduled
their deadlines. The follow-up removed that additional wait for notes and
other recognized text formats, including canvases, while keeping 50 ms event
batching at that stage. Binary attachments retain the size-based cooldown.

Regressions cover consecutive note and canvas uploads, attachment deadlines,
busy event streams, shutdown, idle clients, and simultaneous edits. A plugin
integration test saves sixty successive edits in three bursts, verifies every
paragraph on the peer, and checks that only three history versions were made.

The inspected Obsidian 1.13.7 code uses 10/20/30-second upload cooldowns and
keeps retrying while they expire. This is a scheduling comparison, not an
end-to-end benchmark against official Sync. The measurements start at a file
save; they exclude Obsidian's editor autosave delay. Phone storage, suspension,
network delay, and large vault scans are outside the loopback measurement.

A separate native acceptance check of the initial fix used Obsidian 1.13.7,
about 3,942 indexed files and folders, and the real self-hosted server. With
Obsidian in the foreground, a new note was acknowledged in 98 ms and three
repeat edits in 919–927 ms. Each saved version was fetched back and compared
byte for byte; the temporary note was trashed and its server deletion verified.
The same check in a hidden window reported about 3 seconds per upload with
Electron's background timer throttling enabled. Foreground and background
timings should be reported separately.

Repeating that native check after removing the note cooldown gave 118 ms for
a new note and **100–121 ms for five repeat edits**. These are saved-file to
server-acknowledgement times, not phone-delivery measurements. All six versions
were fetched back and matched exactly; the temporary note's deletion synced.

## Open editors and foreground notes — September 9, 2026

A native Obsidian 1.13.7 reproduction found that the 0.7.0 plugin temporarily
renamed every replaced note into a conflict copy. The open editor followed that
rename; deleting the temporary copy left an empty tab. Disk-only tests missed
the effect on Obsidian's file identity and rename listeners.

The installed official Sync implementation updates existing files through
`Vault.modify`/`modifyBinary`; Obsidian's text view then merges unsaved buffers
and preserves the open file. Trew now keeps text files at their original
paths, using a verified backup and a comparison inside `DataAdapter.process`.
The [design guide](design.md#file-replacement) describes its recovery limits.

`scripts/open-note-smoke.mjs` verified twelve updates in two actual editors,
cursor stability, disjoint unsaved typing, and undo/redo. Native application of
Trew's updates took **20.6–34.7 ms**; a `Vault.modify` control took **1.5–3.8 ms**.
The Trew path includes backup verification and desktop filesystem flushes.
Both modes include incoming changes in native undo history; redo restored the
combined text. This is an editor/storage test, not an official Sync network
benchmark or a test of Android storage.

Trew also prioritizes the current text note over background notes. With
3,845 unchanged notes and a simulated 500 ms read of another note,
`bench:cadence` measured five deliveries at **561–586 ms** without that priority
and **25–39 ms** with it. The same run's ordinary repeat edits were **32–37 ms**
with priority enabled. All received contents were checked. Reproduce on an
Apple M4 Pro with Bun 1.4.2, a real loopback server, and in-memory vaults:

```bash
cd client
TREW_BENCH_NOTES=3845 TREW_BENCH_PRIORITY=0 bun run bench:cadence
TREW_BENCH_NOTES=3845 TREW_BENCH_PRIORITY=1 bun run bench:cadence
```

This does not interrupt a transfer already in progress. Automatic sync still
starts from Obsidian's saved-file events; the editor's own autosave delay is
separate. **Sync now** saves open Markdown buffers before syncing so a manual
request includes the text still being edited. The ribbon icon now shows sync,
offline, and error states visually, including on mobile.

Live PKB verification also exposed a connection race: a foreground probe could
send a text ping while the server was waiting for an upload's binary bodies.
Resume probes and periodic keepalives now use the client's existing operation
queue. Regression tests hold a requested body until released and check that
neither ping interrupts the upload. Idle resume still uses its short timeout;
an active transfer keeps its normal progress timeout.

## Resume and attachment scheduling

The protocol 6 follow-up keeps the same note event batching. Resume now probes
an idle socket with a two-second timeout and interrupts reconnect backoff;
active transfers retain their normal progress deadlines. Simultaneous resume
and keepalive requests share one ping. Tests cover missed saves after resume,
wake-ups during connection teardown, and an active transfer during a probe.

A controlled `bench:cadence` case delays attachment reads by 500 ms while a
note is saved in the same event batch. With alphabetical processing, five note
deliveries took **623–644 ms**. Processing text first and flushing its transfer
queue before preparing attachments reduced that to **123–129 ms**. Every note
and attachment was verified. Ordinary repeat edits measured **122–126 ms**.
These use the same loopback setup as above, not a measured phone-storage delay.
At that stage, an attachment already transferring occupied the serial transport
until completion. The post-0.8.2 implementation above removes that wait for
independent saved note edits.

Device delivery confirmation is separate from these transfer timings. A device
reports a completed checkpoint only after its files and index have been saved.
The server holds that receipt in memory; the panel originally refreshed once per
second and now uses the adaptive schedule in [Design](design.md#sync-scheduling).
Tests withhold confirmation during a blocked replacement,
a failed replacement, and a failed index save. A disconnected device is shown
as unconfirmed; receipt metadata is not a backup guarantee.

Native acceptance used the full plugin in a separate Obsidian 1.13.7 test vault
(320 existing files), a temporary protocol 6 server, and a second client with
an in-memory vault. In the final build, foreground saved-file delivery measured
130 ms for a new note and 133/140 ms for repeat edits. Suppressing the plugin's
file event and then dispatching the online signal delivered the missed edit in 86 ms.
Every version matched on both clients, the peer reported its applied checkpoint,
and the temporary note's deletion synced. This tests the desktop runtime and
resume wiring; it does not establish Android suspension behavior.

The full suite also exposed an acknowledgment-ordering defect: an upload could
be marked synced before a preceding peer update finished metadata verification.
The existing stale-upload check then missed the competing edit. A gated
two-client regression reproduced the loss of one working version. Uploads now
wait for already-received metadata to finish verification before committing
their local sync state. The preservation regression and all three upload reply
paths failed before the fix and pass with it; failed verification also refuses
the local commit. No extra network request or timer is involved.

Repeating the benchmark with that fix measured **123–126 ms** for ordinary
repeat edits and **123–128 ms** beside the delayed attachment, with exact
contents checked. These are development-tree results, not a published release
or evidence of an upgrade on the phone.

## Removing event-window latency

The next scheduling pass removed the fixed 50 ms wait at each client, using
the next event-loop turn to group saves. An arrival pass waits for its snapshot
of already-received metadata to finish verification. New frames cannot extend
that wait. Initial catch-up is now explicitly excluded from automatic arrival
passes; a regression reproduced premature reconciliation under the old timer.

With 2,000 unchanged notes, the same `bench:cadence` workload measured repeat
edits at **129–132 ms before** and **23–32 ms after**. Notes beside a delayed
attachment measured **23–33 ms after**. A 200-note event burst took 1.34 seconds
before and 1.27 seconds after; this small throughput difference is not a general
speed claim. The sender used one pass in both runs. The receiver used four
passes before and thirteen after: earlier delivery trades additional scans for
less batching. Every generated note and attachment matched exactly. These are
loopback measurements with memory vaults, not mobile network results.

Run `TREW_BENCH_NOTES=2000 bun run bench:cadence` to repeat the larger-vault
workload; its output includes pass counts and content verification. The serial
queue still bounds active work and combines requests waiting to start. A second
transport and partial-vault scans were deferred in this experiment; see the
post-0.8.2 results above for the subsequent implementation and its limits.

The accompanying UI changes make the offline sync action reconnect immediately,
combine repeated manual requests, and show sustained activity even when each
individual file finishes quickly. Fast automatic passes keep a steady status.

Native acceptance of this build used the same 320-file Obsidian test vault and
local memory peer. With the test window visibly foregrounded, delivery measured
18 ms for a new note, 11/17 ms for repeat edits, and 11 ms for a missed file
event followed by an online signal. Contents, peer checkpoints, and deletion of
the temporary note were verified. Background-window samples ranged from 9 to
36 ms and are separate from the foreground result. These small desktop samples
do not predict phone latency or suspended-app behavior.

## Transfer feedback

The panel now shows transfer direction, file or batch identity, and encrypted
body bytes moved. Counters exclude reused chunks and continue across split
downloads. They do not imply a saved file or a completed sync. Tests hold back
socket draining, later download bodies, and the index save to check those
boundaries; a three-file batch sharing two chunks verifies exact retained
content and counts each transferred chunk once.

With transfer callbacks enabled and 2,000 unchanged notes, `bench:cadence`
measured repeat edits at **22–31 ms**, compared with **23–32 ms** in the previous
run. Notes beside a delayed attachment took **21–31 ms**. The 200-note burst took
1.29 seconds with one sender pass and eighteen receiver passes. These are small
loopback samples; the differences do not establish a speedup or a regression.

Native Obsidian acceptance verified a random 2 MiB attachment at both ends,
the real upload counter, and cleanup. Foreground note delivery measured 35 ms
for a new note, 27/26 ms for repeat edits, and 21 ms after an online signal.
This sample was slower than the previous native sample; neither is a phone
measurement or a controlled comparison with official Sync. All test files and
the temporary plugin were removed through Obsidian.

The final local gate passed all 30 checks: 1,585 client tests, 15 panel checks,
and 24 stress tests. Native screenshots cover desktop and phone-width transfer
layouts; phone previews do not test the Android or iOS runtime.

## Pairing a populated vault

Inspected Obsidian 1.13.7's bundled Sync implementation on September 8, 2026.
Connecting a vault that contains files opens a merge confirmation with Continue
and Cancel. There is no first-sync strategy selector. After connecting, Sync
offers folder exclusions and a separate Start syncing action. Its
[onboarding for another device](https://obsidian.md/help/sync/setup) also offers
creating a new local vault from the remote vault.

Trew uses the populated-vault confirmation and lets empty vaults proceed
directly. Its filesystem check runs before consuming an invite, including when
Obsidian's loaded-file cache is incomplete. Trew still preserves divergent
versions according to its existing conflict rules; this UI change does not adopt
Sync's initial same-path resolution by modification time. An automatic
backup-and-replace workflow was deferred because it would need a separate,
resumable recovery design.

## Transfers and history

Historical transfer after inserting one line, including entry metadata in both
columns. The whole-file column is a baseline, not a measurement of a competing
service.

| Note size | Whole-file baseline | Trew | Entry metadata within Trew total |
|---|---|---|---|
| 4 KiB | 4.4 KiB | 1.9 KiB | 624 B |
| 32 KiB | 32.4 KiB | 4.9 KiB | 1.3 KiB |
| 128 KiB | 128.4 KiB | 5.8 KiB | 2.7 KiB |
| 512 KiB | 512.4 KiB | 9.6 KiB | 4.8 KiB |
| 2 MiB | 2.0 MiB | 21.7 KiB | 9.0 KiB |

Content-defined boundaries let most chunks survive a small edit. An entry still
lists every chunk in the new version, which limits the saving for large notes.
The chunk-size target balances that list against the changed content sent.

The recorded deduplication sample saved **0.11% across different files** and
**73–90% across versions of one file**. Repeated edits, rather than unrelated
notes containing the same text, motivated the design. Deterministic sealing
also reveals equality of chunks within a vault; see [the threat model](design.md).

## Whole-vault sync

Apple M4 Pro; 200 distinct files, 17.8 MiB plaintext and 10.8 MiB transferred
after compression. All 200 files arrived byte-identical on every row.

| Round trip / bandwidth | Initial upload | Initial download | 20 edited notes up | 20 edited notes down |
|---|---|---|---|---|
| Loopback | 11.9 s | 0.62 s | 0.24 s | 0.11 s |
| 20 ms | 12.7 s | 0.85 s | 0.29 s | 0.13 s |
| 100 ms | 12.6 s | 1.90 s | 0.44 s | 0.23 s |
| 400 ms / 2.6 MiB/s | 15.8 s | 10.1 s | 1.07 s | 0.63 s |

These runs predate the current handshake and exclude its connection cost. The
reported download figures incorporate a correction to the bandwidth proxy;
earlier figures did not enforce the download limit. Upload time was sensitive
to macOS flushing costs. Neither these measurements nor earlier Linux runs
establish current performance on a phone or across the public internet.

A separate real-vault run recorded 3,751 files and 91 MB: 54 seconds up,
22 seconds down on loopback, and 62.7 MiB transferred. All files matched;
`verify -deep` checked 11,762 chunk references with no faults. That is evidence
for that run, not a general durability guarantee.

## Scale and attachment memory

| Historical scale run | 1,000 notes | 10,000 notes |
|---|---|---|
| Local index | 0.6 MiB | 5.6 MiB |
| Unchanged pass | 7 ms | 41 ms |
| Twenty edited notes | 20 chunks / 8.0 KiB | 20 chunks / 8.0 KiB |

The attachment run used the **headless client**, which streams content:

| File | Peak process memory | Sync time |
|---|---|---|
| 16 MiB | 144 MB | 0.4 s |
| 64 MiB | 220 MB | 1.6 s |
| 256 MiB | 291 MB | 6.5 s |

These are not mobile memory bounds. Large files may be read whole by a plugin
adapter. The server defaults to 64 MiB per file; the 256 MiB run required a
higher limit.

## Client index

The old full-JSON rewrite was measured on a laptop SSD:

| Notes | Snapshot | Serialization | Durable write | Total |
|---|---|---|---|---|
| 1,000 | 0.6 MiB | 0.1 ms | 1.5 ms | 1.6 ms |
| 10,000 | 6.3 MiB | 1.9 ms | 2.1 ms | 4.0 ms |
| 50,000 | 31.6 MiB | 8.6 ms | 5.0 ms | 13.6 ms |

One cold write of the 50,000-note snapshot took 228 ms. The warm figures should
not be used to dismiss flush latency. Trew now uses a [shared journal](index-journal.md)
to avoid rewriting the full snapshot on every changed pass. SQLite or IndexedDB
would require additional platform-specific storage integration.

## Evaluated alternatives

These record decisions at the time of evaluation. Revisit them when requirements
or measurements change, with compatibility and preservation tests.

| Alternative | Evaluation and tradeoff |
|---|---|
| Whole-file path for small notes | More transfer and history storage in the sample, plus a second write path. |
| Global authenticated history chain | Could strengthen completeness checks, but the evaluated design serialized concurrent writers. |
| One transaction per batch | SQL work improved about tenfold, but saved only 0.7% of the measured upload and changed acknowledgement boundaries. |
| Solid compression for initial sync | 57% versus 60% of plaintext in the sample; a second transfer path for a modest saving. |
| Different chunk boundaries | Changes chunk identities and causes existing content to be uploaded again. |
| Plaintext-derived chunk names | A keyed design decoupled some encoding choices but removed the server's ability to recompute names from stored bodies. Migration still required devices holding plaintext. |
| Local plaintext-to-name cache | Helped a parameter-change experiment but increased the index; little benefit without such a change. |
| `node-diff3` | Conflicted on five of eight cases that the existing merge handled in that evaluation. |
| CRDT text model | Convergence alone does not establish that combined edits preserve meaning. A different editing and recovery model would need separate evaluation. |
| Rename detection from content equality | Identical files and rename-plus-edit cases make equality alone ambiguous. |
| Streaming server import | The recorded first-sync cost did not justify another durable ingestion path; remeasure for larger vaults and real networks. |
| Alternative codec (I25) | Encoded bytes affect chunk identities. Require a measured benefit and a migration plan; see the historical review evidence. |
| Diff-match-patch fork (I26) | The evaluated fork produced different diffs and lacked equivalent line-mode/deadline behavior. A dependency swap would change merge results. |

Data-key epochs, re-encryption, and device signatures could strengthen access
revocation and author attribution. They also require key distribution, history
and backup compatibility, and migration work. They are outside the current
personal-device scope. The [design](design.md#what-the-server-can-and-cannot-do)
states the resulting limits; these mechanisms are not inherently impossible.

### Locking

Earlier file-lock recovery schemes repeatedly admitted two writers during stale
holder checks and removal. The historical findings are R03, R20, R34, R40,
R44, R49, and RR1 in the [findings index](findings.md).

The supported CLI now uses kernel-managed exclusion: `O_EXLOCK` on macOS and
an abstract Unix socket on Linux. Process death releases it. The accompanying
file records the holder. A foreign holder or unavailable mechanism still needs
manual handling; this does not add support for network filesystems.

The comparison with `obsidian-headless` 0.0.3 examined a timed lease. Trew chose
kernel exclusion because a paused writer must not become a second active owner
when its heartbeat expires. That version-specific evaluation is preserved in
the original page, rather than presented as a claim about today's product.

## Credits and dependencies

These projects informed Trew's design and regression cases:

| Project | Influence |
|---|---|
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | Content-defined chunking, the 48-byte window, a BOM-boundary regression, and text-merge approaches. |
| [Obsidian Sync](https://obsidian.md/sync) | Remembering the last synced content as a merge base; shipped-app behavior also informed protocol review. |
| [Sync Engine](https://github.com/hesprs/sync-engine) | Correctness checks beside benchmarks, corpus shape, latency scenarios, and trash behavior. |
| [Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync) | A regression involving a file/folder collision at the same path. |
| [obsidian-headless](https://github.com/obsidianmd/obsidian-headless) | Locking, read-only mirror, and conflict-policy evaluations. |

The old source comparison recorded LiveSync 1.0.27 (`dd280a4`), Sync Engine
3.1.4 (`edb9d42`), and Fast Note Sync 2.4.0 (`1bfb406`). Those observations are
historical, not a maintained feature matrix. Use the [product comparison](compared.md)
for current user-facing guidance.

The client uses `diff-match-patch` for merging and `fflate` for compression;
the server uses `modernc.org/sqlite` and `github.com/coder/websocket`. Exact
versions live in the package manifests and lockfiles. Changes that affect sealed
bytes or merge output need compatibility tests, even when the replacement API
looks equivalent.

The namespace expansion uses a preview containing exact source spans and required
bases. Applying recomputes the semantic operation and accepts only the same plan.
All before-images are verified and flushed before any original is changed. Batch
results retain per-file outcomes when a later operation fails; rollback could
replace a concurrent editor save, so it is not used.

Moves deliberately use a verified exclusive copy, approved backlink changes and
recoverable source deletion, in that order. They do not call `noteRename` inside
`mutateLocal`, which would wait on the same serial queue. They also do not claim
crash-stable rename lineage: the engine's in-memory rename hint is persisted only
by a later sync pass. Destination history starts at its new path.

Independent review caught destination parsing errors in links containing code
labels, nested images and character references. The implementation now consumes
micromark destination token offsets and raw fragment boundaries rather than
searching for a decoded URL in a whole link. Regression tests preserve labels,
titles, aliases, encoded fragments, BOM/CRLF, relative outbound links and unrelated
prose. The micromark and decode-string dependencies are pinned directly because
these CLI paths import them directly.

The same review reproduced two deletion adapter failures: an unreadable or
missing `lstat` could fall through to an unconditional remove, and a stranded
editor save's path appeared only in error text that MCP redacts. Missing paths
now return without a second removal, other stat errors propagate, and retained
paths travel in `PreservationError`. Actual process stress tests kill moves,
deletes and tag batches before replies, restart them, sync a fresh device and
assert the original bytes remain discoverable. Concurrent phone-edit cases check
retained content after the remote author disconnects.
