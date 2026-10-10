/**
 * The transport against a server that misbehaves.
 *
 * `server-harness.test.ts` proves the client and the real server agree. It cannot
 * prove the client is robust, because the real server never lies: every
 * defensive check in the transport is unreachable when the peer is correct, and a
 * mutation pass against the integration suite showed exactly that, with nine of
 * eighteen breakages surviving.
 *
 * So this file supplies the lying peer. A gap in the batch sequence, a caught-up
 * at a cursor nobody reached, an entry outside its own range, a reply nobody
 * asked for: none of these can be produced by the Go server, and all of them can
 * be produced by a proxy, a version mismatch, or a bug on either side. The two
 * files are the same subject from opposite directions and neither is redundant.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, nextTurn } from "./test-async.ts";

afterEach(() => vi.useRealTimers());

import { chunkName } from "./digest.ts";
import {
  FakeSocket,
  RIG_EPOCH,
  engineOnFakeSocket,
  rawFrame,
  ready,
  settle,
} from "./fake-socket.ts";
import { MARKER_DEFLATE, MARKER_RAW, decodeFrame, encodeFrame } from "./frame.ts";
import {
  Backoff,
  ConnectionError,
  LOCAL_MAX_CHUNK_BYTES,
  PROTO,
  ProtocolError,
  Transport,
  entryBudget,
  type Batch,
} from "./transport.ts";
import { MemoryVault } from "./vault.ts";

/** Random bytes, which do not compress, so they travel in a raw frame. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) {
    crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, n)));
  }
  return out;
}

/** The raw chunk inside a frame this device sent. */
const opened = (frame: Uint8Array): Uint8Array => decodeFrame(frame, LOCAL_MAX_CHUNK_BYTES);

/** A connected transport and the socket behind it. */
async function connected(
  opts: {
    onBatch?: (b: Batch) => void | Promise<void>;
    onCaughtUp?: (c: number) => void;
    timeoutMs?: number;
    socket?: FakeSocket;
  } = {},
) {
  const socket = opts.socket ?? new FakeSocket();
  const batches: Batch[] = [];
  const t = new Transport("ws://test", {
    onBatch: opts.onBatch ?? ((b) => void batches.push(b)),
    ...(opts.onCaughtUp ? { onCaughtUp: opts.onCaughtUp } : {}),
    socketFactory: () => socket,
    timeoutMs: opts.timeoutMs ?? 1000,
  });
  const connecting = t.connect();
  socket.open();
  await connecting;
  return { t, socket, batches };
}

/** Completes a handshake so the tests below start from a live session. */
async function helloed(cursor = 0, opts: Parameters<typeof connected>[0] = {}) {
  const rig = await connected(opts);
  const hello = rig.t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor });
  rig.socket.reply(ready());
  await hello;
  return rig;
}

/**
 * The conditions of a first write, for the puts below that are about the
 * transport rather than about the entry: no live version at the path. `put`
 * takes its conditions rather than defaulting them, so that a caller with a
 * base cannot forget to pass it; a test that deliberately writes against
 * nothing says so here.
 */
const noBase = { base: 0 };

describe("transfer byte progress", () => {
  it.each(["put", "putmany"])(
    "counts wanted bytes in %s, without completing before the ack",
    async (op) => {
      class BufferedSocket extends FakeSocket {
        bufferedAmount = 0;
        override send(data: string | ArrayBufferLike | Uint8Array): void {
          super.send(data);
          if (typeof data !== "string") this.bufferedAmount += data.byteLength;
        }
      }
      const socket = new BufferedSocket();
      const { t } = await helloed(0, { socket });
      // Incompressible, so the frame is the chunk and one marker byte, and the
      // numbers below are the frame's.
      const body = noise(100);
      const frame = encodeFrame(body);
      expect(frame[0]).toBe(MARKER_RAW);
      const name = await chunkName(body);
      const reused = await chunkName(new Uint8Array([1]));
      const seen: number[] = [];
      const produce = vi.fn(async () => body);
      const meta = { size: 101, ctime: 0, mtime: 0 };
      let done = false;
      const putting = (
        op === "put"
          ? t.put("p", meta, [name, reused], produce, noBase, (n) => seen.push(n))
          : t.putMany([{ path: "p", meta, names: [name, reused], ...noBase }], produce, (n) =>
              seen.push(n),
            )
      ).then((r) => {
        done = true;
        return r;
      });
      try {
        socket.reply({ res: "want", chunks: [name] });
        await settle();
        // The body goes up framed, and the framing is done here.
        expect(socket.sentBinary).toEqual([frame]);
        expect(seen).toEqual([0]);
        socket.bufferedAmount = 60;
        await expect.poll(() => seen.at(-1)).toBe(frame.length - 60);
        socket.bufferedAmount = 0;
        await expect.poll(() => seen.at(-1)).toBe(frame.length);
        expect(done).toBe(false);
        expect(produce).toHaveBeenCalledTimes(1);
        socket.reply(
          op === "put" ? { res: "ack", uid: 1 } : { res: "acks", results: [{ uid: 1 }] },
        );
        // What went on the wire is what is counted: frame bytes.
        expect(await putting).toMatchObject({ bytes: frame.length, uploaded: 1 });
      } finally {
        t.close();
        await putting.catch(() => {});
      }
    },
  );

  it("stops polling the socket buffer four times a second while it sits still", async () => {
    // A fixed 5 ms poll woke the event loop two hundred times a second for the
    // length of an upload, which on a phone is the radio and the CPU kept
    // awake to read one number that has not changed (R083-22). The wait widens
    // while nothing moves and resets the moment something does, so the thing
    // that matters, noticing the buffer clear, is as prompt as it was.
    let reads = 0;
    let buffered = 0;
    class CountingSocket extends FakeSocket {
      get bufferedAmount(): number {
        reads++;
        return buffered;
      }
      override send(data: string | ArrayBufferLike | Uint8Array): void {
        super.send(data);
        if (typeof data !== "string") buffered += data.byteLength;
      }
    }
    const socket = new CountingSocket();
    const { t } = await helloed(0, { socket });
    // Over UPLOAD_HIGH_WATER once framed, which it only is if it does not
    // compress: a frame of zeroes would be a few kilobytes.
    const body = noise(8 * 1024 * 1024);
    const name = await chunkName(body);
    const meta = { size: body.length, ctime: 0, mtime: 0 };
    const putting = t.put("p", meta, [name], async () => body, noBase);
    try {
      socket.reply({ res: "want", chunks: [name] });
      await expect.poll(() => reads > 0).toBe(true);
      // A quarter of a second with the buffer stuck. At a flat 5 ms that is
      // about fifty looks; widening towards 50 ms it is under ten.
      const before = reads;
      await new Promise((r) => setTimeout(r, 250));
      const looks = reads - before;
      expect(looks, `${looks} looks at a buffer that never moved`).toBeLessThan(15);

      // And it comes straight back when the buffer moves.
      buffered = 0;
      await expect.poll(() => reads > 0).toBe(true);
      socket.reply({ res: "ack", uid: 1 });
      await putting;
    } finally {
      t.close();
      await putting.catch(() => {});
    }
  });

  it("reports received bodies while later bodies are still outstanding", async () => {
    const { t, socket } = await helloed();
    const bodies = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const seen: number[] = [];
    let done = false;
    const fetching = t
      .fetch(await Promise.all(bodies.map(chunkName)), (n) => seen.push(n))
      .then((r) => {
        done = true;
        return r;
      });
    try {
      socket.reply({ res: "bodies", count: 2 });
      // Frames, a marker byte each, and what is counted is what arrived.
      socket.body(rawFrame(bodies[0]!));
      await settle();
      expect(seen).toEqual([0, 4]);
      expect(done).toBe(false);
      socket.body(rawFrame(bodies[1]!));
      expect(await fetching).toEqual(bodies);
      expect(seen).toEqual([0, 4, 7]);
    } finally {
      t.close();
      await fetching.catch(() => {});
    }
  });

  it("keeps progress observers out of transfer failure handling", async () => {
    const { t, socket } = await helloed();
    const body = new Uint8Array([1, 2, 3]);
    const fetching = t.fetch([await chunkName(body)], () => {
      throw new Error("UI failed");
    });
    socket.bodies(body);
    expect(await fetching).toEqual([body]);
    expect(t.isClosed).toBe(false);
    t.close();
  });
});

describe("upload acknowledgments behind metadata verification", () => {
  it.each(["have", "ack", "acks"])("waits for earlier batches before returning %s", async (res) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let verified = false;
    const { t, socket } = await helloed(0, {
      onBatch: async () => {
        await gate;
        verified = true;
      },
    });
    const { body, name } = await named(new Uint8Array([1, 2, 3]));
    const meta = { size: 3, ctime: 1, mtime: 1 };
    const write =
      res === "acks"
        ? t.putMany([{ path: "p", meta, names: [name], ...noBase }], async () => body)
        : t.put("p", meta, [name], async () => body, noBase);
    let completed = false;
    const result = write.then((value) => {
      completed = true;
      return value;
    });
    try {
      if (res === "ack") {
        socket.reply({ res: "want", chunks: [name] });
        await settle();
      }
      socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
      socket.reply(res === "acks" ? { res, results: [{ uid: 2 }] } : { res, uid: 2 });
      await settle();
      expect(completed).toBe(false);
      expect(verified).toBe(false);
      release();
      await result;
      expect(verified).toBe(true);
      expect(completed).toBe(true);
    } finally {
      release();
      await result;
      t.close();
    }
  });

  it("refuses to mark an upload synced when earlier metadata fails verification", async () => {
    const { t, socket } = await helloed(0, {
      onBatch: async () => {
        await settle();
        throw new Error("the batch before this write could not be applied");
      },
    });
    const write = t.put(
      "p",
      { size: 0, ctime: 1, mtime: 1 },
      [],
      async () => new Uint8Array(),
      noBase,
    );
    const checked = expect(write).rejects.toThrow(
      "the batch before this write could not be applied",
    );
    socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
    socket.reply({ res: "have", uid: 2 });
    await checked;
    expect(t.isClosed).toBe(true);
  });
});

/** A body and the name it travels under, which is a hash of exactly its bytes. */
async function named(body: Uint8Array): Promise<{ body: Uint8Array; name: string }> {
  return { body, name: await chunkName(body) };
}

