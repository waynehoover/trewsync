/**
 * The protocol 1 path contract, on the client: which paths the server accepts,
 * which two paths collide, and the five format policies.
 *
 * This is the TypeScript half of a contract whose Go half is `internal/paths`.
 * Both are checked against `protocol-fixtures.json`, whose vectors come from
 * `scripts/protocol-vectors.py` rather than from either implementation, and
 * both must reach the same verdict *and* the same reason (PLAN.md M0.5).
 *
 * The rule behind it (PLAN.md section 4.1): the server's keyspace is
 * Obsidian's. A path `normalizePath` would rewrite is refused.
 */

import { fold } from "./fold.ts";

/** The longest path, in bytes of UTF-8, the server accepts. */
export const MAX_PATH_BYTES = 1024;

/**
 * The longest single name in a path, in bytes of UTF-8: ext4 and f2fs, which
 * Android and Linux use, hold no more, so a longer name is refused where it is
 * made rather than failing on every Android and Linux device later.
 */
export const MAX_SEGMENT_BYTES = 255;

/**
 * The name the adapters give files they are staging. Derived from the product
 * name, which is not final (PLAN.md section 10).
 */
export const STAGING_MARK = ".trew-tmp-";

/** Why a path is refused, in the order `pathReason` tests them. */
export type PathReason =
  | "utf8"
  | "empty"
  | "toolong"
  | "segmenttoolong"
  | "control"
  | "nfc"
  | "nbsp"
  | "backslash"
  | "slash"
  | "emptysegment"
  | "dotsegment"
  | "dotprefix"
  | "staging";

const utf8 = new TextEncoder();

/** Whether a string can be encoded as UTF-8: no unpaired surrogate. */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Why the server refuses `path`, or `undefined` when it accepts it. */
export function pathReason(path: string): PathReason | undefined {
  if (!wellFormed(path)) return "utf8";
  if (path === "") return "empty";
  if (utf8.encode(path).length > MAX_PATH_BYTES) return "toolong";
  if (path.split("/").some((s) => utf8.encode(s).length > MAX_SEGMENT_BYTES))
    return "segmenttoolong";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(path)) return "control";
  if (path.normalize("NFC") !== path) return "nfc";
  if (/[\u00a0\u202f]/u.test(path)) return "nbsp";
  if (path.includes("\\")) return "backslash";
  if (path.startsWith("/") || path.endsWith("/")) return "slash";
  const segments = path.split("/");
  if (segments.some((s) => s === "")) return "emptysegment";
  if (segments.some((s) => s === "." || s === "..")) return "dotsegment";
  if (segments.some((s) => s.startsWith("."))) return "dotprefix";
  if (path.includes(STAGING_MARK)) return "staging";
  return undefined;
}

/** One live entry, as the collision rule sees it. */
export interface LiveEntry {
  readonly path: string;
  readonly folder?: boolean;
}

/** One create or move, as the collision rule sees it. */
export type PathOp =
  | { readonly type: "create"; readonly path: string; readonly folder?: boolean }
  | {
      readonly type: "move";
      readonly prev: string;
      readonly path: string;
      readonly folder?: boolean;
    };

/**
 * Whether `op` would leave two live paths a case-folding disk holds as one
 * file or one folder. The reference the server's indexed check is tested
 * against, and the rule the client uses to explain a `collision` refusal; it is
 * quadratic, so it is not what the server runs.
 *
 * A move whose source and destination fold alike is a case-only rename and
 * never collides: it keeps every folded key where it was, which is also what
 * lets a case-only folder rename spread over several batches.
 */
export function collides(live: readonly LiveEntry[], op: PathOp): boolean {
  if (op.type === "move" && fold(op.prev) === fold(op.path)) return false;
  if (op.type === "create" && live.some((e) => e.path === op.path)) return false;
  const others = live.filter(
    (e) => e.path !== op.path && !(op.type === "move" && e.path === op.prev),
  );
  const key = fold(op.path);
  if (others.some((e) => fold(e.path) === key)) return true;
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const e of others) {
    const segs = e.path.split("/");
    for (let k = 1; k < segs.length; k++) dirs.add(segs.slice(0, k).join("/"));
    if (e.folder === true) dirs.add(e.path);
    else files.push(e.path);
  }
  const spellings = (folded: string) => [...dirs].filter((d) => fold(d) === folded);
  const segs = op.path.split("/");
  for (let k = 1; k < segs.length; k++) {
    const d = segs.slice(0, k).join("/");
    const fd = fold(d);
    const s = spellings(fd);
    if (s.length > 0 && !s.includes(d)) return true;
    if (files.some((f) => fold(f) === fd)) return true;
  }
  const same = spellings(key);
  return same.length > 0 && (op.folder !== true || !same.includes(op.path));
}

/**
 * The extensions whose files are chunked as text. It only picks chunk sizes: a
 * wrong answer costs efficiency, never correctness.
 */
export const CHUNKING_TEXT_EXTENSIONS: readonly string[] = [
  "md",
  "txt",
  "canvas",
  "json",
  "csv",
  "yml",
  "yaml",
  "base",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "svg",
  "bib",
  "tex",
];

/** Lower case for A to Z only, so no Unicode rule is involved. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Whether a path may be stored at all. */
export function syncable(path: string): boolean {
  return pathReason(path) === undefined;
}

/** Whether a path is chunked with the text sizes. */
export function chunkingText(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return false;
  return CHUNKING_TEXT_EXTENSIONS.includes(asciiLower(path.slice(dot + 1)));
}

function mcpText(path: string): boolean {
  if (!syncable(path)) return false;
  const lower = asciiLower(path);
  return lower.endsWith(".md") || lower.endsWith(".txt");
}

/** Whether a note's text is searched: Markdown or plain text, drawings included. */
export function searchable(path: string): boolean {
  return mcpText(path);
}

/** Whether an agent may read a note's text. A separate policy from `searchable` on purpose. */
export function mcpReadable(path: string): boolean {
  return mcpText(path);
}

/** Whether an agent may change a note: readable, and not an Excalidraw drawing. */
export function mcpEditable(path: string): boolean {
  return mcpText(path) && !asciiLower(path).endsWith(".excalidraw.md");
}
