import { expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { z } from "zod";
import { deferred, within } from "../core/test-async.ts";
import { startStdio, TrackedMcpServer, MCP_INPUT_BYTES } from "./mcp-protocol.ts";

function harness(factory: () => TrackedMcpServer, sink?: Writable) {
  const input = new PassThrough();
  const output = sink ?? new PassThrough();
  const replies = new Map<string | number, any>();
  const waits = new Map<string | number, (reply: any) => void>();
  const failures: unknown[] = [];
  const ended = deferred<void>();
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      replies.set(msg.id, msg);
      waits.get(msg.id)?.(msg);
    }
  });
  const protocol = startStdio(factory, input, output, (error) => {
    failures.push(error);
    ended.resolve();
  });
  const send = (value: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const reply = (id: number | string): Promise<any> =>
    replies.has(id)
      ? Promise.resolve(replies.get(id))
      : within(new Promise((yes) => waits.set(id, yes)), `MCP reply ${id}`, 5000);
  const initialize = async () => {
    send({
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      },
    });
    await reply("init");
    send({ method: "notifications/initialized" });
  };
  return { send, reply, initialize, protocol, failures, input, output, ended, replies };
}
function server() {
  return new TrackedMcpServer({ name: "test", version: "1" });
}
const completed = () => ({ content: [{ type: "text" as const, text: "done" }] });

it("reclaims admission after cancelled handlers actually finish", async () => {
  let entered = deferred<void>();
  let aborted = deferred<void>();
  const h = harness(() => {
    const s = server();
    s.registerTool("hold", { inputSchema: z.object({}) }, async (_, ctx) => {
      entered.resolve();
      await new Promise<void>((yes) =>
        ctx.mcpReq.signal.addEventListener("abort", () => yes(), { once: true }),
      );
      aborted.resolve();
      return completed();
    });
    return s;
  });
  try {
    await h.initialize();
    for (let id = 1; id <= 16; id++) {
      h.send({ id, method: "tools/call", params: { name: "hold", arguments: {} } });
      await entered.promise;
      h.send({ method: "notifications/cancelled", params: { requestId: id } });
      await aborted.promise;
      entered = deferred();
      aborted = deferred();
    }
    h.send({ id: 99, method: "tools/list", params: {} });
    const next = await h.reply(99);
    expect(next.error).toBeUndefined();
    expect(next.result.tools[0].name).toBe("hold");
  } finally {
    await h.protocol.close();
  }
});

it("keeps admission for cancelled transactions until filesystem work finishes", async () => {
  const finish = deferred<void>();
  const finished = deferred<void>();
  let entered = deferred<void>();
  let aborted = deferred<void>();
  let tracked!: TrackedMcpServer;
  const h = harness(() => {
    const s = server();
    tracked = s;
    s.registerTool("transaction", { inputSchema: z.object({}) }, async (_, context) => {
      const cancelled = aborted;
      context.mcpReq.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      entered.resolve();
      await finish.promise;
      return completed();
    });
    return s;
  });
  try {
    await h.initialize();
    const completed = tracked.server.onRequestCompleted;
    let count = 0;
    tracked.server.onRequestCompleted = (id, cancelled) => {
      completed?.(id, cancelled);
      if (cancelled && ++count === 16) finished.resolve();
    };
    for (let id = 1; id <= 16; id++) {
      h.send({ id, method: "tools/call", params: { name: "transaction", arguments: {} } });
      await entered.promise;
      entered = deferred();
      h.send({ method: "notifications/cancelled", params: { requestId: id } });
      await aborted.promise;
      aborted = deferred();
    }
    h.send({ id: "full", method: "ping" });
    expect((await h.reply("full")).error.message).toContain("queue is full");
    finish.resolve();
    await finished.promise;
    h.send({ id: "available", method: "ping" });
    expect((await h.reply("available")).error).toBeUndefined();
  } finally {
    finish.resolve();
    await h.protocol.close();
  }
});

it("does not treat a version claim on a legacy connection as initialized", async () => {
  let calls = 0;
  const h = harness(() => {
    const s = server();
    s.registerTool("mark", { inputSchema: z.object({}) }, async () => {
      calls++;
      return completed();
    });
    return s;
  });
  try {
    h.send({
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      },
    });
    await h.reply(0);
    h.send({
      id: 1,
      method: "tools/call",
      params: {
        name: "mark",
        arguments: {},
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    });
    const next = await h.reply(1);
    expect(calls).toBe(0);
    expect(next.error).toBeDefined();
  } finally {
    await h.protocol.close();
  }
});

