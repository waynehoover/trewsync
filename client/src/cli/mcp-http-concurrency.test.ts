import { afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "../core/client.ts";
import { MemoryIndexStore } from "../core/vault.ts";
import { TestServer, removeTree } from "../core/test-server.ts";
import { testWrapped } from "../core/test-keys.ts";
import { deferred, within } from "../core/test-async.ts";
import { seamNamed } from "../core/seam.ts";
import { httpFixture, initialize } from "./mcp-http-test.ts";
import { cli, tool } from "./mcp-test.ts";
import { readMcpToken, authenticateMcp } from "./mcp-token.ts";
import { NodeVault } from "./vault.ts";
import { device, settle, SUITE_SECRET, type Device } from "../stress/harness.ts";

let server: TestServer | undefined;
let host: Awaited<ReturnType<typeof httpFixture>> | undefined;
const clients: Client[] = [],
  dirs: string[] = [],
  releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
  await host?.close();
  host = undefined;
  await server?.cleanup();
  server = undefined;
  for (const dir of dirs.splice(0)) await removeTree(dir);
});
async function setup(now?: () => number) {
  server = new TestServer();
  await server.start();
  let current: Client | undefined;
  host = await httpFixture({ mode: "writable", client: () => current, ...(now ? { now } : {}) });
  const vault = host.session.writer;
  await vault.probeCase();
  current = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(SUITE_SECRET, await testWrapped(SUITE_SECRET), "agent")),
    vaultId: "default",
    device: "agent",
    coalesceWrites: false,
    timeoutMs: 30000,
  });
  clients.push(current);
  await current.connect();
  await current.settle();
  const agent: Device = { c: current, dir: host.root };
  return { http: host, agent, server };
}
function hold(name: string) {
  const entered = deferred<void>(),
    release = deferred<void>();
  const undo = seamNamed(name).hold(async () => {
    entered.resolve();
    await release.promise;
  });
  releases.push(() => {
    release.resolve();
    undo();
  });
  return {
    entered: () => within(entered.promise, name),
    release: () => {
      release.resolve();
      undo();
    },
  };
}
async function backups(http: Awaited<ReturnType<typeof httpFixture>>, path?: string) {
  const { client } = await http.client(true);
  const listed = await tool(client, "list_notes", { includeBackups: true });
  return listed.entries.filter(
    (entry: { backupOf?: string }) => entry.backupOf && (!path || entry.backupOf === path),
  );
}

it("serializes disjoint HTTP mutations and sends both notes and before-images to a phone", async () => {
  const { http, agent, server } = await setup();
  await writeFile(join(http.root, "second.md"), "second original\n");
  agent.c.noteChanged("second.md");
  await agent.c.settle();
  const a = await http.client(),
    b = await http.client(true);
  const paths = ["note.md", "second.md"];
  const reads = await Promise.all(
    [a.client, b.client].map((client, i) => tool(client, "read_note", { path: paths[i] })),
  );
  const results = await Promise.all(
    [a.client, b.client].map((client, i) =>
      tool(client, "append_note", {
        path: paths[i],
        base: reads[i]!.base,
        text: `accepted ${i}\n`,
      }),
    ),
  );
  expect(results.every((result) => result.applied === true && result.durable === true)).toBe(true);
  expect(await backups(http)).toHaveLength(2);
  await settle([agent], 2);
  const phone = await device(server, "phone", dirs, clients);
  await settle([phone], 2);
  for (const [i, result] of results.entries()) {
    expect(await readFile(join(phone.dir, paths[i]!), "utf8")).toBe(
      reads[i]!.content + `accepted ${i}\n`,
    );
    expect(await readFile(join(phone.dir, result.beforeImage), "utf8")).toBe(reads[i]!.content);
  }
});

