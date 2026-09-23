/**
 * Content-defined chunking: a Rabin-Karp rolling hash decides where chunks end.
 *
 * The idea and the parameters come from LiveSync's `splitPiecesRabinKarp`, read
 * at `livesync-commonlib/src/string_and_binary/chunks.ts:493`. Two things are
 * done differently and both are deliberate; they are noted where they occur.
 *
 * ## Why a rolling hash rather than fixed offsets
 *
 * Cut a file every 64 KiB and inserting one line near the top shifts every
 * subsequent boundary, so every chunk after the edit is new and the whole file
 * uploads again. Cut where a hash of the last 48 bytes says to, and an insert
 * changes the one chunk containing it: the boundaries either side are decided by
 * content that did not move.
 *
 * The property that makes it work is worth stating because it is not obvious.
 * The boundary test is `hash % average === 1`, so each position has a 1-in-average
 * chance of ending a chunk, independent of where it is. Chunk lengths come out
 * exponentially distributed around the average without anything tracking
 * position, which is why an insert cannot shift the pattern downstream.
 */

/**
 * Rolling hash window, in bytes.
 *
 * 48 is LiveSync's, and the size matters in one direction: the window is the
 * amount of context deciding each boundary, so too small and boundaries move
 * with tiny edits, too large and the hash takes longer to forget an edit that
 * has passed. It is not a tunable and there is no setting for it.
 */
import { CHUNKING_TEXT_EXTENSIONS, chunkingText } from "./path-policy.ts";

export const WINDOW = 48;

/** Multiplier for the rolling hash. */
const PRIME = 31;

/**
 * The residue that ends a chunk. Any fixed value in range does; this one is
 * LiveSync's.
 *
 * `hash % avg` reads only the low bits when `avg` is a power of two, and a
 * polynomial hash with PRIME = 31 is often said to mix those badly, since
 * 31 = 32 - 1. Measured against 15.4 MiB of real markdown the worry does not
 * survive: the mean chunk came out at 352 B against a 384 B target, a ratio of
 * 0.92. A prime modulus or skipping the low byte both reach 0.97, which is 3.7%
 * fewer chunks and not worth diverging from a well-tested reference for. Written
 * down so the measurement does not have to be repeated to settle it again.
 */
const BOUNDARY = 1;

/**
 * Whether the rolling hash says to cut here.
 *
 * This is `(hash >>> 0) % avg === BOUNDARY`, which is what it used to say and
 * what it still means. `hash >>> 0` is a double above 2^31, so `%` is a
 * floating point remainder, and V8 calls out to fmod for it once per byte: 32
 * MiB/s against 996 for the same answer written without a division. JavaScript-
 * Core is indifferent, every benchmark here was taken under it, and the shipped
 * CLI runs node. That is how a 31x cost in the hottest loop in the project
 * stayed invisible.
 *
 * Exact, not approximate. `u % avg === BOUNDARY` iff
 * `floor(u / avg) * avg === u - BOUNDARY`, given `0 <= BOUNDARY < avg`, which
 * holds because BOUNDARY is 1 and the smallest avg any size table produces is
 * 1024. For `u < 2^32` and `avg <= 2^18`, which `sizesFor` guarantees, a
 * double's ulp near 2^32 is 2^-21 while the true quotient sits at least
 * `1/avg >= 2^-18` below the next integer whenever the remainder is non-zero:
 * two orders of margin. `chunk.test.ts` walks it against the modulo it replaces
 * for every avg the size tables can produce.
 *
 * Cutting differently is not a performance question. A boundary that moved
 * would rechunk every vault, rename every chunk, and deduplicate against
 * nothing.
 */
function atBoundary(hash: number, avg: number): boolean {
  const u = hash >>> 0;
  return Math.floor(u / avg) * avg === u - BOUNDARY;
}

/**
 * Chunk size targets.
 *
 * Text and binary get different sizes for the same reason LiveSync separates
 * them: prose is edited in small pieces and deduplicates well at a few hundred
 * bytes, while an attachment is either the same file or a different one and
 * chunking it finely buys nothing but overhead.
 *
 * Every one of these is a constant with its reasoning attached rather than a
 * setting. docs/design.md: a question with a right answer is answered once
 * in the source.
 */
