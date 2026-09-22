/**
 * The entry shape, checked here against the same fixtures Go checks (I03).
 *
 * `protocol-fixtures.json` at the repository root is the contract. Every case
 * in it is fed to `checkEntryShape` here and to `store.Entry.Validate` in
 * `internal/store`, and the two have to agree: a valid case is accepted
 * by both, an invalid one refused by both. Adding a rule to one language
 * without the other fails on one side or the other, which is the whole reason
 * the file exists.
 *
 * The client is the side that matters most for the invalid cases. A server is
 * not obliged to be honest, so every shape it refuses to store is a shape a
 * hostile one can still send.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkEntryShape } from "./engine.ts";
import { LOCAL_MAX_BATCH_BYTES, LOCAL_MAX_FETCH_BYTES } from "./transport.ts";
import type { WireEntry } from "./transport.ts";

interface Fixture {
  goodMac: string;
  goodChunk: string;
  ceilings: { maxBatchBytes: number; maxFetchBytes: number };
  cases: { name: string; valid: boolean; why?: string; entry: Record<string, unknown> }[];
}

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol-fixtures.json"), "utf8"),
) as Fixture;

/** `$mac` and `$chunk` stand in for real digests, so the file stays readable. */
function resolve(entry: Record<string, unknown>): WireEntry {
  const swap = (v: unknown): unknown =>
    v === "$mac" ? fixtures.goodMac : v === "$chunk" ? fixtures.goodChunk : v;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    out[k] = Array.isArray(v) ? v.map(swap) : swap(v);
  }
  return out as unknown as WireEntry;
}

describe("the entry shape both languages enforce", () => {
  it("has fixtures to check, and both kinds of them", () => {
    expect(fixtures.cases.length).toBeGreaterThan(10);
    expect(fixtures.cases.some((c) => c.valid)).toBe(true);
    expect(fixtures.cases.some((c) => !c.valid)).toBe(true);
  });

  for (const c of fixtures.cases) {
    it(`${c.valid ? "accepts" : "refuses"}: ${c.name}`, () => {
      const entry = resolve(c.entry);
      if (c.valid) {
        expect(() => checkEntryShape(entry)).not.toThrow();
      } else {
        expect(
          () => checkEntryShape(entry),
          `the server refuses this and the client does not: ${c.why ?? ""}`,
        ).toThrow();
      }
    });
  }
});

/**
 * The other thing both languages write down separately (R26).
 *
 * The client caps what a handshake may raise its own memory limits to, and it
 * needs those numbers before the handshake has told it anything, so it cannot
 * read them off the wire. Two copies of a constant drift, and this pair drifts
 * into a client that ends the connection over a batch the server was entitled
 * to send: an outage that neither side reports as a version mismatch.
 */
describe("the ceilings both languages hard-code", () => {
  it("match the fixtures the server also reads", () => {
    expect(fixtures.ceilings.maxBatchBytes).toBe(LOCAL_MAX_BATCH_BYTES);
    expect(fixtures.ceilings.maxFetchBytes).toBe(LOCAL_MAX_FETCH_BYTES);
  });
});
