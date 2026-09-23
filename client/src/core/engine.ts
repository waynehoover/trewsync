import type { SyncPreview, PreviewAction } from "./preview.ts";
import type { Activity, ActivityAction } from "./activity.ts";
/**
 * The engine: everything that decides, and nothing that knows where files live.
 *
 * Structure follows Obsidian's: an orchestrator collaborating with a transport
 * that knows no policy, a filter that knows only paths, and a chunker with no
 * reference to the app. That shape is why the same engine runs in their plugin
 * and their headless client, and it is why this one can run against a vault
 * held in memory.
 *
 * Two properties this is built around, both from that reading:
 *
 *   - **Single flight.** One sync runs at a time, and requests to sync while one
 *     is running set a flag rather than starting a second. Two passes deciding
 *     about the same file from the same index is how a file gets uploaded twice
 *     or downloaded over itself.
 *   - **Retry and refuse are different.** A file that failed once should be tried
 *     again later; a file that can never work should not be tried forever. One
 *     work queue cannot tell those apart, which is why Obsidian keeps
 *     `fileRetry` and `skippedFiles` as separate tables and so does this.
 *
 * ## What the tests pin down
 *
 * Every one of sixteen deliberate breakages of this file is caught by two
 * engines converging through a real server. Three of them took a specific case
 * to catch, and those cases are worth knowing about because each one is a real
 * way to lose a note:
 *
 *   - Moving the ancestor when the two sides already agree. Nothing transfers,
 *     so it looks like a no-op; skip it and the next pair of edits merges
 *     against a version neither device ever had.
 *   - Recording the ancestor on the download itself. The line above would set it
 *     on the following pass anyway, so the two cover each other. The case that
 *     separates them is a user editing straight after a download, before any
 *     pass in which both sides still agree.
 *   - Uploading the conflict copy rather than waiting for the next scan to find
 *     it as a new file. The scan is a real backstop, and it is no use when the
 *     device that found the conflict syncs once and then stops: the other device
 *     downloads the winning version over its own text, and its own text is gone.
 *
 * None of the three is caught by asserting that two devices agree, which is
 * rule 10 of docs/design.md in its natural habitat.
 */

import { notifyTransfer, type TransferActivity } from "./transfer.ts";
import {
  CHUNK_FLOOR,
  looksLikeJson,
  looksLikeText,
  looksLikeYaml,
  chunkBytes,
  chunkStream,
  sizesFor,
} from "./chunk.ts";
import { parsesAsYaml } from "./yaml.ts";
import { drawingGate, looksLikeExcalidraw } from "./excalidraw.ts";
import { looksLikeMarkupPath, wellFormedMarkup } from "./markup.ts";
import { chunkName, chunkNames, plainDigest } from "./digest.ts";
import { pathReason, type PathReason } from "./path-policy.ts";
import { conflictCopyPath, mergeText } from "./merge.ts";
import {
  decide,
  needsRehash,
  newEntry,
  nextUploadTime,
  observe,
  readyToSyncAgain,
  renamed,
  synced,
  type Action,
  type IndexEntry,
  type LocalState,
  type RemoteState,
  reconciled,
} from "./index-state.ts";
import {
  ConnectionError,
  MAX_BATCH_ENTRIES,
  MAX_FETCH_NAMES,
  encodedEntryBytes,
  entryBudget,
  PUTMANY_FRAME_OVERHEAD,
  ProtocolError,
  type BatchEntry,
  type ServerLimits,
  type Transport,
  type WireEntry,
} from "./transport.ts";
import { validateStoredState } from "./stored-state.ts";
import {
  canonicalSpelling,
  firstFreeName,
  foldPath,
  foldsTogether,
  isNeverSynced,
  spellOut,
} from "./paths.ts";
import {
  parents,
  type ExpectedContent,
  type FileStat,
  type IndexStore,
  type Times,
  type Vault,
} from "./vault.ts";

/**
 * An index entry with its derivable fields left out.
 *
 * The entry holds a chunk name list, the same names joined as `hash`, and often
 * the same string again as `synchash`, so a vault's chunk names were written to
 * disk three times over. At two thousand files that is 6.96 MiB of index where
 * 2.33 MiB says the same thing, and the whole of it is stringified and written
 * whenever anything changes.
 *
 * Only the serialised form changes. In memory the entry keeps all three, which
 * is what `decide` compares on a hot path, and neither field is recomputed
 * while the engine is running.
 *
 * Left in place when they differ, because they genuinely can: `hash` is the
 * content as of the last scan and `synchash` as of the last completed sync, and
 * the difference between them is the merge base. Dropping that would not save
 * space, it would lose the ancestor.
 */
function packed(e: IndexEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...e };
  if (e.hash === contentId(e.chunks)) delete out["hash"];
  if (e.synchash === e.hash) delete out["synchash"];
  return out;
}

/** The inverse, putting back what `packed` left to be derived. */
function unpacked(path: string, raw: Record<string, unknown>): IndexEntry {
  const e = { ...newEntry(path), ...raw } as IndexEntry;
  if (raw["hash"] === undefined) e.hash = contentId(e.chunks);
  if (raw["synchash"] === undefined) e.synchash = e.hash;
  return e;
}

/**
 * The identity of a file's content, as both sides can compute it.
 *
 * Equality of content is equality of the chunk name sequence. A chunk's name is
 * the SHA-256 of its raw bytes and the chunker is deterministic, so the same
 * bytes are always the same list, on this device and on the server.
 *
 * An empty file gets a marker rather than the empty string, because the index
 * uses `synchash === ""` to mean "never synced". Without this an empty note that
 * had synced perfectly well would read as one that never had, and every pass
 * would treat it as new.
 */
export function contentId(chunkNames: readonly string[]): string {
  return chunkNames.length === 0 ? "-empty-" : chunkNames.join(",");
}

/**
 * Refuses a server that is behind the device talking to it.
 *
 * The docs present the client-ahead case as what catches a server restored from
 * an old backup or pointed at the wrong vault, and the refusal was implemented
 * only in the server, so it was absent exactly when it was needed: against a
 * server that is wrong. `ready.cursor` was parsed, logged, shown in the status
 * line, and never compared. Worse, the status line computed `behind` as
 * `max(0, server - local)`, so a server behind its clients displayed as zero
 * and read as being up to date.
 *
 * Its own function because a real server refuses this case first, so nothing
 * short of a lying transport reaches the check and the comparison is the part
 * worth testing.
 *
 * The message names the way out, because an error string is the only UI a
 * stopped device has. It used to end at "the wrong vault", which is a correct
 * diagnosis and no help at all: the person reading it is looking at a vault
 * that has stopped syncing, and the recovery lived in docs/server.md. Both
 * recoveries are named, and the cost of the blunt one with them, because
 * re-pairing resets the merge base and the next concurrent edit then makes
 * conflict copies instead of merging.
 *
 * A `ProtocolError` with the server's own code for this, rather than a plain
 * Error, for two reasons. `runForever` stops on a fatal `ProtocolError` and
 * otherwise retries: a plain Error here was retried three times and then
 * reported under a message about an entry no device can apply, which is a
 * different fault with a different fix. And a shell that wants to offer the
 * recovery has one thing to recognise however the refusal arrived, from the
 * wire or from here.
 */
export function refuseIfBehind(serverCursor: number, ownCursor: number): void {
  if (serverCursor < ownCursor) {
    throw new ProtocolError(
      "cursor",
      `this server is at version ${serverCursor} and this device has already seen ${ownCursor}: ` +
        `refusing to sync, because a server behind its own clients is a restored backup or the wrong vault. ` +
        `${REJOIN_ADVICE}`,
    );
  }
}

/**
 * The way back from a server that has lost history a device already applied.
 *
 * One string, because the two shells say it in the same breath: the headless
 * client prints it under the refusal and the plugin puts it in the panel beside
 * the button that does it.
 */
export const REJOIN_ADVICE =
  "A restore through trew backup starts a new epoch and needs nothing from here; this is a " +
  "data directory copied back behind the server's back. To rejoin it and keep what only this " +
  "device holds, back the server up, then press Rejoin this server in the Trew panel, or unlink " +
  "this device and pair it again with a new invite. Either resets the merge base, so the next " +
  "edit made on two devices at once makes conflict copies instead of merging.";

/**
 * What this device accepts whatever the server says it stores.
 *
 * The inbound guards read their bounds from `ready`, which is the party they
 * exist to bound. `numberOf()` maps a missing field to 0 and both guards read
 * `if (max > 0)`, so a server that merely omitted `perFileMax` and `maxChunks`
 * switched them both off, and a corrupt row did the same. Missing has to mean
 * this device's own ceiling, never no ceiling.
 *
 * These are the protocol's own maxima, from the server's store package, so
 * nothing a working server asks for is refused by them.
 */
export const OWN_LIMITS = {
  /** 256 MiB, the largest file any server will store. */
  perFileMax: 1 << 28,
  /** 65536, the most chunks any server records for one entry. */
  maxChunks: 1 << 16,
  /** 16 MiB, the largest batched write any server takes, encoded or as summed budget. */
  maxBatchBytes: 16 << 20,
  /** 64 MiB, the most body bytes any server serves for one fetch. */
  maxFetchBytes: 64 << 20,
  /** 1 MiB, the largest raw chunk any server stores. */
  chunkMax: 1 << 20,
} as const;

/** The tighter of what the server asks for and what this device allows. */
export function boundedBy(fromServer: number, own: number): number {
  return fromServer > 0 ? Math.min(fromServer, own) : own;
}

/**
 * Refuses an entry that contradicts itself, before anything acts on it.
 *
 * Every path that acts on an entry comes through here: the sync path for every
 * batch entry, and recovery for every version it shows or restores, because a
 * server that answers with a shape it would never store is still a server this
 * device has to survive. The protocol states this invariant and assigns it to
 * the server: "a file declaring a size names at least one chunk, since a size
 * with no chunks is byte-identical on the wire to an empty note." It was once
 * not mirrored here.
 *
 * Unmirrored, one frame emptied a note. `contentId([])` is `-empty-`,
 * `chunkNamesOf` gives it back as no chunks, nothing is fetched, and the
 * zero-length assembly is written over the file. Through `write` rather than
 * `remove`, so there is no trash copy, and the emptied note then goes to every
 * peer as an ordinary edit.
 *
 * A corrupt row does this as readily as a hostile server, which is the same
 * reason the size and chunk-count limits exist.
 */
export function checkEntryShape(e: WireEntry): void {
  // The same list the server's `store.Entry.Validate` enforces, and
  // `protocol-fixtures.json` is what keeps the two lists the same (I03).
  //
  // This used to check two of the server's rules and the server checked seven.
  // That asymmetry is the wrong way round: a server is not obliged to be
  // honest, so every shape it refuses to *store* is a shape a hostile one can
  // still *send*, and the client is the side that has to refuse it on the way
  // in. Checking less here than the server does meant trusting that nobody
  // would ever write the difference.
  if (e.path === "") {
    throw new Error(`version ${e.uid} has an empty path, and no file is called nothing`);
  }
  if (e.folder && e.deleted) {
    throw new Error(`version ${e.uid} is both a folder and a deletion`);
  }
  if (e.size < 0) {
    throw new Error(`version ${e.uid} declares ${e.size} bytes, and there is no such file`);
  }
  for (const name of e.chunks) {
    if (!isDigest(name)) {
      throw new Error(`version ${e.uid} names ${JSON.stringify(name)}, which is not a chunk name`);
    }
  }
  if (!e.folder && !e.deleted && e.size > 0 && e.chunks.length === 0) {
    throw new Error(
      `version ${e.uid} declares ${e.size} bytes and names no chunks, which cannot both be true`,
    );
  }
  if (!e.folder && !e.deleted && e.size === 0 && e.chunks.length > 0) {
    throw new Error(`version ${e.uid} is a zero-byte file naming ${e.chunks.length} chunks`);
  }
  if (e.chunks.length > 0 && (e.folder || e.deleted)) {
    const what = e.folder ? "a folder" : "a deletion";
    throw new Error(`version ${e.uid} is ${what} and names ${e.chunks.length} chunks`);
  }
}

