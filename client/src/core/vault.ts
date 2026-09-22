/**
 * The boundary between the engine and wherever the files actually live.
 *
 * Everything platform-specific about a client is behind this interface, and
 * there is deliberately not much of it. `obsidian-headless` is the same sync
 * engine as the desktop app with the Vault API swapped for the filesystem, so
 * the size of this interface is the size of the difference between a plugin and
 * a headless client.
 *
 * It is narrow enough that an in-memory implementation is a real one rather than
 * a mock, which is what lets two engines converge against a real server in a
 * test with no Obsidian and no disk involved.
 */

import type { Displaced, Inventory } from "./displaced.ts";

/** What a listing says about one path. */
export interface FileStat {
  readonly path: string;
  readonly folder: boolean;
  /** Milliseconds. Rounded up by the index, because platforms disagree below that. */
  readonly mtime: number;
  /**
   * Creation time, in milliseconds, or 0 when the platform will not say.
   *
   * Carried because the protocol carries it, and read by nothing. Obsidian
   * ships prebuilt native addons for five platforms to get this value, which
   * is a fair measure of how unreliable it is; anything deciding from it would
   * be deciding from a guess.
   */
  readonly ctime: number;
  readonly size: number;
  /** Local filesystem change identity, when available; never sent to peers. */
  readonly changeId?: string;
}

/**
 * The timestamps a write carries.
 *
 * Its own name because both vaults, the engine and every test double spelled
 * it out separately, and the two fields have to travel together: a downloaded
 * file stamped with the moment it landed looks locally edited on the next
 * pass.
 */
export interface Times {
  readonly mtime: number;
  readonly ctime: number;
}

/**
 * One path that two names on disk both claim, and the names claiming it.
 *
 * A disk that keeps `café.md` in NFC and the same name in NFD apart holds two
 * files for one path, and there is no right answer to which one syncs: only a
 * person can say which they meant. Both are left alone and the path is blocked
 * until they do.
 *
 * It travels beside the listing rather than in it because the two files are
 * exactly what must not be listed: listing either would sync it under the
 * shared path and record the other as gone, and omitting them with nothing
 * said would have the engine report a note it can plainly see as deleted, on
 * the strength of a spelling. Named, and no note moves under that name, and
 * every other note in the vault keeps syncing.
 */
export interface Ambiguous {
  /** The path both spellings normalize to. Nothing syncs under it. */
  readonly path: string;
  /** Every spelling on disk that normalizes to it, as the disk has them. */
  readonly spellings: readonly string[];
}

/** What the engine needs from a place files live. */
/**
 * What a caller believes is at a path, for `replace` and `removeExpecting`.
 *
 * A digest of the bytes, and not their length and timestamp. The metadata is
 * what the old check compared and is exactly what an ordinary edit can leave
 * alone: a corrected word is the same number of characters more often than
 * not, and an editor that writes through a temporary file can reuse the
 * timestamp. The digest is the thing that actually changed.
 */
export interface ExpectedContent {
  /** The engine's content id for the local version the decision was taken on. */
  readonly contentId: string;
  /** Computes the content id of bytes, so the adapter needs no crypto of its own. */
  readonly idOf: (bytes: Uint8Array) => Promise<string>;
}

/**
 * A digest of one path's contents, computed however the platform can do it
 * without holding the file (R31).
 *
 * The engine used to do this itself by collecting every block a vault streamed
 * and concatenating them, which holds the file twice over: once in the pieces
 * and once in the joined copy. For an attachment being replaced that is the
 * memory this whole mechanism is supposed to be careful with.
 *
 * Optional, and the engine falls back to reading the file whole. A vault that
 * can hash as it reads should, and the headless one can.
 */
export type ContentDigest = (path: string) => Promise<string | undefined>;

