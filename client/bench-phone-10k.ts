/**
 * Ten thousand notes on the phone, in one command.
 *
 *   bun run bench:phone             the real run, against the phone adb sees
 *   bun run bench:phone --dry-run   everything but the phone, which a stand-in plays
 *
 * docs/research.md records the last attempt: seeding took 543 seconds, the
 * phone dozed partway through its first reconcile, and after thirty minutes
 * nothing was known. This does the whole of that run again with the
 * confounds held off, and adds what the owner's goal needs on top: a steady
 * pass, a device away for 500 edits catching up, and a conflict made on the
 * phone and the Mac at once, each checked for exact bytes afterwards.
 *
 * What it does, in order:
 *
 *  1. Holds the phone awake: `svc power stayon usb`, a wake key, and Doze
 *     turned off with `dumpsys deviceidle disable`, every one undone at the
 *     end. Wakefulness and the focused window are read every thirty seconds
 *     throughout, and any moment the phone was not awake with Obsidian in
 *     front is written into the report, because a number taken while it was
 *     is not a number about TrewSync.
 *  2. Starts a disposable `trewd serve -mcp -localhost` here, reached from the
 *     phone over `adb reverse` on its own loopback. The live server is never
 *     named.
 *  3. Builds the corpus (`src/stress/corpus.ts`, 10,000 files by default) and
 *     uploads it from a headless device on this Mac.
 *  4. Seeds the phone's test vault with the same bytes while Obsidian is
 *     stopped: one tar, pushed and unpacked on the device.
 *  5. Brings Obsidian forward on that vault, enables the plugin and pairs it
 *     through the WebView's DevTools socket (plan/handoff/phone-eval.mjs is
 *     the same mechanism), then times the first reconcile until the server
 *     says the phone has applied everything and the plugin says synced, and
 *     checks every file's SHA-256 on the phone.
 *  6. Times steady passes inside the app, and one edit each way.
 *  7. Pauses sync on the phone (the plugin's own command, which closes its
 *     connection), makes 500 edits on the Mac and five on the phone, one of
 *     them rewriting the same line of the same note the Mac rewrote, resumes,
 *     and times the catch-up. Then checks both devices hold the same bytes,
 *     both sides of the conflict survived, and every conflict copy is one this
 *     run made.
 *  8. Writes the report as JSON and a short text summary.
 *
 * ## What it will not touch
 *
 * One vault on the phone, `/sdcard/Documents/$PHONE_VAULT` (TrewBench10k by
 * default), and nothing else. Every adb argument naming a path on the device
 * must sit under it, vault names that are somebody's notes are refused before
 * anything runs, and every DevTools evaluation checks the open vault's name
 * before it does anything. Those checks run identically in the dry run.
 *
 * ## The one thing a person does
 *
 * Obsidian's vault switcher is not reachable over adb. The first time, open
 * the folder as a vault once (vault switcher, "Open folder as vault", pick
 * Documents/TrewBench10k); every later run opens it with `obsidian://open`.
 * The script waits, and says so, until the WebView reports that vault.
 *
 * Environment: PHONE_VAULT, PHONE_FILES (10000), PHONE_SEED (1),
 * PHONE_SETTLE_MS (first reconcile limit, 3600000), PHONE_REPEATS (7),
 * PHONE_OUT (report path), ANDROID_SERIAL (which device, as adb reads it).
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client, credentialsFor, pairWithInvite } from "./src/core/client.ts";
import { conflictOriginal } from "./src/core/conflicts.ts";
import { parseInvite, startPairing } from "./src/core/pairing.ts";
import { serverBinary } from "./src/core/test-server.ts";
import { configPath, indexPath, saveConfig } from "./src/node/config.ts";
import { JsonIndexStore, NodeVault } from "./src/node/vault.ts";
import { makeCorpus } from "./src/stress/corpus.ts";
import {
  diff,
  editableNotes,
  inventory,
  Live,
  median,
  ms,
  readMaybe,
  run,
  sha,
  sleep,
  trew,
  Trewd,
  unexplainedCopies,
  waitFor,
  writeCorpus,
} from "./bench-support.ts";

const DRY = process.argv.includes("--dry-run") || process.env["PHONE_DRY_RUN"] === "1";
const VAULT = process.env["PHONE_VAULT"] ?? "TrewBench10k";
const VAULT_DIR = `/sdcard/Documents/${VAULT}`;
const PLUGIN_DIR = `${VAULT_DIR}/.obsidian/plugins/trew-sync`;
const FILES = Number(process.env["PHONE_FILES"] ?? 10_000);
const SEED = Number(process.env["PHONE_SEED"] ?? 1);
const SETTLE_MS = Number(process.env["PHONE_SETTLE_MS"] ?? 60 * 60_000);
const REPEATS = Number(process.env["PHONE_REPEATS"] ?? 7);
const OUT = process.env["PHONE_OUT"] ?? `bench-phone-${FILES}${DRY ? "-dry-run" : ""}.json`;
const DEVTOOLS_PORT = 9333;
const PLUGIN_DIST = new URL("./dist/plugin/", import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;

/**
 * Vaults that are somebody's notes, refused by name before anything runs, and
 * words no adb argument may contain. A list rather than a convention, because
 * being wrong costs somebody's notes.
 */
