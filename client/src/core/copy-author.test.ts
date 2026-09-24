/**
 * Whose name a conflict copy carries (decided 2026-09-23).
 *
 * A copy is named after the author of the bytes it holds, not after the device
 * that made it. On a real phone, `From the Mac (Conflicted copy android-a1c2
 * ...)` held the Mac's text, and a copy of an agent's edit would have carried
 * the phone's name: the one fact the name is there to tell somebody was the
 * wrong way round.
 *
 * So each place the engine puts bytes beside a note is driven here, and the
 * copy is read back by its bytes, then asked whose name it has: the incoming
 * version's author, as the entry the server sent recorded it, for what arrived;
 * this device's name for what was on this disk, and for a merge it made; and
 * this device's name when a version carries no author at all.
 *
 * The engine here is "d", and every version the fake server sends is written
 * by someone else unless a case says otherwise.
 */

import { describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { conflictOriginal } from "./conflicts.ts";
import { FakeSocket, engineOnFakeSocket, settle } from "./fake-socket.ts";
import { pathReason } from "./path-policy.ts";
import type { WireEntry } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const enc = new TextEncoder();

/** What the fake server holds: chunk bodies by name, and versions by uid. */
interface Held {
  readonly bodies: Map<string, Uint8Array>;
  readonly versions: Map<number, WireEntry>;
}

async function entry(
  uid: number,
  path: string,
  text: string,
  held: Held,
  over: { deleted?: boolean; mtime?: number; device?: string } = {},
): Promise<WireEntry> {
  const raw = enc.encode(text);
  const name = await chunkName(raw);
  held.bodies.set(name, raw);
  const e: WireEntry = {
    uid,
    path,
    size: over.deleted ? 0 : raw.length,
    ctime: 1000,
    mtime: over.mtime ?? 1000,
    folder: false,
    deleted: over.deleted ?? false,
    chunks: over.deleted ? [] : [name],
    device: over.device ?? "phone",
  };
  held.versions.set(uid, e);
  return e;
}

/**
 * A server that answers fetches and version lookups, takes every write, and
 * says what it holds when asked. `during` runs before the bodies of each
 * fetch go out, which is the editor typing while a version is on the wire;
 * `stale` is how many writes it refuses as out of date first.
 */
function serving(
  socket: FakeSocket,
  { bodies, versions }: Held,
  opts: { during?: () => Promise<void> | void; history?: WireEntry[]; stale?: number } = {},
): void {
  let uid = 100;
  let stale = opts.stale ?? 0;
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      const send = (): void =>
        void s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      const ran = opts.during?.();
      if (ran instanceof Promise) void ran.then(send);
      else send();
    } else if (frame["op"] === "get") {
      const v = versions.get(frame["uid"] as number)!;
      s.reply({ res: "chunks", uid: v.uid, size: v.size, chunks: v.chunks });
    } else if (frame["op"] === "putmany") {
      const entries = frame["entries"] as unknown[];
      s.reply({
        res: "acks",
        results: entries.map(() =>
          stale-- > 0 ? { code: "stale", msg: "another device wrote first" } : { uid: ++uid },
        ),
      });
    } else if (frame["op"] === "history") {
      s.reply({ res: "history", path: frame["path"], entries: opts.history ?? [] });
    } else if (frame["op"] === "applied") {
      s.reply({ res: "applied", cursor: frame["applied"] });
    } else if (frame["op"] === "ping") {
      s.raw({ res: "pong" });
    }
  };
}

async function accepted(engine: { status(): { pending: number } }, n: number): Promise<void> {
  for (let i = 0; i < 400 && engine.status().pending < n; i++) await settle();
}

/** The one path holding exactly `text`, other than `except`. */
function holding(vault: MemoryVault, text: string, except = ""): string {
  const found = vault.paths().filter((p) => p !== except && vault.text(p) === text);
  expect(found, `${JSON.stringify(text)} is at: ${JSON.stringify(vault.snapshot())}`).toHaveLength(
    1,
  );
  return found[0]!;
}

/**
 * A copy of `path` named after `author`, in the one shape the review reads,
 * numbered or not: two copies by one author inside a minute share a stamp.
 */
function copyOf(path: string, author: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot === -1 ? [path, ""] : [path.slice(0, dot), path.slice(dot)];
  return new RegExp(
    `^${esc(stem)} \\(Conflicted copy ${esc(author)} \\d{12}\\)(?: \\d+)?${esc(ext)}$`,
  );
}

