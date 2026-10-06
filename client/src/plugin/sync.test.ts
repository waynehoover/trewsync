import { receiveCommitted } from "../core/test-async.ts";
/**
 * Two Obsidian vaults, through a real server.
 *
 * The engine tests do this with in-memory vaults, which is what makes them fast
 * enough to run a mutation pass over. The CLI test does it with real directories
 * on a disk. This is the third adapter, and until this file existed nothing had
 * ever run the engine against Obsidian's interface at all.
 *
 * Everything here is real except Obsidian: real chunking, real framing, a real
 * WebSocket, a real Go server writing real SQLite. What is faked is
 * `DataAdapter`, and `fake.ts` says what that is worth and what it is not.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { MemoryIndexStore, MemoryVault } from "../core/vault.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/** One device: a fake Obsidian vault, and the same Client both shells use. */
class Device {
  readonly adapter = new FakeAdapter();
  client!: Client;

  constructor(readonly name: string) {}

  async connect(server: TestServer): Promise<void> {
    this.client = new Client({
      vault: new ObsidianVault(asVault(new FakeVaultIndex(this.adapter)), ".obsidian"),
      // Where the plugin puts it: inside its own folder, under
      // `.obsidian`, which never syncs.
      store: new ObsidianIndexStore(this.adapter, ".obsidian/plugins/trew/index.json"),
      url: server.wsUrl,
      ...(await server.deviceCredentials(this.name)),
      vaultId: "default",
      device: this.name,
      timeoutMs: 20_000,
      // These tests drive discrete syncs, so there is no next pass for the
      // write debounce to defer to. The plugin leaves it on, because a
      // plugin does have one.
      coalesceWrites: false,
    });
    await this.client.connect();
  }

  close(): void {
    this.client?.close();
  }

  /** Everything a person would see in the vault, ignoring the plugin's own state. */
  notes(): string[] {
    return this.adapter
      .filePaths()
      .filter((p) => !p.startsWith(".obsidian/") && !p.startsWith(".trash/"));
  }

  text(path: string): string | undefined {
    return this.adapter.text(path);
  }
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

let server: TestServer;
const devices: Device[] = [];

async function fresh(): Promise<void> {
  server = new TestServer();
  await server.start();
}

async function device(name: string): Promise<Device> {
  const d = new Device(name);
  devices.push(d);
  await d.connect(server);
  return d;
}

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  if (server) await server.cleanup();
});

/** Syncs both until each has seen the other's work. */
async function converge(a: Device, b: Device, rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await a.client.settle();
    await receiveCommitted(b.client.transport);
    await b.client.settle();
    await receiveCommitted(a.client.transport);
  }
}

