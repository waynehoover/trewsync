import { clientOptions } from "./client-options.ts";
import { validateUsage } from "./usage.ts";
import { previewCounts } from "../core/preview.ts";
/**
 * The headless client.
 *
 * The same engine the plugin runs, with the filesystem in place of Obsidian's
 * Vault API. Nothing in here decides anything about syncing; it reads arguments,
 * assembles the same four objects the plugin assembles, and prints what came
 * back. If this file ever grows a sync decision, it is in the wrong file.
 *
 * ## Shape
 *
 * `run` takes an argv and an output pair and returns an exit code, so a test can
 * drive the whole CLI against a real server and real directories without a
 * subprocess. `bin.ts` is the four lines that connect it to a process.
 *
 * ## What it prints
 *
 * Rule 7 of docs/design.md: a status that cannot distinguish the cases it
 * collapses is not a status. So a sync never reports a total. It reports what
 * was uploaded, downloaded, merged, conflicted and skipped, separately, and it
 * exits non-zero when anything was skipped for good, because a file that will
 * never sync is not a successful run.
 */

import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { base64urlEncode, randomBytes } from "../core/digest.ts";
import {
  Client,
  adviseAfterPairing,
  attentionLines,
  didSomething,
  needsAttention,
  pairWithInvite,
  runForever,
  whatTheDiskHolds,
  type DeviceRow,
  type PairingStore,
} from "../core/client.ts";
import { REJOIN_ADVICE, type SyncReport } from "../core/engine.ts";
import { INVITE_PREFIX, type InviteString } from "../core/invite-string.ts";
import {
  NoCredential,
  encodeConfig,
  isPendingPairing,
  normaliseUrl,
  parseInvite,
  startPairing,
  type PendingPairing,
} from "../core/pairing.ts";

export { normaliseUrl };
import { DEFAULT_CONFIG_DIR, JsonIndexStore, NodeVault, configFolderName } from "./vault.ts";
import {
  attentionPath,
  configPath,
  indexPath,
  loadAttention,
  loadConfig,
  orphanedIndex,
  removeConfig,
  removeState,
  saveAttention,
  saveConfig,
  type AttentionRecord,
  type Config,
} from "./config.ts";
import type { Displaced, Inventory } from "../core/displaced.ts";
import { lockVault, unlockVault } from "./lock.ts";
import {
  ConnectionError,
  MAX_NAME_BYTES,
  ProtocolError,
  type SearchMode,
  type SearchPage,
} from "../core/transport.ts";
import { renderMatch } from "./search-output.ts";
import { forTerminal, printable, safeJson } from "./terminal.ts";
import { describeOutcome, exitCodeOf, outcomeOf } from "../core/outcome.ts";
import { validateStoredState } from "../core/stored-state.ts";
import type { StoredState } from "../core/vault.ts";

/**
 * The client's release, written in by the build.
 *
 * esbuild defines it from package.json when it makes `dist/trew.mjs`, so the
 * one file somebody installs says which release it is and the version matrix
 * in docs/server.md has a number to name. Under the test runner nothing
 * defines it and the fallback says so rather than inventing a number.
 */
declare const __TREW_VERSION__: string | undefined;
export const VERSION: string =
  typeof __TREW_VERSION__ === "string" ? __TREW_VERSION__ : "development";

/** Where output goes, so a test can read it. */
export interface Console {
  out(line: string): void;
  err(line: string): void;
  /**
   * Whether standard output is a terminal that may be sent colour: what
   * `trew search` highlights its matches with. False when absent, so a test,
   * a pipe and a file get plain text.
   */
  color?: boolean;
}

export const USAGE = `trew: the TrewSync command-line client, self-hosted sync for Obsidian

  trew pair INVITE                        add this device to a vault with an invite (- reads it
                                            from standard input); trew pair alone finishes a
                                            pairing that was interrupted
  trew invite                             print a single-use invite for another device
  trew uninvite ID                        cancel an outstanding invite, from trew devices
  trew sync                               sync once and exit
  trew sync --watch                       sync, then keep syncing
  trew status                             what this device thinks the state is
  trew preview                            show planned sync changes without writing notes
  trew devices                            every device and invite that may reach this vault
  trew rename NAME                        change this device's name in the device list
  trew revoke ID                          stop one device connecting, from trew devices
  trew deleted                            notes the server still has and you do not
  trew history PATH                       every version the server holds of one note
  trew search QUERY                       search the vault's notes on the server for literal text
  trew restore PATH                       put a note back, newest version first
  trew repair                             resend bodies the server has lost, from this device
  trew unlink                             forget the pairing, keep the notes
  trew unlock                             clear a lock left behind by a trew that crashed
  trew --version                          which release this is

The first device pairs from the invite trewd serve writes to <data>/first-invite on the
server, or from trewd invite run there. Later devices pair from trew invite on any paired
device, or from trewd invite on the server again.

Options
  --dir DIR        the vault (default: the current directory)
  --device NAME    what this device calls itself (default: its hostname and four random characters)
  --json           machine-readable output
  --timeout MS     how long to wait on the server (default: 30000)
  --no-merge       never combine two edits to one note; keep both versions instead. Merging is the
                   only thing that makes content neither device wrote, and this is how to say no
  --read-only      apply what the server has and send nothing: no uploads, no deletions, no
                   conflict copies going out. For a mirror that should not change the vault
                   everyone else sees. This client declining to write, not the server refusing
                   it. Recorded in the config by pair, so a cron job cannot lose it by
                   forgetting the flag
  --force          for unlock: clear a lock this machine cannot check: one held on another machine,
                   or one naming a process here that holds nothing, such as a process id reused
                   after a restart. Saying it is not a running trew is your assertion. It will
                   not break a lock a trew on this machine is holding
  --ttl DURATION   how long an invite lasts, like 10m or 1h (default: 1h, at most 1h)
  --uid N          restore one exact version, from trew history
  --to PATH        restore somewhere other than where it came from
  --limit N        how many versions history or deleted shows (default: 20, or all deletions),
                   or matches on one page of search (default: 50, at most 200)
  --before UID     for history or deleted: the page before this version
  --mode MODE      for search: content (the default), filename, both, or tag
  --folder F       for search: only notes beneath this folder
  --case-sensitive for search: match case exactly
  --context N      for search: lines of context before and after each match, 0 to 3
  --all            for search: every page of matches, not only the first
  --after CURSOR   for search: the page after this one, from the cursor a page ends with
  --verify         for sync: read every file to verify the content cache
  --key-file PATH  pair: read the invite from a file, so it stays out of the shell's history
  --config-dir DIR Obsidian's config folder, if it is not .obsidian
  --ignore NAME    a folder or file name never to sync, at any depth, repeatable; local to this
                   device. A path another device syncs and this one ignores is reported as
                   ignored rather than failed, and does not affect the exit code
`;

/**
 * What `trew mcp` and `trew mcp-token` say now that they are gone.
 *
 * Both were the headless client's own MCP server, retired once the server's
 * `/mcp` passed the fixtures it was ported against (PLAN.md M2 task 10). A
 * service file or an agent config that still runs one is told where MCP went,
 * rather than handed the usage text, and before its old flags are refused one
 * at a time.
 */
const RETIRED = new Map<string, string>([
  [
    "mcp",
    "trew mcp is gone: TrewSync serves MCP from the server now. Run trewd serve -mcp, " +
      "and point the agent at the server's /mcp with a token from trewd mcp-token " +
      "(see docs/agent.md).",
  ],
  [
    "mcp-token",
    "trew mcp-token is gone: MCP tokens are made on the server now, with trewd mcp-token " +
      "(see docs/agent.md).",
  ],
]);

export async function run(argv: readonly string[], terminal: Console): Promise<number> {
  // Every line every command prints goes through here, so nothing a name
  // holds reaches the terminal as an instruction (T20, terminal.ts). One door
  // rather than an escape at each place a name is printed: that was the
  // arrangement before, and only `search` and part of `status` had one.
  const style = terminal.color === true;
  const io: Console = {
    out: (line) => terminal.out(forTerminal(line, style)),
    err: (line) => terminal.err(forTerminal(line, false)),
    ...(terminal.color === undefined ? {} : { color: terminal.color }),
  };
  const retired = RETIRED.get(argv[0] ?? "");
  if (retired !== undefined) {
    io.err(`trew: ${retired}`);
    return 2;
  }
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(String((err as Error).message));
    return 2;
  }
  const retiredLater = RETIRED.get(args.command ?? "");
  if (retiredLater !== undefined) {
    io.err(`trew: ${retiredLater}`);
    return 2;
  }

  if (args.version) {
    io.out(args.json ? safeJson({ ok: true, version: VERSION }) : VERSION);
    return 0;
  }
  if (args.help || args.command === undefined) {
    // A line at a time, since a newline inside one is spelled out (T20).
    for (const line of USAGE.split("\n")) io.out(line);
    return args.command === undefined && !args.help ? 2 : 0;
  }

  try {
    validateUsage(args);
  } catch (err) {
    const error = (err as Error).message;
    if (args.json) io.out(safeJson({ ok: false, error }));
    else io.err(`trew: ${error}`);
    return 2;
  }

  try {
    // Anything that changes the vault, its config or its index takes the
    // vault's lock for as long as it runs. Reading commands do not: they
    // load the index once and talk to the server, and holding a lock for
    // them would make `status` refuse while a watcher is running, which is
    // exactly when somebody asks.
    switch (args.command) {
      case "pair":
        return await locked(args, () => cmdPair(args, io));
      case "devices":
        return await cmdDevices(args, io);
      case "rename":
        return await locked(args, () => cmdRename(args, io));
      case "revoke":
        return await cmdRevoke(args, io);
      case "invite":
        return await cmdInvite(args, io);
      case "uninvite":
        return await cmdUninvite(args, io);
      case "sync":
        return await locked(args, () => cmdSync(args, io));
      case "status":
        return await cmdStatus(args, io);
      case "preview":
        return await cmdPreview(args, io);
      case "repair":
        return await cmdRepair(args, io);
      case "deleted":
        return await cmdDeleted(args, io);
      case "history":
        return await cmdHistory(args, io);
      case "search":
        return await cmdSearch(args, io);
      case "restore":
        return await locked(args, () => cmdRestore(args, io));
      case "unlink":
        return await locked(args, () => cmdUnlink(args, io));
      // Not under `locked`, which would be asking the lock for permission to
      // clear the lock.
      case "unlock":
        return await cmdUnlock(args, io);
      default:
        io.err(`no such command: ${args.command}`);
        for (const line of USAGE.split("\n")) io.err(line);
        return 2;
    }
  } catch (err) {
    // Every failure arrives here as a sentence rather than a stack. A stack
    // is for a bug in this program; the common failures are a server that is
    // not running and a string that was pasted wrong, and those deserve to
    // be readable.
    const message = withRecovery(err);
    if (args.json) io.out(safeJson({ ok: false, error: message }));
    else io.err(`trew: ${message}`);
    return 1;
  }
}

/**
 * A failure as a sentence, with the way out of it when there is a known one.
 *
 * The server's `cursor` refusal is exact about what is wrong and says nothing
 * about what to do, and it cannot: the recovery is a client command the server
 * has never heard of. The engine's own copy of the refusal names it, and this
 * puts the same words behind the server's, so a restored backup reads the same
 * whichever end noticed. Error strings are the whole UI of a device that has
 * stopped.
 */
function withRecovery(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ProtocolError && err.code === "cursor" && !message.includes(REJOIN_ADVICE)) {
    return `${message}. ${REJOIN_ADVICE}`;
  }
  return message;
}

/* ---------------------------------------------------------------- *
 * Commands
 * ---------------------------------------------------------------- */

/**
 * Why what is waiting could not be established, or undefined when it could.
 *
 * One place, because `status`, a single sync and a watch tick all have to give
 * the same answer, and three copies of "is this complete" is how they stop
 * doing that.
 */
