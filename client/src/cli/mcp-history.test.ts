import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  symlink,
  utimes,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as Host, InMemoryTransport } from "@modelcontextprotocol/client";
import { Client, type ClientOptions } from "../core/client.ts";
import { MemoryIndexStore } from "../core/vault.ts";
import { testWrapped } from "../core/test-keys.ts";
import { TestServer } from "../core/test-server.ts";
import { NodeVault, STALE_TEMP_MS } from "./vault.ts";
import { McpReader } from "./mcp-read.ts";
import { McpHistory, HISTORY_LOOKUP_VERSIONS } from "./mcp-history.ts";
import { createTools, type McpSession } from "./mcp-tools.ts";
import { tool } from "./mcp-test.ts";

let root: string,
  writer: NodeVault,
  reader: McpReader,
  client: Client,
  server: TestServer,
  history: McpHistory,
  options: ClientOptions;
const hosts: Host[] = [];
const registries: ReturnType<typeof createTools>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trew-mcp-history-"));
  writer = new NodeVault(root);
  await writer.probeCase();
  reader = new McpReader(new NodeVault(root, { observeOnly: true, alsoIgnore: ["Secret"] }));
  await reader.vault.probeCase();
  server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(79);
  options = {
    vault: writer,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, await testWrapped(secret))),
    vaultId: "default",
    device: "history",
    coalesceWrites: false,
    timeoutMs: 5000,
  };
  client = new Client(options);
  await client.connect();
  await client.settle();
  history = new McpHistory(reader, () => client);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await client?.close();
  for (const registry of registries.splice(0)) {
    await registry.drain();
    await registry.server.close();
  }
  for (const host of hosts.splice(0)) await host.close();
  await reader?.drain();
  await server?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});
async function save(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
  client.noteChanged(path);
  await client.settle();
}
async function inspect() {
  await client.close();
  client = new Client({ ...options, inspect: true });
  await client.connect();
}
async function snapshot(dir = root): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    const full = join(dir, name);
    const info = await lstat(full);
    if (info.isDirectory())
      for (const [child, bytes] of Object.entries(await snapshot(full)))
        out[name + "/" + child] = bytes;
    else if (info.isFile()) out[name] = (await readFile(full)).toString("hex");
    else out[name] = "link";
  }
  return out;
}
async function connectedTools() {
  const session: McpSession = {
    mode: "writable",
    writer,
    reader,
    client: () => client,
    stopping: () => false,
    changed: () => {},
    summary: () => ({}),
    status: async () => ({}),
  };
  const registry = createTools(session, "test");
  registries.push(registry);
  const [hostWire, serverWire] = InMemoryTransport.createLinkedPair();
  await registry.server.connect(serverWire);
  const host = new Host({ name: "history-test", version: "1" });
  hosts.push(host);
  await host.connect(hostWire);
  return { host, session };
}

it("pages history including an exact-full final page and reads an authenticated old body without changing disk", async () => {
  const bodies = [
    "\ufeff---\r\ntitle: Old\r\n---\r\nUNSENT ORIGINAL\r\n",
    "second version\n",
    "third version\n",
  ];
  for (const body of bodies) await save("daily.md", body);
  await inspect();
  await mkdir(join(root, ".trew/tmp"), { recursive: true });
  const staged = join(root, ".trew/tmp/replace.old");
  await writeFile(staged, "staged bytes");
  const old = new Date(Date.now() - STALE_TEMP_MS - 60000);
  await utimes(staged, old, old);
  await writeFile(join(root, "cafe\u0301.md"), "do not normalize");
  const before = await snapshot();
  let cursor: number | undefined;
  const versions: number[] = [];
  for (let i = 0; i < 3; i++) {
    const page = await history.history({ path: "daily.md", limit: 1, before: cursor });
    expect(page.versions).toHaveLength(1);
    versions.push(page.versions[0]!.uid);
    cursor = page.nextBefore ?? undefined;
    expect(cursor === undefined).toBe(i === 2);
  }
  const read = await history.read({ path: "daily.md", uid: versions[2]! });
  expect(read).toMatchObject({ source: "history", uid: versions[2], content: bodies[0] });
  expect(await snapshot()).toEqual(before);
});

