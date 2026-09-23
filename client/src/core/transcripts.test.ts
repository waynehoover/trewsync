/**
 * `protocol-transcripts.json`, played back to the real transport.
 *
 * The file holds protocol 1 exchanges message by message, written by
 * `scripts/protocol-transcripts.py` and replayed against a real server on a
 * fresh store by `internal/server/transcripts_test.go`, which fails on any
 * frame the server sends that differs. This is the other half: a fake socket
 * plays the server's side of every transcript to the real `Transport`, and
 * every frame the client sends is held to the client's side of it. A
 * transcript that passes both is the server's behaviour and the client's
 * contract at once, which is what the file is for (its `note` is the format).
 *
 * Each Transport call is derived from the transcript's own client frames: the
 * hello from the hello frame, a put or a putmany from its frame with `bodyOf`
 * answering from the bodies the transcript sends after it, and a fetch, a
 * resend, an applied, a devices and a ping from theirs. Server frames go out
 * with each placeholder's example in place, `store` steps are skipped (the
 * server's frames already reflect them), and at the end nothing may be left
 * over on either side: no frame the client sent that the transcript lacks, no
 * call still waiting on a server frame, and no connection closed that the
 * transcript did not close.
 *
 * Text frames are compared as parsed JSON: the same keys, no others, equal
 * values. A binary frame is compared byte for byte where the transcript's hex
 * is exactly what this client's `encodeFrame` makes of those bytes, and by
 * the bytes it decodes to otherwise, since a sender may deflate or not; which
 * of the two each step used is pinned below.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { FakeSocket, rawFrame, settle } from "./fake-socket.ts";
import { MARKER_DEFLATE, decodeFrame, encodeFrame } from "./frame.ts";
import {
  LOCAL_MAX_CHUNK_BYTES,
  ProtocolError,
  Transport,
  type Batch,
  type BatchEntry,
  type PutMeta,
} from "./transport.ts";

/* ---------------------------------------------------------------- *
 * The file
 * ---------------------------------------------------------------- */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Frame = { [key: string]: Json };

interface Placeholder {
  kind: "string" | "number";
  same: boolean;
  example: string | number;
  about: string;
}

interface Step {
  conn?: string;
  send?: Frame;
  sendBinary?: string;
  expect?: Frame;
  expectBinary?: string;
  expectClose?: boolean;
  close?: boolean;
  store?: Frame;
}

interface Transcript {
  name: string;
  covers: string;
  steps: Step[];
}

interface TranscriptFile {
  note: string[];
  format: number;
  vault: string;
  placeholders: Record<string, Placeholder>;
  devices: Record<string, { deviceId: string; token: string; device: string; createdAt: number }>;
  transcripts: Transcript[];
}

const FILE = join(import.meta.dirname, "..", "..", "..", "protocol-transcripts.json");

/** A fresh copy of the file, so a case can damage it without touching another's. */
function load(): TranscriptFile {
  return JSON.parse(readFileSync(FILE, "utf8")) as TranscriptFile;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error(`${hex} is not hex`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * A server frame as a fake socket sends it: each placeholder's example, and
 * for `$prefix:TEXT` the text followed by "example" (the file's `note`).
 */
function substituted(value: Json, placeholders: Record<string, Placeholder>): Json {
  if (typeof value === "string" && value.startsWith("$")) {
    if (value.startsWith("$prefix:")) return `${value.slice("$prefix:".length)}example`;
    const holder = placeholders[value];
    if (holder === undefined) throw new Error(`${value} is not a placeholder the file defines`);
    return holder.example;
  }
  if (Array.isArray(value)) return value.map((v) => substituted(v, placeholders));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituted(v, placeholders)]),
    );
  }
  return value;
}

/**
 * Holds a frame the client sent to the one the transcript has: the same keys,
 * no others, and equal values all the way down. Throws naming the first
 * difference, which is what a failed replay reports.
 */
