/**
 * Ten thousand realistic notes, three devices, and nothing lost.
 *
 * The short form of `bench-10k.ts`: the same corpus (`corpus.ts`) through a
 * real server, with the devices in memory so the run measures sync rather
 * than a laptop's fsync, and every timing left to the benchmark. What it
 * holds is the owner's goal at this size: a first upload and a first
 * download arrive byte for byte; a device away for 500 edits (deletions,
 * renames, new notes and notes edited then deleted at once among them)
 * catches up while its own offline edits, one of them to the same line as
 * the other device's, all survive; every conflict copy is explained; and a
 * third device from nothing holds exactly what the other two do.
 *
 * `STRESS_FILES` sets the size (10,000 by default).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { conflictOriginal } from "../core/conflicts.ts";
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import { MemoryIndexStore, MemoryVault } from "../core/vault.ts";
import { makeCorpus } from "./corpus.ts";

const FILES = Number(process.env["STRESS_FILES"] ?? 10_000);
const dec = new TextDecoder("utf-8", { ignoreBOM: true });

beforeAll(async () => {
  await serverBinary();
}, 300_000);
afterAll(async () => await cleanupBinary());

async function contents(vault: MemoryVault): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of await vault.list()) {
    if (s.folder) continue;
    out.set(s.path, Buffer.from(await vault.read(s.path)).toString("base64"));
  }
  return out;
}

function differences(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [p, v] of a) if (b.get(p) !== v) out.push(`${p}: ${b.has(p) ? "differs" : "missing"}`);
  for (const p of b.keys()) if (!a.has(p)) out.push(`${p}: extra`);
  return out.slice(0, 10);
}

async function settleAll(clients: Client[]): Promise<void> {
  for (let round = 0; round < 12; round++) {
    let busy = false;
    for (const c of clients) {
      const r = await c.settle({ coalesceWrites: false });
      if (
        r.uploaded + r.downloaded + r.merged + r.conflicted + r.deletedLocally + r.deletedRemotely >
          0 ||
        r.waiting + r.retrying > 0
      )
        busy = true;
    }
    if (!busy) return;
  }
  throw new Error("the devices did not settle in twelve rounds");
}

describe(`${FILES.toLocaleString()} realistic notes`, () => {
  let server: TestServer;
  const clients: Client[] = [];
  afterAll(async () => {
    for (const c of clients) await c.close();
    await server?.cleanup();
  });

  /**
   * A device on `vault`. The store and credentials are the caller's to keep,
   * so a device that goes away comes back as itself, with its own index.
   */
  async function device(
    vault: MemoryVault,
    name: string,
    store = new MemoryIndexStore(),
    creds?: { deviceId: string; token: string },
  ): Promise<Client> {
    const c = new Client({
      vault,
      store,
      url: server.wsUrl,
      ...(creds ?? (await server.deviceCredentials(name))),
      vaultId: "default",
      device: name,
      timeoutMs: 600_000,
      coalesceWrites: false,
    });
    clients.push(c);
    await c.connect();
    return c;
  }

  it("arrive, survive a device away for 500 edits, and match a witness byte for byte", async () => {
    server = new TestServer();
    await server.start();
    const corpus = makeCorpus({ seed: 1, files: FILES });
    const mac = new MemoryVault();
    const t = 1_700_000_000_000;
    for (let i = 0; i < corpus.files.length; i++) {
      await mac.write(corpus.files[i]!.path, corpus.bytes(i), { mtime: t, ctime: t });
    }
    const expected = await contents(mac);
    expect(expected.size).toBe(FILES);

    const a = await device(mac, "mac");
    await settleAll([a]);
    const phoneVault = new MemoryVault();
    const phoneStore = new MemoryIndexStore();
    const phoneCreds = await server.deviceCredentials("phone");
    let b = await device(phoneVault, "phone", phoneStore, phoneCreds);
    await settleAll([b]);
    expect(differences(expected, await contents(phoneVault))).toEqual([]);

    // The phone goes away, keeping its vault and its index, as a closed app
    // keeps them on disk.
    await b.close();
    clients.splice(clients.indexOf(b), 1);

    const notes = corpus.files
      .map((f, i) => ({ f, i }))
      .filter(
        ({ f, i }) =>
          f.kind === "note" &&
          !dec.decode(corpus.bytes(i)).includes("\r") &&
          corpus.bytes(i)[0] !== 0xef,
      )
      .map(({ f }) => f.path);
    let cursor = 0;
    const next = () => notes[cursor++]!;
    const contested = next();
    const base = mac.text(contested)!;
    const heading = base.split("\n").findIndex((l) => l.startsWith("# "));
    const rewrite = (line: string) =>
      base
        .split("\n")
        .map((l, n) => (n === heading ? `# ${line}` : l))
        .join("\n");
    const onMac = rewrite("rewritten on the Mac while the phone was away");
    const onPhone = rewrite("rewritten on the phone while it was away");
    await mac.edit(contested, onMac);
    const macEdits = new Map<string, string>([[contested, onMac]]);
    const removed = new Set<string>();
    for (let k = 1; k < 500; k++) {
      if (k < 400) {
        const p = next();
        const text = `${mac.text(p)!}\naway edit ${k}\n`;
        await mac.edit(p, text);
        macEdits.set(p, text);
      } else if (k < 440) {
        const p = `Inbox/Neue Notiz ${k} über Café.md`;
        await mac.edit(p, `# ${k}\n\nwritten on the Mac while the phone was away\n`);
        macEdits.set(p, mac.text(p)!);
      } else if (k < 470) {
        const p = next();
        await mac.remove(p);
        removed.add(p);
      } else if (k < 490) {
        const p = next();
        const to = p.replace(/\.md$/, ` (moved ${k}).md`);
        await mac.write(to, await mac.read(p), { mtime: Date.now(), ctime: Date.now() });
        await mac.remove(p);
        removed.add(p);
        macEdits.set(to, mac.text(to)!);
      } else {
        // Edited, then deleted before any pass could send the edit.
        const p = next();
        await mac.edit(p, `${mac.text(p)!}\nan edit nobody will see\n`);
        await mac.remove(p);
        removed.add(p);
      }
      if (k % 100 === 99) await a.settle({ coalesceWrites: false });
    }
    await settleAll([a]);
    const phoneEdits = new Map<string, string>([[contested, onPhone]]);
    for (let k = 0; k < 19; k++) {
      const p = next();
      phoneEdits.set(p, `phone offline edit ${k}\n${phoneVault.text(p)!}`);
    }
    for (const [p, text] of phoneEdits) await phoneVault.edit(p, text);

    b = await device(phoneVault, "phone", phoneStore, phoneCreds);
    await settleAll([b, a]);

    const onA = await contents(mac);
    expect(differences(onA, await contents(phoneVault)), "the two devices agree").toEqual([]);
    for (const [p, text] of macEdits) {
      if (phoneEdits.has(p)) continue;
      expect(mac.text(p), `the Mac's edit to ${p}`).toBe(text);
    }
    for (const p of removed) expect(onA.has(p), `${p} stays deleted`).toBe(false);
    for (const [p, text] of phoneEdits) {
      if (p === contested) continue;
      expect(mac.text(p), `the phone's offline edit to ${p}`).toBe(text);
    }
    const copies = [...onA.keys()].filter((p) => conflictOriginal(p) !== undefined);
    expect(
      copies.filter((p) => conflictOriginal(p) !== contested),
      "every conflict copy is explained",
    ).toEqual([]);
    const sides = [contested, ...copies].map((p) => mac.text(p));
    expect(sides, "both sides of the conflict survive").toContain(onMac);
    expect(sides, "both sides of the conflict survive").toContain(onPhone);

    const witnessVault = new MemoryVault();
    const w = await device(witnessVault, "witness");
    await settleAll([w]);
    expect(differences(onA, await contents(witnessVault)), "the witness matches").toEqual([]);

    const verified = await server.cli("verify", "-deep");
    expect(verified).toMatch(/, 0 faults$/m);
  });
});
