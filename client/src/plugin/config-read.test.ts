import { afterEach, expect, it } from "vitest";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import TelimusPlugin from "./main.ts";
import { App, resetStub } from "./stub.ts";

let plugin: TelimusPlugin | undefined;
afterEach(async () => {
  plugin?.onunload();
  await plugin?.closing;
  resetStub();
});

it("refuses to pair when Obsidian returns undefined for an unreadable settings file", async () => {
  const app = new App();
  const path = ".obsidian/plugins/telimus-sync/data.json";
  const broken = '{"deviceKey":"the only credential is in this damaged file"';
  app.vault.adapter.seed(path, broken);
  plugin = new TelimusPlugin(
    app as unknown as ObsidianApp,
    {
      id: "telimus-sync",
      dir: ".obsidian/plugins/telimus-sync",
    } as PluginManifest,
  );
  // Native readPluginData returns null for ENOENT and undefined for read/JSON errors.
  plugin.loadData = async () => undefined;
  await plugin.onload();
  expect(plugin.currentState.kind).toBe("stopped");
  await expect(plugin.pairFirst("unused setup", "laptop")).rejects.toThrow(
    /saved settings.*could not be read/,
  );
  expect(app.vault.adapter.text(path)).toBe(broken);
});