/** Lowercase hex SHA-256, which is the shape of a chunk name. */
function isDigest(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * The chunk names back out of a content id.
 *
 * The id is the names joined, so this is not a lookup, it is punctuation. It
 * matters because a batch already carries the chunk list of every entry in it,
 * so a device that keeps the id keeps the list, and asking the server for it
 * again is a round trip spent learning something already known.
 *
 * A chunk name is hex, so the comma can never appear inside one.
 */
export function chunkNamesOf(id: string): string[] {
  return id === "" || id === "-empty-" ? [] : id.split(",");
}

export interface EngineOptions {
  readonly vault: Vault;
  readonly store: IndexStore;
  readonly transport: Transport;
  /** Keep the main wire available while a large upload sends its bodies. */
  readonly withUploadTransport?: <T>(work: (transport: Transport) => Promise<T>) => Promise<T>;
  readonly releaseUploadTransport?: () => void;
  /**
   * Measure where a pass spends its time, and put it in the report.
   *
   * Off everywhere that ships. When off, the marks below are a single boolean
   * test at each boundary: no clock reading, no allocation, no record. That is
   * checked rather than asserted, by running `bench:pass` with it off against
   * the commit before it existed.
   */
  readonly timing?: boolean;
  readonly device: string;
  readonly vaultId: string;
  /** This device's row in the vault's device list. */
  readonly deviceId: string;
  /** This device's own 32-byte token, unpadded base64url. */
  readonly token: string;
  readonly now?: () => number;
  readonly log?: (message: string, ...rest: unknown[]) => void;
  readonly onActivity?: (activity: Activity) => void;
  readonly confirmFirstSync?: (preview: SyncPreview) => Promise<boolean>;
  readonly confirmDeletions?: (preview: SyncPreview) => Promise<boolean>;
  /** The open note gets its own first batch before background text or attachments. */
  readonly activePath?: () => string | undefined;
  /** Path preparation, and undefined before the pass flushes files and saves its index. */
  readonly onProgress?: (path: string | undefined) => void;
  /** Transfer activity for a sync batch; undefined when the exchange ends, before local saving. */
  readonly onTransfer?: (activity: TransferActivity | undefined) => void;
  /** Whether a path may be three-way merged. Defaults to text extensions. */
  readonly mergeable?: (path: string) => boolean;
  /**
   * Whether to hold back a binary attachment that was written moments ago.
   * Notes and other recognized text formats never wait on this cooldown.
   *
   * On by default, which is right for a client that keeps running. A one-shot
   * sync turns it off: deferring to a next pass that will never happen would
   * mean exiting successfully having skipped the file the user just saved.
   */
  readonly coalesceWrites?: boolean;
  /**
   * Whether two edits to one note may be merged. Default true (I30).
   *
   * False keeps both versions in every case that would have merged, which is
   * what merging already does when it cannot proceed safely.
   */
  readonly merge?: boolean;
  /**
   * Whether this device may send anything to the server. Default false, which
   * is to say it may (I29).
   */
  readonly readOnly?: boolean;
}

/** Overrides for a single pass. */
export interface SyncOptions {
  /** Read every file's contents instead of trusting the saved hash cache. */
  readonly verifyContents?: boolean;
  /** Refresh the full listing, including changes a filesystem watcher missed. */
  readonly forceFullScan?: boolean;
  /** Retry transient failures once now; automatic failures keep their backoff. */
  readonly retryFailures?: boolean;
  /**
   * Whether to hold back a file written moments ago, just for this pass.
   *
   * Defaults to whatever the engine was built with. A person choosing "sync
   * now" turns it off: they have said now, and reporting "up to date" while
   * the line they just typed sits unsent is the exact status rule 7 forbids.
   */
  readonly coalesceWrites?: boolean;
  /**
   * Whether two edits to one note may be merged. Default true (I30).
   *
   * False keeps both versions in every case that would have merged, which is
   * what merging already does when it cannot proceed safely.
   */
  readonly merge?: boolean;
  /**
   * Whether this device may send anything to the server. Default false, which
   * is to say it may (I29).
   */
  readonly readOnly?: boolean;
}

/**
 * What a sync did.
 *
 * Counted separately rather than summed, because rule 7 of
 * docs/design.md is that a status which cannot distinguish the cases it
 * collapses is not a status. "12 files synced" hides whether anything conflicted.
 */
/**
 * What one `repair` run did, and what it knows it did not do (I14).
 *
 * The counts are deliberately about this device and nothing else, because that
 * is the whole of what a device can see. A body belonging to a version this
 * device never had is not on this disk and is not in this index: there is
 * nothing here that could notice it is gone, let alone supply it. The
 * authoritative list of what a vault is still missing comes from `trew
 * verify` on the server, and both shells say so rather than implying that a
 * clean repair means a whole vault.
 */
export interface RepairReport {
  /** Notes this device holds and examined. */
  scanned: number;
  /** Chunk names offered to the server across all of them. */
  offered: number;
  /** Bodies the server was missing and now has. */
  stored: number;
  /**
   * Chunks of notes this device could not offer, because its copy has moved on
   * from the version the server acknowledged.
   *
   * Those bytes were this device's and are not any more. Counted because it is
   * the one kind of "cannot help" this device can actually see, and because a
   * repair run that examined a note and skipped it should say so.
   */
  couldNotOffer: number;
  /**
   * Bodies the server asked for, was sent, and still does not have.
   *
   * Always zero in a healthy run, and never a normal outcome: the server asked
   * for these, so it wants them, and it refused what arrived. A full disk is
   * the likely reason.
   */
  stillMissing: number;
  /** Paths that could not be read or sent, with why. One does not stop the rest. */
  failed: Array<{ readonly path: string; readonly why: string }>;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  merged: number;
  conflicted: number;
  deletedLocally: number;
  deletedRemotely: number;
  restored: number;
  foldersCreated: number;
  unchanged: number;
  /**
   * Files held back by the write debounce, which will go on the next pass.
   *
   * Its own counter rather than folded into `unchanged`, because rule 7 of
   * docs/design.md is that a status collapsing cases it should distinguish
   * is not a status. "unchanged" for a file the user saved four seconds ago is
   * the exact lie that rule is about.
   */
  waiting: number;
  /** Earliest deferred upload or transient retry; absent when no timed work remains. */
  nextUploadAt?: number;
  /** All server entries through this cursor were applied and the local pass saved. */
  appliedCursor?: number;
  /** Files that failed and will be tried again. */
  retrying: number;
  /** Files that can never work and will not be tried again. */
  skipped: number;
  /**
   * Which ones, sorted, and bounded the way `inTheWay` is.
   *
   * The count alone is not an identity, and the plugin's notice fires on a
   * change (N2). One file being fixed in the same pass as another starts
   * failing leaves the count at one, and the new failure was never announced:
   * the glyph said something was wrong and nothing ever said what. Bounded
   * because one bad folder writes off everything under it, and a list the
   * length of a subtree is not a message.
   */
  skippedPaths: string[];
  /**
   * Paths this pass could not finish and will try again, sorted and bounded
   * the way `skippedPaths` is.
   *
   * `retrying` is a count, and a count cannot answer the one question a
   * caller acting on a single path has: did *mine* go? Restoring a version
   * settled the vault, ignored the report, and reported the restored note as
   * sent to the other devices whatever had happened to it (F15). A number is
   * enough for a status line and never enough for a promise about one file.
   */
  retryingPaths: string[];
  /**
   * Paths another device syncs that this one is set to ignore.
   *
   * Its own counter rather than folded into `skipped`, and deliberately not
   * part of the exit code (R2). Refusing them is the configuration doing what
   * it was told, so calling the run a failure meant one `--ignore` made every
   * later sync exit 1 for ever. Counted and printed all the same: a number
   * that quietly disappears is how somebody loses track of a folder they
   * stopped syncing years ago.
   */
  ignored: number;
  /**
   * Local changes this device will never send, because it is read-only (I29).
   *
   * Its own count rather than folded into `ignored`, and out of the exit code
   * for the same reason: it is the configuration doing what it was told. An
   * `--ignore` is a path this device does not sync at all; this is one it
   * syncs in a single direction, and somebody looking at a mirror quietly
   * accumulating local edits should be told which of the two they have.
   */
  heldBack: number;
  /** Which ones, so the line names them rather than counting them. */
  heldBackPaths: string[];
  /**
   * Paths a file is standing in the way of.
   *
   * Its own counter rather than folded into `skipped`, whose label says a file
   * will not be tried again. These are tried every pass and cannot succeed
   * until somebody renames one of the two things that disagree, which is a
   * different thing to tell a person and rule 7 says to tell them apart.
   */
  blocked: number;
  /**
   * Which paths, and what is standing in the way of each.
   *
   * The count on its own is not something anybody can act on, and this is the
   * one refusal that never clears itself: it waits until a person renames one
   * of the two things that disagree, and they cannot do that without being
   * told which two. Bounded, because a folder converted to a file blocks
   * everything under it and a list the length of a subtree is not a message.
   */
  inTheWay: {
    path: string;
    blockedBy: string;
    /**
     * The sentence for this one, where "a file here and a folder elsewhere"
     * is not what happened.
     *
     * Optional, and absent for the clash that named this field, which every
     * caller already spells out. Two names on disk that are one path once
     * normalized need their own sentence: the two look identical printed
     * plainly, so a message that did not spell them out would ask a person to
     * rename one of two strings they cannot tell apart.
     */
    why?: string;
  }[];
  /**
   * The one list a person reads: every path waiting on somebody, and the
   * sentence saying what to do about it.
   *
   * Rule 7 is about a status that cannot tell its cases apart, and the answer
   * to it was four counters. Four is three distinctions to learn before the
   * output can be read, and the distinctions are ours: `blocked`, `skipped`
   * and `refusedInbound` all mean "this path is not syncing and waiting will
   * not fix it", and each one's *reason* is the part that differs and the part
   * that can be acted on. So the reasons are what is printed, in one list, and
   * the categories stay where they belong, in the engine.
   *
   * The four maps are untouched and so are the counters above: each came from
   * its own incident and they carry different exit-code semantics, which
   * merging would throw away to save a noun. This is a projection of them for
   * printing, and both shells render it rather than each inventing its own
   * vocabulary for the same three counters.
   *
   * `ignored` is deliberately not in here (R2). A path another device syncs
   * and this one is set to ignore is the configuration doing what it was
   * asked; nobody needs to attend to it, which is the same reason it is not in
   * the exit code. It keeps its counter and is still printed, because a number
   * that quietly disappears is how somebody loses track of a folder they
   * stopped syncing years ago.
   *
   * Bounded the way `inTheWay` and `skippedPaths` are, and bounded per source
   * rather than over the whole list: one file where a folder belongs blocks a
   * subtree, and a single list capped at the end would let that one cause hide
   * every other. `blocked` is the count of the first kind and `skipped` of the
   * second, so a renderer can always say how many are not shown.
   */
  needsAttention: { path: string; why: string }[];
  /**
   * Where a pass spent its wall time, when this device was asked to measure.
   *
   * Absent unless `timing` is on, which it is not in any shipped
   * configuration: the numbers exist to settle whether reconciliation visiting
   * the whole index is worth rewriting (see docs/open-work.md), and a question
   * asked once does not deserve a permanent cost.
   *
   * Wall time, not CPU time, and on a phone that distinction is the whole
   * story: Obsidian runs on the same single JavaScript thread, so a phase that
   * held the event loop while Obsidian reacted to a save is charged for it.
   * That is why the quiet ticker passes are the evidence and the save passes
   * are not.
   */
  phases?: PassPhases | undefined;
  /** Chunk bodies actually sent, and their size. The measure that matters. */
  chunksSent: number;
  bytesSent: number;
  /**
   * Chunk bodies a download did not have to ask for, because this device
   * already held them in the file it was replacing.
   *
   * The download's own measure, and the reason it is counted separately from
   * `downloaded`: a file that arrives is a file that arrived either way, and
   * what changed is how much of somebody's connection it took.
   */
  reusedChunks: number;
}

/**
 * The four terms a pass divides into, in milliseconds, plus how many rounds it
 * took.
 *
 * They partition the pass and are meant to be added up: `list` is the vault
 * listing and the restored-path recheck, `decide` is everything from the first
 * observation to the end of the ordered walk with transfer time taken out,
 * `transfer` is every fill, flush and delete application wherever they happen,
 * and `save` is the prune, the vault flush and the index write.
 *
 * `journalCompare` is inside `save` rather than beside it, and is reported
 * separately because it is the term the rewrite in docs/open-work.md would
 * remove. `filesystem` is an overlay, not a fifth term: it cuts across all
 * four, and on Android it is the one most likely to differ from a desktop.
 */
export interface PassPhases {
  listMs: number;
  decideMs: number;
  transferMs: number;
  saveMs: number;
  /** Inside `saveMs`: the journal's own record-by-record comparison. */
  journalCompareMs: number;
  /** Across all four: time awaited inside the vault adapter, by operation. */
  filesystemMs: Record<string, { ms: number; calls: number }>;
  /** How many rounds `sync` ran, since `again` can repeat a pass. */
  rounds: number;
}

/**
 * How many paths any of the report's lists names before it stops being a
 * message.
 *
 * One file where a folder belongs blocks every path beneath it, so the count
 * can be a whole subtree while the *cause* is a single name. Naming a few is
 * enough to act on; naming four hundred is a wall.
 *
 * One constant for every list, because there were three: blocked and written
 * off at five, held back at twenty, and only one renderer said how many it was
 * not showing. Two bounds is two answers to "is this list the whole of it", and
 * the count beside each list is what a renderer says the remainder from.
 */
const LISTED_PATHS = 5;

/**
 * How many `stale` refusals of one path are answered by asking the server for
 * its head before the path is put on ordinary backoff instead (R083-01).
 *
 * Three, because one refusal is the ordinary case of another device writing
 * first, a second says the head this device then fetched was already old, and
 * a third says asking is not what this path is short of.
 */
const STALE_REFUSALS_BEFORE_BACKOFF = 3;

/**
 * How long a path waits after the connection went away under it (R083-03).
 *
 * Flat, and short, because it is not a fact about the file: the reconnect is
 * what decides when this can be tried, and `runForever` builds a fresh engine
 * for it anyway. What matters is that it is not `5 * 2^n` per path.
 */
const RECONNECT_RETRY_MS = 5_000;

/**
 * The floor under a pass that asked to run again immediately (R083-02).
 *
 * `again` means a pass found work it could not finish, and eight rounds of it
 * end with `nextUploadAt` set to now, which the client turns into
 * `setTimeout(0)`. Anything that sets `again` on every pass is then a
 * continuous loop of whole-vault passes: a peer editing the note this device
 * is uploading, or a path the server keeps refusing. A second between rounds
 * is imperceptible to a person and is the difference between catching up and
 * spinning.
 */
const AGAIN_FLOOR_MS = 1_000;

/**
 * Counts one path as written off, and records which one.
 *
 * One place, because the count and the names have to move together: a counter
 * bumped without a name is exactly the report the plugin cannot tell apart
 * from the pass before it.
 */
/**
 * What to do about a refusal, in one sentence (I11).
 *
 * A refusal that names only what went wrong leaves somebody with a file that
 * will never sync and no idea which of the two devices to go and look at. The
 * reason and the remedy are different halves and only one of them was ever
 * printed. Kept beside the codes rather than in either shell, because both
 * print the same list and neither should be inventing advice.
 *
 * Nothing for a code with no general answer: a made-up next step is worse
 * than none, because it sends somebody to do something that will not help.
 */
function nextStepFor(code: string | undefined): string {
  switch (code) {
    case "toolarge":
      return "Make it smaller, or raise the server's -max-file and restart it.";
    case "badname":
      return "Rename it to something this server will take, on the device that made it.";
    case "neversync":
      return "Nothing syncs under that name here. Move it, or change what this device ignores.";
    case "badentry":
      return "The device that wrote it sent something malformed; its logs say what.";
    case "nochunk":
      return "The server no longer holds its content. Restore it from a backup, or write it again from a device that still has it.";
    case "cursor":
      return "The server has lost history this device applied without starting a new epoch. Back the server up, then unlink this device and pair it again.";
    case "badpath":
      return "Rename it on this device to a name the server takes; the rule it broke is named first.";
    case "collision":
      return "Another note already has this name in a different case or form. Rename one of the two.";
    default:
      return "";
  }
}

function noteSkipped(report: SyncReport, path: string): void {
  report.skipped++;
  report.skippedPaths.push(path);
}

/** The same pairing for a path that will be tried again. */
function noteRetrying(report: SyncReport, path: string): void {
  report.retrying++;
  report.retryingPaths.push(path);
}

/**
 * Two passes' phases, added.
 *
 * The filesystem overlay adds per operation, so a run that read in two rounds
 * reports one call count and one total for reads rather than two rows nobody
 * can add up.
 */
function addPhases(a?: PassPhases, b?: PassPhases): PassPhases {
  const left = a ?? blankPhases();
  const right = b ?? blankPhases();
  const filesystemMs: Record<string, { ms: number; calls: number }> = {};
  for (const side of [left.filesystemMs, right.filesystemMs]) {
    for (const [op, seen] of Object.entries(side)) {
      const into = (filesystemMs[op] ??= { ms: 0, calls: 0 });
      into.ms += seen.ms;
      into.calls += seen.calls;
    }
  }
  return {
    listMs: left.listMs + right.listMs,
    decideMs: left.decideMs + right.decideMs,
    transferMs: left.transferMs + right.transferMs,
    saveMs: left.saveMs + right.saveMs,
    journalCompareMs: left.journalCompareMs + right.journalCompareMs,
    filesystemMs,
    // Not summed: `a` is the accumulated report and `b` is one more round.
    rounds: (a === undefined ? 0 : left.rounds) + right.rounds,
  };
}

/** A fresh set of phase totals, all zero. */
function blankPhases(): PassPhases {
  return {
    listMs: 0,
    decideMs: 0,
    transferMs: 0,
    saveMs: 0,
    journalCompareMs: 0,
    filesystemMs: {},
    rounds: 1,
  };
}

function emptyReport(): SyncReport {
  return {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    conflicted: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
    restored: 0,
    foldersCreated: 0,
    unchanged: 0,
    waiting: 0,
    retrying: 0,
    skipped: 0,
    skippedPaths: [],
    retryingPaths: [],
    heldBack: 0,
    heldBackPaths: [],
    ignored: 0,
    blocked: 0,
    inTheWay: [],
    needsAttention: [],
    chunksSent: 0,
    reusedChunks: 0,
    bytesSent: 0,
  };
}

interface Retry {
  count: number;
  error: string;
  /** Not before this time. */
  at: number;
}

/**
 * The server's word about a path, plus the spelling the server has for it.
 *
 * `wire` is set only while the two differ, which is only for a vault an older
 * Mac client wrote: it spelled every accented name in NFD, so the server holds
 * `café.md` under a spelling no other device produces. This device files that
 * note under its NFC name, and remembers the other one so the next upload can
 * say which name it used to have. Without that the upload is a second note
 * with a name nobody can tell from the first.
 */
type Remote = RemoteState & { readonly wire?: string; readonly heads?: Record<string, number> };

function spellingHeads(
  prior: Remote | undefined,
  path: string,
  wire: string,
  uid: number,
): Pick<Remote, "wire" | "heads"> {
  if (wire === path && !prior?.heads && !prior?.wire) return {};
  return {
    ...(wire !== path ? { wire } : {}),
    heads: { ...prior?.heads, ...(prior ? { [prior.wire ?? path]: prior.uid } : {}), [wire]: uid },
  };
}

function pathBase(state: Remote | undefined, path: string, basedOn: number | undefined): number {
  if (basedOn !== undefined && state && state.uid !== basedOn)
    throw new ProtocolError("stale", "The path changed while preparing this write.");
  if (!state?.wire) return basedOn ?? 0;
  const head = state.heads?.[path];
  return typeof head === "number" ? head : 0;
}

export class Engine {
  private readonly entries = new Map<string, IndexEntry>();
  /** The server's newest word per plaintext path. */
  private readonly remote = new Map<string, Remote>();
  /** Plaintext paths with inbound work outstanding. */
  private readonly pending = new Set<string>();
  private readonly retries = new Map<string, Retry>();
  /**
   * Paths written off, and what the file looked like when they were. Kept
   * apart from `retries` on purpose, because a file that can never work and a
   * file that failed once want opposite treatment.
   *
   * The fingerprint is the point. "Permanent" describes the file, not the
   * path, and a file can be changed: somebody whose note is refused for being
   * too large shortens it. Without the fingerprint the path stayed written
   * off until the application restarted, and nothing said so.
   */
  private readonly skipped = new Map<string, { why: string; fingerprint: string }>();

  /**
   * Paths from other devices this one will not act on, and why. Counted as
   * skipped in every report, since a person may want to know, and never
   * retried, since nothing about them changes by waiting.
   */
  private readonly refusedInbound = new Map<string, string>();

  /**
   * Paths the server refused as `stale`, and how many times in a row (R083-01).
   *
   * A stale refusal means the server's head for this path is not the version
   * this device based its write on, and the ordinary way to learn the new head
   * is the batch that carries it. There is one head this device is never sent:
   * its own. A device's own write comes back as an empty batch, the cursor
   * advance without the payload, so if the acknowledgement is lost after that
   * echo was applied, the cursor is past the entry, catch-up will never replay
   * it, and `remote` keeps the version before it for ever. Every upload of that
   * path is then refused, including every later edit, and the retry is
   * immediate because `stale` sets `again` rather than a backoff.
   *
   * So a refusal puts the path in here and the next round asks the server what
   * the head actually is, once, before deciding again. The count is what stops
   * that becoming its own loop: a path refused this many times running has not
   * been helped by asking, and it goes to the ordinary retry backoff with a
   * reason a person can read.
   */
  private readonly staleHeads = new Map<string, number>();

  /**
   * Whether this sync has already abandoned a walk to publish the open note.
   *
   * Per sync rather than per round, because the cost being bounded is the
   * re-listing the next round does. See the yield in `pass`.
   */
  private yieldedThisSync = false;

  /**
   * How many times each path has been refused since it last settled, carried
   * across the ask.
   *
   * Separate from `staleHeads`, which is only the queue of paths still to ask
   * about: a path comes off that queue the moment it is asked, so nothing
   * accumulates there for a path that never comes back. This is the count, and
   * it is cleared everywhere a path settles.
   */
  private readonly asked = new Map<string, number>();

  /**
   * Paths another device syncs that this device is configured to ignore, and
   * why.
   *
   * Kept apart from `skipped` because this is not a failure (R2). Kept at all
   * for the same reason `skipped` is: without it, every pass would fetch the
   * file again to be told the same thing by the same vault.
   */
  private readonly ignoredPaths = new Map<string, string>();

  /**
   * Paths a file is standing in the way of, as of the last pass.
   *
   * Not written off, only noted: the condition belongs to the vault rather
   * than to the path, and it stops holding by itself when somebody renames
   * the file. Kept only so that the same complaint is not logged every pass.
   */
  private blocked = new Set<string>();
  /** The blocked set being built by the pass in progress. */
  private nowBlocked = new Set<string>();

  /**
   * Set once a vault that advertised streaming failed at it. See `streamScan`:
   * the plugin's streaming is a URL the webview fetches, which is verified on
   * desktop and nowhere else.
   */
  private cannotStream = false;

  /** Writes waiting to go up together. */
  private outbox: Queued[] = [];
  /** And what they cost against the server's two batch caps. */
  private outboxBudget = 0;
  private outboxFrame = 0;

  /** Versions waiting to come down together, and what they will cost to hold. */
  private inbox: Incoming[] = [];
  private inboxBytes = 0;

  /**
   * What the server said it will take, learned at the handshake, and kept so
   * a download can be held to it.
   *
   * The limits arrive at hello and were previously logged and dropped. They
   * bound what this device sends; nothing bounded what it would take. A chunk
   * list is a number the server chooses, and a device that fetches and buffers
   * however many are named runs out of memory on a corrupt row as readily as
   * on a hostile one.
   *
   * Readable because a shell has to be able to say why a file was written
   * off, and "too large" is only meaningful next to the number.
   */
  limits: ServerLimits | undefined;

  private cursor = 0;
  /**
   * The store epoch `cursor` belongs to (PLAN.md section 2.8): what the last
   * `ready` said, saved beside the cursor and sent back at the next hello.
   * Undefined until the first connection.
   */
  private epoch: string | undefined;
  /** Whether this session has already read the server's history as new. */
  private adoptedReplacedHistory = false;
  private syncing = false;
  private again = false;
  private started = false;

  constructor(private readonly opts: EngineOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private log(message: string, ...rest: unknown[]): void {
    this.opts.log?.(message, ...rest);
  }

  private activity(action: ActivityAction, path: string, copy?: string): void {
    // Diagnostics must never prevent a completed write from being recorded.
    try {
      this.opts.onActivity?.({ at: this.now(), action, path, ...(copy ? { copy } : {}) });
    } catch {
      /* optional observer */
    }
  }

  private mergeable(path: string): boolean {
    return (this.opts.mergeable ?? looksLikeText)(path);
  }

  /**
   * Chunk sizes for a file, against what this server said it would take.
   *
   * The server's ceiling was never passed. `sizesFor` takes it and defaults
   * to the client's own idea of a maximum, so a server advertising something
   * smaller was ignored and every chunk at the boundary was refused. Nothing
   * noticed because the two numbers happen to be the same, and because the
   * refusal only bites on data that does not compress.
   */
  private sizesFor(size: number, isText: boolean) {
    return sizesFor(size, isText, this.limits?.chunkMax);
  }

  private get coalesce(): boolean {
    return this.opts.coalesceWrites ?? true;
  }

  /**
   * Whether this device may merge two edits into one note (I30).
   *
   * On by default, because it is the thing this client is for. Off is for
   * somebody who would rather look at two files than trust anything to
   * combine them: merging is the only operation here that produces content
   * neither device wrote, and while it refuses everything it cannot do safely,
   * "refuses to guess" and "does not guess" are different promises.
   *
   * Off does not mean anything is lost. It means every case that would have
   * merged keeps both versions instead, which is what merging already falls
   * back to.
   */
  private get merging(): boolean {
    return this.opts.merge ?? true;
  }

  /**
   * Whether this device may send anything to the server (I29).
   *
   * A mirror holds a copy and originates nothing. What this stops is not a
   * mistake in the sync engine: a scan of a mount that came up empty, a path
   * typo, a half-restored disk are all *ordinary local changes*, and ordinary
   * local changes propagate. A device that cannot push cannot delete somebody's
   * notes on every other device by being wrong about what is on its own disk.
   *
   * It does not make the client simpler, and it was proposed on the mistaken
   * belief that it would. Downloads still land through `writePreserving`,
   * because the bytes still arrive on a disk a person may have edited.
   */
  private get sending(): boolean {
    return this.opts.readOnly !== true;
  }

  /**
   * Records a local change this device is not going to send.
   *
   * Counted and named, never silent. A mirror with local edits is a thing
   * somebody should find out about from `status` rather than by noticing years
   * later that a machine has been quietly diverging, which is the reasoning
   * that put `ignored` in the report (R2).
   *
   * Deliberately not a failure. Nothing is wrong and nothing needs fixing: the
   * device was told not to send, and did not.
   */
  private heldBack(path: string, report: SyncReport, why: string): void {
    report.heldBack++;
    if (report.heldBackPaths.length < LISTED_PATHS) report.heldBackPaths.push(path);
    this.log("held back", path, why);
  }

  /** What this device knows, for a status line that describes the vault. */
  /**
   * Whether the server is holding exactly what this device holds for one path
   * (R09).
   *
   * An affirmative answer about one file, which is what a caller reporting
   * "sent" actually needs. The alternative was to look for the path in the
   * report's `skippedPaths` and `retryingPaths`, and those are display
   * samples: sorted, de-duplicated and cut to five, because a notice naming
   * four hundred files is not a notice. Absence from a sample is not evidence
   * of anything, and the sixth failure of a pass was reported as a success.
   *
   * `synchash` is written only by `synced`, and `synced` is called only where
   * the server has acknowledged a version. So this is the acknowledgement,
   * asked about one path, and it is true for a file that was already up to
   * date as well as one this pass sent, which is the right answer to "is it
   * on the server" either way.
   */
  serverHasOurs(path: string): boolean {
    const entry = this.entries.get(path);
    if (entry === undefined || entry.folder) return false;
    return entry.syncuid > 0 && entry.synchash !== "" && entry.synchash === entry.hash;
  }

  status(): {
    cursor: number;
    files: number;
    pending: number;
    retrying: number;
    skipped: number;
    /**
     * Paths another device syncs that this one is set to ignore.
     *
     * Reported apart from `skipped` for the same reason the counter is (R2):
     * one is a failure and the other is the configuration doing as it was
     * told, and a caller reading this programmatically could not tell them
     * apart at all.
     */
    ignored: number;
    syncing: boolean;
  } {
    let files = 0;
    for (const e of this.entries.values()) if (!e.folder) files++;
    return {
      cursor: this.cursor,
      files,
      pending: this.pending.size,
      retrying: this.retries.size,
      skipped: this.skipped.size + this.refusedInbound.size,
      ignored: this.ignoredPaths.size,
      syncing: this.syncing,
    };
  }

  /**
   * Loads the index, opens the session, and drains the backlog.
   *
   * The cursor sent is this device's, from the index. Sending 0 instead would
   * work and would re-download the whole vault, and the server would refuse a
   * cursor it never issued, which is the case that catches a restored backup.
   */
  async start(): Promise<ServerLimits> {
    if (this.started) throw new Error("already started");
    this.started = true;

    // Checked in full before any of it becomes state. See stored-state.ts:
    // a store hands back whatever it parsed, and the casts below used to be
    // the only thing between a corrupt file and a wrong decision.
    const stored = validateStoredState(await this.opts.store.load());
    if (stored) {
      this.cursor = stored.cursor;
      this.epoch = stored.epoch;
      for (const [path, raw] of Object.entries(stored.entries)) {
        this.entries.set(path, unpacked(path, raw as Record<string, unknown>));
      }
      for (const [path, raw] of Object.entries(stored.remote)) {
        this.remote.set(path, raw as Remote);
      }
      for (const path of stored.pending) this.pending.add(path);
      this.log("index loaded", {
        cursor: this.cursor,
        entries: this.entries.size,
        pending: this.pending.size,
      });
    }

    const limits = await this.opts.transport.hello({
      vault: this.opts.vaultId,
      deviceId: this.opts.deviceId,
      token: this.opts.token,
      device: this.opts.device,
      cursor: this.cursor,
      epoch: this.epoch,
    });
    // A server whose history is not the one this device's cursor was read
    // from: restored from a backup, or replaced. It replays the vault from uid
    // 1, and a batch of that replay may already have been applied by now, in
    // which case this has been done once already and does nothing.
    if (this.opts.transport.historyReplaced) this.adoptReplacedHistory(limits.epoch);
    this.epoch = limits.epoch;
    // The docs present the client-ahead case as what catches a server
    // restored from an old backup or pointed at the wrong vault, and the
    // refusal lived only in the server, so it was missing exactly when it
    // was needed. A server behind this device would answer no batches, and
    // the status line reported `behind` clamped at zero, so it looked like
    // being up to date. With epochs the server replays a restored history
    // instead, so what is left here is a store rolled back without a new
    // epoch, which only a copy made behind the server's back produces.
    refuseIfBehind(limits.cursor, this.cursor);
    // A ceiling the chunker cannot cut under. `sizesFor` never goes below a
    // window's worth, so every chunk this device made would be over the
    // server's limit and refused for ever, one file at a time, with nothing
    // pointing at the server. Refused here, once, naming it.
    if (limits.chunkMax < CHUNK_FLOOR) {
      const err = new ProtocolError(
        "protostate",
        `this server takes chunks of at most ${limits.chunkMax} bytes, and this device cannot ` +
          `cut a chunk smaller than ${CHUNK_FLOOR}, so every file it sent would be refused; the ` +
          `server's chunk limit has to be at least ${CHUNK_FLOOR}`,
        { retryable: false },
      );
      this.opts.transport.close();
      throw err;
    }
    this.limits = limits;
    this.log("connected", limits);
    return limits;
  }

  /**
   * Reads the server's history as new, because it is not the one this
   * device's cursor was read from (plan/protocol.md, "Device session").
   *
   * A different epoch means the store was restored or replaced, so the uid
   * sequence may have been reissued: a uid this device remembers can name a
   * different version now, and a version this device synced may not be there
   * at all. The server replays the whole vault from uid 1, and it is read the
   * way a device that had never synced would read it. The cursor, the server's
   * word per path and the inbound work list all describe the history that is
   * gone, so they go.
   *
   * The index entries stay, because they describe the files on this disk, and
   * only their sync state is forgotten. That is the half that keeps notes. An
   * entry whose last-synced content is still what is on disk would otherwise
   * read a restored, older version as "changed on another device and
   * unchanged here" and be written over by it, and the newer text would be on
   * no server and no device. Forgotten, the two versions are compared as they
   * are: the same content is agreement, different content is kept both ways,
   * a file only here is sent, and nothing is deleted on the strength of a
   * history that has been replaced (rules 3 and 6).
   */
  private adoptReplacedHistory(epoch?: string): void {
    if (this.adoptedReplacedHistory) return;
    this.adoptedReplacedHistory = true;
    this.log("the server's history is not the one this device synced against; reading it as new", {
      was: this.epoch,
      now: epoch ?? this.opts.transport.serverLimits?.epoch,
      cursor: this.cursor,
    });
    this.cursor = 0;
    this.remote.clear();
    this.pending.clear();
    this.staleHeads.clear();
    this.asked.clear();
    for (const entry of this.entries.values()) {
      entry.synchash = "";
      entry.syncuid = 0;
      entry.synctime = 0;
    }
  }

  /**
   * Takes a batch from the transport into the remote index.
   *
   * Wired to the transport's `onBatch`. The transport has already checked that
   * the range continues this device's cursor, so what is left here is checking
   * the entries and remembering that these paths have work outstanding.
   *
   * A batch with no entries is this device's own write coming back: it carries
   * the cursor advance and nothing to apply.
   */
  async acceptBatch(batch: { from: number; to: number; entries: WireEntry[] }): Promise<void> {
    // The first batch of a replayed history can arrive before `start` has
    // heard its `ready`, and it is read against a fresh listing either way.
    if (this.opts.transport.historyReplaced) this.adoptReplacedHistory();
    // Staged, then committed once every entry has passed its checks. Applied
    // entry by entry, a batch that failed part way through left the entries
    // before the failure recorded and no way to undo them, and `save()`
    // persists `remote` and `pending`, so they survived the session dying.
    // `deleteLocal` needs no server, so a batch of [deletion, malformed entry]
    // applied the deletion on the next pass while the connection died looking
    // like a misconfiguration. "The session ended safely" is not "nothing was
    // applied" unless the state is committed together, so the whole batch is
    // checked before anything is touched.
    for (const e of batch.entries) checkEntryShape(e);

    // The spelling the sender used, and the one this device files it under.
    // They differ only when a peer spells a name in a Unicode normal form
    // that is not NFC, which the server refuses, so for a Trew server they
    // are always the same; the fold is kept because it is the one place a
    // path off the wire becomes an identity here.
    const wires = batch.entries.map((e) => e.path);
    const paths = wires.map(canonicalSpelling);
    const olds = batch.entries.map((e) => (e.prev ? e.prev : undefined));

    const staged = new Map<string, Remote>();
    for (let at = 0; at < batch.entries.length; at++) {
      const e = batch.entries[at]!;
      const path = paths[at]!;
      const wire = wires[at]!;
      // A name this device would never list, or would list as a different
      // string, is refused: written, `a//b` would be invisible to the next
      // scan as `a//b` and reported deleted, and the engine keys its whole
      // idea of a file on the string, so two spellings of one file would be
      // two entries here and one file there. A peer that is wrong about one
      // path is still the vault, so this ends nothing.
      //
      // Refused in the pass rather than here, because a refusal decided here
      // lived only in memory: the version was dropped on the floor, so a
      // restart forgot both the refusal and the fact that anything had been
      // refused, and the panel's count of written-off paths silently reset
      // (R083-04, rule 7). Staged, the version persists in the state file
      // like any other, the pass re-decides it from a pure function of the
      // name, and the report says the same thing after a restart as before.
      //
      // Except a name that cannot be a key at all. The empty path is not a
      // path (`isPath`), so a state file containing one is refused on load,
      // and staging it would make this device unable to read its own index.
      if (path === "" || path.includes("\0")) {
        const why = refusedInboundPath(path) ?? "a path containing a NUL byte";
        if (!this.refusedInbound.has(path)) {
          this.log("refused a path from another device", path, why);
        }
        this.refusedInbound.set(path, why);
        continue;
      }
      staged.set(path, {
        uid: e.uid,
        folder: e.folder,
        deleted: e.deleted,
        mtime: e.mtime,
        size: e.size,
        hash: contentId(e.chunks),
        // The sender's spelling, kept only while it is not the one this
        // device uses (R10). It is what the next upload of this path names
        // as the path it used to have, so the correction travels as a
        // rename rather than as a second note.
        ...spellingHeads(staged.get(path) ?? this.remote.get(path), path, wire, e.uid),
      });

      if (e.prev) {
        // A rename travels as one operation, so nothing tells this
        // device the old path is gone except this field. Recorded as a
        // deletion of the old path, which is what it is, and which lets
        // the decision table handle the awkward case for free: if the
        // old path was edited here since the last sync, a deletion loses
        // to an edit and the file is kept and re-uploaded.
        const old = canonicalSpelling(olds[at]!);
        // Unless the two names are one name. A peer correcting the
        // spelling of a path sends exactly that: `café.md` in NFC, moved
        // from `café.md` in NFD. Staged as written, the deletion of the
        // old name lands on the same key as the arrival of the new one
        // and whichever went in last decided whether the note existed
        // (R10). `renamed` refuses a rename to itself for the same
        // reason, one layer up.
        if (old !== path) {
          staged.set(old, {
            uid: e.uid,
            folder: false,
            deleted: true,
            mtime: e.mtime,
            size: 0,
            hash: "",
            ...spellingHeads(staged.get(old) ?? this.remote.get(old), old, olds[at]!, e.uid),
          });
        } else {
          const state = staged.get(path)!;
          staged.set(path, { ...state, heads: { ...state.heads, [olds[at]!]: e.uid } });
        }
      }
    }

    for (const [path, state] of staged) {
      this.remote.set(path, state);
      this.pending.add(path);
    }
    this.cursor = batch.to;
  }

  /**
   * Runs one reconciliation pass, and only one.
   *
   * A request arriving while a pass is running sets a flag and the pass runs
   * again when it finishes, which is Obsidian's `requestSync`. Starting a
   * second pass concurrently would have two of them deciding about the same
   * file from the same index.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncReport> {
    if (this.syncing) {
      this.again = true;
      return emptyReport();
    }
    this.syncing = true;
    this.again = false;
    this.yieldedThisSync = false;
    try {
      if (opts.retryFailures || opts.verifyContents) {
        const now = this.now();
        for (const retry of this.retries.values()) retry.at = Math.min(retry.at, now);
      }
      let report = await this.pass(opts);
      let rounds = 1;
      while (this.again && rounds < 8 && !this.opts.transport.isClosed) {
        this.again = false;
        await this.opts.transport.drainReceived();
        // Before the round, so a round that only exists because of a stale
        // refusal has something new to decide from (R083-01). A round that
        // re-decides from the same `remote` reaches the same conclusion and is
        // refused again, which is the loop this whole mechanism is about.
        await this.refreshStaleHeads(report);
        const next = await this.pass(opts);
        report = combinePasses(report, next);
        rounds++;
      }
      if (this.again) {
        report.waiting = Math.max(report.waiting, 1);
        // Not `now` (R083-02). The client turns this into its next timer, and
        // zero means the whole vault is re-decided as fast as the disk allows
        // for as long as whatever set `again` keeps setting it.
        report.nextUploadAt = this.now() + AGAIN_FLOOR_MS;
        delete report.appliedCursor;
      }
      return report;
    } finally {
      this.opts.releaseUploadTransport?.();
      this.syncing = false;
    }
  }

  /**
   * `refusedInboundPath`, remembered.
   *
   * The answer is a pure function of the string, and the pass asks it about
   * every path in the vault on every pass. Asked directly it is two splits and
   * two walks of the segments per path, which measured as 4 to 6% of a settled
   * pass at four thousand notes: the whole cost of a check that says no to
   * approximately nothing.
   *
   * Pruned against the sets the index keeps, so a vault that churns through
   * names does not accumulate answers about paths nothing refers to any more.
   */
  private refusedName(path: string): string | undefined {
    const known = this.refusalOf.get(path);
    if (known !== undefined) return known.why;
    const why = refusedInboundPath(path);
    this.refusalOf.set(path, { why });
    return why;
  }

  private readonly refusalOf = new Map<string, { why: string | undefined }>();

  /**
   * Asks the server for the current version of every path it refused as stale,
   * and folds the answer into `remote` (R083-01).
   *
   * The one head a device is never sent is its own. A device's own write comes
   * back as an empty batch, the cursor advance without the payload, so an
   * acknowledgement lost after that echo has been applied leaves the cursor
   * past an entry this device will never be shown: catch-up starts above it,
   * `remote` keeps the version before it for ever, and every upload of that
   * path is refused as out of date. Including every later edit of it, which is
   * how a note stops leaving this device while the panel says it is waiting.
   *
   * Asking is the only thing that breaks that, because the missing fact is one
   * the fan-out will never carry. `history` with a limit of one is the ask, the
   * answer is checked exactly as a batch entry is, and no cursor moves.
   *
   * Under the server's own spelling where that differs, since the name this
   * device files a note under need not be the name the server has (`Remote.wire`).
   *
   * A failure is recorded against the path rather than thrown: this runs
   * between rounds of a sync that is already under way, and one path that
   * cannot be asked about must not end the pass for the rest of the vault.
   */
  private async refreshStaleHeads(report: SyncReport): Promise<void> {
    if (this.staleHeads.size === 0 || this.opts.transport.isClosed) return;
    for (const [path, refusals] of [...this.staleHeads]) {
      // Asked, so it comes off the queue. The next refusal of this path puts
      // it back with its count carried in `asked`, and a path that leaves by
      // any other route, a deletion, a conflict copy, a prune, leaves nothing
      // behind to ask about on every round of every sync for the session.
      this.staleHeads.delete(path);
      this.asked.set(path, refusals);
      const known = this.remote.get(path);
      const wire = known?.wire ?? path;
      try {
        const [newest] = await this.opts.transport.history(wire, { limit: 1 });
        if (newest === undefined) {
          // The server holds no version of this path at all: purged, or a
          // vault restored from before it existed. The next decision is made
          // against no remote version rather than against one that is gone.
          this.remote.delete(path);
          this.pending.delete(path);
          continue;
        }
        // The check a batch entry gets, and one the batch path does not need:
        // a batch says which path each entry is for, and an answer to a
        // question does not, so a version of another note would otherwise be
        // recorded as this path's head.
        checkEntryShape(newest);
        if (newest.path !== wire) {
          throw new Error(
            `the server answered a request for the newest version of ${path} with a version of ` +
              `another note, so the current version of this path is still not known here`,
          );
        }
        if (known !== undefined && newest.uid <= known.uid) continue;
        this.remote.set(path, {
          uid: newest.uid,
          folder: newest.folder,
          deleted: newest.deleted,
          mtime: newest.mtime,
          size: newest.size,
          hash: contentId(newest.chunks),
          ...spellingHeads(known, path, wire, newest.uid),
        });
        this.pending.add(path);
        this.log("asked the server which version of a refused path it holds", path, {
          was: known?.uid ?? 0,
          now: newest.uid,
        });
      } catch (err) {
        this.recordFailure(path, err, report);
      }
    }
  }

  /** A content-based estimate. Sync rechecks all decisions before writing. */
  async preview(stats?: FileStat[]): Promise<SyncPreview> {
    const remote = new Map(this.remote);
    const preview: SyncPreview = { cursor: this.cursor, files: [] };
    const disk = new Map(
      (stats ?? (await this.opts.vault.list())).map((stat) => [stat.path, stat]),
    );
    const moving = new Set(
      [...this.entries].flatMap(([path, entry]) =>
        entry.prev && disk.has(path) && !disk.has(entry.prev) ? [entry.prev] : [],
      ),
    );
    for (const path of new Set([...disk.keys(), ...remote.keys(), ...this.entries.keys()])) {
      if (moving.has(path)) continue;
      const stat = disk.get(path);
      const other = remote.get(path);
      if (stat?.folder || other?.folder || this.entries.get(path)?.folder) continue;
      const stored = this.entries.get(path);
      const index = stored ? { ...stored, chunks: [...stored.chunks] } : newEntry(path);
      let action: PreviewAction;
      try {
        if (stat) {
          observe(index, stat);
          if (stat.size > this.limitOn("perFileMax")) throw new Error("File too large");
          // The same cache the pass honours, for the same reason. This used
          // to read, chunk and name every file on disk unconditionally, and
          // then throw the work away: `index` is a copy, so the fresh hashes
          // went nowhere and the pass that followed did it all again. A
          // folder deletion on a 5,000-note phone vault therefore read the
          // whole vault twice before the dialog appeared (R083-08).
          //
          // The comment that stood here said a preview must not hide a
          // same-stat edit. It must not, and `changeId` is what catches one
          // where the adapter has it. Where it does not, `dirty` does: an
          // editor that saved a note told this device so, and that is exactly
          // the edit a stat cannot see.
          if (
            this.dirty.has(path) ||
            needsRehash(index, Math.ceil(stat.mtime), stat.size, stat.changeId)
          ) {
            await this.rehash(index, path, stat.size);
          }
        }
        const local = stat
          ? { folder: false, mtime: index.mtime, size: index.size, hash: index.hash }
          : undefined;
        const kind = decide({ local, remote: other, index, mergeable: this.mergeable(path) }).kind;
        action =
          kind === "nothing"
            ? "unchanged"
            : kind === "conflict"
              ? "copy"
              : kind === "deleteLocal"
                ? "delete-local"
                : kind === "deleteRemote"
                  ? "delete-server"
                  : kind === "restoreLocal"
                    ? "download"
                    : kind === "upload" || kind === "download" || kind === "merge"
                      ? kind
                      : "blocked";
        if (!this.sending && (action === "upload" || action === "delete-server"))
          action = "held-back";
        // The refusal from the name, not from the map: a restart has the
        // version back from the state file before it has run a pass to
        // refuse it again, and a preview run in between must not offer to
        // download a name this device will never write (R083-04).
        if (
          this.ignoredPaths.has(path) ||
          this.skipped.has(path) ||
          refusedInboundPath(path) !== undefined
        )
          action = "blocked";
      } catch {
        action = "blocked";
      }
      preview.files.push({ path, action });
    }
    return preview;
  }

  private firstSyncConfirmed = false;
  private readonly approvedDeletions = new Set<string>();

  private async confirmWork(stats: FileStat[]): Promise<void> {
    const disk = new Map(stats.map((stat) => [stat.path, stat]));
    const first =
      !this.firstSyncConfirmed &&
      this.opts.confirmFirstSync &&
      ![...this.entries.values()].some((entry) => entry.syncuid > 0) &&
      stats.some((stat) => !stat.folder) &&
      [...this.remote.values()].some((entry) => !entry.deleted && !entry.folder);
    const removedFolders = this.opts.confirmDeletions
      ? [...new Set([...this.entries.keys(), ...this.remote.keys()])].filter(
          (path) =>
            (this.remote.get(path)?.folder && this.remote.get(path)?.deleted && disk.has(path)) ||
            (this.sending &&
              this.entries.get(path)?.folder &&
              !disk.has(path) &&
              !this.remote.get(path)?.deleted),
        )
      : [];
    if (!first && !removedFolders.length) return;
    const preview = await this.preview(stats);
    if (first) {
      if (!(await this.opts.confirmFirstSync!(preview)))
        throw new Error("First sync paused for review.");
      this.firstSyncConfirmed = true;
    }
    const deletes = preview.files.filter(
      (file) => file.action === "delete-local" || file.action === "delete-server",
    );
    // Confirm a whole folder's files, not ordinary individual note deletions.
    if (
      !removedFolders.some(
        (folder) => deletes.filter((file) => file.path.startsWith(`${folder}/`)).length > 1,
      )
    )
      return;
    const key = JSON.stringify(
      deletes.map((file) => [file.path, file.action, this.remote.get(file.path)?.uid]).sort(),
    );
    if (this.approvedDeletions.has(key)) return;
    if (!(await this.opts.confirmDeletions!(preview)))
      throw new Error("Folder deletion paused for review.");
    if (this.cursor !== preview.cursor)
      throw new Error("Server changes arrived during review. Review the updated deletion plan.");
    this.approvedDeletions.clear();
    this.approvedDeletions.add(key);
  }

  private async pass(opts: SyncOptions = {}): Promise<SyncReport> {
    const report = emptyReport();
    // One closure per pass, captured once. `phases` stays undefined when
    // timing is off, and `into` returns immediately, so the cost of carrying
    // this is one property read and one comparison per boundary.
    const phases = this.opts.timing ? blankPhases() : undefined;
    let mark = phases === undefined ? 0 : performance.now();
    const into = (term: "listMs" | "decideMs" | "transferMs" | "saveMs"): void => {
      if (phases === undefined) return;
      const at = performance.now();
      phases[term] += at - mark;
      mark = at;
    };
    const now = this.now();
    const coalesce = opts.coalesceWrites ?? this.coalesce;

    // Both queues empty at the end of every pass that returns. One that
    // threw on its way out leaves them full, and carrying that into the next
    // pass would commit those writes against a report nobody reads, so the
    // pass that did the work would say it did none and `settle` would stop.
    //
    // Dropping them is safe and is the reason this is a discard rather than
    // a flush. Nothing queued was acknowledged, so no entry was marked
    // synced and no file was written; reconciliation sees the same
    // divergence again and queues the same work.
    if (this.outbox.length > 0 || this.inbox.length > 0) {
      this.log("a pass ended early, discarding what it had queued", {
        writes: this.outbox.length,
        reads: this.inbox.length,
      });
      this.outbox = [];
      this.outboxBudget = 0;
      this.outboxFrame = 0;
      this.inbox = [];
      this.inboxBytes = 0;
    }

    let stats = await this.opts.vault.list({
      forceFull: opts.verifyContents === true || opts.forceFullScan === true,
    });
    let onDisk = new Map(stats.map((s) => [s.path, s]));
    // Never turn a cached absence into a deletion of a restored file. Check
    // before this pass writes anything: later, a case-only rename or a folder
    // replacing a deleted file can legitimately occupy the old physical path.
    // Full reconciliation decides those cases from the refreshed inventory.
    const omittedRefusals = new Map<string, unknown>();
    let refreshed = false;
    for (const [path, entry] of this.entries) {
      if (onDisk.has(path) || (entry.synchash === "" && entry.synctime <= 0)) continue;
      try {
        if ((await this.opts.vault.exists(path)) && !refreshed) {
          stats = await this.opts.vault.list({ forceFull: true });
          onDisk = new Map(stats.map((s) => [s.path, s]));
          refreshed = true;
        }
      } catch (err) {
        const code = (err as { code?: string })?.code;
        // Excluded is not absent. Route explicit path refusals through the
        // ordinary reporting below; an unreadable presence check still stops
        // the pass. Check every omitted entry, even after a forced rescan.
        if (code !== "ignored" && code !== "neversync") throw err;
        omittedRefusals.set(path, err);
      }
    }
    into("listMs");
    await this.confirmWork(stats);
    const dirty = new Set(this.dirty);
    this.dirty.clear();
    for (const stat of stats) {
      const entry = this.entryFor(stat.path);
      if (dirty.has(stat.path) || opts.verifyContents) {
        entry.hash = "";
        entry.chunks = [];
      }
      observe(entry, stat);
    }
    const moving = new Set<string>();
    for (const [to, entry] of this.entries) {
      if (!entry.prev || entry.folder) continue;
      const from = canonicalSpelling(entry.prev);
      if (from === to) continue;
      if (onDisk.has(from))
        entry.prev = ""; // a new file now occupies the source
      else if (this.sending && onDisk.has(to)) moving.add(from);
    }

    // Paths that are files, so a path whose parent is one can be spotted
    // before anything tries to create a folder there. A real filesystem
    // answers ENOTDIR, which is not a condition that improves with retrying,
    // and the retry is where this used to spend the rest of the session.
    const filePaths = new Set<string>();
    for (const [path, stat] of onDisk) {
      if (!stat.folder) filePaths.add(path);
    }
    const nowBlocked = new Set<string>();
    this.nowBlocked = nowBlocked;

    // Paths the vault left out of the listing because two names on disk claim
    // them, with the sentence that names both.
    //
    // Read right after the listing and from the same pass, because a path in
    // neither is a path the engine would report deleted: the vault can see
    // both files and omitting them with nothing said would have this device
    // tell the server a note it is looking at is gone, on the strength of a
    // spelling. Nothing syncs under such a path and nothing under it either,
    // since a folder two names claim has no unambiguous path inside it
    // (cli/vault-spelling.test.ts, "blocks the one name two files claim and
    // syncs the rest of the vault").
    const ambiguous = new Map<string, string>();
    for (const clash of this.opts.vault.ambiguous?.() ?? []) {
      ambiguous.set(
        clash.path,
        `${clash.spellings.map((s) => `"${spellOut(s)}"`).join(" and ")} are one name here, ` +
          `and only one of them can sync.`,
      );
    }

    // What the disk will file each local path under, for the collision
    // check in `fill`. Worked out here, once per pass, from the same listing
    // the decisions are made from.
    this.localByIdentity = new Map();
    for (const path of onDisk.keys()) this.localByIdentity.set(this.identity(path), path);
    this.deletingThisPass = new Set();

    // 2. Every path either side knows about, plus the ones the vault could
    //    not name. A clash between two brand new files is in no index and on
    //    neither side, and left out of this set it would be refused in
    //    silence, which is the one thing a refusal that waits on a person
    //    must not be.
    const paths = new Set<string>([
      ...onDisk.keys(),
      ...this.entries.keys(),
      ...this.remote.keys(),
      ...ambiguous.keys(),
    ]);

    const active = this.opts.activePath?.();
    const priority = (path: string) =>
      onDisk.get(path)?.folder || this.remote.get(path)?.folder
        ? 0
        : looksLikeText(path)
          ? path === active
            ? 1
            : 2
          : 3;
    const ordered = [...paths]
      .map((path) => ({ path, priority: priority(path) }))
      .sort((a, b) => a.priority - b.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let previousPriority = 0;
    let visitedActive = false;
    let activeRemoteUid: number | undefined;
    for (const { path, priority } of ordered) {
      // Yield background preparation at a file boundary when the open note changes.
      // Already pending work may be refused or backing off; only a new revision
      // should interrupt unrelated files. Keep the refusal visible in pending.
      //
      // Once per sync, not once per round (R083-11). The yield discards the
      // ordered walk and the round after it lists the vault and re-decides
      // every path from the start, so a save per round is a whole re-decision
      // per save: somebody typing through a first sync on a phone spent more
      // on re-listing five thousand notes than on the sync. Worse, with a
      // steady typist the pass never got past the point it kept yielding at,
      // because every round threw away the same prefix of work.
      //
      // One interruption buys what the yield is for, which is a save reaching
      // the server without waiting out a scan of the whole vault, and bounds
      // the cost of it at one extra listing. A save made after that is picked
      // up by the next sync, a second later.
      const latestActiveUid = active ? this.remote.get(active)?.uid : undefined;
      if (
        active &&
        visitedActive &&
        !this.yieldedThisSync &&
        (this.dirty.has(active) ||
          (latestActiveUid !== undefined &&
            latestActiveUid !== activeRemoteUid &&
            latestActiveUid > (this.entries.get(active)?.syncuid ?? 0)))
      ) {
        this.yieldedThisSync = true;
        this.again = true;
        break;
      }
      if (path === active) {
        visitedActive = true;
        activeRemoteUid = this.remote.get(path)?.uid;
      }
      if (moving.has(path)) continue; // the conditional rename retires its source
      // Refused for what the name is, not for anything that happened to it,
      // so it is decided here from the name rather than remembered from the
      // batch that carried it (R083-04). The version stays in `remote` and
      // the path stays in `pending`, both of which persist, so the refusal
      // and its count survive a restart. Nothing is written and nothing is
      // fetched: there is no local file to compare and no name to write to.
      // Only for a name the listing did not produce. A path on disk was
      // listed by the vault, and both adapters apply the dot rule and hand
      // back names a filesystem filed, so it cannot be one of these; `remote`
      // is the only place a non-canonical name can come from. Asking about
      // every path in the vault instead was 1.3 s of samples in a profile of
      // a settled pass, for a question whose answer is no for all of them.
      const refused = onDisk.has(path) ? undefined : this.refusedName(path);
      if (refused !== undefined) {
        if (this.refusedInbound.get(path) !== refused) {
          this.log("refused a path from another device", path, refused);
        }
        this.refusedInbound.set(path, refused);
        // Owed nothing, for the reason an ignored path is owed nothing: it
        // will never be fetched and never be written, so leaving it on the
        // inbound work list is a device reporting work it has decided not to
        // do. It also has to leave, or the record can never go: `prune` keeps
        // a deleted path that anything is still pending on, and the way a
        // vault recovers from a peer that wrote `a//b.md` is that peer
        // renaming it, which arrives as a deletion of exactly this path.
        this.pending.delete(path);
        noteSkipped(report, path);
        continue;
      }
      if (previousPriority > 0 && priority > previousPriority) {
        // Publish the current note before background notes, and all notes
        // before attachments. A slow file must not hold an interactive edit
        // in an unflushed batch. Every batch retains the same safety checks.
        into("decideMs");
        await this.fill(report);
        await this.flush(report);
        into("transferMs");
      }
      previousPriority = priority;
      if (omittedRefusals.has(path)) {
        this.recordFailure(path, omittedRefusals.get(path), report);
        continue;
      }
      if (this.ignoredPaths.has(path)) {
        // Settled, and settled by the person who configured this device. It
        // is counted every pass so it stays visible, and nothing is fetched
        // to find out what is already known.
        //
        // Dropped from the work list, because there is no work: it was left
        // there, so `trew status` reported an ignored folder as "N files
        // with work outstanding" for the rest of the vault's life. Rule 7,
        // and the counter above is where an ignored path is meant to show.
        this.pending.delete(path);
        report.ignored++;
        continue;
      }
      const skip = this.skipped.get(path);
      if (skip) {
        if (fingerprintOf(this.entries.get(path)) === skip.fingerprint) {
          noteSkipped(report, path);
          continue;
        }
        // Changed since it was written off. Whatever was wrong with it
        // may not be any more, and the only way to find out is to try.
        this.skipped.delete(path);
        this.log("skipped file changed, trying again", path);
      }
      // This path, or a folder above it, is one two names on disk claim.
      // Both are left where they are and nothing moves under the name until
      // a person renames one, which is the only outcome that keeps both
      // notes. Worked out fresh every pass, like the clash below and for the
      // same reason: the moment one of them is renamed there is nothing here
      // to notice, so a remembered refusal would never clear.
      const claimed = ambiguous.has(path)
        ? path
        : parents(path).find((ancestor) => ambiguous.has(ancestor));
      if (claimed !== undefined) {
        const why = ambiguous.get(claimed)!;
        nowBlocked.add(path);
        if (!this.blocked.has(path)) this.log("cannot be both", path, why);
        report.blocked++;
        if (report.inTheWay.length < LISTED_PATHS) {
          report.inTheWay.push({ path, blockedBy: claimed, why });
        }
        continue;
      }

      const blockedBy = parents(path).find((ancestor) => filePaths.has(ancestor));
      if (blockedBy !== undefined && !onDisk.has(path)) {
        // Something upstream is a file where this path needs a folder.
        // Nothing can be written here until somebody renames one of
        // them, and a real filesystem answers ENOTDIR, which does not
        // improve with retrying.
        //
        // Worked out fresh every pass rather than remembered. There is
        // no local file here to notice a change in, so a remembered
        // refusal would have nothing to clear it: the first version of
        // this kept the path written off after the blocker was renamed
        // away, and the note never arrived.
        nowBlocked.add(path);
        if (!this.blocked.has(path)) {
          this.log("cannot be both", path, `${blockedBy} is a file here and a folder elsewhere`);
        }
        report.blocked++;
        if (report.inTheWay.length < LISTED_PATHS) {
          report.inTheWay.push({ path, blockedBy });
        }
        continue;
      }

      const retry = this.retries.get(path);
      if (retry && retry.at > now) {
        noteRetrying(report, path);
        report.nextUploadAt = Math.min(report.nextUploadAt ?? Infinity, retry.at);
        continue;
      }
      try {
        this.opts.onProgress?.(path);
        await this.reconcile(path, onDisk.get(path), report, now, coalesce);
        this.retries.delete(path);
      } catch (err) {
        this.recordFailure(path, err, report);
      }
    }

    // Whatever is still queued moves now. Until these return, no write in
    // this pass has been acknowledged and no queued file is on disk.
    //
    // `wroteThisPass` is not cleared here. `receive` already fills a full
    // inbox part way through the loop, and those writes are the ones
    // `applyDeletes` has to know about: clearing the list before the final
    // fill forgot every file written by an earlier one, so a case-only rename
    // arriving in a pass with more than a batch of downloads deleted the file
    // it had just written. The reset after the deletes is the one that counts.
    into("decideMs");
    await this.fill(report);
    await this.applyDeletes(report);
    this.wroteThisPass = [];
    await this.flush(report);
    into("transferMs");

    this.opts.onProgress?.(undefined);
    // The ones the walk cannot reach, which is the empty path and anything
    // else `isPath` will not have as a key: those are refused at accept and
    // never staged, so nothing in `remote` names them and the loop above never
    // sees them. Everything else was counted where it was refused.
    for (const [path] of this.refusedInbound) {
      if (!this.remote.has(path)) noteSkipped(report, path);
    }
    // Sorted and capped once, here, after everything that could add to it.
    // Sorted because the plugin keys its notice on the names and the same set
    // reached in a different order is the same set; capped for the reason
    // above the constant.
    report.skippedPaths = [...new Set(report.skippedPaths)].sort().slice(0, LISTED_PATHS);
    report.retryingPaths = [...new Set(report.retryingPaths)].sort().slice(0, LISTED_PATHS);

    // Replaced rather than added to, so a path stops being blocked the
    // moment the file in its way is gone.
    this.blocked = nowBlocked;

    into("decideMs");
    this.prune(onDisk);
    // Before the index, always. The index names notes, so it must not be
    // durable ahead of them; a vault that defers any part of a write makes it
    // durable here. Rule 3 in another form.
    await this.opts.vault.flush?.();
    await this.save();
    if (
      this.pending.size === 0 &&
      report.waiting === 0 &&
      report.retrying === 0 &&
      report.skipped === 0 &&
      report.blocked === 0 &&
      // Not `ignored`. A path this device was configured to skip is settled,
      // by the person who configured it, and no later pass will change that.
      // Counting it as outstanding meant a phone that skips one attachment
      // folder never reported an applied cursor again: `applied` was never
      // sent, so every other device said "Waiting for Phone" for the life of
      // the vault, and polled it at a second to keep saying so (Codex-10).
      //
      // "Waiting" and "not coming" are different answers and the first one was
      // wrong. What the count still is, and what the panel still says, is that
      // N paths are not synced here; that is this device's business and it is
      // on this device's screen. What goes to the other devices is how far
      // through the log this one has got, which is all `applied` ever meant.
      report.heldBack === 0 &&
      report.conflicted === 0 &&
      [...this.remote].every(
        ([path, remote]) =>
          // A path this device was told to skip has no entry and never will,
          // so measuring it against one is asking whether a decision has
          // finished happening (Codex-10). It is counted and named as ignored
          // on this device's own screen, which is where it belongs.
          this.ignoredPaths.has(path) || (this.entries.get(path)?.syncuid ?? -1) >= remote.uid,
      )
    ) {
      report.appliedCursor = this.cursor;
    }
    report.needsAttention = this.attentionList(report);
    if (phases !== undefined) {
      into("saveMs");
      report.phases = phases;
    }
    return report;
  }

  /**
   * The four maps, rendered as the one list a person reads.
   *
   * Built here, at the end of a pass, because `inTheWay` is still being added
   * to by `refuseAliases` and `applyDeletes` until then, and a list assembled
   * halfway through would be missing whichever refusal came last.
   *
   * Every entry carries a whole sentence, including what to do, because a
   * reason a person cannot act on is a category with extra words. The two
   * blocked kinds ask for different things and say so: two spellings of one
   * name are both on this device, so the rename is here, while a file here and
   * a folder elsewhere is waiting on whichever device meant the other thing.
   *
   * Deduplicated by path, since a path can be blocked and written off at once,
   * and blocked is the one that clears itself. Bounded per source, for the
   * reason on the field.
   */
  private attentionList(report: SyncReport): { path: string; why: string }[] {
    const out: { path: string; why: string }[] = [];
    const said = new Set<string>();
    const add = (path: string, why: string) => {
      if (said.has(path)) return;
      said.add(path);
      out.push({ path, why });
    };

    for (const blocked of report.inTheWay) {
      add(
        blocked.path,
        blocked.why === undefined
          ? `"${blocked.blockedBy}" is a file here and a folder on another device. ` +
              `Rename one of them, on whichever device meant the other thing.`
          : `${blocked.why} Rename one of them here; nothing syncs under that name until you do.`,
      );
    }
    for (const path of report.skippedPaths) {
      // The reason is in whichever map wrote the path off. `refusedInbound` is
      // counted as skipped in every report and has its own map, so both are
      // asked; a path in neither is one a pass recorded and then cleared, and
      // a bare path with no sentence is worse than no line.
      const why =
        this.skipped.get(path)?.why ?? this.refusedInbound.get(path) ?? refusedInboundPath(path);
      if (why !== undefined) add(path, why);
    }
    return out;
  }

  private entryFor(path: string): IndexEntry {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = newEntry(path);
      this.entries.set(path, entry);
    }
    return entry;
  }

  private readonly dirty = new Set<string>();

  /** An event invalidates content even when size and timestamps are unchanged. */
  noteChanged(path: string): void {
    const canonical = canonicalSpelling(path);
    this.dirty.add(canonical);
    const retry = this.retries.get(canonical);
    if (retry) retry.at = Math.min(retry.at, this.now());
    if (this.syncing) this.again = true;
  }

  private async reconcile(
    path: string,
    stat: FileStat | undefined,
    report: SyncReport,
    now: number,
    coalesce: boolean,
  ): Promise<void> {
    const entry = this.entryFor(path);
    const remote = this.remote.get(path);

    // Checked from the stat, before the file is opened. The server refuses
    // an oversized file at the put, which is correct and far too late: by
    // then the client has read it, chunked it and named it, and a file just
    // over the limit costs several times its own size in memory to produce
    // an error that its size alone predicted. On a phone that is not a
    // wasted pass, it is the end of the process.
    const perFileMax = this.limitOn("perFileMax");
    if (stat && !stat.folder && stat.size > perFileMax) {
      this.recordFailure(path, tooLarge(stat.size, perFileMax), report);
      return;
    }

    let local: LocalState | undefined;
    let scanned: Scanned | undefined;
    if (stat) {
      if (!stat.folder && needsRehash(entry, Math.ceil(stat.mtime), stat.size, stat.changeId)) {
        // The only place a file is read for its content, and only when
        // the stat says it moved.
        scanned = await this.rehash(entry, path, stat.size);
      }
      local = { folder: stat.folder, mtime: entry.mtime, size: entry.size, hash: entry.hash };
    }

    let action = decide({ local, remote, index: entry, mergeable: this.mergeable(path) });

    // The server still spells this name a way this device does not.
    //
    // Only a vault an older Mac client wrote is in this state: it uploaded
    // `café.md` in NFD, which is the same name as `café.md` and not the same
    // string, and nothing else produces it. This device holds the note under
    // the NFC name, so the correction it owes the server is a rename, and
    // `prev` is how a rename travels: one entry, no bodies, the chunks are
    // already there. Uploading without it is what left two spellings on the
    // server and a vault permanently `blocked` between them, which is the
    // failure the normalisation was added to prevent
    // (cli/normalization.test.ts, "a peer that spells the name NFD").
    //
    // Only with the file actually here, because a rename has to name a file.
    // `prev` is filled only when it is free: a rename this device has not sent
    // yet names the path the server knows, which is the older of the two, and
    // that is the one Obsidian keeps too. The upload is forced whether or not
    // it was free, because it is `remote.wire` going away that says the server
    // has heard, and an attempt that failed owes another one.
    //
    // Files only. A folder carries no content and its entry carries no `prev`,
    // so renaming one would add a second folder to the server and remove
    // nothing. It does not need to: a receiving device folds the old spelling
    // to the same name and makes the same directory.
    const spelled = remote?.wire;
    if (spelled !== undefined && local !== undefined && !local.folder) {
      if (entry.prev === "") entry.prev = spelled;
      if (action.kind === "nothing") {
        action = { kind: "upload", why: "the server spells this name in another normal form" };
      }
    }

    if (
      coalesce &&
      action.kind === "upload" &&
      this.sending &&
      local &&
      !stat?.folder &&
      !looksLikeText(path) &&
      !readyToSyncAgain(entry, now)
    ) {
      // Only repeat binary uploads wait. Notes already have the client's
      // event batching; another per-file delay holds back saved edits.
      // Incoming updates also reach the editor without this cooldown.
      // Give the client a deadline so this cannot wait for the 30 s poll.
      report.waiting++;
      report.nextUploadAt = Math.min(report.nextUploadAt ?? Infinity, nextUploadTime(entry));
      return;
    }

    await this.act(path, action, entry, local, remote, report, now, scanned);
    this.pending.delete(path);
  }

  /**
   * Chunks and names a file, filling in the index's content cache.
   *
   * The cut pieces come back so that an upload deciding to send this file
   * does not read and chunk it all over again. On a first sync that second
   * pass was half of everything the client did: seventeen megabytes took
   * thirty seconds against four seconds of wire, and the four round trips it
   * now costs made the duplication the whole cost. The pieces are views into
   * the bytes read, so keeping them costs nothing the read did not.
   *
   * Hashed a window at a time, concurrently within each window, which is the
   * measured middle between hashing one chunk at a time and holding a copy of
   * every chunk in flight (`chunkNames`).
   */
  private async rehash(entry: IndexEntry, path: string, knownSize?: number): Promise<Scanned> {
    const streamed = await this.streamScan(entry, path, knownSize);
    if (streamed) return streamed;

    const bytes = await this.opts.vault.read(path);
    const isText = this.mergeable(path);
    const pieces = [...chunkBytes(bytes, this.sizesFor(bytes.length, isText), isText)];
    entry.chunks = await chunkNames(pieces.map((c) => c.bytes));
    entry.hash = contentId(entry.chunks);
    entry.size = bytes.length;
    return { bytes, pieces, names: entry.chunks };
  }

  /**
   * Names a large file without ever holding it, when the vault can stream.
   *
   * The buffered path holds the whole file from the moment it is read until
   * the last chunk has gone, because a wanted chunk is sent from the bytes in
   * hand. That is the whole of why a 256 MiB attachment costs most of a
   * gigabyte: not the sending, the holding.
   *
   * With blocks and ranges the file is read twice from disk instead: once to
   * cut and name it, keeping one chunk at a time, and again for the chunks the
   * server actually asks for. Two reads of a disk against most of a gigabyte
   * of memory is not a close trade.
   *
   * Returns undefined when the vault cannot do it, or when the file is small
   * enough that holding it is cheaper than reading it twice. A platform whose
   * resource fetch fails, which the plugin has seen on a phone, is the first
   * case after its first failure.
   */
  private async streamScan(
    entry: IndexEntry,
    path: string,
    knownSize: number | undefined,
  ): Promise<Scanned | undefined> {
    const vault = this.opts.vault;
    if (!vault.readBlocks || !vault.readRange || this.cannotStream) return undefined;
    if (knownSize === undefined || knownSize <= KEEP_BODIES_BELOW) return undefined;

    try {
      return await this.streamed(entry, path, knownSize);
    } catch (err) {
      // A vault that offers these methods and cannot deliver. The Obsidian
      // adapter reaches the file through a URL the webview can fetch, and
      // that is verified on desktop and unverified anywhere else, so a
      // failure here is read as "not on this platform" rather than as a
      // failure of the file.
      //
      // Remembered, because otherwise every large file in the vault would
      // discover it again, one at a time.
      this.cannotStream = true;
      this.log("streaming is not available here, reading whole files instead", path, {
        why: (err as Error).message,
      });
      return undefined;
    }
  }

  private async streamed(entry: IndexEntry, path: string, knownSize: number): Promise<Scanned> {
    const vault = this.opts.vault;
    const isText = this.mergeable(path);
    const names: string[] = [];
    const spans: { start: number; end: number }[] = [];
    let size = 0;

    for await (const piece of chunkStream(
      vault.readBlocks!(path),
      this.sizesFor(knownSize, isText),
      isText,
    )) {
      names.push(await chunkName(piece.bytes));
      spans.push({ start: piece.offset, end: piece.offset + piece.bytes.length });
      size += piece.bytes.length;
    }

    entry.chunks = names;
    entry.hash = contentId(names);
    entry.size = size;
    return { names, spans, path, size };
  }

  private async act(
    path: string,
    action: Action,
    entry: IndexEntry,
    local: LocalState | undefined,
    remote: Remote | undefined,
    report: SyncReport,
    /** The pass's own clock reading, so the hot branches do not take another. */
    now: number,
    /** What the rehash read and cut, if this file was just scanned. */
    scanned?: Scanned,
  ): Promise<void> {
    switch (action.kind) {
      case "nothing":
        report.unchanged++;
        // Agreement settles a refusal too, so a later genuine race starts its
        // own count rather than inheriting one (R083-01).
        this.staleHeads.delete(path);
        this.asked.delete(path);
        // Two sides agreeing *is* a sync: the ancestor moves, or the next
        // divergence would merge against a version neither side has.
        if (local && remote && !remote.deleted) {
          if (local.folder && remote.folder) {
            // A folder has no content to compare, and the two sides spell
            // that differently: "" from the scan, "-empty-" from a batch.
            // Left to the hash comparison below, a folder both devices
            // had before they paired never recorded a sync, and
            // `decideFolder` reads no synctime as "never seen here", so
            // removing it later put it straight back.
            synced(entry, "", [], remote.uid, now);
          } else if (local.hash === remote.hash) {
            synced(entry, local.hash, entry.chunks, remote.uid, now);
          }
        }
        return;

      case "upload":
        await this.upload(path, entry, report, remote?.uid, true, scanned);
        return;

      case "download":
      case "restoreLocal": {
        if (!remote) return;
        await this.receive(path, entry, remote, action.kind, action.why, report, local);
        return;
      }

      case "createLocalFolder":
        await this.opts.vault.mkdir(path);
        entry.folder = true;
        if (remote) synced(entry, "", [], remote.uid, now);
        report.foldersCreated++;
        return;

      case "clash":
        // Written off rather than retried. Trying again cannot help
        // while both devices disagree about what this path is, and the
        // alternative was one direction retrying an impossible mkdir
        // for ever while the other silently ignored the file.
        //
        // Neither side is touched. Renaming somebody's file to admit a
        // folder is a larger intervention than telling them the two
        // disagree, and only they know which they meant. The skip
        // clears by itself once the file changes, which renaming it
        // does.
        this.skipped.set(path, {
          why: `${action.why}. Rename one of them, and it will sync.`,
          fingerprint: fingerprintOf(entry),
        });
        noteSkipped(report, path);
        this.log("cannot be both", path, action.why);
        return;

      case "deleteLocal":
        this.deletingThisPass.add(path);
        // Held until the pass has written everything it is going to.
        //
        // Rule 3 argues for this on its own: never delete until a
        // verified copy exists elsewhere. A move makes it concrete. The
        // old path is deleted and the new one downloaded in the same
        // pass, and deleting first threw away the only local copy of
        // bytes the pass was about to write back, so the file came over
        // the wire instead. Deferring costs nothing and means there is
        // never a moment where neither name holds the note.
        this.pendingDeletes.push({ path, why: action.why, based: local });
        if (local !== undefined && !local.folder) {
          const digest = await this.digestOf(path);
          if (digest !== undefined) this.deleteBaseline.set(path, digest);
        }
        return;

      case "deleteRemote": {
        if (!this.sending) {
          // The one this feature exists for. A mirror that decides a note is
          // gone because its disk was not mounted must not be able to say so.
          this.heldBack(path, report, "this device is read-only, so it was not deleted anywhere");
          return;
        }
        const deletedAt = this.now();
        const facts: PutFacts = {
          // Under the name the server has, where that is not the name this
          // device uses. A note downloaded from a vault an older Mac
          // client wrote is here under its NFC name and there under an NFD
          // one, and until the rename has gone up those are different files
          // to the server: a deletion sent under the NFC name deletes
          // nothing, and the note stays alive on every device that has not
          // folded it (engine.test.ts, "deletes the note the server has").
          path: remote?.wire ?? path,
          meta: { size: 0, ctime: 0, mtime: deletedAt, deleted: true },
          names: [],
        };
        await this.queue(
          {
            path,
            size: 0,
            entry: { ...facts, base: remote?.uid ?? 0 },
            bodyOf: noBodies,
            commit: (uid, remoteIsNewer) => {
              // Recorded before the entry is forgotten. This
              // device's own writes come back with no payload, so
              // nothing else will ever tell it the deletion
              // happened, and a stale entry here reads on the next
              // pass as a file to download back.
              if (!remoteIsNewer)
                this.remote.set(path, {
                  uid,
                  folder: false,
                  deleted: true,
                  mtime: this.now(),
                  size: 0,
                  hash: "",
                });
              this.entries.delete(path);
              report.deletedRemotely++;
              this.log("deleted on the server", path, action.why);
              this.activity("deleted-server", path);
            },
          },
          report,
        );
        return;
      }

      case "merge":
        await this.merge(path, entry, remote, report);
        return;

      case "conflict":
        await this.conflict(path, entry, remote, report, action.why);
        return;
    }
  }

  /**
   * Queues a file to go up with the next batch.
   *
   * `count` is whether committing it adds to `report.uploaded`. A merge and a
   * conflict copy both upload, and both are already counted as what they are.
   */
  private async upload(
    path: string,
    entry: IndexEntry,
    report: SyncReport,
    /** The server's version this write answers, as the decision saw it. */
    basedOn: number | undefined,
    count = false,
    /**
     * What the pass already read and cut for this exact content. Passed
     * only where the file has not been touched since: a merge rewrites it,
     * so a merge scans again.
     */
    scanned?: Scanned,
  ): Promise<void> {
    const base = pathBase(this.remote.get(path), path, basedOn);
    // Here rather than at the decision, because this is the choke point (I29).
    //
    // The first version guarded the `upload` action in the switch above and a
    // conflict copy went up anyway: this has four callers, and the other three
    // are a merge result, a conflict copy and the note beside it. Guarding the
    // one place that sends is the difference between a device that mostly does
    // not send and one that cannot.
    if (!this.sending) {
      this.heldBack(path, report, "this device is read-only, so it was not sent");

      // And the ancestor moves here too, for the same reason the guard is here
      // (RR7, RR9).
      //
      // Sending the local version against `basedOn` is what normally records
      // that this remote version has been dealt with. A device that never sends
      // never records it, so the next pass sees both sides moved since the
      // ancestor, decides the same thing again, and does it again: another
      // conflict copy every pass, or the same merge reported every pass. The
      // first fix put this in `conflict` alone and the successful-merge branch
      // kept the defect, which is exactly the mistake the guard above is here
      // to stop being made once per caller.
      //
      // Only `synchash` and `syncuid` move. `hash` and `chunks` describe the
      // bytes on this disk and saying they were the agreed version would be the
      // "a failed push looks like an agreed state" mistake `synced` warns
      // about, reached from the other side. The local edit therefore stays
      // described as it is, the next pass sees an upload, holds it back and
      // says so, which is true and is a fixed point rather than a loop.
      //
      // Nothing is claimed when the answer is not to a version, or when the
      // server has moved on since the decision was taken: a later version has
      // not been dealt with and must not be recorded as though it had.
      const answered = answeredVersion(basedOn, this.remote.get(path));
      if (answered) reconciled(entry, answered.hash, answered.uid, this.now());
      return;
    }
    if (entry.folder) {
      const facts: PutFacts = {
        path,
        meta: { size: 0, ctime: 0, mtime: 0, folder: true },
        names: [],
      };
      await this.queue(
        {
          path,
          size: 0,
          entry: { ...facts, base },
          bodyOf: noBodies,
          commit: (uid, remoteIsNewer) => {
            synced(entry, "", [], uid, this.now());
            if (!remoteIsNewer)
              this.remote.set(path, {
                uid,
                folder: true,
                deleted: false,
                mtime: 0,
                size: 0,
                hash: "",
              });
            if (count) report.uploaded++;
          },
        },
        report,
      );
      return;
    }

    const plan = await this.planUpload(entry, path, scanned);
    // Read now, applied later. `entry` is mutable and the commit runs after
    // the flush, so what gets recorded has to be what actually went up.
    const hash = entry.hash;
    const chunks = [...entry.chunks];
    const size = entry.size;
    const mtime = entry.mtime;

    const previous = entry.prev;
    const prevBase = previous ? (this.entries.get(canonicalSpelling(previous))?.syncuid ?? 0) : 0;
    const facts: PutFacts = {
      path,
      meta: {
        size,
        ctime: entry.ctime,
        mtime,
        ...(previous ? { prev: previous } : {}),
      },
      names: plan.names,
    };

    await this.queue(
      {
        path,
        size,
        // The versions this was prepared against: a peer's write since is
        // refused as `stale` rather than replaced.
        entry: { ...facts, base, prevBase },
        bodyOf: plan.bodyOf,
        commit: (uid, remoteIsNewer) => {
          synced(entry, hash, chunks, uid, this.now());
          // Record what the server now holds, so the next pass sees
          // agreement rather than deciding to upload again.
          if (!remoteIsNewer)
            this.remote.set(path, {
              uid,
              folder: false,
              deleted: false,
              mtime,
              size,
              hash,
              ...spellingHeads(this.remote.get(path), path, path, uid),
            });
          if (previous) {
            // A peer can advance the destination before this ack is handled.
            // Its source retirement still committed; own broadcasts carry
            // no entry that could record that fact for us later.
            const old = canonicalSpelling(previous);
            if (old !== path) {
              // The old incarnation was retired even if a peer has already
              // reused its name with identical bytes. Keeping that ancestor
              // would misread the absent old file as a new deletion.
              this.entries.delete(old);
              if ((this.remote.get(old)?.uid ?? 0) <= uid) {
                this.remote.set(old, {
                  uid,
                  folder: false,
                  deleted: true,
                  mtime,
                  size: 0,
                  hash: "",
                  ...spellingHeads(this.remote.get(old), old, previous, uid),
                });
                this.pending.delete(old);
              }
            } else if (old === path) {
              const state = this.remote.get(path)!;
              this.remote.set(path, {
                ...state,
                heads: { ...state.heads, [previous]: Math.max(state.heads?.[previous] ?? 0, uid) },
              });
            }
          }
          if (count) report.uploaded++;
          this.log("uploaded", path);
          this.activity("uploaded", path);
        },
      },
      report,
    );
  }

  /**
   * Adds a write to the outbox, flushing when the batch is full.
   *
   * Three bounds, because they guard different things. The count is the
   * server's, and it is what makes a vault of notes one exchange instead of
   * hundreds. The other two are the server's caps on a batched write, one on
   * the summed declared sizes of the entries and one on the encoded frame,
   * and between them they bound this device's memory as well: a queued file
   * pins roughly its own size until the batch goes, as the bytes its bodies
   * are cut from, so batching two hundred and fifty-six attachments would
   * otherwise hold all of them at once. Notes batch to the count; attachments
   * flush almost every file, which is what this did before.
   */
  private async queue(q: Queued, report: SyncReport): Promise<void> {
    // Two caps from `ready`, both on the whole batch: the summed declared
    // sizes of its entries, and the encoded size of the frame. A write that
    // would take either over the cap goes in the next batch, and one whose
    // own budget is over it goes alone, as a `put`, which the server bounds
    // by the file limit instead. Added regardless, one attachment made one
    // batch of everything, the server refused the batch by bytes, and every
    // note in it was written off for the attachment's size.
    const cap = this.batchCap;
    const budget = entryBudget(q.size);
    const encoded = encodedEntryBytes(q.entry);
    if (
      this.outbox.length > 0 &&
      (budget > cap ||
        this.outboxBudget + budget > cap ||
        this.outboxFrame + encoded > cap - PUTMANY_FRAME_OVERHEAD)
    ) {
      await this.flush(report);
    }
    this.outbox.push(q);
    this.outboxBudget += budget;
    this.outboxFrame += encoded;
    if (
      this.outbox.length >= MAX_BATCH_ENTRIES ||
      this.outboxBudget >= cap ||
      this.outboxFrame >= cap - PUTMANY_FRAME_OVERHEAD
    ) {
      await this.flush(report);
    }
  }

  /**
   * One limit, held to the tighter of what the server asked for and what this
   * device allows.
   *
   * The rule lives here rather than at each guard because it was written out
   * by hand at every guard and one of them was written differently: the
   * outbound size pre-check read the server's raw number and gated on `> 0`,
   * so a server advertising `perFileMax: 0` turned it off. Every reader of a
   * limit goes through this, so the next limit added cannot be added with the
   * fallback forgotten.
   */
  private limitOn(which: keyof typeof OWN_LIMITS): number {
    return boundedBy(this.limits?.[which] ?? 0, OWN_LIMITS[which]);
  }

  /** The batched-write cap this device keeps to: the server's, or its own if smaller. */
  private get batchCap(): number {
    return Math.min(
      this.limitOn("maxBatchBytes"),
      this.opts.activePath?.() ? 2 * 1024 * 1024 : Infinity,
    );
  }

  /** The fetch cap this device keeps to, the same way. */
  private get fetchCap(): number {
    return Math.min(
      this.limitOn("maxFetchBytes"),
      this.opts.activePath?.() ? 2 * 1024 * 1024 : Infinity,
    );
  }

  /**
   * Sends the outbox as one exchange and applies what committed.
   *
   * Nothing here is recorded until the server has said so. An entry it refuses
   * goes through the same failure path a single put's refusal did, and the
   * rest of the batch is unaffected.
   */
  private async flush(report: SyncReport): Promise<void> {
    if (this.outbox.length === 0) return;
    const batch = this.outbox;
    this.outbox = [];
    this.outboxBudget = 0;
    this.outboxFrame = 0;

    // One producer per chunk name. Two notes sharing a chunk means the
    // server asks once, and it must not matter which of them is asked.
    const producers = new Map<string, (name: string) => Promise<Uint8Array>>();
    for (const q of batch) {
      for (const name of q.entry.names) {
        if (!producers.has(name)) producers.set(name, q.bodyOf);
      }
    }

    const bodyOf = async (name: string) => {
      const produce = producers.get(name);
      if (!produce) throw new Error(`server asked for ${name}, which no queued file contains`);
      return produce(name);
    };
    let out;
    try {
      out = await this.transferring(
        "upload",
        batch.filter((q) => q.entry.names.length > 0).map((q) => q.path),
        async (onBytes) => {
          const alone = batch.length === 1 ? batch[0]! : undefined;
          if (alone !== undefined && entryBudget(alone.size) > this.batchCap) {
            // One large file is a `put`, not a batch of one. The server caps a
            // batched write by budget and says so in its refusal: split the
            // batch, and send a file over the limit on its own with put. A
            // single put is bounded only by the per-file limit.
            const { entry } = alone;
            const send = (transport: Transport) =>
              transport.put(
                entry.path,
                entry.meta,
                entry.names,
                bodyOf,
                { base: entry.base ?? 0, prevBase: entry.prevBase ?? 0 },
                onBytes,
                transport === this.opts.transport
                  ? undefined
                  : () =>
                      this.sendInteractiveEdit(
                        report,
                        batch.map((q) => q.path),
                      ),
              );
            const one =
              this.opts.withUploadTransport && !this.servicingInteractive
                ? await this.opts.withUploadTransport(send)
                : await send(this.opts.transport);
            return { results: [{ uid: one.uid }], uploaded: one.uploaded, bytes: one.bytes };
          } else {
            return await this.opts.transport.putMany(
              batch.map((q) => q.entry),
              bodyOf,
              onBytes,
            );
          }
        },
      );
    } catch (err) {
      // A lost reply can follow a commit. Reconcile before retrying; the
      // server's conditional write prevents replacing a newer branch.
      for (const q of batch) this.recordFailure(q.path, err, report);
      return;
    }

    report.chunksSent += out.uploaded;
    report.bytesSent += out.bytes;
    for (let i = 0; i < batch.length; i++) {
      const q = batch[i]!;
      const result = out.results[i]!;
      if (result.error) {
        this.recordFailure(q.path, result.error, report);
        continue;
      }
      // Settled, so a later genuine race starts its own count rather than
      // inheriting one (R083-01).
      this.staleHeads.delete(q.path);
      this.asked.delete(q.path);
      const remoteIsNewer = (this.remote.get(q.path)?.uid ?? 0) > result.uid;
      // A successful conditional write is an accepted ancestor even if a
      // peer edits it before the ack arrives. Record that local checkpoint
      // and any source retirement, while preserving the newer remote head.
      q.commit(result.uid, remoteIsNewer);
      if (remoteIsNewer) {
        report.waiting++;
        this.again = true;
        this.log("another device wrote after this upload, reconciling next pass", q.path, {
          uploaded: result.uid,
          now: this.remote.get(q.path)?.uid,
        });
      }
    }
  }

  private servicingInteractive = false;
  /** When the interleaved publish last looked, so it does not look per body. */
  private lastInteractive = 0;

  /**
   * Publish an independent small saved note while a bulk transfer yields.
   * This stays inside the owning engine pass. Namespace changes and conflicts
   * keep the ordinary full reconciliation path; no second engine edits the index.
   */
  private async sendInteractiveEdit(
    report: SyncReport,
    transferring: readonly string[],
  ): Promise<void> {
    if (
      this.servicingInteractive ||
      this.dirty.size === 0 ||
      !this.sending ||
      this.opts.transport.isClosed
    )
      return;
    // Not on every body. This runs between the bodies of a transfer, and the
    // checks below include a walk of every index entry looking for a rename in
    // flight: a 64 MiB attachment is a few hundred bodies, so on a large vault
    // with one unsaved note that is a few million comparisons spent deciding
    // the same thing over and over. The point of the yield is that a save
    // reaches the server while a person would still call it prompt, and a
    // fifth of a second is well inside that.
    //
    // Wall clock rather than `now()`, because this is about not burning a
    // phone's CPU in real time rather than about sync's own ordering. The
    // first opportunity is always taken, so nothing waits that would not have.
    const at = Date.now();
    if (at - this.lastInteractive < INTERACTIVE_GAP_MS) return;
    this.lastInteractive = at;
    const active = this.opts.activePath?.();
    const path =
      active && this.dirty.has(active)
        ? active
        : [...this.dirty].find((candidate) => looksLikeText(candidate));
    if (!path || !looksLikeText(path) || !this.opts.vault.stat) return;
    const entry = this.entries.get(path);
    const remote = this.remote.get(path);
    // Work already planned under either spelling must finish before revisiting it.
    const involved = [
      ...transferring,
      ...this.outbox.map((q) => q.path),
      ...this.inbox.map((q) => q.path),
      ...this.pendingDeletes.map((q) => q.path),
    ];
    const identity = this.identity(path);
    if (
      involved.some((other) => {
        const id = this.identity(other);
        return id === identity || id.startsWith(`${identity}/`) || identity.startsWith(`${id}/`);
      })
    )
      return;
    if (
      !entry ||
      entry.folder ||
      entry.prev ||
      remote?.wire ||
      remote?.deleted ||
      remote?.folder ||
      (remote?.uid ?? 0) !== entry.syncuid ||
      this.skipped.has(path) ||
      this.ignoredPaths.has(path) ||
      refusedInboundPath(path) !== undefined ||
      this.nowBlocked.has(path) ||
      this.pending.has(path)
    )
      return;
    if (
      [...this.entries.values()].some(
        (other) => other.prev && this.identity(other.prev) === identity,
      )
    )
      return;
    if (
      (this.opts.vault.ambiguous?.() ?? []).some(
        (clash) =>
          this.identity(clash.path) === identity ||
          identity.startsWith(`${this.identity(clash.path)}/`),
      )
    )
      return;
    const retry = this.retries.get(path);
    if (retry && retry.at > this.now()) return;

    this.servicingInteractive = true;
    // Keep the outer queues intact. This path is disjoint from everything they name.
    const queued = this.outbox;
    const budget = this.outboxBudget;
    const frame = this.outboxFrame;
    this.outbox = [];
    this.outboxBudget = 0;
    this.outboxFrame = 0;
    try {
      const stat = await this.opts.vault.stat(path);
      if (!stat || stat.folder || stat.size > Math.min(512 * 1024, this.limitOn("perFileMax")))
        return;
      // A newer edit during either await remains dirty for the next boundary.
      this.dirty.delete(path);
      entry.hash = "";
      entry.chunks = [];
      observe(entry, stat);
      const scanned = await this.rehash(entry, path, stat.size);
      // A save can grow the file after the stat. Keep bulk content off the
      // interactive wire even when its original size fitted this path.
      if (entry.size > Math.min(512 * 1024, this.limitOn("perFileMax"))) {
        this.again = true;
        return;
      }
      const current = this.remote.get(path);
      const action = decide({
        local: { folder: false, mtime: entry.mtime, size: entry.size, hash: entry.hash },
        remote: current,
        index: entry,
        mergeable: this.mergeable(path),
      });
      if (action.kind !== "upload") {
        this.again = true;
        return;
      }
      await this.upload(path, entry, report, current?.uid, true, scanned);
      await this.flush(report);
    } catch (err) {
      this.recordFailure(path, err, report);
    } finally {
      // A thrown preparation did not commit anything left in its temporary queue.
      this.outbox = queued;
      this.outboxBudget = budget;
      this.outboxFrame = frame;
      this.servicingInteractive = false;
    }
  }

  /**
   * Sends the server bodies it has lost, without writing a version (I14).
   *
   * A body can go missing while every row stays exactly as it was: a disk rots
   * one and `trew verify` quarantines it, or a restore brings back a
   * database and a chunk tree of slightly different ages. Every device that
   * wants that version then downloads for ever, which presents as a sync that
   * never finishes rather than as an error anybody can act on.
   *
   * Ordinary reconciliation cannot fix it, and that is the point of this
   * method. A device whose copy of the note has not changed considers it
   * synced, because it is: the entry is committed, the hashes agree, and there
   * is nothing for a pass to do. It is holding the missing bytes and has no
   * reason to send them. The only way to make it send them used to be to edit
   * the note, which writes a version nobody typed into the history of a vault
   * that is already damaged.
   *
   * So this offers the server the chunk names of everything this device holds,
   * lets the server say which of them it actually lacks, and produces only
   * those, from the files on this disk. Nothing about any entry changes.
   *
   * What this cannot see is said out loud rather than implied away. A body
   * belonging to a version this device never had is not on this disk and is not
   * in this index: nothing here could notice it is gone. `couldNotOffer` is the
   * one kind of "cannot help" a device can see for itself, a note whose local
   * copy has moved on from what the server acknowledged. The authoritative list
   * of what a vault still lacks is `trew verify` on the server, and both
   * shells say so, because a clean repair here is not the same claim as a whole
   * vault and reporting it as one would be the comfortable lie.
   */
  async repair(): Promise<RepairReport> {
    const report: RepairReport = {
      scanned: 0,
      offered: 0,
      stored: 0,
      couldNotOffer: 0,
      stillMissing: 0,
      failed: [],
    };

    // Offers are gathered first and sent in batches (Codex-01). One `resend`
    // per file meant one round trip per file whatever the answer was, and the
    // answer is almost always "I have all of those": at ten thousand notes and
    // 200 ms to the server that is over half an hour of nothing but waiting,
    // on the client's serial queue, to put back a handful of bodies.
    //
    // The offer itself is free to make. It is the index's own chunk names, so
    // a batch reads nothing; the server answers `want` with the subset it
    // actually lacks, and only those files are read.
    const offers: { path: string; entry: IndexEntry; names: readonly string[] }[] = [];
    for (const [path, entry] of [...this.entries]) {
      if (entry.folder || entry.chunks.length === 0) continue;
      report.scanned++;

      // Only what this device can prove it holds. `synchash` is the content the
      // server acknowledged; if the local file has moved on, its chunks are not
      // the ones the server is missing, and offering them would be an offer
      // this device cannot keep.
      const names = entry.chunks;
      if (entry.hash !== entry.synchash) {
        report.couldNotOffer += names.length;
        continue;
      }

      // And what the disk still agrees with, from a stat rather than a read.
      //
      // This is the check that used to happen inside `planUpload`, before the
      // offer went out. Deferring the read means the disagreement is found
      // while the server is already reading bodies, which is the one moment
      // there is no way to withdraw: the connection has to be ended, and every
      // path after this one in the run fails with it. A stat is what stops the
      // common case, a note edited since the last pass, from ever getting
      // there. The exact check still runs on the bytes; this only decides
      // whether to offer at all.
      const disk = this.opts.vault.stat ? await this.opts.vault.stat(path) : undefined;
      if (
        disk === undefined ||
        disk.folder ||
        needsRehash(entry, Math.ceil(disk.mtime), disk.size, disk.changeId)
      ) {
        report.couldNotOffer += names.length;
        continue;
      }
      offers.push({ path, entry, names });
    }

    for (let at = 0; at < offers.length;) {
      // A batch, by name count. The server refuses a resend naming more than
      // `MAX_FETCH_NAMES` chunks, and one file may be most of a batch on its
      // own, so a file whose names exceed the cap goes alone and is bounded by
      // the same rule a put is.
      const batch: typeof offers = [];
      let named = 0;
      while (
        at < offers.length &&
        (batch.length === 0 || named + offers[at]!.names.length <= REPAIR_BATCH_NAMES)
      ) {
        named += offers[at]!.names.length;
        batch.push(offers[at]!);
        at++;
      }

      // Which file can make which name. A chunk two files share is offered
      // once and produced from whichever holds it; they are the same bytes,
      // because the name is a hash of them.
      const owner = new Map<
        string,
        { path: string; entry: IndexEntry; names: readonly string[] }
      >();
      const names: string[] = [];
      for (const offer of batch) {
        for (const name of offer.names) {
          if (owner.has(name)) continue;
          owner.set(name, offer);
          names.push(name);
        }
      }

      // The read, still deferred to the first body the server asks for, and
      // still checked against the index before any of it goes on the wire.
      const plans = new Map<string, UploadPlan>();
      let stale: string | undefined;
      const bodyOf = async (name: string): Promise<Uint8Array> => {
        const from = owner.get(name);
        if (!from) throw new Error(`the server asked for ${name}, which this repair did not offer`);
        let plan = plans.get(from.path);
        if (plan === undefined) {
          plan = await this.planUpload(from.entry, from.path);
          if (
            plan.names.length !== from.names.length ||
            plan.names.some((n, i) => n !== from.names[i])
          ) {
            stale = from.path;
            throw new Error(
              `${from.path} has changed since the version the server acknowledged, so its chunks were not sent`,
            );
          }
          plans.set(from.path, plan);
        }
        return plan.bodyOf(name);
      };

      try {
        const out = await this.opts.transport.resend(names, bodyOf);
        report.offered += names.length;
        report.stored += out.stored;
        report.stillMissing += out.missing;
      } catch (err) {
        // One batch's failure is one batch. A repair run is somebody acting on
        // a vault that is already damaged, and stopping at the first thing it
        // could not send would leave the rest unrepaired with no list of what
        // was skipped.
        //
        // The file that could not produce a body is named apart from the rest,
        // because it is not a failure: it is the same "cannot help with this
        // one" the `synchash` test above reports, found one step later because
        // that is where the file is read.
        for (const offer of batch) {
          if (offer.path === stale) report.couldNotOffer += offer.names.length;
          else report.failed.push({ path: offer.path, why: (err as Error).message });
        }
        // Unless the connection is what failed, in which case every batch
        // after this one would fail the same way and be listed as though this
        // device could not read it (rule 7). Stopping says what happened once.
        if (this.opts.transport.isClosed) break;
      }
    }
    return report;
  }

  /**
   * Works out what a file's chunks are called, and how to produce one.
   *
   * The names have to be known before the put is sent, because the server
   * answers with the subset it wants, so a file is chunked and named in full
   * either way. A body is produced only when the server asks for it: from the
   * bytes the scan already holds, where it held the file, or read back off
   * the disk by offset and hashed again, where it streamed it. Holding a
   * separate copy of every body was what made a 256 MiB attachment cost twice
   * its size, and on a phone that is not a spike but the end of the process.
   */
  private async planUpload(entry: IndexEntry, path: string, fresh?: Scanned): Promise<UploadPlan> {
    // A file whose chunk list is already right does not need reading at all.
    //
    // The names have to be known before the put goes out, because the server
    // answers with the subset it wants. When the pass did not rehash this
    // path, the index's names *are* the names: `needsRehash` said the bytes on
    // disk are the bytes these describe, and that is the same evidence every
    // other decision in the pass is made from.
    //
    // This is what a rename costs. Moving a folder changes no byte of any note
    // under it, so the server already holds every chunk and wants none of
    // them, and the old shape read, cut and hashed all of them anyway to
    // rediscover a list it was holding. The bodies are produced only if the
    // server asks, and then they are checked against the name they were
    // promised under, so a file that changed between the scan and the ask is
    // refused rather than sent as something it is not.
    if (fresh === undefined && entry.chunks.length > 0 && entry.hash !== "") {
      const names = [...entry.chunks];
      let made: UploadPlan | undefined;
      return {
        names,
        bodyOf: async (name) => {
          if (made === undefined) {
            const scan = await this.rehash(entry, path);
            if (scan.names.length !== names.length || scan.names.some((n, i) => n !== names[i])) {
              throw new Error(`${path} changed while it was being sent, so it was not sent`);
            }
            made = await this.planUpload(entry, path, scan);
          }
          return made.bodyOf(name);
        },
      };
    }

    // The scan that decided this file changed already read it, cut it and
    // named it. Doing that again was the single largest cost of sending a
    // large attachment: a 64 MiB file was read twice and chunked twice, and
    // the garbage from both passes was live at once. Read and cut here when
    // the caller had no fresh scan to hand over. A merge and a conflict copy
    // both rewrite the file before uploading it, so whatever the pass scanned
    // is stale by the time they are done.
    const scan = fresh ?? (await this.rehash(entry, path));

    // Offsets only, for a file too large to hold. A wanted chunk is read back
    // off the disk and hashed again, and only sent if it is still the bytes
    // it was named for.
    const vault = this.opts.vault;

    if (scan.spans) {
      const spanOf = new Map(scan.names.map((name, i) => [name, scan.spans[i]!]));
      return {
        names: scan.names,
        bodyOf: async (name) => {
          const span = spanOf.get(name);
          if (!span) throw new Error(`no chunk named ${name} in ${path}`);
          const range = await vault.readRange!(scan.path, span.start, span.end);
          // Checked against the name it was promised under. The file
          // was read to name it and is being read again to send it,
          // so an edit in between would otherwise put bytes on the
          // wire under a name that is not theirs. The server would
          // catch that and end the session; caught here it is one
          // file to try again next pass.
          if ((await chunkName(range)) !== name) {
            throw new Error(`${path} changed while it was being sent, so it was not sent`);
          }
          return range;
        },
      };
    }

    // The file is in hand, and each piece is a view into it: the bytes the
    // name was computed from, so they are the body as they stand.
    const byName = new Map<string, Uint8Array>();
    for (let i = 0; i < scan.names.length; i++) byName.set(scan.names[i]!, scan.pieces[i]!.bytes);
    return {
      names: scan.names,
      bodyOf: async (name) => {
        const body = byName.get(name);
        if (!body) throw new Error(`no chunk named ${name} in ${path}`);
        return body;
      },
    };
  }

  /**
   * Queues a version to come down with the next fetch.
   *
   * A download was one round trip, which for two hundred notes was two
   * hundred of them, and on a slow link that was most of the sync. The chunk
   * names are already known, because the batch that announced the version
   * carried them, so many files' names can go up in one ask and their bodies
   * come back in one stream.
   */
  private async receive(
    path: string,
    entry: IndexEntry,
    remote: RemoteState,
    kind: "download" | "restoreLocal",
    why: string,
    report: SyncReport,
    based: LocalState | undefined,
  ): Promise<void> {
    const chunks = chunkNamesOf(remote.hash);
    this.checkChunkCount(remote.uid, chunks.length);

    const baseDigest = based === undefined || based.folder ? undefined : await this.digestOf(path);
    this.inbox.push({ path, entry, remote, chunks, kind, why, based, baseDigest });
    this.inboxBytes += remote.size;
    if (this.inbox.length >= MAX_BATCH_ENTRIES || this.inboxBytes >= INBOX_BYTES) {
      await this.fill(report);
    }
  }

  /**
   * Fetches every queued version's chunks in one ask and writes the files.
   *
   * The names are deduplicated across the batch, so two notes that share a
   * chunk cost one body, and a file whose chunks the server cannot serve
   * fails alone rather than taking the batch with it.
   */
  private async fill(report: SyncReport): Promise<void> {
    if (this.inbox.length === 0) return;
    const batch = this.refuseAliases(this.inbox, report);
    this.inbox = [];
    this.inboxBytes = 0;
    if (batch.length === 0) return;

    // Bytes this device already holds are not worth asking for again.
    //
    // A move is the case that matters. Chunk names are hashes of the
    // chunks' bytes, so moving a file costs the sender nothing: the server
    // already has every chunk and only metadata travels. The receiver had
    // no such luck, and downloaded the whole file back over a name it was
    // already storing under. Moving one folder of attachments re-pulled all
    // of it, on every other device.
    const local = new Map<Incoming, string>();
    const byContent = this.heldByContent();
    for (const d of batch) {
      const from = byContent.get(contentId(d.chunks));
      if (from !== undefined && from !== d.path) local.set(d, from);
    }

    // And the parts of a file this device is already storing under the very
    // name being replaced.
    //
    // The whole-file check above catches a move. This catches an edit, which
    // is the common case and the expensive one: a paragraph changed in a
    // 200 MB recording renames one chunk and leaves the other eight hundred
    // alone, and the receiver downloaded all of it. A chunk's name is the hash
    // of its bytes and the chunker is deterministic, so a name this device's
    // own index lists is a body this device can make, exactly, from the file
    // on its disk. Making it costs a read and a hash; fetching it costs the
    // bytes over somebody's phone connection.
    const reuse = this.reusableFrom(batch, local);

    const wanted: string[] = [];
    const budgets = new Map<string, number>();
    for (const d of batch) {
      if (local.has(d)) continue;
      const mine = reuse.get(d);
      const each = perChunkBudget(d.remote.size, d.chunks.length);
      for (const name of d.chunks) {
        if (mine?.has(name)) continue;
        const known = budgets.get(name);
        if (known === undefined) wanted.push(name);
        // A chunk two files share is fetched once, and costed at the larger
        // of the two guesses, which is never under what it is.
        if (known === undefined || each > known) budgets.set(name, each);
      }
    }

    const held = new Map<string, Uint8Array>();
    let fetchIndividually = false;
    if (wanted.length > 0) {
      try {
        const bodies = await this.fetchAll(
          wanted,
          (name) => budgets.get(name)!,
          batch.filter((d) => !local.has(d)).map((d) => d.path),
          // The open note, published between bodies. A download of one large
          // attachment is a single request, so without this a save made
          // during it waited out the whole download.
          () =>
            this.sendInteractiveEdit(
              report,
              batch.map((d) => d.path),
            ),
        );
        for (let i = 0; i < wanted.length; i++) held.set(wanted[i]!, bodies[i]!);
      } catch (err) {
        // A missing or quarantined body must not hold every healthy note in
        // this batch back forever. The server refuses before sending bodies,
        // so the connection is still usable for individual file requests.
        if (
          err instanceof ProtocolError &&
          err.code === "nochunk" &&
          !this.opts.transport.isClosed
        ) {
          fetchIndividually = true;
        } else {
          for (const d of batch) this.recordFailure(d.path, err, report);
          return;
        }
      }
    }

    for (const d of batch) {
      try {
        const from = local.get(d);
        const reused = from === undefined ? "ask" : await this.landFromLocal(d, from, report);
        if (reused === "landed") {
          if (d.kind === "download") {
            report.downloaded++;
            this.activity("downloaded", d.path);
          } else report.restored++;
          this.log(d.kind, d.path, `${d.why}, from ${from} without asking`);
          continue;
        }
        // Written, over somebody's edit, and that edit is beside the note.
        // Counted by `writePreserving` as a conflict and not as a download,
        // and finished: asking the server for bytes already on the disk
        // would only displace them again.
        if (reused === "kept") continue;
        // Whatever this file's own copy can supply, made now rather than
        // asked for. A name that does not come out of the local file is one
        // the index was wrong about, and it is fetched below like any other.
        const mine = reuse.get(d);
        const bodies =
          mine === undefined ? held : await this.withLocalChunks(d, mine, held, report);
        const wrote =
          from !== undefined || fetchIndividually
            ? // Isolate missing bodies, or fetch after local reuse could not
              // be verified. Ordinary healthy batches keep the shared fetch.
              await this.land(d, await this.fetchFor(d), report)
            : await this.land(d, bodies, report);
        // Counted only when it happened. A conflict copy is not a download,
        // and reporting one is the kind of true-sounding status rule 7 is
        // about: the incoming version is on this disk either way, but under
        // a different name and with the local file untouched.
        if (!wrote) continue;
        if (d.kind === "download") {
          report.downloaded++;
          this.activity("downloaded", d.path);
        } else report.restored++;
        this.log(d.kind, d.path, d.why);
      } catch (err) {
        this.recordFailure(d.path, err, report);
      }
    }
  }

  /** Local paths as the disk files them, from this pass's listing. */
  private localByIdentity = new Map<string, string>();
  /** Paths this pass has decided to delete locally, which cannot collide with a write. */
  private deletingThisPass = new Set<string>();

  /** What the disk will file a path under. The vault knows; otherwise the safe guess. */
  private identity(path: string): string {
    return this.opts.vault.canonical ? this.opts.vault.canonical(path) : foldPath(path);
  }

  /**
   * Drops incoming versions that would be filed as one local file.
   *
   * Two distinct paths on the server, `Note.md` and `note.md`, or one name in
   * NFC and NFD, are one file on a disk that folds them. Written in turn, the
   * second replaced the first, both were recorded as synced, and the next scan
   * found the first missing and reported it deleted to every other device.
   * That is not a move, which the case-only rename protection covers; it is
   * two notes, and one of them was lost.
   *
   * Neither is written. Both are named, because only a person can say which
   * spelling they meant, and the refusal clears itself the moment one of them
   * is renamed on the device that has both. A path this pass is deleting is
   * not in the way: that is the rename case, and it goes through as before.
   */
  private refuseAliases(batch: Incoming[], report: SyncReport): Incoming[] {
    const byIdentity = new Map<string, Incoming[]>();
    for (const d of batch) {
      const key = this.identity(d.path);
      const same = byIdentity.get(key) ?? [];
      same.push(d);
      byIdentity.set(key, same);
    }
    const kept: Incoming[] = [];
    for (const [key, group] of byIdentity) {
      const local = this.localByIdentity.get(key);
      const localInTheWay =
        local !== undefined &&
        !this.deletingThisPass.has(local) &&
        group.some((d) => d.path !== local);
      if (!localInTheWay && group.length === 1) {
        kept.push(group[0]!);
        continue;
      }
      for (const d of group) {
        const other = localInTheWay ? local! : group.find((g) => g.path !== d.path)!.path;
        report.blocked++;
        if (report.inTheWay.length < LISTED_PATHS) {
          report.inTheWay.push({ path: d.path, blockedBy: other });
        }
        if (!this.blocked.has(d.path)) {
          this.log("cannot be both", d.path, `${other} is the same file on this disk`);
        }
        this.nowBlocked.add(d.path);
      }
    }
    return kept;
  }

  /**
   * The local deletions this pass decided on, applied once its writes are done.
   *
   * A path is either deleted or written in one pass, never both, because
   * `decide` returns one action for it. That is true of paths and was taken to
   * be true of files, and it is not: rename `Note.md` to `NOTE.md` and the
   * other device is told to write one and delete the other, which on macOS or
   * Windows is one file. It wrote the note and then deleted it, reported the
   * deletion back, and the server agreed the note was gone. Nothing on that
   * device was left to notice.
   *
   * So the writes are remembered, and a deletion naming a file one of them
   * produced is refused. Rule 3 in its smallest form: not "the path is
   * different" but "the file is a different file".
   */
  private pendingDeletes: { path: string; why: string; based: LocalState | undefined }[] = [];
  /**
   * The digest each pending deletion was decided about, taken when it was
   * decided (R01).
   *
   * Kept beside `pendingDeletes` rather than in it so that the read happens
   * once, at the moment the decision is recorded, and not again at the end of
   * the pass when it would describe whatever the editor had done since.
   */
  private deleteBaseline = new Map<string, string>();
  private wroteThisPass: string[] = [];

  /**
   * Whether removing `path` would remove something this pass wrote.
   *
   * The vault answers where it can, because the filesystem is the only thing
   * that actually knows. Where it cannot, two paths equal under case folding
   * are treated as one file, which keeps the note.
   *
   * `sure` is which of the two answered. The fallback keeps the note and does
   * not converge: on a disk that does keep the two spellings apart, the
   * deletion is refused again on every pass, for ever, and the caller reports
   * that rather than returning a clean report over a vault that never settles.
   */
  private async wouldUndoAWrite(
    path: string,
  ): Promise<{ wrote: string; sure: boolean } | undefined> {
    const vault = this.opts.vault;
    for (const wrote of this.wroteThisPass) {
      if (wrote === path) continue;
      if (vault.sameFile) {
        if (await vault.sameFile(wrote, path)) return { wrote, sure: true };
        continue;
      }
      if (foldsTogether(wrote, path)) return { wrote, sure: false };
    }
    return undefined;
  }

  private async applyDeletes(report: SyncReport): Promise<void> {
    const deletes = this.pendingDeletes;
    this.pendingDeletes = [];
    // Drained with them, so a digest never outlives the pass that took it and
    // a later deletion of the same path cannot be checked against a baseline
    // from an earlier one.
    const baselines = this.deleteBaseline;
    this.deleteBaseline = new Map();
    for (const { path, why, based } of deletes) {
      try {
        const same = await this.wouldUndoAWrite(path);
        if (same !== undefined) {
          // Not a failure and not retried: the file is where it should be,
          // under the name the server asked for. Only the deletion of its old
          // name has nowhere to land, because that name was never a second
          // file here.
          this.entries.delete(path);
          if (same.sure) {
            this.log(
              "kept",
              path,
              `deleting it would remove ${same.wrote}, which is the same file`,
            );
            continue;
          }
          // Guessed from the spelling, because this vault cannot say. The
          // note is kept, which is the right side to err on, and it is
          // counted, because on a disk that holds both spellings the
          // deletion comes back every pass and never lands: a report that
          // said nothing happened described a vault that never settles.
          report.blocked++;
          if (report.inTheWay.length < LISTED_PATHS) {
            report.inTheWay.push({ path, blockedBy: same.wrote });
          }
          this.log(
            "kept",
            path,
            `deleting it might remove ${same.wrote}, and this vault cannot say whether they are one file`,
          );
          continue;
        }
        // An incoming deletion removes bytes, so it asks the same question
        // the landing paths do (F01). A file edited since the pass decided
        // to delete it holds work the server has never seen, and the
        // deletion is about the version that is gone, not about this one.
        if (!(await this.unchangedSince(path, based))) {
          report.waiting++;
          this.again = true;
          this.log("kept", path, {
            why: "it changed after the pass decided to delete it",
            deletion: why,
          });
          continue;
        }
        // And the removal preserves too, for the same reason the write does
        // (R01): the check above compares metadata, and an edit that keeps the
        // length is invisible to it. `removeExpecting` says whether what it
        // took away was the version this decided about, and hands it back when
        // it was not.
        const keptAt = await this.removedSomethingElse(path, based, baselines);
        if (keptAt !== undefined) {
          this.log("kept what was about to be deleted", path, {
            why: "it changed after the pass decided to delete it",
            deletion: why,
            keptAt,
          });
          this.landed(keptAt);
          this.activity("conflict", path, keptAt);
          report.conflicted++;
          this.entries.delete(path);
          continue;
        }
        this.entries.delete(path);
        report.deletedLocally++;
        this.log("deleted locally", path, why);
        this.activity("deleted-local", path);
      } catch (err) {
        this.recordFailure(path, err, report);
      }
    }
  }

  /**
   * Records a write this pass made, for the two checks that read it.
   *
   * `wroteThisPass` is for the deletions applied at the end of the pass.
   * `localByIdentity` is for the alias check in every later fill of this
   * pass: it was built from the listing at the start and never updated, so a
   * second spelling of a file the first fill had just landed was not "in the
   * way" of anything and landed over it.
   */
  private landed(path: string): void {
    this.wroteThisPass.push(path);
    this.localByIdentity.set(this.identity(path), path);
  }

  /** Every path this device holds, by the content it holds, newest wins. */
  private heldByContent(): Map<string, string> {
    const by = new Map<string, string>();
    for (const [path, entry] of this.entries) {
      if (entry.folder || entry.hash === "" || entry.hash === "-empty-") continue;
      by.set(entry.hash, path);
    }
    return by;
  }

  /**
   * Which incoming chunks this device can make from the file already at that
   * path, without asking for them.
   *
   * A name test only. Nothing is read here: the index already holds the chunk
   * names of what is on this disk, so the intersection with the incoming
   * version's names is free, and it is exact, because a chunk name is the hash
   * of the chunk's bytes.
   *
   * Two gates, both about not making a small download slower. Under
   * `REUSE_ABOVE` there is nothing to save: a note's whole body is smaller
   * than the bookkeeping. And under half the chunks in common, the read and
   * the hashing of the local file cost more than fetching the difference would.
   */
  private reusableFrom(
    batch: readonly Incoming[],
    moved: ReadonlyMap<Incoming, string>,
  ): Map<Incoming, Set<string>> {
    const out = new Map<Incoming, Set<string>>();
    for (const d of batch) {
      if (moved.has(d) || d.remote.size < REUSE_ABOVE) continue;
      const entry = this.entries.get(d.path);
      if (!entry || entry.folder || entry.chunks.length === 0) continue;
      const here = new Set(entry.chunks);
      const shared = new Set(d.chunks.filter((name) => here.has(name)));
      if (shared.size * 2 < d.chunks.length) continue;
      out.set(d, shared);
    }
    return out;
  }

  /**
   * `held`, plus the bodies made from the file this version is replacing.
   *
   * The file is cut exactly as the scan cut it, so piece `i` is the piece the
   * index named `entry.chunks[i]`, and each piece is hashed again to confirm
   * it: a name that comes back different is a file that has changed under the
   * index, and that piece is simply not offered. Nothing is trusted here that
   * is not re-derived.
   *
   * Streamed where the vault can, which is what keeps a 200 MB file to one
   * piece at a time plus the bodies actually reused. Where it cannot, the file
   * is read whole, and only up to the size the scan is willing to hold.
   *
   * A failure is not a failure of the download. Whatever could not be made is
   * fetched, which is what would have happened anyway.
   */
  private async withLocalChunks(
    d: Incoming,
    shared: ReadonlySet<string>,
    held: ReadonlyMap<string, Uint8Array>,
    report: SyncReport,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map(held);
    const need = new Set([...shared].filter((name) => !out.has(name)));
    if (need.size === 0) return out;

    const entry = this.entries.get(d.path);
    const vault = this.opts.vault;
    const isText = this.mergeable(d.path);
    let made = 0;
    try {
      const sizes = this.sizesFor(entry?.size ?? d.remote.size, isText);
      const pieces =
        vault.readBlocks && !this.cannotStream
          ? chunkStream(vault.readBlocks(d.path), sizes, isText)
          : (entry?.size ?? Infinity) <= KEEP_BODIES_BELOW
            ? chunkBytes(await vault.read(d.path), sizes, isText)
            : undefined;
      if (pieces === undefined) return out;
      for await (const piece of pieces) {
        if (need.size === 0) break;
        const name = await chunkName(piece.bytes);
        if (!need.has(name)) continue;
        out.set(name, piece.bytes);
        need.delete(name);
        made++;
      }
    } catch (err) {
      // Reading this device's own copy of a file it is about to replace is
      // never required. Say so once and fetch the rest.
      this.log("could not reuse this device's copy, fetching instead", d.path, {
        why: (err as Error).message,
      });
    }

    if (need.size > 0) {
      const each = perChunkBudget(d.remote.size, d.chunks.length);
      const names = [...need];
      const bodies = await this.fetchAll(names, () => each, [d.path]);
      names.forEach((name, i) => out.set(name, bodies[i]!));
    }
    if (made > 0) {
      this.log("reused this device's own copy", d.path, {
        chunks: made,
        of: d.chunks.length,
        fetched: need.size,
      });
      report.reusedChunks += made;
    }
    return out;
  }

  /** The chunks for one entry, asked for on their own. */
  private async fetchFor(d: Incoming): Promise<Map<string, Uint8Array>> {
    const each = perChunkBudget(d.remote.size, d.chunks.length);
    const bodies = await this.fetchAll([...d.chunks], () => each, [d.path]);
    const held = new Map<string, Uint8Array>();
    d.chunks.forEach((name, i) => held.set(name, bodies[i]!));
    return held;
  }

  /**
   * Fetches a list of chunks in as many asks as the server's caps require.
   *
   * One `fetch` may carry at most `maxFetchBytes` of summed budget and at
   * most 65536 names, and the server refuses more with `toolarge` and no
   * bodies. This device does not know the size of a chunk it has not got, so
   * it costs each at its share of the file's declared size, which for a whole
   * file adds up to exactly what the server counts. The bodies come back in
   * the order asked, across every ask.
   */
  private async fetchAll(
    names: readonly string[],
    budgetOf: (name: string) => number,
    paths: readonly string[] = [],
    /** Run between bodies on the second wire, for the open note's sake. */
    interleave?: () => Promise<void>,
  ): Promise<Uint8Array[]> {
    // History previews call this without paths: they are not a sync pass and
    // must not leave the vault's sync status busy after the preview closes.
    return this.transferring("download", paths, async (onBytes) => {
      const collect = async (
        transport: Transport,
        cap: number,
        interleave?: () => Promise<void>,
      ): Promise<Uint8Array[]> => {
        const out: Uint8Array[] = [];
        let received = 0;
        for (const ask of planFetches(names, budgetOf, cap, MAX_FETCH_NAMES)) {
          const bodies = await transport.fetch(
            ask,
            onBytes === undefined ? undefined : (n) => onBytes(received + n),
            interleave,
          );
          for (const b of bodies) {
            out.push(b);
            received += b.length;
          }
        }
        return out;
      };

      // A large download goes down the second wire, uncapped, the way a large
      // upload already does (R083-10).
      //
      // `fetchCap` is 2 MiB whenever a note is open in Obsidian, which is
      // nearly always, and a fetch cannot overlap another on the same stream:
      // a 64 MiB attachment was therefore 32 asks in series, and on a phone
      // 200 ms from its server that is over six seconds of nothing but
      // waiting. The cap is there to keep the interactive wire free, so the
      // answer is the one the uploads found: take the bulk off that wire
      // rather than slice it thinner. What is left on the main wire is
      // whatever the person is doing right now.
      const serverCap = this.limitOn("maxFetchBytes");
      const cap = this.fetchCap;
      let total = 0;
      for (const name of names) total += budgetOf(name);
      // Only when the interactive cap is the one biting. Where `fetchCap` is
      // already the server's own limit there is nothing to escape: the split
      // is the server's rule, the second wire would keep to it too, and all
      // that would change is which socket the same round trips go down.
      //
      // Only inside a sync. The second wire is opened for the length of one
      // and released in `sync`'s `finally`; a history preview or a restore
      // calls this outside one, and would leave an idle connection open until
      // whenever the next pass happened to end.
      if (
        this.syncing &&
        cap < serverCap &&
        total > cap &&
        this.opts.withUploadTransport &&
        !this.servicingInteractive
      ) {
        // With the same interleave a large upload gets: an independent saved
        // note goes out on the main wire between bodies rather than waiting
        // out the download. Sixty-four mebibytes at a megabyte a second is a
        // minute of a person's note sitting on one device.
        return await this.opts.withUploadTransport((transport) =>
          collect(transport, serverCap, interleave),
        );
      }
      return await collect(this.opts.transport, cap);
    });
  }

  private async transferring<T>(
    direction: TransferActivity["direction"],
    paths: readonly string[],
    work: (onBytes: ((bytes: number) => void) | undefined) => Promise<T>,
  ): Promise<T> {
    if (paths.length === 0 || this.opts.onTransfer === undefined) return work(undefined);
    const details = {
      direction,
      files: paths.length,
      ...(paths.length === 1 ? { path: paths[0]! } : {}),
    };
    const progress = (bytes: number) => notifyTransfer(this.opts.onTransfer, { ...details, bytes });
    progress(0);
    try {
      return await work(progress);
    } finally {
      notifyTransfer(this.opts.onTransfer, undefined);
    }
  }

  /**
   * Writes a version from a copy this device already has, or declines to.
   *
   * Declining is the important half. The index says this path holds that
   * content, and the index can be out of date: the file may have been edited
   * between the scan and here. So the bytes are re-chunked and re-hashed and
   * the names compared, which is exact rather than trusting: identical content
   * gives identical names, and that is the same property deduplication is
   * built on.
   *
   * A false negative costs one round trip, which is what the old code did
   * every time. A false positive would write the wrong bytes into somebody's
   * note, so there is no version of this worth guessing at.
   *
   * Three answers, not two. "ask" is the false negative above, and the caller
   * fetches. "kept" is the write having happened and having displaced
   * somebody's edit, which is finished business: reading it as "ask" sent the
   * pass round again to write the same bytes over the version it had just
   * put there, and made a second conflict copy holding the server's own text.
   */
  private async landFromLocal(
    d: Incoming,
    from: string,
    report: SyncReport,
  ): Promise<"landed" | "kept" | "ask"> {
    let bytes: Uint8Array;
    try {
      bytes = await this.opts.vault.read(from);
    } catch {
      return "ask";
    }
    if (bytes.length !== d.remote.size) return "ask";

    const isText = this.mergeable(from);
    const parts = [...chunkBytes(bytes, this.sizesFor(bytes.length, isText), isText)].map(
      (c) => c.bytes,
    );
    // A window at a time, because only the names are wanted: hashing every
    // part at once holds a copy of every part in flight beside the file,
    // which is the peak `rehash` is windowed to avoid. Moving a 64 MiB
    // attachment on one device makes every other device take this path, on
    // the hardware with the least memory (R083-07).
    const names = await chunkNames(parts);
    if (contentId(names) !== contentId(d.chunks)) return "ask";

    // The same check as `land`, for the same reason: this writes over
    // `d.path` too, and finding the bytes on this disk rather than on the
    // wire does not make the destination any less somebody's open note.
    if (!(await this.unchangedSince(d.path, d.based))) return "ask";

    // And the same preserving write (R19). This path used to call
    // `vault.write` straight after the stat, so a version rebuilt from chunks
    // this device already had overwrote an edit that the stat could not see,
    // while the identical download beside it kept one.
    if (
      await this.writePreserving(
        d.path,
        this.expecting(d.baseDigest),
        bytes,
        { mtime: d.remote.mtime, ctime: d.remote.mtime },
        report,
      )
    ) {
      return "kept";
    }
    this.landed(d.path);
    observe(d.entry, {
      folder: false,
      mtime: d.remote.mtime,
      ctime: d.remote.mtime,
      size: bytes.length,
    });
    d.entry.chunks = [...d.chunks];
    d.entry.hash = contentId(d.chunks);
    d.entry.size = bytes.length;
    synced(d.entry, d.entry.hash, d.entry.chunks, d.remote.uid, this.now());
    return "landed";
  }

  /**
   * Whether this path still holds the file the pass decided about (F01).
   *
   * A pass scans, decides, fetches, and only then writes. The fetch is the
   * whole of a slow link and the editor is in use throughout it, so by the
   * time the bytes arrive the note underneath may be somebody's unsaved
   * paragraph. Overwriting it loses work no other device has ever seen,
   * which is rule 1, and a report that says "downloaded 1" while it happens
   * is rule 7 as well.
   *
   * Compared against `LocalState`, whose mtime and size came from the scan
   * that informed the decision, so `Math.ceil` is applied here to match what
   * `observe` stored. Absent means absent on both sides: a note created
   * under the path during the fetch is a change, not an empty slot.
   *
   * **What this does not close.** A write landing between this stat and the
   * write below is still undetected; no adapter here offers a
   * compare-and-swap, and Obsidian's offers no locking at all. The window
   * goes from the length of a fetch to the length of one stat, which is the
   * difference between "happens on a slow link" and "happens if you hit a
   * microsecond". docs/design.md, "What is not claimed", says so.
   */
  /**
   * The plaintext digest of what is at a path now, or undefined if it cannot
   * be read (R01).
   *
   * Streamed where the vault can, so digesting a large attachment costs one
   * pass over it and not a copy of it in memory. A vault that cannot stream
   * reads it whole, which is what the pass was about to do anyway.
   */
  private async digestOf(path: string): Promise<string | undefined> {
    // The vault's own, where it has one (R31).
    //
    // This used to collect every block the vault streamed and then allocate a
    // second buffer of the whole file to join them into, which holds a large
    // attachment twice over and does it on the path that queues a download.
    // The comment called it streaming; it was not. A vault that can hash as it
    // reads keeps nothing, and the headless one can.
    const streamed = this.opts.vault.contentDigest;
    if (streamed !== undefined) return await streamed(path);
    try {
      return await plainDigest(await this.opts.vault.read(path));
    } catch {
      // A file that cannot be read is one this cannot make a promise about.
      // Undefined means "no baseline", and every caller treats that as a
      // reason to keep whatever it finds rather than to overwrite it.
      return undefined;
    }
  }

  /**
   * What the adapter should compare against, or undefined when there is no
   * baseline to compare with.
   */
  private expecting(digest: string | undefined): ExpectedContent | undefined {
    return digest === undefined ? undefined : { contentId: digest, idOf: plainDigest };
  }

  /**
   * Writes over a path, keeping anything it displaces that this pass did not
   * decide about (R01, R18, R19).
   *
   * The one door every destructive landing goes through: an ordinary download,
   * a version rebuilt from chunks this device already had, and a merge. Two of
   * those still called `vault.write` after a stat, which is the check this
   * whole mechanism exists because it is not enough.
   *
   * Returns true when something was preserved or the write did not land. Both
   * mean the incoming version is not simply in place, so the caller must not
   * record it as synced.
   *
   * A vault with no `replace` falls back to the plain write, guarded only by
   * the stat, which is what every vault had before.
   */
  private async writePreserving(
    path: string,
    expect: ExpectedContent | undefined,
    content: Uint8Array,
    times: Times,
    report: SyncReport,
  ): Promise<boolean> {
    const vault = this.opts.vault;
    if (vault.replace === undefined) {
      await vault.write(path, content, times);
      return false;
    }
    // The name a displaced version will take, worked out here because conflict
    // naming is the engine's and a name a person recognises is the point of
    // it. A sibling, so the adapter's move onto it is a rename inside one
    // directory.
    const keepAt = await this.freeConflictPath(path);
    const out = await vault.replace(path, expect, content, times, keepAt);

    if (out.keptAt !== undefined) {
      // On the disk already, under a name of its own. Nothing here has to
      // write it down, which is the difference between this and handing back
      // a buffer: no failure between the adapter and here can lose it (R18).
      this.log("kept what was already there", path, {
        why: "it changed while its next version was being fetched",
        keptAt: out.keptAt,
      });
      this.landed(out.keptAt);
      this.activity("conflict", path, out.keptAt);
      report.conflicted++;
    }
    if (!out.landed) {
      // Something else took the name in the instant it was free, and it is
      // newer than this decision. The incoming version needs a home of its own
      // rather than being dropped.
      //
      // Through `placeBeside`, like every other copy this puts next to a note.
      // It claims the name with `create` and looks again if that is refused,
      // where this branch used to pick a free name and then `write` it: the
      // same choose-then-truncate the adapters spent two rounds of review
      // having removed, reintroduced one level up in the code that handles
      // their answer.
      const beside = await placeBeside(() => this.freeConflictPath(path), content, times, vault);
      this.landed(beside);
      this.log("kept the incoming version beside", path, { at: beside });
      this.activity("conflict", path, beside);
      if (out.keptAt === undefined) report.conflicted++;
    }
    return out.keptAt !== undefined || !out.landed;
  }

  /**
   * Removes a path, and returns what it took away when that was not the
   * version the pass decided to delete (R01).
   *
   * The baseline is read here rather than carried from the scan, because a
   * deletion has no fetch in front of it: the gap this closes is between the
   * scan that listed the file and the removal at the end of the pass, and a
   * digest taken now would be taken after that gap rather than before it. So
   * the digest of record is the one from the listing where there is one, and
   * where there is not, the removal simply reports what it took.
   */
  private async removedSomethingElse(
    path: string,
    based: LocalState | undefined,
    baselines: ReadonlyMap<string, string>,
  ): Promise<string | undefined> {
    const vault = this.opts.vault;
    const digest = based === undefined || based.folder ? undefined : baselines.get(path);
    if (vault.removeExpecting === undefined) {
      await vault.remove(path);
      return undefined;
    }
    // A missing baseline is a reason to look, not a reason to skip looking
    // (R33). It used to send the deletion straight to `remove`, which takes
    // whatever is at the name: the one case R33 names, a baseline that could
    // not be read, was the one case the preserving removal was not used, and
    // the pass reported it as an ordinary deletion rather than as a conflict.
    // A folder has no baseline either and is not a thing an editor rewrites,
    // but the adapter keeps what it finds and that costs nothing.
    const keepAt = await this.freeConflictPath(path);
    const out = await vault.removeExpecting(path, this.expecting(digest), keepAt);
    return out.keptAt;
  }

  private async unchangedSince(path: string, based: LocalState | undefined): Promise<boolean> {
    let now: FileStat | undefined;
    try {
      now = await this.opts.vault.stat(path);
    } catch {
      // A vault that cannot answer is a vault that cannot promise the file is
      // untouched, so this reads as changed and both copies are kept.
      return false;
    }
    if (based === undefined) {
      if (now === undefined) return true;
      // Something is at a path the scan did not list under this name. On a
      // case-folding disk that is routinely this pass's own rename: the scan
      // listed `Note.md`, the server asked for `NOTE.md`, and a stat for the
      // second finds the first because they are one file. Writing over it is
      // the rename, not a stranger's edit, and the old name's deletion at the
      // end of the pass is what completes it.
      //
      // Anything else at an unlisted path is a file that appeared during the
      // fetch, which is the case this guard is for.
      const known = this.localByIdentity.get(this.identity(path));
      return known !== undefined && this.deletingThisPass.has(known);
    }
    if (now === undefined) return false;
    if (now.folder !== based.folder) return false;
    if (now.folder) return true;
    return now.size === based.size && Math.ceil(now.mtime) === based.mtime;
  }

  /**
   * Keeps both when the file changed under a decision already taken (F01).
   *
   * The incoming version goes beside the note rather than over it, which is
   * what `conflict` already does for a divergence the scan saw. This is the
   * same divergence, noticed later.
   */
  private async landedOnAChangedFile(
    d: Incoming,
    content: Uint8Array,
    report: SyncReport,
  ): Promise<void> {
    this.log("kept the local copy", d.path, {
      why: "it changed while its next version was being fetched",
      version: d.remote.uid,
    });
    // The entry is re-read from disk on the next pass, and must not claim the
    // scan's stale shape in the meantime.
    const entry = this.entryFor(d.path);
    await this.conflict(d.path, entry, d.remote, report, "changed during the fetch", content);
  }

  /**
   * Writes one queued version from bodies already in hand.
   *
   * False when it wrote nothing because the file changed under the decision,
   * so the caller counts a conflict rather than a download it did not do.
   */
  private async land(
    d: Incoming,
    held: Map<string, Uint8Array>,
    report: SyncReport,
  ): Promise<boolean> {
    const bodies = d.chunks.map((name) => {
      const body = held.get(name);
      if (!body) throw new Error(`the server did not send ${name}, which ${d.path} is made of`);
      return body;
    });
    // The declared size is the count of the bytes that were chunked, so the
    // check inside `assemble` is exact rather than approximate, and a mismatch
    // means the chunk list is not the one that file was made of. It runs here
    // as well as on arrival because this is the line that overwrites
    // somebody's note.
    const content = await this.assemble(
      d.remote.uid,
      `version ${d.remote.uid} of ${d.path}`,
      bodies,
      d.remote.size,
    );

    // The last thing before the bytes go down (F01).
    if (!(await this.unchangedSince(d.path, d.based))) {
      await this.landedOnAChangedFile(d, content, report);
      return false;
    }

    // And then the write itself preserves, because the check above cannot be
    // made exact (R01). A stat compares length and a rounded timestamp, which
    // is what an ordinary correction leaves alone, and there is no
    // compare-and-swap on a file to close the gap between the check and the
    // write. So the adapter moves whatever is there aside before writing over
    // it and hands back anything that was not what this decided about.
    if (
      await this.writePreserving(
        d.path,
        this.expecting(d.baseDigest),
        content,
        { mtime: d.remote.mtime, ctime: d.remote.mtime },
        report,
      )
    ) {
      return false;
    }
    this.landed(d.path);
    observe(d.entry, {
      folder: false,
      mtime: d.remote.mtime,
      ctime: d.remote.mtime,
      size: content.length,
    });
    // The chunk list is the server's, so the cache is filled without
    // re-chunking what was just reassembled, and without asking again.
    d.entry.chunks = [...d.chunks];
    d.entry.hash = contentId(d.chunks);
    d.entry.size = content.length;
    synced(d.entry, d.entry.hash, d.entry.chunks, d.remote.uid, this.now());
    return true;
  }

  /**
   * Downloads and reassembles one version's plaintext.
   *
   * Public because recovery needs it: restoring an old version is fetching
   * its content and writing it back, and there is no reason for a second copy
   * of the reassembly to exist for that.
   */
  async contentOf(uid: number, expected?: string, listedSize?: number): Promise<Uint8Array> {
    const meta = await this.opts.transport.get(uid);
    // `expected` is a content id the caller already holds for this uid, and
    // the one that matters is the merge ancestor's. A three-way merge
    // decides which side's changes are already present, so whoever chooses
    // the base chooses what can be dropped: a base equal to the local file
    // plus some paragraphs makes those paragraphs look deleted by the other
    // side, and mergeText then drops them cleanly, writes the result and
    // uploads it. No conflict copy, one counted merge, and the shortened
    // text becomes canonical everywhere.
    //
    // `entry.synchash` is this device's own record of the ancestor from the
    // last completed sync, so the server cannot move it. That is what makes
    // this check worth anything; comparing an incoming version against the
    // hash the same server announced a moment ago only catches it
    // contradicting itself.
    if (expected !== undefined && contentId(meta.chunks) !== expected) {
      throw new Error(
        `version ${uid} is made of chunks this device did not record for it, ` +
          `so it is not the version it is being offered as`,
      );
    }
    // The size, the same way, which this did not check at all. `land` does
    // (an assembled file must match its declared size) and the restore path
    // is the one that writes into somebody's vault on the worst afternoon.
    //
    // Substituted bodies are not the hole here: `fetch` hashes every body
    // against the name it asked for, so a server cannot answer one name with
    // another chunk's bytes. What this catches is an entry that contradicts
    // itself, from a writer's bug or a corrupt row: 500 bytes made of chunks
    // holding five restored as five bytes and said nothing.
    //
    // `listedSize` is the size off the history or deletion entry the caller
    // chose this version from, where it has one; `meta.size` is the server's
    // word for the same number in another answer. Where both exist they have
    // to agree, and the listed one is what the assembly is held to, because it
    // is the one a person was shown.
    if (listedSize !== undefined && listedSize !== meta.size) {
      throw new Error(
        `version ${uid} is offered as ${meta.size} bytes and was listed as ${listedSize} bytes`,
      );
    }
    const declared = listedSize ?? meta.size;
    if (meta.chunks.length === 0) {
      if (declared !== 0) {
        throw new Error(
          `version ${uid} declares ${declared} bytes and names no chunks, which cannot both be true`,
        );
      }
      return new Uint8Array(0);
    }
    this.checkChunkCount(uid, meta.chunks.length);
    const each = perChunkBudget(meta.size, meta.chunks.length);
    return await this.assemble(
      uid,
      `version ${uid}`,
      await this.fetchAll(meta.chunks, () => each),
      declared,
    );
  }

  /**
   * Held to what the server itself advertised. Both of these are the server's
   * own numbers, so refusing past them is not a policy of this client's, it is
   * declining to be told two different things.
   */
  private checkChunkCount(uid: number, count: number): void {
    const maxChunks = this.limitOn("maxChunks");
    if (count > maxChunks) {
      throw new Error(
        `version ${uid} names ${count} chunks, and this server said it stores at most ${maxChunks}`,
      );
    }
  }

  /**
   * Joins raw chunk bodies, in order, into the file they make.
   *
   * The bodies are raw and verified: the transport decoded each frame and
   * checked it against its name before anything here saw it (plan/protocol.md,
   * "Chunk bodies"), so what is left is copying them into place.
   *
   * Into one buffer of the declared size rather than a list of parts joined at
   * the end. The join shape held two copies of the file at its peak, on the
   * device with the least memory to spare (R083-06).
   *
   * Each body is dropped from the list as it is copied, which is why `bodies`
   * is mutable: both callers build it for this call alone. That is the whole
   * saving for `contentOf`, where the list is the only reference to them. It
   * is not for `land`, whose bodies are also held by the inbox until the file
   * is written; `INBOX_BYTES` bounds that for many small files and not for one
   * large one, which is a separate thing and still true.
   *
   * `declared` is the size the entry says it is. Allocating from it is what
   * makes one buffer possible, and it is why the size check that used to be
   * the caller's is made here: `out.length` is the declared length by
   * construction, so a caller comparing the two would be comparing a number
   * with itself.
   */
  private async assemble(
    uid: number,
    what: string,
    bodies: (Uint8Array | undefined)[],
    declared: number,
  ): Promise<Uint8Array> {
    if (bodies.length === 0) {
      if (declared !== 0) {
        throw new Error(`${what} assembled to 0 bytes, not the ${declared} it declares`);
      }
      return new Uint8Array(0);
    }
    const perFileMax = this.limitOn("perFileMax");
    // Before the allocation, not after it. This is the server's own number and
    // nothing has held it to anything yet, so a version claiming 4 GiB would
    // otherwise be answered by trying to allocate 4 GiB.
    if (declared > perFileMax) {
      throw new Error(
        `version ${uid} is offered as ${declared} bytes, and this server said it stores at most ${perFileMax}`,
      );
    }
    const out = new Uint8Array(declared);
    let total = 0;
    for (let at = 0; at < bodies.length; at++) {
      const part = bodies[at];
      if (part === undefined) throw new Error(`version ${uid} is missing one of its chunks`);
      bodies[at] = undefined;
      total += part.length;
      if (total > perFileMax) {
        throw new Error(
          `version ${uid} is over ${total} bytes, and this server said it stores at most ${perFileMax}`,
        );
      }
      // More bytes than the entry declares is the entry contradicting itself.
      // Kept counting so the refusal below can name the real total, and not
      // written, because there is no room for it.
      if (total <= declared) out.set(part, total - part.length);
    }
    // Rule 5, and the line that enforces it: a version made of chunks holding
    // five bytes and declaring five hundred is refused rather than written.
    // Here rather than in the callers, because `out` is allocated at the
    // declared length and a caller comparing `content.length` to `declared`
    // would now be comparing that number with itself.
    if (total !== declared) {
      throw new Error(`${what} assembled to ${total} bytes, not the ${declared} it declares`);
    }
    return out;
  }

  private async merge(
    path: string,
    entry: IndexEntry,
    remote: RemoteState | undefined,
    report: SyncReport,
  ): Promise<void> {
    if (!remote) return;

    // Turned off, so this is a conflict without looking at the bytes (I30).
    //
    // Before the decode and before the ancestor is fetched, because neither is
    // worth doing to reach a decision already made, and because the reason a
    // person reads should be the one they chose rather than whatever the text
    // would have produced.
    if (!this.merging) {
      await this.conflict(path, entry, remote, report, "merging is off on this device");
      return;
    }

    // Refusing to decode is the point. A file is classified as text by its
    // extension, and an extension is a claim rather than a fact: a `.md`
    // holding bytes that are not UTF-8 decodes with replacement characters,
    // merges cleanly, and is written back with those replacements in place
    // of bytes neither side edited. That is a file quietly altered by a sync
    // that reported success.
    //
    // So the merge is attempted only on text that really is text, and
    // anything else takes the conflict path, which keeps both versions
    // byte-for-byte and transforms neither.
    // The ancestor, fetched by the uid the index remembered. This is what
    // `synchash` and `syncuid` are for: one field to identify the common
    // ancestor and one to go and get it, with no version history on the
    // device.
    //
    // Fetched outside the decode's try, and the distinction matters. One
    // catch used to cover the fetches, the local read and the decoding, so a
    // dropped connection, a chunk the server no longer holds and bytes that
    // were never UTF-8 all became a conflict copy labelled "not valid
    // UTF-8". A transport error is not a fact about the file: it propagates,
    // is recorded against the path and is tried again. An ancestor the
    // server has purged is a fact, and it gets said as what it is.
    let baseBytes: Uint8Array;
    try {
      baseBytes = await this.contentOf(entry.syncuid, entry.synchash);
    } catch (err) {
      if (!ancestorIsGone(err)) throw err;
      const why =
        "the version both sides edited from has been purged from the server, so there is nothing to merge against";
      this.log("merge refused", path, why);
      await this.conflict(path, entry, remote, report, why);
      return;
    }
    const mineBytes = await this.opts.vault.read(path);
    // What this file was when its bytes were read, for the check before the
    // merged text is written back (F01). Between here and that write is a
    // fetch for the other side, which is a network round trip, and a merge
    // computed from a version the editor has already replaced would write
    // over the replacement with text nobody has.
    const read = await this.opts.vault.stat(path);
    const mineAt: LocalState | undefined = read && {
      folder: read.folder,
      mtime: Math.ceil(read.mtime),
      size: read.size,
      hash: "",
    };
    const theirsBytes = await this.contentOf(remote.uid, remote.hash, remote.size);

    const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let base: string;
    let mine: string;
    let theirs: string;
    try {
      base = dec.decode(baseBytes);
      mine = dec.decode(mineBytes);
      theirs = dec.decode(theirsBytes);
    } catch {
      const why = "one side is not valid UTF-8, so merging it would rewrite bytes nobody edited";
      this.log("merge refused", path, why);
      await this.conflict(path, entry, remote, report, why);
      return;
    }

    // A canvas that merged cleanly and no longer parses is a canvas
    // Obsidian refuses to open, and the four checks inside mergeText all
    // pass for it: nothing was lost and nothing collided.
    //
    // An Excalidraw drawing is the same failure under a `.md`, so it gets the
    // same treatment through a predicate of its own. Its extension is `md`, so
    // neither `looksLikeJson` nor anything else was ever asked about it, while
    // its body is a JSON scene in a fenced block that a merge concatenates
    // without a comma exactly as it does a canvas: 744 of 4,882 clean merges of
    // an empty drawing two devices both drew on (core/excalidraw.ts, and the
    // corpus in excalidraw.test.ts). The gate is built from all three versions
    // rather than named by extension alone, because it has to abstain on a
    // `.excalidraw.md` whose drawing it cannot read instead of turning every
    // merge of it into a conflict copy; the reasoning is in that module.
    const outcome = mergeText(base, mine, theirs, validityGateFor(path, base, mine, theirs));
    if (outcome.kind === "conflict") {
      this.log("merge refused", path, outcome.why);
      await this.conflict(path, entry, remote, report, outcome.why);
      return;
    }

    const text = outcome.text;
    // What is on disk when this is done, and when it was put there. Defaults
    // to the local side, because a merge whose result is already the local
    // text writes nothing and must not claim it did.
    let merged = mineBytes;
    let wroteAt = entry.mtime;
    if (text !== mine) {
      if (!(await this.unchangedSince(path, mineAt))) {
        // The merge is of a version that is no longer here, so writing it
        // would drop whatever replaced it. Both sides are kept instead, which
        // is what a divergence this pass cannot resolve has always meant.
        const why = "it changed while the other side of the merge was being fetched";
        this.log("merge refused", path, why);
        await this.conflict(path, entry, remote, report, why, theirsBytes);
        return;
      }
      // Preserving, like every other landing (R19), and with the one baseline
      // that is exactly right: `mine` is the bytes this merge was computed
      // from, so a digest of them says precisely "is the file still the one I
      // merged". The metadata check above was taken *after* those bytes were
      // read, which let a newer file wear an older baseline's stat.
      merged = new TextEncoder().encode(text);
      wroteAt = this.now();
      if (
        await this.writePreserving(
          path,
          { contentId: await plainDigest(mineBytes), idOf: plainDigest },
          merged,
          { mtime: wroteAt, ctime: entry.ctime },
          report,
        )
      ) {
        // Something else was at the path and has been kept. The merge did not
        // land as itself, so the ancestor must not move.
        return;
      }
    }
    // The local result now incorporates this remote version. Retain that
    // ancestor even if another writer wins the upload, so the next merge
    // does not treat the same already-incorporated edit as a new conflict.
    reconciled(entry, remote.hash, remote.uid, this.now());
    // The bytes that were written and the timestamp they were written with,
    // not `text.length` and a fresh clock reading (R083-20). `text.length` is
    // UTF-16 code units, so any merged note with an accent or an emoji in it
    // recorded a size the file does not have, and a second reading of the
    // clock recorded an mtime the file does not have either. Both are what
    // `needsRehash` compares against, so the note was read, chunked and
    // hashed again on the very next pass to discover it had not changed.
    observe(entry, {
      folder: false,
      mtime: wroteAt,
      ctime: entry.ctime,
      size: merged.length,
    });
    await this.upload(path, entry, report, remote.uid);
    // Counted here, where the merge happened, and not where the put commits.
    // `uploaded` is the other way round, so a flush that fails reports merges
    // whose new version never reached the server. Deliberate: the merge is a
    // fact about this device either way, the text is written and durable, and
    // the pass that failed says so through `retrying`. Moving it into the
    // commit would mean threading a callback per queued file through the
    // flush for a counter.
    report.merged++;
    this.log("merged", path, outcome.kind === "merged" ? "three-way" : outcome.why);
    this.activity("merged", path);
  }

  /**
   * A conflict copy path nothing is using yet.
   *
   * The name carries the device and the time to the minute, so two conflicts
   * on one path from one device inside the same minute produced the same
   * name, and the second write replaced the first. Two passes inside a minute
   * is ordinary: the write debounce is measured in seconds.
   *
   * That lost a note. A conflict copy is the only surviving record of one
   * side of a divergence, and quietly overwriting it is the failure the
   * conflict copy exists to prevent, one level up.
   */
  private freeConflictPath(path: string): Promise<string> {
    return firstFreeName(conflictCopyPath(path, this.opts.device, new Date(this.now())), (p) =>
      this.opts.vault.exists(p),
    );
  }

  /**
   * Keeps both versions.
   *
   * The local file stays where it is and the incoming version takes a new
   * name. Obsidian does the opposite, putting local content in the conflict
   * copy and overwriting the file with the server's, so a sync rewrites the
   * file you have open and your version appears somewhere you were not
   * looking.
   *
   * Both are then uploaded: the copy so other devices get it, and the local
   * file so the server's newest word for that path is what is actually here.
   */
  private async conflict(
    path: string,
    entry: IndexEntry,
    remote: RemoteState | undefined,
    report: SyncReport,
    why: string,
    /**
     * The incoming plaintext, when the caller already holds it.
     *
     * The landing paths do: they have just assembled it, and asking the
     * server for the same version again would be a second round trip for
     * bytes in hand, on the one path where the reason for the conflict is
     * that everything took too long already.
     */
    inHand?: Uint8Array,
  ): Promise<void> {
    if (!remote) return;
    const incoming = inHand ?? (await this.contentOf(remote.uid, remote.hash, remote.size));
    const copyPath = await placeBeside(
      () => this.freeConflictPath(path),
      incoming,
      { mtime: remote.mtime, ctime: remote.mtime },
      this.opts.vault,
    );

    const copyEntry = this.entryFor(copyPath);
    observe(copyEntry, {
      folder: false,
      mtime: remote.mtime,
      ctime: remote.mtime,
      size: incoming.length,
    });
    await this.upload(copyPath, copyEntry, report, this.remote.get(copyPath)?.uid);
    // Which is also what records that this remote version has been dealt with
    // on a device that cannot send it (RR7). That lives in `upload`, at the one
    // place that decides not to send, because it was here first and the
    // successful-merge branch went on repeating itself (RR9).
    await this.upload(path, entry, report, remote.uid);

    // On the queue, not on the commit, for the reason `merged` gives above:
    // both copies are on this disk whatever the flush then does.
    report.conflicted++;
    this.log("kept both", path, { copy: copyPath, why });
    this.activity("conflict", path, copyPath);
  }

  /**
   * Records a failure, and decides whether the file is worth trying again.
   *
   * A protocol refusal the session survives and that names the file as the
   * problem will fail identically forever, so retrying it is noise that hides
   * everything else. Anything else gets exponential backoff, in Obsidian's
   * shape: `5 * 2^n` seconds, capped at five minutes.
   */
  private recordFailure(path: string, err: unknown, report: SyncReport): void {
    let message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    if (code === "stale") {
      // A changed source must survive under its original name. Retrying as
      // a copy lets ordinary reconciliation preserve it and the moved draft.
      const entry = this.entries.get(path);
      if (entry?.prev && canonicalSpelling(entry.prev) !== path) entry.prev = "";
      const refusals = (this.staleHeads.get(path) ?? this.asked.get(path) ?? 0) + 1;
      if (refusals <= STALE_REFUSALS_BEFORE_BACKOFF) {
        // Ask for the head before deciding again (R083-01). `again` is what
        // schedules that round, and `refreshStaleHeads` is what makes the
        // round see something this one did not.
        this.staleHeads.set(path, refusals);
        this.retries.delete(path);
        report.waiting++;
        this.again = true;
        this.log("another device wrote first, reconciling next pass", path);
        return;
      }
      // Asked, told, and refused anyway. Whatever is wrong is not a head this
      // device has failed to hear about, so it stops being a same-second retry
      // and becomes an ordinary backed-off one that says so.
      this.staleHeads.delete(path);
      this.asked.delete(path);
      // Falls through to the retry below, saying what actually happened rather
      // than repeating the server's one-line refusal for the fourth time.
      message =
        `${message} (refused as out of date ${refusals} times running, ` +
        `even after asking the server for this path's current version)`;
    }
    // A connection that went away is not a fact about this file (R083-03).
    //
    // `flush` records every path its batch was carrying, so one dropped socket
    // charged two hundred and fifty-six notes a failure each and started them
    // climbing `5 * 2^n` seconds towards five minutes, for something that was
    // never about any of them. On a link that drops every few minutes the
    // counts only go up, and a note that was fine sat out five minutes for a
    // fault it had no part in.
    //
    // So it is counted as retrying, which it is, and given a flat wait instead
    // of a place in an escalation. Nothing is written off and no count is kept:
    // the next pass decides about the file again from scratch, which is the
    // right amount of memory to have about somebody's wifi.
    if (err instanceof ConnectionError) {
      noteRetrying(report, path);
      report.nextUploadAt = Math.min(
        report.nextUploadAt ?? Infinity,
        this.now() + RECONNECT_RETRY_MS,
      );
      this.log("will retry when the connection is back", path, message);
      return;
    }
    // Not a failure at all: this device was told not to sync under that name
    // and did not (R2). Remembered so no later pass fetches it again, counted
    // so it stays visible, and out of the exit code.
    if (code === "ignored") {
      if (!this.ignoredPaths.has(path)) this.log("ignored here", path, message);
      this.ignoredPaths.set(path, message);
      // Owed nothing: it will never be fetched, so leaving it on the inbound
      // work list reported work outstanding for ever when a single pass was
      // all the vault needed (N4). The reconcile loop drops it too, for
      // indexes written before this line existed.
      this.pending.delete(path);
      report.ignored++;
      return;
    }
    // `neversync` is a vault refusing to write under a name its shell never
    // syncs, which no retry changes; the others are the server's. `badpath`
    // and `collision` are a path the server will not hold, with the reason in
    // the message (plan/protocol.md, "Paths"): a stranded path the person has
    // to see, in the panel and in `trew status`, rather than a log line
    // nobody reads while the file never syncs (PLAN.md section 4.9).
    const permanent =
      code !== undefined &&
      ["badentry", "badname", "toolarge", "neversync", "badpath", "collision"].includes(code);

    if (permanent) {
      this.skipped.set(path, {
        why: `${message} ${nextStepFor(code)}`.trim(),
        fingerprint: fingerprintOf(this.entries.get(path)),
      });
      noteSkipped(report, path);
      this.log("skipped for good", path, message);
      this.activity("error", path);
      return;
    }

    const retry = this.retries.get(path) ?? { count: 0, error: "", at: 0 };
    retry.count++;
    retry.error = message;
    retry.at = this.now() + Math.min(300_000, 5_000 * Math.pow(2, retry.count));
    this.retries.set(path, retry);
    noteRetrying(report, path);
    report.nextUploadAt = Math.min(report.nextUploadAt ?? Infinity, retry.at);
    this.log("will retry", path, { attempt: retry.count, error: message });
    this.activity("error", path);
  }

  /**
   * Forgets what nothing can act on any more.
   *
   * Two halves, and for a long time there was only the first. `entries` was
   * pruned and `remote` was not, so a vault kept the server's word about every
   * path it had ever deleted, for ever, in a file rewritten on every sync. Six
   * hundred deleted notes cost around 60 KB and six hundred no-op decisions a
   * pass, growing for as long as the vault exists.
   *
   * The second half is not a cap and not a setting. A number would be
   * arbitrary and would evict on the wrong axis, and nobody can reasonably be
   * asked how many tombstones their index should keep. What is dropped here is
   * dropped because it is provably dead: the file is not on disk, the server's
   * newest word is a deletion, no index entry refers to it, and no inbound
   * work is outstanding. A record in that state can only produce a decision to
   * do nothing.
   *
   * Nothing is lost by forgetting it. A batch naming the path again repopulates
   * it, and a file reappearing at that path is a new file, which is what it is.
   * The server keeps the history either way, and `trew deleted` reads it from
   * there rather than from here.
   */
  private prune(onDisk: Map<string, unknown>): void {
    // Both loops walk the whole index on every pass and in the ordinary case
    // delete nothing, so what they cost per record is the whole of what they
    // cost. `for (const [path, x] of map)` allocates a two-element array per
    // record to destructure, which at four thousand notes a pass made this the
    // most expensive thing in a settled sync. Reading the key and looking the
    // value up allocates nothing.
    for (const path of this.entries.keys()) {
      if (onDisk.has(path)) continue;
      const entry = this.entries.get(path)!;
      const remote = this.remote.get(path);
      if (remote && !remote.deleted) continue;
      if (entry.synchash === "" && entry.hash === "") this.entries.delete(path);
    }

    // After the loop above, so a path whose entry was just dropped is
    // considered in the same pass rather than the next one.
    //
    // The four clauses are one predicate: the server's last word was a
    // deletion, this device has applied it, and nothing local still refers
    // to it. Four tests fail if the whole predicate goes, and none fails if
    // any single clause does, because in the states actually reachable the
    // clauses overlap. That is a fact about the state space rather than
    // about the clauses, and shaving it down to whatever a current test can
    // tell apart would be optimising the predicate against the tests.
    for (const path of this.remote.keys()) {
      if (!this.remote.get(path)!.deleted) continue;
      if (onDisk.has(path)) continue;
      if (this.entries.has(path)) continue;
      if (this.pending.has(path)) continue;
      this.remote.delete(path);
      this.staleHeads.delete(path);
      this.asked.delete(path);
      // With the reason it was refused, if it was. A path this device would
      // not file, whose newest word from the server is that it is gone, is
      // finished business: keeping the refusal would go on reporting a written
      // off path that no longer exists anywhere, and there would be nothing
      // anybody could do about it (R083-04, rule 7).
      this.refusedInbound.delete(path);
    }

    // The refusal memo, under its own bound rather than the one below: it is
    // keyed by every path a pass walks, which includes the ones on disk, so a
    // vault that churns through names would otherwise keep an answer about
    // each of them for the life of the process.
    if (this.refusalOf.size > onDisk.size + this.entries.size + this.remote.size) {
      const live = new Set<string>([
        ...onDisk.keys(),
        ...this.entries.keys(),
        ...this.remote.keys(),
      ]);
      for (const path of this.refusalOf.keys()) {
        if (!live.has(path)) this.refusalOf.delete(path);
      }
    }
  }

  private async save(): Promise<void> {
    // Null-prototype, because a filename is not a property name (F14).
    //
    // `entries["__proto__"] = ...` on an ordinary object does not add a key.
    // It sets the prototype, or on a frozen prototype does nothing at all, and
    // either way the assignment succeeds silently and the key is not there
    // afterwards. A vault holding a note called `__proto__` therefore
    // downloaded it, advanced the cursor, and saved an index with no record of
    // it: the note was on disk and the index had never heard of it, for ever.
    // `constructor` and `toString` are the same trick with a different name.
    //
    // Objects rather than Maps because this is what goes to JSON, and
    // `JSON.stringify` treats a null-prototype object exactly like any other.
    const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [path, e] of this.entries) entries[path] = packed(e);
    const remote: Record<string, Remote> = Object.create(null) as Record<string, Remote>;
    for (const [path, r] of this.remote) remote[path] = r;
    await this.opts.store.save({
      cursor: this.cursor,
      ...(this.epoch !== undefined ? { epoch: this.epoch } : {}),
      entries,
      remote,
      pending: [...this.pending],
    });
  }

  /**
   * Records a rename the vault reported, so it travels as one operation.
   *
   * A folder rename is one event in Obsidian, for the folder, and every path
   * beneath it has moved without a word. So everything under `from` moves
   * too: without that, each file inside read as deleted at its old path and
   * new at its new one, and the whole subtree went over the wire again.
   *
   * The local bookkeeping keyed by path moves with it: the retry clock and
   * the write-off, so a file that was stuck does not forget it was stuck by
   * being renamed. What does not move is the server's word (`remote`) or the
   * inbound work list (`pending`), because both describe the server's path,
   * and the server has not heard of the rename yet: the next pass tells it,
   * as an upload of the new name carrying `prev`, and a remote entry moved
   * ahead of that made the new name look already synced and the rename was
   * never sent.
   *
   * A destination that never syncs is refused rather than recorded. An entry
   * under a dot folder is one the listing will never show again, and an
   * entry that is never listed reconciles as a deletion.
   */
  noteRename(from: string, to: string): void {
    if (isNeverSynced(to, new Set())) {
      this.log("rename into a path that never syncs, not recorded", from, to);
      return;
    }
    this.movePath(from, to);
    const under = `${from}/`;
    const known = new Set([...this.entries.keys(), ...this.retries.keys(), ...this.skipped.keys()]);
    for (const path of known) {
      if (path.startsWith(under)) this.movePath(path, to + path.slice(from.length));
    }
  }

  /** Moves the entry and the local bookkeeping from one name to another. */
  private movePath(from: string, to: string): void {
    this.moveEntry(from, to);
    const retry = this.retries.get(from);
    if (retry !== undefined) {
      this.retries.delete(from);
      this.retries.set(to, retry);
    }
    const skip = this.skipped.get(from);
    if (skip !== undefined) {
      this.skipped.delete(from);
      this.skipped.set(to, skip);
    }
  }

  private moveEntry(from: string, to: string): void {
    const entry = this.entries.get(from);
    if (!entry) return;

    // Content follows the file; reconciliation history belongs to the path.
    // If B was moved to C before A moves to B, A's old ancestor does not
    // describe B. Inheriting it would mistake the old remote B for an edit
    // to A and download it over the moved note. The source entry below keeps
    // the UID needed to conditionally retire A when this rename commits.
    const target = this.entries.get(to);
    const moved: IndexEntry = {
      ...entry,
      chunks: [...entry.chunks],
      synchash: target?.synchash ?? "",
      syncuid: target?.syncuid ?? 0,
    };
    renamed(moved, from, to);
    this.entries.set(to, moved);

    // Keep the observed source UID until the conditional rename commits.
    // If another writer changed it, the source must be reconciled too.
  }
}

/**
 * Two passes of one sync, as one report.
 *
 * The work counters add, because they count things that happened. The state
 * counters do not: `unchanged`, `waiting`, `retrying`, `skipped`, `ignored`,
 * `blocked` and `inTheWay` describe how the vault looks at the end of a pass,
 * and adding them reported one file held back in two passes as two waiting
 * , and one unchanged file looked at four times as four unchanged. The
 * newest pass has the last word on those.
 *
 * This is also how a settle adds its passes up, which for a while it did
 * through a second copy of this function.
 */
export function combinePasses(a: SyncReport, b: SyncReport): SyncReport {
  return {
    uploaded: a.uploaded + b.uploaded,
    downloaded: a.downloaded + b.downloaded,
    merged: a.merged + b.merged,
    conflicted: a.conflicted + b.conflicted,
    deletedLocally: a.deletedLocally + b.deletedLocally,
    deletedRemotely: a.deletedRemotely + b.deletedRemotely,
    restored: a.restored + b.restored,
    foldersCreated: a.foldersCreated + b.foldersCreated,
    chunksSent: a.chunksSent + b.chunksSent,
    reusedChunks: a.reusedChunks + b.reusedChunks,
    // Summed, not replaced. `sync` runs a pass again while `again` is set, and
    // the question these answer is what the whole sync cost, so two rounds of
    // 20 ms is 40 ms and two rounds.
    ...(a.phases || b.phases ? { phases: addPhases(a.phases, b.phases) } : {}),
    bytesSent: a.bytesSent + b.bytesSent,
    unchanged: b.unchanged,
    waiting: b.waiting,
    ...(b.nextUploadAt !== undefined ? { nextUploadAt: b.nextUploadAt } : {}),
    ...(b.appliedCursor !== undefined ? { appliedCursor: b.appliedCursor } : {}),
    retrying: b.retrying,
    skipped: b.skipped,
    skippedPaths: b.skippedPaths,
    retryingPaths: b.retryingPaths,
    // The newest pass has the last word, like `ignored` and for the same
    // reason this function's own comment gives: these are what the vault
    // looks like at the end of a pass, not things that happened during one.
    // Every pass re-decides the same local changes, so adding them would
    // report one held-back note in two passes as two.
    heldBack: b.heldBack,
    heldBackPaths: b.heldBackPaths,
    ignored: b.ignored,
    blocked: b.blocked,
    inTheWay: b.inTheWay,
    needsAttention: b.needsAttention,
  };
}

/**
 * The predicate that says whether a merged file is still the kind of thing it
 * was, or undefined where there is nothing to ask.
 *
 * Its own function because it is the wiring, and wiring is the part that goes
 * untested: every gate here can exist, read correctly and be asked of nothing.
 * Unwiring this passed the whole suite before it was pulled out where a test
 * could reach it.
 *
 * For prose there is nothing to ask -- any arrangement of lines is a valid
 * note. For a structured file there is, and a line-wise merge does not know
 * it: two edits to different parts of a canvas can each apply cleanly and
 * leave JSON that does not parse, which Obsidian then refuses to open.
 *
 * Three kinds have one. JSON and canvas parse or they do not. An Excalidraw
 * drawing is a JSON scene inside a `.md`, so it is recognised by its content
 * rather than its extension and abstains where it cannot read the drawing
 * (`core/excalidraw.ts`). Markup is the newest: `.svg` was measured not to
 * need a gate, that measurement was taken with the coarse diff, and making the
 * diff exact for ordinary notes took the corpus in `markup.test.ts` from zero
 * malformed merges in 20,923 to one (I28, I31).
 */
/**
 * The server version a held-back write was answering, when it is still that
 * version.
 *
 * Out here and exported because the alternative was a condition inside
 * `upload` that nothing could ask about. It only ever declines on a device
 * that cannot send, which is a device whose `remote` map nothing commits to,
 * so the deciding case is one the read-only tests structurally cannot reach:
 * exactly the guard-that-is-asked-of-nothing this codebase keeps producing.
 *
 * Declining matters anyway. `reconciled` writes a hash and a uid together as
 * the ancestor, and a hash belonging to one version recorded against another
 * uid is a lie about what has been dealt with, which is how a later version
 * gets skipped rather than merged. So: nothing is claimed for a write that
 * answered no version, and nothing is claimed when the version it answered is
 * no longer the one the server has.
 */
export function answeredVersion(
  basedOn: number | undefined,
  remote: { uid: number; hash: string } | undefined,
): { uid: number; hash: string } | undefined {
  if (basedOn === undefined) return undefined;
  if (!remote || remote.uid !== basedOn) return undefined;
  return { uid: basedOn, hash: remote.hash };
}

export function validityGateFor(
  path: string,
  base: string,
  mine: string,
  theirs: string,
): ((text: string) => boolean) | undefined {
  if (looksLikeJson(path)) return parsesAsJson;
  if (looksLikeExcalidraw(path)) return drawingGate(base, mine, theirs);
  if (looksLikeMarkupPath(path)) return wellFormedMarkup;
  if (looksLikeYaml(path)) {
    // Abstaining where the sides already fail, the way `drawingGate` does.
    // This gate reads a subset of YAML, so a document shape it gets wrong
    // would turn every concurrent edit of that one file into a conflict copy
    // for as long as the file existed, with nothing on screen to say why.
    // Refusing a merge is only defensible when the unmerged sides pass.
    return parsesAsYaml(base) && parsesAsYaml(mine) && parsesAsYaml(theirs)
      ? parsesAsYaml
      : undefined;
  }
  return undefined;
}

/**
 * Why a path from another device is one this device will not act on, or
 * undefined for a path it will.
 *
 * The protocol's own rule (`pathReason`, plan/protocol.md, "Paths"), which the
 * server applies to every entry before it stores one. Checked again on the way
 * in because two checks are cheaper than one recovery (PLAN.md section 4.1): a
 * server is not obliged to be honest, and the dot rule in particular is what
 * stops a path under `.obsidian` being written into this vault's settings. The
 * dot rule is also the shared one from paths.ts: a dot-prefixed segment never
 * syncs in either direction, because Obsidian's index does not list it and a
 * file written and never listed is reported deleted.
 */
export function refusedInboundPath(path: string): string | undefined {
  const reason = pathReason(path);
  if (reason === undefined) return undefined;
  if (reason === "slash") {
    return path.startsWith("/")
      ? "a path starting with a slash is not canonical"
      : "a path ending with a slash is not canonical";
  }
  if (reason === "dotsegment") {
    const part = path.split("/").find((s) => s === "." || s === "..") ?? ".";
    return `a path with a ${JSON.stringify(part)} segment is not canonical`;
  }
  return INBOUND_REFUSALS[reason];
}

/** What `refusedInboundPath` says for each of the protocol's reasons. */
const INBOUND_REFUSALS: Record<PathReason, string> = {
  utf8: "a path that is not valid UTF-8",
  empty: "an empty path",
  toolong: "a path longer than the 1024 bytes the server holds",
  segmenttoolong: "a path with a name longer than the 255 bytes Android and Linux can hold",
  control: "a path with a control character in it",
  nfc: "a path that is not in Unicode NFC",
  nbsp: "a path with a no-break space in it, which Obsidian would turn into a space",
  backslash: "a path with a backslash in it, which Obsidian would turn into a slash",
  slash: "a path starting or ending with a slash is not canonical",
  emptysegment: "a path with an empty segment (//) is not canonical",
  dotsegment: "a path with a . or .. segment is not canonical",
  dotprefix: "a path under a dot-prefixed name never syncs",
  staging: "a path carrying the name the vaults give files they are staging",
};

/**
 * Enough of a file to notice it changed.
 *
 * Modification time and size rather than a content hash, because this is read
 * before the pass decides whether to re-read anything, and a hash would mean
 * reading every written-off file on every pass to find out whether it was still
 * written off.
 *
 * Taken off the index entry, which reads as though it were frozen at whatever
 * the last successful sync recorded, and is not: every pass calls `observe`
 * over the whole listing before any of these comparisons, and `observe` stamps
 * the entry with the mtime and size the disk just reported. So this is the
 * on-disk stat, one step removed, and both sides of the comparison come from
 * the same listing. That is what makes a written-off file that somebody has
 * since repaired get tried again, rather than staying written off until the
 * process restarts.
 *
 * A path with nothing on disk is not observed, so its entry keeps whatever it
 * had and a refusal that was never about a local file stays put, which is
 * right: nothing here changed.
 */
function fingerprintOf(entry: IndexEntry | undefined): string {
  return entry ? `${entry.mtime}:${entry.size}` : "gone";
}

/**
 * Below this, a file is held whole while it is chunked and sent, and above it
 * a vault that can stream reads it a block at a time instead.
 *
 * Almost every file is a note, and reading a note twice from the disk to save
 * a few kilobytes of memory is a worse trade. Above it a file is an
 * attachment, and the memory is the thing that matters: streaming keeps one
 * chunk at a time plus the offsets, and reads back only the chunks the server
 * asks for. The same line decides whether a download that can reuse this
 * device's own copy of a file may read that copy whole.
 */
const KEEP_BODIES_BELOW = 8 * 1024 * 1024;

/**
 * Below this, a download does not look at what this device already holds.
 *
 * The reuse costs a read and a hash of the local file to save fetching the
 * parts that have not changed, which is a good trade for an attachment and a
 * bad one for a note: a note's whole body is a couple of chunks, and the
 * bookkeeping is most of the work. A mebibyte is where the saving starts to be
 * worth more than the read.
 */
const REUSE_ABOVE = 1024 * 1024;

/**
 * How many chunk names one repair offer carries.
 *
 * A repair used to send one `resend` per file and wait for the answer, so a
 * vault of ten thousand notes was ten thousand round trips whatever the server
 * said: at 200 ms each, half an hour of waiting to put back a handful of
 * bodies, on the connection's serial queue.
 *
 * The server refuses a resend naming more than 65536 chunks. Four thousand is
 * well under that, keeps the request frame to a couple of hundred kilobytes,
 * and covers most vaults in a handful of round trips. It also bounds what one
 * failed batch costs: a batch that cannot be sent is reported per file, and
 * the run carries on with the next.
 */
const REPAIR_BATCH_NAMES = 4096;

/**
 * The shortest gap between two looks at whether the open note can be published
 * mid-transfer.
 *
 * The look is not free: it walks every index entry for a rename in flight, and
 * it happens between the bodies of a transfer, which for a large attachment is
 * hundreds of times. Two hundred milliseconds is invisible to a person saving a
 * note and turns a per-body cost into a per-fifth-of-a-second one.
 */
const INTERACTIVE_GAP_MS = 200;

/**
 * How many bytes of incoming version this device will queue before fetching.
 * See `receive`: the count bound is the server's and the fetch caps split
 * what goes on the wire; this one is memory, since every queued body is held
 * until its file is written.
 */
const INBOX_BYTES = 8 * 1024 * 1024;

/**
 * What one chunk of a file is costed at when only the file's size is known:
 * its share of the declared size, rounded up. Over a whole file the shares add
 * up to at least the declared size, which is the sum of the chunks' raw
 * lengths and exactly what the server's fetch budget counts.
 */
function perChunkBudget(size: number, chunks: number): number {
  return entryBudget(Math.ceil(size / Math.max(1, chunks)));
}

/**
 * Splits a chunk list into fetches, each within a byte budget and a count.
 *
 * Greedy and in order, so the bodies come back in the order the names were
 * given when the asks are made in sequence. A single name over the byte
 * budget goes on its own: the budget is a guess that is never too small, so
 * a chunk the server holds is one the server will serve alone.
 *
 * Exported because the property worth testing is that nothing in any ask is
 * over either bound and that every name is asked for exactly once.
 */
export function planFetches(
  names: readonly string[],
  budgetOf: (name: string) => number,
  maxBytes: number,
  maxNames: number,
): string[][] {
  const asks: string[][] = [];
  let ask: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const cost = budgetOf(name);
    if (ask.length > 0 && (bytes + cost > maxBytes || ask.length >= maxNames)) {
      asks.push(ask);
      ask = [];
      bytes = 0;
    }
    ask.push(name);
    bytes += cost;
  }
  if (ask.length > 0) asks.push(ask);
  return asks;
}

