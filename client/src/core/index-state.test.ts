import { describe, expect, it } from "vitest";
import {
  decide,
  needsRehash,
  newEntry,
  nextUploadTime,
  observe,
  readyToSyncAgain,
  reconciled,
  renamed,
  synced,
  type Action,
  type IndexEntry,
  type LocalState,
  type RemoteState,
} from "./index-state.ts";

const BASE = "hash-of-the-last-synced-version";

function entry(over: Partial<IndexEntry> = {}): IndexEntry {
  return { ...newEntry("note.md"), ...over };
}

function local(over: Partial<LocalState> = {}): LocalState {
  return { folder: false, mtime: 1000, size: 100, hash: BASE, ...over };
}

function remote(over: Partial<RemoteState> = {}): RemoteState {
  return { uid: 7, folder: false, deleted: false, mtime: 1000, size: 100, hash: BASE, ...over };
}

function at(
  local: LocalState | undefined,
  remote: RemoteState | undefined,
  index: IndexEntry,
  mergeable = true,
): Action {
  return decide({ local, remote, index, mergeable });
}

describe("the decision table", () => {
  it("does nothing when both sides agree", () => {
    const a = at(local({ hash: "same" }), remote({ hash: "same" }), entry({ synchash: "same" }));
    expect(a.kind).toBe("nothing");
  });

  it("uploads a file the server has never held", () => {
    expect(at(local({ hash: "new" }), undefined, entry()).kind).toBe("upload");
  });

  it("downloads a file that is new on the server", () => {
    expect(at(undefined, remote({ hash: "theirs" }), entry()).kind).toBe("download");
  });

  it("uploads when only the local side moved", () => {
    const a = at(local({ hash: "mine" }), remote({ hash: BASE }), entry({ synchash: BASE }));
    expect(a.kind).toBe("upload");
    expect(a.why).toMatch(/unchanged on the server/);
  });

  it("downloads when only the remote side moved", () => {
    const a = at(local({ hash: BASE }), remote({ hash: "theirs" }), entry({ synchash: BASE }));
    expect(a.kind).toBe("download");
    expect(a.why).toMatch(/unchanged here/);
  });

  it("merges when both sides moved and the file can be merged", () => {
    const a = at(
      local({ hash: "mine" }),
      remote({ hash: "theirs" }),
      entry({ synchash: BASE }),
      true,
    );
    expect(a.kind).toBe("merge");
  });

  it("keeps both when both sides moved and the file cannot be merged", () => {
    // An attachment, a PDF, anything not text. There is no merge to attempt
    // and choosing by mtime would discard one of them.
    const a = at(
      local({ hash: "mine" }),
      remote({ hash: "theirs" }),
      entry({ synchash: BASE }),
      false,
    );
    expect(a.kind).toBe("conflict");
  });

  it("does nothing when the path is absent everywhere", () => {
    expect(at(undefined, undefined, entry()).kind).toBe("nothing");
    expect(at(undefined, remote({ deleted: true }), entry()).kind).toBe("nothing");
  });
});

describe("pairing a device against a vault it already has", () => {
  /**
   * The case Obsidian resolves by mtime, which silently discards the other
   * version. It happens the first time a second device is paired against a
   * vault someone copied by hand.
   */
  it("keeps both versions when there is no ancestor to merge from", () => {
    const a = at(local({ hash: "mine" }), remote({ hash: "theirs" }), entry({ synchash: "" }));
    expect(a.kind).toBe("conflict");
    expect(a.why).toMatch(/no last-synced version/);
  });

  it("keeps the local file in place whichever clock ran ahead", () => {
    // No field decides this, and that is the point: information-wise the
    // choice is a coin flip, and never rewriting the file somebody has open
    // is a better rule than preferring whichever device's clock was faster.
    const clocks: [number, number][] = [
      [2000, 1000],
      [1000, 2000],
    ];
    for (const [lm, rm] of clocks) {
      const a = at(
        local({ hash: "mine", mtime: lm }),
        remote({ hash: "theirs", mtime: rm }),
        entry({ synchash: "" }),
      );
      expect(a.kind).toBe("conflict");
      expect(a).not.toHaveProperty("keepLocal");
    }
  });

  it("does nothing at all for the files that are byte-identical", () => {
    // Which is nearly all of them, and is why conflicting on the rest is not
    // the disaster it sounds like. A hand-copied vault agrees everywhere it
    // has not been edited since.
    const a = at(local({ hash: "same" }), remote({ hash: "same" }), entry({ synchash: "" }));
    expect(a.kind).toBe("nothing");
  });
});

