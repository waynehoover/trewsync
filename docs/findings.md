# Historical findings index

[Developer documentation](development.md)

Definitions of the review IDs cited in code, such as `(R40)` and `(I29)`.
These titles preserve the original reviewers' wording. They describe historical
work recorded as resolved or deliberately declined, not a fresh readiness audit.

Telimus is forked from Basalt Sync (github.com/waynehoover/basalt-sync, commit
664a963). Every ID below, and the review files it links, comes from Basalt's
history and is kept verbatim, so names, versions and paths in them are
Basalt's. The F section at the end is the one addition: those IDs were
defined only in Basalt's commit messages, and it was reconstructed from them.

For 0.7.1, see the [September 9 review](reviews/0.7.1.md) and
[September 10 fixes and verification](reviews/0.7.1-fixes.md). For 0.8.3, see
the 0.8.3 round below. What is still deliberately undone is in
[open work](open-work.md).

Reproductions, acceptance criteria, and verification evidence remain in Git
history: `git log -- FOLLOW_UP_REVIEW.md IMPROVEMENTS.md READINESS.md TODO.md
PRODUCT_READINESS.md`.

## R: the review rounds

- **R01** Incoming changes can still overwrite an intervening local edit
- **R02** Displaying recovery keys before commit is still not a recoverable handoff
- **R03** Stale CLI lock takeover can still grant ownership to two callers
- **R04** Purge still accepts an unusable backup
- **R05** Overlapping batch uploads can deadlock on chunk ownership
- **R06** Chunk visibility can still be mistaken for durability
- **R07** Filename normalization can delete a newly saved source file
- **R08** Cross-filesystem trash can delete an edit made after copy verification
- **R09** A restored file can still be reported sent when its upload failed
- **R10** Recovery-key pairing can restart an unloaded plugin
- **R11** State and staging containment is enforced inconsistently
- **R12** Status can report zero unsent work without examining local notes
- **R13** Receive limits still apply after expensive allocation, or only count objects
- **R14** The new backup identity stamp does not uniquely identify a snapshot
- **R15** Health can claim persistence is available when the database cannot write
- **R16** Release assets become public before the new validation gate runs
- **R17** Concurrent image releases can still move a stable tag backward
- **R18** Replacement cleanup can delete the only copy of a local edit
- **R19** Local reuse, merge, and plugin landing still lose intervening edits
- **R20** Recovering an abandoned eviction marker can still create two lock owners
- **R21** Staging cleanup deletes both external files and preserved note versions
- **R22** The final trash digest check still races with unlink
- **R23** The backup lock is released before purge uses its verification
- **R24** Rotation does not await the new recovery-key acknowledgement
- **R25** Status still produces false-clean or inconsistent outcomes
- **R26** A peer can raise the client's network memory limits arbitrarily
- **R27** A malformed backup digest panics during validation
- **R28** Health still reports persistence available on unwritable chunk storage
- **R29** Draft release creation does not trigger the new attestation workflow
- **R30** The image concurrency group can cancel an unpublished queued release
- **R31** The new “streamed” baseline digest buffers the entire file twice
- **R32** A failed plugin preservation rename still permits destructive overwrite
- **R33** Missing content baselines still select an unconditional overwrite
- **R34** An eviction that crosses a minute boundary can delete a new owner's lock
- **R35** The staging allowlist still deletes displaced edits after interruption
- **R36** A trash-move retry overwrites the previous attempt's preserved file
- **R37** Replacement still cannot publish an existing note across filesystems
- **R38** A canceled promotion can still strand `latest` and minor aliases
- **R39** Attestation assumes its target is private without checking
- **R40** Taking a live lock aside admits another owner
- **R41** An unpublished newer Git tag prevents promotion of a valid release
- **R42** A valid prerelease-only history makes promotion fail
- **R43** Preservation can overwrite a note at the chosen conflict path
- **R44** Reusing lock generations admits a paused contender beside a live owner
- **R45** A failed lookup of the current alias bypasses rollback protection
- **R46** Failed preservation leaves an unsent edit hidden after sync recovers
- **R47** Deep verification reports a truncated chunk list as healthy
- **R48** Read-only entry queries cannot inspect a previous-version backup
- **R49** A delayed lower claim takes ownership after a higher owner has acquired
- **R50** Text status sends recovery to an empty directory
- **R51** Matching count and maximum ordinal do not prove a valid chunk sequence

