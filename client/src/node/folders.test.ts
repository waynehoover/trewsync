/**
 * The headless client's half of folder deletions (docs/design.md, "Folders").
 *
 * `removeFolder` removes a folder only if the disk finds it empty at the
 * moment of removal, which is what `rmdir` is: one call, no look beforehand
 * for a note to be saved behind. Then two devices on real directories, one
 * of them the case where a disk that folds case sees one folder under two
 * spellings, which a folder deletion must never read as two folders.
 */

import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Engine, type SyncReport } from "../core/engine.ts";
import { receiveCommitted } from "../core/test-async.ts";
import { TestServer, cleanupBinary, removeTree, serverBinary, until } from "../core/test-server.ts";
import { Transport } from "../core/transport.ts";
import { MemoryIndexStore } from "../core/vault.ts";
import { NodeVault, midRemoveFolder } from "./vault.ts";

let root: string;

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trew-folders-"));
});

afterEach(async () => {
  midRemoveFolder.pause = async () => {};
  await removeTree(root);
});

describe("removeFolder", () => {
  it("removes an empty folder, and answers yes for one that is not there", async () => {
    const v = new NodeVault(root);
    await mkdir(join(root, "Empty"));
    expect(await v.removeFolder("Empty")).toBe(true);
    await expect(stat(join(root, "Empty"))).rejects.toThrow(/ENOENT/);
    expect(await v.removeFolder("Never there")).toBe(true);
  });

  it("leaves a folder holding anything, listed or not, exactly as it was", async () => {
    const v = new NodeVault(root, { alsoIgnore: ["Ignored"] });
    const cases: [string, string][] = [
      ["Note", "Note/kept.md"],
      ["Dotfile", "Dotfile/.DS_Store"],
      ["Ignored folder", "Ignored folder/Ignored/x.md"],
      ["Nested", "Nested/inner/deeper.md"],
    ];
    for (const [, file] of cases) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), `the contents of ${file}\n`);
    }
    await mkdir(join(root, "Only a folder", "inside"), { recursive: true });
    for (const [folder, file] of cases) {
      expect(await v.removeFolder(folder), folder).toBe(false);
      expect(await readFile(join(root, file), "utf8")).toBe(`the contents of ${file}\n`);
    }
    expect(await v.removeFolder("Only a folder")).toBe(false);
    expect((await stat(join(root, "Only a folder", "inside"))).isDirectory()).toBe(true);
    // Nothing went into the trash on the way.
    await expect(readdir(join(root, ".trash"))).rejects.toThrow(/ENOENT/);
  });

  it("does not remove a file that has the name", async () => {
    const v = new NodeVault(root);
    await writeFile(join(root, "Plain"), "a file with no extension\n");
    expect(await v.removeFolder("Plain")).toBe(false);
    expect(await readFile(join(root, "Plain"), "utf8")).toBe("a file with no extension\n");
  });

  /** The moment the removal exists to survive: a save after any look would have been made. */
  it("keeps a note saved into the folder in the instant before it goes", async () => {
    const v = new NodeVault(root);
    await mkdir(join(root, "Inbox"));
    midRemoveFolder.pause = async () => {
      await writeFile(join(root, "Inbox", "just saved.md"), "saved at the last moment\n");
    };
    expect(await v.removeFolder("Inbox")).toBe(false);
    expect(await readFile(join(root, "Inbox", "just saved.md"), "utf8")).toBe(
      "saved at the last moment\n",
    );
  });

  it("refuses a path outside the vault or one that never syncs", async () => {
    const v = new NodeVault(root);
    await expect(v.removeFolder("../elsewhere")).rejects.toThrow(/outside the vault/);
    await mkdir(join(root, ".obsidian"));
    await expect(v.removeFolder(".obsidian")).rejects.toThrow();
    expect((await stat(join(root, ".obsidian"))).isDirectory()).toBe(true);
  });
});

/** One headless device on a real directory. */
class Device {
  readonly store = new MemoryIndexStore();
  readonly vault: NodeVault;
  transport!: Transport;
  engine!: Engine;
  caughtUp = false;
  clock = 1_000_000;
  readonly reports: SyncReport[] = [];

  constructor(
    readonly name: string,
    readonly dir: string,
  ) {
    this.vault = new NodeVault(dir);
  }

