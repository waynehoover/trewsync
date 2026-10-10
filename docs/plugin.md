# Use TrewSync in Obsidian

[Documentation](index.md) · [Server setup](server.md) · [Security and privacy](security.md)

TrewSync syncs your notes and attachments, shows sync status, and lets you recover
earlier versions from inside Obsidian. Start with a
[configured server](server.md) and Obsidian **1.7.2 or newer**.

Use a local vault on macOS, Linux, or Android. iOS is untested; Windows is not
supported. The plugin pairs on both, and says so in its panel for as long as
it runs; the [platform table](../README.md#platforms) says what that means.
Back up an existing vault before pairing, and disable other sync
services for that vault. Each device should have its own local copy.

## Install

1. Download `main.js`, `manifest.json`, and `styles.css` from the newest stable
   [plugin release](https://github.com/waynehoover/trewsync/releases).
   Plugin releases use a plain `X.Y.Z` version; skip `server/v…` and `cli/v…`.
2. Create `<vault>/.obsidian/plugins/trew-sync/` and put the three files there.
   If you use a custom Obsidian configuration folder, use that folder instead
   of `.obsidian`.
3. Reload Obsidian. Under **Settings → Community plugins**, turn community plugins on if they are
   off, then enable **TrewSync**.
4. Open the TrewSync ribbon icon and choose **Sync settings**, or run
   **TrewSync: Show status** from the command palette.

Manual installation is required while TrewSync is outside the community directory.
To upgrade, replace the same three files and reload Obsidian. When a release
changes the protocol, upgrade the server before its clients.

## Pairing

Every device joins with an invite: a single-use string starting `trew1i_` that
carries the server's address and the vault's name. The setup screen has one
field, **Invite**, and a **Pair** button.

<details>
<summary>See the setup screen</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/pairing-dark.png">
  <img src="assets/screenshots/pairing.png" alt="The setup screen: an Invite field and a Pair button." width="640">
</picture>

</details>

### Start your first device

1. Get the first invite from your server. It is in the `first-invite` file in
   the server's data directory, or `trewd invite` on the server prints a fresh
   one; [server setup](server.md#the-first-device) shows both.
2. Paste it into **Invite**. TrewSync reads it and says which server it points to,
   and which vault if it is not `default`; check that address. **Pair** becomes
   available once the invite can be read.
3. Press **Pair**, then wait for sync to finish before adding another device.

To name this device something other than the suggestion, or to skip a folder
on this device, open **More options** first.

There is no recovery key to write down. Your notes and their history live on
the server, so losing every device loses no synced note: run `trewd invite` on
the server to pair a new one.

### Add another device

1. On a paired device, open **Add another device → Create invite**.
2. On your phone, install and enable TrewSync, then scan the QR code. Or copy the
   pairing code and paste it into **Invite** on the new device.
3. Check the server (and vault) named under the field, then press **Pair**.
4. If this vault already contains files, TrewSync asks you to confirm combining
   them with your synced vault. An older copy can bring back files moved or
   deleted elsewhere. **Cancel** leaves your files and invite untouched.
5. If **Review your first sync** appears, review the counts and choose
   **Continue sync**. An empty vault, or one whose files are all already the
   server's, starts downloading immediately, and so does a first sync that was
   interrupted before it finished.
   Keep Obsidian open until it finishes. On desktop the review opens in the
   main Obsidian window, even when you paired from a separate Settings window.
   While it waits, the status bar says so; click it to bring the review back.
   Closing the review pauses sync, and nothing syncs until you choose
   **Continue sync**.

To download a fresh copy, create a new empty Obsidian vault and keep the old
vault as a backup. TrewSync does not clear or move existing files during pairing.

An invite works once and expires after one hour. If it expires, create a new
one. If no paired device remains, run `trewd invite` on the server and paste
what it prints into the same field. There is no fixed device limit.

If pairing is interrupted after the invite was sent, TrewSync keeps the pairing
and finishes it on the next attempt, even after the invite has expired. A
refused invite (unknown, already used, expired or cancelled) leaves nothing
saved. An invite or recovery key from Basalt Sync does not pair with TrewSync; the
field says so.

<details>
<summary>See the QR code and pairing code</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/invite-dark.png">
  <img src="assets/screenshots/invite.png" alt="A QR code and a compact pairing code field with a Copy button." width="640">
</picture>

</details>

### Where this device's token is kept

A paired device connects with its own random token. On Obsidian 1.11.4 and
later, TrewSync keeps that token in Obsidian's keychain (**Settings → Keychain**
lists it as `trew-<vault>-<device>`), and the plugin's `data.json` keeps only
the rest of the pairing. On an older Obsidian the token stays in `data.json`,
as it always did; TrewSync still installs there.

The keychain belongs to Obsidian on this device, not to the vault folder, so a
backup, an iCloud or git copy, or a copy of `.obsidian` does not carry the
token. A copy opened elsewhere cannot sync as this device: its panel says the
token is not in this device's keychain and shows **Pair this device again**.
Pairing it with a new invite adds it as a device of its own.

The token leaves `data.json` in two steps, because Obsidian saves its keychain
in the background and cannot say when that has finished. When a device pairs,
or a vault paired on an older Obsidian is first loaded by a newer one, TrewSync
writes the keychain and reads the token back, and `data.json` keeps the token
too. The next time Obsidian starts and the keychain still holds it, TrewSync
removes it from `data.json`. So until that restart a copy of `.obsidian` still
carries the token, and Obsidian closing or crashing before its keychain was
saved costs nothing. If the keychain does not read the token back, the token
stays in `data.json`, sync carries on, and a notice says so.

On a desktop each vault has a keychain of its own, so a vault renamed there
finds its token under the old name, keeps it under the new one and removes the
old entry. On a phone every vault shares one keychain, so a renamed vault
cannot tell its own entry from a copy's: it stops, names the entry left under
the old name and the device, and offers **Pair this device again**. After
pairing, revoke that device under **Devices** and remove the entry in
**Settings → Keychain**.

If the token cannot be found (the keychain was reset, or a renamed vault on a
phone), TrewSync stops and offers **Pair this device again**. No note is lost:
pair with a new invite, confirm combining the notes, and it syncs as a new
device. Revoke the old row under **Devices** once you no longer need it.

## What it does

TrewSync syncs shortly after edits and checks periodically while Obsidian is open.
It reconnects after a dropped connection. Press **Sync now** to sync immediately,
including retrying files after fixing a problem. Use **Reconnect** when offline
or **Resume sync** when paused.

Open the panel for the result and any files needing attention. It includes the
server address and version, useful when diagnosing a connection problem.
On desktop, the status bar shows a cloud with a check when synced. Hover for
details or click it for quick actions and settings.

During longer transfers, the panel shows which file is uploading or downloading
and how much data has moved. Keep Obsidian open until sync finishes.

The delivery line reports which other devices have received the latest changes.
If it is waiting for your phone, open Obsidian there. A disconnected device
cannot confirm new changes until it reconnects.

| Status | What to do |
|---|---|
| Unpaired | Pair this vault. |
| Paused | Choose **Resume sync** from the TrewSync menu. |
| Connecting, loading history, or syncing | Keep Obsidian open until sync finishes. |
| Synced | No outstanding work was reported. |
| Needs attention | Open the panel and follow the reason shown for each file. |
| Failed or offline | Check the connection and the reported error; TrewSync retries temporary failures. |
| Stopped | Follow the panel's instructions. Repeated attempts alone will not fix this condition. |

For a protocol mismatch, update the server and plugin to compatible releases.
After the server is restored from a backup, TrewSync catches up by itself; see
[rejoining a restored server](#rejoining-a-restored-server) for the one case
that stops. If the panel reports unreadable local state, preserve that state
and your notes before attempting recovery; deleting the plugin's files is not a
general troubleshooting step.

## Activity and quick actions

Click the TrewSync status icon or tap its ribbon icon for **Sync activity**,
**Review conflicts**, **Preview sync**, history, and settings. **Pause sync**
stops this device until you resume it or restart Obsidian.

The activity log keeps the latest 300 events on this device across restarts.
Search by filename or filter errors and conflicts. **Copy diagnostics** omits
filenames; note contents and credentials are never recorded in this log.

Before combining populated vaults, TrewSync shows upload, download, and preserved-copy
counts. Deleting an entire folder containing several synced
files also opens a review. Choose **Pause sync** if the changes are unexpected.
**Preview sync** lets you inspect planned changes at other times without writing
notes. A preview is an estimate: files are checked again when sync runs.

If a file changed outside Obsidian but did not sync, run **TrewSync: Verify
vault contents**. This reads every file again and can take longer than a normal
sync.

<details>
<summary>See activity, conflict review, and first-sync previews</summary>

- [Recent activity](assets/screenshots/activity-phone.png)
  ([dark theme](assets/screenshots/activity-phone-dark.png))
- [Compare a conflict](assets/screenshots/conflicts-phone.png)
  ([dark theme](assets/screenshots/conflicts-phone-dark.png))
- [Review first-sync changes](assets/screenshots/preview-phone.png)
  ([dark theme](assets/screenshots/preview-phone-dark.png))

These phone layouts were captured in desktop Obsidian's mobile styles.

</details>

## Version history

Run **TrewSync: Show version history** for the open note, or use the note's
right-click menu. Choose a version to read it or compare it with the local copy.
Use **Load more** to go further back. Tab or the arrow keys move between
versions. Attachments and large notes show their details without loading a text
preview; restore a copy to open the complete file.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/changes-dark.png">
  <img src="assets/screenshots/changes.png" alt="Version history showing the changes between an earlier note and its local copy." width="800">
</picture>

**Restore does not overwrite an existing file.** If the original path is
occupied, the copy appears beside it, for example `Note (restored 42).md`.
Restoring also tries to upload the copy to the server. Other devices receive
it when they next sync.

**Undo this change** appears on a version an agent wrote through the server's
[MCP endpoint](agent.md), and on one an undo wrote. Unlike Restore, it replaces: it puts
back what that operation changed, in every note it changed, as it was before,
and every device receives the result. The panel names who wrote the version:
the agent by its token's label, an undo on the server, or an undo from a
device. This device's unsent changes are sent first. If any note the operation
changed has been edited since, here or on a device that has synced the edit,
nothing is changed; the panel says which note and who edited it, and offers **Keep both: write the earlier versions as
copies**, which writes each earlier version beside its note, as
`Note (restored 42).md`, and leaves everything else alone. An undo can itself
be undone. A version already undone shows no undo button.

History remains available until the server operator
[purges it](server-operations.md#purge). An agent's version keeps the note's
earlier version for at least 30 days, whatever purge is asked to do; after
that, undoing it may be refused because the earlier version is gone.

## Deleted notes

Press **Browse deleted**, select the note, and restore it. A note whose
content has been purged is listed without a restore button.
Use **Show older** to browse further back and **Newest** to return. If the
connection fails, choose **Try again** after reconnecting.

<details>
<summary>See deleted notes</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/deleted-dark.png">
  <img src="assets/screenshots/deleted.png" alt="Deleted notes with individual Restore buttons." width="640">
</picture>

</details>

A deletion received from another device goes to the system trash, or the
vault's `.trash` if necessary. If you edit a note while another device deletes
it, TrewSync keeps the edit and sends it back as a new version.

Deleting or renaming a folder removes it from your other devices too, once
nothing is left in it there. The notes that were in it go to the trash on the
other devices, as any deletion does; the emptied folder is removed, not
trashed. A folder that still
holds something on another device stays, and comes back on the device where
you deleted it: a note written there while it was offline, a note edited
there, or a file TrewSync never syncs, such as a name starting with a dot. The
`.DS_Store` the macOS Finder leaves in folders it has opened does not keep a
folder: it is removed with the folder when nothing else is inside.
Deleted folders are not listed under **Browse deleted**; the notes that were
in them are.

Folders deleted with an earlier version of TrewSync may still be on your
other devices. The device a folder was deleted on removes it from the others
on its first sync with this version, as long as that device still has its
sync record of the folder. If an old folder stays, delete it again.

## Conflicts

TrewSync tries to combine edits made on different devices. If its merge checks
fail, it keeps both versions, for example:

```text
Meeting notes.md
Meeting notes (Conflicted copy laptop 202608311412).md
```

The name in the copy says whose words are in it: here, the version the laptop
wrote, kept beside the one you have. A copy of an agent's edit carries the
name its access token was given, such as `Claude on Mac`. A copy with this
device's own name holds something that was on this device, such as an edit
saved while a newer version was arriving. Characters a file name cannot hold
are replaced, and a long name is shortened.

Choose **Review conflicts** from the TrewSync menu. Compare the original and
preserved copy, then keep either one or edit a combined version. **Decide later**
leaves both files in place. If a file changes while you review it, refresh the
comparison before choosing. The result syncs to your other devices.

Attachments and large notes can be opened separately for comparison. You can
also combine files manually and delete the extra copy. Usually the incoming
version gets the conflict name; an edit made during replacement can instead be
preserved there.

Successful merges and ordinary downloads can update the original note. Keeping
both versions on a conflict is not a promise that sync never changes an open file.

## Settings sync

Off until you turn it on, on each device: **Manage this vault**, **Sync
settings**, **Turn on**. It syncs Obsidian's own settings, themes and CSS
snippets from the settings folder this device runs, with every device that
runs a folder of the same name. Plugins, their settings and the workspace
layout do not sync. It needs a server from this release on, which speaks
protocol 3; upgrade the server first.

**Keeping a phone's settings apart.** Devices share settings by folder, and
desktops usually all run `.obsidian`. To give a phone its own, run **Create a
settings profile for this device** on it (also under **Manage this vault**,
**Settings profile**). That copies the phone's settings folder, plugins
included, to `.obsidian-mobile` or a name you choose. Then open Obsidian's
**Settings**, **Files and links**, **Override config folder**, enter
`.obsidian-mobile` and tap **Relaunch**. Do this before turning settings sync
on, so the phone joins the phone settings rather than the desktops'. Another
phone that does the same shares them.

**The first time.** When you turn it on, TrewSync asks which settings to use
where the server already has some for this folder from another device and this
device's differ: the server's, or this device's. Either way it first keeps a
copy of this device's settings as they were, in a `settings-before-sync-` folder
inside the plugin's own folder, and says where.

**Applying a change.** Obsidian reads its settings when it starts and holds
them in memory, so a setting changed on another device waits until you apply
it. TrewSync says how many are waiting. Tap the notice, or run **Apply synced
settings and reload**: it saves open notes, writes the settings and reloads
Obsidian. If Obsidian writes its old setting back as it reloads, TrewSync
notices and offers the change again, rather than sending the old value to your
other devices.

The server keeps every version of a setting, as it does for a note. Agents
connected over MCP never see settings, and the Git export leaves them out.

## What is not synced

- Obsidian's configuration folder, unless settings sync is on; with it on, its
  plugins, their settings and the workspace layout still do not sync.
- Files or folders whose names start with a dot, at any depth, including
  `.git`, `.trash`, and `.trew`. An `.attachments` folder is one of these, so
  attachments kept there stay on the device that has them.
- Files above the server's limit, **64 MiB by default**. The server operator
  can [adjust the limit](server-reference.md#serve).
- Paths the server refuses because Obsidian could not hold them everywhere:
  longer than 1,024 bytes, a file or folder name longer than 255 bytes, control
  characters, backslashes, and a few more. A no-break space in a name is not
  one of them: Obsidian reads it as an ordinary space, and so does TrewSync, so
  the note syncs under that name and the file keeps its own.
- A path that differs from another synced path only in letter case, such as
  `Notes/a.md` beside `notes/a.md`, because a case-insensitive disk would hold
  them as one.

The panel lists each refused path with its reason, and the file stays on this
device. Rename it and press **Sync now**. Other notes and attachments are
included. Large attachments need more memory, particularly on phones.

## Phones

Android sync runs while Obsidian is **open in the foreground**. There is no
background service or push notification to wake it. Turning the screen off
pauses Obsidian and drops its connection within seconds, so while a sync runs
for more than a couple of seconds TrewSync keeps the screen on, and lets it
sleep again when the sync finishes. Switching to another app or pressing the
power button still pauses it; an interrupted sync carries on where it stopped
when Obsidian is open again. Let changes finish before closing the app.

iOS has not been tested. If a first connection is rejected because of its
browser origin, the panel shows an origin hint for the server operator; see
[server connection troubleshooting](server.md#connection-troubleshooting).

## Change the server address

Open **Server → Server address**, enter the new address, and press **Save**.
TrewSync checks the connection using this device's existing pairing before saving.
Use this when the same server moves to a new hostname or port. Notes and sync
history are kept. Update the address on each device.

<details>
<summary>See server settings</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/server-dark.png">
  <img src="assets/screenshots/server.png" alt="Server connection details above the editable server address." width="640">
</picture>

</details>

## Devices, and revoking one

Under **Manage this vault**:

- **This device's name → Rename** changes the label used for future activity.
  Existing history and conflict filenames retain their old labels.
- **Devices → Show devices** lists paired devices and outstanding invites.
- **Revoke** stops a device syncing; **Cancel** invalidates an unused invite.

When names match, the list shows device IDs to help you tell them apart.
Rows marked **Never connected** may be left by an interrupted pairing. The
server's host can do the same with `trewd devices`, `trewd revoke` and
`trewd uninvite`; see the
[server reference](server-reference.md#invite-devices-revoke-uninvite).

<details>
<summary>See the device list</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/devices-dark.png">
  <img src="assets/screenshots/devices.png" alt="Two registered devices with last-seen times and access controls." width="640">
</picture>

</details>

Revoking a device stops it receiving and sending changes at once, and cancels
any invites it created. It cannot erase notes already on that device: they stay
readable there. See
[what to do after losing a device](security.md#if-a-device-is-lost-or-stolen).
You can revoke any device, including this one and the last one; `trewd invite`
on the server pairs a device again afterwards.

On the revoked device, the panel says it was revoked and shows **Pair this
device again** with an Invite field in place of its usual controls. Its notes
stay where they are, on that device and on the server. Paste or scan a new
invite and press **Pair**: TrewSync asks before combining the vault's notes, then
replaces the old pairing and sync index, as unlinking would, and syncs as a new
device under the same name, still skipping what it skipped.

<details>
<summary>Recovery and server maintenance</summary>

## Rejoining a restored server

When the operator restores the server from a `trewd backup` snapshot, the
server starts a new history, and this device notices at its next connection.
It then reads the restored history as a fresh listing, with nothing to press:
files that match agree, files that differ are kept both ways as a conflict
copy, files only this device holds are sent back, and nothing is deleted
because the restored history lacks it. A note deleted after that backup was
taken can come back; delete it again if you still want it gone.

The one case that stops is a server data directory copied back by hand rather
than restored from a backup. The panel then shows **Stopped** and offers
**Rejoin this server**. First have the operator back up the server and
preserve local notes. Press **Rejoin this server**, review the two positions
shown, then confirm. TrewSync rejoins and sends versions held only on this device,
keeping both copies where they disagree. Prefer this action to unlinking and
pairing again.

After either, the next edit made on two devices at once keeps both versions
instead of merging them, because the last version the devices agreed on is
gone.

## Sending back what the server has lost

If the operator confirms that the server is missing stored content, choose
**Manage this vault → Send back what the server has lost** on a device that
still has the notes. TrewSync resends missing content without creating new note
versions.

Repeat on other devices that may have additional copies. The operator should
then run `trewd verify`; a successful repair on one device cannot establish
that all server history is recoverable.

## Durability

TrewSync writes a new file or a changed attachment beside its destination,
checks the written bytes, and only then puts it in place. An incoming edit to a
note is written into the note itself, so an open editor keeps showing it: what
the note held is first copied beside it as a conflict copy and checked, and
once the new text has been read back the copy goes if the server already has
what it holds. If that write is cut short, by a full disk for example, TrewSync
puts back what the note held and fetches the edit again; a note it cannot put
back yet is not sent anywhere until it can. Desktop and mobile provide
different guarantees during a power loss; keep independent backups of your
notes.

If the panel says **versions were kept somewhere Obsidian does not show**, keep
the named files and the plugin's state folder. The notice gives their retained
locations. Copy a retained version to a new visible note and check it before
removing any recovery material. Do not clear hidden files as a general cleanup.
The [technical design](design.md#file-replacement) explains these paths.

</details>

## Unlink

**Manage this vault → Unlink this vault** stops syncing here and removes the
local pairing, its token in Obsidian's keychain and the sync index. Your notes
remain on this device and the server.
Pair again to resume. Unlinking locally does not revoke the server's device
record; use **Devices** when you want to remove access.

## Commands

| Command-palette action | Result |
|---|---|
| TrewSync: Sync now | Run a sync. |
| TrewSync: Verify vault contents | Re-read every file, then sync. |
| TrewSync: Preview sync | Review planned changes without writing notes. |
| TrewSync: Show sync activity | Search recent activity. |
| TrewSync: Review conflicts | Compare and resolve preserved copies. |
| TrewSync: Pause or resume sync | Stop or restart syncing on this device. |
| TrewSync: Show status | Open the panel. |
| TrewSync: Show version history | View history for the open note. |
| TrewSync: Recover a deleted note | Browse deleted notes. |
