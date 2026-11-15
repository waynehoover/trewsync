# Set up your TrewSync server

[Documentation](index.md) · [Maintenance](server-operations.md) · [Command reference](server-reference.md)

Run one server for your vault, then connect your devices with the Obsidian
plugin. The server stores your notes and their history. You provide storage,
a secure connection, and backups.

Before you start:

- **You need** a Linux or macOS machine with local storage. Docker is the
  simplest route. Keep the data directory off NFS, SMB, and other network
  filesystems.
- **Notes are readable on the server's disk** to anyone who can read it. Put
  the data directory on encrypted storage (LUKS, FileVault, ZFS native
  encryption). [Security and privacy](security.md) says what that does and
  does not cover.
- **Put Tailscale Serve or an HTTPS reverse proxy in front of TrewSync.** Your
  devices connect to the proxy; TrewSync's own port stays private. For a
  homelab we recommend [Tailscale Serve](#tailscale-recommended). If you
  already have a domain and an HTTPS proxy, [use that instead](#caddy).

## Install

### Docker

From a copy of this repository:

```bash
git clone https://github.com/waynehoover/trewsync.git
cd trewsync
docker compose up -d
docker compose logs trew
```

The included [compose.yaml](../compose.yaml) runs the server release it pins,
`ghcr.io/waynehoover/trewsync` by tag and digest. It keeps data in a named
volume, serves sync and the MCP endpoint (`-mcp`) on the one port 3003, and
exposes that port only on the host's loopback interface. The MCP endpoint
answers nobody until you make a token for it ([Connect an agent](agent.md)).

For a quick trial without cloning:

```bash
docker run -d --name trew --restart unless-stopped --stop-timeout 30 \
  -p 127.0.0.1:3003:3003 -v trew-data:/data \
  ghcr.io/waynehoover/trewsync:latest
docker logs trew
```

Its commands are then `docker exec trew /trewd ...` rather than
`docker compose exec trew /trewd ...`.

Use the pinned Compose setup for a server you keep. Next, set up
[secure access](#secure-access) before pairing devices.

Good to know:

- **Bind mounts.** Named volumes get the right ownership automatically. If
  you use a bind mount instead, create a dedicated empty directory writable
  by UID/GID `65532:65532`, the container's user. Keep it when upgrading:
  removing it removes the server's notes and history.
- **What is in the image.** Alpine, the server's binary, and git, git-lfs and
  ssh for the optional [Git export](git-export.md). The server runs no shell
  and needs none of them unless the export is on.
- **Settings** such as the export's and the daily-note tools' live in
  `trewd.json` in the volume (`docker compose exec trew /trewd config show`),
  so the compose file needs no flags for them.

### A binary

Download the matching binary from the newest server
[release](https://github.com/waynehoover/trewsync/releases), the one tagged
`server/vX.Y.Z` and titled **trewd X.Y.Z** (the bare `X.Y.Z` releases are the
plugin's): `trewd-linux-amd64` or `-arm64` for Linux, or `trewd-darwin-amd64`
or `-arm64` for macOS. Check it against the release's `SHA256SUMS`, make it
executable, and run it with a writable data directory, given as an absolute
path:

```bash
V=0.14.0   # the newest server release
curl -fLO https://github.com/waynehoover/trewsync/releases/download/server/v$V/trewd-linux-amd64
curl -fLO https://github.com/waynehoover/trewsync/releases/download/server/v$V/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
chmod +x trewd-linux-amd64
./trewd-linux-amd64 serve -data ~/trew-data -addr 127.0.0.1:3003
```

- **macOS.** Use `trewd-darwin-arm64` (or `-amd64`). macOS refuses to run a
  binary a browser downloaded until you clear its quarantine
  (`xattr -d com.apple.quarantine trewd-darwin-arm64`); `curl`, as above, sets
  none.
- **Port in use.** If another program holds port 3003, the server says
  `address already in use`. Choose another port with `-addr 127.0.0.1:PORT`,
  and use that port in `tailscale serve` or your proxy, and in
  `trewd health -addr 127.0.0.1:PORT`.
- **Other platforms.** On anything else Go builds for (FreeBSD, or Linux on
  riscv64, for example), build trewd from the release's tag with Go 1.27 or
  later, the way a release is built:

```bash
git clone --branch server/v$V https://github.com/waynehoover/trewsync && cd trewsync
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$V" -o trewd ./cmd/trewd
```

The invite this trial writes to `first-invite` names `wss://127.0.0.1:3003`,
which no device can use. Once secure access works, make the first device's
invite with `-url`, as [the first device](#the-first-device) shows. To try
TrewSync on this one machine first, with no TLS, start it with `-localhost`
instead: its invites name `ws://127.0.0.1:3003`, and
`trewd invite -data ~/trew-data` makes one.

For a persistent Linux service, install the binary as `/usr/local/bin/trewd`,
create a dedicated `trew` account and a writable `/var/lib/trew` directory,
then run:

```bash
trewd service -data /var/lib/trew -addr 127.0.0.1:3003 \
  -user trew -binary /usr/local/bin/trewd
```

This prints a systemd unit and the commands to install it; review and follow
them. It does not install the service itself. The unit includes restart
handling and a 30-second shutdown allowance. Add `-mcp` to have it serve the
[MCP endpoint](agent.md) too.

### Homebrew, mise or packslip

```bash
brew install waynehoover/tap/trewd                   # macOS or Linux
mise use -g packslip:waynehoover/trewsync/server
packslip install github.com/waynehoover/trewsync/server --pin ps1_puqrourkbcv2h6nky6fzbdkksa
```

mise and the [packslip](https://packslip.dev) CLI install from the release's
signed manifest: they check that this repository's release workflow signed
it, then check the download against it. `--pin` is this repository's signer
fingerprint, so even a first install accepts only a release signed here.
packslip puts `trewd` in `~/.local/bin`.

**Homebrew service.** `brew services start trewd` runs the server on
`127.0.0.1:3003`, without the MCP endpoint, with its data in
`$(brew --prefix)/var/trewd`. Give that directory to every command
(`trewd invite -data "$(brew --prefix)/var/trewd" ...`), or set `TREW_DATA`
to it, since the default is `~/.trew`.

The Homebrew service cannot be given `-mcp`. To serve the
[MCP endpoint](agent.md), stop it (`brew services stop trewd`) and run the
server under a service of your own with the same data directory and `-mcp`:
`trewd serve -data "$(brew --prefix)/var/trewd" -addr 127.0.0.1:3003 -mcp`.
On Linux, `trewd service ... -mcp`, above, prints a systemd unit for it.

**Upgrading.**

| Installed with | Upgrade with |
|---|---|
| A download by hand | `trewd update` |
| packslip | `trewd update`, or the same `packslip install` again |
| Homebrew or mise | Their own tool |

`trewd update` verifies the release before replacing anything
([reference](server-reference.md#update)). It needs the
[packslip](https://github.com/jdx/packslip) CLI on `PATH` (or given with
`-packslip`) for that check, and refuses to run without it.

## Secure access

TrewSync does not provide HTTPS itself. Tailscale Serve or your reverse proxy
does:

**Your devices → Tailscale Serve or HTTPS proxy → TrewSync**

Use the proxy's `wss://` address in the plugin. Keep the raw server port
private: over plain `ws://`, your notes and device credentials cross the
network readable to anyone on the path.

### Tailscale (recommended)

Only devices on your Tailscale network can reach TrewSync, with no public
domain and no router port forwarding. Install and connect Tailscale on the
server and on each device, your phone included.

On the server, check for existing routes first:

```bash
tailscale serve status
```

If the default HTTPS address is free, publish TrewSync there:

```bash
tailscale serve --bg 3003
tailscale serve status
```

Follow any prompt to enable HTTPS. Use the address Tailscale reports,
replacing `https://` with `wss://`, for example
`wss://homelab.example.ts.net`. Leave Tailscale connected on every device
when syncing. Use Serve, not Funnel, for tailnet-only access. See
[Tailscale's Serve guide](https://tailscale.com/docs/reference/tailscale-cli/serve).

If another app already uses that address, choose a free HTTPS port with
`tailscale serve --bg --https=8443 3003`, and include `:8443` in the plugin's
address. The final `3003` is TrewSync's internal port, not necessarily the
port you enter on your phone.

### Caddy

For an endpoint reachable from the internet, point a domain at your server
and let Caddy handle HTTPS. With Caddy on the same host as TrewSync:

```caddyfile
sync.example.org {
    reverse_proxy 127.0.0.1:3003
}
```

Reload Caddy and use `wss://sync.example.org`. The usual Caddy setup needs
ports 80 and 443 reachable for certificates and HTTPS; keep port 3003
private. Caddy handles WebSockets automatically. See
[Caddy's reverse-proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy).

An existing proxy works too: it must provide a trusted HTTPS certificate and
support WebSockets. If the proxy runs in Docker, connect it to TrewSync over
a private Docker network; `127.0.0.1` inside the proxy container is that
container, not the host.

For a test entirely on one machine, `trewd serve -localhost` binds to
loopback and puts a `ws://127.0.0.1` address in its invites. The first device
still pairs from an invite.

## The first device

Every device joins with an invite, the first one included. An invite is a
single-use `trew1i_` string that carries the server's address and the vault's
name. So it has to name the address your devices use: the `wss://` address
from [secure access](#secure-access), not the server's own port.

Once secure access works, make the first invite on the server:

```bash
docker compose exec trew /trewd invite -url wss://homelab.example.ts.net
```

For a binary installation, run
`trewd invite -data /var/lib/trew -url wss://homelab.example.ts.net` as the
account that runs the server. It prints the invite; `-out FILE` writes it to
a file, mode 0600, instead. The command goes through the running server.

Then pair:

1. [Install the plugin](plugin.md#install) on your first device.
2. Open TrewSync, paste the invite into **Invite**, check the server it names,
   and press **Pair**.
3. Wait for sync to finish.
4. Use **Add another device → Create invite** for each additional device.

An invite works once and expires after one hour, so make it when you are
ready to pair. `trewd invite -ttl 0` makes one that never expires, for when
you mean it.

There is no recovery key. The notes and their history are on the server, and
`trewd invite` there pairs a new device whenever you need one, even when no
device is left.

**The `first-invite` file.** When the vault has no devices yet, `trewd serve`
also writes an invite to `first-invite` in its data directory, mode 0600. It
logs that path and when the invite expires, never the invite itself. That
invite names the right address only when `serve` was started with
`-url wss://homelab.example.ts.net` (or `-localhost`, for a trial on one
machine). Otherwise it names this machine's own addresses at the server's
own port, one per line, as `wss://`, where nothing speaks TLS. No device
behind `tailscale serve` or a proxy can use that, and the startup message
says so: make the invite with `trewd invite -url` instead.

Find the startup log with `docker compose logs trew`, `docker logs trew`,
or `journalctl -u trew`, depending on how you installed.

## Check your setup

Create a small note on the first device and confirm it arrives on the second.
Edit it there and check the first device gets the edit. Then open version
history and find the earlier version.

For the server itself:

```bash
docker compose exec trew /trewd health
docker compose exec trew /trewd stats
```

With a binary installation, use `trewd health` and
`trewd stats -data /path/to/trew-data`.

Before you rely on the server, set up
[backups and a restore rehearsal](server-operations.md#backup). History grows
until you purge it yourself; there is no automatic retention policy.

## Let an agent in

The server can also serve an MCP endpoint at `/mcp` on the same port, so an
agent such as Claude Code can read the notes and, with a write token, edit
them. It is off until you start `serve` with `-mcp`, and it refuses every
request until you make a token with `trewd mcp-token`.

A token reads the whole vault, and what the agent reads reaches its model
provider. Read [Connect an agent](agent.md) before making one.

## Upgrade order

Back up first. Upgrade the server, then the plugin and CLI on every device.

Server, plugin, and CLI release numbers are separate; the protocol decides
whether they can connect. The server speaks protocols 1 to 5 and keeps
serving older plugins and CLIs exactly as before, which is why server-first
works. A client newer than its server stops at the handshake with a protocol
error and says to upgrade the server. It never syncs partially.

| Client | Protocol | Needs `trewd` |
|---|---|---|
| Plugin 0.16, `trew` 0.14.0 | 5 | 0.15.0 or later |
| Plugin 0.15, `trew` 0.13 | 4 | 0.14.0 or later |

`trew` 0.12.0 speaks protocol 2. For source builds, use the same revision for
the server and clients.

Moving from Basalt Sync is a fresh pairing, not an upgrade: its releases
speak protocol 7, and a Basalt client and a TrewSync server refuse each other
at the handshake, naming both numbers.

**Compose.** Take the `image:` line, tag and digest, from the repository's
`compose.yaml` on `main` (`git pull` in your clone brings it), then run
`docker compose pull` and `docker compose up -d`. Do not take it from the
`server/vX.Y.Z` tag: the pin for a release is committed after the tag, so the
tag's own `compose.yaml` names the release before it. Keep the data volume
and any customized flags, especially the file-size limit. Never use
`docker compose down -v` to upgrade.

Use `trewd version` to check the server build, and the plugin panel to check
what each device connected to. The [protocol reference](protocol.md)
describes the version this source tree uses.

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

Android needs Obsidian in the foreground. For note recovery and
device-specific status messages, see the [plugin guide](plugin.md).