function unknownRecovery(vault: { recovery?: Inventory } | undefined): string | undefined {
  const at = vault?.recovery;
  // An adapter with no opinion is not an incomplete one: `recovery` is
  // optional precisely so an adapter that cannot strand anything says nothing.
  if (at === undefined || at.complete) return undefined;
  return at.why ?? "the record of displaced versions could not be established";
}

/** Runs a command that changes the vault under the vault's lock. */
async function locked(args: Args, command: () => Promise<number>): Promise<number> {
  const release = await lockVault(args.dir, `trew ${args.command ?? ""}`.trim());
  try {
    return await command();
  } finally {
    // Best effort. A lock that cannot be removed names a process that has
    // exited, and the next holder recognises that and takes it over; an
    // error here would only hide the command's own outcome.
    await release().catch(() => {});
  }
}

/**
 * This device's name: what was typed, or the hostname with a short random
 * tail.
 *
 * Two fresh laptops are both called `macbook`, and the device name is what
 * tells two conflict copies apart. The copies were never lost, since
 * `firstFreeName` numbers them, but a name that says which device wrote it is
 * the point of having one in the filename. The tail is chosen at pairing and
 * kept in the config, so it never changes under a running vault.
 */
export function deviceNameFor(args: Args): string {
  // A name somebody typed is theirs, and one that is too long is refused
  // rather than shortened: it goes beside their notes in a conflict copy and
  // in `trew devices`, so quietly handing back a different one is worse
  // than saying no. `checkName` does the refusing.
  if (args.deviceGiven) return args.device;

  // A derived one is not theirs, and refusing it means `trew pair` fails on
  // a machine whose only crime is a long hostname. That is what happened: a
  // runner with a 61-character hostname produced a 66-byte default and every
  // pairing test failed with "the device name is 66 bytes". Nobody chose that
  // name, so shortening it costs nothing anybody asked for.
  const tail = [...randomBytes(2)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${clipToBytes(args.device, MAX_NAME_BYTES - tail.length - 1)}-${tail}`;
}

/**
 * The longest prefix of `name` that fits in `limit` UTF-8 bytes.
 *
 * Bytes rather than characters, because that is how the server counts, and
 * never half a character: cutting a string at a byte offset can leave a lead
 * surrogate with nothing after it, which is a name no two devices would agree
 * on the spelling of.
 */
function clipToBytes(name: string, limit: number): string {
  const enc = new TextEncoder();
  if (enc.encode(name).length <= limit) return name;
  let out = "";
  for (const ch of name) {
    if (enc.encode(out + ch).length > limit) break;
    out += ch;
  }
  // A limit smaller than one character leaves nothing, and an empty device
  // name is legal but useless for telling two laptops apart.
  return out === "" ? "device" : out;
}

/**
 * Adds this device to a vault by redeeming an invite (plan/protocol.md,
 * "Invite redemption").
 *
 * The invite is a `trew1i_` string. The first device's is the one `trewd serve`
 * writes to <data>/first-invite on the server; `trewd invite` on the server
 * makes more, and so does `trew invite` on any paired device. Redeeming it
 * registers this device's own row, under an id and a 32-byte token made here,
 * and nothing else on this disk authenticates: revoking that row is the whole
 * of taking the device away.
 *
 * The order is `pairWithInvite`'s, in core, and it is what makes each way this
 * can stop recoverable. The pairing is saved and read back before a byte goes
 * out (rule 4), so a reply lost after the server committed leaves a pending
 * pairing holding exactly the credential the server registered, and `trew pair`
 * again, with the same invite or with none, finishes it under the same ids;
 * that works even after the invite has expired, because the server recognises
 * its own redemption. A refusal no retry changes, or a first attempt that
 * never reached its server, removes what was saved, so nothing is left behind
 * and the invite is not spent (hazard 2 in plan/strip-ledger.md). Finishing a
 * pending pairing against a server that cannot be reached keeps it, since the
 * attempt that saved it may have been registered. "Paired" is said only once
 * `redeemed` has come back.
 *
 * What to do after a pairing that did not finish comes from
 * `adviseAfterPairing`, which the panel takes its words from too, and it is
 * read off the disk rather than off which step threw (rule 4).
 */
async function cmdPair(args: Args, io: Console): Promise<number> {
  const given = await secretFrom(args.rest[0], args, "the invite");
  // The file serve writes holds one line per address it found, each the same
  // invite. Handed over whole it is several strings in one, and the codec
  // would call that damaged, which sends somebody looking for a copying
  // mistake nobody made. Only lines holding an invite count: what `trewd
  // invite` prints is a sentence and then the invite, and saved to a file or
  // piped in whole it is one invite, not two (found in the M10 rehearsal,
  // where it was refused as "2 invites, one per address").
  const lines = given?.split(/\r?\n/).filter((line) => line.trim() !== "") ?? [];
  const invites = lines.filter((line) => line.trim().startsWith(INVITE_PREFIX));
  if (invites.length > 1) {
    throw new Error(
      `that holds ${invites.length} invites, one per address of the server, all the same invite. ` +
        `Give trew pair the one line whose address this device can reach.`,
    );
  }
  // Anything else is handed to the codec whole, so a string that is not an
  // invite at all is named for what it is.
  const handed = invites.length === 1 ? invites[0]!.trim() : given;
  // Parsed before anything on disk is looked at, so a string pasted wrong is
  // named as that whatever state the vault is in.
  const invite = handed === undefined ? undefined : parseInvite(handed);
  const held = await loadConfig(args.dir);
  let pending: PendingPairing;
  // Whether this finishes a pairing an earlier run started. That run may have
  // been answered with the answer lost, so this id and token may already be a
  // row, and a server that cannot be reached now is no reason to forget them.
  let resuming = false;
  if (held !== undefined && isPendingPairing(held)) {
    refuseAnotherPairing(args, held, invite);
    pending = held;
    resuming = true;
    if (!args.json) io.err(`Finishing the pairing already started here, as "${held.device}".`);
  } else if (held !== undefined) {
    // Pairing over a paired vault would throw away this device's credential,
    // the only copy of its row's token, and strand that row on the server
    // with nothing left here that can revoke it.
    throw new Error(
      `${args.dir} is already paired. Run trew unlink first if that is really what you want.`,
    );
  } else {
    // An index with no config beside it is an unlink that did not finish, and
    // pairing over it would load an index describing another pairing's sync.
    if (await orphanedIndex(args.dir)) {
      throw new Error(
        `${args.dir} is not paired but still holds an index at ${indexPath(args.dir)}, ` +
          `left by an unlink that did not finish. Run trew unlink to clear it, then pair again.`,
      );
    }
    if (invite === undefined) throw new Error(`pair needs an invite. ${WHERE_INVITES_COME_FROM}`);
    pending = startPairing(invite, deviceNameFor(args), {
      // Recorded in the config rather than left to the flag (I29). A mirror
      // that becomes writable when a cron line loses an argument has been
      // made conditional rather than safe, and there is no flag that turns
      // this back off.
      ...(args.readOnly ? { readOnly: true } : {}),
    });
  }

  let notDurable: string | undefined;
  let paired: Config;
  const how = {
    timeoutMs: args.timeout,
    resuming,
    ...(args.verbose ? { log: (m: string) => io.err(`  ${m}`) } : {}),
  };
  try {
    paired = await pairWithInvite(
      pending,
      pairingStore(args.dir, (why) => (notDurable = why)),
      how,
    );
  } catch (err) {
    // What the disk holds now, in the four states the counsellor knows, rather
    // than what the step that threw suggests (rule 4).
    const remains = await whatTheDiskHolds(() => loadConfig(args.dir));
    const flushed =
      notDurable === undefined
        ? ""
        : ` The pairing saved before it was sent is gone from this disk, but flushing that ` +
          `removal failed (${notDurable}); if the machine loses power first it may come back.`;
    throw new Error(
      `${(err as Error).message}. ` +
        adviseAfterPairing({ remains, surface: "cli", where: args.dir }) +
        flushed,
    );
  }

  // Then once as the device, which the redemption was not. It proves the saved
  // credential opens a session, and it is what stamps the row as seen, so
  // `trew devices` does not show a device paired a moment ago as one nothing
  // has ever connected under (I13).
  try {
    const client = await open(paired, args, io, { waitForBacklog: false, inspect: true });
    await client.close();
  } catch (err) {
    throw new Error(
      `${args.dir} is paired as "${paired.device}" and holds its credential, and connecting as ` +
        `it afterwards failed: ${(err as Error).message}. Nothing needs undoing: trew sync ` +
        `connects again.`,
    );
  }

  if (args.json) {
    io.out(
      safeJson({
        ok: true,
        paired: args.dir,
        device: paired.device,
        deviceId: paired.deviceId,
        url: paired.url,
        vaultId: paired.vaultId,
      }),
    );
  } else {
    io.out(`Paired ${args.dir} with ${paired.url} as "${paired.device}". Run trew sync.`);
    io.out(
      `This device has its own credential, and nothing else here opens the vault: ` +
        `trew revoke ${asTyped(paired.deviceId!)} on any device stops it connecting.`,
    );
  }
  return 0;
}

/**
 * Where the first invite and the ones after it come from, for a sentence that
 * has to say.
 */
const WHERE_INVITES_COME_FROM =
  "The first device pairs from the invite trewd serve writes to <data>/first-invite on the " +
  "server, or from trewd invite run there; later devices pair from trew invite on any paired " +
  "device, or from trewd invite on the server again.";

/**
 * Refuses to change a pairing that has not finished into a different one.
 *
 * The pending pairing may already be a row on the server whose reply was lost,
 * and the token saved here is then the only copy of that row's credential.
 * Starting over with another invite would throw it away and leave the row with
 * nothing that can connect as it, so that is the person's decision, made with
 * `trew unlink`, and not something a second paste does in passing.
 *
 * The name and `--read-only` are checked for the same reason a flag that is
 * quietly ignored is refused everywhere else: the pairing finishes as it was
 * started, and somebody who asked for something else should hear so. A name
 * that was not typed is derived afresh on every run, so it is not compared.
 */
function refuseAnotherPairing(
  args: Args,
  held: PendingPairing,
  invite: InviteString | undefined,
): void {
  const sameInvite =
    invite === undefined ||
    (base64urlEncode(invite.token) === held.invite &&
      invite.url === held.url &&
      invite.vault === held.vaultId);
  const renamed = args.deviceGiven && args.device !== held.device;
  const madeReadOnly = args.readOnly && held.readOnly !== true;
  if (sameInvite && !renamed && !madeReadOnly) return;
  const asked = !sameInvite
    ? "a different invite"
    : renamed
      ? `the name ${JSON.stringify(args.device)}`
      : "--read-only";
  throw new Error(
    `${args.dir} holds a pairing that has not finished, started with ${held.url} as ` +
      `"${held.device}"${held.readOnly === true ? " and read-only" : ""}, and this asked for ` +
      `${asked}. Run trew pair here with the same invite, or with none, to finish it as it was ` +
      `started; or run trew unlink here to abandon it, and then pair again.`,
  );
}

/**
 * Where a pairing's progress is kept: this vault's own config file.
 *
 * `save` reads back what it wrote before it returns (rule 4), because each of
 * the two things it writes holds the only copy of this device's token: the
 * pending pairing before the redemption goes out, and the finished device once
 * it is answered. `forget` removes the config and proves it gone, for a
 * pairing that was refused or never reached its server, so nothing is left
 * saved. A removal that happened and could not be flushed is handed to
 * `onNotDurable` rather than thrown, because the file is gone either way.
 */
function pairingStore(dir: string, onNotDurable: (why: string) => void): PairingStore {
  return {
    save: async (config) => {
      await saveConfig(dir, config);
      await mustReadBack(dir, config);
    },
    forget: async () => {
      const why = await removeConfig(dir);
      if (why !== undefined) onNotDurable(why);
    },
  };
}

/**
 * Proves the config is on disk and decodes to exactly what was written before
 * anything relies on it (rule 4). Not written, not renamed, but readable.
 *
 * Every field, by comparing the stored forms, because a read-back that checked
 * the address and not the token would pass over the write that lost the one
 * thing nothing can reissue, and a token that landed under a different id is a
 * credential for a row that is not this device's.
 */
async function mustReadBack(dir: string, config: Config): Promise<void> {
  const back = await loadConfig(dir);
  const wrote = JSON.stringify(encodeConfig(config));
  if (back === undefined || JSON.stringify(encodeConfig(back)) !== wrote) {
    throw new Error(`${configPath(dir)} did not read back as what was just written`);
  }
}

/**
 * Prints a single-use invite for another device.
 *
 * Minted over the wire by this device (plan/protocol.md, "Devices and
 * invites"): the server makes the token and keeps only its digest, and this
 * formats it into a `trew1i_` string with this device's own server address and
 * vault. The string is the only copy of the token, and nothing here keeps it.
 * It lasts an hour unless asked for less, and revoking this device cancels it.
 */
async function cmdInvite(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
  let issued: { invite: string; id: string; expiresAt: number | null };
  try {
    issued = await client.invite(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {});
  } finally {
    await client.close();
  }
  if (args.json) {
    io.out(
      safeJson({
        ok: true,
        invite: issued.invite,
        id: issued.id,
        expiresAt: issued.expiresAt,
      }),
    );
    return 0;
  }
  io.out(issued.invite);
  io.out("");
  io.out(`Paste it into trew pair, or into the TrewSync panel, on the new device.`);
  io.out(
    issued.expiresAt === null
      ? `It works once and does not expire. trew uninvite ${asTyped(issued.id)} cancels it.`
      : `It works once, until ${when(issued.expiresAt)}. trew uninvite ${asTyped(issued.id)} cancels it ` +
          `sooner.`,
  );
  return 0;
}

/**
 * Every device that may reach this vault, and every invite that could still
 * add one.
 *
 * The only way to answer "what is still connected to my notes", which is the
 * question a device list exists for.
 *
 * A row that has never connected is flagged rather than left to be read out of
 * a blank column, because those are the reclaimable ones: a redemption answered
 * and never followed by a session, which is a pairing interrupted and not
 * finished, or one abandoned with `trew unlink` while it was pending.
 *
 * An invite is listed as its id, its label and its expiry, and nothing else:
 * the token is the whole credential, it never comes back from the server, and
 * no field of a row redeems anything (hazard 1 in plan/strip-ledger.md).
 */
async function cmdDevices(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
  const thisDevice = client.deviceId;
  let devices: DeviceRow[];
  let invites: ListedInvite[];
  try {
    const listed = await client.devices();
    devices = listed.devices;
    invites = listed.invites.map((row) => ({
      id: row.invite,
      label: row.label,
      expiresAt: row.expiresAt,
    }));
  } finally {
    await client.close();
  }
  if (args.json) {
    io.out(safeJson({ ok: true, devices, invites, thisDevice }));
    return 0;
  }
  for (const d of devices) {
    const mine = d.id === thisDevice ? "  (this device)" : "";
    // The id first, because it is what `trew revoke` takes and the name is
    // not: two laptops may both be called laptop, and a list that put the
    // name where the identity goes would invite revoking the wrong one.
    io.out(
      `${d.id.padEnd(24)}  ${d.name.padEnd(16)}  added ${when(d.createdAt)}  ` +
        `${d.lastSeen === 0 ? "never connected " : `last seen ${when(d.lastSeen)}`}${mine}`,
    );
  }
  io.out("");
  io.out(
    `${devices.length} ${devices.length === 1 ? "device" : "devices"}. trew revoke ID stops one.`,
  );
  const stale = devices.filter((d) => d.lastSeen === 0);
  if (stale.length > 0) {
    io.out(
      `${stale.length} of them ${stale.length === 1 ? "has" : "have"} never connected. A pairing ` +
        `that was interrupted and never finished, or abandoned with trew unlink, leaves a row ` +
        `like that.`,
    );
  }
  io.out(REVOKING_DOES_NOT_UNREAD);
  // The invites, beside the rows, because they are the same question. A row
  // is a device that was added and an outstanding invite is one about to be:
  // a string issued on a device somebody has just lost is the thing worth
  // seeing, and until this it was invisible until it was redeemed.
  io.out("");
  if (invites.length === 0) {
    io.out("No outstanding invites.");
  } else {
    for (const inv of invites) {
      const label = inv.label === "" ? "" : ` ${JSON.stringify(inv.label)}`;
      io.out(
        `${inv.id.padEnd(24)}  invite${label}, ` +
          (inv.expiresAt === null ? "never expires" : `expires ${when(inv.expiresAt)}`),
      );
    }
    io.out("");
    io.out(
      `${invites.length} outstanding ${invites.length === 1 ? "invite" : "invites"}. Each one ` +
        `registers one device and then stops working. trew uninvite ID cancels one you did ` +
        `not mean to issue.`,
    );
  }
  return 0;
}

/**
 * An outstanding invite as `trew devices` shows it: the id `uninvite` takes,
 * the label a person gave it, and when it stops working, or null for never.
 */
interface ListedInvite {
  readonly id: string;
  readonly label: string;
  readonly expiresAt: number | null;
}

/**
 * What revoking does and does not do, said wherever it is offered.
 *
 * The notes are plaintext on every device that synced them. Revoking stops a
 * device receiving anything new and stops it writing; it cannot reach into
 * that device and take back what it already has, and a list that let somebody
 * think otherwise would be the most dangerous line in it.
 */
const REVOKING_DOES_NOT_UNREAD =
  "Revoking stops a device connecting, receiving anything new and writing. It does not un-read " +
  "what that device already read: every note it synced is still on its disk, in plaintext.";

/**
 * Cancels an outstanding invite.
 *
 * The companion to seeing them. An invite is a standing authority to register
 * one device, and waiting out its hour is not an answer to "I issued that on
 * the laptop I have just lost". Revoking that laptop cancels the invites it
 * issued too.
 */
async function cmdUninvite(args: Args, io: Console): Promise<number> {
  const invite = args.rest[0];
  if (!invite) throw new Error("uninvite needs an invite id, from trew devices");
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
  try {
    await client.uninvite(invite);
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "badentry") {
      // One refusal for unknown, expired, cancelled and already redeemed,
      // because saying which would tell somebody guessing ids that they had
      // found a real one. What it can say is where to look.
      throw new Error(
        `this vault has no outstanding invite ${invite}: it may have expired, been cancelled, or ` +
          `been redeemed, in which case it is a device row now. trew devices shows both.`,
      );
    }
    throw err;
  } finally {
    await client.close();
  }
  if (args.json) {
    io.out(safeJson({ ok: true, cancelled: invite }));
    return 0;
  }
  io.out(`Cancelled ${invite}. That string no longer adds a device.`);
  io.out(
    "It does not touch a device already added with it. If it was redeemed before this, the " +
      "device it added is a row in trew devices, and trew revoke ID is what stops that.",
  );
  return 0;
}

