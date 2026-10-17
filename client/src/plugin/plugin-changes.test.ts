import { describe, expect, it } from "vitest";

import type { HeldSetting } from "../core/engine.ts";
import { describeChange, describePluginChanges } from "./plugin-changes.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function held(path: string, uid: number, device = "Mac", deleted = false): HeldSetting {
  return { path, uid, hash: `h${uid}`, size: 1, deleted, device };
}

describe("what an Apply would change in this device's plugins' settings", () => {
  it("names each plugin by its name here, the device the change came from, and whether it is installed", async () => {
    const disk = new Map<string, string>([
      [".obsidian-mobile/plugins/dataview/manifest.json", JSON.stringify({ name: "Dataview" })],
      [".obsidian-mobile/plugins/obsidian42-brat/manifest.json", JSON.stringify({ name: "BRAT" })],
    ]);
    const changes = await describePluginChanges(
      [
        held(".obsidian-mobile/plugins/dataview/data.json", 1),
        held(".obsidian-mobile/plugins/obsidian42-brat/data.json", 2, "Pixel"),
        held(".obsidian-mobile/plugins/templater-obsidian/data.json", 3),
        held(".obsidian-mobile/plugins/omnisearch/data.json", 4, "Mac", true),
        held(".obsidian-mobile/app.json", 5),
      ],
      ".obsidian-mobile",
      async (path) => (disk.has(path) ? enc(disk.get(path)!) : undefined),
    );
    expect(changes.plugins.map((c) => [describeChange(c), c.from])).toEqual([
      ["Change BRAT's settings", "Pixel"],
      ["Change Dataview's settings", "Mac"],
      ["Remove omnisearch's settings", "Mac"],
      ["Keep settings for templater-obsidian, ready for when it is installed here", "Mac"],
    ]);
    expect(changes.otherSettings).toBe(1);
  });

  it("counts a plugins folder spelt in capitals as plugins'", async () => {
    const changes = await describePluginChanges(
      [held(".obsidian/Plugins/dataview/data.json", 1)],
      ".obsidian",
      async () => undefined,
    );
    expect(changes.plugins.map((c) => c.id)).toEqual(["dataview"]);
    expect(changes.otherSettings).toBe(0);
  });
});
