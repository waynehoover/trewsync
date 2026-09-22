/**
 * Saved edit -> matching bytes on another client, with production timers.
 * Run: bun run bench:cadence
 * Real Go server and crypto; in-memory vaults, loopback, simulated plugin events.
 * This measures scheduling, not phone filesystem or official Sync performance.
 */
import { execFileSync } from "node:child_process";
import { arch, cpus, platform } from "node:os";
import { Client, SYNC_EVENT_DELAY_MS } from "./src/core/client.ts";
import { TestServer, cleanupBinary, until } from "./src/core/test-server.ts";
import { testWrapped } from "./src/core/test-keys.ts";
import { MemoryIndexStore, MemoryVault } from "./src/core/vault.ts";

class PluginEvents extends MemoryVault {
  readonly readDelays = new Map<string, number>();
  override async read(path: string): Promise<Uint8Array> {
    const delay = this.readDelays.get(path);
    if (delay) await sleep(delay);
    return super.read(path);
  }
  override watch(onChange: (path: string) => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = super.watch((path) => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        onChange(path);
      }, SYNC_EVENT_DELAY_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }
}

const server = new TestServer();
const clients: Client[] = [];
const loops: Promise<Error>[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const samples: Record<string, number[]> = {};
const passes: Record<string, number> = {};
const baselineNotes = Number(process.env["TELIMUS_BENCH_NOTES"] ?? 0);
const clientCount = Number(process.env["TELIMUS_BENCH_CLIENTS"] ?? 2);
const sampleCount = Number(process.env["TELIMUS_BENCH_SAMPLES"] ?? 5);
if (
  !Number.isSafeInteger(clientCount) ||
  clientCount < 2 ||
  clientCount > 20 ||
  !Number.isSafeInteger(sampleCount) ||
  sampleCount < 1 ||
  sampleCount > 100
)
  throw new Error("Invalid benchmark client or sample count");
const prioritizeActive = process.env["TELIMUS_BENCH_PRIORITY"] !== "0";
let activePath: string | undefined;
if (!Number.isSafeInteger(baselineNotes) || baselineNotes < 0)
  throw new Error("Invalid TELIMUS_BENCH_NOTES");
try {
  await server.start();
  const secret = new Uint8Array(32).fill(95);
  const wrapped = await testWrapped(secret);
  const av = new PluginEvents();
  const bv = new PluginEvents();
  for (let i = 0; i < baselineNotes; i++)
    await av.edit(`baseline/note-${i}.md`, `Unchanged note ${i}.\n`);
  const make = async (device: string, vault: MemoryVault) => {
    const client = new Client({
      vault,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      vaultId: "default",
      device,
      activePath: () => (prioritizeActive ? activePath : undefined),
      // Exercise the same transfer reporting path used by the plugin.
      onTransfer: () => {},
      onPass: () => {
        passes[device] = (passes[device] ?? 0) + 1;
      },
      ...(await server.deviceCredentials(secret, wrapped, device)),
    });
    clients.push(client);
    await client.connect();
    await client.settle();
    loops.push(client.runUntilClosed());
    return client;
  };
  const a = await make("sender", av);
  await make("receiver", bv);
  const receivers = [bv];
  for (let i = 2; i < clientCount; i++) {
    const vault = new PluginEvents();
    receivers.push(vault);
    await make(`receiver-${i}`, vault);
  }
  const send = async (scenario: string, path: string, body: string, forceSender = false) => {
    const start = performance.now();
    await av.edit(path, body);
    // Bypass only the sender to isolate the receiving client's arrival delay.
    if (forceSender) await a.sync({ coalesceWrites: false });
    await until(scenario, () => receivers.every((vault) => vault.text(path) === body), 60_000);
    (samples[scenario] ??= []).push(Math.round(performance.now() - start));
    if (av.text(path) !== body) throw new Error(`${scenario}: sender's edit was lost`);
  };
  for (let i = 0; i < sampleCount; i++) {
    await send("new note", `new-${i}.md`, `# Note ${i}\n\nSaved content.\n`);
  }
  let body = "# Rapid edits\n";
  await send("initial note", "repeat.md", body);
  for (let i = 0; i < sampleCount; i++) {
    await sleep(100);
    body += `\nSaved paragraph ${i}.\n`;
    await send("repeat edit", "repeat.md", body);
  }
  for (let i = 0; i < sampleCount; i++) {
    await sleep(100);
    body += `\nIncoming paragraph ${i}.\n`;
    await send("incoming update (sender forced)", "repeat.md", body, true);
  }
  for (let i = 0; i < sampleCount; i++) {
    const path = `a-slow-attachment-${i}.bin`;
    av.readDelays.set(path, 500);
    await av.edit(path, "complete attachment bytes\n");
    await send(
      "note beside attachment (500 ms read)",
      `z-urgent-${i}.md`,
      `Kept urgent paragraph ${i}.\n`,
    );
    await until("the attachment to finish", () => bv.text(path) === "complete attachment bytes\n");
    av.readDelays.delete(path);
  }
  for (let i = 0; i < sampleCount; i++) {
    const background = `a-background-note-${i}.md`;
    activePath = `z-current-note-${i}.md`;
    av.readDelays.set(background, 500);
    await av.edit(background, `Background note ${i}.\n`);
    await send(
      "current note beside background note (500 ms read)",
      activePath,
      `Current note ${i}.\n`,
    );
    await until("the background note", () => bv.text(background) === `Background note ${i}.\n`);
    av.readDelays.delete(background);
  }
  activePath = undefined;
  const beforeBurst = { ...passes };
  const burst = performance.now();
  for (let i = 0; i < 200; i++) await av.edit(`burst/note-${i}.md`, `Exact burst content ${i}.\n`);
  await until("all burst notes", () =>
    Array.from({ length: 200 }, (_, i) =>
      receivers.every(
        (vault) => vault.text(`burst/note-${i}.md`) === `Exact burst content ${i}.\n`,
      ),
    ).every(Boolean),
  );
  samples["200-note event burst"] = [Math.round(performance.now() - burst)];
  await sleep(200);
  for (let i = 0; i < 200; i++)
    if (av.text(`burst/note-${i}.md`) !== `Exact burst content ${i}.\n`)
      throw new Error("Burst edit lost");
  const burstPasses = Object.fromEntries(
    Object.entries(passes).map(([device, n]) => [device, n - (beforeBurst[device] ?? 0)]),
  );
  console.log(
    JSON.stringify(
      {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).length > 0,
        variant: process.env["TELIMUS_BENCH_VARIANT"] ?? "current",
        runtime: execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim(),
        hardware: `${platform()} ${arch()} ${cpus()[0]?.model ?? "unknown"}`,
        environment:
          "loopback; real Go server; in-memory vaults; production sync timers; simulated Obsidian events",
        samplesMs: samples,
        clientCount,
        percentilesMs: Object.fromEntries(
          Object.entries(samples).map(([name, values]) => {
            const sorted = values.slice().sort((a, b) => a - b);
            return [
              name,
              {
                n: sorted.length,
                p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
                p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
              },
            ];
          }),
        ),
        baselineNotes,
        prioritizeActive,
        burstPasses,
        exactContentVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients) await client.close();
  await Promise.all(loops);
  await server.cleanup();
  await cleanupBinary();
}
