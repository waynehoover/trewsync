# Gabbro plan critique

Reviewed 2026-09-17. This is a design review, not an implementation review. No Gabbro implementation exists to validate.

I read all five planning files and checked the load-bearing references against Basalt HEAD `664a9630517a4b5ae1caceb973ba79c05feccc31`. The checkout is clean and has the claimed 354 commits. In citations, `basalt:` means `/Users/wayne/code/basalt/`; other paths are relative to `/Users/wayne/code/gabbro/`. Counts below are physical source lines, including comments, with test files classified by `_test.go` or `.test.ts`.

My recommendation is a smaller first release: the Go sync/MCP server, the existing TypeScript engine in both the plugin and a published headless client, protected history, and a rehearsed migration. Remove the second sync engine from the release plan. Make recovery, authorization ordering, and the server mutation contract release prerequisites.

## 1. Things that should change

Findings are ordered by their consequences for notes and access to them, rather than by implementation order.

### 1.1 A 30-day history cutoff does not protect an agent's before-image

**The plan says:** replace before-image files with `previousUid`, then retain versions newer than a 30-day cutoff. Audit and undo remain ideas. See [PLAN.md:243](/Users/wayne/code/gabbro/PLAN.md:243), [plan/mcp-tools.md:20](/Users/wayne/code/gabbro/plan/mcp-tools.md:20), and [plan/ideas.md:12](/Users/wayne/code/gabbro/plan/ideas.md:12).

**Why this fails:** a note last changed 90 days ago can be edited by an agent today. Its old version is now neither the head nor younger than the cutoff. Purge can immediately delete the only before-image. The grace period must start when the version is displaced, not when its original content was written. Also, Basalt entries have client-supplied `ctime` and `mtime`, but no server commit timestamp: [basalt:server/internal/store/store.go:410](/Users/wayne/code/basalt/server/internal/store/store.go:410). These fields cannot safely drive retention age.

I executed Basalt's actual `purgeSurvivorUIDs` query against an in-memory two-version fixture and added the proposed age predicate. Only today's UID survived; `previousUid=1` did not. The current survivor query is at [basalt:server/internal/store/conditional.go:23](/Users/wayne/code/basalt/server/internal/store/conditional.go:23). This plan claim did not survive checking.

**Do instead:** store an operation record and explicit retention references in the same transaction as each MCP mutation. Pin every affected before-image until at least 30 days after that operation, independently of file timestamps. Include source and destination state for moves, backlinks, and tag batches. Purge preview, purge execution, chunk reachability, backup, and restore must all understand those references. Define what happens after the undo window expires; keeping everything forever is not required.

Ship conditional undo with agent writes. Undo appends a new version only if the affected heads still match the operation's outputs. If a person has edited since, refuse or restore to a copy. The current plugin does not supply overwrite undo: its history interface explicitly restores without replacing existing content at [basalt:client/src/plugin/history.ts:39](/Users/wayne/code/basalt/client/src/plugin/history.ts:39). The suggestion that the existing history panel already fills this gap in [plan/mcp-tools.md:129](/Users/wayne/code/gabbro/plan/mcp-tools.md:129) is misleading.

### 1.2 Atomic MCP operations need a new contract, including the preview's read set

**The plan says:** atomic batches are a flag on `AppendMany`; extract session commits and reuse them; recompute previews, compare plans, then conditionally write each changed path. See [plan/mcp-tools.md:24](/Users/wayne/code/gabbro/plan/mcp-tools.md:24), [plan/mcp-tools.md:149](/Users/wayne/code/gabbro/plan/mcp-tools.md:149), and [PLAN.md:339](/Users/wayne/code/gabbro/PLAN.md:339).

**Why this fails:** Basalt deliberately skips invalid entries before opening the transaction, rolls back individual stale entries to savepoints, and commits the others. Its session layer even falls back to individual commits after a batch infrastructure failure. Those behaviors are correct for the existing wire protocol and wrong for an atomic agent operation. See [basalt:server/internal/store/store.go:759](/Users/wayne/code/basalt/server/internal/store/store.go:759), [basalt:server/internal/store/store.go:829](/Users/wayne/code/basalt/server/internal/store/store.go:829), and [basalt:server/internal/server/session.go:1664](/Users/wayne/code/basalt/server/internal/server/session.go:1664). I ran `TestAppendManyRefusesOneEntryAndCommitsTheRest`; it passes and proves partial success is intentional.

Per-entry bases also do not protect everything a preview read. After a move preview is recomputed, a device can add a new backlink in another note, or introduce a filename that changes a short wiki-link's resolution. None of the planned output paths changed, so their bases still match, but the preview's claim about affected links is stale. Moving computation to the server removes filesystem races, not this database concurrency problem.

**Do instead:** keep device `putmany` partial-success semantics. Add a distinct `CommitOperation` with an explicit all-or-nothing contract and no individual-write fallback. Validate the entire operation, including parent folders and path dependencies; append entries, audit data, undo pins, and its durable result in one transaction. A server-atomic batch is still applied file by file on devices; do not promise atomic visibility in Obsidian.

For the first release, bind each preview to a consistent vault snapshot and require that snapshot's head still matches when the operation commits. This conservative check also detects new backlinks and namespace changes. Recompute outside the write lock, then check the snapshot under the commit boundary. Later, a complete read-set and namespace revision scheme could reduce unnecessary refusals. Testing just one raced output path is insufficient.

### 1.3 Direct database administration breaks revocation ordering

**The plan says:** admin commands can write SQLite while `serve` runs because WAL, `busy_timeout`, and a shared data-directory lock coordinate them. See [PLAN.md:81](/Users/wayne/code/gabbro/PLAN.md:81).

