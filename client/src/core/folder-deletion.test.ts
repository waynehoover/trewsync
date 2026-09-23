/**
 * Folder deletions travel (docs/design.md, "Folders").
 *
 * Inherited from Basalt, a folder's deletion was never sent: its files went
 * one by one and the folder stayed on every other device. Renaming
 * `Projects Old` to `Projects New` on one device therefore left an empty
 * `Projects Old` on every other one, and an empty folder deleted anywhere
 * stayed everywhere else (M3's real-app acceptance, finding 5).
 *
 * The rule now: the device that removed a folder sends its deletion after the
 * deletions of what was in it, and a device receiving one removes the folder
 * only if nothing is left in it there. Anything that is keeps it, and the
 * folder goes back on the server. Nothing here ever deletes or trashes a file
 * because its folder went, so the assertions are about notes as much as
 * folders: which bytes are where, on every device, afterwards.
 *
 * Real server, real transport, vaults in memory.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { Engine, type SyncReport } from "./engine.ts";
import { engineOnFakeSocket, settleUntil } from "./fake-socket.ts";
import type { SyncPreview } from "./preview.ts";
import { receiveCommitted } from "./test-async.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";
import { ProtocolError, Transport, type BatchEntry } from "./transport.ts";
import { MemoryIndexStore, MemoryVault, type FileStat } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/**
 * A memory vault on a disk that keeps case apart and says so, so a folder's
 * old spelling and its new one are two folders, as on Linux. A plain memory
 * vault cannot say, and the engine then treats two spellings as one folder,
 * which keeps an old spelling rather than removing it.
 */
class CaseKeepingVault extends MemoryVault {
  canonical(path: string): string {
    return path.normalize("NFC");
  }
  async sameFile(a: string, b: string): Promise<boolean> {
    return a === b;
  }
}

/**
 * A vault holding files its listing never shows: a dot-prefixed file, one
 * this device ignores. They are on the disk, so a folder holding one is not
 * empty, and the engine only learns that by trying to remove it.
 */
class HidingVault extends CaseKeepingVault {
  readonly unlisted = new Set<string>();
  override async list(): Promise<FileStat[]> {
    return (await super.list()).filter((s) => !this.unlisted.has(s.path));
  }
}

interface DeviceOptions {
  readOnly?: boolean;
  confirmDeletions?: (preview: SyncPreview) => Promise<boolean>;
}

/** One device. Closing it and connecting again is how it goes offline and comes back. */
class Device {
  readonly store = new MemoryIndexStore();
  transport!: Transport;
  engine!: Engine;
  caughtUp = false;
  clock = 1_000_000;
  readonly reports: SyncReport[] = [];

  constructor(
    readonly name: string,
    readonly vault: MemoryVault,
    readonly options: DeviceOptions = {},
  ) {}

  async connect(server: TestServer): Promise<void> {
    this.caughtUp = false;
    this.transport = new Transport(server.wsUrl, {
      onBatch: async (b) => {
        await this.engine.acceptBatch(b);
      },
      onCaughtUp: () => {
        this.caughtUp = true;
      },
      timeoutMs: 20_000,
    });
    this.engine = new Engine({
      vault: this.vault,
      store: this.store,
      transport: this.transport,
      device: this.name,
      vaultId: "default",
      ...(await server.deviceCredentials(this.name)),
      now: () => (this.clock += 60_000),
      ...(this.options.readOnly ? { readOnly: true } : {}),
      ...(this.options.confirmDeletions ? { confirmDeletions: this.options.confirmDeletions } : {}),
    });
    await this.transport.connect();
    await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
  }

  async sync(): Promise<SyncReport> {
    await receiveCommitted(this.transport);
    const report = await this.engine.sync();
    this.reports.push(report);
    return report;
  }

  close(): void {
    this.transport?.close();
  }

  /** Every pass's count of one thing, added up. */
  total(key: "foldersDeletedLocally" | "foldersDeletedRemotely" | "deletedLocally"): number {
    return this.reports.reduce((n, r) => n + r[key], 0);
  }

  /** The folders on this device, sorted. */
  async folders(): Promise<string[]> {
    return (await this.vault.list())
      .filter((s) => s.folder)
      .map((s) => s.path)
      .sort();
  }
}

let server: TestServer;
const devices: Device[] = [];

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  if (server) await server.cleanup();
});

