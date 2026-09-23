import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deferred, within } from "../core/test-async.ts";
import { StringDecoder } from "node:string_decoder";

/** A fresh process, with every protocol byte retained for diagnostic assertions. */
export function mcpProcess(bundle: string, dir: string, flags: string[] = []) {
  const child = spawn(process.execPath, [bundle, "mcp", "--dir", dir, ...flags], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  }) as ChildProcessWithoutNullStreams;
  const responses = new Map<string | number | null, any>();
  const pending = new Map<string | number, ReturnType<typeof deferred<any>>>();
  const events = new Map<string, ReturnType<typeof deferred<any>>>();
  const exit = deferred<{ code: number | null; signal: string | null }>();
  const errors: string[] = [];
  let stdout = "",
    stderr = "",
    buffered = "",
    next = 1;
  const decoder = new StringDecoder("utf8");
  child.on("error", (error) => errors.push(String(error)));
  child.stdin.on("error", (error) => errors.push(String(error)));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    stdout += text;
    buffered += text;
    let at: number;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      try {
        const response = JSON.parse(line);
        responses.set(response.id, response);
        pending.get(response.id)?.resolve(response);
      } catch {
        errors.push(`Non-protocol stdout: ${line}`);
      }
    }
  });
  child.on("message", (message: any) => {
    for (const kind of ["armed", "reached"])
      if (message[kind]) event(`${kind}:${message[kind]}`).resolve(message);
  });
  child.on("close", (code, signal) => exit.resolve({ code, signal }));
  function event(name: string) {
    if (!events.has(name)) events.set(name, deferred<any>());
    return events.get(name)!;
  }
  function send(message: object) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }
  async function request(method: string, params?: object, id: string | number = next++) {
    const response = deferred<any>();
    pending.set(id, response);
    send({ id, method, ...(params ? { params } : {}) });
    try {
      return await within(response.promise, `${method} response (${stderr})`, 15000);
    } finally {
      pending.delete(id);
    }
  }
  async function tool(name: string, args: object = {}) {
    const response = await request("tools/call", { name, arguments: args });
    if (!response.result?.structuredContent) throw new Error(JSON.stringify(response));
    return response.result.structuredContent;
  }
  return {
    child,
    send,
    request,
    tool,
    responses,
    errors,
    stdout: () => stdout,
    stderr: () => stderr,
    async initialize() {
      const response = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "process-probe", version: "1" },
      });
      if (response.error) throw new Error(JSON.stringify(response));
      send({ method: "notifications/initialized" });
    },
    async ready() {
      await within(
        (async () => {
          for (;;) {
            const status = await tool("sync_status");
            if (status.writeReady) return;
            if (status.connection === "fatal") throw new Error(JSON.stringify(status));
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })(),
        "MCP write readiness",
        15000,
      );
    },
    async hold(name: string) {
      child.send({ hold: name });
      await within(event(`armed:${name}`).promise, `arm ${name}`);
    },
    reached: (name: string) => within(event(`reached:${name}`).promise, `reach ${name}`),
    release: () => child.send({ release: true }),
    exited: () =>
      within(exit.promise, "process exit", 15000).catch((error) => {
        throw new Error(`${String(error)}\n${stderr}\n${stdout}`);
      }),
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await within(exit.promise, "test child cleanup", 15000);
    },
  };
}