function compareText(want: Json, got: Json, where: string): void {
  const say = (v: Json) => JSON.stringify(v);
  if (typeof want === "string" && want.startsWith("$")) {
    // The client's frames are concrete in the file; a placeholder in one is a
    // transcript this replayer does not know how to hold the client to.
    throw new Error(`${where}: ${want} in a client frame, which this replayer does not match`);
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) {
      throw new Error(`${where}: the transcript has ${say(want)}, the client sent ${say(got)}`);
    }
    want.forEach((w, i) => compareText(w, got[i]!, `${where}[${i}]`));
    return;
  }
  if (want !== null && typeof want === "object") {
    if (got === null || typeof got !== "object" || Array.isArray(got)) {
      throw new Error(`${where}: the transcript has ${say(want)}, the client sent ${say(got)}`);
    }
    for (const key of Object.keys(got)) {
      if (!(key in want)) {
        throw new Error(`${where}: the client sent "${key}", which the transcript does not have`);
      }
    }
    for (const key of Object.keys(want)) {
      if (!(key in got)) {
        throw new Error(`${where}: the transcript has "${key}", which the client did not send`);
      }
      compareText(want[key]!, got[key]!, `${where}.${key}`);
    }
    return;
  }
  if (!Object.is(want, got)) {
    throw new Error(`${where}: the transcript has ${say(want)}, the client sent ${say(got)}`);
  }
}

/* ---------------------------------------------------------------- *
 * The replay
 * ---------------------------------------------------------------- */

/** A fake socket that keeps what the client sent in the order it was sent. */
class RecordingSocket extends FakeSocket {
  readonly sent: ({ text: Frame } | { binary: Uint8Array })[] = [];
  override send(data: string | ArrayBufferLike | Uint8Array): void {
    super.send(data);
    if (typeof data === "string") this.sent.push({ text: this.sentText.at(-1) as Frame });
    else this.sent.push({ binary: this.sentBinary.at(-1)! });
  }
}

/** One call made on a connection, and how it ended. */
interface Call {
  op: string;
  outcome?: { ok: true; value: unknown } | { ok: false; error: unknown };
}

/** One connection of a transcript: its socket, its transport, and what it was given. */
interface Conn {
  name: string;
  socket: RecordingSocket;
  t: Transport;
  batches: Batch[];
  caughtUp: number[];
  calls: Call[];
  /** Client frames already held to a step. */
  consumed: number;
  /** Whether a `close` or `expectClose` step ended it. */
  ended: boolean;
  /** Whether it was still open after the last step, before the replay closed it. */
  openAtEnd: boolean;
}

/** How a binary step was compared: exact frame bytes, or the bytes it decodes to. */
type Mode = "bytes" | "decoded";

interface Replayed {
  conns: Map<string, Conn>;
  modes: { step: number; mode: Mode }[];
}

/** How long the replay waits for a frame the client owes before calling it missing. */
const PATIENCE = 400;

