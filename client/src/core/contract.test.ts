/**
 * The protocol 1 contract, checked from the TypeScript side (PLAN.md M0.5).
 *
 * `protocol-fixtures.json` is the contract. Its invite, frame, fold, path,
 * collision and format sections are written by `scripts/protocol-vectors.py`,
 * a reference that is neither this client nor the server, and `internal/paths`,
 * `internal/frame` and `internal/invite` check the same vectors in Go. Each
 * implementation consuming vectors it did not produce is the point: passing
 * your own tests proves nothing.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { base64urlDecode } from "./digest.ts";
import { fold, foldTable } from "./fold.ts";
import { FOLD_TABLE_DIGEST, FOLD_TABLE_UNICODE_VERSION } from "./fold-table.ts";
import { FrameError, MARKER_DEFLATE, MARKER_RAW, decodeFrame, encodeFrame } from "./frame.ts";
import {
  INVITE_PREFIX,
  INVITE_TOKEN_BYTES,
  MAX_VAULT_NAME_BYTES,
  formatInviteString,
  parseInviteString,
} from "./invite-string.ts";
import {
  CHUNKING_TEXT_EXTENSIONS,
  MAX_PATH_BYTES,
  MAX_SEGMENT_BYTES,
  STAGING_MARK,
  chunkingText,
  collides,
  mcpEditable,
  mcpReadable,
  pathReason,
  searchable,
  syncable,
  type PathOp,
} from "./path-policy.ts";

interface Contract {
  constants: {
    invitePrefix: string;
    stagingMark: string;
    inviteTokenBytes: number;
    maxPathBytes: number;
    maxSegmentBytes: number;
    maxNameBytes: number;
    chunkMax: number;
  };
  invite: {
    good: { string: string; token: string; url: string; vault: string }[];
    bad: { why: string; string: string }[];
  };
  frames: {
    chunkMax: number;
    good: { why: string; frame: string; raw: string; name: string }[];
    generated: {
      why: string;
      marker: number;
      valid: boolean;
      name: string;
      gen: { kind: string; seed?: string; length: number };
    }[];
    bad: { why: string; frame: string }[];
  };
  fold: {
    unicodeVersion: string;
    tableDigest: string;
    tableSize: number;
    vectors: { input: string; fold: string }[];
  };
  paths: { cases: { name: string; hex: string; valid: boolean; reason: string | null }[] };
  collisions: {
    scenarios: {
      name: string;
      live: { path: string; folder?: boolean }[];
      op: { type: "create" | "move"; path: string; prev?: string; folder?: boolean };
      // `stale` is a refusal of its own, not a collision: the server's verdict
      // on a write that turns a live folder into a file while notes live in it.
      expect: "ok" | "collision" | "stale";
    }[];
  };
  formats: {
    textExtensions: string[];
    samples: {
      path: string;
      syncable: boolean;
      chunkingText: boolean;
      searchable: boolean;
      mcpReadable: boolean;
      mcpEditable: boolean;
    }[];
  };
}

const contract = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol-fixtures.json"), "utf8"),
) as Contract;

const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The fixture's generator: SHA-256(seed || counter) for counter 0, 1, 2 ..., big-endian. */
function sha256Ctr(seed: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; at < length; i++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    const block = createHash("sha256").update(Buffer.from(seed, "utf8")).update(counter).digest();
    out.set(block.subarray(0, Math.min(block.length, length - at)), at);
    at += block.length;
  }
  return out;
}

function tableDigest(table: ReadonlyMap<number, string>): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const lines = [...table.keys()]
    .sort((a, b) => a - b)
    .map(
      (cp) => `${hex(cp)}:${[...table.get(cp)!].map((c) => hex(c.codePointAt(0)!)).join(" ")}\n`,
    );
  return createHash("sha256").update(lines.join(""), "ascii").digest("hex");
}

/** A path case's bytes as the string this client would hold, or "utf8" when it cannot. */
function verdict(hex: string): string | undefined {
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(unhex(hex));
  } catch {
    return "utf8";
  }
  return pathReason(path);
}

