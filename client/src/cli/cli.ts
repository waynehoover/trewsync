import { cmdMcp } from "./mcp.ts";
import { cmdMcpToken } from "./mcp-token.ts";
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

import { open as openFile, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { generateSecret, randomBytes } from "../core/crypto.ts";
import {
  Client,
  Registrar,
  adviseAfterRegistering,
  attentionLines,
  didSomething,
  needsAttention,
  rebaseCursors,
  redeemInvite,
  refuseUnlessAhead,
  registerAsDevice,
  runForever,
  whatTheDiskHolds,
  type DeviceRow,
  type InviteRow,
  type JoiningVault,
} from "../core/client.ts";
import { REJOIN_ADVICE, type SyncReport } from "../core/engine.ts";
import {
  NoCredential,
  deviceCredential,
  formatPairing,
  isInvite,
  normaliseUrl,
  parseInvite,
  parsePairing,
  parseSetup,
  type Invite,
} from "../core/pairing.ts";

export { normaliseUrl };
import {
  DEFAULT_CONFIG_DIR,
  JsonIndexStore,
  NodeVault,
  configFolderName,
  syncDirectoryIfSupported,
} from "./vault.ts";
import {
  configPath,
  indexPath,
  loadConfig,
  orphanedIndex,
  removeIndex,
  removeState,
  saveConfig,
  type Config,
} from "./config.ts";
import type { Displaced, Inventory } from "../core/displaced.ts";
import { lockVault, unlockVault } from "./lock.ts";
import { ConnectionError, MAX_NAME_BYTES, ProtocolError } from "../core/transport.ts";
import { describeOutcome, exitCodeOf, outcomeOf } from "../core/outcome.ts";
import { rotateVault } from "../core/rotation.ts";
import { validateStoredState } from "../core/stored-state.ts";
import type { StoredState } from "../core/vault.ts";

/**
 * The client's release, written in by the build.
 *
 * esbuild defines it from package.json when it makes `dist/telimus.mjs`, so the
 * one file somebody installs says which release it is and the version matrix
 * in docs/server.md has a number to name. Under the test runner nothing
 * defines it and the fallback says so rather than inventing a number.
 */
declare const __TELIMUS_VERSION__: string | undefined;
export const VERSION: string =
  typeof __TELIMUS_VERSION__ === "string" ? __TELIMUS_VERSION__ : "development";

/** Where output goes, so a test can read it. */
export interface Console {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `telimus: self-hosted sync for Obsidian

  telimus init HOST:PORT#TOKEN               start a new vault, with the line the server printed
  telimus invite                             print a single-use invite for another device
  telimus uninvite ID                        cancel an outstanding invite, from telimus devices
  telimus pair INVITE                        add this device to a vault, with an invite or its
                                            recovery key
  telimus sync                               sync once and exit
  telimus sync --watch                       sync, then keep syncing
  telimus mcp                                serve notes over stdio, or HTTP with --listen
  telimus mcp-token                          issue or rotate the HTTP MCP credential
  telimus status                             what this device thinks the state is
  telimus preview                            show planned sync changes without writing notes
  telimus devices                            every device that may reach this vault
  telimus rename NAME                        change this device's name in the device list
  telimus revoke ID                          stop one device connecting, from telimus devices
  telimus deleted                            notes the server still has and you do not
  telimus history PATH                       every version the server holds of one note
  telimus restore PATH                       put a note back, newest version first
  telimus repair                             resend bodies the server has lost, from this device
  telimus rotate RECOVERY-KEY                give the vault a new secret, keeping its history
  telimus rebase --backup-taken              rejoin a server restored from an older backup
  telimus unlink                             forget the pairing, keep the notes
  telimus unlock                             clear a lock left behind by a telimus that crashed
  telimus --version                          which release this is

Options
  --dir DIR        the vault (default: the current directory)
  --vault NAME=DIR mcp only: explicitly named absolute vault directory; repeatable, replaces --dir
  --device NAME    what this device calls itself (default: its hostname and four random characters)
  --vault-id ID    which vault on the server (default: default)
  --json           machine-readable output
  --timeout MS     how long to wait on the server (default: 30000)
  --listen [ADDR]  mcp over HTTP (default: 127.0.0.1:3010); requires an mcp-token credential
  --writable       allow HTTP MCP mutations; requires --listen and a writable device
  --allow-origin O allow this exact HTTP origin; repeatable, requires --listen
  --revoke         mcp-token only: revoke HTTP access without restarting the service
  --allow-last     revoke the last device, leaving the vault reachable only by its recovery key.
                   Needs --recovery-key: it is the one revocation a device cannot undo
  --no-merge       never combine two edits to one note; keep both versions instead. Merging is the
                   only thing that makes content neither device wrote, and this is how to say no
  --read-only      apply what the server has and send nothing: no uploads, no deletions, no
                   conflict copies going out. For a mirror that should not change the vault
                   everyone else sees. This client declining to write, not the server refusing
                   it. Recorded in the config by init and pair, so a cron job cannot lose it by
                   forgetting the flag
  --force          for unlock: clear a lock held on another machine. This one cannot tell whether
                   that process is still running, so saying it is not is your assertion. It will
                   not break a lock held by a process on this machine that is still running
  --recovery-key K run devices, revoke or uninvite with the vault's recovery key instead of this
                   device's credential, for the last device and for a vault with no device to ask
  --ttl DURATION   how long an invite lasts, like 10m or 1h (default: 10m, at most 1h)
  --uid N          restore one exact version, from telimus history
  --to PATH        restore somewhere other than where it came from
  --limit N        how many versions history or deleted shows (default: 20, or all deletions)
  --before UID     for history or deleted: the page before this version
  --verify         for sync: read every file to verify the content cache
  --key-file PATH  read the recovery key, invite or setup string from a file
  --key-out PATH   save a generated key in a new private file
                   mcp-token: outside the vault, prints only the id and path
                   recovery keys: also printed to stdout
  --config-dir DIR Obsidian's config folder, if it is not .obsidian
  --ignore NAME    a folder or file name never to sync, at any depth, repeatable; local to this
                   device. A path another device syncs and this one ignores is reported as
                   ignored rather than failed, and does not affect the exit code
`;

export async function run(argv: readonly string[], io: Console): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(String((err as Error).message));
    return 2;
  }

  // stdout belongs to MCP even when startup or usage fails.
  if (args.command === "mcp") io = { out: io.err, err: io.err };

  if (args.version) {
    io.out(args.json ? JSON.stringify({ ok: true, version: VERSION }) : VERSION);
    return 0;
  }
  if (args.help || args.command === undefined) {
    io.out(USAGE);
    return args.command === undefined && !args.help ? 2 : 0;
  }

  try {
    validateUsage(args);
  } catch (err) {
    const error = (err as Error).message;
    if (args.json) io.out(JSON.stringify({ ok: false, error }));
    else io.err(`telimus: ${error}`);
    return 2;
  }

  try {
    // Anything that changes the vault, its config or its index takes the
    // vault's lock for as long as it runs. Reading commands do not: they
    // load the index once and talk to the server, and holding a lock for
    // them would make `status` refuse while a watcher is running, which is
    // exactly when somebody asks.
    switch (args.command) {
      case "init":
        return await locked(args, () => cmdInit(args, io));
      case "pair":
        return await locked(args, () => cmdPair(args, io));
      case "devices":
        return await cmdDevices(args, io);
      case "rename":
        return await locked(args, () => cmdRename(args, io));
      case "revoke":
        return await cmdRevoke(args, io);
      case "rotate":
        return await cmdRotate(args, io);
      case "invite":
        return await cmdInvite(args, io);
      case "uninvite":
        return await cmdUninvite(args, io);
      case "recovery-key":
        throw new Error(NO_RECOVERY_KEY);
      case "rebase":
        return await locked(args, () => cmdRebase(args, io));
      case "mcp":
        return await cmdMcp(args, io, VERSION);
      case "mcp-token":
        return await cmdMcpToken(args, io, writeKeyOut);
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
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    // Every failure arrives here as a sentence rather than a stack. A stack
    // is for a bug in this program; the common failures are a server that is
    // not running and a string that was pasted wrong, and those deserve to
    // be readable.
    const message = withRecovery(err);
    if (args.json) io.out(JSON.stringify({ ok: false, error: message }));
    else io.err(`telimus: ${message}`);
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
  const release = await lockVault(args.dir, `telimus ${args.command ?? ""}`.trim());
  try {
    return await command();
  } finally {
    // Best effort. A lock that cannot be removed names a process that has
    // exited, and the next holder recognises that and takes it over; an
    // error here would only hide the command's own outcome.
    await release().catch(() => {});
  }
}

async function cmdInit(args: Args, io: Console): Promise<number> {
  // One argument, the line the server printed, is the normal way. The two
  // flags are kept for anyone who split it by hand when that was the only way.
  let server = args.server;
  let token = args.token;
  // The line's own vault name, where it carries one, so `--vault-id` and a
  // named setup line cannot disagree about which vault is being claimed.
  let named: string | undefined;
  const setup = await secretFrom(args.rest[0], args, "the setup string");
  if (setup !== undefined) {
    if (server !== undefined || token !== undefined)
      throw new Error("init takes the server's line or --server and --token, not both");
    ({ url: server, token, vaultId: named } = parseSetup(setup));
    if (named !== undefined && args.vaultIdGiven && named !== args.vaultId) {
      throw new Error(
        `the setup line names the vault ${named} and --vault-id says ${args.vaultId}; ` +
          `they have to be the same vault`,
      );
    }
  }
  if (!server || !token)
    throw new Error(
      "init needs the line the server printed on its first run, like host:3003#TOKEN",
    );
  await refuseIfPaired(args.dir);

  const secret = generateSecret();
  const url = normaliseUrl(server);
  const device = deviceNameFor(args);
  // The root, on disk before the claim goes out, and this is the only reason
  // it is ever written here. The claim binds the server to the key this secret
  // derives, for good, so a secret that claimed a server without reaching the
  // disk first is a vault nobody can ever open. Read back rather than trusted:
  // not written, not renamed, but readable and decoding to itself.
  const starting: Config = {
    url,
    vaultId: named ?? args.vaultId,
    device,
    secret,
    // Recorded here rather than left to the flag (I29). A mirror that becomes
    // writable when a cron line loses an argument has been made conditional
    // rather than safe, and there is no flag that turns this back off.
    ...(args.readOnly ? { readOnly: true } : {}),
  };
  await saveConfig(args.dir, starting);
  await mustReadBack(args.dir, starting);

  // The recovery key, worked out before anything is sent and printed after.
  // This is the only moment it exists anywhere: registering below replaces the
  // root on disk with this device's own credential on purpose, so if this
  // string is not written down now there is no command that can print it again.
  const recoveryKey = formatPairing({ url, vaultId: starting.vaultId, secret });

  // Claim the vault and register this device's row now, rather than leaving
  // either to whenever this device first syncs.
  //
  // init used to write a config and contact nothing, so it reported a paired
  // vault that the server had never heard of. A second device pairing and
  // syncing before this one ever did was refused with "not authorised for
  // this vault": true, unhelpful, and indistinguishable from a bad key.
  //
  // The config is kept if this throws, root and all. The claim may have
  // committed with the reply lost, and a config discarded in that case is a
  // vault that nothing will ever open again: the secret in it is the only copy
  // on this machine. Every command from here on refuses it and prints the key
  // back out, which is what "pair again with it" needs to be possible.
  // Out before the registration, not after it (F02).
  //
  // The registration replaces the root on this disk with this device's own
  // credential, and printing the key afterwards meant the window between the
  // replacement and the print had no copy of it anywhere: a crash there left
  // a working device and a vault nobody can ever recover. The catch below
  // already prints it, which covers a failure and not a kill.
  //
  // On stderr under --json, because stdout is one object and a second thing
  // written there is a parse error for whatever is reading it. That is where
  // the failure path has always printed it.
  const sayKey = (): void => {
    const say = args.json ? io.err.bind(io) : io.out.bind(io);
    say("This is the vault's recovery key. Write it down and keep it offline:");
    say("");
    say(`  ${recoveryKey}`);
    say("");
    say("It is shown once and this device does not keep it: what is on disk here is this");
    say("device's own credential, which can be revoked on its own. Adding a device does not");
    say("need it, telimus invite does that; the recovery key replaces the vault's secret and is");
    say("the only way back if every device is lost. Anyone who has it has the vault, and the");
    say("server has never seen it.");
    say("");
  };
  sayKey();
  // Also to a file, when asked, so a script has somewhere to keep it that is
  // not a terminal. Before the registration for the same reason the printing
  // is: everything after this is allowed to fail (F02, I12).
  if (args.keyOut !== undefined) await writeKeyOut(args.keyOut, recoveryKey);

  let registered = false;
  try {
    await joinVault(
      {
        url,
        vaultId: args.vaultId,
        device,
        secret,
        bootstrap: token,
        ...(args.readOnly ? { readOnly: true } : {}),
      },
      args,
      io,
      () => {
        registered = true;
      },
    );
  } catch (err) {
    // What to do next is read off the disk rather than off which step threw
    // (rule 4), by the same counsellor `pair` and the panel use, so the four
    // states get the same four answers wherever a registration stops. This one
    // used to say only "unlink here, and pair with that key", which left out
    // the row the registration may already have committed: pairing again
    // registers a second one without explaining the abandoned registration. state.test.ts, "names the row a failed init left".
    const remains = await whatTheDiskHolds(() => loadConfig(args.dir));
    io.err("telimus: the vault was started but this device could not register itself with it:");
    io.err(`  ${(err as Error).message}`);
    io.err("Write this recovery key down now, before anything else:");
    io.err(`  ${recoveryKey}`);
    io.err(adviseAfterRegistering({ remains, registered, surface: "cli", where: args.dir }));
    return 1;
  }

  if (args.json) {
    io.out(JSON.stringify({ ok: true, paired: args.dir, device, recoveryKey }));
  } else {
    io.out(`Started the vault. ${args.dir} is paired as "${device}".`);
  }
  return 0;
}

/** Registers this device with a vault it holds the root of, saving durably and reading back. */
async function joinVault(
  joining: JoiningVault,
  args: Args,
  io: Console,
  onRegistered?: () => void,
): Promise<Config> {
  return registerAsDevice(
    joining,
    async (device) => {
      await saveConfig(args.dir, device);
      await mustReadBack(args.dir, device);
    },
    {
      timeoutMs: args.timeout,
      ...(onRegistered !== undefined ? { onRegistered } : {}),
      ...(args.verbose ? { log: (m: string) => io.err(`  ${m}`) } : {}),
    },
  );
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
  // in `telimus devices`, so quietly handing back a different one is worse
  // than saying no. `checkName` does the refusing.
  if (args.deviceGiven) return args.device;

  // A derived one is not theirs, and refusing it means `telimus init` fails on
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
 * Refuses to pair a vault that is paired, or that still holds an index.
 *
 * Re-pairing over a paired vault would replace this device's credential and
 * the data key it holds, and if the new string is for another vault every note
 * already on the server becomes undecryptable here. It also strands the row
 * this device already has, which nothing left on this machine can then revoke.
 * An index with no config beside it is an unlink that did not finish, and
 * pairing over it would load an index describing another vault's sync.
 */
async function refuseIfPaired(dir: string): Promise<void> {
  if (await loadConfig(dir)) {
    throw new Error(`${dir} is already paired. Use unlink first if that is really what you want.`);
  }
  if (await orphanedIndex(dir)) {
    throw new Error(
      `${dir} is not paired but still holds an index at ${indexPath(dir)}, ` +
        `left by an unlink that did not finish. Run telimus unlink to clear it, then pair again.`,
    );
  }
}

/**
 * Adds this device to a vault, with an invite or with the vault's recovery key.
 *
 * An invite is the ordinary way and the recovery key is the last resort. Both
 * end in the same place: this device holds a row of its own, the credential
 * for it and the vault's data key, and no root. That is what makes revoking
 * this device on its own mean anything.
 *
 * The two differ in what is on the wire and so in when the config is written.
 *
 * An **invite** is spent by the redemption that registers this device, in one
 * server transaction, so there is nothing to write until it has answered: the
 * id and the key it registered are made in that call and come back with the
 * data key. A crash before the reply lands leaves this vault unpaired and one
 * row on the server that nobody holds the key to, which shows up in `telimus
 * devices` as a device that has never connected and goes with `telimus revoke`.
 * The alternative order strands this device instead; see `redeemInvite`.
 *
 * A **recovery key** buys a registrar session: it may register a device and
 * rewrap the vault's secret, and it may not sync. So that path is
 * register-then-save, and nothing is written until the row exists: the key was
 * pasted in a moment ago, so there is nothing on this disk yet worth keeping
 * and a key that turns out to be wrong should leave the vault exactly as
 * unpaired as it found it. A crash between the registration and the save
 * leaves the same orphan row the invite path leaves, and the same way to see
 * and remove it. See `registerAsDevice`.
 *
 * What a failure after the registration is told to do comes from
 * `adviseAfterRegistering`, which `init` and both of the panel's pairing paths
 * also take their words from.
 */
async function cmdPair(args: Args, io: Console): Promise<number> {
  const given = await secretFrom(args.rest[0], args, "the invite or recovery key");
  if (!given) throw new Error("pair needs the invite or recovery key another device printed");
  await refuseIfPaired(args.dir);
  if (isInvite(given)) return await pairWithInvite(parseInvite(given), args, io);

  const pairing = parsePairing(given);
  const joining: JoiningVault = {
    url: pairing.url,
    vaultId: pairing.vaultId,
    device: deviceNameFor(args),
    secret: pairing.secret,
    // The mirror case (I29). `init --read-only` and `pair --read-only` both
    // have to record it, and only `init` did: this is the path a second
    // device takes, which is the one a mirror actually uses.
    ...(args.readOnly ? { readOnly: true } : {}),
  };
  let paired: Config;
  let registered = false;
  try {
    paired = await joinVault(joining, args, io, () => {
      registered = true;
    });
  } catch (err) {
    if (!registered) throw err;
    // Registered, and then what the disk says rather than which step threw
    // (rule 4). The `.catch(() => undefined)` this used to read it with is
    // what the counsellor exists to replace: it made an unreadable config look
    // like an absent one, so a save that succeeded with a read-back that then
    // failed was told to revoke a row it was itself holding the key to.
    // state.test.ts, "will not send somebody revoking a row".
    const remains = await whatTheDiskHolds(() => loadConfig(args.dir));
    throw new Error(
      `${(err as Error).message}. ` +
        adviseAfterRegistering({ remains, registered, surface: "cli", where: args.dir }),
    );
  }

  if (args.json) {
    io.out(
      JSON.stringify({
        ok: true,
        paired: args.dir,
        device: paired.device,
        deviceId: paired.deviceId,
        url: paired.url,
      }),
    );
  } else {
    io.out(`Paired ${args.dir} with ${paired.url} as "${paired.device}". Run telimus sync.`);
    io.out(
      `This device has its own credential now, and not the recovery key: ` +
        `telimus revoke ${paired.deviceId} on any device stops it connecting.`,
    );
  }
  return 0;
}

/**
 * Pairs with an invite: redeem, save, connect.
 *
 * The redemption is the registration, so what comes back is a finished device:
 * this config never holds a root, at any point.
 *
 * Saved and read back before the connection is made, because at the moment the
 * reply lands the only copy of the data key on this machine is in this
 * process, and the invite that carried it is already spent (rule 4). Then the
 * connection, because a pairing that says "paired" without having reached the
 * server is how a wrong address is found out later, from a sync that fails
 * (I13).
 */
async function pairWithInvite(invite: Invite, args: Args, io: Console): Promise<number> {
  const device = deviceNameFor(args);
  const redeemed = await redeemInvite(invite, device, {
    timeoutMs: args.timeout,
    ...(args.verbose ? { log: (m: string) => io.err(`  ${m}`) } : {}),
  });
  const config: Config = {
    url: invite.url,
    vaultId: invite.vaultId,
    device,
    deviceId: redeemed.deviceId,
    deviceSecret: redeemed.deviceSecret,
    dataKey: redeemed.dataKey,
    // The third of three places that write this config, and the one a mirror
    // actually goes through: a second device is added with an invite (I29).
    // The other two are `init` and pairing with a recovery key.
    ...(args.readOnly ? { readOnly: true } : {}),
  };
  await saveConfig(args.dir, config);
  await mustReadBack(args.dir, config);
  // The row exists and this is the only copy of its credential, so a failure
  // from here leaves the config alone: the next command finishes what this
  // started rather than making somebody find another invite.
  const client = await open(config, args, io, { waitForBacklog: false });
  await client.close();

  if (args.json) {
    io.out(
      JSON.stringify({
        ok: true,
        paired: args.dir,
        device: config.device,
        deviceId: config.deviceId,
        url: config.url,
      }),
    );
  } else {
    io.out(`Paired ${args.dir} with ${config.url} as "${config.device}". Run telimus sync.`);
    io.out(
      `This device has its own credential, and not the vault's recovery key: ` +
        `telimus revoke ${config.deviceId} on any device stops it connecting.`,
    );
  }
  return 0;
}

/**
 * Prints a single-use invite for another device.
 *
 * The vault's data key goes to the server sealed under a key that stays in the
 * string, for ten minutes unless asked otherwise, and the string works once.
 * Nothing about the vault is shown: the string is where to ask, which vault,
 * and how to open what is handed back.
 *
 * This is how a device is added. The recovery key is not: it stays written
 * down for the day every device is gone, and no device holds one to print.
 */
async function cmdInvite(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
  let issued: { invite: string; expiresAt: number };
  try {
    issued = await client.invite(args.ttlMs);
  } finally {
    await client.close();
  }
  if (args.json) {
    io.out(JSON.stringify({ ok: true, invite: issued.invite, expiresAt: issued.expiresAt }));
    return 0;
  }
  io.out(issued.invite);
  io.out("");
  io.out(`Paste it into telimus pair, or into the Telimus panel, on the new device.`);
  io.out(`It works once and expires at ${when(issued.expiresAt)}.`);
  return 0;
}

/**
 * Proves the config is on disk and decodes to itself before anything relies
 * on it. Not written, not renamed, but readable: what is in it is the only
 * copy this device has, whether that is a vault's root before its claim or a
 * device's credential after its registration.
 */
async function mustReadBack(dir: string, config: Config): Promise<void> {
  const back = await loadConfig(dir);
  if (!back || back.url !== config.url) {
    throw new Error(`${configPath(dir)} did not read back as what was just written`);
  }
  const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
    a === undefined ? b === undefined : b !== undefined && Buffer.compare(a, b) === 0;
  // Every key, by name, because each of the three is the only copy of itself
  // in one of the two states a config is written in, and a read-back that
  // checked one of them would pass over the write that lost another.
  // `deviceId` too: a device secret that landed under a different id is a
  // credential for a row that is not this device's.
  if (
    !same(back.secret, config.secret) ||
    !same(back.deviceSecret, config.deviceSecret) ||
    !same(back.dataKey, config.dataKey) ||
    back.deviceId !== config.deviceId
  ) {
    throw new Error(`${configPath(dir)} did not read back with the keys that were written`);
  }
}

/**
 * What `telimus recovery-key` says now, and why there is nothing to print.
 *
 * It used to print the vault's root secret out of this device's config. No
 * device holds one since protocol 4, which is the whole of why revoking one
 * means anything, so the command has nothing to read. Adding a device is
 * `telimus invite`, which is what it was for anyway.
 */
const NO_RECOVERY_KEY =
  "this device does not hold the vault's recovery key. It was shown once, when the vault was " +
  "started, and it is not on any device on purpose: a device that held it could re-derive " +
  "the vault's credential and register itself again, so revoking it would stop nothing. " +
  "To add a device, run telimus invite here. If the recovery key is lost, telimus rotate needs " +
  "the old one, so there is nothing this can print.";

/**
 * Opens a session holding the vault's recovery key rather than this device's
 * own credential.
 *
 * Two commands take one. Revoking the last device needs it, because that is
 * the one revocation nothing on a device can undo. Listing accepts it for the
 * vault that has no paired device left to ask: unused registrations can
 * still be inspected and revoked.
 *
 * The key names its own server and vault, so this works in a directory that
 * was never paired. When there is a config here it has to agree, or a key
 * pasted from the wrong vault would act on that vault while the person read
 * this one's name off the screen.
 */
async function asRecoveryKey(given: string, args: Args): Promise<Registrar> {
  const key = parsePairing(given);
  const config = await loadConfig(args.dir);
  if (config && config.vaultId !== key.vaultId) {
    throw new Error(
      `that recovery key is for vault "${key.vaultId}" and this directory is paired with ` +
        `"${config.vaultId}", so it would act on a vault this device is not on`,
    );
  }
  return Registrar.open({
    // A paired directory chooses the target, as it does for rotation. Most
    // servers call their vault "default", so the name alone cannot distinguish
    // a key pasted from another server. This also keeps old recovery keys
    // usable after updating the saved server address.
    url: config?.url ?? key.url,
    vaultId: key.vaultId,
    device: config?.device ?? "recovery-key",
    secret: key.secret,
    timeoutMs: args.timeout,
  });
}

/**
 * Every device that may reach this vault.
 *
 * The only way to answer "what is still connected to my notes", which is the
 * question a device list exists for.
 *
 * A row that has never connected is flagged rather than left to be read out of
 * a blank column, because those are the reclaimable ones. A redemption saves
 * nothing on the new device until the server has answered, so a crash in that
 * window strands a row on the server instead of a device that thinks it is
 * paired: the right way round, and it means the rows that pile up against the
 * cap are exactly the ones nothing has ever connected under.
 */
async function cmdDevices(args: Args, io: Console): Promise<number> {
  const { devices, maxDevices, invites, thisDevice, close } = await openDeviceList(args, io);
  try {
    if (args.json) {
      io.out(
        JSON.stringify({
          ok: true,
          devices,
          maxDevices,
          invites,
          ...(thisDevice !== undefined ? { thisDevice } : {}),
        }),
      );
      return 0;
    }
    for (const d of devices) {
      const mine = d.id === thisDevice ? "  (this device)" : "";
      // The id first, because it is what `telimus revoke` takes and the name
      // is not: two laptops may both be called laptop, and a list that put
      // the name where the identity goes would invite revoking the wrong one.
      io.out(
        `${d.id.padEnd(24)}  ${d.name.padEnd(16)}  added ${when(d.createdAt)}  ` +
          `${d.lastSeen === 0 ? "never connected " : `last seen ${when(d.lastSeen)}`}${mine}`,
      );
    }
    io.out("");
    const count =
      maxDevices > 0
        ? `${devices.length} of at most ${maxDevices} devices`
        : `${devices.length} ${devices.length === 1 ? "device" : "devices"}`;
    io.out(`${count}. telimus revoke ID stops one.`);
    const stale = devices.filter((d) => d.lastSeen === 0);
    if (stale.length > 0) {
      io.out(
        `${stale.length} of them ${stale.length === 1 ? "has" : "have"} never connected. A pairing ` +
          `that reached the server and then crashed can leave a row like that.`,
      );
    }
    io.out(
      "Revoking stops a device connecting. It does not un-read what that device already read:",
    );
    io.out(
      "it still holds the vault's key and can decrypt later encrypted content obtained elsewhere.",
    );
    io.out(
      "If the recovery key was exposed, use telimus rotate. Rotation does not change the data key.",
    );
    // The invites, beside the rows, because they are the same question. A row
    // is a device that was added and an outstanding invite is one about to be:
    // a string issued on a device somebody has just lost is the thing worth
    // seeing, and until this it was invisible until it was redeemed.
    io.out("");
    if (invites.length === 0) {
      io.out("No outstanding invites.");
    } else {
      for (const inv of invites) {
        io.out(`${inv.id.padEnd(24)}  invite, expires ${when(inv.expiresAt)}`);
      }
      io.out("");
      io.out(
        `${invites.length} outstanding ${invites.length === 1 ? "invite" : "invites"}. Each one ` +
          `registers one device and then stops working. telimus uninvite ID cancels one you did ` +
          `not mean to issue.`,
      );
    }
    return 0;
  } finally {
    await close();
  }
}

/**
 * Cancels an outstanding invite.
 *
 * The companion to seeing them. An invite is a standing authority to register
 * one device, and before it could be listed the only ways to retire one were
 * to wait out its hour or to rotate the vault, which retires the recovery key
 * with it. Neither is an answer to "I issued that on the laptop I have just
 * lost".
 */
async function cmdUninvite(args: Args, io: Console): Promise<number> {
  const invite = await secretFrom(args.rest[0], args, "the invite");
  if (!invite) throw new Error("uninvite needs an invite id, from telimus devices");
  const canceller = await openRevoker(args, io);
  try {
    await canceller.uninvite(invite);
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "badentry") {
      // One refusal for unknown, expired and already redeemed, because saying
      // which would tell somebody guessing identifiers that they had found a
      // real one. What it can say is where to look.
      throw new Error(
        `this vault has no outstanding invite ${invite}: it may have expired, or been redeemed, ` +
          `in which case it is a device row now. telimus devices shows both.`,
      );
    }
    throw err;
  } finally {
    await canceller.close();
  }
  if (args.json) {
    io.out(JSON.stringify({ ok: true, cancelled: invite }));
    return 0;
  }
  io.out(`Cancelled ${invite}. That string no longer adds a device.`);
  io.out(
    "It does not touch a device already added with it. If it was redeemed before this, the " +
      "device it added is a row in telimus devices, and telimus revoke ID is what stops that.",
  );
  return 0;
}

/**
 * Whoever is doing the revoking: this device, or the recovery key.
 *
 * The same two ways in as the list, and the same reason for the second one.
 * Both objects answer `revoke` identically, because it is the same op on the
 * wire; what differs is only whether the server will honour `allowLast`.
 */
async function openRevoker(
  args: Args,
  io: Console,
): Promise<{
  revoke: (id: string, opts: { allowLast?: boolean }) => Promise<{ self: boolean }>;
  uninvite: (invite: string) => Promise<void>;
  close: () => Promise<void>;
}> {
  if (args.recoveryKey !== undefined) {
    const registrar = await asRecoveryKey(args.recoveryKey, args);
    return {
      revoke: (id, opts) => registrar.revoke(id, opts),
      uninvite: (invite) => registrar.uninvite(invite),
      close: async () => registrar.close(),
    };
  }
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
  return {
    revoke: (id, opts) => client.revoke(id, opts),
    uninvite: (invite) => client.uninvite(invite),
    close: () => client.close(),
  };
}

/**
 * The device list, from whichever credential was offered.
 *
 * Two ways in, one shape out. `thisDevice` is absent over the recovery key,
 * because a registrar is not a device and there is no row for it to be: a
 * list that guessed one would put "(this device)" against somebody else.
 */
async function openDeviceList(
  args: Args,
  io: Console,
): Promise<{
  devices: DeviceRow[];
  maxDevices: number;
  invites: InviteRow[];
  thisDevice?: string;
  close: () => Promise<void>;
}> {
  if (args.recoveryKey !== undefined) {
    const registrar = await asRecoveryKey(args.recoveryKey, args);
    try {
      return {
        ...(await registrar.devices()),
        close: async () => registrar.close(),
      };
    } catch (err) {
      registrar.close();
      throw err;
    }
  }
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false, inspect: true });
  try {
    return {
      ...(await client.devices()),
      thisDevice: client.deviceId,
      close: () => client.close(),
    };
  } catch (err) {
    await client.close();
    throw err;
  }
}

