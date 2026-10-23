# Changelog

What changed in TrewSync, newest first, for people running it. The server,
the Obsidian plugin and the command-line client are released separately
(`server/vX.Y.Z`, `X.Y.Z` and `cli/vX.Y.Z` tags), and each GitHub release
carries its own notes with upgrade steps. This file collects them in one place
and records what is merged but not yet released.

Protocol compatibility, not release numbers, decides whether a server and a
client can talk; upgrade the server first.

## Unreleased

### Plugin

- **Attachments on demand.** A device can leave attachments of 1 MB or more
  (or 10 MB, or all of them) on the server and download each one when a note
  that uses it is opened, or when it is tapped. Off by default, per device;
  notes, canvases and settings always download. **Free space** removes
  attachments the setting covers from the device, each checked against the
  server first. See [the plugin guide](docs/plugin.md#attachments-on-demand).

### Server

- An agent's preview is no longer expired by a device saving its settings
  between the preview and the apply. The apply is refused as `plan_changed`
  only when a note changed; the operator's `trewd restore` is still bound to
  the vault's exact head.
- A settings save no longer shapes the Git export's commits: one saved
  between two note edits could split a device's commit in two or move its
  time. The export's position still moves past it. A history exported by
  0.14.2 or earlier and rebuilt from scratch can differ where that happened,
  so keep `git-export/` across the upgrade.

### Plugin

- A changed setting is sent once it has been left alone for ten seconds, not
  on every save. Obsidian saves a setting about a second after you change it,
  and some plugins' settings tabs save on every keystroke; each save used to
  become a version in the server's history. **Sync now** still sends at once.

### Command-line client

- A note a crash cut off part way through being replaced is put back at the
  next run. `trew` moves a note aside before linking its new version in, and
  a crash between the two left nothing at the note's name, which the next run
  sent to every device as a deletion. The note was always kept, reported as
  stranded.

## 0.15.3, plugin, 0.14.2, server, and trew 0.13.1 (2026-10-22)

The plugin and `trew` work with trewd 0.14.0 or later. Upgrading the
server to 0.14.2 adds `trewd deleted -settings`.

### Command-line client

- A new note is linked into place whole again, as before 0.13.0, and only
  its fsync waits to be done with the others. In 0.13.0 the name appeared
  empty for an instant before its contents, and an editor saving into it
  then would have lost that save. A first sync of 3,000 notes takes about
  10 s, against 2 to 4 s in 0.13.0 and 21 to 36 s before it.
- After a crash during a first sync, a file found whole is fetched again
  rather than kept, since nothing had made it durable.

### Server

- `trewd deleted -settings` lists deleted settings, which the list of deleted
  notes leaves out: Obsidian's, themes, snippets and plugins' settings, each
  with the version to restore it from.

### Plugin

- A setting removed by Apply stays removed even when another sync runs before
  Obsidian reloads. The record that holds back Obsidian's write-back of the
  old setting was dropped by that sync in 0.15.1 and 0.15.2.
- A setting another device deletes is deleted here too when this device held
  it in another key order; it was kept and never offered for Apply.
- An incoming change to a note that a crash cuts short as it is written is put
  right when Obsidian starts again. The plugin writes each such update down
  before it starts; at the next start, a note left holding part of the change
  goes back to what it held, the part is kept aside and reported, and the
  incoming change is fetched again. Before, the part could be sent to every
  device as the note's newest version. Its original was always kept in a
  conflict copy.

## 0.15.2, plugin (2026-10-22)

Works with trewd 0.14.0 or later, as 0.15.1 does. The server is unchanged.

### Plugin

- A setting saved again with the same values in another order or layout is
  no longer a change. Obsidian re-saving a setting its own way after an Apply
  no longer asks for a second Apply, and two devices that held a setting in
  different orders before they synced no longer get a conflict copy of it.
- A settings file Obsidian resets because it could not read it is no longer
  sent to your other devices. When Android stops Obsidian part way through
  saving `app.json`, Obsidian replaces the damaged file with an empty one at
  its next start, which used to reach every device as "all settings back to
  default". Now that device offers its synced settings back in **Apply synced
  settings** instead. Found by doing exactly that on a Pixel.
- The Apply dialog no longer says every setting waiting came from another
  device, and **Review conflicts** names a plugin's settings as that
  plugin's ("dataview plugin settings: data.json") rather than as Obsidian's.

## trew 0.13.0, command-line client (2026-10-22)

`trew` now speaks protocol 4, so it needs `trewd` 0.14.0 or later: upgrade
the server first. It still syncs notes only, never settings.

- A first sync writes new notes straight to their names and makes them
  durable together, instead of staging and fsyncing each one: 3,000 notes in
  2 to 4 s instead of 21 to 36 s on a Mac. A crash part way is recognised on
  the next run, which finishes with the server's notes and sends nothing of
  what the crash left part written.

## 0.15.1, plugin, and 0.14.1, server (2026-10-22)

Upgrade the server first if you want a plugin settings conflict's copy to
sync; the 0.15.1 plugin works with server 0.14.0 otherwise.

### Server

- A conflict over a community plugin's settings now syncs the copy it keeps,
  `data (Conflicted copy <device> <stamp>).json` beside the plugin's
  `data.json`. It was refused, so the other device's version stayed on one
  device, unlisted. Plugin 0.15.1 needs this to sync the copy; against
  0.14.0 the copy is refused as before.

### Plugin

- "Use the server's" now holds even when the first sync is interrupted, by
  an edit to the open note or a setting waiting out a retry. Before, an
  interrupted first pass could send this device's settings to every device
  instead.
- A setting removed by Apply stays removed. Obsidian or the plugin writing
  its old copy back before the reload is held and offered for Apply again,
  not sent to every device.
- A conflict over a plugin's settings keeps the other device's version in a
  copy that syncs, appears in **Review conflicts**, and is named in the Apply
  dialog.
- Apply can no longer be cut short by unlinking during it, and its dialog
  stays open until Obsidian reloads.
- The first-sync count no longer includes deleted files, settings waiting for
  Apply, or files waiting to retry, and no longer counts one file twice.
- The Apply dialog counts a plugin once, with or without a conflict copy.
- Documentation fixes throughout: the protocol numbers, the server each
  plugin needs, installing with BRAT (the way onto an Android App storage
  vault), and the `trew:history` and `trew:restore` Obsidian CLI commands.

## 0.15.0, plugin, and 0.14.0, server (2026-10-16)

Community plugins' settings sync. **Upgrade the server first**: the 0.15.0
plugin speaks protocol 4, and meeting an older server it stops at the
handshake and says to upgrade the server. The server still serves older
plugins and `trew` as before. `trew` stays at 0.12.0.

### Server

- Releases carry four binaries, the ones Homebrew installs: Linux and macOS,
  each on amd64 and arm64. The FreeBSD and Linux riscv64 builds stop after
  0.13.0, because no test ever ran on FreeBSD and riscv64 ran only under
  emulation. On those, build trewd from source
  ([server setup](docs/server.md#a-binary)); `trewd update` there says the
  release has no build for the machine.
- **Protocol 4: plugins' settings.** The server stores and sends each
  community plugin's settings, its `data.json`, to devices of protocol 4, and
  refuses every other file of a plugin, so nothing a device syncs is code
  another device runs. A device of 3 or less, plugin 0.14 and earlier and
  `trew` 0.12, is answered as before and never sees one. The settings of the
  plugins that sync or control a vault (obsidian-git, Local REST API,
  LiveSync, Remotely Save, Basalt Sync, SuperSync, and TrewSync itself) are
  refused in any spelling.

### Plugin

- **Plugins' settings can sync.** With settings sync on, **Manage this
  vault**, **Sync plugin settings** syncs each community plugin's settings
  with the same group; the plugins themselves are installed and switched on
  separately on each device. Off until turned on on each device. A change waits until
  you apply it, and **Apply synced settings** names each plugin and the device
  the change came from, and writes only what it named. Plugins' settings, API
  keys included, are stored on your server as they are, as notes are. Needs
  trewd 0.14.0 or later; upgrade the server first.

## 0.14.3, plugin (2026-10-16)

A first sync on a Mac is faster. No server change: the plugin needs trewd
0.13.0 or later. `trew` stays at 0.12.0.

### Plugin

- **A first sync on a Mac is faster.** Before saving its progress, TrewSync
  makes the files it wrote durable, one at a time. On macOS each of those
  waits for the drive to flush its whole cache, and with Obsidian writing its
  own caches at the same moment that was about 4 ms a file: 13 to 14 seconds
  of a 3,000-note first sync. They now run 32 at a time, which took that step
  to under 7 seconds. What is on disk before progress is saved is unchanged.

## 0.14.2, plugin (2026-10-15)

A first sync shows how far it has got. No server change: the plugin needs
trewd 0.13.0 or later. `trew` stays at 0.12.0.

### Plugin

- **A first sync counts its files.** A device joining a vault said "Syncing
  notes." for the whole of its first sync, which on a large vault is minutes,
  with "Device delivery unconfirmed." under it. It now counts the files as
  they are written, "Downloading 1,280 of 3,000 files.", and the line about
  other devices stays blank until this device has finished syncing and there
  is something true to say.

## 0.14.1, plugin (2026-10-11)

Settings that disagree can be resolved in Review conflicts. No server change:
the plugin needs trewd 0.13.0 or later. `trew` stays at 0.12.0.

### Plugin

- **Review conflicts lists settings.** A setting changed two ways on two
  devices before either synced keeps both, and the copy, which sits in
  Obsidian's settings folder, never showed in **Review conflicts**. It does
  now, as an Obsidian setting, and in the menu's count. Keeping the original
  removes the copy; keeping the copy or a combined version writes it and
  reloads Obsidian, as applying does, and a combined version of a JSON file
  has to be valid JSON.

## 0.14.0, plugin (2026-10-10)

Settings sync by group. No server change: the plugin needs trewd 0.13.0 or
later, as 0.13.0 did. `trew` stays at 0.12.0.

### Plugin

- **Settings sync is one choice on each device:** Off, Mobile only (Desktop
  only on a desktop), or Mobile and desktop, under **Manage this vault**,
  **Sync settings**. Every device keeps its own settings folder, and TrewSync
  maps it onto the group's folder on the server, so there is no settings
  profile to create, no Override config folder to set and no relaunch.
  **Create a settings profile for this device** is gone. A device that turned
  settings sync on in 0.13.0 has it off again until you choose a group.
- The TrewSync panel shows what you just changed. In 0.13.0, turning on
  **Sync settings** in Obsidian's Settings left the row saying Off; now the
  row shows the saved choice, **Manage this vault** stays open and the page
  stays where it was scrolled, after this and every other change made there.
  Settings arriving to wait for **Apply and reload** appear in a panel that is
  already open, with the button.
- The sync preview says what turning on settings sync will do with a setting
  this device has never synced. With **Use the server's** chosen it said
  "Keep both versions" of a file the sync then took from the server.

## 0.13.0, server and plugin (2026-10-10)

Settings sync. **Upgrade the server first**: the 0.13.0 plugin speaks protocol
3, and meeting an older server it stops at the handshake and says to upgrade
the server. The server still serves older plugins and `trew` as before. `trew`
stays at 0.12.0, since nothing in it changed.

### Plugin

- **Settings sync**, off until you turn it on, on each device: **Manage this
  vault**, **Sync settings**, **Turn on**. Obsidian's own settings, core
  plugins and hotkeys included, themes and CSS snippets sync with every device
  that runs the same settings folder, so desktops can share `.obsidian` while
  phones share `.obsidian-mobile`. **Create a settings profile for this
  device** makes a phone's; do that before turning settings sync on there.
  The first time, you choose whose settings to use where the server already
  has some, and a copy of this device's settings is kept first. A change from
  another device waits until you apply it: tap the notice, or run **Apply
  synced settings and reload**, which keeps a copy of this device's settings,
  saves open notes and reloads Obsidian. Names this device skips are skipped
  in the settings folder too. Community plugins and the workspace layout do
  not sync yet. See the [plugin guide](docs/plugin.md#settings-sync).

### Server

- **Protocol 3**, which carries settings: the files settings sync carries,
  under `.obsidian` or `.obsidian-<name>`. Anything else there is refused with
  its reason, and a device's pairing and workspace never sync. Plugins and
  `trew` of protocols 1 and 2 are served as before and are never sent a
  settings file. Agents over MCP never see settings, and the Git export leaves
  them out.
- `trewd restore -to-uid` keeps a setting first synced after that uid rather
  than deleting it, and says how many it kept.

### Known issues

- An agent's preview expires whenever a device saves a setting, so the agent
  previews again.
- A deleted setting is in no deleted list; `trewd history -path` with its path
  still lists every version.
- Obsidian saving a setting again with the same values in another order can
  ask for a second Apply.

## 0.12.1, server and plugin (2026-10-09)

Released together, so that BRAT installs the plugin again.

### Plugin

- **BRAT installs and updates the plugin again.** BRAT installs from the
  release with the highest version in its tag name, server releases included,
  so from server/v0.12.0 on it tried to install the plugin from the server's
  release, found no manifest.json, and failed with "This does not seem to be an
  obsidian plugin". 0.12.1 is the plugin's own release again. If BRAT showed
  that error, check for updates once more.
- When a `wss://` address does not connect, the hint says to pair from an
  invite naming `ws://HOST`, made with `trewd invite -url`, instead of to type
  an address that nothing takes.
- The notice shown when Obsidian's keychain refuses the device token names the
  vault's own configuration folder, not always `.obsidian`.
- main.js carries the copyright notices of fflate and diff-match-patch, which
  it bundles.

### Server

- **`trewd` with no command lists the commands** instead of starting a
  server. Serving is always `trewd serve`; flags with no command are refused
  and point at it. Every shipped way of running the server (the container
  image, the unit `trewd service` prints, the Homebrew service) already says
  `serve`, so nothing deployed changes.
- An encrypted backup (`trewd backup -encrypt-to` or `-recipients-file`) of a
  data directory given as a relative path, `-data ./trew-data`, works. It
  failed after staging.
- The invite a server prints at its first start says when the addresses in it
  are guesses, because the server was started without `-url`, and how to make
  the one to paste: `trewd invite -url wss://NAME`.
- `trewd doctor`'s advice on rehearsing a restore mentions `-identity` for an
  encrypted backup, `trewd service` prints notes whose commands work as
  printed, and `trewd`'s help no longer shows a quoted command as a flag's
  argument.

## 0.12.0 and earlier

TrewSync's first release, forked from Basalt Sync 0.10.0 (protocol 7). It is a
fresh start rather than an upgrade: a Basalt device, invite or recovery key
does not work with a TrewSync server, and moving a vault is a new pairing.

### Fixed in the 2026-10-06 review

A full review of the server, the sync engine, the plugin and the headless
client; the IDs are in [docs/findings.md](docs/findings.md).

- **A restored or renamed-back note is no longer deleted again** on every
  device after a deletion both sides had made, or a rename whose
  acknowledgement was lost (T01).
- **A text update cut short on a phone puts the note back** instead of
  uploading the truncated note to every device (T09).
- **A large download batch is no longer written off** as too large when the
  server refuses one ask: the ask is split and sent again (T02).
- **A file dated before 1970 no longer breaks every device's index** (T03).
- **A download is no longer cut off by another device's save** (T55), and a
  slow upload is no longer taken for a dead connection (T56).
- **A phone's first sync is faster** (about 40% fewer filesystem calls per
  note, and the plugin's own writes no longer trigger a second round), and an
  interrupted first sync resumes without asking for the review again (T12).
- **The headless client refuses** a vault folder that was swapped for another
  (an unmounted disk, T16), a filesystem without hard links (T18), and
  compares ignored names case-folded where the disk does (T17); it keeps a
  note's permissions and escapes what it prints to the terminal (T20, T23).
- **Backups and restores:** `trewd backup` no longer overwrites a stopped
  server's data or the age key (T35), every restore starts a new epoch (T27),
  a restored store runs in WAL mode (T26), and a restore keeps the server's
  settings (T38).
- **Agents:** a template note's text can no longer reach an agent as the
  server's own words (T49), and move and delete previews of a well-linked
  note take about 0.1 s instead of seconds (T50).

### Changed from Basalt Sync

- **No end-to-end encryption.** The server stores notes, their history and
  their names in plaintext. There is no recovery key, root secret or key
  rotation; losing every device loses no synced note, and `trewd invite` on the
  server pairs a new one. Put the data directory and backups on encrypted
  storage ([Privacy](README.md#privacy)).
- **Invites.** Every device, the first included, pairs from a single-use
  `trew1i_` invite that carries the server's address and the vault's name. An
  invite expires after one hour by default. A server with no devices writes
  the first one to `first-invite` in its data directory, never to its log.
- **The device token is kept in Obsidian's keychain** on Obsidian 1.11.4 and
  later, not in the plugin's `data.json`, so a backup or synced copy of the
  vault cannot connect as the device. Older Obsidian keeps it in `data.json`.
  A copy, a renamed vault or a cleared keychain asks to pair again and loses
  no note.
- **Names.** The product is TrewSync; the server's command is `trewd`, the
  headless client's is `trew`, the plugin id and npm package are `trew-sync`.
- **Paths.** The server refuses a path Obsidian could not hold everywhere
  (over 1,024 bytes, control characters, a no-break space, any segment
  starting with a dot, and a few more) and a path that differs from another
  live one only by letter case. A refused file stays on its device and is
  listed with its reason.
- **Folders.** Deleting or renaming a folder now removes it from other
  devices once it is empty there; a folder that still holds something stays.
- **Conflict copies** are named after the author of the bytes they hold:
  another device's name, or an agent token's label.
- **One MCP, on the server.** The headless client's own MCP server and its
  credential, inherited from Basalt Sync as `trew mcp` and `trew mcp-token`,
  are removed, with their flags
  (`--listen`, `--writable`, `--allow-origin`, `--vault`, `--key-out`,
  `--revoke`). Both commands exit 2 and point at the server's `/mcp`. Start
  the server with `-mcp`, mint a token with `trewd mcp-token`, and point the
  agent at `/mcp` ([Moving from `trew mcp`](docs/agent.md#moving-from-trew-mcp)).
  The client's `trew.mjs` is about a quarter of its former size.

### Added

- **`trew search QUERY`** in the command-line client: literal search of the
  vault's notes on the server, by text, file name or tag, with `--folder`,
  `--case-sensitive`, `--context`, `--limit`, `--all` and `--json`. It uses the
  same search as the MCP tool `search_notes`. Matches are highlighted on a
  terminal, and control characters and escape sequences in note text are
  printed spelled out, never sent to the terminal. Protocol 2 gains the
  `search` request, answered for a paired device with a search budget of its
  own (`toomany` when over it) so searching cannot slow another device's sync.
  It needs a server of this release; upgrade the server first.

- **An MCP endpoint in the server** (`trewd serve -mcp`), at `/mcp` on the
  same port. Read tools for any token; exact edits, appends, creates, moves,
  deletions, restores and tag changes for a write token, each one
  all-or-nothing, previewed where it touches more than one note, and
  retryable safely with an idempotency key. Every note-derived string arrives
  under `untrusted_content`. See [Connect an agent](docs/agent.md).
- **Vault health tools for agents.** `backlinks`, `outgoing_links`,
  `broken_links` and `orphans` find links as `move_note` rewrites them (wiki
  names, paths, aliases, embeds, relative and percent-encoded Markdown links),
  report a name several notes share as ambiguous, and page through large
  vaults, reading only the notes that may link when the search index has
  caught up ([Links and vault health](docs/agent.md#links-and-vault-health)).
- **Daily-note and template tools for agents.** `today_note`,
  `append_to_daily` (optionally under a heading) and `create_from_template`,
  with Obsidian's `{{title}}`, `{{date}}` and `{{time}}` placeholders. The
  daily-note folder, format and template, the templates folder and the time
  zone are keys of the configuration file (`trewd config set daily.folder
  Journal`) and `trewd serve` flags (`-daily-folder`, `-daily-format`,
  `-daily-template`, `-templates-folder`, `-template-date-format`,
  `-template-time-format`, `-timezone`), because Obsidian's own settings live
  in `.obsidian/`, which never syncs
  ([Daily notes and templates](docs/agent.md#daily-notes-and-templates)).
- **A configuration file**, `trewd.json` in the data directory, mode 0600,
  written by `trewd config set KEY VALUE` through the running server, which
  checks the value and uses it at once. A `serve` flag wins over the file, the
  file over the default, so a unit or compose file needs none of these flags
  ([Configuration file](docs/server-reference.md#configuration-file)).
- **A Git history of the vault** (`trewd git-export set`), off by default: a
  bare repository in the data directory, one commit per agent operation and
  one per quiet run of a device's edits, dated by the server, attachments over
  10 MiB in Git LFS, pushed with a lease to a remote reached with a deploy key
  or a single-repository token. It is never read back, never delays a write,
  and refuses rather than repairs a branch changed outside it. Exported
  history is plaintext and `trewd purge` cannot remove it
  ([Keep a Git history](docs/git-export.md)).
- **The Git export can continue an existing backup branch**, such as the
  `main` the Obsidian Git plugin has been committing to: `trewd git-export
  adopt` shows the branch's tip, and `trewd git-export adopt SHA`, given that
  commit back, makes the export's first commit a child of it, so the old
  history stays beneath and the first push is a fast-forward. Nothing is
  force-pushed or rewritten, the old history is not moved to LFS, and a
  rebuild makes the same commits. Without adoption the export still refuses a
  branch it did not make
  ([Continue an existing backup branch](docs/git-export.md#continue-an-existing-backup-branch)).
- **The container image is Alpine with git, git-lfs and ssh**, for the Git
  export, instead of `scratch`; the Nix package puts the same three on the
  server's PATH, and the Homebrew formula depends on git-lfs.
- **Tokens for agents** (`trewd mcp-token`): read scope by default, 90-day
  expiry by default, listed with use counts, revocable while the server runs.
  `-key-out` writes a token only to a new file and refuses one that exists;
  a token whose file could not be written is revoked at once.
- **Audit and undo.** `trewd audit` lists every agent write and every undo;
  `trewd undo OPID` reverses one, or writes what it replaced as copies. The
  plugin's version history offers **Undo this change** on an agent's version,
  and an agent can undo its own writes. A version an agent's write displaced
  is kept at least 30 days whatever purge is asked to do.
- **Protocol 2**, which is protocol 1 with undo. The server speaks both, so a
  client of protocol 1 keeps working against an upgraded server.
- **Windows and iOS pair**, with a standing notice in the panel that Windows is
  not supported and iOS is untested, and names Windows cannot hold listed as
  needing attention instead of syncing.
- **`trewd cat` and `trewd export`** read a note or one version straight from
  the store, with nothing but the server.