function op(s: Contract["collisions"]["scenarios"][number]["op"]): PathOp {
  const folder = s.folder === true ? { folder: true } : {};
  return s.type === "move"
    ? { type: "move", prev: s.prev!, path: s.path, ...folder }
    : { type: "create", path: s.path, ...folder };
}

describe("the protocol 1 contract", () => {
  it("is a contract and not an empty file", () => {
    expect(contract.paths.cases.length).toBeGreaterThanOrEqual(20);
    expect(contract.collisions.scenarios.length).toBeGreaterThanOrEqual(15);
    expect(contract.invite.bad.length).toBeGreaterThanOrEqual(15);
    expect(contract.frames.bad.length).toBeGreaterThanOrEqual(6);
  });

  it("holds the constants the contract names", () => {
    expect(INVITE_PREFIX).toBe(contract.constants.invitePrefix);
    expect(STAGING_MARK).toBe(contract.constants.stagingMark);
    expect(INVITE_TOKEN_BYTES).toBe(contract.constants.inviteTokenBytes);
    expect(MAX_PATH_BYTES).toBe(contract.constants.maxPathBytes);
    expect(MAX_SEGMENT_BYTES).toBe(contract.constants.maxSegmentBytes);
    expect(MAX_VAULT_NAME_BYTES).toBe(contract.constants.maxNameBytes);
    expect(contract.frames.chunkMax).toBe(contract.constants.chunkMax);
  });

  describe("the fold", () => {
    it("carries the table the contract pins, by digest", () => {
      const table = foldTable();
      expect(table.size).toBe(contract.fold.tableSize);
      expect(tableDigest(table)).toBe(contract.fold.tableDigest);
      expect(FOLD_TABLE_DIGEST).toBe(contract.fold.tableDigest);
      expect(FOLD_TABLE_UNICODE_VERSION).toBe(contract.fold.unicodeVersion);
    });

    it("folds every vector as the reference does", () => {
      for (const v of contract.fold.vectors)
        expect(fold(v.input), JSON.stringify(v.input)).toBe(v.fold);
    });
  });

  it("gives every path the reference's verdict and reason", () => {
    for (const c of contract.paths.cases) {
      expect(c.valid).toBe(c.reason === null);
      expect(verdict(c.hex), c.name).toBe(c.reason ?? undefined);
    }
  });

  it("gives every collision scenario the reference's verdict", () => {
    for (const s of contract.collisions.scenarios) {
      expect(collides(s.live, op(s.op)), s.name).toBe(s.expect === "collision");
    }
  });

  it("keeps the five format policies the reference keeps", () => {
    expect([...CHUNKING_TEXT_EXTENSIONS]).toEqual(contract.formats.textExtensions);
    for (const s of contract.formats.samples) {
      expect(syncable(s.path), `syncable ${s.path}`).toBe(s.syncable);
      expect(chunkingText(s.path), `chunkingText ${s.path}`).toBe(s.chunkingText);
      expect(searchable(s.path), `searchable ${s.path}`).toBe(s.searchable);
      expect(mcpReadable(s.path), `mcpReadable ${s.path}`).toBe(s.mcpReadable);
      expect(mcpEditable(s.path), `mcpEditable ${s.path}`).toBe(s.mcpEditable);
    }
  });

  describe("invites", () => {
    it("parses every good invite to its fields", () => {
      for (const g of contract.invite.good) {
        const inv = parseInviteString(g.string);
        expect(Buffer.from(inv.token).equals(Buffer.from(base64urlDecode(g.token)))).toBe(true);
        expect(inv.url).toBe(g.url);
        expect(inv.vault).toBe(g.vault);
      }
    });

    it("formats the reference's exact string", () => {
      for (const g of contract.invite.good) {
        const s = formatInviteString({
          token: base64urlDecode(g.token),
          url: g.url,
          vault: g.vault,
        });
        expect(s).toBe(g.string.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""));
      }
    });

    it("refuses every bad invite", () => {
      for (const b of contract.invite.bad)
        expect(() => parseInviteString(b.string), b.why).toThrow();
    });
  });

  describe("frames", () => {
    it("decodes every good frame to its chunk", () => {
      for (const g of contract.frames.good) {
        const raw = decodeFrame(unhex(g.frame), contract.frames.chunkMax);
        expect(sha256(raw), g.why).toBe(g.name);
        expect(Buffer.from(raw).equals(Buffer.from(unhex(g.raw))), g.why).toBe(true);
      }
    });

    it("refuses every bad frame", () => {
      for (const b of contract.frames.bad) {
        expect(() => decodeFrame(unhex(b.frame), contract.frames.chunkMax), b.why).toThrow(
          FrameError,
        );
      }
    });

    it("holds the chunk limit at its boundary, on both sides of it", () => {
      for (const g of contract.frames.generated) {
        const raw =
          g.gen.kind === "sha256-ctr"
            ? sha256Ctr(g.gen.seed!, g.gen.length)
            : new Uint8Array(g.gen.length);
        expect(sha256(raw), `${g.why}: the generator reproduces the reference bytes`).toBe(g.name);
        let framed: Uint8Array;
        if (g.marker === MARKER_DEFLATE) {
          framed = encodeFrame(raw);
          expect(framed[0], `${g.why}: bytes that compress are deflated`).toBe(MARKER_DEFLATE);
        } else {
          framed = new Uint8Array(1 + raw.length);
          framed[0] = MARKER_RAW;
          framed.set(raw, 1);
        }
        if (g.valid) {
          expect(sha256(decodeFrame(framed, contract.frames.chunkMax)), g.why).toBe(g.name);
        } else {
          let kind: string | undefined;
          try {
            decodeFrame(framed, contract.frames.chunkMax);
          } catch (err) {
            kind = err instanceof FrameError ? err.kind : "other";
          }
          expect(kind, g.why).toBe("toolarge");
        }
      }
    });

    it("never frames a chunk longer than one byte over its raw length", () => {
      for (const raw of [
        new TextEncoder().encode("a"),
        new TextEncoder().encode("compressible ".repeat(400)),
        sha256Ctr("incompressible", 64 * 1024),
        Uint8Array.of(0),
        Uint8Array.of(1, 0),
      ]) {
        const framed = encodeFrame(raw);
        expect(framed.length).toBeLessThanOrEqual(raw.length + 1);
        expect(Buffer.from(decodeFrame(framed, 1 << 20)).equals(Buffer.from(raw))).toBe(true);
      }
    });
  });

  // PLAN.md M0.5: a deliberately corrupted vector must fail on the consuming
  // side. If a wrong expectation could pass, the checks above would pass
  // whatever the fixture said.
  it("catches a corrupted vector in every section", () => {
    const p = contract.paths.cases.at(-1)!;
    expect(verdict(p.hex)).not.toBe(p.reason === "empty" ? "utf8" : "empty");

    const s = contract.collisions.scenarios[0]!;
    expect(collides(s.live, op(s.op))).not.toBe(s.expect !== "collision");

    const v = contract.fold.vectors[0]!;
    expect(fold(v.input)).not.toBe(v.fold + "x");
    expect(tableDigest(new Map([[0x41, "b"]]))).not.toBe(contract.fold.tableDigest);

    const g = contract.invite.good[0]!;
    const at = INVITE_PREFIX.length + 5;
    const damaged =
      g.string.slice(0, at) + (g.string[at] === "A" ? "B" : "A") + g.string.slice(at + 1);
    expect(() => parseInviteString(damaged)).toThrow();

    const f = contract.frames.good[0]!;
    const frame = unhex(f.frame);
    frame[frame.length - 1]! ^= 0xff;
    expect(sha256(decodeFrame(frame, contract.frames.chunkMax))).not.toBe(f.name);
  });
});
