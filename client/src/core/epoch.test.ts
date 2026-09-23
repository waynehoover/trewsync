/**
 * A server whose history was replaced under a device that had moved on.
 *
 * Every store has an epoch, and every backup is given one of its own, so a
 * data directory restored from a backup answers `ready` with an epoch no
 * device has seen. A device's hello carries the epoch its cursor was read
 * under; the server, seeing another, does not honour the cursor either way and
 * replays the whole vault from uid 1 (plan/protocol.md, "Device session"). The
 * device has to read that replay as a fresh listing and not as history it
 * already applied: the uids it remembers may now name other versions, and a
 * version it synced may not be there at all.
 *
 * What a device must not do with it is lose anything (rule 3, rule 10): a note
 * edited since the backup keeps its newer bytes, the older version it
 * replaced is kept beside it, a note added since goes up again, and nothing
 * is deleted on the strength of a history that has been replaced.
 *
 * One device, at the engine level. The same restore seen by several devices
 * that each moved on differently is the stress suite's
 * (durability.stress.ts, "a server restored from a backup its devices have
 * moved past").
 */

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { Engine, type SyncReport } from "./engine.ts";
import { FakeSocket, engineOnFakeSocket, ready, settle, settleUntil } from "./fake-socket.ts";
import { receiveCommitted } from "./test-async.ts";
import { TestServer, cleanupBinary, removeTree, serverBinary, until } from "./test-server.ts";
import { Transport, type ServerLimits, type SocketLike, type WireEntry } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

/** One device, which keeps its credentials across connections as a paired one does. */
class Device {
  readonly store = new MemoryIndexStore();
  readonly vault = new MemoryVault();
  transport!: Transport;
  engine!: Engine;
  caughtUp = false;
  clock = 1_000_000;
  /** Every text frame this device has sent, on every connection. */
  readonly sent: Record<string, unknown>[] = [];
  readonly logs: string[] = [];
  private credentials: { deviceId: string; token: string } | undefined;

  constructor(readonly name: string) {}

  async connect(server: TestServer): Promise<ServerLimits> {
    this.credentials ??= await server.deviceCredentials(this.name);
    this.caughtUp = false;
    this.transport = new Transport(server.wsUrl, {
      onBatch: (b) => this.engine.acceptBatch(b),
      onCaughtUp: () => {
        this.caughtUp = true;
      },
      timeoutMs: 20_000,
      // The platform's socket, with what goes out of it kept, so the hello
      // can be read back rather than inferred.
      socketFactory: (url) => {
        const ws = new WebSocket(url) as unknown as SocketLike;
        const send = ws.send.bind(ws);
        ws.send = (data) => {
          if (typeof data === "string") this.sent.push(JSON.parse(data) as Record<string, unknown>);
          send(data);
        };
        return ws;
      },
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
      log: (m, ...rest) =>
        void this.logs.push(`${m} ${rest.map((r) => JSON.stringify(r)).join(" ")}`),
    });
    await this.transport.connect();
    const limits = await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
    return limits;
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
const dirs: string[] = [];

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  await server?.cleanup();
  server = undefined;
  while (dirs.length) await removeTree(dirs.pop()!);
});

/** The newest uid the server holds, from its own report on itself. */
async function latestUid(s: TestServer): Promise<number> {
  const stats = JSON.parse(await s.cli("stats", "-json")) as { vaults: { latestUid: number }[] };
  return stats.vaults[0]!.latestUid;
}

const sum = (reports: SyncReport[], key: keyof SyncReport) =>
  reports.reduce((n, r) => n + (r[key] as number), 0);

