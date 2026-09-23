import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import { MemoryVault, MemoryIndexStore } from "./vault.ts";
import { TestServer } from "./test-server.ts";

let server: TestServer;
let client: Client;
afterEach(async () => {
  client?.close();
  await server?.cleanup();
});

it.each(["event", "verification"])("detects unchanged metadata through %s", async (mode) => {
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault();
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials()),
    vaultId: "default",
    device: "test",
    coalesceWrites: false,
  });
  await client.connect();
  await vault.edit("note.md", "BEFORE\n", 1000);
  await client.settle();
  await vault.edit("note.md", "AFTERS\n", 1000);
  if (mode === "event") client.noteChanged("note.md");
  await client.settle({ verifyContents: mode === "verification" });
  const versions = await client.history("note.md", { limit: 2 });
  expect(versions).toHaveLength(2);
  expect(new TextDecoder().decode(await client.contentAt(versions[0]!))).toBe("AFTERS\n");
});
