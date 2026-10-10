/**
 * Settings sync on the plugin's side (plan/settings-sync.md): the config
 * folder the vault lists and writes when settings sync is on, under the name
 * of the group the device chose, and the copies of a device's settings kept
 * before the first sync and before every Apply.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { decodeConfig, encodeConfig, type DeviceConfig } from "../core/pairing.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";
import { resetStub } from "./stub.ts";
import { backUpSettings, keepSettingsBeforeApply, settingsIn } from "./settings.ts";
import { ObsidianVault } from "./vault.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const times = { mtime: 1_000, ctime: 1_000 };

/** A config folder with every kind of thing a real one has. */
async function configFolder(adapter: FakeAdapter, root = ".obsidian"): Promise<void> {
  for (const [path, text] of [
    [`${root}/app.json`, `{"spellcheck": true}`],
    [`${root}/appearance.json`, `{"theme": "obsidian"}`],
    [`${root}/workspace.json`, `{"main": {}}`],
    [`${root}/workspace-mobile.json`, `{"main": {}}`],
    [`${root}/community-plugins.json`, `["trew-sync", "dataview"]`],
    [`${root}/themes/Tela/theme.css`, "body {}"],
    [`${root}/themes/Tela/manifest.json`, `{"name": "Tela"}`],
    [`${root}/snippets/wide.css`, ".wide {}"],
    [`${root}/snippets/notes.md`, "not a snippet"],
    [`${root}/plugins/trew-sync/data.json`, `{"deviceToken": "secret"}`],
    [`${root}/plugins/trew-sync/index.json`, `{"cursor": 9}`],
    [`${root}/plugins/trew-sync/index.log`, "1 abcd {}\n"],
    [`${root}/plugins/dataview/main.js`, "module.exports = {}"],
  ] as const) {
    await write(adapter, path, text);
  }
}

/** Writes a file and makes its folders, which the fake, unlike Obsidian, does not. */
async function write(adapter: FakeAdapter, path: string, text: string): Promise<void> {
  let at = "";
  for (const part of path.split("/").slice(0, -1)) {
    at = at === "" ? part : `${at}/${part}`;
    if (!(await adapter.exists(at))) await adapter.mkdir(at);
  }
  await adapter.write(path, text);
}

const SETTINGS = [
  ".obsidian/app.json",
  ".obsidian/appearance.json",
  ".obsidian/snippets/wide.css",
  ".obsidian/themes/Tela/manifest.json",
  ".obsidian/themes/Tela/theme.css",
];

beforeEach(() => resetStub());

describe("the vault, with settings sync", () => {
  it("lists the settings of the folder it runs, and nothing else there, only when it is on", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    await configFolder(adapter, ".obsidian-mobile");
    await write(adapter, "note.md", "a note");
    const on = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian",
    });
    const off = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    const files = async (v: ObsidianVault) =>
      (await v.list())
        .filter((s) => !s.folder)
        .map((s) => s.path)
        .sort();
    expect(await files(on)).toEqual([...SETTINGS, "note.md"].sort());
    expect(await files(off)).toEqual(["note.md"]);
  });

  it("writes a setting it syncs, and refuses everything else in the folder", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian",
    });
    await vault.write(".obsidian/snippets/new.css", enc.encode(".new {}"), times);
    expect(dec.decode(await adapter.readBinary(".obsidian/snippets/new.css"))).toBe(".new {}");
    for (const path of [
      ".obsidian/workspace.json",
      ".obsidian/plugins/trew-sync/data.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/community-plugins.json",
      ".obsidian-mobile/app.json",
    ]) {
      await expect(vault.write(path, enc.encode("{}"), times), path).rejects.toMatchObject({
        code: "neversync",
      });
    }
    expect(dec.decode(await adapter.readBinary(".obsidian/plugins/trew-sync/data.json"))).toContain(
      "secret",
    );

    const off = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    await expect(off.write(".obsidian/app.json", enc.encode("{}"), times)).rejects.toMatchObject({
      code: "neversync",
    });
  });
});

