/**
 * What a pass costs when nothing much happened, as the vault grows (I07).
 *
 * `bun run bench:pass`, or `BENCH_NODE=1 node --experimental-strip-types
 * bench-pass.ts` for the runtime the CLI actually ships on.
 *
 * bench-sync.ts measures a whole vault through a real server: how fast the
 * first sync is, what goes on the wire. This measures the other thing, which is
 * what the software costs when there is nothing to do. A watcher fires on every
 * save, a ticker fires anyway, and the great majority of passes in a vault's
 * life find one note changed or none at all. If that pass is O(vault) then the
 * cost of owning a large vault is paid on every keystroke's worth of work, and
 * nothing in the suite would say so: every test runs against a handful of
 * notes, where O(vault) and O(change) are the same number.
 *
 * Four workloads, because they exercise different halves:
 *
 *   nothing changed   the walk, the index compare, and whatever save does
 *   one note changed  the above, plus the smallest possible amount of real work
 *   a folder renamed  many paths moving at once, which is where identity
 *                     tracking and the delta both get expensive
 *   catching up       entries arriving from elsewhere, which is the inbound
 *                     half and the one a device does after being away
 *
 * Reported, not asserted. This is a script for the same reason bench.ts is one:
 * the numbers move by 20x between JavaScriptCore and V8, and a floor loose
 * enough to survive both would catch nothing. What it is for is deciding
 * whether I07 is worth doing, and then whether doing it worked.
 *
 * Read the shape rather than the absolute time. A cost that is flat as the
 * vault grows is a cost that does not matter however large it is; one that
 * doubles when the vault doubles is the thing I07 is about, and the ratio
 * column is the whole answer.
 */

