import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import type { SocketLike } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";
import { deferred, receiveCommitted, within } from "./test-async.ts";

const clients: Client[] = [];
let server: TestServer;
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await server?.cleanup();
});

async function pair() {
  server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(83),
    wrapped = await testWrapped(secret);
  const vault = new MemoryVault(),
    peerVault = new MemoryVault();
  const sockets: WebSocket[] = [];
  let bodyStarted = deferred();
  const uploads: string[] = [];
  const noteUploaded = new Set<() => void>();
  let held = true,
    bodies = 0;
  let bulkSocket: WebSocket | undefined;
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
    onActivity: (event) => {
      if (event.action !== "uploaded") return;
      uploads.push(event.path!);
      if (event.path === "note.md") for (const resolve of noteUploaded) resolve();
    },
    socketFactory: (url) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      // Gate after the first body on either implementation's upload wire.
      // The actual server receives it, and later bodies stay unsent. This
      // tests an in-flight transfer rather than a file not yet prepared.
      const nativeBuffered = Object.getOwnPropertyDescriptor(
        WebSocket.prototype,
        "bufferedAmount",
      )!.get!;
      const send = socket.send.bind(socket);
      Object.defineProperty(socket, "bufferedAmount", {
        get: () =>
          held && bodies > 0 && socket === bulkSocket
            ? 8 * 1024 * 1024
            : nativeBuffered.call(socket),
      });
      socket.send = (data) => {
        if (typeof data === "string" && JSON.parse(data).op === "put") bulkSocket = socket;
        send(data);
        if (typeof data !== "string" && socket === bulkSocket) {
          bodies++;
          bodyStarted.resolve();
        }
      };
      return socket as unknown as SocketLike;
    },
  });
  clients.push(writer);
  await writer.connect();
  // Initial note uses HAVE-free normal batching, but its body must not trip
  // the bulk gate. Temporarily release it during the baseline upload.
  held = false;
  await vault.edit("note.md", "# Shared note\n\nOriginal paragraph.\n");
  await writer.engine.sync();
  bodies = 0;
  bodyStarted = deferred();
  const peer = new Client({
    vault: peerVault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, wrapped, "peer")),
    vaultId: "default",
    device: "peer",
    inspect: true,
    coalesceWrites: false,
  });
  clients.push(peer);
  await peer.connect();
  await peer.engine.sync();
  const attachment = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < attachment.length; i += 65536)
    crypto.getRandomValues(attachment.subarray(i, i + 65536));
  await vault.write("attachment.bin", attachment, { mtime: 1, ctime: 1 });
  held = true;
  uploads.length = 0;
  return {
    writer,
    peer,
    vault,
    peerVault,
    attachment,
    sockets,
    uploads,
    release: () => {
      held = false;
    },
    waitForBody: () => within(bodyStarted.promise, "attachment first body"),
    nextNoteUpload: () => {
      const done = deferred();
      const resolve = () => {
        noteUploaded.delete(resolve);
        done.resolve();
      };
      noteUploaded.add(resolve);
      return done.promise;
    },
  };
}

it("delivers repeated note edits before the remaining attachment bodies are sent", async () => {
  const rig = await pair();
  const busy = rig.writer.engine.sync();
  try {
    await rig.waitForBody();
    for (let i = 1; i <= 3; i++) {
      const content = `# Shared note\n\nSaved during upload ${i}.\n`;
      const uploaded = rig.nextNoteUpload();
      await rig.vault.edit("note.md", content);
      rig.writer.noteChanged("note.md");
      await within(uploaded, "note upload during held attachment");
      await receiveCommitted(rig.peer.transport);
      await rig.peer.engine.sync();
      expect(rig.peerVault.text("note.md")).toBe(content);
      expect(await rig.peer.history("attachment.bin")).toEqual([]);
    }
    expect(rig.uploads).toEqual(["note.md", "note.md", "note.md"]);
  } finally {
    rig.release();
    await busy;
  }
  await receiveCommitted(rig.peer.transport);
  await rig.peer.engine.sync();
  expect(Buffer.from(await rig.peerVault.read("attachment.bin")).equals(rig.attachment)).toBe(true);
  expect(rig.vault.text("note.md")).toBe("# Shared note\n\nSaved during upload 3.\n");
  expect(rig.sockets).toHaveLength(2);
  expect(rig.sockets[1]!.readyState).not.toBe(WebSocket.OPEN);
});

it("closing during a bulk upload closes both wires and retains the local bytes", async () => {
  const rig = await pair();
  const busy = rig.writer.engine.sync();
  try {
    await rig.waitForBody();
    await within(rig.writer.close(), "close both upload connections");
    await busy;
    expect(rig.sockets.every((socket) => socket.readyState !== WebSocket.OPEN)).toBe(true);
    expect(Buffer.from(await rig.vault.read("attachment.bin")).equals(rig.attachment)).toBe(true);
  } finally {
    rig.release();
    await busy;
  }
});

it("retries an interrupted auxiliary upload without closing the main connection", async () => {
  const rig = await pair();
  const busy = rig.writer.engine.sync();
  try {
    await rig.waitForBody();
    rig.sockets[1]!.close();
    const failed = await within(busy, "interrupted attachment pass");
    expect(failed.retrying).toBeGreaterThan(0);
    expect(rig.writer.transport.isClosed).toBe(false);
    expect(Buffer.from(await rig.vault.read("attachment.bin")).equals(rig.attachment)).toBe(true);
    expect(await rig.peer.history("attachment.bin")).toEqual([]);
    rig.release();
    await rig.writer.engine.sync({ retryFailures: true });
    await receiveCommitted(rig.peer.transport);
    await rig.peer.engine.sync();
    expect(Buffer.from(await rig.peerVault.read("attachment.bin")).equals(rig.attachment)).toBe(
      true,
    );
    expect(rig.sockets).toHaveLength(3);
    expect(rig.sockets[2]!.readyState).not.toBe(WebSocket.OPEN);
  } finally {
    rig.release();
    await busy;
  }
});

it("preserves both concurrent note edits while an attachment is in flight", async () => {
  const rig = await pair();
  const busy = rig.writer.engine.sync();
  try {
    await rig.waitForBody();
    await rig.peerVault.edit(
      "note.md",
      "# Shared note\n\nOriginal paragraph.\n\nAdded on phone.\n",
    );
    rig.peer.noteChanged("note.md");
    await rig.peer.engine.sync();
    await receiveCommitted(rig.writer.transport);
    await rig.vault.edit("note.md", "# Updated on Mac\n\nOriginal paragraph.\n");
    rig.writer.noteChanged("note.md");
  } finally {
    rig.release();
    await busy;
  }
  await receiveCommitted(rig.peer.transport);
  await rig.peer.engine.sync();
  const expected = "# Updated on Mac\n\nOriginal paragraph.\n\nAdded on phone.\n";
  expect(rig.vault.text("note.md")).toBe(expected);
  expect(rig.peerVault.text("note.md")).toBe(expected);
  expect(Buffer.from(await rig.peerVault.read("attachment.bin")).equals(rig.attachment)).toBe(true);
  expect((await rig.vault.list()).map((file) => file.path).sort()).toEqual([
    "attachment.bin",
    "note.md",
  ]);
});
