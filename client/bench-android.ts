/**
 * What a pass costs on the phone, which is the only machine whose answer
 * settles anything.
 *
 * `bun run bench:android`. Read [open work](../docs/open-work.md) first: it
 * names the two things this is meant to decide and fixes the threshold for
 * both *before* the numbers arrive, so neither can be argued into place
 * afterwards.
 *
 * The desktop benchmark next door (`bench-pass.ts`) measures the same phases
 * through `NodeVault` on APFS. The two differ in the term that matters: a
 * desktop `list()` walks a directory and the Obsidian adapter's reads
 * `getAllLoadedFiles()` out of memory, so roughly half of a desktop quiet pass
 * is a cost the phone does not pay, and the share of what remains is what is
 * in question.
 *
 * ## What this will not do
 *
 * It refuses to touch the live vault or the live server, and the refusals are
 * checks rather than intentions: every adb argument naming a path must sit
 * under the bench vault, and a handful of names are refused outright. A
 * benchmark that can reach somebody's notes is one nobody should run.
 *
 * It also needs a person for four things, and says so rather than pretending:
 * Obsidian's vault switcher is not reachable over adb, and neither is the
 * Restricted-mode toggle or a pairing dialog.
 *
 * ## The clock
 *
 * There is no shared clock and none is invented. The end-to-end number is
 * taken entirely on this machine: the moment before `adb` is asked to write,
 * and the moment a fresh read of the peer's own file matches the exact bytes.
 * The phone's numbers are durations from its own monotonic clock, which need
 * agreement with nothing. Total and breakdown are each sound, and what sits
 * between them is reported as a remainder rather than attributed to either.
 *
 * ## What it cannot see
 *
 * The phone has one JavaScript thread and Obsidian is on it, so a phase that
 * held the event loop while Obsidian reacted to the same save is charged for
 * it. That is why the **quiet ticker passes**, where Trew is alone on the
 * thread, are the evidence for the phase split, and the save passes are used
 * only for the end-to-end figure.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Client } from "./src/core/client.ts";
import { TestServer, serverBinary } from "./src/core/test-server.ts";
import { JsonIndexStore, NodeVault } from "./src/node/vault.ts";
import { corpusPaths, noteBody, pathFor } from "./bench-corpus.ts";

const run = promisify(execFile);

/** The vault on the phone this may touch, and nothing else. */
const VAULT = process.env["BENCH_VAULT"] ?? "Bench";
const VAULT_DIR = `/sdcard/Documents/${VAULT}`;
const PLUGIN_DIR = `${VAULT_DIR}/.obsidian/plugins/trew-sync`;
const TIMING_LOG = `${PLUGIN_DIR}/pass-timings.ndjson`;
const SIZES = (process.env["BENCH_SIZES"] ?? "10000").split(",").map(Number);
const SAMPLES = Number(process.env["BENCH_SAMPLES"] ?? 15);
/** How long the first sync is allowed before this gives up on it. */
const SETTLE_MS = Number(process.env["BENCH_SETTLE_MS"] ?? 30 * 60_000);
/** How long quiet passes are gathered for. The ticker fires every 30 s. */
const COLLECT_MS = Number(process.env["BENCH_COLLECT_MS"] ?? 210_000);

/**
 * Names this must never appear to operate on.
 *
 * A list rather than a convention, because the cost of being wrong is somebody
 * else's notes and somebody else's server.
 */
const FORBIDDEN = ["My Vault", "homelab", "example"];

