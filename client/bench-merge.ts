/**
 * What a merge costs on text designed to be hard (I08).
 *
 * `bun run bench:merge`, or `BENCH_NODE=1` for the runtime the plugin runs in.
 *
 * The merge is synchronous and it runs on Obsidian's UI thread. `mergeText`
 * refuses a time limit on purpose, and the reason is good: which regions exist
 * would otherwise depend on the clock, so two devices with the same three texts
 * could compute different results and neither would be wrong. A sync engine
 * cannot have that. Given that, the only remaining question is whether the
 * unbounded work is ever long enough to be felt, and that is a measurement
 * rather than an argument.
 *
 * Adversarial shapes rather than random text. Random text diffs quickly:
 * nothing matches, so the algorithm gives up early and reports one big change.
 * The expensive inputs are the ones that almost match, where a line diff has
 * many candidate alignments to consider, and those are also what a real note
 * looks like after two people have edited it. Every shape here is one a vault
 * actually produces.
 *
 *   interleaved      the two sides changed alternating lines. The worst
 *                    realistic case for a line diff and the commonest merge.
 *   nearly identical every line differs from its neighbours by one character,
 *                    which is a table, a changelog, or a list of dates.
 *   rewritten        one side rewrote the whole thing. Little to align.
 *   one long line    no line structure at all, so this falls through to the
 *                    character merge, which is the quadratic one.
 *   many lines       up against the 65,535-line encoding ceiling, where the
 *                    line path gives up and the character path takes over.
 *   duplicated       the same paragraph many times over, so every line has
 *                    many equally good matches. This is the shape that makes
 *                    diff-match-patch work hardest for its size.
 *
 * Reported, not asserted, for the reason bench.ts gives: the numbers move by
 * more than an order of magnitude between JavaScriptCore and V8, and a floor
 * loose enough to survive both would catch nothing. What this is for is
 * deciding whether I08 needs doing.
 *
 * A frame is 16ms. The column that matters is how many of those a merge takes,
 * because that is the number somebody feels.
 */

import { cpus } from "node:os";

import { mergeText, mergeTextCharacters } from "./src/core/merge.ts";

const REPEATS = Number(process.env["BENCH_REPEATS"] ?? 5);

interface Shape {
  readonly name: string;
  readonly make: (n: number) => { base: string; mine: string; theirs: string };
  /** Sizes in lines, or in characters where the shape has no lines. */
  readonly sizes: readonly number[];
  readonly unit: string;
}

const para = (i: number): string =>
  `Paragraph ${i}: a sentence with enough words in it to look like prose rather than filler.`;

const SHAPES: Shape[] = [
  {
    name: "interleaved edits",
    unit: "lines",
    sizes: [200, 1000, 5000, 20000],
    make: (n) => {
      const base: string[] = [];
      const mine: string[] = [];
      const theirs: string[] = [];
      for (let i = 0; i < n; i++) {
        base.push(para(i));
        // Alternating ownership, so neither side's changes are contiguous and
        // the diff cannot collapse them into one hunk.
        mine.push(i % 2 === 0 ? para(i) + " Mine." : para(i));
        theirs.push(i % 2 === 1 ? para(i) + " Theirs." : para(i));
      }
      return { base: base.join("\n"), mine: mine.join("\n"), theirs: theirs.join("\n") };
    },
  },
  {
    name: "nearly identical lines",
    unit: "lines",
    sizes: [200, 1000, 5000, 20000],
    make: (n) => {
      // A changelog or a table: every line differs from the next by a digit.
      const line = (i: number) =>
        `| 2026-01-${String((i % 28) + 1).padStart(2, "0")} | row ${i} | ok |`;
      const base = Array.from({ length: n }, (_, i) => line(i));
      const mine = base.slice();
      const theirs = base.slice();
      mine[Math.floor(n / 3)] = `| 2026-01-01 | row edited by me | ok |`;
      theirs[Math.floor((2 * n) / 3)] = `| 2026-01-01 | row edited by them | ok |`;
      return { base: base.join("\n"), mine: mine.join("\n"), theirs: theirs.join("\n") };
    },
  },
  {
    name: "duplicated paragraphs",
    unit: "lines",
    sizes: [200, 1000, 5000, 20000],
    make: (n) => {
      // Every line has many equally good matches, which is the input a line
      // diff has the most work to do on for its size.
      const base = Array.from({ length: n }, (_, i) => para(i % 8));
      const mine = base.slice();
      const theirs = base.slice();
      mine.splice(Math.floor(n / 2), 0, "A line only I added.");
      theirs.splice(Math.floor(n / 2), 0, "A line only they added.");
      return { base: base.join("\n"), mine: mine.join("\n"), theirs: theirs.join("\n") };
    },
  },
  {
    name: "one side rewrote it",
    unit: "lines",
    sizes: [200, 1000, 5000, 20000],
    make: (n) => {
      const base = Array.from({ length: n }, (_, i) => para(i)).join("\n");
      const mine = Array.from(
        { length: n },
        (_, i) => `Rewritten line ${i}, nothing like the last.`,
      ).join("\n");
      const theirs = base + "\nOne line appended at the end.";
      return { base, mine, theirs };
    },
  },
  {
    name: "no line structure",
    unit: "chars",
    sizes: [2000, 8000, 32000, 128000],
    make: (n) => {
      // A note saved as one paragraph, which several editors produce and which
      // has no lines for the line path to work with, so this measures the
      // character merge directly.
      const base = "word ".repeat(Math.floor(n / 5)).trim();
      const mine = base.replace(/^word word/, "WORD word") + " mine";
      const theirs = "theirs " + base;
      return { base, mine, theirs };
    },
  },
];

