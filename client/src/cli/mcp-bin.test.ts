import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestServer, removeTree } from "../core/test-server.ts";
import { deferred, within } from "../core/test-async.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { buildMcp, cli } from "./mcp-test.ts";
import { mcpProcess } from "./mcp-process-test.ts";

let buildDir: string, bundle: string, recoveryKey: string, server: TestServer | undefined;
const roots: string[] = [];
const processes: ReturnType<typeof mcpProcess>[] = [];
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "telimus-mcp-process-build-"));
  bundle = await buildMcp(buildDir, "./mcp-fault-child.ts");
});
afterAll(async () => removeTree(buildDir));
afterEach(async () => {
  for (const child of processes.splice(0)) await child.dispose();
  await server?.cleanup();
  server = undefined;
  for (const dir of roots.splice(0)) await removeTree(dir);
});
async function paired() {
  server = new TestServer();
  await server.start();
  const dir = await mkdtemp(join(tmpdir(), "telimus-mcp-process-"));
  roots.push(dir);
  const result = await cli("init", server.setup, "--dir", dir, "--json");
  expect(result.code, result.err).toBe(0);
  recoveryKey = JSON.parse(result.out).recoveryKey;
  return dir;
}
function start(dir: string, flags: string[] = []) {
  const child = mcpProcess(bundle, dir, flags);
  processes.push(child);
  return child;
}
async function command(...args: string[]) {
  const child = spawn(process.execPath, [bundle, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let out = "",
    err = "";
  child.stdout.on("data", (b: Buffer) => {
    out += b.toString();
  });
  child.stderr.on("data", (b: Buffer) => {
    err += b.toString();
  });
  try {
    const [code, signal] = await within(closed, "CLI command exit", 15000);
    return { code, signal, out, err };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

it.each(["EOF", "SIGTERM", "EPIPE"])(
  "%s drains an admitted edit before another process can take the vault",
  async (ending) => {
    const dir = await paired();
    await writeFile(join(dir, "note.md"), "preexisting unsent branch\n");
    const owner = start(dir);
    await owner.initialize();
    await owner.ready();
    const read = await owner.tool("read_note", { path: "note.md" });
    await owner.hold("cli/mcp:backupDurable");
    owner.send({
      id: "edit",
      method: "tools/call",
      params: {
        name: "append_note",
        arguments: { path: "note.md", base: read.base, text: "accepted new branch\n" },
      },
    });
    await owner.reached("cli/mcp:backupDurable");
    if (ending === "EOF") owner.child.stdin.end();
    else if (ending === "SIGTERM") owner.child.kill("SIGTERM");
    else {
      owner.child.stdout.destroy();
      owner.send({ id: "broken-output", method: "ping" });
    }
    const contender = await command("sync", "--dir", dir);
    expect(contender.code).not.toBe(0);
    expect(contender.err).toMatch(/lock|held|running|another/i);
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();
    owner.release();
    const ended = await owner.exited();
    expect(ended.signal).toBeNull();
    expect(ended.code).toBe(ending === "EPIPE" ? 1 : 0);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe(
      "preexisting unsent branch\naccepted new branch\n",
    );
    const next = start(dir);
    await next.initialize();
    await next.ready();
    const listing = await next.tool("list_notes", { includeBackups: true });
    const backup = listing.entries.find((entry: any) => entry.backupOf === "note.md");
    expect(backup).toBeDefined();
    expect((await next.tool("read_note", { path: backup.path })).content).toBe(read.content);
    expect(
      (
        await next.tool("append_note", {
          path: "note.md",
          base: read.base,
          text: "accepted new branch\n",
        })
      ).error.code,
    ).toBe("stale");
    expect(owner.errors).toEqual([]);
    next.child.stdin.end();
    expect((await next.exited()).code).toBe(0);
  },
);

it.each(["EOF", "SIGTERM"])(
  "%s closes a stalled handshake and wakes reconnect sleep",
  async (ending) => {
    const dir = await paired();
    const accepted = deferred<void>();
    const sockets = new Set<Socket>();
    const blocked = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      accepted.resolve();
    });
    await new Promise<void>((resolve) => blocked.listen(0, "127.0.0.1", resolve));
    const address = blocked.address();
    if (!address || typeof address === "string") throw new Error("no listen port");
    const config = (await loadConfig(dir))!;
    await saveConfig(dir, { ...config, url: `ws://127.0.0.1:${address.port}` });
    try {
      const held = start(dir);
      await held.initialize();
      await within(accepted.promise, "stalled handshake");
      if (ending === "EOF") held.child.stdin.end();
      else held.child.kill("SIGTERM");
      expect(await held.exited()).toEqual({ code: 0, signal: null });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => blocked.close(() => resolve()));
      const offline = start(dir);
      await offline.initialize();
      await within(
        (async () => {
          while ((await offline.tool("sync_status")).connection !== "offline")
            await new Promise<void>((resolve) => setImmediate(resolve));
        })(),
        "reconnect sleep",
      );
      if (ending === "EOF") offline.child.stdin.end();
      else offline.child.kill("SIGTERM");
      expect(await offline.exited()).toEqual({ code: 0, signal: null });
    } finally {
      for (const socket of sockets) socket.destroy();
      if (blocked.listening) await new Promise<void>((resolve) => blocked.close(() => resolve()));
    }
  },
);

it("MCP and sync watch exclude each other through root aliases and release after a kernel kill", async () => {
  const dir = await paired();
  const alias = dir + "-alias";
  roots.push(alias);
  await symlink(dir, alias);
  const owner = start(dir);
  await owner.initialize();
  await owner.ready();
  const refused = await command("sync", "--watch", "--dir", alias);
  expect(refused.code).not.toBe(0);
  expect(refused.err).toMatch(/lock|held|running|another/i);
  owner.child.kill("SIGKILL");
  expect((await owner.exited()).signal).toBe("SIGKILL");
  const watcher = spawn(process.execPath, [bundle, "sync", "--watch", "--dir", alias], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(watcher, "close");
  const started = deferred<void>();
  watcher.stdout.on("data", () => started.resolve());
  watcher.stderr.on("data", () => started.resolve());
  try {
    await within(started.promise, "sync watcher startup");
    const denied = start(dir);
    expect((await denied.exited()).code).not.toBe(0);
    expect(denied.stderr()).toMatch(/lock|held|running|another/i);
  } finally {
    watcher.kill("SIGTERM");
    await within(closed, "watcher shutdown");
  }
  const final = start(dir);
  await final.initialize();
  final.child.stdin.end();
  expect((await final.exited()).code).toBe(0);
});

it.each(["--json", "--watch", "--verify"])(
  "rejects %s without putting human diagnostics on stdout",
  async (flag) => {
    const dir = await paired();
    const result = await command("mcp", "--dir", dir, flag);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
  },
);

it.each(["{broken\n", "[]\n", '{"jsonrpc":"2.0","method":7}\n'])(
  "rejects malformed input without dispatch or non-protocol stdout: %j",
  async (input) => {
    const dir = await paired();
    const child = start(dir, ["--verbose"]);
    await child.initialize();
    await child.ready();
    child.child.stdin.write(input);
    if (input === "{broken\n") {
      // SDK 2.0 discards malformed JSON; a valid envelope with invalid
      // fields instead raises a transport error and shuts down.
      expect((await child.request("ping")).error).toBeUndefined();
      child.child.stdin.end();
      expect((await child.exited()).code).toBe(0);
    } else expect((await child.exited()).code).toBe(1);
    expect(child.errors).toEqual([]);
  },
);

it.each(["EOF", "SIGTERM"])(
  "%s drains an incoming sync replacement before releasing the lock",
  async (ending) => {
    const dir = await paired();
    await writeFile(join(dir, "note.md"), "original remote ancestor\n");
    const owner = start(dir);
    await owner.initialize();
    await owner.ready();
    const phone = await mkdtemp(join(tmpdir(), "telimus-mcp-incoming-"));
    roots.push(phone);
    expect((await cli("pair", recoveryKey, "--dir", phone)).code).toBe(0);
    expect((await cli("sync", "--dir", phone)).code).toBe(0);
    await owner.hold("cli/vault:replace.staged");
    await writeFile(join(phone, "note.md"), "INDEPENDENT REMOTE COMMIT\n");
    expect((await cli("sync", "--dir", phone)).code).toBe(0);
    await owner.reached("cli/vault:replace.staged");
    if (ending === "EOF") owner.child.stdin.end();
    else owner.child.kill("SIGTERM");
    expect((await command("sync", "--dir", dir)).code).not.toBe(0);
    owner.release();
    expect(await owner.exited()).toEqual({ code: 0, signal: null });
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("INDEPENDENT REMOTE COMMIT\n");
    expect((await command("sync", "--dir", dir)).code).toBe(0);
  },
);

it("a real backpressured stdout resumes bounded read replies without losing protocol framing", async () => {
  const dir = await paired();
  await writeFile(join(dir, "large.md"), "note content with an emoji 😃\n".repeat(10000));
  const child = start(dir);
  await child.initialize();
  await child.ready();
  child.child.stdout.pause();
  const requests = Array.from({ length: 4 }, () =>
    child.request("tools/call", {
      name: "read_note",
      arguments: { path: "large.md", maxLines: 1000 },
    }),
  );
  const completed = Promise.all(requests);
  void completed.catch(() => undefined);
  try {
    await within(once(child.child.stdout, "readable"), "backpressured read output");
    child.child.stdout.resume();
    for (const reply of await completed) {
      expect(reply.result.structuredContent.content).toBe(
        "note content with an emoji 😃\n".repeat(1000),
      );
      expect(reply.result.structuredContent.nextLine).toBe(1001);
    }
    expect(child.errors).toEqual([]);
    child.child.stdin.end();
    expect((await child.exited()).code).toBe(0);
  } finally {
    child.child.stdout.resume();
  }
});
