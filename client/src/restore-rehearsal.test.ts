/**
 * A backup, restored, read back by a device that has never seen the vault
 * (I16).
 *
 * `cmd/trew/rehearsal_test.go` already executes the runbook and it is
 * the reason `trew restore` is not a rumour: back up, lose the original,
 * copy the backup somewhere fresh, verify it deeply, start a server on it, and
 * read every version and every body back over a real socket. What it cannot do
 * is the last step of the actual disaster, because it is the server testing
 * itself: the server holds no key and has never seen a plaintext, so "every
 * body came back" is as far as it can get. Whether any of it decrypts to the
 * note somebody wrote is a question only a client can answer.
 *
 * That gap is the whole of what a backup is for. Every byte can be present and
 * verified and the vault still be unrecoverable, if what came back cannot be
 * opened by the recovery key on the piece of paper. Nothing checked that end to
 * end, so this does:
 *
 *   1. a device writes notes whose plaintext hashes are known here,
 *   2. `trew backup` takes a copy,
 *   3. the live directory is destroyed, which is the disaster,
 *   4. a server starts on the backup,
 *   5. a device that has never existed pairs with the recovery key alone,
 *   6. and every note it pulls down is compared by hash to what was written.
 *
 * Step 5 is the one that matters and the one no server-side test can reach: it
 * is somebody who has lost every device, holding only what they wrote down.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "./core/client.ts";
import { MemoryIndexStore, MemoryVault } from "./core/vault.ts";
import { TestServer, serverBinary } from "./core/test-server.ts";
import { testWrapped } from "./core/test-keys.ts";

const enc = new TextEncoder();
const hashOf = (text: string): string =>
  createHash("sha256").update(enc.encode(text)).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * Notes worth losing. A few small ones, one with characters that have bitten
 * this project before, one large enough to be several chunks, and one folder,
 * because a restore that brings back the notes and not the shape of the vault
 * is a restore somebody has to tidy up by hand.
 */
function theVault(): Map<string, string> {
  const notes = new Map<string, string>();
  for (let i = 0; i < 12; i++) {
    notes.set(`notes/day-${i}.md`, `# Day ${i}\n\n` + `Something happened.\n`.repeat(3 + i));
  }
  notes.set("notes/a note with spaces.md", "and an apostrophe: don't\n");
  notes.set("notes/émoji 🌋.md", "unicode in the path and the body: 🌋\n");
  // Several chunks' worth, so the restore has to reassemble rather than hand
  // back one body.
  notes.set("attachments/big.md", "a paragraph of ordinary prose.\n".repeat(20_000));
  notes.set("deep/one/two/three/buried.md", "as far down as anything goes\n");
  return notes;
}