const FORBIDDEN_VAULTS = ["My Vault", "Test", "Trew M3"];
const FORBIDDEN_WORDS = ["My Vault", "homelab", "example", "/Documents/Test"];

export function refuseVault(name: string): void {
  if (FORBIDDEN_VAULTS.some((v) => v.toLowerCase() === name.toLowerCase()))
    throw new Error(`refusing to use the phone vault ${JSON.stringify(name)}: it holds real notes`);
  if (name === "" || name.includes("/") || name.startsWith("."))
    throw new Error(`refusing the vault name ${JSON.stringify(name)}`);
}

/** Refuses an adb command that names anything outside the bench vault. */
export function guard(parts: readonly string[], vaultDir = VAULT_DIR): void {
  const whole = parts.join(" ");
  for (const w of FORBIDDEN_WORDS) {
    if (whole.includes(w)) throw new Error(`refusing an adb command that names ${w}: ${whole}`);
  }
  for (const p of parts) {
    if (p.includes("/sdcard") && !(p === vaultDir || p.startsWith(`${vaultDir}/`)))
      throw new Error(`refusing an adb command outside ${vaultDir}: ${p}`);
    if (p.includes("..")) throw new Error(`refusing a path with .. in it: ${p}`);
  }
  if (parts[0] === "rm") {
    for (const p of parts.slice(1)) {
      if (p.startsWith("-")) continue;
      if (p === vaultDir || !p.startsWith(`${vaultDir}/`))
        throw new Error(`refusing to remove ${p}: only things inside ${vaultDir}`);
    }
  }
}

/** One argument for the phone's own shell, which `adb shell` hands a joined string. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/* ------------------------------------------------------------------ *
 * The phone, real or played
 * ------------------------------------------------------------------ */

interface Phone {
  /** A command run by the phone's shell, every part quoted. */
  shell(...parts: string[]): Promise<string>;
  /** An adb command that is not a shell: push, reverse, forward. */
  adb(...args: string[]): Promise<string>;
  /** An expression evaluated in Obsidian's WebView, awaited, returned by value. */
  evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
  readonly commands: string[];
}

class RealPhone implements Phone {
  readonly commands: string[] = [];
  async shell(...parts: string[]): Promise<string> {
    guard(parts);
    this.commands.push(`shell ${parts.join(" ")}`);
    const { stdout } = await run("adb", ["shell", parts.map(quote).join(" ")], {
      maxBuffer: 512 * 1024 * 1024,
    });
    return stdout;
  }
  async adb(...args: string[]): Promise<string> {
    guard(args);
    this.commands.push(args.join(" "));
    const { stdout } = await run("adb", args, { maxBuffer: 256 * 1024 * 1024, timeout: 3_600_000 });
    return stdout;
  }
  async evaluate(expression: string, timeoutMs = 120_000): Promise<unknown> {
    const targets = (await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page on the WebView's DevTools socket");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    try {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
      const reply = await Promise.race([
        new Promise<{
          result?: {
            result?: { value?: string };
            exceptionDetails?: { exception?: { description?: string } };
          };
        }>((resolve) => {
          ws.onmessage = (m) => {
            const d = JSON.parse(String(m.data));
            if (d.id === 1) resolve(d);
          };
        }),
        sleep(timeoutMs).then(() => {
          throw new Error(`an evaluation on the phone took longer than ${timeoutMs} ms`);
        }),
      ]);
      const ex = reply.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
      const v = reply.result?.result?.value;
      return v === undefined ? undefined : JSON.parse(v);
    } finally {
      ws.close();
    }
  }
}

/**
 * The phone, played by this machine, for `--dry-run`.
 *
 * A folder stands in for the vault on the device, adb's commands are carried
 * out on it, and the plugin is a headless client over it with the few members
 * the evaluations use. The guard runs before every command exactly as it does
 * for the real phone, and the evaluations are the same expression strings,
 * evaluated against a stand-in `app`. What it cannot tell you is anything about
 * a phone's speed: its numbers are this Mac's.
 */
