import { runForever, type Client } from "../core/client.ts";
import { outcomeOf } from "../core/outcome.ts";
import type { Args, Console } from "./cli.ts";
import { clientOptions } from "./client-options.ts";
import type { Config } from "./config.ts";
import { NodeVault } from "./vault.ts";
import { McpReader } from "./mcp-read.ts";
import type { McpSession } from "./mcp-tools.ts";

function boundedArrays<T extends object>(value: T): { value: T; truncated: boolean } {
  let remaining = 32768;
  let truncated = false;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!Array.isArray(item)) return [key, item];
      const rows: unknown[] = [];
      for (const row of item) {
        const bytes = Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= 20 || bytes > remaining) {
          truncated = true;
          continue;
        }
        remaining -= bytes;
        rows.push(row);
      }
      return [key, rows];
    }),
  );
  return { value: result as T, truncated };
}

export async function prepareMcpSession(
  args: Args,
  config: Config,
  io: Console,
  onFailure: (error: Error) => void,
) {
  const opts = await clientOptions(config, { ...args, watch: true }, io);
  const mode =
    opts.readOnly || (args.mcpListen !== undefined && !args.mcpWritable) ? "read-only" : "writable";
  const writer = opts.vault as NodeVault;
  const observed = new NodeVault(args.dir, {
    configDir: args.configDir,
    alsoIgnore: args.ignore,
    observeOnly: true,
  });
  await observed.probeCase();
  const reader = new McpReader(observed);
  let current: Client | undefined;
  let stopping = false;
  let state = "connecting";
  let wake: (() => void) | undefined;
  let lastPass: object | null = null;
  let lastFailure: object | null = null;
  let localGeneration = 0;
  let passGeneration = 0;
  let scannedGeneration = 0;
  const summary = () => ({
    connection: state,
    writeReady: mode === "writable" && !stopping && !!current?.writeReady,
    localGeneration,
    scannedGeneration,
    localWritesSincePass: localGeneration - scannedGeneration,
  });
  const session: McpSession = {
    mode,
    reader,
    writer,
    client: () =>
      state === "ready" && current && !current.transport.isClosed ? current : undefined,
    stopping: () => stopping,
    changed: () => {
      localGeneration++;
    },
    summary,
    async status() {
      return reader.run(async () => {
        let scanFailure: string | undefined;
        try {
          await observed.list({ forceFull: true, checked: true });
        } catch {
          scanFailure = "the recovery inventory could not be completely checked";
        }
        const recovery = observed.recovery;
        const sampled = boundedArrays({ stranded: observed.stranded, displaced: recovery.waiting });
        return {
          ...summary(),
          readOnly: mode === "read-only",
          mergeEnabled: opts.merge ?? true,
          exclusions: { configDir: args.configDir ?? ".obsidian", ignoredNames: args.ignore },
          engine: current
            ? { ...current.engine.status(), serverCursor: current.serverCursor }
            : null,
          lastPass,
          lastFailure,
          recovery: {
            observedAt: scanFailure ? null : Date.now(),
            complete: !scanFailure && recovery.complete,
            why: scanFailure ?? recovery.why?.slice(0, 1024) ?? null,
            ...sampled.value,
            count: new Set([...observed.stranded, ...recovery.waiting.map((item) => item.at)]).size,
            truncated: sampled.truncated,
          },
          observedAt: Date.now(),
        };
      });
    },
  };

  let loop: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  function stop() {
    if (stopping) return;
    stopping = true;
    state = "stopping";
    wake?.();
    closing = current?.close().catch(onFailure);
  }
  return {
    session,
    start() {
      if (loop || stopping) throw new Error("MCP session already started or stopping");
      loop = runForever(
        {
          ...opts,
          onSyncStart: () => {
            passGeneration = localGeneration;
          },
          onPass: (report) => {
            scannedGeneration = passGeneration;
            const sampled = boundedArrays(report);
            const outcome = boundedArrays(
              outcomeOf(report, undefined, writer.recovery, writer.stranded),
            );
            lastPass = {
              at: Date.now(),
              report: sampled.value,
              outcome: outcome.value,
              truncated: sampled.truncated || outcome.truncated,
            };
          },
          onSyncFailed: (error) => {
            lastFailure = {
              at: Date.now(),
              message: error.message.slice(0, 1024),
              retryInMs: null,
            };
          },
        },
        {
          keepGoing: () => !stopping,
          onWaiting: (value) => {
            wake = value;
          },
          onConnecting: (client) => {
            current = client;
            state = "connecting";
          },
          onClient: (client) => {
            if (client) {
              current = client;
              state = "initial-sync";
            } else {
              current = undefined;
              if (!stopping && state !== "fatal") state = "offline";
            }
          },
          onSynced: () => {
            if (!stopping) state = "ready";
          },
          onFatal: (error) => {
            state = "fatal";
            lastFailure = {
              at: Date.now(),
              message: error.message.slice(0, 1024),
              retryInMs: null,
            };
          },
          onDisconnected: (error, retryInMs) => {
            if (!stopping) state = "offline";
            lastFailure = { at: Date.now(), message: error.message.slice(0, 1024), retryInMs };
          },
          onUnreachable: (error, retryInMs) => {
            if (!stopping) state = "offline";
            lastFailure = { at: Date.now(), message: error.message.slice(0, 1024), retryInMs };
          },
        },
      ).catch(onFailure);
    },
    stop,
    async drain() {
      stop();
      await loop;
      await closing;
      await reader.drain();
    },
  };
}
