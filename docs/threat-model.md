# Threat model

[Developer documentation](development.md) · [Design](design.md)

This is the maintainer's threat model for TrewSync as it will be deployed: a
server that holds notes in plaintext, with an agent endpoint over the same
store. It is written before deployment on purpose (PLAN.md M5.5), as a list of
requirements, each with where it is enforced and whether it is yet. A
requirement with no enforcement is a hope, and this page says which ones are.

[Security and privacy](security.md) is the user-facing page, written from this
one for the plaintext server; M9 revisits it with the agent endpoint.

## The decision this rests on

**The server is trusted with everything.** It reads every note so that search
and the agent endpoint can exist (PLAN.md section 3.6). That is deliberate, and
it is the right trade for one person's notes on a server they run, but it
moves the whole security question onto the server host, its disk, its backups,
and whoever holds a token.

What that costs, stated once so nothing below understates it:

- **The readable surface is more than the notes.** Current notes, every deleted
  version still in history, chunks from abandoned uploads, every filename,
  search terms, tags and audit context. Not only the files meant: the SQLite
  WAL, the search index, temporary files, backup staging, filesystem snapshots,
  crash dumps and any copied volume.
- **Writer authenticity is gone.** Basalt's entry authenticator let a device
  tell a note its owner wrote from one a compromised server made up. SHA-256
  chunk names give consistency, not authorship. Devices now trust the server's
  word about who wrote what.
- **Chunk names are a presence oracle.** A name is the SHA-256 of plaintext, so
  anyone with a chunk inventory can confirm guessed content (PLAN.md section
  2.2).

## Assets and the people after them

| Asset | Held where | Who might want it |
|---|---|---|
| Note content and history | Server data directory, backups, every paired device | Anyone with the host, a backup, a device, or a token |
| Device tokens | Server (SHA-256 only); each device (keychain or `data.json`, 0600 file for the headless client) | Anyone wanting to impersonate a device |
| MCP tokens | Server (SHA-256 only); the agent's configuration | Anyone wanting whole-vault read, or write with a write token |
| Invite tokens | Server (SHA-256 only); the one string handed over, for an hour by default | Anyone who sees it before it is redeemed |
| Paths and chunk names | Server; logs if careless | Anyone profiling what the vault contains |

Adversaries considered: a thief with a stolen device; someone who reads a
backup or a copied volume; a network attacker; an agent, or a note, that tries
to turn the agent against the vault; a leaked token; a hostile or buggy client
sending shapes the server should refuse. **Not** defended against, and said so
plainly: a compromised running server host (it holds the plaintext by design),
and a model provider receiving what an agent reads (that is what reading
means).

## Requirements

Status is one of **enforced** (code and a test hold it), **planned** (a
milestone task owns it), **documented** (it is the operator's to do, and this
page and the operations guide say how), **accepted risk** or **deferred** (the
owner decided, with the date and what it costs). Each status below was checked
against the code on 2026-09-24 (M5.5), and an enforced one names the test that
holds it.

