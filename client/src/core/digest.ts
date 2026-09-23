/**
 * Names, digests, random bytes and the one text encoding the wire uses.
 *
 * Everything here is a pure function of its input or of the platform's random
 * source, with no reference to Obsidian, to the transport or to any state, so
 * all of it can be exercised with WebCrypto and nothing else.
 *
 * A chunk's name is the lowercase hex SHA-256 of its raw bytes (plan/protocol.md,
 * "Chunk bodies"). The server recomputes it from every body it receives and
 * refuses a mismatch, and it can recompute it from every body it holds, so a
 * name is checkable by both ends from the bytes alone.
 */

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    // Not a condition to work around. Without WebCrypto nothing can be named,
    // and a name made some other way would be one the server refuses.
    throw new Error("WebCrypto is unavailable, so this device cannot name what it sends");
  }
  return c.subtle;
}

/** Random bytes from the platform, or a refusal. */
export function randomBytes(n: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    // Not a condition to work around: a credential from a weak source is worse
    // than no credential, because it looks like one.
    throw new Error("no secure random source is available, so no credential can be made here");
  }
  return c.getRandomValues(new Uint8Array(n));
}

/**
 * A chunk's name: the lowercase hex SHA-256 of its raw bytes.
 *
 * Must agree with the server's `chunks.Name` exactly. The server recomputes this
 * from the body it receives and refuses a mismatch, so a disagreement here is
 * caught on the first upload rather than becoming a corrupt vault.
 */
export async function chunkName(raw: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", toBuffer(raw));
  return hex(new Uint8Array(digest));
}

/**
 * How many chunks are hashed at once when a whole file is named.
 *
 * Hashing is mostly waiting on WebCrypto: awaited one chunk at a time it ran at
 * 56 MiB/s, and with one file's chunks in flight together at 151 MiB/s, measured
 * over 1,893 chunks of a real vault. A window rather than the whole file,
 * because each digest of a view into a larger buffer copies its chunk, and the
 * whole file in flight at once is a second copy of the file.
 */
export const NAME_WINDOW = 16;

/**
 * The names of a file's chunks, in order, hashed a window at a time.
 *
 * Exported because the property worth testing is that windowing changes nothing
 * but the time and the memory: the names must be exactly what naming each chunk
 * on its own produces, in the order the chunks came, or a file would be stored
 * under names no other device agrees with.
 */
export async function chunkNames(
  parts: readonly Uint8Array[],
  window = NAME_WINDOW,
): Promise<string[]> {
  const names: string[] = [];
  for (let at = 0; at < parts.length; at += window) {
    const named = await Promise.all(parts.slice(at, at + window).map((part) => chunkName(part)));
    for (const name of named) names.push(name);
  }
  return names;
}

/**
 * The digest of a local file, for deciding whether it is still the one a pass
 * decided about (R01).
 *
 * Not a chunk name and not the content id: those describe a chunk list, and
 * producing one from a file means chunking it, which is more work than a single
 * hash of the bytes as they are. This is used only to compare a file with itself
 * at two moments, and it never leaves the device.
 */
export async function plainDigest(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await subtle().digest("SHA-256", toBuffer(bytes))));
}

/**
 * Whether a string has the shape `chunkName` produces, and nothing else has.
 *
 * Beside the function that makes one, because the shape is that function's
 * output and nothing else. Three readers check it: a `get`, a recovery list and
 * the stored index. Each one is about to fetch by the name or key something on
 * it, and each had the pattern written out again.
 */
export function isChunkName(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/* ---------------------------------------------------------------- *
 * Encoding
 * ---------------------------------------------------------------- */

/**
 * A standalone ArrayBuffer holding exactly a view's bytes.
 *
 * WebCrypto accepts a BufferSource, but a Uint8Array that is a *view* into a
 * larger buffer has caused real bugs in this shape of code: passing the view's
 * buffer where the view was meant hands over neighbouring data. So the buffer
 * that leaves here always holds the view's bytes and nothing else.
 *
 * A view that already spans its whole buffer is that buffer, and copying it
 * only makes a second one with the same contents. The hazard cannot arise, so
 * the copy is skipped. It is the common case: a chunk read from a file owns its
 * bytes, and copying every one of them cost 1.36x on attachments.
 */
function toBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer as ArrayBuffer;
  }
  return view.slice().buffer;
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * base64url without padding, implemented rather than borrowed.
 *
 * `btoa` works on a string of char codes and needs a conversion that is easy to
 * get wrong for bytes above 0x7f, and Node's Buffer is not available in a
 * webview. Sixteen lines removes a platform difference from the encoding every
 * credential and invite on the wire travels in.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64URL[b0 >> 2]!;
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += B64URL[b2 & 0x3f]!;
  }
  return out;
}

const B64URL_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) m[B64URL.charCodeAt(i)] = i;
  return m;
})();

/**
 * Decodes base64url, refusing anything that is not exactly one encoding of the
 * bytes it produces.
 *
 * The two refusals at the end are what make the total-failure contract hold,
 * and both were once accepted. A length leaving six unconsumed bits is a string
 * with one character too many: those six bits produce no output byte, so an
 * invite with a character appended decoded to the original bytes and passed its
 * CRC, and a damaged credential was taken for the real one. Nonzero bits below
 * the last output byte are the same fault in the other direction: the low bits
 * of a final partial sextet are not read, so they could be flipped without
 * changing a byte, and the checksum never saw the difference.
 *
 * A canonical encoder never produces either, so nothing legitimate is refused.
 */
export function base64urlDecode(s: string): Uint8Array {
  const n = s.length;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const code = s.charCodeAt(i);
    const v = code < 128 ? B64URL_INDEX[code]! : -1;
    if (v < 0) {
      // Not silently skipped. A stray character means the value was mangled
      // in transit or storage, and decoding around it would produce plausible
      // bytes that fail somewhere later, further from the cause.
      throw new Error(`invalid base64url character ${JSON.stringify(s[i])} at position ${i}`);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits === 6) {
    throw new Error(
      `this base64url value is ${n} characters, which is one more than a whole number of bytes: ` +
        "the last character adds no byte and something has been added to it or lost from it",
    );
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Error(
      `this base64url value ends with ${bits} bits that no byte uses, and they are not zero, ` +
        "so it is not the encoding of the bytes it decodes to",
    );
  }
  return out.subarray(0, o);
}
