/**
 * A rename from another device, onto a name this device refuses.
 *
 * A rename travels as one entry, the new path with the old one on it, and a
 * receiving device stages it as two: the arrival of the new path and the
 * deletion of the old one (`acceptBatch`). When the new path is one this
 * device will not write, a name Windows cannot hold on a Windows device or a
 * dot-prefixed folder on any device, the arrival is stranded and the deletion
 * still lands. Where the old note is unchanged here that is right: the note is
 * on the server under its new name, and the stranded list says where.
 *
 * Where the old note has an edit here that has not gone up, the deletion is
 * the same deletion that loses to an edit anywhere else (`decide`): the note
 * is kept under its old name, with the edit, and sent again. These cases hold
 * the engine to that for each order the edit and the rename can meet in, a
 * restart between them included, and check the edited words themselves on
 * this device, on the server and on the device that renamed (rule 10).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Engine, type SyncReport } from "./engine.ts";
import { chunkName } from "./digest.ts";
import { FakeSocket, engineOnFakeSocket, settle } from "./fake-socket.ts";
import { receiveCommitted } from "./test-async.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";
import { Transport, type WireEntry } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { describeWindowsRefusal } from "./windows-names.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/** One device on the real server, which can be closed and started again on the same state. */
class Device {
  transport!: Transport;
  engine!: Engine;
  caughtUp = false;
  clock = 1_000_000;
  /** Minted on first connect and kept, so a restart is the same device. */
  credentials: { deviceId: string; token: string } | undefined;

  constructor(
    readonly name: string,
    readonly windows: boolean,
    readonly vault = new MemoryVault(),
    readonly store = new MemoryIndexStore(),
  ) {}

  async connect(server: TestServer): Promise<void> {
    this.credentials ??= await server.deviceCredentials(this.name);
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
      ...this.credentials,
      now: () => (this.clock += 60_000),
      ...(this.windows ? { windows: true } : {}),
    });
    await this.transport.connect();
    await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
  }

  /** Syncs until nothing more changes, letting relayed work arrive between passes. */
  async settle(rounds = 4): Promise<SyncReport> {
    let last = await this.engine.sync();
    for (let i = 1; i < rounds; i++) {
      await receiveCommitted(this.transport);
      last = await this.engine.sync();
    }
    return last;
  }

  close(): void {
    this.transport?.close();
  }
}

let server: TestServer;
const devices: Device[] = [];

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  if (server) await server.cleanup();
});

async function device(name: string, windows: boolean): Promise<Device> {
  const d = new Device(name, windows);
  devices.push(d);
  await d.connect(server);
  return d;
}

const ORIGINAL = "the note as both devices had it\n";
const EDITED = "the note as both devices had it\nand a line written on the Windows device\n";
const REFUSED = "a:b.md";

/**
 * A Mac and a Windows device agreed on `a.md`, and the Mac about to rename it
 * to a name Windows cannot hold. The server takes the name, because every
 * other platform can hold it.
 */
async function agreed(): Promise<{ mac: Device; win: Device }> {
  server = new TestServer();
  await server.start();
  const mac = await device("mac", false);
  const win = await device("win", true);
  await mac.vault.edit("a.md", ORIGINAL, 1000);
  await mac.settle();
  await receiveCommitted(win.transport);
  await win.settle();
  expect(win.vault.text("a.md")).toBe(ORIGINAL);
  return { mac, win };
}

/** The Mac renames `a.md` to the refused name, as the plugin reports one, and sends it. */
async function macRenames(mac: Device): Promise<void> {
  const bytes = await mac.vault.read("a.md");
  await mac.vault.remove("a.md");
  await mac.vault.write(REFUSED, bytes, { mtime: 2000, ctime: 1000 });
  mac.engine.noteRename("a.md", REFUSED);
  await mac.settle(1);
  expect(await server.cli("cat", "-path", REFUSED), "the rename never went up").toBe(ORIGINAL);
}

/** What the server holds at a path, or undefined when it holds nothing live there. */
async function onServer(path: string): Promise<string | undefined> {
  try {
    return await server.cli("cat", "-path", path);
  } catch {
    return undefined;
  }
}

/**
 * Where the edit has to be once everything has settled: kept here under the
 * old name, back on the server under it, and on the Mac, with the renamed
 * note beside it untouched. Nothing the Windows device did deleted the
 * renamed note from the server.
 */
