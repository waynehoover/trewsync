# Ideas unlocked by a plaintext server

Not commitments. Things that were impossible or awkward while the server could not read the notes, and are cheap or at least tractable now. Grouped by cost relative to what PLAN.md already builds. Move an idea into PLAN.md when it becomes a milestone; delete it here when it ships or is refused.

## Nearly free once M4 and M5 exist

- **Web history viewer.** (Started 2026-09-25 and parked at the owner's request before it was finished; the partial work was not kept.) Read-only pages for a note's versions and diffs, served by the same binary. Basalt refused a web UI partly because the server could not render anything.
- **`changes_since {afterUid, folder?}`.** A read tool beside the vault-health tools (`backlinks`, `outgoing_links`, `broken_links` and `orphans` shipped 2026-09-25, with the daily-note and template tools; plan/mcp-tools.md): cheap and exact on a version log, and what an agent needs to catch up without re-listing.
- **MCP resources.** `trew://note/<path>` so hosts attach a note as context without a tool call. Prompts once tools are stable.
- **Webhooks or an event stream.** The hub already broadcasts every commit. `--webhook URL` or SSE at `/events`: rebuild a site, notify, run an agent on "note changed". Two rules from the research: a subscriber that falls behind gets the missed events replayed or an explicit `lagged` with the UID to resume from, never a silent gap (PKV Sync's notifications could drop); and for agents, prefer standard MCP `notifications/resources/updated` over a custom method. No credential in the URL (NoX Sync put its key in the status stream's query string); use a header or a short-lived single-use ticket.
*(The agent audit log and undo were here. They are now M5 tasks in PLAN.md. They are not optional additions, they are the reason unattended agent writes are acceptable at all. Note that the plugin's history panel does not already provide undo: it restores without replacing, by design, `basalt:client/src/plugin/history.ts:39`.)*

## A milestone of work, high payoff

- **Publishing, as serving pinned versions.** Serve a folder or a tag as a static site from the store, or export on commit for Quartz or Hugo. Designed so Pumice's failures cannot happen (`plan/research/pumice.md`): publishing is a device-only act that records `(path, uid)` pins, which purge keeps (PLAN §4.5), so an agent edit or a half-written note never goes live by itself; the note must also carry `publish: true`; agents cannot publish; pages are served from a separate origin, or at least a path with a strict CSP and `sandbox`; Markdown HTML is sanitized, `javascript:` and `data:` link schemes refused, and no vault file is ever executed as script (Pumice ran a vault-supplied `publish.js` on its dashboard's origin and never checked its own site passwords).
- **`serve --export-dir DIR`.** One-way plaintext mirror written from head versions: no credential, no upload path, no merge, no engine. A few hundred lines, and it covers the NAS-mirror case without a second sync implementation. See PLAN §2.6.
- **Go sync engine and `serve --vault-dir`.** Cut from the plan (PLAN §2.6). Reopening needs a measured runtime, packaging or resource requirement, plus shared golden merge decisions, pinned algorithm settings, explicit UTF-16 handling, differential fuzzing, and a rule that unexplained disagreement keeps both versions. The exclusion-lock incompatibility between Go `flock` and the Node adapter's abstract socket must be solved before two implementations ever share a directory.
- **Scheduled agents on the server.** `trewd run --prompt-file` calling a model with the MCP tools against the local store on a schedule: morning summaries, inbox triage, link fixing. The server always has the notes and never sleeps.
- **Semantic search.** An embeddings table maintained beside the FTS index, on the same asynchronous worker (PLAN §2.5), not at commit. Needs a model endpoint trusted with the text.
- **Time-travel reads.** `read_note` at a timestamp; `vault_at(time)` listings. The store has everything; it is a query.
- **Attachment tools.** Image dimensions, PDF text into the search index, `read_attachment` as a resource.
- **Streaming assembly on download.** Basalt's `docs/open-work.md` first item; lifts the 64 MiB default. Independent of encryption but easier without the seal window.
- **`import-basalt`.** Replay a Basalt data directory into TrewSync given a data key exported from a paired device. History would carry over.
- **Whole-file `write_note`.** Settled as refused for v1 (PLAN §4.4). If usage shows the need, it arrives as `replace_note` with a full-read base, diff preview, audit record, pinned before-image and conditional undo, or, more likely, as a structural `replace_section` on the Markdown AST.
- **Stdio bridge.** `trew mcp-stdio --url --token-file` for hosts that cannot speak streamable HTTP.

## Borrowed from `asciimoo/hister`

A close structural sibling: one self-hosted Go binary, privacy-first, full-text index, served to web, TUI, CLI and MCP; 4,900 stars in eight months. Three of its ideas were promoted straight into PLAN.md (the untrusted-content envelope in §4.10, `doctor` in M5.5, packaging and README shape in M9). These are the rest.

- **A TUI.** `hister` ships `cmd/tui/`. Browse the vault, search, read a note's version history, see device and agent activity, all in the terminal. It is the natural companion to a headless server and it costs far less than a web UI.
- **Importers for the neighbours.** `hister` ships seven (karakeep, linkding, linkwarden, raindrop, readeck, shaarli, wallabag) and they are how people switch to it. The equivalents here: Obsidian Sync, remotely-save, a Syncthing folder, LiveSync, or a plain directory. This is the same machinery as the M10 migration, so it is nearly free once that exists, and it turns a one-time personal cutover into a way in for everyone else.
- **A demo instance.** `demo.hister.org` lets people try before installing. Harder here, since a sync server needs a vault and a device, but a read-only demo over a sample vault with the MCP endpoint exposed would show the whole idea in one link.
- **Reconsider OAuth, deliberately.** `hister` has `server/oauth/`; PLAN §2.3 refuses OAuth in favour of a static bearer behind Tailscale. That refusal still looks right for one person, but it is now a considered difference from a peer project rather than an obvious call. Revisit if the MCP endpoint is ever exposed to a host that cannot hold a static token safely. If it is reopened, use Pumice's shape: OAuth only as a consent wrapper that mints an ordinary scoped token; `peek()` the code before `consume()` so a failed PKCE check does not spend it; the dynamic-registration `client_name` and redirect URI shown on the consent page. Until then, publish no OAuth metadata at all (Syncidian advertised metadata for a flow it did not implement, and MCP clients act on it after a 401).
- **Semantic search, framed as they frame it.** Optional, off by default, and disclosed exactly: "sends document text to the embeddings endpoint you choose." That sentence is the whole privacy contract and it belongs beside the setting, not in a footnote.

## Interesting, but they push on the scope refusals

- **Share one note.** A signed read-only link. Tiny to build, and the first step toward teams. Decide on purpose. The link points at a pinned `uid`, not the live path, for the same reason publishing does; and it is the first narrower reader, so PLAN §2.2's chunk-fetch authorisation note applies before it ships.
- **Several vaults per server.** Cheap without per-vault keys; the MCP `vault` parameter is already in the tool spec. Per-token vault scope follows. Note this is also the point at which narrower readers exist, so chunk-name presence oracles and fetch authorisation need revisiting (PLAN §2.2).
- **Obsidian config sync.** Promoted to M11 on 2026-10-09, for Obsidian's own settings with one profile per device class: [settings-sync.md](settings-sync.md). It starts from the known costs this entry listed: Obsyncian's exclusions (the plugin folder, `workspace.json`, `workspace-mobile.json`) and its cursor-rewind problem (`plan/research/obsyncian.md`), and the fact that Obsidian's vault index does not list dot-folders, so a config sync built on it silently does nothing (seen in NoX Sync and PKV Sync). Community plugins wait for its phase 2.
- **Frontmatter merge by key.** Merge YAML frontmatter per top-level key, refusing anything ambiguous (LiteSync, MIT, `litesync:src/merge/markdown/frontmatter.ts`). Evaluated only behind Basalt's merge validity gates and fuzz corpus before any adoption. Token-level and list-union auto-merge are refused outright: LiteSync's invented a sentence nobody wrote and resurrected deleted list items (`plan/research/litesync.md` section 6).
- **A resolver view over conflict copies.** Built, inherited from Basalt: "Review conflicts" (`client/src/plugin/conflicts.ts`) compares a copy with its note as a line diff, keeps either, saves an edited combination, or leaves both, and never writes markers into a live note. Since 2026-10-02 the conflict notice opens it when tapped.

## Refused, with the reason written down

- **Plugin self-update.** Obsidian's plugin guidelines disallow it, and PKV Sync does it. Updates come through the community directory or a manual install.
- **Client-side error reporting or telemetry.** Forbidden by the directory's policy, and Obsyncian shipped it on by default while sending the paths its own settings text said it never sent.
- **Conflict markers in a live note.** The agent, search and any published page all read the live note. Pumice, Obsyncian and PKV Sync write `<<<<<<<` into notes, frontmatter included; TrewSync keeps both versions as files.

## First three after M5

Webhooks, backlinks and vault health, and the web history viewer. Small, compounding, and none of them were possible before. (Undo used to be on this list; it moved into M5.)
