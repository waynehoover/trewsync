/**
 * The oracle for the Go port of the MCP tools' note functions (PLAN.md
 * section 2.1): the read side (M4), and the write side's pure half (M5):
 * exact edits, tag edits and operation plans.
 *
 * Feeds a corpus through the TypeScript functions internal/notes is ported
 * from, and writes what they return to mcp-fixtures.json at the repository
 * root. internal/notes/oracle_test.go holds the Go functions to every vector.
 * It also writes internal/notes/emoji_table.go, the two Unicode properties Go
 * has no table for, taken from this runtime, and records sweeps of every code
 * point through the character classes the ports depend on, so a runtime and a
 * Go toolchain that disagree about Unicode cannot pass unnoticed.
 *
 *     cd client && bun run src/node/mcp-oracle.run.ts
 *
 * The corpus is the regression inputs of the mcp-*.test.ts files plus
 * generated ones: multilingual text, CRLF and lone CR, byte-order marks,
 * astral characters, very long lines, empty notes, frontmatter edge cases,
 * nested code blocks, %% inside code, and link destinations with parentheses
 * and fragments. Generated inputs come from a fixed seed, so a rerun on the
 * same runtime writes the same bytes.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { characterEntities } from "character-entities";
import { decodeString } from "micromark-util-decode-string";
import { compareText, compareVersions } from "./mcp-inspect.ts";
import type { McpHistory } from "./mcp-history.ts";
import { linkResolver, linkSpans, changeLinks, type LinkChange } from "./mcp-links.ts";
import {
  changeTags,
  frontmatter,
  inlineTags,
  markdownHidden,
  matchesTag,
  tagOccurrences,
  tagPattern,
  validateTag,
  type TagChange,
} from "./mcp-markdown.ts";
import {
  INPUT_BYTES,
  NOTE_BYTES,
  NoteError,
  noteDigest,
  prepareNote,
  type NoteMutation,
} from "./mcp-notes.ts";
import {
  previewOperation,
  samePlan,
  type PlannedChange,
  type VaultOperation,
} from "./mcp-operations.ts";
import { fingerprint, McpReader, pageNote, position, token } from "./mcp-read.ts";
import { CheckedPathError, NodeVault } from "./vault.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Encoding. Every string in the file is ASCII: JSON.stringify's output with
// each code unit above U+007E escaped, so invisible and astral characters are
// visible in a diff and survive any editor.

function ascii(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/gu,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** Text as the fixture carries it: a string, or bytes that are not UTF-8. */
type Text = string | { b64: string } | { repeat: [string, number][] };
const bytesText = (bytes: Uint8Array): Text => ({ b64: Buffer.from(bytes).toString("base64") });
function repeatText(parts: [string, number][]): { text: Text; value: string } {
  return { text: { repeat: parts }, value: parts.map(([s, n]) => s.repeat(n)).join("") };
}
/** A large output is recorded by digest and length; the Go test hashes. */
function big(s: string): string | { sha256: string; units: number } {
  if (s.length <= 1024) return s;
  return { sha256: createHash("sha256").update(s).digest("hex"), units: s.length };
}
function failure(error: unknown): { error: string } {
  if (error instanceof NoteError) return { error: error.code };
  throw error;
}

// Fixed-seed generators for the generated corpus (mulberry32). Each kind of
// input added later draws from a generator of its own, so that adding one
// leaves the inputs of the others as they were.
function mulberry32(start: number): () => number {
  let seed = start;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(0x7e11a5);
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

// ---------------------------------------------------------------------------
// Shared corpus pieces. Written with escapes throughout, so this file stays
// ASCII.

const MULTILINGUAL = [
  "caf\u00e9 and cafe\u0301",
  "\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac \u039f\u0394\u039f\u03a3 \u03bf\u03b4\u03bf\u03c2 \u03a3\u0391\u03a3",
  "Stra\u00dfe STRASSE \u1e9e\u00df",
  "\u0130stanbul \u0131Ii",
  "\u041a\u0438\u0457\u0432 \u041a\u0418\u0407\u0412",
  "\u10e5\u10d0\u10e0\u10d7\u10e3\u10da\u10d8 \u1c95\u1c90\u1ca0",
  "\u13a0\u13a1 \uab70\uab71 \u13f0\u13f8",
  "\u{10400}\u{10428} Deseret",
  "\u{1e900}\u{1e922} Adlam",
  "\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8",
  "\u4e2d\u6587\u6587\u672c",
  "\ud55c\uad6d\uc5b4 \u1112\u119e\u11ab",
  "\u05e2\u05d1\u05e8\u05d9\u05ea",
  "\u0627\u0644\u0639\u0631\u0628\u064a\u0629",
  "\u0939\u093f\u0928\u094d\u0926\u0940",
  "\u0e44\u0e17\u0e22",
  "\u{1f600} \u{1f44d}\u{1f3fd} \u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}",
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} \u{1f1fa}\u{1f1f8}",
  "\u212a Kelvin \u212b Angstrom \u2126 Ohm",
  "\ufb00 ligature \u01c5 titlecase \u0345 ypogegrammeni",
  "\u{1d400}\u{1d401} math",
  "tab\there and \u00a0nbsp \u2028ls \u2029ps",
];

function lines(n: number, make: (i: number) => string, newline = "\n"): string {
  return Array.from({ length: n }, (_, i) => make(i) + newline).join("");
}

// ---------------------------------------------------------------------------
// read_note paging (pageNote).

function pageVectors(): unknown[] {
  const texts: { text: Text; bytes: Uint8Array }[] = [];
  const add = (s: string) => texts.push({ text: s, bytes: enc.encode(s) });
  const addBytes = (b: Uint8Array) => texts.push({ text: bytesText(b), bytes: b });
  const addRepeat = (parts: [string, number][]) => {
    const r = repeatText(parts);
    texts.push({ text: r.text, bytes: enc.encode(r.value) });
  };
  for (const s of [
    "",
    "a",
    "a\n",
    "a\nb",
    "a\r\nb\r\n",
    "a\rb\rc",
    "abc\r",
    "\r",
    "\r\n",
    "\n\n\n",
    "\r\r\n\n\r",
    "\ufeff---\r\ntitle: Daily\r\n---\r\n\r\n- [ ] Task\r\n",
    "\ufeff",
    "\ufeff\n",
    "\u0000nul\u0000\n",
    MULTILINGUAL.join("\n"),
    MULTILINGUAL.join("\r\n") + "\r\n",
    MULTILINGUAL.join("\r"),
    "\u{1f600}\n\u{10400}\r\n\u{1d400}",
  ])
    add(s);
  // Lines at and around the 64 KiB budget, in one-, two-, three- and
  // four-byte characters.
  addRepeat([["x", 65535]]);
  addRepeat([["x", 65536]]);
  addRepeat([["x", 65537]]);
  addRepeat([
    ["x", 65535],
    ["\n", 1],
  ]);
  addRepeat([
    ["x", 65536],
    ["\n", 1],
  ]);
  addRepeat([
    ["\u20ac", 21845],
    ["\n", 1],
  ]);
  addRepeat([
    ["\u20ac", 21845],
    ["x\n", 1],
  ]);
  addRepeat([["\u{1f600}", 16384]]);
  addRepeat([
    ["\u{1f600}", 16383],
    ["abc\n", 1],
    ["y\n", 3],
  ]);
  addRepeat([
    ["\u00e9", 32767],
    ["\n", 1],
    ["z\n", 2],
  ]);
  addRepeat([["x".repeat(1023) + "\n", 1024]]);
  addRepeat([["x".repeat(1023) + "\r\n", 1000]]);
  addRepeat([["a\n", 2000]]);
  addRepeat([
    ["x".repeat(1023) + "\n", 1024],
    ["!", 1],
  ]);
  addRepeat([["\r", 70000]]);
  // Bytes a fatal decoder refuses.
  for (const b of [
    [0xff],
    [0x61, 0xc0, 0x80],
    [0xed, 0xa0, 0x80],
    [0xed, 0xbf, 0xbf, 0x0a],
    [0xe2, 0x82],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf0, 0x9f, 0x98],
    [0x61, 0x0a, 0x80],
    [0xef, 0xbb, 0xbf, 0xfe],
  ])
    addBytes(new Uint8Array(b));
  const out: unknown[] = [];
  const calls: [number, number][] = [
    [1, 200],
    [1, 1],
    [2, 1],
    [3, 2],
    [1, 1000],
    [2, 1000],
    [4, 3],
    [65, 10],
    [1000, 5],
    [2001, 1],
    [9007199254740991, 1],
    [0, 1],
    [1, 0],
    [1, 1001],
  ];
  for (const t of texts)
    for (const [startLine, maxLines] of calls) {
      let want: unknown;
      try {
        const page = pageNote(t.bytes, "note.md", { path: "note.md", startLine, maxLines });
        want = {
          content: big(page.content),
          startLine: page.startLine,
          endLine: page.endLine,
          nextLine: page.nextLine,
          complete: page.complete,
        };
      } catch (error) {
        want = failure(error);
      }
      out.push({ text: t.text, startLine, maxLines, want });
    }
  return out;
}

// ---------------------------------------------------------------------------
// Continuation cursors (fingerprint, token, position).

type Options = [string, string | number | boolean][];
const obj = (o: Options) => Object.fromEntries(o);

function cursorVectors() {
  const strings = [
    "",
    "Daily",
    'a"b',
    "back\\slash",
    "\u0001\u001f\u007f",
    "\b\f\n\r\t",
    "\u2028\u2029",
    "<>&",
    "caf\u00e9 \u{1f600}",
    "\ufeff\u00a0",
    "/",
  ];
  const optionSets: Options[] = [];
  for (const s of strings) {
    optionSets.push([
      ["folder", s],
      ["nameContains", ""],
      ["includeBackups", false],
    ]);
    optionSets.push([
      ["query", s || "q"],
      ["mode", "content"],
      ["includeChildren", true],
      ["folder", ""],
      ["caseSensitive", false],
      ["includeBackups", false],
      ["contextLines", 3],
    ]);
  }
  optionSets.push([
    ["a", 0],
    ["b", -1],
    ["c", 9007199254740991],
    ["d", true],
  ]);
  const fingerprints = optionSets.map((options) => ({ options, want: fingerprint(obj(options)) }));

  const paths = [
    "note.md",
    "Daily/2026-09-22.md",
    "caf\u00e9/\u{1f600}.md",
    Array.from({ length: 16 }, () => "\u0001".repeat(60)).join("/") + "/a.md",
    "x".repeat(1024),
    "\u20ac".repeat(341) + "x",
    "",
  ];
  const tokens: unknown[] = [];
  for (const path of paths)
    for (const [line, column] of [
      [0, 0],
      [0, 1],
      [3, 17],
      [9007199254740991, 0],
    ] as const) {
      const options = optionSets[tokens.length % optionSets.length]!;
      tokens.push({
        options,
        path,
        line,
        column,
        want: token(obj(options), { path, line, column }),
      });
    }

  // Refusals, varying one part of an otherwise valid cursor at a time.
  const base: Options = optionSets[0]!;
  const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64url");
  const make = (at: Record<string, unknown>, query: unknown = fingerprint(obj(base))) =>
    b64(JSON.stringify({ query, at }));
  const pathFields: { field: string; note: string }[] = [
    { field: b64("note.md"), note: "valid" },
    { field: b64(""), note: "empty path" },
    { field: b64("caf\u00e9"), note: "valid unicode" },
    { field: "YR", note: "non-canonical trailing bits" },
    { field: "Y", note: "impossible length" },
    { field: "_w", note: "0xff byte" },
    { field: b64(new Uint8Array([0xed, 0xa0, 0x80])), note: "encoded surrogate" },
    { field: b64(new Uint8Array([0xc0, 0x80])), note: "overlong" },
    { field: b64("x".repeat(1024)), note: "1024 bytes" },
    { field: b64("x".repeat(1025)), note: "1025 bytes" },
    { field: b64("x".repeat(4096)), note: "4096 bytes" },
    { field: b64("x".repeat(4097)), note: "4097 bytes" },
    { field: "bm90ZS5tZA==", note: "padded" },
    { field: "bm90ZS5tZA+", note: "standard alphabet" },
  ];
  const positions: unknown[] = [];
  const decode = (value: string, options: Options) => {
    try {
      const at = position(value, obj(options))!;
      return { path: at.path, line: at.line, column: at.column };
    } catch (error) {
      return failure(error);
    }
  };
  for (const { field, note } of pathFields) {
    const value = make({ path: field, line: 1, column: 2 });
    positions.push({ note, value, pathField: field, want: decode(value, base) });
  }
  const whole: { value: string; note: string }[] = [
    {
      value: make({ path: b64("a.md"), line: 1, column: 2 }, "0".repeat(64)),
      note: "other options",
    },
    { value: make({ path: b64("a.md"), line: -1, column: 2 }), note: "negative line" },
    { value: make({ path: b64("a.md"), line: 1.5, column: 2 }), note: "fractional line" },
    { value: make({ path: b64("a.md"), line: 9007199254740992, column: 0 }), note: "unsafe line" },
    { value: make({ path: b64("a.md"), line: 1 }), note: "missing column" },
    { value: make({ path: 7, line: 1, column: 1 }), note: "path not a string" },
    { value: b64("[]"), note: "not an object" },
    { value: b64("{"), note: "not JSON" },
    { value: "", note: "empty" },
    { value: "a+b", note: "outside the alphabet" },
    { value: "A".repeat(8193), note: "too long" },
    { value: make({ path: b64("a.md"), line: 1, column: 2 }) + "=", note: "padding" },
  ];
  for (const { value, note } of whole)
    positions.push({ note, value, pathField: null, want: decode(value, base) });
  return { fingerprints, tokens, positions };
}