/**
 * Changes this device's name, on the server and then here.
 *
 * Under the vault lock, because it writes the config, and that is the file the
 * pairing lives in.
 *
 * The order is the server first. It cannot be atomic across a network and a
 * disk, so which half goes first is a decision: the device list is what another
 * person reads and what this device cannot repair while offline, whereas a
 * local name that ran ahead would have this device writing conflict copies
 * under a label the vault does not know. If the local save then fails, that is
 * said in full rather than reported as a failure, because the rename did
 * happen and running it again is what finishes it.
 */
async function cmdRename(args: Args, io: Console): Promise<number> {
  const name = args.rest[0];
  if (!name) throw new Error("rename needs a name: trew rename laptop");
  // `deviceGiven`, because this name was typed. Without it `deviceNameFor`
  // takes the derived path and appends a random tail, so `trew rename laptop`
  // would have produced `laptop-3f9c`: a name nobody asked for, quietly. A
  // typed name is refused rather than shortened, which is what `checkName`
  // does below and what the server does again.
  const wanted = deviceNameFor({ ...args, device: name, deviceGiven: true });

  const config = await mustLoad(args.dir);
  const client = await open(config, args, io);
  let said: string;
  try {
    said = await client.rename(wanted);
  } finally {
    await client.close();
  }

  try {
    await saveConfig(args.dir, { ...config, device: said });
  } catch (err) {
    // Both halves, because the useful sentence is what is true of each. The
    // list has the new name and this device does not, which shows up as
    // conflict copies still carrying the old one.
    io.err(
      `The device list now says ${said}, and this device could not write it down: ` +
        `${(err as Error).message}. Conflict copies made here will still say ` +
        `${JSON.stringify(config.device)} until this runs again.`,
    );
    if (args.json) io.out(safeJson({ ok: false, renamed: true, name: said, saved: false }));
    return 1;
  }

  if (args.json) {
    io.out(safeJson({ ok: true, renamed: true, name: said, saved: true }));
    return 0;
  }
  io.out(`This device is now ${said} in the device list.`);
  // Said because it is the half a person would otherwise discover from a
  // filename months later, and because it is not a fault to be fixed.
  io.out("Conflict copies made before now keep the old name; they are notes, not labels.");
  return 0;
}

/**
 * Stops one device connecting, and closes whatever it has open.
 *
 * Both, and the reply means both: a row removed while the revoked device holds
 * an authenticated connection is a revocation it does not notice.
 *
 * Any device may do this to any other, to itself, and to the last one
 * (plan/protocol.md, "Devices and invites"). Nothing a device holds is needed
 * to get back in afterwards: `trewd invite` on the server makes an invite
 * whatever is left, so a vault with no devices is one invite from having one
 * again. Revoking a device also cancels the invites it issued, so an invite
 * minted on a laptop before it was stolen cannot add the thief's next device.
 */
async function cmdRevoke(args: Args, io: Console): Promise<number> {
  const deviceId = args.rest[0];
  if (!deviceId) throw new Error("revoke needs a device id, from trew devices");
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
  let self: boolean;
  try {
    ({ self } = await client.revoke(deviceId));
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "nodevice") {
      throw new Error(
        `this vault has no device with id ${deviceId}, so the list you were reading is stale. ` +
          `Run trew devices again.`,
      );
    }
    throw err;
  } finally {
    await client.close();
  }
  if (args.json) {
    io.out(safeJson({ ok: true, revoked: deviceId, self }));
    return 0;
  }
  io.out(`Revoked ${deviceId}. Its sessions are closed and it cannot connect again.`);
  io.out(REVOKING_DOES_NOT_UNREAD);
  if (self) {
    io.out("");
    io.out(
      `That was this device. It has stopped syncing; run trew unlink here to forget the ` +
        `pairing, then trew pair with a new invite to add it again: from trew invite on another ` +
        `device, or, if no device is left, from trewd invite on the server.`,
    );
  }
  return 0;
}

async function cmdSync(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  if (args.watch) return await watchForever(config, args, io);

  const client = await open(config, args, io);
  try {
    const report = await client.settle({ verifyContents: args.verify });
    renderReport(
      report,
      args,
      io,
      client.serverCursor,
      client.vault.stranded ?? [],
      client.vault.displaced ?? [],
      unknownRecovery(client.vault),
    );
    await recordAttention(args, io, report);
    return exitCodeFor(report, client.vault);
  } finally {
    await client.close();
  }
}

/**
 * Writes down what a pass left waiting on a person, for `trew status`.
 *
 * After every pass that prints a report: a one-shot sync, each pass of a watch
 * whose list changed, and the sync a restore runs. `status` runs no pass of its
 * own, so without this a path the server refused was named once, by a report
 * somebody may never have read, and then never again (PLAN.md section 4.9).
 *
 * A failure here is said, on stderr where it cannot break a JSON report, and
 * does not change the exit code: the pass's own report and exit code are
 * already true, and what failed is the note of them for later. The old record
 * is removed if it can be, because a record older than the pass that just ran
 * would have `status` describe a vault this pass has already contradicted.
 */
async function recordAttention(args: Args, io: Console, report: SyncReport): Promise<void> {
  try {
    await saveAttention(args.dir, {
      at: Date.now(),
      count: needsAttention(report),
      // `?? []` because the type promises the list and a report built by hand
      // may not keep it, the same guard `attentionLines` has.
      paths: report.needsAttention ?? [],
    });
  } catch (err) {
    const gone = await rm(attentionPath(args.dir), { force: true }).then(
      () => "",
      (cause: Error) => ` The older record could not be removed either: ${cause.message}.`,
    );
    io.err(
      `trew: could not write down what needs attention, for trew status: ` +
        `${(err as Error).message}.${gone}`,
    );
  }
}

