/**
 * What `bench-10k.ts` and `bench-phone-10k.ts` share: a real `trewd` and what
 * it costs, devices as the headless client opens them, byte-for-byte
 * inventories, and the check that two devices' edits of one note both survived.
 *
 * Nothing here decides anything a device does. It drives the shipped code
 * (`dist/trew.mjs`, `Client` with the Node vault) and reads the results off
 * the disk, so a number it produces describes the product and not the harness.
 */

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { Client, credentialsFor } from "./src/core/client.ts";
import { conflictOriginal } from "./src/core/conflicts.ts";
import { loadConfig, indexPath } from "./src/node/config.ts";
import { JsonIndexStore, NodeVault } from "./src/node/vault.ts";
import type { Corpus } from "./src/stress/corpus.ts";

export const run = promisify(execFile);
/** The shipped headless client, built by `node esbuild.config.mjs production`. */
export const CLI = new URL("./dist/trew.mjs", import.meta.url).pathname;

/**
 * Builds the headless client and the plugin from this checkout, so a run
 * measures the code beside it and not whatever `dist/` last held.
 */
export function buildClient(): void {
  execFileSync("node", ["esbuild.config.mjs", "production"], {
    cwd: new URL(".", import.meta.url).pathname,
    stdio: "ignore",
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]!;
};
export const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!;
};
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export const ms = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ *
 * The server, and what it costs
 * ------------------------------------------------------------------ */

export class Trewd {
  proc: ChildProcess | undefined;
  port = 0;
  readonly log: string[] = [];
  constructor(
    readonly binary: string,
    readonly data: string,
  ) {}

