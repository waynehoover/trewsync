/**
 * The filesystem, as a vault.
 *
 * Half of what makes the headless client the same client: the engine above this
 * cannot tell whether it is talking to a directory or to Obsidian's Vault API.
 *
 * Nothing here decides anything. It lists, reads, writes and removes, and every
 * question about *whether* to is answered a layer up.
 */

import { constants, watch as fsWatch, type BigIntStats, type FSWatcher } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  canonicalSpelling,
  configFolderName,
  firstFreeName,
  foldPath,
  ignoredHere,
  ignoredHereError,
  isNeverSynced,
  neverSync,
  obsidianSpaces,
  splitName,
} from "../core/paths.ts";
import { composite, seam } from "../core/seam.ts";
import {
  DISPLACED_LOG,
  DisplacedLedger,
  type Displaced,
  type DisplacedFiles,
  type Inventory,
} from "../core/displaced.ts";
import {
  JournalIndexStore,
  indexLogPath,
  type JournalFiles,
  type JournalStamps,
  type JournalStoreOptions,
} from "../core/index-journal-store.ts";
import type {
  Ambiguous,
  ExpectedContent,
  FileStat,
  IndexStamp,
  IndexStore,
  Replaced,
  StoredState,
  Times,
  Vault,
} from "../core/vault.ts";

/**
 * This client's state folder, spelled here rather than imported.
 *
 * `config.ts` exports the same string and imports this module for its durable
 * writes, so importing it back would make a cycle out of a five-character
 * constant. The two are checked against each other by
 * `cli/config-dir.test.ts`, which is cheaper than the cycle.
 */
const STATE_FOLDER = ".trew";

/**
 * Where a deletion arriving from another device goes, rather than away.
 *
 * Dot-prefixed, so `isNeverSynced` keeps it out of the listing and what lands
 * there does not travel back out and undo the deletion everywhere else.
 */
const TRASH_DIR = ".trash";

/**
 * Whether something is at a path, for a caller about to write over it.
 *
 * Not `exists`: an error is not an answer. A name that cannot be looked at may
 * well be occupied, and taking it for free is how a note lands on top of one.
 */
async function occupied(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Names this client leaves alone on top of the rule in core/paths.ts.
 *
 * Every dot-prefixed segment is already refused there: the config folder,
 * `.trew` (this client's own bookkeeping, and syncing it would sync the
 * index to itself), the trash, `.git`. What is left is the one name a headless
 * client meets that Obsidian does not.
 *
 * The config folder is added too, because somebody can rename it to something
 * without a dot. Syncing plugins and settings is not done here; that is an
 * open question rather than a closed refusal, and docs/design.md argues both
 * sides of it. Which folder it is comes from --config-dir, since only Obsidian
 * knows for certain and this cannot ask.
 */
const NEVER_SYNC = new Set(["node_modules"]);

/** What Obsidian calls its config folder unless the user has overridden it. */
export const DEFAULT_CONFIG_DIR = ".obsidian";

export { configFolderName };

export interface NoteSnapshot {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly base: string;
  readonly size: number;
  readonly mtime: number;
  readonly ctime: number;
}

export class CheckedPathError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A failed publication can still have moved an independent local version. */
export class PreservationError extends Error {
  constructor(
    error: unknown,
    readonly preserved: readonly string[],
  ) {
    super(error instanceof Error ? error.message : "file preservation failed", { cause: error });
  }
}

interface CheckedLocation {
  readonly path: string;
  readonly full: string;
  readonly info: BigIntStats | undefined;
  readonly parents: readonly { full: string; info: BigIntStats }[];
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}

// The excluded folder may not exist yet, so inode checks alone can authorize
// its creation through an APFS alias. Fold expansions conservatively here;
// existing names are also compared using the filesystem's own identity.
function foldedExclusion(name: string): string {
  return name.toLowerCase().toUpperCase().normalize("NFC");
}

export interface NodeVaultOptions {
  /** Extra names to leave alone, at any depth. */
  readonly alsoIgnore?: readonly string[];
  /**
   * Look and do not touch (R12).
   *
   * `list` is a scan and is not observational: it reaps the temporary files a
   * crashed run left behind, and it re-spells names into their normal form,
   * both of which are writes. That is right for a pass, which is going to
   * write anyway and wants the vault tidy first. It is wrong for `trew
   * status`, which takes no lock, may run beside a watcher, and is described
   * to people as a question rather than an action.
   *
   * With this set the walk reports exactly what is on the disk and changes
   * nothing. A name the disk spells its own way is reported the way the disk
   * spells it, which is what the logical spelling map is for.
   */
  readonly observeOnly?: boolean;
  /**
   * Obsidian's config folder, which is `.obsidian` until somebody overrides
   * it in the app.
   *
   * Defaulted here, where the plugin demands it. The plugin can ask Obsidian
   * and get the right answer; this cannot ask anything, so refusing to run
   * without being told would put a flag in front of every ordinary use. The
   * cost of the default is that a vault with an overridden config folder
   * syncs it until someone passes --config-dir, which is why the flag exists.
   */
  readonly configDir?: string;
  /**
   * The spelling this vault reports for one name, and the one it treats as
   * the name (R9).
   *
   * NFC in production, always, and nothing outside a test passes this. It is
   * here because the mechanism underneath it cannot otherwise be run: macOS
   * folds NFC and NFD at lookup while keeping the disk's own bytes, so on a
   * Mac `absolute` can drop the whole disk-spelling map and every test still
   * passes, while ext4 keeps the two apart and loses a note. A test injects
   * another normal form, over characters APFS does keep apart, and gets the
   * non-folding filesystem it cannot mount (cli/vault-spelling.test.ts).
   *
   * One name, not a path: it is applied segment by segment, because that is
   * how a filesystem files a path.
   *
   * Obsidian's no-break spaces are folded on top of whatever this is, and are
   * never re-spelled on the disk (`reported` below).
   */
  readonly normalForm?: (name: string) => string;
  /**
   * The paired vault's config file, which has to be there on every look (T16).
   *
   * Passed by the commands that open a paired vault, and nothing else: a
   * folder that does not hold its pairing is not the vault that was opened,
   * whatever it is called. See `sameVault`.
   */
  readonly pairing?: string;
}

/**
 * The instant between reserving a normalised name and taking the old one
 * away (R07).
 *
 * An editor saving through a temporary file replaces the old name atomically,
 * and if that lands here the old code deleted the new file during what is
 * meant to be a read-only scan. Too short to hit by racing, so a test stops
 * the world in it. It does nothing in every build.
 */
export const midRespell = composite({
  pause: seam("cli/vault:respell"),
  /**
   * The instant after the old name has been moved aside and before what came
   * out is put back under it (R21).
   *
   * The other window, and the one the first fix missed: the name is free here,
   * and a save that takes it leaves this scan holding a version with nowhere
   * to return it to.
   */
  beforeGivingBack: seam("cli/vault:respell.beforeGivingBack"),
  /**
   * The instant the old name's file is in staging and nothing has been decided
   * about it (R35).
   *
   * The crash point. Whatever is parked here may be the only copy of an unsent
   * edit, and it is at a name in the directory the scan sweeps, so what the
   * sweep believes about that name is the whole question.
   */
  parked: seam("cli/vault:respell.parked"),
});

/**
 * The instant between a trash copy being made durable and the original being
 * removed (R08).
 *
 * Where the vault and its trash are on different filesystems, that gap is a
 * whole-tree flush wide, and a save landing in it used to be deleted on the
 * strength of a comparison about an older version. Too short to hit by racing
 * when the tree is one file, so a test stops the world in it. It does nothing
 * in every build.
 */
export const midTrash = composite({
  pause: seam("cli/vault:trash"),
  /**
   * The instant after a file's copy has been checked and before the original
   * is disposed of (R22).
   *
   * The window the previous attempt left: the comparison described the bytes
   * that were there a moment ago, and the unlink took whatever is there now.
   * The hook sits after the comparison on purpose, because that is the only
   * place it can prove anything.
   */
  afterCompare: seam("cli/vault:trash.afterCompare"),
  /**
   * The instant a note being removed is parked under a temporary name, before
   * anything has been decided about it (R22).
   *
   * Where a crash leaves the vault, which is why the name it is parked under
   * matters: a visible one is a note, and this pass would upload it.
   */
  parked: seam("cli/vault:trash.parked"),
});

/**
 * The instant a displaced version is parked and its destination has not been
 * claimed yet (R43).
 *
 * The window the caller's name choice opens: it picked a free path, staging
 * and hashing happened, and the file only lands there now. A note created at
 * that path in between is the thing preservation must not destroy, and this is
 * where a test puts one. It does nothing in every build.
 */
export const midPreserve = composite({
  beforeClaim: seam("cli/vault:preserve.beforeClaim"),
});

/**
 * The instant before an empty folder another device deleted is removed, which
 * is where a note saved into it at the last moment lands. `rmdir` is the
 * check, so the folder must be kept with the note in it. It does nothing in
 * every build.
 */
export const midRemoveFolder = composite({
  pause: seam("cli/vault:removeFolder"),
});

/**
 * The two instants inside a preserving write.
 *
 * Added by the fault driver rather than by a defect, which is the first time
 * that has happened here: sweeping every scenario across every seam reported
 * that the whole of `replace` was unreachable, because the seams this file had
 * were each placed by the test for one earlier defect and none of them was in
 * the ordinary path. The widest window in the client had no way to stop the
 * world in it.
 */
export const midReplace = composite({
  /** Staged and durable, with the note still under its own name. */
  staged: seam("cli/vault:replace.staged"),
  /**
   * The note has been moved aside and nothing is at its name yet.
   *
   * A save landing here takes the name, and what this operation does about
   * that is the whole of R43 and half of R18.
   */
  nameFree: seam("cli/vault:replace.nameFree"),
});

/**
 * Takes away a name whose file now has a second, normalised name, without
 * deleting anything that is not that file (R07).
 *
 * The old code reserved the new name with `link` and removed the old one with
 * `rm`. `rm` removes whatever is at the name at that moment, and an editor
 * replacing the file in between, which is what an atomic save is, had its new
 * version deleted by a read-only scan.
 *
 * `rename` into staging is the atomic half: whatever is at the old name comes
 * out whole, and only then is it identified. Our own inode is a second name
 * for a file that is safely at its new one, so it is dropped. Anything else is
 * a save that landed in the instant between the link and here, and it goes
 * back; if the name has been taken again in the meantime it goes beside the
 * note instead, because staging is swept and a note is not debris (R21).
 *
 * Module-level so it can be driven directly. Through `list` it is reachable
 * only on a filesystem that keeps two Unicode spellings apart, which macOS
 * does not, and a preservation rule tested on one platform is tested nowhere.
 */
export async function retireName(
  staging: string,
  from: string,
  source: { dev: number; ino: number },
): Promise<void> {
  await midRespell.pause(from);
  // Created first. `rename` reports a missing *destination* directory as
  // ENOENT too, and reading that as "the source is already gone" left both
  // spellings on the disk with nothing said, which is the divergence the
  // re-spelling exists to end.
  await mkdir(staging, { recursive: true });
  // `preserved.`, not `respell.`, and the difference is the whole of R35: this
  // name holds a note that has been taken off the disk and not yet put
  // anywhere, so it must be one the sweep never claims.
  const spare = join(staging, `preserved.${randomBytes(8).toString("hex")}`);
  const there = await lstat(from).catch(() => undefined);
  if (there === undefined) return; // already gone: two passes racing
  await rename(from, spare);
  await midRespell.parked(spare);

  const moved = await lstat(spare).catch(() => undefined);
  if (moved !== undefined && moved.dev === source.dev && moved.ino === source.ino) {
    await rm(spare, { force: true });
    return;
  }
  // Not ours. Put it back under the name it was saved at.
  await midRespell.beforeGivingBack(from);
  try {
    await link(spare, from);
    await rm(spare, { force: true });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // The name was taken again while this was deciding, so there are now two
  // versions somebody wrote and one name. The one in hand goes beside the
  // note, not into staging (R21).
  //
  // It used to stay in staging, which is where the scan's reaper looks, and a
  // rename carries the file's timestamp: the preserved version was older than
  // the cutoff the instant it arrived and was deleted on the next pass as
  // write debris. A note somebody typed is not debris, and staging is not
  // recovery storage.
  const kept = await freeSiblingName(from, "kept");
  try {
    await link(spare, kept);
  } catch {
    // `link` cannot cross a filesystem, and staging is `<root>/.trew/tmp`,
    // which is a separate mount on any vault assembled out of several. The
    // copy is verified and refuses an occupied name, so it keeps both halves
    // of what `link` was chosen for.
    await copyVerifiedThenRemove(spare, kept).catch((err: unknown) => {
      // Out of options that do not risk the file, so the file wins: it stays
      // in staging under the name it was parked at, which the sweep does not
      // claim, and the message says where.
      throw new Error(
        `two versions of ${from} were saved at once and the one this scan moved could not be ` +
          `put beside the other (${(err as Error).message}); it is at ${spare}`,
      );
    });
  }
  await rm(spare, { force: true });
}

/**
 * Puts a file this call exclusively owns at a preservation path, without
 * replacing whatever may have arrived there (R43).
 *
 * The caller picked `keepAt` because it was free, and picking is not claiming:
 * durable staging and a stat or two happen in between, and a note created at
 * that name in the meantime was destroyed by `rename`, which replaces. The one
 * operation that preserves notes was the one deleting one.
 *
 * `link` creates the name or fails, so the destination is claimed rather than
 * assumed. On a collision it takes the next sibling name, because the caller
 * has one name to give and the point is to keep both files, not to keep the
 * name. Returns where it actually landed, which is what the caller reports.
 *
 * `from` must be a path only this call can reach -- a temporary it renamed the
 * note into -- because the unlink at the end is unconditional.
 */
async function claimPreserved(from: string, keepAt: string): Promise<string> {
  await midPreserve.beforeClaim(keepAt);
  let at = keepAt;
  for (let attempt = 0; ; attempt++) {
    try {
      await link(from, at);
      await rm(from, { force: true });
      return at;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt >= 64) throw err;
      at = await freeSiblingName(keepAt, "kept");
    }
  }
}

/**
 * A free name beside a file, for a version that has to be kept and has
 * nowhere else to go.
 *
 * Not the engine's conflict naming, which needs the device name and a clock
 * this module does not have. What it shares is the important half: the file
 * lands next to the note it came from, under a name a person will see.
 */
async function freeSiblingName(full: string, why: string): Promise<string> {
  const dir = dirname(full);
  const base = basename(full);
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? "" : base.slice(dot);
  for (let n = 1; n < 1000; n++) {
    const at = join(dir, `${stem} (${why} ${n})${ext}`);
    if (!(await lstat(at).catch(() => undefined))) return at;
  }
  throw new Error(`no free name beside ${full}`);
}

/**
 * Refuses a path whose real location is outside the vault (F24, R11).
 *
 * Walks up from the path's parent resolving links until it finds something
 * that exists, and requires that to be the vault or inside it. Walking up is
 * what makes it work on a path that is about to be created: the file is not
 * there yet, and the question is about the directory it will land in.
 *
 * Module-level and shared, because the containment rule was on the vault
 * adapter and three writers were not going through it. The config, the index
 * and the lock all live under `.trew`, and a `.trew` that is a symlink out
 * of the vault sent this device's recovery material somewhere else with
 * nothing said. One implementation, so the next writer added under there gets
 * the rule by using the same door.
 *
 * `root` must already be resolved.
 */
export async function refuseOutsideVault(root: string, full: string): Promise<void> {
  let at = dirname(full);
  for (;;) {
    const real = await realpath(at).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (real !== undefined) {
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`refusing a path that leaves the vault through a link: ${full}`);
      }
      return;
    }
    const up = dirname(at);
    // The filesystem root, which cannot be inside the vault.
    if (up === at) return;
    at = up;
  }
}

/**
 * The same check for a writer that has only the vault's path (R11).
 *
 * `saveConfig`, the index and the lock are module-level and hold no adapter,
 * so they resolve the root themselves. A vault root that does not exist yet is
 * not a containment failure: the caller is about to create it.
 */