describe("batches from a server that skips one", () => {
  it("refuses a batch that does not continue the cursor", async () => {
    const { t, socket, batches } = await helloed(0);
    // Jumping from 0 to a batch starting at 5 means uids 1 to 4 were never
    // sent, and nothing would ask about them again.
    socket.reply({ op: "batch", from: 5, to: 6, entries: [] });
    await settle();

    expect(t.isClosed).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("accepts a batch whose range spans a hole left by a purge", async () => {
    // From and to are a covered range, not the uids present, so a purged
    // sequence is not a gap. Getting this wrong would make a client read its
    // own tidied history as lost files.
    const { t, socket, batches } = await helloed(0);
    socket.reply({ op: "batch", from: 1, to: 9, entries: [{ uid: 9, path: "p", chunks: [] }] });
    await settle();

    expect(t.isClosed).toBe(false);
    expect(batches).toHaveLength(1);
    expect(t.appliedCursor).toBe(9);
  });

  it("refuses an entry outside the range it arrived in", async () => {
    const { t, socket } = await helloed(0);
    socket.reply({ op: "batch", from: 1, to: 3, entries: [{ uid: 77, path: "p", chunks: [] }] });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("refuses a chunk name that is not one (C-D3)", async () => {
    // history, deleted and get all check the shape of every name they are
    // given, and this did not: a name that is not a name went on to be
    // fetched as one, and the refusal came much later from somewhere with
    // nothing to say about where it had come from.
    const { t, socket, batches } = await helloed(0);
    socket.reply({
      op: "batch",
      from: 1,
      to: 1,
      entries: [{ uid: 1, path: "p", chunks: ["../../etc/passwd"] }],
    });
    await settle();
    expect(t.isClosed).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("refuses an empty range", async () => {
    const { t, socket } = await helloed(5);
    socket.reply({ op: "batch", from: 6, to: 5, entries: [] });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("advances the cursor only after the batch has been applied", async () => {
    // Advancing first would mean a failure to apply is a file silently
    // skipped: the cursor would already be past it and nothing asks twice.
    let seen = -1;
    const { t, socket } = await helloed(0, {
      onBatch: async (b) => {
        seen = t.appliedCursor;
        void b;
      },
    });
    socket.reply({ op: "batch", from: 1, to: 4, entries: [] });
    await settle();
    expect(seen, "the cursor had already moved when the batch was handed over").toBe(0);
    expect(t.appliedCursor).toBe(4);
  });

  it("stops at the first batch the caller cannot apply", async () => {
    const { t, socket } = await helloed(0, {
      onBatch: () => {
        throw new Error("could not write the file");
      },
    });
    socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
    await settle();
    // The cursor did not move, so a reconnect asks for it again.
    expect(t.appliedCursor).toBe(0);
    expect(t.isClosed).toBe(true);
  });

  it("applies batches one at a time, in order", async () => {
    // Two batches arriving together must not overlap: the second's
    // continuity check depends on the first having finished.
    const order: number[] = [];
    const held = deferred();
    const entered = deferred();
    const { t, socket } = await helloed(0, {
      onBatch: async (b) => {
        order.push(b.from);
        if (b.from === 1) {
          entered.resolve();
          await held.promise;
        }
        order.push(-b.from);
      },
    });
    socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
    socket.reply({ op: "batch", from: 2, to: 2, entries: [] });
    await entered.promise;
    expect(order).toEqual([1]);
    held.resolve();
    await t.drainReceived();

    expect(order).toEqual([1, -1, 2, -2]);
    expect(t.appliedCursor).toBe(2);
    expect(t.isClosed).toBe(false);
  });
});

describe("caught-up", () => {
  it("is refused when it names a cursor this device never reached", async () => {
    // The server says the backlog ends somewhere the client never got to,
    // which leaves a hole nothing asks about again.
    const { t, socket } = await helloed(0);
    socket.reply({ op: "caught-up", cursor: 40 });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("is reported when it agrees", async () => {
    const seen: number[] = [];
    const { t, socket } = await helloed(0, { onCaughtUp: (c) => seen.push(c) });
    socket.reply({ op: "batch", from: 1, to: 3, entries: [] });
    socket.reply({ op: "caught-up", cursor: 3 });
    await settle();
    expect(seen).toEqual([3]);
    expect(t.isClosed).toBe(false);
  });
});

describe("the handshake", () => {
  it("refuses a server answering in another protocol version, naming both", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply(ready({ proto: 1, serverVersion: "0.2.2" }));
    await expect(hello).rejects.toMatchObject({ code: "proto" });
    await expect(hello).rejects.toThrow(/protocol 1/);
    await expect(hello).rejects.toThrow(new RegExp(`speaks ${PROTO}`));
    await expect(hello).rejects.toThrow(/upgrade the server first/);
  });

  /**
   * review finding I9. A server that does not speak this client's protocol
   * refuses the hello before it knows anything about who is asking, so the
   * refusal carries no id and no `retryable`, only a message naming the
   * server's own range. The client turns that into a sentence naming both
   * ends and the one thing to do about it, because the upgrade order is the
   * server first and a person reading "protocol 3 not supported" on their
   * phone has no way to know which end is behind.
   */
  it("names both versions when a server refuses the protocol, and says which end to upgrade", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.raw({
      res: "err",
      code: "proto",
      msg: "protocol 2 not supported, this server speaks 1 to 1",
    });
    await expect(hello).rejects.toMatchObject({ code: "proto", retryable: false });
    await expect(hello).rejects.toThrow(/speaks 1 to 1/);
    await expect(hello).rejects.toThrow(new RegExp(`This client speaks protocol ${PROTO}`));
    await expect(hello).rejects.toThrow(/upgrade the server first/);
    expect(t.isClosed).toBe(true);
  });

  /**
   * The frame is exactly the fields the protocol names, and nothing else: no
   * `crypto` suite, which Basalt's hello carried and a TrewSync server has no use
   * for, and no `epoch` on a device that has not been told one. The version is
   * 2, protocol 1 and undo (plan/protocol.md, "Undo (protocol 2)").
   */
  it("sends its protocol version, a device id and an id, and no crypto suite", async () => {
    const { t, socket } = await connected();
    void t
      .hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 7 })
      .catch(() => {});
    await settle();
    expect(socket.sentText[0]).toEqual({
      op: "hello",
      id: 1,
      proto: PROTO,
      vault: "v",
      deviceId: "dev",
      token: "t",
      device: "d",
      cursor: 7,
    });
    expect(PROTO).toBe(3);
    expect("crypto" in socket.sentText[0]!).toBe(false);
  });

  it("sends the epoch its cursor was read under, and only when there is one", async () => {
    // Absent, the server takes the cursor as it is; present, a server whose
    // history is not that one replays the vault from uid 1 instead of
    // refusing a cursor it never issued (plan/protocol.md, "Device session").
    for (const epoch of [undefined, "an-epoch"]) {
      const { t, socket } = await connected();
      void t
        .hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 3, epoch })
        .catch(() => {});
      await settle();
      const sent = socket.sentText[0]!;
      if (epoch === undefined) expect("epoch" in sent, "an epoch nobody gave was sent").toBe(false);
      else expect(sent["epoch"]).toBe(epoch);
      t.close();
    }
  });

  it("reads every ceiling ready carries, and the epoch", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply(
      ready({
        minProto: 3,
        serverVersion: "1.2.3",
        epoch: "the-store's-epoch",
        cursor: 44,
        perFileMax: 999,
        chunkMax: 4096,
        maxChunks: 17,
        maxBatchBytes: 1234,
        maxFetchBytes: 5678,
      }),
    );
    // Every field, and no other: there is no data key to read any more.
    expect(await hello).toEqual({
      proto: PROTO,
      minProto: 3,
      serverVersion: "1.2.3",
      epoch: "the-store's-epoch",
      cursor: 44,
      perFileMax: 999,
      chunkMax: 4096,
      maxChunks: 17,
      maxBatchBytes: 1234,
      maxFetchBytes: 5678,
    });
    expect(t.serverLimits?.maxBatchBytes).toBe(1234);
    expect(t.serverLimits?.epoch).toBe("the-store's-epoch");
  });

  /**
   * Every store has an epoch, so a `ready` without one is not a second kind of
   * server: it is one this device cannot tell apart from a restored copy of
   * itself, and a cursor into a reissued uid sequence skips, without a word,
   * the versions that replaced the ones it saw. Refused, and the session ends.
   */
  it("ends the session on a ready with no epoch", async () => {
    for (const missing of [{ epoch: undefined }, { epoch: "" }, { epoch: 7 }, { epoch: null }]) {
      const { t, socket } = await connected();
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
      socket.reply(ready(missing));
      await expect(hello, JSON.stringify(missing)).rejects.toMatchObject({ code: "protostate" });
      await expect(hello).rejects.toThrow(/no epoch/);
      expect(t.isClosed, "carried on without knowing which history it serves").toBe(true);
    }
  });

  it("caps the chunk ceiling at the most this device will decode", async () => {
    // A frame is refused on its length before anything is inflated, and that
    // bound is this number, so a server does not get to raise it.
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply(ready({ chunkMax: LOCAL_MAX_CHUNK_BYTES * 64 }));
    expect((await hello).chunkMax).toBe(LOCAL_MAX_CHUNK_BYTES);
  });

  it("names the device on a device hello", async () => {
    // The row the session speaks for. There is no other kind of hello that
    // syncs, and a redemption is a separate call with its own frame.
    const { t, socket } = await connected();
    void t
      .hello({ vault: "v", deviceId: "dev-1", token: "t", device: "d", cursor: 0 })
      .catch(() => {});
    await settle();
    expect(socket.sentText[0]).toMatchObject({ op: "hello", proto: PROTO, deviceId: "dev-1" });
  });

  /**
   * review finding I6. Both names land in the server's log and on every entry
   * this device writes; the server refuses over 64 bytes or a control
   * character with `badname` and ends the session. Refused here first, so a
   * bad name is one error at pairing rather than a connection that dies on
   * every attempt with nothing to say.
   */
  it("refuses a vault or device name the server would refuse, before sending it", async () => {
    for (const [what, name] of [
      ["device", "x".repeat(65)],
      ["device", "é".repeat(33)], // 66 bytes of 33 characters
      ["vault", "y".repeat(65)],
      ["device", "line\nbreak"],
      ["vault", "tab\there"],
      ["device", "del\x7f"],
    ] as const) {
      const { socket, t } = await connected();
      const args = {
        vault: "v",
        deviceId: "dev",
        token: "t",
        device: "d",
        cursor: 0,
        [what]: name,
      };
      await expect(t.hello(args), `${what} ${JSON.stringify(name)}`).rejects.toMatchObject({
        code: "badname",
      });
      expect(socket.sentText, "the bad name was sent").toHaveLength(0);
    }
    // And exactly sixty-four bytes is fine, as is any printable character.
    const { socket, t } = await connected();
    void t
      .hello({ vault: "v".repeat(64), deviceId: "dev", token: "t", device: "café ~", cursor: 0 })
      .catch(() => {});
    await settle();
    expect(socket.sentText).toHaveLength(1);
  });

  it("refuses anything other than ready", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply({ res: "pong" });
    await expect(hello).rejects.toBeInstanceOf(ProtocolError);
  });
});

/**
 * A `ready` from a store whose history is not the one this device's cursor
 * was read from (plan/protocol.md, "Device session"; PLAN.md section 2.8).
 *
 * The hello carried the epoch the cursor belongs to, and the server, seeing
 * another, replays the whole vault from uid 1. So the transport's own cursor
 * has to start again from zero, and it has to do so the moment `ready`
 * lands: the first batch of the replay can be queued behind it before the
 * caller of `hello` has heard anything, and read against the old cursor it
 * would be refused as a gap.
 */
describe("a ready in another epoch", () => {
  const helloIn = (t: Transport, epoch: string | undefined, cursor = 7) =>
    t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor, epoch });

  it("is read as a history replaced, and the cursor starts again from zero", async () => {
    const { t, socket, batches } = await connected();
    const hello = helloIn(t, "the-old-epoch");
    socket.reply(ready({ epoch: "a-new-epoch", cursor: 3 }));
    const limits = await hello;
    expect(limits.epoch).toBe("a-new-epoch");
    expect(t.historyReplaced, "a replaced history read as the same one").toBe(true);
    expect(t.appliedCursor, "the cursor of the old history was kept").toBe(0);

    // The replay, from uid 1, is taken as continuing a cursor of zero.
    socket.raw({ op: "batch", from: 1, to: 3, entries: [] });
    socket.raw({ op: "caught-up", cursor: 3 });
    await t.drainReceived();
    expect(batches.map((b) => [b.from, b.to])).toEqual([[1, 3]]);
    expect(t.appliedCursor).toBe(3);
    expect(t.isClosed).toBe(false);
  });

  it("takes the replay's first batch even when it lands with the ready, before hello returns", async () => {
    const { t, socket, batches } = await connected();
    const hello = helloIn(t, "the-old-epoch");
    await settle();
    // Both frames in one turn, which is how a loopback server delivers them:
    // nothing between them gives the caller of `hello` a chance to act.
    const id = socket.lastId;
    socket.raw(ready({ id, epoch: "a-new-epoch", cursor: 1 }));
    socket.raw({ op: "batch", from: 1, to: 1, entries: [] });
    await hello;
    await t.drainReceived();
    expect(t.isClosed, "the replay's first batch was refused as a gap").toBe(false);
    expect(batches.map((b) => b.from)).toEqual([1]);
    expect(t.appliedCursor).toBe(1);
  });

  it("continues the cursor when the epoch is the one the hello carried", async () => {
    const { t, socket, batches } = await connected();
    const hello = helloIn(t, RIG_EPOCH);
    socket.reply(ready({ epoch: RIG_EPOCH, cursor: 9 }));
    await hello;
    expect(t.historyReplaced).toBe(false);
    expect(t.appliedCursor).toBe(7);
    socket.raw({ op: "batch", from: 8, to: 9, entries: [] });
    await t.drainReceived();
    expect(batches.map((b) => [b.from, b.to])).toEqual([[8, 9]]);

    // And a batch from 1 in the same history is the gap it always was.
    socket.raw({ op: "batch", from: 1, to: 1, entries: [] });
    await settle();
    expect(t.isClosed, "a restart of the history was taken without a new epoch").toBe(true);
  });

  it("takes the cursor as it is on a hello that carried no epoch", async () => {
    // A device's first connect has nothing to compare, and the server takes
    // its cursor as given; nothing about that is a replaced history.
    const { t, socket, batches } = await connected();
    const hello = helloIn(t, undefined);
    socket.reply(ready({ epoch: "whatever-this-store-has", cursor: 8 }));
    await hello;
    expect(t.historyReplaced).toBe(false);
    socket.raw({ op: "batch", from: 8, to: 8, entries: [] });
    await t.drainReceived();
    expect(batches).toHaveLength(1);
    expect(t.appliedCursor).toBe(8);
  });
});

