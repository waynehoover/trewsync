import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { once } from "node:events";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import { authenticateMcp, McpCredentialError, readMcpToken } from "./mcp-token.ts";
import {
  MCP_INPUT_BYTES,
  MCP_REPLY_BYTES,
  type ProtocolHandle,
  type TrackedMcpServer,
} from "./mcp-protocol.ts";

export const MCP_HTTP_SESSIONS = 16;
export const MCP_HTTP_REQUESTS = 32;
export const MCP_SESSION_REQUESTS = 8;
export const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
export const MCP_HEADER_TIMEOUT_MS = 10000;

export interface HttpRegistry {
  server: TrackedMcpServer;
  drain(): Promise<void>;
}
type Id = string | number;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Entry = ReturnType<typeof deferred> & { original: Id; internal: number; dispatched: boolean };
interface LegacySession {
  id: string;
  hash: string;
  registry: HttpRegistry;
  raw: WebStandardStreamableHTTPServerTransport;
  original: Map<Id, Entry>;
  internal: Map<number, Entry>;
  nextId: number;
  last: number;
  requests: number;
  get: boolean;
  initialized: boolean;
  initializeAnswered: boolean;
  ending?: Promise<void>;
}
class Refusal extends Error {
  constructor(readonly status: number) {
    super("request refused");
  }
}

export function parseMcpListen(value: string): { host: string; port: number; loopback: boolean } {
  const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(value);
  if (!match) throw new Error("--listen wants an IP address and port, such as 127.0.0.1:3010");
  let host = (match[1] ?? match[2]) || "127.0.0.1";
  if (isIP(host) === 6) host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  const port = Number(match[3]);
  if (host === "0.0.0.0" || host === "::" || host === "::ffff:0:0")
    throw new Error(
      "--listen refuses wildcard addresses; name the interface carrying plaintext notes",
    );
  if (
    (!isIP(host) && host !== "localhost") ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("--listen wants an IP address or localhost and a port from 1 to 65535");
  return {
    host,
    port,
    loopback: host === "localhost" || host === "::1" || host.startsWith("127."),
  };
}

export function mcpOrigin(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value)
    throw new Error("--allow-origin wants an exact HTTP origin, such as https://app.example.com");
  return value;
}

function refuse(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = status;
  response.setHeader("WWW-Authenticate", 'Bearer realm="telimus"');
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (status === 429) response.setHeader("Retry-After", "1");
  response.setHeader("Connection", "close");
  response.end(
    status === 404 || status === 405
      ? ""
      : status === 401
        ? "unauthorized"
        : status === 503
          ? "unavailable"
          : "refused",
  );
}

async function bodyOf(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MCP_INPUT_BYTES))
    throw new Refusal(413);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", error);
      signal.removeEventListener("abort", abort);
    };
    const error = (error: Error) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const abort = () => error(new Refusal(499));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_INPUT_BYTES) {
        error(new Refusal(413));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid envelope");
    return value;
  } catch {
    throw new Refusal(400);
  }
}

function message(value: unknown): { id?: Id; method?: string; params?: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.id === "string" || typeof record.id === "number" ? { id: record.id } : {}),
    ...(typeof record.method === "string" ? { method: record.method } : {}),
    ...(record.params && typeof record.params === "object" && !Array.isArray(record.params)
      ? { params: record.params as Record<string, unknown> }
      : {}),
  };
}

