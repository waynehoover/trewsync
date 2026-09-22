/**
 * One scenario, in a process that is killed inside a seam.
 *
 * Run by `faults.stress.ts`, never by hand. Everything the seams protect is
 * written to be safe across a crash, and none of it had ever been crashed:
 * the seams stop the world and then let it go again, which exercises the
 * ordering but never the case where the second half of an operation simply
 * does not happen. A `finally` that puts a note back is exactly the kind of
 * repair a SIGKILL skips.
 *
 *   bun run src/stress/faults-child.ts <dir> <scenario> <seam> <token>
 *
 * SIGKILL rather than `process.exit`, because `exit` runs handlers and flushes
 * and a crash does not. It also means this process leaves no exit code worth
 * reading: the parent looks at the vault, not at us (rule 4).
 */

import { writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { seamNamed } from "../core/seam.ts";
import { NodeVault } from "../cli/vault.ts";
// For its seams. The parent enumerates every registered seam and asks for
// each by name, so a module it has loaded and this one has not is a name
// this process cannot find.
import "../cli/lock.ts";
import { SCENARIOS } from "./fault-scenarios.ts";
import type { Ground } from "./faults.ts";

const [dir, wanted, seam, token, signals] = process.argv.slice(2);
if (!dir || !wanted || !seam || !token || !signals) {
  console.error("usage: faults-child.ts <dir> <scenario> <seam> <token> <signal-dir>");
  process.exit(2);
}

/**
 * Says out loud what this process did, where the parent can read it after the
 * kill and where the vault's own walk cannot see it.
 *
 * The parent used to work out whether the seam had been reached by looking for
 * the version it was about to check had survived. A run that lost that version
 * therefore reported "the seam was never reached" and no fault at all, which
 * is the exact inversion of what this file is for (RR4). Reachability has to
 * come from somewhere other than the bytes under test.
 *
 * Written synchronously: the next thing to happen is a SIGKILL, and an
 * unresolved promise is not a signal. `writeFileSync` returns with the bytes in
 * the page cache, which a killed process does not take with it.
 */
const announce = (what: string): void => {
  writeFileSync(join(signals, what), `${Date.now()}\n`);
};

const scenario = SCENARIOS.find((s) => s.name === wanted);
if (scenario === undefined) {
  console.error(`no scenario called ${wanted}`);
  process.exit(2);
}

const save = async (path: string, body: string): Promise<void> => {
  const full = join(dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(`${full}.editor-swap`, body);
  await rename(`${full}.editor-swap`, full);
};

const ground: Ground = {
  dir,
  vault: new NodeVault(dir),
  save,
  saveInPlace: async (path, body) => {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  },
  state: {},
};

await scenario.setup(ground);

let done = false;
seamNamed(seam).pause = async (): Promise<void> => {
  if (done) return;
  done = true;
  // Before the competitor writes, so the parent can tell "the seam ran and the
  // competitor could not write" from "the seam never ran".
  announce("reached");
  await scenario.interfere(ground, token);
  // And after, so the parent knows the version it is about to look for was
  // really put there. Only now is its absence a loss rather than a competitor
  // that failed.
  announce("wrote");
  // Nothing after this line runs. Not a `finally`, not a flush, not the rest
  // of the operation.
  process.kill(process.pid, "SIGKILL");
  // Unreachable, and here so the seam never returns even if the signal is
  // somehow deferred: returning would let the operation finish tidily, which
  // is the thing this file exists not to do.
  await new Promise(() => {});
};

// The scenario may refuse before it ever reaches the seam, which is a fine
// outcome and not this process's business to report.
await scenario.run(ground).catch(() => undefined);
// Reached only when the seam was never hit. The parent tells the difference by
// whether the token is in the vault at all.
process.exit(0);
