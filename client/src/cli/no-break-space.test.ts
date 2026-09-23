/**
 * A note whose name has a no-break space in it, on a disk and in Obsidian.
 *
 * Obsidian's `normalizePath` turns U+00A0 and U+202F into an ordinary space, so
 * the plugin can only ever send `a b.md` for a file whose name on disk is
 * `a<NBSP>b.md`, and the server refuses the no-break spelling outright (PLAN.md
 * section 4.1, `nbsp` in core/path-policy.ts). The headless client used to
 * report the disk's bytes, which made it the one client that could not sync
 * such a note at all: refused on the way up, and a second file with a plain
 * space on the way down.
 *
 * So `NodeVault` keeps the plugin's mapping. The engine sees the plain space;
 * reads, writes and removals land on the file's real name; and the name on the
 * disk is never changed, because unlike NFD against NFC it is a name somebody
 * typed, and Obsidian leaves it alone as well.
 *
 * Written as escapes, because the point of these names is that they look
 * identical printed plainly.
 */

import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTree } from "../core/test-server.ts";
import { NodeVault } from "./vault.ts";

/** The name every device and the server use. */
const SPACE = "a b.md";
/** The same name as a person typed it, with a no-break space. */
const NBSP = "a\u00A0b.md";
/** And with a narrow no-break space, which Obsidian folds the same way. */
const NARROW = "a\u202Fb.md";

const times = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };
const enc = new TextEncoder();
const dec = new TextDecoder();

async function idOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Buffer.from(digest).toString("hex");
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trew-nbsp-"));
});
afterEach(async () => {
  await removeTree(root);
});

