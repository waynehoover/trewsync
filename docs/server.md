# Set up your TrewSync server

[Documentation](index.md) · [Maintenance](server-operations.md) · [Command reference](server-reference.md)

Run one server for your personal vault, then connect your devices through the
Obsidian plugin. The server stores your notes and their history, readable to
anyone who can read its disk; you provide storage, a secure connection, and
backups. Put the data directory on encrypted storage (LUKS, FileVault, ZFS
native encryption) and see [Security and privacy](security.md) for what that
does and does not cover.

**Put Tailscale Serve or an HTTPS reverse proxy in front of TrewSync.** Your devices
connect to the proxy; TrewSync's own port stays private. For a personal homelab,
we recommend [Tailscale Serve](#tailscale-recommended). If you already use a domain
and an HTTPS proxy, [use that instead](#caddy).

You need a Linux or macOS machine with local storage. Docker is the simplest
route. Keep the data directory off NFS, SMB, and other network filesystems.

## Install

### Docker

From a copy of this repository:

```bash
git clone https://github.com/waynehoover/trew.git
cd trew-sync
docker compose up -d
docker compose logs trew
```

The included [compose.yaml](../compose.yaml) pins a server image and its digest,
preserves data in a named volume, and exposes port 3003 only on the host's
loopback interface.

For a quick trial without cloning:

```bash
docker run -d --name trew --restart unless-stopped --stop-timeout 30 \
  -p 127.0.0.1:3003:3003 -v trew-data:/data \
  ghcr.io/waynehoover/trew:latest
docker logs trew
```

Use the pinned Compose setup for a server you keep. Next, configure
[secure access](#secure-access) before pairing devices.

Named volumes get the required ownership automatically. If you replace one
with a bind mount, create a dedicated empty directory and make it writable by
UID/GID `65532:65532`, the container's user. Keep that directory when upgrading;
removing it removes the server's notes and history.

### A binary

Download the matching binary from a
[server release](https://github.com/waynehoover/trew/releases?q=server):
Linux amd64/arm64 or macOS amd64/arm64. Make it executable and run it with a
writable data directory:

```bash
chmod +x trewd-linux-amd64
./trewd-linux-amd64 serve -data ./trew-data -addr 127.0.0.1:3003
```

Use your downloaded filename on macOS. For a persistent Linux service, install
the binary as `/usr/local/bin/trewd`, create a dedicated `trew` account and
writable `/var/lib/trew` directory, then run:

```bash
trewd service -data /var/lib/trew -addr 127.0.0.1:3003 \
  -user trew -binary /usr/local/bin/trewd
```

This prints a systemd unit and installation commands; review and follow them.
It does not install the service itself. The generated unit includes restart
handling and a 30-second shutdown allowance.

## Secure access

TrewSync does not provide HTTPS itself. Tailscale Serve or your reverse proxy
provides the secure connection:

**Your devices → Tailscale Serve or HTTPS proxy → TrewSync**

Use the proxy's `wss://` address in the plugin. Keep the raw server port private:
over plain `ws://`, your notes and device credentials cross the network
readable to anyone on the path.

### Tailscale (recommended)

This keeps TrewSync accessible only to devices allowed on your Tailscale network,
without a public domain or router port forwarding. Install and connect Tailscale
on the server and each device, including your phone.

On the server, check for existing routes first:

```bash
tailscale serve status
```

If the default HTTPS address is free, publish TrewSync there:

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
address. The final `3003` is TrewSync's internal port, not the port you necessarily
enter on your phone.

### Caddy

For an internet-accessible endpoint, point a domain to your server and let Caddy
handle HTTPS. With Caddy running on the same host as TrewSync, use:

```caddyfile
sync.example.org {
    reverse_proxy 127.0.0.1:3003
}
```

Reload Caddy and use `wss://sync.example.org`. The usual Caddy setup needs ports
80 and 443 reachable for certificates and HTTPS; keep port 3003 private.
Caddy handles WebSockets automatically. See [Caddy's reverse-proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy).

An existing proxy is fine too: it must provide a trusted HTTPS certificate and
support WebSockets. If the proxy runs in Docker, connect it to TrewSync over a
private Docker network; `127.0.0.1` inside the proxy container refers to that
container, not the host.

For a test entirely on one machine, `trewd serve -localhost` binds to loopback
and puts a `ws://127.0.0.1` address in its invites. The first device still
pairs from an invite.

## The first device

Every device joins with an invite, the first one included. An invite is a
single-use `trew1i_` string that carries the server's address and the vault's
name, so it has to name the address your devices use: the `wss://` address from
[secure access](#secure-access), not the server's own port.

Once secure access works, make the first invite on the server, naming that
address:

```bash
docker compose exec trew /trewd invite -url wss://homelab.example.ts.net
```

For a binary installation, run
`trewd invite -data /var/lib/trew -url wss://homelab.example.ts.net` as the
account that runs the server. It prints the invite; `-out FILE` writes it to a
file, mode 0600, instead. The command goes through the running server.

When the vault has no devices yet, `trewd serve` also writes an invite for the
first one to `first-invite` in its data directory, mode 0600, and logs that
path and when it expires, never the invite itself. It names the right address
only when `serve` was started with `-url wss://homelab.example.ts.net`;
otherwise it names this machine's own addresses, one per line, at the server's
own port, which no device can use while the proxy in front terminates TLS.

1. [Install the plugin](plugin.md#install) on your first device.
2. Open TrewSync, paste the invite into **Invite**, check the server it names, and
   press **Pair**.
3. Wait for sync to finish.
4. Use **Add another device → Create invite** for each additional device.

An invite works once and expires after one hour, so make it when you are ready
to pair; `trewd invite -ttl 0` makes one that never expires, for when you mean
it. There is no recovery key: the notes and their history are on the server,
and `trewd invite` there pairs a new device whenever you need one, even when no
device is left.

Find the startup log with `docker compose logs trew`, `docker logs trew`,
or `journalctl -u trew`, depending on how you installed it.

## Check your setup

Create a small note on the first device, let it sync, and confirm it arrives on
the second. Edit it there and check that the first device receives the edit.
Open version history to confirm you can find the earlier version.

For the server itself:

```bash
docker compose exec trew /trewd health
docker compose exec trew /trewd stats
```

With a binary installation, use `trewd health` and
`trewd stats -data /path/to/trew-data`.

Before relying on the service, set up
[backups and a restore rehearsal](server-operations.md#backup). History grows
until you explicitly purge it; there is no automatic retention policy.

## Upgrade order

Back up first. Upgrade the server, then the plugin and CLI on every device.
Server, plugin, and CLI release numbers are separate; protocol compatibility
determines whether they can connect. An incompatible client stops with a
protocol error instead of syncing partially.

This source tree speaks protocol 1, TrewSync's own. Basalt Sync's releases speak
protocol 7, and a Basalt client and a TrewSync server refuse each other at the
handshake, naming both numbers; moving from Basalt is a fresh pairing, not an
upgrade. For source builds, use the same revision for the server and clients.

For Compose, update both the image tag and digest from the chosen server
release, then run `docker compose pull` and `docker compose up -d`. Preserve
the data volume and any customized flags, especially the file-size limit.
Never use `docker compose down -v` to upgrade.

Use `trewd version` to check the server build and the plugin panel to check
what each device connected to. The [protocol reference](protocol.md) describes
the version used by this source tree.

## A vault that is not called `default`

A server serves one vault, named by `-vault` (default `default`). Run it with
`-vault work` and every invite it makes carries the name, the first one
included. A device joins whichever vault its invite names, with nothing extra
to type; the plugin shows the name before you press **Pair**.

## Connection troubleshooting

| Problem | Check |
|---|---|
| Cannot reach the server | Server process, proxy, and the proxy's hostname and port. With Tailscale, check it is connected on both server and device. |
| Works on the server but not the phone | Use the proxy's `wss://` hostname and HTTPS port. `localhost` on the phone is the phone itself. |
| Invite refused | An invite works once and expires; make a new one with `trewd invite` on the server or **Create invite** on a paired device. |
| Invite names an address the device cannot reach | Make one that names the proxy's address: `trewd invite -url wss://your-host`. |
| Protocol mismatch | Update the server and clients to compatible releases. |
| Device limit reached | Update the server. Older releases capped the number of devices. |
| Browser origin rejected | Check the exact origin in the server log and the plugin's hint. Add only that required origin with `-allow-origin`. |
| Stopped after the data directory was copied back | Follow [server restoration](server-operations.md#restore), then use **Rejoin this server**. A restore from a `trewd backup` snapshot needs nothing from the devices. |
| File too large | Check the default 64 MiB limit and [how to change it](server-reference.md#serve). |

Android needs Obsidian in the foreground. For note recovery and device-specific
status messages, see the [plugin guide](plugin.md).
