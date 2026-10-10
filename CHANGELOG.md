# Changelog

What changed in TrewSync, newest first, for people running it. The server,
the Obsidian plugin and the command-line client are released separately
(`server/vX.Y.Z`, `X.Y.Z` and `cli/vX.Y.Z` tags), and each GitHub release
carries its own notes with upgrade steps. This file collects them in one place
and records what is merged but not yet released.

Protocol compatibility, not release numbers, decides whether a server and a
client can talk; upgrade the server first.

## Unreleased

Nothing yet.

## 0.12.1, server and plugin (2026-10-09)

Released together, so that BRAT installs the plugin again.

### Plugin

- **BRAT installs and updates the plugin again.** BRAT installs from the
  release with the highest version in its tag name, server releases included,
  so from server/v0.12.0 on it tried to install the plugin from the server's
  release, found no manifest.json, and failed with "This does not seem to be an
  obsidian plugin". 0.12.1 is the plugin's own release again. If BRAT showed
  that error, check for updates once more.
- When a `wss://` address does not connect, the hint says to pair from an
  invite naming `ws://HOST`, made with `trewd invite -url`, instead of to type
  an address that nothing takes.
- The notice shown when Obsidian's keychain refuses the device token names the
  vault's own configuration folder, not always `.obsidian`.
- main.js carries the copyright notices of fflate and diff-match-patch, which
  it bundles.

### Server

- **`trewd` with no command lists the commands** instead of starting a
  server. Serving is always `trewd serve`; flags with no command are refused
  and point at it. Every shipped way of running the server (the container
  image, the unit `trewd service` prints, the Homebrew service) already says
  `serve`, so nothing deployed changes.
- An encrypted backup (`trewd backup -recipients`) of a data directory given
  as a relative path, `-data ./trew-data`, works. It failed after staging.
- The invite a server prints at its first start says when the addresses in it
  are guesses, because the server was started without `-url`, and how to make
  the one to paste: `trewd invite -url wss://NAME`.
- `trewd doctor`'s advice on rehearsing a restore mentions `-identity` for an
  encrypted backup, `trewd service` prints notes whose commands work as
  printed, and `trewd`'s help no longer shows a quoted command as a flag's
  argument.

## 0.12.0 and earlier

TrewSync's first release, forked from Basalt Sync 0.10.0 (protocol 7). It is a
fresh start rather than an upgrade: a Basalt device, invite or recovery key
does not work with a TrewSync server, and moving a vault is a new pairing.

### Fixed in the 2026-10-06 review

A full review of the server, the sync engine, the plugin and the headless
client; the IDs are in [docs/findings.md](docs/findings.md).

- **A restored or renamed-back note is no longer deleted again** on every
  device after a deletion both sides had made, or a rename whose
  acknowledgement was lost (T01).
- **A text update cut short on a phone puts the note back** instead of
  uploading the truncated note to every device (T09).
- **A large download batch is no longer written off** as too large when the
  server refuses one ask: the ask is split and sent again (T02).
- **A file dated before 1970 no longer breaks every device's index** (T03).
- **A download is no longer cut off by another device's save** (T55), and a
  slow upload is no longer taken for a dead connection (T56).
- **A phone's first sync is faster** (about 40% fewer filesystem calls per
  note, and the plugin's own writes no longer trigger a second round), and an
  interrupted first sync resumes without asking for the review again (T12).
- **The headless client refuses** a vault folder that was swapped for another
  (an unmounted disk, T16), a filesystem without hard links (T18), and
  compares ignored names case-folded where the disk does (T17); it keeps a
  note's permissions and escapes what it prints to the terminal (T20, T23).
- **Backups and restores:** `trewd backup` no longer overwrites a stopped
  server's data or the age key (T35), every restore starts a new epoch (T27),
  a restored store runs in WAL mode (T26), and a restore keeps the server's
  settings (T38).
- **Agents:** a template note's text can no longer reach an agent as the
  server's own words (T49), and move and delete previews of a well-linked
  note take about 0.1 s instead of seconds (T50).

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

