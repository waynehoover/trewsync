/**
 * What a 10,000 note vault costs, and where the cost sits.
 *
 * Not a speed benchmark. The question is whether the chunking and dedup design
 * still makes sense at that size: how much of the upload is chunk names rather
 * than content, how much deduplication actually saves on distinct prose, and
 * what the local index grows to.
 *
 * What it measures, under protocol 1, before any server is involved: the notes
 * chunked as the engine chunks them, and each chunk named by the SHA-256 of its
 * raw bytes (`chunkNames`), so the distinct names are exactly the distinct byte
 * strings and deduplication is over raw bytes, across every file in the vault.
 * The bodies are counted as the frames the transport sends (`encodeFrame`: one
 * marker byte, then deflate where that is shorter), once per distinct name,
 * because a name the server already holds is never sent again. The metadata is
 * each note's put entry as the transport encodes it (`encodedEntryBytes`, with
 * the plaintext path, the meta and every chunk name), measured rather than
 * estimated from a per-entry constant. Then a real server: the first sync, an
 * idle pass, the index and database sizes, and a day's editing.
 *
 * Run: `bun run scale`, or `NOTES=2000 bun run scale` for a smaller vault.
 */
import { mkdtemp, mkdir, readdir, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "../core/client.ts";
import { chunkNames } from "../core/digest.ts";
import { encodeFrame } from "../core/frame.ts";
import { chunkBytes, sizesFor } from "../core/chunk.ts";
import { encodedEntryBytes } from "../core/transport.ts";
import { removeTree, TestServer } from "../core/test-server.ts";
import { JsonIndexStore, NodeVault } from "../node/vault.ts";

const COUNT = Number(process.env["NOTES"] ?? 10000);
const enc = new TextEncoder();

/** Distinct prose. A generator that repeats itself measures the generator. */
function note(i: number): string {
  let seed = i * 2654435761;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
  const words = [
    "meeting",
    "design",
    "protocol",
    "because",
    "however",
    "perhaps",
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
    "January",
    "refactor",
    "interface",
    "threshold",
    "migration",
    "observed",
    "argument",
  ];
  let out = `# Note ${i}\n\n`;
  const paras = 2 + (rnd() % 6);
  for (let p = 0; p < paras; p++) {
    const lines = 2 + (rnd() % 5);
    for (let l = 0; l < lines; l++) {
      const n = 8 + (rnd() % 12);
      const parts: string[] = [];
      for (let w = 0; w < n; w++)
        parts.push(words[rnd() % words.length]! + (rnd() % 7 === 0 ? `-${rnd() % 9999}` : ""));
      out += parts.join(" ") + ".\n";
    }
    out += "\n";
  }
  return out;
}

/**
 * The server's data directory in two parts: the database with its write-ahead
 * log, and everything else, which is the chunk store. The log is counted with
 * the database because in WAL mode the rows are there until a checkpoint, and
 * `trew.db` on its own read as nothing at all after a first sync.
 */
async function serverBytes(dataDir: string): Promise<{ database: number; rest: number }> {
  let database = 0;
  let rest = 0;
  const walk = async (at: string): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true })) {
      const full = join(at, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) {
        const size = (await stat(full)).size;
        if (at === dataDir && (item.name === "trew.db" || item.name === "trew.db-wal")) {
          database += size;
        } else rest += size;
      }
    }
  };
  await walk(dataDir);
  return { database, rest };
}

