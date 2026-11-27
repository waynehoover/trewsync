import { afterEach, expect, it, vi } from "vitest";
import { Client } from "./client.ts";
import { Transport } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer } from "../../test/core/test-server.ts";
import { receiveCommitted } from "../../test/core/test-async.ts";

let server: TestServer;
let client: Client;
afterEach(async () => {
  await client?.close();
  await server?.cleanup();
});
it("returns to an edited open note before preparing the remaining attachments", async () => {
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault(),
    order: string[] = [];
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials()),
    vaultId: "default",
    device: "phone",
    inspect: true,
    activePath: () => "note.md",
    onActivity: (event) => {
      if (event.action === "uploaded") order.push(event.path!);
    },
  });
  await client.connect();
  await vault.edit("note.md", "before");
  await client.engine.sync({ coalesceWrites: false });
  order.length = 0;
  await vault.edit("a.bin", "attachment-a");
  await vault.edit("z.bin", "attachment-z");
  const read = vault.read.bind(vault);
  let changed = false;
  vault.read = async (path) => {
    if (path === "a.bin" && !changed) {
      changed = true;
      await vault.edit("note.md", "edited while transferring");
      client.noteChanged("note.md");
    }
    return read(path);
  };
  await client.engine.sync({ coalesceWrites: false });
  expect(order.indexOf("note.md")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("note.md")).toBeLessThan(order.indexOf("z.bin"));
  expect(vault.text("note.md")).toBe("edited while transferring");
});

it("leaves a setting saved during a transfer to the settings rules", async () => {
  // Neon review #4. The yield to a saved note picked any dirty text file,
  // and `.json` is text, so a settings file Obsidian was half way through
  // writing went up between two bodies of an attachment with none of the
  // checks a setting gets: not parsed, no quiet period, no hold.
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault();
  const P = ".obsidian/app.json";
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials()),
    vaultId: "default",
    device: "phone",
    inspect: true,
    settings: { root: ".obsidian" },
    // An open note is what makes a large file go up with saves serviced
    // between its bodies; this one is not the setting.
    activePath: () => "note.md",
  });
  await client.connect();
  await vault.edit(P, '{"a":1}', 1_000);
  await client.engine.sync({ coalesceWrites: false });
  expect(await client.history(P)).toHaveLength(1);
  // Large enough to go up on its own connection, with saves serviced
  // between its bodies.
  const attachment = new Uint8Array(3 * 1024 * 1024);
  for (let at = 0; at < attachment.length; at += 65536)
    crypto.getRandomValues(attachment.subarray(at, at + 65536));
  await vault.write("attachment.bin", attachment, { mtime: 1, ctime: 1 });
  let changed = false;
  const put = Transport.prototype.put;
  vi.spyOn(Transport.prototype, "put").mockImplementation(function (this: Transport, ...args) {
    const interleave = args[6];
    if (interleave)
      args[6] = async () => {
        if (!changed) {
          changed = true;
          await vault.edit(P, '{"a":', 2_000);
          client.noteChanged(P);
        }
        await interleave();
      };
    return put.apply(this, args);
  });
  await client.engine.sync({ coalesceWrites: false });
  vi.restoreAllMocks();
  expect(changed, "the test never reached the window it is about").toBe(true);
  expect(await client.history(P), "a half-written setting was sent").toHaveLength(1);
});

it("does not restart the whole pass for every save to the open note", async () => {
  // The yield breaks out of the ordered walk, and the next round lists the
  // vault and re-decides every path from the start. Unbounded, one save per
  // round is one whole re-decision per save, so typing during a first sync on
  // a phone costs more in re-listing than the sync does (R083-11).
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault();
  let listings = 0;
  const list = vault.list.bind(vault);
  vault.list = async () => {
    listings++;
    return list();
  };
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials()),
    vaultId: "default",
    device: "phone",
    activePath: () => "note.md",
  });
  await client.connect();
  await vault.edit("note.md", "before");
  for (let i = 0; i < 60; i++)
    await vault.edit(`background/${String(i).padStart(3, "0")}.md`, `n${i}`);

  // Saved again the instant the engine looks at any background note, which is
  // what an autosave during a first sync does.
  let saves = 0;
  const read = vault.read.bind(vault);
  vault.read = async (path) => {
    if (path.startsWith("background/") && saves < 20) {
      saves++;
      await vault.edit("note.md", `edit ${saves}`);
      client.noteChanged("note.md");
    }
    return read(path);
  };

  listings = 0;
  await client.engine.sync({ coalesceWrites: false });
  expect(saves, "the test never reached the window it is about").toBeGreaterThan(1);
  // The property is that this does not scale with the saves. A round per save
  // was one listing each, up to the eight rounds `sync` allows, which is what
  // this used to hit; one interruption per sync is a small constant whatever
  // somebody types.
  expect(listings, `${listings} whole-vault listings for ${saves} saves`).toBeLessThanOrEqual(3);
});

