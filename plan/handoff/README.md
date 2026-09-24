# Handoff: resuming on 2026-09-24

Written at the end of the 2026-09-23 session, which was paused for the token
budget. Give Claude the prompt below to pick everything up.

## The prompt to paste

> Resume TrewSync from plan/handoff/README.md. Read it, CLAUDE.md and
> PLAN.md first. Finish the three stopped worktrees in the order the handoff
> gives, verifying each and merging it into m1-flip only when
> scripts/check.sh passes on the merged tree. Then continue the remaining
> milestones autonomously with local commits at green gates, nothing pushed,
> and ask me before anything that touches the real vault, the live Basalt
> server, the phone, or publishing.

## Where things stand

- Branch `m1-flip` at `bd06188`, in `~/code/gabbro`. `scripts/check.sh`
  passed 33 of 33 on exactly that commit. Nothing is pushed; there is no
  GitHub repo yet (on hold until the owner asks).
- **Done:** M0, M0.5, M1, M2 (real-app acceptance recorded), M4 (including
  Claude Code acceptance), the M9 directory lint gate.
- **M3:** exercised on the Mac and the Pixel 9 Pro XL over Tailscale; its
  four findings are fixed and merged (a receiver deleting a file it had just
  downloaded, and three revoke/re-pair panel defects). What remains is the
  re-check on the Pixel (below).
- **M5:** merged: the store's `CommitOperation`, oplog, `trewd audit`,
  idempotency, before-image pins (tasks 1, 2, 3, 10); the pure edit/tag/plan
  functions (4, and the pure half of 5 and 6); the twelve write tools,
  `lookup_operation`, the link index, author labels, the injection round
  trip (5, 6, 8, 11). In progress in worktrees: undo (7), the crash matrix
  (9), the phone races (12). Left: the done-when's "a day of real use on a
  scratch vault".
- **Also merged today:** folder deletions now travel (a receiver removes a
  folder only if it is empty there; the server refuses a folder deletion
  while anything live is inside); the product is called **TrewSync**, the
  server command is **`trewd`**, the headless client stays **`trew`**, and
  every identifier (`trew-sync`, the Go module, `TREW_DATA`, `.trew`,
  `trew1i_`) is unchanged.

## Owner decisions made on 2026-09-23 (already in memory and the docs)

1. Name: TrewSync everywhere a person reads it; `trewd` for the server;
   `trew` for the headless client; identifiers unchanged.
2. Folder deletions travel, removed only where empty (done).
3. Conflict copies are named after the **author** of the bytes they hold:
   the other device for a device conflict, the MCP token's label for an
   agent's edit, this device for its own bytes (in progress, worktree 3
   below).

## Step 1: finish the three stopped worktrees

Each is under `~/code/gabbro/.claude/worktrees/`. Each ends in its own
commits; the two with a `WIP:` commit were stopped mid-task and are not
verified. Resume each with a fresh agent in the same worktree (tell it the
worktree path and branch, not to reset it, and to read its own commits
first), then merge into `m1-flip` in this order, running
`scripts/check.sh` after each merge.

1. **Crash matrix and phone races (M5 tasks 9 and 12).**
   `agent-a9575e20cb205ea0c`, branch `worktree-agent-a9575e20cb205ea0c`,
   seven commits on `84ebee5`, clean, head `e8f20d2`. A real `trewd` is
   held at each write seam in a test-only build and SIGKILLed; the phone
   races run the agent through the HTTP tools against offline headless
   clients. It **found and fixed a real bug**: `7db8550` "Read an edit's
   note once, so a racing commit is stale and not gone". Remaining: review
   that fix, confirm the test-only kill cannot be enabled in a normal build,
   run `scripts/check.sh` in full on the branch merged with current
   `m1-flip`, and report.
