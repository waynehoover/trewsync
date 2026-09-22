/**
 * The vault lock, and the ways it could be handed to two processes.
 *
 * It is the only thing standing between two `telimus` processes and two engines
 * writing notes, config and index over each other from state neither saw. So
 * the property under everything here is the same one: two callers never both
 * come back holding it.
 *
 * Five of the six defects this file records were in automatic stale-lock
 * takeover, which no longer exists (R03, R34, R40, R44, R49). What is left is
 * an exclusive `link` and a refusal, and the tests that used to prove a
 * takeover was safe now prove there is not one. `unlock.test.ts` covers the
 * command that replaced it.
 *
 * The other faults were an empty file and an identity that is not one. Taking
 * the lock used to create the file with `wx` and write the holder afterwards,
 * which left a window in which the lock existed and said nothing; a competitor
 * read that, called it corrupt, deleted it and took a lock somebody was
 * holding. And release matched on pid and host, which the operating system
 * reuses.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { spawn } from "node:child_process";
import { hostname } from "node:os";

import { STATE_DIR } from "./config.ts";
import { forgetProven, pretendThereIsNone } from "./exclusion.ts";
import { alive, currentHolder, lockPath, lockVault, midPublish } from "./lock.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function vault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "telimus-lock-"));
  dirs.push(dir);
  return dir;
}

/** A pid that is certainly not running, for the stale-holder cases. */
function deadPid(): number {
  for (let pid = 4_000_000; pid > 100; pid -= 7919) {
    if (!alive(pid)) return pid;
  }
  throw new Error("every pid on this machine is alive, which cannot be");
}

/** A lock left behind by a process that is gone: what a crash leaves. */
async function staleLock(dir: string): Promise<number> {
  const pid = deadPid();
  await mkdir(join(dir, STATE_DIR), { recursive: true });
  await writeFile(
    lockPath(dir),
    JSON.stringify({
      pid,
      host: hostname(),
      command: "sync --watch",
      since: Date.now() - 1000,
      token: "a stale token",
    }),
  );
  return pid;
}

describe("taking the vault lock", () => {
  it("hands it to exactly one of many callers at once", async () => {
    const dir = await vault();
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) => lockVault(dir, `command ${i}`)),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners.length, `${winners.length} callers were all told they hold the vault`).toBe(1);
    for (const loser of results.filter((r) => r.status === "rejected")) {
      expect((loser as PromiseRejectedResult).reason.message).toMatch(/another telimus/);
    }
  });

  it("never leaves the lock file present without a holder in it", async () => {
    // The empty window, which is what let a competitor delete a live lock.
    // Sampled as hard as this event loop allows while an acquisition runs.
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    const path = lockPath(dir);

    let sampling = true;
    const empty: string[] = [];
    const sampler = (async () => {
      while (sampling) {
        try {
          const text = await readFile(path, "utf8");
          if (text === "" || !text.includes('"token"')) empty.push(JSON.stringify(text));
        } catch {
          // Not there yet, which is a lock nobody is misreading.
        }
      }
    })();

    for (let i = 0; i < 40; i++) {
      const release = await lockVault(dir, "sync");
      await release();
    }
    sampling = false;
    await sampler;
    expect(empty, `the lock was readable with no holder in it: ${empty.join(", ")}`).toEqual([]);
  });

  it("refuses while a holder on this host is alive, and frees on release", async () => {
    const dir = await vault();
    const release = await lockVault(dir, "sync --watch");
    await expect(lockVault(dir, "sync")).rejects.toThrow(/another telimus is using this vault/);
    await release();
    // And it is free again afterwards.
    await (
      await lockVault(dir, "sync")
    )();
  });
});

/**
 * What I27 is for: a crashed telimus does not wedge the next one.
 *
 * Every one of the five failed takeover attempts was trying to synthesise this
 * property out of a file, and could not, because "the holder is dead" is a
 * conclusion and acting on a conclusion is two steps. The kernel does it in
 * one: the exclusion goes away when the process does.
 */