/**
 * What a preserving write or removal found in the way.
 *
 * `keptAt` is a vault path, not bytes, and that is the whole of the contract
 * (R18). Handing back a buffer meant the only copy of somebody's edit existed
 * in memory between the adapter returning and the caller writing it down, and
 * the adapter's own cleanup deleted the file it came from on the way out. A
 * failure anywhere in that window, or in the caller, lost it. So the adapter
 * moves the displaced version to a real path inside the vault before it
 * returns, and says where: it is on the disk, it is a note like any other, and
 * nothing has to remember to save it.
 *
 * An `expect` of `undefined` does not mean "write over whatever is there"
 * (R33). It means the caller could not say what it decided about: either the
 * path was new when the pass looked, or its baseline could not be read. Both
 * are reasons to keep what is found rather than reasons to destroy it, so an
 * adapter given no baseline preserves anything at all that it displaces. The
 * ordinary first download costs nothing for that, because there is nothing
 * there to displace.
 *
 * `landed` says whether the new content reached the path it was meant for.
 * False means something else took the name in the instant it was free, and
 * that file is newer than this write's decision, so it was left alone; the
 * caller has an incoming version with nowhere to go and must place it.
 */
export interface Replaced {
  /** Where a displaced local version was preserved, when there was one. */
  readonly keptAt?: string;
  /** Whether the bytes this call was given are now at the path. */
  readonly landed: boolean;
}