export async function refuseOutsideVaultAt(vault: string, full: string): Promise<void> {
  const root = await realpath(vault).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (root === undefined) return;
  await refuseOutsideVault(root, full);
}

export class NodeVault implements Vault {
  private readonly root: string;
  private readonly ignore: Set<string>;
  /** How this vault spells one name on the disk. NFC everywhere but a test. */
  private readonly normal: (name: string) => string;
  /**
   * How this vault names one name to the engine: the normal form, with
   * U+00A0 and U+202F as an ordinary space (PLAN.md section 4.1).
   *
   * The plugin's keyspace, because `normalizePath` does the same and the
   * server refuses the other spelling: without it, a note named with a
   * no-break space on this disk was refused on the way up, and the same note
   * arriving from Obsidian became a second file with a plain space beside it.
   *
   * Two functions rather than one, because only `normal` is a spelling the
   * disk is put into. A no-break space stays in the file's name, as Obsidian
   * leaves it, and `diskName` carries the difference so that reads, writes
   * and removals still land on the real file (`ObsidianVault.actualName`).
   */
  private readonly reported: (name: string) => string;
  /** Whether this vault may write while listing. See NodeVaultOptions. */
  private readonly observeOnly: boolean;
  private readonly listingWatchers = new Set<FSWatcher>();
  private cachedListing: Map<string, FileStat> | undefined;
  private readonly listingChanges = new Set<string>();
  private listingGeneration = 0;
  private fullScanDue = 0;

  private invalidateListing(): void {
    this.cachedListing = undefined;
    this.listingChanges.clear();
    this.listingGeneration++;
  }
  /**
   * What this client has taken off a name and could not put back.
   *
   * Written when it happens rather than worked out afterwards from the names
   * on the disk: the disk can say a parked file is there and not which note it
   * came off or why (`core/displaced.ts`).
   */
  private readonly ledger: DisplacedLedger;
  /** Refreshed by every scan, from the ledger, for anything that reports. */
  displaced: readonly Displaced[] = [];
  /**
   * And whether that is the whole of it (RR2).
   *
   * Starts incomplete, because nothing has looked yet, and a shell that reads
   * this before the first scan should not be told the vault is clean.
   */
  recovery: Inventory = { waiting: [], complete: false, why: "nothing has scanned this vault yet" };

  constructor(root: string, opts: NodeVaultOptions = {}) {
    this.root = resolve(root);
    this.pairing = opts.pairing;
    this.observeOnly = opts.observeOnly ?? false;
    const normal = opts.normalForm ?? canonicalSpelling;
    this.normal = normal;
    this.reported = (name) => obsidianSpaces(normal(name));
    // NFC, because everything this is compared against is NFC now. `list`
    // folds the disk's spelling before asking `isNeverSynced`, and a Mac shell
    // hands out NFD: a name tab-completed off the disk and passed to
    // `--ignore` stopped matching the moment that fold landed, so a folder
    // somebody had explicitly kept off the server started syncing on the next
    // pass, with nothing said. Same for `--config-dir`.
    // And with Obsidian's spaces, for the same reason: the names it is compared
    // against are the ones `list` reports.
    const configDir = this.reported(configFolderName(opts.configDir ?? DEFAULT_CONFIG_DIR));
    this.ignore = new Set([
      ...NEVER_SYNC,
      configDir,
      ...(opts.alsoIgnore ?? []).map((name) => this.reported(name)),
    ]);
    this.ledger = new DisplacedLedger(new NodeDisplacedFiles(this.root), (m) =>
      console.warn(`trew: ${m}`),
    );
  }

  /**
   * Writes down that a version is somewhere nothing lists.
   *
   * Called from the failure paths of the preserving write and the preserving
   * removal, which is where a version can end up parked with nowhere to go
   * (R46). Never throws: see `DisplacedLedger.record`.
   */
  private async noteDisplaced(at: string, from: string, why: string): Promise<void> {
    this.invalidateListing();
    await this.ledger.record({
      at: relative(this.root, at),
      from: this.normalPath(relative(this.root, from)),
      why,
      when: Date.now(),
    });
  }

  /** A whole path as this vault reports it, one segment at a time. */
  private normalPath(path: string): string {
    return path
      .split("/")
      .map((part) => this.reported(part))
      .join("/");
  }

  /** The vault root with its links resolved, worked out once. */
  private realRootOnce: Promise<string> | undefined;

  /** See `NodeVaultOptions.pairing`. */
  private readonly pairing: string | undefined;

  /** The root folder's identity when this vault first looked at it (T16). */
  private rootSeen: { dev: bigint; ino: bigint } | undefined;

  /**
   * Refuses a root that is no longer the folder this vault opened (T16).
   *
   * Asked before every scan, after every full walk, and by `absolute`, which
   * every other question about a path goes through. A vault whose root is a
   * mount point is ordinary on Linux, and when the disk goes away the mount
   * point stays behind as an empty folder; so does a vault folder moved away
   * and made again. Nothing below could tell either from a vault whose notes
   * had all been deleted, and a `trew sync --watch` acted on exactly that: its
   * next scan found nothing, every note read as deleted here, and the deletions
   * went to every other device. A one-shot sync was safe only because it reads
   * the pairing first and found none.
   *
   * So the folder is the one first looked at, by device and inode. A paired
   * vault's config file must also still be in it, which catches a folder made
   * again on a filesystem that hands the old inode number back; that is asked
   * by every scan and the first look, and the other questions ask only the
   * stat, since they come between two scans that ask both. Measured under Node
   * at about 10 microseconds a question, against a scan or a write that makes
   * dozens of syscalls. The same folder remounted under a new device number is
   * refused too, and that is the safe side: starting trew again takes it as it
   * now is.
   */
  private async sameVault(withPairing: boolean): Promise<void> {
    const refuse = (why: string): never => {
      throw new Error(
        `${this.root} is not the folder this trew opened as the vault: ${why}. Nothing was ` +
          `listed or changed, because a folder standing in for it would read as every note ` +
          `deleted. Put the vault back (mount its disk again, for example) and start trew again.`,
      );
    };
    let now: BigIntStats;
    try {
      now = await stat(this.root, { bigint: true });
    } catch (err) {
      return refuse(`it cannot be looked at (${(err as Error).message})`);
    }
    if (!now.isDirectory()) refuse("it is not a folder");
    const seen = this.rootSeen;
    if (seen !== undefined && (now.dev !== seen.dev || now.ino !== seen.ino)) {
      refuse(
        "a different folder is at its path now, which is what an unmounted disk or a vault " +
          "moved away leaves behind",
      );
    }
    if (
      this.pairing !== undefined &&
      (withPairing || seen === undefined) &&
      !(await occupied(this.pairing))
    ) {
      refuse(`it no longer holds this device's pairing, ${relative(this.root, this.pairing)}`);
    }
    // Remembered only once it has passed, so a first look at a folder standing
    // in for the vault does not make that folder the one expected from then on.
    this.rootSeen ??= { dev: now.dev, ino: now.ino };
  }

  /**
   * Directories written to since the last flush.
   *
   * A set, because the saving is entirely in not flushing the same folder once
   * per file in it.
   */
  private readonly unflushed = new Set<string>();

  /**
   * Makes durable the directory entries of everything written since the last
   * call. The engine calls this before it saves the index, which is what keeps
   * the index from being durable ahead of the notes it names.
   */
  async flush(): Promise<void> {
    const dirs = [...this.unflushed];
    this.unflushed.clear();
    // Every directory is attempted, and the ones that failed go back on
    // the list. Clearing first and syncing second lost the retry: a sync
    // that failed once was never asked for again, and the next otherwise
    // clean pass saved an index naming files whose directory entries had
    // never been made durable.
    const outcomes = await Promise.allSettled(dirs.map((d) => syncDirectory(d)));
    let first: unknown;
    outcomes.forEach((o, i) => {
      if (o.status === "rejected") {
        this.unflushed.add(dirs[i]!);
        first ??= o.reason;
      }
    });
    if (first !== undefined) throw first;
  }

  /**
   * Remembers that a path's directory entries changed, so `flush` makes them
   * durable before the index is saved.
   *
   * Every ancestor that did not exist before is new content in *its* parent,
   * so the directories from the deepest one that already existed down to the
   * path's parent are all dirty. Only writes used to register, so a folder
   * made for a note, a case rename, a move into the trash and the copy across
   * a mount all changed names on disk that nothing then synced.
   */
  private dirty(full: string, deepestExisting: string): void {
    this.invalidateListing();
    let at = dirname(full);
    this.unflushed.add(at);
    while (at !== deepestExisting && at.startsWith(this.root) && at !== this.root) {
      at = dirname(at);
      this.unflushed.add(at);
    }
  }

