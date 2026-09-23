# Review synthesis

Two independent design reviews of the plan as it stood on 2026-09-17, reconciled into the current PLAN.md. Both read `/Users/wayne/code/basalt` at `664a963` and checked the plan's claims against it rather than against memory.

- [opus-critique.md](opus-critique.md): Opus. Verified the cited line numbers, found the internal contradictions, argued the structural cuts.
- [astra-critique.md](astra-critique.md): Codex Astra. Verified 80 citations, ran five targeted Basalt tests, and ran live SQLite probes that turned three suspicions into proofs.

This file records what changed and why. It is a record, not a plan; PLAN.md is the plan.

## What both reviews found independently

When two reviews that did not see each other land on the same finding, it is worth more than either one saying it twice.

| Finding | Where it landed |
|---|---|
| The Go sync engine port should be cut, not staged | §2.6, milestones |
| Freeze-and-fork is not safe; build a vertical slice first | M0.5 |
| Admin subcommands writing SQLite cannot revoke a live session | §2.3.1 |
| Search indexing does not belong in the commit transaction | §2.5 |
| MCP tokens need scope, expiry, and per-token limits | §2.3 |
| No whole-file `write_note` in v1 | §4.4 |
| Backups and at-rest exposure are understated | §3.6 |
| Audit and undo must leave `ideas.md` and become milestone work | M5 |
| Cutover needs rehearsal, inventory and rollback | M10 |
| Observability is absent | M5.5 |

## The findings that changed the most

**Retention by age does not work.** (Astra.) The `-keep-since 30d` proposal fails on the ordinary case: a note last edited a year ago, edited by an agent today, has a before-image that is neither a head nor newer than the cutoff, so purge can delete it the same day. Astra proved it by running Basalt's real `purgeSurvivorUIDs` query against a two-version fixture with the age predicate added, and only today's UID survived. And there is no server commit timestamp to compute age from: entries carry client-supplied `ctime`/`mtime` (`store.go:410`). Retention became pinning by reference at the operation (§4.5, `op_pins`). This was the single most valuable finding in either review; Opus had said "state the invariant" without noticing the flag as specified could not implement it.

**Atomic batches are not a flag.** (Astra.) `AppendMany` is *deliberately* partial: savepoints per entry, a session-layer fallback to individual commits, and `TestAppendManyRefusesOneEntryAndCommitsTheRest` holding the behaviour on purpose. That is right for a device and wrong for an agent's multi-file refactor. Two APIs now (§4.3). Astra also found that preview-then-apply is not saved by matching bases: a device adding a backlink, or a filename that changes a short wiki-link's resolution, invalidates what the preview *read* while every output base still matches.

**Schema version 1 collides with Basalt's schema version 1.** (Astra.) A Trew binary opened on a Basalt data directory would find a version it accepts. Became product identifier plus store epoch, validated before any write, with the epoch binding cursors and preconditions so a restored database cannot make a stale precondition match the wrong version (§2.8, §3.3).

**FTS5 phrase matching is not literal search.** (Astra, with a live SQLite probe.) With `foobar` indexed, `MATCH '"oo"'` returns nothing; `instr(body,'oo')` returns the row. Basalt's `search_notes` is an escaped literal regex (`mcp-read.ts:305`), so the swap would have quietly returned fewer results with no error. Also proven with a fixture: the as-of listing predicate leaves rename *sources* visible (§2.5, M4).

**Committed is not delivered.** (Astra.) The hub skips failing peers by design (`hub.go:50`), so "a committed version is already visible to every connected device" was false. Combined with the crash matrix's own kill-before-reply seam, this produced the idempotency-key requirement (§4.8).

**`mcp:<id>` is not a valid device id.** (Astra.) `ValidDeviceID` accepts base64url, which has no colon (`store.go:2595`), so the claim that the devices table was reused unchanged did not hold.

**The two exclusion mechanisms do not exclude each other.** (Astra.) The Go client was to use `flock` while the retained Node adapter uses an abstract socket on Linux (`exclusion.ts:21`). Two implementations sharing a journal format with mutual exclusion that does not mutually exclude is a data-loss shape. This turned the Go-engine argument from "expensive" into "hazardous".

**The `handleResend` port instruction was simply wrong.** (Astra.) It is an upload path receiving repair bodies through `readBodies`, not a download handler that encodes frames.

**The internal contradictions.** (Opus.) `auth` vs `token` in redemption; `scope` present in the tool spec and absent from the schema; §2.5 maintaining the index transactionally while `vault_status` reported `index.fresh` as though it were asynchronous; §2.2 celebrating the removal of a cross-runtime byte-equality requirement that M7.1 then reintroduced harder. These mattered less for their individual weight than as evidence that a 200-line document was not a contract two lanes could implement in parallel, which is the argument for M0.5.