async function fresh(): Promise<void> {
  server = new TestServer();
  await server.start();
}

async function device(
  name: string,
  vault: MemoryVault = new CaseKeepingVault(),
  options: DeviceOptions = {},
): Promise<Device> {
  const d = new Device(name, vault, options);
  devices.push(d);
  await d.connect(server);
  return d;
}

/** Every device, several rounds each, so each has heard what the others did. */
async function syncAll(...all: Device[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const d of all) await d.sync();
  }
}

/** The server's newest word on a path: live, deleted, or never held. */
async function onServer(d: Device, path: string): Promise<"live" | "deleted" | "absent"> {
  const [head] = await d.transport.history(path, { limit: 1 });
  if (head === undefined) return "absent";
  return head.deleted ? "deleted" : "live";
}

describe("a folder rename", () => {
  /**
   * The case the owner hit on 2026-09-23, with a folder inside it and an
   * empty folder inside that, reported the way Obsidian reports a folder
   * rename: one event, for the folder.
   */
  it("leaves no ghost of the old name on any device", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    const c = await device("c");
    const notes = {
      "Projects Old/plan.md": "the plan\n",
      "Projects Old/sub/detail.md": "the detail\n",
    };
    for (const [path, text] of Object.entries(notes)) await a.vault.edit(path, text);
    await a.vault.mkdir("Projects Old/sub/empty");
    await syncAll(a, b, c);
    for (const d of [b, c]) {
      expect(await d.folders(), d.name).toEqual([
        "Projects Old",
        "Projects Old/sub",
        "Projects Old/sub/empty",
      ]);
    }

    for (const path of Object.keys(notes)) {
      const bytes = await a.vault.read(path);
      await a.vault.remove(path);
      await a.vault.write(path.replace("Projects Old", "Projects New"), bytes, {
        mtime: 2000,
        ctime: 1000,
      });
    }
    for (const folder of ["Projects Old/sub/empty", "Projects Old/sub", "Projects Old"]) {
      await a.vault.remove(folder);
    }
    await a.vault.mkdir("Projects New/sub/empty");
    a.engine.noteRename("Projects Old", "Projects New");
    await syncAll(a, b, c);

    for (const d of [a, b, c]) {
      expect(await d.folders(), `${d.name} keeps a ghost of the old name`).toEqual([
        "Projects New",
        "Projects New/sub",
        "Projects New/sub/empty",
      ]);
      expect(d.vault.snapshot(), `${d.name} does not hold the notes under the new name`).toEqual({
        "Projects New/plan.md": "the plan\n",
        "Projects New/sub/detail.md": "the detail\n",
      });
    }
    expect(a.total("foldersDeletedRemotely")).toBe(3);
    for (const d of [b, c]) expect(d.total("foldersDeletedLocally"), d.name).toBe(3);
    expect(await onServer(a, "Projects Old")).toBe("deleted");
    expect(await onServer(a, "Projects New")).toBe("live");
  }, 240_000);

  /**
   * The same rename made where nothing reports it, as a file manager or a
   * shell does it: the scan finds the old names gone and the new ones new,
   * and the folder's deletion follows the deletions of what was in it.
   */
  it("found by the scan leaves no ghost either", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    await a.vault.edit("Old/note.md", "kept across the rename\n");
    await syncAll(a, b);

    const bytes = await a.vault.read("Old/note.md");
    await a.vault.remove("Old/note.md");
    await a.vault.remove("Old");
    await a.vault.write("New/note.md", bytes, { mtime: 2000, ctime: 1000 });
    await syncAll(a, b);

    for (const d of [a, b]) {
      expect(await d.folders(), d.name).toEqual(["New"]);
      expect(d.vault.snapshot(), d.name).toEqual({ "New/note.md": "kept across the rename\n" });
    }
  }, 240_000);
});

describe("an empty folder deleted on one device", () => {
  it("goes from every other device, nested folders and all", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    await a.vault.mkdir("Tree/branch/leaf");
    await a.vault.mkdir("Kept");
    await syncAll(a, b);
    expect(await b.folders()).toEqual(["Kept", "Tree", "Tree/branch", "Tree/branch/leaf"]);

    for (const folder of ["Tree/branch/leaf", "Tree/branch", "Tree"]) await a.vault.remove(folder);
    await syncAll(a, b);

    for (const d of [a, b]) expect(await d.folders(), d.name).toEqual(["Kept"]);
    // And it does not come back on the device that deleted it.
    await syncAll(a, b);
    expect(await a.folders()).toEqual(["Kept"]);
  }, 240_000);
});

