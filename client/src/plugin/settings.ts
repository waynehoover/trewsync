/**
 * Settings sync's work on the config folder itself (plan/settings-sync.md):
 * the copies of a device's settings kept before the first sync and before
 * every Apply can replace any.
 *
 * Everything here goes through the adapter, because Obsidian's index never
 * lists a dot folder, and every copy is read back before it counts: a backup
 * nobody checked is a hope.
 */

import type { DataAdapter } from "obsidian";

import { configPathReason, isDeviceLocalPlugin } from "../core/path-policy.ts";

type Adapter = Pick<
  DataAdapter,
  "list" | "exists" | "mkdir" | "readBinary" | "writeBinary" | "rmdir"
>;

/**
 * Every setting settings sync carries in `root`, the config folder this
 * device runs, as vault paths, walked as the vault lists them: the JSON files
 * at its top, `themes/<theme>/<file>` and `snippets/<name>.css`, and with
 * `plugins` each plugin's settings, `plugins/<id>/data.json`, but those that
 * never move. Judged as the paths they sync as, under `group` and in NFC, and
 * returned under the name the disk has, which is the one to copy.
 */
export async function settingsIn(
  adapter: Adapter,
  root: string,
  group: string,
  plugins = false,
  /**
   * The folder this plugin runs from, left out: it holds this device's
   * pairing and index, and the copies themselves are made inside it.
   */
  ownFolder?: string,
): Promise<string[]> {
  if (!(await adapter.exists(root))) return [];
  const out: string[] = [];
  const folders = [root];
  while (folders.length > 0) {
    const here = await adapter.list(folders.pop()!);
    for (const folder of here.folders) {
      const rel = folder.slice(root.length + 1);
      const theme = rel.startsWith("themes/") && !rel.slice("themes/".length).includes("/");
      const segments = rel.split("/");
      const plugin =
        plugins &&
        segments[0] === "plugins" &&
        (segments.length === 1 ||
          (segments.length === 2 &&
            !isDeviceLocalPlugin(segments[1]!) &&
            !segments[1]!.startsWith(".")));
      if (folder === ownFolder) continue;
      if (rel === "themes" || rel === "snippets" || theme || plugin) folders.push(folder);
    }
    for (const file of here.files) {
      const synced = `${group}${file.slice(root.length)}`.normalize("NFC");
      if (configPathReason(synced, plugins) !== undefined) continue;
      out.push(file);
    }
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
 * here with `group` (rule 3), whether it was off or syncing with another
 * group. The server's version of a setting this device has never synced in
 * that group replaces it without a copy beside it, because the replacement is
 * what the person chose, so this is the copy. In a new folder each time,
 * under the plugin's own, which never syncs: one made in the same second as
 * the last, by changing group twice, takes the next free name rather than
 * refusing the change or filling the earlier copy.
 */
export async function backUpSettings(
  adapter: Adapter,
  root: string,
  group: string,
  pluginDir: string,
  now: Date,
  /**
   * Whether this device is to sync its plugins' settings, which the server's
   * can replace as they replace its own: the copy then takes them too.
   */
  plugins = false,
): Promise<{ folder: string; files: number }> {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  let folder = `${pluginDir}/settings-before-sync-${stamp}`;
  for (let n = 2; await adapter.exists(folder); n++) {
    folder = `${pluginDir}/settings-before-sync-${stamp}-${n}`;
  }
  const files = await copyVerified(
    adapter,
    await settingsIn(adapter, root, group, plugins, pluginDir),
    root,
    folder,
  );
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
  group: string,
  pluginDir: string,
  /** Whether this device syncs its plugins' settings, which are copied with the rest. */
  plugins = false,
): Promise<number> {
  const folder = `${pluginDir}/settings-before-apply`;
  if (await adapter.exists(folder)) await adapter.rmdir(folder, true);
  return copyVerified(
    adapter,
    await settingsIn(adapter, root, group, plugins, pluginDir),
    root,
    folder,
  );
}
