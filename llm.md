# Install Trew with an agent

> Follow this runbook to install the Trew server and Obsidian plugin, pair the
> user's devices, and verify sync. Continue through the steps you can complete;
> report any missing access or unfinished verification precisely.

Trew is self-hosted Obsidian sync with version history. The server holds the
notes in plaintext: there is no end-to-end encryption, so the server host, its
disk and its backups can read every note. Tell the user this before installing
if they have not already chosen Trew knowing it. The plugin runs on macOS,
Linux, and Android with local vault storage. iOS is untested; Windows is
unsupported. Android sync requires Obsidian in the foreground. The CLI is
experimental and optional.

Repository: <https://github.com/waynehoover/trew>.
Use the [server setup](docs/server.md), [plugin guide](docs/plugin.md), and
[maintenance guide](docs/server-operations.md) for details. If reading a raw copy
of this file, resolve those paths against the repository root at the same ref.
[llms.txt](llms.txt) provides absolute Markdown URLs.

## 1. Establish the target

Use information the user has already supplied. Inspect the accessible machines
before asking questions. Collect only missing information:

| Input | What to establish |
|---|---|
| Server | Existing Trew endpoint, or the host and authorized access for a new installation. Check OS, architecture, local disk, Docker/Compose or service manager, and free port 3003. |
| Vault | Exact local path and device, Obsidian version, and configuration folder (normally `.obsidian`). Do not infer the intended vault from whichever one is open. |
| Existing sync | Whether this vault already uses Trew or another sync service. Reuse an existing Trew pairing. For another service, let outstanding sync finish, preserve a backup, and agree on the switch before enabling Trew. |
| Secure connection | Existing HTTPS proxy/domain, or Tailscale on the server and devices. Prefer what is already configured. Ask for the user's choice if neither exists. |
| Storage | Whether the server's data volume and the backup destination sit on encrypted storage. Both hold every note in plaintext; record what the user decides. |
| Backup | An available separate disk or off-host destination, and an existing scheduler if any. |

Check whether this is a fresh installation, an upgrade, or an additional device.
A server that already has devices needs no first-device step. Every device,
the first included, joins by invite. If only the local computer is accessible,
do the local work and identify the server or phone steps needing access.

Keep a short, secret-free record of the chosen host, paths, Compose project,
endpoint, versions, and completed steps. On a retry, inspect current state and
resume. Do not delete an existing volume, pairing, or recovery file to make the
instructions run again. Back up existing notes before the first sync.

A Basalt Sync vault does not move over by pairing: Trew and Basalt speak
different protocols, and a Basalt invite or recovery key does not pair with
Trew. Moving from Basalt is a fresh pairing against a new Trew server, done on a
rehearsed copy first; agree that plan with the user before touching the live
vault.

## 2. Choose released artifacts

Use published, non-draft, non-prerelease artifacts from this repository unless
the user requested a development build. Release channels have different tags:

| Component | Tag / artifact |
|---|---|
| Obsidian plugin | Bare `X.Y.Z`; `main.js`, `manifest.json`, `styles.css`, and `SHA256SUMS`. |
| Server | `server/vX.Y.Z`; container image or `trew-OS-ARCH` binary. |
| CLI, if requested | `trew-sync` on npm; source tags use `cli/vX.Y.Z`. |

List releases and choose the newest compatible stable plugin and server. Do not
assume GitHub's single “latest release” is the plugin, or that all components
share a version. Read the chosen release notes for protocol requirements and
upgrade the server before clients when required. Compare Obsidian's installed
version with the **downloaded** manifest's `minAppVersion`.

The following download template uses GitHub CLI; HTTPS downloads from the exact
release are also suitable. Replace `X.Y.Z` with the selected published plugin
tag. Do not run this placeholder unchanged.

```bash
TREW_PLUGIN_TAG='X.Y.Z'
TREW_DOWNLOAD_DIR="$(mktemp -d)"
gh release download "$TREW_PLUGIN_TAG" --repo waynehoover/trew \
  --dir "$TREW_DOWNLOAD_DIR" \
  --pattern main.js --pattern manifest.json --pattern styles.css --pattern SHA256SUMS
(cd "$TREW_DOWNLOAD_DIR" && shasum -a 256 -c SHA256SUMS)
```

