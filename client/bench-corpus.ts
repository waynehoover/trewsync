/**
 * The corpus every benchmark measures against.
 *
 * Pulled out of `bench-pass.ts` so the Android runs and the desktop runs are
 * the same files byte for byte. A phone number and a laptop number describing
 * different notes are two numbers, not a comparison, and the whole point of
 * measuring on the phone is to hold one against the other.
 *
 * Deterministic and dependency-free on purpose: `i` alone decides a note's
 * path and its contents, so a corpus can be rebuilt anywhere, or generated
 * once on a laptop and generated again on a phone, and the two agree without
 * anything being copied.
 */

import { join } from "node:path";

/**
 * Notes that look like notes. Length varies, because a vault of identical
 * files would let anything that caches by content look better than it is.
 */
export function noteBody(i: number): string {
  const lines = 8 + (i % 23);
  const out: string[] = [`# Note ${i}`, ""];
  for (let n = 0; n < lines; n++) {
    out.push(`Paragraph ${n} of note ${i}, with enough words in it to be a sentence.`);
  }
  return out.join("\n") + "\n";
}

/**
 * Several folders deep and spread across them, because a flat directory is the
 * one shape a real vault never is, and folder entries are their own work.
 */
export function pathFor(i: number): string {
  return join(`area-${i % 11}`, `topic-${i % 7}`, `note-${String(i).padStart(5, "0")}.md`);
}

/** Every path in a corpus of `count` notes, in the order they are made. */
export function corpusPaths(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(pathFor(i));
  return out;
}

/** Total plaintext bytes, without building any of it. */
export function corpusBytes(count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += Buffer.byteLength(noteBody(i));
  return total;
}
