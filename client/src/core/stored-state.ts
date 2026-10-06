/**
 * What a saved index has to look like before the engine will believe it.
 *
 * Both index stores handed back whatever JSON they found, and `Engine.start`
 * then spread it into entries and remote states through casts. A file that was
 * valid JSON and nothing else, an index from a future version with a field
 * renamed, or one corrupted in a way that kept the braces balanced, all became
 * engine state: a cursor of `null` read as zero and re-downloaded the vault, a
 * pending list of numbers threw somewhere far from here, and an entry with a
 * hash but no chunks read as a file already synced.
 *
 * So the whole shape is checked, field by field, before anything changes. A
 * refusal names the field, because "the index is corrupt" is not something a
 * person can act on, and says what to do, because the answer is always the
 * same: the index is a cache of what the server and the disk agree on, and
 * both still exist.
 */

import { isChunkName } from "./digest.ts";
import type { StoredState } from "./vault.ts";

/** How to get out of a refused index. Always the same, so said once. */
const RECOVERY =
  "Remove the index and sync again: it is rebuilt from the vault and the server, and nothing is lost.";

/**
 * Returns the state if it is usable, and throws naming the first thing wrong.
 *
 * `undefined` passes through: a device that has never synced has no index and
 * that is a valid state, not a broken one.
 */
export function validateStoredState(raw: unknown): StoredState | undefined {
  if (raw === undefined) return undefined;
  const refuse = (what: string): Error =>
    new Error(`the index cannot be trusted: ${what}. ${RECOVERY}`);
  if (!isObject(raw)) throw refuse("it is not an object");

  const cursor = raw["cursor"];
  if (!isCount(cursor)) throw refuse(`cursor is ${describe(cursor)}, not a non-negative integer`);

  // Optional, because an index written before the first connection has none,
  // and absent is read by the hello as "take the cursor as it is". Present, it
  // is the server's own opaque string and nothing else.
  const epoch = raw["epoch"];
  if (epoch !== undefined && (typeof epoch !== "string" || epoch === "")) {
    throw refuse(`epoch is ${describe(epoch)}, not the server's epoch`);
  }

  const entries = raw["entries"];
  if (!isObject(entries)) throw refuse("entries is not an object");
  for (const [path, entry] of Object.entries(entries)) {
    checkEntry(path, entry, refuse);
  }

  const remote = raw["remote"];
  if (!isObject(remote)) throw refuse("remote is not an object");
  for (const [path, state] of Object.entries(remote)) {
    checkRemote(path, state, refuse);
  }

  const pending = raw["pending"];
  if (!Array.isArray(pending)) throw refuse("pending is not a list");
  pending.forEach((p, i) => {
    if (!isPath(p)) throw refuse(`pending[${i}] is ${describe(p)}, not a path`);
  });

  // Cross-field: the remote index is what pending refers to, and a pending
  // path with no remote state is work that can never be done.
  for (const p of pending as string[]) {
    // `hasOwn` rather than `in`: a pending entry named `constructor` or
    // `toString` is on every object ever made and would pass a check that
    // walks the prototype chain.
    if (!Object.hasOwn(remote, p)) {
      throw refuse(`pending names ${JSON.stringify(p)}, which remote does not hold`);
    }
  }

  return {
    cursor,
    ...(epoch !== undefined ? { epoch } : {}),
    entries,
    remote,
    pending: pending as string[],
  };
}

