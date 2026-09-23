/**
 * What happens when the vault changes under a decision already taken (F01).
 *
 * A pass decides what to do from a scan, then goes to the network, then
 * writes. The gap between the decision and the write is a fetch, which on a
 * slow link is seconds, and the person using the vault is typing throughout
 * it. Serialising engine passes does not serialise the editor.
 *
 * Every test here edits, replaces or deletes a note inside that gap and
 * asserts the same property: the bytes on this disk that nobody has sent
 * anywhere are still there afterwards. Keeping both copies is the answer the
 * engine already has for a divergence; the bug was that it never asked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { chunkName } from "./digest.ts";
import { FakeSocket, engineOnFakeSocket, settle } from "./fake-socket.ts";
import type { WireEntry } from "./transport.ts";
import { MemoryVault } from "./vault.ts";

afterEach(() => vi.useRealTimers());

const enc = new TextEncoder();

async function entryFor(
  uid: number,
  path: string,
  text: string,
  bodies: Map<string, Uint8Array>,
  over: { deleted?: boolean; mtime?: number } = {},
): Promise<WireEntry> {
  const raw = enc.encode(text);
  const name = await chunkName(raw);
  bodies.set(name, raw);
  return {
    uid,
    path,
    size: over.deleted ? 0 : raw.length,
    ctime: 1000,
    mtime: over.mtime ?? 1000,
    folder: false,
    deleted: over.deleted ?? false,
    chunks: over.deleted ? [] : [name],
    device: "other",
  };
}

/**
 * A server that answers fetches, and runs `during` before it sends the bodies.
 *
 * That callback is the editor: it is the only moment the test can write to
 * the vault after the engine has decided what to do with it and before the
 * engine acts on that decision.
 */
function servingWith(
  socket: FakeSocket,
  bodies: Map<string, Uint8Array>,
  during?: () => Promise<void> | void,
): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      const send = (): void =>
        void s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      const ran = during?.();
      if (ran instanceof Promise) void ran.then(send);
      else send();
    } else if (frame["op"] === "ping") s.raw({ res: "pong" });
  };
}

async function accepted(engine: { status(): { pending: number } }, n: number): Promise<void> {
  for (let i = 0; i < 400 && engine.status().pending < n; i++) await settle();
}

/** Whatever the vault holds that is not `path`, which is where a copy lands. */
function beside(vault: MemoryVault, path: string): { path: string; text: string }[] {
  return vault
    .paths()
    .filter((p) => p !== path)
    .map((p) => ({ path: p, text: vault.text(p)! }));
}

describe("a note edited while its next version is in flight (F01)", () => {
  it("keeps the edit, and puts the incoming version beside it", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "note.md", "one", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("note.md")).toBe("one");

    // Version two is announced, and the editor saves over the note while its
    // body is on the wire.
    const two = await entryFor(2, "note.md", "two", bodies, { mtime: 2000 });
    servingWith(socket, bodies, async () => {
      await vault.write("note.md", enc.encode("mine"), { mtime: 5000, ctime: 1000 });
    });
    socket.raw({ op: "batch", from: 2, to: 2, entries: [two] });
    await accepted(engine, 1);

    const report = await engine.sync({ coalesceWrites: false });

    expect(vault.text("note.md"), "the unsent edit was overwritten by the incoming version").toBe(
      "mine",
    );
    const copies = beside(vault, "note.md");
    expect(
      copies.map((c) => c.text),
      `nothing beside the note: ${JSON.stringify(copies)}`,
    ).toContain("two");
    expect(report.conflicted, "keeping both was not reported as a conflict").toBe(1);
  });

  it("keeps a note created under the path while a first version is in flight", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();

    // Nothing is here when the decision is taken, so the engine plans a plain
    // write. The person creates a note at that path before the body lands.
    const one = await entryFor(1, "fresh.md", "from the server", bodies);
    servingWith(socket, bodies, async () => {
      await vault.write("fresh.md", enc.encode("typed here first"), { mtime: 5000, ctime: 5000 });
    });
    socket.raw({ op: "batch", from: 1, to: 1, entries: [one] });
    await accepted(engine, 1);

    const report = await engine.sync({ coalesceWrites: false });

    expect(vault.text("fresh.md"), "a note created during the fetch was overwritten").toBe(
      "typed here first",
    );
    expect(beside(vault, "fresh.md").map((c) => c.text)).toContain("from the server");
    expect(report.conflicted).toBe(1);
  });
});

