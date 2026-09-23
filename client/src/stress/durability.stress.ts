/**
 * What survives a process being taken away mid-write.
 *
 * Durability rule 1 says an ack means the body and the entry are both
 * committed. `stop()` sends SIGTERM and the server shuts down cleanly, which
 * proves nothing about that claim. These kill it outright.
 *
 * Both of these found nothing when first written, which is the point: they are
 * here so that the next change to the commit path cannot quietly break it.
 *
 * The third takes the server away in the other direction: its history is
 * replaced by an older backup, which is what a restore is (rule 11).
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Client } from "../core/client.ts";
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import { buildVault, device, differences, fingerprint, reopen, settle, tidy } from "./harness.ts";

beforeAll(async () => {
  await serverBinary();
}, 300_000);
afterAll(async () => await cleanupBinary());

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];
afterEach(async () => await tidy(open, dirs, server));

const NOTES = 600;

/** Waits until the server's own log says it has committed this many versions. */
async function committedAtLeast(s: TestServer, n: number, ms = 60_000): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = s.committed();
    if (seen >= n || Date.now() > deadline) return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a server killed while it is committing", () => {
  it("loses no note, and a new device still gets every one", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, "a", dirs, open);
    await buildVault(a.dir, NOTES);
    const before = await fingerprint(a.dir);
    expect(before.size).toBe(NOTES);

    // Killed part way through, not at a boundary chosen to be safe.
    const syncing = a.c.settle({}, 32).catch(() => undefined);
    const at = await committedAtLeast(server, 150);
    expect(at, "the server committed nothing, so nothing was under test").toBeGreaterThan(0);
    await server.kill();
    await syncing;

    // The same data directory, and it must open.
    await server.start(server.port);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);

    // The device comes back as a new process would: same directory, whatever
    // index survived, a fresh connection, and the row it was paired as.
    const again = await reopen(server, "a", a.dir, open);
    expect(again.c.deviceId, "the restarted device connected as a new row").toBe(a.c.deviceId);
    await settle([again], 10);
    const b = await device(server, "b", dirs, open);
    await settle([b], 10);

    const after = await fingerprint(b.dir);
    expect(differences(before, after), "a note did not survive the kill").toEqual([]);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});

describe("a client killed while it is uploading", () => {
  it("leaves its own vault untouched and finishes on the next run", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, "a", dirs, open);
    await buildVault(a.dir, NOTES);
    const before = await fingerprint(a.dir);

    // Closing the socket under a sync in flight is what a killed client looks
    // like to everything else: no goodbye, and a half-sent batch.
    const syncing = a.c.settle({}, 32).catch(() => undefined);
    await committedAtLeast(server, 200);
    a.c.close();
    await syncing;

    // The vault on disk is the user's notes. A sync that died must not have
    // touched them.
    expect(differences(before, await fingerprint(a.dir))).toEqual([]);

    const again = await reopen(server, "a", a.dir, open);
    expect(again.c.deviceId, "the restarted device connected as a new row").toBe(a.c.deviceId);
    await settle([again], 10);
    const b = await device(server, "b", dirs, open);
    await settle([b], 10);
    expect(differences(before, await fingerprint(b.dir))).toEqual([]);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});

/** Every note in a vault, by path, as text. */
async function texts(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of (await fingerprint(dir)).keys()) {
    out.set(path, await readFile(join(dir, path), "utf8"));
  }
  return out;
}

