import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  Client as Host,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../core/client.ts";
import { sealPath } from "../core/crypto.ts";
import { Transport, ProtocolError } from "../core/transport.ts";
import { TestServer, removeTree } from "../core/test-server.ts";
import { deferred, within, receiveCommitted } from "../core/test-async.ts";
import { seams } from "../core/seam.ts";
import { NodeVault } from "../cli/vault.ts";
import { McpReader } from "../cli/mcp-read.ts";
import { createTools } from "../cli/mcp-tools.ts";
import { buildMcp, cli, tool } from "../cli/mcp-test.ts";
import { mcpProcess } from "../cli/mcp-process-test.ts";
import { device, reopen, fingerprint, settle, type Device, SUITE_SECRET } from "./harness.ts";
import { startHttp } from "../cli/mcp-http.ts";
import { openHttp } from "../cli/mcp-http-test.ts";
import { saveConfig } from "../cli/config.ts";

let server: TestServer, buildDir: string, bundle: string;
const dirs: string[] = [],
  clients: Client[] = [],
  hosts: Host[] = [];
const registries: ReturnType<typeof createTools>[] = [];
const children: { dispose(): Promise<void> }[] = [];
const httpServers: Awaited<ReturnType<typeof startHttp>>[] = [];
const releases: (() => void)[] = [];
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "trew-mcp-crash-build-"));
  bundle = await buildMcp(buildDir, "./mcp-fault-child.ts");
});
afterAll(async () => removeTree(buildDir));
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  for (const child of children.splice(0)) await child.dispose();
  for (const c of clients.splice(0)) await c.close();
  for (const http of httpServers.splice(0)) await http.close();
  for (const registry of registries.splice(0)) {
    await registry.drain();
    await registry.server.close();
  }
  for (const host of hosts.splice(0)) await host.close();
  await server?.cleanup();
  for (const dir of dirs.splice(0)) await removeTree(dir);
});
async function setup(singlePut = false, overHttp = false) {
  server = new TestServer();
  if (singlePut) server.extraArgs = ["-max-batch-bytes", "1048576"];
  await server.start();
  const a = await device(server, "agent", dirs, clients);
  let baseline = "PREEXISTING BRANCH\nOriginal first line.\nOriginal second line.\n";
  if (singlePut) baseline = (baseline + "filler\n".repeat(160000)).slice(0, 1024 * 1024 - 200);
  await writeFile(join(a.dir, "note.md"), baseline);
  await settle([a], 1);
  const b = await device(server, "phone", dirs, clients);
  await settle([b], 1);
  const original = baseline + "\nUNSENT LOCAL MATERIAL\n";
  await writeFile(join(a.dir, "note.md"), original);
  a.c.noteChanged("note.md");
  const reader = new McpReader(new NodeVault(a.dir, { observeOnly: true }));
  await reader.vault.probeCase();
  const writer = await a.c.mutateLocal(async ({ vault }) => vault);
  const session = {
    mode: "writable" as const,
    reader,
    writer: writer as NodeVault,
    client: () => a.c,
    stopping: () => false,
    changed: () => {},
    summary: () => ({}),
    status: async () => ({}),
  };
  if (overHttp) {
    // The harness registers devices directly; token issuance requires the
    // same local pairing state as the actual CLI owner.
    await saveConfig(a.dir, {
      url: server.wsUrl,
      vaultId: "default",
      device: "agent",
      secret: SUITE_SECRET,
    });
    const issued = await cli("mcp-token", "--dir", a.dir);
    expect(issued.code, issued.err).toBe(0);
    const http = await startHttp(
      a.dir,
      () => createTools(session, "test"),
      { host: "127.0.0.1", port: 0, allowOrigins: [], log: () => {} },
      (error) => {
        if (error) throw error;
      },
    );
    httpServers.push(http);
    const agents: Host[] = [];
    for (let i = 0; i < 3; i++) {
      const host = new Host(
        { name: `http-stress-${i}`, version: "1" },
        { versionNegotiation: { mode: i === 0 ? "legacy" : { pin: "2026-07-28" } } },
      );
      hosts.push(host);
      agents.push(host);
      await host.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
          authProvider: { token: async () => issued.out.trim() },
        }),
      );
    }
    return { a, b, host: agents[0]!, agents, original, baseline };
  }
  const registry = createTools(session, "test");
  registries.push(registry);
  const [hostWire, serverWire] = InMemoryTransport.createLinkedPair();
  await registry.server.connect(serverWire);
  const host = new Host({ name: "stress", version: "1" });
  await host.connect(hostWire);
  hosts.push(host);
  return { a, b, host, agents: [host], original, baseline };
}
async function retained(d: Device, markers: string[]) {
  const bodies = await Promise.all(
    [...(await fingerprint(d.dir)).keys()].map((path) => readFile(join(d.dir, path), "utf8")),
  );
  for (const marker of markers)
    expect(bodies.join("\n"), `lost ${marker} on ${d.dir}`).toContain(marker);
}

