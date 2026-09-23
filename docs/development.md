# Develop Trew

[Documentation](index.md)

This section is for contributors and reviewers. For installation and everyday
use, start with the [server](server.md), [plugin](plugin.md), or
[CLI](../client/README.md) guide.

## Technical reference

| Document | Purpose |
|---|---|
| [Design](design.md) | Durability rules, supported environment, and threat model. |
| [Protocol](protocol.md) | Requests, replies, pairing, paths, chunk framing, and errors. |
| [Index journal](index-journal.md) | Client state format and recovery behavior. |
| [Engineering notes](research.md) | Historical measurements, design evaluations, and credits. |
| [Threat model](threat-model.md) | Requirements for the plaintext server and agent endpoint, each with where it is enforced and its status. |
| [Findings index](findings.md) | Definitions of review IDs cited in code. |
| [Open work](open-work.md) | What is deliberately not done, and what would change that. |
| [Documentation review](documentation-review.md) | Editorial changes and guidance for future docs. |
| [0.7.1 review](reviews/0.7.1.md) | Concurrency, CLI, plugin, and UX review with reproductions and implementation follow-up. |

## Repository layout

```text
go.mod, cmd/, internal/  trew: server, store, backup, verification, purge
client/src/core/         shared sync engine, chunking, merging, transport
client/src/plugin/       Obsidian plugin and Vault adapter
client/src/cli/          trew CLI and filesystem adapter
client/src/stress/       fault, crash, collision, and scale coverage
scripts/                 validation and release tools
```