describe("a server restored from a backup its devices have moved past", () => {
  it("replays the restored history on both devices and loses nothing either held", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, "a", dirs, open);
    const b = await device(server, "b", dirs, open);
    for (let i = 1; i <= 10; i++) {
      await writeFile(join(a.dir, `note-${i}.md`), `BACKED UP ${i}\n`);
    }
    await settle([a, b]);

    const held = await mkdtemp(join(tmpdir(), "trew-restore-"));
    dirs.push(held);
    const snapshot = join(held, "snapshot");
    // Closed first and reopened after, as the shells' run loops would
    // reconnect them: a client does not redial on its own in `settle`, and
    // work a dead connection never sent is not work the backup lacks.
    a.c.close();
    b.c.close();
    await server.whileStopped(async () => {
      await server.cli("backup", "-to", snapshot);
    });
    const a1 = await reopen(server, "a", a.dir, open);
    const b1 = await reopen(server, "b", b.dir, open);

    // What the backup will not have: an edit, a new note, and a deletion,
    // each synced to both devices before the restore.
    await writeFile(join(a.dir, "note-1.md"), "EDITED AFTER THE BACKUP\n");
    await writeFile(join(a.dir, "after.md"), "WRITTEN AFTER THE BACKUP\n");
    await rm(join(b.dir, "note-2.md"));
    await settle([a1, b1]);
    expect(existsSync(join(a.dir, "note-2.md")), "the deletion never reached a").toBe(false);
    expect(await readFile(join(b.dir, "after.md"), "utf8")).toBe("WRITTEN AFTER THE BACKUP\n");
    expect(await readFile(join(b.dir, "note-1.md"), "utf8")).toBe("EDITED AFTER THE BACKUP\n");
    const onA = await fingerprint(a.dir);
    const onB = await fingerprint(b.dir);

    // The restore, as `trew backup` says to do one: the server pointed at the
    // backup, at the same address. The devices table is in the backup, so
    // both devices reconnect with the credentials they hold, and the backup
    // has an epoch of its own, which is how they are told their cursors
    // describe a history that is gone.
    a1.c.close();
    b1.c.close();
    const port = server.port;
    await server.stop();
    dirs.push(server.dataDir);
    server = new TestServer();
    server.dataDir = snapshot;
    await server.start(port);

    const a2 = await reopen(server, "a", a.dir, open);
    const b2 = await reopen(server, "b", b.dir, open);
    for (const d of [a2, b2]) {
      expect(d.c.transport.historyReplaced, "the restored epoch was not noticed").toBe(true);
    }
    await settle([a2, b2], 10);

    // Rule 10: every version either device held is still on it, byte for
    // byte, wherever it now lives.
    for (const [d, before] of [
      [a2, onA],
      [b2, onB],
    ] as const) {
      const now = new Set((await fingerprint(d.dir)).values());
      const lost = [...before].filter(([, hash]) => !now.has(hash)).map(([path]) => path);
      expect(lost, `these were lost across the restore on ${d.dir}`).toEqual([]);
    }
    for (const d of [a2, b2]) {
      const notes = await texts(d.dir);
      const all = [...notes.values()];
      // The restored original of the edited note is kept beside the edit,
      // not written over it and not dropped for it.
      expect(all, "the edit made after the backup").toContain("EDITED AFTER THE BACKUP\n");
      expect(all, "the restored original of the edited note").toContain("BACKED UP 1\n");
      // A deletion the restored history does not hold is not applied to it
      // on the strength of the history that was replaced (rules 3 and 6).
      expect(notes.get("note-2.md")).toBe("BACKED UP 2\n");
      // Notes the backup and the device agree on are agreement, not conflict
      // copies: only the note that differs between them gets a copy.
      const copies = [...notes].filter(([path]) => path.includes("Conflicted copy"));
      expect(copies.length, "the edited note was not kept both ways").toBeGreaterThan(0);
      for (const [path, body] of copies) {
        expect(["BACKED UP 1\n", "EDITED AFTER THE BACKUP\n"], path).toContain(body);
      }
    }

    // And the restored server holds all of it now: a device paired against it
    // after the restore gets exactly what the two agree on.
    expect(differences(await fingerprint(a2.dir), await fingerprint(b2.dir))).toEqual([]);
    const c = await device(server, "c", dirs, open);
    await settle([c]);
    expect(differences(await fingerprint(a2.dir), await fingerprint(c.dir))).toEqual([]);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});
