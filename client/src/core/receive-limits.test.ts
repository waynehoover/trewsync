/**
 * What arrives is bounded before it is expanded, parsed or kept (R13).
 *
 * F28 added the counts: how many notifications may queue, how many bodies a
 * fetch may carry. What it did not add is bytes. A count of objects says
 * nothing about the memory they occupy, and each of the three checks ran after
 * the expensive step rather than before it:
 *
 *   - the chunk ceiling was compared against the finished inflate, so the
 *     allocation it refuses had already happened, and a quarter of a gigabyte
 *     of zeroes is 256 kB on the wire;
 *   - a chunk framed raw skipped that ceiling altogether, so the bound was a
 *     property of how the writer chose to frame its bytes;
 *   - a text frame was parsed and then looked at, and `JSON.parse` on a very
 *     large string is the allocation.
 *
 * In protocol 1 a body frame is decoded in one place, `decodeFrame`, and only
 * the transport's `fetch` calls it (plan/protocol.md, "Chunk bodies"), so each
 * guarantee is asserted twice here: on the decoder, and on the fetch a server
 * would have to get past to reach it.
 */

import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { FakeSocket, rawFrame, ready } from "./fake-socket.ts";
import { FrameError, MARKER_DEFLATE, decodeFrame, encodeFrame } from "./frame.ts";
import { LOCAL_MAX_CHUNK_BYTES, PROTO, ProtocolError, Transport } from "./transport.ts";

/** A body frame of a test's own making: a marker, then whatever payload. */
function frameOf(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length);
  out[0] = marker;
  out.set(payload, 1);
  return out;
}

/** The kind a frame is refused with, or undefined when it decodes. */
function refusal(frame: Uint8Array, maxRaw: number): string | undefined {
  try {
    decodeFrame(frame, maxRaw);
    return undefined;
  } catch (err) {
    if (!(err instanceof FrameError)) throw err;
    return err.kind;
  }
}

/** A connected transport, and what it gave as the reason when it closed. */
async function connected() {
  const socket = new FakeSocket();
  let cause: Error | undefined;
  const t = new Transport("ws://test", {
    onBatch: () => {},
    onClosed: (c) => {
      cause = c;
    },
    socketFactory: () => socket,
    timeoutMs: 5000,
  });
  const connecting = t.connect();
  socket.open();
  await connecting;
  return { t, socket, cause: () => cause };
}

/** A transport past its handshake, with the ceilings a case asks for. */
async function helloed(over: Record<string, unknown> = {}) {
  const rig = await connected();
  const hello = rig.t.hello({ vault: "v", deviceId: "d1", device: "d", token: "t", cursor: 0 });
  rig.socket.reply(ready({ cursor: 0, ...over }));
  const limits = await hello;
  return { ...rig, limits };
}

/** 256 MiB of one byte, which deflate carries in a few hundred kilobytes. */
function deflateBomb(): Uint8Array {
  const bomb = frameOf(MARKER_DEFLATE, deflateSync(new Uint8Array(256 * 1024 * 1024)));
  expect(bomb.length, "the frame is not small enough to make the point").toBeLessThan(
    2 * 1024 * 1024,
  );
  // And under the frame bound, so it is the inflate that has to stop it.
  expect(bomb.length).toBeLessThanOrEqual(LOCAL_MAX_CHUNK_BYTES + 1);
  return bomb;
}

