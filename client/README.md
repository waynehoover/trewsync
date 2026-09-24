# TrewSync command-line client

**Self-hosted vault sync with full version history, on a server you run.**

`trew` is TrewSync's headless client: a paired device that is a folder rather
than an Obsidian vault. Keep a copy of your notes on a NAS or another machine
without Obsidian, as a read-only mirror or a two-way peer, and read history and
recover notes from the terminal. It runs the same sync engine as the
[Obsidian plugin](https://github.com/waynehoover/trew/blob/main/docs/plugin.md).

The server it syncs through can read what it stores; see
[Security and privacy](https://github.com/waynehoover/trew/blob/main/docs/security.md).

**Experimental.** Use macOS or Linux, Node **22 or newer**, and a local
filesystem. Run one TrewSync process that writes to each directory, and keep
other sync tools and the Obsidian plugin off that same directory.

The package installs a command called `trew`. The server's command is `trewd`,
so a machine can have both on its path.

## Set up a mirror

Create an invite on an existing device, using **Add another device → Create
invite** in the plugin, `trew invite` on a paired client, or `trewd invite` on
the server. Then, on the mirror machine:

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
saved during pairing, so later syncs keep local changes from being uploaded
even without the flag. To keep the invite out of your shell history, use
`trew pair --key-file /private/path/invite.txt` instead.

Keep the process running for continuous sync. For a scheduled job, use
`trew sync --dir /path/to/trew-mirror` instead.

## Everyday commands

| Command | Use it to… |
|---|---|
| `trew pair INVITE` | Join a vault with an invite; run it again to finish an interrupted pairing. |
| `trew sync` | Sync once and exit; `--watch` keeps syncing. |
| `trew status` | Check connection, local changes, refused paths, and recovery issues. |
| `trew preview` | Show planned sync changes without writing notes. |
| `trew invite` | Add another device with a single-use invite. |
| `trew devices` | List devices and outstanding invites. |
| `trew revoke ID` | Stop a device syncing. |
| `trew history "Note.md"` | View a note's versions, newest first. |
| `trew deleted` | List deleted notes and whether they can be restored. |
| `trew restore "Note.md"` | Restore the newest version with content, never over an existing file. |
| `trew unlink` | Remove local pairing and index while keeping notes. |

## Read more

- [The command-line client guide](https://github.com/waynehoover/trew/blob/main/docs/client.md):
  the first device on a new server, mirrors and merging, recovery, automation,
  local state and locking.
- [Command reference](https://github.com/waynehoover/trew/blob/main/docs/cli-reference.md):
  every command, flag, exit status and JSON field.
- [Connect an agent](https://github.com/waynehoover/trew/blob/main/docs/agent.md):
  the server's MCP endpoint. `trew mcp`, this client's own MCP server over a
  separately paired directory, is described in the guide.
- [Set up the server](https://github.com/waynehoover/trew/blob/main/docs/server.md)
  and [all documentation](https://github.com/waynehoover/trew/blob/main/docs/index.md).

[MIT](https://github.com/waynehoover/trew/blob/main/LICENSE).
