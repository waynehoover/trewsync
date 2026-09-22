/**
 * What the engine does with an entry it should not act on.
 *
 * Every entry here is authenticated by the vault's own key, so nothing below
 * is a forgery. It is a peer that is well and truly ours and still wrong: a
 * path under a dot folder, a path that is not in canonical form, two paths
 * one disk files as one. The right answer in each case is to refuse the
 * entry, say so once, and never retry what cannot succeed, without ending
 * the session over it.
 */

import { describe, expect, it } from "vitest";

import { macEntry, sealChunks, sealPath, type Schedule } from "./crypto.ts";
import { FakeSocket, engineOnFakeSocket, settle } from "./fake-socket.ts";
import type { WireEntry } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const enc = new TextEncoder();

/** One authenticated entry with real sealed content behind it. */
async function entryFor(
  keys: Schedule,
  uid: number,
  path: string,
  text: string,
  bodies: Map<string, Uint8Array>,
  /** The name this is moved from, for an entry that carries a rename. */
  from?: string,
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
    // In the authenticator, because a rename is one operation and the old
    // name is part of what was signed.
    ...(from !== undefined ? { prev: await sealPath(keys, from) } : {}),
  };
  return { uid, ...facts, device: "other", mac: await macEntry(keys, facts) };
}

/** A server that serves every body it was told about. */
function serving(socket: FakeSocket, bodies: Map<string, Uint8Array>): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
    } else if (frame["op"] === "ping") s.raw({ res: "pong" });
  };
}

async function accepted(engine: { status(): { pending: number } }, n: number): Promise<void> {
  for (let i = 0; i < 400 && engine.status().pending < n; i++) await settle();
}

/**
 * A peer wrote a path under a dot folder, which this device
 * will never list and so would report deleted the moment it wrote it. The
 * vault refused the write, the engine filed the refusal for retry, and the
 * one-shot sync exited 1 on every run for ever, saying the file would be
 * tried again.
 */
describe("an inbound path that never syncs", () => {
  it("is refused at accept as permanent, not retried, and never written", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);
    const entries = [
      await entryFor(keys, 1, ".obsidian/plugins/evil/main.js", "module.exports = 1", bodies),
      await entryFor(keys, 2, "ok.md", "fine", bodies),
    ];
    socket.raw({ op: "batch", from: 1, to: 2, entries });
    await accepted(engine, 1);

    const report = await engine.sync();
    expect(report.downloaded).toBe(1);
    expect(vault.text("ok.md")).toBe("fine");
    expect(vault.text(".obsidian/plugins/evil/main.js")).toBeUndefined();
    expect(report.retrying, "a path that can never sync was filed for retry").toBe(0);
    expect(report.skipped).toBe(1);
    // And the next pass says the same, rather than trying again.
    const again = await engine.sync();
    expect(again.retrying).toBe(0);
    expect(again.skipped).toBe(1);
    expect(socket.sentText.filter((m) => m["op"] === "fetch")).toHaveLength(1);
  });

  it("treats a vault's own never-sync refusal as permanent too", async () => {
    // The dot rule is the engine's; a shell adds names of its own, such as
    // a renamed config folder, and only the vault knows those. Its refusal
    // carries a code, and the engine reads the code.
    class Refusing extends MemoryVault {
      override async write(): Promise<void> {
        const err = new Error(
          "refusing to write inside a folder that is never synced: x",
        ) as Error & {
          code: string;
        };
        err.code = "neversync";
        throw err;
      }
    }
    const { engine, socket, keys } = await engineOnFakeSocket({}, { vault: new Refusing() });
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "config/x.md", "y", bodies)],
    });
    await accepted(engine, 1);
    const report = await engine.sync();
    expect(report.retrying).toBe(0);
    expect(report.skipped).toBe(1);
  });
});

/**
 * `a//b`, `a/./b` and `a/b/` are not the paths they look
 * like: a filesystem collapses them onto `a/b`, and the engine keyed its
 * whole idea of a file on the string as it arrived. Two spellings of one file
 * are two entries here and one file there, which is the alias problem with a
 * different cause, so a path that is not already canonical is refused.
 */