describe("a folder deleted while another device writes into it", () => {
  /**
   * The note is kept on every device and the folder is live again, whichever
   * of the two syncs first: the deleting device's deletion reaching the other
   * one, or the note reaching the server before the deletion does.
   */
  it.each(["the deletion first", "the note first"] as const)(
    "keeps the note everywhere and the folder live, %s",
    async (order) => {
      await fresh();
      const a = await device("a");
      const b = await device("b");
      await a.vault.edit("Shared/old.md", "old note\n");
      await syncAll(a, b);

      // Both offline, both acting on what they last saw.
      a.close();
      b.close();
      await a.vault.remove("Shared/old.md");
      await a.vault.remove("Shared");
      await b.vault.edit("Shared/new.md", "written offline, inside the folder\n", 3_000_000);

      const [first, second] = order === "the deletion first" ? [a, b] : [b, a];
      await first.connect(server);
      await first.sync();
      await first.sync();
      await second.connect(server);
      await syncAll(a, b);

      for (const d of [a, b]) {
        expect(d.vault.snapshot(), `${d.name} lost the note or kept the deleted one`).toEqual({
          "Shared/new.md": "written offline, inside the folder\n",
        });
        expect(await d.folders(), d.name).toEqual(["Shared"]);
      }
      expect(await onServer(a, "Shared")).toBe("live");
      expect(await onServer(a, "Shared/new.md")).toBe("live");
      expect(await onServer(a, "Shared/old.md")).toBe("deleted");
    },
    240_000,
  );

  /** The same, with the note one edited here rather than one made here. */
  it("keeps a note edited here in the folder another device deleted", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    await a.vault.edit("Shared/note.md", "first\n");
    await syncAll(a, b);

    b.close();
    await a.vault.remove("Shared/note.md");
    await a.vault.remove("Shared");
    await syncAll(a);
    expect(await onServer(a, "Shared")).toBe("deleted");
    await b.vault.edit("Shared/note.md", "first\nedited offline\n", 3_000_000);
    await b.connect(server);
    await syncAll(a, b);

    for (const d of [a, b]) {
      expect(d.vault.snapshot(), d.name).toEqual({ "Shared/note.md": "first\nedited offline\n" });
      expect(await d.folders(), d.name).toEqual(["Shared"]);
    }
    expect(await onServer(a, "Shared")).toBe("live");
  }, 240_000);

  /**
   * A note written into the folder between the deleting device's last look
   * at the server and its folder deletion committing. The server refuses the
   * deletion as stale, because something live is in the folder, and the
   * deleting device reads what arrived and keeps the folder.
   */
  it("is refused by the server when a note landed in the folder first", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    await a.vault.edit("Race/old.md", "old\n");
    await syncAll(a, b);

    await a.vault.remove("Race/old.md");
    await a.vault.remove("Race");
    const refusals: string[] = [];
    const original = a.transport.putMany.bind(a.transport);
    a.transport.putMany = async (entries: BatchEntry[], ...rest) => {
      if (entries.some((e) => e.path === "Race" && e.meta.deleted)) {
        // The other device's note lands first.
        await b.vault.edit("Race/landed.md", "landed in the race\n", 3_000_000);
        await b.sync();
      }
      const out = await original(entries, ...rest);
      entries.forEach((e, i) => {
        const err = out.results[i]?.error;
        if (e.path === "Race" && err instanceof ProtocolError) refusals.push(err.code);
      });
      return out;
    };
    await syncAll(a, b);

    expect(refusals[0], "the server took a folder deletion with a note live in it").toBe("stale");
    for (const d of [a, b]) {
      expect(d.vault.snapshot(), d.name).toEqual({ "Race/landed.md": "landed in the race\n" });
      expect(await d.folders(), d.name).toEqual(["Race"]);
    }
    expect(await onServer(a, "Race")).toBe("live");
  }, 240_000);
});

