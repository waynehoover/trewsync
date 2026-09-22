# Ideas unlocked by a plaintext server

Not commitments. Things that were impossible or awkward while the server could not read the notes, and are cheap or at least tractable now. Grouped by cost relative to what PLAN.md already builds. Move an idea into PLAN.md when it becomes a milestone; delete it here when it ships or is refused.

## Nearly free once M4 and M5 exist

- **Web history viewer.** Read-only pages for a note's versions and diffs, served by the same binary. Basalt refused a web UI partly because the server could not render anything.
- **Daily-note and template tools.** `today_note`, `append_to_daily`, `create_from_template` on top of `create_note` and `append_note`. The tools agents reach for most.
- **Backlinks and vault health.** The move tool needs a link index anyway. Expose it: `backlinks(path)`, `orphans`, `broken_links`.
- **MCP resources.** `telimus://note/<path>` so hosts attach a note as context without a tool call. Prompts once tools are stable.
- **Webhooks or an event stream.** The hub already broadcasts every commit. `--webhook URL` or SSE at `/events`: rebuild a site, notify, run an agent on "note changed".
*(The agent audit log and undo were here. They are now M5 tasks in PLAN.md. They are not optional additions, they are the reason unattended agent writes are acceptable at all. Note that the plugin's history panel does not already provide undo: it restores without replacing, by design, `basalt:client/src/plugin/history.ts:39`.)*

## A milestone of work, high payoff

- **Publishing.** Serve a folder or a tag as a static site from the store, or export on commit for Quartz or Hugo.
- **`serve --export-dir DIR`.** One-way plaintext mirror written from head versions: no credential, no upload path, no merge, no engine. A few hundred lines, and it covers the NAS-mirror case without a second sync implementation. See PLAN §2.6.
- **Go sync engine and `serve --vault-dir`.** Cut from the plan (PLAN §2.6). Reopening needs a measured runtime, packaging or resource requirement, plus shared golden merge decisions, pinned algorithm settings, explicit UTF-16 handling, differential fuzzing, and a rule that unexplained disagreement keeps both versions. The exclusion-lock incompatibility between Go `flock` and the Node adapter's abstract socket must be solved before two implementations ever share a directory.
- **Scheduled agents on the server.** `telimus run --prompt-file` calling a model with the MCP tools against the local store on a schedule: morning summaries, inbox triage, link fixing. The server always has the notes and never sleeps.
- **Semantic search.** An embeddings table maintained beside the FTS index, on the same asynchronous worker (PLAN §2.5), not at commit. Needs a model endpoint trusted with the text.
- **Time-travel reads.** `read_note` at a timestamp; `vault_at(time)` listings. The store has everything; it is a query.
- **Attachment tools.** Image dimensions, PDF text into the search index, `read_attachment` as a resource.
- **Streaming assembly on download.** Basalt's `docs/open-work.md` first item; lifts the 64 MiB default. Independent of encryption but easier without the seal window.
- **`import-basalt`.** Replay a Basalt data directory into Telimus given a data key exported from a paired device. History would carry over.
- **Whole-file `write_note`.** Settled as refused for v1 (PLAN §4.4). If usage shows the need, it arrives as `replace_note` with a full-read base, diff preview, audit record, pinned before-image and conditional undo, or, more likely, as a structural `replace_section` on the Markdown AST.
- **Stdio bridge.** `telimus mcp-stdio --url --token-file` for hosts that cannot speak streamable HTTP.

## Borrowed from `asciimoo/hister`

A close structural sibling: one self-hosted Go binary, privacy-first, full-text index, served to web, TUI, CLI and MCP; 4,900 stars in eight months. Three of its ideas were promoted straight into PLAN.md (the untrusted-content envelope in §4.10, `doctor` in M5.5, packaging and README shape in M9). These are the rest.

- **A TUI.** `hister` ships `cmd/tui/`. Browse the vault, search, read a note's version history, see device and agent activity, all in the terminal. It is the natural companion to a headless server and it costs far less than a web UI.
- **Importers for the neighbours.** `hister` ships seven (karakeep, linkding, linkwarden, raindrop, readeck, shaarli, wallabag) and they are how people switch to it. The equivalents here: Obsidian Sync, remotely-save, a Syncthing folder, LiveSync, or a plain directory. This is the same machinery as the M10 migration, so it is nearly free once that exists, and it turns a one-time personal cutover into a way in for everyone else.
- **A demo instance.** `demo.hister.org` lets people try before installing. Harder here, since a sync server needs a vault and a device, but a read-only demo over a sample vault with the MCP endpoint exposed would show the whole idea in one link.
- **Reconsider OAuth, deliberately.** `hister` has `server/oauth/`; PLAN §2.3 refuses OAuth in favour of a static bearer behind Tailscale. That refusal still looks right for one person, but it is now a considered difference from a peer project rather than an obvious call. Revisit if the MCP endpoint is ever exposed to a host that cannot hold a static token safely.
- **Semantic search, framed as they frame it.** Optional, off by default, and disclosed exactly: "sends document text to the embeddings endpoint you choose." That sentence is the whole privacy contract and it belongs beside the setting, not in a footnote.

## Interesting, but they push on the scope refusals

- **Share one note.** A signed read-only link. Tiny to build, and the first step toward teams. Decide on purpose.
- **Several vaults per server.** Cheap without per-vault keys; the MCP `vault` parameter is already in the tool spec. Per-token vault scope follows. Note this is also the point at which narrower readers exist, so chunk-name presence oracles and fetch authorisation need revisiting (PLAN §2.2).
- **Obsidian config sync.** Still refused: settings and workspace files have different ownership and failure modes from notes.

## First three after M5

Webhooks, backlinks and vault health, and the web history viewer. Small, compounding, and none of them were possible before. (Undo used to be on this list; it moved into M5.)
