/** Production sync timing, real clients and a real server; no manual retry loop. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Client, type ClientOptions } from "./client.ts";
import type { SyncReport } from "./engine.ts";
import type { TransferActivity } from "./transfer.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";
import { deferred, receiveCommitted, within } from "./test-async.ts";
import { MemoryIndexStore, MemoryVault, type StoredState } from "./vault.ts";

// Events are delivered explicitly so unrelated writes cannot accidentally wake
// a deferred upload and conceal a missing deadline timer.
class ManualVault extends MemoryVault {
  override watch(): () => void {
    return () => {};
  }
}

const secret = new Uint8Array(32).fill(93);
const clients: Client[] = [];
const loops: Promise<Error>[] = [];
let server: TestServer;
let wrapped: string;

beforeAll(async () => {
  await serverBinary();
  wrapped = await testWrapped(secret);
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await Promise.all(loops.splice(0));
  await server?.cleanup();
});
afterAll(cleanupBinary);

async function pair(
  seed: Record<string, string> = { "file.bin": "original\n" },
  receiverOptions: Partial<ClientOptions> = {},
  senderOptions: Partial<ClientOptions> = {},
) {
  server = new TestServer();
  await server.start();
  const av = new ManualVault();
  const bv = new ManualVault();
  const reports: SyncReport[] = [];
  const make = async (device: string, vault: MemoryVault, extra: Partial<ClientOptions> = {}) => {
    const client = new Client({
      vault,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      ...(await server.deviceCredentials(secret, wrapped, device)),
      vaultId: "default",
      device,
      ...extra,
    });
    clients.push(client);
    await client.connect();
    return client;
  };
  for (const [path, body] of Object.entries(seed)) await av.edit(path, body);
  const a = await make("sender", av, {
    onPass: (report) => void reports.push(report),
    ...senderOptions,
  });
  await a.settle({ coalesceWrites: false });
  const b = await make("receiver", bv, receiverOptions);
  await b.settle({ coalesceWrites: false });
  for (const [path, body] of Object.entries(seed)) expect(bv.text(path)).toBe(body);
  // Startup metadata must be verified; connect no longer schedules a catch-up nudge.
  await Promise.all([a.transport.drainReceived(), b.transport.drainReceived()]);
  return { a, b, av, bv, reports };
}

describe("automatic sync cadence", () => {
  it("wakes at a transient read retry deadline without another file event", async () => {
    const completed = deferred<SyncReport>();
    const { a, b, av, bv } = await pair(
      {},
      {},
      {
        onPass: (report) => {
          if (report.uploaded === 1) completed.resolve(report);
        },
      },
    );
    let unavailable = true;
    const read = av.read.bind(av);
    av.read = async (path) => {
      if (unavailable) throw new Error("temporarily unavailable");
      return read(path);
    };
    await av.edit("retry.md", "Saved content survives a transient read failure.\n");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const now = Date.now();
      const failed = await a.sync();
      expect(failed?.nextUploadAt).toBe(now + 10_000);
      loops.push(a.runUntilClosed());
      unavailable = false;
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
    const retried = await within(completed.promise, "scheduled retry upload");
    expect(retried.retrying).toBe(0);
    expect(retried.nextUploadAt).toBeUndefined();
    await receiveCommitted(b.transport);
    await b.settle();
    expect(bv.text("retry.md")).toBe("Saved content survives a transient read failure.\n");
    expect(av.text("retry.md")).toBe(bv.text("retry.md"));
  });

  it("sends the current note before a slow background note can hold the pass", async () => {
    const { a, b, av, bv } = await pair({}, {}, { activePath: () => "z-current.md" });
    loops.push(b.runUntilClosed());
    await av.edit("a-background.md", "background note\n");
    await av.edit("z-current.md", "the note being edited\n");
    const gate = deferred();
    const read = av.read.bind(av);
    av.read = async (path) => {
      if (path === "a-background.md") await gate.promise;
      return read(path);
    };
    const pass = a.sync();
    try {
      await until(
        "current note before background read",
        () => bv.text("z-current.md") === "the note being edited\n",
        1500,
      );
      expect(bv.text("a-background.md")).toBeUndefined();
    } finally {
      gate.resolve();
      await pass;
    }
    await until("background note", () => bv.text("a-background.md") === "background note\n");
  });

  it("applies the open note before a background download can block it", async () => {
    const { a, b, av, bv } = await pair({}, { activePath: () => "z-current.md" });
    const scanGate = deferred();
    const list = bv.list.bind(bv);
    bv.list = async () => {
      await scanGate.promise;
      return list();
    };
    const gate = deferred();
    const entered = deferred();
    const write = bv.write.bind(bv);
    bv.write = async (path, bytes, times) => {
      if (path === "a-background.md") {
        entered.resolve();
        await gate.promise;
      }
      await write(path, bytes, times);
    };
    await av.edit("a-background.md", "background note\n");
    await av.edit("z-current.md", "open note update\n");
    await a.sync();
    try {
      await receiveCommitted(b.transport);
      scanGate.resolve();
      await within(entered.promise, "background download to start");
      expect(bv.text("z-current.md")).toBe("open note update\n");
    } finally {
      scanGate.resolve();
      gate.resolve();
      await b.sync();
    }
    expect(bv.text("a-background.md")).toBe("background note\n");
  });

  it("reports deduplicated batch transfers and remains unconfirmed until the index is saved", async () => {
    const uploads: (TransferActivity | undefined)[] = [];
    const downloads: (TransferActivity | undefined)[] = [];
    class GatedStore extends MemoryIndexStore {
      gate: Promise<void> | undefined;
      entered = false;
      override async save(state: StoredState): Promise<void> {
        if (this.gate) {
          this.entered = true;
          await this.gate;
        }
        await super.save(state);
      }
    }
    const store = new GatedStore();
    const { a, b, av, bv } = await pair(
      {},
      { store, onTransfer: (p) => downloads.push(p) },
      { onTransfer: (p) => uploads.push(p) },
    );
    // A deliberately small client fetch cap splits one download batch into
    // multiple requests. Counters must continue across those requests.
    (b.engine as unknown as { limits: { maxFetchBytes: number } }).limits.maxFetchBytes = 4096;
    const fetch = b.transport.fetch.bind(b.transport);
    let requests = 0;
    b.transport.fetch = async (...args) => {
      requests++;
      return fetch(...args);
    };
    const originals = ["one".repeat(1000), "two".repeat(1000), "one".repeat(1000)];
    // Hold the receiver's scan until every metadata entry has arrived. With
    // next-turn scheduling it may otherwise legitimately download the first
    // entry before the sender finishes announcing the rest of this batch.
    const list = bv.list.bind(bv);
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => (releaseScan = r));
    bv.list = async () => {
      await scanGate;
      return list();
    };
    let release!: () => void;
    store.gate = new Promise<void>((r) => (release = r));
    try {
      for (let i = 0; i < originals.length; i++) await av.edit(`${i}.bin`, originals[i]!);
      const sent = await a.sync({ coalesceWrites: false });
      await until("all batch metadata", () => b.engine.status().cursor === a.serverCursor);
      releaseScan();
      await until("the receiver's index save", () => store.entered);
      const up = uploads.filter((p): p is TransferActivity => p !== undefined);
      const down = downloads.filter((p): p is TransferActivity => p !== undefined);
      expect(up.length).toBeGreaterThan(1);
      expect(down.length).toBeGreaterThan(1);
      expect(
        up.every((p) => p.direction === "upload" && p.files === 3 && p.path === undefined),
      ).toBe(true);
      expect(
        down.every((p) => p.direction === "download" && p.files === 3 && p.path === undefined),
      ).toBe(true);
      expect(sent!.chunksSent).toBe(2);
      expect(requests).toBe(2);
      expect(up.at(-1)!.bytes).toBe(sent!.bytesSent);
      expect(down.at(-1)!.bytes).toBe(sent!.bytesSent);
      expect(down.map((p) => p.bytes)).toEqual(down.map((p) => p.bytes).sort((a, b) => a - b));
      expect(uploads.at(-1)).toBeUndefined();
      expect(downloads.at(-1)).toBeUndefined();
      expect(b.deliveryReady).toBe(false);
      for (let i = 0; i < originals.length; i++) expect(bv.text(`${i}.bin`)).toBe(originals[i]);
      release();
      await until("the saved checkpoint", () => b.deliveryReady);
      downloads.length = 0;
      const versions = await b.history("0.bin", { limit: 1 });
      expect(new TextDecoder().decode(await b.engine.contentOf(versions[0]!.uid))).toBe(
        originals[0],
      );
      expect(downloads).toEqual([]);
    } finally {
      releaseScan();
      release();
      bv.list = list;
    }
  });

  it("withholds confirmation until the applied index has been saved", async () => {
    class FailingStore extends MemoryIndexStore {
      fail = false;
      override async save(state: StoredState): Promise<void> {
        if (this.fail) throw new Error("index disk full");
        await super.save(state);
      }
    }
    const store = new FailingStore();
    const { a, b, av, bv } = await pair({ "note.md": "original\n" }, { store });
    const before = a.serverCursor;
    store.fail = true;
    await av.edit("note.md", "saved note with an unsaved index\n");
    await a.sync();
    await until("the incoming metadata", () => b.engine.status().cursor === a.serverCursor);
    expect(await b.sync()).toBeUndefined();
    expect(bv.text("note.md")).toBe("saved note with an unsaved index\n");
    expect((await a.devices()).devices.find((d) => d.id === b.deviceId)!.applied).toBe(before);
    expect(b.deliveryReady).toBe(false);
    store.fail = false;
    await b.sync();
    expect((await a.devices()).devices.find((d) => d.id === b.deviceId)!.applied).toBe(
      a.serverCursor,
    );
    expect(b.deliveryReady).toBe(true);
  });
  it("delivers a note before a slow attachment finishes being read", async () => {
    const { a, b, av, bv } = await pair({});
    loops.push(b.runUntilClosed());
    await av.edit("a-attachment.bin", "complete attachment bytes\n");
    await av.edit("z-note.md", "the note should arrive first\n");
    const read = av.read.bind(av);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    av.read = async (path) => {
      if (path === "a-attachment.bin") await gate;
      return read(path);
    };
    const pass = a.sync();
    try {
      await until(
        "the note while the attachment is still blocked",
        () => bv.text("z-note.md") === "the note should arrive first\n",
        1500,
      );
      expect(bv.text("a-attachment.bin")).toBeUndefined();
    } finally {
      release();
      await pass;
    }
    await until(
      "the complete attachment",
      () => bv.text("a-attachment.bin") === "complete attachment bytes\n",
    );
    expect(av.text("z-note.md")).toBe("the note should arrive first\n");
  });
  it("confirms delivery only after the receiving device finishes saving", async () => {
    const { a, b, av, bv } = await pair({ "note.md": "original\n" });
    const before = a.serverCursor;
    const row = async () => (await a.devices()).devices.find((d) => d.id === b.deviceId)!;
    expect((await row()).applied).toBe(before);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let replacing = false;
    bv.midReplace = async () => {
      replacing = true;
      await gate;
    };
    try {
      await av.edit("note.md", "latest saved paragraph\n");
      await a.sync();
      await until("the receiver to start saving", () => replacing);
      expect(b.engine.status().cursor).toBe(a.serverCursor);
      expect((await row()).applied).toBe(before);
      expect(bv.text("note.md")).toBe("original\n");
    } finally {
      release();
    }
    await b.sync();
    expect(bv.text("note.md")).toBe("latest saved paragraph\n");
    expect((await row()).applied).toBe(a.serverCursor);
    expect(av.text("note.md")).toBe("latest saved paragraph\n");
  });

  it("does not confirm a failed replacement", async () => {
    const { a, b, av, bv } = await pair({ "note.md": "original\n" });
    const before = a.serverCursor;
    bv.midReplace = () => {
      throw new Error("disk write failed");
    };
    await av.edit("note.md", "must reach the other device\n");
    await a.sync();
    await until("the new metadata", () => b.engine.status().cursor === a.serverCursor);
    const report = await b.sync();
    expect(report?.retrying).toBe(1);
    const other = (await a.devices()).devices.find((d) => d.id === b.deviceId)!;
    expect(other.applied).toBe(before);
    expect(bv.text("note.md")).toBe("original\n");
    expect(av.text("note.md")).toBe("must reach the other device\n");
  });
  it.each([
    ["note.md", "original\n"],
    ["large.md", "original paragraph\n".repeat(8000)],
    ["board.canvas", '{"nodes":[],"edges":[]}'],
  ])("uploads consecutive saved edits to %s in the current pass", async (path, original) => {
    const { a, b, av, bv } = await pair({ [path]: original });
    loops.push(b.runUntilClosed());
    for (const suffix of ["\n", "\n\n"]) {
      const body = original + suffix;
      await av.edit(path, body);
      const report = await a.sync();
      expect(report?.uploaded).toBe(1);
      expect(report?.waiting).toBe(0);
      expect(report?.nextUploadAt).toBeUndefined();
      await until("the saved version on the other device", () => bv.text(path) === body);
      expect(av.text(path)).toBe(body);
    }
  });

  it("delivers a deferred edit without another event or the 30 second poll", async () => {
    const { a, b, av, bv } = await pair();
    loops.push(a.runUntilClosed(), b.runUntilClosed());
    await av.edit("file.bin", "latest paragraph\n");
    expect((await a.sync())?.waiting).toBe(1);
    await until(
      "the deferred edit to arrive automatically",
      () => bv.text("file.bin") === "latest paragraph\n",
      8000,
    );
    expect(av.text("file.bin")).toBe("latest paragraph\n");
  });

  it("applies consecutive incoming versions without an upload cooldown", async () => {
    const { a, b, av, bv } = await pair();
    for (const body of ["second paragraph\n", "third paragraph\n"]) {
      await av.edit("file.bin", body);
      await a.sync({ coalesceWrites: false });
      await until(
        "the incoming version",
        () => b.engine.status().pending > 0 || bv.text("file.bin") === body,
      );
      const report = await b.sync();
      expect(bv.text("file.bin")).toBe(body);
      expect(report?.waiting).toBe(0);
      expect(av.text("file.bin")).toBe(body);
    }
  });

  it("arms the deadline when initial settling deferred an edit before watching began", async () => {
    const { a, b, av, bv } = await pair();
    await av.edit("file.bin", "saved during startup\n");
    expect((await a.settle()).waiting).toBe(1);
    loops.push(a.runUntilClosed(), b.runUntilClosed());
    await until("the startup edit", () => bv.text("file.bin") === "saved during startup\n", 8000);
    expect(av.text("file.bin")).toBe("saved during startup\n");
  });

  it("brings an earlier deadline forward and still sends the larger file later", async () => {
    const large = "attachment text\n".repeat(8000);
    const { a, b, av, bv } = await pair({ "file.bin": "original\n", "large.bin": large });
    loops.push(a.runUntilClosed(), b.runUntilClosed());
    await av.edit("large.bin", large + "latest attachment ending\n");
    expect((await a.sync())?.waiting).toBe(1);
    await av.edit("file.bin", "latest note\n");
    expect((await a.sync())?.waiting).toBe(2);
    await until(
      "the small attachment's earlier deadline",
      () => bv.text("file.bin") === "latest note\n",
      3500,
    );
    expect(bv.text("large.bin")).toBe(large);
    await until(
      "the remaining attachment deadline",
      () => bv.text("large.bin") === large + "latest attachment ending\n",
      8000,
    );
    expect(av.text("large.bin")).toBe(large + "latest attachment ending\n");
  });

  it("does not retry a deferred upload after the client has closed", async () => {
    const { a, av, bv, reports } = await pair();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      loops.push(a.runUntilClosed());
      await av.edit("file.bin", "unsent local edit\n");
      expect((await a.sync())?.waiting).toBe(1);
      await a.close();
      const passes = reports.length;
      const sync = vi.spyOn(a.engine, "sync");
      await vi.advanceTimersByTimeAsync(1300);
      expect(sync).not.toHaveBeenCalled();
      expect(reports).toHaveLength(passes);
      expect(bv.text("file.bin")).toBe("original\n");
      expect(av.text("file.bin")).toBe("unsent local edit\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the deadline when the edit is undone and leaves the idle vault alone", async () => {
    const { a, av, bv, reports } = await pair();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      loops.push(a.runUntilClosed());
      await av.edit("file.bin", "temporary edit\n");
      expect((await a.sync())?.waiting).toBe(1);
      await av.edit("file.bin", "original\n");
      expect((await a.sync())?.waiting).toBe(0);
      const passes = reports.length;
      const sync = vi.spyOn(a.engine, "sync");
      await vi.advanceTimersByTimeAsync(1300);
      expect(sync).not.toHaveBeenCalled();
      expect(reports).toHaveLength(passes);
      expect(av.text("file.bin")).toBe("original\n");
      expect(bv.text("file.bin")).toBe("original\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves every paragraph through rapid consecutive note uploads", async () => {
    const { a, b, av, bv, reports } = await pair({ "note.md": "original\n" });
    loops.push(a.runUntilClosed(), b.runUntilClosed());
    reports.length = 0;
    let body = "original\n";
    for (let i = 0; i < 20; i++) {
      body += `kept paragraph ${i}\n`;
      await av.edit("note.md", body);
      await a.sync();
    }
    await until("every saved paragraph", () => bv.text("note.md") === body, 8000);
    expect(av.text("note.md")).toBe(body);
    expect(reports.reduce((n, r) => n + r.uploaded, 0)).toBe(20);
  });

  it("reports a mirror's local edit as held back instead of scheduling an upload", async () => {
    const { b, bv } = await pair(undefined, { readOnly: true });
    loops.push(b.runUntilClosed());
    await bv.edit("file.bin", "local mirror edit\n");
    const report = await b.sync();
    expect(report?.heldBack).toBe(1);
    expect(report?.waiting).toBe(0);
    expect(report?.nextUploadAt).toBeUndefined();
    expect(bv.text("file.bin")).toBe("local mirror edit\n");
  });

  it("does not turn a one-shot client's deferred pass into a background upload", async () => {
    const { a, av, bv, reports } = await pair();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await av.edit("file.bin", "local one-shot edit\n");
      expect((await a.sync())?.waiting).toBe(1);
      const passes = reports.length;
      const sync = vi.spyOn(a.engine, "sync");
      await vi.advanceTimersByTimeAsync(1300);
      expect(sync).not.toHaveBeenCalled();
      expect(reports).toHaveLength(passes);
      expect(av.text("file.bin")).toBe("local one-shot edit\n");
      expect(bv.text("file.bin")).toBe("original\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves both devices' paragraphs when note uploads overlap", async () => {
    const { a, b, av, bv } = await pair({ "note.md": "original\n" });
    loops.push(a.runUntilClosed(), b.runUntilClosed());
    await av.edit("note.md", "laptop paragraph\noriginal\n");
    await bv.edit("note.md", "original\nphone paragraph\n");
    await Promise.all([a.sync(), b.sync()]);
    const hasBoth = (vault: MemoryVault) => {
      const bodies = Object.values(vault.snapshot()).join("\n");
      return (
        bodies.includes("laptop paragraph\noriginal\n") &&
        bodies.includes("original\nphone paragraph\n")
      );
    };
    await until(
      "both edits to be preserved on both devices",
      () => hasBoth(av) && hasBoth(bv),
      8000,
    );
  });
});
