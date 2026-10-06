/**
 * A file that vanishes between the readdir and its stat.
 *
 * `list` reads a directory and then stats every file in it, and somebody saving
 * in an editor, or a build tool cleaning up, can remove one in between. That is
 * an absent file, not an unreadable listing, and treating it as the second
 * failed the whole pass for an ordinary thing happening at an ordinary moment.
 *
 * Its own file because the race is produced by intercepting `stat`, and a mock
 * of a module is for the file that declares it.
 */

import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { PathLike, StatOptions } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeVault } from "./vault.ts";
import { removeTree } from "../core/test-server.ts";
import { generateDeviceId, generateDeviceToken } from "../core/pairing.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    access: vi.fn(actual.access),
    readdir: vi.fn(actual.readdir),
    cp: vi.fn(actual.cp),
    // F13 watches the order of flushes against the removal of the source.
    rm: vi.fn(actual.rm),
    // And R08 removes directories with rmdir, because `rm` will not take one
    // without `recursive` and that would remove children this deliberately
    // keeps.
    rmdir: vi.fn(actual.rmdir),
    // F25 injects the EXDEV a mounted subdirectory produces.
    link: vi.fn(actual.link),
    // And R37 makes the device numbers say so, which is what a separate mount
    // actually is and what `replace` now asks before it moves anything.
    lstat: vi.fn(actual.lstat),
  };
});

import { access, cp, link, lstat, open, readdir, rename, stat, utimes } from "node:fs/promises";
import { JsonIndexStore, TEMP_MARK, copyVerifiedThenRemove, writeDurably } from "./vault.ts";
import { loadConfig, saveConfig } from "./config.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trew-race-"));
});
afterEach(async () => {
  for (const fn of [stat, open, rename, access, readdir, cp, link, lstat]) {
    const m = vi.mocked(fn as unknown as (...a: unknown[]) => unknown);
    m.mockRestore?.();
  }
  await removeTree(root);
});

