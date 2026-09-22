# Telimus: self-hosted Obsidian sync with a built-in agent

Named for House Telimus in James Islington's *The Will of the Many*, the family that takes Vis in and gives him a name. Said TEL-ih-mus. The name was chosen on 2026-09-22 after a second naming round; it replaced Lyell, which is recorded in [§10](#10-the-name) with the other candidates that did not survive. The on-disk identity (`telimus1i_` invite strings, `.telimus` state directories, the store's product identifier) derives from it, so it is settled, not a placeholder.

This plan is written for agents. Each milestone lists tasks small enough for one session, the Basalt files they start from, and the test that proves them done. Read [plan/reuse-map.md](plan/reuse-map.md), [plan/protocol.md](plan/protocol.md), and [plan/mcp-tools.md](plan/mcp-tools.md) before starting a task that touches those areas.

Seven code-level investigations of other self-hosted Obsidian sync projects and of Basalt's own history (2026-09-22) are synthesised in [plan/research/README.md](plan/research/README.md); its §5 lists the changes still to fold into this plan.

This revision incorporates two independent design reviews, both of which read the Basalt checkout and checked the plan's claims against it. The findings that changed the plan are recorded in [plan/review-synthesis.md](plan/review-synthesis.md); the reviews themselves are [plan/astra-critique.md](plan/astra-critique.md) and [plan/opus-critique.md](plan/opus-critique.md). Several load-bearing claims did not survive checking and are corrected below.

Source of truth for what exists today: `/Users/wayne/code/basalt` at commit `664a963` (Basalt Sync 0.10.0, protocol 7). Every file reference of the form `basalt:client/src/core/engine.ts:1329` points into that checkout.

## 1. What this is

One person's Obsidian vault, synced through a server they run, with an MCP server built into that server so agents read and edit the same notes the devices sync. No end-to-end encryption: the server holds the notes in the clear, which is what makes the built-in agent possible.

Three roles, one static Go binary:

| Role | Command | What it does |
|---|---|---|
| Server | `telimus serve` | WebSocket sync server. SQLite metadata, content-addressed chunk store, version history, conditional writes, live fan-out. |
| Agent endpoint | `telimus serve --mcp` | Streamable HTTP MCP at `/mcp` on the same listener. Tools read and write the server's own store, so an agent edit is an ordinary version that every device receives on the next frame. |
| Headless client | `telimus-sync` (npm) | A paired device without Obsidian: a plaintext mirror on a NAS, a two-way peer, or a live folder on the server host. This is the **existing TypeScript client**, published, not a Go port. See §2.6. |

The Obsidian plugin stays TypeScript and is a strip-down of Basalt's plugin: same panels, same preserving-write adapter, same history and recovery screens, minus the recovery key, rotation, and key handling.

**One sync engine, two deployments.** The plugin and the headless client both run `client/src/core`. There is no second implementation of reconciliation or merge in this plan. The Go binary is the server and the agent endpoint; it is not a sync peer.

### What Basalt gives us