describe("a vault reaching another device", () => {
  it("keeps the same note open on both devices across alternating edits", async () => {
    await fresh();
    const mac = await device("Mac");
    const phone = await device("Phone");
    mac.adapter.seed("note.md", "initial\n", 1000);
    await converge(mac, phone);

    const openPaths = new Map([
      [mac, "note.md"],
      [phone, "note.md"],
    ]);
    const renames: Promise<void>[] = [];
    for (const d of [mac, phone]) {
      d.adapter.afterRename = (from, to) => {
        if (openPaths.get(d) === from) openPaths.set(d, to);
        // The plugin forwards Obsidian's rename events to the client. The
        // previous fake never did, hiding the identity change from the engine.
        renames.push(d.client.noteRename(from, to));
      };
    }
    for (let i = 0; i < 6; i++) {
      const writer = i % 2 === 0 ? mac : phone;
      const text = `edited on ${writer.name}, turn ${i}\n`;
      writer.adapter.seed(openPaths.get(writer)!, text, 2000 + i * 1000);
      await converge(mac, phone);
      await Promise.all(renames);
      for (const d of [mac, phone]) {
        expect(openPaths.get(d), `${d.name}'s open note moved`).toBe("note.md");
        expect(d.notes()).toEqual(["note.md"]);
        expect(d.text("note.md")).toBe(text);
      }
    }
  });

  it("carries notes, folders and an attachment", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    a.adapter.seed("Meeting notes.md", "# Meeting\n\nDiscussed the thing.\n");
    a.adapter.seed("Projects/TrewSync.md", "# TrewSync\n\nA sync tool.\n");
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
    await a.adapter.writeBinary("attachment.bin", bytes.slice().buffer as ArrayBuffer, {
      mtime: 1000,
    });

    await converge(a, b);

    expect(b.notes().sort()).toEqual([
      "Meeting notes.md",
      "Projects/TrewSync.md",
      "attachment.bin",
    ]);
    expect(b.text("Meeting notes.md")).toBe("# Meeting\n\nDiscussed the thing.\n");
    expect(b.text("Projects/TrewSync.md")).toBe("# TrewSync\n\nA sync tool.\n");
    expect([...new Uint8Array(await b.adapter.readBinary("attachment.bin"))]).toEqual([...bytes]);
    // And the folder came too, so an empty one would as well.
    expect(await b.adapter.exists("Projects")).toBe(true);
  }, 300_000);

  /**
   * The bug this whole file was written to find, end to end.
   *
   * `normalizePath` rewrites a non-breaking space, and the first version of
   * the adapter dropped such a note from its listing without a word. It would
   * never have synced.
   */
  it("carries a note whose name Obsidian would rewrite", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    a.adapter.seed("Q1 review.md", "the note with a non-breaking space");
    a.adapter.seed("ordinary.md", "the other one");
    await converge(a, b);

    expect(b.notes().length, "a note went missing on the way").toBe(2);
    const carried = b.notes().find((p) => p !== "ordinary.md")!;
    expect(b.text(carried)).toBe("the note with a non-breaking space");
  }, 300_000);

  it("never sends what must never sync", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    a.adapter.seed(".obsidian/workspace.json", "{}");
    a.adapter.seed(".obsidian/plugins/other/main.js", "// not yours");
    a.adapter.seed("real.md", "x");
    await converge(a, b);

    // One device disabling every plugin on another is where that rule came
    // from, and the index living under .obsidian is why it matters here.
    expect(b.notes()).toEqual(["real.md"]);
    expect(await b.adapter.exists(".obsidian/workspace.json")).toBe(false);
  }, 300_000);

  it("carries an edit back the other way", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    a.adapter.seed("note.md", "first\n");
    await converge(a, b);
    expect(b.text("note.md")).toBe("first\n");

    b.adapter.seed("note.md", "second\n", 2_000_000);
    await converge(a, b);
    expect(a.text("note.md")).toBe("second\n");
  }, 300_000);

  /**
   * A deletion arriving over the wire goes to the trash rather than away. It
   * was somebody's decision on another device, possibly a mistaken one.
   */
  it("carries a deletion, into the trash", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    a.adapter.seed("doomed.md", "here for now\n");
    await converge(a, b);
    expect(b.text("doomed.md")).toBe("here for now\n");

    await a.adapter.remove("doomed.md");
    await converge(a, b);

    expect(b.notes()).not.toContain("doomed.md");
    // Under the name it had. A trash keeps a basename and drops every folder
    // above it, so the move that takes the note out of the way before it is
    // identified has to be into a folder rather than under a new name (R22):
    // renamed, it reaches the trash as `.trew-tmp-9f2c-doomed.md`, which is
    // not what somebody looking for the note they deleted searches for.
    expect(b.adapter.trashedLocally.map(basename)).toContain("doomed.md");
    // Recoverable by hand, and not syncing back out to undo the deletion
    // everywhere else.
    expect(b.adapter.text(".trash/doomed.md")).toBe("here for now\n");
    // And nothing of that move is left behind.
    expect(b.adapter.everything().filter((p) => p.includes(".trew-tmp-"))).toEqual([]);
  }, 300_000);

  it("merges edits to different parts of one note", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    a.adapter.seed("note.md", base);
    await converge(a, b);

    a.adapter.seed(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
      2_000_000,
    );
    b.adapter.seed(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
      2_000_000,
    );
    await converge(a, b, 6);

    for (const d of [a, b]) {
      const text = d.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
    }
  }, 300_000);

  /**
   * Rule 10: the property is not that the two devices agree, it is that
   * neither edit was lost. Both are asserted by name.
   */
  it("keeps both versions when the same line was rewritten twice", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    a.adapter.seed("note.md", "# Note\n\nThe original sentence.\n");
    await converge(a, b);

    a.adapter.seed("note.md", "# Note\n\nA's completely different sentence.\n", 2_000_000);
    b.adapter.seed("note.md", "# Note\n\nB's entirely other sentence.\n", 2_000_000);
    await converge(a, b, 6);

    for (const d of [a, b]) {
      const all = d
        .notes()
        .map((p) => d.text(p))
        .join("\n---\n");
      expect(all, `${d.name} lost A's version`).toContain("A's completely different sentence");
      expect(all, `${d.name} lost B's version`).toContain("B's entirely other sentence");
      expect(
        d.notes().some((p) => p.includes("Conflicted copy")),
        `${d.name} has no copy`,
      ).toBe(true);
    }
  }, 300_000);

  it("does not upload back what it just downloaded", async () => {
    // The adapter sets the mtime it was given for exactly this reason. A
    // file stamped with the moment it landed looks locally edited on the
    // next pass, and the two devices push it back and forth forever.
    await fresh();
    const a = await device("a");
    const b = await device("b");

    a.adapter.seed("note.md", "settled\n");
    await converge(a, b);

    const quiet = await b.client.settle();
    expect(quiet.uploaded).toBe(0);
    expect(quiet.downloaded).toBe(0);
    expect(quiet.chunksSent).toBe(0);
  }, 300_000);
});