/**
 * What a one-shot sync exits with.
 *
 * A file that can never sync is not a successful run, whatever else worked,
 * and neither is one still failing when the pass gave up, nor one waiting on
 * a name that is a file here and a folder elsewhere. Exiting zero over
 * any of those is how a broken vault stays broken quietly in somebody's cron,
 * and it is how a sync that lost its connection half way through once
 * reported that it had finished.
 *
 * `ignored` is deliberately not in that list (R2). A path another device
 * syncs and `--ignore` keeps out of this one is the configuration doing what
 * it was asked, and it never stops being true: counting it made one ignored
 * folder exit every future sync 1, which is a cron job alerting for ever
 * about a decision its owner made on purpose. It is printed on every run
 * instead.
 */
/**
 * A secret from somewhere other than the command line (I12).
 *
 * An invite typed as an argument is in the shell's history file and in
 * `/proc` for every process on the machine while the command runs, and until
 * it is redeemed or expires it adds a device to the vault. That is fine for a
 * one-off on a laptop you own and wrong for a script, a shared box, or
 * anything a person will paste twice.
 *
 * Three ways in, and the argument is still one of them because taking it away
 * would make the common case worse for no gain:
 *
 *   trew pair trew1i_...          the argument, as before
 *   trew pair -                   standard input, for a pipe
 *   trew pair --key-file ./k      a file, which is what a script should use
 *
 * `-` reads to end of input and trims, so `printf %s "$INVITE" | trew pair -`
 * and a here-doc both work. A file is read whole and trimmed for the same
 * reason. Neither is logged, and neither is echoed back. An empty file is
 * refused rather than read as no invite, and a file and an argument together
 * are refused rather than one of them quietly winning.
 */
async function secretFrom(
  given: string | undefined,
  args: Args,
  what: string,
): Promise<string | undefined> {
  if (args.keyFile !== undefined) {
    if (given !== undefined && given !== "-") {
      throw new Error(`give ${what} as an argument or with --key-file, not both`);
    }
    const text = await readFile(args.keyFile, "utf8");
    const trimmed = text.trim();
    if (trimmed === "") throw new Error(`${args.keyFile} is empty, so it holds no ${what}`);
    return trimmed;
  }
  if (given === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const trimmed = Buffer.concat(chunks).toString("utf8").trim();
    if (trimmed === "")
      throw new Error(`nothing arrived on standard input, so there is no ${what}`);
    return trimmed;
  }
  return given;
}

export function exitCodeFor(
  report: SyncReport,
  /** The vault, for what it could establish about versions waiting (RR5). */
  vault?: { recovery?: Inventory; stranded?: readonly string[] },
): number {
  // Through the shared vocabulary, so the exit code, the panel's glyph and
  // the JSON all draw the same conclusion from one pass (I04). This counted
  // three fields directly, the panel counted two others, and the two answers
  // were not always the same pass's.
  //
  // The vault goes in as well, because the pass report cannot carry this: a
  // version the adapter displaced and could not place is something the adapter
  // did, and the engine is told only that a path was kept. `status` worked it
  // out for itself and `sync` did not, so the two exited differently on one
  // vault (RR5).
  return exitCodeOf(outcomeOf(report, undefined, vault?.recovery, vault?.stranded));
}

/**
 * Syncs, then keeps syncing.
 *
 * The reconnecting is `runForever` in core, because the plugin needs exactly the
 * same loop for exactly the same reasons. What is left here is what a shell
 * should own: deciding what to print.
 */
async function watchForever(config: Config, args: Args, io: Console): Promise<number> {
  let fatal: Error | undefined;
  // Every pass, not only the first (F16).
  //
  // `onSynced` reports the settle that runs on connecting, and then watch
  // sits inside `runUntilClosed` for hours while the ticker and arriving
  // batches start passes nobody reports. A file that started failing an hour
  // in said nothing at all, and a pass that failed outright said less: the
  // exception was swallowed by `Client.sync`, whose callers are event
  // handlers with nothing to do with one.
  //
  // Gated on the settle having been reported, because `onPass` fires for the
  // passes inside it too and printing both is the same report twice. Quiet
  // passes are not printed: a watcher that says "nothing happened" every
  // thirty seconds is a watcher somebody stops reading.
  let settled = false;
  // The live client, for the server cursor an ongoing report prints. Held by
  // `onClient`, which is how `runForever` hands each connection over.
  let watching: Client | undefined;
  // What `trew status` is told, rewritten only when the list changes, since a
  // watcher passes every thirty seconds and nearly every pass finds what the
  // last one did. Chained, so two passes close together cannot land their
  // records out of order and leave the older one on disk.
  let recorded: string | undefined;
  let recording = Promise.resolve();
  const record = (report: SyncReport): void => {
    const now = JSON.stringify([needsAttention(report), report.needsAttention ?? []]);
    if (now === recorded) return;
    recorded = now;
    recording = recording.then(() => recordAttention(args, io, report));
  };
  await runForever(
    {
      ...(await clientOptions(config, args, io)),
      onPass: (report) => {
        record(report);
        if (!settled || !didSomething(report)) return;
        renderReport(
          report,
          args,
          io,
          watching?.serverCursor ?? 0,
          watching?.vault.stranded ?? [],
          watching?.vault.displaced ?? [],
          unknownRecovery(watching?.vault),
        );
      },
      onSyncFailed: (err) => {
        io.err(`trew: a sync failed: ${err.message}. It will try again.`);
      },
    },
    {
      onClient: (client) => {
        watching = client;
        settled = false;
      },
      onSynced: (report, serverCursor) => {
        renderReport(
          report,
          args,
          io,
          serverCursor,
          watching?.vault.stranded ?? [],
          watching?.vault.displaced ?? [],
          unknownRecovery(watching?.vault),
        );
        settled = true;
        if (!args.json) io.err("Watching for changes. Ctrl-C to stop.");
      },
      onDisconnected: (cause, retryIn) => {
        io.err(`Disconnected: ${cause.message}. Trying again in ${seconds(retryIn)}.`);
      },
      onUnreachable: (cause, retryIn) => {
        io.err(`Cannot reach the server: ${cause.message}. Trying again in ${seconds(retryIn)}.`);
      },
      onFatal: (cause) => {
        fatal = cause;
      },
    },
  );
  // `recordAttention` catches its own failures, so this only waits.
  await recording;
  if (fatal) {
    io.err(`trew: ${withRecovery(fatal)}`);
    io.err("That will not fix itself by trying again.");
    return 1;
  }
  return 0;
}

/**
 * How many notes have changed here since the index was written (F27).
 *
 * A read and nothing else: `status` does not hold the vault's lock, on
 * purpose, so it must not write notes or an index (F08). Listing and
 * comparing stats does neither, and it is the same comparison the engine's
 * own scan starts from: a path the index has never seen, one it has and whose
 * size or modification time has moved, or one the index has and the disk no
 * longer does.
 *
 * Approximate in one direction only, and safely: an edit that preserves both
 * size and mtime is not counted, which understates rather than claiming more
 * is synced than is. A number here is never wrong about there being work.
 */
/**
 * How many notes on this disk the server has not been told about (F27, R12).
 *
 * `unknown` is a real answer and used to be reported as zero, twice over.
 *
 * A vault with no index returned zero, and that is the ordinary state
 * immediately after pairing and before the first sync: every note is unsent,
 * and status said "up to date with the server". The baseline for a vault with
 * no index is an empty one, not an excuse to stop counting.
 *
 * A scan that failed also returned zero, under a comment saying that guessing
 * at zero would be exactly the claim this exists to prevent. Now it says so.
 */
async function unsentHere(
  args: Args,
  stored: StoredState | undefined,
  /** Filled with any preserved version waiting in staging (R35). */
  stranded?: string[],
  /** Filled with what is known about each, where a record was written. */
  displaced?: Displaced[],
  /** Set to what the scan could establish about the recovery inventory. */
  recovery?: { at: Inventory | undefined },
): Promise<number | "unknown"> {
  try {
    const vault = new NodeVault(args.dir, {
      configDir: args.configDir,
      alsoIgnore: args.ignore,
      // Status takes no lock and may run beside a watcher, so its scan reaps
      // nothing and re-spells nothing (R12). It is a question.
      observeOnly: true,
    });
    const onDisk = await vault.list();
    stranded?.push(...vault.stranded);
    displaced?.push(...vault.displaced);
    if (recovery !== undefined) recovery.at = vault.recovery;
    // No index is an empty baseline, not a reason to answer zero.
    const known = new Map(Object.entries(stored?.entries ?? {}));
    let unsent = 0;
    const seen = new Set<string>();
    for (const f of onDisk) {
      seen.add(f.path);
      if (f.folder) continue;
      const was = known.get(f.path) as { size?: number; mtime?: number } | undefined;
      if (was === undefined) {
        unsent++;
        continue;
      }
      if (was.size !== f.size || was.mtime !== Math.ceil(f.mtime)) unsent++;
    }
    for (const [path, entry] of known) {
      if ((entry as { folder?: boolean }).folder) continue;
      if (!seen.has(path)) unsent++;
    }
    return unsent;
  } catch {
    // A vault that will not list is a vault this command cannot describe, and
    // guessing at zero is the claim the whole item is about.
    return "unknown";
  }
}

