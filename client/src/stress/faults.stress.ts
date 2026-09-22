/**
 * Every destructive path, at every seam, with somebody saving into it.
 *
 * These scenarios are ordinary: a note is being replaced by a download, or
 * deleted because another device deleted it, or renamed because this disk
 * spells it in NFD. In each one a person saves the note while it happens.
 *
 * What is not ordinary is that each runs at every seam the client has, so the
 * question is no longer "does the ordering somebody wrote a test for still
 * work" but "is there an ordering that loses the save". See `faults.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { releaseAllSeams, seams } from "../core/seam.ts";
import { crashSweep, losses, permute, sweep } from "./faults.ts";
import { SCENARIOS } from "./fault-scenarios.ts";
// Imported for their seams: a seam is only in the registry once its module
// has been loaded, so the driver's coverage is exactly what is imported here
// and by the scenarios (see `seams`).
import "../cli/vault.ts";
import "../cli/lock.ts";

afterEach(() => releaseAllSeams());

/**
 * Which seams these scenarios actually reach, written down and checked.
 *
 * Registering a seam does not mean a scenario reaches it, and the count of
 * registered seams was quoted as though it did (RR4). Six of twelve were being
 * reached, which is a fine number to have and a bad one to leave unstated: a
 * scenario that quietly stops reaching a seam looks exactly like a scenario
 * that passes.
 *
 * So this is the claim, exactly. Reaching more than it says is as much a
 * failure as reaching less: it means somebody moved a seam and did not say so.
 */
const REACHES: Record<string, readonly string[]> = {
  "a download lands on a note being saved": [
    "cli/vault:replace.staged",
    "cli/vault:replace.nameFree",
  ],
  "a deletion arrives for a note being saved": ["cli/vault:trash.parked"],
  "a superseded name is retired while it is saved": [
    "cli/vault:respell",
    "cli/vault:respell.parked",
  ],
  "a retired name turns out to hold somebody else's file": [
    "cli/vault:respell",
    "cli/vault:respell.beforeGivingBack",
    "cli/vault:respell.parked",
  ],
  "a note appears where a displaced version is going": [
    "cli/vault:preserve.beforeClaim",
    "cli/vault:replace.staged",
    "cli/vault:replace.nameFree",
  ],
  "a displaced version has nowhere to go": [
    "cli/vault:preserve.beforeClaim",
    "cli/vault:replace.staged",
    "cli/vault:replace.nameFree",
  ],
};

/**
 * The seams no scenario here reaches, each with the reason.
 *
 * Not an apology: two of them cannot be reached on this machine at all, and
 * saying which is the difference between a gap somebody can weigh and a number
 * somebody has to go and measure.
 */
const UNREACHED: Record<string, string> = {
  "cli/lock:publish": "the lock is exclusion rather than bytes; see the ownership suite",
  "cli/lock:break.beforeTaking": "as above",
  "cli/lock:break.taken": "as above",
  "cli/vault:trash":
    "the cross-filesystem trash path, which needs the trash on its own mount and so runs " +
    "only in CI",
  "cli/vault:trash.afterCompare": "as above",
};

describe("a save landing inside a destructive operation", () => {
  // Not a scenario: a guard. A driver that has loaded no seams reports every
  // permutation as passing, and would go on doing so for ever.
  it("has seams to run against", () => {
    expect(seams().length).toBeGreaterThanOrEqual(12);
  });

  it("reaches exactly the seams it says it reaches", async () => {
    const named = new Set([...Object.keys(UNREACHED), ...Object.values(REACHES).flat()]);
    expect(
      [...seams()].map((s) => s.name).filter((n) => !named.has(n)),
      "a seam exists that this matrix does not account for, reached or not",
    ).toEqual([]);

    for (const scenario of SCENARIOS) {
      const reached: string[] = [];
      for (const it of seams()) {
        const out = await permute(scenario, it);
        releaseAllSeams();
        if (out.fired) reached.push(it.name);
      }
      expect(reached.sort(), `${scenario.name} reaches a different set of seams`).toEqual(
        [...(REACHES[scenario.name] ?? [])].sort(),
      );
    }
  }, 300_000);

  for (const scenario of SCENARIOS) {
    it(`survives it: ${scenario.name}`, async () => {
      const outcomes = await sweep(scenario);
      const reached = outcomes.filter((o) => o.fired);
      expect(reached.length, "no seam was reached, so nothing was tested").toBeGreaterThan(0);
      expect(losses(outcomes)).toEqual([]);
    }, 120_000);
  }
});

describe("a process killed inside a destructive operation", () => {
  // Every seam, not a chosen few: the whole point is that nobody picks.
  for (const scenario of SCENARIOS) {
    it(`leaves both versions findable: ${scenario.name}`, async () => {
      const outcomes = [];
      for (const it of seams()) outcomes.push(await crashSweep(scenario, it.name));
      expect(
        outcomes.filter((o) => o.fired).length,
        "no seam was reached in any child, so nothing was tested",
      ).toBeGreaterThan(0);
      expect(losses(outcomes)).toEqual([]);
    }, 600_000);
  }
});
