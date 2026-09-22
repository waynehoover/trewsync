import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import type { SocketLike } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";
import { receiveCommitted } from "./test-async.ts";

const clients: Client[] = [];
let server: TestServer;
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server?.cleanup();
});

it("covers delayed main updates before checkpointing an auxiliary upload", async () => {
  server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(84);
  const wrapped = await testWrapped(secret);
  const vault = new MemoryVault();
  const store = new MemoryIndexStore();
  const sockets: WebSocket[] = [];
  const checkpoints: { cursor: number; acknowledged: number }[] = [];
  let acknowledged = 0;
  const writer = new Client({
    vault,
    store,
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, wrapped, "writer")),
    vaultId: "default",
    device: "writer",
    inspect: true,
    activePath: () => "note.md",
    coalesceWrites: false,
    onActivity: (event) => {
      if (event.action === "uploaded")
        checkpoints.push({ cursor: writer.engine.status().cursor, acknowledged });
    },
    socketFactory: (url) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      if (sockets.length > 1) {
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const frame = JSON.parse(event.data) as { res?: string; uid?: number };
          if (frame.res === "ack" || frame.res === "have") acknowledged = frame.uid!;
        });
      }
      return socket as unknown as SocketLike;
    },
  });
  clients.push(writer);
  await writer.connect();

  // Hold the main stream until a new ping makes an ordering barrier. The
  // auxiliary ACK may arrive first; no checkpoint may get ahead of this stream.
  const main = sockets[0]!;
  const receive = main.onmessage!;
  const held: MessageEvent[] = [];
  let holding = true;
  const release = () => {
    holding = false;
    for (const event of held.splice(0)) receive.call(main, event);
  };
  main.onmessage = (event) => {
    if (holding) held.push(event);
    else receive.call(main, event);
  };
  const send = main.send.bind(main);
  main.send = (data) => {
    if (typeof data === "string" && JSON.parse(data).op === "ping") release();
    send(data);
  };

  const body = new Uint8Array(3 * 1024 * 1024);
  for (let at = 0; at < body.length; at += 65536)
    crypto.getRandomValues(body.subarray(at, at + 65536));
  await vault.write("attachment.bin", body, { mtime: 1, ctime: 1 });
  try {
    const report = await writer.engine.sync();
    expect(report.uploaded).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(acknowledged).toBeGreaterThan(0);
    expect(checkpoints).toEqual([{ cursor: acknowledged, acknowledged }]);
    expect((await store.load())?.cursor).toBe(acknowledged);
    expect(Buffer.from(await vault.read("attachment.bin")).equals(body)).toBe(true);
  } finally {
    release();
  }

  const peerVault = new MemoryVault();
  const peer = new Client({
    vault: peerVault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, wrapped, "peer")),
    vaultId: "default",
    device: "peer",
    inspect: true,
  });
  clients.push(peer);
  await peer.connect();
  await receiveCommitted(peer.transport);
  await peer.engine.sync();
  expect(Buffer.from(await peerVault.read("attachment.bin")).equals(body)).toBe(true);
  expect(await peer.history("attachment.bin")).toHaveLength(1);
});
