/**
 * The Obsidian adapter, against a faithful fake of Obsidian's own interface.
 *
 * This file could not exist until `fake.ts` did, and the reason it is worth
 * having is in that file's header: the fake is declared `implements DataAdapter`
 * against the real declarations, and the one behaviour that matters is copied
 * out of the shipped application rather than assumed.
 *
 * What is still not covered: whether Obsidian calls the adapter the way this
 * expects. That needs Obsidian. Everything the plugin's own code does with it is
 * here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeAdapter, FakeVaultIndex, asVault, normalizePath } from "./fake.ts";
import { resetStub, setApiVersion } from "./stub.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";
import { plainDigest } from "../core/digest.ts";

let adapter: FakeAdapter;
let vault: ObsidianVault;

beforeEach(() => {
  adapter = new FakeAdapter();
  vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
});

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("normalizePath, as Obsidian actually ships it", () => {
  /**
   * These are not tests of this project's code. They are what was read out of
   * `obsidian.asar`, written down so that a future version changing any of it
   * is noticed here rather than in somebody's vault.
   */
  it("collapses slashes and strips the ends", () => {
    expect(normalizePath("/a/b/")).toBe("a/b");
    expect(normalizePath("a//b///c")).toBe("a/b/c");
    expect(normalizePath("a\\b")).toBe("a/b");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
  });

  /**
   * The surprising one, and the reason the adapter below normalizes on the way
   * in as well as on the way out. A non-breaking space in a filename becomes
   * an ordinary space, so the path handed over is not the path written.
   */
  it("rewrites a non-breaking space into an ordinary one", () => {
    expect(normalizePath("a b.md")).toBe("a b.md");
    expect(normalizePath("a b.md")).toBe("a b.md");
    expect(normalizePath("a b.md")).not.toBe("a b.md");
  });

  it("normalizes to NFC, which is what macOS does not hand out", () => {
    const nfd = "café.md";
    const nfc = "café.md";
    expect(nfd).not.toBe(nfc);
    expect(normalizePath(nfd)).toBe(nfc);
  });
});

describe("listing", () => {
  it("reports files and the folders above them", async () => {
    adapter.seed("top.md", "top");
    adapter.seed("notes/one.md", "one");
    adapter.seed("notes/deep/two.md", "two");

    const listed = await vault.list();
    expect(listed.map((f) => f.path).sort()).toEqual([
      "notes",
      "notes/deep",
      "notes/deep/two.md",
      "notes/one.md",
      "top.md",
    ]);
    const byPath = new Map(listed.map((f) => [f.path, f]));
    expect(byPath.get("notes")?.folder).toBe(true);
    expect(byPath.get("top.md")?.folder).toBe(false);
    expect(byPath.get("top.md")?.size).toBe(3);
  });

  it("leaves the directories that must never sync alone", async () => {
    // Obsidian's own index leaves out every dot-prefixed path, so in a real
    // vault these never reach the filter at all. The fake is told to hand
    // them over anyway: the filter is the thing under test, and one that
    // works only because its input was already clean is not tested.
    adapter.indexHidesDotfiles = false;
    // Plugin and settings sync is refused, and one device disabling every
    // plugin on another is the incident that rule came from.
    for (const dir of [".obsidian", ".trew", ".git", ".trash"]) {
      adapter.seed(`${dir}/inside.md`, "x");
    }
    adapter.seed("real.md", "x");
    expect((await vault.list()).map((f) => f.path)).toEqual(["real.md"]);
  });

  /**
   * The config folder is "typically `.obsidian` but it could be different",
   * says the API, and that folder holds this plugin's `data.json`, and that
   * file holds this device's credential. Hardcoding the usual name would mean
   * a vault with a custom one uploaded its own token.
   */
  it("leaves alone whatever Obsidian calls its config folder", async () => {
    adapter.indexHidesDotfiles = false; // As above: the filter is what is under test.
    const odd = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".my-config");
    adapter.seed(".my-config/plugins/trew/data.json", "this device's credential lives here");
    adapter.seed("real.md", "x");
    expect((await odd.list()).map((f) => f.path)).toEqual(["real.md"]);

    // And a stray `.obsidian` in a vault configured elsewhere still does not
    // sync, because nothing dot-prefixed does, whatever it is called.
    adapter.seed(".obsidian/leftover.json", "{}");
    expect((await odd.list()).map((f) => f.path)).not.toContain(".obsidian");
  });

  it("refuses a config folder that is not a plain name", async () => {
    // Anything else means the exclusion would not match what it should, and
    // a silently wrong exclusion is how the credential gets uploaded.
    for (const bad of ["", "/", "a/b"]) {
      expect(
        () => new ObsidianVault(asVault(new FakeVaultIndex(adapter)), bad),
        JSON.stringify(bad),
      ).toThrow(/plain name/);
    }
  });

  it("leaves a never-sync folder alone at any depth", async () => {
    adapter.indexHidesDotfiles = false; // As above: the filter is what is under test.
    adapter.seed("notes/.obsidian/workspace.json", "{}");
    adapter.seed("notes/real.md", "x");
    expect((await vault.list()).map((f) => f.path).sort()).toEqual(["notes", "notes/real.md"]);
  });

  /**
   * The bug this file was written to find.
   *
   * `normalizePath` rewrites a non-breaking space, so a listing that reported
   * the raw name would give the engine a path that `read` and `write` then
   * resolve to a different file. The engine would see the raw path vanish on
   * the next scan and call it a deletion, and see the normalized one appear
   * and call it a new file, forever.
   */
  it("reports paths in the form that reading and writing will use", async () => {
    adapter.seed("a b.md", "nbsp");
    adapter.seed("café.md", "nfd");
    adapter.seed("plain.md", "plain");

    const listed = await vault.list();
    // Nothing was dropped. This is the whole point: the first version of the
    // adapter returned only "plain.md", and the other two notes would never
    // have synced with nothing said about it.
    expect(listed.length).toBe(3);

    for (const file of listed) {
      expect(file.path, `${JSON.stringify(file.path)} is not in normalized form`).toBe(
        normalizePath(file.path),
      );
      // And the path it reported is one it can actually read back.
      expect(dec.decode(await vault.read(file.path)), file.path).toBeTruthy();
    }
  });

  /**
   * A path the engine got from `list` has to survive a round trip through
   * every other method, or the engine and the vault are talking about
   * different files.
   */
  it("round trips a name Obsidian would rewrite", async () => {
    adapter.seed("a b.md", "original");
    const [file] = await vault.list();
    const path = file!.path;
    expect(path).toBe("a b.md");

    expect(await vault.exists(path)).toBe(true);
    await vault.write(path, enc.encode("edited"), { mtime: 5000, ctime: 5000 });
    expect(dec.decode(await vault.read(path))).toBe("edited");

    // Written to the file that was already there, not to a second one
    // beside it under the normalized name.
    expect(adapter.filePaths()).toEqual(["a b.md"]);

    await vault.remove(path);
    expect(await vault.exists(path)).toBe(false);
  });
});

describe("reading and writing", () => {
  it("round trips bytes", async () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    await vault.write("bin/file.dat", bytes, { mtime: 1_700_000_000_000, ctime: 0 });
    expect(await vault.read("bin/file.dat")).toEqual(bytes);
  });

  it("creates the folders a path needs", async () => {
    await vault.write("a/b/c/note.md", enc.encode("deep"), { mtime: 1000, ctime: 1000 });
    expect(await vault.exists("a")).toBe(true);
    expect(await vault.exists("a/b")).toBe(true);
    expect(await vault.exists("a/b/c")).toBe(true);
    expect(dec.decode(await vault.read("a/b/c/note.md"))).toBe("deep");
  });

  /**
   * P-1d. Obsidian has its folders in memory, so a folder its index holds is
   * not asked about level by level for every file written into it.
   */
  it("asks the disk nothing about folders Obsidian's index already holds", async () => {
    adapter.seed("a/b/old.md", "already here");
    await vault.write("a/b/new.md", enc.encode("new"), { mtime: 1000, ctime: 1000 });
    expect(adapter.text("a/b/new.md")).toBe("new");
    const asked = adapter.calls.filter(
      (c) => (c.op === "exists" || c.op === "mkdir") && (c.path === "a" || c.path === "a/b"),
    );
    expect(asked).toEqual([]);
  });

  it("fails a write into a folder the index still shows and the disk has lost, and lands it later", async () => {
    // The index behind the disk: the folder went outside Obsidian and the
    // watcher has not said so. The write has nowhere to go and must say so,
    // not land somewhere else; the next pass finds the index caught up.
    adapter.seed("gone/old.md", "already here");
    await adapter.rmdir("gone", true);
    const index = new FakeVaultIndex(adapter);
    const stale = { path: "gone", name: "gone" };
    index.getAbstractFileByPath = (p: string) => (p === "gone" ? (stale as never) : null);
    const v = new ObsidianVault(asVault(index), ".obsidian");
    // A disk, unlike the fake, refuses a file in a folder that is not there.
    adapter.fault = (op, path) => {
      const cut = path.lastIndexOf("/");
      const folder = cut === -1 ? "" : path.slice(0, cut);
      return op === "writeBinary" && folder !== "" && !adapter.everything().includes(folder)
        ? new Error(`ENOENT: no such file or directory, open '${path}'`)
        : undefined;
    };
    await expect(v.write("gone/new.md", enc.encode("new"), { mtime: 1, ctime: 1 })).rejects.toThrow(
      /ENOENT/,
    );
    expect(adapter.filePaths()).toEqual([]);

    // The watcher has reported the folder gone.
    index.getAbstractFileByPath = () => null;
    await v.write("gone/new.md", enc.encode("new"), { mtime: 1, ctime: 1 });
    expect(adapter.text("gone/new.md")).toBe("new");
  });

  /**
   * The engine's decision table compares mtimes. A downloaded file stamped
   * with the moment it landed looks locally edited on the next pass, so the
   * device would upload back what it just received, forever.
   */
  it("sets the modification time it was given", async () => {
    const when = 1_600_000_000_000;
    await vault.write("note.md", enc.encode("x"), { mtime: when, ctime: when });
    const listed = await vault.list();
    expect(listed.find((f) => f.path === "note.md")?.mtime).toBe(when);
  });

  it("does not hand over neighbouring bytes when given a view", async () => {
    // Chunk reassembly produces exactly this: a Uint8Array that is a window
    // into a larger buffer. Passing the view where the buffer is read writes
    // the whole thing.
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    await vault.write("note.md", view, { mtime: 1, ctime: 1 });
    expect([...(await vault.read("note.md"))]).toEqual([1, 2, 3]);
  });

  it("hands bytes that fill their buffer to the adapter without copying them", async () => {
    // Every copy is a whole file more in memory, and a 64 MiB attachment
    // used to hold four at once on its way through `create` and `stage`.
    const handed: ArrayBuffer[] = [];
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      handed.push(data);
      return realWrite(path, data, options);
    };
    const whole = new Uint8Array([1, 2, 3, 4]);
    expect(await vault.create("whole.bin", whole, { mtime: 1, ctime: 1 })).toBe(true);
    adapter.seed("old.bin", "x");
    await vault.write("old.bin", whole, { mtime: 1, ctime: 1 });
    expect(handed).toHaveLength(3);
    expect(handed.every((data) => data === whole.buffer)).toBe(true);
    expect([...(await vault.read("whole.bin"))]).toEqual([1, 2, 3, 4]);
    expect([...(await vault.read("old.bin"))]).toEqual([1, 2, 3, 4]);
  });
});

