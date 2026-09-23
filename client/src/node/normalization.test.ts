import { receiveCommitted } from "../core/test-async.ts";
/**
 * The same note created on a Mac and on anything else.
 *
 * A Mac spells `café.md` on disk with a combining accent (NFD) and every other
 * platform with a precomposed one (NFC). The bytes differ and the name does
 * not: the two are canonically equivalent, one name by definition. A sync that
 * treats them as two names has two devices each refusing the other's spelling
 * for ever, and the refusal names two strings the person cannot tell apart.
 *
 * Real filesystem on the Mac side, because the spelling is the disk's doing
 * and an in-memory vault cannot have that property. The peer is in memory and
 * spells the name the way the plugin and every non-Mac device do.
 */

import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { MemoryIndexStore, MemoryVault } from "../core/vault.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => await cleanupBinary());

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (open.length) open.pop()!.close();
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
});

async function credentials(name: string) {
  return {
    url: server.wsUrl,
    ...(await server.deviceCredentials()),
    vaultId: "default",
    device: name,
    timeoutMs: 20_000,
    coalesceWrites: false,
  };
}

async function diskDevice(name: string): Promise<{ c: Client; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `trew-nfc-${name}-`));
  dirs.push(dir);
  const c = new Client({
    vault: new NodeVault(dir),
    store: new JsonIndexStore(join(dir, ".trew", "index.json")),
    ...(await credentials(name)),
  });
  open.push(c);
  await c.connect();
  return { c, dir };
}

async function memoryDevice(name: string): Promise<{ c: Client; vault: MemoryVault }> {
  const vault = new MemoryVault();
  const c = new Client({ vault, store: new MemoryIndexStore(), ...(await credentials(name)) });
  open.push(c);
  await c.connect();
  return { c, vault };
}

/**
 * How this disk spells a name, so a test can edit the file that is there.
 *
 * Not the same as the name: `café.md` reaches the file on macOS whichever
 * normal form it is in, and on ext4 only in the one the disk has. A test that
 * wants to edit a note has to open the note.
 */
async function onDiskName(dir: string, name: string): Promise<string> {
  const found = (await readdir(dir)).find((n) => n.normalize("NFC") === name);
  if (found === undefined) throw new Error(`${name} is not in ${dir}`);
  return found;
}

/** The files on disk, as text by NFC name, without the state folder. */
async function held(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    if (name.startsWith(".")) continue;
    out[name.normalize("NFC")] = await readFile(join(dir, name), "utf8");
  }
  return out;
}

const NFD = "café.md";
const NFC = "café.md";