describe("a folder deleted elsewhere that still holds something here", () => {
  /**
   * A file the listing never shows, which is the only kind a removal can
   * find that the engine could not: the folder stays, goes back on the
   * server, and comes back on the device that deleted it.
   */
  it("keeps the folder with the unlisted file in it, and puts it back", async () => {
    await fresh();
    const a = await device("a");
    const vault = new HidingVault();
    const b = await device("b", vault);
    await a.vault.mkdir("Holder");
    await syncAll(a, b);
    await vault.edit("Holder/.keep", "never synced\n");
    vault.unlisted.add("Holder/.keep");

    await a.vault.remove("Holder");
    await syncAll(a, b);

    expect(vault.text("Holder/.keep"), "the unlisted file was touched").toBe("never synced\n");
    for (const d of [a, b]) expect(await d.folders(), d.name).toEqual(["Holder"]);
    expect(await onServer(a, "Holder")).toBe("live");
    expect(b.total("foldersDeletedLocally")).toBe(0);
  }, 240_000);
});

describe("the order a folder's deletion arrives in", () => {
  /**
   * Across a reconnect: the device hears the file deletions, goes away before
   * the folder's own deletion, and hears that when it comes back. The folder
   * goes, as it does when both arrive together.
   */
  it("comes to the same end when the folder's deletion arrives after a reconnect", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    await a.vault.edit("Split/a.md", "a\n");
    await a.vault.edit("Split/b.md", "b\n");
    await syncAll(a, b);

    // Only the files, first.
    await a.vault.remove("Split/a.md");
    await a.vault.remove("Split/b.md");
    await syncAll(a, b);
    expect(await b.folders()).toEqual(["Split"]);
    b.close();
    await a.vault.remove("Split");
    await syncAll(a);
    await b.connect(server);
    await syncAll(a, b);

    for (const d of [a, b]) {
      expect(await d.folders(), d.name).toEqual([]);
      expect(d.vault.snapshot(), d.name).toEqual({});
    }
  }, 240_000);
});

describe("reviewing a folder deletion", () => {
  /**
   * A folder deletion that takes several files is reviewed through those
   * files, once, on the device that made it. Its own deletion is not a second
   * question, and a device receiving it is not asked at all.
   */
  it("asks once, on the deleting device, and not again for the folder", async () => {
    await fresh();
    let approve = false;
    const asked: string[] = [];
    const a = await device("a", new CaseKeepingVault(), {
      confirmDeletions: async () => {
        asked.push("a");
        return approve;
      },
    });
    const b = await device("b", new CaseKeepingVault(), {
      confirmDeletions: async () => {
        asked.push("b");
        return true;
      },
    });
    await a.vault.edit("Big/one.md", "one\n");
    await a.vault.edit("Big/two.md", "two\n");
    await syncAll(a, b);

    await a.vault.remove("Big/one.md");
    await a.vault.remove("Big/two.md");
    await a.vault.remove("Big");
    await expect(a.engine.sync()).rejects.toThrow(/paused for review/);
    expect(asked).toEqual(["a"]);
    approve = true;
    await syncAll(a, b);

    expect(asked, "the folder's own deletion asked again, or the receiver was asked").toEqual([
      "a",
      "a",
    ]);
    for (const d of [a, b]) expect(await d.folders(), d.name).toEqual([]);
    expect(await onServer(a, "Big")).toBe("deleted");
  }, 240_000);
});

describe("a read-only device", () => {
  it("does not delete a folder anywhere, and says it held it back", async () => {
    await fresh();
    const a = await device("a");
    const mirror = await device("mirror", new CaseKeepingVault(), { readOnly: true });
    await a.vault.mkdir("Mirrored");
    await syncAll(a, mirror);
    await mirror.vault.remove("Mirrored");
    const report = await mirror.sync();

    expect(report.heldBackPaths).toContain("Mirrored");
    expect(await onServer(a, "Mirrored")).toBe("live");
    expect(await a.folders()).toEqual(["Mirrored"]);
  }, 240_000);
});

/**
 * A history in whatever order a server could hand it over, which the real
 * one does not choose: it refuses a folder's deletion while anything live is
 * in the folder, so the deletions of the files always come first. The client
 * does not lean on that. Handed the folder's deletion before its files',
 * with them, or after, it ends in the same place, and in no order does it
 * put the folder back or delete anything the history did not.
 */
