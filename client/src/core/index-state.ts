/**
 * The local index, and the decision it exists to answer.
 *
 * The most useful idea in Obsidian's engine is one field: `synchash`, the
 * content hash as of the last successful sync. It is the
 * common ancestor, so a three-way merge needs no version history on the device
 * at all. Everything here is built around that.
 *
 * The reconciliation itself is a pure function of three states, deliberately.
 * `decide` touches no filesystem, no socket and no clock, so the whole decision
 * table can be enumerated in tests, which is the only way to know a case is not
 * missing. What is left over is the part that genuinely needs Obsidian's Vault
 * API, and it is kept as thin as possible.
 */

/**
 * What the index remembers about one path.
 *
 * `hash` and `chunks` are a cache, not a record: they describe the file as of the
 * last scan and are dropped the moment the filesystem says the file moved.
 * `synchash` is a record, and is written only when a sync completes.
 */
export interface IndexEntry {
  path: string;
  /**
   * The path this file had at the last sync, when it has been renamed since.
   *
   * Set on the *first* rename and not overwritten by later ones, which is what
   * Obsidian does (`i.previouspath || (i.previouspath = t)`) and is the subtle
   * part: renaming A to B to C before syncing has to tell the server about A,
   * the name it knows, not about B, which it never saw.
   */
  prev: string;
  folder: boolean;
  ctime: number;
  mtime: number;
  size: number;
  changeId?: string;
  /**
   * Content hash as of the last scan, or "" when unknown.
   *
   * Cleared whenever mtime or size moves, which is Obsidian's trick and is
   * what keeps a scan of an unchanged vault down to one stat per file rather
   * than one read.
   */
  hash: string;
  /**
   * The chunk names for `hash`, or empty when unknown.
   *
   * The same cache one level further on. Obsidian stops at the hash because it
   * uploads whole files; TrewSync uploads chunks, so re-deriving the chunk list
   * for an unchanged file would mean re-reading, re-chunking and re-hashing it
   * to learn something already known.
   */
  chunks: string[];
  /** Content hash as of the last successful sync. The merge base. */
  synchash: string;
  /**
   * The server uid holding `synchash`, so the base *content* can be fetched
   * when a merge needs it. The hash identifies the ancestor; the uid is how to
   * get it.
   */
  syncuid: number;
  /** When the last sync of this path completed, in milliseconds. */
  synctime: number;
}

export function newEntry(path: string): IndexEntry {
  return {
    path,
    prev: "",
    folder: false,
    ctime: 0,
    mtime: 0,
    size: 0,
    hash: "",
    chunks: [],
    synchash: "",
    syncuid: 0,
    synctime: 0,
  };
}

/** What the filesystem says right now. */
export interface LocalState {
  readonly folder: boolean;
  readonly mtime: number;
  readonly size: number;
  /** Content hash, which the caller computes only when the stat has moved. */
  readonly hash: string;
}

/** What the server's newest entry for this path says. */
export interface RemoteState {
  readonly uid: number;
  readonly folder: boolean;
  readonly deleted: boolean;
  readonly mtime: number;
  readonly size: number;
  /**
   * An identity for the content: the chunk list, joined.
   *
   * Equality of content is equality of the chunk name sequence. A chunk's
   * name is the SHA-256 of its raw bytes and the chunker is deterministic, so
   * the same bytes are always the same list; see digest.ts and chunk.ts.
   */
  readonly hash: string;
}

/**
 * What to do about one path.
 *
 * Every outcome carries `why`. A sync that acts silently is one nobody can
 * debug, and rule 7 of docs/design.md is about statuses that cannot
 * distinguish between the cases they collapse.
 */
export type Action =
  | { readonly kind: "nothing"; readonly why: string }
  | { readonly kind: "upload"; readonly why: string }
  | { readonly kind: "download"; readonly why: string }
  /** Both sides moved and the file is text: fetch the base and three-way merge. */
  | { readonly kind: "merge"; readonly why: string }
  /**
   * Both sides moved and no merge is possible or safe: keep both.
   *
   * There is no field saying which one stays in place, because the answer is
   * always the local file. An earlier version returned the newer by mtime, and
   * the engine ignored it: information-wise the choice is a coin flip, and
   * "never rewrite the file somebody has open" is the better rule than "prefer
   * whichever clock ran ahead".
   */
  | { readonly kind: "conflict"; readonly why: string }
  | { readonly kind: "deleteLocal"; readonly why: string }
  | { readonly kind: "deleteRemote"; readonly why: string }
  | { readonly kind: "createLocalFolder"; readonly why: string }
  /** Local is gone and the server has content that must not be lost. */
  | { readonly kind: "restoreLocal"; readonly why: string }
  /**
   * One path, a file on one device and a folder on another.
   *
   * Reachable with any extensionless name: somebody has a note called
   * `notes`, somebody else makes a folder called `notes`. Both cannot exist,
   * and neither device may quietly destroy what it has to make room.
   *
   * Reported rather than resolved, and that is the decision. Renaming
   * somebody's file to admit a folder is a larger intervention than saying
   * the two disagree, and the person can see which of them they meant.
   * Before this existed, one direction retried an impossible mkdir for ever
   * and the other silently ignored the file.
   */
  | { readonly kind: "clash"; readonly why: string };