async function cmdStatus(args: Args, io: Console): Promise<number> {
  // Not `mustLoad`, which refuses a pairing that has not finished: this is the
  // command somebody runs to find out what state the vault is in, and that is
  // one of the states it has to be able to describe (rule 7).
  const config = await loadConfig(args.dir);
  if (!config) throw new Error(notPaired(args.dir));
  const unfinished = isPendingPairing(config);
  // Checked the way the engine checks it, so a status never reports numbers
  // read out of a file the next sync would refuse.
  const stored = validateStoredState(await new JsonIndexStore(indexPath(args.dir)).load());

  // What the last sync left waiting on a person, as it wrote it down (PLAN.md
  // section 4.9): a path the server refused, with the server's reason, and
  // every other path the engine wrote off. Read rather than worked out here,
  // because a refusal is the server's answer to a put and this command sends
  // nothing. Unreadable is kept apart from absent (rule 2).
  let attention: AttentionRecord | undefined;
  let attentionUnknown: string | undefined;
  try {
    attention = await loadAttention(args.dir);
  } catch (err) {
    attentionUnknown = (err as Error).message;
  }

  const stranded: string[] = [];
  const displaced: Displaced[] = [];
  // A box rather than a value, because the scan that fills it happens inside
  // `unsentHere` and this is read after it. Left undefined when that scan
  // never ran, which is itself not a clean answer.
  const recovery: { at: Inventory | undefined } = { at: undefined };
  const local = {
    vault: args.dir,
    device: config.device,
    server: config.url,
    vaultId: config.vaultId,
    cursor: stored?.cursor ?? 0,
    tracked: stored ? Object.keys(stored.entries).length : 0,
    pending: stored?.pending.length ?? 0,
    // Local to this device, and printed so a divergence is visible: the
    // plugin ignores nothing beyond the dot rule and the config folder, and
    // a folder ignored here is one the phone uploads.
    ignore: [...args.ignore],
    // Notes changed here since the last pass (F27), and how that was decided
    // (R25).
    //
    // It is a comparison of sizes and timestamps, not of content: hashing
    // every note in the vault is what a sync pass does, and this command takes
    // no lock and is meant to be cheap. So an edit that keeps a file's length
    // and its timestamp is not visible here, and the number is an estimate.
    // Saying which basis it is on is the difference between an estimate and a
    // claim; `unsent: 0` used to be printed as "up to date with the server".
    unsent: await unsentHere(args, stored, stranded, displaced, recovery),
    unsentFrom: "size and timestamp" as const,
    // Versions this client took off the disk and could not put back, which
    // nothing reaps and nothing else mentions (R35). Empty on every ordinary
    // vault; when it is not, the notes in it exist nowhere else.
    stranded,
    // The same versions with what was written down about each at the time:
    // which note it came off and why it is not at its name. A subset, because
    // the scan also finds parked files nothing wrote a record for.
    displaced,
    // Whether the two lists above are the whole of what is waiting (RR2). An
    // empty `stranded` with this false is not a clean vault, and this command
    // had no way to say so.
    recoveryComplete: recovery.at?.complete ?? false,
    recoveryUnknown:
      recovery.at === undefined
        ? "this vault could not be scanned, so what is waiting is unknown"
        : recovery.at.complete
          ? undefined
          : (recovery.at.why ?? "the record of displaced versions could not be established"),
    // The paths the last sync could not sync and waiting will not fix, each
    // with the engine's sentence: for a path the server refused, its reason
    // code first (`toolong:`, `control:`), then what it is and what to do.
    // Null when no sync has written a record yet.
    attention: attention ?? null,
    // Set when that record is there and cannot be read, which is not the
    // same as there being nothing to attend to.
    attentionUnknown,
  };

  // Reachability is reported, never assumed. "up to date" from a client that
  // could not reach the server is the kind of status rule 7 is about.
  //
  // `refused` is the other half of that rule, and it used to be collapsed into
  // the same field (N3). A server that answers and will not have this device,
  // because it was restored from an older backup or because the credential is
  // no longer the vault's, is not a server that is down, and a cron job
  // keying on `reachable` read the two as one outage. Mirrors the plugin's
  // `offline.refused`.
  let server: {
    reachable: boolean;
    refused: boolean;
    cursor?: number;
    behind?: number;
    error?: string;
  };
  // The third state, kept out of the JSON because the two booleans there
  // already say it: nothing was asked, so neither reachable nor refused. It is
  // here because the line printed for a person cannot be the same one, and
  // "cannot reach the server" about a connection nobody attempted is the
  // sentence that sends somebody to go and look at the server.
  let unjoined = false;
  try {
    // A pairing that has not finished has a credential, and whether the
    // server registered it is exactly what is not known, so nothing is asked
    // with it: `trew pair` is what finishes it, and says which it was.
    if (unfinished) throw new NoCredential(unfinishedPairing(args.dir));
    // The handshake and nothing after it. What is printed below is the
    // server's own cursor out of `ready`, and waiting for the backlog first
    // meant a device weeks behind downloaded all of it before saying a word.
    const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
    // Signed, not clamped. Clamping at zero made a server behind its own
    // clients, which is a restored backup or the wrong vault, read exactly
    // like being up to date.
    server = {
      reachable: true,
      refused: false,
      cursor: client.serverCursor,
      behind: client.serverCursor - local.cursor,
    };
    await client.close();
  } catch (err) {
    // Only the transport failing means the server was not reached. Everything
    // else got an answer out of it: an `auth` refusal, or the cursor check
    // against a server that has lost history. A device with no credential
    // asked nothing of anybody, so it is neither reachable nor refused: rule
    // 7, and exactly the pair of states this field exists to keep apart. It
    // is also the one this command must not turn into "not authorised", which
    // sends somebody looking for a server problem that is not there.
    const answered = !(err instanceof ConnectionError) && !(err instanceof NoCredential);
    unjoined = err instanceof NoCredential;
    server = { reachable: answered, refused: answered, error: (err as Error).message };
  }

  // One outcome, and both formats derive their status from it (R25).
  //
  // The two disagreed: text returned failure when the local scan could not
  // run and JSON returned success for the same vault in the same state, so a
  // cron job and a person looking at the same command were told different
  // things. Whether the exit code is right is a separate argument from
  // whether it is the same in both, and it has to be the same in both.
  // A version this client took off a note and could not put back is an
  // outstanding fact about the vault, and it does not clear itself: it waits
  // for a person to look at two files and decide. Reporting it in the text and
  // exiting 0 is how a cron job never finds out, which is the same shape as
  // the disagreement above.
  const wrong =
    !server.reachable ||
    server.refused ||
    local.unsent === "unknown" ||
    local.stranded.length > 0 ||
    // Not knowing is not clean (RR2). A vault whose record of displaced
    // versions could not be read may have notes sitting where no listing shows
    // them, and an empty list is the answer it gives either way. Exiting zero
    // on the difference between "nothing is waiting" and "this could not be
    // established" is rule 7 with the two cases that matter collapsed.
    !local.recoveryComplete ||
    // A path the last sync wrote off waits on a person and does not clear
    // itself, the same as a version this client could not put back, and
    // `sync` exited 1 over it: two readings of one vault cannot disagree about
    // whether it needs somebody (RR5). Not knowing is not clean either.
    (attention?.count ?? 0) > 0 ||
    attentionUnknown !== undefined;

  if (args.json) {
    io.out(safeJson({ ok: !wrong, ...local, server }));
    return wrong ? 1 : 0;
  }

  io.out(`vault    ${local.vault}`);
  io.out(`device   ${local.device}`);
  io.out(`server   ${local.server} (vault "${local.vaultId}")`);
  io.out(`tracked  ${local.tracked} files`);
  io.out(
    `ignore   ${local.ignore.length === 0 ? "nothing beyond the dot rule and the config folder" : local.ignore.join(", ")} (this device only)`,
  );
  // Both cursors, on their own lines, so "behind and nothing arriving" is
  // something a person can see rather than something the design says cannot
  // be detected (I11).
  io.out(`local cursor   ${local.cursor}`);
  if (server.cursor !== undefined) io.out(`server cursor  ${server.cursor}`);
  if (local.pending > 0) io.out(`pending  ${local.pending} files with work outstanding`);
  // Above the state line, because it is about notes and not about the server,
  // and because a person reading "caught up" wants to have seen this first.
  // Above the list, because it is the sentence that says the list may not be
  // the whole of it.
  if (local.recoveryUnknown !== undefined) {
    io.out(`unknown  ${local.recoveryUnknown}. There may be versions waiting that are not listed.`);
  }
  if (local.stranded.length > 0) {
    // The paths, not a directory (R50). This said `.trew/tmp` because that
    // was where the only kind of stranded version lived; a preservation claim
    // that fails now leaves one beside the note it came from, and somebody
    // following the printed path found an empty directory while the only copy
    // of their edit sat under `notes/` with the listing deliberately hiding
    // it. A line that names a place the bytes are not is worse than no line.
    io.out(`kept     ${local.stranded.length} version(s) this client could not put back:`);
    // With the reason where there is one. A path on its own says a file is
    // there and not which note it came off or why, which is a person opening
    // `note.md..trew-tmp-keep3f9c` to find out.
    const known = new Map(local.displaced.map((d) => [d.at, d]));
    for (const at of local.stranded) {
      io.out(`  ${join(args.dir, at)}`);
      const d = known.get(at);
      if (d !== undefined) io.out(`    from ${d.from}: ${d.why}`);
    }
  }
  // The paths themselves, with the reason each one gives, because a count is
  // not something anybody can act on and these never clear themselves (PLAN.md
  // section 4.9). With when they were found, because this is what the last
  // sync saw and not something this command looked at.
  if (attentionUnknown !== undefined) {
    io.out(
      `unknown  what the last sync left needing attention could not be read: ${attentionUnknown}. ` +
        `trew sync writes it again.`,
    );
  } else if (attention !== undefined && attention.count > 0) {
    io.out(
      `attention ${attention.count} ${attention.count === 1 ? "path needs" : "paths need"} a ` +
        `person, as the sync at ${when(attention.at).trim()} found them:`,
    );
    for (const { path, why } of attention.paths) io.out(`  ${visible(path)}: ${why}`);
    const rest = attention.count - attention.paths.length;
    if (rest > 0) io.out(`  and ${rest} more.`);
  }
  if (unjoined) {
    io.out(
      unfinished
        ? `state    not connected: ${server.error}`
        : `state    nothing to connect with: ${server.error}`,
    );
    return 1;
  }
  if (server.refused) {
    io.out(`state    the server is up and refused this device: ${server.error}`);
    return 1;
  }
  if (server.reachable) {
    // The cursor says what this device has seen, not what it has applied. A
    // path that is a file here and a folder elsewhere is applied by nobody and
    // never will be, and the cursor moves past it regardless, so the two facts
    // were printed on the same screen and only one of them was read. Rule 7:
    // "everything is here" cannot look like "everything except that".
    io.out(
      server.behind !== 0
        ? `state    ${server.behind} changes behind`
        : local.pending > 0
          ? `state    caught up with the server, with ${local.pending} still not applied here`
          : local.unsent === "unknown"
            ? // The scan failed, so what is on this disk is not known (R12).
              // Saying "up to date" here would be a claim about files nothing
              // managed to look at, which is the exact shape of status this
              // command exists to stop reporting.
              "state    caught up with the server; this vault could not be read, " +
              "so what is unsent from here is unknown"
            : local.unsent > 0
              ? // F27. The cursors matching says what the server has told this
                // device, and nothing at all about what has been typed here
                // since. A note edited after a successful sync left the two
                // numbers equal and the pending set empty, and the status said
                // everything was current while the paragraph sat on the disk.
                `state    caught up with the server, with ${local.unsent} not yet sent from here`
              : // Not "up to date": that is a claim about content, and what
                // this compared was sizes and timestamps (R25). An edit that
                // keeps both is invisible here, and a sync is what settles it.
                "state    caught up with the server; nothing here looks changed " +
                "(sizes and timestamps only)",
    );
    return wrong ? 1 : 0;
  }
  io.out(`state    cannot reach the server: ${server.error}`);
  return 1;
}

/* ---------------------------------------------------------------- *
 * Recovery
 * ---------------------------------------------------------------- */

/**
 * Notes the server still holds and this vault does not.
 *
 * The whole point of keeping every version is that this list exists. Until it
 * did, a deleted note was safe and unreachable, which is only half a promise.
 */
/**
 * Sends the server bodies it has lost, without writing a version (I14).
 *
 * `trewd verify` finds a chunk the disk rotted or the server quarantined, and
 * says it is waiting for a device to resend it. Nothing did. A device whose copy
 * of the note has not changed is correct to consider it synced: the entry is
 * committed, the hashes agree, and a pass has nothing to do. It is holding the
 * bytes and has no reason to send them, and the only way to make it was to edit
 * the note, which writes a version nobody typed into a damaged vault's history.
 *
 * Exits non-zero when anything is still missing afterwards, because that is the
 * case that needs a person: another device may hold it, and if none does, the
 * version is gone and the vault should be told the truth about that.
 */
async function cmdRepair(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  // Repair only resends bodies. A peer arriving during the request must not
  // start an ordinary sync: this command does not hold the vault's writer lock.
  const client = await open(config, args, io, { inspect: true });
  try {
    const out = await client.repair();
    const wrong = out.failed.length > 0 || out.stillMissing > 0;
    if (args.json) {
      io.out(safeJson({ ok: !wrong, ...out }));
      return wrong ? 1 : 0;
    }

    if (out.stored > 0) {
      io.out(`Sent ${out.stored} ${out.stored === 1 ? "body" : "bodies"} the server was missing.`);
    } else {
      io.out(
        `The server has every body this device can offer, from ${out.scanned} ` +
          `${out.scanned === 1 ? "note" : "notes"}.`,
      );
    }
    for (const f of out.failed) io.err(`${f.path}: ${f.why}`);
    if (out.stillMissing > 0) {
      io.err(
        `${out.stillMissing} ${out.stillMissing === 1 ? "body was" : "bodies were"} asked for, ` +
          "sent, and the server still does not have them. Check its disk.",
      );
    }
    if (out.couldNotOffer > 0) {
      io.out(
        `${out.couldNotOffer} ${out.couldNotOffer === 1 ? "chunk belongs" : "chunks belong"} to ` +
          "notes this device has edited since they were last synced, so it cannot supply them.",
      );
    }

    // What this command does not know, said rather than left to be inferred.
    //
    // A device can only see the bodies of the versions it holds. History it
    // never had is not in its index, so a clean run here is not a statement
    // that the vault is whole, and reading it as one is exactly the mistake
    // this project keeps finding: a green result that answers a narrower
    // question than the one somebody asked.
    io.out("");
    io.out(
      "This repairs what this device holds. Run it on your other devices too, then " +
        "`trewd verify` on the server for what is still missing: history this device " +
        "never had is not visible from here.",
    );
    return wrong ? 1 : 0;
  } finally {
    await client.close();
  }
}

