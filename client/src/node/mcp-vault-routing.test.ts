import { afterEach, expect, it } from "vitest";
import { Client as Host, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Client } from "../core/client.ts";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeVault } from "./vault.ts";
import { McpReader } from "./mcp-read.ts";
import { createVaultTools, type McpSession } from "./mcp-tools.ts";
import { tool } from "./mcp-test.ts";
import { removeTree } from "../core/test-server.ts";
const roots: string[] = [];
const hosts: Host[] = [];
const registries: ReturnType<typeof createVaultTools>[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) {
    await registry.drain();
    await registry.server.close();
  }
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await removeTree(root);
});
async function vault(id: string, readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "trew-route-"));
  roots.push(root);
  await writeFile(join(root, "same.md"), id + " secret content");
  const writer = new NodeVault(root),
    reader = new McpReader(new NodeVault(root, { observeOnly: true }));
  const client = {
    writeReady: true,
    mutateLocal: async (work: (context: { changed: (path: string) => void }) => Promise<object>) =>
      work({ changed: () => {} }),
  } as unknown as Client;
  const session: McpSession = {
    mode: readOnly ? "read-only" : "writable",
    writer,
    reader,
    device: "laptop",
    client: () => client,
    stopping: () => false,
    changed: () => {},
    summary: () => ({ connection: "ready" }),
    status: async () => ({}),
  };
  return { id, session, root };
}
async function connect(vaults: Awaited<ReturnType<typeof vault>>[]) {
  const registry = createVaultTools(vaults, "test");
  registries.push(registry);
  const [hostWire, serverWire] = InMemoryTransport.createLinkedPair();
  await registry.server.connect(serverWire);
  const host = new Host({ name: "routing", version: "1" });
  hosts.push(host);
  await host.connect(hostWire);
  return host;
}
it("lists only configured aliases and requires a vault choice before reading", async () => {
  const a = await vault("personal"),
    b = await vault("work");
  const host = await connect([a, b]);
  const listed = await tool(host, "list_vaults");
  expect(listed.vaults.map((row: { id: string }) => row.id)).toEqual(["personal", "work"]);
  expect(JSON.stringify(listed)).not.toContain(a.root);
  expect(JSON.stringify(listed)).not.toContain(b.root);
  expect((await host.callTool({ name: "read_note", arguments: { path: "same.md" } })).isError).toBe(
    true,
  );
  const rows = await Promise.all(
    ["personal", "work"].map((vault) => tool(host, "read_note", { vault, path: "same.md" })),
  );
  expect(rows.map((row) => row.content)).toEqual([
    "personal secret content",
    "work secret content",
  ]);
});
it("routes writes only to the selected vault and cannot upgrade another vault's read-only policy", async () => {
  const a = await vault("personal"),
    b = await vault("work", true);
  const host = await connect([a, b]);
  const first = await tool(host, "read_note", { vault: "personal", path: "same.md" });
  expect(
    await tool(host, "append_note", {
      vault: "personal",
      path: "same.md",
      base: first.base,
      text: " changed",
    }),
  ).toMatchObject({ applied: true, durable: true });
  expect(
    await tool(host, "append_note", {
      vault: "work",
      path: "same.md",
      base: first.base,
      text: " leak",
    }),
  ).toMatchObject({ error: { code: "read_only" } });
  expect(await readFile(join(a.root, "same.md"), "utf8")).toBe("personal secret content changed");
  expect(await readFile(join(b.root, "same.md"), "utf8")).toBe("work secret content");
});
it("rejects unknown aliases and keeps the single-vault argument optional", async () => {
  const a = await vault("personal");
  const host = await connect([a]);
  expect((await tool(host, "read_note", { path: "same.md" })).content).toBe(
    "personal secret content",
  );
  expect(
    (await host.callTool({ name: "read_note", arguments: { vault: "unknown", path: "same.md" } }))
      .isError,
  ).toBe(true);
});