/** One adb call, refused before it runs if it names anything it must not. */
async function adb(...args: string[]): Promise<string> {
  const whole = args.join(" ");
  for (const name of FORBIDDEN) {
    if (whole.includes(name)) {
      throw new Error(`refusing an adb command that names ${name}: ${whole}`);
    }
  }
  for (const arg of args) {
    if (arg.startsWith("/sdcard") && !arg.startsWith(VAULT_DIR)) {
      throw new Error(`refusing an adb command outside ${VAULT_DIR}: ${arg}`);
    }
  }
  const { stdout } = await run("adb", args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

const line = (text: string, match: string): string =>
  text
    .split("\n")
    .find((l) => l.includes(match))
    ?.trim() ?? "unknown";

/** What the phone is, recorded beside the numbers so they can be read later. */
async function phoneFacts(): Promise<Record<string, string>> {
  const one = async (...args: string[]) => (await adb(...args)).trim();
  return {
    device: await one("shell", "getprop", "ro.product.model"),
    android: await one("shell", "getprop", "ro.build.version.release"),
    obsidian: line(await one("shell", "dumpsys", "package", "md.obsidian"), "versionName"),
    battery: line(await one("shell", "dumpsys", "battery"), "level"),
    thermal: line(await one("shell", "dumpsys", "thermalservice"), "Thermal Status"),
  };
}

/** Brings Obsidian forward without writing anything. */
async function wakeObsidian(): Promise<void> {
  await adb(
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `'obsidian://open?vault=${encodeURIComponent(VAULT)}'`,
  ).catch(() => "");
  await new Promise((r) => setTimeout(r, 3000));
}

/** Whether Obsidian is the focused window, which is when Android lets it work. */
async function inForeground(): Promise<boolean> {
  return /mCurrentFocus.*md\.obsidian/.test(await adb("shell", "dumpsys", "window"));
}

/** One line per measured pass, as the plugin wrote it. */
interface PassLine {
  readonly at: number;
  readonly waitedMs: number | null;
  readonly listMs: number;
  readonly decideMs: number;
  readonly transferMs: number;
  readonly saveMs: number;
  readonly journalCompareMs: number;
  readonly filesystemMs: Record<string, { ms: number; calls: number }>;
  readonly journal: { compareMs: number; writeMs: number; bytes: number; kind: string } | null;
  readonly unchanged: number;
  readonly uploaded: number;
  readonly downloaded: number;
}

/** Everything the phone has written since the log was last cleared. */
async function readTimings(): Promise<PassLine[]> {
  const text = await adb("shell", "cat", TIMING_LOG).catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as PassLine];
      } catch {
        // A line cut in half by a read racing an append. Dropped rather than
        // guessed at, and the count of them is reported.
        return [];
      }
    });
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
};