  /** The deepest ancestor of a path that exists now, before anything is created. */
  private async deepestExisting(full: string): Promise<string> {
    let at = dirname(full);
    for (;;) {
      try {
        await access(at, constants.F_OK);
        return at;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const up = dirname(at);
      if (up === at) return at;
      at = up;
    }
  }

  /**
   * Proves containment against the filesystem rather than the string.
   *
   * `absolute` resolves `..` lexically. That is everything for a path trying
   * to climb out and nothing for one walking through a symlinked folder, and
   * a vault with `Attachments -> /elsewhere` is ordinary: a shared media
   * directory, a notes tree living on another disk. `list` neither follows nor
   * reports such a folder, so it never syncs out and the vault never learns it
   * is there, but every write followed it. A peer naming a path under one
   * wrote outside the vault with the user's privileges, and `remove` deleted
   * out there.
   *
   * The deepest ancestor that exists is the one worth resolving; anything
   * below it is about to be created and cannot be a link yet.
   */
  private async insideForReal(full: string): Promise<void> {
    await refuseOutsideVault(await (this.realRootOnce ??= realpath(this.root)), full);
  }

  /**
   * The same check, once per directory rather than once per note.
   *
   * `refuseOutsideVault` resolves the containing directory, so asking it per
   * read asks the same question of the same few directories thousands of
   * times: measured at about 20 microseconds each, which is 80 ms of realpath
   * on a four thousand note catch-up and buys nothing after the first answer.
   *
   * Only reads use this. A write creates the thing it is naming, so the
   * directory it lands in may have appeared since, and the writes keep asking
   * every time.
   *
   * What is not cached is the leaf, which `O_NOFOLLOW` settles at the moment
   * of opening and cannot be stale. So a directory replaced by a link is
   * caught the first time this vault reads through it, and a *note* replaced
   * by a link is caught every time. The gap left is a directory swapped after
   * this process has already read through it, which is outside the threat
   * model here: ordinary local storage and an owner who is not attacking
   * themselves.
   */
  private async readableDir(full: string): Promise<void> {
    const dir = dirname(full);
    if (this.checkedDirs.has(dir)) return;
    await this.insideForReal(full);
    this.checkedDirs.add(dir);
  }

  private readonly checkedDirs = new Set<string>();

  /** Listing already inspected the disk; apply the same exclusions to its names. */
  assertPathPolicy(path: string, kind: "file" | "directory" = "file"): void {
    if (
      typeof path !== "string" ||
      /[\\\0]/u.test(path) ||
      /\p{Surrogate}/u.test(path) ||
      /^[A-Za-z]:/u.test(path) ||
      Buffer.byteLength(path) > 4096 ||
      path !== this.normalPath(path) ||
      (path !== "" && path.split("/").some((part) => !part || part === "." || part === "..")) ||
      (path === "" && kind !== "directory")
    ) {
      throw new CheckedPathError("invalid_path", "expected a canonical vault-relative path");
    }
    const parts = path === "" ? [] : path.split("/");
    const ignored = new Set([...this.ignore].map(foldedExclusion));
    if (parts.some((part) => part.startsWith(".") || ignored.has(foldedExclusion(part)))) {
      throw new CheckedPathError("excluded_path", "the path is excluded from this vault");
    }
  }

  /**
   * An agent can name a file no scan has seen. The ordinary read's cached
   * directory check accepted an alias into .trew, including after a folder
   * changed to a link. Ask each segment afresh before following it, and keep
   * this lookup out of the engine's spelling caches.
   */
  private async checkedLocation(
    path: string,
    {
      allowMissing = false,
      kind = "file",
    }: { allowMissing?: boolean; kind?: "file" | "directory" } = {},
  ): Promise<CheckedLocation> {
    this.assertPathPolicy(path, kind);
    const parts = path === "" ? [] : path.split("/");
    let full = await (this.realRootOnce ??= realpath(this.root));
    let info: BigIntStats | undefined = await lstat(full, { bigint: true });
    const parents: { full: string; info: BigIntStats }[] = [];
    const canonical: string[] = [];
    const checkParents = async (): Promise<void> => {
      // A second walk can itself cross a link installed during its readdir.
      // Inspect the names again after that walk, not only its saved stats.
      for (const parent of parents) {
        const now = await lstat(parent.full, { bigint: true });
        if (!now.isDirectory() || !sameSnapshot(parent.info, now)) {
          throw new CheckedPathError(
            "changed_during_read",
            "a path ancestor changed while checking it",
          );
        }
      }
    };
    for (let i = 0; i < parts.length; i++) {
      if (!info.isDirectory()) {
        throw new CheckedPathError(
          "not_regular_file",
          "a path ancestor is not a regular directory",
        );
      }
      parents.push({ full, info });
      const part = parts[i]!;
      // Folding every lookup made Work/new.md land in work/ on Linux and
      // refused exact reads when Foo.md and foo.md both existed.
      const names = (await readdir(full)).filter(
        (name) => this.canonical(name) === this.canonical(part),
      );
      if (names.length > 1) {
        throw new CheckedPathError("ambiguous_path", "the path has ambiguous spellings on disk");
      }
      const name = names[0] ?? part;
      canonical.push(this.reported(name));
      const parent = full;
      full = join(full, name);
      try {
        info = await lstat(full, { bigint: true });
      } catch (err) {
        if (!allowMissing || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const rest = parts.slice(i + 1);
        await checkParents();
        return {
          path: [...canonical, ...rest].join("/"),
          full: join(full, ...rest),
          info: undefined,
          parents,
        };
      }
      // APFS resolves aliases that lowercasing does not, such as sigma's
      // final form and sharp-s. Do not let a spelling absent from readdir
      // become a route into an excluded folder through lstat's lookup.
      if (names.length === 0) {
        throw new CheckedPathError("ambiguous_path", "the path uses an unlisted filesystem alias");
      }
      if (info.isSymbolicLink()) {
        throw new CheckedPathError("symlink", "refusing a path through a link");
      }
      for (const excluded of this.ignore) {
        if (excluded !== basename(excluded)) continue;
        const alias = await lstat(join(parent, excluded), { bigint: true }).catch(
          (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") return undefined;
            throw err;
          },
        );
        if (alias !== undefined && sameIdentity(alias, info)) {
          throw new CheckedPathError(
            "excluded_path",
            "the path aliases an excluded name in this vault",
          );
        }
      }
    }
    if (kind === "file" ? !info.isFile() : !info.isDirectory()) {
      throw new CheckedPathError("not_regular_file", `the path is not a regular ${kind}`);
    }
    await checkParents();
    return { path: canonical.join("/"), full, info, parents };
  }

  /** Refresh the writer's spellings only after policy accepts the destination. */
  async checkPath(
    path: string,
    options: { allowMissing?: boolean; kind?: "file" | "directory" } = {},
  ): Promise<{ path: string; exists: boolean }> {
    const location = await this.checkedLocation(path, options);
    // A missing leaf ends the walk early. A folder swapped during readdir
    // otherwise authorizes create through a new alias into excluded state.
    const again = await this.checkedLocation(path, options);
    if (
      location.full !== again.full ||
      location.parents.length !== again.parents.length ||
      location.parents.some((parent, i) => !sameIdentity(parent.info, again.parents[i]!.info)) ||
      (location.info === undefined
        ? again.info !== undefined
        : again.info === undefined || !sameSnapshot(location.info, again.info))
    ) {
      throw new CheckedPathError("changed_during_read", "the path changed while checking it");
    }
    this.diskName.clear();
    this.spellingsKnown.clear();
    return { path: location.path, exists: location.info !== undefined };
  }

  /** A bounded snapshot is not a promise that a local editor cannot save again. */
  async readSnapshot(
    path: string,
    maxBytes: number,
    { flush = false }: { flush?: boolean } = {},
  ): Promise<NoteSnapshot> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
      throw new CheckedPathError(
        "invalid_limit",
        "snapshot byte limit must be between 1 and 1048576",
      );
    }
    const before = await this.checkedLocation(path);
    const tooLarge = (): never => {
      throw new CheckedPathError("note_too_large", "the note is too large for this read");
    };
    const changed = (): never => {
      throw new CheckedPathError(
        "changed_during_read",
        "the note changed during the read; read it again",
      );
    };
    if (before.info!.size > BigInt(maxBytes)) tooLarge();
    let handle;
    try {
      // NONBLOCK also makes an injected FIFO refuse instead of waiting for a writer.
      handle = await open(
        before.full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (err) {
      if (["ELOOP", "EMLINK"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        throw new CheckedPathError("symlink", "refusing a path through a link");
      }
      throw err;
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameSnapshot(before.info!, opened)) changed();
      const recheck = async (): Promise<void> => {
        const now = await this.checkedLocation(path);
        if (
          now.full !== before.full ||
          !sameSnapshot(opened, now.info!) ||
          now.parents.length !== before.parents.length ||
          now.parents.some((parent, i) => !sameIdentity(parent.info, before.parents[i]!.info))
        )
          changed();
      };
      await recheck();
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > maxBytes) tooLarge();
      // Directory fsync alone did not make an unexpected editor save durable
      // when MCP preserved it during replacement. Flush this checked descriptor
      // before the final identity checks, only when a transaction requests it.
      if (flush) await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (!sameSnapshot(opened, after) || BigInt(size) !== after.size) changed();
      await recheck();
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, size);
      return {
        path: before.path,
        bytes,
        base: createHash("sha256").update(bytes).digest("hex"),
        size,
        mtime: Number(opened.mtimeNs) / 1e6,
        ctime: Number(opened.birthtimeNs) / 1e6,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Turns a vault-relative path into an absolute one, refusing to escape.
   *
   * Paths arrive from the server, written there by another device or by an
   * agent, and a client that joined `../../.ssh/authorized_keys` onto the vault
   * root without looking would write outside it. The server refuses such a path
   * too (plan/protocol.md, "Paths"), which proves it passed the server's rules
   * and not that the server is honest or that whoever wrote it meant this
   * device well; a bug on another device is enough.
   */
  private async absolute(path: string): Promise<string> {
    await this.sameVault(false);
    const full = resolve(this.root, path);
    const outside = relative(this.root, full);
    if (outside === "" || outside === ".." || outside.startsWith(`..${sep}`)) {
      throw new Error(`refusing a path outside the vault: ${path}`);
    }
    // A path this client would never upload is one it must never accept.
    //
    // The ignore set was read by `list` and `watch` and by nothing on the
    // way in, so the two directions disagreed: a peer naming
    // `.obsidian/plugins/<any>/main.js` had it written, and Obsidian runs
    // that file on the next reload in a renderer with Node integration.
    // `.trew/config.json` holds this device's own secret and server URL,
    // and `.git/hooks/` runs on the next checkout.
    //
    // Then it was read on the way in for the first segment only, while
    // `list` skipped every depth, so `notes/.git/hooks/post-checkout` from
    // a peer was written, never listed, and reported deleted on the next
    // pass. One predicate, the same one `list` and `watch` use.
    // NFC, whatever spelling arrived. Every path this vault hands out is NFC
    // (see `list`), and a path coming in is normalised the same way so there
    // is one keyspace, as the plugin has. An NFD spelling can still arrive,
    // from a headless client older than this rule or from an index it wrote.
    const rel = this.normalPath(outside.split(sep).join("/"));
    if (this.neverSynced(rel)) {
      // Two refusals, because they mean opposite things to whoever reads the
      // exit status (R2). A dot-prefixed name is one this client would write
      // and then never list again, which is a fault in the vault it came
      // from. A name in this device's own ignore list is the person who
      // passed `--ignore` getting what they asked for, and a peer that syncs
      // it is not doing anything wrong either.
      throw ignoredHere(rel, this.ignore)
        ? ignoredHereError(`not writing under a name this device is set to ignore: ${path}`)
        : neverSync(`refusing to write inside a folder that is never synced: ${path}`);
    }
    return resolve(this.root, await this.spelledOnDisk(rel));
  }

  /** The one answer to "does this path sync", asked the same way in every direction. */
  private neverSynced(rel: string): boolean {
    return isNeverSynced(rel, this.ignore);
  }

  /**
   * The disk's own spelling of each name whose reported form differs from it.
   *
   * Keyed by the reported vault-relative path of the entry, holding the name
   * the disk uses for its last segment. Read by `absolute`, so a path the
   * engine names in NFC, with plain spaces, still reaches the file on a disk
   * that keeps the two spellings apart or whose name has a no-break space in
   * it. Empty on a vault whose names are all reported as they are spelled,
   * which is every vault that never met a Mac or a no-break space.
   */
  private readonly diskName = new Map<string, string>();

  /**
   * Directories whose spellings are known, so the disk is asked once.
   *
   * `list` fills this for every directory it walks, which is why the sync
   * path never reads a directory twice: it has just read the whole vault.
   */
  private readonly spellingsKnown = new Set<string>();

  /**
   * A vault-relative path in this vault's normal form, spelled the way the
   * disk has each segment.
   *
   * The map used to be filled only by `list`, and `trew restore` never
   * calls `list` (R9). On a disk that keeps the two spellings apart that made
   * restore invisible to itself: the file was there under the disk's NFD
   * name, `exists` asked for the NFC one and was told no, restore wrote a
   * second file, and the next `trew sync` refused the whole vault with "two
   * files in this vault are the same path once normalized" until a person
   * renamed one of two names that look identical. So resolving a path asks
   * the disk when it has to, rather than depending on another call having
   * run first (cli/vault-spelling.test.ts, "a restore into a vault nothing
   * has listed").
   *
   * The reads are bounded by the directories on the path, once each, and the
   * sync path does none: `list` has already been over the whole tree.
   */
  private async spelledOnDisk(rel: string): Promise<string> {
    let at = "";
    let spelled = "";
    for (const part of rel.split("/")) {
      const next = at ? `${at}/${part}` : part;
      let name = this.diskName.get(next);
      if (name === undefined && !this.spellingsKnown.has(at)) {
        await this.readSpellings(at, spelled);
        name = this.diskName.get(next);
      }
      spelled = spelled ? `${spelled}/${name ?? part}` : (name ?? part);
      at = next;
    }
    return spelled;
  }

  /**
   * Learns how one directory spells the names in it.
   *
   * A directory that is not there yet is the ordinary case, and it is the
   * parent of every file about to be created: nothing to map, and nothing
   * remembered, because "nothing here" would outlive the moment. One that
   * cannot be read is rule 2, and it is the difference between the two that
   * matters: an unreadable directory may well hold this name under another
   * spelling, and taking the answer as "it does not" is how a write lands
   * beside a note instead of on it (cli/vault-race.test.ts, "does not write
   * under an unverified spelling when the directory cannot be listed").
   *
   * Two names in one directory with the same normal form are not mapped at
   * all: there is no right answer to which one a path means, and guessing is
   * how a write lands on the wrong note. `list` is where that is refused,
   * loudly, and it refuses the whole vault rather than one path.
   */
  private async readSpellings(dir: string, spelled: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(resolve(this.root, spelled));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Not there, or an ancestor that is a file rather than a folder.
      // Neither holds a spelling, and both produce their own error from the
      // operation that actually needs the path.
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw err;
    }
    this.spellingsKnown.add(dir);
    // Grouped before anything is mapped, as `list` groups them. Names already
    // in reported form used to be skipped before they were counted, so a
    // directory holding `a b.md` and its no-break twin mapped the plain name
    // to the twin, and a write to `a b.md` landed on the note that is not
    // called that. The same held for NFC beside NFD on a disk that keeps them
    // apart; the no-break space makes it reachable on every disk.
    const claims = new Map<string, string[]>();
    for (const name of names) {
      const normal = this.reported(name);
      const group = claims.get(normal);
      if (group) group.push(name);
      else claims.set(normal, [name]);
    }
    for (const [normal, group] of claims) {
      const key = dir ? `${dir}/${normal}` : normal;
      if (group.length > 1) this.diskName.delete(key);
      else if (group[0] !== normal && !this.diskName.has(key)) this.diskName.set(key, group[0]!);
    }
  }

  /** Paths the last `list` left out because two names on disk claim them. */
  private ambiguousPaths: Ambiguous[] = [];

  /**
   * Which paths two names on disk both claim, from the last `list`.
   *
   * The engine blocks these and everything under them rather than syncing
   * either spelling, and names them so a person can rename one.
   */
  ambiguous(): readonly Ambiguous[] {
    return this.ambiguousPaths;
  }

  /**
   * Names this vault has already tried to put into their normal form.
   *
   * A filesystem that stores one normal form of its own accepts the rename,
   * reports success, and hands the old spelling back on the next `readdir`:
   * HFS+ stores NFD whatever it is given. Without this the vault would rename
   * that name on every pass for the rest of the process's life, getting
   * nowhere. One rename that the disk accepted is enough to know the answer,
   * so it is not asked again; one that failed is not recorded, because a
   * failure can pass.
   */
  private readonly normalized = new Set<string>();

  /**
   * Renames a file to the spelling this vault reports for it.
   *
   * The vault's promise is that it holds the same notes as every other
   * device, and it was not keeping it. A Mac creates `écombining.md` with a
   * combining acute; this vault reports it in NFC, uploads NFC, and every
   * other device writes NFC, so the Mac was left holding the one spelling
   * nothing else had. On a disk that folds the two that is invisible and on
   * ext4 it is two different filenames for ever, which is the same divergence
   * normalising was added to end, moved from the wire to the disk
   * (stress/names.stress.ts, "round-trips every one to another device";
   * cli/vault-spelling.test.ts, "is renamed on disk to the spelling every
   * other device will use").
   *
   * The correction a device owes the server for a name spelled the old way is
   * a rename, and this is the same correction owed to its own disk. A real
   * rename: `rename` is atomic, so an interrupted one leaves the note under
   * one name or the other and never under neither, and it is the same inode,
   * so no content is copied and nothing that has the file open loses it.
   * Never over an existing entry, which is what the caller's check of the
   * directory's own names is for: `rename` would replace it silently, and the
   * one case where both spellings are there is the one case where only a
   * person can say which note to keep. That check is the `readdir` this walk
   * has just done, so what is not covered is a file created under the normal
   * form in the microseconds between the two, by something other than this
   * pass. Stated rather than claimed away: Node has no `renameat2`, and the
   * alternatives are worse. `link` then `unlink` cannot clobber but leaves
   * two names for one file if it is interrupted, and that state does not heal
   * itself, which trades a window nothing has been seen in for a condition a
   * person would have to resolve by hand.
   *
   * A failure here is not a failure of the listing (rule 2 is about not
   * mistaking one state for another, and there is no mistake in this one). A
   * read-only vault, or one on a filesystem that will not have it, keeps the
   * disk's spelling and syncs exactly as it did before this rule: the map
   * below is what makes that correct. Stopping a sync over the spelling of a
   * name that is already right on the wire would be the worse trade.
   */
  private async normalizeName(
    dir: string,
    entry: { name: string; disk: string; spelled: string },
    path: string,
  ): Promise<void> {
    if (this.normalized.has(path)) return;
    try {
      // `link` decides whether the name is free; `rename` is what re-spells
      // it (F12).
      //
      // Renaming straight over the target was the fault. The decision that the
      // normalised name is free came from the directory listing, and a listing
      // is a moment ago, so an editor that created that exact name in between
      // had its file silently replaced by this one during what is meant to be
      // a read-only scan.
      //
      // `link` cannot replace anything: it creates the name or fails with
      // EEXIST. Two of the three answers are then easy. What EEXIST does not
      // distinguish on its own is the case this rule exists for: APFS stores
      // one name for `café.md` in either normal form, so the two spellings are
      // one inode, and the destination "already existing" is the source. That
      // one is re-spelled with `rename`, which is safe precisely because there
      // is only one file to lose. A different inode is a real collision and is
      // left alone for the alias machinery to report as two spellings of one
      // name, which is what it is for.
      //
      // A folder takes the second path from the start: `link` refuses a
      // directory, and there is no atomic no-clobber rename for one. It is
      // checked and then renamed, which narrows the window rather than
      // closing it, and a folder appearing under a normalised name during a
      // scan is not a thing an editor does.
      // `spelled`, not the reported name: a no-break space stays on the disk.
      const from = join(dir, entry.disk);
      const to = join(dir, entry.spelled);
      const source = await lstat(from);
      const sameFileAt = async (): Promise<boolean> => {
        const there = await lstat(to).catch(() => undefined);
        if (there === undefined) return true;
        return there.dev === source.dev && there.ino === source.ino;
      };

      if (source.isDirectory()) {
        if (!(await sameFileAt())) return;
        await rename(from, to);
        this.finishNormalising(path, entry, dir);
      } else {
        try {
          await link(from, to);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          if (!(await sameFileAt())) throw err;
          await rename(from, to);
          this.finishNormalising(path, entry, dir);
          return;
        }
        // The destination is reserved and is the same inode. What is left is
        // to take the old name away, and `rm(from)` is the wrong tool for it
        // (R07).
        //
        // `rm` removes whatever is at the name *now*. An editor that replaced
        // the file between the link above and here, which is what an atomic
        // save does, has its new file deleted by a read-only scan, and the
        // normalised name still points at the old inode. The review
        // reproduced exactly that.
        //
        // Recorded here, before the old name is dealt with, because the file
        // is already at `to` and the listing has to say so whatever happens
        // next.
        //
        // It used to be recorded after. Retiring the old name can throw, and
        // then `entry.disk` still held the old spelling, the old name was
        // gone, and `list` stat-ed a name that no longer existed and dropped
        // the path. A note sitting on the disk under its correct name was
        // therefore missing from the scan, the engine read that as a local
        // deletion, and it deleted the note on the server and so on every
        // other device. The most expensive way this file can be wrong.
        const wasSpelled = entry.disk;
        this.finishNormalising(path, entry, dir);
        // So the old name is moved rather than removed. `rename` is atomic:
        // whatever is at `from` at that instant comes out in one piece, and
        // then it can be looked at. Our own inode is debris and is dropped.
        // Anything else is a file somebody saved in the last microsecond, and
        // it goes back where it came from.
        try {
          await this.retireOldSpelling(from, source);
        } catch (err) {
          // The file is at its normalised name and the old name may still be
          // there too, which is two spellings of one note and exactly what the
          // alias report is for. A version `retireName` could not place is in
          // staging under `preserved.`, which the next scan counts into
          // `stranded` and `status` prints, so it is not lost with the throw.
          void err;
          this.ambiguousPaths.push({ path, spellings: [entry.spelled, wasSpelled] });
        }
      }
    } catch {
      // Kept under the spelling the disk has, which is what the map is for.
      // A destination that appeared since the listing lands here too, and
      // leaving both is the point: the alias machinery reports two spellings
      // of one name, and replacing one with the other would report nothing.
    }
  }

  /**
   * Records that a name has been put into its normal form.
   *
   * Remembered on success, not on the attempt. A rename that succeeded and
   * left the name where it was is a filesystem storing its own normal form,
   * and asking it again will get the same answer for ever. A rename that threw
   * may have thrown for a reason that passes, and writing the name off on the
   * first EBUSY would leave a watching client diverged from every other device
   * until somebody restarted it.
   */
  private finishNormalising(
    path: string,
    entry: { name: string; disk: string; spelled: string },
    dir: string,
  ): void {
    this.normalized.add(path);
    entry.disk = entry.spelled;
    this.unflushed.add(dir);
  }

  /**
   * Takes away a name that now has a normalised twin, without deleting
   * anything that is not the file we linked (R07).
   *
   * `rename` into staging is the atomic half: whatever is at the old name
   * comes out whole, and only then is it identified. Our own inode is a
   * second name for a file that is safely at its new one, so it is dropped.
   * Anything else is a save that landed in the instant between the link and
   * here, and it is put back; if the name has been taken again in the
   * meantime it goes beside the note under a name a person will see, because
   * staging is swept by age and a note somebody typed is not debris (R21).
   */
  private async retireOldSpelling(
    from: string,
    source: { dev: number; ino: number },
  ): Promise<void> {
    await this.checkStaging();
    await retireName(this.staging, from, source);
  }

  /** Temporary files of a crashed earlier run that `list` has removed. */
  reaped = 0;

  /**
   * Preserved note versions that nothing will remove, as vault-relative paths.
   *
   * Taking `respell.` off the reaper's list closed one hole and could have
   * opened another: a note parked mid-normalisation and abandoned by a crash
   * now stays there for ever, which is the right thing to do with it and the
   * wrong thing to do silently. A version nobody can find is not much better
   * than one that was deleted, so the scan counts them and `status` says so.
   *
   * Two kinds end up here and they are in different places: what an
   * interrupted normalisation parks in `.trew/tmp`, and what a failed
   * preservation claim leaves beside the note it came from (R46). Both are
   * written the same way, relative to the vault root, because the only thing
   * anybody does with this list is go and look.
   *
   * Filled by every scan, including an observing one: counting is a read.
   */
  readonly stranded: string[] = [];

  /**
   * Removes staged temporaries that nothing is writing and that are old.
   *
   * A crash mid-write leaves its temporary behind, and the staging folder is
   * never listed, so left alone it would sit there for ever, unseen. Anything
   * older than the grace period and not open in this process cannot be an
   * in-flight write, so it is removed and counted. A missing folder is empty;
   * other scan errors make the recovery inventory incomplete while unrelated
   * notes can continue syncing.
   */
  private async reapStaleTemps(): Promise<string | undefined> {
    // Cleared here, at the top of the scan that fills it, because the walk
    // below adds to it too (R46).
    this.stranded.length = 0;
    // Containment first, and before the directory is even read (R21).
    //
    // This also runs when the vault is observing, and stops before the
    // removals: what it records is what it *will not* take, which is a read
    // and is the only thing that tells anybody a preserved version is waiting.
    //
    // This walks a directory and deletes things in it, and it did so without
    // ever asking whether the directory is inside the vault. A `.trew/tmp`
    // that is a symlink somewhere else therefore had its contents deleted by
    // an ordinary scan: no race, no hostile process, just a filesystem laid
    // out in a way nobody checked. It is the most destructive loop in this
    // file and it was the only writer with no guard.
    try {
      await this.checkStaging();
    } catch (err) {
      // Not a directory this vault owns. Nothing here is ours to remove, and
      // the write paths refuse it too.
      return `recovery staging could not be checked: ${(err as Error).message}`;
    }
    let names: string[];
    try {
      names = await readdir(this.staging);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      return `recovery staging could not be read: ${(err as Error).message}`;
    }
    // What is in here that this will not remove, before deciding to remove
    // anything (R35). Recorded on every scan and not only on a reaping one,
    // because `status` observes and a question is exactly when somebody wants
    // to be told.
    for (const name of names) {
      if (!disposableTemp(name) && !liveTemps.has(join(this.staging, name))) {
        // Relative to the vault, like the ones the walk finds (R50). Two
        // conventions in one list is a list nothing can print: `status` said
        // every entry was in `.trew/tmp` because that used to be the only
        // place they came from, and sent people to an empty directory for the
        // ones that are beside their note.
        this.stranded.push(relative(this.root, join(this.staging, name)));
      }
    }
    if (this.observeOnly) return;

    const cutoff = Date.now() - STALE_TEMP_MS;
    for (const name of names) {
      // Only what this code makes (R21). It used to delete anything old, and
      // "old" is not a property of debris: a rename carries the file's
      // timestamp, so anything moved in here looks ancient the moment it
      // lands. Deleting by age alone is how a preserved version of somebody's
      // note became write debris.
      if (!disposableTemp(name)) continue;
      const full = join(this.staging, name);
      if (liveTemps.has(full)) continue;
      try {
        if ((await stat(full)).mtimeMs < cutoff) {
          await rm(full, { force: true });
          this.reaped++;
        }
      } catch {
        // Gone, or not ours to judge. Next time.
      }
    }
  }

  /**
   * Every file and folder in the vault, with the stats the engine decides on.
   *
   * The stats go together rather than one after another. Serially this was
   * 14 us a file and 138 ms over ten thousand of them, of which 112 ms was
   * nothing but waiting: `readdir` over the same tree is 25 ms. It runs on
   * every pass, so a settled vault paid it on every watch tick and every
   * keepalive, for ever. Together it is 27 ms.
   *
   * The engine's own comment, that an unchanged file costs one stat and so a
   * full pass is affordable, was right about the number of syscalls and wrong
   * about the wall clock, purely because they were issued one at a time.
   *
   * Order is unchanged and deliberately so: a folder is listed before
   * anything inside it, because that is the order folders have to be created
   * in. Each directory returns its own list and they are assembled in the
   * order they were read, so concurrency cannot reshuffle them.
   *
   * Do not raise UV_THREADPOOL_SIZE to go further. Measured at 16 it made this
   * 2.6x worse than the default 4.
   */
  async list(options: { forceFull?: boolean; checked?: boolean } = {}): Promise<FileStat[]> {
    if (options.checked && !this.observeOnly) {
      throw new Error("checked inventory requires an observe-only vault");
    }
    // Before anything is read or reaped (T16): an empty folder standing in
    // for the vault lists as every note deleted.
    await this.sameVault(true);
    // Neither of the two writes a scan normally makes happens in observe-only
    // mode (R12): reaping a crashed run's temporaries, and re-spelling names.
    // The pass over staging still runs, because counting what it will not
    // remove is a read and is the only thing that tells anybody a preserved
    // version is sitting there (R35); the removal half is what it skips.
    const stagingUnknown = await this.reapStaleTemps();
    const listed = await this.listFiles(options.forceFull === true, options.checked === true);

    // Recovery remains an authoritative inventory on every pass, including
    // passes whose visible files came from the watcher-backed listing.
    const inventory = await this.ledger.inventory(!this.observeOnly);
    this.displaced = inventory.waiting;
    this.recovery =
      stagingUnknown === undefined
        ? inventory
        : {
            ...inventory,
            complete: false,
            why: inventory.why ? `${stagingUnknown}; ${inventory.why}` : stagingUnknown,
          };
    const already = new Set(this.stranded);
    for (const d of this.displaced) {
      if (!already.has(d.at) && !liveTemps.has(join(this.root, d.at))) {
        this.stranded.push(d.at);
        already.add(d.at);
      }
    }
    return listed;
  }

  private async listFiles(forceFull: boolean, checked = false): Promise<FileStat[]> {
    if (
      !forceFull &&
      !this.observeOnly &&
      this.listingWatchers.size > 0 &&
      Date.now() < this.fullScanDue
    ) {
      const cached = this.cachedListing;
      if (cached) {
        // Drain before awaiting: an event arriving during a stat belongs to
        // the next pass, even if it names the same file.
        const changes = [...this.listingChanges];
        this.listingChanges.clear();
        const gate = limiter(SCAN_CONCURRENCY);
        try {
          await Promise.all(
            changes.map((path) =>
              gate(async () => {
                const s = await lstat(await this.absolute(path)).catch(
                  (err: NodeJS.ErrnoException) => {
                    if (err.code === "ENOENT" || err.code === "ENOTDIR") return undefined;
                    throw err;
                  },
                );
                if (!s?.isFile()) {
                  this.invalidateListing();
                  return;
                }
                cached.set(path, {
                  path,
                  folder: false,
                  mtime: s.mtimeMs,
                  ctime: s.birthtimeMs || s.ctimeMs,
                  size: s.size,
                  changeId: `${s.dev}:${s.ino}:${s.ctimeMs}`,
                });
              }),
            ),
          );
        } catch (err) {
          this.invalidateListing();
          throw err; // Unreadable is never an authoritative deletion.
        }
        if (this.cachedListing === cached) return [...cached.values()];
      }
    }

    this.invalidateListing();
    const generation = this.listingGeneration;
    this.diskName.clear();
    this.spellingsKnown.clear();
    this.ambiguousPaths = [];
    // One gate for the whole scan, not one per directory, which is what makes
    // the bound hold however deep the tree goes (I06).
    const gate = limiter(SCAN_CONCURRENCY);
    const together = async <T>(work: readonly T[]): Promise<Awaited<T>[]> => {
      if (!checked) return Promise.all(work);
      // A failed child walk used to leave its siblings updating the reader's
      // caches after the next queued request had started using them.
      const results = await Promise.allSettled(work);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return results.map((result) => (result as PromiseFulfilledResult<Awaited<T>>).value);
    };
    const walk = async (dir: string, prefix: string): Promise<FileStat[]> => {
      const before = checked ? await lstat(dir, { bigint: true }) : undefined;
      const checkDirectory = async (): Promise<void> => {
        if (!before) return;
        const now = await lstat(dir, { bigint: true });
        if (!before.isDirectory() || !now.isDirectory() || !sameSnapshot(before, now)) {
          throw new CheckedPathError("changed_during_read", "a directory changed during inventory");
        }
      };
      await checkDirectory();
      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        // Rule 2: absent and unreadable are different states. A directory
        // that cannot be read is not an empty one, and treating it as
        // empty would report every file in it as deleted.
        throw new Error(`cannot read ${dir}: ${(err as Error).message}`);
      }
      // A saved Dirent described a folder that had already become a link.
      // MCP then listed outside note titles through that stale type check.
      await checkDirectory();

      // Symlinks and anything else are left alone: following one would
      // sync a file that is not in the vault, and copying it as a link
      // would sync a path that means nothing elsewhere. `readdir` answers
      // for the entry rather than its target, so a link is neither a file
      // nor a directory here and a cyclic one is never looked through
      // (cli/vault.test.ts, "symlinks in the listing").
      //
      // A write in flight from this client is skipped too. Listing one
      // would sync a half-written note under a name about to vanish.
      //
      // Every name is reported in NFC, whatever the disk spells it in. A Mac
      // hands back what Finder wrote, which is NFD, and every other device
      // spells the same name NFC: the two are one name by definition, not
      // two a person could choose between. Reporting the disk's bytes had
      // this client disagree with the plugin about what one vault contains,
      // and two devices each refusing the other's spelling of one note for
      // ever, naming two strings nobody can tell apart.
      //
      // And the disk is put into that spelling as well, because reporting one
      // name while holding another leaves this device the only one with the
      // spelling it invented (`normalizeName`). Where the rename cannot
      // happen the disk's spelling is remembered instead, so reads and writes
      // still land on the file (cli/vault.test.ts, "a name the disk spells in
      // NFD"; cli/vault-spelling.test.ts; cli/normalization.test.ts).
      //
      // A no-break space is reported as a plain one, as the plugin reports it,
      // and is only ever mapped, never re-spelled: `reported` is the name the
      // engine sees, `spelled` the one the disk is put into
      // (cli/no-break-space.test.ts).
      this.spellingsKnown.add(prefix);
      // Displaced versions the scan meets on its way past (R46). Not listed,
      // because they are not notes and syncing one would be publishing a
      // conflict copy nobody made; recorded, because a version this client
      // took off a name and could not put anywhere is the one thing in the
      // vault nobody else knows about.
      for (const item of items) {
        if (item.isFile() && isParkedOriginal(item.name)) {
          const at = join(dir, item.name);
          if (!liveTemps.has(at)) this.stranded.push(relative(this.root, at));
        }
      }
      const found = items
        .map((item) => ({
          item,
          name: this.reported(item.name),
          disk: item.name,
          spelled: this.normal(item.name),
        }))
        .filter(
          ({ item, name }) =>
            !this.neverSynced(prefix ? `${prefix}/${name}` : name) &&
            !isTemporary(item.name, join(dir, item.name)) &&
            (item.isDirectory() || item.isFile()),
        )
        .filter(({ item, name }) => {
          if (!checked) return true;
          try {
            this.assertPathPolicy(
              prefix ? `${prefix}/${name}` : name,
              item.isDirectory() ? "directory" : "file",
            );
            return true;
          } catch {
            return false;
          }
        });

      // A disk that keeps the two spellings apart can hold both, and then
      // there is no right answer to which one syncs. Every disk can hold a
      // plain space beside a no-break one, and the plugin blocks that pair the
      // same way (plugin/vault.test.ts, "two names the plugin cannot hold
      // apart"), so both files stay where they are and neither is uploaded.
      //
      // It used to throw, which stopped the whole vault: one ambiguous pair
      // and four thousand other notes went nowhere, including the ones a
      // person was writing that minute, until somebody renamed one of two
      // names that look identical. Fail loudly is rule 2 and it is satisfied
      // by naming the pair; stopping every other note is not what it asks
      // for, and a vault that syncs nothing is the larger risk to the first
      // rule. So the pair is blocked by name and the rest of the vault keeps
      // going, which is what the engine already does for two server paths
      // that alias one local file (`refuseAliases`).
      //
      // Left out of the listing and reported separately, never silently
      // dropped: a path that vanishes from a listing is a path the engine
      // reports deleted (cli/vault-spelling.test.ts, "blocks the one name two
      // files claim and syncs the rest of the vault").
      const byNormal = new Map<string, typeof found>();
      for (const entry of found) {
        const same = byNormal.get(entry.name);
        if (same) same.push(entry);
        else byNormal.set(entry.name, [entry]);
      }

      const kept: typeof found = [];
      const rawNames = new Set(items.map((item) => item.name));
      for (const [name, group] of byNormal) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (group.length > 1) {
          // Whole paths, because "two files called café.md" does not say
          // which folder to look in, and the folders above are unambiguous
          // by construction: a folder two names claim is never walked into.
          this.ambiguousPaths.push({
            path,
            spellings: group.map((e) => (prefix ? `${prefix}/${e.disk}` : e.disk)).sort(),
          });
          // No mapping either. `absolute` would otherwise pick one of the two
          // and a write would land on the note the person did not mean.
          this.diskName.delete(path);
          continue;
        }
        const only = group[0]!;
        if (!this.observeOnly && only.disk !== only.spelled && !rawNames.has(only.spelled)) {
          await this.normalizeName(dir, only, path);
        }
        if (only.disk !== name) this.diskName.set(path, only.disk);
        kept.push(only);
      }

      // A file deleted between the readdir and its stat is absent, which is
      // an ordinary state and not a failure of the listing. Anything else
      // the stat says is still rule 2: unreadable is not the same as gone,
      // and one unreadable file is a reason to stop rather than to report
      // the rest of the vault as the whole of it.
      // `disk` rather than `item.name` from here on: the entry may have just
      // been renamed into its normal form, and statting the name it no longer
      // has would report a note that is right there as gone.
      // Every stat in the whole scan passes through one gate (I06).
      //
      // This was `Promise.all` per directory, and the recursion was another,
      // so in-flight work multiplied with depth rather than adding up: a wide
      // deep tree meant thousands of concurrent operations, and on a network
      // filesystem or under a low descriptor limit that is an EMFILE with
      // nothing useful attached to it.
      //
      // The gate is on the stats and not on the recursion, and that is the
      // whole design. Stats are leaves, so a slot is held for one syscall and
      // released; a directory that held a slot while its children waited for
      // one would deadlock the moment the tree was deeper than the limit.
      // Bounding the recursion instead, by walking subdirectories one at a
      // time, was measured and cost nearly three times the wall clock on 2,880
      // files: correct, and not worth it when the descriptors were never the
      // recursion's to exhaust.
      const stats = await together(
        kept.map(({ item, disk }) =>
          checked || item.isFile()
            ? gate(() =>
                (checked ? lstat(join(dir, disk)) : stat(join(dir, disk))).catch(
                  (err: NodeJS.ErrnoException) => {
                    if (err.code === "ENOENT") return undefined;
                    throw err;
                  },
                ),
              )
            : undefined,
        ),
      );
      if (checked) {
        for (let i = 0; i < kept.length; i++) {
          const info = stats[i];
          if (info && (kept[i]!.item.isDirectory() ? !info.isDirectory() : !info.isFile())) {
            throw new CheckedPathError(
              "changed_during_read",
              "a file type changed during inventory",
            );
          }
        }
      }
      const children = await together(
        kept.map(({ item, name, disk }, i) =>
          item.isDirectory() && (!checked || stats[i] !== undefined)
            ? walk(join(dir, disk), prefix ? `${prefix}/${name}` : name)
            : undefined,
        ),
      );
      await checkDirectory();

      const out: FileStat[] = [];
      for (let k = 0; k < kept.length; k++) {
        const { item, name } = kept[k]!;
        const path = prefix ? `${prefix}/${name}` : name;
        if (item.isDirectory()) {
          if (checked && stats[k] === undefined) continue;
          out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
          out.push(...children[k]!);
        } else {
          const s = stats[k];
          if (s === undefined) continue; // gone since the readdir
          out.push({
            path,
            folder: false,
            mtime: s.mtimeMs,
            // birthtimeMs is unreliable across platforms, which
            // Obsidian cared about enough to ship native addons for.
            // Carried because the protocol carries it, and read by
            // nothing that decides.
            ctime: s.birthtimeMs || s.ctimeMs,
            size: s.size,
            changeId: `${s.dev}:${s.ino}:${s.ctimeMs}`,
          });
        }
      }
      return out;
    };
    const scanRoot = checked ? await (this.realRootOnce ??= realpath(this.root)) : this.root;
    const listed = await walk(scanRoot, "");
    // And again after the walk, which reads every folder by its path: a root
    // that changed part way through gave half a listing from each (T16).
    await this.sameVault(true);
    if (
      !this.observeOnly &&
      this.listingWatchers.size > 0 &&
      generation === this.listingGeneration &&
      this.stranded.length === 0 &&
      this.ambiguousPaths.length === 0
    ) {
      // Parked originals outside staging require the full walk to keep their
      // recovery inventory current. Ambiguous spellings do as well.
      this.cachedListing = new Map(listed.map((entry) => [entry.path, entry]));
      this.fullScanDue = Date.now() + 30_000;
    }
    return listed;
  }