describe("the vault, syncing the folder Obsidian runs as its group's", () => {
  const SETTINGS_IN_GROUP = SETTINGS.map(
    (path) => `.obsidian-mobile${path.slice(".obsidian".length)}`,
  );

  it("lists the settings under the group's name, and writes them back into the folder it runs", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    await write(adapter, "note.md", "a note");
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian-mobile",
    });
    const files = (await vault.list())
      .filter((f) => !f.folder)
      .map((f) => f.path)
      .sort();
    expect(files).toEqual([...SETTINGS_IN_GROUP, "note.md"].sort());
    expect(dec.decode(await vault.read(".obsidian-mobile/app.json"))).toBe(`{"spellcheck": true}`);
    expect(await vault.stat(".obsidian-mobile/app.json")).toMatchObject({
      path: ".obsidian-mobile/app.json",
    });

    await vault.write(".obsidian-mobile/snippets/new.css", enc.encode(".new {}"), times);
    expect(dec.decode(await adapter.readBinary(".obsidian/snippets/new.css"))).toBe(".new {}");
    expect(await vault.exists(".obsidian-mobile/snippets/new.css")).toBe(true);
    expect(await adapter.exists(".obsidian-mobile"), "a folder of the group's name was made").toBe(
      false,
    );
  });

  it("refuses every other group's settings, the one named like the folder it runs included", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian-mobile",
    });
    await vault.list();
    for (const path of [
      ".obsidian/app.json",
      ".obsidian-desktop/app.json",
      ".obsidian-mobile/plugins/trew-sync/data.json",
      ".obsidian-mobile/workspace.json",
    ]) {
      await expect(vault.write(path, enc.encode("{}"), times), path).rejects.toMatchObject({
        code: "neversync",
      });
    }
    expect(dec.decode(await adapter.readBinary(".obsidian/app.json"))).toBe(`{"spellcheck": true}`);
    expect(dec.decode(await adapter.readBinary(".obsidian/plugins/trew-sync/data.json"))).toContain(
      "secret",
    );
  });

  it("syncs a config folder of any name", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter, ".my-config");
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".my-config", undefined, {
      settings: ".obsidian",
    });
    const files = (await vault.list()).filter((f) => !f.folder).map((f) => f.path);
    expect(files.sort()).toEqual(SETTINGS);
    await vault.write(".obsidian/snippets/new.css", enc.encode(".new {}"), times);
    expect(dec.decode(await adapter.readBinary(".my-config/snippets/new.css"))).toBe(".new {}");
  });

  it("names a setting the walk missed, and the engine found there, under the group's name", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const list = adapter.list.bind(adapter);
    adapter.list = async (path) => {
      if (path === ".obsidian") throw new Error("EIO: i/o error, scandir");
      return list(path);
    };
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian-mobile",
    });
    const files = (await vault.list({ present: [".obsidian-mobile/app.json"] })).map((f) => f.path);
    // Under the disk's name, the engine would read the setting it asked about
    // as gone, and send its deletion.
    expect(files).toContain(".obsidian-mobile/app.json");
    expect(files).not.toContain(".obsidian/app.json");
  });
});

describe("the vault, with a config folder whose name normalizing changes", () => {
  // Option-space on a Mac types a no-break space, and Obsidian's override
  // takes any name that starts with a dot.
  const disk = `.my${String.fromCharCode(0xa0)}config`;

  it("lists the folder's settings under the group's name", async () => {
    const adapter = new FakeAdapter();
    await write(adapter, `${disk}/app.json`, `{"spellcheck": true}`);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), disk, undefined, {
      settings: ".obsidian",
    });
    const files = (await vault.list()).filter((f) => !f.folder).map((f) => f.path);
    expect(files).toEqual([".obsidian/app.json"]);
  });

  it("names a setting the engine found there under the group's name, not the disk's", async () => {
    const adapter = new FakeAdapter();
    await write(adapter, `${disk}/app.json`, `{"spellcheck": true}`);
    const list = adapter.list.bind(adapter);
    adapter.list = async (path) => {
      if (path === disk) throw new Error("EIO: i/o error, scandir");
      return list(path);
    };
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), disk, undefined, {
      settings: ".obsidian",
    });
    const files = (await vault.list({ present: [".obsidian/app.json"] })).map((f) => f.path);
    expect(files).toEqual([".obsidian/app.json"]);
  });
});

