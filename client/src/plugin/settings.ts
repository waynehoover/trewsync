/**
 * Settings sync's work on the config folder itself (plan/settings-sync.md):
 * which folder a device runs, the copy of its settings taken before the first
 * sync can replace any, and a new settings profile made from the one running.
 *
 * Everything here goes through the adapter, because Obsidian's index never
 * lists a dot folder, and every copy is read back before it counts: a backup
 * nobody checked is a hope, and a profile copied short is a device that
 * relaunches without the plugin that would have noticed.
 */

import type { DataAdapter } from "obsidian";

import { configPathReason, isProfileRoot } from "../core/path-policy.ts";
import { configFolderName } from "../core/paths.ts";

type Adapter = Pick<
  DataAdapter,
  "list" | "exists" | "mkdir" | "readBinary" | "writeBinary" | "remove" | "stat"
>;

/**
 * The profile root a device runs, or undefined when its config folder is not
 * one settings sync can use: `.obsidian`, or `.obsidian-` and a name of 1 to
 * 32 lower-case letters, digits and dashes. Another name cannot be told apart
 * from `.git` or `.trash` by its shape, so it is not guessed at.
 */
export function profileRootOf(configDir: string): string | undefined {
  const name = configFolderName(configDir);
  return isProfileRoot(name) ? name : undefined;
}

/** Whether `name` makes a profile root as `.obsidian-<name>`. */
export function isProfileName(name: string): boolean {
  return isProfileRoot(`.obsidian-${name}`);
}

/**
 * Every setting settings sync carries in `root`, as vault paths, walked as
 * the vault lists them: the JSON files at its top, `themes/<theme>/<file>`
 * and `snippets/<name>.css`.
 */
export async function settingsIn(adapter: Adapter, root: string): Promise<string[]> {
  if (!(await adapter.exists(root))) return [];
  const out: string[] = [];
  const folders = [root];
  while (folders.length > 0) {
    const here = await adapter.list(folders.pop()!);
    for (const folder of here.folders) {
      const rel = folder.slice(root.length + 1);
      const theme = rel.startsWith("themes/") && !rel.slice("themes/".length).includes("/");
      if (rel === "themes" || rel === "snippets" || theme) folders.push(folder);
    }
    for (const file of here.files) {
      if (configPathReason(file) === undefined) out.push(file);
    }
  }
  return out.sort();
}

/** Every file in `root` and everything under it, as vault paths. */
async function everythingIn(adapter: Adapter, root: string): Promise<string[]> {
  const out: string[] = [];
  const folders = [root];
  while (folders.length > 0) {
    const here = await adapter.list(folders.pop()!);
    folders.push(...here.folders);
    out.push(...here.files);
  }
  return out.sort();
}

/**
 * Copies `files`, each from under `from` to the same place under `to`, and
 * reads every copy back. A copy that differs from what was read fails the
 * whole thing, after which `to` holds what was copied so far and nothing
 * under `from` has been touched.
 */
async function copyVerified(
  adapter: Adapter,
  files: readonly string[],
  from: string,
  to: string,
): Promise<number> {
  for (const file of files) {
    const target = `${to}${file.slice(from.length)}`;
    await ensureFolder(adapter, target.slice(0, target.lastIndexOf("/")));
    const bytes = new Uint8Array(await adapter.readBinary(file));
    await adapter.writeBinary(target, bytes.slice().buffer);
    const back = new Uint8Array(await adapter.readBinary(target));
    if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) {
      throw new Error(`the copy of ${file} at ${target} does not read back as what was copied`);
    }
  }
  return files.length;
}

/**
 * Makes `folder` and every folder above it that is missing, one level at a
 * time, as `ensureParents` in vault.ts does: neither adapter promises that
 * `mkdir` makes the levels above.
 */
async function ensureFolder(adapter: Adapter, folder: string): Promise<void> {
  let at = "";
  for (const part of folder.split("/")) {
    at = at === "" ? part : `${at}/${part}`;
    if (!(await adapter.exists(at))) await adapter.mkdir(at);
  }
}

/**
 * Keeps this device's settings, as they are, before settings sync first runs
 * here (rule 3). The server's version of a setting this device has never
 * synced replaces it without a copy beside it, because the replacement is
 * what the person chose, so this is the copy. In a new folder each time,
 * under the plugin's own, which never syncs.
 */
export async function backUpSettings(
  adapter: Adapter,
  root: string,
  pluginDir: string,
  now: Date,
): Promise<{ folder: string; files: number }> {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const folder = `${pluginDir}/settings-before-sync-${stamp}`;
  if (await adapter.exists(folder)) throw new Error(`${folder} is already there`);
  const files = await copyVerified(adapter, await settingsIn(adapter, root), root, folder);
  return { folder, files };
}

/**
 * A new settings profile, `to`, as a verified copy of everything in `from`:
 * settings, plugins and this plugin with its pairing and index, so the device
 * that relaunches into it syncs on from where it was. Refused when `to` is
 * already there, because copying into a profile another device has filled
 * would mix two devices' settings in one folder.
 *
 * Then the index the copy carries on with is removed from `from`, so that if
 * Obsidian is ever pointed back at `from`, this plugin there starts over and
 * decides by content rather than resuming from a record the copy has moved
 * past.
 */
export async function createProfile(
  adapter: Adapter,
  from: string,
  to: string,
  indexFiles: readonly string[],
): Promise<number> {
  if (await adapter.exists(to)) {
    throw new Error(`${to} already exists. Point Obsidian at it instead, or choose another name.`);
  }
  const files = await copyVerified(adapter, await everythingIn(adapter, from), from, to);
  for (const file of indexFiles) {
    if (await adapter.exists(file)) await adapter.remove(file);
  }
  return files;
}