/**
 * Writes a copy under a free name, without ever replacing what is there.
 *
 * `exists` and then `write` is a gap, and another process, or the editor
 * somebody is typing in, can put a file under that name inside it. A conflict
 * copy or a restore landing there replaced the very file it existed to keep.
 * So where the vault can create exclusively, the name is claimed and written
 * in one step, and a name that turns out taken is passed over for the next.
 *
 * Exported because the engine's conflict copy and the client's restore are
 * the same operation with a different name in hand.
 */
export async function placeBeside(
  freeName: () => Promise<string>,
  bytes: Uint8Array,
  times: Times,
  vault: Pick<Vault, "write" | "create">,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const at = await freeName();
    if (!vault.create) {
      await vault.write(at, bytes, times);
      return at;
    }
    if (await vault.create(at, bytes, times)) return at;
    // Taken between choosing it and claiming it. The chooser looks again
    // and finds the next free name, because this one now exists.
  }
  throw new Error("could not find a name beside the note that stayed free long enough to use");
}

/**
 * A refusal carrying the code that makes it permanent.
 *
 * `recordFailure` classifies by code, and `toolarge` is one it writes off rather
 * than retries: a file does not become smaller by being tried again. The write
 * off is undone the moment the file changes, because the skip is keyed on the
 * entry's fingerprint, so somebody who trims an attachment sees it sync.
 */