it("a retry on the same session and another session queues behind a held append without applying twice", async () => {
  const { http } = await setup();
  const a = await http.client(),
    b = await http.client();
  const read = await tool(a.client, "read_note", { path: "note.md" });
  const seam = hold("cli/vault:replace.staged");
  const args = { path: "note.md", base: read.base, text: "one append\n" };
  const first = tool(a.client, "append_note", args);
  first.catch(() => {});
  await seam.entered();
  await expect(within(first, "client response deadline", 25)).rejects.toThrow("timed out");
  const retries = [tool(a.client, "append_note", args), tool(b.client, "append_note", args)];
  seam.release();
  expect(await first).toMatchObject({ applied: true, durable: true });
  for (const retry of await Promise.all(retries)) {
    expect(retry).toMatchObject({ applied: false, error: { code: "stale" } });
    expect(retry.base).toBeUndefined();
  }
  expect(await readFile(join(http.root, "note.md"), "utf8")).toBe(read.content + "one append\n");
  expect(await backups(http, "note.md")).toHaveLength(1);
});

it("the seventeenth HTTP mutation gets busy while sixteen retain their notes and before-images", async () => {
  const { http, agent } = await setup();
  const { client } = await http.client(true);
  for (let i = 0; i < 17; i++) {
    await writeFile(join(http.root, `${i}.md`), `original ${i}\n`);
    agent.c.noteChanged(`${i}.md`);
  }
  await agent.c.settle();
  const reads: Awaited<ReturnType<typeof tool>>[] = [];
  for (let i = 0; i < 17; i++) reads.push(await tool(client, "read_note", { path: `${i}.md` }));
  const seam = hold("cli/mcp:backupDurable");
  const first = tool(client, "append_note", {
    path: "0.md",
    base: reads[0]!.base,
    text: "accepted\n",
  });
  first.catch(() => {});
  await seam.entered();
  let entered = 0;
  const queued = deferred<void>();
  const mutate = agent.c.mutateLocal.bind(agent.c);
  vi.spyOn(agent.c, "mutateLocal").mockImplementation((work, options) => {
    const result = mutate(work, options);
    if (++entered === 15) queued.resolve();
    return result;
  });
  const waiting = Array.from({ length: 15 }, (_, i) =>
    tool(client, "append_note", {
      path: `${i + 1}.md`,
      base: reads[i + 1]!.base,
      text: "accepted\n",
    }),
  );
  await within(queued.promise, "fifteen queued mutations");
  const refused = await tool(client, "append_note", {
    path: "16.md",
    base: reads[16]!.base,
    text: "must not appear\n",
  });
  expect(refused).toMatchObject({ applied: false, error: { code: "busy" } });
  seam.release();
  const applied = await Promise.all([first, ...waiting]);
  expect(applied.every((result) => result.applied === true && result.durable === true)).toBe(true);
  expect(await backups(http)).toHaveLength(16);
  for (let i = 0; i < 17; i++)
    expect(await readFile(join(http.root, `${i}.md`), "utf8")).toBe(
      `original ${i}\n` + (i < 16 ? "accepted\n" : ""),
    );
});