/**
 * A note written on one device has to appear on the other without waiting for a
 * timer.
 *
 * Accepting a batch records what the server holds; it does not fetch it. The
 * fetch used to wait for the next thirty-second tick, so two devices that were
 * both connected and idle could be half a minute apart. Measured on a real
 * phone before this: 0.2 s, 9.2 s, 14.2 s, and one that had still not arrived
 * after thirty seconds.
 *
 * Nothing here calls sync on b after it has settled. Only the batch arriving can
 * produce the file.
 */
describe("how soon the other device sees it", () => {
  it("fetches what a batch named, without being asked again", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    await b.client.settle();

    const text = "# Written on a\n\nand never fetched by hand on b\n";
    await a.adapter.write("live.md", text);
    await a.client.settle();

    const deadline = Date.now() + 10_000;
    while (b.text("live.md") === undefined) {
      if (Date.now() > deadline) throw new Error("b never fetched what the server told it about");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(b.text("live.md")).toBe(text);
  }, 60_000);
});

/** Obsidian's index does not hold dot-prefixed files or folders; model that. */
class HidingIndex extends FakeVaultIndex {
  override getAllLoadedFiles() {
    return super
      .getAllLoadedFiles()
      .filter((f) => !f.path.split("/").some((p) => p.startsWith(".")));
  }
}

/**
 * The plugin's listing comes from Obsidian's index, which
 * omits every dot-prefixed path, and the filter on the way in refused only
 * five names. A peer's `.gitignore` was written here, never listed, reported
 * deleted on the next pass, and the peer trashed its only copy.
 */
describe("a dotfile a headless peer holds", () => {
  it("is neither written here nor deleted there", async () => {
    await fresh();
    // The headless client lists everything the way NodeVault does.
    const cliVault = new MemoryVault();
    await cliVault.edit(".gitignore", "node_modules\n");
    await cliVault.edit("note.md", "hello\n");
    const cli = new Client({
      vault: cliVault,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      ...(await server.deviceCredentials("cli")),
      vaultId: "default",
      device: "cli",
      timeoutMs: 20_000,
      coalesceWrites: false,
    });
    await cli.connect();

    const adapter = new FakeAdapter();
    const plugin = new Client({
      vault: new ObsidianVault(asVault(new HidingIndex(adapter)), ".obsidian"),
      store: new ObsidianIndexStore(adapter, ".obsidian/plugins/trew/index.json"),
      url: server.wsUrl,
      ...(await server.deviceCredentials("phone")),
      vaultId: "default",
      device: "phone",
      timeoutMs: 20_000,
      coalesceWrites: false,
    });
    await plugin.connect();
    try {
      for (let i = 0; i < 5; i++) {
        await cli.settle();
        await receiveCommitted(plugin.transport);
        await plugin.settle();
        await receiveCommitted(cli.transport);
      }
      // Rule 10: the property is that the peer keeps its file and this side
      // never held it, not that the two agree.
      expect(cliVault.text(".gitignore"), "the peer lost its dotfile").toBe("node_modules\n");
      expect(
        adapter.text(".gitignore"),
        "the plugin wrote a path it can never list",
      ).toBeUndefined();
      expect(adapter.text("note.md")).toBe("hello\n");
    } finally {
      await cli.close();
      await plugin.close();
    }
  }, 120_000);
});

