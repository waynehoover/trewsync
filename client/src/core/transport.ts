/**
 * The wire, and nothing above it.
 *
 * This module knows the protocol and no policy: what a `put` looks like, not
 * when to send one. That boundary is the cleanest thing in Obsidian's engine,
 * where a 66-method engine collaborates with a 20-method transport that decides
 * nothing.
 *
 * ## Shape, taken from Obsidian's transport, and one thing not taken
 *
 * Read at `app.pretty.js:176823` onwards. Two decisions there are right and are
 * kept:
 *
 *   - **A queue for binary frames.** Bodies can arrive before the loop that
 *     reads them is running, so they are buffered rather than dropped.
 *     Obsidian's `dataQueue`.
 *   - **A timeout closes the connection.** A request that did not answer leaves
 *     the session's state unknown, and continuing on an unknown state is how two
 *     ends desync. Obsidian rejects and disconnects; so does this.
 *
 * The third, one promise slot resolved by the next reply that is not a
 * notification, is what this transport used to do and what request ids
 * removed. Matching a reply to a request by position produced three separate
 * defects here: an acknowledgement arriving from inside the last `send`,
 * before its waiter was armed, read as a reply nobody asked for; a
 * shutdown notice read as a bad reply; and the bodies of a refused fetch
 * consumed as the answer to the next one. Every request now carries an
 * `id` and every reply echoes it, so a reply is matched to its request by name
 * and a reply with no name is a notification or the reason the connection is
 * closing. docs/protocol.md, "Request ids".
 *
 * And one thing every client of this protocol has to do, which is worth saying
 * plainly because the first two written against it got it wrong: **replies are
 * multiplexed with notifications.** Another device can commit at any moment, so a
 * batch can arrive between any request and its answer. Anything that assumes the
 * next frame is its reply will read a batch as an answer and hang.
 */

import { notifyTransfer } from "./transfer.ts";
import { base64urlDecode, chunkName, isChunkName } from "./digest.ts";
import { FrameError, decodeFrame, encodeFrame } from "./frame.ts";

/**
 * The protocol version this client speaks. A mismatch is refused, not negotiated.
 *
 * Version 2 of TrewSync's protocol (plan/protocol.md): version 1, which is
 * Basalt's protocol 7 with the encryption taken out, and undo (`undo`, and the
 * operation behind each `history` entry). A server of protocol 2 still answers
 * a client of protocol 1, so the upgrade order is the server first; this
 * client meeting a server of protocol 1 is refused at hello, and says so.
 */
export const PROTO = 2;

/** How long a request may go unanswered before the connection is considered dead. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The most bytes a `vault` or `device` name may be, and the rule on what is in
 * it: no byte below 0x20 and not 0x7f. Both land in the server's log lines and
 * on every entry a device writes, and a newline in a log line is a forged log
 * line. The server refuses either fault with `badname` and ends the session;
 * checking here first means a bad name is one error at pairing rather than a
 * connection that dies on every attempt.
 */
export const MAX_NAME_BYTES = 64;

/**
 * The most chunk names one `fetch` may carry. The server's own bound on a chunk
 * list, and it refuses more with `toolarge`; a client splits before that.
 */
export const MAX_FETCH_NAMES = 65536;

/**
 * The budget of one entry, as the server accounts it: its declared size, which
 * is the sum of its chunks' raw lengths (plan/protocol.md, "Limits"). The
 * server bounds a `putmany` by the sum of these and a `fetch` by the summed
 * raw sizes of the bodies it serves. One function, so the client and the
 * server add the same thing up.
 */
export function entryBudget(size: number): number {
  return size;
}

/** A deletion as the server lists it: an entry, and whether anything restores it. */
export interface WireDeletion extends WireEntry {
  /**
   * The newest version with content, or 0 when purge has taken them all.
   *
   * Optional because nothing validates it, and the reader defaults it to 0.
   * Declared required, the default read as dead code and the type read as a
   * promise the parser does not keep.
   */
  readonly restorable?: number;
}

/**
 * One version as the server hands it over.
 *
 * `uid`, `path` and `chunks` are the three the parsers check, because they are
 * the three a reader cannot do without. The engine then holds every entry to
 * `checkEntryShape`, which is the server's own list of rules, because a server
 * is not obliged to be honest and nothing else checks what it says. Devices
 * trust the server's word about who wrote an entry: protocol 1 carries no
 * writer authenticity (PLAN.md section 3.6).
 */
export interface WireEntry {
  readonly uid: number;
  readonly path: string;
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly folder: boolean;
  readonly deleted: boolean;
  readonly device: string;
  readonly prev?: string;
  readonly chunks: string[];
  /**
   * On a `history` entry, the operation that wrote the version, when an agent
   * or an undo did (protocol 2). Never on a batch entry.
   */
  readonly op?: OperationRef;
}

/**
 * The operation that wrote a version, as a history names it (plan/protocol.md,
 * "Undo (protocol 2)"): the id an undo names, what it was, who made it, and
 * the undo in place that undid it, if one has.
 */
export interface OperationRef {
  readonly id: string;
  /** What it was: an agent's tool (`edit_note`, `move_note`, ...), `undo` or `undo_to_copy`. */
  readonly tool: string;
  /** Who made it: `mcp` an agent's token, `operator` `trewd undo`, `device` a device's undo. */
  readonly kind: string;
  readonly undoneBy?: string;
}

/** One thing an undo did, in the order it did them. */
export interface UndoStep {
  /**
   * `restore`, `move_back` (from `from`), `remove`, `remove_folder`,
   * `keep_folder` (with `why`), `make_folder`, `copy` (to `copy`), or
   * `nothing` (in a copy, a path with nothing to copy).
   */
  readonly action: string;
  readonly path: string;
  readonly from?: string;
  readonly copy?: string;
  readonly before?: number;
  readonly after?: number;
  readonly why?: string;
}

/** What an undo committed: its own id, what it undid, and what it did. */
export interface UndoResult {
  readonly opId: string;
  readonly undoes: string;
  readonly toCopy: boolean;
  readonly committedAt: number;
  readonly steps: UndoStep[];
  /** The versions it wrote, which also reach this device in a batch. */
  readonly entries: { path: string; uid: number; previousUid: number; prev?: string }[];
}

/** A covered range of the uid sequence, with everything in it that exists. */
export interface Batch {
  readonly from: number;
  readonly to: number;
  readonly entries: WireEntry[];
}

/** What the server advertises in reply to hello. */
export interface ServerLimits {
  readonly proto: number;
  /** The oldest protocol the server still answers. */
  readonly minProto: number;
  /** The server's release, for an error that names both ends. */
  readonly serverVersion: string;
  /**
   * The store's epoch, an opaque string (PLAN.md section 2.8).
   *
   * Minted when the store was made and new in every backup of it, so a
   * different one means the server's history was restored or replaced and the
   * uid sequence a cursor points into may have been reissued. A device keeps
   * it beside its cursor and sends it back at the next hello.
   */
  readonly epoch: string;
  /** The newest uid the server holds. */
  readonly cursor: number;
  readonly perFileMax: number;
  readonly chunkMax: number;
  readonly maxChunks: number;
  /** The largest encoded `putmany` frame, and the largest summed entry budget in one. */
  readonly maxBatchBytes: number;
  /** The most body bytes one `fetch` may ask for, as summed entry budget. */
  readonly maxFetchBytes: number;
}

/**
 * One outstanding invite, as the server hands it over.
 *
 * Its id, its label and its expiry, and deliberately nothing else. The id is a
 * non-secret handle minted beside the invite's token and not derived from it,
 * so a reader of this list cannot redeem anything; what the id is for is
 * saying which invite to cancel (plan/protocol.md, "Devices and invites").
 */
export interface InviteRow {
  /** The invite's id, which `uninvite` takes. Never the token. */
  readonly invite: string;
  /** A name for it a person reads, or "" when it was given none. */
  readonly label: string;
  /** When it stops working, in server milliseconds, or null for an invite that never expires. */
  readonly expiresAt: number | null;
}

/**
 * A freshly minted invite, as the device that asked for it is told.
 *
 * `token` is the whole credential: the one field anywhere in the protocol that
 * can redeem an invite, sent once, to this device. It is formatted into a
 * `trew1i_` string with this device's own server address and vault
 * (`formatInviteString`), and nothing here keeps it.
 */
export interface MintedInvite {
  /** The non-secret id the device list shows and `uninvite` takes. */
  readonly invite: string;
  /** The 16-byte redemption token, unpadded base64url. */
  readonly token: string;
  /** When it stops working, in server milliseconds, or null for never. */
  readonly expiresAt: number | null;
}

/** One device's row in the vault's list, as the server hands it over. */
export interface DeviceRow {
  /** The identity: chosen by that device, unique in the vault, never the name. */
  readonly id: string;
  /** A label a person reads. Two devices may share one. */
  readonly name: string;
  readonly createdAt: number;
  /** Zero until that device has connected once. */
  readonly lastSeen: number;
  readonly online: boolean;
  /** Successful local application in a live session; null means unconfirmed. */
  readonly applied: number | null;
}

/** Metadata for a put. Mirrors the protocol's `meta` object exactly. */
export interface PutMeta {
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly folder?: boolean;
  readonly deleted?: boolean;
  /** The previous path on a rename, so a rename is one operation. */
  readonly prev?: string;
}

/** One version in a batched write. */
export interface BatchEntry {
  readonly path: string;
  readonly meta: PutMeta;
  readonly names: readonly string[];
  /** Expected current UID; zero (the default) asserts there is no live entry. */
  readonly base?: number;
  /** A rename's expected source UID. Sent only with `meta.prev`. */
  readonly prevBase?: number;
}

/** What became of one entry in a batch. */
export interface BatchResult {
  /** The uid the server gave it, or zero if this entry alone was refused. */
  readonly uid: number;
  /** Why it was refused. The other entries in the batch still committed. */
  readonly error?: ProtocolError;
}

/**
 * The most entries one batch may hold. The server refuses more; this matches
 * wire.MaxBatchEntries so a client splits rather than being told to.
 */
export const MAX_BATCH_ENTRIES = 256;

/** The meta a put sends. Written once, because two copies drift. */
function wireMeta(meta: PutMeta): Record<string, unknown> {
  return {
    size: meta.size,
    ctime: meta.ctime,
    mtime: meta.mtime,
    folder: meta.folder ?? false,
    deleted: meta.deleted ?? false,
    ...(meta.prev ? { prev: meta.prev } : {}),
  };
}

/**
 * The conditional-write fields of one write, as the wire carries them.
 *
 * `base` always, zero meaning no live entry. `prevBase` only on a rename,
 * which is the only write that has a source (plan/protocol.md, "Writing").
 */
function conditions(meta: PutMeta, base?: number, prevBase?: number): Record<string, unknown> {
  return { base: base ?? 0, ...(meta.prev ? { prevBase: prevBase ?? 0 } : {}) };
}

/** One entry as it travels inside a `putmany`. */
function wireEntry(e: BatchEntry): Record<string, unknown> {
  return {
    path: e.path,
    meta: wireMeta(e.meta),
    chunks: [...e.names],
    ...conditions(e.meta, e.base, e.prevBase),
  };
}

const utf8 = new TextEncoder();

/** How many bytes of UTF-8 a text frame holding `text` is. */
function frameBytes(text: string): number {
  return utf8.encode(text).length;
}

/**
 * How many bytes one entry adds to an encoded `putmany` frame.
 *
 * Measured by encoding it, because an estimate is the kind of thing that is
 * right until a path is long. Bytes of UTF-8, not characters: paths travel in
 * plaintext, and a note called in Greek is twice as many bytes as characters.
 * The one byte is the comma between entries.
 */
export function encodedEntryBytes(e: BatchEntry): number {
  return frameBytes(JSON.stringify(wireEntry(e))) + 1;
}

/**
 * What an encoded `putmany` costs before any entry is in it: the op, the id
 * at its widest, and the brackets. Generous rather than exact, because the
 * client has to stay under a cap it cannot measure until the frame exists.
 */
export const PUTMANY_FRAME_OVERHEAD = 64;

