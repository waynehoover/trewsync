# Security and privacy

[Documentation](index.md) · [Plugin guide](plugin.md)

Telimus is designed for one person's trusted devices and a server they control.
It encrypts note contents and filenames before uploading them. Your local vault
remains ordinary, readable files, so your device's security matters too.

## What the server can see

The server stores encrypted notes and filenames without the keys needed to
read them. It can see file sizes, timestamps, activity, device labels, how long
each filename is, and when encrypted pieces repeat. Encryption does not hide all
metadata.

Use a secure `wss://` connection, normally through Tailscale Serve or a TLS
proxy. Note encryption alone does not protect the device credentials sent over
an unencrypted connection. [Server setup](server.md#secure-access) covers this step.

## Keep your recovery key

Your first device shows a recovery key during setup. Keep it somewhere safe,
separate from your devices and server backup. Anyone holding it can add a
device and access the vault.

Use an invite to add devices during normal use. An invite works once and
expires after ten minutes by default. If every device is lost, use the recovery
key to pair a replacement. Telimus cannot recover that key for you.

A paired device keeps the credentials it needs to sync and decrypt your notes
locally. Protect device accounts, disks, and copies of the plugin or CLI state.

## If a device is lost or stolen

1. Open **Manage this vault → Devices** on another paired device and revoke
   the missing device.
2. Review the device list and outstanding invites. Revoke unfamiliar devices
   and cancel invites you no longer trust.
3. If the recovery key may also have been exposed, use **Replace the vault's
   secret** and save the new recovery key.

Revocation stops access through your server. It cannot erase notes or keys
already copied from the device. A revoked device still holds the data key and
can decrypt later encrypted content if it obtains that content elsewhere.

Replacing the vault's secret invalidates the old recovery key and outstanding
invites. It **does not** change the data-encryption key, re-encrypt history, or
revoke existing devices. These limits apply even after you complete the steps
above.

## What encryption does not guarantee

Telimus checks that received content and its protected metadata authenticate
under the vault's key. A server without that key cannot create arbitrary valid
note content. It can still withhold updates or replay a previously valid
version. Telimus does not fully detect those actions.

Paired devices are trusted to change the vault and invite other devices. Telimus
is not a system for sharing notes with people you do not trust. The CLI's
read-only mode controls that client's sync behavior; it is not a restricted
server credential.

## HTTP access for an agent

`telimus mcp --listen` exposes readable notes from a paired device. The MCP client
and any model service it uses can receive plaintext note content. Whoever
terminates the HTTPS connection can see that content and the bearer credential.
This differs from the sync relay, which receives encrypted notes.

Keep the listener on loopback and put a trusted TLS proxy in front of it.
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) terminates
TLS on the serving machine and restricts reachability to the tailnet and its
network policy. The MCP bearer remains mandatory. A **Cloudflare Tunnel exposes
plaintext notes to Cloudflare's TLS termination**. If you choose that arrangement,
put an identity check such as Cloudflare Access in front of it and keep MCP's
own bearer check. Forwarded identity or IP headers never authenticate to Telimus.

Generate the separate random credential with `telimus mcp-token`. Keep it in the
client's authentication configuration, outside the notes it can read. With
`--key-out`, the CLI creates a new private file outside the vault and prints
only its id and path. The server stores a SHA-256 hash in unsynced `.telimus`
state. A missing credential refuses access, as does an unreadable or malformed
record. There is no auth bypass, OAuth server, multi-user account system or
per-tool token scope.

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

Keep a backup of your readable local notes as well as the server's encrypted
history. A server backup needs a paired device or the recovery key to read it.
Sync propagates changes, including deletions; it is not an independent backup.

See [backup and restore](server-operations.md#backup) for the server procedure.
For the cryptographic construction and filesystem assumptions, see the
[technical design](design.md).
