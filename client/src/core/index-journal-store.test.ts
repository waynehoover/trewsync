/**
 * The journal store's behaviour, against a fake filesystem that can be made to
 * fail exactly where a real one fails by accident.
 *
 * The fake is the point. A short append and a crash between publishing a
 * snapshot and truncating the log are both things a real disk does rarely and
 * a test must do every time.
 */

import { describe, expect, it } from "vitest";
import {
  JournalIndexStore,
  type JournalFiles,
  type JournalStamps,
  wantsSnapshot,
} from "./index-journal-store.ts";
import type { StoredState } from "./vault.ts";

class FakeFiles implements JournalFiles {
  snapshot: string | undefined;
  log: string | undefined;
  /** Cut every append to this many bytes, the way a full disk would. */
  truncateAppendsTo: number | undefined;
  /** Throw after the snapshot is durable and before the log is truncated. */
  crashBeforeTruncate = false;
  /** Throw instead of publishing a snapshot, the way a full disk would. */
  failWriteSnapshot = false;
  /**
   * Land the whole record and then throw, as `write` succeeding and `fsync`
   * failing does in the headless client's append.
   */
  throwAfterAppend = false;
  /** Fail the next look at the files, once, the way a stat that errors does. */
  failStampsOnce = false;
  appends = 0;
  snapshots = 0;

  /**
   * A clock that ticks on every write, so a stamp can tell one write from the
   * next. A real filesystem's does too, and the one that does not is the
   * residual the store's comment names.
   */
  private clock = 1;
  private snapshotAt = 0;
  private logAt = 0;

  async readSnapshot(): Promise<string | undefined> {
    return this.snapshot;
  }
  async writeSnapshot(text: string): Promise<void> {
    if (this.failWriteSnapshot) throw new Error("no space");
    this.snapshot = text;
    this.snapshotAt = this.clock++;
    this.snapshots++;
  }
  async readLog(): Promise<string | undefined> {
    return this.log;
  }
  async appendLog(line: string): Promise<void> {
    const write =
      this.truncateAppendsTo === undefined ? line : line.slice(0, this.truncateAppendsTo);
    this.log = (this.log ?? "") + write;
    this.logAt = this.clock++;
    this.appends++;
    if (this.throwAfterAppend) throw new Error("EIO on fsync");
  }
  async truncateLog(): Promise<void> {
    if (this.crashBeforeTruncate) throw new Error("power cut");
    this.log = "";
    this.logAt = this.clock++;
  }
  async stamps(): Promise<JournalStamps> {
    if (this.failStampsOnce) {
      this.failStampsOnce = false;
      throw new Error("stat failed");
    }
    return {
      ...(this.snapshot === undefined
        ? {}
        : { snapshot: { size: bytes(this.snapshot), mtime: this.snapshotAt } }),
      ...(this.log === undefined ? {} : { log: { size: bytes(this.log), mtime: this.logAt } }),
    };
  }

  /** What another writer does: touch a file this store thinks is its own. */
  writeBehindOurBack(what: "snapshot" | "log", text: string): void {
    if (what === "snapshot") {
      this.snapshot = text;
      this.snapshotAt = this.clock++;
    } else {
      this.log = text;
      this.logAt = this.clock++;
    }
  }
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function state(over: Partial<StoredState> = {}): StoredState {
  return { cursor: 0, entries: {}, remote: {}, pending: [], ...over } as StoredState;
}

function entry(path: string, size: number): Record<string, unknown> {
  return { path, prev: "", folder: false, ctime: 1, mtime: 2, size, hash: "h", chunks: [] };
}

describe("a vault with no index at all", () => {
  it("loads as undefined and snapshots on the first save", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    expect(await store.load()).toBeUndefined();
    await store.save(state({ cursor: 1 }));
    expect(files.snapshots).toBe(1);
    expect(files.appends).toBe(0);
  });

  it("refuses a journal with no snapshot rather than inventing a base for it", async () => {
    // Applying deltas to nothing would produce a state that never existed, and
    // silently ignoring them would be rule 2.
    const files = new FakeFiles();
    files.log = '1 00000000 {"cursor":1}\n';
    await expect(new JournalIndexStore(files).load()).rejects.toThrow(/no snapshot/);
  });
});

