# Competitor and Basalt research, 2026-09-22

Seven code-level investigations, one per project, each written by an agent that cloned the repository, read the code, issues and history, and in several cases ran the code to confirm a bug. This page is the synthesis. The reports carry the evidence (file and line citations into each repository).

| Report | Project | License | What it is | Verdict |
|---|---|---|---|---|
| [pkv-sync.md](pkv-sync.md) | PKV Sync (CyberKurry) | AGPL-3.0-only | Rust server, one bare git repo per vault, built-in MCP | Closest competitor. Ideas only. Its MCP is much cruder than ours and has a lost-update hole. |
| [pumice.md](pumice.md) | Pumice (search5) | Client BSD-3, server unlicensed | Plaintext-capable server with MCP, publish and share | Ideas only. Its transport history is the most useful lesson in the set. |
| [litesync.md](litesync.md) | LiteSync (KJoner) | Plugin MIT, server AGPL-3.0 | E2E sync, history, three-way merge | One adaptable file (platform probe). Strong evidence for pinned retention. |
| [syncidian.md](syncidian.md) | Syncidian (shangeethsivan) | MIT | Server with GitHub as source of truth, MCP | One adaptable file (ephemeral-storage check). A worked example of why Git must not be authoritative. |
| [obsyncian.md](obsyncian.md) | Obsyncian (aabulkhairov) | MIT (plugin only, server closed) | Hosted commercial E2E sync | No code. The best source on the new Obsidian directory review. |
| [nox-sync.md](nox-sync.md) | NoX Sync (mapherez) | GPL-3.0 | Manual sync, Go backend | No code. Two reproduced deletion bugs that shape the headless client. |
| [basalt-lessons.md](basalt-lessons.md) | Basalt Sync (ours) | MIT | The fork source | Nearly every lesson survives in copied code; the strip is where they get lost. Corrects the M0 copy list and the reuse map. |

## 1. Code we can actually use

