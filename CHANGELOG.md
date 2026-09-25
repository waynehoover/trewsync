# Changelog

What changed in TrewSync, newest first, for people running it. The server,
the Obsidian plugin and the command-line client are released separately
(`server/vX.Y.Z`, `X.Y.Z` and `cli/vX.Y.Z` tags), and each GitHub release
carries its own notes with upgrade steps. This file collects them in one place
and records what is merged but not yet released.

Protocol compatibility, not release numbers, decides whether a server and a
client can talk; upgrade the server first.

## Unreleased

TrewSync's first release, forked from Basalt Sync 0.10.0 (protocol 7). It is a
fresh start rather than an upgrade: a Basalt device, invite or recovery key
does not work with a TrewSync server, and moving a vault is a new pairing.

### Changed from Basalt Sync

- **No end-to-end encryption.** The server stores notes, their history and
  their names in plaintext. There is no recovery key, root secret or key
  rotation; losing every device loses no synced note, and `trewd invite` on the
  server pairs a new one. Put the data directory and backups on encrypted
  storage ([Privacy](README.md#privacy)).
- **Invites.** Every device, the first included, pairs from a single-use
  `trew1i_` invite that carries the server's address and the vault's name. An
  invite expires after one hour by default. A server with no devices writes
  the first one to `first-invite` in its data directory, never to its log.
- **The device token is kept in Obsidian's keychain** on Obsidian 1.11.4 and
  later, not in the plugin's `data.json`, so a backup or synced copy of the
  vault cannot connect as the device. Older Obsidian keeps it in `data.json`.
  A copy, a renamed vault or a cleared keychain asks to pair again and loses
  no note.
- **Names.** The product is TrewSync; the server's command is `trewd`, the
  headless client's is `trew`, the plugin id and npm package are `trew-sync`.
- **Paths.** The server refuses a path Obsidian could not hold everywhere
  (over 1,024 bytes, control characters, a no-break space, any segment
  starting with a dot, and a few more) and a path that differs from another
  live one only by letter case. A refused file stays on its device and is
  listed with its reason.
- **Folders.** Deleting or renaming a folder now removes it from other
  devices once it is empty there; a folder that still holds something stays.
- **Conflict copies** are named after the author of the bytes they hold:
  another device's name, or an agent token's label.
- **One MCP, on the server.** The headless client's own MCP server and its
  credential, inherited from Basalt Sync as `trew mcp` and `trew mcp-token`,
  are removed, with their flags
  (`--listen`, `--writable`, `--allow-origin`, `--vault`, `--key-out`,
  `--revoke`). Both commands exit 2 and point at the server's `/mcp`. Start
  the server with `-mcp`, mint a token with `trewd mcp-token`, and point the
  agent at `/mcp` ([Moving from `trew mcp`](docs/agent.md#moving-from-trew-mcp)).
  The client's `trew.mjs` is about a quarter of its former size.

### Added

- **An MCP endpoint in the server** (`trewd serve -mcp`), at `/mcp` on the
  same port. Read tools for any token; exact edits, appends, creates, moves,
  deletions, restores and tag changes for a write token, each one
  all-or-nothing, previewed where it touches more than one note, and
  retryable safely with an idempotency key. Every note-derived string arrives
  under `untrusted_content`. See [Connect an agent](docs/agent.md).
- **Tokens for agents** (`trewd mcp-token`): read scope by default, 90-day
  expiry by default, listed with use counts, revocable while the server runs.
- **Audit and undo.** `trewd audit` lists every agent write and every undo;
  `trewd undo OPID` reverses one, or writes what it replaced as copies. The
  plugin's version history offers **Undo this change** on an agent's version,
  and an agent can undo its own writes. A version an agent's write displaced
  is kept at least 30 days whatever purge is asked to do.
- **Protocol 2**, which is protocol 1 with undo. The server speaks both, so a
  client of protocol 1 keeps working against an upgraded server.
- **Windows and iOS pair**, with a standing notice in the panel that Windows is
  not supported and iOS is untested, and names Windows cannot hold listed as
  needing attention instead of syncing.
- **`trewd cat` and `trewd export`** read a note or one version straight from
  the store, with nothing but the server.