/**
 * Stops one device connecting, and closes whatever it has open.
 *
 * Both, and the reply means both: a row removed while the revoked device holds
 * an authenticated connection is a revocation it does not notice.
 *
 * Any device may do this to any other, which is the whole point of having
 * revocation rather than rotation: a phone cuts off a stolen laptop without
 * anybody digging the recovery key out of a drawer. The exception is
 * `--allow-last`, which needs the recovery key, because emptying the vault is
 * the one revocation nothing on a device can undo.
 */
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
  if (!name) throw new Error("rename needs a name: telimus rename laptop");
  // `deviceGiven`, because this name was typed. Without it `deviceNameFor`
  // takes the derived path and appends a random tail, so `telimus rename laptop`
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
    if (args.json) io.out(JSON.stringify({ ok: false, renamed: true, name: said, saved: false }));
    return 1;
  }

  if (args.json) {
    io.out(JSON.stringify({ ok: true, renamed: true, name: said, saved: true }));
    return 0;
  }
  io.out(`This device is now ${said} in the device list.`);
  // Said because it is the half a person would otherwise discover from a
  // filename months later, and because it is not a fault to be fixed.
  io.out("Conflict copies made before now keep the old name; they are notes, not labels.");
  return 0;
}

async function cmdRevoke(args: Args, io: Console): Promise<number> {
  const deviceId = args.rest[0];
  if (!deviceId) throw new Error("revoke needs a device id, from telimus devices");
  // Refused here as well as at the server, so somebody who typed it gets the
  // whole command back rather than a round trip and a refusal. The server's
  // is the one that enforces it; this one is the one that helps.
  if (args.allowLast && args.recoveryKey === undefined) {
    throw new Error(
      `--allow-last leaves a vault only its recovery key can reach, and it is the one revocation ` +
        `no device can undo, so it takes that key: telimus revoke ${deviceId} --allow-last ` +
        `--recovery-key basalt3_...`,
    );
  }
  const revoker = await openRevoker(args, io);
  let self: boolean;
  try {
    ({ self } = await revoker.revoke(deviceId, { allowLast: args.allowLast }));
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "nodevice") {
      throw new Error(
        `this vault has no device with id ${deviceId}, so the list you were reading is stale. ` +
          `Run telimus devices again.`,
      );
    }
    if (err instanceof ProtocolError && err.code === "badentry" && !args.allowLast) {
      // The last device. Over the recovery key that is the confirmation being
      // asked for; from a device it is the credential as well, and saying so
      // is the difference between an instruction and a dead end.
      const said = err.message.replace(/; resend with allowLast.*$/, "");
      throw new Error(
        args.recoveryKey !== undefined
          ? `${said}. Say it out loud to do it anyway: telimus revoke ${deviceId} --allow-last ` +
              `--recovery-key basalt3_...`
          : `${said}. That is the recovery key's to do, not a device's: telimus revoke ${deviceId} ` +
              `--allow-last --recovery-key basalt3_...`,
      );
    }
    throw err;
  } finally {
    await revoker.close();
  }
  if (args.json) {
    io.out(JSON.stringify({ ok: true, revoked: deviceId, self }));
    return 0;
  }
  io.out(`Revoked ${deviceId}. Its sessions are closed and it cannot connect again.`);
  io.out(
    "It still holds the vault's key and can decrypt later encrypted content obtained elsewhere.",
  );
  io.out(
    "If the recovery key was exposed, use telimus rotate. Rotation does not change the data key.",
  );
  if (self) {
    io.out("");
    io.out(
      `That was this device. It has stopped syncing; run telimus unlink here to forget the pairing, ` +
        `then telimus pair RECOVERY-KEY to add it again if needed.`,
    );
  }
  return 0;
}