Very little, and that is a finding rather than a disappointment: Basalt is ahead of every one of these projects on every axis the investigations measured (merge, durability, conditional writes, retention, adapter safety). Two of the six are copyleft (PKV Sync, NoX Sync) and one server has no license at all (Pumice's), so nothing may be copied from them in any form, including tests and templates.

| Take | From | License | Where it lands |
|---|---|---|---|
| **Platform probe**: case, NFC/NFD, trailing dot and space, reserved names, long names, rename into an empty slot, run through Obsidian's adapter on the device and graded safe, restricted, unsafe | `litesync:src/diagnostics/platform-probe.ts` (346 lines) | MIT, keep the notice | M2 plugin command that writes to the plugin directory (never a vault note, which would sync). Run on the Android phones in M3. |
| **Ephemeral-storage check**: longest mount prefix of the data directory in `/proc/self/mounts`, flag `overlay`, `tmpfs`, `aufs` inside a container | `syncidian:internal/config/persist.go:20-129` (about 100 lines) | MIT, credit in `docs/research.md` | M5.5 `telimus doctor` check, and `serve` refuses an empty store on such a mount without `--allow-ephemeral`. |

Ideas taken without code (the code was trivial or not good enough to copy): a release step that refuses to bump the manifest without publishing its release (Obsyncian, de-listed once for that gap); a settings-tab Tab-key fix (Pumice, three lines); a frontmatter merge by top-level key, to be evaluated only behind Basalt's merge fuzz corpus (LiteSync).

## 2. What the competitors' failures confirm

Each of these is a plan decision that at least one competitor made the other way and lost data for it. They are the strongest argument for not "simplifying" during the strip.

| Plan decision | Who got it wrong, and how |
|---|---|
| The caller supplies `base`, per note, and the server never substitutes the current head (§2.4, mcp-tools) | PKV Sync: vault-wide `parent_commit`, and the error hands back the new head, inviting a blind retry that overwrites a device edit. Syncidian: MCP re-reads the current SHA at write time. Pumice: no base on uploads, device clock decides. |
| Retention pinned by reference, not by age or count (§4.5) | LiteSync: history trimmed to 100 versions inside every upload; confirmed by running it that a phone offline across about 5 minutes of typing loses its merge base. PKV Sync: blob cleanup counted only the current tree and permanently lost attachment history (their BUG-R3-01). |
| Merge only behind validity gates; conflict copies, never markers in a live note (§4.6) | LiteSync's merge invented "Tuesday at 11" from "Monday at 10" edited two ways (run). Syncidian's merge has no base and silently keeps only one side (run). Pumice, Obsyncian and PKV Sync write `<<<<<<<` into notes, frontmatter included. |
| A missing file is never a delete (Basalt engine, rule 6) | NoX: an empty file list deleted the server copy (reproduced). Obsyncian: deletes inferred from absence. Syncidian: deletes every local file missing from a truncated GitHub tree listing, still open at HEAD. |
| One commit path for devices and MCP (§4.3) | Syncidian: two writers diverged, and the fix was a hard reset that discards accepted writes. Pumice: MCP bypassed the change log for a release, so agent renames never reached reconnecting devices. |
| Dot-segment paths refused, including for MCP (§4.1) | Syncidian: an agent can `create_note` then `move_note` to `.obsidian/plugins/x/main.js`, and sync delivers executable code to every device. |
| Every request carries an id (protocol) | Pumice removed request ids to imitate Obsidian Sync's one-request-at-a-time design and shipped three bugs in a week (stray pong resolving the wrong request, hangs, indistinguishable download frames); any timeout now kills the connection. |
| History is append-only; restore is a new version (§4.5) | PKV Sync's vault rollback force-moves the branch, breaking per-file history and "changes since" checkpoints. |
| Content-addressed chunks, not whole files (§2.2) | LiteSync stores every edit of a 100 MB attachment as another full copy. |
| Writes are fsynced (§8) | PKV Sync never fsyncs git objects or refs (libgit2 default), so an acknowledged commit can vanish on power loss. NoX trusts a blob that exists at its hash name even if a crash truncated it. |

## 3. New facts about the platform and the review

- **The Obsidian community directory changed.** `obsidianmd/obsidian-releases` no longer accepts pull requests. Plugins are submitted at community.obsidian.md and **every release** is re-reviewed by `obsidianmd/eslint-plugin`. Errors make that release uninstallable; warnings pass with a written reason. Obsyncian was stopped once by a single error and de-listed once for a manifest bump without its release.
- **Basalt fails that review today**: four `console.info` calls in `plugin/main.ts` (937, 1666, 1743, 1878) are errors (only `warn`, `error`, `debug` are allowed). Bare `setTimeout` and `globalThis` are warnings.
- **Manifest rules**: `id`, `name`, `description` may not contain "obsidian" or "plugin"; the description is 10 to 250 characters, ends with a period, and uses no colons, semicolons or parentheses. Basalt's description failed; M0 replaced it.
- **Client-side telemetry is forbidden by policy.** The plugin never gets error reporting.
- **A listed plugin installs everywhere**, including Windows and iOS, whatever §1 refuses. The plugin needs a decided behaviour on both.
- **`app.secretStorage`** exists from Obsidian 1.11.4. Pumice raised `minAppVersion` to use newer APIs and stranded users on older mobile apps. Detect it at runtime instead.
- **Obsidian's vault index does not list dot-folders**, so `createFolder` throws for them and any `.obsidian` sync built on the file tree silently does nothing (seen in NoX, PKV Sync).
- **iOS is case-sensitive and normalises Unicode; Android is the opposite** (LiteSync, measured on devices). Renaming an open note also fires `modify`. On iOS a text field next to a password field loses third-party keyboards.
- **Desktop IndexedDB is shared by every vault**, so any per-device store keyed only by path collides across two open vaults (Pumice).
- **Go and JavaScript lower-case `İ` differently** (LiteSync investigation, checked), so any case fold shared by server and client must be pinned in fixtures.
- **A health endpoint that does not take the commit lock lies.** LiteSync's backup deadlocked the server for six release candidates while `/health` answered.

## 4. Corrections to our own plan (from the Basalt pass)

These are mistakes in PLAN.md or the reuse map, not new ideas.

- **M0's copy list was wrong** and is corrected in the M0 work: `docs/findings.md` defines the review IDs cited about 400 to 600 times across 76 to 100 source files, `docs/index-journal.md` has no history sections, and `LICENSE`, `.prettierrc`, `.prettierignore`, `.gitignore`, `llms.txt` were missing. `styles.css` is `client/styles.css`.
- **`plan/reuse-map.md`** swaps `commit` and `commitMany` (`commitMany` is `session.go:1608`, `commit` is `:1968`); the class A core bundle is 4,394 lines, not 6,000, and still contains comments that say identity depends on sealing.
- **`KEEP_SEALED_BELOW` is not crypto**: it is the memory policy for attachments over 8 MiB. Rename it, do not delete it. **`pairingHosts`** has one caller, `printSetup`, which the map deletes; without it an invite from `-addr 0.0.0.0` embeds `0.0.0.0`. **`sealChunks`** carries the only record that hashing a file's chunks concurrently runs at 151 MiB/s against 56 MiB/s serially.
- **§4.9's NFD rationale is wrong**: both adapters normalise NFD to NFC before upload (`basalt:client/src/core/vault.ts:136-145`), so an NFD filename cannot trigger `badpath`. Real sources: paths over 1,024 bytes, control characters, hand-built clients.
- **NBSP divergence**: the plugin folds NBSP to a space via `normalizePath` and the Node adapter does not, so the two production clients can write different server paths for one file. Pick one rule.
- **§4.7's sidecar is not excluded**: the Linux abstract-socket lock is per network namespace, so two containers sharing a vault volume both acquire it.
- **The single biggest production lesson**: Basalt's batched commit failed 22,000 times in one day with `SQLITE_IOERR_GETTEMPPATH` in the read-only scratch image and was rescued only by a per-entry fallback. An atomic `CommitOperation` cannot have that fallback, so it must be tested inside the shipped image with `read_only: true`, and the fresh schema must carry `PRAGMA temp_store = MEMORY`.

## 5. Changes to fold into PLAN.md

De-duplicated across all seven reports and keyed to where each lands. Items that changed behaviour were decided by the owner on 2026-09-22 and are marked **Decided**, with where each now lives in PLAN.md; the rest are tests, clarifications or corrections still to fold in.

**Protocol and store (M0.5, M1)**
- `plan/protocol.md` design rules: every request and response carries `id`, every body frame is bound to its request, and why (Pumice).
- Path containment is one function after normalisation, called by every entry point that turns a wire path into a key or file path (`put`, `putmany`, rename source and destination, restore, MCP tools, any export or publish), with `..`, absolute and sibling-prefix fixtures (Pumice left upload open after fixing restore).
- **Decided 2026-09-22, adopted (PLAN §4.1):** refuse case-fold collisions on the server with a new `collision` code, for device `put`, MCP `create_note` and moves; pin the fold (NFC then one specified case fold) in `protocol-fixtures.json` with vectors for U+0130, `ß` and final sigma (LiteSync). An MCP create has no filesystem to stop `note.md` beside `Note.md`.
- **Decided 2026-09-22 (PLAN §4.1):** the server's keyspace is Obsidian's, so it refuses U+00A0 and U+202F, and `NodeVault` maps them the way the plugin already does (Basalt).
- State whether `chunkMax` bounds raw or framed bytes; fixture a random chunk at exactly `chunkMax` (Basalt).
- Chunk writes: temp name, fsync, rename, directory fsync; "exists at the hash name" never means valid (NoX). A chunk that fails verification is quarantined and reads return a typed `corrupt`, never `notfound` (LiteSync).
- Fresh schema keeps `PRAGMA temp_store = MEMORY`, `entries.n_chunks NOT NULL`, the three secondary indexes and the DSN `synchronous` pragma, diffed line by line against `basalt:server/internal/store/store.go:292-470` (Basalt).
- `hello` carries `clientVersion` and `platform`; the devices table stores them; `devices` and `doctor` show them (LiteSync).
- Regression tests: a device tombstone with a stale `base` never deletes a newer version; a rename whose source moved since `prevBase` is `stale`; a commit between a reconnecting session's catch-up read and subscribe is delivered exactly once; fan-out never writes a socket from another goroutine (Pumice).
- No credential in a URL query string, including any future event stream (NoX, Pumice).

**Retention and history (§4.5, M5, M5.5)**
- Survivor set includes, per path, every version that was head at or after the minimum applied checkpoint of non-revoked devices, so a device's possible merge base is never purged. Test: a device offline across 100 edits still merges after a default purge (LiteSync).
- Pruning never runs inside a write transaction. Orphan reclamation takes two persisted rounds, an age gate longer than any upload-to-commit window, a final check under `commitMu`, and is skipped during backup or verify; in-flight uploads survive a grace window (LiteSync, NoX).
- Tests of PKV Sync's two bug shapes: purge then restore an attachment version that is no longer a head; an operation that stored bodies then failed `stale` leaves chunks a later purge reclaims.
- **Decided 2026-09-22, adopted as a CLI command in M5.5, plugin action after v1:** "restore the vault to a UID" as one compensating `CommitOperation` (tombstones for paths created since, pins every displaced head, itself undoable), on the control socket and in the plugin, not a default MCP tool. Never a history rewrite (PKV Sync).
- `CommitOperation` tested inside the shipped scratch image with `read_only: true`, returning a typed storage failure (Basalt incident).
- `/health` takes the commit lock and runs a trivial read with a timeout; backup tests run against the real `commitMu`, never a pass-through double (LiteSync incident).

**MCP (M4, M5, plan/mcp-tools.md)**
- `read_note` states that `uid` is the version the bytes came from and the value to pass as `base`; test that a device edit between two page reads never yields mixed versions. `stale.currentUid` refers only to the named path; a commit to another path never makes an agent write stale (PKV Sync).
- Write budget is charged after the precondition passes, so `stale` refusals are cheap (PKV Sync).
- Add `changes_since {afterUid, folder?, limit?, cursor?}` with segment-prefix folder matching (PKV Sync). Promote vault health (`vault_links`: orphans, broken links with `missing` or `ambiguous`) once the link index exists.
- Optional `heading` on `append_note` and `prepend_note`, exact ATX match, `no_match` and `ambiguous_edit` (Syncidian), or record it as the first form of `replace_section`.
- `operations` records MCP `client_name` and `client_version` from `initialize`, capped and treated as untrusted (Syncidian).
- Authorization matrix generated from the tool registry and the control-socket command table (no token, expired, revoked, read, write), so a new tool cannot ship unenforced (LiteSync).
- Named M5 injection fixture: `create_note` plus `move_note` into `.obsidian/plugins/x/main.js` is refused (Syncidian).
- Streamable HTTP conformance tests if hand-rolled: notifications get 202 and no body; tool failures are `isError` results, not JSON-RPC errors (Syncidian). Never publish OAuth metadata unless OAuth exists, because clients act on it after a 401 (Syncidian).
- Fixtures for the Basalt MCP lessons that live only in `mcp*.ts` comments before those files are deleted: path cursor encoding, lone surrogates, CR-preserving paging, tag range rewrites, case-rule resolution, duplicate JSON-RPC ids, non-object frames, fatal UTF-8 decode for editability. `-addr 0.0.0.0` now exposes `/mcp`, which Basalt's HTTP MCP refused.

**Plugin and headless client (M2, M3)**
- The invite protocol handler never pairs directly: the modal shows the server URL and vault decoded from the invite, warns when the URL differs from the configured one, and changes nothing until confirmed; test it (Pumice).
- **Decided 2026-09-22, adopted (PLAN §2.3):** store the device token in `app.secretStorage` when present at runtime, with the secret id scoped to vault and device, without raising `minAppVersion`; migrate with read-back verification before removing the old field (Pumice, LiteSync).
- Replace the four `console.info` calls; move bare `setTimeout` to `window.setTimeout` (Obsyncian).
- Keep: sync start on `onLayoutReady`; no deletes from an empty or partial startup scan (test "scan returns a small fraction of indexed files"); conflict-copy names collision-proof within one second; writes into open files through the preserving replace, which must not be "simplified" into rename-aside plus create (PKV Sync, NoX).
- Headless: `telimus-sync sync --dry-run`; a vanished-root and mass-delete guard (`--allow-mass-delete`); `status` reports `behind` and `unpushed` (NoX).
- Foreground return forces a catch-up exchange even when the socket reports open; mobile settings refuse loopback URLs (Syncidian).
- Regression cases: a failed download leaves the change pending; un-ignoring a folder pulls what arrived meanwhile; two devices creating the same path offline end with one identity and both contents; a kill during first upload duplicates nothing (Obsyncian). A one-shot headless run killed after the server commit reconverges with zero conflict copies; a peer offline across two remote versions of an untouched path fast-forwards (NoX).
- M3: rename a note open in the editor and keep typing; two vaults open on one desktop editing the same relative path; a server that accepts the socket and never answers `hello`; run `scripts/open-note-smoke.mjs`; record the Pixel's Origin header; carry the unfinished Android list from Basalt's 0.7.1 fixes review (LiteSync, Pumice, Basalt).
- **Decided 2026-09-22 (PLAN §4.12):** the plugin pairs on Windows and iOS with a persistent unsupported or untested notice (the recommendation had been to refuse Windows). The safeguards: a Windows inbound refusal list, since `refusedInboundPath` covers none of Windows' reserved names or characters (this corrects [obsyncian.md](obsyncian.md) §3, which said it did), and the platform probe before any support claim.

**Packaging (M9)**
- A "Community directory submission" task: `eslint-plugin-obsidianmd` recommended config in `scripts/check.sh` and CI, failing on errors; a ledger of accepted warnings with reasons in `docs/development.md`; the submission flow.
- One release step bumps `manifest.json` and `versions.json` and publishes the matching GitHub release together, and refuses a version not greater than every `versions.json` entry (Obsyncian, Pumice).
- README "Disclosures" block in the directory's vocabulary, including that the server stores notes in plaintext and the MCP endpoint exposes them to the agent's model provider.
- Record "no plugin self-update" as a refusal (PKV Sync does it; the guidelines forbid it).

**Ideas (plan/ideas.md)**
- Git history export, one-way, never read back, derived like the search index, one commit per MCP operation (full spec in [syncidian.md](syncidian.md) §8).
- Publishing rewritten as "serve pinned versions": device-only, `publish: true`, agents cannot publish, separate origin or strict CSP and sandbox, sanitized HTML, no vault file ever executed (Pumice).
- Share one note points at a pinned `uid`; event streams replay or report `lagged`, preferably as MCP `resources/updated` (Pumice, PKV Sync).