export interface Vault {
  /**
   * Every file and folder, excluding anything the client should not sync.
   *
   * Paths are reported in NFC. A Mac spells names on disk in NFD and every
   * other platform in NFC, and the two are one name, so a vault that handed
   * out the disk's bytes had two devices each refusing the other's spelling
   * of one note for ever. Both real vaults normalise here and map back on
   * the way in; the engine's own folding is the fallback for one that does
   * not, and it errs towards refusing rather than overwriting.
   */
  list(options?: { forceFull?: boolean }): Promise<FileStat[]>;
  /**
   * Paths the last `list` left out because two names on disk claim them.
   *
   * Optional, because a vault whose names cannot collide has none to report
   * and a vault that cannot tell says nothing rather than guessing. Read once
   * per pass, right after `list`, and only ever grows the blocked set: a vault
   * that does not offer it behaves exactly as before.
   */
  ambiguous?(): readonly Ambiguous[];
  read(path: string): Promise<Uint8Array>;
  /**
   * One path's stat, or undefined when nothing is there.
   *
   * Not a convenience over `list`. A pass decides what to do from a scan,
   * then goes to the network, then writes, and the editor is in use for the
   * whole of that gap. This is what the engine calls immediately before a
   * write or a removal that would destroy local bytes, to check the file is
   * still the one the decision was taken about.
   *
   * Required, not optional, because a vault that cannot answer would make the
   * check silently do nothing and the note it was protecting disappear
   * exactly as before. A vault that genuinely cannot stat one path should
   * answer from its own listing rather than say nothing.
   */
  stat(path: string): Promise<FileStat | undefined>;
  /**
   * Makes durable whatever the writes so far have left un-durable.
   *
   * Optional, because a vault whose writes are already durable when they return
   * has nothing to do here. Called once at the end of a pass, before the index
   * is saved, so that the index is never durable ahead of the notes it names.
   * Obsidian's `DataAdapter` has no way to ask for this, so the plugin's vault
   * cannot offer it; see the note on `ObsidianVault` about what that costs.
   */
  flush?(): Promise<void>;
  /**
   * The same bytes, in blocks, for a caller that does not need them at once.
   *
   * Optional, and the reason the engine has two paths for a large file. A
   * vault that can stream lets one be chunked, named and sent in bounded
   * memory; a vault that cannot has to hand over the whole thing.
   *
   * Both vaults offer it. The headless client streams from the file; the
   * plugin fetches the URL Obsidian's webview already uses for a file, which
   * carries a body stream and honours a Range header on desktop. Where that
   * fetch fails, as it may on a phone, the engine falls back to `read`.
   */
  readBlocks?(path: string, blockSize?: number): AsyncIterable<Uint8Array>;
  /**
   * One byte range. Needed with `readBlocks` and for the same reason.
   *
   * The chunk names go up before any body does, so the file is read once to
   * name it and then again for the chunks the server actually asks for.
   * Without this the second pass would need the whole file in hand, which is
   * the thing being avoided.
   */
  readRange?(path: string, start: number, end: number): Promise<Uint8Array>;
  /**
   * Writes a file, creating any missing folders.
   *
   * `mtime` is set to the value given, because the engine's whole decision
   * table compares timestamps, and a downloaded file stamped with the moment
   * it landed looks locally edited on the next pass.
   */
  write(path: string, bytes: Uint8Array, times: Times): Promise<void>;
  /**
   * Writes over a file, keeping whatever was there if it is not what the
   * caller expected (R01).
   *
   * The problem this exists for. A pass decides what to do from a scan, goes
   * to the network, and writes; the editor is in use for the whole of that
   * gap, and the engine's guard against it was a stat: same size, same
   * rounded mtime, so presumed untouched. An edit that changes a line without
   * changing the length, saved inside the same second or by an editor that
   * preserves timestamps, passes that check and is overwritten with no copy
   * anywhere. There is also a gap between the stat and the write itself, and
   * no filesystem here offers a compare-and-swap to close it.
   *
   * So this does not try to detect the edit and refuse. It makes the
   * destructive step non-destructive: the bytes at `path` are moved aside
   * before anything is written over them, and the caller is told what was
   * moved. Whatever was there is in hand afterwards, whether it was expected
   * or not, and a caller that finds a surprise can keep it. Rule 1 is not to
   * lose a note, and preserving beats predicting.
   *
   * `expect` is the content the caller decided about, or undefined when it
   * expected nothing at the path. Returns `replaced` with the bytes that were
   * actually there, when they were not what `expect` described, and undefined
   * when the write went over exactly what the caller meant it to.
   *
   * Optional, because a platform whose API cannot move a file aside cannot
   * offer it. Without it the engine falls back to the stat check, which is
   * what it always had.
   */
  replace?(
    path: string,
    expect: ExpectedContent | undefined,
    bytes: Uint8Array,
    times: Times,
    /**
     * A free path inside the vault where a displaced version may be kept.
     *
     * Chosen by the caller, because conflict naming is the engine's and a
     * name a person will recognise is the point of it. A sibling of `path`,
     * so the move onto it is a rename within one directory and cannot meet
     * `EXDEV` however the vault is mounted.
     */
    keepAt: string,
  ): Promise<Replaced>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /**
   * Whether two paths name the same file on this filesystem.
   *
   * Not the same question as string equality, and the difference loses notes.
   * macOS and Windows fold case, so `Note.md` and `NOTE.md` are two paths here
   * and one file there. A pass that writes one and deletes the other then
   * deletes what it just wrote.
   *
   * Optional, because only a vault that can ask the platform should answer.
   * When it is absent the engine assumes two paths differing only by case are
   * the same file, which is right on every platform the plugin runs on and
   * errs towards keeping a file rather than removing one.
   */
  sameFile?(a: string, b: string): Promise<boolean>;
  /**
   * The identity the filesystem gives a path, so two paths that would be one
   * file here can be told apart from two files.
   *
   * Two distinct paths on the server can alias one local file: `Note.md` and
   * `note.md` on a filesystem that folds case, or one name in NFC and NFD.
   * Written one after the other, the second replaced the first and both were
   * recorded as synced, and the next scan reported the first one deleted.
   *
   * Optional. Without it the engine folds case and Unicode normalisation
   * everywhere, which refuses two files that a case-sensitive disk could have
   * held apart, and that is the safe side to err on.
   */
  canonical?(path: string): string;
  /**
   * Writes a file only if nothing is at the path, and says whether it did.
   *
   * `exists` followed by `write` is a gap, and a conflict copy or a restore
   * landing in it replaces whatever another process put there first. That is
   * the one file the copy exists to keep. Optional, because a platform whose
   * API has no exclusive create cannot offer it; the engine then falls back
   * to the gap it always had.
   */
  create?(path: string, bytes: Uint8Array, times: Times): Promise<boolean>;
  /**
   * Versions this adapter took off a note and could not put anywhere, as
   * vault-relative paths (R46, R50).
   *
   * Preservation moves the displaced bytes aside before it writes, and the
   * move can fail to land anywhere: the note is then somewhere no listing
   * shows, which is safe and useless unless something says where. An adapter
   * that can strand a version answers this; one that cannot leaves it out, and
   * the shells treat that as nothing stranded.
   *
   * Refreshed by a scan, because that is when the disk is looked at.
   */
  readonly stranded?: readonly string[];
  /**
   * The same versions, with what is known about each.
   *
   * `stranded` is a list of paths and a path is not an explanation: somebody
   * looking at `note.md..telimus-tmp-keep3f9c` has to guess which note it came
   * off and why it is not at its name. These are the records the adapter wrote
   * when it displaced them, so the answer is remembered rather than inferred.
   *
   * A subset of `stranded` rather than the whole of it: a scan also finds
   * parked files nothing wrote a record for, from an older build or another
   * process, and those are reported with no more said about them than that
   * they are there.
   */
  readonly displaced?: readonly Displaced[];
  /**
   * Whether `stranded` and `displaced` are the whole of what is waiting.
   *
   * Undefined from an adapter that cannot strand anything. From one that can,
   * `complete: false` means this could not be established: the record was
   * unreadable, or something was displaced and could not be written down. An
   * empty list with `complete: false` is not a clean vault, and a shell that
   * renders it as one is the defect this field exists for (RR2, rule 2).
   */
  readonly recovery?: Inventory;