async function editSurvived(mac: Device, win: Device, report: SyncReport): Promise<void> {
  expect(win.vault.text("a.md"), "the edit was lost on the device that made it").toBe(EDITED);
  expect(win.vault.text(REFUSED), "a refused name was written").toBeUndefined();
  expect(report.needsAttention).toContainEqual({
    path: REFUSED,
    why: describeWindowsRefusal("character"),
  });

  expect(await onServer("a.md"), "the edit never reached the server").toBe(EDITED);
  expect(await onServer(REFUSED), "the renamed note went from the server").toBe(ORIGINAL);

  await receiveCommitted(mac.transport);
  await mac.settle();
  expect(mac.vault.text("a.md"), "the edit never reached the other device").toBe(EDITED);
  expect(mac.vault.text(REFUSED)).toBe(ORIGINAL);
}

describe("a rename onto a name Windows cannot hold, arriving on Windows", () => {
  it("removes an unchanged source and lists the destination as stranded", async () => {
    const { mac, win } = await agreed();
    await macRenames(mac);
    await receiveCommitted(win.transport);
    const report = await win.settle();

    expect(win.vault.paths(), "the old name was left behind, or the new one written").toEqual([]);
    expect(report.needsAttention).toEqual([
      { path: REFUSED, why: describeWindowsRefusal("character") },
    ]);
    // The note is on the server under its new name, and this device said
    // nothing to change that.
    expect(await onServer(REFUSED)).toBe(ORIGINAL);
    expect(await onServer("a.md")).toBeUndefined();
    await receiveCommitted(mac.transport);
    await mac.settle();
    expect(mac.vault.snapshot()).toEqual({ [REFUSED]: ORIGINAL });
  }, 120_000);

  it("keeps an edit made before the rename arrived", async () => {
    const { mac, win } = await agreed();
    await win.vault.edit("a.md", EDITED, 5000);
    await macRenames(mac);
    await receiveCommitted(win.transport);
    await editSurvived(mac, win, await win.settle());
  }, 120_000);

  it("keeps an edit made after the rename arrived and before a pass applied it", async () => {
    const { mac, win } = await agreed();
    await macRenames(mac);
    await receiveCommitted(win.transport);
    expect(win.engine.status().pending, "the rename has not arrived").toBeGreaterThan(0);
    expect(win.vault.text("a.md"), "a pass ran before the edit").toBe(ORIGINAL);
    await win.vault.edit("a.md", EDITED, 5000);
    await editSurvived(mac, win, await win.settle());
  }, 120_000);

  it("keeps the edit across a restart between the rename arriving and the pass", async () => {
    const { mac, win } = await agreed();
    await macRenames(mac);
    await receiveCommitted(win.transport);
    await win.vault.edit("a.md", EDITED, 5000);
    // Gone before any pass decided about either, and back on the same disk
    // and the same state file.
    win.close();
    const again = new Device("win", true, win.vault, win.store);
    again.credentials = win.credentials;
    devices.push(again);
    await again.connect(server);
    await editSurvived(mac, again, await again.settle());
  }, 120_000);

  it("keeps an edit that lands while the pass is removing the source", async () => {
    const { mac, win } = await agreed();
    await macRenames(mac);
    await receiveCommitted(win.transport);
    // The scan saw the note unchanged and the pass decided to remove it; the
    // editor saves in the moment before it goes. `midReplace` is the gap a
    // preserving removal reads after, which is where a real save can land.
    let saved = false;
    win.vault.midReplace = async (path) => {
      if (path !== "a.md" || saved) return;
      saved = true;
      await win.vault.edit("a.md", EDITED, 5000);
    };
    const report = await win.settle();
    expect(saved, "the pass never removed the source, so this proves nothing").toBe(true);

    // Kept beside the name, as any deletion racing a save is, and sent up.
    const kept = Object.entries(win.vault.snapshot()).filter(([, text]) => text === EDITED);
    expect(kept, "the edit was lost on the device that made it").toHaveLength(1);
    const [keptAt] = kept[0]!;
    expect(report.needsAttention).toContainEqual({
      path: REFUSED,
      why: describeWindowsRefusal("character"),
    });
    expect(await onServer(keptAt), "the edit never reached the server").toBe(EDITED);
    expect(await onServer(REFUSED)).toBe(ORIGINAL);
    await receiveCommitted(mac.transport);
    await mac.settle();
    expect(mac.vault.text(keptAt), "the edit never reached the other device").toBe(EDITED);
  }, 120_000);
});