describe("put, against a server that answers oddly", () => {
  it("sends bodies in the order the server asked for", async () => {
    // The server matches each body by hashing it, so a wrong order is caught
    // there. Sending the right order is still this side's job: relying on the
    // other end to notice is how the two ends end up disagreeing about how
    // many frames are left.
    const { t, socket } = await helloed(0);
    const chunks = [
      { name: "a".repeat(64), bytes: new Uint8Array([1]) },
      { name: "b".repeat(64), bytes: new Uint8Array([2]) },
      { name: "c".repeat(64), bytes: new Uint8Array([3]) },
    ];
    const put = t.put(
      "p",
      { size: 3, ctime: 0, mtime: 0 },
      chunks.map((c) => c.name),
      async (n) => chunks.find((c) => c.name === n)!.bytes,
      noBase,
    );
    await settle();
    // Asked for out of order, and only two of the three.
    socket.reply({ res: "want", chunks: ["c".repeat(64), "a".repeat(64)] });
    await settle();
    socket.reply({ res: "ack", uid: 5 });

    expect(await put).toMatchObject({ uid: 5, uploaded: 2 });
    expect(socket.sentBinary.map((b) => opened(b)[0])).toEqual([3, 1]);
    // Each one framed as it went, and framed the one way: what encodeFrame
    // makes of those bytes.
    expect(socket.sentBinary).toEqual([
      encodeFrame(new Uint8Array([3])),
      encodeFrame(new Uint8Array([1])),
    ]);
  });

  it("refuses to invent a body the server asked for", async () => {
    const { t, socket } = await helloed(0);
    const put = t.put(
      "p",
      { size: 1, ctime: 0, mtime: 0 },
      ["a".repeat(64)],
      async () => new Uint8Array([1]),
      noBase,
    );
    await settle();
    socket.reply({ res: "want", chunks: ["z".repeat(64)] });
    await expect(put).rejects.toMatchObject({ code: "badchunk" });
  });

  it("reports have as no upload at all", async () => {
    const { t, socket } = await helloed(0);
    const put = t.put(
      "p",
      { size: 1, ctime: 0, mtime: 0 },
      ["a".repeat(64)],
      async () => new Uint8Array([1]),
      noBase,
    );
    await settle();
    socket.reply({ res: "have", uid: 9 });
    expect(await put).toEqual({ uid: 9, uploaded: 0, bytes: 0 });
    expect(socket.sentBinary).toHaveLength(0);
  });

  it("refuses a reply that is neither want nor have", async () => {
    const { t, socket } = await helloed(0);
    const put = t.put(
      "p",
      { size: 0, ctime: 0, mtime: 0 },
      [],
      async () => new Uint8Array(0),
      noBase,
    );
    await settle();
    socket.reply({ res: "chunks", uid: 1, size: 0, chunks: [] });
    await expect(put).rejects.toBeInstanceOf(ProtocolError);
  });

  it("carries prev only when there is a rename", async () => {
    const { t, socket } = await helloed(0);
    void t
      .put("new", { size: 0, ctime: 0, mtime: 0 }, [], async () => new Uint8Array(0), noBase)
      .catch(() => {});
    await settle();
    expect(socket.sentText.at(-1)?.["meta"]).not.toHaveProperty("prev");

    socket.reply({ res: "have", uid: 1 });
    await settle();
    void t
      .put(
        "new",
        { size: 0, ctime: 0, mtime: 0, prev: "old" },
        [],
        async () => new Uint8Array(0),
        noBase,
      )
      .catch(() => {});
    await settle();
    expect(socket.sentText.at(-1)?.["meta"]).toMatchObject({ prev: "old" });
  });

  /**
   * The conditional-write fields, as protocol 1 puts them on the wire:
   * `base` on every write, zero for no live entry, and `prevBase` only on a
   * rename, which is the only write that has a source (plan/protocol.md,
   * "Writing"). The transcripts pin the same shapes against the server.
   */
  it("sends base always, and prevBase only with a rename", async () => {
    const { t, socket } = await helloed(0);
    const sent = async (
      meta: { size: number; ctime: number; mtime: number; prev?: string },
      cond: { base?: number; prevBase?: number },
    ) => {
      void t.put("p.md", meta, [], async () => new Uint8Array(0), cond).catch(() => {});
      await settle();
      const frame = socket.sentText.at(-1)!;
      socket.reply({ res: "have", uid: 1 });
      await settle();
      return frame;
    };
    const plain = { size: 0, ctime: 1, mtime: 2 };

    // A first write: a base of zero, sent, and nothing about a source.
    expect(await sent(plain, {})).toEqual({
      op: "put",
      id: 2,
      path: "p.md",
      meta: { size: 0, ctime: 1, mtime: 2, folder: false, deleted: false },
      chunks: [],
      base: 0,
    });
    // A write on top of a version.
    const edit = await sent(plain, { base: 5 });
    expect(edit["base"]).toBe(5);
    expect("prevBase" in edit, "a prevBase went out with no rename").toBe(false);
    // A prevBase handed to a write that is not a rename is not sent either.
    expect("prevBase" in (await sent(plain, { base: 5, prevBase: 3 }))).toBe(false);
    // A rename carries both, and its source's defaults to zero.
    const move = await sent({ ...plain, prev: "old.md" }, { base: 0, prevBase: 3 });
    expect(move).toMatchObject({ base: 0, prevBase: 3, meta: { prev: "old.md" } });
    const blind = await sent({ ...plain, prev: "old.md" }, {});
    expect(blind).toMatchObject({ base: 0, prevBase: 0 });
  });

  it("gives every entry of a batch the same shape a put has", async () => {
    const { t, socket } = await helloed(0);
    const meta = { size: 0, ctime: 1, mtime: 2 };
    void t
      .putMany(
        [
          { path: "new.md", meta, names: [] },
          { path: "edit.md", meta, names: [], base: 4, prevBase: 9 },
          { path: "moved.md", meta: { ...meta, prev: "old.md" }, names: [], base: 0, prevBase: 6 },
        ],
        async () => new Uint8Array(0),
      )
      .catch(() => {});
    await settle();
    const frame = socket.sentText.at(-1)!;
    expect(frame["op"]).toBe("putmany");
    const shape = { folder: false, deleted: false, size: 0, ctime: 1, mtime: 2 };
    expect(frame["entries"]).toEqual([
      { path: "new.md", meta: shape, chunks: [], base: 0 },
      { path: "edit.md", meta: shape, chunks: [], base: 4 },
      {
        path: "moved.md",
        meta: { ...shape, prev: "old.md" },
        chunks: [],
        base: 0,
        prevBase: 6,
      },
    ]);
    t.close();
  });
});

/**
 * The ack follows the last body, and a loopback server answers
 * inside the same tick as the send. A waiter installed after the bodies went
 * out found the answer already there, and with no waiter in place a valid
 * acknowledgement read as a reply nobody asked for and closed the connection.
 */
describe("an acknowledgement that arrives as fast as a loopback server sends it", () => {
  const one = { name: "a".repeat(64), bytes: new Uint8Array([1]) };
  const two = { name: "b".repeat(64), bytes: new Uint8Array([2]) };

  /** A socket that answers from inside `send`, the moment the last body lands. */
  class InstantSocket extends FakeSocket {
    answer: Record<string, unknown> = {};
    after = 0;
    override send(data: string | ArrayBufferLike | Uint8Array): void {
      super.send(data);
      if (typeof data !== "string" && this.sentBinary.length === this.after) {
        this.reply(this.answer);
      }
    }
  }

  /** A socket whose buffer drains on a timer, with the answer arriving mid-drain. */
  class DrainingSocket extends FakeSocket {
    buffered = 0;
    answer: Record<string, unknown> = {};
    after = 0;
    stepMs = 5;
    stepBytes = 1;
    get bufferedAmount(): number {
      return this.buffered;
    }
    override send(data: string | ArrayBufferLike | Uint8Array): void {
      super.send(data);
      if (typeof data === "string") return;
      this.buffered += this.sentBinary.at(-1)!.length;
      const tick = () => {
        this.buffered = Math.max(0, this.buffered - this.stepBytes);
        if (this.buffered > 0) setTimeout(tick, this.stepMs);
      };
      setTimeout(tick, this.stepMs);
      // The server has the bodies and answers while this side's buffer is
      // still reported as draining.
      if (this.sentBinary.length === this.after) setTimeout(() => this.reply(this.answer), 1);
    }
  }

  async function rig(socket: FakeSocket, timeoutMs = 1000) {
    const t = new Transport("ws://test", {
      onBatch: () => {},
      socketFactory: () => socket,
      timeoutMs,
    });
    const connecting = t.connect();
    socket.open();
    await connecting;
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor: 0 });
    socket.reply(ready());
    await hello;
    return t;
  }

  it("commits a put whose ack arrives from inside the last send", async () => {
    const socket = new InstantSocket();
    socket.answer = { res: "ack", uid: 7 };
    socket.after = 2;
    const t = await rig(socket);
    const put = t.put(
      "p",
      { size: 2, ctime: 0, mtime: 0 },
      [one.name, two.name],
      async (n) => (n === one.name ? one.bytes : two.bytes),
      noBase,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name, two.name] });
    expect(await put).toMatchObject({ uid: 7, uploaded: 2 });
    expect(t.isClosed).toBe(false);
  });

  it("commits a batch whose acks arrive from inside the last send", async () => {
    const socket = new InstantSocket();
    socket.answer = { res: "acks", results: [{ uid: 3 }, { uid: 4 }] };
    socket.after = 2;
    const t = await rig(socket);
    const entry = (path: string, name: string) => ({
      path,
      meta: { size: 1, ctime: 0, mtime: 0 },
      names: [name],
    });
    const putting = t.putMany([entry("p", one.name), entry("q", two.name)], async (n) =>
      n === one.name ? one.bytes : two.bytes,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name, two.name] });
    const out = await putting;
    expect(out.results.map((r) => r.uid)).toEqual([3, 4]);
    expect(t.isClosed).toBe(false);
  });

  it("commits a put whose ack arrives while the socket buffer is still draining", async () => {
    const socket = new DrainingSocket();
    socket.answer = { res: "ack", uid: 8 };
    socket.after = 1;
    socket.stepBytes = 1;
    socket.stepMs = 5;
    const t = await rig(socket);
    const body = new Uint8Array(20);
    const put = t.put("p", { size: 20, ctime: 0, mtime: 0 }, [one.name], async () => body, noBase);
    await settle();
    socket.reply({ res: "want", chunks: [one.name] });
    // The bytes counted are the frame's, which is what went on the wire.
    expect(await put).toMatchObject({ uid: 8, uploaded: 1, bytes: encodeFrame(body).length });
    expect(t.isClosed).toBe(false);
  });

  it("does not time out an upload that drains slowly but steadily", async () => {
    // The drain takes several timeouts; every step is progress, and the ack
    // clock starts only once the last byte has left.
    const socket = new DrainingSocket();
    socket.answer = { res: "ack", uid: 9 };
    socket.after = 1;
    socket.stepBytes = 1;
    socket.stepMs = 10;
    const t = await rig(socket, 100);
    // 410 ms of drain against a 100 ms timeout. Incompressible, because a
    // frame of forty zeroes is a few bytes and would drain inside one.
    const body = noise(40);
    const put = t.put("p", { size: 40, ctime: 0, mtime: 0 }, [one.name], async () => body, noBase);
    await settle();
    socket.reply({ res: "want", chunks: [one.name] });
    expect(await put).toMatchObject({ uid: 9, uploaded: 1 });
    expect(t.isClosed).toBe(false);
  });

  it("still closes when the buffer stops moving for a whole timeout", async () => {
    const socket = new DrainingSocket();
    socket.answer = { res: "ack", uid: 9 };
    socket.after = 99; // never answers
    socket.stepBytes = 0; // never drains
    const t = await rig(socket, 100);
    const put = t.put(
      "p",
      { size: 4, ctime: 0, mtime: 0 },
      [one.name],
      async () => new Uint8Array(4),
      noBase,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name] });
    await expect(put).rejects.toThrow(/stalled/);
    expect(t.isClosed).toBe(true);
  });
});

