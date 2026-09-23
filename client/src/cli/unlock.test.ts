/**
 * `trew unlock`, which is what replaced automatic stale-lock takeover.
 *
 * Five attempts at deciding on its own that a holder was gone each handed one
 * vault to two writers (R03, R34, R40, R44, R49). The decision is the same one
 * either way; what changed is that a person makes it, out loud, once, and can
 * see what they are deciding about first.
 *
 * So the properties here are about the decision, not the mechanism: it will
 * not break a lock somebody is holding, it will not break a lock it cannot
 * check without being told to, and it cannot remove a lock that arrived while
 * it was deciding.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { STATE_DIR } from "./config.ts";
import { run } from "./cli.ts";
import { alive, lockPath, lockVault, midBreak, unlockVault, type Unlocked } from "./lock.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
afterEach(() => {
  midBreak.beforeTaking = async () => {};
  midBreak.taken = async () => {};
});

async function vault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trew-unlock-"));
  dirs.push(dir);
  return dir;
}

function deadPid(): number {
  for (let pid = 4_000_000; pid > 100; pid -= 7919) if (!alive(pid)) return pid;
  throw new Error("every pid on this machine is alive, which cannot be");
}

async function put(dir: string, holder: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, STATE_DIR), { recursive: true });
  await writeFile(lockPath(dir), JSON.stringify(holder));
}

const stale = () => ({
  pid: deadPid(),
  host: hostname(),
  command: "sync --watch",
  since: Date.now() - 1000,
  token: "a stale token",
});

describe("unlock", () => {
  it("returns a failure in JSON when an unlock finds competing holders", async () => {
    const dir = await vault();
    await put(dir, stale());
    midBreak.beforeTaking = async () => {
      await put(dir, {
        pid: process.pid,
        host: hostname(),
        command: "the holder that returned",
        since: Date.now(),
        token: "returned",
      });
    };
    let release: (() => Promise<void>) | undefined;
    midBreak.taken = async () => {
      release = await lockVault(dir, "the competing holder");
    };
    const out: string[] = [];
    try {
      const code = await run(["unlock", "--dir", dir, "--json"], {
        out: (line) => out.push(line),
        err: (line) => out.push(line),
      });
      const result = JSON.parse(out.join("\n")) as { ok: boolean; did: string; why: string };
      expect(result.did).toBe("contested");
      expect(result.why).toContain("stop both");
      expect(result.ok).toBe(false);
      expect(code).toBe(1);
      expect(JSON.parse(await readFile(lockPath(dir), "utf8")).command).toBe(
        "the competing holder",
      );
    } finally {
      await release?.();
    }
  });

  it("says so when there is nothing to clear", async () => {
    const out = await unlockVault(await vault());
    expect(out.did).toBe("nothing");
  });

  it("clears a lock whose holder is gone, and names who it was", async () => {
    const dir = await vault();
    const was = stale();
    await put(dir, was);

    const out = await unlockVault(dir);
    expect(out.did).toBe("removed");
    expect(out.why).toContain("sync --watch");
    expect(out.why).toContain(String(was.pid));
    // And the vault can be locked again, which is the whole point of it.
    await (
      await lockVault(dir, "sync")
    )();
  });

  it("refuses a lock whose holder is running", async () => {
    const dir = await vault();
    const release = await lockVault(dir, "sync --watch");

    const out = await unlockVault(dir);
    expect(out.did).toBe("refused");
    expect(out.why).toContain(String(process.pid));
    // Refused means the lock is still there and still theirs, not that it was
    // removed and something complained afterwards.
    const still = JSON.parse(await readFile(lockPath(dir), "utf8")) as { command: string };
    expect(still.command).toBe("sync --watch");
    await expect(lockVault(dir, "sync")).rejects.toThrow(/another trew/);
    await release();
  });

  it("refuses a lock held on another machine until it is told to", async () => {
    const dir = await vault();
    // A pid that is alive here, which says nothing at all about a process on
    // a different host. Believing it would be answering with the wrong
    // machine's facts.
    await put(dir, {
      pid: process.pid,
      host: `not-${hostname()}`,
      command: "sync --watch",
      since: Date.now(),
      token: "theirs",
    });

    const refused = await unlockVault(dir);
    expect(refused.did).toBe("refused");
    expect(refused.why).toContain("--force");

    const forced = await unlockVault(dir, true);
    expect(forced.did).toBe("removed");
    await (
      await lockVault(dir, "sync")
    )();
  });

  it("will not break a running local process, --force or not", async () => {
    // `--force` is for the one case this machine cannot check: a holder on
    // another host. A process running here is checkable, so there is nothing
    // to assert about it. The first version let --force through regardless,
    // which its own help text did not say, and which put the two-step read
    // and unlink in `lockVault`'s release back in reach of removing somebody
    // else's lock.
    const dir = await vault();
    const release = await lockVault(dir, "sync --watch");

    const out = await unlockVault(dir, true);
    expect(out.did).toBe("refused");
    expect(out.why).toContain("--force does not break");
    const still = JSON.parse(await readFile(lockPath(dir), "utf8")) as { command: string };
    expect(still.command).toBe("sync --watch");
    await release();
  });

  it("clears something at the path that names nobody", async () => {
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(lockPath(dir), "not a holder at all");

    const out = await unlockVault(dir);
    expect(out.did).toBe("removed");
    expect(out.why).toContain("named nobody");
    await (
      await lockVault(dir, "sync")
    )();
  });

  it("does not remove a lock that arrived while it was deciding", async () => {
    // The window that the five takeover attempts kept reopening, now in the
    // one place that still has it. `unlock` reads a dead holder, and before it
    // can act somebody legitimately takes the vault. Removing the file at that
    // point would hand the vault to whoever asks next while a live process
    // holds it, which is exactly the defect.
    const dir = await vault();
    await put(dir, stale());

    let release: (() => Promise<void>) | undefined;
    midBreak.taken = async () => {
      midBreak.taken = async () => {};
      release = await lockVault(dir, "sync");
    };

    const out = await unlockVault(dir);
    expect(release, "the competitor never took the lock, so nothing was tested").toBeDefined();
    expect(out.did).toBe("removed");

    // The stale one was cleared, and the live one is still there and still
    // theirs. `link` back is what makes this hold: had the aside been renamed
    // back it would have written over the new holder's lock.
    const now = JSON.parse(await readFile(lockPath(dir), "utf8")) as { command: string };
    expect(now.command, "the live holder's lock was written over").toBe("sync");
    await expect(lockVault(dir, "sync")).rejects.toThrow(/another trew/);
    await release!();
  });

  it("never takes a live holder's lock aside, even for an instant", async () => {
    // The window this command could open by itself. Moving a running holder's
    // lock out of the way, even to decide to put it back, leaves the vault
    // looking free, and a `trew sync` starting in that instant takes it
    // beside the holder: two writers on one vault, caused by the command whose
    // whole job is to stop that. So an ordinary refusal touches nothing.
    const dir = await vault();
    const release = await lockVault(dir, "sync --watch");

    let taken = false;
    midBreak.beforeTaking = async () => {
      taken = true;
    };
    const out = await unlockVault(dir);

    expect(out.did).toBe("refused");
    expect(taken, "a running holder's lock was taken aside to decide about it").toBe(false);
    await release();
  });

  it("does not write over a lock somebody took while it was deciding", async () => {
    // The residual race, and the only path on which the put-back happens: the
    // lock reads as abandoned, becomes held before the rename gets it, and a
    // third process takes the free name before it can go back.
    //
    // `link` is what makes this safe, and `rename` is what makes it the old
    // defect: the new holder's file would be replaced by the old holder's and
    // both would believe they hold the vault. Nothing else in this file
    // distinguishes the two, which a mutation showed by surviving.
    const dir = await vault();
    await put(dir, stale());

    const live = {
      pid: process.pid,
      host: hostname(),
      command: "the holder that came back",
      since: Date.now(),
      token: "live",
    };
    midBreak.beforeTaking = async () => {
      midBreak.beforeTaking = async () => {};
      await put(dir, live);
    };
    let release: (() => Promise<void>) | undefined;
    midBreak.taken = async () => {
      midBreak.taken = async () => {};
      release = await lockVault(dir, "sync");
    };

    const out = await unlockVault(dir);
    expect(release, "the competitor never took the lock, so nothing was tested").toBeDefined();

    // The competitor's lock is the one at the name, untouched.
    const now = JSON.parse(await readFile(lockPath(dir), "utf8")) as { command: string };
    expect(now.command, "the lock somebody else took was written over").toBe("sync");
    // And this is not reported as a tidy refusal, because it is not one: two
    // processes may hold this vault and only saying so gets them stopped.
    expect(out.did).toBe("contested");
    expect(out.why).toContain("stop both");
    await release!();
  });

  it("never lets two callers hold the vault, whatever unlock is doing", async () => {
    // RR1, the reviewer's schedule, using nothing but the public functions.
    //
    // U1 reads a lock whose holder is gone and pauses. U2 clears that same
    // stale lock, so the name is free and A takes the vault legitimately. U1
    // resumes and renames *A's* lock aside, freeing the name while A still
    // holds it, and B walks in. Two writers, and the `contested` U1 returns is
    // a report that arrives after both are already inside.
    //
    // The fix is upstream of all of it: two unlocks may not overlap. Nothing
    // else can make the lock file absent while one is deciding, because an
    // acquirer meets the occupied name and is refused, so excluding a second
    // unlock removes the only way into this schedule.
    //
    // The phase gate matters. Both unlocks run through the same module-level
    // seams, and without it U2 fires the hook meant for U1 and the schedule
    // tests something else that happens to pass.
    const dir = await vault();
    await put(dir, stale());

    const held: string[] = [];
    let phase: "paused" | "insideU2" | "resumed" = "paused";
    let u2: Unlocked | undefined;
    let a: (() => Promise<void>) | undefined;
    let b: (() => Promise<void>) | undefined;

    midBreak.beforeTaking = async () => {
      if (phase !== "paused") return;
      phase = "insideU2";
      u2 = await unlockVault(dir);
      a = await lockVault(dir, "writer A").catch(() => undefined);
      if (a !== undefined) held.push("A");
      phase = "resumed";
    };
    midBreak.taken = async () => {
      if (phase !== "resumed") return;
      b = await lockVault(dir, "writer B").catch(() => undefined);
      if (b !== undefined) held.push("B");
    };

    const u1 = await unlockVault(dir);

    // The schedule has to have been attempted, or this proves nothing.
    expect(u2, "the second unlock never ran, so the schedule was not exercised").toBeDefined();
    expect(phase, "the first unlock never reached its pause").toBe("resumed");
    expect(
      held.length,
      `${held.join(" and ")} were both admitted while the other still held the vault`,
    ).toBeLessThanOrEqual(1);
    // The second unlock is what has to be turned away, and it has to say why.
    expect(u2!.did).toBe("refused");
    expect(u2!.why).toContain("already running");

    // What U1 ends up doing depends on whether this platform has a kernel
    // exclusion, and both answers are right. Without one, A cannot get in
    // during U1's flight and U1 clears the abandoned lock: `removed`. With
    // one, A takes the vault legitimately the moment the file stops naming a
    // live holder, and U1 then finds a *live* lock in its hand and puts it
    // back: `refused`. What must be true either way is that the vault has at
    // most one holder and that whoever holds it still has their record.
    expect(["removed", "refused"]).toContain(u1.did);
    if (a !== undefined) {
      const now = JSON.parse(await readFile(lockPath(dir), "utf8")) as { command: string };
      expect(now.command, "the holder's lock was taken away underneath it").toBe("writer A");
    }

    for (const release of [a, b]) if (release !== undefined) await release();
  });

  it("hands a cleared vault to exactly one of many waiting callers", async () => {
    const dir = await vault();
    await put(dir, stale());
    await unlockVault(dir);

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => lockVault(dir, `after the unlock ${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  });
});
