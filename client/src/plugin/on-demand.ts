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
 * The server-only file a note's link means, as Obsidian would resolve it if
 * the file were here: the vault path as written, then relative to the note's
 * folder, then the one whose path ends in it, shortest first. Undefined when
 * none matches.
 */
export function resolveServerOnly(
  link: string,
  source: string,
  serverOnly: Iterable<string>,
): string | undefined {
  const target = linkpathOf(link).replace(/^\/+/, "");
  if (target === "") return undefined;
  const paths = [...serverOnly];
  if (paths.includes(target)) return target;
  const folder = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  if (folder !== "") {
    const relative = normalizeRelative(`${folder}/${target}`);
    if (relative !== undefined && paths.includes(relative)) return relative;
  }
  const ends = paths.filter((p) => p.endsWith(`/${target}`));
  ends.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return ends[0];
}

/** `a/b/../c` as `a/c`, or undefined for one that climbs out of the vault. */
function normalizeRelative(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** The links and embeds Obsidian's metadata cache lists for a note, as written. */
export interface NoteLinks {
  embeds?: readonly { link: string }[];
  links?: readonly { link: string }[];
  frontmatterLinks?: readonly { link: string }[];
}

/**
 * The server-only files a note embeds or links, which opening it fetches.
 * `local` says whether Obsidian resolves a link to a file on this device,
 * which is then left alone.
 */
export function neededBy(
  note: string,
  cache: NoteLinks | null | undefined,
  serverOnly: ReadonlyMap<string, number>,
  local: (link: string) => boolean,
): string[] {
  if (cache == null || serverOnly.size === 0) return [];
  const wanted = new Set<string>();
  for (const ref of [
    ...(cache.embeds ?? []),
    ...(cache.links ?? []),
    ...(cache.frontmatterLinks ?? []),
  ]) {
    if (local(linkpathOf(ref.link))) continue;
    const path = resolveServerOnly(ref.link, note, serverOnly.keys());
    if (path !== undefined) wanted.add(path);
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