function tooLarge(size: number, max: number): Error {
  const err = new Error(
    `${size} bytes, and this server said it stores at most ${max}, so it was not read`,
  );
  (err as Error & { code: string }).code = "toolarge";
  return err;
}

/**
 * One read of a file, cut and named, which an upload can use as it stands.
 *
 * Read whole, the pieces are views into `bytes` and are the bodies as they
 * stand. Streamed, only the offsets are kept, and a wanted chunk is read back
 * off the disk and hashed again.
 */
type Scanned =
  /** The file was read whole, because it was small or the vault could only hand it over whole. */
  | {
      readonly bytes: Uint8Array;
      readonly pieces: readonly { offset: number; bytes: Uint8Array }[];
      readonly names: string[];
      readonly spans?: undefined;
    }
  /** The file was streamed, and nothing of it is held but the offsets. */
  | {
      readonly names: string[];
      readonly spans: readonly { start: number; end: number }[];
      readonly path: string;
      readonly size: number;
      readonly bytes?: undefined;
    };

/** One version waiting for company in the inbox. */
interface Incoming {
  readonly path: string;
  readonly entry: IndexEntry;
  readonly remote: RemoteState;
  /** The server's own chunk list for this version, from the batch. */
  readonly chunks: readonly string[];
  readonly kind: "download" | "restoreLocal";
  readonly why: string;
  /**
   * What this path held locally when the pass decided to write over it, or
   * undefined when it held nothing.
   *
   * Checked again immediately before the write. Between the decision and the
   * write is a fetch, and the person using the vault is typing through it.
   */
  readonly based: LocalState | undefined;
  /**
   * A digest of the bytes this path held when the pass decided to write over
   * it, or undefined when it held none or could not be read (R01).
   *
   * `based` is metadata and metadata is what an ordinary edit leaves alone: a
   * corrected word is usually the same number of characters, and an editor
   * writing through a temporary file can carry the timestamp over. This is the
   * thing that actually changes, and it is what the adapter compares against
   * whatever it displaces.
   *
   * Read at decision time, which is before the fetch, so it describes the
   * version the decision was actually taken on. That costs one read of a file
   * this pass is about to overwrite anyway.
   */
  readonly baseDigest: string | undefined;
}