  /**
   * The digest of one path's contents, without holding the whole file (R31).
   *
   * Must agree with `ExpectedContent.idOf` over the same bytes, because the two
   * are compared. Optional; without it the engine reads the file.
   */
  contentDigest?: ContentDigest;
  /**
   * Removes a file, keeping it if it is not what the caller expected (R01).
   *
   * The deletion half of `replace`, and the same reasoning: a deletion applied
   * from a decision taken before the fetch can remove an edit made during it,
   * and a stat cannot tell. Returns the bytes it kept when they were not what
   * `expect` described, so the caller can put them back where somebody will
   * see them.
   */
  removeExpecting?(
    path: string,
    expect: ExpectedContent | undefined,
    keepAt: string,
  ): Promise<Replaced>;
  /**
   * Watches for changes, returning a function that stops watching.
   *
   * Optional. A vault that cannot watch is polled instead, which is slower to
   * notice an edit and no less correct: the scan is what decides, and an event
   * only decides when to scan.
   */
  watch?(onChange: (path: string) => void): () => void;
}

/**
 * Where the index is kept between runs.
 *
 * Separate from the vault because the two answer to different constraints: a
 * vault holds the user's notes and this holds bookkeeping, and putting
 * bookkeeping in the vault would sync it to every device and to itself.
 */
export interface IndexStore {
  load(): Promise<StoredState | undefined>;
  save(state: StoredState): Promise<void>;
}

/** What a stat says about the index file, and all this needs of one. */
export interface IndexStamp {
  readonly size: number;
  readonly mtime: number;
}

/**
 * The last index this session wrote, so an unchanged index is not written again.
 *
 * A pass ends by saving whether or not anything happened, and a settled vault
 * passes on every watch tick and every keepalive. At 2000 files that was a
 * 9 MiB serialisation and two fsyncs every thirty seconds, for ever, to record
 * that nothing had changed; at 10k it measured 21 ms of which 11 ms was the
 * flushes. Two separate audits found this independently, which is the best
 * evidence a thing is real.
 *
 * Comparing the string is not free either, but stringify is 2.1 ms against
 * 10.7 ms of fsync, so it pays for itself the first time it matches. And a
 * write skipped because the bytes on disk are already those bytes cannot lose
 * anything: the failure it would cause is the failure it prevents.
 *
 * That last sentence holds only while the bytes are still there, which is why
 * the file is asked about as well. An index removed from outside during a
 * session used to be skipped by every later unchanged pass, and the restart
 * after it started cold over a vault this device had already synced.
 *
 * Asking whether it exists was not enough either (R3). Something overwriting
 * the index in place leaves a file that is there and is not what was written,
 * and every later unchanged pass would skip over it and preserve it for the
 * rest of the session. So what is remembered is its size and modification
 * time, and the skip needs both to match. Not the content: reading nine
 * megabytes back on every settled pass is the cost this skip exists to avoid,
 * while a stat is one call whatever the index weighs.
 *
 * The residual, stated rather than hidden: an overwrite of exactly the same
 * length inside one modification-time tick is invisible here and still skips.
 * That is a corruption-only window, narrow where the clock is fine grained
 * (APFS and ext4 record nanoseconds) and real where it is not (HFS+ ticks once
 * a second, FAT once every two). Closing it means reading the file back on
 * every settled pass, which is the whole cost this skip exists to avoid.
 *
 * Here in core because it was not: the plugin's store grew the stamp and the
 * headless client's kept an existence check, so one client carried a fix the
 * other did not. Two copies of a rule is how they come to disagree.
 */
