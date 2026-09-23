/**
 * What the body frame does with the chunks a vault is made of (`frame.ts`).
 *
 * A frame is one marker byte and then the chunk, raw or as a raw DEFLATE
 * stream, and compression is a wire encoding only: a chunk's name is the
 * SHA-256 of its raw bytes, so the two ends never have to agree on compressed
 * output, only on what it decodes to (plan/protocol.md, "Chunk bodies").
 * `contract.test.ts` holds this side to the contract's frame vectors: the
 * refusals, the boundary at `chunkMax`, and frames Go and the reference made.
 * This file is the rest of what the frame is for, most of it carried from the
 * sealed-chunk tests of `crypto.test.ts` and `compression-golden.test.ts`,
 * whose guarantees outlived the sealing: text is actually deflated,
 * incompressible bytes cost one byte, the probe's worst case survives, the
 * marker each kind of input gets is pinned, and the name never depends on the
 * frame.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { FrameError, MARKER_DEFLATE, MARKER_RAW, decodeFrame, encodeFrame } from "./frame.ts";

const enc = new TextEncoder();
/** The protocol's chunkMax, which every receiver decodes against. */
const CHUNK_MAX = 1 << 20;

const prose = (n: number) => enc.encode("the note sync vault chunk ".repeat(n));

