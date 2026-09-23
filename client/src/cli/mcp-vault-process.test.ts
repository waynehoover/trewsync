import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { TestServer, removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";
import { buildMcp, cli, openMcp, tool } from "./mcp-test.ts";
import { openHttp } from "./mcp-http-test.ts";
import { lockVault } from "./lock.ts";
let buildDir: string, bundle: string;
const servers: TestServer[] = [],
  roots: string[] = [];
const hosts: { client: Client; close(): Promise<unknown> }[] = [];
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "trew-multivault-build-"));
  bundle = await buildMcp(buildDir);
});
afterAll(async () => removeTree(buildDir));
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) await server.cleanup();
  for (const root of roots.splice(0)) await removeTree(root);
});
async function paired() {
  const server = new TestServer();
  servers.push(server);
  await server.start();
  const dir = await mkdtemp(join(tmpdir(), "trew-multivault-"));
  roots.push(dir);
  const init = await cli("init", server.setup, "--dir", dir, "--json");
  expect(init.code, init.err).toBe(0);
  return dir;
}
async function settled(client: Client, vault: string) {
  await within(
    (async () => {
      for (;;) {
        const status = await tool(client, "sync_status", { vault });
        if (
          status.writeReady &&
          !status.localWritesSincePass &&
          !status.engine.syncing &&
          !status.engine.pending
        )
          return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    "selected vault settled",
    15000,
  );
}
it.each([false, true])(
  "isolates configured vaults through the built process and holds both locks, HTTP=%s",
  async (http) => {
    const personal = await paired(),
      work = await paired();
    const issued = await cli("mcp-token", "--dir", personal);
    expect(issued.code, issued.err).toBe(0);
    const flags = ["--vault", `personal=${personal}`, "--vault", `work=${work}`];
    const host = http
      ? await openHttp(bundle, personal, issued.out.trim(), [...flags, "--writable"])
      : await openMcp(bundle, personal, flags);
    hosts.push(host);
    await Promise.all([settled(host.client, "personal"), settled(host.client, "work")]);
    const listing = await tool(host.client, "list_vaults");
    expect(listing.vaults.map((v: { id: string }) => v.id)).toEqual(["personal", "work"]);
    expect(JSON.stringify(listing)).not.toContain(personal);
    expect(JSON.stringify(listing)).not.toContain(work);
    for (const dir of [personal, work]) await expect(lockVault(dir, "test")).rejects.toThrow();
    expect(
      (
        await host.client.callTool({
          name: "create_note",
          arguments: { path: "same.md", content: "wrong vault" },
        })
      ).isError,
    ).toBe(true);
    for (const vault of ["personal", "work"]) {
      expect(
        await tool(host.client, "create_note", {
          vault,
          path: "same.md",
          content: `${vault} preserved\n`,
        }),
      ).toMatchObject({ applied: true, durable: true });
      await settled(host.client, vault);
      const history = await tool(host.client, "note_history", { vault, path: "same.md" });
      const read = await tool(host.client, "read_note", { vault, path: "same.md" });
      expect(read.content).toBe(`${vault} preserved\n`);
      expect(
        await tool(host.client, "compare_versions", {
          vault,
          path: "same.md",
          fromUid: history.versions[0].uid,
        }),
      ).toMatchObject({ identical: true, complete: true });
      const delivery = await tool(host.client, "delivery_status", { vault });
      expect(delivery.devices).toBeInstanceOf(Array);
      expect(JSON.stringify(delivery)).not.toContain("deviceId");
    }
    const read = await tool(host.client, "read_note", { vault: "personal", path: "same.md" });
    expect(
      await tool(host.client, "append_note", {
        vault: "work",
        path: "same.md",
        base: read.base,
        text: "leak",
      }),
    ).toMatchObject({ applied: false, error: { code: "stale" } });
    expect(await readFile(join(personal, "same.md"), "utf8")).toBe("personal preserved\n");
    expect(await readFile(join(work, "same.md"), "utf8")).toBe("work preserved\n");
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    for (const dir of [personal, work]) await (await lockVault(dir, "after shutdown"))();
  },
  30000,
);

it("holds every root until an admitted HTTP write finishes during shutdown", async () => {
  const a = await paired(),
    b = await paired();
  const token = (await cli("mcp-token", "--dir", a)).out.trim();
  const faultDir = await mkdtemp(join(tmpdir(), "trew-multivault-fault-"));
  roots.push(faultDir);
  const fault = await buildMcp(faultDir, "./mcp-fault-child.ts");
  const owner = await openHttp(fault, a, token, [
    "--vault",
    `one=${a}`,
    "--vault",
    `two=${b}`,
    "--writable",
  ]);
  hosts.push(owner);
  await Promise.all([settled(owner.client, "one"), settled(owner.client, "two")]);
  expect(
    await tool(owner.client, "create_note", {
      vault: "two",
      path: "note.md",
      content: "preserve before shutdown\n",
    }),
  ).toMatchObject({ applied: true });
  await settled(owner.client, "two");
  const read = await tool(owner.client, "read_note", { vault: "two", path: "note.md" });
  await owner.hold("cli/mcp:durable");
  const edit = tool(owner.client, "append_note", {
    vault: "two",
    path: "note.md",
    base: read.base,
    text: "finish admitted work\n",
  }).catch(() => undefined);
  await owner.reached("cli/mcp:durable");
  owner.child.kill("SIGTERM");
  try {
    for (const dir of [a, b]) await expect(lockVault(dir, "must remain locked")).rejects.toThrow();
    expect(owner.child.exitCode).toBeNull();
  } finally {
    owner.release();
  }
  expect(await owner.close()).toMatchObject({ code: 0, signal: null });
  hosts.splice(hosts.indexOf(owner), 1);
  await edit;
  expect(await readFile(join(b, "note.md"), "utf8")).toBe(
    "preserve before shutdown\nfinish admitted work\n",
  );
  for (const dir of [a, b]) await (await lockVault(dir, "shutdown finished"))();
}, 30000);

it("uses only the first configured vault's HTTP credential and rotates access to the whole explicit set", async () => {
  const a = await paired(),
    b = await paired();
  const tokenA = (await cli("mcp-token", "--dir", a)).out.trim();
  const tokenB = (await cli("mcp-token", "--dir", b)).out.trim();
  const owner = await openHttp(bundle, a, tokenA, ["--vault", `one=${a}`, "--vault", `two=${b}`]);
  hosts.push(owner);
  const request = (token: string) =>
    fetch(owner.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
  const refused = await request(tokenB);
  expect(refused.status).toBe(401);
  await refused.text();
  expect((await tool(owner.client, "list_vaults")).vaults).toHaveLength(2);
  const next = (await cli("mcp-token", "--dir", a)).out.trim();
  const old = await request(tokenA);
  expect(old.status).toBe(401);
  await old.text();
  const fresh = await owner.connect(true, next);
  const list = await tool(fresh.client, "list_vaults");
  expect(list.vaults).toHaveLength(2);
  expect(list.vaults.every((v: { mode: string }) => v.mode === "read-only")).toBe(true);
}, 30000);
