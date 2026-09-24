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
owner decided, with the date and what it costs).

### Storage and backups

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| S1 | The data volume sits on encrypted storage (LUKS, FileVault, ZFS native encryption), and where its key lives and how an unattended restart unlocks it is written down | `docs/operations.md` (M5.5); `trewd doctor` reports whether it can tell | **accepted risk**: the owner's homelab volume is not encrypted and the owner accepts that (2026-09-22). Anyone who can read that disk can read every note and its history. `doctor` still reports it. |
| S2 | Backups are encrypted, including backups that stay on the same box: `trewd backup` refuses to write outside the data directory without `--plaintext-ok`, or takes `--encrypt-to <age recipient>` | `backup` | **deferred** by the owner (2026-09-22): no TrewSync backup destination yet. The M5.5 restore rehearsal still runs, locally, because a recovery path tested only in docs is a rumour (rule 11). |
| S3 | The restore rehearsal exercises the encrypted path, not a plaintext shortcut | M5.5 rehearsal | **deferred** with S2 |
| S4 | A data directory on storage a container replacement or a reboot erases is reported, and `serve` refuses to start an empty store there without `--allow-ephemeral` | `internal/doctor` (the check exists; wiring is M5.5) | planned |
| S5 | A directory of another product, or a newer schema, is refused before any write and left byte-identical | store identity (M1) | planned |
| S6 | Deleted versions a person expects gone are gone only when purge says so, and purge never reclaims a version pinned by an agent operation inside its window | purge survivor set (M1, M5) | planned |

### Credentials

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| C1 | Every credential is random and stored only as its SHA-256; comparison is constant-time | store (M1, M4) | planned |
| C2 | No listing returns anything that redeems: an invite listing carries a separate non-secret id, never the token or its hash | store, with a test that tries every listing field as a token (M1) | planned |
| C3 | A redemption refusal is one identical answer for unknown, spent, expired and cancelled invites, and writes nothing | store (M1) | planned |
| C4 | A revoke means no later mutation from that credential commits, no queued one completes, and no live subscription keeps delivering | control socket and commit boundary (M1) | planned |
| C5 | Invites expire by default (one hour); the invite `serve` mints for the first device goes to a 0600 file, never a log | `serve` (M1) | planned |
| C6 | No credential in a URL query string, including any future event stream | review rule; test on the MCP endpoint (M4) | planned |
| C7 | The plugin keeps its device token in Obsidian's keychain when the app has one, scoped to vault and device, so a copied `.obsidian` does not carry a working credential | `client/src/plugin/keychain.ts` (M2) | enforced; tested with a copied vault and a lost keychain entry |
| C8 | Secret files (the first invite, `mcp-token --key-out`) are written atomically at mode 0600 | M1, M4 | planned |

### The agent endpoint

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| A1 | A token reads the whole vault, and the person creating one is told so, including that results reach the agent's model provider | `docs/agent.md` (M9); `mcp-token` output | planned |
| A2 | Tokens default to read scope; write is explicit, and scope is checked at discovery, at dispatch and at the commit boundary against the credential as it stands then | `internal/mcp` (M4, M5) | planned |
| A3 | Every byte from a note reaches the agent only under `untrusted_content`, through one normalisation function, with the warning in each tool's description | `internal/mcp` envelope (M4) | planned |
| A4 | An agent cannot write outside the vault's note space: dot-prefixed segments are refused, so `.obsidian/plugins/*/main.js` (code every device would run) is unreachable, including by create then move | path rules (enforced in the contract); MCP injection fixture (M5) | enforced in the path rules; fixture planned |
| A5 | No unauthenticated discovery document and no OAuth metadata, because MCP clients act on it after a 401 | M4 | planned |
| A6 | Per-token budgets, so one looping agent gets 429 without starving another token or device sync; failed authentication rate-limited separately | M4 | planned |
| A7 | Every agent mutation is audited (actor, tool, server time, paths, before and after versions), its displaced versions pinned, and undoable as a unit | oplog, pins, undo (M5) | planned |
| A8 | Bearer tokens and note bodies never appear in logs or the audit record | review rule; tests (M4, M5) | planned |

### Transport and host

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| T1 | TLS in front of the server (Tailscale Serve, Caddy); device tokens and note contents cross the network | `docs/server.md` (M9) | documented |
| T2 | `/mcp` behind Tailscale or an identity-aware proxy; a warning when `--mcp` listens on a wildcard address | M4 | planned |
| T3 | The service runs as its own user with a private data directory; the container image is scratch, read-only, capabilities dropped | `trewd service`, `compose.yaml` (inherited from Basalt) | enforced for the unit and image |
| T4 | Chunk names, paths, credentials and note bodies stay out of logs and metric labels | review rule; M5.5 observability tests | planned |

### Clients

| # | Requirement | Enforced by | Status |
|---|---|---|---|
| D1 | A client refuses inbound paths it could not hold safely: dot segments, staging names, and on Windows the names Windows reserves, each as a visible stranded path, never a retried write error | engine `refusedInboundPath`, with the Windows rule from `client/src/core/windows-names.ts` when the plugin or headless client runs on Windows; `client/src/core/windows-inbound.test.ts` | enforced |
| D2 | The plugin never adds client-side error reporting or telemetry (the community directory forbids it) | review rule (M9 lint gate) | documented |
| D3 | An invite link never pairs by itself: the modal shows the server address the invite names, warns when it differs from the configured one, and changes nothing until confirmed | plugin (M2) | planned |

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
still **planned** without a milestone that owns it.
