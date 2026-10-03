/**
 * Ten thousand notes, end to end, against a real `trewd serve -mcp -localhost`.
 *
 * `bun run bench:10k`. Everything the owner's goal needs that does not need
 * the phone: the first upload from one device, a fresh device's first download
 * through the shipped `trew` command, steady passes, one edit's latency between
 * two watching devices, 200 edits at once, a device away for 500 edits, the
 * conflicts those make, the server's CPU, memory and disk, the search index at
 * this size and `search_notes` against it, and `trewd verify -deep`. With
 * `BENCH_OBSIDIAN=1` it also opens a fresh scratch vault in the running
 * Obsidian app and times the real plugin's first download and passes.
 *
 * The corpus is `src/stress/corpus.ts`: unicode, spaces and case in names,
 * frontmatter, links, tags, CRLF and BOM files and 3% attachments, rebuilt
 * exactly from `BENCH_SEED`.
 *
 * Every timed phase is also a correctness check, and a failed check fails the
 * run rather than printing a number beside it: every device's files are
 * compared byte for byte with what they must hold, every conflict copy must
 * belong to a path two devices really did edit at once, and nothing either
 * device wrote may be missing afterwards. A witness device that syncs last
 * from nothing must hold exactly the same bytes as the two that did the work.
 *
 * It never touches a real vault. The devices are temporary directories, the
 * server's data directory is temporary, and the Obsidian vault is a new folder
 * made for the run, opened through Obsidian's own IPC, written only through
 * Obsidian once open, and refused if it already exists.
 *
 * Environment: BENCH_FILES (10000), BENCH_SEED (1), BENCH_REPEATS (7),
 * BENCH_LATENCY_SAMPLES (15), BENCH_OBSIDIAN (0), BENCH_OUT (a JSON report),
 * BENCH_KEEP (1 keeps the temporary directories).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";

import { conflictOriginal } from "./src/core/conflicts.ts";
import { serverBinary } from "./src/core/test-server.ts";
import { makeCorpus } from "./src/stress/corpus.ts";
import { LOCAL_REFUSALS } from "./bench-refuse.ts";
import {
  buildClient,
  converge,
  diff,
  du,
  editableNotes,
  inventory,
  Live,
  median,
  ms,
  overlapSurvived,
  pct,
  readMaybe,
  run,
  Sampler,
  sha,
  sleep,
  trew,
  Trewd,
  unexplainedCopies,
  waitFor,
  writeCorpus,
  type Overlap,
} from "./bench-support.ts";

const FILES = Number(process.env["BENCH_FILES"] ?? 10_000);
const SEED = Number(process.env["BENCH_SEED"] ?? 1);
const REPEATS = Number(process.env["BENCH_REPEATS"] ?? 7);
const LATENCY_SAMPLES = Number(process.env["BENCH_LATENCY_SAMPLES"] ?? 15);
const OBSIDIAN = process.env["BENCH_OBSIDIAN"] === "1";
const KEEP = process.env["BENCH_KEEP"] === "1";
const OUT = process.env["BENCH_OUT"] ?? `bench-10k-${FILES}.json`;
const PLUGIN_DIST = new URL("./dist/plugin/", import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;

const report: Record<string, unknown> = {};
const failures: string[] = [];
const say = (s: string) => console.log(s);
const check = (ok: boolean, what: string) => {
  if (!ok) {
    failures.push(what);
    say(`  FAILED: ${what}`);
  }
};

/* ------------------------------------------------------------------ *
 * MCP
 * ------------------------------------------------------------------ */