async function httpChild(dir: string, token: string) {
  const owner = await openHttp(bundle, dir, token, ["--writable"]);
  const responses = new Map<string | number, unknown>();
  return {
    child: owner.child,
    responses,
    initialize: async () => {},
    async ready() {
      await within(
        (async () => {
          while (!(await tool(owner.client, "sync_status")).writeReady)
            await new Promise<void>((resolve) => setImmediate(resolve));
        })(),
        "HTTP crash child readiness",
        15000,
      );
    },
    tool: (name: string, args: Record<string, unknown> = {}) => tool(owner.client, name, args),
    send(message: {
      id: string | number;
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    }) {
      void owner.client.callTool(message.params).then(
        (result) => responses.set(message.id, result),
        (error) => responses.set(message.id, error),
      );
    },
    hold: owner.hold,
    async reached(name: string) {
      await owner.reached(name);
      return owner.messages.find(
        (value) =>
          value && typeof value === "object" && "reached" in value && value.reached === name,
      ) as { path: string };
    },
    exited: owner.exited,
    async dispose() {
      if (owner.child.exitCode === null && owner.child.signalCode === null)
        owner.child.kill("SIGKILL");
      await owner.close();
    },
  };
}

it.each(
  ["disjoint", "overlap", "append", "delete", "rename", "lost-reply"].flatMap((scenario) => [
    { scenario, http: false },
    { scenario, http: true },
  ]),
)(
  "MCP $scenario preserves the local commit and a phone branch after its author exits (HTTP=$http)",
  async ({ scenario, http }) => {
    const { a, b, host, agents, original, baseline } = await setup(false, http);
    const entered = deferred<void>(),
      release = deferred<void>();
    releases.push(() => release.resolve());
    const put = a.c.transport.putMany.bind(a.c.transport);
    const target = await sealPath(a.c.keys, "note.md");
    let intercepted = false,
      stale = false,
      acceptedBeforeLoss = false;
    vi.spyOn(a.c.transport, "putMany").mockImplementation(async (...args) => {
      if (intercepted) return put(...args);
      intercepted = true;
      entered.resolve();
      await release.promise;
      const reply = await put(...args);
      stale = reply.results.some((result) => result.error?.code === "stale");
      if (scenario === "lost-reply") {
        const index = args[0].findIndex((entry) => entry.path === target);
        acceptedBeforeLoss = index >= 0 && reply.results[index]!.uid > 0;
        throw new Error("test dropped the committed upload reply");
      }
      return reply;
    });
    const read = await tool(host, "read_note", { path: "note.md" });
    const result =
      scenario === "append"
        ? await tool(agents[1] ?? host, "append_note", {
            path: "note.md",
            base: read.base,
            text: "AGENT COMMIT\n",
          })
        : await tool(agents[1] ?? host, "edit_note", {
            path: "note.md",
            base: read.base,
            edits: [{ old: "Original first line.", new: "AGENT COMMIT" }],
          });
    expect(result).toMatchObject({ applied: true, durable: true });
    expect((await tool(agents[2] ?? host, "read_note", { path: result.beforeImage })).content).toBe(
      original,
    );
    await within(entered.promise, "prepared MCP upload");
    const markers = ["PREEXISTING BRANCH", "UNSENT LOCAL MATERIAL", "AGENT COMMIT"];
    if (scenario === "delete") {
      await rm(join(b.dir, "note.md"));
      b.c.noteChanged("note.md");
    } else if (scenario === "rename") {
      await rename(join(b.dir, "note.md"), join(b.dir, "moved.md"));
      await b.c.noteRename("note.md", "moved.md");
      await writeFile(join(b.dir, "moved.md"), baseline + "PHONE BRANCH\n");
      b.c.noteChanged("moved.md");
      markers.push("PHONE BRANCH");
    } else if (scenario !== "lost-reply") {
      const remote = baseline.replace(
        scenario === "overlap" ? "Original first line." : "Original second line.",
        "PHONE BRANCH",
      );
      await writeFile(join(b.dir, "note.md"), remote);
      b.c.noteChanged("note.md");
      markers.push("PHONE BRANCH");
    }
    await b.c.settle();
    await b.c.close();
    await receiveCommitted(a.c.transport);
    release.resolve();
    await a.c.settle({ retryFailures: true }, 16);
    await settle([a], 3);
    if (scenario === "lost-reply") expect(acceptedBeforeLoss).toBe(true);
    else expect(stale).toBe(true);
    if (http) {
      const submitted = await Promise.all(
        agents.map((agent, i) =>
          tool(agent, "create_note", {
            path: `session-${i}.md`,
            content: `HTTP SESSION ${i} COMMIT\n`,
          }),
        ),
      );
      expect(submitted.every((result) => result.applied === true && result.durable === true)).toBe(
        true,
      );
      markers.push(...agents.map((_, i) => `HTTP SESSION ${i} COMMIT`));
      await settle([a], 2);
    }
    const fresh = await device(server, "fresh-reader", dirs, clients);
    await settle([fresh], 2);
    await retained(a, markers);
    await retained(fresh, markers);
    expect(await readFile(join(fresh.dir, result.beforeImage), "utf8")).toBe(original);
  },
);

