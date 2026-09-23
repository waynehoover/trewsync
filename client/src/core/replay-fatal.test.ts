/**
 * A batch the engine cannot apply, an entry that contradicts itself above
 * all, threw out of `acceptBatch`, which ended the session, which the loop
 * read as a dropped connection and retried. The server sent the same batch,
 * the engine threw the same error, and the loop went round for ever with no
 * `onFatal`, backing off to five minutes and saying nothing a person could
 * act on.
 *
 * Basalt's version of this test was seeded with an entry whose authenticator
 * did not verify. Protocol 1 has none, so the entry here declares three bytes
 * and names no chunks: a refusal that stands on its own (hazard 5 in
 * plan/strip-ledger.md), and one only the engine makes, which is the case the
 * loop has to stop on.
 */

import { describe, expect, it } from "vitest";

import { runForever } from "./client.ts";
import { FakeSocket, ready } from "./fake-socket.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

describe("a batch no reconnection can get past", () => {
  it("stops after three identical failures, naming the cursor and the entry", async () => {
    const contradictory = {
      uid: 1,
      path: "note.md",
      size: 3,
      ctime: 1,
      mtime: 1,
      folder: false,
      deleted: false,
      chunks: [],
      device: "other",
    };
    const sockets: FakeSocket[] = [];
    let fatal: Error | undefined;
    const disconnects: string[] = [];
    let running = true;
    await runForever(
      {
        vault: new MemoryVault(),
        store: new MemoryIndexStore(),
        url: "ws://test",
        deviceId: "rig-device",
        token: "t",
        vaultId: "v",
        device: "d",
        timeoutMs: 2000,
        socketFactory: () => {
          const s = new FakeSocket();
          sockets.push(s);
          s.autoReply = (frame, socket) => {
            if (frame["op"] === "hello") {
              socket.reply(ready({ cursor: 1 }));
              socket.raw({ op: "batch", from: 1, to: 1, entries: [contradictory] });
            }
          };
          setTimeout(() => s.open(), 0);
          return s;
        },
      },
      {
        onDisconnected: (cause) => void disconnects.push(cause.message),
        onUnreachable: (cause) => void disconnects.push(cause.message),
        onFatal: (cause) => {
          fatal = cause;
          running = false;
        },
        keepGoing: () => running && sockets.length < 20,
        sleep: async () => {},
      },
    );

    expect(fatal, `the loop went round ${sockets.length} times without stopping`).toBeDefined();
    expect(sockets.length).toBe(3);
    expect(fatal!.message).toMatch(/version 1/);
    expect(fatal!.message).toMatch(/declares 3 bytes and names no chunks/);
    expect(fatal!.message).toMatch(/cursor 0/);
    expect(fatal!.message).toMatch(/3 times/);
    expect(fatal!.message).toMatch(/docs\/server\.md/);
  });

  it("keeps retrying failures that differ, which a flaky link produces", async () => {
    // Only the same failure three times running is a wall. A connection
    // that drops with a different reason each time is a network, and a
    // network is retried for as long as the shell says.
    let attempt = 0;
    let fatal: Error | undefined;
    await runForever(
      {
        vault: new MemoryVault(),
        store: new MemoryIndexStore(),
        url: "ws://test",
        deviceId: "rig-device",
        token: "t",
        vaultId: "v",
        device: "d",
        timeoutMs: 2000,
        socketFactory: () => {
          const s = new FakeSocket();
          const n = ++attempt;
          setTimeout(() => s.hangUp(1006, `reason ${n}`), 0);
          return s;
        },
      },
      {
        onFatal: (cause) => {
          fatal = cause;
        },
        keepGoing: () => attempt < 6,
        sleep: async () => {},
      },
    );
    expect(fatal).toBeUndefined();
    expect(attempt).toBe(6);
  });
});