export interface DecideInput {
  /** Absent when the file is not on disk. */
  readonly local: LocalState | undefined;
  /** Absent when the server has never held this path. */
  readonly remote: RemoteState | undefined;
  readonly index: IndexEntry;
  /** Whether a three-way text merge is possible for this path. */
  readonly mergeable: boolean;
}

/**
 * Decides what to do about one path, from three states and nothing else.
 *
 * The shape follows Obsidian's engine, whose guard is at
 * `obsidian-sync-engine.js:1471` and whose ordering is sound. Three places
 * differ, and all three are the same principle: when the choice is between
 * losing a note and keeping something awkward, keep the awkward thing.
 *
 *   - A local delete against a remote change restores the file rather than
 *     propagating the delete. Somebody's edit outranks somebody's tidy-up, and
 *     the delete can be repeated.
 *   - A remote delete against a local change keeps the local file and re-uploads
 *     it, for the same reason.
 *   - Two versions with no common ancestor conflict rather than resolving by
 *     mtime. Obsidian downloads whichever is newer, which silently discards the
 *     other. This happens when a device is paired against a vault it already has
 *     a copy of, and identical files hash identically, so only genuinely
 *     diverged ones are affected.
 */
export function decide(input: DecideInput): Action {
  const { local, remote, index, mergeable } = input;
  const base = index.synchash;

  // Folders first: they carry no content, so most of the reasoning below has
  // nothing to work with.
  if (local?.folder || remote?.folder) {
    return decideFolder(local, remote, index);
  }

  if (local === undefined && (remote === undefined || remote.deleted)) {
    return { kind: "nothing", why: "absent on both sides" };
  }

  if (remote === undefined) {
    // The server has never seen this path.
    return { kind: "upload", why: "new file, the server has never held this path" };
  }

  if (local === undefined) {
    return decideMissingLocally(remote, index);
  }

  if (remote.deleted) {
    if (local.hash === base && base !== "") {
      return { kind: "deleteLocal", why: "deleted on another device and unchanged here" };
    }
    if (base === "") {
      // Never synced, and the server's newest word is a deletion. The file
      // here is either new or from a vault copied by hand; either way it
      // has not been sent.
      return { kind: "upload", why: "deleted on the server but never synced from here" };
    }
    return {
      kind: "upload",
      why: "deleted on another device but edited here, so the edit is kept and re-sent",
    };
  }

  if (local.hash === remote.hash) {
    return { kind: "nothing", why: "the two sides hold the same content" };
  }

  if (base === "") {
    // No common ancestor, and the two differ. There is no correct merge and
    // no honest way to pick, so both are kept.
    return {
      kind: "conflict",
      why: "both sides have content and there is no last-synced version to merge from",
    };
  }

  if (local.hash === base) {
    return { kind: "download", why: "changed on another device and unchanged here" };
  }

  if (remote.hash === base) {
    return { kind: "upload", why: "changed here and unchanged on the server" };
  }

  // Both moved since the last sync.
  if (!mergeable) {
    return { kind: "conflict", why: "changed on both sides and this file cannot be merged" };
  }
  return { kind: "merge", why: "changed on both sides since the last sync" };
}

function decideFolder(
  local: LocalState | undefined,
  remote: RemoteState | undefined,
  index: IndexEntry,
): Action {
  if (local !== undefined && local.folder) {
    if (remote === undefined) {
      return { kind: "upload", why: "new folder, the server has never held this path" };
    }
    if (remote.deleted) {
      // A folder deletion is not propagated on its own. Obsidian's engine
      // treats folders as bookkeeping, and removing one here would mean
      // deciding what to do about anything inside it that has not synced
      // yet. The files carry the truth.
      return { kind: "nothing", why: "folder deleted elsewhere; its files decide" };
    }
    if (!remote.folder) {
      // A folder here and a file of the same name there. This used to
      // fall through to "folder exists on both sides", so the file was
      // never downloaded and nothing said why.
      return { kind: "clash", why: "a folder here and a file of the same name on another device" };
    }
    return { kind: "nothing", why: "folder exists on both sides" };
  }
  // Not a folder locally.
  if (remote?.folder && !remote.deleted) {
    if (local !== undefined) {
      // A file here and a folder of the same name there. This used to
      // return createLocalFolder, which a real filesystem refuses, so the
      // device retried an impossible mkdir for ever.
      return { kind: "clash", why: "a file here and a folder of the same name on another device" };
    }
    if (index.synctime > 0) {
      // Known here once and gone now: somebody removed it. Creating it again
      // would undo that on the device it was done on, a second after they did
      // it. A folder deletion is still not propagated, so the other devices
      // keep theirs; this is only about not resurrecting it here.
      //
      // `synctime` rather than content, because a folder has none. It is set
      // when a folder entry syncs and survives `prune` while the server still
      // holds the folder, which is exactly the window this has to cover.
      return {
        kind: "nothing",
        why: "folder removed here, and deletions of folders do not travel",
      };
    }
    return { kind: "createLocalFolder", why: "folder exists on the server and not here" };
  }
  return { kind: "nothing", why: "folder absent on both sides" };
}

