import { describe, expect, it } from "vitest";

import { contentId } from "../core/engine.ts";
import { chunkNames } from "../core/digest.ts";
import { chunkBytes, sizesFor } from "../core/chunk.ts";
import { MemoryVault } from "../core/vault.ts";
import { sharedList, sharingPluginList, writtenList } from "./community-plugins.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const list = (...ids: string[]) => JSON.stringify(ids, null, 2);
const times = { mtime: 1_000, ctime: 1_000 };
const PATH = ".obsidian/community-plugins.json";

/** The engine's content id of some bytes, as an ExpectedContent computes it. */
async function idOf(bytes: Uint8Array): Promise<string> {
  const pieces = [...chunkBytes(bytes, sizesFor(bytes.length, true), true)];
  return contentId(await chunkNames(pieces.map((p) => p.bytes)));
}

describe("the plugin list as a group shares it", () => {
  it("leaves out the plugins that are one device's, in any spelling, and keeps the order", () => {
    const raw = enc(
      list("dataview", "trew-sync", "Obsidian-Git", "quickadd", "obsidian-local-rest-api"),
    );
    expect(dec(sharedList(raw))).toBe(list("dataview", "quickadd"));
  });

  it("returns the bytes as they are when there is nothing to leave out", () => {
    const raw = enc('["dataview",   "quickadd"]\n');
    expect(sharedList(raw)).toBe(raw);
  });

  it("passes a file that is not a list of names through, for the JSON gate", () => {
    for (const odd of ['{"not": "a list"}', '["dataview", 3]', '["data', ""]) {
      expect(dec(sharedList(enc(odd))), odd).toBe(odd);
      expect(dec(writtenList(enc(odd), enc(list("trew-sync")))), odd).toBe(odd);
    }
  });

  it("writes the group's list with this device's own entries as this device has them", () => {
    const current = enc(list("dataview", "trew-sync", "obsidian-git"));
    const incoming = enc(list("quickadd", "dataview"));
    expect(dec(writtenList(incoming, current))).toBe(
      list("quickadd", "dataview", "trew-sync", "obsidian-git"),
    );
  });

  it("never lets the group's list switch a device-local plugin on, nor off", () => {
    // obsidian-git is off here: a list naming it does not switch it on.
    const here = enc(list("dataview", "trew-sync"));
    expect(dec(writtenList(enc(list("dataview", "obsidian-git")), here))).toBe(
      list("dataview", "trew-sync"),
    );
    // The sync plugin is on here: a list without it does not switch it off.
    expect(dec(writtenList(enc(list("quickadd")), here))).toBe(list("quickadd", "trew-sync"));
  });

  it("shows the engine exactly the list it wrote, whatever this device adds to it", () => {
    const incoming = enc(list("quickadd", "dataview"));
    for (const current of [
      undefined,
      enc(list()),
      enc(list("trew-sync")),
      enc(list("obsidian-livesync", "dataview", "trew-sync", "supersync")),
    ]) {
      expect(dec(sharedList(writtenList(incoming, current)))).toBe(dec(incoming));
    }
  });
});

describe("a vault that shares the plugin list", () => {
  async function vaultWith(
    onDisk: string,
  ): Promise<{ inner: MemoryVault; vault: ReturnType<typeof sharingPluginList> }> {
    const inner = new MemoryVault();
    await inner.write(PATH, enc(onDisk), times);
    await inner.write(".obsidian/app.json", enc("{}"), times);
    return { inner, vault: sharingPluginList(inner, ".obsidian") };
  }

  it("reads, stats and lists the shared list, and every other file as it is", async () => {
    const { vault } = await vaultWith(list("dataview", "trew-sync", "obsidian-git"));
    const shared = list("dataview");
    expect(dec(await vault.read(PATH))).toBe(shared);
    expect((await vault.stat(PATH))?.size).toBe(enc(shared).length);
    const listed = (await vault.list()).find((s) => s.path === PATH);
    expect(listed?.size).toBe(enc(shared).length);
    expect(dec(await vault.read(".obsidian/app.json"))).toBe("{}");
  });

  it("writes an incoming list with this device's own entries kept", async () => {
    const { inner, vault } = await vaultWith(list("dataview", "trew-sync", "obsidian-git"));
    await vault.write(PATH, enc(list("quickadd")), times);
    expect(inner.text(PATH)).toBe(list("quickadd", "trew-sync", "obsidian-git"));
    expect(dec(await vault.read(PATH))).toBe(list("quickadd"));
  });

  it("does not take this device's own entries for an edit made in the way of a write", async () => {
    const { inner, vault } = await vaultWith(list("dataview", "trew-sync", "obsidian-git"));
    // The engine decided about the shared list, and the disk holds it with
    // this device's own entries: nothing is in the way.
    const expect1 = { contentId: await idOf(enc(list("dataview"))), idOf };
    const quiet = await vault.replace!(PATH, expect1, enc(list("quickadd")), times, `${PATH}.kept`);
    expect(quiet.keptAt).toBeUndefined();
    expect(inner.text(PATH)).toBe(list("quickadd", "trew-sync", "obsidian-git"));

    // A real edit meanwhile is still found and kept.
    await inner.write(PATH, enc(list("quickadd", "templater", "trew-sync")), {
      mtime: 2_000,
      ctime: 1_000,
    });
    const stale = { contentId: await idOf(enc(list("quickadd"))), idOf };
    const kept = await vault.replace!(PATH, stale, enc(list("dataview")), times, `${PATH}.kept`);
    expect(kept.keptAt).toBe(`${PATH}.kept`);
    expect(inner.text(`${PATH}.kept`)).toBe(list("quickadd", "templater", "trew-sync"));
  });
});