  /**
   * One note's bytes, from inside the vault and from a real file.
   *
   * `absolute` is lexical. It refuses `../` and the excluded names and it
   * cannot see a link, which is why every write follows it with
   * `insideForReal`. Reading did not, and that was defensible while the only
   * caller was the engine: it reads paths its own `list` produced, and `list`
   * does not follow links. It stops being defensible as soon as a path
   * arrives from somewhere that is not this device, and `trew mcp` hands an
   * agent's path straight to the adapter.
   *
   * Two different holes, so two different answers. An ancestor that is a link
   * is `insideForReal`, the check the writes already make. The leaf is not:
   * `refuseOutsideVault` resolves `dirname`, so a link sitting exactly where
   * the note should be goes straight through it.
   *
   * The leaf is refused rather than resolved, because resolving it is not
   * enough either. A link inside the vault pointing at `.trew/config.json`
   * resolves to a path under the root, so a containment test would pass it
   * and hand over the device credential. `list` omits links and `stat`
   * lstats deliberately, so a link is already not a note anywhere else here;
   * this only makes reading agree.
   *
   * `O_NOFOLLOW` rather than an `lstat` first, so there is no instant between
   * deciding and opening for the path to become a link.
   */
  async read(path: string): Promise<Uint8Array> {
    const handle = await this.openNote(path);
    try {
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  /**
   * Opens a note for reading, refusing a link at its name or above it (F24).
   *
   * One door for every read of a note's bytes (T25). `readBlocks` and
   * `readRange` opened the path plainly, so a file over 8 MiB, which the
   * engine reads in blocks rather than whole, was read through a link that
   * `read` would have refused: an attachment swapped for a link to
   * `.trew/config.json` after the scan handed over the device credential to be
   * uploaded as the attachment.
   */
  private async openNote(path: string): Promise<Awaited<ReturnType<typeof open>>> {
    const full = await this.absolute(path);
    await this.readableDir(full);
    try {
      return await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      // ELOOP is what both kernels raise for a link under O_NOFOLLOW. macOS
      // has also been seen to answer EMLINK, which means nothing else here.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") {
        throw new Error(`refusing a path that leaves the vault through a link: ${full}`);
      }
      throw err;
    }
  }

  /**
   * One path's stat, for the check the engine makes before destroying bytes.
   *
   * `lstat`, not `stat`, and deliberately: the question is whether this path
   * still holds the file the pass decided about, and a symlink that appeared
   * where a note was is a different answer, not the same one seen through.
   *
   * Only absence is absent (T19, rule 2). Every error used to be reported as
   * absent, and the engine asks this after a read fails to decide whether the
   * note is gone: a folder that lost its search permission between the scan
   * and the read made an unsent edit read as a deletion, which went to the
   * server and from there into the trash of every other device. A stat that
   * fails now fails, and the engine keeps the file and tries again.
   */
  async stat(path: string): Promise<FileStat | undefined> {
    let st;
    try {
      st = await lstat(await this.absolute(path));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Not there, or an ancestor that is a file rather than a folder.
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw err;
    }
    if (st.isDirectory()) return { path, folder: true, mtime: 0, ctime: 0, size: 0 };
    if (!st.isFile()) return undefined;
    return {
      path,
      folder: false,
      mtime: st.mtimeMs,
      ctime: st.birthtimeMs || st.ctimeMs,
      size: st.size,
      changeId: `${st.dev}:${st.ino}:${st.ctimeMs}`,
    };
  }

  /**
   * The file in blocks, so a large one can be chunked without being held.
   *
   * A megabyte at a time: large enough that the per-read cost disappears,
   * small enough that peak memory is bounded by something other than the file.
   */
  async *readBlocks(path: string, blockSize = 1024 * 1024): AsyncGenerator<Uint8Array> {
    const handle = await this.openNote(path);
    try {
      const buf = new Uint8Array(blockSize);
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, blockSize, null);
        if (bytesRead === 0) return;
        // Copied rather than yielded as a view, because the buffer is
        // reused for the next block and a consumer that kept the view
        // would find it rewritten underneath.
        yield buf.slice(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
  }

  async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const handle = await this.openNote(path);
    try {
      const out = new Uint8Array(end - start);
      let at = 0;
      while (at < out.length) {
        const { bytesRead } = await handle.read(out, at, out.length - at, start + at);
        if (bytesRead === 0) break;
        at += bytesRead;
      }
      // Short means the file shrank since it was named. The caller checks
      // the chunk against its name and fails this file rather than
      // sending bytes under a name that is not theirs.
      return at === out.length ? out : out.subarray(0, at);
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes a file, then sets its modification time to the one given.
   *
   * The timestamp is not decoration. The engine's decision table compares
   * mtimes, so a downloaded file stamped with the moment it landed looks
   * locally edited on the very next pass, and the device would upload back what
   * it just received, forever.
   */
  async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    this.invalidateListing();
    const full = await this.absolute(path);
    await this.insideForReal(full);
    const had = await this.deepestExisting(full);
    await mkdir(dirname(full), { recursive: true });
    await this.matchCase(full);
    await this.checkStaging();
    await writeDurably(full, bytes, false, { mtime: times.mtime, stageIn: this.staging });
    this.dirty(full, had);
  }

  /** Where this vault's temporary files live: under its own state folder, never beside a note. */
  private get staging(): string {
    return join(this.root, STATE_FOLDER, "tmp");
  }

  /**
   * The staging directory, checked once per process for leaving the vault
   * (F24).
   *
   * Note destinations were validated and the internal directories were not,
   * so a `.trew` that is a link somewhere else staged every note this
   * device wrote outside the vault, in plaintext, on the way in. Checked once
   * and remembered: it is the same path for the life of the process, and
   * asking `realpath` per write would be a syscall on the hot path for an
   * answer that cannot change without somebody moving the directory under a
   * running client.
   */
  private stagingChecked: Promise<void> | undefined;

  private checkStaging(): Promise<void> {
    return (this.stagingChecked ??= this.insideForReal(join(this.staging, "x")));
  }

  /**
   * Renames an existing file to the spelling being written, where they differ.
   *
   * On a filesystem that folds case, writing `NOTE.md` over an existing
   * `Note.md` writes the same file and leaves the directory entry spelled the
   * old way. The bytes are then right and the name is not, so the next scan
   * reports `NOTE.md` missing, the engine calls it deleted, and the deletion
   * travels to every other device. A rename that only changed case therefore
   * lost the note everywhere, one pass later than it looked.
   *
   * Only reached when the target already exists, which for a first download is
   * never, so it costs nothing on the path that moves the most files.
   */
  private async matchCase(full: string): Promise<void> {
    let there;
    try {
      there = await stat(full);
    } catch (err) {
      // Only absence means absent. Anything else is a disk that would not
      // answer, and writing on top of an answer it did not give is how a
      // note ends up spelled one way on disk and another in the index.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (there.isDirectory()) return;

    const dir = dirname(full);
    const want = basename(full);
    const entries = await readdir(dir);
    if (entries.includes(want)) return; // Spelled the way it is being written.

    const folded = foldPath(want);
    const actual = entries.find((e) => foldPath(e) === folded);
    if (actual === undefined) return;
    await rename(join(dir, actual), full);
    this.unflushed.add(dir);
  }

  /**
   * Removes a path by moving it into the vault's trash.
   *
   * Not `rm`. A deletion arriving over the wire was somebody's decision on
   * another device, possibly a mistaken one, and the first rule is not to
   * lose a note. The Obsidian adapter has always trashed rather than deleted
   * and this one did not, which is the same defect Sync Engine had reported
   * against it as issue 232: files destroyed on one platform and trashed on
   * another, by the same sync.
   *
   * `.trash` is in the never-sync list, so what lands there does not travel
   * back out and undo the deletion everywhere else.
   */
  /**
   * Writes over a file without ever destroying the bytes that were there
   * (R01).
   *
   * The engine's guard used to be a stat taken immediately before the write:
   * same size, same rounded mtime, presumed untouched. An edit that keeps the
   * length, which is most corrections, saved inside the same second, passes
   * it and is overwritten with no copy anywhere. Narrowing the window does not
   * help, because there is no compare-and-swap on a file.
   *
   * So nothing here predicts. The order is: stage the new bytes and make them
   * durable, *move* whatever is at the path aside, then link the new content
   * into the name that is now free. The move is a rename, which is atomic and
   * keeps every byte; at no point are bytes about to be destroyed. Whatever
   * came out is hashed afterwards, and if it is not what the caller decided
   * about it is handed back for the caller to keep.
   *
   * The one remaining instant is between the rename away and the link back,
   * when the name does not exist. A save landing exactly there wins: `link`
   * refuses an occupied name, so the new file stays and the caller is handed
   * the older bytes to place beside it. That is the safe way round.
   */
  async replace(
    path: string,
    expect: ExpectedContent | undefined,
    bytes: Uint8Array,
    times: Times,
    keepAt: string,
  ): Promise<Replaced> {
    this.invalidateListing();
    const full = await this.absolute(path);
    await this.insideForReal(full);
    const had = await this.deepestExisting(full);
    await mkdir(dirname(full), { recursive: true });
    await this.matchCase(full);
    await this.checkStaging();

    // No early exit for a caller with no baseline (R33).
    //
    // It used to be an ordinary overwrite, on the reasoning that a path the
    // pass had not seen holds nothing worth keeping. The pass saw the path at
    // the start and writes at the end, and a note created in between is
    // exactly what that reasoning destroys. Undefined means "I cannot say what
    // I decided about", which is a reason to keep what is found and not a
    // licence to write over it. Where the path really is free this costs one
    // failed rename.
    const kept = await this.absolute(keepAt);
    await this.insideForReal(kept);
    let staged = join(this.staging, `replace.${randomBytes(8).toString("hex")}`);
    // Named out here so the `finally` can say it is no longer this call's.
    const parked = `${full}.${PARKED_MARK}${randomBytes(4).toString("hex")}`;
    let retained: string | undefined;
    let failed = false;
    const failure = (error: unknown): unknown =>
      retained === undefined ? error : new PreservationError(error, [retained]);
    try {
      // Durable before anything is moved: a crash after the rename below must
      // not leave the path empty and the new content only in memory.
      await writeDurably(staged, bytes, true, { mtime: times.mtime, stageIn: this.staging });

      // On the destination's filesystem, decided before the original moves
      // (R37).
      //
      // `link` cannot cross a filesystem, and `.trew/tmp` is a separate
      // mount on any vault assembled out of several. The old order staged
      // there, moved the note aside, and only then found out: the note's own
      // name was empty, the bytes were at a conflict path, and the incoming
      // version had nowhere to go. Asking two stats first turns that into a
      // second staging copy beside the destination, where a link always
      // reaches.
      if (!(await sameFilesystem(staged, dirname(full)))) {
        const near = `${full}.${TEMP_MARK}near${randomBytes(4).toString("hex")}`;
        await writeDurably(near, bytes, true, { mtime: times.mtime });
        await rm(staged, { force: true });
        staged = near;
      }

      // The displaced version goes to a real path in the vault, not to staging
      // (R18, R21). Staging is swept by the scan's reaper, which cannot tell a
      // half-finished write from somebody's only copy of a note, and a rename
      // carries the old timestamp so it looks old the moment it lands there.
      // A note is a note: discoverable, backed up, and never aged out.
      //
      // A sibling of the file, so this rename is within one directory and
      // cannot meet EXDEV however the vault is mounted.
      //
      // Into a temporary of this call's own rather than straight to `keepAt`
      // (R43). The name the caller chose was free when it chose it, and the
      // durable staging above happens in between; `rename` replaces, so a note
      // created at that name meanwhile was destroyed by the operation that
      // exists to preserve notes. Taking it away from `full` still has to be a
      // rename, because that is the only atomic way to get exactly the bytes
      // that are there; where they go afterwards is a `link`, which refuses an
      // occupied name.
      let moved = true;
      // Declared before it exists, and cleared in the `finally` below. A
      // parked original is a stranded version to anything that walks past it,
      // and for the few milliseconds this operation holds one it is not: a
      // scan in this process would otherwise report a note that is about to be
      // placed, and `status` exits non-zero on that. Another process still
      // sees it, and truthfully -- the bytes really are there under a name
      // nothing lists -- which is the cost of a lock-free `status` and clears
      // itself on the next look.
      liveTemps.add(parked);
      // Staged and durable, and the note is still under its own name. A save
      // landing here is one this operation has not looked at yet.
      await midReplace.staged(path);
      try {
        await rename(full, parked);
        retained = relative(this.root, parked);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // Nothing there, which is the ordinary first download and also a
        // caller who expected content and found none. Either way there is
        // nothing to preserve.
        moved = false;
      }

      let landed = true;
      // The note's name holds nothing at all, and this operation emptied it.
      // The widest window in this file, and until the fault driver went
      // looking there was no way to stop the world inside it.
      await midReplace.nameFree(path);
      try {
        await link(staged, full);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          // Somebody created a file in the instant the name was free. Theirs
          // stays: it is the newest thing anybody wrote, and this write is
          // acting on a decision older than it. The caller is told the
          // incoming version has nowhere to go.
          landed = false;
        } else {
          // Publication failed for a reason of its own, and the note's name is
          // empty because this emptied it. Put it back before the error
          // travels (R37): a caller that sees a failure should find the vault
          // as it was, not a note renamed to a conflict copy for a reason that
          // has nothing to do with a conflict.
          if (moved && !(await this.putBack(parked, full))) {
            const at = await claimPreserved(parked, kept).catch(() => parked);
            retained = relative(this.root, at);
            // Where `claimPreserved` also failed, the version is at a parked
            // name nothing lists and only this record says which note it is.
            if (at === parked) {
              await this.noteDisplaced(
                parked,
                full,
                `${path} could not be written and its previous version could not be put back`,
              );
            }
            throw new Error(
              `${path} could not be written (${(err as Error).message}) and its previous ` +
                `version could not be put back; it is at ${relative(this.root, at)}`,
            );
          }
          retained = undefined;
          throw err;
        }
      }
      this.dirty(full, had);
      this.unflushed.add(dirname(full));

      if (!moved) return { landed };
      if (landed && expect !== undefined) {
        // Was what was displaced the version this write was decided about? If
        // so the copy is a duplicate of something the server already has, and
        // removing it is the one deletion here that destroys nothing. With no
        // baseline there is nothing to compare it against, so it is kept
        // (R33): unknown is not the same as agreed.
        //
        // Read from the parked copy, which nothing else can reach, rather than
        // from the preservation path: hashing a name and then removing it is
        // the shape this file spends its length avoiding.
        const digest = await digestOf(parked).catch(() => undefined);
        if (digest !== undefined && digest === expect.contentId) {
          await rm(parked, { force: true });
          retained = undefined;
          return { landed: true };
        }
      }
      // Kept: either it was not what this write expected, or the write did not
      // land and the displaced version is all there is. Its path is returned
      // rather than its bytes, so nothing depends on the caller finishing.
      //
      // Claimed rather than taken: the name was free when the caller chose it
      // and a note may have arrived at it since (R43).
      let at: string;
      try {
        at = await claimPreserved(parked, kept);
        retained = relative(this.root, at);
      } catch (err) {
        // The displaced version has nowhere to go: the conflict name and every
        // sibling of it are taken, or that directory cannot be written. The
        // bytes are safe under the parked name and nothing lists it, so the
        // record is the only thing between this and a lost note (R46).
        await this.noteDisplaced(
          parked,
          full,
          `the version replaced at ${path} could not be placed at ${keepAt} ` +
            `(${(err as Error).message})`,
        );
        throw err;
      }
      this.dirty(at, had);
      this.unflushed.add(dirname(at));
      return { keptAt: relative(this.root, at), landed };
    } catch (error) {
      failed = true;
      throw failure(error);
    } finally {
      // Only the staged copy, and only ever the staged copy. `link` leaves it
      // behind by design, so there is always one to remove. The preserved
      // version is a note now and is not this function's to remove; deleting
      // recovery data in a `finally` is how a failure anywhere above used to
      // take the original with it (R18). The parked original is not removed
      // here either, for the same reason: every path above either puts it
      // somewhere or names it in the error.
      try {
        await rm(staged, { force: true });
      } catch (error) {
        // The publication failure already names its retained version. A
        // second cleanup error must not replace that recovery information.
        if (!failed) throw failure(error);
      } finally {
        // Cleanup failure must not hide a stranded version from the next scan.
        liveTemps.delete(parked);
      }
    }
  }

  /**
   * Puts a preserved version back under its own name, if the name is free.
   *
   * `link` rather than `rename`, so a file that arrived at the name while this
   * was deciding is not written over: the note stays where it was preserved
   * and the caller says so.
   */
  private async putBack(from: string, to: string): Promise<boolean> {
    try {
      await link(from, to);
    } catch {
      return false;
    }
    await rm(from, { force: true });
    this.unflushed.add(dirname(to));
    return true;
  }

  /**
   * Removes a file, and says so when what it removed was not what the caller
   * meant to remove (R01).
   *
   * The deletion half of `replace`. `remove` already moves the file to the
   * trash rather than unlinking it, so nothing is destroyed either way; what
   * this adds is telling the caller that the thing it deleted had changed, so
   * a deletion decided before a fetch does not quietly take an edit made
   * during it and report it as an ordinary removal.
   */
  async removeExpecting(
    path: string,
    expect: ExpectedContent | undefined,
    keepAt: string,
  ): Promise<Replaced> {
    this.invalidateListing();
    const full = await this.absolute(path);
    await this.insideForReal(full);
    const present = await lstat(full).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (present === undefined) {
      // Nothing there. Two devices deleting one file produces this routinely;
      // `remove` says the same by doing nothing. Asked with `lstat` and not by
      // hashing: hashing to find out whether a file exists reads a 256 MiB
      // attachment to learn what one syscall knows, and calls a file that
      // cannot be read a file that is gone.
      // A second, unconditional remove used to trash a save arriving after
      // this missing-path observation, bypassing the expected digest.
      return { landed: true };
    }

    // Moved out of the way first, and identified afterwards (R22).
    //
    // It used to hash the file and then `rm` the path, and `rm` removes
    // whatever is at the name at that moment: an editor replacing it between
    // the two deleted a version nothing had ever seen. A rename takes the
    // exact bytes that were there, atomically, and then they can be looked at
    // at leisure.
    //
    // Under a temporary name beside it rather than at `keepAt`, because most
    // of the time this is an ordinary deletion and the file is going to the
    // trash. Parked at the conflict-copy path it reached the trash *called* a
    // conflict copy, which is a name nobody searches for and a claim that
    // something was in conflict when nothing was.
    const aside = `${full}.${PARKED_MARK}${randomBytes(4).toString("hex")}`;
    // Not a stranded version while this call is holding it; see `replace`.
    liveTemps.add(aside);
    try {
      await rename(full, aside);
    } catch (err) {
      liveTemps.delete(aside);
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { landed: true }; // gone between the lstat and here
    }
    this.unflushed.add(dirname(full));
    await midTrash.parked(aside);

    // Everything from here can fail, and the note is off its own name until
    // one of these branches puts it somewhere.
    //
    // It used to be unguarded. `replace` was given a put-back and this was
    // not, so a failed `mkdir`, an `insideForReal` that refused, or a disk
    // that said no left the note at `aside`: a name `isTemporary` hides from
    // every listing, in a directory the staging reaper never reads, which
    // `stranded` therefore never counts. The next pass saw the path missing
    // and the server saying deleted, agreed, and the unsent edit was gone from
    // every surface with no error anywhere.
    try {
      // With no baseline there is nothing to compare against, so whatever
      // this took is kept (R33): unknown is not the same as agreed.
      const digest =
        expect === undefined ? undefined : await digestOf(aside).catch(() => undefined);
      if (digest !== undefined && expect !== undefined && digest === expect.contentId) {
        // The version the pass decided to delete. It goes where a deletion
        // goes, which is the trash, under the name it had.
        await this.intoTrash(full, aside);
        return { landed: true };
      }
      // Something else, so it is not deleted at all. It comes back out under a
      // name a person will find, and the engine says so.
      const kept = await this.absolute(keepAt);
      await this.insideForReal(kept);
      const had = await this.deepestExisting(kept);
      await mkdir(dirname(kept), { recursive: true });
      // Claimed, not taken (R43): the caller chose this name because it was
      // free, and a hash and a trash decision have happened since. `rename`
      // would replace a note that arrived at it in between.
      const at = await claimPreserved(aside, kept);
      this.dirty(at, had);
      this.unflushed.add(dirname(at));
      return { keptAt: relative(this.root, at), landed: true };
    } catch (err) {
      // Back under its own name, which is where a caller that sees a failure
      // should find it. `putBack` refuses an occupied name, so a file that
      // arrived while this was deciding keeps it.
      if (await this.putBack(aside, full)) throw err;
      try {
        await this.noteDisplaced(
          aside,
          full,
          `${path} was taken off its name to be identified and could not be put back`,
        );
      } catch (ledgerError) {
        throw new PreservationError(ledgerError, [relative(this.root, aside)]);
      }
      // MCP redacts filesystem error text. A recovery path only named in
      // that text disappeared from its deletion response despite surviving.
      throw new PreservationError(err, [relative(this.root, aside)]);
    } finally {
      // It stops being this call's business either way, so a later scan
      // reports it if it is still there.
      liveTemps.delete(aside);
    }
  }

  /**
   * The digest of one path's contents, hashed as it is read (R31).
   *
   * The engine used to do this by collecting every block a vault streamed and
   * joining them, which holds the file twice: once in the pieces and once in
   * the copy. Here the hash consumes each block and keeps none of them, so a
   * 256 MiB attachment costs one pass and a few kilobytes.
   */
  contentDigest = async (path: string): Promise<string | undefined> =>
    digestOf(await this.absolute(path)).catch(() => undefined);

  async remove(path: string): Promise<void> {
    this.invalidateListing();
    const full = await this.absolute(path);
    await this.insideForReal(full);
    try {
      await access(full, constants.F_OK);
    } catch (err) {
      // Two devices deleting the same file produces this routinely. Only
      // this, though: a file that cannot be looked at is not a file that
      // is gone, and saying it was removed would have the index agree.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    await this.intoTrash(full, full);
  }

  /**
   * Removes an empty folder, and only an empty one.
   *
   * `rmdir` is the check. It is one system call that removes a directory the
   * kernel finds empty and refuses one holding anything, hidden files and
   * ignored ones included, so there is no moment between a look and a removal
   * for a note saved into the folder to be lost in: the note is either in it
   * before the call, which then refuses, or it has nowhere to land after.
   * Never `rm`, and never the trash, which would carry anything inside away
   * with it (docs/design.md, "Folders").
   */
  async removeFolder(path: string): Promise<boolean> {
    this.invalidateListing();
    const full = await this.absolute(path);
    await this.insideForReal(full);
    try {
      const at = await lstat(full);
      // A file or a link at the name is not a folder this can remove.
      if (!at.isDirectory()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    await midRemoveFolder.pause(full);
    try {
      await rmdir(full);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      // Linux answers ENOTEMPTY, and POSIX allows EEXIST for the same thing.
      if (code === "ENOTEMPTY" || code === "EEXIST") return false;
      throw err;
    }
    // The folder's own entries were owed a flush by the writes that made
    // them, and there is nothing left to open and sync: what is owed now is
    // its parent, which lost an entry.
    for (const owed of this.unflushed) {
      if (owed === full || owed.startsWith(`${full}${sep}`)) this.unflushed.delete(owed);
    }
    this.unflushed.add(dirname(full));
    return true;
  }

  /**
   * Gives a folder another spelling of its own name (see `Vault.respellFolder`).
   *
   * The directory is read for the entry as the disk spells it, because a path
   * resolves to that spelling whichever way it is asked. Refused where the
   * two do not fold together, where the disk already has the wanted spelling,
   * or where it holds both, which is two folders and not this.
   */
  async respellFolder(from: string, to: string): Promise<boolean> {
    if (from === to || foldPath(from) !== foldPath(to)) return false;
    this.invalidateListing();
    const full = await this.absolute(from);
    await this.insideForReal(full);
    const dir = dirname(full);
    const want = to.slice(to.lastIndexOf("/") + 1);
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.name === want)) return false;
    const have = entries.filter((e) => foldPath(e.name) === foldPath(want));
    if (have.length !== 1 || !have[0]!.isDirectory()) return false;
    await rename(join(dir, have[0]!.name), join(dir, want));
    this.unflushed.add(dir);
    return true;
  }

  /**
   * Moves `from` into the trash under the name the file at `full` had.
   *
   * The two are separate because `removeExpecting` disposes of a note that is
   * sitting under a temporary name by then, and the trash entry has to carry
   * the note's own name rather than the one it was parked under. A person
   * looking for the note they deleted searches for `doomed.md`.
   *
   * The disk's name, not the engine's: a note named with a no-break space
   * goes into the trash under that name, as the plugin's `trashLocal` of the
   * real name puts it there.
   */
  private async intoTrash(full: string, from: string): Promise<void> {
    const target = await this.freeTrashPath(relative(this.root, full).split(sep).join("/"));
    // The destination is checked too (F24).
    //
    // The source's parents were validated and the trash path was then built
    // and used without the same question being asked of it. A `.trash` that
    // is a symlink out of the vault therefore moved notes outside it, which
    // is the deletion path quietly becoming an export. `.trew` and the
    // staging directory get the same treatment where they are made.
    await this.insideForReal(target);
    const had = await this.deepestExisting(target);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(from, target);
      this.unflushed.add(dirname(from));
      this.dirty(target, had);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    }
    // The trash is on another filesystem, which happens when a vault spans
    // mounts. Copied, checked byte for byte, and only then removed.
    await copyVerifiedThenRemove(from, target);
    this.unflushed.add(dirname(from));
    this.dirty(target, had);
  }

  /**
   * Where in the trash a path can go without displacing what is already there.
   *
   * Deleting, restoring and deleting again is ordinary, and the second
   * deletion overwriting the first would quietly discard a version somebody
   * might want. Numbered rather than timestamped so the order is obvious, and
   * in brackets, which is how it has always spelled them.
   *
   * The search is `firstFreeName`, shared with the conflict copy and the
   * plugin's staging name. What is local to the trash is the answer to
   * "taken": a name that cannot be looked at may well be occupied, and moving
   * a note onto it would replace what is there, so an error is not a "no".
   */
  private async freeTrashPath(path: string): Promise<string> {
    const base = join(this.root, TRASH_DIR, path);
    // Split on the vault-relative path, which always uses forward slashes,
    // and take the extension off the joined absolute one, which may not.
    const { ext } = splitName(path);
    const stem = ext === "" ? base : base.slice(0, base.length - ext.length);
    return firstFreeName(base, occupied, (n) => `${stem} (${n})${ext}`);
  }

  async mkdir(path: string): Promise<void> {
    this.invalidateListing();
    const full = await this.absolute(path);
    await this.insideForReal(full);
    const had = await this.deepestExisting(join(full, "x"));
    await mkdir(full, { recursive: true });
    this.dirty(join(full, "x"), had);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(await this.absolute(path), constants.F_OK);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      // Not "no": a disk that would not answer. The callers here go on to
      // write beside or over the answer, so an honest error beats a guess.
      throw err;
    }
  }

  /**
   * The name this filesystem will actually file a path under.
   *
   * Case folding is asked of the disk once, by creating a probe under the
   * state folder and looking for it under the other spelling. Unicode is
   * folded to NFC whatever the disk does: HFS+ normalises and APFS does
   * not, and a note that syncs between the two is one file on one and two
   * on the other, so treating them as one everywhere is the side that keeps
   * both copies. Obsidian's no-break spaces are folded too, which is what
   * the plugin's `canonical` does through `normalizePath`.
   */
  canonical(path: string): string {
    const normal = this.normalPath(path);
    return this.foldsCaseSync ? normal.toLowerCase() : normal;
  }

  /**
   * Whether this filesystem folds case, worked out on first use.
   *
   * Synchronous once known, because `canonical` is called per path inside a
   * loop. Until the probe has run the answer is "yes", which is the safe
   * side: it refuses two files where one would do, never the reverse.
   */
  private foldsCaseSync = true;
  private probed: Promise<void> | undefined;

  /**
   * Runs the case probe, so `canonical` answers for this disk rather than for
   * the worst one.
   *
   * In the vault root, which is the one directory that is always already
   * there. It used to make `.trew/` on the way, and every command goes
   * through here: `trew status` reads and prints and should leave nothing
   * behind, and on a read-only mount the mkdir was a failure where there had
   * been none (R9). The name is dot-prefixed, so both clients pass over it by
   * the dot rule for the moment it exists, and carries the pid so two runs
   * over one vault cannot take each other's probe away.
   *
   * A probe that cannot be made at all, on that read-only mount or anywhere
   * else, leaves the default standing, and the default is the safe side.
   */
  probeCase(): Promise<void> {
    return (this.probed ??= (async () => {
      const probe = join(this.root, `.trew-CaseProbe-${process.pid}`);
      try {
        await (await open(probe, "wx")).close();
        try {
          await access(join(this.root, `.trew-caseprobe-${process.pid}`), constants.F_OK);
          this.foldsCaseSync = true;
        } catch {
          this.foldsCaseSync = false;
        }
      } catch {
        // Could not probe. The default stands, and it is the safe one.
      } finally {
        await rm(probe, { force: true }).catch(() => {});
      }
    })());
  }

  /**
   * Writes a file only if nothing is at the path, atomically.
   *
   * The bytes go to a temporary first, as every write does, and then a hard
   * link puts them under the final name: `link` fails with EEXIST if the name
   * is taken, and there is no moment in which the name exists half written.
   * Where the filesystem has no hard links, the file is opened exclusively
   * instead, which is exclusive but can leave a partial file after a crash.
   */
  async create(path: string, bytes: Uint8Array, times: Times): Promise<boolean> {
    this.invalidateListing();
    const full = await this.absolute(path);
    await this.insideForReal(full);
    // The staging directory too (R11). `write` checks it and this did not, so
    // the one write that must not clobber anything staged its bytes through a
    // directory nothing had asked about: a `.trew/tmp` that is a link out of
    // the vault put a conflict copy's contents outside it on the way past.
    await this.checkStaging();
    const had = await this.deepestExisting(full);
    await mkdir(dirname(full), { recursive: true });
    const { tmp, handle } = await openTemp(full, undefined, this.staging);
    try {
      try {
        await writeAll(handle, bytes);
        if (times.mtime > 0) await handle.utimes(times.mtime / 1000, times.mtime / 1000);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, full);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return false;
        // `EXDEV` belongs with the rest (F25). The staging directory is at
        // the vault root and the destination may be on a different mount, in
        // which case a hard link between them is refused for a reason that
        // has nothing to do with the filesystem's support for links. An
        // ordinary write has had a cross-device fallback for a while;
        // restores and conflict copies into a mounted subdirectory failed
        // outright without this, which is the one place a file arriving is
        // the whole point.
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV") {
          throw err;
        }
        // No link across this boundary. Exclusive open, then the bytes again,
        // which keeps the no-overwrite promise: `wx` fails if anything is
        // there, including something that appeared since the link was tried.
        let exclusive;
        try {
          exclusive = await open(full, "wx");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw e;
        }
        try {
          await writeAll(exclusive, bytes);
          if (times.mtime > 0) await exclusive.utimes(times.mtime / 1000, times.mtime / 1000);
          await exclusive.sync();
        } finally {
          await exclusive.close();
        }
      }
      this.dirty(full, had);
      return true;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
      liveTemps.delete(tmp);
    }
  }

  /**
   * Whether two paths are one file, asked of the filesystem rather than guessed.
   *
   * Device and inode, which is the only answer that holds everywhere: case
   * folding on macOS and Windows, Unicode normalisation on HFS+, and a hard
   * link, which no amount of comparing strings would catch. A path that is not
   * there is not the same file as anything, including another path that is not
   * there.
   */
  async sameFile(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    try {
      const [here, there] = await Promise.all([this.absolute(a), this.absolute(b)]);
      const [x, y] = await Promise.all([stat(here), stat(there)]);
      return x.dev === y.dev && x.ino === y.ino;
    } catch (err) {
      // Absent is not the same file as anything. Anything else is thrown,
      // and the caller, which is deciding whether a deletion would remove a
      // file this pass wrote, records a failure and keeps the file.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Reports changes under the vault, coalesced.
   *
   * Known content events refresh that file's stat. Structural or incomplete
   * events invalidate the listing. A full scan on the client's periodic tick,
   * and a cache deadline here, recover missed notifications. Without a healthy
   * watcher every listing is a full scan.
   *
   * Events delivered together share the next event-loop turn. More events
   * cannot keep postponing the scan while a folder is being copied.
   */
  watch(onChange: (path: string) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    const changed = new Set<string>();
    let watcher: FSWatcher | undefined;
    const enqueue = (path: string) => {
      changed.add(path);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const paths = [...changed];
        changed.clear();
        for (const path of paths) onChange(path);
      }, 0);
    };
    const failed = () => {
      if (watcher) this.listingWatchers.delete(watcher);
      this.invalidateListing();
    };

    try {
      this.invalidateListing(); // No cached scan can bridge a gap in watching.
      watcher = fsWatch(this.root, { recursive: true, persistent: true }, (event, filename) => {
        if (!filename) {
          this.invalidateListing();
          enqueue("");
          return;
        }
        const path = filename.toString().split(sep).join("/");
        if (isParkedOriginal(basename(path))) this.invalidateListing();
        // The state folder changes on every single pass, because that is
        // where the index is written. Watching it would mean each pass
        // scheduled the next one, forever.
        if (this.neverSynced(path)) return;
        if (isTemporary(basename(path), join(this.root, path))) return;
        const normal = this.normalPath(path);
        const known = this.cachedListing?.get(normal);
        if (event === "change" && known && !known.folder) this.listingChanges.add(normal);
        else this.invalidateListing();
        enqueue(path);
      });
      this.listingWatchers.add(watcher);
      watcher.on("error", failed);
      watcher.on("close", failed);
    } catch {
      failed();
      // Recursive watching is not available everywhere. The caller polls.
      return () => {};
    }

    return () => {
      if (timer) clearTimeout(timer);
      failed();
      watcher?.close();
    };
  }
}