describe("a chunk that expands past what a chunk may hold", () => {
  it("is refused, and the expansion is stopped rather than completed", () => {
    const bomb = deflateBomb();
    const started = Date.now();
    expect(refusal(bomb, LOCAL_MAX_CHUNK_BYTES)).toBe("toolarge");
    // Stopping early is the point, and it is also observable: inflating the
    // whole 256 MiB takes far longer than refusing it partway.
    expect(
      Date.now() - started,
      "the refusal took long enough that it probably inflated the whole thing",
    ).toBeLessThan(5000);
  }, 60_000);

  it("is refused by a fetch, which ends the session over it", async () => {
    const { t, socket } = await helloed();
    // Made before the clock starts: deflating 256 MiB is seconds of its own
    // on a slow runner, and it was being counted as the refusal's time.
    const bomb = deflateBomb();
    const fetching = t.fetch(["a".repeat(64)]);
    socket.reply({ res: "bodies", count: 1 });
    const started = Date.now();
    socket.body(bomb);
    await expect(fetching).rejects.toMatchObject({ code: "toolarge" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.isClosed, "a body that could not be read left the session open").toBe(true);
  }, 60_000);

  /** The raw framing gets the same ceiling. It used to get none. */
  it("is refused when it is framed raw as well as when it is deflated", () => {
    const big = new Uint8Array(LOCAL_MAX_CHUNK_BYTES + 1);
    expect(refusal(rawFrame(big), LOCAL_MAX_CHUNK_BYTES)).toBe("toolarge");
    // Refused on its length, before anything is looked at: a frame of any
    // marker over the bound is the same refusal.
    expect(refusal(frameOf(MARKER_DEFLATE, big), LOCAL_MAX_CHUNK_BYTES)).toBe("toolarge");
    // And the boundary itself is a chunk: exactly the ceiling, framed raw.
    expect(refusal(rawFrame(big.subarray(1)), LOCAL_MAX_CHUNK_BYTES)).toBeUndefined();
  }, 60_000);

  it("is refused by a fetch when it is framed raw", async () => {
    const { t, socket } = await helloed();
    const big = new Uint8Array(LOCAL_MAX_CHUNK_BYTES + 1).fill(7);
    const fetching = t.fetch([await chunkName(big)]);
    socket.bodies(big);
    await expect(fetching).rejects.toMatchObject({ code: "toolarge" });
    expect(t.isClosed).toBe(true);
  }, 60_000);

  /** And an ordinary chunk still opens, both ways round. */
  it("still opens a chunk of an ordinary size", async () => {
    const text = new TextEncoder().encode("a note, of the size notes are.\n".repeat(100));
    for (const frame of [rawFrame(text), frameOf(MARKER_DEFLATE, deflateSync(text))]) {
      expect(decodeFrame(frame, LOCAL_MAX_CHUNK_BYTES)).toEqual(text);
    }
    // Through a fetch, deflated the way a writer frames it, which is what
    // `encodeFrame` does to text: what comes back is the raw chunk.
    const framed = encodeFrame(text);
    expect(framed[0], "text of this size is sent deflated").toBe(MARKER_DEFLATE);
    const { t, socket } = await helloed();
    const fetching = t.fetch([await chunkName(text)]);
    socket.reply({ res: "bodies", count: 1 });
    socket.body(framed);
    expect(await fetching).toEqual([text]);
    expect(t.isClosed).toBe(false);
    t.close();
  }, 60_000);
});

/**
 * A text frame is a control message, and its size is checked before it is
 * parsed. The frame here is not JSON at all, which is how the order shows: a
 * transport that parsed first would refuse it as `protostate` for not being
 * JSON, having already paid for the parse, and one that bounds first refuses
 * it as `toolarge` without looking inside.
 */
describe("a text frame larger than any control message", () => {
  /** The code the transport closed with, which has to be a refusal. */
  const codeOf = (cause: Error | undefined): string => {
    expect(cause, "the transport did not close").toBeInstanceOf(ProtocolError);
    return (cause as ProtocolError).code;
  };

  it("is refused before the handshake, before it is parsed", async () => {
    const { t, socket, cause } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "d1", device: "d", token: "t", cursor: 0 });
    const refused = expect(hello).rejects.toMatchObject({ code: "toolarge" });
    // Over the megabyte the handshake allows, and not JSON.
    socket.onmessage?.({ data: "{".repeat((1 << 20) + 1) });
    await refused;
    expect(t.isClosed).toBe(true);
    expect(codeOf(cause()), cause()?.message).toBe("toolarge");
  });

  it("is refused after the handshake by the batch ceiling the server advertised", async () => {
    // A server that advertised a small batch cap cannot then send a frame
    // of many times that, which it could never legitimately need.
    const { t, socket, cause } = await helloed({ maxBatchBytes: 4096 });
    socket.onmessage?.({ data: "{".repeat(4096 * 2 + 1) });
    expect(t.isClosed).toBe(true);
    expect(codeOf(cause()), cause()?.message).toBe("toolarge");
  });

  it("is still read when it is under the ceiling", async () => {
    const { t, socket, cause } = await helloed({ maxBatchBytes: 4096 });
    // Not JSON, and under the bound, so it reaches the parser and is refused
    // for what it is rather than for its size.
    socket.onmessage?.({ data: "{".repeat(100) });
    expect(t.isClosed).toBe(true);
    expect(codeOf(cause()), cause()?.message).toBe("protostate");
  });
});

/**
 * The peer does not choose how much memory this device commits (R26).
 *
 * The handshake's `maxBatchBytes`, `maxFetchBytes` and `chunkMax` are a server
 * saying how much it may send. They were taken as the client's own ceilings,
 * which makes the peer the one deciding: a handshake advertising
 * `Number.MAX_SAFE_INTEGER` was accepted and produced a text-frame ceiling of
 * eighteen quadrillion. Whether the server is hostile or simply wrong does not
 * change the cost.
 */