async function cmdDeleted(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { inspect: true });
  try {
    // Only a limit somebody typed. The default of 20 is history's, and
    // passing it here silently cut the deleted list to twenty while the
    // "older deletions" hint below stayed quiet, because the server had not
    // been asked for more.
    const gone = await client.deleted(
      args.limitGiven ? args.limit : undefined,
      args.before > 0 ? args.before : undefined,
    );
    if (args.json) {
      io.out(safeJson({ ok: true, deleted: gone.notes, more: gone.more }));
      return 0;
    }
    if (gone.notes.length === 0) {
      io.out("Nothing has been deleted from this vault.");
      return 0;
    }
    let lost = 0;
    for (const v of gone.notes) {
      // Said per note rather than assumed for all of them. A purge keeps
      // only the newest version per path, which for a deleted note is the
      // deletion, so its content can be gone while it is still listed.
      const state = v.restorable === 0 ? "  (content purged)" : "";
      if (v.restorable === 0) lost++;
      io.out(`${when(v.mtime)}  ${v.device.padEnd(12)}  ${v.path}${state}`);
    }
    io.out("");
    const recoverable = gone.notes.length - lost;
    if (lost === 0) {
      io.out(`${recoverable} deleted, all still recoverable. trew restore PATH brings one back.`);
    } else {
      io.out(
        `${gone.notes.length} deleted. ${recoverable} can be restored; ` +
          `${lost} had their history purged and cannot be.`,
      );
    }
    // Never a short list that looks complete. Somebody reading one and not
    // finding their note concludes it is gone.
    // A cursor, not a bigger ask (F21). This said `--limit N shows more`,
    // which stops being true at the server's cap: past a thousand deletions
    // every larger limit returned the same page. The uid is what walks past
    // it, and it is the same flag `history` pages with.
    if (gone.more && gone.oldest !== undefined) {
      io.out(
        `There are older deletions than these. trew deleted --before ${gone.oldest} ` +
          "shows the page before this one.",
      );
    }
    return 0;
  } finally {
    await client.close();
  }
}

/**
 * The most versions the server will list in one answer.
 *
 * Its number, mirrored here so a larger request is capped and said to be,
 * rather than quietly answered with a different page size.
 */
const HISTORY_LIMIT_MAX = 500;

/** Every version of one note, newest first. */
async function cmdPreview(args: Args, io: Console): Promise<number> {
  const client = await open(await mustLoad(args.dir), args, io, { inspect: true });
  try {
    const preview = await client.preview();
    const ok = !preview.files.some((file) => file.action === "blocked");
    if (args.json) io.out(safeJson({ ok, ...preview, counts: previewCounts(preview) }));
    else {
      io.out("Preview only. Files are checked again during sync.");
      for (const file of preview.files)
        if (file.action !== "unchanged") io.out(`${file.action}: ${file.path}`);
      io.out(JSON.stringify(previewCounts(preview)));
    }
    return ok ? 0 : 1;
  } finally {
    await client.close();
  }
}

async function cmdHistory(args: Args, io: Console): Promise<number> {
  const path = args.rest[0];
  if (!path) throw new Error("history needs the path of a note");
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { inspect: true });
  try {
    // Capped here rather than left to the server, which answers a limit over
    // its maximum with its *default* page of a hundred and no indication.
    // Somebody asking for six hundred versions and shown a hundred reads
    // the list as complete, in the one tool where a short list that looks
    // complete costs a note.
    const limit = Math.min(args.limit, HISTORY_LIMIT_MAX);
    const versions = await client.history(path, {
      limit,
      ...(args.before ? { before: args.before } : {}),
    });
    const nextBefore = versions.length === limit ? versions.at(-1)!.uid : null;
    if (args.json) {
      io.out(safeJson({ ok: true, path, versions, limit, nextBefore }));
      return 0;
    }
    if (versions.length === 0) {
      // The server cannot tell a path it never had from one whose history
      // was purged, so neither can this. Saying which would be a guess in
      // the one tool where a guess is least welcome.
      io.out(`The server holds no versions of ${path}.`);
      return 0;
    }
    for (const v of versions) {
      const what = v.deleted ? "deleted" : v.folder ? "folder" : `${bytes(v.size)}`;
      io.out(`${String(v.uid).padStart(7)}  ${when(v.mtime)}  ${v.device.padEnd(12)}  ${what}`);
    }
    io.out("");
    if (args.limit > limit) {
      io.out(
        `Showing the newest ${limit}: the server lists at most ${HISTORY_LIMIT_MAX} versions at a time, ` +
          `so --limit ${args.limit} was capped there.`,
      );
    }
    io.out("trew restore PATH --uid N brings one of these back.");
    if (nextBefore !== null) io.out(`Older versions: trew history PATH --before ${nextBefore}`);
    return 0;
  } finally {
    await client.close();
  }
}

/** The most matches the server puts on one page of a search. */
export const SEARCH_LIMIT_MAX = 200;

/** The most lines of context a search match may carry each side. */
export const SEARCH_CONTEXT_MAX = 3;

/** How many times one page is asked for again after the server said to wait. */
const SEARCH_RETRIES = 5;

/**
 * Searches the vault on the server (plan/protocol.md, "Search (protocol
 * 2)"): the server's literal search, the one an agent's search_notes answers
 * from, over the notes as the server holds them.
 *
 * Matches go to standard output, one per line as grep prints them, and
 * everything said about them to standard error, so a pipe gets only matches.
 * Note text is untrusted, and every character a terminal would act on is
 * spelled out before it is printed (terminal.ts); the match is highlighted
 * only when standard output is a terminal.
 *
 * Exit 0 when the search answered, matches or none, including a first page
 * with more after it, which is said with the way to see them. Exit 1 when a
 * note could not be searched, since then a match may be missing and "no
 * match" would be a claim this cannot make, or when the search failed. Exit 2
 * for arguments that are not a search.
 */
async function cmdSearch(args: Args, io: Console): Promise<number> {
  const query = args.rest[0]!;
  const mode = (args.mode ?? "content") as SearchMode;
  const client = await open(await mustLoad(args.dir), args, io, { inspect: true });
  const color = io.color === true && !args.json;
  const pages: SearchPage[] = [];
  let after = args.after;
  let printed = false;
  try {
    for (;;) {
      const page = await searchPage(client, args, query, mode, after);
      pages.push(page);
      if (!args.json) {
        for (const m of page.matches) {
          // grep's separator between groups of context.
          if (args.context > 0 && printed) io.out("--");
          for (const line of renderMatch(m, query, mode, color)) io.out(line);
          printed = true;
        }
      }
      if (!args.all || page.nextAfter === null) break;
      after = page.nextAfter;
    }
  } finally {
    await client.close();
  }
  const last = pages.at(-1)!;
  const matches = pages.flatMap((p) => p.matches);
  const skipped = pages.flatMap((p) => p.skipped);
  const scanned = pages.reduce((n, p) => n + p.scanned, 0);
  const ok = skipped.length === 0;
  if (args.json) {
    io.out(
      safeJson({
        ok,
        query,
        mode,
        matches,
        skipped,
        complete: ok && last.nextAfter === null,
        nextAfter: last.nextAfter,
        head: last.head,
        indexedHead: last.indexedHead,
        index: last.index,
        pages: pages.length,
        scanned,
        scannedBytes: pages.reduce((n, p) => n + p.scannedBytes, 0),
      }),
    );
    return ok ? 0 : 1;
  }
  if (matches.length === 0) {
    io.err(last.nextAfter === null ? "No matches." : "No matches on this page.");
  }
  // What the index did. It only proposes, so a missing or lagging one costs
  // time and never a match, and saying so keeps a slow search from reading
  // as a broken one.
  if (mode !== "filename") {
    if (!last.index.usable) {
      io.err(
        `The server's search index was not used (${last.index.why ?? "no reason given"}), so every ` +
          "note was read: nothing is missed, it is only slower.",
      );
    } else if (last.indexedHead < last.head) {
      io.err(
        `The server's search index is still catching up (version ${last.indexedHead} of ` +
          `${last.head}); notes it has not reached were read in full, so nothing is missed.`,
      );
    }
  }
  if (matches.some((m) => m.clipped)) {
    io.err("Long lines are shortened; --json has each match's line as the server sent it.");
  }
  if (last.nextAfter !== null) {
    io.err(
      `More matches may follow: this is ${pages.length === 1 ? "the first page" : `${pages.length} pages`}` +
        `. trew search --all shows every page, or --after ${last.nextAfter} the next one.`,
    );
  }
  if (!ok) {
    io.err(
      `${skipped.length} ${skipped.length === 1 ? "note" : "notes"} could not be searched, so a ` +
        "match may be missing:",
    );
    for (const s of skipped) io.err(`  ${printable(s.path)}: ${printable(s.why)}`);
  }
  return ok ? 0 : 1;
}

/**
 * One page, asked for again after the wait the server names when it says a
 * device has searched as much as it may for now (`toomany`), a few times.
 */