describe("errors", () => {
  it("raises a refusal rather than returning it as a reply", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({ res: "err", code: "nouid", msg: "no entry 1" });
    await expect(get).rejects.toMatchObject({ code: "nouid", message: "no entry 1" });
    // Not fatal, so the session lives.
    expect(t.isClosed).toBe(false);
  });

  it("closes the session on a fatal refusal and leaves it closed", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({ res: "err", code: "protostate", msg: "we disagree" });
    await expect(get).rejects.toMatchObject({ code: "protostate" });
    expect(t.isClosed).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it("knows which codes end a session", () => {
    for (const code of ["proto", "auth", "cursor", "busy", "protostate", "nospace", "internal"]) {
      expect(new ProtocolError(code, "x").endsSession, code).toBe(true);
    }
    // `rotated` ended one in Basalt; protocol 1 has no rotation and no such
    // code. The path and collision refusals reject an entry and no more.
    for (const code of [
      "badentry",
      "badname",
      "toolarge",
      "nouid",
      "nocontent",
      "nochunk",
      "badpath",
      "collision",
      "stale",
      "rotated",
    ]) {
      expect(new ProtocolError(code, "x").endsSession, code).toBe(false);
    }
  });

  /**
   * review finding I2. Whether a loop retries is the server's `retryable`, read
   * off the frame, and the code table stands in only for an error that
   * arrived before the protocol was settled and so has no field.
   */
  it("takes retryable from the frame when it is there, and from the code only when it is not", () => {
    expect(new ProtocolError("busy", "x", { retryable: false }).fatal).toBe(true);
    expect(new ProtocolError("badname", "x", { retryable: true }).fatal).toBe(false);
    for (const code of ["busy", "nospace", "internal"]) {
      expect(new ProtocolError(code, "x").fatal, `${code} with no field`).toBe(false);
    }
    for (const code of ["proto", "auth", "cursor", "protostate", "badchunk", "toolarge"]) {
      expect(new ProtocolError(code, "x").fatal, `${code} with no field`).toBe(true);
    }
  });

  it("carries the server's retry hint on a refusal in reply", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({
      res: "err",
      code: "busy",
      msg: "8 devices connected",
      retryable: true,
      retryAfterMs: 30_000,
    });
    await expect(get).rejects.toMatchObject({
      code: "busy",
      retryable: true,
      retryAfterMs: 30_000,
      fatal: false,
    });
    expect(t.isClosed, "busy ends the session").toBe(true);
  });

  it("refuses a frame that is not JSON", async () => {
    const { t, socket } = await helloed(0);
    socket.onmessage?.({ data: "this is not json" });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("refuses a reply nobody asked for", async () => {
    const { t, socket } = await helloed(0);
    socket.reply({ res: "pong" });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  /**
   * On shutdown the server sends every idle session
   * `{res:"err", code:"busy"}` and then closes it. Read as a stray reply this
   * was a protocol violation, so every plugin attached to a restarting server
   * went to "stopped" instead of waiting for it to come back.
   */
  describe("an error frame nobody asked for", () => {
    async function idle() {
      const socket = new FakeSocket();
      let cause: Error | undefined;
      const t = new Transport("ws://test", {
        onBatch: () => {},
        onClosed: (c) => {
          cause = c;
        },
        socketFactory: () => socket,
        timeoutMs: 1000,
      });
      const connecting = t.connect();
      socket.open();
      await connecting;
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor: 0 });
      socket.reply(ready({ cursor: 0 }));
      await hello;
      return { t, socket, cause: () => cause };
    }

    it("takes busy as the connection ending, which a loop retries after the hint", async () => {
      const { t, socket, cause } = await idle();
      socket.raw({
        res: "err",
        code: "busy",
        msg: "this server is shutting down",
        retryable: true,
        retryAfterMs: 5000,
      });
      await settle();
      expect(t.isClosed).toBe(true);
      expect(cause()).toBeInstanceOf(ProtocolError);
      expect((cause() as ProtocolError).fatal, "a shutdown notice must not stop the loop").toBe(
        false,
      );
      expect((cause() as ProtocolError).retryAfterMs).toBe(5000);
      expect(cause()!.message).toMatch(/shutting down/);
    });

    it("takes a refusal that would repeat as fatal, as it would be in reply", async () => {
      for (const code of ["proto", "auth", "cursor", "protostate"]) {
        const { t, socket, cause } = await idle();
        socket.raw({ res: "err", code, msg: "no", retryable: false });
        await settle();
        expect(t.isClosed, code).toBe(true);
        expect(cause(), code).toBeInstanceOf(ProtocolError);
        expect((cause() as ProtocolError).code).toBe(code);
        expect((cause() as ProtocolError).fatal, code).toBe(true);
      }
    });

    it("reads a shutdown notice with no retryable field by its code, which is how one arrives before ready", async () => {
      const { t, socket, cause } = await idle();
      socket.raw({ res: "err", code: "busy", msg: "shutting down" });
      await settle();
      expect(t.isClosed).toBe(true);
      expect((cause() as ProtocolError).fatal).toBe(false);
    });
  });

  it("fails everything waiting when the connection goes away", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.hangUp();
    await expect(get).rejects.toBeInstanceOf(ConnectionError);
    expect(t.isClosed).toBe(true);
  });

  it("reports itself closed after being closed", async () => {
    const { t } = await helloed(0);
    expect(t.isClosed).toBe(false);
    t.close();
    expect(t.isClosed).toBe(true);
    await expect(t.get(1)).rejects.toBeInstanceOf(ConnectionError);
  });

  /**
   * review finding I1. Two requests in flight used to be refused, because a
   * reply was matched to the one request in flight by position. Every reply
   * now echoes the id it answers, so the answers can arrive in any order and
   * each caller gets its own.
   */
  it("matches two replies in flight to their requests by id, whatever order they come in", async () => {
    const { t, socket } = await helloed(0);
    const first = t.get(1);
    const second = t.get(2);
    await settle();
    const [askOne, askTwo] = socket.sentText.slice(-2) as Record<string, unknown>[];
    expect(askOne!["id"]).not.toBe(askTwo!["id"]);
    socket.reply({ res: "chunks", id: askTwo!["id"], uid: 2, size: 0, chunks: [] });
    socket.reply({ res: "chunks", id: askOne!["id"], uid: 1, size: 0, chunks: [] });
    expect((await first).uid).toBe(1);
    expect((await second).uid).toBe(2);
    expect(t.isClosed).toBe(false);
  });

  it("gives every request a fresh id", async () => {
    const { t, socket } = await helloed(0);
    for (let i = 0; i < 5; i++) {
      const get = t.get(i + 1);
      await settle();
      socket.reply({ res: "chunks", uid: i + 1, size: 0, chunks: [] });
      await get;
    }
    const ids = socket.sentText.map((m) => m["id"]).filter((id) => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6); // the hello and five gets
  });

  it("ends the session on a reply to a request it does not have in flight", async () => {
    // The server never sends an id it was not given, so an unknown one means
    // the two ends disagree about state, and the protocol says to stop.
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({ res: "chunks", id: 999, uid: 1, size: 0, chunks: [] });
    await expect(get).rejects.toMatchObject({ code: "protostate" });
    expect(t.isClosed).toBe(true);
  });

  it("carries a put's id on its want and its ack", async () => {
    const { t, socket } = await helloed(0);
    const name = "a".repeat(64);
    const put = t.put(
      "p",
      { size: 1, ctime: 0, mtime: 0 },
      [name],
      async () => new Uint8Array([1]),
      noBase,
    );
    await settle();
    const id = socket.sentText.at(-1)!["id"];
    socket.reply({ res: "want", id, chunks: [name] });
    await settle();
    socket.reply({ res: "ack", id, uid: 4 });
    expect(await put).toMatchObject({ uid: 4 });
  });

  it("sends pings with no id, and takes the pong without one", async () => {
    const { t, socket } = await helloed(0);
    const ping = t.ping();
    await settle();
    expect("id" in socket.sentText.at(-1)!).toBe(false);
    socket.raw({ res: "pong" });
    await expect(ping).resolves.toBeUndefined();
  });

  it("closes the connection when a request goes unanswered", async () => {
    // The request may have been received and acted on, so the session's state
    // is unknown, and continuing on an unknown state is how two ends desync.
    vi.useFakeTimers();
    try {
      const { t, socket } = await connected({ timeoutMs: 50 });
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
      const rejected = expect(hello).rejects.toBeInstanceOf(ConnectionError);
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `connect` waited for the socket to open with no deadline, so
 * a server that accepted the TCP connection and never completed the handshake,
 * or a firewall that swallowed it, left the client hanging for as long as the
 * platform cared to wait, and the CLI held the vault's lock for the whole of it.
 */
describe("a connection that never opens", () => {
  it("gives up within the timeout and closes the socket", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const t = new Transport("ws://test", {
        onBatch: () => {},
        socketFactory: () => socket,
        timeoutMs: 50,
      });
      const connecting = t.connect();
      const rejected = expect(connecting).rejects.toThrow(
        /no connection to ws:\/\/test within 50ms/,
      );
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // A device reaches whatever address its invite names, and nothing takes an
  // address in its place, so the advice for a wss:// address with no TLS in
  // front is an invite naming ws://, which the server makes: the hint used to
  // say to "pair with ws://...", which no command or panel field can do.
  it("says to make an invite naming ws:// when wss:// cannot connect", async () => {
    const socket = new FakeSocket();
    const t = new Transport("wss://127.0.0.1:3003", {
      onBatch: () => {},
      socketFactory: () => socket,
      timeoutMs: 1000,
    });
    const connecting = t.connect();
    socket.onerror?.(undefined);
    const message = ((await connecting.catch((err: Error) => err)) as Error).message;
    expect(message).toContain("could not connect to wss://127.0.0.1:3003");
    expect(message).toContain("trewd invite -url ws://127.0.0.1:3003");
    expect(message).not.toContain("pair with ws://");
  });
});

describe("bodies", () => {
  it("keeps bodies that arrive before anything asks for them", async () => {
    // The server streams a fetch as binary frames with no reply in front, so
    // they can land before the loop that reads them. Dropping one loses a
    // chunk and the file it belongs to.
    const { t, socket } = await helloed(0);
    const one = await named(new Uint8Array([7]));
    const two = await named(new Uint8Array([8]));
    const fetching = t.fetch([one.name, two.name]);
    await settle();
    socket.bodies(one.body, two.body);
    const bodies = await fetching;
    expect(bodies.map((b) => b[0])).toEqual([7, 8]);
  });

  it("returns as many bodies as it asked for", async () => {
    const { t, socket } = await helloed(0);
    const parts = await Promise.all([1, 2, 3].map((n) => named(new Uint8Array([n]))));
    const fetching = t.fetch(parts.map((p) => p.name));
    await settle();
    socket.bodies(...parts.map((p) => p.body));
    expect(await fetching).toHaveLength(3);
  });

  it("expects the bodies header to announce exactly the number asked for", async () => {
    const { t, socket } = await helloed(0);
    const fetching = t.fetch(["a".repeat(64), "b".repeat(64)]);
    await settle();
    socket.reply({ res: "bodies", count: 1 });
    await expect(fetching).rejects.toMatchObject({ code: "protostate" });
    expect(t.isClosed).toBe(true);
  });

  it("refuses a body that arrives with no header in front of it", async () => {
    const { t, socket } = await helloed(0);
    const one = await named(new Uint8Array([7]));
    const fetching = t.fetch([one.name]);
    await settle();
    socket.body(one.body);
    await expect(fetching).rejects.toBeInstanceOf(Error);
    expect(t.isClosed).toBe(true);
  });

  /**
   * Bodies arrive as bare binary frames with nothing tying them to a request,
   * so the only thing connecting one to a name is the order it came in. A body
   * left over from an abandoned fetch would be taken by the next one, decode
   * perfectly, being a real chunk of a real file, and be assembled into the
   * wrong note. The name is a hash of exactly those bytes, so this is exact.
   */
  it("refuses a body that is not the one it asked for", async () => {
    const { t, socket } = await helloed(0);
    const wanted = await named(new Uint8Array([1, 2, 3]));
    const other = await named(new Uint8Array([9, 9, 9]));
    const fetching = t.fetch([wanted.name]);
    await settle();
    socket.bodies(other.body);
    await expect(fetching).rejects.toMatchObject({ code: "badchunk" });
    // The stream no longer says what it is answering, so there is nothing to
    // carry on to.
    expect(t.isClosed).toBe(true);
  });

  it("refuses a body nobody asked for", async () => {
    // Unbounded queueing would make this a way to exhaust the device's
    // memory, and a body outside a fetch means the two ends no longer agree
    // about what is being answered.
    const { t, socket } = await helloed(0);
    socket.body(new Uint8Array([1, 2, 3]));
    await settle();
    expect(t.isClosed).toBe(true);
  });

  /**
   * A fetch was once answered in bare bodies, so
   * a body left over from a refused one was consumed as the answer to the
   * next. The `bodies` header removes the class: a fetch is answered by the
   * header and exactly that many frames, or by an error and none, so there
   * is never a leftover, and a body with no header is a protocol fault.
   */
  it("does not let one fetch inherit the bodies of another", async () => {
    const { t, socket } = await helloed(0);
    const wanted = await named(new Uint8Array([4, 5, 6]));
    const stale = await named(new Uint8Array([7, 8, 9]));

    // A fetch is refused. No bodies follow a refusal.
    const abandoned = t.fetch([stale.name, wanted.name]);
    await settle();
    socket.reply({ res: "err", code: "nochunk", msg: "gone", retryable: false });
    await expect(abandoned).rejects.toMatchObject({ code: "nochunk" });
    expect(t.isClosed).toBe(false);

    // The next fetch is answered on its own terms.
    const next = t.fetch([wanted.name]);
    await settle();
    socket.bodies(wanted.body);
    expect((await next)[0]).toEqual(wanted.body);

    // And a body arriving outside any fetch, which a misbehaving server
    // could still send, ends the session rather than being kept for the
    // next question.
    socket.body(stale.body);
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("raises a refusal that arrives instead of the bodies", async () => {
    const { t, socket } = await helloed(0);
    const fetching = t.fetch(["a".repeat(64)]);
    await settle();
    socket.reply({ res: "err", code: "nochunk", msg: "not held", retryable: false });
    await expect(fetching).rejects.toMatchObject({ code: "nochunk" });
  });

  it("asks for nothing when given nothing", async () => {
    const { t, socket } = await helloed(0);
    expect(await t.fetch([])).toEqual([]);
    expect(socket.sentText).toHaveLength(1); // the hello, and nothing more
  });
});

/**
 * Success replies were read leniently: a missing or non-numeric
 * uid became zero and was committed to the index as a version, and a `want`
 * with a malformed member dropped it and carried on. Every field a reply is
 * acted on has one shape, and anything else ends the session.
 */
describe("a success reply that is not the shape it should be", () => {
  const name = "a".repeat(64);
  const bad = [undefined, 0, -1, "5", 1.5, null, Number.MAX_SAFE_INTEGER + 1];

  it("refuses a have whose uid is not a version number", async () => {
    for (const uid of bad) {
      const { t, socket } = await helloed(0);
      const put = t.put(
        "p",
        { size: 1, ctime: 0, mtime: 0 },
        [name],
        async () => new Uint8Array(1),
        noBase,
      );
      await settle();
      socket.reply({ res: "have", ...(uid === undefined ? {} : { uid }) });
      await expect(put, `uid ${String(uid)}`).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed, `uid ${String(uid)}`).toBe(true);
    }
  });

  it("refuses an ack whose uid is not a version number", async () => {
    for (const uid of bad) {
      const { t, socket } = await helloed(0);
      const put = t.put(
        "p",
        { size: 1, ctime: 0, mtime: 0 },
        [name],
        async () => new Uint8Array(1),
        noBase,
      );
      await settle();
      socket.reply({ res: "want", chunks: [name] });
      await settle();
      socket.reply({ res: "ack", ...(uid === undefined ? {} : { uid }) });
      await expect(put, `uid ${String(uid)}`).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a want that names a chunk twice, or names something that is not a chunk", async () => {
    for (const chunks of [[name, name], [name, 7], [name, "not-hex"], "nope", undefined]) {
      const { t, socket } = await helloed(0);
      const put = t.put(
        "p",
        { size: 1, ctime: 0, mtime: 0 },
        [name],
        async () => new Uint8Array(1),
        noBase,
      );
      await settle();
      socket.reply({ res: "want", ...(chunks === undefined ? {} : { chunks }) });
      await expect(put, JSON.stringify(chunks)).rejects.toBeInstanceOf(ProtocolError);
      expect(t.isClosed).toBe(true);
      expect(socket.sentBinary, "sent bodies for a want it refused").toHaveLength(0);
    }
  });

  it("refuses acks whose results carry no version number", async () => {
    const entry = {
      path: "p",
      meta: { size: 0, ctime: 0, mtime: 0 },
      names: [],
    };
    for (const results of [[{ uid: 0 }], [{}], [{ uid: "3" }], [null], [{ code: 7 }]]) {
      const { t, socket } = await helloed(0);
      const putting = t.putMany([entry], async () => new Uint8Array(0));
      await settle();
      socket.reply({ res: "acks", results });
      await expect(putting, JSON.stringify(results)).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a chunks answer with a bad uid, size or chunk list", async () => {
    for (const reply of [
      { res: "chunks", uid: 0, size: 1, chunks: [name] },
      { res: "chunks", uid: 3, size: -1, chunks: [name] },
      { res: "chunks", uid: 3, size: 1.5, chunks: [name] },
      { res: "chunks", uid: 3, size: 1, chunks: [name, 4] },
      { res: "chunks", uid: 3, size: 1 },
    ]) {
      const { t, socket } = await helloed(0);
      const get = t.get(3);
      await settle();
      socket.reply(reply);
      await expect(get, JSON.stringify(reply)).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a ready whose limits are not counts", async () => {
    for (const field of [
      "cursor",
      "perFileMax",
      "chunkMax",
      "maxChunks",
      "maxBatchBytes",
      "maxFetchBytes",
      "minProto",
    ]) {
      const { t, socket } = await connected();
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor: 0 });
      socket.reply(ready({ [field]: "lots" }));
      await expect(hello, field).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a history or deleted list holding a version nobody could act on", async () => {
    for (const entry of [
      { path: "p", chunks: [] },
      { uid: 0, path: "p", chunks: [] },
      { uid: 2, chunks: [] },
      { uid: 2, path: "p" },
    ]) {
      const { t, socket } = await helloed(0);
      const asking = t.history("p");
      await settle();
      socket.reply({ res: "history", entries: [entry] });
      await expect(asking, JSON.stringify(entry)).rejects.toMatchObject({ code: "protostate" });
    }
  });

  it("still takes every well-formed answer", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(3);
    await settle();
    socket.reply({ res: "chunks", uid: 3, size: 0, chunks: [] });
    expect(await get).toEqual({ uid: 3, size: 0, chunks: [] });
  });
});

describe("reconnect pacing", () => {
  it("does not wait at all before the first attempt", () => {
    expect(new Backoff(0, 300_000, 5_000, false).delay()).toBe(0);
  });

  it("doubles, and stops at the ceiling", () => {
    const b = new Backoff(0, 300_000, 5_000, false);
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      b.fail();
      seen.push(b.delay());
    }
    expect(seen.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(Math.max(...seen)).toBe(300_000);
    expect(seen.at(-1)).toBe(300_000);
  });

  it("jitters between half and all of the delay", () => {
    // Not decoration: a server restarting with several devices attached would
    // otherwise have all of them return at the same instant, fail together,
    // and come back together.
    const lowest = new Backoff(0, 300_000, 5_000, true, () => 0);
    const highest = new Backoff(0, 300_000, 5_000, true, () => 1);
    lowest.fail();
    highest.fail();
    expect(lowest.delay()).toBe(2_500);
    expect(highest.delay()).toBe(5_000);
  });

  it("forgets its failures on success", () => {
    const b = new Backoff(0, 300_000, 5_000, false);
    b.fail();
    b.fail();
    expect(b.delay()).toBe(10_000);
    b.success();
    expect(b.delay()).toBe(0);
  });

  it("waits at least the floor, however the last attempt went", () => {
    const b = new Backoff(1_000, 300_000, 5_000, false);
    expect(b.delay()).toBe(1_000);
    b.success();
    expect(b.delay()).toBe(1_000);
    b.fail();
    expect(b.delay()).toBe(6_000);
  });
});

/**
 * Recovery is the one place where "there is nothing" and "I could not tell" are
 * most easily confused, and where confusing them costs most: somebody is
 * looking for a note they have lost.
 */
describe("recovery answers from a server that answers badly", () => {
  it("asks with the path and reads back what it is given", async () => {
    // The path itself, as the vault spells it: protocol 1 carries plaintext.
    const path = "Notes/a note, as it is spelled.md";
    const { t, socket } = await helloed();
    const asked = t.history(path, { before: 40, limit: 5 });
    await settle();
    expect(socket.sentText.at(-1)).toMatchObject({
      op: "history",
      path,
      before: 40,
      limit: 5,
    });

    socket.reply({
      res: "history",
      path,
      entries: [
        { uid: 3, path, chunks: [] },
        { uid: 2, path, chunks: [] },
      ],
    });
    expect((await asked).map((e) => e.uid)).toEqual([3, 2]);
  });

  it("omits paging fields it was not given, rather than sending zeroes", async () => {
    // Zero means "start at the newest" to the server, which is the same
    // thing, but sending a limit of zero would ask for the default and look
    // deliberate. Absent is the honest way to say nothing was specified.
    const { t, socket } = await helloed();
    // Caught and closed, because this reply never comes.
    //
    // `void` on its own leaves a request armed with a one-second clock and a
    // promise nobody is holding. A second later the timer closes the transport
    // and rejects it, and by then this test is over, so the rejection is
    // unhandled and belongs to whatever is running instead. It never fired
    // here -- the suite finishes first -- and it failed CI three runs in a row
    // as `ConnectionError: no history within 1000ms`, blamed on an unrelated
    // test in another file. Only the loaded runner was slow enough to see it.
    const never = t.history("p");
    never.catch(() => {});
    await settle();
    const sent = socket.sentText.at(-1)!;
    expect("before" in sent).toBe(false);
    expect("limit" in sent).toBe(false);
    t.close();
  });

  /**
   * The one that matters. A reply with no entries field, or a null one, must
   * not become "nothing was deleted": that is the answer somebody acts on by
   * concluding their note is unrecoverable.
   */
  it("carries the server saying the list was cut short", async () => {
    // Dropping this hands somebody a short list that looks complete, and
    // the note they are looking for is exactly the one that might be
    // missing from it.
    const { t, socket } = await helloed();
    const asked = t.deleted(2);
    await settle();
    expect(socket.sentText.at(-1)).toMatchObject({ op: "deleted", limit: 2 });
    socket.reply({
      res: "deleted",
      entries: [
        { uid: 9, path: "p", chunks: [] },
        { uid: 8, path: "q", chunks: [] },
      ],
      more: true,
    });
    expect((await asked).more).toBe(true);
  });

  it("refuses an answer with no list in it rather than reading it as empty", async () => {
    for (const bad of [
      { res: "deleted" },
      { res: "deleted", entries: null },
      { res: "deleted", entries: "none" },
      { res: "deleted", entries: 0 },
    ]) {
      const { t, socket } = await helloed();
      const asked = t.deleted();
      await settle();
      socket.reply(bad);
      await expect(asked, JSON.stringify(bad)).rejects.toThrow(/without a list of entries/);
    }
  });

  it("refuses a history answer with no list in it", async () => {
    const { t, socket } = await helloed();
    const asked = t.history("p");
    await settle();
    socket.reply({ res: "history", path: "p", entries: null });
    await expect(asked).rejects.toThrow(/without a list of entries/);
  });

  it("refuses an answer to a question it did not ask", async () => {
    const { t, socket } = await helloed();
    const asked = t.deleted();
    await settle();
    socket.reply({ res: "chunks", uid: 1, size: 0, chunks: [] });
    await expect(asked).rejects.toThrow(/expected deleted/);
  });

  it("passes on a refusal rather than reporting an empty vault", async () => {
    const { t, socket } = await helloed();
    const asked = t.history("p");
    await settle();
    socket.reply({ res: "err", code: "internal", msg: "could not read history" });
    await expect(asked).rejects.toThrow(/could not read history/);
  });

  it("accepts an empty list, which is the ordinary answer", async () => {
    const { t, socket } = await helloed();
    const asked = t.deleted();
    await settle();
    socket.reply({ res: "deleted", entries: [] });
    expect(await asked).toEqual({ entries: [], more: false });
  });
});

/**
 * A device is told at hello what the server will store. Nothing used to hold
 * the server to it on the way back: a chunk list is a number the server
 * chooses, and a device that fetches and buffers however many are named runs
 * out of memory on a corrupt row as readily as on a hostile one.
 */
describe("a download against what the server said it would store", () => {
  it("refuses a version naming more chunks than the server stores", async () => {
    const { engine, socket } = await engineOnFakeSocket({ maxChunks: 4 });
    const asked = engine.contentOf(1);
    await settle();
    socket.reply({
      res: "chunks",
      uid: 1,
      size: 10,
      chunks: Array.from({ length: 5 }, (_, i) => `${i}`.repeat(64)),
    });
    await expect(asked).rejects.toThrow(/stores at most 4/);
  });

  it("accepts one within the limit", async () => {
    const { engine, socket } = await engineOnFakeSocket({ maxChunks: 4 });
    const body = new Uint8Array([1, 2, 3]);
    const name = await chunkName(body);
    const asked = engine.contentOf(1);
    await settle();
    socket.reply({ res: "chunks", uid: 1, size: 3, chunks: [name] });
    await settle();
    socket.bodies(body);
    // Past the bound, and all the way to the bytes.
    expect(await asked).toEqual(body);
  });
});

/**
 * A server may advertise a smaller chunk ceiling than this client's own idea of
 * one, and the client has to cut to it. `sizesFor` took the parameter and the
 * engine never passed it, so a smaller ceiling was ignored and every chunk at
 * the boundary was refused, permanently, for any file that did not compress.
 */
describe("cutting to the ceiling the server advertised", () => {
  it("sends no body larger than the server said it would take", async () => {
    const ceiling = 64 * 1024;
    const { engine, socket, vault } = await engineOnFakeSocket({ chunkMax: ceiling });

    const bytes = new Uint8Array(1024 * 1024);
    for (let at = 0; at < bytes.length; at += 65536) {
      crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, bytes.length)));
    }
    await vault.write("clip.raw", bytes, { mtime: 1000, ctime: 1000 });

    const syncing = engine.sync();
    // Chunking and naming a megabyte takes real time, so this waits for the
    // put rather than for one turn of the event loop.
    for (let i = 0; i < 200 && !socket.sentText.some((m) => m["op"] === "putmany"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The put names its chunks; the server asks for all of them.
    const put = socket.sentText.find((m) => m["op"] === "putmany");
    expect(
      put,
      `nothing was put: ${JSON.stringify(socket.sentText.map((m) => m["op"]))}`,
    ).toBeDefined();
    const entries = put!["entries"] as { chunks: string[] }[];
    const names = entries.flatMap((e) => e.chunks);
    expect(names.length, "a 1 MiB file was not cut to a 64 KiB ceiling").toBeGreaterThan(8);

    socket.reply({ res: "want", chunks: names });
    await settle();
    socket.reply({ res: "acks", results: entries.map((_, i) => ({ uid: i + 1 })) });
    await syncing.catch(() => undefined);

    // The ceiling bounds the raw chunk, and a frame is one marker byte more
    // (plan/protocol.md, "Chunk bodies"), so the two are held to their own
    // numbers: a chunk over the ceiling is refused at the server however it
    // is framed, and a frame over the ceiling plus one is refused before it
    // is looked at.
    expect(socket.sentBinary.length, "no body went up, so this proves nothing").toBe(names.length);
    const worst = Math.max(...socket.sentBinary.map((b) => opened(b).length));
    expect(
      worst,
      `the largest chunk sent was ${worst} against a ceiling of ${ceiling}`,
    ).toBeLessThanOrEqual(ceiling);
    const widest = Math.max(...socket.sentBinary.map((b) => b.length));
    expect(widest, `the largest frame sent was ${widest}`).toBeLessThanOrEqual(ceiling + 1);
  });
});

/**
 * A fetch is answered in binary frames, not with a reply, so the timeout armed
 * for that reply is waiting for something that will never come. Left running it
 * fires later, in the middle of a sync, and closes the connection.
 *
 * On loopback a sync finishes long before any timeout, which is why this went
 * unnoticed. Adding four hundred milliseconds of latency to the benchmark made
 * every large sync die exactly one timeout after its first fetch, with most of
 * the vault missing and the client reporting that it had finished.
 */
describe("the timeout a fetch leaves behind", () => {
  it("closes an idle socket promptly when a resume probe gets no response", async () => {
    const { t } = await helloed();
    vi.useFakeTimers();
    const result = expect(t.probe(20)).rejects.toThrow("after resuming");
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(t.isClosed).toBe(true);
  });

  it("does not apply the short resume timeout to an active transfer", async () => {
    const { t, socket } = await helloed();
    const body = new Uint8Array([1, 2, 3]);
    const name = await chunkName(body);
    vi.useFakeTimers();
    const fetch = t.fetch([name]);
    const probe = t.probe(20);
    await vi.advanceTimersByTimeAsync(50);
    expect(t.isClosed).toBe(false);
    socket.bodies(body);
    socket.reply({ res: "pong" });
    expect(await fetch).toEqual([body]);
    await probe;
    t.close();
  });
  it("shares a ping between resume and the periodic keepalive", async () => {
    const { t, socket } = await helloed();
    try {
      const first = t.ping();
      const second = t.ping();
      const result = Promise.all([first, second]);
      socket.reply({ res: "pong" });
      await expect(result).resolves.toEqual([undefined, undefined]);
    } finally {
      t.close();
    }
  });
  it("does not close the connection some time after a fetch succeeded", async () => {
    const { t, socket } = await helloed(0, { timeoutMs: 120 });
    const body = new Uint8Array([1, 2, 3]);
    const name = await chunkName(body);

    vi.useFakeTimers();
    const fetching = t.fetch([name]);

    socket.bodies(body);
    expect(await fetching).toHaveLength(1);

    // Well past the timeout that was armed for the reply.
    await vi.advanceTimersByTimeAsync(300);
    expect(t.isClosed, "the connection died after a fetch that had already succeeded").toBe(false);

    // And it is still usable, which is the property that matters.
    const pinging = t.ping();

    socket.reply({ res: "pong" });
    await expect(pinging).resolves.toBeUndefined();
  });

  it("does not leave one behind when a fetch fails either", async () => {
    const { t, socket } = await helloed(0, { timeoutMs: 120 });
    vi.useFakeTimers();
    const fetching = t.fetch(["a".repeat(64)]);

    socket.reply({ res: "err", code: "nochunk", msg: "not held", retryable: false });
    await expect(fetching).rejects.toMatchObject({ code: "nochunk" });

    await vi.advanceTimersByTimeAsync(300);
    // A refusal is not a reason to close, and the timer must not make it one.
    const pinging = t.ping();

    socket.reply({ res: "pong" });
    await expect(pinging).resolves.toBeUndefined();
  });
});

/**
 * A batch that lost its entries must not look like a batch that had none.
 *
 * The decoder read an absent or null `entries` as `[]`. A frame mangled by a
 * proxy, or written by a future server with a bug, therefore passed the
 * continuity check, applied nothing, and advanced the cursor over real
 * versions. On reconnect the client resumed after them and never fetched them
 * again: notes missing for ever, with the client reporting success throughout.
 *
 * Empty stays legal. That is how a device receives its own committed write,
 * with the cursor advance and no payload, and refusing it would break every
 * push this device makes.
 */
describe("a batch frame that cannot be trusted", () => {
  const badFrames: { why: string; frame: Record<string, unknown> }[] = [
    { why: "no entries field at all", frame: { op: "batch", from: 1, to: 3 } },
    { why: "a null entries field", frame: { op: "batch", from: 1, to: 3, entries: null } },
    { why: "entries that is not an array", frame: { op: "batch", from: 1, to: 3, entries: {} } },
    {
      why: "an entry with no uid, which slips past a range check",
      frame: { op: "batch", from: 1, to: 3, entries: [{ path: "p", chunks: [] }] },
    },
    {
      why: "an entry with no path",
      frame: { op: "batch", from: 1, to: 3, entries: [{ uid: 2, chunks: [] }] },
    },
    {
      // The wire path is the name in protocol 1, so an empty one names no file.
      why: "an entry whose path is empty",
      frame: { op: "batch", from: 1, to: 3, entries: [{ uid: 2, path: "", chunks: [] }] },
    },
    {
      why: "an entry with no chunks array",
      frame: { op: "batch", from: 1, to: 3, entries: [{ uid: 2, path: "p" }] },
    },
  ];

  for (const { why, frame } of badFrames) {
    it(`refuses ${why} rather than advancing the cursor`, async () => {
      const { socket, batches } = await helloed(0);
      socket.reply(frame);
      await settle();

      expect(batches, "a malformed batch was applied").toHaveLength(0);
      expect(socket.closed, "a batch nobody can interpret has to end the session").toBe(true);
    });
  }

  it("still accepts an empty batch, which is how a device sees its own write", async () => {
    const { socket, batches } = await helloed(0);
    socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
    await settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]!.entries).toEqual([]);
    expect(socket.closed).toBe(false);

    // The cursor is not readable from outside, so it is observed the way it
    // matters: the next contiguous batch is accepted, which it could only
    // be if the empty one advanced it to 1.
    socket.reply({ op: "batch", from: 2, to: 2, entries: [] });
    await settle();
    expect(batches).toHaveLength(2);
    expect(socket.closed).toBe(false);
  });
});

/**
 * review finding I3. `ready` carries two caps on a batched write, the encoded
 * frame and the summed size budget, and one on a fetch. The engine used
 * a constant of its own, so a server advertising something smaller was ignored
 * and the batch refused with `toolarge`, which the engine reads as permanent
 * and wrote every note in the batch off for good.
 */
describe("keeping to the caps the server advertised", () => {
  /** A server that takes whatever is put and acknowledges it, one uid per entry. */
  function acceptEverything(socket: FakeSocket): void {
    let uid = 0;
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "putmany") {
        const entries = frame["entries"] as unknown[];
        s.reply({ res: "acks", id: frame["id"], results: entries.map(() => ({ uid: ++uid })) });
      } else if (frame["op"] === "put") {
        s.reply({ res: "have", id: frame["id"], uid: ++uid });
      } else if (frame["op"] === "ping") {
        s.raw({ res: "pong" });
      }
    };
  }

  /** Every putmany frame this socket saw, with its encoded size and summed budget. */
  function batches(socket: FakeSocket) {
    return socket.sentText
      .filter((m) => m["op"] === "putmany")
      .map((m) => {
        const entries = m["entries"] as { meta: { size: number }; chunks: string[] }[];
        return {
          count: entries.length,
          encoded: new TextEncoder().encode(JSON.stringify(m)).length,
          budget: entries.reduce((n, e) => n + entryBudget(e.meta.size), 0),
        };
      });
  }

  it("counts an entry at its declared size, which is what the server adds up", () => {
    // The sum of its chunks' raw lengths (plan/protocol.md, "Limits"). Basalt
    // added an allowance per chunk for the sealing it charged, and there is
    // none now.
    expect(entryBudget(0)).toBe(0);
    expect(entryBudget(4096)).toBe(4096);
  });

  it("splits a batched write by the summed budget cap", async () => {
    const cap = 6000;
    const { engine, socket, vault } = await engineOnFakeSocket({ maxBatchBytes: cap });
    acceptEverything(socket);
    // Each note is one chunk of about 400 bytes, and costs exactly that, so
    // fifteen fit under the cap and thirty need more than one batch.
    for (let i = 0; i < 30; i++) {
      await vault.edit(`note-${String(i).padStart(2, "0")}.md`, `note ${i}\n${"x".repeat(390)}\n`);
    }
    const report = await engine.sync();
    expect(report.uploaded).toBe(30);
    expect(report.skipped).toBe(0);
    const sent = batches(socket);
    expect(sent.length, JSON.stringify(sent)).toBeGreaterThan(1);
    for (const b of sent) {
      expect(b.budget, `a batch of ${b.count} carried a budget of ${b.budget}`).toBeLessThanOrEqual(
        cap,
      );
    }
    expect(sent.reduce((n, b) => n + b.count, 0)).toBe(30);
  });

  it("splits a batched write by the encoded frame cap", async () => {
    // Empty notes cost no budget at all, so only the frame size can fill a
    // batch. A plaintext entry is short, so the names are long: each entry
    // is a couple of hundred bytes of path, and eighty of them are several
    // frames' worth.
    const cap = 4096;
    const { engine, socket, vault } = await engineOnFakeSocket({ maxBatchBytes: cap });
    acceptEverything(socket);
    const count = 80;
    for (let i = 0; i < count; i++) {
      await vault.edit(`a folder with a long name/empty note ${String(i).padStart(2, "0")}.md`, "");
    }
    const report = await engine.sync();
    expect(report.uploaded).toBe(count + 1); // and the folder
    const sent = batches(socket);
    expect(sent.length, JSON.stringify(sent)).toBeGreaterThan(2);
    for (const b of sent) {
      expect(b.budget, "an empty note cost budget").toBe(0);
      expect(b.encoded, `a batch of ${b.count} encoded to ${b.encoded}`).toBeLessThanOrEqual(cap);
    }
    expect(sent.reduce((n, b) => n + b.count, 0)).toBe(count + 1);
  });

  it("sends a file whose own budget is over the cap with put, and the notes beside it as a batch", async () => {
    const cap = 6000;
    const { engine, socket, vault } = await engineOnFakeSocket({ maxBatchBytes: cap });
    acceptEverything(socket);
    for (let i = 0; i < 3; i++) await vault.edit(`note-${i}.md`, `note ${i}\n`);
    const big = new Uint8Array(cap + 1000);
    crypto.getRandomValues(big);
    await vault.write("photo.bin", big, { mtime: 1000, ctime: 1000 });
    const report = await engine.sync();
    expect(report.uploaded, JSON.stringify(report)).toBe(4);
    expect(report.skipped).toBe(0);
    const puts = socket.sentText.filter((m) => m["op"] === "put");
    expect(puts, "the large file did not go alone").toHaveLength(1);
    expect(batches(socket).reduce((n, b) => n + b.count, 0)).toBe(3);
  });

  /**
   * A fetch is bounded by the summed budget of what it asks for and by a
   * count of names. The client cannot see a stored chunk's size, so it costs
   * each at its share of the file's declared size, which over part of a file
   * can be under what the server counts; the engine asks again in halves when
   * the server says so (T02, below).
   */
  it("splits a fetch by the byte cap and asks for every chunk once", async () => {
    const { Engine, planFetches } = await import("./engine.ts");
    void Engine;
    const budget = (name: string) => Number(name.split(":")[1]);
    const names = ["a:1000", "b:1000", "c:1000", "d:2500", "e:100", "f:100", "g:5000"];
    const asks = planFetches(names, budget, 2500, 65536);
    for (const ask of asks) {
      const total = ask.reduce((n, name) => n + budget(name), 0);
      expect(total <= 2500 || ask.length === 1, `${ask.join(",")} costs ${total}`).toBe(true);
    }
    expect(asks.flat()).toEqual(names);
    expect(asks.length).toBeGreaterThan(2);
  });

  it("splits a fetch by the count of names", async () => {
    const { planFetches } = await import("./engine.ts");
    const names = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const asks = planFetches(names, () => 1, 1 << 30, 4);
    expect(asks.map((a) => a.length)).toEqual([4, 4, 2]);
    expect(asks.flat()).toEqual(names);
  });

  it("downloads a batch of files in fetches that each keep under the server's cap", async () => {
    const cap = 3000;
    const { engine, socket, vault, logs } = await engineOnFakeSocket({ maxFetchBytes: cap });

    // Ten files of a kilobyte, one chunk each, so each costs its 997 bytes and
    // three fit under the cap.
    const files: { path: string; name: string; text: Uint8Array }[] = [];
    for (let i = 0; i < 10; i++) {
      const text = new TextEncoder().encode(`file ${i}\n${"y".repeat(990)}`);
      files.push({ path: `f${i}.md`, name: await chunkName(text), text });
    }
    const byName = new Map(files.map((f) => [f.name, f.text]));
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch") {
        const asked = frame["chunks"] as string[];
        s.bodies(...asked.map((n) => byName.get(n)!));
      }
    };
    const entries = files.map((f, i) => ({
      uid: i + 1,
      path: f.path,
      size: f.text.length,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [f.name],
      device: "other",
    }));
    socket.raw({ op: "batch", from: 1, to: 10, entries });
    // Accepted on the transport's own turn, which is more than one turn of
    // the event loop away.
    for (let i = 0; i < 200 && engine.status().pending < 10; i++) await settle();
    expect(engine.status().pending, logs.join("\n")).toBe(10);
    const report = await engine.sync();
    expect(report.downloaded, JSON.stringify(report)).toBe(10);

    const fetches = socket.sentText.filter((m) => m["op"] === "fetch");
    expect(fetches.length, "one fetch carried everything").toBeGreaterThan(1);
    const sizeOf = new Map(files.map((f) => [f.name, f.text.length]));
    for (const f of fetches) {
      const asked = f["chunks"] as string[];
      const bytes = asked.reduce((n, name) => n + sizeOf.get(name)!, 0);
      expect(bytes, `a fetch of ${asked.length} chunks`).toBeLessThanOrEqual(cap);
    }
    // Split, not starved: a fetch holds as many as fit, not one at a time.
    expect(Math.max(...fetches.map((f) => (f["chunks"] as string[]).length))).toBe(3);
    expect(fetches.flatMap((f) => f["chunks"] as string[]).sort()).toEqual(
      files.map((f) => f.name).sort(),
    );
    for (const f of files) expect(vault.text(f.path)).toBe(new TextDecoder().decode(f.text));
  });

  /**
   * A server that counts a fetch by the chunks' real sizes, as `handleFetch`
   * does, and refuses one over its cap with `toolarge`, keeping the session.
   *
   * The device plans by each file's average chunk, which over a whole file is
   * what the server counts and over part of one is not: a large file's first
   * chunks are often bigger than its average. The refusal used to be recorded
   * as a fact about every file in the batch, written off for good as "too
   * large", small notes included, and the batch formed the same way after
   * every reconnect (T02).
   */
  function countingRealBytes(
    socket: FakeSocket,
    bodies: Map<string, Uint8Array>,
    cap: number,
  ): { answered: string[][]; refused: number } {
    const seen = { answered: [] as string[][], refused: 0 };
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch") {
        const asked = frame["chunks"] as string[];
        const total = asked.reduce((t, n) => t + bodies.get(n)!.length, 0);
        if (total > cap) {
          seen.refused++;
          s.raw({
            res: "err",
            id: frame["id"],
            code: "toolarge",
            msg: `the ${asked.length} chunks asked for hold ${total} bytes, limit for one fetch is ${cap}; ask in smaller sets`,
          });
          return;
        }
        seen.answered.push(asked);
        s.raw({ res: "bodies", id: frame["id"], count: asked.length });
        for (const n of asked) s.body(rawFrame(bodies.get(n)!));
      } else if (frame["op"] === "ping") s.raw({ res: "pong" });
    };
    return seen;
  }

  /** A file of chunks of the given sizes, each filled with its own byte. */
  async function fileOf(
    uid: number,
    path: string,
    sizes: number[],
    bodies: Map<string, Uint8Array>,
  ) {
    const parts = sizes.map((n, i) => new Uint8Array(n).fill((uid * 31 + i) % 251));
    const names: string[] = [];
    for (const p of parts) {
      const name = await chunkName(p);
      bodies.set(name, p);
      names.push(name);
    }
    const bytes = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    const entry = {
      uid,
      path,
      size: bytes.length,
      ctime: 1,
      mtime: 1,
      folder: false,
      deleted: false,
      chunks: names,
      device: "other",
    };
    return { entry, bytes };
  }

  it("asks again in smaller sets when a planned fetch is refused as too large (T02)", async () => {
    const cap = 4 << 20;
    const { engine, socket, vault } = await engineOnFakeSocket({
      maxFetchBytes: cap,
      maxChunks: 1000,
    });
    const bodies = new Map<string, Uint8Array>();
    // Three chunks of a mebibyte and then many small ones, so the average is
    // far below what the first chunks hold, beside a small file.
    const big = await fileOf(
      1,
      "media/big.bin",
      [...[1, 1, 1].map((m) => m << 20), ...Array(24).fill(128 << 10)],
      bodies,
    );
    const small = await fileOf(2, "media/a-small.bin", [1000], bodies);
    const seen = countingRealBytes(socket, bodies, cap);

    socket.raw({ op: "batch", from: 1, to: 2, entries: [big.entry, small.entry] });
    for (let i = 0; i < 200 && engine.status().pending < 2; i++) await settle();
    const report = await engine.sync({ coalesceWrites: false });

    expect(seen.refused, "the server never refused a plan, so this proves nothing").toBeGreaterThan(
      0,
    );
    expect(report.skipped, JSON.stringify(report.needsAttention)).toBe(0);
    expect(report.downloaded).toBe(2);
    expect(
      Buffer.from((await vault.read("media/big.bin")).subarray()).equals(Buffer.from(big.bytes)),
    ).toBe(true);
    expect(
      Buffer.from(await vault.read("media/a-small.bin")).equals(Buffer.from(small.bytes)),
    ).toBe(true);
    // Every chunk was asked for and answered once, within the cap.
    expect(seen.answered.flat().sort()).toEqual(
      [...big.entry.chunks, ...small.entry.chunks].sort(),
    );
    for (const ask of seen.answered) {
      expect(ask.reduce((t, n) => t + bodies.get(n)!.length, 0)).toBeLessThanOrEqual(cap);
    }
  });

  it("does not write a file off when even one chunk is over the fetch limit (T02)", async () => {
    // A server whose fetch limit is below its own chunk size cannot serve
    // that chunk at all. That is the server's configuration, not the file's
    // size, so it is retried and named, never written off as too large.
    const cap = 64 << 10;
    const { engine, socket } = await engineOnFakeSocket({ maxFetchBytes: cap, maxChunks: 1000 });
    const bodies = new Map<string, Uint8Array>();
    const one = await fileOf(1, "one.bin", [128 << 10], bodies);
    countingRealBytes(socket, bodies, cap);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [one.entry] });
    for (let i = 0; i < 200 && engine.status().pending < 1; i++) await settle();
    const report = await engine.sync({ coalesceWrites: false });
    expect(report.skipped, JSON.stringify(report.needsAttention)).toBe(0);
    expect(report.retrying).toBe(1);
  });

  it("tries a written-off download again when a new version arrives (T02)", async () => {
    // A write-off is keyed on what the file looked like, and a file not yet
    // downloaded has no local shape: every version of it looked alike, so a
    // download written off once stayed written off for the session, however
    // many new versions arrived.
    class RefusesOnce extends MemoryVault {
      refused = false;
      override async replace(...args: Parameters<MemoryVault["replace"]>) {
        if (!this.refused && args[0] === "note.md") {
          this.refused = true;
          const err = new Error("this vault will not write that name just now") as Error & {
            code: string;
          };
          err.code = "neversync";
          throw err;
        }
        return super.replace(...args);
      }
      override async create(...args: Parameters<MemoryVault["create"]>) {
        if (!this.refused && args[0] === "note.md") {
          this.refused = true;
          const err = new Error("this vault will not write that name just now") as Error & {
            code: string;
          };
          err.code = "neversync";
          throw err;
        }
        return super.create(...args);
      }
    }
    const vault = new RefusesOnce();
    const { engine, socket } = await engineOnFakeSocket({}, { vault });
    const bodies = new Map<string, Uint8Array>();
    const first = await fileOf(1, "note.md", [100], bodies);
    countingRealBytes(socket, bodies, 64 << 20);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [first.entry] });
    for (let i = 0; i < 200 && engine.status().pending < 1; i++) await settle();
    const refused = await engine.sync({ coalesceWrites: false });
    expect(refused.skipped, "the vault's refusal was not written off").toBe(1);

    const second = await fileOf(2, "note.md", [200], bodies);
    socket.raw({ op: "batch", from: 2, to: 2, entries: [second.entry] });
    for (let i = 0; i < 200 && engine.status().pending < 1; i++) await settle();
    const report = await engine.sync({ coalesceWrites: false });
    expect(report.skipped, "a new version was never tried").toBe(0);
    expect(Buffer.from(await vault.read("note.md")).equals(Buffer.from(second.bytes))).toBe(true);
  });
});

