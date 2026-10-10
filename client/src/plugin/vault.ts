/**
 * Obsidian's vault, as a vault.
 *
 * Uses `DataAdapter` for staged binary writes and serialized text updates.
 * Writes carry the incoming timestamps so a download does not look like a
 * new local edit on the next scan.
 *
 * ## Verification
 *
 * `fake.ts` models the inspected adapter behavior for unit and server-backed
 * tests. `scripts/open-note-smoke.mjs` also exercises actual Obsidian editors:
 * a correct file on disk is not enough if its tab follows a temporary rename.
 * Native Android filesystem and power-loss behavior still need device testing.
 *
 * ## normalizePath is not a formatting function
 *
 * Read out of the shipped `obsidian.asar`, it does four things, and two of them
 * change what file you are talking about:
 *
 *   - collapses runs of slashes and backslashes, and strips them from the ends
 *   - an empty path becomes "/", the vault root
 *   - a non-breaking space (U+00A0) or narrow no-break space (U+202F) becomes an
 *     ordinary space
 *   - the result is normalized to NFC, and macOS hands out filenames in NFD
 *
 * So `normalizePath(p)` can name a different file than `p`. The first version of
 * this file called it on paths that had just come back from `adapter.list`, then
 * skipped anything whose `stat` came back null, and the result was that a note
 * with a non-breaking space in its name disappeared from the listing entirely.
 * It would never have synced, and nothing would have said so.
 *
 * What is below keeps one keyspace. Everything the engine sees is normalized,
 * and where the adapter's own name for a file differs, that mapping is kept so
 * reads and writes still land on the real file.
 *
 * ## What the adapter's own writes are
 *
 * Also read out of the shipped bundle (`obsidian-1.13.7.asar`), because the
 * declarations do not say. `FileSystemAdapter.write` and `writeBinary` are
 * `fs.promises.writeFile` on the destination itself: the file is opened with
 * truncation and then written, so a full disk or a process killed between the
 * two leaves a note empty or short with no copy of what it held. And
 * `FileSystemAdapter.rename` throws "Destination file already exists!" when the
 * target exists, unless the two names differ only by case on a filesystem that
 * folds it. The Capacitor adapter was read again for 1.13.7 and makes the same
 * check with the same message and the same single exception before it hands
 * anything to the platform plugin, so the refusal is not desktop-only. Both
 * make the check inside the rename's own turn of the adapter's queue (read
 * again in 1.14.4), the queue every adapter call from Obsidian and from
 * plugins waits in. What is still the platform's is a destination another
 * program creates between that check and the rename itself, and a look from
 * here cannot narrow that: it happens before the adapter's own check, not
 * between it and the rename. An earlier version of this comment said `create`
 * looked once more for that reason, which it could not do.
 * So there is no replace-by-rename through this API on either platform, and
 * `replace` below says what is done instead.
 *
 * What reaches Obsidian's index differs too. Every write and removal
 * reconciles its own path before it returns; `rename` only moves a record the
 * adapter already held, and it holds none for a staging copy. A file renamed
 * into place is missing from the index until the filesystem watcher reports
 * it, so `list` asks the adapter about those (`unlisted`).
 */

import {
  normalizePath,
  requireApiVersion,
  type DataAdapter,
  type TAbstractFile,
  type Vault as ObsidianVaultApi,
} from "obsidian";

import { looksLikeText } from "../core/chunk.ts";
import { plainDigest } from "../core/digest.ts";
import {
  DISPLACED_LOG,
  DisplacedLedger,
  type Displaced,
  type DisplacedFiles,
  type Inventory,
} from "../core/displaced.ts";
import {
  configFolderName,
  firstFreeName,
  foldPath,
  foldsTogether,
  ignoredHere,
  ignoredHereError,
  isNeverSynced,
  neverSync,
} from "../core/paths.ts";
import { configPathReason } from "../core/path-policy.ts";
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
 * A file's size and times, or undefined when the thing is a folder.
 *
 * Structural rather than an `instanceof TFile`, because class identity across a
 * plugin boundary works until a build changes and then fails in a way that
 * looks like an empty vault.
 */
function statOf(item: TAbstractFile): { mtime: number; ctime: number; size: number } | undefined {
  const stat = (item as { stat?: { mtime: number; ctime: number; size: number } }).stat;
  return stat && typeof stat.size === "number" ? stat : undefined;
}

/**
 * The name every staging copy carries, so one can be told from a file of the
 * user's. Reserved: nothing else in a vault is expected to start with it.
 */
const STAGING_MARK = ".trew-tmp-";

/**
 * Where a staged copy of `path` goes: beside it, under a name nothing syncs.
 *
 * Dot-prefixed, so `isNeverSynced` keeps it out of every listing and
 * Obsidian's own index never shows it as a note. Beside the destination
 * rather than in one folder, so the rename that lands it never crosses a
 * mount and the copy a failure leaves behind is next to the note it was for.
 *
 * With a random part (see `newStagingPath`). A fixed name was a name a person
 * could have given a real dotfile, which the listing never shows and a sync
 * of the note beside it would have overwritten without a word.
 *
 * Never longer than a disk holds (T63). The mark and the random part go in
 * front of the note's own name, and a note named within that many bytes of
 * the limit, which the server accepts, never landed here: the staging write
 * was refused on every pass, for good. The note's name is cut from the end
 * to fit, between characters; the mark and the random part are what make a
 * staging copy one, and they are kept whole.
 */
function stagingPath(normalized: string, nonce: string): string {
  const cut = normalized.lastIndexOf("/");
  const dir = cut === -1 ? "" : normalized.slice(0, cut + 1);
  const name = cut === -1 ? normalized : normalized.slice(cut + 1);
  const mark = `${STAGING_MARK}${nonce}-`;
  return `${dir}${mark}${cutToBytes(name, NAME_MAX - mark.length)}`;
}

/**
 * The longest name one file can have, in bytes of UTF-8, on the disks a vault
 * lives on: ext4 and f2fs on Android and Linux, and APFS. The server refuses
 * a longer one (`segmenttoolong`), so a note's own name always fits.
 */
const NAME_MAX = 255;

/**
 * `name`, cut from the end to at most `budget` bytes of UTF-8.
 *
 * Between characters, never inside one: `for...of` walks code points, so a
 * surrogate pair is a single step, and each step is counted at the width
 * UTF-8 gives it. A cut inside a character is a name the adapter would encode
 * with U+FFFD in it, which is not a name anybody gave a file.
 */
function cutToBytes(name: string, budget: number): string {
  let used = 0;
  let end = 0;
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + width > budget) break;
    used += width;
    end += ch.length;
  }
  return name.slice(0, end);
}

/**
 * A staging name beside `normalized` that nothing can already be using.
 *
 * Sixteen random bytes from the platform's cryptographic generator, and
 * nothing asked of the disk (P-1e). It used to be four bytes and an `exists`
 * before every staged write, with a fresh guess for each name found taken,
 * and on a phone that look was a turn of the adapter's one queue, about 2 ms
 * of every new file. What the look guarded against is a name somebody else
 * could have used: a fixed one, or four bytes an older build's leftover
 * could repeat. Nobody chooses a 128-bit name in advance, a dot-prefixed
 * name never syncs so no other device can put one here, and a leftover of
 * this plugin's carries a guess of its own: the chance of meeting one is
 * one in 2^128 per write, far below what a disk can be trusted to.
 */
function newStagingPath(normalized: string): string {
  return stagingPath(normalized, nonce(16));
}

/**
 * A folder beside `normalized` to move it into while it is identified (R22).
 *
 * A folder rather than a name, and that is the whole of it. Both trashes keep
 * a file's basename and drop every folder above it, so a note moved aside
 * under a different *name* reaches the trash under that name: delete
 * `doomed.md` and find `.trew-tmp-9f2c-doomed.md` in there, which is not
 * what a person looking for the note they deleted searches for. Moved into a
 * folder, it keeps the only part of the path a trash reads.
 *
 * Dot-prefixed and random for the reasons `stagingPath` is: never synced,
 * never listed, and not a name somebody could already have taken. Emptied and
 * removed on the way out; a crash in the middle leaves a hidden folder with
 * one note in it, which is the same litter a staging copy leaves and is
 * findable by the same search.
 */
function removalFolder(normalized: string, id: string): string {
  const cut = normalized.lastIndexOf("/");
  return `${cut === -1 ? "" : normalized.slice(0, cut + 1)}${STAGING_MARK}${id}`;
}

async function freeRemovalFolder(adapter: Writer, normalized: string): Promise<string> {
  const named = () => removalFolder(normalized, nonce());
  return firstFreeName(named(), (path) => adapter.exists(path), named);
}

/**
 * Whether a folder holds nothing at all, as the adapter lists it: hidden
 * names included, because `list` reads the directory rather than the index.
 */
async function holdsNothing(
  adapter: Pick<DataAdapter, "list">,
  normalized: string,
): Promise<boolean> {
  const listed = await adapter.list(normalized);
  return listed.files.length === 0 && listed.folders.length === 0;
}

/**
 * Files an operating system leaves in a folder it has shown, by lowercased
 * name: Finder's `.DS_Store`, Explorer's `Thumbs.db` and `desktop.ini`.
 *
 * They do not keep a folder another device deleted, where this device does
 * not sync them. Finder writes a `.DS_Store` into every folder it opens, and it
 * used to: a Mac put back every folder deleted elsewhere that it had once
 * shown. One this device syncs (`Thumbs.db` and `desktop.ini` have no dot, so
 * they do unless ignored) is a file like any other: its deletion travels on
 * its own, and one still here is live and keeps the folder.
 */
const OS_METADATA = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function isOsMetadata(normalized: string): boolean {
  return OS_METADATA.has(normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase());
}

/**
 * The metadata a folder holds, when that is all it holds, and undefined when
 * anything else is in it: a note, a subfolder, any other hidden file.
 * `unsynced` says whether a file, by the path it has there, is one this
 * device never syncs.
 */
async function onlyMetadataIn(
  adapter: Pick<DataAdapter, "list">,
  normalized: string,
  unsynced: (file: string) => boolean,
): Promise<string[] | undefined> {
  const listed = await adapter.list(normalized);
  if (listed.folders.length > 0) return undefined;
  return listed.files.every((f) => isOsMetadata(f) && unsynced(f)) ? listed.files : undefined;
}

/**
 * Removes one of this client's own hidden folders, if it is empty.
 *
 * Neither shipped adapter has a call that removes only an empty folder. Read
 * out of 1.13.7: desktop `rmdir` is `fs.rm` with `recursive` as given, which
 * refuses every directory unless told to recurse and then takes everything in
 * it, and mobile `rmdir` recurses whatever it is told. `rmdir(folder, false)`
 * therefore did nothing on desktop, and every deletion that arrived there left
 * its empty removal folder behind. So the emptiness is looked at here, and the
 * removal recurses into what was just seen to be nothing. Only for a name
 * this client made at random and nothing else writes to, where no note can
 * arrive between the look and the removal.
 */
async function removeOwnEmptyFolder(
  adapter: Pick<DataAdapter, "list" | "rmdir">,
  normalized: string,
): Promise<void> {
  try {
    if (await holdsNothing(adapter, normalized)) await adapter.rmdir(normalized, true);
  } catch {
    // Litter at worst: a hidden folder with nothing in it.
  }
}

function nonce(size = 4): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Writes and reads, minus the paths: what staging needs from an adapter. */
type Writer = Pick<
  DataAdapter,
  "writeBinary" | "readBinary" | "stat" | "exists" | "rename" | "remove" | "mkdir" | "rmdir"
>;

/**
 * The bytes as an `ArrayBuffer` that holds exactly them, for `writeBinary`.
 *
 * A view into a larger buffer would hand over its neighbours as well, and
 * chunk reassembly produces exactly such views, so a view is copied. Bytes
 * that already fill their whole buffer are handed over as they are. They
 * used to be copied on the way into `create`, again in `stage`, and again for
 * a write in place: a whole file more in memory each time, so a 64 MiB
 * attachment held about four copies at once on its way to the disk. Neither
 * adapter writes into the buffer it is given (desktop wraps it in a Node
 * `Buffer`, mobile reads it into base64).
 */
function standalone(bytes: Uint8Array): ArrayBuffer {
  const whole =
    bytes.byteOffset === 0 &&
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteLength === bytes.buffer.byteLength;
  return whole ? bytes.buffer : bytes.slice().buffer;
}

/**
 * Puts a staged copy of `bytes` at `temp` and proves it is all there.
 *
 * A failure leaves nothing behind: a short or refused staging copy is removed
 * before the error travels, because a temp that nothing will look at again is
 * clutter and a temp somebody might mistake for the note is worse.
 */
async function stage(
  adapter: Writer,
  temp: string,
  bytes: Uint8Array,
  options: { mtime?: number; ctime?: number },
): Promise<void> {
  try {
    await adapter.writeBinary(temp, standalone(bytes), options);
    await verify(adapter, temp, bytes);
  } catch (err) {
    await adapter.remove(temp).catch(() => undefined);
    throw err;
  }
}