describe("deleting", () => {
  /**
   * A deletion arriving over the wire was somebody's decision on another
   * device, possibly a mistaken one, and the first rule is not to lose a note.
   */
  it("moves a file to the system trash where there is one", async () => {
    adapter.systemTrashWorks = true;
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");

    expect(adapter.trashedToSystem).toEqual(["doomed.md"]);
    expect(adapter.trashedLocally).toEqual([]);
    expect(await vault.exists("doomed.md")).toBe(false);
  });

  it("falls back to the vault's own trash where there is not", async () => {
    adapter.systemTrashWorks = false;
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");

    expect(adapter.trashedLocally).toEqual(["doomed.md"]);
    expect(adapter.text(".trash/doomed.md")).toBe("x");
  });

  it("falls back when the system trash throws rather than refusing", async () => {
    // A locked file, or a platform whose trash is not there. Failing to
    // reach the recycle bin is not a reason to abandon the deletion.
    adapter.systemTrashThrows = true;
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");
    expect(adapter.trashedLocally).toEqual(["doomed.md"]);
  });

  /**
   * P-9. A phone has no system trash, and the Capacitor adapter answers
   * false every time it is asked: one more turn of the adapter's queue for
   * every deletion. A refusal is remembered for the session; a throw, which
   * is one file that could not go, is not.
   */
  it("asks for the system trash once a session where the platform has none", async () => {
    adapter.systemTrashWorks = false;
    for (const name of ["a.md", "b.md", "c.md"]) adapter.seed(name, name);
    for (const name of ["a.md", "b.md", "c.md"]) await vault.remove(name);
    expect(adapter.calls.filter((c) => c.op === "trashSystem")).toHaveLength(1);
    expect(adapter.trashedLocally).toEqual(["a.md", "b.md", "c.md"]);
    expect(adapter.text(".trash/c.md")).toBe("c.md");
  });

  it("keeps asking a system trash that throws, and one that works", async () => {
    adapter.systemTrashThrows = true;
    for (const name of ["a.md", "b.md"]) adapter.seed(name, name);
    for (const name of ["a.md", "b.md"]) await vault.remove(name);
    expect(adapter.calls.filter((c) => c.op === "trashSystem")).toHaveLength(2);
    expect(adapter.trashedLocally).toEqual(["a.md", "b.md"]);

    adapter.systemTrashThrows = false;
    adapter.systemTrashWorks = true;
    for (const name of ["c.md", "d.md"]) adapter.seed(name, name);
    for (const name of ["c.md", "d.md"]) await vault.remove(name);
    expect(adapter.trashedToSystem).toEqual(["c.md", "d.md"]);
  });

  it("removing something already gone is not an error", async () => {
    // Two devices deleting the same file produces this routinely.
    await expect(vault.remove("never-existed.md")).resolves.toBeUndefined();
    expect(adapter.trashedLocally).toEqual([]);
  });

  it("never syncs what it trashed", async () => {
    // .trash is in the never-sync list. Syncing it back would undo the
    // deletion on every other device in turn.
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");
    expect((await vault.list()).map((f) => f.path)).not.toContain(".trash/doomed.md");
  });
});

describe("paths from elsewhere", () => {
  /**
   * Paths arrive from the server, written by another device or by the server
   * itself. Nothing proves that either is well, and a bug on one is enough.
   */
  it("refuses to write outside the vault", async () => {
    for (const path of [
      "../escaped.md",
      "../../escaped.md",
      "a/../../escaped.md",
      "a/b/../../../out.md",
    ]) {
      await expect(
        vault.write(path, enc.encode("x"), { mtime: 1, ctime: 1 }),
        path,
      ).rejects.toThrow(/outside the vault/);
    }
    expect(adapter.filePaths()).toEqual([]);
  });

  it("refuses to read, remove or make a folder outside the vault", async () => {
    await expect(vault.read("../secret.md")).rejects.toThrow(/outside the vault/);
    await expect(vault.remove("../important")).rejects.toThrow(/outside the vault/);
    await expect(vault.mkdir("../elsewhere")).rejects.toThrow(/outside the vault/);
  });

  it("allows a path that merely looks alarming", async () => {
    // `..` inside a name is a filename, not a traversal, and refusing it
    // would make a legitimate note unsyncable.
    await vault.write("notes/a..b.md", enc.encode("fine"), { mtime: 1, ctime: 1 });
    expect(dec.decode(await vault.read("notes/a..b.md"))).toBe("fine");
  });

  it("refuses a path that normalizes to nothing", async () => {
    // normalizePath("") and normalizePath("/") are both "/", the vault root.
    // Writing a file there is not a thing, and quietly doing something is
    // worse than refusing.
    for (const path of ["", "/", "///"]) {
      await expect(
        vault.write(path, enc.encode("x"), { mtime: 1, ctime: 1 }),
        JSON.stringify(path),
      ).rejects.toThrow();
    }
  });
});

describe("the index", () => {
  const state = (cursor: number) => ({
    cursor,
    entries: { "note.md": { path: "note.md", hash: "h" } },
    remote: { "note.md": { uid: 1 } },
    pending: ["note.md"],
  });

  it("round trips", async () => {
    const store = new ObsidianIndexStore(adapter, ".obsidian/plugins/trew/index.json");
    await store.save(state(7));
    expect(await store.load()).toEqual(state(7));
  });

  it("reports nothing when there is nothing yet", async () => {
    expect(await new ObsidianIndexStore(adapter, "nowhere/index.json").load()).toBeUndefined();
  });

  /**
   * Rule 2, and the incident behind it: code that read a config file, fell
   * back to an empty result on error, and wrote that back disabled every
   * plugin on a device. An index that cannot be read must stop the run, not be
   * replaced with a blank one that then re-uploads the vault.
   */
  it("refuses to start from an index it cannot parse", async () => {
    await adapter.write("index.json", "{ this is not json");
    await expect(new ObsidianIndexStore(adapter, "index.json").load()).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("creates the folder it needs", async () => {
    const store = new ObsidianIndexStore(adapter, "deep/nested/index.json");
    await store.save(state(1));
    expect(await adapter.exists("deep/nested")).toBe(true);
    expect((await store.load())?.cursor).toBe(1);
  });
});

/**
 * The scan reads Obsidian's own index rather than asking the adapter about
 * every file in turn.
 *
 * On a desktop the difference is wasteful; on a phone it is the difference
 * between a scan you do not notice and one you do, since every adapter call
 * crosses into the platform. The listing happens on every pass, so the cost is
 * per pass, for ever.
 */
describe("what a scan costs", () => {
  it("does not ask the adapter about each file", async () => {
    const a = new FakeAdapter();
    for (let i = 0; i < 200; i++) a.seed(`folder${i % 10}/note-${i}.md`, "x");
    const counting = new CountingAdapter(a);
    const v = new ObsidianVault(
      asVault(new FakeVaultIndex(counting as unknown as FakeAdapter)),
      ".obsidian",
    );

    const listed = await v.list();
    expect(listed.length).toBe(210); // 200 notes and the 10 folders

    // One case-folding probe on the first listing and one recovery-log stat
    // on every listing. Neither costs a call per note as the vault grows.
    expect(
      { stat: counting.stats, list: counting.lists, exists: counting.exists_ },
      `a 200 file vault cost ${counting.stats} stat, ${counting.lists} list and ${counting.exists_} exists calls`,
    ).toEqual({ stat: 1, list: 0, exists: 1 });
    await v.list();
    expect(
      { stat: counting.stats, list: counting.lists, exists: counting.exists_ },
      "the second scan cost more than the log",
    ).toEqual({ stat: 2, list: 0, exists: 1 });

    // And the same vault at ten times the size costs the same, which is the
    // claim. Pinning the number alone would pass on a scan that had become
    // per-file and cheap per file.
    const big = new FakeAdapter();
    for (let i = 0; i < 2000; i++) big.seed(`folder${i % 10}/note-${i}.md`, "x");
    const bigCount = new CountingAdapter(big);
    const bigVault = new ObsidianVault(
      asVault(new FakeVaultIndex(bigCount as unknown as FakeAdapter)),
      ".obsidian",
    );
    await bigVault.list();
    expect(
      { stat: bigCount.stats, list: bigCount.lists, exists: bigCount.exists_ },
      "ten times the notes must not increase scan calls",
    ).toEqual({ stat: 1, list: 0, exists: 1 });
  });

  it("still reports what the walk did", async () => {
    // The same answers as before, from a different source. Folders with no
    // stat, files with theirs.
    const a = new FakeAdapter();
    a.seed("notes/deep/two.md", "two");
    a.seed("top.md", "top");
    const v = new ObsidianVault(asVault(new FakeVaultIndex(a)), ".obsidian");

    const byPath = new Map((await v.list()).map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual([
      "notes",
      "notes/deep",
      "notes/deep/two.md",
      "top.md",
    ]);
    expect(byPath.get("notes")?.folder).toBe(true);
    expect(byPath.get("top.md")?.folder).toBe(false);
    expect(byPath.get("top.md")?.size).toBe(3);
    expect(byPath.get("top.md")?.mtime).toBeGreaterThan(0);
  });
});

/** Counts what the plugin asks of the adapter, which is meant to be nothing. */
class CountingAdapter {
  stats = 0;
  lists = 0;
  exists_ = 0;

  constructor(private readonly inner: FakeAdapter) {}

  index() {
    return this.inner.index();
  }
  async stat(p: string) {
    this.stats++;
    return this.inner.stat(p);
  }
  async list(p: string) {
    this.lists++;
    return this.inner.list(p);
  }
  async exists(p: string) {
    this.exists_++;
    return this.inner.exists(p);
  }
}

/**
 * Streaming through the resource URL, which is how the plugin sends a large
 * attachment without holding it. `DataAdapter` has no ranged or streaming read,
 * but `getResourcePath` returns a URL the webview already fetches for images,
 * and that response carries a body stream and honours a Range header. Verified
 * in a running Obsidian on desktop; unverified on mobile, which is why the
 * engine falls back rather than failing a file.
 */
describe("reading a file through its resource URL", () => {
  /**
   * Test bytes that do not repeat.
   *
   * This was `(i * 37 + (i >> 7)) & 0xff`, whose period is 32768, so every
   * 64 KiB block of it was byte-identical to every other. That made a whole
   * class of bug invisible: yielding a view of the reused block buffer instead
   * of a copy passed, because all the aliased blocks looked the same anyway.
   * Data that repeats at the block size cannot test blocking.
   */
  const body = (n: number) => {
    const out = new Uint8Array(n);
    let x = 0x2545f491;
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      out[i] = (x >>> 16) & 0xff;
    }
    return out;
  };

  /** A vault whose resource URLs are served by a fetch this test controls. */
  function streaming(
    bytes: Uint8Array,
    opts: { honourRange?: boolean; fail?: boolean; pieces?: number } = {},
  ) {
    const adapter = new FakeAdapter();
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    (adapter as unknown as { getResourcePath(p: string): string }).getResourcePath = (p) =>
      `app://test/${p}`;

    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      if (opts.fail) return { ok: false, status: 404, body: null };
      const range = init?.headers?.["Range"];
      let slice = bytes;
      if (range && opts.honourRange !== false) {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
        slice = bytes.subarray(Number(a), Number(b) + 1);
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => slice.slice().buffer,
        body: {
          getReader() {
            // One piece unless the test asks for a shape. What a fetch hands
            // back is the transport's business, and re-blocking exists so the
            // chunker never sees it, so the shapes have to be tested.
            const piece = opts.pieces ?? slice.length;
            let at = 0;
            return {
              async read() {
                if (at >= slice.length) return { done: true, value: undefined };
                const next = slice.slice(at, at + Math.max(1, piece));
                at += next.length;
                return { done: false, value: next };
              },
            };
          },
        },
      };
    }) as never;
    return vault;
  }

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("streams the whole file in blocks of the size asked for", async () => {
    const bytes = body(300_000);
    const vault = streaming(bytes);
    const blocks: Uint8Array[] = [];
    for await (const b of vault.readBlocks("big.bin", 64 * 1024)) blocks.push(b);

    // Re-blocked, so what the chunker sees does not depend on how the
    // transport felt like splitting the response.
    expect(blocks.length).toBe(Math.ceil(300_000 / (64 * 1024)));
    expect(blocks.slice(0, -1).every((b) => b.length === 64 * 1024)).toBe(true);

    const joined = new Uint8Array(300_000);
    let at = 0;
    for (const b of blocks) {
      joined.set(b, at);
      at += b.length;
    }
    expect(joined).toEqual(bytes);
  });

  /**
   * The blocks must not depend on how the response arrived.
   *
   * The re-blocking used to grow a buffer by concatenation, which copied
   * everything held on every arriving piece: 2144 MiB copied and 4160 buffers
   * allocated to move 64 MiB when the pieces came 16 KiB at a time. It fills one
   * buffer now, and that is a different loop, so the shapes that used to take
   * the other branch are the ones worth checking.
   */
  it("blocks the same whatever size the pieces arrive in", async () => {
    // Small blocks, so the byte-at-a-time shapes are a few thousand reads
    // rather than a few hundred thousand.
    const size = 10_000;
    const bytes = body(size);
    const blockSize = 4096;

    for (const pieces of [1, 3, 1000, blockSize - 1, blockSize, blockSize + 1, size, size * 2]) {
      const vault = streaming(bytes, { pieces });
      const blocks: Uint8Array[] = [];
      for await (const b of vault.readBlocks("big.bin", blockSize)) blocks.push(b);

      expect(blocks.length, `pieces=${pieces}`).toBe(Math.ceil(size / blockSize));
      expect(
        blocks.slice(0, -1).every((b) => b.length === blockSize),
        `pieces=${pieces}: a block that is not full`,
      ).toBe(true);
      expect(blocks[blocks.length - 1]!.length, `pieces=${pieces}`).toBe(size % blockSize);

      const joined = new Uint8Array(size);
      let at = 0;
      for (const b of blocks) {
        joined.set(b, at);
        at += b.length;
      }
      expect(joined, `pieces=${pieces}: the bytes came out different`).toEqual(bytes);
    }
  });

  it("reads a range from the middle", async () => {
    const bytes = body(100_000);
    const vault = streaming(bytes);
    expect(await vault.readRange("big.bin", 40_000, 40_200)).toEqual(
      bytes.subarray(40_000, 40_200),
    );
  });

  // The failure that would otherwise be silent: a handler ignoring Range and
  // answering with the whole file. Those bytes would be sent under a chunk
  // name they do not hash to, and refused by the server for not matching it,
  // which ends the upload.
  // Caught here, it is a platform that cannot stream.
  it("refuses a vault that ignores the range rather than sending the wrong bytes", async () => {
    const vault = streaming(body(100_000), { honourRange: false });
    await expect(vault.readRange("big.bin", 40_000, 40_200)).rejects.toThrow(/ranged reads/);
  });

  it("says so when the resource cannot be fetched at all", async () => {
    const vault = streaming(body(1000), { fail: true });
    await expect(vault.readRange("big.bin", 0, 10)).rejects.toThrow(/404/);
  });
});