async function searchPage(
  client: Client,
  args: Args,
  query: string,
  mode: SearchMode,
  after: string | undefined,
): Promise<SearchPage> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.search({
        query,
        mode,
        ...(args.folder !== undefined ? { folder: args.folder } : {}),
        ...(args.caseSensitive ? { caseSensitive: true } : {}),
        ...(args.context > 0 ? { contextLines: args.context } : {}),
        ...(args.limitGiven ? { limit: args.limit } : {}),
        ...(after !== undefined ? { after } : {}),
      });
    } catch (err) {
      if (!(err instanceof ProtocolError) || err.code !== "toomany" || attempt >= SEARCH_RETRIES) {
        throw searchRefusal(err);
      }
      const wait = Math.min(Math.max(err.retryAfterMs ?? 1000, 50), 30_000);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** A search's refusal in words, with what to do about the ones that have an answer. */
function searchRefusal(err: unknown): unknown {
  if (!(err instanceof ProtocolError)) return err;
  if (err.code === "proto" || (err.code === "protostate" && err.message.includes('"search"'))) {
    return new Error(
      "this server does not search for devices: it is older than this client. Upgrade the " +
        "server (docs/server.md, Upgrade order).",
    );
  }
  if (err.code === "stale" && err.message.startsWith("expired:")) {
    return new Error(
      "that --after cursor belongs to another search, or to the vault's history before a " +
        "restore or a purge changed it; search again without it.",
    );
  }
  if (err.code === "toomany") {
    return new Error(`the server is busy with searches: ${err.message}. Try again in a moment.`);
  }
  return err;
}

/**
 * Puts a note back.
 *
 * Never overwrites. If something already occupies the path, the restored copy
 * lands beside it and both are reported: a recovery tool that can destroy the
 * thing you still have is worse than none.
 */
async function cmdRestore(args: Args, io: Console): Promise<number> {
  const path = args.rest[0];
  if (!path) throw new Error("restore needs the path of a note");
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io);
  try {
    let version;
    if (args.uid !== undefined) {
      version = await client.findVersion(path, (v) => v.uid === args.uid);
      if (!version) throw new Error(`the server has no version ${args.uid} of ${path}`);
      // Whether that version can be restored is Client.restore's to say,
      // and it says it. A second check here would be a duplicate that no
      // test could pin: remove either one and the other still refuses.
    } else {
      version = await client.newestContentVersion(path);
      if (!version)
        throw new Error(`the server holds no version of ${path} with any content in it`);
    }

    const done = await client.restore(version, args.to);
    const sayRestored = (): void => {
      io.out(
        `Restored version ${version.uid} of ${path} to ${done.path} ` +
          `(${bytes(done.bytes)}, from ${when(version.mtime)}).`,
      );
      if (done.path !== (args.to ?? path)) {
        io.out(`Written to ${done.path}, because something is already at ${args.to ?? path}.`);
      }
    };
    // Sent straight away rather than left for the next sync. Somebody who
    // has just recovered a note should not have to know that it is only on
    // this device until something else happens.
    let report: SyncReport;
    try {
      report = await client.settle({ coalesceWrites: false });
    } catch (err) {
      // A failed sync cannot undo the completed local restore. Report the
      // retained path so a caller retries sync instead of creating more copies.
      const error = withRecovery(err);
      const outcome = outcomeOf(undefined, { why: error, offline: err instanceof ConnectionError });
      const sent = client.engine.serverHasOurs(done.path);
      if (args.json) {
        io.out(
          safeJson({
            ok: false,
            restored: true,
            path: done.path,
            uid: version.uid,
            bytes: done.bytes,
            sent,
            outcome,
            error,
          }),
        );
      } else {
        sayRestored();
        io.err(
          `The restored copy is on this device, but sync did not finish: ${error}. Run trew sync to retry.`,
        );
      }
      return 1;
    }
    const sent = client.engine.serverHasOurs(done.path);
    await recordAttention(args, io, report);

    if (args.json) {
      // `ok` from the same place the exit code comes from (RR8).
      //
      // It was `true` unconditionally beside an exit code that had learned
      // about unresolved recovery, so a restore on a vault whose displaced-
      // version log cannot be read returned exit 1 and `ok: true`, and
      // automation's answer depended on which of the two it read.
      //
      // `restored` is separate on purpose. The bytes really are on this disk
      // and saying so is not the same as saying the run had nothing else
      // wrong with it; folding the two together is what made the old `true`
      // look reasonable.
      const outcome = outcomeOf(report, undefined, client.vault.recovery, client.vault.stranded);
      const code = exitCodeOf(outcome);
      io.out(
        safeJson({
          ok: code === 0,
          restored: true,
          sent,
          outcome,
          path: done.path,
          uid: version.uid,
          bytes: done.bytes,
          sync: report,
          recoveryUnknown: unknownRecovery(client.vault) ?? null,
        }),
      );
      return code;
    }
    sayRestored();
    if (sent) io.out("Sent to the server, so your other devices will pick it up.");
    else if (args.readOnly || config.readOnly === true) {
      io.out("The restored copy stays on this device because it is read-only.");
    } else {
      io.out("The restored copy has not been acknowledged by the server. Run trew sync to retry.");
    }
    if (exitCodeFor(report, client.vault) !== 0) {
      renderReport(
        report,
        args,
        io,
        client.serverCursor,
        client.vault.stranded ?? [],
        client.vault.displaced ?? [],
        unknownRecovery(client.vault),
      );
    }
    // The restore itself succeeded, and the sync after it is a sync: a file
    // that can never sync, or one still failing when the pass gave up, is
    // the same unsuccessful run here as it is under `sync`. The note is on
    // this device either way, and the line above says so.
    return exitCodeFor(report, client.vault);
  } finally {
    await client.close();
  }
}

/**
 * Forgets the pairing here, and says what is still on the server.
 *
 * Deliberately local, and deliberately not a revoke. Unlinking has to work
 * when the server does not, which is half of what somebody reaches for it for,
 * and a version of it that needed a connection would fail exactly then. The
 * cost is a row this device leaves behind, so the row's id is printed: that is
 * what `trew revoke` takes, and a list somebody cannot act on is worse than
 * no list.
 */
/**
 * Clears a lock left behind by a trew that is not running any more.
 *
 * This exists because taking a lock over automatically was wrong five times
 * (R03, R34, R40, R44, R49), each attempt handing one vault to two writers.
 * The decision "the holder is dead, so I may have it" cannot be made and acted
 * on atomically without something like `flock`, which Node does not have, so
 * it is a person who makes it and this reports what they are deciding about.
 *
 * Three exit codes, because there are three outcomes and a status that
 * collapses them is a status that cannot be scripted against (rule 7): 0 it is
 * clear, 1 it is still held, 2 the arguments were wrong.
 */
async function cmdUnlock(args: Args, io: Console): Promise<number> {
  const outcome = await unlockVault(args.dir, args.force);
  if (args.json) {
    const ok = outcome.did === "nothing" || outcome.did === "removed";
    io.out(
      safeJson({
        ok,
        did: outcome.did,
        why: outcome.why,
        ...(outcome.did === "nothing" ? {} : { holder: outcome.was ?? null }),
      }),
    );
    return ok ? 0 : 1;
  }
  switch (outcome.did) {
    case "nothing":
      io.out(outcome.why);
      return 0;
    case "removed":
      io.out(`the lock is clear: ${outcome.why}.`);
      return 0;
    case "refused":
      io.err(`trew: the lock was not cleared, because ${outcome.why}.`);
      return 1;
    case "contested":
      io.err(`trew: ${outcome.why}.`);
      return 1;
  }
}

async function cmdUnlink(args: Args, io: Console): Promise<number> {
  const config = await loadConfig(args.dir).catch(() => undefined);
  // `notDurable` is set when the removal happened and could not be made
  // durable: the disk failed while it was being flushed, rather than a
  // filesystem that has no directory fsync, which says nothing (I18).
  //
  // Not an error. The files are unlinked and the pairing is forgotten, which
  // is what was asked for; what is uncertain is whether a power cut in the
  // next moment brings the config back. Saying so is the whole of the fix:
  // this used to be swallowed, so a vault could come back paired to a server
  // it had been told to forget with nothing anywhere having mentioned it.
  const notDurable = await removeState(args.dir);
  // A pairing that had not finished is forgotten like a finished one, and is
  // not described like one: whether the server registered it is exactly what
  // was never learned, so the row this names may or may not exist.
  const unfinished = config !== undefined && isPendingPairing(config);
  if (args.json) {
    io.out(
      safeJson({
        ok: true,
        unlinked: args.dir,
        wasPaired: config !== undefined && !unfinished,
        ...(unfinished ? { unfinished: true } : {}),
        ...(notDurable !== undefined ? { notDurable } : {}),
        ...(config?.deviceId !== undefined ? { deviceId: config.deviceId } : {}),
      }),
    );
    return 0;
  }
  io.out(`Forgot the pairing for ${args.dir}. Every note is where it was.`);
  if (notDurable !== undefined) {
    io.out("");
    io.out(`The pairing is gone from this disk, but flushing that removal failed: ${notDurable}`);
    io.out(
      "If the machine loses power before the filesystem catches up, the pairing may come back. " +
        "Check the disk, and run `trew unlink` again if it does.",
    );
  }
  io.out("Nothing was removed from the server.");
  if (unfinished) {
    io.out("");
    io.out(
      `The pairing here had not finished. If the server registered it, the vault's device list ` +
        `has a row ${config.deviceId} that has never connected, and nothing here can remove it ` +
        `now: run trew revoke ${asTyped(config.deviceId)} on a device that still syncs.`,
    );
  } else if (config?.deviceId !== undefined) {
    io.out("");
    io.out(
      `This device is still in the vault's device list as ${config.deviceId}. Nothing here can ` +
        `remove it now, because the credential for it has just been forgotten: run ` +
        `trew revoke ${asTyped(config.deviceId)} on a device that still syncs.`,
    );
  }
  return 0;
}

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

/**
 * How much of a connection a command needs.
 *
 * A command that only reads a number off the handshake passes
 * `waitForBacklog: false` and closes; see `Client.connect`. Anything that
 * syncs takes the default and waits.
 */
interface ConnectHow {
  readonly waitForBacklog?: boolean;
}

/**
 * Assembles the four objects and connects, which is the whole of what a shell
 * does.
 *
 * There is one credential and no candidates to try. A paired device has
 * exactly one, and either it opens the vault or it does not; no other
 * credential on this disk would. A second way in is one that revoking the
 * first cannot close.
 *
 * Nothing is written back either. Which row this device is and the token
 * that proves it are settled by the redemption that made the device, before
 * any command connects.
 */