/**
 * Two devices that were both left called the same thing, conflicting.
 *
 * The conflict copy carries the device name, so two devices with one name
 * produce two copies wanting one filename. `firstFreeName` numbers the second,
 * and the property that matters is that both edits survive under distinct
 * names, whatever they are called.
 */
describe("two devices with the same name (device-name collision)", () => {
  it("keep both edits under distinct conflict copies", async () => {
    await fresh();
    const a = await device("laptop");
    const b = await device("laptop");
    a.adapter.seed("note.md", "# Note\n\nThe original sentence.\n");
    await converge(a, b);

    a.adapter.seed("note.md", "# Note\n\nA's completely different sentence.\n", 2_000_000);
    b.adapter.seed("note.md", "# Note\n\nB's entirely other sentence.\n", 2_000_000);
    await converge(a, b, 6);

    for (const d of [a, b]) {
      const copies = d.notes().filter((p) => p.includes("Conflicted copy"));
      expect(copies.length, `${d.name} has ${JSON.stringify(d.notes())}`).toBeGreaterThan(0);
      expect(new Set(copies).size).toBe(copies.length);
      const all = d
        .notes()
        .map((p) => d.text(p))
        .join("\n---\n");
      expect(all, `${d.name} lost A's version`).toContain("A's completely different sentence");
      expect(all, `${d.name} lost B's version`).toContain("B's entirely other sentence");
    }
  }, 300_000);
});

/**
 * through the plugin's adapter. A restore chose its name with
 * `exists` and then wrote with a replacing write, so a file appearing in the
 * gap was replaced by the restore.
 */
describe("a restore whose name is taken in the gap", () => {
  it("goes under the next free name rather than over what appeared", async () => {
    await fresh();
    const a = await device("a");
    a.adapter.seed("note.md", "first\n");
    await a.client.settle();
    a.adapter.seed("note.md", "second\n", 2_000_000);
    await a.client.settle();

    const versions = await a.client.history("note.md", { limit: 10 });
    const oldest = versions[versions.length - 1]!;
    // Somebody writes the very name the restore is about to claim.
    const raced: string[] = [];
    a.adapter.fault = (op, _path, to) => {
      if (op === "rename" && to !== undefined && to.includes("(restored") && raced.length === 0) {
        raced.push(to);
        a.adapter.seed(to, `somebody else's ${to}\n`);
      }
      return undefined;
    };
    const { path } = await a.client.restore(oldest);
    expect(raced.length).toBeGreaterThan(0);
    for (const taken of raced) expect(a.text(taken)).toBe(`somebody else's ${taken}\n`);
    expect(path).not.toBe(raced[0]);
    expect(a.text(path)).toBe("first\n");
    expect(a.text("note.md")).toBe("second\n");
  }, 300_000);
});

const enc = new TextEncoder();

/** Bytes that are not text and do not repeat, as a photo's are not. */
function photoBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    out[i] = x >>> 24;
  }
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  return out;
}

async function holds(d: Device, path: string, bytes: Uint8Array): Promise<boolean> {
  if (!(await d.adapter.exists(path))) return false;
  const now = new Uint8Array(await d.adapter.readBinary(path));
  return now.length === bytes.length && now.every((b, i) => b === bytes[i]);
}