**Why this fails:** a shared lock permits simultaneous holders. It does not join another process to `commitMu`, invalidate its authentication state, or evict its sockets. Basalt explicitly documents that deleting a device row alone leaves its live connection receiving notes: [basalt:server/internal/server/hub.go:85](/Users/wayne/code/basalt/server/internal/server/hub.go:85). It currently serializes credential checks, mutations, and revocation under the same process lock: [basalt:server/internal/server/authorization.go:12](/Users/wayne/code/basalt/server/internal/server/authorization.go:12). The data lock's purpose is to exclude destructive maintenance, not serialize these operations: [basalt:server/internal/dirlock/dirlock.go:77](/Users/wayne/code/basalt/server/internal/dirlock/dirlock.go:77).

There is also a check-then-commit gap if an external process revokes a credential after the server checks it but before the write commits. SQLite serializing SQL writers does not serialize that earlier application-level check. I ran Basalt's live-session revocation and revoked-writer tests successfully; the proposed admin path bypasses the mechanism they test.

**Do instead:** route mutating administration through a private local control socket owned by `serve`, using the same authorization and commit boundary. Allow direct mutation only with the server stopped under an exclusive lock. Read-only `stats`, verification, and backup may retain their existing access paths. A successful revoke must mean no later authorized mutation can commit and no active subscription continues delivering new notes. Check MCP scope and credential generation again at commit, not only in HTTP middleware. Revoke the token and its author/device relationship atomically, whichever interface initiates the revoke.

### 1.4 Cutover needs a rollback procedure and a storage identity, not counts and a round trip

**The plan says:** fresh pairing handles migration; back up Basalt, upload the live Mac vault, compare counts, pair the phone, and remove the old services. The old directories can go after 30 days. See [PLAN.md:109](/Users/wayne/code/gabbro/PLAN.md:109) and [PLAN.md:392](/Users/wayne/code/gabbro/PLAN.md:392).

**Why this is risky:** equal counts do not prove equal paths or bytes. The procedure does not first settle offline edits, reconcile device differences, or explicitly disable Basalt on each local vault before enabling the new plugin. A new plugin id allows both plugins to remain installed. A phone carrying an older tree is a source of writes, not merely a download target. Populated-vault confirmation is not a migration reconciliation algorithm.

A server backup also cannot establish that a currently unsynced local edit was preserved. Basalt itself says to back up readable local notes separately at [basalt:docs/security.md:103](/Users/wayne/code/basalt/docs/security.md:103). Restore rehearsal is not missing from Basalt or entirely absent from this plan: [basalt:scripts/check.sh:152](/Users/wayne/code/basalt/scripts/check.sh:152) and PLAN M9 carry it. What is missing is an early rehearsal of this new migration, credentials, history pins, and rollback with representative data.

There is a concrete format collision too. Gabbro proposes `user_version=1` and `CREATE IF NOT EXISTS` at [PLAN.md:168](/Users/wayne/code/gabbro/PLAN.md:168); Basalt already uses schema version 1 at [basalt:server/internal/store/open.go:31](/Users/wayne/code/basalt/server/internal/store/open.go:31). Version 1 cannot distinguish the two products. Bare UIDs are also insufficient after restoring an older database and creating a different continuation of its UID sequence.

**Do instead:** rehearse on an isolated copy, settle each device, take both encrypted server and local-vault backups, and compare an inventory of normalized paths, kinds, lengths, and content hashes against a freshly downloaded third copy. Disable the old writer per device before pairing the new one. Keep the old service and data isolated, with a documented way to export post-cutover edits before rolling back. Retirement should require a successful restore rehearsal and explicit acceptance, not merely elapsed time.

Add a product/format identifier and a store epoch. Refuse Basalt or unknown directories before mutating them. Bind cursors and MCP version preconditions to the epoch; an explicit restore changes it. A restored backup can also resurrect previously revoked credentials, so isolated restore testing and credential retirement belong in the procedure.

### 1.5 Server-readable does not require unprotected disks and backups

**The plan says:** the server holds notes in the clear, backups need encryption if they leave the box, and losing E2EE loses exactly one property. See [PLAN.md:208](/Users/wayne/code/gabbro/PLAN.md:208).

**Why this understates the change:** the server now has readable current notes, deleted versions, chunks from abandoned uploads, filenames, search terms, and potentially audit context. Database WAL files, search databases, temporary files, snapshots, backup staging directories, crash dumps, and copied volumes are additional exposure paths. A backup on the same homelab is still a backup someone or another process can read. Removing entry authentication also removes the device's ability to distinguish legitimate content from content a compromised server manufactured; SHA-256 provides consistency checking, not independent writer authenticity.

**Do instead:** explicitly accept server trust while requiring encrypted persistent storage and encrypted backups, including local backup destinations. For this project, OS/filesystem encryption plus an established encrypted backup tool is a better first choice than designing application encryption into chunks and SQLite. Document where keys live and how an unattended restart unlocks storage. Encryption protects only the layers actually encrypted: a logical snapshot exported from an unlocked filesystem can still contain plaintext. Back up the database, WAL as appropriate to the backup method, chunks, audit data, and derived indexes under the same protection policy.

At-rest encryption does not protect a running service from root compromise, an agent with an authorized token, or a model provider receiving tool results. A copied key beside copied ciphertext does not add that protection either. State these limits without claiming that Tailscale changes them. If protecting against a live server compromise becomes a requirement, the architectural decision to remove E2EE must be revisited.

**Chunk names deserve an explicit decision:** raw SHA-256 makes known or guessed content recognizable from chunk identifiers and permits correlation across exposed inventories. A `have`/`want` response can reveal whether guessed bytes already exist. This is not an unauthenticated leak demonstrated in Basalt: the relevant endpoints authenticate, and the current trust scope is already the whole vault. Do not exaggerate it, but do not publish chunk names in logs, metrics, unauthenticated endpoints, or public backup manifests. Keep deduplication scoped to the vault. If future sharing introduces narrower readers, revisit fetch authorization and presence oracles before reusing this design.