/**
 * The index, in a JSON snapshot and a journal beside the vault.
 *
 * Obsidian's headless client keeps its index in SQLite, with a JSON blob per
 * path. This keeps the JSON and drops the SQLite: the whole index of a four
 * thousand note vault is a few hundred kilobytes, and a native dependency is a
 * real cost for a client that otherwise needs none. What replaced rewriting
 * the whole file on every change is a journal, not a database, because a
 * journal is the only shape that is one implementation on both shells: Node
 * has `appendFile` and Obsidian's `DataAdapter` has `append`. The reasoning
 * and the crash semantics are in `core/index-journal-store.ts`, which is where
 * both shells get them from; everything here is the five file operations it
 * needs and nothing else.
 *
 * The snapshot write is atomic. An index truncated by a crash is worse than no
 * index at all: no index re-reads the vault and recovers, while a half-written
 * one is read as fact and quietly disagrees with the server about what has
 * been synced. The log is different by construction, because a record that did
 * not land whole is discarded on the next load and the records before it are
 * not, and that is a device redoing a pass rather than a device believing
 * something untrue.
 */
export class JsonIndexStore implements IndexStore {
  private readonly store: JournalIndexStore;

  constructor(file: string, opts: JournalStoreOptions = {}) {
    this.store = new JournalIndexStore(new NodeJournalFiles(file), {
      // Loud by default, and on stderr, because everything this reports is a
      // thing the person running the client would want to know about their
      // index. A caller with somewhere better to put it passes one in.
      log: (message: string, ...rest: unknown[]) => console.warn(`trew: ${message}`, ...rest),
      ...opts,
    });
  }