// Each row must report that the child reached it before the parent kills it.
// The adapter's nameFree point is after parking and before publication.
const CRASH_SEAMS = [
  "cli/mcp:backupVerified",
  "cli/mcp:backupDurable",
  "cli/vault:replace.staged",
  "cli/vault:replace.nameFree",
  "cli/mcp:published",
  "cli/mcp:durable",
] as const;
it("accounts for every MCP mutation seam in the crash matrix", () => {
  expect(
    seams()
      .filter((point) => point.name.startsWith("cli/mcp:"))
      .map((point) => point.name)
      .sort(),
  ).toEqual(
    CRASH_SEAMS.filter((name) => name.startsWith("cli/mcp:"))
      .slice()
      .sort(),
  );
});
it.each(
  CRASH_SEAMS.flatMap((point) => [
    { point, http: false },
    { point, http: true },
  ]),
)(
  "a real MCP process killed at $point leaves acknowledged and preexisting bytes discoverable (HTTP=$http)",
  async ({ point, http }) => {
    server = new TestServer();
    await server.start();
    const dir = await mkdtemp(join(tmpdir(), "trew-mcp-crash-"));
    dirs.push(dir);
    const initialized = await cli("init", server.setup, "--dir", dir, "--json");
    expect(initialized.code, initialized.err).toBe(0);
    const key = JSON.parse(initialized.out).recoveryKey;
    const token = http ? await cli("mcp-token", "--dir", dir) : undefined;
    if (token) expect(token.code).toBe(0);
    await writeFile(join(dir, "note.md"), "PREEXISTING CRASH BRANCH\n");
    const child = http ? await httpChild(dir, token!.out.trim()) : mcpProcess(bundle, dir);
    children.push(child);
    await child.initialize();
    await child.ready();
    const first = await child.tool("read_note", { path: "note.md" });
    const committed = await child.tool("append_note", {
      path: "note.md",
      base: first.base,
      text: "ACKNOWLEDGED COMMIT\n",
    });
    expect(committed).toMatchObject({ applied: true, durable: true });
    await child.hold(point);
    child.send({
      id: "crash-edit",
      method: "tools/call",
      params: {
        name: "edit_note",
        arguments: {
          path: "note.md",
          base: committed.base,
          edits: [{ old: "PREEXISTING CRASH BRANCH", new: "PROPOSED SECOND EDIT" }],
        },
      },
    });
    expect((await child.reached(point)).path).toBe("note.md");
    expect(child.responses.has("crash-edit")).toBe(false);
    child.child.kill("SIGKILL");
    expect((await child.exited()).signal).toBe("SIGKILL");
    const observer = new NodeVault(dir, { observeOnly: true });
    const stats = await observer.list({ forceFull: true, checked: true });
    expect(observer.recovery.complete).toBe(true);
    const copies = await Promise.all(
      stats.filter((stat) => !stat.folder).map((stat) => observer.read(stat.path)),
    );
    const retainedBytes = copies.map((bytes) => Buffer.from(bytes).toString()).join("\n");
    expect(retainedBytes).toContain("PREEXISTING CRASH BRANCH");
    expect(retainedBytes).toContain("ACKNOWLEDGED COMMIT");
    if (point === "cli/mcp:published" || point === "cli/mcp:durable")
      expect(retainedBytes).toContain("PROPOSED SECOND EDIT");
    const restarted = http ? await httpChild(dir, token!.out.trim()) : mcpProcess(bundle, dir);
    children.push(restarted);
    await restarted.initialize();
    await restarted.ready();
    if (http) restarted.child.kill("SIGTERM");
    else restarted.child.stdin!.end();
    expect((await restarted.exited()).code).toBe(0);
    const fresh = await mkdtemp(join(tmpdir(), "trew-mcp-crash-reader-"));
    dirs.push(fresh);
    expect((await cli("pair", key, "--dir", fresh)).code).toBe(0);
    expect((await cli("sync", "--dir", fresh)).code).toBe(0);
    const files = await new NodeVault(fresh, { observeOnly: true }).list();
    const remoteBytes = (
      await Promise.all(
        files
          .filter((file) => !file.folder)
          .map((file) => readFile(join(fresh, file.path), "utf8")),
      )
    ).join("\n");
    expect(remoteBytes).toContain("PREEXISTING CRASH BRANCH");
    expect(remoteBytes).toContain("ACKNOWLEDGED COMMIT");
  },
);

