/**
 * The operator restores the vault to a uid while a phone is offline
 * (PLAN.md M5.5, "Restore the vault to a point in time").
 *
 * `trewd restore -to-uid N -apply` is one operation on the server: a new
 * version for every path whose head differs from what it held at N, a
 * deletion for every path created since, nothing for the rest. History is
 * appended to, never rewound, so every device reads the restore as ordinary
 * new versions. What this holds is the part only a device can show: a phone
 * that was offline across the whole thing, with its own unsent edit to a path
 * the restore did not touch, comes back and converges with no conflict copy
 * at all, keeps its edit, and holds exactly the restored notes; and the
 * laptop that was connected throughout ends up the same.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { Engine, type SyncReport } from "./engine.ts";
import { receiveCommitted } from "./test-async.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";
import { Transport } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

/** One device, which keeps its credentials across connections as a paired one does. */
class Device {
  readonly store = new MemoryIndexStore();
  readonly vault = new MemoryVault();
  transport!: Transport;
  engine!: Engine;
  caughtUp = false;
  clock = 1_000_000;
  private credentials: { deviceId: string; token: string } | undefined;

  constructor(readonly name: string) {}

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
      // A clock that moves a minute a reading, so the write debounce never
      // decides when a sync may happen.
      now: () => (this.clock += 60_000),
    });
    await this.transport.connect();
    await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
  }

  /** Passes until nothing changes, and every report on the way. */
  async settle(rounds = 4): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (let i = 0; i < rounds; i++) {
      await receiveCommitted(this.transport);
      reports.push(await this.engine.sync());
    }
    return reports;
  }

  close(): void {
    this.transport?.close();
  }
}

let server: TestServer | undefined;
const devices: Device[] = [];

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

const closers: (() => unknown)[] = [];

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  while (closers.length) await closers.pop()!();
  await server?.cleanup();
  server = undefined;
});

async function latestUid(s: TestServer): Promise<number> {
  const stats = JSON.parse(await s.cli("stats", "-json")) as { vaults: { latestUid: number }[] };
  return stats.vaults[0]!.latestUid;
}

const sum = (reports: SyncReport[], key: keyof SyncReport) =>
  reports.reduce((n, r) => n + (r[key] as number), 0);

describe("a restore to a uid while a phone is offline", () => {
  it("reaches the phone as ordinary versions, with no conflict copy for a path it did not touch", async () => {
    server = new TestServer();
    await server.start();
    const laptop = new Device("laptop");
    const phone = new Device("phone");
    devices.push(laptop, phone);
    await laptop.connect(server);
    await phone.connect(server);

    const plan = "the plan, as it stood at the restore point\n";
    const kept = "a note deleted after the restore point\n";
    const phoneNote = "the phone's note, before it went offline\n";
    await laptop.vault.edit("plan.md", plan, 1_000);
    await laptop.vault.edit("kept.md", kept, 1_000);
    await laptop.vault.edit("phone.md", phoneNote, 1_000);
    await laptop.settle();
    await phone.settle();
    expect(phone.vault.snapshot()).toEqual({
      "plan.md": plan,
      "kept.md": kept,
      "phone.md": phoneNote,
    });
    const point = await latestUid(server);

    // The phone goes offline, and edits a note the restore will not touch.
    phone.close();
    const phoneEdit = "edited on the phone while it was offline\n";
    await phone.vault.edit("phone.md", phoneEdit, 5_000);

    // Overnight, on the laptop: a rewrite, a deletion, a new note.
    await laptop.vault.edit("plan.md", "an overnight rewrite nobody wanted\n", 2_000);
    await laptop.vault.remove("kept.md");
    await laptop.vault.edit("new.md", "made after the restore point\n", 2_000);
    await laptop.settle();
    expect(await server.cli("cat", "-path", "plan.md")).toBe(
      "an overnight rewrite nobody wanted\n",
    );

    // The operator puts the vault back, through the running server.
    const dry = await server.cli("restore", "-to-uid", String(point));
    const head = /-head (\d+) -apply/.exec(dry);
    expect(head, dry).not.toBeNull();
    const applied = await server.cli(
      "restore",
      "-to-uid",
      String(point),
      "-head",
      head![1]!,
      "-apply",
    );
    expect(applied).toMatch(/^Restored vault "default" to uid \d+, as operation /);

    // The laptop was connected: it receives the restore as it lands.
    const laptopReports = await laptop.settle();
    expect(laptop.vault.snapshot()).toEqual({
      "plan.md": plan,
      "kept.md": kept,
      "phone.md": phoneNote,
    });
    expect(sum(laptopReports, "conflicted"), "the laptop kept a conflict copy").toBe(0);

    // The phone comes back, having missed the rewrite, the deletion, the new
    // note and the restore of all three, with its own edit unsent.
    await phone.connect(server);
    const phoneReports = await phone.settle(6);
    const copies = phone.vault.paths().filter((p) => p.includes("Conflicted copy"));
    expect(copies, "the phone made a conflict copy of a path it never touched").toEqual([]);
    expect(sum(phoneReports, "conflicted")).toBe(0);
    expect(phone.vault.snapshot()).toEqual({
      "plan.md": plan,
      "kept.md": kept,
      "phone.md": phoneEdit,
    });
    expect(await server.cli("cat", "-path", "phone.md")).toBe(phoneEdit);

    // And the laptop receives the phone's edit, still with nothing copied.
    await laptop.settle();
    expect(laptop.vault.snapshot()).toEqual({
      "plan.md": plan,
      "kept.md": kept,
      "phone.md": phoneEdit,
    });
    expect(laptop.vault.paths().filter((p) => p.includes("Conflicted copy"))).toEqual([]);
  }, 240_000);
});

