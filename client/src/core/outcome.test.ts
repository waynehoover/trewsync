/**
 * The vocabulary itself, and the property it exists for (I04).
 *
 * The same pass has to reach the same conclusion whoever is asking. Before
 * this the CLI's exit code counted three fields, the panel's glyph counted
 * two others, the JSON `ok` was hardcoded, and a restore read "sent" off a
 * resolved promise. Four readings of one report, each defensible alone.
 */

import { describe, expect, it } from "vitest";

import { combinePasses } from "./engine.ts";
import type { SyncReport } from "./engine.ts";
import { describeOutcome, exitCodeOf, outcomeOf } from "./outcome.ts";

function report(over: Partial<SyncReport> = {}): SyncReport {
  return {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    conflicted: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
    restored: 0,
    foldersCreated: 0,
    foldersDeletedLocally: 0,
    foldersDeletedRemotely: 0,
    unchanged: 0,
    waiting: 0,
    retrying: 0,
    skipped: 0,
    skippedPaths: [],
    retryingPaths: [],
    ignored: 0,
    blocked: 0,
    inTheWay: [],
    needsAttention: [],
    chunksSent: 0,
    bytesSent: 0,
    ...over,
  } as SyncReport;
}

describe("what a pass came to", () => {
  it("names each outcome, and orders them by what it costs to be wrong", () => {
    expect(outcomeOf(report()).kind).toBe("synced");
    expect(outcomeOf(report({ conflicted: 2 })).kind).toBe("conflicted");
    expect(outcomeOf(report({ skipped: 1, skippedPaths: ["a.md"] })).kind).toBe("refused");
    expect(
      outcomeOf(report({ blocked: 1, inTheWay: [{ path: "b.md", blockedBy: "B.md" }] })).kind,
    ).toBe("refused");
    expect(outcomeOf(report({ retrying: 1, retryingPaths: ["c.md"] })).kind).toBe("retrying");
    expect(outcomeOf(undefined, { why: "the index will not save" }).kind).toBe("passFailed");
    expect(outcomeOf(undefined, { why: "no route to host", offline: true }).kind).toBe("offline");

    // A pass can be several at once, and something has to choose. Retrying
    // outranks refused: telling somebody to go and fix a file while the vault
    // is about to fix it itself is the worse mistake.
    const both = report({
      retrying: 1,
      retryingPaths: ["c.md"],
      skipped: 1,
      skippedPaths: ["a.md"],
      conflicted: 3,
    });
    expect(outcomeOf(both).kind).toBe("retrying");
  });

  it("gives a conflict a zero exit, because keeping both is the engine working", () => {
    expect(exitCodeOf(outcomeOf(report({ conflicted: 4 })))).toBe(0);
    expect(exitCodeOf(outcomeOf(report()))).toBe(0);
    for (const bad of [
      report({ retrying: 1, retryingPaths: ["c.md"] }),
      report({ skipped: 1, skippedPaths: ["a.md"] }),
      report({ blocked: 1, inTheWay: [{ path: "b.md", blockedBy: "B.md" }] }),
    ]) {
      expect(exitCodeOf(outcomeOf(bad)), JSON.stringify(bad)).toBe(1);
    }
    expect(exitCodeOf(outcomeOf(undefined, { why: "gone" }))).toBe(1);
  });

  it("keeps a known hidden version distinct from visible conflict copies", () => {
    const at = ".trew/tmp/preserved.edit";
    const recovery = { complete: true, waiting: [{ at }] };
    const outcome = outcomeOf(report({ conflicted: 1 }), undefined, recovery);
    expect(outcome).toEqual({ kind: "recoveryNeeded", paths: [at] });
    expect(exitCodeOf(outcome)).toBe(1);
    expect(describeOutcome(outcome)).toContain("needs recovery");
    expect(outcomeOf(report(), undefined, undefined, [at])).toEqual(outcome);
    expect(
      exitCodeOf(outcomeOf(report({ conflicted: 1 }), undefined, { complete: true, waiting: [] })),
    ).toBe(0);
  });

  it("says which paths, because a count is not something anybody can act on", () => {
    expect(describeOutcome(outcomeOf(report({ retrying: 1, retryingPaths: ["c.md"] })))).toContain(
      "c.md",
    );
    expect(describeOutcome(outcomeOf(report({ skipped: 1, skippedPaths: ["a.md"] })))).toContain(
      "a.md",
    );
  });

  /**
   * Combining passes must not change the conclusion into one neither pass
   * reached. `settle` runs several and adds them up, and the outcome of the
   * total is what both shells report.
   */
  it("keeps a combined pass honest about the worst thing in it", () => {
    const clean = report({ uploaded: 2 });
    const stuck = report({ retrying: 1, retryingPaths: ["c.md"] });
    expect(outcomeOf(combinePasses(clean, stuck)).kind).toBe("retrying");
    expect(exitCodeOf(outcomeOf(combinePasses(clean, stuck)))).toBe(1);
  });
});