/** A note synced at version 1, from `device`, on an engine the fake server serves. */
async function synced(text: string, device = "phone") {
  const rig = await engineOnFakeSocket();
  const held: Held = { bodies: new Map(), versions: new Map() };
  serving(rig.socket, held);
  rig.socket.raw({
    op: "batch",
    from: 1,
    to: 1,
    entries: [await entry(1, "note.md", text, held, { device })],
  });
  await accepted(rig.engine, 1);
  await rig.engine.sync({ coalesceWrites: false });
  expect(rig.vault.text("note.md")).toBe(text);
  return { ...rig, held };
}

describe("a copy of an incoming version", () => {
  it("is named after the device that wrote it, not this one", async () => {
    const { engine, socket, vault, held } = await synced("The original sentence.\n");

    // The same line rewritten on both sides, which no merge may combine.
    await vault.edit("note.md", "This device's sentence.\n", 5000);
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entry(2, "note.md", "The phone's sentence.\n", held, { mtime: 2000 })],
    });
    await accepted(engine, 1);
    const report = await engine.sync({ coalesceWrites: false });

    expect(report.conflicted).toBe(1);
    expect(vault.text("note.md")).toBe("This device's sentence.\n");
    expect(holding(vault, "The phone's sentence.\n")).toMatch(copyOf("note.md", "phone"));
  });

  it("is named after an agent's token label, made safe, when an agent wrote it", async () => {
    const { engine, socket, vault, held } = await synced("The original sentence.\n");

    await vault.edit("note.md", "This device's sentence.\n", 5000);
    const label = "Claude/Mac: work\t";
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [
        await entry(2, "note.md", "The agent's sentence.\n", held, {
          mtime: 2000,
          device: label,
        }),
      ],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const copy = holding(vault, "The agent's sentence.\n");
    expect(copy).toMatch(copyOf("note.md", "Claude-Mac- work"));
    // A name the server takes and the conflict review offers.
    expect(pathReason(copy)).toBeUndefined();
    expect(conflictOriginal(copy)).toBe("note.md");
  });

  it("is named after its author when the note changed while it was on the wire", async () => {
    const { engine, socket, vault, held } = await synced("one\n");

    serving(socket, held, {
      during: () => vault.write("note.md", enc.encode("mine\n"), { mtime: 5000, ctime: 1000 }),
    });
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entry(2, "note.md", "two\n", held, { mtime: 2000 })],
    });
    await accepted(engine, 1);
    const report = await engine.sync({ coalesceWrites: false });

    expect(report.conflicted).toBe(1);
    expect(vault.text("note.md")).toBe("mine\n");
    expect(holding(vault, "two\n")).toMatch(copyOf("note.md", "phone"));
  });

  it("is named after the writer a stale refusal led this device to", async () => {
    const { engine, socket, vault, held } = await synced("The original sentence.\n");

    // Another device's version 2, which this one is never sent in a batch and
    // learns of only by asking after its own write is refused.
    const theirs = await entry(2, "note.md", "The laptop's sentence.\n", held, {
      mtime: 2000,
      device: "laptop",
    });
    serving(socket, held, { stale: 1, history: [theirs] });
    await vault.edit("note.md", "This device's sentence.\n", 5000);
    await engine.sync({ coalesceWrites: false });
    await engine.sync({ coalesceWrites: false });

    expect(vault.text("note.md")).toBe("This device's sentence.\n");
    expect(holding(vault, "The laptop's sentence.\n")).toMatch(copyOf("note.md", "laptop"));
  });
});