it.each(
  [false, true].flatMap((modern) => [
    { modern, action: "rotate" },
    { modern, action: "revoke" },
  ]),
)(
  "observed $action cancels queued mutations but preserves the admitted one across five clients, modern=$modern",
  async ({ modern, action }) => {
    const { http, agent } = await setup();
    const connections = await Promise.all(Array.from({ length: 5 }, () => http.client(modern)));
    const controllers = connections.map(() => new AbortController());
    for (let i = 0; i < 5; i++) {
      await writeFile(join(http.root, `${i}.md`), `original ${i}\n`);
      agent.c.noteChanged(`${i}.md`);
    }
    await agent.c.settle();
    const reads = await Promise.all(
      connections.map(({ client }, i) => tool(client, "read_note", { path: `${i}.md` })),
    );
    const seam = hold("cli/mcp:backupDurable");
    let queued = 0;
    const allQueued = deferred<void>();
    const mutate = agent.c.mutateLocal.bind(agent.c);
    vi.spyOn(agent.c, "mutateLocal").mockImplementation((work, options) => {
      const result = mutate(work, options);
      if (++queued === 5) allQueued.resolve();
      return result;
    });
    const calls = connections.map(({ client }, i) =>
      client
        .callTool(
          {
            name: "append_note",
            arguments: { path: `${i}.md`, base: reads[i]!.base, text: "admitted\n" },
          },
          { signal: controllers[i]!.signal },
        )
        .catch(() => "cancelled"),
    );
    await seam.entered();
    await within(allQueued.promise, "five mutation calls");
    const rotated = await cli(
      "mcp-token",
      "--dir",
      http.root,
      ...(action === "revoke" ? ["--revoke"] : []),
    );
    expect(rotated.code).toBe(0);
    const refusal = await http.request(initialize());
    expect(refusal.status).toBe(401);
    await refusal.text();
    seam.release();
    await agent.c.settle();
    for (const controller of controllers) controller.abort();
    await Promise.all(calls);
    const bodies = await Promise.all(
      Array.from({ length: 5 }, (_, i) => readFile(join(http.root, `${i}.md`), "utf8")),
    );
    expect(bodies.filter((body) => body.endsWith("admitted\n"))).toHaveLength(1);
    bodies.forEach((body, i) => expect(body.startsWith(`original ${i}\n`)).toBe(true));
    const issued = action === "revoke" ? await cli("mcp-token", "--dir", http.root) : rotated;
    expect(issued.code).toBe(0);
    const fresh = await http.client(modern, issued.out.trim());
    const listing = await tool(fresh.client, "list_notes", { includeBackups: true });
    const copies = listing.entries.filter((entry: { backupOf?: string }) => entry.backupOf);
    expect(copies).toHaveLength(1);
    expect((await tool(fresh.client, "read_note", { path: copies[0].path })).content).toMatch(
      /^original [0-4]\n$/,
    );
  },
);

it("one thousand credential replacements never produce a torn authentication read", async () => {
  const { http } = await setup();
  let done = false,
    reads = 0;
  const hashes = new Set<string>();
  const reading = (async () => {
    while (!done) {
      hashes.add((await readMcpToken(http.root)).hash);
      try {
        await authenticateMcp(http.root, `Bearer ${http.token}`);
      } catch (error) {
        expect(error).toMatchObject({ status: 401 });
      }
      reads++;
    }
  })();
  reading.catch(() => {});
  let last = "";
  try {
    for (let i = 0; i < 1000; i++) {
      const issued = await cli("mcp-token", "--dir", http.root);
      expect(issued.code, issued.err).toBe(0);
      last = issued.out.trim();
    }
  } finally {
    done = true;
  }
  await reading;
  expect(reads).toBeGreaterThan(100);
  expect(hashes.size).toBeGreaterThan(1);
  const { client } = await http.client(true, last);
  expect((await tool(client, "read_note", { path: "note.md" })).content).toBe(
    "private note marker 813751\n",
  );
});