async function atSize(size: number): Promise<void> {
  console.log(`\n=== ${size.toLocaleString()} notes ===`);

  const server = new TestServer();
  await server.start();
  const peerDir = await mkdtemp(join(tmpdir(), "trew-android-peer-"));
  const port = new URL(server.wsUrl).port;

  // The phone reaches this machine over its own loopback, forwarded by adb.
  // Nothing is published on the network and the live server is never named.
  //
  // The *same* port number on both sides, which matters more than it looks:
  // an invite carries the server's own URL, and the phone has to resolve that
  // URL unchanged. Forwarding phone:3999 to mac:65267 hands the phone an
  // invite naming 65267, a port nothing on the phone is listening on, and the
  // pairing fails for a reason that looks like anything but this.
  await adb("reverse", `tcp:${port}`, `tcp:${port}`);
  const endpoint = `ws://127.0.0.1:${port}`;

  const peer = new Client({
    vault: new NodeVault(peerDir),
    store: new JsonIndexStore(join(peerDir, ".trew", "index.json")),
    url: server.wsUrl,
    ...(await server.deviceCredentials("peer")),
    vaultId: "default",
    device: "peer",
    timeoutMs: 300_000,
    coalesceWrites: false,
  });

  try {
    await peer.connect();

    console.log(`  building ${size.toLocaleString()} notes on this machine...`);
    const made = new Set<string>();
    for (let i = 0; i < size; i++) {
      const rel = pathFor(i);
      const folder = join(peerDir, rel, "..");
      if (!made.has(folder)) {
        await mkdir(folder, { recursive: true });
        made.add(folder);
      }
      await writeFile(join(peerDir, rel), noteBody(i));
    }
    console.log("  uploading to the disposable server...");
    await peer.settle({}, 256);

    // The folders the corpus actually used, so the archive names them rather
    // than sweeping in the peer's `.trew` index alongside the notes.
    const corpusFolders = [...new Set(corpusPaths(size).map((p) => p.split("/")[0]!))];

    // The phone gets the same bytes locally rather than downloading them, so
    // pairing finds both sides identical and nothing transfers. Written while
    // Obsidian is stopped, which is the one moment a vault has no watcher
    // state to protect; once it is open every write goes through Obsidian.
    console.log("  seeding the phone (Obsidian stopped)...");
    await adb("shell", "am", "force-stop", "md.obsidian");
    await adb("shell", "mkdir", "-p", PLUGIN_DIR);

    // One archive, extracted on the device. `adb push` of a directory is one
    // round trip per file, and fifty thousand of those is the seeding step
    // taking longer than everything it exists to set up. The phone has
    // toybox tar, so the transfer becomes one file and the unpacking happens
    // where the files land.
    const archive = join(peerDir, "..", `bench-corpus-${size}.tar`);
    await run("tar", ["-cf", archive, "-C", peerDir, ...corpusFolders], {
      maxBuffer: 1024 * 1024 * 1024,
    });
    const tarAt = performance.now();
    await adb("push", archive, `${VAULT_DIR}/corpus.tar`);
    await adb("shell", "tar", "-xf", `${VAULT_DIR}/corpus.tar`, "-C", VAULT_DIR);
    await adb("shell", "rm", "-f", `${VAULT_DIR}/corpus.tar`);
    await rm(archive, { force: true });
    console.log(`    seeded in ${((performance.now() - tarAt) / 1000).toFixed(1)} s`);
    await adb("push", "dist/plugin/main.js", `${PLUGIN_DIR}/main.js`);
    await adb("push", "dist/plugin/manifest.json", `${PLUGIN_DIR}/manifest.json`);
    await adb("push", "dist/plugin/styles.css", `${PLUGIN_DIR}/styles.css`);
    const enabled = join(peerDir, ".community-plugins.json");
    await writeFile(enabled, JSON.stringify(["trew-sync"]));
    await adb("push", enabled, `${VAULT_DIR}/.obsidian/community-plugins.json`);
    await adb("shell", "touch", TIMING_LOG);
    // Unpaired, every run. The server this seeds against is disposable, so a
    // pairing left from a previous run names a port nothing is listening on,
    // and the phone sits retrying a dead address instead of offering the
    // invite screen. The index goes with it: it describes a vault on a server
    // that no longer exists.
    for (const stale of ["data.json", "index.json", "index.log"]) {
      await adb("shell", "rm", "-f", `${PLUGIN_DIR}/${stale}`);
    }

    // An hour, asked for rather than left to the default. What this is
    // waiting for is a person picking up a phone, and an invite that expires
    // while they do fails as "could not connect", which reads like a broken
    // endpoint rather than a stopwatch. An hour is also the most a device may
    // ask for: the server clamps anything longer to it.
    const invite = await peer.invite({ ttlMs: 60 * 60_000 });
    const until =
      invite.expiresAt === null
        ? "it is cancelled, since it never expires"
        : new Date(invite.expiresAt).toLocaleTimeString();
    console.log("\n  ---- do this on the phone ----");
    console.log(`  1. Obsidian, vault switcher, "Open folder as vault", pick ${VAULT}`);
    console.log("     (it exists now: this step is why it did not before)");
    console.log("  2. Settings, Community plugins, turn off Restricted mode");
    console.log("  3. Trew, Paste an invite, and paste this:");
    console.log(`\n     ${invite.invite}\n`);
    console.log(`     It must say it joins ${endpoint}. If it names anything else, stop.`);
    console.log("  4. Leave Obsidian open, in the foreground, screen on");
    console.log(`\n  This invite is good until ${until}.`);
    console.log("  ------------------------------\n");
    console.log("  waiting for the phone to pair, then to catch up...");
    // Generous, because what it is waiting for is a person with a phone.
    await waitFor(
      "the phone to appear online",
      async () => {
        const rows = await peer.devices();
        return rows.devices.some((d) => d.name !== "peer" && d.online);
      },
      30 * 60_000,
    );

    // Settled, and seen to be settled, before anything is timed. Obsidian
    // Settled first, and only then measured. Obsidian indexes the whole vault
    // on open and the first pass reconciles every file against the server,
    // which at 500 notes was 22 seconds: a real cost, and not a quiet pass.
    // Letting it finish and *then* clearing the log keeps it out of the
    // sample rather than sitting in the middle of it.
    // Waited for, not timed out. The first pass reconciles every file against
    // the server and took 22.5 seconds at five hundred notes, so any fixed
    // sleep is a guess that is far too long at one size and far too short at
    // the next. The phone reports the cursor it has applied, and that reaching
    // the server's is the thing "settled" actually means.
    console.log("  letting the first sync finish (waiting for the phone to catch up)...");
    const settleFrom = performance.now();
    await waitFor(
      "the phone to apply everything the server has",
      async () => {
        const rows = await peer.devices();
        const phone = rows.devices.find((d) => d.name !== "peer");
        return phone !== undefined && (phone.applied ?? -1) >= peer.serverCursor;
      },
      SETTLE_MS,
    );
    console.log(`    first sync done in ${((performance.now() - settleFrom) / 1000).toFixed(0)} s`);
    await adb("shell", "rm", "-f", TIMING_LOG);
    await adb("shell", "touch", TIMING_LOG);
    // Obsidian in front, or there are no passes to collect.
    //
    // Android suspends a backgrounded WebView, and Trew's own guide says
    // sync runs on Android only while Obsidian is open in the foreground. A
    // collection window with the phone on a home screen gathers nothing at
    // all, which is what two runs did. `obsidian://open` brings it forward and
    // writes nothing, so it costs the measurement nothing either.
    await wakeObsidian();
    console.log(`  collecting quiet passes for ${(COLLECT_MS / 1000).toFixed(0)} s...`);
    await new Promise((r) => setTimeout(r, COLLECT_MS));

    // The end-to-end figure, on this machine's clock at both ends.
    console.log(`\n  ${SAMPLES} saved edits, phone to verified bytes here...`);
    const totals: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      // Brought forward rather than skipped. The URI below launches Obsidian
      // anyway, so refusing to send it because Obsidian was not already in
      // front skipped every sample of the first run and measured nothing.
      // What matters is that it was in front *while the pass ran*, which is
      // checked after.
      const nonce = `bench-${Date.now()}-${i}`;
      const rel = pathFor(i % size);
      const uri =
        `obsidian://new?vault=${encodeURIComponent(VAULT)}` +
        `&file=${encodeURIComponent(rel.replace(/\.md$/, ""))}` +
        `&content=${encodeURIComponent(nonce)}&overwrite&silent`;
      const at = performance.now();
      // Quoted for the phone's shell, which is a second shell.
      //
      // `adb shell` joins its arguments and hands the string to `sh` on the
      // device, so an unquoted `&` in the URI is a shell operator there: the
      // last run split `...&overwrite&silent` into three commands and failed
      // with "silent: inaccessible or not found". This is CLAUDE.md's rule
      // about never inlining a payload into a shell argument, and the second
      // shell is the one that is easy to forget.
      await adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${uri}'`);
      await waitFor(`sample ${i + 1} to arrive`, async () => {
        const here = await readFileMaybe(join(peerDir, rel));
        return here !== undefined && here.includes(nonce);
      });
      const took = performance.now() - at;
      const front = await inForeground();
      if (!front) {
        console.log(`    ${i + 1}/${SAMPLES}: ${took.toFixed(0)} ms (discarded, not in front)`);
        continue;
      }
      totals.push(took);
      console.log(`    ${i + 1}/${SAMPLES}: ${took.toFixed(0)} ms`);
    }
    if (totals.length > 0) {
      console.log(
        `\n  save to verified on peer: p50 ${median(totals).toFixed(0)} ms, ` +
          `p95 ${percentile(totals, 95).toFixed(0)} ms, over ${totals.length} samples`,
      );
    }

    // The whole log, read once at the end, rather than a snapshot taken in
    // the middle. A quiet pass is a quiet pass whenever it happened, and the
    // ones that follow each timed save are as good as the ones in the
    // collection window; reading only the window threw half the evidence away.
    const all = await readTimings();
    await writeFile(`bench-android-${size}.ndjson`, all.map((l) => JSON.stringify(l)).join("\n"));
    // The first pass after pairing reconciles every file against the server
    // and is not a quiet pass by any reading: at 500 notes it was 22 seconds.
    const quiet = all
      .filter((l) => l.unchanged > 0 && l.uploaded === 0 && l.downloaded === 0)
      .slice(1);
    console.log(`\n  quiet passes: ${quiet.length} (raw log in bench-android-${size}.ndjson)`);
    if (quiet.length > 0) {
      const total = (l: PassLine) => l.listMs + l.decideMs + l.transferMs + l.saveMs;
      // From the journal's own record. `phases.journalCompareMs` is the
      // engine's field, and the engine cannot see inside the store, so it is
      // always zero; the number is the one the store reported.
      const compareOf = (l: PassLine) => l.journal?.compareMs ?? 0;
      const share = median(quiet.map((l) => (l.decideMs + compareOf(l)) / total(l)));
      console.log(`    total     p50 ${median(quiet.map(total)).toFixed(1)} ms`);
      console.log(`    list      p50 ${median(quiet.map((l) => l.listMs)).toFixed(1)} ms`);
      console.log(`    decide    p50 ${median(quiet.map((l) => l.decideMs)).toFixed(1)} ms`);
      console.log(`    save      p50 ${median(quiet.map((l) => l.saveMs)).toFixed(1)} ms`);
      console.log(`    compare   p50 ${median(quiet.map(compareOf)).toFixed(1)} ms`);
      console.log(`    decide+compare share: ${(share * 100).toFixed(1)}%  (threshold 50%)`);
      const snaps = all.filter((l) => l.journal?.kind === "snapshot");
      if (snaps.length > 0) {
        const bytes = Math.max(...snaps.map((l) => l.journal?.bytes ?? 0));
        const wrote = Math.max(...snaps.map((l) => l.journal?.writeMs ?? 0));
        console.log(
          `    index snapshot: ${(bytes / 1024).toFixed(0)} KiB in ${wrote.toFixed(0)} ms`,
        );
      }
    }
  } finally {
    await adb("reverse", "--remove", `tcp:${port}`).catch(() => "");
    await peer.close().catch(() => undefined);
    await server.cleanup().catch(() => undefined);
    await rm(peerDir, { recursive: true, force: true });
  }
}

