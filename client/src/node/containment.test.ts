/**
 * Nothing internal is written outside the vault, whatever `.trew` is (R11).
 *
 * F24 gave `NodeVault.write` a containment check and the trash a pair of them,
 * and stopped there. The config, the index, the lock and the exclusive-create
 * path all write under `.trew` and none of them asked. A `.trew` that is a
 * symlink to somewhere else therefore put this device's credential, its index
 * and its lock outside the vault, and no race was needed to arrange it: an
 * ordinary pre-existing filesystem layout does it, which is why this is about
 * accidents as much as about a hostile process.
 */

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  STATE_DIR,
  removeConfig,
  removeIndex,
  removeState,
  saveAttention,
  saveConfig,
} from "./config.ts";
import { lockVault } from "./lock.ts";
import { NodeVault } from "./vault.ts";
import { generateDeviceToken } from "../core/pairing.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A vault whose `.trew` is a link to somewhere else entirely. */
async function vaultWithEscapingState(): Promise<{ vault: string; elsewhere: string }> {
  const base = await mkdtemp(join(tmpdir(), "trew-contain-"));
  dirs.push(base);
  const vault = join(base, "vault");
  const elsewhere = join(base, "elsewhere");
  await mkdir(vault, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, join(vault, STATE_DIR));
  return { vault, elsewhere };
}

const config = () => ({
  url: "ws://example.invalid",
  vaultId: "default",
  device: "d",
  deviceId: "d1",
  deviceToken: generateDeviceToken(),
});

describe("a .trew that leaves the vault", () => {
  it("is refused by saveConfig, and writes nothing outside", async () => {
    const { vault, elsewhere } = await vaultWithEscapingState();
    await expect(saveConfig(vault, config())).rejects.toThrow(/leaves the vault/);
    expect(await readdir(elsewhere), "the config was written outside the vault").toEqual([]);
  });

  it("is refused by the lock", async () => {
    const { vault, elsewhere } = await vaultWithEscapingState();
    await expect(lockVault(vault, "sync")).rejects.toThrow(/leaves the vault/);
    expect(await readdir(elsewhere), "the lock was taken outside the vault").toEqual([]);
  });

  it("is refused by the index removals", async () => {
    const { vault } = await vaultWithEscapingState();
    await expect(removeIndex(vault)).rejects.toThrow(/leaves the vault/);
    await expect(removeState(vault)).rejects.toThrow(/leaves the vault/);
    // And by the removal a refused pairing makes of what it saved.
    await expect(removeConfig(vault)).rejects.toThrow(/leaves the vault/);
  });

  it("is refused by the record of what needs attention, and writes nothing outside", async () => {
    const { vault, elsewhere } = await vaultWithEscapingState();
    await expect(saveAttention(vault, { at: 1, count: 0, paths: [] })).rejects.toThrow(
      /leaves the vault/,
    );
    expect(await readdir(elsewhere), "the record was written outside the vault").toEqual([]);
  });
});

describe("a staging directory that leaves the vault", () => {
  it("is refused by an exclusive create", async () => {
    const base = await mkdtemp(join(tmpdir(), "trew-contain-"));
    dirs.push(base);
    const vault = join(base, "vault");
    const elsewhere = join(base, "elsewhere");
    await mkdir(join(vault, STATE_DIR), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(vault, STATE_DIR, "tmp"));

    const v = new NodeVault(vault);
    await expect(
      v.create("note.md", new TextEncoder().encode("hello"), { mtime: 1000, ctime: 1000 }),
    ).rejects.toThrow(/leaves the vault/);
    expect(
      await readdir(elsewhere),
      "an exclusive create staged its bytes outside the vault",
    ).toEqual([]);
  });
});

describe("a note path that leaves the vault", () => {
  /**
   * Reading followed the same rule as writing, eventually.
   *
   * `absolute` is lexical: it refuses `../` and the excluded names, and it
   * cannot see a symlink, so every write calls `insideForReal` after it and
   * `read` did not. That was defensible while the only caller was the engine,
   * which reads paths its own `list` produced and `list` does not follow
   * links. It stops being defensible the moment a path arrives from somewhere
   * that is not this device: `trew mcp` hands an agent's path straight to
   * the adapter, and a read primitive that follows a link out of the vault is
   * a read primitive for the whole filesystem.
   *
   * The leaf and the ancestor are both tested because they fail differently:
   * a link in the middle of a path is the one a lexical check is most likely
   * to be thought to have covered.
   */
  it("is refused by read, whether the link is the leaf or an ancestor", async () => {
    const base = await mkdtemp(join(tmpdir(), "trew-contain-read-"));
    dirs.push(base);
    const vault = join(base, "vault");
    const elsewhere = join(base, "elsewhere");
    await mkdir(vault, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "secret.md"), "not yours\n");
    await symlink(join(elsewhere, "secret.md"), join(vault, "leaf.md"));
    await symlink(elsewhere, join(vault, "ancestor"));

    const v = new NodeVault(vault);
    await expect(v.read("leaf.md")).rejects.toThrow(/leaves the vault/);
    await expect(v.read("ancestor/secret.md")).rejects.toThrow(/leaves the vault/);
  });

  it("still reads an ordinary note, and one under a real folder", async () => {
    const base = await mkdtemp(join(tmpdir(), "trew-contain-read-ok-"));
    dirs.push(base);
    const vault = join(base, "vault");
    await mkdir(join(vault, "folder"), { recursive: true });
    await writeFile(join(vault, "note.md"), "mine\n");
    await writeFile(join(vault, "folder", "deep.md"), "also mine\n");

    const v = new NodeVault(vault);
    expect(new TextDecoder().decode(await v.read("note.md"))).toBe("mine\n");
    expect(new TextDecoder().decode(await v.read("folder/deep.md"))).toBe("also mine\n");
  });
});

describe("an ordinary vault", () => {
  it("is not refused by any of it", async () => {
    const base = await mkdtemp(join(tmpdir(), "trew-contain-ok-"));
    dirs.push(base);
    const vault = join(base, "vault");
    await mkdir(vault, { recursive: true });

    await saveConfig(vault, config());
    const release = await lockVault(vault, "sync");
    await release();
    const v = new NodeVault(vault);
    expect(
      await v.create("note.md", new TextEncoder().encode("hello"), { mtime: 1000, ctime: 1000 }),
    ).toBe(true);
    await expect(removeState(vault)).resolves.toBeUndefined();
    void writeFile;
  });
});