async function replay(file: TranscriptFile, tr: Transcript): Promise<Replayed> {
  const conns = new Map<string, Conn>();
  const modes: { step: number; mode: Mode }[] = [];

  const open = async (name: string): Promise<Conn> => {
    const existing = conns.get(name);
    if (existing) {
      if (existing.ended) throw new Error(`${tr.name}: ${name} was already closed`);
      return existing;
    }
    const socket = new RecordingSocket();
    const conn: Conn = {
      name,
      socket,
      t: undefined as unknown as Transport,
      batches: [],
      caughtUp: [],
      calls: [],
      consumed: 0,
      ended: false,
      openAtEnd: false,
    };
    conn.t = new Transport("ws://transcript", {
      onBatch: (b) => void conn.batches.push(b),
      onCaughtUp: (c) => void conn.caughtUp.push(c),
      socketFactory: () => socket,
      timeoutMs: 5000,
    });
    const connecting = conn.t.connect();
    socket.open();
    await connecting;
    conns.set(name, conn);
    return conn;
  };

  /** The next frame the client sent on `conn` that no step has claimed yet. */
  const nextSent = async (conn: Conn, where: string, owed: string) => {
    for (let i = 0; i < PATIENCE && conn.socket.sent.length <= conn.consumed; i++) await settle();
    const frame = conn.socket.sent[conn.consumed];
    if (frame === undefined) {
      // Why it never came, where a call on this connection has already said.
      const failed = conn.calls.flatMap((c) =>
        c.outcome?.ok === false ? [`${c.op} failed: ${String(c.outcome.error)}`] : [],
      );
      throw new Error(
        `${where}: the client never sent ${owed}` +
          (failed.length > 0 ? ` (${failed.join("; ")})` : ""),
      );
    }
    conn.consumed++;
    return frame;
  };

  /**
   * The bodies the transcript has this connection send before its next
   * request, by the name of the chunk each carries: what `bodyOf` answers from.
   */
  const bodiesAfter = async (at: number, conn: string): Promise<Map<string, Uint8Array>> => {
    const bodies = new Map<string, Uint8Array>();
    for (let j = at + 1; j < tr.steps.length; j++) {
      const s = tr.steps[j]!;
      if (s.conn !== conn) continue;
      if (s.send !== undefined) break;
      if (s.sendBinary !== undefined) {
        const raw = decodeFrame(fromHex(s.sendBinary), LOCAL_MAX_CHUNK_BYTES);
        bodies.set(await chunkName(raw), raw);
      }
    }
    return bodies;
  };

  /** Starts the Transport call a client frame is the first frame of. */
  const call = async (conn: Conn, frame: Frame, at: number, where: string): Promise<void> => {
    const bodies = await bodiesAfter(at, conn.name);
    const bodyOf = async (name: string): Promise<Uint8Array> => {
      const body = bodies.get(name);
      if (body === undefined)
        throw new Error(`${where}: the transcript sends no body named ${name}`);
      return body;
    };
    const f = frame as Record<string, unknown>;
    const t = conn.t;
    let promise: Promise<unknown>;
    switch (f["op"]) {
      case "hello":
        promise = t.hello({
          vault: f["vault"] as string,
          deviceId: f["deviceId"] as string,
          token: f["token"] as string,
          device: f["device"] as string,
          cursor: f["cursor"] as number,
          ...(f["epoch"] !== undefined ? { epoch: f["epoch"] as string } : {}),
        });
        break;
      case "put":
        promise = t.put(
          f["path"] as string,
          f["meta"] as unknown as PutMeta,
          f["chunks"] as string[],
          bodyOf,
          {
            ...(f["base"] !== undefined ? { base: f["base"] as number } : {}),
            ...(f["prevBase"] !== undefined ? { prevBase: f["prevBase"] as number } : {}),
          },
        );
        break;
      case "putmany":
        promise = t.putMany(
          (f["entries"] as Record<string, unknown>[]).map((e): BatchEntry => ({
            path: e["path"] as string,
            meta: e["meta"] as unknown as PutMeta,
            names: e["chunks"] as string[],
            ...(e["base"] !== undefined ? { base: e["base"] as number } : {}),
            ...(e["prevBase"] !== undefined ? { prevBase: e["prevBase"] as number } : {}),
          })),
          bodyOf,
        );
        break;
      case "fetch":
        promise = t.fetch(f["chunks"] as string[]);
        break;
      case "resend":
        promise = t.resend(f["chunks"] as string[], bodyOf);
        break;
      case "applied":
        promise = t.applied(f["applied"] as number);
        break;
      case "devices":
        promise = t.devices();
        break;
      case "ping":
        promise = t.ping();
        break;
      default:
        throw new Error(`${where}: no Transport call sends ${JSON.stringify(f["op"])}`);
    }
    const record: Call = { op: String(f["op"]) };
    conn.calls.push(record);
    promise.then(
      (value) => void (record.outcome = { ok: true, value }),
      (error: unknown) => void (record.outcome = { ok: false, error }),
    );
  };

  try {
    for (const [i, step] of tr.steps.entries()) {
      const where = `${tr.name}, step ${i + 1}`;
      if (step.store !== undefined) continue;
      if (step.conn === undefined) throw new Error(`${where}: a step with no connection`);
      const conn = await open(step.conn);

      if (step.send !== undefined) {
        await call(conn, step.send, i, where);
        const got = await nextSent(conn, where, JSON.stringify(step.send));
        if (!("text" in got)) {
          throw new Error(`${where}: the client sent a binary frame where the transcript has text`);
        }
        compareText(step.send, got.text, `${where}, ${String(step.send["op"])}`);
      } else if (step.sendBinary !== undefined) {
        const want = fromHex(step.sendBinary);
        const got = await nextSent(conn, where, `the body ${step.sendBinary}`);
        if (!("binary" in got)) {
          throw new Error(
            `${where}: the client sent ${JSON.stringify(got.text)} where a body is due`,
          );
        }
        const raw = decodeFrame(want, LOCAL_MAX_CHUNK_BYTES);
        if (sameBytes(encodeFrame(raw), want)) {
          modes.push({ step: i + 1, mode: "bytes" });
          if (!sameBytes(got.binary, want)) {
            throw new Error(
              `${where}: the client's body frame is not the transcript's, byte for byte`,
            );
          }
        } else {
          modes.push({ step: i + 1, mode: "decoded" });
          if (!sameBytes(decodeFrame(got.binary, LOCAL_MAX_CHUNK_BYTES), raw)) {
            throw new Error(
              `${where}: the client's body decodes to other bytes than the transcript's`,
            );
          }
        }
      } else if (step.expect !== undefined) {
        conn.socket.raw(substituted(step.expect, file.placeholders));
        await settle();
      } else if (step.expectBinary !== undefined) {
        // A body frame as a server sends it, raw: short bodies do not deflate
        // shorter, and a replaying server may frame either way.
        conn.socket.body(rawFrame(fromHex(step.expectBinary)));
        await settle();
      } else if (step.expectClose === true) {
        conn.socket.hangUp(1000, "closed by the server, as the transcript says");
        conn.ended = true;
      } else if (step.close === true) {
        conn.t.close();
        conn.ended = true;
      } else {
        throw new Error(`${where}: a step that does nothing`);
      }
    }

    // Nothing left over, on either side.
    for (let i = 0; i < 20; i++) await settle();
    for (const conn of conns.values()) {
      const extra = conn.socket.sent.slice(conn.consumed);
      if (extra.length > 0) {
        const first = extra[0]!;
        throw new Error(
          `${tr.name}: after the last step, ${conn.name} sent ` +
            `${"text" in first ? JSON.stringify(first.text) : `a ${first.binary.length} byte body`}` +
            `, which the transcript does not have`,
        );
      }
      for (const c of conn.calls) {
        if (c.outcome === undefined) {
          throw new Error(
            `${tr.name}: ${conn.name}'s ${c.op} never finished, so a server frame it waits for is missing`,
          );
        }
      }
      conn.openAtEnd = !conn.t.isClosed;
      if (!conn.ended && !conn.openAtEnd) {
        throw new Error(`${tr.name}: ${conn.name} closed, and nothing in the transcript closes it`);
      }
    }
    return { conns, modes };
  } finally {
    for (const conn of conns.values()) conn.t.close();
  }
}