export interface ChunkSizes {
  readonly min: number;
  readonly avg: number;
  readonly max: number;
}

/**
 * Text: 512 B / 1 KiB / 4 KiB.
 *
 * Four times LiveSync's, which is where these started, and the change was
 * measured rather than reasoned. The cost that dominates is not the chunk
 * bodies, it is their names: a put carries every chunk name of the file, 64
 * characters each, whether anything changed or not. At a 256-byte average a
 * 14 KiB note is forty chunks, so the name list alone is 2.5 KiB and an edit
 * costs more in names than in content.
 *
 * Measured over this project's own markdown and source, 80 files, 1155 KiB:
 *
 *     average   chunks/file   first sync   one edit   chunk rows
 *         256          40.4          85%     3030 B         3230
 *        1024          10.4          52%     1732 B          832
 *        4096           3.3          40%     2538 B          260
 *
 * 256 is worse than 1024 on every column. 4 KiB is cheaper again on a first
 * sync and dearer on every edit after it, and edits are the case that repeats,
 * so 1 KiB is the middle that wins.
 *
 * The minimum matters more than it looks. Without it a run of low-entropy
 * content can fire the boundary test repeatedly and produce a chunk every few
 * bytes, and every chunk costs 64 characters of name in each put and a row on
 * the server. A floor bounds that; without one it is unbounded.
 */
export const TEXT_SIZES: ChunkSizes = { min: 512, avg: 1024, max: 4096 };

/** A chunk name on the wire: 64 hex characters of SHA-256. */
export const NAME_BYTES = 64;

/** The band the average is kept inside, whatever the arithmetic says. */
const TEXT_AVG_MIN = TEXT_SIZES.avg;
const TEXT_AVG_MAX = 64 * 1024;

/**
 * Chunk sizes for a text file, scaled to how big it is.
 *
 * A put carries every chunk name of the file, so sending an edit costs roughly
 * one chunk body plus sixty-four bytes for each chunk the file has:
 *
 *     cost(c) ~ c + NAME_BYTES * size / c
 *
 * which is least at `c = sqrt(NAME_BYTES * size)`. One fixed size cannot be
 * right for both a 2 KiB note and a 2 MiB one, and 1 KiB chunks for the latter
 * make it two thousand chunks whose names alone are 128 KiB, so an edit to it
 * costs more in names than the note contains.
 *
 * Clamped at both ends. Below the floor a chunk's fixed costs, its name in
 * every put and its row on the server, start to matter more than the bytes it
 * saves; above the ceiling the chunks are large enough that an edit stops
 * being cheap, which is the whole point of chunking.
 */
export function textSizesFor(size: number): ChunkSizes {
  const ideal = Math.sqrt(NAME_BYTES * Math.max(size, 1));
  const avg = Math.min(TEXT_AVG_MAX, Math.max(TEXT_AVG_MIN, Math.round(ideal / 512) * 512));
  return { min: Math.max(TEXT_SIZES.min, avg / 2), avg, max: avg * 4 };
}

/**
 * Binary: 128 KiB / 256 KiB / 1 MiB.
 *
 * LiveSync uses 256 KiB / 1 MiB / 4 MiB here, and this is a deliberate departure
 * measured against a real vault rather than argued. Chunked with LiveSync's
 * numbers, that vault produced a single 4 MiB chunk, which the server refuses:
 * its `chunkMax` is 1 MiB. So the choice was to raise the server's ceiling or
 * lower these, and lowering them wins on every count that matters here.
 *
 * A 1 MiB ceiling means a phone never holds four megabytes for one chunk, and
 * the chunk counts stay trivial either way. Measured on that vault: its largest
 * file is 7.2 MiB, which was 4 chunks at LiveSync's sizes and is 19 at these,
 * and no chunk in 78.8 MiB across 3,730 files now exceeds 1.0 MiB. Nineteen is
 * nothing, and finer chunks deduplicate better when a large attachment is
 * edited rather than replaced.
 *
 * LiveSync's larger sizes are not a mistake on their side. Each of their chunks
 * is a CouchDB document, so a chunk carries a document's cost and fewer is
 * better. TrewSync writes a file into a content-addressed directory.
 */
