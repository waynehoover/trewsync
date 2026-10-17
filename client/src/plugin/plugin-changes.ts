/**
 * What an Apply would do to this device's community plugins, said before it
 * does it (plan/settings-sync.md, section 6).
 *
 * A plugin another device installed, updated or switched on is code that
 * runs here once applied, so the Apply dialog names each one: which plugin,
 * which version, from which device, and whether Obsidian will run it on this
 * kind of device at all. Worked out from the settings the engine holds and
 * the server's versions of them, read before anything is written.
 */

import type { HeldSetting } from "../core/engine.ts";
import { COMMUNITY_PLUGINS } from "../core/path-policy.ts";
import { sharedList } from "./community-plugins.ts";

export interface PluginChange {
  readonly id: string;
  readonly kind: "install" | "update" | "settings" | "remove";
  /** The plugin's name, from its manifest, or its id where none can be read. */
  readonly name: string;
  /** The version being applied, from the incoming manifest. */
  readonly version?: string;
  /** The version this device has now, from its manifest. */
  readonly installed?: string;
  /** The device that wrote the incoming version. */
  readonly from?: string;
  /** Whether the incoming manifest says the plugin runs on desktops only. */
  readonly desktopOnly?: boolean;
}

export interface PluginChanges {
  readonly plugins: readonly PluginChange[];
  /** Plugins the incoming list switches on and off, when the list itself waits. */
  readonly switchedOn: readonly string[];
  readonly switchedOff: readonly string[];
  /** Settings waiting that are not community plugins'. */
  readonly otherSettings: number;
}

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly isDesktopOnly?: boolean;
}

function manifestOf(bytes: Uint8Array | undefined): Manifest | undefined {
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const m = value as Record<string, unknown>;
    return {
      ...(typeof m["name"] === "string" ? { name: m["name"] } : {}),
      ...(typeof m["version"] === "string" ? { version: m["version"] } : {}),
      ...(m["isDesktopOnly"] === true ? { isDesktopOnly: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function listOf(bytes: Uint8Array | undefined): string[] | undefined {
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(sharedList(bytes)),
    );
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The plugin changes among `waiting`, the settings held for Apply under the
 * group's folder `root`. `held` reads the server's version of a held setting
 * and `local` this device's copy of a path, by the path it syncs as; either
 * may answer undefined, and the change is then described with less.
 */
export async function describePluginChanges(
  waiting: readonly HeldSetting[],
  root: string,
  read: {
    held(setting: HeldSetting): Promise<Uint8Array | undefined>;
    local(path: string): Promise<Uint8Array | undefined>;
  },
): Promise<PluginChanges> {
  const prefix = `${root}/plugins/`;
  const byPlugin = new Map<string, HeldSetting[]>();
  let list: HeldSetting | undefined;
  let otherSettings = 0;
  for (const setting of waiting) {
    if (setting.path === `${root}/${COMMUNITY_PLUGINS}`) {
      list = setting;
    } else if (setting.path.startsWith(prefix) && setting.path.slice(prefix.length).includes("/")) {
      const id = setting.path.slice(prefix.length).split("/")[0]!;
      byPlugin.set(id, [...(byPlugin.get(id) ?? []), setting]);
    } else {
      otherSettings++;
    }
  }

  const plugins: PluginChange[] = [];
  for (const [id, files] of [...byPlugin].sort(([a], [b]) => a.localeCompare(b))) {
    const manifestPath = `${prefix}${id}/manifest.json`;
    const heldManifest = files.find((f) => f.path === manifestPath && !f.deleted);
    const incoming = heldManifest ? manifestOf(await read.held(heldManifest)) : undefined;
    const installed = manifestOf(await read.local(manifestPath));
    const from = (heldManifest ?? files[0]!).device;
    const kind = files.every((f) => f.deleted)
      ? "remove"
      : installed === undefined
        ? "install"
        : files.some((f) => !f.path.endsWith("/data.json"))
          ? "update"
          : "settings";
    plugins.push({
      id,
      kind,
      name: incoming?.name ?? installed?.name ?? id,
      ...(incoming?.version ? { version: incoming.version } : {}),
      ...(installed?.version ? { installed: installed.version } : {}),
      ...(from ? { from } : {}),
      ...(incoming?.isDesktopOnly ? { desktopOnly: true } : {}),
    });
  }

  let switchedOn: string[] = [];
  let switchedOff: string[] = [];
  if (list !== undefined) {
    const next = list.deleted ? [] : (listOf(await read.held(list)) ?? undefined);
    const now = listOf(await read.local(list.path)) ?? [];
    if (next !== undefined) {
      switchedOn = next.filter((id) => !now.includes(id));
      switchedOff = now.filter((id) => !next.includes(id));
    }
  }
  return { plugins, switchedOn, switchedOff, otherSettings };
}

/** One line a person reads about a plugin change, without the device it came from. */
export function describeChange(change: PluginChange): string {
  switch (change.kind) {
    case "install":
      return `Install ${change.name}${change.version ? ` ${change.version}` : ""}`;
    case "update":
      return change.installed && change.version && change.installed !== change.version
        ? `Update ${change.name} from ${change.installed} to ${change.version}`
        : `Update ${change.name}${change.version ? ` ${change.version}` : ""}`;
    case "settings":
      return `Change ${change.name}'s settings`;
    case "remove":
      return `Remove ${change.name}`;
  }
}