export async function startHttp(
  vault: string,
  factory: () => HttpRegistry,
  options: {
    host: string;
    port: number;
    allowOrigins: readonly string[];
    verbose?: boolean;
    log: (line: string) => void;
    now?: () => number;
  },
  ended: (error?: Error) => void,
): Promise<ProtocolHandle & { port: number }> {
  await readMcpToken(vault);
  const now = options.now ?? Date.now;
  const sessions = new Map<string, LegacySession>();
  const retiring = new Set<Promise<void>>();
  const running = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const authenticated = new Map<AbortController, string>();
  const sockets = new Set<Socket>();
  let stopped = false;
  let total = 0;
  let closeListener: Promise<void> | undefined;

  function endSession(session: LegacySession): Promise<void> {
    if (session.ending) return session.ending;
    sessions.delete(session.id);
    const ending = (async () => {
      await session.registry.server.close();
      // SDK close aborts its signals before a held note transaction finishes.
      // The registry is the evidence that this session no longer owns work.
      await session.registry.drain();
      for (const entry of session.original.values()) entry.resolve();
      session.original.clear();
      session.internal.clear();
    })();
    session.ending = ending;
    retiring.add(ending);
    void ending.then(
      () => retiring.delete(ending),
      (error) => {
        retiring.delete(ending);
        ended(error);
      },
    );
    return ending;
  }
  function expire(): void {
    for (const session of sessions.values())
      if (now() - session.last >= MCP_SESSION_IDLE_MS) void endSession(session);
  }

  async function newSession(hash: string): Promise<LegacySession> {
    if (sessions.size + retiring.size >= MCP_HTTP_SESSIONS) throw new Refusal(429);
    const id = randomBytes(16).toString("hex");
    const registry = factory();
    const raw = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      keepAliveMs: 0,
      onsessionclosed: () => {
        void endSession(session);
      },
    });
    const session: LegacySession = {
      id,
      hash,
      registry,
      raw,
      original: new Map(),
      internal: new Map(),
      nextId: 1,
      requests: 0,
      get: false,
      last: now(),
      initialized: false,
      initializeAnswered: false,
    };
    sessions.set(id, session);
    const transport: Transport = {
      async start() {
        raw.onmessage = (incoming, extra) => {
          let value: JSONRPCMessage = incoming;
          if ("method" in value && "id" in value) {
            const entry = session.original.get(value.id);
            if (entry) {
              entry.dispatched = true;
              value = { ...value, id: entry.internal };
            }
          } else if ("method" in value && value.method === "notifications/cancelled") {
            const original = value.params?.requestId;
            const entry =
              typeof original === "string" || typeof original === "number"
                ? session.original.get(original)
                : undefined;
            if (!entry) return;
            value = { ...value, params: { ...value.params, requestId: entry.internal } };
          }
          transport.onmessage?.(value, extra);
        };
        raw.onclose = () => transport.onclose?.();
        raw.onerror = (error) => transport.onerror?.(error);
        await raw.start();
      },
      async send(value, sendOptions) {
        const entry =
          "id" in value && typeof value.id === "number"
            ? session.internal.get(value.id)
            : undefined;
        const mapped = entry ? { ...value, id: entry.original } : value;
        if (Buffer.byteLength(JSON.stringify(mapped)) > MCP_REPLY_BYTES) {
          void endSession(session);
          throw new Error("MCP output budget exceeded");
        }
        const related = sendOptions?.relatedRequestId;
        const relatedEntry =
          typeof related === "number" ? session.internal.get(related) : undefined;
        await raw.send(
          mapped,
          related === undefined
            ? undefined
            : { relatedRequestId: relatedEntry?.original ?? related },
        );
        entry?.resolve();
        if ("result" in mapped && !session.initializeAnswered) session.initializeAnswered = true;
      },
      close: () => raw.close(),
    };
    registry.server.server.onRequestCompleted = (id, cancelled) => {
      if (typeof id === "number") session.internal.get(id)?.resolve();
      // SDK 2.0 retains a cancelled legacy request mapping until its transport
      // is collected. End the session instead of accumulating abandoned ids.
      if (cancelled) void endSession(session);
    };
    try {
      await registry.server.connect(transport);
    } catch (error) {
      await endSession(session);
      throw error;
    }
    return session;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let session: LegacySession | undefined;
    let entry: Entry | undefined;
    let registry: HttpRegistry | undefined;
    let modern: ReturnType<typeof createMcpHandler> | undefined;
    let reserved = false;
    let sessionReserved = false;
    let isGet = false;
    let tokenId = "";
    let tool = "";
    const started = now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => {
      if (!response.writableFinished) abort();
    };
    const abortSession = () => {
      if (session) void endSession(session);
    };
    controllers.add(controller);
    request.once("aborted", abort);
    response.once("close", closed);
    controller.signal.addEventListener("abort", abortSession);
    try {
      if (stopped) throw new Refusal(503);
      if (request.url !== "/mcp") throw new Refusal(404);
      if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) throw new Refusal(405);
      if (
        request.headers.origin !== undefined &&
        !options.allowOrigins.includes(request.headers.origin)
      )
        throw new Refusal(403);
      if (total >= MCP_HTTP_REQUESTS) throw new Refusal(429);
      total++;
      reserved = true;
      const authorized = await authenticateMcp(vault, request.headers.authorization, (hash) => {
        for (const previous of sessions.values())
          if (previous.hash !== hash) void endSession(previous);
        for (const [previous, credential] of authenticated)
          if (credential !== hash) previous.abort();
      });
      authenticated.set(controller, authorized.hash);
      tokenId = authorized.id;
      expire();
      if (stopped || controller.signal.aborted) throw new Refusal(503);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const web = new Request("http://localhost/mcp", {
        method: request.method!,
        headers,
        signal: controller.signal,
      });
      const body = request.method === "POST" ? await bodyOf(request, controller.signal) : undefined;
      const call = message(body);
      if (
        call.method === "tools/call" &&
        typeof call.params?.name === "string" &&
        /^(?:list_notes|read_note|search_notes|sync_status|edit_note|append_note|create_note|note_history|deleted_notes|restore_note)$/.test(
          call.params.name,
        )
      )
        tool = call.params.name;
      let result: Response;
      if (await isLegacyRequest(web, body)) {
        const id = request.headers["mcp-session-id"];
        if (id !== undefined) {
          session = typeof id === "string" ? sessions.get(id) : undefined;
          if (!session || session.hash !== authorized.hash) throw new Refusal(404);
        } else {
          if (request.method !== "POST" || call.method !== "initialize") throw new Refusal(400);
          session = await newSession(authorized.hash);
        }
        if (session.requests >= MCP_SESSION_REQUESTS) throw new Refusal(429);
        if (request.method === "GET" && session.get) throw new Refusal(429);
        if (call.method?.startsWith("tools/") && !session.initialized) throw new Refusal(400);
        if (call.method === "notifications/initialized" && session.initializeAnswered)
          session.initialized = true;
        if (call.id !== undefined && call.method) {
          // The raw SDK overwrites its stream mapping before onmessage. Reject
          // duplicate original ids here, then remap only toward the Server.
          if (session.original.has(call.id)) throw new Refusal(400);
          entry = {
            ...deferred(),
            original: call.id,
            internal: session.nextId++,
            dispatched: false,
          };
          session.original.set(entry.original, entry);
          session.internal.set(entry.internal, entry);
        }
        session.requests++;
        sessionReserved = true;
        session.last = now();
        isGet = request.method === "GET";
        if (isGet) session.get = true;
        if (controller.signal.aborted) {
          void endSession(session);
          throw new Refusal(499);
        }
        result = await session.raw.handleRequest(web, { parsedBody: body });
        if (entry && !entry.dispatched) entry.resolve();
        if (!session.raw.sessionId) void endSession(session);
      } else {
        modern = createMcpHandler(
          () => {
            registry = factory();
            return registry.server;
          },
          { legacy: "reject", maxSubscriptions: 0 },
        );
        result = await modern.fetch(web, { parsedBody: body });
      }
      if (response.destroyed) {
        await result.body?.cancel();
        return;
      }
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.setHeader("Cache-Control", "no-store");
      if (isGet) response.flushHeaders();
      let bytes = 0;
      const stream = result.body?.getReader();
      try {
        if (stream)
          for (;;) {
            const part = await stream.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (!isGet && bytes > MCP_REPLY_BYTES + 8192) throw new Refusal(503);
            if (!response.write(part.value))
              await once(response, "drain", { signal: controller.signal });
          }
        if (!response.destroyed) {
          response.end();
          if (!response.writableFinished)
            await once(response, "finish", { signal: controller.signal });
        }
      } finally {
        await stream?.cancel().catch(() => {});
      }
    } catch (error) {
      refuse(
        response,
        error instanceof Refusal || error instanceof McpCredentialError ? error.status : 503,
      );
      if (error instanceof McpCredentialError && error.status === 503)
        options.log("MCP credential unavailable");
      if (error instanceof McpCredentialError && error.status === 401)
        options.log("MCP authorization refused");
    } finally {
      if (entry) {
        if (!entry.dispatched) entry.resolve();
        await entry.promise;
        session?.original.delete(entry.original);
        session?.internal.delete(entry.internal);
      }
      await modern?.close();
      await registry?.drain();
      if (session && sessionReserved) {
        session.requests--;
        if (isGet) session.get = false;
      }
      if (reserved) total--;
      if (options.verbose) {
        const forwarded = (name: string, proto = false) => {
          const raw = request.headers[name];
          if (typeof raw !== "string" || raw.length > 256) return raw ? "invalid" : "";
          return proto
            ? ["http", "https"].includes(raw)
              ? raw
              : "invalid"
            : raw.split(",").every((ip) => isIP(ip.trim()))
              ? raw
              : "invalid";
        };
        options.log(
          JSON.stringify({
            method: ["POST", "GET", "DELETE"].includes(request.method ?? "")
              ? request.method
              : "unsupported",
            tool,
            session: session?.id.slice(0, 8) ?? "",
            tokenId,
            remote: request.socket.remoteAddress,
            forwardedFor: forwarded("x-forwarded-for"),
            forwardedProto: forwarded("x-forwarded-proto", true),
            realIp: forwarded("x-real-ip"),
            duration: now() - started,
            outcome: response.statusCode,
          }),
        );
      }
      request.off("aborted", abort);
      response.off("close", closed);
      controller.signal.removeEventListener("abort", abortSession);
      controllers.delete(controller);
      authenticated.delete(controller);
    }
  }
  const server = createServer(
    {
      headersTimeout: MCP_HEADER_TIMEOUT_MS,
      requestTimeout: 30000,
      connectionsCheckingInterval: 1000,
      maxHeaderSize: 8192,
    },
    (request, response) => {
      const work = handle(request, response);
      running.add(work);
      void work.then(
        () => running.delete(work),
        (error) => {
          running.delete(work);
          ended(error);
        },
      );
    },
  );
  server.maxHeadersCount = 64;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", ended);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP listener did not bind a port");
  const timer = setInterval(expire, 60000);
  timer.unref();
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    closeListener = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const controller of controllers) controller.abort();
    for (const session of sessions.values()) void endSession(session);
    server.closeIdleConnections();
  }
  return {
    port: address.port,
    stop,
    async drain() {
      await Promise.all(running);
      await Promise.all(retiring);
    },
    async close() {
      stop();
      await Promise.all(running);
      await Promise.all(retiring);
      for (const socket of sockets) socket.destroy();
      await closeListener;
    },
  };
}
