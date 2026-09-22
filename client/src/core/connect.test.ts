/**
 * R1. What a connection has to wait for depends on what the caller is going
 * to do with it.
 *
 * Anything that syncs waits for the backlog, because a pass that runs before
 * catch-up finishes sees a vault the server already has files for and uploads
 * the lot. `telimus status` and the cursor probe in `telimus rebase` do not
 * sync: they read the server's cursor out of the handshake and close. Making
 * them wait meant a device weeks behind unsealed and MAC checked every entry
 * of the backlog before printing one line.
 */

import { describe, expect, it, vi } from "vitest";

import { Client, type ClientOptions } from "./client.ts";
import { FakeSocket, ready, settle } from "./fake-socket.ts";
import { TEST_DATA_KEY } from "./test-keys.ts";
import { macEntry, sealPath } from "./crypto.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

/** A client on a socket that will say `ready` and never say `caught-up`. */
function clientOnFakeSocket(extra: Partial<ClientOptions> = {}): {
  socket: FakeSocket;
  client: Client;
} {
  const socket = new FakeSocket();
  const client = new Client({
    vault: new MemoryVault(),
    store: new MemoryIndexStore(),
    dataKey: TEST_DATA_KEY,
    url: "ws://test",
    deviceId: "rig-device",
    token: "t",
    vaultId: "v",
    device: "d",
    timeoutMs: 2000,
    socketFactory: () => socket,
    ...extra,
  });
  return { socket, client };
}

/** Opens the socket and answers the hello, leaving the backlog outstanding. */
async function sayReady(socket: FakeSocket, cursor: number): Promise<void> {
  await settle();
  socket.open();
  for (let i = 0; i < 50 && !socket.sentText.some((m) => m["op"] === "hello"); i++) await settle();
  socket.reply(ready({ cursor }));
  await settle();
}