  async start(port: number): Promise<void> {
    this.port = port;
    const proc = spawn(
      this.binary,
      ["serve", "-mcp", "-localhost", "-addr", `127.0.0.1:${port}`, "-data", this.data],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.proc = proc;
    proc.stderr!.on("data", (b: Buffer) => this.log.push(String(b)));
    await new Promise<void>((resolve, reject) => {
      let banner = "";
      const timer = setTimeout(
        () => reject(new Error(`trewd did not start: ${this.log.join("")}`)),
        30_000,
      );
      proc.stdout!.on("data", (b: Buffer) => {
        banner += String(b);
        if (/^trewd .* listening on /m.test(banner)) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc.once("exit", (code) => reject(new Error(`trewd exited ${code}: ${this.log.join("")}`)));
    });
  }

  get pid(): number {
    return this.proc!.pid!;
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    const ended = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    await Promise.race([ended, sleep(20_000)]);
    if (p.exitCode === null) p.kill("SIGKILL");
    this.proc = undefined;
  }

  cli(...args: string[]): string {
    return execFileSync(this.binary, [...args, "-data", this.data], {
      encoding: "utf8",
      timeout: 600_000,
    });
  }

  invite(): string {
    const found = /trew1i_[A-Za-z0-9_-]+/.exec(this.cli("invite"));
    if (!found) throw new Error("trewd invite printed no invite");
    return found[0];
  }
}

export interface Sample {
  readonly at: number;
  readonly rssKb: number;
  readonly cpuS: number;
}

/** `ps` four times a second: resident memory and cumulative CPU of the server. */
export class Sampler {
  readonly samples: Sample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly pid: () => number | undefined) {}
  start(): void {
    this.timer = setInterval(() => void this.once(), 250);
  }
  async once(): Promise<Sample | undefined> {
    const pid = this.pid();
    if (pid === undefined) return undefined;
    try {
      const { stdout } = await run("ps", ["-o", "rss=,time=", "-p", String(pid)]);
      const [rss, time] = stdout.trim().split(/\s+/);
      const parts = time!.split(":").map(Number);
      let cpu = 0;
      for (const p of parts) cpu = cpu * 60 + p;
      const s = { at: performance.now(), rssKb: Number(rss), cpuS: cpu };
      this.samples.push(s);
      return s;
    } catch {
      return undefined;
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  /** Peak resident and CPU seconds between two instants. */
  window(from: number, to: number): { peakRssMiB: number; cpuS: number } {
    const inside = this.samples.filter((s) => s.at >= from && s.at <= to);
    const before = [...this.samples].reverse().find((s) => s.at <= from);
    const after = this.samples.find((s) => s.at >= to) ?? inside[inside.length - 1];
    const peak = Math.max(0, ...inside.map((s) => s.rssKb));
    // A restart inside the window starts the count again from zero.
    const spent =
      before && after ? (after.cpuS >= before.cpuS ? after.cpuS - before.cpuS : after.cpuS) : NaN;
    return { peakRssMiB: Math.round((peak / 1024) * 10) / 10, cpuS: Math.round(spent * 100) / 100 };
  }
}

export async function du(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let total = 0;
  const walk = async (at: string, top: string) => {
    for (const e of await readdir(at, { withFileTypes: true })) {
      const p = join(at, e.name);
      if (e.isDirectory()) await walk(p, top === "" ? e.name + "/" : top);
      else if (e.isFile()) {
        const size = (await stat(p)).size;
        const key = top === "" ? e.name : top;
        out[key] = (out[key] ?? 0) + size;
        total += size;
      }
    }
  };
  await walk(dir, "");
  const mib: Record<string, number> = {};
  for (const [k, v] of Object.entries(out))
    if (v > 64 * 1024) mib[k] = Math.round((v / 1048576) * 10) / 10;
  mib["total"] = Math.round((total / 1048576) * 10) / 10;
  return mib;
}

/* ------------------------------------------------------------------ *
 * Devices
 * ------------------------------------------------------------------ */

export async function writeCorpus(dir: string, corpus: Corpus): Promise<number> {
  const made = new Set<string>();
  let bytes = 0;
  for (let i = 0; i < corpus.files.length; i++) {
    const p = join(dir, corpus.files[i]!.path);
    const folder = dirname(p);
    if (!made.has(folder)) {
      await mkdir(folder, { recursive: true });
      made.add(folder);
    }
    const b = corpus.bytes(i);
    bytes += b.length;
    await writeFile(p, b);
  }
  return bytes;
}

/** Path to SHA-256 of every file a device syncs, dot-prefixed names skipped. */
export async function inventory(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (at: string) => {
    for (const e of await readdir(at, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(at, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.set(relative(dir, p).normalize("NFC"), sha(await readFile(p)));
    }
  };
  await walk(dir);
  return out;
}

export function diff(a: Map<string, string>, b: Map<string, string>, limit = 8): string[] {
  const out: string[] = [];
  for (const [p, h] of a) if (b.get(p) !== h) out.push(`${p}: ${b.has(p) ? "differs" : "missing"}`);
  for (const p of b.keys()) if (!a.has(p)) out.push(`${p}: extra`);
  return out
    .slice(0, limit)
    .concat(out.length > limit ? [`...and ${out.length - limit} more`] : []);
}

export async function trew(
  dir: string,
  ...args: string[]
): Promise<{ ms: number; code: number; out: string }> {
  const t0 = performance.now();
  try {
    const { stdout, stderr } = await run(
      "node",
      [CLI, ...args, "--dir", dir, "--timeout", "600000"],
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 1_800_000,
      },
    );
    return { ms: performance.now() - t0, code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      ms: performance.now() - t0,
      code: typeof e.code === "number" ? e.code : -1,
      out: `${e.stdout}${e.stderr}`,
    };
  }
}

/** A watching headless client, as `trew sync --watch` opens one, in this process. */
export class Live {
  c: Client | undefined;
  running: Promise<Error> | undefined;
  constructor(readonly dir: string) {}
  async open(watch = true): Promise<Client> {
    const config = await loadConfig(this.dir);
    if (!config) throw new Error(`${this.dir} is not paired`);
    const vault = new NodeVault(this.dir);
    await vault.probeCase();
    this.c = new Client({
      vault,
      store: new JsonIndexStore(indexPath(this.dir)),
      ...credentialsFor(config),
      timeoutMs: 600_000,
      coalesceWrites: watch,
    });
    await this.c.connect();
    return this.c;
  }
  watch(): void {
    this.running = this.c!.runUntilClosed(30_000);
  }
  async close(): Promise<void> {
    await this.c?.close();
    await this.running?.catch(() => undefined);
    this.c = undefined;
    this.running = undefined;
  }
}

/** Settles each device in turn until a round moves nothing. */
/**
 * Settles each device in turn until a round moves nothing and nothing is
 * left waiting or retrying.
 *
 * Waiting and retrying count as not settled. The first version of this
 * stopped at a round that moved nothing, and a deletion held back by a retry
 * was still unsent when the next phase began: the run blamed the device that
 * caught up for a note the other one had not yet said was gone.
 */
export async function converge(clients: Client[], rounds = 12, limitMs = 600_000): Promise<number> {
  const until = performance.now() + limitMs;
  let n = 0;
  for (; n < rounds; n++) {
    let moved = false;
    let owed = false;
    for (const c of clients) {
      const r = await c.settle({ coalesceWrites: false });
      if (
        r.uploaded +
          r.downloaded +
          r.merged +
          r.conflicted +
          r.deletedLocally +
          r.deletedRemotely +
          r.restored >
        0
      )
        moved = true;
      if (r.waiting + r.retrying > 0) owed = true;
    }
    if (!moved && !owed) break;
    if (!moved && owed) {
      if (performance.now() > until)
        throw new Error("devices still owe work after the time allowed");
      await sleep(1000);
      n--;
    }
  }
  return n;
}

export async function waitFor(
  what: string,
  ready: () => Promise<boolean>,
  limitMs = 600_000,
  everyMs = 20,
): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < limitMs) {
    if (await ready().catch(() => false)) return performance.now() - t0;
    await sleep(everyMs);
  }
  throw new Error(`gave up waiting for ${what} after ${limitMs} ms`);
}

export const readMaybe = (p: string) => readFile(p, "utf8").catch(() => undefined);

/* ------------------------------------------------------------------ *
 * Edits, and the check that nothing was lost
 * ------------------------------------------------------------------ */

/** Notes safe to edit by string: plain LF text, no BOM. */
export function editableNotes(corpus: Corpus): string[] {
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  return corpus.files
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => {
      if (f.kind !== "note") return false;
      const t = dec.decode(corpus.bytes(i));
      return !t.includes("\r") && t.charCodeAt(0) !== 0xfeff;
    })
    .map(({ f }) => f.path);
}

export interface Overlap {
  readonly path: string;
  readonly a: string;
  readonly b: string;
  readonly lineA: string;
  readonly lineB: string;
}

/**
 * Checks two edits of one note both survive: merged into it, or kept beside it
 * as a conflict copy holding the other side's exact bytes.
 */
export async function overlapSurvived(
  dir: string,
  o: Overlap,
  inv: Map<string, string>,
): Promise<"merged" | "kept both" | "lost"> {
  const note = (await readMaybe(join(dir, o.path))) ?? "";
  const copies = [...inv.keys()].filter((p) => conflictOriginal(p) === o.path);
  if (note.includes(o.lineA) && note.includes(o.lineB) && copies.length === 0) return "merged";
  const texts = [note, ...(await Promise.all(copies.map((c) => readMaybe(join(dir, c)))))];
  const hasA = texts.some((t) => t === o.a || (t?.includes(o.lineA) ?? false));
  const hasB = texts.some((t) => t === o.b || (t?.includes(o.lineB) ?? false));
  return hasA && hasB ? "kept both" : "lost";
}

/** Every conflict copy on disk must name a path two devices really edited at once. */
export function unexplainedCopies(inv: Map<string, string>, explained: Set<string>): string[] {
  return [...inv.keys()].filter((p) => {
    const orig = conflictOriginal(p);
    return orig !== undefined && !explained.has(orig);
  });
}