class Mcp {
  private id = 0;
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}
  /** How long the last successful request took, excluding pacing and retries. */
  lastMs = 0;
  private last = 0;
  /**
   * One request, paced under the endpoint's per-token budget of five a
   * second (internal/mcp/limits.go), and retried on its 429. The budget is
   * the server doing its job; the time spent waiting on it is not search.
   */
  private async post(body: unknown, init = false): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + 220 - performance.now();
      if (wait > 0) await sleep(wait);
      const s = performance.now();
      this.last = s;
      try {
        const out = await this.postOnce(body, init);
        this.lastMs = performance.now() - s;
        return out;
      } catch (err) {
        if (attempt < 6 && String(err).includes("MCP 429")) {
          await sleep(1000);
          continue;
        }
        throw err;
      }
    }
  }
  private async postOnce(body: unknown, init: boolean): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(init ? {} : { "mcp-protocol-version": "2025-11-25" }),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${res.status}: ${text.slice(0, 400)}`);
    return text === "" ? undefined : JSON.parse(text);
  }
  async init(): Promise<void> {
    await this.post(
      {
        jsonrpc: "2.0",
        id: ++this.id,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "bench-10k", version: "1" },
        },
      },
      true,
    );
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = (await this.post({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "tools/call",
      params: { name, arguments: args },
    })) as {
      result?: {
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
        content?: { text: string }[];
      };
      error?: unknown;
    };
    if (r.error) throw new Error(`MCP error: ${JSON.stringify(r.error).slice(0, 400)}`);
    if (r.result?.isError) throw new Error(`tool error: ${JSON.stringify(r.result).slice(0, 600)}`);
    return r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? "{}");
  }
}

/** Paths a search's matches name, over every page. */
function matchPaths(page: Record<string, unknown>): string[] {
  const data = (page["untrusted_content"] ?? {}) as { matches?: { path: string }[] };
  return [...new Set((data.matches ?? []).map((r) => r.path))];
}
function nextCursor(page: Record<string, unknown>): string | undefined {
  const data = (page["trusted"] ?? {}) as { nextCursor?: string | null };
  return data.nextCursor ?? undefined;
}

/* ------------------------------------------------------------------ *
 * Obsidian, driven through its own CLI
 * ------------------------------------------------------------------ */

function obsidian(args: string[]): string {
  return execFileSync("obsidian", args, {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let evalN = 0;
async function inVault(
  vault: string,
  body: string,
  markerDir: string,
  timeoutMs = 120_000,
): Promise<unknown> {
  const marker = join(markerDir, `eval-${process.pid}-${++evalN}.json`);
  const code = `void (async()=>{const fs=require("fs");try{
    if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error("CLI selected "+app.vault.getName());
    const plugin=app.plugins.plugins["trew-sync"];
    const result=await (async()=>{${body}})();
    fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ok:true,result:result??null}));
  }catch(err){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ok:false,error:String(err&&err.stack||err)}));}})()`;
  const out = obsidian([`vault=${vault}`, "eval", `code=${code}`]);
  if (/^(?:Error|Evaluation error):/m.test(out)) throw new Error(out.trim());
  const t0 = Date.now();
  while (!existsSync(marker)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`eval ${evalN} in ${vault} timed out`);
    await sleep(50);
  }
  const r = JSON.parse(await readFile(marker, "utf8")) as {
    ok: boolean;
    result?: unknown;
    error?: string;
  };
  await rm(marker, { force: true });
  if (!r.ok) throw new Error(`in ${vault}: ${r.error}`);
  return r.result;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const commit = execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["-C", REPO, "status", "--short", "--untracked-files=no"], {
      encoding: "utf8",
    }).trim() !== "";
  buildClient();
  const binary = await serverBinary();
  report["facts"] = {
    commit: commit + (dirty ? " (with uncommitted changes)" : ""),
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    os: `${process.platform} ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()}`,
    bench: `bun ${process.versions["bun"] ?? "?"}`,
    cli: `node ${execFileSync("node", ["--version"], { encoding: "utf8" }).trim()}`,
    server: execFileSync(binary, ["version"], { encoding: "utf8" }).trim().split("\n")[0],
    go: execFileSync("go", ["version"], { encoding: "utf8" }).trim(),
    files: FILES,
    seed: SEED,
  };
  say(`TrewSync at ${FILES.toLocaleString()} files: ${JSON.stringify(report["facts"])}`);

  const root = await mkdtemp(join(tmpdir(), "trew-10k-"));
  const data = join(root, "server");
  const dirA = join(root, "mac-a");
  const dirB = join(root, "mac-b");
  const dirW = join(root, "witness");
  for (const d of [data, dirA, dirB, dirW]) await mkdir(d, { recursive: true });
  const server = new Trewd(binary, data);
  const sampler = new Sampler(() => server.proc?.pid);
  const a = new Live(dirA);
  const b = new Live(dirB);
  const phase = (name: string, t0: number, t1: number, extra: Record<string, unknown> = {}) => {
    const w = sampler.window(t0, t1);
    const row = { ms: ms(t1 - t0), serverCpuS: w.cpuS, serverPeakRssMiB: w.peakRssMiB, ...extra };
    (report["phases"] as Record<string, unknown>)[name] = row;
    say(`  ${name}: ${JSON.stringify(row)}`);
    return row;
  };
  report["phases"] = {};

  try {
    // The corpus, and what every device must end up holding.
    const corpus = makeCorpus({ seed: SEED, files: FILES });
    const t0 = performance.now();
    const bytes = await writeCorpus(dirA, corpus);
    const expected = new Map<string, string>();
    corpus.files.forEach((f, i) => expected.set(f.path, sha(corpus.bytes(i))));
    report["corpus"] = {
      files: corpus.files.length,
      notes: corpus.files.filter((f) => f.kind === "note").length,
      attachments: corpus.files.filter((f) => f.kind === "attachment").length,
      canvases: corpus.files.filter((f) => f.kind === "canvas").length,
      folders: new Set(corpus.files.map((f) => dirname(f.path))).size,
      MiB: Math.round((bytes / 1048576) * 10) / 10,
      writtenMs: ms(performance.now() - t0),
    };
    say(`corpus: ${JSON.stringify(report["corpus"])}`);

    const port = 20000 + Math.floor(Math.random() * 20000);
    await server.start(port);
    sampler.start();
    await sleep(500);
    report["serverIdle"] = sampler.window(0, performance.now());

    // 1. First upload, from the shipped command.
    say("first upload (trew pair, then trew sync, on the full vault)");
    const first = (await readFile(join(data, "first-invite"), "utf8"))
      .split("\n")
      .find((l) => l.trim() !== "")!
      .trim();
    let t = performance.now();
    const pairA = await trew(dirA, "pair", first, "--device", "mac-a");
    check(pairA.code === 0, `trew pair on A exited ${pairA.code}: ${pairA.out.slice(-400)}`);
    const pairedA = performance.now();
    const upA = await trew(dirA, "sync");
    check(upA.code === 0, `the first sync on A exited ${upA.code}: ${upA.out.slice(-400)}`);
    phase("first upload", t, performance.now(), {
      pairMs: ms(pairedA - t),
      syncMs: ms(upA.ms),
      cliSays: upA.out.trim().split("\n").slice(-2).join(" / "),
    });
    report["diskAfterUpload"] = await du(data);
    say(`  server disk: ${JSON.stringify(report["diskAfterUpload"])}`);
    check(
      diff(expected, await inventory(dirA)).length === 0,
      "A changed its own files during its upload",
    );

    // 2. The search index, caught up with the upload, then rebuilt from nothing.
    const head = await (async () => {
      const l = new Live(dirA);
      const c = await l.open(false);
      await c.settle({}, 0);
      const h = c.serverCursor;
      await l.close();
      return h;
    })();
    const searchDb = join(data, "search.db");
    const indexed = async (): Promise<{ through: number; notes: number } | undefined> => {
      if (!existsSync(searchDb)) return undefined;
      const { stdout } = await run("sqlite3", [
        `file:${searchDb}?mode=ro`,
        "SELECT through, notes FROM generations WHERE state='active' ORDER BY gen DESC LIMIT 1",
      ]).catch(() => ({ stdout: "" }));
      const [through, notes] = stdout.trim().split("|").map(Number);
      return stdout.trim() === "" ? undefined : { through: through!, notes: notes! };
    };
    t = performance.now();
    const lag = await waitFor(
      "the index to catch up with the upload",
      async () => ((await indexed())?.through ?? 0) >= head,
      900_000,
      100,
    );
    report["indexCatchUpAfterUploadMs"] = ms(lag);
    say(
      `  index at head ${head} ${ms(lag)} ms after the upload finished: ${JSON.stringify(await indexed())}`,
    );
    await server.stop();
    for (const f of await readdir(data)) if (f.startsWith("search.db")) await rm(join(data, f));
    t = performance.now();
    await server.start(port);
    const started = performance.now();
    const built = await waitFor(
      "the index to rebuild",
      async () => ((await indexed())?.through ?? 0) >= head,
      900_000,
      100,
    );
    phase("search index rebuild from nothing", t, performance.now(), {
      serverStartMs: ms(started - t),
      buildMs: ms(built),
      index: await indexed(),
    });
    report["diskAfterIndex"] = await du(data);

    // 3. Search over MCP.
    say("search_notes over MCP");
    const tokenFile = join(root, "mcp-token");
    server.cli("mcp-token", "-label", "bench", "-key-out", tokenFile);
    const mcp = new Mcp(`http://127.0.0.1:${port}/mcp`, (await readFile(tokenFile, "utf8")).trim());
    await mcp.init();
    const facts = corpus.facts();
    const searches: Record<string, unknown> = {};
    const timeSearch = async (
      label: string,
      args: Record<string, unknown>,
      verify?: (first: Record<string, unknown>) => void,
    ) => {
      const first = await mcp.tool("search_notes", args);
      verify?.(first);
      const times: number[] = [];
      for (let k = 0; k < 20; k++) {
        await mcp.tool("search_notes", args);
        times.push(mcp.lastMs);
      }
      const trusted = (first["trusted"] ?? {}) as {
        index?: unknown;
        scanned?: number;
        complete?: boolean;
      };
      searches[label] = {
        p50Ms: ms(median(times)),
        p95Ms: ms(pct(times, 95)),
        notesOnFirstPage: matchPaths(first).length,
        scanned: trusted.scanned,
        complete: trusted.complete,
        index: trusted.index,
      };
      say(`  ${label}: ${JSON.stringify(searches[label])}`);
      return first;
    };
    const needle = await timeSearch("content, one match (needle)", { query: facts.needle.text });
    check(
      JSON.stringify(matchPaths(needle)) === JSON.stringify([facts.needle.path]),
      `the needle search found ${JSON.stringify(matchPaths(needle))}, not ${facts.needle.path}`,
    );
    await timeSearch("content, common word, first page of 50", { query: facts.common });
    await timeSearch("content, common word, case-sensitive", {
      query: facts.common,
      caseSensitive: true,
    });
    await timeSearch("filename", { query: facts.nameFragment, mode: "filename" });
    await timeSearch("tag, exact", { query: "recipe", mode: "tag", includeChildren: false });
    await timeSearch("tag with children", { query: "project", mode: "tag" });
    // A whole result set, every page, against the corpus's own count.
    const pageAll = async (args: Record<string, unknown>) => {
      const paths = new Set<string>();
      let cursor: string | undefined;
      let spent = 0;
      let pages = 0;
      do {
        const page = await mcp.tool("search_notes", {
          ...args,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        spent += mcp.lastMs;
        for (const p of matchPaths(page)) paths.add(p);
        cursor = nextCursor(page);
        pages++;
      } while (cursor);
      return { paths, ms: spent, pages };
    };
    const recipe = await pageAll({ query: "recipe", mode: "tag", includeChildren: false });
    searches["tag recipe, every page"] = {
      ms: ms(recipe.ms),
      pages: recipe.pages,
      notes: recipe.paths.size,
      corpusSays: facts.tagged.get("recipe"),
    };
    say(`  tag recipe, every page: ${JSON.stringify(searches["tag recipe, every page"])}`);
    check(
      recipe.paths.size === facts.tagged.get("recipe"),
      `tag search found ${recipe.paths.size} notes tagged recipe, the corpus has ${facts.tagged.get("recipe")}`,
    );
    const names = await pageAll({ query: facts.nameFragment, mode: "filename" });
    const expectNames = corpus.files.filter(
      (f) =>
        /\.(md|txt)$/i.test(f.path) &&
        f.path
          .slice(f.path.lastIndexOf("/") + 1)
          .toLowerCase()
          .includes(facts.nameFragment.toLowerCase()),
    ).length;
    searches["filename, every page"] = {
      ms: ms(names.ms),
      pages: names.pages,
      notes: names.paths.size,
      corpusSays: expectNames,
    };
    say(`  filename, every page: ${JSON.stringify(searches["filename, every page"])}`);
    report["search"] = searches;

    // 4. verify -deep, against the live server.
    t = performance.now();
    const verified = server.cli("verify", "-deep").trim();
    phase("verify -deep", t, performance.now(), { says: verified });

    // 5. A fresh device's first download, through the shipped command.
    say("fresh headless device, first download");
    t = performance.now();
    const pairB = await trew(dirB, "pair", server.invite(), "--device", "mac-b");
    check(pairB.code === 0, `trew pair on B exited ${pairB.code}: ${pairB.out.slice(-400)}`);
    const pairedB = performance.now();
    const downB = await trew(dirB, "sync");
    check(downB.code === 0, `the first sync on B exited ${downB.code}: ${downB.out.slice(-400)}`);
    phase("first download (headless)", t, performance.now(), {
      pairMs: ms(pairedB - t),
      syncMs: ms(downB.ms),
      cliSays: downB.out.trim().split("\n").slice(-2).join(" / "),
    });
    const invB = await inventory(dirB);
    const d1 = diff(expected, invB);
    check(d1.length === 0, `B after its first download: ${d1.join("; ")}`);

    // 6. Steady state: nothing changed.
    say("steady passes, nothing changed");
    const steadyCli: number[] = [];
    for (let k = 0; k < 3; k++) steadyCli.push((await trew(dirA, "sync")).ms);
    await a.open(false);
    const steady: number[] = [];
    await a.c!.settle();
    for (let k = 0; k < REPEATS; k++) {
      const s = performance.now();
      const r = await a.c!.settle({}, 0);
      steady.push(performance.now() - s);
      check(r.uploaded + r.downloaded === 0, "a steady pass moved something");
    }
    const tq = performance.now();
    await a.c!.settle({}, 0);
    report["steady"] = {
      inProcessPassP50Ms: ms(median(steady)),
      inProcessPassMinMs: ms(Math.min(...steady)),
      cliSyncWallP50Ms: ms(median(steadyCli)),
      serverCpuSDuringOnePass: sampler.window(tq - 1, performance.now() + 300).cpuS,
    };
    say(`  ${JSON.stringify(report["steady"])}`);
    await a.close();

    // 7. One edit's latency between two watching devices.
    say("one edit, A saves to B verified");
    const editable = editableNotes(corpus);
    let cursor = 0;
    const nextNote = () => editable[cursor++ % editable.length]!;
    await a.open(true);
    await b.open(true);
    await converge([a.c!, b.c!]);
    a.watch();
    b.watch();
    await sleep(1500);
    const lat: number[] = [];
    for (let k = 0; k < LATENCY_SAMPLES; k++) {
      const p = nextNote();
      const text =
        (await readFile(join(dirA, p), "utf8")) + `\nlatency sample ${k} ${Date.now()}\n`;
      const s = performance.now();
      await writeFile(join(dirA, p), text);
      await waitFor(
        `sample ${k} at B`,
        async () => (await readMaybe(join(dirB, p))) === text,
        120_000,
        2,
      );
      lat.push(performance.now() - s);
      await sleep(300);
    }
    report["editLatency"] = {
      p50Ms: ms(median(lat)),
      p95Ms: ms(pct(lat, 95)),
      minMs: ms(Math.min(...lat)),
      samples: lat.length,
      note: "watching headless clients, production write coalescing",
    };
    say(`  ${JSON.stringify(report["editLatency"])}`);

    // 8a. 200 edits at once while both watch, 100 on each device, distinct notes.
    say("200 edits at once, both devices watching");
    const burst: { dir: string; other: string; path: string; text: string }[] = [];
    for (let k = 0; k < 200; k++) {
      const p = nextNote();
      const [dir, other] = k % 2 === 0 ? [dirA, dirB] : [dirB, dirA];
      burst.push({
        dir,
        other,
        path: p,
        text:
          (await readFile(join(dir, p), "utf8")) +
          `\nburst edit ${k} from ${dir === dirA ? "A" : "B"}\n`,
      });
    }
    t = performance.now();
    await Promise.all(burst.map((e) => writeFile(join(e.dir, e.path), e.text)));
    await waitFor(
      "every burst edit on the other device",
      async () => {
        for (const e of burst)
          if ((await readMaybe(join(e.other, e.path))) !== e.text) return false;
        return true;
      },
      600_000,
      100,
    );
    phase("200 concurrent edits, both watching", t, performance.now());
    for (const e of burst)
      check(
        (await readMaybe(join(e.dir, e.path))) === e.text,
        `burst edit to ${e.path} changed on its own device`,
      );

    // 8b. 200 edits made on two devices while neither could see the other,
    // 40 of them to the same 40 notes, then both reconnecting at once.
    say("200 edits on two disconnected devices, 40 notes edited on both");
    await a.close();
    await b.close();
    const overlaps: Overlap[] = [];
    const solo: { dir: string; path: string; text: string }[] = [];
    for (let k = 0; k < 40; k++) {
      const p = nextNote();
      const base = await readFile(join(dirA, p), "utf8");
      const lineA = `concurrent edit ${k} made on A`;
      const lineB = `concurrent edit ${k} made on B`;
      // Half in different places, which a merge can hold both of. Half
      // rewriting the same line two ways, which it cannot, so a conflict copy
      // must hold one side.
      const heading = base.split("\n").findIndex((l) => l.startsWith("# "));
      const rewrite = (line: string) =>
        base
          .split("\n")
          .map((l, n) => (n === heading ? `# ${line}` : l))
          .join("\n");
      const [ta, tb] =
        k % 2 === 0
          ? [`${base}\n${lineA}\n`, `${lineB}\n${base}`]
          : [rewrite(lineA), rewrite(lineB)];
      overlaps.push({ path: p, a: ta, b: tb, lineA, lineB });
    }
    for (let k = 0; k < 120; k++) {
      const p = nextNote();
      const dir = k % 2 === 0 ? dirA : dirB;
      solo.push({
        dir,
        path: p,
        text: (await readFile(join(dir, p), "utf8")) + `\noffline solo edit ${k}\n`,
      });
    }
    await Promise.all([
      ...overlaps.flatMap((o) => [
        writeFile(join(dirA, o.path), o.a),
        writeFile(join(dirB, o.path), o.b),
      ]),
      ...solo.map((e) => writeFile(join(e.dir, e.path), e.text)),
    ]);
    t = performance.now();
    await Promise.all([a.open(true), b.open(true)]);
    const rounds = await converge([a.c!, b.c!]);
    const tc = performance.now();
    const [iA, iB] = [await inventory(dirA), await inventory(dirB)];
    const dAB = diff(iA, iB);
    check(dAB.length === 0, `A and B disagree after the concurrent edits: ${dAB.join("; ")}`);
    const outcome = { merged: 0, "kept both": 0, lost: 0 };
    for (const o of overlaps) {
      const r = await overlapSurvived(dirA, o, iA);
      outcome[r]++;
      check(r !== "lost", `an edit to ${o.path} was lost`);
    }
    for (const e of solo)
      check(
        (await readMaybe(join(dirA, e.path))) === e.text &&
          (await readMaybe(join(dirB, e.path))) === e.text,
        `the offline edit to ${e.path} did not arrive intact`,
      );
    const explained = new Set(overlaps.map((o) => o.path));
    const stray = unexplainedCopies(iA, explained);
    check(stray.length === 0, `conflict copies nobody made: ${stray.join(", ")}`);
    const copies = [...iA.keys()].filter((p) => conflictOriginal(p) !== undefined).length;
    phase("200 edits on two disconnected devices, reconnect", t, tc, {
      rounds,
      overlapping: overlaps.length,
      ...outcome,
      conflictCopies: copies,
    });

    // 9. B away for 500 edits on A, with 20 of its own, then catching up.
    say("B offline while A makes 500 edits");
    await b.close();
    a.watch();
    const aEdits: { path: string; text?: string; gone?: boolean }[] = [];
    const renamedFrom = new Map<string, string>();
    const deletedByA = new Set<string>();
    const touched = new Set<string>();
    // B's edits first chosen, so A can be made to edit, delete and rename some of the same notes.
    const bOverlap = Array.from({ length: 10 }, () => nextNote());
    const bOnDeleted = Array.from({ length: 3 }, () => nextNote());
    const bOnRenamed = Array.from({ length: 2 }, () => nextNote());
    const bSolo = Array.from({ length: 5 }, () => nextNote());
    t = performance.now();
    for (let k = 0; k < 500; k++) {
      if (k < 380) {
        const p = k < 10 ? bOverlap[k]! : nextNote();
        const text = (await readFile(join(dirA, p), "utf8")) + `\naway edit ${k} on A\n`;
        await writeFile(join(dirA, p), text);
        aEdits.push({ path: p, text });
        touched.add(p);
      } else if (k < 430) {
        const p = `Inbox/Neue Notiz ${k} über Café.md`;
        const text = `# New ${k}\n\nwritten on A while B was away.\n`;
        await mkdir(join(dirA, "Inbox"), { recursive: true });
        await writeFile(join(dirA, p), text);
        aEdits.push({ path: p, text });
      } else if (k < 470) {
        const p = k < 433 ? bOnDeleted[k - 430]! : nextNote();
        await rm(join(dirA, p));
        aEdits.push({ path: p, gone: true });
        deletedByA.add(p);
      } else {
        const p = k < 472 ? bOnRenamed[k - 470]! : nextNote();
        const to = p.replace(/\.md$/, ` (moved ${k}).md`);
        await rename(join(dirA, p), join(dirA, to));
        renamedFrom.set(to, p);
        aEdits.push({ path: p, gone: true });
        aEdits.push({ path: to, text: await readFile(join(dirA, to), "utf8") });
      }
      if (k % 50 === 49) await sleep(200);
    }
    await a.c!.settle({ coalesceWrites: false });
    const madeA = performance.now();
    const bLines: { path: string; line: string }[] = [];
    for (const [k, p] of [...bOverlap, ...bOnDeleted, ...bOnRenamed, ...bSolo].entries()) {
      const line = `B's own offline edit ${k}`;
      const base = await readFile(join(dirB, p), "utf8");
      await writeFile(join(dirB, p), `${line}\n${base}`);
      bLines.push({ path: p, line });
    }
    phase("500 edits on A while B is away", t, madeA);
    t = performance.now();
    await b.open(true);
    await b.c!.settle({ coalesceWrites: false });
    const caughtUp = performance.now();
    const roundsAway = await converge([a.c!, b.c!]);
    const settledAll = performance.now();
    const [jA, jB] = [await inventory(dirA), await inventory(dirB)];
    const dAway = diff(jA, jB);
    check(dAway.length === 0, `A and B disagree after B caught up: ${dAway.join("; ")}`);
    // Every edit A made while B was away, where A left it, unless B's own edit
    // of the same note was merged into it.
    const bPaths = new Set(bLines.map((l) => l.path));
    for (const e of aEdits) {
      if (e.gone) continue;
      const now = await readMaybe(join(dirB, e.path));
      if (bPaths.has(e.path) || bPaths.has(renamedFrom.get(e.path) ?? "")) {
        const lastLine = e.text!.trimEnd().split("\n").pop()!;
        check(now !== undefined && now.includes(lastLine), `A's away edit to ${e.path} is gone`);
      } else check(now === e.text, `A's away edit to ${e.path} did not arrive intact at B`);
    }
    // What A deleted or moved away is gone from B too, unless B had edited it.
    for (const p of [...deletedByA, ...renamedFrom.values()]) {
      if (!bPaths.has(p)) check(!jB.has(p), `${p}, removed on A while B was away, is still at B`);
    }
    // Every line B wrote while away, somewhere in the vault.
    const everything = await Promise.all([...jB.keys()].map((p) => readMaybe(join(dirB, p))));
    for (const l of bLines)
      check(
        everything.some((txt) => txt?.includes(l.line) ?? false),
        `B's offline edit to ${l.path} is gone`,
      );
    // Deleted notes B edited must come back, not stay deleted.
    for (const p of bOnDeleted)
      check(
        everything.some((txt) => txt?.includes(bLines.find((l) => l.path === p)!.line) ?? false),
        `B's edit to ${p}, deleted on A, is gone`,
      );
    const explainedAway = new Set([...explained, ...bPaths, ...[...renamedFrom.keys()]]);
    const strayAway = unexplainedCopies(jB, explainedAway);
    check(
      strayAway.length === 0,
      `conflict copies nobody made after the catch-up: ${strayAway.join(", ")}`,
    );
    phase("B catches up on 500 edits", t, caughtUp, {
      untilBothSettledMs: ms(settledAll - t),
      rounds: roundsAway,
      conflictCopies: [...jB.keys()].filter((p) => conflictOriginal(p) !== undefined).length,
      deletedOnAButEditedOnB: bOnDeleted.map((p) =>
        jB.has(p) ? "kept at its path" : "kept elsewhere",
      ),
    });
    await a.close();
    await b.close();

    // 10. A witness from nothing holds exactly what both devices hold.
    say("witness: a third device from nothing");
    t = performance.now();
    const pairW = await trew(dirW, "pair", server.invite(), "--device", "witness");
    const downW = await trew(dirW, "sync");
    check(
      pairW.code === 0 && downW.code === 0,
      `the witness exited ${pairW.code}/${downW.code}: ${downW.out.slice(-300)}`,
    );
    const jW = await inventory(dirW);
    const dW = diff(jA, jW);
    check(dW.length === 0, `the witness differs from A: ${dW.join("; ")}`);
    phase("witness first download", t, performance.now(), {
      files: jW.size,
      identicalToA: dW.length === 0,
    });

    // 11. The real plugin in a fresh scratch vault.
    if (OBSIDIAN) await obsidianRun(server, dirA, jA, root, phase);

    t = performance.now();
    const v2 = server.cli("verify", "-deep").trim();
    phase("verify -deep after the run", t, performance.now(), { says: v2 });
    check(/, 0 faults$/.test(v2), `verify -deep: ${v2}`);
    report["diskAtEnd"] = await du(data);
    const all = sampler.samples;
    report["serverPeakRssMiB"] =
      Math.round((Math.max(...all.map((s) => s.rssKb)) / 1024) * 10) / 10;
    report["serverCpuSTotal"] = Math.round((all[all.length - 1]!.cpuS - all[0]!.cpuS) * 100) / 100;
  } finally {
    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    sampler.stop();
    await server.stop();
    report["failures"] = failures;
    await writeFile(OUT, JSON.stringify(report, null, 2));
    say(`\nreport in ${OUT}`);
    if (!KEEP) await rm(root, { recursive: true, force: true });
    else say(`kept ${root}`);
  }
  if (failures.length > 0) {
    say(`\n${failures.length} checks FAILED`);
    process.exitCode = 1;
  } else say("\nevery check passed");
}

