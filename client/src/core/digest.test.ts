/**
 * Names, the one text encoding the wire uses, and random bytes (`digest.ts`).
 *
 * A chunk's name is the lowercase hex SHA-256 of its raw bytes (plan/protocol.md,
 * "Chunk bodies"), and the server recomputes it from every body it receives, so
 * a name this side makes differently is an upload refused on its first attempt.
 * base64url carries every device id, device token and invite token, so a
 * decoder that reads a damaged value as a good one is a credential taken for
 * another.
 *
 * Most of this was in `crypto.test.ts` until the encryption went (M2): the
 * vectors, the name's shape, the view into a larger buffer, the whole-file
 * naming and the strict decoder. The cases are the same and so are the
 * assertions; what they are asked of is `digest.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NAME_WINDOW,
  base64urlDecode,
  base64urlEncode,
  chunkName,
  chunkNames,
  isChunkName,
  randomBytes,
} from "./digest.ts";

const enc = new TextEncoder();

describe("chunk names", () => {
  /**
   * Pinned, because a disagreement with the server means every upload is
   * refused as corrupt. That is at least loud, but the vectors make it a test
   * failure instead of a field report.
   */
  it("agrees with the server, byte for byte", async () => {
    const vectors: [Uint8Array, string][] = [
      [new Uint8Array(0), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      [enc.encode("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
      [
        enc.encode("the quick brown fox"),
        "9ecb36561341d18eb65484e833efea61edc74b84cf5e6ae1b81c63533e25fc8f",
      ],
      [
        new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0xfe, 0x01]),
        "11a374c7aa6de48cc311c32b9fcad7c0ca6c943410bbc7871458f1fb7a294b1d",
      ],
    ];
    for (const [input, want] of vectors) {
      expect(await chunkName(input)).toBe(want);
    }
  });

  /**
   * The same property against vectors neither side wrote: every chunk in the
   * contract's frame section is named by `scripts/protocol-vectors.py`, and
   * `internal/frame` checks the Go side's names against the same file.
   */
  it("names every chunk in the shared contract as the reference names it", async () => {
    const contract = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol-fixtures.json"), "utf8"),
    ) as { frames: { good: { why: string; raw: string; name: string }[] } };
    expect(contract.frames.good.length).toBeGreaterThanOrEqual(5);
    for (const g of contract.frames.good) {
      const raw = Uint8Array.from(Buffer.from(g.raw, "hex"));
      expect(await chunkName(raw), g.why).toBe(g.name);
    }
  });

  it("is 64 lowercase hex characters, which is what the server accepts", async () => {
    const name = await chunkName(enc.encode("anything"));
    expect(name).toMatch(/^[0-9a-f]{64}$/);
    expect(isChunkName(name)).toBe(true);
  });

  /**
   * `isChunkName` is what a `get`, a recovery list and the stored index hold a
   * name to before fetching by it, so it has to take exactly what `chunkName`
   * makes. The server's `ValidName` is the same shape and refuses upper case
   * rather than normalising it, which would give one chunk two names.
   */
  it("recognises a name by its shape and nothing else", async () => {
    const name = await chunkName(enc.encode("a chunk"));
    for (const bad of [
      name.toUpperCase(),
      name.slice(1),
      name + "0",
      name.slice(0, 63) + "g",
      "",
      "../../etc/passwd",
      undefined,
      null,
      64,
    ]) {
      expect(isChunkName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

/**
 * WebCrypto is handed an ArrayBuffer, and a Uint8Array that is a view into a
 * larger buffer is where that gets dangerous: hand over the buffer and the call
 * reads the neighbours too. The helper only skips its copy when the view spans
 * its whole buffer, so these pin the case it must never skip.
 */
describe("a view into a larger buffer", () => {
  const bytes = enc.encode("the bytes that are actually the message");

  /**
   * The same bytes as a view of a larger array of 0xff, at `at`. Offset zero is
   * its own case: a view can start at the start and still stop short, and a
   * check that only looked at where it began would wave that one through.
   */
  function embedded(at: number): Uint8Array {
    const backing = new Uint8Array(bytes.length + 64).fill(0xff);
    backing.set(bytes, at);
    return backing.subarray(at, at + bytes.length);
  }

  it("names a chunk by its own bytes, not its neighbours'", async () => {
    for (const at of [0, 32, 64]) {
      expect(await chunkName(embedded(at)), `at ${at}`).toBe(await chunkName(bytes));
    }
  });
});

/**
 * A file's chunks are named a window at a time (`NAME_WINDOW`), which is only
 * a matter of time and memory. The names must be exactly what naming each
 * chunk on its own gives, in the order the chunks came: a put names its chunks
 * in order, reassembly joins them in that order, and a file stored under names
 * no other device agrees with is a file that never deduplicates or, reordered,
 * one that comes back scrambled.
 */
describe("naming a whole file's chunks", () => {
  it("gives the same result as naming them one at a time", async () => {
    const parts = ["first chunk", "second chunk", "third chunk"].map((s) => enc.encode(s));
    const batch = await chunkNames(parts);
    expect(batch).toHaveLength(3);
    for (let i = 0; i < parts.length; i++) {
      expect(batch[i]).toBe(await chunkName(parts[i]!));
    }
  });

  it("keeps the chunks in order, which is what reassembly depends on", async () => {
    const parts = Array.from({ length: 50 }, (_, i) => enc.encode(`chunk number ${i}`));
    const one = await Promise.all(parts.map((p) => chunkName(p)));
    // Across window boundaries and on both sides of one: a single window, the
    // default, windows that do not divide the file, and a window per chunk.
    for (const window of [1, 3, 7, NAME_WINDOW, 49, 50, 64]) {
      expect(await chunkNames(parts, window), `window ${window}`).toEqual(one);
    }
    expect(new Set(one).size, "the fixture is fifty distinct chunks").toBe(50);
  });

  it("handles a file with no chunks", async () => {
    expect(await chunkNames([])).toEqual([]);
  });
});

describe("base64url", () => {
  it("round trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(base64urlDecode(base64urlEncode(all))).toEqual(all);
  });

  it("round trips every length modulo 3, where padding bugs live", () => {
    for (let n = 0; n <= 12; n++) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff;
      expect(base64urlDecode(base64urlEncode(bytes)), `length ${n}`).toEqual(bytes);
    }
  });

  it("emits no padding and nothing needing escaping in JSON or a URL", () => {
    for (let n = 1; n <= 8; n++) {
      expect(base64urlEncode(new Uint8Array(n))).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("refuses a mangled value rather than decoding around it", () => {
    // Decoding around a stray character produces plausible bytes that fail
    // somewhere later, further from the cause: a device token that the
    // server refuses at every hello, or an invite that redeems nothing.
    expect(() => base64urlDecode("abc$def")).toThrow(/invalid base64url/);
    expect(() => base64urlDecode("abc=")).toThrow(/invalid base64url/);
    // Go's decoder skips CR and LF inside its input, so the alphabet is what
    // refuses them here (plan/protocol.md, "The invite string").
    expect(() => base64urlDecode("ab\ncd")).toThrow(/invalid base64url/);
    expect(() => base64urlDecode("ab\rcd")).toThrow(/invalid base64url/);
    expect(() => base64urlDecode("ab+/")).toThrow(/invalid base64url/);
  });

  it("refuses a length that leaves a dangling sextet", () => {
    // Four characters are three bytes; a fifth adds six bits and no byte, so
    // it used to decode to exactly the same three and any check downstream
    // saw the original value.
    const four = base64urlEncode(new Uint8Array([1, 2, 3]));
    for (const extra of ["A", "B", "_"]) {
      expect(() => base64urlDecode(four + extra), extra).toThrow(/one more than a whole number/);
    }
  });

  it("refuses unused bits that are not zero", () => {
    // One byte is two characters, and the last one carries four bits nothing
    // reads. Flipping them left the decoded byte alone.
    const two = base64urlEncode(new Uint8Array([0xff]));
    expect(base64urlDecode(two)).toEqual(new Uint8Array([0xff]));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(two[1]!);
    for (let flip = 1; flip < 16; flip++) {
      const damaged = two[0]! + alphabet[last ^ flip]!;
      expect(() => base64urlDecode(damaged), damaged).toThrow(/bits that no byte uses/);
    }
    // And the two unused bits two bytes leave, the other partial length.
    const three = base64urlEncode(new Uint8Array([0xff, 0xff]));
    const end = alphabet.indexOf(three[2]!);
    for (let flip = 1; flip < 4; flip++) {
      const damaged = three.slice(0, 2) + alphabet[end ^ flip]!;
      expect(() => base64urlDecode(damaged), damaged).toThrow(/bits that no byte uses/);
    }
  });
});

describe("random bytes", () => {
  it("returns as many as were asked for, and never the same twice", () => {
    for (const n of [0, 1, 16, 32]) expect(randomBytes(n)).toHaveLength(n);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(base64urlEncode(randomBytes(16)));
    expect(seen.size, "two draws of 16 random bytes agreed").toBe(100);
  });
});
