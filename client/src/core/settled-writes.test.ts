/**
 * A settled vault writes nothing, end to end (I07).
 *
 * index-journal-store.test.ts already asserts this, and the store already keeps
 * it: hand it the same state twice and it writes nothing the second time. What
 * nothing checked is whether the engine ever hands it the same state twice, and
 * it did not. `case "nothing"` is the branch for two sides that already agree,
 * and it called `synced`, which stamped `synctime` with the current clock. So
 * every entry differed from the last pass by one field, on every pass, and the
 * store dutifully journalled all of them.
 *
 * Four thousand notes appended 155 KiB per watch tick and rewrote the whole
 * 1.8 MiB snapshot whenever that log grew long enough, to record that nothing
 * had happened. The quiet pass cost 40 ms where it now costs 17.
 *
 * The reason it survived is worth keeping in view: both halves were tested and
 * both halves passed. The store was given identical states by construction, and
 * every engine test runs a handful of notes for a pass or two, where one extra
 * journal record is invisible. The bug lived exactly in the join between them.
 *
 * So this test owns the join, and it asserts on states rather than on bytes or
 * milliseconds: what a pass hands the store is what decides everything
 * downstream, and it is the thing with a right answer.
 */

import { describe, expect, it } from "vitest";

import { macEntry, sealChunks, sealPath, type Schedule } from "./crypto.ts";
import { engineOnFakeSocket, settle } from "./fake-socket.ts";
import { deltaBetween } from "./index-journal.ts";
import type { StoredState } from "./vault.ts";
import type { WireEntry } from "./transport.ts";

const enc = new TextEncoder();

async function entryFor(
  keys: Schedule,
  uid: number,
  path: string,
  text: string,
  bodies: Map<string, Uint8Array>,
): Promise<WireEntry> {
  const plain = enc.encode(text);
  const [chunk] = await sealChunks(keys, [plain]);
  bodies.set(chunk!.name, chunk!.bytes);
  const facts = {
    path: await sealPath(keys, path),
    size: plain.length,
    ctime: 1000,
    mtime: 1000,
    folder: false,
    deleted: false,
    chunks: [chunk!.name],
    parent: "",
  };
  return { uid, ...facts, device: "other", mac: await macEntry(keys, facts) };
}

/** A deep copy, so a state the engine goes on mutating stays as it was handed over. */
const frozen = (s: StoredState): StoredState => JSON.parse(JSON.stringify(s)) as StoredState;

describe("a vault where both sides agree", () => {
  it("hands the store nothing new, however many times it passes", async () => {
    const { engine, socket, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch")
        s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      else if (frame["op"] === "ping") s.raw({ res: "pong" });
    };

    // Enough entries, in folders, that a per-entry mistake is unmistakable.
    // Folders take a different branch of `case "nothing"` from files and had
    // the same bug, so both are here.
    const count = 30;
    const entries: WireEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push(
        await entryFor(
          keys,
          i + 1,
          `folder-${i % 5}/note-${i}.md`,
          `note ${i} says something`,
          bodies,
        ),
      );
    }
    socket.raw({ op: "batch", from: 1, to: count, entries });
    for (let i = 0; i < 400 && engine.status().pending < count; i++) await settle();

    // Settle: pass until the engine stops changing its mind. Both sides now
    // hold the same content for every path, which is the state this is about.
    for (let i = 0; i < 6; i++) await engine.sync({ coalesceWrites: false });

    const store = (
      engine as unknown as { opts: { store: { save(s: StoredState): Promise<void> } } }
    ).opts.store;
    const real = store.save.bind(store);
    let last: StoredState | undefined;
    const differed: string[] = [];
    store.save = async (s: StoredState) => {
      const copy = frozen(s);
      if (last !== undefined) {
        const delta = deltaBetween(last, copy);
        if (delta !== undefined) differed.push(JSON.stringify(delta).slice(0, 400));
      }
      last = copy;
      return real(s);
    };

    // The vault has not changed and neither has the server. Ten passes, which
    // is a few seconds of a watcher and a keepalive doing their jobs.
    await engine.sync({ coalesceWrites: false });
    for (let i = 0; i < 10; i++) await engine.sync({ coalesceWrites: false });

    expect(last, "no pass reached the store, so this proves nothing").toBeDefined();
    expect(
      differed,
      `a settled vault handed the store ${differed.length} different states:\n${differed.slice(0, 2).join("\n")}`,
    ).toEqual([]);
  });
});

describe("synced, on a path that was already synced", () => {
  it("leaves the entry exactly as it was, clock included", async () => {
    const { newEntry, synced } = await import("./index-state.ts");
    const entry = newEntry("note.md");
    synced(entry, "abc", ["chunk-a"], 7, 1000);
    const after = { ...entry, chunks: [...entry.chunks] };

    // The same agreement, confirmed again at a later time. Nothing about the
    // path has moved, so nothing about the entry may.
    synced(entry, "abc", ["chunk-a"], 7, 9999);
    expect(entry, "confirming an agreement rewrote the entry").toEqual(after);
  });

  it("still records the first agreement, even when every field already matches", async () => {
    const { newEntry, synced } = await import("./index-state.ts");
    const entry = newEntry("folder");
    // A folder: hash "", no chunks, and uid 0 is what a fresh entry already
    // has. Nothing here differs, and it still has to be recorded, because a
    // zero synctime is read elsewhere as "never seen on this device" and a
    // folder that never records one gets put back after it is removed.
    synced(entry, "", [], 0, 4242);
    expect(entry.synctime, "the first agreement was skipped as a no-op").toBe(4242);
  });

  it("writes when anything real has moved", async () => {
    const { newEntry, synced } = await import("./index-state.ts");
    const base = () => {
      const e = newEntry("note.md");
      synced(e, "abc", ["chunk-a"], 7, 1000);
      return e;
    };
    for (const [what, apply] of [
      ["the content", (e: ReturnType<typeof base>) => synced(e, "def", ["chunk-a"], 7, 2000)],
      ["the chunks", (e: ReturnType<typeof base>) => synced(e, "abc", ["chunk-b"], 7, 2000)],
      [
        "how many chunks",
        (e: ReturnType<typeof base>) => synced(e, "abc", ["chunk-a", "b"], 7, 2000),
      ],
      [
        "the server's version",
        (e: ReturnType<typeof base>) => synced(e, "abc", ["chunk-a"], 8, 2000),
      ],
    ] as const) {
      const e = base();
      apply(e);
      expect(e.synctime, `${what} changed and the sync was not recorded`).toBe(2000);
    }
  });

  it("clears a pending rename even when nothing else moved", async () => {
    const { newEntry, synced } = await import("./index-state.ts");
    const entry = newEntry("note.md");
    synced(entry, "abc", ["chunk-a"], 7, 1000);
    // A rename the server has now been told about. `prev` is the whole record
    // of that, and leaving it set would send the rename again on every pass.
    entry.prev = "old-name.md";
    synced(entry, "abc", ["chunk-a"], 7, 2000);
    expect(entry.prev, "the old name was left on the entry").toBe("");
    expect(entry.synctime, "a rename being acknowledged is a sync").toBe(2000);
  });
});
