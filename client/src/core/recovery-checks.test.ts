/**
 * The restore path's consistency checks: what recovery holds a server's
 * answers to before it shows them or writes them into a vault.
 *
 * Recovery reads what the server hands back and acts on it: a `history` list
 * is shown, a `deleted` list is offered for restore, and a `get` answers with a
 * chunk list that is assembled and written into the vault. The ordinary sync
 * path holds every batch entry to its shape; the path somebody takes on the
 * worst afternoon has to hold its answers to the same, and to each other: the
 * chunks `get` names must be the listed version's, the assembly must be the
 * declared length, a listed version must be the note that was asked for, and
 * the pages must come newest first and go back.
 *
 * This file was `recovery-auth.test.ts`. Two of its twelve cases checked
 * Basalt's entry authenticator and went with it; the other ten are these, and
 * they are the only tests of these checks (plan/strip-ledger.md, hazard 10).
 */

import { describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { chunkName } from "./digest.ts";
import { FakeSocket, ready, settle } from "./fake-socket.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const enc = new TextEncoder();

async function rig() {
  const socket = new FakeSocket();
  const vault = new MemoryVault();
  const client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: "ws://test",
    deviceId: "rig-device",
    token: "t",
    vaultId: "v",
    device: "d",
    timeoutMs: 2000,
    socketFactory: () => socket,
  });
  const connecting = client.connect();
  await settle();
  socket.open();
  for (let i = 0; i < 50 && !socket.sentText.some((m) => m["op"] === "hello"); i++) await settle();
  socket.reply(ready({ cursor: 0, perFileMax: 1 << 28, chunkMax: 1 << 20, maxChunks: 100 }));
  await settle();
  socket.raw({ op: "caught-up", cursor: 0 });
  await connecting;
  return { socket, client, vault };
}

/** One version of one note, as a server lists it, and the chunk it is made of. */
async function version(uid: number, path: string, text: string, over: { deleted?: boolean } = {}) {
  const raw = enc.encode(text);
  const name = await chunkName(raw);
  const entry = {
    uid,
    path,
    size: over.deleted ? 0 : raw.length,
    ctime: 1000,
    mtime: 1000,
    folder: false,
    deleted: over.deleted ?? false,
    chunks: over.deleted ? [] : [name],
    device: "other",
  };
  return { entry, body: { name, raw } };
}

/**
 * Waits until the request is actually on the wire before the fake server
 * answers it.
 *
 * A single `settle` is not enough: the client's operation queue decides when
 * a request goes, so how many ticks pass between calling `history` and the
 * frame being sent is not fixed. Answering early filled in the id of the
 * previous request and the client refused its own reply.
 */
async function sent(socket: FakeSocket, op: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (socket.sentText.some((m) => m["op"] === op)) return;
    await settle();
  }
  throw new Error(`no ${op} was sent`);
}

describe("recovery against a server whose answers do not agree with each other", () => {
  it("refuses to restore when get answers with chunks the listed version did not name", async () => {
    const { socket, client, vault } = await rig();
    const real = await version(7, "note.md", "what was written");
    const other = await version(8, "other.md", "something else entirely");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: "note.md", entries: [real.entry] });
    const [v] = await asking;

    // The server answers the get with another file's chunk list. It is real
    // content, another note's, and it would be written under this note's name.
    const restoring = client.restore(v!);
    await sent(socket, "get");
    socket.reply({
      res: "chunks",
      uid: 7,
      size: other.body.raw.length,
      chunks: [other.body.name],
    });
    await expect(restoring).rejects.toThrow(/not the version it is being offered as/);
    expect(vault.paths()).toEqual([]);
  });

  it("refuses a history entry whose chunk names are not chunk names", async () => {
    const { socket, client } = await rig();
    const good = await version(3, "note.md", "three");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({
      res: "history",
      path: "note.md",
      entries: [{ ...good.entry, chunks: ["not-a-chunk-name"] }],
    });
    // The name's shape is the whole trigger now. It used to be one of two
    // accepted reasons, the other being the authenticator, which would have
    // let this pass for the wrong one (plan/strip-ledger.md, hazard 5).
    await expect(asking).rejects.toThrow(/"not-a-chunk-name", which is not a chunk name/);
  });

  it("still restores a version that checks out", async () => {
    const { socket, client, vault } = await rig();
    const real = await version(7, "note.md", "what was written");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: "note.md", entries: [real.entry] });
    const [v] = await asking;
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "get") {
        s.reply({ res: "chunks", uid: 7, size: real.entry.size, chunks: [real.body.name] });
      } else if (frame["op"] === "fetch") s.bodies(real.body.raw);
    };
    const done = await client.restore(v!);
    expect(done.path).toBe("note.md");
    expect(vault.text("note.md")).toBe("what was written");
  });
});

