/**
 * Putting a filename into its normal form cannot delete a file somebody just
 * saved (R07).
 *
 * A Mac writes `café.md` with a combining acute; every other device writes the
 * composed form. On a filesystem that keeps them apart those are two names for
 * ever, so the scan re-spells the disk to match the wire. That is a write on a
 * read path, and it was destructive: it reserved the new name with `link` and
 * then removed the old one with `rm`, and `rm` removes whatever is at the name
 * at that moment. An editor replacing the file in between, which is what an
 * atomic save is, had its new version deleted and the normalised name left
 * pointing at the old inode.
 *
 * The re-spelling is worth keeping: without it a note written on a Mac and one
 * written anywhere else are two different files on ext4, which is the exact
 * divergence normalising was added to end. So the old name is moved aside
 * rather than deleted, and what came out is looked at.
 */

import {
  link as hardLink,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeVault, STALE_TEMP_MS, midRespell, retireName } from "./vault.ts";

const dirs: string[] = [];
afterEach(async () => {
  midRespell.pause = async () => {};
  midRespell.beforeGivingBack = async () => {};
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function vault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trew-respell-"));
  dirs.push(dir);
  return dir;
}

/** Everything readable under these directories, for asserting nothing was lost. */
async function contentsUnder(...where: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of where) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith(".")) continue;
      const text = await readFile(join(dir, name), "utf8").catch(() => undefined);
      if (text !== undefined) out.push(text);
    }
  }
  return out;
}

/**
 * The rule itself, driven directly.
 *
 * Through `list` this is reachable only on a filesystem that keeps two Unicode
 * spellings apart, and macOS does not, so the integration tests below skip
 * there. A rule about not losing notes that runs on one platform runs nowhere,
 * so these use two ordinary distinct names and nothing about Unicode: the
 * shape is "this file now has a second name, take the first one away", which
 * is the same shape whatever produced it.
 */