describe("deletions, where losing a note is easiest", () => {
  it("propagates a local delete when the server has not moved", () => {
    const a = at(undefined, remote({ hash: BASE }), entry({ synchash: BASE }));
    expect(a.kind).toBe("deleteRemote");
  });

  it("propagates a remote delete when the local file has not moved", () => {
    const a = at(local({ hash: BASE }), remote({ deleted: true }), entry({ synchash: BASE }));
    expect(a.kind).toBe("deleteLocal");
  });

  /**
   * Deleted here, changed there. A deletion can be repeated; an edit cannot be
   * recovered once it is gone from both the device that made it and the server.
   */
  it("restores a file deleted here but changed elsewhere", () => {
    const a = at(undefined, remote({ hash: "theirs" }), entry({ synchash: BASE }));
    expect(a.kind).toBe("restoreLocal");
    expect(a.why).toMatch(/changed on another device/);
  });

  /** The same principle from the other side. */
  it("keeps and re-uploads a file deleted elsewhere but edited here", () => {
    const a = at(local({ hash: "mine" }), remote({ deleted: true }), entry({ synchash: BASE }));
    expect(a.kind).toBe("upload");
    expect(a.why).toMatch(/edited here/);
  });

  it("uploads a local file the server last saw as deleted and never had from here", () => {
    // A file recreated with the same name, on a device that never synced it.
    const a = at(local({ hash: "mine" }), remote({ deleted: true }), entry({ synchash: "" }));
    expect(a.kind).toBe("upload");
  });

  it("does nothing when both sides have deleted it", () => {
    expect(at(undefined, remote({ deleted: true }), entry({ synchash: BASE })).kind).toBe(
      "nothing",
    );
  });
});

describe("folders", () => {
  it("creates a folder the server has and the device does not", () => {
    const a = at(undefined, remote({ folder: true, hash: "" }), entry());
    expect(a.kind).toBe("createLocalFolder");
  });

  it("uploads a new local folder", () => {
    expect(at(local({ folder: true, hash: "" }), undefined, entry()).kind).toBe("upload");
  });

  it("does not delete a local folder because the server dropped it", () => {
    // Deleting it here would mean deciding what happens to anything inside
    // that has not synced yet. The files carry the truth; a folder is
    // bookkeeping.
    const a = at(
      local({ folder: true, hash: "" }),
      remote({ folder: true, deleted: true }),
      entry(),
    );
    expect(a.kind).toBe("nothing");
  });

  it("does nothing when a folder is on both sides", () => {
    const a = at(local({ folder: true, hash: "" }), remote({ folder: true, hash: "" }), entry());
    expect(a.kind).toBe("nothing");
  });
});

describe("every decision explains itself", () => {
  it("gives a reason for every case in the table", () => {
    // Rule 7: a status that cannot distinguish between the cases it collapses
    // is not a status. Every branch here is reachable and every one says why.
    const cases: [LocalState | undefined, RemoteState | undefined, IndexEntry, boolean][] = [
      [local(), remote(), entry({ synchash: BASE }), true],
      [local({ hash: "mine" }), remote({ hash: "theirs" }), entry({ synchash: BASE }), true],
      [local({ hash: "mine" }), remote({ hash: "theirs" }), entry({ synchash: BASE }), false],
      [local({ hash: "mine" }), remote({ hash: "theirs" }), entry({ synchash: "" }), true],
      [local({ hash: "mine" }), undefined, entry(), true],
      [undefined, remote({ hash: "theirs" }), entry(), true],
      [undefined, remote({ hash: BASE }), entry({ synchash: BASE }), true],
      [undefined, remote({ hash: "theirs" }), entry({ synchash: BASE }), true],
      [local({ hash: BASE }), remote({ deleted: true }), entry({ synchash: BASE }), true],
      [local({ hash: "mine" }), remote({ deleted: true }), entry({ synchash: BASE }), true],
      [local({ folder: true, hash: "" }), undefined, entry(), true],
      [undefined, remote({ folder: true, hash: "" }), entry(), true],
      [undefined, undefined, entry(), true],
    ];
    const seen = new Set<string>();
    for (const [l, r, e, m] of cases) {
      const a = decide({ local: l, remote: r, index: e, mergeable: m });
      expect(a.why.length, `${a.kind} gave an empty reason`).toBeGreaterThan(10);
      seen.add(a.kind);
    }
    // Rule 8: without a count, "every case has a reason" is also what one
    // case having a reason looks like.
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });
});