Stop on a failed download or checksum. Check that the manifest ID is
`trew-sync` and its version matches the tag. Where GitHub attestation
verification is available, verify all three assets with `gh attestation verify
FILE --repo waynehoover/trew`. Report whether provenance was checked;
a matching checksum alone does not authenticate its publisher. Never silently
substitute source archives for the built plugin.

## 3. Run the server

Skip creation when the user already has a working compatible server. Inspect
and preserve its data and flags before any upgrade.

### Docker Compose, preferred when available

Clone the official repository into a new dedicated deployment directory:

```bash
git clone https://github.com/waynehoover/trew.git
cd trew-sync
docker compose config
```

Review the included [compose.yaml](compose.yaml) before starting. It pins an
image tag and digest, uses a persistent named volume, and publishes
`127.0.0.1:3003`. Confirm that the pin is a published server compatible with the
chosen plugin; do not assume an arbitrary source tag carries the newest pin.
Record the actual image digest and Compose directory. Reuse that directory and
project name for later commands so maintenance targets the same volume.

Once the configuration and compatible image pin are verified, start it:

```bash
docker compose up -d
docker compose exec trew /trew version
docker compose exec trew /trew health
```

If the directory or container name already exists, inspect it and reuse the
correct installation instead of overwriting it. Keep the published port on
loopback, persistent storage, and the 30-second stop allowance. Do not use
`docker compose down -v` for installation, upgrade, or troubleshooting.

### Binary alternative

Use this route when Docker is unsuitable. Download the matching published
server binary: Linux or Darwin, amd64 or arm64. Verify its exact checksum entry
from that release's `SHA256SUMS` before running it. Use a dedicated writable
local data directory and bind `127.0.0.1:3003`.