it("twenty modern readers report bounded admission and agree with sequential reads while a phone publishes two hundred notes", async () => {
  const { http, agent, server } = await setup();
  await mkdir(join(http.root, "Stable"));
  for (let i = 0; i < 30; i++) {
    await writeFile(join(http.root, `Stable/${i}.md`), `literal needle ${i}\n`);
    agent.c.noteChanged(`Stable/${i}.md`);
  }
  await agent.c.settle();
  const phone = await device(server, "phone", dirs, clients);
  await phone.c.settle();
  const strip = (value: Record<string, unknown>) => {
    const { observedAt: _time, connection: _connection, ...rest } = value;
    return rest;
  };
  let busy = 0;
  let progress = deferred<void>();
  const query = async (
    client: Awaited<ReturnType<typeof http.client>>["client"],
    name: string,
    args: Record<string, unknown>,
  ) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const advanced = progress.promise;
      const result = await tool(client, name, args);
      if (result.error?.code === "busy") {
        busy++;
        await within(advanced, "reader capacity to become available", 15000);
        continue;
      }
      progress.resolve();
      progress = deferred<void>();
      if (result.skipped?.count) {
        expect(result.complete).toBe(false);
        expect(
          result.skipped.items.every((item: { why: string }) => item.why === "changed_during_read"),
        ).toBe(true);
        continue;
      }
      if (!["busy", "changed_during_read"].includes(result.error?.code)) {
        expect(result.error).toBeUndefined();
        return strip(result);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("reader queue never made progress");
  };
  const read = async (client: Awaited<ReturnType<typeof http.client>>["client"]) => [
    await query(client, "list_notes", { folder: "Stable" }),
    await query(client, "search_notes", { folder: "Stable", query: "needle" }),
    await query(client, "read_note", { path: "Stable/10.md" }),
  ];
  const connections = await Promise.all(Array.from({ length: 20 }, () => http.client(true)));
  const sequential = await read(connections[0]!.client);
  await mkdir(join(phone.dir, "Phone"));
  for (let i = 0; i < 200; i++) {
    await writeFile(join(phone.dir, `Phone/${i}.md`), `independent phone note ${i}\n`);
    phone.c.noteChanged(`Phone/${i}.md`);
  }
  const publishing = phone.c.settle();
  const results = await Promise.all(connections.map(({ client }) => read(client)));
  for (const result of results)
    for (let i = 0; i < sequential.length; i++) expect(result[i]).toEqual(sequential[i]);
  expect(busy).toBeGreaterThan(0);
  await publishing;
  await settle([agent, phone], 3);
  const observe = new NodeVault(http.root, { observeOnly: true });
  const disk = (await observe.list({ forceFull: true, checked: true }))
    .filter((file) => !file.folder)
    .map((file) => file.path)
    .sort();
  const final = await tool(connections[0]!.client, "list_notes", { limit: 500 });
  expect(
    final.entries
      .filter((entry: { kind: string }) => entry.kind !== "folder")
      .map((entry: { path: string }) => entry.path)
      .sort(),
  ).toEqual(disk);
  expect(disk).toHaveLength(231);
});

it.each(["DELETE", "expiry"])(
  "ending a session by %s lets its admitted transaction finish",
  async (ending) => {
    let now = 1;
    const { http, agent } = await setup(() => now);
    const { client, transport } = await http.client();
    const read = await tool(client, "read_note", { path: "note.md" });
    const seam = hold("cli/mcp:backupDurable");
    const controller = new AbortController();
    const pending = client
      .callTool(
        {
          name: "append_note",
          arguments: { path: "note.md", base: read.base, text: "admitted before session end\n" },
        },
        { signal: controller.signal },
      )
      .catch(() => "cancelled");
    try {
      await seam.entered();
      const headers = {
        "mcp-session-id": transport.sessionId!,
        "mcp-protocol-version": "2025-11-25",
      };
      if (ending === "expiry") now += 30 * 60 * 1000;
      const response = await http.request(undefined, {
        method: ending === "DELETE" ? "DELETE" : "GET",
        headers,
      });
      expect(response.status).toBe(ending === "DELETE" ? 200 : 404);
      await response.text();
      expect(await readFile(join(http.root, "note.md"), "utf8")).toBe(read.content);
    } finally {
      seam.release();
      controller.abort();
    }
    await pending;
    await agent.c.settle();
    expect(await readFile(join(http.root, "note.md"), "utf8")).toBe(
      read.content + "admitted before session end\n",
    );
    const copies = await backups(http, "note.md");
    expect(copies).toHaveLength(1);
    expect(await readFile(join(http.root, copies[0].path), "utf8")).toBe(read.content);
  },
);
