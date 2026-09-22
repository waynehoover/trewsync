/**
 * Chunk boundaries, pinned across the language boundary (PLAN M0.5 task 5).
 *
 * The Go server gets its own content-defined chunker, `internal/notes`, because
 * the MCP write tools chunk note bodies on the server. A chunk's name is the
 * SHA-256 of its raw bytes, so every cut Go makes has to land on the byte this
 * file's `chunkBytes` lands on. One byte off and the server and a device store
 * the same note as different chunks, and nothing says so: both sides still
 * converge, they just stop deduplicating against each other.
 *
 * `chunk-fixtures.json` at the repository root is how the two are held
 * together, and each language checks the other's work rather than its own:
 *
 * - corpus A is defined below, cut by `chunkBytes` and written by
 *   `chunk-fixtures.run.ts`; Go regenerates each input and checks its cuts.
 * - corpus B is defined in `internal/notes`, cut by Go and written by
 *   `go test ./internal/notes -run TestChunkFixtures -update`;
 *   `chunk-fixtures.test.ts` regenerates each input and checks these cuts.
 *
 * An entry describes its input with a deterministic generator instead of
 * carrying the bytes, which keeps the file small enough to read, and records
 * the input's SHA-256 so that two generators disagreeing is reported as that
 * and not as a chunker bug.
 *
 * Imported only by the fixture test and the runner, like compression-golden.ts,
 * so none of this reaches a shipped bundle; that is also why it may use
 * `node:crypto` and `node:fs`.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BINARY_SIZES,
  TEXT_SIZES,
  chunkBytes,
  textSizesFor,
  type Chunk,
  type ChunkSizes,
} from "./chunk.ts";

/** The fixture file, at the repository root beside `protocol-fixtures.json`. */
export const FIXTURE_PATH = join(import.meta.dirname, "..", "..", "..", "chunk-fixtures.json");

/**
 * How an entry's input is made. The `generators` section of the fixture file
 * says the same in prose; `internal/notes` implements each kind again, and an
 * entry's `inputSha256` is what shows the two agree.
 */
export type Generator =
  /** SHA-256(utf8(seed) || uint32 big-endian counter), counter 0, 1, 2, ..., truncated. */
  | { kind: "sha256-ctr"; length: number; seed: string }
  /** utf8(text) repeated and truncated to length, which may cut a character. */
  | { kind: "repeat"; length: number; text: string }
  /** The bytes of hex repeated and truncated, for input that is not UTF-8 at all. */
  | { kind: "repeat"; length: number; hex: string }
  /** Pieces drawn with two bytes of the seed's sha256-ctr stream per draw. */
  | { kind: "mixed"; length: number; seed: string; pieces: string[] };

/** One fixture entry: an input, how to cut it, and where it is cut. */
export interface Entry {
  name: string;
  why: string;
  generator: Generator;
  sizes: ChunkSizes;
  isUtf8: boolean;
  inputSha256: string;
  /** The end offset of every chunk, in order. The last is the input's length. */
  cuts: number[];
  /** The lowercase hex SHA-256 of every chunk's bytes. */
  names: string[];
}

/** One direction's worth of entries, with who cut them and who checks them. */
export interface Corpus {
  producedBy: string;
  regenerate: string;
  checkedBy: string;
  entries: Entry[];
}

/** One case of the protocol 1 `sizesFor` rule, written by hand. */
export interface SizesForCase {
  name: string;
  size: number;
  isText: boolean;
  serverChunkMax: number;
  expected: ChunkSizes;
}

/** The parts of `chunk-fixtures.json` the tests read. */
export interface FixtureFile {
  corpusA: Corpus;
  corpusB: Corpus;
  sizesForV1: { note: string[]; cases: SizesForCase[] };
  isTextPath: {
    note: string[];
    textExtensions: string[];
    cases: { path: string; isText: boolean }[];
  };
}

/** Anything shaped like `chunkBytes`, so a test can hand the checker a broken one. */
export type Chunker = (data: Uint8Array, sizes: ChunkSizes, isUtf8: boolean) => Iterable<Chunk>;

const enc = new TextEncoder();

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The sha256-ctr stream: SHA-256 of the seed followed by a big-endian 32-bit
 * counter, one 32-byte block per counter value, read in order.
 */