it("does not fetch a UID belonging to another path and bounds an incomplete version lookup", async () => {
  await save("wanted.md", "wanted");
  await save("other.md", "private other version");
  const other = (await client.history("other.md"))[0]!;
  const fetch = vi.spyOn(client, "contentAt");
  await expect(history.content("wanted.md", other.uid)).rejects.toMatchObject({
    code: "version_not_found",
  });
  expect(fetch).not.toHaveBeenCalled();
  let uid = 10000;
  const pages = vi
    .spyOn(client, "history")
    .mockImplementation(async (path) =>
      Array.from({ length: 100 }, () => ({ ...other, path, uid: uid-- })),
    );
  await expect(history.content("wanted.md", 1)).rejects.toMatchObject({
    code: "lookup_incomplete",
  });
  expect(pages.mock.calls.length).toBe(Math.floor(HISTORY_LOOKUP_VERSIONS / 100) + 1);
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses excluded and symlinked history sources before asking the server", async () => {
  await save("visible.md", "visible");
  await mkdir(join(root, "Secret"), { recursive: true });
  await writeFile(join(root, "Secret/hidden.md"), "excluded");
  await symlink(join(root, "Secret"), join(root, "linked"));
  const ask = vi.spyOn(client, "history");
  const before = await snapshot();
  for (const path of ["Secret/hidden.md", "linked/hidden.md", ".trew/config.json", "../visible.md"])
    await expect(history.content(path, 1)).rejects.toThrow();
  expect(ask).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
});

it("advances deleted pages across filtered rows and retains restorable zero", async () => {
  for (const path of ["a.md", "b.md", "Secret/hidden.md"]) await save(path, "body " + path);
  for (const path of ["a.md", "b.md", "Secret/hidden.md"]) {
    await rm(join(root, path));
    client.noteChanged(path);
    await client.settle();
  }
  let before: number | undefined,
    omitted = 0;
  const found: string[] = [];
  for (let pageCount = 0; pageCount < 10; pageCount++) {
    const page = await history.deleted({ limit: 1, before });
    omitted += page.omitted;
    found.push(...page.notes.map((note) => note.path));
    if (!page.more) {
      expect(page.nextBefore).toBeNull();
      break;
    }
    expect(page.nextBefore).not.toBeNull();
    if (before !== undefined) expect(page.nextBefore).toBeLessThan(before);
    before = page.nextBefore!;
  }
  expect(found.sort()).toEqual(["a.md", "b.md"]);
  expect(omitted).toBe(1);
  const original = await client.deleted(10);
  const note = original.notes.find((note) => note.path === "a.md")!;
  vi.spyOn(client, "deleted").mockResolvedValue({
    notes: [{ ...note, restorable: 0 }],
    more: false,
    oldest: note.uid,
  });
  expect((await history.deleted({})).notes[0]!.restorable).toBe(0);
});