I would keep raw-byte SHA-256 for this explicitly trusted, single-vault server. HMAC names would reintroduce a naming secret and would not hide plaintext from this server. The current hash function really is reusable: [basalt:client/src/core/crypto.ts:743](/Users/wayne/code/basalt/client/src/core/crypto.ts:743). The lost confidentiality of identifiers must nevertheless be documented.

### 1.6 Delete the Go engine milestones from the first release, and strengthen merge acceptance

**The plan says:** a staged 5,500-line Go port earns one binary; different Go and TypeScript merge outputs are acceptable because conditional writes serialize publication and content remains somewhere. See [PLAN.md:99](/Users/wayne/code/gabbro/PLAN.md:99), [PLAN.md:101](/Users/wayne/code/gabbro/PLAN.md:101), and [PLAN.md:349](/Users/wayne/code/gabbro/PLAN.md:349).

**Why this is the wrong trade:** 5,519 lines counts only `engine.ts`. The port also needs the 2,674-line transport, 3,445-line Node filesystem adapter, 1,147-line merge, 276-line merge regions, and journal/index machinery. These are measured file lengths, not estimates of new Go code. The plan already retains the working TypeScript client and adapter for testing, so the Go port adds a production engine rather than removing one. Its ongoing cost is having to apply every preservation fix twice.

The lock rationale is also incomplete. Holding a Go `flock` fd is reasonable, but the retained Node adapter uses an abstract socket on Linux. Those mechanisms do not exclude each other. See [basalt:client/src/cli/exclusion.ts:21](/Users/wayne/code/basalt/client/src/cli/exclusion.ts:21) versus [PLAN.md:356](/Users/wayne/code/gabbro/PLAN.md:356). Shared journal formats make concurrent access by the two implementations especially dangerous. Matching disk formats does not create mutual exclusion.

Conditional writes pick one immediate winner; they do not prove eventual convergence, bounded conflict-copy creation, semantic correctness, or that a stale writer will preserve the right thing at the right path. Basalt explicitly explains that all insertions can survive while meaning is destroyed at [basalt:client/src/core/merge.ts:48](/Users/wayne/code/basalt/client/src/core/merge.ts:48). It also rejects nondeterministic region computation at [basalt:client/src/core/merge-regions.ts:55](/Users/wayne/code/basalt/client/src/core/merge-regions.ts:55). Thus “retained content, not agreement” is an important warning against a weak test, not a complete merge specification.

**Do instead:** publish the stripped TypeScript headless client. Use that client as an optional sidecar for a server-host folder, through the ordinary authenticated transport. Keep the Go server a single deployable binary without requiring every supported role to be written in Go. Reopen a Go client only for a measured runtime, packaging, or resource requirement.

If the port returns, require shared golden merge decisions and outputs, explicit UTF-16/Unicode handling, fixed algorithm settings, and differential fuzzing. Unexplained disagreements should conservatively keep both versions. Test preservation and eventual agreement after edits stop, bounded extra versions/copies, idempotent replay, intended deletions, renames, and a newly paired witness device. Independent merges need not mathematically produce identical bytes in every permissible design, but the stated design has not proved that its allowed differences settle safely. I did not reproduce a mixed-engine divergence because no Go engine exists.

### 1.7 A frozen draft cannot substitute for an interoperable vertical slice

**The plan says:** M1 and M2 can run independently once the protocol document is frozen. M1 accepts Go-only tests; M4 and M6 can start behind it. See [PLAN.md:274](/Users/wayne/code/gabbro/PLAN.md:274) and [PLAN.md:410](/Users/wayne/code/gabbro/PLAN.md:410).

**Why this is premature:** the proposed contract is both incomplete and internally inconsistent:

- Redemption sends `auth` in [PLAN.md:278](/Users/wayne/code/gabbro/PLAN.md:278) and `token` in [plan/protocol.md:35](/Users/wayne/code/gabbro/plan/protocol.md:35).
- Invite `len(url)`, `len(vault)`, CRC byte order, checksum coverage, and canonical base64 rules are not specified at [plan/protocol.md:46](/Users/wayne/code/gabbro/plan/protocol.md:46).
- Transport decodes frames before hashing, but engine assembly is also told to decode frames at [PLAN.md:300](/Users/wayne/code/gabbro/PLAN.md:300). The return contract between the layers must say whether bytes are framed or raw.
- M1 says `handleResend` encodes outgoing bodies. Basalt's function receives repair uploads through `readBodies`; it is not a download handler. See [basalt:server/internal/server/session.go:2161](/Users/wayne/code/basalt/server/internal/server/session.go:2161), especially line 2209. That port instruction is wrong.
- `size + 64` per entry at [plan/protocol.md:91](/Users/wayne/code/gabbro/plan/protocol.md:91) is not an exact wire-memory budget for an entry with many chunk frames. Separate raw-byte, encoded-frame, control-message, and aggregate request limits, including the marker byte at the maximum raw chunk size.
- MCP writes need the Go chunker in M5 at [PLAN.md:229](/Users/wayne/code/gabbro/PLAN.md:229), while its explicit port and shared boundary fixtures arrive in M7 at [PLAN.md:370](/Users/wayne/code/gabbro/PLAN.md:370).
- The general text-chunking heuristic is proposed as MCP edit eligibility at [PLAN.md:220](/Users/wayne/code/gabbro/PLAN.md:220), but the MCP spec allows editing only `.md` and `.txt`. Basalt's heuristic includes source, XML, SVG, YAML, and other formats and explicitly says it is only an efficiency guess: [basalt:client/src/core/chunk.ts:499](/Users/wayne/code/basalt/client/src/core/chunk.ts:499). These must be separate policies.