function decideMissingLocally(remote: RemoteState, index: IndexEntry): Action {
  const base = index.synchash;
  if (remote.deleted) {
    return { kind: "nothing", why: "deleted on both sides" };
  }
  if (base === "") {
    return { kind: "download", why: "new on the server" };
  }
  if (remote.hash === base) {
    return { kind: "deleteRemote", why: "deleted here and unchanged on the server" };
  }
  // Deleted here, changed there. The change is newer information than the
  // deletion, and a deletion can be repeated where an edit cannot be
  // recovered.
  return {
    kind: "restoreLocal",
    why: "deleted here but changed on another device, so the newer content is restored",
  };
}

/**
 * Whether a scan needs to re-read a file, given what the index remembers.
 *
 * This is the whole performance story for a routine scan, and it is Obsidian's:
 * `(i.mtime && i.mtime === o && i.size === r.size) || (i.hash = "")`. If the
 * stat has not moved, the cached hash stands and the file is not opened. A vault
 * of four thousand notes then costs four thousand stats rather than four
 * thousand reads, four thousand chunkings and four thousand rounds of hashing.
 *
 * TrewSync extends it to the chunk list, because it uploads chunks rather than
 * whole files and re-deriving that list means redoing all of the above.
 */
export function needsRehash(
  entry: IndexEntry,
  mtime: number,
  size: number,
  changeId?: string,
): boolean {
  // Do not be tempted to excuse a `changeId` difference when the inode and the
  // stat agree.
  //
  // That was tried, to stop a folder rename re-hashing every note under it: a
  // rename moves an inode's change time without touching a byte, so the
  // argument was that same device, same inode, same modification time and same
  // size must be the same bytes. It is not. An editor that writes in place and
  // then restores the modification time produces exactly that shape, and the
  // change time is the only witness left. `preservation.stress.ts` has the
  // case, it failed within one run of trying, and R071-03 is the incident the
  // change time was added for in the first place.
  if (changeId !== undefined && changeId !== entry.changeId) return true;
  // An empty file is made of no chunks, so "no chunks" cannot mean "not
  // hashed yet" for one: `contentId([])` is `-empty-`, and a synced empty
  // note was re-read, re-chunked and re-hashed on every pass for the life of
  // the vault, which is the one file where that work is certain to produce
  // nothing. The stat still decides, as it does for every other file.
  if (entry.hash === "-empty-" && entry.size === 0) return entry.mtime !== mtime || size !== 0;
  if (entry.hash === "" || entry.chunks.length === 0) return true;
  return entry.mtime !== mtime || entry.size !== size;
}

/**
 * Records a filesystem observation, dropping the content cache if the file moved.
 *
 * Timestamps are rounded up, as Obsidian does with `Math.ceil`. Filesystems and
 * platforms disagree about sub-millisecond precision, and a timestamp that
 * changes because it was read on a different platform is a file that looks
 * edited when it is not.
 */
export function observe(
  entry: IndexEntry,
  obs: { folder: boolean; mtime: number; ctime: number; size: number; changeId?: string },
): void {
  const mtime = Math.ceil(obs.mtime);
  const ctime = Math.ceil(obs.ctime);

  if (obs.folder) {
    entry.folder = true;
    entry.mtime = 0;
    entry.ctime = 0;
    entry.size = 0;
    entry.hash = "";
    entry.chunks = [];
    return;
  }

  if (needsRehash(entry, mtime, obs.size, obs.changeId)) {
    entry.hash = "";
    entry.chunks = [];
  }
  entry.folder = false;
  entry.mtime = mtime;
  entry.ctime = ctime;
  entry.size = obs.size;
  if (obs.changeId !== undefined) entry.changeId = obs.changeId;
}

/**
 * Records a rename, keeping the name the server knows.
 *
 * `prev` is set only if empty. A to B to C before a sync has to tell the server
 * about A; B is a name it never saw and cannot act on.
 */
