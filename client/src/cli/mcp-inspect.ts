import type { Client } from "../core/client.ts";
import { receivedLatest } from "../core/delivery.ts";
import { McpHistory } from "./mcp-history.ts";
import { McpReader } from "./mcp-read.ts";
import { NOTE_BYTES, NoteError, noteDigest, noteText } from "./mcp-notes.ts";

export interface CompareInput {
  path: string;
  fromUid: number;
  toUid?: number | undefined;
  fromBase?: string | undefined;
  toBase?: string | undefined;
  after?: number | undefined;
  limit?: number | undefined;
}
interface Difference {
  fromLine: number;
  toLine: number;
  old: string;
  new: string;
  oldLines: number;
  newLines: number;
}
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
const clip = (text: string) => {
  const value = text.slice(0, 2048);
  return /\p{Surrogate}$/u.test(value) ? value.slice(0, -1) : value;
};

export function compareText(before: string, after: string) {
  const a = lines(before),
    b = lines(after);
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const changes: Difference[] = [];
  const add = (i: number, j: number, old: string[], next: string[]) => {
    if (old.length || next.length)
      changes.push({
        fromLine: i + 1,
        toLine: j + 1,
        old: old.join(""),
        new: next.join(""),
        oldLines: old.length,
        newLines: next.length,
      });
  };
  // A deterministic work cap keeps comparison pagination stable. A timed diff
  // can choose different hunks on the next page despite identical input bytes.
  const height = endA - start + 1,
    width = endB - start + 1;
  const coarse = height * width > 1_000_000;
  if (coarse) add(start, start, a.slice(start, endA), b.slice(start, endB));
  else {
    const table = new Uint32Array(height * width);
    for (let i = height - 2; i >= 0; i--)
      for (let j = width - 2; j >= 0; j--)
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0,
      j = 0,
      from = 0,
      to = 0;
    let old: string[] = [],
      next: string[] = [];
    while (i < height - 1 || j < width - 1) {
      if (i < height - 1 && j < width - 1 && a[start + i] === b[start + j]) {
        add(start + from, start + to, old, next);
        old = [];
        next = [];
        i++;
        j++;
        from = i;
        to = j;
      } else if (
        i < height - 1 &&
        (j === width - 1 || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
      )
        old.push(a[start + i++]!);
      else next.push(b[start + j++]!);
    }
    add(start + from, start + to, old, next);
  }
  return { changes, coarse };
}

export async function compareVersions(
  history: McpHistory,
  reader: McpReader,
  input: CompareInput,
  signal?: AbortSignal,
) {
  if ((input.after ?? 0) > 0 && (!input.fromBase || !input.toBase))
    throw new NoteError("missing_base", "comparison continuation requires both returned bases");
  const client = history.connection();
  const from = await history.content(input.path, input.fromUid, signal, client);
  const to =
    input.toUid === undefined
      ? await reader.run(() => reader.vault.readSnapshot(from.path, NOTE_BYTES), signal)
      : await history.content(from.path, input.toUid, signal, client);
  const fromBase = noteDigest(from.bytes),
    toBase = noteDigest(to.bytes);
  if (
    (input.fromBase !== undefined && input.fromBase !== fromBase) ||
    (input.toBase !== undefined && input.toBase !== toBase)
  )
    throw new NoteError("stale", "a compared version changed; restart comparison and reconsider");
  const diff = compareText(noteText(from.bytes), noteText(to.bytes));
  const changes: (Difference & { clipped: boolean })[] = [];
  let used = 0,
    index = input.after ?? 0;
  for (; index < diff.changes.length && changes.length < (input.limit ?? 20); index++) {
    const row = diff.changes[index]!;
    const old = clip(row.old),
      next = clip(row.new);
    const output = {
      ...row,
      old,
      new: next,
      clipped: old.length !== row.old.length || next.length !== row.new.length,
    };
    const size = Buffer.byteLength(JSON.stringify(output));
    if (used + size > 128 * 1024) break;
    used += size;
    changes.push(output);
  }
  return {
    path: from.path,
    from: { uid: input.fromUid, base: fromBase },
    to: { uid: input.toUid ?? null, base: toBase },
    identical: fromBase === toBase,
    coarse: diff.coarse,
    totalChanges: diff.changes.length,
    changes,
    nextAfter: index < diff.changes.length ? index : null,
    complete: index >= diff.changes.length,
    detailClipped: changes.some((change) => change.clipped),
    observedAt: Date.now(),
  };
}

export async function deliveryStatus(client: Client | undefined, generation: () => unknown) {
  if (!client || client.transport.isClosed)
    throw new NoteError(
      "delivery_unavailable",
      "device checkpoints require a live server connection",
    );
  const cursor = client.serverCursor,
    before = JSON.stringify(generation());
  const ready = client.deliveryReady;
  const answer = await client.devices();
  const localReady =
    ready &&
    client.deliveryReady &&
    !client.transport.isClosed &&
    client.serverCursor === cursor &&
    before === JSON.stringify(generation());
  const devices = answer.devices.slice(0, 100).map((device) => ({
    name: clip(device.name),
    online: device.online,
    lastSeen: device.lastSeen,
    applied: device.applied,
    state:
      !localReady || !device.online || device.applied === null
        ? "unconfirmed"
        : receivedLatest(device, cursor)
          ? "received"
          : "waiting",
  }));
  return {
    cursor,
    localReady,
    devices,
    omitted: Math.max(0, answer.devices.length - devices.length),
    scope:
      "Server checkpoint, not a receipt for a particular tool call. Device names are reported labels.",
    observedAt: Date.now(),
  };
}
