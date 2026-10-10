/**
 * Settings sync on the plugin's side (plan/settings-sync.md): the config
 * folder the vault lists and writes when settings sync is on, the copy of a
 * device's settings kept before the first sync, and a profile made from the
 * one running.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { decodeConfig, encodeConfig, type DeviceConfig } from "../core/pairing.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";
import { resetStub } from "./stub.ts";
import {
  backUpSettings,
  createProfile,
  isProfileName,
  keepSettingsBeforeApply,
  profileRootOf,
  settingsIn,
} from "./settings.ts";
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
      settings: true,
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
      settings: true,
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
      settings: true,
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
      settings: true,
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
      settings: true,
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
  it("is a profile root only under a name settings sync can tell from any other dot folder", () => {
    expect(profileRootOf(".obsidian")).toBe(".obsidian");
    expect(profileRootOf("/.obsidian-mobile/")).toBe(".obsidian-mobile");
    expect(profileRootOf(".my-config")).toBeUndefined();
    expect(profileRootOf(".obsidian-Mobile")).toBeUndefined();
    expect(isProfileName("mobile")).toBe(true);
    expect(isProfileName("phone-2")).toBe(true);
    for (const bad of ["", "Mobile", "-x", "a/b", "x".repeat(33)])
      expect(isProfileName(bad), bad).toBe(false);
  });

  it("holds the settings settings sync carries, found the way the vault lists them", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    expect(await settingsIn(adapter, ".obsidian")).toEqual(SETTINGS);
    expect(await settingsIn(adapter, ".obsidian-none")).toEqual([]);
  });
});

describe("the copy kept before the first sync", () => {
  it("is every setting, read back, under the plugin's own folder", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const kept = await backUpSettings(
      adapter,
      ".obsidian",
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

  it("refuses to fill a folder that is already there", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const at = new Date("2026-10-10T01:02:03Z");
    await backUpSettings(adapter, ".obsidian", ".obsidian/plugins/trew-sync", at);
    await expect(
      backUpSettings(adapter, ".obsidian", ".obsidian/plugins/trew-sync", at),
    ).rejects.toThrow("already there");
  });
});

describe("a new settings profile", () => {
  it("is a read-back copy of everything, plugins and pairing included, and leaves the old folder whole", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    await write(adapter, ".obsidian/plugins/dev-plugin/node_modules/x/index.js", "a dependency");
    await write(adapter, ".obsidian/plugins/dev-plugin/.git/HEAD", "ref: refs/heads/main");
    await write(adapter, ".obsidian/plugins/dev-plugin/main.js", "module.exports = {}");
    await createProfile(adapter, ".obsidian", ".obsidian-mobile");
    for (const path of [
      "app.json",
      "workspace.json",
      "community-plugins.json",
      "themes/Tela/theme.css",
      "plugins/trew-sync/data.json",
      "plugins/trew-sync/index.json",
      "plugins/dataview/main.js",
      "plugins/dev-plugin/main.js",
    ]) {
      expect(await adapter.exists(`.obsidian-mobile/${path}`), path).toBe(true);
    }
    expect(await adapter.exists(".obsidian-mobile/plugins/dev-plugin/node_modules")).toBe(false);
    expect(await adapter.exists(".obsidian-mobile/plugins/dev-plugin/.git")).toBe(false);
    expect(
      dec.decode(await adapter.readBinary(".obsidian-mobile/plugins/trew-sync/index.json")),
    ).toBe(`{"cursor": 9}`);
    // The folder still running keeps its index until the copy runs.
    expect(await adapter.exists(".obsidian/plugins/trew-sync/index.json")).toBe(true);
  });

  it("is never made over a profile that is already there", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    await write(adapter, ".obsidian-mobile/app.json", `{"from": "the phone"}`);
    await expect(createProfile(adapter, ".obsidian", ".obsidian-mobile")).rejects.toThrow(
      "already exists",
    );
    expect(dec.decode(await adapter.readBinary(".obsidian-mobile/app.json"))).toBe(
      `{"from": "the phone"}`,
    );
  });

  it("is removed when the copy fails part way, so nothing half made is left to relaunch into", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    let writes = 0;
    const writeBinary = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (++writes === 3) throw new Error("ENOSPC: no space left on device");
      return writeBinary(path, data, options);
    };
    await expect(createProfile(adapter, ".obsidian", ".obsidian-mobile")).rejects.toThrow("ENOSPC");
    expect(await adapter.exists(".obsidian-mobile")).toBe(false);
  });
});

describe("the copy kept before an Apply", () => {
  it("is this device's settings as they are, replacing the last such copy", async () => {
    const adapter = new FakeAdapter();
    await configFolder(adapter);
    const dir = ".obsidian/plugins/trew-sync";
    expect(await keepSettingsBeforeApply(adapter, ".obsidian", dir)).toBe(SETTINGS.length);
    await adapter.remove(".obsidian/snippets/wide.css");
    await adapter.write(".obsidian/app.json", `{"spellcheck": false}`);
    expect(await keepSettingsBeforeApply(adapter, ".obsidian", dir)).toBe(SETTINGS.length - 1);
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
    expect(await settingsIn(adapter, ".obsidian")).toContain(nfd);
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

  it("is saved and read back, and off unless it says exactly on", () => {
    const on: DeviceConfig = { ...base, settings: true, settingsFirstChoice: "server" };
    expect(decodeConfig(encodeConfig(on), "data.json")).toMatchObject({
      settings: true,
      settingsFirstChoice: "server",
    });
    const off = decodeConfig(encodeConfig({ ...base, settings: false }), "data.json");
    expect(off.settings).toBeUndefined();
    const odd = decodeConfig(
      { ...encodeConfig(base), settings: "yes", settingsFirstChoice: "both" },
      "data.json",
    );
    expect(odd.settings).toBeUndefined();
    expect(odd.settingsFirstChoice).toBeUndefined();
  });
});