class FakePhone implements Phone {
  readonly commands: string[] = [];
  running = false;
  vaultOpen = false;
  enabled = false;
  reversed = new Set<string>();
  readonly plugin: FakePlugin;
  constructor(readonly root: string) {
    this.plugin = new FakePlugin(root);
  }
  private local(p: string): string {
    if (p === VAULT_DIR) return this.root;
    if (p.startsWith(`${VAULT_DIR}/`)) return join(this.root, p.slice(VAULT_DIR.length + 1));
    throw new Error(`the stand-in has no ${p}`);
  }
  async shell(...parts: string[]): Promise<string> {
    guard(parts);
    this.commands.push(`shell ${parts.join(" ")}`);
    const [cmd, ...rest] = parts;
    switch (cmd) {
      case "getprop":
        return (
          { "ro.product.model": "stand-in (dry run)", "ro.build.version.release": "0" }[rest[0]!] ??
          ""
        );
      case "dumpsys":
        if (rest[0] === "package") return "    versionName=dry-run\n";
        if (rest[0] === "battery") return "  level: 100\n";
        if (rest[0] === "thermalservice") return "Thermal Status: 0\n";
        if (rest[0] === "power") return "  mWakefulness=Awake\n";
        if (rest[0] === "window")
          return this.running
            ? "  mCurrentFocus=Window{1 u0 md.obsidian/md.obsidian.MainActivity}\n"
            : "  mCurrentFocus=Window{1 u0 launcher}\n";
        return "";
      case "svc":
      case "input":
      case "touch":
        return "";
      case "pidof":
        return this.running ? "4242\n" : "";
      case "am":
        if (rest[0] === "force-stop") {
          this.running = false;
          this.vaultOpen = false;
          await this.plugin.stop();
        } else if (rest[0] === "start") {
          this.running = true;
          this.vaultOpen = rest.some((r) => r.includes(`vault=${encodeURIComponent(VAULT)}`));
          if (this.vaultOpen && this.enabled) await this.plugin.load();
        }
        return "";
      case "mkdir":
        await mkdir(this.local(rest[rest.length - 1]!), { recursive: true });
        return "";
      case "ls": {
        const at = this.local(rest[rest.length - 1]!);
        return (await readdir(at).catch(() => [] as string[])).join("\n") + "\n";
      }
      case "rm":
        for (const p of rest.filter((r) => !r.startsWith("-")))
          await rm(this.local(p), { recursive: true, force: true });
        return "";
      case "tar": {
        const file = this.local(rest[rest.indexOf("-xf") + 1]!);
        const into = this.local(rest[rest.indexOf("-C") + 1]!);
        await run("tar", ["-xf", file, "-C", into]);
        return "";
      }
      case "find": {
        const inv = await inventory(this.root);
        return [...inv].map(([p, h]) => `${h}  ${VAULT_DIR}/${p}`).join("\n") + "\n";
      }
      default:
        throw new Error(`the stand-in does not know the shell command ${cmd}`);
    }
  }
  async adb(...args: string[]): Promise<string> {
    guard(args);
    this.commands.push(args.join(" "));
    const [cmd, ...rest] = args;
    if (cmd === "devices") return "List of devices attached\nstand-in\tdevice\n";
    if (cmd === "push") {
      const to = this.local(rest[1]!);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(rest[0]!, to);
      return "";
    }
    if (cmd === "reverse") {
      if (rest[0] === "--remove") this.reversed.delete(rest[1]!);
      else this.reversed.add(rest[0]!);
      return "";
    }
    if (cmd === "forward") return "";
    throw new Error(`the stand-in does not know adb ${cmd}`);
  }
  async evaluate(expression: string): Promise<unknown> {
    if (!this.running) throw new Error("Obsidian is not running on the stand-in");
    const app = this.app();
    // The same string the WebView gets, with the stand-in's `app` in scope.
    const value = (await new Function("app", `return ${expression}`)(app)) as string | undefined;
    return value === undefined ? undefined : JSON.parse(value);
  }
  private app(): unknown {
    const phone = this;
    const plugin = this.plugin;
    return {
      vault: {
        getName: () => (phone.vaultOpen ? VAULT : "some other vault"),
        getAbstractFileByPath: (p: string) => ({ path: p }),
        modify: async (f: { path: string }, text: string) => {
          await writeFile(join(phone.root, f.path), text);
          plugin.changed(f.path);
        },
        adapter: { read: (p: string) => readFile(join(phone.root, p), "utf8") },
      },
      plugins: {
        plugins: phone.enabled ? { "trew-sync": plugin } : {},
        isEnabled: () => phone.enabled,
        setEnable: async () => {
          phone.enabled = true;
        },
        enablePluginAndSave: async () => {
          phone.enabled = true;
          await plugin.load();
        },
      },
      commands: {
        executeCommandById: (id: string) => {
          if (id === "trew-sync:pause-resume") void plugin.togglePause();
          return true;
        },
      },
    };
  }
}

