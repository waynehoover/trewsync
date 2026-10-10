# Settings sync, one profile per device class (M11)

Drafted 2026-10-09 against commit `38c7604`; line references are at that commit. Nothing here is built yet.

**Decided by the owner, 2026-10-09.** Reverse the refusal for Obsidian's own settings, and sync community plugins later (§6, phase 2). Phones share their settings with phones and desktops with desktops: one profile per device class, through Obsidian's own override, which is (a) in §2. A change arriving for the profile a device runs waits for Apply and reload (§4); applying the files Obsidian already reloads live on desktops is deferred. The remaining questions in §8 have defaults and do not block the MVP.

**Summary.** Sync Obsidian's configuration folders as versioned data. Each device class runs its own folder, chosen with Obsidian's own per-device "Override config folder": `.obsidian` on the desktops, `.obsidian-mobile` on the phone. A device uploads only the folder it runs and receives all of them. A change to the folder it runs lands only through an explicit "Apply and reload". The MVP covers Obsidian's own settings, hotkeys, core plugins, snippets and themes; community plugins (code and settings together) are a second phase behind per-change confirmation. Agents never see any of it.

## 0. What this reverses, and where each reason is answered

On record:

- PLAN.md:68: "Carried from Basalt unchanged: ... no Obsidian configuration sync". PLAN.md:324 refuses every dot segment, and PLAN.md:415 calls that "correct and deliberate (it covers `.obsidian`, `.trash`, `.trew`)".
- docs/design.md:404-407: "Obsidian configuration sync is also absent: settings and workspace files have different ownership and failure consequences from notes, and the configuration folder contains device credentials."
- plan/ideas.md:41: "Still refused ... If ever revisited, start from the known costs: Obsyncian's exclusions (the plugin folder, `workspace.json`, `workspace-mobile.json`) and its cursor-rewind problem (`plan/research/obsyncian.md`), and the fact that Obsidian's vault index does not list dot-folders, so a config sync built on it silently does nothing (seen in NoX Sync and PKV Sync)."
- plan/research/basalt-lessons.md:83: "Config sync is refused because Obsidian holds config in memory and writes it back, silently undoing a remote change."
- Users are told so in docs/compared.md:73-74, README.md:120 and docs/plugin.md:317-321.

| Reason on record | Answered by |
|---|---|
| Different ownership and failure consequences | A device uploads only the folder Obsidian runs from on it (§2); config work never holds up notes (§7) |
| The folder contains device credentials | TrewSync's own plugin folder never syncs, refused by the server and both clients (§1) |
| The running app writes stale settings back | Held apply, reload, then confirmation after the reload (§4) |
| The vault index omits dot folders (nox-sync.md:51, pkv-sync.md:107, pumice.md:69) | An adapter walk (§3) |
| Cursor rewind when a filter lifts (obsyncian.md:66) | Not needed: the engine keeps the server's newest word for every path (engine.ts:916-917) |
| Workspace files | Never synced (§1) |
| An agent planting plugin code (threat-model.md:97, A4; syncidian.md:83) | MCP never sees a config path (§7); plugin code is phase 2 and opt-in (§6) |

## 1. What syncs, and what never does

A *profile root* is a top-level folder named `.obsidian` or `.obsidian-<name>`, where `<name>` is 1 to 32 lowercase letters, digits and dashes. Obsidian requires a config folder name to start with a dot ("starting with a period", Configuration folder help), so a fixed pattern keeps `.git`, `.trash`, `.trew` and `.attachments` out without a denylist. A device whose config folder has another name is told why settings sync is unavailable (rule 7).