describe("recovering from a telimus that died", () => {
  it("takes a vault whose holder is gone, with nobody typing anything", async () => {
    const dir = await vault();
    await staleLock(dir);

    // No `telimus unlock`. This is the whole change.
    const release = await lockVault(dir, "after the crash");
    expect(await currentHolder(dir)).toMatchObject({ pid: process.pid });
    await release();
  });

  it("still hands it to exactly one of many contenders", async () => {
    const dir = await vault();
    await staleLock(dir);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => lockVault(dir, `after the crash ${i}`)),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(
      winners.length,
      `${winners.length} contenders took over the same dead holder's lock`,
    ).toBe(1);
    for (const w of winners) await (w as PromiseFulfilledResult<() => Promise<void>>).value();
  });

  it("clears debris that names nobody, rather than refusing for ever", async () => {
    // Holding the kernel's exclusion establishes that no local telimus is
    // inside, so a file that cannot be read is not a holder: it is litter.
    // Without the exclusion this has to refuse, because it cannot know.
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(lockPath(dir), "this is not a holder");
    const release = await lockVault(dir, "sync");
    expect(await currentHolder(dir)).toMatchObject({ pid: process.pid });
    await release();
  });

  it("does not take one a live process is holding", async () => {
    const dir = await vault();
    const release = await lockVault(dir, "sync --watch");
    await expect(lockVault(dir, "sync")).rejects.toThrow(/another telimus is using this vault/);
    await release();
    await (
      await lockVault(dir, "sync")
    )();
  });

  it("still believes a holder on another machine", async () => {
    // A kernel answers for one machine. A vault on a disk two machines can
    // reach is outside all of this, and the file is what still answers it.
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: process.pid,
        host: `not-${hostname()}`,
        command: "sync --watch",
        since: Date.now(),
        token: "theirs",
      }),
    );
    await expect(lockVault(dir, "sync")).rejects.toThrow(/different machine/);
    await expect(lockVault(dir, "sync")).rejects.toThrow(/--force/);
  });

  it("refuses rather than proceeding when the exclusion disagrees with the file", async () => {
    // The one failure that would matter: a mechanism that reports success
    // without excluding. Everything above treats holding it as proof that no
    // other local process is inside, so a live local pid in the file is a
    // contradiction, and this believes neither side and stops. Simulated by
    // writing a live pid that is not ours into a vault nothing holds.
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      await writeFile(
        lockPath(dir),
        JSON.stringify({
          pid: child.pid,
          host: hostname(),
          command: "sync --watch",
          since: Date.now(),
          token: "theirs",
        }),
      );
      await expect(lockVault(dir, "sync")).rejects.toThrow(/still running/);
      await expect(lockVault(dir, "sync")).rejects.toThrow(/wrong with locking/);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("releasing the vault lock", () => {
  it("removes only its own, not whatever is at the path", async () => {
    // A lock that is not this release's to remove. Matching on pid and host
    // let a release take one, because the operating system reuses pids, so
    // the token is what "still ours" means.
    const dir = await vault();
    const release = await lockVault(dir, "sync");
    const theirs = JSON.stringify({
      pid: process.pid,
      host: (await import("node:os")).hostname(),
      command: "somebody else",
      since: Date.now(),
      token: "not our token",
    });
    await writeFile(lockPath(dir), theirs);

    await release();

    const after = await readFile(lockPath(dir), "utf8");
    expect(after, "the release removed a lock that was not its own").toBe(theirs);
  });

  it("leaves nothing behind when it is its own", async () => {
    const dir = await vault();
    const release = await lockVault(dir, "sync");
    await release();
    await expect(readFile(lockPath(dir), "utf8")).rejects.toThrow(/ENOENT/);
  });
});

/**
 * The same lock with no kernel exclusion to be had.
 *
 * This is what runs on a platform without a mechanism, and on a filesystem
 * where the mechanism does not actually hold -- a network mount being the case
 * that matters, since that is where `O_EXLOCK` is most likely to be ignored.
 * It is the whole of the pre-I27 protocol and it is not dead code, so it is
 * tested as its own contract rather than left to be exercised by accident.
 *
 * What differs is the recovery, and only the recovery. A holder that died
 * still holds the vault as far as this path can tell, because telling would
 * mean guessing, and `telimus unlock` is the way out.
 */
describe("the vault lock with no kernel exclusion", () => {
  beforeEach(() => {
    pretendThereIsNone.on = true;
    forgetProven();
  });
  afterEach(() => {
    pretendThereIsNone.on = false;
    forgetProven();
  });

  it("does not hand the lock to a competitor that arrives mid-acquisition", async () => {
    // The reproduced fault, made deterministic. The old implementation created
    // the lock file empty and wrote the holder afterwards; a competitor that
    // arrived in between read nothing, decided the file was corrupt, deleted
    // it and took a lock somebody already held. Both callers then believed
    // they owned the vault.
    //
    // The seam is that same instant. Nothing is at the path yet now, because
    // the holder is built under a private name and linked into place, and a
    // link either creates the name or fails.
    const dir = await vault();
    // The competitor takes the lock during that instant and keeps it, which
    // is what a second `telimus` process does: it is not going to hand it back
    // while the first is still deciding.
    let theirs: (() => Promise<void>) | undefined;
    midPublish.pause = async () => {
      midPublish.pause = async () => {};
      theirs = await lockVault(dir, "the competitor").catch(() => undefined);
    };

    const mine = await lockVault(dir, "sync --watch").then(
      (r) => r,
      () => undefined,
    );

    expect(theirs, "the competitor could not take a lock nobody held").toBeDefined();
    expect(
      mine,
      "both callers were told they hold the vault, and the competitor is still holding it",
    ).toBeUndefined();

    if (mine !== undefined) await mine();
    if (theirs !== undefined) await theirs();
    midPublish.pause = async () => {};
  });

  it("refuses a lock whose holder has died, and says what to do", async () => {
    const dir = await vault();
    await staleLock(dir);

    // Every contender wants the same abandoned lock, which is what a machine
    // looks like after a crash and a cron job. Not one of them may have it:
    // five attempts at deciding this automatically each handed one vault to
    // two writers, and the sixth answer is not to decide.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => lockVault(dir, `after the crash ${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toEqual([]);
    for (const r of results) {
      const why = (r as PromiseRejectedResult).reason.message;
      expect(why).toMatch(/not running any more/);
      // The way out has to be in the message. A refusal that leaves somebody
      // guessing which terminal to look in is the cost of not taking over,
      // and it is only worth paying if the message pays it back.
      expect(why).toMatch(/telimus unlock/);
    }
  });

  it("tells a live holder apart from a dead one and from another machine", async () => {
    const here = hostname();
    const dir = await vault();
    const release = await lockVault(dir, "sync --watch");
    await expect(lockVault(dir, "sync")).rejects.toThrow(/Wait for it to finish, or stop it/);
    await release();

    await staleLock(dir);
    await expect(lockVault(dir, "sync")).rejects.toThrow(/telimus unlock/);

    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: process.pid,
        host: `not-${here}`,
        command: "sync --watch",
        since: Date.now(),
        token: "theirs",
      }),
    );
    // A pid that is alive here means nothing about a process over there, and
    // saying "wait for it to finish" would be advice about the wrong machine.
    await expect(lockVault(dir, "sync")).rejects.toThrow(/different machine/);
    await expect(lockVault(dir, "sync")).rejects.toThrow(/--force/);
  });

  it("refuses when something is at the path that names nobody", async () => {
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(lockPath(dir), "this is not a holder");
    // Absent and unreadable are different states (rule 2). Taking the vault
    // here would mean writing over whatever that is.
    await expect(lockVault(dir, "sync")).rejects.toThrow(/does not name a holder/);
  });
});
