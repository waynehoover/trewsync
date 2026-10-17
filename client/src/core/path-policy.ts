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
  | "staging"
  // Protocol 3's, for a path inside a profile root (`configPathReason`): one
  // device's own state, which never syncs, and a file settings sync does not
  // carry.
  | "devicelocal"
  | "configscope";

/**
 * The plugin's id, so the name of its folder in a profile root. That folder
 * holds one device's pairing and index and never syncs.
 */
export const SYNC_PLUGIN_ID = "trew-sync";

/**
 * The plugins whose folders never move between devices and which sync never
 * switches on: this one, and the others that sync or remote-control a vault,
 * whose folders hold credentials and device identity, and which on a second
 * device would be a second writer (plan/settings-sync.md, section 6). The
 * server refuses their folders as well. Lower case, compared folded.
 */
export const DEVICE_LOCAL_PLUGINS: readonly string[] = [
  SYNC_PLUGIN_ID,
  "obsidian-git",
  "obsidian-local-rest-api",
  "obsidian-livesync",
  "remotely-save",
  "basalt-sync",
  "supersync",
];

/** Obsidian's list of the community plugins it runs, at the top of a profile root. */
export const COMMUNITY_PLUGINS = "community-plugins.json";

/** Whether a plugin id, a folder name under `plugins`, is one that never syncs. */
export function isDeviceLocalPlugin(id: string): boolean {
  return DEVICE_LOCAL_PLUGINS.includes(fold(id));
}

/**
 * A profile root: Obsidian's configuration folder, or one a device chose with
 * Obsidian's "Override config folder" as `.obsidian-<name>`
 * (plan/settings-sync.md, section 1). A fixed pattern keeps `.git`, `.trash`
 * and `.trew` out without a list of them.
 */
const CONFIG_ROOT = /^\.obsidian(?:-[a-z0-9][a-z0-9-]{0,31})?$/u;

/** Whether `path` begins with a profile root, whatever follows it. */
export function isConfigPath(path: string): boolean {
  const slash = path.indexOf("/");
  return CONFIG_ROOT.test(slash < 0 ? path : path.slice(0, slash));
}

/**
 * Whether `path` is community plugins' inside a profile root: the plugin list,
 * or anything in the plugins folder, folded as the scope rule folds. These
 * are protocol 4's, and a device that does not sync its plugins leaves them
 * out of its scope.
 */
export function isPluginPath(path: string): boolean {
  if (!isConfigPath(path)) return false;
  const rest = path.split("/").slice(1);
  const first = rest[0] === undefined ? undefined : fold(rest[0]);
  return first === "plugins" || (rest.length === 1 && first === COMMUNITY_PLUGINS);
}

/**
 * Whether `path` is a community plugin's code or assets: a file in a plugin's
 * folder other than its settings, `data.json`. Two builds of these are never
 * merged; the plugin list and a plugin's settings merge as settings do.
 */
export function isPluginCode(path: string): boolean {
  if (!isPluginPath(path)) return false;
  const rest = path.split("/").slice(1);
  return rest.length >= 3 && fold(rest[rest.length - 1]!) !== "data.json";
}

/** Whether `name`, a single folder name, is a profile root. */
export function isProfileRoot(name: string): boolean {
  return CONFIG_ROOT.test(name);
}

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

/**
 * Why the server refuses `path` as a note, or `undefined` when it accepts it.
 * The rule for notes, and for every session of protocol 1 or 2.
 */
export function pathReason(path: string): PathReason | undefined {
  return reason(path, false);
}

/**
 * Protocol 3's rule: `pathReason`, except that a profile root may begin the
 * path, and then what follows it must be what settings sync carries
 * (`configScope`). A path outside every profile root gets `pathReason`'s
 * answer.
 *
 * With `plugins`, protocol 4's: community plugins too, the plugin list and
 * any file inside a plugin's folder, except the folders of
 * `DEVICE_LOCAL_PLUGINS`. A device that syncs its settings but not its
 * plugins keeps protocol 3's scope.
 */
export function configPathReason(path: string, plugins = false): PathReason | undefined {
  return reason(path, true, plugins);
}

/**
 * Why a path inside a profile root does not sync, given its segments after the
 * root, or `undefined` when it does. Settings sync carries Obsidian's own
 * settings, every JSON file at the top of the root, and themes and CSS
 * snippets. With `plugins`, which is protocol 4, it carries community plugins
 * too: their list, and any file inside a plugin's folder. Without it both are
 * out of scope. The sync plugin's folder, the other `DEVICE_LOCAL_PLUGINS` and
 * the workspace files never sync. Compared folded, with the fold the collision
 * rule uses, so a case-folding disk cannot spell its way past the device-local
 * rule: APFS holds workspace.json and workspace.json spelt with U+017F as one
 * file, which ASCII lower case does not see.
 */
function configScope(rest: readonly string[], plugins: boolean): PathReason | undefined {
  const lower = rest.map(fold);
  const [first, second] = lower;
  if (lower.length >= 2 && first === "plugins" && second === SYNC_PLUGIN_ID) return "devicelocal";
  if (plugins && lower.length >= 2 && first === "plugins" && DEVICE_LOCAL_PLUGINS.includes(second!))
    return "devicelocal";
  if (plugins && lower.length >= 3 && first === "plugins") return undefined;
  if (plugins && lower.length === 1 && first === COMMUNITY_PLUGINS) return undefined;
  if (lower.length === 1 && (first === "workspace.json" || first === "workspace-mobile.json"))
    return "devicelocal";
  if (lower.length === 1 && first?.endsWith(".json") && first !== COMMUNITY_PLUGINS)
    return undefined;
  if (lower.length === 3 && first === "themes") return undefined;
  if (lower.length === 2 && first === "snippets" && second?.endsWith(".css")) return undefined;
  return "configscope";
}

function reason(path: string, config: boolean, plugins = false): PathReason | undefined {
  if (!wellFormed(path)) return "utf8";
  if (path === "") return "empty";
  if (utf8.encode(path).length > MAX_PATH_BYTES) return "toolong";
  if (path.split("/").some((s) => utf8.encode(s).length > MAX_SEGMENT_BYTES))
    return "segmenttoolong";
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/u.test(path)) return "control";
  if (path.normalize("NFC") !== path) return "nfc";
  if (/[\u00a0\u202f]/u.test(path)) return "nbsp";
  if (path.includes("\\")) return "backslash";
  if (path.startsWith("/") || path.endsWith("/")) return "slash";
  const segments = path.split("/");
  if (segments.some((s) => s === "")) return "emptysegment";
  if (segments.some((s) => s === "." || s === "..")) return "dotsegment";
  const root = config && isConfigPath(path);
  if ((root ? segments.slice(1) : segments).some((s) => s.startsWith("."))) return "dotprefix";
  if (path.includes(STAGING_MARK)) return "staging";
  if (root) return configScope(segments.slice(1), plugins);
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