  private credentials: { deviceId: string; token: string } | undefined;

  async connect(server: TestServer): Promise<void> {
    this.credentials ??= await server.deviceCredentials(this.name);
    this.caughtUp = false;
    this.transport = new Transport(server.wsUrl, {
      onBatch: (b) => this.engine.acceptBatch(b),
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
      ...this.credentials,
      now: () => (this.clock += 60_000),
    });
    await this.transport.connect();
    await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
  }

  async sync(): Promise<void> {
    await receiveCommitted(this.transport);
    this.reports.push(await this.engine.sync());
  }

  close(): void {
    this.transport?.close();
  }
}

/** Every directory under a vault, apart from what the client keeps for itself. */
async function folders(dir: string, under = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, under), { withFileTypes: true })) {
    if (!e.isDirectory() || (under === "" && e.name.startsWith("."))) continue;
    const path = under ? `${under}/${e.name}` : e.name;
    out.push(path, ...(await folders(dir, path)));
  }
  return out.sort();
}

/** Every file under a vault with its text, apart from what the client keeps for itself. */
async function files(dir: string, under = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(join(dir, under), { withFileTypes: true })) {
    if (under === "" && e.name.startsWith(".")) continue;
    const path = under ? `${under}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await files(dir, path));
    else out[path] = await readFile(join(dir, path), "utf8");
  }
  return out;
}

async function trashed(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, ".trash"), { recursive: true })).map(String);
  } catch {
    return [];
  }
}

describe("two headless devices", () => {
  let server: TestServer;
  const devices: Device[] = [];

  afterEach(async () => {
    while (devices.length) devices.pop()!.close();
    if (server) await server.cleanup();
  });

  async function two(): Promise<[Device, Device]> {
    server = new TestServer();
    await server.start();
    const out: Device[] = [];
    for (const name of ["a", "b"]) {
      const dir = join(root, name);
      await mkdir(dir);
      const d = new Device(name, dir);
      devices.push(d);
      await d.connect(server);
      out.push(d);
    }
    return out as [Device, Device];
  }

  async function syncBoth(a: Device, b: Device): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await a.sync();
      await b.sync();
    }
  }

  it("removes an emptied folder, and keeps and puts back one a dot file holds", async () => {
    const [a, b] = await two();
    for (const folder of ["Gone", "Held"]) {
      await mkdir(join(a.dir, folder));
      await writeFile(join(a.dir, folder, "note.md"), `in ${folder}\n`);
    }
    await syncBoth(a, b);
    expect(await folders(b.dir)).toEqual(["Gone", "Held"]);
    // What Finder leaves in a folder somebody opened, and never syncs.
    await writeFile(join(b.dir, "Held", ".DS_Store"), "finder\n");

    for (const folder of ["Gone", "Held"]) {
      await rm(join(a.dir, folder), { recursive: true });
    }
    await syncBoth(a, b);

    expect(await folders(b.dir)).toEqual(["Held"]);
    expect(await readFile(join(b.dir, "Held", ".DS_Store"), "utf8")).toBe("finder\n");
    // Kept, so put back, so the device that deleted it has it again, empty.
    expect(await folders(a.dir)).toEqual(["Held"]);
    expect(await files(a.dir)).toEqual({});
    expect(await files(b.dir)).toEqual({ "Held/.DS_Store": "finder\n" });
    // The notes went where incoming deletions go; the folders did not go
    // there, and the dot file was never touched.
    expect((await trashed(b.dir)).sort()).toEqual(["Gone", "Gone/note.md", "Held", "Held/note.md"]);
  }, 240_000);
});

const scratch = await mkdtemp(join(tmpdir(), "trew-case-"));
await writeFile(join(scratch, "CaseProbe.tmp"), "probe");
const diskFolds = await stat(join(scratch, "caseprobe.tmp")).then(
  () => true,
  () => false,
);
await rm(scratch, { recursive: true, force: true });

describe("a case-only folder rename, on a disk that folds case", () => {
  let server: TestServer;
  const devices: Device[] = [];

  afterEach(async () => {
    while (devices.length) devices.pop()!.close();
    if (server) await server.cleanup();
  });

  /**
   * One folder under two spellings, on the disk that renamed it and on the
   * one that receives the rename. Neither spelling is a folder somebody
   * deleted, so nothing sends a folder deletion and nothing removes the
   * folder, empty subfolder and all.
   */
  it.skipIf(!diskFolds)(
    "keeps the folder, and sends no folder deletion for either spelling",
    async () => {
      server = new TestServer();
      await server.start();
      const [a, b] = await Promise.all(
        ["a", "b"].map(async (name) => {
          const dir = join(root, name);
          await mkdir(dir);
          return new Device(name, dir);
        }),
      );
      for (const d of [a!, b!]) {
        devices.push(d);
        await d.connect(server);
      }
      await mkdir(join(a!.dir, "Dir", "Empty"), { recursive: true });
      await writeFile(join(a!.dir, "Dir", "note.md"), "the only copy\n");
      for (let i = 0; i < 4; i++) {
        await a!.sync();
        await b!.sync();
      }

      await rename(join(a!.dir, "Dir"), join(a!.dir, "dir"));
      for (let i = 0; i < 4; i++) {
        await a!.sync();
        await b!.sync();
      }

      for (const d of [a!, b!]) {
        const found = await folders(d.dir);
        expect(
          found.map((f) => f.toLowerCase()),
          `${d.name} lost the folder`,
        ).toEqual(["dir", "dir/empty"]);
        const notes = await files(d.dir);
        expect(Object.values(notes), `${d.name} lost the note`).toEqual(["the only copy\n"]);
        expect(await trashed(d.dir), `${d.name} trashed something`).toEqual([]);
        expect(
          d.reports.reduce((n, r) => n + r.foldersDeletedLocally + r.foldersDeletedRemotely, 0),
          `${d.name} deleted a folder`,
        ).toBe(0);
      }
      for (const spelling of ["Dir", "dir", "Dir/Empty", "dir/Empty"]) {
        const versions = await a!.transport.history(spelling, { limit: 20 });
        expect(
          versions.filter((v) => v.deleted && !v.prev),
          `a folder deletion was sent for ${spelling}`,
        ).toEqual([]);
      }
    },
    240_000,
  );

  /**
   * The rename made while the other device was offline (plan/cutover.md,
   * finding 9). It came back to versions of each note under the new folder
   * spelling and the old ones retired, and wrote each into the folder it
   * already had, which on this disk is the same folder: nothing was lost and
   * the files stayed under `Inner` for good, while the server and every new
   * device had `iNNER`.
   */
  it.skipIf(!diskFolds)(
    "respells the folder on a device that was offline for the rename",
    async () => {
      server = new TestServer();
      await server.start();
      const [a, b] = await Promise.all(
        ["a", "b"].map(async (name) => {
          const dir = join(root, name);
          await mkdir(dir);
          return new Device(name, dir);
        }),
      );
      for (const d of [a!, b!]) {
        devices.push(d);
        await d.connect(server);
      }
      await mkdir(join(a!.dir, "Inner", "Deeper"), { recursive: true });
      await writeFile(join(a!.dir, "Inner", "note.md"), "in the folder\n");
      await writeFile(join(a!.dir, "Inner", "Deeper", "deep.md"), "further in\n");
      for (let i = 0; i < 4; i++) {
        await a!.sync();
        await b!.sync();
      }
      expect(await folders(b!.dir)).toEqual(["Inner", "Inner/Deeper"]);

      b!.close();
      await rename(join(a!.dir, "Inner"), join(a!.dir, "iNNER"));
      for (let i = 0; i < 3; i++) await a!.sync();
      await b!.connect(server);
      for (let i = 0; i < 4; i++) {
        await b!.sync();
        await a!.sync();
      }

      // And a device paired now, which has only what the server holds.
      const cDir = join(root, "c");
      await mkdir(cDir);
      const c = new Device("c", cDir);
      devices.push(c);
      await c.connect(server);
      await c.sync();

      const want = ["iNNER", "iNNER/Deeper"];
      const notes = { "iNNER/note.md": "in the folder\n", "iNNER/Deeper/deep.md": "further in\n" };
      for (const d of [a!, c, b!]) {
        expect(await folders(d.dir), `${d.name}'s folders`).toEqual(want);
        expect(await files(d.dir), `${d.name}'s notes`).toEqual(notes);
        expect(await trashed(d.dir), `${d.name} trashed something`).toEqual([]);
      }
    },
    240_000,
  );
});