Keep sync decisions in `core`; adapters supply filesystem and interface behavior.
Read [the design rules](design.md#the-durability-rules) before changing a write
or recovery path.

## Build and test

Use the Go version required by [go.mod](../go.mod), Bun for client
scripts, and Node 22 or newer for the shipped CLI.

```bash
cd client
bun install
bun run typecheck
bun run test
bun run stress
bun run build
```

The client tests build and run a real Go server. `bun run build` produces
`client/dist/trew.mjs` and the three plugin assets under `client/dist/plugin/`.
Use `bun run format` for TypeScript formatting.

Before pushing, run the complete local gate from the repository root:

```bash
bash scripts/check.sh
```

Exit 0 means all checks applicable to this machine passed. Exit 1 is failure;
exit 2 means checks could not run and is incomplete. A skipped check is not a
pass. If Docker is unavailable, start your Docker engine (`orb start` for OrbStack
on macOS) and rerun the gate. Platform-specific checks may run only in CI;
inspect CI for the exact commit before releasing. A local pass does not
establish CI success.

For a bug fix, demonstrate that its regression test fails without the fix and
passes with it. Test preservation of the actual edited bytes, not just agreement
between devices. Keep fault and stress tests in scope for durability changes.

Wait for completion signals rather than guessed sleep intervals. Tests can use
`core/test-async.ts`: `deferred` holds a race window, `receiveCommitted` waits for
an acknowledged peer write to arrive, and `within` adds a cancelled-on-completion
failure deadline. Use fake clocks for timer behavior. Real delays belong in slow
link simulations; bounded polling is a fallback when an external process or
filesystem provides no completion signal. Keep awaits that order reads, writes,
acknowledgements, and index saves.

Measure interactive sync separately from bulk transfers with
`cd client && bun run bench:cadence`. It checks exact contents after new notes,
rapid edits, and incoming updates, using the production timers and a local test
server. Its in-memory adapters do not measure a phone's filesystem or network.

## MCP verification

The stdio and HTTP implementations use the pinned official MCP SDK 2.0.0. Protocol tests
exercise its legacy `2025-11-25` and modern `2026-07-28` modes, cancellation and
framing. The usable workflow is also tested through an official client talking
to a freshly built CLI child and the real Go server:

```bash
cd client
bun run test src/cli/mcp.test.ts src/cli/mcp-bin.test.ts src/cli/mcp-protocol.test.ts src/cli/mcp-artifact.test.ts
bun run test src/cli/mcp-token.test.ts src/cli/mcp-token-auth.test.ts src/cli/mcp-http.test.ts src/cli/mcp-http-process.test.ts src/cli/mcp-http-concurrency.test.ts
```

The TypeScript MCP's stress file, `mcp.stress.ts`, was retired in M2 rather than
moved to protocol 1: its phone races (disjoint, overlapping, append, delete and
rename edits against a phone, and an offline phone catching up) are the cases M5
task 12 ports to the server's MCP, from Basalt's identical copy, and its crash
and before-image cases belong to the MCP write path M5 replaces (tasks 3 and 9).
The classification of its 43 cases is in plan/strip-ledger.md, "M2 outcome".

The workflow finds a daily note, changes two exact task lines, compares unrelated
BOM/CRLF/frontmatter/link bytes, reads the before-image, and checks both copies
on a separately paired device. History tests inspect and restore an older version
to a free destination and read it again after restart and from a fresh device.
All files live in temporary directories. Tests never require a real user's vault.
The daily-note workflow runs through both legacy and modern official HTTP clients
talking to a CLI child, including exact before-image and second-device checks.

HTTP concurrency tests use one actual sync Client and writing NodeVault shared
by all clients. They cover same-base contention, disjoint edits, retries behind
a held append, 17 competing mutations, disconnect, DELETE and idle expiry during
an admitted write. Rotation and revocation tests hold one admitted write and
four queued writes, then prove that observing an old-token 401 cancels queued
work without losing the admitted edit. One thousand real CLI rotations under
an authentication loop must never expose a missing or torn credential record.

The SDK's `2026-07-28` HTTP path is sessionless; legacy `2025-11-25` uses sessions.
Twenty legacy initialization attempts yield 16 usable sessions and four prompt
refusals. Twenty modern readers compete with a phone-equivalent publishing 200
notes. Reads may honestly return `busy` or `changed_during_read`, and searches
report skipped changing files. Successful stable-folder results match sequential
queries; a fresh observer matches the final converged 231-file inventory.
The tests keep those bounded refusals instead of widening the existing queues.

Legacy cancellation ends its session because SDK 2.0 retains cancelled routing
state until the transport is collected. Tests check reconnection and actual
callback drain, including cancellation of old-key work in both protocol modes.
Authorization, origin, body, request, session and response limits run on real
ports. An unreadable credential returns 503 with no tool dispatch; its real
permission test explicitly skips when root bypasses that filesystem refusal.
Named-interface binding is exercised when a non-loopback IPv4 interface exists;
otherwise only that environment-dependent probe skips. Loopback remains required.
Both probes ran on the development Mac.

Process tests cover EOF, SIGTERM and broken stdout during admitted writes,
incoming sync, stalled handshake and reconnect sleep. They hold a filesystem
seam while another process tries the same canonical vault root and require it
to remain locked until the first process drains. Output backpressure is tested
with a paused real pipe. Malformed envelope shutdown has a regression for a
paused stdin descriptor that previously kept the process alive after draining.

`mcp-artifact.test.ts` builds the actual production configuration, copies only
`trew.mjs` into an empty installation and removes its build inputs before
launch. On macOS, sandbox-exec also denies the child access to the repository.
The test initializes, lists, reads and edits over both transports with the official
client, verifies the backup, and checks the plugin bundle for MCP SDK leakage.
The npm tarball gate repeats both read/edit/backup workflows against the installed package.
Dependencies missing from setup fail these tests rather than skipping them.

The MCP stress suite submits writes through tool handlers and uses independent
phone-equivalent clients plus a freshly paired reader. It checks actual retained
content after disjoint/overlapping edits, append versus replace, deletion,
rename, offline catch-up, stale put/putmany and a lost accepted upload reply.
The remote author exits after uploading so its disk cannot rescue a lost branch.
Tests also interrupt restore before its reply and disconnect the server during
an already admitted edit.

The HTTP stress driver repeats the phone races through real ports. Three official
clients share one writer; all three submit distinct create requests after the
intercepted phone race, and a fresh device must retain their markers as well as
the original and independent remote branches. Simultaneous competing HTTP edits
are covered separately by the concurrency tests above.

The explicit crash matrix reaches each boundary before SIGKILL on both stdio and HTTP:

| Seam | Boundary |
|---|---|
| `cli/mcp:backupVerified` | Backup bytes verified, before the transaction's directory flush. |
| `cli/mcp:backupDurable` | Before-image flushed, before rechecking and replacing the source. |
| `cli/vault:replace.staged` | Replacement staged, before parking the original. |
| `cli/vault:replace.nameFree` | Original parked, before publishing the replacement. |
| `cli/mcp:published` | Replacement published, before final verification and flush. |
| `cli/mcp:durable` | Local result flushed, before sending the tool response. |

After each kill, fresh observing objects read retained content before the first
network pass; a new process then acquires the lock and a fresh device downloads
the preserved branches. Removing before-image creation makes the post-publication
kill test lose the preexisting branch. Removing shutdown drains makes the
held-write lock test admit a competing process too early. These are preservation
assertions, not just convergence or successful exit checks.
HTTP restart also requires the unchanged credential to authenticate. All six
HTTP seams additionally exercise dropped TCP plus SIGTERM: the lock remains held
until the admitted edit finishes, and the exact before-image remains readable.

Production artifacts have been exercised on macOS with Node 22.23.2 and 24.21.0.
Recorded on 2026-09-15 on an Apple M4 Pro with 48 GiB RAM and local storage:
the HTTP CLI is 1,088,247 bytes, 49,471 bytes above the step 5 artifact
(1,038,776), or 49,171 bytes above the final stdio artifact (1,039,076).
The plugin remains 298,846 bytes, unchanged by HTTP and free of SDK imports.

| Runtime | Step 5 stdio initialization | Current HTTP initialization | Difference |
|---|---:|---:|---:|
| Node 22.23.2 | 93.0 ms | 120.7 ms | +27.7 ms |
| Node 24.21.0 | 101.4 ms | 109.8 ms | +8.4 ms |

Current stdio samples were 96.0 ms and 268.5 ms respectively. These are individual
observations from separate runs with different concurrent load and probe setup,
not controlled performance comparisons or latency guarantees. Each current
artifact workflow also verified an exact edit and before-image while denied
access to repository sources and dependencies.

Node 20.20.2 could initialize and read locally but lacked the global WebSocket
needed for sync; it is not supported. Process kills do not simulate power loss.
Flush-failure injection complements them, and native Linux filesystem/systemd
checks still require CI. The HTTP reverse-proxy stand-in rewrites Host and adds
forwarded headers while preserving mandatory bearer authentication. It exercises
forwarding, not external TLS, tailnet reachability or proxy identity enforcement.

Real Tailscale Serve acceptance passed on 2026-09-15 with a Linux headless client
and official SDK clients on macOS. Both protocol families negotiated through
HTTPS; exact edits, verified before-images, stale retries, token rotation,
revocation and restart were exercised. Mac and Android Obsidian devices received
the expected edited bytes and original before-image through ordinary Trew sync.
Temporary vaults also exercised native/container exclusion and SIGKILL recovery
on that Linux host. This does not replace CI's mounted-filesystem or systemd checks.

Cloudflare Tunnel, Collie and a specific phone MCP client remain untested. Manual
acceptance for that client must reach the actual proxy, ask the intended note
questions, then rotate the credential and prove access fails until the new token
is entered. If the chosen client requires OAuth instead of a static bearer,
scope that separately.

## Plugin testing

Tests use the real Obsidian declarations with a `DataAdapter` fake and a runtime
stub. Bundle tests load the built plugin against that stub and a real server,
and check for accidental Node dependencies in the plugin bundle.

These tests do not establish that a real Obsidian release invokes every adapter
method as expected. Pairing, editing, recovery, suspension, and upgrade flows
also need acceptance on actual supported desktop and Android devices. Screenshots
and panel structure tests cover presentation, not filesystem durability.

For plugin reviewers: the repository also contains a Node CLI. Its imports do
not imply Node dependencies in the plugin bundle. Shared code uses `globalThis`
and platform-neutral timers; local-resource `fetch` is used for attachment
streaming. Review the built plugin and resolved types as well as source scans.

Check actual open-editor behavior in an unpaired test vault:

```bash
node scripts/open-note-smoke.mjs --vault "Test vault"
```

This exercises repeated incoming updates, split views, cursor position, unsaved
typing, and undo/redo. It trashes its temporary notes and removes the test plugin
afterward. Add `--native-writes` to compare the same editors using Obsidian's
`Vault.modify` API. Neither mode measures network or Android performance.

### Refresh the screenshots

Open a test vault in desktop Obsidian and enable its command-line interface.
With client dependencies installed, run from the repository root:

```bash
node scripts/screenshots.mjs --vault "Screenshot vault"
```

The script captures the actual plugin panels with sample notes, device names,
and pairing details in both themes. It writes `docs/assets/screenshots/`, then
removes its temporary preview plugin and restores the window and appearance.
It never connects to a server. Review the images before committing them.
Use `--scene invite --theme dark` to recapture one view; `--help` lists the scenes.
For release captures, pass `--server-version VERSION` with the matching server
version. Source previews otherwise label the server `dev`.
The `uploading` and `downloading` scenes show transfer activity, including in
phone previews.
Keep the test vault open until cleanup finishes.

Use `--device phone` to preview the settings at phone width with Obsidian's
mobile styles. The script checks action alignment, field widths, tap targets,
and horizontal overflow. This is a layout preview, not Android or iOS acceptance.
Use `--output /tmp/trew-screenshots` for review images without replacing the
published gallery. A failed layout check leaves a `.failed.png` for inspection.

<details>
<summary>Screenshot gallery</summary>

| View | Light | Dark |
|---|---|---|
| Status panel | [View](assets/screenshots/panel.png) | [View](assets/screenshots/panel-dark.png) |
| Loading sync history | [View](assets/screenshots/loading.png) | [View](assets/screenshots/loading-dark.png) |
| Uploading changes | [View](assets/screenshots/uploading.png) | [View](assets/screenshots/uploading-dark.png) |
| Downloading changes | [View](assets/screenshots/downloading.png) | [View](assets/screenshots/downloading-dark.png) |
| Plugin settings | [View](assets/screenshots/settings.png) | [View](assets/screenshots/settings-dark.png) |
| Status indicator | [View](assets/screenshots/status.png) | [View](assets/screenshots/status-dark.png) |
| Setup choices | [View](assets/screenshots/pairing.png) | [View](assets/screenshots/pairing-dark.png) |
| First device | [View](assets/screenshots/setup.png) | [View](assets/screenshots/setup-dark.png) |
| Join a vault | [View](assets/screenshots/join.png) | [View](assets/screenshots/join-dark.png) |
| Confirm merging existing files | [View](assets/screenshots/join-confirm.png) | [View](assets/screenshots/join-confirm-dark.png) |
| QR invite and pairing code | [View](assets/screenshots/invite.png) | [View](assets/screenshots/invite-dark.png) |
| Server address | [View](assets/screenshots/server.png) | [View](assets/screenshots/server-dark.png) |
| Device list | [View](assets/screenshots/devices.png) | [View](assets/screenshots/devices-dark.png) |
| Deleted notes | [View](assets/screenshots/deleted.png) | [View](assets/screenshots/deleted-dark.png) |
| No deleted notes | [View](assets/screenshots/deleted-empty.png) | [View](assets/screenshots/deleted-empty-dark.png) |
| Version comparison | [View](assets/screenshots/changes.png) | [View](assets/screenshots/changes-dark.png) |

Phone layout previews (desktop rendering with mobile styles):

| View | Light | Dark |
|---|---|---|
| Status panel | [View](assets/screenshots/panel-phone.png) | [View](assets/screenshots/panel-phone-dark.png) |
| Loading sync history | [View](assets/screenshots/loading-phone.png) | [View](assets/screenshots/loading-phone-dark.png) |
| Uploading changes | [View](assets/screenshots/uploading-phone.png) | [View](assets/screenshots/uploading-phone-dark.png) |
| Downloading changes | [View](assets/screenshots/downloading-phone.png) | [View](assets/screenshots/downloading-phone-dark.png) |
| Setup choices | [View](assets/screenshots/pairing-phone.png) | [View](assets/screenshots/pairing-phone-dark.png) |
| First device | [View](assets/screenshots/setup-phone.png) | [View](assets/screenshots/setup-phone-dark.png) |
| Join a vault | [View](assets/screenshots/join-phone.png) | [View](assets/screenshots/join-phone-dark.png) |
| Confirm merging existing files | [View](assets/screenshots/join-confirm-phone.png) | [View](assets/screenshots/join-confirm-phone-dark.png) |
| QR invite and pairing code | [View](assets/screenshots/invite-phone.png) | [View](assets/screenshots/invite-phone-dark.png) |
| Server address | [View](assets/screenshots/server-phone.png) | [View](assets/screenshots/server-phone-dark.png) |
| Device list | [View](assets/screenshots/devices-phone.png) | [View](assets/screenshots/devices-phone-dark.png) |
| Deleted notes | [View](assets/screenshots/deleted-phone.png) | [View](assets/screenshots/deleted-phone-dark.png) |
| No deleted notes | [View](assets/screenshots/deleted-empty-phone.png) | [View](assets/screenshots/deleted-empty-phone-dark.png) |
| Version comparison | [View](assets/screenshots/changes-phone.png) | [View](assets/screenshots/changes-phone-dark.png) |

</details>

## Performance work

From `client/`, use `bun run bench`, `bun run bench:sync`, `bun run scale`, and
`bun run dedup`. Run CPU-sensitive measurements under both Bun and stock Node
where practical. Report the commit, hardware, runtime, network conditions, and
correctness checks with every timing. [Historical results](research.md) are
context, not measurements of the current checkout.

## Releases

The server uses `server/vX.Y.Z` tags, the CLI uses `cli/vX.Y.Z`, and the plugin
uses bare `X.Y.Z` tags matching its manifest. Versions can move independently;
protocol compatibility is separate.

Use [scripts/release.sh](../scripts/release.sh) for preparation and the current
runbook. `scripts/release.sh --runbook` prints instructions without building or
publishing. The workflows build and check release assets; verify the published
files with [scripts/verify-release.sh](../scripts/verify-release.sh).

Every GitHub release must include a short user-facing changelog: what is new
or fixed since that component's previous release, upgrade steps, and known
issues. Include CLI changes in the plugin notes when they ship together.
Publish the notes with `--notes-file` and read the release body back to verify
it. GitHub is the home for changelogs; do not duplicate them in repository docs.

To check an asset's build provenance:

```bash
gh attestation verify main.js --repo waynehoover/trew
```

An attestation identifies the build source. It is not a security audit or proof
that the application is defect-free.

The current source speaks protocol 1, Trew's own; Basalt's releases speak
protocol 7, and the two refuse each other at hello, naming both numbers. Build
the server and clients together for local testing. No compatibility fallback is
provided. Tests exercise preserved bytes across concurrent writers, not just
final agreement.

The screenshot script includes activity, conflict comparison, first-sync
preview, and attachment history scenes. Use a disposable Obsidian vault and
`--output /tmp/trew-captures` for review images. Phone CSS previews are not
native Android acceptance.

## The fork from Basalt (M0)

Trew began as a copy of Basalt Sync at commit `664a963` (Basalt Sync 0.10.0,
protocol 7), renamed, with every Basalt check passing before anything was
removed. The steps, each gated by a full `scripts/check.sh` run:

1. A faithful copy, same layout, still named Basalt: 32 passed, 0 failed,
   0 skipped (two checks are CI only: systemd's verdict on the unit and the
   loopback filesystem).
2. The rename (first to Telimus, then the same day to Trew, the name it
   has now). `basalt`, `Basalt`, `BASALT` and `basaltd` became `trew`,
   `Trew`, `TREW` and `trew`; the module became
   `github.com/waynehoover/trew`; the invite protocol action became
   `obsidian://trew`; the manifest description was rewritten to pass the
   community directory's rules (no "Obsidian", ends with a period).
3. The Go module moved from `server/` to the repository root, so
   `go install github.com/waynehoover/trew/cmd/trew@latest` names one
   binary. Release tags stay `server/vX.Y.Z` until M9 decides the release
   scheme; they are release triggers, not Go module versions.

Deliberately not renamed at M0, because they were to die with the crypto in
M1 and M2 and renaming them would have changed derived bytes or golden vectors:
the `basalt3i_` invite and `basalt3_` credential prefixes, and the
`basalt/<purpose>/1` key-derivation labels including the crypto suite id.
Three tests had matched a recovery key with a loose `/^basalt/` pattern and
were changed to match the kept `basalt3_` prefix. The key schedule and the
recovery key have since gone. The two prefixes survive in `parseInvite`
(`client/src/core/pairing.ts`), which recognises a pasted Basalt string so it
can say that it is Basalt's, and in the fixtures' refused invite vectors.

`docs/findings.md`, `docs/documentation-review.md` and `docs/reviews/` are
Basalt's history, copied verbatim with a provenance note, because the review
IDs they define are cited throughout the code.

### Inventory at the fork

Counted with the same method at Basalt `664a963` and at the Trew fork; the
only difference is the FTS5 probe below.

| Area | Basalt `664a963` | Trew at M0 |
|---|---|---|
| Go non-test | 13,588 lines in 18 files | 13,588 lines in 18 files |
| Go test | 22,895 lines in 73 files, 536 top-level `Test` functions | 22,941 lines in 74 files, 537 |
| Core TypeScript non-test | 20,802 lines in 36 files | same |
| Core TypeScript test | 21,301 lines in 56 files | same |
| Plugin source / test files | 15 / 21 | same |
| TypeScript MCP non-test | 5,246 lines in 21 files | same |

### FTS5 in the pinned driver

`internal/store/fts5_test.go` asks the driver the server links
(`modernc.org/sqlite` v1.56.0), not the local `sqlite3` CLI: it creates an FTS5
table with the `unicode61 remove_diacritics 2` tokenizer and runs a
`bm25`-ranked `MATCH` in which "resume" finds "résumé". It passes, so PLAN §2.5
can build on FTS5 without a second dependency.

### Real-app acceptance

On 2026-09-22, against Obsidian 1.13.7 on macOS: the built plugin was
installed in a brand-new vault, loaded unpaired with no captured errors, and
claimed a fresh `trew serve -localhost` through its first-device flow, still
Basalt's at M0 (`pairFirst`, with the recovery key handed over before the
claim; both are gone since M2, and the first device now pairs from an invite).
A note
written through the `obsidian` CLI reached the server; a headless client
paired from an invite the plugin created and downloaded it byte-identical; a
note created on the headless client arrived in the vault over the live
session; and an edit appended in Obsidian after pairing arrived
byte-identical on the headless client. The server then held 2 files and 3
versions.