/** The batches and catch-ups a connection was sent, as the transcript has them. */
function sentTo(file: TranscriptFile, tr: Transcript, conn: string) {
  const frames = tr.steps
    .filter((s) => s.conn === conn && s.expect !== undefined)
    .map((s) => substituted(s.expect!, file.placeholders) as Record<string, unknown>);
  return {
    batches: frames
      .filter((f) => f["op"] === "batch")
      .map((f) => ({ from: f["from"], to: f["to"], entries: f["entries"] })),
    caughtUp: frames.filter((f) => f["op"] === "caught-up").map((f) => f["cursor"]),
  };
}

/** What a call returned, or throws saying how it ended instead. */
function value(conn: Conn, i: number, op: string): unknown {
  const c = conn.calls[i];
  if (c === undefined || c.op !== op) {
    throw new Error(`${conn.name}'s call ${i} is ${c?.op ?? "missing"}, not ${op}`);
  }
  if (c.outcome === undefined) throw new Error(`${conn.name}'s ${op} never finished`);
  if (!c.outcome.ok) throw new Error(`${conn.name}'s ${op} failed: ${String(c.outcome.error)}`);
  return c.outcome.value;
}

/** How a call was refused, or throws saying it was not. */
function refusal(conn: Conn, i: number, op: string): ProtocolError {
  const c = conn.calls[i];
  if (c?.op !== op || c.outcome?.ok !== false) {
    throw new Error(`${conn.name}'s call ${i} (${c?.op}) was not a refused ${op}`);
  }
  expect(c.outcome.error).toBeInstanceOf(ProtocolError);
  return c.outcome.error as ProtocolError;
}

