import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import { MemoryVault, MemoryIndexStore } from "./vault.ts";
import { TestServer } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";
import { previewCounts } from "./preview.ts";
import type { ClientOptions } from "./client.ts";

let server: TestServer;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server?.cleanup();
});
async function setup() {
  server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(49),
    wrapped = await testWrapped(secret);
  return async (device: string, extra: Partial<ClientOptions> = {}) => {
    const vault = new MemoryVault(),
      store = new MemoryIndexStore();
    const client = new Client({
      vault,
      store,
      url: server.wsUrl,
      vaultId: "default",
      device,
      coalesceWrites: false,
      ...(await server.deviceCredentials(secret, wrapped, device)),
      ...extra,
    });
    clients.push(client);
    await client.connect();
    return { client, vault, store };
  };
}
it("previews uploads, downloads and preserved copies without changing notes or the index", async () => {
  const device = await setup(),
    a = await device("a"),
    b = await device("b", { inspect: true });
  await a.vault.edit("shared.md", "server version");
  await a.vault.edit("remote.md", "remote");
  await a.client.settle();
  await b.vault.edit("shared.md", "local version");
  await b.vault.edit("local.md", "local");
  await b.client.transport.ping();
  await b.client.transport.drainReceived();
  const files = b.vault.snapshot(),
    index = await b.store.load();
  const plan = await b.client.preview();
  expect(previewCounts(plan)).toMatchObject({ upload: 1, download: 1, copy: 1 });
  expect(b.vault.snapshot()).toEqual(files);
  expect(await b.store.load()).toEqual(index);
});
it("waits for a populated first-sync decision before touching either side", async () => {
  const device = await setup(),
    a = await device("a");
  await a.vault.edit("shared.md", "remote");
  await a.client.settle();
  const vault = new MemoryVault();
  await vault.edit("shared.md", "local");
  let asked = 0;
  const b = await device("b", {
    vault,
    inspect: true,
    confirmFirstSync: async (plan) => {
      asked++;
      expect(previewCounts(plan).copy).toBe(1);
      return false;
    },
  });
  await expect(b.client.engine.sync()).rejects.toThrow(/paused/);
  expect(asked).toBe(1);
  expect(vault.text("shared.md")).toBe("local");
  expect(await a.client.history("shared.md")).toHaveLength(1);
});
it("guards whole-folder deletion but permits an individual note deletion", async () => {
  const device = await setup();
  let asked = 0;
  const a = await device("a", {
    confirmDeletions: async (plan) => {
      asked++;
      expect(previewCounts(plan)["delete-server"]).toBe(2);
      return false;
    },
  });
  await a.vault.mkdir("folder");
  await a.vault.edit("folder/a.md", "a");
  await a.vault.edit("folder/b.md", "b");
  await a.vault.edit("single.md", "single");
  await a.client.settle();
  await a.vault.remove("single.md");
  await a.client.settle();
  expect(asked).toBe(0);
  await a.vault.remove("folder/a.md");
  await a.vault.remove("folder/b.md");
  await a.vault.remove("folder");
  await expect(a.client.settle()).rejects.toThrow(/paused/);
  expect(asked).toBe(1);
  expect((await a.client.history("folder/a.md"))[0]?.deleted).toBe(false);
});
