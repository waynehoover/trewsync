/**
 * Obsidian's list of the community plugins it runs, as a group of devices
 * shares it (plan/settings-sync.md, section 6).
 *
 * The list is one file, `community-plugins.json`, and every device in a group
 * syncs it. But some of its entries are one device's: the sync plugin, and
 * the other `DEVICE_LOCAL_PLUGINS`, whose folders never move and which sync
 * never switches on or off. Synced as it is, the list would undo itself: the
 * Mac, with obsidian-git on, sends a list naming it; a phone without it
 * applies that list, writes one without it and sends that; the Mac applies
 * it and loses obsidian-git, or puts it back and sends it again, for ever.
 *
 * So the engine is shown the list without those entries, and an incoming
 * list is written with this device's own entries for them put back as this
 * device has them. The set left out is the same on every device, so every
 * device shows the engine the same list for the same choices, and the shared
 * list never names a device-local plugin at all. A file that is not a list of
 * names is passed through untouched: the settings JSON gate decides about it,
 * as it decides about any setting that does not parse.
 */

import { plainDigest } from "../core/digest.ts";
import { COMMUNITY_PLUGINS, isDeviceLocalPlugin } from "../core/path-policy.ts";
import type { ExpectedContent, FileStat, Vault } from "../core/vault.ts";

function parseList(bytes: Uint8Array): string[] | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : undefined;
  } catch {
    return undefined;
  }
}

/** As Obsidian writes it: two-space JSON, with no newline at the end. */
function serialize(list: readonly string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(list, null, 2));
}

/**
 * The list as the group shares it: this device's own entries left out. The
 * bytes are returned as they are when there is nothing to leave out, so a
 * list Obsidian wrote is never rewritten for the sake of its spacing.
 */
export function sharedList(raw: Uint8Array): Uint8Array {
  const list = parseList(raw);
  if (list === undefined) return raw;
  const shared = list.filter((id) => !isDeviceLocalPlugin(id));
  return shared.length === list.length ? raw : serialize(shared);
}

/**
 * What to write for the group's list: its names, without any device-local
 * one it should never carry, and this device's own entries for the
 * device-local plugins as this device has them, after the group's.
 */
export function writtenList(shared: Uint8Array, current: Uint8Array | undefined): Uint8Array {
  const incoming = parseList(shared);
  if (incoming === undefined) return shared;
  const own =
    (current === undefined ? undefined : parseList(current))?.filter(isDeviceLocalPlugin) ?? [];
  const theirs = incoming.filter((id) => !isDeviceLocalPlugin(id));
  if (own.length === 0 && theirs.length === incoming.length) return shared;
  return serialize([...theirs, ...own]);
}

/**
 * `inner`, with the plugin list under `root` shown and written as the group
 * shares it, through every member the engine reads or writes a file with, so
 * no route sees the other version: its size in a listing and a stat, its
 * bytes whole, in ranges, in blocks and as a digest, and what a preserving
 * write or removal expects to find there.
 *
 * Written out member by member, as `timedVault` is, because the engine asks
 * whether a member is there to decide what a vault can do.
 */
export function sharingPluginList(inner: Vault, root: string): Vault {
  const listPath = `${root}/${COMMUNITY_PLUGINS}`;
  const raw = async (): Promise<Uint8Array | undefined> =>
    (await inner.exists(listPath)) ? inner.read(listPath) : undefined;
  const sized = async (stat: FileStat): Promise<FileStat> => {
    if (stat.folder || stat.path !== listPath) return stat;
    try {
      return { ...stat, size: sharedList(await inner.read(listPath)).length };
    } catch {
      // Gone between the listing and the read: the stat says what was there,
      // and the next scan says it is gone.
      return stat;
    }
  };
  /**
   * What a preserving write or removal should expect at the list: the bytes
   * on the disk, when they are the list the engine decided about with this
   * device's own entries in them, and otherwise what the engine said, so a
   * real change made meanwhile is still found and kept.
   */
  const onDisk = async (
    expect: ExpectedContent | undefined,
    current: Uint8Array | undefined,
  ): Promise<ExpectedContent | undefined> => {
    if (expect === undefined || current === undefined) return expect;
    if ((await expect.idOf(sharedList(current))) !== expect.contentId) return expect;
    return { contentId: await expect.idOf(current), idOf: expect.idOf };
  };

  const out: Vault = {
    list: async (options) => Promise.all((await inner.list(options)).map(sized)),
    read: async (path) =>
      path === listPath ? sharedList(await inner.read(path)) : inner.read(path),
    stat: async (path) => {
      const stat = await inner.stat(path);
      return stat === undefined ? undefined : sized(stat);
    },
    write: async (path, bytes, times) =>
      inner.write(path, path === listPath ? writtenList(bytes, await raw()) : bytes, times),
    remove: (path) => inner.remove(path),
    removeFolder: (path) => inner.removeFolder(path),
    mkdir: (path) => inner.mkdir(path),
    exists: (path) => inner.exists(path),
    ...(inner.watch ? { watch: inner.watch.bind(inner) } : {}),
    ...(inner.ambiguous ? { ambiguous: inner.ambiguous.bind(inner) } : {}),
    ...(inner.canonical ? { canonical: inner.canonical.bind(inner) } : {}),
    ...(inner.sameFile ? { sameFile: inner.sameFile.bind(inner) } : {}),
    ...(inner.flush ? { flush: () => inner.flush!() } : {}),
    ...(inner.respellFolder ? { respellFolder: (from, to) => inner.respellFolder!(from, to) } : {}),
    ...(inner.create
      ? {
          create: (path, bytes, times) =>
            inner.create!(path, path === listPath ? writtenList(bytes, undefined) : bytes, times),
        }
      : {}),
    ...(inner.replace
      ? {
          replace: async (path, expect, bytes, times, keepAt) => {
            if (path !== listPath) return inner.replace!(path, expect, bytes, times, keepAt);
            const current = await raw();
            return inner.replace!(
              path,
              await onDisk(expect, current),
              writtenList(bytes, current),
              times,
              keepAt,
            );
          },
        }
      : {}),
    ...(inner.removeExpecting
      ? {
          removeExpecting: async (path, expect, keepAt) =>
            inner.removeExpecting!(
              path,
              path === listPath ? await onDisk(expect, await raw()) : expect,
              keepAt,
            ),
        }
      : {}),
    ...(inner.readRange
      ? {
          readRange: async (path, start, end) =>
            path === listPath
              ? sharedList(await inner.read(path)).slice(start, end)
              : inner.readRange!(path, start, end),
        }
      : {}),
    ...(inner.contentDigest
      ? {
          contentDigest: async (path) =>
            path === listPath
              ? plainDigest(sharedList(await inner.read(path)))
              : inner.contentDigest!(path),
        }
      : {}),
    ...(inner.readBlocks
      ? {
          readBlocks: (path, blockSize) =>
            path === listPath
              ? blocksOf(inner, path, blockSize)
              : inner.readBlocks!(path, blockSize),
        }
      : {}),
  };
  // Read through, not copied: an adapter refreshes these on every scan.
  for (const key of ["stranded", "displaced", "recovery"] as const) {
    if (key in inner) Object.defineProperty(out, key, { get: () => inner[key], enumerable: true });
  }
  return out;
}

async function* blocksOf(
  inner: Vault,
  path: string,
  blockSize = 1024 * 1024,
): AsyncGenerator<Uint8Array> {
  const bytes = sharedList(await inner.read(path));
  for (let at = 0; at < bytes.length; at += blockSize) yield bytes.slice(at, at + blockSize);
}