describe("the content cache, which is the whole cost of a routine scan", () => {
  it("re-reads nothing when the stat has not moved", () => {
    const e = entry({ mtime: 500, size: 42, hash: "cached", chunks: ["a"] });
    expect(needsRehash(e, 500, 42)).toBe(false);
  });

  it("re-reads when mtime or size moved", () => {
    const e = entry({ mtime: 500, size: 42, hash: "cached", chunks: ["a"] });
    expect(needsRehash(e, 501, 42)).toBe(true);
    expect(needsRehash(e, 500, 43)).toBe(true);
  });

  it("re-reads when the hash is unknown", () => {
    expect(needsRehash(entry({ mtime: 500, size: 42 }), 500, 42)).toBe(true);
  });

  /**
   * Obsidian caches the hash and stops there, because it uploads whole files.
   * Trew uploads chunks, so a cached hash with no chunk list still means
   * re-reading, re-chunking, re-compressing and re-encrypting the file to
   * learn something it already knows.
   */
  it("re-reads when the hash is known but the chunk list is not", () => {
    const e = entry({ mtime: 500, size: 42, hash: "cached", chunks: [] });
    expect(needsRehash(e, 500, 42)).toBe(true);
  });

  /**
   * C-D13 in the 0.3.0 review. An empty file is made of no chunks, so for one
   * file in the vault "no chunk list" is never going to become "a chunk list"
   * and the rule above read it, chunked it and sealed it on every single pass,
   * for ever, to learn that it is empty.
   */
  it("does not re-read a synced empty file every pass", () => {
    const e = entry({ mtime: 500, size: 0, hash: "-empty-", chunks: [] });
    expect(needsRehash(e, 500, 0)).toBe(false);
    // The stat still decides, as it does for everything else: a file that is
    // no longer empty, or was touched, is read again.
    expect(needsRehash(e, 500, 42)).toBe(true);
    expect(needsRehash(e, 501, 0)).toBe(true);
  });

  it("drops the cache when observing a moved file", () => {
    const e = entry({ mtime: 500, size: 42, hash: "cached", chunks: ["a", "b"] });
    observe(e, { folder: false, mtime: 600, ctime: 1, size: 42 });
    expect(e.hash).toBe("");
    expect(e.chunks).toEqual([]);
    expect(e.mtime).toBe(600);
  });

  it("keeps the cache when observing an unchanged file", () => {
    const e = entry({ mtime: 500, size: 42, hash: "cached", chunks: ["a", "b"] });
    observe(e, { folder: false, mtime: 500, ctime: 1, size: 42 });
    expect(e.hash).toBe("cached");
    expect(e.chunks).toEqual(["a", "b"]);
  });

  it("rounds timestamps up, so a platform's precision does not look like an edit", () => {
    const e = entry();
    observe(e, { folder: false, mtime: 1000.2, ctime: 500.7, size: 10 });
    expect(e.mtime).toBe(1001);
    expect(e.ctime).toBe(501);
    // And the rounded value is what the next comparison sees, so an
    // unchanged file stays unchanged.
    e.hash = "cached";
    e.chunks = ["a"];
    observe(e, { folder: false, mtime: 1000.9, ctime: 500.1, size: 10 });
    expect(e.hash).toBe("cached");
  });
});

describe("renames", () => {
  it("remembers the name the server knows", () => {
    const e = entry({ path: "a.md", synchash: BASE });
    renamed(e, "a.md", "b.md");
    expect(e.path).toBe("b.md");
    expect(e.prev).toBe("a.md");
  });

  /**
   * A to B to C before a sync has to tell the server about A. B is a name the
   * server never saw and cannot act on. Obsidian gets this right with
   * `previouspath || (previouspath = old)` and it is easy to get wrong.
   */
  it("keeps the first previous name through a chain of renames", () => {
    const e = entry({ path: "a.md", synchash: BASE });
    renamed(e, "a.md", "b.md");
    renamed(e, "b.md", "c.md");
    renamed(e, "c.md", "d.md");
    expect(e.path).toBe("d.md");
    expect(e.prev).toBe("a.md");
  });

  it("forgets the rename when the file comes back to its old name", () => {
    // Otherwise the server is told to rename a path to itself, which it
    // refuses, and the file stops syncing until somebody notices.
    const e = entry({ path: "a.md", synchash: BASE });
    renamed(e, "a.md", "b.md");
    renamed(e, "b.md", "a.md");
    expect(e.path).toBe("a.md");
    expect(e.prev).toBe("");
  });

  it("clears the debounce so the rename syncs promptly", () => {
    const e = entry({ path: "a.md", synctime: 999 });
    renamed(e, "a.md", "b.md");
    expect(e.synctime).toBe(0);
  });
});

