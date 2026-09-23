/**
 * A vault whose listing can be behind its disk, and the guard that keeps that
 * from becoming a deletion.
 *
 * Obsidian's index is such a listing: a file another program deletes and
 * writes again is missing from it until the watcher reports the write. The
 * engine asks `exists` about every synced name a listing leaves out, and
 * hands the vault each one that is there, so a listing that cannot walk the
 * disk on every pass can read those few from it. It used to stop at the first
 * one and ask for a full listing with nothing named, which a lagging vault
 * answered from the same index, and every name in it was sent as deleted.
 */

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { Client } from "./client.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault, type FileStat } from "./vault.ts";

/** Leaves `behind` out of every listing, except the names it is asked to read. */
class LaggingVault extends MemoryVault {
  readonly behind = new Set<string>();
  readonly asked: (readonly string[])[] = [];

  override async list(
    options: { forceFull?: boolean; present?: readonly string[] } = {},
  ): Promise<FileStat[]> {
    if (options.present !== undefined) this.asked.push([...options.present].sort());
    const read = new Set(options.present ?? []);
    return (await super.list()).filter((s) => !this.behind.has(s.path) || read.has(s.path));
  }
}

let server: TestServer | undefined;
let client: Client | undefined;

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(cleanupBinary);
afterEach(async () => {
  await client?.close();
  await server?.cleanup();
});

it("names every synced file a listing left out that is still there", async () => {
  server = new TestServer();
  await server.start();
  const vault = new LaggingVault();
  await vault.edit("a.md", "the first note\n");
  await vault.edit("b.md", "the second note\n");
  await vault.edit("gone.md", "deleted for real\n");
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials("laptop")),
    vaultId: "default",
    device: "laptop",
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  await client.connect();
  await client.settle();

  for (const path of ["a.md", "b.md", "gone.md"]) vault.behind.add(path);
  await vault.remove("gone.md");
  await client.settle();

  for (const path of ["a.md", "b.md"]) {
    const versions = await client.history(path, { limit: 10 });
    expect(
      versions.filter((v) => v.deleted),
      `${path} was deleted`,
    ).toEqual([]);
  }
  // Absent is still absent: the one that really went is a deletion.
  expect((await client.history("gone.md", { limit: 10 }))[0]?.deleted).toBe(true);
  expect(vault.text("a.md")).toBe("the first note\n");
  expect(vault.text("b.md")).toBe("the second note\n");
  expect(vault.asked[0], "the names the listing was asked to read").toEqual(["a.md", "b.md"]);
}, 120_000);