describe("a folder's deletion in any order against the deletions of its files", () => {
  async function onServerHolding(
    history: Record<string, unknown>[],
    bodies: Map<string, Uint8Array>,
  ) {
    const rig = await engineOnFakeSocket({}, { vault: new CaseKeepingVault() });
    let uid = 100;
    const written: Record<string, unknown>[] = [];
    rig.socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch") {
        s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      } else if (frame["op"] === "putmany") {
        const entries = frame["entries"] as Record<string, unknown>[];
        written.push(...entries);
        s.reply({ res: "acks", results: entries.map(() => ({ uid: ++uid })) });
      } else if (frame["op"] === "put") {
        written.push(frame);
        s.reply({ res: "have", uid: ++uid });
      } else if (frame["op"] === "applied") {
        s.reply({ res: "applied", cursor: frame["applied"] });
      } else if (frame["op"] === "ping") {
        s.raw({ res: "pong" });
      }
    };
    await deliver(rig, 1, history);
    return { ...rig, written };
  }

  async function deliver(
    rig: Awaited<ReturnType<typeof engineOnFakeSocket>>,
    from: number,
    entries: Record<string, unknown>[],
  ): Promise<void> {
    const to = from + entries.length - 1;
    rig.socket.raw({ op: "batch", from, to, entries });
    await settleUntil("the batch to be taken", () => rig.engine.status().cursor === to);
  }

  const entry = (uid: number, path: string, over: Record<string, unknown> = {}) => ({
    uid,
    path,
    size: 0,
    ctime: 1000,
    mtime: 1000,
    folder: false,
    deleted: false,
    chunks: [],
    device: "other",
    ...over,
  });

  async function note(uid: number, path: string, text: string, bodies: Map<string, Uint8Array>) {
    const raw = new TextEncoder().encode(text);
    const name = await chunkName(raw);
    bodies.set(name, raw);
    return entry(uid, path, { size: raw.length, chunks: [name] });
  }

  it.each(["before", "with", "after"] as const)(
    "removes the folder once its file is gone, the folder's deletion arriving %s it",
    async (order) => {
      const bodies = new Map<string, Uint8Array>();
      const rig = await onServerHolding(
        [entry(1, "F", { folder: true }), await note(2, "F/a.md", "a\n", bodies)],
        bodies,
      );
      await rig.engine.sync();
      await rig.engine.sync();
      expect(rig.vault.snapshot()).toEqual({ "F/a.md": "a\n" });

      const folderGone = (uid: number) => entry(uid, "F", { deleted: true });
      const fileGone = (uid: number) => entry(uid, "F/a.md", { deleted: true });
      if (order === "with") {
        await deliver(rig, 3, [fileGone(3), folderGone(4)]);
      } else {
        const [first, second] =
          order === "before" ? [folderGone(3), fileGone(4)] : [fileGone(3), folderGone(4)];
        await deliver(rig, 3, [first]);
        await rig.engine.sync();
        // Whatever arrived first, nothing in the folder was removed for the
        // folder's sake: the note goes only with its own deletion.
        if (order === "before") {
          expect(rig.vault.snapshot(), "the note went with its folder").toEqual({
            "F/a.md": "a\n",
          });
          expect(await rig.vault.exists("F"), "a folder with a note in it was removed").toBe(true);
        }
        await deliver(rig, 4, [second]);
      }
      let report!: SyncReport;
      for (let i = 0; i < 3; i++) report = await rig.engine.sync();

      expect(rig.vault.snapshot()).toEqual({});
      expect(await rig.vault.exists("F"), "the emptied folder stayed").toBe(false);
      expect(
        rig.written.filter((e) => e["path"] === "F"),
        "the folder was put back or deleted again",
      ).toEqual([]);
      expect(report.appliedCursor, "the device never settled").toBe(4);
    },
  );

  it("puts the folder back when a note in it is newer than its deletion", async () => {
    const bodies = new Map<string, Uint8Array>();
    const rig = await onServerHolding([entry(1, "F", { folder: true })], bodies);
    await rig.engine.sync();
    expect(await rig.vault.exists("F")).toBe(true);

    // Deleted, and then written into by a device that had not heard.
    await deliver(rig, 2, [
      entry(2, "F", { deleted: true }),
      await note(3, "F/late.md", "late\n", bodies),
    ]);
    for (let i = 0; i < 3; i++) await rig.engine.sync();

    expect(rig.vault.snapshot()).toEqual({ "F/late.md": "late\n" });
    const putBack = rig.written.filter((e) => e["path"] === "F");
    expect(putBack).toHaveLength(1);
    expect(putBack[0]).toMatchObject({ base: 2, meta: { folder: true } });
  });
});