/**
 * Frames that parse as JSON and are not frames (F17).
 *
 * `JSON.parse` was wrapped in a try, so a frame that is not JSON at all ends
 * the session cleanly. `null`, a number, a string and an array all parse
 * perfectly well and then reach a reader that indexes into an object: the
 * probe threw a TypeError out of the socket callback, which nothing catches,
 * and left the connection open and unusable. A frame that is not an object
 * means the two ends disagree about the protocol just as surely as one that
 * is not JSON.
 */
describe("a text frame that is not a frame", () => {
  for (const [what, frame] of [
    ["null", null],
    ["a number", 7],
    ["a string", "hello"],
    ["an array", [1, 2, 3]],
  ] as const) {
    it(`ends the session on ${what}, without throwing out of the socket`, async () => {
      const { t, socket } = await helloed(0);
      const thrown: unknown[] = [];
      const realOnMessage = socket.onmessage!.bind(socket);
      socket.onmessage = (ev) => {
        try {
          realOnMessage(ev);
        } catch (err) {
          thrown.push(err);
        }
      };

      socket.raw(frame);
      await settle();

      expect(thrown, `the socket callback threw: ${String(thrown[0])}`).toEqual([]);
      expect(t.isClosed, "the connection was left open after an unreadable frame").toBe(true);
      await expect(t.ping()).rejects.toThrow();
    });
  }
});

