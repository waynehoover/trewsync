# Is Trew right for you?

[Documentation](index.md) · [Get started](server.md)

Choose Trew if you want to sync a personal Obsidian vault through your own
server, with version history and a small plugin interface, and you are content
for that server to read your notes. You run one server and add your devices
with invites.

The biggest choice is how much you want to manage yourself.

## Three ways to sync

| | Trew | Obsidian Sync | Self-hosted LiveSync |
|---|---|---|---|
| Hosting | Your Trew server | Managed by Obsidian | Your chosen backend, including CouchDB or S3-compatible storage |
| Setup | Run the server, install the plugin manually, pair devices | Subscribe and set up Sync in Obsidian | Install the plugin and configure a supported backend |
| File scope | Notes and attachments | Notes, attachments, and configurable vault settings | Notes and attachments, with options for settings, themes, and plugins |
| Encryption | None end to end: your server holds notes in plaintext; TLS protects them in transit | End-to-end encryption available and enabled by default for new vaults | End-to-end encryption available |
| Cost model | Free MIT software; you cover hosting and maintenance | Subscription | Open-source software; hosting costs depend on your setup |

Obsidian's [Sync overview](https://obsidian.md/sync),
[encryption guide](https://obsidian.md/help/sync/security), and
[settings guide](https://obsidian.md/help/sync/settings), and the
[LiveSync documentation](https://github.com/vrtmrz/obsidian-livesync) describe
those options. Comparison checked September 10, 2026; see their documentation
for current plans and features.

## What you get with Trew

**Control over where your notes live.** Run the server on a machine you manage.
It stores your notes and their history readable, so protect its disk and its
backups as you would the notes themselves; there is no key to lose, and a lost
device loses no synced note.

**Less data to transfer after edits.** Trew reuses unchanged pieces of a file
across versions. This is useful for notes you edit often, especially larger
ones. LiveSync also uses chunking; it is not unique to Trew.

**Recovery inside Obsidian.** Browse a note's history, compare versions, and
restore a copy. When edits cannot be merged, Trew keeps both versions for you
to review. History stays until you explicitly purge it on the server.

**A focused setup.** One server per vault, no fixed device limit, and a panel for
sync and recovery. There is no database service to install alongside Trew.

## When another option fits better

- **Choose Obsidian Sync if you want someone else to run the service.** It also
  supports iOS and Windows, which are outside Trew's supported setup.
- **Consider LiveSync if you want storage choices or configuration sync.** It
  offers a broader set of backends and plugin features.
- **Choose either of those if the server must not read your notes.** Both
  offer end-to-end encryption; Trew does not.
- **Try Trew if you already run a homelab and want a focused personal sync
  service.** Be comfortable maintaining it and keeping independent backups.

Trew is early. Its supported devices are macOS and Linux desktops and Android;
Android sync runs while Obsidian is open. iOS is untested. The command-line
client is experimental. Obsidian settings, themes, plugins, and hidden files do
not sync, and files are limited to 64 MiB by default.

This page makes no speed ranking between products. Historical performance
measurements and implementation credits are in the
[engineering notes](research.md), with their methods and limits.

**[Set up Trew](server.md)** · [Read the plugin guide](plugin.md) · [Security and privacy](security.md)