// `rename` is imported under another name: the measurement below binds a const
// called rename, and the callback would resolve to that one, uninitialised.
import { mkdtemp, mkdir, readFile, rename as movePath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";

import { Client } from "./src/core/client.ts";
import type { PassPhases, SyncReport } from "./src/core/engine.ts";
import { testWrapped } from "./src/core/test-keys.ts";
import { TestServer, serverBinary } from "./src/core/test-server.ts";
import { noteBody, pathFor } from "./bench-corpus.ts";
import { JsonIndexStore, NodeVault } from "./src/cli/vault.ts";
import { timedVault } from "./src/core/vault.ts";

/** Vault sizes. Doubling, so the ratio between rows is the growth rate. */
const SIZES = (process.env["BENCH_SIZES"] ?? "500,1000,2000,4000").split(",").map(Number);

/** How many passes each figure is the median of. */
const REPEATS = Number(process.env["BENCH_REPEATS"] ?? 7);

const enc = new TextEncoder();

async function buildVault(dir: string, count: number): Promise<void> {
  const made = new Set<string>();
  for (let i = 0; i < count; i++) {
    const rel = pathFor(i);
    const folder = join(dir, rel, "..");
    if (!made.has(folder)) {
      await mkdir(folder, { recursive: true });
      made.add(folder);
    }
    await writeFile(join(dir, rel), noteBody(i));
  }
}

interface Timing {
  readonly median: number;
  readonly heapKb: number;
  /** Median of each phase across the same samples, in milliseconds. */
  readonly phases?: Record<string, number>;
}

/** The median of one phase across the samples that reported it. */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The median of several passes, after a warm-up.
 *
 * Median rather than mean: one pass in ten is a garbage collection, and a mean
 * reports the collector's schedule as if it were the cost of the work. The
 * warm-up is because the first call through any of this is compiling it.
 */
async function measure(
  pass: () => Promise<SyncReport | void>,
  repeats = REPEATS,
  /** Reset before each sample and read after it, for the two overlays. */
  overlays?: { reset(): void; read(): { fsMs: number; compareMs: number } },
): Promise<Timing> {
  await pass();
  await pass();
  const times: number[] = [];
  const seen: PassPhases[] = [];
  const fs: number[] = [];
  const compare: number[] = [];
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  for (let i = 0; i < repeats; i++) {
    overlays?.reset();
    const t = performance.now();
    const report = await pass();
    times.push(performance.now() - t);
    if (report && report.phases) seen.push(report.phases);
    if (overlays) {
      const got = overlays.read();
      fs.push(got.fsMs);
      compare.push(got.compareMs);
    }
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  times.sort((a, b) => a - b);
  // Median per phase across the same samples, not a breakdown of the median
  // pass: one sample's collection pause should not be attributed to whichever
  // phase happened to hold it in a different sample.
  const phases =
    seen.length === 0
      ? undefined
      : {
          list: medianOf(seen.map((p) => p.listMs)),
          decide: medianOf(seen.map((p) => p.decideMs)),
          transfer: medianOf(seen.map((p) => p.transferMs)),
          save: medianOf(seen.map((p) => p.saveMs)),
          journalCompare: medianOf(compare),
          fs: medianOf(fs),
        };
  return {
    median: times[Math.floor(times.length / 2)]!,
    heapKb: Math.max(0, Math.round((peak - before) / 1024)),
    ...(phases ? { phases } : {}),
  };
}

interface Row {
  readonly size: number;
  readonly quiet: Timing;
  readonly oneNote: Timing;
  readonly rename: Timing;
  /** The same move, with the shell reporting it the way the plugin does. */
  readonly renameReported: Timing;
  readonly catchUp: Timing;
}

async function atSize(size: number): Promise<Row> {
  const server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(31);
  const wrapped = await testWrapped(secret);
  const dirs: string[] = [];
  const clients: Client[] = [];

  // Filled by the wrappers below, read by `measure`, cleared per sample. The
  // adapter overlay and the journal's own split do not travel in the report,
  // because they belong to the store and the vault rather than to the engine.
  const filesystemMs: Record<string, { ms: number; calls: number }> = {};
  let journalCompareMs = 0;

  const device = async (name: string): Promise<{ c: Client; dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), `trew-pass-${name}-`));
    dirs.push(dir);
    const c = new Client({
      // Wrapped exactly as the plugin wraps its own, so the desktop rows and
      // the Android rows are measuring the same things under the same names.
      vault: timedVault(new NodeVault(dir), filesystemMs),
      store: new JsonIndexStore(join(dir, ".trew", "index.json"), {
        onSave: (cost) => {
          journalCompareMs += cost.compareMs;
        },
      }),
      url: server.wsUrl,
      ...(await server.deviceCredentials(secret, wrapped, name)),
      vaultId: "default",
      device: name,
      timeoutMs: 120_000,
      coalesceWrites: false,
      // The same breakdown the Android runs collect, so the two can be held
      // against each other. See docs/open-work.md for what the comparison is
      // meant to settle.
      timing: true,
    });
    clients.push(c);
    await c.connect();
    return { c, dir };
  };

  try {
    const a = await device("a");
    await buildVault(a.dir, size);
    await a.c.settle({}, 64);

    // Nothing changed. The pass that happens most and should cost least.
    const overlays = {
      reset: () => {
        for (const op of Object.keys(filesystemMs)) delete filesystemMs[op];
        journalCompareMs = 0;
      },
      read: () => ({
        fsMs: Object.values(filesystemMs).reduce((sum, op) => sum + op.ms, 0),
        compareMs: journalCompareMs,
      }),
    };

    const quiet = await measure(async () => await a.c.sync(), REPEATS, overlays);

    // One note, rewritten each time so the pass has exactly one thing to do.
    let n = 0;
    const oneNote = await measure(
      async () => {
        const rel = pathFor(n++ % size);
        const body = await readFile(join(a.dir, rel), "utf8");
        await writeFile(join(a.dir, rel), body + `edit ${n}\n`);
        return await a.c.settle({}, 8);
      },
      REPEATS,
      overlays,
    );

    // A folder moved. Every note under it changes path at once, which is the
    // shape that makes identity tracking and the index delta work hardest, and
    // the one somebody does by dragging a folder in the sidebar.
    let round = 0;
    const rename = await measure(
      async () => {
        const from = join(a.dir, `area-3`);
        const to = join(a.dir, `area-3-moved-${round++}`);
        await movePath(from, to).catch(() => undefined);
        await a.c.settle({}, 16);
        await movePath(to, from).catch(() => undefined);
        return await a.c.settle({}, 16);
      },
      Math.max(3, Math.floor(REPEATS / 2)),
      overlays,
    );

    // The same folder rename, with the vault telling the engine it happened.
    //
    // This is the difference between the two shells rather than a variant of
    // the benchmark. Obsidian fires a rename event and the plugin forwards it
    // to `noteRename`, which carries the entry, its chunk list and its hash to
    // the new path: nothing is read and nothing is sealed, because the bytes
    // did not change and sealing is deterministic. The CLI has no such event,
    // so every moved note looks like a new path with no entry and is read,
    // chunked and sealed again from scratch.
    let told = 0;
    const renameReported = await measure(
      async () => {
        const from = `area-5`;
        const to = `area-5-moved-${told++}`;
        await movePath(join(a.dir, from), join(a.dir, to)).catch(() => undefined);
        a.c.engine.noteRename(from, to);
        await a.c.settle({}, 16);
        await movePath(join(a.dir, to), join(a.dir, from)).catch(() => undefined);
        a.c.engine.noteRename(to, from);
        return await a.c.settle({}, 16);
      },
      Math.max(3, Math.floor(REPEATS / 2)),
      overlays,
    );

    // Catching up: entries arriving from another device, which is the inbound
    // half. A second device writes a fixed number of notes however large the
    // vault is, so a cost that grows with the row is the vault's size showing
    // through work that should only be about the change.
    const b = await device("b");
    await b.c.settle({}, 64);
    let batch = 0;
    const arriving = 25;
    const catchUp = await measure(
      async () => {
        const tag = batch++;
        await mkdir(join(b.dir, "incoming"), { recursive: true });
        for (let i = 0; i < arriving; i++) {
          await writeFile(join(b.dir, "incoming", `from-b-${tag}-${i}.md`), noteBody(i));
        }
        await b.c.settle({}, 16);
        return await a.c.settle({}, 16);
      },
      Math.max(3, Math.floor(REPEATS / 2)),
      overlays,
    );

    return { size, quiet, oneNote, rename, renameReported, catchUp };
  } finally {
    for (const c of clients) c.close();
    await server.stop();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
}