it("an offline phone catches up without losing its independent edit or the acknowledged MCP append", async () => {
  const { a, b, host, original, baseline } = await setup();
  await b.c.close();
  await writeFile(
    join(b.dir, "note.md"),
    baseline.replace("Original second line.", "OFFLINE PHONE EDIT"),
  );
  const before = await tool(host, "read_note", { path: "note.md" });
  const result = await tool(host, "append_note", {
    path: "note.md",
    base: before.base,
    text: "ACKNOWLEDGED MCP APPEND\n",
  });
  expect(result).toMatchObject({ applied: true, durable: true });
  await settle([a], 2);
  const back = await reopen(server, "phone", b.dir, clients);
  await settle([back, a], 4);
  const fresh = await device(server, "fresh", dirs, clients);
  await settle([fresh], 2);
  for (const d of [a, back, fresh])
    await retained(d, ["OFFLINE PHONE EDIT", "ACKNOWLEDGED MCP APPEND", "UNSENT LOCAL MATERIAL"]);
  expect(await readFile(join(fresh.dir, result.beforeImage), "utf8")).toBe(original);
});

it("a stale single put from an MCP edit retains the remote branch after its author disappears", async () => {
  const { a, b, host, original, baseline } = await setup(true);
  const target = await sealPath(a.c.keys, "note.md");
  const entered = deferred<void>(),
    release = deferred<void>();
  releases.push(() => release.resolve());
  const put = Transport.prototype.put;
  let intercepted = false,
    stale = false;
  vi.spyOn(Transport.prototype, "put").mockImplementation(async function (
    this: Transport,
    ...args
  ) {
    if (intercepted || args[0] !== target) return put.apply(this, args);
    intercepted = true;
    entered.resolve();
    await release.promise;
    try {
      return await put.apply(this, args);
    } catch (error) {
      stale = error instanceof ProtocolError && error.code === "stale";
      throw error;
    }
  });
  const before = await tool(host, "read_note", { path: "note.md" });
  const result = await tool(host, "edit_note", {
    path: "note.md",
    base: before.base,
    edits: [{ old: "Original first line.", new: "AGENT COMMIT" }],
  });
  expect(result).toMatchObject({ applied: true, durable: true });
  await within(entered.promise, "single put prepared");
  await writeFile(
    join(b.dir, "note.md"),
    baseline.replace("Original second line.", "PHONE BRANCH"),
  );
  b.c.noteChanged("note.md");
  await b.c.settle();
  await b.c.close();
  release.resolve();
  await a.c.settle({ retryFailures: true }, 16);
  await settle([a], 3);
  expect(stale).toBe(true);
  const fresh = await device(server, "single-put-reader", dirs, clients);
  await settle([fresh], 2);
  for (const d of [a, fresh])
    await retained(d, ["AGENT COMMIT", "PHONE BRANCH", "UNSENT LOCAL MATERIAL"]);
  expect(await readFile(join(fresh.dir, result.beforeImage), "utf8")).toBe(original);
});

