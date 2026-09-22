import { afterEach, expect, it, vi } from "vitest";
import { Client } from "./client.ts";
import { Transport, type SocketLike } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";
import { deferred, receiveCommitted, within } from "./test-async.ts";

const clients: Client[] = [];
let server: TestServer;
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server?.cleanup();
  vi.restoreAllMocks();
});

it("defers a note that grows beyond the interactive budget after its stat", async () => {
  server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(85);
  const wrapped = await testWrapped(secret);
  const vault = new MemoryVault();
  const started = deferred();
  const serviced = deferred();
  let held = false;
  let grew = false;
  let bodies = 0;
  let sockets = 0;
  const writer = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, wrapped, "writer")),
    vaultId: "default",
    device: "writer",
    inspect: true,
    activePath: () => "note.md",
    coalesceWrites: false,
    socketFactory: (url) => {
      const socket = new WebSocket(url);
      if (++sockets > 1) {
        const buffered = Object.getOwnPropertyDescriptor(
          WebSocket.prototype,
          "bufferedAmount",
        )!.get!;
        Object.defineProperty(socket, "bufferedAmount", {
          get: () => (held && bodies > 0 ? 8 * 1024 * 1024 : buffered.call(socket)),
        });
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          send(data);
          if (typeof data !== "string") {
            bodies++;
            started.resolve();
          }
        };
      }
      return socket as unknown as SocketLike;
    },
  });
  clients.push(writer);
  await writer.connect();
  await vault.edit("note.md", "Original saved paragraph.");
  await writer.engine.sync();
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
  await peer.engine.sync();

  // Observe the exact end of the real cooperative callback, without guessing
  // how long hashing or a rejected upload will take.
  const put = Transport.prototype.put;
  vi.spyOn(Transport.prototype, "put").mockImplementation(function (this: Transport, ...args) {
    const interleave = args[6];
    if (interleave)
      args[6] = async () => {
        await interleave();
        if (grew) serviced.resolve();
      };
    return put.apply(this, args);
  });
  const largeNote = "A newly pasted paragraph.\n".repeat(25_000);
  const stat = vault.stat.bind(vault);
  let growOnStat = false;
  vault.stat = async (path) => {
    const seen = await stat(path);
    if (path === "note.md" && growOnStat) {
      growOnStat = false;
      grew = true;
      await vault.edit(path, largeNote);
      writer.noteChanged(path);
    }
    return seen;
  };
  const attachment = new Uint8Array(3 * 1024 * 1024);
  for (let at = 0; at < attachment.length; at += 65536)
    crypto.getRandomValues(attachment.subarray(at, at + 65536));
  await vault.write("attachment.bin", attachment, { mtime: 1, ctime: 1 });
  held = true;
  const busy = writer.engine.sync();
  try {
    await within(started.promise, "attachment body before note growth");
    growOnStat = true;
    await vault.edit("note.md", "A small edit before its stat.");
    writer.noteChanged("note.md");
    await within(serviced.promise, "interactive callback after note growth");
    expect(await peer.history("note.md")).toHaveLength(1);
    expect(vault.text("note.md")).toBe(largeNote);
    expect(await peer.history("attachment.bin")).toHaveLength(0);
  } finally {
    held = false;
    await busy;
  }
  await receiveCommitted(peer.transport);
  await peer.engine.sync();
  expect(vault.text("note.md")).toBe(largeNote);
  expect(peerVault.text("note.md")).toBe(largeNote);
  expect(Buffer.from(await peerVault.read("attachment.bin")).equals(attachment)).toBe(true);
  expect(await peer.history("note.md")).toHaveLength(2);
});
