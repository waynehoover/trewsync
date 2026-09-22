/**
 * A merge cannot take longer than a person will wait (I08).
 *
 * The merge is synchronous and runs on Obsidian's UI thread, and the line diff
 * inside it is quadratic. Measured in bench-merge.ts on the shape two devices
 * produce most often, both having edited the same note in places spread through
 * it: 45 ms at a thousand lines, 1.2 seconds at five thousand, 23 seconds at
 * twenty thousand. A 1.8 MiB note is nothing more remarkable than long.
 *
 * Nothing in the suite could see it. Every other merge test is a handful of
 * lines, where quadratic and linear are the same number, so the cost was
 * invisible in six hundred passing tests and would have stayed invisible until
 * somebody's editor stopped responding for half a minute.
 *
 * The bound is on work rather than on time, which is what the tests below are
 * mostly about: a clock-based limit would make two devices with identical
 * inputs compute different merges, and that is worse than slow.
 */

import { describe, expect, it } from "vitest";

import { mergeText } from "./merge.ts";
import { regions } from "./merge-regions.ts";

/**
 * The expensive shape: both sides changed alternating lines, so neither side's
 * changes are contiguous and there is nothing for the diff to trim.
 */
function interleaved(lines: number): { base: string; mine: string; theirs: string } {
  const base: string[] = [];
  const mine: string[] = [];
  const theirs: string[] = [];
  for (let i = 0; i < lines; i++) {
    const line = `Paragraph ${i}: a sentence with enough words to look like prose.`;
    base.push(line);
    mine.push(i % 2 === 0 ? `${line} Mine.` : line);
    theirs.push(i % 2 === 1 ? `${line} Theirs.` : line);
  }
  return { base: base.join("\n"), mine: mine.join("\n"), theirs: theirs.join("\n") };
}

describe("a merge that would cost too much", () => {
  /**
   * The ceiling is loose on purpose. What it has to separate is 38 ms from 23
   * seconds, and any number between those does that; a tight one would fail on
   * a loaded CI runner and teach somebody to raise it. Twenty thousand lines
   * took 23 seconds before this bound and takes about 40 ms after it.
   */
  it("finishes in well under a second on a note that used to take twenty-three", () => {
    const { base, mine, theirs } = interleaved(20_000);
    const started = performance.now();
    const outcome = mergeText(base, mine, theirs);
    const took = performance.now() - started;

    expect(
      took,
      `the merge took ${took.toFixed(0)}ms, which is an editor that has stopped responding`,
    ).toBeLessThan(2000);
    // Not asserted as a merge: above the budget this keeps both versions, which
    // is the trade the bound makes and is stated where the bound is.
    expect(["conflict", "merged", "take"]).toContain(outcome.kind);
  });

  it("keeps both versions rather than losing one, when it refuses", () => {
    const { base, mine, theirs } = interleaved(20_000);
    const outcome = mergeText(base, mine, theirs);
    // Rule 1. A refusal is only acceptable because nothing is thrown away: the
    // caller writes a conflict copy, and both texts are still on the disk.
    expect(outcome.kind, "a note this size was silently merged after all").toBe("conflict");
    expect(outcome.kind === "conflict" ? outcome.why : "").toBeTruthy();
  });

  /**
   * The reason the bound counts work and not milliseconds.
   *
   * A deadline would make the answer depend on how busy the machine was when it
   * was asked. Two devices merging the same three texts would then be able to
   * produce different files, both of them "correct", and the vault would
   * diverge with nothing to say it had. This asserts the property that rules
   * that out: same input, same answer, every time.
   */
  it("gives the same answer every time, because the limit is not a clock", () => {
    const { base, mine, theirs } = interleaved(6000);
    const first = mergeText(base, mine, theirs);
    for (let i = 0; i < 5; i++) {
      const again = mergeText(base, mine, theirs);
      expect(again.kind, "the same three texts merged two different ways").toBe(first.kind);
      const textOf = (o: typeof first): string | undefined =>
        o.kind === "merged" || o.kind === "take" ? o.text : undefined;
      expect(textOf(again), "the same three texts produced two different files").toBe(
        textOf(first),
      );
    }
  });

  it("refuses at the region level, which is where the cost is", () => {
    const { base, mine, theirs } = interleaved(20_000);
    // `undefined` is how merge.ts is told to use the character merge instead.
    // Asserted here as well as through mergeText so that a change which makes
    // the line path cheap again is a deliberate one.
    expect(regions(base, mine, theirs)).toBeUndefined();
  });
});

describe("what the bound must not break", () => {
  it("still merges a note that is long but not tangled", () => {
    // 50,000 lines, one paragraph changed on each side, far apart. The common
    // ends are trimmed before the cost is estimated, so this is cheap however
    // large the note is, and refusing it would be the bound overreaching.
    const lines = Array.from({ length: 50_000 }, (_, i) => `Line ${i} of a long note.`);
    const base = lines.join("\n");
    const mineLines = lines.slice();
    mineLines[100] = "Line 100, as I rewrote it.";
    const theirLines = lines.slice();
    theirLines[40_000] = "Line 40000, as they rewrote it.";

    const started = performance.now();
    const outcome = mergeText(base, mineLines.join("\n"), theirLines.join("\n"));
    const took = performance.now() - started;

    expect(
      outcome.kind,
      `a long note with two small edits was refused: ${JSON.stringify(outcome).slice(0, 200)}`,
    ).toBe("merged");
    expect(outcome.kind === "merged" ? outcome.text : "").toContain("as I rewrote it");
    expect(outcome.kind === "merged" ? outcome.text : "").toContain("as they rewrote it");
    expect(took, `${took.toFixed(0)}ms for two small edits in a long note`).toBeLessThan(2000);
  });

  it("still merges a tangled note that is small enough to afford", () => {
    const { base, mine, theirs } = interleaved(500);
    const outcome = mergeText(base, mine, theirs);
    expect(outcome.kind, "an ordinary two-device edit was refused").toBe("merged");
    const text = outcome.kind === "merged" ? outcome.text : "";
    expect(text, "one side's edits were dropped").toContain("Mine.");
    expect(text, "the other side's edits were dropped").toContain("Theirs.");
  });
});