it("a restore survives a kill before its reply, and retry never creates a second destination", async () => {
  server = new TestServer();
  await server.start();
  const dir = await mkdtemp(join(tmpdir(), "trew-mcp-restore-kill-"));
  dirs.push(dir);
  const initialized = await cli("init", server.setup, "--dir", dir, "--json");
  expect(initialized.code).toBe(0);
  const key = JSON.parse(initialized.out).recoveryKey;
  const original = "HISTORICAL RESTORE BRANCH\n";
  await writeFile(join(dir, "source.md"), original);
  expect((await cli("sync", "--dir", dir)).code).toBe(0);
  await writeFile(join(dir, "source.md"), "CURRENT SOURCE BRANCH\n");
  expect((await cli("sync", "--dir", dir)).code).toBe(0);
  const child = mcpProcess(bundle, dir);
  children.push(child);
  await child.initialize();
  await child.ready();
  const history = await child.tool("note_history", { path: "source.md" });
  const uid = history.versions[1].uid;
  expect((await child.tool("read_note", { path: "source.md", uid })).content).toBe(original);
  await child.hold("cli/mcp:durable");
  const args = { path: "source.md", uid, to: "recovered.md" };
  child.send({
    id: "restore",
    method: "tools/call",
    params: { name: "restore_note", arguments: args },
  });
  expect((await child.reached("cli/mcp:durable")).path).toBe("recovered.md");
  expect(child.responses.has("restore")).toBe(false);
  child.child.kill("SIGKILL");
  expect((await child.exited()).signal).toBe("SIGKILL");
  const restarted = mcpProcess(bundle, dir);
  children.push(restarted);
  await restarted.initialize();
  await restarted.ready();
  expect((await restarted.tool("read_note", { path: "recovered.md" })).content).toBe(original);
  expect(await restarted.tool("restore_note", args)).toMatchObject({
    applied: false,
    error: { code: "exists" },
  });
  expect((await restarted.tool("list_notes", { nameContains: "recovered" })).entries).toHaveLength(
    1,
  );
  restarted.child.stdin.end();
  expect((await restarted.exited()).code).toBe(0);
  const fresh = await mkdtemp(join(tmpdir(), "trew-mcp-restore-fresh-"));
  dirs.push(fresh);
  expect((await cli("pair", key, "--dir", fresh)).code).toBe(0);
  expect((await cli("sync", "--dir", fresh)).code).toBe(0);
  expect(await readFile(join(fresh, "recovered.md"), "utf8")).toBe(original);
  expect(await readFile(join(fresh, "source.md"), "utf8")).toBe("CURRENT SOURCE BRANCH\n");
});