**Do instead:** build one small Go-server/TypeScript-client slice before splitting work: invite redemption, one upload, fetch, rename, stale refusal, reconnect, and repair. Freeze executable cross-language fixtures alongside precise protocol text. Require both implementations to consume each other's vectors, not just independently generate their own. Then parallelize bounded areas behind that gate and integrate continuously. The “where silent, protocol 7 applies” shortcut at [plan/protocol.md:3](/Users/wayne/code/gabbro/plan/protocol.md:3) should become an explicit list of inherited operations and differences.

### 1.8 Search parsing must not become a prerequisite for syncing a note

**The plan says:** assemble and parse text, maintain FTS5 and tags inside the commit transaction, and rebuild at startup. See [PLAN.md:93](/Users/wayne/code/gabbro/PLAN.md:93) and [PLAN.md:326](/Users/wayne/code/gabbro/PLAN.md:326).

**Why this expands the failure domain:** every device write now depends on the new Markdown/YAML parser and search implementation. A malformed frontmatter case, expensive note, indexing failure, or long FTS maintenance operation can delay or reject the authoritative sync write. A 256-entry batch can accumulate substantial work behind SQLite's single writer. Rebuild also needs a consistent snapshot while edits, renames, and deletes continue. A missing table or changed `index_version` does not detect an existing corrupted or silently incomplete index.

**Do instead:** commit authoritative versions plus durable indexing work, then index asynchronously. Use the version log as the recoverable work source, or a small transactional pending-path table; do not rely only on a best-effort hub notification. Put derived search data in a separate rebuildable database if isolating corruption and write contention is the goal. Record a contiguous `indexedHead`, generation, eligible/skipped counts, failures, and lag. Invalid frontmatter may limit tag extraction but must not reject an otherwise valid sync entry.

Build a replacement index from a captured head, catch up later changes, and switch generations after verification. Interrupted builds restart safely; sync stays available. Measure rebuild wall time, disk headroom, peak memory, and sync commit latency on a representative vault and a larger synthetic corpus. Define `complete` relative to eligible formats and size limits, not just whether a worker reached the latest UID. Link-based mutations must scan authoritative content or prove their link index is current; `note_links` is referenced at [plan/mcp-tools.md:121](/Users/wayne/code/gabbro/plan/mcp-tools.md:121) but has no concrete schema or maintenance task.

### 1.9 The proposed search and pagination semantics are not preserved

**The plan says:** an escaped FTS5 phrase is Basalt's literal search; immutable UIDs and a pinned head make pagination stable. See [plan/mcp-tools.md:59](/Users/wayne/code/gabbro/plan/mcp-tools.md:59), [plan/mcp-tools.md:71](/Users/wayne/code/gabbro/plan/mcp-tools.md:71), and [plan/mcp-tools.md:85](/Users/wayne/code/gabbro/plan/mcp-tools.md:85).

**What failed checking:** Basalt uses an escaped literal regular expression, not token search, at [basalt:client/src/cli/mcp-read.ts:305](/Users/wayne/code/basalt/client/src/cli/mcp-read.ts:305). In SQLite 3.54.0, I inserted `foobar`: `MATCH '"oo"'` returned zero rows, while `instr(body,'oo') > 0` returned one. Filtering FTS hits afterwards cannot restore omitted matches. SQLite documents phrase tokenization and the trigram tokenizer's short-query limitations in its [FTS5 reference](https://www.sqlite.org/fts5.html#fts5_phrases) and [trigram documentation](https://www.sqlite.org/fts5.html#the_trigram_tokenizer). This probe used the local SQLite CLI, not Basalt's pinned Go driver.

The stated listing predicate also leaves rename sources visible. Given `A.md` at UID 1 and a rename to `B.md` at UID 2, selecting the latest row per `path` below head 2 returns both paths. I ran that fixture. Basalt already has the missing retirement predicate at [basalt:server/internal/store/conditional.go:11](/Users/wayne/code/basalt/server/internal/store/conditional.go:11); an as-of query must cap both normal entries and rename retirements at the snapshot head.

**Do instead:** choose literal substring search deliberately, using a candidate index only where it cannot omit matches and a bounded scan fallback where it can. Alternatively introduce a clearly named token-search mode. Add Unicode, punctuation, one/two-character, substring, case, and multiline fixtures shared with Basalt's contract.

Make listing cursors account for renames, deletes, reused paths, store epoch, and retention. A pinned UID does not keep its row alive across purge. Either lease short-lived snapshots or return an explicit expired-cursor result. Search cursors must pin an index generation or refuse continuation when it changes. `compare_versions` must resolve an omitted `toUid` once and carry it through continuation; otherwise each page can compare against a different head.

### 1.10 Durable commit, delivery, and a known client outcome are different facts

**The plan says:** `sync: pending` disappears because a committed version is visible to every connected device; a plugin should receive the batch before the tool reply. All uncertainty reduces to `stale`. See [PLAN.md:87](/Users/wayne/code/gabbro/PLAN.md:87) and [plan/mcp-tools.md:170](/Users/wayne/code/gabbro/plan/mcp-tools.md:170).

**Why this is false:** Basalt's hub explicitly skips failing peers and relies on later catch-up; broadcasting is not its durable delivery channel. See [basalt:server/internal/server/hub.go:50](/Users/wayne/code/basalt/server/internal/server/hub.go:50). A queue insertion is not a phone applying the note. Also, the plan itself tests a kill after commit but before reply at [PLAN.md:344](/Users/wayne/code/gabbro/PLAN.md:344). The caller then has an unknown outcome, even though the database has a definite one. Reply-size failure after a committed operation must not be reported as an ordinary failed mutation either.

**Do instead:** report `committed` with operation id and resulting UIDs, and expose delivery separately through applied checkpoints. Do not block an agent edit on every device. Add request idempotency: persist a caller-supplied operation key, canonical request digest, and result with the commit; replay returns the same result, and key reuse with different input refuses. Define result retention and a lookup for lost replies. Base checks already prevent many duplicate retries, but they do not explain whose earlier write succeeded.

