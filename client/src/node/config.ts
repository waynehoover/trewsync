/**
 * What a paired device remembers.
 *
 * Kept in `.trew/` inside the vault, which is in the never-sync list, so it
 * neither travels to other devices nor appears as a note. Everything in it is
 * local to this device: the server's address, the vault's name, this device's
 * row id and the token that proves it, and, while a pairing is in progress, the
 * invite it is redeeming. Nothing here opens another device's row.
 */

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { indexLogPath } from "../core/index-journal-store.ts";
import { decodeConfig, encodeConfig, type DeviceConfig } from "../core/pairing.ts";
import {
  refuseOutsideVaultAt,
  syncDirectory,
  syncDirectoryIfSupported,
  writeDurably,
} from "./vault.ts";

/** The folder inside a vault that holds this client's state. */
export const STATE_DIR = ".trew";

/** What a paired device stores. Defined in core, so both shells agree. */
export type Config = DeviceConfig;

export const configPath = (vault: string) => join(vault, STATE_DIR, "config.json");
export const indexPath = (vault: string) => join(vault, STATE_DIR, "index.json");
/** The journal of what has changed since that snapshot. Both are the index. */
export const indexLog = (vault: string) => indexLogPath(indexPath(vault));

/**
 * Reads the config, distinguishing "not paired" from "cannot be read".
 *
 * Returns undefined only for a config that is genuinely absent. Anything else
 * throws: rule 2, and the incident behind it, where falling back to an empty
 * result on a read error and writing it back disabled every plugin on a device.
 * An unreadable config treated as an unpaired vault would re-pair and re-upload.
 */