it("rejects non-content, oversized, corrupt and invalid UTF-8 historical bodies before publication", async () => {
  await save("source.md", "valid source");
  const version = (await client.history("source.md"))[0]!;
  const { host } = await connectedTools();
  const find = vi.spyOn(client, "findVersion");
  const fetch = vi.spyOn(client, "contentAt");
  for (const bad of [
    { ...version, folder: true },
    { ...version, deleted: true },
    { ...version, size: 1024 * 1024 + 1 },
  ]) {
    find.mockResolvedValue(bad);
    fetch.mockClear();
    const result = await tool(host, "restore_note", {
      path: "source.md",
      uid: version.uid,
      to: "recovered.md",
    });
    expect(result.applied).toBe(false);
    expect(result.error).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  }
  find.mockResolvedValue(version);
  for (const content of [Buffer.from([255]), Buffer.alloc(1024 * 1024 + 1)]) {
    fetch.mockResolvedValue(content);
    const result = await tool(host, "restore_note", {
      path: "source.md",
      uid: version.uid,
      to: "recovered.md",
    });
    expect(result.applied).toBe(false);
    expect(result.error).toBeDefined();
  }
  fetch.mockRejectedValue(new Error("authenticated chunk verification failed"));
  expect(
    (await tool(host, "restore_note", { path: "source.md", uid: version.uid, to: "recovered.md" }))
      .applied,
  ).toBe(false);
  await expect(readFile(join(root, "recovered.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "source.md"), "utf8")).toBe("valid source");
});

it("keeps a competing restore destination and does not continue onto a replacement client", async () => {
  await save("source.md", "historical bytes");
  const version = (await client.history("source.md"))[0]!;
  const { host } = await connectedTools();
  const original = client.contentAt.bind(client);
  const fetch = vi.spyOn(client, "contentAt").mockImplementationOnce(async (version) => {
    const bytes = await original(version);
    await writeFile(join(root, "occupied.md"), "an independent editor");
    return bytes;
  });
  const raced = await tool(host, "restore_note", {
    path: "source.md",
    uid: version.uid,
    to: "occupied.md",
  });
  expect(raced).toMatchObject({ applied: false, error: { code: "exists" } });
  expect(await readFile(join(root, "occupied.md"), "utf8")).toBe("an independent editor");
  const previous = client;
  fetch.mockImplementationOnce(async (version) => {
    const bytes = await original(version);
    await previous.close();
    client = new Client(options);
    await client.connect();
    await client.settle();
    return bytes;
  });
  const disconnected = await tool(host, "restore_note", {
    path: "source.md",
    uid: version.uid,
    to: "after-reconnect.md",
  });
  expect(disconnected).toMatchObject({ applied: false, error: { code: "not_ready" } });
  await expect(readFile(join(root, "after-reconnect.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rechecks read-only mode before any restore filesystem or history work", async () => {
  const { host, session } = await connectedTools();
  Object.defineProperty(session, "mode", { value: "read-only" });
  const check = vi.spyOn(reader.vault, "checkPath"),
    lookup = vi.spyOn(client, "findVersion"),
    create = vi.spyOn(writer, "create");
  const result = await tool(host, "restore_note", {
    path: "source.md",
    uid: 1,
    to: "recovered.md",
  });
  expect(result).toMatchObject({ applied: false, error: { code: "read_only" } });
  expect(check).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("refuses an unpageable history entry instead of declaring a false end of history", async () => {
  await save("source.md", "body");
  const version = (await client.history("source.md"))[0]!;
  vi.spyOn(client, "history").mockResolvedValue([
    { ...version, device: "\u0001".repeat(128 * 1024) },
  ]);
  await expect(history.history({ path: "source.md", limit: 1 })).rejects.toMatchObject({
    code: "entry_too_large",
  });
});

it("advances past oversized excluded deletion metadata instead of repeating the same cursor", async () => {
  await save("source.md", "body");
  const version = (await client.history("source.md"))[0]!;
  vi.spyOn(client, "deleted").mockResolvedValue({
    notes: [{ ...version, path: "\u0001".repeat(30000) + ".md", deleted: true, restorable: 0 }],
    more: false,
    oldest: version.uid,
  });
  expect(await history.deleted({ limit: 1 })).toMatchObject({
    notes: [],
    omitted: 1,
    more: false,
    nextBefore: null,
  });
});

it("reuses checked inventory for preview pages while checking remote-only paths and exclusions", async () => {
  await save("local.md", "saved local body");
  await save("missing.md", "saved remote body");
  await save("Secret/hidden.md", "excluded body");
  await inspect();
  await rm(join(root, "missing.md"));
  const before = await snapshot();
  const check = vi.spyOn(reader.vault, "checkPath");
  const first = await history.preview({ limit: 1 });
  expect(first.files.map((file) => file.path)).toEqual(["local.md"]);
  expect(first.omitted).toBe(1);
  expect(first.counts.unchanged).toBe(1);
  expect(first.nextAfter).toBeTypeOf("string");
  expect(check.mock.calls.some(([path]) => path === "local.md")).toBe(false);
  expect(check.mock.calls.some(([path]) => path === "missing.md")).toBe(true);
  const second = await history.preview({ limit: 1, after: first.nextAfter! });
  expect(second.files.map((file) => file.path)).toEqual(["missing.md"]);
  expect(second.nextAfter).toBeNull();
  expect(await snapshot()).toEqual(before);
});

it("compares authenticated history with local bytes without changing either version", async () => {
  await save("compare.md", "\ufeffkeep\r\nold task\r\nUNSENT original\r\n");
  const uid = (await client.history("compare.md"))[0]!.uid;
  await save("compare.md", "\ufeffkeep\r\nnew task\r\nUNSENT original\r\n");
  const before = await snapshot();
  const { host } = await connectedTools();
  const result = await tool(host, "compare_versions", { path: "compare.md", fromUid: uid });
  expect(result).toMatchObject({ complete: true, coarse: false, from: { uid }, to: { uid: null } });
  expect(result.changes).toEqual([
    {
      fromLine: 2,
      toLine: 2,
      old: "old task\r\n",
      new: "new task\r\n",
      oldLines: 1,
      newLines: 1,
      clipped: false,
    },
  ]);
  expect(await snapshot()).toEqual(before);
});
it("pins comparison pages to both complete bases and refuses another path's version", async () => {
  await save("compare.md", "old A\nkeep\nold B\n");
  const uid = (await client.history("compare.md"))[0]!.uid;
  await save("compare.md", "new A\nkeep\nnew B\n");
  await save("other.md", "private other");
  const other = (await client.history("other.md"))[0]!.uid;
  const { host } = await connectedTools();
  const page = await tool(host, "compare_versions", { path: "compare.md", fromUid: uid, limit: 1 });
  expect(page.nextAfter).toBe(1);
  const next = await tool(host, "compare_versions", {
    path: "compare.md",
    fromUid: uid,
    after: page.nextAfter,
    fromBase: page.from.base,
    toBase: page.to.base,
    limit: 1,
  });
  expect(next.changes[0]).toMatchObject({ old: "old B\n", new: "new B\n" });
  await save("compare.md", "changed between pages");
  expect(
    await tool(host, "compare_versions", {
      path: "compare.md",
      fromUid: uid,
      after: page.nextAfter,
      fromBase: page.from.base,
      toBase: page.to.base,
    }),
  ).toMatchObject({ error: { code: "stale" } });
  expect(
    await tool(host, "compare_versions", { path: "compare.md", fromUid: other }),
  ).toMatchObject({ error: { code: "version_not_found" } });
});
it("reports device checkpoints without claiming an offline or unconfirmed device received changes", async () => {
  const { host } = await connectedTools();
  const cursor = client.serverCursor;
  const row = {
    id: "private id",
    name: "phone",
    createdAt: 1,
    lastSeen: 2,
    online: true,
    applied: cursor,
  };
  vi.spyOn(client, "devices").mockResolvedValue({
    devices: [
      row,
      { ...row, name: "offline", online: false, applied: null },
      { ...row, name: "unknown", applied: null },
    ],
    maxDevices: 10,
    invites: [{ id: "private invite", expiresAt: 100 }],
  });
  const ready = vi.spyOn(client, "deliveryReady", "get").mockReturnValue(true);
  const result = await tool(host, "delivery_status");
  expect(result.localReady).toBe(true);
  expect(result.devices.map((row: { state: string }) => row.state)).toEqual([
    "received",
    "unconfirmed",
    "unconfirmed",
  ]);
  expect(JSON.stringify(result)).not.toContain("private");
  ready.mockReturnValue(false);
  expect(
    (await tool(host, "delivery_status")).devices.every(
      (row: { state: string }) => row.state === "unconfirmed",
    ),
  ).toBe(true);
});
