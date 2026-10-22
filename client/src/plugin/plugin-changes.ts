/**
 * What an Apply would change in this device's community plugins' settings,
 * said before it does it (plan/settings-sync.md, section 6).
 *
 * Only a plugin's settings sync, its `data.json`, never its code, so the
 * Apply dialog names each plugin whose settings would change, the device the
 * change came from, and whether the plugin is installed here at all: settings
 * for one that is not wait in its folder until it is installed.
 */

import type { HeldSetting } from "../core/engine.ts";
import { fold } from "../core/fold.ts";

export interface PluginSettingsChange {
  readonly id: string;
  /** The plugin's name, from its manifest here, or its id where it is not installed. */
  readonly name: string;
  /** The device that wrote the incoming settings. */
  readonly from?: string;
  /** Whether the plugin is installed on this device. */
  readonly installed: boolean;
  /** Whether the incoming change removes the settings. */
  readonly removed: boolean;
  /** Whether it is the copy a conflict kept of another device's settings, not the settings. */
  readonly copy: boolean;
}

export interface PluginChanges {
  readonly plugins: readonly PluginSettingsChange[];
  /** Settings waiting that are not plugins'. */
  readonly otherSettings: number;
}

function nameIn(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const name = (value as Record<string, unknown>)["name"];
    return typeof name === "string" ? name : "";
  } catch {
    return undefined;
  }
}

/**
 * The plugin settings among `waiting`, the settings held for Apply under the
 * group's folder `root`. `local` reads this device's copy of a path, by the
 * path it syncs as, and answers undefined where there is none.
 */
export async function describePluginChanges(
  waiting: readonly HeldSetting[],
  root: string,
  local: (path: string) => Promise<Uint8Array | undefined>,
): Promise<PluginChanges> {
  const plugins: PluginSettingsChange[] = [];
  let otherSettings = 0;
  for (const setting of waiting) {
    const rest = setting.path.startsWith(`${root}/`)
      ? setting.path.slice(root.length + 1).split("/")
      : [];
    if (rest.length !== 3 || fold(rest[0]!) !== "plugins") {
      otherSettings++;
      continue;
    }
    const id = rest[1]!;
    const manifest = nameIn(await local(`${root}/plugins/${id}/manifest.json`));
    plugins.push({
      id,
      name: manifest || id,
      ...(setting.device ? { from: setting.device } : {}),
      installed: manifest !== undefined,
      removed: setting.deleted,
      copy: fold(rest[2]!) !== "data.json",
    });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins, otherSettings };
}

/** One line a person reads about a change, without the device it came from. */
export function describeChange(change: PluginSettingsChange): string {
  if (change.copy)
    return change.removed
      ? `Remove a conflict copy of ${change.name}'s settings`
      : `Add a conflict copy of ${change.name}'s settings`;
  if (change.removed) return `Remove ${change.name}'s settings`;
  return change.installed
    ? `Change ${change.name}'s settings`
    : `Keep settings for ${change.name}, ready for when it is installed here`;
}
