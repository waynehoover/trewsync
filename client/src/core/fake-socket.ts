/**
 * A socket under a test's control, and an engine wired to one.
 *
 * `server-harness.test.ts` proves the client and the real server agree. It
 * cannot prove the client is robust, because the real server never lies, so
 * this is the lying peer: it can say anything at all, in any order, and it
 * answers by echoing the id of the newest request unless told otherwise, which
 * is what a correct server does and what almost every case wants.
 *
 * Imported only by tests, like test-server.ts, so nothing here reaches a
 * shipped bundle.
 */

import { Engine } from "./engine.ts";
import { PROTO, Transport, type SocketLike } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

export class FakeSocket implements SocketLike {
  binaryType = "";
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  /** Everything the client sent, in order. */
  readonly sentText: Record<string, unknown>[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closed = false;
  /**
   * Answers a request the moment it is sent, on the next tick, for the cases
   * where the engine is driving and the test only watches what went out.
   */
  autoReply: ((frame: Record<string, unknown>, socket: FakeSocket) => void) | undefined;

  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (typeof data === "string") {
      const frame = JSON.parse(data) as Record<string, unknown>;
      this.sentText.push(frame);
      const auto = this.autoReply;
      if (auto) setTimeout(() => auto(frame, this), 0);
    } else
      this.sentBinary.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(undefined);
  }

  /** The id of the newest request that carried one. */
  get lastId(): number | undefined {
    for (let i = this.sentText.length - 1; i >= 0; i--) {
      const id = this.sentText[i]!["id"];
      if (typeof id === "number") return id;
    }
    return undefined;
  }

  /** Delivers a reply, under the id of the newest request unless told otherwise. */
  reply(frame: Record<string, unknown>): void {
    const out = { ...frame };
    if (out["id"] === null) delete out["id"];
    else if (out["id"] === undefined && "res" in out && out["res"] !== "pong") {
      const id = this.lastId;
      if (id !== undefined) out["id"] = id;
    }
    this.raw(out);
  }

  /** Delivers exactly this text frame. */
  raw(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  body(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  /**
   * Answers a fetch: the header, then the bodies, each framed raw the way a
   * protocol 1 server may send it (plan/protocol.md, "Chunk bodies").
   *
   * `body` sends exactly the bytes it is given, for a case that wants a frame
   * of its own making: a deflated one, an unknown marker, an empty frame.
   */
  bodies(...bodies: Uint8Array[]): void {
    this.reply({ res: "bodies", count: bodies.length });
    for (const b of bodies) this.body(rawFrame(b));
  }

  hangUp(code = 1006, reason = "gone"): void {
    this.onclose?.({ code, reason });
  }
}

/** The epoch every fake server's `ready` carries unless a case says otherwise. */
export const RIG_EPOCH = "rig-epoch";

/** A well-formed ready, with whatever the case wants changed. */
export function ready(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    res: "ready",
    proto: PROTO,
    minProto: PROTO,
    serverVersion: "test",
    // Every store has one, so the well-formed frame carries one. A case that
    // wants a server without it passes `epoch: undefined`.
    epoch: RIG_EPOCH,
    cursor: 10,
    perFileMax: 1,
    // The protocol's own ceiling, and above the chunker's floor, which an
    // engine refuses a server for being under.
    chunkMax: 1 << 20,
    maxChunks: 1,
    maxBatchBytes: 16 << 20,
    maxFetchBytes: 64 << 20,
    ...over,
  };
}

/** A chunk framed raw: the marker byte, then the bytes. */
export function rawFrame(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + raw.length);
  out[0] = 0;
  out.set(raw, 1);
  return out;
}

/** Lets queued notification work run before asserting on it. */
export const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

/**
 * Settles until something is true, rather than a guessed number of times.
 *
 * `settle()` is one macrotask, so `await settle(); await settle();` is a guess
 * about how many the work takes. It is right for notification work, which is
 * queued and synchronous once it runs. It is wrong for anything that waits on
 * something asynchronous, a digest or a vault read, and two settles was enough
 * on a laptop and not enough on a loaded CI runner. The test failed there
 * saying "nothing refused the batch, so this proves nothing", which is the
 * guard doing its job about a race in the test rather than a fault in the
 * client.
 *
 * `invariants.test.ts` already had this shape written out inline in two places,
 * as `for (let i = 0; i < 200 && ...; i++) await settle()`. This is the same
 * thing with a name and a reason, so the next assertion about a refusal does
 * not have to rediscover it.
 */
export async function settleUntil(what: string, cond: () => boolean, ticks = 400): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (cond()) return;
    await settle();
  }
  if (!cond()) throw new Error(`settled ${ticks} times and ${what} never happened`);
}

/** An engine wired to a fake socket, connected, with limits of the test's choosing. */
export async function engineOnFakeSocket(
  limits: {
    maxChunks?: number;
    perFileMax?: number;
    chunkMax?: number;
    maxBatchBytes?: number;
    maxFetchBytes?: number;
    cursor?: number;
    epoch?: string;
  } = {},
  opts: { vault?: MemoryVault; store?: MemoryIndexStore; windows?: boolean } = {},
): Promise<{
  engine: Engine;
  socket: FakeSocket;
  t: Transport;
  vault: MemoryVault;
  logs: string[];
  store: MemoryIndexStore;
}> {
  const socket = new FakeSocket();
  const logs: string[] = [];
  let engine!: Engine;
  const t = new Transport("ws://test", {
    onBatch: (b) => engine.acceptBatch(b),
    socketFactory: () => socket,
    timeoutMs: 2000,
    log: (m, ...rest) => void logs.push(`${m} ${rest.map((r) => JSON.stringify(r)).join(" ")}`),
  });
  const connecting = t.connect();
  socket.open();
  await connecting;

  const vault = opts.vault ?? new MemoryVault();
  // Sharable, so a test can build a second engine on the state the first
  // wrote and ask what survives a restart.
  const store = opts.store ?? new MemoryIndexStore();
  engine = new Engine({
    vault,
    store,
    transport: t,
    device: "d",
    vaultId: "v",
    deviceId: "rig-device",
    token: "t",
    ...(opts.windows ? { windows: true } : {}),
    log: (m, ...rest) => void logs.push(`${m} ${rest.map((r) => JSON.stringify(r)).join(" ")}`),
  });
  const started = engine.start();
  await settle();
  socket.reply(
    ready({
      epoch: limits.epoch ?? RIG_EPOCH,
      cursor: limits.cursor ?? 0,
      perFileMax: limits.perFileMax ?? 1 << 28,
      chunkMax: limits.chunkMax ?? 1 << 20,
      maxChunks: limits.maxChunks ?? 100,
      maxBatchBytes: limits.maxBatchBytes ?? 16 << 20,
      maxFetchBytes: limits.maxFetchBytes ?? 64 << 20,
    }),
  );
  await settle();
  socket.raw({ op: "caught-up", cursor: limits.cursor ?? 0 });
  await started;
  return { engine, socket, t, vault, logs, store };
}