function median(times: number[]): number {
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

function time(run: () => void): number {
  run();
  run();
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const t = performance.now();
    run();
    times.push(performance.now() - t);
  }
  return median(times);
}

function main(): void {
  console.log("telimus: what a merge costs on text built to be hard");
  console.log(`  ${cpus()[0]?.model ?? "unknown cpu"}, ${cpus().length} cores`);
  console.log(
    `  ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.version}`,
  );
  console.log(`  median of ${REPEATS}, after two warm-up runs. A frame is 16ms.`);

  let worst = 0;
  let worstName = "";
  for (const shape of SHAPES) {
    console.log(`\n  ${shape.name}`);
    console.log(
      `    ${shape.unit.padStart(8)} ${"KiB".padStart(7)} ${"ms".padStart(9)} ${"vs prev".padStart(8)} ${"frames".padStart(7)}  outcome`,
    );
    let prev: number | undefined;
    for (const n of shape.sizes) {
      const { base, mine, theirs } = shape.make(n);
      let outcome = "";
      const ms = time(() => {
        const r = mergeText(base, mine, theirs);
        outcome = r.kind;
      });
      const ratio = prev === undefined ? "" : `${(ms / prev).toFixed(2)}x`;
      const kib = (Math.max(base.length, mine.length, theirs.length) / 1024).toFixed(0);
      console.log(
        `    ${String(n).padStart(8)} ${kib.padStart(7)} ${ms.toFixed(1).padStart(9)} ${ratio.padStart(8)} ${(ms / 16).toFixed(1).padStart(7)}  ${outcome}`,
      );
      if (ms > worst) {
        worst = ms;
        worstName = `${shape.name} at ${n} ${shape.unit}`;
      }
      prev = ms;
    }
  }

  // The character merge on its own, because the line path falls back to it and
  // a slow fallback is invisible in the numbers above until it is reached.
  console.log(`\n  the character merge, reached directly`);
  console.log(
    `    ${"chars".padStart(8)} ${"ms".padStart(9)} ${"vs prev".padStart(8)} ${"frames".padStart(7)}`,
  );
  let prev: number | undefined;
  for (const n of [2000, 8000, 32000, 128000]) {
    const base = "word ".repeat(Math.floor(n / 5)).trim();
    const mine = base + " mine";
    const theirs = "theirs " + base;
    const ms = time(() => {
      mergeTextCharacters(base, mine, theirs);
    });
    const ratio = prev === undefined ? "" : `${(ms / prev).toFixed(2)}x`;
    console.log(
      `    ${String(n).padStart(8)} ${ms.toFixed(1).padStart(9)} ${ratio.padStart(8)} ${(ms / 16).toFixed(1).padStart(7)}`,
    );
    if (ms > worst) {
      worst = ms;
      worstName = `the character merge at ${n} chars`;
    }
    prev = ms;
  }

  console.log(`
  Worst: ${worst.toFixed(0)}ms, ${worstName}, which is ${(worst / 16).toFixed(0)} frames.

  Sizes go up 5x, then 4x, then 4x, so a ratio near those is linear in the size
  and anything much above them is not. What I08 turns on is the worst figure
  above: a merge is synchronous and on the UI thread, so that number is how long
  Obsidian is unresponsive for when two devices edited the same note.`);
}

main();