function table(rows: Row[]): void {
  const cols: Array<[string, (r: Row) => Timing]> = [
    ["nothing changed", (r) => r.quiet],
    ["one note changed", (r) => r.oneNote],
    ["a folder renamed", (r) => r.rename],
    ["a folder renamed, reported", (r) => r.renameReported],
    [`catching up`, (r) => r.catchUp],
  ];
  for (const [name, pick] of cols) {
    console.log(`\n  ${name}`);
    console.log(`    ${"notes".padStart(7)} ${"ms".padStart(9)} ${"vs prev".padStart(8)}  heap`);
    let prev: number | undefined;
    for (const r of rows) {
      const t = pick(r);
      // The whole point of the table. Doubling the vault doubles this number
      // if the cost is the vault's size, and leaves it alone if it is not.
      const ratio = prev === undefined ? "" : `${(t.median / prev).toFixed(2)}x`;
      console.log(
        `    ${String(r.size).padStart(7)} ${t.median.toFixed(1).padStart(9)} ${ratio.padStart(8)}  ${String(t.heapKb).padStart(6)} KiB`,
      );
      prev = t.median;
    }
    // The breakdown under the totals, for the terms the rewrite in
    // docs/open-work.md would remove. `fs` is an overlay across the other
    // four, not a fifth column, so it does not add into the total.
    //
    // The four phase columns are per pass, summed across the rounds of one
    // `sync`. The two overlay columns are per *sample*, and a sample of every
    // workload except the quiet one is a whole `settle`, which is several
    // syncs. So on those rows `compare` and `fs` cover more passes than the
    // phases do and can exceed the phase they sit inside. The quiet row, which
    // is one `sync` and is the row the threshold in docs/open-work.md is
    // written against, is consistent.
    if (rows.some((r) => pick(r).phases)) {
      console.log(
        `    ${"notes".padStart(7)} ${"list".padStart(8)} ${"decide".padStart(8)} ${"transfer".padStart(8)} ${"save".padStart(8)} ${"of which".padStart(9)} ${"fs".padStart(8)}`,
      );
      console.log(
        `    ${"".padStart(7)} ${"per pass".padStart(35)} ${"compare".padStart(18)} ${"per sample".padStart(8)}`,
      );
      for (const r of rows) {
        const p = pick(r).phases;
        if (!p) continue;
        const n = (v: number | undefined) => (v ?? 0).toFixed(1).padStart(8);
        console.log(
          `    ${String(r.size).padStart(7)} ${n(p["list"])} ${n(p["decide"])} ${n(p["transfer"])} ${n(p["save"])} ${n(p["journalCompare"]).padStart(9)} ${n(p["fs"])}`,
        );
      }
    }
  }
  console.log(`
  Sizes double, so 2.0x means the cost is the vault's size and 1.0x means it is
  the change's. Anything at or near 2.0x on "nothing changed" or "one note
  changed" is what I07 is about.`);
}

async function main(): Promise<void> {
  console.log("trew: what a quiet pass costs, as the vault grows");
  console.log(`  ${cpus()[0]?.model ?? "unknown cpu"}, ${cpus().length} cores`);
  console.log(
    `  ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.version}`,
  );
  console.log(`  median of ${REPEATS}, after two warm-up passes`);
  void enc;

  await serverBinary();
  const rows: Row[] = [];
  for (const size of SIZES) {
    process.stdout.write(`\n  measuring ${size} notes...`);
    rows.push(await atSize(size));
    process.stdout.write(" done");
  }
  console.log();
  table(rows);
}

await main();