/** An error with the code a filesystem would give. */
function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: injected`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Makes one fs call fail with `code` for paths matching `when`, once each. */
function failWith(fn: unknown, code: string, when: (path: string) => boolean): void {
  const m = vi.mocked(fn as (...a: unknown[]) => Promise<unknown>);
  const real = m.getMockImplementation()!;
  const done = new Set<string>();
  m.mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]);
    if (when(path) && !done.has(path)) {
      done.add(path);
      throw errno(code);
    }
    return real(...args);
  });
}

/** Makes every handle `open` returns write at most `most` bytes per call. */
function shortWrites(most: number): void {
  const real = vi.mocked(open).getMockImplementation()!;
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await real(...args);
    const write = handle.write.bind(handle);
    (handle as { write: unknown }).write = (data: Uint8Array) =>
      write(data.subarray(0, Math.min(most, data.length)));
    return handle;
  });
}

const enc = new TextEncoder();
const temps = async (dir: string) => (await readdir(dir)).filter((n) => n.includes(".trew-tmp-"));
/** The state folder's entries, with the staging folder counted only if it holds anything. */
async function stateDir(): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(join(root, ".trew"))) {
    if (name === "tmp" && (await readdir(join(root, ".trew", "tmp"))).length === 0) continue;
    out.push(name);
  }
  return out.sort();
}

describe("listing while something else is deleting", () => {
  it("reports a file deleted between readdir and stat as absent, and the rest as present", async () => {
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "keep.md"), "kept");
    await writeFile(join(root, "notes", "gone.md"), "about to go");
    await writeFile(join(root, "top.md"), "top");

    const real = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementation(async (path, ...rest) => {
      // The deletion lands after the readdir named the file and before its
      // stat, which is the only window this race has.
      if (String(path).endsWith("gone.md")) await rm(path);
      return real(path, ...rest);
    });

    const listed = (await new NodeVault(root).list()).map((f) => f.path).sort();
    expect(listed).toEqual(["notes", "notes/keep.md", "top.md"]);
  });

  it("still stops for a stat that fails for any other reason", async () => {
    await writeFile(join(root, "top.md"), "top");
    vi.mocked(stat).mockImplementation(async () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    // Rule 2: unreadable is not absent, and an unreadable file must not turn
    // into a listing that omits it and calls the rest the vault.
    await expect(new NodeVault(root).list()).rejects.toThrow(/EACCES/);
  });
});

/**
 * `FileHandle.write` says how much it wrote and may say less
 * than it was given; the count was ignored, so a short write was fsynced and
 * renamed into place as a complete note, or a complete index.
 */
describe("a write the filesystem cuts short", () => {
  it("is finished rather than renamed into place short, for a note", async () => {
    shortWrites(7);
    const body = enc.encode("x".repeat(1000));
    await writeDurably(join(root, "note.md"), body);
    expect(await readFile(join(root, "note.md"))).toEqual(Buffer.from(body));
    expect(await temps(root)).toEqual([]);
  });

  it("is finished for the index too", async () => {
    shortWrites(11);
    const store = new JsonIndexStore(join(root, ".trew", "index.json"));
    const state = { cursor: 7, entries: { "a.md": { size: 1 } }, remote: {}, pending: ["b.md"] };
    await store.save(state);
    expect(await new JsonIndexStore(join(root, ".trew", "index.json")).load()).toEqual(state);
  });

  it("refuses a write that makes no progress, and leaves no temporary", async () => {
    shortWrites(0);
    await expect(writeDurably(join(root, "note.md"), enc.encode("abc"))).rejects.toThrow(
      /not progressing/,
    );
    await expect(readFile(join(root, "note.md"))).rejects.toThrow();
    expect(await temps(root)).toEqual([]);
  });
});

/**
 * The config is the only copy of this device's token, and a pairing writes it
 * before the redemption that registers the token goes out. It goes through
 * the same durable path as a note, and a failure at any step leaves either the
 * previous config or none, never a temporary and never a partial file.
 */
describe("the config on disk", () => {
  const config = () => ({
    url: "ws://127.0.0.1:1",
    vaultId: "default",
    device: "d",
    deviceId: generateDeviceId(),
    deviceToken: generateDeviceToken(),
  });

  it("is owner-readable only, complete, and alone in its directory", async () => {
    const c = config();
    await saveConfig(root, c);
    const file = join(root, ".trew", "config.json");
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    expect((await loadConfig(root))!.deviceToken).toBe(c.deviceToken);
    expect(await stateDir()).toEqual(["config.json"]);
  });

  it("leaves the previous config when the rename fails, and no temporary", async () => {
    const first = config();
    await saveConfig(root, first);
    vi.mocked(rename).mockImplementationOnce(async () => {
      const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });
    await expect(saveConfig(root, config())).rejects.toThrow(/EIO/);
    expect((await loadConfig(root))!.deviceToken).toBe(first.deviceToken);
    // Nothing beside the config: no temporary under any name.
    expect(await stateDir()).toEqual(["config.json"]);
  });

  it("is written whole even when the filesystem writes short", async () => {
    shortWrites(5);
    const c = config();
    await saveConfig(root, c);
    expect((await loadConfig(root))!.deviceToken).toBe(c.deviceToken);
  });
});

/**
 * Several helpers turned every filesystem error into "absent"
 * or "not the same". A `remove` that could not look at the file reported it
 * gone, a trash name that could not be looked at was taken for free, and a
 * write whose spelling check failed went ahead under an unverified name.
 */
describe("a filesystem that answers with an error rather than an answer", () => {
  it("does not call a file gone because it could not look at it", async () => {
    await writeFile(join(root, "note.md"), "still here");
    const v = new NodeVault(root);
    failWith(access, "EACCES", (p) => p.endsWith("note.md"));
    await expect(v.remove("note.md")).rejects.toThrow(/EACCES/);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("still here");
  });

  it("does not take a trash name it could not look at for a free one", async () => {
    await writeFile(join(root, "note.md"), "mine");
    await mkdir(join(root, ".trash"));
    await writeFile(join(root, ".trash", "note.md"), "somebody's earlier deletion");
    const v = new NodeVault(root);
    failWith(access, "EACCES", (p) => p.endsWith(join(".trash", "note.md")));
    await expect(v.remove("note.md")).rejects.toThrow(/EACCES/);
    expect(await readFile(join(root, ".trash", "note.md"), "utf8")).toBe(
      "somebody's earlier deletion",
    );
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("mine");
  });

  it("does not answer 'absent' or 'different file' to a question it could not ask", async () => {
    await writeFile(join(root, "a.md"), "a");
    const v = new NodeVault(root);
    failWith(access, "EIO", (p) => p.endsWith("a.md"));
    await expect(v.exists("a.md")).rejects.toThrow(/EIO/);
    failWith(stat, "EIO", (p) => p.endsWith("a.md"));
    await expect(v.sameFile("a.md", "b.md")).rejects.toThrow(/EIO/);
    // Absent is still absent.
    expect(await v.exists("nothing.md")).toBe(false);
    expect(await v.sameFile("nothing.md", "a.md")).toBe(false);
  });

  /**
   * T19. `stat` is what the engine asks before it decides a note it could not
   * read is gone, and it answered every error with "absent". A folder that
   * lost its search permission between the scan and the read therefore made
   * an unsent edit read as a deletion, which went to the server and from there
   * to the trash of every other device.
   */
  it("does not call a note absent because its stat failed (T19)", async () => {
    await mkdir(join(root, "Projects"));
    await writeFile(join(root, "Projects", "plan.md"), "the plan, edited here");
    const v = new NodeVault(root);
    for (const code of ["EACCES", "EIO"]) {
      failWith(lstat, code, (p) => p.endsWith(join("Projects", "plan.md")));
      await expect(v.stat("Projects/plan.md"), code).rejects.toThrow(new RegExp(code));
    }
    // Absent is still absent, and so is a path whose folder is a file.
    expect(await v.stat("Projects/nothing.md")).toBeUndefined();
    await writeFile(join(root, "flat"), "a file, not a folder");
    expect(await v.stat("flat/plan.md")).toBeUndefined();
    expect(await readFile(join(root, "Projects", "plan.md"), "utf8")).toBe("the plan, edited here");
  });

  it("does not write under an unverified spelling when the directory cannot be listed", async () => {
    await writeFile(join(root, "Note.md"), "old spelling");
    const v = new NodeVault(root);
    failWith(readdir, "EACCES", (p) => p === root);
    await expect(v.write("Note.md", enc.encode("new"), { mtime: 1, ctime: 1 })).rejects.toThrow(
      /EACCES/,
    );
    expect(await readFile(join(root, "Note.md"), "utf8")).toBe("old spelling");
  });
});

/**
 * The directory syncs that make the index safe to save were
 * forgotten on failure, and only a plain write registered its directory.
 */
describe("what a flush remembers", () => {
  /** Directories whose handles were synced, from the mocked `open`. */
  function watchSyncs(failFor?: (path: string) => boolean): string[] {
    const synced: string[] = [];
    const real = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await real(...args);
      const path = String(args[0]);
      if ((await handle.stat()).isDirectory()) {
        const sync = handle.sync.bind(handle);
        (handle as { sync: unknown }).sync = async () => {
          if (failFor?.(path)) throw errno("EIO");
          synced.push(path);
          return sync();
        };
      }
      return handle;
    });
    return synced;
  }

  it("keeps a directory whose sync failed for the next flush", async () => {
    const v = new NodeVault(root);
    await v.write("notes/a.md", enc.encode("a"), { mtime: 1, ctime: 1 });
    let failing = true;
    const synced = watchSyncs((p) => failing && p === join(root, "notes"));
    await expect(v.flush()).rejects.toThrow(/EIO/);
    expect(synced).not.toContain(join(root, "notes"));
    failing = false;
    // Nothing new was written, and the flush still owes the sync.
    await v.flush();
    expect(synced).toContain(join(root, "notes"));
  });

  it("syncs the directories a folder, a trash move and a case rename changed", async () => {
    const v = new NodeVault(root);
    await v.write("Note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await v.flush();
    const synced = watchSyncs();

    await v.mkdir("deep/er/folder");
    await v.write("NOTE.md", enc.encode("y"), { mtime: 2, ctime: 2 }); // case rename in place
    await v.remove("NOTE.md"); // into .trash, which did not exist
    await v.flush();

    for (const dir of [root, join(root, "deep"), join(root, "deep", "er"), join(root, ".trash")]) {
      expect(synced, `${dir} was not synced`).toContain(dir);
    }
  });
});

/**
 * The move across filesystems copied and then removed, and
 * trusted the copy. Rule 3 says copy, compare, then delete.
 */
describe("moving a note across filesystems", () => {
  it("removes the original only once the copy proves identical", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.md"), "alpha");
    await writeFile(join(root, "src", "b.md"), "beta");
    await copyVerifiedThenRemove(join(root, "src"), join(root, "dst"));
    await expect(stat(join(root, "src"))).rejects.toThrow();
    expect(await readFile(join(root, "dst", "b.md"), "utf8")).toBe("beta");
  });

  const faults: [string, (src: string, dst: string) => Promise<void>][] = [
    ["a short copy", async (_s, dst) => writeFile(join(dst, "a.md"), "alph")],
    ["a missing descendant", async (_s, dst) => rm(join(dst, "b.md"))],
    ["a source changed while copying", async (src) => writeFile(join(src, "a.md"), "altered")],
  ];
  for (const [what, sabotage] of faults) {
    it(`keeps the original and removes the copy after ${what}`, async () => {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "a.md"), "alpha");
      await writeFile(join(root, "src", "b.md"), "beta");
      const real = vi.mocked(cp).getMockImplementation()!;
      vi.mocked(cp).mockImplementationOnce(async (...args: Parameters<typeof cp>) => {
        await real(...args);
        await sabotage(String(args[0]), String(args[1]));
      });
      await expect(copyVerifiedThenRemove(join(root, "src"), join(root, "dst"))).rejects.toThrow(
        /does not match/,
      );
      expect((await readdir(join(root, "src"))).sort()).toEqual(["a.md", "b.md"]);
      await expect(stat(join(root, "dst"))).rejects.toThrow();
    });
  }

  /**
   * F13. The copy has to be durable before the original goes.
   *
   * Reading the copy back proves the bytes reached the page cache and no more,
   * so a power cut after the removal could leave the source deleted and the
   * copy short or absent. Rule 3 says nothing is destroyed until a verified
   * copy exists elsewhere, and a copy that is only in memory is not elsewhere
   * yet.
   *
   * Counted rather than power-cut: what is checked is that every copied file
   * and the directories holding them were flushed, and that they were flushed
   * before the source was removed.
   */
  it("flushes every copied file and directory before removing the source", async () => {
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "a.md"), "alpha");
    await writeFile(join(root, "src", "deep", "b.md"), "beta");

    const order: string[] = [];
    const realOpen = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await realOpen(...args);
      const path = String(args[0]);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (path.includes("dst")) order.push(`sync ${path.slice(root.length + 1)}`);
        return realSync();
      };
      return handle;
    });
    // Both, because the source tree comes away file by file now (R08): the
    // files go through `rm` and the directories through `rmdir`. What the
    // ordering has to show is unchanged: nothing under the source is taken
    // away until every copied file and directory has been flushed.
    const realRm = vi.mocked(rm).getMockImplementation()!;
    vi.mocked(rm).mockImplementation(async (...args: Parameters<typeof rm>) => {
      const path = String(args[0]);
      if (path.includes("/src")) order.push("remove the source");
      return realRm(...args);
    });
    const realRmdir = vi.mocked(rmdir).getMockImplementation()!;
    vi.mocked(rmdir).mockImplementation(async (...args: Parameters<typeof rmdir>) => {
      const path = String(args[0]);
      if (path.includes("/src")) order.push("remove the source");
      return realRmdir(...args);
    });

    await copyVerifiedThenRemove(join(root, "src"), join(root, "dst"));

    const removedAt = order.indexOf("remove the source");
    expect(removedAt, `the source was never removed: ${order.join(", ")}`).toBeGreaterThan(-1);
    const flushed = order.slice(0, removedAt);
    for (const wanted of ["dst/a.md", "dst/deep/b.md", "dst/deep", "dst"]) {
      expect(
        flushed,
        `${wanted} was not made durable before the original was removed: ${order.join(", ")}`,
      ).toContain(`sync ${wanted}`);
    }
    await expect(stat(join(root, "src"))).rejects.toThrow();
  });

  it("refuses a destination something else took first", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.md"), "alpha");
    await mkdir(join(root, "dst"));
    await writeFile(join(root, "dst", "a.md"), "theirs");
    await expect(copyVerifiedThenRemove(join(root, "src"), join(root, "dst"))).rejects.toThrow();
    expect(await readFile(join(root, "src", "a.md"), "utf8")).toBe("alpha");
    expect(await readFile(join(root, "dst", "a.md"), "utf8")).toBe("theirs");
  });
});

/**
 * Any name containing the temp marker vanished from the
 * listing, while a crash's own temporaries stayed beside notes for ever.
 */
describe("temporary files, ours and not", () => {
  it("lists a note whose name merely contains the marker", async () => {
    await writeFile(join(root, `notes${TEMP_MARK}1.md`), "a real note");
    const listed = (await new NodeVault(root).list()).map((f) => f.path);
    expect(listed).toContain(`notes${TEMP_MARK}1.md`);
  });

  it("stages its temporaries under the state folder and leaves none behind", async () => {
    const v = new NodeVault(root);
    await v.write("deep/note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    expect((await readdir(join(root, "deep"))).filter((n) => n.includes(TEMP_MARK))).toEqual([]);
    expect(await readdir(join(root, ".trew", "tmp"))).toEqual([]);
  });

  it("reaps a stale temporary a crash left, and keeps a fresh one", async () => {
    const staging = join(root, ".trew", "tmp");
    await mkdir(staging, { recursive: true });
    const stale = join(staging, `old.md${TEMP_MARK}zz`);
    const fresh = join(staging, `new.md${TEMP_MARK}yy`);
    await writeFile(stale, "half a note");
    await writeFile(fresh, "being written by another process, maybe");
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    const v = new NodeVault(root);
    await v.list();
    expect(v.reaped).toBe(1);
    expect(await readdir(staging)).toEqual([`new.md${TEMP_MARK}yy`]);
  });
});

/**
 * F25. A restore into a mounted subdirectory has to land.
 *
 * `create` stages under the vault's own `.trew/tmp` and hard-links the
 * result into place, which is what makes it exclusive: a link creates the
 * name or fails, so it cannot replace a note that appeared since. Its
 * fallback covered the filesystems that have no hard links and not the case
 * where the two paths are on different mounts, which is a different error for
 * a reason that has nothing to do with link support. Restores and conflict
 * copies into such a directory failed outright.
 */
describe("creating a file across a mount boundary", () => {
  it("still lands, and still refuses to replace what is already there", async () => {
    const vault = new NodeVault(root);
    // What a staging directory on one mount and a destination on another
    // produces, and nothing else here can.
    vi.mocked(link).mockImplementation(async () => {
      const err = new Error("EXDEV: cross-device link") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    });

    const times = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };
    const made = await vault.create("restored.md", enc.encode("brought back"), times);
    expect(made, "a restore into a mounted subdirectory was refused").toBe(true);
    expect(await readFile(join(root, "restored.md"), "utf8")).toBe("brought back");

    // And the no-overwrite promise survives the fallback: the second attempt
    // finds the name taken and says so rather than replacing it.
    const again = await vault.create("restored.md", enc.encode("a second copy"), times);
    expect(again, "the fallback replaced a file that was already there").toBe(false);
    expect(await readFile(join(root, "restored.md"), "utf8")).toBe("brought back");
  });
});

/**
 * R37. Replacing an existing note under a mounted subdirectory.
 *
 * The preserving write stages the incoming version under the vault's own
 * `.trew/tmp` and hard-links it into the note's directory, and a link cannot
 * cross a filesystem. On a vault assembled out of several mounts that link
 * failed *after* the original had been moved aside: the note's own name was
 * empty, its bytes were at a conflict path, and the incoming version had
 * nowhere to go. Every byte survived and the vault was still wrong.
 *
 * Which filesystem the staging is on is now asked before anything moves.
 */
describe("replacing a note across a mount boundary", () => {
  /** Makes everything under `.trew/tmp` report a device of its own. */
  function stagingOnAnotherMount(): void {
    const staging = `${sep}.trew${sep}tmp`;
    const realStat = vi.mocked(lstat).getMockImplementation()!;
    vi.mocked(lstat).mockImplementation((async (path: PathLike, opts?: StatOptions) => {
      const info = (await realStat(path, opts)) as unknown as { dev: number };
      return String(path).includes(staging) ? { ...info, dev: info.dev + 1 } : info;
    }) as typeof lstat);
    // And a link out of it fails the way the kernel would, so a fix that only
    // reordered the stats and still linked from staging is caught here.
    const realLink = vi.mocked(link).getMockImplementation()!;
    vi.mocked(link).mockImplementation(async (from: PathLike, to: PathLike) => {
      if (String(from).includes(staging)) throw errno("EXDEV");
      return realLink(from, to);
    });
  }

  it("lands the incoming version and keeps the one it displaced", async () => {
    const vault = new NodeVault(root);
    await writeFile(join(root, "note.md"), "the unsent edit\n");
    stagingOnAnotherMount();

    const out = await vault.replace(
      "note.md",
      { contentId: "a digest of something else", idOf: async () => "not that" },
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );

    expect(out.landed, "the replacement never reached the note's own name").toBe(true);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("the server's version\n");
    expect(out.keptAt).toBe("note (kept).md");
    expect(await readFile(join(root, "note (kept).md"), "utf8")).toBe("the unsent edit\n");
  });

  it("creates a note it has never seen there too", async () => {
    const vault = new NodeVault(root);
    stagingOnAnotherMount();

    const out = await vault.replace(
      "fresh.md",
      undefined,
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "fresh (kept).md",
    );

    expect(out).toEqual({ landed: true });
    expect(await readFile(join(root, "fresh.md"), "utf8")).toBe("the server's version\n");
  });

  /**
   * And when publication fails for a reason of its own, the note goes back
   * under its own name. A failure should leave the vault as it was, not a note
   * renamed to a conflict copy for a reason that has nothing to do with a
   * conflict.
   */
  it("puts the original back when the write cannot be published at all", async () => {
    const vault = new NodeVault(root);
    await writeFile(join(root, "note.md"), "the unsent edit\n");
    // Publication fails; putting the original back does not. Only the link
    // out of a temporary is refused, which is the failure being modelled.
    // Only the publication link, whose source is the staged copy. The
    // put-back and the preservation claim link from the parked original, and
    // failing those would be modelling a different failure.
    const realLink = vi.mocked(link).getMockImplementation()!;
    vi.mocked(link).mockImplementation(async (from: PathLike, to: PathLike) => {
      const source = String(from);
      if (source.includes("replace.") || source.includes(`${TEMP_MARK}near`)) {
        throw errno("EIO");
      }
      return realLink(from, to);
    });

    await expect(
      vault.replace(
        "note.md",
        { contentId: "a digest of something else", idOf: async () => "not that" },
        enc.encode("the server's version\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow();

    expect(
      await readFile(join(root, "note.md"), "utf8"),
      "a failed write left the note under a conflict name",
    ).toBe("the unsent edit\n");
    expect((await readdir(root)).filter((n) => !n.startsWith("."))).toEqual(["note.md"]);
  });

  /**
   * And when it cannot even be put back, the error says where it is. Bytes
   * that survive somewhere nobody is told about are bytes nobody finds.
   */
  it("names the path it left the original at when it cannot put it back", async () => {
    const vault = new NodeVault(root);
    await writeFile(join(root, "note.md"), "the unsent edit\n");
    vi.mocked(link).mockImplementation(async () => {
      throw errno("EIO");
    });

    let named: string | undefined;
    try {
      await vault.replace(
        "note.md",
        { contentId: "a digest of something else", idOf: async () => "not that" },
        enc.encode("the server's version\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      );
    } catch (err) {
      named = /it is at (.+)$/.exec((err as Error).message)?.[1];
    }

    // Wherever it ended up, the error says so and the bytes are there. Which
    // path that is depends on how far the recovery got, and the claim being
    // made is that it is never nowhere.
    expect(named, "the error did not say where the note is").toBeDefined();
    expect(await readFile(join(root, named!), "utf8")).toBe("the unsent edit\n");
  });
});

/**
 * The two halves `docs/design.md` claims for both clients, on the real one.
 *
 * A pass decides from a scan and writes seconds later, and nothing locks the
 * editor out. What is claimed instead is that nothing is destroyed on the
 * strength of the decision: the bytes are moved aside first, and the incoming
 * version is published to a name that must be free.
 *
 * The plugin's half of each is in plugin/vault.test.ts. This is the headless
 * client's, because the memory vault can only be *told* that the name was
 * taken and the claim is about what `link` and `rename` actually do.
 */
describe("publishing over somebody who took the name first", () => {
  it("leaves the name to them and hands back the version it displaced", async () => {
    const vault = new NodeVault(root);
    await writeFile(join(root, "note.md"), "the unsent edit\n");

    // A file appears in the instant between the move aside and the link. The
    // hook is the move itself, which is the only call that happens there.
    const realRename = vi.mocked(rename).getMockImplementation()!;
    vi.mocked(rename).mockImplementation(async (from: PathLike, to: PathLike) => {
      const out = await realRename(from, to);
      // The move aside, which now parks in a temporary of the call's own
      // before it claims a preservation path (R43).
      if (String(to).includes(`${TEMP_MARK}keep`)) {
        vi.mocked(rename).mockImplementation(realRename);
        await writeFile(join(root, "note.md"), "typed while the name was empty\n");
      }
      return out;
    });

    const out = await vault.replace(
      "note.md",
      { contentId: "a digest of something else", idOf: async () => "not that" },
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );

    expect(
      await readFile(join(root, "note.md"), "utf8"),
      "the save that took the name was written over",
    ).toBe("typed while the name was empty\n");
    expect(out.landed, "a write that lost the name was reported as landed").toBe(false);
    expect(out.keptAt).toBe("note (kept).md");
    expect(await readFile(join(root, "note (kept).md"), "utf8")).toBe("the unsent edit\n");
  });

  /**
   * And a move aside that fails for a reason other than the file being gone is
   * reported as a failure.
   *
   * The note survives either way here, because publication is exclusive and
   * the name it would have to take is still occupied by the note itself. What
   * this pins is the report: reading a refused move as "there was nothing
   * there" makes a permissions or I/O fault look like an ordinary first
   * download, and the next thing the caller does with that answer is decide
   * the path is settled. The plugin, whose publication was not exclusive until
   * R32, lost the note outright on the same reasoning.
   */
  it("reports a move aside it could not make, rather than reading it as absence", async () => {
    const vault = new NodeVault(root);
    await writeFile(join(root, "note.md"), "the unsent edit\n");

    const realRename = vi.mocked(rename).getMockImplementation()!;
    vi.mocked(rename).mockImplementation(async (from: PathLike, to: PathLike) => {
      if (String(to).includes(`${TEMP_MARK}keep`)) throw errno("EACCES");
      return realRename(from, to);
    });

    await expect(
      vault.replace(
        "note.md",
        { contentId: "a digest of something else", idOf: async () => "not that" },
        enc.encode("the server's version\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow();

    expect(
      await readFile(join(root, "note.md"), "utf8"),
      "the write went ahead after the step that protects the note had failed",
    ).toBe("the unsent edit\n");
    expect((await readdir(root)).filter((n) => !n.startsWith("."))).toEqual(["note.md"]);
  });
});

/**
 * A scan's concurrency is bounded however deep the vault goes (I06).
 *
 * A stat per file was `Promise.all` per directory and the recursion was
 * another, so in-flight work multiplied with depth rather than adding up: a
 * wide deep tree meant thousands of concurrent operations, and on a network
 * filesystem or under a low descriptor limit that is an EMFILE with nothing
 * useful attached to it.
 *
 * The gate is on the stats and not on the recursion. Stats are leaves, so a
 * slot is held for one syscall; a directory holding a slot while its children
 * waited for one would deadlock as soon as the tree was deeper than the limit.
 */
describe("how much a scan does at once", () => {
  it("keeps outstanding stats under a ceiling, and still finds everything", async () => {
    // Wide and deep, which is the shape that punished the old code.
    let expected = 0;
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 6; b++) {
        await mkdir(join(root, `d${a}`, `e${b}`), { recursive: true });
        for (let f = 0; f < 8; f++) {
          await writeFile(join(root, `d${a}`, `e${b}`, `n${f}.md`), "x");
          expected++;
        }
      }
    }

    let inFlight = 0;
    let peak = 0;
    const real = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementation(async (...args: Parameters<typeof stat>) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await real(...args);
      } finally {
        inFlight--;
      }
    });

    const listed = await new NodeVault(root).list();
    expect(listed.filter((f) => !f.folder)).toHaveLength(expected);
    // The ceiling is 64 inside the vault. Asserted with room, because the
    // number is an implementation choice and the property is that there is
    // one at all: unbounded on this tree is 288 stats at once.
    expect(peak, `a scan had ${peak} stats outstanding at once`).toBeLessThanOrEqual(80);
    expect(peak, "the gate serialised the scan, which is the other failure").toBeGreaterThan(1);
  });
});