class Sha256Ctr {
  private readonly input: Uint8Array;
  private readonly view: DataView;
  private counter = 0;
  private block: Uint8Array = new Uint8Array(0);
  private at = 0;

  constructor(seed: Uint8Array) {
    this.input = new Uint8Array(seed.length + 4);
    this.input.set(seed);
    this.view = new DataView(this.input.buffer);
  }

  private refill(): void {
    // DataView writes big-endian unless told otherwise.
    this.view.setUint32(this.input.length - 4, this.counter++);
    this.block = createHash("sha256").update(this.input).digest();
    this.at = 0;
  }

  /** The next byte. */
  byte(): number {
    if (this.at === this.block.length) this.refill();
    return this.block[this.at++]!;
  }

  /** The next `out.length` bytes, into `out`. */
  fill(out: Uint8Array): void {
    let at = 0;
    while (at < out.length) {
      if (this.at === this.block.length) this.refill();
      const n = Math.min(out.length - at, this.block.length - this.at);
      out.set(this.block.subarray(this.at, this.at + n), at);
      this.at += n;
      at += n;
    }
  }
}

function seedBytes(seed: string): Uint8Array {
  if (typeof seed !== "string" || seed === "") throw new Error("a seed is a non-empty string");
  return enc.encode(seed);
}

function fromHex(hex: string): Uint8Array {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(hex)) {
    throw new Error(`hex ${JSON.stringify(hex)} is not lowercase byte pairs`);
  }
  return Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
}

function repeat(unit: Uint8Array, length: number): Uint8Array {
  if (unit.length === 0) throw new Error("repeat needs a unit of at least one byte");
  const out = new Uint8Array(length);
  // Doubling: every copy starts at a multiple of the unit, so the pattern stays
  // in phase, and a megabyte of one byte is twenty copies rather than a million.
  let filled = Math.min(unit.length, length);
  out.set(unit.subarray(0, filled));
  while (filled < length) {
    const n = Math.min(filled, length - filled);
    out.copyWithin(filled, 0, n);
    filled += n;
  }
  return out;
}

function mixed(seed: Uint8Array, length: number, pieces: string[]): Uint8Array {
  if (!Array.isArray(pieces) || pieces.length === 0) throw new Error("mixed needs pieces");
  const encoded = pieces.map((p) => {
    if (typeof p !== "string" || p === "") throw new Error("a piece is a non-empty string");
    return enc.encode(p);
  });
  const random = new Sha256Ctr(seed);
  const out = new Uint8Array(length + Math.max(...encoded.map((p) => p.length)));
  let at = 0;
  while (at < length) {
    // Two bytes per draw, high byte first.
    const hi = random.byte();
    const lo = random.byte();
    const piece = encoded[((hi << 8) | lo) % encoded.length]!;
    out.set(piece, at);
    at += piece.length;
  }
  return out.slice(0, length);
}

function expectFields(g: object, fields: string): void {
  const have = Object.keys(g).sort().join(",");
  if (have !== fields) {
    const kind = String((g as { kind: unknown }).kind);
    throw new Error(`a ${kind} generator has ${have}, not ${fields}`);
  }
}

/** The input a generator describes. Refuses a description it does not fully understand. */
export function generate(g: Generator): Uint8Array {
  if (!Number.isSafeInteger(g.length) || g.length < 0) {
    throw new Error(`length ${String(g.length)} is not a byte count`);
  }
  switch (g.kind) {
    case "sha256-ctr": {
      expectFields(g, "kind,length,seed");
      const out = new Uint8Array(g.length);
      new Sha256Ctr(seedBytes(g.seed)).fill(out);
      return out;
    }
    case "repeat":
      if ("text" in g) {
        expectFields(g, "kind,length,text");
        return repeat(enc.encode(g.text), g.length);
      }
      expectFields(g, "hex,kind,length");
      return repeat(fromHex(g.hex), g.length);
    case "mixed":
      expectFields(g, "kind,length,pieces,seed");
      return mixed(seedBytes(g.seed), g.length, g.pieces);
    default:
      throw new Error(`no generator called ${JSON.stringify((g as { kind: unknown }).kind)}`);
  }
}