/**
 * Gives the vault a new root secret and keeps its history and its devices.
 *
 * It takes the old recovery key on the command line, because no device holds
 * one: rotating is the root's own power, along with registering a device, and
 * this is one of the two moments in a vault's life the root is used.
 *
 * **No device row is touched and every device keeps syncing across this**,
 * which is the expensive half of what per-device credentials removed. A
 * rotation that evicted every device would be a weekend of re-pairing across a
 * laptop, a phone, a desktop and a NAS, and that is how a leaked string goes
 * unrotated.
 *
 * The data key is this device's own, which is the vault's: rotation replaces
 * the wrapping and never the key, so the copy a paired device holds is always
 * current, and there is nothing to fetch before rewrapping it.
 */
async function cmdRotate(args: Args, io: Console): Promise<number> {
  const given = await secretFrom(args.rest[0], args, "the recovery key");
  if (!given) {
    throw new Error(
      "rotate needs the vault's current recovery key, which no device holds: " +
        "telimus rotate basalt3_...",
    );
  }
  const config = await mustLoad(args.dir);
  const { dataKey } = deviceCredential(config);

  const rotation = await rotateVault(
    {
      url: config.url,
      vaultId: config.vaultId,
      device: config.device,
      recoveryKey: given,
      dataKey,
      timeoutMs: args.timeout,
    },
    // Out before the request, and on stderr whatever the output format: stdout
    // is one object under `--json` and a second thing written there is a parse
    // error for whatever is reading it (F03). The shared machine awaits this,
    // so the bytes are gone before the vault can change.
    async (candidate: string) => {
      io.err("The vault is about to get this recovery key. Write it down before pressing on:");
      io.err(`  ${candidate}`);
      // Awaited by the state machine, so a script's copy is on disk before
      // the vault can change under it (I02, I12).
      if (args.keyOut !== undefined) await writeKeyOut(args.keyOut, candidate);
    },
  );

  switch (rotation.kind) {
    case "committed":
      if (rotation.confirmedBy === "probe") {
        // The command looked like it failed and did not. Said before the
        // success block below, because somebody watching a timeout needs to
        // know the key they were shown is the live one.
        io.err(
          "telimus: the reply was lost, but the rotation did commit. The key above is the vault's.",
        );
      }
      return finishRotate(rotation.recoveryKey, args, io);
    case "refused":
      throw new Error(rotation.why);
    case "notCommitted":
      throw new Error(
        `${rotation.why}. The vault still has its old recovery key; cross out the one above.`,
      );
    case "unknown":
      throw new Error(
        `${rotation.why}. Keep both keys and run telimus rotate again with whichever one the ` +
          `server accepts.`,
      );
  }
  // Every arm above returns or throws. Named rather than left implicit,
  // because a fifth outcome added to the union should fail here loudly.
  throw new Error(`unhandled rotation outcome ${JSON.stringify(rotation)}`);
}