  load(): Promise<StoredState | undefined> {
    return this.store.load();
  }

  /**
   * Writes the index durably, and only ever after the notes it describes.
   *
   * The engine writes every downloaded file in a pass and saves this once at
   * the end, so the ordering is already right. What was missing was the
   * durability underneath it: with neither the note nor the index fsynced, a
   * power cut could leave the index on disk saying a note was synced while the
   * note itself was not. On the next pass the file is missing, the index says
   * it matched the server, and `decideMissingLocally` reads that as "the user
   * deleted it" and propagates the deletion to every other device.
   *
   * That is a note lost silently, by a machine losing power at the wrong
   * moment, and it is the exact failure the first rule exists to refuse. It
   * holds for a record as it did for a whole file: the append is fsynced
   * before it is called done.
   */
  save(state: StoredState): Promise<void> {
    return this.store.save(state);
  }
}

/** The snapshot, the log and the stats, on a real filesystem. */
class NodeJournalFiles implements JournalFiles {
  private readonly log: string;
  /**
   * Whether the log's own name has been made durable.
   *
   * The bytes of an append are fsynced every time. The directory entry only
   * has to be, once, for a log that was not there before: a name that is not
   * durable is a log a crash can lose whole, which is an older index and safe,
   * but there is no reason to pay it more than once and no reason not to pay
   * it at all.
   */
  private named = false;

