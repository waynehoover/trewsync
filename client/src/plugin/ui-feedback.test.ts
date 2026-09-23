import { afterEach, expect, it, vi } from "vitest";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import TrewPlugin, { type State } from "./main.ts";
import { App, built, FakeEl, modals, resetStub, type Plugin as StubPlugin } from "./stub.ts";
import { deferred, nextTurn } from "../core/test-async.ts";
import type { SyncPreview } from "../core/preview.ts";

type Subject = TrewPlugin & StubPlugin;
const plugins: Subject[] = [];
afterEach(async () => {
  for (const plugin of plugins.splice(0)) {
    plugin.onunload();
    await plugin.closing;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetStub();
});
async function load() {
  const plugin = new TrewPlugin(
    new App() as unknown as ObsidianApp,
    {
      id: "trew-sync",
      dir: ".obsidian/plugins/trew-sync",
    } as PluginManifest,
  ) as Subject;
  plugins.push(plugin);
  await plugin.onload();
  return plugin;
}
const state = (plugin: Subject, value: State) =>
  (plugin as unknown as { setState(value: State): void }).setState(value);
function pair(plugin: Subject) {
  Object.assign(plugin, {
    config: {
      url: "wss://example.invalid",
      vaultId: "default",
      device: "Laptop",
      deviceId: "sample",
    },
  });
  vi.spyOn(plugin, "devices").mockResolvedValue({
    devices: [],
    invites: [],
    maxDevices: 0,
    thisDevice: "sample",
  });
}
const rows = (host: FakeEl) => built.filter((row) => host.contains(row.settingEl));
const button = (host: FakeEl, label: string) =>
  rows(host)
    .flatMap((row) => row.buttons)
    .find((b) => b.label === label)!;

it("updates an already open setup panel when another surface finishes pairing, without discarding a draft on routine updates", async () => {
  const plugin = await load();
  const tab = plugin.settingTabs[0]!;
  tab.display();
  const field = rows(tab.containerEl).find((row) => row.name === "Invite or setup line")!.texts[0]!;
  field.type("a draft invite");
  state(plugin, { kind: "unpaired" });
  expect(rows(tab.containerEl).find((row) => row.name === "Invite or setup line")!.texts[0]).toBe(
    field,
  );
  expect(field.getValue()).toBe("a draft invite");
  pair(plugin);
  state(plugin, { kind: "synced", summary: "Up to date", at: 1, refused: 0, waiting: 0 });
  expect(rows(tab.containerEl).map((row) => row.name)).toContain("Sync status");
  expect(rows(tab.containerEl).map((row) => row.name)).not.toContain("Invite or setup line");
  tab.hide();
  expect((plugin as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
});

it("gives pairing inputs accessible names matching the visible labels", async () => {
  const plugin = await load();
  const tab = plugin.settingTabs[0]!;
  tab.display();
  // One form, so both fields are here at once. "Device name" lives inside the
  // collapsed More options, and a label inside a closed `details` is still a
  // label: a screen reader reaches it by opening the disclosure, and it has to
  // say the same thing there as it does on screen.
  for (const name of ["Device name", "Invite or setup line"]) {
    expect(
      rows(tab.containerEl)
        .find((row) => row.name === name)!
        .texts[0]!.inputEl.getAttribute("aria-label"),
    ).toBe(name);
  }
  tab.hide();
});

it("retains the busy status icon while updating its accessible progress text", async () => {
  const plugin = await load();
  state(plugin, { kind: "syncing", since: 1, path: "Before.md" });
  const status = plugin.statusBarItems[0]!;
  const icon = status.children[0];
  state(plugin, { kind: "syncing", since: 1, path: "After.md" });
  expect(status.children[0]).toBe(icon);
  expect(status.getAttribute("aria-label")).toContain("After.md");
  state(plugin, { kind: "synced", summary: "Up to date", at: 1, refused: 0, waiting: 0 });
  expect(status.children[0]!.getAttribute("data-icon")).toBe("cloud-check");
});

it("shows one loading preview immediately and ignores its result after closing", async () => {
  const plugin = await load();
  const pending = deferred<SyncPreview>();
  const preview = vi.fn(() => pending.promise);
  Object.assign(plugin, { client: { preview, close: async () => {} } });
  const command = plugin.commands.find((command) => command.id === "preview-sync")!.callback!;
  command();
  command();
  const loading = modals.filter((modal) => modal.isOpen);
  expect(loading).toHaveLength(1);
  expect(loading[0]!.contentEl.allText()).toMatch(/prepar|loading/i);
  expect(preview).toHaveBeenCalledTimes(1);
  loading[0]!.close();
  pending.resolve({ cursor: 0, files: [] });
  await nextTurn();
  expect(modals.filter((modal) => modal.isOpen)).toHaveLength(0);
});

it("offers resume in the paused panel and resumes through the existing lifecycle", async () => {
  const plugin = await load();
  pair(plugin);
  Object.assign(plugin, { paused: true });
  const start = vi
    .spyOn(plugin as unknown as { start(): void }, "start")
    .mockImplementation(() => {});
  state(plugin, { kind: "paused" });
  const tab = plugin.settingTabs[0]!;
  tab.display();
  const resume = button(tab.containerEl, "Resume sync");
  expect(resume).toBeDefined();
  await resume.click();
  expect(start).toHaveBeenCalledOnce();
  expect((plugin as unknown as { paused: boolean }).paused).toBe(false);
  tab.hide();
});

it("closes the subscribed activity window when the plugin unloads", async () => {
  const plugin = await load();
  plugin.commands.find((command) => command.id === "activity")!.callback!();
  const modal = modals.find((modal) => modal.isOpen)!;
  expect(modal).toBeDefined();
  plugin.onunload();
  await plugin.closing;
  expect(modal.isOpen).toBe(false);
});

async function drainingPause() {
  const plugin = await load();
  pair(plugin);
  const internal = plugin as unknown as {
    togglePause(): Promise<void>;
    start(): void;
    activityLog: { flush(): Promise<void> };
  };
  const drain = deferred();
  const flush = deferred();
  Object.assign(plugin, { client: { close: () => drain.promise } });
  vi.spyOn(internal.activityLog, "flush").mockImplementation(() => flush.promise);
  const start = vi.spyOn(internal, "start").mockImplementation(() => {});
  const pausing = internal.togglePause();
  return { plugin, drain, flush, start, pausing };
}

it.each(["settings", "menu"])(
  "resumes from %s after the client's close and activity flush both finish",
  async (surface) => {
    const { plugin, drain, flush, start, pausing } = await drainingPause();
    try {
      let resume: Promise<void>;
      if (surface === "settings") {
        const tab = plugin.settingTabs[0]!;
        tab.display();
        resume = button(tab.containerEl, "Resume sync").click();
      } else {
        const { Menu } = await import("./stub.ts");
        plugin.ribbonIcons[0]!.callback();
        const item = Menu.latest!.items.find((item) => item.label === "Resume sync")!;
        expect(item.disabled).toBe(false);
        resume = item.click();
      }
      expect(start).not.toHaveBeenCalled();
      drain.resolve();
      await nextTurn();
      expect(start).not.toHaveBeenCalled();
      flush.resolve();
      await Promise.all([pausing, resume]);
      await nextTurn();
      expect(start).toHaveBeenCalledOnce();
      expect((plugin as unknown as { paused: boolean }).paused).toBe(false);
    } finally {
      drain.resolve();
      flush.resolve();
      await pausing;
    }
  },
);

it.each(["unload", "unlink"])(
  "cancels a pending resume when %s retires the paused run",
  async (retirement) => {
    const { plugin, drain, flush, start, pausing } = await drainingPause();
    try {
      const resume = plugin.syncNow();
      let retired: Promise<void> | undefined;
      if (retirement === "unload") {
        plugin.onunload();
        retired = plugin.closing;
      } else retired = plugin.unlink();
      drain.resolve();
      flush.resolve();
      await Promise.all([pausing, resume, retired]);
      expect(start).not.toHaveBeenCalled();
      if (retirement === "unlink") expect(plugin.currentState.kind).toBe("unpaired");
    } finally {
      drain.resolve();
      flush.resolve();
      await pausing;
    }
  },
);
