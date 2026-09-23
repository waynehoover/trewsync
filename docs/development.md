# Develop TrewSync

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
go.mod, cmd/, internal/  trewd: server, store, backup, verification, purge
client/src/core/         shared sync engine, chunking, merging, transport
client/src/plugin/       Obsidian plugin and Vault adapter
client/src/node/          trew CLI and filesystem adapter
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
bun run lint
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
bun run test src/node/mcp.test.ts src/node/mcp-bin.test.ts src/node/mcp-protocol.test.ts src/node/mcp-artifact.test.ts
bun run test src/node/mcp-token.test.ts src/node/mcp-token-auth.test.ts src/node/mcp-http.test.ts src/node/mcp-http-process.test.ts src/node/mcp-http-concurrency.test.ts
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

The fake's index leaves out a file renamed into place from a hidden name until
its watcher reports it, as Obsidian 1.13.7 does. `holdWatcher` keeps the index
behind for a test, and the stub vault's `relayAdapterEvents` passes the
adapter's reports to the plugin as the `create`, `modify`, `delete` and
`rename` events Obsidian fires for the plugin's own writes.

These tests do not establish that a real Obsidian release invokes every adapter
method as expected. Pairing, editing, recovery, suspension, and upgrade flows
also need acceptance on actual supported desktop and Android devices. Screenshots
and panel structure tests cover presentation, not filesystem durability.

