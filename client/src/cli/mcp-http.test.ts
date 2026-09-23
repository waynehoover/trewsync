import { afterEach, expect, it, vi } from "vitest";
import { chmod, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { httpFixture, legacy, initialize, callStatus } from "./mcp-http-test.ts";
import { cli, tool } from "./mcp-test.ts";
import { deferred, within } from "../core/test-async.ts";
import { MCP_SESSION_IDLE_MS } from "./mcp-http.ts";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";

const fixtures: Awaited<ReturnType<typeof httpFixture>>[] = [];
async function fixture(options: Parameters<typeof httpFixture>[0] = {}) {
  const value = await httpFixture(options);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) {
    await value.close();
    expect(value.errors).toEqual([]);
  }
});

it.each([false, true])(
  "cancels queued old-key reads when rotation is observed, modern=%s",
  async (modern) => {
    const host = await fixture();
    const { client } = await host.client(modern);
    const release = deferred<void>(),
      entered = deferred<void>(),
      queued = deferred<void>();
    const reader = host.session.reader;
    const blocked = reader.run(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const read = reader.read.bind(reader);
    let signal: AbortSignal | undefined;
    vi.spyOn(reader, "read").mockImplementation((input, abort) => {
      signal = abort;
      const result = read(input, abort);
      queued.resolve();
      return result;
    });
    const snapshot = vi.spyOn(reader.vault, "readSnapshot");
    const controller = new AbortController();
    const result = client
      .callTool(
        { name: "read_note", arguments: { path: "note.md" } },
        { signal: controller.signal },
      )
      .catch(() => "cancelled");
    try {
      await within(queued.promise, "queued HTTP read");
      expect((await cli("mcp-token", "--dir", host.root)).code).toBe(0);
      const refused = await host.request(initialize());
      expect(refused.status).toBe(401);
      await refused.text();
      expect(signal?.aborted).toBe(true);
    } finally {
      release.resolve();
      controller.abort();
    }
    await blocked;
    await within(reader.drain(), "cancelled reader queue");
    await result;
    expect(snapshot).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "reads notes through the official HTTP client, modern=%s",
  async (modern) => {
    const host = await fixture();
    const { client } = await host.client(modern);
    expect((await tool(client, "read_note", { path: "note.md" })).content).toBe(
      "private note marker 813751\n",
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("edit_note");
    await expect(
      client.callTool({ name: "create_note", arguments: { path: "forbidden.md", content: "no" } }),
    ).rejects.toThrow();
    await expect(readFile(join(host.root, "forbidden.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(host.logs.join("\n")).not.toContain("private note marker");
    expect(host.logs.join("\n")).not.toContain(host.token);
  },
);

it("requires current authorization on POST, GET and DELETE, even for an existing session", async () => {
  const host = await fixture();
  const headers = await legacy(host);
  for (const method of ["POST", "GET", "DELETE"]) {
    const response = await host.request(method === "POST" ? callStatus(1) : undefined, {
      method,
      headers: { ...headers, authorization: "" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="trew"');
    expect(await response.text()).toBe("unauthorized");
  }
  const rotated = await cli("mcp-token", "--dir", host.root);
  expect(rotated.code).toBe(0);
  const old = await host.request(callStatus(2), { headers });
  expect(old.status).toBe(401);
  await old.text();
  const staleSession = await host.request(callStatus(3), {
    headers: { ...headers, authorization: `Bearer ${rotated.out.trim()}` },
  });
  expect(staleSession.status).toBe(404);
  await staleSession.text();
  const fresh = await host.request(initialize(), {
    headers: { authorization: `Bearer ${rotated.out.trim()}` },
  });
  expect(fresh.status).toBe(200);
  await fresh.text();
  await rm(join(host.root, ".trew/mcp-token.json"));
  const revoked = await host.request(initialize(), {
    headers: { authorization: `Bearer ${rotated.out.trim()}` },
  });
  expect(revoked.status).toBe(401);
  await revoked.text();
});

it.each(["rotate", "revoke"])(
  "retires old sessions when an old-token request observes %s",
  async (action) => {
    const host = await fixture();
    const headers = await legacy(host);
    const controller = new AbortController();
    const stream = await host.request(undefined, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const finished = stream.text().catch(() => "disconnected");
    try {
      const result = await cli(
        "mcp-token",
        "--dir",
        host.root,
        ...(action === "revoke" ? ["--revoke"] : []),
      );
      expect(result.code).toBe(0);
      const refused = await host.request(callStatus(9), { headers });
      expect(refused.status).toBe(401);
      await refused.text();
      await within(finished, "retired old-token stream", 1000);
    } finally {
      controller.abort();
    }
  },
);

it("refuses malformed and missing bearer headers before any tool runs, with fixed pre-authentication replies", async () => {
  let dispatched = 0;
  const host = await fixture({
    status: async () => {
      dispatched++;
      return { private: "must stay private" };
    },
  });
  const headers = await legacy(host);
  const record = JSON.parse(await readFile(join(host.root, ".trew/mcp-token.json"), "utf8"));
  for (const authorization of [
    undefined,
    "Basic wrong",
    "Bearer " + "a".repeat(42),
    "Bearer " + "a".repeat(44),
    "Bearer " + "a".repeat(43),
    "Bearer " + "!".repeat(43),
  ]) {
    const result = await fetch(host.url, {
      method: "POST",
      headers: {
        ...headers,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(callStatus(10)),
    });
    expect(result.status).toBe(401);
    expect(result.headers.get("www-authenticate")).toBe('Bearer realm="trew"');
    const body = await result.text();
    expect(body).toBe("unauthorized");
    const responseHeaders: Record<string, string> = {};
    result.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    const exposed = body + JSON.stringify(responseHeaders);
    for (const secret of [
      host.token,
      record.hash,
      host.root,
      "private-http-vault",
      "sync_status",
      "test",
      "note.md",
    ])
      expect(exposed).not.toContain(secret);
  }
  expect(dispatched).toBe(0);
});

it("an unreadable credential refuses HTTP with 503 before any tool runs", async (context) => {
  if (process.getuid?.() === 0) {
    context.skip("root bypasses the filesystem permission refusal");
    return;
  }
  let dispatched = 0;
  const host = await fixture({ status: async () => ({ dispatched: ++dispatched }) });
  const headers = await legacy(host);
  const path = join(host.root, ".trew/mcp-token.json");
  await chmod(path, 0);
  try {
    await expect(readFile(path)).rejects.toMatchObject({ code: "EACCES" });
    const response = await host.request(callStatus(1), { headers });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unavailable");
    expect(dispatched).toBe(0);
    expect(host.logs.join("\n")).not.toContain(path);
    expect(host.logs.join("\n")).not.toContain(host.token);
  } finally {
    await chmod(path, 0o600);
  }
});

it("logs bounded proxy diagnostics without trusting forwarded identity or recording secrets", async () => {
  const host = await fixture();
  const denied = await host.request(initialize(), {
    headers: {
      authorization: "Bearer wrong",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "https",
      "x-real-ip": "::1",
      host: "trusted.internal",
    },
  });
  expect(denied.status).toBe(401);
  await denied.text();
  expect(host.logs.join("\n")).toContain('"forwardedFor":"127.0.0.1"');
  expect(host.logs.join("\n")).toContain('"forwardedProto":"https"');
  expect(host.logs.join("\n")).toContain('"realIp":"::1"');
  const admitted = await host.request(initialize(), {
    headers: {
      "x-forwarded-for": host.token.repeat(10),
      "x-forwarded-proto": host.token,
      "x-real-ip": host.token,
      host: "rewritten.example",
    },
  });
  expect(admitted.status).toBe(200);
  await admitted.text();
  expect(host.logs.join("\n")).not.toContain(host.token);
  expect(host.logs.join("\n")).toContain('"forwardedFor":"invalid"');
});

it("does not expose the credential or administrative tools over authenticated HTTP", async () => {
  const host = await fixture();
  const { client } = await host.client();
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
  const token = JSON.parse(await readFile(join(host.root, ".trew/mcp-token.json"), "utf8"));
  const read = await tool(client, "read_note", { path: ".trew/mcp-token.json" });
  expect(read.error).toBeDefined();
  const status = await tool(client, "sync_status");
  for (const value of [host.token, token.hash, "private-http-vault", "ws://127.0.0.1:1"])
    expect(JSON.stringify({ read, status })).not.toContain(value);
});

it("checks exact origins before auth and refuses every other route without exposing state", async () => {
  const host = await fixture({ allowOrigins: ["https://trusted.example"] });
  await writeFile(join(host.root, ".trew/mcp-token.json"), "invalid state");
  for (const origin of [
    "null",
    "https://evil.example",
    "https://trusted.example.evil",
    "https://trusted.example/",
  ]) {
    const result = await host.request(initialize(), { headers: { origin } });
    expect(result.status).toBe(403);
    expect(await result.text()).toBe("refused");
  }
  const permitted = await host.request(initialize(), {
    headers: { origin: "https://trusted.example" },
  });
  expect(permitted.status).toBe(503);
  expect(await permitted.text()).toBe("unavailable");
  for (const path of ["/", "/health", "/mcp?key=secret", "/.trew/mcp-token.json"]) {
    const result = await host.request(undefined, { method: "GET", path });
    expect(result.status).toBe(404);
    expect(await result.text()).toBe("");
  }
  const put = await host.request(undefined, { method: "PUT" });
  expect(put.status).toBe(405);
  expect(await put.text()).toBe("");
});

it("keeps eight requests reserved after refusing overflow and routes every result to its original id", async () => {
  const release = deferred<void>();
  let entered = 0;
  const host = await fixture({
    status: async () => {
      entered++;
      await release.promise;
      return { held: true };
    },
  });
  const headers = await legacy(host);
  const calls = Array.from({ length: 8 }, (_, id) =>
    host
      .request(callStatus(id), { headers })
      .then(async (response) => ({ status: response.status, text: await response.text() })),
  );
  try {
    await within(
      (async () => {
        while (entered < 8) await new Promise<void>((resolve) => setImmediate(resolve));
      })(),
      "eight admitted HTTP calls",
    );
    for (const id of [8, 9]) {
      const overflow = await within(
        host.request(callStatus(id), { headers }),
        "overflow refusal",
        1000,
      );
      expect(overflow.status).toBe(429);
      expect(overflow.headers.get("retry-after")).toBe("1");
      await overflow.text();
    }
  } finally {
    release.resolve();
  }
  const results = await Promise.all(calls);
  results.forEach((result, id) => {
    expect(result.status).toBe(200);
    const data = result.text.split("\n").find((line) => line.startsWith("data: "))!;
    expect(JSON.parse(data.slice(6)).id).toBe(id);
    expect(result.text).toContain('"held":true');
  });
});

it("refuses duplicate ids before the SDK can reroute the first response", async () => {
  const release = deferred<void>();
  const entered = deferred<void>();
  let calls = 0;
  const host = await fixture({
    status: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return { first: true };
    },
  });
  const headers = await legacy(host);
  const first = host.request(callStatus("same"), { headers }).then((response) => response.text());
  try {
    await within(entered.promise, "first call");
    const duplicate = await within(
      host.request(callStatus("same"), { headers }),
      "duplicate refusal",
    );
    expect(duplicate.status).toBe(400);
    await duplicate.text();
    expect(calls).toBe(1);
  } finally {
    release.resolve();
  }
  expect(await within(first, "original response")).toContain('"id":"same"');
});

it("caps sessions, expires idle sessions, and keeps existing clients usable after overflow", async () => {
  let now = 1;
  const host = await fixture({ now: () => now });
  const sessions = [];
  for (let i = 0; i < 16; i++) sessions.push(await legacy(host));
  for (let i = 16; i < 20; i++) {
    const overflow = await host.request(initialize());
    expect(overflow.status).toBe(429);
    await overflow.text();
  }
  const existing = await host.request(callStatus(1), { headers: sessions[0]! });
  expect(existing.status).toBe(200);
  await existing.text();
  now += MCP_SESSION_IDLE_MS;
  const expired = await host.request(callStatus(2), { headers: sessions[0]! });
  expect(expired.status).toBe(404);
  await expired.text();
  await legacy(host);
});

it("opens one GET stream promptly, refuses a second, and drains shutdown without waiting for its peer", async () => {
  const host = await fixture();
  const headers = await legacy(host);
  const controller = new AbortController();
  const firstPromise = host.request(undefined, {
    method: "GET",
    headers,
    signal: controller.signal,
  });
  firstPromise.catch(() => {});
  try {
    const first = await within(firstPromise, "GET response headers", 1000);
    expect(first.status).toBe(200);
    const second = await host.request(undefined, { method: "GET", headers });
    expect(second.status).toBe(429);
    await second.text();
    await within(host.server.close(), "HTTP close with open GET");
    await first.body?.cancel();
  } finally {
    controller.abort();
  }
});

it("keeps the process bound at 32 modern requests and releases slots only after work finishes", async () => {
  const release = deferred<void>();
  let entered = 0;
  const host = await fixture({
    status: async () => {
      entered++;
      await release.promise;
      return { finished: true };
    },
  });
  const { client } = await host.client(true);
  const calls = Array.from({ length: 32 }, () => tool(client, "sync_status"));
  try {
    await within(
      (async () => {
        while (entered < 32) await new Promise<void>((resolve) => setImmediate(resolve));
      })(),
      "32 admitted modern calls",
    );
    const extra = await host.request(initialize());
    expect(extra.status).toBe(429);
    await extra.text();
  } finally {
    release.resolve();
  }
  expect((await Promise.all(calls)).every((result) => result.finished === true)).toBe(true);
});

it.each([false, true])(
  "holds shutdown until disconnected work actually finishes, modern=%s",
  async (modern) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const host = await fixture({
      status: async () => {
        entered.resolve();
        await release.promise;
        return { finished: true };
      },
    });
    const { client } = await host.client(modern);
    const controller = new AbortController();
    const call = client.callTool(
      { name: "sync_status", arguments: {} },
      { signal: controller.signal },
    );
    const refused = expect(call).rejects.toThrow();
    await within(entered.promise, "held HTTP callback");
    controller.abort();
    await refused;
    let drained = false;
    const closing = host.server.close().then(() => {
      drained = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
    } finally {
      release.resolve();
    }
    await within(closing, "held callback drain");
  },
);

async function wire(
  host: Awaited<ReturnType<typeof httpFixture>>,
  headers: Record<string, string>,
  body: Buffer,
) {
  return within(
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        host.url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${host.token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk.toString();
          });
          response.once("end", () => resolve({ status: response.statusCode!, body: text }));
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.end(body);
    }),
    "HTTP body refusal",
  );
}

it("caps declared and chunked bytes before parsing and rejects malformed UTF-8", async () => {
  const host = await fixture();
  const declared = await wire(
    host,
    { "content-length": String(8 * 1024 * 1024 + 1) },
    Buffer.from("{"),
  );
  expect(declared).toEqual({ status: 413, body: "refused" });
  const streamed = await wire(
    host,
    { "transfer-encoding": "chunked" },
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
  );
  expect(streamed).toEqual({ status: 413, body: "refused" });
  const malformed = await wire(
    host,
    {},
    Buffer.concat([
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"',
      ),
      Buffer.from([0xff]),
      Buffer.from('","version":"1"}}}'),
    ]),
  );
  expect(malformed).toEqual({ status: 400, body: "refused" });
  const unauthorized = await wire(
    host,
    { authorization: "Bearer invalid" },
    Buffer.from("invalid-json"),
  );
  expect(unauthorized).toEqual({ status: 401, body: "unauthorized" });
  const { client } = await host.client();
  expect((await tool(client, "read_note", { path: "note.md" })).content).toBe(
    "private note marker 813751\n",
  );
});

it("bounds replies even when the peer supplies a multi-megabyte request id", async () => {
  const host = await fixture();
  const response = await host.request(initialize("x".repeat(2 * 1024 * 1024)));
  const body = await response.text();
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024 * 1024 + 8192);
  const headers = await legacy(host);
  const next = await host.request(callStatus(1), { headers });
  expect(next.status).toBe(200);
  await next.text();
});

it("times out unfinished headers near ten seconds without exposing diagnostics", async () => {
  const host = await fixture();
  const socket = connect(Number(new URL(host.url).port), "127.0.0.1");
  let data = "";
  socket.on("data", (chunk) => {
    data += chunk.toString();
  });
  const closed = once(socket, "close");
  const started = Date.now();
  try {
    await once(socket, "connect");
    socket.write("POST /mcp HTTP/1.1\r\nHost: localhost\r\nX-Unfinished: ");
    await within(closed, "header timeout", 13000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9000);
    expect(data).toMatch(/^HTTP\/1.1 (400|408)/);
    expect(data).not.toMatch(/trew|vault|private|test/i);
  } finally {
    socket.destroy();
  }
}, 15000);