/**
 * A body that is the wrong bytes must end the fetch when it is noticed (F18).
 *
 * The hashes are checked alongside the bodies still arriving, which is what
 * makes a fetch of two thousand bodies affordable, and nothing looked at them
 * until every body had been received. So a corrupt first body followed by a
 * slow second one rejected with nobody watching: an `unhandledRejection`,
 * which some runtimes treat as fatal, and then a wait for the rest of
 * whatever an attacker felt like sending.
 */
describe("a corrupt body early in a fetch", () => {
  it("fails at once rather than waiting for the bodies after it", async () => {
    const { t, socket } = await helloed(0);
    const good = new Uint8Array([1, 2, 3]);
    const alsoGood = new Uint8Array([4, 5, 6]);
    const names = [await chunkName(good), await chunkName(alsoGood)];

    const unhandled: unknown[] = [];
    const watch = (err: unknown): void => void unhandled.push(err);
    process.on("unhandledRejection", watch);
    try {
      const fetching = t.fetch(names);
      await settle();
      // Two are promised. The first is not what was asked for, and the second
      // never comes, which is the shape that used to leave a rejection with
      // nobody watching while the fetch sat waiting for it.
      socket.reply({ res: "bodies", count: 2 });
      socket.body(new Uint8Array([9, 9, 9]));

      await expect(fetching).rejects.toMatchObject({ code: "badchunk" });
      // Waited for, because an unhandled rejection is reported a turn later.
      await nextTurn();
      expect(
        unhandled,
        `the corrupt body rejected with nobody watching: ${String(unhandled[0])}`,
      ).toEqual([]);
    } finally {
      process.off("unhandledRejection", watch);
    }
  });

  it("still reports a bad hash on the last body of a fetch", async () => {
    const { t, socket } = await helloed(0);
    const good = new Uint8Array([1, 2, 3]);
    const names = [await chunkName(good)];
    const fetching = t.fetch(names);
    await settle();
    socket.bodies(new Uint8Array([8, 8, 8]));
    await expect(fetching).rejects.toMatchObject({ code: "badchunk" });
  });
});

