/**
 * Putting back a body the server lost, without inventing an edit (I14).
 *
 * `trew verify` finds a chunk whose bytes no longer hash to its name, sets
 * it aside, and says it is waiting for a device to resend it. Nothing ever did.
 * A device whose copy of the note has not changed is right to consider it
 * synced: the entry is committed, the hashes agree, and a pass has nothing to
 * do. It is holding the missing bytes and has no reason to send them.
 *
 * So the vault had a version every device would download for ever and no device
 * would repair, and the only way to make one send the body was to edit the
 * note, which writes a version nobody typed into the history of a vault that is
 * already damaged.
 *
 * The three cases here are the three the review asked for: a current chunk that
 * this device can supply, a historical one that it cannot, and a second device
 * that can supply what the first could not.
 */

import { mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "./core/client.ts";
import { MemoryIndexStore, MemoryVault } from "./core/vault.ts";
import { TestServer, serverBinary } from "./core/test-server.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function device(
  server: TestServer,
  name: string,
): Promise<{ c: Client; vault: MemoryVault }> {
  const vault = new MemoryVault();
  const c = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(name)),
    vaultId: "default",
    device: name,
    timeoutMs: 60_000,
    coalesceWrites: false,
  });
  cleanups.push(async () => c.close());
  await c.connect();
  return { c, vault };
}

/** Every body file in the server's chunk tree, by full path. */
async function bodies(server: TestServer): Promise<string[]> {
  const root = join(server.dataDir, "chunks");
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (!item.name.endsWith(".quarantine")) out.push(full);
    }
  };
  await walk(root).catch(() => undefined);
  return out.sort();
}

/**
 * Loses one body the way a disk does: the file is gone and every row still
 * refers to it. Returns the name so a test can say which.
 */
async function loseOneBody(server: TestServer, which = 0): Promise<string> {
  const all = await bodies(server);
  expect(all.length, "the server holds no bodies, so nothing can be lost").toBeGreaterThan(which);
  const victim = all[which]!;
  await unlink(victim);
  return victim;
}

describe("what repair costs the device running it", () => {
  it("reads nothing when the server is not missing anything", async () => {
    // The offer is the index's own chunk names, so making it opens no files
    // (R083-09). It used to plan an upload for every synced note before
    // offering anything, which on a phone meant reading, chunking and sealing
    // the whole vault to find out the server had lost nothing.
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    for (let i = 0; i < 12; i++) await a.vault.edit(`note-${i}.md`, `note number ${i}\n`);
    await a.c.settle({}, 8);

    const read = a.vault.read.bind(a.vault);
    const opened: string[] = [];
    a.vault.read = async (path) => {
      opened.push(path);
      return read(path);
    };

    const out = await a.c.repair();
    expect(out.scanned, "there was nothing to scan, so this proves nothing").toBeGreaterThan(0);
    expect(out.offered).toBeGreaterThan(0);
    expect(out.stored).toBe(0);
    expect(out.failed).toEqual([]);
    expect(opened, "repair read files the server never asked for").toEqual([]);
  }, 120_000);

  it("offers a whole vault in a handful of round trips", async () => {
    // One `resend` per file meant one round trip per file whatever the answer
    // was, and the answer is almost always "I have all of those". At ten
    // thousand notes and 200 ms to the server that is over half an hour of
    // waiting on the connection's serial queue (Codex-01).
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    for (let i = 0; i < 40; i++) await a.vault.edit(`note-${i}.md`, `note number ${i}\n`);
    await a.c.settle({}, 8);

    let requests = 0;
    const resend = a.c.transport.resend.bind(a.c.transport);
    a.c.transport.resend = async (...args) => {
      requests++;
      return resend(...args);
    };
    const out = await a.c.repair();
    expect(out.scanned).toBe(40);
    expect(out.offered).toBeGreaterThan(0);
    expect(requests, `${requests} round trips for 40 files`).toBe(1);
  }, 120_000);

  it("reads only the note whose body is missing", async () => {
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    for (let i = 0; i < 12; i++) await a.vault.edit(`note-${i}.md`, `note number ${i}\n`);
    await a.c.settle({}, 8);
    await loseOneBody(server, 3);

    const read = a.vault.read.bind(a.vault);
    const opened: string[] = [];
    a.vault.read = async (path) => {
      opened.push(path);
      return read(path);
    };

    const out = await a.c.repair();
    expect(out.stored, "nothing was put back, so the read count means nothing").toBeGreaterThan(0);
    // One note, because one body was lost. The old shape read all twelve.
    expect(new Set(opened).size, `repair opened ${[...new Set(opened)].join(", ")}`).toBe(1);
  }, 120_000);
});

