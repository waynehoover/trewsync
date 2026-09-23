import type { Args } from "./cli.ts";
import { mcpOrigin, parseMcpListen } from "./mcp-http.ts";

/** Accepted positional arguments. Vault paths always use --dir. */
const POSITIONALS: Record<string, number> = {
  init: 1,
  pair: 1,
  history: 1,
  rename: 1,
  restore: 1,
  revoke: 1,
  rotate: 1,
  uninvite: 1,
};

const TAKES_RECOVERY_KEY = new Set(["devices", "revoke", "uninvite"]);

function refuseRecoveryKey(args: Args): void {
  if (args.recoveryKey === undefined) return;
  if (TAKES_RECOVERY_KEY.has(args.command ?? "")) return;
  throw new Error(
    `${args.command} does not take --recovery-key, so the key would have been ignored. ` +
      `It is for ${[...TAKES_RECOVERY_KEY].join(", ")}; trew rotate takes the key as its ` +
      `argument instead.`,
  );
}

function refuseForce(args: Args): void {
  if (!args.force || args.command === "unlock") return;
  throw new Error(
    `${args.command} does not take --force, so it would have been ignored. It is for ` +
      `trew unlock, and only for a lock held on another machine.`,
  );
}

function refuseExtras(args: Args): void {
  const takes = POSITIONALS[args.command ?? ""] ?? 0;
  if (args.rest.length <= takes) return;
  const extra = args.rest.slice(takes);
  const what = extra.map((e) => JSON.stringify(e)).join(", ");
  throw new Error(
    takes === 0
      ? `${args.command} takes no arguments, so ${what} was not used. The vault is chosen with --dir.`
      : `${args.command} takes one argument, so ${what} was not used.`,
  );
}

export function validateUsage(args: Args): void {
  refuseExtras(args);
  if (args.command === "mcp" && args.json)
    throw new Error("mcp uses the MCP protocol on stdout; --json is not supported");
  const forCommands: Record<string, string[]> = {
    "--before": ["history", "deleted"],
    "--limit": ["history", "deleted"],
    "--uid": ["restore"],
    "--to": ["restore"],
    "--ttl": ["invite"],
    "--watch": ["sync"],
    "--verify": ["sync"],
    "--backup-taken": ["rebase"],
    "--allow-last": ["revoke"],
    "--server": ["init"],
    "--token": ["init"],
    "--device": ["init", "pair"],
    "--vault-id": ["init"],
    "--key-file": ["init", "pair", "rotate"],
    "--key-out": ["init", "rotate", "mcp-token"],
    "--revoke": ["mcp-token"],
    "--listen": ["mcp"],
    "--vault": ["mcp"],
    "--writable": ["mcp"],
    "--allow-origin": ["mcp"],
    "--no-merge": ["sync", "restore", "preview", "mcp"],
    "--read-only": ["init", "pair", "sync", "restore", "preview", "mcp"],
  };
  for (const flag of args.provided ?? []) {
    const allowed = forCommands[flag];
    if (allowed && !allowed.includes(args.command ?? ""))
      throw new Error(
        `${flag} is only for ${allowed.join(", ")}; it has no effect on ${args.command}`,
      );
  }
  if (args.mcpVaults?.length && args.provided?.has("--dir"))
    throw new Error("mcp takes --dir or named --vault roots, not both");
  if (args.command === "mcp-token" && (args.json || (args.mcpRevoke && args.keyOut !== undefined)))
    throw new Error("mcp-token does not accept --json or --key-out together with --revoke");
  if ((args.mcpWritable || args.mcpOrigins?.length) && args.mcpListen === undefined)
    throw new Error("--writable and --allow-origin require --listen");
  if (args.mcpWritable && args.readOnly)
    throw new Error("--writable cannot be combined with --read-only");
  if (args.mcpListen !== undefined) parseMcpListen(args.mcpListen);
  for (const origin of args.mcpOrigins ?? []) mcpOrigin(origin);
  if (args.keyFile && args.rest[0] && args.rest[0] !== "-")
    throw new Error("Use a key argument or --key-file, not both");
  if (["pair", "rotate"].includes(args.command ?? "") && !args.rest[0] && !args.keyFile)
    throw new Error(
      args.command === "rotate"
        ? "rotate needs the vault's current recovery key"
        : "pair needs an invite or recovery key",
    );
  if (args.command === "init") {
    if ((args.rest[0] || args.keyFile) && (args.server || args.token))
      throw new Error("init takes a setup string or --server and --token, not both");
    if (!args.rest[0] && !args.keyFile && (!args.server || !args.token))
      throw new Error(
        "init needs the server's setup string, like host:3003#TOKEN, or --server and --token",
      );
  }
  if (args.allowLast && !args.recoveryKey)
    throw new Error("Use --allow-last --recovery-key to remove the final device");
  refuseRecoveryKey(args);
  refuseForce(args);
  if (args.verify && (args.command !== "sync" || args.watch)) {
    throw new Error("--verify is for a one-time sync, without --watch");
  }
  if (args.before && args.command !== "history" && args.command !== "deleted") {
    throw new Error("--before is only for history and deleted");
  }
  const required: Record<string, string> = {
    history: "the path of a note",
    restore: "the path of a note",
    rename: "a name for this device",
    revoke: "a device id",
    uninvite: "an invite id",
  };
  const argument = required[args.command ?? ""];
  if (argument && !args.rest[0]) throw new Error(`${args.command} needs ${argument}`);
}
