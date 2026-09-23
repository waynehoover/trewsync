/**
 * Chunk boundaries Go cut, checked by this side's chunker (PLAN M0.5 task 5).
 *
 * `chunk-fixtures.json` carries two corpora, and each language checks the one
 * the other cut. Corpus B was cut by `ChunkBytes` in `internal/notes`; this
 * file regenerates every input and cuts it with `chunkBytes`, and every cut and
 * every chunk name has to match. That is the direction that matters here:
 * passing one's own vectors proves nothing. Go does the same with corpus A,
 * which `chunk-fixtures.run.ts` cuts on this side.
 *
 * The rest keeps the arrangement honest: corpus A is still what chunkBytes
 * cuts today, a corrupted vector fails, the corpus catches a chunker that is
 * wrong in plausible ways, and the two tables both languages share agree with
 * this side's `sizesFor` and `looksLikeText`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TEXT_EXTENSIONS, chunkBytes, looksLikeText, sizesFor } from "./chunk.ts";
import {
  CORPUS_A,
  CORPUS_A_HEADER,
  FIXTURE_PATH,
  canonical,
  checkEntry,
  computeEntry,
  readFixtures,
  type Chunker,
  type Entry,
} from "./chunk-fixtures.ts";

const text = readFileSync(FIXTURE_PATH, "utf8");
const fixtures = readFixtures();

describe("corpus B: cut by Go, checked here", () => {
  it("was cut by Go, and is large enough to be a contract", () => {
    expect(fixtures.corpusB.producedBy).toMatch(/^Go:/);
    expect(fixtures.corpusB.entries.length).toBeGreaterThanOrEqual(20);
  });

  for (const entry of fixtures.corpusB.entries) {
    it(entry.name, () => {
      expect(checkEntry(entry), entry.why).toEqual([]);
    });
  }
});

describe("corpus A: cut here, checked by Go", () => {
  // Go checks these cuts against its own. This keeps them the cuts chunkBytes
  // makes today, so that a change on this side reaches Go's check instead of
  // going stale in the file, and so that the file cannot be edited by hand to
  // agree with a broken Go.
  const regenerate = `stale: ${CORPUS_A_HEADER.regenerate}`;

  it("has the header and the cases the runner writes", () => {
    const { entries, ...header } = fixtures.corpusA;
    expect(header, regenerate).toEqual(CORPUS_A_HEADER);
    expect(
      entries.map((e) => e.name),
      regenerate,
    ).toEqual(CORPUS_A.map((d) => d.name));
  });

  CORPUS_A.forEach((def, i) => {
    it(`${def.name} is what chunkBytes cuts today`, () => {
      expect(fixtures.corpusA.entries[i], regenerate).toEqual(computeEntry(def));
    });
  });
});

describe("a corrupted vector", () => {
  const victim = fixtures.corpusB.entries.find(
    (e) => e.cuts.length >= 3 && "seed" in e.generator,
  ) as Entry;

  /** One hex digit of a name, changed. */
  const flip = (name: string) => ((parseInt(name[0]!, 16) + 1) % 16).toString(16) + name.slice(1);

  const corruptions: [string, (e: Entry) => Entry, string][] = [
    [
      "one expected offset a byte later",
      (e) => ({ ...e, cuts: e.cuts.map((c, i) => (i === 0 ? c + 1 : c)) }),
      "cut 0:",
    ],
    [
      "one expected offset a byte earlier",
      (e) => ({ ...e, cuts: e.cuts.map((c, i) => (i === 1 ? c - 1 : c)) }),
      "cut 1:",
    ],
    [
      "the last offset dropped",
      (e) => ({ ...e, cuts: e.cuts.slice(0, -1) }),
      "cuts in the fixture",
    ],
    [
      "one expected name changed",
      (e) => ({ ...e, names: e.names.map((n, i) => (i === 1 ? flip(n) : n)) }),
      "name 1:",
    ],
    [
      "the generator's seed changed",
      (e) => {
        const g = e.generator;
        if (!("seed" in g)) throw new Error("the victim has no seed");
        return { ...e, generator: { ...g, seed: `${g.seed}!` } };
      },
      "does not reproduce the input",
    ],
  ];

  it("starts out passing, so a failure below is the corruption's", () => {
    expect(victim, "corpus B has no entry with three chunks and a seed").toBeDefined();
    expect(checkEntry(victim)).toEqual([]);
  });

  for (const [what, corrupt, says] of corruptions) {
    it(`fails with ${what}, and says where`, () => {
      const problems = checkEntry(corrupt(victim));
      expect(problems.length, `${what} passed the check`).toBeGreaterThan(0);
      expect(problems.join("; ")).toContain(says);
      // The corruption was made on a copy.
      expect(checkEntry(victim)).toEqual([]);
    });
  }
});

describe("corpus B has teeth", () => {
  // The real chunker with one thing wrong. Go's test does the same for both
  // corpora with a rewrite of the loop, which can break things these cannot:
  // how the hash rolls, restarts and rewinds.
  const mutants: [string, Chunker][] = [
    ["a chunker that ignores UTF-8", (data, sizes) => chunkBytes(data, sizes, false)],
    ["a chunker that trims on the byte path too", (data, sizes) => chunkBytes(data, sizes, true)],
    [
      "a forced cut one byte late",
      (data, sizes, isUtf8) => chunkBytes(data, { ...sizes, max: sizes.max + 1 }, isUtf8),
    ],
    [
      "an average one larger",
      (data, sizes, isUtf8) => chunkBytes(data, { ...sizes, avg: sizes.avg + 1 }, isUtf8),
    ],
    [
      "a minimum one smaller",
      (data, sizes, isUtf8) => chunkBytes(data, { ...sizes, min: sizes.min - 1 }, isUtf8),
    ],
  ];

  for (const [what, mutant] of mutants) {
    it(`catches ${what}`, () => {
      const caught = fixtures.corpusB.entries.find((e) => checkEntry(e, mutant).length > 0);
      expect(caught, `nothing in corpus B catches ${what}`).toBeDefined();
    });
  }
});

describe("sizesForV1: the protocol 1 rule, which sizesFor and Go's SizesFor both implement", () => {
  // Checked against sizesFor as it is, with nothing handed back: the ceiling
  // bounds raw bytes and nothing is reserved below it (PLAN M2 task 2). A
  // ceiling of 0 or less is passed through too, because standing for the
  // server not having said is part of the rule and sizesFor's own business.
  it("has cases to check", () => {
    expect(fixtures.sizesForV1.cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of fixtures.sizesForV1.cases) {
    it(c.name, () => {
      expect(sizesFor(c.size, c.isText, c.serverChunkMax)).toEqual(c.expected);
    });
  }
});

describe("isTextPath: looksLikeText here, IsTextPath in Go", () => {
  it("lists the extensions TEXT_EXTENSIONS does", () => {
    expect([...TEXT_EXTENSIONS].sort()).toEqual([...fixtures.isTextPath.textExtensions].sort());
  });

  for (const c of fixtures.isTextPath.cases) {
    it(`${JSON.stringify(c.path)} is ${c.isText ? "text" : "not text"}`, () => {
      expect(looksLikeText(c.path)).toBe(c.isText);
    });
  }
});

describe("the fixture file", () => {
  it("is in the one format both writers produce", () => {
    // Go's writer is held to this too: a run of its -update that formatted
    // differently fails here, before it turns every regeneration into a diff
    // of the whole file.
    expect(text === canonical(JSON.parse(text)), `reformat: ${CORPUS_A_HEADER.regenerate}`).toBe(
      true,
    );
  });
});