describe("recording a completed sync", () => {
  it("moves the ancestor and clears the rename", () => {
    const e = entry({ prev: "old.md" });
    synced(e, "fresh", ["c1", "c2"], 42, 1_700_000);
    expect(e.synchash).toBe("fresh");
    expect(e.hash).toBe("fresh");
    expect(e.chunks).toEqual(["c1", "c2"]);
    expect(e.syncuid).toBe(42);
    expect(e.synctime).toBe(1_700_000);
    expect(e.prev).toBe("");
  });

  it("copies the chunk list rather than aliasing it", () => {
    // The caller's array is a scan's working buffer. Keeping a reference
    // means the index quietly changes when the next file is chunked.
    const e = entry();
    const chunks = ["c1"];
    synced(e, "h", chunks, 1, 0);
    chunks.push("c2");
    expect(e.chunks).toEqual(["c1"]);
  });

  it("keeps the uid, so the ancestor's content can be fetched", () => {
    // synchash identifies the ancestor; the uid is how to get it. A merge
    // needs the content, and the device does not keep old versions.
    const e = entry();
    synced(e, "h", [], 99, 0);
    expect(e.syncuid).toBe(99);
  });
});

describe("recording a remote version as dealt with", () => {
  // RR7 and RR9. A device that cannot send never uploads, and the upload is
  // what normally records that a remote version has been handled, so without
  // this the same conflict copy or the same merge is decided on every pass.
  //
  // The distinction this makes is unobservable through the CLI: the merged file
  // gets a fresh mtime, so the next scan rehashes it and would put a wrong
  // `hash` back regardless. Removing the distinction passed every read-only
  // test. It is asserted here, where it is the whole content of the function.

  it("moves the ancestor to the version that was dealt with", () => {
    const e = entry({ synchash: BASE, syncuid: 7, synctime: 1 });
    reconciled(e, "theirs", 8, 1_700_000);
    expect(e.synchash).toBe("theirs");
    expect(e.syncuid).toBe(8);
    expect(e.synctime).toBe(1_700_000);
  });

  it("leaves the local bytes described as they are", () => {
    // `hash` and `chunks` say what is on this disk. Moving them to the agreed
    // version is the "a failed push looks like an agreed state" mistake that
    // `synced` exists to avoid, arrived at from the other direction: the local
    // edit would stop looking like an edit, stop being held back, and stop
    // being sent if the device ever became writable.
    const e = entry({ hash: "the bytes here", chunks: ["local1", "local2"] });
    reconciled(e, "theirs", 8, 1_700_000);
    expect(e.hash).toBe("the bytes here");
    expect(e.chunks).toEqual(["local1", "local2"]);
  });

  it("does nothing at all when it is already that version", () => {
    // Not merely idempotent in its result: `synctime` feeds the debounce, and
    // a pass that decided nothing new must not push the next sync away.
    const e = entry({ synchash: "theirs", syncuid: 8, synctime: 500 });
    reconciled(e, "theirs", 8, 1_700_000);
    expect(e.synctime).toBe(500);
  });

  it("still moves when the uid matches but the hash does not", () => {
    // One version's bytes replaced under the same uid should not be mistaken
    // for the version already recorded.
    const e = entry({ synchash: "old", syncuid: 8, synctime: 500 });
    reconciled(e, "new", 8, 1_700_000);
    expect(e.synchash).toBe("new");
    expect(e.synctime).toBe(1_700_000);
  });
});