describe("an ordinary sequence of passes", () => {
  it("persists in-place changes to loaded entries and nested chunk arrays", async () => {
    const files = new FakeFiles();
    const first = new JournalIndexStore(files);
    await first.save(state({ entries: { "a.md": { ...entry("a.md", 1), chunks: ["old"] } } }));
    const reopened = new JournalIndexStore(files);
    const loaded = (await reopened.load())!;
    const note = loaded.entries["a.md"] as { size: number; chunks: string[] };
    note.size = 2;
    note.chunks[0] = "new";
    await reopened.save(loaded);
    note.chunks.push("newer");
    await reopened.save(loaded);
    const restored = (await new JournalIndexStore(files).load())!;
    expect(restored.entries["a.md"]).toMatchObject({ size: 2, chunks: ["new", "newer"] });
  });

  it("appends what changed and does not rewrite the snapshot", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 1 }));
    const afterFirst = files.snapshots;

    await store.save(state({ cursor: 2, entries: { "a.md": entry("a.md", 1) } }));
    await store.save(state({ cursor: 3, entries: { "a.md": entry("a.md", 1) } }));
    expect(files.appends, "a change did not reach the log").toBe(2);
    expect(files.snapshots, "the snapshot was rewritten for an ordinary pass").toBe(afterFirst);
  });

  it("writes nothing at all when nothing changed", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    const s = state({ cursor: 4, entries: { "a.md": entry("a.md", 1) } });
    await store.save(s);
    const appends = files.appends;
    const snapshots = files.snapshots;

    for (let i = 0; i < 20; i++)
      await store.save(state({ cursor: 4, entries: { "a.md": entry("a.md", 1) } }));
    expect(files.appends, "a settled vault kept writing").toBe(appends);
    expect(files.snapshots).toBe(snapshots);
  });

  it("reads back exactly what was saved, across a reopen", async () => {
    const files = new FakeFiles();
    const first = new JournalIndexStore(files);
    await first.load();
    await first.save(state({ cursor: 1 }));
    const wanted = state({
      cursor: 9,
      entries: { "a.md": entry("a.md", 3) },
      remote: { "a.md": { uid: 9, folder: false, deleted: false, mtime: 1, size: 3, hash: "abc" } },
      pending: ["a.md"],
    });
    await first.save(wanted);

    const reopened = new JournalIndexStore(files);
    expect(await reopened.load()).toEqual(wanted);
  });
});

/**
 * The store epoch (PLAN.md section 2.8) has to come back from disk exactly as
 * it went, by whichever route it went: a hello sends the stored epoch with the
 * stored cursor, and a cursor reloaded without its epoch is taken as it is by
 * a server whose history may have been replaced since.
 */
describe("the store epoch", () => {
  it("survives a snapshot and a journal replay, and an absent one stays absent", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();

    await store.save(state({ cursor: 1 }));
    const bare = (await new JournalIndexStore(files).load())!;
    expect("epoch" in bare, "an index saved with no epoch came back with one").toBe(false);

    // Through the log: the first save wrote the snapshot, so this is a record.
    await store.save(state({ cursor: 2, epoch: "first" }));
    expect(files.appends, "the epoch did not go through the journal").toBe(1);
    expect(files.log).toContain('"epoch":"first"');
    expect(await new JournalIndexStore(files).load()).toEqual(state({ cursor: 2, epoch: "first" }));

    // Through a snapshot: a fresh store that must snapshot on its first save.
    const snapshotting = new JournalIndexStore(files, {
      policy: { fractionOfSnapshot: 0, maxRecords: 1, minBytes: 0 },
    });
    await snapshotting.load();
    const snapshotsBefore = files.snapshots;
    await snapshotting.save(state({ cursor: 0, epoch: "second" }));
    expect(files.snapshots, "the save did not write a snapshot").toBe(snapshotsBefore + 1);
    expect(files.snapshot).toContain('"epoch":"second"');
    expect(files.log, "the log was not truncated behind the snapshot").toBe("");
    expect(await new JournalIndexStore(files).load()).toEqual(
      state({ cursor: 0, epoch: "second" }),
    );
  });
});

