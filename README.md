# <img src="docs/assets/logo.svg" width="40" height="40" align="top" alt=""> TrewSync

**Self-hosted vault sync with full version history, on a server you run.**

TrewSync keeps your notes in sync through a server you control, and that server
keeps every earlier version. Keep writing offline, catch up when you reconnect,
and recover earlier versions from inside Obsidian.

[![CI](https://github.com/waynehoover/trew/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/trew/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/trew-sync?logo=npm&label=trew-sync)](https://www.npmjs.com/package/trew-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[Get started](docs/server.md)** · [How it compares](docs/compared.md) · [Documentation](docs/index.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/panel-dark.png">
  <img src="docs/assets/screenshots/panel.png" alt="TrewSync's simple sync panel." width="700">
</picture>

## Made for your personal vault

- **Host it where you want.** Run a Docker container or a standalone server
  binary on your homelab. TrewSync is free, open-source software; you provide the
  hosting and backups.
- **No key to lose.** The server keeps your notes and their history, so losing
  every device loses no synced note: pair a new device from the server. The
  price is that the server can read them; see [Privacy](#privacy).
- **Send less when you edit.** TrewSync uploads changed pieces of a file and
  reuses the rest, reducing transfers and storage across versions.
- **Recover your work.** Browse history, compare changes, and restore deleted
  notes. Restoring creates a separate copy when a file already exists.
- **Handle conflicting edits.** TrewSync combines edits when its merge checks
  pass and keeps both versions when they do not. Review preserved copies
  together and choose what to keep.
- **Add devices with an invite.** Scan a QR code or copy a pairing code. There
  is no fixed device limit, and you can revoke a lost device from another one
  or from the server.

## Get started

**Run TrewSync behind Tailscale Serve or an HTTPS reverse proxy.** Tailscale Serve
is the recommended option for a personal homelab: only your permitted Tailscale
devices can reach it. You can also use Caddy or an existing HTTPS proxy with your
own domain. Keep TrewSync's port 3003 private.

1. **[Set up your server](docs/server.md).** Run TrewSync, follow the
   [secure connection setup](docs/server.md#secure-access), and make an
   invite for your first device.
2. **[Install the Obsidian plugin](docs/plugin.md#install).** Paste the invite
   into TrewSync and press **Pair**.
3. **[Add your other devices](docs/plugin.md#pairing).** Create an invite, then
   scan its QR code or paste the pairing code into TrewSync on the next device.
   An invite works once and expires after one hour.

**Prefer to have your agent handle setup?** Give it [llm.md](llm.md). The guide
covers the server, plugin, pairing, and checks that sync works.

For a NAS or a machine without Obsidian, the experimental
**[command-line client](client/README.md)** can keep a local mirror.

## Before you choose TrewSync

TrewSync is an early project for one person's devices. The supported setup is
Obsidian on **macOS, Linux, and Android**, with local storage. The plugin needs
Obsidian **1.7.2 or newer** and is installed manually. iOS is untested; Windows
is not supported.

### Platforms

| Platform | Status | What that means |
|---|---|---|
| macOS | Supported | The tests run here. |
| Linux | Supported | The tests run here. |
| Android | Supported | Sync runs while Obsidian is open in the foreground. |
| iOS | Untested | The same code as on Android, but no test has run on an iPhone or iPad: background suspension, iCloud Drive vaults and the iOS file system are untested. The plugin pairs, and says so in its panel for as long as it runs. |
| Windows | Not supported | No test runs on Windows. The plugin pairs, and says so in its panel and status bar for as long as it runs. A note whose name Windows cannot hold (a device name such as `CON` or `COM1`, one of the characters Windows forbids, or a name ending in a dot or a space) is listed as needing attention instead of syncing, and stays on your other devices. |

On Android, sync runs while Obsidian is open in the foreground. Settings,
themes, plugins, and hidden files do not sync: nothing whose name starts with a
dot does, so an `.attachments` folder stays on the device that has it.
Attachments elsewhere are included, with a default limit of **64 MiB per file**.

Use one sync service per local vault, and keep it off network filesystems.
TrewSync needs you to maintain the server and keep backups. See
**[How it compares](docs/compared.md)** if you prefer a hosted service or need
different storage options.

## Privacy

**The server reads your notes.** TrewSync has no end-to-end encryption: the server
holds every note, every earlier version and every filename in plaintext, and
so does every backup of it. Anyone who can read the server's disk or a backup
can read your vault. Put the data directory and your backups on encrypted
storage, and keep the connection behind TLS, which protects your notes and
device credentials in transit. If you need a server that cannot read what it
stores, choose an end-to-end encrypted service instead;
[Security and privacy](docs/security.md) says what TrewSync does and does not
protect.

## Find what you need

| I want to… | Guide |
|---|---|
| Set up TrewSync with an agent | [Agent installation guide](llm.md) |
| Run TrewSync on my server | [Server setup](docs/server.md) |
| Pair devices or recover a note | [Obsidian plugin](docs/plugin.md) |
| Back up, restore, or free server space | [Server maintenance](docs/server-operations.md) |
| Keep a copy without Obsidian | [Command-line client](client/README.md) |
| Understand what the server can read | [Security and privacy](docs/security.md) |
| Build or contribute | [Developer documentation](docs/development.md) |

## License

[MIT](LICENSE).
