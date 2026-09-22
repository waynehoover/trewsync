import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestServer, removeTree } from "../core/test-server.ts";
import { deferred, within } from "../core/test-async.ts";
import { buildMcp, cli, openMcp, tool } from "./mcp-test.ts";
import { loadConfig, saveConfig } from "./config.ts";

let buildDir: string, bundle: string;
const roots: string[] = [];
const hosts: Awaited<ReturnType<typeof openMcp>>[] = [];
let server: TestServer | undefined;
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "telimus-mcp-build-"));
  bundle = await buildMcp(buildDir);
}, 30000);
afterAll(async () => {
  await removeTree(buildDir);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await server?.cleanup();
  server = undefined;
  for (const dir of roots.splice(0)) await removeTree(dir);
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "telimus-mcp-"));
  roots.push(dir);
  return dir;
}
async function paired() {
  server = new TestServer();
  await server.start();
  const dir = await directory();
  const initialized = await cli("init", server.setup, "--dir", dir, "--json");
  expect(initialized.code, initialized.err).toBe(0);
  return { dir, key: JSON.parse(initialized.out).recoveryKey as string };
}
async function host(dir: string, flags: string[] = [], modern = false) {
  const result = await openMcp(bundle, dir, flags, modern);
  hosts.push(result);
  return result;
}
async function ready(client: Awaited<ReturnType<typeof host>>["client"]) {
  await within(
    (async () => {
      for (;;) {
        const status = await tool(client, "sync_status");
        if (status.writeReady) return;
        if (status.connection === "fatal") throw new Error(JSON.stringify(status));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    "MCP initial sync",
    15000,
  );
}

it("edits two daily tasks over stdio while keeping unrelated bytes and the backup on a second device", async () => {
  const { dir, key } = await paired();
  const name = "Daily/2026-09-14.md";
  const original =
    "\ufeff---\r\nprivate: true\r\n---\r\nUnsent marker 982317 with [[a link]].\r\n- [ ] Call Sam\r\n- [ ] Pay bill\r\nKeep every unrelated paragraph.\r\n";
  await mkdir(join(dir, "Daily"));
  await writeFile(join(dir, name), original);
  const { client } = await host(dir, ["--verbose"]);
  await ready(client);
  const listed = await tool(client, "list_notes", { folder: "Daily", nameContains: "2026-09-14" });
  expect(listed.entries.map((entry: { path: string }) => entry.path)).toEqual([name]);
  const read = await tool(client, "read_note", { path: name });
  expect(read.content).toBe(original);
  const edited = await tool(client, "edit_note", {
    path: name,
    base: read.base,
    edits: [
      { old: "- [ ] Call Sam", new: "- [x] Call Sam" },
      { old: "- [ ] Pay bill", new: "- [x] Pay bill" },
    ],
  });
  expect(edited.error).toBeUndefined();
  expect(edited.applied).toBe(true);
  expect(edited.durable).toBe(true);
  const expected = original
    .replace("- [ ] Call Sam", "- [x] Call Sam")
    .replace("- [ ] Pay bill", "- [x] Pay bill");
  expect((await tool(client, "read_note", { path: name })).content).toBe(expected);
  expect((await tool(client, "read_note", { path: edited.beforeImage })).content).toBe(original);
  const refused = await tool(client, "append_note", {
    path: name,
    base: read.base,
    text: "lost-response retry",
  });
  expect(refused.error.code).toBe("stale");
  expect(refused.connection.localGeneration).toBe(edited.connection.localGeneration);
  await within(
    (async () => {
      for (;;) {
        const status = await tool(client, "sync_status");
        if (!status.localWritesSincePass && !status.engine.syncing && status.engine.pending === 0)
          return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    "edited note upload",
    15000,
  );
  const phone = await directory();
  const pair = await cli("pair", key, "--dir", phone, "--device", "phone");
  expect(pair.code, pair.err).toBe(0);
  const synced = await cli("sync", "--dir", phone);
  expect(synced.code, synced.err).toBe(0);
  expect(await readFile(join(phone, name), "utf8")).toBe(expected);
  expect(await readFile(join(phone, edited.beforeImage), "utf8")).toBe(original);
}, 30000);

it("resolves case aliases over stdio only when the filesystem does", async () => {
  const { dir } = await paired();
  await mkdir(join(dir, "work"));
  await writeFile(join(dir, "work/note.md"), "keep the existing note");
  const foldsCase = await readFile(join(dir, "Work/note.md")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  const { client } = await host(dir);
  await ready(client);
  const read = await tool(client, "read_note", { path: "Work/note.md" });
  if (foldsCase) {
    expect(read).toMatchObject({ path: "work/note.md", content: "keep the existing note" });
  } else {
    expect.soft(read.error?.code).toBe("not_found_local");
  }
  const created = await tool(client, "create_note", {
    path: "Work/new.md",
    content: "new note in the requested folder",
  });
  expect(created.applied).toBe(true);
  expect(created.path).toBe(foldsCase ? "work/new.md" : "Work/new.md");
  expect(await readFile(join(dir, "Work/new.md"), "utf8")).toBe("new note in the requested folder");
  if (!foldsCase)
    await expect(readFile(join(dir, "work/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(dir, "work/note.md"), "utf8")).toBe("keep the existing note");
});

it("reads and edits both case-distinct notes over stdio without touching the other", async (ctx) => {
  const { dir } = await paired();
  await writeFile(join(dir, "Foo.md"), "upper note original");
  try {
    await writeFile(join(dir, "foo.md"), "lower note original", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    ctx.skip();
  }
  const { client } = await host(dir);
  await ready(client);
  const listed = await tool(client, "list_notes");
  expect(listed.ambiguousCount).toBe(0);
  expect(listed.entries.map((entry: { path: string }) => entry.path)).toEqual(["Foo.md", "foo.md"]);
  for (const [path, original] of [
    ["Foo.md", "upper note original"],
    ["foo.md", "lower note original"],
  ] as const) {
    const read = await tool(client, "read_note", { path });
    expect(read.content).toBe(original);
    const edited = await tool(client, "edit_note", {
      path,
      base: read.base,
      edits: [{ old: "original", new: "edited" }],
    });
    expect(edited.applied).toBe(true);
    expect(await readFile(join(dir, edited.beforeImage), "utf8")).toBe(original);
    expect(await readFile(join(dir, path), "utf8")).toBe(original.replace("original", "edited"));
    if (path === "Foo.md")
      expect(await readFile(join(dir, "foo.md"), "utf8")).toBe("lower note original");
  }
});

it("initializes and reads 5000 notes while the sync handshake is stalled, with bounded pages and eight concurrent calls", async () => {
  const { dir } = await paired();
  const accepted = deferred<void>();
  const sockets = new Set<Socket>();
  const blocked = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    accepted.resolve();
  });
  await new Promise<void>((resolve) => blocked.listen(0, "127.0.0.1", resolve));
  const address = blocked.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const config = (await loadConfig(dir))!;
  await saveConfig(dir, { ...config, url: `ws://127.0.0.1:${address.port}` });
  await mkdir(join(dir, "Notes"));
  for (let from = 0; from < 5000; from += 100)
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(
          join(dir, "Notes", `${String(from + i).padStart(4, "0")}.md`),
          `literal needle ${from + i}\n`,
        ),
      ),
    );
  await writeFile(join(dir, "large.md"), ("a".repeat(1023) + "\n").repeat(1024));
  const started = performance.now();
  try {
    const opened = await host(dir, ["--read-only"], true);
    const { client } = opened;
    await within(accepted.promise, "held sync connection", 5000);
    console.info(
      `MCP initialize while sync stalled: ${(performance.now() - started).toFixed(1)} ms`,
    );
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "edit_note")).toBe(false);
    expect((await tool(client, "sync_status")).writeReady).toBe(false);
    const inventoryStarted = performance.now();
    let after: string | undefined;
    const found: string[] = [];
    do {
      const page = await tool(client, "list_notes", {
        folder: "Notes",
        limit: 500,
        ...(after ? { after } : {}),
      });
      found.push(...page.entries.map((row: { path: string }) => row.path));
      after = page.nextAfter ?? undefined;
    } while (after);
    expect(found).toHaveLength(5000);
    expect(new Set(found).size).toBe(5000);
    console.info(
      `MCP 5000-note inventory, all ten pages: ${(performance.now() - inventoryStarted).toFixed(1)} ms`,
    );
    const page = await tool(client, "read_note", { path: "large.md", maxLines: 1000 });
    expect(page.size).toBe(1024 * 1024);
    expect(Buffer.byteLength(page.content)).toBe(65536);
    expect(page.nextLine).toBe(65);
    let line: number | null = 1;
    let bytes = 0;
    while (line !== null) {
      const part = await tool(client, "read_note", {
        path: "large.md",
        startLine: line,
        base: page.base,
        maxLines: 1000,
      });
      bytes += Buffer.byteLength(part.content);
      line = part.nextLine;
    }
    expect(bytes).toBe(1024 * 1024);
    const requests = Array.from({ length: 8 }, (_, i) =>
      i % 2
        ? { name: "list_notes", args: { folder: "Notes", limit: 5 } }
        : { name: "search_notes", args: { query: "literal needle", folder: "Notes", limit: 5 } },
    );
    const strip = (value: Record<string, unknown>) => {
      const { observedAt: _time, connection: _connection, ...rest } = value;
      return rest;
    };
    const sequential = [];
    for (const request of requests)
      sequential.push(strip(await tool(client, request.name, request.args)));
    expect(
      (await Promise.all(requests.map((request) => tool(client, request.name, request.args)))).map(
        strip,
      ),
    ).toEqual(sequential);
    await opened.close();
    hosts.splice(hosts.indexOf(opened), 1);
    const writable = await host(dir);
    const refused = await tool(writable.client, "create_note", {
      path: "not-admitted.md",
      content: "must not exist",
    });
    expect(refused).toMatchObject({ applied: false, error: { code: "not_ready" } });
    await expect(readFile(join(dir, "not-admitted.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await tool(writable.client, "read_note", { path: "Notes/0000.md" })).content).toBe(
      "literal needle 0\n",
    );
    await writable.close();
    hosts.splice(hosts.indexOf(writable), 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => blocked.close(() => resolve()));
  }
}, 60000);

it("omits every mutation in persisted read-only mode and refuses invalid schemas without creating files", async () => {
  const { dir } = await paired();
  const config = (await loadConfig(dir))!;
  await saveConfig(dir, { ...config, readOnly: true });
  const { client } = await host(dir);
  expect((await client.listTools()).tools.map((row) => row.name).sort()).toEqual([
    "compare_versions",
    "deleted_notes",
    "delivery_status",
    "list_notes",
    "list_vaults",
    "note_history",
    "read_note",
    "search_notes",
    "sync_status",
  ]);
  await expect(
    client.callTool({
      name: "create_note",
      arguments: { path: "unauthorized.md", content: "must not appear" },
    }),
  ).rejects.toThrow();
  await expect(readFile(join(dir, "unauthorized.md"))).rejects.toMatchObject({ code: "ENOENT" });
  for (const args of [
    { path: "x.md", maxLines: 0 },
    { path: "x.md", extra: true },
    { path: "x.md", base: "invalid" },
    { path: "\ud800.md" },
  ]) {
    const result = await client.callTool({ name: "read_note", arguments: args });
    expect(result.isError).toBe(true);
  }
});

it("serves a cancelled search without losing the next request", async () => {
  const { dir } = await paired();
  await writeFile(join(dir, "note.md"), "a local note\n");
  const { client } = await host(dir);
  const cancel = new AbortController();
  const request = client.callTool(
    { name: "search_notes", arguments: { query: "local" } },
    { signal: cancel.signal },
  );
  cancel.abort();
  await expect(request).rejects.toThrow();
  expect((await tool(client, "read_note", { path: "note.md" })).content).toBe("a local note\n");
});

it("reads old versions and restores deleted notes to explicit destinations across restart and another device", async () => {
  const { dir, key } = await paired();
  const original =
    "\ufeff---\r\ntitle: Before\r\n---\r\nOriginal [[link]] and unique historical marker.\r\n";
  await writeFile(join(dir, "daily.md"), original);
  expect((await cli("sync", "--dir", dir)).code).toBe(0);
  await writeFile(join(dir, "daily.md"), "latest daily version\n");
  expect((await cli("sync", "--dir", dir)).code).toBe(0);
  const firstHost = await host(dir);
  await ready(firstHost.client);
  const latest = await tool(firstHost.client, "note_history", { path: "daily.md", limit: 1 });
  expect(latest.versions).toHaveLength(1);
  expect(latest.nextBefore).toBeTypeOf("number");
  const old = await tool(firstHost.client, "note_history", {
    path: "daily.md",
    before: latest.nextBefore,
    limit: 1,
  });
  expect(old.nextBefore).toBeNull();
  const uid = old.versions[0].uid;
  const historical = await tool(firstHost.client, "read_note", { path: "daily.md", uid });
  expect(historical).toMatchObject({ source: "history", uid, content: original });
  const restored = await tool(firstHost.client, "restore_note", {
    path: "daily.md",
    uid,
    to: "Recovered/daily.md",
  });
  expect(restored).toMatchObject({
    applied: true,
    durable: true,
    restoredFrom: { path: "daily.md", uid },
  });
  expect(
    await tool(firstHost.client, "restore_note", {
      path: "daily.md",
      uid,
      to: "Recovered/daily.md",
    }),
  ).toMatchObject({ applied: false, error: { code: "exists" } });
  expect((await tool(firstHost.client, "read_note", { path: "daily.md" })).content).toBe(
    "latest daily version\n",
  );
  expect((await tool(firstHost.client, "read_note", { path: "Recovered/daily.md" })).content).toBe(
    original,
  );
  const preview = await tool(firstHost.client, "sync_status", { preview: true, limit: 1 });
  expect(preview.preview).toMatchObject({ estimated: true });
  expect(preview.preview.files).toHaveLength(1);
  await firstHost.close();
  hosts.splice(hosts.indexOf(firstHost), 1);
  await rm(join(dir, "daily.md"));
  expect((await cli("sync", "--dir", dir)).code).toBe(0);
  const secondHost = await host(dir);
  await ready(secondHost.client);
  const deleted = await tool(secondHost.client, "deleted_notes");
  expect(deleted.notes.some((note: { path: string }) => note.path === "daily.md")).toBe(true);
  expect((await tool(secondHost.client, "read_note", { path: "daily.md", uid })).content).toBe(
    original,
  );
  expect(
    (
      await tool(secondHost.client, "restore_note", {
        path: "daily.md",
        uid,
        to: "Recovered/from-deleted.md",
      })
    ).applied,
  ).toBe(true);
  await secondHost.close();
  hosts.splice(hosts.indexOf(secondHost), 1);
  expect((await cli("sync", "--dir", dir)).code).toBe(0);
  const fresh = await directory();
  expect((await cli("pair", key, "--dir", fresh, "--device", "fresh-reader")).code).toBe(0);
  expect((await cli("sync", "--dir", fresh)).code).toBe(0);
  expect(await readFile(join(fresh, "Recovered/daily.md"), "utf8")).toBe(original);
  expect(await readFile(join(fresh, "Recovered/from-deleted.md"), "utf8")).toBe(original);
}, 30000);
it("reports real Unicode spelling collisions as an incomplete stdio search", async (ctx) => {
  const { dir } = await paired();
  await writeFile(join(dir, "café.md"), "needle in the first spelling");
  try {
    await writeFile(join(dir, "cafe\u0301.md"), "needle in the second spelling", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    ctx.skip();
  }
  const { client } = await host(dir, ["--read-only"]);
  const listed = await tool(client, "list_notes");
  expect(listed.ambiguousCount).toBe(1);
  const searched = await tool(client, "search_notes", { query: "needle" });
  expect(searched).toMatchObject({
    matches: [],
    scanned: 0,
    complete: false,
    nextCursor: null,
    skipped: { count: 1, items: [{ path: "café.md", why: "ambiguous_path" }], truncated: false },
  });
  expect(await readFile(join(dir, "café.md"), "utf8")).toBe("needle in the first spelling");
  expect(await readFile(join(dir, "cafe\u0301.md"), "utf8")).toBe("needle in the second spelling");
});
