import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import { MemoryVault, MemoryIndexStore, type StoredState } from "./vault.ts";
import { TestServer } from "./test-server.ts";
import { previewCounts, type SyncPreview } from "./preview.ts";
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
      ...(await server.deviceCredentials(device)),
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
/**
 * The first-sync review is for a vault where something local is at stake
 * (T12). One where every local file is already the server's and the rest only
 * arrives has nothing to review, and asking blocked the sync until somebody
 * answered: on a phone, every time a first sync was interrupted.
 */
it("does not ask for a first-sync review when nothing local is at stake (T12)", async () => {
  const device = await setup(),
    a = await device("a");
  await a.vault.edit("same.md", "the same text\n");
  await a.vault.edit("theirs.md", "only on the server\n");
  await a.client.settle();
  const vault = new MemoryVault();
  await vault.edit("same.md", "the same text\n");
  let asked = 0;
  const b = await device("b", {
    vault,
    confirmFirstSync: async () => {
      asked++;
      return true;
    },
  });
  await b.client.settle();
  expect(asked, "a review with nothing to decide was asked").toBe(0);
  expect(vault.text("theirs.md")).toBe("only on the server\n");
  expect(vault.text("same.md")).toBe("the same text\n");
});
/**
 * A first sync that dies before the end of its pass, as Obsidian on a phone
 * does when Android reclaims it (T12). The index was saved only at the end of
 * a pass, so the restart had none: it asked for the first-sync review again and
 * read and hashed every note that had already landed, twice.
 */
it("resumes an interrupted first sync without asking again or reading what landed (T12)", async () => {
  const device = await setup(),
    a = await device("a");
  // A full batch of downloads, which is when a long pass saves its progress.
  for (let i = 0; i < 256; i++) await a.vault.edit(`Notes/note-${i}.md`, `note ${i}\n`);
  await a.client.settle();

  // The phone dies after its downloads have landed and before the pass's own
  // index save at the end.
  const vault = new MemoryVault();
  const kept = new MemoryIndexStore();
  let killed = false;
  const store = {
    load: () => kept.load(),
    save: async (state: StoredState) => {
      if (killed) throw new Error("process killed");
      await kept.save(state);
    },
  };
  const reviews: SyncPreview[] = [];
  const confirmFirstSync = async (plan: SyncPreview) => {
    reviews.push(plan);
    return true;
  };
  const credentials = await server.deviceCredentials("phone");
  const phone = await device("phone", {
    vault,
    store,
    confirmFirstSync,
    onProgress: (path) => {
      if (path === undefined) killed = true;
    },
    ...credentials,
  });
  await expect(phone.client.settle()).rejects.toThrow(/process killed/);
  await phone.client.close();
  expect(vault.paths(), "the downloads did not land").toHaveLength(256);

  // The next start, with the same credentials and what the store kept.
  const read = vault.reads;
  const again = await device("phone", { vault, store: kept, confirmFirstSync, ...credentials });
  const report = await again.client.settle();
  expect(reviews, "the first-sync review was asked again").toHaveLength(0);
  expect(vault.reads - read, "the notes that had landed were read again").toBe(0);
  expect(report.downloaded).toBe(0);
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