it("an admitted MCP edit finishes across server disconnection and reaches a fresh device after reconnect", async () => {
  server = new TestServer();
  await server.start();
  const dir = await mkdtemp(join(tmpdir(), "trew-mcp-disconnect-"));
  dirs.push(dir);
  const initialized = await cli("init", server.setup, "--dir", dir, "--json");
  expect(initialized.code).toBe(0);
  const key = JSON.parse(initialized.out).recoveryKey;
  await writeFile(join(dir, "note.md"), "BEFORE DISCONNECTION\n");
  const child = mcpProcess(bundle, dir);
  children.push(child);
  await child.initialize();
  await child.ready();
  const before = await child.tool("read_note", { path: "note.md" });
  await child.hold("cli/mcp:backupDurable");
  const pending = child.tool("append_note", {
    path: "note.md",
    base: before.base,
    text: "ADMITTED WHILE ONLINE\n",
  });
  void pending.catch(() => undefined);
  await child.reached("cli/mcp:backupDurable");
  const port = server.port;
  await server.stop();
  await within(
    (async () => {
      while ((await child.tool("sync_status")).writeReady)
        await new Promise<void>((resolve) => setImmediate(resolve));
    })(),
    "the disconnected client to stop admitting writes",
  );
  child.release();
  const result = await pending;
  expect(result).toMatchObject({ applied: true, durable: true });
  await server.start(port);
  await child.ready();
  expect((await child.tool("read_note", { path: result.beforeImage })).content).toBe(
    before.content,
  );
  child.child.stdin.end();
  expect((await child.exited()).code).toBe(0);
  const fresh = await mkdtemp(join(tmpdir(), "trew-mcp-reconnect-reader-"));
  dirs.push(fresh);
  expect((await cli("pair", key, "--dir", fresh)).code).toBe(0);
  expect((await cli("sync", "--dir", fresh)).code).toBe(0);
  expect(await readFile(join(fresh, "note.md"), "utf8")).toBe(
    "BEFORE DISCONNECTION\nADMITTED WHILE ONLINE\n",
  );
  expect(await readFile(join(fresh, result.beforeImage), "utf8")).toBe(before.content);
});

it.each(
  ["delete_note", "move_note", "add_tags"].flatMap((name) =>
    [false, true].map((http) => ({ name, http })),
  ),
)(
  "namespace $name retains a disconnected phone branch and all local input (HTTP=$http)",
  async ({ name, http }) => {
    const { a, b, host, original, baseline } = await setup(false, http);
    const entered = deferred<void>(),
      release = deferred<void>();
    releases.push(() => release.resolve());
    const put = a.c.transport.putMany.bind(a.c.transport);
    let intercepted = false;
    vi.spyOn(a.c.transport, "putMany").mockImplementation(async (...args) => {
      if (!intercepted) {
        intercepted = true;
        entered.resolve();
        await release.promise;
      }
      return put(...args);
    });
    const args =
      name === "move_note"
        ? { path: "note.md", to: "moved.md" }
        : name === "delete_note"
          ? { path: "note.md" }
          : { paths: ["note.md"], tags: ["AGENT_TAG"] };
    const preview = await tool(host, name, args);
    const result = await tool(host, name, { ...args, changes: preview.changes });
    expect(result.complete).toBe(true);
    const originalRow = result.results.find((row: { path: string }) => row.path === "note.md");
    expect(await readFile(join(a.dir, originalRow.beforeImage), "utf8")).toBe(original);
    await within(entered.promise, "namespace upload before remote edit");
    await writeFile(join(b.dir, "note.md"), baseline + "PHONE NAMESPACE BRANCH\n");
    b.c.noteChanged("note.md");
    await b.c.settle();
    await b.c.close();
    await receiveCommitted(a.c.transport);
    release.resolve();
    await a.c.settle({ retryFailures: true }, 16);
    await settle([a], 3);
    const fresh = await device(server, "namespace-reader", dirs, clients);
    await settle([fresh], 2);
    const markers = ["PREEXISTING BRANCH", "UNSENT LOCAL MATERIAL", "PHONE NAMESPACE BRANCH"];
    if (name === "add_tags") markers.push("AGENT_TAG");
    for (const d of [a, fresh]) await retained(d, markers);
    expect(await readFile(join(fresh.dir, originalRow.beforeImage), "utf8")).toBe(original);
    if (name === "move_note")
      expect(await readFile(join(fresh.dir, "moved.md"), "utf8")).toBe(original);
  },
);

