# Contributing to TrewSync

Thank you for helping. TrewSync's one priority is not losing a note, so a
change is judged first on whether it can lose, hide or corrupt one, and only
then on anything else.

## Before you start

For anything bigger than a small fix, open an issue first and say what you
want to change and why. The [design](docs/design.md) and its refusals say what
TrewSync deliberately does not do (configuration sync, teams, a web interface,
a second sync engine); a change that reverses one of those needs the reason to
change the decision, not just the code.

Read [the durability rules](docs/design.md#the-durability-rules) before
changing anything that writes, deletes, merges or recovers. Code comments cite
them by number.

## Build and test

The [developer documentation](docs/development.md#build-and-test) covers the
toolchain: the Go version in `go.mod` for the server, Bun for the client
scripts, and Node 22 or newer for the headless client. Before you push, run
the whole gate from the repository root:

```bash
bash scripts/check.sh
```

Exit 0 means everything CI runs passed on your machine. Exit 2 means some
checks could not run, which is not a pass. CI still runs on the exact commit,
and a check can pass locally and fail there.

## What a change needs

- **A bug fix comes with a test that fails without it.** Show the failure
  before the fix and the pass after.
- **Check the bytes, not agreement.** Two devices that agree have both lost
  an edit just as easily as they have both kept it. Assert the retained
  content.
- **A deleted test is a decision.** Before removing a test file, list its
  assertions and keep each one that is still a guarantee, with new setup if it
  needs it.
- **Keep sync decisions in the shared engine** (`client/src/core`), and a fix
  that touches one adapter checked against the other.
- **The plugin passes the community directory's review.** `bun run lint` runs
  it and fails on an error; a new warning needs its reason in the
  [ledger](docs/development.md#accepted-warnings).
- **No telemetry, no client-side error reporting, no self-update in the
  plugin.** The directory's policies forbid them and TrewSync does not want
  them.
- **Never copy code from copyleft or unlicensed projects**, in any form, tests
  and templates included. The [credits](docs/research.md#credits-and-dependencies)
  name the projects this applies to.

## Documentation

The README and the user guides are for people choosing, installing and using
TrewSync; implementation detail goes in the [developer documentation](docs/development.md).
When a change alters a command, a flag, a limit or what someone sees, change
the docs in the same commit. Say what is true of the code, not what is planned.

## Commits and pull requests

Write commit subjects that say what the change does for the reader, in the
present tense, as the history does: "Name a conflict copy after the author of
the bytes it holds". Explain the why in the body. Keep one logical change per
commit.

By contributing you agree that your contribution is licensed under the
[MIT licence](LICENSE).
