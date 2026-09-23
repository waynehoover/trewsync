/**
 * A server whose chunk ceiling is below the smallest chunk this device cuts.
 *
 * `sizesFor` never cuts under `CHUNK_FLOOR` (192 bytes, four rolling-hash
 * windows), whatever the server advertises, so against a server that takes
 * less every chunk this device made would be over the server's limit and
 * refused, one file at a time and for ever, with nothing pointing at the
 * server. So `start` refuses such a server once, at the handshake, with a
 * refusal no retry can help that names both numbers, and uploads nothing. A
 * server at the floor itself is one this device can talk to, and does.
 */

import { describe, expect, it } from "vitest";

import { CHUNK_FLOOR } from "./chunk.ts";
import { runForever } from "./client.ts";
import { chunkName } from "./digest.ts";
import { Engine } from "./engine.ts";
import { FakeSocket, ready, settle, settleUntil } from "./fake-socket.ts";
import { decodeFrame } from "./frame.ts";
import { LOCAL_MAX_CHUNK_BYTES, ProtocolError, Transport } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

/** A note long enough to need many chunks at the floor, each line its own. */
const note = Array.from({ length: 120 }, (_, i) => `line ${i} of a note cut at the floor\n`).join(
  "",
);

/** A device with a note to send, started against a server advertising `chunkMax`. */
async function against(chunkMax: number) {
  const socket = new FakeSocket();
  let engine!: Engine;
  const transport = new Transport("ws://test", {
    onBatch: (b) => engine.acceptBatch(b),
    socketFactory: () => socket,
    timeoutMs: 2000,
  });
  const connecting = transport.connect();
  socket.open();
  await connecting;
  const vault = new MemoryVault();
  await vault.edit("note.md", note);
  engine = new Engine({
    vault,
    store: new MemoryIndexStore(),
    transport,
    device: "d",
    vaultId: "v",
    deviceId: "rig-device",
    token: "t",
  });
  const started = engine.start();
  // Handled here, because it can reject during the settles below, before the
  // case that awaits it has had the chance to; the case still sees how.
  started.catch(() => {});
  await settle();
  // The server's other limits generous, so the chunk ceiling is the only one
  // this is about.
  socket.reply(ready({ cursor: 0, chunkMax, perFileMax: 1 << 28, maxChunks: 65536 }));
  await settle();
  socket.raw({ op: "caught-up", cursor: 0 });
  return { started, socket, transport, engine, vault };
}

describe("a server whose chunk ceiling is below the chunker's floor", () => {
  it("is the floor the chunker keeps to", () => {
    expect(CHUNK_FLOOR).toBe(192);
  });

  it("is refused at the handshake, for good, naming both numbers", async () => {
    const { started, socket, transport, engine } = await against(CHUNK_FLOOR - 1);
    const refused = await started.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refused, "a server this device cannot cut for was taken").toBeInstanceOf(ProtocolError);
    const err = refused as ProtocolError;
    expect(err.code).toBe("protostate");
    expect(err.retryable, "a limit no retry changes was called retryable").toBe(false);
    expect(err.fatal).toBe(true);
    expect(err.message).toContain(`at most ${CHUNK_FLOOR - 1} bytes`);
    expect(err.message).toContain(`smaller than ${CHUNK_FLOOR}`);
    expect(transport.isClosed, "the session was left open").toBe(true);

    // And nothing went up, even with a shell asking for a sync anyway.
    await engine.sync().catch(() => undefined);
    expect(socket.sentText.map((m) => m["op"])).toEqual(["hello"]);
    expect(socket.sentBinary).toEqual([]);
  });

  it("stops a device that runs for ever, rather than reconnecting into it", async () => {
    // Non-retryable is what a shell reads: the loop stops and says why, where
    // a retryable refusal would back off and come back to the same limit.
    const sockets: FakeSocket[] = [];
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
          sockets.push(s);
          s.autoReply = (frame, socket) => {
            if (frame["op"] === "hello") {
              socket.reply(ready({ cursor: 0, chunkMax: 64 }));
              socket.raw({ op: "caught-up", cursor: 0 });
            }
          };
          setTimeout(() => s.open(), 0);
          return s;
        },
      },
      {
        onFatal: (cause) => {
          fatal = cause;
        },
        keepGoing: () => sockets.length < 5,
        sleep: async () => {},
      },
    );
    expect(fatal, `the loop went round ${sockets.length} times without stopping`).toBeDefined();
    expect(sockets).toHaveLength(1);
    expect(fatal!.message).toContain("at most 64 bytes");
    expect(fatal!.message).toContain(`smaller than ${CHUNK_FLOOR}`);
  });

  it("is taken at the floor itself, and the note goes up whole in chunks no larger", async () => {
    const { started, socket, transport, engine } = await against(CHUNK_FLOOR);
    const limits = await started;
    expect(limits.chunkMax).toBe(CHUNK_FLOOR);

    // A server that wants every body it is offered and then commits.
    let uid = 0;
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "putmany") {
        const entries = frame["entries"] as { chunks: string[] }[];
        const names = [...new Set(entries.flatMap((e) => e.chunks))];
        const before = s.sentBinary.length;
        s.reply({ res: "want", chunks: names });
        void (async () => {
          await settleUntil(
            "the bodies to arrive",
            () => s.sentBinary.length >= before + names.length,
          );
          s.reply({ res: "acks", results: entries.map(() => ({ uid: ++uid })) });
        })();
      } else if (frame["op"] === "applied") {
        s.reply({ res: "applied", cursor: frame["applied"] });
      } else if (frame["op"] === "ping") {
        s.raw({ res: "pong" });
      }
    };
    const report = await engine.sync({ coalesceWrites: false });
    expect(report.uploaded, JSON.stringify(report.needsAttention)).toBe(1);
    expect(transport.isClosed).toBe(false);

    const put = socket.sentText.find((m) => m["op"] === "putmany");
    const names = (put!["entries"] as { chunks: string[] }[])[0]!.chunks;
    expect(names.length, "a note this long was not cut at the floor").toBeGreaterThan(10);
    const bodies = new Map<string, Uint8Array>();
    for (const frame of socket.sentBinary) {
      const raw = decodeFrame(frame, LOCAL_MAX_CHUNK_BYTES);
      expect(raw.length, "a chunk over the server's ceiling went up").toBeLessThanOrEqual(
        CHUNK_FLOOR,
      );
      bodies.set(await chunkName(raw), raw);
    }
    // Rule 10: the bytes, reassembled in the order the entry names them, are
    // the note, so nothing was lost to cutting this fine.
    const joined = names.map((n) => new TextDecoder().decode(bodies.get(n)!)).join("");
    expect(joined).toBe(note);
  });
});