async function open(
  config: Config,
  args: Args,
  io?: Console,
  opts: ConnectHow & { inspect?: boolean } = {},
): Promise<Client> {
  const client = new Client({
    ...(await clientOptions(config, args, io, opts.inspect)),
    ...(opts.inspect === true ? { inspect: true } : {}),
  });
  try {
    await client.connect(opts);
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
}

export function renderReport(
  r: SyncReport,
  args: Args,
  io: Console,
  serverCursor: number,
  /**
   * Versions this vault took off a note and could not put anywhere, as
   * vault-relative paths.
   *
   * Reported here as well as by `status`, because somebody who runs `trew
   * sync` on a timer and reads nothing else was never told (R46, R50). These
   * do not clear themselves: they wait for a person.
   */
  stranded: readonly string[] = [],
  /** What was written down about each, where a record exists. */
  displaced: readonly Displaced[] = [],
  /** Why what is waiting could not be established, when it could not (RR2). */
  recoveryUnknown: string | undefined = undefined,
): void {
  const outcome = outcomeOf(
    r,
    undefined,
    // From the same string the text renderer prints below, so the JSON's `ok`
    // and the sentence a person reads cannot say different things.
    {
      complete: recoveryUnknown === undefined,
      ...(recoveryUnknown !== undefined ? { why: recoveryUnknown } : {}),
      waiting: displaced,
    },
    stranded,
  );
  if (args.json) {
    // `ok` and `outcome` come from the same conclusion, so a script keying on
    // either gets the same answer as the exit code (I04). `ok: true` beside a
    // non-zero exit was a real divergence, and one field being derived from
    // counters while another was hardcoded is how it happened.
    io.out(
      safeJson({
        ok: exitCodeOf(outcome) === 0,
        outcome,
        ...r,
        serverCursor,
        stranded,
        displaced,
        recoveryUnknown: recoveryUnknown ?? null,
      }),
    );
    return;
  }

  const lines: string[] = [];
  const say = (n: number, what: string) => {
    if (n > 0) lines.push(`${String(n).padStart(5)}  ${what}`);
  };
  say(r.uploaded, "uploaded");
  say(r.downloaded, "downloaded");
  say(r.merged, "merged");
  say(r.conflicted, "kept both versions");
  say(r.deletedLocally, "deleted here");
  say(r.deletedRemotely, "deleted on the server");
  say(r.restored, "brought back, having been edited elsewhere");
  say(r.foldersCreated, "folders created");
  say(r.foldersDeletedLocally, "folders removed here, deleted elsewhere");
  say(r.foldersDeletedRemotely, "folders deleted on the server");
  say(r.waiting, "waiting for a write to settle");
  say(r.retrying, "failed, will try again");
  // One line where there were three, and one list under it where there were
  // two. `skipped`, `blocked` and the inbound refusals folded into `skipped`
  // are three names for "this path is not syncing and waiting will not fix
  // it", and a person had to learn all three before the output could be read
  // (rule 7). What differs between them is the reason, which is the part
  // somebody can act on, so the reasons are what is printed. The counters and
  // the four maps behind them are untouched, and so is the exit code.
  say(needsAttention(r), "need attention");
  // Apart from the counted lines and out of the exit code, like `ignored`: a
  // read-only device not sending is the configuration doing what it was told
  // (I29). Named all the same, because a mirror quietly accumulating local
  // edits is something to find out about here rather than in a year.
  say(r.heldBack, "changed here and not sent, because this device is read-only");
  // Apart, and still printed, because this one is not a problem: it is the
  // configuration doing what it was told, it is deliberately not in the exit
  // code (R2), and a number that quietly disappears is how somebody loses
  // track of a folder they stopped syncing years ago.
  say(r.ignored, "ignored here, and synced by another device");

  if (lines.length === 0) {
    io.out(
      outcome.kind === "synced"
        ? "Nothing to do. Everything here matches the server."
        : describeOutcome(outcome),
    );
  } else {
    for (const line of lines) io.out(line);
    // The conclusion, once, in the same words the panel and the JSON use
    // (I04). The counted lines above say what happened; this says what it
    // adds up to, which is the part a person acts on and the part that used
    // to be left to them to work out from three separate numbers.
    if (outcome.kind !== "synced") io.out(`         ${describeOutcome(outcome)}`);
  }

  // Named, because a count is not something anybody can act on, and some of
  // these never clear themselves: they wait for a person to rename one of two
  // things that disagree, and they cannot do that without being told which
  // two. The same renderer the panel uses, so the two surfaces cannot drift
  // into describing one vault two ways again.
  if (r.needsAttention.length > 0) {
    io.out("");
    for (const line of attentionLines(r, "  ")) io.out(line);
  }
  // And versions this pass took off a note and could not put anywhere, which
  // `status` reports and a watcher never would have: somebody who runs
  // `trew sync` on a timer and nothing else was never told (R46, R50).
  if (recoveryUnknown !== undefined) {
    io.out("");
    io.out(`  ${recoveryUnknown}. There may be versions waiting that are not listed.`);
  }
  if (stranded.length > 0) {
    io.out("");
    io.out(`  ${stranded.length} version(s) this client could not put back:`);
    const known = new Map(displaced.map((d) => [d.at, d]));
    for (const at of stranded) {
      io.out(`    ${at}`);
      const d = known.get(at);
      if (d !== undefined) io.out(`      from ${d.from}: ${d.why}`);
    }
  }
  if (r.chunksSent > 0)
    io.out(`${String(r.chunksSent).padStart(5)}  chunks sent, ${bytes(r.bytesSent)}`);
  if (r.conflicted > 0)
    io.err('Look for files with "Conflicted copy" in the name. Both versions are kept.');
}

/* ---------------------------------------------------------------- *
 * Arguments
 * ---------------------------------------------------------------- */

export interface Args {
  provided?: Set<string>;
  verify: boolean;
  command?: string;
  rest: string[];
  dir: string;
  device: string;
  /** Whether --device was typed, since the default gets a random tail at pairing. */
  deviceGiven: boolean;
  json: boolean;
  watch: boolean;
  uid?: number;
  to?: string;
  limit: number;
  /** Whether --limit was typed, since the default only suits history. */
  limitGiven: boolean;
  /**
   * The oldest uid already seen, to ask for the page before it (F21).
   *
   * Zero means the newest page. Used by `deleted`, which had no way past the
   * server's cap and told people to raise `--limit`, which stops working at
   * exactly the point somebody needs it.
   */
  before: number;
  /** A file holding the invite `pair` redeems (I12). */
  keyFile: string | undefined;
  verbose: boolean;
  help: boolean;
  version: boolean;
  timeout: number;
  /** How long an invite lasts, in milliseconds; undefined is the server's default. */
  ttlMs?: number;
  /**
   * Whether two edits to one note may be merged on this device (I30).
   *
   * On unless `--no-merge` was typed. Off keeps both versions in every case
   * that would have merged, which is what merging already falls back to.
   */
  merge: boolean;
  /**
   * Whether this device may send anything to the server (I29).
   *
   * Off with `--read-only`, and off for good once it is in the config: a
   * mirror that can be made writable by forgetting a flag is not a mirror.
   */
  readOnly: boolean;
  /**
   * Whether `unlock` may break a lock it *cannot check*.
   *
   * Which is a lock held on another machine: nothing here can ask that machine
   * whether the process is running, so the only honest answers are to refuse
   * and to let somebody who does know say so out loud. It is not permission to
   * break a lock held by a process on this machine that is running, because
   * that one is checkable and there is nothing to assert about it.
   */
  force: boolean;
  configDir: string;
  ignore: string[];
  /** For search: what to match against, content when absent. */
  mode?: string;
  /** For search: only notes beneath this folder. */
  folder?: string;
  /** For search: match case exactly. */
  caseSensitive: boolean;
  /** For search: lines of context each side, 0 to 3. */
  context: number;
  /** For search: every page, not only the first. */
  all: boolean;
  /** For search: the cursor of the page before. */
  after?: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    provided: new Set(),
    verify: false,
    rest: [],
    dir: process.cwd(),
    device: hostname().split(".")[0] || "device",
    deviceGiven: false,
    json: false,
    watch: false,
    limit: 20,
    limitGiven: false,
    before: 0,
    keyFile: undefined,
    verbose: false,
    help: false,
    version: false,
    force: false,
    merge: true,
    readOnly: false,
    timeout: 30_000,
    configDir: DEFAULT_CONFIG_DIR,
    ignore: [],
    caseSensitive: false,
    context: 0,
    all: false,
  };

  const takes = new Set([
    "--dir",
    "--device",
    "--timeout",
    "--uid",
    "--to",
    "--limit",
    "--before",
    "--key-file",
    "--config-dir",
    "--ignore",
    "--ttl",
    "--mode",
    "--folder",
    "--context",
    "--after",
  ]);
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (onlyPositional) {
      if (args.command === undefined) args.command = arg;
      else args.rest.push(arg);
      continue;
    }
    // Everything after `--` is a word rather than an option. A device id is
    // base64url and base64url's alphabet includes `-`, so `trew revoke
    // -Xy...` was refused with "no such option" and there was no way to say
    // what was meant. Ids made here no longer start with one; ids from
    // anywhere else still can.
    if (arg === "--") {
      onlyPositional = true;
      continue;
    }
    if (arg.startsWith("-")) args.provided!.add(arg);
    let value: string | undefined;
    if (takes.has(arg)) {
      value = argv[++i];
      // A flag that swallowed the next flag is the classic way to end up
      // pointed at the wrong directory without noticing.
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    }
    switch (arg) {
      case "--dir":
        args.dir = resolve(value!);
        break;
      case "--device":
        args.device = value!;
        args.deviceGiven = true;
        break;
      case "--timeout": {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0)
          throw new Error(`--timeout wants a number of milliseconds, not ${value}`);
        args.timeout = ms;
        break;
      }
      case "--uid": {
        const uid = Number(value);
        if (!Number.isSafeInteger(uid) || uid <= 0)
          throw new Error(`--uid wants a version number, not ${value}`);
        args.uid = uid;
        break;
      }
      case "--to":
        args.to = value!;
        break;
      case "--ttl":
        args.ttlMs = parseDuration(value!);
        break;
      // Checked here rather than at the vault, so a name that cannot be
      // one is refused before anything is opened.
      case "--config-dir":
        args.configDir = configFolderName(value!);
        break;
      // Repeatable. One name per flag rather than a separated list,
      // because a filename may contain a comma and a vault is the wrong
      // place to find out which separator was assumed.
      //
      // Checked, because it is matched against one path segment at a time:
      // an empty name or one with a slash in it matches nothing anywhere,
      // and . and .. are never a segment of a canonical path, so all four
      // were accepted in silence, which is the worst answer available for a
      // flag whose whole job is to keep a folder out.
      case "--ignore":
        if (value === "" || value === "." || value === ".." || value!.includes("/")) {
          throw new Error(
            `--ignore wants one folder or file name, not ${JSON.stringify(value)}: ` +
              `it is matched against each part of a path on its own, so a name with a slash in it matches nothing, and . and .. are never a part`,
          );
        }
        args.ignore.push(value!);
        break;
      case "--limit": {
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit <= 0)
          throw new Error(`--limit wants a count, not ${value}`);
        args.limit = limit;
        args.limitGiven = true;
        break;
      }
      case "--key-file":
        args.keyFile = value!;
        break;
      case "--before": {
        const before = Number(value);
        if (!Number.isSafeInteger(before) || before <= 0)
          throw new Error(`--before wants a version number, not ${value}`);
        args.before = before;
        break;
      }
      case "--mode":
        if (!["content", "filename", "both", "tag"].includes(value!)) {
          throw new Error(`--mode is content, filename, both or tag, not ${value}`);
        }
        args.mode = value!;
        break;
      case "--folder":
        args.folder = value!;
        break;
      case "--context": {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0 || n > SEARCH_CONTEXT_MAX)
          throw new Error(`--context wants 0 to ${SEARCH_CONTEXT_MAX} lines, not ${value}`);
        args.context = n;
        break;
      }
      case "--after":
        args.after = value!;
        break;
      case "--case-sensitive":
        args.caseSensitive = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--verify":
        args.verify = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--no-merge":
        args.merge = false;
        break;
      case "--read-only":
        args.readOnly = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--version":
      case "-V":
        args.version = true;
        break;
      case "--watch":
        args.watch = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // A lone dash is the documented standard-input argument for secrets.
        if (arg !== "-" && arg.startsWith("-")) throw new Error(`no such option: ${arg}`);
        if (args.command === undefined) args.command = arg;
        else args.rest.push(arg);
    }
  }
  return args;
}

/* ---------------------------------------------------------------- *
 * Small things
 * ---------------------------------------------------------------- */

/**
 * The config of a paired device, refusing a vault that is not paired and a
 * pairing that has not finished.
 *
 * The second in its own words and as a `NoCredential`, because every command
 * that connects comes through here and a pending pairing is neither reachable
 * nor refused (rule 7): nothing was asked of the server, and "not authorised"
 * would send somebody after a server problem that is not there. `status` does
 * not come through here, because describing that state is its job.
 */
async function mustLoad(dir: string): Promise<Config> {
  const config = await loadConfig(dir);
  if (!config) throw new Error(notPaired(dir));
  if (isPendingPairing(config)) throw new NoCredential(unfinishedPairing(dir));
  return config;
}

/**
 * An id as it has to be typed after a command.
 *
 * Base64url's alphabet includes `-`, and an id beginning with one is read as
 * an option: `trew uninvite -Xy...` was refused with "no such option". Ids this
 * client and the server make avoid a leading dash, and one from anywhere else
 * still can have one, so a command printed for a person to copy puts `--`
 * before it, which is what every word after it being a word means.
 */
export function asTyped(id: string): string {
  return id.startsWith("-") ? `-- ${id}` : id;
}

/** What every command says in a vault that is not paired, with the way to pair it. */
function notPaired(dir: string): string {
  return `${dir} is not paired. Run trew pair with an invite. ${WHERE_INVITES_COME_FROM}`;
}

/**
 * What a command says about a pairing that has not finished.
 *
 * The redemption may have been sent and not answered, or not sent at all
 * before whatever stopped it, and the pending pairing on disk is the same
 * either way: whether the server registered this device is what is not known.
 * `trew pair` asks, with the credential already saved, and the server answers
 * `redeemed` again if it did, even after the invite has expired.
 */
function unfinishedPairing(dir: string): string {
  return (
    `the pairing in ${dir} has not finished: an invite was being redeemed and no answer was ` +
    `heard, so whether the server registered this device is not known. Run trew pair here to ` +
    `finish it with the credential already saved, which works even after the invite has ` +
    `expired if the server did register it.`
  );
}

/**
 * A path as a terminal can show it: every control character spelled out.
 *
 * The paths `status` prints are ones the last sync could not sync, and one of
 * the reasons the server refuses a path is a control character in it
 * (plan/protocol.md, "Paths"). Printed raw, that character is invisible at
 * best, and an escape sequence is an instruction to the terminal rather than a
 * name. Everything else is left as it is, because a person reads a name best
 * as itself; `spellOut` in core goes further, for the one refusal where two
 * spellings have to be told apart.
 */
function visible(path: string): string {
  let out = "";
  for (const ch of path) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? `\\u{${code.toString(16)}}` : ch;
  }
  return out;
}

/**
 * A duration as a person types one: `10m`, `1h`, `90s`, or plain seconds.
 *
 * Bounded above by what the server allows, an hour, which is also its
 * default, so the answer is one it will give rather than one it will quietly
 * cap. Nothing here asks for an invite that never expires: that is `trewd
 * invite -ttl 0` on the server, a deliberate act by whoever runs it.
 */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(`--ttl wants a duration like 10m, 90s or 1h, not ${text}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const ms = n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  if (ms <= 0) throw new Error("--ttl must be more than nothing");
  if (ms > 3_600_000)
    throw new Error("--ttl can be at most 1h, which is the most the server allows");
  return ms;
}

/** A timestamp somebody can read, which is the point of a recovery listing. */
function when(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown         ";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