export async function loadConfig(vault: string): Promise<Config | undefined> {
  const file = configPath(vault);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON, so it cannot be trusted: ${(err as Error).message}`,
    );
  }

  // Decoded by core, so the plugin and this agree about what a config is and
  // refuse the same things. A token of the wrong length is one the server
  // refuses at every hello, and a device told it is paired would retry for
  // ever.
  return decodeConfig(raw, file);
}

/**
 * Writes the config, durably, atomically and readable only by its owner.
 *
 * The mode is set on the temporary file before the rename, so the config is
 * never briefly world-readable. It holds this device's token: anyone who can
 * read it can connect as this device, and so read every note in the vault.
 *
 * Durably, through the same path a note takes. A pairing is saved before its
 * redemption is sent (plan/protocol.md, "Invite redemption"), so from that
 * moment this file holds the only copy of a token the server may be about to
 * register, and once `redeemed` comes back it holds the only copy of a live
 * row's credential. A write and a rename with no fsync between them can be
 * undone by a power cut, leaving a row on the server that nothing can connect
 * as. The state directory is created and synced too, so the file's name is as
 * durable as its bytes.
 */
export async function saveConfig(vault: string, config: Config): Promise<void> {
  const dir = join(vault, STATE_DIR);
  const file = configPath(vault);
  // Before the directory is created, and before anything is written (R11).
  //
  // `NodeVault` has checked its writes for this since F24 and the config did
  // not, which is the one file where it matters most: a `.trew` that is a
  // symlink out of the vault wrote this device's credential somewhere else,
  // with nothing said, and no race was needed to arrange it.
  // The staging directory under it gets the same question for the same reason.
  await refuseOutsideVaultAt(vault, file);
  await mkdir(dir, { recursive: true });
  await refuseOutsideVaultAt(vault, join(dir, "tmp", "probe"));
  const text = JSON.stringify(encodeConfig(config), null, 2) + "\n";
  await writeDurably(file, new TextEncoder().encode(text), true, {
    mode: 0o600,
    stageIn: join(dir, "tmp"),
  });
  // The directory itself may be new. Its own entry in the vault root is what
  // makes it findable after a crash.
  await syncDirectory(vault);
}

/**
 * Forgets a device's pairing, leaving every note where it is.
 *
 * The index goes first, and is checked to be gone, before the config does.
 * The other order left a window in which the vault read as unpaired while
 * the old index still existed, and a new pairing then loaded an index that
 * described another pairing's sync: every note "already synced" against a
 * server that had never seen this device. An index removal that fails must
 * leave the vault paired, which is the state that refuses to pair again.
 *
 * The record of what the last sync left needing attention goes before either,
 * because it describes this pairing's vault: left behind, it would be what the
 * next pairing's `trew status` reported until its first sync replaced it.
 */
export async function removeState(vault: string): Promise<string | undefined> {
  await refuseOutsideVaultAt(vault, configPath(vault));
  await rm(attentionPath(vault), { force: true });
  await mustBeGone(attentionPath(vault), "the record of what needs attention");
  const first = await removeIndex(vault);
  await rm(configPath(vault), { force: true });
  await mustBeGone(configPath(vault), "the config");
  // Synced, so the removal is as durable as the writes were. Without
  // this a power cut after unlink could bring the config back, and with it
  // a vault that reads as paired to a server it was told to forget.
  //
  // Returned rather than thrown or swallowed (I18). By the time this runs the
  // files are unlinked and the pairing is forgotten; what is uncertain is
  // whether that survives a power cut. A filesystem that cannot fsync a
  // directory is not a problem and says nothing. A disk that failed is, and
  // the caller says so.
  const done = await syncDirectoryIfSupported(join(vault, STATE_DIR));
  return first ?? (done.synced ? undefined : done.why);
}

/**
 * Removes the index alone, proven gone, and syncs the directory.
 *
 * The first half of `removeState`, kept on its own so that removing an index
 * and removing a pairing stay two functions: nothing that means the first can
 * do the second by taking the wrong one.
 */
export async function removeIndex(vault: string): Promise<string | undefined> {
  await refuseOutsideVaultAt(vault, indexPath(vault));
  // The journal first, and this order is the only safe one. A crash between
  // the two leaves a snapshot with no journal, which is exactly what an index
  // looked like before the journal existed and loads without a word. The other
  // order leaves a journal with no snapshot, which is a delta against a base
  // that is not there, and the next load refuses to start at all.
  await rm(indexLog(vault), { force: true });
  await mustBeGone(indexLog(vault), "the index journal");
  await rm(indexPath(vault), { force: true });
  await mustBeGone(indexPath(vault), "the index");
  const done = await syncDirectoryIfSupported(join(vault, STATE_DIR));
  return done.synced ? undefined : done.why;
}

/**
 * Removes the config alone, proven gone, and syncs the directory.
 *
 * What a pairing that was refused, or never reached its server, leaves behind
 * is the pending pairing it saved before sending anything, and nothing else:
 * `pair` refuses to start over an index, so there is none. This is the
 * `forget` half of the CLI's `PairingStore` (core/client.ts, `pairWithInvite`):
 * the file is removed and then looked for, because a removal nobody checks is
 * how "nothing is saved after a refusal" becomes a claim rather than a fact
 * (rule 4).
 *
 * Returns why the removal could not be made durable, as `removeState` does,
 * rather than throwing: the file is gone either way (I18).
 */
export async function removeConfig(vault: string): Promise<string | undefined> {
  await refuseOutsideVaultAt(vault, configPath(vault));
  await rm(configPath(vault), { force: true });
  await mustBeGone(configPath(vault), "the config");
  const done = await syncDirectoryIfSupported(join(vault, STATE_DIR));
  return done.synced ? undefined : done.why;
}

/**
 * Where the last sync wrote down what it left waiting on a person.
 *
 * A path the server refused (`badpath` or `collision`), a file over its size
 * limit, a name two things claim: the engine writes each off with a sentence
 * saying why and what to do, and the pass's report names them. The report
 * lives only as long as the command that printed it, and `trew status` is a
 * separate command that runs no pass, so without this a refused path was named
 * once, by a sync nobody may have read, and then never again (PLAN.md section
 * 4.9).
 */
export const attentionPath = (vault: string) => join(vault, STATE_DIR, "attention.json");

/** What `saveAttention` writes and `loadAttention` reads back. */
export interface AttentionRecord {
  /** When the pass that found these finished, in this device's milliseconds. */
  readonly at: number;
  /**
   * How many paths need a person, which may be more than are listed: the list
   * is bounded and the count is not, as in the report it came from.
   */
  readonly count: number;
  /** The listed ones, each with the engine's sentence for it. */
  readonly paths: readonly { readonly path: string; readonly why: string }[];
}

/**
 * Writes the record, atomically, so a `status` running beside a sync reads the
 * old one or the new one and never half of either.
 *
 * Durably too, through the same path as the config, although nothing in it is
 * a note: a record that a power cut could roll back to an older one would
 * report a vault as clean after a pass that found it was not.
 */
export async function saveAttention(vault: string, record: AttentionRecord): Promise<void> {
  const dir = join(vault, STATE_DIR);
  const file = attentionPath(vault);
  await refuseOutsideVaultAt(vault, file);
  await mkdir(dir, { recursive: true });
  await refuseOutsideVaultAt(vault, join(dir, "tmp", "probe"));
  const text = JSON.stringify(record) + "\n";
  await writeDurably(file, new TextEncoder().encode(text), true, {
    mode: 0o600,
    stageIn: join(dir, "tmp"),
  });
}

/**
 * Reads the record back, keeping absent and unreadable apart (rule 2).
 *
 * Undefined only when there is no file, which is a vault no sync has recorded
 * anything for yet. A file that will not read, or does not hold a record,
 * throws: "the last sync found nothing" and "what the last sync found cannot
 * be read" are different answers, and `status` must not give the first when
 * it means the second.
 */
export async function loadAttention(vault: string): Promise<AttentionRecord | undefined> {
  const file = attentionPath(vault);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const { at, count, paths } = record;
  const listed = Array.isArray(paths) ? (paths as unknown[]) : undefined;
  if (
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    listed === undefined ||
    count < listed.length ||
    !listed.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>)["path"] === "string" &&
        typeof (p as Record<string, unknown>)["why"] === "string",
    )
  ) {
    throw new Error(`${file} does not hold a record of what needs attention`);
  }
  return { at, count, paths: listed as { path: string; why: string }[] };
}

/**
 * Whether a vault holds an index but no config.
 *
 * That is not "unpaired", it is an unlink that did not finish or a config
 * somebody removed by hand, and pairing over it would load the orphan. The
 * caller refuses and says how to clear it.
 */
export async function orphanedIndex(vault: string): Promise<boolean> {
  // Either half counts. A journal left on its own is not something a fresh
  // pairing can start from either: it is a delta against a snapshot that is
  // gone, and the load refuses it rather than guessing at a base.
  for (const path of [indexPath(vault), indexLog(vault)]) {
    try {
      await stat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return false;
}

async function mustBeGone(path: string, what: string): Promise<void> {
  try {
    await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  throw new Error(`${what} at ${path} is still there after removing it`);
}