## RR: the re-verification rounds

- **RR1** Manual unlock still admits two active writers
- **RR2** Plugin discovery still depends on a ledger record that may never exist or be readable
- **RR3** Plugin ledger compaction can destroy the only recovery inventory
- **RR4** The crash driver can treat a lost version as an unreached seam
- **RR5** Sync still reports success when recovery is unknown
- **RR6** A torn ledger tail absorbs the next recovery intent
- **RR7** A read-only mirror repeatedly creates the same conflict copy
- **RR8** Restore JSON reports success while its exit status reports incomplete recovery
- **RR9** A read-only mirror never settles a successful automatic merge

## I: improvements, done or evaluated and declined

See [evaluated alternatives](research.md#evaluated-alternatives) before
revisiting I25 (a codec replacement) or I26 (a diff-match-patch fork).

- **I01** Split large modules along existing responsibilities
- **I02** Share credential-operation state machines between CLI and plugin
- **I03** Make protocol contracts executable across TypeScript and Go
- **I04** Use one failure/outcome vocabulary from core to UI and automation
- **I05** Coalesce queued passes and make waiting cancellable
- **I06** Limit filesystem scan concurrency
- **I07** Reduce CPU and allocations on unchanged or lightly changed passes
- **I08** Budget merge/diff work and keep the Obsidian UI responsive
- **I09** Reduce duplicate chunk I/O without weakening verification
- **I10** Profile SQLite queries and startup work against large histories
- **I11** Extend existing diagnostics with durable, actionable failure context
- **I12** Support secret input without shell history or process arguments
- **I13** Align custom-vault setup and command examples
- **I14** Add an explicit repair path for quarantined/missing server bodies
- **I15** Separate read-only inspection from database creation and migration
- **I16** Strengthen backup identity, retention, and restore verification
- **I17** Make operational health and shutdown limits observable
- **I18** Document filesystem and device support as an explicit matrix
- **I19** Turn the review probes into an invariant-focused failure suite
- **I20** Add representative real-runtime and filesystem coverage
- **I21** Gate published artifacts on validation of the same commit
- **I22** Pin the build environment and schedule dependency checks
- **I23** Make release channels, checksums, and version preparation consistent
- **I24** Clarify revocation, rotation, and the scope of cryptographic trust
- **I25** A codec that is one implementation everywhere and faster than fflate
- **I26** Replace the unmaintained diff-match-patch
- **I27** Recover from a crashed CLI without anybody typing a command
- **I28** Decide whether the merge diff should be coarse on purpose
- **I29** A read-only headless client
- **I30** Let a person turn merging off
- **I31** Give markup the validity gate that JSON has

## R083: the 0.8.3 reading review

A reading review of the shipped source, and the fixes for it. All are
implemented except the two marked declined, and each says why.

- **R083-01** A lost `acks` after the own-write echo strands paths as `stale`
- **R083-02** Persistent `again` re-arms the next pass immediately
- **R083-03** A dropped connection charges every queued path exponential backoff
- **R083-04** Refused inbound paths are reported until restart, then vanish
- **R083-05** Pairing with an invite never shows which server it will join
- **R083-06** `assemble()` holds three copies of a downloaded file
- **R083-07** `landFromLocal` seals a whole attachment at once
- **R083-08** Preview and folder-deletion review seal the whole vault and discard it
- **R083-09** Repair reads and seals every synced file to offer names it has
- **R083-10** Downloads are one round trip per 2 MiB while a note is open
- **R083-11** A save to the open note restarts the whole pass
- **R083-12** `.base` files are treated as attachments
- **R083-13** No folder exclusion in the plugin
- **R083-14** One vault per server. Half done: a setup line can name its vault,
  so the plugin can start one. Lifting the one-vault-per-server rule itself is
  declined because it is a scope decision recorded in [the design](design.md),
  not a defect.
- **R083-15** Dismissing a review modal silently pauses sync
- **R083-16** No visible status on phones
- **R083-17** Deleted-note browser has no search
- **R083-18** Attachment replacement reads the old file twice more than it needs
- **R083-19** Delivery polling at 250 ms
- **R083-20** Merge records a UTF-16 length as the file size
- **R083-21** Report list caps disagree
- **R083-22** Upload pacing polls every 5 ms
- **R083-23** One transaction per entry inside a `putmany`
- **R083-24** Latest-per-path is recomputed per call. Declined: the maintained
  table it proposes also feeds `purgeSurvivorUIDs`, so a table that falls behind
  deletes live versions, and no measurement here says the recomputation costs
  anything worth that.
- **R083-25** Sealed paths reveal filename length

## Codex: the 0.8.3 performance and interface reading

A second reading of the same commit plus the R083 fixes, asked to look only at
speed and at what a person can see and do. All are implemented except Codex-02,
which is declined; [open work](open-work.md) has the measurement that would
change the answer.

- **Codex-01** A large download blocks a saved note until it finishes
- **Codex-02** A one-note save reconciles and compares the whole vault.
  Declined for now; see [open work](open-work.md).
- **Codex-03** Pending failures show a checked cloud, and their reasons vanish
- **Codex-04** Receivers download unchanged chunks again after an ordinary edit
- **Codex-05** Phone exclusions cannot be chosen before pairing starts downloading
- **Codex-06** Renaming a note makes its earlier history unreachable
- **Codex-07** Repair pays one serial network round trip per file
- **Codex-08** Preserved hidden copies have no in-app recovery action
- **Codex-09** The server serialises directory flushes after parallel chunk writes
- **Codex-10** Intentional exclusions leave delivery permanently described as unfinished
- **Codex-11** Recovering a deleted folder is one restore and one sync per note

## Removed citation schemes

`C`, `P`, and `T` review IDs were removed from code because their definitions
were never committed. Other documents reused those labels for unrelated
checklists or priority tiers, so reconstructing an index would be ambiguous.
The explanatory comments remain. This cleanup was recorded at `9f99b6a`.

`C0` and `C1` in server name validation refer to Unicode control-character
classes, not review findings.

## 0.6.2 pre-release review

Parallel reviews of the CLI, shared client, Obsidian plugin, server, and docs
found the defects below. All were fixed; each code regression was demonstrated
failing before its fix and passing after it.

| Defect | Result after the fix | Regression coverage |
|---|---|---|
| The documented `pair -` form rejected standard input as an unknown option. | A lone dash reaches the secret reader; pairing from a private pipe works. | [state.test.ts](../client/src/cli/state.test.ts): standard-input pairing, saved mirror mode, and note readback. |
| `unlock --json` returned success for competing holders. | Contested recovery returns `ok: false` and exit 1, matching text output. | [unlock.test.ts](../client/src/cli/unlock.test.ts): contested recovery preserves the current holder. |
| Recovery-key administration could act on another server with the same vault name. | A paired directory's saved endpoint determines the target; keys with an old address remain usable. | [cli.test.ts](../client/src/cli/cli.test.ts): two-server refusal and moved-address administration. |
| A sync failure hid a completed local restore. | Both output formats retain the restored path and distinguish local restoration from sync failure. | [recover.test.ts](../client/src/cli/recover.test.ts): the restored bytes and current edit both survive; sync can be retried. |
| An unrelated upload marked a restored note as sent. | Delivery is checked for that exact path, and an unsent copy is reported accurately. | [recover.test.ts](../client/src/cli/recover.test.ts): another file uploads while the restored file remains absent from server history. |
| Watch mode omitted its live recovery inventory. | Watch reports include retained paths and incomplete recovery, using the current connection. | [state.test.ts](../client/src/cli/state.test.ts): a separate watcher process reports a torn ledger and retains the displaced bytes. |
| CLI advice implied that rotation protected future content after device theft. | The device list and revocation output explain the retained data key and when recovery-key rotation helps. | [cli.test.ts](../client/src/cli/cli.test.ts): listing and revocation guidance. |

Documentation corrections remove the old device caps from the server reference,
name the current pairing and deleted-note controls, distinguish plugin releases
from the server release channel, and keep custom-vault CLI setup out of the
plugin's local directory. The CLI reference now explains restore delivery and
the server targeted by recovery-key administration. Local links were checked;
comparison claims were checked against the official Obsidian and LiveSync docs.

The retained SVG diagrams were reviewed too. Both security themes now describe
shared-key authentication, replay risk, recovery-key administration, and stored
credential hashes accurately. Both transfer diagrams label their figures as a
historical example and remove the incorrect claim that metadata is most of the
illustrated transfer. These diagrams are not currently embedded in the guides;
the referenced logo is unchanged.

### Shared client and plugin

| Defect | Result after the fix | Regression coverage |
|---|---|---|
| Rejoin could continue after unlink or unload. | Recovery retains ownership of its pairing; shutdown waits for index resets and closes recovery connections. | [main.test.ts](../client/src/plugin/main.test.ts): delayed cursor probe, reset success/failure, and interrupted handshake. |
| Concurrent unlink requests started independent clears. | Repeated requests share the same unlink operation. | [main.test.ts](../client/src/plugin/main.test.ts): overlapping unlink requests. |
| Unlink trusted a successful settings write without checking it. | Saved settings are read back before unlink reports completion. | [main.test.ts](../client/src/plugin/main.test.ts): a silently dropped clear is reported. |
| Restore could write after client shutdown finished. | Fetching and publishing the recovered note share the shutdown queue; closed clients refuse new restores. | [restore.test.ts](../client/src/core/restore.test.ts): close waits for recovered bytes, and a closed client cannot restore a folder. |
| A delayed action could rebuild a closed panel and recreate subscriptions. | A torn-down panel stays closed when an action completes. | [main.test.ts](../client/src/plugin/main.test.ts): delayed completion after panel teardown. |

### Server

| Defect | Result after the fix | Regression coverage |
|---|---|---|
| A root credential retired during authentication could keep a registrar session. | Publication is followed by a credential recheck, closing the gap around rotation. | [release_review_test.go](../server/internal/server/release_review_test.go): rotation before registrar publication. |
| Rotation and asynchronous logging read unfinished session identity. | Both read identity only after authentication publishes it under the session mutex. | [release_review_test.go](../server/internal/server/release_review_test.go): unpublished handshake and connection-failure races. |
| Large invite TTLs overflowed before the expiry cap applied. | Milliseconds are clamped before duration conversion. | [release_review_test.go](../server/internal/server/release_review_test.go): overflowing positive TTL. |
| SQLite interpreted a `?` in the data path as URI syntax. | Filesystem paths are encoded before connection options are added. | [path_test.go](../server/internal/store/path_test.go): special characters remain in the real database path. |
| Read-only inspection recreated missing chunk directories. | Inspection refuses missing storage without creating it. | [open_test.go](../server/internal/store/open_test.go): missing chunk storage remains absent. |
| Repair applied the plaintext file limit to encrypted chunk bodies. | Repair uses the ciphertext chunk limit, allowing valid repairs under a small file ceiling. | [resend_test.go](../server/internal/server/resend_test.go): exact repaired bytes and unchanged history. |

### Verification scope

The review's broader runs passed 403 CLI tests, 335 client/plugin tests, and the
full Go race-enabled suite. The complete local gate then passed: 1,523 client
tests, 24 stress tests, server race tests, the restore rehearsal, package/build
checks, and Docker checks. All 11 CI jobs passed on the
[release commit](https://github.com/waynehoover/basalt-sync/actions/runs/34294787886)
before publication.

The screenshot script captured 12 views in both themes in desktop Obsidian
1.13.7, using sample data. Its interrupted-run cleanup was exercised too.
Android and iOS acceptance were not performed during this review; existing
platform and threat-model limits remain as documented in [the design](design.md).

### Release verification follow-up

The public 0.6.2 downloads passed checksum and provenance checks for all seven
plugin/server assets. The container ran on Linux amd64 and arm64, its moving
tags matched the versioned image, and the published CLI installed and ran under
Node 22. Two release-automation defects were also corrected:

- Publishing the server draft made GitHub's **latest release** point away from
  the plugin. The public link was corrected to 0.6.2; future publication now
  explicitly selects the plugin and excludes the server from that label.
- Building successive server binaries inside the checkout marked later builds
  as `vcs.modified=true` because earlier build outputs were untracked. Future
  builds stage outside the checkout before gathering the assets. Some published
  0.6.2 binaries retain that misleading stamp; their source revision and
  attestations identify the verified release commit. Published bytes were kept
  unchanged.

[attest-trigger.test.sh](../scripts/attest-trigger.test.sh) now executes the
workflow's publication commands and four real Go builds in a temporary Git
repository. The latest-release check and three clean-build checks failed before
these workflow fixes and passed afterward.

## F: the 2026-09-05 follow-up review

Defined in Basalt's commit messages rather than in this file until the fork, which left 125 citations
in 43 source files pointing at nothing. Reconstructed on 2026-09-22 from the commits that fixed each one;
the hash is the Basalt commit, whose message has the full account.

- **F01** Check the file is still the one the pass decided about (`ee632f3`)
- **F02** Get the recovery key out before the step that erases it (`7fc605b`)
- **F03** Show the rotation's candidate key before the request that commits it (`337a7a9`)
- **F04** `-backup` is what authorises the one command that destroys something no device holds a copy of, and what it checked was two maximum uids. (`9cd082b`)
- **F05** A chunk is visible when it is renamed into place and durable when its directory is flushed, and those are two different moments. (`9cd082b`)
- **F06** A backup locked the source and nothing else, so it would replace the database of a directory something was using as a live store: reproduced by holding both of a destination's locks and watching it be overwritten anyway. (`f259331`)
- **F07** The vault lock could be handed to two processes three ways. (`f259331`)
- **F08** `history`, `deleted`, `devices`, `invite`, `uninvite` and `status` do not take the vault's lock, and should not: holding it would make `status` refuse exactly while a watcher is running, which is when somebody asks. (`d7682e3`)
- **F09** Replay stopping at a damaged record was reported and then forgotten. (`d7682e3`)
- **F10** A signature says who wrote an entry, not which note it belongs to. (`d8b9a84`)
- **F11** The threat model said withholding was the whole of what a server can still do, and that no note is altered. (`d8b9a84`)
- **F12** `list` decides a normalised name is free from the directory listing, and a listing is a moment ago. (`bf7df34`)
- **F13** The cross-filesystem fallback copied, read the copy back, and removed the original. (`bf7df34`)
- **F14** `entries["__proto__"] = e` does not add a key. (`d588bf5`)
- **F15** `settle` resolves for a vault that is retrying or has written a path off, and `restoreAndSend` ignored what it returned, so a restored note was reported as sent to the other devices while its upload sat queued. (`d588bf5`)
- **F16** `Client.sync` swallows exceptions on purpose, because most of its callers are event handlers with nothing useful to do with one. (`c2d76c0`)
- **F17** `JSON.parse` was wrapped in a try, so a frame that is not JSON ends the session cleanly. (`c2d76c0`)
- **F18** Hashes are checked alongside the bodies still arriving, which is what makes a fetch of two thousand bodies affordable, and nothing looked at them until every body had been received. (`c2d76c0`)
- **F19** `DerivedAuth` checks the served vault, and that was taken to be the whole of the rule. (`5b57ce2`)
- **F20** `Entry.Validate` returned for a folder or a deletion before it looked at `Mac` and `Parent`, so both kinds were committed with an empty authenticator and a malformed parent. (`5b57ce2`)
- **F21** The deleted list was capped with no way past the cap, and both clients tried to get past it anyway: the panel doubled the limit it asked for and the CLI told people to raise `--limit`. (`d55d7ab`)
- **F22** A crash between the plugin's index removals leaves whatever is still there. (`ff4a514`)
- **F23** Redeeming an invite is a round trip, and Obsidian can disable a plugin while one is in flight. (`72d1edf`)
- **F24** A note's own path was validated and the internal directories were not. (`72d1edf`)
- **F25** `create` stages under the vault's own `.basalt/tmp` and hard-links into place, which is what makes it exclusive. (`72d1edf`)
- **F26** `rebase --json` returned zero unconditionally while the text branch called `exitCodeFor`, so an incomplete replay was a failure interactively and a success in automation: exactly the difference a cron job cannot see. (`ff4a514`)
- **F27** `status` read the index and the server's cursor. (`72d1edf`)
- **F28** Two things a server could make a device do without limit. (`d55d7ab`)
