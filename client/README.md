# TrewSync command-line client

**Self-hosted vault sync with full version history, on a server you run.**

Keep a local copy of your Obsidian notes on a NAS or another machine without
Obsidian. TrewSync connects to your own server, which keeps your notes and every
earlier version, and provides note history and recovery from the terminal.
The server can read what it stores: see
[Security and privacy](https://github.com/waynehoover/trew/blob/main/docs/security.md).

**Experimental.** Use macOS or Linux, Node **22 or newer**, and a local
filesystem. Run one TrewSync process that writes to each vault, and keep other
sync tools and the Obsidian plugin off that same directory. For everyday
editing, use the
[Obsidian plugin](https://github.com/waynehoover/trew/blob/main/docs/plugin.md).

The package installs a command called `trew`. The server's command is `trewd`,
so a machine can have both on its path.

## Set up a mirror

Create an invite on an existing device, using **Add another device → Create
invite** in the plugin or `trew invite` on a paired client. Then, on the mirror
machine:

```bash
npm install -g trew-sync
mkdir -p ~/trew-mirror
cd ~/trew-mirror
trew pair 'INVITE' --read-only
trew sync --watch
```

Replace `INVITE` with the string you created. It starts `trew1i_` and carries
the server's address and the vault's name, so there is nothing else to type.
An invite works once and expires after one hour by default. `--read-only` is
saved during pairing, so subsequent syncs keep local changes from being
uploaded even without the flag.

Keep the process running for continuous sync. For a scheduled job, use
`trew sync --dir /path/to/trew-mirror` instead.

If pairing is interrupted after the invite was sent, for example by a dropped
connection, run the same `trew pair` command again in that directory. The
client saved the pairing before sending it, and finishes it as the same device,
even if the invite has expired since. A refused invite (unknown, already used,
expired or cancelled) leaves nothing saved; ask for a new one.

## The first device on a new server

The first device pairs from an invite too. Make one on the server host with
`trewd invite -url wss://your-host`, naming the address devices reach, or use
the one a server with no devices writes to `first-invite` in its data
directory. Copy it to this machine privately, then pair, without `--read-only`
if this device should write:

```bash
mkdir -p ~/vault
trew pair --dir ~/vault --key-file /private/path/invite.txt
trew sync --dir ~/vault
```

A `first-invite` file holds one line per server address, each the same invite;
give `--key-file` a file holding just the line this machine can reach.

There is no separate command for starting a vault, and no recovery key to
save: the notes and their history are on the server, and `trewd invite` on the
server pairs a new device whenever you need one. See
[server setup](https://github.com/waynehoover/trew/blob/main/docs/server.md#the-first-device)
for TLS and the first invite.

## Everyday commands

Commands use the current directory unless you pass `--dir DIR`.

| Command | Use it to… |
|---|---|
| `trew pair INVITE` | Join a vault with an invite; run it again to finish an interrupted pairing. |
| `trew sync` | Sync once and exit. |
| `trew sync --watch` | Keep syncing and reconnect after temporary outages. |
| `trew mcp` | Expose this paired directory over stdio, or HTTP with `--listen`. |
| `trew mcp-token` | Issue or rotate the HTTP MCP credential; `--revoke` revokes it. |
| `trew status` | Check connection, local changes, refused paths, and recovery issues. |
| `trew invite` | Add another device with a single-use invite. |
| `trew devices` | List devices and outstanding invites. |
| `trew revoke ID` | Stop a device syncing, this one and the last one included. |
| `trew uninvite ID` | Cancel an outstanding invite. |
| `trew rename NAME` | Rename this device's label. |
| `trew history "Note.md"` | View a note's versions, newest first. |
| `trew deleted` | List deleted notes and whether they can be restored. |
| `trew restore "Note.md"` | Restore the newest version with content. |
| `trew unlink` | Remove local pairing and index while keeping notes. |

The [command reference](https://github.com/waynehoover/trew/blob/main/docs/cli-reference.md)
covers all flags, device access, repair, and recovery.

## Connect a local agent

`trew mcp` lets a local MCP host read notes and make exact edits while TrewSync
syncs its own headless copy. The host and any model service it uses can receive
plaintext note content. Choose a host you trust with those notes.

First create an invite on an existing device and pair a **separate directory**:

```bash
mkdir -p /absolute/path/to/agent-vault
trew pair --dir /absolute/path/to/agent-vault --key-file /private/path/invite.txt
```

For an inspection-only host, add `--read-only` at pairing or launch. A saved
read-only pairing cannot be made writable by omitting the flag. Never point the
CLI at the local vault already being synced by the Obsidian plugin.

Configure the host to launch Node with an absolute executable path, the absolute
installed `trew.mjs` path, and `--dir`. For a host using `mcpServers` JSON:

```json
{
  "mcpServers": {
    "trew": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/trew-sync/dist/trew.mjs",
        "mcp",
        "--dir",
        "/absolute/path/to/agent-vault"
      ]
    }
  }
}
```

Replace all paths with your installation's paths. `command -v node` locates Node;
for a global npm installation, `npm root -g` locates the directory containing
`trew-sync/dist/trew.mjs`. Use Node 22 or newer. Node 22 and 24 have been
exercised with the production MCP artifact. Hosts may use a different outer
configuration format; the executable and argument array stay the same.

The host owns this long-running process. Stop `sync --watch` first, and configure
one host process per directory. MCP holds the vault lock and handles ongoing
sync itself. Stdout is reserved for protocol messages; do not add `--json` or
`--watch`. EOF, SIGINT and SIGTERM drain admitted writes before releasing the
lock. A host that force-kills its child can interrupt that drain; inspect any
unknown outcome.

Start with `sync_status`, `list_notes` and `read_note`. Initialization and local
reads work during connection setup or outages. They can be stale; a missing local
file may simply be waiting to download. Edits require `writeReady:true` after
initial sync. History and restore need a server connection.

Search by content, filename or tag with `search_notes`. Tag changes, moves and
recoverable deletion use a preview first, then require the returned exact
changes and bases to apply. `compare_versions` shows differences from retained
history; `delivery_status` reports device checkpoints without promising that a
particular edit reached every device.

To expose several separately paired directories, replace `--dir` with repeated
`--vault name=/absolute/path` arguments. `list_vaults` discovers those aliases;
every other tool requires `vault` when several are configured. For HTTP, the
first configured directory's credential grants access to the whole explicit set.
See [multiple vaults](https://github.com/waynehoover/trew/blob/main/docs/cli-reference.md#several-vaults)
for credential scope and per-vault permissions.

To change a note, read it and supply its returned `base` with exact `{old,new}`
spans to `edit_note`. Each old span must be unique; all spans are validated
against the same original and published as one replacement. `append_note` and `prepend_note` also
require a base and add exactly the supplied text, including only the newlines
you supply. `create_note` and `restore_note` require free destination paths.
UTF-8 Markdown and plain text are supported up to 1 MiB; drawings and attachments
cannot be mutated. There is no whole-file writer.

Every mutation of an existing note preserves a verified, flushed
before-image. Read the returned `beforeImage` to inspect it, or list with
`includeBackups:true` to find older copies. Backups sync as ordinary notes and
MCP cannot alter or delete them.
`applied:true` and `durable:true` describe the local commit, not delivery to the
server or another device. Errors may report an applied change or preserved paths.
After `stale`, a timeout or a lost response, reread and reconsider before retrying.

Follow continuation fields to read later pages. `--read-only` omits every mutation
tool but still downloads remote edits. The
[MCP reference and recovery example](https://github.com/waynehoover/trew/blob/main/docs/cli-reference.md#mcp-over-stdio)
cover exact limits, partial results and restoring an inspected version to a new
path.

## Connect over HTTP

For an agent running on the same machine, stdio can use the configuration above.
HTTP lets multiple clients share one running process. Use the same separately
paired headless directory and stop its existing watcher first. Issue the HTTP
credential, exporting it outside the vault to a new private file:

```bash
trew mcp-token --dir /srv/vault --key-out /private/path/trew-mcp.key
trew mcp --dir /srv/vault --listen 127.0.0.1:3010
```

The output directory must already exist. Without `--key-out`, the command prints
the token once. With it, only the credential id and file path are printed.
Every HTTP request needs `Authorization: Bearer TOKEN`, including requests on
loopback. The token is separate from this device's own credential.
HTTP has read-only tools by default; add `--writable` only when the agent should
edit notes. A saved read-only pairing cannot be overridden. This default limits
MCP tools, while ordinary sync still uploads on a writable device.

On Linux, a service can own this directory. For example, save the following as
`/etc/systemd/system/trew-mcp.service`, adjusting the account, Node executable,
installed artifact and vault paths:

```ini
[Unit]
Description=TrewSync MCP
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=trew
ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/trew-sync/dist/trew.mjs mcp --dir /srv/vault --listen 127.0.0.1:3010
Restart=on-failure
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

The service account must own the paired directory and its credential state.
Use `command -v node` and `npm root -g` to locate your installation. Then enable
the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now trew-mcp
```

SIGTERM drains admitted edits before releasing the vault lock. If the service
manager force-kills the process after its shutdown allowance, inspect uncertain
outcomes and recovery copies. HTTP ignores stdin EOF and writes diagnostics only
to stderr. Systemd acceptance of this example remains untested locally on macOS.

On the same machine, publish the loopback listener through Tailscale Serve:

```bash
tailscale serve --bg --https=8443 3010
```

Replace `host.ts.net` with the machine's full Tailscale DNS name. Enter
`https://host.ts.net:8443/mcp` in the MCP client and put the token in its bearer
token/API-key field, or configure the exact `Authorization` header above. The
client must support that header and have a network path into your tailnet.
This static-key service does not provide OAuth discovery or a browser login.
If your phone only sends prompts to an agent on your Mac, the Mac is the MCP
client and can use local stdio instead.

Rotate without restarting the service, then update each client:

```bash
trew mcp-token --dir /srv/vault --key-out /private/path/trew-mcp-next.key
```

Use a new export filename; existing files are never overwritten. Old keys fail
their next request, and old sessions end when the new credential is observed.
Queued old-key operations are cancelled; admitted edits finish. Revoking uses
`trew mcp-token --dir /srv/vault --revoke`. Issuing another credential restores
access. The stored hash cannot recover a lost token.

The [HTTP reference](https://github.com/waynehoover/trew/blob/main/docs/cli-reference.md#mcp-over-http)
covers origins, limits and reconnect behavior. TLS terminators receive plaintext
notes; read the [Cloudflare and proxy warning](https://github.com/waynehoover/trew/blob/main/docs/security.md#http-access-for-an-agent)
before choosing another proxy. Real Tailscale HTTPS was tested with official SDK
clients, including edits, before-images, credential rotation and restart.
**Cloudflare Tunnel, Collie and a specific phone MCP client remain unverified**,
including phone lockout and re-entry after token rotation.

## A mirror, and turning merging off

`--read-only` stops ordinary sync from uploading local edits, deletions, and
conflict copies. It still downloads and changes local files. Preserve local
edits you care about separately; this mode does not make the local directory
immutable.

The setting is a client behavior, **not a server-enforced permission**. The
client keeps an ordinary device credential, and explicit administrative
commands still work. In particular, `trew repair` can resend missing content.
Use this mode on a machine you trust.

`pair` persists `--read-only`; passing it to `sync` applies it to that
invocation. There is no flag to turn a persisted setting off.

To review conflicting edits yourself instead of merging them:

```bash
trew sync --no-merge
trew sync --watch --no-merge
```

Pass `--no-merge` on each invocation that should use it. TrewSync keeps both
versions when a merge would otherwise be needed.

## Recovery

```bash
trew history "Quarterly plan.md"
trew restore "Quarterly plan.md" --uid 42
trew restore "Quarterly plan.md" --uid 42 --to "Recovered plan.md"
```

Restore never overwrites an existing file. If the target is occupied, it writes
a copy such as `Quarterly plan (restored 42).md`. On a writable client, it then
attempts to send that copy. On a read-only mirror, the copy stays local.

When the server is restored from a `trewd backup` snapshot, this client needs
nothing from you. The restored server has a new history, and at its next
connection the client reads that history as a fresh listing: files that match agree, files
that differ are kept both ways as a conflict copy, files only this device holds
are sent back (unless it is read-only), and nothing is deleted because the
restored history lacks it. A note deleted after that backup was taken can
therefore come back; delete it again if you still want it gone.

If the server's data directory was instead copied back by hand, the client
stops with a `cursor` error. Back up the server, then `trew unlink` and pair
again with a new invite. Local files are kept, and what only this device holds
is sent back. Either way the next edit made on two devices at once keeps both
versions instead of merging them, because the last agreed version is gone.

If a command reports a version kept at a hidden path, preserve that file and
`.trew/`. Copy the retained version to a new visible filename and inspect it
before removing recovery material. An unreadable recovery inventory needs
attention even when other transfers succeed.

## Automation and output

Use `--json` for structured command output. `mcp` and `mcp-token` refuse this flag.
MCP stdout is protocol-only for stdio and empty for HTTP; `mcp-token` prints
the token once, or the id and path when exporting.
Exit **0** means the command succeeded,
**1** means a failure or unresolved issue, and **2** means invalid arguments.
For sync, `outcome` explains the result and the counters describe the work.

A conflict exits 0 because both versions were preserved. Ignored files and
changes held back by read-only mode also do not make a sync fail. Inspect those
fields if your job needs a stricter condition. Hidden versions awaiting recovery
and an unreadable recovery inventory make sync fail until addressed.

Restore separates `restored` (the local file was written), `sent` (that copy was
acknowledged by the server), and `ok` (the overall operation succeeded). If the
copy was restored but sync failed, retry `trew sync` to avoid creating another copy.

To keep invites out of command arguments, use an existing private file or
standard input:

```bash
trew pair --key-file /private/path/invite.txt --read-only
trew pair - --read-only < /private/path/invite.txt
```

`trew invite` prints the new invite, so protect its output and logs. For
`mcp-token`, `--key-out` creates a new private file, refuses to overwrite one,
and suppresses the token on stdout.

## Files and local state

TrewSync stores this device's credential and the sync index in `.trew/`, which
never syncs. Protect this directory: a copy of it can connect as this device
until you revoke the device. Unlink through the command rather than deleting
state files by hand.

The CLI excludes dot-prefixed files and folders, `node_modules`, and the
Obsidian configuration folder. Use `--config-dir NAME` if yours differs from
`.obsidian`. Add `--ignore NAME` for a file or folder name to exclude at every
depth; repeat the flag for more names. These choices apply to this device only.

A name that starts with a dot never syncs from any device, at any depth, so a
folder such as `.attachments` stays on this machine. The server also refuses
paths Obsidian could not hold: longer than 1,024 bytes, a file or folder name
longer than 255 bytes, control characters, backslashes, no-break spaces, and a
few more. Two paths that differ only in letter case, such as `Notes/a.md` and
`notes/a.md`, cannot both sync either, because a case-insensitive disk would
hold them as one. A refused path stays on this device and `trew status` lists
it with the reason; rename it and sync again.

Equivalent Unicode filename spellings are normalized. If two distinct files
would become the same name, TrewSync blocks those paths and identifies them;
rename one yourself. Keep clients updated together to avoid older clients
reintroducing obsolete spellings. Filesystem renames can appear as a deletion
of the old path and a creation of the new one; both names retain their history.

## A command says the vault is locked

Stop an existing watcher before starting another command that writes to the
vault. On supported local macOS and Linux setups, process exit releases the
lock automatically, including after a crash.

If TrewSync reports that manual recovery is required, run `trew unlock` after
confirming the previous process has stopped. It refuses a live local holder.
`--force` is only for a holder recorded on another machine and requires you to
verify that it is stopped. Shared network vaults remain unsupported.

## More

- [Install with an agent](https://github.com/waynehoover/trew/blob/main/llm.md)
- [All documentation](https://github.com/waynehoover/trew/blob/main/docs/index.md)
- [Command reference](https://github.com/waynehoover/trew/blob/main/docs/cli-reference.md)
- [Security and privacy](https://github.com/waynehoover/trew/blob/main/docs/security.md)
- [Build and contribute](https://github.com/waynehoover/trew/blob/main/docs/development.md)

## Preview and verify

`trew preview --dir ~/vault` shows planned changes without writing notes.
Add `--json` for file actions and counts. Run `trew sync --verify --dir ~/vault`
to re-read every file when an external edit may have preserved its timestamps.
History supports `--before UID` for older pages; see the
[CLI reference](https://github.com/waynehoover/trew/blob/main/docs/cli-reference.md).