This is M0's acceptance, not M3's: one desktop, one machine, loopback, and
the flows driven through the plugin's own methods rather than by hand.

### The MCP transport: hand-rolled, with the SDK as the test client

Decided 2026-09-22 (PLAN.md M4 task 1). The server speaks MCP's streamable
HTTP itself: stateless `POST /mcp` answered with `application/json`, `GET` and
`DELETE` answered 405, and the protocol version negotiated from the client's
`initialize` among 2025-06-18, 2025-11-25 and 2026-07-28. The tool surface is
fixed and small (`initialize`, `tools/list`, `tools/call`, the `initialized`
notification), and every input is validated more strictly than a generic
schema layer would (character and UTF-8 byte limits, lone surrogates).

The official Go SDK, `github.com/modelcontextprotocol/go-sdk` v1.8.0, is a
test-only dependency. Its client drives the handler at every protocol version
it supports (2024-11-05 through 2026-07-28), so interoperability is proven by
an implementation that is not this one. Linking its `mcp` package into the
server was measured and rejected: it pulls `golang.org/x/oauth2`,
`google/jsonschema-go`, segmentio's assembly-accelerated JSON and base64,
`uritemplate` and `x/time/rate` into the binary, beside a 12,000-line
streamable transport. Test-only imports are not linked into `trew`.