/** The plugin's members the evaluations use, over a headless client. */
class FakePlugin {
  paired = false;
  paused = false;
  currentState: { kind: string } = { kind: "unpaired" };
  private client: Client | undefined;
  private loop: Promise<Error> | undefined;
  constructor(readonly root: string) {}
  async load(): Promise<void> {
    if (this.paired && !this.paused) await this.start();
  }
  async pair(invite: string, device: string): Promise<void> {
    const pending = startPairing(parseInvite(invite), device);
    await pairWithInvite(pending, {
      save: (c) => saveConfig(this.root, c),
      forget: () => rm(configPath(this.root), { force: true }),
    });
    this.paired = true;
    await this.start();
  }
  private async start(): Promise<void> {
    if (this.client) return;
    const config = JSON.parse(await readFile(configPath(this.root), "utf8"));
    const vault = new NodeVault(this.root);
    await vault.probeCase();
    this.client = new Client({
      vault,
      store: new JsonIndexStore(indexPath(this.root)),
      ...credentialsFor(config),
      timeoutMs: 600_000,
    });
    this.currentState = { kind: "syncing" };
    await this.client.connect();
    await this.client.settle();
    this.currentState = { kind: "synced" };
    this.loop = this.client.runUntilClosed(30_000);
  }
  async stop(): Promise<void> {
    await this.client?.close();
    await this.loop?.catch(() => undefined);
    this.client = undefined;
    this.loop = undefined;
  }
  changed(path: string): void {
    this.client?.noteChanged(path);
    void this.client?.sync();
  }
  async syncNow(): Promise<void> {
    await this.client?.settle();
  }
  async togglePause(): Promise<void> {
    if (this.paused) {
      this.paused = false;
      await this.start();
    } else {
      this.paused = true;
      await this.stop();
      this.currentState = { kind: "paused" };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Evaluations in Obsidian, guarded on the vault's name
 * ------------------------------------------------------------------ */

/** A body run in the WebView with `plugin` bound, refused unless the bench vault is open. */
export function expression(body: string, vault = VAULT): string {
  return `(async()=>{
  if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error("wrong vault: "+app.vault.getName());
  const plugin=app.plugins.plugins["trew-sync"];
  return JSON.stringify(await (async()=>{${body}\n})() ?? null);
})()`;
}
const probe = `(async()=>JSON.stringify(app.vault.getName()))()`;

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const report: Record<string, unknown> = { dryRun: DRY };
const failures: string[] = [];
const awake: { at: string; wakefulness: string; front: boolean }[] = [];
const say = (s: string) => console.log(s);
const check = (ok: boolean, what: string) => {
  if (!ok) {
    failures.push(what);
    say(`  FAILED: ${what}`);
  }
};

async function main(): Promise<void> {
  refuseVault(VAULT);
  const root = await mkdtemp(join(tmpdir(), "trew-phone-10k-"));
  const phone: Phone = DRY ? new FakePhone(join(root, "stand-in-vault")) : new RealPhone();
  if (DRY) await mkdir(join(root, "stand-in-vault"), { recursive: true });
  const binary = await serverBinary();
  const data = join(root, "server");
  const dirA = join(root, "mac");
  await mkdir(data, { recursive: true });
  await mkdir(dirA, { recursive: true });
  const server = new Trewd(binary, data);
  const mac = new Live(dirA);
  const port = 20000 + Math.floor(Math.random() * 20000);
  let watcher: ReturnType<typeof setInterval> | undefined;

  const facts = async () => ({
    commit: execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    host: `${cpus()[0]?.model}, ${cpus().length} cores`,
    server: execFileSync(binary, ["version"], { encoding: "utf8" }).trim().split("\n")[0],
    device: (await phone.shell("getprop", "ro.product.model")).trim(),
    android: (await phone.shell("getprop", "ro.build.version.release")).trim(),
    obsidian:
      /versionName=(\S+)/.exec(await phone.shell("dumpsys", "package", "md.obsidian"))?.[1] ??
      "unknown",
    battery: /level: (\d+)/.exec(await phone.shell("dumpsys", "battery"))?.[1] ?? "unknown",
    thermal:
      /Thermal Status: (\d+)/.exec(await phone.shell("dumpsys", "thermalservice"))?.[1] ??
      "unknown",
    vault: VAULT_DIR,
    files: FILES,
    seed: SEED,
  });

  /** Awake, with Obsidian in front, or the numbers are about a sleeping phone. */
  const readAwake = async () => {
    const power = await phone.shell("dumpsys", "power").catch(() => "");
    const window = await phone.shell("dumpsys", "window").catch(() => "");
    const row = {
      at: new Date().toISOString(),
      wakefulness: /mWakefulness=(\w+)/.exec(power)?.[1] ?? "unknown",
      front: /mCurrentFocus.*md\.obsidian/.test(window),
    };
    awake.push(row);
    return row;
  };
  const bringForward = async () => {
    await phone.shell("input", "keyevent", "KEYCODE_WAKEUP").catch(() => "");
    await phone.shell(
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `obsidian://open?vault=${encodeURIComponent(VAULT)}`,
    );
  };
  const devtools = async () => {
    const pid = (await phone.shell("pidof", "md.obsidian")).trim().split(/\s+/)[0];
    if (!pid) throw new Error("Obsidian is not running on the phone");
    await phone.adb(
      "forward",
      `tcp:${DEVTOOLS_PORT}`,
      `localabstract:webview_devtools_remote_${pid}`,
    );
  };
  const inApp = async (body: string, timeoutMs?: number) =>
    phone.evaluate(expression(body), timeoutMs);
  const phoneInventory = async () => {
    const out = await phone.shell("find", VAULT_DIR, "-type", "f", "-exec", "sha256sum", "{}", "+");
    const inv = new Map<string, string>();
    for (const line of out.split("\n")) {
      const m = /^([0-9a-f]{64})\s+(.*)$/.exec(line.trim());
      if (!m) continue;
      const rel = m[2]!.slice(VAULT_DIR.length + 1);
      if (rel.split("/").some((s) => s.startsWith("."))) continue;
      inv.set(rel.normalize("NFC"), m[1]!);
    }
    return inv;
  };

  try {
    const devices = await phone.adb("devices");
    const attached = devices
      .split("\n")
      .slice(1)
      .filter((l) => /\tdevice$/.test(l));
    if (attached.length !== 1 && !process.env["ANDROID_SERIAL"])
      throw new Error(
        `expected one phone on adb, found ${attached.length}; set ANDROID_SERIAL to choose`,
      );
    report["facts"] = await facts();
    say(
      `phone run${DRY ? " (DRY RUN: a stand-in plays the phone)" : ""}: ${JSON.stringify(report["facts"])}`,
    );

    // 1. Awake for the whole run.
    await phone.shell("svc", "power", "stayon", "usb").catch(() => "");
    await phone.shell("dumpsys", "deviceidle", "disable").catch(() => "");
    await phone.shell("input", "keyevent", "KEYCODE_WAKEUP").catch(() => "");
    watcher = setInterval(() => void readAwake(), 30_000);

    // 2. A disposable server, on the phone's loopback.
    await server.start(port);
    await phone.adb("reverse", `tcp:${port}`, `tcp:${port}`);

    // 3. The corpus, uploaded from this Mac.
    const corpus = makeCorpus({ seed: SEED, files: FILES });
    const expected = new Map<string, string>();
    corpus.files.forEach((f, i) => expected.set(f.path, sha(corpus.bytes(i))));
    await writeCorpus(dirA, corpus);
    const first = (await readFile(join(data, "first-invite"), "utf8"))
      .split("\n")
      .find((l) => l.trim() !== "")!
      .trim();
    check(
      (await trew(dirA, "pair", first, "--device", "mac")).code === 0,
      "pairing the Mac failed",
    );
    const up = await trew(dirA, "sync");
    check(up.code === 0, `the Mac's upload exited ${up.code}`);
    report["macUploadMs"] = ms(up.ms);
    say(`  the Mac uploaded ${FILES} files in ${ms(up.ms)} ms`);

    // 4. Seed the phone while Obsidian is stopped: the one moment its vault
    // has no watcher state to protect.
    say("seeding the phone (Obsidian stopped)");
    await phone.shell("am", "force-stop", "md.obsidian");
    await phone.shell("mkdir", "-p", PLUGIN_DIR);
    for (const entry of (await phone.shell("ls", "-A", VAULT_DIR))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (entry === ".obsidian") continue;
      await phone.shell("rm", "-rf", `${VAULT_DIR}/${entry}`);
    }
    for (const stale of ["data.json", "index.json", "index.log", "pass-timings.ndjson"])
      await phone.shell("rm", "-f", `${PLUGIN_DIR}/${stale}`);
    // Every top-level name: the folders, and the files at the vault root.
    const tops = [...new Set(corpus.files.map((f) => f.path.split("/")[0]!))];
    const archive = join(root, "corpus.tar");
    await run("tar", ["-cf", archive, "-C", dirA, ...tops], { maxBuffer: 1 << 30 });
    const seedAt = performance.now();
    await phone.adb("push", archive, `${VAULT_DIR}/corpus.tar`);
    const pushed = performance.now();
    await phone.shell("tar", "-xf", `${VAULT_DIR}/corpus.tar`, "-C", VAULT_DIR);
    await phone.shell("rm", "-f", `${VAULT_DIR}/corpus.tar`);
    report["seed"] = {
      pushMs: ms(pushed - seedAt),
      unpackMs: ms(performance.now() - pushed),
      archiveMiB: ms((await stat(archive)).size / 1048576),
    };
    for (const f of ["main.js", "manifest.json", "styles.css"])
      await phone.adb("push", join(PLUGIN_DIST, f), `${PLUGIN_DIR}/${f}`);
    const enabled = join(root, "community-plugins.json");
    await writeFile(enabled, JSON.stringify(["trew-sync"]));
    await phone.adb("push", enabled, `${VAULT_DIR}/.obsidian/community-plugins.json`);
    const seeded = await phoneInventory();
    const dSeed = diff(expected, seeded);
    check(dSeed.length === 0, `the phone after seeding: ${dSeed.join("; ")}`);
    say(`  seeded: ${JSON.stringify(report["seed"])}`);

    // 5. Obsidian on the vault, the plugin on, paired, and the first reconcile.
    say(`opening ${VAULT} in Obsidian`);
    await bringForward();
    let told = false;
    await waitFor(
      "Obsidian to open the bench vault",
      async () => {
        try {
          await devtools();
          if ((await phone.evaluate(probe, 10_000)) === VAULT) return true;
        } catch {
          /* not up yet */
        }
        if (!told) {
          told = true;
          say(
            `  waiting for Obsidian to show ${VAULT}. If it opened another vault, open the vault switcher,`,
          );
          say(
            `  "Open folder as vault", and pick Documents/${VAULT}. This is needed only the first time.`,
          );
        }
        await bringForward().catch(() => undefined);
        return false;
      },
      30 * 60_000,
      3000,
    );
    await inApp(`
      if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
      if (!app.plugins.plugins["trew-sync"]) await app.plugins.enablePluginAndSave("trew-sync");
      return true;`);
    await waitFor(
      "the plugin to load",
      async () => (await inApp(`return !!plugin;`)) === true,
      120_000,
      1000,
    );
    await mac.open(true);
    mac.watch();
    const invite = server.invite();
    say("pairing the phone, then timing its first reconcile");
    const t0 = performance.now();
    await inApp(`globalThis.__trewBench = {}; plugin.pair(${JSON.stringify(invite)}, "Phone 10k bench", true)
      .then(() => { globalThis.__trewBench.paired = true; }, (e) => { globalThis.__trewBench.error = String(e); });
      return true;`);
    const phoneRow = async () =>
      (await mac.c!.devices()).devices.find((d) => d.name === "Phone 10k bench");
    let lastLog = 0;
    await waitFor(
      "the phone to apply everything the server holds",
      async () => {
        const row = await phoneRow();
        const s = (await inApp(
          `return { state: plugin.currentState, bench: globalThis.__trewBench };`,
        ).catch(() => undefined)) as
          { state?: { kind?: string }; bench?: { error?: string } } | undefined;
        if (s?.bench?.error) throw new Error(`pairing failed on the phone: ${s.bench.error}`);
        if (performance.now() - lastLog > 60_000) {
          lastLog = performance.now();
          say(
            `  ${ms((performance.now() - t0) / 1000)} s: state ${s?.state?.kind}, applied ${row?.applied ?? "?"} of ${mac.c!.serverCursor}`,
          );
          await bringForward().catch(() => undefined);
        }
        return (
          row !== undefined &&
          (row.applied ?? -1) >= mac.c!.serverCursor &&
          s?.state?.kind === "synced"
        );
      },
      SETTLE_MS,
      2000,
    );
    report["firstReconcileMs"] = ms(performance.now() - t0);
    say(`  first reconcile: ${ms((performance.now() - t0) / 1000)} s`);
    const afterFirst = await phoneInventory();
    const dFirst = diff(expected, afterFirst);
    check(dFirst.length === 0, `the phone after its first reconcile: ${dFirst.join("; ")}`);

    // 6. Steady passes, timed inside the app, and one edit each way.
    const passes = (await inApp(
      `const out = [];
      for (let k = 0; k < ${REPEATS}; k++) { const s = performance.now(); await plugin.syncNow(); out.push(performance.now() - s); }
      return out;`,
      600_000,
    )) as number[];
    report["steadySyncNow"] = {
      p50Ms: ms(median(passes)),
      minMs: ms(Math.min(...passes)),
      samples: passes,
    };
    say(`  steady syncNow: ${JSON.stringify(report["steadySyncNow"])}`);
    const editable = editableNotes(corpus);
    let cursor = 0;
    const nextNote = () => editable[cursor++ % editable.length]!;
    const rtt: number[] = [];
    for (let k = 0; k < 3; k++) {
      const s = performance.now();
      await inApp("return 1;");
      rtt.push(performance.now() - s);
    }
    const toPhone: number[] = [];
    const fromPhone: number[] = [];
    for (let k = 0; k < 5; k++) {
      const p = nextNote();
      const text = (await readFile(join(dirA, p), "utf8")) + `\nto the phone ${k}\n`;
      const s = performance.now();
      await writeFile(join(dirA, p), text);
      await inApp(
        `const t0 = performance.now();
        // A read can fail for the instant the note is being replaced.
        while ((await app.vault.adapter.read(${JSON.stringify(p)}).catch(() => "")) !== ${JSON.stringify(text)}) {
          if (performance.now() - t0 > 120000) throw new Error("the edit did not arrive");
          await new Promise((r) => setTimeout(r, 20));
        }
        return true;`,
        180_000,
      );
      toPhone.push(performance.now() - s);
      const back = text + `from the phone ${k}\n`;
      const s2 = performance.now();
      await inApp(
        `const f = app.vault.getAbstractFileByPath(${JSON.stringify(p)}); await app.vault.modify(f, ${JSON.stringify(back)}); return true;`,
      );
      await waitFor(
        "the phone's edit on the Mac",
        async () => (await readMaybe(join(dirA, p))) === back,
        180_000,
        5,
      );
      fromPhone.push(performance.now() - s2);
    }
    report["editLatency"] = {
      macToPhoneP50Ms: ms(median(toPhone)),
      phoneToMacP50Ms: ms(median(fromPhone)),
      devtoolsRoundTripMs: ms(median(rtt)),
      note: "each includes one DevTools round trip, reported beside them",
    };
    say(`  edit latency: ${JSON.stringify(report["editLatency"])}`);

    // 7. The phone away for 500 edits on the Mac, five of its own, one conflict.
    say("pausing the phone; 500 edits on the Mac, five on the phone");
    await inApp(`app.commands.executeCommandById("trew-sync:pause-resume"); return true;`);
    await waitFor(
      "the phone to pause",
      async () =>
        ((await inApp(`return plugin.currentState;`)) as { kind?: string })?.kind === "paused",
      60_000,
      500,
    );
    const contested = nextNote();
    const base = await readFile(join(dirA, contested), "utf8");
    const heading = base.split("\n").findIndex((l) => l.startsWith("# "));
    const rewrite = (line: string) =>
      base
        .split("\n")
        .map((l, n) => (n === heading ? `# ${line}` : l))
        .join("\n");
    const onMac = rewrite("rewritten on the Mac while the phone was away");
    const onPhone = rewrite("rewritten on the phone while it was away");
    await writeFile(join(dirA, contested), onMac);
    const macEdits = new Map<string, string>([[contested, onMac]]);
    const removed: string[] = [];
    // Five hundred, or fewer on a corpus too small to give that many distinct
    // notes: a note edited twice here would be checked against the wrong text.
    const away = Math.max(20, Math.min(500, editable.length - cursor - 10));
    report["awayEdits"] = away;
    for (let k = 1; k < away; k++) {
      if (k < Math.floor(away * 0.94)) {
        const p = nextNote();
        const text = (await readFile(join(dirA, p), "utf8")) + `\naway edit ${k}\n`;
        await writeFile(join(dirA, p), text);
        macEdits.set(p, text);
      } else if (k < Math.floor(away * 0.98)) {
        const p = `Inbox/Phone away ${k} ünïcode.md`;
        await mkdir(join(dirA, "Inbox"), { recursive: true });
        await writeFile(join(dirA, p), `# ${k}\n\nwritten on the Mac while the phone was away\n`);
        macEdits.set(p, `# ${k}\n\nwritten on the Mac while the phone was away\n`);
      } else {
        const p = nextNote();
        await rm(join(dirA, p));
        removed.push(p);
      }
    }
    await mac.c!.settle({ coalesceWrites: false });
    const phoneEdits = new Map<string, string>([[contested, onPhone]]);
    for (let k = 0; k < 4; k++) {
      const p = nextNote();
      phoneEdits.set(p, `phone offline edit ${k}\n` + (await readFile(join(dirA, p), "utf8")));
    }
    for (const [p, text] of phoneEdits) {
      await inApp(
        `const f = app.vault.getAbstractFileByPath(${JSON.stringify(p)}); await app.vault.modify(f, ${JSON.stringify(text)}); return true;`,
      );
    }
    const head = mac.c!.serverCursor;
    const t1 = performance.now();
    await inApp(`app.commands.executeCommandById("trew-sync:pause-resume"); return true;`);
    await waitFor(
      "the phone to catch up",
      async () => {
        const row = await phoneRow();
        const s = (await inApp(`return plugin.currentState;`)) as { kind?: string };
        return row !== undefined && (row.applied ?? -1) >= head && s?.kind === "synced";
      },
      SETTLE_MS,
      1000,
    );
    report["catchUpMs"] = ms(performance.now() - t1);
    say(`  caught up on ${away} edits in ${ms((performance.now() - t1) / 1000)} s`);
    // Until both agree: the phone's own edits reach the Mac.
    await waitFor(
      "the phone and the Mac to agree",
      async () => {
        await mac.c!.settle({ coalesceWrites: false });
        return diff(await inventory(dirA), await phoneInventory()).length === 0;
      },
      600_000,
      3000,
    );
    report["catchUpUntilAgreedMs"] = ms(performance.now() - t1);
    const final = await inventory(dirA);
    for (const [p, text] of macEdits) {
      if (phoneEdits.has(p)) continue;
      check((await readMaybe(join(dirA, p))) === text, `the Mac's edit to ${p} did not survive`);
    }
    for (const p of removed) check(!final.has(p), `${p}, deleted on the Mac, came back`);
    for (const [p, text] of phoneEdits) {
      if (p === contested) continue;
      check(
        (await readMaybe(join(dirA, p))) === text,
        `the phone's offline edit to ${p} did not arrive intact`,
      );
    }
    const copies = [...final.keys()].filter((p) => conflictOriginal(p) === contested);
    const sides = await Promise.all([contested, ...copies].map((p) => readMaybe(join(dirA, p))));
    const bothKept = sides.includes(onMac) && sides.includes(onPhone);
    check(bothKept, `the conflict on ${contested} lost a side: ${copies.length} copies`);
    const stray = unexplainedCopies(final, new Set([contested]));
    check(stray.length === 0, `conflict copies this run did not make: ${stray.join(", ")}`);
    report["conflict"] = { path: contested, copies, bothSidesKept: bothKept };
    say(`  conflict: ${JSON.stringify(report["conflict"])}`);
  } finally {
    if (watcher) clearInterval(watcher);
    await mac.close().catch(() => undefined);
    await phone.adb("reverse", "--remove", `tcp:${port}`).catch(() => "");
    await phone.adb("forward", "--remove", `tcp:${DEVTOOLS_PORT}`).catch(() => "");
    await phone.shell("svc", "power", "stayon", "false").catch(() => "");
    await phone.shell("dumpsys", "deviceidle", "enable").catch(() => "");
    if (phone instanceof FakePhone) await phone.plugin.stop();
    await server.stop();
    const dozed = awake.filter((r) => r.wakefulness !== "Awake" || !r.front);
    report["awake"] = { checks: awake.length, notAwakeOrNotInFront: dozed };
    if (dozed.length > 0)
      say(
        `  WARNING: ${dozed.length} checks found the phone asleep or Obsidian behind; read those numbers as confounded`,
      );
    report["failures"] = failures;
    report["adbCommands"] = phone.commands.length;
    if (DRY) report["adbLog"] = phone.commands;
    await writeFile(OUT, JSON.stringify(report, null, 2));
    say(`\nreport in ${OUT}`);
    await rm(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    say(`${failures.length} checks FAILED`);
    process.exitCode = 1;
  } else say("every check passed");
}

// Imported by its test for the guards; run only as a script.
if (import.meta.main) await main();