/** The limits a transcript's ready carries, once its placeholders are filled. */
function limits(cursor: number) {
  return {
    proto: 1,
    minProto: 1,
    serverVersion: "dev",
    epoch: "transcript-epoch",
    cursor,
    perFileMax: 64 << 20,
    chunkMax: 1 << 20,
    maxChunks: 65536,
    maxBatchBytes: 16 << 20,
    maxFetchBytes: 64 << 20,
  };
}

const text = (s: string) => new TextEncoder().encode(s);

/**
 * What the transport returns for each transcript, written out by hand from
 * plan/protocol.md rather than read back from the file: a replay that only
 * checked the client against the file would pass a file that had been changed
 * to say something else.
 */
const RESULTS: Record<string, (c: Map<string, Conn>) => void> = {
  have: (c) => {
    const laptop = c.get("laptop")!;
    expect(value(laptop, 0, "hello")).toEqual(limits(1));
    // Every body already held, so nothing went up.
    expect(value(laptop, 1, "put")).toEqual({ uid: 2, uploaded: 0, bytes: 0 });
    expect(laptop.t.appliedCursor).toBe(2);
  },
  want: (c) => {
    const laptop = c.get("laptop")!;
    const phone = c.get("phone")!;
    expect(value(laptop, 0, "hello")).toEqual(limits(0));
    expect(value(phone, 0, "hello")).toEqual(limits(0));
    // Two bodies, and the bytes counted are the two frames: ten and twelve
    // bytes of chunk, a marker each.
    expect(value(laptop, 1, "put")).toEqual({ uid: 1, uploaded: 2, bytes: 11 + 13 });
    // The other device fetches what the batch named, raw, marker taken off.
    expect(value(phone, 1, "fetch")).toEqual([text("bravo body"), text("charlie body")]);
    expect(phone.t.appliedCursor).toBe(1);
  },
  "mixed-success putmany": (c) => {
    const laptop = c.get("laptop")!;
    expect(value(laptop, 0, "hello")).toEqual(limits(1));
    const out = value(laptop, 1, "putmany") as {
      results: { uid: number; error?: ProtocolError }[];
      uploaded: number;
      bytes: number;
    };
    // Slot by slot: the new file committed; the stale write was refused at
    // the commit; the refused path, by the policy, uploaded nothing.
    expect(out.results).toHaveLength(3);
    expect(out.results[0]).toEqual({ uid: 2 });
    expect(out.results[1]!.uid).toBe(0);
    expect(out.results[1]!.error?.code).toBe("stale");
    expect(out.results[2]!.uid).toBe(0);
    expect(out.results[2]!.error?.code).toBe("badpath");
    expect(out.results[2]!.error?.message).toBe("dotprefix: the path example");
    expect(out.results[2]!.error?.fatal).toBe(true);
    expect(out.uploaded).toBe(2);
    expect(out.bytes).toBe(11 + 11);
    expect(laptop.openAtEnd, "a refused entry ended the session").toBe(true);
  },
  "stale rename source": (c) => {
    const laptop = c.get("laptop")!;
    expect(value(laptop, 0, "hello")).toEqual(limits(2));
    expect(refusal(laptop, 1, "put").code).toBe("stale");
    // And the session stays usable: the same rename on the source's head.
    expect(value(laptop, 2, "put")).toEqual({ uid: 3, uploaded: 0, bytes: 0 });
  },
  "stale rename destination": (c) => {
    const laptop = c.get("laptop")!;
    expect(value(laptop, 0, "hello")).toEqual(limits(2));
    expect(refusal(laptop, 1, "put").code).toBe("stale");
    expect(value(laptop, 2, "ping")).toBeUndefined();
  },
  "reconnect continuity": (c) => {
    const first = c.get("laptop")!;
    const again = c.get("laptop-again")!;
    const phone = c.get("phone")!;
    expect(value(first, 0, "hello")).toEqual(limits(2));
    expect(first.t.appliedCursor).toBe(2);
    expect(value(again, 0, "hello")).toEqual(limits(3));
    expect(value(phone, 0, "hello")).toEqual(limits(3));
    expect(value(phone, 1, "put")).toEqual({ uid: 4, uploaded: 1, bytes: 11 });
    // The reconnected device was sent what it missed and then the other
    // device's write live, each range continuing the one before.
    expect(again.batches.map((b) => [b.from, b.to])).toEqual([
      [3, 3],
      [4, 4],
    ]);
    expect(again.t.appliedCursor).toBe(4);
  },
  "resend repair": (c) => {
    const laptop = c.get("laptop")!;
    expect(value(laptop, 0, "hello")).toEqual(limits(1));
    // No entry and no uid: what was stored and what is still missing.
    expect(value(laptop, 1, "resend")).toEqual({ stored: 1, missing: 0, bytes: 11 });
    expect(value(laptop, 2, "fetch")).toEqual([text("alpha body")]);
  },
  "applied receipts": (c) => {
    const laptop = c.get("laptop")!;
    expect(value(laptop, 0, "hello")).toEqual(limits(2));
    expect(value(laptop, 1, "applied")).toBeUndefined();
    expect(value(laptop, 2, "devices")).toEqual({
      devices: [
        {
          id: "laptop",
          name: "laptop",
          createdAt: 1,
          lastSeen: 1790000000000,
          online: true,
          applied: 2,
        },
        { id: "phone", name: "phone", createdAt: 2, lastSeen: 0, online: false, applied: null },
      ],
      invites: [],
    });
    // A checkpoint ahead of the server is refused, and the session goes on.
    expect(refusal(laptop, 3, "applied").code).toBe("badentry");
    expect(value(laptop, 4, "ping")).toBeUndefined();
    expect(laptop.openAtEnd, "a refused checkpoint ended the session").toBe(true);
  },
};

