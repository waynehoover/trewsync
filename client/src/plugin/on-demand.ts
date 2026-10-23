/**
 * Attachments on demand: which files a note needs that this device left on the
 * server, and which it could free the space of.
 *
 * The engine decides what stays on the server (`EngineOptions.onDemand`) and
 * frees space (`Engine.release`). What lives here is the part that knows about
 * Obsidian: a note's links and embeds, read from its metadata, resolved
 * against the files the server holds and this device does not.
 */

import { Modal, Setting, type App } from "obsidian";

import { looksLikeText } from "../core/chunk.ts";
import { isConfigPath } from "../core/path-policy.ts";

/** The presets a person chooses from, in bytes. Absent is off. */
export const ON_DEMAND_PRESETS: readonly { label: string; bytes: number | undefined }[] = [
  { label: "Off", bytes: undefined },
  { label: "Over 1 MB", bytes: 1_000_000 },
  { label: "Over 10 MB", bytes: 10_000_000 },
  { label: "All attachments", bytes: 0 },
];

/** The default once it is turned on: over 1 MB. */
export const ON_DEMAND_DEFAULT = 1_000_000;

/** Whether a file of this size is one the setting leaves on the server. */
export function coveredBy(threshold: number | undefined, path: string, size: number): boolean {
  return (
    threshold !== undefined && size >= threshold && !looksLikeText(path) && !isConfigPath(path)
  );
}

/** The part of a link that names a file: no `#heading`, no `|alias`, in NFC. */
export function linkpathOf(link: string): string {
  let out = link;
  const bar = out.indexOf("|");
  if (bar >= 0) out = out.slice(0, bar);
  const hash = out.indexOf("#");
  if (hash >= 0) out = out.slice(0, hash);
  try {
    out = decodeURI(out);
  } catch {
    // A literal `%` in a name: kept as it was written.
  }
  return out.trim().normalize("NFC");
}

/**
 * The file a link means, chosen the way Obsidian 1.14 chooses
 * (`MetadataCache.getLinkpathDest`), but over every file this device knows
 * of: the ones here and the ones left on the server. Resolved over the files
 * here alone, a link to an attachment not here yet resolves to some other
 * file of that name, or to none, and the one meant is never fetched.
 *
 * Case-insensitive throughout. `./` and `../` from the note's folder, then the
 * path as written from the vault's root, then any path ending in it: those
 * under the note's folder first, each group shortest first. A name with no
 * extension is a note's, as `name.md`.
 */
export function resolveLink(
  link: string,
  source: string,
  files: readonly string[],
): string | undefined {
  const written = linkpathOf(link);
  if (written === "") return undefined;
  const named = (base: string): string[] => files.filter((f) => baseOf(f.toLowerCase()) === base);
  let want = written.toLowerCase();
  let candidates = baseOf(want).includes(".") ? named(baseOf(want)) : [];
  if (candidates.length === 0) {
    want = `${written}.md`.toLowerCase();
    candidates = named(baseOf(want));
  }
  if (candidates.length === 0) return undefined;
  if (baseOf(want) === want && candidates.length === 1) return candidates[0];
  let dir = dirOf(source).toLowerCase();
  if (want.startsWith("./") || want.startsWith("../")) {
    if (want.startsWith("./../")) want = want.slice(2);
    if (want.startsWith("./")) {
      if (dir !== "") dir += "/";
      want = dir + want.slice(2);
    } else {
      while (want.startsWith("../")) {
        want = want.slice(3);
        dir = dirOf(dir);
      }
      if (dir !== "") dir += "/";
      want = dir + want;
    }
    const hit = candidates.find((f) => f.toLowerCase() === want);
    if (hit !== undefined) return hit;
  }
  if (want.startsWith("/")) want = want.slice(1);
  const exact = candidates.find((f) => f.toLowerCase() === want);
  if (exact !== undefined) return exact;
  if (written.startsWith("/")) return undefined;
  const near: string[] = [];
  const far: string[] = [];
  for (const f of candidates) {
    const lower = f.toLowerCase();
    if (lower.endsWith(want)) (lower.startsWith(dir) ? near : far).push(f);
  }
  const shortest = (a: string, b: string): number => a.length - b.length;
  return near.sort(shortest)[0] ?? far.sort(shortest)[0];
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** The links and embeds Obsidian's metadata cache lists for a note, as written. */
export interface NoteLinks {
  embeds?: readonly { link: string }[];
  links?: readonly { link: string }[];
  frontmatterLinks?: readonly { link: string }[];
}

/**
 * The server-only files a note embeds or links, which opening it fetches:
 * each link resolved over the files here and on the server together
 * (`resolveLink`), kept when what it means is not here.
 */
export function neededBy(
  note: string,
  cache: NoteLinks | null | undefined,
  serverOnly: ReadonlyMap<string, number>,
  local: readonly string[],
): string[] {
  if (cache == null || serverOnly.size === 0) return [];
  const files = [...local, ...serverOnly.keys()];
  const wanted = new Set<string>();
  for (const ref of [
    ...(cache.embeds ?? []),
    ...(cache.links ?? []),
    ...(cache.frontmatterLinks ?? []),
  ]) {
    const path = resolveLink(ref.link, note, files);
    if (path !== undefined && serverOnly.has(path)) wanted.add(path);
  }
  return [...wanted];
}

/** A size for a person: `1.8 GB`, `12.4 MB`, `640 KB`. */
export function bytesForPeople(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} bytes`;
}

/**
 * Every file this device left on the server, to pick one to download: a
 * search box over the names, biggest first when there is nothing typed.
 */
export class ServerOnlyModal extends Modal {
  constructor(
    app: App,
    private readonly files: ReadonlyMap<string, number>,
    private readonly choose: (path: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Download a file kept on the server");
    const list = this.contentEl.createDiv();
    const draw = (query: string): void => {
      list.empty();
      const q = query.trim().toLowerCase();
      const shown = [...this.files]
        .filter(([path]) => q === "" || path.toLowerCase().includes(q))
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 100);
      for (const [path, size] of shown) {
        new Setting(list)
          .setName(path)
          .setDesc(bytesForPeople(size))
          .addButton((b) =>
            b.setButtonText("Download").onClick(() => {
              this.choose(path);
              this.close();
            }),
          );
      }
      if (shown.length === 0) list.createEl("p", { text: "No file on the server only matches." });
    };
    new Setting(this.contentEl)
      .setName("Find")
      .addText((t) => t.setPlaceholder("A name").onChange((v) => draw(v)));
    this.contentEl.appendChild(list);
    draw("");
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