/**
 * Work a server can make this device queue, and memory it can make it hold
 * (F28).
 *
 * Batches and caught-up frames are chained onto one promise so they apply in
 * order, and the chain had no bound: a server that sends faster than the
 * engine applies grows it without limit, each link holding its frame's
 * entries alive. Ending the session is the answer rather than dropping a
 * frame, because a dropped batch advances nothing and leaves a hole this
 * device never asks about again.
 */
describe("a server that sends faster than this device can apply", () => {
  it("ends the session rather than queueing without limit", async () => {
    const { t, socket } = await helloed(0);
    // Nothing drains while this runs: the frames are all delivered inside one
    // synchronous burst, so the chain cannot make progress between them.
    for (let i = 0; i < 2000 && !t.isClosed; i++) {
      socket.raw({ op: "batch", from: i + 1, to: i + 1, entries: [] });
    }
    await settle();
    expect(t.isClosed, "the backlog grew without any bound at all").toBe(true);
  });
});

/**
 * A chunk that inflates to whatever the writer chose (F28).
 *
 * `inflateSync` has no output limit, and the engine checked the assembled size
 * only after every chunk had been expanded, so a small body could make a
 * device allocate as much as its writer liked. In Basalt producing one needed
 * the data key; a frame needs nothing, so any server can send this, and on a
 * phone that is the difference between a note and a dead app.
 */