/** Where a chunker cuts `data`, and the name of each chunk it cuts. */
function observe(
  data: Uint8Array,
  sizes: ChunkSizes,
  isUtf8: boolean,
  chunker: Chunker,
): { cuts: number[]; names: string[] } {
  const cuts: number[] = [];
  const names: string[] = [];
  let end = 0;
  for (const c of chunker(data, sizes, isUtf8)) {
    if (c.offset !== end) throw new Error(`a chunk starts at ${c.offset}, not at ${end}`);
    end = c.offset + c.bytes.length;
    cuts.push(end);
    names.push(sha256Hex(c.bytes));
  }
  if (end !== data.length) throw new Error(`the chunks cover ${end} of ${data.length} bytes`);
  return { cuts, names };
}

/** The first place two lists part, if they do. */
function differences<T>(what: string, fixture: readonly T[], here: readonly T[]): string[] {
  const out: string[] = [];
  if (fixture.length !== here.length) {
    out.push(`${fixture.length} ${what}s in the fixture, ${here.length} here`);
  }
  for (let i = 0; i < Math.min(fixture.length, here.length); i++) {
    if (fixture[i] !== here[i]) {
      out.push(
        `${what} ${i}: the fixture says ${String(fixture[i])}, this side ${String(here[i])}`,
      );
      break;
    }
  }
  return out;
}

const ENTRY_FIELDS = "cuts,generator,inputSha256,isUtf8,name,names,sizes,why";

/**
 * Everything wrong with an entry as this side sees it. Empty means this side
 * regenerates the same input and cuts it in the same places into the same
 * chunks.
 *
 * `chunker` is only ever replaced by a test proving a broken chunker fails.
 */
export function checkEntry(entry: Entry, chunker: Chunker = chunkBytes): string[] {
  const problems: string[] = [];
  const fields = Object.keys(entry).sort().join(",");
  if (fields !== ENTRY_FIELDS) problems.push(`the entry has ${fields}, not ${ENTRY_FIELDS}`);
  const sizeFields = Object.keys(entry.sizes).sort().join(",");
  const whole = [entry.sizes.min, entry.sizes.avg, entry.sizes.max].every(Number.isSafeInteger);
  if (sizeFields !== "avg,max,min" || !whole) {
    return [...problems, `sizes ${JSON.stringify(entry.sizes)} are not three whole numbers`];
  }

  let data: Uint8Array;
  try {
    data = generate(entry.generator);
  } catch (err) {
    return [...problems, `the generator: ${(err as Error).message}`];
  }
  const digest = sha256Hex(data);
  if (digest !== entry.inputSha256) {
    problems.push(
      `the generator does not reproduce the input: ${data.length} bytes hashing to ${digest}, not ${entry.inputSha256}`,
    );
  }

  let seen: { cuts: number[]; names: string[] };
  try {
    seen = observe(data, entry.sizes, entry.isUtf8, chunker);
  } catch (err) {
    return [...problems, (err as Error).message];
  }
  problems.push(...differences("cut", entry.cuts, seen.cuts));
  problems.push(...differences("name", entry.names, seen.names));
  return problems;
}

/** One case before its cuts are known. */
export interface CaseDefinition {
  name: string;
  why: string;
  generator: Generator;
  sizes: ChunkSizes;
  isUtf8: boolean;
  /** Cuts a case exists to pin. The runner refuses to write a corpus without them. */
  expectCuts?: number[];
}

/** A case with its cuts and names, as `chunkBytes` makes them today. */
export function computeEntry(def: CaseDefinition): Entry {
  const data = generate(def.generator);
  const { cuts, names } = observe(data, def.sizes, def.isUtf8, chunkBytes);
  if (def.expectCuts && differences("cut", def.expectCuts, cuts).length > 0) {
    throw new Error(`${def.name} exists to pin cuts [${def.expectCuts}], and they are [${cuts}]`);
  }
  // Built field by field so the key order is the one Go writes too.
  return {
    name: def.name,
    why: def.why,
    generator: def.generator,
    sizes: { min: def.sizes.min, avg: def.sizes.avg, max: def.sizes.max },
    isUtf8: def.isUtf8,
    inputSha256: sha256Hex(data),
    cuts,
    names,
  };
}

// Generator descriptions, built with their keys in the order Go writes them.
const ctr = (seed: string, length: number): Generator => ({ kind: "sha256-ctr", length, seed });
const rep = (text: string, length: number): Generator => ({ kind: "repeat", length, text });
const repHex = (hex: string, length: number): Generator => ({ kind: "repeat", length, hex });
const mix = (seed: string, length: number, pieces: string[]): Generator => ({
  kind: "mixed",
  length,
  seed,
  pieces,
});