it.each(["oversized", "unreadable"] as const)(
  "syncs background notes when the active note is %s and has pending remote work",
  async (failure) => {
    server = new TestServer();
    server.extraArgs = ["-max-file", "64"];
    await server.start();
    const source = new MemoryVault();
    const writer = new Client({
      vault: source,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      ...(await server.deviceCredentials("writer")),
      vaultId: "default",
      device: "writer",
      coalesceWrites: false,
    });
    try {
      await writer.connect();
      await source.edit("active.md", "remote edit");
      await source.edit("background.md", "another device's note");
      await writer.settle();
      const vault = new MemoryVault();
      const local = failure === "oversized" ? "local draft ".repeat(10) : "local draft";
      await vault.edit("active.md", local);
      if (failure === "unreadable") {
        const read = vault.read.bind(vault);
        vault.read = (path) => {
          if (path === "active.md") throw new Error("temporarily unreadable");
          return read(path);
        };
      }
      client = new Client({
        vault,
        store: new MemoryIndexStore(),
        url: server.wsUrl,
        ...(await server.deviceCredentials("reader")),
        vaultId: "default",
        device: "reader",
        inspect: true,
        activePath: () => "active.md",
      });
      await client.connect();
      for (let round = 0; round < 2; round++) {
        const report = await client.engine.sync({ coalesceWrites: false });
        expect(vault.text("background.md")).toBe("another device's note");
        expect(vault.text("active.md")).toBe(local);
        if (failure === "oversized") expect(report.nextUploadAt).toBeUndefined();
        else expect(report.nextUploadAt).toBeGreaterThan(Date.now());
        expect(report.appliedCursor).toBeUndefined();
        expect(failure === "oversized" ? report.skipped : report.retrying).toBe(1);
      }
      expect(await writer.history("active.md")).toHaveLength(1);
    } finally {
      await writer.close();
    }
  },
);

it("prioritizes a remote edit arriving while the active note is being read", async () => {
  server = new TestServer();
  await server.start();
  const source = new MemoryVault();
  const writer = new Client({
    vault: source,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials("writer")),
    vaultId: "default",
    device: "writer",
    coalesceWrites: false,
  });
  try {
    await writer.connect();
    await source.edit("active.md", "before");
    await writer.settle();
    const vault = new MemoryVault();
    client = new Client({
      vault,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      ...(await server.deviceCredentials("reader")),
      vaultId: "default",
      device: "reader",
      inspect: true,
      activePath: () => "active.md",
    });
    await client.connect();
    await client.engine.sync({ coalesceWrites: false });
    expect(vault.text("active.md")).toBe("before");
    await vault.edit("background.bin", "attachment");
    const read = vault.read.bind(vault);
    let arrived = false;
    let readAttachment = false;
    vault.read = async (path) => {
      if (path === "active.md" && !arrived) {
        arrived = true;
        await source.edit("active.md", "incoming edit");
        await writer.settle();
        await receiveCommitted(client.transport);
      }
      if (path === "background.bin") {
        readAttachment = true;
        expect(vault.text("active.md")).toBe("incoming edit");
      }
      return read(path);
    };
    client.noteChanged("active.md");
    const report = await client.engine.sync({ coalesceWrites: false });
    expect(arrived && readAttachment).toBe(true);
    expect(vault.text("active.md")).toBe("incoming edit");
    expect(report.retrying).toBe(0);
    expect(report.nextUploadAt).toBeUndefined();
  } finally {
    await writer.close();
  }
});
