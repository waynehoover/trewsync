/**
 * The kernel exclusion, on whatever platform this is, with real processes.
 *
 * `cli/lock.test.ts` covers the protocol; this covers the property the
 * protocol is built on and cannot check for itself: that the operating system
 * takes the exclusion away when the holder dies. A unit test cannot establish
 * that, because a process that is still running to make an assertion has not
 * died.
 *
 * Run by `scripts/check.sh` on the developer's machine and by CI on Linux, so
 * both mechanisms are exercised somewhere. They are entirely different -- a
 * `flock` taken at `open` on macOS, an abstract socket on Linux -- and a
 * property proven on one says nothing at all about the other (I27).
 */

import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { STATE_DIR } from "../client/src/node/config.ts";
import { alive, currentHolder, lockPath, lockVault } from "../client/src/node/lock.ts";
import { BUSY, mechanismFor, provenFor } from "../client/src/node/exclusion.ts";

const failures: string[] = [];
function ok(what: string, holds: boolean): void {
  console.log(`  ${holds ? "ok  " : "FAIL"}   ${what}`);
  if (!holds) failures.push(what);
}

if (process.argv[2] === "hold") {
  await lockVault(process.argv[3]!, "the holder");
  console.log("held");
  setInterval(() => {}, 1000);
} else {
  console.log(`the kernel exclusion on ${platform()}:`);
  const m = mechanismFor();
  if (m === undefined) {
    // Not a pass. A platform with no mechanism falls back to the file, which
    // is correct behaviour and is not what this file is checking, so it says
    // so rather than printing a row of ticks.
    console.log(`  no mechanism on ${platform()}, so a crashed trew needs trew unlock`);
    process.exit(0);
  }

  const dir = await mkdtemp(join(tmpdir(), "trew-kernel-lock-"));
  await mkdir(join(dir, STATE_DIR), { recursive: true });
  ok(`${m.how} actually excludes on this filesystem`, await provenFor(m, join(dir, STATE_DIR)));

  // A holder in a process of its own, so the kill is a real one.
  const child = spawn(process.execPath, [process.argv[1]!, "hold", dir], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((go) => child.stdout.on("data", go));

  let refused = false;
  try {
    await lockVault(dir, "second");
  } catch (err) {
    refused = /another trew/.test((err as Error).message);
  }
  ok("a second trew is refused while the holder runs", refused);
  ok("and the lock names the holder", (await currentHolder(dir))?.pid === child.pid);

  child.kill("SIGKILL");
  await new Promise((go) => child.on("exit", go));

  let took = false;
  try {
    const release = await lockVault(dir, "after the kill");
    took = true;
    await release();
  } catch (err) {
    console.log(`         refused: ${(err as Error).message.slice(0, 80)}`);
  }
  // The whole of I27 in one line. Everything else here is scaffolding for it.
  ok("after SIGKILL the next trew takes it, with nobody typing anything", took);

  // And a record naming a pid that never existed is debris, not a holder.
  let dead = 4_000_000;
  while (alive(dead)) dead -= 7919;
  await writeFile(
    lockPath(dir),
    JSON.stringify({ pid: dead, host: hostname(), command: "sync", since: 1, token: "stale" }),
  );
  let cleared = false;
  try {
    const release = await lockVault(dir, "after the crash");
    cleared = true;
    await release();
  } catch {
    /* reported below */
  }
  ok("a lock left by a process that is gone is taken over", cleared);

  // The lock must outlive the caller's interest in it.
  //
  // A `FileHandle` is closed by a finalizer, so an exclusion whose only
  // reference was a closure the caller discarded could be collected -- and
  // collecting it drops the lock while this process is still running and still
  // writing notes. `lockVault` returns a release function and a caller is
  // allowed to ignore it; the lock's lifetime has to be the process's.
  //
  // Forced, because garbage collection is not otherwise a thing a test can
  // wait for. Bun's own warning about a collected handle is what found this in
  // the first place, on a run where it happened to fire.
  const gcDir = await mkdtemp(join(tmpdir(), "trew-kernel-gc-"));
  await mkdir(gcDir, { recursive: true });
  await (async () => {
    await m.take(`${gcDir}#probe`, join(gcDir, "lock.excl"));
  })();
  for (let i = 0; i < 5; i++) {
    (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun?.gc(true);
    (globalThis as { gc?: () => void }).gc?.();
    await new Promise((go) => setTimeout(go, 20));
  }
  const survived = await m.take(`${gcDir}#probe`, join(gcDir, "lock.excl"));
  ok("the lock survives the caller dropping its release function", survived === BUSY);

  // One vault, two ways of naming it.
  //
  // Linux names its exclusion after the vault's path, so a name is only an
  // exclusion if two spellings of one vault produce one name. They did not:
  // a symlink to a vault, and the same path with a trailing slash, each got a
  // name of their own and each admitted a second writer. macOS never had it,
  // because a `flock` is on an inode and does not care what the path looked
  // like, which is why this check has to run on Linux to mean anything.
  const twoNames = await mkdtemp(join(tmpdir(), "trew-kernel-names-"));
  const real = join(twoNames, "vault");
  await mkdir(join(real, STATE_DIR), { recursive: true });
  const link = join(twoNames, "link");
  await symlink(real, link);

  const first = await lockVault(real, "through the real path");
  for (const [what, other] of [
    ["a symlink to it", link],
    ["a trailing slash", `${real}/`],
  ] as const) {
    let admitted: (() => Promise<void>) | undefined;
    try {
      admitted = await lockVault(other, "through another name");
    } catch {
      /* refused, which is the answer */
    }
    ok(`the same vault reached through ${what} is one vault`, admitted === undefined);
    if (admitted !== undefined) await admitted();
  }
  await first();

  if (failures.length > 0) {
    console.error(`${failures.length} kernel-exclusion checks failed`);
    process.exit(1);
  }
  console.log("all checks passed");
}
