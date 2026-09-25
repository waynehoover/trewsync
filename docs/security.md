# Security and privacy

[Documentation](index.md) · [Plugin guide](plugin.md)

TrewSync is designed for one person's trusted devices and a server they control.
**The server can read your notes.** It stores their contents, their filenames
and every earlier version in plaintext. That is deliberate: it is what lets the
server check everything it holds, hand a note back with nothing but the server
itself (`trewd cat`), and host the built-in agent endpoint that reads and
edits the same notes. There is no end-to-end encryption. If you need a server that
cannot read what it stores, TrewSync is the wrong tool.

## What the server holds

Everything a device syncs: current notes and attachments, every version still
in history (deleted notes included), filenames and folder names, sizes,
timestamps, device names and activity. It is not only the files you meant,
either: the database's write-ahead log, temporary files, filesystem snapshots,
crash dumps, a copied volume, and every backup hold the same notes.

Anyone who can read the server's data directory, or a backup of it, can read
your vault. So:

- Keep the data directory on encrypted storage, such as LUKS, FileVault or ZFS
  native encryption, and write down where its key lives and how the machine
  unlocks it after a restart.
- Backups are encrypted to a key you keep off the server: `trewd backup`
  writes a plaintext copy only when told `-plaintext-ok`, and that one belongs
  on encrypted storage too, even when it stays on the same machine.
- Treat anyone who can log in to the server host as someone who can read your
  notes.

Encrypting the disk protects a disk that is taken or thrown away. It does
nothing against someone on the running server, which holds the notes readable
by design.

## Use a secure connection

Use a `wss://` address, normally through Tailscale Serve or a TLS proxy. Your
notes and your devices' credentials both cross the network, and over plain
`ws://` anyone on the path can read them.
[Server setup](server.md#secure-access) covers this step.

## Devices and invites

Each device connects with its own random credential. The server stores only a
SHA-256 hash of it, so the server's database alone does not let anyone connect
as your phone.

A device joins by redeeming an invite: a single-use string starting `trew1i_`
that carries a random token, the server's address and the vault's name. An
invite works once and expires after one hour by default. Until it is used,
whoever holds it can add their own device, so hand it over privately, and
cancel one you no longer need under **Devices** or with `trew uninvite`.

There is no recovery key. Your notes and their history live on the server, so
losing every device loses no synced note: run `trewd invite` on the server to
pair a new one. That also means shell access to the server host is access to
the vault.

A paired device keeps its credential locally. In Obsidian 1.11.4 and later the
plugin keeps it in Obsidian's keychain, which the operating system protects
(the macOS Keychain, Windows DPAPI, libsecret on Linux, the iOS Keychain or the
Android Keystore), and not in the vault folder, so a backup or synced copy of
the vault or its `.obsidian` folder does not carry it and cannot connect as the
device. It leaves `data.json` only once a restart of Obsidian finds it in the
keychain, so until the first restart after pairing a copy of `.obsidian`
still carries it. On an older Obsidian, or when the keychain fails to read the
token back, it stays in the plugin's `data.json` inside `.obsidian`. The
command-line client keeps it in its `0600` config file. Protect device
accounts, disks and copies of that state: a copy of a credential can connect
as the device until you revoke it.

On a desktop where Obsidian cannot encrypt the keychain (some Linux setups
without a secret service), Obsidian keeps it unencrypted in its own storage and
warns once. The token is then still out of the vault folder, but only as safe
as your user account.

## If a device is lost or stolen

1. Open **Manage this vault → Devices** on another paired device and revoke
   the missing device. On the server, `trewd devices` lists devices and
   `trewd revoke -data DIR DEVICE_ID` does the same.
2. Review the device list and outstanding invites. Revoke unfamiliar devices
   and cancel invites you no longer trust.

Revoking stops the device receiving and sending changes at once, and cancels
the invites it had created, so an invite made on a stolen laptop cannot add
the thief's next device. It cannot un-read anything: the device keeps every
note it had already synced, in plaintext, and whoever holds it can read them.
You may revoke the last device; `trewd invite` on the server is the way back.

If you later restore the server from a backup taken before the revocation, the
revoked device is in the restored device list again. Revoke it again after the
restore.

## What TrewSync does not protect against

- **A compromised server host.** It holds every note readable, by design.
- **The server's word.** Devices trust the server about what a note says and
  about which device wrote a version. Basalt Sync, which TrewSync is forked from,
  authenticated every entry under a key the server never had, so a device could
  refuse a note the server made up; TrewSync has no such check. The server can
  also withhold updates or replay an older version.
- **A paired device.** Every paired device is trusted to change any note and to
  invite other devices. TrewSync is not a system for sharing notes with people you
  do not trust. The CLI's read-only mode controls that client's sync behavior;
  it is not a restricted server credential.

## An agent's token

A token from `trewd mcp-token` opens the server's MCP endpoint to an agent.
[Connect an agent](agent.md) is the full guide; what matters for privacy:

- **It reads the whole vault.** There is no per-note or per-folder read
  control. A write token can also change any note outside the dot-prefixed
  folders.
- **What the agent reads reaches its model provider.** Every note, search
  result and diff a tool returns goes to the agent, and from there to whoever
  runs its model. Revoking the token cannot take back what was already read.
- **The token is the only lock on `/mcp`.** Keep the endpoint behind Tailscale
  or an identity-aware proxy, never on an open port. The server stores only
  the token's SHA-256, shows it once, and records how often and when each
  token was used (`trewd mcp-token -list`).
- **Whoever terminates TLS sees the notes and the token.** Tailscale Serve
  terminates it on your own machine. A **Cloudflare Tunnel terminates it at
  Cloudflare**, which then sees every note an agent reads; if you choose one,
  put an identity check such as Cloudflare Access in front of it as well.
  Forwarded identity or address headers never authenticate to TrewSync.
- **Tokens expire**, after 90 days by default. Revoke one with
  `trewd mcp-token -revoke ID`; a request it has in flight is refused before
  it is answered.
- **Read scope is the default.** A write token is made only with
  `-scope write`, and every write it makes is recorded with its label, keeps
  what it replaced for at least 30 days, and can be undone (`trewd audit`,
  `trewd undo`).
- **Notes can carry instructions aimed at the agent.** Results keep note text
  apart from the server's own facts and say it is untrusted, but whether the
  agent obeys text it reads is up to the agent. Give write access only to an
  agent you have watched work.

## Backups still matter

Sync propagates changes, including deletions; it is not an independent backup.
Keep a backup of your readable local notes as well as server backups, and
remember that a server backup is a complete copy of your vault and its
history: readable by whoever holds the key it was encrypted to, and by anyone
at all if it was taken with `-plaintext-ok`.

See [backup and restore](server-operations.md#backup) for the server procedure.
For the threat model and the filesystem assumptions, see the
[technical design](design.md) and the [threat model](threat-model.md).