export const BINARY_SIZES: ChunkSizes = { min: 128 * 1024, avg: 256 * 1024, max: 1024 * 1024 };

/**
 * Above this, a text file is chunked as binary.
 *
 * LiveSync's threshold, and its reasoning holds here: a 4 MiB note at a 256-byte
 * average is sixteen thousand chunks, and sixteen thousand of anything per file
 * is a performance problem in whichever layer touches it first. A note that
 * large is not prose being edited, it is data in a text file.
 */
export const TEXT_AS_BINARY_ABOVE = 4 * 1024 * 1024;

/**
 * The smallest chunk ceiling the chunker can work under.
 *
 * A window's worth of data is the least that can produce a boundary at all, so
 * `sizesFor` raises any maximum to this. A server advertising a `chunkMax` below
 * it would therefore be sent chunks larger than it takes, and would refuse every
 * one of them for ever; the engine refuses such a server at the handshake
 * instead (docs/development.md, "Latent issues in the chunker").
 */
export const CHUNK_FLOOR = WINDOW * 4;

/**
 * Chooses sizes for a file, clamped to what the server will accept.
 *
 * `serverChunkMax` comes from the handshake. Clamping here rather than trusting
 * the constants means a server with a smaller ceiling produces smaller chunks
 * instead of rejected puts, and a client that has not asked yet still gets
 * something sane.
 *
 * The protocol 1 rule, which Go's `SizesFor` implements too and
 * `chunk-fixtures.json` pins for both (`sizesForV1`): `max = min(base.max,
 * serverChunkMax)`, then raised to `CHUNK_FLOOR`, with `min` and `avg` clamped
 * to it.
 */
export function sizesFor(
  size: number,
  isText: boolean,
  serverChunkMax: number = BINARY_SIZES.max,
): ChunkSizes {
  if (!Number.isFinite(serverChunkMax) || serverChunkMax <= 0) serverChunkMax = BINARY_SIZES.max;
  const base = isText && size < TEXT_AS_BINARY_ABOVE ? textSizesFor(size) : BINARY_SIZES;

  // The ceiling is on the raw chunk (plan/protocol.md, "Chunk bodies"). A body
  // frame's marker byte sits on top of it, and deflate is sent only when it is
  // shorter, so a chunk cut at exactly `chunkMax` is one the server takes.
  // Nothing is reserved below it: an allowance kept here would be one the
  // server does not count, and the two ends would disagree about the largest
  // chunk for no gain.
  const max = Math.min(base.max, serverChunkMax);
  // A window's worth of data is the least that can produce a boundary at all,
  // so a maximum below it would make every chunk a forced cut and the rolling
  // hash pointless. Clamping up keeps the algorithm meaningful; a server
  // advertising less than this is refused at the handshake (`CHUNK_FLOOR`).
  const clampedMax = Math.max(max, CHUNK_FLOOR);
  return {
    min: Math.min(base.min, clampedMax),
    avg: Math.min(base.avg, clampedMax),
    max: clampedMax,
  };
}

/**
 * Moves a cut back off an incomplete character.
 *
 * The question is asked of the chunk itself, not of the byte after it: does
 * `data[start..end)` end part way through a UTF-8 sequence? That is decidable
 * from the trailing bytes alone, and it matters because a streaming splitter has
 * no next byte to look at. An earlier version asked the lookahead question and
 * needed a one-byte delay to answer it, which made the streaming and in-memory
 * paths disagree on forced cuts; asking it this way lets both share one rule.
 *
 * Backing off rather than extending is deliberate. Extending past the character
 * keeps it whole too, and makes the chunk exceed the maximum, and the maximum is
 * what the server advertised as `chunkMax`. Three bytes over a limit is a put
 * refused for a file the user simply has.
 *
 * Returns `end` unchanged when backing off would empty the chunk, which needs a
 * maximum smaller than one character. `sizesFor` will not produce one, but a
 * zero-length chunk is worth closing rather than reasoning away.
 */