async function arrives(d: Device, path: string, bytes: Uint8Array): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!(await holds(d, path, bytes))) {
    if (Date.now() > deadline) throw new Error(`${d.name} never received ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every version `d` put on the server under these paths after `after`. */
async function writtenBy(d: Device, paths: readonly string[], after = 0): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    for (const v of await d.client.history(path, { limit: 50 })) {
      if (v.device !== d.name || v.uid <= after) continue;
      out.push(`${v.deleted ? "deleted" : "wrote"} ${path} as ${v.uid}`);
    }
  }
  return out;
}

/** Every deletion the server holds for these paths, whoever made it. */
async function deletions(d: Device, paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    for (const v of await d.client.history(path, { limit: 50 })) {
      if (v.deleted) out.push(`${path} by ${v.device} as ${v.uid}`);
    }
  }
  return out;
}

/**
 * A device that only receives, while Obsidian's index is behind its disk.
 *
 * A file the plugin lands by renaming a staged copy into place is missing from
 * `getAllLoadedFiles` until the filesystem watcher reports it, because the
 * adapter's `rename` has no record of a hidden source to move (`fake.ts`,
 * `unindexed`). The M3 acceptance run on 2026-09-23 found what a pass inside
 * that window did: a Mac receiving a photo from a phone read the photo it had
 * just downloaded as deleted, committed the deletion, and uploaded the same
 * bytes as new a few milliseconds later. The phone put its copy in the trash.
 * Had the upload failed, every device would have lost the file.
 *
 * The property asserted is the one that matters (rule 10): the receiver
 * writes nothing to the server, nobody deletes anything, and both devices end
 * with the bytes that were sent.
 */
describe("a device that only receives, while Obsidian's index catches up", () => {
  /**
   * `path` reaches the receiver, and its index, as `first`. Then `second`
   * arrives while the index is behind, and the receiver passes again before
   * the watcher reports what the download landed.
   */
  async function replacedWhileTheIndexLags(
    sender: Device,
    receiver: Device,
    path: string,
    first: { bytes: Uint8Array; mtime: number },
    second: { bytes: Uint8Array; mtime: number },
  ): Promise<void> {
    const put = (v: { bytes: Uint8Array; mtime: number }) =>
      sender.adapter.writeBinary(path, v.bytes.slice().buffer, { mtime: v.mtime, ctime: v.mtime });
    await put(first);
    await sender.client.settle();
    await receiveCommitted(receiver.client.transport);
    await arrives(receiver, path, first.bytes);
    // Long enough for the fake's watcher, which reports on the next turn.
    await new Promise((r) => setTimeout(r, 50));
    await receiver.client.settle();

    receiver.adapter.holdWatcher();
    await put(second);
    await sender.client.settle();
    await receiveCommitted(receiver.client.transport);
    // The download, and a pass after it while the index is still behind.
    await receiver.client.settle();
    await arrives(receiver, path, second.bytes);
    await receiver.client.settle();
    receiver.adapter.releaseWatcher();
    await converge(sender, receiver);
  }

  async function nothingWasLost(
    sender: Device,
    receiver: Device,
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    expect(await writtenBy(receiver, [path]), "the receiver wrote to the server").toEqual([]);
    expect(await deletions(sender, [path]), "a deletion nobody asked for").toEqual([]);
    expect(await holds(receiver, path, bytes), "the receiver's copy").toBe(true);
    expect(await holds(sender, path, bytes), "the sender's copy").toBe(true);
    expect(sender.adapter.trashedLocally, "the sender trashed its copy").toEqual([]);
    expect(receiver.notes()).toEqual([path]);
  }

  it("keeps a photo that arrived empty and then whole, with an older mtime", async () => {
    await fresh();
    const phone = await device("android");
    const mac = await device("Mac");
    await converge(phone, mac);
    // The incident's own shape: first seen while the program writing it had
    // written nothing, then whole, stamped with the source file's older mtime.
    const jpeg = photoBytes(377_520, 5);
    await replacedWhileTheIndexLags(
      phone,
      mac,
      "m3-photo.jpg",
      { bytes: new Uint8Array(0), mtime: 1_790_192_360_000 },
      { bytes: jpeg, mtime: 1_790_192_356_000 },
    );
    await nothingWasLost(phone, mac, "m3-photo.jpg", jpeg);
  }, 300_000);

  it("keeps a new note it received in the same pass as an edit to another", async () => {
    await fresh();
    const phone = await device("android-a1c2");
    const mac = await device("Mac");
    const edited = "From the Mac.md";
    const copy = "From the Mac (Conflicted copy Mac 202609230941).md";
    const v1 = "# From the Mac\n\nWritten on the Mac.\n";
    const v2 = "# From the Mac\n\nWritten on the Mac, and edited on the phone.\n";
    mac.adapter.seed(edited, v1, 1_790_192_400_000);
    await converge(mac, phone);
    expect(phone.text(edited)).toBe(v1);
    const [authored] = await mac.client.history(edited, { limit: 1 });

    // The phone kept the Mac's version under a conflict name, named after the
    // Mac whose words it holds, whose bytes are the ones the Mac already has
    // for the other note, and edited that note.
    mac.adapter.holdWatcher();
    phone.adapter.seed(copy, v1, 1_790_192_410_000);
    phone.adapter.seed(edited, v2, 1_790_192_420_000);
    await phone.client.settle();
    await receiveCommitted(mac.client.transport);
    await mac.client.settle();
    await arrives(mac, copy, enc.encode(v1));
    await arrives(mac, edited, enc.encode(v2));
    await mac.client.settle();
    mac.adapter.releaseWatcher();
    await converge(phone, mac);

    expect(await writtenBy(mac, [copy, edited], authored!.uid)).toEqual([]);
    expect(await deletions(phone, [copy, edited])).toEqual([]);
    for (const d of [phone, mac]) {
      expect(d.text(copy), `${d.name}'s copy`).toBe(v1);
      expect(d.text(edited), `${d.name}'s note`).toBe(v2);
      expect(d.notes().sort(), d.name).toEqual([copy, edited].sort());
    }
    expect(phone.adapter.trashedLocally).toEqual([]);
  }, 300_000);

  it("keeps a note written over an empty one", async () => {
    await fresh();
    const phone = await device("phone");
    const mac = await device("Mac");
    const words = enc.encode("Now it has words.\n");
    await replacedWhileTheIndexLags(
      phone,
      mac,
      "empty.md",
      { bytes: new Uint8Array(0), mtime: 2_000_000 },
      { bytes: words, mtime: 3_000_000 },
    );
    await nothingWasLost(phone, mac, "empty.md", words);
  }, 300_000);

  it("keeps an attachment written over an earlier one", async () => {
    await fresh();
    const phone = await device("phone");
    const mac = await device("Mac");
    const after = photoBytes(60_000, 2);
    await replacedWhileTheIndexLags(
      phone,
      mac,
      "diagram.png",
      { bytes: photoBytes(50_000, 1), mtime: 2_000_000 },
      { bytes: after, mtime: 3_000_000 },
    );
    await nothingWasLost(phone, mac, "diagram.png", after);
  }, 300_000);

  it("keeps a note whose new version is stamped older than the one it replaces", async () => {
    await fresh();
    const phone = await device("phone");
    const mac = await device("Mac");
    const older = enc.encode("# Restored\n\nThe version with the older stamp.\n");
    await replacedWhileTheIndexLags(
      phone,
      mac,
      "stamped.md",
      { bytes: enc.encode("# Restored\n\nThe newer stamp.\n"), mtime: 5_000_000 },
      { bytes: older, mtime: 4_000_000 },
    );
    await nothingWasLost(phone, mac, "stamped.md", older);
  }, 300_000);

  it("keeps an attachment too large to hold in memory while it is compared", async () => {
    // Above the engine's KEEP_BODIES_BELOW of 8 MiB, where a body is not
    // kept whole for reuse and the landing is the same staged rename.
    await fresh();
    const phone = await device("phone");
    const mac = await device("Mac");
    const before = photoBytes(9 * 1024 * 1024, 3);
    const after = before.slice();
    after.set(photoBytes(64 * 1024, 4), 4 * 1024 * 1024);
    await replacedWhileTheIndexLags(
      phone,
      mac,
      "recording.m4a",
      { bytes: before, mtime: 2_000_000 },
      { bytes: after, mtime: 3_000_000 },
    );
    await nothingWasLost(phone, mac, "recording.m4a", after);
  }, 300_000);
});