describe("a copy of what was on this disk", () => {
  it("is named after this device when a download displaced an edit", async () => {
    const { engine, socket, vault, held } = await synced("the original line\n");
    const stamped = await vault.stat("note.md");

    // Same length, same stamp: the edit only the preserving write can see.
    serving(socket, held, {
      during: () =>
        vault.write("note.md", enc.encode("the ORIGINAL line\n"), {
          mtime: stamped!.mtime,
          ctime: stamped!.ctime,
        }),
    });
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entry(2, "note.md", "the phone's version\n", held, { mtime: 9000 })],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(vault.text("note.md")).toBe("the phone's version\n");
    expect(holding(vault, "the ORIGINAL line\n")).toMatch(copyOf("note.md", "d"));
  });

  it("names both halves of a write that lost its name after their own authors", async () => {
    const { engine, socket, vault, held } = await synced("the original line\n");

    serving(socket, held, {
      during: () => {
        vault.nameTakenOnce = enc.encode("a note somebody made under that name\n");
      },
    });
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entry(2, "note.md", "the phone's version\n", held, { mtime: 9000 })],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(vault.text("note.md")).toBe("a note somebody made under that name\n");
    // What was on this disk, taken off the name: this device's.
    expect(holding(vault, "the original line\n")).toMatch(copyOf("note.md", "d"));
    // What arrived and found the name taken: the phone's.
    expect(holding(vault, "the phone's version\n")).toMatch(copyOf("note.md", "phone"));
  });

  it("is named after this device when an edit is kept from under a deletion", async () => {
    const { engine, socket, vault, held } = await synced("the original line\n");
    const stamped = await vault.stat("note.md");

    vault.midReplace = async (path) => {
      if (path !== "note.md") return;
      vault.midReplace = undefined;
      await vault.write("note.md", enc.encode("the ORIGINAL line\n"), {
        mtime: stamped!.mtime,
        ctime: stamped!.ctime,
      });
    };
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [await entry(2, "note.md", "", held, { deleted: true, mtime: 9000 })],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(holding(vault, "the ORIGINAL line\n")).toMatch(copyOf("note.md", "d"));
  });

  it("is named after this device when it holds a merge this device made", async () => {
    const base = "line one\nline two\nline three\n";
    const { engine, socket, vault, held } = await synced(base);

    // Two edits a merge combines, and a name taken in the instant the merged
    // text is written: the merged text goes beside, and it is this device's.
    await vault.edit("note.md", "line one, mine\nline two\nline three\n", 5000);
    serving(socket, held, {
      during: () => {
        vault.nameTakenOnce = enc.encode("a note somebody made under that name\n");
      },
    });
    socket.raw({
      op: "batch",
      from: 2,
      to: 2,
      entries: [
        await entry(2, "note.md", "line one\nline two\nline three, theirs\n", held, {
          mtime: 2000,
        }),
      ],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(vault.text("note.md")).toBe("a note somebody made under that name\n");
    // The merge, and the edit it was made from, which the write displaced:
    // both this device's, in one minute, so one of them is numbered.
    const merged = holding(vault, "line one, mine\nline two\nline three, theirs\n");
    const mine = holding(vault, "line one, mine\nline two\nline three\n");
    expect(merged).toMatch(copyOf("note.md", "d"));
    expect(mine).toMatch(copyOf("note.md", "d"));
    expect(merged).not.toBe(mine);
  });
});

describe("a version with no author", () => {
  // Empty, and nothing but what a filename cannot use.
  it.each(["", "..."])(
    "names the copy after this device when the server recorded %j",
    async (device) => {
      const { engine, socket, vault, held } = await synced("The original sentence.\n");

      await vault.edit("note.md", "This device's sentence.\n", 5000);
      socket.raw({
        op: "batch",
        from: 2,
        to: 2,
        entries: [
          await entry(2, "note.md", "A sentence by nobody.\n", held, { mtime: 2000, device }),
        ],
      });
      await accepted(engine, 1);
      await engine.sync({ coalesceWrites: false });

      expect(vault.text("note.md")).toBe("This device's sentence.\n");
      expect(holding(vault, "A sentence by nobody.\n")).toMatch(copyOf("note.md", "d"));
    },
  );

  it("names the copy after this device for an index saved before versions had authors", async () => {
    // Version 1 synced, then the state rewritten as an older engine left it:
    // the server's version 2 known and not yet reconciled, with no author.
    const first = await synced("The original sentence.\n");
    const saved = JSON.parse(JSON.stringify(await first.store.load())) as {
      cursor: number;
      remote: Record<string, Record<string, unknown>>;
      pending: string[];
    };
    first.t.close();
    const theirs = await entry(2, "note.md", "The phone's sentence.\n", first.held, {
      mtime: 2000,
    });
    saved.cursor = 2;
    saved.remote["note.md"] = {
      uid: 2,
      folder: false,
      deleted: false,
      mtime: 2000,
      size: theirs.size,
      hash: theirs.chunks.join(","),
    };
    saved.pending = ["note.md"];
    const store = new MemoryIndexStore();
    await store.save(saved as never);

    const { engine, socket, vault } = await engineOnFakeSocket(
      { cursor: 2 },
      { store, vault: first.vault },
    );
    serving(socket, first.held);
    await vault.edit("note.md", "This device's sentence.\n", 5000);
    await engine.sync({ coalesceWrites: false });

    expect(vault.text("note.md")).toBe("This device's sentence.\n");
    expect(holding(vault, "The phone's sentence.\n")).toMatch(copyOf("note.md", "d"));
  });
});