describe("the vault, mapping onto a group, keeps everything it writes in the folder it runs", () => {
  it("never touches a folder on the disk spelled like the group", async () => {
    const adapter = new FakeAdapter();
    // This device runs .obsidian-mobile, and an old .obsidian is on the disk.
    await write(adapter, ".obsidian-mobile/app.json", `{"from": "running"}`);
    await write(adapter, ".obsidian/app.json", `{"from": "stale"}`);
    const vault = new ObsidianVault(
      asVault(new FakeVaultIndex(adapter)),
      ".obsidian-mobile",
      undefined,
      { settings: ".obsidian" },
    );
    const files = (await vault.list()).filter((f) => !f.folder).map((f) => f.path);
    expect(files).toEqual([".obsidian/app.json"]);
    expect(dec.decode(await vault.read(".obsidian/app.json"))).toContain("running");
    await vault.write(".obsidian/app.json", enc.encode(`{"from": "server"}`), times);
    expect(await adapter.read(".obsidian-mobile/app.json")).toContain("server");
    expect(await adapter.read(".obsidian/app.json")).toContain("stale");
    await expect(
      vault.write(".obsidian-mobile/app.json", enc.encode("{}"), times),
    ).rejects.toMatchObject({ code: "neversync" });
  });

  it("keeps a conflict copy beside the setting", async () => {
    const adapter = new FakeAdapter();
    await write(adapter, ".obsidian/app.json", `{"mine": true}`);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian-mobile",
    });
    await vault.list();
    const out = await vault.replace(
      ".obsidian-mobile/app.json",
      undefined,
      enc.encode(`{"theirs": true}`),
      times,
      ".obsidian-mobile/app (conflict).json",
    );
    expect(out.landed).toBe(true);
    expect(await adapter.read(".obsidian/app.json")).toContain("theirs");
    expect(await adapter.read(".obsidian/app (conflict).json")).toContain("mine");
    expect(await adapter.exists(".obsidian-mobile")).toBe(false);
    const files = (await vault.list())
      .filter((f) => !f.folder)
      .map((f) => f.path)
      .sort();
    expect(files).toEqual([".obsidian-mobile/app (conflict).json", ".obsidian-mobile/app.json"]);
  });

  it("keeps a setting it cannot match beside, rather than removing it", async () => {
    const adapter = new FakeAdapter();
    await write(adapter, ".obsidian/snippets/wide.css", ".wide {}");
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian-mobile",
    });
    await vault.list();
    const out = await vault.removeExpecting(
      ".obsidian-mobile/snippets/wide.css",
      undefined,
      ".obsidian-mobile/snippets/wide (kept).css",
    );
    expect(out.landed).toBe(true);
    expect(await adapter.exists(".obsidian-mobile")).toBe(false);
    expect(await adapter.read(".obsidian/snippets/wide (kept).css")).toBe(".wide {}");
    const files = (await vault.list()).filter((f) => !f.folder).map((f) => f.path);
    expect(files).toEqual([".obsidian-mobile/snippets/wide (kept).css"]);
  });
});

describe("the vault's settings walk", () => {
  it("keeps the notes' listing when part of the settings folder cannot be read", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    await write(adapter, "note.md", "a note");
    const list = adapter.list.bind(adapter);
    adapter.list = async (path) => {
      if (path === ".obsidian/themes/Tela")
        throw new Error("ENOENT: no such file or directory, scandir");
      return list(path);
    };
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian",
    });
    const files = (await vault.list()).filter((f) => !f.folder).map((f) => f.path);
    expect(files).toContain("note.md");
    expect(files).toContain(".obsidian/app.json");
  });

  it("sets aside a setting the disk holds under two spellings, as it does a note", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const nfc = ".obsidian/snippets/caf\u00e9.css";
    const nfd = ".obsidian/snippets/cafe\u0301.css";
    await write(adapter, nfc, ".one {}");
    await write(adapter, nfd, ".other {}");
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian",
    });
    const files = (await vault.list()).filter((f) => !f.folder).map((f) => f.path);
    expect(files).toContain(".obsidian/app.json");
    expect(files).not.toContain(nfc);
    expect(vault.ambiguous()).toEqual([{ path: nfc, spellings: [nfd, nfc] }]);
  });

  it("skips in the settings folder the names this device was told to skip", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      settings: ".obsidian",
      ignore: ["wide.css", "themes"],
    });
    const files = (await vault.list())
      .filter((f) => !f.folder)
      .map((f) => f.path)
      .sort();
    expect(files).toEqual([".obsidian/app.json", ".obsidian/appearance.json"]);
    // Refused as what this device was told, not as a failure.
    await expect(
      vault.write(".obsidian/snippets/wide.css", enc.encode("x"), times),
    ).rejects.toMatchObject({
      code: "ignored",
    });
  });
});