/**
 * A synced file another program deletes and writes again, while Obsidian's
 * watcher has reported the delete and not the write.
 *
 * The index has lost the name and the disk has the file. The engine checks
 * every synced name missing from a listing with `exists` and asks the vault
 * to list those from the disk before anything is treated as deleted, and the
 * plugin used to answer from the same index. So a camera app saving a photo
 * again, or a sync tool replacing one, could send a deletion to every device.
 */
describe("a synced file another program writes again while Obsidian's index is behind", () => {
  it("sends the new bytes, keeps the unchanged one, and deletes nothing", async () => {
    await fresh();
    const phone = await device("phone");
    const mac = await device("Mac");
    const before = photoBytes(40_000, 7);
    const unchanged = photoBytes(30_000, 8);
    await phone.adapter.writeBinary("camera.jpg", before.slice().buffer, { mtime: 2_000_000 });
    await phone.adapter.writeBinary("kept.jpg", unchanged.slice().buffer, { mtime: 2_000_000 });
    await converge(phone, mac);
    expect(await holds(mac, "kept.jpg", unchanged)).toBe(true);

    // Two, because the engine asks about every missing name before it lists
    // again, and a second one missed would be deleted all the same.
    mac.adapter.holdWatcher();
    const after = photoBytes(45_000, 9);
    mac.adapter.writeUnreported("camera.jpg", after, 3_000_000);
    mac.adapter.writeUnreported("kept.jpg", unchanged, 2_000_000);
    await mac.client.settle();
    mac.adapter.releaseWatcher();
    await converge(phone, mac);

    expect(await deletions(phone, ["camera.jpg", "kept.jpg"])).toEqual([]);
    expect(await writtenBy(mac, ["kept.jpg"]), "an unchanged file went up again").toEqual([]);
    const [latest] = await phone.client.history("camera.jpg", { limit: 1 });
    expect(latest).toMatchObject({ device: "Mac", deleted: false, size: after.length });
    for (const d of [phone, mac]) {
      expect(await holds(d, "camera.jpg", after), `${d.name}'s camera.jpg`).toBe(true);
      expect(await holds(d, "kept.jpg", unchanged), `${d.name}'s kept.jpg`).toBe(true);
      expect(d.notes().sort(), d.name).toEqual(["camera.jpg", "kept.jpg"]);
    }
    expect(phone.adapter.trashedLocally).toEqual([]);
  }, 300_000);
});

