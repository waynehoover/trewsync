import { describe, expect, it } from "vitest";

import type { HeldSetting } from "../core/engine.ts";
import { describeChange, describePluginChanges } from "./plugin-changes.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (name: string, version: string, desktopOnly = false) =>
  JSON.stringify({
    id: name.toLowerCase(),
    name,
    version,
    ...(desktopOnly ? { isDesktopOnly: true } : {}),
  });

function held(path: string, uid: number, device = "Mac", deleted = false): HeldSetting {
  return { path, uid, hash: `h${uid}`, size: 1, deleted, device };
}

describe("what an Apply would do to this device's plugins", () => {
  it("names each plugin to install, update, change or remove, with its version and device", async () => {
    const server = new Map<number, string>([
      [1, manifest("Dataview", "0.5.68")],
      [3, manifest("QuickAdd", "1.3.0")],
      [6, JSON.stringify(["dataview", "quickadd"], null, 2)],
    ]);
    const disk = new Map<string, string>([
      [".obsidian-mobile/plugins/quickadd/manifest.json", manifest("QuickAdd", "1.2.0")],
      [".obsidian-mobile/plugins/templater-obsidian/manifest.json", manifest("Templater", "2.0.0")],
      [".obsidian-mobile/plugins/omnisearch/manifest.json", manifest("Omnisearch", "1.0.0")],
      [
        ".obsidian-mobile/community-plugins.json",
        JSON.stringify(["quickadd", "omnisearch", "trew-sync"]),
      ],
    ]);
    const changes = await describePluginChanges(
      [
        held(".obsidian-mobile/plugins/dataview/manifest.json", 1),
        held(".obsidian-mobile/plugins/dataview/main.js", 2),
        held(".obsidian-mobile/plugins/quickadd/manifest.json", 3, "Pixel"),
        held(".obsidian-mobile/plugins/templater-obsidian/data.json", 4),
        held(".obsidian-mobile/plugins/omnisearch/main.js", 5, "Mac", true),
        held(".obsidian-mobile/community-plugins.json", 6),
        held(".obsidian-mobile/app.json", 7),
      ],
      ".obsidian-mobile",
      {
        held: async (h) => (server.has(h.uid) ? enc(server.get(h.uid)!) : undefined),
        local: async (path) => (disk.has(path) ? enc(disk.get(path)!) : undefined),
      },
    );
    expect(changes.plugins.map((c) => [describeChange(c), c.from])).toEqual([
      ["Install Dataview 0.5.68", "Mac"],
      ["Remove Omnisearch", "Mac"],
      ["Update QuickAdd from 1.2.0 to 1.3.0", "Pixel"],
      ["Change Templater's settings", "Mac"],
    ]);
    // The sync plugin is this device's own entry, never switched by the list.
    expect(changes.switchedOn).toEqual(["dataview"]);
    expect(changes.switchedOff).toEqual(["omnisearch"]);
    expect(changes.otherSettings).toBe(1);
  });

  it("says when an incoming plugin runs on desktops only", async () => {
    const changes = await describePluginChanges(
      [held(".obsidian-mobile/plugins/git-thing/manifest.json", 1)],
      ".obsidian-mobile",
      { held: async () => enc(manifest("Git thing", "1.0.0", true)), local: async () => undefined },
    );
    expect(changes.plugins[0]?.desktopOnly).toBe(true);
  });

  it("still names a plugin whose versions cannot be read", async () => {
    const changes = await describePluginChanges(
      [held(".obsidian/plugins/dataview/main.js", 1), held(".obsidian/community-plugins.json", 2)],
      ".obsidian",
      { held: async () => undefined, local: async () => undefined },
    );
    expect(changes.plugins.map(describeChange)).toEqual(["Install dataview"]);
    expect(changes.switchedOn).toEqual([]);
  });
});