/**
 * A filesystem that folds case, which is what macOS and Windows are.
 *
 * `FakeAdapter` is a `Map` and so is case-sensitive, like Linux. Most of this
 * file is right to use it. This corner is not: the bug it covers only exists
 * where two spellings are one file, and on a case-sensitive fake there is
 * nothing to reproduce.
 *
 * The folding lives in the fake now, under the name and the two rules the
 * shipped adapter uses: a write lands on the spelling already on disk, and a
 * rename onto an occupied name is refused unless the two names differ only by
 * case. This used to be a subclass here that had the first rule and not the
 * second, so a rename onto a name that existed in another case succeeded and
 * left two files a folding disk could not have held.
 */
function foldingAdapter(): FakeAdapter {
  const adapter = new FakeAdapter();
  adapter.insensitive = true;
  return adapter;
}

describe("writing a name that differs only by case", () => {
  it("renames the file rather than leaving the old spelling", async () => {
    const folding = foldingAdapter();
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    const times = { mtime: 1000, ctime: 1000 };

    await vault.write("Note.md", new TextEncoder().encode("first"), times);
    expect((await folding.list("/")).files).toContain("Note.md");

    // The other device renamed it. Writing the new spelling has to move the
    // directory entry, or the next scan calls NOTE.md missing and reports a
    // deletion that nobody made.
    await vault.write("NOTE.md", new TextEncoder().encode("first"), times);
    const listed = (await folding.list("/")).files;
    expect(listed).toContain("NOTE.md");
    expect(listed).not.toContain("Note.md");
    expect(listed.filter((f) => f.toLowerCase() === "note.md")).toHaveLength(1);
  });

  it("calls two spellings of one file the same file, and two files not", async () => {
    const folding = foldingAdapter();
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    await vault.write("Note.md", new TextEncoder().encode("first"), { mtime: 1, ctime: 1 });

    expect(await vault.sameFile("Note.md", "NOTE.md")).toBe(true);
    expect(await vault.sameFile("Note.md", "Note.md")).toBe(true);
    // Different names are different files whatever the filesystem does.
    expect(await vault.sameFile("Note.md", "Other.md")).toBe(false);
  });
});

/**
 * The adapter's own write truncates the destination and then
 * fills it, read out of the shipped bundle, so a note used to be able to end up
 * empty with no copy of the old bytes or the new. Every failure below is one a
 * full disk or a killed process produces, and after each the note is either
 * as it was or complete.
 */
/** Whether a path is a staging copy beside `note`, whatever its random part. */
const isStaging = (path: string, note = "note.md") =>
  new RegExp(`^\\.trew-tmp-[0-9a-f]{32}-${note.replace(".", "\\.")}$`).test(path);
/** The staging copies present, by name. */
const stagingCopies = (a: FakeAdapter) => a.filePaths().filter((p) => p.includes(".trew-tmp-"));

describe("landing a note without a moment where it is half written", () => {
  const times = { mtime: 1000, ctime: 1000 };

  it("a new note arrives by rename, never by a write at its own path", async () => {
    await vault.write("note.md", enc.encode("fresh"), times);
    expect(adapter.text("note.md")).toBe("fresh");
    expect(stagingCopies(adapter)).toEqual([]);
    const writes = adapter.calls.filter((c) => c.op === "writeBinary").map((c) => c.path);
    expect(writes.length).toBe(1);
    expect(isStaging(writes[0]!)).toBe(true);
    expect(adapter.calls.some((c) => c.op === "rename" && c.to === "note.md")).toBe(true);
  });

  it("a write refused before anything lands leaves the note as it was", async () => {
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) =>
      op === "writeBinary" && isStaging(path) ? new Error("EACCES: refused") : undefined;
    await expect(vault.write("note.md", enc.encode("new"), times)).rejects.toThrow(/EACCES/);
    expect(adapter.text("note.md")).toBe("old");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("a staging copy cut short is caught by reading it back, and the note is untouched", async () => {
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) => (op === "writeBinary" && isStaging(path) ? 2 : undefined);
    await expect(vault.write("note.md", enc.encode("new content"), times)).rejects.toThrow(
      /wrote 2 of 11/,
    );
    expect(adapter.text("note.md")).toBe("old");
    // Nothing half written is left lying about under a name that looks like a copy.
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("a short staging copy that the adapter did not report is still caught", async () => {
    // The adapter says the write succeeded and the file is short anyway. The
    // read-back is the only thing that can see it. Rule 4.
    adapter.seed("note.md", "old");
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (isStaging(path)) return realWrite(path, data.slice(0, 3), options);
      return realWrite(path, data, options);
    };
    await expect(vault.write("note.md", enc.encode("new content"), times)).rejects.toThrow(
      /3 bytes after writing 11/,
    );
    expect(adapter.text("note.md")).toBe("old");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("a staging copy the adapter reported and never wrote is caught, and named", async () => {
    // The read-back is the whole check now (P-1c), so a file that is not
    // there has to be found by it, and said in words that name the path.
    adapter.seed("note.md", "old");
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (isStaging(path)) return;
      return realWrite(path, data, options);
    };
    await expect(vault.write("note.md", enc.encode("new content"), times)).rejects.toThrow(
      /\.trew-tmp-[0-9a-f]+-note\.md cannot be read back after writing it: ENOENT/,
    );
    expect(adapter.text("note.md")).toBe("old");
  });

  it("a failure while replacing keeps the complete new copy beside the note and names it", async () => {
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) => (op === "writeBinary" && path === "note.md" ? 1 : undefined);
    await expect(vault.write("note.md", enc.encode("new content"), times)).rejects.toThrow(
      /complete new content is beside it at \.trew-tmp-[0-9a-f]{32}-note\.md/,
    );
    // The destination is what the adapter left, which is the failure this
    // API cannot prevent; the new version is whole beside it, and the old one
    // is on the server.
    const [copy] = stagingCopies(adapter);
    expect(copy).toBeDefined();
    expect(adapter.text(copy!)).toBe("new content");
  });

  it("a failure removing the staging copy does not fail a verified write", async () => {
    const logs: unknown[][] = [];
    const logging = new ObsidianVault(
      asVault(new FakeVaultIndex(adapter)),
      ".obsidian",
      (...rest) => void logs.push(rest),
    );
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) =>
      op === "remove" && isStaging(path) ? new Error("EBUSY: in use") : undefined;
    await expect(logging.write("note.md", enc.encode("new"), times)).resolves.toBeUndefined();
    expect(adapter.text("note.md")).toBe("new");
    expect(logs.flat().join(" ")).toMatch(/staging copy/);
    // And the leftover is never listed as a note.
    expect((await logging.list()).map((f) => f.path)).toEqual(["note.md"]);
  });

  it("keeps the mtime it was given through the staging copy", async () => {
    await vault.write("note.md", enc.encode("x"), { mtime: 1_600_000_000_000, ctime: 0 });
    expect((await adapter.stat("note.md"))?.mtime).toBe(1_600_000_000_000);
  });
});

/**
 * `exists` and then `write` is a gap, and a
 * conflict copy or a restore landing in it replaced whatever appeared there.
 * The claim has to be exclusive, and `rename` refusing an occupied destination
 * is what makes it so.
 */
