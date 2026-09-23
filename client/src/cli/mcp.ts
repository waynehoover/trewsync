import type { Args, Console } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { startStdio, type ProtocolHandle } from "./mcp-protocol.ts";
import { createVaultTools } from "./mcp-tools.ts";
import { startHttp, parseMcpListen } from "./mcp-http.ts";
import { readMcpToken } from "./mcp-token.ts";
import { mcpVaultRoots, withMcpLocks } from "./mcp-vaults.ts";
import { prepareMcpSession } from "./mcp-session.ts";

export async function cmdMcp(args: Args, io: Console, version: string): Promise<number> {
  const roots = await mcpVaultRoots(args);
  return withMcpLocks(roots, async () => {
    const configs = await Promise.all(
      roots.map(async (root) => {
        const config = await loadConfig(root.dir);
        if (!config) throw new Error(`${root.id} is not paired. Run trew init or trew pair first.`);
        return config;
      }),
    );
    const listen = args.mcpListen === undefined ? undefined : parseMcpListen(args.mcpListen);
    if (args.mcpWritable && (args.readOnly || configs.some((config) => config.readOnly))) {
      io.err("trew mcp: --writable cannot override a read-only device");
      return 2;
    }
    const credentialRoot = roots[0]!.dir;
    if (listen) {
      try {
        await readMcpToken(credentialRoot);
      } catch {
        throw new Error(
          "HTTP MCP requires a readable credential. Run trew mcp-token for the first configured vault.",
        );
      }
    }
    const sessions: Awaited<ReturnType<typeof prepareMcpSession>>[] = [];
    const registries: ReturnType<typeof createVaultTools>[] = [];
    let protocol: ProtocolHandle | undefined;
    let stopping = false,
      exitCode = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    function stop(error?: Error) {
      if (error) {
        exitCode = 1;
        io.err(`trew mcp: ${error.message.slice(0, 1024)}`);
      }
      if (stopping) return;
      stopping = true;
      protocol?.stop();
      for (const session of sessions) session.stop();
      finish();
    }
    const onSignal = () => stop();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      for (let index = 0; index < roots.length; index++) {
        if (stopping) break;
        sessions.push(
          await prepareMcpSession({ ...args, dir: roots[index]!.dir }, configs[index]!, io, stop),
        );
      }
      if (!stopping) {
        const vaults = sessions.map((session, index) => ({
          id: roots[index]!.id,
          session: session.session,
        }));
        for (const session of sessions) session.start();
        if (listen) {
          protocol = await startHttp(
            credentialRoot,
            () => createVaultTools(vaults, version),
            {
              host: listen.host,
              port: listen.port,
              allowOrigins: args.mcpOrigins ?? [],
              verbose: args.verbose,
              log: io.err,
            },
            stop,
          );
          if (!listen.loopback)
            io.err(
              `WARNING: ${args.mcpListen} carries plaintext notes and credentials. Use a trusted network and a TLS proxy.`,
            );
          io.err(
            `trew mcp: HTTP listening on ${args.mcpListen}, ${sessions.map((item, index) => `${roots[index]!.id}: ${item.session.mode}`).join(", ")}`,
          );
        } else {
          protocol = startStdio(
            () => {
              const registry = createVaultTools(vaults, version);
              registries.push(registry);
              return registry.server;
            },
            process.stdin,
            process.stdout,
            stop,
          );
        }
        if (stopping) protocol.stop();
        await finished;
      }
    } finally {
      stop();
      try {
        // Keep every vault lock until all admitted work has drained. Releasing
        // the first one early lets another process sync a half-finished batch.
        const drained = await Promise.allSettled([
          ...sessions.map((session) => session.drain()),
          ...registries.map((registry) => registry.drain()),
          protocol?.drain(),
        ]);
        await protocol?.close();
        const failure = drained.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    }
    return exitCode;
  });
}