/**
 * The bytes at a normalized path, or undefined when there is nothing to read.
 *
 * Straight at the adapter, because the paths this is used for are the hidden
 * ones: `resolve` refuses a dot-prefixed name, which is exactly what staging
 * and removal folders are.
 */
async function readRaw(adapter: Writer, normalized: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await adapter.readBinary(normalized));
  } catch {
    return undefined;
  }
}

/**
 * Reads back what was written, or says how it differs. Rule 4.
 *
 * Every byte, whatever the size. A first version trusted the length alone
 * above a few megabytes to spare a phone a second copy of a large attachment,
 * and a staged copy of the right length with the wrong bytes would have been
 * renamed into place and become the note. The memory is a moment; the
 * corruption would have been for good.
 *
 * The read is the whole check. A stat used to come first, for a missing
 * file, a folder and a wrong length, and the read answers all three: neither
 * adapter reads anything but a file, and the length is compared before the
 * bytes are. On a phone the stat was one more turn of the adapter's queue,
 * about 2 ms of every file landed, and Capacitor's `readBinary` stats the
 * file itself before reading it (P-1c).
 */
async function verify(adapter: Writer, path: string, bytes: Uint8Array): Promise<void> {
  let back: Uint8Array;
  try {
    back = new Uint8Array(await adapter.readBinary(path));
  } catch (err) {
    throw new Error(`${path} cannot be read back after writing it: ${(err as Error).message}`);
  }
  if (back.length !== bytes.length) {
    throw new Error(`${path} is ${back.length} bytes after writing ${bytes.length}`);
  }
  for (let i = 0; i < bytes.length; i++) {
    if (back[i] !== bytes[i]) {
      throw new Error(`${path} reads back differently from what was written, at byte ${i}`);
    }
  }
}

/**
 * What a desktop fsync needs from Node's `fs`, so a test can hand in a fake.
 *
 * The shape of `fs.promises.open` and the handle it returns, and nothing
 * else. Named rather than imported: the plugin bundle may not reference a
 * `node:` module, because on a phone there is none, and the build test reads
 * the bundle to make sure.
 */
export interface FsyncFs {
  promises: {
    open(path: string, flags: string): Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
  };
}

/**
 * Node's `fs`, where Electron provides it, and nothing anywhere else.
 *
 * Obsidian's desktop renderer runs with Node integration, so `require` is a
 * global there and hands over the real module. On a phone there is no such
 * global, and the answer is undefined. Looked up through `globalThis` rather
 * than written as `require("fs")`, because the bundler would try to resolve
 * that and the build test would rightly refuse a bundle that names a Node
 * module.
 */
function electronFs(): FsyncFs | undefined {
  const req = (globalThis as { require?: (name: string) => unknown }).require;
  if (typeof req !== "function") return undefined;
  try {
    const mod = req("fs") as Partial<FsyncFs> | undefined;
    return mod?.promises && typeof mod.promises.open === "function" ? (mod as FsyncFs) : undefined;
  } catch {
    return undefined;
  }
}

/** The one method a `FileSystemAdapter` has that the Capacitor adapter does not. */
type DesktopAdapter = DataAdapter & { getFullPath(normalizedPath: string): string };

function isDesktopAdapter(adapter: DataAdapter): adapter is DesktopAdapter {
  return typeof (adapter as Partial<DesktopAdapter>).getFullPath === "function";
}

