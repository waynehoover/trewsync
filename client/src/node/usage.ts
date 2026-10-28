import type { Args } from "./cli.ts";

/** Accepted positional arguments. Vault paths always use --dir. */
const POSITIONALS: Record<string, number> = {
  pair: 1,
  history: 1,
  search: 1,
  rename: 1,
  restore: 1,
  revoke: 1,
  uninvite: 1,
  rewind: 1,
  undo: 1,
  "on-demand": 1,
  fetch: Number.MAX_SAFE_INTEGER,
  "free-space": Number.MAX_SAFE_INTEGER,
};

/**
 * A rewind is a preview or the apply of one, never both: a preview names a
 * time, and an apply names the version and head its preview printed, so what
 * is applied is exactly what was shown.
 */
function refuseMixedRewind(args: Args): void {
  const has = (flag: string) => args.provided?.has(flag) === true;
  if (has("--at") && has("--ago")) throw new Error("rewind takes --at or --ago, not both");
  const time = has("--at") || has("--ago");
  if (args.apply) {
    if (time) {
      throw new Error(
        "rewind --apply applies a preview by its --uid and --head, not a time: preview the time " +
          "first, and use the command it prints",
      );
    }
    if (args.uid === undefined || args.head === undefined) {
      throw new Error("rewind --apply needs the --uid and --head its preview printed");
    }
    return;
  }
  if (has("--uid") || has("--head")) {
    throw new Error("--uid and --head are for rewind --apply, with the values a preview printed");
  }
  if (!time) throw new Error("rewind needs a time, with --at or --ago");
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
  const forCommands: Record<string, string[]> = {
    "--before": ["history", "deleted"],
    "--limit": ["history", "deleted", "search"],
    "--mode": ["search"],
    "--folder": ["search"],
    "--case-sensitive": ["search"],
    "--context": ["search"],
    "--all": ["search"],
    "--after": ["search"],
    "--uid": ["restore", "rewind"],
    "--at": ["rewind"],
    "--ago": ["rewind"],
    "--head": ["rewind"],
    "--apply": ["rewind"],
    "--copy": ["undo"],
    "--to": ["restore"],
    "--ttl": ["invite"],
    "--watch": ["sync"],
    "--verify": ["sync"],
    "--device": ["pair"],
    "--key-file": ["pair"],
    "--no-merge": ["sync", "restore", "preview"],
    "--read-only": ["pair", "sync", "restore", "preview", "fetch"],
  };
  for (const flag of args.provided ?? []) {
    const allowed = forCommands[flag];
    if (allowed && !allowed.includes(args.command ?? ""))
      throw new Error(
        `${flag} is only for ${allowed.join(", ")}; it has no effect on ${args.command}`,
      );
  }
  // Refused here, before anything is read, rather than one of the two quietly
  // winning: an invite from a file and another on the command line are two
  // answers to one question (I12).
  if (args.keyFile && args.rest[0] && args.rest[0] !== "-")
    throw new Error("give the invite as an argument or with --key-file, not both");
  refuseForce(args);
  if (args.verify && (args.command !== "sync" || args.watch)) {
    throw new Error("--verify is for a one-time sync, without --watch");
  }
  if (args.before && args.command !== "history" && args.command !== "deleted") {
    throw new Error("--before is only for history and deleted");
  }
  // `pair` is not among these: with no invite it finishes a pairing that was
  // interrupted, and whether there is one is on the disk, which `pair` reads.
  // The server's own bound, said here rather than as a refusal from it.
  if (args.command === "search" && args.limitGiven && args.limit > 200) {
    throw new Error(`--limit for search is at most 200 matches a page, not ${args.limit}`);
  }
  const required: Record<string, string> = {
    search: "something to search for",
    history: "the path of a note",
    restore: "the path of a note",
    rename: "a name for this device",
    revoke: "a device id",
    uninvite: "an invite id",
    undo: "an operation id, from trew history",
    fetch: "the path of a file to download",
  };
  const argument = required[args.command ?? ""];
  if (argument && !args.rest[0]) throw new Error(`${args.command} needs ${argument}`);
  if (args.command === "rewind") refuseMixedRewind(args);
}
