# Server reference

[Documentation](index.md) · [Setup](server.md) · [Maintenance](server-operations.md)

`trewd` runs the server and its maintenance commands. Commands that use a
store, plus `service`, accept `-data DIR`; the default is `$TREW_DATA`, then
`~/.trew`. When the server's data directory is anywhere else, give it to every
command, or set `TREW_DATA` to it. `health` uses an address instead, and
`version` needs neither. Only `serve` creates a new server data directory.
`trewd -h` shows `serve`'s flags, the default command; `trewd COMMAND -h`
shows another command's.

## Commands

| Command | Purpose | Can the server remain running? |
|---|---|---|
| `serve` | Serve one vault; also the default command. | One server per data directory. |
| `invite` | Print an invite that adds one device. | Yes; it goes through the running server. |
| `devices [-json]` | List devices and outstanding invites. | Yes; it goes through the running server. |
| `revoke ID` | Stop a device syncing and cancel the invites it made. | Yes; it goes through the running server. |
| `uninvite ID` | Cancel an outstanding invite. | Yes; it goes through the running server. |
| `cat -path P [-uid N]` | Print a note, or one version of it, straight from the store. | Yes. |
| `history -path P [-limit N] [-before UID]` | List a note's versions, newest first, with the uid `cat` takes; 50 a page by default, `-before` for the next. | Yes. |
| `deleted [-limit N] [-before UID]` | List deleted notes and the version to restore each from; 100 a page by default. | Yes. |
| `export -uid N -to FILE` | Write one version to a new file. | Yes. |
| `doctor [-json]` | Diagnose the data directory and a running server; changes nothing. | Yes. |
| `backup -to FILE -encrypt-to KEY` | Take a verified backup, encrypted to an age recipient. `-plaintext-ok` writes a plaintext directory instead. | Yes. |
| `backup-key -out FILE` | Make the age identity backups are encrypted to. | Independent of serving. |
| `unpack -from FILE -identity KEY -to DIR` | Decrypt a backup into a new data directory and verify it. | Independent of serving. |
| `rehearse -backup PATH` | Restore a backup where nothing can reach it and prove it, recording the result for `doctor`. | Yes. |
| `verify [-deep]` | Check stored entries and content. | Yes. |
| `stats [-json]` | Inspect storage and potential reclaimable space. | Yes. |
| `purge -confirm VAULT -backup DIR` | Remove old versions and unused content. | No. |
| `service` | Print a systemd unit and installation instructions. | Prints only. |
| `health` | Check a running server. | Yes. |
| `update [-dry-run]` | Replace this binary with the newest verified server release. | Yes; restart it afterwards. |
| `mcp-token -label L` | Mint, list (`-list`) or revoke (`-revoke ID`) a token for the MCP endpoint. | Yes; it goes through the running server. |
| `audit [-since WHEN] [-json]` | List what agents' write operations, and every undo, changed. | Yes; it goes through the running server. |
| `undo OPID [-to-copy] [-json]` | Undo one operation from the audit, or copy what it replaced. | Yes; it goes through the running server. |
| `restore -to-uid N [-head H -apply]` | Put the whole vault back as it was at a uid, as one undoable operation; a dry run without `-apply`. | Yes; it goes through the running server. |
| `config show`, `config set KEY VALUE`, `config unset KEY` | Read and change the [configuration file](#configuration-file). | Yes; it goes through the running server, which uses the change at once. |
| `git-export set`, `status`, `disable`, `adopt [SHA]` | Keep a [Git history](git-export.md) of the vault and push it to a remote, or continue a branch that already has history. | Yes; it goes through the running server. |
| `version` | Print version, platform, and toolchain. | Independent of serving. |

## serve

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `:3003` | Listen address. Use `127.0.0.1:3003` behind a local proxy. |
| `-url` | This machine's addresses, as `wss://` at the server's own port | The `ws://` or `wss://` address devices reach, which invites carry. Give the proxy's address: nothing at the server's own port speaks TLS, so the default works for no device. |
| `-localhost` | Off | Bind to loopback and put a `ws://` address in invites, for a trial on one machine. |
| `-invite-out` | `first-invite` in the data directory | Where to write the first device's invite when the vault has no devices. |
| `-vault` | `default` | The vault this server serves. |
| `-max-file` | `67108864` | Maximum file size in bytes: 64 MiB; maximum 256 MiB. |
| `-max-batch-bytes` | `16777216` | Upload batch budget: 16 MiB; may be lowered, not raised. |
| `-max-fetch-bytes` | `67108864` | Download body budget: 64 MiB; maximum 256 MiB. |
| `-allow-origin` | No extras | Additional exact browser origin; repeatable. |
| `-mcp` | Off | Also serve the MCP endpoint at `/mcp` for agents; see below. |
| `-allow-ephemeral` | Off | Start an empty store on storage a restart or a container replacement erases. |
| `-alert-every` | `5m` | How often the server checks itself and logs an alert with its remedy; `0` turns it off. |
| `-daily-folder` | The vault's root | The folder daily notes are in, as Obsidian's Daily notes "New file location". |
| `-daily-format` | `YYYY-MM-DD` | A daily note's name, as Obsidian's Daily notes "Date format"; may hold `/`. |
| `-daily-template` | None | The vault path of the daily template, as Daily notes "Template file location". |
| `-templates-folder` | `Templates` | Where `create_from_template` finds templates, as Templates "Template folder location". |
| `-template-date-format` | `YYYY-MM-DD` | What a template's `{{date}}` writes, as Templates "Date format". |
| `-template-time-format` | `HH:mm` | What a template's `{{time}}` writes, as Templates "Time format". |
| `-timezone` | The server's local zone | IANA zone the daily-note tools read "today" and `{{time}}` in. |
| `-git-export` | Off | Keep a [Git history](git-export.md) of the vault; `-git-export=false` turns off one the file turns on. |
| `-git-export-remote`, `-git-export-key`, `-git-export-token`, `-git-export-known-hosts`, `-git-export-branch`, `-git-export-lfs-threshold`, `-git-export-quiet` | See [git-export](#git-export) | The Git export's settings; any of them turns the export on. |
| `-v` | Off | Verbose logging. |

Every flag from `-daily-folder` down is also a key in the
[configuration file](#configuration-file), and the flag wins over the file for
as long as that server runs.

Batch and fetch budgets cannot be smaller than one maximum-sized chunk.
Built-in browser origins are `app://obsidian.md`, `capacitor://localhost`, and
`http://localhost`; non-browser clients without an Origin header are allowed.
Origins matching the request's Host are also accepted. These handshake checks
do not replace device authentication.

Flags specifying bytes accept integers, not `MiB` suffixes. For a 128 MiB file
limit in Compose:

```yaml
command: ["serve", "-addr", "0.0.0.0:3003", "-max-file", "134217728"]
```

Larger files cost more client memory, especially on phones. The server refuses
to start if its file limit is below a current live file already stored. Raise
the limit to start it; to lower it later, first delete or shrink those files
through a client and let the changes sync. Purge alone keeps current files.

`serve` refuses to start an empty store on a RAM-backed filesystem, or on a
container's own writable layer, which the next upgrade replaces: mount a
persistent volume there, or pass `-allow-ephemeral` for a trial you mean to
throw away. A store that already holds notes there is served, and every start
logs that it is one restart from gone.

Every few minutes (`-alert-every`) the server runs the cheap half of `trewd
doctor` on itself and logs `msg=alert` with the check, what is wrong and its
remedy when something needs attention: the disk filling, a backup failing or
older than two days, a body missing or quarantined, commits failing, the search
index behind, a device that has stopped advancing, a token expiring. An alert
is logged when raised, when it changes, once a day while it stands, and once
when it clears (`msg="alert cleared"`).

Every `serve` keeps a search index in `search.db` in the data directory, with
`-mcp` or without it: `trew search` on a device and the endpoint's
`search_notes` ask the same one. It is derived, built and updated by a worker
that never delays a write, rebuilt from the store when it is missing or
damaged, and not part of a backup. A `search.db` that cannot be opened is kept
as `search.db.broken` for inspection and may be deleted. Until the index has
caught up a search reads every note, so nothing is missed, only slower. The
first build of 10,000 notes (17 MB of Markdown) took 6.9 s, in the background
after the port had opened; a restart checks the existing index against the
store, 0.74 s for the same notes, after the port is bound, so a device
reconnecting meanwhile waits rather than being refused. The index takes about
twice the notes' size on disk (39 MB there). There is no flag to turn it off.

The daily-note and template settings matter only with `-mcp`, for the
[daily-note and template tools](agent.md#daily-notes-and-templates). Obsidian
keeps them in `.obsidian/daily-notes.json` and `.obsidian/templates.json`,
which never sync, so copy them from Obsidian's settings into the configuration
file (`trewd config set daily.folder Journal`) or give them as flags. `serve`
refuses to start with a path the server would refuse or a date format it
cannot write as Obsidian does, naming the key or the flag. A unit from `trewd
service` needs none of these on its `ExecStart` line: `serve` reads the file in
its data directory.

Every `serve` runs the [Git export](git-export.md)'s worker, which does nothing
while the export is off. It reads only what the store has committed and never
takes the commit lock, so it cannot delay or refuse a write; its trouble, git
missing or a push failing, is its status and doctor's `git-export` check, never
a reason not to serve.

On a vault with no devices, `serve` writes an invite for the first one to
`-invite-out`, mode 0600, and logs that path and its expiry, never the invite.
The file has one line per address the invite names, all the same invite. A
restart while it is still outstanding leaves the file alone.

## Configuration file

`trewd.json` in the data directory holds the settings that are not about the
store, so a unit file or a compose file can carry no flags for them. It is
mode 0600 and holds no secret: the Git export's credential is named by its
path. One object with a section per feature:

```json
{
  "git_export": {
    "enabled": true,
    "remote": "git@github.com:you/vault-history.git",
    "key": "/var/lib/trew/keys/vault-history",
    "quiet": "5m"
  },
  "daily": {
    "folder": "Journal",
    "template": "Templates/Daily",
    "timezone": "Europe/London"
  }
}
```

**Precedence, setting by setting: a `serve` flag, then the file, then the
default.** A flag wins for as long as that server runs; the file wins over the
built-in default. `trewd config show` prints each setting's value and where it
came from (`flag`, `file` or `default`), as the running server uses it when
one runs.

`trewd config set KEY VALUE` and `trewd config unset KEY` change one key.
With a server running they go through its control socket: the server checks
the value as it would use it, writes the file, and takes the change up at once
(a `daily.*` key reaches the MCP tools' next call, a `git_export.*` key the
export's next step), saying so, or saying that a flag it was started with still
wins. With no server they write the file under the server lock, and `serve`
reads it when it starts. The data directory must exist; the file can be
written before the first `serve`. A key this build does not know, a value its
feature cannot use, and a file that is not valid JSON are refused, and `serve`
refuses to start on a file it cannot read rather than ignore it. The file may
be edited by hand while the server is stopped.

| Key | `serve` flag | Default |
|---|---|---|
| `git_export.enabled` | `-git-export` | `false` |
| `git_export.remote` | `-git-export-remote` | None: the repository stays local |
| `git_export.key` | `-git-export-key` | None |
| `git_export.token` | `-git-export-token` | None |
| `git_export.known_hosts` | `-git-export-known-hosts` | GitHub's published keys, for github.com |
| `git_export.branch` | `-git-export-branch` | `main` |
| `git_export.lfs_threshold` | `-git-export-lfs-threshold` | `10485760` (10 MiB); `0` never uses LFS; `KiB`, `MiB` and `GiB` suffixes accepted |
| `git_export.quiet` | `-git-export-quiet` | `5m` |
| `daily.folder` | `-daily-folder` | The vault's root |
| `daily.format` | `-daily-format` | `YYYY-MM-DD` |
| `daily.template` | `-daily-template` | None |
| `daily.templates_folder` | `-templates-folder` | `Templates` |
| `daily.template_date_format` | `-template-date-format` | `YYYY-MM-DD` |
| `daily.template_time_format` | `-template-time-format` | `HH:mm` |
| `daily.timezone` | `-timezone` | The server's local zone |

Paths given to `config set` are made absolute. `-json` prints `config show`
as JSON.

## git-export

`trewd git-export set` writes the `git_export` section of the configuration
file and turns the export on; `status` says what it is doing; `disable` turns
it off and keeps the settings. [Keep a Git history of your vault](git-export.md)
is the step-by-step guide, including the deploy key and the privacy it costs.

```bash
trewd git-export set -remote git@github.com:you/vault-history.git -key ~/.trew-keys/vault-history
trewd git-export status [-json]
trewd git-export disable
trewd git-export adopt [-json]
trewd git-export adopt SHA [-json]
```

| `set` flag | Meaning |
|---|---|
| `-remote URL` | `git@host:owner/repo.git`, `ssh://`, `https://` or `file:///`. A URL carrying a password or token, `http://` and `git://` are refused. |
| `-key FILE` | SSH remote: the deploy key's private half. Refused unless mode 0600 or stricter. |
| `-token FILE` | HTTPS remote: a file holding an access token for that one repository. Refused unless mode 0600 or stricter. |
| `-known-hosts FILE` | SSH remote: the known_hosts file the host key is checked against, strictly. Needed for any host but github.com. |
| `-branch B` | The branch to write and push; default `main`. |
| `-lfs-threshold N` | Files larger than N bytes go to Git LFS (`KiB`, `MiB`, `GiB` accepted); `0` never; default 10 MiB. |
| `-quiet D` | How long a device must stop writing before its versions are one commit; default `5m`, at most `24h`. |
| `-local` | Keep the repository on this machine only, clearing the remote and its credential. |

The repository is `git-export/repo.git` in the data directory, beside its
state (`git-export/state.db`). Both are derived from the store and not part of
a backup. Commits are pushed with a lease: the remote's branch moves only from
the commit the export last pushed, so a commit somebody else pushed there is
never overwritten; the export refuses and says so until `trewd git-export set`
is run again with the branch back at one of its commits, or with another
`-branch`. `status` and doctor name a credential by its path only.

`adopt` is the one exception, made explicitly and once, for a branch that
already holds history to keep, such as the Obsidian Git plugin's `main`
([Continue an existing backup branch](git-export.md#continue-an-existing-backup-branch)).
With no argument it fetches the configured remote's branch and prints its tip
(commit, committer date, subject), changing nothing. Given that tip back, all
40 hexadecimal digits, it records it as the adopted commit in
`git_export.adopted` (`{"remote", "branch", "commit"}`, applied only while the
export's remote and branch are those) and in the export's state: the export's
first commit on the branch is then a child of it, with the store's notes as its
tree and a message naming it (`Trew-Continues` trailer), and the first push is
a fast-forward. A commit that is not the tip, a branch the export already
pushed to, and a branch the remote does not have are refused. Commits the
export made locally and never pushed are set aside and made again on the
adopted commit. After adoption the remote's branch is accepted at the adopted
commit only before the first push, and at the export's own commits after it.
A rebuild from scratch fetches the adopted commit again and makes the same
commits. The command waits up to 20 minutes for the fetch.

The server runs `git` (2.36 or later) and `git-lfs` (3.0 or later) with an
environment of its own: no user or system Git configuration, no hooks, no
credential helper but its own, no prompt, and for SSH only the given key, no
agent, and strict host key checking against the one known_hosts file.

## The MCP endpoint

`serve -mcp` answers MCP's streamable HTTP at `/mcp` on the same port, with
read tools over the notes the server stores: `vault_status`, `list_notes`,
`read_note`, `search_notes`, `note_history`, `deleted_notes`,
`compare_versions`, `delivery_status`, `lookup_operation`, and the vault-health
tools `backlinks`, `outgoing_links`, `broken_links` and `orphans`. A token minted
with `-scope write` also gets the write tools, below. [Connect an agent](agent.md)
is the guide to setting a client up. A client authenticates with
`Authorization: Bearer <token>`:

```bash
trewd mcp-token -label "Claude on Mac"                   # prints the token once
trewd mcp-token -label "Claude on Mac" -key-out FILE     # or writes it to a new file, mode 0600
trewd mcp-token -list                                    # ids, scopes, expiry, use counts
trewd mcp-token -revoke ID
```

A token reads the whole vault, and what it reads reaches the agent's model
provider. It has read scope unless minted with `-scope write`, and expires
after 90 days unless `-ttl` says otherwise (`-ttl 0` never expires). Every
note-derived string in a result arrives under `untrusted_content`, apart from
what the server vouches for under `trusted`.

`-key-out` never writes over a file. A name that is already taken is refused
before a token is minted, and a file that appears there in the meantime is
refused by the write itself. If the file cannot be written once the token
exists, the token is revoked at once and the command says nothing usable was
left; mint another. If that revoke fails too, the command says so, names the
token's id, and prints the `trewd mcp-token -revoke` command that ends it.

With `-addr 0.0.0.0` or the default `:3003` the endpoint listens on every
interface, and the server logs a warning saying so: keep `/mcp` behind
Tailscale or an identity-aware proxy. A request from a browser must carry an
`Origin` given with `-allow-origin`. `search_notes` asks the server's
[search index](#serve), the one every `serve` keeps, and the vault-health tools
read its link keys when it has caught up with the vault, and every note, 512 a
page, when it has not.

### Writing through the endpoint

A write token adds `create_note`, `create_directory`, `edit_note`,
`append_note`, `prepend_note`, `delete_note`, `move_note`, `restore_note`,
`add_tags`, `remove_tags`, `manage_tags`, `rename_tag`, `undo_operation`, and
the daily-note and template tools `today_note`, `append_to_daily` and
`create_from_template`, which follow the `-daily-*` and `-template*` settings
above. Each is one operation: all of it commits or none of it, as a new version of
every path it changes, which every device receives like any other. What an agent writes is
recorded with the token's label as its author, so `note_history` and
`trewd audit` name it. A version an agent's write displaces is kept for at
least 30 days, whatever purge is asked to do, and `read_note` with its uid
reads it back.

What an agent needs to know to write safely, which each tool's description
also says:

- **Read first, then write against what was read.** `read_note` returns the
  note's `uid` and the store's `epoch`. An edit, an append, a prepend, a move
  and a deletion name that uid as `base` and pass that `epoch`; if the note
  has changed since, the write is refused as `stale` with the note's
  `currentUid`, and nothing is written. Read it again rather than retry with
  the new uid unread. The epoch changes only when the server is restored from
  a backup, after which every uid read before it is refused as `stale`.
- **Exact edits only.** `edit_note` replaces text that occurs exactly once in
  the version read; there is no whole-note overwrite. Only Markdown and plain
  text notes can be changed, not Excalidraw drawings or attachments.
- **Appends to a daily note need no base.** `append_to_daily` adds its text
  to the version it reads and commits only if that is still the head, so a
  change in between is `stale`, never lost; `today_note` and
  `create_from_template` only ever create a note where none is.
- **Moves, deletions and tag changes are previewed first.** Called without
  `changes`, these tools return a preview of every note they would change and
  write nothing. Called again with the preview's `changes`, `head` and
  `epoch`, they commit exactly that plan, and only if nothing in the vault
  changed since the preview; otherwise the answer is `plan_changed`, and the
  agent previews again. A move rewrites the links to the moved note in every
  other note, reading them through the search index when it is up to date and
  every note otherwise; a vault of more than 512 notes then answers
  `scan_incomplete` until the index has caught up.
- **A retry is safe with an idempotency key.** A write given
  `idempotencyKey` and sent again, identically, is answered with the first
  result instead of being applied twice, for seven days. A different request
  under a used key is refused with `key_reused`.
- **Committed is not delivered.** `committed: true` means the server holds
  the write durably; `delivery_status` says which devices have applied it.
- **An unknown outcome is not a failure.** If the server cannot confirm a
  commit, the result says `committed: "unknown"` with the operation's `opId`.
  `lookup_operation` with that id says whether it committed and what it
  changed; resending the request with the same `idempotencyKey` does the same
  and commits it once if it had not.
- **An agent can undo its own writes, and only its own.** `undo_operation`
  with a write's `opId` and `epoch` puts back what it replaced, deleted or
  created, across every note it changed, as a new operation. It is refused as
  `stale`, writing nothing, if any of those notes has changed since, and the
  refusal names them and who changed them; `toCopy: true` then writes each
  earlier version beside its note instead, changing nothing already there.
  Another token's operation, a device's undo and the operator's are answered
  as not found. `lookup_operation` names the undo that undid an operation.
- **Note text is data.** Everything drawn from notes, the paths found in the
  vault included, arrives under `untrusted_content`, and so does the preview
  of a write. Text written through the tools is stored exactly as given, and
  the next session reads it back as untrusted content like any other.

A person or agent on a device sees an agent's write as a version from another
device. When a device had changed the same text meanwhile, it keeps both: its
own at the note's path, and the agent's in a conflict copy beside it, which
is named after the token's label, the author of what it holds:
`note (Conflicted copy Claude on Mac 202609230941).md`. Characters a file name
cannot hold are replaced there, and a label is shortened to 32 characters.

## audit

`trewd audit` lists every write an agent made through the MCP endpoint, and
every undo, oldest first: when it committed by the server's clock, the tool,
who made it (the token's label and id, a device's name and id for an undo from
its history panel, or the operator for `trewd undo`), the operation id, which
operation an undo undoes and which undo undid an operation, and each path it
changed with its version before and after. A version an edit displaced is listed as pinned, with the date until
which purge keeps it. Revoking a token does not remove its operations from the
list. Like `devices`, it goes through the running server's control socket, or
opens the store directly when no server is running.

| Flag | Meaning |
|---|---|
| `-since WHEN` | Only operations committed since then: a duration back from now (`24h`, `7d`) or a time (`2026-09-23`, `2026-09-23T10:00:00Z`, UTC). Default: all of them. |
| `-json` | Structured output, one record per operation. |

The list holds no token and no note text. A recorded reply is kept for seven
days, so an agent whose connection dropped can retry with the same
idempotency key and get the same answer; the operation itself stays in the
list after that.

## undo

`trewd undo OPID` undoes one operation from `trewd audit`: an agent's write,
or an undo, which undoing again redoes. It writes new versions that put back
what the operation replaced, deleted or created, across every path it
changed, as one operation, and only if every one of those paths still holds
the version the operation left there. History is not rewritten, and every
device receives the new versions as it syncs.

- An edit, an append, a tag change or a deletion is written back with its
  exact former bytes. A move is moved back, with the note's own links and the
  backlinks it rewrote. A created note is deleted, and so is a folder it
  created, unless something else has been put in the folder since.
- If any path has changed since, nothing is written. The refusal lists each
  path, its version now, and who wrote it, and exits non-zero.
- `-to-copy` writes each version the operation replaced beside its note, as
  `Note (restored 42).md` (then `Note (restored 42) 2.md`), and changes
  nothing already in the vault. It works whatever has happened to the notes
  since.
- An operation already undone is refused, naming the undo; undo that undo
  instead. A version the operation replaced that a purge has taken, once its
  30-day pin expired, is refused as `gone`, and nothing is written.

The undo is recorded as the operator's, and its versions carry the label
`trewd undo`, which is what `note_history` and a device's history panel show.
Like `audit`, it goes through the running server's control socket, so every
connected device receives it at once, or opens the store directly when no
server is running. `-json` prints what was done, or why not, as JSON.

A device can also undo an operation from its history panel, and an agent can
undo its own through `undo_operation`; see [the plugin guide](plugin.md#version-history).

## restore

`trewd restore -to-uid N` puts every path of the vault back as it stood at
uid N: a new version for each path whose newest version differs from what it
held then, a deletion for each path created since, and nothing for a path that
already holds the same bytes. History is not rewritten; every device receives
the restore as ordinary new versions, and every version it replaces is kept
for 30 days, so `trewd undo OPID` of the restore puts everything back.

Without `-apply` it is a dry run: it lists each step and the head it planned
at. `-head H -apply` with that number applies exactly what was shown, and is
refused if anything was written since. A uid older than the last purge may no
longer be readable exactly, and the restore then refuses, naming the path,
rather than guess; restore a backup taken before the purge instead. `trewd
history -path P` and `trewd audit` name uids to restore to.

## doctor

`trewd doctor` checks the data directory, the store, the records the commands
leave, and a running server over its control socket, and prints each finding
with its status and what to do. It writes nothing. It exits non-zero when any
finding is `warn` or `fail`, so a timer or a monitor can run it.

| Flag | Meaning |
|---|---|
| `-url URL` | The address devices use, whose `/health` doctor asks; default the running server's own. |
| `-sample N` | Chunk references to read and hash, chosen at random; default 256. |
| `-deep` | Read and hash every body, as `verify -deep` does. |
| `-accept CHECK` | A check whose warning you have decided to live with; printed as `accepted`, and it no longer fails the run. Repeatable. |
| `-json` | The report, and the server's metrics, as JSON. |
| `-vault NAME` | The vault the server serves; default `default`. |

The checks, in order: `data-dir`, `storage`, `encryption`, `server`,
`restarts`, `identity`, `store`, `chunks`, `space`, `index`, `git-export`,
`tokens`, `devices`, `commits`, `backup`, `rehearsal`, `origin`. [Operating
TrewSync](operations.md) says what each finding means and what to do.

## backup-key, unpack, rehearse

`trewd backup-key -out FILE` writes a new age identity to FILE, mode 0600,
and its recipient to `FILE.pub`, and never writes over either. It is
post-quantum (ML-KEM-768 with X25519) by default; `-x25519` makes the classic
kind, whose recipient is short enough to type. Keep the identity off the
server: it is the only thing that reads the backups.

`trewd unpack -from FILE -identity KEY -to DIR` decrypts an encrypted backup
into DIR, which must be new or empty, checks every body against its name and
the database against the archive's manifest, writes the database last, brings
a store an older `trewd` wrote up to this build's schema, and then runs
`verify -deep` on the result. A damaged or truncated archive never
becomes a data directory. `-record DIR` (a data directory, or a copy of its
`last-backup.json`) compares the archive's SHA-256 with the last encrypted
archive a backup wrote whole from there, which a failed or plaintext backup
since does not change, before decrypting, and refuses another archive unless
`-not-last-backup` is given; a `-record` with no record there, or one that
records no encrypted backup, is refused rather than ignored. Without `-record`
it prints the digest and says it was not compared. Anyone holding the
recipient can make an archive the identity opens, so an archive that decrypts
is not proof the server wrote it.

`trewd rehearse -backup PATH [-identity KEY]` rehearses a restore of an
encrypted archive or a plaintext backup directory: into a work directory of
its own inside the data directory (`-work` for another, `-keep` to keep it),
verified deeply, compared with every version the live store holds up to the
backup's newest uid, served on a loopback port, downloaded whole by a newly
paired device and compared byte for byte, and its search index rebuilt. It
prints how long the restore took and how old the backup is, and records the
result for `doctor`. An encrypted archive must be the last backup the data
directory recorded, compared by its SHA-256 before it is decrypted;
`-not-last-backup` rehearses another one of your own, with a warning.

## invite, devices, revoke, uninvite

These administer the vault's devices. While `serve` runs they go through its
control socket, a private socket in the data directory, so a revoke takes
effect in the running server at once; with no server running they open the
store directly. The socket answers only the account that runs the server, and
root, so run them as that account. All take `-data DIR` and `-vault NAME`,
which go before an ID: `trewd revoke -data /var/lib/trew DEVICE_ID`.

| Flag | Command | Meaning |
|---|---|---|
| `-ttl DURATION` | invite | How long the invite works, such as `30m`; default `1h`. `0` makes one that never expires. |
| `-label TEXT` | invite | A name shown in the device list until the invite is used. |
| `-out FILE` | invite | Write the invite to this file, mode 0600, instead of printing it. |
| `-url URL` | invite | The address the invite names. Default: the running server's, which is right only when it was started with `-url` or `-localhost`; with no server running, this machine's addresses as `wss://` at port 3003, one line each. Give the proxy's address. |
| `-json` | devices | Structured output. |

An invite works once and expires after one hour by default. Anyone holding it
before it is used can add a device, so hand it over privately. Revoking a
device stops it receiving and sending at once, and cancels the invites it
created; the last device can be revoked too, and `trewd invite` pairs a new one.

## backup, verify, purge, stats

| Flag | Command | Meaning |
|---|---|---|
| `-to PATH` | backup | Required: the archive file with `-encrypt-to`, the destination directory with `-plaintext-ok`. |
| `-encrypt-to KEY` | backup | An age recipient (`age1...` or `age1pq1...`) to encrypt to; repeatable. |
| `-recipients-file FILE` | backup | A file of age recipients, one per line, such as `backup-key`'s `FILE.pub`; repeatable. |
| `-plaintext-ok` | backup | Write a plaintext data directory: every note readable by whoever can read it. |
| `-deep` | backup, verify | Re-read content hashes and validate device/invite records. |
| `-vault NAME` | purge | Vault to purge; default `default`. |
| `-confirm NAME` | purge | Exact vault name, required as confirmation. |
| `-backup DIR` | purge | Backup that must pass the command's checks. |
| `-no-backup-check` | purge | Explicitly bypass backup validation; destructive recovery is then your responsibility. |
| `-grace DURATION` | purge | Retain recent unreferenced content; default `1h`. Use `0` to collect it immediately. |
| `-json` | stats | Structured output. |

A backup has to say which it is: with neither `-encrypt-to` nor
`-plaintext-ok` it is refused and nothing is written. An encrypted backup is
staged as an ordinary verified backup in `backup-staging` inside the data
directory, where the plaintext already is, and only the archive leaves it; the
staging copy makes the next backup incremental and can be removed whenever no
backup is running. Both kinds carry the [configuration file](#configuration-file),
`trewd.json`, and neither the Git export's repository; [Restore](server-operations.md#restore)
says what a restore does with each.
Each backup, good or failed, is recorded in `last-backup.json` for `doctor`.

Follow the [purge procedure](server-operations.md#purge), including a separate
pre-purge backup. Purge checks a plaintext backup directory, so that one is
taken with `-plaintext-ok`, onto encrypted storage. A deletion record can survive after its restorable content is
purged.

Purge never removes a version an agent's edit, move or delete displaced until
30 days after that edit, however old the version is: it is the only copy of
what the note said before the agent touched it. `stats` and `purge` report how
many versions are kept this way; after the 30 days they are ordinary history.

Useful `stats -json` fields:

| Field | Meaning |
|---|---|
| `files`, `folders`, `bytes` | Current live content. |
| `deleted`, `recoverable`, `purged` | Deleted paths and recovery availability. |
| `versions`, `history` | All versions and the older versions eligible for purge; required move/deletion history is retained. |
| `pinned` | Older versions purge keeps because an agent's edit displaced them within the last 30 days. |
| `latestUid` | Newest version still present. |
| `allocatedTo` | Highest version number ever allocated; does not go backward after purge. |
| `purges` | Purge generation. |
| `reclaimBytes`, `reclaimBodies` | Unreferenced content eligible under the grace policy. |
| `recentBytes`, `recentBodies` | Unreferenced content retained by the grace period. |
| `reclaimComplete` | Whether the storage scan completed; check before using estimates. |

Vault-specific fields appear in the `vaults` array. `stats` is an inspection;
use `health` to check whether the running server can accept writes.

## service

| Flag | Meaning |
|---|---|
| `-addr`, `-vault` | Listen address and vault in the generated unit. |
| `-max-file N` | File limit to preserve in the unit. |
| `-user NAME` | Service account; default is the caller. |
| `-binary PATH` | Installed binary path; default is the running executable. |
| `-mcp` | Also serve the MCP endpoint at `/mcp`, as `serve -mcp` does. |

The generated unit uses a 30-second stop timeout and limits repeated restarts.
After fixing a repeated startup failure, `systemctl reset-failed trew` may be
needed before starting it again.

## health

`trewd health` requests `/health` and exits non-zero on failure. Its flags are
`-addr` (default `127.0.0.1:3003`) and `-timeout` (default `5s`).

| HTTP response | Meaning |
|---|---|
| `200 ok` | Current readiness checks pass. This is not a deep integrity check. |
| `503 store-unreadable` | Database cannot be read. |
| `503 store-read-only` | Database cannot accept a write transaction. |
| `503 chunks-read-only` | Stored-content directory cannot be written. |
| `503 chunks-unreachable` | Stored-content directory is unavailable. |
| `503 disk-full` | Free space is below the readiness threshold of 64 MiB. |
| `503 store-busy` | Temporary write contention exceeded the check's wait. |
| `503 shutting-down` | Server is draining connections. |

Inspect logs, capacity, mounts, and permissions according to the result. Do not
restart repeatedly just because the store is busy. Use `verify -deep` for
integrity checks. Health responses are unauthenticated and intentionally omit
vault names, paths, and detailed storage figures. The server runs the checks
at most once a second and gives every request in that second the same answer,
so a fault shows up within a second and a flood of requests costs one check.

## update

`trewd update` replaces the running binary with the newest server release,
after checking who built it. It needs the
[packslip](https://github.com/jdx/packslip) CLI on `PATH`
(`mise use -g github:jdx/packslip`); without it, it refuses.

| Flag | Meaning |
|---|---|
| `-dry-run` | Download and verify, then stop without replacing anything. |
| `-version X.Y.Z` | Install this release instead of the newest; never an older one. |
| `-binary PATH` | Replace this trewd instead of the running one. |
| `-feed URL` | Read releases from this GitHub API base, such as a mirror. |
| `-packslip PATH` | The packslip executable to verify with. |

It installs a release only when its `packslip.server.sigstore.json` is signed
by this repository's release workflow run from that release's own
`server/vX.Y.Z` tag, through GitHub's issuer, the downloaded binary matches the
digest and size signed for it and the release's `SHA256SUMS`, and the new
binary runs here and reports the version it was released as. The replacement
is one rename in the binary's directory, so an interrupted update leaves the
old binary in place. It refuses an older release, a development build, a
binary Homebrew, Nix or mise installed, and one inside a container (Docker,
Podman or Kubernetes), whose image is what to update; and it does not restart
the server.

## Ceilings

These are implementation limits for operators and client authors.

| Limit | Value |
|---|---|
| Registered devices per vault | No fixed limit. |
| Authenticated connections per vault | No fixed limit. |
| File | 64 MiB default; configurable up to 256 MiB. |
| Chunk body | 1 MiB. |
| Chunks per entry or fetch | 65,536. |
| Path | 1,024 bytes of UTF-8; each file or folder name at most 255 bytes. |
| Entries per upload batch | 256. |
| Encoded upload batch and summed body budget | 16 MiB maximum. |
| Fetch body budget | 64 MiB default; configurable up to 256 MiB. |
| Post-handshake frame | 32 MiB. |
| Pre-handshake frame | 64 KiB. |
| Connections awaiting a handshake | 32. |
| Handshake timeout | 10 seconds. |
| Vault and device names | 64 bytes, no control characters. |
| Invite lifetime | One hour by default, and at most one hour when a device asks; `trewd invite -ttl 0` on the server makes one that never expires. |
| Deleted entries per protocol page | 1,000, with continuation information. |

## Stopping it

Allow at least 15 seconds for graceful shutdown. The provided systemd unit and
Compose file allow 30 seconds. Keep that allowance in custom process managers
so requests in progress can finish before the process is killed.