/**
 * The same rename into a dot-prefixed folder, which no device writes. The
 * server refuses such a path itself (plan/protocol.md, "Paths"), so only a
 * server that is wrong can send one, and a fake one is the only way to.
 */
describe("a rename into a dot-prefixed folder, on any platform", () => {
  const enc = new TextEncoder();
  const HIDDEN = ".hidden/a.md";

  async function entry(uid: number, path: string, text: string, from?: string) {
    const raw = enc.encode(text);
    const name = await chunkName(raw);
    const e: WireEntry = {
      uid,
      path,
      size: raw.length,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [name],
      device: "other",
      ...(from !== undefined ? { prev: from } : {}),
    };
    return { e, name, raw };
  }

  /** Every write this device sent up, by path, as the wire carried it. */
  function writes(socket: FakeSocket): { path: string; deleted: boolean; chunks: string[] }[] {
    const out: { path: string; deleted: boolean; chunks: string[] }[] = [];
    const one = (w: Record<string, unknown>) =>
      out.push({
        path: w["path"] as string,
        deleted: (w["meta"] as { deleted: boolean }).deleted,
        chunks: w["chunks"] as string[],
      });
    for (const frame of socket.sentText) {
      if (frame["op"] === "put") one(frame);
      if (frame["op"] === "putmany") {
        for (const w of frame["entries"] as Record<string, unknown>[]) one(w);
      }
    }
    return out;
  }

  /** A device that holds `a.md` from another device, synced, on a server that takes every write. */
  async function holding() {
    const rig = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    let uid = 10;
    rig.socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch") {
        s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      } else if (frame["op"] === "put") {
        s.reply({ res: "have", uid: ++uid });
      } else if (frame["op"] === "putmany") {
        const n = (frame["entries"] as unknown[]).length;
        s.reply({ res: "acks", results: Array.from({ length: n }, () => ({ uid: ++uid })) });
      } else if (frame["op"] === "ping") s.raw({ res: "pong" });
    };
    const first = await entry(1, "a.md", ORIGINAL);
    bodies.set(first.name, first.raw);
    rig.socket.raw({ op: "batch", from: 1, to: 1, entries: [first.e] });
    for (let i = 0; i < 400 && rig.engine.status().pending < 1; i++) await settle();
    await rig.engine.sync({ coalesceWrites: false });
    expect(rig.vault.text("a.md")).toBe(ORIGINAL);
    const renamed = await entry(2, HIDDEN, ORIGINAL, "a.md");
    bodies.set(renamed.name, renamed.raw);
    const arrive = async () => {
      rig.socket.raw({ op: "batch", from: 2, to: 2, entries: [renamed.e] });
      for (let i = 0; i < 400 && rig.engine.status().pending < 2; i++) await settle();
    };
    return { ...rig, arrive };
  }

  it("removes an unchanged source, lists the destination, and sends nothing", async () => {
    const { engine, vault, socket, arrive } = await holding();
    await arrive();
    const report = await engine.sync({ coalesceWrites: false });
    expect(vault.paths()).toEqual([]);
    expect(report.needsAttention).toEqual([
      { path: HIDDEN, why: "a path under a dot-prefixed name never syncs" },
    ]);
    expect(writes(socket), "something went back to the server").toEqual([]);
  });

  it.each([
    ["before the rename arrived", true],
    ["after the rename arrived", false],
  ])("keeps an edit made %s, and sends it up under the old name", async (_, editFirst) => {
    const { engine, vault, socket, arrive } = await holding();
    if (editFirst) await vault.edit("a.md", EDITED, 5000);
    await arrive();
    if (!editFirst) await vault.edit("a.md", EDITED, 5000);
    const report = await engine.sync({ coalesceWrites: false });

    expect(vault.text("a.md"), "the edit was lost").toBe(EDITED);
    expect(vault.text(HIDDEN)).toBeUndefined();
    expect(report.needsAttention).toContainEqual({
      path: HIDDEN,
      why: "a path under a dot-prefixed name never syncs",
    });
    const edited = await chunkName(enc.encode(EDITED));
    expect(writes(socket), "the edit never went up, or something was deleted").toEqual([
      { path: "a.md", deleted: false, chunks: [edited] },
    ]);
  });
});