describe("creating a file only where nothing is", () => {
  const times = { mtime: 1000, ctime: 1000 };

  it("writes where nothing is, and refuses where something is", async () => {
    expect(await vault.create("new.md", enc.encode("mine"), times)).toBe(true);
    expect(adapter.text("new.md")).toBe("mine");
    expect(await vault.create("new.md", enc.encode("again"), times)).toBe(false);
    expect(adapter.text("new.md")).toBe("mine");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("loses to a file that appears between looking and claiming", async () => {
    adapter.fault = (op, _path, to) => {
      // Somebody else writes the very name, in the gap.
      if (op === "rename" && to === "new.md") adapter.seed("new.md", "theirs");
      return undefined;
    };
    expect(await vault.create("new.md", enc.encode("mine"), times)).toBe(false);
    expect(adapter.text("new.md")).toBe("theirs");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("does not report a claim it cannot prove", async () => {
    adapter.fault = (op, path) =>
      op === "writeBinary" && isStaging(path, "new.md") ? 1 : undefined;
    await expect(vault.create("new.md", enc.encode("mine"), times)).rejects.toThrow(/wrote 1/);
    expect(await adapter.exists("new.md")).toBe(false);
  });

  /**
   * P-1b. Both adapters look for the destination inside the rename's own turn
   * of their queue (1.13.7 and 1.14.4), so a look from here before it is
   * earlier than theirs and narrows nothing. The claim is the rename's.
   */
  it("leaves the look to the rename on an Obsidian whose rename makes it", async () => {
    const asked = () => adapter.calls.filter((c) => c.op === "exists" && c.path === "new.md");
    expect(await vault.create("new.md", enc.encode("mine"), times)).toBe(true);
    expect(asked(), "looked at the destination before the rename").toEqual([]);

    adapter.seed("taken.md", "theirs");
    expect(await vault.create("taken.md", enc.encode("mine"), times)).toBe(false);
    expect(adapter.text("taken.md")).toBe("theirs");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("still looks first on an Obsidian older than the one whose rename was read", async () => {
    setApiVersion("1.13.6");
    try {
      adapter.seed("taken.md", "theirs");
      expect(await vault.create("taken.md", enc.encode("mine"), times)).toBe(false);
      // Refused before anything was staged.
      expect(adapter.calls.some((c) => c.op === "writeBinary")).toBe(false);
      expect(await vault.create("new.md", enc.encode("mine"), times)).toBe(true);
      expect(adapter.calls.filter((c) => c.op === "exists" && c.path === "new.md")).toHaveLength(2);
    } finally {
      resetStub();
    }
  });
});

/**
 * A file renamed into place, before Obsidian's index has it.
 *
 * The staged copy has a dot-prefixed name, which Obsidian's adapter never
 * holds, and its `rename` only moves a record it holds. So the landed file is
 * on the disk and missing from the index until the watcher reports it. On a
 * Mac receiving from a phone (M3, 2026-09-23), a pass inside that window read
 * a photo it had just downloaded as deleted and sent the deletion everywhere.
 */
describe("a file renamed into place, before Obsidian's index has it", () => {
  const times = { mtime: 1000, ctime: 1000 };
  const listed = async () => (await vault.list()).map((f) => f.path).sort();
  const indexed = () => adapter.index().map((f) => f.path);
  const statsOf = (path: string) =>
    adapter.calls.filter((c) => c.op === "stat" && c.path === path).length;

  it("lists a new file the index does not show yet", async () => {
    adapter.holdWatcher();
    await vault.write("new.md", enc.encode("landed"), { mtime: 1234, ctime: 1000 });
    expect(await vault.create("made.bin", new Uint8Array([1, 2, 3]), times)).toBe(true);

    expect(indexed()).not.toContain("new.md");
    const byPath = new Map((await vault.list()).map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(["made.bin", "new.md"]);
    expect(byPath.get("new.md")).toMatchObject({ folder: false, size: 6, mtime: 1234 });
    expect(byPath.get("made.bin")).toMatchObject({ folder: false, size: 3 });
  });

  it("lists an attachment replaced over the one the index had", async () => {
    await adapter.writeBinary("photo.jpg", new ArrayBuffer(0), times);
    expect(indexed()).toContain("photo.jpg");
    adapter.holdWatcher();

    const jpeg = new Uint8Array(4096).map((_, i) => (i * 131 + 7) & 0xff);
    const out = await vault.replace(
      "photo.jpg",
      { contentId: await plainDigest(new Uint8Array(0)), idOf: plainDigest },
      jpeg,
      { mtime: 900, ctime: 900 },
      "photo (kept).jpg",
    );

    // The old bytes were moved aside and removed as a duplicate, so the index
    // lost the name, and the new bytes have not been reported yet.
    expect(out).toEqual({ landed: true });
    expect(indexed()).not.toContain("photo.jpg");
    const byPath = new Map((await vault.list()).map((f) => [f.path, f]));
    expect([...byPath.keys()]).toEqual(["photo.jpg"]);
    expect(byPath.get("photo.jpg")).toMatchObject({ size: 4096, mtime: 900 });
  });

  it("stops asking once the index has it, or once nothing is there", async () => {
    adapter.holdWatcher();
    await vault.write("kept.md", enc.encode("stays"), times);
    await vault.write("gone.md", enc.encode("goes"), times);
    expect(await listed()).toEqual(["gone.md", "kept.md"]);

    await adapter.remove("gone.md");
    adapter.releaseWatcher();
    expect(await listed()).toEqual(["kept.md"]);
    const asked = { kept: statsOf("kept.md"), gone: statsOf("gone.md") };
    expect(await listed()).toEqual(["kept.md"]);
    expect({ kept: statsOf("kept.md"), gone: statsOf("gone.md") }).toEqual(asked);
  });

  it("fails the listing when it cannot tell whether such a file is there", async () => {
    adapter.holdWatcher();
    await vault.write("new.md", enc.encode("landed"), times);
    adapter.fault = (op, path) =>
      op === "stat" && path === "new.md" ? new Error("EIO: stat failed") : undefined;
    // Rule 2: left out, it would read as deleted.
    await expect(vault.list()).rejects.toThrow(/EIO/);
    adapter.fault = undefined;
    expect(await listed()).toEqual(["new.md"]);
  });

  it("takes a respelling the index shows for the same file on a folding disk", async () => {
    adapter.insensitive = true;
    adapter.holdWatcher();
    await vault.write("note.md", enc.encode("one file"), times);
    // Respelled behind the vault's back, then reported by the watcher.
    await adapter.rename("note.md", "Note.md");
    adapter.releaseWatcher();
    expect(await listed()).toEqual(["Note.md"]);
  });
});

/**
 * A name the engine found on the disk that the index does not have.
 *
 * `forceFull` is asked for on every thirty-second pass, so it is not a walk
 * here. What it guards is the engine's deletion of a synced name the listing
 * left out, and the engine names each one `exists` finds (`present`).
 */
describe("a name the engine found on the disk and the index does not have", () => {
  const byPath = async (options?: { forceFull?: boolean; present?: readonly string[] }) =>
    new Map((await vault.list(options)).map((f) => [f.path, f]));

  it("reads it from the disk, and keeps reading it until the index has it", async () => {
    adapter.seed("photo.jpg", "old");
    adapter.holdWatcher();
    adapter.writeUnreported("photo.jpg", enc.encode("taken again"), 5000);
    expect((await byPath()).has("photo.jpg")).toBe(false);

    const asked = await byPath({ present: ["photo.jpg"] });
    expect(asked.get("photo.jpg")).toMatchObject({ folder: false, size: 11, mtime: 5000 });
    // The next pass lists without naming it and must not lose it again.
    expect((await byPath()).has("photo.jpg")).toBe(true);
    adapter.releaseWatcher();
    const stats = adapter.calls.filter((c) => c.op === "stat" && c.path === "photo.jpg").length;
    expect((await byPath()).has("photo.jpg")).toBe(true);
    expect(adapter.calls.filter((c) => c.op === "stat" && c.path === "photo.jpg").length).toBe(
      stats,
    );
  });

  it("reads a folder as a folder", async () => {
    await adapter.mkdir("Photos");
    expect((await byPath({ present: ["Photos"] })).get("Photos")).toMatchObject({ folder: true });
  });

  it("does not walk the vault to do it", async () => {
    for (let i = 0; i < 3000; i++) adapter.seed(`folder${i % 30}/note-${i}.md`, "x");
    adapter.holdWatcher();
    adapter.writeUnreported("folder0/note-0.md", enc.encode("again"));
    await vault.list();
    const before = adapter.calls.length;
    expect((await byPath({ forceFull: true, present: ["folder0/note-0.md"] })).size).toBe(3030);
    // The one stat the name costs and the recovery log's, and no call per note.
    const cost = adapter.calls.slice(before).map((c) => c.op);
    expect(cost.filter((op) => op === "list")).toEqual([]);
    expect(cost.filter((op) => op === "stat").length).toBeLessThanOrEqual(2);
  });

  it("leaves a respelling the index already shows to the listing", async () => {
    // On a folding disk `exists` answers for a note renamed only in case, and
    // the engine pairs the two names as that rename from what is listed.
    adapter.insensitive = true;
    adapter.seed("NOTE.md", "renamed in case");
    expect([...(await byPath({ present: ["Note.md"] })).keys()]).toEqual(["NOTE.md"]);
  });

  it("fails the listing when the disk cannot be asked", async () => {
    adapter.holdWatcher();
    adapter.writeUnreported("photo.jpg", enc.encode("taken again"));
    adapter.fault = (op, path) =>
      op === "stat" && path === "photo.jpg" ? new Error("EIO: stat failed") : undefined;
    await expect(vault.list({ present: ["photo.jpg"] })).rejects.toThrow(/EIO/);
  });
});

describe("a rename this client makes, as Obsidian reports it", () => {
  it("is known as its own for as long as the adapter has it in hand", async () => {
    await adapter.writeBinary("photo.jpg", new Uint8Array([1]).buffer, { mtime: 1, ctime: 1 });
    const reported: [string, string, boolean][] = [];
    // Where the shipped adapter reports it: inside the call.
    adapter.handler = (kind, path, oldPath) => {
      if (kind === "renamed") reported.push([oldPath!, path, vault.ownRename(oldPath!, path)]);
    };
    await vault.replace(
      "photo.jpg",
      undefined,
      new Uint8Array([2, 3]),
      { mtime: 2, ctime: 2 },
      "photo (kept).jpg",
    );
    expect(reported).toEqual([["photo.jpg", "photo (kept).jpg", true]]);
    expect(vault.ownRename("photo.jpg", "photo (kept).jpg")).toBe(false);

    // And a person's rename of the same pair afterwards is theirs.
    await adapter.rename("photo (kept).jpg", "renamed.jpg");
    expect(reported.at(-1)).toEqual(["photo (kept).jpg", "renamed.jpg", false]);
  });
});

/**
 *  Two raw names in Obsidian's index that normalize
 * to one path used to be one entry in the map, the second winning silently.
 *
 * That was fixed by throwing out of `list`, and throwing was the wrong half of
 * the answer, for the reason `cli/vault-spelling.test.ts` gives about the same
 * bug on the other adapter: one ambiguous pair stopped the whole pass, so every
 * other note in the vault went nowhere until somebody renamed one of two names
 * that look identical. Naming the pair is what "fail loudly" asks for; stopping
 * the vault is not.
 *
 * These now assert the CLI's behaviour, and they are deliberately the same
 * assertions: the two adapters are one engine's two shells and they cannot
 * answer this question differently. Unreachable through Obsidian, whose index
 * is normalized before this code sees it, which is exactly why it had drifted.
 */
/**
 * The two ways one name can be spelled twice in an index, and both are ones
 * `normalizePath` folds: a no-break space against a plain one, and a
 * precomposed e-acute against e plus a combining acute. Written as escapes
 * because the point of these names is that they look identical.
 */
const SPACE = "a b.md";
const NBSP = "a\u00A0b.md";
const NFC = "caf\u00E9.md";
const NFD = "cafe\u0301.md";

describe("two names the plugin cannot hold apart", () => {
  it("names the pair rather than refusing the whole vault", async () => {
    adapter.seed(NBSP, "nbsp");
    adapter.seed(SPACE, "space");
    adapter.seed("fine.md", "x");
    const listed = (await vault.list()).map((f) => f.path);
    expect(listed, "the rest of the vault stopped as well").toEqual(["fine.md"]);
    expect(vault.ambiguous()).toEqual([{ path: SPACE, spellings: [NBSP, SPACE].sort() }]);
  });

  it("names NFC and NFD spellings of one name", async () => {
    adapter.seed(NFC, "nfc");
    adapter.seed(NFD, "nfd");
    expect(await vault.list()).toEqual([]);
    expect(vault.ambiguous()).toEqual([{ path: NFC, spellings: [NFC, NFD].sort() }]);
  });

  it("names the pair with the folder it is in", async () => {
    adapter.seed(`notes/${NFC}`, "nfc");
    adapter.seed(`notes/${NFD}`, "nfd");
    await vault.list();
    expect(vault.ambiguous()).toEqual([
      { path: `notes/${NFC}`, spellings: [`notes/${NFC}`, `notes/${NFD}`].sort() },
    ]);
  });

  it("stops naming it the moment one of the two is gone", async () => {
    adapter.seed(NFC, "nfc");
    adapter.seed(NFD, "nfd");
    await vault.list();
    expect(vault.ambiguous()).toHaveLength(1);

    await adapter.remove(NFD);
    expect((await vault.list()).map((f) => f.path)).toEqual([NFC]);
    expect(vault.ambiguous(), "the refusal outlived what caused it").toEqual([]);
  });

  /**
   * A lone odd spelling still syncs, under the normal name, and is still
   * readable. The clash path must not have taken the ordinary case with it.
   */
  it("still maps a lone odd spelling back to the name in the index", async () => {
    adapter.seed(NFD, "nfd only");
    expect((await vault.list()).map((f) => f.path)).toEqual([NFC]);
    expect(vault.ambiguous()).toEqual([]);
    expect(new TextDecoder().decode(await vault.read(NFC))).toBe("nfd only");
  });
  it("folds normalization always, and case only where the adapter does", async () => {
    // Until asked, the safe answer: two spellings are one file.
    expect(vault.canonical("Note.md")).toBe(vault.canonical("note.md"));
    expect(vault.canonical("café.md")).toBe(vault.canonical("café.md"));
    expect(vault.canonical("a b.md")).toBe(vault.canonical("a b.md"));

    // The fake is a Map, which is case-sensitive like Linux, and the probe
    // finds that out from the first listing.
    adapter.seed("Note.md", "x");
    await vault.list();
    expect(vault.canonical("Note.md")).not.toBe(vault.canonical("note.md"));
    expect(vault.canonical("café.md")).toBe(vault.canonical("café.md"));

    const folding = foldingAdapter();
    const foldingVault = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    await foldingVault.write("Note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await foldingVault.list();
    expect(foldingVault.canonical("Note.md")).toBe(foldingVault.canonical("note.md"));
  });

  it("two case spellings are two files where the adapter keeps them apart", async () => {
    adapter.seed("Note.md", "one");
    adapter.seed("note.md", "two");
    const listed = (await vault.list()).map((f) => f.path).sort();
    expect(listed).toEqual(["Note.md", "note.md"]);
    expect(vault.canonical("Note.md")).not.toBe(vault.canonical("note.md"));
  });
});

/**
 * `matchCase` used to shrug at a listing that failed and write
 * under a spelling nothing had checked, leaving the old spelling on disk while
 * the engine recorded the new one as synced.
 */
describe("a spelling check that cannot be made", () => {
  it("fails the write and leaves the note alone, then succeeds once it can", async () => {
    const folding = foldingAdapter();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    const times = { mtime: 1000, ctime: 1000 };
    await v.write("Note.md", enc.encode("first"), times);

    let failures = 1;
    folding.fault = (op) => (op === "list" && failures-- > 0 ? new Error("EIO") : undefined);
    await expect(v.write("NOTE.md", enc.encode("second"), times)).rejects.toThrow(
      /cannot check how NOTE.md is spelled/,
    );
    expect((await folding.list("/")).files).toEqual(["Note.md"]);
    expect(folding.text("Note.md")).toBe("first");

    await v.write("NOTE.md", enc.encode("second"), times);
    expect((await folding.list("/")).files).toEqual(["NOTE.md"]);
    expect(folding.text("NOTE.md")).toBe("second");
  });
});

/**
 * The index is written with the same truncating write as a
 * note, and an index cut short is not JSON, and an index that is not JSON stops
 * the plugin on every load. A vault whose notes were all fine sat behind it.
 */
describe("the index, interrupted", () => {
  const INDEX = ".obsidian/plugins/trew/index.json";
  const TEMP = ".obsidian/plugins/trew/.trew-tmp-index-index.json";
  const LOG = ".obsidian/plugins/trew/index.log";
  const state = (cursor: number) => ({
    cursor,
    entries: { "note.md": { path: "note.md", hash: `h${cursor}` } },
    remote: {},
    pending: [],
  });

  /**
   * Every save writes a whole snapshot, which is what these tests are about.
   *
   * With the ordinary policy the second save of a session appends one record
   * and never touches the snapshot, so a fault injected into the snapshot
   * write would never fire and every one of these would pass without testing
   * anything. Forcing the snapshot keeps them aimed at the path they were
   * written for.
   */
  const always = { policy: { fractionOfSnapshot: 0, maxRecords: 1, minBytes: 0 } };

  it("recovers from a live index cut short by reading the staged copy", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX, always);
    await store.save(state(1));
    adapter.fault = (op, path) => (op === "write" && path === INDEX ? 5 : undefined);
    await expect(store.save(state(2))).rejects.toThrow(/wrote 5 of/);
    expect(() => JSON.parse(adapter.text(INDEX)!)).toThrow();

    // A restart: a fresh store over the same files.
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(2));
  });

  it("keeps the live index when the staging copy is what was cut short", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX, always);
    await store.save(state(1));
    adapter.fault = (op, path) => (op === "writeBinary" && path === TEMP ? 3 : undefined);
    await expect(store.save(state(2))).rejects.toThrow(/wrote 3/);
    expect(await adapter.exists(TEMP)).toBe(false);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("loads the live index and tidies a staged copy left behind after a complete save", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX, always);
    await store.save(state(1));
    adapter.fault = (op, path) =>
      op === "remove" && path === TEMP ? new Error("EBUSY") : undefined;
    await expect(store.save(state(2))).resolves.toBeUndefined();
    expect(await adapter.exists(TEMP)).toBe(true);
    adapter.fault = undefined;

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(2));
    expect(await adapter.exists(TEMP)).toBe(false);
  });

  it("a first save that fails leaves no index at all, not a short one", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    adapter.fault = (op, path) => (op === "writeBinary" && path === TEMP ? 4 : undefined);
    await expect(store.save(state(1))).rejects.toThrow();
    expect(await adapter.exists(INDEX)).toBe(false);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toBeUndefined();
  });

  it("still refuses an unreadable index when there is nothing to recover it from", async () => {
    await adapter.write(INDEX, "{ cut sho");
    await expect(new ObsidianIndexStore(adapter, INDEX).load()).rejects.toThrow(/not valid JSON/);
  });

  it("removes every copy and proves it, for unlink", async () => {
    // Three files, not two. A journal left behind is a delta against a
    // snapshot that no longer exists, and the load after it refuses to start
    // rather than guessing at a base.
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));
    await store.save(state(2));
    expect(await adapter.exists(LOG), "nothing was journalled to remove").toBe(true);
    await adapter.write(TEMP, JSON.stringify(state(2)));
    await store.remove();
    expect(await adapter.exists(INDEX)).toBe(false);
    expect(await adapter.exists(TEMP)).toBe(false);
    expect(await adapter.exists(LOG), "the journal outlived the index").toBe(false);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toBeUndefined();

    await store.save(state(3));
    adapter.fault = (op, path) =>
      op === "remove" && path === INDEX ? new Error("EACCES") : undefined;
    await expect(store.remove()).rejects.toThrow(/EACCES/);
  });

  /**
   * F22. An interrupted removal must leave something that loads.
   *
   * A crash between the two removals leaves whatever is still there. Journal
   * gone and snapshot left is exactly what an index looked like before the
   * journal existed, and it loads without a word. The other way round is a
   * delta against a base that is not there, which the loader refuses, so an
   * unlink that stopped half way left a vault that would not start at all.
   * The CLI has removed them in the safe order since the journal landed; the
   * plugin had its list the other way up.
   */
  it("leaves a loadable index when the removal is interrupted at any point", async () => {
    for (const stopAt of [INDEX, TEMP, LOG]) {
      adapter = new FakeAdapter();
      const store = new ObsidianIndexStore(adapter, INDEX);
      await store.save(state(1));
      await store.save(state(2));
      await adapter.write(TEMP, JSON.stringify(state(2)));

      adapter.fault = (op, path) =>
        op === "remove" && path === stopAt ? new Error("EACCES") : undefined;
      await expect(store.remove()).rejects.toThrow(/EACCES/);
      adapter.fault = undefined;

      // Whatever survived, the next start has to get somewhere: an older
      // index, or a clean empty one. Never a refusal.
      const after = new ObsidianIndexStore(adapter, INDEX);
      const loaded = await after.load().catch((err: Error) => err);
      expect(
        loaded instanceof Error ? loaded.message : "loaded",
        `stopping the removal at ${stopAt} left an index that will not load`,
      ).toBe("loaded");
    }
  });
});