Revalidate noops at the same authorization/head boundary; returning `noop` based on a head that changed during computation is not sound. Use `previousUid: null` for a genuinely absent predecessor, and distinguish a predecessor tombstone from readable content. The universal “read every previous UID as former bytes” test cannot apply to creates, folders, and tombstones. Preserve typed storage failures and distinguish pre-commit refusal from an unknown transport outcome.

### 1.11 The token policy needs to be a real, consistent capability boundary

**The plan says:** whole-vault static bearers, `read|write` scopes in the MCP spec, 32 concurrent requests globally, and no-expiry host invites printed at startup. See [PLAN.md:77](/Users/wayne/code/gabbro/PLAN.md:77), [PLAN.md:79](/Users/wayne/code/gabbro/PLAN.md:79), [plan/mcp-tools.md:33](/Users/wayne/code/gabbro/plan/mcp-tools.md:33), and [plan/mcp-tools.md:37](/Users/wayne/code/gabbro/plan/mcp-tools.md:37).

**Why this needs more design:** `scope` is missing from the proposed table at [PLAN.md:178](/Users/wayne/code/gabbro/PLAN.md:178). Omitting mutation tools from discovery is not enforcement against a hand-crafted request. Global concurrency is not per-token fairness, a rate limit, or a byte/CPU budget. One agent can monopolize search or generate history until disk exhaustion. A permanent invite in container logs is a durable vault credential.

**Do instead:** keep static bearers for this personal deployment, default to read-only, require explicit write capability, and enforce it on every dispatch and again on mutation commit. Do not add OAuth solely for architectural fashion. Whole-vault read access must be stated as intentional exposure to the configured agent and its model service. Consider an optional write-prefix capability for unattended agents without pretending it protects reads; a full ACL system is not necessary for v1.

Add per-token admission, sustained request and byte budgets, parser/assembly deadlines, and disk-pressure controls that preserve capacity for ordinary device sync. Rate-limit failed authentication separately. Use expiring invites by default and an explicit private output path for bootstrap credentials. Use a collision-resistant stable token identifier; eight hex hash characters are a display fingerprint, not a good database identity.

MCP pseudo-devices also need explicit validation and verification support: Basalt's `ValidDeviceID` accepts base64url, so `mcp:<id>` is not an unchanged device id. See [basalt:server/internal/store/store.go:2595](/Users/wayne/code/basalt/server/internal/store/store.go:2595). Preserve author identity after revocation without leaving a usable sync credential or making agents appear to be offline sync peers waiting to acknowledge every version.

### 1.12 Settle the whole-file writer decision honestly

**The plan says:** no `write_note` in scope, but section 4.4 leaves it for Wayne to decide and `ideas.md` still calls it pending. See [PLAN.md:51](/Users/wayne/code/gabbro/PLAN.md:51), [PLAN.md:239](/Users/wayne/code/gabbro/PLAN.md:239), and [plan/ideas.md:24](/Users/wayne/code/gabbro/plan/ideas.md:24).

**What should change:** settle v1 as exact edits, append, prepend, and create. Server history alone does not justify a whole-file writer, especially while retention and undo are incomplete. However, exact edits are not a semantic safety boundary: an agent can replace an entire small note as one unique `old`, delete important prose, or append harmful content. A mandatory base protects committed concurrent changes; it cannot see a phone's unsynced work or prove preservation of meaning.

If actual usage shows a need, add an explicitly enabled `replace_note` with full-read base, diff preview, size bounds, operation audit, protected before-image, and conditional undo. Do not implement a user-approval ceremony merely because the tool exists; the essential prerequisite is a concrete, reviewable diff and the same enforceable commit contract. Measure tool use before introducing it.

### 1.13 The reuse map needs an evidence correction pass

**The plan says:** roughly 80% of the server is reusable unchanged, the server has 9,500 non-test lines and 27,000 test lines, the core has 22,900 non-test lines, and nearly all plugin files survive unchanged. See [PLAN.md:28](/Users/wayne/code/gabbro/PLAN.md:28) and [plan/reuse-map.md:5](/Users/wayne/code/gabbro/plan/reuse-map.md:5).

**Measured at the cited commit:**

| Area | Plan | Checked checkout |
|---|---:|---:|
| Go non-test lines | 9,500 | 13,588 in 18 files |
| Go test lines | 27,000 | 22,895 in 73 files |
| Top-level Go `Test...` functions | about 600 | 536, excluding subtests |
| Core TypeScript non-test lines | 22,900 | 20,802 in 36 files |
| Core TypeScript test lines | 19,200 | 21,301 in 56 files |
| Plugin source/test files | 14 / 22 | 15 / 21, including source-side test helpers |
| MCP non-test lines | 4,700 | 5,246 in 21 files |

The totals did not survive checking. Individual large-file lengths mostly did: [basalt:server/internal/store/store.go:3546](/Users/wayne/code/basalt/server/internal/store/store.go:3546), [basalt:client/src/core/engine.ts:5519](/Users/wayne/code/basalt/client/src/core/engine.ts:5519), [basalt:client/src/core/transport.ts:2674](/Users/wayne/code/basalt/client/src/core/transport.ts:2674), and [basalt:client/src/cli/vault.ts:3445](/Users/wayne/code/basalt/client/src/cli/vault.ts:3445) are the actual final lines. The map is not uniformly invented, but its precision is overstated.

The `commit`/`commitMany` reference at [plan/reuse-map.md:21](/Users/wayne/code/gabbro/plan/reuse-map.md:21) points to the tail of one function, not their definitions. The actual starts are [basalt:server/internal/server/session.go:1608](/Users/wayne/code/basalt/server/internal/server/session.go:1608) and [basalt:server/internal/server/session.go:1968](/Users/wayne/code/basalt/server/internal/server/session.go:1968). `chunks.Store.Size` exists and is useful, but its signature is `Size(vaultID, name) (int64, bool)`, not simply `Size(name)`: [basalt:server/internal/chunks/chunks.go:331](/Users/wayne/code/basalt/server/internal/chunks/chunks.go:331).