/**
 * Codes after which the session is over, whatever else is true.
 *
 * The "session" column of the error table in docs/protocol.md. A caller that
 * carried on after one of these would be talking to a connection the server
 * has closed, or one where the two ends no longer agree how many frames are
 * outstanding. `internal` is in the list because the doc ends the session on
 * it during handshake and catch-up, and a client cannot always tell which
 * phase a reply belongs to; the cost of closing on the other kind is a
 * reconnect, not a note.
 */
const ENDS_SESSION = new Set([
  "proto",
  "auth",
  "cursor",
  "busy",
  "protostate",
  "nospace",
  "internal",
]);

/**
 * Whether reconnecting later can succeed, by code alone.
 *
 * The "retryable" column of the error table, as a default for a frame that
 * arrives without the field. That is not an older protocol, of which there is
 * none: it is an error the server sends before it has parsed the hello, when
 * it knows nothing about who is asking, such as a refusal at admission during
 * shutdown or at the pre-auth cap. The server sets the field on those too, so
 * in practice this is never consulted, and it stays because a client that
 * guessed "retry" at a `proto` mismatch would loop for ever and one that
 * guessed "stop" at a `busy` would stop on every server restart.
 */
function retryableByCode(code: string): boolean {
  return code === "busy" || code === "nospace" || code === "internal";
}

/**
 * A refusal from the server, carrying the code it sent.
 *
 * `code` is what a client acts on and `message` is what a person reads;
 * docs/protocol.md requires both, because an error a device cannot act on and a
 * person cannot read is how a silent failure starts.
 */
export class ProtocolError extends Error {
  /**
   * Whether reconnecting later can succeed where retrying the same request
   * cannot. The server says so on every error, and a watching client has
   * nothing to interpret: back off and reconnect on true, stop on false. Read
   * from the frame, and from the code table only as a default for a frame
   * that somehow carries no such field.
   */
  readonly retryable: boolean;
  /** How long the server suggests waiting before reconnecting, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: string,
    message: string,
    opts: { retryable?: boolean | undefined; retryAfterMs?: number | undefined } = {},
  ) {
    super(message);
    this.name = "ProtocolError";
    this.retryable = opts.retryable ?? retryableByCode(code);
    this.retryAfterMs = opts.retryAfterMs;
  }

  /**
   * Whether trying again could never help.
   *
   * The complement of `retryable`, kept under the name the loops read it by:
   * a caller that retried a `proto` mismatch would loop forever, and one that
   * stopped on a `busy` would stop on every server restart.
   */
  get fatal(): boolean {
    return !this.retryable;
  }

  /** Whether this refusal ends the session, as the protocol's table says. */
  get endsSession(): boolean {
    return ENDS_SESSION.has(this.code);
  }
}

/** Builds the error a frame describes, reading every field it carries. */
function errorFrom(frame: Reply): ProtocolError {
  const retryable = frame["retryable"];
  const after = frame["retryAfterMs"];
  const code = frame["code"];
  const msg = frame["msg"];
  return new ProtocolError(
    typeof code === "string" ? code : "unknown",
    typeof msg === "string" ? msg : "no message",
    {
      retryable: typeof retryable === "boolean" ? retryable : undefined,
      retryAfterMs: typeof after === "number" && after > 0 ? after : undefined,
    },
  );
}

/**
 * The one thing a failed `wss://` connection is most often missing.
 *
 * A bare host a person types becomes `wss://`, which is right for the
 * tunnel or the tailnet this is meant to be reached through: a server with TLS
 * in front of it. A server without TLS in front of it answers nothing at all,
 * and the failure looks exactly like a wrong address or a machine that is off.
 *
 * Cost an hour the first time it was hit, against a server on localhost. The
 * address is in the message already; this adds the one word that turns it into
 * something to try.
 */
function plainTextHint(url: string): string {
  if (!url.startsWith("wss://")) return "";
  return `. If that server has no TLS in front of it, pair with ws://${url.slice("wss://".length)} instead`;
}

/** Raised when the connection went away rather than answering. */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

export interface TransportOptions {
  /**
   * Called for every batch, in the order the server sent them.
   *
   * Both catch-up and live changes arrive here, because they are the same
   * message. A batch whose entry list is empty is this device's own write: it
   * carries the cursor advance and not the payload, so there is nothing to
   * apply and the cursor still moves.
   */
  readonly onBatch: (batch: Batch) => void | Promise<void>;
  /** Called once when the backlog is drained. */
  readonly onCaughtUp?: (cursor: number) => void;
  /**
   * Called once when the connection has ended, for any reason.
   *
   * This class deliberately does not reconnect: a client that keeps running
   * wants backoff and a client that syncs once and exits wants to fail, and
   * that is a decision for whoever is running it. `Backoff` below is here for
   * the first kind. `retryable` on the error says whether trying again could
   * ever help.
   */
  readonly onClosed?: (cause: Error) => void;
  readonly log?: (message: string, ...rest: unknown[]) => void;
  /** Injectable for tests. Defaults to the platform's WebSocket. */
  readonly socketFactory?: (url: string) => SocketLike;
  readonly timeoutMs?: number;
}

/**
 * The subset of WebSocket this uses.
 *
 * Narrowed to what is needed, so a test can supply a socket without simulating a
 * browser and so the type does not depend on which platform's DOM types happen
 * to be loaded.
 */