Basalt is 354 commits of durability work. Nearly all of it survives the change. Measured at `664a963` (the plan's earlier round numbers were wrong in both directions; these are counted):

| Area | Measured |
|---|---|
| Go non-test | 13,588 lines in 18 files |
| Go test | 22,895 lines in 73 files, 536 top-level `Test…` functions |
| Core TypeScript non-test | 20,802 lines in 36 files |
| Core TypeScript test | 21,301 lines in 56 files |
| Plugin source / test files | 15 / 21 |
| TypeScript MCP non-test | 5,246 lines in 21 files |

What actually carries over:

- The eleven [durability rules](#durability-rules) and the review discipline behind them.
- The Go server: store, chunk store, session state machine, catch-up ordering, conditional writes (`base`/`prevBase`/`stale`), applied-checkpoint receipts, graceful shutdown, backup, purge, verify, health, systemd unit, scratch Docker image.
- The TypeScript engine: reconciliation, three-way merge with validity gates, preserving replace, index journal, retry scheduling, conflict copies, recovery inventory. Crypto touches are concentrated in six files and listed line by line in the reuse map.
- The MCP contract: tool names, input shapes, bounds, pagination, exact-edit semantics, and an error vocabulary already exercised by a crash matrix. The semantics move to Go; the *mutation contract* does not survive unchanged (§4.3).

**Do not quote a reuse percentage.** The packages the reuse map labels "unchanged" are about 2,929 of 13,588 Go lines, and textual reuse inside a modified file is not retained assurance when authentication, entry validation, body representation, and commit behaviour all change. §2.1 replaces the percentage with a per-symbol ledger.

### What changes, in one table

| Basalt | Telimus | Why |
|---|---|---|
| Sealed paths, sealed chunks, HMAC entry authenticator | Plaintext NFC paths, chunks named by SHA-256 of raw bytes | The server is trusted and needs to read notes for MCP and search. |
| Root secret, recovery key, wrapped data key, rotation | None. Admin access is shell access to the data directory. | No keys to recover. Losing every device means running `telimus invite` on the server. |
| Device secret with HKDF-derived auth token | Random 32-byte device token, server stores its SHA-256 | Same devices table, one derivation removed. |
| Registrar session type, claim, bootstrap token file | Gone. Two hello routes: device session and invite redemption. | Nothing needs privilege separation from a root the devices must not hold. |
| Invite carries a sealed data key | Invite is a single-use 128-bit token in a `telimus1i_` string | Same QR flow in the plugin. |
| Per-chunk deflate inside the ciphertext, codec pinned by a golden table | Deflate is a wire encoding with a marker byte. Names are over raw bytes, so the codec can never change identities. | Removes the cross-runtime byte-equality requirement and `compression-golden`. |
| MCP is a separately paired TypeScript CLI on a plaintext directory | MCP is in the server, reading and appending versions in the store | One container instead of two; no second vault copy, no filesystem lock dance, no before-image files. |
| Before-image sibling files for every agent edit | The displaced version, **pinned by reference** at the time of the operation | History is the copy only if purge cannot reclaim it. An age cutoff does not achieve this; see §4.5. |
| TypeScript headless CLI, unpublished | TypeScript headless CLI, **published and in the test gate** | It is the supported headless peer, so it is production code, not a harness. |
| MCP batch stops at the first error | A distinct all-or-nothing `CommitOperation`; device `putmany` keeps partial success | Two callers with genuinely different needs; see §4.3. |

### Scope and refusals

Carried from Basalt unchanged: one person's devices, one vault per server process, local storage on the server, Obsidian on macOS, Linux, and Android as the supported platforms, no network filesystems, no second sync tool on the same local vault, no Obsidian configuration sync, no teams, no web UI.

New refusals: no per-note read access control on the MCP endpoint (a token reads the whole vault, and this is stated to the user as intentional exposure to the agent and its model provider), no OAuth (static bearer, Tailscale in front), no whole-file `write_note` tool in the first release (§4.4), **no second sync engine** (§2.6).

Changed from Basalt (decided 2026-09-22): Windows and iOS are **not refused**. A plugin listed in the community directory installs on both, so the plugin pairs there and says plainly, in the panel and for as long as it runs, that Windows is unsupported and iOS is untested. The safeguards that makes necessary are in §4.12.

Deferred, with the reason written down rather than left implicit: a Go sync engine and `serve --vault-dir` (§2.6), `import-basalt` history migration (§2.8), per-token path scoping (§2.3).

## 2. Decisions

These are made, with reasons. Change them deliberately.

### 2.1 Fork and strip, do not rewrite

Copy Basalt wholesale into the new repository, rename, get every existing test green, then remove encryption in small commits that keep the suites green. The alternative, building fresh and importing pieces, discards the 536 Go tests and 56 core test files that are the actual value. Milestone 0 is the copy; milestones 1 and 2 are the strip.

**Deleting a test file is a decision, not cleanup.** The reuse map's instruction to delete `keys_test.go`, `auth_test.go`, and `invite_test.go` wholesale would discard invariants that have nothing to do with encryption: `keys_test.go` alone carries invite redemption rollback (`basalt:server/internal/store/keys_test.go:530`) and a revoke-race case (`:557`). Before deleting any test file, list its assertions and classify each as *obsolete with the crypto* or *still a guarantee*. Rewrite the setup for the second kind and keep the assertion. Record the ledger in `docs/development.md`.

The same rule applies to the TypeScript MCP suite. Its semantic fixtures are the only oracle for whether the Go port behaves like the thing that worked; keep `client/src/cli/mcp-*.test.ts` and its vectors until the Go replacements pass against them. Do not erase the oracle in M2 and rebuild it from memory in M5.

### 2.2 Chunks stay; names are over raw bytes; compression is wire-only

Content-defined chunking earns its place without encryption: an edit costs one chunk plus a name list, moves cost nothing, downloads reuse local chunks, `resend` repairs lost bodies, and large attachments stream in bounded memory. Basalt's own measurements (`basalt:docs/research.md`, "Whole-vault sync") justify it.

Chunk name = lowercase hex SHA-256 of the raw chunk bytes. The server stores raw bytes and can recompute every name from what it holds, which Basalt's evaluated-alternatives table lists as the thing the keyed design lost. On the wire each body frame is `marker || payload`, marker `0` raw or `1` raw deflate; the receiver inflates, hashes, and refuses a mismatch. Either side may send raw. Codec output never affects identity, so Go's `compress/flate` and the plugin's `fflate` need not agree byte for byte, and `compression-golden` is deleted.

Consequence for the server: declared `size` must equal the sum of raw chunk lengths, checked at commit. That is a stronger invariant than Basalt's ciphertext budget and replaces it.

Implement the check cheaply. `chunks.Store.Size` is `Size(vaultID, name) (int64, bool)` (`basalt:server/internal/chunks/chunks.go:331`), one lookup per chunk. The naive form is a filesystem loop held inside `commitMu` across a batch of up to 256 entries, each with up to 65,536 chunks. Carry the raw length in the chunk metadata row and sum in SQL, one statement per entry, or verify only the chunks uploaded in this session and trust names already verified at store time. Whichever is chosen, write it down: this check runs on the hot path of every write.

**What raw-byte names give away, stated once.** A chunk name is the SHA-256 of plaintext, so anyone holding an exposed chunk inventory can confirm guessed content, and a `have`/`want` exchange is a presence oracle for guessed bytes. Against this server that is not a new exposure (the endpoints authenticate and a token's scope is already the whole vault), and HMAC names would reintroduce a naming secret without hiding anything from a server that reads the notes anyway. Keep raw SHA-256. The obligations that follow: chunk names never appear in logs, metrics labels, unauthenticated endpoints, or public backup manifests, and deduplication stays scoped to the vault. If narrower readers ever exist (a shared note, a second vault), revisit fetch authorisation before reusing this design.

### 2.3 Authentication: device tokens, invite tokens, MCP tokens

Three credentials, all random, all stored hashed:

| Credential | Made by | Stored | Used for |
|---|---|---|---|
| Device token (32 bytes) | The joining client, at redemption | `devices.auth_hash` | `hello` for a device session. Basalt's table and revoke flow, unchanged. |
| Invite token (16 bytes) | Server, on `telimus invite` or the wire `invite` op | `invites.token_hash`, expiry, label | One redemption. Carried in the `telimus1i_` string with server URL and vault id. |
| MCP token (32 bytes) | Server, on `telimus mcp-token` | `mcp_tokens.token_hash`, label, **scope**, **expires_at**, created, last used, used count | `Authorization: Bearer` on `/mcp`. Several may exist; each has a label that becomes the author name on its writes. |

MCP tokens default to **scope `read`**. Write access is explicit (`--scope write`), and the scope is enforced three times: at tool discovery, at dispatch, and again at the commit boundary against the credential as it stands *then* (§2.3.1). Omitting mutation tools from the tool list is presentation, not enforcement, and does nothing against a hand-written request. Tokens expire (90 days default) and carry a `used_count` alongside `last_used`, because `last_used` throttled to once a minute can miss a stolen token used once. The token's database identity is a generated collision-resistant id, not the first eight hex characters of its hash; eight hex characters are a display fingerprint.

Per-token budgets, not just a global cap: concurrency, sustained request and byte rates, parser and assembly deadlines, and a maximum operation cost. One agent looping on `search_notes` must receive 429 without starving another token or, more importantly, ordinary device sync. Rate-limit failed authentication separately.

The first device pairs from an invite printed by `serve` on first start with an empty store, and re-printable at any time with `telimus invite`. **Invites expire by default** (one hour) and bootstrap credentials go to an explicit private output path rather than to stdout, because a never-expiring invite in a container log is a durable vault credential. `--ttl 0` for a deliberate no-expiry invite is allowed and says so on the tin.

**Where the plugin keeps its device token** (decided 2026-09-22). In Obsidian's keychain, `app.secretStorage`, when the running app has it (1.11.4 and later), detected at runtime; in `data.json` on older apps. `minAppVersion` stays at 1.7.2, because raising it strands everyone on an older mobile app from updates (Pumice did this, `plan/research/pumice.md`). The keychain takes no vault parameter and may be shared by every vault on the device, so the secret id is scoped to both: `telimus-<vault>-<device>`, lowercased to the id alphabet the API accepts (lowercase alphanumeric and dashes). Migration writes the keychain, reads it back, and only then removes the `data.json` field (rules 3 and 4); a keychain that fails the read-back leaves the old field in place and says so. The point is that the token stops travelling with copies of `.obsidian` (backups, iCloud, git), so a copied vault cannot act as the device. Losing the keychain entry means re-pairing that device, which loses no note. The headless client keeps its 0600 config file.

`mcp:<id>` is not a valid device id. `ValidDeviceID` accepts base64url (`basalt:server/internal/store/store.go:2595`), which has no colon, so the claim that the devices table is reused unchanged is false. Either widen the validator deliberately, with its own test, or give author rows a separate `kind` column and keep device ids as they are. The second is preferable: it also stops the panel leaking the id shape, and it stops an agent appearing as an offline sync peer whose applied-checkpoint everyone waits on.

### 2.3.1 Administration goes through the running server, not around it

The earlier plan had `invite`, `devices`, `revoke`, and `mcp-token` writing SQLite directly while `serve` runs, coordinated by WAL, `busy_timeout`, and the `dirlock.Data` shared lock. **That does not work, and the failure is a revoked device that keeps receiving notes.**

A shared lock permits simultaneous holders; it does not join another process to `commitMu`, invalidate that process's in-memory authentication state, or close its sockets. Basalt says so directly (`basalt:server/internal/server/hub.go:85`) and serialises credential checks, mutations, and revocation under one process lock (`basalt:server/internal/server/authorization.go:12`). The data lock exists to exclude destructive maintenance (`basalt:server/internal/dirlock/dirlock.go:77`), not to order these operations. There is also a check-then-commit gap: SQLite serialises SQL writers, but not the application-level authorisation check that happened before the write.

So: **mutating administration goes through a private local control socket owned by `serve`**, using the same authorisation path and the same commit boundary as everything else. Direct database mutation is allowed only with the server stopped, under an exclusive lock. Read-only `stats`, `verify`, and `backup` keep their current access.

A successful revoke must mean all three of: no later authorised mutation from that credential can commit, no queued mutation from it completes, and no live subscription keeps delivering. Revoking an MCP token retires its author relationship in the same transaction, whichever interface initiated it.

### 2.4 The MCP server works on the store, not on files

Every tool call is a store operation. Reads assemble the head version's chunks. Writes chunk the new content, store missing bodies, and append an entry through the same `AppendCurrent(vault, entry, base, prevBase)` path a device `put` uses, inside the same `commitMu`, then broadcast through the same hub. The agent's `base` is a version UID, which is exactly the protocol's conditional-write precondition. Stale means another writer got there first; the tool reports the current UID and the agent re-reads.

This removes from the Basalt MCP: two vault instances, the kernel lock, the serial-queue admission, `writeReady`, the before-image sibling, the recovery sibling, and the `race` outcome. What remains is the tool vocabulary, the bounds, the exact-edit rules, the tag and link parsers, and preview-then-apply.

It does **not** remove the durable-versus-delivered distinction, and the earlier draft was wrong to collapse it. A commit is durable when the transaction commits (rule 1); it is *delivered* when a device applies it, which is a different fact on a different timeline. Basalt's hub deliberately skips peers that are failing and leaves them to catch-up (`basalt:server/internal/server/hub.go:50`), so "committed" never implied "every device has it". The tool result reports `committed` with the operation id and resulting UIDs; delivery is exposed separately through applied checkpoints, and an agent edit never blocks on a slow phone. See §4.8.

Author identity: each MCP token is also a device row with id `mcp:<token id>` and name from the token's label. Conflict copies read `Note (Conflicted copy Claude 202609171130).md`, history shows the author, and the devices panel lists the agent with its last-seen time. Revoking the token revokes the row.

### 2.5 Search is a derived view, maintained outside the write path

The server holds the text, so it indexes it. Two constraints shape how.

**Indexing must not be able to refuse a sync write.** The earlier draft maintained FTS5 and `note_tags` inside the commit transaction. That puts a new Markdown and YAML parser, and the search implementation, on the critical path of every device write: malformed frontmatter, an expensive note, or a slow FTS merge can then delay or reject the authoritative write. Derived state must never do that. Commit the version, commit a durable record that indexing is owed, and index asynchronously. The work source is the version log itself (a contiguous `indexed_through_uid`) or a small transactional pending-path table, not a best-effort hub notification, which is lost across a restart. A frontmatter parse error limits tag extraction for that note and is reported; it does not reject the entry.

This also removes a cost nobody had accounted for: indexing requires assembling the note from its chunks, so a transactional index makes a 256-entry batch do 256 assemblies inside `commitMu`. First upload of a whole vault would stall.

`vault_status` already reports `index: {fresh, indexedHead}`, which only means anything in an asynchronous design; the two halves of the earlier draft contradicted each other.

**Literal search must stay literal.** Basalt's `search_notes` is an escaped literal regular expression (`basalt:client/src/cli/mcp-read.ts:305`). FTS5 phrase matching is not the same function and quietly finds less: in SQLite 3.54.0, with `foobar` indexed, `MATCH '"oo"'` returns nothing while `instr(body,'oo') > 0` returns the row. Filtering FTS hits afterwards cannot recover matches the index never proposed. So: use an index only where it cannot omit a match, fall back to a bounded scan where it can, and report `complete: false` honestly when the budget binds. If token search is wanted, add it as a separate, clearly named mode. Contract fixtures cover one- and two-character queries, substrings inside words, punctuation, case, Unicode, and multiline.

Rebuild is generational: capture a head, build a new generation in bounded batches, replay changes since, verify, then switch. The previous index stays queryable with its own observed head while this runs. A corrupt index must be detectable independently of its schema version. A matching `index_version` on a silently truncated table is exactly the failure this catches.

Verify at milestone 0 that the pinned `modernc.org/sqlite` build has FTS5 compiled in (`SELECT fts5(?1)` or create a virtual table in a test). If it does not, the fallback is a `LIKE`-or-scan path over a `note_text` table with the same tool contract. Do not block the server on this.

### 2.6 There is no second sync engine

**The Go engine port is cut from this plan.** Both reviews reached this independently and the arguments compound.

The scope was understated. `engine.ts` is 5,519 lines, but a working Go peer also needs the transport (2,674), the Node filesystem adapter it would replace (3,445), merge (1,147), merge regions (276), and the index journal and state machinery. These are measured file lengths, not estimates. And because the TypeScript client and adapter are kept anyway (as the test harness, and as the thing that actually works), the port *adds* a production engine rather than replacing one. Every preservation fix then lands twice, in two languages, forever.

The accepted merge divergence was the tell. "Retained content, not agreement" is rule 10 warning against a weak assertion; it is not a merge specification. Basalt's own merge code explains that every inserted word can survive while the note's meaning is destroyed (`basalt:client/src/core/merge.ts:48`), and its region code explicitly refuses nondeterministic region computation (`basalt:client/src/core/merge-regions.ts:55`). Conditional writes pick an immediate winner; they do not establish eventual convergence, bounded conflict-copy growth, or that the loser preserved the right thing at the right path.

There is also a concrete hazard the plan had hand-waved. The Go client was to use `flock`, while the retained Node adapter uses an abstract socket on Linux (`basalt:client/src/cli/exclusion.ts:21`). **Those two mechanisms do not exclude each other.** Two implementations sharing an on-disk journal format, with mutual exclusion that does not actually mutually exclude, is a data-loss shape. Matching disk formats is not a lock.

Instead: **publish the stripped TypeScript headless client.** It exists, it is tested, and it speaks the ordinary authenticated protocol. A live folder on the server host is that client running as a sidecar with its own credential and its own exclusion lock: no in-process `Transport`, no `--vault-dir` mode, no second engine.

What this does not cut: the Go **chunker**, which MCP writes genuinely need. It belongs in `internal/notes` before the write tools, with its boundaries pinned against the TypeScript implementation (M0.5 task 6). Scheduling it in M7 while M5 depended on it was a milestone-ordering bug.

Reopening the port requires a measured reason: a runtime, packaging, or resource requirement someone has actually hit. If it returns, it returns with shared golden merge decisions, pinned algorithm settings, explicit UTF-16 handling, differential fuzzing, and a rule that unexplained disagreement keeps both versions.

### 2.7 The TypeScript side ships two artifacts

`client/` builds the Obsidian plugin and the headless client. `client/src/core` is the shared engine for both. `client/src/node` holds the Node adapter (`NodeVault`, `JsonIndexStore`, exclusion lock) and the published CLI.

The headless client is **production code**: it is in `scripts/check.sh`, in CI, in the stress matrix, and in the release process. The earlier plan marked it private and treated the adapter as a harness. That was only coherent while a Go client was going to replace it. The TypeScript MCP server is still deleted; that part moves to Go.

### 2.8 Migration from Basalt is a fresh pairing, rehearsed first

Basalt history cannot be read without a data key the server never had. Migration transfers current content; the Basalt history stays an encrypted archive, readable later with the archived recovery material and a compatible Basalt build. A `telimus import-basalt` is later work, not promised.

The mechanism is a fresh pairing. **The procedure around it is not "pair and compare counts."** Equal entry counts do not prove equal paths or equal bytes, a server backup cannot show that an unsynced local edit survived (`basalt:docs/security.md:103` says to back up readable local notes separately), and a phone carrying an older tree is a source of writes, not just a download target. Because the plugin id changes, both plugins can sit installed on the same vault at once, which is the one thing the scope refusals forbid.

So M10 becomes: rehearse the whole thing on a disposable copy, settle every device against Basalt first, disable the old writer per directory before enabling the new one, verify by comparing a normalised path/kind/size/SHA-256 inventory against a freshly paired empty witness device, and keep a rollback that can export post-cutover edits. Retirement is earned by a successful restore, not by thirty days elapsing. Details in M10.

**Storage identity, decided here because it constrains M1.** `PRAGMA user_version = 1` collides with Basalt's own schema version 1 (`basalt:server/internal/store/open.go:31`): a Telimus binary opened on a Basalt data directory would find a version it accepts. Every data directory therefore records a **product identifier**, a schema version, and a **store epoch**, all validated before any write. A Basalt directory, an unknown product, or a newer schema is refused with the input left byte-identical. An explicit restore starts a new epoch, and cursors and MCP version preconditions bind to the epoch. Otherwise a restored database that re-issues UIDs makes a stale precondition silently match the wrong version.

## 3. Architecture

### 3.1 Repository layout

```
telimus/
  go.mod                      module github.com/waynehoover/telimus
  cmd/telimus/                 main.go and one file per subcommand
  internal/wire/              message shapes, codes, limits            (from basalt server/internal/wire)
  internal/store/             SQLite metadata, history, purge, backup  (from server/internal/store)
  internal/chunks/            content-addressed bodies                 (from server/internal/chunks)
  internal/server/            WebSocket sessions, hub, delivery, HTTP  (from server/internal/server)
  internal/dirlock/           advisory data-dir locks                  (unchanged)
  internal/fsync/             directory fsync                          (unchanged)
  internal/frame/             chunk wire framing: marker + deflate     (new, small)
  internal/notes/             assemble, chunk, text detection, tags, links, exact edits  (new, Go)
  internal/search/            index worker, generations, tag index     (new, async; see §2.5)
  internal/mcp/               MCP handler, token auth, tools           (new, spec in plan/mcp-tools.md)
  internal/oplog/             operations, audit, retention pins, idempotency  (new; see §4.3, §4.5)
  internal/control/           private local admin socket               (new; see §2.3.1)
  client/                     TypeScript
    src/core/                 shared engine, both clients              (from basalt client/src/core)
    src/plugin/               Obsidian plugin                          (from client/src/plugin)
    src/node/                 Node adapter + published headless CLI    (from client/src/cli, trimmed)
    src/stress/               fault, crash, scale suites               (from client/src/stress)
    esbuild.config.mjs        plugin bundle and CLI bundle
  manifest.json  versions.json  styles.css
  docs/                       README-adjacent user docs, design.md, protocol.md, development.md
  scripts/check.sh            the full local gate with CI drift guard   (from basalt scripts/check.sh)
  Dockerfile  compose.yaml
  llm.md                      agent installation runbook
  PLAN.md  plan/              this plan; delete or move to docs/history once shipped
```

The Go module lives at the repository root so `go install github.com/waynehoover/telimus/cmd/telimus@latest` works and there is one binary to name.

### 3.2 Process model of `telimus serve`

```
                      ┌────────────────────────────────────────────┐
  Obsidian plugin ──ws──▶ /          Session ──┐                    │
  Go client       ──ws──▶ /                    │   commitMu         │
                      │                        ├──▶ Store.Append ──▶ SQLite (WAL)
  MCP client     ──http─▶ /mcp  Tools ──▶ CommitOperation  │            │
                      │            ▲                    ├──▶ chunks/  (raw bodies)
                      │            │                    ├──▶ oplog: audit, pins, idempotency
                      │        Bearer auth               └──▶ Hub.broadcast ──▶ live sessions
                      │                                            (best effort; catch-up is the
  telimus admin ──unix─▶ control socket ───────────────┘             durable path, §4.8)
                      │                                         │
                      └────────────────────────────────────────────┘
                       search worker ◀── indexed_through_uid ──┘   (async, §2.5)

  GET /health         unauthenticated, bounded reasons (unchanged)
```

One listener, one port, TLS terminated in front by Tailscale Serve or Caddy exactly as Basalt documents. The `/mcp` path is registered only with `--mcp`. With `--mcp` and no token rows, the server logs a hint and answers 401. The control socket is a unix socket inside the data directory, mode 0600, and is the only way to mutate credentials while the server runs (§2.3.1).

### 3.3 Store changes

Fresh project, fresh schema. **Not bare `PRAGMA user_version = 1`**. See §2.8. The directory records a product identifier, a schema version, and a store epoch, all checked before any write, so that a Basalt or unknown directory is refused rather than adopted. `migrate()` shrinks to "create if not exists", but keep the upgrade discipline: a fresh first schema does not mean the second one arrives untested.

Removed: `vaults.auth_hash`, `vaults.wrapped`, `vaults.rotations`, `entries.mac`, `entries.parent`, table `invites` in its sealed form.

Changed: `entries.path` and `entries.prev_path` are plaintext NFC UTF-8, `MaxPathLen` 1024 bytes, validated on the server (rules in [plan/protocol.md](plan/protocol.md#paths)). `Entry.Validate` additionally requires `size == Σ chunk lengths` at commit, which needs chunk sizes; `chunks.Store.Size(name)` exists.

Added:

```sql
store_identity (product TEXT, schema_version INTEGER, epoch TEXT)   -- §2.8; checked before any write

invites     (vault_id, token_hash TEXT PK, label, created_at, expires_at INTEGER NULL, used_at INTEGER NULL)
mcp_tokens  (vault_id, id TEXT PK, token_hash, label, scope TEXT, created_at,
             expires_at INTEGER NULL, last_used, used_count INTEGER)

operations  (id TEXT PK, vault_id, actor_id, actor_label, tool, request_digest,
             committed_at INTEGER, outcome TEXT, epoch TEXT)        -- server clock, not client mtime
op_entries  (op_id, path, before_uid INTEGER NULL, after_uid INTEGER NULL)
op_pins     (op_id, uid, expires_at INTEGER)                        -- purge survivor set; §4.5
op_keys     (actor_id, idempotency_key, op_id, expires_at)          -- PK (actor_id, key); §4.8

note_text   (vault_id, path, uid, body)   -- FTS5 virtual table, per index generation
note_tags   (vault_id, path, tag, source) -- source: frontmatter | inline
index_state (generation INTEGER, indexed_through_uid INTEGER, failures INTEGER, skipped INTEGER)
```

`devices` keeps its shape and its `ValidDeviceID` rule. MCP author rows do **not** squat on `device_id` with an `mcp:` prefix, because a colon is not valid base64url (§2.3). Give author rows their own `kind` column, or their own table joined for display.

`operations.committed_at` is server clock at commit. Entries carry client-supplied `ctime`/`mtime` only (`basalt:server/internal/store/store.go:410`) and there is no server commit timestamp on a version row, which is exactly why retention cannot be computed from entry timestamps (§4.5).

### 3.4 Protocol

Version 1 of a new wire protocol, derived from Basalt's protocol 7 by deletion. The full draft is [plan/protocol.md](plan/protocol.md). Summary of the diff: `hello` loses `crypto`, `claim`, `wrapped`, `token`-as-registrar; `ready` loses `wrapped`; entries lose `mac` and `parent`; `put` keeps `base`/`prevBase`/`stale`; body frames gain the one-byte marker; `register`, `rotate`, and the registrar session are gone; `invite` returns a token instead of accepting a sealed key; the error table loses `rotated` and gains `badpath`.

### 3.5 Deployment

```yaml
services:
  telimus:
    image: ghcr.io/waynehoover/telimus:X.Y.Z@sha256:…
    ports: ["127.0.0.1:3003:3003"]
    volumes: ["./telimus/data:/data"]
    command: ["serve", "-addr", "0.0.0.0:3003", "--mcp"]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    stop_grace_period: 30s
```

Tailscale Serve maps `https://homelab.tail….ts.net:3003` to `127.0.0.1:3003`; the MCP client URL is that origin plus `/mcp`. The homelab's current `basalt` and `basalt-mcp` services (`~/code/homelab/docker-compose.yml:528-620`) collapse into this one. `telimus mcp-token --label "Claude on Mac" --key-out FILE` replaces `basalt mcp-token`.

### 3.6 Threat model, stated plainly

The server is trusted with everything. That is the decision, and it is the right one for this product. What follows is what it actually costs, because the earlier draft understated it in a parenthetical.

**The readable surface is larger than "the notes".** It is current notes, every deleted version still in history, chunks from abandoned uploads, every filename, search terms, tags, and audit context. And it is not only the files you meant: the SQLite WAL, the search database, temporary files, backup staging directories, filesystem snapshots, crash dumps, and any copied volume.

**Requirements, not advice:**

- The data volume sits on encrypted storage (LUKS, FileVault, ZFS native). Document where the key lives and how an unattended restart unlocks it.
- Backups are encrypted, **including backups that stay on the same box**. `telimus backup` refuses to write outside the data directory without `--plaintext-ok`, or takes `--encrypt-to <age recipient>`. A backup on the homelab is still a backup another process can read.
- The restore rehearsal (M5.5) exercises the encrypted path, not a plaintext shortcut.
- Chunk names and paths are sensitive metadata: not in metrics labels, not on unauthenticated endpoints, not in public manifests.

**What encryption at rest does not buy.** Nothing against a compromised running host, nothing against an agent holding a valid token, nothing against a model provider receiving tool results, and nothing when a logical snapshot is exported from an already-unlocked filesystem. Tailscale does not change any of this. If protecting against a live server compromise ever becomes a requirement, the decision to drop end-to-end encryption has to be reopened; no amount of at-rest work substitutes.

**One property lost that is easy to miss.** Removing the HMAC entry authenticator removes a device's ability to distinguish a note the vault owner wrote from a note a compromised server manufactured. SHA-256 chunk names give consistency, not writer authenticity. Devices now trust the server's word about authorship.

TLS is still required: device tokens and note contents cross the network. The MCP bearer is the only thing between the tailnet and the vault; keep `/mcp` behind Tailscale or an identity-aware proxy, as Basalt's `docs/security.md` already says for its HTTP MCP. A token's read scope is the whole vault, and the user is told so in `docs/agent.md` as intentional exposure to the agent and its model provider.

What is gained: the server can verify every chunk name and every declared size from the bytes it holds, can rebuild the search index from history, and can serve history to an agent without a paired copy.

## 4. Design details worth settling before code

### 4.1 Path policy on the server

Plaintext paths make the server the last line of defence against a bad client. Refuse at `put`: empty, longer than 1024 bytes, invalid UTF-8, not NFC, control characters, a leading or trailing `/`, an empty segment, `.` or `..` segments, any segment starting with `.` (this covers `.obsidian`, `.trash`, `.telimus` state folders, and conflicts with the plugin's `isNeverSynced` rule), and the names the adapters reserve for staging (`.telimus-tmp-` prefix). Return `badpath`. The engine keeps validating inbound paths too (`refusedName` in `engine.ts`); two checks are cheaper than one recovery.

**The server's keyspace is Obsidian's** (decided 2026-09-22). Two further rules, because an MCP write has no filesystem to stop it and the two production clients disagreed:

- Refuse, with `badpath`, any path that Obsidian's `normalizePath` would change. Beyond non-NFC, that is U+00A0 and U+202F anywhere: `normalizePath` turns them into ordinary spaces (`client/src/plugin/vault.ts:15-38`), so the plugin can never send them, and until now the Node client did. `NodeVault` gets the plugin's mapping (`ObsidianVault.actualName`): the engine sees the normalized path, reads and writes land on the file's real name, and both clients produce one server path for one file.
- Refuse, with a new `collision` code, a create or the destination of a move whose folded key equals the folded key of a different live path. A rename whose source and destination differ only by case is the same note and is allowed. Deleted paths do not collide. Directory prefixes count: `notes/b.md` beside a live `Notes/a.md` is refused too, because a case-folding disk holds the two folders as one. A folder rename that changes only case arrives as a batch of moves, so the prefix check is evaluated against the batch's resulting state, not move by move. The fold is pinned in `protocol-fixtures.json` (NFC, then a named Unicode case-folding table, simple or full, decided in M0.5) with vectors for U+0130, `ß` and final sigma, and Go and TypeScript both consume them: Go and JavaScript lower-case U+0130 differently, so neither runtime's lower-casing is the specification. `foldPath` in `client/src/core/paths.ts` becomes that fold.

The cost, accepted: two notes differing only by case can no longer both exist, even on a Linux-only setup. The second is refused with its reason, visible under §4.9, rather than accepted and later broken on macOS and Android.

### 4.2 Text versus attachment on the server

The server needs the plugin's `looksLikeText` extension list (`basalt:client/src/core/chunk.ts:506-528`) to decide what to index and what MCP may edit. Port it to `internal/notes` and pin both lists with a fixture (`protocol-fixtures.json` already carries shared constants; add the extension list to it and test both sides read the same file).

### 4.3 An MCP write is a durable operation, not a put with a different caller

The earlier draft made an MCP write "the existing `put` path with the session replaced by a tool context", and made atomic batches "a flag on `AppendMany`". Both are wrong, and for the same reason: `AppendMany` is *deliberately* partial. It skips invalid entries before opening the transaction, rolls individual stale entries back to savepoints and commits the rest (`basalt:server/internal/store/store.go:759`, `:829`), and the session layer falls back to individual commits after a batch failure (`basalt:server/internal/server/session.go:1664`). `TestAppendManyRefusesOneEntryAndCommitsTheRest` exists to hold that behaviour. It is correct for a device catching up and wrong for an agent's four-file refactor.

So there are two APIs. Devices keep `putmany` with per-entry answers, untouched. MCP gets **`CommitOperation`**: all-or-nothing, no individual-write fallback.

An operation carries an authenticated actor, an idempotency key, validated preconditions, and a durable result.

1. Authenticate the bearer; resolve actor and scope.
2. Validate inputs against the tool schema; validate every path; refuse non-text formats and `.excalidraw.md` for edits. **Editability is its own policy** (`.md` and `.txt`), and is not `looksLikeText`, which is a chunking efficiency guess covering source, XML, SVG and YAML (`basalt:client/src/core/chunk.ts:499`). Keep the two lists separate and pin both in fixtures.
3. Prepare outside the write lock: assemble heads, compute new bytes, chunk, and store bodies through `chunks.Writer` + `Close()` (fsync) so bodies are durable before any entry references them.
4. Under the commit boundary, **recheck** credential, scope, store epoch, every source and destination base, and any preview snapshot dependency. A credential revoked since step 1 must lose here (§2.3.1).
5. In one transaction: entries, `operations` row, `op_entries`, `op_pins` for every displaced version (§4.5), and the recorded result. Bound and precompute the reply before committing, so a reply that is too large is not discovered after the write.
6. Broadcast through the hub, best effort. Catch-up is what makes delivery durable (§4.8).
7. Return `{committed: true, opId, entries: [{path, uid, previousUid}]}`.

Identical bytes are a `noop`, but the noop revalidates its preconditions at the same boundary. A noop decided against a head that moved during computation is not sound. `previousUid` is `null` for a genuine create, and a tombstone is distinguishable from readable content: creates, folders, deletions, and empty files each say what they are in the result schema rather than sharing one shape.

**Preview-then-apply needs more than matching bases.** Re-deriving the plan and comparing output paths does not protect what the preview *read*. Between preview and apply, a device can add a backlink in a third note, or create a filename that changes which note a short wiki-link resolves to. No planned output path changed, so every base still matches, and the preview's claim about affected links is now false. Moving the computation server-side removes filesystem races, not this one. For v1, bind each preview to a vault snapshot head and require it unchanged at commit: conservative, occasionally refusing work that would have been fine, and honest. A read-set and namespace-revision scheme can narrow it later.

### 4.4 Settled: no whole-file writer in v1

v1 is create, exact edits, append, prepend. This is now a decision, not a question.

Basalt's original reason does weaken here: with mandatory `base` and durable history, a whole-file write cannot lose a committed concurrent edit. The reasons that survive are different and better. A whole-file write makes the agent re-emit the entire note, which silently normalises frontmatter order, trailing whitespace and list markers it never intended to touch, and it produces a diff no human can review. Server history does not fix either, and neither is fixed while retention and undo are still being built (§4.5).

Be honest about the converse too: exact edits are not a semantic safety boundary. An agent can pass a whole small note as one unique `old` string, delete the prose that mattered, or append something harmful. A mandatory base protects against committed concurrent changes; it cannot see a phone's unsynced work and cannot prove meaning was preserved. The protection is retention, audit, and undo, not the shape of the edit tool.

If real use shows the need, add an explicitly enabled `replace_note` with a full-read base, a diff preview, size bounds, an audit record, a pinned before-image, and conditional undo. Measure tool usage before adding it rather than reasoning about it again. A structural `replace_section(path, base, heading, body)` on goldmark's AST is the better first move if the pressure turns out to be "rewrite one section", which is usually what it is.

### 4.5 Retention is by reference, pinned at the operation, not by age

`Purge` keeps per-path heads and the rename chain. After an MCP edit, the displaced version is the only copy of what the note said before the agent touched it.

**The `-keep-since 30d` proposal does not do the job, and this was checked.** Take a note last edited a year ago and let an agent edit it today. Its previous version is now neither a head nor newer than a 30-day cutoff, so purge can delete the only before-image immediately, the same day the agent wrote. Running Basalt's actual `purgeSurvivorUIDs` query (`basalt:server/internal/store/conditional.go:23`) against a two-version fixture with the age predicate added leaves only today's UID; `previousUid` does not survive. Worse, there is no server commit timestamp on a version row to compute age from: entries carry client-supplied `ctime` and `mtime` (`basalt:server/internal/store/store.go:410`), which a wrong device clock can set to anything.

The grace period must start when a version is **displaced**, not when its content was written. So:

- Every MCP operation writes `op_pins` rows in its own transaction, pinning each displaced version until at least 30 days after `operations.committed_at` (server clock).
- Purge's survivor set is heads, required rename records, **and unexpired pins**. Its preview uses the same survivor calculation as its execution. Chunk reclamation considers every surviving reference.
- Backup carries operations, pins, and audit rows; restore validates them.
- Three retention policies, kept separate and separately configurable: ordinary history, operation results (§4.8), and before-image pins. Define what happens when a pin expires; keeping everything forever is not required.
- `purge --dry-run`, and a test that default purge never reclaims a version pinned inside the window.

**Undo ships with agent writes, in M5.** It is a compensating operation, not a rollback: it appends a new version, and only if every affected head still equals that operation's outputs. If a person has edited since, it refuses or offers restore-to-a-copy, never a blind overwrite. A move, or a backlink or tag batch, undoes as a unit or refuses as a unit.

The plugin's history panel does not already provide this. It restores *without* replacing existing content by design (`basalt:client/src/plugin/history.ts:39`), which is a different operation; the earlier claim that the existing panel covers undo was wrong.

### 4.6 Conflict copies and the agent

An agent edit that lands while a phone is offline is an ordinary remote version to that phone. On reconnect the phone's engine merges or keeps both, exactly as it does for a second laptop today. No new machinery; the stress suite's phone-race cases (`basalt:client/src/stress/mcp.stress.ts:380-507`) are re-targeted at the server MCP in milestone 5.

### 4.7 Live folder on the server is a sidecar, not a mode

The server host gets a plaintext folder by running the published headless client against `127.0.0.1`, with its own device credential and its own exclusion lock on that directory. Other tools (grep, Quartz, rsync backups, a different agent framework) read it; edits made in it sync back. No in-process `Transport`, no `--vault-dir` flag, no second engine (§2.6).

The exclusion lock does not protect a containerised sidecar: on Linux it is an abstract socket, which is per network namespace (`basalt:f2cee53`), so two containers sharing one vault volume both acquire it. Run one headless client per folder, and when running in containers add a `flock` on a file inside the vault's state directory as a second guard.

A later `serve --export-dir DIR` that writes head versions one-way, with no credential and no upload path, is listed in `plan/ideas.md`. It is genuinely small, and it is not needed for v1.

### 4.8 Committed, delivered, and known are three different facts

Keep them apart in the tool contract, because collapsing them produces wrong answers in exactly the cases that matter.

**Committed ≠ delivered.** The hub skips peers that are failing and leaves them to catch up (`basalt:server/internal/server/hub.go:50`). A queue insertion is not a phone applying a note. The result reports `committed` with `opId` and UIDs; delivery is a separate question answered by applied checkpoints and `delivery_status`. An agent edit never waits on a slow device, and catch-up recovers any commit that was never broadcast.

**Committed ≠ known to the caller.** The M5 crash matrix kills the server after append and before the reply, deliberately. The database then has a definite outcome and the agent has none. A reply that exceeds the size cap after a successful commit has the same shape, and must not be reported as an ordinary failed mutation.

The fix is request idempotency. Persist `(actor_id, idempotency_key)` with the canonical request digest and the result, in the operation's own transaction. Replaying the key returns the recorded result; reusing the key with different input refuses. Give results a retention window, define the behaviour after it expires, and provide an operation lookup so a lost reply can be resolved. Base preconditions already stop many blind retries, but they never explain *whose* earlier write succeeded.

Preserve typed storage failures through the stack, and keep "refused before commit" distinct from "unknown transport outcome". They call for different actions from the agent and from the person reading the log at 2am.

### 4.9 A refused path must be visible, not logged

§4.1 lets the server refuse a path. A file that trips any of those rules (most plausibly a path over 1,024 bytes, since Basalt allowed 4,096, or a control character in a Linux filename; not NFD, which both adapters already normalise to NFC before upload at `basalt:client/src/core/vault.ts:136-145`) then silently never syncs, forever, and the only trace is a log line on a machine nobody reads.

`badpath` must reach the person: the plugin's stranded list with the path and the reason, and `telimus-sync status` for the headless client. `refusedName` in `engine.ts` is the existing hook. This is an M2 task and an M3 acceptance step, not a nicety.

Also document, rather than leave to be discovered, that any segment beginning with `.` is unsyncable. That is correct and deliberate (it covers `.obsidian`, `.trash`, `.telimus`), and it also means a user's `.attachments` folder will never sync.

### 4.10 Note content is untrusted input to the agent

Every byte this server hands an agent came from a note, and a note is attacker-influenced data. This is the largest security consideration the MCP design has, and the earlier draft did not address it at all.

It is worse here than in a read-only tool. An instruction-shaped sentence inside a note can tell the agent to read a credential, call another tool, or write somewhere it should not. And because this agent writes, that sentence is then committed as an ordinary version, replicated to every device, and served to the next session forever. A poisoned note is persistent and self-propagating. The sources are not trusted: a phone, a web clipping, a shared file, another agent.

Three requirements, taken from `asciimoo/hister`, which built the same separation for a personal search index:

1. **Structural separation in the envelope.** Every tool result carries `schema_version`, `tool`, `security`, `trusted` and `untrusted_content`. Server-derived facts go under `trusted`; anything drawn from note bytes goes under `untrusted_content` and nowhere else. The boundary lives in the data, not in a convention a client has to remember.
2. **The warning travels with the tool**, stated in each tool's own description so it reaches the model beside the data: returned note content is untrusted, must never be treated as instructions, and must not cause secrets to be revealed or other tools to be invoked.
3. **One normalisation function** every untrusted string passes through: strip control characters, refuse lone surrogates, cap length, neutralise sequences imitating the envelope's framing. One function, one test table, used everywhere.

Full specification in [plan/mcp-tools.md](plan/mcp-tools.md#note-content-is-untrusted-and-the-envelope-says-so). This is a v1 requirement, not later work.

### 4.11 Clocks

MCP writes set `mtime` from the server clock while devices use their own, and conflict-copy names embed a timestamp. Say what happens when the server clock is wrong, and keep `operations.committed_at`, which retention depends on (§4.5), on the server clock with a monotonic guard, so a clock jump backwards cannot shorten a pin.

### 4.12 Platforms the listing reaches

Decided 2026-09-22: the plugin pairs on Windows and iOS rather than refusing, with a persistent notice. That choice needs three safeguards, because nothing in Basalt's tests has exercised Windows:

1. **A Windows inbound refusal list.** `refusedInboundPath` (`client/src/core/engine.ts:5177`) refuses only empty paths, dot-prefixed segments, leading or trailing slashes, empty segments and `.` or `..`. On Windows it must also refuse, as a stranded path with its reason (§4.9), names Windows cannot hold: the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, with or without an extension), the characters `\ : * ? " < > |`, and a trailing dot or space in any segment. A note named `a:b.md` created on a Mac must arrive on Windows as a visible refusal, never as a write error retried forever. Case collisions need nothing extra: §4.1 already refuses them at the server.
2. **The notice is not a toast.** A panel row and a status-bar state for as long as the plugin runs on either platform, naming what is untested, with a link to the support table in the README.
3. **Evidence before a support claim.** The platform probe (`plan/research/README.md` §1) runs on Windows and iOS and its report is kept; moving either platform to supported needs the M3 acceptance steps on a real device. iOS runs the same mobile adapter as Android, which is why it is "untested" and Windows is "unsupported".

## 5. Milestones

Sizes: S is a session, M is a few, L is a week of agent work with review in between, XL is a project. Lanes name what can run in parallel.

### M0. Bootstrap (S, sequential)

Goal: a repository where every Basalt test passes under the new name, still encrypted.

Tasks:

- Copy `basalt/server` to the repo root as the Go module, `basalt/client` to `client/` (including `client/styles.css`), `manifest.json`, `versions.json`, `scripts/`, `Dockerfile`, `compose.yaml`, `llm.md`, `llms.txt`, `protocol-fixtures.json`, `.github/workflows`, `LICENSE`, `.prettierrc`, `.prettierignore`, `.gitignore`, and all of `docs/`. Exclude only `tmp/` and `release/`. `docs/findings.md`, `docs/documentation-review.md` and `docs/reviews/` are Basalt history but are copied verbatim, because the review IDs they define are cited hundreds of times in the code (`plan/research/basalt-lessons.md` §3); `docs/index-journal.md` has no history sections and is copied whole.
- Rename the module to `github.com/waynehoover/telimus`, `basaltd` to `telimus`, `BASALT_DATA` to `TELIMUS_DATA`, the `.basalt` state directory to `.telimus`, `.basalt-tmp-` staging marks to `.telimus-tmp-`, the plugin id to `telimus-sync`, the `obsidian://basalt-sync` protocol action to `obsidian://telimus`, the systemd unit name, the Docker image name, the npm package name (unpublished). Keep `basalt3i_`/`basalt3_` prefixes for now; they die in M2.
- Write `CLAUDE.md`: the layout table above, the durability rules by reference, "do not lose a note", the `scripts/check.sh` gate, and the rule that every write to a live Obsidian vault goes through the `obsidian` CLI.
- Copy `docs/design.md` and keep the eleven rules with their numbers. Remove the key, credential, and threat-model sections; they are rewritten in M9.
- Verify FTS5 in the pinned `modernc.org/sqlite` with a one-line test; record the result in `docs/development.md`.
- **Measure the inventory.** Record the Basalt commit, per-file line counts, and the test-assertion ledger from §2.1 (which assertions are obsolete with the crypto, which are still guarantees). This replaces the reuse percentages, which did not survive checking.
- Run `go test -race ./...`, `bun run test`, `bun run stress`, `bun run build`, `scripts/check.sh`. All green under the new name.

Done when: `scripts/check.sh` exits 0 and the built plugin loads in a scratch vault against `telimus serve`.

**Status: done, 2026-09-22.** `scripts/check.sh` passed 32 of 32 on the final tree, and the built plugin loaded in a brand-new vault on Obsidian 1.13.7, claimed a fresh `telimus serve`, and synced notes both ways with a headless client (`docs/development.md`, "The fork from Basalt").

### M0.5. Contract slice (M, sequential gate)

Goal: one Go server and one TypeScript client agree on the new protocol **before** the work splits into lanes. This milestone exists because the previous plan's freeze-then-fork was not safe: the protocol draft is both incomplete and self-contradictory, and the contradictions are only findable by building.

What was already found in the draft, as evidence that a document freeze is not a contract:

- Redemption sends `auth` in PLAN and `token` in `plan/protocol.md:35`.
- The invite string leaves `len(url)`, `len(vault)`, CRC byte order, checksum coverage, and canonical base64 rules unspecified.
- Transport decodes frames before hashing, and `assemble` is *also* told to decode frames. The layer boundary must say whether bytes crossing it are framed or raw.
- M1 said `handleResend` encodes outgoing bodies. It does not: `handleResend` receives repair *uploads* through `readBodies` (`basalt:server/internal/server/session.go:2161`, esp. `:2209`). That port instruction was simply wrong.
- `size + 64` per entry is not an exact wire-memory budget for an entry with many chunk frames; raw bytes, encoded frames, control messages, and the aggregate request each need their own limit, including the marker byte at maximum chunk size.
- "Where silent, protocol 7 applies" is not a specification. Enumerate the inherited operations and their differences.

Tasks:

1. Define the invite byte layout completely, with good and bad vectors for base64, lengths, CRC, expiry, and single-use redemption. The joining device generates and persists its credential *before* sending redemption; test a redemption that commits but whose reply is lost, and make the retry either recover the paired device or return an explicitly recoverable result. Settle the three conflicts the strip ledger found before writing vectors: persisting the device credential before redemption against the six tests asserting nothing is saved after a refusal; the lost-reply retry against "an existing device id is refused"; and the last-device rule, on which `plan/protocol.md:123` (drops `allowLast`) and PLAN disagree.
2. Put framing at the transport boundary; its consumers receive verified raw chunks. Test empty bodies, raw payloads whose first byte is `0` or `1`, maximum sizes including marker overhead, truncated deflate, unknown markers, and inflation beyond the raw limit. Repair uploads follow the same rule.
3. Share path and format-policy fixtures, and keep the five policies distinct: syncable path, text chunking, search eligibility, MCP readability, MCP editability. Cover NFC, astral characters, byte-versus-character limits, staging substrings, case collisions, and file-versus-directory collisions.
4. Write exchange transcripts for the inherited operations: `have`, `want`, mixed-success device batches, stale rename source and destination, reconnect continuity, repair, applied receipts.
5. Port the Go text chunker into `internal/notes` and prove its boundaries against the TypeScript implementation *before* MCP uses it (§2.6). Compression output may differ across runtimes; decoded bytes, chunk names, and size checks may not.
6. Both implementations consume each other's fixtures. Generating your own vectors and passing your own tests proves nothing.

Done when: a TypeScript client pairs, uploads raw and deflated notes, fetches them through Go, repairs a missing body, renames, races a conditional write, and reconnects without losing stream continuity. Fixtures run in both language suites, and a deliberately corrupted vector fails on the consuming side.

### M1. Server: plaintext protocol 1 (L, lane A, after M0.5)

Goal: `telimus serve` speaks [plan/protocol.md](plan/protocol.md). Go tests green, and the M0.5 slice keeps passing continuously. M1 is no longer validated Go-only, because a real TypeScript counterparty exists from M0.5 onward.

Tasks, in order:

1. **wire.go.** `Proto = MinProto = 1`. Delete `Crypto`, `Claim`, `Wrapped`, `Auth`, `Sealed`, `TTLMs` on hello, `Registrar`, `Registered`, `Redeemed.Sealed`, `Rotated`, `Invited.Sealed`, `CodeRotated`. Delete `Mac`, `Parent` from `PutEntry`/entry replies. Add `CodeBadPath`. `Invited` returns `token`. `hello` for redemption carries `invite`, `deviceId`, `auth`, `device`. Update `wire_test.go`, `ceilings_test.go`. Start: `basalt:server/internal/wire/wire.go:27-246`.
2. **store schema.** New `schema` string per §3.3. Delete `MaxWrappedLen`, `MaxSealedLen`, `MaxInviteLen`, `ErrRotated`, `AuthHash`, `ValidWrapped/Sealed/Invite`, `Wrapped`, `VaultKeys`, `Rotations`, `ClaimVault`, `Rotate`, the invite functions in their sealed form, the `vaultHash` parameters on `RegisterDevice`/`RevokeDevice`. Rewrite invites as `CreateInvite(vault, label, expiresAt) (token, error)`, `RedeemInvite(vault, token, deviceID, authHash, name)` atomic, `Invites`, `CancelInvite`. Add `McpTokens` CRUD. Start: `basalt:server/internal/store/store.go:104-116, 179, 213, 306-468, 2572-3474`.
3. **path validation.** `Entry.Validate` enforces §4.1; `MaxPathLen = 1024`. Add `path_test.go` cases for every refusal. Delete `Mac`/`Parent` from `Entry`, `verifyEntries` (`nomac`, `badparent`), `sameVersion` in `main.go`.
4. **size invariant.** Replace `CiphertextBudget`/`chunksAccountedFor` with `sizeAccountedFor`: `Σ chunks.Size(name) == size` at commit. `ChunkOverheadMax` goes to 0 and then away. Update `budget_test.go`.
5. **frame package.** `internal/frame`: `Encode(raw) []byte` (marker 1 if deflate level 6 is smaller, else marker 0), `Decode(frame, maxRaw) ([]byte, error)`. Bounded inflate; refuse unknown markers. Golden tests for shape, not bytes.
6. **session upload/download.** `readBodies` decodes each frame, hashes the raw bytes, matches the name, stores raw; the per-connection `allowance` counts raw bytes. `handleFetch` encodes each body before sending. `handleResend` likewise. Start: `basalt:server/internal/server/session.go:1848-1912, 2274-2371`.
7. **session hello.** Delete `helloAsRegistrar`, `handleRotate`, `handleRegister`, `handleInvite`'s sealed form, `handleUninvite` registrar branch, the `registrar`/`wrapped`/`bootstrap`/`authHash` fields, `Credentials`/`Grant`/`Authenticator`/`DerivedAuth`/`MinClaimLength`. `helloAsDevice` drops `VaultKeys`; refuse `device_id` with the `mcp:` prefix. `helloAsInvite` redeems the token. `authorizedMutation` loses its registrar branch. Start: `session.go:798-1258, 2421-2913`, `server.go:136-179, 694-799`, `authorization.go`.
8. **storage identity.** `store_identity` per §2.8: product, schema version, epoch, validated before any write. A Basalt directory, an unknown product, or a newer schema is refused and the input left byte-identical. An explicit restore mints a new epoch; cursors and MCP preconditions bind to it.
9. **admin via the control socket.** `internal/control`: a unix socket in the data directory, mode 0600, served by `serve`, carrying `invite`, `devices`, `revoke`, `mcp-token`. The CLI subcommands talk to it when a server is running and open the store directly only under an exclusive lock when one is not (§2.3.1). Read-only `stats`, `verify`, `backup` keep direct shared access. Delete `loadOrCreateToken`, `printSetup`, `copyToken`, the `auth-token` file. `serve` on an empty store mints one invite, default one-hour TTL, written to an explicit private path rather than stdout.
10. **escape hatch.** `telimus cat --path P [--uid N]` and `telimus export --uid N --to FILE`, reading the store directly. Twenty lines, and the property that makes the whole thing trustworthy: the notes come back out with the binary and nothing else. This is also the 2am tool.
11. **tests.** Apply §2.1's ledger rather than deleting test files wholesale: `keys_test.go:530` (invite redemption rollback) and `:557` (revoke race) keep their assertions with rewritten setup. Rewrite `devices_test.go` redemption cases for token invites. Add: revoke racing an upload, an MCP preparation, an invite creation, and a token recreation, each asserting no later version reaches the revoked connection; wrong-product-directory startup leaves bytes identical; `badpath` matrix; size-invariant refusals; frame decode bounds; author-row id validity. `protocol-fixtures.json` gains the path rules and the five format policies. The full ledger is [plan/strip-ledger.md](plan/strip-ledger.md): 254 tests in 18 files classified (100 obsolete, 128 guarantees, 26 split) plus the crypto cases of 17 adapted files. Its unique guarantees must survive: eight store handles redeeming one invite register exactly one device (`keys_test.go:743`); an expired invite is refused (no TypeScript test covers this); spent, unknown, malformed and cancelled invites get one identical refusal; a refused redemption never spends the invite; credentials are stored only as SHA-256; secret files are written atomically at 0600. Tests that fire only through a MAC failure or a `nomac` row (`engine.test.ts:2844`, `invariants.test.ts:75`, `backup_test.go:845`, `store_test.go:1383`) need a new trigger or they will pass vacuously. **Security hazard:** Basalt's invite listing (`Store.Invites`, `internal/store/store.go:2830`) returns the redemption identifier, which was safe only because redeeming also needed the invite key that never reached the server. With a bearer invite token that listing would hand every paired device a working credential. The listing must return a separate non-secret invite id, never the token or anything that redeems, with a test that no field of the listing redeems (`cli.test.ts:1481` checks only the whole string).
12. **backup/verify/purge.** `backup.go` drops the `nomac` inheritance and the token copy, and carries operations, pins, and audit rows. `verify -deep` also checks `Σ sizes == size`. `purge` implements the pinned survivor set of §4.5, with `--dry-run` and a preview that uses the same survivor calculation as execution.

Done when: `go test -race ./...` green; the M0.5 TypeScript client pairs from an invite, puts a two-chunk note with one deflated body, fetches it back, renames it with `prevBase`, gets `stale` on a raced put, sees `badpath` for `.obsidian/app.json`; a revoked device's live session stops receiving within the revoke reply; and `telimus cat` prints a note the plugin wrote.

### M2. TypeScript: core, plugin, and headless client without encryption (L, lane B, parallel with M1 after M0.5)

Goal: the plugin pairs, syncs, merges, and recovers against the M1 server. `bun run test`, `bun run stress`, `bun run build`, panel shots all green.

Tasks:

1. **digest.ts and frame.ts.** Move `randomBytes`, `chunkName`, `plainDigest`, `isChunkName`, `hex`, `base64urlEncode/Decode` out of `crypto.ts` into `core/digest.ts`. Move `worthDeflating`, `PROBE_BYTES`, the `0`/`1` markers, `inflateBounded`, `MAX_CHUNK_PLAINTEXT` into `core/frame.ts` as `encodeFrame`/`decodeFrame`. Delete `crypto.ts`, `rotation.ts`, `test-keys.ts`, `compression-golden*.ts`. Fix the seven import sites listed in the reuse map.
2. **chunk.ts.** `sizesFor` drops `SEAL_OVERHEAD` (`basalt:client/src/core/chunk.ts:31, 214`). Chunk names become `chunkName(rawChunk)`.
3. **transport.ts.** `PROTO = 1`. Delete `crypto` from every hello, `wrapped` from `ServerLimits` and `readReady`, `helloAsRegistrar`, `register`, `rotate`; `redeem` takes `{invite, deviceId, auth, device}`; `invite()` returns `{token, expiresAt}`. Delete `mac`/`parent` from `WireEntry`, `BatchEntry`, `wireEntry`, `put`. `fetch` decodes frames before the hash check (`transport.ts:2007`); `sendBodies` encodes. `encodedEntryBytes` counts UTF-8 bytes with `TextEncoder` (`transport.ts:274-280`). `entryBudget` becomes `size`. Start: lines listed in `plan/reuse-map.md`.
4. **engine.ts.** Delete `dataKey`, `derived`/`keysReady`/`settleKeys`/`failKeys`, `authFor`, `mustBeOurs`, the `mac`/`parent` shape checks, the `unsealed` cache and its prune, `Scanned.sealed`; rename `KEEP_SEALED_BELOW` to `KEEP_BODIES_BELOW` rather than deleting it (it is the memory policy for attachments over 8 MiB, used at `engine.ts:2338`, `:2380`, `:3828`, not crypto); `sealedPath`/`plaintextPath` become identity; `sealedNames` becomes a windowed hash loop that still hashes one file's chunks concurrently (serial hashing measured 56 MiB/s against 151 MiB/s, `crypto.ts:589-610`); `planUpload` re-hashes instead of re-sealing; `assemble` decodes frames. `acceptBatch` no longer awaits keys. `contentOf`'s expected-digest checks stay as consistency checks. Twenty-nine touch points; the reuse map lists every line.
5. **pairing.ts.** New `DeviceConfig {url, vaultId, device, deviceId, deviceToken, readOnly?, ignore?}`; `encodeConfig/decodeConfig` for it; delete `formatPairing/parsePairing` (recovery key), `secret`, `dataKey`, `deviceSecret`, `deviceCredential`'s key checks. New `formatInvite/parseInvite` for `telimus1i_` (version byte, 16-byte token, length-prefixed URL and vault id, CRC-32). `joinDestination` keeps its invite branch, loses the setup-line branch. The device token goes to the keychain when present (§2.3), with the read-back migration and its tests: keychain present, absent, failing the read-back, and two vaults on one device keeping two tokens.
6. **client.ts.** Delete `Registrar`, `registerAsDevice`, `wrappedForClaim`, `proveDeviceConnects`, the sealing in `invite()`, `history()`, `deleted()`, `recoveryIsOurs`; `redeemInvite` returns `{deviceId, deviceToken}`; `credentialsFor` passes the token. Everything from `serial` through `mutateLocal`, `runForever`, and the report renderers is untouched.
7. **plugin main.ts.** Delete `pairFirst`'s root-secret flow, `pendingFirstPairing`, `renderRecoveryKey`, `writtenDown`, `abandonRecoveryKey`, `freshRecoveryKey`, `rotate`, `renderRotate`, the recovery-key row, the `basalt3_` branch in `pair()` and `renderPairing`. The pairing panel becomes one field, "Invite", one button, "Pair", plus the existing device-name and skip-list options and the populated-vault confirmation. Rewrite the strings listed in the reuse map. `invite-qr.ts` keeps the QR over the new string and protocol action.
8. **plugin vault.ts and the rest.** Import `plainDigest` from `digest.ts`; no other change. `history.ts`, `activity.ts`, `conflicts.ts`, `delivery.ts`, `preview.ts`, `visible-poll.ts`, `first-sync.ts`, `transfer.ts`, `resume.ts`, `stub.ts`, `fake.ts`, `styles.css` unchanged.
9. **test-server.ts and fake-socket.ts.** `credentials()` pairs through an invite created with `telimus invite` (`TestServer.cli`). `ready()` fixture drops `wrapped`. Delete `crypto.test.ts`, `rotation.test.ts`, `invite.test.ts`, the MAC-forgery half of `recovery-auth.test.ts`, `plugin/rotate.test.ts`. Rewrite `testKeys`/`testWrapped` call sites (34 files, mostly one line each).
10. **src/node, published.** Rename `client/src/cli` to `client/src/node`. Keep `vault.ts` (`NodeVault`, `JsonIndexStore`), `exclusion.ts`, `lock.ts`, `config.ts`, `client-options.ts`, and `cli.ts` with `pair`, `sync`, `status`, `history`, `deleted`, `restore`, `unlink`. Delete `mcp*.ts` **only once the Go tools pass against their fixtures** (§2.1). Keep the semantic vectors until M5 proves the port. Delete `init`, `invite`-as-registrar, `rotate`, `rebase`. This package is **published** as `telimus-sync` and is in the release process (§2.7). `NodeVault` gains the plugin's normalized-name mapping for U+00A0 and U+202F (§4.1), tested with a file named with a non-breaking space on disk that round-trips through both clients to one server path. `esbuild.config.mjs` builds both bundles.
11. **refused paths surface.** `badpath` from the server lands in the plugin's stranded list with path and reason, and in `telimus-sync status` (§4.9). Test with a path over 1,024 bytes and with a control-character filename, both created directly on disk (an NFD name cannot reach the server; see §4.9).
12. **stress.** `harness.ts` pairs devices through invites. Re-run every `*.stress.ts` except `mcp.stress.ts`, which is retired here and reborn in M5.
13. **screenshots.** Regenerate the gallery; the pairing scenes change, everything else should be pixel-close.
14. **platforms.** The Windows inbound refusal list and the persistent unsupported or untested notice (§4.12), with tests that each reserved name, forbidden character and trailing dot or space arrives as a stranded path with its reason when the platform is Windows.

Done when: two plugin instances in two scratch vaults and one headless client pair from invites, converge on the M1 server, keep both sides of a conflict, restore a deleted note, surface a refused path, and `scripts/check.sh` exits 0.

### M3. First real acceptance (S)

Pair the Mac test vault and the Pixel against a local `telimus serve` over Tailscale. Exercise pairing, edits both ways, an attachment, a conflict, history compare, deleted-note restore, a refused path, revoke while the other device is connected, and re-pair. Write `docs/server.md` and `docs/plugin.md` from Basalt's, minus keys. Not the homelab yet.

### M4. MCP on the server: read tools (M, lane C, after M1)

Goal: `telimus serve --mcp` answers the read half of [plan/mcp-tools.md](plan/mcp-tools.md) over streamable HTTP with bearer auth.

Tasks:

1. **SDK, or not.** Add `github.com/modelcontextprotocol/go-sdk` at its latest tagged release, use its streamable HTTP handler in stateless mode, mount at `/mcp` behind auth middleware, and record the pin in `docs/development.md`. **Evaluate hand-rolling first.** `asciimoo/hister` serves MCP from 854 lines of plain JSON-RPC with no SDK dependency at all (`server/mcp.go`; its `go.mod` has no `modelcontextprotocol` entry). Given that the tool surface here is fixed, the transport is one HTTP path, and the SDK's API is still moving, a hand-rolled handler may be the smaller long-term cost. Decide in M4 with the reason written down.
2. **Auth.** Middleware: `Authorization: Bearer <43 base64url chars>`, constant-time compare against `mcp_tokens.token_hash`, 401 with `WWW-Authenticate: Bearer realm="telimus"`, update `last_used` at most once a minute. Origin header must equal an `--allow-origin` value or be absent (non-browser clients). Body limit 8 MiB, response limit 1 MiB, 32 concurrent requests, 429 with `Retry-After: 1` beyond.
3. **notes package.** `Assemble(store, chunks, vault, uid) ([]byte, error)`, `IsText(path)`, `Page(text, startLine, maxLines, budget)`, the opaque cursor codec, `CompareLines` (LCS with the 1e6 cell cap and `coarse` fallback). Port from `basalt:client/src/cli/mcp-read.ts`, `mcp-inspect.ts`.
4. **search package, asynchronous.** Per §2.5: an index worker driven by a durable `indexed_through_uid`, never inside the commit transaction. Generational rebuild (capture head, build, replay, verify, switch) with the previous generation queryable meanwhile. Corruption detectable independently of `index_version`. Tag parser ported from `basalt:client/src/cli/mcp-markdown.ts` (frontmatter YAML `tags` scalar or sequence, inline `#tags` outside code, HTML, `%%` comments, links; NFC-fold and lowercase for matching), using `goldmark` for structure and `gopkg.in/yaml.v3` node positions for source ranges. **A parse failure limits tag extraction and is reported; it never rejects a sync entry.**
5. **search semantics.** Literal substring search stays literal (§2.5). Use the index only where it cannot omit a match; scan within a documented budget where it can; report `complete: false` honestly. Fixture set: one- and two-character queries, substrings inside words, punctuation, case, Unicode, multiline, run against the Basalt reference scan as the oracle.
6. **tools.** `vault_status`, `list_notes`, `read_note`, `search_notes`, `note_history`, `deleted_notes`, `compare_versions`, `delivery_status`. Shapes and bounds per the spec. `read_note` returns `uid` as the base.
7. **as-of listing, corrected.** The stated predicate (latest row per path at or below the pinned head) leaves rename *sources* visible: with `A.md` at uid 1 renamed to `B.md` at uid 2, pinning head 2 returns both paths. Basalt already has the retirement predicate (`basalt:server/internal/store/conditional.go:11`); an as-of query must cap normal entries **and** rename retirements at the snapshot head.
8. **cursors that can expire.** A pinned uid does not keep its row alive across purge. Listing cursors account for renames, deletes, reused paths, store epoch, and retention; search cursors pin an index generation. Either lease a short-lived snapshot or return an explicit expired-cursor result. Do not silently return a different world. `compare_versions` resolves an omitted `toUid` once and carries it through continuation, or successive pages compare against different heads.
9. **auth.** Read-only by default; scope checked at discovery, dispatch, and commit (§2.3). Per-token budgets, not just the global cap. `telimus serve --mcp`, `--allow-origin` reused.
10. **untrusted envelope.** Implement §4.10: the `schema_version`/`tool`/`security`/`trusted`/`untrusted_content` result shape, the per-tool warning text, and the single normalisation function every untrusted string passes through. This lands with the *read* tools, not later, because the read tools are what first hands note bytes to a model.
11. **tests.** Go tests with the SDK's client over an in-process handler: every tool, every bound, pagination continuity across a concurrent commit and across a rename, 401/403/413/429, a token revoked mid-session losing at the commit boundary, an expired token, a write attempted with a read token by hand-built request. An index test that corrupts the index with a matching `index_version` and proves the corruption is still detected. A rebuild that runs while device writes continue. **Injection fixtures:** notes containing instruction-shaped text, envelope-imitating framing, control characters and lone surrogates, asserted to arrive under `untrusted_content`, normalised, and never in `trusted`.

Done when: Claude Code configured with the URL and token lists, reads, searches, and compares versions of a scratch vault while a plugin edits it; search matches the reference literal scan over the corpus; a concurrent rename produces no ghost row; and a note full of instruction-shaped text comes back under `untrusted_content` with the warning attached.

### M5. MCP write tools and the crash matrix (L, lane C)

Goal: the mutation half of the spec, safe under kill and under concurrent device writes, **with the recovery machinery that makes unattended agent writes acceptable**. Audit, retention pins, and undo are part of this milestone, not ideas for later. The plan previously marked them "do this early" in `plan/ideas.md` and then never scheduled them.

Tasks:

1. **`CommitOperation`.** Per §4.3: a distinct all-or-nothing API, not a flag on `AppendMany`, and no individual-write fallback. Device `putmany` keeps its partial-success semantics untouched. Prepare outside the write lock; recheck credential, scope, epoch, and every base under the commit boundary; precompute and bound the reply before committing.
2. **oplog.** `operations`, `op_entries`, `op_pins`, `op_keys` written in the operation's own transaction. Record operation id, actor id and label as they were, tool, server commit time, request digest, affected paths, before and after UIDs, and outcome. Never record bearer tokens or note bodies. Revoking an actor does not erase its history. `telimus audit --since` reads it.
3. **idempotency.** `(actor_id, idempotency_key)` with the canonical request digest and the recorded result (§4.8). Replay returns the same result; the same key with different input refuses. Define result retention and provide an operation lookup for a lost reply.
4. **exact edits.** Port `replacement` (unique `old`, non-overlapping, ≤32 edits, ≤8 KiB each, ≤64 KiB total, result ≤1 MiB), `append`, `prepend` (BOM-aware) from `basalt:client/src/cli/mcp-notes.ts:157-261`.
5. **tools.** `create_note`, `create_directory`, `edit_note`, `append_note`, `prepend_note`, `delete_note`, `move_note`, `restore_note`, `add_tags`, `remove_tags`, `manage_tags`, `rename_tag`. Per §4.3. Preview-then-apply binds a vault snapshot head and requires it unchanged at commit, which is what catches a new backlink or a namespace change that per-entry bases cannot see.
6. **links.** Port `changeLinks` from `mcp-links.ts` on goldmark's AST: Markdown links, images, definitions, `[[wiki|alias]]`, `![[embed]]`, fragments, encoded paths, shortest unambiguous wiki names. Regression cases from `mcp-links.test.ts` become Go table tests. A link-based mutation either scans authoritative content or proves its link index is current: `note_links` needs a real schema and a maintenance task, which the spec referenced but never defined.
7. **undo.** A compensating operation that verifies every affected head still equals the original operation's outputs, and refuses or offers restore-to-copy otherwise (§4.5). Moves and tag or backlink batches undo as a unit. Exposed in the plugin's history panel and as `telimus undo OPID`.
8. **author rows.** Author identity for MCP tokens without squatting on `device_id` (§2.3): its own `kind`, valid ids, a label that reaches conflict-copy names and history, and no agent appearing as an offline peer whose applied checkpoint everyone waits for.
9. **crash matrix.** Seams: after bodies stored before append; after append before broadcast; after broadcast before reply. SIGKILL at each; restart; assert the version is either fully present with all bodies or absent, never a dangling entry, and that the idempotency key resolves the unknown-outcome case into one discoverable result. Reuse `basalt:client/src/stress/faults.ts` by pointing it at the Go process, or port `seam.ts` to Go.
10. **retention under purge.** Edit a note untouched for a year, purge immediately with defaults, restart, and read its exact former bytes. Repeat across a backup and restore. This is the test the earlier `-keep-since` design fails.
11. **injection round-trip.** The write half of §4.10: an agent that creates or edits a note containing instruction-shaped text must produce a stored version that, when read back by the next session, still arrives under `untrusted_content` and normalised. Assert that a poisoned note cannot escape the boundary by being written through the tools rather than synced from a device.
12. **phone races.** Port the five cases in `basalt:client/src/stress/mcp.stress.ts` (disjoint edits, overlapping edits, append versus replace, delete versus edit, offline catch-up) with the agent side through the HTTP tools and the phone side through two headless clients. Assert retained bytes on a freshly paired third device.

Done when: one stale slot, a changed namespace, a new backlink, a revoked actor, or an injected storage error leaves **zero** entries committed for that operation; SIGKILL after append yields exactly one discoverable result on retry; a fresh witness device sees exactly the committed state; the year-old before-image survives an immediate purge; and a day of real use on a scratch vault has produced no unexplained conflict copy.

### M5.5. Operational acceptance and restore rehearsal (M, after M5)

Goal: the maintainer can tell a healthy vault from a quiet failure, recover from a failed server, and explain every agent mutation. **No milestone that mutates real notes starts before its recovery path has actually been exercised**, which is rule 11 applied to the project rather than to a document.

Tasks:

- **Threat model written before deployment**, per §3.6: encrypted storage and backup coverage, key custody, TLS termination, service-user permissions, secret output handling, snapshots, logs, and the limits of protection against a running-host compromise. Chunk identifiers and paths are named as sensitive metadata.
- **`telimus doctor`.** One command that diagnoses instead of leaving the maintainer to infer. Modelled on `hister doctor`, which checks "configuration, connectivity, authentication, and index compatibility" and states plainly that it "does not repair data". A diagnostic that cannot mutate is one you can run while worried. Checks: data directory and lock state, product identifier, schema version and epoch, a sampled chunk-store integrity pass, index lag and generation, MCP token validity and expiry, device last-seen and applied lag, free space, last verified backup, and reachability of the configured origin. Exit non-zero on anything actionable.
- **Observability as a package, not log lines.** `hister` carries `server/metrics/` and `server/diagnostics/` as first-class packages rather than scattered instrumentation; do the same. `/health` is inherited and is not a vault-health verdict; "the process is listening" says nothing about whether notes are arriving. Add structured operation ids and bounded metrics: commit latency, lock wait, stale refusals, auth failures, rate-limit responses, active and evicted peers, applied lag per device, index lag and failures, database, WAL and chunk sizes, free space, last verified backup, last successful restore rehearsal. Credentials, note bodies, paths, and chunk digests stay out of metric labels.
- **Alerts with remedies** for disk pressure, failed backups, missing chunks, repeated commit failures, index lag, and a device that has stopped advancing. Detailed diagnostics only over authenticated or local access.
- **Restore rehearsal for real.** Restore an encrypted backup into a separate directory on a separate port with production clients unable to reach it. Verify every expected version and body, operation pins, audit rows, rename and deletion recovery, and a freshly paired device's downloaded bytes. Rebuild search from the restored store. Measure recovery time and write down the data-loss window the backup schedule implies.
- **Restore the vault to a point in time** (decided 2026-09-22). `telimus restore --to-uid N`, through the control socket, dry run by default and `--apply` to commit: one `CommitOperation` that appends a new version for every path whose head differs from its state at `N`, tombstones paths created since, pins every displaced head (§4.5), and is itself undoable. History is never rewritten or rewound (PKV Sync's force-moved branch broke per-file history and checkpoints, `plan/research/pkv-sync.md`). Tests: restore across renames, deletions and paths created since; restore then undo returns byte-identical heads; a device offline during the restore converges without conflict copies for paths it did not touch. A plugin action comes after v1.
- **Faults beyond SIGKILL.** Disk full during chunk and database writes, failed directory fsync, missing and corrupt chunks, slow peers, dropped replies, restart loops, parser failures. Keep deterministic seams and failing seeds. SIGKILL alone is not evidence for power-loss durability.
- **`docs/operations.md`**, the 2am document: how to tell whether a note is lost, how to read a path's history from the shell, how to extract a version with `telimus cat` and nothing else, how to roll back an agent's overnight run, what `badpath` in the logs means, what to do when the index is behind.
- **Soak.** A defined period on disposable representative data, including a phone offline while the agent edits. The exit criterion is no unexplained loss, divergence, or unbounded retries, not zero conflict copies, which are an expected outcome, not a defect.

Done when: each fault produces an actionable status, preserves acknowledged content, and has a tested recovery path; `telimus doctor` reports every injected fault correctly and exits non-zero; and the operator has personally performed a restore rather than read about one.


### M9. Packaging, docs, release (M, can start after M3)

- `Dockerfile` and `compose.yaml` from Basalt with the new name, `--mcp` in the example command, one port.
- `telimus service` unit; `telimus health`; `telimus doctor` from M5.5.
- **Reach, not just a Dockerfile.** `asciimoo/hister` ships Homebrew, Docker, a Nix flake and goreleaser binaries for every platform, and it is the difference between a project people can try and one they read about. Add `.goreleaser.yml` (which also produces the release attestations this milestone wants), a Homebrew tap, and `flake.nix`. `go install` and Docker alone are not distribution.
- **Self-update.** `telimus update`, as `hister` has. This is a binary someone runs for years on a box they rarely log into; make upgrading it one command that checks the release feed and verifies the signature.
- **A docs site, in-repo.** `hister` keeps its docs site in the repository beside the code so they version together. Same here: the `docs/` markdown becomes a small static site, published from the same tag as the binary.
- `scripts/check.sh` with the CI drift guard; CI jobs mirrored from `basalt/.github/workflows/ci.yml` (server, client, stress, mounted filesystem, case-folding, systemd, docker, restore rehearsal; note that Basalt already has this at `basalt:scripts/check.sh:152`; what M5.5 adds is rehearsing *this* migration, not the concept). Release workflow with attestations; plugin assets `main.js`, `manifest.json`, `styles.css`; the `telimus-sync` npm package (§2.7); `versions.json` maintenance; tags `X.Y.Z` for the plugin and `server/vX.Y.Z` for the binary.
- Docs, few files, plain: `README.md`, `docs/server.md`, `docs/plugin.md`, `docs/agent.md` (MCP setup, token handling, scopes, what the agent can and cannot do, and the plain statement that a token reads the whole vault), `docs/client.md` (headless), `docs/operations.md` (M5.5), `docs/design.md` (rules, threat model rewritten for a trusted server, conflicts, MCP principles), `docs/protocol.md`, `docs/development.md`, `docs/compared.md` (add "built-in agent" and "no encryption" rows honestly), `llm.md`.
- **`README.md` written to the shape that works.** Modelled on `asciimoo/hister`, which reached 4,900 stars in eight months as a self-hosted Go binary with the same audience: one bold line of value ("Your own Obsidian sync, with an agent inside it"); a link row of Demo · Download · Quickstart · Docs; a screenshot before any prose; a numbered quickstart that reaches first success in about five steps and is honest about friction ("keep this terminal open"); eight **bold-led** feature bullets; a standalone **Privacy** section; a **Why this?** section; then development, community and licence. Add `CHANGELOG.md`, `CONTRIBUTING.md` and `SECURITY.md` at the root.
- **The Privacy section is not optional and it goes in the README.** This project *removed* end-to-end encryption, so the honest account in §3.6 is exactly what a prospective user most needs before installing, and burying it in `docs/design.md` would be a form of misrepresentation. State plainly: the server reads your notes, that is what makes the agent possible; the data volume must be encrypted; backups must be encrypted; an MCP token reads the whole vault and its results reach your model provider. `hister` does this well and it costs them nothing.
- `docs/research.md` credits: Basalt itself, LiveSync for chunking, obsidian-mcp for the tool scope, the go-sdk, and `asciimoo/hister` for the untrusted-content envelope (§4.10), the `doctor` command, and the packaging and README shape.

### M10. Cutover: rehearse, inventory, cut, keep the way back (M, after M5.5 and M9)

The earlier version of this milestone was seven steps ending in "verify counts". Counts do not prove equal paths or equal bytes, a server backup cannot show that an unsynced local edit survived, and because the plugin id changes, both plugins can sit installed on the same vault, the one arrangement the scope refusals forbid.

1. **Rehearse the whole procedure on a disposable copy first.** Include attachments, large notes, nested renames, deleted notes, conflict copies, Unicode names, and a device that was offline with edits. Do not connect the rehearsal to the live vault.
2. **Settle every device against Basalt.** Bring each online, account for local-only changes and conflicts. A device that cannot participate is frozen and gets an explicit later rejoin procedure; an unknown old tree does not get to join blindly and start writing.
3. **Freeze and capture.** Pause writers. Take and verify both the Basalt server backup and a snapshot of readable local vault content (`basalt:docs/security.md:103`). Record the inventory. Archive the backup, its recovery key, and a compatible Basalt build together. Write down the rollback window and who owns edits made during it.
4. **Disable the old writer per directory** before enabling the new one. Deploy Telimus on an isolated address for verification. Pair the primary vault, upload, then **download to a freshly paired empty witness device and compare normalised paths, kinds, sizes, and SHA-256 content hashes.** Check excluded content explicitly rather than assuming it was meant to be excluded.
5. **Migrate the phone** from a verified local backup against the reconciled inventory. Confirm no two sync systems share a local directory. Exercise offline edits, catch-up, delete and restore, and conditional undo. Start MCP **read-only**; issue a write token deliberately and separately.
6. **If validation fails:** stop new writers, preserve the Telimus server, export post-cutover changes, then reconcile against the frozen Basalt baseline. Do not point the old plugin at a changed directory and hope the old server sorts it out.
7. **Retire on evidence, not elapsed time.** The old services and data go only after a Telimus backup has been restored successfully, both devices pass the inventory check, and the rollback is no longer needed. Record the accepted result; keep the Basalt archive under an explicit policy.
8. Update `~/code/homelab` docs and the compose comments; remove the second MCP route.

Done when: independent downloads match the agreed source inventory, every participating device has converged, a Telimus backup has been restored, and rollback has been rehearsed with post-cutover edits in play.

## 6. Sequence and dependencies

```
M0  baseline, naming, storage identity, measured inventory
 └─▶ M0.5  Go/TypeScript contract slice          ← sequential gate, not a document freeze
      ├─▶ M1  server (lane A) ──┬─▶ M4  MCP read ──▶ M5  MCP write, audit, retention, undo ──┐
      └─▶ M2  TS clients (lane B) ─▶ M3  device acceptance ──▶ M9  packaging and docs ───────┤
                                                              M5.5  operational acceptance ──┴─▶ M10  cutover
```

M1 and M2 run as two agents at once, but **behind M0.5 rather than behind a frozen document**, and they integrate continuously against each other from that point. The earlier plan had them forking off a 200-line draft; that draft turned out to contain a field-name contradiction, an incorrect port instruction, an unspecified binary format, and a milestone-ordering bug (§2.6, M0.5), none of which a freeze would have caught.

M9 can start writing docs as soon as M3 shows the flows. M5.5 gates M10: nothing touches the live vault before its recovery path has been exercised.

Gone from this diagram: M6, M7, and M8, the Go sync engine and `--vault-dir`. See §2.6 for why, and `plan/ideas.md` for what would have to be true to bring them back.

## 7. Verification discipline

Carried from Basalt without softening:

- `scripts/check.sh` before every push; exit 2 is not a pass; read CI for the exact commit.
- Every bug fix ships with a test shown failing without it.
- Preservation assertions check retained bytes, not agreement between clients.
- Subagents run on the session's model; reports from subagents are verified, not relayed.
- The five fix-defect shapes an outside reviewer keeps finding in Basalt (`~/.claude/projects/-Users-wayne-code-basalt/memory/basalt-protocol-and-reviews.md`): a seam before the check it proves, a vacuous test, a `finally` that deletes recovery data, a comment describing a removed mechanism, a fix applied to one of two adapters. Read every fix for them.

New for Telimus:

- Every MCP mutation test asserts the displaced version is still readable by UID after the write, **and still readable after a default purge**. The universal form of this ("read every previous UID as former bytes") does not apply to creates, folders, and tombstones; those assert their own shape instead.
- Every server-side path or size check has a test that a hand-built client can trip it. Scope enforcement is tested against a hand-built request, not against the tool list.
- A revoke is not proven by its reply. It is proven by a later mutation from that credential failing to commit and a live subscription stopping.
- Search behaviour is tested against the Basalt literal-scan oracle over a corpus, not against its own index.
- Fixtures cross the language boundary in both directions. Each implementation consumes the other's vectors, and a deliberately corrupted vector must fail on the consuming side.
- Before deleting a test file, classify its assertions (§2.1). "It was a crypto test" is a claim to be checked, not a category.
- Deterministic seams and failing seeds are retained. SIGKILL is not evidence for power loss (M5.5).
- No tool result carries note-derived bytes outside `untrusted_content` (§4.10). Every read tool has an injection fixture, and the write tools have a round-trip fixture proving a poisoned note cannot escape the boundary by being written through the tools rather than synced from a device.

## 8. Durability rules

Reproduced from `basalt:docs/design.md` so the numbers stay citable in code comments. Do not renumber.

1. Acknowledge only after the write is durable.
2. A failed read is not an empty result.
3. Never delete until a verified copy exists elsewhere.
4. Verify the outcome, not the exit code.
5. Never write a result smaller than its input without proving that is right.
6. Deletions are entries, not absences.
7. A status describes the vault, not the filter.
8. Trust the numbers, not the passes.
9. A fix without a test that failed first is not finished.
10. Assertions must check the property that matters.
11. A recovery path tested only in docs is a rumour.

## 9. Later work, not promised

Collected in [plan/ideas.md](plan/ideas.md): what a plaintext server unlocks (web history viewer, webhooks, backlinks and vault health, publishing, scheduled agents, semantic search, time-travel reads), the carry-overs (`import-basalt`, whole-file `write_note`, stdio bridge, streaming download), and the ones that press on the scope refusals (share one note, several vaults). Move an idea here when it becomes a milestone.

Promoted **out** of ideas and into M5, because they are what make unattended agent writes acceptable rather than nice additions: the agent audit log and undo.

Newly deferred, with the condition for reopening written down rather than left as a shrug:

- **Go sync engine and `serve --vault-dir`** (§2.6). Reopen only for a measured runtime, packaging, or resource requirement, and only with shared golden merge decisions and differential fuzzing.
- **`serve --export-dir DIR`**, a one-way plaintext mirror written from head versions, with no credential and no upload path. A few hundred lines, genuinely useful, not needed for v1.
- **Per-token path scoping.** An optional write-prefix capability for unattended agents. It would not restrict reads and must not be described as though it did.

## 10. The name

**Telimus**, said TEL-ih-mus. It is House Telimus from James Islington's *The Will of the Many* (the adoptive house that takes Vis in). It carries no meaning about sync or history, and that was accepted knowingly: the name was chosen for being clean everywhere, easy to say and spell from hearing, and liked, after roughly 280 candidates across two rounds.

Checked on 2026-09-22:

| Check | Result |
|---|---|
| npm `telimus`, `telimus-sync` | free |
| GitHub repositories named `telimus` | 0 |
| Obsidian community registry | no match |
| Web search, with and without software terms | no product collision. Telemus (a defence electronics firm, and Telemus AI) is a near-homophone spelled differently. |

These are absence checks on one day, not reservations. Domain and trademark clearance were not done.

The first round rejected Telimus because `telimus-sync` puts two sibilants together (TEL-ih-mus-SINK). On a second hearing that was judged acceptable, which also reopened the question for Talus below.

### Why not the others

The pattern from both rounds: anything short, easy to say **and** meaningful is already taken, usually by a company founded in the last few years, and registry availability (npm, GitHub) is a poor proxy because most competing products are SaaS that never publish a package. In 2026 the words about memory, records and preservation are especially crowded by AI-agent memory tools.

Round one (2026-09-18):

| Candidate | Removed by |
|---|---|
| Lyell | The previous settled name (Mount Lyell and Charles Lyell, who showed a landscape is accumulated small changes, all still legible). Clean on npm, GitHub and the Obsidian registry. Replaced by preference, not by a collision; it remains the fallback. |
| Gabbro | The working name. Also, since Aug 2026, a Gabbro password manager (`gabbro-foss/gabbro`) that stores "vaults" and `.gabbro` backups, a Gabbro Go CLI, and SLR Consulting's Gabbro tool. |
| Jotrove | Clean everywhere, but a coined portmanteau that means nothing on sight. |
| Picrite, Pohaku, Kohala, Punawai, Kipuka | Sound, length, or a decision to drop Hawaiian entirely. |
| Pono | Available, but in living Hawaiian usage it is a moral word about conduct. |
| ʻAuwai, Tinna, Askja | Pronunciation ambiguity an English reader cannot resolve on sight. |
| Teli, Telim, Telora | `teli` is the dictionary's phonetic spelling of "telly"; the others are live products. |
| Trew | A permanent typo tax: people type "true" forever. |
| Troth, Bevara, PlainSync, VaultMesh, NoteAnchor, Capsa, Armarium | Direct product collisions, several in data preservation, local-first Markdown sync, or AI agent memory. |
| ob-sync, obone-sync, obtail, obi | Reads as Obsidian Sync, Obsidian's paid product. Six registry plugins already use `obsync*` (one, `obsync-private-sync`, is also a self-hosted sync server), and `acheong08/obi-sync` reverse-engineers Obsidian Sync. `obtail` collides with Tailscale in this project's own docs. |
| pi-sync, 111, alpha-sync, omega-sync | Unsearchable, or (111) breaks the invite prefix `<name>1i_` and parses as a number in YAML. |
| Crag | `CRAG` is Corrective Retrieval-Augmented Generation, plus Meta's CRAG benchmark. |
| Hordern, Bochord, Hordere, Frithstow | Old English storehouse words. Clean, but long or read as "hoarder". |
| Nunatak, Batholith, Tenaya, Inselberg, Monadnock | Clean and viable, not preferred. |

Round two (2026-09-22):

| Candidate | Removed by |
|---|---|
| Fons, Kilde, Varve, Weir, Quelda | The final shortlist. All clean on npm `-sync`, the Obsidian registry and GitHub. Fons (Latin "spring") "did not sit right" and sits one letter from "fonts"; Varve has Varve Studio, a local-first design suite; Kilde (Danish "spring") has uncertain English pronunciation. Keep as fallbacks. |
| Talus | Talus Notes, an iOS notes app with private sync (Aug 2026), and Talus Network, AI-agent infrastructure on Sui (v2.0 and developer API in Sep 2026). |
| lit-sync, lith-sync | LiteSync (`litesync`, a self-hosted E2E Obsidian sync plugin, Aug 2026) is one letter away, a published `/lit-sync` Claude Code skill syncs into Obsidian, and Lith and Lithic are notes apps. |
| o6n-sync | A numeronym for "Obsidian", so it decodes to "Obsidian Sync". Search is owned by the Radxa Orion O6N board. |
| vis-sync | vis.js and "vis" for visualization. |
| Arx, Nox, Holm, Sheaf, Verra, Rill, Kiln, Gemynd, Geyma, Keld, Palim, Kepta, Tovra, Kivra, Loci, Stele, Fonds, Quipu, Kenning, Firn, Scrinium | Live products in adjacent fields: sync or notes apps, AI-agent memory, agent platforms, knowledge stores, or a writing app that keeps earlier versions. |
| Cairn, Stratum, Folio, Tally, Seam, Scree, Quire, Memor, Arca, Verso, Tabula, Lumen, Vesta | Existing Obsidian plugins of the same or near name. |
| Three-letter names (Ulv, Orv, Oru and others) | `-sync` forms were free, but bare names are mostly taken, unsearchable, and read as acronyms. |

**Correction worth recording:** the Obsidian developer policy forbids the *word* "Obsidian" in a plugin name and "obsidian" in a plugin ID. It does not restrict the prefix `ob`. The objections to the `ob-` family are confusion with Obsidian Sync and namespace crowding.

### Derived identifiers

Settled now, before the invite format and on-disk identity freeze:

| Thing | Value |
|---|---|
| Go module | `github.com/waynehoover/telimus` |
| Binary | `telimus` |
| Environment | `TELIMUS_DATA` |
| State directory | `.telimus`, staging marks `.telimus-tmp-` |
| Plugin id | `telimus-sync` |
| Protocol action | `obsidian://telimus` |
| Invite prefix | `telimus1i_` |
| npm package | `telimus-sync` |
| Auth realm | `WWW-Authenticate: Bearer realm="telimus"` |
| Docker image | `ghcr.io/waynehoover/telimus` |
| Store product id | `telimus` (§2.8) |