The packages/files labelled A amount to about 2,929 of 13,588 Go lines under the map's own groupings. That does not disprove 80% textual reuse inside modified files, but the plan supplies no measurement for it. Textual reuse is also not retained assurance when authentication, entry validation, body representation, and commit behavior all change.

**Do instead:** replace the percentage with a symbol-level ledger: copied behavior, changed contract, test carrying the guarantee, and evidence after the change. Keep obsolete-crypto test cases separate from still-needed invariants. In particular, wholesale deletion of `keys_test.go` would discard invite redemption rollback and revoke-race cases at [basalt:server/internal/store/keys_test.go:530](/Users/wayne/code/basalt/server/internal/store/keys_test.go:530) and [basalt:server/internal/store/keys_test.go:557](/Users/wayne/code/basalt/server/internal/store/keys_test.go:557). Rewrite their setup and retain their assertions. Preserve the TypeScript MCP semantic fixtures until their Go replacements pass; do not erase the comparison oracle in M2 and rebuild it from memory in M5.

The chunking decision itself is defensible. Basalt has real measurements at [basalt:docs/research.md:657](/Users/wayne/code/basalt/docs/research.md:657) and [basalt:client/src/core/chunk.ts:100](/Users/wayne/code/basalt/client/src/core/chunk.ts:100). Their limitations are explicit: the measurements do not establish mobile memory bounds, and large plugin reads may still be whole-file. Do not turn those results into a universal “attachments stream in bounded memory” guarantee.

## 2. Things to add to the plan

The following blocks use the plan's task-and-acceptance style. Locations name where to paste them; the wording below each location is proposed plan text.

### 2.1 Replace §2.6, §2.7, M6-M8, and the dependency diagram: one production engine

The first release ships a Go server and two TypeScript clients: the Obsidian plugin and the published headless CLI. Both clients use the same core engine. The Node adapter is production code and remains in the full test gate. A server-host folder uses the headless client over the ordinary protocol, with its own credential and directory exclusion.

The Go sync engine and in-process `--vault-dir` mode are later work. They require a measured reason to maintain a second implementation. The Go chunker needed by MCP belongs in the shared notes package before write tools; it does not require a Go sync engine.

Release sequence:

```text
M0 baseline, naming, storage identity, fixture inventory
  -> M0.5 Go/TypeScript plaintext vertical slice
  -> M1/M2 coordinated server and client work
  -> M3 scratch desktop and phone acceptance
  -> M4 read-only MCP and bounded search
  -> M5 atomic operations, audit, retention, undo, crash recovery
  -> M5.5 operational and restore acceptance
  -> M9 packaging and runbooks
  -> M10 rehearsed migration and cutover
```

Documentation and packaging may proceed alongside implementation. No milestone that mutates real notes starts before its recovery path is exercised.

### 2.2 Insert after M0: M0.5. Contract slice (M, sequential gate)

Goal: one Go server and one TypeScript client agree on the new protocol before the work splits.

Tasks:

1. Record the Basalt commit, measured file inventory, and the test invariants that survive stripping encryption. Keep the old MCP fixtures available as a reference.
2. Define the invite byte layout completely. Pin good and bad vectors for base64, URL/vault lengths, CRC, expired tokens, and single-use redemption. Generate the joining device credential before sending redemption and persist it safely. Test a committed redemption whose reply is lost; retry must recover the paired device or give an explicit recoverable result.
3. Put framing at the transport boundary. Its consumers receive verified raw chunks. Test empty bodies, raw payloads beginning with `0` or `1`, maximum sizes including marker overhead, truncated deflate, unknown markers, and inflation beyond the raw limit. Apply the same rule to repair uploads.
4. Share path and format-policy fixtures. Distinguish syncable paths, text chunking, search eligibility, MCP readability, and MCP editability. Cover NFC, astral characters, byte versus character limits, staging substrings, case collisions, and file-versus-directory collisions.
5. Specify the inherited protocol operations explicitly. Add exchange transcripts for `have`, `want`, mixed-success device batches, stale rename source/destination, reconnect continuity, repair, and applied receipts.
6. Port the Go text chunker and prove its boundaries against the TypeScript implementation before MCP uses it. Compression outputs may differ; decoded bytes, names, and size checks may not.

Done when: a TypeScript client pairs, uploads raw and deflated notes, fetches them through Go, repairs a missing body, renames, races a conditional write, and reconnects without losing stream continuity. Fixtures run in both language suites. A deliberately changed vector fails the consuming side's test.

### 2.3 Add to §3.3 and M1: storage identity and administration

Every data directory records a product identifier, schema version, and store epoch. Opening a directory validates all three before running schema changes. A Basalt directory, an unknown product, or a newer incompatible schema is refused without writes. Future schema upgrades remain explicit, transactional, and tested; a fresh first schema does not remove the need for upgrade discipline.

Live administrative mutations go through a private local socket served by the running process. Direct mutation requires the server to be stopped and an exclusive data lock. Revoke shares the commit ordering used by sync and MCP, invalidates queued mutations, and evicts live delivery subscriptions before reporting success. An explicitly restored database starts a new epoch and refuses old cursors and mutation preconditions.

Tests: wrong-directory startup leaves byte-identical input; revoke races upload, MCP preparation, invite creation, and token recreation; a revoked connection receives no later version; a stale MCP token cannot finish a queued commit; the device-panel revoke path also retires the corresponding MCP token.

### 2.4 Replace §4.3 and expand M5: durable agent operations