function trimIncompleteCharacter(data: Uint8Array, start: number, end: number): number {
  // Find the lead byte of the last sequence.
  let lead = end - 1;
  while (lead > start && (data[lead]! & 0xc0) === 0x80) lead--;
  if (lead < start) return end;

  const b = data[lead]!;
  const expected =
    b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
  if (end - lead >= expected) return end; // complete, nothing to do
  return lead > start ? lead : end;
}

/** One chunk: where it came from, and its bytes. */
export interface Chunk {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/**
 * Splits bytes into content-defined chunks.
 *
 * A generator, and synchronous, because the caller decides what to do with each
 * chunk (name it, decide whether the server already has it, send it) and holding
 * a whole file's worth of chunks to hand back at the end would double the peak
 * memory for no gain.
 *
 * ## The two departures from LiveSync
 *
 * It takes a `Uint8Array` and never a Blob. LiveSync reads the entire file into
 * memory with `await dataSrc.arrayBuffer()` before chunking, which for a vault
 * of notes is fine and for a vault with video attachments is not. The algorithm
 * only ever looks at a 48-byte window, so it is inherently streamable;
 * `chunkStream` below does that, and this function is the in-memory case it is
 * built from.
 *
 * It does not base64 anything. LiveSync encodes binary chunks because CouchDB
 * stores strings; TrewSync sends binary WebSocket frames, so the bytes go as
 * bytes and a third of the transfer is not spent on encoding.
 */
export function* chunkBytes(
  data: Uint8Array,
  sizes: ChunkSizes,
  isUtf8: boolean,
): Generator<Chunk> {
  const { min, avg, max } = sizes;
  const length = data.length;

  // An empty input yields nothing, and needs no special case to do it: the
  // loop does not run and the trailing yield is guarded. That is the right
  // answer rather than an accident. The protocol says a file has chunks if and
  // only if it has content, so an empty note carries none and the server
  // refuses one that carries any.

  // PRIME^(WINDOW-1), for removing the byte leaving the window. Math.imul
  // keeps the arithmetic in 32 bits, which is what makes the rolling update
  // exact rather than drifting through float precision.
  let pPowW = 1;
  for (let i = 0; i < WINDOW - 1; i++) pPowW = Math.imul(pPowW, PRIME);

  let start = 0;
  let hash = 0;

  for (let pos = 0; pos < length; pos++) {
    const byte = data[pos]!;

    if (pos >= start + WINDOW) {
      // Roll: drop the byte that has left the window, take in the new one.
      hash = (hash - Math.imul(data[pos - WINDOW]!, pPowW)) | 0;
      hash = Math.imul(hash, PRIME);
      hash = (hash + byte) | 0;
    } else {
      // Still filling the first window of this chunk.
      hash = Math.imul(hash, PRIME);
      hash = (hash + byte) | 0;
    }

    const size = pos - start + 1;
    let boundary = size >= min && atBoundary(hash, avg);
    // A forced cut at the maximum. Without it a file with no boundary in it
    // is one chunk however large, which the server would refuse.
    if (size >= max) boundary = true;

    if (boundary) {
      // Framing and reassembly are byte exact, so splitting a character
      // would corrupt nothing. It would make a chunk that is not valid
      // UTF-8 on its own, which cannot be diffed, logged or looked at, and
      // LiveSync carries a regression test for a U+FEFF landing here.
      const end = isUtf8 ? trimIncompleteCharacter(data, start, pos + 1) : pos + 1;
      yield { offset: start, bytes: data.subarray(start, end) };
      start = end;
      hash = 0;
      // The bytes backed over have not been hashed into the new chunk, so
      // rewind to re-read them. `end > start` always holds, so this
      // terminates.
      pos = end - 1;
    }
  }

  if (start < length) {
    yield { offset: start, bytes: data.subarray(start, length) };
  }
}

/**
 * The rolling hash over a stream, as a class so its loop is a method.
 *
 * The only reason this is not a closure inside `chunkStream` is that the loop
 * has to be somewhere JavaScriptCore will optimise, and an async generator body
 * is not. See the comment at the call site.
 */
class Roller {
  used = 0;
  hash = 0;