// Invisible characters are built from code points so that the source says
// which ones they are.
const BOM = String.fromCodePoint(0xfeff);
const ZWJ = String.fromCodePoint(0x200d);
const COMBINING_ACUTE = String.fromCodePoint(0x301);

/**
 * Prose for corpus A: ASCII words, two-, three- and four-byte characters, a
 * byte order mark (LiveSync carries a regression test for one at a cut), a
 * zero-width-joiner sequence, a combining mark, Markdown, and three kinds of
 * line break.
 */
const PROSE_A = [
  "the ",
  "note ",
  "vault ",
  "sync ",
  "chunk ",
  "edit ",
  "and ",
  "of ",
  "a ",
  "is ",
  "café ",
  "cafe" + COMBINING_ACUTE + " ",
  "naïve ",
  "über ",
  "straße ",
  "Ωμέγα ",
  "жизнь ",
  "łódź ",
  "日本語",
  "のノート",
  "東京 ",
  "中文 ",
  "€",
  BOM,
  "한국어 ",
  "🗿",
  "😀 ",
  "𝄞",
  "🧪",
  "👩" + ZWJ + "💻 ",
  ". ",
  ", ",
  "# ",
  "- [ ] ",
  "**",
  "`",
  "\n",
  "\r\n",
  "\n\n",
  "\t",
];

/** The same prose with every line break and tab taken out: one long line. */
const ONE_LINE_A = PROSE_A.filter((p) => !/[\n\r\t]/.test(p));

/** Almost nothing but multi-byte characters, for small sizes that cut constantly. */
const DENSE_A = ["🗿", "𝄞", "😀", "日", "本", "é", "ж", "a", " "];

/** Every byte value once, for a UTF-8 path fed every malformed shape there is. */
const EVERY_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0")).join("");

const MiB = 1024 * 1024;

/** Maximum under the window: every decision is made while the hash is still filling. */
const FILL_ONLY: ChunkSizes = { min: 2, avg: 5, max: 40 };
/** Decisions at 48 bytes, just before the first roll, and just after it. */
const WINDOW_EDGE: ChunkSizes = { min: 48, avg: 2, max: 60 };
/** A minimum under four, so bytes a trim gives back are tested again at once. */
const REWIND: ChunkSizes = { min: 1, avg: 3, max: 9 };
/** The sizes chunk.test.ts feeds malformed input. */
const SMALL: ChunkSizes = { min: 8, avg: 16, max: 64 };
/** What protocol 1's sizesFor gives under a ceiling of 192 or less: every cut forced. */
const CLAMPED_192: ChunkSizes = { min: 192, avg: 192, max: 192 };
/** sizesFor under a ceiling of 193, for a different phase against a 5-byte unit. */
const CLAMPED_193: ChunkSizes = { min: 193, avg: 193, max: 193 };
/**
 * Binary sizes as protocol 1's sizesFor gives them at the default ceiling: the
 * whole MiB, with no seal overhead reserved. Today's sizesFor still reserves
 * it (sizesForV1 in the fixture file says why); chunkBytes takes sizes as
 * given, so the corpus can pin the protocol 1 ones already.
 */
const BINARY: ChunkSizes = BINARY_SIZES;

/**
 * Corpus A. Cut here, checked by Go.
 *
 * Changing a case changes the fixture: run `chunk-fixtures.run.ts`, then the Go
 * tests, and commit both. Go's coverage test insists the corpus keeps covering
 * tiny inputs, text and binary sizes, cuts at and just past the maximum, forced
 * cuts one, two and three bytes into a four-byte character, and a text file
 * over 4 MiB, so a case that goes should be replaced by one that does the same.
 */
