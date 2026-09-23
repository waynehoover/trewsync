/**
 * When a path the server refused stops being written off (PLAN.md section 4.9).
 *
 * A refused path is stranded with its reason, which is the whole point of the
 * refusal reaching the person. What these pin is the other half: a stranded
 * path has to stop being reported once what caused it is gone, or the panel
 * and `trew status` report a problem nobody can fix and every later sync exits
 * with attention needed.
 *
 *  - A file refused as `badpath` and then renamed, which is what the refusal
 *    asks for, is nowhere: the new name syncs and the old one is not reported
 *    again, least of all as a name "from another device".
 *  - A file refused as `collision` is refused because of a live path, often on
 *    another device. When that path goes, nothing about this device's file
 *    changes, so a write-off that waited for the file to change waited for
 *    ever. The next pass after a deletion or a move tries it again.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client, type ClientOptions } from "./client.ts";
import type { SyncReport } from "./engine.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer;
const open: Client[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  if (server) await server.cleanup();
});

const enc = new TextEncoder();
const dec = new TextDecoder();
const at = { mtime: 1_000, ctime: 1_000 };

async function connected(name: string, vault: MemoryVault): Promise<Client> {
  const opts: ClientOptions = {
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(name)),
    vaultId: "default",
    device: name,
    timeoutMs: 20_000,
    coalesceWrites: false,
  };
  const client = new Client(opts);
  open.push(client);
  await client.connect();
  return client;
}

/** The written-off paths a report names, with their reasons. */
function stranded(report: SyncReport): Map<string, string> {
  return new Map(report.needsAttention.map((n) => [n.path, n.why]));
}

describe("a path the server refused", () => {
  it("stops being reported once its file is renamed to a name the server takes", async () => {
    server = new TestServer();
    await server.start();
    const vault = new MemoryVault();
    const bad = "draft\u0001.md";
    await vault.write(bad, enc.encode("keep me"), at);
    const a = await connected("a", vault);

    const first = await a.settle();
    expect(first.skipped, "the control character is refused").toBe(1);
    const why = stranded(first).get(bad);
    expect(why, "the refusal reaches the report with its reason").toMatch(/^control:/);
    // Two sentences, not the server's reason running into the remedy.
    expect(why).toMatch(/\.\s+Rename it/);
    expect(why).not.toMatch(/[a-z] Rename it/);

    // What the refusal asks for.
    await vault.write("draft.md", enc.encode("keep me"), at);
    await vault.remove(bad);
    const second = await a.settle();
    expect(second.skipped, "the old name is nowhere, and is not stranded").toBe(0);
    expect(stranded(second).has(bad)).toBe(false);
    const third = await a.settle();
    expect(third.skipped, "nor on any pass after").toBe(0);
    expect(a.engine.status().skipped).toBe(0);

    // And the note itself went up under its new name, byte for byte.
    const b = await connected("b", new MemoryVault());
    await b.settle();
    expect(dec.decode(await b.vault.read("draft.md"))).toBe("keep me");
  });
});

describe("a path refused as a collision", () => {
  it("is tried again once the path it collided with is deleted on another device", async () => {
    server = new TestServer();
    await server.start();
    const vaultA = new MemoryVault();
    await vaultA.write("Note.md", enc.encode("the first note"), at);
    const a = await connected("a", vaultA);
    await a.settle();

    // B holds both spellings, which a case-sensitive disk can, and the server
    // refuses the second: a case-folding disk would hold them as one.
    const vaultB = new MemoryVault();
    const b = await connected("b", vaultB);
    await b.settle();
    await vaultB.write("NOTE.md", enc.encode("the second note"), at);
    const refused = await b.settle();
    expect(refused.skipped).toBe(1);
    expect(stranded(refused).get("NOTE.md")).toMatch(/^collision:/);

    // The obstacle goes on A, and nothing about B's file changes.
    await vaultA.remove("Note.md");
    await a.settle();
    // B hears of the deletion, and its next pass tries NOTE.md again.
    for (let i = 0; i < 20 && (await vaultB.exists("Note.md")); i++) await b.settle();
    const after = await b.settle();
    expect(after.skipped, "the collision's cause is gone, so it is not stranded").toBe(0);

    // B's note is on the server now, byte for byte.
    const c = await connected("c", new MemoryVault());
    await c.settle();
    expect(dec.decode(await c.vault.read("NOTE.md"))).toBe("the second note");
  });
});