describe("a server restored from a backup this device has moved past", () => {
  it("is read as a fresh listing: nothing lost, both versions kept, the new epoch stored", async () => {
    server = new TestServer();
    await server.start();
    const a = new Device("a");
    devices.push(a);
    await a.connect(server);

    const kept = "unchanged since the backup\n";
    const before = "the version in the backup\n";
    const after = "edited after the backup, and not in it\n";
    const added = "added after the backup\n";
    await a.vault.edit("kept.md", kept, 1_000);
    await a.vault.edit("edited.md", before, 1_000);
    await a.settle();
    const epochBefore = (await a.store.load())?.epoch;
    expect(epochBefore, "the device never stored the epoch it synced under").toBeTruthy();

    // A backup, taken the way the runbook takes one: the server stopped and
    // `trew backup` run against its data directory.
    const offsite = join(await mkdtemp(join(tmpdir(), "trew-epoch-")), "offsite");
    dirs.push(offsite);
    a.close();
    await server.whileStopped(async () => {
      await server!.cli("backup", "-to", offsite);
    });
    // The same store, so the same epoch: nothing about this is a restore yet.
    expect((await a.connect(server)).epoch).toBe(epochBefore);

    // The device moves on past the backup.
    await a.vault.edit("edited.md", after, 2_000);
    await a.vault.edit("added.md", added, 2_000);
    await a.settle();
    const movedOn = (await a.store.load())!;
    expect(movedOn.epoch).toBe(epochBefore);
    const heldBefore = a.vault.snapshot();
    expect(heldBefore).toEqual({ "kept.md": kept, "edited.md": after, "added.md": added });

    // The data directory replaced by the backup, restored as the runbook
    // restores one (a copy, checked deeply before it is served), and the
    // server started on it again, on the same port.
    a.close();
    await server.whileStopped(async () => {
      await removeTree(server!.dataDir);
      await cp(offsite, server!.dataDir, { recursive: true });
      expect(await server!.cli("verify", "-deep")).toMatch(/0 faults/);
    });

    const sentBefore = a.sent.length;
    const limits = await a.connect(server);
    // The hello said which history its cursor belongs to, and the ready
    // answered with another one.
    const hello = a.sent.slice(sentBefore).find((f) => f["op"] === "hello")!;
    expect(hello["epoch"]).toBe(epochBefore);
    expect(hello["cursor"]).toBe(movedOn.cursor);
    expect(
      limits.epoch,
      "a restored store answered with the epoch it was backed up under",
    ).not.toBe(epochBefore);
    expect(a.transport.historyReplaced).toBe(true);
    // Replayed from uid 1, not refused for a cursor ahead of the store.
    expect(limits.cursor).toBeLessThan(movedOn.cursor);

    const reports = await a.settle(6);

    // Rule 10: every note this device held is still here, byte for byte.
    for (const [path, text] of Object.entries(heldBefore)) {
      expect(a.vault.text(path), `${path} was lost or overwritten`).toBe(text);
    }
    expect(sum(reports, "deletedLocally"), "a replaced history deleted a note here").toBe(0);
    expect(sum(reports, "deletedRemotely"), "a replaced history deleted a note there").toBe(0);

    // The note edited since the backup keeps its newer bytes, and the version
    // the backup holds is kept beside it, as a conflict copy, which went up
    // too; the newer bytes went up under the note's own name.
    const copies = a.vault.paths().filter((p) => p !== "edited.md" && a.vault.text(p) === before);
    expect(copies, JSON.stringify(a.vault.paths())).toHaveLength(1);
    expect(copies[0]).toMatch(/^edited \(Conflicted copy a .*\)\.md$/);
    expect(await server.cli("cat", "-path", "edited.md")).toBe(after);
    expect(await server.cli("cat", "-path", copies[0]!)).toBe(before);
    // The note that agreed is not copied: the same content is agreement.
    expect(a.vault.paths().filter((p) => p.startsWith("kept ("))).toEqual([]);
    expect(await server.cli("cat", "-path", "kept.md")).toBe(kept);

    // The note added since the backup is on the restored server.
    expect(await server.cli("cat", "-path", "added.md")).toBe(added);

    // The index now names the new history, at a cursor inside it.
    const stored = (await a.store.load())!;
    expect(stored.epoch).toBe(limits.epoch);
    expect(stored.cursor).toBe(await latestUid(server));

    // And the next sync has nothing to do.
    const quiet = await a.engine.sync();
    for (const key of [
      "uploaded",
      "downloaded",
      "merged",
      "conflicted",
      "deletedLocally",
      "deletedRemotely",
    ] as const) {
      expect(quiet[key], `the pass after the restore still had ${key}`).toBe(0);
    }
  }, 240_000);
});

