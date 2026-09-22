/** Sync, history and restore share one operation queue. Request IDs route
 * replies, while the queue also protects binary exchanges and local writes. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { testWrapped } from "./test-keys.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const SECRET = new Uint8Array(32).fill(9);
let wrapped: string;
beforeAll(async () => {
  await serverBinary();
  wrapped = await testWrapped(SECRET);
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
    ...(await server.deviceCredentials(SECRET, wrapped)),
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