/** Opens one path for reading and fsyncs it, leaving no handle behind. */
async function fsyncPath(fs: FsyncFs, adapter: DesktopAdapter, path: string): Promise<void> {
  const handle = await fs.promises.open(adapter.getFullPath(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ObsidianVault implements Vault {
  /**
   * Normalized path to the adapter's own name for it, where they differ.
   *
   * Filled in by `list`, and empty in the ordinary case, because Obsidian
   * normalizes paths as it indexes a vault and so hands back names that
   * already survive `normalizePath`. It exists for the names that do not: a
   * non-breaking space, or a filesystem handing out NFD. Without it, the
   * engine would be given a path that nothing could then read.
   */
  private readonly actualName = new Map<string, string>();
  /**
   * Names this client renamed something onto, or the engine found on the disk
   * and missing from a listing, which Obsidian's index may not show yet.
   *
   * Read out of 1.13.7, both adapters: `rename` moves the adapter's record of
   * the source to the destination and reports that, and a source it never
   * held has no record to move. A write never gives it a record of a
   * dot-prefixed name, so a file landed by renaming its staged copy into place
   * is on the disk and missing from `getAllLoadedFiles` until the filesystem
   * watcher reports it, however long the platform takes. A pass that listed
   * inside that window read the file it had just downloaded as deleted here:
   * it sent the deletion to every device, then uploaded the same bytes as new
   * once the watcher caught up (M3 acceptance, 2026-09-23). The window is
   * reached because the plugin's own events during a pass ask the engine for
   * another round at once. Writes and removals put their own path into the
   * index before they return, so of this client's own changes renames are
   * all that is recorded.
   *
   * Another program's write is in the index only once the watcher reports
   * it, too, and one that deletes a synced file and writes it again leaves
   * the name out in between. The engine asks `exists` about each synced name
   * a listing leaves out and names the ones it finds (`list`'s `present`),
   * and those are recorded here as well.
   */
  private readonly unlisted = new Set<string>();
  private readonly ignore: Set<string>;
  private readonly adapter: DataAdapter;
  private readonly log: (message: string, ...rest: unknown[]) => void;

  /**
   * What this pass has written and not yet made durable: files, and the
   * directories whose entries changed under them. Cleared by `flush`.
   *
   * Each name carries the number of the write that owed it, counted from
   * `owed` below, so a flush can tell the write it is syncing from a later
   * one for the same name. Crossing a name off without that check crossed off
   * a write it had never seen: see `forget`.
   */
  private readonly unsynced = { files: new Map<string, number>(), dirs: new Map<string, number>() };
  /** Counts writes, so two of one file are two things owed and not one. */
  private owed = 0;
  /** Node's fs where there is one; resolved once, on the first flush. */
  private fsync: FsyncFs | undefined | null = null;
  private readonly fsOverride: FsyncFs | undefined;
  private saidNoDirSync = false;
  /**
   * What this client has taken off a name and could not put back.
   *
   * The plugin could strand a version and reported nothing: `removeExpecting`
   * leaves one in a hidden folder when the bytes cannot be identified, and
   * `stranded` was never implemented here at all. The headless client answered
   * the question by walking the vault for parked names, which the hidden
   * folder is not, so the Obsidian client -- which is the product -- had no
   * answer.
   */
  private readonly ledger: DisplacedLedger;
  /** Refreshed by every scan, for anything that reports. */
  displaced: readonly Displaced[] = [];
  /**
   * And whether that is the whole of it (RR2).
   *
   * It matters more here than in the headless client, because here the record
   * is the *only* source: Obsidian's index does not list the hidden folder a
   * displaced note goes into, so there is no walk to fall back on. A log this
   * cannot read is a vault this cannot describe.
   */
  recovery: Inventory = { waiting: [], complete: false, why: "nothing has scanned this vault yet" };
  /**
   * The same, as bare paths, which is what the engine and both shells read.
   *
   * Filled from the ledger by `list`, like the headless client's, so that
   * "what is waiting" has one answer whichever client is asked.
   */
  readonly stranded: string[] = [];

  /**
   * @param vault Obsidian's own vault, read for its index of what exists.
   * @param configDir Obsidian's own config folder, from `Vault.configDir`.
   *   Required rather than defaulted, because the default would be right
   *   almost always and catastrophic the rest of the time.
   * @param log Where a non-fatal oddity is reported, such as a staging copy
   *   that could not be removed after the note it staged was verified.
   * @param opts.displacedLog Where the record of versions this client took off
   *   a name and could not put back is kept. Inside the plugin's own folder,
   *   because it is this device's bookkeeping and must not sync.
   * @param opts.settings Whether this device syncs its settings: the config
   *   folder's settings are then listed and written like notes, and nothing
   *   else in it is (plan/settings-sync.md).
   */
  constructor(
    private readonly vault: ObsidianVaultApi,
    configDir: string,
    log: (message: string, ...rest: unknown[]) => void = () => undefined,
    /** A stand-in for Node's fs, for tests. Never set in the plugin. */
    opts: {
      fs?: FsyncFs;
      displacedLog?: string;
      ignore?: readonly string[];
      settings?: boolean;
    } = {},
  ) {
    this.adapter = vault.adapter;
    this.log = log;
    this.fsOverride = opts.fs;
    this.ledger = new DisplacedLedger(
      new ObsidianDisplacedFiles(
        vault.adapter,
        normalizePath(opts.displacedLog ?? `${configFolderName(configDir)}/${DISPLACED_LOG}`),
      ),
      (message) => log(message),
    );
    // Obsidian's config folder is *not* assumed to be `.obsidian`: the API
    // says plainly that it could be something else, and that folder holds
    // this plugin's `data.json`, which holds this device's credential. So the
    // real name is passed in, and it is the one thing added to the rule in
    // core/paths.ts, which already covers every dot-prefixed name.
    // Plus whatever this device has been told to leave alone, which is
    // per-device configuration and goes nowhere near the server (R083-13).
    // The same shape the CLI's `--ignore` has: one name, matched against every
    // segment, so `Attachments` skips it wherever it is.
    this.ignore = new Set([configFolderName(configDir), ...(opts.ignore ?? [])]);
    this.skipHere = new Set(opts.ignore ?? []);
    this.settingsRoot = opts.settings === true ? configFolderName(configDir) : undefined;
  }

  /** The names this device was told to leave alone, without the config folder's. */
  private readonly skipHere: ReadonlySet<string>;

  /**
   * A setting this device would sync but for a name it was told to skip:
   * refused as configuration, not as a failure, as a skipped folder of notes
   * is (R2).
   */
  private skippedSetting(path: string): boolean {
    const root = this.settingsRoot;
    return (
      root !== undefined &&
      path.startsWith(root + "/") &&
      configPathReason(path) === undefined &&
      isNeverSynced(path.slice(root.length + 1), this.skipHere)
    );
  }

  /**
   * The config folder, when this device syncs its settings; undefined when
   * it does not. Only the folder Obsidian runs from here: another device's
   * profile is not this device's to write (plan/settings-sync.md, section 2).
   */
  private readonly settingsRoot: string | undefined;

  /**
   * Whether a path is a setting this device syncs. The names this device was
   * told to skip apply inside the settings folder as everywhere else, so a
   * snippet can be kept to one device the way a folder of notes can.
   */
  private inSettings(path: string): boolean {
    const root = this.settingsRoot;
    return (
      root !== undefined &&
      path.startsWith(root + "/") &&
      configPathReason(path) === undefined &&
      !isNeverSynced(path.slice(root.length + 1), this.skipHere)
    );
  }

  /**
   * The settings this device syncs, from the disk. Obsidian's index never
   * lists a dot folder, so the config folder is walked with the adapter: into
   * `themes` and `snippets` only, because nothing else under it is a setting
   * settings sync carries, and `plugins` is most of the folder. A few dozen
   * stats, about 120 ms for the whole of a phone's folder on a Pixel 9a
   * (plan/settings-sync.md, spike results).
   *
   * A walk that fails part way keeps what it found and says so in the log,
   * and the notes' listing goes on: a theme uninstalled mid-walk must not
   * stop notes syncing (plan/settings-sync.md, section 7). A setting it did
   * not reach is not read as deleted, because the engine asks the vault about
   * every synced path the listing leaves out before it decides anything.
   */
  private async listSettings(out: FileStat[]): Promise<Set<string>> {
    const listed = new Set<string>();
    const root = this.settingsRoot;
    if (root === undefined) return listed;
    const found = new Map<string, { raw: string; stat: FileStat }[]>();
    try {
      await this.walkSettings(root, found);
    } catch (err) {
      this.log(`the settings folder could not be listed in full: ${(err as Error).message}`);
    }
    for (const [path, group] of found) {
      listed.add(path);
      if (group.length > 1) {
        // Two names on this disk for one setting, as `list` treats two for
        // one note: left out and named, never one of them picked.
        this.ambiguousPaths.push({ path, spellings: group.map((g) => g.raw).sort() });
        this.actualName.delete(path);
        continue;
      }
      const { raw, stat } = group[0]!;
      if (path !== raw) this.actualName.set(path, raw);
      out.push(stat);
    }
    return listed;
  }

  private async walkSettings(
    root: string,
    found: Map<string, { raw: string; stat: FileStat }[]>,
  ): Promise<void> {
    if (!(await this.adapter.exists(root))) return;
    const folders = [root];
    while (folders.length > 0) {
      const here = await this.adapter.list(folders.pop()!);
      for (const raw of here.folders) {
        const rel = trimLeadingSlash(raw).slice(root.length + 1);
        const theme = rel.startsWith("themes/") && !rel.slice("themes/".length).includes("/");
        if (rel === "themes" || rel === "snippets" || theme) folders.push(trimLeadingSlash(raw));
      }
      for (const file of here.files) {
        const raw = trimLeadingSlash(file);
        const path = this.normalOf(raw);
        if (!this.inSettings(path)) continue;
        const stat = await this.adapter.stat(raw);
        if (stat?.type !== "file") continue;
        const one = {
          raw,
          stat: { path, folder: false, mtime: stat.mtime, ctime: stat.ctime, size: stat.size },
        };
        const group = found.get(path);
        if (group) group.push(one);
        else found.set(path, [one]);
      }
    }
  }

  /**
   * The file in blocks, without `DataAdapter` having a streaming read.
   *
   * `getResourcePath` returns the URL the webview already uses to show an
   * image or play an audio note, and that URL can be fetched. The response
   * carries a body stream, so a large attachment can be cut and named a chunk
   * at a time instead of being handed over whole.
   *
   * Verified in a running Obsidian on desktop: fetch succeeds, `res.body` is
   * a stream, and a ranged request returns the right bytes from the middle of
   * a file rather than the first N. Mobile is Capacitor and its resource URLs
   * are a different scheme, which nothing here has tested, so the engine
   * treats a failure as "this platform cannot" and falls back to reading the
   * file whole.
   */
  async *readBlocks(path: string, blockSize = 1024 * 1024): AsyncGenerator<Uint8Array> {
    this.refuseCutShort(this.resolve(path));
    const res = await fetch(this.resourceUrl(path));
    if (!res.ok || !res.body) {
      throw new Error(`cannot stream ${path}: the vault answered ${res.status}`);
    }
    const reader = res.body.getReader();
    // Re-blocked rather than passed through, because what a fetch hands back
    // is whatever the transport felt like and the chunker should not have
    // its memory decided by that.
    //
    // Filled into one buffer rather than grown by concatenation. Growing it
    // reallocated and copied everything held on every arriving piece, so moving
    // 64 MiB copied 2144 MiB and allocated 4160 buffers when the pieces came
    // 16 KiB at a time: 33x the file, to move the file. This is 128 MiB and 65
    // buffers. Wall clock barely notices on a laptop; allocation churn is the
    // axis that matters on a phone, which is where this path runs.
    //
    // `subarray` was the other half of it: the remainder kept the whole block
    // alive to hold a few spare kilobytes.
    const block = new Uint8Array(blockSize);
    let filled = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (value && value.length > 0) {
        let at = 0;
        while (at < value.length) {
          const take = Math.min(blockSize - filled, value.length - at);
          block.set(value.subarray(at, at + take), filled);
          filled += take;
          at += take;
          if (filled === blockSize) {
            yield block.slice(0, blockSize);
            filled = 0;
          }
        }
      }
      if (done) break;
    }
    if (filled > 0) yield block.slice(0, filled);
  }

  async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    this.refuseCutShort(this.resolve(path));
    const res = await fetch(this.resourceUrl(path), {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (!res.ok)
      throw new Error(`cannot read ${path} at ${start}: the vault answered ${res.status}`);
    const got = new Uint8Array(await res.arrayBuffer());
    // A handler that ignored the Range would answer with the whole file,
    // which would then be sent and refused for not matching its name. Said
    // here instead, where the reason is knowable.
    if (got.length > end - start) {
      throw new Error(`this vault does not honour ranged reads, so ${path} cannot be streamed`);
    }
    // And a short answer is not the range either. A file cut down between
    // being scanned and being fetched used to hand back what was left, which
    // was sent as the chunk it no longer was and refused much later, by
    // name, with nothing pointing back here. Rule 4.
    if (got.length < end - start) {
      throw new Error(
        `${path} answered ${got.length} bytes for a read of ${end - start} at ${start}; it has changed since it was scanned`,
      );
    }
    return got;
  }

  /** Where the webview can fetch a file from. */
  private resourceUrl(path: string): string {
    return this.vault.adapter.getResourcePath(this.resolve(path));
  }

  /**
   * Everything in the vault, from Obsidian's own index.
   *
   * `getAllLoadedFiles` returns what the application already has in memory,
   * with each file's size and times attached. The alternative, and what this
   * did first, was to walk `adapter.list` and `stat` every file. That is one
   * call per file per pass through the adapter, which on a desktop is merely
   * wasteful and on a phone is the difference between a scan you do not
   * notice and one you do. The walk is gone; nothing is read that Obsidian
   * has not already read.
   *
   * A folder is told from a file structurally, by whether it carries a
   * `stat`, rather than by `instanceof`. Class identity across a plugin
   * boundary is a thing that works until a build changes.
   *
   * Two raw names that normalize to one path are left out of the listing and
   * reported through `ambiguous`, which blocks that one name and lets the rest
   * of the vault sync.
   *
   * The map used to let the second one win, so one of two real files was read
   * and written under the other's name and recorded as synced, and the next
   * scan called the loser deleted. That was fixed by throwing, and throwing was
   * the wrong half of the answer: it stopped the whole pass, so one ambiguous
   * pair took every other note in the vault with it, including the one being
   * written that minute. Fail loudly is rule 2 and naming the pair satisfies
   * it; a vault that syncs nothing is the larger risk to the first rule.
   *
   * This is `NodeVault.list`'s behaviour, word for word, and that is the point:
   * two adapters to one engine cannot disagree about what a vault contains.
   * The divergence was unreachable, because Obsidian normalizes as it indexes,
   * and it was still two shells answering one question two ways
   * (plugin/vault.test.ts, "two names the plugin cannot hold apart ").
   *
   * Grouped before anything is decided, because a clash cannot be seen one
   * entry at a time and what is done about it applies to the whole group. The
   * ignore filter runs first, as it does in the CLI: a name this device is not
   * looking at is not a name it has an opinion about.
   *
   * `forceFull` is not a walk here, because the plugin is asked for one on
   * every thirty-second pass and a walk is the per-file cost described above.
   * What it exists to prevent is a stale index becoming a deletion, and the
   * engine names each synced path it would treat as deleted that `exists`
   * finds (`present`). Those are read from the disk, as the names this client
   * renamed into place are (`unlisted`), and nothing else in a listing can
   * become a deletion.
   */
  async list(
    options: { forceFull?: boolean; present?: readonly string[] } = {},
  ): Promise<FileStat[]> {
    // Resolved before the spellings are forgotten below, so a name the disk
    // spells differently is read under its own spelling.
    for (const path of options.present ?? []) this.unlisted.add(this.resolve(path));
    // A note an update was cut short in is put back before it is listed, so
    // the listing describes it whole and the pass fetches the update again
    // rather than reading the cut text as an edit (T09).
    for (const [normalized, held] of [...this.cutShort]) await this.putBack(normalized, held);
    this.actualName.clear();
    this.ambiguousPaths = [];
    const items = this.vault.getAllLoadedFiles();
    await this.probeCase(items);

    const byPath = new Map<string, { raw: string; item: TAbstractFile }[]>();
    for (const item of items) {
      const raw = trimLeadingSlash(item.path);
      if (raw === "" || raw === "/") continue; // the vault root itself
      const path = this.normalOf(raw);
      if (this.ignored(path)) continue;
      const group = byPath.get(path);
      if (group) group.push({ raw, item });
      else byPath.set(path, [{ raw, item }]);
    }

    const out: FileStat[] = [];
    for (const [path, group] of byPath) {
      // The single-spelling case does not build anything.
      //
      // Every path used to get a Set, a mapped array and a sort to find out
      // whether two names in the index claim it. Two do for approximately no
      // paths in any real vault, and this runs for all of them on every pass:
      // listing is about half of a quiet pass on both a laptop and a phone,
      // and this was a measurable part of it.
      if (group.length === 1) {
        const { raw, item } = group[0]!;
        if (path !== raw) this.actualName.set(path, raw);
        const only = statOf(item);
        out.push(
          only === undefined
            ? { path, folder: true, mtime: 0, ctime: 0, size: 0 }
            : { path, folder: false, mtime: only.mtime, ctime: only.ctime, size: only.size },
        );
        continue;
      }
      const spellings = [...new Set(group.map((g) => g.raw))].sort();
      if (spellings.length > 1) {
        // Left out of the listing and reported separately, never silently
        // dropped: a path that vanishes from a listing is a path the engine
        // reports deleted. No `actualName` mapping either, or a write would
        // pick one of the two and land on the note nobody meant.
        this.ambiguousPaths.push({ path, spellings });
        this.actualName.delete(path);
        continue;
      }
      const { raw, item } = group[0]!;
      if (path !== raw) this.actualName.set(path, raw);

      const stat = statOf(item);
      if (stat === undefined) {
        out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
        continue;
      }
      out.push({
        path,
        folder: false,
        mtime: stat.mtime,
        // Carried because the protocol carries it, and read by nothing
        // that decides. Obsidian ships native addons for five platforms
        // to get this value in its headless client, which is a fair
        // measure of how much it is worth.
        ctime: stat.ctime,
        size: stat.size,
      });
    }

    // A setting this client wrote into place is in `unlisted` too, and the
    // walk has listed it: Obsidian's index never will, so without this it
    // would be listed twice and kept in `unlisted` for good.
    const settings = await this.listSettings(out);
    if (this.unlisted.size > 0) await this.addUnlisted(byPath, out, settings);
    // A landing the index now has has been reported, and one with nothing on
    // the disk never will be: neither is waited for any longer (P-3).
    for (const path of this.landing.keys()) {
      if (!this.unlisted.has(path)) this.landing.delete(path);
    }

    // What this client has taken off a name and could not put back. From the
    // ledger only, unlike the headless client: Obsidian's index does not list
    // a hidden folder, so there is nothing here to walk for and the record is
    // the whole answer.
    // Kept to roughly what the vault holds. See `normalOf`.
    if (this.normalised.size > items.length * 2) this.normalised.clear();

    let inventory = await this.ledger.inventory();
    // A folder removal that did not finish, put right before it is reported.
    // What goes back is listed by the next scan, as a note renamed into place
    // is; it was never synced, so its absence from this one deletes nothing.
    const looked = await this.putBackRemovals(inventory.waiting);
    if (looked.size > 0) {
      inventory = await this.ledger.inventory();
      // A removal folder still there is reported by the file records written
      // for what could not go back, not as a folder nobody can open.
      inventory = { ...inventory, waiting: inventory.waiting.filter((d) => !looked.has(d.at)) };
    }
    this.displaced = inventory.waiting;
    this.recovery = inventory;
    this.stranded.length = 0;
    for (const d of this.displaced) this.stranded.push(d.at);
    return out;
  }

  /**
   * Adds to a listing what the disk holds and the index does not show yet,
   * asked of the adapter (see `unlisted`).
   *
   * A name is dropped once the index has it, under any spelling this disk
   * treats as the same one, or once the adapter finds nothing there. The
   * respelling is the listing's to decide: on a folding disk `exists` answers
   * for a note renamed only in case, and the engine pairs the two names as a
   * rename from what the index says. A stat that fails fails the listing
   * (rule 2): leaving the name out instead is the deletion this exists to
   * prevent.
   */
  private async addUnlisted(
    indexed: ReadonlyMap<string, unknown>,
    out: FileStat[],
    settings: ReadonlySet<string>,
  ): Promise<void> {
    let folded: Set<string> | undefined;
    for (const raw of [...this.unlisted]) {
      const path = this.normalOf(raw);
      if (indexed.has(path) || settings.has(path)) {
        this.unlisted.delete(raw);
        continue;
      }
      if (this.foldsCase) {
        folded ??= new Set([...indexed.keys()].map(foldPath));
        if (folded.has(foldPath(path))) {
          this.unlisted.delete(raw);
          continue;
        }
      }
      const stat = await this.adapter.stat(raw);
      if (stat === null || (stat.type !== "file" && stat.type !== "folder")) {
        this.unlisted.delete(raw);
        continue;
      }
      if (path !== raw) this.actualName.set(path, raw);
      out.push(
        stat.type === "folder"
          ? { path, folder: true, mtime: 0, ctime: 0, size: 0 }
          : { path, folder: false, mtime: stat.mtime, ctime: stat.ctime, size: stat.size },
      );
    }
  }

  /**
   * `adapter.rename`, for every rename this client makes.
   *
   * It remembers a destination the index may not show (see `unlisted`), and
   * it holds the pair while the adapter has it, which is when Obsidian reports
   * the rename to plugins (see `ownRename`).
   */
  private async move(from: string, to: string): Promise<void> {
    this.renaming.set(from, to);
    try {
      await this.adapter.rename(from, to);
    } finally {
      this.renaming.delete(from);
    }
    if (!this.ignored(to)) this.unlisted.add(to);
  }

  /** Each rename in hand, from its source to its destination. */
  private readonly renaming = new Map<string, string>();

  /**
   * Whether a rename Obsidian reports is one this client is making.
   *
   * None of them is a person's. Moving the old bytes aside before a binary
   * replacement, putting back a version it could not identify, respelling a
   * name to match the server: the engine decided each one and accounts for it
   * itself. Told of one as a rename, it moved the entry of the note it had
   * just written onto the name of the copy it had moved aside. The shipped
   * adapter reports a rename from inside the call (read out of 1.13.7), so
   * the pair is held for exactly as long as it can be reported.
   */
  ownRename(from: string, to: string): boolean {
    return this.renaming.get(from) === to;
  }

  /**
   * Files this client renamed into place, with the size and the time it gave
   * them, until Obsidian reports them (P-3).
   *
   * A file renamed into place from a staging copy is reported by Obsidian's
   * watcher some time later, as `create`, and the plugin used to take that
   * for news: it marked the file changed and asked for another round, and the
   * round read and hashed again every file the pass had just written and read
   * back. On a first sync that was 12 to 14 ms more for every file on a phone.
   * Kept until the report comes, or until a listing finds the index has the
   * name or the disk has nothing there.
   */
  private readonly landing = new Map<string, { size: number; mtime: number }>();

  /**
   * Paths this client is writing in place, removing or making right now,
   * with how many such calls are in hand for each (P-3). Obsidian reports a
   * `modify`, `delete` or folder `create` from inside the call that caused
   * it (read out of 1.13.7), so a report while one is held is this client's.
   */
  private readonly touching = new Map<string, number>();

  /** Runs one adapter call on `normalized` as this client's own (see `touching`). */
  private async touch<T>(normalized: string, work: () => Promise<T>): Promise<T> {
    this.touching.set(normalized, (this.touching.get(normalized) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.touching.get(normalized) ?? 1) - 1;
      if (left > 0) this.touching.set(normalized, left);
      else this.touching.delete(normalized);
    }
  }

  /**
   * Whether a `create` Obsidian reports is a file this client has just
   * landed, as it landed it, or a folder it is making (P-3).
   *
   * A file's report is matched against the size and time this client gave it,
   * once: a write by anything else in between carries a time of its own and
   * is reported as news, as before. The engine has already recorded what it
   * landed, so nothing from the report is needed, and no byte is trusted from
   * it.
   */
  ownCreate(path: string, stat: { size: number; mtime: number } | undefined): boolean {
    if (stat === undefined) return this.touching.has(path);
    const landed = this.landing.get(path);
    if (landed === undefined) return false;
    this.landing.delete(path);
    return stat.size === landed.size && Math.round(stat.mtime) === Math.round(landed.mtime);
  }

  /** Whether a `modify` or `delete` Obsidian reports is this client's own (P-3). */
  ownChange(path: string): boolean {
    return this.touching.has(path);
  }

  /** Paths the last `list` left out because two names in the index claim them. */
  private ambiguousPaths: Ambiguous[] = [];

  /**
   * Which paths two names in Obsidian's index both claim, from the last `list`.
   *
   * The engine blocks these and everything under them rather than syncing
   * either spelling, and names them so a person can rename one. Same contract
   * as `NodeVault.ambiguous`, because it is the same engine reading it.
   */
  ambiguous(): readonly Ambiguous[] {
    return this.ambiguousPaths;
  }

  /**
   * What the disk files a path under, so two paths that are one file here can
   * be told from two files.
   *
   * `normalizePath` first, because that is the keyspace everything else here
   * uses and it already folds NFC and Obsidian's no-break spaces. Case is
   * folded only where the adapter has been seen to fold it, and until it has
   * been asked the answer is that it does, which refuses two files where one
   * would have done rather than the reverse.
   */
  canonical(path: string): string {
    const normalized = normalizePath(path);
    return this.foldsCase ? normalized.toLowerCase() : normalized;
  }

  private foldsCase = true;
  private probed = false;

  /**
   * Asks the adapter whether it folds case, once, without writing anything.
   *
   * `exists` on a folding filesystem answers yes for a spelling that differs
   * from the real one only by case, and no on one that does not. So the
   * first file in the index with a letter in it is asked about under a
   * flipped spelling, provided nothing is really spelled that way. Obsidian
   * itself knows the answer but does not expose it.
   */
  private async probeCase(items: TAbstractFile[]): Promise<void> {
    if (this.probed) return;
    const paths = new Set(items.map((i) => trimLeadingSlash(i.path)));
    let looked = false;
    for (const item of items) {
      if (statOf(item) === undefined) continue;
      looked = true;
      const raw = trimLeadingSlash(item.path);
      const flipped = flipCase(raw);
      if (flipped === raw) continue;
      // Both spellings in the index is the answer already: a filesystem that
      // folded case could not hold them both.
      this.foldsCase = paths.has(flipped) ? false : await this.adapter.exists(flipped);
      this.probed = true;
      return;
    }
    // Files were looked at and none of them has a letter in it. A vault of
    // numeric names would otherwise be walked in full on every `list()`, for
    // ever, to reach the same answer (B12). Settling for the default is
    // settling on the safe side: folding refuses two paths a case-sensitive
    // disk could have held apart, rather than overwriting one with the other.
    // An empty listing is not an answer and does not settle anything.
    if (looked) this.probed = true;
  }

  /**
   * Turns a path from anywhere into the name the adapter knows.
   *
   * Paths reach this from two directions: out of `list`, already normalized,
   * and off the wire, written by another device in whatever form that
   * device's filesystem uses. Both end up normalized, and then mapped back to
   * the adapter's own name if it has a different one.
   *
   * The refusals are for the second direction. The server checks every path
   * it stores, and it is trusted with that; it is also the last thing between
   * this vault and another device's bug, or a compromised server, handing it
   * `../../.ssh/authorized_keys` or a plugin's `main.js` (PLAN.md section 3.6),
   * so the check is made here as well.
   */
  private resolve(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") {
      // What normalizePath returns for "", "/" and "///". It is the vault
      // root, which is not a file, and quietly doing something with it is
      // worse than refusing.
      throw new Error(`refusing an empty path: ${JSON.stringify(path)}`);
    }
    // normalizePath does not resolve "..", so this has to.
    if (normalized.split("/").some((part) => part === "..")) {
      throw new Error(`refusing a path outside the vault: ${path}`);
    }
    // The same rule as the headless client, and for the same reason: this
    // set was consulted on the way out and not on the way in, so a path the
    // plugin would never upload was one it would write. Under the config
    // folder that means `main.js` of an installed plugin, which Obsidian
    // executes on the next reload, and this plugin's own `data.json`.
    if (this.ignored(normalized)) {
      // Two refusals, because they mean different things to the engine (R2).
      // A dot-prefixed name cannot work here and never will. The config
      // folder is this device's configuration: a peer whose config folder is
      // named something else uploads paths under it, and this device saying
      // no to those is the arrangement working, not a fault.
      throw ignoredHere(normalized, this.ignore) || this.skippedSetting(normalized)
        ? ignoredHereError(`not writing under a name this device does not sync: ${path}`)
        : neverSync(`refusing to write inside a folder that is never synced: ${path}`);
    }
    return this.actualName.get(normalized) ?? normalized;
  }

  /**
   * Whether any part of a path is a name that never syncs.
   *
   * The shared rule, so both shells and both directions agree. Obsidian's
   * index omits every dot-prefixed path, so the listing here could never
   * name one; a filter on the way in that refused only five names accepted
   * the rest, and a file written and never listed is reported deleted.
   */
  private ignored(path: string): boolean {
    return !this.inSettings(path) && isNeverSynced(path, this.ignore);
  }

  /**
   * `normalizePath`, remembered.
   *
   * It is a pure function of the string and it is asked about every file in
   * the vault on every pass, and it normalises to NFC, which is not cheap.
   * The same few thousand names are asked about over and over, so the answer
   * is kept.
   *
   * Bounded against the listing that is being built: a vault that churns
   * through names would otherwise keep an answer for each of them for the
   * life of the process. Nothing here can go stale, because nothing about a
   * string changes.
   */
  private normalOf(raw: string): string {
    const known = this.normalised.get(raw);
    if (known !== undefined) return known;
    const path = normalizePath(raw);
    this.normalised.set(raw, path);
    return path;
  }

  private readonly normalised = new Map<string, string>();

  async read(path: string): Promise<Uint8Array> {
    const normalized = this.resolve(path);
    this.refuseCutShort(normalized);
    return new Uint8Array(await this.adapter.readBinary(normalized));
  }

  /**
   * Reads a version this vault parked out of sight, past the filter that put
   * it there (Codex-08).
   *
   * `resolve` refuses a dot-prefixed name because nothing under one may be
   * *synced*: Obsidian does not list it, so a file written there and never
   * listed is reported deleted. Reading one back is the opposite operation.
   * The whole reason those bytes are under a hidden name is that this device
   * could not leave them anywhere Obsidian would show, and a recovery that
   * cannot read them is the safety net with a hole in it.
   *
   * Only for a path the displaced ledger names. Nothing else calls this, and
   * nothing it reads is written back under the name it came from: the caller
   * places a visible copy beside the note instead.
   */
  async readDisplaced(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(normalizePath(path)));
  }

  /**
   * One path's stat, for the check the engine makes before destroying bytes.
   *
   * Obsidian's adapter answers `null` for a path it has nothing at, and this
   * turns anything it cannot describe as a file or a folder into the same
   * `undefined`. That reads as "not the file the pass decided about", which
   * makes the engine keep both copies: the safe direction for a question
   * whose wrong answer is somebody's unsaved paragraph.
   */
  async stat(path: string): Promise<FileStat | undefined> {
    const st = await this.adapter.stat(this.resolve(path));
    if (st === null) return undefined;
    if (st.type === "folder") return { path, folder: true, mtime: 0, ctime: 0, size: 0 };
    if (st.type !== "file") return undefined;
    return { path, folder: false, mtime: st.mtime, ctime: st.ctime, size: st.size };
  }

  async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    const normalized = this.resolve(path);
    await this.ensureParents(normalized);
    await this.matchCase(normalized);
    // Not copied here: a view into a larger buffer would hand over its
    // neighbouring bytes, and chunk reassembly produces exactly that kind of
    // view, but `standalone` copies one where the bytes meet the adapter.
    await this.writeThroughStaging(normalized, bytes, writeOptions(times));
    this.wrote(normalized);
  }

  /**
   * Writes over a file, keeping what was there when it is not what the caller
   * expected (R01, R19).
   *
   * Text updates use `process` with a verified backup and a comparison inside
   * the adapter's save queue. Renaming a live note, even temporarily, redirects
   * its open editors and emits a user-visible rename to every plugin.
   *
   * Binary updates use the move-aside path below. Obsidian's adapter has no
   * binary equivalent of `process` and no hard link, so the headless client's trick of
   * staging the new bytes and linking them into a name that has just been
   * vacated is not available. What it does have is `rename`, and that is
   * enough for the half that matters: the old bytes are moved to a path of
   * their own *before* anything is written over them, so at no moment are
   * bytes about to be destroyed.
   *
   * It used to read the old bytes, write, and compare afterwards. That saw an
   * edit the previous check could not, because it compared content rather than
   * a length and a timestamp, and it still overwrote one that landed between
   * the read and the write (R19). Moving first removes that: whatever is at
   * the path when the rename happens is what comes out, whenever it was
   * written.
   *
   * The new bytes are then published with `create` and not with `write`, and
   * that is not a detail (R32). After the move the name is free, so anything
   * at it is somebody else's save, and `write` would have truncated it:
   * `writeThroughStaging` asks whether the destination exists and takes a
   * `writeBinary` when it does, which is right for replacing a note in place
   * and wrong here. A save landing between the move and that question was
   * destroyed, and the version this displaced was removed as a duplicate in
   * the same call, so the only copy of what somebody had just typed went. What
   * `create` does instead is rename the staged copy into place, and rename
   * refuses an occupied destination in both of Obsidian's adapters, so the
   * competitor keeps the name and the caller is told the incoming version has
   * nowhere to go.
   */
  async replace(
    path: string,
    expect: ExpectedContent | undefined,
    bytes: Uint8Array,
    times: Times,
    keepAt: string,
  ): Promise<Replaced> {
    const from = this.resolve(path);
    const kept = this.resolve(keepAt);
    await this.wholeBeforeTouching(from);

    // Whether this is a text update is decided from the name and from the
    // bytes that have already been fetched, before anything on disk is read
    // (R083-18). It used to read the existing file first and ask whether it
    // decoded, which meant replacing a 50 MiB attachment read it in full to
    // discover it was not text, on top of the park, the stage, the verify and
    // the digest. `looksLikeText` is the engine's own list, so the files that
    // take the in-place path here are the files it treats as text everywhere
    // else, and that path is the one that keeps an open editor pointed at the
    // same TFile.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let next: string | undefined;
    if (looksLikeText(path)) {
      try {
        next = decoder.decode(bytes);
      } catch {
        // Invalid UTF-8 must stay bytes; decoding it leniently corrupts it.
      }
    }
    if (next !== undefined) {
      const before = await this.readIfThere(path);
      if (before !== undefined) {
        let previous: string | undefined;
        try {
          previous = decoder.decode(before);
        } catch {
          // A text name whose current content is not text. Kept as bytes.
        }
        if (previous !== undefined) {
          return this.replaceText(path, from, keepAt, before, previous, next, expect, times);
        }
      }
    }

    // No baseline is not permission to overwrite (R33).
    //
    // It used to be: a path the pass had not seen holds nothing worth keeping.
    // The pass looked at the start and writes at the end, and a note created
    // in between is what that reasoning destroys. Undefined means the caller
    // cannot say what it decided about, so anything found here is kept.
    //
    // A first download therefore costs a failed rename and one `exists` on top
    // of the write, which over an initial sync of a few thousand notes is two
    // cheap calls each against a whole file being written. Reinstating the
    // early write to save them is reinstating the defect.
    let moved = true;
    try {
      await this.move(from, kept);
    } catch (err) {
      // Absent, or refused, and the two are not the same answer (R32).
      //
      // Both used to fall through to the write. A rename refused for
      // permissions or I/O left the original exactly where it was and then
      // wrote over it, reporting `landed: true` and no preserved version: the
      // failure of the step that exists to protect the note became the reason
      // it was destroyed.
      if (await this.stillThere(from)) {
        // Nothing was moved and nothing may be written. The caller is told the
        // incoming version has nowhere to go, and places it beside.
        this.log(
          `could not move ${path} aside before writing over it, so it was left alone: ` +
            `${(err as Error).message}`,
        );
        return { landed: false };
      }
      moved = false;
    }

    // Exclusively, because the name is supposed to be free by now and anything
    // at it is a save this must not take (R32).
    if (!(await this.create(path, bytes, times))) {
      // Somebody got there first. Theirs is the newest thing anybody wrote and
      // it stays; the displaced version, if there was one, is already at its
      // own name and is reported.
      if (!moved) return { landed: false };
      this.entryChanged(kept);
      this.wrote(kept);
      return { keptAt: keepAt, landed: false };
    }
    if (!moved) return { landed: true };

    this.entryChanged(kept);
    const was = await this.readIfThere(keepAt);
    // With no baseline there is nothing it can match, so it is kept (R33).
    if (
      expect !== undefined &&
      was !== undefined &&
      (await expect.idOf(was)) === expect.contentId
    ) {
      // The version this write was decided about: the copy is a duplicate of
      // something the server already holds.
      await this.dropDuplicate(kept);
      return { landed: true };
    }
    this.wrote(kept);
    return { keptAt: keepAt, landed: true };
  }

  /**
   * Keep the TFile at its original path so Obsidian updates its open editors.
   * `process` serializes the comparison and write with Obsidian's other saves
   * on desktop and mobile. It still writes in place: the backup must exist
   * before it starts and survive until the destination is verified and flushed.
   * The backup is visible, so a crash needs no in-memory recovery record.
   */
  private async replaceText(
    path: string,
    normalized: string,
    keepAt: string,
    before: Uint8Array,
    previous: string,
    next: string,
    expect: ExpectedContent | undefined,
    times: Times,
  ): Promise<Replaced> {
    let was: Times;
    try {
      const stat = await this.adapter.stat(normalized);
      if (stat?.type !== "file") return { landed: false };
      was = { mtime: stat.mtime, ctime: stat.ctime };
      if (!(await this.create(keepAt, before, was))) {
        return { landed: false };
      }
    } catch (error) {
      this.log(`could not back up ${path}, so it was left alone`, String(error));
      return { landed: false };
    }

    const changed = new Error("the note changed before its update could be applied");
    try {
      await this.flush();
      // A peer may intentionally change only the filename's case. Updating
      // bytes in place must still apply that rename; ordinary edits use the
      // loaded index and need no directory listing or rename.
      if (this.vault.getAbstractFileByPath(normalized)?.path !== normalized) {
        await this.matchCase(normalized);
      }
      await this.touch(normalized, () =>
        this.adapter.process(
          normalized,
          (current) => {
            // No awaits between this comparison and the queued write. An editor
            // save made while the backup was being written keeps the original.
            if (current !== previous) throw changed;
            return next;
          },
          writeOptions(times),
        ),
      );
      this.wrote(normalized);
      await verify(this.adapter, normalized, new TextEncoder().encode(next));
      await this.flush();
    } catch (error) {
      if (error === changed) {
        // The save that changed the note is kept and the update goes beside
        // it. The backup is checked as it is after a write that lands: when
        // it holds the version this was decided about, the server has it,
        // and keeping it left a copy of what both devices already had, named
        // as if it held this device's words (T13).
        if (expect !== undefined && (await expect.idOf(before)) === expect.contentId) {
          await this.dropDuplicate(this.resolve(keepAt));
          return { landed: false };
        }
        return { keptAt: keepAt, landed: false };
      }
      // `process` truncates the note and then writes it, so a write that
      // stopped part way (a full disk, an I/O error) left the start of the
      // incoming version at the note's name, and nothing said it was this
      // device's own failed write. The next pass read it as an edit, kept it
      // at the name and sent it to every device as the newest version: a
      // 410-byte note was fifteen bytes everywhere (T09). So what it held is
      // put back, here and now, unless something else has been saved there.
      const whole = await this.putBack(normalized, { previous, next, before, was });
      const why = `writing ${path} failed: ${String(error)}`;
      if (!whole) {
        throw new Error(
          this.cutShort.has(normalized)
            ? `${why}. It was cut short and could not be put back yet, so it will not sync ` +
                `until it is; what it held is at ${keepAt}`
            : `${why}. The previous content is at ${keepAt}`,
        );
      }
      if (expect !== undefined && (await expect.idOf(before)) === expect.contentId) {
        // The note holds the version this was decided about, which the server
        // has, so the backup is a duplicate, as it is after a write that lands.
        await this.dropDuplicate(this.resolve(keepAt));
        throw new Error(`${why}. What the note held was put back`);
      }
      throw new Error(`${why}. What the note held was put back, and is also at ${keepAt}`);
    }

    if (expect !== undefined && (await expect.idOf(before)) === expect.contentId) {
      await this.dropDuplicate(this.resolve(keepAt));
      return { landed: true };
    }
    return { keptAt: keepAt, landed: true };
  }

  /**
   * Removes a copy that duplicates a version the server holds, as this
   * client's own removal (see `touching`). A failure leaves a duplicate,
   * which costs a conflict copy and loses nothing.
   */
  private async dropDuplicate(normalized: string): Promise<void> {
    await this.touch(normalized, () => this.adapter.remove(normalized)).catch(() => undefined);
    this.entryChanged(normalized);
  }

  /**
   * Notes whose in-place update was cut short and could not be put back whole
   * yet, with what puts them back (T09).
   *
   * While one is here it is not read for the engine (`refuseCutShort`), so
   * its start-of-another-version is never taken for an edit and sent, and
   * every listing tries to put it back before anything reads it. Kept in
   * memory: the backup beside the note is what survives a restart, and a
   * note still cut short after one is read as it stands.
   */
  private readonly cutShort = new Map<string, CutShort>();

  /**
   * Puts back what a note held before its in-place update was cut short, and
   * says whether the note now holds it, verified.
   *
   * Inside `process`, so it is decided in the same turn of the adapter's
   * queue as the write: a note is put back only while it holds a strict
   * prefix of the incoming text or of what it held, which is all a write cut
   * short can leave, and anything else at the name (somebody's save in
   * between) is left alone and the record dropped. Overwriting such a prefix
   * loses no text: every byte of it is in the incoming version, which the
   * server has, or in what is being put back. The note's own times go back
   * with it, so the next pass sees it unchanged and fetches the incoming
   * version again.
   *
   * A put-back that is cut short too, or cannot be verified, keeps the note
   * on record and is tried again by the next listing; a note that has gone
   * is not on record any more.
   */
  private async putBack(normalized: string, held: CutShort): Promise<boolean> {
    let restoring = false;
    try {
      await this.touch(normalized, () =>
        this.adapter.process(
          normalized,
          (current) => {
            restoring = cutShortOf(current, held.next) || cutShortOf(current, held.previous);
            return restoring ? held.previous : current;
          },
          writeOptions(held.was),
        ),
      );
      if (restoring) {
        this.wrote(normalized);
        await verify(this.adapter, normalized, held.before);
      }
      this.cutShort.delete(normalized);
      return restoring;
    } catch (err) {
      if (!(await this.stillThere(normalized))) {
        this.cutShort.delete(normalized);
        return false;
      }
      this.cutShort.set(normalized, held);
      this.log(
        `${normalized} was cut short while it was being updated and could not be put back yet`,
        (err as Error).message,
      );
      return false;
    }
  }

  /**
   * Refuses to read a note whose update was cut short and is not whole yet
   * (see `cutShort`), on every path the engine reads by.
   */
  private refuseCutShort(normalized: string): void {
    if (!this.cutShort.has(normalized)) return;
    throw new Error(
      `${normalized} was cut short while an update was being written into it, and is not ` +
        `read until what it held has been put back`,
    );
  }

  /**
   * Puts a note on record as cut short back before a write or a removal
   * touches it, and refuses to touch it while it cannot be (T09): a backup or
   * a kept copy of it would carry the cut text to every device instead.
   */
  private async wholeBeforeTouching(normalized: string): Promise<void> {
    const held = this.cutShort.get(normalized);
    if (held === undefined) return;
    await this.putBack(normalized, held);
    this.refuseCutShort(normalized);
  }

  /**
   * Whether a path is still occupied, when a rename off it has just failed.
   *
   * The conservative direction is "yes". An adapter that cannot answer cannot
   * establish absence either, and absence is the only answer that permits
   * writing over the name (R32).
   */
  private async stillThere(normalized: string): Promise<boolean> {
    try {
      return await this.adapter.exists(normalized);
    } catch {
      return true;
    }
  }

  /**
   * Removes a file, keeping it when it is not the version the caller meant to
   * remove (R01, R22).
   *
   * Moved first and identified afterwards, for the reason `replace` is: a
   * removal that hashes the path and then deletes it deletes whatever is
   * there at the second step.
   */
  async removeExpecting(
    path: string,
    expect: ExpectedContent | undefined,
    keepAt: string,
  ): Promise<Replaced> {
    const from = this.resolve(path);
    const kept = this.resolve(keepAt);
    await this.wholeBeforeTouching(from);
    if (!(await this.adapter.exists(from))) {
      await this.remove(path);
      return { landed: true };
    }

    // Aside first, into a folder that keeps the note's own name, because what
    // happens to it next depends on bytes nobody has read yet and reading
    // them where it lies would identify one file and dispose of another.
    const folder = await freeRemovalFolder(this.adapter, from);
    const aside = `${folder}/${from.slice(from.lastIndexOf("/") + 1)}`;

    // Written down *before* the note is hidden, and the note is not hidden if
    // it cannot be (RR2).
    //
    // It used to be recorded afterwards, and only on the path where something
    // threw. Two ways that lost a note: a crash between the rename below and
    // the catch left no record at all, and an append that failed left none
    // either, and in both cases Obsidian does not list the folder the note is
    // now in, so nothing anywhere knew where it had gone. Recording an intent
    // first is the same rule as the rest of this file -- establish the
    // recovery before the destructive act, not after it -- and it makes the
    // failure "the note was not moved" rather than "the note cannot be found".
    //
    // The record goes stale on every successful path, because the file it
    // names stops existing, and `inventory` drops a record whose file is gone.
    // Nothing has to remember to clear it.
    if (
      !(await this.ledger.record({
        at: aside,
        from: path,
        why: `${path} is being moved aside to be identified before a deletion`,
        when: Date.now(),
      }))
    ) {
      this.log(
        `not moving ${path} aside to identify it, because that could not be written down ` +
          `first and nothing would know where it had gone`,
      );
      return { keptAt: path, landed: true };
    }

    try {
      await this.adapter.mkdir(folder);
      await this.move(from, aside);
    } catch {
      // Could not be moved, so it cannot be identified either. Left where it
      // is rather than deleted on an unproven decision. The folder goes only
      // if the move really left nothing in it: mobile `rmdir` recurses.
      await removeOwnEmptyFolder(this.adapter, folder);
      return { keptAt: path, landed: true };
    }
    this.entryChanged(from);

    let emptied = false;
    try {
      // With no baseline there is nothing it can match, so it is kept (R33).
      const was = expect === undefined ? undefined : await readRaw(this.adapter, aside);
      if (
        was !== undefined &&
        expect !== undefined &&
        (await expect.idOf(was)) === expect.contentId
      ) {
        // The version the pass decided to delete. It goes where a deletion
        // goes, under the name it had: both trashes read the basename, which
        // is why the move above was into a folder.
        await this.intoTrash(aside);
        emptied = true;
        this.wentAway(from);
        return { landed: true };
      }
      // Somebody else's version, so it is not deleted at all. It comes back
      // out under a name a person will find, and the engine says so.
      await this.move(aside, kept);
      emptied = true;
      this.wrote(kept);
      return { keptAt: keepAt, landed: true };
    } catch (err) {
      // The note is still in the hidden folder, so the folder stays and the
      // path is reported. Mislaid is recoverable; unmentioned is not.
      //
      // The intent recorded above already names this file, so the note is
      // findable whether or not this second record lands. This one only
      // improves the reason, from "is being moved aside" to what actually
      // went wrong, and supersedes the first because they share a path.
      await this.ledger.record({
        at: aside,
        from: path,
        why:
          `${path} was moved aside to be identified and could not be dealt with ` +
          `(${(err as Error).message})`,
        when: Date.now(),
      });
      return { keptAt: aside, landed: true };
    } finally {
      // Only once it is known to be empty, and looked at again before it
      // goes: Obsidian's `rmdir` is `rm -rf` on mobile whatever it is told,
      // and the note is what would be under there.
      if (emptied) await removeOwnEmptyFolder(this.adapter, folder);
    }
  }

  /**
   * The digest of one path's contents (R31).
   *
   * Obsidian's adapter reads whole files and offers no stream, so this holds
   * one copy and no more. The headless vault hashes as it reads.
   */
  contentDigest = async (path: string): Promise<string | undefined> => {
    this.refuseCutShort(this.resolve(path));
    const bytes = await this.readIfThere(path);
    return bytes === undefined ? undefined : plainDigest(bytes);
  };

  /** The bytes at a path, or undefined when there is nothing there to read. */
  private async readIfThere(path: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await this.adapter.readBinary(this.resolve(path)));
    } catch {
      // Absent, a folder, or unreadable. All three mean this cannot promise
      // anything about what is being replaced, and every caller treats an
      // absent baseline as a reason to keep what it finds rather than to
      // overwrite it.
      return undefined;
    }
  }

  /** Remembers a file whose bytes or name changed, for `flush`. */
  private wrote(normalized: string): void {
    this.unsynced.files.set(normalized, ++this.owed);
    this.entryChanged(normalized);
  }

  /** Remembers the directory a path lives in, whose entries have changed. */
  private entryChanged(normalized: string): void {
    const cut = normalized.lastIndexOf("/");
    this.unsynced.dirs.set(cut === -1 ? "" : normalized.slice(0, cut), ++this.owed);
  }

  /**
   * Crosses a name off, unless something owed it again while it was in hand.
   *
   * The flush syncs a name and then forgets it, and between those two it has
   * awaited. A write that landed in that gap put the same name back, and the
   * forget used to take it away again: the bytes it wrote were never fsynced
   * and the index that followed named them as durable, which is the one
   * ordering rule 3 forbids here. A different file was already safe, because
   * the flush had never held its name; the same file was not, and neither was
   * the directory a new file had just appeared in.
   *
   * Nothing in the engine writes during a flush today, because a pass is
   * awaited end to end and passes are queued one at a time. This is what the
   * file said it did, made true, so that the ordering does not rest on a
   * property of a caller in another module.
   */
  private forget(owed: Map<string, number>, path: string, stamp: number): void {
    if (owed.get(path) === stamp) owed.delete(path);
  }

  /**
   * Makes this pass's writes durable, on desktop.
   *
   * The engine calls this before it saves the index, so the index is never
   * durable ahead of the notes it names (rule 3, in the form the header of
   * core/vault.ts gives it). `DataAdapter` has no way to ask for this, so
   * for a long time the plugin's answer was nothing at all and the ordering
   * the engine relies on held only by luck.
   *
   * On desktop the adapter is Electron's `FileSystemAdapter`, the vault is
   * a real directory, and Node's fs is a `require` away: every file written
   * this pass is opened and fsynced, and so is every directory whose
   * entries changed, because a rename or a create is durable only once its
   * directory is. On a phone the adapter is Capacitor's, there is no fs to
   * reach, and this does nothing: durability there is whatever the platform
   * gives the adapter's own writes, which docs/plugin.md calls best effort.
   *
   * A directory that cannot be opened for syncing is logged once and not
   * raised. Windows refuses it, and a note that is itself synced with its
   * directory entry pending is a far better state than a pass that cannot
   * finish.
   *
   * A file is forgotten when it has been synced and not before. This used to
   * empty both sets first and stop at the first file that would not open, so
   * one transient failure skipped every later file in the pass and then lost
   * the record of all of them: the retry found nothing to flush, and the
   * index could be saved over notes that had never been made durable. Now
   * every file is attempted, the ones that failed stay for the next pass, and
   * the first failure is what the pass fails with.
   *
   * Keeping failures is only safe while a path that has gone is not one of
   * them. A file written and then deleted, here or by anybody else, cannot be
   * opened to be synced and has nothing left to make durable; counted as a
   * failure it would stay in the set, fail again on every later flush, and
   * block index saves for the rest of the session (R6).
   */
  async flush(): Promise<void> {
    const files = [...this.unsynced.files];
    const dirs = [...this.unsynced.dirs];
    if (this.fsync === null) {
      this.fsync = this.fsOverride ?? (isDesktopAdapter(this.adapter) ? electronFs() : undefined);
    }
    const fs = this.fsync;
    if (fs === undefined || !isDesktopAdapter(this.adapter)) {
      // Nothing here can ever sync them, so holding on to the names is a set
      // that grows for the life of the session and syncs nothing.
      this.unsynced.files.clear();
      this.unsynced.dirs.clear();
      return;
    }
    const adapter = this.adapter;
    // An Error, so what is thrown below is one: the same object a platform's
    // fsync threw, or one naming what it threw when that was not an Error.
    let failure: Error | undefined;
    for (const [path, stamp] of files) {
      try {
        await fsyncPath(fs, adapter, path);
        // Dropped one at a time rather than cleared, and only the write this
        // one synced, so a write that landed while it was running is still
        // waiting for the next flush.
        this.forget(this.unsynced.files, path, stamp);
      } catch (err) {
        // Gone rather than unopenable: there is nothing to make durable, so
        // the name is dropped and the pass carries on. Asked of the adapter
        // rather than read off the error, because a platform is free to
        // report a missing file however it likes.
        if (!(await this.adapter.exists(path))) {
          this.forget(this.unsynced.files, path, stamp);
          continue;
        }
        failure ??= err instanceof Error ? err : new Error(String(err));
      }
    }
    for (const [dir, stamp] of dirs) {
      try {
        await fsyncPath(fs, adapter, dir);
      } catch (err) {
        if (!this.saidNoDirSync) {
          this.saidNoDirSync = true;
          this.log(
            "this platform will not sync a directory, so a new file's name is durable when the disk says",
            (err as Error).message,
          );
        }
      }
      // Dropped either way: this failure is tolerated rather than retried,
      // and a platform that refuses would refuse for ever. Still only the
      // change this one synced, for the reason `forget` gives.
      this.forget(this.unsynced.dirs, dir, stamp);
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * Lands bytes at a path without a moment in which the note is half written
   * and nowhere complete.
   *
   * The adapter's own write truncates the destination and then fills it (see
   * the header), so a failure in between used to leave the note empty with
   * no copy of what it held or of what was arriving. Now the bytes go to a
   * staged copy beside the destination first and are read back from it.
   *
   * Onto a path with nothing at it, the staged copy is renamed into place,
   * which the desktop adapter does atomically. Onto an occupied path it
   * cannot be: `rename` refuses an existing destination, verified in the
   * shipped bundle, so the fallback is the adapter's own write in place,
   * taken only once the staged copy has been proven complete and kept until
   * the destination has been read back too. The window in which the
   * destination is short still exists on that path, but for the whole of it
   * a verified copy of the new bytes sits beside it and the old bytes are the
   * server's newest version; a failure names the copy so a person can find
   * it.
   */
  private async writeThroughStaging(
    normalized: string,
    bytes: Uint8Array,
    options: { mtime?: number; ctime?: number },
  ): Promise<void> {
    const temp = newStagingPath(normalized);
    await stage(this.adapter, temp, bytes, options);

    if (!(await this.adapter.exists(normalized))) {
      this.expectLanding(normalized, bytes.length, options.mtime);
      try {
        await this.move(temp, normalized);
        await verify(this.adapter, normalized, bytes);
      } catch (err) {
        this.landing.delete(normalized);
        await this.adapter.remove(temp).catch(() => undefined);
        throw err;
      }
      return;
    }

    try {
      await this.touch(normalized, () =>
        this.adapter.writeBinary(normalized, standalone(bytes), options),
      );
      await verify(this.adapter, normalized, bytes);
    } catch (err) {
      // The staged copy stays. It is the only complete copy of the new
      // version on this device, and the destination may now be short.
      throw new Error(
        `writing ${normalized} failed: ${(err as Error).message}. ` +
          `The complete new content is beside it at ${temp}`,
      );
    }
    await this.discardStaging(temp);
  }

  /**
   * Removes a staging copy the destination no longer needs.
   *
   * A failure here is logged and not raised. The note is complete and
   * verified; raising would have the engine write it again next pass, fail
   * the same cleanup, and go round for ever with a correct file on disk.
   */
  private async discardStaging(temp: string): Promise<void> {
    try {
      await this.adapter.remove(temp);
    } catch (err) {
      this.log(
        "could not remove a staging copy after the note it staged was verified; it is safe to delete",
        temp,
        (err as Error).message,
      );
    }
  }

  /**
   * Writes a file only if nothing is at the path, and says whether it did.
   *
   * The staged copy is renamed into place, and `rename` refusing an occupied
   * destination is what makes the claim exclusive: both adapters look for
   * the destination inside the rename's own turn of their queue (read out of
   * 1.13.7 and 1.14.4, see the header), and a refusal is read as "taken"
   * whenever something is there afterwards.
   *
   * It used to look twice more, before staging and again just before the
   * rename, and said the second look narrowed the gap on mobile. It could
   * not: the adapter's own check comes later than any look from here, and
   * what is left of the race, another program taking the name between that
   * check and the rename, is invisible to both. On a phone each look is a
   * turn of the adapter's one queue, about 2 ms of every new file apiece
   * (P-1b). They stay for an Obsidian older than 1.13.7, whose rename
   * nothing here has read.
   */
  async create(path: string, bytes: Uint8Array, times: Times): Promise<boolean> {
    const normalized = this.resolve(path);
    const looks = !requireApiVersion("1.13.7");
    if (looks && (await this.adapter.exists(normalized))) return false;
    await this.ensureParents(normalized);
    const temp = newStagingPath(normalized);
    await stage(this.adapter, temp, bytes, writeOptions(times));

    if (looks && (await this.adapter.exists(normalized))) {
      await this.discardStaging(temp);
      return false;
    }
    this.expectLanding(normalized, bytes.length, writeOptions(times).mtime);
    try {
      await this.move(temp, normalized);
    } catch (err) {
      this.landing.delete(normalized);
      await this.adapter.remove(temp).catch(() => undefined);
      if (await this.adapter.exists(normalized)) return false;
      throw err;
    }
    try {
      await verify(this.adapter, normalized, bytes);
    } catch (err) {
      this.landing.delete(normalized);
      throw err;
    }
    this.wrote(normalized);
    return true;
  }

  /**
   * Remembers a landing about to happen, for the report Obsidian makes of it
   * later (see `landing`). Only with a time to match the report by: a file
   * stamped with the moment it landed is not told apart from a write that
   * came after, so its report is taken as news, as it always was.
   */
  private expectLanding(normalized: string, size: number, mtime: number | undefined): void {
    if (mtime !== undefined) this.landing.set(normalized, { size, mtime });
  }

  /**
   * Renames an existing file to the spelling being written, where they differ.
   *
   * macOS and Windows fold case, so writing `NOTE.md` over an existing
   * `Note.md` writes the same file and leaves the name spelled the old way.
   * The bytes are then right and the name is not, the next scan calls the new
   * name missing, and the deletion that follows travels to every device. A
   * rename that changed only case lost the note, one pass after it looked
   * fine. Obsidian's own index is asked rather than the platform guessed at.
   *
   * A listing that fails fails the write. It used to be skipped, and the
   * write went ahead under a spelling nothing had checked: the old spelling
   * stayed on disk, the engine recorded the new one as synced, and the next
   * scan reported it deleted.
   */
  private async matchCase(normalized: string): Promise<void> {
    if (!(await this.adapter.exists(normalized))) return;

    const cut = normalized.lastIndexOf("/");
    const dir = cut === -1 ? "/" : normalized.slice(0, cut);
    let listed;
    try {
      listed = await this.adapter.list(dir);
    } catch (err) {
      throw new Error(
        `cannot check how ${normalized} is spelled on disk, so it was not written: ${(err as Error).message}`,
      );
    }
    if (listed.files.includes(normalized)) return; // Already spelled this way.

    const folded = foldPath(normalized);
    const actual = listed.files.find((f) => foldPath(f) === folded);
    if (actual === undefined || actual === normalized) return;
    await this.move(actual, normalized);
    this.actualName.delete(actual);
    // A rename is a changed entry in the directory holding it, and durable
    // only when that directory is. The write that follows records the file.
    this.entryChanged(normalized);
  }

  /**
   * Whether two paths are one file, according to Obsidian's own listing.
   *
   * Two spellings that fold together and appear once between them are one
   * file. The engine asks before applying a deletion, because deleting the old
   * name of a case-only rename would delete the note it just wrote.
   */
  async sameFile(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const left = this.resolve(a);
    const right = this.resolve(b);
    if (left === right) return true;
    if (!foldsTogether(left, right)) return false;

    const cut = left.lastIndexOf("/");
    const dir = cut === -1 ? "/" : left.slice(0, cut);
    try {
      const listed = await this.adapter.list(dir);
      // Both spellings present means two files, and both deserve their fate.
      return !(listed.files.includes(left) && listed.files.includes(right));
    } catch {
      return true;
    }
  }

  /**
   * Removes a path by moving it to the vault's trash.
   *
   * Not `remove`. A deletion arriving over the wire was somebody's decision on
   * another device, possibly a mistaken one, and the first rule is not to lose
   * a note. The trash makes it recoverable by hand for as long as Obsidian
   * keeps it, and `.trash` is in the never-sync list so it does not travel back
   * out and undo the deletion everywhere else.
   *
   * The system trash is tried first, because that is recoverable for longer and
   * from outside Obsidian. It returns false where the platform has none, and
   * the vault-local trash is the fallback.
   */
  async remove(path: string): Promise<void> {
    const normalized = this.resolve(path);
    if (!(await this.adapter.exists(normalized))) {
      // Already gone, by hand or by another pass. It still owes nothing: a
      // write earlier in this pass may have left the name owed, and there is
      // no file left to open and fsync for it. The next flush's own check
      // would drop it a cycle later; dropping it here is where the fact is
      // known (N7, R6).
      this.wentAway(normalized);
      return;
    }
    // Either way it left its directory, and a pass that only deleted used to
    // save the index without ever fsyncing the directory it changed.
    await this.intoTrash(normalized);
    this.wentAway(normalized);
  }

  /**
   * Into whichever trash this platform has, by normalized path.
   *
   * Separate from `remove` because `removeExpecting` disposes of a note that
   * is sitting in a hidden folder at the time, and `resolve` refuses those.
   */
  private async intoTrash(normalized: string): Promise<void> {
    await this.touch(normalized, () => this.trash(normalized));
  }

  private async trash(normalized: string): Promise<void> {
    if (this.systemTrash) {
      try {
        if (await this.adapter.trashSystem(normalized)) return;
        // Refused, which is the platform's answer and not this file's: the
        // Capacitor adapter catches whatever its trash throws and answers
        // false, every time, on a phone that has none. Asked again, it was
        // one more turn of the adapter's queue on every deletion (P-9). Both
        // trashes keep the note recoverable, so this decides only which one
        // the rest of this session's deletions go to.
        this.systemTrash = false;
      } catch {
        // This file could not go to the recycle bin, which says nothing
        // about the next one. The local trash is next, and a failure to reach
        // the recycle bin is not a reason to give up on the deletion.
      }
    }
    await this.adapter.trashLocal(normalized);
  }

  /** Whether to offer a deletion to the system trash first (see `intoTrash`). */
  private systemTrash = true;

  /**
   * Records a path that has left the vault.
   *
   * Its directory has a changed entry, as any deletion does. The file itself
   * is dropped from what the flush owes: there is nothing at that name to open
   * and sync, and a write earlier in the same pass may well have left one
   * owed. Kept, it would fail every flush from here on and block the index
   * saves that follow them (R6). Only after the deletion has actually
   * happened, so a trash that refused still leaves the file owed.
   */
  private wentAway(normalized: string): void {
    this.unsynced.files.delete(normalized);
    this.entryChanged(normalized);
  }

  /**
   * Removes an empty folder, and only an empty one (docs/design.md, "Folders").
   *
   * Neither shipped adapter can be asked for that (see `removeOwnEmptyFolder`),
   * so the emptiness is established here, and a look followed by a recursive
   * removal would take a note saved into the folder between the two with it,
   * past the trash. So the folder is moved aside first, onto a hidden name
   * nothing writes to, and looked at again there. Whatever was saved before
   * the move is in the hidden folder, which then goes back; nothing can be
   * saved into it after, because the name a save would land under has gone.
   *
   * The move is written down first, in the ledger, as `removeExpecting`'s is
   * (RR2). A note saved in the window and a kill before the second look left
   * the folder under its hidden name with nothing anywhere knowing it was
   * there, and Obsidian lists no hidden folder: a note no device had, gone
   * from view. The next scan now looks inside any recorded removal folder
   * still on the disk and puts back what it finds (`putBackRemovals`).
   *
   * Operating system metadata (`OS_METADATA`) does not keep the folder, and
   * goes with it only when nothing else is inside.
   */
  async removeFolder(path: string): Promise<boolean> {
    const normalized = this.resolve(path);
    const stat = await this.adapter.stat(normalized);
    if (stat === null) {
      this.wentAway(normalized);
      return true;
    }
    if (stat.type !== "folder") return false;
    const unsynced = this.unsyncedIn(normalized, normalized);
    if ((await onlyMetadataIn(this.adapter, normalized, unsynced)) === undefined) return false;
    const aside = await freeRemovalFolder(this.adapter, normalized);
    if (
      !(await this.ledger.record({
        at: aside,
        from: path,
        why: `${path} is being moved aside to be removed, as a folder deleted on another device`,
        when: Date.now(),
      }))
    ) {
      this.log(
        `not removing the folder ${path}, because moving it aside could not be written down ` +
          `first and nothing would know where a note saved into it had gone`,
      );
      return false;
    }
    try {
      await this.move(normalized, aside);
    } catch {
      // Not moved, so not removed. The next pass asks again.
      return false;
    }
    this.entryChanged(normalized);
    if (await this.disposeOfEmptied(aside, normalized)) {
      this.wentAway(normalized);
      return true;
    }
    // Something was saved into it between the look and the move, so the
    // folder stays, with it inside.
    try {
      await this.move(aside, normalized);
      this.entryChanged(normalized);
    } catch (err) {
      // The name is taken again, by a folder made in the same instant. What is
      // in the hidden one is written down, file by file, so it is reported
      // rather than lost from view.
      await this.recordStrandedUnder(aside, path, err);
    }
    return false;
  }

  /**
   * Gives a folder another spelling of its own name (see `Vault.respellFolder`).
   *
   * The parent is listed for the folder as the disk spells it, as `matchCase`
   * does for a file, and the rename is this client's own, so the event
   * Obsidian reports for it is not sent on as a person's rename.
   */
  async respellFolder(from: string, to: string): Promise<boolean> {
    if (from === to || foldPath(from) !== foldPath(to)) return false;
    const want = this.resolve(to);
    const cut = want.lastIndexOf("/");
    const dir = cut === -1 ? "/" : want.slice(0, cut);
    const listed = await this.adapter.list(dir);
    const everything = [...listed.files, ...listed.folders];
    const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    const wanted = name(want);
    if (everything.some((p) => name(p) === wanted)) return false;
    const have = everything.filter((p) => foldPath(name(p)) === foldPath(wanted));
    if (have.length !== 1 || !listed.folders.includes(have[0]!)) return false;
    const target = `${have[0]!.slice(0, have[0]!.length - name(have[0]!).length)}${wanted}`;
    await this.move(have[0]!, target);
    this.entryChanged(target);
    return true;
  }

  /**
   * Removes a removal folder that holds nothing but operating system
   * metadata, with the metadata, and says whether it did. Anything else in it
   * is somebody's, and then nothing is touched.
   */
  private async disposeOfEmptied(hidden: string, home: string): Promise<boolean> {
    const metadata = await onlyMetadataIn(this.adapter, hidden, this.unsyncedIn(hidden, home));
    if (metadata === undefined) return false;
    for (const file of metadata) await this.adapter.remove(file);
    await removeOwnEmptyFolder(this.adapter, hidden);
    return true;
  }

  /**
   * Whether a file listed under `listed` is one this device never syncs, by
   * the path it has, or had, under the folder `home`: a removal folder's name
   * is hidden, and what is in it is judged by where it came from.
   */
  private unsyncedIn(listed: string, home: string): (file: string) => boolean {
    return (file) => this.ignored(`${home}${file.slice(listed.length)}`);
  }

  /**
   * Puts back what a folder removal left under its hidden name, for every
   * recorded removal folder still on the disk (RR2), and says which it
   * looked at.
   *
   * A removal folder is still there only when the removal did not finish: a
   * kill after the move, or a failure after it. One with nothing in it but
   * metadata is removed, which is what the removal was doing. One with
   * anything else in it holds something saved in the window, which no device
   * has, so it goes back under the folder's name; where a folder of that name
   * has been made since, each file goes into it at its own path if that is
   * free, and anything left is recorded file by file and reported, as
   * `removeFolder` does when it cannot put a folder back.
   */
  private async putBackRemovals(waiting: readonly Displaced[]): Promise<Set<string>> {
    const looked = new Set<string>();
    for (const d of waiting) {
      const hidden = normalizePath(d.at);
      if (!hidden.slice(hidden.lastIndexOf("/") + 1).startsWith(STAGING_MARK)) continue;
      try {
        if ((await this.adapter.stat(hidden))?.type !== "folder") continue;
        looked.add(d.at);
        let home: string;
        try {
          home = this.resolve(d.from);
        } catch {
          home = normalizePath(d.from);
        }
        if (await this.disposeOfEmptied(hidden, home)) continue;
        if (!(await this.adapter.exists(home))) {
          await this.ensureParents(home);
          await this.move(hidden, home);
          this.entryChanged(home);
          this.log(`put back ${d.from}, which a folder removal had moved aside and not finished`);
          continue;
        }
        await this.putBackInto(hidden, home, d.from);
      } catch (err) {
        this.log(`could not put back what ${d.at} holds: ${(err as Error).message}`);
      }
    }
    return looked;
  }

  /** Each file under `hidden` into `home` at its own path, where that path is free. */
  private async putBackInto(hidden: string, home: string, from: string): Promise<void> {
    const folders: string[] = [];
    const queue = [hidden];
    let left = false;
    while (queue.length > 0) {
      const at = queue.pop()!;
      folders.push(at);
      const listed = await this.adapter.list(at);
      queue.push(...listed.folders);
      for (const file of listed.files) {
        const to = `${home}${file.slice(hidden.length)}`;
        if (await this.adapter.exists(to)) {
          left = true;
          continue;
        }
        await this.ensureParents(to);
        await this.move(file, to);
        this.entryChanged(to);
      }
    }
    // Deepest first, and each only if the moves above emptied it.
    for (const at of folders.reverse()) await removeOwnEmptyFolder(this.adapter, at);
    if (left) {
      await this.recordStrandedUnder(
        hidden,
        from,
        new Error(`${from} holds a file of the same name`),
      );
    }
  }

  /** Every file under one of this client's hidden folders, written into the ledger. */
  private async recordStrandedUnder(hidden: string, path: string, err: unknown): Promise<void> {
    const queue = [hidden];
    while (queue.length > 0) {
      const at = queue.pop()!;
      let listed;
      try {
        listed = await this.adapter.list(at);
      } catch {
        continue;
      }
      queue.push(...listed.folders);
      for (const file of listed.files) {
        await this.ledger.record({
          at: file,
          from: `${normalizePath(path)}${file.slice(hidden.length)}`,
          why:
            `${path} was moved aside to be removed, something had been saved into it, and it ` +
            `could not be put back (${(err as Error).message})`,
          when: Date.now(),
        });
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    const normalized = this.resolve(path);
    if (await this.adapter.exists(normalized)) return;
    await this.ensureParents(normalized);
    await this.touch(normalized, () => this.adapter.mkdir(normalized));
    // A new directory is an entry in its parent, durable when the parent is.
    this.entryChanged(normalized);
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(this.resolve(path));
  }

  /**
   * Creates the folders a path needs.
   *
   * `writeBinary` does not, and a note arriving in a folder this device has
   * never seen is the common case on a first sync.
   *
   * Nothing is asked of the disk when Obsidian's index already holds the
   * parent as a folder, and then every folder above it too (P-1d). The look
   * was an `exists` per level for every file written, about 2 ms each on a
   * phone, mostly to find folders the index had in memory all along. An
   * index behind the disk the other way, a folder removed outside Obsidian
   * and not yet reported, leaves the staging write with no folder to go into:
   * it fails, the pass retries it once the index has caught up, and a failed
   * write lands nowhere, least of all on somebody else's file.
   */
  private async ensureParents(normalizedPath: string): Promise<void> {
    const cut = normalizedPath.lastIndexOf("/");
    if (cut === -1) return;
    const parent = this.vault.getAbstractFileByPath(normalizedPath.slice(0, cut));
    if (parent !== null && statOf(parent) === undefined) return;
    const parts = normalizedPath.split("/");
    parts.pop();
    let at = "";
    for (const part of parts) {
      if (part === "") continue;
      at = at === "" ? part : `${at}/${part}`;
      if (!(await this.adapter.exists(at))) {
        const folder = at;
        await this.touch(folder, () => this.adapter.mkdir(folder));
        this.entryChanged(at);
      }
    }
  }
}

/** The adapter's write options for the times the engine hands over. */
function writeOptions(times: Times): {
  mtime?: number;
  ctime?: number;
} {
  return {
    ...(times.mtime > 0 ? { mtime: times.mtime } : {}),
    ...(times.ctime > 0 ? { ctime: times.ctime } : {}),
  };
}

/**
 * What puts back a note whose in-place update was cut short (T09): the text
 * it held, its bytes, its times, and the incoming text the write was cutting.
 */
interface CutShort {
  readonly previous: string;
  readonly next: string;
  readonly before: Uint8Array;
  readonly was: Times;
}

/**
 * Whether `text` is what a write of `of` leaves when it stops part way: a
 * strict prefix of it, as the adapter reads one back.
 *
 * A cut that fell inside a character leaves bytes that are not UTF-8, which
 * the adapter's text read turns into U+FFFD, one or several depending on the
 * platform's decoder, so those are not counted against the prefix. Nothing
 * else is forgiven: a note holding one character that `of` does not have
 * there is not a write of `of` cut short.
 */
function cutShortOf(text: string, of: string): boolean {
  let start = text;
  while (!of.startsWith(start) && start.endsWith("\uFFFD")) start = start.slice(0, -1);
  return start.length < of.length && of.startsWith(start);
}

/** The same path with the case of its first cased letter flipped, or itself. */
function flipCase(path: string): string {
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    const upper = c.toUpperCase();
    const lower = c.toLowerCase();
    if (upper === lower) continue;
    return path.slice(0, i) + (c === upper ? lower : upper) + path.slice(i + 1);
  }
  return path;
}

/**
 * The index, in the plugin's own data folder.
 *
 * Kept out of the vault proper so it never syncs and never appears as a note.
 * Written through the adapter rather than the filesystem, because on mobile
 * there is no filesystem to write to.
 *
 * Two files, a snapshot and a journal of what has changed since, with the
 * reasoning and every crash case in `core/index-journal-store.ts` so that this
 * shell and the headless one cannot answer them differently. What is here is
 * the mapping onto the adapter, and it is the mapping that is awkward:
 *
 *   - the snapshot is written the way notes are, staged and read back, because
 *     the adapter's write truncates first. An index cut short by a crash was
 *     not valid JSON, and an index that is not valid JSON stops the plugin on
 *     every load (rule 2), so one bad moment put a vault whose notes were all
 *     fine behind a plugin that would not start. The staged copy is the way
 *     back: it is read when the live file cannot be, because it is complete and
 *     describes a state at least as new.
 *   - the journal is appended with `DataAdapter.append`, which is
 *     `fs.promises.appendFile(path, data, "utf8")` on desktop and Capacitor's
 *     `appendFile` with a UTF-8 encoding on mobile. Both were read out of the
 *     shipped bundle (`obsidian-1.13.7.asar`) rather than inferred from the
 *     declarations, and `append` is public from 1.7.2, which is this plugin's
 *     minimum. `appendBinary` is 1.12.3 and is not used for that reason.
 *   - there is no staged copy of the journal and there does not need to be. A
 *     record the adapter cut short is discarded by the next load and the
 *     records before it are not, so the failure a staged copy exists to
 *     prevent cannot happen here.
 *
 * What is still not offered is an fsync. The adapter has no way to ask for one,
 * so a record is durable when the platform says it is, exactly as a note is.
 * That is not a regression and it is not an improvement.
 */
export class ObsidianIndexStore implements IndexStore {
  private readonly files: ObsidianJournalFiles;
  private readonly store: JournalIndexStore;

  constructor(
    private readonly adapter: DataAdapter,
    path: string,
    opts: JournalStoreOptions = {},
  ) {
    this.files = new ObsidianJournalFiles(adapter, normalizePath(path));
    this.store = new JournalIndexStore(this.files, {
      log: (message: string, ...rest: unknown[]) => console.warn(`TrewSync: ${message}`, ...rest),
      ...opts,
    });
  }

  load(): Promise<StoredState | undefined> {
    return this.store.load();
  }

  save(state: StoredState): Promise<void> {
    return this.store.save(state);
  }

  /**
   * Removes the index, every copy of it, and proves they are gone.
   *
   * What unlink needs. An index left behind is read by the next pairing as
   * the truth about a server that has never seen this device, a staged copy
   * left behind is read by `load` as the index, and a journal left behind is
   * a delta against a snapshot that no longer exists.
   */
  async remove(): Promise<void> {
    for (const path of this.files.everyFile()) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
      if (await this.adapter.exists(path)) {
        throw new Error(`${path} is still there after removing it`);
      }
    }
  }
}