export interface SocketLike {
  binaryType: string;
  onopen: ((this: void, ev: unknown) => void) | null;
  onclose: ((this: void, ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((this: void, ev: unknown) => void) | null;
  onmessage: ((this: void, ev: { data: unknown }) => void) | null;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /**
   * Bytes handed to `send` and not yet on the wire, where the platform says.
   *
   * Browsers and Node's WebSocket both do. A socket that does not is sent to
   * without pacing, which is what every socket was before this existed.
   */
  readonly bufferedAmount?: number;
}

type Reply = Record<string, unknown>;

/**
 * A request waiting for its reply, by id.
 *
 * Each carries its own inactivity clock. An inactivity timer rather than a
 * deadline: a fetch is answered in bodies, and a large file over a slow link
 * delivers them steadily for longer than any sensible timeout. A timer
 * measuring the whole fetch killed it however well it was going, and the
 * client reconnected into the same download for ever. What a timeout is for
 * is a server that has stopped talking, so everything the server sends for a
 * request starts its clock again.
 */
interface Pending {
  readonly what: string;
  resolve: (value: Reply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the clock is running. A put's is stopped while its bodies go out. */
  armed: boolean;
  /**
   * Run on the reply the moment it arrives, before anything after it is read.
   *
   * For the one reply whose content decides how the frames behind it are
   * read: `ready`, whose epoch says whether the batches that follow continue
   * this device's cursor or start the vault again from uid 1. The caller of
   * `hello` learns of the reply a few turns later, and a batch can be queued
   * in between.
   */
  onArrival?: (frame: Reply) => void;
}

/**
 * The ceilings that apply before the server has advertised its own (R13).
 *
 * Only the handshake happens before `ready`, and its frames are a few hundred
 * bytes. These are generous enough that nothing legitimate meets them and
 * small enough that meeting one is not dangerous, and they exist so that
 * "before the limits are known" is not the same as "unlimited".
 */
const MAX_UNAGREED_FRAME_BYTES = 1 << 20;
const MAX_UNAGREED_FETCH_BYTES = 1 << 20;

/**
 * What this device will hold for one batch and one fetch, whatever the server
 * advertises (R26).
 *
 * The handshake numbers are a server saying how much it may send. They were
 * used directly as the client's own ceilings, which makes the peer the one
 * deciding how much memory this process commits; a handshake advertising
 * `Number.MAX_SAFE_INTEGER` was accepted and produced a text-frame ceiling of
 * eighteen quadrillion. Whether the server is hostile or simply wrong does not
 * change what it costs.
 *
 * Set at the protocol's own defaults, so an ordinary server is unaffected and
 * one asking for more than the protocol describes is held to it. A server that
 * advertises *less* still gets its way: the smaller of the two wins.
 *
 * Written down twice, once here and once in `wire`, because this side needs
 * them before the handshake has said anything. Both sides check them against
 * `protocol-fixtures.json`, so raising the server's without raising these
 * fails a test rather than producing a client that hangs up on a batch the
 * server was entitled to send.
 */
export const LOCAL_MAX_BATCH_BYTES = 16 << 20;
export const LOCAL_MAX_FETCH_BYTES = 64 << 20;
/**
 * The largest raw chunk this device will take from a body frame, whatever the
 * server advertises: the protocol's `chunkMax` (plan/protocol.md, "Limits").
 * A frame is refused before anything is inflated when it is longer than this
 * plus its marker, and inflating stops the moment it passes this.
 */
export const LOCAL_MAX_CHUNK_BYTES = 1 << 20;

export class Transport {
  private socket: SocketLike | undefined;

  /** Requests in flight, by the id they were sent with. */
  private readonly pending = new Map<number, Pending>();
  /**
   * The id the next request gets. Ids are 1 to 2^32-1 and wrap, which at one
   * request a millisecond is a hundred and forty years per connection; a wrap
   * onto an id still in flight is refused rather than reused.
   */
  private nextId = 1;
  /**
   * The ping waiting for its pong. Pings carry no id in either direction and
   * pongs are matched by being the only thing a pong could answer, so at most
   * one is in flight.
   */
  private pinging: Pending | undefined;
  private pingPromise: Promise<void> | undefined;

  /**
   * The fetch collecting bodies, if one is. The `bodies` header says exactly
   * how many binary frames follow and this is what reads them; a body with no
   * fetch collecting is a body nobody asked for.
   *
   * `waiter` is the reader of that same fetch, waiting on a body that has not
   * arrived. It used to be a field of its own, which described one in-progress
   * fetch in two places; there is only ever one fetch, so there is only ever
   * one waiter, and the two can no more disagree now than they were allowed to
   * before.
   */
  private collecting:
    | {
        pending: Pending;
        want: number;
        got: Uint8Array[];
        /** Bytes received so far, against the server's own fetch ceiling (R13). */
        bytes: number;
        waiter?: () => void;
      }
    | undefined;

  /**
   * How many requests this connection has sent.
   *
   * Latency multiplies round trips the way bandwidth multiplies bytes, so
   * this is the number that says how a design behaves on a slow wire. Kept
   * here rather than measured outside because only this class knows what a
   * request is: a fetch is one, however many bodies come back.
   */
  requestsSent = 0;
  private closed = false;
  private closeReason: Error | undefined;
  /**
   * The cursor as the client understands it, advanced only by batches.
   *
   * Held here so the continuity check has something to compare against. The
   * protocol's rule is `from === cursor + 1`, and a gap means a file was
   * skipped, which is the one thing the batch shape exists to make visible.
   */
  private cursor = 0;
  /** Notifications are handled in arrival order, never overlapped. */
  private notifying: Promise<void> = Promise.resolve();
  /** What the server said at hello, for the bounds this side keeps to. */
  private limits: ServerLimits | undefined;
  /**
   * Whether the `ready` this session began with carried an epoch other than
   * the one the hello's cursor was read under.
   *
   * The server then ignores the cursor and replays the whole vault from uid 1
   * (plan/protocol.md, "Device session"), so this transport's own cursor starts
   * again from zero, and whoever applies the batches has to read them as a
   * fresh listing rather than as versions it has seen.
   */
  private replaced = false;

  /**
   * The largest text frame this device will parse (R13).
   *
   * A control message, so the bound is the largest legitimate one: a batch,
   * which the server bounds by the `maxBatchBytes` it advertised. Before
   * `ready` nothing has been advertised and the only frames that should arrive
   * are the handshake's, so the fallback is generous enough for any of those
   * and far below what makes a parse dangerous.
   */
  private textFrameCeiling(): number {
    const agreed = this.limits?.maxBatchBytes;
    // Room for the framing around a batch that is exactly at the limit.
    return agreed === undefined ? MAX_UNAGREED_FRAME_BYTES : agreed * 2;
  }

  constructor(
    private readonly url: string,
    private readonly opts: TransportOptions,
  ) {}

  private log(message: string, ...rest: unknown[]): void {
    this.opts.log?.(message, ...rest);
  }

  /** The cursor this client has applied up to. */
  get appliedCursor(): number {
    return this.cursor;
  }

  /** What the server advertised at hello, or undefined before it. */
  get serverLimits(): ServerLimits | undefined {
    return this.limits;
  }

  /**
   * Whether the server's history is not the one this device's cursor was read
   * from, as the `ready` of this session said.
   *
   * Set the moment that `ready` arrives, before any batch behind it is read,
   * so a reader of the batches can ask it first.
   */
  get historyReplaced(): boolean {
    return this.replaced;
  }

  /**
   * Opens the socket, within the timeout.
   *
   * The open used to have no deadline at all. A server that accepts the
   * TCP connection and never completes the handshake, or a firewall that
   * swallows the SYN, left `connect` hanging for as long as the platform
   * cared to wait, and the CLI held the vault's lock for the whole of it.
   */
  async connect(): Promise<void> {
    if (this.socket) throw new Error("already connected");
    const factory = this.opts.socketFactory ?? defaultSocketFactory;
    const socket = factory(this.url);
    // Bodies as bytes. Browsers default to Blob, which would mean an await
    // per frame and a different code path from Node.
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    const timeoutMs = this.timeoutMs;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ConnectionError(`no connection to ${this.url} within ${timeoutMs}ms`));
        try {
          socket.close();
        } catch {
          // Never opened, so there is nothing to close.
        }
      }, timeoutMs);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      socket.onopen = () => done(resolve);
      socket.onerror = () =>
        done(() =>
          reject(new ConnectionError(`could not connect to ${this.url}${plainTextHint(this.url)}`)),
        );
      socket.onclose = (ev) =>
        done(() =>
          reject(new ConnectionError(`connection closed before opening: ${describeClose(ev)}`)),
        );
    });

    socket.onerror = () => this.die(new ConnectionError("the connection failed"));
    socket.onclose = (ev) =>
      this.die(new ConnectionError(`the connection closed: ${describeClose(ev)}`));
    socket.onmessage = (ev) => this.onFrame(ev.data);
  }

  /**
   * Ends the connection and fails anything waiting on it.
   *
   * Everything that stops this transport goes through here, so there is one
   * place a waiter can be left hanging and it is covered.
   */
  private die(cause: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = cause;
    this.log("transport closed", cause.message);
    const waiting = [...this.pending.values()];
    this.pending.clear();
    const ping = this.pinging;
    this.pinging = undefined;
    const body = this.collecting?.waiter;
    this.collecting = undefined;
    for (const p of waiting) {
      this.disarm(p);
      p.reject(cause);
    }
    if (ping) {
      this.disarm(ping);
      ping.reject(cause);
    }
    // A body reader is woken with nothing, and finds the transport closed.
    body?.();
    try {
      this.socket?.close();
    } catch {
      // Already gone. Nothing to do and nothing worth reporting.
    }
    try {
      this.opts.onClosed?.(cause);
    } catch {
      // A listener that throws does not get to leave the transport in a
      // half-closed state; it is already closed by this point.
    }
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Starts, or restarts, the clock on one request's answer. */
  private arm(p: Pending): void {
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.armed = true;
    const timeoutMs = this.timeoutMs;
    p.timer = setTimeout(() => {
      this.die(new ConnectionError(`no ${p.what} within ${timeoutMs}ms`));
    }, timeoutMs);
  }

  private disarm(p: Pending): void {
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.timer = undefined;
    p.armed = false;
  }

  close(): void {
    this.die(new ConnectionError("closed by this device"));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onFrame(data: unknown): void {
    if (typeof data === "string") {
      // The size before the parse (R13).
      //
      // `JSON.parse` on a 200 MB string allocates the string's worth of
      // objects before anything here sees a frame, and every check this class
      // makes runs afterwards. A text frame is a control message: the largest
      // legitimate one is a batch, which the server bounds by `maxBatchBytes`,
      // and this is that bound applied to what arrives rather than to what
      // was meant to be sent. Characters rather than bytes, which is within a
      // factor of the limit and needs no encoder.
      if (data.length > this.textFrameCeiling()) {
        this.die(
          new ProtocolError(
            "toolarge",
            `server sent a ${data.length} character frame, over the ` +
              `${this.textFrameCeiling()} this device will parse`,
          ),
        );
        return;
      }
      let frame: Reply;
      try {
        frame = JSON.parse(data) as Reply;
      } catch {
        // A frame that is not JSON means the two ends disagree about the
        // protocol. Guessing at it is worse than stopping.
        this.die(
          new ProtocolError(
            "protostate",
            `server sent a frame that is not JSON: ${data.slice(0, 120)}`,
          ),
        );
        return;
      }
      // Parsed is not the same as a frame (F17). `null`, `7`, `"hello"` and
      // `[]` are all valid JSON, and every one of them left the `try` above
      // and reached a reader that expects to index into an object: the probe
      // threw a TypeError out of the socket callback, which nothing here
      // catches, and left the connection open and unusable. A frame that is
      // not an object means the two ends disagree about the protocol just as
      // surely as one that is not JSON, and it is refused in the same place
      // with the same code.
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        this.die(
          new ProtocolError(
            "protostate",
            `server sent a frame that is not an object: ${data.slice(0, 120)}`,
          ),
        );
        return;
      }
      this.onTextFrame(frame, data.length);
      return;
    }

    const bytes = toBytes(data);
    if (bytes === undefined) {
      this.die(new ProtocolError("protostate", `server sent a frame of an unexpected type`));
      return;
    }
    const fetch = this.collecting;
    if (!fetch || fetch.got.length >= fetch.want) {
      // A body nobody asked for. The `bodies` header said how many were
      // coming and this is one more, or there was no header at all; either
      // way the two ends no longer agree about what is being answered, and
      // a queue not bounded by that would be a way for a peer to exhaust
      // this device's memory.
      this.die(
        new ProtocolError(
          "protostate",
          `server sent a ${bytes.length} byte body with nothing outstanding to receive it`,
        ),
      );
      return;
    }
    // A budget over the whole fetch, not a count of frames (R13).
    //
    // The header says how many bodies are coming and each one is bounded by
    // the chunk ceiling, so the count alone allows a fetch of the maximum
    // number of maximum-sized bodies to sit in memory at once. What was asked
    // for is known: the sizes were agreed when the fetch went out, and the
    // server's own `maxFetchBytes` is the number it promised not to exceed.
    fetch.bytes += bytes.length;
    // Before `ready` there are no advertised limits, and a fetch cannot have
    // been sent either, so the fallback is only ever reached by a peer sending
    // bodies nobody asked for; the branch above has already refused that.
    const ceiling = this.limits?.maxFetchBytes ?? MAX_UNAGREED_FETCH_BYTES;
    // The budget is on raw bytes, and a frame carries one marker byte over its
    // chunk when it is sent raw, so a fetch at exactly the ceiling arrives as
    // the ceiling plus one byte per body. Refusing that would end a session
    // over a fetch the server was entitled to answer.
    if (fetch.bytes > ceiling + fetch.want) {
      this.die(
        new ProtocolError(
          "toolarge",
          `server sent ${fetch.bytes} bytes of bodies for a fetch it said would hold at most ` +
            `${ceiling}`,
        ),
      );
      return;
    }
    // Progress on the fetch, so its clock restarts.
    this.arm(fetch.pending);
    fetch.got.push(bytes);
    const waiter = fetch.waiter;
    if (waiter) {
      delete fetch.waiter;
      waiter();
    }
  }

  private onTextFrame(frame: Reply, frameBytes = 0): void {
    // Notifications first, and by name. Everything else is the answer to a
    // request, matched by id; see the note at the top about why a client that
    // skips this reads a batch as its reply and hangs.
    if (frame["op"] === "batch") {
      // Charged its own size, because a batch is the notification that holds
      // anything: its entries stay alive for as long as it is queued (R26).
      this.queueNotification(() => this.onBatchFrame(frame), frameBytes);
      return;
    }
    if (frame["op"] === "caught-up") {
      const cursor = numberOf(frame["cursor"]);
      this.queueNotification(async () => {
        if (cursor !== this.cursor) {
          // The server says the backlog ends somewhere this client
          // never reached. Continuing would leave a hole nothing asks
          // about again.
          this.die(
            new ProtocolError(
              "protostate",
              `server says caught up at ${cursor}, this device reached ${this.cursor}`,
            ),
          );
          return;
        }
        this.opts.onCaughtUp?.(cursor);
      });
      return;
    }

    const id = frame["id"];
    if (id !== undefined) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        this.die(
          new ProtocolError("protostate", `server sent a reply whose id is ${JSON.stringify(id)}`),
        );
        return;
      }
      const waiting = this.pending.get(id);
      if (!waiting) {
        // The server never sends an id it was not given, so this is an
        // answer to a request this client does not have in flight: one it
        // already answered, or one it never sent. Either way the two ends
        // disagree about state, and the protocol says to end the session.
        this.die(
          new ProtocolError(
            "protostate",
            `server sent a reply to request ${id}, which is not in flight: ${JSON.stringify(frame)}`,
          ),
        );
        return;
      }
      this.pending.delete(id);
      this.disarm(waiting);
      try {
        waiting.onArrival?.(frame);
      } catch {
        // Only ever a reading of the reply, which its caller reads again and
        // refuses properly; a hook that throws must not strand the waiter.
      }
      waiting.resolve(frame);
      return;
    }

    if (frame["res"] === "pong") {
      const ping = this.pinging;
      if (!ping) {
        this.die(new ProtocolError("protostate", "server sent a pong with no ping in flight"));
        return;
      }
      this.pinging = undefined;
      this.disarm(ping);
      ping.resolve(frame);
      return;
    }

    if (frame["res"] === "err") {
      // An error nobody asked for is the server saying why it is about to
      // hang up, and the protocol says so: on shutdown every idle session is
      // sent `busy` and then closed, and a revoke sends the revoked
      // device's sessions `auth`. Read as a stray reply this was a protocol violation,
      // so a server restarting put every plugin into "stopped" when what it
      // meant was "not now". Whether a loop retries is the error's
      // own `retryable`, which the server set.
      this.die(errorFrom(frame));
      return;
    }
    // Nothing asked for this. Either the server sent an unsolicited reply
    // or this client lost track, and both mean the two ends disagree about
    // state.
    this.die(
      new ProtocolError("protostate", `server sent an unexpected reply: ${JSON.stringify(frame)}`),
    );
  }

  /**
   * Runs notifications one at a time, in arrival order.
   *
   * Batches must be applied in order or the cursor walks backwards over files
   * that were never received. Obsidian serialises them through a `notifyQueue`
   * for the same reason.
   */
  /**
   * The most notifications that may be waiting to run at once (F28).
   *
   * Batches and caught-up frames are chained onto one promise so they are
   * applied in order, and the chain had no bound: a server that sends faster
   * than the engine applies grows it without limit, and each link holds its
   * frame's entries alive. Catch-up on a large vault is legitimately hundreds
   * deep, so this is well above anything an honest server produces and well
   * below the point where a phone dies.
   */
  private static readonly MAX_BACKLOG = 1024;

  /**
   * And how many *bytes* those notifications may be holding (R26).
   *
   * A count of messages is not a bound on memory. Each queued batch holds its
   * frame's entries alive, and a thousand batches of sixteen megabytes each is
   * sixteen gigabytes with the counter reading well inside its limit. The
   * count still matters, because a flood of tiny frames is its own problem;
   * this is the other half.
   *
   * Sized at four batches, which is more than the engine is ever behind by on
   * an honest server and far below what makes a phone unhappy.
   */
  private static readonly MAX_BACKLOG_BYTES = 4 * LOCAL_MAX_BATCH_BYTES;

  private backlog = 0;
  private backlogBytes = 0;

  private queueNotification(work: () => void | Promise<void>, bytes = 0): void {
    if (this.backlogBytes + bytes > Transport.MAX_BACKLOG_BYTES) {
      this.die(
        new ProtocolError(
          "protostate",
          `server sent ${this.backlogBytes + bytes} bytes of notifications faster than this ` +
            `device could apply them, over the ${Transport.MAX_BACKLOG_BYTES} it will hold`,
        ),
      );
      return;
    }
    if (this.backlog >= Transport.MAX_BACKLOG) {
      // Ended rather than dropped. Dropping a batch would advance nothing and
      // leave a hole this device never asks about again, which is the silent
      // half of the failure; ending the session means the next connection
      // starts from the cursor that was actually applied.
      this.die(
        new ProtocolError(
          "protostate",
          `server sent more than ${Transport.MAX_BACKLOG} notifications faster than this device ` +
            "could apply them",
        ),
      );
      return;
    }
    this.backlog++;
    this.backlogBytes += bytes;
    this.notifying = this.notifying
      .then(work)
      .catch((err: unknown) => {
        this.die(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.backlog--;
        this.backlogBytes -= bytes;
      });
  }

  private async onBatchFrame(frame: Reply): Promise<void> {
    const from = numberOf(frame["from"]);
    const to = numberOf(frame["to"]);
    // Required to be present, though it may be empty. An absent or null
    // `entries` used to be read as an empty batch, so a frame that lost the
    // field advanced the cursor over real versions and this device never
    // fetched them: a note missing for ever, on a client reporting success.
    // Empty stays legal, because that is how a device gets its own writes
    // back without the payload.
    const raw = frame["entries"];
    if (!Array.isArray(raw)) {
      throw new ProtocolError(
        "protostate",
        `batch ${from} to ${to} carries no entries array, so an empty batch cannot be told from a lost one`,
      );
    }
    const entries = raw as WireEntry[];

    // The continuity check the batch shape exists for. From and to are a
    // covered range, not the uids present, so a purged hole in the sequence
    // is not a gap; anything else is.
    if (from !== this.cursor + 1) {
      throw new ProtocolError(
        "protostate",
        `batch covers ${from} to ${to} but this device has applied up to ${this.cursor}, so something was skipped`,
      );
    }
    if (to < from) {
      throw new ProtocolError("protostate", `batch covers an empty range, ${from} to ${to}`);
    }
    for (const e of entries) {
      // Checked to be a number before it is compared. An entry with no
      // uid at all made both comparisons false and sailed through, which
      // is the range check passing by not being performed.
      if (typeof e?.uid !== "number" || !Number.isFinite(e.uid)) {
        throw new ProtocolError("protostate", `batch ${from}..${to} contains an entry with no uid`);
      }
      if (typeof e.path !== "string" || e.path === "") {
        throw new ProtocolError(
          "protostate",
          `batch ${from}..${to} contains uid ${e.uid} with no path`,
        );
      }
      if (!Array.isArray(e.chunks)) {
        throw new ProtocolError(
          "protostate",
          `batch ${from}..${to} contains uid ${e.uid} with no chunks array`,
        );
      }
      // Each name's shape, which history, deleted and get all check and this
      // did not. A name that is not a name is fetched as one, and the reply
      // to that is refused much later and by something with less to say
      // about where it came from.
      for (const name of e.chunks as unknown[]) {
        if (!isChunkName(name)) {
          throw new ProtocolError(
            "protostate",
            `batch ${from}..${to} contains uid ${e.uid} naming ${JSON.stringify(name)}, ` +
              `which is not a chunk name`,
          );
        }
      }
      if (e.uid < from || e.uid > to) {
        throw new ProtocolError("protostate", `batch ${from}..${to} contains uid ${e.uid}`);
      }
    }

    await this.opts.onBatch({ from, to, entries });
    // Advanced only after the caller has applied it. Advancing first would
    // mean a failure to apply is a file silently skipped.
    this.cursor = to;
  }

  /* ------------------------------------------------------------ *
   * Sending
   * ------------------------------------------------------------ */

  /** A text frame or a body, over a socket that is still there. */
  private send(data: string | Uint8Array): void {
    if (this.closed || !this.socket) {
      throw this.closeReason ?? new ConnectionError("not connected");
    }
    this.socket.send(data);
  }

  /** A fresh request id, never one still in flight. */
  private takeId(): number {
    for (let tries = 0; tries < 8; tries++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
      if (!this.pending.has(id)) return id;
    }
    throw new Error("every request id is in flight, which cannot happen");
  }

  /**
   * Sends a request under a fresh id and waits for the reply that echoes it.
   *
   * A timeout closes the connection rather than only rejecting. The request
   * may have been received and acted on, so the session's state is unknown,
   * and the only safe next step is to start again.
   *
   * `clock` says whether the reply is expected straight away. A put's reply
   * follows its bodies, and the sending phase has its own measure of progress
   * (`drained`), so the clock on the reply starts once every body is with the
   * socket, from `awaitReply`.
   */
  private begin(
    value: Record<string, unknown>,
    what: string,
    clock = true,
    onArrival?: (frame: Reply) => void,
  ): Promise<Reply> {
    const id = this.takeId();
    const text = JSON.stringify({ ...value, id });
    this.requestsSent++;
    const reply = new Promise<Reply>((resolve, reject) => {
      if (this.closed) {
        reject(this.closeReason ?? new ConnectionError("not connected"));
        return;
      }
      const p: Pending = {
        what,
        resolve,
        reject,
        timer: undefined,
        armed: false,
        ...(onArrival ? { onArrival } : {}),
      };
      this.pending.set(id, p);
      if (clock) this.arm(p);
      try {
        this.send(text);
      } catch (err) {
        this.pending.delete(id);
        this.disarm(p);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // Nobody may await this until later, and a connection that dies before
    // then rejects it now. The caller sees that failure through its own
    // send; this only keeps the rejection from being reported as one nobody
    // handled. `awaitReply` still sees it.
    reply.catch(() => {});
    return reply;
  }

  /**
   * Waits for a reply and raises a refusal as an error.
   *
   * A refusal that ends the session closes the transport as well, so nothing
   * else is sent down a connection the server is about to close.
   */
  private async awaitReply(reply: Promise<Reply>): Promise<Reply> {
    const frame = await reply;
    if (frame["res"] === "err") {
      const err = errorFrom(frame);
      if (err.endsSession) this.die(err);
      throw err;
    }
    return frame;
  }

  /** One round trip: send, wait, and refuse a refusal. */
  private async request(
    value: Record<string, unknown>,
    what: string,
    onArrival?: (frame: Reply) => void,
  ): Promise<Reply> {
    return this.awaitReply(this.begin(value, what, true, onArrival));
  }

  /* ------------------------------------------------------------ *
   * Operations
   * ------------------------------------------------------------ */

  /**
   * Opens the session and returns the limits the server advertises.
   *
   * The cursor sent is what this device has applied. The reply's cursor is what
   * the *server* holds, so the difference says how far behind this device is
   * without anything having remembered a verdict from last time.
   *
   * `epoch` is the store epoch that cursor was read under, as an earlier
   * `ready` said, and absent on a first connect. A `ready` carrying another
   * one means the server's history was replaced: it replays the vault from
   * uid 1, and this transport's cursor starts from zero to read it
   * (`historyReplaced`).
   */
  async hello(args: {
    vault: string;
    /** This device's row in the vault's device list. */
    deviceId: string;
    /** This device's own 32-byte token, unpadded base64url. */
    token: string;
    device: string;
    cursor: number;
    epoch?: string | undefined;
  }): Promise<ServerLimits> {
    checkName("vault", args.vault);
    checkName("device", args.device);
    this.cursor = args.cursor;
    this.replaced = false;
    let reply: Reply;
    try {
      reply = await this.request(
        {
          op: "hello",
          proto: PROTO,
          vault: args.vault,
          deviceId: args.deviceId,
          token: args.token,
          device: args.device,
          cursor: args.cursor,
          ...(args.epoch !== undefined ? { epoch: args.epoch } : {}),
        },
        "ready",
        (frame) => {
          // Decided as the frame lands, because the batches behind it are
          // read against this transport's cursor, and one of them can be
          // queued before the caller of `hello` hears back. A cursor that
          // belongs to another history would refuse the replay's first batch,
          // from 1, as a gap.
          const epoch = frame["epoch"];
          if (
            frame["res"] === "ready" &&
            args.epoch !== undefined &&
            typeof epoch === "string" &&
            epoch !== args.epoch
          ) {
            this.cursor = 0;
            this.replaced = true;
          }
        },
      );
    } catch (err) {
      throw protoRefusal(err);
    }
    return this.readReady(reply);
  }

  /**
   * Redeems a single-use invite, which is how this device joins a vault.
   *
   * The hello carries the invite token in place of a credential and, beside
   * it, the device row it is asking for: an id of its own and the 32-byte token
   * it will connect with (plan/protocol.md, "Invite redemption"). Both halves
   * are one server transaction, so a redemption is either an invite spent and
   * a row written or neither, and a refusal writes nothing: it never spends the
   * invite.
   *
   * The server closes the session after `redeemed`: this connection proved
   * that somebody held an invite, not that anybody holds the token just
   * registered. The caller keeps the credential and connects again as a
   * device, and that hello is the proof.
   *
   * A retry with the same id and token after a lost reply is answered
   * `redeemed` again, even after the invite has expired, because the
   * redemption it repeats did not. That is why the caller persists both before
   * this is sent and keeps them until an answer arrives (`pairWithInvite` in
   * client.ts).
   */
  async redeem(args: {
    vault: string;
    /** The label the new row takes. */
    device: string;
    /** The 16-byte invite token, unpadded base64url. */
    invite: string;
    /** The row this device is asking the invite to register. */
    deviceId: string;
    /** The token that row will be recognised by. */
    token: string;
  }): Promise<{ deviceId: string }> {
    checkName("vault", args.vault);
    checkName("device", args.device);
    let reply: Reply;
    try {
      reply = await this.request(
        {
          op: "hello",
          proto: PROTO,
          vault: args.vault,
          device: args.device,
          invite: args.invite,
          deviceId: args.deviceId,
          token: args.token,
        },
        "redeemed",
      );
    } catch (err) {
      throw protoRefusal(err);
    }
    if (reply["res"] !== "redeemed") {
      throw new ProtocolError("protostate", `expected redeemed, got ${JSON.stringify(reply)}`);
    }
    if (reply["deviceId"] !== args.deviceId) {
      // The reply names the row that was written. A different id means this
      // device is about to keep a credential for a row that is not its own,
      // and it would be refused at every hello from then on with nothing to
      // say why.
      throw this.malformed(
        `a redeemed naming device ${JSON.stringify(reply["deviceId"])}, which is not the ${JSON.stringify(args.deviceId)} that was redeemed for`,
      );
    }
    return { deviceId: args.deviceId };
  }

  private readReady(reply: Reply): ServerLimits {
    if (reply["res"] !== "ready") {
      throw new ProtocolError("protostate", `expected ready, got ${JSON.stringify(reply)}`);
    }
    const version = reply["serverVersion"];
    const epoch = reply["epoch"];
    if (typeof epoch !== "string" || epoch === "") {
      // Without it a device cannot tell a restored server from the one it
      // left, and a cursor into a reissued uid sequence silently skips the
      // versions that replaced the ones it saw (PLAN.md section 2.8).
      throw this.malformed("a ready with no epoch, so which history it serves cannot be told");
    }
    const limits: ServerLimits = {
      proto: this.count(reply, "proto", "ready"),
      minProto: this.count(reply, "minProto", "ready"),
      serverVersion: typeof version === "string" ? version : "unknown",
      epoch,
      cursor: this.count(reply, "cursor", "ready"),
      perFileMax: this.count(reply, "perFileMax", "ready"),
      // Capped by what this device is willing to decode, like the two
      // budgets below: a frame is bounded by it before anything is inflated.
      chunkMax: Math.min(this.count(reply, "chunkMax", "ready"), LOCAL_MAX_CHUNK_BYTES),
      maxChunks: this.count(reply, "maxChunks", "ready"),
      // Capped by what this device is willing to hold, not only by what the
      // server says it will send (R26).
      //
      // These decide how much memory the client will commit: the text-frame
      // ceiling is derived from the batch figure and the fetch budget is the
      // fetch figure. Taking them from the handshake as given means the peer
      // chooses, and a server advertising `Number.MAX_SAFE_INTEGER` was
      // accepted, which is the same as having no ceiling at all. A limit is a
      // negotiation: the smaller of what they will send and what this device
      // will accept.
      maxBatchBytes: Math.min(this.count(reply, "maxBatchBytes", "ready"), LOCAL_MAX_BATCH_BYTES),
      maxFetchBytes: Math.min(this.count(reply, "maxFetchBytes", "ready"), LOCAL_MAX_FETCH_BYTES),
    };
    if (limits.proto !== PROTO) {
      // A server answers in the version the client asked for, so a ready in
      // another version is a server that did not understand the question.
      const err = new ProtocolError(
        "proto",
        `server (version ${limits.serverVersion}) answered in protocol ${limits.proto}, ` +
          `this client speaks ${PROTO}; upgrade the server first`,
      );
      this.die(err);
      throw err;
    }
    this.limits = limits;
    this.log("ready", limits);
    return limits;
  }

  /**
   * Writes a version of a file and returns the uid it was given.
   *
   * `uploaded` is how many chunk bodies actually went over the wire, which is
   * the number worth logging: it is the difference between this and whole-file
   * sync, and a client re-sending chunks the server already holds would look
   * identical without it.
   */
  async put(
    path: string,
    meta: PutMeta,
    names: readonly string[],
    /**
     * The raw bytes of one chunk, asked for only if the server wants it.
     *
     * A callback rather than the bodies themselves, because a put used to
     * take every chunk of a file at once and a 256 MiB attachment, which is
     * the size the server advertises it will take, meant twice that live.
     * Measured, not guessed. On a phone that is not a spike, it is the end of
     * the process.
     *
     * The caller decides what that costs it. A file held in memory hands out
     * views into it; a streamed one keeps offsets and reads the chunk back
     * off the disk. Each body is framed here, as it goes.
     */
    bodyOf: (name: string) => Promise<Uint8Array>,
    /**
     * The versions this write was prepared against: `base` for the target,
     * zero for no live entry, and `prevBase` for a rename's source.
     *
     * Required, with no default. A default of zero would let a caller that
     * forgot send an unconditional write, which overwrites a peer's newer
     * version where it should have been refused as `stale`.
     */
    cond: { base?: number; prevBase?: number },
    onBytes?: (bytes: number) => void,
    /** Work on a separate connection while this upload yields between bodies. */
    interleave?: () => Promise<void>,
  ): Promise<{ uid: number; uploaded: number; bytes: number }> {
    notifyTransfer(onBytes, 0);
    const reply = await this.request(
      {
        op: "put",
        path,
        meta: wireMeta(meta),
        chunks: [...names],
        ...conditions(meta, cond.base, cond.prevBase),
      },
      "want or have",
    );

    if (reply["res"] === "have") {
      await this.drainReceived();
      return { uid: this.uid(reply, "have"), uploaded: 0, bytes: 0 };
    }
    if (reply["res"] !== "want") {
      throw new ProtocolError("protostate", `expected want or have, got ${JSON.stringify(reply)}`);
    }

    const offered = new Set(names);
    const wanted = this.wanted(reply, offered);

    // The ack answers the same id as the put, so the waiter for it is the
    // one taken out again here, before any body goes out: a loopback server
    // acks from inside the last send, and a waiter installed after
    // the bodies found the answer already there.
    const id = idOf(reply);
    const ack = this.expectMore(id, "acknowledgement");
    const bytes = await this.sendBodies(wanted, offered, bodyOf, "put", onBytes, interleave);
    const acked = await this.awaitPhase(ack, id);
    if (acked["res"] !== "ack") {
      throw new ProtocolError("protostate", `expected ack, got ${JSON.stringify(acked)}`);
    }
    await this.drainReceived();
    return { uid: this.uid(acked, "ack"), uploaded: wanted.length, bytes };
  }

  /**
   * Writes many versions in one exchange, and returns one result per entry in
   * the order they were given.
   *
   * A put is one round trip in the good case and two when bodies have to go,
   * which on a loopback socket is nothing and on a link with four hundred
   * milliseconds in it is the whole cost of a sync. Two hundred notes were two
   * hundred conversations. This is one: every entry's chunk names go up
   * together, the server answers with the union of what it lacks, and the
   * bodies follow in that order.
   *
   * An entry the server refuses does not refuse the batch. Its result carries
   * the error and the others carry their uids, because a batch that fails as a
   * unit leaves a client bisecting it to find out which note it was.
   *
   * The caller splits by the caps `ready` advertised (the engine does); this
   * checks the count, which is the one bound that predates the caps, and the
   * frame size, as a tripwire for a caller that did not.
   */
  async putMany(
    entries: readonly BatchEntry[],
    bodyOf: (name: string) => Promise<Uint8Array>,
    onBytes?: (bytes: number) => void,
  ): Promise<{ results: BatchResult[]; uploaded: number; bytes: number }> {
    notifyTransfer(onBytes, 0);
    if (entries.length === 0) return { results: [], uploaded: 0, bytes: 0 };
    if (entries.length > MAX_BATCH_ENTRIES) {
      throw new ProtocolError(
        "toolarge",
        `${entries.length} entries in one batch, the limit is ${MAX_BATCH_ENTRIES}`,
      );
    }
    const frame = { op: "putmany", entries: entries.map(wireEntry) };
    const cap = this.limits?.maxBatchBytes;
    if (cap !== undefined && cap > 0) {
      // A plain error, not a refusal: the server would answer `toolarge`
      // and the engine would write every note in the batch off for good,
      // when what happened is that the caller did not split. Raised as a
      // fault of this program, it is retried like a dropped connection.
      // Bytes of UTF-8, because that is what the server measures.
      const encoded = frameBytes(JSON.stringify(frame)) + 24;
      if (encoded > cap) {
        throw new Error(
          `a putmany of ${entries.length} entries encodes to ${encoded} bytes, over the server's ${cap}; it should have been split`,
        );
      }
    }

    const reply = await this.request(frame, "want or acks");

    let acks = reply;
    let uploaded = 0;
    let bytes = 0;

    if (reply["res"] === "want") {
      const offered = new Set<string>();
      for (const e of entries) for (const name of e.names) offered.add(name);
      const wanted = this.wanted(reply, offered);

      const id = idOf(reply);
      const pending = this.expectMore(id, "acknowledgement");
      bytes = await this.sendBodies(wanted, offered, bodyOf, "batch", onBytes);
      uploaded = wanted.length;
      acks = await this.awaitPhase(pending, id);
    }

    if (acks["res"] !== "acks") {
      throw new ProtocolError("protostate", `expected acks, got ${JSON.stringify(acks)}`);
    }

    // Results are matched to entries by position and nothing else, so a
    // count that does not line up is not something to paper over: the uid
    // that would be recorded against a note would be another note's.
    const raw = acks["results"];
    if (!Array.isArray(raw) || raw.length !== entries.length) {
      throw new ProtocolError(
        "protostate",
        `${entries.length} entries went up and ${Array.isArray(raw) ? raw.length : "no"} results came back`,
      );
    }

    const results = raw.map((r, i): BatchResult => {
      if (typeof r !== "object" || r === null) {
        throw this.malformed(`acks[${i}] is not an object`);
      }
      const row = r as Record<string, unknown>;
      if (row["code"] !== undefined) {
        if (typeof row["code"] !== "string")
          throw this.malformed(`acks[${i}].code is not a string`);
        return { uid: 0, error: errorFrom(row) };
      }
      return { uid: this.uid(row, `acks[${i}]`) };
    });

    // A per-entry refusal is survivable; one that ends the session is not,
    // and the session has to end for the same reason it would on a single put.
    for (const r of results) {
      if (r.error?.endsSession) this.die(r.error);
    }

    await this.drainReceived();
    return { results, uploaded, bytes };
  }

  /**
   * The server queues earlier commits before this write's ack, but applying
   * them to the engine runs asynchronously. Let that work finish before the
   * engine checks whether its upload was built on a stale version. Otherwise
   * both writers can mark divergent edits synced and silently replace them on
   * the next pass.
   *
   * Also used before an arrival-triggered pass, so a burst of metadata is
   * checked together before scanning the vault. Wait only for notifications
   * already queued; no round trip or timer, and later arrivals cannot extend it.
   * Handshake and intermediate `want` replies must remain independent of it.
   */
  async drainReceived(): Promise<void> {
    await this.notifying;
    if (this.closed) throw this.closeReason ?? new ConnectionError("not connected");
  }

  /**
   * Sends the bodies the server asked for, paced against the socket's buffer.
   *
   * Every name is checked against what was offered before anything goes out,
   * because sending a body the put never named is caught by the server as a
   * protocol failure and ends the session.
   *
   * Each body is framed here and nowhere else (plan/protocol.md, "Chunk
   * bodies"): deflated when that is shorter, raw otherwise, so nothing above
   * this line ever sees a marker byte. The byte count is what went on the
   * wire.
   */
  private async sendBodies(
    wanted: readonly string[],
    offered: ReadonlySet<string>,
    bodyOf: (name: string) => Promise<Uint8Array>,
    what: string,
    onBytes?: (bytes: number) => void,
    interleave?: () => Promise<void>,
  ): Promise<number> {
    let bytes = 0;
    let reported = 0;
    const progress =
      onBytes === undefined
        ? undefined
        : () => {
            // bufferedAmount includes bodies still waiting on the connection. With
            // adapters that do not expose it, only handoff to the socket is known.
            const sent = Math.max(0, bytes - (this.socket?.bufferedAmount ?? 0));
            if (sent > reported) {
              reported = sent;
              notifyTransfer(onBytes, sent);
            }
          };
    for (const name of wanted) {
      await interleave?.();
      if (!offered.has(name)) {
        // Already checked when the reply was read; kept because this is
        // the line that sends bytes, and it should not trust a list.
        throw new ProtocolError(
          "badchunk",
          `server asked for ${name}, which this ${what} does not contain`,
        );
      }
      let body: Uint8Array;
      try {
        body = await bodyOf(name);
      } catch (err) {
        // The server has sent `want` and is reading binary frames. It is owed
        // N bodies and is about to get fewer, and there is no frame that says
        // "never mind": the next text frame this client sends would arrive
        // where a body was expected, and the server would end the session over
        // a protocol violation whose real cause was a file that changed on
        // this disk. So the connection is ended here, by the side that knows
        // why, and the caller gets the reason rather than a `protostate` on
        // whatever it asked for next.
        this.die(
          new ConnectionError(
            `${what} could not produce ${name}, so the connection was ended ` +
              `rather than left owing the server bodies: ${(err as Error).message}`,
          ),
        );
        throw err;
      }
      await interleave?.();
      const frame = encodeFrame(body);
      this.send(frame);
      bytes += frame.length;
      await this.drained(interleave ? 256 * 1024 : UPLOAD_HIGH_WATER, progress, interleave);
    }
    // Every body is with the socket before the clock on the ack starts. The
    // ack follows the last body, so a timer armed while bodies were still
    // queued measured the upload rather than the server.
    await this.drained(0, progress, interleave);
    return bytes;
  }

  /**
   * Waits until the socket has handed its queued bytes on, down to `below`.
   *
   * Bodies used to be pushed into the socket as fast as they could be made,
   * and the timer for the ack was armed for the whole drain. A file larger
   * than the link could carry inside one timeout could therefore never be
   * sent: the ack was always late, the connection was closed, and the client
   * reconnected to try the same file again. Pacing the sends against the
   * socket's own buffer keeps memory bounded, and measuring progress rather
   * than the total is what lets a slow link finish.
   *
   * A stall, meaning the buffer has not shrunk in a whole timeout, is the
   * connection being dead, and is treated as one.
   */
  private async drained(
    below: number,
    progress?: () => void,
    interleave?: () => Promise<void>,
  ): Promise<void> {
    progress?.();
    const socket = this.socket;
    if (!socket || socket.bufferedAmount === undefined) return;
    let last = socket.bufferedAmount;
    let movedAt = Date.now();
    let wait = DRAIN_POLL_MS;
    while (socket.bufferedAmount > below) {
      if (this.closed) throw this.closeReason ?? new ConnectionError("not connected");
      // Browser WebSocket has no drain event. Poll only while bytes remain;
      // removing this wait would spin or remove the upload's memory bound.
      await sleep(wait);
      if (interleave) {
        const before = Date.now();
        await interleave();
        movedAt += Date.now() - before;
      }
      const now = socket.bufferedAmount;
      progress?.();
      if (now < last) {
        last = now;
        movedAt = Date.now();
        wait = DRAIN_POLL_MS;
      } else if (Date.now() - movedAt > this.timeoutMs) {
        this.die(
          new ConnectionError(`upload stalled: ${now} bytes unsent for ${this.timeoutMs}ms`),
        );
        throw this.closeReason ?? new ConnectionError("not connected");
      } else {
        wait = Math.min(wait * 2, DRAIN_POLL_MAX_MS);
      }
    }
  }

  /**
   * Re-opens a request's slot for the second reply it will get, with no clock.
   *
   * A put is answered twice under one id: `want`, then `ack` after the bodies.
   * The slot is taken again *before* the bodies go out, because a loopback
   * server acks inside the same tick as the last send, and a waiter
   * installed afterwards found the answer already there. No timer, because
   * the sending phase has its own: `drained` watches the socket for progress,
   * which is the honest measure of an upload. The clock on the reply itself
   * starts in `awaitPhase`, once every body is with the socket.
   */
  private expectMore(id: number, what: string): Promise<Reply> {
    if (this.pending.has(id)) throw new Error(`request ${id} is already waiting for a reply`);
    const pending = new Promise<Reply>((resolve, reject) => {
      if (this.closed) {
        reject(this.closeReason ?? new ConnectionError("not connected"));
        return;
      }
      this.pending.set(id, { what, resolve, reject, timer: undefined, armed: false });
    });
    pending.catch(() => {});
    return pending;
  }

  /** Waits for a reply `expectMore` was told to expect, from now with a clock. */
  private async awaitPhase(pending: Promise<Reply>, id: number): Promise<Reply> {
    const p = this.pending.get(id);
    // Still waiting: the clock starts now that the bodies are sent.
    if (p) this.arm(p);
    return this.awaitReply(pending);
  }

  /** Asks where a version's content lives. */
  async get(uid: number): Promise<{ uid: number; size: number; chunks: string[] }> {
    const reply = await this.request({ op: "get", uid }, "chunks");
    if (reply["res"] !== "chunks") {
      throw new ProtocolError("protostate", `expected chunks, got ${JSON.stringify(reply)}`);
    }
    return {
      uid: this.uid(reply, "chunks"),
      size: this.count(reply, "size", "chunks"),
      chunks: this.chunkNames(reply["chunks"], "chunks"),
    };
  }

  /**
   * Offers bodies for chunks the server has lost, and writes no entry (I14).
   *
   * A put with no version attached. The server answers `want` with whatever it
   * is actually missing, takes those bodies, and reports what it stored and
   * what it still lacks; no uid is allocated, so a vault repaired this way is
   * the vault it should have been rather than one with a synthetic edit in its
   * history. The bodies go up as frames, like a put's (plan/protocol.md,
   * "`resend` is an upload path").
   *
   * `bodyOf` is asked for a chunk only if the server wants it, exactly as in
   * `put` and for the same reason: producing every body up front to discover
   * the server needed none of them is the whole file in memory for nothing.
   */
  async resend(
    names: readonly string[],
    bodyOf: (name: string) => Promise<Uint8Array>,
  ): Promise<{ stored: number; missing: number; bytes: number }> {
    const reply = await this.request({ op: "resend", chunks: [...names] }, "want or resent");

    if (reply["res"] === "resent") {
      return { stored: countOf(reply, "stored"), missing: countOf(reply, "missing"), bytes: 0 };
    }
    if (reply["res"] !== "want") {
      throw new ProtocolError(
        "protostate",
        `expected want or resent, got ${JSON.stringify(reply)}`,
      );
    }

    const offered = new Set(names);
    const wanted = this.wanted(reply, offered);
    // Taken out before the bodies go, for the reason `put` gives: a loopback
    // server answers from inside the last send, and a waiter installed
    // afterwards finds the answer already gone.
    const id = idOf(reply);
    const done = this.expectMore(id, "resent");
    const bytes = await this.sendBodies(wanted, offered, bodyOf, "resend");
    const final = await this.awaitPhase(done, id);
    if (final["res"] !== "resent") {
      throw new ProtocolError("protostate", `expected resent, got ${JSON.stringify(final)}`);
    }
    return { stored: countOf(final, "stored"), missing: countOf(final, "missing"), bytes };
  }

  /**
   * Every version of one path, newest first.
   *
   * An empty list means the server has no versions of that path. It cannot
   * tell "never existed" from "history purged", so neither can this.
   */
  async history(
    path: string,
    opts: { before?: number; limit?: number } = {},
  ): Promise<WireEntry[]> {
    const reply = await this.request(
      {
        op: "history",
        path,
        ...(opts.before !== undefined ? { before: opts.before } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      },
      "history",
    );
    if (reply["res"] !== "history") {
      throw new ProtocolError("protostate", `expected history, got ${JSON.stringify(reply)}`);
    }
    return entriesOf(reply["entries"], "history");
  }

  /**
   * Every path whose newest version is a deletion, newest first.
   *
   * Renames are suppressed by the server and not optionally: a rename leaves
   * a deletion behind at the old path, and a recovery list that is mostly
   * phantom deletions of files that still exist is one nobody reads.
   */
  async deleted(
    limit?: number,
    before?: number,
  ): Promise<{ entries: WireDeletion[]; more: boolean }> {
    const reply = await this.request(
      {
        op: "deleted",
        ...(limit !== undefined ? { limit } : {}),
        // The oldest uid already held, to ask for the page before it (F21).
        ...(before !== undefined && before > 0 ? { before } : {}),
      },
      "deleted",
    );
    if (reply["res"] !== "deleted") {
      throw new ProtocolError("protostate", `expected deleted, got ${JSON.stringify(reply)}`);
    }
    // `more` says the server cut the list short. Dropping it would hand
    // somebody a short list that looks complete, and the note they are
    // looking for is exactly the one that might be missing from it.
    return {
      entries: entriesOf(reply["entries"], "deleted"),
      more: reply["more"] === true,
    };
  }

  /**
   * Downloads chunk bodies, in the order asked for.
   *
   * The answer is `{res:"bodies", count}` and then exactly `count` binary
   * frames, or an `err` and no frames; the server refuses the whole fetch if
   * it lacks any of them, so a partial answer is not a case to handle and
   * bodies from a refused fetch can no longer be taken as the answer to the
   * next one.
   *
   * Every body is decoded from its frame and checked against the name it was
   * asked for, here rather than in the caller, so what comes back is verified
   * raw chunks and nothing above sees a marker byte (plan/protocol.md, "Chunk
   * bodies"). Bodies arrive as bare binary frames with nothing but their order
   * tying them to a name, and the name is a hash of exactly the decoded bytes,
   * so the check is exact and costs one digest.
   *
   * The caller keeps within `maxFetchBytes` and `MAX_FETCH_NAMES`; this
   * refuses a list over the count, which is the one bound it can see whole.
   */
  async fetch(
    names: readonly string[],
    onBytes?: (bytes: number) => void,
    /**
     * Called between bodies, so a saved note can go out while a large
     * attachment is still arriving.
     *
     * Only ever passed for a fetch on the auxiliary wire, for the reason
     * `put`'s is: whatever this does sends frames, and sending them down the
     * stream that is mid-fetch would put them between two bodies. On the
     * second wire the bodies and the interleaved write are on different
     * sockets and cannot meet.
     */
    interleave?: () => Promise<void>,
  ): Promise<Uint8Array[]> {
    if (names.length === 0) return [];
    if (names.length > MAX_FETCH_NAMES) {
      throw new Error(
        `a fetch of ${names.length} chunks is over the ${MAX_FETCH_NAMES} the server takes; it should have been split`,
      );
    }
    if (this.collecting) {
      // Two fetches at once would interleave their bodies on one stream with
      // nothing but arrival order to tell them apart. The engine is
      // single-flight and never does this; the check makes that a property.
      throw new Error("a fetch is already collecting bodies");
    }
    // The collector is in place before the request goes, because the
    // server sends the first body straight after the header, in the same
    // instant on loopback, and a body arriving with nothing collecting is
    // read as one nobody asked for. The bodies get a clock of their own,
    // restarted by every frame that lands.
    const collector: Pending = {
      what: "chunk body",
      resolve: () => {},
      reject: () => {},
      timer: undefined,
      armed: false,
    };
    const got: Uint8Array[] = [];
    const raws: Uint8Array[] = [];
    let received = 0;
    let decoded = 0;
    notifyTransfer(onBytes, 0);
    this.collecting = { pending: collector, want: names.length, got, bytes: 0 };
    // Decoded against the server's own chunk ceiling, which is the most a
    // chunk may inflate to: bounded as it inflates, not after (R13).
    const maxRaw = this.limits?.chunkMax ?? LOCAL_MAX_CHUNK_BYTES;
    const maxFetch = this.limits?.maxFetchBytes ?? MAX_UNAGREED_FETCH_BYTES;
    const checks: Promise<void>[] = [];

    // The first failing hash, made observable the moment it fails (F18).
    //
    // The checks below run alongside the bodies still arriving, and nothing
    // looked at them until every body had been received. A corrupt first body
    // followed by a slow second one therefore rejected with nobody watching:
    // an `unhandledRejection`, which some runtimes are configured to treat as
    // fatal, and then a wait for the rest of what an attacker felt like
    // sending. Racing the wait for each body against this ends the fetch at
    // the first bad hash instead.
    //
    // `stop` is only ever called once, and the `catch` below is what keeps
    // this promise from being the unhandled rejection it exists to prevent
    // when nothing is racing it at that instant.
    let firstBad: Error | undefined;
    let stop: ((err: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      stop = reject;
    });
    void aborted.catch(() => {});

    try {
      const started = this.begin({ op: "fetch", chunks: [...names] }, "bodies");
      const header = await this.awaitReply(started);
      if (header["res"] !== "bodies") {
        throw new ProtocolError("protostate", `expected bodies, got ${JSON.stringify(header)}`);
      }
      const count = this.count(header, "count", "bodies");
      if (count !== names.length) {
        // The server promised a different number of frames from the number
        // of names asked for. Whatever follows cannot be matched to a name.
        throw this.malformed(`bodies announcing ${count} frames for a fetch of ${names.length}`);
      }
      this.arm(collector);
      for (let i = 0; i < count; i++) {
        // Whichever comes first: the next body, or a body already received
        // turning out to be the wrong bytes.
        const frame = await Promise.race([this.body(i), aborted]);
        received += frame.length;
        notifyTransfer(onBytes, received);
        let next: Uint8Array;
        try {
          next = decodeFrame(frame, maxRaw);
        } catch (err) {
          if (!(err instanceof FrameError)) throw err;
          // A body that is not a chunk at all leaves the two ends disagreeing
          // about what was sent, and the rest of the stream cannot be matched
          // to names, so the session ends here, as it does on a bad hash.
          const bad = new ProtocolError(
            err.kind === "toolarge" ? "toolarge" : "badchunk",
            `asked for ${names[i]!} and received a body that does not decode: ${err.message}`,
          );
          this.die(bad);
          throw bad;
        }
        // The frame is done with once it is decoded. Kept, it would double
        // what a large fetch holds for no reason.
        got[i] = EMPTY;
        // And the decoded total against the same budget the frames were held
        // to, since a small deflate stream is not a small chunk.
        decoded += next.length;
        if (decoded > maxFetch) {
          const over = new ProtocolError(
            "toolarge",
            `server sent bodies decoding to ${decoded} bytes for a fetch it said would hold at ` +
              `most ${maxFetch}`,
          );
          this.die(over);
          throw over;
        }
        raws.push(next);
        // Between bodies, not between fetches. A fetch of one 64 MiB
        // attachment is a single request, so a yield that only happened
        // between requests never happened at all, and a note saved during
        // that download waited out the whole of it.
        if (interleave) await interleave();
        // Hashed alongside the next body rather than in front of it.
        //
        // The bodies arrive in order and must be read in order, but
        // verifying one has nothing to do with receiving the next, and
        // waiting for each digest made the check 90% of what a fetch
        // costs this side: 21.6 ms of a 23.9 ms fetch of 2000 bodies,
        // against 5.1 ms taken together.
        //
        // Not dropped, only moved. The session still ends on a mismatch, a
        // few bodies later than it used to, and nothing is written before
        // the check settles.
        const want = names[i]!;
        // Recorded rather than thrown, so nothing in this array is ever a
        // rejection waiting for somebody to notice it. The failure leaves
        // through `aborted`, which the loop above is racing, and through
        // `firstBad` below for a body that was the last one.
        checks.push(
          chunkName(next).then((hash) => {
            if (hash === want) return;
            const bad = new ProtocolError(
              "badchunk",
              `asked for ${want} and received ${next.length} bytes that hash to ${hash}`,
            );
            if (firstBad === undefined) {
              firstBad = bad;
              stop?.(bad);
            }
          }),
        );
      }
      await Promise.all(checks);
      if (firstBad !== undefined) throw firstBad;
    } catch (err) {
      if (err instanceof ProtocolError && err.code === "badchunk") this.die(err);
      throw err;
    } finally {
      this.disarm(collector);
      this.collecting = undefined;
    }
    return raws;
  }

  /** Waits for the i-th body of the fetch in progress. */
  private async body(i: number): Promise<Uint8Array> {
    const fetch = this.collecting;
    if (!fetch || this.closed) throw this.closeReason ?? new ConnectionError("not connected");
    if (fetch.got.length <= i) {
      await new Promise<void>((resolve) => {
        fetch.waiter = resolve;
      });
      if (this.closed) throw this.closeReason ?? new ConnectionError("not connected");
    }
    return fetch.got[i]!;
  }

  /**
   * Mints a single-use invite for another device (plan/protocol.md, "Devices
   * and invites").
   *
   * The server makes the token and answers with it once, with the invite's id
   * and when it stops working. `ttlMs` of zero or absent is the server's
   * default of an hour, and anything above an hour is clamped to it; an invite
   * that never expires is made only with `trewd invite -ttl 0` on the server.
   */
  async invite(args: { ttlMs?: number; label?: string } = {}): Promise<MintedInvite> {
    const reply = await this.request(
      {
        op: "invite",
        ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {}),
        ...(args.label !== undefined && args.label !== "" ? { label: args.label } : {}),
      },
      "invited",
    );
    if (reply["res"] !== "invited") {
      throw new ProtocolError("protostate", `expected invited, got ${JSON.stringify(reply)}`);
    }
    const invite = reply["invite"];
    if (typeof invite !== "string" || invite === "") {
      throw this.malformed("an invited with no invite id");
    }
    const token = reply["token"];
    let raw: Uint8Array | undefined;
    try {
      raw = typeof token === "string" ? base64urlDecode(token) : undefined;
    } catch {
      raw = undefined;
    }
    if (typeof token !== "string" || raw?.length !== INVITE_TOKEN_WIRE_BYTES) {
      // The token is what goes into the string somebody pastes. One this
      // device cannot read back as sixteen bytes makes an invite that fails
      // on the other device, far from here.
      throw this.malformed(`an invited whose token is not ${INVITE_TOKEN_WIRE_BYTES} bytes`);
    }
    return { invite, token, expiresAt: this.expiry(reply["expiresAt"], "invited") };
  }

  /**
   * Cancels an outstanding invite, so the string somebody is holding stops
   * working before it expires.
   *
   * Takes the invite's id, the handle a listing shows, which cannot redeem
   * anything. An id that is unknown, malformed, spent, cancelled or expired is
   * one refusal, `badentry`, saying which to nobody.
   */
  async uninvite(invite: string): Promise<void> {
    const reply = await this.request({ op: "uninvite", invite }, "uninvited");
    if (reply["res"] !== "uninvited") {
      throw new ProtocolError("protostate", `expected uninvited, got ${JSON.stringify(reply)}`);
    }
    if (reply["invite"] !== invite) {
      throw this.malformed(
        `an uninvited naming ${JSON.stringify(reply["invite"])}, which is not the ${JSON.stringify(invite)} that was cancelled`,
      );
    }
  }

  /**
   * Every device that may reach this vault, and every invite that could still
   * add one.
   *
   * The invites come with the devices because they are one answer: a row is
   * what has been added and an outstanding invite is what is about to be.
   */
  async devices(): Promise<{ devices: DeviceRow[]; invites: InviteRow[] }> {
    const reply = await this.request({ op: "devices" }, "devices");
    if (reply["res"] !== "devices") {
      throw new ProtocolError("protostate", `expected devices, got ${JSON.stringify(reply)}`);
    }
    const list = reply["devices"];
    if (!Array.isArray(list)) {
      throw this.malformed("a devices reply with no list of devices");
    }
    // A server that answers no `invites` at all is a malformed reply, the same
    // as one with no `devices`: both are always sent, and reading a missing
    // list as "none outstanding" would show an empty invite list with as much
    // confidence as a true one. That is rule 7 in miniature.
    const invites = reply["invites"];
    if (!Array.isArray(invites)) {
      throw this.malformed("a devices reply with no list of invites");
    }
    return {
      devices: list.map((raw, i) => this.deviceRow(raw, i)),
      invites: invites.map((raw, i) => this.inviteRow(raw, i)),
    };
  }

  /** A completed local checkpoint, separate from the received metadata cursor. */
  async applied(cursor: number): Promise<void> {
    const reply = await this.request({ op: "applied", applied: cursor }, "applied");
    if (reply["res"] !== "applied" || this.count(reply, "cursor", "applied") !== cursor) {
      throw this.malformed("an applied reply that does not match the checkpoint");
    }
  }

  /** One invite, read as strictly as a device row and for the same reason. */
  private inviteRow(raw: unknown, i: number): InviteRow {
    const row = raw as Record<string, unknown>;
    const invite = row?.["invite"];
    if (typeof invite !== "string" || invite === "") {
      throw this.malformed(`a devices reply whose invite ${i} has no id`);
    }
    const label = row["label"];
    return {
      invite,
      label: typeof label === "string" ? label : "",
      expiresAt: this.expiry(row["expiresAt"], `a devices reply's invite ${i}`),
    };
  }

  /**
   * An invite's expiry: server milliseconds, or null for one that never
   * expires, and nothing else.
   *
   * A missing one cannot become zero: that reads as "expired in 1970" and
   * would have a person ignore an invite that still works. Null is a real
   * answer and is kept apart from absent for the same reason.
   */
  private expiry(v: unknown, of: string): number | null {
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      throw this.malformed(`${of} with expiresAt = ${JSON.stringify(v)}, not a time or null`);
    }
    return v;
  }

  /** One row, read strictly: a list somebody acts on is not a place to guess. */
  private deviceRow(raw: unknown, i: number): DeviceRow {
    const row = raw as Record<string, unknown>;
    const id = row?.["id"];
    if (typeof id !== "string" || id === "") {
      throw this.malformed(`a devices reply whose entry ${i} has no id`);
    }
    const name = row["name"];
    if (
      typeof row["online"] !== "boolean" ||
      !(
        row["applied"] === null ||
        (typeof row["applied"] === "number" &&
          Number.isSafeInteger(row["applied"]) &&
          row["applied"] >= 0)
      ) ||
      (row["online"] === false && row["applied"] !== null)
    ) {
      throw this.malformed(`a devices reply with invalid delivery state at entry ${i}`);
    }
    const num = (key: string): number => {
      const v = row[key];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    };
    return {
      id,
      name: typeof name === "string" ? name : "",
      createdAt: num("createdAt"),
      lastSeen: num("lastSeen"),
      online: row["online"],
      applied: row["applied"],
    };
  }

  /**
   * Removes a device's row and closes every session it has open.
   *
   * The reply means both, in that order, and the ordering is the guarantee:
   * see plan/protocol.md, "Devices and invites". Revoking a device also
   * cancels the invites it issued, and the last device may be revoked: the way
   * back is `trewd invite` on the server.
   *
   * `self` says the row removed was this session's own, in which case this is
   * the last frame on the connection.
   */
  async revoke(args: { deviceId: string }): Promise<{ deviceId: string; self: boolean }> {
    const reply = await this.request({ op: "revoke", deviceId: args.deviceId }, "revoked");
    if (reply["res"] !== "revoked") {
      throw new ProtocolError("protostate", `expected revoked, got ${JSON.stringify(reply)}`);
    }
    const deviceId = reply["deviceId"];
    if (deviceId !== args.deviceId) {
      throw this.malformed(
        `a revoked naming device ${JSON.stringify(deviceId)}, which is not the ${JSON.stringify(args.deviceId)} that was revoked`,
      );
    }
    return { deviceId, self: reply["self"] === true };
  }

  /**
   * Changes this device's own label in the vault's device list.
   *
   * Only its own: there is no field naming a row, because the row is the one
   * this session authenticated as. A device relabelling another would need a
   * rule for who may relabel whom, and the only thing that wants one is tidying
   * somebody else's list.
   *
   * The name is echoed back and checked against what was sent, for the reason
   * every other reply here is checked: the server is the authority on what the
   * device list says, and a client that believed its own request would not
   * notice a server that stored something else.
   *
   * Nothing about the vault's content moves. No uid is spent, no entry is
   * written, and a pass running on another device is unaffected; that device
   * sees the new label the next time it lists.
   */
  /**
   * Undoes one operation of the vault (protocol 2; plan/protocol.md, "Undo
   * (protocol 2)"), by the id a history entry's `op` names.
   *
   * An undo puts back what the operation displaced, as one operation, and
   * only if every path it changed still holds what it left there. A note
   * changed since refuses it with `stale`, naming who changed what, and
   * `toCopy` then writes each version the operation replaced beside its note
   * and changes nothing else. Anything no retry changes is `noundo`, whose
   * message begins with the reason. The versions it wrote reach this device
   * as an ordinary batch before this resolves.
   */
  async undo(opId: string, opts: { toCopy?: boolean } = {}): Promise<UndoResult> {
    if (opId === "") throw new Error("an undo names the operation it undoes");
    const reply = await this.request(
      { op: "undo", opId, ...(opts.toCopy === true ? { toCopy: true } : {}) },
      "undone",
    );
    if (reply["res"] !== "undone") {
      throw new ProtocolError("protostate", `expected undone, got ${JSON.stringify(reply)}`);
    }
    const own = reply["opId"];
    if (typeof own !== "string" || own === "" || reply["undoes"] !== opId) {
      throw this.malformed(
        `an undone for ${JSON.stringify(reply["undoes"])}, which is not the ${JSON.stringify(opId)} that was undone`,
      );
    }
    if (reply["toCopy"] !== (opts.toCopy === true)) {
      throw this.malformed("an undone that did not do what was asked, in place or as a copy");
    }
    const steps = reply["steps"];
    const entries = reply["entries"];
    if (!Array.isArray(steps) || !Array.isArray(entries)) {
      throw this.malformed("an undone with no list of steps or entries");
    }
    const text = (row: Record<string, unknown>, key: string): string | undefined => {
      const v = row[key];
      return typeof v === "string" && v !== "" ? v : undefined;
    };
    return {
      opId: own,
      undoes: opId,
      toCopy: opts.toCopy === true,
      committedAt: this.count(reply, "committedAt", "undone"),
      steps: steps.map((raw, i) => {
        const row = raw as Record<string, unknown>;
        const action = text(row ?? {}, "action");
        const path = text(row ?? {}, "path");
        if (action === undefined || path === undefined) {
          throw this.malformed(`an undone whose step ${i} names no action or no path`);
        }
        const step: {
          action: string;
          path: string;
          from?: string;
          copy?: string;
          before?: number;
          after?: number;
          why?: string;
        } = { action, path };
        for (const key of ["from", "copy", "why"] as const) {
          const v = text(row, key);
          if (v !== undefined) step[key] = v;
        }
        for (const key of ["before", "after"] as const) {
          const v = row[key];
          if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) step[key] = v;
        }
        return step;
      }),
      entries: entries.map((raw, i) => {
        const row = raw as Record<string, unknown>;
        const path = text(row ?? {}, "path");
        const uid = row?.["uid"];
        const previousUid = row?.["previousUid"];
        if (
          path === undefined ||
          typeof uid !== "number" ||
          !Number.isSafeInteger(uid) ||
          uid <= 0 ||
          typeof previousUid !== "number" ||
          !Number.isSafeInteger(previousUid) ||
          previousUid < 0
        ) {
          throw this.malformed(`an undone whose entry ${i} is not a path and two uids`);
        }
        const prev = text(row, "prev");
        return { path, uid, previousUid, ...(prev !== undefined ? { prev } : {}) };
      }),
    };
  }

  async rename(name: string): Promise<string> {
    const reply = await this.request({ op: "rename", name }, "renamed");
    if (reply["res"] !== "renamed") {
      throw new ProtocolError("protostate", `expected renamed, got ${JSON.stringify(reply)}`);
    }
    const said = reply["name"];
    if (said !== name) {
      throw this.malformed(
        `a renamed naming ${JSON.stringify(said)}, which is not the ${JSON.stringify(name)} that was sent`,
      );
    }
    return name;
  }

  /* ------------------------------------------------------------ *
   * Strict reading of what the server answered
   * ------------------------------------------------------------ */

  /**
   * A malformed reply ends the session.
   *
   * Success replies were read as leniently as the batch frames were read
   * strictly: a missing or non-numeric uid became zero and was committed to
   * the index as the version of a note, and a `want` with a malformed member
   * dropped it and went on. A server that answers in a shape this client does
   * not know is a server this client does not understand, and the only safe
   * thing to do about that is stop.
   */
  private malformed(what: string): ProtocolError {
    const err = new ProtocolError("protostate", `server sent ${what}`);
    this.die(err);
    return err;
  }

  /** A non-negative integer field, or the end of the session. */
  private count(reply: Reply, field: string, of: string): number {
    const v = reply[field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw this.malformed(
        `${of} with ${field} = ${JSON.stringify(v)}, not a non-negative integer`,
      );
    }
    return v;
  }

  /** A version number, which is a positive integer, or the end of the session. */
  private uid(reply: Reply, of: string): number {
    const v = this.count(reply, "uid", of);
    if (v === 0) throw this.malformed(`${of} with uid 0, which no version has`);
    return v;
  }

  /** A list of chunk names, or the end of the session. */
  private chunkNames(v: unknown, of: string): string[] {
    if (!Array.isArray(v)) throw this.malformed(`${of} with no chunks list`);
    for (const name of v) {
      if (!isChunkName(name)) {
        throw this.malformed(`${of} naming ${JSON.stringify(name)}, which is not a chunk name`);
      }
    }
    return v as string[];
  }

  /**
   * What a `want` asks for: chunk names, each offered by this put, none twice.
   *
   * A name that was never offered is the server asking for bytes this put
   * does not have, which is `badchunk` and ends the session; a duplicate
   * would have the same body sent twice under one name, which the server
   * cannot mean.
   */
  private wanted(reply: Reply, offered: ReadonlySet<string>): string[] {
    const names = reply["chunks"];
    if (!Array.isArray(names)) throw this.malformed("want with no chunks list");
    const seen = new Set<string>();
    for (const name of names) {
      if (typeof name !== "string") {
        throw this.malformed(`want naming ${JSON.stringify(name)}, which is not a chunk name`);
      }
      // Offered is the test of a name here, not its shape: what was offered
      // is by construction well formed, and anything else is the server
      // asking for bytes this put does not have.
      if (!offered.has(name)) {
        const err = new ProtocolError(
          "badchunk",
          `server asked for ${name}, which this put does not contain`,
        );
        this.die(err);
        throw err;
      }
      if (seen.has(name)) throw this.malformed(`want naming ${name} twice`);
      seen.add(name);
    }
    return names as string[];
  }

  /**
   * Says something, so the connection is not idle, and hears something back.
   *
   * Pings carry no id, in either direction, so this is the one exchange still
   * matched by position: a pong answers the ping in flight, and there is at
   * most one.
   */
  ping(): Promise<void> {
    if (this.pingPromise) return this.pingPromise;
    const work = this.sendPing();
    this.pingPromise = work;
    void work.then(
      () => {
        this.pingPromise = undefined;
      },
      () => {
        this.pingPromise = undefined;
      },
    );
    return work;
  }

  /** Detect an idle socket stranded by sleep, without timing out active transfers. */
  async probe(timeoutMs = 2000): Promise<void> {
    const timer = setTimeout(() => {
      if (this.pinging && this.pending.size === 0 && !this.collecting) {
        this.die(new ConnectionError("the connection did not respond after resuming"));
      }
    }, timeoutMs);
    try {
      await this.ping();
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendPing(): Promise<void> {
    this.requestsSent++;
    const reply = await new Promise<Reply>((resolve, reject) => {
      if (this.closed) {
        reject(this.closeReason ?? new ConnectionError("not connected"));
        return;
      }
      const p: Pending = { what: "pong", resolve, reject, timer: undefined, armed: false };
      this.pinging = p;
      this.arm(p);
      try {
        this.send(JSON.stringify({ op: "ping" }));
      } catch (err) {
        this.pinging = undefined;
        this.disarm(p);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    if (reply["res"] !== "pong") {
      throw new ProtocolError("protostate", `expected pong, got ${JSON.stringify(reply)}`);
    }
  }
}

/**
 * Refuses a `vault` or `device` name the server would refuse, before it goes.
 *
 * Bounded in bytes, not characters, because that is how the server counts,
 * and a name of sixty-four accented letters is more than sixty-four bytes.
 */
export function checkName(what: "vault" | "device", name: string): void {
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > MAX_NAME_BYTES) {
    throw new ProtocolError(
      "badname",
      `the ${what} name is ${bytes} bytes, and the server takes at most ${MAX_NAME_BYTES}`,
    );
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new ProtocolError(
        "badname",
        `the ${what} name contains a control character at position ${i}, which the server refuses because the name lands in its log`,
      );
    }
  }
}

/**
 * Names both protocol versions in a `proto` refusal, and says which end to
 * upgrade.
 *
 * A server that does not speak this client's protocol refuses the hello, and
 * the refusal arrives here as the close reason. Its message names the server's
 * range and version; this adds the client's version and the one instruction
 * that follows from the upgrade order, which is the server first. Kept against
 * the next version, not for any version that exists.
 */
function protoRefusal(err: unknown): unknown {
  if (err instanceof ProtocolError && err.code === "proto") {
    return new ProtocolError(
      "proto",
      `${err.message}. This client speaks protocol ${PROTO}; upgrade the server first`,
      { retryable: false },
    );
  }
  return err;
}

/** The id a reply came back under, which every reply reaching a caller has. */
/**
 * A count out of a reply, refused rather than coerced.
 *
 * `Number(undefined)` is NaN and `Number(null)` is 0, and a repair reporting
 * "0 still missing" because a field was absent is the wrong kind of good news.
 */
function countOf(reply: Reply, field: string): number {
  const raw = reply[field];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new ProtocolError("protostate", `${field} is ${JSON.stringify(raw)}, not a count`);
  }
  return raw;
}

function idOf(reply: Reply): number {
  const id = reply["id"];
  if (typeof id !== "number") throw new Error("a matched reply lost its id, which cannot happen");
  return id;
}

/* ---------------------------------------------------------------- *
 * Reconnect pacing
 * ---------------------------------------------------------------- */

/**
 * Exponential backoff with jitter, in Obsidian's shape.
 *
 * Read at `app.pretty.js:176896`, and used by its engine as
 * `new Backoff(0, 300_000, 5_000, true)`: no delay on the first attempt, five
 * seconds doubling, capped at five minutes.
 *
 * The jitter is 50% to 100% of the computed delay, and it is not decoration. A
 * server restarting with several devices attached would otherwise have all of
 * them return at the same instant, fail together, and come back together.
 */
export class Backoff {
  private count = 0;

  constructor(
    private readonly min = 0,
    private readonly max = 300_000,
    private readonly base = 5_000,
    private readonly jitter = true,
    private readonly random: () => number = Math.random,
  ) {}

  /** Records a success: the next attempt waits only the floor. */
  success(): void {
    this.count = 0;
  }

  fail(): void {
    this.count++;
  }

  /** How long the next attempt waits, given the failures so far. */
  delay(): number {
    if (this.count === 0) return this.min;
    let t = this.base * Math.pow(2, this.count - 1);
    if (this.jitter) t *= 0.5 + 0.5 * this.random();
    return Math.floor(Math.min(this.max, this.min + t));
  }
}

/* ---------------------------------------------------------------- *
 * Plumbing
 * ---------------------------------------------------------------- */

function defaultSocketFactory(url: string): SocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!ctor) {
    throw new Error("no WebSocket available in this environment");
  }
  return new ctor(url) as SocketLike;
}

/**
 * How much may sit in the socket's buffer before the next body waits.
 *
 * Enough to keep the link busy between one body being framed and the next,
 * not so much that a large attachment is held twice, once by the caller and
 * once by the socket.
 */
const UPLOAD_HIGH_WATER = 4 * 1024 * 1024;

/**
 * How often the socket buffer is looked at while an upload drains, at its
 * fastest and at its slowest.
 *
 * It starts fast, because the wait at the start of each body is short and a
 * slow first look is latency added to every chunk. It widens while the buffer
 * is not moving, because a buffer that has not moved in 5 ms will not have
 * moved in the next 5 ms either: at a fixed 5 ms a 64 MiB attachment woke the
 * event loop two hundred times a second for the length of the upload, which on
 * a phone is the radio and the CPU both kept awake to read one number
 * (R083-22). Every look that finds progress resets it, so the responsiveness
 * that matters, the moment the buffer clears, is unchanged.
 */
const DRAIN_POLL_MS = 5;
const DRAIN_POLL_MAX_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a frame is replaced by once its chunk is decoded, so it can be freed. */
const EMPTY = new Uint8Array(0);

/** The length of an invite token, as the `invited` reply carries it. */
const INVITE_TOKEN_WIRE_BYTES = 16;

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function describeClose(ev: { code?: number; reason?: string }): string {
  const code = ev.code ?? 0;
  const reason = ev.reason ? `, ${ev.reason}` : "";
  return `code ${code}${reason}`;
}

/**
 * Reads an entry list off the wire, refusing anything that is not one.
 *
 * Not `Array.isArray(x) ? x : []`. A server that answered null, or answered
 * with a field missing, would become "there is nothing to recover", and the one
 * moment somebody runs this is the moment they have lost a note. An unreadable
 * answer has to be an error.
 */
function entriesOf(value: unknown, what: string): WireEntry[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError("protostate", `${what} came back without a list of entries`);
  }
  value.forEach((e, i) => {
    // The same shape a batch entry is held to. A recovery list is read by a
    // person deciding what to bring back, and a version with no uid or no
    // path is one they cannot act on and must not be shown as if they could.
    const row = e as Partial<WireEntry> | null;
    if (typeof row?.uid !== "number" || !Number.isSafeInteger(row.uid) || row.uid <= 0) {
      throw new ProtocolError("protostate", `${what}[${i}] has no usable uid`);
    }
    if (typeof row.path !== "string" || row.path === "") {
      throw new ProtocolError("protostate", `${what}[${i}] has no path`);
    }
    if (!Array.isArray(row.chunks)) {
      throw new ProtocolError("protostate", `${what}[${i}] has no chunks list`);
    }
    // Every name the shape a chunk name has, before anything is fetched by
    // it. A `get` is held to this already; a recovery list was not.
    for (const name of row.chunks) {
      if (!isChunkName(name)) {
        throw new ProtocolError(
          "protostate",
          `${what}[${i}] names ${JSON.stringify(name)}, which is not a chunk name`,
        );
      }
    }
    // The operation behind a version, when there is one (protocol 2). The
    // history panel offers to undo by its id, so an id that is not a string
    // is not one to offer.
    if (row.op !== undefined) {
      const op = row.op as Partial<OperationRef> | null;
      if (
        typeof op?.id !== "string" ||
        op.id === "" ||
        typeof op.tool !== "string" ||
        typeof op.kind !== "string" ||
        (op.undoneBy !== undefined && typeof op.undoneBy !== "string")
      ) {
        throw new ProtocolError(
          "protostate",
          `${what}[${i}] names an operation it does not describe`,
        );
      }
    }
  });
  return value as WireEntry[];
}
