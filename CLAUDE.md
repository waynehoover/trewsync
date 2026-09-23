# Trew

Self-hosted vault sync with full version history, on a server you run.

Trew is a fork of Basalt Sync (`github.com/waynehoover/basalt-sync`, commit
`664a963`). The destination is a server that holds notes in plaintext, with an
MCP endpoint built into it so agents read and edit the same notes devices sync.
[PLAN.md](PLAN.md) is the plan and the milestones; read it, and the files in
[plan/](plan/) it points to, before starting a task.

**Where the code is today: M0.** The tree is Basalt, renamed, with every
Basalt test passing. It is still end-to-end encrypted. The encryption is
removed in M1 (server) and M2 (client), in small commits that keep the suites
green. Until then the docs describe the encrypted system, because that is what
the code does. The `basalt3i_` and `basalt3_` prefixes and the `basalt/.../1`
key-derivation labels are deliberately unrenamed: they die with the crypto.

## Layout

| Path | What |
|---|---|
| `go.mod`, `cmd/trew/`, `internal/` | Go server, `trew`: store, chunks, sessions, backup, verify, purge |
| `client/src/core/` | shared sync engine: reconciliation, merge, index journal, transport |
| `client/src/plugin/` | Obsidian plugin and its preserving-write adapter |
| `client/src/cli/` | headless client (`trew-sync` on npm) and its filesystem adapter |
| `client/src/stress/` | fault, crash, collision and scale suites |
| `scripts/check.sh` | the full local gate, with a guard against drift from CI |
| `docs/` | user and developer docs; `docs/findings.md` defines the review IDs cited in code |

## Preserve notes

**Do not lose a note.** Correctness takes priority over simplicity; cut a
feature if necessary. Preserve the eleven
[durability rules](docs/design.md#the-durability-rules) by their numbers.

Every write to a live Obsidian vault on a development machine must go through
the `obsidian` CLI, never direct `mv`, `rm` or `cp`. This preserves Obsidian's
view of changes. Repository files are not live vault notes.

**Deleting a test file is a decision, not cleanup** (PLAN §2.1). Before deleting
one, list its assertions, classify each as obsolete with the crypto or still a
guarantee, rewrite the setup for the second kind and keep the assertion. The
ledger lives in `docs/development.md`.

## Verification

**Run `scripts/check.sh` before pushing.** Exit 0 means the full local gate
passed; exit 2 means checks could not run and is not a pass. Inspect CI for the
exact commit too: local success does not establish CI success.

A unit-test pass alone does not cover stress or real-runtime behavior. For every
bug fix, show that its regression test fails without the fix and passes with
it. Check preservation of the edited content, not just agreement between
clients.

## Documentation and prior art

Write the README and user guides for people choosing, installing and using
Trew. Put implementation details in the
[developer documentation](docs/development.md). [llm.md](llm.md) is the
installation runbook for agents helping users.

Credit projects and record design evaluations in
[docs/research.md](docs/research.md). The 2026-09-22 investigation of other
self-hosted Obsidian sync projects is in [plan/research/](plan/research/).
Copyleft or unlicensed code from those projects (PKV Sync, NoX Sync, the Pumice
server, the LiteSync server) is never copied, in any form.