export class LastIndexWrite {
  private text: string | undefined;
  private stamp: IndexStamp | undefined;

  /** Whether `text` is on disk already, untouched since this session put it there. */
  matches(text: string, onDisk: IndexStamp | undefined): boolean {
    const was = this.stamp;
    if (text !== this.text || was === undefined || onDisk === undefined) return false;
    return onDisk.size === was.size && onDisk.mtime === was.mtime;
  }

  /**
   * Records what was just written and how it looks on disk.
   *
   * Only ever after the write is durable. Recording it first would skip the
   * write that a failed one still owes. A stamp that could not be taken is
   * remembered as none, which makes the next save write rather than skip.
   */
  wrote(text: string, onDisk: IndexStamp | undefined): void {
    this.text = text;
    this.stamp = onDisk;
  }

  /** Forgets it, for an index that has been removed on purpose. */
  forget(): void {
    this.text = undefined;
    this.stamp = undefined;
  }
}

/**
 * Everything the client must remember across a restart.
 *
 * `pending` is the inbound work list, and it is persisted on purpose. Obsidian's
 * desktop engine keeps its equivalent in memory and rebuilds it from the server;
 * its headless client persists it. Persisting is right, and the reason is rule 1
 * in different clothes: a work list that exists only in memory is one a crash
 * silently shortens, and the shortening looks exactly like having finished.
 */
export interface StoredState {
  /** The last uid this device has applied. */
  readonly cursor: number;
  /** Index entries by path. Shape mirrors IndexEntry. */
  readonly entries: Record<string, unknown>;
  /** The server's newest word per path, by plaintext path. */
  readonly remote: Record<string, unknown>;
  /** Plaintext paths with inbound work outstanding. */
  readonly pending: string[];
}

/* ---------------------------------------------------------------- *
 * In memory, for tests and for anything that needs a vault without a disk
 * ---------------------------------------------------------------- */

interface MemoryFile {
  bytes: Uint8Array;
  mtime: number;
  ctime: number;
}

/**
 * A vault held in memory.
 *
 * Not a mock: it implements the interface completely, which is what lets two
 * engines converge against a real server in a test where the only thing being
 * faked is the disk.
 *
 * Where the destructive paths are concerned it models what the two real
 * adapters *do* rather than what is easy here, and that is a rule rather than
 * a nicety. This class was wrong in both directions at once: it wrote over a
 * name a competitor had taken and called it a success, which is the R32 loss
 * modelled as working, and it identified a file and then deleted it across an
 * await, which is the R22 loss the shipped clients do not have. A fake wrong
 * in the first direction lets a defect through; one wrong in the second
 * teaches the engine to guard something that was never true.
 */
export class MemoryVault implements Vault {
  private readonly files = new Map<string, MemoryFile>();
  private readonly folders = new Set<string>();

  private listeners: ((path: string) => void)[] = [];
  /**
   * How many times a file has been read.
   *
   * Counted because the index's content cache is a performance property, and a
   * performance property with no observation is a claim. An unchanged pass
   * should read nothing.
   */
  reads = 0;