/**
 * The replay can arrive with its `ready`, in the same turn, before `start`
 * has heard anything. The transport resets its cursor the moment the `ready`
 * lands, and the engine reads the batch as the start of a fresh listing
 * either way; refused as a gap, or read against the old history, the replay
 * would end the session or be applied as versions this device already had.
 */
describe("a replay whose first batch lands with its ready", () => {
  it("is taken, before start has heard the ready, as the start of a fresh listing", async () => {
    const text = "a note synced in the old history\n";
    const raw = new TextEncoder().encode(text);
    const name = await chunkName(raw);
    const entry = (uid: number): WireEntry => ({
      uid,
      path: "note.md",
      size: raw.length,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [name],
      device: "other",
    });

    // A device that synced a note at uid 7 of an old history.
    const store = new MemoryIndexStore();
    const vault = new MemoryVault();
    const old = await engineOnFakeSocket({ epoch: "the-old-history" }, { store, vault });
    old.socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch") s.bodies(raw);
    };
    old.socket.raw({ op: "batch", from: 1, to: 7, entries: [entry(7)] });
    await settleUntil("the batch to be taken", () => old.engine.status().pending === 1);
    await old.engine.sync({ coalesceWrites: false });
    old.t.close();
    expect(vault.snapshot()).toEqual({ "note.md": text });
    expect(await store.load()).toMatchObject({ cursor: 7, epoch: "the-old-history" });

    // The same device against the restored server.
    const socket = new FakeSocket();
    let engine!: Engine;
    let heard = false;
    const heardWhenApplied: boolean[] = [];
    const t = new Transport("ws://test", {
      onBatch: async (b) => {
        heardWhenApplied.push(heard);
        await engine.acceptBatch(b);
      },
      socketFactory: () => socket,
      timeoutMs: 2000,
    });
    const connecting = t.connect();
    socket.open();
    await connecting;
    engine = new Engine({
      vault,
      store,
      transport: t,
      device: "d",
      vaultId: "v",
      deviceId: "rig-device",
      token: "t",
    });
    const started = engine.start().then((limits) => {
      heard = true;
      return limits;
    });
    await settleUntil("the hello", () => socket.sentText.some((m) => m["op"] === "hello"));
    const hello = socket.sentText.find((m) => m["op"] === "hello")!;
    expect(hello).toMatchObject({ epoch: "the-old-history", cursor: 7 });

    // The ready, the replay's first batch and the end of the backlog, in one
    // turn, which is how a loopback server delivers them.
    socket.raw(
      ready({
        id: hello["id"],
        epoch: "a-new-history",
        cursor: 1,
        perFileMax: 1 << 28,
        maxChunks: 100,
      }),
    );
    socket.raw({ op: "batch", from: 1, to: 1, entries: [entry(1)] });
    socket.raw({ op: "caught-up", cursor: 1 });
    const limits = await started;

    expect(
      heardWhenApplied,
      "the replay's first batch did not come before the ready was heard",
    ).toEqual([false]);
    expect(t.isClosed, "the replay was refused as a gap").toBe(false);
    expect(limits.epoch).toBe("a-new-history");
    expect(engine.status().cursor).toBe(1);

    // Read as a fresh listing: the note it replays is the one this device
    // holds, so the pass agrees and changes nothing.
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "applied") s.reply({ res: "applied", cursor: frame["applied"] });
      else if (frame["op"] === "ping") s.raw({ res: "pong" });
    };
    const report = await engine.sync({ coalesceWrites: false });
    await settle();
    expect(vault.snapshot()).toEqual({ "note.md": text });
    expect(report.conflicted + report.deletedLocally + report.uploaded + report.downloaded).toBe(0);
    expect(await store.load()).toMatchObject({ cursor: 1, epoch: "a-new-history" });
    t.close();
  });
});