/** The vault's names as the disk spells them, without dot-prefixed state. */
async function onDisk(dir = root): Promise<string[]> {
  return (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
}

describe("a name with a no-break space, on the disk", () => {
  it("is listed with an ordinary space, and the disk keeps its own name", async () => {
    await writeFile(join(root, NBSP), "nbsp\n");
    await writeFile(join(root, "x\u202Fy.md"), "narrow\n");
    const vault = new NodeVault(root);
    expect((await vault.list()).map((f) => f.path).sort()).toEqual([SPACE, "x y.md"]);
    expect(vault.ambiguous()).toEqual([]);
    // Not re-spelled. The NFD fold renames the disk to NFC because the two
    // are one name by definition; this is a character somebody chose.
    expect(await onDisk()).toEqual([NBSP, "x\u202Fy.md"].sort());
  });

  it("reads, stats and digests the file under the name it reported", async () => {
    await writeFile(join(root, NBSP), "nbsp\n");
    const vault = new NodeVault(root);
    await vault.list();
    expect(dec.decode(await vault.read(SPACE))).toBe("nbsp\n");
    expect((await vault.stat(SPACE))?.size).toBe(5);
    expect(await vault.exists(SPACE)).toBe(true);
    expect(await vault.contentDigest(SPACE)).toBeDefined();
    const blocks: Uint8Array[] = [];
    for await (const b of vault.readBlocks(SPACE)) blocks.push(b);
    expect(dec.decode(Buffer.concat(blocks))).toBe("nbsp\n");
    expect(dec.decode(await vault.readRange(SPACE, 1, 4))).toBe("bsp");
  });

  it("writes over the file that is there rather than beside it", async () => {
    await writeFile(join(root, NBSP), "before\n");
    const vault = new NodeVault(root);
    await vault.list();
    await vault.write(SPACE, enc.encode("after\n"), times);
    expect(await onDisk(), "a second file appeared beside the note").toEqual([NBSP]);
    expect(await readFile(join(root, NBSP), "utf8")).toBe("after\n");
    expect((await vault.list()).map((f) => f.path)).toEqual([SPACE]);
  });

  it("writes over it without a listing first, as restore does", async () => {
    await writeFile(join(root, NBSP), "before\n");
    await new NodeVault(root).write(SPACE, enc.encode("after\n"), times);
    expect(await onDisk()).toEqual([NBSP]);
    expect(await readFile(join(root, NBSP), "utf8")).toBe("after\n");
  });

  it("replaces it through the preserving write, on the real name", async () => {
    await writeFile(join(root, NBSP), "before\n");
    const vault = new NodeVault(root);
    await vault.list();
    const contentId = await idOf(enc.encode("before\n"));
    const replaced = await vault.replace(
      SPACE,
      { contentId, idOf },
      enc.encode("after\n"),
      times,
      "a b (kept).md",
    );
    expect(replaced).toEqual({ landed: true });
    expect(await onDisk()).toEqual([NBSP]);
    expect(await readFile(join(root, NBSP), "utf8")).toBe("after\n");
  });

  it("keeps an unexpected version beside it when the preserving write finds one", async () => {
    await writeFile(join(root, NBSP), "somebody's edit\n");
    const vault = new NodeVault(root);
    await vault.list();
    const replaced = await vault.replace(
      SPACE,
      { contentId: "not what is there", idOf },
      enc.encode("incoming\n"),
      times,
      "a b (kept).md",
    );
    expect(replaced.keptAt).toBe("a b (kept).md");
    expect(await readFile(join(root, NBSP), "utf8")).toBe("incoming\n");
    expect(await readFile(join(root, "a b (kept).md"), "utf8")).toBe("somebody's edit\n");
    expect(await onDisk()).toEqual(["a b (kept).md", NBSP].sort());
  });

  it("takes the real file away through the preserving removal", async () => {
    await writeFile(join(root, NBSP), "doomed\n");
    const vault = new NodeVault(root);
    await vault.list();
    const contentId = await idOf(enc.encode("doomed\n"));
    const out = await vault.removeExpecting(SPACE, { contentId, idOf }, "a b (kept).md");
    expect(out.keptAt).toBeUndefined();
    expect(await onDisk()).toEqual([]);
    expect(await readdir(join(root, ".trash"))).toEqual([NBSP]);
  });

  it("does not create a second file under the plain name", async () => {
    await writeFile(join(root, NBSP), "there\n");
    const vault = new NodeVault(root);
    expect(await vault.create(SPACE, enc.encode("new\n"), times)).toBe(false);
    expect(await onDisk()).toEqual([NBSP]);
    expect(await readFile(join(root, NBSP), "utf8")).toBe("there\n");
  });

  it("removes the real file into the trash under its own name", async () => {
    await writeFile(join(root, NBSP), "doomed\n");
    const vault = new NodeVault(root);
    await vault.list();
    await vault.remove(SPACE);
    expect(await onDisk()).toEqual([]);
    expect(await readdir(join(root, ".trash"))).toEqual([NBSP]);
  });

  it("is one file to sameFile and to canonical", async () => {
    await writeFile(join(root, NBSP), "x");
    const vault = new NodeVault(root);
    await vault.list();
    expect(await vault.sameFile(SPACE, NBSP)).toBe(true);
    expect(vault.canonical(NBSP)).toBe(vault.canonical(SPACE));
    expect(vault.canonical(NARROW)).toBe(vault.canonical(SPACE));
  });

  it("maps a folder's name as well as a file's", async () => {
    await mkdir(join(root, "My\u00A0Notes"));
    await writeFile(join(root, "My\u00A0Notes", NBSP), "deep\n");
    const vault = new NodeVault(root);
    expect((await vault.list()).map((f) => f.path)).toEqual(["My Notes", `My Notes/${SPACE}`]);
    await vault.write(`My Notes/${SPACE}`, enc.encode("edited\n"), times);
    await vault.write("My Notes/new.md", enc.encode("new\n"), times);
    expect(await onDisk()).toEqual(["My\u00A0Notes"]);
    expect((await readdir(join(root, "My\u00A0Notes"))).sort()).toEqual([NBSP, "new.md"].sort());
    expect(await readFile(join(root, "My\u00A0Notes", NBSP), "utf8")).toBe("edited\n");
  });

  it("is listed the same way by a vault that only observes", async () => {
    await writeFile(join(root, NBSP), "x");
    const vault = new NodeVault(root, { observeOnly: true });
    expect((await vault.list()).map((f) => f.path)).toEqual([SPACE]);
    expect(await onDisk()).toEqual([NBSP]);
  });

  it("matches an ignored name however its spaces are spelled", async () => {
    await mkdir(join(root, "Big\u00A0Files"));
    await writeFile(join(root, "Big\u00A0Files", "x.bin"), "x");
    await writeFile(join(root, "kept.md"), "x");
    const vault = new NodeVault(root, { alsoIgnore: ["Big\u00A0Files"] });
    expect((await vault.list()).map((f) => f.path)).toEqual(["kept.md"]);
    await expect(vault.write("Big Files/y.bin", enc.encode("y"), times)).rejects.toThrow(/ignore/);
  });
});

/**
 * Both spellings on one disk, which every filesystem can hold.
 *
 * The plugin's answer, and so this one (plugin/vault.test.ts, "two names the
 * plugin cannot hold apart"): neither is listed, both are named, and neither
 * file is touched. A path that vanishes from a listing is one the engine calls
 * deleted, so the pair is reported rather than dropped, and picking one would
 * sync one note under a name the other also claims.
 */
describe("a plain space and a no-break space beside each other", () => {
  it("names the pair, lists neither, and leaves both files alone", async () => {
    await writeFile(join(root, SPACE), "space\n");
    await writeFile(join(root, NBSP), "nbsp\n");
    await writeFile(join(root, "fine.md"), "x");
    const vault = new NodeVault(root);
    expect((await vault.list()).map((f) => f.path)).toEqual(["fine.md"]);
    expect(vault.ambiguous()).toEqual([{ path: SPACE, spellings: [NBSP, SPACE].sort() }]);
    expect(await readFile(join(root, SPACE), "utf8")).toBe("space\n");
    expect(await readFile(join(root, NBSP), "utf8")).toBe("nbsp\n");
  });

  it("counts a narrow no-break space into the same group", async () => {
    await writeFile(join(root, NBSP), "nbsp\n");
    await writeFile(join(root, NARROW), "narrow\n");
    const vault = new NodeVault(root);
    expect(await vault.list()).toEqual([]);
    expect(vault.ambiguous()).toEqual([{ path: SPACE, spellings: [NBSP, NARROW].sort() }]);
  });

  /**
   * Without a listing, the directory's names are read by `absolute` alone,
   * and that read used to skip every name already in normal form. So a disk
   * holding both mapped the plain name to the no-break file, and a write to
   * `a b.md` landed on the note that is not called that.
   */
  it("does not send a write for the plain name to the other file", async () => {
    await writeFile(join(root, SPACE), "space\n");
    await writeFile(join(root, NBSP), "nbsp\n");
    await new NodeVault(root).write(SPACE, enc.encode("written\n"), times);
    expect(await readFile(join(root, NBSP), "utf8"), "the write took the other note").toBe(
      "nbsp\n",
    );
    expect(await readFile(join(root, SPACE), "utf8")).toBe("written\n");
  });

  it("stops naming the pair once one of them is renamed", async () => {
    await writeFile(join(root, SPACE), "space\n");
    await writeFile(join(root, NBSP), "nbsp\n");
    const vault = new NodeVault(root);
    await vault.list();
    expect(vault.ambiguous()).toHaveLength(1);
    await rename(join(root, NBSP), join(root, "c.md"));
    expect((await vault.list()).map((f) => f.path).sort()).toEqual([SPACE, "c.md"]);
    expect(vault.ambiguous()).toEqual([]);
  });
});
