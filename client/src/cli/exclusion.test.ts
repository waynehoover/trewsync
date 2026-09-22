/**
 * The check that the kernel's exclusion is really excluding.
 *
 * `scripts/kernel-lock.test.ts` exercises the real mechanisms against real
 * processes, and on a machine where they work it cannot tell a self-test that
 * is doing its job from one that returns `true` unconditionally: both look
 * identical. The case that matters is a filesystem which accepts `O_EXLOCK`
 * and ignores it, which is what a network mount may do, and which no test here
 * can mount.
 *
 * So the self-test is checked against mechanisms built to lie. That is the
 * whole of this file, and it is worth having because everything above treats
 * "I hold the exclusion" as proof that no other telimus is inside the vault: a
 * mechanism that reports success without excluding would have this client
 * write over a live holder's record.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BUSY, forgetProven, mechanismFor, provenFor, selfTest } from "./exclusion.ts";
import type { Exclusion, Mechanism } from "./exclusion.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "telimus-exclusion-"));
  dirs.push(dir);
  return dir;
}

const nothing: Exclusion = { how: "pretend", release: async () => {} };

/** Says yes to everybody, which is the failure that would matter. */
const alwaysYes: Mechanism = { how: "pretend", take: async () => nothing };

/** Refuses even the first caller, which is a mechanism that cannot be used. */
const alwaysBusy: Mechanism = { how: "pretend", take: async () => BUSY };

/** Throws, which is what a read-only or unsupported filesystem does. */
const alwaysThrows: Mechanism = {
  how: "pretend",
  take: async () => {
    throw new Error("EROFS: read-only file system");
  },
};

/** Excludes properly, for the case that should pass. */
function honest(): Mechanism {
  const taken = new Set<string>();
  return {
    how: "pretend",
    take: async (vault) => {
      if (taken.has(vault)) return BUSY;
      taken.add(vault);
      return { how: "pretend", release: async () => void taken.delete(vault) };
    },
  };
}

describe("proving the exclusion excludes", () => {
  it("fails a mechanism that hands the same thing to two callers", async () => {
    expect(await selfTest(alwaysYes, await stateDir())).toBe(false);
  });

  it("fails a mechanism that refuses everybody", async () => {
    // Not usable either, and telling the two apart is not worth a code path:
    // both mean this client falls back to the file.
    expect(await selfTest(alwaysBusy, await stateDir())).toBe(false);
  });

  it("fails a mechanism that throws, rather than letting the error escape", async () => {
    // A read-only filesystem is a fallback, not a crash. Taking the vault lock
    // is the first thing every writing command does, so an exception here
    // would replace every error message the CLI has with a stack.
    await expect(selfTest(alwaysThrows, await stateDir())).resolves.toBe(false);
  });

  it("passes one that really excludes", async () => {
    expect(await selfTest(honest(), await stateDir())).toBe(true);
  });

  it("does not report a filesystem's failure as another's", async () => {
    // The answer is about one state folder, so two vaults on different
    // filesystems must not share it. The cache is keyed on both, and keying it
    // on the mechanism alone would have one vault's network mount silently
    // decide the question for every other vault on the machine.
    forgetProven();
    const good = await stateDir();
    expect(await provenFor(honest(), good)).toBe(true);
    expect(await provenFor(alwaysYes, await stateDir())).toBe(false);
    forgetProven();
  });

  it("asks once per state folder, however many callers there are", async () => {
    // Concurrent acquisitions used to each run their own probe against a name
    // derived from the pid, so they collided, decided the filesystem does not
    // lock, and all fell back to the file. Two of them then held one vault.
    forgetProven();
    let probes = 0;
    const counted: Mechanism = {
      how: "pretend",
      take: async (vault) => {
        probes++;
        return await honestShared.take(vault, "");
      },
    };
    const honestShared = honest();
    const dir = await stateDir();
    const answers = await Promise.all(Array.from({ length: 8 }, () => provenFor(counted, dir)));
    expect(answers).toEqual(Array.from({ length: 8 }, () => true));
    // Two takes for one probe: the first, and the second that must be refused.
    expect(probes, `eight callers ran ${probes / 2} probes rather than one`).toBe(2);
    forgetProven();
  });

  it("names a mechanism for this platform, or says there is none", () => {
    // Not an assertion about which: macOS and Linux have one, and anything
    // else falls back to the file, which is a supported way to run.
    const m = mechanismFor();
    expect(m === undefined || typeof m.how === "string").toBe(true);
    expect(mechanismFor("plan9")).toBeUndefined();
  });
});