describe("what a server may talk this device into holding", () => {
  it("caps the advertised limits at what this device will accept", async () => {
    const socket = new FakeSocket();
    const t = new Transport("ws://test", {
      onBatch: () => {},
      socketFactory: () => socket,
      timeoutMs: 2000,
    });
    const connecting = t.connect();
    socket.open();
    await connecting;

    const hello = t.hello({ vault: "v", deviceId: "d1", device: "d", token: "t", cursor: 0 });
    await new Promise((r) => setTimeout(r, 0));
    socket.raw({
      res: "ready",
      id: 1,
      proto: PROTO,
      minProto: PROTO,
      epoch: "e",
      cursor: 0,
      perFileMax: Number.MAX_SAFE_INTEGER,
      chunkMax: Number.MAX_SAFE_INTEGER,
      maxChunks: Number.MAX_SAFE_INTEGER,
      maxBatchBytes: Number.MAX_SAFE_INTEGER,
      maxFetchBytes: Number.MAX_SAFE_INTEGER,
      serverVersion: "0",
    });
    const limits = await hello;

    expect(
      limits.maxBatchBytes,
      "the server chose how large a frame this device will parse",
    ).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(
      limits.maxFetchBytes,
      "the server chose how many bytes of bodies this device will hold",
    ).toBeLessThanOrEqual(64 * 1024 * 1024);
    // The chunk ceiling bounds every body frame before anything is inflated,
    // so it is held to this device's own figure like the two budgets.
    expect(limits.chunkMax, "the server chose how far a body may inflate").toBe(
      LOCAL_MAX_CHUNK_BYTES,
    );
    t.close();
  });

  it("still honours a server that asks for less", async () => {
    const socket = new FakeSocket();
    const t = new Transport("ws://test", {
      onBatch: () => {},
      socketFactory: () => socket,
      timeoutMs: 2000,
    });
    const connecting = t.connect();
    socket.open();
    await connecting;

    const hello = t.hello({ vault: "v", deviceId: "d1", device: "d", token: "t", cursor: 0 });
    await new Promise((r) => setTimeout(r, 0));
    socket.raw({
      res: "ready",
      id: 1,
      proto: PROTO,
      minProto: PROTO,
      epoch: "e",
      cursor: 0,
      perFileMax: 1024,
      chunkMax: 1024,
      maxChunks: 8,
      maxBatchBytes: 4096,
      maxFetchBytes: 8192,
      serverVersion: "0",
    });
    const limits = await hello;
    expect(limits.maxBatchBytes, "a smaller advertised limit was raised").toBe(4096);
    expect(limits.maxFetchBytes, "a smaller advertised limit was raised").toBe(8192);
    expect(limits.chunkMax, "a smaller advertised limit was raised").toBe(1024);
    t.close();
  });
});

/**
 * The fetch budget, at its edge.
 *
 * `maxFetchBytes` counts raw chunk bytes, and every body travels in a frame
 * one marker byte longer than its chunk when it is sent raw. A fetch of
 * exactly the budget therefore arrives as the budget plus one byte per body,
 * and refusing that would end a session over an answer the server was entitled
 * to give. One byte over the budget in raw bytes is over it, however it is
 * framed.
 */
describe("a fetch at the edge of the byte budget", () => {
  /** Bodies of the given sizes, each different, with their names. */
  async function bodiesOf(...sizes: number[]) {
    const bodies = sizes.map((n, i) => new Uint8Array(n).fill(i + 1));
    return { bodies, names: await Promise.all(bodies.map((b) => chunkName(b))) };
  }

  it("takes exactly maxFetchBytes of raw-framed bodies, marker bytes and all", async () => {
    const { t, socket } = await helloed({ chunkMax: 2048, maxFetchBytes: 4096 });
    const { bodies, names } = await bodiesOf(2048, 2048);
    const fetching = t.fetch(names);
    socket.bodies(...bodies);
    const got = await fetching;
    expect(got).toEqual(bodies);
    expect(got.reduce((n, b) => n + b.length, 0)).toBe(4096);
    expect(t.isClosed, "a fetch the server was entitled to send ended the session").toBe(false);
    t.close();
  });

  it("refuses one byte over it", async () => {
    const { t, socket } = await helloed({ chunkMax: 2048, maxFetchBytes: 4096 });
    const { bodies, names } = await bodiesOf(2048, 2048, 1);
    const fetching = t.fetch(names);
    socket.bodies(...bodies);
    await expect(fetching).rejects.toMatchObject({ code: "toolarge" });
    expect(t.isClosed).toBe(true);
  });

  it("refuses one byte over it even when the frames are small", async () => {
    // The frames are deflated and far under the budget; what they decode to
    // is not, and the decoded total is held to the same number.
    const { t, socket } = await helloed({ chunkMax: 2048, maxFetchBytes: 4096 });
    const { bodies, names } = await bodiesOf(2048, 2048, 1);
    const fetching = t.fetch(names);
    const frames = bodies.map((b) => encodeFrame(b));
    expect(
      frames.reduce((n, f) => n + f.length, 0),
      "the frames have to be small for this to be about the decoded total",
    ).toBeLessThan(4096);
    socket.reply({ res: "bodies", count: frames.length });
    for (const f of frames) socket.body(f);
    await expect(fetching).rejects.toMatchObject({ code: "toolarge" });
    await expect(fetching).rejects.toThrow(/decoding to 4097 bytes/);
    expect(t.isClosed).toBe(true);
  });
});