  async list(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    for (const path of this.folders) {
      out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
    }
    for (const [path, f] of this.files) {
      out.push({ path, folder: false, mtime: f.mtime, ctime: f.ctime, size: f.bytes.length });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    this.reads++;
    return f.bytes;
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const f = this.files.get(path);
    if (f) return { path, folder: false, mtime: f.mtime, ctime: f.ctime, size: f.bytes.length };
    if (this.folders.has(path)) return { path, folder: true, mtime: 0, ctime: 0, size: 0 };
    return undefined;
  }

  async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    this.files.set(path, { bytes: bytes.slice(), mtime: times.mtime, ctime: times.ctime });
    for (const parent of parents(path)) this.folders.add(parent);
    this.notify(path);
  }

  /**
   * Runs between reading what is at a path and writing over it, which is
   * where a save from the editor lands (R01).
   *
   * The seam that makes the preserving write testable. In a real vault the
   * gap is a rename and a link; here it is one statement, and without a hook
   * inside it there is no way to produce the interleaving the whole mechanism
   * exists for.
   */
  midReplace: ((path: string) => Promise<void> | void) | undefined;

  /**
   * The bytes somebody else puts at the path in the instant it is free, once.
   *
   * The real adapters reserve the destination with an exclusive create and
   * lose it when a file appears there first, which leaves the incoming version
   * with nowhere to go. That is a whole branch in the engine, and in memory
   * there is no way to reach it: a map assignment cannot fail. So it is asked
   * for, and asked for with the interloper's content, because "the write did
   * not land" and "the path is empty" are not the same vault and only the
   * first one is what an adapter reports.
   */
  nameTakenOnce: Uint8Array | undefined;

  /**
   * Writes over a file, keeping what was there when it is not what the caller
   * expected (R01, R33).
   *
   * The in-memory equivalent of the real adapter's rename-aside: read what is
   * there, write, and hand back what was displaced if it was a surprise. It
   * reads *after* the hook above, so a write landing in the gap is the version
   * this preserves rather than the one it was told to expect.
   *
   * No baseline is a surprise too. It used to be a plain overwrite, on the
   * reasoning that a path the pass had not seen has nothing worth keeping; a
   * file created in the same gap was then destroyed by the download that was
   * queued while the name was free.
   */
  async replace(
    path: string,
    expect: ExpectedContent | undefined,
    bytes: Uint8Array,
    times: Times,
    keepAt: string,
  ): Promise<Replaced> {
    await this.midReplace?.(path);
    const was = this.files.get(path);
    // Read after the hook, so a write landing in the gap is the version this
    // preserves rather than the one it was told to expect.
    if (was === undefined) {
      // Both real adapters publish with an exclusive create even when they
      // displaced nothing, so a save that takes the name first keeps it and
      // the call reports `landed: false`. This branch used to write anyway,
      // discard the interloper's bytes and answer `landed: true`, which is
      // the R32 loss modelled as a success: a test arming the seam on a first
      // download would have passed while asserting the opposite.
      const taken = this.nameTakenOnce;
      this.nameTakenOnce = undefined;
      if (taken !== undefined) {
        await this.write(path, taken, times);
        return { landed: false };
      }
      await this.write(path, bytes, times);
      return { landed: true };
    }
    // Moved to its own path before anything is written over it, and it stays
    // there: the caller is told where, not handed a buffer (R18).
    this.files.set(keepAt, was);
    this.files.delete(path);
    const taken = this.nameTakenOnce;
    this.nameTakenOnce = undefined;
    await this.write(path, taken ?? bytes, times);
    const landed = taken === undefined;
    // With no baseline there is nothing it can match, so it is kept (R33).
    const agreed =
      landed && expect !== undefined && (await expect.idOf(was.bytes)) === expect.contentId;
    if (agreed) {
      // A duplicate of what the server already has.
      this.files.delete(keepAt);
      this.notify(keepAt);
      return { landed };
    }
    this.notify(keepAt);
    return { keptAt: keepAt, landed };
  }

