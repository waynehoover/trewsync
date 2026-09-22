/**
 * Moving a note to the trash across a filesystem boundary cannot delete a
 * newer version of it (R08).
 *
 * Where the vault and its `.trash` are on different filesystems a rename will
 * not do it, so the note is copied, the copy is verified, the copy is flushed,
 * and then the original is removed. F13 added the flush, which is what makes
 * the copy survive a power cut. What it did not change is that the removal was
 * unconditional and happened after that flush, which for a folder of
 * attachments is not a short operation: an editor saving into that window had
 * its work deleted on the strength of a comparison made about an older version.
 *
 * Nothing here can close the window entirely; a filesystem offers no
 * compare-and-unlink. What it can do is shrink it to one hash per file and
 * leave anything that does not match alone, so the worst case is a note in two
 * places rather than in none.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyVerifiedThenRemove, midTrash } from "./vault.ts";

const dirs: string[] = [];
afterEach(async () => {
  midTrash.pause = async () => {};
  midTrash.afterCompare = async () => {};
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "telimus-trash-"));
  dirs.push(dir);
  return dir;
}

describe("copying a note away and then removing it", () => {
  it("removes a file whose copy matches", async () => {
    const dir = await scratch();
    const source = join(dir, "note.md");
    const target = join(dir, "trash", "note.md");
    await mkdir(join(dir, "trash"), { recursive: true });
    await writeFile(source, "the only version\n");

    await copyVerifiedThenRemove(source, target);

    expect(await readFile(target, "utf8")).toBe("the only version\n");
    expect((await readdir(dir)).sort()).toEqual(["trash"]);
  });

  it("leaves a file that changed after its copy was verified, and says so", async () => {
    const dir = await scratch();
    const source = join(dir, "note.md");
    const target = join(dir, "trash", "note.md");
    await mkdir(join(dir, "trash"), { recursive: true });
    await writeFile(source, "the version that was copied\n");

    // The editor, in the gap between the copy being made durable and the
    // original being removed.
    midTrash.pause = async (at) => {
      midTrash.pause = async () => {};
      await writeFile(`${at}.editor`, "the unsent edit, written after the copy\n");
      await (await import("node:fs/promises")).rename(`${at}.editor`, at);
    };

    await expect(copyVerifiedThenRemove(source, target)).rejects.toThrow();

    const stillThere = await readFile(source, "utf8").catch(() => "");
    const inTrash = await readFile(target, "utf8").catch(() => "");
    expect(
      `${stillThere}|${inTrash}`,
      "the edit written after the copy was verified is gone",
    ).toContain("the unsent edit, written after the copy\n");
  });

  /**
   * R36. The second attempt must not destroy what the first one kept.
   *
   * A move that cannot put a displaced version back leaves it beside the note
   * and reports the move as incomplete, which is the whole of the preservation
   * here. The parking name was one fixed string, so the retry a person then
   * runs renamed the next file straight onto it: `rename` replaces, and the
   * cleanup afterwards took what was left. One attempt, tested on a pristine
   * directory, passed; the pair lost a note.
   */
  it("does not overwrite the previous attempt's preserved version", async () => {
    const dir = await scratch();
    const source = join(dir, "note.md");
    await mkdir(join(dir, "trash"), { recursive: true });
    await writeFile(source, "the version that was copied\n");

    // A save lands before the original is taken away, so what gets moved
    // aside is that save and not the version in the trash.
    midTrash.pause = async (at) => {
      midTrash.pause = async () => {};
      await writeFile(`${at}.tmp`, "save A, never sent anywhere\n");
      await renameFile(`${at}.tmp`, at);
    };
    // And another takes the name back before the walk can put A there, so A
    // stays parked and the move reports itself incomplete.
    midTrash.afterCompare = async (at) => {
      midTrash.afterCompare = async () => {};
      await writeFile(`${at}.tmp`, "save B, also never sent\n");
      await renameFile(`${at}.tmp`, at);
    };

    await expect(copyVerifiedThenRemove(source, join(dir, "trash", "note.md"))).rejects.toThrow();

    // A is parked somewhere beside the note. Found rather than assumed, so
    // this uses the real leftover and not a fixture that resembles one.
    const parked = (await readdir(dir)).find((n) => n.startsWith("note.md."));
    expect(
      parked,
      `save A was not kept. The directory holds: ${JSON.stringify(await readdir(dir))}`,
    ).toBeDefined();
    expect(await readFile(join(dir, parked!), "utf8")).toBe("save A, never sent anywhere\n");

    // The retry, which is what somebody actually does next.
    await copyVerifiedThenRemove(source, join(dir, "second", "note.md"));

    expect(await readFile(join(dir, "second", "note.md"), "utf8")).toBe(
      "save B, also never sent\n",
    );
    expect(
      await readFile(join(dir, parked!), "utf8").catch(() => undefined),
      "the retry wrote over the version the first attempt had kept",
    ).toBe("save A, never sent anywhere\n");
  });

  it("keeps a changed file inside a folder and removes the rest", async () => {
    const dir = await scratch();
    const source = join(dir, "folder");
    const target = join(dir, "trash", "folder");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "quiet.md"), "unchanged\n");
    await writeFile(join(source, "busy.md"), "before the copy\n");
    await mkdir(join(dir, "trash"), { recursive: true });

    midTrash.pause = async () => {
      midTrash.pause = async () => {};
      await writeFile(join(source, "busy.md.editor"), "edited while copying\n");
      await (
        await import("node:fs/promises")
      ).rename(join(source, "busy.md.editor"), join(source, "busy.md"));
    };

    await expect(copyVerifiedThenRemove(source, target)).rejects.toThrow();

    // The edited one is still there, under its own name; the untouched one is
    // gone, because its copy did match.
    expect(await readFile(join(source, "busy.md"), "utf8")).toBe("edited while copying\n");
    expect(await readdir(source)).toEqual(["busy.md"]);
  });

  /**
   * The window the previous attempt left, and the reason this hook is where it
   * is (R22).
   *
   * The old code hashed the source, compared it with the copy, and then
   * unlinked the source's *path*. An editor saving between those two took the
   * place of the file that had just been approved, and the unlink deleted it.
   * Shrinking the window from a whole-tree flush to one hash is not closing it.
   *
   * The hook fires after the comparison, which is exactly where the earlier
   * tests did not look.
   */
  it("does not delete a version saved after the final comparison", async () => {
    const dir = await scratch();
    const source = join(dir, "note.md");
    const target = join(dir, "trash", "note.md");
    await mkdir(join(dir, "trash"), { recursive: true });
    await writeFile(source, "the version that was copied\n");

    midTrash.afterCompare = async (at) => {
      midTrash.afterCompare = async () => {};
      await writeFile(`${at}.editor`, "saved after the check\n");
      await (await import("node:fs/promises")).rename(`${at}.editor`, at);
    };

    await copyVerifiedThenRemove(source, target).catch(() => undefined);

    const stillThere = await readFile(source, "utf8").catch(() => "");
    const inTrash = await readFile(target, "utf8").catch(() => "");
    expect(
      `${stillThere}|${inTrash}`,
      "the version saved after the copy was approved is gone",
    ).toContain("saved after the check\n");
  });
});
