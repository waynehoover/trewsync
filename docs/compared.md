# Is TrewSync right for you?

[Documentation](index.md) · [Get started](server.md)

Choose TrewSync if you want to sync a personal Obsidian vault through your own
server, with version history, and an agent that reads and edits the same notes
through that server, and you are content for the server to read your notes.
You run one server and add your devices with invites.

The biggest choice is how much you want to manage yourself.

## Three ways to sync

| | TrewSync | Obsidian Sync | Self-hosted LiveSync |
|---|---|---|---|
| Hosting | Your TrewSync server | Managed by Obsidian | Your chosen backend, including CouchDB or S3-compatible storage |
| Setup | Run the server, install the plugin manually, pair devices | Subscribe and set up Sync in Obsidian | Install the plugin and configure a supported backend |
| File scope | Notes and attachments; Obsidian's own settings, themes and snippets per device when turned on | Notes, attachments, and configurable vault settings | Notes and attachments, with options for settings, themes, and plugins |
| End-to-end encryption | **None.** Your server holds notes and their history in plaintext; TLS protects them in transit | Available, and on by default for new vaults | Available |
| MCP endpoint for agents | Built into the server: read tools with any token; exact edits, moves and tag changes with a write token, each recorded and undoable | None built in | None built in |
| Cost model | Free MIT software; you cover hosting and maintenance | Subscription | Open-source software; hosting costs depend on your setup |

Obsidian's [Sync overview](https://obsidian.md/sync),
[encryption guide](https://obsidian.md/help/sync/security), and
[settings guide](https://obsidian.md/help/sync/settings), and the
[LiveSync documentation](https://github.com/vrtmrz/obsidian-livesync) describe
those options. Comparison checked September 10, 2026; see their documentation
for current plans and features. The MCP endpoint row was added on
September 24, 2026 without re-checking those pages; check them before relying
on it.

## What you get with TrewSync

**Control over where your notes live.** Run the server on a machine you manage.
It stores your notes and their history readable, so protect its disk and its
backups as you would the notes themselves; there is no key to lose, and a lost
device loses no synced note.

**Less data to transfer after edits.** TrewSync reuses unchanged pieces of a file
across versions. This is useful for notes you edit often, especially larger
ones. LiveSync also uses chunking; it is not unique to TrewSync.

**Recovery inside Obsidian.** Browse a note's history, compare versions, and
restore a copy. When edits cannot be merged, TrewSync keeps both versions for you
to review. History stays until you explicitly purge it on the server.

**An agent on the same notes.** The server's MCP endpoint lets an agent such
as Claude Code read, search and compare versions of every note, and with a
write token edit them. Its edits are ordinary versions: history keeps what they
replaced and you can undo them. This is only possible because the server reads
your notes. An MCP server that reads a local vault folder works with any sync
service, TrewSync's included, but it is a second writer beside the sync and
has none of the server's history or undo.

**A focused setup.** One server per vault, no fixed device limit, and a panel for
sync and recovery. There is no database service to install alongside TrewSync.

## When another option fits better

- **Choose Obsidian Sync if you want someone else to run the service.** It also
  supports iOS and Windows, which are outside TrewSync's supported setup.
- **Consider LiveSync if you want storage choices or plugin sync.** It offers
  a broader set of backends and plugin features.
- **Choose either of those if the server must not read your notes.** Both
  offer end-to-end encryption; TrewSync does not, and its agent endpoint,
  once a token exists, sends what the agent reads to the agent's model
  provider.
- **Try TrewSync if you already run a homelab and want a focused personal sync
  service.** Be comfortable maintaining it and keeping independent backups.

TrewSync is early. Its supported devices are macOS and Linux desktops and Android;
Android sync runs while Obsidian is open. iOS is untested. The command-line
client is experimental. Obsidian's own settings, themes and snippets sync only
where you turn settings sync on; plugins and other hidden files do not sync,
and files are limited to 64 MiB by default.

This page makes no speed ranking between products. Historical performance
measurements and implementation credits are in the
[engineering notes](research.md), with their methods and limits.

**[Set up TrewSync](server.md)** · [Read the plugin guide](plugin.md) · [Security and privacy](security.md)