  /** The deletion half, and the same reasoning. */
  async removeExpecting(
    path: string,
    expect: ExpectedContent | undefined,
    keepAt: string,
  ): Promise<Replaced> {
    await this.midReplace?.(path);
    const was = this.files.get(path);
    if (was === undefined) {
      await this.remove(path);
      return { landed: true };
    }
    // Taken off the name first, and identified afterwards, which is what both
    // real adapters do (R22): the plugin moves the note into a hidden folder
    // and the headless client renames it beside itself, and only then is it
    // hashed. This used to identify and then delete across an await, so a save
    // in that window was destroyed here and kept by both shipped clients --
    // the fake losing a note the real thing does not, which is the direction
    // that teaches a test the wrong lesson.
    // The seams belong here, where the note leaves its name, because that is
    // the step a real adapter can fail at: a rename-aside that refuses has
    // moved nothing, and the error travels with the file still in place.
    await this.beforeRemove?.(path);
    if (this.failRemoveOnce === path) {
      this.failRemoveOnce = undefined;
      throw new Error(`refusing to remove ${path}, as a locked file would`);
    }
    this.files.delete(path);
    this.notify(path);
    // With no baseline there is nothing it can match, so it is kept (R33).
    const agreed = expect !== undefined && (await expect.idOf(was.bytes)) === expect.contentId;
    if (agreed) {
      // The version the pass decided to delete, disposed of where it is. Not
      // by putting it back at the path first: the whole point of taking it off
      // the name is that whatever is at the name now is somebody else's.
      return { landed: true };
    }
    this.files.set(keepAt, was);
    this.notify(keepAt);
    return { keptAt: keepAt, landed: true };
  }

  /**
   * Hashes without holding the file, which in memory is the same thing.
   *
   * The import is deferred because this module has no others: it is the
   * interface every vault implements, and the plugin, the CLI and the engine
   * all reach it. Pulling `crypto.ts` in at the top would put the whole cipher
   * suite into any bundle that only wanted the type.
   */
  contentDigest = async (path: string): Promise<string | undefined> => {
    const f = this.files.get(path);
    if (f === undefined) return undefined;
    const { plainDigest } = await import("./crypto.ts");
    return plainDigest(f.bytes);
  };

  /**
   * Makes the next removal of this path fail, once.
   *
   * A test seam, and a narrow one. Applying an incoming deletion can fail for
   * ordinary reasons on a real device, a locked file being the obvious one,
   * and what the engine does next is a durability question rather than a
   * cosmetic one. There is no other way to produce it.
   */
  failRemoveOnce: string | undefined;

  /**
   * Runs just before a removal, which is where an editor's write would land.
   *
   * The sibling of the fetch callback the download races use. A deletion
   * carries no body, so there is no network round trip to hide an edit
   * inside, and this is the only way to produce one at the moment that
   * matters.
   */
  beforeRemove: ((path: string) => Promise<void> | void) | undefined;

  async remove(path: string): Promise<void> {
    await this.beforeRemove?.(path);
    if (this.failRemoveOnce === path) {
      this.failRemoveOnce = undefined;
      throw new Error(`refusing to remove ${path}, as a locked file would`);
    }
    this.files.delete(path);
    this.folders.delete(path);
    this.notify(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
    for (const parent of parents(path)) this.folders.add(parent);
    this.notify(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async create(path: string, bytes: Uint8Array, times: Times): Promise<boolean> {
    if (this.files.has(path) || this.folders.has(path)) return false;
    await this.write(path, bytes, times);
    return true;
  }

  watch(onChange: (path: string) => void): () => void {
    this.listeners.push(onChange);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== onChange);
    };
  }

  private notify(path: string): void {
    for (const l of this.listeners) l(path);
  }

  /* Test conveniences, outside the interface. */

  /** Writes as a user would, so mtime moves and the engine notices. */
  async edit(path: string, content: string, mtime = Date.now()): Promise<void> {
    await this.write(path, new TextEncoder().encode(content), { mtime, ctime: mtime });
  }

  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.bytes) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Everything in the vault, for comparing two of them. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, f] of this.files) out[path] = new TextDecoder().decode(f.bytes);
    return out;
  }
}

/** An index store held in memory, for the same reason. */
export class MemoryIndexStore implements IndexStore {
  private state: StoredState | undefined;
  saves = 0;

  async load(): Promise<StoredState | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: StoredState): Promise<void> {
    this.state = structuredClone(state);
    this.saves++;
  }
}