/**
 * A ranged read that came back short was handed on as if
 * it were the range, sent as a chunk it was not, and refused much later by
 * name.
 */
describe("a ranged read that comes back short", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is refused here, where the reason is knowable", async () => {
    const v = new ObsidianVault(asVault(new FakeVaultIndex(new FakeAdapter())), ".obsidian");
    globalThis.fetch = (async () => ({
      ok: true,
      status: 206,
      arrayBuffer: async () => new Uint8Array(100).buffer,
    })) as never;
    await expect(v.readRange("big.bin", 1000, 1200)).rejects.toThrow(
      /answered 100 bytes for a read of 200/,
    );
  });
});

/**
 * Above a few megabytes the read-back used to trust the
 * length alone, so a staged copy of the right size and the wrong bytes would
 * have become the note.
 */
describe("a large staged copy with the right length and the wrong bytes", () => {
  it("is caught by reading every byte back", async () => {
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (isStaging(path, "big.bin")) {
        const flipped = new Uint8Array(data.slice(0));
        flipped[3 * 1024 * 1024] = flipped[3 * 1024 * 1024]! ^ 0xff;
        return realWrite(path, flipped.buffer, options);
      }
      return realWrite(path, data, options);
    };
    await expect(vault.write("big.bin", big, { mtime: 1, ctime: 1 })).rejects.toThrow(
      /reads back differently/,
    );
    expect(await adapter.exists("big.bin")).toBe(false);
  });
});

/**
 * T63. The server takes a name of up to 255 bytes, which is what ext4, f2fs
 * and APFS hold, and the staging copy's name is the note's name with the
 * staging mark in front: nineteen bytes more. A note whose name was within
 * nineteen bytes of the limit never landed here, and an incoming edit failed
 * once its conflict copy's name, plus those bytes, passed it. Every pass
 * tried again and failed the same way, which threat model D1 says a name the
 * server accepted must never be.
 */
describe("a note whose name is near the filesystem's limit", () => {
  const times = { mtime: 1000, ctime: 1000 };
  const bytesIn = (s: string) => enc.encode(s).length;
  /**
   * A disk that refuses to make a name longer than 255 bytes, as ext4, f2fs
   * and APFS do. Asking about one is not refused: nothing can be there.
   */
  const nameMax = (a: FakeAdapter) => {
    const tooLong = (p: string) => p.split("/").some((part) => bytesIn(part) > 255);
    const makes = new Set(["write", "writeBinary", "append", "mkdir", "rename", "copy"]);
    a.fault = (op, path, to) =>
      makes.has(op) && (tooLong(path) || (to !== undefined && tooLong(to)))
        ? new Error(`ENAMETOOLONG: name too long, ${op} '${to ?? path}'`)
        : undefined;
  };
  /** The staging names this test's writes used, by the calls that wrote them. */
  const staged = (a: FakeAdapter) =>
    a.calls
      .filter((c) => c.op === "writeBinary" && c.path.includes(".trew-tmp-"))
      .map((c) => c.path);
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("lands a new note whose name is 250 bytes", async () => {
    nameMax(adapter);
    const name = `Notes/${"n".repeat(247)}.md`;
    expect(bytesIn(name.slice("Notes/".length))).toBe(250);
    await vault.write(name, enc.encode("a note with a long name\n"), times);
    expect(adapter.text(name)).toBe("a note with a long name\n");
    expect(stagingCopies(adapter)).toEqual([]);
    for (const p of staged(adapter)) {
      const last = p.slice(p.lastIndexOf("/") + 1);
      expect(bytesIn(last)).toBeLessThanOrEqual(255);
      expect(last.startsWith(".trew-tmp-")).toBe(true);
    }
  });

  it("cuts a name of three- and four-byte characters between characters, never inside one", async () => {
    nameMax(adapter);
    // 78 three-byte characters and an emoji of four bytes, 238 bytes, then the
    // extension: the cut lands inside the emoji's surrogate pair or a
    // character's bytes unless it is made between characters.
    for (const name of [
      `${"ノ".repeat(79)}.md`,
      `${"ノ".repeat(78)}🪨🪨.md`,
      `${"🪨".repeat(62)}.md`,
    ]) {
      expect(bytesIn(name)).toBeLessThanOrEqual(255);
      await vault.write(name, enc.encode(name), times);
      expect(adapter.text(name)).toBe(name);
    }
    expect(staged(adapter)).toHaveLength(3);
    for (const p of staged(adapter)) {
      expect(bytesIn(p)).toBeLessThanOrEqual(255);
      expect(unpaired.test(p), `a surrogate was split in ${p}`).toBe(false);
      expect(p.startsWith(".trew-tmp-")).toBe(true);
    }
  });

  it("keeps the backup of an edited note whose conflict copy's name is 250 bytes", async () => {
    nameMax(adapter);
    adapter.seed("note.md", "the note as it was\n", 1000);
    const keepAt = `${"k".repeat(247)}.md`;
    const out = await vault.replace(
      "note.md",
      { contentId: "not-what-is-there", idOf: async () => "something-else" },
      enc.encode("the incoming edit\n"),
      { mtime: 2000, ctime: 1000 },
      keepAt,
    );
    expect(out).toEqual({ keptAt: keepAt, landed: true });
    expect(adapter.text(keepAt)).toBe("the note as it was\n");
    expect(adapter.text("note.md")).toBe("the incoming edit\n");
  });
});

/**
 * A staging copy under a fixed name was a name a person
 * could have given a real dotfile, which no listing shows and a sync of the
 * note beside it would have overwritten.
 *
 * The four random bytes that replaced it were looked for on the disk before
 * every staged write. Sixteen are not (P-1e): no name a person, a peer or an
 * older build could have given a file is one of them, which is what this
 * checks. A generator pinned to repeat a name a file already has is no longer
 * caught by a look; the chance of meeting one from a working generator is one
 * in 2^128 per write.
 */
describe("a dotfile of the user's where a staging copy would go", () => {
  it("is never written over", async () => {
    // Pinned, so the random part repeats what an older build's four bytes
    // could have left beside the note, and the user's file has that name.
    const realRandom = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = ((arr: Uint8Array) => {
      arr.fill(0xab);
      return arr;
    }) as typeof crypto.getRandomValues;
    try {
      adapter.seed(".trew-tmp-abababab-note.md", "the user's own dotfile");
      await vault.write("note.md", enc.encode("a note"), { mtime: 1, ctime: 1 });
      expect(adapter.text("note.md")).toBe("a note");
      expect(adapter.text(".trew-tmp-abababab-note.md")).toBe("the user's own dotfile");
      expect(stagingCopies(adapter)).toEqual([".trew-tmp-abababab-note.md"]);
    } finally {
      crypto.getRandomValues = realRandom;
    }
  });

  it("carries 128 random bits, a fresh draw for every write, and asks the disk nothing", async () => {
    await vault.write("a.md", enc.encode("a"), { mtime: 1, ctime: 1 });
    await vault.write("b.md", enc.encode("b"), { mtime: 1, ctime: 1 });
    const names = adapter.calls
      .filter((c) => c.op === "writeBinary" && c.path.includes(".trew-tmp-"))
      .map((c) => c.path);
    expect(names).toHaveLength(2);
    const parts = names.map((p) => /^\.trew-tmp-([0-9a-f]{32})-[ab]\.md$/.exec(p)?.[1]);
    expect(parts.every((p) => p !== undefined)).toBe(true);
    expect(parts[0]).not.toBe(parts[1]);
    expect(adapter.calls.filter((c) => c.op === "exists" && c.path.includes(".trew-tmp-"))).toEqual(
      [],
    );
  });
});