  constructor(private readonly file: string) {
    this.log = indexLogPath(file);
  }

  async readSnapshot(): Promise<string | undefined> {
    return read(this.file, `the index at ${this.file}`);
  }

  async writeSnapshot(text: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeDurably(this.file, new TextEncoder().encode(text), true, {
      stageIn: join(dirname(this.file), "tmp"),
    });
  }

  async readLog(): Promise<string | undefined> {
    return read(this.log, `the index journal at ${this.log}`);
  }

  /**
   * One record on the end, fsynced before it is called written.
   *
   * `a` rather than a seek, so the kernel places the bytes at the end of the
   * file whatever else has happened to it, and `writeAll` because a short
   * write reports itself and is otherwise ignored (rule 5). What a short write
   * leaves behind is a torn record, which the next load discards along with
   * nothing else; what the caller does about it is check the size afterwards.
   */
  async appendLog(line: string): Promise<void> {
    await mkdir(dirname(this.log), { recursive: true });
    const handle = await open(this.log, "a");
    try {
      await writeAll(handle, new TextEncoder().encode(line));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!this.named) {
      await syncDirectory(dirname(this.log));
      this.named = true;
    }
  }

  /** Empty, and still there. A missing log and an empty one are different states. */
  async truncateLog(): Promise<void> {
    await mkdir(dirname(this.log), { recursive: true });
    await writeDurably(this.log, new Uint8Array(0), true, {
      stageIn: join(dirname(this.log), "tmp"),
    });
    this.named = true;
  }

  async stamps(): Promise<JournalStamps> {
    const [snapshot, log] = await Promise.all([stampOf(this.file), stampOf(this.log)]);
    return { ...(snapshot ? { snapshot } : {}), ...(log ? { log } : {}) };
  }
}

/** A file's size and modification time, or undefined if it is not a file. */
async function stampOf(path: string): Promise<IndexStamp | undefined> {
  try {
    const st = await stat(path);
    return st.isFile() ? { size: st.size, mtime: st.mtimeMs } : undefined;
  } catch {
    // Not there, or not answerable. Either way this session cannot claim the
    // file still holds its own bytes, so the next save writes.
    return undefined;
  }
}

/**
 * A file's text, undefined when it is absent, and an error when it is neither.
 *
 * Rule 2, and this is the incident it came from: code that read a config file,
 * fell back to an empty result on error and wrote that back disabled every
 * plugin on a device. Unreadable must stop.
 */
async function read(path: string, what: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${what}: ${(err as Error).message}`);
  }
}

/**
 * Marks this client's in-progress writes.
 *
 * A vault is somebody's own directory and they can name a file whatever they
 * like, so the suffix alone is not enough: the temp name used to be exactly
 * `<file>.trew-tmp`, and a real attachment sitting at that path would be
 * overwritten by the next write of `<file>` and then renamed away. Unique names
 * make that a coincidence rather than a certainty, and creating them
 * exclusively makes it impossible.
 *
 * Temporaries live under the vault's own state folder, which is never listed,
 * so ordinarily none of this touches the listing at all. The marker still
 * matters for the one case a temporary is made beside its destination, when
 * the destination is on another filesystem and a rename from the staging
 * folder would not work.
 */
export const TEMP_MARK = ".trew-tmp-";

/**
 * The one staged name the reaper may delete (R21, R35).
 *
 * The reaper empties the staging directory, and it decided by age. Age says
 * nothing here: a rename keeps the file's own timestamp, so anything moved in
 * is instantly older than the cutoff, and a version of somebody's note
 * preserved from a losing race was deleted as write debris on the next scan.
 * So it deletes only what it can name.
 *
 * `replace.` is the whole list, because it names the only thing in here that
 * is provably a copy: an incoming version staged on its way to a note, which
 * came from the server, which the server still has, and losing it costs a
 * re-download.
 *
 * `respell.` and `keep.` were on this list and had no business being there.
 * Both name *displaced originals* while this code works out what they are: an
 * older `retireName` renamed a note into `respell.<token>` before it could
 * know whose inode it was, and an older replacement staged unsent edits into
 * `keep.<token>` before comparing them. Either can be the only copy of
 * something somebody typed. They stay off for good, so an upgrade does not
 * sweep what an older client left behind on its first run.
 *
 * What this code parks now goes under `preserved.`, which is deliberately
 * absent and always will be. It is not an oversight that nothing reaps those:
 * a name for the case this file could not resolve is exactly the case a sweep
 * must not touch, and `retireName` names the path in the error it throws.
 */
const DISPOSABLE_PREFIXES = ["replace."];

function disposableTemp(name: string): boolean {
  // `openTemp` builds `<basename><TEMP_MARK><counter>`, so the mark is inside
  // the name rather than at the front of it; the rest are staged under a
  // prefix of their own.
  return name.includes(TEMP_MARK) || DISPOSABLE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * The marker a parked original carries, on top of the temporary one (R46).
 *
 * A displaced version lives under one of these between being taken off its
 * name and being claimed at a preservation path, and a claim that fails leaves
 * it there. It is a temporary by name, so no listing shows it, and it is not in
 * the staging directory, so the reaper never reads it and `stranded` never
 * counted it: the bytes survived on disk and every surface said the vault was
 * settled. The first error names the path, and an error string is not a record
 * of anything -- the next sync succeeds and the message is gone.
 *
 * So the scan looks for these by name wherever it walks, and reports them.
 */
const PARKED_MARK = `${TEMP_MARK}keep`;

/** Whether a name is a displaced version waiting for somewhere to go. */
export function isParkedOriginal(name: string): boolean {
  return name.includes(PARKED_MARK);
}

/** Temporaries open in this process, by full path. Exact, so a note is never mistaken for one. */
const liveTemps = new Set<string>();

/** How old a staged temporary must be before it is taken for a crash's leftover. */
export const STALE_TEMP_MS = 60 * 60 * 1000;

/**
 * Whether a directory entry is one of this client's temporary files.
 *
 * Exactly, not by containing the marker. `notes.trew-tmp-1.md` is a note
 * with an odd name, and it used to vanish from the listing for the life of the
 * vault. A temporary of ours ends with the marker and its counter and nothing
 * after, and while it is being written this process knows its full path.
 */
export function isTemporary(name: string, full?: string): boolean {
  if (full !== undefined && liveTemps.has(full)) return true;
  return /\.trew-tmp-[0-9a-z]+(-\d+)?$/.test(name);
}

let tempCounter = 0;

/**
 * Creates a temporary file, and never opens one that already exists: `wx`
 * fails rather than truncating, so a file somebody else put there is refused
 * instead of destroyed.
 *
 * Under `stageIn` when given, and beside the destination otherwise. The
 * staging folder is the ordinary case; beside is the fallback for a
 * destination on another filesystem, where the rename into place would fail.
 */
async function openTemp(
  full: string,
  mode?: number,
  stageIn?: string,
): Promise<{ tmp: string; handle: Awaited<ReturnType<typeof open>> }> {
  if (stageIn !== undefined) await mkdir(stageIn, { recursive: true });
  const base = stageIn !== undefined ? join(stageIn, basename(full)) : full;
  for (let attempt = 0; attempt < 64; attempt++) {
    const tmp = `${base}${TEMP_MARK}${(tempCounter++).toString(36)}${attempt ? `-${attempt}` : ""}`;
    try {
      const handle = await open(tmp, "wx", mode);
      liveTemps.add(tmp);
      return { tmp, handle };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not find an unused temporary name for ${full}`);
}

/**
 * A temporary name beside a file that nothing is using.
 *
 * Random rather than counted, and checked before it is used, because the
 * caller is about to `rename` onto it and `rename` replaces whatever is there
 * (R36). A fixed name is fine exactly once, and these operations are retried.
 */
async function freeTempName(full: string): Promise<string> {
  for (let n = 0; n < 64; n++) {
    const at = `${full}.${TEMP_MARK}${randomBytes(4).toString("hex")}`;
    if (!(await lstat(at).catch(() => undefined))) return at;
  }
  throw new Error(`no free temporary name beside ${full}`);
}

/**
 * Whether two paths are on one filesystem, which is what `link` requires.
 *
 * Asked rather than discovered: finding out from an `EXDEV` means finding out
 * after the destructive step, with the note's own name already empty (R37).
 * An unanswerable stat reads as "not the same", which costs one extra staging
 * copy and never costs a wrong link.
 */
