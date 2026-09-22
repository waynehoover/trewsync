# Set up your Telimus server

[Documentation](index.md) · [Maintenance](server-operations.md) · [Command reference](server-reference.md)

Run one server for your personal vault, then connect your devices through the
Obsidian plugin. The server stores encrypted notes and history; you provide
storage, a secure connection, and backups.

**Put Tailscale Serve or an HTTPS reverse proxy in front of Telimus.** Your devices
connect to the proxy; Telimus's own port stays private. For a personal homelab,
we recommend [Tailscale Serve](#tailscale-recommended). If you already use a domain
and an HTTPS proxy, [use that instead](#caddy).

You need a Linux or macOS machine with local storage. Docker is the simplest
route. Keep the data directory off NFS, SMB, and other network filesystems.

## Install

### Docker

From a copy of this repository:

```bash
git clone https://github.com/waynehoover/telimus.git
cd telimus-sync
docker compose up -d
docker compose logs telimus
```

The included [compose.yaml](../compose.yaml) pins a server image and its digest,
preserves data in a named volume, and exposes port 3003 only on the host's
loopback interface.

For a quick trial without cloning:

```bash
docker run -d --name telimus --restart unless-stopped --stop-timeout 30 \
  -p 127.0.0.1:3003:3003 -v telimus-data:/data \
  ghcr.io/waynehoover/telimus:latest
docker logs telimus
```

Use the pinned Compose setup for a server you keep. Next, configure
[secure access](#secure-access) before pairing devices.

Named volumes get the required ownership automatically. If you replace one
with a bind mount, create a dedicated empty directory and make it writable by
UID/GID `65532:65532`, the container's user. Keep that directory when upgrading;
removing it removes the server's notes and history.

### A binary

Download the matching binary from a
[server release](https://github.com/waynehoover/telimus/releases?q=server):
Linux amd64/arm64 or macOS amd64/arm64. Make it executable and run it with a
writable data directory:

```bash
chmod +x telimus-linux-amd64
./telimus-linux-amd64 serve -data ./telimus-data -addr 127.0.0.1:3003
```

Use your downloaded filename on macOS. For a persistent Linux service, install
the binary as `/usr/local/bin/telimus`, create a dedicated `telimus` account and
writable `/var/lib/telimus` directory, then run:

```bash
telimus service -data /var/lib/telimus -addr 127.0.0.1:3003 \
  -user telimus -binary /usr/local/bin/telimus
```

This prints a systemd unit and installation commands; review and follow them.
It does not install the service itself. The generated unit includes restart
handling and a 30-second shutdown allowance.

## Secure access

Telimus does not provide HTTPS itself. Tailscale Serve or your reverse proxy
provides the secure connection:

**Your devices → Tailscale Serve or HTTPS proxy → Telimus**

Use the proxy's `wss://` address in the plugin. Keep the raw server port private;
note encryption does not protect device credentials sent over plain `ws://`.

### Tailscale (recommended)

This keeps Telimus accessible only to devices allowed on your Tailscale network,
without a public domain or router port forwarding. Install and connect Tailscale
on the server and each device, including your phone.

On the server, check for existing routes first:

```bash
tailscale serve status
```

If the default HTTPS address is free, publish Telimus there:

```bash
tailscale serve --bg 3003
tailscale serve status
```

Follow any prompt to enable HTTPS. Use the address Tailscale reports, replacing
`https://` with `wss://`, for example `wss://homelab.example.ts.net`. Leave Tailscale
connected on every device when syncing. Use Serve, not Funnel, for tailnet-only
access. See [Tailscale's Serve guide](https://tailscale.com/docs/reference/tailscale-cli/serve).

If another app already uses that address, choose a free HTTPS port with
`tailscale serve --bg --https=8443 3003`, and include `:8443` in the plugin's
address. The final `3003` is Telimus's internal port, not the port you necessarily
enter on your phone.

### Caddy

For an internet-accessible endpoint, point a domain to your server and let Caddy
handle HTTPS. With Caddy running on the same host as Telimus, use:

```caddyfile
sync.example.org {
    reverse_proxy 127.0.0.1:3003
}
```

Reload Caddy and use `wss://sync.example.org`. The usual Caddy setup needs ports
80 and 443 reachable for certificates and HTTPS; keep port 3003 private.
Caddy handles WebSockets automatically. See [Caddy's reverse-proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy).

An existing proxy is fine too: it must provide a trusted HTTPS certificate and
support WebSockets. If the proxy runs in Docker, connect it to Telimus over a
private Docker network; `127.0.0.1` inside the proxy container refers to that
container, not the host.

For a test entirely on one machine, `telimus serve -localhost` provides a
loopback `ws://` address. The first-device token is still required.

## The first device

The first startup log includes a setup string like `HOST:3003#TOKEN`.
Replace the address before `#` with your secure endpoint, keeping the token:

```text
wss://homelab.example.ts.net#TOKEN
```

1. [Install the plugin](plugin.md#install) on your first device.
2. Open Telimus, paste the setup string into **Invite or setup line**, and press
   **Start a new vault**.
3. Save the recovery key somewhere safe and separate, then press
   **I have written it down**.
4. Wait for sync to finish.
5. Use **Add another device → Create invite** for each additional device.
   An invite works once and expires after ten minutes.

The setup token claims the server once. It is not your recovery key. Once the
vault is claimed, new devices join through invites or the recovery key.

Find the startup log with `docker compose logs telimus`, `docker logs telimus`,
or `journalctl -u telimus`, depending on how you installed it.

## Check your setup

Create a small note on the first device, let it sync, and confirm it arrives on
the second. Edit it there and check that the first device receives the edit.
Open version history to confirm you can find the earlier version.

For the server itself:

```bash
docker compose exec telimus /telimus health
docker compose exec telimus /telimus stats
```

With a binary installation, use `telimus health` and
`telimus stats -data /path/to/telimus-data`.

Before relying on the service, set up
[backups and a restore rehearsal](server-operations.md#backup). History grows
until you explicitly purge it; there is no automatic retention policy.

## Upgrade order

Back up first. Upgrade the server, then the plugin and CLI on every device.
Server, plugin, and CLI release numbers are separate; protocol compatibility
determines whether they can connect. An incompatible client stops with a
protocol error instead of syncing partially.

Plugin, CLI, and server **0.8.0** use protocol 7. Upgrade the server first,
then every client. Version 0.7.x uses protocol 6 and cannot connect to the
upgraded server. Existing pairings, credentials, and vault history stay in place.
For source builds, use the same revision for the server and clients.

For Compose, update both the image tag and digest from the chosen server
release, then run `docker compose pull` and `docker compose up -d`. Preserve
the data volume and any customized flags, especially the file-size limit.
Never use `docker compose down -v` to upgrade.

Use `telimus version` to check the server build and the plugin panel to check
what each device connected to. The [protocol reference](protocol.md) describes
the version used by this source tree.

## A vault that is not called `default`

A server serves one vault, named by `-vault` (default `default`). Run it with
`-vault work` and its setup line carries the name:

```text
wss://homelab.example.ts.net#TOKEN#work
```

Paste that whole line into the plugin under **Start a new vault**, or give it to
`telimus init`. The panel shows which vault and which server the line claims
before you press the button. Other devices learn the name from the invite, so
they need nothing extra.

A line with no second `#` claims `default`, which is what every line printed by
an older server does. A named line needs a plugin or CLI from 0.8.4 or newer:
older ones read everything after the last `#` as the token and will reject it.

## Connection troubleshooting

| Problem | Check |
|---|---|
| Cannot reach the server | Server process, proxy, and the proxy's hostname and port. With Tailscale, check it is connected on both server and device. |
| Works on the server but not the phone | Use the proxy's `wss://` hostname and HTTPS port. `localhost` on the phone is the phone itself. |
| Setup token rejected | Copy it from this server's log. If already claimed, use an invite. |
| Protocol mismatch | Update the server and clients to compatible releases. |
| Device limit reached | Update the server. Older releases capped the number of devices. |
| Browser origin rejected | Check the exact origin in the server log and the plugin's hint. Add only that required origin with `-allow-origin`. |
| Stopped after restoring a backup | Follow [server restoration](server-operations.md#restore), then use **Rejoin this server**. |
| File too large | Check the default 64 MiB limit and [how to change it](server-reference.md#serve). |

Android needs Obsidian in the foreground. For note recovery and device-specific
status messages, see the [plugin guide](plugin.md).