/** Every transcript, replayed, with its batches and results held to the file and the table. */
async function replayAll(file: TranscriptFile): Promise<Map<string, Replayed>> {
  const all = new Map<string, Replayed>();
  for (const tr of file.transcripts) {
    const done = await replay(file, tr);
    for (const [name, conn] of done.conns) {
      const want = sentTo(file, tr, name);
      expect(
        conn.batches.map((b) => ({ from: b.from, to: b.to, entries: b.entries })),
        `${tr.name}: the batches ${name} was handed`,
      ).toEqual(want.batches);
      expect(conn.caughtUp, `${tr.name}: where ${name} was told it caught up`).toEqual(
        want.caughtUp,
      );
    }
    const results = RESULTS[tr.name];
    if (results === undefined) throw new Error(`no results are written down for ${tr.name}`);
    results(done.conns);
    all.set(tr.name, done);
  }
  return all;
}

/* ---------------------------------------------------------------- *
 * The tests
 * ---------------------------------------------------------------- */

describe("the protocol transcripts, played to the real transport", () => {
  it("is the file the replayer reads, with the transcripts the server replays", () => {
    const file = load();
    expect(file.format).toBe(1);
    expect(file.transcripts.map((t) => t.name).sort()).toEqual(
      [
        "have",
        "want",
        "mixed-success putmany",
        "stale rename source",
        "stale rename destination",
        "reconnect continuity",
        "resend repair",
        "applied receipts",
      ].sort(),
    );
  });

  it("sends exactly the client side of every transcript, and returns what it says", async () => {
    const all = await replayAll(load());
    expect([...all.keys()]).toHaveLength(8);
  });

  /**
   * Which comparison each binary step got, pinned so a change to the file or
   * to `encodeFrame` is read rather than absorbed. Every body in the file is
   * a short raw frame, which is what this client makes of a short chunk, so
   * every one is compared byte for byte.
   */
  it("compares each body the client sends byte for byte, where the frame is the client's", async () => {
    const all = await replayAll(load());
    const modes = [...all].flatMap(([name, r]) =>
      r.modes.map((m) => `${name} step ${m.step}: ${m.mode}`),
    );
    expect(modes).toEqual([
      "want step 9: bytes",
      "want step 10: bytes",
      "mixed-success putmany step 7: bytes",
      "mixed-success putmany step 8: bytes",
      "reconnect continuity step 18: bytes",
      "resend repair step 8: bytes",
    ]);
  });

  it("compares by decoded bytes where the transcript frames a body another way", async () => {
    // The same chunk, deflated, which this client would not send for bytes
    // this short: the frame differs and the chunk it carries does not.
    const file = load();
    const want = file.transcripts.find((t) => t.name === "want")!;
    const step = want.steps.find((s) => s.sendBinary !== undefined)!;
    const raw = decodeFrame(fromHex(step.sendBinary!), LOCAL_MAX_CHUNK_BYTES);
    const deflated = new Uint8Array([MARKER_DEFLATE, ...deflateSync(raw)]);
    step.sendBinary = Buffer.from(deflated).toString("hex");
    const done = await replay(file, want);
    expect(done.modes[0]).toEqual({ step: 9, mode: "decoded" });
  });
});

