# Basalt lessons: what the Trew fork must not lose

Investigation of `/Users/wayne/code/basalt` at `664a963` (MIT, owner's own code, all reusable with the copyright line kept). Not a reuse map and not a design review; those exist (`plan/reuse-map.md`, `plan/astra-critique.md`, `plan/opus-critique.md`, `plan/review-synthesis.md`). This report asks three narrower questions: which hard-won lessons live only in material M0 excludes or code M2 deletes, whether the reuse map's claims hold at `664a963`, and what the plan drops that it should keep (or keeps that it should drop).

## 1. Summary

- **What was read:** all 354 commit messages (8,804 lines), `docs/findings.md`, `docs/documentation-review.md`, `docs/index-journal.md`, all five files in `docs/reviews/`, `docs/research.md` and `docs/open-work.md` where they carry platform facts, every code comment matching platform and workaround terms, and the headers and cases of all stress suites.
- **Good news:** nearly every data-loss lesson in the log is already encoded as a test or a long comment in code M0 copies. The excluded docs are mostly an index and narrative, not the only record of a guarantee.
- **The real risk is the strip, not the exclusion.** Lessons sit inside code M2 deletes or rewrites: `KEEP_SEALED_BELOW` is a memory policy misfiled as crypto, `sealChunks` carries the only record of the WebCrypto batching win, `printSetup` is the only caller of `pairingHosts`, `mcp*.ts` holds a dozen escaping and SDK quirks the Go port needs, and the fresh schema must hand-carry `temp_store = MEMORY` and `n_chunks`.
- **Two exclusions are wrong as written.** `docs/findings.md` defines the review IDs cited 608 times in 100 source files; excluding it leaves every `(R33)` and `(RR2)` in the copied code dangling. `docs/index-journal.md` has no history sections to exclude; it describes the shipped format and three source files cite it. Separately, 125 citations of `F01`..`F28` in 43 files are defined nowhere in the tree today (only in commit messages such as `9cd082b`).
- **Reuse-map spot check:** 25 claims checked, 19 hold. Mismatches: `commit`/`commitMany` line numbers swapped (in the map's own correction note), the class A core bundle is 4,394 lines not 6,000 and carries stale sealing comments, `KEEP_SEALED_BELOW` is misclassified, `printSetup` deletion takes `pairingHosts` with it, and the M0 copy list names a root `styles.css` that does not exist while omitting `LICENSE`, `.prettierrc`, `.prettierignore`, `.gitignore`, and `llms.txt`.
- **Two plan statements contradict the code.** PLAN §4.9 and M2 task 11 expect an NFD filename on disk to produce `badpath`, but both adapters normalise to NFC before upload (`basalt:client/src/core/vault.ts:136-145`), so the test cannot trigger it. And the plugin folds NBSP and U+202F to a space (Obsidian's `normalizePath`, `basalt:client/src/plugin/vault.ts:15-30`) while the Node adapter does not, so the plugin and the now-production headless client can upload different paths for the same file.

## 2. Method

Three forked readers each took a third of the commit log and classified every lesson as CODE (a test or comment in copied code encodes it), PLAN (PLAN.md says it), LOG-ONLY (only in a commit message or excluded doc), or CRYPTO-ONLY (obsolete once encryption goes). A fourth swept code comments and stress suites and checked each against the reuse map's deletion ranges. I read the excluded docs directly and verified the reuse-map claims myself with `grep -n` and `sed -n` against the checkout. Where a fork's claim looked load-bearing (NBSP divergence, NFD normalisation, the `sameVersion` MAC dependency, the container-lock argument) I re-checked it; one fork claim did not survive and is corrected in §5.

## 3. The excluded material, file by file

| File | What it is | Cost of excluding it | Verdict |
|---|---|---|---|
| `docs/findings.md` (273 lines) | Titles for R01..R51, RR1..RR9, I01..I31, R083-01..25, Codex-01..11, and the 0.6.2 review tables with regression-test links | **High.** 608 citations in 100 source files (`R01` 18 times, `RR2` 18, `R46` 17, `R33` 17, `I29` 16, `I14` 16...). Basalt's own `CLAUDE.md:56` and `docs/design.md:12` point to it. Excluding it creates exactly the "comment describing a removed mechanism" shape PLAN §7 warns about, at scale. | Copy to `docs/history/findings.md`. Add an F-index (F01..F28) reconstructed from the log, or the 125 F citations stay dangling as they already are in Basalt. |
| `docs/index-journal.md` (120 lines) | The journal's on-disk format, save/snapshot/load rules and failure table | Cited by `index-journal.ts:6`, `index-journal.test.ts:4` ("the ten properties docs/index-journal.md pins"), `stress/journal.ts:4`. There are **no history sections** in it at `664a963`; the 2026-09-08 documentation review already removed them (`documentation-review.md:28`). | Copy whole. Change M0's wording. |
| `docs/documentation-review.md` (116 lines) | Editorial record plus six "keep future docs focused" rules and factual corrections | Low. The corrections worth keeping: a plugin sync *can* update an open note; reusing a backup destination replaces its snapshot; read-only CLI mode is not a server permission and explicit repair can upload. | Exclude, but carry the six doc rules into Trew `docs/development.md`. |
| `docs/reviews/0.7.1.md` (423 lines) | The three-writer lost-edit diagnosis (R071-01) that produced protocol 7's `base`/`prevBase`, plus BOM, same-mtime, overlapping-session findings | Medium. This is the design rationale for conditional writes, which Trew keeps and extends to MCP. Its closing observations still apply: "the Go race detector checks memory access, not logical lost-update races", and "keep separate tests for transport progress, durable storage, edit preservation, and user-visible delivery; passing any one does not establish the other three". The tests it asked for were promoted (`preservation.stress.ts`, `conditional_test.go`, `delivery_overlap_test.go`). | Exclude the file; quote the R071-01 paragraph and those two sentences in Trew `docs/design.md` under concurrent branch preservation. |
| `docs/reviews/0.7.1-fixes.md` | What shipped in 0.8.0 for each finding, and "native Android acceptance remains outstanding" | Low; its tests exist. The unfinished item (TalkBack, enlarged text, keyboard open, suspension and offline resume on a real phone) is still unfinished and belongs in M3. | Exclude; move the open item to M3. |
| `docs/reviews/0.7.1-reproductions.patch`, `0.7.1-metrics.json` | Failing reproductions against `920324c`; cadence samples | None; promoted into suites and `docs/research.md`. | Exclude. |
| `docs/reviews/0.8.4-android-500.ndjson` | Raw pass timings from a Pixel 9 Pro XL at 589 files. Every `flush` is 0 ms, which is the mobile adapter having no flush primitive, not a fast one. | Low; the analysis is in `research.md:136-217`. | Exclude. |

Not excluded but not listed in M0 either: `docs/research.md`, `docs/open-work.md`, `docs/compared.md`, `docs/protocol.md`, `docs/server.md`, `docs/plugin.md`, `docs/security.md`, `docs/server-operations.md`. Source comments cite `docs/protocol.md` 39 times, `docs/design.md` 32, `docs/server.md` 21, `docs/open-work.md` 7, `docs/plugin.md` 6, `docs/compared.md` 4, `docs/research.md` 2. PLAN §2.2 itself rests on `research.md`. The M0 bullet should say "copy all of `docs/` except ..." so the citations resolve until M9 rewrites them.

## 4. Reuse-map spot check (25 claims)

| # | Claim in `plan/reuse-map.md` or PLAN | Checked at `664a963` | Holds? |
|---|---|---|---|
| 1 | `internal/fsync` 31 lines, A | `fsync.go` 31 lines | Yes |
| 2 | `internal/dirlock` 165, A; `Shared` at `dirlock.go:77` | 165; `Shared` at 77-80 | Yes |
| 3 | `chunks.Store.Size(vaultID, name) (int64, bool)` at `chunks.go:331` | Exact | Yes. Its doc comment at 325-330 also talks about ciphertext; add it to the "reword" list with 1-11 and 30. |
| 4 | `open.go:31` is `user_version` 1 | `const SchemaVersion = 1` at 31, written at 130 | Yes |
| 5 | `conditional.go` 73 lines, retirement predicate at 11, `purgeSurvivorUIDs` at 23, pure path logic | Exact | Yes |
| 6 | `hub.go`, `delivery.go`, `http.go` 316 lines, A | 113 + 67 + 136 = 316 | Mostly. `http.go:112-114` justifies disabled WebSocket compression with "bodies are ciphertext", and `:109` says "basalt speaks websocket only". Both need edits; class A is not quite "unchanged". |
| 7 | `Entry.Validate` mac/parent checks at `store.go:663-668` | Exact | Yes |
| 8 | `MaxPathLen` at `store.go:72-75`; `ValidDeviceID` at 2595 | 72-75; the function is at 2599, its comment at 2595 | Yes |
| 9 | `store.go:410` shows entries carry client `ctime`/`mtime` | 410 opens `CREATE TABLE entries`; columns at 415-416 | Yes. The same table's `n_chunks` (426-439) is absent from PLAN §3.3's schema list and must be kept (see §5.4). |
| 10 | `commit` at `session.go:1608`, `commitMany` at `:1968` (the map's own correction) | **`commitMany` is at 1608 and `commit` at 1968** | **No, swapped** |
| 11 | Batch failure falls back to single commits at `session.go:1664` | 1664-1689 | Yes; see §5.4 for the incident behind it |
| 12 | `handleResend` (2161) receives uploads via `readBodies` (2209) | Exact | Yes |
| 13 | `wire.go` `Proto`/`MinProto` 27-28, `Crypto` 39 | Exact | Yes |
| 14 | `server.go` `Credentials`/`Grant`/`Authenticator` 136-179, `registrarsOn` 438, `MinClaimLength` 694, `DerivedAuth` 730-799 | Types at 149, 168, 179; others exact | Yes |
| 15 | `authorization.go` 45 lines, drop the registrar branch | 45 lines; `authorizedMutation` takes `commitMu` at 15-16 | Yes |
| 16 | Core class A bundle, "6,000 lines, change: None" | **4,394 lines.** `index-state.ts:100-106` says content identity works because "sealing is deterministic; see src/crypto.ts" and `:327-352` talks about re-sealing. `latency.ts`, `merge.fuzz.ts`, `merge.fuzz.run.ts`, `test-async.ts` are in no table. | **No** (count, and "None" hides comment rot) |
| 17 | `chunk.ts` `SEAL_OVERHEAD` at 31 and 214; `looksLikeText` at 506-528 | 31, 214; `TEXT_EXTENSIONS` at 506, `looksLikeText` at 530 | Yes, but see §5.2: the comment at 206-213 is the marker-byte lesson and must survive the deletion. |
| 18 | `crypto.ts` extraction line numbers (`randomBytes` 189, `chunkName` 749, `plainDigest` 767, `isChunkName` 779, `hex` 832, base64url 848/885, `worthDeflating` 571, `PROBE_BYTES` 581, markers 491-492, `inflateBounded` 672, `MAX_CHUNK_PLAINTEXT` 637) | All exact | Yes, but `sealChunks` (609) and the chunk-size measurements (505-510) are not in the move list and carry lessons (§5.2). |
| 19 | `engine.ts` delete `KEEP_SEALED_BELOW` (5222) | Used at 2338, 2380, 3828 to choose between keeping bodies in memory and re-deriving them from offsets for files over 8 MiB | **No, misclassified.** It is a memory policy. Rename (`KEEP_BODIES_BELOW`), do not delete. |
| 20 | `engine.ts` `mustBeOurs` 272, `authFor` 1329, callers 2544/2652/2700, `assemble` "4471" | Exact except `assemble` starts at 4441 | Yes |
| 21 | `transport.ts` `PROTO` 48, `CRYPTO_SUITE` 40/1196/1240/1319, `helloAsRegistrar` 1226, `redeem` 1300, `sendBodies` 1617, `register` 2063, `invite` 2111, `rotate` 2316, fetch hash check near 2007, `encodedEntryBytes` 274-280 | All exact (`encodedEntryBytes` at 278) | Yes |
| 22 | Plugin `vault.ts` class A, `plainDigest` import at 60, `process()` text replace after backup | Import at 62; `adapter.process` at 988 runs only after a verified visible backup (960-977). Seal comments at 394-397, 471, 478, 684-690. | Yes, with the comment rewording list incomplete |
| 23 | `main.go` delete `printSetup` (696) | `printSetup` is the only caller of `pairingHosts` (643), whose wildcard-address test is `main_test.go:1195` | **Partly wrong.** Keep `pairingHosts` for the invite printer. |
| 24 | `sameVersion`'s mac/parent compare at `main.go:1380-1383` | Exact. Chunk lists are compared element by element at 1384-1391, so dropping MAC does not weaken the purge proof. | Yes |
| 25 | M0 copy list: root `styles.css`, `.github/workflows` | `styles.css` lives at `client/styles.css`; workflows exist. `LICENSE`, `.prettierrc`, `.prettierignore`, `.gitignore`, `llms.txt` are not listed. | **No** (see §7) |

Also confirmed: `keys_test.go:557` is `TestARedeemRacingARevokeLeavesTheVaultConsistent` and 520-535 is the rollback assertion; `mcp-read.ts:305` is the escaped-literal `RegExp`; `exclusion.ts:21-26` documents the abstract socket; `ops.go` + `service.go` = 704 lines.

## 5. Gotchas and platform quirks, with evidence and where each is kept

Class key: **CODE** encoded in a copied test or comment; **PLAN** stated in PLAN.md or `plan/*.md`; **AT RISK** only in excluded docs, a commit message, or code the strip deletes; **CRYPTO** obsolete without encryption. Commit hashes are Basalt's.

### 5.1 Obsidian API and plugin runtime

| Gotcha | Evidence | Kept where | Class |
|---|---|---|---|
| `normalizePath` changes which file you mean: NBSP and U+202F become spaces, result is NFC, empty becomes `/`. A note with NBSP in its name vanished from listings. Keep an `actualName` map back to the disk spelling. | `cd3b209`; `plugin/vault.ts:15-30`, `:305-315`, `fake.ts:66-94` | Plugin adapter | CODE. **Node adapter does not fold NBSP** (no U+00A0 handling in `cli/` or `core/`), so the two production clients disagree. Not in PLAN. |
| `normalizePath` does not resolve `..`; the adapter must refuse it. | `plugin/vault.ts:704-707` | Plugin adapter | CODE |
| `FileSystemAdapter.write`/`writeBinary` truncate then write, so a crash leaves a short note. `DataAdapter.write` for the displaced log truncated to `{"at":".`. | `c0e972d` (RR3); `plugin/vault.ts:38-43`, `displaced.ts:55-71` | Adapter, displaced log | CODE |
| `Vault.process`/`adapter.process` is read, callback, write in place with no temp file (read out of `obsidian-1.13.7.asar`). Usable only after a verified visible backup, with no `await` between compare and return. | `dc757b6`; `plugin/vault.ts:950-1000` | Adapter | CODE (PLAN names it only as "`process()` text replace") |
| `rename` refuses an occupied destination on desktop and Capacitor, except a case-only rename on a folding filesystem, which is the only in-place case fix on macOS. `replace` must publish with `create`, not `write`. | `8ee6db7`; `plugin/vault.ts:43-51`, `fake.ts:551-566` | Adapter and fake | CODE |
| Capacitor's destination check can race; `create` re-checks `exists` just before renaming. | `plugin/vault.ts:1364-1385` | Adapter | CODE |
| A folder rename fires one event for the folder and one per descendant. | `7ae51de`; `fake.ts:564-572`, `vault-events.test.ts:105` | Fake and test | CODE |
| `adapter.list` on a missing directory throws; the index includes the root as `/`. | `7ae51de`; `fake.ts:31-32`, `:657-676` | Fake | CODE |
| Obsidian's index never lists dot-prefixed paths, so a write there is later reported deleted. Hence "any dot segment never syncs". | `ae7199e`, `7ae51de`; `fake.ts:657-676`, `core/paths.ts` | Code, PLAN §4.1 | CODE+PLAN (PLAN does not give the reason) |
| A path never uploaded must never be accepted: a peer wrote `.obsidian/plugins/x/main.js`, which Obsidian executes on reload. `startsWith("..")` also wrongly refused `..hidden.md`. | `997ba83`; `engine.ts:4994`, `:5179`, `cli/vault.ts:949`, `plugin/vault.ts:708-721` | Engine and adapters; PLAN §4.1 adds a server check | CODE+PLAN. With a plaintext server that an injected agent can write through, this client-side refusal is now also the defence against a compromised server; §3.6 should say so. |
| `Vault.configDir` can be renamed and need not be `.obsidian`; `manifest.dir` is optional (it once made `undefined/index.json` sync itself). A non-dot config folder is invisible to the server's `badpath`. | `cd3b209`, `0c08cf4`; `plugin/vault.ts:394-405`, `main.ts:1079` | Plugin | CODE (not in PLAN) |
| Config sync is refused because Obsidian holds config in memory and writes it back, silently undoing a remote change. | `db2589d`; `docs/design.md` | Design doc, PLAN scope refusal | CODE+PLAN |
| Both trashes keep only the basename and number collisions `note 2.md`; park deletions in a hidden folder, never at a conflict name. Desktop `trashSystem` throws where Capacitor returns false. | `82fa0f3`, `370a1b5`; `fake.ts:446-500`, `plugin/vault.ts:150-170`, `:1463-1507` | Adapter | CODE |
| Register vault events inside `onLayoutReady`, or opening a vault fires a create per file. | `f0747c3`; `main.ts:404-411`, `main.test.ts:276` | Plugin | CODE |
| Without the `rename` event a move is a delete plus an add and the deleted list fills with phantoms; a headless scan cannot see renames at all. Events say when to look; the scan decides. | `7b8c457`, `1b6cb01`; `main.ts:398-428` | Plugin, index-state | CODE |
| "Sync now" must `view.save()` every Markdown leaf first because autosave has its own delay; deferred tabs have no `save`. | `main.ts:1405-1413` | Plugin | CODE |
| Obsidian can unload a plugin mid-await; guard every save with the run generation and re-check after the await. Number runs so a superseded one cannot wake from backoff and paint "stopped". | `72d1edf` (F23), `53dd265`; `main.ts` `saveDuringRun`, `main.test.ts:2068` | Plugin | CODE |
| `registerCliHandler` needs 1.12.2, so `minAppVersion` lied; the first guard skipped event registration. | `fb1c0cc`; `main.test.ts:3542` | Plugin test | CODE |
| The plugin bundle must import only `obsidian`; a `node:` import passes every test and fails only on a phone. Desktop fsync reaches Node through `globalThis.require`. | `1b5a2c3`, `a919524`; `build.test.ts`, `plugin/vault.ts:255-300` | Build test | CODE |
| `adapter.append` is public from 1.7.2; `appendBinary` needs 1.12.3 and is not used. | `plugin/vault.ts:1583-1612` | Adapter | CODE |
| Keep the `TFile` at its path so open editors follow it; a tab does not follow a temporary rename. Proven only by `scripts/open-note-smoke.mjs` in a real Obsidian. | `plugin/vault.ts:10-12`; `0.7.1-fixes.md:93-96` | Script copied, but in no milestone gate | AT RISK (process) |
| Since 1.13, settings-tab rows are rounded cards; restyling `.setting-item` breaks them. `mod-sidebar-layout` collapses a modal title to 0x0. `addClass("")` throws on a real `DOMTokenList`. | `62e28a7`, `e99c996`, `dae9dcb`; `styles.css:71`, `stub.ts:172` | Partly CSS only | CODE / AT RISK (low) |
| Obsidian gives some plugin elements `user-select: none`, so a secret could not be copied. Applies to the new invite string field. | `8279977` | `client/styles.css` only | AT RISK (low) |
| The `?` help used `aria-label` tooltips, which need hover and are dead on phones. | `8279977`, `65cc735`; `main.ts:2803-2812` | Plugin | CODE |
| Stubs must be as strict as the DOM and Obsidian; a stub typing an async callback as `void` made test awaits meaningless. Layout bugs were found only by screenshots, three times. | `8f5af50`, `8f95bfe`, `d06b5f5`, `de4d519` | `stub.ts`, screenshot ratchet | CODE |

### 5.2 Mobile (Android, iOS, Capacitor)

| Gotcha | Evidence | Kept where | Class |
|---|---|---|---|
| Android suspends a backgrounded WebView (screen off, dozing); sync is foreground-only and a large first sync will not finish in a pocket. A 10,000-note first reconcile was not obtained in 30 minutes because the phone dozed. | `267a2ce`, `fbc283f`; `research.md:186`, `:195-217`; `design.md:270`; `bench-android.ts:325` | `design.md` support table (copied) and `research.md` (not in M0 list) | CODE/doc. PLAN never states foreground-only; M3 should. |
| Mobile has no status bar (`addStatusBarItem` does nothing), `navigator.clipboard` may be absent, mobile keyboards autocapitalise addresses and keys. | `afce478`, `807e076`; `main.ts:276-280`, `:2882`, `:2900`, `:3099` | Plugin | CODE |
| `Platform.isMacOS` is true on iPad and iPhone; check mobile flags first. | `main.ts:2958-2972` | Plugin | CODE |
| A socket stranded by sleep looks connected. On `visibilitychange` to visible or `online`, `probe()`, which kills it after 2 s idle. Stop activity and delivery polling while hidden. | `plugin/resume.ts:1-14`, `main.ts:748-770`, `transport.ts:2430`, `visible-poll.ts` | Plugin | CODE |
| Every adapter call crosses the Capacitor bridge onto a FUSE mount on Android, so scan from `getAllLoadedFiles`, not the adapter. `timedVault` exists to measure the per-call cost. | `afce478`; `core/vault.ts:800-812`, `engine.ts:716` | Core | CODE |
| Mobile exposes no flush primitive, so mobile power-loss durability is weaker (every `flush` in the Android trace is 0 ms). | `design.md:85-89`, `index-journal.md:101`; `0.8.4-android-500.ndjson` | `design.md` (copied), `index-journal.md` (excluded) | CODE/doc |
| Streaming via `getResourcePath` plus ranged `fetch` works on desktop; Capacitor resource URLs are untested, so fall back to whole-file reads. A handler ignoring `Range` returns the whole file; a short answer means the file changed since scan. | `967e244`; `plugin/vault.ts:410-485` | Adapter | CODE |
| Downloads assemble the whole file in one buffer (about twice the file size at peak), which is why `-max-file` defaults to 64 MiB. The 2.7 MB per MiB figure behind that default predates windowed sealing and was never re-measured on a phone. | `open-work.md:7-37` | `open-work.md` (not in M0 list) | AT RISK. Also bears on Go `Assemble` for MCP reads. |
| JavaScriptCore (iOS) does not optimise a hot loop inside an async generator: 39 MiB/s against 700 MiB/s once hoisted. V8 has a different slowdown. | `core/chunk.ts:452-460` | Chunker | CODE |
| Upload drain polling at a fixed 5 ms kept a phone radio and CPU awake 200 times a second during a 64 MiB upload; it backs off 5 to 50 ms. Delivery polling at 250 ms was R083-19. | `transport.ts:2600-2615` | Transport | CODE |
| An identical index save must be skipped by comparing strings, or a settled vault fsyncs megabytes every 30 s (battery and flash wear). A quiet pass stamping `synctime` journaled the whole index every tick. | `0dec65c`, `69dc164` | Index stores, `settled-writes.test.ts` | CODE |
| Capacitor origins `capacitor://localhost` and `http://localhost` are admitted by default but have never been observed from a device; desktop is exactly `app://obsidian.md`. Every Go test passed while no plugin could connect because Go clients send no Origin. | `37eaa4e`, `94b7093`; `http.go:15-40`, `origin_test.go:29` | Server | CODE (the unverified mobile origin is not in PLAN; M3 should record the origin the Pixel actually sends) |
| `adb shell` is a second shell: an unquoted `&` in a URI split the command in three. Checking foreground before sending the URI that brings Obsidian forward skipped a whole run. | `fbc283f`; `research.md:170-190` | Bench harness | CODE |
| Native Android acceptance (TalkBack, large text, keyboard open, suspend and resume, two devices on one note) was never completed. | `0.7.1.md:417`, `0.7.1-fixes.md:106-111` | Excluded review only | AT RISK |

### 5.3 Filesystem semantics (headless client and fsync)

| Gotcha | Evidence | Kept where | Class |
|---|---|---|---|
| Index fsynced but note not: a power cut makes a missing file with a matching `synchash` look like a user delete, which propagates. Flush files, then directories, then save the index. | `dc9944f`, `ace4139`; `vault-race.test.ts:365` | Adapters, tests | CODE |
| A fixed temp name truncated and renamed away a user's file at that name. Unique `wx` names, excluded from listings and the watcher. | `dc9944f`; `faults.ts:248`, `vault-race.test.ts:98` | Code; PLAN §4.1 reserves `.trew-tmp-` | CODE+PLAN |
| Cross-filesystem copy-then-remove read back only through the page cache. Fsync every file and every directory deepest first before removing the source. `link` across mounts fails `EXDEV`; check the filesystem before the destructive step. | `bf7df34` (F13), `c51bd6a` (R37), `72d1edf` (F25); `cli/vault.ts:2505-2520`, `:2938-2948` | Node adapter | CODE |
| A "read-only" scan renamed NFD to NFC over a file an editor had just created. APFS stores both forms as one inode, so compare dev/ino and use `link`. HFS+ stores NFD whatever it is given, so remember accepted renames or the vault renames forever. | `bf7df34` (F12); `cli/vault.ts:1095-1118` | Node adapter | CODE |
| macOS folds NFC/NFD at lookup but keeps the disk bytes, so tests on a Mac pass while ext4 loses a note; a spelling injection simulates non-folding filesystems. | `cli/vault.ts:205-216` | Node adapter | CODE |
| Always folding lookups put `Work/new.md` into `work/` on Linux; APFS resolves aliases lowercase misses (final sigma, sharp s), so refuse spellings absent from `readdir`. | `1747ae7`; `cli/vault.ts:165-172`, `:770-803` | Node adapter; also `mcp*.ts` | CODE for the adapter; **AT RISK for the Go MCP**, which resolves paths against the store and must decide case behaviour explicitly |
| Two server paths that fold together alias one local file; refuse those incoming versions. A case-only rename wrote then deleted the same file. Two names that normalise together block that pair only; leaving them out without telling the engine deletes them on the server. | `87c171a`, `20a8d94`, `cac0651`; `engine.ts:3553-3614`, `core/vault.ts:263-285`, `plugin/vault.ts` `ambiguous()` | Engine, adapters | CODE (PLAN M0.5 lists case collisions only as fixtures) |
| A search skipping collision paths must say so on every page, or the last page implies completeness. | `35ec87f` | `mcp*.ts` only | **AT RISK** (Go search must carry it) |
| `O_NOFOLLOW` on reads: a symlink to `.basalt/config.json` passes containment and leaks the credential. macOS answers `EMLINK` as well as `ELOOP`. Symlinked folders turned writes outside the vault; a `.trash` that links out turned delete into export. | `b043e9f`, `676e158`, `72d1edf` (F24); `cli/vault.ts:1762-1770` | Node adapter | CODE |
| `__proto__`, `constructor`, `toString` are legal filenames; path-keyed maps must be `Object.create(null)`. | `d588bf5` (F14) | Engine, journal | CODE. The Go side has no such trap, but any TypeScript fixture loader does. |
| mtime-only change detection misses same-size edits within one tick (HFS+ 1 s, FAT 2 s) and editors that restore mtime; the change time is the only witness, and excusing a `changeId` difference was tried and failed. | `2b3d611` (R071-03); `index-state.ts:339-352`, `core/vault.ts:410-420` | Index state | CODE |
| Directory-fsync errors meaning "not supported" (ENOTSUP, EINVAL, EPERM on network, FUSE, Windows) are ignored; EIO and ENOSPC are fatal. A blanket catch conflated them. | `cddca48`; `cli/vault.ts:3340-3353` | Node adapter | CODE |
| Stat concurrency capped at 64 (EMFILE, network filesystems); gate the leaves, not the recursion. `UV_THREADPOOL_SIZE=16` made the walk 2.6x worse. | `bb838f5`, `8658a8f`; `cli/vault.ts:3294-3302` | Node adapter | CODE |
| Node `birthtime` is unreliable; reconciliation must never read ctime as creation. | `08919e0`; `cli/vault.ts:1705` | Node adapter | CODE (MCP writes should not start either) |
| Node `readFile` of a small file returns a view into a shared pool; only `new Uint8Array(x)` copies. | `87a04c2`, `223a422`; `stress/harness.ts:109-112` | Harness | CODE |
| Stale-lock takeover was wrong five times (R03, R20, R34, R40, R44/R49), four of them handing one vault to two writers. Kernel exclusion only: `O_EXLOCK` on macOS, abstract socket on Linux. The socket must be named from the resolved path; a `FileHandle` GC finalizer can drop the lock. | `0ac30da`, `128c42d`, `e81dc6e`; `lock.ts`, `exclusion.ts` | Node adapter; PLAN §2.6 | CODE+PLAN |
| **An abstract socket is per network namespace**, so two headless-client containers sharing a vault volume on one Linux host both acquire the lock. | `f2cee53` (I27) | `exclusion.ts:143` mentions the namespace, not the consequence | **AT RISK**, and PLAN §4.7's sidecar is exactly this deployment |

### 5.4 Server, SQLite, and storage

| Gotcha | Evidence | Kept where | Class |
|---|---|---|---|
| **`disk I/O error (6410)` is `SQLITE_IOERR_GETTEMPPATH`:** the image is `FROM scratch` and `read_only`, a `SAVEPOINT` wants a statement journal in a temp directory, and every batch failed 22,000 times in a day. Fix: `PRAGMA temp_store = MEMORY` plus fallback to one commit per entry. The pragma was not proven to be the cause. | `452eb72`; `store.go:292-304`, `session.go:1664-1689` | Code | CODE, but PLAN §3.3 says the schema is written fresh and does not list the pragma; and PLAN §4.3 gives `CommitOperation` **no fallback**, so the same failure would make every agent write fail. FTS generations, `VACUUM INTO` backups and large sorts also want temp space; under `temp_store = MEMORY` they use RAM instead, so a large index rebuild is a memory question. |
| A failure that repeats identically forever is one nothing learns from; the server logged the same line 22,000 times. | `452eb72` | Commit message | AT RISK (maps onto M5.5 alerts) |
| A chunk list that lost its tail passed the ord and size checks; `n_chunks` records what the writer wrote. | `496f225`; `store.go:426-439` | Schema | CODE; must be in the fresh schema (without the `-1` legacy value) |
| `Quarantine` removed a body without the commit lock, breaking "committed implies serveable". | `496f225` | chunks, session | CODE. `CommitOperation` must take the same lock as quarantine and sweep. |
| A chunk is visible at rename and durable only at the directory fsync; `Has()` answered from visibility, so a second writer acked an unflushed chunk. The fix deadlocked on a batch holding the same chunk twice; presence is withheld while a name is being published. | `9cd082b` (F05), `0527f7b`; `chunks.go:110-123`, `writer_test.go` | Chunks | CODE |
| Purge swept bodies of in-flight uploads (unreferenced until commit); two thirds of pushes never committed. Grace window on body mtime. | `08f2eb2`; `chunks.DefaultGrace` | Chunks | CODE. MCP prepares bodies outside the lock (PLAN §4.3 step 3), so the grace window now protects agent writes too. |
| Health from `SELECT 1` passes on a read-only database; begin and roll back a write. `statfs` says mounted and roomy while a remount refuses every create; probe with a real create. An unmounted chunk directory is invisible to SQLite on another filesystem. | `0527f7b`, `2f4f0e3`; `health.go:66-77`, `:130-140`, `chunks.go:905-920` | Health | CODE (not in PLAN; `trew doctor` should reuse these probes, not reinvent them) |
| `VACUUM INTO` resets the change counter, so backup identity is a digest; backups verify themselves; one legacy fault must not veto every backup forever. | `eb76632`, `0527f7b`, `496f225` | `backup.go` | CODE |
| `verify` exited 0 on an empty store, so `verify && rm -rf OLD` deleted the last copy. | `356fb40` | `main_test.go` | CODE |
| A mistyped `-data` created an empty database and "backed it up". Only `serve` creates the directory; refuse before taking the lock, which creates it. | `845f057` | main tests | CODE |
| Read-only open does not migrate, so an older backup failed with "no such column". | `99c47e8` (R48) | `open.go` | CODE |
| SQLite read a `?` in the data path as URI syntax. | `findings.md` 0.6.2 table; `path_test.go` | Store test | CODE |
| `entry_chunks WITHOUT ROWID` was declined (+36% inserts, but a table rebuild). A fresh schema gets it free. Backup `ORDER BY` defeated a covering index; `Deleted()` needed `entries_by_prev`. | `fa5f549`, `c1985d3`; `store.go:455-470` | Schema comments | CODE; the WITHOUT ROWID decision is LOG-ONLY and worth making deliberately in M1 |
| `serve` refuses to start with `-max-file` below an existing file; the systemd unit once dropped the flag and `Restart=always` looped. | `1886f52`, `aaa2e79`; `serve_ceiling_test.go` | Code | CODE |
| "listening on" was printed before bind; bind before the startup chunk walk. Shutdown waited 1 s instead of for sessions to reach zero. Stop deadlines live in three files in two languages (Docker's 10 s was too short). | `2f4f0e3`, `650e11f`, `cddca48` | main, shutdown tests | CODE |
| Purge cannot run through `docker exec`; it needs the server stopped and an exclusive lock, so it runs as its own container. | `e8bb695` | `docs/server.md` | Doc (rewritten in M3/M9; keep the sentence) |
| An invite embeds the server URL and nothing overrides it, so a device cannot be pointed at a rehearsal copy on another port. | `bc18bb6` | `docs/server.md` | AT RISK; M5.5's restore rehearsal on a separate port needs a URL override in the invite flow |
| Docker named volumes arrive root-owned; the image ships `/data` owned by 65532. `ProtectHome` breaks a unit whose data lives under `~`. | `b1b6961`, `afce478` | Dockerfile, main tests | CODE |

### 5.5 WebSocket and protocol

| Gotcha | Evidence | Kept where | Class |
|---|---|---|---|
| Silence is not death: an idle timeout dropped settled vaults every five minutes. Ping every 45 s with a 15 s pong, only while parked in `Read` with nothing queued, because a pong is processed only inside `Read`. | `8eb1321`, `53dd265`; `server.go:80-97`, `session.go:444-470` | Server | CODE (`plan/protocol.md:148` keeps the numbers) |
| The server must echo a device's own write as `entries: []`; skipping leaves the cursor behind, sending the payload makes the device re-recognise itself. If the ack is lost after the echo, every later upload of that path is stale forever unless the client asks for the head. | `cd2827a`, `f74d344` (R083-01) | Session and engine tests | CODE |
| Concurrent commits were announced out of UID order because the store lock was released before fan-out; `commitMu` spans append and broadcast, and the test forces the interleaving because racing never reproduces it. | `cd2827a` | Session, hub | CODE+PLAN §3.2 |
| A commit-time refusal of one entry ended the session, so committed entries were never acked and retries duplicated every version. Refusals are per entry. | `628a513` | Session | CODE+PLAN §4.3 |
| Replies matched by position caused three bugs; use request ids, and a fetch answers with a header naming the body count or an error, never bodies then an error. | `57c6fc3`, `650e11f` | Wire, `docs/protocol.md` | CODE; must survive the `plan/protocol.md` rewrite |
| `busy` stays one code (an unknown code is non-retryable, so splitting it strands a device); a full vault is `full`, not `busy`. | `8cfd782`, `53160b8` | Session comment | CODE; add to `plan/protocol.md` |
| A leftover body from an abandoned fetch was assembled into the wrong note; check each body against its requested name in the transport, and bound the queue. A fetch timeout was armed and never disarmed because answers are binary frames. | `3574b16`, `237e195`; `transport.test.ts:1225-1254`, `transport.ts:690-694` | Transport | CODE; the name check must run on decoded raw bytes after framing moves into the transport |
| JSON frames of `null`, a number or an array escaped `JSON.parse` handling as a `TypeError`, leaving a dead open socket. | `c2d76c0` (F17) | `transport.test.ts` | CODE (TS). The Go MCP JSON-RPC handler needs the same four cases. |
| The client took inbound limits from the server and a missing field meant no limit; use `OWN_LIMITS` and the tighter of the two. Size and chunk count bounded separately made their product the ceiling; negative or `MaxInt64` sizes shrank the batch budget, so saturate the sum. | `7d75bec`, `05fe9aa`, `2f4f0e3` | Engine, session | CODE; PLAN's `sizeAccountedFor` must keep saturation |
| "No chunks" had three wire shapes (omitted, null, empty); a zero-byte file had two. A declared size with no chunks is byte-identical to an empty note and empties it without a trash copy. | `05fe9aa`, `cd2827a`, `35ba52a`; `store.go:260`, `:682` | Store | CODE+PLAN §2.2 |
| A chunk cut at the server ceiling was refused permanently once overhead was added, hidden for a long time because test data compressed. | `ec11e0e`; `chunk.ts:206-213` | Chunker comment (deleted with `SEAL_OVERHEAD`) | CRYPTO in form; the lesson applies to the frame marker byte (PLAN M0.5 task 2 names it) |
| Test with incompressible, aperiodic data; generators cycling a dozen words faked 80% dedup and hid defects. | `88233ea`, `237e195`, `fe5bcfb`; `stress/harness.ts:72` | Harness | CODE |
| The browser Origin is `app://obsidian.md` and coder/websocket rejects cross-origin by default; log the refused origin with the flag that would admit it. | `37eaa4e` | `http.go`, `origin_test.go` | CODE+PLAN M4.2 |
| Retrying an invite under the same id hit a primary-key conflict, reported as retryable `internal`, which looped forever. A hello with both a token and an invite ignored the invite. Invite and device ids starting with `-` look like shell options (about 1 in 64). | `650e11f`, `356fb40` | `invite_test.go`, `store.go` | CODE; the token-invite rewrite must keep all three |
| The served-vault check ran on only one route; check before lookup and before spending an invite. | `5b57ce2` (F19) | `refuseUnservedVault` | CODE |
| The release version leaked on pre-auth refusals; a sentinel test covers every pre-auth response. | `1886f52`; `disclosure_test.go` | Server | CODE; extend to `/mcp` 401 and 429 |
| A client ahead of its server (restored backup, wrong vault) must refuse rather than continue while UIDs are reissued. | `cd2827a`, `7d75bec`; `refuseIfBehind`, `cli.ts:1239` | Engine | CODE+PLAN §2.8 epoch |
| Unlink left the index behind, so the next pairing trusted a cursor from another server and skipped uploads. | `37eaa4e` | Unlink tests | CODE; M10's re-pair depends on it |

### 5.6 Merge and conflict

| Gotcha | Evidence | Kept where | Class |
|---|---|---|---|
| Three writers editing different lines converged with one edit absent from every current file; the server accepted writes without checking the head moved. | `0.7.1.md:44-97` (R071-01); `1b00d09` | Conditional writes, `preservation.stress.ts` | CODE+PLAN (the diagnosis itself is in an excluded file) |
| BOM decoding gave the replacement the wrong baseline and produced needless conflict copies; keep the BOM and compare original bytes. | R071-02 | Tests | CODE |
| `patch_apply` fuzzy-matches hunks, so an edit to section 3 landed on section 6 with every flag true; merge both ways and compare line multisets. Overlapping ancestor regions are refused. | `9e4d7bc`, `9d7f216`; `merge.ts:48` | Merge | CODE+PLAN §2.6 |
| `diff_main(..., 0)` is an expired deadline, the opposite of `Diff_Timeout = 0`; changing it changes merges between releases. `@sanity/diff-match-patch` is not a drop-in. | `f9fdf21` (I26, I28) | `merge.ts` call-site comment | CODE; the fork's "do not upgrade the dependency" is LOG-ONLY |
| The merge budget is work, not time, or two devices compute different merges; a 20,000-line diff took 23 s on the UI thread. | `69dc164`; `merge-budget.test.ts` | Merge | CODE |
| Canvas `"edges":[]` merged into invalid JSON; a finer diff produced a malformed SVG merge 1 in 20,000. Validity gates are load-bearing, and the gate wiring itself was untested once. | `0614151`, `5627120`, `2a879d9` | `markup.ts`, `canvas.test.ts` | CODE |
| The fuzzer found four shapes of invented text; residue about 2 per 100,000. | `723ad12`, `908aa24`; `merge.fuzz.ts` | Merge fuzz (not named in the reuse map) | CODE |
| A `.md` that is not valid UTF-8 merged cleanly after U+FFFD decoding and was written back corrupted; decode fatally and keep both. | `dc9944f`; `conflicts.ts:50` | Conflicts | CODE; the Go MCP editability check needs the same fatal decode |
| The merge base must be checked against the device's own `synchash`, because the server picks the base and so picks what gets deleted. | `99eee2c`; `engine.ts` `contentOf` | Engine | CODE; PLAN M2 task 4 keeps it as a consistency check |
| A read-only mirror wrote another conflict copy every pass (11, then 20). | `5627120` (RR7), `eac9224` (RR9) | Engine tests | CODE |
| Conflict-copy names carry the minute; two in one minute overwrote each other. | `dc9944f`; `engine.ts:4672` | Engine | CODE; agent-labelled copies (PLAN §2.4) hit this more often |

### 5.7 Performance lessons buried in deleted code

| Lesson | Evidence | Kept where | Class |
|---|---|---|---|
| Awaiting each chunk's WebCrypto call in turn is 38 us per chunk (56 MiB/s); one file's chunks at once is 14 us (151 MiB/s), and file-at-a-time keeps memory bounded. SHA-256 naming is a WebCrypto promise too. | `crypto.ts:589-610` (`sealChunks`) | Deleted in M2 | **AT RISK** |
| Chunk size measured: 256 B was worse than 1 KiB on every axis (64 B of name per chunk per put); per-chunk deflate took an upload from 108% of plaintext to 67%. | `88233ea`; `crypto.ts:505-510` | Not in the move list | **AT RISK** (partly in `research.md`) |
| Cross-file dedup is worth 0.11%; cross-version 73 to 90%; entry metadata is 37% of a first sync. | `fc7e804`; `research.md` | `research.md` (not in M0 list) | Doc; PLAN §2.2 cites it |
| The chunker's double modulo became an `fmod` per byte in V8; benchmarks ran on bun while the CLI ships on node. Any boundary change re-chunks every vault. | `15a677d`, `fccea2a` | `chunk.ts`, `bench.ts` | CODE; the Go chunker must copy the exact arithmetic and the UTF-8 back-off rule (`chunk.ts:227-240`) |
| Plugin `list()` was 47 to 53% of a quiet pass; memoise `normalizePath`. | `0efaee6`; `list-bench.test.ts` | Plugin | CODE |

### 5.8 MCP lessons that die with `mcp*.ts`

PLAN keeps these files as an oracle until the Go port passes, which protects behaviour the fixtures exercise. It does not protect behaviour recorded only in comments. Move these into `plan/mcp-tools.md` as named fixtures before M2 deletes anything:

- A tag regex stopping at the first `)` ate URL fragments; rewrite only the frontmatter's tags range, never re-serialise the whole block (`mcp-markdown.ts:210`, `:339`).
- JSON escaping expanded legal Linux paths past the cursor cap, so cursors base64url-encode the path; escaped control characters cost six bytes each; a lone low surrogate at the clip point must be skipped (`mcp-read.ts:62`, `:123`, `:426-432`). This is the same problem PLAN §4.10's normalisation function has to solve.
- Paging keeps line terminators, including a trailing CR (`mcp-read.ts:123`).
- The SDK's raw transport overwrote its stream mapping on a duplicate JSON-RPC id; cancelled mappings were kept until collection; `serveStdio` had an unbounded queue (`mcp-http.ts:302-305`, `:394-397`, `mcp-protocol.ts:159`). Relevant to M4 task 1's SDK-or-hand-roll decision: test duplicate ids either way.
- `--listen` refuses wildcard addresses (`mcp-http.ts:60-80`); the Go `/mcp` shares the sync listener, so say explicitly that `serve -addr 0.0.0.0` now exposes MCP as well.
- A duplicate SIGTERM after the child removed its handler turned a clean drain into a signal exit (`912f8ff`); the Go MCP drain tests need the case.
- Case-rule path resolution and "skipped collision paths reported on every page" (§5.3).

## 6. Basalt defects and habits the rewrite could reintroduce

These are not open Basalt bugs; they are places where a Trew rewrite of copied code would quietly undo a fix.

1. **Deleting `KEEP_SEALED_BELOW`.** Without it, `planUpload` either holds every attachment's bodies in memory or re-derives every small note's chunks twice. Rename it and keep its three call sites.
2. **Replacing `sealChunks` with a per-chunk `await chunkName(...)` loop.** That is the 56 MiB/s path Basalt measured and left.
3. **Writing the "fresh schema" from memory.** It must carry `PRAGMA temp_store = MEMORY`, `n_chunks` (now `NOT NULL` with no legacy `-1`), `entries_by_path`, `entry_chunks_by_name`, `entries_by_prev`, and the `synchronous` pragma set in the DSN (`open.go:102`), which lives outside the schema string and is easy to miss. Diff the new schema string against `store.go:292-470` line by line.
4. **An all-or-nothing `CommitOperation` with no degraded path.** Basalt's only batched commit failed in production within a day and was rescued by a fallback. MCP operations must be atomic, so a fallback to partial commits is wrong; the answer is to make the failure visible and typed (and to have `temp_store` right), and to test `CommitOperation` in the read-only scratch image, not only in `go test`.
5. **Dropping `SEAL_OVERHEAD` to zero.** If `chunkMax` bounds the framed body, the marker byte is the new overhead and an incompressible chunk cut at exactly `chunkMax` is refused forever. Decide whether `chunkMax` is raw or framed, write it in `plan/protocol.md`, and test with random bytes at exactly the limit.
6. **Losing `pairingHosts`.** A `trew1i_` invite minted by `serve -addr 0.0.0.0:3003` must not embed `0.0.0.0`.
7. **Deleting the `runLoop` credential refusal (`main.ts:789-800`).** Its lesson ("a config with no credential is a refusal, not a retry loop that says connecting forever") applies to a missing device token as much as to a missing data key.
8. **Stale comments at scale.** `index-state.ts:100-106` will say content identity depends on deterministic sealing; `http.go:112` will say bodies are ciphertext; `plugin/vault.ts:684-690` will say the seal proves a path's origin. PLAN §7 already names this defect shape; M2 needs a grep gate (`seal|cipher|data key|recovery key|wrapped` in comments) rather than trust.
9. **Adding a caller outside the client's `serial` queue.** The transport has one request in flight; a recovery query during a sync once collided (`cad8075`). The plugin undo button in M5 task 7 is a new caller.

## 7. Keep or drop: where the plan's copy list should change

**The plan drops, but should keep:**

- `docs/findings.md` and an F01..F28 index, as `docs/history/` (§3).
- `docs/index-journal.md`, whole (§3).
- The rest of `docs/` until M9 rewrites it, so 114 source citations resolve (§3).
- `LICENSE` (the MIT notice travels with the copied code), `.prettierrc` and `.prettierignore` (`d68c2d5`: formatting without a committed config produced a 1,855-line diff for a 6-line change), `.gitignore` (with `bun.lock` kept tracked, `4374e2a`), `llms.txt`.
- `KEEP_SEALED_BELOW` renamed, the `sealChunks` batching pattern, the chunk-size measurement comment, `pairingHosts` and its test, the `runLoop` refusal (§6).
- `scripts/open-note-smoke.mjs` as an M3 acceptance step: it is the only proof that open editors keep cursors and unsaved typing through a replace, and nothing in PLAN runs it.
- `client/src/core/merge.fuzz.ts` and `merge.fuzz.run.ts`, `latency.ts`, `test-async.ts`, and `client/bench-*.ts` including `bench-android.ts`: not named in the reuse map, so easy to lose in a strip.
- The mobile acceptance list from `0.7.1-fixes.md:106-111`, moved into M3.

**The plan keeps, but could drop:**

- `Remote.wire` spelling memory and the older-Mac-NFD handling (`engine.ts:905-915`, `:1448`, `:2265`, `:2529`). Under a server that refuses non-NFC paths it is dead; delete it deliberately with its tests rather than carry unreachable code. Keep the local NFD-to-NFC normalisation, which is the part that matters.
- The journal's "snapshot without `seq`" compatibility branch (`index-journal.md:92-93`): no Trew client ever wrote one.
- `n_chunks = -1` "written before this column existed", the `migrate` ALTERs, and `splitInheritedFaults`'s legacy-fault cases that only a Basalt-era store can produce (keep the mechanism).
- `worthDeflating` as a pure-function requirement: the probe still saves CPU, but since names are over raw bytes its output no longer needs to agree across devices. Say so in the comment so nobody preserves a constraint that no longer exists.

## 8. Recommended changes to PLAN.md

- **M0 copy bullet:** replace "Exclude `docs/reviews`, `docs/findings.md`, `docs/documentation-review.md`, `docs/index-journal.md` history sections" with: copy all of `docs/` except `docs/reviews/` and `docs/documentation-review.md`; move `docs/findings.md` to `docs/history/findings.md` and add an F01..F28 section reconstructed from the log (`git log --grep='F[0-9][0-9]'`). Copy `LICENSE`, `.prettierrc`, `.prettierignore`, `.gitignore`, `llms.txt`. Correct `styles.css` to `client/styles.css`.
- **M0 new task:** a comment-rot gate in `scripts/check.sh` that fails on `seal`, `cipher`, `data key`, `recovery key`, `wrapped` in comments outside `docs/history/`, run from M2 onward.
- **§3.3 Store changes, "Keep" list:** add `PRAGMA temp_store = MEMORY` (with the `452eb72` reason), `entries.n_chunks NOT NULL`, the three secondary indexes, and a line saying the new schema is diffed against `basalt:server/internal/store/store.go:292-470`. Decide `entry_chunks WITHOUT ROWID` now (`fa5f549`), since a fresh schema makes it free.
- **§4.3 `CommitOperation`:** add a paragraph: Basalt's batched commit failed in production on `SQLITE_IOERR_GETTEMPPATH` in the read-only scratch image and was rescued only by a per-entry fallback that an atomic operation cannot have; so `CommitOperation` must be tested inside the shipped image under `read_only: true`, must take the same lock as quarantine and sweep (`496f225`), and must return a typed storage failure rather than a generic error.
- **§4.9:** correct the rationale. Both adapters normalise NFD to NFC before upload (`basalt:client/src/core/vault.ts:136-145`), so NFD is not the likely `badpath` source; the plausible ones are paths over 1,024 bytes (Basalt allowed 4,096), control characters in Linux filenames, and hand-built clients. Change M2 task 11's test from "an NFD filename on disk" to a path over 1,024 bytes and a control-character name.
- **§4.1 or M0.5 task 3:** add NBSP and U+202F to the path fixtures and decide one rule for both adapters (the plugin folds them via `normalizePath`, `NodeVault` does not). Either fold in `NodeVault` too or have the server refuse them; do not leave the two production clients writing different server paths for one file.
- **§4.7 sidecar:** state that the Linux abstract-socket exclusion is per network namespace (`f2cee53`), so two containers sharing one vault volume are not excluded; require one headless client per folder and use a `flock` on a file inside the vault's state directory as a second guard when running in containers.
- **§2.2 or M0.5 task 2:** say whether `chunkMax` bounds raw or framed bytes, and add a random-bytes chunk at exactly `chunkMax` to the fixtures (`ec11e0e`, `chunk.ts:206-213`).
- **M2 task 4:** replace "delete `KEEP_SEALED_BELOW`" with "rename to `KEEP_BODIES_BELOW`; it is the attachment memory policy", and require `sealedNames`'s replacement to hash one file's chunks concurrently (`crypto.ts:589-610`).
- **M1 task 9:** keep `pairingHosts` (`main.go:643`) and `main_test.go:1195` for the invite printer; add an invite URL override so M5.5's rehearsal on another port can pair (`bc18bb6`).
- **M1 task 11:** name the invite tests that must survive the token rewrite: retry under the same id is not retryable `internal` forever, hello with both token and invite, ids starting with `-` (`650e11f`, `356fb40`). Extend `disclosure_test.go` to `/mcp` responses.
- **M3:** add foreground-only sync on Android as a documented expectation (`design.md:270`), run `scripts/open-note-smoke.mjs`, record the Origin header the Pixel actually sends (the Capacitor defaults at `http.go:15-40` have never been observed), and carry the unfinished Android list from `0.7.1-fixes.md:106-111`.
- **M4 tasks 3 to 5 and `plan/mcp-tools.md`:** add fixtures for the §5.8 comment-only lessons: path cursor encoding, control-character and lone-surrogate clipping, CR-preserving paging, tag range rewriting, case-rule resolution, collision paths reported on every page, duplicate JSON-RPC ids, non-object JSON-RPC frames (`c2d76c0`), and fatal UTF-8 decode for editability (`dc9944f`).
- **M4 task 1:** note that `-addr 0.0.0.0` now exposes `/mcp`, where Basalt's HTTP MCP refused wildcard binds (`mcp-http.ts:60-80`).
- **M5.5 `trew doctor`:** reuse `health.go`'s write-probe and chunk-directory create-probe instead of writing new checks, and add "the same failure repeated N times" as an alert condition (`452eb72`).
- **§3.6:** add that the client's refusal of inbound dot and config-folder paths (`997ba83`, `plugin/vault.ts:708-721`) is now the last defence against a compromised server or an injected agent writing `.obsidian/plugins/*/main.js`, and that a non-dot `configDir` is protected only on the client.
- **§7:** add two lines from the excluded 0.7.1 review: the Go race detector checks memory access, not logical lost updates; and transport progress, durable storage, edit preservation, and user-visible delivery each need their own test.
- **`plan/reuse-map.md`:** swap the `commit`/`commitMany` line numbers (`commitMany` 1608, `commit` 1968); change the class A core total to 4,394 lines and list the stale comments in `index-state.ts`; move `KEEP_SEALED_BELOW` out of the delete list; add `pairingHosts` as a keep; add `http.go:109-114` and `chunks.go:325-330` to the reword list; name `merge.fuzz*.ts`, `latency.ts`, `test-async.ts`, and `client/bench-*.ts`.