/** Every folder above a path, outermost first. */
export function parents(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const out: string[] = [];
  let at = "";
  for (const part of parts) {
    at = at ? `${at}/${part}` : part;
    out.push(at);
  }
  return out;
}

/**
 * A vault that reports how long it spent inside the adapter, by operation.
 *
 * An overlay rather than a phase. Filesystem time cuts across listing,
 * deciding, transferring and saving, so reporting it as a fifth term would
 * double-count; reporting it per operation says which call is expensive
 * without pretending it belongs to one part of a pass.
 *
 * This exists for one question. On a desktop the adapter is Node's `fs`; on
 * Android it is Obsidian's `DataAdapter` over a Capacitor bridge onto a
 * FUSE-backed mount, and the per-call cost is not the same animal. Whether
 * that difference matters is exactly what docs/open-work.md is waiting on, and
 * a guess about it would not settle anything.
 *
 * Results and failures pass through untouched, and the timing is recorded for
 * a rejection as well as a return: an operation that took two seconds and then
 * threw still took two seconds. `watch` is not wrapped, because it is a
 * subscription rather than an operation and its duration means nothing.
 *
 * Synchronous members (`ambiguous`, `canonical`, `sameFile`) are forwarded
 * rather than timed: they read state the adapter already has, and wrapping them
 * would cost more than it measured. The index store is not here at all, because
 * it is its own interface with its own hook (`JournalStoreOptions.onSave`).
 */
export function timedVault(
  inner: Vault,
  into: Record<string, { ms: number; calls: number }>,
): Vault {
  const time = <T>(op: string, run: () => Promise<T>): Promise<T> => {
    const at = performance.now();
    const done = (): void => {
      const seen = (into[op] ??= { ms: 0, calls: 0 });
      seen.ms += performance.now() - at;
      seen.calls++;
    };
    return run().then(
      (value) => {
        done();
        return value;
      },
      (err: unknown) => {
        done();
        throw err;
      },
    );
  };

  // Written out rather than built from a proxy. A proxy would forward
  // everything including the optional members, and the engine decides what an
  // adapter can do by asking whether the method is there: a proxy that answers
  // every name would tell it every vault can stream.
  const out: Vault = {
    list: (options) => time("list", () => inner.list(options)),
    read: (path) => time("read", () => inner.read(path)),
    stat: (path) => time("stat", () => inner.stat(path)),
    write: (path, bytes, times) => time("write", () => inner.write(path, bytes, times)),
    remove: (path) => time("remove", () => inner.remove(path)),
    mkdir: (path) => time("mkdir", () => inner.mkdir(path)),
    exists: (path) => time("exists", () => inner.exists(path)),
    ...(inner.watch ? { watch: inner.watch.bind(inner) } : {}),
    ...(inner.ambiguous ? { ambiguous: inner.ambiguous.bind(inner) } : {}),
    ...(inner.canonical ? { canonical: inner.canonical.bind(inner) } : {}),
    ...(inner.sameFile ? { sameFile: inner.sameFile.bind(inner) } : {}),
    ...(inner.flush ? { flush: () => time("flush", () => inner.flush!()) } : {}),
    ...(inner.create
      ? { create: (path, bytes, times) => time("create", () => inner.create!(path, bytes, times)) }
      : {}),
    ...(inner.replace
      ? {
          replace: (path, expect, bytes, times, keepAt) =>
            time("replace", () => inner.replace!(path, expect, bytes, times, keepAt)),
        }
      : {}),
    ...(inner.removeExpecting
      ? {
          removeExpecting: (path, expect, keepAt) =>
            time("removeExpecting", () => inner.removeExpecting!(path, expect, keepAt)),
        }
      : {}),
    ...(inner.readRange
      ? {
          readRange: (path, start, end) =>
            time("readRange", () => inner.readRange!(path, start, end)),
        }
      : {}),
    ...(inner.readBlocks
      ? {
          // Timed as one span over the whole stream, because that is the thing
          // a caller waits for. Per-block timing would measure how fast the
          // consumer asked.
          readBlocks: (path, blockSize) => inner.readBlocks!(path, blockSize),
        }
      : {}),
  };
  return out;
}