/**
 * A replayer that passes whatever it is given proves nothing, so the file,
 * damaged one way at a time, must fail to replay, each for its own reason.
 */
describe("a damaged transcript", () => {
  const damaged: {
    what: string;
    damage: (f: TranscriptFile) => void;
    because: RegExp;
  }[] = [
    {
      what: "a field changed in an expected client frame",
      damage: (f) => {
        const put = step(f, "have", (s) => s.send?.["op"] === "put");
        put.send!["id"] = 3;
      },
      because: /have, step 6, put\.id: the transcript has 3, the client sent 2/,
    },
    {
      what: "a key the client does not send, added to its frame",
      damage: (f) => {
        const hello = step(f, "have", (s) => s.send?.["op"] === "hello");
        hello.send!["crypto"] = "basalt/hkdf-aes-gcm/1";
      },
      because: /the transcript has "crypto", which the client did not send/,
    },
    {
      what: "a key the client sends, taken out of its frame",
      damage: (f) => {
        const put = step(f, "want", (s) => s.send?.["op"] === "put");
        delete put.send!["base"];
      },
      because: /the client sent "base", which the transcript does not have/,
    },
    {
      // The devices reply then answers nothing in flight, which ends the
      // session, and the request after it is never sent.
      what: "a request the client makes, left out",
      damage: (f) => {
        const tr = f.transcripts.find((t) => t.name === "applied receipts")!;
        tr.steps = tr.steps.filter((s) => s.send?.["op"] !== "devices");
      },
      because: /applied receipts, step 10: the client never sent \{"op":"applied","id":4/,
    },
    {
      what: "a body the client sends, left out",
      damage: (f) => {
        const tr = f.transcripts.find((t) => t.name === "resend repair")!;
        tr.steps = tr.steps.filter((s) => s.sendBinary === undefined);
      },
      because: /resend failed: .*the transcript sends no body named/,
    },
    {
      what: "a server frame left out",
      damage: (f) => {
        const tr = f.transcripts.find((t) => t.name === "want")!;
        tr.steps = tr.steps.filter((s) => s.expect?.["res"] !== "ack");
      },
      because: /laptop's put never finished/,
    },
    {
      what: "a uid the server gives, changed",
      damage: (f) => {
        const have = step(f, "have", (s) => s.expect?.["res"] === "have");
        have.expect!["uid"] = 99;
      },
      because: /expected \{ uid: 99/,
    },
    {
      // Refused as a gap, so the device is handed nothing of it.
      what: "a batch's range changed, so it no longer continues the cursor",
      damage: (f) => {
        const batch = step(f, "reconnect continuity", (s) => s.expect?.["op"] === "batch");
        batch.expect!["from"] = 2;
      },
      because: /reconnect continuity: the batches laptop was handed/,
    },
    {
      what: "a body the client sends, changed",
      damage: (f) => {
        const body = step(f, "mixed-success putmany", (s) => s.sendBinary !== undefined);
        body.sendBinary = Buffer.from(new Uint8Array([0, ...text("not the body")])).toString("hex");
      },
      because: /putmany failed: .*the transcript sends no body named/,
    },
  ];

  /** The first step of a transcript that `which` picks. */
  function step(f: TranscriptFile, name: string, which: (s: Step) => boolean): Step {
    const tr = f.transcripts.find((t) => t.name === name);
    const found = tr?.steps.find(which);
    if (found === undefined) throw new Error(`${name} has no such step to damage`);
    return found;
  }

  it.each(damaged)("fails to replay with $what", async ({ damage, because }) => {
    const file = load();
    damage(file);
    await expect(replayAll(file)).rejects.toThrow(because);
  });

  it("replays clean when it is not damaged, so each failure above is the damage", async () => {
    await expect(replayAll(load())).resolves.toBeDefined();
  });
});