/**
 * An edit that keeps a synced file's length and timestamp, made by something
 * that is not Obsidian (rule 3).
 *
 * The plugin's listing carries no change id, so a scan decides whether to read
 * a file again from its length and timestamp alone, and `rsync -t`, a restore
 * from a backup, or a tool that puts the stamp back leaves both as they were.
 * The pass then believes the file is the version it last synced. The download
 * that followed took its expectation from the bytes on the disk at that
 * moment, which were the edit, so the preserving write found what it displaced
 * "expected" and removed it with `adapter.remove`, outside the trash; a
 * deletion trashed it and reported an ordinary deletion. The edit was then on
 * no device and in no place anybody would look.
 */
describe("an edit its stat could not see, under an incoming version", () => {
  async function invisiblyEdit(d: Device, path: string, bytes: Uint8Array): Promise<void> {
    const was = await d.adapter.stat(path);
    expect(was?.size, "the edit has to keep the length").toBe(bytes.length);
    await d.adapter.writeBinary(path, bytes.slice().buffer as ArrayBuffer, {
      mtime: was!.mtime,
      ctime: was!.ctime,
    });
  }

  /** Every path a person can see in this vault that holds exactly these bytes. */
  async function visiblyHeld(d: Device, bytes: Uint8Array): Promise<string[]> {
    const out: string[] = [];
    for (const p of d.notes()) if (await holds(d, p, bytes)) out.push(p);
    return out;
  }

  it("keeps a text edit a download would have written over", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    a.adapter.seed("note.md", "the synced line\n", 1000);
    await converge(a, b);
    expect(b.text("note.md")).toBe("the synced line\n");

    const edit = new TextEncoder().encode("the SYNCED line\n");
    await invisiblyEdit(b, "note.md", edit);
    a.adapter.seed("note.md", "a newer version from a\n", 2_000_000);
    await converge(a, b);

    expect(b.text("note.md")).toBe("a newer version from a\n");
    expect(
      await visiblyHeld(b, edit),
      `the edit is gone. b holds ${JSON.stringify(b.adapter.filePaths())}`,
    ).not.toEqual([]);
  }, 300_000);

  it("keeps a binary edit a download would have written over", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    const synced = photoBytes(20_000, 3);
    await a.adapter.writeBinary("photo.jpg", synced.slice().buffer as ArrayBuffer, {
      mtime: 1000,
    });
    await converge(a, b);
    expect(await holds(b, "photo.jpg", synced)).toBe(true);

    const edit = photoBytes(20_000, 4);
    await invisiblyEdit(b, "photo.jpg", edit);
    const newer = photoBytes(21_000, 5);
    await a.adapter.writeBinary("photo.jpg", newer.slice().buffer as ArrayBuffer, {
      mtime: 2_000_000,
    });
    await converge(a, b);

    expect(await holds(b, "photo.jpg", newer)).toBe(true);
    expect(
      await visiblyHeld(b, edit),
      `the edit is gone. b holds ${JSON.stringify(b.adapter.filePaths())}`,
    ).not.toEqual([]);
  }, 300_000);

  it("keeps an edit a deletion would have trashed as an ordinary deletion", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    a.adapter.seed("doomed.md", "the synced line\n", 1000);
    await converge(a, b);
    expect(b.text("doomed.md")).toBe("the synced line\n");

    const edit = new TextEncoder().encode("the SYNCED line\n");
    await invisiblyEdit(b, "doomed.md", edit);
    await a.adapter.remove("doomed.md");
    await converge(a, b);

    expect(
      await visiblyHeld(b, edit),
      `the edit is only in the trash, or nowhere. b holds ${JSON.stringify(b.adapter.filePaths())}`,
    ).not.toEqual([]);
    expect(b.adapter.trashedLocally).toEqual([]);
  }, 300_000);
});

