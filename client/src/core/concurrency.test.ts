/** Sync, history and restore share one operation queue. Request IDs route
 * replies, while the queue also protects binary exchanges and local writes. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer;
let client: Client | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (server) await server.cleanup();
});

async function ready(): Promise<{ client: Client; vault: MemoryVault }> {
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault();
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials()),
    vaultId: "default",
    device: "a",
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  await client.connect();
  return { client, vault };
}

describe("a recovery question during a sync", () => {
  it("does not collide with the sync in progress", async () => {
    const { client: c, vault } = await ready();
    for (let i = 0; i < 12; i++) await vault.edit(`note-${i}.md`, `body ${i}\n`);
    await c.settle();
    await vault.remove("note-3.md");
    await c.settle();

    // Both started without waiting for the other, which is what a person
    // opening the recovery list during a background sync produces.
    for (let round = 0; round < 5; round++) {
      await vault.edit(`churn-${round}.md`, `round ${round}\n`);
      const syncing = c.settle();
      const asking = c.deleted();
      const [, gone] = await Promise.all([syncing, asking]);
      expect(gone.notes.map((v) => v.path)).toContain("note-3.md");
    }
  }, 300_000);

  it("asks whether settings sync has anything to choose only between passes, never inside or behind one", async () => {
    const { client: c, vault } = await ready();
    await c.settle();
    // Held just after the server has asked for the note's chunks, when the
    // next frame it reads has to be one of them.
    const transport = c.transport as unknown as {
      sendBodies(...args: unknown[]): Promise<number>;
    };
    const send = transport.sendBodies.bind(transport);
    let reached!: () => void;
    const inside = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    transport.sendBodies = async (...args) => {
      reached();
      await held;
      return send(...args);
    };
    await vault.edit("note.md", "a note\n");
    const syncing = c.settle();
    await inside;
    const settings = [{ path: ".obsidian/app.json", bytes: new TextEncoder().encode("{}") }];
    expect(await c.settingsToChoose(settings), "unasked, and not waiting").toBeUndefined();
    release();
    await syncing;
    expect((await c.history("note.md")).length, "the note reached the server").toBe(1);
    expect(await c.settingsToChoose(settings), "asked once nothing else is").toBe(false);
  }, 300_000);

  it("does not collide with another recovery question", async () => {
    const { client: c, vault } = await ready();
    await vault.edit("note.md", "one\n");
    await c.settle();
    await vault.edit("note.md", "two\n");
    await c.settle();

    const [history, deleted] = await Promise.all([c.history("note.md"), c.deleted()]);
    expect(history.length).toBe(2);
    expect(deleted.notes).toEqual([]);
  }, 300_000);

  it("restores while a sync is running", async () => {
    const { client: c, vault } = await ready();
    await vault.edit("gone.md", "# Gone\n");
    await c.settle();
    await vault.remove("gone.md");
    await c.settle();

    const version = await c.newestContentVersion("gone.md");
    await vault.edit("busy.md", "keeping the engine occupied\n");
    const [, restored] = await Promise.all([c.settle(), c.restore(version!)]);
    expect(restored.path).toBe("gone.md");
    expect(vault.text("gone.md")).toBe("# Gone\n");
  }, 300_000);
});
