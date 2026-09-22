import { normalizePath, type DataAdapter } from "obsidian";
import { configFolderName, isNeverSynced } from "../core/paths.ts";

/** A populated vault needs consent before its files join the synced vault. */
export class MergeConfirmationRequired extends Error {
  constructor() {
    super("Confirm merging this vault's existing files before pairing.");
  }
}

/** Check the actual files before registering a device or spending its invite. */
export async function checkFirstSync(
  adapter: Pick<DataAdapter, "list">,
  configDir: string,
  mergeConfirmed = false,
): Promise<void> {
  if (mergeConfirmed === true) return;
  const excluded = new Set([configFolderName(configDir)]);
  const included = (path: string) => !isNeverSynced(normalizePath(path), excluded);
  const folders = [""];
  while (folders.length > 0) {
    // The loaded-file cache may still be filling when a QR link opens Obsidian.
    // A failed directory read must also refuse pairing, never mean "empty".
    const listed = await adapter.list(folders.pop()!);
    if (listed.files.some(included)) {
      throw new MergeConfirmationRequired();
    }
    folders.push(...listed.folders.filter(included));
  }
}
