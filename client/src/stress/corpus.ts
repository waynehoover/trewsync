/**
 * A vault that looks like somebody's, of any size, rebuilt exactly from a seed.
 *
 * `bench-corpus.ts` is the corpus the pass benchmarks share, and it is
 * deliberately plain: one sentence repeated, three folder levels, ASCII names.
 * That is right for timing a pass and wrong for asking whether ten thousand
 * real notes sync, because what goes wrong in a real vault is the part that
 * corpus leaves out: a name in Japanese or with an accent, two spaces and a
 * capital in a folder name, frontmatter a parser has to read, a link to a note
 * three folders away, a 2 MB scan beside a 200-byte note, a file with CRLF
 * line endings. This one has all of them, in proportions taken from a real
 * vault (3,796 notes, 91 MB, docs/research.md), and nothing else.
 *
 * Deterministic by seed, and file by file: `seed` and `i` alone decide file
 * `i`'s path and bytes, through a PRNG seeded from both, so a corpus rebuilt on
 * another machine is the same bytes, and a harness can regenerate one file to
 * know what it should hold without keeping the corpus. No dependency, no
 * `Math.random`, no clock.
 *
 * Every path is one the server accepts (`pathReason`) and no two fold together
 * (`foldPath`), because a macOS or Windows disk would hold two such paths as one
 * file and the corpus would be measuring a collision nobody asked for. Names
 * avoid the characters Obsidian refuses in a file name (`* " \ / < > : | ? # ^
 * [ ]`), so the same corpus opens in the real app.
 */

import { foldPath } from "../core/paths.ts";
import { pathReason } from "../core/path-policy.ts";

export interface CorpusOptions {
  /** Decides everything. Two corpora with one seed and one size are identical. */
  readonly seed?: number;
  /** How many files, attachments included. */
  readonly files?: number;
  /** The share of files that are attachments rather than notes. */
  readonly attachmentShare?: number;
  /** The largest attachment, in bytes. The server's default ceiling is 64 MiB. */
  readonly maxAttachmentBytes?: number;
}

export interface CorpusFile {
  readonly path: string;
  readonly kind: "note" | "attachment" | "canvas";
}

/** What the corpus holds that a search or a check can be asserted against. */
export interface CorpusFacts {
  /** Notes carrying each tag, in frontmatter or inline, by the tag without `#`. */
  readonly tagged: ReadonlyMap<string, number>;
  /** The phrase exactly one note contains, and that note. */
  readonly needle: { readonly text: string; readonly path: string };
  /** A word in many notes' text. */
  readonly common: string;
  /** A fragment of many file names. */
  readonly nameFragment: string;
}

export interface Corpus {
  readonly seed: number;
  readonly files: readonly CorpusFile[];
  /** File `i`'s bytes, computed afresh every call. */
  bytes(i: number): Uint8Array;
  /** The index of a path, or undefined. */
  indexOf(path: string): number | undefined;
  facts(): CorpusFacts;
}