describe("the settings folder", () => {
  it("holds the settings settings sync carries, found the way the vault lists them", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    expect(await settingsIn(adapter, ".obsidian", ".obsidian-desktop")).toEqual(SETTINGS);
    expect(await settingsIn(adapter, ".obsidian-none", ".obsidian")).toEqual([]);
    await configFolder(adapter, ".my-config");
    expect(await settingsIn(adapter, ".my-config", ".obsidian")).toEqual(
      SETTINGS.map((path) => `.my-config${path.slice(".obsidian".length)}`),
    );
  });
});

describe("the copy kept before the first sync", () => {
  it("is every setting, read back, under the plugin's own folder", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const kept = await backUpSettings(
      adapter,
      ".obsidian",
      ".obsidian-mobile",
      ".obsidian/plugins/trew-sync",
      new Date("2026-10-10T01:02:03Z"),
    );
    expect(kept).toEqual({
      folder: ".obsidian/plugins/trew-sync/settings-before-sync-20261010-010203",
      files: SETTINGS.length,
    });
    for (const path of SETTINGS) {
      const copy = `${kept.folder}${path.slice(".obsidian".length)}`;
      expect(dec.decode(await adapter.readBinary(copy)), copy).toBe(
        dec.decode(await adapter.readBinary(path)),
      );
    }
  });

  it("never fills an earlier copy, made in the same second or not", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const at = new Date("2026-10-10T01:02:03Z");
    const dir = ".obsidian/plugins/trew-sync";
    const first = await backUpSettings(adapter, ".obsidian", ".obsidian", dir, at);
    await adapter.write(".obsidian/app.json", `{"spellcheck": false}`);
    const second = await backUpSettings(adapter, ".obsidian", ".obsidian", dir, at);
    expect(second.folder).toBe(`${first.folder}-2`);
    expect(dec.decode(await adapter.readBinary(`${first.folder}/app.json`))).toContain("true");
    expect(dec.decode(await adapter.readBinary(`${second.folder}/app.json`))).toContain("false");
  });
});

describe("the copy kept before an Apply", () => {
  it("is this device's settings as they are, replacing the last such copy", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const dir = ".obsidian/plugins/trew-sync";
    expect(await keepSettingsBeforeApply(adapter, ".obsidian", ".obsidian", dir)).toBe(
      SETTINGS.length,
    );
    await adapter.remove(".obsidian/snippets/wide.css");
    await adapter.write(".obsidian/app.json", `{"spellcheck": false}`);
    expect(await keepSettingsBeforeApply(adapter, ".obsidian", ".obsidian", dir)).toBe(
      SETTINGS.length - 1,
    );
    expect(dec.decode(await adapter.readBinary(`${dir}/settings-before-apply/app.json`))).toContain(
      "false",
    );
    expect(await adapter.exists(`${dir}/settings-before-apply/snippets/wide.css`)).toBe(false);
  });

  it("includes a theme whose name the disk keeps in NFD", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const nfd = ".obsidian/themes/Cafe\u0301/theme.css";
    await write(adapter, nfd, "body {}");
    expect(await settingsIn(adapter, ".obsidian", ".obsidian")).toContain(nfd);
  });
});

describe("the device's settings switch", () => {
  const base: DeviceConfig = {
    url: "wss://trew.example",
    vaultId: "v1",
    device: "phone",
    deviceId: "AAAAAAAAAAAAAAAAAAAAAA",
    deviceToken: "A".repeat(43),
  };

  it("is saved and read back, and off unless it names a group exactly", () => {
    const on: DeviceConfig = {
      ...base,
      settings: ".obsidian-mobile",
      settingsFirstChoice: "server",
    };
    expect(decodeConfig(encodeConfig(on), "data.json")).toMatchObject({
      settings: ".obsidian-mobile",
      settingsFirstChoice: "server",
    });
    expect(decodeConfig(encodeConfig(base), "data.json").settings).toBeUndefined();
    // 0.13.0 saved "true", which names no group, so it reads as off.
    for (const odd of ["true", "yes", ".obsidian-linux", ".OBSIDIAN"]) {
      const read = decodeConfig({ ...encodeConfig(base), settings: odd }, "data.json");
      expect(read.settings, odd).toBeUndefined();
    }
    const choice = decodeConfig(
      { ...encodeConfig(base), settingsFirstChoice: "both" },
      "data.json",
    );
    expect(choice.settingsFirstChoice).toBeUndefined();
  });
});