A mutation is one operation with an authenticated actor, an idempotency key, validated preconditions, and a durable result. Device batches retain their existing per-entry answers. MCP batches use a separate all-or-nothing operation API.

Tasks:

1. Define `CommitOperation` inputs and error outcomes. Prepare note bytes outside the write lock. Under the commit boundary, recheck credential, scope, store epoch, source/destination bases, and any preview snapshot dependency.
2. Persist new entries, operation metadata, before-image retention references, and the operation result in one transaction. Bodies are durable before entries reference them. No atomic operation falls back to individual commits. Precompute and bound the result before committing.
3. Record operation id, actor id and label at the time, tool, server commit time, request digest, affected paths, before/after UIDs, and outcome. Do not record bearer tokens or note bodies in general logs. Revoking an actor does not erase its audit history.
4. Store a unique `(actor, idempotencyKey)` record. The same request returns its recorded result; a different request under that key refuses. Define retention for results and explicit behavior after it expires. Provide an operation lookup for a lost reply.
5. Return server commitment separately from device delivery. Broadcast after commitment. Catch-up recovers a commit that was never broadcast. Noops revalidate their preconditions and write no note version.
6. Make creates, folders, deletions, moves, and empty files explicit in result schemas. An absent before-image is `null`; a tombstone is not readable note content. Every affected path in a batch has its own result and predecessor state.

Preview apply requires an unchanged snapshot head for v1. The preview records the operation arguments, actor, store epoch, head, and normalized changes. Recomputed plans must include effects of filename resolution, outbound links, backlinks, and tag selection. A partial scan cannot be applied.

Done when: one stale slot, a changed namespace, a new backlink, a revoked actor, or an injected storage error leaves zero operation entries committed. SIGKILL after append but before broadcast/reply yields one discoverable result after retry. A fresh witness device sees exactly the committed state. A slow peer does not delay the operation reply indefinitely.

### 2.5 Replace §4.5 and move audit/undo out of ideas: recovery is part of M5

History used as an agent before-image is retained by reference. Each operation pins the displaced versions until at least 30 days after its server commit time. `ctime` and `mtime` are file metadata and never decide this window. Ordinary history retention, operation-result retention, and before-image retention are separate policies.

Purge's survivor set includes normal heads, required rename records, and unexpired operation pins. Its preview uses the same survivor calculation as execution. Chunk collection considers every surviving reference. Backup carries the audit records and pins; restore validates them. Purge stays an explicit maintenance operation.

Undo is an appended compensating operation. It verifies that all affected heads still equal the original operation's outputs. A later user edit causes refusal or a restore-to-copy offer, never a blind overwrite. Moves and backlink/tag batches undo together or refuse together. A partial manual recovery remains possible from the operation's recorded versions.

Tests: edit a note untouched for a year, purge immediately, restart, and read its exact former bytes; repeat after backup/restore. Undo an edit, delete, rename with backlinks, and tag batch. Race undo against a device edit. Verify that an expired pin becomes reclaimable only when no other survivor needs it.

### 2.6 Replace §2.5 and expand M4: derived search with explicit completeness

Search is a rebuildable view of committed notes. A search failure does not reject a sync commit. A durable log position or pending-path record makes unfinished indexing discoverable after restart. A worker records the last contiguous indexed head and its index generation; skipped formats and invalid text are reported separately from backlog.

Literal search remains literal. If an index cannot produce a complete candidate set, the implementation scans within a documented budget or reports incomplete results. Short strings, punctuation, case behavior, Unicode, and substrings inside words are contract fixtures. Search, tags, and link previews use the same parsing policy but do not treat a parsing error as an empty note.

Index rebuild captures a snapshot, builds a new generation in bounded batches, replays subsequent changes, checks integrity, and then switches generations. The previous usable index may remain available with its observed head. Missing history needed for replay forces a fresh rebuild. A corrupt index is detected independently of its schema version.

Done when: search matches the reference literal scan on the corpus; concurrent rename/delete/recreate does not produce ghost results; corrupt, interrupted, and outdated indexes rebuild while device writes continue. Listing and search cursors either continue against their declared snapshot/generation or explicitly expire. Rebuild reports duration, peak memory, disk cost, and effects on commit latency.

### 2.7 Insert before cutover: M5.5. Operational acceptance and restore rehearsal (M)

Goal: the maintainer can distinguish a healthy vault from a quiet failure, recover from a failed server, and explain every agent mutation.

Tasks:

- Write the threat model before deployment. Document encrypted storage and backup coverage, key custody, TLS termination, service-user permissions, secret output handling, snapshots, logs, and the limits of protection against a running-host compromise. Treat chunk identifiers and paths as sensitive metadata.
- Enforce read-only tokens by default. Specify read/write scopes in schema, dispatch, and commit checks. Add per-token concurrency, request and byte rates, deadlines, maximum operation cost, and pre-auth limits. Record tested defaults. An abusive token must receive 429 without starving another token or ordinary sync.
- Add structured operation ids and bounded metrics: commit latency, lock wait, stale refusals, auth failures, rate-limit responses, active/evicted peers, applied lag, index lag/failures, database/WAL/chunk sizes, free space, last verified backup, and last successful restore rehearsal. Keep credentials, note bodies, paths, and chunk digests out of metric labels.
- Define alert conditions and remedies for disk pressure, failed backups, missing chunks, repeated commit failures, index lag, and a device that stops advancing. “Process is listening” is not a vault-health verdict. Expose detailed diagnostics only through authenticated or local access.
- Rehearse restoring an encrypted backup to a separate directory and port with production clients unable to connect. Verify all expected versions and bodies, operation pins, audit records, rename/deletion recovery, and a freshly paired device's downloaded bytes. Rebuild search from that restored store. Measure recovery time and document the data-loss window implied by the backup schedule.
- Extend fault testing beyond SIGKILL: disk full during chunk and database writes, failed directory fsync, missing/corrupt chunks, slow peers, dropped replies, restart loops, and parser failures. Retain deterministic seams and failing seeds. SIGKILL alone is not evidence for power-loss durability.