describe("the binary upload cooldown", () => {
  it("lets a never-synced file go immediately", () => {
    expect(readyToSyncAgain(entry({ synctime: 0 }), 1000)).toBe(true);
  });

  it("waits longer for larger files", () => {
    // Short repeat-upload intervals, scaled by size to limit history churn.
    const small = entry({ size: 1024, synctime: 0 });
    const medium = entry({ size: 50 * 1024, synctime: 0 });
    const large = entry({ size: 500 * 1024, synctime: 0 });
    for (const e of [small, medium, large]) e.synctime = 100_000;

    expect(readyToSyncAgain(small, 101_000)).toBe(true);
    expect(readyToSyncAgain(medium, 101_000)).toBe(false);
    expect(readyToSyncAgain(medium, 102_000)).toBe(true);
    expect(readyToSyncAgain(large, 102_000)).toBe(false);
    expect(readyToSyncAgain(large, 105_000)).toBe(true);
  });

  it.each([
    [10240, 1000],
    [10241, 2000],
    [102400, 2000],
    [102401, 5000],
  ])("makes a %i byte file eligible exactly at its %i ms deadline", (size, delay) => {
    const e = entry({ size, synctime: 100_000 });
    expect(nextUploadTime(e)).toBe(100_000 + delay);
    expect(readyToSyncAgain(e, 100_000 + delay - 1)).toBe(false);
    expect(readyToSyncAgain(e, 100_000 + delay)).toBe(true);
  });

  it("does not stall an upload when the clock moved backwards", () => {
    expect(readyToSyncAgain(entry({ synctime: 200_000 }), 100_000)).toBe(true);
  });
});

/**
 * review finding I12. Timestamps are client-asserted and clocks disagree, so they
 * are hints and never the authority. The decision table reads `mtime` from
 * neither side: ordering is uid order, agreement is content, and a device with
 * a clock a year off makes exactly the decisions a device with the right time
 * makes.
 */
describe("with skewed clocks", () => {
  const YEAR = 365 * 24 * 3600 * 1000;
  const base = "chunk-a";

  function alreadySynced(hash = base): IndexEntry {
    const e = newEntry("note.md");
    e.hash = hash;
    e.synchash = base;
    e.syncuid = 7;
    e.synctime = 1;
    return e;
  }

  it("downloads a newer version even when the local file's clock says it is newer", () => {
    // Local is unchanged since the last sync (hash equals the ancestor) but
    // its mtime is a year ahead of the server's. A table that trusted
    // clocks would keep the stale local file.
    const action = decide({
      local: { folder: false, mtime: 2 * YEAR, size: 5, hash: base },
      remote: { uid: 9, folder: false, deleted: false, mtime: 1000, size: 6, hash: "chunk-b" },
      index: alreadySynced(),
      mergeable: true,
    });
    expect(action.kind).toBe("download");
  });

  it("uploads a local edit even when the server's version claims a later time", () => {
    const action = decide({
      local: { folder: false, mtime: 1000, size: 5, hash: "chunk-c" },
      remote: { uid: 9, folder: false, deleted: false, mtime: 2 * YEAR, size: 6, hash: base },
      index: alreadySynced("chunk-c"),
      mergeable: true,
    });
    expect(action.kind).toBe("upload");
  });

  it("makes the same decision whatever either clock says", () => {
    // Every combination of a clock far ahead and far behind on either side,
    // for the case where both sides moved: the answer is a merge, and it
    // never becomes a download or an upload because one side looks newer.
    for (const localTime of [0, 1000, 2 * YEAR]) {
      for (const remoteTime of [0, 1000, 2 * YEAR]) {
        const action = decide({
          local: { folder: false, mtime: localTime, size: 5, hash: "chunk-mine" },
          remote: {
            uid: 9,
            folder: false,
            deleted: false,
            mtime: remoteTime,
            size: 6,
            hash: "chunk-theirs",
          },
          index: alreadySynced("chunk-mine"),
          mergeable: true,
        });
        expect(action.kind, `local ${localTime} remote ${remoteTime}`).toBe("merge");
      }
    }
  });

  it("does not resolve a no-ancestor divergence by picking the newer clock", () => {
    // Obsidian downloads whichever is newer, which silently discards the
    // other. Here both are kept, and the clocks are not consulted.
    for (const [localTime, remoteTime] of [
      [0, YEAR],
      [YEAR, 0],
    ]) {
      const action = decide({
        local: { folder: false, mtime: localTime!, size: 5, hash: "one" },
        remote: { uid: 3, folder: false, deleted: false, mtime: remoteTime!, size: 6, hash: "two" },
        index: newEntry("note.md"),
        mergeable: true,
      });
      expect(action.kind).toBe("conflict");
    }
  });
});