describe("an append that did not land whole", () => {
  it("raises rather than leaving a record the next load will silently drop", async () => {
    // A short append is the one damage this format cannot see for itself at
    // write time: the next load discards it and nothing ever says why.
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 1 }));
    files.truncateAppendsTo = 5;
    await expect(store.save(state({ cursor: 2 }))).rejects.toThrow(/did not land whole/);
  });
});

/**
 * A record that reached the disk from a save that then failed (T05).
 *
 * The sequence advanced only on success, so the record was on disk under
 * seq + 1 while the store still said seq. The next save took the record for
 * somebody else's write, said so, and published a snapshot stamped with the
 * old seq; a crash before the log was truncated then replayed that stale record
 * over the newer snapshot: an older cursor, and a deleted entry back.
 */
describe("an append that landed and then failed (T05)", () => {
  for (const [what, arm] of [
    ["the append itself reports the failure", (f: FakeFiles) => (f.throwAfterAppend = true)],
    ["the check of the append fails", (f: FakeFiles) => (f.failStampsOnce = true)],
  ] as const) {
    it(`does not replay its record over a newer snapshot when ${what}`, async () => {
      const files = new FakeFiles();
      const said: string[] = [];
      const store = new JournalIndexStore(files, { log: (m) => said.push(m) });
      await store.load();
      await store.save(state({ cursor: 1, entries: { "a.md": entry("a.md", 10) } }));
      await store.save(state({ cursor: 2, entries: { "a.md": entry("a.md", 20) } }));

      // The record lands whole, and the save fails all the same.
      const failing = state({
        cursor: 3,
        entries: { "a.md": entry("a.md", 30), "gone.md": entry("gone.md", 1) },
      });
      if (what === "the check of the append fails") {
        // After the append, not before it: the save's own first look succeeds.
        const appendLog = files.appendLog.bind(files);
        files.appendLog = async (line) => {
          await appendLog(line);
          arm(files);
        };
        await expect(store.save(failing)).rejects.toThrow(/stat failed/);
        files.appendLog = appendLog;
      } else {
        arm(files);
        await expect(store.save(failing)).rejects.toThrow(/EIO/);
        files.throwAfterAppend = false;
      }

      // The next save snapshots, and the process dies before the log is
      // truncated behind it.
      files.crashBeforeTruncate = true;
      const newest = state({ cursor: 4, entries: { "a.md": entry("a.md", 40) } });
      await expect(store.save(newest)).rejects.toThrow(/power cut/);

      expect(await new JournalIndexStore(files).load()).toEqual(newest);
      expect(said.join(" "), "its own record was taken for another writer's").not.toMatch(
        /something else is writing the index/,
      );
    });
  }
});

describe("a crash between publishing a snapshot and truncating the log", () => {
  it("loads the snapshot and applies none of the records it already holds", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files, {
      policy: { fractionOfSnapshot: 0, maxRecords: 3, minBytes: 0 },
    });
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));

    files.crashBeforeTruncate = true;
    await expect(store.save(state({ cursor: 3 }))).rejects.toThrow(/power cut/);
    expect(files.snapshot, "the snapshot was not published first").toContain('"cursor":3');
    expect(files.log, "the log was truncated despite the crash").not.toBe("");

    const reopened = new JournalIndexStore(files);
    expect((await reopened.load())!.cursor).toBe(3);
  });
});

describe("a log that cannot be trusted", () => {
  it("keeps the records before the damage and drops the rest", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));
    files.log = (files.log ?? "") + '2 deadbeef {"cursor":99}\n';

    const said: string[] = [];
    const reopened = new JournalIndexStore(files, { log: (m) => said.push(m) });
    expect((await reopened.load())!.cursor).toBe(2);
    expect(said.join(" "), "a discarded record was not reported").toMatch(/journal stops/);
  });

  /**
   * F09. Everything saved after damaged tail was found has to be readable.
   *
   * Replay stopping early was reported and then forgotten: the next save
   * appended after the record replay stops at, so it was written, `save`
   * returned, and the next load stopped at the same bad record and reported
   * the same older state. The vault went on working perfectly and forgetting
   * everything, for ever, with no error on any pass. This is the review's own
   * sequence: save 1, save 2, damage, load at 2, save 3, load at 2.
   */
  it("makes the first save after the damage readable, and the next one too", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));
    files.log = (files.log ?? "") + '2 deadbeef {"cursor":99}\n';

    const reopened = new JournalIndexStore(files, { log: () => undefined });
    expect((await reopened.load())!.cursor).toBe(2);
    await reopened.save(state({ cursor: 3 }));
    expect(
      (await new JournalIndexStore(files).load())!.cursor,
      "a save made after a damaged tail was not readable afterwards",
    ).toBe(3);

    // And the one after it, so the repair is not a single lucky snapshot.
    const third = new JournalIndexStore(files);
    await third.load();
    await third.save(state({ cursor: 4 }));
    expect((await new JournalIndexStore(files).load())!.cursor).toBe(4);
  });

  it("falls back to the snapshot when the whole log is rubbish", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 7 }));
    files.log = "not a journal at all\n";

    const reopened = new JournalIndexStore(files, { log: () => undefined });
    expect((await reopened.load())!.cursor).toBe(7);
  });
});