/** The snapshot, the journal and the stats, through Obsidian's adapter. */
class ObsidianJournalFiles implements JournalFiles {
  private readonly log: string;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly live: string,
  ) {
    this.log = indexLogPath(live);
  }

  /**
   * A fixed name, unlike a note's staging copy, because `readSnapshot` has to
   * find it after a restart. Inside the plugin's own folder, so nothing of the
   * user's can be there under that name.
   */
  private get temp(): string {
    return stagingPath(this.live, "index");
  }

  /** Every path this store owns, for a removal that must leave nothing behind. */
  everyFile(): string[] {
    // The journal first, and this order is the only safe one (F22).
    //
    // A crash between the removals leaves whatever is still there. Journal
    // gone and snapshot left is exactly what an index looked like before the
    // journal existed, and it loads without a word. The other way round is a
    // delta against a base that is not there, which the loader refuses, so an
    // unlink that stopped half way left a vault that would not start. The CLI
    // has removed them in this order since the journal landed; this had the
    // list the other way up.
    //
    // The staged snapshot sits between them: it is a copy of the live one, so
    // it is safe at any point, and putting it after the journal keeps the two
    // that matter adjacent.
    return [this.log, this.temp, this.live];
  }

  /**
   * The live snapshot, or the staged copy when the live one cannot be read.
   *
   * Which of the two is returned changes nothing about the journal beside
   * them. The staged copy is written first and holds the newer sequence, so a
   * journal that continues the live file is already folded into it and every
   * record is skipped; a journal that continues the staged copy is applied to
   * the live one across the same gap. Either way no delta lands on a base it
   * was not computed against.
   */
  async readSnapshot(): Promise<string | undefined> {
    const live = await this.readFile(this.live);
    if (live.text !== undefined && parses(live.text)) {
      // A staging copy left behind means a save was interrupted after the
      // live file was complete, or never got as far as touching it. The live
      // file is complete and parses, so it is the state to start from; an
      // older index is always safe, because notes are durable before the
      // index that names them.
      if (await this.adapter.exists(this.temp)) await this.adapter.remove(this.temp);
      return live.text;
    }
    const staged = await this.readFile(this.temp);
    if (staged.text !== undefined && parses(staged.text)) return staged.text;
    // Neither parses. The live file's text, if there is one, so the refusal
    // above names what is wrong with the file somebody has to fix.
    return live.text;
  }

  async writeSnapshot(text: string): Promise<void> {
    const live = this.live;
    const parts = live.split("/");
    parts.pop();
    if (parts.length > 0) {
      const dir = parts.join("/");
      if (dir !== "" && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }

    const temp = this.temp;
    const bytes = new TextEncoder().encode(text);
    await stage(this.adapter, temp, bytes, {});
    if (!(await this.adapter.exists(live))) {
      try {
        await this.adapter.rename(temp, live);
        await verify(this.adapter, live, bytes);
      } catch (err) {
        await this.adapter.remove(temp).catch(() => undefined);
        throw err;
      }
      return;
    }
    // In place, because rename refuses an occupied destination (see the header
    // of this file). The staged copy stays until the live file has been read
    // back, and stays for good if it never is: `readSnapshot` finds it.
    await this.adapter.write(live, text);
    await verify(this.adapter, live, bytes);
    // The live index is verified, so a staged copy that will not go is clutter
    // and not a failure: raising here would have the next pass write the same
    // index again and fail the same way, for ever. `readSnapshot` removes it
    // the next time the plugin starts.
    await this.adapter.remove(temp).catch(() => undefined);
  }

  async readLog(): Promise<string | undefined> {
    return (await this.readFile(this.log)).text;
  }

  async appendLog(line: string): Promise<void> {
    await this.adapter.append(this.log, line);
  }

  /**
   * Empty, and still there. A missing log and an empty one are different states.
   *
   * `write` truncates first, which is the one place in this file where that is
   * exactly what is wanted, and it is verified afterwards rather than trusted
   * (rule 4). A truncate that silently did not happen would leave the records
   * a fresh snapshot has already folded in, and the load after that skips them
   * by sequence, so this is belt and braces rather than the only defence.
   */
  async truncateLog(): Promise<void> {
    await this.adapter.write(this.log, "");
    const stat = await this.adapter.stat(this.log);
    if (stat === null || stat.type !== "file" || stat.size !== 0) {
      throw new Error(`the index journal at ${this.log} is not empty after truncating it`);
    }
  }

  async stamps(): Promise<JournalStamps> {
    const [snapshot, log] = await Promise.all([this.stampOf(this.live), this.stampOf(this.log)]);
    return { ...(snapshot ? { snapshot } : {}), ...(log ? { log } : {}) };
  }

  private async stampOf(path: string): Promise<IndexStamp | undefined> {
    const stat = await this.adapter.stat(path);
    if (stat === null || stat.type !== "file") return undefined;
    return { size: stat.size, mtime: stat.mtime };
  }

  /**
   * One file's text, or undefined when it is absent.
   *
   * A read that throws is not an absent file. Rule 2, and the incident it came
   * from: falling back to an empty result and writing it back disabled every
   * plugin on a device.
   */
  private async readFile(path: string): Promise<{ text?: string }> {
    if (!(await this.adapter.exists(path))) return {};
    return { text: await this.adapter.read(path) };
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function trimLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * The displaced-version log, through Obsidian's adapter.
 *
 * Inside the plugin's own folder, which is inside Obsidian's config folder,
 * which this client never syncs. A record of what went wrong on this device
 * arriving on another device would be a note nobody wrote about a note nobody
 * can reach.
 */
class ObsidianDisplacedFiles implements DisplacedFiles {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly path: string,
  ) {}

  async read(): Promise<string | undefined> {
    // Desktop `exists` turns access failures into false. Only a missing file
    // is an empty ledger; stat propagates other errors to the recovery report.
    if ((await this.adapter.stat(this.path)) === null) return undefined;
    return await this.adapter.read(this.path);
  }

  async append(line: string): Promise<void> {
    // `DataAdapter` has an append, and it is the only reason this log is lines
    // rather than a document: a whole-file rewrite on every record would lose
    // the whole log to one bad write, at the moment something has already gone
    // wrong with somebody's note.
    await this.mkdirForIt();
    await this.adapter.append(this.path, line);
  }

  // No `rewrite`, on purpose (RR3). `DataAdapter.write` truncates in place, so
  // a short write leaves a log holding the first few bytes of one record and
  // an inventory of nothing, while the hidden notes those records named are
  // still there and now unfindable. The ledger compacts only where a shell can
  // replace the whole file or none of it, and this adapter cannot: it has no
  // staged write, and remove-then-rename has a moment with no log at all,
  // which reads as a clean vault. See `core/displaced.ts`.

  /**
   * Empties the log while it still holds exactly what was read (T11).
   *
   * What this shell can do instead of `rewrite`, and all the log needs here.
   * Every incoming deletion writes a record before the note is moved aside,
   * and the record is dead once the note is in the trash; a log that only
   * grew had a phone reading back and looking on the disk for every deletion
   * it had ever applied, on every pass. Writing nothing cannot be cut short
   * into half a record, so the log is either as it was or empty, and the
   * ledger asks for this only when every record in it is dead. Inside
   * `process`, so a record appended since the log was read is not emptied
   * with the dead ones; and the result is checked rather than trusted (rule
   * 4).
   */
  async clear(was: string): Promise<boolean> {
    let emptying = false;
    await this.adapter.process(this.path, (current) => {
      emptying = current === was;
      return emptying ? "" : current;
    });
    if (!emptying) return false;
    const stat = await this.adapter.stat(this.path);
    if (stat === null || stat.type !== "file" || stat.size !== 0) {
      throw new Error(`the displaced-version log at ${this.path} is not empty after emptying it`);
    }
    return true;
  }

  async stillThere(at: string): Promise<boolean> {
    return (await this.adapter.stat(at)) !== null;
  }

  private async mkdirForIt(): Promise<void> {
    const cut = this.path.lastIndexOf("/");
    if (cut <= 0) return;
    const dir = this.path.slice(0, cut);
    if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
  }
}