it.each(
  [
    { name: "move_note", point: "cli/mcp:durable" },
    { name: "move_note", point: "cli/vault:trash.parked" },
    { name: "delete_note", point: "cli/vault:trash.parked" },
    { name: "add_tags", point: "cli/mcp:published" },
  ].flatMap((row) => [false, true].map((http) => ({ ...row, http }))),
)(
  "namespace crash at $point during $name retains all before-images through restart (HTTP=$http)",
  async ({ name, point, http }) => {
    server = new TestServer();
    await server.start();
    const dir = await mkdtemp(join(tmpdir(), "trew-namespace-crash-"));
    dirs.push(dir);
    const init = await cli("init", server.setup, "--dir", dir, "--json");
    expect(init.code, init.err).toBe(0);
    const key = JSON.parse(init.out).recoveryKey;
    const token = http ? await cli("mcp-token", "--dir", dir) : undefined;
    await writeFile(join(dir, "a.md"), "ACKNOWLEDGED A UNSENT SOURCE\n");
    await writeFile(join(dir, "b.md"), "ACKNOWLEDGED B [[a]]\n");
    const child = http ? await httpChild(dir, token!.out.trim()) : mcpProcess(bundle, dir);
    children.push(child);
    await child.initialize();
    await child.ready();
    const args =
      name === "move_note"
        ? { path: "a.md", to: "moved.md" }
        : name === "delete_note"
          ? { path: "a.md" }
          : { paths: ["a.md", "b.md"], tags: ["agent"] };
    const preview = await child.tool(name, args);
    await child.hold(point);
    child.send({
      id: "namespace-crash",
      method: "tools/call",
      params: { name, arguments: { ...args, changes: preview.changes } },
    });
    const reached = await child.reached(point);
    expect(reached.path).toBeTypeOf("string");
    expect(child.responses.has("namespace-crash")).toBe(false);
    child.child.kill("SIGKILL");
    expect((await child.exited()).signal).toBe("SIGKILL");
    const observer = new NodeVault(dir, { observeOnly: true });
    const files = await observer.list({ forceFull: true, checked: true });
    const local = (
      await Promise.all(
        files.filter((file) => !file.folder).map((file) => readFile(join(dir, file.path), "utf8")),
      )
    ).join("\n");
    expect(local).toContain("ACKNOWLEDGED A UNSENT SOURCE");
    expect(local).toContain("ACKNOWLEDGED B [[a]]");
    const restarted = http ? await httpChild(dir, token!.out.trim()) : mcpProcess(bundle, dir);
    children.push(restarted);
    await restarted.initialize();
    await restarted.ready();
    if (http) restarted.child.kill("SIGTERM");
    else restarted.child.stdin!.end();
    expect((await restarted.exited()).code).toBe(0);
    const fresh = await mkdtemp(join(tmpdir(), "trew-namespace-crash-reader-"));
    dirs.push(fresh);
    expect((await cli("pair", key, "--dir", fresh)).code).toBe(0);
    const synced = await cli("sync", "--dir", fresh);
    expect(synced.code, synced.err).toBe(0);
    const remoteFiles = await new NodeVault(fresh, { observeOnly: true }).list();
    const remote = (
      await Promise.all(
        remoteFiles
          .filter((file) => !file.folder)
          .map((file) => readFile(join(fresh, file.path), "utf8")),
      )
    ).join("\n");
    expect(remote).toContain("ACKNOWLEDGED A UNSENT SOURCE");
    expect(remote).toContain("ACKNOWLEDGED B [[a]]");
  },
);