| Category (Obsidian Sync's names) | Files under each root | Phase |
|---|---|---|
| Main settings | `app.json` | MVP |
| Appearance | `appearance.json` | MVP |
| Themes and snippets | `themes/<name>/*`, `snippets/*.css` | MVP |
| Hotkeys | `hotkeys.json` | MVP |
| Core plugin list and settings | `core-plugins.json`, `<core id>.json` (daily-notes, templates, graph, bookmarks, ...), `types.json` | MVP |
| Community plugin list, installed plugins, their settings | `community-plugins.json` and `plugins/<id>/**`, moved as one unit | Phase 2 (§6) |

Never synced, refused by the server and by both clients (two checks, the argument PLAN.md:324 makes for dot segments):

| Path | Why |
|---|---|
| `workspace.json`, `workspace-mobile.json` | One device's open panes, rewritten on every layout change. Obsyncian and LiteSync exclude them (obsyncian.md:36, litesync.md:65); syncing them only manufactures conflicts. |
| `plugins/trew-sync/**`, and whatever `manifest.dir` the plugin runs from (main.ts:1535-1541) | `data.json` is this device's pairing: server, vault, deviceId, and the token itself on Obsidian before 1.11.4, or until the first restart after pairing on later ones (pairing.ts:98-127, keychain.ts:1-45, docs/plugin.md:120-128). `index.json`, `activity.json`, `displaced.log` and `pass-timings.ndjson` are this device's sync state (main.ts:646, :1389, :1555, :1570). A copy on another device impersonates this one (threat-model.md:87, C7), the hazard paths.ts:353-360 already names. Its code: §6. |
| Dot-named segments inside a root, and `.trew-tmp-` staging names | Unchanged rules (paths.go:108-115) |
| Every other top-level dot folder | Unchanged |
| Until phase 2: `community-plugins.json`, `plugins/**` | Code, and the switch that runs code. The Mac's folder has obsidian-git and Local REST API enabled and LiveSync installed (plan/cutover.md:27-35). |

Caches need no rule: Obsidian keeps its metadata cache and File recovery snapshots in app storage (IndexedDB `<vault id>-cache` and `-backup` in 1.14.4), not in the folder. Caches that plugins write into their own folders are phase 2's problem: a per-file size cap and a per-plugin exclusion.

Three gates on every config file. A `.json` file is uploaded or applied only if it parses: Obsidian 1.14.4 writes config in place as two-space `JSON.stringify`, a file that fails to parse reads as nothing (main.ts:2055-2058 relies on the same distinction), and the app re-saves its config about a second after every start, so a torn read that became a version could put defaults over a profile's settings on every device (rules 2 and 4). A JSON change counts only when the parsed value differs, so a start that re-serializes is not a version and the confirmation in §4 compares values, not bytes. And an edit uploads only after 10 s unchanged (§3). Scale: the owner's `.obsidian` has 289 entries (plan/cutover.md:48), most of them under `plugins/`; the MVP set is a few dozen files.

## 2. Mobile versus desktop

How others do it:

- **Obsidian Sync** offers one switch per category, set on each device ("Sync settings do not sync across devices"). Some settings hot-reload; the rest wait for a reload or restart, a force-quit on mobile. JSON conflicts are merged by applying "keys from the local JSON on top of the remote JSON". Separate config folders sync side by side as "settings profiles", and the help's example is `.obsidian-mobile`.
- **LiveSync** has two features that must not manage the same files. Hidden File Sync moves dot files chosen by regex target and ignore patterns, set up per device with Merge, Fetch or Overwrite, and asks for a restart. Customisation Sync needs a device name unique across devices; each device stores its own copy of every item (settings, snippets, themes, plugins with code), and a dialog applies, item by item, the copy you pick, or the newest for items you flag. It can scan before each replication or every minute, and keeps LiveSync's own settings out by default.

| | (a) A folder per device class, every folder synced as data | (b) Per-category rules on each device, one shared folder | (c) Named profiles in TrewSync, mapped onto each device's folder |
|---|---|---|---|
| How the phone differs | It runs `.obsidian-mobile`, the Mac runs `.obsidian`; nothing is merged across classes | It stops syncing a category and keeps a copy nobody else has | Its `.obsidian` maps to a server profile `mobile` |
| Where the choice lives | Obsidian's override, kept per device in the app's localStorage under `<vault id>-config` (read out of 1.14.4), never in the vault | TrewSync's per-device config | TrewSync's per-device config |
| The phone's settings backed up with history | Yes | Not for opted-out categories | Yes |
| Engine and server | A path carve-out; the path on disk is the path on the server | The same, plus filters (a per-device ignore list exists: pairing.ts:128-140, main.ts:1764) | The carve-out plus a translation layer; every path rule and fixture gets two spellings |
| Switching | Change the override and relaunch; nothing is deleted | Re-enabling a category needs a merge | Rewrites the running folder in place, or reads as deleting a whole profile (rules 3 and 6) |
| Cost | Settings meant for every device are set once per profile; other profiles take disk space | Cannot say "both synced, different values"; `app.json` mixes shared and per-device keys | The most code and the most risk |
| Precedent | Obsidian Sync settings profiles | Obsidian Sync switches; LiveSync Hidden File Sync | LiveSync Customisation Sync |

**Recommend (a), with the folder name as the profile name**, which is (c) without the mapping layer. Obsidian already isolates the folders and already keeps the choice per device, so TrewSync syncs files whose path is the same on disk and on the server, through its one engine (PLAN.md §2.6). (b) survives only as the existing ignore list, for emergencies. Obsidian's help describes the same arrangement: "Obsidian Sync can sync multiple configuration folders to the same remote vault, allowing you to create separate profiles (e.g., one for mobile, another for your laptop)."

What makes (a) safe:

- **A device syncs only the root it runs** (decided while building, 2026-10-10, replacing receive-only copies of the others). Every other root is out of scope there, in both directions, and the engine keeps the server's newest word for those paths without writing them, so a device that later runs another root decides from what it already knows. That covers the phone's leftover `.obsidian` without a conflict over it, and a phone whose override was lost with its app data runs `.obsidian` again, joins the desktop profile, and is asked first (§4) before anything uploads. The server holds every root with its history, which is the backup the receive-only copies were for.
- **A root no device runs is never uploaded.** It is reported, not synced.
- **Switching a device carries TrewSync with it.** Its pairing and index live in the running root, and Obsidian's help warns that a new profile needs sync set up again. The command "Create a settings profile for this device" pauses sync, copies the running root, TrewSync's folder included, to `.obsidian-<name>`, verifies the copy, and asks the person to set Settings → Files and links → Override config folder and relaunch (on Android, copying a dot folder otherwise needs a file manager that shows hidden files). After the relaunch it removes `index.json` from the old copy, so that folder can never resume from a stale index; the verified copy exists first (rule 3).
- **Within a class**, a device that needs its own settings (a Linux desktop's fonts) gets another root, `.obsidian-linux`.

## 3. Detecting config edits

Obsidian's index (`getAllLoadedFiles`, vault.ts:666-723) leaves config files out, and the vault events the plugin listens to (main.ts:579-641) do not fire for them (pumice.md:69). So `ObsidianVault.list` gains a second source: a walk of each profile root with `adapter.list` and `adapter.stat`, handing FileStats to the same engine, which decides by content as it does for notes ("a missed event costs latency and never correctness", main.ts:579-582).

- **Desktop:** at plugin load, on Sync now, and on every periodic pass (30 s, client.ts:665; design.md:315).
- **Android:** the same while Obsidian is open, which is the only time it syncs (docs/compared.md:71-72), plus on resume (visible or online, resume.ts:2-14). The MVP walk is a few dozen stats; time it on the Pixel before fixing the cadence (rule 8). Phase 2's plugin folders may need a slower full walk there.
- **Quiet period:** 10 s without change before an upload, through the existing deferred-upload deadline (design.md:306-314). Obsidian saves its own config about a second after a change, and plugin settings tabs often save on every keystroke; history should not keep each one.
- **Later, desktop only:** Obsidian's undocumented vault `raw` event, which its own hotkey, property and plugin managers use in 1.14.4, as a nudge and never as the record.

## 4. Applying an incoming change

- **Running root, hold:** the adapter stores the bytes in TrewSync's own folder (device-local), verified, and reports `held`; the engine keeps the path pending with its base unchanged. A local edit to a held path waits too, since finishing it means writing a merge into place. The panel and one notice say "N settings from <device> wait for a reload" (rule 7).
- **Apply and reload:**
  1. Save open editors with `TextFileView.save()`. `requestSave` waits 2 s (obsidian.d.ts:7054-7059, :7077-7081), and a reload must not drop the last words typed.
  2. One engine pass in apply mode merges each held file with any local edit against the base, writes it in place, reads it back and parses it (rule 4). The index marks it applied-unconfirmed and keeps the previous base.
  3. `window.location.reload()`, which is all Obsidian's own "Reload app without saving" command does in 1.14.4.
- **Confirm after the reload.** If the disk holds the applied value (parsed, for JSON, since the app re-saves at start), the base advances. Otherwise the app wrote back during unload, and the engine merges against the previous base: stale values equal that base, so the incoming values win, real edits merge, and a key changed two ways keeps both (§5). This is the answer to basalt-lessons.md:83, and its test must fail without the confirmation step (rule 9).
- **First enable on a device:** snapshot the running root into TrewSync's folder and verify it (rule 3). The running root uploads when the server has none, and otherwise asks once ("Use <device>'s settings, or this device's?"), like joining a populated vault (design.md:398).
- **Why no hot reload in the MVP.** Obsidian 1.14.4's desktop watcher already reloads `app.json`, `appearance.json`, `hotkeys.json`, `types.json` and enabled core plugins' files, and calls `onExternalSettingsChange` (obsidian.d.ts:5075-5085, since 1.5.7) when a plugin's `data.json` is newer than its last save. It reloads no plugin list, no CSS and no plugin without that hook, and Android is unverified. Obsidian Sync's help says as much: "Reload or restart the app to apply the synced settings. On mobile or tablet, a force-quit may be required." Applying the reloadable files at once on desktops is a later optimization.

## 5. Conflicts

- **Merge with the engine's merge, unchanged:** three-way against the last reconciled content (design.md:44-47), with the JSON validity check it already runs for `.json` (merge.ts:121-129, chunk.ts:566-588). Obsidian writes one key per line, so for flat settings a line merge is a key merge; one that leaves invalid JSON (two keys added at the end of one object) is refused by that check and keeps both.
- **Keep both** when one key changed two ways: a conflict copy beside the file (merge.ts:1138), uploaded and listed in Review conflicts (conflicts.ts). Obsidian reads fixed names, so the copy is inert; a copied snippet shows as one more snippet, disabled.
- **Not Obsidian Sync's rule.** Applying local keys over remote ones drops the other value without a trace (rule 5).
- **Last writer, with history,** only for vendor files in phase 2 (`main.js`, theme files): they can be fetched again from the directory, the older version stays in history, and no conflict copy of code is written.
- **The durability rules:** 1 unchanged. 2: an unreadable root or a failed walk stops config reconciliation, and never reads as an empty profile. 3: the first-enable snapshot; displaced local bytes become a copy or a version before any overwrite. 4: read back and parse. 5: the merge's existing checks. 6: removing a snippet is a deletion entry within its root. 7: status counts config apart from notes: synced, held, refused. 8: measure the walk. 9: every fix lands with a test that failed first. 10: assert that setting values survived, not that two devices agree. 11: restore a profile from history in the rehearsal.

## 6. Plugin code, and the sync plugin itself

- **TrewSync never syncs itself**, code or data (§1). Syncing its `main.js` would be a self-update through the vault, which is refused (PLAN.md:70, design.md:402-416), and a broken build would reach every device and stop the sync that could repair it. LiveSync keeps its own settings out of Customisation Sync for the same reason: "An automatically propagated transport, database, or exclusion setting can disable the mechanism needed to reverse it." An incoming `community-plugins.json` never drops `trew-sync`.
- **Phase 2 moves a plugin as one unit**: `plugins/<id>/**` with its entry in `community-plugins.json`, as LiveSync's Customisation Sync keeps a plugin's code and settings together. Settings then always arrive with the code that wrote them, so a `data.json` from 0.5.68 never lands under 0.5.67.
- **Code execution is new.** Today no device can make another run code (basalt-lessons.md:81, threat-model.md:97). Phase 2 creates that path between paired devices in one profile, so it is off by default on each receiving device; every code change or newly enabled plugin is shown with id, version and author device, and waits for a tap; none can come from MCP (§7).
- **Compatibility:** hold, with its reason, a plugin whose manifest says `isDesktopOnly` on Android, or whose `minAppVersion` is newer than the app (obsidian.d.ts:5120-5140, `requireApiVersion` at :5494). With a root per class, desktop-only plugins do not reach the phone's running root anyway.
- **Denylist:** sync and remote-control plugins are never moved or enabled by sync (trew-sync, obsidian-git, obsidian-local-rest-api, obsidian-livesync, remotely-save, basalt-sync, supersync). Their data holds credentials and device identity, and enabling one elsewhere adds the second writer PLAN.md:68 refuses.
- **Other plugins' secrets** in `data.json` would sit in plaintext on the server and in its backups (syncidian.md:66). That is inside the threat model (the server is trusted, design.md:446), but it must be said beside the switch. Plugins that use Obsidian's keychain (1.11.4 and later) keep secrets out of the folder.
- Code for roots a device does not run stays on the server, counted as ignored on that device (engine.ts:5570-5581), so the phone does not store desktop plugins.

## 7. Server, protocol and MCP

- **Path policy.** `paths.Check` (paths.go:66-118) stays the notes rule, unchanged for MCP. A new `CheckConfig` accepts a profile root, alone or followed by a path the notes rule accepts, and refuses the never-synced list with a new reason, `devicelocal`. `scripts/protocol-vectors.py` (:196-197, :239) and `protocol-fixtures.json` (:836-840, :1440-1445) gain a config section; the `.obsidian/x.md` policy vector stays unsearchable, unreadable and uneditable.
- **Protocol 3** is protocol 2 plus config paths. The server already answers each session in its own version (docs/protocol.md:22-30). Only sessions on 3 may put or receive config paths. Older sessions get those entries covered without payload, the way a device's own write already comes back (engine.ts:962-964), so an old client never lists them as refused, and its puts of them still get `badpath`. The server upgrades first, as now (docs/protocol.md:127-130).
- **Store:** no schema change. Versions, chunks, verify, backup and purge treat config paths as files. A noisy plugin's `data.json` may later want its own retention.
- **History:** yes. `trewd history`, `cat` and `export` (docs/server-reference.md:23-26) see config versions, and a device restores a setting by uploading an old version (docs/protocol.md:380-382). A settings view in the plugin's history panel comes later.
- **Undo:** no agent can write a config path, so no agent operation needs undoing there. `trewd restore -to-uid` is one undoable operation over every path (docs/server-reference.md:41, :428), so it would roll settings back with notes, and its undo would return them, unless told otherwise (open question 5).
- **MCP sees nothing.** A pure `paths.Config` makes `mcpText` false (paths.go:321-327), so search, read and edit exclude config, and every listing (notes, links, tags, orphans) skips it. Create and move keep the notes rule, so A4's create-then-move into `.obsidian/plugins/x/main.js` stays refused. The reasons: code (A4), other plugins' keys reaching a model provider (docs/compared.md:64-67), and tools that are about notes.
- **Git export** skips config paths, keeping docs/git-export.md:59.
- **Clients:** `isNeverSynced` (paths.ts:31-37) and `refusedInboundPath` (engine.ts:6023-6039) take the config predicate. A device with settings sync off counts config paths as ignored. The headless client is unchanged in the MVP (`--config-dir`, docs/cli-reference.md:44).
- **Isolation from notes:** a held, refused or failing config path never stops a pass for notes, and its counts are reported apart, so a settings fault cannot cost a note.
- **Platforms:** macOS, Linux and Android only; Windows is unsupported and iOS untested (PLAN.md:72).

## 8. MVP, deferred, open questions

**MVP**, one milestone:

0. Spike on the Pixel first: the override on Android, `window.location.reload()`, whether config writes raise `raw` there, and the walk's time.
1. Server: `CheckConfig`, fixtures and transcripts, protocol 3, the MCP, search and git-export exclusions, counts in `doctor`.
2. Engine: the config predicate, the per-path sending gate, the `held` outcome, applied-unconfirmed in the index, the JSON gate, the quiet period.
3. Plugin: "Sync settings" per device, off by default; the walk; held apply with Apply and reload; the first-enable snapshot; "Create a settings profile for this device".
4. Tests that fail first: a stale write-back over an applied change; typing just before Apply; a torn `app.json` never uploads; the server refuses `plugins/trew-sync/data.json`; MCP cannot list, read or move into a config path; a protocol 2 client never sees one.
5. Acceptance on the Mac and the Pixel: a theme and a hotkey changed on the Mac reach a second desktop vault after Apply; the phone's profile backs up and restores from history.
6. Docs: PLAN.md:68 and §4.1, ideas.md:41, design.md:404-407, compared.md:73-74, README.md:120, plugin.md:317-321, and a threat-model row.

**Deferred:** community plugins (§6); immediate apply of the hot-reloadable files on desktops; a settings view in history; files meant to match in every root (`bookmarks.json`, `types.json`) copied across roots; the server reading Daily notes and Templates settings from a chosen root instead of flags (plan/mcp-tools.md:213); a settings mirror in the headless client; category switches in the panel.

**Answered by the owner, 2026-10-09:**

1. Reverse the refusal for Obsidian's own settings: yes. Plugins: later, as phase 2.
2. Profiles: phones with phones, desktops with desktops, so `.obsidian` on the desktops and `.obsidian-mobile` on the phones. The `.obsidian-<name>` rule stands, which leaves room for another class later.
6. A reload prompt: yes, for every setting. Live apply on desktops is deferred.

**Still open, each with the default the MVP builds unless the owner says otherwise:**

3. Should every device carry every root (a backup on each), or only its own? Decided while building, 2026-10-10: only its own (§2). Receive-only copies would have met the phone's leftover `.obsidian` as a conflict on every first enable, and the server already keeps every root with history.
4. Bookmarks and property types: per profile, or the same everywhere? Default: per profile; copying across roots is deferred.
5. Should `trewd restore -to-uid` roll settings back along with notes? Default: yes, as one undoable operation, which is what it does to every path today.
7. The denylist, including obsidian-git and Local REST API on the Mac. Default: as listed in §6. It matters from phase 2, when plugins move.
8. In phase 2, accept other plugins' API keys in plaintext on the server and in its backups? Asked again before phase 2.

## Spike results, 2026-10-09 (MVP step 0)

On the owner's Pixel 9a, Obsidian 1.14.4 for Android, TrewSync 0.12.1, battery saver on, through the WebView's DevTools:

- **The override exists on Android**, in Files and links: "Override config folder. Use a different config folder than the default one. Must start with a dot." Its Relaunch button stores the folder under `<appId>-config` in localStorage, where `appId` is the vault's path on Android (`/storage/emulated/0/Documents/PKB`), and in Capacitor's native preferences under the same key, then calls `window.location.reload()`. The plugin should send the person to that setting rather than write either store itself: it cannot reach the native half through a public API.
- **`window.location.reload()` works on Android.** After saving the one open editor, the layout was ready and TrewSync loaded 2.3 s after the call, and TrewSync went straight back to connecting.
- **Writes into the config folder raise `raw` on Android.** A file written and removed through the adapter raised `raw` within 20 ms of each. Obsidian's own hotkey manager listens for `raw` on `hotkeys.json` and reloads hotkeys from it, on Android as well, so hotkeys are a candidate for the deferred live apply.
- **The walk is cheap.** The phone's `.obsidian` holds 19 files: listing took 55 ms and stat on all of them 63 ms. Five are in the MVP's scope (`app.json`, `appearance.json`, `core-plugins.json`, and a theme's `manifest.json` and `theme.css`); `workspace-mobile.json` never syncs and `community-plugins.json` is phase 2.
- **A backgrounded Obsidian answers nothing.** With another app in front, even a trivial evaluation never returned: Android pauses the WebView. Nothing new for the design, since the plugin syncs only while Obsidian is open (docs/compared.md), but a spike or test on the phone has to keep Obsidian in front.

## Sources

Repository facts cite paths and lines at `38c7604`; `obsidian.d.ts` is the `obsidian` 1.13.1 package in `client/node_modules`. External:

- Obsidian Help, Configuration folder: https://obsidian.md/help/configuration-folder ("type the name of your profile, starting with a period"; "Relaunch Obsidian"; settings "will not transfer").
- Obsidian Help, Sync settings and selective syncing: https://obsidian.md/help/sync/settings (categories, "Sync settings do not sync across devices", reloading of settings, settings profiles).
- Obsidian Help, Troubleshoot Obsidian Sync: https://obsidian.md/help/sync/troubleshoot (JSON conflicts; restart to see settings and plugin updates).
- The help's sources, read 2026-10-09: https://github.com/obsidianmd/obsidian-help
- Plugin API: https://docs.obsidian.md/Reference/TypeScript+API/Plugin/onExternalSettingsChange
- Obsidian 1.14.4 desktop, behaviour read out of the installed app on 2026-10-09, as keychain.ts:12-45 did for 1.13.7: override storage, config-dir validation, raw-event reloads, JSON writes, the reload command, cache locations. Each needs re-checking on Android.
- LiveSync, behaviour only, no code read (AGENTS.md): settings https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md (sections 6 and 7); Hidden File Sync https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tips/hidden-file-sync.md; its own settings kept out https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/troubleshooting.md; the per-device newest flag and conflicts by modified time https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/releases/legacy.md (0.23.18, 0.19.20); a user's guide to Customisation Sync's per-device copies and dialog https://github.com/vrtmrz/obsidian-livesync/discussions/394