describe("a note edited while an incoming deletion is in flight (F01)", () => {
  it("does not delete bytes the server has never seen", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "doomed.md", "one", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("doomed.md")).toBe("one");

    // The deletion carries no body, so there is nothing to hide inside on
    // its own. A real pass has other work: deletions are applied at the end,
    // after every download, so the fetch for an unrelated note is exactly
    // the window in which the editor saves over the doomed one.
    const gone = await entryFor(2, "doomed.md", "", bodies, { deleted: true, mtime: 2000 });
    const other = await entryFor(3, "other.md", "unrelated", bodies);
    servingWith(socket, bodies, async () => {
      await vault.write("doomed.md", enc.encode("still writing this"), {
        mtime: 5000,
        ctime: 1000,
      });
    });
    socket.raw({ op: "batch", from: 2, to: 3, entries: [gone, other] });
    await accepted(engine, 1);

    await engine.sync({ coalesceWrites: false });

    expect(
      vault.text("doomed.md"),
      "an incoming deletion removed a local edit the server had never seen",
    ).toBe("still writing this");
  });
});

/**
 * A client that connected to look wrote to the vault anyway (F08).
 *
 * `history`, `deleted`, `devices`, `invite` and `status` do not take the
 * vault's lock, and that is deliberate: looking is not writing, and holding
 * the lock would make `status` refuse exactly while a watcher is running,
 * which is when somebody asks. But the client they built scheduled a sync
 * the moment a batch arrived, so an inspection command that stayed connected
 * long enough downloaded notes and saved an index with no lock held and
 * nobody having asked it to.
 */
describe("a client connected only to look (F08)", () => {
  it("takes a batch and neither downloads it nor saves an index", async () => {
    const { Client } = await import("./client.ts");
    const { MemoryIndexStore } = await import("./vault.ts");
    const { FakeSocket, ready } = await import("./fake-socket.ts");

    const socket = new FakeSocket();
    const bodies = new Map<string, Uint8Array>();
    const looking = new MemoryVault();
    const store = new MemoryIndexStore();
    const client = new Client({
      vault: looking,
      store,
      url: "ws://test",
      deviceId: "inspector",
      token: "t",
      vaultId: "v",
      device: "d",
      inspect: true,
      socketFactory: () => socket,
    });

    const connecting = client.connect({ waitForBacklog: false });
    socket.open();
    await settle();
    socket.reply(ready({ cursor: 0 }));
    await connecting;

    socket.raw({ op: "caught-up", cursor: 0 });
    await client.transport.drainReceived();
    vi.useFakeTimers();

    // A note arrives while this command is still printing its answer, which
    // is all it takes: catch-up delivers batches to whoever is connected.
    servingWith(socket, bodies);
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "arrived.md", "not asked for", bodies)],
    });
    await client.transport.drainReceived();
    await vi.advanceTimersByTimeAsync(1);

    expect(looking.paths(), "a command that only looks downloaded a note into the vault").toEqual(
      [],
    );
    expect(await store.load(), "a command that only looks saved an index").toBeUndefined();

    // And asking it to sync is a mistake it names rather than performs.
    await expect(client.sync()).rejects.toThrow(/connected to read, not to sync/);
    await client.close();
  });
});

/**
 * Replay of an old version, which the server can do and nothing here detects
 * (F11).
 *
 * The server assigns uids and ordering the log is its job, and protocol 1
 * carries nothing a device could check that ordering against: devices take the
 * server's word about who wrote what (PLAN.md section 3.6). Basalt's entry
 * authenticator covered the content and the metadata and still not the uid, so
 * this was open there too. A server can take a version a device really did
 * write, hand it back under a newer uid, and the receiving device applies it:
 * the note reverts to contents it genuinely had once.
 *
 * These are pinned rather than fixed. docs/design.md says so under what the
 * server can do, and describes the ancestry check that would close it. If a
 * later change makes one of them fail, that is the fix landing, and the test
 * should become an assertion of the new behaviour rather than be deleted.
 */