describe("a snapshot that cannot be read", () => {
  it("refuses, and does not start from empty", async () => {
    const files = new FakeFiles();
    files.snapshot = "{ this is not json";
    await expect(new JournalIndexStore(files).load()).rejects.toThrow(/not valid JSON/);
  });
});

describe("the snapshot policy", () => {
  const tiny = { fractionOfSnapshot: 0.25, maxRecords: 1000, minBytes: 0 };

  it("takes a snapshot once the log has outgrown its fraction", () => {
    expect(wantsSnapshot(10, 1000, 1, tiny)).toBe(false);
    expect(wantsSnapshot(300, 1000, 1, tiny)).toBe(true);
  });

  it("leaves a small log alone however small the snapshot is", () => {
    // The failure this floor exists for: a new vault's snapshot is a few dozen
    // bytes, so a quarter of it is smaller than one record and every pass
    // would rewrite the whole index, which is what the journal replaces.
    expect(wantsSnapshot(300, 60, 1), "a small vault snapshotted on an ordinary pass").toBe(false);
    expect(wantsSnapshot(300, 60, 1, tiny)).toBe(true);
  });

  it("bounds a vault by the record count whatever the sizes say", () => {
    expect(wantsSnapshot(5000, 0, 1)).toBe(false);
    expect(wantsSnapshot(5000, 0, 1000)).toBe(true);
  });
});

describe("something else writing the index", () => {
  /** A policy that never fires, so only a foreign write can force a snapshot. */
  const never = { fractionOfSnapshot: 1e9, maxRecords: 1e9, minBytes: 1e9 };

  it("is answered with a whole snapshot rather than a record", async () => {
    // A record appended beside a snapshot somebody else wrote is this device's
    // delta over their base, which invents a state that never existed. A whole
    // snapshot is complete on its own and cannot.
    const files = new FakeFiles();
    const said: string[] = [];
    const store = new JournalIndexStore(files, { policy: never, log: (m) => said.push(m) });
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));
    expect(files.appends).toBe(1);

    files.writeBehindOurBack("snapshot", JSON.stringify({ ...state({ cursor: 900 }), seq: 77 }));
    await store.save(state({ cursor: 3 }));
    expect(said.join(" ")).toMatch(/something else is writing the index/);
    expect(files.appends, "a record was appended onto somebody else's snapshot").toBe(1);
    expect(files.log).toBe("");
  });

  it("still owes that snapshot after one that failed", async () => {
    // The failure this catches: a foreign write forces a snapshot, the
    // snapshot cannot be written, and the next save finds the files unchanged
    // since the failure and quietly appends a record beside the foreign
    // snapshot after all. One-shot alarms have to survive a failure or they
    // are worse than none.
    const files = new FakeFiles();
    const store = new JournalIndexStore(files, { policy: never, log: () => undefined });
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));

    files.writeBehindOurBack("snapshot", JSON.stringify({ ...state({ cursor: 900 }), seq: 77 }));
    files.failWriteSnapshot = true;
    await expect(store.save(state({ cursor: 3 }))).rejects.toThrow(/no space/);
    files.failWriteSnapshot = false;

    await store.save(state({ cursor: 4 }));
    expect(files.appends, "a failed snapshot was papered over with a record").toBe(1);
    expect(files.snapshot, "the snapshot that was owed was never written").toContain('"cursor":4');
    expect(files.log).toBe("");
  });
});