/** One write waiting for company in the outbox. */
interface Queued {
  /** The plaintext path, for logging and for recording a failure against. */
  readonly path: string;
  /** Roughly what holding this until the flush costs in memory. */
  readonly size: number;
  readonly entry: BatchEntry;
  readonly bodyOf: (name: string) => Promise<Uint8Array>;
  /** Record the accepted write, preserving a remote head newer than its UID. */
  readonly commit: (uid: number, remoteIsNewer: boolean) => void;
}

/** What a write says about the version it carries, before its conditions are added. */
type PutFacts = Pick<BatchEntry, "path" | "meta" | "names">;

/** What an upload needs: every chunk's name, and a way to get one's bytes. */
interface UploadPlan {
  readonly names: string[];
  readonly bodyOf: (name: string) => Promise<Uint8Array>;
}

/** For a put that carries no bodies at all: a folder, or a deletion. */
async function noBodies(name: string): Promise<Uint8Array> {
  throw new Error(`this put has no bodies, and the server asked for ${name}`);
}

/**
 * Whether a failed fetch means the server no longer has the version at all.
 *
 * `nouid` is an entry purge has removed; `nochunk` is a body it no longer
 * holds, which is what an old version's unshared chunks become. Both are the
 * server telling the truth about its history, as opposed to a connection that
 * went away or a server that answered strangely, which are not facts about
 * the version and are retried.
 */
function ancestorIsGone(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  // `nocontent` is a uid that names a folder or a deletion, which an ancestor
  // never should. If it does, there is equally nothing to merge against.
  return code === "nouid" || code === "nochunk" || code === "nocontent";
}

/** Whether text is still JSON, for the formats where that is what it means to be usable. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