export const CORPUS_A: CaseDefinition[] = [
  {
    name: "a-empty",
    why: "No bytes and no chunks: a file has chunks if and only if it has content.",
    generator: ctr("corpus A tiny", 0),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [],
  },
  {
    name: "a-one-byte",
    why: "One byte, one chunk.",
    generator: ctr("corpus A tiny", 1),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [1],
  },
  {
    name: "a-window-minus-one",
    why: "One byte short of a full window, at text sizes: the remainder is the only chunk.",
    generator: ctr("corpus A tiny", 47),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [47],
  },
  {
    name: "a-window",
    why: "Exactly one window.",
    generator: ctr("corpus A tiny", 48),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [48],
  },
  {
    name: "a-window-plus-one",
    why: "One byte past a window, the first byte that rolls.",
    generator: ctr("corpus A tiny", 49),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [49],
  },
  {
    name: "a-fill-phase-only",
    why: "A maximum under the window, so every cut is decided while the hash is still filling and it never rolls.",
    generator: mix("corpus A fill", 49, PROSE_A),
    sizes: FILL_ONLY,
    isUtf8: true,
  },
  {
    name: "a-window-edge",
    why: "Boundaries tested at 48 bytes, the last unrolled hash, and from 49, the first rolled one.",
    generator: ctr("corpus A edge", 600),
    sizes: WINDOW_EDGE,
    isUtf8: false,
  },
  {
    name: "a-rewind-retests-carried-bytes",
    why: "A minimum under four with dense multi-byte text: bytes a trim gives back are hashed again, and tested again, as the next chunk opens.",
    generator: mix("corpus A rewind", 80, DENSE_A),
    sizes: REWIND,
    isUtf8: true,
  },
  {
    name: "a-text-floor-sizes",
    why: "Multilingual prose at the floor text sizes, which textSizesFor gives a 20 KB note.",
    generator: mix("corpus A prose", 20000, PROSE_A),
    sizes: textSizesFor(20000),
    isUtf8: true,
  },
  {
    name: "a-text-scaled-1536",
    why: "Text sizes scaled to a 40 KB note: an average of 1536, which is not a power of two.",
    generator: mix("corpus A scaled", 40000, PROSE_A),
    sizes: textSizesFor(40000),
    isUtf8: true,
  },
  {
    name: "a-text-scaled-3072",
    why: "Text sizes scaled to a 130 KB note.",
    generator: mix("corpus A long note", 130000, PROSE_A),
    sizes: textSizesFor(130000),
    isUtf8: true,
  },
  {
    name: "a-one-long-line",
    why: "30 KB of multilingual text with no line break anywhere in it.",
    generator: mix("corpus A one line", 30000, ONE_LINE_A),
    sizes: textSizesFor(30000),
    isUtf8: true,
  },
  {
    name: "a-text-on-the-byte-path",
    why: "Multilingual text with isUtf8 false: cuts may split a character, and have to split it in the same place.",
    generator: mix("corpus A bytes", 12000, PROSE_A),
    sizes: TEXT_SIZES,
    isUtf8: false,
  },
  {
    name: "a-binary",
    why: "Incompressible bytes at binary sizes.",
    generator: ctr("corpus A attachment", 3 * MiB + 7),
    sizes: BINARY,
    isUtf8: false,
  },
  {
    name: "a-binary-on-the-utf8-path",
    why: "Arbitrary bytes at binary sizes with isUtf8 true, as a .md holding anything at all is chunked: malformed input decides every trim.",
    generator: ctr("corpus A odd note", 2 * MiB + 1),
    sizes: BINARY,
    isUtf8: true,
  },
  {
    name: "a-text-over-4-mib",
    why: "A text file over TEXT_AS_BINARY_ABOVE takes binary sizes and keeps the UTF-8 rule, as the engine chunks it.",
    generator: mix("corpus A huge note", 4 * MiB + 4097, PROSE_A),
    sizes: BINARY,
    isUtf8: true,
  },
  {
    name: "a-at-max-text",
    why: "Input exactly at max, with no boundary in it: one forced cut at the very end and no empty chunk after it.",
    generator: rep("a", 4096),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [4096],
  },
  {
    name: "a-max-plus-one-text",
    why: "One byte over max: a forced cut, then a one-byte remainder.",
    generator: rep("a", 4097),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [4096, 4097],
  },
  {
    name: "a-at-max-ends-on-a-lead-byte",
    why: "Input exactly at max whose last byte opens a four-byte character: the forced cut backs off it, and it is the remainder.",
    generator: rep("🗿a", 4096),
    sizes: TEXT_SIZES,
    isUtf8: true,
    expectCuts: [4095, 4096],
  },
  {
    name: "a-at-max-binary",
    why: "A raw chunk of exactly chunkMax, which protocol 1 allows: the marker byte goes on top.",
    generator: rep("z", MiB),
    sizes: BINARY,
    isUtf8: false,
    expectCuts: [MiB],
  },
  {
    name: "a-max-plus-one-binary",
    why: "One byte over chunkMax.",
    generator: rep("z", MiB + 1),
    sizes: BINARY,
    isUtf8: false,
    expectCuts: [MiB, MiB + 1],
  },
  {
    name: "a-forced-into-4-byte-chars-192",
    why: "Every cut forced, as under a 192-byte ceiling: the first lands one byte into a four-byte character, the rest two.",
    generator: rep("a🗿", 1500),
    sizes: CLAMPED_192,
    isUtf8: true,
  },
  {
    name: "a-forced-into-4-byte-chars-193",
    why: "Every cut forced at 193: the first lands two bytes into a four-byte character, the rest three.",
    generator: rep("a🗿", 1500),
    sizes: CLAMPED_193,
    isUtf8: true,
  },
  {
    name: "a-forced-into-mixed-text",
    why: "Every cut forced at 192 through multilingual text, landing in characters of every width.",
    generator: mix("corpus A forced", 3000, PROSE_A),
    sizes: CLAMPED_192,
    isUtf8: true,
  },
  {
    name: "a-remainder-ends-mid-character",
    why: "The input ends one byte into a three-byte character. The last chunk is the remainder and is never trimmed.",
    generator: rep("日本語", 1000),
    sizes: TEXT_SIZES,
    isUtf8: true,
  },
  {
    name: "a-malformed-continuation-run",
    why: "Nothing but continuation bytes on the UTF-8 path: no lead byte in sight, so nothing is ever trimmed.",
    generator: repHex("80", 400),
    sizes: SMALL,
    isUtf8: true,
  },
  {
    name: "a-malformed-truncated-leads",
    why: "Four-byte leads promising more than follows, back to back.",
    generator: repHex("f080", 400),
    sizes: SMALL,
    isUtf8: true,
  },
  {
    name: "a-malformed-every-byte",
    why: "Every byte value in turn, which is every malformed shape there is.",
    generator: repHex(EVERY_BYTE, 512),
    sizes: SMALL,
    isUtf8: true,
  },
  {
    name: "a-malformed-lead-classes",
    why: "Overlong leads, 0xF5 read as a four-byte lead, 0xF8 and 0xFF read as single bytes, an encoded surrogate: classified as chunk.ts classifies them.",
    generator: repHex("c0afe080aff58080f888c1ffeda080", 300),
    sizes: SMALL,
    isUtf8: true,
  },
];

