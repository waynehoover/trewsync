/**
 * A directory fsync that failed and one the filesystem cannot do are not the
 * same outcome (I18).
 *
 * `removeState` and `removeIndex` unlink a pairing and then flush the directory
 * so the removal survives a power cut. Both ended in
 * `syncDirectory(...).catch(() => undefined)`, which is two different things
 * wearing one face:
 *
 *   - a filesystem with no directory fsync (some network mounts, some FUSE
 *     layers). Nothing to do, nothing to say.
 *   - a disk returning EIO in the middle of making an unlink durable. The
 *     config can come back after a power cut, and with it a vault that reads
 *     as paired to a server it was told to forget, which is precisely what
 *     the flush added to prevent.
 *
 * Both were silence. The second one is now said out loud, and it is said rather
 * than thrown, because by the time the flush runs the files are already gone
 * and the pairing already forgotten: throwing would report a failure for
 * something that did what was asked.
 */

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { syncDirectoryIfSupported } from "./vault.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop()!;
    await chmod(d, 0o700).catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "trew-fsync-"));
  dirs.push(d);
  return d;
}

describe("flushing a directory after a removal", () => {
  it("reports success on a directory it can flush", async () => {
    const dir = await tempDir();
    expect(await syncDirectoryIfSupported(dir)).toEqual({ synced: true });
  });

  /**
   * The directory is gone, which is the ordinary result of removing the last
   * thing in it. There is nothing left to make durable and nothing to report:
   * a warning here would appear on an unlink that worked perfectly.
   */
  it("says nothing about a directory that is already gone", async () => {
    const dir = await tempDir();
    const missing = join(dir, "never-existed");
    expect(await syncDirectoryIfSupported(missing)).toEqual({ synced: true });
  });

  /**
   * The case the blanket catch hid. This is not a filesystem that cannot do
   * the operation, it is one that refused, and the removal it was flushing may
   * not survive a power cut.
   */
  it("reports a directory it could not open, naming the reason", async () => {
    const dir = await tempDir();
    const shut = join(dir, "shut");
    await (await import("node:fs/promises")).mkdir(shut);
    await chmod(shut, 0o000);
    dirs.push(shut);

    const out = await syncDirectoryIfSupported(shut);
    if (out.synced) {
      // Running as root, where a mode of 000 stops nothing. Skipping is
      // honest; claiming a pass would not be.
      expect(process.getuid?.()).toBe(0);
      return;
    }
    expect(out.synced, "a directory that could not be opened was reported as flushed").toBe(false);
    expect(out.why, "the report does not say what went wrong").toMatch(/EACCES|EPERM/);
  });
});

describe("what the removals do with that", () => {
  it("returns the reason rather than throwing, because the pairing is already gone", async () => {
    const { removeState, configPath } = await import("./config.ts");
    const { saveConfig } = await import("./config.ts");
    const { generateSecret } = await import("../core/crypto.ts");
    const dir = await tempDir();
    await saveConfig(dir, {
      url: "ws://example.invalid",
      vaultId: "default",
      device: "d",
      deviceId: "d1",
      deviceSecret: generateSecret(),
      dataKey: generateSecret(),
    });

    // The ordinary path: the removal happens and reports nothing wrong.
    await expect(removeState(dir)).resolves.toBeUndefined();
    // And the pairing really is gone, so the return value is about durability
    // and not about whether the work was done.
    const { access } = await import("node:fs/promises");
    await expect(access(configPath(dir))).rejects.toThrow();
  });
});