### Latent issues in the chunker

Found while porting `client/src/core/chunk.ts` to Go (`internal/notes`,
2026-09-22). None is reachable through `sizesFor` with today's tables, so both
ports keep the behaviour, but each is a trap for whoever changes the sizes.
Line numbers are those of the M2 core:

- `chunkStream` and `chunkBytes` disagree for minimums of 1 or 2: after a UTF-8
  trim the streaming splitter re-hashes the carried bytes without testing them
  for a boundary (`chunk.ts:450-465`) while the in-memory one re-tests them
  (`:355`). The engine uses both on the same files, so a table with a tiny
  minimum would rename chunks.
- With a minimum under 4, a chunk of valid UTF-8 can be invalid on its own
  (`:270`), and chunks other than the last can come out up to 3 bytes below
  the minimum.
- `EngineOptions.mergeable` also decides chunking (`engine.ts:354`, `:2217`):
  it picks the size table and the UTF-8 flag, so a custom merge predicate
  would silently change chunk names. Nothing in production sets it.
- Dead code: `TEXT_AVG_MAX` (`:132`) cannot apply through `sizesFor`, and
  `if (lead < start)` (`:264`) is never true.

Settled in M2:

- **Done.** The 192-byte floor (`CHUNK_FLOOR`, `WINDOW * 4`, `chunk.ts:199`)
  can exceed a server's advertised `chunkMax`, which would produce chunks that
  server refuses for ever, against the promise at `:204-207`. The engine's
  `start()` now refuses a `chunkMax` below the floor at the handshake, with a
  non-retryable `protostate` naming both numbers, and closes the connection
  rather than strand every file. This server advertises a fixed 1 MiB.
- **Done.** The chunking text-extension list existed twice in TypeScript.
  `looksLikeText` in `chunk.ts` now delegates to `chunkingText` in
  `path-policy.ts`, and `TEXT_EXTENSIONS` is a view of
  `CHUNKING_TEXT_EXTENSIONS`, so the list `protocol-fixtures.json` pins is the
  one the chunker uses.

### The strip ledger

Before M1 or M2 deletes a test file, each of its assertions is classified as
obsolete with the crypto or still a guarantee (PLAN §2.1). The ledger is
[plan/strip-ledger.md](../plan/strip-ledger.md): its per-test tables hold the
classification, its
[unique guarantees](../plan/strip-ledger.md#guarantees-with-no-equivalent-elsewhere)
are the ones no other test would catch, and its
[M1 outcome](../plan/strip-ledger.md#m1-outcome-the-go-side) records where each
Go test went.