/**
 * Polls until a condition holds, or gives up and says what it was waiting for.
 *
 * `until` in the test harness takes a synchronous predicate; every condition
 * here is a read of another machine.
 */
async function waitFor(what: string, ready: () => Promise<boolean>, ms = 180_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`gave up waiting for ${what} after ${ms} ms`);
}

async function readFileMaybe(path: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8").catch(() => undefined);
}

async function main(): Promise<void> {
  console.log("trew: what a pass costs on the phone");
  console.log(`  ${cpus()[0]?.model ?? "unknown cpu"}, ${cpus().length} cores (host)`);
  for (const [k, v] of Object.entries(await phoneFacts())) console.log(`  ${k}: ${v}`);
  console.log(`  vault: ${VAULT_DIR}`);
  console.log(`  sizes: ${SIZES.join(", ")}, ${SAMPLES} samples each`);

  await serverBinary();
  // The screen off is Obsidian suspended, and a suspended Obsidian runs no
  // passes: the last run collected one quiet pass in three and a half minutes
  // of trying, because the phone had gone to sleep. Restored at the end.
  await adb("shell", "svc", "power", "stayon", "usb").catch(() => "");
  try {
    for (const size of SIZES) await atSize(size);
  } finally {
    await adb("shell", "svc", "power", "stayon", "false").catch(() => "");
  }
}

await main();