/** mulberry32: small, fast, and good enough to make prose that is not a pattern. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed for one file, mixed from the corpus seed and the file's index. */
function mix(seed: number, i: number, salt: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** Log-normal, because note and attachment sizes are: most small, a long tail. */
function lognormal(r: () => number, median: number, sigma: number): number {
  const u = Math.max(r(), 1e-12);
  const v = r();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(sigma * z);
}

/*
 * The word stock. Unicode where a real vault has it: accented Latin, Greek,
 * Cyrillic, CJK, an emoji or two. Case varied on purpose (iOS, README, macOS),
 * since a case-folding disk is where a sync goes wrong.
 */
const TITLE_WORDS = [
  "Meeting",
  "notes",
  "Design",
  "review",
  "Roadmap",
  "Q3",
  "planning",
  "Ideas",
  "reading",
  "list",
  "Recipe",
  "Trip",
  "budget",
  "README",
  "iOS",
  "macOS",
  "API",
  "migration",
  "Weekly",
  "retro",
  "Book",
  "summary",
  "Project",
  "kickoff",
  "Interview",
  "prep",
  "Garden",
  "log",
  "Health",
  "Workout",
  "plan",
  "Café",
  "crème brûlée",
  "Zürich",
  "São Paulo",
  "Kraków",
  "naïve",
  "résumé",
  "Ñandú",
  "Ελλάδα",
  "Москва",
  "東京",
  "日本語",
  "메모",
  "北京",
  "🚀 Launch",
  "✨ ideas",
  "Straße",
  "Ærø",
  "Øresund",
  "piñata",
  "Déjà vu",
  "façade",
  "jalapeño",
  "O'Brien",
  "Smith & Co",
  "v2.1",
  "draft (old)",
  "Tom, Dick and Harry",
  "x-ray",
  "50% off",
];

const FOLDERS_TOP = [
  "Journal",
  "Projects",
  "Areas",
  "Resources",
  "Archive",
  "Inbox",
  "People",
  "Meetings",
  "Zettelkasten",
  "Recettes de cuisine",
  "日本語ノート",
  "Ελληνικά σημειώσεις",
  "Work Stuff",
  "reading list",
  "HOME",
  "Mañana",
];

const FOLDERS_SUB = [
  "2023",
  "2024",
  "2025",
  "2026",
  "Alpha",
  "beta",
  "Client A",
  "Client B",
  "Health",
  "Finance",
  "Travel",
  "Côte d'Azur",
  "Books",
  "Podcasts",
  "old",
  "Drafts",
  "Team",
  "1-on-1s",
  "Ideas & Sketches",
  "München",
  "Κρήτη",
  "Токио",
];

const PROSE = [
  "the",
  "meeting",
  "moved",
  "because",
  "however",
  "perhaps",
  "decision",
  "measure",
  "boundary",
  "release",
  "review",
  "observed",
  "argument",
  "threshold",
  "migration",
  "garden",
  "tomatoes",
  "budget",
  "invoice",
  "timeline",
  "draft",
  "summary",
  "question",
  "answer",
  "follow",
  "up",
  "with",
  "about",
  "before",
  "after",
  "during",
  "should",
  "would",
  "could",
  "maybe",
  "later",
  "coffee",
  "walk",
  "sleep",
  "chapter",
  "author",
  "quote",
  "server",
  "phone",
  "laptop",
  "sync",
  "café",
  "naïve",
  "façade",
  "Zürich",
  "résumé",
  "東京",
  "日本",
  "Ελλάδα",
  "Москва",
  "🙂",
];

const TAGS = [
  "project/alpha",
  "project/beta",
  "status/todo",
  "status/done",
  "status/waiting",
  "idea",
  "reading",
  "recipe",
  "health",
  "journal",
  "meeting",
  "person",
  "travel",
  "finance",
  "draft",
  "café",
  "日本語",
];

const ATTACHMENT_KINDS: readonly { ext: string; median: number; sigma: number; magic: number[] }[] =
  [
    {
      ext: "png",
      median: 120_000,
      sigma: 1.0,
      magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    },
    { ext: "jpg", median: 250_000, sigma: 0.9, magic: [0xff, 0xd8, 0xff, 0xe0] },
    {
      ext: "pdf",
      median: 300_000,
      sigma: 1.2,
      magic: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
    },
    {
      ext: "m4a",
      median: 700_000,
      sigma: 0.8,
      magic: [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70],
    },
  ];

/** The phrase exactly one note contains, for a search that must find one. */
const NEEDLE = "quokka-marmalade-7731";

function titleCase(r: () => number, words: string[]): string {
  const style = r();
  if (style < 0.55) return words.join(" ");
  if (style < 0.75) return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  if (style < 0.9) return words.join(" ").toLowerCase();
  if (style < 0.95) return words.join("-");
  return words.join(" ").toUpperCase();
}

function folderFor(r: () => number, folders: readonly string[]): string {
  return pick(r, folders);
}

/**
 * The folder tree, built once per corpus: some top folders on their own, most
 * with one to three levels beneath. Spelled once, so every file in a folder
 * uses the same bytes for it, which is what a real disk does.
 */
function buildFolders(seed: number): string[] {
  const r = prng(mix(seed, 0, 1));
  const out = new Set<string>([""]);
  const folded = new Set<string>([""]);
  const add = (f: string) => {
    const key = foldPath(f);
    if (folded.has(key)) return;
    folded.add(key);
    out.add(f);
  };
  for (const top of FOLDERS_TOP) {
    add(top);
    const subs = 1 + Math.floor(r() * 5);
    for (let s = 0; s < subs; s++) {
      const a = `${top}/${pick(r, FOLDERS_SUB)}`;
      add(a);
      if (r() < 0.5) {
        const b = `${a}/${pick(r, FOLDERS_SUB)}`;
        add(b);
        if (r() < 0.3) add(`${b}/${pick(r, FOLDERS_SUB)}`);
      }
    }
  }
  return [...out].sort();
}

/** Makes the corpus: paths first, all of them, so links can point at real notes. */
export function makeCorpus(opts: CorpusOptions = {}): Corpus {
  const seed = opts.seed ?? 1;
  const count = opts.files ?? 10_000;
  const share = opts.attachmentShare ?? 0.03;
  const maxAttachment = opts.maxAttachmentBytes ?? 8 * 1024 * 1024;
  const folders = buildFolders(seed);
  const files: CorpusFile[] = [];
  const taken = new Set<string>(folders.map(foldPath));
  const byPath = new Map<string, number>();

  for (let i = 0; i < count; i++) {
    const r = prng(mix(seed, i, 2));
    const roll = r();
    const kind: CorpusFile["kind"] =
      roll < share ? "attachment" : roll < share + 0.004 ? "canvas" : "note";
    let path = "";
    for (let attempt = 0; ; attempt++) {
      let folder: string;
      let name: string;
      if (kind === "attachment") {
        folder = r() < 0.7 ? "Attachments" : folderFor(r, folders);
        const k = ATTACHMENT_KINDS[Math.floor(r() * ATTACHMENT_KINDS.length)]!;
        const stem =
          r() < 0.5
            ? `Pasted image ${20240000 + Math.floor(r() * 30000)}${Math.floor(r() * 1e6)}`
            : titleCase(r, [pick(r, TITLE_WORDS), pick(r, TITLE_WORDS)]);
        name = `${stem}.${k.ext}`;
      } else if (kind === "canvas") {
        folder = folderFor(r, folders);
        name = `${titleCase(r, [pick(r, TITLE_WORDS), "board"])}.canvas`;
      } else if (r() < 0.25) {
        // Daily notes, as Obsidian's core plugin names them.
        const day = new Date(Date.UTC(2021, 0, 1) + Math.floor(r() * 2000) * 86_400_000);
        const iso = day.toISOString().slice(0, 10);
        folder = `Journal/${iso.slice(0, 4)}`;
        name = `${iso}.md`;
      } else {
        folder = folderFor(r, folders);
        const n = 1 + Math.floor(r() * 4);
        const words: string[] = [];
        for (let w = 0; w < n; w++) words.push(pick(r, TITLE_WORDS));
        name = `${titleCase(r, words)}.md`;
      }
      if (attempt > 0) name = name.replace(/(\.[^.]+)$/, ` ${attempt + 1}$1`);
      path = (folder === "" ? name : `${folder}/${name}`).normalize("NFC");
      const key = foldPath(path);
      if (!taken.has(key) && pathReason(path) === undefined) {
        taken.add(key);
        break;
      }
      if (attempt > 50) throw new Error(`could not name file ${i}: last tried ${path}`);
    }
    files.push({ path, kind });
    byPath.set(path, i);
  }

  const notes = files.map((f, i) => (f.kind === "note" ? i : -1)).filter((i) => i >= 0);
  const attachments = files.map((f, i) => (f.kind === "attachment" ? i : -1)).filter((i) => i >= 0);
  const needleAt = notes[Math.floor(prng(mix(seed, 0, 3))() * notes.length)]!;
  const linkName = (i: number) => {
    const p = files[i]!.path;
    return p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, "");
  };

  const enc = new TextEncoder();

  function noteText(i: number): { text: string; tags: string[] } {
    const r = prng(mix(seed, i, 4));
    const tags = new Set<string>();
    const lines: string[] = [];
    if (r() < 0.6) {
      lines.push("---");
      lines.push(
        `created: ${new Date(Date.UTC(2021, 0, 1) + Math.floor(r() * 2000) * 86_400_000).toISOString().slice(0, 10)}`,
      );
      if (r() < 0.7) {
        const n = 1 + Math.floor(r() * 3);
        const fm: string[] = [];
        for (let t = 0; t < n; t++) fm.push(pick(r, TAGS));
        const uniq = [...new Set(fm)];
        uniq.forEach((t) => tags.add(t));
        lines.push("tags:");
        for (const t of uniq) lines.push(`  - ${t}`);
      }
      if (r() < 0.3)
        lines.push(`aliases: [${JSON.stringify(titleCase(r, [pick(r, TITLE_WORDS)]))}]`);
      if (r() < 0.4) lines.push(`status: ${pick(r, ["open", "done", "someday", "waiting"])}`);
      if (r() < 0.2) lines.push(`rating: ${1 + Math.floor(r() * 5)}`);
      lines.push("---");
    }
    lines.push(`# ${linkName(i)}`, "");
    // Size: median about 1.2 KB of text, a long tail to tens of KB.
    const target = Math.min(120_000, Math.max(40, lognormal(r, 1200, 1.1)));
    let size = 0;
    while (size < target) {
      const block = r();
      let para = "";
      if (block < 0.55) {
        const n = 6 + Math.floor(r() * 30);
        const ws: string[] = [];
        for (let w = 0; w < n; w++) {
          const x = r();
          if (x < 0.02 && notes.length > 1) {
            const to = notes[Math.floor(r() * notes.length)]!;
            const s = r();
            ws.push(
              s < 0.6
                ? `[[${linkName(to)}]]`
                : s < 0.85
                  ? `[[${linkName(to)}|${pick(r, PROSE)}]]`
                  : `[[${linkName(to)}#${pick(r, PROSE)}]]`,
            );
          } else if (x < 0.025) {
            const t = pick(r, TAGS);
            tags.add(t);
            ws.push(`#${t}`);
          } else ws.push(pick(r, PROSE));
        }
        para = ws.join(" ") + ".";
        para = para.charAt(0).toUpperCase() + para.slice(1);
      } else if (block < 0.7) {
        const n = 2 + Math.floor(r() * 6);
        const items: string[] = [];
        for (let k = 0; k < n; k++) {
          const box = r() < 0.4 ? (r() < 0.5 ? "[ ] " : "[x] ") : "";
          items.push(`- ${box}${pick(r, PROSE)} ${pick(r, PROSE)} ${pick(r, PROSE)}`);
        }
        para = items.join("\n");
      } else if (block < 0.8) {
        para = `## ${titleCase(r, [pick(r, TITLE_WORDS), pick(r, PROSE)])}`;
      } else if (block < 0.86 && attachments.length > 0) {
        para = `![[${files[attachments[Math.floor(r() * attachments.length)]!]!.path.split("/").pop()}]]`;
      } else if (block < 0.92) {
        para =
          "```js\nconst x = " +
          Math.floor(r() * 1000) +
          ";\nconsole.log(`" +
          pick(r, PROSE) +
          " ${x}`);\n```";
      } else if (block < 0.96) {
        para = `> ${pick(r, PROSE)} ${pick(r, PROSE)} ${pick(r, PROSE)}, ${pick(r, PROSE)}.\n> -- ${pick(r, TITLE_WORDS)}`;
      } else {
        para = `| a | b | c |\n|---|---|---|\n| ${pick(r, PROSE)} | ${Math.floor(r() * 100)} | ${pick(r, PROSE)} |`;
      }
      lines.push(para, "");
      size += para.length + 2;
    }
    if (i === needleAt) lines.push(`The one note that mentions ${NEEDLE}.`, "");
    let text = lines.join("\n");
    // A few files as another editor left them: CRLF line endings, or a BOM.
    const quirk = r();
    if (quirk < 0.01) text = text.replace(/\n/g, "\r\n");
    else if (quirk < 0.015) text = String.fromCharCode(0xfeff) + text;
    return { text, tags: [...tags] };
  }

  function attachmentBytes(i: number): Uint8Array {
    const r = prng(mix(seed, i, 5));
    const ext = files[i]!.path.slice(files[i]!.path.lastIndexOf(".") + 1);
    const k = ATTACHMENT_KINDS.find((a) => a.ext === ext)!;
    const size = Math.floor(
      Math.min(maxAttachment, Math.max(2048, lognormal(r, k.median, k.sigma))),
    );
    const out = new Uint8Array(size);
    out.set(k.magic);
    // Incompressible, as an image or a recording is, and cheap to make.
    let x = mix(seed, i, 6) | 1;
    for (let b = k.magic.length; b < size; b++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[b] = x & 0xff;
    }
    return out;
  }

  function canvasText(i: number): string {
    const r = prng(mix(seed, i, 7));
    const nodes = [];
    const n = 2 + Math.floor(r() * 8);
    for (let k = 0; k < n; k++) {
      const to = notes[Math.floor(r() * notes.length)]!;
      nodes.push(
        r() < 0.5
          ? {
              id: `n${k}`,
              type: "file",
              file: files[to]!.path,
              x: k * 300,
              y: 0,
              width: 250,
              height: 200,
            }
          : {
              id: `n${k}`,
              type: "text",
              text: `${pick(r, PROSE)} ${pick(r, PROSE)}`,
              x: k * 300,
              y: 300,
              width: 250,
              height: 120,
            },
      );
    }
    return JSON.stringify({ nodes, edges: [] }, null, "\t");
  }

  let factsCache: CorpusFacts | undefined;

  return {
    seed,
    files,
    bytes(i: number): Uint8Array {
      const f = files[i];
      if (f === undefined) throw new Error(`no file ${i} in a corpus of ${files.length}`);
      if (f.kind === "attachment") return attachmentBytes(i);
      if (f.kind === "canvas") return enc.encode(canvasText(i));
      return enc.encode(noteText(i).text);
    },
    indexOf(path: string): number | undefined {
      return byPath.get(path);
    },
    facts(): CorpusFacts {
      if (factsCache) return factsCache;
      const tagged = new Map<string, number>();
      for (const i of notes)
        for (const t of noteText(i).tags) tagged.set(t, (tagged.get(t) ?? 0) + 1);
      factsCache = {
        tagged,
        needle: { text: NEEDLE, path: files[needleAt]!.path },
        common: "tomatoes",
        nameFragment: "Meeting",
      };
      return factsCache;
    },
  };
}

/** Every folder the corpus's files sit in, parents first. */
export function corpusFolders(corpus: Corpus): string[] {
  const out = new Set<string>();
  for (const f of corpus.files) {
    const parts = f.path.split("/").slice(0, -1);
    for (let k = 1; k <= parts.length; k++) out.add(parts.slice(0, k).join("/"));
  }
  return [...out].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
}