  constructor(
    private readonly buf: Uint8Array,
    private readonly sizes: ChunkSizes,
    private readonly pPowW: number,
  ) {}

  /**
   * Consumes bytes from `block` starting at `from` until a chunk is due.
   *
   * Returns the index to resume at, or -1 when the block ran out first. The
   * caller cuts and calls again.
   */
  scanTo(block: Uint8Array, from: number): number {
    const { min, avg, max } = this.sizes;
    const buf = this.buf;
    const pPowW = this.pPowW;
    let used = this.used;
    let hash = this.hash;

    for (let i = from; i < block.length; i++) {
      const byte = block[i]!;
      buf[used++] = byte;
      if (used >= WINDOW + 1) {
        hash = (hash - Math.imul(buf[used - 1 - WINDOW]!, pPowW)) | 0;
        hash = Math.imul(hash, PRIME);
        hash = (hash + byte) | 0;
      } else {
        hash = Math.imul(hash, PRIME);
        hash = (hash + byte) | 0;
      }

      if (used >= max || (used >= min && atBoundary(hash, avg))) {
        this.used = used;
        this.hash = hash;
        return i + 1;
      }
    }

    this.used = used;
    this.hash = hash;
    return -1;
  }
}

/**
 * Splits a stream into content-defined chunks, holding at most one chunk plus a
 * window in memory.
 *
 * This is the departure from LiveSync that matters most. The boundary decision
 * needs 48 bytes of history and nothing else, so there is no reason to hold a
 * 700 MB attachment in memory to chunk it, and on a phone there is every reason
 * not to.
 *
 * The chunk being accumulated is bounded by `sizes.max`, so peak memory is that
 * plus one incoming block, whatever the file size.
 */
export async function* chunkStream(
  blocks: AsyncIterable<Uint8Array>,
  sizes: ChunkSizes,
  isUtf8: boolean,
): AsyncGenerator<Chunk> {
  const { max } = sizes;

  let pPowW = 1;
  for (let i = 0; i < WINDOW - 1; i++) pPowW = Math.imul(pPowW, PRIME);

  // The chunk under construction. Sized to the maximum once, then reused.
  const buf = new Uint8Array(Math.max(max, WINDOW * 2));
  let used = 0;
  let hash = 0;
  let offset = 0;

  // Trimming an incomplete character looks only at bytes already in the
  // buffer, so this needs no lookahead and no pending state. That is what lets
  // both implementations share one rule.
  const cut = (): Chunk => {
    const end = isUtf8 ? trimIncompleteCharacter(buf, 0, used) : used;
    const chunk = { offset, bytes: buf.slice(0, end) };
    offset += end;
    // Whatever was backed over stays, and is rehashed as the next chunk's
    // opening bytes.
    const carry = used - end;
    buf.copyWithin(0, end, used);
    used = carry;
    hash = 0;
    for (let i = 0; i < carry; i++) {
      hash = Math.imul(hash, PRIME);
      hash = (hash + buf[i]!) | 0;
    }
    return chunk;
  };

  // The byte loop lives in a plain function, not in this generator's body.
  //
  // JavaScriptCore does not optimise a hot loop inside an async generator:
  // the same arithmetic moved out of one goes from 39 MiB/s to 700. V8 is
  // indifferent to this and JavaScriptCore is indifferent to the modulo in
  // `atBoundary`, so the two defects are disjoint and both engines were slow,
  // each for its own reason. iOS is JavaScriptCore, which makes this the
  // mobile half.
  const roll = new Roller(buf, sizes, pPowW);
  for await (const block of blocks) {
    let from = 0;
    for (;;) {
      const at = roll.scanTo(block, from);
      if (at < 0) break;
      used = roll.used;
      yield cut();
      roll.used = used;
      roll.hash = hash;
      from = at;
    }
    used = roll.used;
  }

  if (used > 0) {
    // The remainder, whatever it is. No backing off: there is no next
    // character to protect.
    const chunk = { offset, bytes: buf.slice(0, used) };
    offset += used;
    used = 0;
    yield chunk;
  }
}

/**
 * Reads a Blob as blocks, for feeding chunkStream.
 *
 * 1 MiB blocks: large enough that the per-slice cost disappears, small enough
 * that peak memory is bounded by something other than the file.
 */
export async function* blobBlocks(blob: Blob, blockSize = 1024 * 1024): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < blob.size; at += blockSize) {
    yield new Uint8Array(await blob.slice(at, Math.min(at + blockSize, blob.size)).arrayBuffer());
  }
}