describe("a note that changed after the last sync", () => {
  it("is skipped without taking the rest of the run with it", async () => {
    // The read moved to the first body the server asks for (R083-09), and the
    // check that the disk still matches the index moved with it. That is the
    // one moment the disagreement cannot be withdrawn: the server has sent
    // `want` and is reading binary frames, so a refusal there ends the
    // connection and every later path fails with it, listed as though this
    // device could not read them. A stat before the offer is what keeps the
    // common case off the wire.
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    await a.vault.edit("changed.md", "the version the server acknowledged\n");
    await a.vault.edit("steady.md", "this one has not moved\n");
    await a.c.settle({}, 8);

    // Both bodies lost, and one of the two notes edited since that sync
    // without a pass having noticed: the index still says it holds what the
    // server acknowledged, and the disk does not.
    await loseOneBody(server, 0);
    await loseOneBody(server, 0);
    await a.vault.edit("changed.md", "but this device has moved on\n");

    const out = await a.c.repair();
    expect(out.couldNotOffer, "the changed note was offered anyway").toBeGreaterThan(0);
    expect(out.failed, "a changed note took the rest of the run down with it").toEqual([]);
    expect(out.stored, "the unchanged note's body was not put back").toBeGreaterThan(0);
    // And the connection is still usable, which is what the acks depend on.
    await expect(a.c.settle({}, 2)).resolves.toBeTruthy();
  }, 120_000);
});