/**
 * The engine saves the index after `flush`, so the index is
 * never durable ahead of the notes it names, and the plugin's vault had no
 * `flush` at all: on desktop the adapter's writes reached the disk when the
 * operating system felt like it, and the index could be durable first. On
 * desktop the adapter is Electron's, the vault is a directory, and Node's fs
 * is reachable, so every written file and every changed directory is fsynced.
 * On a phone there is no fs to reach and the flush is a no-op, which
 * docs/plugin.md calls best effort.
 */
/** Electron's adapter, as far as the vault can tell: it knows the disk path. */
class DesktopAdapter extends FakeAdapter {
  getBasePath(): string {
    return "/home/me/vault";
  }
  getFullPath(normalizedPath: string): string {
    return normalizedPath === "" ? this.getBasePath() : `${this.getBasePath()}/${normalizedPath}`;
  }
}

/** The same, on a filesystem that folds case: macOS and Windows. */
function foldingDesktopAdapter(): DesktopAdapter {
  const adapter = new DesktopAdapter();
  adapter.insensitive = true;
  return adapter;
}

/** A Node fs that records what was opened and synced. */
function recordingFs(failDirs = false) {
  const synced: string[] = [];
  const open: string[] = [];
  const fs = {
    promises: {
      async open(path: string, flags: string) {
        if (flags !== "r") throw new Error(`opened ${path} with ${flags}, and a sync needs only r`);
        if (failDirs && !path.includes(".")) throw new Error("EISDIR");
        open.push(path);
        return {
          async sync() {
            synced.push(path);
          },
          async close() {
            open.splice(open.indexOf(path), 1);
          },
        };
      },
    },
  };
  return { fs, synced, open };
}

describe("making a pass durable on desktop", () => {
  it("fsyncs every file written this pass and the directories their entries changed in", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced, open } = recordingFs();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    await v.write("daily/2026-09-02.md", enc.encode("one"), { mtime: 1, ctime: 1 });
    await v.write("top.md", enc.encode("two"), { mtime: 1, ctime: 1 });
    await v.mkdir("attachments");
    expect(synced, "nothing is synced until flush").toEqual([]);

    expect(v.flush).toBeDefined();
    await v.flush!();
    expect(synced).toContain("/home/me/vault/daily/2026-09-02.md");
    expect(synced).toContain("/home/me/vault/top.md");
    // The directories: the one the new note went in, and the root, whose
    // entries gained a note, a folder and another folder.
    expect(synced).toContain("/home/me/vault/daily");
    expect(synced).toContain("/home/me/vault");
    expect(open, "a handle was left open").toEqual([]);

    // Once. A second flush with nothing written syncs nothing.
    synced.length = 0;
    await v.flush!();
    expect(synced).toEqual([]);
  });

  it("syncs a file created beside an occupied name too", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced } = recordingFs();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    expect(await v.create("note.md", enc.encode("x"), { mtime: 1, ctime: 1 })).toBe(true);
    await v.flush!();
    expect(synced).toContain("/home/me/vault/note.md");
  });

  it("does not fail the pass when a directory cannot be synced, and says so once", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced } = recordingFs(true);
    const said: string[] = [];
    const v = new ObsidianVault(
      asVault(new FakeVaultIndex(desktop)),
      ".obsidian",
      (m) => void said.push(m),
      { fs },
    );
    await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await v.write("b.md", enc.encode("y"), { mtime: 1, ctime: 1 });
    await v.flush!();
    expect(synced).toEqual(["/home/me/vault/a.md", "/home/me/vault/b.md"]);
    expect(said.filter((m) => m.includes("will not sync a directory"))).toHaveLength(1);
  });

  it("fails the pass when a file cannot be synced, so the index is not saved ahead of it", async () => {
    const desktop = new DesktopAdapter();
    const fs = {
      promises: {
        async open(): Promise<never> {
          throw new Error("EIO");
        },
      },
    };
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await expect(v.flush!()).rejects.toThrow(/EIO/);
  });

  it("does nothing on an adapter that is not the desktop one, whatever fs is given", async () => {
    // Capacitor's adapter has no getFullPath: there is no path to sync and
    // no fs to sync it with. Best effort, and documented as such.
    const { fs, synced } = recordingFs();
    const v = new ObsidianVault(
      asVault(new FakeVaultIndex(new FakeAdapter())),
      ".obsidian",
      () => {},
      { fs },
    );
    await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await expect(v.flush!()).resolves.toBeUndefined();
    expect(synced).toEqual([]);
  });

  it("does nothing on desktop when no fs can be reached, rather than failing every pass", async () => {
    // A renderer whose `require` refuses, or has no fs: the flush has
    // nothing to sync with and says nothing, rather than failing every pass.
    const g = globalThis as { require?: unknown };
    const had = g.require;
    g.require = () => {
      throw new Error("no such module");
    };
    try {
      const desktop = new DesktopAdapter();
      const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian");
      await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
      await expect(v.flush!()).resolves.toBeUndefined();
    } finally {
      if (had === undefined) delete g.require;
      else g.require = had;
    }
  });
});

/**
 * P-D4 and P-D5 in the 0.3.0 review, both of them rule 3 in the form the header
 * of core/vault.ts gives it: the index must never be durable ahead of the notes
 * it names. `flush` is the whole of how that holds in the plugin, so anything it
 * forgets is a note the index can be saved over.
 */
describe("what flush must not forget (P-D4, P-D5)", () => {
  const times = { mtime: 1, ctime: 1 };

  it("syncs the rest of the pass, and keeps what it could not sync (P-D4)", async () => {
    const desktop = new DesktopAdapter();
    const synced: string[] = [];
    let failing: string | undefined = "/home/me/vault/a.md";
    const fs = {
      promises: {
        async open(path: string) {
          if (path === failing) throw new Error("EMFILE");
          return {
            async sync() {
              synced.push(path);
            },
            async close() {},
          };
        },
      },
    };
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    await v.write("a.md", enc.encode("one"), times);
    await v.write("b.md", enc.encode("two"), times);

    // The pass still fails, which is the point: the index is not saved over
    // a note that is not durable.
    await expect(v.flush!()).rejects.toThrow(/EMFILE/);
    // But one file that would not open is not a reason to leave every later
    // file in the pass unsynced.
    expect(synced, "the files after the failure were skipped").toContain("/home/me/vault/b.md");

    // And the one that failed is still owed. Forgetting it let the next pass
    // flush nothing and save the index over a note never made durable.
    failing = undefined;
    synced.length = 0;
    await expect(v.flush!()).resolves.toBeUndefined();
    expect(synced, "the file that failed was forgotten").toContain("/home/me/vault/a.md");
  });

  it("syncs the directory a deletion changed (P-D5)", async () => {
    for (const systemTrash of [true, false]) {
      const desktop = new DesktopAdapter();
      desktop.systemTrashWorks = systemTrash;
      const { fs, synced } = recordingFs();
      const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
        fs,
      });
      desktop.seed("daily/note.md", "text");

      await v.remove("daily/note.md");
      await v.flush!();
      // A pass that only deleted used to flush nothing at all and then save
      // the index, so the name could come back after a crash while the index
      // said it was gone.
      expect(synced, `system trash ${systemTrash}`).toContain("/home/me/vault/daily");
    }
  });

  it("syncs the directory a case-fixing rename changed even when the write fails (P-D5)", async () => {
    const desktop = foldingDesktopAdapter();
    const { fs, synced } = recordingFs();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    // Through the vault, because the fake only folds the spellings it has
    // been given: this is the file already on disk, already flushed.
    await v.write("daily/Note.md", enc.encode("old"), times);
    await v.flush!();
    synced.length = 0;

    // The other device renamed it to NOTE.md. The rename lands, the bytes
    // after it do not, and the directory entry that moved is the one thing
    // that changed on disk.
    desktop.fault = (op, path) =>
      op === "writeBinary" && path.includes("trew-tmp") ? new Error("ENOSPC") : undefined;
    await expect(v.write("daily/NOTE.md", enc.encode("new"), times)).rejects.toThrow(/ENOSPC/);
    desktop.fault = undefined;

    await v.flush!();
    expect(synced).toContain("/home/me/vault/daily");
  });

  /**
   * A Node fs that answers for what the adapter actually holds, which is what
   * a real one does and what `recordingFs` above does not: it opens anything.
   * A path that is not there fails the way the platform fails it.
   */
  function fsOver(adapter: DesktopAdapter) {
    const synced: string[] = [];
    const tried: string[] = [];
    const fs = {
      promises: {
        async open(path: string) {
          tried.push(path);
          const rel = path.slice("/home/me/vault".length).replace(/^\//, "");
          if (rel !== "" && !(await adapter.exists(rel))) {
            const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
            (err as NodeJS.ErrnoException).code = "ENOENT";
            throw err;
          }
          return {
            async sync() {
              synced.push(path);
            },
            async close() {},
          };
        },
      },
    };
    return { fs, synced, tried };
  }

  it("stops owing a file the same pass deleted (R6)", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced, tried } = fsOver(desktop);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });

    // Arriving and then withdrawn: a note downloaded in a pass that also
    // applies the deletion another device sent for it.
    await v.write("daily/note.md", enc.encode("one"), times);
    await v.remove("daily/note.md");

    await expect(v.flush!()).resolves.toBeUndefined();
    expect(tried, "a name with nothing at it was opened to be synced").not.toContain(
      "/home/me/vault/daily/note.md",
    );
    expect(synced, "the directory the deletion changed").toContain("/home/me/vault/daily");
  });

  it("stops owing a file that had already gone when the deletion arrived (N7)", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced, tried } = fsOver(desktop);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });

    // The note arrives, and something outside the app removes it before the
    // deletion another device sent for it is applied. `remove` returns early
    // on a path that is already gone, and used to leave the name on the
    // flush list for the next flush to work out for itself.
    await v.write("daily/note.md", enc.encode("one"), times);
    await desktop.remove("daily/note.md");
    await v.remove("daily/note.md");

    await expect(v.flush!()).resolves.toBeUndefined();
    expect(tried, "a name already known to be gone was opened to be synced").not.toContain(
      "/home/me/vault/daily/note.md",
    );
    expect(synced, "the directory the deletion changed").toContain("/home/me/vault/daily");
  });

  /**
   * N5. The other trigger the flush fix was written for: a write under a
   * spelling that differs only by case renames what is on disk, so a name the
   * flush is still holding from earlier in the same pass no longer names what
   * it named. The pass has to finish, under the surviving spelling.
   */
  it("keeps flushing after a case-only rename moves a file mid-pass (N5)", async () => {
    const folding = foldingDesktopAdapter();
    const { fs, synced } = fsOver(folding);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian", () => {}, {
      fs,
    });

    await v.write("daily/Note.md", enc.encode("old"), times);
    await v.write("daily/NOTE.md", enc.encode("new"), times);

    await expect(v.flush!()).resolves.toBeUndefined();
    // One file, spelled the way the last writer spelled it, and durable.
    expect((await folding.list("daily")).files).toEqual(["daily/NOTE.md"]);
    expect(synced, "the surviving spelling").toContain("/home/me/vault/daily/NOTE.md");
    expect(synced, "the directory the rename changed").toContain("/home/me/vault/daily");
  });

  it("treats a file that has gone as flushed rather than as a failure, for ever (R6)", async () => {
    const INDEX = ".obsidian/plugins/trew/index.json";
    const state = { cursor: 1, entries: {}, remote: {}, pending: [] };
    const desktop = new DesktopAdapter();
    const { fs, synced } = fsOver(desktop);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    const store = new ObsidianIndexStore(desktop, INDEX);

    // Removed from under the vault: another program, or Obsidian's own
    // trash on a device where the person emptied it.
    await v.write("note.md", enc.encode("one"), times);
    await desktop.remove("note.md");

    // The engine's order, twice. A flush that keeps failing over a name
    // nothing can open never lets the save after it run again.
    await expect(v.flush!()).resolves.toBeUndefined();
    await store.save(state);
    await v.write("other.md", enc.encode("two"), times);
    await expect(
      v.flush!(),
      "the second flush still owed the missing file",
    ).resolves.toBeUndefined();
    await store.save({ ...state, cursor: 2 });

    expect(synced).toContain("/home/me/vault/other.md");
    expect(await new ObsidianIndexStore(desktop, INDEX).load()).toEqual({ ...state, cursor: 2 });
  });
});

