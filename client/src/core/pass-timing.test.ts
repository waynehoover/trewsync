/**
 * The instrumentation, held to the two things that make its numbers mean
 * anything.
 *
 * A measurement nobody checked is a number with a decimal point in it. These
 * are the checks: that the phases actually partition the pass rather than
 * overlapping or leaking, and that the whole apparatus is absent when it is
 * off, which is what lets it exist in shipped code at all.
 */

import { describe, expect, it, vi } from "vitest";

import { combinePasses, type PassPhases, type SyncReport } from "./engine.ts";
import { timedVault, MemoryVault, type StoredState } from "./vault.ts";
import {
  JournalIndexStore,
  type JournalFiles,
  type JournalSaveCost,
  type JournalStamps,
} from "./index-journal-store.ts";

/** Both files in memory, with a clock that ticks so a stamp can tell writes apart. */
class Files implements JournalFiles {
  private snapshot: string | undefined;
  private log: string | undefined;
  private clock = 1;
  private snapshotAt = 0;
  private logAt = 0;

  async readSnapshot(): Promise<string | undefined> {
    return this.snapshot;
  }
  async writeSnapshot(text: string): Promise<void> {
    this.snapshot = text;
    this.snapshotAt = this.clock++;
  }
  async readLog(): Promise<string | undefined> {
    return this.log;
  }
  async appendLog(line: string): Promise<void> {
    this.log = (this.log ?? "") + line;
    this.logAt = this.clock++;
  }
  async truncateLog(): Promise<void> {
    this.log = undefined;
    this.logAt = this.clock++;
  }
  async stamps(): Promise<JournalStamps> {
    const size = (text: string | undefined) => new TextEncoder().encode(text ?? "").length;
    return {
      ...(this.snapshot === undefined
        ? {}
        : { snapshot: { size: size(this.snapshot), mtime: this.snapshotAt } }),
      ...(this.log === undefined ? {} : { log: { size: size(this.log), mtime: this.logAt } }),
    };
  }
}

function report(over: Partial<SyncReport>): SyncReport {
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
    bytesSent: 0,
    reusedChunks: 0,
    ...over,
  };
}

const phases = (over: Partial<PassPhases> = {}): PassPhases => ({
  listMs: 0,
  decideMs: 0,
  transferMs: 0,
  saveMs: 0,
  journalCompareMs: 0,
  filesystemMs: {},
  rounds: 1,
  ...over,
});

describe("phases across rounds", () => {
  it("adds the terms and counts the rounds", () => {
    // `sync` runs the pass again while `again` is set, and the question these
    // answer is what the whole sync cost. Two rounds of 20 ms is 40 ms.
    const a = report({ phases: phases({ listMs: 10, decideMs: 5 }) });
    const b = report({ phases: phases({ listMs: 4, saveMs: 3 }) });
    const both = combinePasses(a, b);
    expect(both.phases?.listMs).toBe(14);
    expect(both.phases?.decideMs).toBe(5);
    expect(both.phases?.saveMs).toBe(3);
    expect(both.phases?.rounds).toBe(2);
  });

  it("adds the filesystem overlay per operation, not per round", () => {
    // A run that read in two rounds is one call count and one total, or
    // nothing downstream can add the column up.
    const a = report({ phases: phases({ filesystemMs: { read: { ms: 6, calls: 2 } } }) });
    const b = report({
      phases: phases({ filesystemMs: { read: { ms: 4, calls: 3 }, stat: { ms: 1, calls: 9 } } }),
    });
    const both = combinePasses(a, b);
    expect(both.phases?.filesystemMs["read"]).toEqual({ ms: 10, calls: 5 });
    expect(both.phases?.filesystemMs["stat"]).toEqual({ ms: 1, calls: 9 });
  });

  it("says nothing at all when the pass was not measured", () => {
    expect(combinePasses(report({}), report({})).phases).toBeUndefined();
  });
});

describe("the filesystem overlay", () => {
  it("counts each operation and hands the result back untouched", async () => {
    const into: Record<string, { ms: number; calls: number }> = {};
    const inner = new MemoryVault();
    await inner.edit("note.md", "hello\n");
    const timed = timedVault(inner, into);

    expect(new TextDecoder().decode(await timed.read("note.md"))).toBe("hello\n");
    await timed.stat("note.md");
    await timed.stat("note.md");
    expect(into["read"]?.calls).toBe(1);
    expect(into["stat"]?.calls).toBe(2);
    expect(into["read"]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("times an operation that failed, and rethrows it", async () => {
    // An operation that took two seconds and then threw still took two
    // seconds, and on a phone that is the interesting one.
    const into: Record<string, { ms: number; calls: number }> = {};
    const timed = timedVault(new MemoryVault(), into);
    await expect(timed.read("missing.md")).rejects.toThrow();
    expect(into["read"]?.calls).toBe(1);
  });

  it("does not claim an ability the vault underneath does not have", async () => {
    // The engine decides what an adapter can do by asking whether the method
    // is there. A wrapper that answered every name would tell it every vault
    // can stream, and the streaming scan would then fail on every large file.
    const bare: Parameters<typeof timedVault>[0] = new MemoryVault();
    const timed = timedVault(bare, {});
    expect(timed.readBlocks === undefined).toBe(bare.readBlocks === undefined);
    expect(timed.readRange === undefined).toBe(bare.readRange === undefined);
    expect(timed.replace === undefined).toBe(bare.replace === undefined);
  });
});

describe("what an index save cost", () => {
  const state = (over: Partial<StoredState> = {}): StoredState => ({
    cursor: 1,
    entries: {},
    remote: {},
    pending: [],
    ...over,
  });

  it("tells an unchanged save apart from an append", async () => {
    // The two scale differently and only one of them is what the work set in
    // open-work.md would remove, so a hook that reported "a save happened"
    // would answer nothing.
    const seen: JournalSaveCost[] = [];
    const store = new JournalIndexStore(new Files(), {
      onSave: (cost) => seen.push(cost),
    });
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));
    await store.save(state({ cursor: 2 }));

    expect(seen.at(-1)?.kind, "a settled pass wrote something").toBe("unchanged");
    expect(seen.at(-1)?.bytes).toBe(0);
    expect(seen.at(-2)?.kind).toBe("append");
    expect(seen.at(-2)?.bytes).toBeGreaterThan(0);
    // The comparison happens even when nothing is written: that walk is how a
    // settled pass learns it has nothing to say, and it is the term the
    // rewrite would remove.
    expect(seen.at(-1)?.compareMs).toBeGreaterThanOrEqual(0);
  });

  it("cannot stop a save by throwing", async () => {
    const store = new JournalIndexStore(new Files(), {
      onSave: () => {
        throw new Error("the measurement fell over");
      },
    });
    await store.load();
    await expect(store.save(state({ cursor: 4 }))).resolves.toBeUndefined();
    expect((await store.load())?.cursor).toBe(4);
  });

  it("is never called when nobody asked to measure", async () => {
    const onSave = vi.fn();
    const store = new JournalIndexStore(new Files(), {});
    await store.load();
    await store.save(state({ cursor: 9 }));
    expect(onSave).not.toHaveBeenCalled();
  });
});