function finishRotate(recoveryKey: string, args: Args, io: Console): number {
  if (args.json) {
    io.out(JSON.stringify({ ok: true, rotated: args.dir, recoveryKey }));
    return 0;
  }
  io.out("Rotated. The old recovery key, and every outstanding invite, no longer open this vault.");
  io.out("");
  io.out("This is the new recovery key. Write it down in place of the old one:");
  io.out("");
  io.out(`  ${recoveryKey}`);
  io.out("");
  io.out("Every device keeps syncing: a rotation replaces the vault's secret and touches no");
  io.out("device row. It cannot un-read what a lost device already read, so revoke that device");
  io.out("too, with telimus devices and telimus revoke ID.");
  return 0;
}

/**
 * Rejoins a server that has lost history this device applied.
 *
 * A device ahead of the server is refused with `cursor`, and rightly: the
 * server is a restored backup or the wrong vault, and continuing would reissue
 * uids for different content. The one safe thing to do is to forget what this
 * device believed it had synced and start again from the server's cursor:
 * everything both sides hold identically is agreed, what only this device
 * holds goes up as new versions, and where the two disagree both are kept.
 * Nothing is deleted anywhere.
 *
 * Refused without `--backup-taken`, because the index this removes is the
 * only record of what this device had synced, and the server's own history
 * is what the person is about to add to.
 */