Done when: each fault produces an actionable status, preserves acknowledged content, and has a tested recovery path. Complete a defined soak period on disposable representative data, including a phone offline during agent edits. The exit criterion is no unexplained loss, divergence, or unbounded retries, not zero expected conflict copies. The operator has performed a restore, not merely read its instructions.

### 2.8 Replace M10: rehearsal, inventory, cutover, rollback

Migration transfers current content; Basalt history remains an encrypted archive readable with the archived recovery material and a compatible Basalt build. Importing historical versions is a separate feature.

1. Before scheduling cutover, run the complete procedure on a disposable copy. Include attachments, large notes, nested renames, deleted notes, conflict copies, Unicode names, and an offline device with edits. Do not connect this rehearsal to a live vault.
2. Bring every participating device online against Basalt and account for local-only changes and conflicts. If a device cannot participate, freeze it and give it an explicit later rejoin procedure. Do not let an unknown old tree join blindly.
3. Pause writers, take and verify both the Basalt server backup and a snapshot of readable current vault content, and record the inventory. Archive the backup, keys, and compatible release securely. Define the rollback window and ownership of any later edits.
4. Disable the Basalt plugin and old headless writers on each migrating directory. Deploy the new server on an isolated address during verification. Pair the primary copied/tested vault and upload it. Download to a freshly paired empty witness and compare paths, kinds, sizes, and SHA-256 content hashes. Check excluded content explicitly.
5. Migrate the phone using a verified local backup and the reconciled inventory. Confirm no two sync systems operate on the same local directory. Exercise offline edits, catch-up, delete/restore, and conditional undo. Start MCP read-only before issuing an intentional write token.
6. If validation fails, stop new writers, preserve the new server and export post-cutover changes, then restore/reconcile against the frozen Basalt baseline. Do not point the old plugin at a changed directory and assume the old server will safely sort it out.
7. Retire the old services and data only after the new backup restores successfully, both devices pass the inventory checks, and the rollback procedure is no longer needed. Record the accepted result and retain the archived Basalt history according to an explicit policy.

Done when: independent downloads match the agreed source inventory, every participating device has converged, a new-server backup has been restored, and rollback has been rehearsed with post-cutover edits.

## 3. A new name

**My pick: Jotrove**, pronounced “JOT-rohv.” It joins *jot* and *trove*: a small personal collection of notes whose history stays recoverable. Seven lowercase letters work naturally in commands and package names without tying the product to a model vendor, a particular sync implementation, or another rock.

| Candidate | Binary and npm name | Plugin id | Invite prefix | State directory | Reason / drawback |
|---|---|---|---|---|---|
| **Jotrove** | `jotrove` | `jotrove-sync` | `jotrove1i_` | `.jotrove` | Notes plus a durable collection. The coined spelling needs one initial introduction. |
| Jotmere | `jotmere` | `jotmere-sync` | `jotmere1i_` | `.jotmere` | “JOT-meer”; a quiet place where notes collect. The “mere” association is less immediately obvious. |
| Inkweir | `inkweir` | `inkweir-sync` | `inkweir1i_` | `.inkweir` | “INK-weer”; stored writing with controlled flow between devices. More distinctive, but people may need help spelling “weir.” |

Availability checks performed on 2026-09-17:

| Check | Jotrove | Jotmere | Inkweir |
|---|---|---|---|
| Exact public npm registry document | HTTP 404 | HTTP 404 | HTTP 404 |
| GitHub repository search, `<name> in:name` | 0 results | 0 results | 0 results |
| `waynehoover/<name>` repository lookup | HTTP 404 | HTTP 404 | HTTP 404 |
| Obsidian community registry id/name search | No matches | No matches | No matches |
| Quoted general web search, also with software/notes terms | No relevant software collision found | No relevant software collision found | No relevant software collision found |

The direct npm checks were [jotrove](https://registry.npmjs.org/jotrove), [jotmere](https://registry.npmjs.org/jotmere), and [inkweir](https://registry.npmjs.org/inkweir). GitHub was checked with native `gh api search/repositories` and direct repository lookups, including [the proposed Jotrove namespace](https://api.github.com/repos/waynehoover/jotrove). I parsed all 7,750 entries returned by the [Obsidian community registry](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json). General searches returned some unrelated historical/OCR/name matches; they are not evidence of a competing software product.

These are absence checks, not reservations or a guarantee npm will permit publication. Domain registration and trademark clearance were not checked. Nothing was registered or created.

I rejected **Jotkeep** despite npm returning 404 because GitHub already has a directly adjacent [Markdown workspace](https://github.com/Asilencer/jotkeep). **Notewell** has an existing [npm package](https://registry.npmjs.org/notewell) in the notes/LLM space, **Leafkeep** is already a [reading and notes product](https://leafkeep.net/), and **Notewick** is already a [social product built around captured notes](https://notewick.com/). Those collisions matter more than whether a particular binary or npm spelling happens to be free.

For Jotrove, derive the remaining identifiers consistently: `JOTROVE_DATA`, `.jotrove-tmp-`, `obsidian://jotrove`, `github.com/waynehoover/jotrove`, and `WWW-Authenticate: Bearer realm="jotrove"`. Settle the name before freezing the invite format and on-disk identity.

---

Verification limits: I inspected source and ran five existing targeted Basalt tests covering partial batches, intra-batch visibility, rename retention, live-session revocation, and revoked-writer ordering. All passed. I also ran the in-memory retention, FTS phrase, and rename-listing probes described above. I did not run the complete Basalt suite, verify FTS5 in its pinned Go build, operate a live vault, or prove any unbuilt Gabbro behavior. The proposed race and recovery tests above are acceptance work, not claims of completed implementation testing.