/**
 * The extensions whose files are chunked, and merged, as text.
 *
 * The list lives once, in the protocol's format policies (`chunkingText` in
 * path-policy.ts, with its Go twin in `internal/paths`), and this is a view of
 * it for the callers that want a set. It includes `.base`, Obsidian's Bases:
 * YAML, a few hundred bytes, and edited from a table view on every device, so
 * as an attachment it took the 128 KiB binary minimum for a one-line change, it
 * conflicted rather than merged, and its history showed "preview unavailable"
 * (R083-12).
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(CHUNKING_TEXT_EXTENSIONS);

/**
 * Guesses whether a path holds text, for choosing chunk sizes.
 *
 * A guess, and only ever used to pick sizes and whether to merge: getting it
 * wrong costs efficiency and never correctness, because both paths are byte
 * exact. Extension based rather than content sniffing, because the answer is
 * wanted before the file is read. It is the protocol's `chunkingText` policy,
 * so the server's chunker and this one agree on which files are text.
 */
export function looksLikeText(path: string): boolean {
  return chunkingText(path);
}

/**
 * Extensions whose contents have to parse as JSON to be usable.
 *
 * `.canvas` is Obsidian's own, and a canvas that does not parse is one the
 * application refuses to open. They are still merged as text, because a
 * line-wise merge of two edits to different parts of a document is usually
 * right; what changes is that the result is checked before it is accepted.
 *
 * The list stops here, and that was measured rather than assumed. `.svg`,
 * `.xml`, `.csv` and the source extensions are all in `TEXT_EXTENSIONS` and
 * merge with nothing looking at the result, which reads like the same hole
 * the canvas corpus found. It is not, and the reason is one character.
 *
 * What breaks a canvas is the comma between two siblings: both devices turn
 * `"edges":[]` into three lines, the merge concatenates two edge objects with
 * nothing between them, and every other check passes. XML has no separator
 * between siblings, so the same edit produces `<rect/><rect/>` and the file is
 * as well formed as either side alone. One document tree, one set of
 * mutations, four writers: as a canvas, 299 of 17,415 clean merges do not
 * parse; as SVG, 0 of 18,229 one element per line, 0 of 19,333 the way
 * Inkscape writes one, and 0 of 15,698 minified. `.csv` does go ragged, 600 of
 * 16,793, and in every one of those every row is a row a device wrote, so
 * nothing is lost and a conflict copy would be the worse record.
 *
 * So no gate for them, and no refusal to merge them either, which would have
 * cost 53% of those merges to catch none. `core/markup.test.ts` holds the
 * corpus, the control that keeps it honest, and the twelve adversarial pairs.
 */
const JSON_EXTENSIONS = new Set(["canvas", "json"]);

/**
 * Extensions whose contents have to be readable as YAML.
 *
 * `.base` is Obsidian's own, and the same argument as `.canvas`: it is edited
 * as structure from a table view, a merge of two structural edits is usually
 * right, and the one that is not is worth catching before it reaches a reader
 * that will silently drop half of it. See `parsesAsYaml` for which of YAML's
 * rules the gate checks and why the rest are out of scope.
 */
const YAML_EXTENSIONS = new Set(["base", "yml", "yaml"]);

export function looksLikeYaml(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return YAML_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function looksLikeJson(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return JSON_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
