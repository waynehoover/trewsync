/**
 * The case fold of protocol 1: which two paths a case-folding disk holds as
 * one file (plan/protocol.md, "Paths").
 *
 * NFC, then Unicode full case folding code point by code point, then NFC
 * again. The table is generated (`fold-table.ts`, from
 * `scripts/protocol-vectors.py`) rather than taken from `toLowerCase`, because
 * the Go server has to fold identically and Go and JavaScript do not lower-case
 * alike: U+0130 is the famous case. Both sides carry the same table and prove
 * it by digest against `protocol-fixtures.json`.
 */

import { FOLD_TABLE_PACKED } from "./fold-table.ts";

let table: Map<number, string> | undefined;

/** The fold table, unpacked once, on first use. */
export function foldTable(): ReadonlyMap<number, string> {
  if (table !== undefined) return table;
  const out = new Map<number, string>();
  for (const entry of FOLD_TABLE_PACKED.split(",")) {
    const [source, ...target] = entry.split(" ").map((hex) => Number.parseInt(hex, 16));
    if (source === undefined || target.length === 0) {
      throw new Error(`the fold table has a malformed entry: ${JSON.stringify(entry)}`);
    }
    out.set(source, String.fromCodePoint(...target));
  }
  table = out;
  return out;
}

/** The key two paths share when a case-folding disk would hold them as one. */
export function fold(s: string): string {
  const t = foldTable();
  let out = "";
  for (const ch of s.normalize("NFC")) out += t.get(ch.codePointAt(0)!) ?? ch;
  return out.normalize("NFC");
}
