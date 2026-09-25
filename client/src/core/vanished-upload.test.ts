/**
 * A file deleted between the pass that listed it and the read that would send
 * it is a deletion, and goes out as one in the same settle.
 *
 * Found at ten thousand notes (bench-10k.ts, docs/research.md): an edit and
 * then a deletion of the same note inside one pass made the upload's read
 * fail with ENOENT, which was recorded as an ordinary failure and backed off
 * for ten seconds and more. The deletion went nowhere meanwhile. A device that
 * came back in that window caught up to a server that still held the note,
 * and so did a device paired from nothing, while the one that deleted it
 * reported itself retrying. Nothing was lost, but for as long as the backoff
 * lasted every other device kept a note the person had deleted.
 */

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { Client } from "./client.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

/** Removes a file the moment anything reads it, as a person deleting it mid-pass would. */
class VanishingVault extends MemoryVault {
  readonly vanishOnRead = new Set<string>();
  override async read(path: string): Promise<Uint8Array> {
    if (this.vanishOnRead.delete(path)) {
      await this.remove(path);
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: "ENOENT",
      });
    }
    return super.read(path);
  }
}

let server: TestServer | undefined;
let clients: Client[] = [];

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(cleanupBinary);
afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  await server?.cleanup();
});

async function device(vault: MemoryVault, name: string): Promise<Client> {
  const c = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server!.wsUrl,
    ...(await server!.deviceCredentials(name)),
    vaultId: "default",
    device: name,
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  clients.push(c);
  await c.connect();
  return c;
}

it("sends the deletion of a note removed while its edit was being read", async () => {
  server = new TestServer();
  await server.start();
  const vault = new VanishingVault();
  await vault.edit("kept.md", "a note nobody touches\n");
  await vault.edit("edited then deleted.md", "the first version\n");
  const laptop = await device(vault, "laptop");
  await laptop.settle();

  await vault.edit("edited then deleted.md", "an edit, saved just before the note was deleted\n");
  vault.vanishOnRead.add("edited then deleted.md");
  const report = await laptop.settle();

  expect(vault.vanishOnRead.size, "the read that finds it gone happened").toBe(0);
  expect(await vault.stat("edited then deleted.md")).toBeUndefined();
  // Out as a deletion in this settle, not after a backoff.
  const versions = await laptop.history("edited then deleted.md", { limit: 10 });
  expect(versions[0]?.deleted, "the server's newest word is the deletion").toBe(true);
  expect(report.retrying, "nothing is left retrying").toBe(0);
  expect(report.retryingPaths).toEqual([]);

  // And a device joining now does not get the deleted note back.
  const phone = await device(new MemoryVault(), "phone");
  await phone.settle();
  expect(await phone.vault.stat("edited then deleted.md")).toBeUndefined();
  expect(new TextDecoder().decode(await phone.vault.read("kept.md"))).toBe(
    "a note nobody touches\n",
  );
});

it("still backs off a read that keeps failing on a file that is still there", async () => {
  server = new TestServer();
  await server.start();
  class Unreadable extends MemoryVault {
    attempts = 0;
    override async read(path: string): Promise<Uint8Array> {
      if (path === "locked.md") {
        this.attempts++;
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return super.read(path);
    }
  }
  const vault = new Unreadable();
  await vault.edit("locked.md", "held open by something else\n");
  const laptop = await device(vault, "laptop");
  const report = await laptop.settle();
  // The file is still on disk, so this is not a deletion and not an
  // immediate re-decide: it is an ordinary failure with a backoff, which a
  // settle does not spin on.
  expect(report.retrying).toBe(1);
  expect(report.retryingPaths).toEqual(["locked.md"]);
  expect(vault.attempts).toBeLessThanOrEqual(2);
  expect((await laptop.history("locked.md", { limit: 10 })).length).toBe(0);
});
