/**
 * Chunk body framing, protocol 1: one marker byte, then the raw chunk or its
 * raw DEFLATE (RFC 1951) stream (plan/protocol.md, "Chunk bodies").
 *
 * Framing lives at the transport boundary. Everything above it receives
 * verified raw chunks and never sees a marker. Compression is a wire encoding
 * only: a chunk's name is the SHA-256 of its raw bytes, so fflate here and
 * compress/flate on the server never have to agree on compressed output, only
 * on what it decodes to. The Go half is `internal/frame`.
 */

import { Inflate, deflateSync } from "fflate";

/** The raw marker. */
export const MARKER_RAW = 0;
/** The deflate marker. */
export const MARKER_DEFLATE = 1;

/** Why a frame was refused. Every kind maps to the wire code `badchunk`. */
export type FrameErrorKind = "empty" | "marker" | "toolarge" | "corrupt";

/** A refused frame, with which rule refused it. */
export class FrameError extends Error {
  constructor(
    readonly kind: FrameErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

/** How much of a chunk is tried before deciding whether to compress it. */
const PROBE_BYTES = 4096;

/**
 * Whether deflating a chunk is worth trying, from its first four kilobytes.
 * An optimisation only: `encodeFrame` still sends raw when the whole deflated
 * chunk is not shorter.
 */
function worthDeflating(chunk: Uint8Array): boolean {
  if (chunk.length <= PROBE_BYTES * 2) return true;
  const probe = chunk.subarray(0, PROBE_BYTES);
  return deflateSync(probe, { level: 6 }).length < probe.length;
}

/**
 * Frames raw bytes for the wire: deflated at level 6 when that is shorter,
 * raw otherwise. "Only when shorter" is what keeps every frame within the
 * receiver's `chunkMax + 1` bytes.
 */
export function encodeFrame(raw: Uint8Array): Uint8Array {
  if (raw.length > 0 && worthDeflating(raw)) {
    const deflated = deflateSync(raw, { level: 6 });
    if (deflated.length < raw.length) {
      const out = new Uint8Array(1 + deflated.length);
      out[0] = MARKER_DEFLATE;
      out.set(deflated, 1);
      return out;
    }
  }
  const out = new Uint8Array(1 + raw.length);
  out[0] = MARKER_RAW;
  out.set(raw, 1);
  return out;
}

/**
 * How much compressed input is fed to the inflater at a time (R13): the output
 * is watched as it is produced, so this decides how far past the limit one
 * push can go before it is seen.
 */
const INFLATE_SLICE = 4096;

/**
 * The raw chunk a frame carries, refusing anything that is not a well-formed,
 * non-empty chunk of at most `maxRaw` bytes.
 *
 * The length is checked before anything is inflated, and inflating is bounded
 * as it goes: fflate has no output ceiling of its own, and refusing a small
 * payload that expands without limit only after it is all in memory is the
 * difference between a message and a dead app on a phone. Bytes after the
 * final deflate block are ignored; they cannot change the decoded bytes, which
 * the chunk name checks.
 */
export function decodeFrame(frame: Uint8Array, maxRaw: number): Uint8Array {
  if (frame.length === 0) throw new FrameError("empty", "a frame with no marker");
  if (frame.length > maxRaw + 1) {
    throw new FrameError("toolarge", `a ${frame.length}-byte frame for a ${maxRaw}-byte limit`);
  }
  const payload = frame.subarray(1);
  if (frame[0] === MARKER_RAW) {
    if (payload.length === 0) throw new FrameError("empty", "a raw chunk of no bytes");
    return payload;
  }
  if (frame[0] !== MARKER_DEFLATE) throw new FrameError("marker", `unknown marker ${frame[0]}`);
  const parts: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  const inflater = new Inflate((piece, final) => {
    total += piece.length;
    if (total <= maxRaw) parts.push(piece);
    if (final) ended = true;
  });
  try {
    for (let at = 0; at < payload.length && !ended; at += INFLATE_SLICE) {
      const end = Math.min(at + INFLATE_SLICE, payload.length);
      inflater.push(payload.subarray(at, end), end === payload.length);
      if (total > maxRaw) throw new FrameError("toolarge", `inflates past ${maxRaw} bytes`);
    }
    if (!ended) inflater.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof FrameError) throw err;
    throw new FrameError("corrupt", `undecodable deflate stream: ${(err as Error).message}`);
  }
  if (!ended) throw new FrameError("corrupt", "the deflate stream ends early");
  if (total === 0) throw new FrameError("empty", "a deflated chunk of no bytes");
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of parts) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