describe("a server that replays an old version (F11, pinned)", () => {
  it("reverts a note, because nothing binds a version to its place in the log", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    const one = await entryFor(1, "note.md", "the first version", bodies);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [one] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const two = await entryFor(2, "note.md", "the second version", bodies, { mtime: 2000 });
    socket.raw({ op: "batch", from: 2, to: 2, entries: [two] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("note.md")).toBe("the second version");

    // The same entry the device accepted as version one, handed back with a
    // uid that makes it look like the newest thing on the server. Nothing in
    // it is anything but the original.
    socket.raw({ op: "batch", from: 3, to: 3, entries: [{ ...one, uid: 3 }] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(
      vault.text("note.md"),
      "the replay was detected, which is a fix: update this test to assert it",
    ).toBe("the first version");
  });

  /**
   * The tombstone case, which turns out to be covered already, and by the
   * ordinary divergence rules rather than by anything about replay: the note
   * has been written here since the deletion, so an incoming deletion is not
   * a continuation of what this device holds and the local copy wins. Kept as
   * the boundary of the gap above, so that a change which widens it fails
   * here.
   */
  it("does not delete a note written since, even when the tombstone is replayed", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "gone.md", "here for now", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const tomb = await entryFor(2, "gone.md", "", bodies, { deleted: true, mtime: 2000 });
    socket.raw({ op: "batch", from: 2, to: 2, entries: [tomb] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("gone.md")).toBeUndefined();

    // Written again on this device, and then the old tombstone comes back.
    await vault.edit("gone.md", "typed again after the deletion", 6000);
    await engine.sync({ coalesceWrites: false });
    socket.raw({ op: "batch", from: 3, to: 3, entries: [{ ...tomb, uid: 4 }] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(
      vault.text("gone.md"),
      "a replayed tombstone removed a note this device had written since",
    ).toBe("typed again after the deletion");
  });
});

/**
 * Filenames that are property names on an ordinary object (F14).
 *
 * `entries["__proto__"] = e` does not add a key. It sets the prototype, or on
 * a frozen prototype does nothing at all, and the assignment succeeds either
 * way. So a vault holding a note called `__proto__` downloaded it, advanced
 * the cursor, and saved an index with no record of it: the note was on disk
 * and the index had never heard of it, for ever. `constructor` and `toString`
 * are the same trick under different names, and a delta naming one of them
 * replayed into a state it was missing from.
 *
 * These are legal filenames on every filesystem TrewSync runs on.
 */
describe("a note whose name is a property name (F14)", () => {
  const awkward = ["__proto__", "constructor", "toString", "hasOwnProperty"];

  it("survives a download, a save and a restart", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    const entries = await Promise.all(
      awkward.map((name, i) => entryFor(i + 1, name, `contents of ${name}`, bodies)),
    );
    socket.raw({ op: "batch", from: 1, to: awkward.length, entries });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    for (const name of awkward) {
      expect(vault.text(name), `${name} was not written to the vault`).toBe(`contents of ${name}`);
    }

    // The index has to name every one of them, or the next pass downloads
    // them all again and the pass after that reports them deleted.
    const state = (await (
      engine as unknown as { opts: { store: { load(): Promise<unknown> } } }
    ).opts.store.load()) as { entries: Record<string, unknown>; remote: Record<string, unknown> };
    for (const name of awkward) {
      expect(
        Object.prototype.hasOwnProperty.call(state.entries, name),
        `the saved index has no entry for ${name}`,
      ).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(state.remote, name),
        `the saved index has no server record for ${name}`,
      ).toBe(true);
    }
  });

  it("round-trips through a journal delta and its replay", async () => {
    const { applyDelta, deltaBetween } = await import("./index-journal.ts");
    const empty = { cursor: 0, entries: {}, remote: {}, pending: [] } as unknown as Parameters<
      typeof deltaBetween
    >[0];
    const withThem = {
      cursor: 4,
      entries: Object.fromEntries(awkward.map((n) => [n, { path: n, size: 1 }])),
      remote: Object.fromEntries(awkward.map((n) => [n, { uid: 1 }])),
      pending: awkward,
    } as unknown as Parameters<typeof deltaBetween>[0];

    const delta = deltaBetween(empty, withThem);
    expect(delta, "nothing was recorded as changed").toBeDefined();
    const back = applyDelta(empty, delta!) as unknown as { entries: Record<string, unknown> };
    for (const name of awkward) {
      expect(
        Object.prototype.hasOwnProperty.call(back.entries, name),
        `${name} did not survive the delta`,
      ).toBe(true);
    }

    // And removing them again leaves nothing behind, rather than a key that
    // cannot be deleted because it was never really there.
    const gone = applyDelta(back as never, deltaBetween(withThem, empty)!) as unknown as {
      entries: Record<string, unknown>;
    };
    for (const name of awkward) {
      expect(
        Object.prototype.hasOwnProperty.call(gone.entries, name),
        `${name} could not be removed`,
      ).toBe(false);
    }
  });
});

/**
 * A pass that fails outright, from wherever it was started (F16).
 *
 * `Client.sync` swallows exceptions on purpose: most of its callers are event
 * handlers with nothing useful to do with one, a ticker, an arriving batch, a
 * file the host says was saved. What it did with the exception was log it if
 * a logger happened to be configured, and nothing else. So a device that
 * connected and then failed every pass went on showing the status of the last
 * pass that worked, which is the status rule in docs/design.md read backwards.
 */
describe("a background pass that fails (F16)", () => {
  it("tells the shell, rather than logging it if anybody asked", async () => {
    const { Client } = await import("./client.ts");
    const { MemoryIndexStore } = await import("./vault.ts");
    const { FakeSocket, ready } = await import("./fake-socket.ts");

    const socket = new FakeSocket();
    const failures: string[] = [];
    const client = new Client({
      vault: new MemoryVault(),
      store: new MemoryIndexStore(),
      url: "ws://test",
      deviceId: "d",
      token: "t",
      vaultId: "v",
      device: "d",
      socketFactory: () => socket,
      onSyncFailed: (err) => void failures.push(err.message),
    });
    const connecting = client.connect({ waitForBacklog: false });
    socket.open();
    await settle();
    socket.reply(ready({ cursor: 0 }));
    await connecting;

    // A pass that cannot finish: the engine throws rather than filing one
    // path for retry, which is the whole-pass case `onPass` never sees.
    (client as unknown as { engine: { sync(): Promise<never> } }).engine.sync = async () => {
      throw new Error("the index will not save");
    };

    const report = await client.sync();
    expect(report, "a failed pass reported a result").toBeUndefined();
    expect(failures, "the shell was never told the pass failed").toEqual([
      "the index will not save",
    ]);
    await client.close();
  });
});

/**
 * The edit a stat cannot see (R01).
 *
 * The guard added for F01 compares the file's length and its rounded
 * modification time, and both of those are what an ordinary correction leaves
 * alone: swapping one word for another of the same length, saved inside the
 * same second or by an editor that carries the timestamp across a temporary
 * file, is invisible to it. The review reproduced exactly that and the local
 * edit was overwritten with no copy anywhere.
 *
 * Narrowing the window does not fix it, because there is no compare-and-swap
 * on a file, so the write itself preserves instead: whatever is displaced is
 * moved aside first and kept if it is a surprise. These assert the property
 * that matters, which is not "the write was refused" but "the bytes nobody
 * sent anywhere are still on this disk".
 */
describe("an edit a stat cannot tell apart", () => {
  it("survives a download that lands on it, same length and same timestamp", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    // Exactly the same number of bytes, written back at exactly the same
    // stamp: a correction, saved by an editor that preserves timestamps.
    const before = "the original line\n";
    const after = "the ORIGINAL line\n";
    expect(after.length, "the two versions must be the same length or this proves nothing").toBe(
      before.length,
    );

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "note.md", before, bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("note.md")).toBe(before);
    const stamped = await vault.stat("note.md");

    // The editor, inside the fetch for the next version, leaving the metadata
    // exactly as it was.
    servingWith(socket, bodies, async () => {
      await vault.write("note.md", enc.encode(after), {
        mtime: stamped!.mtime,
        ctime: stamped!.ctime,
      });
    });
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [
        await entryFor(2, "note.md", "the server's own version\n", bodies, { mtime: 9000 }),
      ],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const everywhere = vault
      .paths()
      .map((p) => vault.text(p) ?? "")
      .join("\n");
    expect(
      everywhere,
      `the local edit is gone. The vault holds: ${JSON.stringify(vault.paths())}`,
    ).toContain(after);
  });

  /**
   * The same edit, under the landing that never goes to the network (R19).
   *
   * Chunk names are hashes of the raw bytes, so a version whose content this
   * device already holds somewhere else is written from that copy rather than
   * fetched. That is the path a move takes, and it writes over the
   * destination exactly as a download does.
   *
   * The first fix routed it through the preserving write and then reported
   * "could not use the local copy", so the pass fetched the same bytes and
   * wrote them again, over the version it had just landed: two conflict
   * copies, the second one holding the server's own text, from one edit.
   */
  it("keeps the edit when the version is rebuilt from a copy this device has", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    const shared = "the version both notes end up holding\n";
    const before = "the original line\n";
    const after = "the ORIGINAL line\n";
    expect(after.length, "the two versions must be the same length or this proves nothing").toBe(
      before.length,
    );

    socket.raw({
      op: "batch",
      from: 1,
      to: 2,
      entries: [
        await entryFor(1, "held.md", shared, bodies),
        await entryFor(2, "note.md", before, bodies),
      ],
    });
    await accepted(engine, 2);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("note.md")).toBe(before);
    const stamped = await vault.stat("note.md");

    // The gap this is about is between the baseline digest, taken as the
    // version is queued, and the write at the end of the batch. There is no
    // fetch for the reused path, so the batch is given a second note that does
    // need one: that fetch is the pause, and the editor types during it.
    servingWith(socket, bodies, async () => {
      await vault.write("note.md", enc.encode(after), {
        mtime: stamped!.mtime,
        ctime: stamped!.ctime,
      });
    });

    // And now the server says `note.md` holds what `held.md` already does,
    // which is the content this device can rebuild without a fetch.
    socket.raw({
      op: "batch",
      from: 3,
      to: 4,
      entries: [
        await entryFor(3, "note.md", shared, bodies, { mtime: 9000 }),
        await entryFor(4, "fetched.md", "something only the server has\n", bodies, {
          mtime: 9000,
        }),
      ],
    });
    await accepted(engine, 2);
    await engine.sync({ coalesceWrites: false });

    const held = vault.paths().map((p) => [p, vault.text(p)] as const);
    expect(
      held.map(([, t]) => t).filter((t) => t === after),
      `the local edit should be kept exactly once. The vault holds: ${JSON.stringify(vault.paths())}`,
    ).toHaveLength(1);
    // And exactly the two notes that should hold the shared version: the one
    // it came from and the one it landed at. A third is the pass writing it
    // twice and calling the second one a conflict.
    expect(
      held.filter(([, t]) => t === shared).map(([p]) => p),
      "the server's own version was kept as a conflict copy of itself",
    ).toEqual(["held.md", "note.md"]);
  });

  /**
   * And the other outcome of the same instant: the write itself loses.
   *
   * The adapters reserve the destination with an exclusive create, so a file
   * that appears in the moment the name is free keeps it, and the incoming
   * version has nowhere to go. Dropping it would be a version the server holds
   * and this device silently does not, with the index recording it as landed.
   */
  it("keeps the incoming version beside the note when the name is taken", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "note.md", "the original line\n", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    // Somebody takes the name in the instant it is free, which the real
    // adapters find out about from an exclusive create and this one is told.
    servingWith(socket, bodies, () => {
      vault.nameTakenOnce = enc.encode("a note somebody made under that name\n");
    });
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [
        await entryFor(2, "note.md", "the server's own version\n", bodies, { mtime: 9000 }),
      ],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const texts = vault.paths().map((p) => vault.text(p));
    expect(
      texts,
      `the incoming version was dropped. The vault holds: ${JSON.stringify(vault.paths())}`,
    ).toContain("the server's own version\n");
    // And the file that took the name is still the file at the name.
    expect(vault.text("note.md")).toBe("a note somebody made under that name\n");
    // As is the version that was there before it.
    expect(texts).toContain("the original line\n");
  });

  /**
   * R33. A path the pass has never seen still has to be looked at when the
   * write lands.
   *
   * There is no baseline for a first download, and no baseline for a file
   * whose content could not be read. Both reached the adapters as "write over
   * whatever is there", which is the one thing this whole mechanism exists to
   * stop: the pass looked at the start, the fetch took seconds, and the note
   * created in between was the only copy anybody had.
   */
  it("keeps a note created at a path the pass had never seen", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();

    // Created inside the adapter, which is the only place left after the
    // engine's last look at the path. Putting it in the fetch instead proves
    // nothing: the metadata check that follows the fetch sees the new file and
    // stops the write on its own, so the test would pass with the adapter
    // writing over it. This hook runs after that check.
    servingWith(socket, bodies);
    vault.midReplace = async (path) => {
      vault.midReplace = undefined;
      if (path !== "fresh.md") return;
      await vault.write("fresh.md", enc.encode("unsent local\n"), { mtime: 5000, ctime: 5000 });
    };
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "fresh.md", "the server's version\n", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const texts = vault.paths().map((p) => vault.text(p));
    expect(
      texts,
      `the note created under the write is gone. The vault holds: ${JSON.stringify(vault.paths())}`,
    ).toContain("unsent local\n");
    expect(texts).toContain("the server's version\n");
  });

  /**
   * And a deletion with no baseline goes through the same door (R33).
   *
   * `removedSomethingElse` skipped `removeExpecting` entirely when the digest
   * was missing and called the plain `remove`, which takes whatever is at the
   * name. So the one case the R33 contract names -- a baseline that could not
   * be read -- was the one case the preserving removal was not used, and the
   * pass reported it as an ordinary deletion rather than as something kept.
   *
   * A file is unreadable for a moment more often than it sounds: a backup tool
   * holding it, an indexer, a permissions blip.
   */
  it("keeps an edit under a deletion whose baseline could not be read", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "doomed.md", "the original line\n", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    // The baseline cannot be read when the pass asks for it, so the deletion
    // is queued with none.
    vault.contentDigest = async () => undefined;
    // And the editor saves in the window, keeping the length and the stamp so
    // the metadata check cannot see it either.
    const stamped = await vault.stat("doomed.md");
    vault.midReplace = async (path) => {
      vault.midReplace = undefined;
      if (path !== "doomed.md") return;
      await vault.write("doomed.md", enc.encode("the ORIGINAL line\n"), {
        mtime: stamped!.mtime,
        ctime: stamped!.ctime,
      });
    };

    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entryFor(2, "doomed.md", "", bodies, { deleted: true, mtime: 9000 })],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const texts = vault.paths().map((p) => vault.text(p));
    expect(
      texts,
      `the edit was deleted on a baseline nothing could read. The vault holds: ${JSON.stringify(vault.paths())}`,
    ).toContain("the ORIGINAL line\n");
  });

  it("survives a deletion that lands on it, same length and same timestamp", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    // The note has to be one the server knows about, or the tombstone below
    // is about a path this device has never heard of and there is nothing to
    // apply.
    const before = "the original line\n";
    const after = "the ORIGINAL line\n";
    expect(after.length).toBe(before.length);
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "doomed.md", before, bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("doomed.md")).toBe(before);
    const stamped = await vault.stat("doomed.md");

    // The seam is the removal's own, which is the only moment a save can land
    // for a deletion: it carries no body, so there is no fetch to hide in.
    vault.midReplace = async (path) => {
      if (path !== "doomed.md") return;
      vault.midReplace = undefined;
      await vault.write("doomed.md", enc.encode(after), {
        mtime: stamped!.mtime,
        ctime: stamped!.ctime,
      });
    };

    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entryFor(2, "doomed.md", "", bodies, { deleted: true, mtime: 9000 })],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const everywhere = vault
      .paths()
      .map((p) => vault.text(p) ?? "")
      .join("\n");
    expect(
      everywhere,
      `the edit made while the deletion was being applied is gone: ${JSON.stringify(vault.paths())}`,
    ).toContain(after);
  });

  /**
   * And the ordinary case is untouched: a download that lands on exactly what
   * the pass decided about overwrites it and makes no conflict copy. Without
   * this, "preserve everything" would pass the two tests above by never
   * writing anything.
   */
  it("still overwrites a file nobody touched, with no copy left behind", async () => {
    const { engine, socket, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(1, "quiet.md", "what was here\n", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("quiet.md")).toBe("what was here\n");

    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entryFor(2, "quiet.md", "the server's version\n", bodies, { mtime: 9000 })],
    });
    await accepted(engine, 1);
    const report = await engine.sync({ coalesceWrites: false });

    expect(vault.text("quiet.md")).toBe("the server's version\n");
    expect(vault.paths(), "a conflict copy was made for a file nobody had touched").toEqual([
      "quiet.md",
    ]);
    expect(report.conflicted).toBe(0);
  });
});