describe("one name spelled NFD on one disk and NFC on another", () => {
  it("is one note to both devices, and neither text is lost", async () => {
    server = new TestServer();
    await server.start();
    const mac = await diskDevice("mac");
    const other = await memoryDevice("other");

    // Both create the note before either syncs, the Mac under the spelling
    // its disk uses and the other under the one everything else uses.
    await writeFile(join(mac.dir, NFD), "written on the mac\n");
    await other.vault.edit(NFC, "written elsewhere\n");

    let mine = await mac.c.settle();
    let theirs = await other.c.settle();
    for (let i = 0; i < 4; i++) {
      await receiveCommitted(mac.c.transport);
      mine = await mac.c.settle();
      await receiveCommitted(other.c.transport);
      theirs = await other.c.settle();
    }

    // Neither device is left refusing the other's spelling. That refusal is
    // right for two names a person could tell apart, and these are not two
    // names.
    expect(
      { blocked: mine.blocked, skipped: mine.skipped, retrying: mine.retrying },
      `the mac is stuck: ${JSON.stringify(mine)}`,
    ).toEqual({ blocked: 0, skipped: 0, retrying: 0 });
    expect(
      { blocked: theirs.blocked, skipped: theirs.skipped, retrying: theirs.retrying },
      `the other device is stuck: ${JSON.stringify(theirs)}`,
    ).toEqual({ blocked: 0, skipped: 0, retrying: 0 });

    // Rule 10: the property is that both texts survive, on both devices.
    const onMac = await held(mac.dir);
    const onOther = other.vault.snapshot();
    for (const [name, files] of [
      ["mac", onMac],
      ["other", onOther],
    ] as const) {
      const all = Object.values(files).join("\n");
      expect(all, `${name} lost the mac's text: ${JSON.stringify(files)}`).toContain(
        "written on the mac",
      );
      expect(all, `${name} lost the other text: ${JSON.stringify(files)}`).toContain(
        "written elsewhere",
      );
    }

    // And they agree on what the vault contains: the same names, one of them
    // the note and the other its conflict copy, and the Mac's disk holds one
    // file for the name rather than one per spelling.
    expect(Object.keys(onMac).sort()).toEqual(Object.keys(onOther).sort());
    expect(Object.keys(onMac).filter((n) => n === NFC)).toEqual([NFC]);
    expect(Object.keys(onOther)).toContain(NFC);
  }, 120_000);

  it("carries an edit each way under one name", async () => {
    server = new TestServer();
    await server.start();
    const mac = await diskDevice("mac");
    const other = await memoryDevice("other");

    // The Mac has the note under its own spelling before anything syncs.
    await writeFile(join(mac.dir, NFD), "first\n");
    await mac.c.settle();
    // And after the first listing it has it under the spelling every other
    // device uses, because a vault that reports one name and holds another is
    // a vault two devices do not agree about.
    expect(await readdir(mac.dir).then((n) => n.filter((f) => !f.startsWith(".")))).toEqual([NFC]);
    await other.c.settle();
    expect(other.vault.paths(), "the other device got the Mac's spelling").toEqual([NFC]);
    expect(other.vault.text(NFC)).toBe("first\n");

    // An edit from the other side lands on the file the Mac already has.
    await other.vault.edit(NFC, "second\n");
    await other.c.settle();
    await mac.c.settle();
    expect(await held(mac.dir)).toEqual({ [NFC]: "second\n" });

    // And one from the Mac travels back under the same name. Through the
    // spelling the disk has, because that is what editing the note means: the
    // literal NFD name is an edit on APFS and a second file on ext4.
    await writeFile(join(mac.dir, await onDiskName(mac.dir, NFC)), "third\n");
    await mac.c.settle();
    await other.c.settle();
    expect(other.vault.snapshot()).toEqual({ [NFC]: "third\n" });
  }, 120_000);
});

/**
 * The same name, in the spelling an older Mac client uploaded.
 *
 * Measured before the fold: a device pairing into a vault that held `café.md`
 * in NFD wrote the note under its NFC name, found a name its index did not
 * know, uploaded it as a second note, and then reported `blocked: 1` on every
 * pass for ever, naming two strings a person cannot tell apart.
 *
 * Protocol 1 closes that at the server: a path not in NFC is refused as
 * `badpath` with the reason `nfc` (plan/protocol.md, "Paths"), so no vault
 * holds a second spelling of a name, and the state the correction rename was
 * written for cannot arise. What this still owes is what it was for: the
 * client that sends the other spelling is told why and keeps its note, and a
 * device joining the vault after it deletes nothing and is not stuck.
 *
 * The second test this block had, an edit carried back to the name the vault
 * already had, needed that NFD name on the server; the edit through the disk's
 * own spelling is the second test in the block above.
 */
describe("a peer that spells the name NFD", () => {
  it("is refused at the server, and neither device is stuck or loses the note", async () => {
    server = new TestServer();
    await server.start();

    // The old client: a vault that hands out the disk's own spelling, which is
    // what this client did before it normalised.
    const old = await memoryDevice("old");
    await old.vault.edit(NFD, "written by the old client\n");
    const refused = await old.c.settle();
    expect(refused.skipped, `the old client: ${JSON.stringify(refused)}`).toBe(1);
    expect(refused.needsAttention.find((n) => n.path === NFD)?.why).toMatch(/^nfc: /);
    // Rule 1: refused is not removed. The note is still where it was written.
    expect(old.vault.text(NFD)).toBe("written by the old client\n");
    old.c.close();

    const mac = await diskDevice("mac");
    let mine = await mac.c.settle();
    // A device that has just joined a vault does not delete anything in it.
    expect(mine.deletedRemotely, "the new device deleted a note on the server").toBe(0);
    for (let i = 0; i < 4; i++) {
      await receiveCommitted(mac.c.transport);
      mine = await mac.c.settle();
    }
    // Not blocked, not skipped, not retrying: there is no second spelling for
    // it to stumble on, because none reached the server.
    expect(
      { blocked: mine.blocked, skipped: mine.skipped, retrying: mine.retrying },
      `the mac is stuck: ${JSON.stringify(mine)}`,
    ).toEqual({ blocked: 0, skipped: 0, retrying: 0 });
    expect(await held(mac.dir), "a refused spelling reached the vault").toEqual({});
  }, 120_000);
});