/**
 * The plugin: a new vault folder, opened through Obsidian's IPC from the
 * scratch vault, paired, downloading ten thousand files, then timed passes and
 * one edit each way.
 */
async function obsidianRun(
  server: Trewd,
  dirA: string,
  want: Map<string, string>,
  root: string,
  phase: (name: string, t0: number, t1: number, extra?: Record<string, unknown>) => unknown,
): Promise<void> {
  const name = `trew-10k-${Date.now().toString(36)}`;
  const vault = join(homedir(), name);
  if (existsSync(vault)) throw new Error(`${vault} exists; refusing to reuse it`);
  const FORBIDDEN = ["My Vault", "basalt-live-vault", ...LOCAL_REFUSALS];
  if (FORBIDDEN.includes(name)) throw new Error("refusing a real vault");
  const markers = join(root, "obsidian-evals");
  await mkdir(markers, { recursive: true });
  // Prepared while Obsidian has never seen it: the plugin and nothing else.
  const plugins = join(vault, ".obsidian/plugins/trew-sync");
  await mkdir(plugins, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"])
    await copyFile(join(PLUGIN_DIST, f), join(plugins, f));
  await writeFile(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["trew-sync"]));
  (report["obsidian"] as unknown) = { vault, version: obsidian(["version"]).trim() };
  say(`obsidian: fresh vault ${vault}`);
  try {
    await inVault(
      "telimus-scratch-vault",
      `require("electron").ipcRenderer.sendSync("vault-open", ${JSON.stringify(vault)}, false); return true;`,
      markers,
    );
    await waitFor(
      "the vault to answer",
      async () => (await inVault(name, "return app.vault.getName();", markers, 10_000)) === name,
      120_000,
      1000,
    );
    await inVault(
      name,
      `
      if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
      if (!app.plugins.plugins["trew-sync"]) await app.plugins.enablePluginAndSave("trew-sync");
      return !!app.plugins.plugins["trew-sync"];`,
      markers,
    );
    await waitFor(
      "the plugin to load",
      async () =>
        (await inVault(name, `return !!app.plugins.plugins["trew-sync"];`, markers)) === true,
      60_000,
      1000,
    );
    const invite = server.invite();
    const t = performance.now();
    // Pairing starts the first sync; the call returns once paired.
    await inVault(
      name,
      `await plugin.pair(${JSON.stringify(invite)}, "Obsidian 10k", false); return plugin.paired;`,
      markers,
      600_000,
    );
    const paired = performance.now();
    await waitFor(
      "every file in the Obsidian vault",
      async () => {
        const inv = await inventory(vault);
        return inv.size >= want.size && diff(want, inv).length === 0;
      },
      1_800_000,
      2000,
    );
    const landed = performance.now();
    await waitFor(
      "the plugin to report synced",
      async () => {
        const s = (await inVault(name, `return plugin.currentState;`, markers)) as {
          kind?: string;
        };
        return s?.kind === "synced";
      },
      600_000,
      1000,
    );
    const d = diff(want, await inventory(vault));
    check(d.length === 0, `the Obsidian vault after its first download: ${d.join("; ")}`);
    phase("first download (Obsidian plugin)", t, performance.now(), {
      pairMs: ms(paired - t),
      untilEveryFileMs: ms(landed - t),
    });

    // Steady passes inside the app, timed there.
    const passes = (await inVault(
      name,
      `
      const out = [];
      for (let k = 0; k < ${REPEATS}; k++) { const s = performance.now(); await plugin.syncNow(); out.push(performance.now() - s); }
      return out;`,
      markers,
      600_000,
    )) as number[];
    (report["obsidian"] as Record<string, unknown>)["steadySyncNowP50Ms"] = ms(median(passes));
    (report["obsidian"] as Record<string, unknown>)["steadySyncNowMinMs"] = ms(Math.min(...passes));
    say(`  steady syncNow: p50 ${ms(median(passes))} ms`);

    // One edit from the headless device into the app, and one back.
    const target = [...want.keys()].find(
      (p) => p.endsWith(".md") && !p.includes("Conflicted copy"),
    )!;
    const l = new Live(dirA);
    await l.open(true);
    l.watch();
    const inbound: number[] = [];
    const outbound: number[] = [];
    for (let k = 0; k < 5; k++) {
      const text = (await readFile(join(dirA, target), "utf8")) + `\nto obsidian ${k}\n`;
      const s = performance.now();
      await writeFile(join(dirA, target), text);
      await waitFor(
        "the edit in Obsidian",
        async () => (await readMaybe(join(vault, target))) === text,
        180_000,
        5,
      );
      inbound.push(performance.now() - s);
      await sleep(500);
      const back = text + `from obsidian ${k}\n`;
      const s2 = performance.now();
      await inVault(
        name,
        `const f=app.vault.getAbstractFileByPath(${JSON.stringify(target)}); await app.vault.modify(f, ${JSON.stringify(back)}); return true;`,
        markers,
      );
      await waitFor(
        "the edit back at A",
        async () => (await readMaybe(join(dirA, target))) === back,
        180_000,
        5,
      );
      outbound.push(performance.now() - s2);
      await sleep(500);
    }
    await l.close();
    // What one eval through the obsidian CLI costs on its own, since the
    // outbound figure starts before one and includes it.
    const rtt: number[] = [];
    for (let k = 0; k < 3; k++) {
      const s = performance.now();
      await inVault(name, "return 1;", markers);
      rtt.push(performance.now() - s);
    }
    Object.assign(report["obsidian"] as Record<string, unknown>, {
      headlessToObsidianP50Ms: ms(median(inbound)),
      obsidianToHeadlessP50Ms: ms(median(outbound)),
      cliEvalRoundTripP50Ms: ms(median(rtt)),
      note: "Obsidian to headless includes one obsidian CLI eval, whose own round trip is reported beside it",
    });
    say(
      `  edit latency: headless to Obsidian p50 ${ms(median(inbound))} ms, Obsidian to headless p50 ${ms(median(outbound))} ms`,
    );
  } finally {
    try {
      obsidian([
        `vault=${name}`,
        "eval",
        `code=require("electron").remote.getCurrentWindow().close()`,
      ]);
    } catch {
      /* closed already */
    }
  }
}

await main();