// ---------------------------------------------------------------------------
// search_notes over one vault at a time (McpReader.search).

interface Note {
  path: string;
  text?: string;
  bytes?: Uint8Array;
}
interface SearchInput {
  query: string;
  mode?: "content" | "filename" | "both" | "tag";
  caseSensitive?: boolean;
  contextLines?: number;
  limit?: number;
  includeChildren?: boolean;
  folder?: string;
}

async function searchVectors() {
  const vaults: { notes: Note[]; queries: SearchInput[] }[] = [];
  // mcp-read.test.ts, as it builds its vaults.
  vaults.push({
    notes: [
      { path: "real.md", text: "---\r\ntags: [Project/Active]\r\n---\r\nbody\r\n" },
      { path: "inline.md", text: "#project/active\n" },
      {
        path: "prose.md",
        text: "project/active\n`#project/active`\n<!-- #project/active -->\n````\n```\n#project/active\n````\n",
      },
      { path: "child.md", text: "#project/active\n" },
      { path: "parent.md", text: "#Project\n" },
      { path: "prefix.md", text: "#projectile\n" },
    ],
    queries: [
      { query: "project/active", mode: "tag" },
      { query: "project", mode: "tag" },
      { query: "project", mode: "tag", includeChildren: false },
      { query: "#Project/ACTIVE", mode: "tag", limit: 1 },
      { query: "project", mode: "both" },
      { query: "active", contextLines: 1 },
    ],
  });
  vaults.push({
    notes: [
      { path: "a-needle.md", text: "no content match" },
      { path: "b-needle.md", text: "no content match" },
      { path: "c.md", text: "needle" },
      { path: "unreadable-needle.md", bytes: new Uint8Array([0xff]) },
      { path: "file.pdf", text: "needle" },
      { path: "note.md", text: "---\ntags: old old\n---\n" },
    ],
    queries: [
      { query: "needle", mode: "filename", limit: 1 },
      { query: "needle", mode: "both" },
      { query: "needle" },
      { query: "old", mode: "tag", limit: 1 },
      { query: "NEEDLE", mode: "both", caseSensitive: true },
    ],
  });
  vaults.push({
    notes: [
      { path: "a.md", text: "needle needle\nneedle\n" },
      { path: "b.md", text: "later needle\n" },
      { path: "note.md", text: "Literal [a-z]+?\nsecond line\n" },
    ],
    queries: [
      { query: "needle", limit: 1 },
      { query: "needle", limit: 2, contextLines: 1 },
      { query: "[a-z]+?" },
      { query: "+?\nsecond" },
      { query: "e" },
      { query: "ee" },
      { query: "E", caseSensitive: true },
      { query: "\n" },
    ],
  });
  const long = "\u0001".repeat(2048);
  vaults.push({
    notes: [
      { path: "note.md", text: [long, long, long, "needle" + long, long, long, long].join("\n") },
    ],
    queries: [{ query: "needle", contextLines: 3 }],
  });
  // Multilingual, case folding, line endings and clipping.
  const multi = MULTILINGUAL.join("\n");
  vaults.push({
    notes: [
      { path: "multi.md", text: multi },
      { path: "crlf.md", text: MULTILINGUAL.join("\r\n") + "\r\n" },
      { path: "cr.md", text: MULTILINGUAL.join("\r") },
      { path: "bom.md", text: "\ufeffneedle at the start\n\ufeffneedle again" },
      { path: "empty.md", text: "" },
      {
        path: "long.md",
        text:
          "a".repeat(300) +
          "needle" +
          "b".repeat(2000) +
          "\n" +
          "\u{1f600}".repeat(200) +
          "needle" +
          "\u{1f600}".repeat(600) +
          "\n" +
          "c".repeat(255) +
          "\u{1f600}needle\n" +
          "d".repeat(257) +
          "needle",
      },
      {
        path: "context.md",
        text: lines(12, (i) => (i === 6 ? "needle" : "\u{1f600}".repeat(127) + "x" + i)),
      },
      { path: "sub/deep.md", text: "needle in a folder\n" },
      { path: "sub.md", text: "needle beside the folder\n" },
    ],
    queries: [
      { query: "needle" },
      { query: "needle", contextLines: 2 },
      { query: "needle", contextLines: 3, limit: 3 },
      { query: "needle", folder: "sub" },
      { query: "\u03c3" },
      { query: "\u03a3" },
      { query: "\u03c2" },
      { query: "\u00df" },
      { query: "\u1e9e" },
      { query: "ss" },
      { query: "k" },
      { query: "\u212a" },
      { query: "\u0130" },
      { query: "i" },
      { query: "\u0131" },
      { query: "\u{10428}" },
      { query: "\u{1e922}" },
      { query: "\uab70" },
      { query: "\u13a0" },
      { query: "\u10e5" },
      { query: "\u1c95" },
      { query: "\u00e9" },
      { query: "e\u0301" },
      { query: "\u{1f3fd}" },
      { query: "\u200d" },
      { query: "\u{1f468}\u200d" },
      { query: "\r" },
      { query: "\r\n" },
      { query: "\u00a0" },
      { query: "\u2028" },
      { query: "\ufeff" },
      { query: "\u0345" },
      { query: "\u03b9" },
      { query: "\u01c4" },
      { query: "\u01c6" },
      { query: "\u212b" },
      { query: "\u00c5" },
      { query: "STRASSE", caseSensitive: true },
      { query: "multi", mode: "filename" },
      { query: "DEEP", mode: "both" },
      { query: "\u{1f600}n" },
      { query: "aaa", limit: 5 },
      { query: "d".repeat(10) + "n" },
    ],
  });
  // Tags through search, from the markdown regression cases.
  vaults.push({
    notes: [
      {
        path: "tags.md",
        text: "#keep #\u5de5\u4f5c/\u5f53\u524d #\u{1f600}\n`#ignore` ``#ignore ` nested``\n\\#ignore 123#ignore #123\n<!-- #ignore\n#ignore -->\n%% #ignore %%\n[[note#ignore]] [note](note#ignore)\n````\n```\n#ignore\n````\n~~~\n#ignore\n~~~\n    #ignore\n",
      },
      {
        path: "emoji.md",
        text: "#\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} #\u{1f44d}\u{1f3fd}\n",
      },
      {
        path: "sigma.md",
        text: "#\u039f\u0394\u039f\u03a3 #\u03bf\u03b4\u03bf\u03c2/child #cafe\u0301/x\n",
      },
      { path: "bad.md", text: "---\ntags: [broken\n---\n#visible\n" },
      { path: "num.md", text: "---\ntags: [a, 123]\n---\n#visible\n" },
    ],
    queries: [
      { query: "keep", mode: "tag" },
      { query: "\u5de5\u4f5c", mode: "tag" },
      { query: "\u{1f600}", mode: "tag" },
      { query: "\u{1f44d}\u{1f3fd}", mode: "tag" },
      { query: "\u{1f44d}", mode: "tag" },
      { query: "\u03bf\u03b4\u03bf\u03c2", mode: "tag" },
      { query: "\u039f\u0394\u039f\u03a3", mode: "tag", includeChildren: false },
      { query: "caf\u00e9", mode: "tag" },
      { query: "visible", mode: "tag" },
      { query: "ignore", mode: "tag" },
      { query: "123", mode: "tag" },
    ],
  });
  // Generated notes: random lines over a small alphabet, so short queries
  // hit often and overlap.
  const alphabet = [
    "a",
    "b",
    "A",
    "\u00e9",
    "E\u0301",
    "\u{1f600}",
    " ",
    "\r",
    "\t",
    "\u03a3",
    "\u03c3",
  ];
  const generated: Note[] = [];
  for (let n = 0; n < 8; n++) {
    const count = 1 + Math.floor(random() * 15);
    const text = lines(count, () =>
      Array.from({ length: Math.floor(random() * 30) }, () => pick(alphabet)).join(""),
    );
    generated.push({ path: `gen-${String(n).padStart(2, "0")}.md`, text });
  }
  vaults.push({
    notes: generated,
    queries: [
      { query: "a" },
      { query: "ab" },
      { query: "aa", limit: 7 },
      { query: "A", caseSensitive: true, limit: 13 },
      { query: "\u03c3", contextLines: 1 },
      { query: "\u{1f600}\u{1f600}" },
      { query: "\r\n" },
      { query: "a\nb" },
      { query: "b", contextLines: 3, limit: 11 },
    ],
  });

  const out: unknown[] = [];
  for (const vault of vaults) {
    const root = await mkdtemp(join(tmpdir(), "trew-oracle-"));
    try {
      for (const note of vault.notes) {
        await mkdir(join(root, dirname(note.path)), { recursive: true });
        await writeFile(join(root, note.path), note.bytes ?? note.text ?? "");
      }
      const reader = new McpReader(new NodeVault(root, { observeOnly: true }));
      const queries: unknown[] = [];
      for (const input of vault.queries) {
        const pages: unknown[] = [];
        let cursor: string | undefined;
        // The first twenty pages of a query are recorded; the Go test
        // replays exactly those.
        for (let page = 0; page < 20; page++) {
          let result: Awaited<ReturnType<McpReader["search"]>>;
          try {
            result = await reader.search({
              ...input,
              ...(cursor ? { cursor } : {}),
            } as Parameters<McpReader["search"]>[0]);
          } catch (error) {
            pages.push(failure(error));
            break;
          }
          pages.push({
            matches: result.matches,
            next: result.nextCursor ? decodeCursor(result.nextCursor) : null,
            complete: result.complete,
            scanned: result.scanned,
            scannedBytes: result.scannedBytes,
            skipped: { count: result.skipped.count, items: result.skipped.items },
          });
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
        queries.push({ input, pages });
      }
      await reader.drain();
      out.push({
        notes: vault.notes.map((n) => ({
          path: n.path,
          text: n.bytes ? bytesText(n.bytes) : n.text,
        })),
        queries,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  return out;
}

function decodeCursor(value: string) {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
    at: { path: string; line: number; column: number };
  };
  return {
    path: Buffer.from(parsed.at.path, "base64url").toString("utf8"),
    line: parsed.at.line,
    column: parsed.at.column,
  };
}

// ---------------------------------------------------------------------------
// compare_versions (compareText and compareVersions' page loop).

async function compareVectors() {
  const pairs: { before: Text; after: Text; a: string; b: string }[] = [];
  const add = (a: string, b: string) => pairs.push({ before: a, after: b, a, b });
  const addBig = (a: [string, number][], b: [string, number][]) => {
    const x = repeatText(a),
      y = repeatText(b);
    pairs.push({ before: x.text, after: y.text, a: x.value, b: y.value });
  };
  // mcp-inspect.test.ts: every pair of these.
  const texts = [
    "",
    "one\n",
    "one\r\ntwo",
    "\ufeffone\n\nthree\n",
    "three\ntwo\none\n",
    "one\ntwo\nthree\n",
  ];
  for (const a of texts) for (const b of texts) add(a, b);
  // The coarse regression: 2,000 lines against 2,000 others.
  add(
    lines(2000, (i) => `old ${i}`),
    lines(2000, (i) => `new ${i}`),
  );
  // Either side of the 1,000,000-cell cap: (h+1)(w+1) cells.
  addBig([["p\n", 999]], [["q\n", 999]]);
  addBig([["p\n", 999]], [["q\n", 1000]]);
  addBig(
    [
      ["same\n", 50],
      ["p\n", 998],
    ],
    [
      ["same\n", 50],
      ["q\n", 1001],
    ],
  );
  // Line endings, byte-order marks, astral characters, empty sides.
  add("a\r\nb\r\nc\r\n", "a\nb\nc\n");
  add("a\rb\rc", "a\rB\rc");
  add("\ufeffa\nb\n", "a\nb\n");
  add(MULTILINGUAL.join("\n"), MULTILINGUAL.slice().reverse().join("\n"));
  add(MULTILINGUAL.join("\n") + "\n", MULTILINGUAL.join("\n"));
  add("x\n", "");
  add("", "x");
  add("same", "same");
  // Hunks longer than the 2,048-unit clip, with an astral character on it.
  add("a".repeat(2047) + "\u{1f600}tail\n", "b".repeat(3000) + "\n");
  add("\u{1f600}".repeat(1100) + "\n", "\u{1f600}".repeat(1024) + "\n");
  // Many changes, and rows whose escaped size fills the 128 KiB page.
  add(
    lines(200, (i) => `line ${i}`),
    lines(200, (i) => (i % 3 === 0 ? `LINE ${i}` : `line ${i}`)),
  );
  const controls = (c: string, keep: boolean): [string, number][] =>
    Array.from({ length: 40 }, (_, i): [string, number][] =>
      keep && i % 2 === 0
        ? [[`keep ${i}\n`, 1]]
        : [
            [c, 3000],
            [`${i}\n`, 1],
          ],
    ).flat();
  addBig(controls("\u0001", false), controls("\u0002", false));
  addBig(controls("\u0001", true), controls("\u0002", true));
  // Generated edits.
  for (let n = 0; n < 16; n++) {
    const base = Array.from({ length: 5 + Math.floor(random() * 40) }, () =>
      pick(["alpha", "beta", "gamma", "delta", "\u00e9", "\u{1f600}", "", "  ", "x\r"]),
    );
    const edited = base.flatMap((line) => {
      const roll = random();
      if (roll < 0.15) return [];
      if (roll < 0.3) return [line, pick(["new", "\u03a3", "alpha"])];
      if (roll < 0.4) return [line.toUpperCase()];
      return [line];
    });
    const newline = pick(["\n", "\r\n"]);
    add(base.join(newline) + newline, edited.join(newline) + pick(["", newline]));
  }

  const out: unknown[] = [];
  for (const pair of pairs) {
    const diff = compareText(pair.a, pair.b);
    const bytes = { 1: enc.encode(pair.a), 2: enc.encode(pair.b) } as Record<number, Uint8Array>;
    const history = {
      connection: () => undefined,
      content: async (path: string, uid: number) => ({ path, bytes: bytes[uid]! }),
    } as unknown as McpHistory;
    const pages: unknown[] = [];
    const walks: [number, number][] = [
      [0, 20],
      [0, 1],
      [1, 2],
      [3, 100],
      [diff.changes.length, 5],
      [diff.changes.length + 3, 5],
    ];
    for (const [after, limit] of walks) {
      const result = await compareVersions(history, undefined as unknown as McpReader, {
        path: "note.md",
        fromUid: 1,
        toUid: 2,
        after,
        limit,
        fromBase: noteDigest(bytes[1]!),
        toBase: noteDigest(bytes[2]!),
      });
      pages.push({
        after,
        limit,
        want: {
          changes: result.changes.map((c) => ({ ...c, old: big(c.old), new: big(c.new) })),
          nextAfter: result.nextAfter,
          complete: result.complete,
          totalChanges: result.totalChanges,
          identical: result.identical,
          coarse: result.coarse,
        },
      });
    }
    out.push({
      before: pair.before,
      after: pair.after,
      want: {
        coarse: diff.coarse,
        changes: diff.changes.map((c) => ({ ...c, old: big(c.old), new: big(c.new) })),
      },
      pages,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tags, frontmatter and hidden ranges (mcp-markdown.ts).

const FRONTMATTER = [
  // mcp-markdown.test.ts
  '\ufeff---\r\ntitle:  "Keep these spaces" # title comment\r\ntags: [old, Keep] # tag comment\r\nother: &value {x: 1}\r\ncopy: *value\r\n---\r\nUNSENT caf\u00e9 \u{1f600}\r\n',
  "---\ntitle:  unchanged\ntags:\n  - old # first\n  # middle\n  - keep\nnext: unchanged\n---\nUNSENT\n",
  "\ufeffBody\r\n",
  "---\ntitle: raw\n---",
  "---\ntags:\n# keep\n---\nbody",
  "\ufeff---\r\ntitle: unchanged\r\n---\r\nUNSENT",
  "---\ntags: [broken\n---\nbody",
  "---\ntags: [a]\ntags: [b]\n---\nbody",
  "---\ntags: &tags [a]\ncopy: *tags\n---\nbody",
  "---\nother: &tags [a]\ntags: *tags\n---\nbody",
  "---\ntags: {other: a}\n---\nbody",
  "---\ntags: [true]\n---\nbody",
  "---\ntitle: no closing delimiter",
  "---\ntags: [Work]\n---\nbody",
  "---\ntags: [new]\n---\n```\ncode\n",
  // Delimiters.
  "--- \t\nt: [a]\n---  \nbody",
  "---\r\ntags: [a]\r\n---\r\nbody",
  "---\ntags: [a]\n---",
  "---\ntags: [a]\n---x\n---\nbody",
  "---\ntags: [a]\n ---\n---\nbody",
  "---\ntags: [a]\r---\rbody",
  "---\ntags: [a]\u2028---\u2029body",
  "---\ntags: [a]\n--- #\n---\n",
  "----\ntags: [a]\n---\n",
  "---x\ntags: [a]\n---\n",
  "\ufeff\ufeff---\ntags: [a]\n---\n",
  " ---\ntags: [a]\n---\n",
  "---\n---\n#after",
  "---\n\n---\n",
  "---\n# only a comment\n---\n",
  // Values.
  "---\ntags: a b  # c\n---\n",
  "---\ntags: [a, b ,c]\n---\n",
  '---\ntags: "a, b"\n---\n',
  "---\ntags: |\n  a\n  b\n\nx: 1\n---\n",
  "---\ntags: >-\n  a\n---\n",
  "---\ntags: |+\n  a\n\n\nx: 1\n---\n",
  "---\ntags: |\n  a",
  "---\ntags:\n  - a\n  - b # c\n---\n",
  "---\ntags: !!str 12a\n---\n",
  "---\ntags: a\n  b\n  c\nx: 1\n---\n",
  "---\ntags: [a\n  b, c]\n---\n",
  "---\ntags: yes\n---\n",
  "---\ntags: 2024-01-01\n---\n",
  "---\ntags: 1_000\n---\n",
  "---\ntags: 0o17\n---\n",
  "---\ntags: .inf\n---\n",
  "---\ntags: ~\n---\n",
  "---\ntags: null\n---\n",
  "---\ntags: [~, a]\n---\n",
  "---\ntags: !foo a\n---\n",
  "---\ntags: !!binary YQ==\n---\n",
  "---\ntags: ! 12\n---\n",
  "---\ntags: ! a12\n---\n",
  "---\ntags: !!int x\n---\n",
  "---\ntags: !!null ~\n---\n",
  "---\ntags: !!null x\n---\n",
  "---\ntags: [!!str 1, b]\n---\n",
  "---\ntags: [\"1a\", '2b']\n---\n",
  "---\ntags: 'it''s'\n---\n",
  '---\n"tags": x\n---\n',
  "---\n? tags\n: y\n---\n",
  "---\ntags: [a, [b]]\n---\n",
  "---\ntags: [a: b]\n---\n",
  "---\ntags:\n---\n",
  "---\ntags\n---\n",
  "---\ntags:   \n---\n",
  "---\ntags: a\r  b\r\n---\n",
  "---\ntags: a\u2028b\n---\n",
  "---\ntags: a\u0085b\n---\n",
  "---\ntags: a\u0001b\n---\n",
  '---\ntags: "a\u0001b"\n---\n',
  '---\ntags: "a\\u0000b"\n---\n',
  "---\ntags: a\u007fb\n---\n",
  "---\ntags: a\ufeffb\n---\n",
  "---\n\ufefftags: x\n---\n",
  "---\ntags: a\tb\n---\n",
  "---\ntags:\t[a]\n---\n",
  "---\nx: *nope\ntags: [a]\n---\n",
  "---\ntags: *nope\n---\n",
  "---\nx: {a: 1, a: 2}\ntags: [q]\n---\n",
  "---\n{tags: [a, b]}\n---\n",
  "---\n~\n---\n",
  "---\n- a\n---\n",
  "---\ntags: [a, b]\nt: !!timestamp 2020-01-01\n---\n",
  "---\ntags: [a]\nt: !!timestamp nope\n---\n",
  "---\ntags: [a]\nx: !foo y\n---\n",
  "---\n1: a\n1.0: b\ntags: [x]\n---\n",
  "---\n.nan: a\n.nan: b\ntags: [x]\n---\n",
  "---\n0x10: a\n16: b\ntags: [x]\n---\n",
  "---\ntrue: a\nTrue: b\ntags: [x]\n---\n",
  '---\n1: a\n"1": b\ntags: [x]\n---\n',
  "---\n~: a\nnull: b\ntags: [x]\n---\n",
  "---\ntags: a # c\n  b\n---\n",
  "---\ntags: [a # c\n  , b]\n---\n",
  "---\ntags:\n- a\n- b\n---\n",
  "---\ntags:\n  -   a  \n  -\n  - c\n---\n",
  "---\ntags: a:b\n---\n",
  "---\ntags: a: b\n---\n",
  "---\ntags: 'a\n  b'\n---\n",
  '---\ntags: "a\\\n  b"\n---\n',
  "---\n? [a]\n: 1\n? [a]\n: 2\ntags: [x]\n---\n",
  "---\ntags: &x [a]\n---\n",
  "---\ntags: [&x a]\n---\n",
  "---\ntags: [*x]\n---\n",
  "---\ntags: !!seq [a]\n---\n",
  "---\ntags: !!map [a]\n---\n",
  "---\ntags: !!str [a]\n---\n",
  '---\ntags: [a, "#b", c/d, \u5de5\u4f5c, \u{1f600}]\n---\n',
  '---\ntags: ["a b", "c,d", "e\u3000f", "g\u00a0h"]\n---\n',
  "---\ntags: [a/, /b, c//d]\n---\n",
  "---\ntags: [123]\n---\n",
  "---\ntags: ['123']\n---\n",
  '---\ntags: ["' + "a".repeat(200) + '"]\n---\n',
  '---\ntags: ["' + "a".repeat(201) + '"]\n---\n',
  "---\ntitle: T\ntags: [caf\u00e9, cafe\u0301, \u039f\u0394\u039f\u03a3]\n---\n#\u03bf\u03b4\u03bf\u03c2\n",
  "---\na:\n\tb: 1\n---\n",
  "---\nx:\n  y: [1, 2]\n  y: 3\ntags: [q]\n---\n",
  '---\nx: "unterminated\ntags: [q]\n---\n',
  "---\nx: 'a' b\n---\n",
  "---\n%YAML 1.1\n---\n",
  "---\na: 1\n...\ntags: [x]\n---\n",
  "---\ntags: [y]\n...\ntags: [x]\n---\n",
  "---\na: 1\n--- b\n---\n",
  "---\n" + "k: v\n".repeat(3) + "tags: [\u{1f468}\u200d\u{1f469}\u200d\u{1f467}]\n---\n",
  "---\ntags:\n  - \"\u{1f600}\"\n  - '\u{10400}'\n---\n",
  "---\ntags: [a]\n---\n\ufeff`#x` [y](Old.md) #z\n",
];

const INLINE = [
  "#keep #\u5de5\u4f5c/\u5f53\u524d #\u{1f600}\n`#ignore` ``#ignore ` nested``\n\\#ignore 123#ignore #123\n<!-- #ignore\n#ignore -->\n%% #ignore %%\n[[note#ignore]] [note](note#ignore)\n````\n```\n#ignore\n````\n~~~\n#ignore\n~~~\n    #ignore\n",
  "[link](https://example.test/a(b)#old)\nUNSENT\n",
  "[link]: https://example.test/a(b)#old\nUNSENT\n",
  "<https://example.test/a(b)#old>\nUNSENT\n",
  "`%%`\n#old\n",
  "```\n%%\n```\n#old\n",
  "#old #OLD/child #older #keep\n",
  "#cafe\u0301/child\n",
  "#\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} #\u{1f44d}\u{1f3fd}\n",
  "body\n```\ncode\n",
  // Boundaries and forms.
  "#a#b #c",
  "##a # a #",
  "a#b a_#c a/#d a\\#e \u00e9#f 1#g \u{1f600}#h (#i) [#j] -#k .#l",
  "#a/ #/b #a//b #a/b/ #a/b",
  "#123 #12a #1_ #- #_ #\u0661\u0662 #\u2167",
  "#" + "a".repeat(200) + " #" + "a".repeat(201),
  "#" + "\u00e9".repeat(100) + " #" + "\u00e9".repeat(101),
  "#\u200d #a\u200db #\u{1f3fb} #\u0301",
  "#tag\r\n#crlf\r#cr\u2028#ls",
  "\ufeff#bom",
  "text #tag, more #tag. end #tag!",
  "#a\u00a0#b\u3000#c",
  // Code, HTML and links.
  "`#code` #after `x`#adjacent",
  "``#a`` ` #b ` `unclosed #c",
  "    #indented\n#not",
  "- item\n\n      #indented in list\n#not",
  "> ```\n> #in quote fence\n#after quote",
  "* ```\n  #in item fence\n* #next item",
  "<div>\n#in block html\n</div>\n\n#after",
  "<div>#same line</div> #after",
  "<!-- #c -->#t",
  '<a href="#x">#t</a>',
  "<b>#t",
  "x <!-- \n#multi line\n--> #after",
  "<?pi #x?> #y",
  "<![CDATA[ #x ]]> #y",
  "<!DOCTYPE #x> #y",
  "[#text](#dest) ![#alt](#src) #after",
  "[#ref][r] [r] #after\n\n[r]: /url#frag 'title #t'\n",
  "[a](<b c>#x) #y",
  "[a](b (#t)) #y",
  "[a](b '#t') #y",
  "[a](<b<c>) #y",
  "[a](b\u0001c) #y",
  '[a](<b>"t") #y',
  '[a](b( "t") #y',
  "[a](\u000bb) #y",
  "[a]( b ) #y",
  '[a](\n b\n "t"\n) #y',
  "[a](" + "(".repeat(33) + "x" + ")".repeat(33) + ") #y",
  "[a](" + "(".repeat(32) + "x" + ")".repeat(32) + ") #y",
  "[[wiki#tag]] ![[embed#tag|alias]] [[un#closed #real",
  "\\[[escaped#x]] #y",
  "%% a `%%` b %% #after",
  "%% unclosed #hidden",
  "`%%` #visible %% #hidden %% #visible",
  "<!-- %% --> #visible %% #hidden",
  "[a %%](b) #t %% #hidden",
  "~~~~\n~~~\n~~~~\n#t",
  "```\n```",
  "  ```js\n  code #x\n  ```  \nafter #y",
  "a\r```\r#t\r```\rb #u",
  "    code\r#tag",
  "a\r\n```\r\n#t\r\n```\r\nb #u",
  "* a\n\n  ```\n  #x\n  ```\n#y",
  "`a\n#b`",
  "> `a\n> #b` #c",
  "[x]: <a b> '#c'\n#d",
  "[x]:\n/url\n'title'\n#after",
  "[x]: /url 'title' extra #t",
  "\ufeff`#x` #y",
  "Setext #h\n===\n#after",
  "| table | #t |\n|---|---|\n| #c | d |",
  "***#t*** _#u_ **#v**",
  "![[image.png]] ![](img.png) #t",
  "[![Old](Old.md)](Other.md) #t",
  "[see `Old`](Old.md) #t [a `[`](Old.md) #u",
];

// The inputs internal/notes/markdown_test.go and frontmatter_test.go use to
// show where goldmark and yaml.v3 read a note differently from micromark and
// npm yaml, so the oracle holds Basalt's answer for each of them too.
const DIVERGENCES = [
  "x\r\r    #a",
  "- a\r\n-\r\n      #b",
  "-\r\n    #a",
  "[r]: u (()",
  "[r]: u (#x()",
  "[a](b (#x()) #y",
  "[a](\u000cb) #x",
  "[a](b(\n) #x",
  "[](0[0](0 0\r* [0]:00000000000000000000(000)0",
  "[r]:\n#u\n'' x",
  "</script>\n#a",
  "<script/>\n\n#a",
  "<!doctype\n\n#a",
  "x\n<div\t\n#a",
  "</ div>\n#a",
  "x\n<meta>\n#a",
  "> a\n<b>\n> #t",
  "> a\n<b>\n#c",
  "a\n>-\n    #b",
  "    code\n2) x\n\n    #b",
  ">\n    >\n2) x\n\n    #e",
  "[r]: u\n-\n    #a",
  ">\t```\n>\t#a\n>\t```",
  "&Abreve; [a](&Abreve;.md)",
  "- -\n\n    #t",
  "2) a\n<b>\n\n\t#t",
  "- - c\n<b>\n  <e>\n#t",
  "x <!z> #t",
  "> <!--\n    x\n\n2) a\n\n    #t",
  "---\ntags: a\rb: c\n---\n",
  "---\ntags: [a]\nx: p\u0001q\n---\n",
  "---\ntags: [a]\nx: p\ufffeq\n---\n",
  "---\ntags: !!str a # c\n---\n",
  "---\ntags:\n  - !!str b   # c\n  - 'q' \n---\n",
  "---\ntags: a\nx: {k: 1, k: 2}\n---\n",
  "---\ntags: [a]\nb: &k: c\n---\n",
  "---\ntags: [a]\nb: &k c\nd: *k:\n---\n",
  "---\ntags: [a]\nb: &k.x c\nd: *k.x\n---\n",
  "---\ntags: [a]\nb: &k:x c\n---\n",
  "---\ntags: [a]\nb: &\u00e9 c\nd: [*\u00e9]\n---\n",
  "---\ntags: [a]\nb: !!str &k.x c\n---\n",
  "---\ntags: [a]\ndescription: a long\n  *important* note\n---\n",
  "---\ntags: [a]\ntitle: Notes, *draft*\n---\n",
  "---\ntags: [a]\nb: [c\n  *d.e]\n---\n",
  "---\ntags: [a]\nb: |\n  x\n\t\n  y\n---\n",
  "---\na:\n\t\nb: c\ntags: [x]\n---\n",
  '---\ntags: [x]\na: "p\n\t\n q"\n---\n',
  "---\ntags: [a]\n\t\nb: c\n---\n",
  "---\ntags:\n-\ta\n---\n",
  "---\n?\ttags\n:\t[a]\n---\n",
  '---\na: "x\n\ty"\ntags: [x]\n---\n',
  "---\na: [x,\n\ty]\ntags: [x]\n---\n",
  "---\ntags:\n  - a\n\t# c\n---\n",
  "---\ntags:\n  - a\n  \t# c\n---\n",
  "---\na: |\n  x\n\t# c\ntags: [x]\n---\n",
  "---\ntags:\n  - |\n    a\n  # m\n\t# c\n---\n",
  "---\ntags: 'x'# c\n---\n",
  "---\ntags: [x]# c\n---\n",
  "---\ntags: [x,# c\n  y]\n---\n",
  '---\na: "b\n  c"#d\ntags: [y]\n---\n',
  "---\na: 1\n--- b\ntags: [x]\n---\n",
  '---\ntags: [a]\n...\n"x\n---\n',
  "---\n# c\n--- !!map\ntags: [a]\n--- b: c\n---\n",
  "---\n# c\n--- tags: [a]\n--- b: c\n---\n",
  "---\n# c\n--- [a]\n--- b: c\n---\n",
  "---\ntags: [a]\n--- \n- x: [\n---\n",
  "---\n...\ntags: [a]\n---\n",
];

/** Everything the read side derives from one note, in one record. */
function noteVector(source: string) {
  const attempt = <T>(f: () => T): T | { error: string } => {
    try {
      return f();
    } catch (error) {
      return failure(error);
    }
  };
  let body = 0;
  try {
    body = frontmatter(source).body;
  } catch {
    body = 0;
  }
  const hidden: unknown[] = [];
  for (const start of new Set([0, body]))
    for (const protectLinks of [false, true])
      hidden.push([
        start,
        protectLinks,
        markdownHidden(source, start, protectLinks).map((r) => [r.start, r.end]),
      ]);
  return {
    source,
    frontmatter: attempt(() => frontmatter(source)),
    tags: attempt(() => tagOccurrences(source)),
    hidden,
    links: attempt(() => linkSpans(source)),
  };
}

// Random Markdown: lines built from container prefixes, block openers and
// inline pieces, so that code, HTML, links and comments open and close in
// combinations nobody wrote by hand.
function randomMarkdown(): string {
  const prefixes = [
    "",
    "",
    "",
    "",
    " ",
    "  ",
    "   ",
    "    ",
    "\t",
    "> ",
    ">",
    "> > ",
    "- ",
    "* ",
    "1. ",
    "2) ",
    "  - ",
    "- - ",
    ">- ",
  ];
  const openers = [
    "```",
    "````",
    "~~~",
    "``` js",
    "~~~ `x`",
    "```#t",
    "<div>",
    "</div>",
    "<pre>",
    "</pre>",
    "<script>",
    "</script>",
    "<style>",
    "<!--",
    "-->",
    "<?php",
    "?>",
    "<!X",
    "<![CDATA[",
    "]]>",
    "<table>",
    "<custom-el a='1'>",
    "# ",
    "## ",
    "---",
    "***",
    "===",
    "[r]: /u#f",
    "[r]: <u v> 't'",
    "[r]:",
    "| a | b |",
  ];
  const inline = [
    "#tag",
    "#t/x",
    "#\u00e9",
    " ",
    "  ",
    "`",
    "``",
    "`#c`",
    "`` ` ``",
    "<b>",
    "</b>",
    '<a href="#x">',
    "<a href='x' b=c>",
    "<!-- #c -->",
    "<!-->",
    "<?x #y?>",
    "<!DOCTYPE x>",
    "<![CDATA[#z]]>",
    "%%",
    "[a](b#c)",
    "[a](<b c>)",
    "[a](b (c))",
    "[a](b 'c')",
    "![i](s#t)",
    "[r]",
    "[r][]",
    "[x][r]",
    "<http://a.b/#c>",
    "<a@b.c>",
    "[[w#t]]",
    "![[e|f]]",
    "\\",
    "\\#",
    "\\`",
    "&#35;",
    "&amp;",
    "**",
    "_",
    "\u{1f600}",
    "(",
    ")",
    "[",
    "]",
    "<",
    ">",
    "x",
    "word",
  ];
  const count = 1 + Math.floor(random() * 8);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let line = pick(prefixes);
    if (random() < 0.35) line += pick(openers);
    const pieces = Math.floor(random() * 6);
    for (let j = 0; j < pieces; j++) line += pick(inline);
    out.push(line);
  }
  const newline = pick(["\n", "\n", "\n", "\r\n", "\r"]);
  return out.join(newline) + (random() < 0.5 ? newline : "");
}

// Random frontmatter: a few properties of assorted YAML shapes, some valid
// and many not, followed by a body with hashtags.
function randomFrontmatter(): string {
  const keys = [
    "tags",
    "tags",
    "tags",
    "title",
    "a",
    '"tags"',
    "'tags'",
    "tags ",
    "1",
    "~",
    "true",
    "? tags\n",
    "!!str tags",
    "&k tags",
    "*k",
  ];
  const values = [
    "[a, b]",
    "[a, b ,c]",
    "a b",
    "a, b",
    '"a, b"',
    "'a'",
    "|\n  a\n  b",
    "|+\n  a\n\n",
    ">-\n  a b\n  c",
    "\n  - a\n  - b",
    "\n- a\n- b",
    "\n  -   a  \n  -\n  - c",
    "~",
    "",
    "  ",
    "!!str 12",
    "!!str a",
    "! b",
    "&x [a]",
    "*x",
    "[&y a]",
    "[*y]",
    "[a, [b]]",
    "{a: b}",
    "[a: b]",
    "a # c",
    "a #b",
    "a#b",
    '"unterminated',
    "a: b",
    "[a,\n  b]",
    "a\n  b",
    "!foo x",
    "2024-01-01",
    "0x1F",
    "1e3",
    ".5",
    "yes",
    "null",
    "\u5de5\u4f5c",
    "\u{1f600}",
    "caf\u00e9",
    "'it''s'",
    '"\\u0041\\t"',
    "a\tb",
    "\ta",
    "[\u00e9, \u{1f600}]",
    "123",
    "[1, a]",
    "a/b c//d e/",
  ];
  const lines: string[] = [];
  const count = 1 + Math.floor(random() * 4);
  for (let i = 0; i < count; i++) {
    const key = pick(keys);
    const value = pick(values);
    lines.push(
      key.endsWith("\n")
        ? key + ": " + value
        : key + ":" + (value.startsWith("\n") ? "" : " ") + value,
    );
    if (random() < 0.2) lines.push(pick(["# comment", "", "  ", "  # indented", "\t"]));
  }
  const newline = random() < 0.2 ? "\r\n" : "\n";
  return ["---", ...lines, "---", "#body #tags text"].join(newline) + newline;
}

// Random frontmatter with anchors and aliases: names libyaml reads
// differently from npm yaml, in each place a property can stand, and plain
// values whose continuation lines start with "*" or "&".
const anchorRandom = mulberry32(0xa5c4);
function randomAnchors(): string {
  const choose = <T>(list: readonly T[]): T => list[Math.floor(anchorRandom() * list.length)]!;
  const names = [
    "k",
    "k",
    "k.x",
    "k:x",
    "k:",
    "\u00e9",
    "k#x",
    "k*",
    "a-b_c",
    "x%",
    "k'x",
    "k!x",
    "k&x",
    "",
  ];
  const anchor = () => "&" + choose(names);
  const alias = () => "*" + choose(names);
  const shapes = [
    () => `a: ${anchor()} v`,
    () => `a: ${alias()}`,
    () => `a: [${anchor()} v, ${alias()}]`,
    () => `a: {${anchor()} k: v, b: ${alias()}}`,
    () => `${anchor()} k: v`,
    () => `${alias()} : v`,
    () => `a: !!str ${anchor()} v`,
    () => `a: ${anchor()} !!str v`,
    () => `a: ${anchor()}\n  - x`,
    () => `a: ${anchor()} |\n  x`,
    () => `a: long text\n  ${alias()} more`,
    () => `a: long text\n  ${anchor()} more`,
    () => `a: x, ${alias()}`,
    () => `a: x - ${alias()}`,
    () => `a: [x\n  ${alias()}]`,
    () => `a:\n  ${anchor()} v`,
    () => `a:\n  - ${alias()}`,
    () => `tags: ${anchor()} [x]`,
    () => `tags: [${alias()}]`,
    () => `tags: ${alias()}`,
    () => `tags: [x, ${anchor()} y]`,
    () => `a: '${alias()}'`,
    () => `a: "q\n  ${alias()} r"`,
    () => `a: v # ${alias()}`,
    // A colon before a flow indicator, and implicit keys over lines.
    () => choose(["tags: [x:]", "tags: [x:, y]", "tags: [x::]", "tags: [!!str x:]", "tags: [x: ]"]),
    () => choose(["a: [x:]", "a: {x:}", "a: [x\n  y:]", "a: [x\n  y: z]", "a: {x\n  y: z}"]),
  ];
  const lines = anchorRandom() < 0.7 ? ["tags: [t]"] : [];
  const count = 1 + Math.floor(anchorRandom() * 4);
  for (let i = 0; i < count; i++)
    lines.splice(Math.floor(anchorRandom() * (lines.length + 1)), 0, choose(shapes)());
  return ["---", ...lines, "---", "#body"].join("\n") + "\n";
}

// Random tags properties, for the edit that rewrites one: block lists with
// comments, blank lines and empty items in every place, flow lists over
// lines, block scalars with header comments, empty values with properties,
// at several indentations, between other properties, with LF or CRLF.
const tagsRandom = mulberry32(0x7a95);
function randomTagsProperty(): string {
  const choose = <T>(list: readonly T[]): T => list[Math.floor(tagsRandom() * list.length)]!;
  const items = [
    "a",
    "b",
    "'c'",
    '"d e"',
    "~",
    "",
    "!!str f",
    "|\n    g",
    ">-\n    h i",
    "| # hh\n    j",
    "t/x",
    "caf\u00e9",
    "a b",
    "'#y'",
    "k\n    l",
  ];
  const trailing = ["", "", "", " ", "  # c", "\t# c", " #c", " # c  "];
  const between = ["", "", "", "\n", "\n  # m", "\n# m", "\n    # m", "\n  ", "\n\t"];
  const indent = choose(["  ", "  ", "    ", " ", ""]);
  const count = Math.floor(tagsRandom() * 4);
  const list = Array.from({ length: count }, () => choose(items));
  let value: string;
  switch (choose(["block", "block", "flow", "scalar", "empty"])) {
    case "block":
      value =
        choose(["", "", " # h", " !!seq"]) +
        (count ? "" : "\n" + indent + "-") +
        list
          .map(
            (item) =>
              "\n" + indent + "-" + (item ? " " + item : "") + choose(trailing) + choose(between),
          )
          .join("");
      break;
    case "flow": {
      const separator = choose([", ", ",", ",\n  ", " # c\n  , ", "\n  , "]);
      const flow = list.filter(
        (item) => !item.includes("\n") && item !== "" && !item.startsWith("!!"),
      );
      value =
        " [" + choose(["", " ", "\n  "]) + flow.join(separator) + choose(["", " ", "\n"]) + "]";
      break;
    }
    case "scalar":
      value =
        " " +
        choose(["a b", "'a, b'", "|\n  a\n  b", "| # h\n  a", ">-\n  a", "~", "!!str a", "a\n  b"]);
      break;
    default:
      value = choose(["", " ", "  # c", " !!null", " !!str", "\n# c"]);
  }
  value += choose(trailing);
  const others = [
    "title: x",
    "a: [1]",
    "# comment",
    "",
    "next: y",
    "  # indented",
    "deep:\n  k: v",
  ];
  const lines = [
    ...Array.from({ length: Math.floor(tagsRandom() * 2) }, () => choose(others)),
    choose(["tags:", "tags:", "tags :", "'tags':", "? tags\n:"]) + value,
    ...Array.from({ length: Math.floor(tagsRandom() * 3) }, () => choose(others)),
  ];
  const newline = tagsRandom() < 0.2 ? "\r\n" : "\n";
  const body = choose(["", "#a #b\n", "text #t", "```\ncode #a\n", "#a/b #c"]);
  return (["---", ...lines, "---"].join("\n") + "\n" + body).replace(/\n/gu, newline);
}

function tagVectors() {
  const notes: unknown[] = [];
  const add = (source: string, kind: TagKind = "frontmatter") => {
    notes.push(noteVector(source));
    tagCorpus.push({ source, kind });
  };
  for (const s of FRONTMATTER) add(s);
  for (const s of INLINE) add(s);
  for (const s of DIVERGENCES) add(s);
  for (const s of MULTILINGUAL) add(s);
  for (const s of LINKS) add(s);
  add(MULTILINGUAL.map((s) => "#" + s.split(" ")[0]).join(" "));
  // Generated Markdown: fragments that open and close code, HTML, links
  // and comments, shuffled.
  const pieces = [
    "#t ",
    "`",
    "``",
    "```\n",
    "~~~\n",
    "    ",
    "\n",
    "\n\n",
    "<b>",
    "</b>",
    "<!--",
    "-->",
    "%%",
    "[a](b#c)",
    "[a]",
    "(x)",
    "[[w#t]]",
    "\\",
    "> ",
    "- ",
    "\u00e9",
    "\u{1f600}",
    "\r\n",
    "\r",
    "&#35;",
    "#",
    "x",
  ];
  for (let n = 0; n < 120; n++)
    add(
      Array.from({ length: 5 + Math.floor(random() * 30) }, () => pick(pieces)).join(""),
      "markdown",
    );
  // ORACLE_EXTRA=n adds n more of each generated kind, for a deeper search
  // for divergences than the committed fixture carries (write it elsewhere
  // with ORACLE_OUT, and point the Go test at it with MCP_FIXTURES).
  const extra = Number(process.env["ORACLE_EXTRA"] ?? 0);
  for (let n = 0; n < 600 + extra; n++) add(randomMarkdown(), "markdown");
  for (let n = 0; n < 400 + extra; n++) add(randomFrontmatter());
  for (let n = 0; n < 300 + extra; n++) add(randomAnchors(), "anchors");
  for (let n = 0; n < 300 + extra; n++) add(randomTagsProperty());

  const inline: unknown[] = [];
  for (const s of INLINE.slice(0, 20))
    for (const start of [0, 1, 5]) {
      // A start between the halves of a surrogate pair is not a place a
      // caller can name; skip it.
      const unit = s.charCodeAt(start);
      if (unit >= 0xdc00 && unit <= 0xdfff) continue;
      inline.push({ source: s, start, want: inlineTags(s, start) });
    }

  const validations: unknown[] = [];
  for (const input of [
    "a",
    "#a",
    "##a",
    "",
    "#",
    "123",
    "1a",
    "a/b",
    "/a",
    "a/",
    "a//b",
    "a b",
    "a-b_c",
    "\u5de5\u4f5c",
    "\u{1f600}",
    "\u{1f44d}\u{1f3fd}",
    "\u{1f3fd}",
    "\u200d",
    "a\u200db",
    "\u0301",
    "\u0661",
    "\u2167",
    "a".repeat(200),
    "a".repeat(201),
    "\u00e9".repeat(100),
    "\u00e9".repeat(101),
    "a*",
    "#a#b",
    "caf\u00e9",
    "cafe\u0301",
  ]) {
    try {
      validations.push({ input, want: validateTag(input) });
    } catch (error) {
      validations.push({ input, want: failure(error) });
    }
  }
  const matches: unknown[] = [];
  const names = [
    "a",
    "A",
    "a/b",
    "A/B",
    "ab",
    "caf\u00e9",
    "cafe\u0301",
    "CAF\u00c9",
    "\u039f\u0394\u039f\u03a3",
    "\u03bf\u03b4\u03bf\u03c2",
    "\u03bf\u03b4\u03bf\u03c3",
    "\u039f\u0394\u039f\u03a3/x",
    "\u03bf\u03b4\u03bf\u03c2/x",
    "\u0130",
    "i\u0307",
    "\u1e9e",
    "\u00df",
    "\u212a",
    "k",
  ];
  for (const candidate of names)
    for (const selected of names)
      for (const children of [false, true])
        matches.push({
          candidate,
          selected,
          children,
          want: matchesTag(candidate, selected, children),
        });
  const patterns: unknown[] = [];
  const globs = [
    ["proj*/done", "Project/done"],
    ["project/*", "project/a/b"],
    ["project/*", "other/a"],
    ["(a+)+$", "a"],
    ["**", "a"],
    ["*", ""],
    ["*", "anything/at/all"],
    ["a*b*c", "aXbYc"],
    ["a*b*c", "aXbY"],
    ["#a", "a"],
    ["\u{1f600}*", "\u{1f600}x"],
    ["*\u{1f600}", "x\u{1f600}"],
    ["CAF\u00c9*", "cafe\u0301/x"],
    ["\u039f\u0394\u039f\u03a3", "\u03bf\u03b4\u03bf\u03c2"],
    ["a".repeat(201), "a"],
    ["", "a"],
    ["a b", "a"],
    ["*a*", "banana"],
    ["*ab", "aab"],
  ] as const;
  for (const [pattern, value] of globs) {
    try {
      patterns.push({ pattern, value, want: tagPattern(pattern, value) });
    } catch (error) {
      patterns.push({ pattern, value, want: failure(error) });
    }
  }
  return { notes, inline, validateTag: validations, matchesTag: matches, tagPattern: patterns };
}

// ---------------------------------------------------------------------------
// Links (mcp-links.ts).

const LINKS = [
  // mcp-links.test.ts
  '\ufeff[Old.md](Old.md "Old.md")\r\n![[Old#Section|Old]] [[Old.md#^block]]\r\nUNSENT body\r\n',
  '---\nproperty: "[[Old]]"\n---\n`[[Old]]`\n```md\n[Old](Old.md)\n```\n<!-- [[Old]] -->\n%% [[Old]] %%\n\\[[Old]] [[Old]]',
  "[label [nested]](Old\\(Note\\).md 'title')",
  "[label [nested]](Old&#32;Note.md 'title')",
  "[label [nested]](<Old Note.md> 'title')",
  "[label [nested]](Old%20Note.md 'title')",
  '[Old][old]\n![Old][old]\n\n[old]: Old.md "Old.md"\n',
  "[[Old]] [[One/Old]]",
  "[B](B.md#Heading) ![](images/x.png) [[B]]",
  "[note](Old.md#Heading) [[Old]] [self](#Section)",
  "[[Old|label]] [text](Old.md)",
  "[see `Old`](Old.md)",
  "[a `[`](Old.md)",
  "[![Old](Old.md)](Other.md)",
  "[x](Old&#32;Note.md#A&#32;B)",
  "[x](Old&#32;Note.md&#35;A&#32;B)",
  "[[Old]] [old](Old)",
  "[planned](Future.md) ![](images/future.png)",
  // More destinations.
  "[a](b(c)d) [e](f(g) [h](i\\(j) [k](<l)m>)",
  "[a](b#c#d) [e](f\\#g) [h](i&num;j) [k](l&#x23;m) [n](o&#X23;p)",
  "[a](<>) [b]() [c](<d>)",
  '[a](<b<c>) [d](e\u0001f) [g](<h>"i") [j](k( "l")',
  "[a](" +
    "(".repeat(33) +
    "x" +
    ")".repeat(33) +
    ") [b](" +
    "(".repeat(32) +
    "y" +
    ")".repeat(32) +
    ")",
  "[a]: " + "(".repeat(40) + "x" + ")".repeat(40) + "\n",
  '[a](\n  b.md\n  "t"\n) [c](\td.md\t)',
  "[x]: <a b> 'c'\n[y]:\n/z.md\n'w'\n[v]: /u 'title' extra\n",
  "[x]: /u.md  \t\n[y]: /v.md 't'  \n",
  "[[a]] ![[b]] [[c|d]] [[e#f|g]] [[h\\|i]] [[j]x]] [[k\nl]]",
  "\\[[a]] \\\\[[b]] \\\\\\[[c]]",
  '`[a](b)` <a href="c">[d](e)</a> %% [f](g) %% [h](i)',
  "[a [[b]] c](d) [[e [f](g) h]]",
  '[a](b "t") [c](d \'t\') [e](f (t)) [g](h "t\\"u")',
  "[caf\u00e9](caf\u00e9.md) [cafe](cafe\u0301.md) [\u{1f600}](\u{1f600}.md)",
  "[a](http://x.test/y#z) [b](mailto:a@b.c) [c](//host/x) [d](/abs.md) [e](../up.md)",
  "[a](%E2%82%AC.md) [b](%ZZ.md) [c](%ED%A0%80.md) [d](a%2Fb.md)",
  "<http://auto.link#x> <a@b.c> [a](<http://x>)",
  "[a][b]\n\n[b]: /ref.md#frag\n[c]: </ref two.md>\n",
  "---\ntags: [a]\n---\n[x](Old.md)",
  "---\nunclosed\n[x](Old.md)",
  "---\ntags: [a]\n---\n\ufeff[x](Old.md) [[Old]]",
  "\r[a](b)\r[[c]]\r",
  "> [a](b)\n> [[c]]\n- [d](e)\n  [[f]]",
  "    [a](b) [[c]]\n\n```\n[d](e)\n```",
];

function linkVectors() {
  const canonical = (path: string) => path.normalize("NFC").toLowerCase();
  const inventories = [
    [
      "Index.md",
      "Old.md",
      "One/Old.md",
      "Two/Old.md",
      "Project/A.md",
      "Project/B.md",
      "Project/images/x.png",
    ],
    [
      "caf\u00e9.md",
      "Caf\u00e9/Note.md",
      "notes.txt",
      "Notes.MD",
      "a b.md",
      "deep/er/x.md",
      "x.md",
    ],
  ];
  const names = [
    "Old",
    "Old.md",
    "old.MD",
    "One/Old",
    "/One/Old.md",
    "../One/Old.md",
    "./Old.md",
    "Old.txt",
    "x",
    "x.md",
    "er/x",
    "deep/er/x",
    "/x",
    "http://x",
    "Mailto:x",
    "//x",
    "",
    "a b",
    "caf\u00e9",
    "cafe\u0301",
    "CAF\u00c9",
    "notes",
    "Notes",
    "Project/B",
    "B",
    "images/x.png",
    "../../x.md",
    "a/../x.md",
    "Old/",
  ];
  const owners = ["Index.md", "Project/A.md", "deep/er/y.md", "Two/z.md"];
  const resolve: unknown[] = [];
  for (const inventory of inventories) {
    const resolver = linkResolver(inventory, canonical);
    const queries: unknown[] = [];
    for (const name of names)
      for (const wiki of [false, true])
        for (const owner of owners)
          queries.push({ name, wiki, owner, want: resolver(name, wiki, owner) });
    resolve.push({ inventory, queries });
  }
  const changes: unknown[] = [];
  const cases: { source: string; change: Omit<LinkChange, "canonical"> }[] = [];
  const moved = (source: string, change: Partial<Omit<LinkChange, "canonical">> = {}) =>
    cases.push({
      source,
      change: {
        path: "Index.md",
        from: "Old.md",
        to: "Folder/New.md",
        inventory: ["Index.md", "Old.md"],
        ...change,
      },
    });
  // mcp-links.test.ts, as it calls changeLinks.
  moved(LINKS[0]!);
  moved(LINKS[1]!);
  moved(LINKS[2]!, { from: "Old(Note).md", inventory: ["Old(Note).md"] });
  moved(LINKS[3]!, { from: "Old Note.md", inventory: ["Old Note.md"] });
  moved(LINKS[4]!, { from: "Old Note.md", inventory: ["Old Note.md"] });
  moved(LINKS[5]!, { from: "Old Note.md", inventory: ["Old Note.md"] });
  moved(LINKS[6]!);
  moved(LINKS[7]!, { from: "One/Old.md", inventory: ["One/Old.md", "Two/Old.md"] });
  moved(LINKS[8]!, {
    path: "Project/A.md",
    from: "Project/A.md",
    to: "Archive/A.md",
    inventory: ["Project/A.md", "Project/B.md", "Project/images/x.png"],
  });
  moved(LINKS[9]!, { to: "New (copy)#name.md" });
  moved(LINKS[10]!, { to: undefined });
  moved(LINKS[11]!);
  moved(LINKS[12]!);
  moved(LINKS[13]!);
  moved(LINKS[14]!, { from: "Old Note.md", inventory: ["Old Note.md"] });
  moved(LINKS[15]!, { from: "Old Note.md", inventory: ["Old Note.md"] });
  moved(LINKS[16]!, { to: "New.txt", inventory: ["Old.md", "New.md"] });
  moved(LINKS[17]!, {
    path: "Project/A.md",
    from: "Project/A.md",
    to: "Archive/A.md",
    inventory: ["Project/A.md"],
  });
  // Every other link corpus entry, as a move and as a deletion.
  for (const source of LINKS.slice(18)) {
    moved(source, { inventory: ["Index.md", "Old.md", "b", "d.md", "Other.md"] });
    moved(source, { to: undefined, from: "Old.md", inventory: ["Index.md", "Old.md", "b"] });
  }
  moved("[a](Old.md) [[Old]]", { to: "New|pipe[x].md" });
  moved("[a](Old.md) [[Old]]", { to: "sp ace/\u00e9.md" });
  moved("[a](Old.md) [[Old]]", {
    to: "Folder/Old.md",
    inventory: ["Index.md", "Old.md", "Folder/Other.md"],
  });
  moved("[a](./Old.md) [b](/Old.md) [[/Old]]");
  moved("[a](Old.md#x) [[Old#y|z]] [[Old]]", { to: "Deep/er/New.md", path: "Deep/Index.md" });
  moved("[a](New.md) [[New]]", { inventory: ["Index.md", "Old.md", "New.md"], to: "Other/New.md" });
  for (const { source, change } of cases) {
    const full: LinkChange = { ...change, canonical };
    try {
      changes.push({ source, change, want: changeLinks(source, full) });
    } catch (error) {
      changes.push({ source, change, want: failure(error) });
    }
  }
  const decoding: unknown[] = [];
  for (const input of [
    "\\#\\\\\\a\\ ",
    "&amp;&AMP;&Amp;&amp",
    "&#35;&#x23;&#X23;&#0035;",
    "&#0;&#1;&#8;&#9;&#10;&#11;&#12;&#13;&#14;&#31;&#32;&#126;&#127;&#159;&#160;",
    "&#55295;&#55296;&#57343;&#57344;&#64975;&#64976;&#65007;&#65008;&#65534;&#65535;",
    "&#x1FFFE;&#x10FFFF;&#x110000;&#9999999;&#12345678;&#x1234567;",
    "&notin;&notit;&ThickSpace;&nbsp;&NotANamedEntity;&" + "a".repeat(32) + ";",
    "a%20b &#x;&#;&;",
  ])
    decoding.push({ input, want: decodeString(input) });
  return { resolve, changeLinks: changes, decodeString: decoding };
}

// ---------------------------------------------------------------------------
// The write side: exact edits (prepareNote in mcp-notes.ts), tag edits
// (changeTags in mcp-markdown.ts), and operation plans (previewOperation and
// samePlan in mcp-operations.ts).

/**
 * A string as the fixture carries it. One with a lone surrogate is written as
 * the bytes a Go string holds it in, WTF-8: a Go string cannot hold a
 * surrogate as UTF-8, and JSON decoding would replace it.
 */
function wtf8(s: string): Text {
  if (!/\p{Surrogate}/u.test(s)) return s;
  const out: number[] = [];
  // for..of yields code points, and a lone surrogate as itself.
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return bytesText(new Uint8Array(out));
}

/** An error the write side reports, by the code its tools gave it. */
function writeFailure(error: unknown): { error: string } {
  if (error instanceof NoteError || error instanceof CheckedPathError) return { error: error.code };
  throw error;
}

type NoteInput = string | Uint8Array | { repeat: [string, number][] };
function noteInput(n: NoteInput): { text: Text; bytes: Uint8Array } {
  if (n instanceof Uint8Array) return { text: bytesText(n), bytes: n };
  if (typeof n === "string") return { text: n, bytes: enc.encode(n) };
  const r = repeatText(n.repeat);
  return { text: r.text, bytes: enc.encode(r.value) };
}

/** A string an edit supplies: itself, or pieces to repeat when it is long. */
type Piece = string | { repeat: [string, number][] };
const rep = (s: string, n: number): Piece => ({ repeat: [[s, n]] });
const pieceValue = (p: Piece): string => (typeof p === "string" ? p : repeatText(p.repeat).value);
const pieceText = (p: Piece): Text => (typeof p === "string" ? wtf8(p) : p);

type EditRequest =
  | { kind: "edit"; edits: { old: Piece; new: Piece }[] }
  | { kind: "append" | "prepend"; text: Piece };

function editCases(): { note: NoteInput; request: EditRequest }[] {
  const edit = (note: NoteInput, ...edits: [Piece, Piece][]) => ({
    note,
    request: { kind: "edit" as const, edits: edits.map(([old, n]) => ({ old, new: n })) },
  });
  const insert = (kind: "append" | "prepend", note: NoteInput, text: Piece) => ({
    note,
    request: { kind, text },
  });
  const daily =
    "# Daily\r\n\r\n- [ ] Book tickets\r\n- [ ] Pack bags\r\n\r\nUNSENT: call the school\r\n";
  const tasks =
    "\ufeff---\r\ntags: [daily]\r\n---\r\n[[Family]] cafe\u0301 \u{1f600}\r\n- [ ] Book tickets\r\n- [ ] Pack bags\r\nUNSENT end\r\n";
  const many = (n: number, old: Piece, text: Piece) => ({
    note: daily,
    request: {
      kind: "edit" as const,
      edits: Array.from({ length: n }, () => ({ old, new: text })),
    },
  });
  const near = NOTE_BYTES - 10;
  return [
    // mcp-notes.test.ts
    insert("prepend", "\ufeffUNSENT original\r\n", "Heading\r\n"),
    edit(
      tasks,
      ["- [ ] Pack bags", "- [x] Pack bags"],
      ["- [ ] Book tickets", "- [x] Book tickets"],
    ),
    edit(daily, ["UNSENT: call the school\r\n", ""]),
    edit(daily, ["- [ ] Book tickets", "done"], ["missing", "lost"]),
    edit(daily, ["[ ]", "[x]"]),
    edit(daily, ["Book tickets", "Booked"], ["tickets", "seats"]),
    edit(daily, ["", "blank"]),
    edit(daily),
    many(33, "Book", "done"),
    edit(daily, ["Book", rep("x", 8193)]),
    edit(daily, ["Book", "\ud800"]),
    edit("aaaa", ["aaa", "b"]),
    {
      note: Array.from({ length: 9 }, (_, i) => `unique-${i}`).join("\n"),
      request: {
        kind: "edit" as const,
        edits: Array.from({ length: 9 }, (_, i) => ({ old: `unique-${i}`, new: rep("x", 8192) })),
      },
    },
    insert("append", "source", "\r\nexact suffix"),
    insert("append", "source", "suffix"),
    insert("append", new Uint8Array([0xff, 0xfe]), "suffix"),
    insert("append", "original", "\udfff"),
    insert("append", { repeat: [["x", NOTE_BYTES]] }, "suffix"),
    edit("unchanged", ["unchanged", "unchanged"]),
    // Counting, order and bounds.
    many(32, "Book", "done"),
    many(2, "Book", "done"),
    edit(daily, ["missing", "x"], ["Book", "\ud800"]),
    edit(daily, ["Book", "\ud800"], ["missing", "x"]),
    edit(daily, ["\udc00", "x"]),
    edit(daily, ["", "\ud800"]),
    edit(daily, [rep("x", 8193), "y"]),
    edit(rep("\u00e9", 4097), [rep("\u00e9", 4097), "y"]),
    edit(
      {
        repeat: [
          ["a", 8192],
          ["|", 1],
        ],
      },
      [rep("a", 8192), rep("b", 8192)],
    ),
    edit(
      Array.from({ length: 5 }, (_, i) => `k${i}`).join(" "),
      ...Array.from({ length: 4 }, (_, i): [Piece, Piece] => [`k${i}`, rep("\u00e9", 4096)]),
    ),
    edit(
      Array.from({ length: 5 }, (_, i) => `k${i}`).join(" "),
      ...Array.from({ length: 4 }, (_, i): [Piece, Piece] => [`k${i}`, rep("\u00e9", 4095)]),
    ),
    edit("abcdef", ["abc", "X"], ["def", "Y"]),
    edit("abcdef", ["def", "Y"], ["abc", "X"]),
    edit("abcdef", ["abc", "X"], ["abc", "Y"]),
    edit("abcdef", ["abcd", "X"], ["bc", "Y"]),
    edit("abcdef", ["cd", "X"], ["abcdef", "Y"]),
    edit("\ufeffabc", ["\ufeffa", "Z"]),
    edit("\ufeffabc", ["\ufeff", ""]),
    edit("a\r\nb\r\nc", ["a\r\nb", "ab"]),
    edit("cafe\u0301 caf\u00e9", ["e", "E"]),
    edit("cafe\u0301 caf\u00e9", ["\u00e9", "E"]),
    edit("x\u{1f600}y\u{1f600}z", ["y\u{1f600}", "\u{1f44d}\u{1f3fd}"]),
    edit("x\u{1f600}y\u{1f600}z", ["\u{1f600}", "-"]),
    edit("one two", ["one", "one"], ["two", "two"]),
    edit("one two", ["one", "two"], ["two", "one"]),
    edit("one two", ["one", "one two"]),
    edit("", ["a", "b"]),
    edit(new Uint8Array([0x61, 0xc3]), ["a", "b"]),
    edit({ repeat: [["x", NOTE_BYTES + 1]] }, ["x", "y"]),
    edit(
      {
        repeat: [
          ["x", near],
          ["END", 1],
        ],
      },
      [
        "END",
        {
          repeat: [
            ["END", 1],
            ["y", 7],
          ],
        },
      ],
    ),
    edit(
      {
        repeat: [
          ["x", near],
          ["END", 1],
        ],
      },
      [
        "END",
        {
          repeat: [
            ["END", 1],
            ["y", 8],
          ],
        },
      ],
    ),
    insert("append", "", "text"),
    insert("prepend", "", "text"),
    insert("prepend", "\ufeff", "text"),
    insert("prepend", "\ufeffbody", "\ufeffnew"),
    insert("prepend", "body\ufeff", "new"),
    insert("prepend", "body", "new\r\n"),
    insert("append", "body", ""),
    insert("prepend", "body", ""),
    insert("prepend", "body", "\ud800x"),
    insert("append", "body", rep("x", INPUT_BYTES)),
    insert("append", "body", rep("x", INPUT_BYTES + 1)),
    insert("prepend", "body", rep("\u00e9", INPUT_BYTES / 2 + 1)),
    insert("append", { repeat: [["x", NOTE_BYTES - 4]] }, "four"),
    insert("append", { repeat: [["x", NOTE_BYTES - 4]] }, "five!"),
    insert(
      "prepend",
      {
        repeat: [
          ["\ufeff", 1],
          ["x", NOTE_BYTES - 7],
        ],
      },
      "four",
    ),
    insert("append", new Uint8Array([0xed, 0xa0, 0x80]), "x"),
    insert("append", new Uint8Array([0xc0, 0xaf]), "x"),
    insert("prepend", { repeat: [["x", NOTE_BYTES + 1]] }, "x"),
  ];
}

async function editVectors() {
  const root = await mkdtemp(join(tmpdir(), "trew-oracle-edit-"));
  const out: unknown[] = [];
  try {
    const vault = new NodeVault(root);
    // A byte-order mark is kept, as Basalt's own decoder kept it.
    const dec = new TextDecoder("utf-8", { ignoreBOM: true });
    for (const { note, request } of editCases()) {
      const { text, bytes } = noteInput(note);
      await writeFile(join(root, "note.md"), bytes);
      const mutation = {
        ...(request.kind === "edit"
          ? {
              kind: "edit",
              edits: request.edits.map((e) => ({ old: pieceValue(e.old), new: pieceValue(e.new) })),
            }
          : { kind: request.kind, text: pieceValue(request.text) }),
        path: "note.md",
        base: noteDigest(bytes),
      } as NoteMutation;
      let want: unknown;
      try {
        const plan = await prepareNote(vault, mutation);
        want = { text: big(dec.decode(plan.proposed!)), noop: plan.result.noop === true };
      } catch (error) {
        want = writeFailure(error);
      }
      out.push({
        note: text,
        request:
          request.kind === "edit"
            ? {
                kind: "edit",
                edits: request.edits.map((e) => ({ old: pieceText(e.old), new: pieceText(e.new) })),
              }
            : { kind: request.kind, text: pieceText(request.text) },
        want,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return out;
}

// Every note the read side's tag vectors were built from, and which kind of
// note it is: the generated Markdown has no frontmatter to edit, and the
// generated anchors are about reading one.
type TagKind = "frontmatter" | "markdown" | "anchors";
const tagCorpus: { source: string; kind: TagKind }[] = [];

// Shapes of the tags property that the edit rewrites: where npm yaml's range
// for the value ends, and which comments move with it.
const TAG_EDITS = [
  "---\ntags:\n  - a\n  - b # c\n---\n",
  "---\ntags:\n  - a\n\n  # after\nnext: x\n---\n",
  "---\ntags:\n  - a # one\n  # two\n  - b\n  # three\nnext: x\n---\n",
  "---\ntags: | # hdr\n  a\n  b\n---\n",
  "---\ntags: [a # c\n  , b]\n---\n",
  "---\ntags:   \n---\n",
  "---\ntags: !!str\n---\n",
  "---\ntags: !!null\n---\n",
  "---\n? tags\n:\n---\n",
  "---\n{tags: [a, b]}\n---\n",
  "---\n{tags: }\n---\n",
  "---\r\ntags:\r\n  - a # c  \r\n  - b\r\n---\r\n",
  "---\ntags: [a]   # c\n---\n",
  "---\ntags:\n  [a, b]\n---\n",
  "---\ntags:\n  - |\n    a\n  - b\n---\n",
  "---\ntags:\n  - a\n  -\n---\n",
  "---\ntags:\n  - a\n  - # c\n---\n",
  "---\ntags: a\n  b\nx: 1\n---\n",
  "---\ntags:\n  - a\n  - b\n---",
  "---\ntags:\n  - a\n  - # c\n  # d\nnext: x\n---\n",
  "---\ntags:\n  - a\n  -\n  # d\nnext: x\n---\n",
  "---\ntags:\n  - a\n  -\n# d\nnext: x\n---\n",
  "---\ntags:\n  - a\n  -   \n---\n",
  "---\ntags:\n  - a\n  -\t\n---\n",
  "---\ntags:\n  - a\n  - b   \n---\n",
  "---\ntags:\n  - a\n  - b\t# x\n---\n",
  "---\ntags:\n  - a\n  - 'b' # x\n---\n",
  "---\ntags:\n  - a\n  - |\n    b\n\n---\n",
  "---\ntags:\n  - a\n  - b\n    c\n---\n",
  "---\ntags:\n  - a\n  - !!str b # x\n---\n",
  "---\ntags:\n  - a\n  - b\n\n\n---\n",
  "---\ntags: [a, b] \n---\n",
  "---\ntags: [ ]\n---\n",
  "---\ntags: []\n---\n",
  "---\ntags: >- # h\n  a b\n---\n",
  "---\ntags: |2 # h\n    a\n---\n",
  "---\n'tags':\n---\n",
  "---\ntags :\n---\n",
  "---\n? tags # c\n: [a]\n---\n",
  "---\n? tags\n:   \n---\n",
  "---\ntags:\n  - a\n  -\n  - b\n---\n",
  "---\ntags:\n  -\n---\n",
  "---\ntags:\n  - # c\n---\n",
  "---\ntags:\n  - a\n  - b #c\n---\n",
  "---\ntags:\n  - a\n  -\n  # d\n\nnext: x\n---\n",
  "---\ntags:\n  - a\n  -\n\n  # d\nnext: x\n---\n",
  "---\ntags:\n  - a\n  -\n    # d\n  # e\n---\n",
  "---\ntags:\n  -\n  # d\n  - b\n---\n",
  "---\ntags:\n  - a\n  - # c\r\n  # d\r\n---\n",
  "---\ntags:\n    - a\n    - b # deep\nx: 1\n---\n",
  // Comments indented past the list go with its last item; one before an
  // empty item's "-" makes that item run over the lines after it; a block
  // scalar takes none.
  "---\ntags:\n  - ~ #c\n   # c  \n---\n",
  "---\ntags:\n  - t/x  # c\n    # c\n  # indented\n---\n",
  "---\ntags:\n  - k\n    l  # c\n    # m \n  # indented\n---\n",
  "---\ntags:\n  - a\n\t\n    # m\n\n  # x\n---\n",
  "---\ntags:\n  - >-\n    h i\n  # m\n  -\na: [1]\n---\n",
  "---\ntags:\n  - |\n    a\n   # m\n---\n",
  "---\ntags:\n - a\n\t# c\n---\n",
  // An insertion before a comment would touch it.
  "---\ntags: #c\n---\n",
  "---\ntags :  # c\n---\n",
  "---\ntags: !!seq\n  - a\n---\n",
  "---\ntags: !!seq [a]\n---\n",
  "---\ntags: a b c # c\n---\n#b #c\n",
  "---\ntags: 'a, b'\n---\n",
  '---\ntags: "a b" # c\n---\n',
  "---\ntags: ~\n---\n",
  "---\ntags: null # c\n---\n",
  "---\ntags:\n  - ~\n  - a\n---\n",
  "---\ntags: [~]\n---\n",
  "---\ntags: 'a #b'\n---\n",
  "---\ntags:\n  - 'a #b'\n  - \"c # d\"\n---\n",
  '---\ntags: ["a # b", c]\n---\n',
  "---\ntitle: x\n---\n#a #b\n",
  "---\n---\n#a",
  "---\n# only\n---\n#a",
  "---\r\ntitle: x\r\n---\r\n#a\r\n",
  "#a #b\n",
  "",
  "\ufeff",
  "\ufeff#a",
  "text without newline #a",
  "text\r\nwith crlf #a",
  "```\nunclosed #a\n",
  "---\ntags: [a]\n---\n```\ncode #a\n",
  "%% #a\n",
  "<!-- #a",
  "---\ntags: [a]\n---",
  "---\ntags: [a]\n---\n",
  "#a/b/c #a/b #A/B/C/d #ab\n",
  "---\ntags: [a/b, A/B/c, ab]\n---\n#a/x\n",
  "#" + "a".repeat(190) + " #a/" + "b".repeat(190) + "\n",
  "---\ntags: [x]\n---\n" + "#t ".repeat(50) + "\n",
  "---\ntags: [old, OLD/child, keep]\n---\n#old #Old/Child #older\n",
  "---\ntags: [caf\u00e9, cafe\u0301/x]\n---\n#CAF\u00c9 #cafe\u0301/y\n",
  "#\u{1f600} #\u{1f600}/x \u{1f600}#t #t\u{1f600}\n",
  "---\ntags: [\u0130, i\u0307]\n---\n#\u0130stanbul\n",
];

// The changes applied to every note: additions in each place and
// normalisation, removals by tag and by pattern, and renames with and
// without children.
const TAG_OPS = [
  { operation: "add", tags: ["new"] },
  {
    operation: "add",
    tags: ["New_Tag", "a"],
    location: "both",
    position: "start",
    normalization: "kebab",
  },
  { operation: "add", tags: ["x", "\u00e9t\u00e9"], location: "content" },
  { operation: "add", tags: ["CamelCase9Z", "\u0130"], normalization: "lowercase" },
  { operation: "remove", tags: ["a"] },
  { operation: "remove", tags: ["b", "tags"], location: "frontmatter", includeChildren: true },
  { operation: "remove", patterns: ["*"] },
  { operation: "remove", tags: ["t"], patterns: ["b*", "*/c"], location: "content" },
  { operation: "rename", oldTag: "a", newTag: "Renamed/Deep", includeChildren: true },
  { operation: "rename", oldTag: "t", newTag: "u", location: "content" },
  { operation: "rename", oldTag: "old", newTag: "new" },
  { operation: "remove", tags: ["old"], includeChildren: true },
  { operation: "rename", oldTag: "caf\u00e9", newTag: "new", includeChildren: true },
  { operation: "rename", oldTag: "body", newTag: "b", location: "both" },
  { operation: "add", tags: ["a"], location: "both", position: "end" },
] as const;
// The changes the generated Markdown and anchors get: the content ones, and
// one of each kind for the anchors.
const KIND_OPS: Record<TagKind, readonly number[] | undefined> = {
  frontmatter: undefined,
  markdown: [2, 6, 9],
  anchors: [0, 4, 8],
};

// Inputs refused before the note is read, and normalisations, on one note.
const TAG_INPUTS = [
  { operation: "add", tags: [] },
  { operation: "add", tags: ["#"] },
  { operation: "add", tags: Array.from({ length: 101 }, (_, i) => `t${i}`) },
  { operation: "add", tags: Array.from({ length: 100 }, (_, i) => `t${i}`) },
  { operation: "remove" },
  { operation: "remove", tags: [] },
  { operation: "remove", patterns: ["**"] },
  { operation: "remove", patterns: ["a b"] },
  { operation: "remove", tags: ["a"], patterns: Array.from({ length: 101 }, () => "a*") },
  { operation: "rename", oldTag: "", newTag: "x" },
  { operation: "rename", newTag: "x" },
  { operation: "rename", oldTag: "a", newTag: "" },
  { operation: "rename", oldTag: "a", newTag: "b".repeat(201) },
  { operation: "rename", oldTag: "a", newTag: "b".repeat(199), includeChildren: true },
  { operation: "rename", oldTag: "a", newTag: "a" },
  { operation: "rename", oldTag: "#a", newTag: "#z" },
  { operation: "add", tags: ["#a"] },
  { operation: "add", tags: ["A"] },
  { operation: "add", tags: ["a", "a"], location: "both" },
  { operation: "add", tags: ["n1", "N1"], location: "both" },
  {
    operation: "add",
    tags: ["fooBar_Baz__Qux9Z", "a\u00c9", "\u00e0B\u01c5c"],
    normalization: "kebab",
  },
  {
    operation: "add",
    tags: ["\u0130X", "\u03a3\u03a3"],
    normalization: "lowercase",
    location: "both",
  },
  { operation: "add", tags: ["new"], location: "content", position: "start" },
  { operation: "remove", tags: ["A"], location: "both" },
  { operation: "remove", patterns: ["#a*"] },
] as const;

function changeTagVectors() {
  const results = (source: string, ops: readonly number[], inputs: readonly object[]) =>
    ops.map((i) => {
      try {
        return [i, changeTags(source, inputs[i] as TagChange)];
      } catch (error) {
        return [i, writeFailure(error)];
      }
    });
  const all = TAG_OPS.map((_, i) => i);
  const notes: unknown[] = TAG_EDITS.map((source) => ({
    source,
    results: results(source, all, TAG_OPS),
  }));
  // The read side's notes are named by their index in its "notes" section
  // rather than written out again.
  tagCorpus.forEach(({ source, kind }, note) =>
    notes.push({ note, results: results(source, KIND_OPS[kind] ?? all, TAG_OPS) }),
  );
  const inputs = ["---\ntags: [a]\n---\n#a #a/xx\n", "#a\n"].map((source) => ({
    source,
    results: results(
      source,
      TAG_INPUTS.map((_, i) => i),
      TAG_INPUTS,
    ),
  }));
  return { ops: TAG_OPS, notes, inputs: TAG_INPUTS, inputNotes: inputs };
}

/** A note of a plan vault; fixture is how a large one is written down. */
type PlanNote = Note & { fixture?: Text };
interface PlanVault {
  notes: PlanNote[];
  operations: VaultOperation[];
}
const repeated = (path: string, parts: [string, number][]): PlanNote => {
  const r = repeatText(parts);
  return { path, text: r.value, fixture: r.text };
};

function planVaults(): PlanVault[] {
  const tag = (change: object, scope: object = {}): VaultOperation =>
    ({ kind: "tags", change, ...scope }) as VaultOperation;
  const rename = { operation: "rename", oldTag: "old", newTag: "new", includeChildren: true };
  const vaults: PlanVault[] = [];
  // mcp-operations.test.ts
  vaults.push({
    notes: [
      {
        path: "a.md",
        text: "---\r\nkeep:  yes # comment\r\ntags: [old]\r\n---\r\nUNSENT A #old/child\r\n",
      },
      { path: "b.md", text: "UNSENT B #old\n`#old`\n" },
      { path: "c.txt", text: "#old in plain text\n" },
      { path: "drawing.excalidraw.md", text: "#old drawn\n" },
      { path: "image.png", text: "#old not a note" },
      { path: "sub/d.md", text: "#OLD/Child #older\n" },
    ],
    operations: [
      tag(rename),
      tag(rename, { folder: "sub" }),
      tag({ operation: "remove", tags: ["old"] }, { paths: ["a.md", "b.md"] }),
      tag({ operation: "add", tags: ["new"] }, { paths: ["b.md", "a.md"] }),
      tag({ operation: "add", tags: ["old"] }, { paths: ["a.md"] }),
      tag(rename, { paths: ["a.md"], folder: "sub" }),
      tag(rename, { paths: ["a.md", "a.md"] }),
      tag(rename, { paths: ["image.png"] }),
      tag(rename, { paths: ["drawing.excalidraw.md"] }),
      tag({ operation: "add", tags: ["#"] }, { paths: ["a.md"] }),
      tag({ operation: "remove", patterns: ["*"] }),
    ],
  });
  vaults.push({
    notes: [
      { path: "Project/A.md", text: "UNSENT A [B](B.md)\n" },
      { path: "Project/B.md", text: "B\n" },
      { path: "Index.md", text: '[[Project/A|label]] [A](Project/A.md "title")\n' },
    ],
    operations: [
      { kind: "move", path: "Project/A.md", to: "Archive/A.md" },
      { kind: "move", path: "Project/A.md", to: "Archive/A.md", updateLinks: false },
      { kind: "move", path: "Project/A.md", to: "A.md" },
      { kind: "move", path: "Project/A.md", to: "Project/A.md" },
      { kind: "move", path: "Project/A.md", to: "Project/B.md" },
      { kind: "move", path: "Project/A.md", to: "index.md" },
      { kind: "move", path: "Project/A.md", to: "Archive/A.json" },
      { kind: "move", path: "Project/B.md", to: "Archive/B.md" },
      { kind: "delete", path: "Project/A.md" },
      { kind: "delete", path: "Project/A.md", markBroken: true },
      { kind: "delete", path: "Project/B.md", markBroken: true },
      tag({ operation: "add", tags: ["moved"], location: "content" }, { folder: "Project" }),
    ],
  });
  vaults.push({
    notes: [
      { path: "One/Old.md", text: "one\n" },
      { path: "Two/Old.md", text: "two\n" },
      { path: "Index.md", text: "[[Old]] [[One/Old]] [o](One/Old.md) `[[One/Old]]`\n" },
      {
        path: "notes/Old.md",
        text: "[up](../Index.md) [[Index]] ![img](img/x.png) [gone](Future.md)\n",
      },
      { path: "notes/img/x.png", text: "png" },
      { path: "other/Ref.md", text: "[x](../notes/Old.md#frag) [[notes/Old|alias]] [[Old]]\n" },
    ],
    operations: [
      { kind: "move", path: "One/Old.md", to: "X/New.md" },
      { kind: "move", path: "notes/Old.md", to: "archive/deep/Old.md" },
      { kind: "move", path: "notes/Old.md", to: "Old.md" },
      { kind: "delete", path: "notes/Old.md", markBroken: true },
      { kind: "delete", path: "One/Old.md", markBroken: true },
    ],
  });
  vaults.push({
    notes: [
      { path: "a.md", text: "#old" },
      { path: "b.md", bytes: new Uint8Array([255]) },
    ],
    operations: [
      tag(rename),
      tag(rename, { paths: ["a.md"] }),
      tag(rename, { paths: ["b.md"] }),
      { kind: "move", path: "a.md", to: "c.md" },
      { kind: "delete", path: "a.md" },
      { kind: "delete", path: "a.md", markBroken: true },
    ],
  });
  const many: PlanNote[] = [];
  for (let i = 0; i < 480; i++)
    many.push({ path: `n${String(i).padStart(3, "0")}.md`, text: "#t" });
  for (let i = 0; i < 10; i++) many.push({ path: `sub/s${i}.md`, text: "#t [[n000]]" });
  for (let i = 0; i < 33; i++)
    many.push({ path: `big/b${String(i).padStart(2, "0")}.md`, text: "#t" });
  vaults.push({
    notes: many,
    operations: [
      tag({ operation: "rename", oldTag: "t", newTag: "u" }),
      tag({ operation: "rename", oldTag: "t", newTag: "u" }, { folder: "sub" }),
      tag({ operation: "rename", oldTag: "t", newTag: "u" }, { folder: "big" }),
      tag({ operation: "rename", oldTag: "absent", newTag: "u" }, { folder: "big" }),
      { kind: "move", path: "n000.md", to: "moved.md" },
      { kind: "move", path: "n000.md", to: "moved.md", updateLinks: false },
    ],
  });
  const heavy: PlanNote[] = [];
  for (let i = 0; i < 9; i++)
    heavy.push(
      repeated(`h/${i}.md`, [
        ["x", 1_000_000 - 3],
        [" #t", 1],
      ]),
    );
  heavy.push(
    repeated("huge/x.md", [
      ["#t", 1],
      ["x", NOTE_BYTES - 1],
    ]),
  );
  heavy.push(
    repeated("limit/x.md", [
      ["#t", 1],
      ["x", NOTE_BYTES - 2],
    ]),
  );
  vaults.push({
    notes: heavy,
    operations: [
      tag({ operation: "rename", oldTag: "t", newTag: "u" }, { folder: "h" }),
      tag(
        { operation: "rename", oldTag: "t", newTag: "u" },
        { paths: heavy.slice(0, 8).map((n) => n.path) },
      ),
      tag({ operation: "rename", oldTag: "t", newTag: "u" }, { folder: "huge" }),
      tag({ operation: "rename", oldTag: "t", newTag: "u" }, { folder: "limit" }),
    ],
  });
  vaults.push({
    notes: [
      repeated("a.md", [["#old ", 2000]]),
      repeated("b.md", [["#old ", 2000]]),
      repeated("c.md", [["#o ", 4097]]),
      repeated("d.md", [["#p ", 700]]),
    ],
    operations: [
      tag(rename),
      tag({ operation: "rename", oldTag: "o", newTag: "q" }, { paths: ["c.md"] }),
      tag({ operation: "remove", tags: ["p"] }, { paths: ["d.md"] }),
      tag(
        { operation: "add", tags: ["x"] },
        { paths: Array.from({ length: 32 }, (_, i) => `${i}${"\u0001".repeat(100)}.md`) },
      ),
      tag(
        { operation: "add", tags: ["x"] },
        { paths: Array.from({ length: 33 }, (_, i) => `${i}.md`) },
      ),
    ],
  });
  return vaults;
}

async function planVectors() {
  const out: unknown[] = [];
  const same: unknown[] = [];
  for (const vault of planVaults()) {
    const root = await mkdtemp(join(tmpdir(), "trew-oracle-plan-"));
    try {
      const uid = new Map<string, number>();
      for (const [i, note] of vault.notes.entries()) {
        await mkdir(join(root, dirname(note.path)), { recursive: true });
        await writeFile(join(root, note.path), note.bytes ?? note.text ?? "");
        uid.set(note.path, i + 1);
      }
      const observer = new NodeVault(root, { observeOnly: true });
      const operations: unknown[] = [];
      for (const operation of vault.operations) {
        let want: unknown;
        try {
          const preview = await previewOperation(observer, operation);
          // Bases here are uids, which is what Trew measures a plan with.
          const numbered = preview.changes.map((c) => ({ ...c, base: uid.get(c.path)! }));
          want = {
            changes: preview.changes,
            ambiguousLinks: preview.ambiguousLinks,
            size: Buffer.byteLength(JSON.stringify(numbered)),
          };
          // Variants of the small plans only: a plan of thousands of edits
          // says nothing more about the comparison, at a great size.
          if (numbered.length && JSON.stringify(numbered).length <= 4096)
            same.push(...planVariants(numbered));
        } catch (error) {
          want = writeFailure(error);
        }
        operations.push({ operation, want });
      }
      out.push({
        notes: vault.notes.map((n) => ({
          path: n.path,
          text: n.fixture ?? (n.bytes ? bytesText(n.bytes) : n.text),
        })),
        operations,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  return { plans: out, samePlan: same };
}

/** A planned change with a uid for its base, as Trew writes one. */
type Numbered = Omit<PlannedChange, "base"> & { base: number };

/** A plan against altered copies of itself, and whether samePlan takes each. */
function planVariants(plan: Numbered[]) {
  const copy = (): Numbered[] => structuredClone(plan);
  const variants: Numbered[][] = [copy(), copy().reverse()];
  const edited = plan.findIndex((c) => c.edits.length > 0);
  if (edited >= 0) {
    const a = copy();
    a[edited]!.edits[0]!.end += 1;
    const b = copy();
    b[edited]!.edits[0]!.text += "x";
    const c = copy();
    c[edited]!.edits[0]!.old = "";
    const d = copy();
    d[edited]!.edits = [];
    variants.push(a, b, c, d);
    if (plan[edited]!.edits.length > 1) {
      const e = copy();
      e[edited]!.edits.reverse();
      variants.push(e);
    }
  }
  const base = copy();
  base[0]!.base += 1000;
  const action = copy();
  action[0]!.action = action[0]!.action === "edit" ? "delete" : "edit";
  const to = copy();
  to[0]!.to = to[0]!.to === undefined ? "Elsewhere.md" : undefined;
  const extra = copy();
  (extra[0] as unknown as Record<string, unknown>)["extra"] = 1;
  variants.push(base, action, to, extra, copy().slice(1), [...copy(), ...copy().slice(0, 1)]);
  const same = (a: Numbered[], b: Numbered[]) =>
    samePlan(a as unknown as PlannedChange[], b as unknown as PlannedChange[]);
  return variants.map((actual) => ({ expected: plan, actual, want: same(plan, actual) }));
}

// ---------------------------------------------------------------------------
// Sweeps: every code point through the classes the ports depend on.

function ranges(test: (c: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (!test(c)) continue;
    const last = out.at(-1);
    if (last && last[1] === c - 1) last[1] = c;
    else out.push([c, c]);
  }
  return out;
}

function sweeps() {
  const chr = (c: number) => String.fromCodePoint(c);
  const tagChar = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d_/-]$/u;
  const tagLetter = /^[\p{L}\p{M}\p{Extended_Pictographic}_-]$/u;
  const boundary = /^[^\p{L}\p{M}\p{N}_/#\\]$/u;
  const space = /^\s$/u;
  const pictographic = /^\p{Extended_Pictographic}$/u;
  const modifier = /^\p{Emoji_Modifier}$/u;
  const lower: [number, string][] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = chr(c);
    const l = s.toLowerCase();
    if (l !== s) lower.push([c, l]);
  }
  const sigmaAfter = (c: number) => ("A\u03a3" + chr(c)).toLowerCase()[1] === "\u03c3";
  const sigmaBefore = (c: number) => ("A" + chr(c) + "\u03a3").toLowerCase().at(-1) === "\u03c2";
  // Case-insensitive equivalence as /iu matching sees it, over every
  // character that has a case mapping at all.
  const candidates: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = chr(c);
    if (s.toLowerCase() !== s || s.toUpperCase() !== s) candidates.push(c);
  }
  const all = candidates.map(chr).join("");
  const parent = new Map<number, number>();
  const find = (c: number): number => {
    let p = parent.get(c) ?? c;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(c, p);
    return p;
  };
  for (const c of candidates) {
    const escaped = chr(c).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const m of all.matchAll(new RegExp(escaped, "giu"))) {
      const d = m[0].codePointAt(0)!;
      const a = find(c),
        b = find(d);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
  }
  const classes = new Map<number, number[]>();
  for (const c of candidates) {
    const root = find(c);
    if (!classes.has(root)) classes.set(root, []);
    classes.get(root)!.push(c);
  }
  const entities = Object.keys(characterEntities)
    .sort()
    .map((name) => [name, decodeString(`&${name};`)]);
  return {
    lowercaseLetter: ranges((c) => /^\p{Ll}$/u.test(chr(c))),
    uppercaseLetter: ranges((c) => /^\p{Lu}$/u.test(chr(c))),
    tagChar: ranges((c) => tagChar.test(chr(c))),
    tagLetter: ranges((c) => tagLetter.test(chr(c))),
    tagBoundary: ranges((c) => boundary.test(chr(c))),
    jsSpace: ranges((c) => space.test(chr(c))),
    extendedPictographic: ranges((c) => pictographic.test(chr(c))),
    emojiModifier: ranges((c) => modifier.test(chr(c))),
    lower,
    cased: ranges(sigmaAfter),
    ignorable: ranges((c) => sigmaBefore(c) && !sigmaAfter(c)),
    caseClasses: [...classes.values()].filter((c) => c.length > 1).sort((a, b) => a[0]! - b[0]!),
    entities,
  };
}

function goTable(name: string, doc: string, list: [number, number][]): string {
  const r16 = list.filter(([, b]) => b <= 0xffff);
  const r32 = list.filter(([a]) => a > 0xffff);
  if (r16.length + r32.length !== list.length) throw new Error(`${name} has a range across U+FFFF`);
  const hex = (n: number, w: number) => "0x" + n.toString(16).padStart(w, "0");
  const out = [doc, `var ${name} = &unicode.RangeTable{`];
  if (r16.length) {
    out.push("\tR16: []unicode.Range16{");
    for (const [a, b] of r16) out.push(`\t\t{Lo: ${hex(a, 4)}, Hi: ${hex(b, 4)}, Stride: 1},`);
    out.push("\t},");
  }
  if (r32.length) {
    out.push("\tR32: []unicode.Range32{");
    for (const [a, b] of r32) out.push(`\t\t{Lo: ${hex(a, 5)}, Hi: ${hex(b, 5)}, Stride: 1},`);
    out.push("\t},");
  }
  out.push(`\tLatinOffset: ${r16.filter(([, b]) => b <= 0xff).length},`, "}");
  return out.join("\n");
}

// ---------------------------------------------------------------------------

const bun = (globalThis as { Bun?: { version: string } }).Bun;
const runtime = bun ? `bun ${bun.version}` : `node ${process.versions.node}`;
const sweep = sweeps();
const fixture: [string, unknown][] = [
  [
    "about",
    {
      generator: "client/src/node/mcp-oracle.run.ts",
      runtime,
      note: "The TypeScript MCP's outputs for a corpus; internal/notes must reproduce every one. Regenerate with: cd client && bun run src/node/mcp-oracle.run.ts",
    },
  ],
  ["page", pageVectors()],
  ["cursor", cursorVectors()],
  ["search", await searchVectors()],
  ["compare", await compareVectors()],
  ...Object.entries(tagVectors()),
  ...Object.entries(linkVectors()),
  ["edits", await editVectors()],
  ["changeTags", changeTagVectors()],
  ...Object.entries(await planVectors()),
  ["sweeps", sweep],
];

function write(sections: [string, unknown][]): string {
  const parts = sections.map(([name, value]) => {
    if (Array.isArray(value))
      return `${ascii(name)}: [\n${value.map((v) => ascii(v)).join(",\n")}\n]`;
    if (value && typeof value === "object")
      return `${ascii(name)}: {\n${Object.entries(value)
        .map(([k, v]) =>
          Array.isArray(v)
            ? `${ascii(k)}: [\n${v.map((x) => ascii(x)).join(",\n")}\n]`
            : `${ascii(k)}: ${ascii(v)}`,
        )
        .join(",\n")}\n}`;
    return `${ascii(name)}: ${ascii(value)}`;
  });
  return `{\n${parts.join(",\n")}\n}\n`;
}

const out = process.env["ORACLE_OUT"];
await writeFile(out ?? join(ROOT, "mcp-fixtures.json"), write(fixture));
if (out) {
  console.info(`wrote ${out} (${runtime})`);
  process.exit(0);
}
await writeFile(
  join(ROOT, "internal/notes/emoji_table.go"),
  [
    "// Code generated by client/src/node/mcp-oracle.run.ts. DO NOT EDIT.",
    "",
    "package notes",
    "",
    'import "unicode"',
    "",
    goTable(
      "extendedPictographic",
      `// extendedPictographic is \\p{Extended_Pictographic} as the JavaScript runtime\n// the oracle ran on (${runtime}) defines it.`,
      sweep.extendedPictographic,
    ),
    "",
    goTable(
      "emojiModifier",
      "// emojiModifier is \\p{Emoji_Modifier}, likewise.",
      sweep.emojiModifier,
    ),
    "",
  ].join("\n"),
);
console.info(`wrote mcp-fixtures.json and internal/notes/emoji_table.go (${runtime})`);