describe("losing the server and getting the vault back", () => {
  it("restores a backup that a device with only the recovery key can read", async () => {
    await serverBinary();

    // ---- before the disaster ------------------------------------------
    const live = new TestServer();
    await live.start();
    cleanups.push(() => live.cleanup());

    const secret = new Uint8Array(32).fill(19);
    const wrapped = await testWrapped(secret);

    const written = theVault();
    const first = new MemoryVault();
    const a = new Client({
      vault: first,
      store: new MemoryIndexStore(),
      url: live.wsUrl,
      ...(await live.deviceCredentials(secret, wrapped, "a")),
      vaultId: "default",
      device: "a",
      timeoutMs: 60_000,
      coalesceWrites: false,
    });
    cleanups.push(async () => a.close());
    await a.connect();
    for (const [path, body] of written) await first.edit(path, body);
    await a.settle({}, 32);

    // Every note is really on the server before anything is backed up. Without
    // this the rest could pass against a backup of an empty vault.
    const uploaded = await live.cli("stats", "-json");
    const stats = JSON.parse(uploaded) as { vaults: Array<{ files: number }> };
    expect(
      stats.vaults[0]?.files,
      `the server holds ${stats.vaults[0]?.files} files and ${written.size} were written`,
    ).toBe(written.size);

    // ---- the backup ---------------------------------------------------
    const dest = await mkdtemp(join(tmpdir(), "trew-restore-"));
    cleanups.push(() => rm(dest, { recursive: true, force: true }));
    await live.cli("backup", "-to", dest, "-deep");

    // ---- the disaster -------------------------------------------------
    // The live directory is gone. Not emptied: gone, the way a disk is.
    await live.cleanup();
    cleanups.pop();

    // ---- the recovery -------------------------------------------------
    const restored = new TestServer();
    restored.dataDir = dest;
    await restored.start();
    cleanups.push(async () => {
      // The data directory here is the backup, cleaned up by the entry above.
      await restored.stop();
    });

    // A device that has never existed, holding the vault's secret and nothing
    // else. This is the person who lost every machine they own.
    const second = new MemoryVault();
    const b = new Client({
      vault: second,
      store: new MemoryIndexStore(),
      url: restored.wsUrl,
      ...(await restored.deviceCredentials(secret, wrapped, "recovered")),
      vaultId: "default",
      device: "recovered",
      timeoutMs: 60_000,
      coalesceWrites: false,
    });
    cleanups.push(async () => b.close());
    await b.connect();
    await b.settle({}, 32);

    // ---- what came back -----------------------------------------------
    const back = second.paths().slice().sort();
    expect(back, "the restored vault does not hold the same paths").toEqual(
      [...written.keys()].sort(),
    );
    const wrong: string[] = [];
    for (const [path, body] of written) {
      const got = second.text(path);
      if (got === undefined) {
        wrong.push(`${path}: nothing came back`);
      } else if (hashOf(got) !== hashOf(body)) {
        wrong.push(
          `${path}: ${got.length} bytes hashing to ${hashOf(got).slice(0, 12)}, ` +
            `wanted ${body.length} bytes hashing to ${hashOf(body).slice(0, 12)}`,
        );
      }
    }
    expect(wrong, `restored notes do not match what was written:\n${wrong.join("\n")}`).toEqual([]);
  }, 180_000);

  /**
   * The same, from a backup taken before a purge.
   *
   * A purge drops history and reclaims the bodies behind it, and the reason to
   * keep a backup from before one is that it still holds them. That is an
   * argument nobody has executed: the backup is verified against its own
   * coverage, which says what it holds and not whether a client can open it.
   */
  it("reads a backup taken before a purge dropped the history", async () => {
    await serverBinary();
    const live = new TestServer();
    await live.start();
    cleanups.push(() => live.cleanup());

    const secret = new Uint8Array(32).fill(23);
    const wrapped = await testWrapped(secret);
    const vault = new MemoryVault();
    const a = new Client({
      vault,
      store: new MemoryIndexStore(),
      url: live.wsUrl,
      ...(await live.deviceCredentials(secret, wrapped, "a")),
      vaultId: "default",
      device: "a",
      timeoutMs: 60_000,
      coalesceWrites: false,
    });
    cleanups.push(async () => a.close());
    await a.connect();

    // Three versions of one note. The first two become history.
    await vault.edit("note.md", "first\n");
    await a.settle({}, 4);
    await vault.edit("note.md", "second\n");
    await a.settle({}, 4);
    await vault.edit("note.md", "third and current\n");
    await a.settle({}, 4);

    const dest = await mkdtemp(join(tmpdir(), "trew-prepurge-"));
    cleanups.push(() => rm(dest, { recursive: true, force: true }));
    await live.cli("backup", "-to", dest, "-deep");
    await live.cleanup();
    cleanups.pop();

    const restored = new TestServer();
    restored.dataDir = dest;
    await restored.start();
    cleanups.push(async () => restored.stop());

    const second = new MemoryVault();
    const b = new Client({
      vault: second,
      store: new MemoryIndexStore(),
      url: restored.wsUrl,
      ...(await restored.deviceCredentials(secret, wrapped, "recovered")),
      vaultId: "default",
      device: "recovered",
      timeoutMs: 60_000,
      coalesceWrites: false,
    });
    cleanups.push(async () => b.close());
    await b.connect();
    await b.settle({}, 8);

    expect(second.text("note.md"), "the current version did not come back").toBe(
      "third and current\n",
    );

    // And the history is there to restore from, which is the reason the backup
    // was kept. Read through the client, because that is how somebody would.
    const history = await b.history("note.md", { limit: 10 });
    expect(
      history.length,
      `the backup holds ${history.length} versions of the note and three were written`,
    ).toBeGreaterThanOrEqual(3);
  }, 180_000);
});