describe("taking away a name whose file has a second one", () => {
  it("does not delete a file saved at that name in the meantime", async () => {
    const dir = await vault();
    const from = join(dir, "old-name.md");
    const to = join(dir, "new-name.md");
    const staging = join(dir, ".trew", "tmp");
    await writeFile(from, "the synced contents\n");
    const source = await lstat(from);
    await hardLink(from, to);

    midRespell.pause = async (at) => {
      midRespell.pause = async () => {};
      // The editor, saving through a temporary file: `from` now names a
      // different inode holding work nothing has sent anywhere.
      await writeFile(`${at}.editor`, "the unsent edit\n");
      await rename(`${at}.editor`, at);
    };

    await retireName(staging, from, { dev: source.dev, ino: source.ino });

    const found = await contentsUnder(dir, staging);
    expect(
      found.join("|"),
      `the edit saved during the scan is gone. Found: ${JSON.stringify(found)}`,
    ).toContain("the unsent edit\n");
    // And the synced version is still at its new name.
    expect(await readFile(to, "utf8")).toBe("the synced contents\n");
  });

  it("removes the old name when nothing touched it", async () => {
    const dir = await vault();
    const from = join(dir, "old-name.md");
    const to = join(dir, "new-name.md");
    const staging = join(dir, ".trew", "tmp");
    await writeFile(from, "the only copy\n");
    const source = await lstat(from);
    await hardLink(from, to);

    await retireName(staging, from, { dev: source.dev, ino: source.ino });

    const after = (await readdir(dir)).filter((n) => !n.startsWith("."));
    expect(after, "the old spelling is still on the disk").toEqual(["new-name.md"]);
    expect(await readFile(to, "utf8")).toBe("the only copy\n");
    expect(
      (await readdir(staging).catch(() => [])).length,
      "the retired name was left behind in staging",
    ).toBe(0);
  });

  /**
   * Two saves and one name, which is where the first R21 fix stopped short.
   *
   * The file that came out of the rename is not ours and cannot go back,
   * because a third version now holds the name. It used to be left in staging
   * and called done. Staging is what the scan's reaper empties, it empties by
   * age, and a rename carries the file's own timestamp: the preserved version
   * was older than the cutoff the moment it landed. So a note somebody typed
   * was deleted an hour later as write debris, and nothing said so.
   */
  it("puts a version it cannot give back beside the note, where no sweep takes it", async () => {
    const dir = await vault();
    const from = join(dir, "old-name.md");
    const to = join(dir, "new-name.md");
    const staging = join(dir, ".trew", "tmp");
    await writeFile(from, "the synced contents\n");
    const source = await lstat(from);
    await hardLink(from, to);

    // One editor saves over the name before the scan moves it aside...
    midRespell.pause = async (at) => {
      midRespell.pause = async () => {};
      await writeFile(`${at}.editor`, "the unsent edit\n");
      await rename(`${at}.editor`, at);
    };
    // ...and another takes the name in the instant it is free, so the first
    // one cannot be put back. This is the window, and the hook sits in it.
    midRespell.beforeGivingBack = async (at) => {
      midRespell.beforeGivingBack = async () => {};
      await writeFile(`${at}.second`, "and a second unsent edit\n");
      await rename(`${at}.second`, at);
    };

    await retireName(staging, from, { dev: source.dev, ino: source.ino });

    // Beside the note, under a name somebody will see.
    const beside = (await readdir(dir)).filter((n) => !n.startsWith("."));
    expect(
      beside.find((n) => n.includes("(kept")),
      `nothing was kept beside the note. Found: ${JSON.stringify(beside)}`,
    ).toBeDefined();

    // And an ordinary scan, an hour later, leaves it alone. Staging would not
    // have: the reaper deletes by age and the file arrived older than the
    // cutoff.
    const kept = join(
      dir,
      beside.find((n) => n.includes("(kept"))!,
    );
    const long = (Date.now() - STALE_TEMP_MS - 60_000) / 1000;
    await utimes(kept, long, long);
    await new NodeVault(dir).list();
    expect(await readFile(kept, "utf8"), "a preserved version was swept away as write debris").toBe(
      "the unsent edit\n",
    );
  });

  it("does nothing when the old name has already gone", async () => {
    const dir = await vault();
    const staging = join(dir, ".trew", "tmp");
    await expect(
      retireName(staging, join(dir, "never-existed.md"), { dev: 1, ino: 1 }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Whether this filesystem keeps two Unicode spellings apart, asked rather than
 * assumed. macOS folds them; ext4 does not.
 */
async function twoSpellingsAreTwoFiles(dir: string): Promise<boolean> {
  const decomposed = join(dir, "probe-cafe\u0301.tmp");
  const composed = join(dir, "probe-caf\u00e9.tmp");
  await writeFile(decomposed, "a");
  try {
    // Asked by resolving the other spelling, not by listing. APFS hands back
    // whichever bytes were written, so a listing shows the decomposed name and
    // says nothing about whether the composed one reaches the same file; a
    // stat does.
    return (await lstat(composed).catch(() => undefined)) === undefined;
  } finally {
    await rm(decomposed, { force: true });
    await rm(composed, { force: true });
  }
}

const NFD = "café.md";
const NFC = "café.md";

describe("the whole scan, on a filesystem that keeps the spellings apart", () => {
  it("re-spells a name nobody touched, leaving one file", async () => {
    const dir = await vault();
    if (!(await twoSpellingsAreTwoFiles(dir))) return;
    await writeFile(join(dir, NFD), "just the one\n");

    await new NodeVault(dir).list();

    const after = (await readdir(dir)).filter((n) => !n.startsWith("."));
    expect(after, "the disk kept a spelling no other device produces").toEqual([NFC]);
    expect(await readFile(join(dir, NFC), "utf8")).toBe("just the one\n");
  });

  it("keeps a save that lands during the re-spelling", async () => {
    const dir = await vault();
    if (!(await twoSpellingsAreTwoFiles(dir))) return;
    await writeFile(join(dir, NFD), "the old contents\n");

    midRespell.pause = async (at) => {
      midRespell.pause = async () => {};
      await writeFile(`${at}.editor`, "the unsent edit\n");
      await rename(`${at}.editor`, at);
    };

    await new NodeVault(dir).list();

    const found = await contentsUnder(dir, join(dir, ".trew", "tmp"));
    expect(
      found.join("|"),
      `the edit saved during the scan is gone. Found: ${JSON.stringify(found)}`,
    ).toContain("the unsent edit\n");
  });

  it("leaves a real collision alone rather than resolving it", async () => {
    const dir = await vault();
    if (!(await twoSpellingsAreTwoFiles(dir))) return;
    await writeFile(join(dir, NFD), "the decomposed one\n");
    await writeFile(join(dir, NFC), "the composed one\n");

    await new NodeVault(dir).list();

    // Both are still here: only a person can say which note to keep, and the
    // alias machinery reports them.
    const after = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
    expect(after).toEqual([NFD, NFC].sort());
  });
});
