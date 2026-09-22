import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import { sealPath } from "./crypto.ts";
import { testWrapped } from "./test-keys.ts";
import { TestServer } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { receiveCommitted } from "./test-async.ts";

const secret = new Uint8Array(32).fill(61);
let server: TestServer;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server?.cleanup();
});

async function connect(name: string, vault = new MemoryVault()) {
  const client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, await testWrapped(secret), name)),
    vaultId: "default",
    device: name,
    inspect: true,
    coalesceWrites: false,
  });
  clients.push(client);
  await client.connect();
  return { client, vault };
}

it("isolates an unavailable chunk from healthy notes in the same download batch", async () => {
  server = new TestServer();
  await server.start();
  const writer = await connect("writer");
  await writer.vault.edit("a-damaged.md", "damaged note content");
  await writer.vault.edit("b-healthy.md", "healthy note content");
  await writer.client.engine.sync();
  const history = await writer.client.transport.history(
    await sealPath(writer.client.keys, "a-damaged.md"),
  );
  const chunk = history[0]!.chunks[0]!;
  const namespace = createHash("sha256").update("default").digest("hex");
  await rm(join(server.dataDir, "chunks", namespace, chunk.slice(0, 2), chunk));
  const reader = await connect("reader");
  const report = await reader.client.engine.sync();
  expect(reader.vault.text("b-healthy.md")).toBe("healthy note content");
  expect(reader.vault.text("a-damaged.md")).toBeUndefined();
  expect(report.retryingPaths).toEqual(["a-damaged.md"]);
});

it.each([undefined, "new note using the source name", "original content"])(
  "records source retirement when a peer edits a rename destination before its acknowledgement settles (source reused: %s)",
  async (reuseSource) => {
    server = new TestServer();
    await server.start();
    const a = await connect("a"),
      b = await connect("b");
    await a.vault.edit("from.md", "original content");
    await a.client.engine.sync();
    await receiveCommitted(b.client.transport);
    await b.client.engine.sync();
    await a.vault.write("to.md", await a.vault.read("from.md"), { mtime: 1234, ctime: 1234 });
    await a.vault.remove("from.md");
    await a.client.noteRename("from.md", "to.md");
    const putMany = a.client.transport.putMany.bind(a.client.transport);
    let raced = false;
    a.client.transport.putMany = async (...args) => {
      const result = await putMany(...args);
      if (!raced && result.results.some((r) => !r.error)) {
        raced = true;
        await receiveCommitted(b.client.transport);
        await b.client.engine.sync();
        expect(b.vault.text("to.md")).toBe("original content");
        await b.vault.edit("to.md", "peer edited the moved note");
        if (reuseSource !== undefined) await b.vault.edit("from.md", reuseSource);
        await b.client.engine.sync();
        await receiveCommitted(a.client.transport);
      }
      return result;
    };
    await a.client.engine.sync();
    let report;
    for (let round = 0; round < 3; round++) {
      await receiveCommitted(a.client.transport);
      report = await a.client.engine.sync();
    }
    expect(raced).toBe(true);
    expect(a.vault.text("to.md")).toBe("peer edited the moved note");
    expect(a.vault.text("from.md")).toBe(reuseSource);
    expect(report?.waiting, "the origin is stuck retrying a source head it already retired").toBe(
      0,
    );
    expect(report?.appliedCursor).toBe(a.client.serverCursor);
    await receiveCommitted(b.client.transport);
    await b.client.engine.sync();
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    expect(Object.keys(a.vault.snapshot()).sort()).toEqual(
      reuseSource === undefined ? ["to.md"] : ["from.md", "to.md"],
    );
  },
);

it.each(["create", "delete"] as const)(
  "preserves a peer's newer file after acknowledging a local %s",
  async (operation) => {
    server = new TestServer();
    await server.start();
    const a = await connect("a"),
      b = await connect("b");
    await a.vault.edit("note.md", "original content");
    if (operation === "delete") {
      await a.client.engine.sync();
      await receiveCommitted(b.client.transport);
      await b.client.engine.sync();
      await a.vault.remove("note.md");
    }
    const putMany = a.client.transport.putMany.bind(a.client.transport);
    let raced = false;
    a.client.transport.putMany = async (...args) => {
      const result = await putMany(...args);
      if (!raced && result.results.some((r) => !r.error)) {
        raced = true;
        await receiveCommitted(b.client.transport);
        await b.client.engine.sync();
        await b.vault.edit("note.md", "the peer's later content");
        await b.client.engine.sync();
        await receiveCommitted(a.client.transport);
      }
      return result;
    };
    const report = await a.client.engine.sync();
    expect(raced).toBe(true);
    expect(a.vault.snapshot()).toEqual({ "note.md": "the peer's later content" });
    expect(report.conflicted).toBe(0);
    expect(report.waiting).toBe(0);
    expect(report.appliedCursor).toBe(a.client.serverCursor);
  },
);