For Linux persistence, follow [binary installation](docs/server.md#a-binary):
create the service account and data directory, then use `trew service` to
print the unit and installation instructions. Apply those instructions through
the available authorized service manager. The command only prints; it does not
install or start the service. On macOS, use an appropriate existing service
manager and verify restart behavior; a foreground process alone is a trial.

Check both the running version and health. Use the same data directory for all
subsequent maintenance commands.

## 4. Establish the secure endpoint

Run Trew behind Tailscale Serve or an HTTPS reverse proxy. It does not provide
TLS itself; keep its own HTTP/WebSocket port private. Recommend Tailscale Serve
for a new personal homelab, or preserve the user's existing HTTPS proxy.

- **Existing Tailscale:** check the current Serve configuration, then configure
  `tailscale serve --bg 3003` without replacing unrelated routes. Obtain the
  actual hostname and HTTPS port from its output, replacing `https://` with
  `wss://` for the plugin. If the default Serve route is occupied, use a free
  HTTPS port and include it in the endpoint. Do not use Funnel for tailnet-only
  access. Verify Tailscale is connected on both the server and every device.
  Tailscale installation, login, or HTTPS enablement may require the user.
- **Existing domain and proxy:** configure Caddy or the user's existing proxy
  to forward WebSockets to `127.0.0.1:3003`. Preserve unrelated sites. For a new
  Caddy site, the [secure access guide](docs/server.md#caddy) gives the configuration.
  A containerized proxy needs a shared private network to reach the Trew
  container; its own loopback does not reach the host.
  Validate configuration and certificates before using it.

Check the public endpoint's `/health` over HTTPS from a client device, in
addition to the server-local health check. Do not disable certificate
verification to make the check pass. If authentication at the proxy prevents
normal Trew WebSocket connections, resolve that configuration before pairing.
Plain `ws://` is only for an explicitly local test on loopback.

The first device pairs from an invite, a `trew1i_` string that carries a
single-use token, the server's address and the vault name. An invite names the
address devices connect to, so it has to name the verified `wss://` endpoint,
not the server's own port. Once the endpoint works, make the first device's
invite on the server host, naming that endpoint, into a permission-restricted
file rather than the conversation:

```bash
(umask 077 && docker compose exec -T trew /trew invite -url wss://actual-hostname \
  > /private/path/first-invite.txt)
```

The file holds a line saying when the invite expires and the invite itself, the
line starting `trew1i_`. For a binary installation, run
`trew invite -data /path/to/trew-data -url wss://actual-hostname -out /private/path/first-invite.txt`
as the service account, which writes only the invite, mode 0600. Either way
the command goes through the running server. A server with no devices also
writes an invite to `first-invite` in its data directory at startup and logs
that path, never the string; it names the endpoint only when `serve` was
started with `-url`. Keep the invite out of the conversation, screenshots and
logs: until it is used, anyone holding it can add a device. It expires after
one hour.

## 5. Install and enable the plugin

On each accessible device:

1. Resolve the intended vault and configuration folder. Preserve an existing
   plugin directory before an upgrade, including its state and credentials.
2. Disable a running Trew plugin before replacing its files. Copy the three
   verified release assets into `<vault>/<config-folder>/plugins/trew-sync/`.
   Update only `main.js`, `manifest.json`, and `styles.css`; keep all other files.
3. Reload Obsidian's plugin discovery, enable **Trew Sync**, and check the
   installed version. Leave unrelated plugins and settings intact.
4. Open Trew's panel and inspect its actual pairing or sync state.

On desktop, check `obsidian help` for supported automation commands. When
available, these commands target a specific open vault:

```bash
obsidian vault="My Vault" vault info=path
obsidian vault="My Vault" plugin:enable id=trew-sync
obsidian vault="My Vault" plugin id=trew-sync
obsidian vault="My Vault" commands filter=trew-sync
```

Replace `My Vault` with the verified vault name and check the returned path.
Use the listed command IDs to open the panel or trigger sync. New manually
copied files may require an app reload before they are discoverable. Enable
community plugins if needed, accounting for any existing disabled plugins.
`plugin:install` searches the community directory; it is not a substitute for
manual release installation while Trew is outside that directory.

Use app automation when available. If Obsidian or Android is inaccessible,
prepare the verified files and give the user just the remaining install/enable
steps. Do not invent an installation API or claim the plugin is enabled because
files exist. [Obsidian's CLI documentation](https://obsidian.md/help/cli) and the
installed CLI's help describe available capabilities.

## 6. Pair each device

Interact with the actual panel through available app controls. There is no
documented Trew CLI command that writes the plugin's pairing state. Do not
manufacture `data.json`, copy another device's credentials, or run the headless
client against the plugin's vault as a shortcut.

**First device:** paste the invite from section 4 into **Invite** and check the
server (and the vault, if it is not `default`) that the panel says it points
to. **Pair** becomes available once the panel can read the invite. A device
name is suggested and can be changed under **More options**. There is no
recovery key to save: the notes and their history stay on the server, and
`trew invite` on the server pairs a replacement whenever one is needed. Wait
for pairing and sync to finish.

**Additional device:** an empty local vault downloads the synced files directly.
If files already exist, the panel asks before combining them with the synced
vault. Continue only when the user wants those files included; an older copy
can reintroduce moved or deleted files. Cancelling leaves the invite unused.
For a fresh copy, create a new empty Obsidian vault and preserve the old vault
separately; do not clear it automatically. Sync runs both ways after pairing.

On a paired device, choose **Add another device → Create invite**. On the new
device, paste the invite into **Invite**, or scan its QR code, check the server
named under the field, and press **Pair**. An invite works once and expires
after one hour by default. Create one per device.

If **Review your first sync** appears, review the upload, download, and
preserved-copy counts before choosing **Continue sync**. **Pause sync** keeps
the first sync paused; resume from the Trew menu when ready.

If pairing is interrupted, inspect the panel and saved state before retrying.
A device saves its pairing before sending it, so one whose reply was lost is
finished by the next attempt, even after the invite has expired; follow what
the panel says. Do not unlink or make a fresh invite simply because a previous
attempt timed out.

Keep invites and device credentials out of chat, screenshots, command
arguments, and routine logs. Use private local files or protected input when
supported. Do not copy an invite into a transcript to automate a button. When
no private interaction is available, let the user paste the invite while
continuing independent setup work.

## 7. Verify the installed system

Use the app or its CLI for note operations so Obsidian observes the changes.
Never overwrite an existing note for a test. Keep the test note unless the user
asks to remove it.

1. Confirm server health locally and through the secure endpoint.
2. Confirm the plugin is enabled, paired to that endpoint, and has no unresolved
   sync or recovery error. Inspect reasons for ignored or oversized files.
3. Create a uniquely named small Markdown note on device A. Wait for sync and
   read back the same content on device B.
4. Edit that note on B and confirm A receives the edit. Open its Trew version
   history and confirm the earlier version is present.
5. Restore that earlier version. Verify the restored content appears as a
   separate copy while the current note remains intact.

A local health check proves neither pairing nor sync between devices. If only
one device is available, report that limitation and leave the two-device and
restore checks pending. Do not equate files installed with working sync.

## 8. Arrange backups and finish

Follow [server backup](docs/server-operations.md#backup) to create and verify a
snapshot, copy it to the chosen separate disk or host, and configure an ordered,
non-overlapping scheduled job. Verify the schedule and destination. A backup
inside the server volume alone does not protect against losing that disk. A
backup is a readable copy of every note and its history, so its destination
needs the same protection as the server's disk.
Schedule a [restore rehearsal](docs/server-operations.md#restore-rehearsal);
do not replace live data for this check. If no backup destination is available,
state that backups are pending and ask for the missing destination. Installation
does not authorize purging history or discarding existing backups.

Report concisely:

- Server endpoint, running version, service/Compose location, and health result.
- Plugin version and paired vault/device names, without credentials or invites.
- Sync and recovery checks that actually passed, with any remaining device steps.
- Whether the data volume and backups are on encrypted storage, and the backup
  location/schedule, or what is still pending.

Distinguish **installed**, **paired**, and **verified between devices** in the
result. Link [the plugin guide](docs/plugin.md) for daily use. Do not ask for
repeated approvals for routine work already authorized by the user.

## Optional: a headless mirror

Only install the CLI if the user also wants a copy on a machine without
Obsidian. It needs Node 22 or newer and its **own local directory**. Follow the
[CLI guide](client/README.md), pair with `--read-only` for a mirror, and supply
an invite through `--key-file` or standard input. Do not run it in a vault the
plugin is already syncing. Read-only mode is local behavior, not a server access
restriction.

## Optional: an MCP host

When the user wants an agent to work with their notes, pair a dedicated headless
directory first, using a separate invite. Do not use the plugin's live vault or
copy its credentials. Configure the host with the absolute Node 22+ executable,
absolute `trew.mjs` path and `mcp --dir /absolute/path/to/agent-vault`, following
the [CLI host example](client/README.md#connect-a-local-agent). One host owns the
directory's lock and sync loop; stop any existing watcher first. Use `--read-only`
when edits are outside the authorized scope. It omits mutations while incoming
sync still changes the local copy.

Verify initialization and local reads, then wait for `sync_status.writeReady`
before an authorized edit. Supply the base from `read_note` and exact unique
old-to-new spans; append adds only the supplied text, with no automatic newline.
Read the before-image and compare unrelated bytes afterward. Follow pagination
and inspect skipped or incomplete results. Local `applied`/`durable` fields do
not prove delivery; read the change and backup from another device if delivery
is part of the task. On a lost response or stale base, reread and reconsider,
never blindly retry with a fresh base. Follow the
[recovery example](docs/cli-reference.md#inspect-and-recover) to inspect a backup
or server version and recover it to a new path. Keep recovery copies for the owner.

For authorized HTTP access, follow the [service and proxy runbook](client/README.md#connect-over-http):
issue `trew mcp-token --dir DIR --key-out /private/path/new-mcp.key` outside the
vault, run `trew mcp --dir DIR --listen 127.0.0.1:3010`, and enable `--writable`
only if edits are authorized and the device is writable. Put the token in the
client's bearer-auth configuration, never in a note or model prompt. Tailscale
Serve can publish the loopback listener; its TLS terminator sees plaintext notes.
Every request still needs the token. Rotation uses `mcp-token` again; revocation
uses `mcp-token --revoke`. Old-key queued work is cancelled when the change is
observed, while admitted edits finish. The client must support a static bearer
and reach the endpoint; OAuth is outside this release. Real Tailscale HTTPS,
credential rotation and restart were verified with official SDK clients. Collie
and a specific phone MCP client remain untested. If the phone just prompts an
agent on the Mac, configure the Mac's MCP client and use stdio when it supports it.

## Working from development source

This source tree speaks protocol 1, Trew's own. Basalt's releases speak its
protocol 7, and the two refuse each other at the handshake, naming both
numbers. For source builds, build the server and clients from the same
checkout. Keep existing data and credentials, and verify the reported protocol
after connecting. `trew preview --json` provides a read-only plan for CLI
vaults.
