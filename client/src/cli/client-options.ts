import type { Args, Console } from "./cli.ts";
import { credentialsFor, type ClientOptions } from "../core/client.ts";
import { indexPath, type Config } from "./config.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";

export async function clientOptions(
  config: Config,
  args: Args,
  io?: Console,
  observeOnly = false,
): Promise<ClientOptions> {
  const vault = new NodeVault(args.dir, {
    configDir: args.configDir,
    alsoIgnore: args.ignore,
    // Inspection suppresses automatic sync and the scan's own mutations.
    // Preview lists files, so transport-only inspection would still compact
    // the recovery ledger and normalize names beside a running writer.
    observeOnly,
  });
  // Once, here, before anything canonicalises a path. Until the probe has run
  // `canonical` folds case, which is the safe default and the wrong answer on
  // Linux: two files that differ only in case are one file as far as the alias
  // check is concerned, both are refused, and every sync exits 1 over a pair
  // the disk is perfectly happy with. The probe existed and nothing called it.
  await vault.probeCase();
  return {
    vault,
    store: new JsonIndexStore(indexPath(args.dir)),
    // Which key authenticates and what the vault is bound to, worked out in
    // core so that both shells cannot answer it differently.
    ...(await credentialsFor(config)),
    timeoutMs: args.timeout,
    // A one-shot sync does not defer a file to a next pass it will never
    // run. A watching one does, because there is one.
    coalesceWrites: args.watch,
    // Both of these are off by their absence rather than by a default, so a
    // config that predates them behaves exactly as it did (I29, I30).
    ...(args.merge ? {} : { merge: false }),
    // The config wins over the flag, and there is no flag that turns it back
    // on. A mirror that becomes writable when a cron line loses an argument is
    // not a mirror, and the whole value of this is that the capability is
    // absent rather than merely unused.
    ...(args.readOnly || config.readOnly === true ? { readOnly: true } : {}),
    // Only while watching. A one-shot sync prints its report at the end and
    // a line per path on the way would bury it; a client that stays running
    // has nothing else to say between passes.
    ...(args.watch && io
      ? {
          onProgress: (path?: string) => {
            if (path !== undefined) io.err(`  ... ${path}`);
          },
        }
      : {}),
    ...(args.verbose && io
      ? {
          log: (m: string, ...rest: unknown[]) =>
            io.err(`  ${m} ${rest.map(brief).join(" ")}`.trimEnd()),
        }
      : {}),
  };
}

function brief(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