describe("a wire path that is not canonical", () => {
  it("is refused at accept, by name, and the canonical one beside it is taken", async () => {
    const { engine, socket, vault, keys, logs } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);
    const odd = ["a//b.md", "a/./c.md", "d/e.md/", "/f.md", "g/../h.md", ""];
    const entries = [
      ...(await Promise.all(odd.map((p, i) => entryFor(keys, i + 1, p, `odd ${i}`, bodies)))),
      await entryFor(keys, odd.length + 1, "a/b.md", "canonical", bodies),
    ];
    socket.raw({ op: "batch", from: 1, to: entries.length, entries });
    await accepted(engine, 1);

    const report = await engine.sync();
    expect(vault.text("a/b.md")).toBe("canonical");
    expect(vault.paths()).toEqual(["a/b.md"]);
    expect(report.skipped).toBe(odd.length);
    expect(report.retrying).toBe(0);
    expect(logs.some((l) => /not canonical|canonical/.test(l))).toBe(true);
    // The session survives: a wrong path from a peer is not a reason to
    // disconnect from the server.
    expect(socket.closed).toBe(false);
  });

  it("is still refused, and still counted, after a restart", async () => {
    // The refusal used to live only in memory: the version was dropped on the
    // floor at accept, so a restart forgot both the refusal and the fact that
    // anything had been refused, and the panel's count of written-off paths
    // reset itself to zero with nothing having been fixed (R083-04, rule 7).
    const store = new MemoryIndexStore();
    const bodies = new Map<string, Uint8Array>();
    const odd = ["a//b.md", "a/./c.md", "d/e.md/", "/f.md", "g/../h.md"];

    const first = await engineOnFakeSocket({}, { store });
    serving(first.socket, bodies);
    const entries = await Promise.all(
      odd.map((p, i) => entryFor(first.keys, i + 1, p, `odd ${i}`, bodies)),
    );
    first.socket.raw({ op: "batch", from: 1, to: entries.length, entries });
    await accepted(first.engine, 1);
    const before = await first.engine.sync();
    expect(before.skipped).toBe(odd.length);
    first.socket.close();

    // A second engine on the state the first one saved, told nothing new.
    const again = await engineOnFakeSocket({ cursor: odd.length }, { store });
    serving(again.socket, bodies);
    const after = await again.engine.sync();
    expect(after.skipped, "the refusals were forgotten across a restart").toBe(odd.length);
    expect(after.retrying).toBe(0);
    expect(again.vault.paths()).toEqual([]);
  });

  it("stops being refused once the peer that wrote it takes it away", async () => {
    // Persisting the refusal is only half of it. The other half is that there
    // has to be a way back: a peer renaming `a//b.md` to `a/b.md` sends the
    // removal of the old name, and if that removal is itself refused and
    // pinned in `pending` for ever, the vault can never report a clean sync
    // again and nobody can do anything about it (rule 7).
    const { engine, socket, keys, vault } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "a//b.md", "written wrong", bodies)],
    });
    await accepted(engine, 1);
    expect((await engine.sync()).skipped).toBe(1);

    // The rename, as a peer sends one: the new name, moved from the old.
    const fixed = await entryFor(keys, 2, "a/b.md", "written wrong", bodies, "a//b.md");
    socket.raw({ op: "batch", from: 2, to: 2, entries: [fixed] });
    await accepted(engine, 1);
    await engine.sync();
    const settled = await engine.sync();
    expect(vault.text("a/b.md")).toBe("written wrong");
    expect(settled.skipped, "the refusal outlived the path it was about").toBe(0);
    // Not `retrying`: the download created the folder `a`, which this device
    // now wants to publish, and the rig's socket answers no upload.
    expect(settled.skippedPaths).toEqual([]);
  });
});

/**
 * The alias check ran per fill, against the listing taken at
 * the start of the pass, so two paths one disk files as one that arrived in
 * different fills of one pass both landed: the second over the first, and
 * both recorded as synced.
 */
describe("two aliases of one file arriving in different fills", () => {
  it("refuses the second, because the first has already landed this pass", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);
    // The inbox fills at 256 entries. The first spelling is in the first
    // fill and the second is the two hundred and fifty-seventh entry.
    const entries: WireEntry[] = [await entryFor(keys, 1, "Note.md", "capital", bodies)];
    for (let i = 2; i <= 256; i++) {
      entries.push(
        await entryFor(keys, i, `filler/${String(i).padStart(3, "0")}.md`, `f${i}`, bodies),
      );
    }
    entries.push(await entryFor(keys, 257, "note.md", "lower", bodies));
    socket.raw({ op: "batch", from: 1, to: 257, entries });
    await accepted(engine, 257);

    const report = await engine.sync();
    expect(vault.text("Note.md")).toBe("capital");
    expect(vault.text("note.md"), "the alias landed over the first spelling").toBeUndefined();
    expect(report.blocked).toBe(1);
    expect(report.inTheWay).toContainEqual({ path: "note.md", blockedBy: "Note.md" });
    expect(report.downloaded).toBe(256);
  }, 60_000);
});

/**
 * Every sealed path ever seen was kept in a map for the life
 * of the session, so a device that stayed connected through months of
 * renames and deletions held every name it had ever been told, for nothing.
 */
describe("the sealed-path cache", () => {
  it("forgets paths that nothing refers to any more", async () => {
    const { engine, socket, vault, keys, logs } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "gone.md", "here", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync();
    expect(vault.text("gone.md")).toBe("here");
    expect(engine.status().cachedPaths).toBe(1);

    // A deletion arrives for it and is applied; the next pass prunes the
    // remote record, and with it the cached name.
    const deletion = {
      path: await sealPath(keys, "gone.md"),
      size: 0,
      ctime: 0,
      mtime: 2000,
      folder: false,
      deleted: true,
      chunks: [],
      parent: "",
    };
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [{ uid: 2, ...deletion, device: "other", mac: await macEntry(keys, deletion) }],
    });
    await accepted(engine, 1);
    // Without the write debounce: the file was landed a moment ago and a
    // one-shot sync does not defer it to a next pass that never comes.
    const applied = await engine.sync({ coalesceWrites: false });
    expect(vault.text("gone.md"), `${JSON.stringify(applied)} ${logs.join("\n")}`).toBeUndefined();
    await engine.sync({ coalesceWrites: false });
    expect(engine.status().cachedPaths).toBe(0);
  });
});
