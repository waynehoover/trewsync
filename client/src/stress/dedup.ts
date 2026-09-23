/**
 * What deduplication is actually for.
 *
 * Two different questions get the same name. Across *files*, does one note
 * share chunks with another? Across *versions*, does today's note share chunks
 * with yesterday's? The first is what "dedup" sounds like and the second is
 * what pays for the machinery. `scale.ts` answers the first over ten thousand
 * notes; this answers the second.
 *
 * What it measures, under protocol 1. A chunk's name is the SHA-256 of its raw
 * bytes (`chunkName` in digest.ts), so two chunks are stored once exactly when
 * their bytes are identical, whichever file, version or device they came from:
 * deduplication is over raw bytes and nothing else. The server keeps one copy
 * of each distinct name per vault, as raw bytes, and a device uploads only the
 * names the server says it wants, each as a body frame (`encodeFrame`: a marker
 * byte, then deflate when that is shorter). So for twenty versions of one note
 * this counts the chunk references the versions make, the distinct names the
 * server holds for them, the raw bytes those names are, and the frame bytes it
 * cost to upload them, against storing every version whole.
 *
 * Checked as well as counted. The distinct names are held against the distinct
 * byte strings, and a disagreement stops the run, because a name that was not a
 * function of the bytes alone would make every number below a measurement of
 * something else (rule 8).
 *
 * Run: `bun run src/stress/dedup.ts`.
 */
import { chunkBytes, sizesFor } from "../core/chunk.ts";
import { chunkNames } from "../core/digest.ts";
import { encodeFrame } from "../core/frame.ts";

const enc = new TextEncoder();

interface Named {
  readonly name: string;
  readonly raw: Uint8Array;
}

/** A note's chunks as the engine cuts and names them for a put. */
async function chunksOf(text: string): Promise<Named[]> {
  const bytes = enc.encode(text);
  const parts = [...chunkBytes(bytes, sizesFor(bytes.length, true), true)].map((c) => c.bytes);
  const names = await chunkNames(parts);
  return parts.map((raw, i) => ({ name: names[i]!, raw }));
}

function prose(seed: number, paras: number): string {
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff);
  const w = [
    "meeting",
    "design",
    "protocol",
    "because",
    "however",
    "chunk",
    "server",
    "vault",
    "content",
    "decision",
    "measure",
    "boundary",
    "identity",
    "release",
    "review",
  ];
  let out = "";
  for (let p = 0; p < paras; p++) {
    for (let l = 0; l < 4; l++) {
      const parts = [];
      for (let i = 0; i < 12; i++) parts.push(w[rnd() % w.length]);
      out += parts.join(" ") + ".\n";
    }
    out += "\n";
  }
  return out;
}

const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;

for (const [label, paras] of [
  ["a short note (2 KB)", 4],
  ["a long note (40 KB)", 90],
] as const) {
  // Somebody's week: append a paragraph a day, twenty times.
  let text = prose(1, paras);
  let references = 0;
  let wholeBytes = 0;
  let lastBytes = 0;
  const stored = new Map<string, Uint8Array>();
  const distinctBytes = new Set<string>();
  let versions = 0;
  for (let day = 0; day < 20; day++) {
    const chunks = await chunksOf(text);
    versions++;
    lastBytes = enc.encode(text).length;
    wholeBytes += lastBytes;
    for (const c of chunks) {
      references++;
      stored.set(c.name, c.raw);
      distinctBytes.add(Buffer.from(c.raw).toString("base64"));
    }
    text += prose(1000 + day, 1) + "\n";
  }
  if (stored.size !== distinctBytes.size) {
    throw new Error(
      `${label}: ${stored.size} distinct names for ${distinctBytes.size} distinct byte strings, ` +
        "so a chunk's name is not a function of its bytes alone and nothing here measures dedup",
    );
  }
  let storedBytes = 0;
  let framedBytes = 0;
  for (const raw of stored.values()) {
    storedBytes += raw.length;
    framedBytes += encodeFrame(raw).length;
  }
  console.log(`\n${label}, ${versions} versions, ending at ${kib(lastBytes)}`);
  console.log(`  chunk references over all versions  ${references}`);
  console.log(`  distinct chunks actually stored     ${stored.size}`);
  console.log(
    `  stored / referenced                 ${((100 * stored.size) / references).toFixed(0)}%  -> dedup across versions saves ${(100 * (1 - stored.size / references)).toFixed(0)}%`,
  );
  console.log(
    `  raw bytes held for all versions     ${kib(storedBytes)}, against ${kib(wholeBytes)} for every version whole`,
  );
  console.log(
    `  frames uploaded for them            ${kib(framedBytes)}  (${((100 * framedBytes) / storedBytes).toFixed(0)}% of the raw bytes, deflated where shorter)`,
  );
}