### Storage and backups

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| S1 | The data volume sits on encrypted storage (LUKS, FileVault, ZFS native encryption), and where its key lives and how an unattended restart unlocks it is written down | [Operating TrewSync](operations.md#encryption-at-rest) says how; `trewd doctor`'s `encryption` check recognises a LUKS volume by its device name and says when it cannot tell | **accepted risk**: the owner's homelab volume is not encrypted and the owner accepts that (2026-09-22). Anyone who can read that disk can read every note and its history. `doctor` still reports it, as a note. |
| S2 | Backups are encrypted, including backups that stay on the same box: `trewd backup` writes a plaintext copy only when `-plaintext-ok` says so, and otherwise takes `-encrypt-to <age recipient>` (or `-recipients-file`), staging the copy inside the data directory so only ciphertext leaves it | `trewd backup`, `internal/archive` (age); `TestABackupMustSayWhetherItIsEncrypted`, `TestAnEncryptedBackupUnpacksToTheNotesItHeld`, `TestAnArchiveUnpacksToTheDataDirectoryItWasPackedFrom` | **enforced**. The owner deferred choosing a backup destination (2026-09-22), not the encryption: until there is one, a backup on the same machine protects against a damaged store and not against losing the machine. |
| S3 | The restore rehearsal exercises the encrypted path, not a plaintext shortcut | `trewd rehearse`, `trewd unpack`; `TestRestoreRehearsal` (the CI job) takes an encrypted backup, rehearses it, loses the live directory, unpacks and serves it | **enforced** |
| S4 | A data directory on storage a container replacement or a reboot erases is reported, and `serve` refuses to start an empty store there without `-allow-ephemeral` | `internal/doctor` (Syncidian's check, adapted), `serve`; `TestServeRefusesAnEmptyStoreOnStorageARestartErases`, `TestDoctorReportsEveryInjectedFault` | **enforced** |
| S5 | A directory of another product, or a newer schema, is refused before any write and left byte-identical | store identity (M1); `TestABasaltDirectoryIsRefusedAndLeftByteIdentical`, `TestAnotherProductOrANewerSchemaIsRefusedAndLeftByteIdentical` | **enforced** |
| S6 | Deleted versions a person expects gone are gone only when purge says so, and purge never reclaims a version pinned by an agent operation inside its window | purge survivor set (M1, M5); `TestAYearOldNoteEditedTodaySurvivesAnImmediatePurgeAndARestart`, `TestTheBeforeImageSurvivesABackupAndARestore` | **enforced** |

### Credentials

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| C1 | Every credential is random and stored only as its SHA-256; comparison is constant-time | store (M1, M4); `TestTheServerStoresAHashAndNotTheKey`, `TestAnMCPTokenIsStoredAsAHashUnderARandomID` | **enforced** |
| C2 | No listing returns anything that redeems: an invite listing carries a separate non-secret id, never the token or its hash | store, with a test that tries every listing field as a token (M1); `TestOutstandingInvitesAreVisibleAndCarryNothingThatRedeems`, `TestADeviceListingCarriesNoCredential` | **enforced** |
| C3 | A redemption refusal is one identical answer for unknown, spent, expired and cancelled invites, and writes nothing | store (M1); `TestI23AnExpiredInviteIsRefused`, `TestARedeemThatCannotRegisterLeavesTheInviteUnspent`, `TestCancellingAnInviteRetiresTheString` | **enforced** |
| C4 | A revoke means no later mutation from that credential commits, no queued one completes, and no live subscription keeps delivering | control socket and commit boundary (M1); `TestNothingCommittedAfterARevokeReachesTheRevokedConnection`, `TestARevokeRacingAnUploadCommitsNothingAndSendsNothingElse`, `TestAWriteLosesAtTheCommitBoundaryToARevoke` | **enforced** |
| C5 | Invites expire by default (one hour); the invite `serve` mints for the first device goes to a 0600 file, never a log | `serve` (M1); `TestI23TheTTLDefaultsAndIsCapped`, `TestS11WriteSecretFileIsExactAndPrivate` | **enforced** |
| C6 | No credential in a URL query string, including any future event stream | `/mcp` refuses any query string before looking at a credential (M4); `TestAQueryStringIsNeverTheEndpoint` | **enforced** |
| C7 | The plugin keeps its device token in Obsidian's keychain when the app has one, scoped to vault and device, so a copied `.obsidian` does not carry a working credential once a restart of Obsidian has found the token in the keychain (until then `data.json` keeps it too, so a kill cannot lose it) | `client/src/plugin/keychain.ts` (M2) | enforced; tested with a copied vault, a lost keychain entry, a kill before the keychain saved and a renamed vault |
| C8 | Secret files (the first invite, `mcp-token --key-out`, `backup-key`'s identity) are written atomically at mode 0600, and a key file (`-key-out`, the identity) never over an existing file | M1, M4, M5.5; `TestS11WriteSecretFileIsExactAndPrivate`, `TestS11OverwritingA0644FileTightensItTo0600`, `TestWriteNewSecretFileRefusesAFileAlreadyThere`, `TestAKeyOutThatExistsIsRefusedBeforeATokenIsMinted`, `TestAnEncryptedBackupUnpacksToTheNotesItHeld` | **enforced** |

### The agent endpoint

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| A1 | A token reads the whole vault, and the person creating one is told so, including that results reach the agent's model provider | `mcp-token` output says so (`cmd/trewd/mcptoken.go`); `docs/agent.md` (M9) | **enforced** in the command's output; the guide is M9's |
| A2 | Tokens default to read scope; write is explicit, and scope is checked at discovery, at dispatch and at the commit boundary against the credential as it stands then | `internal/mcp` (M4, M5); `TestAReadTokenCannotCallAWriteTool`, `TestTheAuthorizationMatrixCoversEveryTool`, `TestATokenRevokedMidFlightLosesAtTheCommitBoundary` | **enforced** |
| A3 | Every byte from a note reaches the agent only under `untrusted_content`, through one normalisation function, with the warning in each tool's description | `internal/mcp` envelope (M4); `TestInjectionReachesAgentsOnlyAsNormalisedUntrustedContent`, `TestAPoisonedNoteWrittenThroughTheToolsStaysUntrusted` | **enforced** |
| A4 | An agent cannot write outside the vault's note space: dot-prefixed segments are refused, so `.obsidian/plugins/*/main.js` (code every device would run) is unreachable, including by create then move | path rules; `TestWriteArgumentsAreStrictAndThePathPoliciesHold` (the `.obsidian/plugins` create and move) | **enforced** |
| A5 | No unauthenticated discovery document and no OAuth metadata, because MCP clients act on it after a 401 | M4; `TestUnauthenticatedRequestsGetAFixedRefusal` | **enforced** |
| A6 | Per-token budgets, so one looping agent gets 429 without starving another token or device sync; failed authentication rate-limited separately | M4; `TestBudgetsAnswer429WithoutStarvingAnotherToken`, `TestWritesPastTheirBudgetGet429AndDevicesKeepSyncing`, `TestFailedAuthenticationIsRateLimitedSeparately` | **enforced** |
| A7 | Every agent mutation is audited (actor, tool, server time, paths, before and after versions), its displaced versions pinned, and undoable as a unit | oplog, pins, undo (M5); `TestEveryWriteToolCommitsAndKeepsItsBeforeImage`, `TestTheAuditOutlivesItsActorAndHoldsNoSecretOrBody`, `TestAMoveWithBacklinksUndoesAsAUnitOrNotAtAll` | **enforced** |
| A8 | Bearer tokens and note bodies never appear in logs or the audit record | review rule; `TestTheLogCarriesNoTokenNoteTextOrPath`, `TestTheAuditOutlivesItsActorAndHoldsNoSecretOrBody` | **enforced** |

### Transport and host

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| T1 | TLS in front of the server (Tailscale Serve, Caddy); device tokens and note contents cross the network | `docs/server.md` (M9); `trewd doctor`'s `origin` check asks the address devices use | documented |
| T2 | `/mcp` behind Tailscale or an identity-aware proxy; a warning when `--mcp` listens on a wildcard address | `serve -mcp` logs it (`logMCP`); `wildcardAddr` tested in `cmd/trewd/mcp_test.go` | **enforced**, the warning; the proxy is the operator's (documented) |
| T3 | The service runs as its own user with a private data directory; the container image is scratch, read-only, capabilities dropped | `trewd service`, `compose.yaml` (inherited from Basalt); `trewd doctor` warns on a data directory other accounts can read | enforced for the unit and image |
| T4 | Chunk names, paths, credentials and note bodies stay out of logs and metric labels | `internal/metrics` has no labels at all; `TestASnapshotCarriesNothingFromTheVault`, `TestTheLogCarriesNoTokenNoteTextOrPath` | **enforced** for metrics and the MCP log; a review rule for the rest of the log |

### Clients

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| D1 | A client refuses inbound paths it could not hold safely: dot segments, staging names, and on Windows the names Windows reserves, each as a visible stranded path, never a retried write error | engine `refusedInboundPath`, with the Windows rule from `client/src/core/windows-names.ts` when the plugin or headless client runs on Windows; `client/src/core/windows-inbound.test.ts` | enforced |
| D2 | The plugin never adds client-side error reporting or telemetry (the community directory forbids it) | review rule (M9 lint gate) | documented |
| D3 | An invite link never pairs by itself: the modal shows the server address the invite names, warns when it differs from the configured one, and changes nothing until confirmed | plugin (M2); `client/src/plugin/main.test.ts`, "opens a scanned invite for confirmation and syncs after Pair" | **enforced** that it never pairs by itself and says where the invite points; the warning for a different address is not asserted by any test |

## What encryption at rest does not buy

Nothing against a compromised running host, nothing against an agent holding a
valid token, nothing against a model provider receiving tool results, and
nothing when a logical snapshot is exported from an already-unlocked
filesystem. Tailscale does not change any of this. If protecting against a live
server compromise ever becomes a requirement, the decision to drop end-to-end
encryption has to be reopened: no amount of at-rest work substitutes for it.

## Keeping this page honest

A requirement moves to **enforced** in the same commit as the test that holds
it, and names that test. M5.5 does not finish while any requirement here is
still **planned** without a milestone that owns it. At the M5.5 review
(2026-09-24) one is: C7, the plugin's keychain, decided in PLAN.md section 2.3
and owned by M2, which has no code yet.
