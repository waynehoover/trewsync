# Strip ledger: what the crypto-era tests assert, before M1 and M2 take the crypto out

Written 2026-09-22 during M0 ("Measure the inventory", PLAN §5), before any stripping. PLAN §2.1: "Deleting a test file is a decision, not cleanup. Before deleting any test file, list its assertions and classify each as obsolete with the crypto or still a guarantee." This file is that list. PLAN §2.1 and CLAUDE.md name `docs/development.md` as the ledger's home; this task was scoped to this one file, so `docs/development.md` should link here the next time it is edited.

The most important sections are [Guarantees with no equivalent elsewhere](#guarantees-with-no-equivalent-elsewhere) and [Hazards](#hazards-what-the-rewrite-must-not-carry-over-as-written). The per-test tables after them are the evidence.

## How to read it

**Classes.**

- **OBSOLETE**: every assertion is about a mechanism that is deleted (root secret, key schedule, sealing, entry MAC, wrapped data key, claim, bootstrap token, registrar session, rotation, recovery key), and no surviving mechanism inherits what it checked. Delete it.
- **GUARANTEE**: the property survives. The rewrite changes setup, or swaps the mechanism under test for its Trew successor (sealed chunk for frame, registrar for control socket, sealed invite for invite token), and keeps the assertion.
- **SPLIT**: some assertions are obsolete and some are guarantees. The rewrite drops the first kind and keeps the second; the row says which is which.

**Lines** are gabbro's, and a TypeScript test is named by its full `describe > it` path. Every file in this ledger has the same line numbers as Basalt at `664a963` (`basalt:server/...` for Go, `basalt:client/...` for TypeScript), because the M0 rename only changed words on existing lines. The one exception is `client/src/cli/cli.test.ts`, which runs 2 lines longer from line 1209 and 4 lines longer from line 1223.

**Owners** are PLAN §5 tasks. Where a row names two, the first builds the mechanism and the second rewrites the test. M1 task 11 ("tests. Apply §2.1's ledger") and M2 task 9 (test-server, fake-socket and the test deletions) are the default owners of every rewrite.

**Scope.**

- **Tier 1, every top-level test**: the files the plan or reuse map deletes wholesale or rewrites heavily because of the crypto, and the files whose cases are mostly about claim, registrar, rotation or keys. Found with `rg` over all 74 Go and 134 TypeScript test files, scored per test rather than per file (a `Mac: testMac` field or a `testKeys(...)` setup line does not make a test about crypto), then read in full.
- **Tier 2, only the crypto-centric cases** of files adapted in place: the recovery-key, claim and setup-line cases of the plugin, the CLI and `cmd/trew`; the MAC and wrapped-key cases of the engine and transport. Their setup-only cases are not listed; M2 task 9's "34 files, mostly one line each" covers those.

**Mechanisms** named in the "Rewrite against" column:

| Name | What it is | Built in |
|---|---|---|
| invite token redemption | `hello {invite, deviceId, token, device}`: `helloAsInvite` plus an atomic `RedeemInvite(vault, token, deviceID, authHash, name)` | M1 task 2, task 7; protocol.md "Invite redemption" |
| invite token rows | `invites (token_hash, label, created_at, expires_at, used_at)` with `CreateInvite`, `Invites`, `CancelInvite`; wire `invite`, `uninvite`, `devices.invites` | M1 task 1, task 2 |
| device token hash lookup | `helloAsDevice`: SHA-256 of the 32-byte device token against `devices.auth_hash`, in constant time | M1 task 7 |
| mcp_tokens | bearer on `/mcp`, `mcp_tokens.token_hash`, scope, expiry | M1 task 2, M4 task 2 |
| control socket admin | `internal/control`: `invite`, `devices`, `revoke`, `mcp-token` while `serve` runs | M1 task 9 |
| first-run invite | the invite `serve` mints on an empty store and writes to a private path | M1 task 9 |
| secret output file | any file Trew writes a credential to: the first-run invite, `mcp-token --key-out` | M1 task 9 |
| size invariant | `sizeAccountedFor`: the sum of raw chunk lengths equals the declared size, at commit | M1 task 4 |
| store_identity | product, schema version and epoch, checked before any write | M1 task 8 |
| path policy | the §4.1 refusals, answered `badpath` | M1 task 3, M0.5 task 3 |
| frame codec | `marker ∥ payload`, marker 0 raw or 1 deflate: Go `internal/frame`, TypeScript `core/frame.ts` | M1 task 5, M2 task 1, M0.5 task 2 |
| digest.ts | `chunkName`, `plainDigest`, `isChunkName`, `hex`, `base64urlEncode/Decode`, `randomBytes`, moved out of `crypto.ts` | M2 task 1 |
| trew1i_ codec | the new `formatInvite` and `parseInvite` | M0.5 task 1, M2 task 5 |
| DeviceConfig | `{url, vaultId, device, deviceId, deviceToken, readOnly?, ignore?}` and its encode and decode | M2 task 5 |
| device token generation | the joining client's random 32-byte credential | M2 task 5, task 6 |
| windowed hash naming | `sealedNames` becoming a windowed hash loop; `planUpload` re-hashing instead of re-sealing | M2 task 4 |
| restore consistency checks | what `client.ts` checks in `history`, `deleted`, `restore` and `findVersion` answers | M2 task 6 |
| lost-reply redemption | the retry of a redemption whose reply was lost, which protocol.md says must recover or return a recoverable result | M0.5 task 1 |

## keys_test.go:530 and :557, confirmed

- **`internal/store/keys_test.go:530`** is inside `TestACrashBetweenSpendingAnInviteAndRegisteringSpendsNeither` (function at line 508; the flagged assertion is the outstanding-invite check at 529-531). It injects a failure between spending the invite and writing the device row, then asserts that no device was registered, the invite is still outstanding, and the same string redeems on retry. **GUARANTEE, confirmed.**
- **`internal/store/keys_test.go:557`** is `TestARedeemRacingARevokeLeavesTheVaultConsistent` itself (557-612). Twenty races of a redemption against revoking the vault's only device, through two store handles on one directory, asserting that the redemption is both halves or neither and the vault is never left empty. **GUARANTEE, confirmed**, with one scope note: the never-empty half rests on `ErrLastDevice`, which `plan/protocol.md:123` removes (hazard 4). The both-halves-or-neither half stands either way, and it is the half that matters.
- The line numbers are identical in `basalt:server/internal/store/keys_test.go`.

## Totals

Tier 1 counts every top-level test in the file.

| File | Plan's fate | Tests | Obsolete | Guarantee | Split |
|---|---|---|---|---|---|
| `internal/store/keys_test.go` | reuse map deletes wholesale; §2.1 says classify first | 17 | 6 | 10 | 1 |
| `internal/server/auth_test.go` | same | 9 | 4 | 4 | 1 |
| `internal/server/invite_test.go` | same | 18 | 3 | 11 | 4 |
| `internal/server/invite_doc_test.go` | kept; its constants change | 1 | 0 | 1 | 0 |
| `cmd/trew/token_s11_test.go` | reuse map: classify; its writer goes in M1 task 9 | 3 | 1 | 2 | 0 |
| `internal/server/unlimited_devices_test.go` | reuse map: classify its claim case | 2 | 0 | 2 | 0 |
| `internal/server/release_review_test.go` | 3 of 4 cases are registrar or rotation | 4 | 2 | 1 | 1 |
| `internal/server/protocol_test.go` | reuse map: adapt; 13 of 27 cases are claim or rotation | 27 | 11 | 14 | 2 |
| `internal/server/devices_test.go` | reuse map: adapt; M1 task 11 rewrites its redemption cases | 22 | 6 | 11 | 5 |
| `internal/store/budget_test.go` | M1 task 4: update for the size invariant | 7 | 1 | 5 | 1 |
| **Go, Tier 1** | | **110** | **34** | **61** | **15** |
| `client/src/core/crypto.test.ts` | M2 task 9 deletes; the code splits into digest.ts and frame.ts | 60 | 34 | 22 | 4 |
| `client/src/core/pairing.test.ts` | rewritten for trew1i_ and DeviceConfig (M2 task 5) | 43 | 7 | 32 | 4 |
| `client/src/core/invite.test.ts` | M2 task 9 deletes | 4 | 1 | 2 | 1 |
| `client/src/core/rotation.test.ts` | M2 task 9 deletes | 9 | 8 | 0 | 1 |
| `client/src/core/compression-golden.test.ts` | deleted with `compression-golden*.ts` (M2 task 1) | 3 | 1 | 1 | 1 |
| `client/src/core/recovery-auth.test.ts` | M2 task 9 deletes "the MAC-forgery half" | 12 | 2 | 10 | 0 |
| `client/src/cli/rotate.test.ts` | reuse map deletes | 7 | 7 | 0 | 0 |
| `client/src/plugin/rotate.test.ts` | M2 task 9 deletes | 6 | 6 | 0 | 0 |
| **TypeScript, Tier 1** | | **144** | **66** | **67** | **11** |
| **Tier 1 total** | | **254** | **100** | **128** | **26** |

Tier 2 counts only the crypto-centric cases listed below, not the whole file.

| File | Tests in file | Listed | Obsolete | Guarantee | Split |
|---|---|---|---|---|---|
| `internal/store/devices_test.go` | 25 | 6 | 4 | 0 | 2 |
| `internal/store/store_test.go` | 49 | 2 | 0 | 0 | 2 |
| `internal/store/backup_test.go` | 19 | 1 | 0 | 0 | 1 |
| `internal/store/migrate_test.go` | 3 | 3 | 2 | 1 | 0 |
| `internal/server/session_test.go` | 43 | 1 | 0 | 0 | 1 |
| `internal/server/mutation_authorization_test.go` | 4 | 1 | 1 | 0 | 0 |
| `internal/server/disclosure_test.go` | 6 | 2 | 0 | 0 | 2 |
| `cmd/trew/main_test.go` | 69 | 6 | 0 | 0 | 6 |
| `cmd/trew/ops_i17_test.go` | 7 | 2 | 1 | 0 | 1 |
| **Go, Tier 2** | 225 | **24** | **8** | **1** | **15** |
| `client/src/core/engine.test.ts` | 105 | 6 | 4 | 0 | 2 |
| `client/src/core/transport.test.ts` | 107 | 7 | 4 | 0 | 3 |
| `client/src/core/server-harness.test.ts` | 24 | 3 | 1 | 1 | 1 |
| `client/src/core/invariants.test.ts` | 6 | 1 | 0 | 0 | 1 |
| `client/src/plugin/main.test.ts` | 165 | 29 | 14 | 6 | 9 |
| `client/src/plugin/panel-shots.test.ts` | 15 | 2 | 0 | 0 | 2 |
| `client/src/cli/cli.test.ts` | 96 | 28 | 17 | 1 | 10 |
| `client/src/cli/state.test.ts` | 34 | 10 | 4 | 3 | 3 |
| **TypeScript, Tier 2** | 552 | **86** | **44** | **11** | **31** |
| **Tier 2 total** | | **110** | **52** | **12** | **46** |

Across both tiers, 364 tests are classified: 152 obsolete, 140 guarantees, 72 split. Fewer than half of them (42 percent) can simply be deleted; even in the three Go files PLAN §2.1 says the reuse map would delete wholesale (`keys_test.go`, `auth_test.go`, `invite_test.go`), 31 of 44 tests carry a guarantee in whole or in part.

## Guarantees with no equivalent elsewhere

"No equivalent" means no test outside this ledger's files would fail if the property broke. Each line says where the guarantee lives today and whether a PLAN task already names its replacement test.

**Carried only by files the plan deletes wholesale** (`keys_test.go`, `auth_test.go`, `invite_test.go`, `token_s11_test.go`, `crypto.test.ts`, `rotation.test.ts`, `compression-golden.test.ts`, `invite.test.ts`, and `recovery-auth.test.ts`, which M2 task 9 deletes by halves):

1. **Redemption is atomic across a crash** between spending the invite and writing the row, and the same string then works. `keys_test.go:508` (assertion 529-531). Named in M1 task 11.
2. **A redemption racing a revoke**, through two store handles, never leaves half a redemption. `keys_test.go:557`. Named in M1 task 11.
3. **Single use under real concurrency**: eight store handles redeeming one invite register exactly one device, and the test was checked to fail when the spend is split into SELECT then UPDATE. `keys_test.go:743`. Not named anywhere in the plan.
4. **Expiry**: an expired invite is refused at redemption, a past expiry is refused at insert, expired rows are swept at the next insert, and expired invites leave the listing. `keys_test.go:107, :307`, `invite_test.go:129, :293`. No TypeScript test touches invite expiry; the plan names only codec vectors for it.
5. **One refusal for spent, unknown, malformed and cancelled invites**: `ErrNoInvite` in the store, a byte-identical `auth` frame on the wire. `keys_test.go:107, :240`, `invite_test.go:147, :244`. `disclosure_test.go:309` covers only a never-issued invite against vault existence.
6. **A refused redemption never spends the invite**: an existing device id (its row's hash and name untouched), a missing or malformed device id, a missing or short token, a bad name, a hello carrying a token and an invite together. `keys_test.go:695`, `invite_test.go:437, :572, :617`.
7. **Credentials are stored as SHA-256, never in the clear, and a redemption refuses a device token below the length floor.** `auth_test.go:98, :140`, `invite_test.go:617`. Trew adds `invites.token_hash` and `mcp_tokens.token_hash`, which nothing tests; M4 task 2 plans the constant-time compare, not the storage.
8. **`validBase64URL` takes "=" only as trailing padding**, and it still guards every device id through `ValidDeviceID` (`store.go:2599, :3243`). `keys_test.go:468`.
9. **Invites travel in a backup and redeem from the restore.** `keys_test.go:334`. Decide against the §2.8 restore epoch before rewriting it either way.
10. **Invite lifetime**: the default, the cap, refusal of a negative TTL, a clamp that cannot overflow on extreme values, and docs that state the same numbers. `invite_test.go:307`, `release_review_test.go:13`, `invite_doc_test.go:83`. protocol.md keeps `ttlMs` on the wire op, moves the default to one hour and adds `--ttl 0`.
11. **Secret files are written exactly, atomically, at 0600, and a pre-existing 0644 file is tightened.** `token_s11_test.go:14, :40`. The writer is deleted with the auth-token file (M1 task 9) while Trew adds two secret outputs: serve's first-run invite and `mcp-token --key-out`.
12. **Chunk names agree with the server** on fixed SHA-256 vectors, are 64 lowercase hex, and a subarray is named by its own bytes. `crypto.test.ts:341, :359, :386`. No Go test pins a vector; M0.5 task 6 implies moving them into `protocol-fixtures.json`.
13. **base64url decoding is strict**: every byte value and every length mod 3 round-trip, no padding is emitted, and stray characters, a dangling sextet and nonzero unused bits are refused. `crypto.test.ts:413-461`. digest.ts, device ids and the trew1i_ codec all rest on it.
14. **Frame behaviour outside M0.5 task 2's list**: compressible text is actually deflated, incompressible input is stored raw at one byte of overhead, the probe's worst case round-trips, text and binary round-trip, the marker per input class is pinned, and a chunk's name never depends on the frame. `crypto.test.ts:117, :132, :146, :174, :189, :625, :632, :638, :648`, `compression-golden.test.ts:18, :32`. Unknown markers, empty bodies and inflation limits are in M0.5 task 2, and inflation limits are already covered by `receive-limits.test.ts` and `transport.test.ts:2168`.
15. **The restore path checks a server's answers against each other**: get's chunk list must be the history entry's, names must be chunk names, the assembly must be the declared length, get's size must be the entry's, the entry must be the requested note, pages must honour `before`, come newest first and advance, and a declared size needs chunks. `recovery-auth.test.ts:109-306`, 10 of its 12 tests. "The MAC-forgery half" is two tests (90, 100).
16. **A `redeemed` reply naming a device other than the one asked for is refused** before a credential is kept. The check exists at `transport.ts:1346` and has never been tested; only its registrar twin is, at `rotation.test.ts:117`.
17. **The device token is 32 random bytes and wire-safe base64url.** `crypto.test.ts:108, :465` test the root and device secrets it replaces; the token itself is new.

**Carried only by files rewritten in place** (the risk is collateral deletion, or a trigger that stops firing once the crypto is gone):

18. **The invite listing carries nothing that redeems.** `keys_test.go:177`, `invite_test.go:73`. `cli.test.ts:1464` checks only that the whole invite string is absent, which would still pass while a token leaked (hazard 1).
19. **A revoke evicts all of a device's sessions in parallel**, not one per second in series. `protocol_test.go:658` tests only the rotation path; `handleRevoke` runs the same loop (`session.go:2774`) with no test.
20. **A connection failure during hello publication is race-free.** `release_review_test.go:33` tests only the registrar hello; `helloAsDevice` publishes the same way (`session.go:996`).
21. **The credential of last resort** can list devices and invites, cancel invites, revoke, and add a device to a store whose every device is gone. `devices_test.go:121, :159`, `invite_test.go:195`, `cli.test.ts:1570`, all in recovery-key form. In Trew that is the control socket (M1 task 9), which has no tests yet.
22. **A retried registration whose reply was lost** succeeds when the id and key match and is refused, changing nothing, when they do not. `devices_test.go:236`. protocol.md requires the same of a redemption retry and nothing tests it there (M0.5 task 1).
23. **The invite codec's error behaviour**: 200 random round trips, paste whitespace, non-ASCII fields, an appended character, flipped unused bits, any single-character change, a transposition, truncation, an unknown version, a length past the end, trailing bytes, a wrong field length, an over-long URL. `pairing.test.ts` (26 codec cases, written against `basalt3_` and `basalt3i_`). M0.5 task 1 plans vectors for base64, lengths, CRC and expiry, which is a subset.
24. **The first-run credential names an address a device can dial** (never `0.0.0.0`, `[::]` or `:3003`), keeps an explicit address as given, uses `ws://` under `-localhost`, is not printed once the store has devices, and survives a restart. `main_test.go:671, :1189, :1207, :1218, :1294`, all written against `printSetup` and the bootstrap token, which M1 task 9 deletes. The trew1i_ string embeds the URL, so this matters more than it did.
25. **A backup publishes over a fault its source already has, and verify names a stored row every reader would refuse.** `backup_test.go:845`, `store_test.go:1383`. Both are seeded only with `nomac`, which M1 tasks 3 and 12 delete.
26. **Entry validation covers folders and deletions**, not only files (F20). `store_test.go:1351`, seeded only with `mac` and `parent`. The `badpath` matrix in M1 task 11 must include folders and deletions.
27. **A batch refused because of a later entry applies nothing from earlier ones, and a refused batch does not move the cursor.** `engine.test.ts:2844`, `invariants.test.ts:75`. Both use a forged MAC as the only trigger.

## Hazards: what the rewrite must not carry over as written

1. **The invite listing's `id` must not be the token.** Basalt lists the redemption identifier itself (`keys_test.go:204`, `invite_test.go:98`), which was safe only because redeeming also needed the invite key, and that never reached the server. A Trew invite token is the whole credential. The same shape of listing would hand a redeemable token to every paired device, to the plugin's device panel and to `trew-sync devices`. protocol.md gives the listing `{id, label, expiresAt}` without saying what `id` is. Rewritten tests must assert that the listed handle cannot redeem and that no field equals or contains the token. `cli.test.ts:1464`'s `not.toContain(string)` would pass while the token leaked.
2. **Persist-before-send against "saves nothing".** protocol.md ("Invite redemption") and M0.5 task 1 require the joining client to persist its credential before sending the redemption. `main.test.ts:2823, :2841, :3956, :3987` and `cli.test.ts:1194, :1265` assert that an unreachable server, a refused redemption, or an unload after redemption leaves nothing saved and the vault unpaired. Both hold only if the early credential lives in a pending state that is not "paired" and is cleared on a definite refusal. Settle that in M0.5, then restate those assertions rather than deleting them.
3. **Lost-reply retry against "an existing id is refused".** `keys_test.go:695` and `invite_test.go:572` refuse a redemption onto an existing device id; protocol.md wants a retried redemption to recover the paired device. The retry must recognise its own row (same id, same token hash) and still refuse a different token under that id, which is `devices_test.go:236`'s rule moved to redemption.
4. **The last-device rule is undecided.** `plan/protocol.md:123` drops `allowLast` and lets a device revoke the last device, since `trew invite` on the server is the way back; PLAN.md does not say so. If that stands, `devices_test.go:532`, `internal/store/devices_test.go:374` and `:667`, `cli.test.ts:1408`, `main.test.ts:4564` and the one-device panel shot at `panel-shots.test.ts:303` invert or go, and `keys_test.go:557` keeps only its both-or-neither half. If it does not stand, their refusal messages must stop naming the recovery key.
5. **Triggers that stop firing.** Some surviving guarantees are exercised only through a MAC failure: `engine.test.ts:2844`, `invariants.test.ts:75`, and `recovery-auth.test.ts:133`, whose regex accepts "not authenticated" as an alternative to "not a chunk name". With the MAC gone they fail for the wrong reason or pass vacuously. Re-seed each with a refusal that survives: a malformed chunk name, a refused path, a shape contradiction.
6. **`nomac` as the only example.** `backup_test.go:845` and `store_test.go:1383` use a missing authenticator as their only instance of an inherited or reader-refused row. Re-seed them with a row the new policy refuses (a `badpath` path, a size that is not the sum of its chunks) instead of deleting them along with the `nomac` code.
7. **Probe with Basalt's protocol.** Trew speaks protocol 1 and Basalt speaks 7. The hello-range tests (`protocol_test.go:832`, `session_test.go:65`, `disclosure_test.go:224`, `server-harness.test.ts:849`) should send a protocol 7 hello with Basalt's fields, so a Basalt plugin meeting a Trew server is refused as `proto` with both numbers named, not as `auth`.
8. **A warning that inverts.** `panel-shots.test.ts:256` pins "the notes are still sealed, the device credential is not" for a hop without TLS. Without end-to-end encryption the notes are exposed as well. Keep the assertion that the warning is shown and change what it says (§3.6).
9. **The path bound shrinks.** Basalt allowed 4096 bytes of sealed path (`crypto.test.ts:323`), roughly 3,000 plaintext bytes. Trew allows 1,024 plaintext bytes (§4.1), so a Basalt vault can hold paths Trew refuses. Add a long-path case to the M10 inventory and to the §4.9 stranded-list tests.
10. **`recovery-auth.test.ts` is mostly guarantees.** Two of its twelve tests are MAC forgery; the other ten are the only tests of the restore path's consistency checks (item 15). Rename the file when stripping it, so the next reader does not take it for a crypto-only file.

## Tier 1 ledger: Go

### `internal/store/keys_test.go` (17)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 29 | `TestI5ClaimStoresHashAndWrappedTogether` | A claim binds the vault's auth hash and wrapped key together; a second claim or a malformed blob changes nothing; an unknown vault reads as empty | OBSOLETE | none | M1 task 2 deletes ClaimVault |
| 61 | `TestI5RotateSwapsBothOrNeither` | Rotate swaps hash and wrapped key atomically and refuses an unknown vault or a malformed blob | OBSOLETE | none | M1 task 2 |
| 88 | `TestI5TheWrappedKeySurvivesBackupAndRestore` | The wrapped key and vault hash come back from a backup | OBSOLETE | none; device rows in a backup are `internal/store/devices_test.go:778` | M1 task 2 |
| 107 | `TestI23InvitesAreSingleUseAndExpire` | Insert refused on an unclaimed vault and for a past expiry; one redemption registers its device; second, expired, unknown and malformed tries are one ErrNoInvite; another vault's invite does not open this one; no refusal writes a row or spends an invite | GUARANTEE (the returned sealed blob becomes a plain success) | invite token rows, invite token redemption | M1 task 2, task 11 |
| 177 | `TestInvitesListsWhatCanStillBeRedeemed` | The listing is never nil, soonest expiry first, carries only id and expiry, drops spent and expired invites, and is per vault | GUARANTEE (hazard 1: the listed id is the redemption identifier) | invite token rows (`Invites`) | M1 task 2, task 11 |
| 240 | `TestCancellingAnInviteRetiresTheString` | Cancel deletes the row, the string stops redeeming and adds no device; cancelled twice, expired, redeemed, unknown and malformed are one ErrNoInvite; cancel is scoped to its vault | GUARANTEE | invite token rows (`CancelInvite` by a handle that cannot redeem) | M1 task 2, task 11 |
| 307 | `TestI23ExpiredInvitesAreSweptAtInsert` | Expired rows are deleted at the next insert | GUARANTEE | invite token rows (`CreateInvite`) | M1 task 2 |
| 334 | `TestI23InvitesTravelInTheBackup` | An invite issued before a backup redeems from the restored store, and its device row is there too | GUARANTEE (decide against the §2.8 restore epoch) | invite token rows, backup | M1 task 12 |
| 366 | `TestRotateIsACompareAndSwapAgainstTheCallersHash` | Two concurrent rotations under one hash: exactly one wins, both columns are the winner's, the loser's retry is refused | OBSOLETE | none | M1 task 2 |
| 426 | `TestRotationsCountsRotationsAndNothingElse` | The rotation generation moves only on a successful rotate; `VaultKeys` reads one row | OBSOLETE | none | M1 task 2 |
| 468 | `TestValidBase64URLTakesPaddingOnlyAtTheEnd` | `validBase64URL` allows "=" only as trailing padding and enforces its ceiling; the three named wrappers inherit it | SPLIT: the `ValidWrapped/Sealed/Invite` line goes; the function stays through `ValidDeviceID` | device id validation | M1 task 2 |
| 508 | `TestACrashBetweenSpendingAnInviteAndRegisteringSpendsNeither` | A failure injected between spend and register leaves no device and the invite outstanding (529-531, the plan's ":530"); the same string then redeems | GUARANTEE (confirmed) | invite token redemption, atomic `RedeemInvite` | M1 task 2, task 11 |
| 557 | `TestARedeemRacingARevokeLeavesTheVaultConsistent` | Twenty races of redeem against revoking the only device through two handles: never an empty vault, the redemption is both halves or neither, the revoke fails only with ErrLastDevice | GUARANTEE (confirmed; the never-empty half depends on hazard 4) | invite token redemption against revoke from a device or the control socket | M1 task 11 |
| 623 | `TestARedeemRacingARotationCannotWin` | Rotation deletes every invite in its own transaction, so a racing redemption either happened or is refused and never redeems afterwards | OBSOLETE (nothing in Trew retires all invites at once) | none | M1 task 2 |
| 679 | `TestAnUnclaimedVaultHasNothingToRedeem` | Redeeming against an unclaimed vault is ErrNoInvite, like an unknown invite | GUARANTEE ("unclaimed" becomes unknown vault; the wire form is also `disclosure_test.go:309`) | invite token redemption | M1 task 2 |
| 695 | `TestARedemptionOntoAnExistingIdChangesNothing` | Redeeming onto an existing device id is ErrDeviceExists; the row's hash and name and the invite are untouched | GUARANTEE (hazard 3) | invite token redemption, lost-reply redemption | M1 task 2, M0.5 task 1 |
| 743 | `TestConcurrentRedemptionsOfOneInviteRegisterExactlyOneDevice` | Eight handles redeem one invite at once, twenty times: one winner, one row holding the winner's hash, the invite spent, nothing redeems afterwards | GUARANTEE | invite token redemption (a single-statement spend) | M1 task 2, task 11 |

### `internal/server/auth_test.go` (9)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 36 | `TestAnUnclaimedVaultIsOpenedOnlyByTheBootstrapToken` | Only the bootstrap token, with a claim, opens an unclaimed vault | OBSOLETE | none; the first device pairs from the first-run invite | M1 task 7, task 9 |
| 50 | `TestTheBootstrapStopsWorkingOnceTheVaultIsClaimed` | The bootstrap works once; the claimed key opens the vault; an unrelated key does not | SPLIT: bootstrap and vault key go; "a first-run credential works once" is the first-run invite's single use, covered by the invite rows | first-run invite | M1 task 9 |
| 69 | `TestAClaimedVaultCannotBeReclaimed` | A second device cannot re-point the vault credential, and the first is not locked out | OBSOLETE; the device-row analogue is `internal/store/devices_test.go:585` | none | M1 task 7 |
| 87 | `TestClaimingNeedsAKey` | The bootstrap without a claim opens nothing | OBSOLETE | none | M1 task 7 |
| 98 | `TestTheServerStoresAHashAndNotTheKey` | The stored credential is hex SHA-256 of the key and never the key | GUARANTEE | device token hash lookup, `invites.token_hash`, `mcp_tokens.token_hash` | M1 task 2, M4 task 2 |
| 122 | `TestOnlyTheServedVaultCanBeClaimed` | A hello for a vault the server does not serve is refused and creates no vault row | GUARANTEE (also `protocol_test.go:1059, :1087`) | served-vault check on device hello and redemption | M1 task 7 |
| 140 | `TestAVaultWillNotBeBoundToAGuessableKey` | Keys shorter than `MinClaimLength` are refused | GUARANTEE (the floor must hold for the device token a redemption registers, once `MinClaimLength` goes) | invite token redemption | M1 task 7, M0.5 task 1 |
| 157 | `TestAVaultIsNotClaimedWithoutADataKey` | A claim with an empty, malformed or oversized wrapped key is refused and binds nothing | OBSOLETE | none | M1 task 7 |
| 177 | `TestAServerWithNoBootstrapClaimsNothing` | An empty token never matches an empty bootstrap | GUARANTEE (an empty credential never matches) | device hello with an empty token, redemption with an empty invite, an empty MCP bearer | M1 task 7, M4 task 2 |

### `internal/server/invite_test.go` (18)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 73 | `TestOutstandingInvitesAreVisibleAndCarryNothingThatRedeems` | `devices` lists invites as `[]` not null; an issued invite shows exactly `{id, expiresAt}` and no sealed blob; a redeemed one leaves the list and appears as a device | GUARANTEE (hazard 1) | invite token rows in `devices.invites` | M1 task 1, task 11 |
| 129 | `TestAnExpiredInviteLeavesTheList` | An expired invite is not listed | GUARANTEE | invite token rows | M1 task 11 |
| 147 | `TestAnOutstandingInviteCanBeCancelled` | `uninvite` removes it and the string stops redeeming; a second cancel and an unknown id get the same `badentry` naming the device list; the session survives | GUARANTEE | `uninvite` by a handle that cannot redeem | M1 task 7, task 11 |
| 195 | `TestTheRecoveryKeySeesAndCancelsInvites` | The recovery-key registrar lists and cancels invites | SPLIT: the registrar goes; the credential of last resort seeing and cancelling invites moves to the admin | control socket admin | M1 task 9 |
| 215 | `TestCrashedPairingsDoNotPreventMoreDevicesJoining` | 24 redeemed but never-connected rows do not stop another device joining; 25 rows show last_seen 0 | GUARANTEE | invite token redemption | M1 task 11 |
| 244 | `TestI23AnInviteIsRedeemedExactlyOnce` | The invite reply echoes its id and an expiry near now plus TTL; redemption returns the device id and no wrapped key; the second, unknown and malformed tries get one identical `auth`; the issuer is untouched | SPLIT: the sealed and wrapped checks go; the rest stays | invite token redemption | M1 task 7, task 11 |
| 293 | `TestI23AnExpiredInviteIsRefused` | A redemption after expiry is `auth` | GUARANTEE | invite token redemption | M1 task 11 |
| 307 | `TestI23TheTTLDefaultsAndIsCapped` | No TTL gives `DefaultInviteTTL` (10 minutes); five hours is capped at `MaxInviteTTL` (1 hour); a negative TTL is `badentry` | GUARANTEE (values change: one-hour default and `--ttl 0` per protocol.md) | invite TTL on the wire op and on `trew invite` | M1 task 1, task 9 |
| 328 | `TestI23InviteRefusals` | A registrar may not issue invites; malformed invite requests are `badentry` and the session survives; an unclaimed vault has nothing to redeem | SPLIT: the registrar and sealed-payload subtests go; the third stays (also `disclosure_test.go:309`) | invite token redemption | M1 task 7 |
| 369 | `TestI23RotateDeletesOutstandingInvites` | A rotation deletes every outstanding invite | OBSOLETE | none | M1 task 7 |
| 399 | `TestI23AnInviteIdentifierIsRefusedTheSecondTime` | A reused client-chosen invite id is non-retryable `badentry` and changes nothing | OBSOLETE (the server mints tokens; the retryable table stays in `protocol_test.go:232`) | none | M1 task 7 |
| 437 | `TestI23AHelloWithBothATokenAndAnInviteIsRefused` | A hello with a token and an invite is `badentry` naming "both", closes, and leaves the invite redeemable | GUARANTEE | hello carrying a device token and an invite | M1 task 7 |
| 479 | `TestARedeemedInviteRegistersTheDeviceThatRedeemedIt` | Redemption adds exactly one row, named from the hello, with last_seen 0, whose key then connects; that device may not register or rotate; the issuer is undisturbed | SPLIT: the register and rotate refusals and the sealed check go; registration and first connect stay | invite token redemption, device token hash lookup | M1 task 7, task 11 |
| 539 | `TestAnInviteRedeemedTwiceRegistersOneDevice` | A second redemption by another device is `auth` and adds no row | GUARANTEE | invite token redemption | M1 task 11 |
| 572 | `TestARedeemThatCannotRegisterLeavesTheInviteUnspent` | Redeeming onto an existing id is `badentry`, the row's hash is unchanged, and the invite stays outstanding and later redeems | GUARANTEE (hazard 3) | invite token redemption | M1 task 7, task 11 |
| 617 | `TestARedeemingHelloMustNameTheDeviceItRegisters` | No or malformed device id is `badname`; no or too-short auth is `badentry`; a newline in the name is `badname`; none of the five spends the invite or adds a row | GUARANTEE (the auth field becomes `token`, and its floor replaces `MinClaimLength`) | invite token redemption | M1 task 7, M0.5 task 1 |
| 664 | `TestAHelloWithBothAClaimAndAnInviteIsRefused` | A claim and an invite together are `badentry` and leave the invite | OBSOLETE | none | M1 task 7 |
| 691 | `TestARevokedDeviceComesBackWithAnInvite` | Revoking closes the revoked session; a new invite re-adds it under a new id that connects; the old id stays gone | GUARANTEE | revoke, invite token redemption | M1 task 11, M3 |

### `internal/server/invite_doc_test.go` (1)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 83 | `TestI23TheDocsStateTheInviteLifetimeTheCodeUses` | Every invite duration in the README, client README, server, plugin and protocol docs equals the default or maximum TTL, and there are at least five mentions | GUARANTEE (constants and docs both change) | invite TTL constants | M1 task 9, M9 |

### `cmd/trew/token_s11_test.go` (3)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 14 | `TestS11WriteTokenFileIsExactAndPrivate` | `writeTokenFile` writes the exact bytes at 0600 and leaves no temporary file | GUARANTEE | secret output file | M1 task 9 |
| 40 | `TestS11OverwritingA0644TokenTightensItTo0600` | Overwriting a 0644 file leaves it 0600 with the new content | GUARANTEE | secret output file | M1 task 9 |
| 64 | `TestS11CopyTokenIntoABackupIsPrivate` | `copyToken` writes the token into a backup at 0600, tightening a stale 0644 copy | OBSOLETE (backups carry no token file) | none | M1 task 12 |

### `internal/server/unlimited_devices_test.go` (2)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 10 | `TestMoreThanEightDevicesCanRegister` | A registrar registers 23 more devices, giving 24 rows | GUARANTEE (also `invite_test.go:215`, `internal/store/devices_test.go:849`) | invite token redemption | M1 task 11 |
| 24 | `TestMoreThanEightConnectionsReceiveCommits` | 24 live sessions all receive one put and fetch it | GUARANTEE | unchanged | none |

### `internal/server/release_review_test.go` (4)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 13 | `TestInviteTTLIsClampedBeforeDurationConversion` | TTLs near the int64 limit clamp to the maximum without overflow, and the invite still redeems | GUARANTEE | invite TTL wherever it is accepted | M1 task 1, task 9 |
| 33 | `TestRegistrarPublicationMayRaceConnectionFailure` | A socket failure killing a registrar hello mid-publication is race-free under `-race` | SPLIT: the registrar goes; `helloAsDevice` publishes the same way (`session.go:996`) and has no such test | device hello publication (a pre-publish hook) | M1 task 7 |
| 69 | `TestRotationDoesNotInspectAnUnpublishedHandshake` | `registrarsOn` skips sessions still in the pre-auth count | OBSOLETE (revoke finds sessions through `hub.sessionsOf`, which holds only joined ones) | none | M1 task 7 |
| 89 | `TestRotationBeforeRegistrarPublicationRetiresTheOldCredential` | A rotation during registrar publication refuses and closes the late registrar | OBSOLETE (the device analogue is `devices_test.go:643, :669`) | none | M1 task 7 |

### `internal/server/protocol_test.go` (27)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 43 | `TestI1RepliesAndRefusalsEchoTheRequestId` | Every reply and refusal echoes its request id | GUARANTEE | unchanged (setup drops `Mac`) | M1 task 1 |
| 84 | `TestI1UnsolicitedFramesCarryNoId` | batch, caught-up and pong carry no id; ready does | GUARANTEE | unchanged | M1 task 1 |
| 122 | `TestI1ARequestWithoutAnIdEndsTheSession` | A missing, oversized or negative id is `protostate` and closes the session | GUARANTEE | unchanged | M1 task 1 |
| 149 | `TestI1FetchIsAnsweredByABodiesHeaderOrAnError` | A fetch answers a bodies header with an exact count, or one error and no frames | GUARANTEE | frame codec on fetch | M1 task 6 |
| 190 | `TestI1AFetchWithARottedBodyIsRefusedBeforeTheHeader` | A rotted body is found before the header, the session survives, and the body is set aside | GUARANTEE | frame codec on fetch | M1 task 6 |
| 232 | `TestI2ErrorsCarryRetryablePerTheTable` | `busy` is retryable with a hint; auth, cursor, proto and request refusals are not | GUARANTEE (the auth row uses a registrar hello; use a device hello and add `badpath`) | device token hash lookup, path policy | M1 task 1, task 3 |
| 300 | `TestI2TheShutdownNoticeIsRetryableWithAHint` | The shutdown notice has no id, is retryable and has a hint | GUARANTEE | unchanged | none |
| 326 | `TestI3ReadyAdvertisesTheCapsAndTheVersion` | ready advertises the enforced caps, protocol range and server version | GUARANTEE (ready loses `wrapped`) | unchanged | M1 task 1 |
| 361 | `TestI5ClaimStoresTheWrappedKeyAndReadyReturnsIt` | The claim stores the wrapped key; register and ready hand it back | OBSOLETE | none | M1 task 7 |
| 393 | `TestI5AClaimWithoutADataKeyIsRefused` | A claim with no wrapped key is refused and binds nothing | OBSOLETE | none | M1 task 7 |
| 412 | `TestI5AMalformedWrappedKeyIsRefusedAtClaim` | A malformed or oversized wrapped key is refused at claim | OBSOLETE | none | M1 task 7 |
| 435 | `TestI5ReadyAlwaysCarriesWrappedForAClaimedVault` | ready carries the wrapped key for every claimed vault, including after rotation | OBSOLETE | none | M1 task 7 |
| 479 | `TestI5AVaultClaimedWithNoDataKeyIsRefusedAtHello` | A vault row from an older build with no data key is refused at hello with an operator-actionable message | SPLIT: the data key goes; "a directory an older build wrote is refused with something an operator can act on" stays | store_identity (refused before any write, input byte-identical) | M1 task 8 |
| 566 | `TestI5RotateReplacesTheSecretAndClosesOtherRegistrars` | Rotate swaps the credential, evicts other registrars, and keeps history | OBSOLETE | none | M1 task 7 |
| 611 | `TestRotationLeavesEveryDeviceRowAndEverySessionAlone` | Rotation leaves every device row and live session untouched | OBSOLETE | none | M1 task 7 |
| 658 | `TestI5RotateEvictsEveryPeerAtOnce` | The peers a rotation retires are evicted in parallel, within the timeout | SPLIT: rotation goes; `handleRevoke` evicts with the same loop (`session.go:2774`) and has no such test | revoke eviction of a device's several sessions, including control-socket revoke | M1 task 9, task 11 |
| 705 | `TestI5RotateRefusals` | A bootstrap session, a device and malformed requests may not rotate, and nothing changes | OBSOLETE | none | M1 task 7 |
| 763 | `TestS24VaultAndDeviceAreBoundedAndFreeOfControlCharacters` | Vault and device names over the bound or with control characters are `badname`; names at the bound work | GUARANTEE (setup uses a registrar hello and `ClaimVault`) | device hello | M1 task 7 |
| 809 | `TestADeviceIDIsBoundedAndBase64URL` | An over-long, non-base64url or slashed device id is `badname` and closes | GUARANTEE (add an `mcp:` id row, per M1 task 7) | device hello | M1 task 7 |
| 832 | `TestAHelloOutsideTheRangeIsRefusedNamingBothNumbers` | An unsupported protocol is refused naming the asked version and the range | GUARANTEE (hazard 7: probe with protocol 7) | wire `Proto = MinProto = 1` | M1 task 1 |
| 855 | `TestI9TwoClientsAgainstTheSameServer` | Two devices see each other's writes and their own echo as an empty range | GUARANTEE (setup through invites) | unchanged | M1 task 11 |
| 898 | `TestRotateIsRefusedWhenAnotherDeviceRotatedFirst` | A rotate under a retired credential is `rotated`, changes nothing, and closes | OBSOLETE | none | M1 task 7 |
| 937 | `TestRegisterIsRefusedWhenTheVaultWasRotatedFirst` | A registration under a retired root is `rotated` and registers nothing | OBSOLETE | none | M1 task 7 |
| 966 | `TestARotationLandingInsideARegistrationRefusesIt` | A rotation committing mid-registration refuses it | OBSOLETE | none | M1 task 7 |
| 994 | `TestTwoConcurrentRotationsAndOnlyOneWins` | Of two racing rotations exactly one lands | OBSOLETE | none | M1 task 7 |
| 1059 | `TestADeviceOfAnUnservedVaultIsRefused` | A device of another vault in the same store is refused on a server serving one vault | GUARANTEE (setup uses the vault hash) | served-vault check on device hello | M1 task 7 |
| 1087 | `TestAnInviteForAnUnservedVaultIsRefusedWithoutBeingSpent` | A redemption for an unserved vault is `auth` and does not spend the invite | GUARANTEE | served-vault check before the invite is looked up | M1 task 7 |

### `internal/server/devices_test.go` (22)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 29 | `TestTheVaultCredentialCannotSync` | A registrar is refused every sync op, writes nothing and is in no fan-out | OBSOLETE | none | M1 task 7 |
| 80 | `TestTheVaultCredentialIsNotADeviceCredential` | The vault key offered as a device key opens nothing | OBSOLETE | none | M1 task 7 |
| 96 | `TestAnUnknownDeviceAndAWrongKeyAreOneRefusal` | A wrong key and an unregistered id get the same refusal | GUARANTEE | device token hash lookup | M1 task 7 |
| 121 | `TestTheRecoveryKeyRegistersADeviceWhenEveryDeviceIsGone` | With every device revoked, the recovery key registers one that then syncs | SPLIT: the recovery key goes; getting back into a store with history and no devices stays | control socket admin (`trew invite`, then redemption) | M1 task 9 |
| 159 | `TestTheRecoveryKeyAdministersTheDeviceListAndReadsNoNote` | The recovery key lists and revokes devices but reads and writes no note | SPLIT: listing and revoking move to the admin; "reads no note" goes (the admin has the data directory) | control socket admin | M1 task 9 |
| 212 | `TestADeviceMayNotRegisterAnotherDevice` | A device's `register` is `auth` and adds no row | OBSOLETE (`register` goes; devices add devices through invites, which are listed) | none | M1 task 7 |
| 236 | `TestRegisteringTheSameDeviceTwiceIsIdempotent` | The same id and key twice is success; a different key under that id is `badentry` and changes nothing | SPLIT: `register` goes; the retry rule is what a redemption retry needs (hazard 3) | lost-reply redemption | M0.5 task 1 |
| 270 | `TestRegisterRefusals` | Bad or over-long ids are `badname`; missing or guessable keys `badentry`; bad or over-long names `badname`; nothing is written | SPLIT: `register` goes; the field checks stay on redemption, where `invite_test.go:617` lacks the over-long id and name rows | invite token redemption | M1 task 7 |
| 307 | `TestARegistrarWithNoVaultCredentialRegistersNothing` | A registrar whose grant names no vault hash registers nothing | OBSOLETE | none | M1 task 7 |
| 333 | `TestTheDeviceListIsUsableAndCarriesNoCredential` | The list names every device, allows duplicate names, carries no credential and is `[]` when empty | GUARANTEE (extend to invite token hashes and MCP author rows) | device list | M1 task 11, M5 task 8 |
| 407 | `TestARevokedDeviceCannotConnect` | A revoked device's hello is `auth` | GUARANTEE | unchanged | M1 task 11 |
| 437 | `TestRevokingClosesTheRevokedDevicesLiveSession` | Revoking closes the live session with an unsolicited `auth` that says what to do | GUARANTEE | unchanged | M1 task 11 |
| 465 | `TestRevokingOneDeviceDisturbsNoOther` | Revoking one device leaves the others syncing | GUARANTEE | unchanged | M1 task 11 |
| 494 | `TestADeviceMayRevokeItselfAndTheSessionEnds` | Self-revocation says `self` and ends the session | GUARANTEE | unchanged | M1 task 11 |
| 532 | `TestADeviceMayNotEmptyTheVault` | A device cannot revoke the last device with or without `allowLast`; the recovery key can, with it | SPLIT, decision-dependent (hazard 4): the recovery-key half moves to the admin or goes with `allowLast` | control socket admin, or protocol.md's rule | M1 task 7, task 9 |
| 588 | `TestARevokeRacingARotationCannotWin` | A revoke under a retired root is `rotated` and removes nothing | OBSOLETE | none | M1 task 7 |
| 617 | `TestRevokingADeviceThatIsNotThere` | An unknown device is `nodevice`, not retryable; a malformed id is `badname` | GUARANTEE | unchanged | M1 task 11 |
| 643 | `TestARevokeRacingAConnectAlwaysWins` | A revoke landing between the credential check and the join still refuses the connect | GUARANTEE | unchanged | M1 task 11 |
| 669 | `TestReusingARevokedDeviceIDDoesNotCompleteItsOldHandshake` | A handshake whose row was revoked and re-registered under another key does not complete, and the replacement works | GUARANTEE (setup reads the vault hash) | device token hash lookup | M1 task 11 |
| 716 | `TestLastSeenMovesOnConnectAndNotOtherwise` | last_seen moves on connect and on nothing else | GUARANTEE | unchanged | none |
| 754 | `TestADeviceRenamesItself` | A device renames itself, repeatedly, and a bad name changes nothing | GUARANTEE (setup through invites) | unchanged | M1 task 11 |
| 809 | `TestARegistrarHasNoNameToChange` | A registrar's `rename` is `auth` naming the op | OBSOLETE | none | M1 task 7 |

### `internal/store/budget_test.go` (7)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 32 | `TestAnEntryCannotReferenceMoreCiphertextThanItsSizeAllows` | Eight 64 KiB chunks under a declared size of 1 are refused with the numbers in the message, and nothing commits | GUARANTEE | size invariant | M1 task 4 |
| 54 | `TestAnHonestlySizedEntryFitsTheBudget` | An honest file with 28 bytes of per-chunk overhead fits | SPLIT: the overhead allowance goes; "an honest entry is accepted" becomes size equal to the raw sum, and needs its mirror (a sum that differs in either direction is refused) | size invariant | M1 task 4 |
| 71 | `TestTheBudgetCountsRepeatedChunksOncePerReference` | Repeated references count once per reference, not once per body | GUARANTEE | size invariant | M1 task 4 |
| 112 | `TestReferencingAlreadyHeldChunksIsStillBudgeted` | An entry pointing at already-held chunks with no upload is still checked at commit | GUARANTEE (this is the case §2.2's "verify only the chunks uploaded in this session" shortcut must not skip) | size invariant | M1 task 4 |
| 132 | `TestCiphertextBudgetArithmetic` | `CiphertextBudget(size, n)` is size plus n times `ChunkOverheadMax` | OBSOLETE | none | M1 task 4 |
| 157 | `TestAZeroByteFileHasExactlyOneShape` | A zero-byte entry with chunks is refused; with none it is valid | GUARANTEE (an empty raw chunk would satisfy the size sum, so the rule stays explicit) | `Entry.Validate` | M1 task 3, task 4 |
| 182 | `TestEntriesLeaveTheStoreWithAnArrayNotNull` | Folders, deletions and empty files come back with `[]` chunk lists | GUARANTEE | unchanged | none |

## Tier 1 ledger: TypeScript

### `client/src/core/crypto.test.ts` (60)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 48 | the key schedule > derives the same keys from the same secret, every time | Root keys and sealed paths are deterministic for one secret | OBSOLETE | none | M2 task 1 |
| 59 | the key schedule > derives different auth keys from different root secrets | Different roots give different auth keys | OBSOLETE | none | M2 task 1 |
| 72 | the key schedule > keeps a device's auth key apart from the vault's, even from the same bytes | Device and vault derivations use distinct info strings | OBSOLETE | none | M2 task 1 |
| 77 | the key schedule > derives a device's auth key from its own secret and nothing else | The device auth token is a pure function of its secret | OBSOLETE | none | M2 task 1 |
| 84 | the key schedule > separates the four keys, so one purpose cannot open another's | The content key cannot open a path seal | OBSOLETE | none | M2 task 1 |
| 94 | the key schedule > refuses keying material with too little entropy to be a key | 8-byte inputs are refused by all three derivations | OBSOLETE (the length floor moves to DeviceConfig decode and to redemption) | none | M2 task 1 |
| 104 | the key schedule > names a suite the server also names | `CRYPTO_SUITE` is the suite string | OBSOLETE | none | M2 task 1 |
| 108 | the key schedule > produces a wire-safe auth token, for a vault and for a device | Vault and device tokens are base64url; the device one is at least 32 characters | SPLIT: the vault half goes; the device token's encoding and floor stay | device token generation | M2 task 5, task 6 |
| 117 | sealing > round trips | Text round-trips through `sealChunk` and `openChunk` | GUARANTEE | frame codec round trip | M2 task 1 |
| 124 | sealing > round trips an empty input | Empty input round-trips; the sealed length is 29 | SPLIT: the 29 goes; the empty-body round trip stays | frame codec | M0.5 task 2, M2 task 1 |
| 132 | sealing > round trips bytes that are not text | Binary input round-trips | GUARANTEE | frame codec | M2 task 1 |
| 146 | sealing > is deterministic, which is what makes deduplication work at all | The same plaintext gives the same sealed bytes and the same name | SPLIT: sealing determinism goes; "the name is a function of the raw bytes, never of the encoding" stays (§2.2) | digest.ts `chunkName` over raw bytes | M2 task 1 |
| 156 | sealing > is deterministic across separate key derivations | Two derivations of one secret seal identically | OBSOLETE | none | M2 task 1 |
| 165 | sealing > gives different plaintexts different nonces | Nonces differ by plaintext | OBSOLETE | none | M2 task 1 |
| 174 | sealing > never costs more than 29 bytes above the content | Incompressible input seals to exactly its size plus 29 | GUARANTEE (the bound becomes one marker byte) | frame codec overhead | M0.5 task 2, M2 task 1 |
| 189 | sealing > shrinks content that compresses | Repetitive text seals to under half and round-trips | GUARANTEE | frame codec deflate | M2 task 1 |
| 197 | sealing > keeps compression deterministic, so dedup still works | The same text seals to the same bytes | OBSOLETE (retired by §2.2: codec output never affects identity) | none | M2 task 1 |
| 206 | sealing > hides whether a chunk compressed | The marker is not visible outside the ciphertext | OBSOLETE (the frame marker is visible by design) | none | M2 task 1 |
| 240 | sealing > refuses a chunk whose marker it does not know | Marker 99 is refused | GUARANTEE | frame decode | M0.5 task 2, M2 task 1 |
| 249 | sealing > refuses a tampered body rather than returning what it can | AEAD refuses a flipped byte | OBSOLETE (integrity now comes from the name check on fetch) | none | M2 task 1 |
| 257 | sealing > refuses a tampered nonce | AEAD refuses a flipped nonce | OBSOLETE | none | M2 task 1 |
| 265 | sealing > refuses a value too short to be sealed | 20 bytes are refused as too short | OBSOLETE (the frame analogue, a zero-length frame with no marker, belongs in M0.5 task 2) | none | M2 task 1 |
| 270 | sealing > refuses a value sealed by another vault | Another vault's chunk does not open | OBSOLETE | none | M2 task 1 |
| 282 | paths > round trip, including the characters that break sync implementations | Paths with colons, emoji, accents, quotes, depth, trailing spaces and backslashes seal, are wire-safe and open | SPLIT: sealing goes; the corpus belongs in the path-policy fixtures (end to end it is already `server-harness.test.ts:422`) | path policy fixtures | M0.5 task 3 |
| 301 | paths > is deterministic, so the server can tell two versions of one file apart | One path seals one way | OBSOLETE | none | M2 task 1 |
| 306 | paths > gives different paths different ciphertext | Different paths seal differently | OBSOLETE | none | M2 task 1 |
| 317 | paths > is reversible, unlike a hash | A sealed path opens | OBSOLETE | none | M2 task 1 |
| 323 | paths > stays inside the server's path bound for a realistic path | A long realistic path seals under 4096 bytes | OBSOLETE (hazard 9: the bound becomes 1024 plaintext bytes) | none | M2 task 1 |
| 341 | chunk names > agrees with the server, byte for byte | Four fixed SHA-256 vectors | GUARANTEE | digest.ts `chunkName`, vectors shared with Go through `protocol-fixtures.json` | M2 task 1, M0.5 task 6 |
| 359 | chunk names > is 64 lowercase hex characters, which is what the server accepts | Names match `^[0-9a-f]{64}$` | GUARANTEE | digest.ts | M2 task 1 |
| 386 | a view into a larger buffer > names a chunk by its own bytes, not its neighbours' | Subarrays at offsets 0, 32 and 64 name like a copy | GUARANTEE | digest.ts | M2 task 1 |
| 392 | a view into a larger buffer > seals to the same ciphertext either way | A subarray seals like a copy | OBSOLETE (a frame-codec twin is cheap to keep) | none | M2 task 1 |
| 401 | a view into a larger buffer > derives the same keys from a secret held in a larger buffer | A secret in a subarray derives the same keys | OBSOLETE | none | M2 task 1 |
| 413 | base64url > round trips every byte value | All 256 byte values round-trip | GUARANTEE | digest.ts base64url | M2 task 1 |
| 419 | base64url > round trips every length modulo 3, where padding bugs live | Lengths 0 to 12 round-trip | GUARANTEE | digest.ts base64url | M2 task 1 |
| 427 | base64url > emits no padding and nothing needing escaping in JSON or a URL | Output matches `^[A-Za-z0-9_-]+$` | GUARANTEE | digest.ts base64url | M2 task 1 |
| 433 | base64url > refuses a mangled value rather than decoding around it | `$` and `=` are refused | GUARANTEE | digest.ts base64url | M2 task 1 |
| 440 | base64url > refuses a length that leaves a dangling sextet | A spare trailing character is refused | GUARANTEE | digest.ts base64url | M2 task 1 |
| 450 | base64url > refuses unused bits that are not zero | Nonzero unused low bits are refused | GUARANTEE | digest.ts base64url | M2 task 1 |
| 465 | generateSecret > returns 32 unpredictable bytes | 32 bytes, two draws differ | GUARANTEE (`generateSecret` goes; the property moves to the device token) | device token generation | M2 task 5, task 6 |
| 480 | the data key > is unwrapped identically by two devices holding the same root | Two devices with one root unwrap one data key | OBSOLETE | none | M2 task 1 |
| 501 | the data key > gives two roots holding one data key the same content keys | Two roots wrapping one data key seal identically | OBSOLETE | none | M2 task 1 |
| 520 | the data key > refuses to unwrap under another root, and says which thing is wrong | Another root cannot unwrap, and the error says so | OBSOLETE | none | M2 task 1 |
| 530 | the data key > survives a rotation of the root: re-wrapped under a new root, the same key comes out | Rewrapping keeps the content keys | OBSOLETE | none | M2 task 1 |
| 554 | sealing a data key for an invite > opens under the invite key and under nothing else | The sealed data key opens only under its invite key | OBSOLETE | none | M2 task 1 |
| 563 | sealing a data key for an invite > seals the same key differently each time, so two invites do not compare equal | Two seals of one key differ | OBSOLETE | none | M2 task 1 |
| 569 | sealing a data key for an invite > refuses to unseal anything that is not a data key's length | A 20-byte unseal is refused | OBSOLETE | none | M2 task 1 |
| 582 | sealing a whole file's chunks > gives the same result as sealing them one at a time | Batch output equals one-at-a-time output, bytes and names | GUARANTEE (also `engine.test.ts:2287`) | windowed hash naming | M2 task 4 |
| 595 | sealing a whole file's chunks > keeps the chunks in order, which is what reassembly depends on | 50 chunks come back in order | GUARANTEE | windowed hash naming | M2 task 4 |
| 604 | sealing a whole file's chunks > handles a file with no chunks | An empty list gives an empty result | GUARANTEE | windowed hash naming | M2 task 4 |
| 625 | deciding whether a chunk is worth compressing > still compresses text, which is what a vault is mostly made of | Prose ends up under half its size and round-trips | GUARANTEE | frame codec (`worthDeflating`) | M2 task 1 |
| 632 | deciding whether a chunk is worth compressing > round trips incompressible bytes, which are no longer deflated at all | 256 KiB of noise round-trips | GUARANTEE | frame codec, marker 0 | M2 task 1 |
| 638 | deciding whether a chunk is worth compressing > names the same content the same way every time | Prose, noise and empty input name identically every time | GUARANTEE (now: the name never depends on the probe or marker) | digest.ts, frame codec | M2 task 1 |
| 648 | deciding whether a chunk is worth compressing > round trips a chunk that is mostly compressible behind a random start | The probe's worst case round-trips | GUARANTEE | frame codec probe | M2 task 1 |
| 679 | an entry nobody but a key holder could have written > verifies what it produced | `macEntry` output verifies | OBSOLETE (§3.6 accepts losing writer authenticity) | none | M2 task 1 |
| 685 | an entry nobody but a key holder could have written > refuses every field changed one at a time | Every altered field fails the MAC | OBSOLETE | none | M2 task 1 |
| 707 | an entry nobody but a key holder could have written > refuses a mac from a different vault | Another vault's MAC fails | OBSOLETE | none | M2 task 1 |
| 714 | an entry nobody but a key holder could have written > refuses a mac of the wrong length rather than comparing it | Empty and short MACs fail | OBSOLETE | none | M2 task 1 |
| 725 | an entry nobody but a key holder could have written > does not confuse fields that could run together | Length prefixes keep fields apart | OBSOLETE | none | M2 task 1 |
| 736 | an entry nobody but a key holder could have written > names a parent stably, and gives no parent an empty name | `parentOf` is stable, 64 hex, and empty for none | OBSOLETE | none | M2 task 1 |

### `client/src/core/pairing.test.ts` (43)

The 26 codec cases were written against `basalt3_` (recovery key) and `basalt3i_` (invite). Every codec property they pin carries over to the trew1i_ string, which has the same family of layout: a version byte, fixed and length-prefixed fields, CRC-32, base64url.

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 36 | round tripping > gives back exactly what went in | url, vault and secret round-trip | GUARANTEE | trew1i_ codec (url, vault, token) | M0.5 task 1, M2 task 5 |
| 44 | round tripping > survives a real generated secret, every time | 200 random secrets round-trip, so no length byte is read as data | GUARANTEE | trew1i_ codec with random tokens | M0.5 task 1, M2 task 5 |
| 54 | round tripping > survives the whitespace a paste brings with it | Surrounding whitespace is trimmed | GUARANTEE | trew1i_ codec | M2 task 5 |
| 59 | round tripping > carries fields that are not ASCII | A non-ASCII vault id round-trips | GUARANTEE | trew1i_ codec | M2 task 5 |
| 64 | round tripping > is one word, so it survives being sent in a message | The string is one base64url word after its prefix | GUARANTEE | trew1i_ codec | M2 task 5 |
| 75 | round tripping > carries a 32-byte root, and refuses any other length | A 32-byte root round-trips; 20 bytes are refused at format time | SPLIT: the root goes; refusing a fixed field of the wrong length stays, for the 16-byte token | trew1i_ codec | M0.5 task 1, M2 task 5 |
| 96 | refusing a string it cannot read completely > refuses something that is not a pairing string at all | "hello" and "" are refused, naming the prefix | GUARANTEE | trew1i_ codec | M2 task 5 |
| 101 | refusing a string it cannot read completely > tells an invite from a recovery key, in both directions | Each parser names the other kind | OBSOLETE (one kind of string remains; a pasted Basalt string could be named as Basalt's) | none | M2 task 5 |
| 115 | refusing a string it cannot read completely > refuses a credential with one character appended | A spare character that adds no byte is refused, for both kinds | GUARANTEE | trew1i_ codec | M2 task 5 |
| 133 | refusing a string it cannot read completely > refuses a credential whose unused final bits were flipped | Flipped unused bits are refused, for both kinds | GUARANTEE | trew1i_ codec | M2 task 5 |
| 153 | refusing a string it cannot read completely > refuses one that lost its end | Cutting 1, 4, 12 or 40 characters is refused | GUARANTEE | trew1i_ codec | M2 task 5 |
| 160 | refusing a string it cannot read completely > refuses one with a character changed | Every single-character change is refused (the CRC) | GUARANTEE | trew1i_ codec | M2 task 5 |
| 178 | refusing a string it cannot read completely > refuses two characters swapped | Every adjacent transposition is refused | GUARANTEE | trew1i_ codec | M2 task 5 |
| 192 | refusing a string it cannot read completely > refuses a version it does not understand | Version 4 with a valid CRC is refused by version | GUARANTEE | trew1i_ codec | M0.5 task 1 |
| 201 | refusing a string it cannot read completely > refuses a length that points past the end | A field length past the end is refused | GUARANTEE | trew1i_ codec | M0.5 task 1 |
| 209 | refusing a string it cannot read completely > refuses trailing rubbish that decoded cleanly | Extra bytes before a valid CRC are refused | GUARANTEE | trew1i_ codec | M0.5 task 1 |
| 220 | refusing to make a string it could not read back > refuses a secret of the wrong length | 8 and 64 bytes are refused at format time | GUARANTEE (secret becomes token) | trew1i_ codec | M2 task 5 |
| 225 | refusing to make a string it could not read back > refuses a field too long for its length byte | A 256-character URL is refused | GUARANTEE | trew1i_ codec | M0.5 task 1 |
| 238 | server addresses that are long or not ASCII > refuses an address too long to carry | Over-long addresses are refused by both formats | GUARANTEE | `normaliseUrl`, trew1i_ codec | M2 task 5 |
| 244 | server addresses that are long or not ASCII > converts an internationalised hostname to punycode, once, on the way in | IDN hosts become punycode once and round-trip; ASCII is untouched | GUARANTEE | `normaliseUrl` (kept) | M2 task 5 |
| 255 | server addresses that are long or not ASCII > refuses a hostname that cannot be made into an address | A host with a space is refused | GUARANTEE | `normaliseUrl` (kept) | none |
| 275 | the invite string > gives back exactly what went in | url, vault, id and key round-trip | GUARANTEE (id and key become the token) | trew1i_ codec | M2 task 5 |
| 284 | the invite string > is one word with its own prefix | `^basalt3i_[A-Za-z0-9_-]+$` | GUARANTEE (prefix `trew1i_`) | trew1i_ codec | M2 task 5 |
| 289 | the invite string > refuses one with a character changed or its end lost | Every single change and every cut is refused | GUARANTEE | trew1i_ codec | M2 task 5 |
| 306 | the invite string > refuses a version it does not understand | Version 9 is refused | GUARANTEE | trew1i_ codec | M0.5 task 1 |
| 314 | the invite string > refuses an id or key of the wrong length rather than making a string it could not read | An 8-byte id and a 16-byte key are refused | SPLIT: the invite key goes; the token length check stays | trew1i_ codec | M2 task 5 |
| 319 | the invite string > refuses something that is not an invite at all | "hello" is refused, naming the prefix | GUARANTEE | trew1i_ codec | M2 task 5 |
| 351 | the names a device is told to skip > survives a round trip through the stored config | The ignore list round-trips through the config | GUARANTEE (setup: the config's key fields change) | DeviceConfig | M2 task 5 |
| 361 | the names a device is told to skip > is absent from a config that skips nothing | No `ignore` key when nothing is skipped | GUARANTEE | DeviceConfig | M2 task 5 |
| 369 | the names a device is told to skip > drops a name it cannot use rather than refusing the file | Bad names and bad JSON are dropped and the config still reads | GUARANTEE | DeviceConfig | M2 task 5 |
| 384 | the names a device is told to skip > accepts one name and no path | `isIgnorableName` refuses "", ".", "..", slashes | GUARANTEE | `isIgnorableName` (kept) | none |
| 397 | the line the server prints for the first device > splits the address from the token at the first # | `parseSetup` splits `host#TOKEN` | OBSOLETE (the setup line goes) | none | M2 task 5 |
| 411 | the line the server prints for the first device > refuses a line with no token, no address, or no # | Malformed setup lines are refused | OBSOLETE | none | M2 task 5 |
| 417 | the line the server prints for the first device > tells a pairing string apart from a setup line | A recovery key or invite is not a setup line | OBSOLETE | none | M2 task 5 |
| 422 | the line the server prints for the first device > carries the vault name after a second # | `#TOKEN#work` names the vault | OBSOLETE (the invite string carries the vault id) | none | M2 task 5 |
| 438 | the line the server prints for the first device > names the vault and the server a pasted string would join | `joinDestination` names url and vault for an invite, a recovery key or a setup line, and refuses in the shape of the field | SPLIT: the invite branch stays (R083-05: say where a pasted invite points before anything is pressable; the plugin form is `main.test.ts:1582`); the recovery-key and setup branches go | `joinDestination` invite branch | M2 task 5 |
| 507 | a config that cannot connect > hands the recovery key back when the root is all that is left | A root-only config throws `NoCredential` printing the recovery key | OBSOLETE | none | M2 task 5 |
| 530 | a config that cannot connect > says to pair again when there is no root and no credential either | An id with no credential throws `NoCredential` naming what is missing and the invite path, never "not authorised" | SPLIT: the root wording goes; the rest stays for an id without a token | DeviceConfig, `deviceCredential` | M2 task 5 |
| 546 | a config that cannot connect > still decodes a config it will refuse, because the key is inside it | A root-only config decodes, then refuses at connect | OBSOLETE | none | M2 task 5 |
| 555 | a config that cannot connect > keeps nothing a device is not meant to hold | The stored config has exactly the documented keys, and old extra fields are dropped | GUARANTEE (new set: url, vaultId, device, deviceId, deviceToken, readOnly?, ignore?) | DeviceConfig | M2 task 5 |
| 596 | ids somebody has to type > never mints a device id that a shell reads as an option | 5,000 device ids, none starts with "-" | GUARANTEE | `generateDeviceId` (kept) | none |
| 605 | ids somebody has to type > never mints an invite id that a shell reads as an option | 5,000 invite ids, none starts with "-" | GUARANTEE (minting moves to Go) | whatever handle a person types to cancel an invite | M1 task 2 |
| 615 | ids somebody has to type > keeps the invite id the length the wire format requires | The id is `INVITE_ID_LENGTH` bytes | GUARANTEE | invite token length (16 bytes) | M1 task 2, M0.5 task 1 |

### `client/src/core/invite.test.ts` (4)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 77 | issuing an invite > seals the vault's data key, and nothing that could add a device later | `invite()` returns a `basalt3i_` string with a future expiry; redeeming it yields this device's data key | SPLIT: the data key goes; a string for this vault with a future expiry, which redeems, stays | client `invite()` returning a trew1i_ string | M2 task 3, task 6 |
| 105 | issuing an invite > registers the redeeming device, so it needs no recovery key of its own | Redemption returns an id and credential; the row is listed as "phone" with lastSeen 0; the credential connects | GUARANTEE (server side also `invite_test.go:479`) | `redeemInvite` returning `{deviceId, deviceToken}` | M2 task 6 |
| 141 | issuing an invite > works once, and the refusal leaves the vault with one new device | A second redemption is "not authorised"; the list gains one device | GUARANTEE (also `main.test.ts:3956`, `cli.test.ts:1194`) | invite token redemption | M2 task 6 |
| 158 | issuing an invite > cannot be opened by anything but the key in the string | A wrong invite key fails to unseal | OBSOLETE | none | M2 task 9 |

### `client/src/core/rotation.test.ts` (9)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 73 | the session the recovery key opens > offers the vault's credential and names no device | The registrar hello carries the root-derived token and no device id | OBSOLETE | none | M2 task 9 |
| 83 | the session the recovery key opens > offers the server's first-run token while the vault is being claimed | The claiming hello carries the bootstrap, claim and wrapped key | OBSOLETE | none | M2 task 9 |
| 95 | the session the recovery key opens > hands the registering device the data key, unwrapped | `register` unwraps the data key and sends the device key, not its digest | OBSOLETE | none | M2 task 9 |
| 117 | the session the recovery key opens > refuses a registration naming a device other than the one asked for | A `registered` reply for another device id is refused | SPLIT: the registrar goes; the same check guards `redeemed` (`transport.ts:1346`), which has no test | transport `redeem` | M2 task 3 |
| 130 | the session the recovery key opens > refuses a registration with no wrapped data key, which no claimed vault has | A `registered` reply with no wrapped key is refused | OBSOLETE | none | M2 task 9 |
| 147 | rotating the vault's secret > sends the same data key, wrapped under the new root | Rotation rewraps the same data key | OBSOLETE | none | M2 task 9 |
| 160 | rotating the vault's secret > sends the new auth key, which the old root does not open | Rotation sends the new root's auth key | OBSOLETE | none | M2 task 9 |
| 180 | what a claim carries > wraps a fresh data key under the root that will hold it | The claim's wrapped key unwraps to 32 bytes | OBSOLETE | none | M2 task 9 |
| 189 | what a claim carries > makes a different key every time it is asked, so it is asked once | Two claims give two keys | OBSOLETE | none | M2 task 9 |

### `client/src/core/compression-golden.test.ts` (3)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 14 | the sealed-chunk format > seals every fixed plaintext to exactly the bytes in the table | The golden table matches byte for byte under Node | OBSOLETE (retired by §2.2) | none | M2 task 1 |
| 18 | the sealed-chunk format > pins one entry per plaintext, and the marker rule for each | One entry per plaintext; raw for empty, one byte, a short sequence and probed noise; deflate for a long repeating sequence and long text | SPLIT: the golden bytes go; the marker rule per input class stays (per runtime: Go and TypeScript may choose differently) | frame codec marker choice | M2 task 1, M1 task 5 |
| 32 | the sealed-chunk format > never seals to more than the plaintext plus 29 bytes | No fixture exceeds its size plus 29 | GUARANTEE (the bound becomes one marker byte) | frame codec overhead | M0.5 task 2, M2 task 1 |

### `client/src/core/recovery-auth.test.ts` (12)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 90 | recovery against a server that answers with entries nobody wrote > refuses a history list holding a version this vault's key did not sign | A forged MAC in a history list is refused | OBSOLETE (§3.6) | none | M2 task 9 |
| 100 | recovery against a server that answers with entries nobody wrote > refuses a deleted list the same way | A forged MAC in a deleted list is refused | OBSOLETE | none | M2 task 9 |
| 109 | recovery against a server that answers with entries nobody wrote > refuses to restore when get answers with chunks the signed version did not name | A get whose chunk list differs from the history entry's is refused and nothing is written | GUARANTEE | restore consistency checks | M2 task 6 |
| 133 | recovery against a server that answers with entries nobody wrote > refuses a history entry whose chunk names are not chunk names | A history entry with a non-name chunk is refused | GUARANTEE (hazard 5: the "not authenticated" alternative in its regex must go) | restore consistency checks (`isChunkName`) | M2 task 6 |
| 146 | recovery against a server that answers with entries nobody wrote > still restores a version that checks out | A consistent version restores to its path with its text | GUARANTEE (also `core/restore.test.ts`, `plugin/recovery.test.ts`) | unchanged | M2 task 9 |
| 174 | recovery against a server that answers with the right names (C-D4, C-D5) > refuses to restore a version that assembles to a length it does not declare | A 500-byte entry assembling to 5 bytes is refused and nothing is written | GUARANTEE | restore consistency checks | M2 task 6 |
| 205 | recovery against a server that answers with the right names (C-D4, C-D5) > refuses to restore a version whose declared size is not the server's | A get size that differs from the entry's is refused | GUARANTEE | restore consistency checks | M2 task 6 |
| 232 | recovery against a server that answers with the right names (C-D4, C-D5) > refuses a signed version of a different note | A history answer holding another note's entry is refused (F10) | GUARANTEE (becomes plain path equality) | restore consistency checks | M2 task 6 |
| 247 | recovery against a server that answers with the right names (C-D4, C-D5) > refuses a page that ignores the version it was asked to go back from | A page before 10 holding version 20 is refused | GUARANTEE | restore consistency checks | M2 task 6 |
| 256 | recovery against a server that answers with the right names (C-D4, C-D5) > refuses a page whose versions are not newest first | An out-of-order page is refused | GUARANTEE | restore consistency checks | M2 task 6 |
| 270 | recovery against a server that answers with the right names (C-D4, C-D5) > gives up on a server that keeps answering with the same page | `findVersion` stops on a page that never advances | GUARANTEE | restore consistency checks | M2 task 6 |
| 287 | recovery against a server that answers with the right names (C-D4, C-D5) > refuses a signed history entry that declares bytes and names no chunks | A 500-byte entry with no chunks is refused | GUARANTEE | restore consistency checks | M2 task 6 |

### `client/src/cli/rotate.test.ts` (7)

All seven are about rotating the recovery key across a lost reply. Two of them (163, 192) are the only tests that drive a commit-then-lose-the-reply split through a mocked `Transport` against the real binary; that technique is a ready template for the lost-reply redemption test M0.5 task 1 asks for.

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 137 | what rotate prints before it commits (F03) > shows the candidate key in JSON mode too, before the request | The new key reaches stderr before the request, and stdout stays one JSON object | OBSOLETE | none | M2 task 10 |
| 163 | a rotation whose reply never came back > finds out that it committed, and says the printed key is the vault's | A reply lost after commit is resolved by probing, and the new key works | OBSOLETE (template for M0.5 task 1) | none | M2 task 10 |
| 192 | a rotation whose reply never came back > finds out that it did not commit, and says to cross the printed key out | A reply lost before commit is reported as not committed | OBSOLETE (template for M0.5 task 1) | none | M2 task 10 |
| 212 | a rotation whose reply never came back > says so plainly when somebody rotated first, and does not offer a key | A `rotated` refusal offers no key | OBSOLETE | none | M2 task 10 |
| 232 | a rotation whose reply never came back > prints the new key before sending, not after hearing back | The key is printed even when the send fails | OBSOLETE | none | M2 task 10 |
| 250 | what a rotation leaves on a device > leaves this device's own credential exactly as it was | The device's id, secret and data key are unchanged by a rotation | OBSOLETE | none | M2 task 10 |
| 271 | what a rotation leaves on a device > leaves a second device syncing too, which is the point | A second device keeps syncing across a rotation | OBSOLETE | none | M2 task 10 |

### `client/src/plugin/rotate.test.ts` (6)

| Line | Test | Asserts | Class | Rewrite against | Owner |
|---|---|---|---|---|---|
| 173 | replacing the vault's secret from the panel > keeps the history and every device, and shows the new key to write down | The panel's rotation waits for acknowledgement, keeps the device credential and history, retires the old key | OBSOLETE | none | M2 task 9 |
| 254 | replacing the vault's secret from the panel > gives up the rotation when the panel is closed instead of acknowledged | Closing the panel settles the wait and sends nothing (R40) | OBSOLETE (R40's rule, that every wait answers on every way out, should be checked for the populated-vault confirmation) | none | M2 task 9 |
| 284 | replacing the vault's secret from the panel > finds out that a lost reply committed, and says the key is the vault's | A lost reply after commit is settled by probing | OBSOLETE | none | M2 task 9 |
| 307 | replacing the vault's secret from the panel > says the vault's secret was not replaced when the request never went out | A send that never left says "was not replaced" | OBSOLETE | none | M2 task 9 |
| 321 | replacing the vault's secret from the panel > says so plainly when somebody rotated first, and offers no key | A `rotated` refusal offers no key | OBSOLETE | none | M2 task 9 |
| 334 | replacing the vault's secret from the panel > refuses a recovery key for another vault rather than rotating this one | Another vault's key is refused | OBSOLETE | none | M2 task 9 |

## Tier 2: crypto-centric cases in files adapted in place

Only the cases whose subject or assertion is the crypto; the setup-only cases of these files change without changing meaning.

### Go

| File:line | Test | Class | What survives, against what | Owner |
|---|---|---|---|---|
| `internal/store/devices_test.go:133` | `TestRegisteringADeviceNeedsAClaimedVault` | SPLIT | "claimed" goes; registering onto a vault with no row stays ErrUnknownVault and writes nothing | M1 task 2 |
| `internal/store/devices_test.go:818` | `TestRotatingAVaultLeavesEveryDeviceRow` | OBSOLETE | none | M1 task 2 |
| `internal/store/devices_test.go:886` | `TestRegisteringUnderARetiredVaultCredentialIsRefused` | OBSOLETE | none; the `vaultHash` parameter goes | M1 task 2 |
| `internal/store/devices_test.go:921` | `TestRevokingUnderARetiredVaultCredentialIsRefused` | OBSOLETE | none | M1 task 2 |
| `internal/store/devices_test.go:956` | `TestRegisteringNamesTheCredentialItIsAuthorisedBy` | OBSOLETE | none | M1 task 2 |
| `internal/store/devices_test.go:977` | `TestDeepVerifyDecodesTheRegistry` | SPLIT | the device-row cases stay; the sealed-invite cases (blob gone, `used = 7`) are replaced by cases for the new invite rows (token hash shape, expiry, `used_at`) and for `mcp_tokens` rows | M1 task 12 |
| `internal/store/store_test.go:1351` | `TestValidateChecksTheAuthenticatorOnFoldersAndDeletions` | SPLIT | `mac` and `parent` go; F20 stays: validation covers folders and deletions, now against the path policy | M1 task 3 |
| `internal/store/store_test.go:1383` | `TestVerifyNoticesAnEntryWithNoAuthenticator` | SPLIT | `nomac` goes; verify still names, by vault and uid, a stored row every reader refuses (hazard 6) | M1 task 12 |
| `internal/store/backup_test.go:845` | `TestBackupPublishesOverAFaultItInherited` | SPLIT | the `nomac` seed goes; a backup still publishes over a metadata fault its source has, reports it, and the next backup works (hazard 6) | M1 task 12 |
| `internal/store/migrate_test.go:107` | `TestOpeningADatabaseFromAnOlderBuildAddsTheColumnsAndLosesNothing` | OBSOLETE | Basalt's ALTERs go with the fresh schema (§3.3); "an older directory loses nothing" becomes store_identity refusing a Basalt directory byte-identical | M1 task 8 |
| `internal/store/migrate_test.go:207` | `TestMigratingTwiceChangesNothing` | GUARANTEE | create-if-not-exists is idempotent | M1 task 2 |
| `internal/store/migrate_test.go:268` | `TestADatabaseFromAnOlderBuildGainsTheDevicesTable` | OBSOLETE | fresh schema | M1 task 2 |
| `internal/server/session_test.go:65` | `TestHandshakeRefusals` | SPLIT | the "unsupported crypto" row goes; the proto, token, vault, cursor and not-hello rows stay; add a protocol 7 row (hazard 7) | M1 task 1, task 7 |
| `internal/server/mutation_authorization_test.go:106` | `TestRetiredRegistrarCannotCancelANewInvite` | OBSOLETE | none; the file's other three tests are revoke races and stay | M1 task 7 |
| `internal/server/disclosure_test.go:224` | `TestTheProtoAndCryptoRefusalsStillNameWhatThisServerSpeaks` | SPLIT | the crypto-suite half goes; the proto refusal still names the asked version and the range | M1 task 1 |
| `internal/server/disclosure_test.go:309` | `TestNoPreAuthRefusalDependsOnWhetherTheVaultExists` | SPLIT | the crypto-suite row goes and the invite row sends a token; every other probe must stay byte-identical for a served and an unknown vault | M1 task 7 |
| `cmd/trew/main_test.go:671` | `TestServeKeepsItsTokenAcrossRestarts` | SPLIT | the bootstrap token goes; a restart on an empty store must not invalidate a first-run invite already written | M1 task 9 |
| `cmd/trew/main_test.go:1189` | `TestTheSetupStringNamesSomethingADeviceCanDial` | SPLIT | `printSetup` goes; the URL inside the first-run invite is never a wildcard bind | M1 task 9 |
| `cmd/trew/main_test.go:1207` | `TestAnExplicitAddressIsPrintedAsGiven` | SPLIT | an explicit address goes into the first-run invite unchanged | M1 task 9 |
| `cmd/trew/main_test.go:1218` | `TestAClaimedVaultPrintsNoToken` | SPLIT | a store with devices mints and prints no first-run invite, and says `trew invite` | M1 task 9 |
| `cmd/trew/main_test.go:1252` | `TestAClaimedVaultRefusesTheNextClaim` | SPLIT | the claim goes; through the shipped binary the first-run invite redeems once, a second use is non-retryable `auth`, and the first device still connects | M1 task 9, task 11 |
| `cmd/trew/main_test.go:1294` | `TestLocalhostPrintsAStringThatCanBePastedAsIs` | SPLIT | under `-localhost` the first-run invite carries a `ws://` loopback URL usable as is | M1 task 9 |
| `cmd/trew/ops_i17_test.go:24` | `TestS20AnExisting0644TokenIsTightenedOnLoad` | OBSOLETE | the server loads no secret file in Trew | M1 task 9 |
| `cmd/trew/ops_i17_test.go:86` | `TestI11StartupLogsVersionLatestUIDAndClaimed` | SPLIT | "claimed" goes; version and latest uid in the startup log stay | M1 task 9 |

The other cases of these files use crypto only in setup: the `RegisterDevice` shadow in `internal/store/devices_test.go`, `Mac: testMac` fields, `vaultHello` and `claimed` helpers. Three of them, `internal/store/devices_test.go:374` and `:667` and `internal/server/devices_test.go:532`, depend on the last-device decision (hazard 4).

### TypeScript

| File:line | Test | Class | What survives, against what | Owner |
|---|---|---|---|---|
| `core/engine.test.ts:359` | a server that answers ready with no data key > ends the session and derives nothing | OBSOLETE | none | M2 task 4 |
| `core/engine.test.ts:2394` | what a large attachment costs to send > does not hold a sealed copy of the whole file | SPLIT | no whole-file copy in memory and a byte-exact arrival stay; "the second seal matches the first" becomes re-hashing and re-framing | M2 task 4 |
| `core/engine.test.ts:2628` | a batch that contradicts itself > refuses an entry carrying no authenticator | OBSOLETE | none | M2 task 4 |
| `core/engine.test.ts:2656` | a batch that contradicts itself > refuses a deletion the server invented for a file it can name | OBSOLETE | none; §3.6 accepts that devices now trust the server's word | M2 task 4 |
| `core/engine.test.ts:2682` | a batch that contradicts itself > refuses an entry whose fields were edited after it was signed | OBSOLETE | none | M2 task 4 |
| `core/engine.test.ts:2844` | a batch that contradicts itself > applies nothing from a batch whose later entry is not ours | SPLIT | batch atomicity stays; re-seed the later entry with a surviving refusal (hazard 5) | M2 task 4 |
| `core/transport.test.ts:450` | the handshake > sends its protocol version, a device id, an id, and the crypto suite it implements | SPLIT | the suite goes; proto, device id and request id stay | M2 task 3 |
| `core/transport.test.ts:466` | the handshake > reads every ceiling ready carries, and the wrapped key | SPLIT | the ceilings stay; `wrapped` goes | M2 task 3 |
| `core/transport.test.ts:497` | the handshake > ends the session on a ready with no wrapped data key | OBSOLETE | none | M2 task 3 |
| `core/transport.test.ts:518` | the handshake > reports the wrapped key ready carries, which a paired device does not use | OBSOLETE | none | M2 task 3 |
| `core/transport.test.ts:529` | the handshake > sends the claim and its wrapped data key together, or neither | OBSOLETE | none | M2 task 3 |
| `core/transport.test.ts:557` | the handshake > names the device on a device hello and no device on a registrar hello | SPLIT | the device hello names its device; the registrar half goes | M2 task 3 |
| `core/transport.test.ts:571` | the handshake > refuses a registrar reply that is not a registrar | OBSOLETE | none | M2 task 3 |
| `core/server-harness.test.ts:338` | a file, all the way there and back > round trips through chunking, sealing, the wire, and the server | GUARANTEE | round trip through chunking, framing, the wire and the Go server | M2 task 9 |
| `core/server-harness.test.ts:849` | refusals that the session survives > refuses a hello in any protocol but this one | SPLIT | claim and crypto fields go; probe with a protocol 7 hello (hazard 7) | M2 task 3, M1 task 1 |
| `core/server-harness.test.ts:888` | what the server can and cannot see > never receives a readable path or a readable byte | OBSOLETE | inverted by design (§1, §3.6) | M2 task 9 |
| `core/invariants.test.ts:75` | failed input does not advance a cursor > refuses a batch signed by another vault, and remembers nothing of it | SPLIT | a refused batch leaves the cursor and the vault alone; re-seed with a surviving refusal (hazard 5) | M2 task 4 |
| `plugin/main.test.ts:314` | loading > refuses a stored secret of the wrong length | SPLIT | a `deviceToken` of the wrong length stops the plugin with a notice | M2 task 5, task 7 |
| `plugin/main.test.ts:395` | pairing > starts a vault, and syncs it | SPLIT | the root flow goes; the first device pairs from the first-run invite and syncs, and data.json holds exactly the DeviceConfig keys | M2 task 7 |
| `plugin/main.test.ts:503` | pairing > does not keep the recovery key, and the panel says so | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:1311` | the panel, which is a modal and a settings tab > asks for one string and works out the rest from it | SPLIT | one visible field, no hover-only guidance, device name and skip list before the download stay; the recovery-key and setup-line wording goes | M2 task 7 |
| `plugin/main.test.ts:2015` | unlinking during the handshake > closes the connecting client, and nothing of the old pairing is written afterwards | GUARANTEE | setup through an invite | M2 task 7 |
| `plugin/main.test.ts:2298` | a vault that was started and never joined > stops with the recovery key on screen rather than retrying for ever | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:2343` | a vault that was started and never joined > hands the recovery key over while the root is still the thing on disk | OBSOLETE | its ordering check is a template for persisting the device token before redemption (M0.5 task 1) | M2 task 7 |
| `plugin/main.test.ts:2374` | a vault that was started and never joined > keeps the root when the claim went through and the credential could not be saved | SPLIT | a failed credential save around a redemption either leaves the invite unspent or names the orphan row; the root goes | M0.5 task 1, M2 task 7 |
| `plugin/main.test.ts:2433` | a vault that was started and never joined > names the row the panel's pairing left when the credential could not be saved | SPLIT | the same, for pairing from the panel | M0.5 task 1, M2 task 7 |
| `plugin/main.test.ts:2473` | a vault that was started and never joined > will not name a row for revoking when data.json refuses to read back | GUARANTEE | setup through an invite | M2 task 7 |
| `plugin/main.test.ts:2511` | a config that cannot be read > refuses to pair over it, and the panel shows why and where instead of the form | GUARANTEE | the unreadable trigger becomes a malformed `deviceToken` | M2 task 7 |
| `plugin/main.test.ts:2823` | pairing honestly > reaches the server before saving a pairing, and saves nothing it could not reach | GUARANTEE | hazard 2 | M0.5 task 1, M2 task 7 |
| `plugin/main.test.ts:2841` | pairing honestly > refuses a pairing the server refuses, and saves nothing | GUARANTEE | a spent or unknown invite; hazard 2 | M2 task 7 |
| `plugin/main.test.ts:2860` | pairing honestly > offers unlink when a new vault's claim is refused for good | SPLIT | a first pairing refused for good says "could not join" and offers unlink, never "syncing" | M2 task 7 |
| `plugin/main.test.ts:2875` | pairing honestly > runs one pairing at a time | GUARANTEE | setup through invites | M2 task 7 |
| `plugin/main.test.ts:3686` | adding a device from the panel > requires confirmation before spending a %s in a populated vault | SPLIT | the invite row stays (confirm before redeeming, local files untouched, invite not consumed); the recovery-key row goes | M2 task 7 |
| `plugin/main.test.ts:3732` | adding a device from the panel > confirms combining a populated vault during %s pairing | SPLIT | the QR and pasted-invite rows stay; the recovery-key row goes | M2 task 7 |
| `plugin/main.test.ts:3850` | adding a device from the panel > opens a scanned invite for confirmation and syncs after Pair | SPLIT | invite creation, copy, QR, prefilled form, pairing, sync and two distinct device credentials stay; the shared `dataKey` check goes | M2 task 7 |
| `plugin/main.test.ts:4020` | adding a device from the panel > adds one with the recovery key, and neither device keeps it | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:4066` | adding a device from the panel > leaves nothing behind when the recovery key is not the vault's | OBSOLETE | for invites, `main.test.ts:2841, :3956` | M2 task 7 |
| `plugin/main.test.ts:4082` | adding a device from the panel > shows the recovery key once when a vault is started, and says to write it down | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:4167` | adding a device from the panel > lets go when the panel is closed instead of acknowledged | OBSOLETE | its rule, that every wait answers on every way out, should be checked for the populated-vault confirmation | M2 task 7 |
| `plugin/main.test.ts:4244` | adding a device from the panel > says where the recovery key is rather than offering to show it | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:5048` | handing over the first recovery key > does not claim the vault until the key has been taken | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:5088` | handing over the first recovery key > can still produce the key after an interrupted pairing | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:5110` | handing over the first recovery key > offers nothing once the device has its own credential | OBSOLETE | none | M2 task 7 |
| `plugin/main.test.ts:5264` | a pairing that outlives the plugin > does not start a loop after unload, pairing with a recovery key | OBSOLETE | the invite form is `main.test.ts:3987` | M2 task 7 |
| `plugin/main.test.ts:5285` | a pairing that outlives the plugin > does not start a loop after unload, starting a vault | OBSOLETE | first and later devices both pair by invite now, so `main.test.ts:3987` covers it | M2 task 7 |
| `plugin/main.test.ts:5323` | handing over a replacement recovery key > does not send the rotation until the key has been taken | OBSOLETE | none | M2 task 7 |
| `plugin/panel-shots.test.ts:256` | the panel walk > still says the four things that were paid for in incidents | SPLIT | "revoking does not un-read" and the invite expiry stay (the expiry becomes one hour); "keeps its decryption key" and the recovery-key lines go; the TLS warning inverts (hazard 8) | M2 task 7, task 13 |
| `plugin/panel-shots.test.ts:320` | the panel walk > puts the invite and the recovery key on screen where they can be read | SPLIT | the invite scene stays with a trew1i_ string; the recovery-key scene goes | M2 task 13 |
| `cli/cli.test.ts:160` | pairing a vault > prints a pairing string the other device can use | SPLIT | a shared URL and distinct device names stay; the shared secret goes | M2 task 10 |
| `cli/cli.test.ts:173` | pairing a vault > takes the one line the server printed, as printed | SPLIT | `pair` takes the invite exactly as `trew invite` or serve printed it; `init` goes | M2 task 10 |
| `cli/cli.test.ts:189` | pairing a vault > says what a setup line looks like when handed something else | OBSOLETE | `init` and the setup line go | M2 task 10 |
| `cli/cli.test.ts:217` | pairing a vault > cannot reprint the recovery key, and says why | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:552` | status > says a device never registered itself, rather than blaming the server | SPLIT | rule 7: a config with no credential is neither reachable nor refused | M2 task 10 |
| `cli/cli.test.ts:588` | status > tells a device with no credential at all to pair again | GUARANTEE | the message names the device token instead of a secret and a data key | M2 task 5, task 10 |
| `cli/cli.test.ts:771` | saying no clearly > refuses a config whose secret is the wrong size | SPLIT | a `deviceToken` of the wrong size is refused | M2 task 5, task 10 |
| `cli/cli.test.ts:866` | one secret > spends the server's first-run token and then forgets it | SPLIT | after pairing the config holds exactly the DeviceConfig keys; the bootstrap goes | M2 task 10 |
| `cli/cli.test.ts:907` | one secret > has no token in the pairing string at all | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:938` | one secret > stops accepting the first-run token once the vault is claimed | OBSOLETE | an invite's single use is `cli.test.ts:1194` | M2 task 10 |
| `cli/cli.test.ts:1095` | a vault is claimed when init says it is > lets a second device sync before the first ever has | OBSOLETE | the vault exists from serve's start | M2 task 10 |
| `cli/cli.test.ts:1123` | a vault is claimed when init says it is > spends the first-run token during init, not later | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1160` | adding a device > adds a device with an invite, which carries no root | SPLIT | issuing, pairing, the config's fields, sync and the listing stay; the root and data-key checks go | M2 task 10 |
| `cli/cli.test.ts:1228` | adding a device > has nothing to print for the recovery key, and says to use an invite | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1240` | adding a device > pairs with the recovery key, registers a row, and then forgets the key | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1265` | adding a device > reaches the server before it says paired | SPLIT | an invite against a dead server never says "Paired"; hazard 2 | M0.5 task 1, M2 task 10 |
| `cli/cli.test.ts:1275` | adding a device > refuses a recovery key the vault does not know | OBSOLETE | the invite form is `cli.test.ts:1194` | M2 task 10 |
| `cli/cli.test.ts:1329` | the device list > says, in the listing, that revoking does not un-read anything | SPLIT | "does not un-read" stays; `trew rotate` and "later encrypted content" go | M2 task 10 |
| `cli/cli.test.ts:1408` | the device list > refuses to empty the vault from a device, and says whose job it is | SPLIT | decision-dependent (hazard 4); the recovery-key half moves to the control socket or goes | M1 task 9, M2 task 10 |
| `cli/cli.test.ts:1548` | the device list > refuses --recovery-key where it would have been ignored | OBSOLETE | the flag goes | M2 task 10 |
| `cli/cli.test.ts:1570` | the device list > lists and revokes with the recovery key, for a vault with no device to ask | SPLIT | listing and revoking with no device left moves to the control socket | M1 task 9 |
| `cli/cli.test.ts:1601` | rotating the secret (I5) > keeps the history and every device, and retires the old key | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1632` | rotating the secret (I5) > prints the new key before it sends the request | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1643` | rotating the secret (I5) > refuses a recovery key for another vault rather than rotating this one | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1653` | rotating the secret (I5) > needs the recovery key, because no device holds one | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1671` | rotating the secret (I5) > offers a data key with every claim, from the first device and the second | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1783` | what the CLI says about itself and the vault > keeps recovery-key administration on the paired server when vault names match | OBSOLETE | none | M2 task 10 |
| `cli/cli.test.ts:1821` | what the CLI says about itself and the vault > uses the saved address when a recovery key still names the old server address | OBSOLETE | none | M2 task 10 |
| `cli/state.test.ts:239` | where a secret can come from (I12) > reads the recovery key from a file, and writes a new one to a file only you can read | SPLIT | reading the invite from a file stays for `pair`; writing a secret to a 0600 file moves to the Go secret outputs (unique item 11) | M2 task 10, M1 task 9 |
| `cli/state.test.ts:264` | where a secret can come from (I12) > refuses an empty key file rather than treating it as no key at all | GUARANTEE | `pair --key-file` with an empty file | M2 task 10 |
| `cli/state.test.ts:275` | where a secret can come from (I12) > will not take the same secret twice, from a file and an argument | GUARANTEE | `pair` given both | M2 task 10 |
| `cli/state.test.ts:353` | what init prints, and when (F02) > prints the recovery key before it registers the device | OBSOLETE | a template for persist-before-send ordering | M2 task 10 |
| `cli/state.test.ts:1081` | a vault that was started and never joined > refuses, hands the recovery key back, and pairs again with it | OBSOLETE | none | M2 task 10 |
| `cli/state.test.ts:1117` | a vault that was started and never joined > names the row it left behind when a pairing could not save its credential | SPLIT | the invite form; interacts with persist-before-send (hazard 2) | M0.5 task 1, M2 task 10 |
| `cli/state.test.ts:1153` | a vault that was started and never joined > names the row a failed init left, and the way back it names works | OBSOLETE | none | M2 task 10 |
| `cli/state.test.ts:1209` | a vault that was started and never joined > will not send somebody revoking a row when the disk refuses to say what is here | GUARANTEE | setup through an invite | M2 task 10 |
| `cli/state.test.ts:1231` | a vault that was started and never joined > says the same thing to status, without blaming the server | SPLIT | rule 7 for a config with no credential, with `cli.test.ts:552` | M2 task 10 |
| `cli/state.test.ts:1245` | a vault that was started and never joined > fails init honestly when the claim succeeds and the registration is not saved | OBSOLETE | none | M2 task 10 |

## M1 outcome: the Go side

The server half of the strip (PLAN M1), applied as this ledger says: every GUARANTEE and SPLIT row kept its assertion with new setup, and only OBSOLETE rows were deleted. The TypeScript rows are M2's. Line numbers are the ledger's, so each row can be found above.

### Where each Go test went

| File | Deleted (OBSOLETE) | Kept, rewritten against protocol 1 |
|---|---|---|
| `internal/store/keys_test.go`, now `invites_test.go` | 29, 61, 88, 366, 426, 623 | 107, 177 (the listed id proven not to redeem, field by field), 240, 307, 334 (decided: see below), 468 (the wrapper line dropped), 508, 557 (the both-or-neither half, now racing a revoke of the invite's own issuer), 679, 695 (with the lost-reply retry of hazard 3), 743 (checked to fail with a deferred transaction) |
| `internal/server/auth_test.go` | 36, 69, 87, 157 | 98 (device and invite digests), 122 (both hello routes), 140 (the 32-byte token floor replaces MinClaimLength), 177 (an empty credential, and a row whose digest is the digest of nothing); 50's surviving half is `cmd/trew` `TestTheFirstInviteWorksOnce` |
| `internal/server/invite_test.go` | 369, 399, 664 | 73, 129, 147, 215, 244, 293, 307 (one hour and one hour), 328's third subtest, 437 (a device's own credential with an invite), 479 (register and rotate are unknown ops now), 539, 572 (refused as `auth`), 617 (with devices_test 270's rows), 691; 195 moved to the control socket (`cmd/trew/admin_test.go`) |
| `internal/server/invite_doc_test.go` | | 83, reading plan/protocol.md too; `client/README.md` is left out until M2, and still says ten minutes |
| `cmd/trew/token_s11_test.go`, now `secretfile_s11_test.go` | 64 | 14, 40, against `writeSecretFile` |
| `internal/server/unlimited_devices_test.go` | | 10 (through invites), 24 |
| `internal/server/release_review_test.go` | 69, 89 | 13; 33 as `TestDevicePublicationMayRaceConnectionFailure` |
| `internal/server/protocol_test.go` | 361, 393, 412, 435, 566, 611, 705, 898, 937, 966, 994 | 43 to 326, 763, 809 (with the `mcp:` rows), 832 (a Basalt protocol 7 hello, hazard 7), 855 (through invites), 1059 (the refusal now byte-identical to a wrong token's), 1087; 479's surviving half is the store identity tests of M1 task 8; 658 as `TestARevokeEvictsEverySessionOfTheDeviceAtOnce` |
| `internal/server/devices_test.go` | 29, 80, 212, 307, 588, 809 | 96, 333 (invite tokens added to what must not appear), 407, 437, 465, 494, 617, 643, 669, 716, 754; 121 as `TestAStoreWithHistoryAndNoDevicesGetsOneBackFromAnInvite` and the admin tests; 159 as the admin tests; 236 as the lost-reply tests; 270 into invite_test 617; 532 as `TestADeviceMayRevokeTheLastDevice` (hazard 4, decided) |
| `internal/store/budget_test.go` | 132 | 32, 54 (both directions of the sum), 71, 112, 157, 182 |
| Tier 2, `internal/store/devices_test.go` | 818, 886, 921, 956 | 133 (a vault that does not exist), 977 (the invite rows' own checks), 374 inverted, 667 as `TestConcurrentRevokesOfOneDeviceDeleteItOnce` |
| Tier 2, the rest | `migrate_test.go` 107 and 268; `mutation_authorization_test.go` 106; `ops_i17_test.go` 24 | `store_test.go` 1351 and 1383 (a `badpath` row, hazard 6); `backup_test.go` 845 (the same); `migrate_test.go` 207; `session_test.go` 65 (a protocol 7 row); `disclosure_test.go` 224 and 309 (run against a server serving a vault as well as one serving any); the six `main_test.go` rows as first-invite tests; `ops_i17_test.go` 86 (devices for claimed) |

Beyond the ledger, three tests went with the fresh schema rather than the crypto, and one file with the Authenticator: `store_test.go`'s `TestAnEntryFromBeforeTheCountIsStillReadable` is inverted to `TestAChunkCountOfMinusOneIsNotSpecial`, since Trew has no rows from before the column; `main_test.go`'s `TestPurgeAcceptsABackupFromBeforeTheChunkCount` is deleted, since no older Trew schema exists to take a backup with; and `internal/server/server_test.go`, which tested the test suite's own `StaticTokens` authenticator, is deleted with it. `protocol-fixtures.json` still carries five entry cases about the MAC and the parent, because the TypeScript suite reads them; the Go test lists them by name and requires the server to accept them, and M2 deletes them with `goodMac`.

### The unique guarantees, on the Go side

Every Go guarantee in [the list above](#guarantees-with-no-equivalent-elsewhere) survives:

1. `TestACrashBetweenRegisteringAndSpendingLeavesNeither`.
2. `TestARedeemRacingARevokeLeavesTheVaultConsistent`.
3. `TestConcurrentRedemptionsOfOneInviteRegisterExactlyOneDevice`, eight handles, twenty times.
4. `TestI23InvitesAreSingleUseAndExpire`, `TestI23ExpiredInvitesAreSweptAtInsert`, `TestAnExpiredInviteLeavesTheList`, `TestI23AnExpiredInviteIsRefused`.
5. `ErrNoInvite` in the store; one identical `auth` in `TestI23AnInviteIsRedeemedExactlyOnce` and the disclosure table.
6. `TestARedemptionOntoAnExistingIdChangesNothing`, `TestARedeemingHelloMustNameTheDeviceItRegisters`, `TestAHelloWithADevicesCredentialAndAnInviteIsRefused`.
7. `TestTheServerStoresAHashAndNotTheKey`, `TestARedemptionWillNotRegisterAGuessableToken`.
8. `TestValidBase64URLTakesPaddingOnlyAtTheEnd`, and `TestDecodeTokenTakesOneSpellingOnly` for the stricter decoder credentials now go through.
9. Decided against the restore epoch: a backup keeps no outstanding invite (`TestABackupCarriesTheDevicesAndNoOutstandingInvite`), because a restore must not revive an invite used or cancelled since; spent rows and devices travel.
10. `TestI23TheTTLDefaultsAndIsCapped`, `TestInviteTTLIsClampedBeforeDurationConversion`, `TestI23TheDocsStateTheInviteLifetimeTheCodeUses`.
11. `TestS11WriteSecretFileIsExactAndPrivate`, `TestS11OverwritingA0644FileTightensItTo0600`.
18. `TestOutstandingInvitesAreVisibleAndCarryNothingThatRedeems` and `TestInvitesListsWhatCanStillBeRedeemed`.
19. `TestARevokeEvictsEverySessionOfTheDeviceAtOnce`.
20. `TestDevicePublicationMayRaceConnectionFailure`.
21. The control socket and the direct path: `TestTheAdminCommandsGoThroughTheRunningServer`, `TestTheAdminCommandsWorkWithNoServerRunning`.
22. `TestALostReplyRetrySucceedsEvenAfterExpiry` and `TestALostReplyRetryIsRedeemedAgainEvenAfterExpiry`.
24. `TestTheFirstInviteNamesSomethingADeviceCanDial`, `TestAnExplicitAddressIsWrittenAsGiven`, `TestLocalhostWritesAnInviteThatWorksAsIs`, `TestAPairedVaultWritesNoFirstInvite`, `TestARestartKeepsTheFirstInviteItWrote`, `TestPairingHostsNamesAddressesADeviceCanDial`.
25. `TestBackupPublishesOverAFaultItInherited` and `TestVerifyNoticesAnEntryNoDeviceWouldAccept`, both seeded with a path the policy refuses.
26. `TestValidateChecksThePathOnFoldersAndDeletions` and the fixture matrix in `TestValidateRefusesExactlyTheFixturesPaths`.

## Method

- Inventory: 74 Go test files with 537 top-level `Test` functions (Basalt's 536 plus M0's `internal/store/fts5_test.go`), and 134 TypeScript test files with 1,939 `it`/`test` cases, where an `it.each` table counts once.
- Go tests were enumerated from gofmt layout (`func Test...(` to the closing `}` at column 0); TypeScript cases through the TypeScript compiler API, walking `describe`, `it` and `test` calls to get each case's full path and line. Both scripts counted crypto vocabulary per test (claim, registrar, rotation, wrapped, sealed, MAC, bootstrap, recovery key, key schedule) so that files could be ranked by how many of their cases are about the crypto rather than merely set up with it. The scripts lived in the session scratchpad and are not part of the repository.
- Every test in Tier 1 and every case in Tier 2 was then read in full, and each "no equivalent" claim was checked with `rg` across the whole suite.
- Line numbers were checked against Basalt `664a963` by comparing every test file's length and, where lengths differed, the diff hunks.
