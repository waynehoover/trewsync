import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { saveConfig } from "./config.ts";
import { cli } from "./mcp-test.ts";
import { NodeVault } from "./vault.ts";
import { McpReader } from "./mcp-read.ts";
import { createTools, type McpSession } from "./mcp-tools.ts";
import { startHttp } from "./mcp-http.ts";
import { removeTree } from "../core/test-server.ts";
import { generateDeviceId, generateDeviceToken } from "../core/pairing.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { deferred, within } from "../core/test-async.ts";
import type { Client as SyncClient } from "../core/client.ts";

export async function httpFixture(
  options: {
    status?: () => Promise<object>;
    mode?: McpSession["mode"];
    client?: () => SyncClient | undefined;
    now?: () => number;
    allowOrigins?: string[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "trew-http-"));
  await saveConfig(root, {
    url: "ws://127.0.0.1:1",
    vaultId: "private-http-vault",
    device: "test",
    deviceId: generateDeviceId(),
    deviceToken: generateDeviceToken(),
  });
  await writeFile(join(root, "note.md"), "private note marker 813751\n");
  const issued = await cli("mcp-token", "--dir", root);
  if (issued.code !== 0) throw new Error(issued.err);
  const token = issued.out.trim();
  const writer = new NodeVault(root);
  const reader = new McpReader(new NodeVault(root, { observeOnly: true }));
  const session: McpSession = {
    mode: options.mode ?? "read-only",
    reader,
    writer,
    device: "laptop",
    client: options.client ?? (() => undefined),
    stopping: () => false,
    changed() {},
    summary: () => ({ connection: "offline" }),
    status: options.status ?? (async () => ({ connection: "offline", readOnly: true })),
  };
  const logs: string[] = [];
  const errors: Error[] = [];
  const server = await startHttp(
    root,
    () => createTools(session, "test"),
    {
      host: "127.0.0.1",
      port: 0,
      allowOrigins: options.allowOrigins ?? [],
      verbose: true,
      log: (line) => logs.push(line),
      ...(options.now ? { now: options.now } : {}),
    },
    (error) => {
      if (error) errors.push(error);
    },
  );
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const clients: Client[] = [];
  return {
    root,
    token,
    url,
    server,
    session,
    logs,
    errors,
    async client(modern = false, key = token, at = url) {
      const transport = new StreamableHTTPClientTransport(new URL(at), {
        authProvider: { token: async () => key },
      });
      const client = new Client(
        { name: "trew-http-test", version: "1" },
        {
          versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
        },
      );
      clients.push(client);
      await client.connect(transport);
      return { client, transport };
    },
    async request(
      body?: object,
      options: {
        method?: string;
        headers?: Record<string, string>;
        path?: string;
        signal?: AbortSignal;
      } = {},
    ) {
      return fetch(options.path ? new URL(options.path, url) : url, {
        method: options.method ?? "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await server.close();
      await reader.drain();
      await removeTree(root);
    },
  };
}

export const initialize = (id: string | number = 0) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw", version: "1" },
  },
});
export const callStatus = (id: string | number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "sync_status", arguments: {} },
});
export async function legacy(fixture: Awaited<ReturnType<typeof httpFixture>>) {
  const response = await fixture.request(initialize());
  const body = await response.text();
  const id = response.headers.get("mcp-session-id");
  if (response.status !== 200 || !id) throw new Error(`initialize ${response.status}: ${body}`);
  const headers = { "mcp-session-id": id, "mcp-protocol-version": "2025-11-25" };
  const initialized = await fixture.request(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { headers },
  );
  await initialized.text();
  if (initialized.status !== 202) throw new Error(`initialized: ${initialized.status}`);
  return headers;
}

export async function unusedHttpPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

export async function openHttp(
  bundle: string,
  root: string,
  token: string,
  flags: string[] = [],
  modern = false,
  launch: { runtime?: string; denyRead?: string; host?: string; bare?: boolean } = {},
) {
  const port = await unusedHttpPort();
  const hostname = launch.host ?? "127.0.0.1";
  const listen = `${launch.bare ? "" : hostname}:${port}`;
  let command = launch.runtime ?? process.execPath;
  let argv = [
    bundle,
    "mcp",
    ...(flags.includes("--vault") ? [] : ["--dir", root]),
    "--listen",
    listen,
    ...flags,
  ];
  if (launch.denyRead && process.platform === "darwin") {
    const profile = join(root, ".trew/mcp-test.sb");
    await writeFile(
      profile,
      `(version 1)\n(allow default)\n(deny file-read* (subpath ${JSON.stringify(launch.denyRead)}))\n`,
    );
    argv = ["-f", profile, command, ...argv];
    command = "/usr/bin/sandbox-exec";
  }
  const started = performance.now();
  const child = spawn(command, argv, {
    cwd: root,
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close");
  const listening = deferred<void>();
  const messages: unknown[] = [];
  const clients: Client[] = [];
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.includes("HTTP listening on")) listening.resolve();
  });
  child.on("message", (message) => messages.push(message));
  child.stdin!.end();
  const event = (kind: string, name: string) =>
    within(
      (async () => {
        while (
          !messages.some(
            (value) =>
              value &&
              typeof value === "object" &&
              (value as Record<string, unknown>)[kind] === name,
          )
        )
          await new Promise<void>((resolve) => setImmediate(resolve));
      })(),
      `${kind}: ${name}`,
    );
  const url = `http://${hostname}:${port}/mcp`;
  async function connect(modern = false, key = token, at = url) {
    const transport = new StreamableHTTPClientTransport(new URL(at), {
      authProvider: { token: async () => key },
    });
    const client = new Client(
      { name: "trew-child-http-test", version: "1" },
      {
        versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
      },
    );
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  }
  async function close() {
    const clientsClosed = await Promise.allSettled(clients.map((client) => client.close()));
    // A shutdown test may already have sent SIGTERM. Sending it again raced
    // the child's removal of its handler and turned a clean drain into a kill.
    if (!child.killed && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    try {
      const [code, signal] = await within(closed, "HTTP child shutdown", 15000);
      const failed = clientsClosed.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      return { code, signal, stdout, stderr };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }
  try {
    await within(
      Promise.race([
        listening.promise,
        closed.then(() => {
          throw new Error(`HTTP startup failed: ${stderr}`);
        }),
      ]),
      "HTTP listener startup",
      15000,
    );
    const connected = await connect(modern);
    return {
      ...connected,
      initializationMs: Math.round((performance.now() - started) * 10) / 10,
      connect,
      child,
      messages,
      url,
      close,
      exited: async () => {
        const [code, signal] = await within(closed, "HTTP child exit", 15000);
        return { code, signal };
      },
      stdout: () => stdout,
      stderr: () => stderr,
      async hold(name: string) {
        child.send({ hold: name });
        await event("armed", name);
      },
      reached: (name: string) => event("reached", name),
      release: () => {
        if (child.connected) child.send({ release: true });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
