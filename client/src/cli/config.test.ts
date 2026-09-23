/**
 * `removeState` removed the index and the config and proved
 * both gone, and did not sync the directory they were in, so a power cut right
 * after an unlink could bring the config back: a vault that reads as paired to
 * a server it was told to forget, with a fresh index built against it on the
 * next run.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const synced: string[] = [];

/**
 * The seam is `syncDirectoryIfSupported`, not `syncDirectory`.
 *
 * That is what the removals call, and a call from inside vault.ts to its own
 * `syncDirectory` does not go through a mock of it: these two tests passed for
 * a while against a wrapper they had stopped exercising. What each errno means
 * is tested against the real function in durable-removal.test.ts.
 */
vi.mock("./vault.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./vault.ts")>();
  return {
    ...real,
    syncDirectoryIfSupported: async (dir: string) => {
      synced.push(dir);
      return real.syncDirectoryIfSupported(dir);
    },
  };
});

import {
  STATE_DIR,
  attentionPath,
  configPath,
  indexLog,
  indexPath,
  loadAttention,
  loadConfig,
  orphanedIndex,
  removeConfig,
  removeIndex,
  removeState,
  saveAttention,
  saveConfig,
} from "./config.ts";
import { generateDeviceId, generateDeviceToken } from "../core/pairing.ts";

const dirs: string[] = [];
afterEach(async () => {
  synced.length = 0;
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function paired(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trew-config-"));
  dirs.push(dir);
  await saveConfig(dir, {
    url: "ws://x",
    vaultId: "default",
    device: "d",
    deviceId: generateDeviceId(),
    deviceToken: generateDeviceToken(),
  });
  return dir;
}

describe("forgetting a pairing, durably", () => {
  it("syncs the state directory after removing the config", async () => {
    const dir = await paired();
    synced.length = 0;
    await removeState(dir);
    expect(synced).toContain(join(dir, STATE_DIR));
  });

  it("syncs the state directory after removing the index alone", async () => {
    const dir = await paired();
    synced.length = 0;
    await removeIndex(dir);
    expect(synced).toContain(join(dir, STATE_DIR));
  });

  /**
   * What a refused pairing leaves: the pending pairing it saved before
   * sending anything, removed and then looked for (`PairingStore.forget`), so
   * "nothing is saved after a refusal" is a fact and not a claim.
   */
  it("removes the config alone, proves it gone, and syncs the directory", async () => {
    const dir = await paired();
    await writeFile(indexPath(dir), '{"cursor":0,"entries":{},"remote":{},"pending":[]}');
    synced.length = 0;
    expect(await removeConfig(dir)).toBeUndefined();
    await expect(stat(configPath(dir))).rejects.toThrow(/ENOENT/);
    expect(await loadConfig(dir)).toBeUndefined();
    expect(synced).toContain(join(dir, STATE_DIR));
    // Only the config: anything else there is not this function's to take.
    await expect(stat(indexPath(dir))).resolves.toBeDefined();
  });

  it("takes the record of what needs attention with the rest of an unlink", async () => {
    // Left behind, it would be what the next pairing's status reported until
    // that pairing's first sync replaced it.
    const dir = await paired();
    await saveAttention(dir, { at: 1, count: 1, paths: [{ path: "a.md", why: "why" }] });
    await removeState(dir);
    await expect(stat(attentionPath(dir))).rejects.toThrow(/ENOENT/);
    expect(await loadAttention(dir)).toBeUndefined();
  });
});

/**
 * What the last sync left needing attention, as `trew status` reads it back
 * (PLAN.md section 4.9). Absent, readable and unreadable are three answers,
 * and the third is not the first (rule 2).
 */
describe("the record of what needs attention", () => {
  it("reads back what was written, exactly", async () => {
    const dir = await paired();
    const record = {
      at: 1_790_000_000_000,
      count: 3,
      paths: [
        { path: "bell\u0007.md", why: "control: the path contains a control character" },
        { path: "long.md", why: "toolong: the path is 1039 bytes of UTF-8" },
      ],
    };
    await saveAttention(dir, record);
    expect(await loadAttention(dir)).toEqual(record);
    // Private, like the config beside it: the paths are somebody's note names.
    expect((await stat(attentionPath(dir))).mode & 0o077).toBe(0);
  });

  it("is absent before any sync has written one", async () => {
    expect(await loadAttention(await paired())).toBeUndefined();
  });

  it("refuses a record it cannot read, rather than reading it as nothing", async () => {
    const dir = await paired();
    await writeFile(attentionPath(dir), '{"at": 1, "count": ');
    await expect(loadAttention(dir)).rejects.toThrow(/not valid JSON/);
    for (const wrong of [
      "[]",
      '{"at": 1, "count": 0}',
      '{"at": "soon", "count": 0, "paths": []}',
      '{"at": 1, "count": 0, "paths": [{"path": "a.md", "why": "w"}]}',
      '{"at": 1, "count": 1, "paths": [{"path": "a.md"}]}',
    ]) {
      await writeFile(attentionPath(dir), wrong);
      await expect(loadAttention(dir), wrong).rejects.toThrow(/does not hold a record/);
    }
  });
});

/**
 * The index is two files now, and both of them are the index.
 *
 * A journal left behind after an unlink is a delta against a snapshot that no
 * longer exists, and the next load refuses to start rather than guessing at a
 * base. Anything that removed the index and left one would have the vault
 * refuse every command until somebody deleted a file nothing told them about.
 */
describe("removing an index that has a journal", () => {
  async function withIndex(): Promise<string> {
    const dir = await paired();
    await writeFile(indexPath(dir), '{"cursor":1,"entries":{},"remote":{},"pending":[],"seq":2}');
    await writeFile(indexLog(dir), "1 00000000 {}\n");
    return dir;
  }

  it("removes the journal as well, and proves it", async () => {
    const dir = await withIndex();
    await removeIndex(dir);
    await expect(stat(indexLog(dir)), "the journal outlived the index").rejects.toThrow(/ENOENT/);
    await expect(stat(indexPath(dir))).rejects.toThrow(/ENOENT/);
  });

  it("takes the journal with the rest of the state on an unlink", async () => {
    const dir = await withIndex();
    await removeState(dir);
    await expect(stat(indexLog(dir))).rejects.toThrow(/ENOENT/);
  });

  it("counts a journal on its own as an orphaned index", async () => {
    // Pairing over one would load a delta with nothing to apply it to. The
    // refusal has to name it, or the next command fails somewhere further in
    // with no way back.
    const dir = await withIndex();
    await rm(indexPath(dir));
    expect(await orphanedIndex(dir), "a journal on its own read as no index at all").toBe(true);
  });
});