function checkEntry(path: string, entry: unknown, refuse: (what: string) => Error): void {
  const at = `entries[${JSON.stringify(path)}]`;
  if (!isPath(path)) throw refuse(`${at} has a key that is not a path`);
  if (!isObject(entry)) throw refuse(`${at} is not an object`);
  if ("path" in entry && entry["path"] !== path) {
    throw refuse(`${at}.path is ${describe(entry["path"])}, which is not its key`);
  }
  for (const field of ["size", "syncuid", "synctime"]) {
    if (field in entry && !isCount(entry[field])) {
      throw refuse(`${at}.${field} is ${describe(entry[field])}, not a non-negative integer`);
    }
  }
  for (const field of ["ctime", "mtime"]) {
    if (field in entry && !isTime(entry[field])) {
      throw refuse(
        `${at}.${field} is ${describe(entry[field])}, not a whole number of milliseconds`,
      );
    }
  }
  if ("folder" in entry && typeof entry["folder"] !== "boolean") {
    throw refuse(`${at}.folder is ${describe(entry["folder"])}, not a boolean`);
  }
  for (const field of ["hash", "synchash", "prev", "changeId"]) {
    if (field in entry && typeof entry[field] !== "string") {
      throw refuse(`${at}.${field} is ${describe(entry[field])}, not a string`);
    }
  }
  if ("chunks" in entry) {
    const chunks = entry["chunks"];
    if (!Array.isArray(chunks) || !chunks.every(isChunkName)) {
      throw refuse(`${at}.chunks is not a list of chunk names`);
    }
  }
  // A synced file names the chunks that make it. An entry claiming a sync
  // with a content hash and no chunk list is one whose content this device
  // cannot produce or compare, and it would read as already synced.
  const synchash = entry["synchash"];
  const chunks = entry["chunks"];
  if (
    typeof synchash === "string" &&
    synchash !== "" &&
    synchash !== "-empty-" &&
    entry["folder"] !== true &&
    Array.isArray(chunks) &&
    chunks.length === 0 &&
    entry["hash"] === synchash
  ) {
    throw refuse(`${at} says it is synced as ${synchash.slice(0, 16)}... but names no chunks`);
  }
}

function checkRemote(path: string, state: unknown, refuse: (what: string) => Error): void {
  const at = `remote[${JSON.stringify(path)}]`;
  if (!isPath(path)) throw refuse(`${at} has a key that is not a path`);
  if (!isObject(state)) throw refuse(`${at} is not an object`);
  if (!isCount(state["uid"]) || state["uid"] === 0) {
    throw refuse(`${at}.uid is ${describe(state["uid"])}, not a positive integer`);
  }
  for (const field of ["folder", "deleted"]) {
    if (typeof state[field] !== "boolean") {
      throw refuse(`${at}.${field} is ${describe(state[field])}, not a boolean`);
    }
  }
  if (!isTime(state["mtime"])) {
    throw refuse(`${at}.mtime is ${describe(state["mtime"])}, not a whole number of milliseconds`);
  }
  if (!isCount(state["size"])) {
    throw refuse(`${at}.size is ${describe(state["size"])}, not a non-negative integer`);
  }
  if (typeof state["hash"] !== "string") {
    throw refuse(`${at}.hash is ${describe(state["hash"])}, not a string`);
  }
  // Optional: an index saved before versions carried their author has none.
  if (state["device"] !== undefined && typeof state["device"] !== "string") {
    throw refuse(`${at}.device is ${describe(state["device"])}, not a string`);
  }
  if (state["heads"] !== undefined) {
    if (
      !isObject(state["heads"]) ||
      !Object.entries(state["heads"]).every(([path, uid]) => isPath(path) && isCount(uid))
    ) {
      throw refuse(`${at}.heads is not a map of path version numbers`);
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * A timestamp in milliseconds, which may be before 1970 (T03).
 *
 * Held to a count once, and a count it is not: a zip entry dated 1970-01-01
 * 00:00 local time and unpacked east of UTC is -3,600,000, and so are a Windows
 * FILETIME of zero and an HFS date of 1904, below zero. The server stores what
 * it is sent, so one such file made the index of its own device and of every
 * device that received it unloadable, and removing the index, as the refusal
 * advised, rebuilt the same state. Clamping where it is observed instead would
 * make the stat disagree with the index and the file read again every pass.
 */
function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function isPath(v: unknown): v is string {
  return typeof v === "string" && v !== "" && !v.includes("\0");
}

function describe(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return Array.isArray(v) ? "a list" : "an object";
}