const dir = await mkdtemp(join(tmpdir(), "trew-scale-"));
const server = new TestServer();
let client: Client | undefined;
try {
  let plaintext = 0;
  for (let i = 1; i <= COUNT; i++) {
    const path = join(dir, `folder${i % 40}`, `note-${i}.md`);
    await mkdir(dirname(path), { recursive: true });
    const body = note(i);
    plaintext += Buffer.byteLength(body);
    await writeFile(path, body);
  }
  console.log(`${COUNT} notes, ${(plaintext / 1048576).toFixed(1)} MiB of prose`);

  // What chunking produces, before any server is involved.
  let chunks = 0;
  const distinct = new Map<string, Uint8Array>();
  let metadata = 0;
  const now = Date.now();
  for (let i = 1; i <= COUNT; i++) {
    const bytes = enc.encode(note(i));
    const parts = [...chunkBytes(bytes, sizesFor(bytes.length, true), true)].map((c) => c.bytes);
    chunks += parts.length;
    const names = await chunkNames(parts);
    names.forEach((name, at) => distinct.set(name, parts[at]!));
    // The entry the first sync puts for this note: a create, so base 0.
    metadata += encodedEntryBytes({
      path: `folder${i % 40}/note-${i}.md`,
      meta: { size: bytes.length, ctime: now, mtime: now },
      names,
      base: 0,
    });
  }
  let framedBytes = 0;
  for (const raw of distinct.values()) framedBytes += encodeFrame(raw).length;
  console.log(
    `  chunks           ${chunks} (${(chunks / COUNT).toFixed(2)} per note, avg ${(plaintext / chunks / 1024).toFixed(1)} KiB)`,
  );
  console.log(
    `  unique chunks    ${distinct.size}  -> dedup saves ${(100 * (1 - distinct.size / chunks)).toFixed(2)}%`,
  );
  console.log(
    `  framed bodies    ${(framedBytes / 1048576).toFixed(1)} MiB  (${((100 * framedBytes) / plaintext).toFixed(0)}% of the prose, one frame per unique chunk)`,
  );
  console.log(
    `  entry metadata   ${(metadata / 1048576).toFixed(1)} MiB  (${((100 * metadata) / (metadata + framedBytes)).toFixed(1)}% of the upload)`,
  );

  await server.start();
  client = new Client({
    vault: new NodeVault(dir),
    store: new JsonIndexStore(join(dir, ".trew", "index.json")),
    url: server.wsUrl,
    ...(await server.deviceCredentials("scale")),
    vaultId: "default",
    device: "scale",
    timeoutMs: 600_000,
    coalesceWrites: false,
  });
  await client.connect();
  const t0 = performance.now();
  const up = await client.settle({}, 200);
  const upMs = performance.now() - t0;
  console.log(
    `\nfirst sync         ${(upMs / 1000).toFixed(1)} s, ${up.uploaded} uploaded, ${up.chunksSent} chunks, ${(up.bytesSent / 1048576).toFixed(1)} MiB of frames sent`,
  );

  const t1 = performance.now();
  await client.settle({}, 2);
  console.log(`idle pass          ${(performance.now() - t1).toFixed(0)} ms`);
  console.log(
    `local index        ${((await stat(join(dir, ".trew", "index.json"))).size / 1048576).toFixed(1)} MiB`,
  );
  const held = await serverBytes(server.dataDir);
  console.log(
    `server database    ${(held.database / 1048576).toFixed(1)} MiB  (trew.db and its write-ahead log)`,
  );
  console.log(
    `server chunks      ${(held.rest / 1048576).toFixed(1)} MiB  (the rest of the data directory)`,
  );

  // A day's editing.
  for (let i = 1; i <= 20; i++) {
    const n = (i * 37) % COUNT || 1;
    const path = join(dir, `folder${n % 40}`, `note-${n}.md`);
    await writeFile(path, (await readFile(path, "utf8")) + "\na line added today.\n");
  }
  const t2 = performance.now();
  const day = await client.settle({}, 8);
  console.log(
    `20 notes edited    ${((performance.now() - t2) / 1000).toFixed(2)} s, ${day.uploaded} uploaded, ${day.chunksSent} chunks, ${(day.bytesSent / 1024).toFixed(1)} KiB of frames`,
  );
} finally {
  client?.close();
  await server.cleanup();
  await removeTree(dir);
}