describe("a chunk that inflates far beyond a chunk", () => {
  it("is refused rather than held", async () => {
    // Framed the way a writer frames one, so this is the real path and not a
    // hand-built frame: zeroes compress to almost nothing and expand past the
    // ceiling.
    const huge = new Uint8Array(LOCAL_MAX_CHUNK_BYTES + 1024);
    const frame = encodeFrame(huge);
    expect(frame[0], "zeroes are sent deflated").toBe(MARKER_DEFLATE);
    expect(frame.length, "the body has to be small to be worth refusing").toBeLessThan(100_000);
    expect(() => decodeFrame(frame, LOCAL_MAX_CHUNK_BYTES)).toThrow(/inflates past/);

    // And on the wire: the fetch that receives it ends the session with
    // `toolarge`, and nothing past the ceiling was kept.
    const { t, socket } = await helloed(0);
    const fetching = t.fetch([await chunkName(huge)]);
    socket.reply({ res: "bodies", count: 1 });
    socket.body(frame);
    await expect(fetching).rejects.toMatchObject({ code: "toolarge" });
    await expect(fetching).rejects.toThrow(/does not decode/);
    expect(t.isClosed).toBe(true);
  });
});

/**
 * A body frame this device cannot read (plan/protocol.md, "Chunk bodies").
 *
 * Framing lives at the transport, so this is the one place a frame that is not
 * a frame can be caught: above it everything is a verified raw chunk. A body
 * that does not decode leaves the two ends disagreeing about what was sent, and
 * the bodies behind it can no longer be matched to names, so the session ends,
 * as it does on a body that hashes wrong.
 */
describe("a body frame that does not decode", () => {
  const text = new TextEncoder().encode("a note long enough that deflating it pays. ".repeat(40));
  const deflated = encodeFrame(text);

  it.each([
    ["an empty frame", new Uint8Array(0)],
    ["a raw frame with no chunk in it", new Uint8Array([MARKER_RAW])],
    ["an unknown marker", new Uint8Array([2, 1, 2, 3])],
    ["a deflate stream cut short", deflated.subarray(0, deflated.length - 4)],
    ["a deflate stream of no bytes at all", new Uint8Array([MARKER_DEFLATE])],
  ])("ends the session on %s, as badchunk", async (_what, frame) => {
    expect(deflated[0], "the text is meant to go deflated").toBe(MARKER_DEFLATE);
    const { t, socket } = await helloed(0);
    const fetching = t.fetch([await chunkName(text)]);
    socket.reply({ res: "bodies", count: 1 });
    socket.body(frame);
    await expect(fetching).rejects.toMatchObject({ code: "badchunk" });
    expect(t.isClosed, "a body nobody can read left the session open").toBe(true);
  });

  it("still takes the whole stream, deflated, and hands back the raw chunk", async () => {
    const { t, socket } = await helloed(0);
    const fetching = t.fetch([await chunkName(text)]);
    socket.reply({ res: "bodies", count: 1 });
    socket.body(deflated);
    expect(await fetching).toEqual([text]);
    expect(t.isClosed).toBe(false);
    t.close();
  });

  it("checks the hash against the decoded bytes, never the frame", async () => {
    // A frame whose bytes are named correctly and whose decoded bytes are not
    // is still the wrong chunk: the name is over the raw bytes.
    const { t, socket } = await helloed(0);
    const fetching = t.fetch([await chunkName(deflated)]);
    socket.reply({ res: "bodies", count: 1 });
    socket.body(deflated);
    await expect(fetching).rejects.toMatchObject({ code: "badchunk" });
  });
});