/** Who cut corpus A, how to cut it again, and who checks it. */
export const CORPUS_A_HEADER = {
  producedBy: "TypeScript: chunkBytes in client/src/core/chunk.ts",
  regenerate: "cd client && bun run src/core/chunk-fixtures.run.ts",
  checkedBy: "Go: go test ./internal/notes -run TestChunkFixtures",
} as const;

/** Corpus A with its cuts, as this side's chunkBytes makes them today. */
export function corpusA(): Corpus {
  return { ...CORPUS_A_HEADER, entries: CORPUS_A.map(computeEntry) };
}

/**
 * The file's sections, in the order both writers put them. The Go writer in
 * `internal/notes` keeps the same list; either refuses a file with a section it
 * does not know rather than dropping it.
 */
const SECTIONS = ["note", "generators", "corpusA", "corpusB", "sizesForV1", "isTextPath"];

/**
 * The one format the file is kept in, which Go's encoder also produces: two
 * spaces, one value per line, and a newline at the end. A second writer with
 * its own idea of formatting would turn every regeneration into a diff of the
 * whole file.
 */
export function canonical(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** The fixture file, parsed. */
export function readFixtures(): FixtureFile {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureFile;
}

/** Replaces corpus A in the fixture file and leaves every other section as it was. */
export function writeCorpusA(corpus: Corpus): void {
  const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
  const unknown = Object.keys(doc).filter((key) => !SECTIONS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `chunk-fixtures.json has sections this writer would drop: ${unknown.join(", ")}`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const key of SECTIONS) {
    if (key === "corpusA") out[key] = corpus;
    else if (key in doc) out[key] = doc[key];
  }
  writeFileSync(FIXTURE_PATH, canonical(out));
}