- **`trew search QUERY`** in the command-line client: literal search of the
  vault's notes on the server, by text, file name or tag, with `--folder`,
  `--case-sensitive`, `--context`, `--limit`, `--all` and `--json`. It uses the
  same search as the MCP tool `search_notes`. Matches are highlighted on a
  terminal, and control characters and escape sequences in note text are
  printed spelled out, never sent to the terminal. Protocol 2 gains the
  `search` request, answered for a paired device with a search budget of its
  own (`toomany` when over it) so searching cannot slow another device's sync.
  It needs a server of this release; upgrade the server first.

- **An MCP endpoint in the server** (`trewd serve -mcp`), at `/mcp` on the
  same port. Read tools for any token; exact edits, appends, creates, moves,
  deletions, restores and tag changes for a write token, each one
  all-or-nothing, previewed where it touches more than one note, and
  retryable safely with an idempotency key. Every note-derived string arrives
  under `untrusted_content`. See [Connect an agent](docs/agent.md).
- **Vault health tools for agents.** `backlinks`, `outgoing_links`,
  `broken_links` and `orphans` find links as `move_note` rewrites them (wiki
  names, paths, aliases, embeds, relative and percent-encoded Markdown links),
  report a name several notes share as ambiguous, and page through large
  vaults, reading only the notes that may link when the search index has
  caught up ([Links and vault health](docs/agent.md#links-and-vault-health)).
- **Daily-note and template tools for agents.** `today_note`,
  `append_to_daily` (optionally under a heading) and `create_from_template`,
  with Obsidian's `{{title}}`, `{{date}}` and `{{time}}` placeholders. The
  daily-note folder, format and template, the templates folder and the time
  zone are keys of the configuration file (`trewd config set daily.folder
  Journal`) and `trewd serve` flags (`-daily-folder`, `-daily-format`,
  `-daily-template`, `-templates-folder`, `-template-date-format`,
  `-template-time-format`, `-timezone`), because Obsidian's own settings live
  in `.obsidian/`, which never syncs
  ([Daily notes and templates](docs/agent.md#daily-notes-and-templates)).
- **A configuration file**, `trewd.json` in the data directory, mode 0600,
  written by `trewd config set KEY VALUE` through the running server, which
  checks the value and uses it at once. A `serve` flag wins over the file, the
  file over the default, so a unit or compose file needs none of these flags
  ([Configuration file](docs/server-reference.md#configuration-file)).
- **A Git history of the vault** (`trewd git-export set`), off by default: a
  bare repository in the data directory, one commit per agent operation and
  one per quiet run of a device's edits, dated by the server, attachments over
  10 MiB in Git LFS, pushed with a lease to a remote reached with a deploy key
  or a single-repository token. It is never read back, never delays a write,
  and refuses rather than repairs a branch changed outside it. Exported
  history is plaintext and `trewd purge` cannot remove it
  ([Keep a Git history](docs/git-export.md)).
- **The Git export can continue an existing backup branch**, such as the
  `main` the Obsidian Git plugin has been committing to: `trewd git-export
  adopt` shows the branch's tip, and `trewd git-export adopt SHA`, given that
  commit back, makes the export's first commit a child of it, so the old
  history stays beneath and the first push is a fast-forward. Nothing is
  force-pushed or rewritten, the old history is not moved to LFS, and a
  rebuild makes the same commits. Without adoption the export still refuses a
  branch it did not make
  ([Continue an existing backup branch](docs/git-export.md#continue-an-existing-backup-branch)).
- **The container image is Alpine with git, git-lfs and ssh**, for the Git
  export, instead of `scratch`; the Nix package puts the same three on the
  server's PATH, and the Homebrew formula depends on git-lfs.
- **Tokens for agents** (`trewd mcp-token`): read scope by default, 90-day
  expiry by default, listed with use counts, revocable while the server runs.
  `-key-out` writes a token only to a new file and refuses one that exists;
  a token whose file could not be written is revoked at once.
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