describe("a body the server has lost", () => {
  it("is put back by a device that still has the note, and no version is written", async () => {
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    await a.vault.edit("note.md", "the only copy of this\n");
    await a.vault.edit("other.md", "something else\n");
    await a.c.settle({}, 8);

    const before = JSON.parse(await server.cli("stats", "-json")) as {
      vaults: Array<{ versions: number; latestUid: number }>;
    };
    const gone = await loseOneBody(server);
    await expect(stat(gone)).rejects.toThrow();

    // `verify` sees it, which is what somebody would run first. It exits
    // non-zero on a fault, so a rejection here is the signal; a resolved
    // promise would mean the missing body went unnoticed.
    await expect(
      server.cli("verify"),
      "verify passed on a vault with a body missing",
    ).rejects.toThrow();

    const out = await a.c.repair();
    expect(out.stored, `repair stored ${out.stored} bodies`).toBeGreaterThan(0);
    expect(out.couldNotOffer, "a device holding both notes said it could not supply one").toBe(0);
    expect(out.stillMissing, "the server asked for bodies and did not keep them").toBe(0);
    expect(out.failed).toEqual([]);

    // The body is back...
    await expect(stat(gone)).resolves.toBeTruthy();
    // ...and `verify` is quiet again.
    await expect(server.cli("verify")).resolves.toBeTruthy();

    // And nothing was written into the vault to achieve it. This is the whole
    // point: the alternative was editing a note to force an upload, which puts
    // a version nobody typed into a damaged vault's history.
    const after = JSON.parse(await server.cli("stats", "-json")) as {
      vaults: Array<{ versions: number; latestUid: number }>;
    };
    expect(after.vaults[0]?.versions, "repair wrote a version").toBe(before.vaults[0]?.versions);
    expect(after.vaults[0]?.latestUid, "repair allocated a uid").toBe(before.vaults[0]?.latestUid);
  }, 120_000);

  /**
   * The case a device cannot see, and must not paper over.
   *
   * A body belonging to a version this device no longer holds is not on its
   * disk and is not in its index: nothing here could notice it is gone. So
   * repair reports a clean run, correctly, and the thing that must be true is
   * that a clean run is not sold as a whole vault. `trew verify` on the
   * server is what knows, and both shells point at it.
   *
   * Written as a test rather than a comment because the tempting fix is to make
   * repair claim it checked: a count of "history I could not reach" that a
   * device cannot actually compute would be a number that reads like assurance
   * and means nothing.
   */
  it("cannot see a lost historical body, and does not pretend the vault is whole", async () => {
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    await a.vault.edit("note.md", "the first version, which will become history\n");
    await a.c.settle({}, 8);
    const historical = await bodies(server);
    expect(historical).toHaveLength(1);

    // A second version. The first is now history, and this device no longer
    // holds its bytes: the file on disk is the new one.
    await a.vault.edit("note.md", "the second version, which is what is on disk\n");
    await a.c.settle({}, 8);

    // Lose the historical body, not the current one.
    await unlink(historical[0]!);

    const out = await a.c.repair();
    expect(out.stored, "a body this device cannot have was somehow supplied").toBe(0);
    expect(out.failed).toEqual([]);
    // The current version is fine, so this device sees nothing wrong. That is
    // the correct answer to the question it can ask.
    expect(out.stillMissing).toBe(0);

    // And the server still knows. This is the half that makes the clean run
    // above safe to report: somebody following the advice repair prints finds
    // out, rather than believing the vault is whole.
    await expect(
      server.cli("verify"),
      "the server did not notice the historical body was gone either",
    ).rejects.toThrow();
  }, 120_000);

  it("is put back by the other device when the first one cannot", async () => {
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    // b holds the note, a never will: a is created after b's push and then
    // told to ignore nothing, so it downloads it. Both hold the same content,
    // which is the ordinary two-device case.
    const b = await device(server, "b");
    await b.vault.edit("shared.md", "written on b and synced everywhere\n");
    await b.c.settle({}, 8);

    const a = await device(server, "a");
    await a.c.settle({}, 8);
    expect(a.vault.text("shared.md"), "a never received the note").toBe(
      "written on b and synced everywhere\n",
    );

    const gone = await loseOneBody(server);
    // Either device can supply it, which is the point of the case: this asks
    // the one that did not write it.
    const out = await a.c.repair();
    expect(out.stored, "the second device could not supply a body it holds").toBeGreaterThan(0);
    await expect(stat(gone)).resolves.toBeTruthy();
  }, 120_000);

  it("refuses a body for a name no entry in the vault refers to", async () => {
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    await a.vault.edit("note.md", "something\n");
    await a.c.settle({}, 8);

    // A perfectly well-formed name for a body nothing references. A device may
    // repair what the vault has lost; it may not write bodies into the store
    // that nothing will ever read, which is a paired device filling a disk.
    const stranger = "f".repeat(64);
    const t = (
      a.c as unknown as { transport: { resend: (n: string[], b: unknown) => Promise<unknown> } }
    ).transport;
    await expect(t.resend([stranger], async () => new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /no entry in this vault refers to/,
    );
  }, 120_000);
});

describe("a vault with nothing wrong", () => {
  it("reports that there was nothing to do", async () => {
    await serverBinary();
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.cleanup());

    const a = await device(server, "a");
    await a.vault.edit("note.md", "all present and correct\n");
    await a.c.settle({}, 8);

    const out = await a.c.repair();
    expect(out.stored).toBe(0);
    expect(out.couldNotOffer).toBe(0);
    expect(out.stillMissing).toBe(0);
    expect(out.failed).toEqual([]);
    // And it did look, which is the difference between "nothing to do" and
    // "nothing was examined".
    expect(out.scanned, "repair examined no notes at all").toBeGreaterThan(0);
    void mkdtemp;
    void rm;
    void writeFile;
    void tmpdir;
  }, 120_000);
});