/** Random bytes, which do not compress. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, n)));
  }
  return out;
}

/** Deterministic bytes with no structure a compressor can find. xorshift32. */
function fixedNoise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** The bytes a receiver gets back from a frame, the way the transport decodes one. */
const roundTrip = (raw: Uint8Array): Uint8Array => decodeFrame(encodeFrame(raw), CHUNK_MAX);

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe("a chunk, framed and read back", () => {
  it("round trips", () => {
    const plain = enc.encode("# A note\n\nWith some content.\n");
    expect(roundTrip(plain)).toEqual(plain);
  });

  it("round trips bytes that are not text", () => {
    const plain = new Uint8Array(1024);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) & 0xff;
    expect(roundTrip(plain)).toEqual(plain);
  });

  /**
   * No file has an empty chunk: the chunker makes none for an empty file
   * (chunk.test.ts, "produces no chunks for an empty file") and an empty note
   * travels as no chunks at all. So an empty input frames to the marker alone,
   * and a receiver refuses that, rather than taking it for a chunk.
   */
  it("gives an empty input the marker alone, which a receiver refuses", () => {
    const framed = encodeFrame(new Uint8Array(0));
    expect([...framed]).toEqual([MARKER_RAW]);
    let refused: unknown;
    try {
      decodeFrame(framed, CHUNK_MAX);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(FrameError);
    expect((refused as FrameError).kind).toBe("empty");
  });

  it("never costs more than one byte above the content", () => {
    // A marker byte, and nothing else: content that compresses costs less
    // than it started as, and content that does not is sent raw at exactly
    // one byte more. Never more than that, which is what keeps every frame
    // within the receiver's chunkMax + 1.
    for (const size of [0, 1, 100, 4096]) {
      // Random bytes do not compress, so this is the worst case.
      const framed = encodeFrame(noise(size));
      expect(framed.length, `${size} bytes of random data`).toBe(size + 1);
      expect(framed[0], `${size} bytes of random data`).toBe(MARKER_RAW);
    }
  });

  it("shrinks content that compresses", () => {
    const repetitive = enc.encode("the same sentence over and over. ".repeat(40));
    const framed = encodeFrame(repetitive);
    expect(framed[0]).toBe(MARKER_DEFLATE);
    expect(framed.length).toBeLessThan(repetitive.length / 2);
    expect(decodeFrame(framed, CHUNK_MAX)).toEqual(repetitive);
  });

  it("refuses a chunk whose marker it does not know", () => {
    // A future version's framing. Guessing at its shape would write nonsense
    // into the vault.
    let refused: unknown;
    try {
      decodeFrame(new Uint8Array([99, 1, 2, 3]), CHUNK_MAX);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(FrameError);
    expect((refused as FrameError).kind).toBe("marker");
    expect((refused as Error).message).toMatch(/unknown marker 99/);
  });

  it("frames a view into a larger buffer exactly as it frames a copy", () => {
    // The framing's own twin of the digest's buffer case: a chunk cut from a
    // file is a view into the file's bytes, and the frame must carry the view
    // and not its neighbours.
    const bytes = prose(200);
    for (const at of [0, 32, 64]) {
      const backing = new Uint8Array(bytes.length + 64).fill(0xff);
      backing.set(bytes, at);
      const view = backing.subarray(at, at + bytes.length);
      expect(same(encodeFrame(view), encodeFrame(bytes)), `at ${at}`).toBe(true);
      expect(same(decodeFrame(encodeFrame(view), CHUNK_MAX), bytes), `at ${at}`).toBe(true);
    }
  });
});

/**
 * Compression is decided from a prefix, because deflating bytes that are
 * already compressed does all the work and throws the answer away. That is an
 * optimisation and nothing else: whatever it decides, the chunk has to come
 * back exactly, and what it decides must never reach the chunk's name.
 */
describe("deciding whether a chunk is worth compressing", () => {
  it("still compresses text, which is what a vault is mostly made of", () => {
    const text = prose(20_000);
    const framed = encodeFrame(text);
    expect(framed.length, "prose was sent uncompressed").toBeLessThan(text.length / 2);
    expect(same(decodeFrame(framed, CHUNK_MAX), text)).toBe(true);
  });

  it("round trips incompressible bytes, which are not deflated at all", () => {
    const bytes = noise(256 * 1024);
    const framed = encodeFrame(bytes);
    expect(framed[0]).toBe(MARKER_RAW);
    expect(same(decodeFrame(framed, CHUNK_MAX), bytes)).toBe(true);
  });

  it("round trips a chunk that is mostly compressible behind a random start", () => {
    // The case the probe gets wrong: its first four kilobytes are noise, so
    // it is sent raw, and the only cost is bytes. It still has to come back
    // exactly.
    const mixed = new Uint8Array(200 * 1024);
    mixed.set(noise(8192), 0);
    mixed.set(prose(10_000).subarray(0, mixed.length - 8192), 8192);
    const framed = encodeFrame(mixed);
    expect(framed[0], "the probe's worst case was deflated after all").toBe(MARKER_RAW);
    expect(same(decodeFrame(framed, CHUNK_MAX), mixed)).toBe(true);
  });

  /**
   * One case per thing the marker rule has to get right, from the sealed-chunk
   * table that pinned it byte for byte. The bytes are not pinned any more,
   * because nothing depends on them: the server re-frames what it sends, and a
   * name is of the raw chunk. The marker is, per runtime, because it says the
   * rule still does what it is for (Go's `internal/frame` may choose
   * differently and is held to its own).
   */
  const kinds: { name: string; bytes: Uint8Array; marker: number }[] = [
    { name: "one byte", bytes: new Uint8Array([0x41]), marker: MARKER_RAW },
    {
      name: "a short growing sequence",
      bytes: new Uint8Array(40).map((_, i) => i),
      marker: MARKER_RAW,
    },
    {
      name: "a long growing sequence, which repeats every 256 bytes",
      bytes: new Uint8Array(2048).map((_, i) => i & 0xff),
      marker: MARKER_DEFLATE,
    },
    {
      name: "incompressible bytes, probed and left alone",
      bytes: fixedNoise(8193, 0x9e3779b9),
      marker: MARKER_RAW,
    },
    {
      name: "a long compressible text",
      bytes: enc.encode(
        Array.from(
          { length: 120 },
          (_, i) => `- [ ] Line ${i}: the same sort of sentence, over and over.\n`,
        ).join(""),
      ),
      marker: MARKER_DEFLATE,
    },
  ];

  it("gives each kind of input the marker the rule says", () => {
    // Nothing, the one input with no chunk, frames as the marker alone.
    expect(encodeFrame(new Uint8Array(0))[0]).toBe(MARKER_RAW);
    for (const kind of kinds) {
      expect(encodeFrame(kind.bytes)[0], kind.name).toBe(kind.marker);
    }
  });

  it("never frames any of them to more than one byte over its length", () => {
    for (const kind of kinds) {
      const framed = encodeFrame(kind.bytes);
      expect(framed.length, kind.name).toBeLessThanOrEqual(kind.bytes.length + 1);
      expect(same(decodeFrame(framed, CHUNK_MAX), kind.bytes), kind.name).toBe(true);
    }
  });
});

/**
 * The property deduplication rests on, and the one whose failure is silent:
 * the same content has to get the same name on every device, whatever any
 * compressor did to it on the way. A name made of a frame would differ between
 * a desktop and a phone, or between this client and the server, and each
 * would upload for ever what the other already holds while reporting success.
 */
describe("a chunk's name", () => {
  it("never depends on the frame it travelled in", async () => {
    for (const raw of [prose(500), noise(200 * 1024), noise(3000), fixedNoise(8193, 7)]) {
      const name = await chunkName(raw);
      const framed = encodeFrame(raw);
      expect(await chunkName(decodeFrame(framed, CHUNK_MAX))).toBe(name);
      // Named by the chunk, not by what carried it.
      expect(await chunkName(framed)).not.toBe(name);
      // The same every time it is asked.
      expect(await chunkName(roundTrip(raw))).toBe(name);
    }
  });

  it("is the same for a raw frame and a deflated one of the same chunk", async () => {
    const raw = prose(2000);
    const deflated = encodeFrame(raw);
    expect(deflated[0]).toBe(MARKER_DEFLATE);
    const rawFramed = new Uint8Array(1 + raw.length);
    rawFramed[0] = MARKER_RAW;
    rawFramed.set(raw, 1);
    expect(same(deflated, rawFramed)).toBe(false);
    const name = await chunkName(raw);
    expect(await chunkName(decodeFrame(deflated, CHUNK_MAX))).toBe(name);
    expect(await chunkName(decodeFrame(rawFramed, CHUNK_MAX))).toBe(name);
  });

  /**
   * Across implementations: the contract holds several frames of one chunk,
   * made by the reference at different deflate levels and with bytes after
   * the final block, which is what another implementation's frame looks like
   * to this one. Every one of them, and this side's own frame of the same
   * bytes, decodes to one chunk and so to one name.
   */
  it("is the same for every frame another implementation could have sent", async () => {
    const contract = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol-fixtures.json"), "utf8"),
    ) as { frames: { good: { why: string; frame: string; raw: string; name: string }[] } };
    const byRaw = new Map<string, { why: string; frame: string; name: string }[]>();
    for (const g of contract.frames.good) {
      byRaw.set(g.raw, [...(byRaw.get(g.raw) ?? []), g]);
    }
    const shared = [...byRaw.entries()].filter(([, frames]) => frames.length > 1);
    expect(shared.length, "the contract has no chunk framed more than one way").toBeGreaterThan(0);
    for (const [rawHex, frames] of shared) {
      const raw = Uint8Array.from(Buffer.from(rawHex, "hex"));
      const name = await chunkName(raw);
      expect(await chunkName(roundTrip(raw))).toBe(name);
      for (const f of frames) {
        const decoded = decodeFrame(Uint8Array.from(Buffer.from(f.frame, "hex")), CHUNK_MAX);
        expect(await chunkName(decoded), f.why).toBe(name);
        expect(f.name, f.why).toBe(name);
      }
    }
  });
});
