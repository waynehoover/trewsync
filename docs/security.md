# Security and privacy

[Documentation](index.md) · [Plugin guide](plugin.md)

Trew is designed for one person's trusted devices and a server they control.
**The server can read your notes.** It stores their contents, their filenames
and every earlier version in plaintext. That is deliberate: it is what lets the
server check everything it holds, hand a note back with nothing but the server
itself (`trewd cat`), and host the planned built-in agent that reads and edits
the same notes. There is no end-to-end encryption. If you need a server that
cannot read what it stores, Trew is the wrong tool.

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
- Keep backups on encrypted storage too, including backups that stay on the
  same machine.
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

A paired device keeps its credential locally. Protect device accounts, disks,
and copies of the plugin's or the command-line client's state: a copy of that
state can connect as the device until you revoke it.

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

## What Trew does not protect against

- **A compromised server host.** It holds every note readable, by design.
- **The server's word.** Devices trust the server about what a note says and
  about which device wrote a version. Basalt Sync, which Trew is forked from,
  authenticated every entry under a key the server never had, so a device could
  refuse a note the server made up; Trew has no such check. The server can
  also withhold updates or replay an older version.
- **A paired device.** Every paired device is trusted to change any note and to
  invite other devices. Trew is not a system for sharing notes with people you
  do not trust. The CLI's read-only mode controls that client's sync behavior;
  it is not a restricted server credential.

## HTTP access for an agent

`trew mcp --listen` exposes readable notes from a paired device. The MCP client
and any model service it uses can receive plaintext note content. Whoever
terminates the HTTPS connection can see that content and the bearer credential.
The sync server already holds the same notes; the difference is who else sees
them: the agent, its model provider, and whatever sits in front of the
listener.

Keep the listener on loopback and put a trusted TLS proxy in front of it.
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) terminates
TLS on the serving machine and restricts reachability to the tailnet and its
network policy. The MCP bearer remains mandatory. A **Cloudflare Tunnel exposes
plaintext notes to Cloudflare's TLS termination**. If you choose that arrangement,
put an identity check such as Cloudflare Access in front of it and keep MCP's
own bearer check. Forwarded identity or IP headers never authenticate to Trew.

Generate the separate random credential with `trew mcp-token`. Keep it in the
client's authentication configuration, outside the notes it can read. With
`--key-out`, the CLI creates a new private file outside the vault and prints
only its id and path. The serving directory stores only a SHA-256 hash, in
unsynced `.trew` state. A missing credential refuses access, as does an
unreadable or malformed record. There is no auth bypass, OAuth server,
multi-user account system or per-tool token scope.

HTTP exposes read-only tools by default; `--writable` explicitly enables the
existing guarded mutations on a writable device. This launch policy applies
to every client using its one credential. It does not restrict the serving
device's own sync credential or prevent incoming sync from changing files.

Rerun `mcp-token` to rotate, or use `mcp-token --revoke` to revoke without stopping
the service. Once a request observes the change, old sessions end and queued
old-key operations are cancelled. An admitted edit still finishes its preservation
transaction. Rotation cannot retract notes already received by a client or model.
Read any uncertain result before trying another edit.

The [service example](../client/README.md#connect-over-http) describes the intended
Tailscale arrangement. Real Tailscale, Cloudflare and phone-client acceptance
have not been exercised for this release.

## Backups still matter

Sync propagates changes, including deletions; it is not an independent backup.
Keep a backup of your readable local notes as well as server backups, and
remember that a server backup is a complete readable copy of your vault and
its history.

See [backup and restore](server-operations.md#backup) for the server procedure.
For the threat model and the filesystem assumptions, see the
[technical design](design.md) and the [threat model](threat-model.md).