it.each([0, "", "0"])(
  "cancels legal request id %j without confusing numeric and string ids",
  async (id) => {
    const entered = deferred<void>();
    const cancelled = deferred<void>();
    const h = harness(() => {
      const s = server();
      s.registerTool("hold", { inputSchema: z.object({}) }, async (_, ctx) => {
        entered.resolve();
        ctx.mcpReq.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
        await cancelled.promise;
        return completed();
      });
      return s;
    });
    try {
      await h.initialize();
      h.send({ id, method: "tools/call", params: { name: "hold", arguments: {} } });
      await entered.promise;
      h.send({ method: "notifications/cancelled", params: { requestId: id } });
      h.send({ id: 2, method: "ping" });
      await h.reply(2);
      let observed = false;
      void cancelled.promise.then(() => (observed = true));
      await new Promise<void>((yes) => setImmediate(yes));
      expect(observed).toBe(true);
      expect(h.replies.has(id)).toBe(false);
    } finally {
      cancelled.resolve();
      await h.protocol.close();
    }
  },
);

it("reclaims cancelled invalid-schema calls even when no tool handler ran", async () => {
  let entered = deferred<void>();
  let validate = deferred<void>();
  let calls = 0;
  const h = harness(() => {
    const s = server();
    s.registerTool(
      "validated",
      {
        inputSchema: z.object({
          value: z.string().refine(async () => {
            entered.resolve();
            await validate.promise;
            return false;
          }),
        }),
      },
      async () => {
        calls++;
        return completed();
      },
    );
    return s;
  });
  try {
    await h.initialize();
    for (let id = 1; id <= 16; id++) {
      h.send({
        id,
        method: "tools/call",
        params: { name: "validated", arguments: { value: "wrong" } },
      });
      await entered.promise;
      h.send({ method: "notifications/cancelled", params: { requestId: id } });
      h.send({ id: `barrier-${id}`, method: "ping" });
      await h.reply(`barrier-${id}`);
      validate.resolve();
      entered = deferred();
      validate = deferred();
    }
    h.send({ id: "last", method: "tools/list" });
    expect((await h.reply("last")).error).toBeUndefined();
    expect(calls).toBe(0);
  } finally {
    validate.resolve();
    await h.protocol.close();
  }
});

it("preserves original response ids and refuses duplicate active ids", async () => {
  const finish = deferred<void>();
  const entered = deferred<void>();
  const h = harness(() => {
    const s = server();
    s.registerTool("hold", { inputSchema: z.object({}) }, async () => {
      entered.resolve();
      await finish.promise;
      return completed();
    });
    return s;
  });
  try {
    await h.initialize();
    h.send({ id: 0, method: "ping" });
    h.send({ id: "0", method: "ping" });
    expect((await h.reply(0)).id).toBe(0);
    expect((await h.reply("0")).id).toBe("0");
    h.send({ id: "duplicate", method: "tools/call", params: { name: "hold", arguments: {} } });
    await entered.promise;
    h.send({ id: "duplicate", method: "ping" });
    await h.ended.promise;
    expect(String(h.failures[0])).toContain("duplicate in-flight");
  } finally {
    finish.resolve();
    await h.protocol.close();
  }
});

it("validates fragmented UTF-8 and rejects oversized unterminated input before dispatch", async () => {
  const h = harness(server);
  try {
    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: "é", method: "ping", params: {} }) + "\n",
    );
    const split = bytes.indexOf(0xc3) + 1;
    h.input.write(bytes.subarray(0, split));
    h.input.write(bytes.subarray(split));
    expect((await h.reply("é")).id).toBe("é");
    h.input.write(Buffer.alloc(MCP_INPUT_BYTES + 1, 32));
    await h.ended.promise;
    expect(String(h.failures[0])).toContain("exceeds 8 MiB");
  } finally {
    await h.protocol.close();
  }
});

it("reports EPIPE and drains queued output without admitting another request", async () => {
  const writing = deferred<void>();
  let release!: (error?: Error) => void;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      release = callback;
      writing.resolve();
    },
  });
  const h = harness(server, output);
  try {
    h.send({ id: 1, method: "ping" });
    await writing.promise;
    h.send({ id: 2, method: "ping" });
    release(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await h.ended.promise;
    await h.protocol.drain();
    expect(String(h.failures[0])).toContain("broken pipe");
  } finally {
    await h.protocol.close();
  }
});

it("holds its bounded input queue while stdout is backpressured", async () => {
  const writing = deferred<void>();
  let release!: (error?: Error) => void;
  let notifications = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      release = callback;
      writing.resolve();
    },
  });
  const h = harness(() => {
    const s = server();
    s.server.setNotificationHandler("notifications/roots/list_changed", () => {
      notifications++;
    });
    return s;
  }, output);
  try {
    h.send({ id: 1, method: "ping" });
    await writing.promise;
    h.send({ method: "notifications/roots/list_changed" });
    await new Promise<void>((yes) => setImmediate(yes));
    expect(notifications).toBe(0);
    release();
    await h.protocol.drain();
    await new Promise<void>((yes) => setImmediate(yes));
    expect(notifications).toBe(1);
  } finally {
    await h.protocol.close();
  }
});