async function cmdRebase(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  // Both numbers from core, so the panel and this cannot disagree about where
  // the two ends are or about when a rebase is allowed.
  const at = await rebaseCursors(await clientOptions(config, args, io));
  const { local, server: serverCursor } = at;
  const say = (line: string) => {
    if (!args.json) io.out(line);
  };
  say(`local cursor   ${local}`);
  say(`server cursor  ${serverCursor}`);

  refuseUnlessAhead(at);
  if (!args.backupTaken) {
    throw new Error(
      `the server is at ${serverCursor} and this device has applied ${local}: the server has lost history. ` +
        `Take a backup of the server (telimus backup) and of this vault, then run telimus rebase --backup-taken`,
    );
  }

  // Same as unlink: a flush that failed is reported and does not stop the
  // rebase, because the index is already gone and starting again from the
  // server's cursor is what was asked for (I18).
  const notDurable = await removeIndex(args.dir);
  if (notDurable !== undefined && !args.json) {
    io.err(`The index was removed, but flushing that removal failed: ${notDurable}`);
  }
  const client = await open(config, args, io);
  try {
    const report = await client.settle({ coalesceWrites: false });
    if (args.json) {
      // The same exit status the text branch gives, and the same `ok` (F26).
      //
      // This returned zero unconditionally, so an incomplete replay was a
      // failure interactively and a success in automation: exactly the
      // difference a cron job cannot see. A rebase that left paths retrying
      // or written off has not finished, whoever is reading.
      const code = exitCodeFor(report, client.vault);
      io.out(
        JSON.stringify({
          ok: code === 0,
          localCursor: local,
          serverCursor,
          replayed: report,
        }),
      );
      return code;
    }
    io.out("");
    io.out("Rebased onto the server's history:");
    renderReport(
      report,
      args,
      io,
      client.serverCursor,
      client.vault.stranded ?? [],
      client.vault.displaced ?? [],
      unknownRecovery(client.vault),
    );
    io.out(`Nothing was deleted. Where the two sides disagreed, both versions were kept.`);
    return exitCodeFor(report, client.vault);
  } finally {
    await client.close();
  }
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
    return exitCodeFor(report, client.vault);
  } finally {
    await client.close();
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
 * A recovery key, an invite or a setup string typed as an argument is in the
 * shell's history file and in `/proc` for every process on the machine while
 * the command runs. That is fine for a one-off on a laptop you own and wrong
 * for a script, a shared box, or anything a person will paste twice.
 *
 * Three ways in, and the argument is still one of them because taking it away
 * would make the common case worse for no gain:
 *
 *   telimus pair basalt3i_...        the argument, as before
 *   telimus pair -                   standard input, for a pipe
 *   telimus pair --key-file ./k      a file, which is what a script should use
 *
 * `-` reads to end of input and trims, so `printf %s "$KEY" | telimus pair -`
 * and a here-doc both work. A file is read whole and trimmed for the same
 * reason. Neither is logged, and neither is echoed back.
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

/**
 * Writes a newly generated recovery key somewhere only its owner can read.
 *
 * The alternative to a key on a terminal, for a script that has to keep one.
 * Created with `wx` so it cannot land on an existing file, and 0600 so it is
 * not readable by anything else on the machine. The key still goes to the
 * usual place as well: a file somebody forgot to look at is not a backup, and
 * this is an addition rather than a redirection.
 */
async function writeKeyOut(path: string, recoveryKey: string): Promise<void> {
  const handle = await openFile(path, "wx", 0o600);
  try {
    await handle.writeFile(`${recoveryKey}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // The directory too, or the file's bytes are durable and its name is not
  // (R02). This is the only copy of a credential nothing can reissue, and a
  // power cut between here and the vault being claimed would leave a vault
  // whose recovery key exists nowhere. The same rule every other durable write
  // in this project follows; this one was written before the rule had a
  // helper and did not get it.
  //
  // A filesystem with no directory fsync says so and is believed; a disk that
  // failed is not, and it is reported, because the whole point of `--key-out`
  // is that the file is there afterwards.
  const flushed = await syncDirectoryIfSupported(dirname(path));
  if (!flushed.synced) {
    throw new Error(
      `wrote the recovery key to ${path}, and could not make that durable: ${flushed.why}. ` +
        `Copy it somewhere else before going on: a power cut now could lose the file, and ` +
        `nothing can reissue this key.`,
    );
  }
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
  await runForever(
    {
      ...(await clientOptions(config, args, io)),
      onPass: (report) => {
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
        io.err(`telimus: a sync failed: ${err.message}. It will try again.`);
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
  if (fatal) {
    io.err(`telimus: ${withRecovery(fatal)}`);
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
  const config = await mustLoad(args.dir);
  // Checked the way the engine checks it, so a status never reports numbers
  // read out of a file the next sync would refuse.
  const stored = validateStoredState(await new JsonIndexStore(indexPath(args.dir)).load());

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
    // The handshake and nothing after it. What is printed below is the
    // server's own cursor out of `ready`, and waiting for the backlog first
    // meant a device weeks behind unsealed all of it before saying a word.
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
    !local.recoveryComplete;

  if (args.json) {
    io.out(JSON.stringify({ ok: !wrong, ...local, server }));
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
    // The paths, not a directory (R50). This said `.telimus/tmp` because that
    // was where the only kind of stranded version lived; a preservation claim
    // that fails now leaves one beside the note it came from, and somebody
    // following the printed path found an empty directory while the only copy
    // of their edit sat under `notes/` with the listing deliberately hiding
    // it. A line that names a place the bytes are not is worse than no line.
    io.out(`kept     ${local.stranded.length} version(s) this client could not put back:`);
    // With the reason where there is one. A path on its own says a file is
    // there and not which note it came off or why, which is a person opening
    // `note.md..telimus-tmp-keep3f9c` to find out.
    const known = new Map(local.displaced.map((d) => [d.at, d]));
    for (const at of local.stranded) {
      io.out(`  ${join(args.dir, at)}`);
      const d = known.get(at);
      if (d !== undefined) io.out(`    from ${d.from}: ${d.why}`);
    }
  }
  if (unjoined) {
    io.out(`state    nothing to connect with: ${server.error}`);
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
 * `telimus verify` finds a chunk the disk rotted or the server quarantined, and
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
      io.out(JSON.stringify({ ok: !wrong, ...out }));
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
        "`telimus verify` on the server for what is still missing: history this device " +
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
      io.out(JSON.stringify({ ok: true, deleted: gone.notes, more: gone.more }));
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
      io.out(
        `${recoverable} deleted, all still recoverable. telimus restore PATH brings one back.`,
      );
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
        `There are older deletions than these. telimus deleted --before ${gone.oldest} ` +
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
    if (args.json) io.out(JSON.stringify({ ok, ...preview, counts: previewCounts(preview) }));
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
      io.out(JSON.stringify({ ok: true, path, versions, limit, nextBefore }));
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
    io.out("telimus restore PATH --uid N brings one of these back.");
    if (nextBefore !== null) io.out(`Older versions: telimus history PATH --before ${nextBefore}`);
    return 0;
  } finally {
    await client.close();
  }
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
          JSON.stringify({
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
          `The restored copy is on this device, but sync did not finish: ${error}. Run telimus sync to retry.`,
        );
      }
      return 1;
    }
    const sent = client.engine.serverHasOurs(done.path);

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
        JSON.stringify({
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
      io.out(
        "The restored copy has not been acknowledged by the server. Run telimus sync to retry.",
      );
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
    // the same unsuccessful run here as it is under `sync` and `rebase`. The
    // note is on this device either way, and the line above says so.
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
 * what `telimus revoke` takes, and a list somebody cannot act on is worse than
 * no list.
 */
/**
 * Clears a lock left behind by a telimus that is not running any more.
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
      JSON.stringify({
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
      io.err(`telimus: the lock was not cleared, because ${outcome.why}.`);
      return 1;
    case "contested":
      io.err(`telimus: ${outcome.why}.`);
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
  if (args.json) {
    io.out(
      JSON.stringify({
        ok: true,
        unlinked: args.dir,
        wasPaired: config !== undefined,
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
        "Check the disk, and run `telimus unlink` again if it does.",
    );
  }
  io.out("Nothing was removed from the server.");
  if (config?.deviceId !== undefined) {
    io.out("");
    io.out(
      `This device is still in the vault's device list as ${config.deviceId}. Nothing here can ` +
        `remove it now, because the credential for it has just been forgotten: run ` +
        `telimus revoke ${config.deviceId} on a device that still syncs.`,
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
 * Nothing is written back either. What a connection used to prove, and this
 * file used to record, is settled by the registration that made the device,
 * before any command connects.
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
   * Reported here as well as by `status`, because somebody who runs `telimus
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
      JSON.stringify({
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
  // `telimus sync` on a timer and nothing else was never told (R46, R50).
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
  vaultId: string;
  /** Whether --vault-id was typed, so a setup line naming a vault can differ. */
  vaultIdGiven: boolean;
  server?: string;
  token?: string;
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
  /** A file holding the recovery key, invite or setup string (I12). */
  keyFile: string | undefined;
  /** Where to write a newly generated recovery key, at 0600 (I12). */
  keyOut: string | undefined;
  mcpRevoke?: boolean;
  mcpListen?: string;
  mcpWritable?: boolean;
  mcpOrigins?: string[];
  mcpVaults?: string[];
  verbose: boolean;
  help: boolean;
  version: boolean;
  timeout: number;
  /**
   * Whether revoking the last device is meant, which the person says out loud.
   *
   * What it leaves is a vault only the recovery key can reach: a real thing to
   * want after a house fire, and not a thing to discover you did by typing an
   * id off a list.
   */
  allowLast: boolean;
  /**
   * The vault's recovery key, for the two device-list commands that can be run
   * with it instead of this device's own credential.
   *
   * Revoking the last device needs it, because that is the one revocation
   * nothing on a device can undo. Listing takes it for the vault with no
   * paired device left to ask, so abandoned registrations can be removed.
   */
  recoveryKey?: string;
  /** How long an invite lasts, in milliseconds; undefined is the server's default. */
  ttlMs?: number;
  /** Whether rebase may remove the index, which the person confirms by typing it. */
  backupTaken: boolean;
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
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    provided: new Set(),
    verify: false,
    rest: [],
    dir: process.cwd(),
    device: hostname().split(".")[0] || "device",
    deviceGiven: false,
    vaultId: "default",
    vaultIdGiven: false,
    json: false,
    watch: false,
    limit: 20,
    limitGiven: false,
    before: 0,
    keyFile: undefined,
    keyOut: undefined,
    verbose: false,
    help: false,
    version: false,
    backupTaken: false,
    allowLast: false,
    force: false,
    merge: true,
    readOnly: false,
    timeout: 30_000,
    configDir: DEFAULT_CONFIG_DIR,
    ignore: [],
  };

  const takes = new Set([
    "--dir",
    "--vault",
    "--device",
    "--vault-id",
    "--server",
    "--token",
    "--timeout",
    "--uid",
    "--to",
    "--limit",
    "--before",
    "--key-file",
    "--key-out",
    "--config-dir",
    "--ignore",
    "--ttl",
    "--recovery-key",
    "--allow-origin",
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
    // base64url and base64url's alphabet includes `-`, so `telimus revoke
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
      case "--listen":
        args.mcpListen =
          argv[i + 1] && !argv[i + 1]!.startsWith("-") ? argv[++i]! : "127.0.0.1:3010";
        break;
      case "--writable":
        args.mcpWritable = true;
        break;
      case "--allow-origin":
        (args.mcpOrigins ??= []).push(value!);
        break;
      case "--vault":
        (args.mcpVaults ??= []).push(value!);
        break;
      case "--dir":
        args.dir = resolve(value!);
        break;
      case "--device":
        args.device = value!;
        args.deviceGiven = true;
        break;
      case "--vault-id":
        args.vaultId = value!;
        args.vaultIdGiven = true;
        break;
      case "--server":
        args.server = value!;
        break;
      case "--token":
        args.token = value!;
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
      case "--key-out":
        args.keyOut = value!;
        break;
      case "--revoke":
        args.mcpRevoke = true;
        break;
      case "--before": {
        const before = Number(value);
        if (!Number.isSafeInteger(before) || before <= 0)
          throw new Error(`--before wants a version number, not ${value}`);
        args.before = before;
        break;
      }
      case "--verify":
        args.verify = true;
        break;
      case "--backup-taken":
        args.backupTaken = true;
        break;
      case "--allow-last":
        args.allowLast = true;
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
      case "--recovery-key":
        args.recoveryKey = value!;
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

async function mustLoad(dir: string): Promise<Config> {
  const config = await loadConfig(dir);
  if (!config) throw new Error(`${dir} is not paired. Run telimus init or telimus pair first.`);
  return config;
}

/**
 * A duration as a person types one: `10m`, `1h`, `90s`, or plain seconds.
 *
 * Bounded above by what the server allows, so the answer is one it will give
 * rather than one it will quietly cap.
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