**The size invariant's cost.** (Opus.) `Σ chunks.Size(name)` is one lookup per chunk per entry inside `commitMu`, across batches of up to 256 entries. Both reviews independently caught that the signature is `Size(vaultID, name)`, not `Size(name)`.

**A refused path becomes an invisible stuck file.** (Opus.) Server-side NFC refusal with no UI surface means a file silently never syncs and the only trace is a log line (§4.9).

**`trew cat`.** (Opus.) A shell-level way to get a version out with the binary and nothing else. Twenty lines, absent from the plan, and the thing you want at 2am. Now an M1 task.

**Line counts.** (Astra, measured.) Go non-test is 13,588 not 9,500; Go test 22,895 not 27,000; 536 test functions not ~600; core TypeScript 20,802 not 22,900. The "roughly 80 percent reusable unchanged" was never measured and is replaced by a per-symbol ledger (§2.1).

## Where the reviews differed, and what was picked

**The mirror use case.** Opus proposed a one-way `serve --export-dir` written from head versions. Astra proposed running the published TypeScript client as a sidecar. Astra's wins because it requires no new code at all; `--export-dir` stays in `ideas.md` as a genuinely small later addition that avoids a second credential.

**Restore rehearsal.** Opus listed it as missing. Astra checked and it is not. `basalt:scripts/check.sh:152` has it and M9 carried it. The real gap was an *early* rehearsal of this migration with representative data, which became M5.5. Correction accepted.

**Whole-file `write_note`.** Both said refuse for v1. Opus argued the reasons that survive server history are silent renormalisation and unreviewable diffs, and proposed `replace_section` on the Markdown AST as the escape hatch agents actually want. Astra added that exact edits are not a semantic boundary either: an agent can pass a whole small note as one unique `old`. Both are in §4.4; the protection is retention, audit and undo, not the shape of the edit tool.

**At-rest encryption.** Opus considered a server-held data key and rejected it, because SQLite metadata (paths, the most sensitive thing after content) stays plaintext with a pure-Go driver. Astra reached the same conclusion from the other direction and added the surface Opus had missed: WAL, temp files, snapshots, backup staging, and the point that removing the HMAC authenticator removes a device's ability to detect server-manufactured content. Merged into §3.6, with Opus's concrete `backup --encrypt-to` / refuse-plaintext mechanics.

**Chunk names.** Astra examined whether raw SHA-256 leaks and concluded: keep it, document it, and do not exaggerate it, because the endpoints authenticate and a token's scope is already the whole vault. Opus had not pressed on this. Adopted as written, including the obligations (no chunk names in logs, metrics labels, or public manifests) and the trigger to revisit (narrower readers).

## The name

Both reviewers proposed a name and checked availability. Opus proposed **Quarry**, which loses on evidence (npm taken, 1,170 GitHub repos, and a collision with Wikimedia's Quarry). Astra proposed **Jotrove** and checked it thoroughly; Opus re-verified all four checks independently rather than relaying them.

Neither pick survived the user's own criteria, which emerged over a long search: short, unambiguous to pronounce, concrete rather than moral, correctly spelled, and clean as `<name>-sync`. Roughly 220 candidates were checked across seventeen languages, fiction, Latin and Old English, coinages, descriptive compounds and geology.

The settled name was Lyell at the time of this synthesis. On 2026-09-22 it was replaced by Telimus, and then, the same day, by **Trew**. Full reasoning and the rejected list are in PLAN §10.

Two findings from that search worth keeping:

- **Registry availability is a poor proxy.** npm and GitHub were free for most descriptive compounds, while the actual products existed as SaaS that never publish packages. PlainSync, Bevara, VaultMesh, Capsa and Armarium were all npm-clear and all taken by live products, several of them in data preservation or local-first Markdown sync.
- **The `ob-` policy claim was overstated.** Obsidian's developer policy forbids the *word* "Obsidian" in a plugin name and "obsidian" in an ID; it does not restrict the prefix. The real objections to that family were trademark confusion with Obsidian Sync, which is Obsidian's own paid product, and a four-way collision with Tailscale in this project's own deployment docs.

## What was not done

Neither review ran the full Basalt suite, verified FTS5 in the pinned Go driver, or operated a live vault. The FTS5 probe used the local SQLite CLI, not `modernc.org/sqlite`. M0 still has to check the pinned build. No Trew code exists, so every proposed race and recovery test in the plan is acceptance work, not a passed test.