2. **Undo (M5 task 7).** `agent-a665304e86ec8d95f`, branch
   `worktree-agent-a665304e86ec8d95f`, on `84ebee5`: `e3c951a` (plan and
   commit an undo in the store), `e2b4d6e` ("Speak protocol 2: undo over the
   wire"), `8ee6b49` (`trewd undo` through the control socket or the store),
   then `9a1af7c` WIP (the MCP `undo_operation` tool and its tests,
   unfinished). Remaining: finish the MCP undo tests; the plugin history
   panel's "Undo this change"; docs; the full gate. **Review the protocol 2
   bump carefully**: the plugin, the headless client and the server must
   agree, older peers must be refused or served correctly, and the
   fixtures, transcripts and `scripts/protocol-vectors.py` must match.
3. **Conflict copies named after the author.** `agent-a98973ba25aec132a`,
   branch `worktree-agent-a98973ba25aec132a`, on `bd06188`: one WIP commit
   `062b1c4` of 38 files across client core, node, plugin, `internal/paths`,
   `internal/mcp` and the docs. The client suites and the stress suite had
   passed on it; the Go gate had not run. Remaining: check every
   copy-making site names the author of the bytes it holds, the filename
   sanitising of labels (`/`, `:`, control characters, Windows trailing dot
   or space, length), that recognition of copies still accepts any author,
   the conflicts screenshot scene, then the full gate.

## Step 2: re-check M3 on the Pixel (needs the owner and the phone)

Ask the owner first, and ask before bringing Obsidian to the foreground on
the phone. What to re-check: an attachment and a new file arriving in the
same pass as another download no longer make the receiver delete anything;
a revoked device's panel leads with pairing again, the spent invite is not
pre-filled, the stopped notice clears; a folder rename leaves no ghost on
the other device; conflict copies carry the author's name.

How it was driven on 2026-09-23 (the helpers are in this folder):

- Server: build `./cmd/trewd`, run `trewd serve -addr 127.0.0.1:3421 -url
  wss://wph.example.ts.net:8445 -data <dir> -mcp`, then `tailscale serve
  --bg --https=8445 http://127.0.0.1:3421` (tailnet only; 8443 and 8444
  belong to other things; turn it off afterwards with `tailscale serve
  --https=8445 off`).
- Mac: vault `~/trew-m3-mac` (registered in Obsidian); `in-vault.mjs VAULT
  FILE.js [ARG]` runs code inside an open vault through the `obsidian` CLI.
- Phone: reached with `adb` over Tailscale (wireless debugging,
  `100.64.0.99`); the test vault is `/sdcard/Documents/Trew M3` (never
  touch `My Vault` or `Test` there). Push a new plugin build into its
  `.obsidian/plugins/trew-sync/`. Obsidian's WebView is debuggable:
  `adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell
  pidof md.obsidian)`, then `phone-eval.mjs FILE.js [ARG]` runs code in it.
  Obsidian must be in the foreground or the WebView is paused.
- Both vaults were paired to a server whose data directory lived in the old
  session's scratchpad and is gone; pair them again (unlink, then an invite).
- `accept.mjs` and `accept-mcp.mjs` are the M2 and M4 acceptance drivers;
  they expect the binary beside their folder and fresh vault names, so
  adjust paths before reuse.

## Step 3: the rest

- **M5 done-when:** a day of real use on a scratch vault with no
  unexplained conflict copy (run an agent through the write tools against a
  scratch vault paired to the plugin, and read `trewd audit` after).
- **M5.5** operational acceptance and restore rehearsal (after M5).
- **M9** packaging and docs: goreleaser, Homebrew tap, Nix flake, `trewd
  update`, the docs site, the README in the shape PLAN describes with the
  Privacy section, `docs/agent.md`, CHANGELOG/CONTRIBUTING/SECURITY, the
  community directory submission write-up. Anything that publishes (npm,
  GitHub releases, the directory) needs the repo: ask first.
- **M10** cutover acts on the real vault ("My Vault") and the live Basalt
  server: ask first, and only after M5.5 and M9.

## Loose ends

- Merged agent worktrees still sit in `.claude/worktrees/`; the three above
  are the only ones with unmerged work. The rest can be removed once those
  three are merged.
- Eight `trew-accept-*` vaults from the M2 and M4 acceptance runs are
  registered in Obsidian and on disk in `~`, kept for inspection; remove them
  through Obsidian when no longer wanted.
- Lint counts 65 accepted warnings (the sentence-case rule flags
  "TrewSync"); the ledger is in `docs/development.md`.
- `compose.yaml` pins the old `0.9.0` image, which has `/trew` inside; the
  documented `docker compose exec trew /trewd ...` works once an image built
  from this tree is released and pinned.
- Fixed outside the repo: `~/.local/bin/export-fathom-notes` passed
  `vault=` after `create`, so the `obsidian` CLI created an empty note in
  whichever vault was active.