For plugin reviewers: the repository also contains a Node CLI. Its imports do
not imply Node dependencies in the plugin bundle. Shared code uses `globalThis`
and platform-neutral timers; local-resource `fetch` is used for attachment
streaming. Review the built plugin and resolved types as well as source scans.
The warnings the directory's review prints for these are the
[accepted warnings](#accepted-warnings) below, each with its reason.

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
| Pair this device | [View](assets/screenshots/pairing.png) | [View](assets/screenshots/pairing-dark.png) |
| An invite pasted | [View](assets/screenshots/join.png) | [View](assets/screenshots/join-dark.png) |
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
| Pair this device | [View](assets/screenshots/pairing-phone.png) | [View](assets/screenshots/pairing-phone-dark.png) |
| An invite pasted | [View](assets/screenshots/join-phone.png) | [View](assets/screenshots/join-phone-dark.png) |
| Confirm merging existing files | [View](assets/screenshots/join-confirm-phone.png) | [View](assets/screenshots/join-confirm-phone-dark.png) |
| QR invite and pairing code | [View](assets/screenshots/invite-phone.png) | [View](assets/screenshots/invite-phone-dark.png) |
| Server address | [View](assets/screenshots/server-phone.png) | [View](assets/screenshots/server-phone-dark.png) |
| Device list | [View](assets/screenshots/devices-phone.png) | [View](assets/screenshots/devices-phone-dark.png) |
| Deleted notes | [View](assets/screenshots/deleted-phone.png) | [View](assets/screenshots/deleted-phone-dark.png) |
| No deleted notes | [View](assets/screenshots/deleted-empty-phone.png) | [View](assets/screenshots/deleted-empty-phone-dark.png) |
| Version comparison | [View](assets/screenshots/changes-phone.png) | [View](assets/screenshots/changes-phone-dark.png) |

</details>

## The community directory review

The Obsidian community directory reviews every release, not only the first,
with `eslint-plugin-obsidianmd`'s `recommended` config. An error makes that
release uninstallable; a warning passes with a written reason. `bun run lint`
runs the same config, unchanged, and fails on any error. It is a step of
`scripts/check.sh` and of CI's client job, both named `lint`.

The versions are pinned: eslint 9.39.5 and eslint-plugin-obsidianmd 0.4.2, the
newest release when the gate landed (2026-09-23). A newer plugin release can
add rules, so move the pin deliberately and read what it finds before
releasing on it.

It reads the plugin bundle's source: the 43 files under `client/src/plugin`
and `client/src/core` that `src/plugin/main.ts` reaches, type-only imports
included. Tests are left out by name, and the fourteen other files of those
folders are listed in [client/eslint.config.mjs](../client/eslint.config.mjs)
with the reason each exists: test scaffolding, the fuzzers, the headless
client's outcomes and fault seams, and the platform probe, which `main.ts` does
not import yet. The config walks the imports from `main.ts` every run and
refuses to lint when a listed file has joined the bundle, when a listed file
is gone, or when a file of those folders is neither reached nor listed.

It runs from the repository root, which `bun run lint` changes to, because the
plugin reads `manifest.json` from the working directory. Without the
manifest's `minAppVersion`, `no-unsupported-api`, the rule that decides whether
an older Obsidian can load the plugin, switches itself off. The config refuses
to run anywhere else.

No rule is switched off in the config, and none can be by comment: the
recommended config makes a comment that disables any `obsidianmd` rule,
`no-console`, `no-restricted-globals`, `@typescript-eslint/no-deprecated` and
several others an error of its own. An Obsidian API newer than `minAppVersion`
goes behind `requireApiVersion("X.Y.Z")`, with the version from its `@since`
tag, which is the guard `no-unsupported-api` recognises. Keep a `typeof` check
after it where the API is optional. `registerCliHandler` (1.12.2) and
`SettingGroup` (1.11.0) are guarded that way in `main.ts`.

### Accepted warnings

The warnings the review will print, and why each stays. When a warning is
added or removed, change this table in the same commit.

| Rule | Count | Where | Why it stays |
|---|---|---|---|
| `obsidianmd/prefer-window-timers` | 20 | `core/client.ts` (12), `core/transport.ts` (8) | `core` is also the headless client's engine, and Node has no `window`. |
| `obsidianmd/prefer-window-timers` | 9 | `plugin/main.ts` (6), `plugin/visible-poll.ts` (3) | The plugin's tests run in Node, where there is no `window`; they drive these timers with fake timers on the globals, and some replace `window` with a bare `EventTarget`. The plugin's code runs in Obsidian's main window, so a bare timer is already that window's. `main.ts` records the choice where the save-to-sync timer is set. |
| `obsidianmd/no-global-this` | 3 | `core/digest.ts` (2, `crypto`), `core/transport.ts` (1, `WebSocket`) | Shared with the headless client. The global object is the one place both runtimes keep WebCrypto and WebSocket. |
| `obsidianmd/no-global-this` | 9 | `plugin/activity.ts` (2), `plugin/delivery.ts` (1), `plugin/main.ts` (3), `plugin/resume.ts` (2), `plugin/visible-poll.ts` (1) | Each reads `document`, `window`, `navigator` or `location` so that a missing one is `undefined` rather than a thrown error, because the tests run in Node and supply them with `vi.stubGlobal`. Where an element is at hand the panel already uses its `ownerDocument` and that document's window, which is what keeps it right in a popout; the global is the fallback. |
| `obsidianmd/no-global-this` | 1 | `electronFs` in `plugin/vault.ts` | Node's `fs` for the durable fsync on desktop, through the `require` Electron provides as a global. Written as `require("fs")` the bundler would resolve it and the plugin would name a Node module, which the build test refuses. |
| `no-restricted-globals` (`fetch`) | 2 | `readBlocks` and `readRange` in `plugin/vault.ts` | They fetch the vault's own resource URL, not the network, to read a large attachment as a stream and by range. `requestUrl` returns whole bodies and does not read resource URLs. |
| `@typescript-eslint/no-deprecated` (`setWarning`) | 5 | `plugin/main.ts` | Its replacement, `setDestructive`, arrived in 1.13.0 and the manifest admits 1.7.2, so using it would be a `no-unsupported-api` error. |
| `obsidianmd/ui/sentence-case` | 15 | `plugin/main.ts` | Twelve are the product's name, TrewSync, whose capital S the rule reads as a second word to lowercase: the plugin's name on the ribbon and in the panel's title, "Which platforms TrewSync supports", the file menu's "TrewSync: version history", and eight notices that name it. One is the literal invite prefix `trew1i_...`, and two are the example device name `laptop` in a placeholder, spelled as device names are everywhere else. |
| `obsidianmd/settings-tab/prefer-setting-definitions` | 1 | the settings tab in `plugin/main.ts` | `getSettingDefinitions` is the declarative settings API of 1.13.0. Until it is adopted, the tab's settings do not appear in Obsidian's settings search on 1.13 or later. |

That was 56 warnings, and no errors, at the commit that added the gate. Writing
the name TrewSync added nine of the sentence-case kind, so it is 65.

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

The current source speaks protocol 1, TrewSync's own; Basalt's releases speak
protocol 7, and the two refuse each other at hello, naming both numbers. Build
the server and clients together for local testing. No compatibility fallback is
provided. Tests exercise preserved bytes across concurrent writers, not just
final agreement.

The screenshot script includes activity, conflict comparison, first-sync
preview, and attachment history scenes. Use a disposable Obsidian vault and
`--output /tmp/trew-captures` for review images. Phone CSS previews are not
native Android acceptance.

## The fork from Basalt (M0)

TrewSync began as a copy of Basalt Sync at commit `664a963` (Basalt Sync 0.10.0,
protocol 7), renamed, with every Basalt check passing before anything was
removed. The steps, each gated by a full `scripts/check.sh` run:

1. A faithful copy, same layout, still named Basalt: 32 passed, 0 failed,
   0 skipped (two checks are CI only: systemd's verdict on the unit and the
   loopback filesystem).
2. The rename (first to Telimus, then the same day to Trew). `basalt`,
   `Basalt`, `BASALT` and `basaltd` became `trew`, `Trew`, `TREW` and
   `trew`; the module became `github.com/waynehoover/trew`; the invite
   protocol action became
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

### TrewSync and trewd (2026-09-23)

The day after the fork the owner settled how the name is written (PLAN §10).
The product is **TrewSync**, one word, wherever a person reads it: the
manifest's `name`, the plugin's notices, titles and tooltips, what the server
and the headless client print, and the docs. The server's command is `trewd`:
`cmd/trew` moved to `cmd/trewd`, so `go build ./cmd/trewd` and
`go install github.com/waynehoover/trew/cmd/trewd@latest` make it, and the
image, the release assets and the test harnesses name it. Until then the
server and the headless client both installed a `trew`. The headless client
keeps `trew`.

No identifier moved: the module path, `TREW_DATA`, the `.trew` folders and
`.trew-tmp-` marks, the `trew1i_` prefix, `obsidian://trew`, the plugin id and
npm package `trew-sync`, the store's product id, the systemd unit and its
account, the image and compose service names, the MCP server name and the
release tag formats. Records written before the change, such as the
acceptance runs below and the status lines in PLAN.md, keep the names they
were written with.

### Inventory at the fork

Counted with the same method at Basalt `664a963` and at the TrewSync fork; the
only difference is the FTS5 probe below.

| Area | Basalt `664a963` | TrewSync at M0 |
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

M2's, on 2026-09-23 at `99953a7`, against Obsidian 1.13.7 on macOS: two
brand-new vaults opened through Obsidian's own IPC, each with the built
plugin, and one headless client, all against `trew serve -localhost`. The
first vault paired from the server's `first-invite` with the merge confirmed
(it held a note already); the second vault and the headless client paired
from invites the first vault's plugin created. Notes written through the
`obsidian` CLI in each vault and on disk for the headless client converged
to one normalised path and SHA-256 inventory on all three. The headless
client, offline, and the first vault edited the same line of one note; after
it synced, all three held the vault's version under the note's name and the
headless client's as a conflicted copy. A note deleted in the first vault
left the other two, was restored from the second vault's deleted list, and
came back byte-identical everywhere. A control-character name on the
headless client's disk and another written through Obsidian's adapter in the
first vault each stayed on the disk that held it and were named with the
reason, in `trew sync` and `trew status` (both exiting 1) and in the
plugin's stranded list. The driver is not in the repository; it drives the
plugin through its own methods (`pair`, `createInvite`, `deletedNotes`,
`recover`, `syncNow`) from `obsidian eval`, as M0's did.

M3's, on 2026-09-23 at `65e9820`, with real devices: Obsidian 1.13.7 on this
Mac and Obsidian on a Pixel 9 Pro XL (Android 17), against `trew serve -mcp`
on the Mac bound to loopback and reached over Tailscale Serve at
`wss://wph.example.ts.net:8445` (tailnet only), with `-url` naming that
address in invites. The Mac vault was fresh and paired from `first-invite`;
the phone vault was a new folder with the plugin pushed over `adb`, and the
phone paired by scanning the QR the Mac's panel showed. On the phone, writes
went through Obsidian itself (`obsidian://new` actions, and the plugin's own
UI driven over the WebView's DevTools socket); on the Mac through the
`obsidian` CLI and `obsidian eval`. Exercised, in order:

- Edits both ways: a note created on the Mac arrived on the phone in about a
  second, an edit and a new note made on the phone arrived on the Mac, all
  byte-identical.
- An attachment: a 377,520-byte JPEG put in the phone's vault folder by
  another program arrived on the Mac byte-identical, but by a bad route (the
  first finding below).
- A conflict: the phone paused (which closes its connection), both devices
  changed the same line, the phone resumed; both texts were kept, the
  phone's under the note's name and the Mac's as `From the Mac (Conflicted
  copy android-a1c2 202609230941).md`, identical on both devices.
- History compare on the phone: the history modal listed four versions with
  their devices and showed the oldest against the current as a coloured diff.
- Deleted-note restore: a note deleted on the Mac left the phone within two
  seconds and was restored from the phone's deleted list with its original
  SHA-256 on both devices.
- A refused path: a note named with U+0007 written through Obsidian's adapter
  on the Mac was named with its reason in the Mac's stranded list, never
  reached the server, and never reached the phone.
- Revoke while connected: the Mac revoked the phone; the server closed its
  session within the revoke reply, the phone said it had been revoked and
  kept all five notes.
- Re-pair: unlink on the phone, a new invite from the Mac pasted into the
  pairing form (destination line shown), the populated-vault confirmation,
  the first-sync review ("already matches"), synced as a new device; an
  append on each side then arrived on the other, and the two inventories
  matched byte for byte apart from the refused note.

Findings:

1. **A receiving device committed deletions nobody made.** Twice, the Mac,
   only receiving, downloaded a version of a file and within 10 to 30 ms
   committed a deletion of it, then found it on disk and uploaded it as new;
   the phone applied the deletion (its copy went to `.trash`) and downloaded
   the re-upload. Once for the attachment (a 0-byte version the phone had
   caught mid-write, then the full bytes), once for the phone's conflict
   copy (a new path downloaded in the same pass as another note's new
   version). No bytes were lost, but only because the re-upload succeeded.
   Fixed separately with regression tests; see the fix's commit.
2. A revoked device's panel says to pair again with a new invite but draws
   the paired panel, with no invite field; the way on is Manage this vault,
   then Unlink. Fixed: a stop on `auth` or `nodevice` carries the
   `pair-again` recovery, and the panel draws the pairing form in place of
   the paired panel. Pairing from it confirms the merge, writes the new
   pending pairing over the refused one, and only then removes the old index,
   which any save of a pending pairing now does, so a crash between the two
   cannot finish the new pairing on the old cursor.
3. After unlinking, the pairing form's Invite field was filled with the
   first QR's invite, already used. Fixed: the panel forgets a link's invite
   once a pairing holds the vault.
4. The "Trew has stopped: this device was revoked" notice stayed on screen
   after re-pairing. Fixed: the notice is taken down when the state leaves
   that stop, by pairing again, unlinking or a recovery.
5. Folder deletions did not travel (a deliberate rule inherited from Basalt):
   empty folders deleted on the Mac stayed on the phone, and a folder renamed
   on one device left its old name, empty, on the other. Changed on
   2026-09-23 with the owner's approval (`docs/design.md`, "Folders"): the
   deleting device sends the folder's deletion after its files', the server
   refuses one while anything live is in the folder, and a receiving device
   removes the folder only if it is empty there, putting it back when
   something keeps it; no file is deleted or trashed for a folder's sake.
   Covered by `client/src/core/folder-deletion.test.ts`,
   `client/src/plugin/folders.test.ts`, `client/src/node/folders.test.ts`,
   `internal/store/folder_deletion_test.go` and
   `client/src/stress/folders.stress.ts`. Folders left behind by the old rule
   are not migrated. Not yet repeated with real devices.
6. Not TrewSync: a meeting-notes exporter on this Mac ran `obsidian create
   vault=NAME ...` with `vault=` after the command, which the CLI ignores,
   so it created an empty note in whichever vault was active (the test
   vault, while it had focus) before writing the real note into the right
   vault by path. Fixed in the script.

### The MCP transport: hand-rolled, with the SDK as the test client

Decided 2026-09-22 (PLAN.md M4 task 1). The server speaks MCP's streamable
HTTP itself, in `internal/mcp`: stateless `POST /mcp` answered with
`application/json`, `GET` and `DELETE` answered 405, no `Mcp-Session-Id` ever
minted. Every input is validated more strictly than a generic schema layer
would (character and UTF-8 byte limits, lone surrogates, unknown and repeated
keys).

The official Go SDK, `github.com/modelcontextprotocol/go-sdk` v1.8.0, is a
test-only dependency. Its client drives the handler at every protocol version
it supports (2024-11-05 through 2026-07-28), so interoperability is proven by
an implementation that is not this one. Linking its `mcp` package into the
server was measured and rejected: it pulls `golang.org/x/oauth2`,
`google/jsonschema-go`, segmentio's assembly-accelerated JSON and base64,
`uritemplate` and `x/time/rate` into the binary, beside a 12,000-line
streamable transport. Test-only imports are not linked into `trewd`, and
`TestTheSDKIsImportedOnlyByTests` checks no server file imports it.

Two eras are spoken, because 2026-07-28 removed the handshake:

| Asked for | Negotiated | How |
|---|---|---|
| 2025-06-18, 2025-11-25 | the same | `initialize`, then `MCP-Protocol-Version` on every request |
| 2024-11-05, 2025-03-26, anything else in `initialize` | 2025-11-25 | the newest version that has a handshake |
| 2026-07-28 | the same | no handshake: `server/discover`, `_meta` protocol version and client capabilities on every request, `Mcp-Method` and `Mcp-Name` mirrored from the body (SEP-2575, SEP-2243) |

An `initialize` asking for 2026-07-28 is answered with 2025-11-25: announcing,
through the handshake, the revision that removed the handshake would be wrong,
and the SDK's own server does the same. At 2026-07-28 results carry
`resultType`, `_meta` names the server, `tools/list` and `server/discover`
carry `ttlMs: 0` and `cacheScope: "private"` (the list depends on the token's
scope), and `ping` is gone, as that revision says. A handshake-era request
other than `initialize` must name a version this server negotiates in
`MCP-Protocol-Version`; the versions before 2025-06-18, which had no such
header, are not spoken, so a missing header is refused rather than guessed.

Frames: one JSON object with JSON-RPC's members and no others, none repeated;
an id that is a string or an integer of at most 256 bytes, repeated back
exactly; params an object. Batches and other non-object bodies are invalid
requests, the Basalt lesson of the non-object frame. Two requests with one id
are answered each on its own connection, so the Basalt lesson of the duplicate
id, whose SDK rerouted the first reply, cannot arise: nothing routes a reply
by id. Unknown methods and malformed frames are JSON-RPC errors (404 for an
unknown method at 2026-07-28, as it requires); a tool that fails reports it in
its own result with `isError`.

### The MCP endpoint (M4)

**Tokens and authors.** `mcp_tokens` holds each token's SHA-256, a random
16-byte id (the display fingerprint is eight hex characters of the hash, never
the identity), label, scope (`read` by default), `expires_at` (90 days by
default), `last_used` and `used_count`. `last_used` is written at most once a
minute per token, with the counts held since, and before any listing and at
shutdown; so a crash loses at most a minute of counts, and a stolen token used
once between legitimate uses still shows in `used_count`. Each token has an
`authors` row of kind `mcp`, made and deleted with it in one transaction:
authors are not devices, never appear in a device listing or delivery status,
and need no widening of the device id rule. Minting, listing and revoking go
through the control socket to the running server, under the commit lock.

**Authorization.** In order: the route (exactly `/mcp`, no query string), the
method, the `Origin` (absent, or exactly an `-allow-origin` value; 403 before
the credential is read), the endpoint's cap of 32 requests in flight, the
bearer (`Authorization: Bearer` and 43 characters of canonical base64url,
compared in constant time against every stored hash), the token's own
budgets, and only then the body (8 MiB, declared or streamed, else 413).
Failures are 401 with `WWW-Authenticate: Bearer realm="trew"` and the word
`unauthorized`, nothing else; there is no OAuth metadata anywhere. Failed
authentication has a budget per connection address (10 at once, 1 a second),
past which refusals are 429 and stop being logged; a valid token from that
address is still admitted. Per token: 8 requests in flight, 5 a second
sustained with a burst of 30, and 4 MiB a second of replies with a burst of
16 MiB, each answering 429 with `Retry-After`. Scope is checked at discovery
(a token is listed only the tools its scope allows), at dispatch (a call to a
tool the scope does not allow is `read_only`, whatever the client was shown),
before every reply (a token revoked while its request ran loses, and the
result is never sent), and for a write under the commit lock
(`call.commit`, the only path from a tool to a mutation, which M5's
`CommitOperation` will run inside). That path is a build check, not a
convention: `TestOnlyTheCommitBoundaryReachesAMutation` reads the package's
source and fails on any method of the store, the server or the chunk store
reached outside a `commit` callback unless it is on a short list of reads, so
a method added later, `CommitOperation` included, is held to the boundary
until someone lists it as a read. Replies over 1 MiB are replaced by
`result_too_large` before anything is written.

**The envelope.** Server facts go under `trusted`: uids, sizes, counts, times,
the head and the epoch, cursors the server minted, and a path only when it is
the caller's own argument, which the path rules have just accepted. Under
`untrusted_content`, through `Normalize`: note text, match context and diff
text, and every path, name and device label a listing finds in the vault. A
row about such a path is kept whole under `untrusted_content` rather than
split, so an agent reads a path beside its facts. A path that `Normalize`
alters (a bidi override, a tag character, an imitated envelope key are all
legal in a path) is shown altered and so cannot be passed back as found; the
security block's counts say it happened.

**Listing and cursors.** `list_notes` and `search_notes` read the vault as of
the head their first page pinned, with rename retirements capped at the head
as well as versions (M4 task 7), streaming along the path index. A cursor
binds the store's epoch, its purge generation, the head and the options; one
made for other options, or from before a restore or a purge, is
`invalid_cursor` with a message saying which it may be, never a page of a
different world. A search cursor does not bind the index generation: the index
only proposes candidates and the matcher decides, so a page's matches are the
same whichever generation proposed them. `compare_versions` refuses a later
page without the `toUid` the first reported.

**Search.** `internal/search` keeps its index in `search.db` beside the store,
written by one worker that never takes the store's write lock or the commit
lock, so it cannot refuse or delay a device's write; a commit nudges it
without waiting, and `indexed_through_uid` is saved in the transaction with the
changes it covers. Each note's text is folded character by character through
the matcher's own case fold (`notes.FoldLiteral`), NUL mapped to U+FFFF because
FTS5 cannot take NUL in a query, and held in a contentless FTS5 table with the
trigram tokenizer and its own case folding off. Folded containment is exactly
what a case-insensitive match needs, and implied by an exact one, so for a
query of three characters or more the proposal is a superset of the matcher's
notes. Shorter queries, notes the index holds at another version than the one
searched, and notes it could not read are scanned. Tags come from the ported
parser; a refused frontmatter limits that note's tags, is counted, and makes
it a candidate that search reports as skipped. A rebuild captures a head,
indexes the vault as of it in batches of 64, replays what came after, is
checked against the store, and only then switches; the previous generation
answers meanwhile with its own indexed head. Every proposal compares the
tables with the generation's recorded counters in the same read, so rows
truncated under a matching `index_version` are caught at once, and a digest
and a comparison with the store at open and every ten minutes catch what
consistent counters would hide. A `search.db` that cannot be opened at all is
renamed `search.db.broken` and made again, and if even that fails the endpoint
serves with no index and search scans: a derived file is never the reason the
server does not start. Search matches Basalt's scan over every query of the
oracle corpus in `mcp-fixtures.json`, with the index and without it.

**Decisions the spec did not settle.** `invalid_arguments` is the code for a
wrong type, an unknown or a missing argument, and `invalid_limit` for a number
out of range (both reached the tools from `internal/notes`, neither is in
plan/mcp-tools.md's list). `list_notes` with `includeDeleted` marks deleted
rows `kind: "deleted"` and `deleted: true`. Paths sort in byte order, which is
code point order; Basalt sorted in UTF-16 order, and the two differ only
between U+E000 to U+FFFF and characters beyond U+FFFF. `.canvas` is not
readable: `internal/paths.MCPReadable`, pinned by the fixtures, says `.md` and
`.txt`, where plan/mcp-tools.md also lists `.canvas`. `note_history` takes any
syncable path, attachments included; Basalt refused formats it could not read.

**Acceptance (M4 done-when, the parts a machine can do).** Recorded
2026-09-23 on macOS against the built binary, on a scratch data directory;
the run with Claude Code and the plugin is below. `TestMCPAcceptanceExternal` pairs a device from the
first invite, writes notes over the protocol, mints a read token through the
running server's control socket, and drives `/mcp` with the SDK client at
three protocol versions while a second connection keeps writing:

```bash
go build -o /tmp/trewd ./cmd/trewd
/tmp/trewd serve --mcp -localhost -addr 127.0.0.1:3013 -data /tmp/accept-data &
TREW_ACCEPT_DATA=/tmp/accept-data TREW_ACCEPT_ADDR=127.0.0.1:3013 \
  go test ./cmd/trewd -run TestMCPAcceptanceExternal -v -count=1
/tmp/trewd mcp-token -data /tmp/accept-data -list
```

The transcript below was recorded before the server command was renamed
`trewd`, so its one command line still says `trew`.

```text
serving MCP at /mcp with no token yet, so every request is refused
acceptance: the device wrote 11 notes through the protocol, the journal at uid 1
acceptance: trew mcp-token -label acceptance -key-out FILE: Wrote an MCP token for vault "default" to .../agent.key.
  It reads the whole vault, and expires at 2026-12-22T10:24:54Z.
acceptance: protocol 2026-07-28, the last of 5 rounds while the device wrote 52 versions: listed 11 paths at head 12,
  read uid 12 exactly, found violet-otter, compared uid 1 to 12 (1 changes), vault head 63, index fresh, indexedHead 63
acceptance: protocol 2025-11-25, the last of 1 rounds while the device wrote 54 versions: listed 37 paths at head 63,
  read uid 116 exactly, found violet-otter, compared uid 1 to 118 (1 changes), vault head 118, index fresh, indexedHead 118
acceptance: protocol 2025-06-18, the last of 1 rounds while the device wrote 92 versions: listed 92 paths at head 174,
  read uid 214 exactly, found violet-otter, compared uid 1 to 214 (1 changes), vault head 265, index fresh, indexedHead 265
acceptance: the device wrote 256 more versions while the agent read, with no refusal
acceptance: the token's request budget answered 429 5 times, and each call succeeded after waiting
--- PASS: TestMCPAcceptanceExternal (5.26s)

1 MCP tokens on vault "default"
  NJvaaTzvoqKTbbAlbK908g  20d11f76  read   "acceptance"  expires 2026-12-22T10:24:54Z, used 56 times, last 2026-09-23T10:24:59Z
```

**Acceptance with Claude Code and the plugin (the rest of M4's done-when).**
Recorded 2026-09-23 at `07d0b49`, on Claude Code 2.1.280 and Obsidian 1.13.7,
against `trew serve -mcp -localhost` on the data directory the M2 acceptance
left, with a read token from `trew mcp-token -key-out`. Claude Code ran
headless with only this server's tools (`claude -p --mcp-config FILE
--strict-mcp-config --tools "" --allowedTools mcp__trew`, the config naming
the URL and an `Authorization: Bearer` header) and was asked to list with
three rows a page to the end, read a note, search, read one note's history,
compare its oldest and newest versions, read a note of instruction-shaped
text, read a note being edited and its history, and list again. Meanwhile the
plugin, in a paired vault, appended to one note every two seconds and renamed
another back and forth: 19 edits and 9 renames in the 56 seconds the session
took, the head moving from 26 to 40. Every call succeeded. Each paged listing
carried one head on all of its pages (26, then 40), with no path twice and
never both names of the renamed note. The comparison and the search matched
the versions written, and the instruction-shaped note came back with its text
under `untrusted_content` only, the notice under `security`, and nothing of
it under `trusted`; the agent reported it as data and did not act on it.

Every read was checked byte for byte against what the device wrote for the
uid it named, the list pages kept the head the first pinned while commits
landed, and the poisoned note in the corpus arrived under
`untrusted_content` with its imitation of the envelope defused. The server's
log for the run names uids, sizes and counts, and no path, token or note text.
A restart reopened the index from its durable state without a rebuild, and a
SIGINT stopped the server with exit status 0. `TestMCPAcceptanceAgainstServe`
runs the same in the test process on every `go test`.

### Agent operations: the commit boundary, the log and the pins (M5)

The store half of M5 tasks 1, 2, 3 and 10 (`internal/store/oplog.go`). The
tools that call it are later work; `cmd/trewd/audit_test.go` commits through it
directly in the meantime.

**The commit boundary.** `Store.CommitOperation(Operation) (OpResult, error)`
is the all-or-nothing write PLAN.md section 4.3 asks for, beside a device's
deliberately partial `AppendMany`, which is unchanged. A tool prepares outside
every lock (bodies stored through `chunks.Writer` and `Close`), and then, inside
`server.UnderCommitLock`, calls it and broadcasts `OpResult.Committed()`.
Under the store's `writeMu`, in one transaction begun `IMMEDIATE`, it rechecks
the credential as it stands (the token row, its hash, write scope, expiry, and
its author still named as the request was prepared), the epoch, the
idempotency key, a preview's snapshot head, and every check, base and
prevBase, and writes each entry through `writeEntry`, the function a device
put runs, so the path and collision rules meet an operation's entries in order
exactly as they meet a device batch's. Any refusal or failure rolls back every
entry, row and uid. An `Operation` with `Checks` and no `Entries` is a noop: it
revalidates at the same boundary and is recorded with outcome `noop`, so its
key names one outcome. `Render` is called before the lock with every uid at
2^53-1 and inside the transaction with the real ones, and both are held to
`MaxResult`, so an oversized reply is refused before anything is written; the
second is recorded and returned.

**Errors.** Every error is an `*OpError` with a `Code` from plan/mcp-tools.md
(`stale`, `exists`, `plan_changed`, `read_only`, `badpath`, `duplicate_path`,
`result_too_large`, `internal`, plus `collision`, which PLAN.md section 4.1
gives MCP creates and moves, and `key_reused`, which section 4.8 asks for and
the list lacks), the `Path` and `CurrentUID` to read again from, the operation's
id, and an `Outcome`: `OpRefused` (a precondition said no, nothing written),
`OpFailed` (a statement failed and the transaction rolled back, nothing
written) or `OpUnknown` (the `COMMIT` itself failed, which SQLite may have made
durable anyway). `errors.Is(err, store.ErrRefused)` and
`errors.Is(err, store.ErrOutcomeUnknown)` test the outcome, and the causes are
sentinels too (`ErrStale`, `ErrExists`, `ErrPlanChanged`,
`ErrActorCannotWrite`, `ErrEpochChanged`, `ErrKeyReused`,
`ErrReplayFromEarlierEpoch`, `ErrResultTooLarge`, `ErrDuplicatePath`,
`ErrCollision`). An unknown outcome is resolved by `LookupOperation` with the
error's `OpID`, or by `Replay` with the key.

**The log.** Schema 2 adds `operations` (the actor's id and label copied in,
tool, request digest, key, epoch, outcome, a preview's snapshot head, the
client's name and version capped and stripped of control characters, the
reply, and `committed_at` on the server's clock, never earlier than the
vault's previous operation), `op_entries` (every path changed, with its uid
before and the uid that changed it; a move is a `write` row and a `source`
row), `op_pins` and `op_keys`. No bearer token, token hash or note body is
stored, which a test checks column by column. Revoking a token deletes its
token and author rows and none of this. `trewd audit` reads it, through the
control socket while `serve` runs. The version is 2 and not just new tables
because the build before would open such a store and purge every pinned
before-image it cannot see; at version 2 it refuses the store instead.

**Idempotency.** `(actor_id, idempotency_key)` names the operation that used
it, whose `request_digest` is the comparison. `Replay` is asked before a retry
is prepared again (preparing reads the heads the first attempt moved), and
`CommitOperation` asks again inside its transaction for the retry that races
the original: the same digest returns the recorded reply and writes nothing, a
different one is `key_reused`. A key lasts as long as its reply. After that
the request is new and meets the bases its first commit moved, so an edit or
an append replayed late is refused as `stale` rather than applied twice. A key
whose operation was recorded before a restore is refused, `stale` with
`ErrReplayFromEarlierEpoch`, and never replayed: its reply names uids of the
old history, which the restored store may issue again to other versions.

**Retention.** Three policies. Ordinary history is purge's own: heads and
rename records kept, the rest dropped when the operator runs it, bodies spared
by `-grace`. Before-image pins (`Retention.PinFor`) hold every version an
operation displaced, where the path held something, against purge for 30 days
after the operation's commit by default, which is also the floor; a longer
window may be set with `SetRetention`. Replies and their keys
(`Retention.ResultFor`) are kept 7 days by default, floor 1 hour: long enough
for any retry, a resumed session and a weekend. Both expiries are fixed on the
row at commit, so changing a window never shortens a promise already made.
Purge's survivor set is heads, rename records and unexpired pins, joined to the
entries, and `Reclaimable` reads the same query with the same clock reading;
both report `Pinned`/`VersionsPinned` separately. When a pin expires its
version is ordinary history and the next purge drops it and the pin row; the
operation and its paths stay, so the audit still names what was displaced.
Expired replies are cleared and expired keys deleted by the same purge.
`Store.SetClock` injects the clock the commit, the expiry checks and purge
read.

**Backup and restore.** `VACUUM INTO` carries all four tables; the report
counts them. `verify` decodes the log on every pass, since a backup checks its
own snapshot with a shallow one, and an unexpired pin whose version is gone is
a `lostpin` fault. A restore serves the backup's new epoch, so its recorded
keys do not replay; its pins hold in its own purges.
`TestAYearOldNoteEditedTodaySurvivesAnImmediatePurgeAndARestart` and
`TestTheBeforeImageSurvivesABackupAndARestore` are the M5 task 10 tests; with
the pin union taken out of the survivor set, those and two more fail.

### The MCP write side's note functions (M5)

M5 tasks 4 to 6 need the bytes each mutation writes before the store can
commit them. Those are pure functions in `internal/notes`, ported from
`client/src/node/mcp-notes.ts`, `mcp-markdown.ts`, `mcp-operations.ts` and
`mcp-batch.ts`; `mcp-links.ts` was ported whole in M4 (`ChangeLinks`), and the
plans use it as it is.

**What the tools call.** `EditNote`, `AppendNote` and `PrependNote` take a
version's bytes and return a `Revision` (the new bytes, and `Noop` when they
are the old ones); `NoteContent` checks `create_note`'s content. `ChangeTags`
returns the exact source edits of a tag change to one note. `PlanTags`,
`PlanMove` and `PlanDelete` read the vault through a `View` (every live file
at one head, and a version's bytes and uid by path) and return a `Plan`: its
`PlannedChange`s, sorted by path, each with the uid it was planned against as
its `base` and edits in UTF-16 offsets, the count of ambiguous links, and
`Writes`, the bytes each change commits. An apply holds the changes passed
back to `PlanTooLarge`, plans again at the current head, and refuses with
`plan_changed` unless `SamePlan` holds (`PlanDigest` is the same comparison as
a hash). Every refusal is a `*notes.Refusal` carrying a plan/mcp-tools.md code,
and a plan's names the note it concerns in `Path`, which can be a path the
plan found in the vault rather than one the caller named.

**The oracle.** `mcp-oracle.run.ts` records what the TypeScript does in four
more sections of `mcp-fixtures.json`: `edits` (`prepareNote` over a note in a
scratch vault), `changeTags` (fifteen changes over every note of the read
side's corpus, the content changes only for generated Markdown and one of each
kind for generated anchors, plus inputs refused before a note is read),
`plans` (`previewOperation` over seven scratch vaults, among them 523 notes for
the scan's count and nine of a million bytes for its size) and `samePlan`
(each small preview against altered copies of itself). `oracle_write_test.go`
holds the port to every vector and `oracle_corrupt_test.go` proves each check
rejects a damaged one. A generator of tags properties (block lists with
comments, blank and empty items at each place, flow lists over lines, block
scalars with header comments, empty values with properties) was added for the
edit, which rewrites the value's source range; with `ORACLE_EXTRA=12000` the
port matched about 250,000 vectors, and the only difference was the one M4
recorded, an implicit key over lines in a flow mapping.

**What the write side found on the read side.** The edit reads the note it
produced again, so it holds the frontmatter reader to more text than M4's
corpus did. Three differences from npm yaml were fixed: a later YAML document,
which npm yaml ignores and libyaml's scanner reads into (`firstDocument`); lines
that start with a tab, where npm yaml refuses a quoted scalar's or a flow
collection's and reads a comment line's, and libyaml does the reverse
(`scanYAML`); and a comment against the token before it (`'x'# c`, `[x]# c`),
which npm yaml refuses and libyaml reads. One is recorded as refused rather
than modelled: a document after a directive, which npm yaml read by the schema
the directive names (`%YAML 1.1` makes `yes` a boolean) and the port refuses
(`TestFrontmatterKnownDivergence`).

**Decisions.**

- An exact edit whose result is over 1 MiB is `note_too_large`, as
  plan/mcp-tools.md says; Basalt said `input_too_large`. The oracle check
  accepts the spec's code for those vectors only.
- A plan's size is measured as Basalt measured it, `JSON.stringify` of the
  changes against 64 KiB, but with the base a uid, so the same plan is smaller
  here than it was.
- More than 32 changes, or 32 paths once a move's destination is counted, is
  `batch_too_large`; a change of more than 4,096 edits is `plan_too_large`.
  Basalt's schema refused both before the operation ran.
- A move onto its own path is `same_destination`. A case-only rename is a
  move, as the store allows (`f5ce1c7`); Basalt refused one on a case-folding
  disk. A destination that a case-folding disk would hold as another live file
  is `exists` at the plan, and the store's collision rule, which sees folders
  too, still decides at the commit.
- A folder scope is a path prefix, as `list_notes` and `search_notes` take
  one; Basalt required the folder to exist on disk.
- Paths sort in byte order, as M4's listings do.
- A move, and a deletion with `markBroken`, read every editable note of the
  vault, as Basalt did, so either is `scan_incomplete` in a vault of more than
  512 notes or 8 MiB of them. A link index could narrow the scan later;
  nothing here assumes one.
- The names the server reserves (`.trew-tmp-`, the conflict-copy pattern) are
  the tools' to refuse, for `create_note` and a move's destination alike.

**Where the TypeScript cases went.** The suites stay in the tree as the
oracle (PLAN.md section 2.1). Their cases about the bytes a mutation writes
are Go table tests; the ones about a filesystem before-image, a replace, a
flush and the races around them become store guarantees, because on the
server a base is a version uid, a before-image is the pinned previous version
and a write is one `CommitOperation`.

| Suite | In `internal/notes` | For the store and the tools |
|---|---|---|
| `mcp-notes.test.ts` | BOM prepend, two edits together, removed prose, every edit refusal, overlapping occurrences, the aggregate budget, no invented newline, invalid source, suffix and size, noop, create content (`port_notes_test.go`) | stale bases, the lost reply, a missing target, every backup, race, publication and reserved-name case |
| `mcp-markdown.test.ts` | every case, reading (`port_markdown_test.go`) and writing (`port_tagedit_test.go`) | |
| `mcp-links.test.ts` | every case (`port_links_test.go`, M4) | |
| `mcp-operations.test.ts` | tag plans and their writes, changed plans, move rewrites, editable notes only, spoiled edits, occupied and refused destinations, undecodable notes, path bounds before reading (`port_operations_test.go`) | the backlink that fails after the destination exists, a destination occupied during the commit, `createDirectory` |
| `mcp-batch.test.ts` | a named note with no edits stays in the plan, so its base is rechecked | deletion before-images, racing saves, every batch backup and partial-publication case: one `CommitOperation` is all or nothing |

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

