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
  "list" | "exists" | "mkdir" | "readBinary" | "writeBinary" | "remove" | "stat" | "rmdir"
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
 * and `snippets/<name>.css`. Judged under the name the vault syncs, in NFC,
 * and returned under the name the disk has, which is the one to copy.
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
      if (configPathReason(file.normalize("NFC")) === undefined) out.push(file);
    }
  }
  return out.sort();
}

/**
 * Folders a profile copy leaves out: a plugin developer's dependencies and
 * repository, which can be most of a desktop's config folder and are no part
 * of a plugin Obsidian loads.
 */
const NOT_COPIED = new Set(["node_modules", ".git"]);

/** Every file in `root` and everything under it, as vault paths. */
async function everythingIn(adapter: Adapter, root: string): Promise<string[]> {
  const out: string[] = [];
  const folders = [root];
  while (folders.length > 0) {
    const here = await adapter.list(folders.pop()!);
    for (const folder of here.folders) {
      if (!NOT_COPIED.has(folder.slice(folder.lastIndexOf("/") + 1))) folders.push(folder);
    }
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
 * This device's settings as they are, kept in one folder the plugin owns
 * before every Apply, replacing the last such copy (rule 3). An Apply writes
 * the server's settings over this device's, and where the first choice
 * settles a setting this device never synced, there is no copy of the one it
 * replaces anywhere else.
 */
export async function keepSettingsBeforeApply(
  adapter: Adapter,
  root: string,
  pluginDir: string,
): Promise<number> {
  const folder = `${pluginDir}/settings-before-apply`;
  if (await adapter.exists(folder)) await adapter.rmdir(folder, true);
  return copyVerified(adapter, await settingsIn(adapter, root), root, folder);
}

/**
 * A new settings profile, `to`, as a verified copy of everything in `from`:
 * settings, plugins and this plugin with its pairing and index, so the device
 * that relaunches into it syncs on from where it was. Refused when `to` is
 * already there, because copying into a profile another device has filled
 * would mix two devices' settings in one folder.
 *
 * A copy that fails part way is removed, because a profile without every
 * plugin in it is one Obsidian relaunches into without this one: `to` was
 * not there before, and nothing else writes a folder no device runs.
 */
export async function createProfile(adapter: Adapter, from: string, to: string): Promise<number> {
  if (await adapter.exists(to)) {
    throw new Error(`${to} already exists. Choose another name.`);
  }
  try {
    return await copyVerified(adapter, await everythingIn(adapter, from), from, to);
  } catch (err) {
    if (await adapter.exists(to)) await adapter.rmdir(to, true);
    throw err;
  }
}

/** Size and time of a file, or null when it is not there. */
export async function stampOf(
  adapter: Adapter,
  path: string,
): Promise<{ size: number; mtime: number } | null> {
  const stat = await adapter.stat(path);
  return stat === null ? null : { size: stat.size, mtime: stat.mtime };
}
