# Documentation review — September 8, 2026

[Developer documentation](development.md)

The README and user guides now lead with what Basalt does, who it fits, and how
to use it. Technical comparisons, review narratives, and implementation details
previously competed with those tasks. They now have separate maintainer pages.

This was an editorial and documentation-accuracy review of every tracked
Markdown file, not a new audit declaring the implementation production-ready.
The baseline is `573617c`, before the editorial changes were incorporated into
`2c2176d`; later pairing instructions also reflect the updated panel.

## Page-by-page changes

Approximate whitespace-delimited word counts. “After” counts the named page;
material moved to new pages is included separately below.

| Original page | Before | After | Editorial change |
|---|---:|---:|---|
| README | 1,039 | 574 | Clear subtitle, benefits, screenshots, three setup steps, support limits, and a task-based guide list. |
| Product comparison | 4,935 | 514 | Hosting, setup, file scope, encryption, cost model, and fit. Removed protocol scoring and incomparable speed claims. |
| Plugin guide | 4,393 | 1,552 | Install, pair, sync, recover, and manage devices in panel order. Moved adapter mechanics out. |
| CLI README | 4,868 | 1,127 | Start with an explicit read-only mirror. Move exhaustive flags and development guidance into references. Keep npm links absolute. |
| Server guide | 7,986 | 1,025 | Focus on installation, TLS, first pairing, and upgrades. Split maintenance and reference into their own pages. |
| Design | 5,795 | 1,989 | Preserve eleven numbered durability rules, supported scope, and trust assumptions; remove repeated incident narratives. |
| Protocol | 7,452 | 2,784 | Describe current v5 messages, limits, authentication, and errors; remove competitor critique and obsolete examples. |
| Index journal | 1,953 | 740 | Describe the shipped implementation directly, without mixing proposal and implementation. |
| Findings index | 1,398 | 1,152 | Preserve all defined IDs; frame them as historical findings, with shorter archival context. |
| CLAUDE.md | 691 | 354 | Preserve contributor rules and verification requirements; route future technical material to developer docs. |

New pages include the documentation hub, security guide, server maintenance,
server and CLI references, developer hub, and engineering notes. The requested
agent installer adds `llm.md` and a small `llms.txt` index. These are deliberate
splits by reader and task, not a claim that all removed words disappeared.

Across the old pages and their new destinations, the documentation is roughly
half its previous 40,510-word size, including the agent installer. Historical
benchmark evidence remains available in a shorter engineering page and Git.

## Factual corrections

- A plugin sync can update an open note. Conflict preservation does not imply
  that the editor's original file is never replaced.
- Reusing a backup destination replaces its database snapshot. Keeping leftover
  content files does not preserve a usable pre-purge history; retain a complete
  separate snapshot.
- CLI read-only mode controls ordinary sync. It is not a server permission, and
  explicit repair can upload missing content.
- `--recovery-key` requires a literal argument. The file/stdin secret helpers
  apply to positional setup, pairing, and rotation inputs.
- Recovery-key rotation keeps the data key and existing devices. It cannot
  retract plaintext or keys held by a revoked device.
- Entry authentication does not cover server-assigned UIDs or device labels.
  Ordering, completeness, and replay protection remain bounded by the design.
- Pairing instructions follow the current two-choice panel. Removed the old
  combined-form screenshot that contradicted those instructions.
- Protocol examples now use v5 and include request IDs for rename and resend.
  Name limits count bytes. Deterministic GCM sealing is not nonce-misuse-resistant.
- Compose maintenance reuses its actual volume. Backup transfer follows
  successful backup/verification; container presence alone is not setup success.

## Positioning

**Fast, secure, self-hosted sync for Obsidian. Simple setup.** is the shared
subtitle in the README, product metadata, documentation entry points, and GitHub
About. Supporting copy explains encryption concretely. “Simple setup” describes
a focused installation; it does not imply managed hosting or zero maintenance.

The comparison uses official Obsidian and LiveSync sources, checked on the
review date. It presents alternatives fairly and avoids unstable price tables.
Historical benchmark results and version-specific source observations are
explicitly labeled; they were not rerun for this pass.

## Keep future docs focused

1. Give each page one reader and one main job. Link to detail at the point it
   becomes useful; do not copy the protocol into a setup guide.
2. Lead marketing with user benefits and fit. Explain security claims with the
   property protected and link the relevant limits.
3. Put commands and expected results together. Match current flags and panel
   labels, distinguish server/plugin/CLI releases, and mark placeholders.
4. Keep recovery steps explicit about retained data and keys. Do not recommend
   deleting state as generic troubleshooting.
5. Record measurements with commit, environment, method, and correctness checks.
   Compare products only under genuinely comparable conditions.
6. Keep agent instructions actionable and resumable. Separate installation,
   pairing, and observed sync success; never fabricate completed verification.

## Verification scope

Checked Markdown parsing, local/repository links and anchors, image paths, shell
example syntax, subtitle consistency, and the server image pin. Compared command
examples and behavior claims with source, CLI help, Obsidian CLI capabilities,
and release metadata. Actual installation, two-device acceptance, benchmarks,
and the full application test suite were not rerun for this prose-only pass.

## September 10 follow-up

Reviewed the README, documentation hub, comparison, plugin guide, and agent
installer against the current plugin and server contracts. The September 8
review above remains a record of that version, including its protocol references.

- Replaced the README's vague privacy benefit with encryption before upload.
- Clarified when pairing shows a first-sync preview and how device delivery
  status differs from this device finishing sync.
- Documented retry and older-page navigation in deleted-note recovery.
- Moved the agent installer's Compose inspection before startup and put the
  released pairing preview in the main installation flow.
- Rechecked comparison claims against official Obsidian and LiveSync sources.

The accompanying plugin review exercised deleted-note recovery with two clients
and a real test server, and checked the recovery dialogs in light and dark
desktop and phone layouts. Phone images use desktop Obsidian's mobile CSS;
they do not establish Android runtime behavior. No installation or deployment
to a personal vault was part of this review.
