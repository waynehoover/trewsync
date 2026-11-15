# Is TrewSync right for you?

[Documentation](index.md) · [Get started](server.md)

TrewSync fits if you want to sync a personal vault through your own server,
keep every version of every note, and let an AI agent read and edit the same
notes, and you accept that the server can read them.

## Three ways to sync

| | TrewSync | Obsidian Sync | Self-hosted LiveSync |
|---|---|---|---|
| Hosting | Your TrewSync server | Managed by Obsidian | Your chosen backend, including CouchDB or S3-compatible storage |
| Setup | Run the server, install the plugin from Community plugins, pair devices | Subscribe and set up Sync in Obsidian | Install the plugin and configure a supported backend |
| File scope | Notes and attachments; Obsidian's own settings, themes and snippets per device when turned on | Notes, attachments, and configurable vault settings | Notes and attachments, with options for settings, themes, and plugins |
| End-to-end encryption | **None.** Your server holds notes and their history in plaintext; TLS protects them in transit | Available, and on by default for new vaults | Available |
| MCP endpoint for agents | Built into the server: read tools with any token; exact edits, moves and tag changes with a write token, each recorded and undoable | None built in | None built in |
| Cost model | Free MIT software; you cover hosting and maintenance | Subscription | Open-source software; hosting costs depend on your setup |

Sources: Obsidian's [Sync overview](https://obsidian.md/sync),
[encryption guide](https://obsidian.md/help/sync/security) and
[settings guide](https://obsidian.md/help/sync/settings), and the
[LiveSync documentation](https://github.com/vrtmrz/obsidian-livesync), checked
September 10, 2026. The MCP row was added on September 24, 2026 without
re-checking those pages. Plans and features change, so check them yourself
before relying on this table.

## What you get with TrewSync

- **Your notes on your machine.** The server runs where you choose and stores
  notes and their history readable. Protect its disk and backups as you would
  the notes themselves. There is no key to lose, and a lost device loses no
  synced note.
- **Recovery inside Obsidian.** Browse a note's history, compare versions and
  restore a copy. Edits that cannot be merged are both kept for you to
  review. History stays until you purge it on the server.
- **An agent on the same notes.** Through the server's MCP endpoint an agent
  such as Claude Code reads, searches and compares versions of every note,
  and edits them with a write token. Its edits are ordinary versions: history
  keeps what they replaced, and you can undo them. An MCP server that reads a
  local vault folder works with any sync service, TrewSync included, but it
  is a second writer beside the sync, with none of the server's history or
  undo.
- **Less to transfer.** Unchanged pieces of a file are reused across
  versions, which helps with large notes you edit often. LiveSync chunks
  files too; this is not unique to TrewSync.
- **Little to run.** One server per vault, no fixed device limit, and no
  database service to install beside it.

## When another option fits better

- **You want someone else to run it:** Obsidian Sync. It also supports iOS
  and Windows, which are outside TrewSync's supported setup.
- **You want a choice of storage, or plugin sync:** LiveSync has a broader
  set of backends and plugin features.
- **The server must not read your notes:** either of those. Both offer
  end-to-end encryption. TrewSync does not, and once an MCP token exists,
  what the agent reads goes to the agent's model provider.

TrewSync suits someone who already runs a homelab, is comfortable maintaining
a server, and keeps independent backups.

## Limits today

TrewSync is early.

- Supported devices are macOS and Linux desktops and Android. Android syncs
  while Obsidian is open. iOS is untested.
- The command-line client runs on macOS and Linux only.
- Obsidian's own settings, themes and snippets sync only where you turn
  settings sync on. Plugins and other hidden files do not sync.
- Files are limited to 64 MiB by default.

## Why TrewSync exists

TrewSync is a fork of [Basalt Sync](https://github.com/waynehoover/basalt-sync),
an end-to-end encrypted sync for Obsidian built around one rule: do not lose a
note. Because Basalt's server could not read anything, an agent there needed
a second paired copy of the vault on its own machine, with its own sync loop.

Dropping end-to-end encryption moves the agent into the server. An agent's
edit is an ordinary version in the history your devices use: checked against
the version the agent read, kept for undo, and delivered to every device like
any other change. Everything else carries over from Basalt: the sync engine,
conflict handling, recovery screens, and the
[eleven durability rules](design.md#the-durability-rules) its tests hold the
code to.

The price is that the server reads your notes
([Security and privacy](security.md)). If that is the wrong trade,
[another option fits better](#when-another-option-fits-better).

This page does not rank products by speed. Performance measurements and
implementation credits are in the [engineering notes](research.md), with
their methods and limits.

**[Set up TrewSync](server.md)** · [Read the plugin guide](plugin.md) · [Security and privacy](security.md)