/**
 * P-D6 in the 0.3.0 review, and the seeding beside it. The skip is what keeps a
 * settled vault from rewriting nine megabytes every thirty seconds, and it is
 * safe only while what it remembers is what is on disk.
 */
describe("the index write that is skipped because nothing changed (P-D6)", () => {
  const INDEX = ".obsidian/plugins/trew/index.json";
  const state = (cursor: number) => ({
    cursor,
    entries: { "note.md": { path: "note.md", hash: `h${cursor}` } },
    remote: {},
    pending: [],
  });

  it("writes again when the index has gone from under it", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // Removed from outside the session: a tidy-up script, a sync tool, a
    // person in a file manager.
    await adapter.remove(INDEX);
    await store.save(state(1));

    expect(await adapter.exists(INDEX), "the index stayed gone for the session").toBe(true);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("does not rewrite an index it has just read", async () => {
    await new ObsidianIndexStore(adapter, INDEX).save(state(1));

    // A restart. The first pass of a settled vault produces the state that
    // is already on disk, and writing it back is two fsyncs to record that
    // nothing happened.
    const store = new ObsidianIndexStore(adapter, INDEX);
    expect(await store.load()).toEqual(state(1));
    let writes = 0;
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      writes++;
      return realWrite(path, data, options);
    };
    await store.save(state(1));
    expect(writes, "an identical index was written again on the first pass").toBe(0);
  });

  it("writes again when the index has been overwritten in place (R3)", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // Still there, and no longer what was written: half an index, a
    // conflicted copy of one, a tidy-up script's idea of tidy. The file
    // exists, so existence alone said nothing was wrong and every later
    // unchanged pass kept it for the rest of the session.
    adapter.now += 1000;
    await adapter.write(INDEX, "{}");
    await store.save(state(1));

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("writes again when a shorter overwrite lands at the same instant (R3)", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // The clock does not move, so size is the half of the stamp that has to
    // notice this one.
    await adapter.write(INDEX, "!".repeat(JSON.stringify(state(1)).length - 1));
    await store.save(state(1));

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("writes again when a same-size overwrite lands a tick later (R3)", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // Exactly as long as what was written, so size says nothing and the
    // modification time is the half that has to notice. The named test above
    // only ever moved the size, so this half of the stamp was never exercised.
    //
    // The residual, which is not a bug this can catch: a same-size overwrite
    // inside one modification-time tick still skips. Narrow where the clock
    // is fine grained (APFS, ext4), real where it is not (HFS+ ticks once a
    // second, FAT once every two). Reading the index back on every settled
    // pass is the cost the skip exists to avoid, so the window stays.
    adapter.now += 1000;
    await adapter.write(INDEX, "!".repeat(JSON.stringify(state(1)).length));
    await store.save(state(1));

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });
});

/**
 * The plugin keeps an edit a stat cannot see (R01).
 *
 * The engine's guard before overwriting was the file's length and its rounded
 * modification time, and an ordinary correction is the same number of
 * characters, saved by an editor that carries the timestamp across. The
 * headless client answers this by moving the old bytes aside before writing;
 * Obsidian's adapter cannot do that, so it reads what it is about to replace
 * and compares the content.
 */
describe("writing over a file the pass did not decide about", () => {
  it("updates an open note without renaming its file or redirecting the editor", async () => {
    const path = "note.md";
    let openPath = path;
    adapter.seed(path, "original\n", 1000);
    // Obsidian follows the same TFile when the adapter emits a rename. This
    // used to send an open editor to the temporary conflict copy on every edit.
    adapter.afterRename = (from, to) => {
      if (openPath === from) openPath = to;
    };
    const out = await vault.replace(
      path,
      { contentId: await plainDigest(enc.encode("original\n")), idOf: plainDigest },
      enc.encode("incoming edit\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out).toEqual({ landed: true });
    expect(openPath).toBe(path);
    expect(adapter.text(openPath)).toBe("incoming edit\n");
    expect(adapter.filePaths()).toEqual([path]);
  });

  it("retains a complete local backup if an in-place text write is cut short", async () => {
    adapter.seed("note.md", "unsent local text\n", 1000);
    // A disk that stays full: the update is cut short, and so is every
    // attempt to put back what the note held.
    adapter.fault = (op, path) => (op === "write" && path === "note.md" ? 3 : undefined);
    await expect(
      vault.replace(
        "note.md",
        undefined,
        enc.encode("incoming text\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow(/could not be put back yet.*what it held is at note \(kept\)\.md/);
    expect(adapter.text("note.md")?.length).toBe(3);
    // The cut note is not handed to the engine, which would send it as an
    // edit (T09), and it is still listed, which a deletion would not be.
    await expect(vault.read("note.md")).rejects.toThrow(/cut short/);
    const listed = (await vault.list()).map((f) => f.path);
    expect(listed).toContain("note.md");
    // Listed before Obsidian's index has it, or it never syncs.
    expect(listed).toContain("note (kept).md");
    // Obsidian lists the whole disk as it opens a vault again.
    adapter.reopen();
    const restarted = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    expect((await restarted.list()).map((f) => f.path)).toContain("note (kept).md");
    expect(dec.decode(await restarted.read("note (kept).md"))).toBe("unsent local text\n");
  });

  /**
   * T09. `process` truncates and then writes, so a write that stops part way
   * leaves the start of the incoming text at the note's name. Read as an edit
   * by the next pass, it was sent to every device as the note's newest
   * version. What the note held goes back instead, with its own times, so the
   * next pass finds it unchanged and fetches the update again.
   */
  it("puts the note back when its in-place update is cut short", async () => {
    adapter.seed("note.md", "the synced text\n", 1000);
    let armed = true;
    adapter.fault = (op, path) => {
      if (armed && op === "write" && path === "note.md") {
        armed = false;
        return 3;
      }
      return undefined;
    };
    await expect(
      vault.replace(
        "note.md",
        { contentId: await plainDigest(enc.encode("the synced text\n")), idOf: plainDigest },
        enc.encode("the incoming text\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow(/ENOSPC.*What the note held was put back$/);
    expect(adapter.text("note.md")).toBe("the synced text\n");
    expect((await adapter.stat("note.md"))?.mtime).toBe(1000);
    // The server has that version, so its backup is a duplicate and goes.
    expect(adapter.text("note (kept).md")).toBeUndefined();
    expect(dec.decode(await vault.read("note.md"))).toBe("the synced text\n");

    // And the update lands when it is tried again.
    const out = await vault.replace(
      "note.md",
      { contentId: await plainDigest(enc.encode("the synced text\n")), idOf: plainDigest },
      enc.encode("the incoming text\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out).toEqual({ landed: true });
    expect(adapter.text("note.md")).toBe("the incoming text\n");
  });

  it("keeps the backup of what it put back when the server may not have it", async () => {
    adapter.seed("note.md", "an unsent edit\n", 1000);
    let armed = true;
    adapter.fault = (op, path) => {
      if (armed && op === "write" && path === "note.md") {
        armed = false;
        return 0;
      }
      return undefined;
    };
    await expect(
      vault.replace(
        "note.md",
        undefined,
        enc.encode("the incoming text\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow(/was put back, and is also at note \(kept\)\.md/);
    expect(adapter.text("note.md")).toBe("an unsent edit\n");
    expect(adapter.text("note (kept).md")).toBe("an unsent edit\n");
  });

  it("puts back a note cut inside a character", async () => {
    const before = "日本語のノート\n";
    adapter.seed("note.md", before, 1000);
    let armed = true;
    adapter.fault = (op, path) => {
      if (armed && op === "write" && path === "note.md") {
        armed = false;
        // Inside the second character: the adapter reads U+FFFD there.
        return 4;
      }
      return undefined;
    };
    await expect(
      vault.replace(
        "note.md",
        { contentId: await plainDigest(enc.encode(before)), idOf: plainDigest },
        enc.encode("日本語のノートと続き\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow(/was put back/);
    expect(adapter.text("note.md")).toBe(before);
  });

  it("leaves alone a save made after the cut, which is nobody's cut text", async () => {
    adapter.seed("note.md", "the synced text\n", 1000);
    let cut = false;
    adapter.fault = (op, path) => {
      if (!cut && op === "write" && path === "note.md") {
        cut = true;
        return 3;
      }
      // The editor saves between the cut and the put-back.
      if (cut && op === "read" && path === "note.md") {
        adapter.seed("note.md", "typed after the cut\n", 3000);
        adapter.fault = undefined;
      }
      return undefined;
    };
    await expect(
      vault.replace(
        "note.md",
        undefined,
        enc.encode("the incoming text\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow(/The previous content is at note \(kept\)\.md/);
    expect(adapter.text("note.md")).toBe("typed after the cut\n");
    expect(adapter.text("note (kept).md")).toBe("the synced text\n");
    // Not on record as cut short: the save is read and syncs.
    expect(dec.decode(await vault.read("note.md"))).toBe("typed after the cut\n");
  });

  it("puts the note back at the next listing when it cannot be at once, and reads it only then", async () => {
    adapter.seed("note.md", "the synced text\n", 1000);
    let cuts = 2;
    adapter.fault = (op, path) =>
      op === "write" && path === "note.md" && cuts-- > 0 ? 3 : undefined;
    await expect(
      vault.replace(
        "note.md",
        { contentId: await plainDigest(enc.encode("the synced text\n")), idOf: plainDigest },
        enc.encode("the incoming text\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow(/could not be put back yet/);
    await expect(vault.read("note.md")).rejects.toThrow(/cut short/);
    await expect(vault.contentDigest("note.md")).rejects.toThrow(/cut short/);

    // The disk has room again by the next pass.
    const listed = await vault.list();
    expect(listed.find((f) => f.path === "note.md")).toMatchObject({ size: 16, mtime: 1000 });
    expect(dec.decode(await vault.read("note.md"))).toBe("the synced text\n");
    expect(adapter.text("note (kept).md")).toBe("the synced text\n");
  });

  it("flushes the backup before truncation and the new note before removing the backup", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced } = recordingFs();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    desktop.seed("note.md", "original\n", 1000);
    const checkpoints: string[][] = [];
    desktop.fault = (op, path) => {
      if (
        (op === "write" && path === "note.md") ||
        (op === "remove" && path === "note (kept).md")
      ) {
        checkpoints.push([...synced]);
      }
      return undefined;
    };
    await v.replace(
      "note.md",
      { contentId: await plainDigest(enc.encode("original\n")), idOf: plainDigest },
      enc.encode("incoming\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toContain("/home/me/vault/note (kept).md");
    expect(checkpoints[0]).toContain("/home/me/vault");
    expect(checkpoints[0]).not.toContain("/home/me/vault/note.md");
    expect(checkpoints[1]).toContain("/home/me/vault/note.md");
  });

  it("keeps the original untouched if its backup cannot be flushed", async () => {
    const desktop = new DesktopAdapter();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs: {
        promises: {
          open: async () => {
            throw new Error("EIO: fsync");
          },
        },
      },
    });
    desktop.seed("note.md", "original\n", 1000);
    await expect(
      v.replace(
        "note.md",
        undefined,
        enc.encode("incoming\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      ),
    ).rejects.toThrow("EIO: fsync");
    expect(desktop.text("note.md")).toBe("original\n");
    expect(desktop.text("note (kept).md")).toBe("original\n");
    expect(desktop.calls.some((c) => c.op === "write" && c.path === "note.md")).toBe(false);
  });

  it("does not truncate a text file if its backup cannot be staged", async () => {
    adapter.seed("note.md", "unsent local text\n", 1000);
    adapter.fault = (op, path) =>
      op === "writeBinary" && path.includes(".trew-tmp-") ? 2 : undefined;
    const out = await vault.replace(
      "note.md",
      undefined,
      enc.encode("incoming text\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out).toEqual({ landed: false });
    expect(adapter.text("note.md")).toBe("unsent local text\n");
    expect(adapter.calls.some((c) => c.op === "write" && c.path === "note.md")).toBe(false);
  });

  it("compares against an editor save inside the text operation, even with matching stats", async () => {
    const before = "original\n";
    const edited = "changed!\n";
    adapter.seed("note.md", before, 1000);
    adapter.fault = (op, path) => {
      if (op === "read" && path === "note.md") {
        adapter.seed(path, edited, 1000);
        adapter.fault = undefined;
      }
      return undefined;
    };
    const out = await vault.replace(
      "note.md",
      { contentId: await plainDigest(enc.encode(before)), idOf: plainDigest },
      enc.encode("incoming\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out).toEqual({ landed: false });
    expect(adapter.text("note.md")).toBe(edited);
    // The backup held the version this was decided about, which the server
    // has: kept, it was a copy of what every device had, named as if it held
    // this device's words (T13).
    expect(adapter.text("note (kept).md")).toBeUndefined();
  });

  it("keeps the backup when a save races an update and the server may not have the text", async () => {
    const before = "an unsent edit\n";
    adapter.seed("note.md", before, 1000);
    adapter.fault = (op, path) => {
      if (op === "read" && path === "note.md") {
        adapter.seed(path, "saved again\n", 1000);
        adapter.fault = undefined;
      }
      return undefined;
    };
    const out = await vault.replace(
      "note.md",
      undefined,
      enc.encode("incoming\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out).toEqual({ keptAt: "note (kept).md", landed: false });
    expect(adapter.text("note.md")).toBe("saved again\n");
    expect(adapter.text("note (kept).md")).toBe(before);
  });

  it("preserves UTF-8 BOMs and CRLFs when updating an open text file", async () => {
    const before = "\uFEFF# café\r\n原文\r\n";
    const after = "\uFEFF# café\r\n原文 🪨\r\n";
    adapter.seed("note.md", before, 1000);
    const out = await vault.replace(
      "note.md",
      { contentId: await plainDigest(enc.encode(before)), idOf: plainDigest },
      enc.encode(after),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out).toEqual({ landed: true });
    expect(new Uint8Array(await adapter.readBinary("note.md"))).toEqual(enc.encode(after));
    expect(adapter.calls.some((c) => c.op === "rename" && c.path === "note.md")).toBe(false);
  });

  it("applies an intentional case-only rename while updating text", async () => {
    adapter.insensitive = true;
    adapter.seed("Note.md", "original\n", 1000);
    const out = await vault.replace(
      "NOTE.md",
      { contentId: await plainDigest(enc.encode("original\n")), idOf: plainDigest },
      enc.encode("incoming\n"),
      { mtime: 2000, ctime: 1000 },
      "NOTE (kept).md",
    );
    expect(out).toEqual({ landed: true });
    expect(adapter.filePaths()).toEqual(["NOTE.md"]);
    expect(adapter.text("NOTE.md")).toBe("incoming\n");
    expect(adapter.calls.filter((c) => c.op === "rename" && c.path === "Note.md")).toEqual([
      { op: "rename", path: "Note.md", to: "NOTE.md" },
    ]);
  });

  it("keeps invalid UTF-8 as bytes instead of passing it through text processing", async () => {
    const before = new Uint8Array([0xff, 0xfe, 0x80]);
    const after = new Uint8Array([0xfe, 0xff, 0x81]);
    await adapter.writeBinary("note.bin", before.buffer);
    const out = await vault.replace(
      "note.bin",
      { contentId: await plainDigest(before), idOf: plainDigest },
      after,
      { mtime: 2000, ctime: 1000 },
      "note (kept).bin",
    );
    expect(out).toEqual({ landed: true });
    expect(new Uint8Array(await adapter.readBinary("note.bin"))).toEqual(after);
    expect(adapter.calls.some((c) => c.op === "write" && c.path === "note.bin")).toBe(false);
  });

  it("keeps what it displaced at a path of its own, not in memory", async () => {
    const enc = new TextEncoder();
    await adapter.write("note.md", "the original line\n", { mtime: 1000 });

    const out = await vault.replace(
      "note.md",
      { contentId: "not-what-is-there", idOf: async () => "something-else" },
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );

    expect(out.keptAt, "the displaced version was not preserved anywhere").toBe("note (kept).md");
    // On the disk, which is the point: nothing has to remember to save it.
    expect(adapter.text("note (kept).md")).toBe("the original line\n");
    expect(adapter.text("note.md")).toBe("the server's version\n");
    expect(out.landed).toBe(true);
  });

  it("keeps nothing when it wrote over exactly what it expected", async () => {
    const enc = new TextEncoder();
    await adapter.write("note.md", "the original line\n", { mtime: 1000 });

    const out = await vault.replace(
      "note.md",
      { contentId: "the-one-we-expect", idOf: async () => "the-one-we-expect" },
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out.keptAt, "a file nobody had touched was preserved").toBeUndefined();
    expect(adapter.text("note.md")).toBe("the server's version\n");
    expect(adapter.text("note (kept).md"), "a needless copy was left behind").toBeUndefined();
  });

  /**
   * The gap R19 named: an edit landing after the adapter has looked and before
   * it writes. Moving the old bytes out first is what closes it, because
   * whatever is at the path when the rename happens is what comes out.
   */
  it("keeps an edit that lands while it is deciding", async () => {
    const enc = new TextEncoder();
    await adapter.write("note.md", "the original line\n", { mtime: 1000 });
    // The editor, between this adapter's first look and its write.
    adapter.beforeRename = async () => {
      adapter.beforeRename = undefined;
      await adapter.write("note.md", "the unsent edit\n", { mtime: 1000 });
    };

    const out = await vault.replace(
      "note.md",
      { contentId: "the-original", idOf: async () => "whatever-it-is" },
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );

    const everywhere = [adapter.text("note.md"), adapter.text(out.keptAt ?? "")].join("|");
    expect(everywhere, "the edit made during the write is gone").toContain("the unsent edit\n");
  });

  /**
   * R32. A preservation that fails is not a preservation that was unnecessary.
   *
   * Every failure of the rename-aside used to be read as "there was nothing
   * there", and the write went ahead. A rename refused for permissions or I/O
   * leaves the original exactly where it was, so the step that exists to
   * protect the note became the reason it was destroyed, and the call reported
   * `landed: true` with nothing preserved: the engine then recorded the
   * incoming version as synced over a note nobody has a copy of.
   */
  it("refuses to write when it could not move the original out of the way", async () => {
    await adapter.write("note.md", "the unsent edit\n", { mtime: 1000 });

    // Only the preservation move fails. Ordinary writes still work, which is
    // what separates this from a vault that is simply broken.
    adapter.fault = (op, _path, to) =>
      op === "rename" && to === "note (kept).md"
        ? new Error("EACCES: permission denied, rename")
        : undefined;

    const out = await vault.replace(
      "note.md",
      { contentId: "the-original", idOf: async () => "something else" },
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );

    expect(adapter.text("note.md"), "the unsent edit was written over").toBe("the unsent edit\n");
    expect(out.landed, "a write that never happened was reported as landed").toBe(false);
    expect(out.keptAt, "nothing was moved, so nothing was kept anywhere").toBeUndefined();
  });

  /**
   * And an adapter that cannot answer counts as occupied.
   *
   * The guard's distinct behaviour is here and nowhere else: when the rename
   * fails *and* `exists` throws, nothing has established absence, and absence
   * is the only answer that permits writing over the name. Neutering the guard
   * left every other test in this file passing, because `create` refuses the
   * occupied path anyway; this is the case where `create` would have gone
   * ahead, since the adapter cannot say the file is there.
   */
  it("refuses when it cannot even find out whether the original is still there", async () => {
    await adapter.write("note.md", "the unsent edit\n", { mtime: 1000 });

    adapter.fault = (op, path, to) => {
      if (op === "rename" && to === "note (kept).md") return new Error("EIO: rename");
      // And the question about the original cannot be answered either.
      if (op === "exists" && path === "note.md") return new Error("EIO: stat");
      return undefined;
    };

    const out = await vault.replace(
      "note.md",
      { contentId: "the-original", idOf: async () => "something else" },
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );

    adapter.fault = undefined;
    expect(out.landed, "a vault that could not answer was treated as an empty path").toBe(false);
    expect(adapter.text("note.md")).toBe("the unsent edit\n");
  });

  /**
   * R33. No baseline is not permission to overwrite.
   *
   * The engine has no baseline for a path it has not seen and none for one
   * whose content it could not read. Both used to reach the adapter as a plain
   * write, so a note created after the pass's last look at the path, which is
   * the only reason this mechanism exists, was destroyed by the download that
   * was queued while the name was free.
   */
  it("keeps a file that appears at a path it was told nothing about", async () => {
    adapter.beforeRename = async () => {
      adapter.beforeRename = undefined;
      await adapter.write("fresh.md", "unsent local\n", { mtime: 1000 });
    };

    const out = await vault.replace(
      "fresh.md",
      undefined,
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "fresh (kept).md",
    );

    expect(out.keptAt, "a file created after the pass looked was overwritten").toBe(
      "fresh (kept).md",
    );
    expect(adapter.text("fresh (kept).md")).toBe("unsent local\n");
    expect(adapter.text("fresh.md")).toBe("the server's version\n");
  });

  it("writes straight into a path that really is free", async () => {
    const out = await vault.replace(
      "brand-new.md",
      undefined,
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "brand-new (kept).md",
    );
    expect(out).toEqual({ landed: true });
    expect(adapter.text("brand-new.md")).toBe("the server's version\n");
    expect(adapter.text("brand-new (kept).md")).toBeUndefined();
  });

  /**
   * R32, the half the first fix left open: publication must not truncate.
   *
   * After the move aside the name is free, so anything at it is somebody
   * else's save. `write` was the wrong tool for that: `writeThroughStaging`
   * asks whether the destination exists and takes a `writeBinary` when it
   * does, which is right for replacing a note in place and destroys a
   * competitor here.
   *
   * `create` renames the staged copy into place instead, and rename refuses an
   * occupied destination in both of Obsidian's adapters (see the note on
   * `FakeAdapter.rename`, read out of the shipped `.asar`).
   *
   * The hook is `afterRename`, not `beforeRename`: the latter is awaited, so a
   * competitor queued from it lands *before* the move and is preserved by it,
   * which is the opposite of the schedule this is about.
   *
   * An attachment, because only a file that is not text is moved aside: a
   * note's update is written in place (R083-18), and this test, written for a
   * note, had been exercising that path instead without saying so.
   */
  it("keeps a save that takes the name after the move aside", async () => {
    const was = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const saved = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
    await adapter.writeBinary("photo.jpg", was.slice().buffer, { mtime: 1000 });

    adapter.afterRename = async (_from, to) => {
      if (to !== "photo (kept).jpg") return;
      adapter.afterRename = undefined;
      await adapter.writeBinary("photo.jpg", saved.slice().buffer, { mtime: 1000 });
    };

    const out = await vault.replace(
      "photo.jpg",
      { contentId: await plainDigest(was), idOf: plainDigest },
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]),
      { mtime: 2000, ctime: 1000 },
      "photo (kept).jpg",
    );

    expect(
      [...new Uint8Array(await adapter.readBinary("photo.jpg"))],
      "the save that took the name was written over by the incoming version",
    ).toEqual([...saved]);
    expect(out.landed, "a write that lost the name was reported as landed").toBe(false);
    // And the version it displaced is still where it was put, because the
    // write it was displaced for never happened.
    expect([...new Uint8Array(await adapter.readBinary("photo (kept).jpg"))]).toEqual([...was]);
    expect(out.keptAt).toBe("photo (kept).jpg");
  });

  it("says what a removal took away when it was not the expected version", async () => {
    await adapter.write("gone.md", "the edit nobody sent\n", { mtime: 1000 });

    const out = await vault.removeExpecting(
      "gone.md",
      {
        contentId: "the version the pass decided about",
        idOf: async () => "something else entirely",
      },
      "gone (kept).md",
    );
    expect(out.keptAt, "the removal did not preserve what it took").toBe("gone (kept).md");
    expect(adapter.text("gone (kept).md")).toBe("the edit nobody sent\n");
  });
});
