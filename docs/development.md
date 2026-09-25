# Develop TrewSync

[Documentation](index.md)

This section is for contributors and reviewers. For installation and everyday
use, start with the [server](server.md), [plugin](plugin.md), [agent](agent.md)
or [CLI](client.md) guide. [CONTRIBUTING.md](../CONTRIBUTING.md) says what a
change needs, and [SECURITY.md](../SECURITY.md) how to report a vulnerability.

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

The server's `/mcp` is the only MCP. Its tests are Go, in `internal/mcp`,
`internal/notes` and `cmd/trewd`, and the stress suites drive it through the
built binary; [The MCP endpoint (M4)](#the-mcp-endpoint-m4) and the sections
after it describe them.

```bash
go test ./internal/notes/ ./internal/mcp/
go test -run 'TestAProductionBuildHasNoTestSeam|TestAKillAround|TestAWriteThatLoses|TestAStorageError|TestSIGTERMLetsAnAdmittedMCPWriteFinish' ./cmd/trewd/
cd client && bunx vitest run --config vitest.stress.config.ts src/stress/mcp-crash.stress.ts src/stress/mcp-races.stress.ts
```

**The oracle.** The headless client's own MCP server, `trew mcp` and `trew
mcp-token`, is retired ([Retiring `trew mcp`](#retiring-trew-mcp-m2-task-10)).
What stays of it in TypeScript is the oracle the Go port was held to (PLAN.md
section 2.1): the pure note functions in `client/src/node/mcp-read.ts`,
`mcp-inspect.ts`, `mcp-history.ts`, `mcp-markdown.ts`, `mcp-links.ts`,
`mcp-notes.ts`, `mcp-operations.ts` and `mcp-batch.ts`, their unit tests, and
`mcp-oracle.run.ts`, which feeds a corpus through them and writes
`mcp-fixtures.json` and `internal/notes/emoji_table.go`. They are test-only:
neither `bin.ts` nor the plugin's `main.ts` reaches them, so neither bundle
carries them, and `client/package.json` ships only `dist/trew.mjs`.
`client/src/node/artifact.test.ts` requires the refusal codes only they hold
to be absent from both production bundles, and present in the same sources
bundled alone, so the check cannot pass by matching nothing. A change to one
of them, or to the runtime, must leave the fixtures byte for byte:

```bash
cd client && bun run src/node/mcp-oracle.run.ts && cd .. && git diff --exit-code mcp-fixtures.json internal/notes/emoji_table.go
```

**The shipped client.** `artifact.test.ts` runs the release's own build
configuration in a staging copy, copies `trew.mjs` alone into an empty
directory with its build inputs deleted, and runs it under `sandbox-exec` with
the repository denied on macOS: it pairs from the first invite, uploads a note
with a byte-order mark, frontmatter, CRLF and LF, mints an invite for a second
device that receives exactly those bytes, and downloads that device's edit.
`scripts/pack-check.sh` runs the same on the file the npm tarball installs,
under plain `node`, and refuses a packed CLI that still answers `trew mcp`.
Recorded 2026-09-24 on an Apple M4 Pro: `trew.mjs` is 263,627 bytes and the
plugin 328,355; with the MCP server and its SDK in it, `trew.mjs` was 1,088,247
bytes when last measured, on 2026-09-15.

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

### Submitting to the community directory

The plugin is installed by hand until it is listed. The directory no longer
takes pull requests to `obsidianmd/obsidian-releases` (that repository is now a
mirror the directory's bot updates); a plugin is added at
[community.obsidian.md](https://community.obsidian.md), and the directory
reviews it automatically from the repository (plan/research/obsyncian.md,
section 5). This is the flow, written from that investigation and not yet
walked for TrewSync:

1. **Settle what is permanent.** The id `trew-sync` cannot change once listed,
   and the display name TrewSync is what the directory's fuzzy trademark check
   reads. `manifest.json`'s `id`, `name` and `description` must not contain
   "obsidian" or "plugin"; the description must be 10 to 250 characters, start
   with a capital, end with a period, and use only letters, digits, spaces and
   `.,!?'"-`. The current description passes.
2. **Make the manifest and the release agree.** The directory reads
   `manifest.json` at the head of the default branch and installs from the
   GitHub release whose tag is exactly its `version`, with no `v`, carrying
   `main.js`, `manifest.json` and `styles.css`. A manifest version with no such
   release gets a plugin de-listed, which is what happened to Obsyncian; so
   bump `manifest.json` and `versions.json` only in the commit that is
   released, and publish the release before the bump reaches the default
   branch. `versions.json` maps each plugin version to its `minAppVersion`.
3. **Pass the review locally.** `bun run lint` is the directory's own
   `recommended` config ([above](#the-community-directory-review)), and fails
   on any error. An error makes that release uninstallable; warnings pass,
   and each accepted one has its reason in the ledger.
4. **Keep the README's [Disclosures](../README.md#disclosures) current.** The
   developer policies require disclosing payment, accounts, network use,
   access to files outside the vault, ads, server-side telemetry and closed
   source. Ours says there is none of those but network use, which is only the
   server the user pairs with, and says in the same block that the server
   stores notes in plaintext and that the MCP endpoint exposes them to an
   agent's model provider. Client-side telemetry and a plugin that updates
   itself are forbidden outright, and TrewSync has neither.
5. **Submit.** Sign in at community.obsidian.md, link the GitHub account that
   owns the repository, and add the plugin by repository. Read the automated
   review's findings for the first release before announcing it.
6. **Every release is reviewed again.** A later release can be refused for an
   error a new version of the rules finds, so the lint pin moves deliberately.

What is not settled: whether the directory's review reads the repository at
the tag or at the default branch for anything beyond `manifest.json`, and what
a human reviewer asks about the adapter-level preserving writes. Record both
here when the first submission answers them.

## The docs site

The documentation is Markdown in this repository, readable on GitHub as it is.
`scripts/docs-site` turns it into a small static site that versions with the
code, because it is built from the same checkout:

```bash
go run ./scripts/docs-site -out /tmp/trew-docs
```

It renders `README.md` (as the site's front page), `CHANGELOG.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `llm.md` and every page under `docs/` with
goldmark, the Markdown parser the server already depends on, so the site adds
no dependency. Links between pages are rewritten from `.md` to `.html`, and
`docs/assets` is copied beside them, so the screenshots load. A link to a
file the site does not publish, such as `compose.yaml` or `plan/`, goes to the
file on GitHub at the same ref (`-ref`, `main` by default). The pages are
plain HTML with one small stylesheet that follows the system's light or dark
setting.

`go test ./scripts/docs-site` builds the site into a temporary directory and
fails on any relative link, image included, that points at a file which does
not exist, in the Markdown and in the built site alike. It runs in
`scripts/check.sh` with the rest of `go test ./...`, so a moved screenshot or
a renamed page fails the gate.

**Publishing, not done yet.** The site would be published from the same tag
as the server binary, by a job in `release.yml` that runs after the image is
promoted: build with `-ref` set to the tag, upload the directory with
`actions/upload-pages-artifact`, and deploy it with `actions/deploy-pages` to
GitHub Pages, each action pinned to a commit as `scripts/actions-pinned.sh`
requires. Until that job exists, the Markdown on GitHub is the documentation.

## Performance work

From `client/`, use `bun run bench`, `bun run bench:sync`, `bun run scale`, and
`bun run dedup`. `bun run bench:10k` is the end-to-end run at ten thousand
realistic notes (`src/stress/corpus.ts`) against a real `trewd serve -mcp`,
with `BENCH_OBSIDIAN=1` adding the plugin in a new scratch vault, and
`bun run bench:phone` is the same on the Android phone over adb, `--dry-run`
for everything but the phone. Both check exact bytes on every device and fail
on a lost edit; [research.md](research.md#ten-thousand-notes-on-a-mac-september-24-2026)
has the results. Run CPU-sensitive measurements under both Bun and stock Node
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

Nothing described below has been published: there is no GitHub repository for
TrewSync yet. Everything is configured and checked locally and in CI; the first
real release is the first run of the publishing half.

### What each release carries

| Release | Tag | Assets | Built by | Installed by |
|---|---|---|---|---|
| Plugin | `X.Y.Z` | `main.js`, `manifest.json`, `styles.css`, `SHA256SUMS` | `bun run build`, rebuilt and attested by `attest.yml` | Obsidian, from the community directory |
| Server | `server/vX.Y.Z` | `trewd-<os>-<arch>` for seven platforms, `SHA256SUMS`, `packslip.server.sigstore.json`; the container image | goreleaser through `scripts/build-server.sh`, rebuilt, attested and signed by `attest.yml`; the image by `release.yml` | hand, `trewd update`, Homebrew, mise, Nix, Docker |
| Headless client | `cli/vX.Y.Z` | the `trew-sync` npm package | `npm-publish.yml` | npm |

**The plugin version step.** `scripts/release.sh --prepare X.Y.Z` sets the
plugin's version in `manifest.json` and adds its `versions.json` entry, in one
step committed before the tag, and refuses a version that is not greater than
every entry `versions.json` already names (Obsyncian and Pumice, in
[plan/research](../plan/research/README.md)). Obsidian offers the newest entry
an install can run, so a lower entry is never offered, and an equal one is a
second release under a version already served. `attest.yml` checks again, at
the tag, that the manifest and `versions.json` agree.
`scripts/release-prepare.test.sh` holds the cases.

**The server binaries.** [.goreleaser.yml](../.goreleaser.yml) builds
Linux amd64, arm64 and riscv64, macOS amd64 and arm64, and FreeBSD amd64 and
arm64: every platform trewd compiles for with CGO off and 64-bit integers.
Refused, with the reason in the config: Windows (the data-directory lock is
flock(2)), 32-bit targets (the note functions use integers past 2^31), and
OpenBSD and NetBSD (free-space reporting reads a statfs field they spell
differently). The Linux binaries are started in the release workflow, arm64
and riscv64 under QEMU; the macOS and FreeBSD ones are built and never started
by CI. goreleaser always runs as a snapshot, with the version from the tag in
`TREWD_VERSION`, because it parses one tag line as semver and cannot read
`server/vX.Y.Z` without its paid monorepo feature. Its output is byte-identical
to `go build -trimpath -ldflags "-s -w -X main.version=V"`, which
`scripts/goreleaser-check.sh` asserts. goreleaser and packslip are fetched at
versions pinned by digest in `scripts/release-tools.sh`.

`go install ...@server/vX.Y.Z` does not resolve: the module is at the
repository root, so Go looks for `vX.Y.Z` tags, which no release line makes.
The `server/` prefix came from Basalt, whose module lived in `server/`.

### The signed manifest, and `trewd update`

A server release carries `packslip.server.sigstore.json`, a
[packslip](https://packslip.dev) manifest: a Sigstore bundle holding a signed
statement of every binary's name, digest, size, platform and executable path.
`attest.yml` signs it with `jdx/packslip` after goreleaser has built and
`attest-build-provenance` has attested the binaries, and before the draft is
published, so a release that cannot be signed stays a draft. It is keyless:
signed with that workflow's own GitHub identity, so there is no key to keep.

- **Project** `github.com/waynehoover/trew/server`. A subpath, because the
  plugin releases from the same repository; `server`, because packslip reads a
  version out of a tag whose prefix is the tool's subpath followed by `/`, so
  `server/v0.2.0` names 0.2.0. The bundle's file name follows from it.
- **Only trewd.** The plugin is installed by Obsidian from the directory and
  the client by npm, neither of which reads packslip, so signing them would add
  an assertion nobody checks. Their provenance is the GitHub attestation and
  npm's own.
- **Linux artifacts say `libc: gnu`.** packslip infers it for every Linux
  artifact and has no way to say "none" short of declaring the file portable.
  The binaries are static (`requires.libs` is empty), so they run on musl too;
  a consumer on a musl host that takes the manifest literally may not select
  them.

`trewd update` reads the releases endpoint, takes the newest non-draft,
non-prerelease `server/v` release (or the one `-version` names), downloads this
platform's binary, `SHA256SUMS` and the manifest beside the installed binary,
and installs nothing until: `packslip verify` accepts the manifest against the
pin `--identity-prefix https://github.com/waynehoover/trew/.github/workflows/attest.yml@refs/tags/server/v`
and `--issuer https://token.actions.githubusercontent.com`, with the binary as
`--artifact`; its report names that scheme, that issuer, and exactly the signer
`...attest.yml@refs/tags/server/vX.Y.Z` for the version offered; the signed
statement, read by trewd itself, is for this project and this version and signs
this file's digest and size; `SHA256SUMS` agrees; and the new binary runs and
says it is that version for this platform. Then one rename and a directory
flush. It refuses a downgrade, a development build, a binary Homebrew, Nix or
mise owns, and a container (Docker's `/.dockerenv`, Podman's
`/run/.containerenv`, or Kubernetes' `KUBERNETES_SERVICE_HOST` or
`/var/run/secrets/kubernetes.io`). The pin is the workflow and the tag it ran
from, not only the repository: a bundle another workflow of the repository
signed is not a release, and neither is one `attest.yml` signed when it was
dispatched from a branch. `attest.yml` runs on `workflow_dispatch`, which runs
the workflow file of whatever ref the dispatch names, so without the tag in the
pin anyone able to push a branch could sign an installable bundle with an
edited copy. The release is therefore dispatched from its own tag,
`gh workflow run attest.yml --ref server/vX.Y.Z -f tag=server/vX.Y.Z`, as
`release.sh` prints it (the plugin's the same way, `--ref X.Y.Z -f tag=X.Y.Z`).
The workflow's first step refuses any run whose `GITHUB_REF` is not
`refs/tags/` followed by the tag it was given, before anything is checked out,
so a dispatch from `main` fails at once rather than signing a manifest no
`trewd update` installs; run it again with the `--ref`.

What is left to trust is who can push a tag. Once the repository exists on
GitHub, protect the `server/v*` pattern (and the plugin's bare `*.*.*` tags)
with a tag ruleset: restrict creation, update and deletion to the maintainers,
and block force pushes, so a tag cannot be moved to a commit CI never saw or
created by anyone who can push a branch. Until the ruleset is in place, anyone
with push access can make a tag and a release from it.

It runs the packslip CLI rather than verifying Sigstore itself; the measured
reason is in [research](research.md#evaluated-alternatives). The tests: the Go
unit tests in `cmd/trewd/update_test.go` run the whole command against a feed
served from memory with a fake packslip, one case per refusal, each asserting
the installed binary is byte-identical afterwards with nothing left beside it.
`scripts/packslip-check.sh` then does it for real: it builds a goreleaser
snapshot, signs it with `packslip keygen` and `packslip create --no-log`,
checks the statement's shape and `packslip verify --allow-unlogged` on every
binary, serves the signed feed on 127.0.0.1, and runs a trewd built with the
`updatetest` tag (`cmd/trewd/update_testpin.go`, which swaps the pin for that
key and nothing else) against it, tampered and untampered; a release build
refuses the same feed because a key is not the workflow. The keyless path
itself, Fulcio and Rekor, cannot be exercised without publishing and is
first checked by `scripts/verify-release.sh --server` on the first release.

### Homebrew, mise, Nix and Docker

- **Homebrew.** [packaging/homebrew/trewd.rb](../packaging/homebrew/trewd.rb)
  is the formula for the tap `github.com/waynehoover/homebrew-tap`, where it
  goes as `Formula/trewd.rb` so that `brew install waynehoover/tap/trewd`
  works. It installs the release's bare binaries for macOS and Linux, arm64 and
  amd64, and declares a `brew services` service on 127.0.0.1:3003 without MCP.
  `scripts/homebrew-formula.sh VERSION SHA256SUMS` renders it from the
  published sums and refuses sums that miss a platform;
  `scripts/homebrew-formula.test.sh` evaluates the result against a stand-in
  for Homebrew's DSL. The tap repository does not exist yet. `brew style`
  passes on the file; `brew audit`, which needs a tap, has not been run.
- **mise.** `mise use -g packslip:github.com/waynehoover/trew/server` installs
  trewd from the signed manifest, verified against the repository's identity.
- **Nix.** [flake.nix](../flake.nix) builds trewd from source with the release
  flags, version `unstable-<rev>`, over only `go.mod`, `go.sum`, `cmd/` and
  `internal/`; [flake.lock](../flake.lock) pins nixpkgs. `vendorHash` changes
  whenever `go.sum` does, and `scripts/flake-check.sh` prints the new one. It
  runs nix if installed and otherwise nix in a container (store in the
  `trew-nix-store` volume).
- **Docker.** `compose.yaml` builds the image from the checkout until the first
  server release, because the only image it could name was Basalt's, which has
  `/trew` inside rather than `/trewd`. `scripts/pin-compose.sh` replaces the
  local build with the published image by tag and digest, and
  `scripts/pin-check.sh` fails from the first server tag's next commit until it
  has. The compose command adds `-mcp`; the image's default command does not.

Every GitHub release must include a short user-facing changelog: what is new
or fixed since that component's previous release, upgrade steps, and known
issues. Include CLI changes in the plugin notes when they ship together.
Publish the notes with `--notes-file` and read the release body back to verify
it. [CHANGELOG.md](../CHANGELOG.md) collects the same notes for all three
components in one place: add a line under **Unreleased** with a user-visible
change, and at a release move those lines under the release's heading and use
them as its notes.

To check an asset's build provenance:

```bash
gh attestation verify main.js --repo waynehoover/trew
```

An attestation identifies the build source. It is not a security audit or proof
that the application is defect-free.

The current server speaks protocols 1 and 2, TrewSync's own, and its clients
speak 2; Basalt's releases speak protocol 7, and Basalt and TrewSync refuse
each other at hello, naming both numbers. Build
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
  copy android-a1c2 202609230941).md`, identical on both devices. That copy
  carried the name of the phone, which made it; since the owner's decision the
  same day a copy is named after the author of what it holds, so it would now
  carry the Mac's device name: `From the Mac (Conflicted copy Mac
  202609230941).md` for a Mac called Mac.
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
`CommitOperation` runs inside). That path is a build check, not a
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
renamed `search.db.broken` and made again, and if even that fails the server
runs with no index and search scans: a derived file is never the reason the
server does not start. Every `serve` opens the index, not only one under
`-mcp`, and hands it to device searches (`Server.SetSearchIndex`) and to the
endpoint; it is opened after the port is bound, because opening an existing
index checks it against the store (0.74 s over 10,000 notes, proportional to
them) and a reconnecting device should queue rather than be refused. Search matches Basalt's scan over every query of the
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
write tools call it (below, "The MCP write tools"); `cmd/trewd/audit_test.go`
also commits through it directly.

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
  512 notes or 8 MiB of them, unless the View is a `LinkIndex` that rules
  notes out (added with the tools; see "The MCP write tools").
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

### The MCP write tools (M5)

M5 tasks 5, 6, 8 and 11 (`internal/mcp/write.go`, `mutations.go`): the twelve
mutation tools of plan/mcp-tools.md for write-scope tokens, and
`lookup_operation`, a read tool. The contract decisions (the epoch argument,
the request digest, the result shapes, the unknown outcome, the apply's
`head`) are recorded in plan/mcp-tools.md, "Decided in M5" and "As built";
this is how the code keeps them.

**One way to write.** Every tool reads its arguments strictly, then
`call.begin` checks the epoch the call's uids belong to and answers a used
idempotency key from `Store.Replay` before anything is prepared. The tool
reads the heads, computes the bytes with `internal/notes`, chunks them with
the Go chunker exactly as a device would, and stores them with
`chunks.Store.PutAll`, durable before anything names them. `mutation.submit`
then runs inside `call.commit`: `CommitOperation`, which rechecks the
credential, the epoch, the key, a preview's snapshot head and every base in
one transaction, then `server.Broadcast` of what committed, still under the
commit lock, then the reply the transaction recorded. `CommitOperation` and
`Broadcast` are reached nowhere else, which
`TestOnlyTheCommitBoundaryReachesAMutation` now requires as well as checks.
Previews commit nothing and go through none of it but `begin`.

**Seams for the crash matrix (task 9).** `Config.Seam` is called at
`SeamUploading` (the first of several bodies durable, the rest not written),
`SeamBodies` (bodies durable, before the commit lock), `SeamCommitted`
(inside the lock, committed, not yet broadcast) and `SeamBroadcast` (after
the lock, before the reply); `TestAWritesSeamsComeInOrderAroundItsCommit`
holds the order. Nil in production. The crash build of trewd binds it to a
hold the test kills the server at (below); the idempotency key and
`lookup_operation` are what resolve the kill after the commit.

**The link index (task 6).** Beside `note_tags` in each search-index
generation, `gN_links (note_id, key)` holds every note's link keys, from
`notes.LinkKeys`, which takes them from the lookups `LinkResolver.Resolve`
itself makes (`linkLookups`, now the one list of them), folded as every plan
folds. A note with a link that could resolve to a path always shares one of
`notes.TargetKeys(path)`. The worker keeps it outside the write path,
counts it in the generation's counters and the cheap check, verifies it in the
deep check, and records a note whose links it could not parse as a link
failure, which every plan reads. `IndexVersion` is 2, and an index without the
table is rebuilt. `Index.Backlinks(head, keys)` narrows only when the trusted
generation has indexed exactly `head`, checked in the read that takes the
keys; `Index.Await` lets the tool give the worker two seconds to get there.
Otherwise the plan reads every editable note, as Basalt did.
`notes.LinkIndex` is how a View rules a note out; the moved note and every
note read are read from the store. `TestTheLinkKeysNeverOmitABacklink` plans
every move and deletion of forty generated vaults with and without the
narrowing and requires the same plan; keying only the first lookup of a wiki
link fails its companion test.

**Authors (task 8).** Entries carry the token's label as their device, so
`note_history`, `trewd audit` and the batches a device receives name the agent,
and authors are never in the device list or delivery status. A device that
meets an agent's edit to text it changed offline keeps both, the agent's
bytes in a conflict copy named after the agent's label, as PLAN.md section 2.4
expected. That took the owner's decision of 2026-09-23 that a copy is named
after the author of the bytes it holds, for every conflict: the engine keeps
each version's recorded `device` in its remote state (`RemoteState.device`,
absent in older indexes, which fall back to the device's own name) and names
each copy after whoever wrote its bytes, this device for what was on its disk
(`Engine.copyAuthor`, `client/src/core/copy-author.test.ts` for every site,
and `client/src/node/agent-author.test.ts` against the real server and the
HTTP tools, labels with a slash and a colon and one over 32 characters
included).

**Tests.** `write_test.go` drives every tool through the go-sdk client and,
after each write, reads the displaced version by `previousUid` as its exact
former bytes, and again after a default purge; seventeen competing edits on
one base give one commit and sixteen `stale`; a token revoked after its bodies
are stored loses at the commit boundary with nothing committed; a device
connected during a write has the batch before the reply; a replay is the
recorded bytes; an unknown outcome, made by a deferred foreign key that fails
the `COMMIT`, is `committed: "unknown"` and never a refusal; writes past the
token's budget are 429 while a device keeps committing.
`write_epoch_test.go` binds the epoch across a backup and a restore that
reissues the agent's base uid to other bytes, and plans a move through the
link index and without it. `injection_write_test.go` is task 11: poisoned
text written through the tools is stored exactly and read back by the next
session only under `untrusted_content`, normalised.

### The crash matrix and the phone races (M5)

M5 tasks 9 and 12, and the done-when's "zero entries committed" and "exactly
one discoverable result on retry", against the built binary rather than the
handler in a test's process.

**The crash build.** `cmd/trewd/testseam.go` is compiled only with
`-tags crashmatrix`, which no release, image, `go install` or CI build step
passes; the crash tests build it for themselves. It binds `mcp.Config.Seam`
to a hold: with `TREW_TEST_SEAM` naming a seam (an unknown name exits 2
rather than hold nothing), every write that reaches it writes
`trewd test seam: holding at SEAM` to stderr and reads a line from stdin,
`go` to go on and anything else, the end of stdin included, to wait there
until the process is killed. The variable is read once, at startup, and
nothing a request carries reaches the hold. A production build has none of
it: `TestAProductionBuildHasNoTestSeam` builds trewd as a release does
(`-trimpath -ldflags "-s -w"`), finds neither the variable's name nor the
hold's line in the binary, and has a write with the variable set commit
straight through; the tagged build, given the same variable, holds the same
write, so the check is not looking at a binary that could never hold.

**In `go test`** (`cmd/trewd/crash_test.go`, a child process each):

- SIGKILL at `bodies`, `committed` and `broadcast` around an append, restart
  on the same directory, retry with the same key: absent and then committed
  by the retry before the commit, present and replayed as the same bytes
  after it; one operation holds the key, `lookup_operation` finds it,
  `verify -deep` is clean, a keyless retry is `stale`, and the line is in the
  note once.
- A write held at `bodies` while a device moves one of three tagged notes,
  creates the note a create in a new folder was for, adds a backlink, or adds
  a second note of the moved note's name, or while the operator revokes the
  token, then let go: refused (`plan_changed`, `exists`, `plan_changed`,
  `plan_changed`, 401), the vault's head the device's last write, the log
  empty, and a fresh preview applying over the device's bytes. Through the
  tools a preview's head is what refuses a batch first; the store's check of
  each slot is behind it, and the create is refused by that check itself.
  With the snapshot head check taken out of the store, the backlink and
  namespace cases commit and fail.
- The chunk store read-only, a trigger failing a pin inside the transaction,
  and a deferred foreign key failing the `COMMIT`, each under a tag batch of
  three notes: nothing committed, the last `committed: "unknown"` with an
  `opId` that `lookup_operation` does not find, and the same request with the
  same key committing once when the fault is gone.

**In the stress suite** (`bun run stress`, so in `scripts/check.sh` and CI):

`mcp-crash.stress.ts` is the matrix: `create_note` into a new folder,
`edit_note`, `append_note`, `move_note` with two backlinks into a new folder
and `add_tags` over three notes, at `bodies`, `committed` and `broadcast`,
and at `uploading` for every write of several bodies, among them a create of
300 KiB. A laptop writes the notes; the server is restarted armed; the
agent's keyed write is held and the server SIGKILLed with the request still
waiting. Restarted unarmed on the same directory: `verify -deep` passes; the
log holds one operation for the key or none, and its uids are the heads; a
freshly paired headless client downloads exactly the seed or exactly what the
write leaves, as the seam says; the retry with the same key is one result,
the same bytes each time, one operation, which `lookup_operation` finds; and
the witness, the laptop that was connected when the server died, and a
second fresh client then hold exactly what the write leaves. What a move or a
tag batch writes is worked out by the test from its preview's changes
(`applyPlan`), not read back from the server. With the key's replay taken
out of both `call.begin` and the store's transaction, all eighteen cases
fail.

`mcp-races.stress.ts` is the phone races: a laptop that stays connected, a
phone that goes offline, and the agent through the server's HTTP tools.
Disjoint edits and an append against a replacement merge; overlapping edits
keep the phone's text in place and the agent's in a conflict copy named
after the phone; the phone's deletion leaves the agent's edit, and the
agent's deletion leaves the phone's; the phone's rename keeps its edit at the
new name and the agent's at the old; an offline phone catches up with the
append the laptop already has; an agent edit prepared before the phone's is
refused `stale` with the phone's uid and applies once read again. The
laptop, the phone and a freshly paired third device hold exactly the expected
bytes, the log holds the one write, and its displaced version reads back
before and after a default purge.

```bash
go test -run 'TestAProductionBuildHasNoTestSeam|TestAKillAround|TestAWriteThatLoses|TestAStorageError' ./cmd/trewd/
cd client && bunx vitest run --config vitest.stress.config.ts src/stress/mcp-crash.stress.ts src/stress/mcp-races.stress.ts
```

A SIGKILL is not a power cut: the page cache survives it, so these prove the
ordering of bodies, commit, broadcast and reply, and the recovery of the
unknown outcome, not durability against losing power (M5.5).

### Undo (M5 task 7)

PLAN.md section 4.5: a compensating operation, never a rollback. Four ways
in, one store path.

**The store** (`internal/store/undo.go`). `PlanUndo` reads an operation's
paths from `op_entries`, each path's head now, the version the operation left
and the before-image it pinned, and builds the operation that puts them back,
outside the write lock. Every entry is based on the operation's output, so
`CommitOperation` refuses the whole undo if any path moved since, and the plan
names each such path, its head and the label that wrote it (`Changed`). The
in-place undo writes in five passes, each before the next: folders the
operation removed, checks of the folders the restores land in, notes put back
and moves reversed (one entry with `prev`, so a move and its backlinks come
back together), notes it created removed, and folders it created removed
deepest first when nothing is left in them (`EmptyFolder`, refused at the
commit as `not_empty` if one was filled meanwhile, before the server's own
rule for every folder deletion would answer `stale`). A restore into a folder
deleted since writes the note and no folder entry: a device makes the folder on
disk for the note it writes, as it did before. The copy writes each
before-image to `name (restored UID).md`, the plugin's name for a restore whose
path is taken, and touches nothing. Schema 3 added `before_state` to
`op_entries`, what a path held before the operation, since after a purge the
uid alone cannot say whether it held a note; `migrate3_test.go` keeps every
schema 2 row and sequence number through the rebuild.

**Who is the actor.** An undo is an operation like an agent's write, recorded
as `undo` or `undo_to_copy` with `undoes` naming its target, and an undo in
place marks its target undone (`undoneBy`), so a second undo of it is refused
and a redo (undoing the undo) is allowed. The operator is actor kind
`operator`, id `operator`, label `trewd undo`, with no device row, so it is in
no device list and no sync peer waits on it. A device's undo is kind `device`
under its own id and name, its credential rechecked under the commit lock. An
agent's is kind `mcp` under its token.

**Who may undo what.** The operator and any device may undo any operation of
the vault: the vault is one person's, and a device could write the same bytes
back by hand. An agent may undo only its own (`UndoRequest.OnlyActor`), and
another token's operation, a device's undo or the operator's is `not_found`
to it, so text in a note cannot talk an agent into undoing someone else's
work. `lookup_operation` matches kind as well as id for the same reason.

**The ways in.** `trewd undo` goes through the control socket, or the store
under the exclusive lock with no server running (`cmd/trewd/undo.go`).
Protocol 2's `undo` serves a device (`internal/server/undo.go`), broadcasting
the versions to every device, the asking one included, before the `undone`
reply; a session of protocol 1 is answered as protocol 1 was, with `undo` an
unknown op and history entries without `op`. `undo_operation` is the MCP tool
(`internal/mcp/undo.go`). The plugin's history panel offers "Undo this change"
on a version whose history entry names an operation; `Client.undo` settles
first, so an edit on this device not yet sent refuses the undo as `stale`
rather than being merged with it afterwards, and settles again so the undo's
versions are on disk when it returns.

**Tests.** `internal/store/undo_test.go`: each kind undone, a folder kept or
filled at the commit, a person's edit refusing the whole undo with nothing
written, a moved path refusing a move's undo, the copy and its second free
name, undo twice refused, an undo undone, a purged before-image `gone`, a
revoked device losing at the commit. `internal/mcp/undo_test.go`: every tool's
operation undone to the exact former bytes in the store and on a device paired
afterwards, the batch refusal and the copy, a retry replayed by its key, and
an agent kept to its own operations. `internal/server/undo_test.go` and
`cmd/trewd/undo_test.go` the wire and the command, and the protocol 1 session.
`client/src/plugin/history.test.ts` the panel against the real server with
`-mcp`: an agent's HTTP edit undone to its former bytes, a refusal and then
the copy, and an unsent local edit refusing the undo; each was seen failing
with the undo broken.

**Found on the way.** The full gate's race run failed the seventeen competing
edits in 30 of 40 runs: `edit_note`, `append_note` and `prepend_note` read a
note's head and then its entry, and a commit between the two reads made a
note that had moved on answer `not_found`. They read it once now, and
`TestEditsRacingACommitAreStaleNeverNotFound` holds every loser `stale`.

### Operational acceptance (M5.5)

PLAN.md M5.5: the maintainer can tell a healthy vault from a quiet failure,
recover from a failed server, and explain every agent mutation. The operator's
guide is [Operating TrewSync](operations.md); this is how it is built and
where each claim is tested.

**Restore to a uid** (`internal/store/restore.go`, `internal/server/restore.go`,
`cmd/trewd/restore.go`). `PlanRestore` merges two as-of listings, the vault
at N and now, by path, and plans one `CommitOperation` recorded as the
operator's `restore_to_uid`: file deletions for paths created since, folder
deletions deepest first (a folder something restored lands in is kept and
checked), folders put back shallowest first, then files put back, each entry
based on the head it replaces, the operation bound to the head it was planned
at. Paths holding the same bytes by another version are left alone. The dry
run prints the head; `-head H -apply` refuses a vault that has moved. Only the
operator may commit one (`validate` and `verify` both know the tool). A
purge takes history, so what a path held at N is exact only at or after the
vault's purge mark, or where no uid between the version it held then and N is
missing (uids are allocated inside the transaction that uses them, so a gap is
a purge); anything else refuses as `gone`, naming the path. The mark is
`purge_marks`, moved by every purge that removes history, and is why the
schema is 4: a schema 3 purge would not move it, and schema 3 would read the
operator's restore as a malformed undo. The migration marks a vault already
purged at its newest uid, the one mark that cannot be too low. Tests:
`internal/store/restore_test.go` (every kind of change undone, restore then
undo byte-identical, a moved head refused, only the operator, the purge gap
refused and the mark exact, the schema 4 migration),
`cmd/trewd/restore_test.go` (dry run, apply through the socket, the audit, the
undo), `client/src/core/restore-to-uid.test.ts` (a phone offline across the
restore converges with no conflict copy and keeps its own edit).

**Metrics** (`internal/metrics`, `internal/server/observe.go`). The commit
lock is a timed mutex, so lock wait and hold time are measured for every
taker. Session error frames count refused credentials, stale refusals and
`busy`; commit sites count commits and failures, with the run of consecutive
failures; the send queue and catch-up buffer count evictions; the MCP handler
counts 401s, 429s, its commits and its failures. No metric has a label
(`TestASnapshotCarriesNothingFromTheVault`). `Server.Delivery` adds when each
connection's applied checkpoint last moved, which is how "stopped advancing"
is told from "busy". The control socket's `status` carries these, the health
answer, the index status and the server's addresses to `doctor`.

**Doctor** (`internal/doctor`, `cmd/trewd/doctor.go`). Sixteen checks, in
`doctor.Checks` order, each a `Finding` with a status and, when not ok, a
remedy. It opens the store with `OpenForInspection` under the shared data
lock, reads `search.db` with `search.Inspect` (`mode=ro`), tells a hung server
from none by the server lock's holder and whether that pid is alive, and never
writes: `TestDoctorFindsNothingInASoundDirectoryAndChangesNothing` compares
every file byte for byte before and after, apart from lock files, SQLite's
shared-memory index and an empty write-ahead log. Seams: `Options.Storage`
(the mount table), `Options.Space` (free bytes), `Options.Now`, and a stand-in
control socket for what only a running server knows. The fault matrix,
`TestDoctorReportsEveryInjectedFault` and `TestDoctorReadsWhatARunningServerKnows`,
injects each fault into a sound directory and holds the check, the status, the
words, the remedy and the non-zero exit; `TestDoctorReportsARunningServerThatCannotTakeANote`
makes a real server's chunk tree read-only.

The records doctor reads are three files beside the database
(`doctor.WriteRecord`), written whole and renamed into place: `last-backup.json`
by every backup, good or failed, keeping when the last good one finished;
`last-rehearsal.json` by `trewd rehearse`; `runtime.json` by `serve`, the last
twenty starts and whether the last run returned (a killed or crashed run leaves
it saying otherwise). Advisory: a missing record is "nothing recorded", never a
fault in the notes.

**Ephemeral storage** (`internal/doctor/storage.go`, adapted from Syncidian,
MIT, credited in [research](research.md)). `serve` refuses an empty store, a
missing database or one with no version and no device, on a tmpfs or ramfs
anywhere or on a container's own overlay layer, unless `-allow-ephemeral`;
serves a store that already holds notes there and logs an error on every
start. Test servers pass `-allow-ephemeral` (the client's `TestServer`, the
crash matrix, the rehearsal), and `cmd/trewd`'s `TestMain` stands the mount
table in with a persistent one, because a developer's `/tmp` can be a tmpfs.

**Alerts** (`cmd/trewd/alerts.go`). Every `-alert-every` (5 minutes) the
server runs `doctor` on itself in `Quick` mode (no walk of every entry, 32
sampled bodies) and logs findings of nine checks as `msg=alert`, `alert
changed`, `alert still standing` (daily) and `alert cleared`. The checks about
set-up, the origin and the rehearsal are left to `doctor`. `TestAnAlertIsLoggedOnceUntilItChangesOrClears`,
`TestAServerLogsAnAlertWithItsRemedy`.

**Encrypted backups** (`internal/archive`, `cmd/trewd/encrypted.go`).
`filippo.io/age` v1.3.2 (BSD-3-Clause), the one new dependency, with
`filippo.io/hpke` and `golang.org/x/crypto` beneath it; tidy adds nothing
else. `trewd backup -encrypt-to` runs the ordinary verified `Store.Backup`
into `<data>/backup-staging` (the store allows a child of the data directory;
the command refuses it for plaintext backups) and packs it: a tar of
`MANIFEST.json`, every body the snapshot references (read through `Get`, so a
rotted body stops the pack), `backup.json` and the database last, streamed
through age to a temporary file beside the destination, synced and renamed.
`Unpack` refuses a non-empty destination, any entry that is not a regular file
at a body's own place (`chunks/<64 hex>/<2>/<name>`) hashing to its name, a
body count or database digest that is not the manifest's, and writes the
database under a temporary name renamed only once it is the manifest's, so an
unpack that stops has made no data directory. Tests:
`internal/archive/archive_test.go` (the round trip and no plaintext in the
archive, the wrong key, a flipped byte, a truncation, escaping and misnamed
entries, a failed pack leaving the last archive), `cmd/trewd/encrypted_test.go`.
The default key is post-quantum (`age.GenerateHybridIdentity`).

**The rehearsal** (`cmd/trewd/rehearse.go`). Its own work directory inside the
data directory, refused if it exists, removed afterwards; unpack or copy;
`Verify(true)`; `backup.json` against the store; every live version up to the
backup's newest compared with `sameVersion`; an in-process server on
`127.0.0.1:0` serving the restore; a device that redeems a fresh invite over
the wire, follows the backlog from 0, fetches every live note's bodies and
checks each chunk and each note's SHA-256 against the store; the search index
built in the work directory and awaited to the head. `TestRestoreRehearsal`
(`-tags rehearsal`, its own CI job) now takes the encrypted path with a rename,
a recoverable deletion and an agent's pinned edit in the vault, runs `trewd
rehearse`, reads doctor's verdict on it, and then does the restore by hand.

**Faults beyond SIGKILL.** Each is injected deterministically; each has its
recovery run and the bytes read back; `doctor` reports each one it can see.

| Fault | How it is injected | What happens, and the recovery | Tests | What doctor says |
|---|---|---|---|---|
| Disk full while a body is stored | `chunks.Store.FaultForTest`, `Write` returning ENOSPC | `nospace`, retryable, the session ends, nothing committed; the reconnecting device's retry commits the same bytes | `TestADiskFullWhileStoringABodyIsNospaceAndCommitsNothing` | `space` fail below 64 MiB, warn below 1 GiB; a running server's `disk-full` under `server` |
| The database cannot grow | SQLite at its page limit (store); SQLITE_FULL through `beforeAppend` (server) | `nospace` (`store.IsDiskFull`), a counted commit failure, nothing committed, not even an operation's row; the retry commits | `TestADatabaseThatCannotGrowCommitsNothing`, `TestADatabaseThatCannotGrowIsNospaceAndCounted` | `commits` warn, fail at three in a row |
| A directory fsync that fails | `FaultForTest`, `Sync` returning EIO | never acknowledged, the body reads as absent, the retry sends it again, earlier notes unchanged | `TestAFailedDirectoryFsyncIsNeverAcknowledged`, and the S17 tests | the log; a volume the kernel remounts read-only shows as `chunks-read-only` under `server` |
| A missing body | the file removed | verify's `missing`; `trew repair` on a device resends it | `TestVerifyFindsAMissingBody`, `client/src/node/inspection.test.ts` | `store` fail, `chunks` fail when sampled |
| A corrupt body | a byte flipped | `Get` refuses it; it is quarantined, never deleted, and replaced by a repair | `TestDeepVerifyFindsACorruptChunk`, `TestDelayedQuarantinePreservesAcknowledgedRepair` | `chunks` fail (sampled), `store` fail with `-deep`, `chunks` warn for quarantined bodies |
| A slow peer | frames past `SendQueueBytes` to a peer that never reads | dropped and counted; the others served; its reconnect catches up with every version | `TestASlowPeerIsDroppedCountedAndCatchesUp`, `TestS8TheCatchUpBufferIsBoundedInBytesAsWellAsEntries` | the count in `commits` |
| A reply lost after its commit | the ack never read | one version; the blind retry is `stale`, and the catch-up carries the write. MCP: the idempotency key; invites: the lost-reply retry | `TestAReplyLostAfterItsCommitIsOneVersionAndAStaleRetry`, `TestAKillAroundAnAppendResolvesOnRetryToOneResult`, `TestALostReplyRetryIsRedeemedAgainEvenAfterExpiry` | nothing to report: nothing is wrong |
| A restart loop, a killed run | the runtime record | the log's startup refusal says why | `TestServeRecordsItsStartsAndACleanStop` | `restarts` fail (five in ten minutes), warn (killed) |
| A parser failure | a note whose tags or links do not parse; malformed JSON-RPC | indexed with the failure counted, never refusing the note; a JSON-RPC error | `TestATagParseFailureIsReportedAndNeverRejectsTheNote`, `TestMalformedFramesAreJSONRPCErrors` | `index` note with the counts |
| A hung server | the server lock held, no socket | restart after reading its log | `TestDoctorReportsEveryInjectedFault` | `server` fail |
| Storage a restart erases | the mount table | `serve` refuses an empty store | `TestServeRefusesAnEmptyStoreOnStorageARestartErases` | `storage` fail |

A SIGKILL is still not a power cut, and nothing here cuts power: the ordering
of bodies, directory fsyncs, commit and reply is what the S17 tests, the crash
matrix and these hold, on a disk that did not lose its cache.

**Soak.** PLAN.md asks for a defined period on disposable representative data,
a phone offline while an agent edits, with no unexplained loss, divergence or
unbounded retries as the exit criterion. The M5 day-of-use soak, running on a
scratch vault at the time of writing, is that period; `trewd doctor` at its
end (no `commits` failures, no device stopped advancing, `store` clean) and
`trewd audit` are how it is read. Its result is recorded with M5's done-when,
not claimed here.

### The soak (M5 done-when)

The done-when's last clause, "a day of real use on a scratch vault has
produced no unexplained conflict copy", as a machine can run it:
`client/src/stress/soak.ts`, with the vault and the people in
`soak-vault.ts`.

**What runs.** A real `trewd serve -mcp` on a temporary data directory. The
headless client, bundled from the tree exactly as `dist/trew.mjs` is and run
under node, in two directories: a laptop in `trew sync --watch`, and a phone
that is offline for minutes at a time and runs `trew sync` between. The seed
vault is shaped like one kept for a while: daily notes, projects, people,
meetings that link one attendee and only name the other, reading notes, an
inbox with empty placeholders, attachments, frontmatter with the
inconsistencies real frontmatter has (`Status:` beside `status:`, `Project`
beside `project`), inline tags, wiki links, Markdown links and embeds. A person
at each device makes the edits people make on a schedule: appends to the
day's note, bullets, words added to a line, tags, frontmatter lines, new
notes, renames, deletions, pasted images. Each edit carries a marker of its
own and none removes text an earlier one wrote. The agent is a write token
(`trewd mcp-token -scope write`) driven either by `claude -p --mcp-config
FILE --strict-mcp-config --tools "" --allowedTools mcp__trew` with twelve
realistic tasks (tidy a tag with `rename_tag`, add backlinks, triage the inbox
with `move_note`, fix frontmatter, append to the daily note, delete
placeholders, tag and then `undo_operation`, build a reading index and
prepend to Home, rename a project, remove a tag, restore a deleted note,
review the week), or by a scripted agent making the same kinds of call.

**What it checks,** after the phone has synced and the watcher settled:

- Every conflict copy anywhere in the server's history, live or not, is
  explained: a version of the note by another author that the copy's device
  had not seen when its person edited (the person's file was an older
  version, found by hash, following the device's own unsent edits back), an
  edit by that person the other version does not hold, and the copy's bytes
  one of the two; for an agent's side, the operation from `trewd audit` and
  the uid it was based on. Anything else fails the run.
- A freshly paired witness matches the server's live state byte for byte
  (bytes through `trewd cat`, not the tools, which normalise text for a
  model), and both devices match the witness.
- `trewd verify -deep` reports 0 faults.
- No note lost: every version a person wrote is in the server's history
  exactly, or its marker is (the engine merged it); no device upload of a
  person's bytes sits on a version that person had not seen, unless the
  device kept that version in a conflict copy; and every marker missing from
  the live vault was taken by a deletion.

An agent's move leaves no deletion at the path it moved from, only a version
at the new path naming the old one, so `list_notes` with `includeDeleted` does
not list the old path; the soak also asks `note_history` about every path the
audit and the ledger mention.

**Running it.** `cd client && bun run soak` runs the scripted agent for three
minutes. `bun run soak --claude --minutes 80 --sessions 12` is the real run
(`--model`, default `sonnet`; `--budget`, per session, default 0.75 USD;
`--first-task N` to go on from task N; `--seed`; `--out DIR` for the report,
the ledger, the audit and each session's transcript; `TREW_SOAK_KEEP=1`
keeps the directories). `soak.stress.ts` is the short mode in `bun run
stress`, and so in `scripts/check.sh` and CI: 60 notes, 75 seconds of edits
and eight scripted sessions, about two minutes, no model and no credentials.

**The run, 2026-09-24.** Two runs with `claude -p` on Sonnet, one of 80
minutes and twelve sessions and one of 35 minutes and five, on vaults of 320
notes and 8 attachments. Session 8 of the first did not run: `claude` exited
at a usage limit, so its task (the reading index) was the first of the second
run, which took tasks 8 to 12.

| | First run | Second run | Total |
|---|---|---|---|
| Sessions that ran | 11 | 5 | 16 |
| Tool calls | 91 | 22 | 113 |
| Operations committed | 22 | 7 | 29 |
| Refusals, nothing written | 4 `plan_changed`, 1 `same_destination` | 1 `same_destination` | 6 |
| Device edits (laptop, phone) | 203 (144, 59) | 85 (55, 30) | 288 |
| Phone syncs | 18 | 11 | 29 |
| Server versions | 583 | 432 | 1,015 |
| Person versions found exactly, merged | 506, 9 | 399, 4 | 905, 13 |
| Lost, over unseen, missing from live | 0, 0, 0 | 0, 0, 0 | 0 |
| Conflict copies | 1, explained | 0 | 1 |
| Witness, devices, `verify -deep` | match, match, 0 faults | match, match, 0 faults | |
| Claude spend | 1.46 USD | 0.53 USD | 1.99 USD |

The operations were `edit_note` 7, `append_note` 6, `move_note` 4,
`create_note` 4, `delete_note` 2, `rename_tag`, `add_tags`,
`prepend_note`, `remove_tags` twice, and one undo (`undo_operation` of the `add_tags`). The refused
restores were `restore_note` onto the note's own path, which the tool
refuses by design; the agent read the version and recreated it with
`create_note`, as the refusal says to.

The one copy, `Daily/2026-09-24 (Conflicted copy Claude soak 202609241409).md`,
made by the phone: the phone's person, offline, appended its edit 21 to the day's
note at uid 415; meanwhile the laptop appended at uid 425 and the agent's
`append_note` (operation `oDj7kpSdBPc6Sn5jIt0-7Q`) appended to that at uid
431. All three added lines at the end of the same text, so there was no
order a line merge could choose: the phone kept its own at the path and the
agent's version, holding the laptop's line too, in the copy named after the
agent. Both are live; nothing was lost.

**What it found.** The short runs that built the harness produced a copy of
a copy: `Daily/2026-09-24 (Conflicted copy laptop T) (Conflicted copy laptop
T).md`. The laptop had kept its own text of the day's note in `Daily
(Conflicted copy laptop T).md` and sent it; the phone had kept the laptop's
text in a copy of the same name in the same minute, because the engine asked
only its own disk whether the name was free. When the laptop's copy arrived,
the phone kept it as a copy of the copy: nothing lost, and a conflict copy no
two edits of one text explain. The engine now counts a name the remote index
holds a live file at as taken (`freeConflictPath`); the engine test "numbers
past a copy's name the server holds that has not reached this disk" failed
without that and passes with it. Both long runs are after the fix.

### The cutover rehearsal (M10)

PLAN.md M10 step 1, run on 2026-09-24 on read-only copies of the owner's
vault. The runbook, the measured vault and the findings are
[plan/cutover.md](../plan/cutover.md); this is how the checks are built and
what the rehearsal established. Nothing from the vault is in the repository:
the copies, inventories and backups were deleted, and only counts are
recorded.

**The inventory** (`scripts/vault-inventory.py`). One JSON line per entry,
sorted by the path's UTF-8 bytes: the path as Obsidian names it (NFC, U+00A0
and U+202F as spaces, the mapping both adapters apply), the kind (`note` for
`.md`, `attachment`, `folder`), size, SHA-256, and the reason an entry is not
expected on a witness. The reasons are the server's path rules, taken from
`scripts/protocol-vectors.py`'s `path_reason` and `fold` rather than written a
fourth time, plus `toolarge` (over `-max-file`), `collision` (a fold group,
of which exactly one may arrive), `symlink` and `other`. It runs under the
interpreter the fold is pinned to (`uv run --no-project --python 3.13`) and
refuses any other. `compare` is go only when every synced source entry is on
the witness with the same kind, size and hash, every excluded one is absent,
and nothing is witness-only outside `.trew`, `.obsidian` and `.trash` (a
client's own state; a leftover `.trew-tmp-` file is a failure). It prints
classes and counts, and paths only with `--paths`. `snapshot` copies a vault
and compares every entry, excluded ones too, listing the source again after
to catch a writer still running. `changes` exports what differs between the
freeze's inventory and a current witness's, verifying each exported file's
hash; `apply` writes it into a vault as it was at the freeze, per path only
where the vault still holds the frozen bytes (or nothing, for an addition), a
dry run unless `--apply`.

`scripts/vault-inventory.test.sh` (the gate step "the witness inventory
explains every difference", in `scripts/check.sh` and CI's server job) builds
a vault with dot folders, an NFD and a no-break-space name, an empty folder,
a symlink, a file over the limit and a fold pair (tested where the disk keeps
both; APFS makes them one file), and holds that a faithful witness is a go
and that one changed byte, a missing note, a missing empty folder, an extra
file, a staging file left behind, an excluded file that arrived, and both of
a fold group arriving are each a no-go; then that an export applied to the
freeze reproduces the current state and that a file changed on both sides is
refused and left as it was. Its dry-run case failed before the fix to
`apply`'s folder accounting.

**The rehearsal** (`scripts/cutover-rehearsal.sh VAULT`). Builds `trewd` and
`trew` from the checkout, snapshots the vault into a private temporary
directory, runs a scratch server on loopback, uploads from the copy, downloads
into a fresh witness and compares, makes edits after the cut on two devices
with one offline (an append to the same note on both, a nested folder rename
with an offline edit inside it, Unicode, NFD and no-break-space names, an
attachment, a large note, a deletion), checks each edit's words survive,
compares the devices and a second fresh witness, takes an encrypted backup and
runs `trewd rehearse`, and exports the changes since the cut, checks them
against `trewd restore -to-uid CUT -json` path for path, applies them to the
frozen copy and compares with the server's state. It prints counts and times,
and removes everything at the end. The first manual run added an agent's
append through `/mcp` (a read token's refused), a file one byte over 64 MiB
(refused with its size, explained as `toolarge`), a manual `unpack` and
`serve` of the backup with a headless witness from it, and `trewd doctor`.

**What it established, on this vault.** 3,853 synced entries (3,621 notes,
136 attachments, 96 folders, 80.9 MiB) and 593 dot-named exclusions; nothing
refused by length, characters, normalisation, case or size. Upload 40 to 52 s,
a witness download 42 to 91 s, an encrypted backup 106 to 183 s (96.5 MiB of
ciphertext), `trewd rehearse`'s recovery time 55 to 82 s, on the Mac over
loopback. Every verdict go, in three runs. The shared note merged both
appends in place; the offline edit inside the renamed folder stayed at its old
path beside the renamed copy; 203 notes' frontmatter is refused for tags by
the Go reader and, checked by running it over the witness, by Basalt's
TypeScript reader alike.

**Fixed.** `trew pair --key-file` on the saved output of `trewd invite` was
refused as "2 invites, one per address": every non-empty line counted, and
`trewd invite` prints a sentence before the invite. Only lines holding a
`trew1i_` string count now; `client/src/node/cli.test.ts` "takes everything
trewd invite printed as the one invite it is" fails without the change. The
plugin's pairing field takes a pasted line and was not affected.

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

### Retiring `trew mcp` (M2 task 10)

PLAN.md M2 task 10 deletes the headless client's MCP server "only once the Go
tools pass against their fixtures", and section 2.1 keeps its semantic vectors
until M5 proves the port. M4 and M5 did: `internal/notes` holds every vector of
`mcp-fixtures.json` (`oracle_test.go`, `oracle_write_test.go`), and the tools'
own suites and the crash and race stress files pass. Decided 2026-09-24:
`trew mcp` and `trew mcp-token` are removed from the published CLI with their
flags, and exit 2 saying where MCP went (`cli.test.ts`, "says where MCP went";
`scripts/pack-check.sh` against the packed file).

**Deleted**, because only the retired host used them: `mcp.ts` (the command),
`mcp-session.ts`, `mcp-tools.ts` (the SDK tool registry), `mcp-protocol.ts`
(the stdio transport), `mcp-http.ts`, `mcp-token.ts` (the directory's
credential), `mcp-vaults.ts` (named roots), their test helpers
`mcp-test.ts`, `mcp-http-test.ts`, `mcp-process-test.ts`, `mcp-fault-child.ts`,
`mcp-artifact-test.ts` and `mcp-artifact.run.ts`, fourteen test files, and the
`@modelcontextprotocol/client`, `@modelcontextprotocol/server` and `zod`
development dependencies. **Kept** as the oracle, test-only, because
`mcp-oracle.run.ts` imports them and must still write `mcp-fixtures.json` byte
for byte: `mcp-read.ts`, `mcp-inspect.ts`, `mcp-history.ts`, `mcp-markdown.ts`,
`mcp-links.ts`, `mcp-notes.ts`, `mcp-operations.ts`, `mcp-batch.ts` and their
unit tests, with `mcp-history.test.ts` cut to its seven cases that need no
host. `bin.test.ts` builds its bundle itself now, which `mcp-test.ts` did for
it, and `artifact-test.ts` replaces `mcp-artifact-test.ts` for the shipped
file (above, "MCP verification").

**The ledger.** Every case of every deleted file, and the six cut from
`mcp-history.test.ts`, was read and classified before the file went: COVERED
by a named Go test that asserts the same property of `/mcp` (each was read to
confirm it does), OBSOLETE with the host (stdio, sessions, the SDK's queues,
the directory's credential file, named local roots, the vault lock and the
before-image files), KEPT in a kept file, or a guarantee with no home, which
was PORTED before the deletion. 109 cases in 15 files; SPLIT rows say which
part is which.

| File | Cases | Where the guarantees went |
|---|---|---|
| `mcp.test.ts` | 8 | 4 covered, 3 obsolete (case aliases and NFC twins on a local disk), 1 ported; one row of a covered case ported |
| `mcp-bin.test.ts` | 7 | 2 covered, 5 obsolete (stdio lifecycle, lock drains) |
| `mcp-protocol.test.ts` | 9 | 4 covered, 5 obsolete (stdio framing, SDK admission); the cancellation halves ported |
| `mcp-artifact.test.ts` | 1 | the shipped-file half ported to `artifact.test.ts`, the tool workflow covered |
| `mcp-tools-process.test.ts` | 2 | covered; one row (a prepend with no base) ported |
| `mcp-token.test.ts` | 6 | 4 covered, 2 obsolete |
| `mcp-token-auth.test.ts` | 12 | 2 covered, 10 obsolete as written (the credential file); the store-failure half of two ported, the key-out half of two covered |
| `mcp-http.test.ts` | 18 | 8 covered, 3 obsolete (sessions, the GET stream), 4 split, 3 ported; one split's route half ported too |
| `mcp-http-cli.test.ts` | 4 | obsolete (the flags) |
| `mcp-http-process.test.ts` | 11 | 2 covered, 6 obsolete, 3 split; the dropped connection ported |
| `mcp-http-concurrency.test.ts` | 7 | 4 covered, 1 obsolete (the credential file's torn reads), 2 split; the dropped connection ported |
| `mcp-vault-process.test.ts`, `mcp-vault-routing.test.ts`, `mcp-vaults.test.ts` | 11 | obsolete (one vault per endpoint); the scope halves covered |
| `mcp-history.test.ts` | 13 | 7 kept, 4 covered, 1 split (covered and obsolete), 1 ported |

**Ported**, each shown to fail with the check it holds taken out where that
could be done by one line:

| Test | Holds |
|---|---|
| `internal/mcp/retired_host_test.go` `TestAStoreThatCannotBeReadAnswers503BeforeAnyTool` | a store that cannot be read at the door is 503 `unavailable`, nothing dispatched, nothing secret in the reply or the log, and the token works again after |
| `TestOnlyExactlySlashMCPIsServed` | only exactly `/mcp`, no query string at all, even with a valid token (fails with the query check removed from `ServeHTTP`) |
| `TestAClientThatHangsUpMidReadGivesItsSlotBack` | a client that hangs up mid-call gives its in-flight slot back |
| `TestAClientThatHangsUpMidWriteCommitsAtMostOnce` | a client that hangs up at `bodies`, `committed` or `broadcast` leaves the write committed once or not at all, and the keyed retry is one result |
| `TestRestoreNoteRefusesWhatIsNotANoteAndWritesNothing` | `restore_note` refuses a folder, a deletion, another path's uid, a version over 1 MiB, invalid UTF-8 and an occupied destination, writing nothing |
| `TestAppendAndPrependNeedABase` | `append_note` and `prepend_note` without a base are `invalid_arguments` |
| `cmd/trewd/mcp_shutdown_test.go` `TestSIGTERMLetsAnAdmittedMCPWriteFinish` | SIGTERM lets a write held at `bodies` or `committed` finish and answer before serve exits 0 (fails with the shutdown allowance cut to a millisecond) |
| `TestServeCutsOffUnfinishedHeaders` | unfinished request headers are cut off at about ten seconds, naming nothing |
| `cmd/trewd/mcptoken_test.go` `TestAKeyOutThatExistsIsRefusedBeforeATokenIsMinted` | a `-key-out` naming an existing file, or a name no file can be made at, is refused before a token is minted, and the file is untouched |
| `TestAKeyOutThatCannotBeWrittenRevokesTheTokenItMinted` | a `-key-out` that cannot be written once the token exists revokes that token, and says nothing usable was left |
| `TestARevokeThatFailsAfterTheKeyOutFailedSaysSoLoudly` | when that revoke fails too, the error says the token is still live, names its id, and gives the exact command that revokes it |
| `cmd/trewd/secretfile_s11_test.go` `TestWriteNewSecretFileRefusesAFileAlreadyThere` | the exclusive writer refuses a file already at the name, leaving it as it was |
| `client/src/node/artifact.test.ts`, `scripts/pack-check.sh` | the shipped `trew.mjs`, alone and with the repository denied, pairs and syncs both ways, and neither bundle carries MCP code |

**Fixed.** `trew mcp-token --key-out` refused an existing file, and never
printed or left a credential it could not make durable. `trewd mcp-token
-key-out` mints the token through the control socket first and then writes
the file, so a file that could not be written left a live token nobody held,
and an existing file was silently replaced. By the owner's decision it now
refuses an existing file before minting, and writes through
`writeNewSecretFile`, which links the staged file to the name so the kernel
refuses a file that appeared in between. A write that fails once the token
exists revokes that token through `revokeMCPToken`, the path `-revoke` takes;
when the revoke fails too, the error says the token is still live, names its
id, and prints the exact revoke command. `writeSecretFile` still replaces an
existing file on purpose, for the first-run invite
(`TestS11OverwritingA0644FileTightensItTo0600`). The three
`cmd/trewd/mcptoken_test.go` tests and
`TestWriteNewSecretFileRefusesAFileAlreadyThere` failed before the change.
Rows `mcp-token.test.ts` 50 and `mcp-token-auth.test.ts` 135 and 158.

The per-case tables follow. Line numbers are those of the deleted files at
`cfb7961`.

#### `client/src/node/mcp.test.ts` (8)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 62 | edits two daily tasks over stdio while keeping unrelated bytes and the backup on a second device | Two exact edits in one call change only those lines of a BOM/CRLF/frontmatter note; the before-image reads back as the original; a retry on the old base is `stale`; a second device receives the edited bytes (and the before-image file) | COVERED | The bytes: `internal/notes/port_notes_test.go` `TestPortedTwoExactEditsTogether`, `TestPortedPrependKeepsTheBOM`, and the `edits` vectors in `oracle_write_test.go`. The before-image as the displaced version read by `previousUid`: `internal/mcp/write_test.go` `TestEveryWriteToolCommitsAndKeepsItsBeforeImage`. Stale with the path's uid: `TestAStaleBaseIsRefusedWithThePathsOwnUID`. The device has it: `TestADeviceReceivesTheWriteBeforeTheReply`, and a fresh device holding exact bytes in `client/src/stress/mcp-races.stress.ts`. The before-image as a file in the vault and `connection.localGeneration` are the host's and go |
| 119 | resolves case aliases over stdio only when the filesystem does | On a case-folding disk `Work/note.md` reads `work/note.md` and a create lands in the existing folder spelling; on a case-sensitive disk it is `not_found_local` | OBSOLETE | A property of the local disk under `trew mcp`. The server has exact paths and one collision rule: a case variant of a live path is `collision` (`internal/mcp/write_test.go` `TestWriteArgumentsAreStrictAndThePathPoliciesHold`, `internal/store/collision_test.go` `TestTheFixtureCollisionsThroughTheAppendPath`) |
| 150 | reads and edits both case-distinct notes over stdio without touching the other | `Foo.md` and `foo.md` side by side are both listed, read and edited, each edit leaving the other untouched | OBSOLETE | The server cannot hold the pair: the second spelling is refused `collision` (same two tests as line 119). Nothing inherits a vault with both |
| 183 | initializes and reads 5000 notes while the sync handshake is stalled, with bounded pages and eight concurrent calls | Initialize and reads work while sync is stalled; no mutation tools in read-only mode; 5000 notes list in bounded pages with no duplicates; a 1 MiB note pages at 65,536 bytes, next line 65, pages summing to the note; eight concurrent reads equal sequential ones; a writable host refuses `not_ready` before its first sync and creates nothing | COVERED | Paging and bounds: `internal/mcp/tools_test.go` `TestListingFiltersKindsAndBounds` (limit 1 to 500), `TestListingPagesAcrossConcurrentCommitsWithoutGhosts` (paged equals whole, no ghost or duplicate). Pages by bytes, the same 1024 x 1024 note and next line 65: `internal/notes/port_read_test.go` `TestPortedPagesByBytes`; pages joined are the bytes: `TestReadNotePagesVersionsAndRefusals`. Read tools hidden from a read token: `internal/mcp/auth_test.go` `TestAReadTokenCannotCallAWriteTool`. The stalled handshake, `not_ready` and the host's admission queue under eight calls are the host's: the server serves from its store, with no sync to wait for |
| 290 | omits every mutation in persisted read-only mode and refuses invalid schemas without creating files | A read-only config lists exactly the nine read tools, a write call fails and writes nothing; `maxLines: 0`, an unknown key, a malformed base and a lone surrogate are tool errors | COVERED | Scope at discovery and dispatch, nothing written: `internal/mcp/auth_test.go` `TestAReadTokenCannotCallAWriteTool`, `TestTheAuthorizationMatrixCoversEveryTool`. Argument strictness: `internal/mcp/tools_test.go` `TestReadNotePagesVersionsAndRefusals` (`invalid_limit`, `invalid_arguments`, lone surrogate `invalid_text`), `internal/mcp/transport_test.go` `TestToolFailuresAreResultsAndUnknownToolsAreErrors` (unknown argument). The read-only device config as the switch is gone; scope is the token's |
| 324 | serves a cancelled search without losing the next request | A search cancelled mid-flight is abandoned, and the next call on the same host succeeds | PORTED | The server has no session to wedge, but it has admission caps (32 in flight, 8 per token). No Go test has a client abandon a request and then shows the slot came back. `TestBudgetsAnswer429WithoutStarvingAnotherToken` "in flight" only shows release after a normal completion. See PORTED 1; ported as `internal/mcp/retired_host_test.go` `TestAClientThatHangsUpMidReadGivesItsSlotBack` |
| 338 | reads old versions and restores deleted notes to explicit destinations across restart and another device | `note_history` pages with `before`/`nextBefore` to a null end; `read_note` with `uid` returns the historical bytes (source `history`); `restore_note` to a free path commits and names its source; the same restore again is `exists`; the head is untouched; `deleted_notes` lists a deletion and its old uid still reads and restores; a fresh device receives both restored notes | COVERED, except one row | History paging and deletions: `internal/mcp/tools_test.go` `TestHistoryDeletionsAndComparisons`; historical reads: `TestReadNotePagesVersionsAndRefusals`; restore to a new path with `restoredFrom`: `internal/mcp/write_test.go` `TestEveryWriteToolCommitsAndKeepsItsBeforeImage`; devices receive it: `TestADeviceReceivesTheWriteBeforeTheReply`. The restart is the server's store, with nothing held in a process. Not asserted in Go: `restore_note` onto an occupied destination is `exists` and replaces nothing. `restoreNote` goes through `mutation.create`, whose `exists` is tested only for `create_note`. See PORTED 2; ported as `internal/mcp/retired_host_test.go` `TestRestoreNoteRefusesWhatIsNotANoteAndWritesNothing` (the `exists` row) |
| 415 | reports real Unicode spelling collisions as an incomplete stdio search | NFC and NFD spellings of one name side by side on disk: `ambiguousCount` 1, the search skips it as `ambiguous_path` and is incomplete, both files untouched | OBSOLETE | The server refuses a path that is not NFC (`badpath`, reason `nfc`: `internal/paths/paths_test.go` `TestEveryPathGetsTheReferenceVerdictAndReason`), so it never holds two spellings; the ambiguity was the local disk's |

#### `client/src/node/mcp-bin.test.ts` (7)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 62 | %s drains an admitted edit before another process can take the vault (EOF, SIGTERM, EPIPE) | Ending the `trew mcp` process mid-write keeps the vault lock until the admitted append finishes, a competing `trew sync` is refused meanwhile, the append lands, the next host lists its before-image, a retry on the old base is `stale` | OBSOLETE | The stdio process, its vault lock and its on-disk before-image all go. The server's version is the commit boundary and SIGKILL around it: `cmd/trewd/crash_test.go` `TestAKillAroundAnAppendResolvesOnRetryToOneResult` and `client/src/stress/mcp-crash.stress.ts` (retry with the key is one result, keyless retry `stale`, line in the note once) |
| 121 | %s closes a stalled handshake and wakes reconnect sleep (EOF, SIGTERM) | `trew mcp` exits 0 promptly while its sync handshake is stalled or it is sleeping before reconnecting | OBSOLETE | The host's own sync lifecycle; the server has no upstream to wait on |
| 165 | MCP and sync watch exclude each other through root aliases and release after a kernel kill | `trew mcp` and `trew sync --watch` on the same vault through a symlinked alias exclude each other; a SIGKILLed holder releases the lock at once | COVERED (the lock half) | MCP half is gone with the host. The lock half, for the commands that stay: `scripts/kernel-lock.test.ts` ("after SIGKILL the next trew takes it", and the symlink and trailing-slash aliases), run by `scripts/check.sh` and CI job `kernel-lock`; `client/src/node/lock.test.ts` "refuses while a holder on this host is alive" |
| 200 | rejects %s without putting human diagnostics on stdout (--json, --watch, --verify) | `trew mcp` with those flags exits 2 with nothing on stdout | OBSOLETE | The command goes; stdout no longer belongs to a protocol in any remaining command |
| 211 | rejects malformed input without dispatch or non-protocol stdout: %j | Broken JSON, an array, and a non-string method are refused with no dispatch and nothing but protocol on stdout | COVERED | `internal/mcp/transport_test.go` `TestMalformedFramesAreJSONRPCErrors` ("not JSON", "an array", "a method that is not a string", and a refusal before any method runs). The stdio shutdown semantics (exit 0 or 1) are the host's |
| 230 | %s drains an incoming sync replacement before releasing the lock (EOF, SIGTERM) | Ending `trew mcp` while it holds an incoming replacement at `cli/vault:replace.staged` keeps the lock until the replacement lands; the note then holds the remote bytes | OBSOLETE (the drain) | The drain was the host's shutdown path. What must not happen, a note lost by a process that dies inside a replacement, is `client/src/stress/faults.stress.ts` "survives it" and "leaves both versions findable" at `cli/vault:replace.staged` and `replace.nameFree` |
| 256 | a real backpressured stdout resumes bounded read replies without losing protocol framing | Four large reads with stdout paused all arrive whole and framed once it resumes | OBSOLETE | Stdio framing. The server answers each request on its own connection; replies are bounded by `internal/mcp/auth_test.go` `TestARepliesOver1MiBAreRefusedBeforeTheyAreSent` and the reply-byte budget in `TestBudgetsAnswer429WithoutStarvingAnotherToken` |

#### `client/src/node/mcp-protocol.test.ts` (9)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 54 | reclaims admission after cancelled handlers actually finish | Sixteen cancelled calls release their admission once each handler returns, so a seventeenth request is served | OBSOLETE | The SDK stdio session's admission queue. The server has no queue: a request holds an in-flight slot only while its handler runs. The part that survives, a slot coming back after an abandoned request, is PORTED 1; ported as `internal/mcp/retired_host_test.go` `TestAClientThatHangsUpMidReadGivesItsSlotBack` |
| 88 | keeps admission for cancelled transactions until filesystem work finishes | A cancelled write keeps its slot until its filesystem work finishes; the queue is full meanwhile, free after | OBSOLETE | As 54, with the local write. On the server a write is one `CommitOperation`, all or nothing whatever the client does; the abandoned-write case is in PORTED 1; ported as `internal/mcp/retired_host_test.go` `TestAClientThatHangsUpMidWriteCommitsAtMostOnce` |
| 134 | does not treat a version claim on a legacy connection as initialized | A handshake-era request carrying a 2026-07-28 `_meta` claim before `initialized` does not dispatch a tool | COVERED | Mixing eras is refused before dispatch: `internal/mcp/transport_test.go` `TestStatelessRequestsMustMirrorTheirBody` ("another version in the header") and `TestHandshakeRequestsNameTheirVersion`. The server is stateless, so "initialized" has no meaning to confuse |
| 172 | cancels legal request id %j without confusing numeric and string ids (0, "", "0") | Cancelling id 0, "" or "0" cancels that request only and it gets no reply | COVERED (the id half) | `internal/mcp/transport_test.go` `TestIDsAreRepeatedAsSent` (0, "", "0" repeated exactly) and `TestDuplicateIDsAreAnsweredEachOnItsOwn`: nothing routes a reply by id. `notifications/cancelled` is accepted and changes nothing (`TestNotificationsAreAcceptedWithNoBody`); cancellation is the client closing its connection, PORTED 1; ported as `internal/mcp/retired_host_test.go` `TestAClientThatHangsUpMidReadGivesItsSlotBack` |
| 206 | reclaims cancelled invalid-schema calls even when no tool handler ran | Cancelled calls stuck in schema validation release admission, and no handler runs | OBSOLETE | The SDK's async zod validation. The server's argument reader is synchronous and strict (`internal/mcp/write_test.go` `TestWriteArgumentsAreStrictAndThePathPoliciesHold`, refused before anything is written) |
| 255 | preserves original response ids and refuses duplicate active ids | Ids 0 and "0" are answered distinctly; a duplicate in-flight id shuts the session | COVERED | `internal/mcp/transport_test.go` `TestIDsAreRepeatedAsSent`; duplicates are decided differently and tested: `TestDuplicateIDsAreAnsweredEachOnItsOwn` (each answered with its own result, PLAN M4 task 1) |
| 284 | validates fragmented UTF-8 and rejects oversized unterminated input before dispatch | A UTF-8 sequence split across writes decodes; input over 8 MiB is refused before dispatch | COVERED | Invalid UTF-8 is a parse error: `internal/mcp/transport_test.go` `TestMalformedFramesAreJSONRPCErrors`; over 8 MiB, declared or streamed, is 413: `internal/mcp/auth_test.go` `TestBodiesOver8MiBAre413`. Fragmentation across writes is a stdio line-reader concern |
| 302 | reports EPIPE and drains queued output without admitting another request | A broken stdout pipe ends the session after draining, with no new request admitted | OBSOLETE | Stdio only |
| 326 | holds its bounded input queue while stdout is backpressured | A notification is not processed while stdout is backpressured, then is | OBSOLETE | Stdio only |

#### `client/src/node/mcp-artifact.test.ts` (1), with `mcp-artifact-test.ts`

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 12 | the actual production configuration builds an isolated single-file MCP and keeps the SDK out of the plugin | A fresh `esbuild.config.mjs production` build succeeds; the plugin bundle has no `modelcontextprotocol`/`McpServer`/`StdioServerTransport`; `trew.mjs` copied alone into an empty directory, build inputs removed and (macOS) the repository denied by `sandbox-exec`, pairs from a real server's first invite and runs the full stdio and HTTP tool workflow (read, exact edit, before-image, create_directory, tags, move with backlink, history, compare, delivery, delete); `pack-check.sh` repeats the workflow against the npm-installed package | PORTED (the artifact half); OBSOLETE (the MCP workflow and the SDK leak) | The tool workflow is the server's now: `internal/mcp/write_test.go` `TestEveryWriteToolCommitsAndKeepsItsBeforeImage`, `internal/mcp/tools_test.go`. The SDK-in-the-plugin check has nothing to catch once `@modelcontextprotocol/*` leaves `client/package.json`. What has no home: nothing else runs a real pair and sync from the production `trew.mjs` isolated from the repository, or from the npm-installed package. `client/src/build.test.ts` runs only `--help`, `--version` and checks imports in place; `scripts/pack-check.sh` runs only `--version` and `--help`. See PORTED 3; ported as `client/src/node/artifact.test.ts` and `artifact-test.ts`, run again by `scripts/pack-check.sh` on the npm-installed file |

#### `client/src/node/mcp-tools-process.test.ts` (2)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 60 | searches tags and filenames, then prepends recoverably through the built CLI, HTTP=%s | Tag search finds a real tag and not one in a code span; filename search finds the note; prepend after a BOM keeps it and CRLF; the before-image reads back; a retry on the old base is `stale`; a prepend without `base` is a tool error; a second device receives the bytes and the before-image | COVERED, except one row | Tag and filename modes through the tool, over Basalt's corpus: `internal/mcp/search_oracle_test.go` `TestSearchMatchesBasaltsLiteralScanOverTheCorpus`; code spans are not tags: `internal/notes/port_read_test.go` `TestPortedSearchesParsedTags`; filename mode: `TestPortedFilenamePagesBindTheMode`; BOM prepend: `internal/notes/port_notes_test.go` `TestPortedPrependKeepsTheBOM` and `write_test.go` `TestEveryWriteToolCommitsAndKeepsItsBeforeImage` (the `bom.md` step, with its former bytes); stale: `TestAStaleBaseIsRefusedWithThePathsOwnUID`; devices: `TestADeviceReceivesTheWriteBeforeTheReply`. Not asserted in Go: a `prepend_note` (or `append_note`) with no `base`; the strictness table has only `edit_note` without a base. See PORTED 2. The before-image as a vault file is the host's; ported as `internal/mcp/retired_host_test.go` `TestAppendAndPrependNeedABase` |
| 116 | previews and applies tag, move, directory and delete workflows through the built transport, HTTP=%s | `create_directory`, `create_note`; `add_tags`, `rename_tag`, `remove_tags`, `manage_tags`, `move_note` each previewed then applied with the preview's changes; the backlink is rewritten; `delete_note` keeps a before-image with the moved note's bytes; a second device holds the backlink and the before-image, and not the deleted note | COVERED | `internal/mcp/write_test.go` `TestEveryWriteToolCommitsAndKeepsItsBeforeImage` (every one of those tools previewed and applied, backlink rewritten, each displaced version read back exactly by `previousUid`), `TestAnApplyIsBoundToItsPreviewsHead`, `TestADeviceReceivesTheWriteBeforeTheReply`; a fresh device after a move with backlinks and a tag batch: `client/src/stress/mcp-crash.stress.ts`. The before-image file on the second device is the host's: on the server it is the pinned version |

#### `client/src/node/mcp-token.test.ts` (6)

The headless client's `trew mcp-token` issued one bearer per vault directory and kept its SHA-256 in `.trew/mcp-token.json`. On the server a token is a row in `mcp_tokens`, minted by `trewd mcp-token` through the control socket, so the file, the vault directory and the owner lock go; what a token must be and where it may be written stays.

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 27 | issues an independent bearer once and stores only its verified hash at 0600 | 43 characters of base64url printed once; only its SHA-256 stored; the fingerprint (8 hex) shown, never the hash or token | COVERED (the 0600 JSON file is OBSOLETE: the hash is a SQLite row) | `internal/store/mcptokens_test.go` `TestAnMCPTokenIsStoredAsAHashUnderARandomID` (hash stored, never the clear token, listing carries neither, fingerprint is hash[:8]); `cmd/trewd/mcptoken_test.go` `TestMCPTokensAreMintedListedAndRevokedThroughTheServer` (printed token decodes to 32 bytes, listing carries no credential) |
| 42 | refuses an unpaired directory without creating state | No pairing, no token, no files | OBSOLETE | A server token needs no device pairing; `trewd mcp-token` on a data dir is the store's, and a refused command mints nothing (`TestMCPTokenRefusesWhatItCannotDo`) |
| 50 | writes --key-out privately without echoing the key and refuses to overwrite it | Key file 0600, token not in output, path in output; a second `--key-out` to the same path fails, leaves the file and the stored hash unchanged | COVERED | 0600 and not printed: `TestMCPTokensAreMintedListedAndRevokedThroughTheServer`, `cmd/trewd/secretfile_s11_test.go` `TestS11WriteSecretFileIsExactAndPrivate`. The overwrite refusal, with the file left as it was and nothing minted: `cmd/trewd/mcptoken_test.go` `TestAKeyOutThatExistsIsRefusedBeforeATokenIsMinted`, and for a file that appears after the check, `TestWriteNewSecretFileRefusesAFileAlreadyThere` |
| 65 | keeps key output outside the vault, including a root alias (it.each false, true) | `--key-out` inside the vault, directly or through a symlinked alias of its root, is refused before any write | OBSOLETE | The risk was a credential landing in a synced folder next to the notes; trewd writes to an operator path on the server and has no vault directory to be inside |
| 82 | rotates and revokes without taking the running vault owner lock | Issue twice while `trew mcp` holds the lock, the second differs; `--revoke` removes the file | COVERED | `TestMCPTokensAreMintedListedAndRevokedThroughTheServer` (mint, list, revoke while serve runs, through the control socket) and `TestMCPTokenCommandsWorkWithNoServerRunning`; several tokens coexist, so "rotation" is mint plus revoke |
| 100 | refuses issuance flags during revocation without changing the credential | `--revoke --key-out` is a usage error (exit 2) and the stored credential is untouched | COVERED | `cmd/trewd/mcptoken_test.go` `TestMCPTokenRefusesWhatItCannotDo`: the `-list -label` row goes through the same minting-flags guard that `-revoke -key-out` does (`mcptoken.go:47`), and the test ends by checking nothing was minted. Only the `-list` spelling is exercised |

#### `client/src/node/mcp-token-auth.test.ts` (12)

`authenticateMcp` and `readMcpToken` read the credential file on every request. The server reads `mcp_tokens` (`Store.MatchMCPToken`, `CheckMCPToken`), so every case about the file (its shape, symlinks, staging, flushes) goes with it; the bearer parsing and the refusal shapes stay.

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 54 | refuses malformed authorization before reading credential state (it.each: none, empty, Basic, 42, 44, 43 of `!`) | 401 `unauthorized`, and no file opened | COVERED | `internal/mcp/auth_test.go` `TestUnauthenticatedRequestsGetAFixedRefusal` (the same shapes and more, fixed 401 body and `WWW-Authenticate`, nothing dispatched); `internal/store/invites_test.go` `TestDecodeTokenTakesOneSpellingOnly`. "Before the store is read" holds by construction (`bearer()` returns before `MatchMCPToken`, `internal/mcp/auth.go:40`) and is not itself asserted |
| 69 | rejects a well-formed wrong token and rechecks the hash after rotation and revocation | Wrong 43-character token 401; after re-issue the old token 401 and the new one works; after revoke the new one 401 | COVERED | `internal/store/mcptokens_test.go` `TestAnMCPTokenAuthenticatesOnlyAsItself` (a one-bit change, short, long and empty tokens never match), `TestCheckMCPTokenIsTheCredentialAsItStandsNow` (revoked token no longer matches or checks); `internal/mcp/auth_test.go` `TestUnauthenticatedRequestsGetAFixedRefusal` (a revoked and an expired token get the fixed 401) |
| 84 | refuses malformed or oversized credential state (it.each: not JSON, null, [], short hash, 1025 spaces) | 503 `unavailable` | OBSOLETE | No credential file; the rows are SQLite with a schema. What survives, a store failure answered 503, is PORTED below (row mcp-http.test.ts 210); ported as `internal/mcp/retired_host_test.go` `TestAStoreThatCannotBeReadAnswers503BeforeAnyTool` |
| 94 | refuses EACCES and EIO without exposing file details (it.each) | 503 `unavailable`, no path or token in the reply | OBSOLETE as written; the store-failure half is PORTED | Same as 84: `handler.go:255` answers 503 when `authenticate` returns an error, with no Go test; ported as `internal/mcp/retired_host_test.go` `TestAStoreThatCannotBeReadAnswers503BeforeAnyTool` |
| 101 | keeps the credential outside note reads by name, leaf alias and ancestor alias | `.trew/mcp-token.json` unreadable through `read_note` by name or any symlink, and absent from listings | OBSOLETE | The server's tokens are never files in the vault, so no vault path can reach them; `internal/mcp/auth_test.go` `TestTheLogCarriesNoTokenNoteTextOrPath` covers the remaining leak (the log) |
| 110 | does not read a credential through a leaf or state symlink (it.each) | `readMcpToken` refuses a symlinked file or `.trew` with 503 | OBSOLETE | No credential file to follow |
| 120 | does not issue or rotate through staging outside the vault | A symlinked `.trew/tmp` refuses issuance, nothing printed, nothing written outside | OBSOLETE | Minting is one SQLite transaction; no staging directory |
| 135 | prints no credential after a durable-write failure | A failed durable write exits nonzero, prints nothing, keeps the old credential | SPLIT: the file half OBSOLETE; the "never a live token nobody holds" half COVERED | `trewd mcp-token -key-out` mints through the control socket first and then writes the file; a write that fails revokes the token it minted: `cmd/trewd/mcptoken_test.go` `TestAKeyOutThatCannotBeWrittenRevokesTheTokenItMinted`, and a revoke that fails too is reported with the id and the revoke command: `TestARevokeThatFailsAfterTheKeyOutFailedSaysSoLoudly` |
| 143 | keeps the old credential when flushing the staged hash fails | A failed fsync of the staged hash leaves the old file and prints nothing | OBSOLETE | The store's own durability (SQLite commit) replaces the staged file |
| 158 | prints no credential if flushing its published directory fails | A failed directory fsync prints nothing | OBSOLETE for the hash file; the key-out half is COVERED under 135 | `writeNewSecretFile` does `fsync.Dir` and returns its error, and the token minted by then is revoked, as for any failed write |
| 172 | reads the published credential back before printing it | A corrupted published file is caught, nothing printed, corrupt text not echoed | OBSOLETE | No published hash file. `writeSecretFile` reads the key file back (`pairing.go:258`), untested for a mismatch, and again after minting |
| 183 | does not print or accept a credential path that became a directory | A directory at the credential path refuses issue and authentication (503) | OBSOLETE | No credential path |


#### `client/src/node/mcp-http.test.ts` (18)

The SDK-backed HTTP host of `trew mcp --listen`, with sessions, a GET stream and a per-process reader queue. The server's `/mcp` is stateless and hand-rolled (`internal/mcp`, "The MCP transport" in docs/development.md), so every case about sessions, the SDK's routing and the client's reader queue goes; the authorization, body, origin and budget cases carry over.

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 26 | cancels queued old-key reads when rotation is observed (legacy, modern) | A read queued behind a held one is aborted when an old-token request sees a rotation, and never reads a snapshot | COVERED in its surviving form | The server has no reader queue; the guarantee that a revoked token's in-flight work never reaches it is `internal/mcp/auth_test.go` `TestATokenRevokedMidRequestLosesBeforeItsReply` (the computed reply is withheld, the next request 401) and, for writes, `TestAWriteLosesAtTheCommitBoundaryToARevoke`, `internal/mcp/write_test.go` `TestATokenRevokedMidFlightLosesAtTheCommitBoundary` |
| 74 | reads notes through the official HTTP client (legacy, modern) | `read_note` returns exact bytes; read-only listing lacks `edit_note`; `create_note` refused and writes nothing; logs carry neither note text nor token | COVERED | `internal/mcp/transport_test.go` `TestTheSDKClientSpeaksEveryVersionItSupports` (every version, exact tool list, exact bytes); `internal/mcp/auth_test.go` `TestAReadTokenCannotCallAWriteTool` (read token never shown a write tool, a hand-built call is `read_only`, nothing written), `TestTheLogCarriesNoTokenNoteTextOrPath` |
| 94 | requires current authorization on POST, GET and DELETE, even for an existing session | Missing auth 401 with realm on every method; the rotated-out token 401; an old session id 404; a fresh initialize 200; after revoke 401 | SPLIT: auth COVERED; session and GET/DELETE halves OBSOLETE | `TestUnauthenticatedRequestsGetAFixedRefusal`, `TestATokenRevokedMidRequestLosesBeforeItsReply`; GET and DELETE are 405 with no session ever minted (`internal/mcp/transport_test.go` `TestGETAndDELETEAre405`) |
| 129 | retires old sessions when an old-token request observes rotate or revoke (it.each) | An open GET stream of the old token ends | OBSOLETE | No sessions and no GET stream (`TestGETAndDELETEAre405`) |
| 159 | refuses malformed and missing bearer headers before any tool runs, with fixed pre-authentication replies | Six bad headers: 401, realm, body `unauthorized`, no token, hash, path, vault id or tool names anywhere in body or headers, no dispatch | COVERED | `internal/mcp/auth_test.go` `TestUnauthenticatedRequestsGetAFixedRefusal` (eleven shapes plus two headers, the same absent-secret check over body and headers, `dispatched == 0`) |
| 210 | an unreadable credential refuses HTTP with 503 before any tool runs | Credential unreadable: 503 `unavailable`, no dispatch, no path or token in the log | PORTED | `internal/mcp/handler.go:255` answers a store error in `authenticate` with 503 and logs `err`; no Go test drives it, and none checks that the logged error carries no token or path; ported as `internal/mcp/retired_host_test.go` `TestAStoreThatCannotBeReadAnswers503BeforeAnyTool` |
| 233 | logs bounded proxy diagnostics without trusting forwarded identity or recording secrets | Forwarded headers logged, bounded, never trusted; a token in a forwarded header never logged | SPLIT: "never trusted" COVERED; the diagnostics OBSOLETE | `internal/mcp/auth_test.go` `TestFailuresAreCountedAgainstTheConnectionNotAHeader` (failure budget keyed on `RemoteAddr`, not `X-Forwarded-For`); the server logs no forwarded headers at all, and `TestTheLogCarriesNoTokenNoteTextOrPath` holds the log to no token |
| 263 | does not expose the credential or administrative tools over authenticated HTTP | Tool list is exactly the nine read tools; reading `.trew/mcp-token.json` is an error; `sync_status` carries no token, hash, vault id or server URL | SPLIT: tool list COVERED; the credential file OBSOLETE | `TestTheSDKClientSpeaksEveryVersionItSupports` (exact `readToolNames`), `internal/mcp/auth_test.go` `TestTheAuthorizationMatrixCoversEveryTool` (generated from the registry, no admin tool exists to list); tokens are not vault files |
| 285 | checks exact origins before auth and refuses every other route without exposing state | Four near-miss origins 403 `refused` even with broken credential state; the allowed origin reaches auth; `/`, `/health`, `/mcp?key=secret`, `/.trew/mcp-token.json` 404 empty; PUT 405 | SPLIT: origin and PUT COVERED; `/mcp?query` PORTED; `/` and `/health` OBSOLETE | `internal/mcp/auth_test.go` `TestOriginsMustBeAllowedExactly` (the same near misses plus a case change, 403 `refused`, checked with and without a credential); `TestGETAndDELETEAre405` (PUT, PATCH). On trewd `/` is the device WebSocket and `/health` is health. The exact-route and no-query-string refusal (`handler.go:229`) has no test; ported as `internal/mcp/retired_host_test.go` `TestOnlyExactlySlashMCPIsServed` |
| 313 | keeps eight requests reserved after refusing overflow and routes every result to its original id | Eight held calls admitted, the ninth and tenth 429 `Retry-After: 1`, each result under its own id | COVERED | `internal/mcp/auth_test.go` `TestBudgetsAnswer429WithoutStarvingAnotherToken` "in flight" (the per-token cap answers 429 with `Retry-After`, another token still admitted; run with a cap of 1, the default 8 set in `limits.go:49`); `internal/mcp/transport_test.go` `TestIDsAreRepeatedAsSent`, `TestDuplicateIDsAreAnsweredEachOnItsOwn` |
| 358 | refuses duplicate ids before the SDK can reroute the first response | A second request with a live id is 400 and never dispatched; the first still answered | COVERED in the server's form | `TestDuplicateIDsAreAnsweredEachOnItsOwn`: the server answers both, each on its own connection with its own result, so the rerouting this refused cannot happen (docs/development.md, "Frames") |
| 387 | caps sessions, expires idle sessions, and keeps existing clients usable after overflow | 16 sessions, 4 refused 429, idle expiry 404 | OBSOLETE | No sessions: `TestTheSDKClientSpeaksEveryVersionItSupports` checks no session id is minted and no DELETE sent |
| 407 | opens one GET stream promptly, refuses a second, and drains shutdown without waiting for its peer | One GET stream 200, a second 429, close does not hang on it | OBSOLETE | GET is 405 (`TestGETAndDELETEAre405`) |
| 430 | keeps the process bound at 32 modern requests and releases slots only after work finishes | 32 held calls admitted, the 33rd 429, all 32 finish | COVERED | `TestBudgetsAnswer429WithoutStarvingAnotherToken` "endpoint" (the endpoint cap answers 429 `Retry-After: 1` even without a credential, and the admitted call finishes 200; run with a cap of 1, default 32 in `limits.go:46`) |
| 458 | holds shutdown until disconnected work actually finishes (legacy, modern) | A call whose client aborted is still running; `close()` does not resolve until it ends | PORTED | `internal/mcp/rig_test.go` shuts down with `Shutdown` but asserts nothing about waiting; `cmd/trewd/shutdown_test.go` `TestS16ATerminatedServerEndsAnUploadAsAnAckOrACleanRetry` is the WebSocket upload. No test holds an MCP call across SIGTERM; ported as `cmd/trewd/mcp_shutdown_test.go` `TestSIGTERMLetsAnAdmittedMCPWriteFinish`, `internal/mcp/retired_host_test.go` `TestAClientThatHangsUpMidWriteCommitsAtMostOnce` |
| 528 | caps declared and chunked bytes before parsing and rejects malformed UTF-8 | Declared and streamed 8 MiB + 1 both 413 `refused`; invalid UTF-8 400; bad token with bad JSON 401; the endpoint still reads afterwards | COVERED | `internal/mcp/auth_test.go` `TestBodiesOver8MiBAre413` (declared, chunked, and just under the limit read); `internal/mcp/transport_test.go` `TestMalformedFramesAreJSONRPCErrors` (invalid UTF-8, parse error); the credential is checked before the body (`handler.go` order), shown by `TestUnauthenticatedRequestsGetAFixedRefusal` |
| 566 | bounds replies even when the peer supplies a multi-megabyte request id | A 2 MiB id yields a reply of at most about 1 MiB, and the endpoint keeps working | COVERED | `TestMalformedFramesAreJSONRPCErrors` "an id of megabytes" (refused, id not echoed, reply under 4096 bytes); `TestARepliesOver1MiBAreRefusedBeforeTheyAreSent` |
| 577 | times out unfinished headers near ten seconds without exposing diagnostics | A socket that never finishes its headers is closed after about 10 s with a bare 400/408 naming nothing | PORTED | `cmd/trewd/main.go:438` sets `ReadHeaderTimeout: 10 * time.Second` on the one listener `/mcp` shares with devices; no test holds it; ported as `cmd/trewd/mcp_shutdown_test.go` `TestServeCutsOffUnfinishedHeaders` |

#### `client/src/node/mcp-http-cli.test.ts` (4)

Command-line parsing for `trew mcp --listen`, `--writable` and `--allow-origin`. The flags go with the command. The server's own flags are `trewd serve -mcp -allow-origin`.

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 29 | parses an optional listener and repeated exact origins without consuming the next flag | `--listen` with no value defaults to 127.0.0.1:3010 and does not eat `--allow-origin`; origins repeat | OBSOLETE | `--listen` goes; trewd listens on `serve -addr` and its origins are exercised by `TestOriginsMustBeAllowedExactly` |
| 46 | refuses invalid HTTP usage before touching vault state (it.each, 13 command lines) | Flag combinations and wildcard, port-0 and out-of-range listeners, an origin with a path, all exit 2 | OBSOLETE | The flags go. trewd warns rather than refusing a wildcard address with no token: `cmd/trewd/mcp_test.go` `TestServeWarnsWhenMCPListensEverywhereAndHasNoToken` |
| 63 | requires a credential before starting HTTP | `trew mcp --listen` with no token exits 1 and names `mcp-token` | OBSOLETE (the server's form is COVERED) | trewd serves `/mcp` with no token and refuses every request 401: `cmd/trewd/mcp_test.go` `TestServeRegistersMCPOnlyWithTheFlag`, and `TestServeWarnsWhenMCPListensEverywhereAndHasNoToken` logs that it will |
| 69 | cannot make a persisted read-only device writable | `--writable` on a read-only paired device exits 2 | OBSOLETE | Writes on the server are a token's scope, not a device's config; `TestAReadTokenCannotCallAWriteTool` is the scope check |


#### `client/src/node/mcp-http-process.test.ts` (11)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 100 | edits two tasks through a freshly built HTTP child and preserves both versions on another device, modern=%s | `list_notes` and `read_note` return the exact BOM/CRLF/frontmatter bytes; two exact edits apply; the before-image reads as the original; a retry with the old base is `stale`; a second paired device receives the edited bytes and the before-image; stderr carries no MCP token, device token, invite or note text; both protocol eras | COVERED | `internal/mcp/write_test.go` `TestEveryWriteToolCommitsAndKeepsItsBeforeImage` (the displaced version reads back by `previousUid` as its exact former bytes), `TestAStaleBaseIsRefusedWithThePathsOwnUID`, `TestADeviceReceivesTheWriteBeforeTheReply`; `internal/mcp/auth_test.go` `TestTheLogCarriesNoTokenNoteTextOrPath`; `internal/mcp/transport_test.go` `TestTheSDKClientSpeaksEveryVersionItSupports`; byte preservation of the edit in `internal/notes/port_notes_test.go` and the `edits` oracle vectors; a second device holding the exact bytes in `client/src/stress/mcp-races.stress.ts`. The before-image as a file on the phone is obsolete: on the server it is the pinned previous version |
| 151 | defaults HTTP to read-only, keeps stdin EOF harmless, and denies mutation calls | Without `--writable` the tool list omits mutations, a mutation call is refused, the note is unchanged; stdin EOF does not end the child | COVERED (read-only half); OBSOLETE (stdin) | `cmd/trewd/mcptoken_test.go` `TestMCPTokensAreMintedListedAndRevokedThroughTheServer` (a token is read scope by default); `internal/mcp/auth_test.go` `TestAReadTokenCannotCallAWriteTool` (a read token is not shown the write tool, a call is `read_only`, nothing written). trewd has no stdin transport |
| 173 | reaps its HTTP child even when the SDK client fails to close | The test harness reaps the `trew mcp` child | OBSOLETE | the child process is gone |
| 189 | cleanup waits for an already signalled HTTP child without sending SIGTERM again | An admitted append held at `cli/mcp:durable` finishes after one SIGTERM; the harness sends no second signal | OBSOLETE | SIGTERM drain of the host and its local seam; the durable outcome of a write interrupted by the server's death is `cmd/trewd/crash_test.go` `TestAKillAroundAnAppendResolvesOnRetryToOneResult` |
| 230 | accepts a bare loopback port without a plaintext warning | `--listen PORT` binds loopback and prints no warning | OBSOLETE | `--listen` goes; trewd's own listen warning is `cmd/trewd/mcp_test.go` `TestServeWarnsWhenMCPListensEverywhereAndHasNoToken` (a different rule: wildcard and no token) |
| 240 | warns when bound to an available named non-loopback IPv4 interface | A named non-loopback bind prints the plaintext warning | OBSOLETE | same; trewd's rule is `TestServeWarnsWhenMCPListensEverywhereAndHasNoToken` |
| 255 | the proxy may rewrite Host and forwarded headers but cannot grant note access | Through a proxy that rewrites Host and adds forwarded headers, a request with no bearer is 401 `unauthorized`; with the bearer, read and append work and the before-image reads back; the token is not logged; `forwardedFor` is logged | COVERED (bearer and headers); OBSOLETE (`forwardedFor` log line) | `internal/mcp/auth_test.go` `TestUnauthenticatedRequestsGetAFixedRefusal` (401, `unauthorized`, `WWW-Authenticate`), `TestFailuresAreCountedAgainstTheConnectionNotAHeader` (`X-Forwarded-For` is not trusted); the Go handler never reads `Host` or forwarded headers; `TestTheLogCarriesNoTokenNoteTextOrPath` |
| 316 | HTTP and sync watch exclude each other through root aliases, with kernel release after a kill | The host and `trew sync --watch` hold one vault lock through a symlinked root; SIGKILL releases it | OBSOLETE | the host no longer writes the device's vault directory; trewd's own single-instance rule is `cmd/trewd/main_test.go` `TestASecondServerRefusesTheSameDirectory` |
| 349 | SIGTERM wakes HTTP reconnect sleep while local reads remain available | With the sync server unreachable, local reads work, a create is `not_ready`, SIGTERM exits 0 | OBSOLETE | the server's tools read its own store; there is no sync client to be offline |
| 373 | serializes edits from separate HTTP sessions against the same base | Two sessions append on one base: one applies, one is `stale` with no base, the note holds only the winner, one before-image with the original bytes | COVERED | `internal/mcp/write_test.go` `TestSeventeenCompetingEditsOneSucceedsSixteenAreStale` (one commits, sixteen `stale`, two versions, one operation), `TestEveryWriteToolCommitsAndKeepsItsBeforeImage` |
| 401 | a dropped connection and SIGTERM at %s retain the lock and both versions until the write drains (six seams) | At each local write seam, a dropped TCP connection plus SIGTERM: the vault lock stays held, the admitted append finishes, exactly one before-image with the original bytes, and a retry on the old base is `stale` | OBSOLETE (lock, drain, filesystem seams); COVERED (outcome); PORTED (dropped client connection) | the six seams are the host's filesystem transaction. The outcome after the server dies at every write seam: `cmd/trewd/crash_test.go` `TestAKillAroundAnAppendResolvesOnRetryToOneResult` (absent or committed, one operation for the key, keyless retry `stale`, line in the note once) and `client/src/stress/mcp-crash.stress.ts`. A client that drops its connection while the server keeps running has no test: see PORTED 1; ported as `internal/mcp/retired_host_test.go` `TestAClientThatHangsUpMidWriteCommitsAtMostOnce`, `cmd/trewd/mcp_shutdown_test.go` `TestSIGTERMLetsAnAdmittedMCPWriteFinish` |

#### `client/src/node/mcp-http-concurrency.test.ts` (7)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 120 | serializes disjoint HTTP mutations and sends both notes and before-images to a phone | Two sessions append to two notes at once: both apply, two before-images; a fresh phone receives both edited notes and both before-images | COVERED | `internal/mcp/write_test.go` `TestAStaleBaseIsRefusedWithThePathsOwnUID` (a commit to another note never makes a write stale), `TestEditsRacingACommitAreStaleNeverNotFound`, `TestADeviceReceivesTheWriteBeforeTheReply`; `client/src/stress/mcp-races.stress.ts` (a freshly paired third device holds exactly the expected bytes). Before-image files on the phone: obsolete, as above |
| 153 | a retry on the same session and another session queues behind a held append without applying twice | A retry of a held append, on the same and another session, is `stale` once the first applies; the text appears once; one before-image | COVERED | `internal/mcp/write_test.go` `TestSeventeenCompetingEditsOneSucceedsSixteenAreStale`, `TestAnIdempotencyKeyReplaysTheRecordedResult`; `cmd/trewd/crash_test.go` `TestAKillAroundAnAppendResolvesOnRetryToOneResult` (a keyless retry is `stale`, the line is in the note once) |
| 175 | the seventeenth HTTP mutation gets busy while sixteen retain their notes and before-images | With sixteen mutations admitted, the seventeenth is `busy`; the sixteen apply with their before-images; the refused note is unchanged | COVERED | bounded admission: `internal/mcp/auth_test.go` `TestBudgetsAnswer429WithoutStarvingAnotherToken` (a request past the token's in-flight budget is 429 with `Retry-After`, the admitted ones end 200); admitted writes keep their displaced versions: `TestEveryWriteToolCommitsAndKeepsItsBeforeImage`. The local queue of sixteen is the host's |
| 225 | observed $action cancels queued mutations but preserves the admitted one across five clients, modern=$modern | Rotating or revoking the credential mid-flight: the old token gets 401, the admitted write completes, the four queued ones write nothing, one before-image, the new token reads | COVERED (revoke); OBSOLETE (rotate, file credential) | `internal/mcp/write_test.go` `TestATokenRevokedMidFlightLosesAtTheCommitBoundary`; `internal/mcp/auth_test.go` `TestAWriteLosesAtTheCommitBoundaryToARevoke`, `TestATokenRevokedMidRequestLosesBeforeItsReply`, `TestTheAuthorizationMatrixCoversEveryTool` (a revoked token reaches no tool). trewd replaces a token by minting another and revoking the old (`cmd/trewd/mcptoken_test.go`) |
| 297 | one thousand credential replacements never produce a torn authentication read | Reading `.trew/mcp-token.json` while it is replaced 1,000 times never sees a torn record | OBSOLETE | the credential file is gone; `mcp_tokens` are rows written in transactions |
| 333 | twenty modern readers report bounded admission and agree with sequential reads while a phone publishes two hundred notes | Twenty readers list, search and read a stable folder while a phone publishes 200 notes; results equal a sequential read; some see `busy`; the final listing matches the 231 files on disk | COVERED | `cmd/trewd/mcp_test.go` `TestMCPAcceptanceAgainstServe` (a device writes hundreds of versions while the agent lists, reads byte for byte, searches and compares); `internal/mcp/tools_test.go` `TestListingPagesAcrossConcurrentCommitsWithoutGhosts`; `internal/mcp/search_test.go` `TestSearchPagesAsOfThePinnedHead`; `internal/mcp/auth_test.go` `TestBudgetsAnswer429WithoutStarvingAnotherToken`. `changed_during_read` is obsolete: reads are pinned to a head |
| 413 | ending a session by %s lets its admitted transaction finish | A legacy session ended by DELETE or idle expiry while an append is held: the append still lands, one before-image | OBSOLETE (sessions); PORTED (the connection half) | trewd mints no session (`internal/mcp/transport_test.go` `TestGETAndDELETEAre405`). What remains, a client going away mid-write, is PORTED 1; ported as `internal/mcp/retired_host_test.go` `TestAClientThatHangsUpMidWriteCommitsAtMostOnce` |

#### `client/src/node/mcp-vault-process.test.ts` (3)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 54 | isolates configured vaults through the built process and holds both locks, HTTP=%s | Two `--vault` roots: `list_vaults` names aliases not directories, both locks held, a call without `vault` is an error, each vault gets its own note, history, comparison and delivery, a base from one vault is `stale` in the other, locks released at exit; delivery has no `deviceId` | OBSOLETE | trewd's endpoint serves one vault (`mcp.Config.Vault`) with no vault argument, and a token belongs to one vault. The delivery half: `internal/mcp/tools_test.go` `TestDeliveryStatusIsTheDevicesAndNeverAnAgent`, which lists device ids by design (a device id is not a credential in protocol 1) |
| 121 | holds every root until an admitted HTTP write finishes during shutdown | SIGTERM with a write held at `cli/mcp:durable`: both roots stay locked, the write finishes, exit 0 | OBSOLETE | local locks and drain; the outcome of a write the server dies inside is `cmd/trewd/crash_test.go` `TestAKillAroundAnAppendResolvesOnRetryToOneResult` |
| 170 | uses only the first configured vault's HTTP credential and rotates access to the whole explicit set | Only the first vault's token authenticates; after replacement the old token is 401; the new one lists both vaults read-only | OBSOLETE (multi-vault); COVERED (a replaced token is refused) | `internal/mcp/auth_test.go` `TestTheAuthorizationMatrixCoversEveryTool` (a revoked token reaches no tool); `cmd/trewd/mcptoken_test.go` `TestMCPTokensAreMintedListedAndRevokedThroughTheServer` |

#### `client/src/node/mcp-vault-routing.test.ts` (3)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 57 | lists only configured aliases and requires a vault choice before reading | `list_vaults` shows aliases only; `read_note` without `vault` is an error with two vaults; each vault reads its own bytes | OBSOLETE | one vault per endpoint, no `vault` argument |
| 76 | routes writes only to the selected vault and cannot upgrade another vault's read-only policy | A write to a writable vault applies; the same call to a read-only vault is `read_only`; bytes unchanged there | OBSOLETE (routing); COVERED (scope) | `internal/mcp/auth_test.go` `TestAReadTokenCannotCallAWriteTool` |
| 100 | rejects unknown aliases and keeps the single-vault argument optional | An unknown alias is an error; with one vault the argument is optional | OBSOLETE | no `vault` argument; an unknown argument is `invalid_arguments` (`internal/mcp/write_test.go` `TestWriteArgumentsAreStrictAndThePathPoliciesHold`) |

#### `client/src/node/mcp-vaults.test.ts` (5)

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 18 | parses repeatable named vaults without changing single-vault defaults | `--vault` parses and repeats | OBSOLETE | the flag goes |
| 23 | canonicalizes explicitly configured roots before acquiring any vault lock | A symlinked root resolves to its real path | OBSOLETE | local roots go |
| 31 | refuses %s vault roots before starting sessions (six kinds) | Duplicate, aliased, nested, badly named, relative and more than ten roots are refused | OBSOLETE | same |
| 52 | rejects ambiguous or irrelevant vault flags: %j | `--vault` on `sync`, and `--dir` with `--vault`, are usage errors | OBSOLETE | the flag goes; a removed flag is `no such option` |
| 59 | releases already acquired locks if a later vault is busy | Taking several locks releases the earlier ones when a later is held | OBSOLETE | multi-root locking goes |

#### `client/src/node/mcp-history.test.ts` (13, seven kept)

Seven cases use only `McpHistory`, `McpReader`, `NodeVault` and the core client; they stay, with the file's `createTools`, `InMemoryTransport` and `tool` scaffolding removed. Six go through the tool host.

| Line | Test | Asserts | Class | Where |
|---|---|---|---|---|
| 115 | pages history including an exact-full final page and reads an authenticated old body without changing disk | Three pages of one, the last ending the cursor; the oldest version reads back as its BOM/CRLF bytes; disk unchanged | KEPT | `mcp-history.test.ts`, host-free. Server side also `internal/mcp/tools_test.go` `TestHistoryDeletionsAndComparisons`, `TestReadNotePagesVersionsAndRefusals` |
| 144 | does not fetch a UID belonging to another path and bounds an incomplete version lookup | Another path's uid is `version_not_found` with no body fetched; an unbounded lookup is `lookup_incomplete` after a fixed number of pages | KEPT | host-free. Server side: `path_mismatch` in `TestReadNotePagesVersionsAndRefusals` |
| 166 | refuses excluded and symlinked history sources before asking the server | Excluded, symlinked, `.trew` and `..` paths refused before any history request; disk unchanged | KEPT | host-free |
| 179 | advances deleted pages across filtered rows and retains restorable zero | Deleted pages advance past an excluded row, count it as omitted, keep `restorable: 0` | KEPT | host-free |
| 213 | rejects non-content, oversized, corrupt and invalid UTF-8 historical bodies before publication | `restore_note` refuses a folder, a deletion, a version over 1 MiB, invalid UTF-8, an oversized body and a failed fetch; nothing is written | COVERED (the shared checks); PORTED (through `restore_note`) | `restoreNote` (`internal/mcp/mutations.go`) uses `call.version` and `versionBytes`, the helpers `read_note` uses, and `notes.DecodeNote`; those refusals are asserted through `read_note` in `internal/mcp/tools_test.go` `TestReadNotePagesVersionsAndRefusals` (`not_note_content`, `note_too_large`, `invalid_utf8`, `path_mismatch`). No Go test sends them to `restore_note` and checks nothing is written: PORTED 2; ported as `internal/mcp/retired_host_test.go` `TestRestoreNoteRefusesWhatIsNotANoteAndWritesNothing` |
| 255 | keeps a competing restore destination and does not continue onto a replacement client | A destination created while the restore fetched is `exists` and keeps the other editor's bytes; a restore that meets a replaced sync client is `not_ready` | COVERED (destination); OBSOLETE (client swap) | a create meeting a destination taken during the write: `cmd/trewd/crash_test.go` `TestAWriteThatLosesAtItsCommitCommitsNothingEndToEnd` ("the second of two slots has moved", `exists`), through `create_note`, whose `mutation.create` `restore_note` shares. The server has no sync client to replace |
| 292 | rechecks read-only mode before any restore filesystem or history work | A read-only session's `restore_note` is `read_only` before any path check, lookup or create | COVERED | `internal/mcp/auth_test.go` `TestAReadTokenCannotCallAWriteTool` (the write never runs for a read token), `TestTheAuthorizationMatrixCoversEveryTool` |
| 309 | refuses an unpageable history entry instead of declaring a false end of history | A history row too large to page is `entry_too_large`, not an empty last page | KEPT | host-free |
| 320 | advances past oversized excluded deletion metadata instead of repeating the same cursor | An oversized deletion row is omitted and the page ends with `nextBefore: null` | KEPT | host-free |
| 336 | reuses checked inventory for preview pages while checking remote-only paths and exclusions | Preview pages reuse the checked listing, check only remote-only paths, omit excluded, page with `nextAfter`; disk unchanged | KEPT | host-free |
| 357 | compares authenticated history with local bytes without changing either version | `compare_versions` of an old uid against local CRLF bytes gives one exact line change; disk unchanged | COVERED | `internal/mcp/tools_test.go` `TestHistoryDeletionsAndComparisons` (line changes, against the head); `internal/notes/port_inspect_test.go` `TestPortedCompareReconstructsTheLaterText` and the `compare` oracle vectors in `TestOracle`. "Local bytes" is obsolete: the server compares versions it holds |
| 378 | pins comparison pages to both complete bases and refuses another path's version | A later comparison page needs both bases, is `stale` after an edit, and another path's uid is `version_not_found` | COVERED | `TestHistoryDeletionsAndComparisons`: a later page without `toUid` is `invalid_cursor` (server versions are immutable, so a page names uids, not bases), another path's uid is `path_mismatch` |
| 410 | reports device checkpoints without claiming an offline or unconfirmed device received changes | Delivery states `received`, `unconfirmed`, `unconfirmed`; no device id or invite in the result; all `unconfirmed` when local delivery is not ready | COVERED (states); decision changed (ids) | `internal/mcp/tools_test.go` `TestDeliveryStatusIsTheDevicesAndNeverAnAgent` (`received`, `waiting`, `unconfirmed` for an offline device, no agent listed); the Go tool reads no invites. Device ids are listed on purpose: in protocol 1 an id is not a credential. `deliveryReady` is the host's |

### The strip ledger

Before M1 or M2 deletes a test file, each of its assertions is classified as
obsolete with the crypto or still a guarantee (PLAN §2.1). The ledger is
[plan/strip-ledger.md](../plan/strip-ledger.md): its per-test tables hold the
classification, its
[unique guarantees](../plan/strip-ledger.md#guarantees-with-no-equivalent-elsewhere)
are the ones no other test would catch, and its
[M1 outcome](../plan/strip-ledger.md#m1-outcome-the-go-side) records where each
Go test went.


The headless client's MCP host, deleted in M2 task 10 after the crypto was
gone, has its own ledger above:
[Retiring `trew mcp`](#retiring-trew-mcp-m2-task-10).
