import { Transform, type Readable, type Writable } from "node:stream";
import {
  McpServer,
  Server,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type Result,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

export const MCP_INPUT_BYTES = 8 * 1024 * 1024;
export const MCP_REPLY_BYTES = 1024 * 1024;
const OUTPUT_BYTES = 8 * MCP_REPLY_BYTES;

type Handler = (request: JSONRPCRequest, context: ServerContext) => Promise<Result>;
class TrackedServer extends Server {
  onRequestCompleted?: (id: string | number, cancelled: boolean) => void;

  protected override _wrapHandler(method: string, handler: Handler): Handler {
    const checked = super._wrapHandler(method, handler);
    return async (request, context) => {
      try {
        return await checked(request, context);
      } finally {
        // The SDK suppresses cancelled replies. Counting only replies made
        // sixteen completed cancellations permanently exhaust admission.
        this.onRequestCompleted?.(request.id, context.mcpReq.signal.aborted);
      }
    };
  }
}

export class TrackedMcpServer extends McpServer {
  override readonly server: TrackedServer;

  constructor(
    info: ConstructorParameters<typeof McpServer>[0],
    options?: ConstructorParameters<typeof McpServer>[1],
  ) {
    // McpServer has no server factory. Leave its unconnected default instance
    // without tool handlers, then register tools on the tracked public server.
    super(info);
    this.server = new TrackedServer(info, options);
  }
}

/** Validate bytes before the SDK decodes JSON, where invalid UTF-8 would be replaced. */
export function checkedInput(): Transform {
  let bytes = 0;
  let decoder = new TextDecoder("utf-8", { fatal: true });
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        let from = 0;
        while (from < chunk.length) {
          const newline = chunk.indexOf(10, from);
          const to = newline < 0 ? chunk.length : newline + 1;
          const part = chunk.subarray(from, to);
          bytes += part.length;
          if (bytes > MCP_INPUT_BYTES) throw new Error("MCP input exceeds 8 MiB");
          decoder.decode(part, { stream: newline < 0 });
          this.push(part);
          if (newline >= 0) {
            bytes = 0;
            decoder = new TextDecoder("utf-8", { fatal: true });
          }
          from = to;
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      try {
        decoder.decode();
        if (bytes) throw new Error("MCP input ended before the message delimiter");
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

export interface ProtocolHandle {
  stop(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** The SDK owns negotiation and messages; this boundary bounds its queues and bytes. */
export function startStdio(
  factory: (era: "legacy" | "modern") => TrackedMcpServer,
  input: Readable,
  output: Writable,
  ended: (error?: Error) => void,
): ProtocolHandle {
  const checked = checkedInput();
  const raw = new StdioServerTransport(checked, output, { maxBufferSize: MCP_INPUT_BYTES });
  type Request = { original: string | number; internal: number };
  const active = new Map<string | number, Request>();
  const internal = new Map<number, Request>();
  let nextId = 1;
  const incoming: JSONRPCMessage[] = [];
  let scheduled: NodeJS.Immediate | undefined;
  let outgoing: Promise<void> = Promise.resolve();
  let queuedBytes = 0;
  let stopped = false;
  let closed = false;
  let era: "legacy" | "modern" | undefined;
  let initialized = false;
  let initializeId: string | number | undefined;
  let initializeAnswered = false;

  function stop(): void {
    stopped = true;
    input.unpipe(checked);
    input.pause();
    incoming.length = 0;
    if (scheduled) clearImmediate(scheduled);
    scheduled = undefined;
  }
  function fail(error?: Error): void {
    stop();
    ended(error);
  }
  function forward(): void {
    scheduled = undefined;
    const message = incoming.shift();
    if (!message || stopped) return;
    const request = "method" in message && "id" in message;
    if ("method" in message) {
      if (message.method === "notifications/initialized" && initializeAnswered) initialized = true;
      if (request && message.method === "initialize") {
        if (initializeId !== undefined) {
          void refuse(message.id, "already initializing");
          pump();
          return;
        }
        initializeId = message.id;
      }
      if (request && message.method.startsWith("tools/") && era !== "modern" && !initialized) {
        // A modern opening carries its own negotiation envelope. The SDK validates it.
        const claim = message.params?._meta;
        if (era === "legacy" || !claim || !("io.modelcontextprotocol/protocolVersion" in claim)) {
          void refuse(message.id, "initialize the MCP connection first");
          pump();
          return;
        }
      }
    }
    transport.onmessage?.(message);
    pump();
  }
  function pump(): void {
    // serveStdio also has a message queue. Hold our bounded queue while a
    // reply is backpressured, instead of transferring a notification flood
    // into the SDK's unbounded one.
    if (!scheduled && incoming.length && !stopped && queuedBytes === 0)
      scheduled = setImmediate(forward);
  }
  function release(id: string | number): void {
    if (typeof id !== "number") return;
    const entry = internal.get(id);
    if (!entry) return;
    internal.delete(id);
    active.delete(entry.original);
  }
  function refuse(id: string | number, message: string): Promise<void> {
    return transport.send({ jsonrpc: "2.0", id, error: { code: -32000, message } }).catch(fail);
  }
  function send(message: JSONRPCMessage, entry?: Request): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes > MCP_REPLY_BYTES || queuedBytes + bytes > OUTPUT_BYTES) {
      const error = new Error("MCP output budget exceeded");
      fail(error);
      return Promise.reject(error);
    }
    queuedBytes += bytes;
    const sent = outgoing.then(async () => {
      if (closed) throw new Error("MCP transport is closed");
      await raw.send(message);
      if (entry) {
        release(entry.internal);
        if (entry.internal === initializeId && "result" in message) initializeAnswered = true;
      }
    });
    outgoing = sent.catch(fail).finally(() => {
      queuedBytes -= bytes;
      pump();
    });
    return sent;
  }
  const transport: Transport = {
    async start() {
      raw.onmessage = (message) => {
        if (stopped) return;
        if ("method" in message && "id" in message) {
          if (active.has(message.id)) return fail(new Error("duplicate in-flight MCP request id"));
          if (active.size >= 16) {
            void send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "MCP request queue is full" },
            }).catch(fail);
            return;
          }
          while (internal.has(nextId)) nextId = nextId === Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
          const entry = { original: message.id, internal: nextId };
          nextId = nextId === Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
          active.set(entry.original, entry);
          internal.set(entry.internal, entry);
          // SDK 2.0 treats requestId 0 as absent on cancellation. Positive
          // internal ids preserve legal zero and empty-string ids on the wire.
          message = { ...message, id: entry.internal };
        } else if ("method" in message && message.method === "notifications/cancelled") {
          const id = message.params?.requestId;
          const entry =
            typeof id === "string" || typeof id === "number" ? active.get(id) : undefined;
          if (entry)
            message = { ...message, params: { ...message.params, requestId: entry.internal } };
          else return;
        }
        if (incoming.length >= 64) return fail(new Error("MCP message queue is full"));
        incoming.push(message);
        pump();
      };
      raw.onerror = fail;
      checked.on("error", fail);
      input.on("error", fail);
      input.once("end", eof);
      input.once("close", eof);
      await raw.start();
      input.pipe(checked);
    },
    send(message) {
      const entry =
        "id" in message && !("method" in message) && typeof message.id === "number"
          ? internal.get(message.id)
          : undefined;
      return send(entry ? { ...message, id: entry.original } : message, entry);
    },
    async close() {
      if (closed) return;
      closed = true;
      stop();
      input.removeListener("end", eof);
      input.removeListener("close", eof);
      input.removeListener("error", fail);
      await raw.close();
      checked.destroy();
      // A schema error can pause stdin inside its own data callback. After
      // draining, that paused descriptor still keeps the process alive.
      input.destroy();
      transport.onclose?.();
    },
  };
  function eof(): void {
    fail();
  }
  const server = serveStdio(
    (context) => {
      era = context.era;
      const product = factory(context.era);
      product.server.onRequestCompleted = (id, cancelled) => {
        if (cancelled) release(id);
      };
      return product;
    },
    { transport, onerror: fail, maxSubscriptions: 0 },
  );
  return { stop, drain: () => outgoing, close: () => server.close() };
}