export function renamed(entry: IndexEntry, from: string, to: string): void {
  entry.path = to;
  if (entry.prev === "") entry.prev = from;
  // If a rename returns a file to the name the server already knows, there is
  // nothing to tell it about. Leaving `prev` set would send a rename from a
  // path to itself, which the server refuses.
  if (entry.prev === to) entry.prev = "";
  entry.synctime = 0;
}

/**
 * Records a completed sync: the point at which the ancestor moves.
 *
 * The only place `synchash` is written, and it is written after the fact, never
 * in anticipation. Setting it before an upload is acknowledged would make a
 * failed push look like an agreed state, and the next divergence would merge
 * against a version the server never had.
 */
export function synced(
  entry: IndexEntry,
  hash: string,
  chunks: string[],
  uid: number,
  now: number,
): void {
  // A pass where the two sides already agreed did not sync anything, and must
  // not say it did (I07).
  //
  // The engine calls this from `case "nothing"`, which is the branch for two
  // sides that already agree, and it is right to: the ancestor has to move or
  // the next divergence merges against a version neither side has. But once
  // the ancestor is where it belongs, calling it again changes exactly one
  // field, `synctime`, to the current clock.
  //
  // That was every entry, on every pass, for ever. A settled vault of four
  // thousand notes appended 155 KiB to its index journal on each watch tick and
  // rewrote the whole 1.8 MiB snapshot whenever that log got long enough, to
  // record that nothing had happened. The store's own comment says a settled
  // vault "must write nothing at all"; nothing checked it above a handful of
  // notes, where the difference does not show.
  //
  // It was also slightly wrong on its own terms. `synctime` feeds
  // `readyToSyncAgain`, which is the debounce before re-uploading a file that
  // is being edited. Refreshing it here measured the time since agreement was
  // last confirmed rather than the time since the file last went anywhere, so
  // a pass that did nothing pushed a legitimate upload further away.
  //
  // `synctime` is deliberately not in this comparison: it is the field being
  // decided about, and including it would make every call rewrite it again.
  const same =
    entry.hash === hash &&
    entry.synchash === hash &&
    entry.syncuid === uid &&
    entry.prev === "" &&
    entry.chunks.length === chunks.length &&
    entry.chunks.every((c, i) => c === chunks[i]);
  // A zero `synctime` is read elsewhere as "never seen on this device"
  // (`decideFolder`), so the first agreement always writes even when every
  // other field already matches.
  if (same && entry.synctime !== 0) return;

  entry.hash = hash;
  entry.chunks = [...chunks];
  entry.synchash = hash;
  entry.syncuid = uid;
  entry.synctime = now;
  entry.prev = "";
}

/**
 * Records that a path has been reconciled against a remote version this device
 * will never answer (RR7).
 *
 * `synced` is for a version this device *sent*, and it writes `hash` and
 * `chunks` as well, because the local file and the agreed version are then the
 * same thing. On a read-only mirror they are not: the incoming version has been
 * dealt with -- kept beside the local note as a conflict copy -- and the local
 * edit is still unsent and always will be.
 *
 * Without this the mirror never settles. `conflict` advanced the state by
 * uploading the local version against the remote uid, the read-only guard
 * correctly stops that upload, and the entry then still shows both sides moved
 * since the ancestor. Every pass reached the same conclusion and wrote another
 * copy: eleven files after one command and twenty after the next, nineteen of
 * them the same incoming body.
 *
 * So the ancestor moves and the local content does not. The next pass sees a
 * path whose remote half matches the ancestor and whose local half does not,
 * which is an upload, which is held back and reported. That is the truth about
 * a mirror with a local edit, and it is a fixed point rather than a loop.
 *
 * `hash` and `chunks` are deliberately untouched: they describe the bytes on
 * this disk, and saying they are the agreed version would be the "failed push
 * looks like an agreed state" mistake `synced` warns about, arrived at from
 * the other direction.
 */
export function reconciled(entry: IndexEntry, synchash: string, uid: number, now: number): void {
  if (entry.synchash === synchash && entry.syncuid === uid) return;
  entry.synchash = synchash;
  entry.syncuid = uid;
  entry.synctime = now;
}

/**
 * Earliest repeat binary upload: 1 s up to 10 KiB, 2 s up to 100 KiB,
 * 5 s above that, to coalesce repeated attachment writes. The engine exempts
 * notes, other recognized text formats, and incoming reconciliation.
 */
export function nextUploadTime(entry: IndexEntry): number {
  if (!entry.synctime) return 0;
  const delay = entry.size > 102400 ? 5000 : entry.size > 10240 ? 2000 : 1000;
  return entry.synctime + delay;
}

/** Whether a repeat upload is due. A clock moved backwards must not stall it. */
export function readyToSyncAgain(entry: IndexEntry, now: number): boolean {
  return entry.synctime > now || now >= nextUploadTime(entry);
}