/**
 * C-D4 and C-D5 in the 0.3.0 review. `land` checks an assembly against the size
 * its entry declares, and refuses an entry whose shape contradicts itself. The
 * recovery path, which is the one somebody takes on the worst afternoon, made
 * neither check: it checked the chunk list against the listed one and then
 * wrote whatever came back.
 */
describe("recovery against a server that answers with the right names (C-D4, C-D5)", () => {
  it("refuses to restore a version that assembles to a length it does not declare", async () => {
    const { socket, client, vault } = await rig();
    const short = await version(7, "note.md", "short");
    // Self-contradictory: 500 bytes made of one chunk holding five.
    // Everything the recovery path checked passed, and the note came back
    // five bytes long with nothing saying so.
    const entry = { ...short.entry, size: 500 };
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: "note.md", entries: [entry] });
    const [v] = await asking;

    socket.autoReply = (frame, s) => {
      if (frame["op"] === "get") {
        s.reply({ res: "chunks", uid: 7, size: 500, chunks: [short.body.name] });
      } else if (frame["op"] === "fetch") s.bodies(short.body.raw);
    };
    await expect(client.restore(v!)).rejects.toThrow(/assembled to 5 bytes, not the 500/);
    expect(vault.paths(), "a truncated note was written as the restore").toEqual([]);
  });

  it("refuses to restore a version whose listed size is not the server's", async () => {
    const { socket, client, vault } = await rig();
    const real = await version(7, "note.md", "what was written");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: "note.md", entries: [real.entry] });
    const [v] = await asking;

    socket.autoReply = (frame, s) => {
      if (frame["op"] === "get") {
        s.reply({ res: "chunks", uid: 7, size: 4, chunks: [real.body.name] });
      } else if (frame["op"] === "fetch") s.bodies(real.body.raw);
    };
    await expect(client.restore(v!)).rejects.toThrow(
      /offered as 4 bytes and was listed as 16 bytes/,
    );
    expect(vault.paths()).toEqual([]);
  });

  /**
   * F10. A well-formed entry says nothing about which note it belongs to.
   *
   * `history` checked the answer's entries and then relabelled every one with
   * the path the caller had asked for. So a real version of one note came back
   * as a version of another, and restoring it wrote one note's contents under
   * the other's name. Nothing later catches it: the chunk list matches its
   * entry perfectly, because it is a genuine entry, just somebody else's. With
   * paths in the clear, it is refused by plain path equality.
   */
  it("refuses a version of a different note", async () => {
    const { socket, client } = await rig();
    const elsewhere = await version(11, "other.md", "another note entirely");
    const asking = client.history("requested.md");
    await sent(socket, "history");
    // Even the echoed path is the one that was asked for, which is what makes
    // this worth refusing: everything on the outside of the answer is right.
    socket.reply({ res: "history", path: "requested.md", entries: [elsewhere.entry] });
    await expect(asking).rejects.toThrow(/a version of some other note/);
  });

  it("refuses a page that ignores the version it was asked to go back from", async () => {
    const { socket, client } = await rig();
    const newer = await version(20, "note.md", "the newer one");
    const asking = client.history("note.md", { before: 10 });
    await sent(socket, "history");
    socket.reply({ res: "history", path: "note.md", entries: [newer.entry] });
    await expect(asking).rejects.toThrow(/older than 10 with version 20/);
  });

  it("refuses a page whose versions are not newest first", async () => {
    const { socket, client } = await rig();
    const older = await version(3, "note.md", "older");
    const newer = await version(9, "note.md", "newer");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: "note.md", entries: [older.entry, newer.entry] });
    await expect(asking).rejects.toThrow(/out of order/);
  });

  /**
   * The one shape a single answer cannot show: every page is well formed and
   * the pages never advance, so `findVersion` walks backwards for ever.
   */
  it("gives up on a server that keeps answering with the same page", async () => {
    const { socket, client } = await rig();
    const page = [await version(4, "note.md", "a"), await version(3, "note.md", "b")];
    socket.autoReply = (frame, sock) => {
      if (frame["op"] === "history") {
        sock.reply({ res: "history", path: "note.md", entries: page.map((v) => v.entry) });
      }
    };
    await expect(client.findVersion("note.md", () => false, 2)).rejects.toThrow(
      /not paging back through the versions|older than 3 with version 4/,
    );
  });

  it("refuses a history entry that declares bytes and names no chunks", async () => {
    const { socket, client } = await rig();
    // Well formed in every field on its own, and it still cannot be true:
    // restoring it wrote a 500 byte note as 0 bytes.
    const entry = {
      uid: 9,
      path: "note.md",
      size: 500,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [] as string[],
      device: "other",
    };
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: "note.md", entries: [entry] });
    await expect(asking).rejects.toThrow(/declares 500 bytes and names no chunks/);
  });
});