/**
 * T09. A text update is written in place, through `process`, which truncates
 * the note and then writes it. A disk that fills in between leaves the note
 * cut short, and nothing said the short note was this device's own failed
 * write: the next pass took it for an edit, kept it at the note's name and
 * sent it to every device as the note's newest version (a 410-byte note was
 * fifteen bytes everywhere). The full text survived only in history and in
 * conflict copies.
 */
describe("an incoming update cut short as it is written in place", () => {
  it("never sends the cut note anywhere, and keeps the note whole on both devices", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    const lines =
      Array.from({ length: 20 }, (_, i) => `line ${i + 1} of the note`).join("\n") + "\n";
    a.adapter.seed("n.md", lines, 1_700_000_000_000);
    await converge(a, b);
    expect(b.text("n.md")).toBe(lines);

    const next = `${lines}line 21 added on a\n`;
    a.adapter.seed("n.md", next, 1_700_000_100_000);
    let armed = true;
    b.adapter.fault = (op, path) => {
      if (armed && op === "write" && path === "n.md") {
        armed = false;
        // Fifteen bytes land, then the disk is full.
        return 15;
      }
      return undefined;
    };
    await converge(a, b);
    expect(armed, "the update was never written").toBe(false);
    // The note as it was, never the fifteen bytes.
    expect(b.text("n.md")).toBe(lines);

    // The incoming version is tried again, and lands.
    await b.client.settle({ retryFailures: true });
    await converge(a, b);
    expect(b.text("n.md")).toBe(next);
    expect(a.text("n.md")).toBe(next);
    const history = await a.client.history("n.md");
    expect(
      history.filter((v) => v.device === "b").map((v) => `${v.uid}:${v.size}B`),
      "b sent a version of a note it never edited",
    ).toEqual([]);
    expect(a.notes()).toEqual(["n.md"]);
    expect(b.notes()).toEqual(["n.md"]);
  }, 300_000);
});

/**
 * T63, through the server: names the server accepts, on a disk that holds
 * nothing longer than 255 bytes.
 *
 * The plugin's staging name put nineteen bytes in front of the note's own, so
 * a new note named within that of the limit never arrived, and an edit to a
 * note whose conflict copy's name came within it never landed: the backup of
 * what was there could not be staged. Both failed the same way on every pass.
 */
describe("a note whose name is near the filesystem's limit", () => {
  const bytesIn = (s: string) => new TextEncoder().encode(s).length;
  function nameMax(d: Device): void {
    const tooLong = (p: string) => p.split("/").some((part) => bytesIn(part) > 255);
    const makes = new Set(["write", "writeBinary", "append", "mkdir", "rename", "copy"]);
    d.adapter.fault = (op, path, to) =>
      makes.has(op) && (tooLong(path) || (to !== undefined && tooLong(to)))
        ? new Error(`ENAMETOOLONG: name too long, ${op} '${to ?? path}'`)
        : undefined;
  }

  it("arrives, and so do the edits made to it afterwards", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    nameMax(b);
    // 250 bytes: within the staging mark's nineteen of the limit.
    const long = `${"n".repeat(247)}.md`;
    // 220 bytes, so the conflict copy of an edit, " (Conflicted copy b
    // <stamp>)" more, fits in 255 and its staging copy used not to.
    const edited = `${"e".repeat(217)}.md`;
    expect([bytesIn(long), bytesIn(edited)]).toEqual([250, 220]);
    a.adapter.seed(long, "a note with a long name\n", 1000);
    a.adapter.seed(edited, "the first version\n", 1000);
    await converge(a, b);
    expect(b.text(long)).toBe("a note with a long name\n");
    expect(b.text(edited)).toBe("the first version\n");

    a.adapter.seed(edited, "the second version\n", 2_000_000);
    await converge(a, b);
    expect(b.text(edited)).toBe("the second version\n");
    expect(b.notes().sort()).toEqual([edited, long].sort());
    expect(b.adapter.filePaths().filter((p) => p.includes(".trew-tmp-"))).toEqual([]);
  }, 300_000);
});