/** Whether a promise has settled, without waiting on it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const first = await Promise.race([p.then(() => true), Promise.resolve(pending)]);
  await settle();
  return first !== pending;
}

describe("connecting only as far as the handshake (R1)", () => {
  it.each(["catch-up", "disconnect", "timeout"] as const)(
    "ends the backlog wait on %s and clears its inactivity deadline",
    async (ending) => {
      vi.useFakeTimers();
      const { socket, client } = clientOnFakeSocket();
      const connecting = client.connect();
      const result = connecting.catch((error: Error) => error);
      try {
        socket.open();
        await vi.waitFor(() => expect(socket.sentText.some((m) => m["op"] === "hello")).toBe(true));
        socket.reply(ready({ cursor: 1 }));
        await vi.waitFor(() => expect(client.serverLimits?.cursor).toBe(1));
        await vi.advanceTimersByTimeAsync(1500);
        socket.raw({ op: "batch", from: 1, to: 1, entries: [] });
        await client.transport.drainReceived();
        await vi.advanceTimersByTimeAsync(1900);
        // Total time exceeds the timeout; the last batch reset the deadline.
        expect(vi.getTimerCount()).toBe(1);
        if (ending === "catch-up") {
          socket.raw({ op: "caught-up", cursor: 1 });
          expect((await connecting).cursor).toBe(1);
        } else if (ending === "disconnect") {
          socket.hangUp(1006, "lost connection");
          expect(await result).toBeInstanceOf(Error);
        } else {
          await vi.advanceTimersByTimeAsync(100);
          expect(await result).toMatchObject({
            message: "the server never finished sending what it already had",
          });
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await client.close();
        await result;
        vi.useRealTimers();
      }
    },
  );
  it("groups already-received metadata before scanning the vault", async () => {
    const vault = new MemoryVault();
    let scans = 0;
    const list = vault.list.bind(vault);
    vault.list = async () => {
      scans++;
      return list();
    };
    const { socket, client } = clientOnFakeSocket({ vault });
    const connecting = client.connect();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let verifying = false;
    const accept = client.engine.acceptBatch.bind(client.engine);
    client.engine.acceptBatch = async (batch) => {
      if (batch.to === 2) {
        verifying = true;
        await gate;
      }
      await accept(batch);
    };
    try {
      await sayReady(socket, 0);
      socket.raw({ op: "caught-up", cursor: 0 });
      await connecting;
      socket.autoReply = (frame, s) => {
        if (frame["op"] === "applied") s.reply({ res: "applied", cursor: frame["applied"] });
      };
      const batches = await Promise.all(
        [1, 2].map(async (uid) => {
          const facts = {
            path: await sealPath(client.keys, `Folder ${uid}`),
            size: 0,
            ctime: 1,
            mtime: 1,
            folder: true,
            deleted: false,
            chunks: [],
            parent: "",
          };
          return {
            op: "batch",
            from: uid,
            to: uid,
            entries: [{ uid, ...facts, mac: await macEntry(client.keys, facts), device: "peer" }],
          };
        }),
      );
      for (const batch of batches) socket.raw(batch);
      await expect.poll(() => verifying).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(scans, "started a pass while received metadata was still being checked").toBe(0);
      release();
      await expect.poll(() => client.deliveryReady).toBe(true);
      expect((await list()).map((f) => f.path).sort()).toEqual(["Folder 1", "Folder 2"]);
      expect(scans).toBe(1);
    } finally {
      release();
      await client.close();
      await connecting.catch(() => undefined);
    }
  });
  it("does not start a sync from a partial initial backlog", async () => {
    const vault = new MemoryVault();
    await vault.edit("local.md", "local content must wait for complete history\n");
    let scans = 0;
    const list = vault.list.bind(vault);
    vault.list = async () => {
      scans++;
      return list();
    };
    const { socket, client } = clientOnFakeSocket({ vault });
    const connecting = client.connect();
    void connecting.catch(() => undefined);
    try {
      await sayReady(socket, 2);
      await expect.poll(() => client.serverLimits?.cursor).toBe(2);
      const facts = {
        path: await sealPath(client.keys, "Remote folder"),
        size: 0,
        ctime: 1,
        mtime: 1,
        folder: true,
        deleted: false,
        chunks: [],
        parent: "",
      };
      socket.raw({
        op: "batch",
        from: 1,
        to: 1,
        entries: [{ uid: 1, ...facts, mac: await macEntry(client.keys, facts), device: "peer" }],
      });
      await expect.poll(() => client.transport.appliedCursor).toBe(1);
      await new Promise((r) => setTimeout(r, 100));
      expect(scans, "a partial backlog started reconciling the vault").toBe(0);
      expect(vault.text("local.md")).toBe("local content must wait for complete history\n");
      expect(socket.sentText.map((m) => m["op"])).toEqual(["hello"]);
      socket.raw({ op: "batch", from: 2, to: 2, entries: [] });
      socket.raw({ op: "caught-up", cursor: 2 });
      await connecting;
    } finally {
      await client.close();
      await connecting.catch(() => undefined);
    }
  });
  it("reports authenticated history loading before connect finishes", async () => {
    const progress: { local: number; server: number }[] = [];
    const { socket, client } = clientOnFakeSocket({ onCatchUp: (at) => progress.push(at) });
    const connecting = client.connect();
    connecting.catch(() => undefined);
    try {
      await sayReady(socket, 4);
      // Ready still has to unwrap the vault key; one event-loop tick is not
      // enough to finish WebCrypto when the full suite is competing for CPU.
      await expect.poll(() => client.serverLimits?.cursor).toBe(4);
      expect(progress, "a connected device still looks like a failed connection").toEqual([
        { local: 0, server: 4 },
      ]);
      socket.raw({ op: "batch", from: 1, to: 2, entries: [] });
      await expect.poll(() => client.transport.appliedCursor).toBe(2);
      expect(progress.at(-1)).toEqual({ local: 2, server: 4 });
      expect(await settled(connecting), "progress must not bypass catch-up").toBe(false);
      socket.raw({ op: "batch", from: 3, to: 4, entries: [] });
      socket.raw({ op: "caught-up", cursor: 4 });
      await connecting;
      expect(progress.at(-1)).toEqual({ local: 4, server: 4 });
      const count = progress.length;
      socket.raw({ op: "batch", from: 5, to: 5, entries: [] });
      await expect.poll(() => client.transport.appliedCursor).toBe(5);
      expect(progress.length, "live changes restarted initial-loading feedback").toBe(count);
    } finally {
      await client.close();
      await connecting.catch(() => undefined);
    }
  });

  it("resolves with the server's own cursor without waiting for the backlog", async () => {
    const { socket, client } = clientOnFakeSocket();
    const connecting = client.connect({ waitForBacklog: false });
    await sayReady(socket, 4211);

    // No `caught-up` is ever sent, and the number is the server's own, out of
    // `ready`, which is what status prints.
    const limits = await connecting;
    expect(limits.cursor).toBe(4211);
    expect(client.serverCursor).toBe(4211);
    await client.close();
  });

  it("still waits for the backlog by default, which is what a sync needs", async () => {
    const { socket, client } = clientOnFakeSocket();
    const connecting = client.connect();
    // It fails on its own timeout eventually. What matters here is that it
    // has not finished while the server is still owed a `caught-up`.
    connecting.catch(() => undefined);
    // At zero, because the transport refuses a catch-up ahead of the batches
    // it was given, and this rig sends none.
    await sayReady(socket, 0);

    expect(await settled(connecting), "a sync connected before catch-up").toBe(false);

    socket.raw({ op: "caught-up", cursor: 0 });
    expect((await connecting).cursor).toBe(0);
    await client.close();
  });
});