/**
 * A device puts one folder back as it was at a time (protocol 5): a preview
 * that changes nothing, the apply of exactly that preview as one operation
 * every device receives, nothing outside the folder touched, and an undo that
 * puts back what it replaced. An edit between the preview and the apply makes
 * the apply refused rather than committed over it.
 */
describe("a device restoring a folder to a time", () => {
  const pause = () => new Promise((r) => setTimeout(r, 50));

  it("previews, applies to every device, leaves the rest of the vault, and undoes", async () => {
    server = new TestServer();
    await server.start();
    const laptop = new Device("laptop");
    const phone = new Device("phone");
    devices.push(laptop, phone);
    await laptop.connect(server);
    await phone.connect(server);

    await laptop.vault.edit("Projects/plan.md", "the plan on Tuesday\n", 1_000);
    await laptop.vault.edit("Projects/gone.md", "deleted since\n", 1_000);
    await laptop.vault.edit("inbox.md", "inbox on Tuesday\n", 1_000);
    await laptop.settle();
    await phone.settle();
    await pause();
    const tuesday = Date.now();
    await pause();

    await laptop.vault.edit("Projects/plan.md", "the plan rewritten\n", 2_000);
    await laptop.vault.remove("Projects/gone.md");
    await laptop.vault.edit("Projects/new.md", "made since\n", 2_000);
    await laptop.vault.edit("inbox.md", "inbox rewritten\n", 2_000);
    await laptop.settle();
    await phone.settle();
    const before = phone.vault.snapshot();

    const preview = await laptop.transport.restore({ at: tuesday, folder: "Projects" });
    expect(preview).toMatchObject({ folder: "Projects", restore: 2, remove: 1, more: 0 });
    expect(preview.opId).toBeUndefined();
    expect(preview.at).toBeLessThanOrEqual(tuesday);
    expect(phone.vault.snapshot(), "a preview changed something").toEqual(before);

    const done = await laptop.transport.restore({
      uid: preview.toUid,
      head: preview.head,
      folder: "Projects",
    });
    expect(done.opId).toBeTruthy();
    await laptop.settle();
    await phone.settle();
    const restored = {
      "Projects/plan.md": "the plan on Tuesday\n",
      "Projects/gone.md": "deleted since\n",
      "inbox.md": "inbox rewritten\n",
    };
    expect(laptop.vault.snapshot()).toEqual(restored);
    expect(phone.vault.snapshot()).toEqual(restored);

    await phone.transport.undo(done.opId!);
    await phone.settle();
    await laptop.settle();
    expect(laptop.vault.snapshot()).toEqual(before);
    expect(phone.vault.snapshot()).toEqual(before);

    // A note saved between a preview and its apply refuses the apply.
    const again = await laptop.transport.restore({ at: tuesday, folder: "Projects" });
    await phone.vault.edit("Projects/plan.md", "saved on the phone meanwhile\n", 3_000);
    await phone.settle();
    await expect(
      laptop.transport.restore({ uid: again.toUid, head: again.head, folder: "Projects" }),
    ).rejects.toMatchObject({ code: "stale" });
    await laptop.settle();
    expect(laptop.vault.text("Projects/plan.md")).toBe("saved on the phone meanwhile\n");
  }, 240_000);
});

describe("a device's restore, through the client", () => {
  const pause = () => new Promise((r) => setTimeout(r, 50));

  async function client(): Promise<{ c: Client; vault: MemoryVault; store: MemoryIndexStore }> {
    server = new TestServer();
    await server.start();
    const vault = new MemoryVault();
    const store = new MemoryIndexStore();
    const c = new Client({
      vault,
      store,
      url: server.wsUrl,
      ...(await server.deviceCredentials()),
      vaultId: "default",
      device: "a",
      timeoutMs: 20_000,
      coalesceWrites: false,
    });
    closers.push(() => c.close());
    await c.connect();
    return { c, vault, store };
  }

  /**
   * Committed is committed: a pass that cannot save afterwards does not undo
   * it, and the caller still gets the operation to offer Undo with. Found by
   * review, 2026-10-23: the error hid the restore and its Undo.
   */
  it("returns a committed restore when putting it on disk fails", async () => {
    const { c, vault, store } = await client();
    await vault.edit("note.md", "then\n", 1_000);
    await c.settle();
    await pause();
    const then = Date.now();
    await pause();
    await vault.edit("note.md", "now\n", 2_000);
    await c.settle();
    const preview = await c.restoreTo({ at: then });
    // The disk fills the moment the server has committed it.
    const transport = (c as unknown as { transport: Transport }).transport;
    const restore = transport.restore.bind(transport);
    transport.restore = async (ask) => {
      const out = await restore(ask);
      store.save = async () => {
        throw new Error("ENOSPC: no space left on device");
      };
      return out;
    };
    const done = await c.restoreTo({ uid: preview.toUid, head: preview.head });
    expect(done.opId).toBeTruthy();
    expect(await server!.cli("cat", "-path", "note.md")).toBe("then\n");
  }, 240_000);

  /** Applying a preview that changes nothing commits nothing, and says so. Found by review. */
  it("applies a preview that changes nothing as nothing, and keeps the session", async () => {
    const { c, vault } = await client();
    await vault.edit("note.md", "the same\n", 1_000);
    await c.settle();
    await pause();
    const preview = await c.restoreTo({ at: Date.now() });
    expect(preview.restore + preview.remove + preview.removeFolder).toBe(0);
    const done = await c.restoreTo({ uid: preview.toUid, head: preview.head });
    expect(done.opId).toBeUndefined();
    expect((await c.history("note.md")).length).toBe(1);
  }, 240_000);
});