async function sameFilesystem(a: string, b: string): Promise<boolean> {
  const [one, two] = await Promise.all([
    lstat(a).catch(() => undefined),
    lstat(b).catch(() => undefined),
  ]);
  return one !== undefined && two !== undefined && one.dev === two.dev;
}

/**
 * Writes a file so that a crash leaves either the old contents or the new.
 *
 * The same four steps the server uses for a chunk body, and each earns its
 * keep. Writing in place would let a crash leave a half-written note. Renaming
 * without fsyncing the file means the rename can be durable while the bytes are
 * not. Renaming without fsyncing the *directory* means the bytes can be durable
 * while the name is not.
 *
 * Exported for the tests, which can check the outcome of every step except the
 * flushes themselves: whether an fsync really reached the platter is not
 * something a process can observe, on any operating system.
 */
export async function writeDurably(
  full: string,
  bytes: Uint8Array,
  /**
   * Whether to make the directory entry durable here.
   *
   * Two flushes cost about the same, and files sharing a folder re-flush the
   * same folder. Measured over 600 files across 60 folders: 3230 ms flushing
   * per file against 1685 ms flushing each folder once, so a vault write defers
   * this and `NodeVault.flush` does it a folder at a time, before the index is
   * written.
   *
   * The file's own flush is never deferred, and the ordering that matters is
   * unchanged: the index must not be durable before the notes it names, and it
   * still is not, because the folder flushes land ahead of it. What a deferred
   * folder flush risks is a crash in the window leaving a file whose bytes are
   * on disk and whose name is not, and the index does not name it either, so
   * the next pass fetches it again. Nothing claims to hold what it does not.
   */
  syncDir = true,
  opts: {
    /** Permission bits for the file, set on the temporary before it is renamed into place. */
    mode?: number;
    /** Modification time in milliseconds, set on the handle before it is synced. */
    mtime?: number;
    /** A folder to stage the temporary in, rather than beside the destination. */
    stageIn?: string;
  } = {},
): Promise<void> {
  const staged = await writeTemp(full, bytes, opts, opts.stageIn);
  try {
    await rename(staged, full);
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    liveTemps.delete(staged);
    if ((err as NodeJS.ErrnoException).code !== "EXDEV" || opts.stageIn === undefined) throw err;
    // The destination is on another filesystem than the staging folder,
    // which a vault spanning mounts produces. Beside it, then.
    const beside = await writeTemp(full, bytes, opts, undefined);
    try {
      await rename(beside, full);
    } catch (again) {
      await rm(beside, { force: true }).catch(() => {});
      throw again;
    } finally {
      liveTemps.delete(beside);
    }
  }
  liveTemps.delete(staged);

  if (syncDir) await syncDirectory(dirname(full));
}

/** Writes and syncs a temporary holding `bytes`, cleaning up after itself on failure. */
async function writeTemp(
  full: string,
  bytes: Uint8Array,
  opts: { mode?: number; mtime?: number },
  stageIn: string | undefined,
): Promise<string> {
  const { tmp, handle } = await openTemp(full, opts.mode, stageIn);
  try {
    try {
      await writeAll(handle, bytes);
      if (opts.mode !== undefined) await handle.chmod(opts.mode);
      // Set through the handle, before the sync, so the timestamp is part
      // of what the sync makes durable. Set afterwards on the path, it was
      // metadata changed after the last fsync with none following.
      if (opts.mtime !== undefined && opts.mtime > 0) {
        await handle.utimes(opts.mtime / 1000, opts.mtime / 1000);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return tmp;
  } catch (err) {
    // A failed attempt leaves nothing behind. The temporary is invisible
    // to the listing, so left in place it would sit there for ever.
    await rm(tmp, { force: true }).catch(() => {});
    liveTemps.delete(tmp);
    throw err;
  }
}

/**
 * Moves a file or tree across filesystems the long way: copy, prove the copy,
 * then remove the original.
 *
 * Rule 3, literally. `cp` followed by `rm` trusted the copy, and a short copy,
 * a descendant the copy missed, a source changed while it was being read or a
 * name taken at the destination all ended with the original gone and the
 * "copy" not what it was. Every file is compared by size and digest, every
 * directory by presence, and a copy that does not prove out is removed so it
 * cannot be mistaken for the real thing later.
 *
 * Exported for the tests, which are the only way to reach this on a machine
 * with one filesystem.
 */
export async function copyVerifiedThenRemove(source: string, target: string): Promise<void> {
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  try {
    await sameTree(source, target);
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `refusing to remove ${source}: its copy at ${target} does not match: ${(err as Error).message}`,
    );
  }
  // Durable before the original goes (F13).
  //
  // Reading the copy back proves the bytes reached the page cache and nothing
  // more, so a power cut after the `rm` below could leave the source deleted
  // and the copy short or absent: rule 3 says nothing is destroyed until a
  // verified copy exists elsewhere, and a copy that is only in memory is not
  // elsewhere yet. Every copied file is flushed, and then every directory
  // holding one, because a file whose bytes are durable under a name that is
  // not is the same loss with a different shape.
  //
  // A failure here leaves both copies. That is the safe direction: the worst
  // case is a note in the trash and in the vault, which somebody can see and
  // sort out, rather than neither.
  try {
    await flushTree(target);
  } catch (err) {
    throw new Error(
      `refusing to remove ${source}: its copy at ${target} could not be made durable: ` +
        `${(err as Error).message}`,
    );
  }
  await midTrash.pause(source);
  // Removed file by file, each one checked against its copy first (R08).
  //
  // `rm -r` on the source removed whatever was there, and what was there was
  // last looked at before a flush of the whole copied tree, which for a folder
  // of attachments is not a short operation. An editor saving into that window
  // had its work deleted on the strength of a comparison made about an older
  // version of the file. The review reproduced exactly that: replace the
  // source after the target flush, and the helper deletes it and leaves only
  // the old bytes in the trash.
  //
  // Comparing again immediately before each unlink does not close the window
  // either, because nothing here can. What it does is shrink it from "the
  // length of a tree flush" to "the length of one hash", and anything that
  // does not match is left where it is rather than deleted, so the worst case
  // is a note in the trash and in the vault, which somebody can see.
  const left = await removeMatching(source, target);
  if (left.length > 0) {
    throw new Error(
      `moved ${source} to ${target}, and left ${left.length} ` +
        `${left.length === 1 ? "file" : "files"} in place because ${
          left.length === 1 ? "it changed" : "they changed"
        } while the copy was being made: ${left.slice(0, 3).join(", ")}`,
    );
  }
}

/**
 * Removes every file under `source` whose copy under `target` still matches
 * it, and returns the paths of any that did not (R08).
 *
 * Directories go last and only when they have emptied, so a file left behind
 * keeps its parents. A file that has changed is left with its copy already in
 * the trash, which is two copies rather than none.
 */
async function removeMatching(source: string, target: string): Promise<string[]> {
  const left: string[] = [];
  const walk = async (from: string, to: string): Promise<void> => {
    const info = await stat(from).catch(() => undefined);
    if (info === undefined) return; // already gone
    if (info.isDirectory()) {
      for (const name of await readdir(from)) await walk(join(from, name), join(to, name));
      // Only if nothing under it was kept. `rmdir` refuses a directory that
      // is not empty, which is the check and the removal in one; `rm` will
      // not remove a directory at all without `recursive`, and asking for
      // that would take the children this walk deliberately kept.
      await rmdir(from).catch(() => {
        left.push(from);
      });
      return;
    }
    if (!info.isFile()) return;
    // Moved out of the way, and identified afterwards (R22).
    //
    // Hashing the source and then unlinking its path is a check followed by a
    // destructive act on a name, and a save between the two is deleted: the
    // hash described the old bytes and the unlink took the new ones. Shrinking
    // that window is not closing it, which is what the previous attempt did.
    //
    // A rename takes exactly the bytes that were there, atomically, into a
    // name only this walk knows. Then it can be hashed at leisure: if it
    // matches the copy already in the trash it is a duplicate and goes, and if
    // it does not it is put back where it came from.
    // A name of its own for every attempt (R36).
    //
    // It used to be the one fixed `<source>..trew-tmp-moving`. When the walk
    // cannot put a displaced version back it leaves it at that name and
    // reports the move as incomplete, and the retry a person then runs renamed
    // the next file straight onto it: `rename` replaces, so attempt two
    // destroyed what attempt one had gone to the trouble of keeping, and the
    // cleanup afterwards took what was left.
    const aside = await freeTempName(from);
    try {
      await rename(from, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // already gone
      left.push(from);
      return;
    }
    const [moved, copied] = await Promise.all([
      digestOf(aside).catch(() => undefined),
      digestOf(to).catch(() => undefined),
    ]);
    // *After* the comparison, which is where the old window was and where a
    // hook has to sit to prove it is closed. A test that pauses before the
    // check it is testing misses the race that follows it.
    await midTrash.afterCompare(from);
    if (moved !== undefined && copied !== undefined && moved === copied) {
      await rm(aside, { force: true });
      return;
    }
    // Not the version that was copied. It goes back under its own name, and
    // if something has taken that name in the meantime it stays where it is
    // and is reported rather than deleted.
    try {
      await link(aside, from);
      await rm(aside, { force: true });
      left.push(from);
    } catch {
      left.push(aside);
    }
  };
  await walk(source, target);
  // A directory that is empty only because its own children were removed
  // reports itself as left above; filter those out, because the caller cares
  // about files it could not remove and not about the shape of the tree.
  return left.filter((p) => !left.some((other) => other !== p && other.startsWith(`${p}/`)));
}

/** Flushes every file under a path, then every directory holding one. */
async function flushTree(path: string): Promise<void> {
  const dirs = new Set<string>();
  const walk = async (at: string): Promise<void> => {
    const info = await stat(at);
    if (info.isDirectory()) {
      dirs.add(at);
      for (const name of await readdir(at)) await walk(join(at, name));
      return;
    }
    if (!info.isFile()) return;
    const handle = await open(at, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    dirs.add(dirname(at));
  };
  await walk(path);
  // The parent too: the copy's own name lives in it, and a name that is not
  // durable is a body nothing can find.
  dirs.add(dirname(path));
  // Deepest first, so a directory's entries are durable before the directory
  // that names it is flushed.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await syncDirectory(dir);
  }
}

async function sameTree(source: string, target: string): Promise<void> {
  const s = await stat(source);
  const t = await stat(target).catch(() => undefined);
  if (t === undefined) throw new Error(`${target} is missing`);
  if (s.isDirectory()) {
    if (!t.isDirectory()) throw new Error(`${target} is not a directory`);
    for (const name of await readdir(source))
      await sameTree(join(source, name), join(target, name));
    return;
  }
  if (!s.isFile()) return; // Anything else was not copied and is not a note.
  if (!t.isFile() || t.size !== s.size)
    throw new Error(`${target} is ${t.size} bytes, not ${s.size}`);
  const [a, b] = await Promise.all([digestOf(source), digestOf(target)]);
  if (a !== b) throw new Error(`${target} does not have the same bytes as ${source}`);
}

async function digestOf(path: string): Promise<string> {
  // No close here: createReadStream closes the handle itself.
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Writes every byte, or fails.
 *
 * `FileHandle.write` reports how much it wrote and may report less than it
 * was given. The count was ignored, so a short write was fsynced and renamed
 * into place as a complete note, or a complete index. Rule 5 in its smallest
 * form: a result shorter than its input is a bug until shown otherwise, and
 * here it is shown by writing the rest. Zero progress is refused rather than
 * looped on for ever.
 */
export async function writeAll(
  handle: { write(data: Uint8Array): Promise<{ bytesWritten: number }> },
  bytes: Uint8Array,
): Promise<void> {
  let at = 0;
  while (at < bytes.length) {
    const { bytesWritten } = await handle.write(bytes.subarray(at));
    if (bytesWritten <= 0) {
      throw new Error(
        `wrote 0 of the ${bytes.length - at} bytes remaining, so the write is not progressing`,
      );
    }
    at += bytesWritten;
  }
}

/**
 * How many file stats a scan may have outstanding at once (I06).
 *
 * High enough that an ordinary vault on a local disk sees no difference, since
 * the cost of a scan there is the syscalls rather than the waiting. Low enough
 * that a network filesystem, or a shell with a small descriptor limit, does
 * not meet a wall of concurrent work with no useful error on it. Internal,
 * because a number nobody has needed to change is not a setting.
 */
const SCAN_CONCURRENCY = 64;

/**
 * A counting gate: at most `limit` calls are inside `fn` at once.
 *
 * Waiters are a queue rather than a poll, so nothing spins and the order they
 * were asked in is the order they run in. A rejection releases the slot the
 * same as a return does, which matters because the caller here lets the first
 * failure end the scan and the rest of the workers have to be able to finish.
 */
function limiter(limit: number): <R>(fn: () => Promise<R>) => Promise<R> {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    running--;
    waiting.shift()?.();
  };
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (running >= limit) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** Makes a directory's own entries durable. */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Errors from a directory fsync that mean "not here" or "not on this
 * filesystem", as opposed to "the disk said no" (I18).
 *
 * `ENOENT` is the directory already being gone, which is the ordinary result of
 * removing the last thing in it and is nothing to report. The rest are
 * filesystems that do not implement fsync on a directory handle at all: some
 * network mounts, some FUSE layers, and Windows through a compatibility layer.
 * On those there is nothing to do and nothing to say.
 *
 * Everything else is `EIO`, `ENOSPC`, `ENXIO` and their relatives, which is a
 * disk that has failed at the exact moment something was being made durable.
 */
const FSYNC_NOT_APPLICABLE = new Set(["ENOENT", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "EPERM"]);

/**
 * A directory fsync that tolerates a filesystem which cannot do one, and
 * nothing else (I18).
 *
 * `syncDirectory(...).catch(() => undefined)` was how removals made themselves
 * durable, and it is two different outcomes wearing one face. A filesystem with
 * no directory fsync is fine and there is nothing to be done about it. A disk
 * returning EIO while a pairing is being forgotten is the opposite: the unlink
 * may not survive a power cut, so the config can come back, and with it a vault
 * that reads as paired to a server it was told to forget. Both used to be
 * silence.
 *
 * Returns what happened rather than throwing, because the caller has already
 * unlinked the files by the time this runs: the pairing *is* forgotten, and
 * only its durability is in question. Throwing would report a failure for
 * something that largely worked, and swallowing reports a success that was not
 * one. Rule 7: say which.
 */
export async function syncDirectoryIfSupported(
  dir: string,
): Promise<{ readonly synced: boolean; readonly why?: string }> {
  try {
    await syncDirectory(dir);
    return { synced: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (FSYNC_NOT_APPLICABLE.has(code)) return { synced: true };
    return { synced: false, why: `${code || "the filesystem"}: ${(err as Error).message}` };
  }
}

/**
 * The displaced-version log, on a Node filesystem.
 *
 * Beside the index in `.trew`, under the name both shells use, so that a
 * support answer can say where it is without asking which client wrote it.
 */
class NodeDisplacedFiles implements DisplacedFiles {
  private readonly path: string;

  constructor(private readonly root: string) {
    this.path = join(root, STATE_FOLDER, DISPLACED_LOG);
  }

  async read(): Promise<string | undefined> {
    try {
      return await readFile(this.path, "utf8");
    } catch (err) {
      // Absent is empty; anything else is not, and saying it is would report
      // nothing waiting for the one reason that most deserves saying (rule 2).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async append(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Durable, and this is not the usual caution about a temporary file: the
    // record is written because something has already gone wrong with
    // somebody's note, and the crash that follows is exactly the case it is
    // for. `appendFile` with a flush is the whole of it, because a torn last
    // line is skipped on read and the lines before it are the ones naming
    // notes.
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rewrite(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeDurably(this.path, new TextEncoder().encode(text), true, {
      stageIn: join(this.root, STATE_FOLDER),
    });
  }

  async stillThere(at: string): Promise<boolean> {
    try {
      await lstat(join(this.root, at));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      // An unreadable retained version is not a resolved one. The ledger
      // keeps its record when this throws instead of compacting it away.
      throw err;
    }
  }
}
