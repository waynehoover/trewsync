import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { TestServer, removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";
import { buildMcp, cli, openMcp, tool } from "./mcp-test.ts";
import { openHttp } from "./mcp-http-test.ts";

let buildDir: string, bundle: string;
let server: TestServer | undefined;
const roots: string[] = [];
const hosts: { client: Client; close(): Promise<unknown> }[] = [];
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "telimus-tools-build-"));
  bundle = await buildMcp(buildDir);
});
afterAll(async () => removeTree(buildDir));
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await server?.cleanup();
  server = undefined;
  for (const root of roots.splice(0)) await removeTree(root);
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "telimus-tools-process-"));
  roots.push(dir);
  return dir;
}
async function start(http: boolean) {
  server = new TestServer();
  await server.start();
  const dir = await directory();
  const init = await cli("init", server.setup, "--dir", dir, "--json");
  expect(init.code, init.err).toBe(0);
  const token = await cli("mcp-token", "--dir", dir);
  expect(token.code, token.err).toBe(0);
  const host = http
    ? await openHttp(bundle, dir, token.out.trim(), ["--writable"], true)
    : await openMcp(bundle, dir);
  hosts.push(host);
  await waitFor(host.client, (status) => status.writeReady);
  return { dir, key: JSON.parse(init.out).recoveryKey as string, client: host.client };
}
async function waitFor(client: Client, predicate: (status: Record<string, any>) => boolean) {
  await within(
    (async () => {
      for (;;) {
        if (predicate(await tool(client, "sync_status"))) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    "MCP tools sync",
    15000,
  );
}

it.each([false, true])(
  "searches tags and filenames, then prepends recoverably through the built CLI, HTTP=%s",
  async (http) => {
    const { dir, key, client } = await start(http);
    const path = "Projects/project.md";
    const original = "\ufeffUNSENT prose\r\n#project/active [[keep]]\r\n`#ignored`\r\n";
    expect(await tool(client, "create_note", { path, content: original })).toMatchObject({
      applied: true,
      durable: true,
    });
    expect(
      (await tool(client, "search_notes", { query: "project/active", mode: "tag" })).matches.map(
        (x: { path: string }) => x.path,
      ),
    ).toEqual([path]);
    expect((await tool(client, "search_notes", { query: "ignored", mode: "tag" })).matches).toEqual(
      [],
    );
    expect(
      (await tool(client, "search_notes", { query: "project", mode: "filename" })).matches.map(
        (x: { path: string }) => x.path,
      ),
    ).toEqual([path]);
    const read = await tool(client, "read_note", { path });
    const result = await tool(client, "prepend_note", {
      path,
      base: read.base,
      text: "# Heading\r\n",
    });
    expect(result).toMatchObject({ applied: true, durable: true });
    const expected = "\ufeff# Heading\r\n" + original.slice(1);
    expect((await tool(client, "read_note", { path })).content).toBe(expected);
    expect((await tool(client, "read_note", { path: result.beforeImage })).content).toBe(original);
    expect(
      await tool(client, "prepend_note", { path, base: read.base, text: "duplicate" }),
    ).toMatchObject({ applied: false, error: { code: "stale" } });
    expect(
      (await client.callTool({ name: "prepend_note", arguments: { path, text: "unguarded" } }))
        .isError,
    ).toBe(true);
    expect(await readFile(join(dir, path), "utf8")).toBe(expected);
    await waitFor(
      client,
      (status) =>
        !status.localWritesSincePass && !status.engine.syncing && status.engine.pending === 0,
    );
    const phone = await directory();
    expect((await cli("pair", key, "--dir", phone, "--device", "phone")).code).toBe(0);
    const synced = await cli("sync", "--dir", phone);
    expect(synced.code, synced.err).toBe(0);
    expect(await readFile(join(phone, path), "utf8")).toBe(expected);
    expect(await readFile(join(phone, result.beforeImage), "utf8")).toBe(original);
  },
  30000,
);

it.each([false, true])(
  "previews and applies tag, move, directory and delete workflows through the built transport, HTTP=%s",
  async (http) => {
    const { dir, key, client } = await start(http);
    expect(await tool(client, "create_directory", { path: "Projects" })).toMatchObject({
      applied: true,
      durable: true,
    });
    for (const [path, content] of [
      ["Projects/A.md", "UNSENT original\n#old\n"],
      ["Index.md", "[[Projects/A|label]]\n"],
    ])
      expect(await tool(client, "create_note", { path, content })).toMatchObject({
        applied: true,
        durable: true,
      });
    const addArgs = { paths: ["Projects/A.md"], tags: ["added"], location: "frontmatter" };
    const add = await tool(client, "add_tags", addArgs);
    expect(add).toMatchObject({ phase: "preview", applied: false });
    expect(await tool(client, "add_tags", { ...addArgs, changes: add.changes })).toMatchObject({
      complete: true,
    });
    const renameArgs = { oldTag: "old", newTag: "new" };
    const rename = await tool(client, "rename_tag", renameArgs);
    expect(
      await tool(client, "rename_tag", { ...renameArgs, changes: rename.changes }),
    ).toMatchObject({ complete: true });
    const removeArgs = { paths: ["Projects/A.md"], patterns: ["add*"] };
    const remove = await tool(client, "remove_tags", removeArgs);
    expect(
      await tool(client, "remove_tags", { ...removeArgs, changes: remove.changes }),
    ).toMatchObject({ complete: true });
    const manageArgs = {
      paths: ["Projects/A.md"],
      operation: "add",
      tags: ["managed"],
      location: "content",
    };
    const manage = await tool(client, "manage_tags", manageArgs);
    expect(
      await tool(client, "manage_tags", { ...manageArgs, changes: manage.changes }),
    ).toMatchObject({ complete: true });
    const moveArgs = { path: "Projects/A.md", to: "Archive/A.md" };
    const move = await tool(client, "move_note", moveArgs);
    expect(await tool(client, "move_note", { ...moveArgs, changes: move.changes })).toMatchObject({
      complete: true,
    });
    expect((await tool(client, "read_note", { path: "Index.md" })).content).toBe(
      "[[Archive/A|label]]\n",
    );
    const read = await tool(client, "read_note", { path: "Archive/A.md" });
    expect(read.content).toContain("UNSENT original");
    expect(read.content).toContain("#new");
    expect(read.content).toContain("#managed");
    const deletion = await tool(client, "delete_note", { path: "Archive/A.md" });
    const deleted = await tool(client, "delete_note", {
      path: "Archive/A.md",
      changes: deletion.changes,
    });
    expect(deleted).toMatchObject({ complete: true });
    const beforeImage = deleted.results.find(
      (row: { path: string }) => row.path === "Archive/A.md",
    ).beforeImage;
    expect((await tool(client, "read_note", { path: beforeImage })).content).toBe(read.content);
    expect(await readFile(join(dir, beforeImage), "utf8")).toBe(read.content);
    await waitFor(
      client,
      (status) =>
        !status.localWritesSincePass && !status.engine.syncing && status.engine.pending === 0,
    );
    const phone = await directory();
    expect((await cli("pair", key, "--dir", phone, "--device", "phone")).code).toBe(0);
    const synced = await cli("sync", "--dir", phone);
    expect(synced.code, synced.err).toBe(0);
    expect(await readFile(join(phone, beforeImage), "utf8")).toBe(read.content);
    expect(await readFile(join(phone, "Index.md"), "utf8")).toBe("[[Archive/A|label]]\n");
    expect(await readFile(join(phone, "Archive/A.md")).catch(() => null)).toBeNull();
  },
  30000,
);
