import { deferred, nextTurn, within } from "../core/test-async.ts";
/**
 * The plugin, run.
 *
 * `main.ts` was written to be the one file no test could reach: it imports
 * `obsidian`, and the npm package is type declarations with no runtime. That is
 * a reason it is hard to test, not a reason it is fine untested, and the shell
 * is where a sync client's setup bugs live.
 *
 * So `stub.ts` supplies the runtime, `vitest.config.ts` aliases the module to it
 * for tests only, and everything below is the real plugin: real pairing, real
 * engine, real WebSocket, real Go server. `tsc` still checks `main.ts` against
 * the genuine declarations, and the shipped bundle still gets Obsidian's own
 * implementation.
 *
 * What this cannot tell you is whether Obsidian calls `onload` when this expects
 * or draws what this builds. That needs Obsidian.
 */

import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { PROTO, Transport } from "../core/transport.ts";
import {
  App,
  type FakeEl,
  Platform,
  Plugin as StubPlugin,
  built,
  modals,
  notices,
  resetStub,
} from "./stub.ts";
import TelimusPlugin, { connectionDetail, describeConnection, describeDeleted } from "./main.ts";
import { describeRestore } from "./history.ts";
import { Engine, type SyncReport } from "../core/engine.ts";
import { Client, redeemInvite } from "../core/client.ts";
import { ObsidianIndexStore } from "./vault.ts";
import {
  DEFAULT_VAULT,
  INVITE_ID_LENGTH,
  INVITE_KEY_LENGTH,
  formatInvite,
  parseInvite,
  parsePairing,
} from "../core/pairing.ts";
import { INVITE_ACTION, inviteLink, inviteQrImage } from "./invite-qr.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/**
 * A plugin wired to the stub.
 *
 * The casts are the seam and there is no way around them: `main.ts` is typed
 * against the real declarations, on purpose, and the stub is a different class
 * that happens to have the same shape. Doing it in one place keeps it honest.
 */
type Testable = TelimusPlugin & StubPlugin;

/**
 * The recovery key `pairFirst` returned, kept for the tests that add a second
 * device with it.
 *
 * It is shown once and no device holds it: a device that did could re-derive
 * the vault's credential and register itself again after being revoked, so
 * revoking it would stop nothing. These tests therefore write it down, which
 * is what a person is told to do.
 */
const writtenDown = new WeakMap<object, string>();
async function startVault(plugin: Testable, name = "laptop", setup?: string): Promise<string> {
  const key = await plugin.pairFirst(setup ?? server.setup, name);
  writtenDown.set(plugin, key);
  return key;
}
const keyOf = (plugin: Testable): string => {
  const key = writtenDown.get(plugin);
  if (key === undefined) throw new Error("this vault was not started by startVault");
  return key;
};

function makePlugin(
  app: App,
  manifest: { id: string; dir?: string } = { id: "telimus", dir: ".obsidian/plugins/telimus" },
): Testable {
  return new TelimusPlugin(
    app as unknown as ObsidianApp,
    manifest as unknown as PluginManifest,
  ) as unknown as Testable;
}

let server: TestServer;
const loaded: Testable[] = [];

beforeEach(() => {
  resetStub();
});

afterEach(async () => {
  const closing: Promise<void>[] = [];
  while (loaded.length) {
    const p = loaded.pop()!;
    p.onunload();
    if (p.closing) closing.push(p.closing);
  }
  await Promise.all(closing);
  if (server) await server.cleanup();
});

async function fresh(): Promise<void> {
  server = new TestServer();
  await server.start();
}

/** Loads a plugin, and returns it and its app. */
async function load(
  saved: unknown = null,
  manifest?: { id: string; dir?: string },
  configDir?: string,
  /** A chance to make the host look like an older Obsidian before onload. */
  beforeLoad?: (plugin: Testable) => void,
): Promise<{ plugin: Testable; app: App }> {
  const app = new App();
  if (configDir !== undefined) app.vault.configDir = configDir;
  const plugin = makePlugin(app, manifest);
  // These lifecycle tests accept sync previews; preview controls have their own tests.
  (plugin as unknown as { confirmSync: () => Promise<boolean> }).confirmSync = async () => true;
  plugin.savedData = saved;
  loaded.push(plugin);
  beforeLoad?.(plugin);
  await plugin.onload();
  return { plugin, app };
}

/**
 * Waits for something to become true, or explains what it was waiting for.
 *
 * The default is generous on purpose. Twenty seconds is a fact about the
 * machine that chose it, and this file starts real Go servers over real
 * sockets: CI's case-folding runner timed out one of these at `connecting`
 * while every laptop passed it, and the fix at the time was to pass a budget
 * at that one call site. Its sibling, seeded with the same 4800-character
 * path, was left on the default and flaked next. Two call sites, one of them
 * fixed, which is a shape this project keeps finding.
 *
 * So the default is the budget, chosen for the slowest thing here rather than
 * the fastest. Nothing waits on this to *expire* as an assertion, and the
 * enclosing `it` allows five minutes, so the cost of being generous is how
 * long a genuinely stuck test takes to say so.
 */
async function until(what: string, cond: () => boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Waits for a promise that is supposed to settle, and says so when it does not.
 *
 * The failure being guarded is a wait left pending, so the symptom is a test
 * that never finishes. Left to the suite timeout that reads as "timed out
 * after 300000ms" five minutes later, with nothing about what was waiting.
 */
async function settles(work: Promise<unknown>, what: string, ms = 5_000): Promise<void> {
  await within(
    work.catch(() => undefined),
    what,
    ms,
  );
}

/**
 * `ms` because `until`'s default is fifteen seconds, and fifteen seconds is a
 * fact about the machine that wrote it.
 *
 * The test below does about seven seconds of work here, which leaves rather
 * little room, and it has timed out three times on CI's mounted-filesystem job
 * while passing everywhere else. That job is not slower on average -- 146s
 * against 141s for the ordinary client job on a run where both passed -- so
 * this is an occasional stall on a shared runner eating a margin that was only
 * ever about twofold, rather than a filesystem that is reliably slow. Which is
 * the more annoying kind: it passes here every time.
 *
 * So pass a budget wherever the work is big. The surrounding `it` has its own
 * much larger timeout, so waiting longer costs nothing when things are working
 * and the only thing a short deadline buys is this.
 */
/**
 * Opens the panel on the pairing form.
 *
 * There is one form and one field now, and which of the three strings it holds
 * is read from the string. So this is only the open, and the `path` argument
 * survives because the callers read better for saying which kind they are
 * about to paste, not because the panel is told.
 */
function choosePairing(plugin: Testable, _path: "invite" | "first"): void {
  built.length = 0;
  plugin.commands.find((c) => c.id === "show-status")!.callback!();
}

const synced = (p: Testable, ms?: number) =>
  until("a sync", () => p.currentState.kind === "synced", ms).catch((err: Error) => {
    throw new Error(`${err.message}; the state is ${JSON.stringify(p.currentState)}`);
  });
/**
 * What the status bar says, which is now a tooltip rather than text: the item
 * itself is a glyph the size of its neighbours.
 */
const status = (p: Testable) => p.statusBarItems[0]?.attributes.get("aria-label") ?? "";

/** Readable panel copy, including native descriptions in the settings stub. */
const panelText = (): string => {
  const walk = (el: FakeEl): string => {
    if (el.hidden) return "";
    const setting = built.find((s) => s.settingEl === el);
    return [el.text, setting?.name, setting?.desc, ...el.children.map(walk)]
      .filter(Boolean)
      .join("\n");
  };
  const modal = modals.at(-1);
  return modal ? walk(modal.contentEl) : "";
};

const containsElement = (root: FakeEl, target: FakeEl): boolean =>
  root === target || root.children.some((child) => containsElement(child, target));

/** Which glyph it chose, which is the other half of what it says. */
const statusIcon = (p: Testable) =>
  p.statusBarItems[0]?.children
    .find((c) => c.cls.includes("telimus-status-icon"))
    ?.attributes.get("data-icon") ?? "";

describe("loading", () => {
  it("comes up unpaired, and says so", async () => {
    const { plugin } = await load();
    expect(plugin.paired).toBe(false);
    expect(status(plugin)).toBe("Telimus Sync: Not paired.");
    expect(statusIcon(plugin)).toBe("link");
  });

  it("registers the things a plugin registers", async () => {
    const { plugin, app } = await load();
    expect(plugin.commands.map((c) => c.id).sort()).toEqual([
      "activity",
      "pause-resume",
      "preview-sync",
      "recover-deleted",
      "review-conflicts",
      "show-status",
      "sync-now",
      "verify-contents",
      "version-history",
    ]);
    expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Telimus Sync"]);
    expect(plugin.statusBarItems.length).toBe(1);
    // create, modify, delete, rename. Without these it only syncs on a timer.
    expect(app.vault.handlerCount()).toBe(4);
    // Those four, plus the file-menu entry that puts history where somebody
    // already looks for it.
    expect(plugin.registeredEvents.length).toBe(5);
    expect([...plugin.cliHandlers.keys()].sort()).toEqual(["telimus:history", "telimus:restore"]);
  });

  /**
   * Obsidian's own documentation: "If you do not wish to receive create events
   * on vault load, register your event handler inside
   * Workspace.onLayoutReady". Registering earlier means opening a vault fires
   * a create for every file in it.
   */
  it("waits for the layout before listening for file events", async () => {
    const app = new App();
    app.workspace.layoutReady = false;
    const plugin = makePlugin(app);
    loaded.push(plugin);
    await plugin.onload();

    expect(app.vault.handlerCount(), "listening before the layout was ready").toBe(0);
    app.workspace.finishLayout();
    expect(app.vault.handlerCount()).toBe(4);
  });

  /**
   * Rule 2, and the incident behind it: code that read a config, fell back to
   * an empty result on error and wrote that back disabled every plugin on a
   * device. Here the fallback would be worse: an unreadable config read as
   * "unpaired" means the next pairing generates a new root secret, and
   * everything already on the server stops being decryptable on this device.
   */
  it("refuses to start over from a config it cannot read", async () => {
    const { plugin } = await load({ url: "ws://x", token: "t", vaultId: "default", device: "d" });
    expect(plugin.paired).toBe(false);
    expect(plugin.currentState.kind).toBe("stopped");
    expect(notices.map((n) => n.message).join(" ")).toMatch(
      /neither the vault's recovery key nor this device's own credential/,
    );
    // And it did not quietly overwrite the config it could not read.
    expect(plugin.savedData).toEqual({
      url: "ws://x",
      token: "t",
      vaultId: "default",
      device: "d",
    });
  });

  it("refuses a stored secret of the wrong length", async () => {
    const { plugin } = await load({
      url: "ws://x",
      token: "t",
      vaultId: "default",
      device: "d",
      secret: "AAAA",
    });
    expect(plugin.currentState.kind).toBe("stopped");
    expect(notices.map((n) => n.message).join(" ")).toMatch(/root secret is 32 bytes/);
  });
});

describe("where its own state goes", () => {
  /**
   * The index must land inside Obsidian's config folder, which never syncs. An
   * index that synced would sync to itself, and every device would overwrite
   * every other device's idea of what had been synced.
   */
  it("keeps the index inside the config folder", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/telimus/index.json");
    // Nothing of the plugin's leaked into the vault proper.
    const inVault = app.vault.adapter.filePaths().filter((p) => !p.startsWith(".obsidian/"));
    expect(inVault).toEqual(["note.md"]);
  }, 300_000);

  it("follows a vault that calls its config folder something else", async () => {
    await fresh();
    const { plugin, app } = await load(
      null,
      { id: "telimus", dir: ".my-config/plugins/telimus" },
      ".my-config",
    );
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".my-config/plugins/telimus/index.json");
    expect(app.vault.adapter.filePaths().filter((p) => !p.startsWith(".my-config/"))).toEqual([
      "note.md",
    ]);
  }, 300_000);

  /**
   * `manifest.dir` is optional in Obsidian's API. Interpolating it without
   * looking produces "undefined/index.json" at the vault root, which the
   * never-sync list has no reason to skip, so the index would be uploaded and
   * then fought over by every device.
   */
  it("works out where it lives when Obsidian does not say", async () => {
    await fresh();
    const { plugin, app } = await load(null, { id: "telimus" });
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/telimus/index.json");
    expect(app.vault.adapter.filePaths().some((p) => p.startsWith("undefined"))).toBe(false);
  }, 300_000);

  it("refuses to run from outside the config folder", async () => {
    // And says so. The loop that assembles the client runs detached, so
    // without somewhere for this to land the plugin would simply never
    // sync, with a status bar still saying "connecting".
    await fresh();
    const { plugin } = await load(null, { id: "telimus", dir: "somewhere/else" });
    await expect(startVault(plugin, "laptop")).rejects.toThrow(/outside/);
    await until("it to give up", () => plugin.currentState.kind === "stopped");
    expect(notices.map((n) => n.message).join(" ")).toMatch(/would sync/);
    expect(statusIcon(plugin)).toBe("alert-triangle");
    expect(status(plugin)).toMatch(/^Telimus Sync: Stopped:/);
  }, 300_000);
});

describe("pairing", () => {
  it("starts a vault, and syncs it", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "# Hello\n");

    const summaries: string[] = [];
    plugin.watchState((state) => {
      if (state.kind === "synced") summaries.push(state.summary);
    });
    const pairing = await startVault(plugin, "laptop");
    expect(pairing).toMatch(/^basalt3_/);
    await synced(plugin);

    expect(plugin.paired).toBe(true);
    expect(plugin.deviceName).toBe("laptop");
    expect(statusIcon(plugin)).toBe("cloud-check");
    expect(summaries).toContain("1 sent");
    expect(status(plugin)).toMatch(/^Telimus Sync: (?:1 sent|Up to date), as of /);
    // Saved in a form that survives the JSON round trip Obsidian does.
    // No token: the vault has one secret, and what authenticates is derived
    // from it. The server's first-run token is kept only until the vault has
    // been claimed with it, and by now it has.
    await until("the spent bootstrap to be dropped", () => {
      const saved = plugin.savedData as Record<string, unknown> | null;
      return saved !== null && saved["bootstrap"] === undefined;
    });
    // What is left is this device's own credential and the data key it reads
    // with. Not the vault's root: a device that held it could register itself
    // again after being revoked, so revoking would stop nothing.
    expect(Object.keys(plugin.savedData as object).sort()).toEqual([
      "dataKey",
      "device",
      "deviceId",
      "deviceSecret",
      "url",
      "vaultId",
    ]);
  }, 300_000);

  it("joins a vault another device started", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "# Hello\n");
    const pairing = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    await second.plugin.pair(pairing, "desktop");
    await synced(second.plugin);
    await until("the note to arrive", () => second.app.vault.adapter.text("note.md") !== undefined);

    expect(second.app.vault.adapter.text("note.md")).toBe("# Hello\n");
    expect(second.plugin.deviceName).toBe("desktop");
  }, 300_000);

  it("comes back paired after a restart", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "x");
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const saved = first.plugin.savedData;
    first.plugin.onunload();

    // Same data.json, a fresh plugin object. It must not ask to be paired.
    const again = await load(saved);
    expect(again.plugin.paired).toBe(true);
    await synced(again.plugin);
    expect(again.plugin.currentState.kind).toBe("synced");
  }, 300_000);

  /**
   * Re-pairing would replace the root secret. Everything already on the server
   * would stop being decryptable here, the vault would look empty, and the
   * local copies would then be uploaded under new keys. There is no coming
   * back from that.
   */
  it("refuses to pair a vault that is already paired", async () => {
    await fresh();
    const { plugin } = await load();
    const pairing = await startVault(plugin, "laptop");
    await synced(plugin);

    await expect(startVault(plugin, "again")).rejects.toThrow(/already paired/);
    await expect(plugin.pair(pairing, "again")).rejects.toThrow(/already paired/);
  }, 300_000);

  it("refuses a pairing string that was mangled", async () => {
    const { plugin } = await load();
    await expect(plugin.pair("hello", "d")).rejects.toThrow(/basalt3_/);
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
  });

  it("needs a server to start a vault against", async () => {
    const { plugin } = await load();
    await expect(plugin.pairFirst("#token", "d")).rejects.toThrow(/server address/);
    await expect(plugin.pairFirst("ws://host#  ", "d")).rejects.toThrow(/token/);
    await expect(plugin.pairFirst("ws://host", "d")).rejects.toThrow(/host:3003#TOKEN/);
    expect(plugin.paired).toBe(false);
  });

  /**
   * The key is shown once and no device keeps it. That is the feature rather
   * than a gap: a device holding the root could re-derive the vault's
   * credential and register itself again after being revoked, so revoking
   * would stop nothing. The panel says so where the key used to be.
   */
  it("does not keep the recovery key, and the panel says so", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    const stored = plugin.savedData as Record<string, string>;
    expect(stored["secret"], "the root secret is on this device").toBeUndefined();
    expect(stored["deviceId"]).toMatch(/^[A-Za-z0-9_-]+$/);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const row = built.find((s) => s.name === "Recovery key")!;
    expect(panelText()).toMatch(/Not stored on this device/);
    // The description points to the user's saved copy.
    expect(panelText()).toMatch(/Keep your saved copy safe/);
    // And no button, because there is nothing for one to do.
    expect(row.buttons, "the panel offers to show a key it does not have").toEqual([]);
  }, 300_000);
});

describe("renaming this device from the panel", () => {
  /**
   * Protocol 5. The name is what the device list, a note's history and every
   * conflict copy are read by, and until now it was chosen once at pairing and
   * fixed: a typo meant unlinking and pairing again, which makes a new row.
   */
  it("renames on the server and writes it down here", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    expect(plugin.deviceName).toBe("laptop");

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const setting = built.find((s) => s.name === "This device's name")!;
    expect(setting, "the panel offers no way to rename this device").toBeDefined();
    setting.texts[0]!.type("the-good-laptop");
    await setting.buttons.find((b) => b.label === "Rename")!.click();

    // Written down here, so a restart does not undo it.
    await until("the name to change", () => plugin.deviceName === "the-good-laptop");
    expect((plugin.savedData as Record<string, string>)["device"]).toBe("the-good-laptop");

    // And on the server, which is the authority a second device reads.
    await until("it to reconnect", () => plugin.currentState.kind === "synced");
    const list = await plugin.devices();
    const mine = list.devices.find((d) => d.id === plugin.deviceId);
    expect(mine?.name, JSON.stringify(list.devices)).toBe("the-good-laptop");
  }, 300_000);

  it("is what a conflict copy made afterwards is named by", async () => {
    // The half that has to be a test rather than a comment. The engine is
    // handed `device` when it is built and reads it at every conflict copy, so
    // saving the config under a running loop renames the device list and
    // nothing else: the next copy still carries the old name, and does until
    // Obsidian restarts. Removing the `quiet`/`start` in `renameDevice` passes
    // every other test in this file, which is how this one came to exist.
    await fresh();
    const a = await load();
    a.app.vault.adapter.seed("note.md", "# Note\n\nThe original.\n");
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);

    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);
    await until("the note to arrive", () => b.app.vault.adapter.text("note.md") !== undefined);

    // b takes a new name, with its loop running, which is the case that broke.
    built.length = 0;
    b.plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const setting = built.find((s) => s.name === "This device's name")!;
    setting.texts[0]!.type("renamed-desktop");
    await setting.buttons.find((btn) => btn.label === "Rename")!.click();
    await until("the rename to land", () => b.plugin.deviceName === "renamed-desktop");
    await until("it to reconnect", () => b.plugin.currentState.kind === "synced");

    // Now diverge, so b has to keep both and name the copy after itself.
    a.app.vault.adapter.seed("note.md", "# Note\n\nA's sentence.\n", 9_000_000_000_000);
    b.app.vault.adapter.seed("note.md", "# Note\n\nB's other sentence.\n", 9_000_000_000_000);
    for (let i = 0; i < 5; i++) {
      await a.plugin.syncNow();
      await b.plugin.syncNow();
    }

    const copies = b.app.vault.adapter
      .filePaths()
      .filter((path) => path.includes("Conflicted copy"));
    expect(copies.length, `paths: ${b.app.vault.adapter.filePaths().join(", ")}`).toBeGreaterThan(
      0,
    );
    // Named for the new name, and not for the old one. Spelled as the whole
    // "Conflicted copy <name>" because `renamed-desktop` contains `desktop`:
    // a bare `not.toContain("desktop")` fails on the right answer, which is
    // how the first version of this assertion was wrong.
    expect(copies.join(" "), "a conflict copy still carries the old name").toMatch(
      /Conflicted copy renamed-desktop/,
    );
    expect(copies.join(" ")).not.toMatch(/Conflicted copy desktop\b/);
  }, 300_000);

  it("says no to an empty name and to the name it already has", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const setting = built.find((s) => s.name === "This device's name")!;

    notices.length = 0;
    setting.texts[0]!.type("   ");
    await setting.buttons.find((b) => b.label === "Rename")!.click();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/cannot be empty/i);
    expect(plugin.deviceName, "an empty name was accepted").toBe("laptop");

    notices.length = 0;
    setting.texts[0]!.type("laptop");
    await setting.buttons.find((b) => b.label === "Rename")!.click();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/already this device's name/i);
  }, 300_000);
});

describe("pairing instructions", () => {
  it("shows the required guidance without a hover or extra click", async () => {
    await fresh();
    const { plugin } = await load();
    choosePairing(plugin, "invite");
    const key = built.find((s) => s.name === "Invite or setup line")!;
    expect(key.desc).toMatch(/invite from a paired device/);
    expect(key.desc).toMatch(/saved recovery key/);
    expect(key.nameEl.children).toEqual([]);
  }, 300_000);
});

describe("syncing while it runs", () => {
  it.each(["foreground", "keepalive"])(
    "keeps %s pings out of an upload's binary body exchange",
    async (trigger) => {
      const win = new EventTarget();
      vi.stubGlobal("window", win);
      const gate = deferred();
      const entered = deferred();
      let upload: Promise<void> | undefined;
      let keepalive: Promise<void> | undefined;
      try {
        await fresh();
        const { plugin, app } = await load();
        await startVault(plugin);
        await synced(plugin);
        const client = (plugin as unknown as { client: Client }).client;
        const putMany = client.transport.putMany.bind(client.transport);
        client.transport.putMany = (entries, bodyOf, onBytes) =>
          putMany(
            entries,
            async (name) => {
              entered.resolve();
              await gate.promise;
              return bodyOf(name);
            },
            onBytes,
          );
        const ping = vi.spyOn(client.transport, "ping");
        app.vault.adapter.seed("foreground.md", "exact foreground upload\n");
        upload = plugin.syncNow();
        await within(entered.promise, "the server to request an upload body");
        if (trigger === "foreground") win.dispatchEvent(new Event("online"));
        else keepalive = (client as unknown as { keepalive(): Promise<void> }).keepalive();
        await nextTurn();
        expect(ping, "a text ping interrupted the binary upload").not.toHaveBeenCalled();
        gate.resolve();
        await upload;
        await keepalive;
        await (plugin as unknown as { resuming?: Promise<void> }).resuming;
        expect(ping).toHaveBeenCalledOnce();
        expect(client.transport.isClosed).toBe(false);
        const versions = await client.history("foreground.md", { limit: 1 });
        expect(new TextDecoder().decode(await client.contentAt(versions[0]!))).toBe(
          "exact foreground upload\n",
        );
      } finally {
        gate.resolve();
        await upload;
        await keepalive;
        vi.unstubAllGlobals();
      }
    },
  );

  it("checks for missed saves when the app returns to the foreground", async () => {
    const doc = new EventTarget();
    Object.defineProperty(doc, "visibilityState", { value: "visible" });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", new EventTarget());
    try {
      await fresh();
      const a = await load();
      await startVault(a.plugin);
      await synced(a.plugin);
      const b = await load();
      await b.plugin.pair(keyOf(a.plugin), "peer");
      await synced(b.plugin);
      a.app.vault.adapter.seed("resumed.md", "saved while the app was asleep\n");
      doc.dispatchEvent(new Event("visibilitychange"));
      await until(
        "the missed edit to arrive after resume",
        () => b.app.vault.adapter.text("resumed.md") === "saved while the app was asleep\n",
        2000,
      );
      expect(a.app.vault.adapter.text("resumed.md")).toBe("saved while the app was asleep\n");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 300_000);
  it("batches a burst of saved edits and delivers its complete final contents", async () => {
    await fresh();
    const a = await load();
    await startVault(a.plugin);
    await synced(a.plugin);
    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "peer");
    await synced(b.plugin);
    const client = (a.plugin as unknown as { client: Client }).client;
    let body = "# Saved edits\n";
    for (let burst = 0; burst < 3; burst++) {
      for (let i = 0; i < 20; i++) {
        body += `\nKept paragraph ${burst}-${i}.\n`;
        a.app.vault.adapter.seed("burst.md", body);
        a.app.vault.fire("modify", { path: "note.md" });
      }
      await until(
        "all paragraphs in the burst to arrive automatically",
        () => b.app.vault.adapter.text("burst.md") === body,
        3000,
      );
      expect(a.app.vault.adapter.text("burst.md")).toBe(body);
    }
    // Sixty saves within three event batches should not make sixty versions.
    expect(await client.history("burst.md")).toHaveLength(3);
  }, 300_000);

  it("starts syncing during a continuous stream of vault events", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin);
    await synced(plugin);
    const peer = await load();
    await peer.plugin.pair(keyOf(plugin), "peer");
    await synced(peer.plugin);
    app.vault.adapter.seed("busy.md", "a saved note during a busy vault\n");
    const events = setInterval(() => app.vault.fire("modify", { path: "note.md" }), 20);
    try {
      await until(
        "delivery while events are still arriving",
        () => peer.app.vault.adapter.text("busy.md") === "a saved note during a busy vault\n",
        3000,
      );
      expect(app.vault.adapter.text("busy.md")).toBe("a saved note during a busy vault\n");
    } finally {
      clearInterval(events);
    }
  }, 300_000);

  it("syncs when Obsidian says a file changed", async () => {
    await fresh();
    const a = await load();
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);

    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);

    // A note appears, and Obsidian says so. Nothing else prompts a sync
    // here: the 30 second backstop would not have fired yet.
    const before = a.plugin.currentState;
    a.app.vault.adapter.seed("fresh.md", "written just now");
    a.app.vault.fire("create", { path: "note.md" });

    // The nudge briefly coalesces events, so this waits for the
    // state to move rather than for a state it is already in.
    await until("A to act on the event", () => a.plugin.currentState !== before);

    // Arrival must wake B automatically, well before its 30 second backstop.
    await until(
      "B to receive the saved note",
      () => b.app.vault.adapter.text("fresh.md") === "written just now",
      8000,
    );
    expect(b.app.vault.adapter.text("fresh.md")).toBe("written just now");
  }, 300_000);

  it("says what happened when asked to sync", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    app.vault.adapter.seed("another.md", "x");
    notices.length = 0;
    // Obsidian's Command.callback returns void, so the command can only
    // start the work. Waiting for the notice is waiting for the same thing
    // a person waits for.
    await plugin.runCommand("sync-now");
    await until("the command to report", () => notices.length > 0);
    expect(notices.map((n) => n.message).join(" ")).toMatch(/sent|up to date/);
  }, 300_000);

  it("says so rather than nothing when it is not paired", async () => {
    const { plugin } = await load();
    await plugin.runCommand("sync-now");
    await until("the command to report", () => notices.length > 0);
    expect(notices.map((n) => n.message).join(" ")).toMatch(/not paired/);
  });

  /**
   * A conflict is one of two outcomes that do not resolve themselves, and a
   * status bar nobody is looking at is not how somebody finds out about it.
   */
  it("tells the user when it kept both versions", async () => {
    await fresh();
    const a = await load();
    a.app.vault.adapter.seed("note.md", "# Note\n\nThe original sentence.\n");
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);

    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);
    await until("the note to arrive", () => b.app.vault.adapter.text("note.md") !== undefined);

    a.app.vault.adapter.seed(
      "note.md",
      "# Note\n\nA's completely different sentence.\n",
      9_000_000_000_000,
    );
    b.app.vault.adapter.seed(
      "note.md",
      "# Note\n\nB's entirely other sentence.\n",
      9_000_000_000_000,
    );
    notices.length = 0;
    for (let i = 0; i < 5; i++) {
      await a.plugin.syncNow();
      await b.plugin.syncNow();
    }

    const all = b.app.vault.adapter
      .filePaths()
      .filter((p) => !p.startsWith(".obsidian/"))
      .map((p) => b.app.vault.adapter.text(p))
      .join("\n");
    expect(all).toContain("A's completely different sentence");
    expect(all).toContain("B's entirely other sentence");
    const said = notices.map((n) => n.message).join(" ");
    expect(said, `notices were: ${said}`).toMatch(/Conflicted copy/);
  }, 300_000);
});

describe("when things go wrong", () => {
  it("skips deferred tabs and saves loaded editor buffers before Sync now completes", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin);
    await synced(plugin);
    app.workspace.markdownLeaves.push({ isDeferred: true, view: {} });
    app.workspace.markdownLeaves.push({
      view: {
        save: async () =>
          app.vault.adapter.write("draft.md", "the paragraph still in the editor\n"),
      },
    });
    await plugin.syncNow();
    const peer = await load();
    await peer.plugin.pair(keyOf(plugin), "peer");
    await synced(peer.plugin);
    expect(peer.app.vault.adapter.text("draft.md")).toBe("the paragraph still in the editor\n");
  });

  it("does not report Sync now as successful when the editor cannot save", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin);
    await synced(plugin);
    app.workspace.markdownLeaves.push({
      view: {
        save: async () => {
          throw new Error("editor disk full");
        },
      },
    });
    notices.length = 0;
    await plugin.syncNow();
    expect(plugin.currentState.kind).toBe("failed");
    expect(notices.some((n) => n.message.includes("editor disk full"))).toBe(true);
    expect(notices.some((n) => n.message === "Telimus: up to date")).toBe(false);
  });

  it("shows one busy action and one result for repeated manual sync requests", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin);
    await synced(plugin);
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const button = built.find((s) => s.name === "Sync status")!.buttons[0]!;
    const client = (plugin as unknown as { client: Client }).client;
    const list = client.vault.list.bind(client.vault);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.vault.list = async () => {
      await gate;
      return list();
    };
    notices.length = 0;
    const first = plugin.syncNow();
    const second = plugin.syncNow();
    try {
      expect(button.label).toBe("Syncing…");
      expect(button.disabled).toBe(true);
      release();
      await Promise.all([first, second]);
      expect(notices.filter((n) => n.message === "Telimus: up to date")).toHaveLength(1);
      expect(button.label).toBe("Sync now");
      expect(button.disabled).toBe(false);
      expect(app.vault.adapter.filePaths().filter((p) => !p.startsWith(".obsidian/"))).toEqual([]);
    } finally {
      release();
      await Promise.all([first, second]);
      client.vault.list = list;
    }
  }, 300_000);

  it("retries the connection immediately when Sync now is pressed offline", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const port = server.port;
    await server.stop();
    await until("the disconnect", () => plugin.currentState.kind === "offline");
    app.vault.adapter.seed("offline.md", "saved while offline\n");
    await server.start(port);
    await plugin.syncNow();
    await until(
      "manual retry to reconnect before backoff expires",
      () => plugin.currentState.kind === "synced",
      1500,
    );
    const peer = await load();
    await peer.plugin.pair(keyOf(plugin), "peer");
    await until(
      "the offline edit to reach the peer",
      () => peer.app.vault.adapter.text("offline.md") === "saved while offline\n",
    );
    expect(app.vault.adapter.text("offline.md")).toBe("saved while offline\n");
  }, 300_000);

  it("shows sustained sync activity even when individual paths finish quickly", async () => {
    const { plugin } = await load();
    const subject = plugin as unknown as {
      working(path: string | undefined): void;
      setState(state: unknown): void;
    };
    subject.setState({
      kind: "synced",
      summary: "up to date",
      at: Date.now(),
      refused: 0,
      waiting: 0,
    });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 8; i++) {
        subject.working(`note-${i}.md`);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(plugin.currentState.kind).toBe("syncing");
      expect(statusIcon(plugin)).toBe("refresh-cw");
    } finally {
      subject.working(undefined);
      vi.useRealTimers();
    }
  });

  /**
   * A dead connection has to be forgotten, not just noticed.
   *
   * The loop clears the client when a connection ends. If it did not, "sync
   * now" would reach for a socket that is gone: the person would get an
   * exception rather than a sentence, and the plugin would look broken rather
   * than offline.
   */
  it("says it is offline rather than reaching for a dead connection", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    await server.cleanup();
    await until("it to notice", () => plugin.currentState.kind === "offline");

    notices.length = 0;
    await plugin.syncNow();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/reconnecting/);
    await until(
      "the unsuccessful retry to report offline",
      () => plugin.currentState.kind === "offline",
    );
    expect(statusIcon(plugin)).toBe("cloud-off");
    expect(status(plugin)).toMatch(/^Telimus Sync: Offline:/);
  }, 300_000);

  /**
   * A file the server will refuse for the same reason every time.
   *
   * The engine stops retrying it, which is right: retrying forever is noise
   * that hides everything else. But a file that will never sync and nobody
   * mentions is a note quietly left behind, so it is said out loud. This uses
   * a path past the server's limit, which is the cheapest permanent refusal
   * there is.
   */
  it("says out loud when a file can never sync", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("fine.md", "this one is ok");
    app.vault.adapter.seed(`${"x".repeat(4800)}.md`, "this one is not");

    await startVault(plugin, "laptop");
    // One overlong path exercises the real server refusal without creating
    // and syncing 1,200 parent folders first.
    await synced(plugin);
    // Said once, when the refusal first appears, so it is looked for
    // rather than provoked again.
    await until("the refusal to be announced", () =>
      notices.some((n) => /cannot sync/.test(n.message)),
    );
    await plugin.syncNow();
    // And the refusal did not stop the file that was fine, and the status
    // says the vault needs a person. One phrase, not three: "stuck",
    // "ignored" and "in the way" were three words a person had to learn before
    // the status could be read, and what differs between them is the reason,
    // which the notice above carries.
    expect(status(plugin)).toMatch(/1 file needs attention\./);
  }, 300_000);
});

describe("recovering a deleted note from the app", () => {
  it("lists what the server still has, and puts one back", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("keep.md", "still here");
    app.vault.adapter.seed("gone.md", "# Gone\n\nBut not forgotten.\n");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    expect(app.vault.adapter.text("gone.md")).toBeUndefined();

    built.length = 0;
    notices.length = 0;
    await plugin.runCommand("recover-deleted");
    await until(
      "the list to load",
      () => built.some((setting) => setting.name === "gone.md"),
      15_000,
    );
    const row = built.find((s) => s.name === "gone.md");
    expect(row, `the modal said: ${modals.at(-1)!.contentEl.allText()}`).toBeDefined();
    expect(built.map((s) => s.name)).not.toContain("keep.md");
    await row!.buttons[0]!.click();

    await until("the note to come back", () => app.vault.adapter.text("gone.md") !== undefined);
    expect(app.vault.adapter.text("gone.md")).toBe("# Gone\n\nBut not forgotten.\n");
    expect(notices.map((n) => n.message).join(" ")).toMatch(/Restored/);
  }, 300_000);

  it("says nothing has been deleted when nothing has", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("keep.md", "here");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await plugin.runCommand("recover-deleted");
    await until("the list to load", () =>
      modals.at(-1)!.contentEl.allText().includes("No deleted notes to restore"),
    );
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/No deleted notes to restore/);
  }, 300_000);

  /**
   * An empty list and an unanswerable question look identical on screen and
   * mean opposite things. Somebody opening this has already lost a note.
   */
  it("says it could not ask, rather than showing an empty list", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    await server.cleanup();
    await until("it to notice", () => plugin.currentState.kind === "offline");

    await plugin.runCommand("recover-deleted");
    await until("the modal to answer", () =>
      modals.at(-1)!.contentEl.allText().includes("Cannot ask"),
    );
    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toMatch(/Cannot ask the server/);
    expect(shown).not.toMatch(/No deleted notes to restore/);
  }, 300_000);
});

describe("renames, which only Obsidian can report", () => {
  /**
   * A rename has to travel as one operation.
   *
   * A filesystem scan cannot see one: it finds a path gone and another
   * arrived and has nothing connecting them, which is why the headless client
   * reports a rename as a deletion. Obsidian does know, and hands the old path
   * to its rename event, and until that was wired up the engine was never told
   * either. Every rename then retired the old path as a deletion, and the list
   * of deleted notes filled with phantoms of files that still exist.
   */
  it("tells the engine the old path, so it is one operation and not two", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("old-name.md", "the same content throughout");
    await startVault(plugin, "laptop");
    await synced(plugin);

    // Obsidian moves the file and says so, old path included.
    await app.vault.adapter.rename("old-name.md", "new-name.md");
    app.vault.fire("rename", { path: "new-name.md" }, "old-name.md");
    for (let i = 0; i < 4; i++) await plugin.syncNow();

    // The server knows it was a rename, so the old path is not offered as
    // something to recover.
    const client = (
      plugin as unknown as { client?: { deleted(): Promise<{ notes: { path: string }[] }> } }
    ).client;
    const gone = (await client!.deleted()).notes.map((v) => v.path);
    expect(gone, `deleted list was ${JSON.stringify(gone)}`).not.toContain("old-name.md");
  }, 300_000);

  it("still moves the file when nothing told it the old path", async () => {
    // The delete-plus-add path, which is what happens on any platform that
    // cannot report a rename. Noisier, and it must still not lose anything.
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("before.md", "content that moves");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await app.vault.adapter.rename("before.md", "after.md");
    await plugin.syncNow();
    await plugin.syncNow();

    const client = (
      plugin as unknown as { client?: { deleted(): Promise<{ notes: { path: string }[] }> } }
    ).client;
    const gone = (await client!.deleted()).notes.map((v) => v.path);
    expect(gone).toContain("before.md");
    expect(app.vault.adapter.text("after.md")).toBe("content that moves");
  }, 300_000);
});

describe("unlinking", () => {
  it("coalesces overlapping unlink requests before another pairing can begin", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clears = 0;
    const save = plugin.saveData.bind(plugin);
    plugin.saveData = async (value: unknown) => {
      if (value === null) {
        clears++;
        await gate;
      }
      await save(value);
    };
    const first = plugin.unlink();
    const second = plugin.unlink();
    try {
      await until("unlink to reach the settings file", () => clears > 0);
      await nextTurn();
      expect(clears, "two unlink operations can erase settings after the first one returns").toBe(
        1,
      );
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(plugin.savedData).toBe(null);
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });

  it("forgets the pairing and keeps every note", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("keep.md", "still here");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/telimus/index.json");

    await plugin.unlink();
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
    expect(statusIcon(plugin)).toBe("link");
    expect(status(plugin)).toBe("Telimus Sync: Not paired.");
    expect(app.vault.adapter.text("keep.md")).toBe("still here");

    // The index goes too. It records what this device believes it has
    // already synced, and left behind it would be read as fact by the next
    // pairing, possibly against a different server entirely.
    expect(app.vault.adapter.filePaths()).not.toContain(".obsidian/plugins/telimus/index.json");
  }, 300_000);

  /**
   * Unlinking and pairing again has to be a genuinely fresh start.
   *
   * This is the failure the stale index would cause: a cursor and a set of
   * entries from the old pairing, read as the truth about a server that has
   * never seen this device, so notes that were never uploaded are treated as
   * already sent.
   */
  it("starts clean when paired again afterwards", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "the only note");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await plugin.unlink();

    // A different server, which has never heard of this device.
    const second = new TestServer();
    await second.start();
    try {
      await startVault(plugin, "laptop-again", second.setup);
      await synced(plugin);
      await plugin.syncNow();

      // The note must have been uploaded to the new server, not assumed
      // to be there already.
      const elsewhere = await load();
      await elsewhere.plugin.pair(keyOf(plugin), "other");
      await synced(elsewhere.plugin);
      await until(
        "the note to arrive",
        () => elsewhere.app.vault.adapter.text("note.md") !== undefined,
      );
      expect(elsewhere.app.vault.adapter.text("note.md")).toBe("the only note");
    } finally {
      await second.cleanup();
    }
  }, 300_000);
});

describe("the panel, which is a modal and a settings tab", () => {
  /**
   * The panel has to be in Settings, and this is the test that says so.
   *
   * It was reachable from the ribbon, the status bar and the command palette,
   * and nowhere else, because the plugin registered no settings tab. Obsidian
   * draws a plugin's gear in Settings only for a plugin that calls
   * `addSettingTab`, so Settings had no Telimus entry at all and somebody
   * looking for the plugin's interface where every other plugin keeps it
   * found nothing and concluded there was none. Reported by the one person
   * running it, who could not find the settings screen.
   *
   * Registering it is the fix, and drawing the same panel is the point: no
   * options were added to earn the place.
   */
  it("is in Obsidian's settings, drawing the same rows as the modal", async () => {
    const { plugin } = await load();
    expect(
      plugin.settingTabs.length,
      "the plugin registers no settings tab, so Settings shows no Telimus entry at all",
    ).toBe(1);

    const tab = plugin.settingTabs[0]!;
    built.length = 0;
    tab.display();
    const inTab = built.map((s) => s.name);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const inModal = built.map((s) => s.name);

    expect(inTab, "the settings tab drew nothing").not.toEqual([]);
    expect(inTab, "the tab and the modal are different panels").toEqual(inModal);

    // And it tears down, because Obsidian calls hide on the way out and a tab
    // that kept its state watcher would add one every time Settings opened.
    tab.hide();
    expect(tab.containerEl.children).toEqual([]);
  }, 300_000);

  it("asks for one string and works out the rest from it", async () => {
    // Two designs failed here before this one. Both forms at once was the
    // first: a name, an invite and Pair, then "Or start a new vault", a setup
    // string and Start a new vault. Everything needed was there and nothing
    // said which half was yours, reported from a phone.
    //
    // Asking first fixed that and cost a whole screen whose only content was
    // the question. An invite starts basalt3i_, a recovery key basalt3_, and a
    // setup line is neither, so the string answers it and nobody has to.
    const { plugin } = await load();
    plugin.commands.find((c) => c.id === "show-status")!.callback!();

    const asked = built.map((s) => s.name);
    // The form, immediately, with no question in front of it.
    expect(asked).toContain("Invite or setup line");
    expect(asked).not.toContain("Join an existing vault");
    expect(asked).not.toContain("Set up a new vault");

    // What to paste is a description and not a `?`. That was the original
    // defect: on a phone there is no hover, so guidance behind a mark is not
    // reachable at all. Read off the row rather than out of `allText`, because
    // the fake keeps a description as a property.
    const row = built.find((s) => s.name === "Invite or setup line")!;
    // All three shapes the one field takes, so nobody holding a recovery key
    // has to guess whether this is the place for it.
    expect(row.desc).toMatch(/invite from a paired device/i);
    expect(row.desc).toMatch(/recovery key/i);
    expect(row.desc).toMatch(/setup line from your server/i);
    expect(row.nameEl.children.filter((c) => c.cls === "telimus-help")).toEqual([]);

    // One field holding the line the server printed, rather than a Server and
    // a Token to split it into by hand.
    expect(asked).not.toContain("Server");
    expect(asked).not.toContain("Token");

    // The two things with working answers are present but not in the way. They
    // are still on this screen: the skip list has to be answerable before the
    // download starts, not after it (Codex-05).
    expect(asked).toContain("Device name");
    expect(asked).toContain("Skip on this device");

    // No options anywhere in it. docs/design.md refuses a settings
    // screen, and this is the thing that would quietly become one.
    expect(asked.filter((n) => n.toLowerCase().includes("enable"))).toEqual([]);
  });

  it("pairs from what was typed into it", async () => {
    await fresh();
    const first = await load();
    const pairing = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    choosePairing(second.plugin, "invite");

    built.find((s) => s.name === "Device name")!.texts[0]!.type("desktop");
    built.find((s) => s.name === "Invite or setup line")!.texts[0]!.type(pairing);
    await built
      .find((s) => s.buttons.some((b) => b.label === "Pair"))!
      .buttons.find((b) => b.label === "Pair")!
      .click();

    expect(second.plugin.paired).toBe(true);
    expect(second.plugin.deviceName).toBe("desktop");
    await synced(second.plugin);
  }, 300_000);

  /**
   * The invite row and the device list, in that order, because they are one
   * subject: an invite is how a row appears in the list, and a row in the list
   * is what can be cut off.
   */
  it("offers an invite and device access management", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const adding = built.find((s) => s.name === "Add another device")!;
    expect(adding, "the panel offers no way to add a device").toBeDefined();
    expect(adding.buttons.map((b) => b.label)).toContain("Create invite");
    expect(adding.desc).toMatch(/one-time invite/);
    expect(adding.desc).toMatch(/Expires in 10 minutes/);
    const row = built.find((s) => s.name === "Devices")!;
    expect(row, "the panel has no device list").toBeDefined();
    expect(row.desc).toMatch(/manage their access/);

    built.length = 0;
    await row.buttons[0]!.click();
    await until("the list to arrive", () =>
      built.some((s) =>
        /Received latest changes|delivery unconfirmed|Waiting for latest changes|Never connected/.test(
          s.desc,
        ),
      ),
    );
    const listed = built.find((s) => s.name.startsWith("laptop"))!;
    expect(listed.name).toMatch(/\(this device\)/);
    // No button on it, because it is the vault's only device and emptying the
    // vault takes the recovery key. What the panel offers instead is in "the
    // device list in the panel", below; the row with a Revoke button on it is
    // there too.
    expect(listed.buttons).toEqual([]);
  }, 300_000);

  it("does not rebuild a closed panel when a settings request finishes", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin);
    await synced(plugin);
    const watching = vi.spyOn(plugin, "watchState");
    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const panel = modals.at(-1)!;
    const row = built.find((setting) => setting.name === "This device's name")!;
    row.texts[0]!.type("new name");
    let finish!: (name: string) => void;
    const request = new Promise<string>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(plugin, "renameDevice").mockReturnValueOnce(request);
    const renaming = row.buttons[0]!.click();
    panel.close();
    watching.mockClear();
    finish("new name");
    await renaming;
    expect(
      panel.contentEl.children,
      "a completed request rebuilt a detached settings panel",
    ).toEqual([]);
    expect(
      watching,
      "the closed panel subscribed again without another teardown",
    ).not.toHaveBeenCalled();
  });

  it("shows what is happening once it is paired", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const names = built.map((s) => s.name);
    expect(names).toContain("Sync status");
    expect(names).toContain("Devices");
    expect(names).toContain("Recovery key");
    expect(names).toContain("Unlink this vault");
  }, 300_000);

  /**
   * The rare rows behind a press, and the everyday ones not.
   *
   * design.md: a thing that matters only when something specific happens
   * appears in that moment. Devices, the recovery key, replacing the secret
   * and unlinking are rare and three of the four cannot be undone, so they are
   * inside a `<details>`. A `<details>` and not a tab or a second modal
   * because it needs no code and holds no state, which is the whole reason the
   * panel can be the whole interface.
   *
   * Pairing, server details and management each have a named disclosure.
   * Only sync and recovery actions are visible by default.
   */
  it("puts the rare rows behind one disclosure and leaves the everyday ones out", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const disclosures = modals.at(-1)!.contentEl.children.filter((el) => el.tag === "details");
    const adding = disclosures.find((el) => el.children[0]?.text === "Add another device");
    expect(adding, "adding a device needs its own collapsed section").toBeDefined();
    expect(adding!.attributes.has("open")).toBe(false);
    expect(
      containsElement(adding!, built.find((s) => s.name === "Add another device")!.settingEl),
    ).toBe(true);
    const primaryRows = built.filter(
      (s) => !disclosures.some((d) => containsElement(d, s.settingEl)),
    );
    expect(primaryRows.flatMap((s) => s.buttons.map((b) => b.label))).toEqual([
      "Sync now",
      "Browse deleted",
    ]);
    const manage = disclosures.find((el) => el.children[0]?.text === "Manage this vault")!;
    expect(manage, "the panel has no Manage disclosure").toBeDefined();
    expect(manage.children[0]!.tag).toBe("summary");
    // And the numbers are behind the other one, not loose at the top.
    const server = disclosures.find((el) => el.children[0]?.text?.startsWith("Server"));
    expect(server, "the server numbers are not behind a disclosure").toBeDefined();
    expect(disclosures.indexOf(adding!)).toBeLessThan(disclosures.indexOf(server!));

    const inside = (name: string): boolean =>
      containsElement(manage, built.find((s) => s.name === name)!.settingEl);
    for (const row of [
      "Devices",
      "Recovery key",
      "Replace the vault's secret",
      "Unlink this vault",
    ])
      expect(inside(row), `"${row}" is on the everyday panel`).toBe(true);
    for (const row of ["Sync status", "Add another device", "Recover a deleted note"])
      expect(inside(row), `"${row}" is behind the disclosure`).toBe(false);

    // And the way out of the panel for anybody who wants the rest of it, which
    // is where the four hundred words that used to be on screen went.
    const links = modals
      .at(-1)!
      .contentEl.children.flatMap((el) => el.children)
      .filter((el) => el.tag === "a");
    expect(links.map((el) => el.attributes.get("href"))).toContain(
      "https://github.com/waynehoover/telimus/blob/main/docs/plugin.md",
    );
  }, 300_000);

  it("says what went wrong rather than failing quietly", async () => {
    const { plugin } = await load();
    choosePairing(plugin, "invite");
    built
      .find((s) => s.name === "Invite or setup line")!
      .texts[0]!.type("this is not a pairing string");
    notices.length = 0;
    const pair = built
      .find((s) => s.buttons.some((b) => b.label === "Pair"))!
      .buttons.find((b) => b.label === "Pair")!;
    // On screen, where the string was typed, and the button is not offered:
    // pairing points a vault at a server, so nothing is pressable until the
    // panel can say which one (R083-05).
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/basalt3_/);
    expect(pair.disabled).toBe(true);
    await pair.click();
    expect(plugin.paired).toBe(false);
  });

  it("carries a skip list chosen before pairing into the vault it pairs", async () => {
    // Pairing starts the download the moment it finishes, and the exclusion
    // controls used to exist only in the paired panel: adding a phone to a
    // vault holding gigabytes of attachments meant racing your own sync to the
    // settings screen (Codex-05).
    const { plugin } = await load();
    choosePairing(plugin, "invite");
    const skip = built.find((s) => s.name === "Skip on this device")!;
    skip.texts[0]!.type("Attachments");
    await skip.buttons.find((b) => b.label === "Skip")!.click();

    let carried: readonly string[] | undefined;
    plugin.pair = async (_key, _device, _merge, ignore) => {
      carried = ignore;
    };
    built
      .find((s) => s.name === "Invite or setup line")!
      .texts[0]!.type(
        formatInvite({
          url: "wss://homelab.example.ts.net",
          vaultId: "default",
          id: new Uint8Array(INVITE_ID_LENGTH).fill(3),
          key: new Uint8Array(INVITE_KEY_LENGTH).fill(4),
        }),
      );
    await built
      .find((s) => s.buttons.some((b) => b.label === "Pair"))!
      .buttons.find((b) => b.label === "Pair")!
      .click();

    expect(carried, "the skip list did not reach the pairing").toEqual(["Attachments"]);
  });

  it("names the vault and server an invite would join, before pairing", async () => {
    const { plugin } = await load();
    choosePairing(plugin, "invite");
    const field = built.find((s) => s.name === "Invite or setup line")!.texts[0]!;
    const pair = () =>
      built
        .find((s) => s.buttons.some((b) => b.label === "Pair"))!
        .buttons.find((b) => b.label === "Pair")!;
    expect(pair().disabled, "nothing typed, so nothing to join").toBe(true);

    field.type(
      formatInvite({
        url: "wss://someone-elses.example.org",
        vaultId: "their-vault",
        id: new Uint8Array(INVITE_ID_LENGTH).fill(7),
        key: new Uint8Array(INVITE_KEY_LENGTH).fill(9),
      }),
    );
    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toContain("their-vault");
    expect(shown).toContain("wss://someone-elses.example.org");
    expect(pair().disabled).toBe(false);

    // A vault nobody named is not named back. "default" is the value assumed
    // when a string carries none, and the server leaves it out of a setup line
    // for the same reason: it is a default, not a choice, and quoting it here
    // reads as a placeholder that leaked into the one line somebody is meant
    // to check the server address on.
    field.type(
      formatInvite({
        url: "wss://homelab.example.ts.net",
        vaultId: DEFAULT_VAULT,
        id: new Uint8Array(INVITE_ID_LENGTH).fill(7),
        key: new Uint8Array(INVITE_KEY_LENGTH).fill(9),
      }),
    );
    const plain = modals.at(-1)!.contentEl.allText();
    expect(plain).toContain("wss://homelab.example.ts.net");
    expect(plain).not.toContain("default");
    expect(pair().disabled, "still perfectly joinable").toBe(false);
  });
});

describe("measuring where a pass spent its time", () => {
  it("writes nothing at all unless the log file is already there", async () => {
    // The file's existence is the whole switch. A plugin that wrote timings
    // because it could would be a permanent cost for a question asked once
    // (docs/open-work.md).
    const { plugin, app } = await load();
    await plugin.syncNow();
    expect(
      app.vault.adapter.text(".obsidian/plugins/telimus-sync/pass-timings.ndjson"),
      "a measurement nobody asked for",
    ).toBeUndefined();
  });

  it("records the first event of a batch, not the last", async () => {
    // Several saves coalesce into one pass. The last would understate what
    // somebody waited, and an average would describe nobody.
    const { plugin } = await load();
    plugin.measuringFrom = undefined;
    const nudge = (plugin as unknown as { nudge(path?: string): void }).nudge.bind(plugin);
    nudge("a.md");
    const first = plugin.measuringFrom;
    expect(first, "the first event was not marked").toBeDefined();
    nudge("b.md");
    expect(plugin.measuringFrom, "a later event moved the mark").toBe(first);
  });
});

describe("a version kept where Obsidian cannot see it", () => {
  it("can be recovered from the panel, without disturbing the hidden copy", async () => {
    // Preservation parks bytes under a hidden name when it cannot place them
    // beside the note, and that was the end of the story: the panel said it
    // had happened and nothing could act on it, so getting them back meant a
    // file manager on a device that has none. Sometimes it is the only
    // surviving copy of the note (Codex-08).
    const { plugin, app } = await load();
    const hidden = "Notes/.telimus-tmp-review/Note.md";
    app.vault.adapter.seed(hidden, "the paragraph that was displaced\n");
    app.vault.adapter.seed("Notes/Note.md", "what replaced it\n");

    const at = await plugin.recoverDisplaced({
      at: hidden,
      from: "Notes/Note.md",
      why: "a save raced the write",
      when: 1,
    });

    // Beside, never over: the name that displaced it is untouched.
    expect(at).not.toBe("Notes/Note.md");
    expect(app.vault.adapter.text("Notes/Note.md")).toBe("what replaced it\n");
    expect(app.vault.adapter.text(at)).toBe("the paragraph that was displaced\n");
    // And the hidden copy stays. Removing it is the one destructive step in a
    // recovery path and there is no "it worked" worth that risk.
    expect(app.vault.adapter.text(hidden)).toBe("the paragraph that was displaced\n");
  });
});

describe("on a device with no status bar", () => {
  it("shows a connected phone loading history before it can sync notes", async () => {
    await fresh();
    const desktop = await load();
    desktop.app.vault.adapter.seed("note.md", "keep this note\n");
    await startVault(desktop.plugin);
    await synced(desktop.plugin);
    const invite = await desktop.plugin.createInvite();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let accepting = false;
    const accept = Engine.prototype.acceptBatch;
    const held = vi.spyOn(Engine.prototype, "acceptBatch").mockImplementationOnce(async function (
      this: Engine,
      batch,
    ) {
      accepting = true;
      await gate;
      await accept.call(this, batch);
    });
    const phone = await load();
    try {
      await phone.plugin.pair(invite.invite, "Phone");
      await until("the phone to receive history", () => accepting);
      expect(phone.plugin.currentState.kind).toBe("loading");
      expect(phone.plugin.connection()?.server?.proto).toBe(PROTO);
      expect(phone.plugin.cursors()).toEqual({ local: 0, server: 1 });
      built.length = 0;
      phone.plugin.commands.find((c) => c.id === "show-status")!.callback!();
      expect(built.find((s) => s.name === "Sync status")!.descEl.allText()).toMatch(
        /Loading sync history/,
      );
      expect(modals.at(-1)!.contentEl.allText()).not.toMatch(/Not connected|allow-origin/);
      const serverDetails = modals
        .at(-1)!
        .contentEl.children.find((el) => el.cls === "telimus-server")!;
      expect(serverDetails.attributes.has("open"), "normal loading expanded diagnostics").toBe(
        false,
      );
      await phone.plugin.syncNow();
      expect(notices.at(-1)!.message).toMatch(/loading.*history/i);
    } finally {
      release();
      held.mockRestore();
    }
    await synced(phone.plugin);
    expect(await phone.app.vault.adapter.read("note.md")).toBe("keep this note\n");
  });

  /**
   * Obsidian mobile has no status bar, so `addStatusBarItem` returns an
   * element nothing displays and the plugin's only ongoing feedback is the
   * plugin talking to itself. The ribbon is on both, so the state goes there
   * too, as the tooltip somebody gets by holding the icon.
   */
  it("puts the state on the ribbon as well", async () => {
    await fresh();
    const { plugin } = await load();
    const ribbon = plugin.ribbonIcons[0]!;
    expect(ribbon.title).toBe("Telimus Sync");

    await startVault(plugin, "laptop");
    await synced(plugin);

    // The same sentence the status bar carries, somewhere a phone shows it.
    const label = ribbon.el.attributes.get("aria-label") ?? "";
    expect(label, `the ribbon says ${JSON.stringify(label)}`).toMatch(/^Telimus: /);
    expect(label).not.toMatch(/connecting/);
    expect(ribbon.el.attributes.get("data-icon")).toBe("cloud-check");
  }, 300_000);

  /**
   * A server refuses a browser origin it does not know, and the only thing
   * that knows this device's origin is this device. The mobile origins in the
   * server's list are Capacitor's documented defaults and have never been
   * checked against a device, so an offline phone has to be able to say what
   * to add rather than leaving somebody guessing.
   */
  it("says what to allow when it has never got through", async () => {
    // A server that is not there looks the same as one that refuses this
    // origin, and this plugin cannot tell them apart, so the advice is
    // offered while nothing has ever connected. A paired phone that comes up
    // with the server unreachable is that: joining a vault reaches the server
    // by definition, and this is the next time it tries.
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const saved = first.plugin.savedData;
    first.plugin.onunload();
    await first.plugin.closing;
    await server.cleanup();

    const { plugin } = await load(saved);
    await until("it to notice", () => plugin.currentState.kind === "offline");

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    await until("the modal to say so", () =>
      modals.at(-1)!.contentEl.allText().includes("-allow-origin"),
    );
    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toMatch(/allow-origin/);
    expect(shown, "it did not say what this device's origin actually is").toMatch(/origin is \S+/);
  }, 300_000);

  /**
   * A connection that was up and went is network loss, and
   * the origin was demonstrably fine. Advice about it on every offline state
   * sent people to restart a server that had nothing wrong with it.
   */
  it("says nothing about origins when a working connection is lost", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    await server.cleanup();
    await until("it to notice", () => plugin.currentState.kind === "offline");

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    expect(modals.at(-1)!.contentEl.allText()).not.toMatch(/allow-origin/);
  }, 300_000);

  it("says nothing about origins while it is working", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    expect(modals.at(-1)!.contentEl.allText()).not.toMatch(/allow-origin/);
  }, 300_000);
});

describe("saying what it is working on", () => {
  it.each(["upload", "download"] as const)(
    "shows %s bytes while the transfer is still pending",
    async (direction) => {
      await fresh();
      const a = await load();
      await startVault(a.plugin, "sender");
      await synced(a.plugin);
      const b = await load();
      await b.plugin.pair(keyOf(a.plugin), "receiver");
      await synced(b.plugin);
      const subject = direction === "upload" ? a.plugin : b.plugin;
      const client = (subject as unknown as { client: Client }).client;
      const wire = client.transport;
      const putMany = wire.putMany.bind(wire);
      const fetch = wire.fetch.bind(wire);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      if (direction === "upload")
        wire.putMany = async (...args) => {
          const result = await putMany(...args);
          await gate;
          return result;
        };
      else
        wire.fetch = async (...args) => {
          const result = await fetch(...args);
          await gate;
          return result;
        };
      subject.commands.find((c) => c.id === "show-status")!.callback!();
      const row = built.filter((s) => s.name === "Sync status").at(-1)!;
      const original = "Exact attachment content while a transfer waits.\n";
      a.app.vault.adapter.seed("attachment.pdf", original);
      const sending = a.plugin.syncNow();
      try {
        await until(
          "visible transfer progress",
          () => {
            const state = subject.currentState;
            return state.kind === "syncing" && state.transfer?.direction === direction;
          },
          10_000,
        );
        const state = subject.currentState;
        if (state.kind !== "syncing") throw new Error("not syncing");
        expect(state.transfer!.bytes).toBeGreaterThan(0);
        expect(state.transfer!.path).toBe("attachment.pdf");
        expect(row.descEl.allText()).toMatch(
          direction === "upload"
            ? /Uploading attachment\.pdf… .* sent\./
            : /Downloading attachment\.pdf… .* received\./,
        );
        expect(row.descEl.allText()).not.toMatch(/%|up to date/i);
        expect(row.buttons[0]!.disabled).toBe(true);
        expect(subject.deliveryReady).toBe(false);
        release();
        await sending;
        await until(
          "exact attachment landing",
          () => b.app.vault.adapter.text("attachment.pdf") === original,
        );
        await until("completed sync status", () => subject.currentState.kind === "synced");
        expect(a.app.vault.adapter.text("attachment.pdf")).toBe(original);
        expect(b.app.vault.adapter.text("attachment.pdf")).toBe(original);
        expect(row.buttons[0]!.disabled).toBe(false);
      } finally {
        release();
        await sending;
        wire.putMany = putMany;
        wire.fetch = fetch;
      }
    },
    300_000,
  );

  /**
   * A large attachment is minutes inside one pass. Without a state for it the
   * status shows the previous pass's result the whole time, so working and
   * idle look exactly alike, which is rule 7 with the two conditions that
   * matter most collapsed.
   *
   * Preparation is activity too, before any transfer bytes exist to report.
   */
  it("reports the file it is on, once it has been on it a while", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    const seen: string[] = [];
    const stop = plugin.watchState((s) => {
      if (s.kind === "syncing" && s.path !== undefined) seen.push(s.path);
    });

    // Incompressible and large enough that sealing it reliably outlasts the
    // threshold. A compressible file seals in a few milliseconds and the
    // state never fires, which made an earlier version of this pass or fail
    // depending on how loaded the machine was.
    const big = new Uint8Array(24 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
    }
    await app.vault.adapter.writeBinary("big.bin", big.buffer as ArrayBuffer, { mtime: 5000 });

    const syncing = plugin.syncNow();
    // Watched while it runs rather than checked afterwards, because by the
    // time it finishes the state has moved on to the result.
    await until("it to say what it is working on", () => seen.length > 0, 60_000);
    await syncing;
    stop();

    expect(seen).toContain("big.bin");
    // And it ends on a result rather than stuck saying it is working.
    expect(plugin.currentState.kind).toBe("synced");
  }, 300_000);

  /**
   * A pass over a settled vault visits every path and does nothing to any of
   * them. Reporting each one would replace a useful summary with a blur.
   */
  it("says nothing while passing over a vault with nothing to do", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("a.md", "one");
    app.vault.adapter.seed("b.md", "two");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await plugin.syncNow();

    const seen: string[] = [];
    const stop = plugin.watchState((s) => {
      if (s.kind === "syncing" && s.path !== undefined) seen.push(s.path);
    });
    await plugin.syncNow();
    stop();
    expect(seen, `a quiet pass announced ${JSON.stringify(seen)}`).toEqual([]);
  }, 300_000);
});

/**
 * Every socket the plugin opens, so a test can see whether one is still open.
 *
 * The plugin uses the platform's WebSocket, and this wraps it for the duration
 * of a test. `readyState` 2 and 3 are closing and closed, per the standard.
 */
function recordSockets(): { sockets: WebSocket[]; restore: () => void } {
  const Real = globalThis.WebSocket;
  const sockets: WebSocket[] = [];
  class Recording extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  }
  globalThis.WebSocket = Recording as typeof WebSocket;
  return {
    sockets,
    restore: () => {
      globalThis.WebSocket = Real;
    },
  };
}

/** Hold the handshake's index read until the test explicitly resumes it. */
function holdIndexLoad(plugin: Testable, app: App) {
  const adapter = app.vault.adapter;
  const realExists = adapter.exists.bind(adapter);
  const began = deferred();
  const gate = deferred();
  let held = false;
  const runs = vi.spyOn(
    plugin as unknown as { runLoop(config: unknown, generation: number): Promise<void> },
    "runLoop",
  );
  adapter.exists = async (path: string) => {
    if (path.endsWith("/index.json") && !held) {
      held = true;
      began.resolve();
      await gate.promise;
    }
    return realExists(path);
  };
  return {
    began: began.promise,
    release: gate.resolve,
    finished: () => runs.mock.results[0]!.value,
  };
}

/**
 *  A run inside `connect` used to survive `unlink`:
 * the shell was handed the client only once the handshake had succeeded, so
 * a vault unlinked during a slow handshake had nothing to close, and the
 * connection went on to complete with the old secret. The two tests this
 * replaces asserted that a counter had moved, which is not the property.
 */
describe("unlinking during the handshake", () => {
  it("closes the connecting client, and nothing of the old pairing is written afterwards", async () => {
    await fresh();
    const { sockets, restore } = recordSockets();
    try {
      const { plugin, app } = await load();
      app.vault.adapter.seed("secret-note.md", "must never reach the old server after unlink");
      const { began, release, finished } = holdIndexLoad(plugin, app);

      const oldPairing = await startVault(plugin, "laptop");
      await began;
      expect(plugin.currentState.kind).toBe("connecting");
      await plugin.unlink();

      // Quiescent: when unlink resolves, no socket of the plugin's is open.
      expect(sockets.length).toBeGreaterThan(0);
      for (const s of sockets)
        expect(s.readyState, "a socket was still open after unlink").toBeGreaterThanOrEqual(2);
      expect(plugin.paired).toBe(false);

      // Resume the retired handshake and wait for its actual completion.
      release();
      await finished();
      expect(await app.vault.adapter.exists(".obsidian/plugins/telimus/index.json")).toBe(false);
      expect(plugin.currentState.kind).toBe("unpaired");

      // The old server holds nothing. It has heard from this device, because
      // starting a vault claims it and registers a row rather than writing a
      // config and contacting nobody, but not one note went up: the run was
      // retired before its first pass.
      const { Client } = await import("../core/client.ts");
      const { parsePairing } = await import("../core/pairing.ts");
      const { testWrapped } = await import("../core/test-keys.ts");
      const { MemoryIndexStore, MemoryVault } = await import("../core/vault.ts");
      const secret = parsePairing(oldPairing).secret;
      const checker = new Client({
        vault: new MemoryVault(),
        store: new MemoryIndexStore(),
        url: server.wsUrl,
        ...(await server.deviceCredentials(secret, await testWrapped(secret), "checker")),
        vaultId: "default",
        device: "checker",
      });
      try {
        await checker.connect();
        expect(checker.serverCursor, "the old run uploaded after unlink").toBe(0);
      } finally {
        await checker.close();
      }
    } finally {
      restore();
    }
  }, 300_000);

  it("unloading during the handshake retires the run and closes it", async () => {
    await fresh();
    const { sockets, restore } = recordSockets();
    try {
      const { plugin, app } = await load();
      const { began, release, finished } = holdIndexLoad(plugin, app);
      await startVault(plugin, "laptop");
      await began;
      const seen: string[] = [];
      plugin.watchState((s) => void seen.push(s.kind));
      plugin.onunload();
      await plugin.closing;
      for (const s of sockets) expect(s.readyState).toBeGreaterThanOrEqual(2);
      release();
      await finished();
      // The retired run said nothing: the only state seen is the one the
      // watcher was handed on subscribing.
      expect(seen).toEqual(["connecting"]);
    } finally {
      restore();
    }
  }, 300_000);
});

/**
 *  Unlink used to discard the
 * promise from `close()`, clear the saved config, and then remove the index,
 * so a pass in flight could recreate the index after its removal and an
 * adapter failure left the vault unpaired on disk and paired in memory.
 */
describe("unlink, in order and all the way", () => {
  it("refuses to report unlink complete when the pairing file was not actually cleared", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    const paired = structuredClone(plugin.savedData);
    const save = plugin.saveData.bind(plugin);
    plugin.saveData = async (value: unknown) => {
      if (value !== null) await save(value);
    };
    await expect(plugin.unlink()).rejects.toThrow(/pairing.*(removed|cleared|read back)/);
    expect(plugin.savedData).toEqual(paired);
    expect(plugin.paired).toBe(true);
    expect(plugin.currentState.kind).toBe("stopped");
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
    plugin.saveData = save;
    await plugin.unlink();
    expect(plugin.savedData).toBe(null);
    expect(plugin.paired).toBe(false);
  });

  const INDEX = ".obsidian/plugins/telimus/index.json";
  const STAGED = ".obsidian/plugins/telimus/.telimus-tmp-index-index.json";

  it("closes, then removes the index, then forgets the pairing", async () => {
    await fresh();
    const { sockets, restore } = recordSockets();
    try {
      const { plugin, app } = await load();
      app.vault.adapter.seed("note.md", "x");
      await startVault(plugin, "laptop");
      await synced(plugin);

      const order: string[] = [];
      const adapter = app.vault.adapter;
      const realRemove = adapter.remove.bind(adapter);
      adapter.remove = async (path) => {
        if (path === INDEX) order.push("remove index");
        return realRemove(path);
      };
      const realSave = plugin.saveData.bind(plugin);
      plugin.saveData = async (data) => {
        if (data === null) {
          order.push("forget pairing");
          expect(await adapter.exists(INDEX), "the pairing went before the index").toBe(false);
        }
        return realSave(data);
      };
      const socket = sockets[sockets.length - 1]!;
      const realClose = socket.close.bind(socket);
      socket.close = (...args) => {
        order.push("close");
        return realClose(...args);
      };

      await plugin.unlink();
      expect(order).toEqual(["close", "remove index", "forget pairing"]);
    } finally {
      restore();
    }
  }, 300_000);

  it("waits for the pass in flight, so the index it saves is the one removed", async () => {
    await fresh();
    const a = await load();
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);
    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);

    // A download on b that takes a while, and an unlink in the middle of it.
    const began = deferred();
    const writeGate = deferred();
    const adapter = b.app.vault.adapter;
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (path.includes("slow.md")) {
        began.resolve();
        await writeGate.promise;
      }
      return realWrite(path, data, options);
    };
    a.app.vault.adapter.seed("slow.md", "arrives slowly");
    await a.plugin.syncNow();
    await began.promise;

    const unlinking = b.plugin.unlink();
    try {
      await nextTurn();
      expect(await adapter.exists(INDEX)).toBe(true);
    } finally {
      writeGate.resolve();
      await unlinking;
    }
    expect(b.plugin.paired).toBe(false);
    // The pass finished before the index was removed, so nothing of it comes
    // back afterwards.
    expect(await adapter.exists(INDEX)).toBe(false);
    expect(await adapter.exists(STAGED)).toBe(false);
    expect(b.plugin.savedData).toBe(null);
  }, 300_000);

  it("takes the staged index copy too", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.write(
      STAGED,
      JSON.stringify({ cursor: 99, entries: {}, remote: {}, pending: [] }),
    );
    await plugin.unlink();
    expect(await app.vault.adapter.exists(STAGED)).toBe(false);
    expect(await app.vault.adapter.exists(INDEX)).toBe(false);
  }, 300_000);

  it("leaves memory and disk agreeing when a step fails, and can be tried again", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const saved = plugin.savedData;

    app.vault.adapter.fault = (op, path) =>
      op === "remove" && path === INDEX ? new Error("EACCES: index is locked") : undefined;
    await expect(plugin.unlink()).rejects.toThrow(/index could not be removed/);
    // Still paired, both places, and honest about being stopped.
    expect(plugin.paired).toBe(true);
    expect(plugin.savedData).toEqual(saved);
    expect(plugin.currentState.kind).toBe("stopped");
    expect(status(plugin)).toMatch(/unlink did not finish/);

    app.vault.adapter.fault = undefined;
    await plugin.unlink();
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
    expect(await app.vault.adapter.exists(INDEX)).toBe(false);
  }, 300_000);

  it("leaves the index gone and the pairing kept when forgetting the pairing fails", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const saved = plugin.savedData;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data) => {
      if (data === null) throw new Error("EIO: data.json");
      return realSave(data);
    };
    await expect(plugin.unlink()).rejects.toThrow(/pairing could not be removed/);
    expect(plugin.paired).toBe(true);
    expect(plugin.savedData).toEqual(saved);
    // A missing index is the safe side: it only means starting over from
    // the server, never skipping an upload.
    expect(await app.vault.adapter.exists(INDEX)).toBe(false);
  }, 300_000);

  /**
   * A "working on" timer armed before unlink fired after
   * it and painted the bar back to syncing an unpaired vault.
   */
  it("clears the timers, so nothing paints over unpaired", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      (plugin as unknown as { working(p: string): void }).working("big.bin");
      await plugin.unlink();
      await vi.advanceTimersByTimeAsync(600);
      expect(plugin.currentState.kind).toBe("unpaired");
    } finally {
      vi.useRealTimers();
    }
  }, 300_000);
});

/**
 * The first device claims the vault
 * with the server's bootstrap token and then drops the token. If the drop
 * never saved, or the claim's reply was lost, the next start offered the
 * spent token first and was refused for ever.
 */
/**
 * What protocol 4 leaves of it.
 *
 * Starting a vault writes the root to `data.json` and reads it back before the
 * claim goes out, because the claim binds the server to that secret for good
 * and a secret that never reached the disk is a vault nobody can open. If the
 * registration after it fails, that is what is left: a root, no row, and a
 * phone. Nothing resumes from that and retries the spent token, so the whole
 * of the answer has to be in what the phone shows, and it is tested for the
 * key itself rather than for advice about it.
 */
describe("a vault that was started and never joined", () => {
  it("stops with the recovery key on screen rather than retrying for ever", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const recoveryKey = keyOf(first.plugin);

    // What a registration that failed after the claim committed leaves on
    // disk: the config as it was saved before the claim, root and all.
    const { parsePairing } = await import("../core/pairing.ts");
    const { base64urlEncode } = await import("../core/crypto.ts");
    const saved = first.plugin.savedData as Record<string, unknown>;
    const stale = {
      url: saved["url"],
      vaultId: saved["vaultId"],
      device: saved["device"],
      secret: base64urlEncode(parsePairing(recoveryKey).secret),
    };
    first.plugin.onunload();
    await first.plugin.closing;

    const again = await load(stale);
    await until("it to stop", () => again.plugin.currentState.kind === "stopped");
    const why = (again.plugin.currentState as { why: string }).why;
    expect(why).toMatch(/never registered itself/);
    // The key, on screen. This config is the only copy of it, so a phone that
    // said "could not connect" and no more would be a lost vault.
    expect(why).toContain(recoveryKey);
    expect(why).toMatch(/unlink this vault and pair again with it/);
    // Stopped, not offline: nothing here is going to change on a retry, and a
    // status bar saying "connecting" about that is the lie rule 7 is about.
    expect(again.plugin.savedData).not.toBe(null);
  }, 300_000);

  /**
   * F02. The recovery key has to leave this device before anything that can
   * lose it.
   *
   * The registration replaces the root on disk with this device's own
   * credential, and the connection that proves that credential comes after
   * the replacement. So every failure from the registration onwards used to
   * end with a working device, no root anywhere, and an error with no key in
   * it; a crash in the same window did it silently. Returning the key at the
   * end cannot fix that, because the end is the part that does not happen.
   */
  it("hands the recovery key over while the root is still the thing on disk", async () => {
    await fresh();
    const { plugin } = await load();

    const seen: { key: string; rootOnDisk: boolean; sent: number }[] = [];
    let sent = 0;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data) => {
      sent++;
      return realSave(data);
    };

    const key = await plugin.pairFirst(server.setup, "laptop", (k) => {
      const held = plugin.savedData as Record<string, unknown> | null;
      seen.push({ key: k, rootOnDisk: held?.["secret"] !== undefined, sent });
    });

    expect(seen, "the key was never handed over before the call returned").toHaveLength(1);
    expect(seen[0]!.key, "a different key was handed over").toBe(key);
    expect(
      seen[0]!.rootOnDisk,
      "the key was handed over after the root had already left the disk",
    ).toBe(true);
    // And the vault ends up in the state it always did: the credential on
    // disk, the root gone, which is what makes revoking this device mean
    // something.
    const held = plugin.savedData as Record<string, unknown>;
    expect(held["deviceId"]).toBeDefined();
    expect(held["secret"], "a paired device kept the vault's root").toBeUndefined();
  }, 300_000);

  it("keeps the root when the claim went through and the credential could not be saved", async () => {
    // The save that records this device's credential is the one that cannot be
    // taken on trust: it lands between a registration the server has committed
    // and a phone with nothing to show for it.
    await fresh();
    const { plugin } = await load();
    let failing = true;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data) => {
      const record = data as Record<string, unknown> | null;
      if (failing && record !== null && record["deviceId"] !== undefined) {
        throw new Error("EIO: data.json");
      }
      return realSave(data);
    };
    const failed = await startVault(plugin, "laptop").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failed?.message, "starting the vault succeeded").toMatch(/could not register itself/);
    // The row the registration may already have committed, named. A phone
    // told only to pair again registers a second row without learning
    // that the first one is there.
    expect(failed?.message).toMatch(/device row was registered/);
    expect(failed?.message).toMatch(/never connected/);
    expect(failed?.message).toMatch(/Write the recovery key shown in the Telimus panel down/);

    // On disk and in memory, the root is still there: the claim may have
    // committed, and throwing it away is a vault nothing will ever open.
    const held = plugin.savedData as Record<string, unknown>;
    expect(held["secret"], "the root went with the failed save").toBeDefined();
    await until("it to stop", () => plugin.currentState.kind === "stopped");
    const why = (plugin.currentState as { why: string }).why;
    expect(why).toMatch(/never registered itself/);
    // And the key is on the panel, which is where the person was sent.
    const printed = why.match(/basalt3_[A-Za-z0-9_-]+/)![0];
    const { parsePairing } = await import("../core/pairing.ts");
    expect(parsePairing(printed).vaultId).toBe("default");

    // The way out the words name: forget this pairing, and pair with the key.
    failing = false;
    await plugin.unlink();
    const rejoined = await load();
    await rejoined.plugin.pair(printed, "laptop");
    await synced(rejoined.plugin);
    const after = rejoined.plugin.savedData as Record<string, unknown>;
    expect(after["secret"], "pairing with the recovery key kept it").toBeUndefined();
    expect(after["deviceId"]).toBeDefined();
  }, 300_000);

  /**
   * The panel's pairing form, at the same moment: the registration commits and
   * the credential does not reach data.json.
   *
   * A row exists on the vault that nothing holds the key to, and the advice
   * has to name it. Pairing again registers a second one, so a phone that is
   * only told to try again leaves another unused row per attempt. The words come from `adviseAfterRegistering`,
   * which the CLI's `init` and `pair` also take theirs from.
   */
  it("names the row the panel's pairing left when the credential could not be saved", async () => {
    await fresh();
    const first = await load();
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    const realSave = second.plugin.saveData.bind(second.plugin);
    second.plugin.saveData = async (data: unknown) => {
      const record = data as Record<string, unknown> | null;
      if (record !== null && record["deviceId"] !== undefined) throw new Error("EIO: data.json");
      return realSave(data);
    };
    const failed = await second.plugin.pair(key, "desktop").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failed?.message, "the pairing succeeded").toMatch(/EIO/);
    expect(failed?.message).toMatch(/device row was registered/);
    expect(failed?.message).toMatch(/never connected/);
    expect(failed?.message).toMatch(/nothing can connect as that device/);
    // Nothing here claims to be paired, because nothing here can connect.
    expect(second.plugin.savedData).toBe(null);

    // And the row it names is really there, and really goes.
    const rows = (await first.plugin.devices()).devices;
    const orphan = rows.find((d) => d.lastSeen === 0);
    expect(orphan, JSON.stringify(rows)).toBeDefined();
    await first.plugin.revoke(orphan!.id);
    expect((await first.plugin.devices()).devices).toHaveLength(1);
  }, 300_000);

  /**
   * The mirror image, and why the advice is read off the disk in four states.
   *
   * A data.json that writes and will not read back holds a credential for a
   * live row, and "that row is one nothing can connect as, revoke it" would
   * destroy the row this phone could have used. Rule 2: absent and unreadable
   * are different states, here with different consequences.
   */
  it("will not name a row for revoking when data.json refuses to read back", async () => {
    await fresh();
    const first = await load();
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    let breaking = false;
    const realLoad = second.plugin.loadData.bind(second.plugin);
    const realSave = second.plugin.saveData.bind(second.plugin);
    second.plugin.saveData = async (data: unknown) => {
      const record = data as Record<string, unknown> | null;
      if (record !== null && record["deviceId"] !== undefined) breaking = true;
      return realSave(data);
    };
    second.plugin.loadData = async () => {
      if (breaking) throw new Error("EIO: data.json");
      return realLoad();
    };
    const failed = await second.plugin.pair(key, "desktop").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failed?.message, "the pairing succeeded").toMatch(/could not be read/);
    expect(failed?.message).toMatch(/not known/);
    expect(failed?.message).not.toMatch(/never connected/);
    // The credential really was written, and it is the row's only key.
    expect((second.plugin.savedData as Record<string, unknown>)["deviceId"]).toBeDefined();
    expect((await first.plugin.devices()).devices).toHaveLength(2);
  }, 300_000);
});

/**
 * An unreadable data.json set the state to stopped, but the
 * panel branched on `paired` and offered the pairing form, and pairing
 * overwrote the file with a new secret.
 */
describe("a config that cannot be read", () => {
  it("refuses to pair over it, and the panel shows why and where instead of the form", async () => {
    await fresh();
    const unreadable = { url: "ws://x", vaultId: "default", device: "d", secret: "AAAA" };
    const { plugin } = await load(unreadable);
    expect(plugin.currentState.kind).toBe("stopped");

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    expect(built.map((s) => s.name)).not.toContain("Pairing string");
    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toMatch(/root secret is 32 bytes/);
    expect(shown).toContain(".obsidian/plugins/telimus/data.json");

    await expect(startVault(plugin, "laptop")).rejects.toThrow(/could not be read/);
    await expect(plugin.pair("basalt3_whatever", "laptop")).rejects.toThrow(/could not be read/);
    const before = modals.length;
    plugin.protocolHandlers.get(INVITE_ACTION)!({ invite: "basalt3i_invalid" });
    expect(modals).toHaveLength(before);
    expect(notices.at(-1)!.message).toMatch(/could not be read/);
    expect(plugin.savedData).toEqual(unreadable);
  }, 300_000);
});

/**
 * "Working on X" stuck after any pass the plugin did not
 * start: the ticker and an arriving batch. Every pass now reports through one
 * hook, and the state follows it.
 */
describe("passes the plugin did not start", () => {
  it("returns to synced after a slow download that a batch started", async () => {
    await fresh();
    const a = await load();
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);
    const b = await load();
    const adapter = b.app.vault.adapter;
    const realWrite = adapter.writeBinary.bind(adapter);
    const writeGate = deferred();
    adapter.writeBinary = async (path, data, options) => {
      if (path.includes("slow.md")) await writeGate.promise;
      return realWrite(path, data, options);
    };
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);

    const seen: string[] = [];
    b.plugin.watchState((s) => void seen.push(s.kind));
    a.app.vault.adapter.seed("slow.md", "takes a while to land");
    await a.plugin.syncNow();
    try {
      await until("b to report the held download", () => b.plugin.currentState.kind === "syncing");
    } finally {
      writeGate.resolve();
    }
    await until("b to receive it", () => adapter.text("slow.md") !== undefined, 30_000);
    await until("b to settle", () => b.plugin.currentState.kind === "synced", 5_000);
    expect(seen, "b never said it was working").toContain("syncing");
    expect(b.plugin.currentState.kind).toBe("synced");
  }, 300_000);
});

/**
 * "Cannot sync N file(s)" fired on every pass for a file that
 * would never sync, and a notice on every pass is a notice nobody reads.
 */
describe("what is announced, and how often", () => {
  it("says a file is stuck once, not on every pass", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("fine.md", "ok");
    app.vault.adapter.seed(`${"x".repeat(4800)}.md`, "nope");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await until("the refusal to be announced", () =>
      notices.some((n) => /cannot sync/.test(n.message)),
    );
    notices.length = 0;
    for (let i = 0; i < 4; i++) await plugin.syncNow();
    expect(notices.filter((n) => /cannot sync/.test(n.message))).toHaveLength(0);

    // And a save, which syncs through the nudge, says nothing new either.
    const beforeSave = plugin.cursors()!.local;
    app.vault.adapter.seed("fine.md", "edited", 9_000_000_000_000);
    app.vault.fire("modify", { path: "note.md" });
    await until(
      "the edit to upload and its pass to finish",
      () => plugin.cursors()!.local > beforeSave && plugin.currentState.kind === "synced",
    );
    expect(notices.filter((n) => /cannot sync/.test(n.message))).toHaveLength(0);
    // The status still says so, because a status describes the vault.
    expect(status(plugin)).toMatch(/attention/);
  }, 300_000);

  /**
   * N2. The notice fired on the count changing, so one file being fixed in the
   * same pass as another started failing left the number where it was and the
   * new failure was never announced. The glyph said something was wrong and
   * nothing said what.
   */
  it("announces a different stuck file even when the count did not move (N2)", async () => {
    await fresh();
    const { plugin, app } = await load();
    const adapter = app.vault.adapter;
    const cannotOpen = new Set(["one.md"]);
    adapter.fault = (op, path) => {
      if (op !== "readBinary" || !cannotOpen.has(path)) return undefined;
      const err = new Error(`this device will not open ${path}`) as Error & { code: string };
      // The code the engine writes a path off for good by.
      err.code = "neversync";
      return err;
    };
    adapter.seed("one.md", "cannot be opened");
    adapter.seed("two.md", "fine for now");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await until("the first refusal", () => notices.some((n) => /cannot sync/.test(n.message)));
    expect(notices.at(-1)!.message, "the notice did not say which file").toContain("one.md");

    // Taking it out of the vault is what stops a written-off path being
    // counted. One pass to see it has gone.
    notices.length = 0;
    await adapter.remove("one.md");
    await plugin.syncNow();

    // A different file now, and the count is one both before and after.
    cannotOpen.clear();
    cannotOpen.add("two.md");
    adapter.seed("two.md", "and now this one will not open", 9_000_000_000_000);
    await plugin.syncNow();

    const said = notices.filter((n) => /cannot sync/.test(n.message));
    expect(said.length, "the swapped failure was never announced").toBeGreaterThan(0);
    expect(said.at(-1)!.message).toContain("two.md");
  }, 300_000);

  /**
   * The notice key assumes the list the type promises. A report built by hand
   * with a count and no list must still announce the count rather than throw
   * inside the announcement.
   */
  it("announces the count when a report names no paths", async () => {
    const { plugin } = await load();
    const report = {
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      conflicted: 0,
      deletedLocally: 0,
      deletedRemotely: 0,
      restored: 0,
      foldersCreated: 0,
      unchanged: 0,
      waiting: 0,
      retrying: 0,
      skipped: 1,
      ignored: 0,
      blocked: 0,
      inTheWay: [],
      chunksSent: 0,
      bytesSent: 0,
      reusedChunks: 0,
    } as unknown as SyncReport;
    (plugin as unknown as { announce(report: SyncReport): void }).announce(report);
    expect(notices.map((n) => n.message).join(" ")).toMatch(/cannot sync 1 file\(s\)\./);
  });
});

/**
 * `syncNow` could reject with the promise discarded by both
 * callers, so a pass that threw was a button that did nothing.
 */
describe("a sync that fails", () => {
  it("says so, and the state is honest about it", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    // The index cannot be written: the pass throws on its way out.
    app.vault.adapter.seed("another.md", "y");
    app.vault.adapter.fault = (op, path) =>
      (op === "writeBinary" || op === "append") && path.includes("/plugins/telimus/")
        ? new Error("EACCES: index")
        : undefined;
    notices.length = 0;
    await plugin.syncNow();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/sync failed.*EACCES/);
    expect(plugin.currentState.kind).toBe("failed");
    expect(statusIcon(plugin)).toBe("alert-triangle");
    expect(status(plugin)).toMatch(/Last sync failed/);

    app.vault.adapter.fault = undefined;
    await plugin.syncNow();
    expect(plugin.currentState.kind).toBe("synced");
  }, 300_000);
});

/**
 * "It will sync as soon as it reconnects" was shown while
 * stopped, which is the one state in which it will not.
 */
describe("what is said while stopped", () => {
  it("does not promise a reconnection that is not coming", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const saved = first.plugin.savedData as Record<string, unknown>;
    first.plugin.onunload();
    await first.plugin.closing;

    // The same server and the same row, a different device secret: refused
    // for good, because a credential the vault does not know is not something
    // another attempt improves on.
    const { decodeConfig, encodeConfig } = await import("../core/pairing.ts");
    const wrong = encodeConfig({
      ...decodeConfig(saved, "test"),
      deviceSecret: new Uint8Array(32).fill(7),
    });
    const other = await load(wrong);
    await until("it to stop", () => other.plugin.currentState.kind === "stopped");
    notices.length = 0;
    await other.plugin.syncNow();
    const said = notices.map((n) => n.message).join(" ");
    expect(said).toMatch(/has stopped/);
    expect(said).not.toMatch(/reconnects/);
    other.plugin.openHistory("note.md");
    expect(notices.at(-1)!.message).toMatch(/has stopped/);
    await expect(other.plugin.deletedNotes()).rejects.toThrow(/has stopped/);
  }, 300_000);
});

/**
 * A folder rename is one event, for the folder, and every
 * path under it moved without a word. Each file inside used to be reported
 * deleted at its old path and new at its new one.
 */
describe("renaming a folder", () => {
  it("produces no phantom deletions for the files inside it", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("docs/one.md", "one");
    app.vault.adapter.seed("docs/two.md", "two");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await app.vault.adapter.rename("docs", "moved");
    app.vault.fire("rename", { path: "moved" }, "docs");
    for (let i = 0; i < 4; i++) await plugin.syncNow();

    const client = (
      plugin as unknown as { client: { deleted(): Promise<{ notes: { path: string }[] }> } }
    ).client;
    const gone = (await client.deleted()).notes.map((v) => v.path);
    expect(gone, `deleted list was ${JSON.stringify(gone)}`).toEqual([]);
    expect(app.vault.adapter.text("moved/one.md")).toBe("one");
  }, 300_000);
});

/**
 * `telimus:restore` looked at one page of two hundred
 * versions, so a version older than that was one `telimus:history` would list
 * and this would then say did not exist.
 */
describe("restoring by uid from the command line", () => {
  it("pages back as far as it has to", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "first");
    await startVault(plugin, "laptop");
    await synced(plugin);
    app.vault.adapter.seed("note.md", "second", 9_000_000_000_000);
    await plugin.syncNow();

    const client = (plugin as unknown as { client: { findVersion: unknown; history: unknown } })
      .client;
    const versions = (await plugin.cliHandlers
      .get("telimus:history")!
      .handler({ path: "note.md" })) as string;
    const oldest = Number(versions.trim().split("\n").at(-1)!.split("\t")[0]);
    // Paged one at a time, so the version wanted is not on the first page.
    let pages = 0;
    const realHistory = (client.history as (p: string, o: unknown) => Promise<unknown[]>).bind(
      client,
    );
    client.history = async (path: string, opts: { before?: number; limit?: number }) => {
      pages++;
      return realHistory(path, { ...opts, limit: 1 });
    };
    const realFind = client.findVersion as (
      p: string,
      m: (v: unknown) => boolean,
      size?: number,
    ) => unknown;
    client.findVersion = (path: string, match: (v: unknown) => boolean) =>
      realFind.call(client, path, match, 1);

    const answer = (await plugin.cliHandlers
      .get("telimus:restore")!
      .handler({ path: "note.md", uid: oldest })) as string;
    expect(answer).toMatch(/^Restored to note \(restored \d+\)\.md/);
    expect(pages).toBeGreaterThan(1);
  }, 300_000);
});

/**
 * md. A pairing string was saved and
 * announced as paired before the server had been reached, and two presses of
 * Pair made two secrets.
 */
describe("pairing honestly", () => {
  it("reaches the server before saving a pairing, and saves nothing it could not reach", async () => {
    await fresh();
    const first = await load();
    const pairing = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // A server that is not there.
    const dead = pairing;
    const second = await load();
    const { url } = { url: server.wsUrl };
    await server.cleanup();
    await expect(second.plugin.pair(dead, "desktop")).rejects.toThrow(/could not connect|closed/);
    expect(second.plugin.paired).toBe(false);
    expect(second.plugin.savedData).toBe(null);
    expect(second.plugin.currentState.kind).toBe("unpaired");
    void url;
  }, 300_000);

  it("refuses a pairing the server refuses, and saves nothing", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // A string for the same server with a secret the vault was not claimed with.
    const { formatPairing } = await import("../core/pairing.ts");
    const wrong = formatPairing({
      url: server.wsUrl,
      vaultId: "default",
      secret: new Uint8Array(32).fill(9),
    });
    const second = await load();
    await expect(second.plugin.pair(wrong, "desktop")).rejects.toThrow(/auth/i);
    expect(second.plugin.paired).toBe(false);
    expect(second.plugin.savedData).toBe(null);
  }, 300_000);

  it("offers unlink when a new vault's claim is refused for good", async () => {
    await fresh();
    const { plugin } = await load();
    // A setup string with the wrong token: the claim is refused, for ever.
    // Reported to whoever asked rather than left to a retry that cannot win.
    await expect(plugin.pairFirst(`${server.wsUrl}#not-the-token`, "laptop")).rejects.toThrow(
      /could not register itself/,
    );
    await until("it to stop", () => plugin.currentState.kind === "stopped");
    const said = notices.map((n) => n.message).join(" ");
    expect(said).toMatch(/could not join/);
    expect(said).toMatch(/unlink/i);
    expect(said).not.toMatch(/syncing/);
  }, 300_000);

  it("runs one pairing at a time", async () => {
    await fresh();
    const { plugin } = await load();
    const [a, b] = await Promise.allSettled([startVault(plugin, "one"), startVault(plugin, "two")]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    const rejected = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already/);
    // One secret, on disk and running.
    await synced(plugin);
    const saved = plugin.savedData as Record<string, string>;
    expect(saved["device"]).toBe(plugin.deviceName);
  }, 300_000);

  it("makes up a device name that tells two blank ones apart", async () => {
    await fresh();
    const a = await load();
    const pairing = await startVault(a.plugin, "   ");
    await synced(a.plugin);
    const b = await load();
    await b.plugin.pair(pairing, "");
    await synced(b.plugin);
    expect(a.plugin.deviceName).toMatch(/^obsidian-[0-9a-f]{4}$/);
    expect(b.plugin.deviceName).toMatch(/^obsidian-[0-9a-f]{4}$/);
    expect(a.plugin.deviceName).not.toBe(b.plugin.deviceName);
  }, 300_000);
});

/**
 * `addStatusBarItem` is declared "not available on mobile"
 * and was called unguarded.
 */
describe("on a phone", () => {
  it("disposes the previous settings panel when Obsidian redraws the tab", async () => {
    const { plugin } = await load();
    const tab = plugin.settingTabs[0]!;
    const callbacks = () => (plugin as unknown as { panelClosers: Set<unknown> }).panelClosers.size;
    tab.display();
    tab.display();
    tab.display();
    expect(callbacks()).toBe(1);
    tab.hide();
    expect(callbacks()).toBe(0);
  });
  it("stops delivery timers while hidden and refreshes on return", async () => {
    const { plugin } = await load();
    vi.spyOn(plugin, "paired", "get").mockReturnValue(true);
    vi.spyOn(plugin, "deliveryReady", "get").mockReturnValue(true);
    vi.spyOn(plugin, "currentState", "get").mockReturnValue({
      kind: "synced",
      summary: "Up to date",
      at: 0,
      refused: 0,
      waiting: 0,
    });
    vi.spyOn(plugin, "cursors").mockReturnValue({ local: 0, server: 0 });
    const requests = vi.spyOn(plugin, "devices").mockResolvedValue({
      devices: [],
      maxDevices: 0,
      invites: [],
      thisDevice: "phone",
    });
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", doc);
    vi.useFakeTimers();
    try {
      plugin.commands.find((c) => c.id === "show-status")!.callback!();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(requests).not.toHaveBeenCalled();
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveBeenCalledTimes(1);
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(vi.getTimerCount()).toBe(0);
      modals.at(-1)!.close();
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(requests).toHaveBeenCalledTimes(1);
    } finally {
      modals.at(-1)?.close();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("adds no status bar item and still says everything on the ribbon", async () => {
    await fresh();
    Platform.isMobileApp = true;
    try {
      const { plugin } = await load();
      expect(plugin.statusBarItems).toHaveLength(0);
      await startVault(plugin, "phone");
      await until("a sync", () => plugin.currentState.kind === "synced");
      expect(plugin.ribbonIcons[0]!.el.attributes.get("aria-label")).toMatch(/^Telimus: .*as of/);
    } finally {
      Platform.isMobileApp = false;
    }
  }, 300_000);
});

describe("recovery taps and late responses", () => {
  const version = {
    uid: 1,
    path: "gone.md",
    contentId: "gone",
    size: 4,
    ctime: 0,
    mtime: 1,
    folder: false,
    deleted: true,
    device: "phone",
    chunks: 1,
    restorable: 1,
  };

  it("restores a deleted note only once for repeated taps", async () => {
    const { plugin } = await load();
    const listed = vi
      .spyOn(plugin, "deletedNotes")
      .mockResolvedValue({ notes: [version], more: false });
    const done = deferred<{ path: string; sent: boolean }>();
    const recover = vi.spyOn(plugin, "recover").mockReturnValue(done.promise);
    await plugin.runCommand("recover-deleted");
    await nextTurn();
    const button = built.find((s) => s.name === "gone.md")!.buttons[0]!;
    const first = button.click();
    const second = button.click();
    done.resolve({ path: "gone.md", sent: true });
    await Promise.all([first, second]);
    expect(recover).toHaveBeenCalledTimes(1);
    // The restored note leaves the list without asking the server again: a
    // refetch would throw away every older page that had been loaded, which
    // is what the filter searches (R083-17).
    expect(listed).toHaveBeenCalledTimes(1);
    expect(modals.at(-1)!.contentEl.allText()).toContain("No deleted notes to restore");
    modals.at(-1)!.close();
    vi.restoreAllMocks();
  });

  it("does not rebuild a closed deleted-notes window", async () => {
    const { plugin } = await load();
    const page = deferred<{ notes: (typeof version)[]; more: boolean }>();
    vi.spyOn(plugin, "deletedNotes").mockReturnValue(page.promise);
    await plugin.runCommand("recover-deleted");
    const modal = modals.at(-1)!;
    const loading = (modal as unknown as { render(): Promise<void> }).render();
    modal.close();
    page.resolve({ notes: [version], more: false });
    await loading;
    expect(modal.contentEl.allText()).toBe("");
    vi.restoreAllMocks();
  });
});

/**
 * Every row was called recoverable, including the ones drawn
 * a few lines down as purged.
 */
describe("the recovery header", () => {
  const note = (path: string, restorable: number) => ({
    uid: 1,
    path,
    size: 1,
    ctime: 0,
    mtime: 0,
    folder: false,
    deleted: true,
    device: "d",
    chunks: 0,
    contentId: "-empty-",
    restorable,
  });

  it("counts what can come back and what cannot, separately", () => {
    const text = describeDeleted({
      notes: [note("a.md", 3), note("b.md", 0), note("c.md", 0)],
      more: false,
    });
    expect(text).toMatch(/1 note is recoverable/);
    expect(text).toMatch(/2 notes are listed but cannot be restored/);
    expect(text).not.toMatch(/all/);
  });

  it("says when the list is cut short, without pointing at a command line", () => {
    const text = describeDeleted({ notes: [note("a.md", 3)], more: true });
    expect(text).toMatch(/older deletions than the 1 shown/);
    expect(text).not.toMatch(/telimus deleted/);
  });
});

/**
 * A restore that landed on disk and then could not be
 * uploaded was reported as a failure, and a retry made a second copy.
 */
describe("a restore whose upload fails", () => {
  it("is reported as restored here and not yet sent", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("gone.md", "bring me back");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    const deletion = (await plugin.deletedNotes()).notes.find((n) => n.path === "gone.md")!;

    // The upload after the restore cannot save its index.
    app.vault.adapter.fault = (op, path) =>
      (op === "writeBinary" || op === "append") && path.includes("/plugins/telimus/")
        ? new Error("EACCES: index")
        : undefined;
    const done = await plugin.recover(deletion);
    expect(done.path).toBe("gone.md");
    expect(done.sent).toBe(false);
    expect(done.why).toMatch(/EACCES/);
    expect(app.vault.adapter.text("gone.md")).toBe("bring me back");
  }, 300_000);

  /**
   * F15. A pass that resolved is not a path that went.
   *
   * `settle` resolves for a vault that is retrying, so ignoring its report
   * reported the restored note as sent to the other devices while its upload
   * sat queued. The restore is durable either way, which is exactly why the
   * two outcomes are kept apart; claiming the second because the first
   * happened is the same conflation from the other side.
   */
  it("does not claim a restore was sent when its upload is still retrying", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("gone.md", "bring me back");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    const deletion = (await plugin.deletedNotes()).notes.find((n) => n.path === "gone.md")!;

    // A pass that resolves while this path has not gone: the report says it is
    // retrying, and the engine has not acknowledged it.
    //
    // Both, and that is the point after R09. `retryingPaths` is a display
    // sample, sorted and cut to five names, and what decides whether a path
    // went is whether the server acknowledged that exact content. Faking the
    // sample alone describes a state the system cannot be in: a path the
    // engine has acknowledged and the report calls retrying. So the fake says
    // the same thing twice, which is what a real failing upload does.
    const held = plugin as unknown as {
      client: {
        settle(o: unknown): Promise<unknown>;
        engine: { serverHasOurs(p: string): boolean };
      };
    };
    const realSettle = held.client.settle.bind(held.client);
    held.client.settle = async (o: unknown) => {
      const report = (await realSettle(o)) as Record<string, unknown>;
      return { ...report, retrying: 1, retryingPaths: ["gone.md"] };
    };
    const realHas = held.client.engine.serverHasOurs.bind(held.client.engine);
    held.client.engine.serverHasOurs = (path: string) =>
      path === "gone.md" ? false : realHas(path);

    const done = await plugin.recover(deletion);
    expect(done.path).toBe("gone.md");
    expect(done.sent, "a restore whose upload is queued was reported as sent").toBe(false);
    expect(done.willRetry).toBe(true);
    // And the local copy is there, because that half really did happen.
    expect(app.vault.adapter.text("gone.md")).toBe("bring me back");
  }, 300_000);

  it("does not blame this restore for another path failing", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("gone.md", "bring me back");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    const deletion = (await plugin.deletedNotes()).notes.find((n) => n.path === "gone.md")!;

    const client = (plugin as unknown as { client: { settle(o: unknown): Promise<unknown> } })
      .client;
    const realSettle = client.settle.bind(client);
    client.settle = async (o: unknown) => {
      const report = (await realSettle(o)) as Record<string, unknown>;
      return { ...report, retrying: 1, retryingPaths: ["something-else.md"] };
    };

    const done = await plugin.recover(deletion);
    expect(done.sent, "an unrelated path's failure was blamed on this restore").toBe(true);
  }, 300_000);
});

/**
 * P-D1 in the 0.3.0 review. The plugin handed the modal a finished sentence and
 * the modal wrapped it in a second one, so every restore from History read
 * "Restored to Restored note.md. Sent to your other devices., because something
 * is already at note.md." The fakes in history.test.ts hand back paths, so
 * nothing pinned the shape the plugin itself produces: this does, through the
 * modal, by pressing the button a person presses.
 */
/**
 * P-D8 in the 0.3.0 review. Obsidian Sync puts version history on the file
 * menu, so this plugin does too, and until now the only thing asserted about
 * it was that a handler had been registered: what the entry says and what
 * clicking it does were untested, which is the whole of the feature.
 */
describe("version history on the file menu (P-D8)", () => {
  /**
   * Just enough of Obsidian's `Menu`: `addItem` hands a builder to the
   * caller and keeps what it built. The real one returns `this` from every
   * setter so they chain, which is the only shape the plugin depends on.
   */
  function fakeMenu() {
    const items: { title: string; icon: string; click(): void }[] = [];
    const menu = {
      addItem(build: (item: unknown) => void): void {
        const item = { title: "", icon: "", click: () => {} };
        build({
          setTitle(title: string) {
            item.title = title;
            return this;
          },
          setIcon(icon: string) {
            item.icon = icon;
            return this;
          },
          onClick(fn: () => void) {
            item.click = fn;
            return this;
          },
        });
        items.push(item);
      },
    };
    return { menu, items };
  }

  it("opens the history of the file the menu was opened on", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("daily/note.md", "text");
    await startVault(plugin, "laptop");
    await synced(plugin);

    // A decoy. Proving "not the active file" against no active file at all
    // proves nothing: a regression that reached for `getActiveFile()` would
    // have read undefined and opened the clicked one anyway (N8).
    app.workspace.activeFile = { path: "other.md", extension: "md" };

    const { menu, items } = fakeMenu();
    app.workspace.fire("file-menu", menu, { path: "daily/note.md", extension: "md" });
    expect(items.map((i) => i.title)).toEqual(["Telimus: version history"]);
    expect(items[0]!.icon).toBe("history");

    modals.length = 0;
    items[0]!.click();
    // That file, not whichever one happens to be open: the menu is the one
    // place where the file acted on is not the active one.
    await until("the history modal", () => modals.length > 0);
    expect(modals.at(-1)!.titleEl.allText()).toBe("History of daily/note.md");
  }, 300_000);

  it("puts nothing on the menu of a folder", async () => {
    const { plugin, app } = await load();
    expect(plugin.paired).toBe(false);
    const { menu, items } = fakeMenu();
    // A TFolder has no extension, and there is no history of a folder.
    app.workspace.fire("file-menu", menu, { path: "daily" });
    expect(items).toEqual([]);
  });
});

describe("what History says after a restore (P-D1)", () => {
  /** The buttons the newest modal drew, in the order it drew them. */
  function buttons(): { text: string; click(): void }[] {
    const found: { text: string; click(): void }[] = [];
    const visit = (n: FakeEl): void => {
      if (n.tag === "button" && !n.disabled)
        found.push({ text: n.allText(), click: () => n.fire("click") });
      for (const c of n.children) visit(c);
    };
    visit(modals[modals.length - 1]!.contentEl);
    return found;
  }

  async function restoreFromHistory(plugin: Testable): Promise<string> {
    notices.length = 0;
    plugin.openHistory("note.md");
    await until("an enabled Restore button", () => buttons().some((b) => b.text === "Restore"));
    buttons()
      .find((b) => b.text.includes("Restore"))!
      .click();
    await until("a notice about the restore", () => notices.length > 0);
    return notices.map((n) => n.message).join(" ");
  }

  it("says it once, and still says when the copy has not been sent", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "first");
    await startVault(plugin, "laptop");
    await synced(plugin);

    const said = await restoreFromHistory(plugin);
    expect(said, "the notice was built from another notice").not.toMatch(/Restored to Restored/);
    expect(said).toMatch(
      /^Restored to note \(restored \d+\)\.md, because something is already at note\.md\. Uploaded to server\. Other devices will receive it when they sync\.$/,
    );

    // The other half: a restore that landed here and could not be uploaded
    // has to say so from this path too, which is what returning a path
    // rather than the outcome would have thrown away.
    app.vault.adapter.fault = (op, path) =>
      (op === "writeBinary" || op === "append") && path.includes("/plugins/telimus/")
        ? new Error("EACCES: index")
        : undefined;
    const stuck = await restoreFromHistory(plugin);
    expect(stuck).toMatch(/will be sent when the next sync succeeds: .*EACCES/);
  }, 300_000);
});

/**
 * P-D2 and P-D3 in the 0.3.0 review. Three things carry on running across an
 * unlink: the settle save started by a connection, a Sync now the person asked
 * for, and a restore waiting for its upload. All three used to speak for a
 * vault that had already been removed.
 */
describe("what is still in flight when a vault is unlinked (P-D2, P-D3)", () => {
  /** Holds the next call to `settle`, so an unlink can happen underneath it. */
  function holdSettle(plugin: Testable): { reached: () => boolean; release: () => void } {
    const client = (plugin as unknown as { client: { settle(o: unknown): Promise<unknown> } })
      .client;
    const real = client.settle.bind(client);
    let reached = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.settle = async (o: unknown) => {
      reached = true;
      await gate;
      return real(o);
    };
    return { reached: () => reached, release };
  }

  it("does not put the pairing back on disk after unlink (P-D2)", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    expect(plugin.savedData).not.toBe(null);

    // A config write of the shape a conversion makes, in flight past its own
    // generation check, and slower than the whole of unlink. Only the first
    // one is held: unlink's own write of null must not be, or nothing lands.
    const { decodeConfig } = await import("../core/pairing.ts");
    const inner = plugin as unknown as {
      generation: number;
      saveDuringRun(mine: number, config: unknown): Promise<void>;
    };
    const config = decodeConfig(plugin.savedData, "test");
    const saveGate = deferred();
    let saves = 0;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data: unknown) => {
      if (++saves === 1) await saveGate.promise;
      return realSave(data);
    };

    const settling = inner.saveDuringRun(inner.generation, config).catch(() => undefined);
    const unlinking = plugin.unlink();
    try {
      await nextTurn();
      expect(plugin.savedData).not.toBe(null);
    } finally {
      saveGate.resolve();
      await Promise.all([unlinking, settling]);
    }

    // The one that matters: what a restart would read. A pairing here means
    // the next start syncs a vault the person removed.
    expect(plugin.savedData, "the conversion's save landed on top of the unlink").toBe(null);
    expect(plugin.paired).toBe(false);
    expect(plugin.currentState.kind).toBe("unpaired");
  }, 300_000);

  /**
   * R10. The same race with two saves in the air. A conversion makes three,
   * and holding only the newest let an older one land its pairing on top of
   * the null that unlink had just written.
   */
  it("waits for every save in flight, not just the newest (R10)", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    expect(plugin.savedData).not.toBe(null);

    const { decodeConfig } = await import("../core/pairing.ts");
    const inner = plugin as unknown as {
      generation: number;
      saveDuringRun(mine: number, config: unknown): Promise<void>;
    };
    const config = decodeConfig(plugin.savedData, "test");

    // The first save is the slow one and the second is quick, so the newest
    // is not the one still in the air when unlink asks.
    const saveGate = deferred();
    let saves = 0;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data: unknown) => {
      if (++saves === 1) await saveGate.promise;
      return realSave(data);
    };

    const first = inner.saveDuringRun(inner.generation, config).catch(() => undefined);
    const second = inner.saveDuringRun(inner.generation, config).catch(() => undefined);
    await second;
    const unlinking = plugin.unlink();
    try {
      await nextTurn();
      expect(plugin.savedData).not.toBe(null);
    } finally {
      saveGate.resolve();
      await Promise.all([unlinking, first]);
    }

    expect(plugin.savedData, "an older save landed on top of the unlink").toBe(null);
    expect(plugin.paired).toBe(false);
  }, 300_000);

  /**
   * The other half of the same guarantee, and the one that covers a save that
   * had not started when the vault was unlinked: a retired run may not write
   * the config at all.
   */
  it("refuses a config write from a run that has been retired", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const { decodeConfig } = await import("../core/pairing.ts");
    const inner = plugin as unknown as {
      generation: number;
      saveDuringRun(mine: number, config: unknown): Promise<void>;
    };
    const config = decodeConfig(plugin.savedData, "test");
    const stale = inner.generation;
    await plugin.unlink();
    await expect(inner.saveDuringRun(stale, config)).rejects.toThrow(/no longer paired/);
    expect(plugin.savedData).toBe(null);
  }, 300_000);

  it("does not report a pass into a vault that is no longer there (P-D3)", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "text");
    await startVault(plugin, "laptop");
    await synced(plugin);

    const gate = holdSettle(plugin);
    const pass = plugin.syncNow();
    await until("the pass to reach settle", gate.reached);
    await plugin.unlink();
    notices.length = 0;
    gate.release();
    await pass;

    // Unpaired is the truth. "Telimus has stopped" or a summary of a pass
    // over a vault that is gone are both louder than the truth and wrong.
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(notices.map((n) => n.message).join(" ")).toBe("");
  }, 300_000);

  it("does not promise a next sync to a restore after unlink (P-D3)", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("gone.md", "bring me back");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    const deletion = (await plugin.deletedNotes()).notes.find((n) => n.path === "gone.md")!;

    const gate = holdSettle(plugin);
    const restoring = plugin.recover(deletion);
    await until("the restore to reach its upload", gate.reached);
    await plugin.unlink();
    gate.release();
    const done = await restoring;

    expect(app.vault.adapter.text("gone.md")).toBe("bring me back");
    expect(done.sent).toBe(false);
    const said = describeRestore(deletion, done);
    expect(said, "promised a sync that cannot happen").not.toMatch(/next sync succeeds/);
    expect(said).toMatch(/on this device and nowhere else/);
  }, 300_000);
});

/**
 * One permanently refused file showed the same green
 * check as a clean vault.
 */
describe("synced, with files that need a person", () => {
  it("is not the synced cloud", async () => {
    const { plugin } = await load();
    const set = (s: unknown) => (plugin as unknown as { setState(s: unknown): void }).setState(s);
    set({ kind: "synced", summary: "up to date", at: 1_700_000_000_000, refused: 0 });
    expect(statusIcon(plugin)).toBe("cloud-check");
    expect(plugin.statusBarItems[0]!.cls).not.toContain("telimus-attention");
    set({ kind: "synced", summary: "1 stuck", at: 1_700_000_000_000, refused: 1 });
    expect(statusIcon(plugin)).not.toBe("cloud-check");
    expect(plugin.statusBarItems[0]!.cls).toContain("telimus-attention");
    expect(status(plugin)).toMatch(/1 file needs attention/);
  });
});

/**
 * The gap between `exists` and `read`, and the
 * command-line handlers throwing out of their channel.
 */
describe("small honesties", () => {
  it("reads a note that is gone as nothing, not as a failure", async () => {
    const { plugin, app } = await load();
    const source = plugin.historySource();
    expect(await source.currentText("never.md")).toBeUndefined();
    app.vault.adapter.seed("here.md", "text");
    expect(await source.currentText("here.md")).toBe("text");

    // Deleted between being looked for and being read: what a person
    // deleting the note while its history loads does.
    app.vault.adapter.seed("gone.md", "about to go");
    const adapter = app.vault.adapter;
    const realExists = adapter.exists.bind(adapter);
    adapter.exists = async (path: string) => {
      const was = await realExists(path);
      if (path === "gone.md") await adapter.remove(path);
      return was;
    };
    await expect(source.currentText("gone.md")).resolves.not.toThrow();
  });

  it("answers the command line in words, whatever happens", async () => {
    await fresh();
    const { plugin } = await load();
    const history = plugin.cliHandlers.get("telimus:history")!.handler;
    const restore = plugin.cliHandlers.get("telimus:restore")!.handler;
    expect(await history({})).toMatch(/needs a path/);
    expect(await history({ path: "x.md" })).toMatch(/not paired/);
    expect(await restore({ path: "x.md" })).toMatch(/needs a uid/);

    await startVault(plugin, "laptop");
    await synced(plugin);
    expect(await history({ path: "nothing-here.md" })).toMatch(/No history/);
    const client = (plugin as unknown as { client: { history: unknown } }).client;
    client.history = async () => {
      throw new Error("the wire broke");
    };
    expect(await history({ path: "x.md" })).toMatch(/could not ask: the wire broke/);
    expect(await restore({ path: "x.md", uid: 1 })).toMatch(/could not restore: the wire broke/);
  }, 300_000);
});

/**
 * An Obsidian without `registerCliHandler` must still get a whole plugin.
 *
 * It arrived in 1.12.2 and everything else this plugin needs is older, so
 * declaring 1.12.2 would exclude people for an optional integration. Calling a
 * method that is not there throws inside onload, and onload stops where it
 * throws: the commands after it never register and the plugin half exists with
 * nothing saying why.
 */
describe("an older Obsidian", () => {
  it("loads everything except the command line integration", async () => {
    const { plugin } = await load(null, undefined, undefined, (p) => {
      // Shadowed on the instance rather than deleted: the stub declares
      // this on the prototype, where a delete of an own property does
      // nothing at all and the method is still found.
      (p as { registerCliHandler?: unknown }).registerCliHandler = undefined;
    });

    expect(plugin.commands.map((c) => c.id).sort()).toEqual([
      "activity",
      "pause-resume",
      "preview-sync",
      "recover-deleted",
      "review-conflicts",
      "show-status",
      "sync-now",
      "verify-contents",
      "version-history",
    ]);
    expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Telimus Sync"]);
    expect(plugin.statusBarItems.length).toBe(1);
    // The four vault events and the file-menu entry, all after the guard.
    expect(plugin.registeredEvents.length).toBe(5);
    expect([...plugin.cliHandlers.keys()]).toEqual([]);
  });
});

/**
 * The status bar is a glyph and a tooltip, so every state has to produce both.
 *
 * The settled state has no tone, and painting it called addClass with an empty
 * string, which throws. It surfaced as a sync failure complaining about a
 * DOMTokenList, which says nothing at all about the status bar it came from.
 */
describe("what the status bar shows", () => {
  const states = [
    { kind: "unpaired" },
    { kind: "connecting" },
    { kind: "syncing", path: "Notes/one.md" },
    { kind: "synced", summary: "up to date", at: 1_700_000_000_000, refused: 0 },
    { kind: "synced", summary: "1 stuck", at: 1_700_000_000_000, refused: 1 },
    { kind: "failed", why: "could not save the index", at: 1_700_000_000_000 },
    { kind: "offline", why: "no route to host", retryAt: 1_700_000_000_000, refused: false },
    { kind: "stopped", why: "not authorised" },
  ] as const;

  it("gives every state a glyph and a sentence, and never throws", async () => {
    const { plugin } = await load();
    const seen = new Set<string>();
    for (const state of states) {
      expect(() =>
        (plugin as unknown as { setState(s: unknown): void }).setState(state),
      ).not.toThrow();
      const icon = statusIcon(plugin);
      expect(icon, `${state.kind} chose no glyph`).not.toBe("");
      expect(plugin.statusBarItems[0]!.allText()).toBe("");
      expect(plugin.statusBarItems[0]!.children).toHaveLength(1);
      expect(status(plugin), `${state.kind} has no tooltip`).toMatch(/^Telimus Sync: \S/);
      seen.add(icon);
    }
    // Not all the same glyph, or the bar would say nothing by changing.
    expect(seen.size).toBeGreaterThan(2);
  });

  /**
   * `summarise` returns a fragment, because three of its four callers put it
   * after a colon. The fourth starts a sentence with it, in the tooltip and on
   * the panel's first line, and it read "up to date, as of 9:41 PM." under a
   * heading and above two proper sentences. Every other state here already
   * capitalises; only the settled one, the one seen most, did not. Found in a
   * screenshot, like the last three layout faults, and not by any of these.
   */
  it("starts every state's sentence the way a sentence starts", async () => {
    const { plugin } = await load();
    for (const state of states) {
      (plugin as unknown as { setState(s: unknown): void }).setState(state);
      const sentence = status(plugin).replace(/^Telimus Sync: /, "");
      expect(sentence, `${state.kind} opens mid-sentence`).toMatch(/^[A-Z0-9]/);
    }
  });
});

/**
 * Working and settled must not share a glyph. If they do, the only thing
 * separating "still syncing" from "done" is whether the icon is spinning, and
 * a spin is not something you can see in a glance at a status bar.
 */
it("does not draw the settled state the same as the working one", async () => {
  const { plugin } = await load();
  const set = (s: unknown) => (plugin as unknown as { setState(s: unknown): void }).setState(s);
  set({ kind: "syncing", path: "a.md" });
  const working = statusIcon(plugin);
  set({ kind: "synced", summary: "up to date", at: 1_700_000_000_000, refused: 0 });
  expect(statusIcon(plugin)).not.toBe(working);
});

/**
 * The status bar must stay legible against the status bar.
 *
 * The faint states measured 2.57:1 in dark and 2.12:1 in light, both under the
 * 3:1 a UI icon needs, and offline (the state meaning notes are not reaching
 * the server) was the faintest thing on screen. Nothing here can measure a
 * colour, so it pins the decision instead: only the error state is tinted, and
 * everything else inherits the status bar's own colour.
 */
it("tints only the state that is actually wrong", async () => {
  const { plugin } = await load();
  const set = (s: unknown) => (plugin as unknown as { setState(s: unknown): void }).setState(s);
  const tone = () =>
    (plugin as unknown as { statusEl: { cls: string } }).statusEl.cls
      .split(" ")
      .filter((c) => c.startsWith("telimus-") && c !== "telimus-status-icon");

  for (const s of [
    { kind: "unpaired" },
    { kind: "offline", why: "x", retryAt: 1, refused: false },
  ]) {
    set(s);
    expect(tone(), `${s.kind} should carry no colour`).not.toContain("telimus-muted");
  }
  set({ kind: "stopped", why: "x" });
  expect(tone()).toContain("telimus-attention");
});

/**
 * Adding a device from the panel: an invite from a device that has the vault,
 * and the recovery key when there is no such device left.
 *
 * The invite is the ordinary path. What it carries is the vault's data key,
 * which is what a device holds anyway, and the redemption registers the new
 * device's own row; no root reaches either end, which is what makes revoking
 * one of them mean something. The recovery key stays written down and offline,
 * and the panel says so where it used to be shown.
 */
describe("adding a device from the panel", () => {
  it.each(["invite", "recovery key"])(
    "requires confirmation before spending a %s in a populated vault",
    async (kind) => {
      await fresh();
      const first = await load();
      first.app.vault.adapter.seed("Organized/note.md", "Keep this note\n");
      await startVault(first.plugin, "laptop");
      await synced(first.plugin);
      const invite = (await first.plugin.createInvite()).invite;
      const key = kind === "invite" ? invite : keyOf(first.plugin);
      const second = await load();
      second.app.vault.adapter.seed("Inbox/note.md", "Keep this note\n");
      await second.app.vault.adapter.writeBinary(
        "old.pdf",
        new Uint8Array([37, 80, 68, 70, 0, 255]).buffer,
      );

      await expect(second.plugin.pair(key, "phone")).rejects.toThrow(/Confirm merging/);
      expect(second.plugin.savedData).toBe(null);
      expect(second.plugin.paired).toBe(false);
      expect(second.app.vault.adapter.text("Inbox/note.md")).toBe("Keep this note\n");
      expect(new Uint8Array(await second.app.vault.adapter.readBinary("old.pdf"))).toEqual(
        new Uint8Array([37, 80, 68, 70, 0, 255]),
      );
      expect((await first.plugin.devices()).devices).toHaveLength(1);
      expect(await first.plugin.historySource().history("Inbox/note.md", {})).toEqual([]);

      // The refusal did not consume the one-time invite: an empty device can still use it.
      const third = await load();
      await third.plugin.pair(invite, "empty-phone");
      await synced(third.plugin);
      await until(
        "the organized note to download",
        () => third.app.vault.adapter.text("Organized/note.md") === "Keep this note\n",
      );
      expect(third.app.vault.adapter.text("Inbox/note.md")).toBeUndefined();
      third.app.vault.adapter.seed("new.md", "Written after downloading\n");
      await third.plugin.syncNow();
      await until(
        "normal uploads after initial download",
        () => first.app.vault.adapter.text("new.md") === "Written after downloading\n",
      );
    },
    300_000,
  );

  it.each(["QR", "pasted invite", "recovery key"])(
    "confirms combining a populated vault during %s pairing",
    async (source) => {
      await fresh();
      const first = await load();
      first.app.vault.adapter.seed("Organized/note.md", "Keep this note\n");
      await startVault(first.plugin, "laptop");
      await synced(first.plugin);
      const invite = (await first.plugin.createInvite()).invite;
      const pairingValue = source === "recovery key" ? keyOf(first.plugin) : invite;
      const second = await load();
      second.app.vault.adapter.seed("Inbox/note.md", "Keep this note\n");
      const pdf = new Uint8Array([37, 80, 68, 70, 0, 255]);
      await second.app.vault.adapter.writeBinary("local.pdf", pdf.buffer);
      built.length = 0;
      if (source === "QR") second.plugin.protocolHandlers.get(INVITE_ACTION)!({ invite });
      else choosePairing(second.plugin, "invite");
      expect(built.find((s) => s.name === "First sync")).toBeUndefined();
      const keyField = built.find((s) => s.name === "Invite or setup line")!.texts[0]!;
      if (source !== "QR") keyField.type(pairingValue);
      built.find((s) => s.name === "Device name")!.texts[0]!.type("Phone");
      const pair = built.flatMap((s) => s.buttons).find((b) => b.label === "Pair")!;
      built.length = 0;
      await pair.click();
      expect(built.find((s) => s.name === "Confirm merge")).toBeDefined();
      expect(modals.at(-1)!.contentEl.allText()).toMatch(/moved or deleted/);
      expect(second.plugin.paired).toBe(false);
      expect(second.plugin.savedData).toBe(null);
      expect((await first.plugin.devices()).devices).toHaveLength(1);
      const cancel = built.flatMap((s) => s.buttons).find((b) => b.label === "Cancel")!;
      built.length = 0;
      await cancel.click();
      expect(built.find((s) => s.name === "Invite or setup line")!.texts[0]!.getValue()).toBe(
        pairingValue,
      );
      expect(built.find((s) => s.name === "Device name")!.texts[0]!.getValue()).toBe("Phone");
      const retry = built.flatMap((s) => s.buttons).find((b) => b.label === "Pair")!;
      built.length = 0;
      await retry.click();
      const proceed = built.flatMap((s) => s.buttons).find((b) => b.label === "Continue")!;
      const cancelPending = built.flatMap((s) => s.buttons).find((b) => b.label === "Cancel")!;
      const doPair = second.plugin.pair.bind(second.plugin);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(second.plugin, "pair").mockImplementationOnce(async (...args) => {
        await pending;
        await doPair(...args);
      });
      const connecting = proceed.click();
      const cancelDisabled = cancelPending.disabled;
      release();
      await connecting;
      expect(cancelDisabled, "Cancel must not imply an in-flight registration can be undone").toBe(
        true,
      );
      await synced(second.plugin);
      await until(
        "both sets of notes and the attachment to reach both devices",
        () =>
          first.app.vault.adapter.text("Inbox/note.md") === "Keep this note\n" &&
          second.app.vault.adapter.text("Organized/note.md") === "Keep this note\n" &&
          first.app.vault.adapter.text("local.pdf") !== undefined,
      );
      expect(new Uint8Array(await first.app.vault.adapter.readBinary("local.pdf"))).toEqual(pdf);
      expect(second.app.vault.adapter.text("Inbox/note.md")).toBe("Keep this note\n");
      expect(first.app.vault.adapter.text("Organized/note.md")).toBe("Keep this note\n");
      expect(second.plugin.deviceName).toBe("Phone");
    },
    300_000,
  );

  it("checks files that Obsidian has not indexed yet and refuses a failed scan", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const invite = (await first.plugin.createInvite()).invite;
    const second = await load();
    await second.app.vault.adapter.writeBinary(
      "unindexed.pdf",
      new Uint8Array([37, 80, 68, 70]).buffer,
    );
    vi.spyOn(second.app.vault, "getAllLoadedFiles").mockReturnValue([]);
    await expect(second.plugin.pair(invite, "phone")).rejects.toThrow(/Confirm merging/);
    second.app.vault.adapter.fault = (op) =>
      op === "list" ? new Error("directory unreadable") : undefined;
    await expect(second.plugin.pair(invite, "phone")).rejects.toThrow(/directory unreadable/);
    expect(second.plugin.savedData).toBe(null);
    expect((await first.plugin.devices()).devices).toHaveLength(1);
    expect(new Uint8Array(await second.app.vault.adapter.readBinary("unindexed.pdf"))).toEqual(
      new Uint8Array([37, 80, 68, 70]),
    );
  }, 300_000);

  it("does not redeem an invite when unloaded during the empty-vault check", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const invite = (await first.plugin.createInvite()).invite;
    const second = await load();
    let finish!: (value: { files: string[]; folders: string[] }) => void;
    vi.spyOn(second.app.vault.adapter, "list").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pairing = second.plugin.pair(invite, "phone");
    second.plugin.onunload();
    finish({ files: [], folders: [] });
    await expect(pairing).rejects.toThrow(/cancelled/);
    expect(second.plugin.savedData).toBe(null);
    expect((await first.plugin.devices()).devices).toHaveLength(1);
  }, 300_000);

  it("opens a scanned invite for confirmation and syncs after Pair", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "# From the first device\n");
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // The invite comes out of the panel, from the live connection, because
    // the server has to store it.
    built.length = 0;
    first.plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const adding = built.find((s) => s.name === "Add another device")!;
    await adding.buttons.find((b) => b.label === "Create invite")!.click();
    const shown = notices.map((n) => n.message).join(" ");
    expect(shown, "the invite was not offered for copying").toMatch(/Copied|clipboard/);
    const pairingCode = built.find((s) => s.name === "Pairing code");
    expect(pairingCode, "the invite needs a labelled field beside its Copy button").toBeDefined();
    expect(pairingCode!.desc).toMatch(/Paste this.*other device/);
    const field = pairingCode!.texts[0]!;
    expect(field.inputEl.attributes.has("readonly")).toBe(true);
    const invite = field.getValue();
    expect(invite).toMatch(/^basalt3i_/);
    const copied: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    try {
      await pairingCode!.buttons.find((b) => b.label === "Copy")!.click();
      expect(copied, "Copy must include the entire pairing code").toEqual([invite]);
    } finally {
      vi.unstubAllGlobals();
    }
    const images: FakeEl[] = [];
    const visit = (el: FakeEl): void => {
      if (el.tag === "img") images.push(el);
      for (const child of el.children) visit(child);
    };
    visit(modals.at(-1)!.contentEl);
    expect(images).toHaveLength(1);
    expect(images[0]!.hidden).toBe(false);
    expect(images[0]!.attributes.get("src")).toBe(inviteQrImage(invite));

    const second = await load();
    built.length = 0;
    const link = new URL(inviteLink(invite));
    second.plugin.protocolHandlers.get(INVITE_ACTION)!(Object.fromEntries(link.searchParams));
    expect(second.plugin.paired).toBe(false);
    expect(second.plugin.savedData).toBe(null);
    expect((await first.plugin.devices()).devices).toHaveLength(1);
    expect(built.find((s) => s.name === "Invite or setup line")!.texts[0]!.getValue()).toBe(invite);
    built.find((s) => s.name === "Device name")!.texts[0]!.type("phone");
    await built
      .find((s) => s.buttons.some((b) => b.label === "Pair"))!
      .buttons.find((b) => b.label === "Pair")!
      .click();
    expect(second.plugin.paired).toBe(true);
    await synced(second.plugin);
    await until("the note to arrive", () => second.app.vault.adapter.text("note.md") !== undefined);
    expect(second.app.vault.adapter.text("note.md")).toBe("# From the first device\n");

    // Two devices, two credentials, one data key, and no root on either. The
    // invite handed over the data key and nothing that could add a third
    // device or rewrap the vault.
    const a = first.plugin.savedData as Record<string, string>;
    const b = second.plugin.savedData as Record<string, string>;
    expect(a["secret"], "the first device is holding the vault's root").toBeUndefined();
    expect(b["secret"], "an invite handed over the vault's root").toBeUndefined();
    expect(b["deviceId"]).not.toBe(a["deviceId"]);
    expect(b["deviceSecret"]).not.toBe(a["deviceSecret"]);
    expect(b["dataKey"]).toBe(a["dataKey"]);

    // And each is a row the other can see and cut off.
    const listed = await first.plugin.devices();
    expect(listed.devices.map((d) => d.name).sort()).toEqual(["laptop", "phone"]);
  }, 300_000);

  it("rejects invalid invite links without opening a form or writing settings", async () => {
    const { plugin } = await load();
    const before = modals.length;
    for (const params of [{}, { invite: "basalt3i_invalid" }, { invite: "https://example.com" }]) {
      plugin.protocolHandlers.get(INVITE_ACTION)!(params);
    }
    expect(modals).toHaveLength(before);
    expect(plugin.savedData).toBe(null);
    expect(notices.at(-1)!.message).toMatch(/invite link is invalid/);
  });

  it("refuses an invite link in an already paired vault", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const invite = (await plugin.createInvite()).invite;
    const saved = plugin.savedData;
    const before = modals.length;
    plugin.protocolHandlers.get(INVITE_ACTION)!({ invite });
    expect(modals).toHaveLength(before);
    expect(plugin.savedData).toEqual(saved);
    expect(notices.at(-1)!.message).toMatch(/already paired/);
    expect((await plugin.devices()).devices).toHaveLength(1);
  });

  it("spends an invite once, and leaves nothing behind on the second try", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const invite = (await first.plugin.createInvite()).invite;

    const second = await load();
    await second.plugin.pair(invite, "phone");
    expect(second.plugin.paired).toBe(true);

    const third = await load();
    await expect(third.plugin.pair(invite, "tablet")).rejects.toThrow(/auth/i);
    expect(third.plugin.paired).toBe(false);
    expect(third.plugin.savedData, "a spent invite left a pairing on disk").toBe(null);
    const listed = await first.plugin.devices();
    expect(listed.devices).toHaveLength(2);
  }, 300_000);

  /**
   * F23. A pairing that completes after the plugin is unloaded must not
   * revive it.
   *
   * Redeeming an invite is a round trip, and Obsidian can disable a plugin
   * while one is in flight. This wrote its config and started a sync loop
   * unconditionally when it came back, so a redemption that finished after
   * `onunload` left a save, a client and a ticker belonging to a plugin that
   * had been retired. The root registration path next door has used the
   * generation guard since it was written; this one reached straight for the
   * raw save.
   */
  it("does not save or start when an invite is redeemed after unload", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const invite = (await first.plugin.createInvite()).invite;

    const second = await load();
    // Retire the plugin before the completed redemption reaches its caller.
    // The empty-vault preflight now runs before the network starts.
    const redeem = Transport.prototype.redeem;
    const delayed = vi.spyOn(Transport.prototype, "redeem").mockImplementationOnce(async function (
      this: Transport,
      args,
    ) {
      const answer = await redeem.call(this, args);
      second.plugin.onunload();
      await second.plugin.closing;
      return answer;
    });
    try {
      await expect(
        second.plugin.pair(invite, "phone"),
        "a pairing completed into a plugin that was gone",
      ).rejects.toThrow(/no longer paired|unlinked while the invite/);
    } finally {
      delayed.mockRestore();
    }
    expect(second.plugin.savedData, "a retired plugin saved a pairing").toBe(null);
    expect(second.plugin.paired).toBe(false);
    expect((await first.plugin.devices()).devices).toHaveLength(2);
  }, 300_000);

  it("adds one with the recovery key, and neither device keeps it", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "# From the first device\n");
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    choosePairing(second.plugin, "invite");
    built.find((s) => s.name === "Device name")!.texts[0]!.type("phone");
    built.find((s) => s.name === "Invite or setup line")!.texts[0]!.type(key);
    await built
      .find((s) => s.buttons.some((b) => b.label === "Pair"))!
      .buttons.find((b) => b.label === "Pair")!
      .click();
    expect(second.plugin.paired).toBe(true);
    await synced(second.plugin);
    await until("the note to arrive", () => second.app.vault.adapter.text("note.md") !== undefined);
    expect(second.app.vault.adapter.text("note.md")).toBe("# From the first device\n");

    // Two devices, two credentials, one data key, and the root on neither.
    const a = first.plugin.savedData as Record<string, string>;
    const b = second.plugin.savedData as Record<string, string>;
    expect(a["secret"], "the first device is holding the vault's root").toBeUndefined();
    expect(b["secret"], "the second device is holding the vault's root").toBeUndefined();
    expect(b["deviceId"]).not.toBe(a["deviceId"]);
    expect(b["deviceSecret"]).not.toBe(a["deviceSecret"]);
    // The same data key, or one of them would be sealing under a schedule the
    // other cannot derive.
    expect(b["dataKey"]).toBe(a["dataKey"]);

    // And each is a row the other can see and cut off.
    const listed = await first.plugin.devices();
    expect(listed.devices.map((d) => d.name).sort()).toEqual(["laptop", "phone"]);
  }, 300_000);

  it("refuses a damaged invite string, and saves nothing", async () => {
    await fresh();
    const { plugin } = await load();
    await expect(plugin.pair("basalt3i_notreallyaninvite", "tablet")).rejects.toThrow(
      /this invite is damaged/,
    );
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
  }, 300_000);

  it("leaves nothing behind when the recovery key is not the vault's", async () => {
    // I13. A key the server does not know used to be saved and announced
    // as paired, and the first sign of it was a status bar saying stopped.
    await fresh();
    const first = await load();
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const { parsePairing, formatPairing } = await import("../core/pairing.ts");
    const stranger = formatPairing({ ...parsePairing(key), secret: new Uint8Array(32).fill(9) });

    const second = await load();
    await expect(second.plugin.pair(stranger, "phone")).rejects.toThrow(/auth/i);
    expect(second.plugin.paired).toBe(false);
    expect(second.plugin.savedData, "a refused pairing was left on disk").toBe(null);
  }, 300_000);

  it("shows the recovery key once when a vault is started, and says to write it down", async () => {
    await fresh();
    const { plugin } = await load();
    choosePairing(plugin, "first");
    built.find((s) => s.name === "Invite or setup line")!.texts[0]!.type(server.setup);
    built.find((s) => s.name === "Device name")!.texts[0]!.type("laptop");
    // Not awaited yet. The pairing now holds the vault's claim until somebody
    // says they have the key (R02), so awaiting the click here would wait for
    // the acknowledgement clicked further down.
    const starting = built
      .find((s) => s.buttons.some((b) => b.label === "Start a new vault"))!
      .buttons.find((b) => b.label === "Start a new vault")!
      .click();
    await until("the recovery key to be shown", () => panelText().includes("Write this down"));

    const shown = panelText();
    expect(shown).toMatch(/Write this down/);
    expect(shown).toMatch(/somewhere safe and separate/);
    expect(shown).toMatch(/only way back/);
    expect(shown).toMatch(/Anyone with it can access your vault/);
    // The key itself, taken off the screen, because this is the one moment it
    // exists anywhere: no device keeps it and nothing reprints it.
    const key = shown.split(/\s+/).find((w) => w.startsWith("basalt3_"))!;
    expect(key, "no recovery key was shown").toBeDefined();
    const beforeScan = modals.length;
    plugin.protocolHandlers.get(INVITE_ACTION)!({ invite: "basalt3i_invalid" });
    expect(modals).toHaveLength(beforeScan);
    expect(notices.at(-1)!.message).toMatch(/pairing is already in progress/);
    expect(plugin.pendingFirstPairing()).toBe(key);

    // And a way to get it off the device, which is the whole point of showing
    // it. "Write it down" is hardest to follow exactly where this plugin is
    // most used: a phone has no second screen to read from, and the paragraph
    // was not selectable because Obsidian turns selection off across its UI. So
    // the button copies, and it copies the key rather than anything near it.
    const copied: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async (t: string) => {
          copied.push(t);
        },
      },
    });
    try {
      // Copy is on the key's own row now, beside the key, and the
      // acknowledgement is a row of its own: a button that dismisses the only
      // copy of a secret should not sit a thumb's width from one that does not.
      const copy = built.flatMap((s) => s.buttons).find((b) => b.label === "Copy");
      expect(copy, "the recovery key was shown with no way to copy it").toBeDefined();
      await copy!.click();
      expect(copied, "Copy did not put the recovery key on the clipboard").toEqual([key]);
    } finally {
      vi.unstubAllGlobals();
    }

    // Acknowledged, it is gone from the panel, and reopening does not bring
    // it back on its own.
    await built
      .find((s) => s.buttons.some((b) => b.label === "I have written it down"))!
      .buttons.find((b) => b.label === "I have written it down")!
      .click();
    // And now the pairing may finish.
    await starting;
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(key);
    modals.at(-1)!.close();
    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(key);
    await synced(plugin);
  }, 300_000);

  /**
   * The panel closed while the key is on screen and nothing has been claimed.
   *
   * The handoff is a wait, and a wait needs an answer for every way out of it.
   * `teardown` cleared the key and emptied the host and left the promise the
   * pairing is awaiting pending for ever, so `onePairing` never let go: the
   * plugin refused every later attempt with "a pairing is already in
   * progress", for the life of the session, and the only way out was reloading
   * it. Nothing was lost, because the root is on disk before the wait, and
   * nothing worked either.
   *
   * Abandoning has to be an outcome. The pairing ends, says why, and the next
   * load finds the root in the config and offers the key again.
   */
  it("lets go when the panel is closed instead of acknowledged", async () => {
    await fresh();
    const { plugin } = await load();

    choosePairing(plugin, "first");
    built.find((s) => s.name === "Invite or setup line")!.texts[0]!.type(server.setup);
    const starting = built
      .find((s) => s.buttons.some((b) => b.label === "Start a new vault"))!
      .buttons.find((b) => b.label === "Start a new vault")!
      .click();
    await until("the recovery key to be shown", () =>
      built.some((s) => s.buttons.some((b) => b.label === "I have written it down")),
    );

    // Closed rather than acknowledged, which is what somebody does when they
    // are interrupted or think they are done.
    modals.at(-1)!.close();

    // The click's promise settles rather than hanging on a wait nothing will
    // ever answer. Bounded, because the way this regresses is by never
    // finishing, and a test that hangs reports a timeout rather than a reason.
    await settles(starting, "the pairing is still waiting for an acknowledgement nobody can give");

    // The key is on disk, which is what makes abandoning cost nothing.
    expect(
      plugin.pendingFirstPairing(),
      "the root is not on disk, so the interrupted pairing lost the key",
    ).toBeDefined();

    // And the vault is *pairable*, which is a different claim and the one that
    // was not being made. `paired` meant "a config exists", and `pairFirst`
    // writes the root before it shows the key, so an abandoned pairing read as
    // paired: the panel drew the whole synced interface over a vault that will
    // never connect, and every retry was answered "this vault is already
    // paired", which is untrue and names no way out.
    expect(plugin.paired, "an abandoned first pairing reads as a paired vault").toBe(false);
    expect(plugin.currentState.kind).toBe("unpaired");

    choosePairing(plugin, "first");
    // The key is offered again, from the config, next to the form that lets
    // somebody start over.
    await until("the key to be offered again", () =>
      built.some((s) => s.buttons.some((b) => b.label === "I have written it down")),
    );
    expect(
      built.some((s) => s.name === "Invite or setup line"),
      "there is no way to try again: the panel offers no pairing form",
    ).toBe(true);
    await built
      .find((s) => s.buttons.some((b) => b.label === "I have written it down"))!
      .buttons.find((b) => b.label === "I have written it down")!
      .click();

    // And starting over actually works, rather than being refused.
    choosePairing(plugin, "first");
    built.find((s) => s.name === "Invite or setup line")!.texts[0]!.type(server.setup);
    const start = built
      .find((s) => s.buttons.some((b) => b.label === "Start a new vault"))!
      .buttons.find((b) => b.label === "Start a new vault")!;
    // Cleared here, so what appears below is the render this click causes and
    // not the one that drew the key from the abandoned attempt. Waiting on the
    // stale one acknowledges a promise nothing is holding, and the pairing
    // then waits for ever on the promise it makes a moment later.
    built.length = 0;
    const again = start.click();
    await until("the recovery key of the second attempt", () =>
      built.some((s) => s.buttons.some((b) => b.label === "I have written it down")),
    );
    await built
      .find((s) => s.buttons.some((b) => b.label === "I have written it down"))!
      .buttons.find((b) => b.label === "I have written it down")!
      .click();
    await settles(again, "the second pairing never finished");
    expect(plugin.paired, "the vault could not be paired after an abandoned attempt").toBe(true);
    await synced(plugin);
  }, 300_000);

  it("says where the recovery key is rather than offering to show it", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();

    const key = keyOf(plugin);
    expect(modals.at(-1)!.contentEl.allText(), "the key was on screen unasked").not.toContain(key);
    const setting = built.find((s) => s.name === "Recovery key")!;
    // After the handoff, the panel explains that this device has no saved key.
    expect(panelText()).toMatch(/Not stored on this device/);
    expect(panelText()).toMatch(/Keep your saved copy safe/);
    expect(setting.buttons, "the panel offers to show a key it does not have").toEqual([]);
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(key);
  }, 300_000);

  it("shows both cursors in the panel (I11)", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("one.md", "1");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await until("the cursor to move", () => (plugin.cursors()?.local ?? 0) > 0);

    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const shown = modals.at(-1)!.contentEl.allText();
    const at = plugin.cursors()!;
    expect(at.local).toBeGreaterThan(0);
    expect(shown).toContain(`Local cursor ${at.local}, server cursor ${at.server}.`);
    // Not `at.server` against itself: reading the panel's own source proves
    // only that it is consistent, and the number was frozen at hello for as
    // long as this test has existed. This device has just uploaded and
    // caught up, so the server holds what it holds.
    expect(at.server, "the server cursor was stale").toBe(at.local);
  }, 300_000);
});

/**
 * The pairing form's device name, and the connection line under the status.
 *
 * Both are the same complaint from the same evening: the panel is the whole
 * interface, and it was not saying two things it already knew. It knew what
 * kind of machine it was running on and offered nothing, so every device was
 * called after the app. It knew the address, the protocol and the server's
 * build, and said "up to date, cursor 66".
 */
describe("what the panel knows and used to keep to itself", () => {
  /** The pairing form's name field, from the last render. */
  const nameField = () => built.find((s) => s.name === "Device name")!.texts[0]!;

  it("suggests a name for this device, and pairs under it", async () => {
    await fresh();
    const { plugin } = await load();
    Platform.isMacOS = true;
    try {
      // Either path draws the name field, since it is shared; this one is the
      // one the rest of the test uses.
      choosePairing(plugin, "first");
      // In the field, not behind it as a placeholder. A placeholder is not a
      // value: the field was empty and so was what got used.
      const suggested = nameField().getValue();
      expect(suggested).toMatch(/^mac-[0-9a-f]{4}$/);

      built.find((s) => s.name === "Invite or setup line")!.texts[0]!.type(server.setup);
      // The pairing holds until the key is acknowledged (R02), so the
      // acknowledgement comes before the await.
      const starting = built
        .find((s) => s.buttons.some((b) => b.label === "Start a new vault"))!
        .buttons.find((b) => b.label === "Start a new vault")!
        .click();
      await until("the recovery key to be shown", () =>
        built.some((s) => s.buttons.some((b) => b.label === "I have written it down")),
      );
      await built
        .find((s) => s.buttons.some((b) => b.label === "I have written it down"))!
        .buttons.find((b) => b.label === "I have written it down")!
        .click();
      await starting;
      await synced(plugin);

      // Used, and used where it is read: the row in the device list, which is
      // what somebody looks at before revoking one.
      expect(plugin.deviceName).toBe(suggested);
      const { devices } = await plugin.devices();
      expect(devices.map((d) => d.name)).toEqual([suggested]);
    } finally {
      Platform.isMacOS = false;
    }
  }, 300_000);

  it("does not call an iPad a Mac", async () => {
    await fresh();
    const { plugin } = await load();
    // obsidian.d.ts: isMacOS is true on "a device that pretends to be one
    // (like iPhones and iPads)". Checked in the wrong order, every iPad in
    // the device list is a Mac.
    Platform.isIosApp = true;
    Platform.isTablet = true;
    Platform.isMacOS = true;
    try {
      choosePairing(plugin, "first");
      expect(nameField().getValue()).toMatch(/^ipad-[0-9a-f]{4}$/);
    } finally {
      Platform.isIosApp = false;
      Platform.isTablet = false;
      Platform.isMacOS = false;
    }
  }, 300_000);

  it("says what it is connected to, with the protocol and the server's build", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const shown = modals.at(-1)!.contentEl.allText();
    const to = plugin.connection()!;
    // The address this device actually holds, rather than the one this test
    // knows: a panel that agreed with the test and not with the config would
    // be the bug.
    expect(to.url).toBe(server.wsUrl);
    expect(shown).toContain(`Connected to ${server.wsUrl}`);
    // From `ready` and nowhere else, and both of them present: an absent
    // build is what a server that never answered looks like.
    expect(to.server!.proto).toBe(PROTO);
    // Not "unknown", which is what `readReady` puts there when the server did
    // not say. A panel showing the fallback as a build is the failure this
    // line exists for, and it reads exactly like a build.
    expect(to.server!.version, "the build is the fallback, not what ready said").not.toBe(
      "unknown",
    );
    expect(shown).toContain(`Protocol ${PROTO}, telimus ${to.server!.version}.`);
    expect(shown).not.toContain("Not connected");
    // An unencrypted connection shows its warning in the server details.
    expect(panelText()).toMatch(/notes are still sealed, the device credential is not/);
    expect(panelText()).toMatch(/the device credential is not/);
  }, 300_000);

  it("says the protocol and the build are unknown rather than leaving a gap", () => {
    // Rule 2 at the width of a sentence: a build missing because nothing is
    // connected reads exactly like a server that did not say, and they are
    // different states.
    const off = describeConnection({ url: "wss://homelab.tailnet.ts.net" });
    expect(off).toContain("Not connected to wss://homelab.tailnet.ts.net");
    expect(off).not.toMatch(/telimus/);
    expect(off).not.toMatch(/Protocol/);

    const on = describeConnection({
      url: "wss://homelab.tailnet.ts.net",
      server: { proto: 4, version: "0.3.4" },
    });
    expect(on).toContain("Protocol 4, telimus 0.3.4.");
    // The scheme is the whole of what is known about the hop, and wss is the
    // only thing that says something terminated TLS in front.
    //
    // One line, and nothing at all when the hop is protected. This used to
    // spend three sentences on what encryption covers and where to read more,
    // in a panel whose last row is a link to that guide.
    expect(connectionDetail({ url: "wss://homelab.tailnet.ts.net" })).toBe("");
    expect(connectionDetail({ url: "ws://192.168.1.20:3003" })).toMatch(
      /notes are still sealed, the device credential is not/,
    );
  });
});

/**
 * The device list in the panel, which is the only device management a plugin
 * device has.
 */
describe("changing the server address", () => {
  it("waits for a pending rename save before unlinking and refuses an overlapping address edit", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    let forgotten = false;
    const save = plugin.saveData.bind(plugin);
    plugin.saveData = async (data: unknown) => {
      if (data !== null) {
        saving = true;
        await gate;
      } else forgotten = true;
      await save(data);
    };
    const renaming = plugin.renameDevice("renamed laptop").catch((err: Error) => err);
    await until("the rename save to begin", () => saving);
    await expect(plugin.changeServerAddress(server.wsUrl)).rejects.toThrow(/in progress/);
    const unlinking = plugin.unlink();
    try {
      await nextTurn();
      expect(forgotten, "unlink forgot the pairing before its pending save finished").toBe(false);
    } finally {
      release();
      await unlinking;
      await renaming;
    }
    expect(plugin.savedData).toBe(null);
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });

  it("moves to the same server on a new port without resetting credentials, notes, or history", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    const saved = structuredClone(plugin.savedData) as Record<string, unknown>;
    const cursor = plugin.cursors()!.local;
    expect(cursor).toBeGreaterThan(0);
    const index = await app.vault.adapter.read(".obsidian/plugins/telimus/index.json");
    await server.stop();
    await server.start();
    expect(server.wsUrl).not.toBe(saved["url"]);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const setting = built.find((s) => s.name === "Server address")!;
    setting.texts[0]!.type(`  ${server.wsUrl.replace("ws://", "http://")}/  `);
    await setting.buttons[0]!.click();
    await synced(plugin);
    expect(plugin.connection()!.url).toBe(server.wsUrl);
    expect(plugin.savedData).toEqual({ ...saved, url: server.wsUrl });
    expect(plugin.cursors()!.local).toBe(cursor);
    expect(await app.vault.adapter.read(".obsidian/plugins/telimus/index.json")).toBe(index);
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
    const peer = await load(plugin.savedData);
    await synced(peer.plugin);
    expect(await peer.app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });

  it("refuses another server without changing the current pairing or notes", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    const saved = structuredClone(plugin.savedData);
    const other = new TestServer();
    await other.start();
    try {
      await expect(plugin.changeServerAddress(other.wsUrl)).rejects.toThrow();
      expect(plugin.savedData).toEqual(saved);
      expect(plugin.connection()!.url).toBe(server.wsUrl);
      expect(plugin.currentState.kind).toBe("synced");
      expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
    } finally {
      await other.cleanup();
    }
  });

  it("cannot restore a pairing when unlinked during the address save", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    await server.stop();
    await server.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    const save = plugin.saveData.bind(plugin);
    plugin.saveData = async (data: unknown) => {
      if (data !== null) {
        saving = true;
        await gate;
      }
      await save(data);
    };
    const changing = plugin.changeServerAddress(server.wsUrl).catch((err: Error) => err);
    await until("the new address save to begin", () => saving);
    const unlinking = plugin.unlink();
    release();
    await unlinking;
    expect(await changing).toBeInstanceOf(Error);
    expect(plugin.savedData).toBe(null);
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(await app.vault.adapter.exists(".obsidian/plugins/telimus/index.json")).toBe(false);
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });
});

describe("the device list in the panel", () => {
  it("keeps the current device list visible during refresh and after a failed refresh", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const button = built.find((s) => s.name === "Devices")!.buttons[0]!;
    await button.click();
    const oldRow = built.find((s) => s.name.startsWith("laptop"))!.settingEl;
    const panel = modals.at(-1)!.contentEl;
    let reject!: (error: Error) => void;
    const request = new Promise<Awaited<ReturnType<Testable["devices"]>>>((_, fail) => {
      reject = fail;
    });
    vi.spyOn(plugin, "devices").mockReturnValueOnce(request);
    const refreshing = button.click();
    expect(containsElement(panel, oldRow), "refresh removed the visible list").toBe(true);
    expect(button.disabled).toBe(true);
    reject(new Error("connection interrupted"));
    await refreshing;
    expect(containsElement(panel, oldRow)).toBe(true);
    expect(button.disabled).toBe(false);
    expect(panelText()).toContain("connection interrupted");
  });
  it("keeps the last device registered and the list concise", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();

    const row = built.find((s) => s.name.startsWith("laptop"))!;
    expect(row, "the panel did not list this device").toBeDefined();
    expect(
      row.buttons.map((b) => b.label),
      "the last row offered a button that cannot work",
    ).toEqual([]);

    expect(built.find((s) => s.name === "Devices")!.desc).toBe("1 device");
    expect(row.desc).toBe("Received latest changes");
    expect(row.desc).not.toContain((await plugin.devices()).thisDevice);
    expect(panelText()).not.toMatch(/--allow-last|Revoking stops|at most/);
    expect(built.find((s) => s.name === "Unlink this vault")!.buttons[0]!.label).toBe("Unlink");
    // And the row is still there, because nothing was pressed and nothing was
    // sent: a panel that said this while the vault emptied itself would be
    // worse than one that said nothing.
    expect((await plugin.devices()).devices).toHaveLength(1);
  }, 300_000);

  /**
   * An invite that has not been redeemed is on screen beside the rows, and can
   * be cancelled from there.
   *
   * It was the one authority on a vault nothing could see. What the panel must
   * never show is the invite string itself, and it cannot: the server never
   * had the invite key, so what comes back is an identifier that redeems
   * nothing and says which invite to cancel.
   */
  it("puts the device rows under the Devices row, not above it", async () => {
    // Twice now the panel has grown a list that rendered above the setting
    // that fills it, so the rows read as belonging to whatever sat above.
    // Both times a screenshot found it and no test did, which is why this
    // one exists.
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const heading = built.find((s) => s.name === "Devices")!;
    await heading.buttons[0]!.click();
    await until("the list to arrive", () => built.some((s) => s.name.includes("laptop")));

    // The stub does not render a setting's name into the DOM, so position is
    // the thing to assert: the container the rows are built into must come
    // after the row that offers them. Both are inside the Manage disclosure,
    // named rather than taken as the first `<details>`, because the panel has
    // a second one for the server's numbers now.
    const manage = modals
      .at(-1)!
      .contentEl.children.filter((el) => el.tag === "details")
      .find((el) => el.children[0]?.text === "Manage this vault");
    expect(manage, "the panel has no disclosure to manage the vault from").toBeDefined();
    const kids = manage!.children.find((el) => el.cls === "setting-group")!.children[0]!.children;
    const row = built.find((b) => b.name.includes("laptop"))!;
    const at = kids.indexOf(heading.settingEl);
    const listAt = kids.findIndex((el) => el.children.includes(row.settingEl));
    expect(at, "the Devices row is not in the panel").toBeGreaterThanOrEqual(0);
    expect(listAt, "no container held the device rows").toBeGreaterThanOrEqual(0);
    expect(listAt, "the device rows rendered above the row that lists them").toBeGreaterThan(at);
  }, 300_000);

  it("shows outstanding invites beside the devices, and cancels one", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const issued = await first.plugin.createInvite();

    built.length = 0;
    first.plugin.commands.find((c) => c.id === "show-status")!.callback!();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();
    await until("the list to arrive", () => built.some((s) => s.name === "Outstanding invite"));

    const row = built.find((s) => s.name === "Outstanding invite")!;
    expect(row.desc).toMatch(/^Expires /);
    // Never the string, which is the only thing that could redeem it.
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(issued.invite);

    await row.buttons.find((b) => b.label === "Cancel")!.click();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/can no longer add a device/);
    expect((await first.plugin.devices()).invites).toHaveLength(0);

    // And the string it cancelled no longer pairs anything.
    const second = await load();
    await expect(second.plugin.pair(issued.invite, "phone")).rejects.toThrow(/auth/i);
    expect(second.plugin.savedData, "a cancelled invite left a pairing on disk").toBe(null);
  }, 300_000);

  /**
   * A row nothing ever connected under is flagged, because it is the
   * reclaimable one.
   *
   * A redemption registers the row before the new device saves anything, so a
   * crash in that window strands a row rather than a device that believes it
   * is paired: the right way round, and the reason the rows that fill the cap
   * are the ones nothing signed in under. The panel says so rather than
   * leaving it to be inferred from a missing date.
   */
  it("flags a row nothing has ever connected under", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // A pairing that reached the server and then crashed.
    const issued = await first.plugin.createInvite();
    await redeemInvite(parseInvite(issued.invite), "the-one-that-crashed");

    built.length = 0;
    first.plugin.commands.find((c) => c.id === "show-status")!.callback!();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();
    await until("the list to arrive", () =>
      built.some((s) =>
        /Received latest changes|delivery unconfirmed|Waiting for latest changes|Never connected/.test(
          s.desc,
        ),
      ),
    );

    const stranded = built.find((s) => s.name === "the-one-that-crashed")!;
    expect(stranded, "the panel did not list the stranded row").toBeDefined();
    expect(stranded.desc).toBe("Never connected");
    // And this device, which has connected, is not flagged: a marker on every
    // row says nothing.
    expect(built.find((s) => s.name.startsWith("laptop"))!.desc).toBe("Received latest changes");
    expect(built.find((s) => s.name === "Devices")!.desc).toBe("2 devices");
  }, 300_000);

  /**
   * The ordinary case, which stays a device's to do: a phone cuts off a stolen
   * laptop without anybody finding the recovery key. Two presses, and the
   * second one means it.
   */
  it("revokes another device, behind a second press", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const invite = (await first.plugin.createInvite()).invite;
    const second = await load();
    await second.plugin.pair(invite, "phone");
    await synced(second.plugin);

    built.length = 0;
    first.plugin.commands.find((c) => c.id === "show-status")!.callback!();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();
    const row = built.find((s) => s.name === "phone")!;
    const button = row.buttons[0]!;
    expect(button.label).toBe("Revoke");

    // One press asks, and changes nothing.
    await button.click();
    expect(button.label).toBe("Yes, revoke");
    expect((await first.plugin.devices()).devices).toHaveLength(2);
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/will stop syncing/);
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/keeps its decryption key/);
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/can still read copies of your notes/);

    // The second does it, and the revoked device finds out by being stopped.
    await button.click();
    expect((await first.plugin.devices()).devices.map((d) => d.name)).toEqual(["laptop"]);
    expect(notices.map((n) => n.message).join(" ")).toMatch(
      /Existing notes on that device are kept/,
    );
    await until(
      "the revoked device to be stopped",
      () => second.plugin.currentState.kind === "stopped",
    );
  }, 300_000);

  it("keeps devices with the same name distinguishable before revocation", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "phone");
    await synced(first.plugin);
    const second = await load();
    await second.plugin.pair((await first.plugin.createInvite()).invite, "phone");
    await synced(second.plugin);
    built.length = 0;
    first.plugin.commands.find((c) => c.id === "show-status")!.callback!();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();
    const listed = await first.plugin.devices();
    for (const device of listed.devices) {
      const name = device.id === listed.thisDevice ? "phone (this device)" : "phone";
      expect(built.find((s) => s.name === name)!.desc).toContain(`ID ${device.id}`);
    }
  }, 300_000);
});

/**
 * A server restored from an older backup, and the way a plugin device gets
 * back onto it (I10, improvements.md §5).
 *
 * The documented path for a plugin device was to unlink and pair again, which
 * works and costs the merge base: every note returns as an ancestor-less new
 * version, so the next edit made on two devices at once cannot merge and makes
 * conflict copies instead. The headless client has had `telimus rebase` for
 * this since I10; the plugin had the blunt tool on the devices least able to
 * clear up after it.
 *
 * What is asserted here is not that the two ends agree (rule 10). It is that
 * the note only this device holds is on another device afterwards, and that
 * the note the backup did hold is still there too.
 */
describe("rejoining a server that lost history (I10, plugin)", () => {
  it("does not rejoin a pairing unlinked while its cursor probe was pending", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    let answer!: (value: { local: number; server: number }) => void;
    const probing = new Promise<{ local: number; server: number }>((resolve) => {
      answer = resolve;
    });
    vi.spyOn(plugin, "rejoinCursors").mockReturnValueOnce(probing);
    const rejoining = plugin.rebase().catch((err: Error) => err);
    await plugin.unlink();
    answer({ local: 2, server: 1 });
    expect(await rejoining).toBeInstanceOf(Error);
    expect(plugin.savedData).toBe(null);
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(await app.vault.adapter.exists(".obsidian/plugins/telimus/index.json")).toBe(false);
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });

  it("waits for the rejoin index reset before finishing unlink", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    vi.spyOn(plugin, "rejoinCursors").mockResolvedValueOnce({ local: 2, server: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resetting = false;
    const remove = ObsidianIndexStore.prototype.remove;
    vi.spyOn(ObsidianIndexStore.prototype, "remove").mockImplementationOnce(async function (
      this: ObsidianIndexStore,
    ) {
      resetting = true;
      await gate;
      await remove.call(this);
    });
    const rejoining = plugin.rebase().catch((err: Error) => err);
    await until("the rejoin index reset", () => resetting);
    let unlinked = false;
    const unlinking = plugin.unlink().then(() => {
      unlinked = true;
    });
    try {
      await nextTurn();
      expect(
        unlinked,
        "unlink returned while rejoin could still remove its next pairing's index",
      ).toBe(false);
    } finally {
      release();
      await unlinking;
      await rejoining;
    }
    expect(await rejoining).toBeInstanceOf(Error);
    expect(plugin.savedData).toBe(null);
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(await app.vault.adapter.exists(".obsidian/plugins/telimus/index.json")).toBe(false);
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });

  it("finishes unlink after an in-flight rejoin reset fails", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    vi.spyOn(plugin, "rejoinCursors").mockResolvedValueOnce({ local: 2, server: 1 });
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((_, reject) => {
      fail = reject;
    });
    let resetting = false;
    vi.spyOn(ObsidianIndexStore.prototype, "remove").mockImplementationOnce(async () => {
      resetting = true;
      await gate;
    });
    const rejoining = plugin.rebase().catch((err: Error) => err);
    await until("the rejoin index reset", () => resetting);
    const unlinking = plugin.unlink();
    // Quiet has begun waiting for the reset when its write reports failure.
    await nextTurn();
    fail(new Error("temporary reset error"));
    await unlinking;
    expect(await rejoining).toBeInstanceOf(Error);
    expect(plugin.savedData).toBe(null);
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(await app.vault.adapter.exists(".obsidian/plugins/telimus/index.json")).toBe(false);
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });

  it("closes a rejoin connection when unlink interrupts its handshake", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("kept.md", "my original note\n");
    await startVault(plugin);
    await synced(plugin);
    vi.spyOn(plugin, "rejoinCursors").mockResolvedValueOnce({ local: 2, server: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let connecting: Client | undefined;
    const connect = Client.prototype.connect;
    vi.spyOn(Client.prototype, "connect").mockImplementationOnce(async function (
      this: Client,
      opts,
    ) {
      const limits = await connect.call(this, opts);
      connecting = this;
      await gate;
      return limits;
    });
    const rejoining = plugin.rebase().catch((err: Error) => err);
    await until("the rejoin connection", () => connecting !== undefined);
    const closing = vi.spyOn(connecting!, "close");
    try {
      await plugin.unlink();
      expect(closing, "unlink did not close the rejoin connection").toHaveBeenCalled();
    } finally {
      release();
      await rejoining;
    }
    expect(await rejoining).toBeInstanceOf(Error);
    expect(plugin.savedData).toBe(null);
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(await app.vault.adapter.exists(".obsidian/plugins/telimus/index.json")).toBe(false);
    expect(await app.vault.adapter.read("kept.md")).toBe("my original note\n");
  });

  /** A copy of the server's data directory, taken with the server stopped. */
  async function backupServer(): Promise<string> {
    const { cp } = await import("node:fs/promises");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "telimus-plugin-backup-"));
    await server.whileStopped(async () => {
      await cp(server.dataDir, dir, { recursive: true });
    });
    return dir;
  }

  async function restoreServer(from: string): Promise<void> {
    const { cp, rm } = await import("node:fs/promises");
    await server.whileStopped(async () => {
      await rm(server.dataDir, { recursive: true, force: true });
      await cp(from, server.dataDir, { recursive: true });
    });
  }

  it("names the recovery, offers it behind two presses, and loses nothing", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("before.md", "in the backup\n");
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    await until("before.md to reach the server", () => (first.plugin.cursors()?.local ?? 0) > 0);

    const backup = await backupServer();

    // Written after the backup, so it is the note only this device holds.
    first.app.vault.adapter.seed("after.md", "written after the backup\n");
    await first.plugin.syncNow();
    await until("after.md to reach the server", () => (first.plugin.cursors()?.local ?? 0) > 1);
    const ahead = first.plugin.cursors()!.local;

    await restoreServer(backup);

    // The server is behind this device now, and refuses it for good.
    await until(
      "the cursor refusal",
      () => first.plugin.currentState.kind === "stopped",
      60_000,
    ).catch((err: Error) => {
      throw new Error(`${err.message}; the state is ${JSON.stringify(first.plugin.currentState)}`);
    });
    const stopped = first.plugin.currentState;
    expect(stopped.kind === "stopped" && stopped.recovery).toBe("rejoin");
    // The reason names the way out, rather than a documentation path (I10).
    expect(status(first.plugin)).toMatch(/telimus rebase --backup-taken/);
    expect(status(first.plugin)).toMatch(/Rejoin this server/);
    expect(status(first.plugin)).toMatch(/conflict copies instead of merging/);
    expect(notices.map((n) => n.message).join("\n")).toMatch(/telimus rebase --backup-taken/);

    // The panel offers it, and the first press is a question rather than an
    // answer: nothing has been touched by it.
    built.length = 0;
    first.plugin.commands.find((c) => c.id === "show-status")!.callback!();
    const row = built.find((s) => s.name === "Rejoin this server")!;
    expect(row, "the panel offered no way back").toBeDefined();
    expect(panelText()).toMatch(/local notes are kept/);
    // On the panel itself, never behind the disclosure: a device the server
    // has refused has to say so, and offer the way out, on open.
    const panel = modals.at(-1)!.contentEl;
    expect(containsElement(panel, row.settingEl)).toBe(true);
    for (const disclosure of panel.children.filter((el) => el.tag === "details")) {
      expect(
        containsElement(disclosure, row.settingEl),
        "the way back off a refused device is behind a disclosure",
      ).toBe(false);
    }
    const button = row.buttons[0]!;
    expect(button.warning, "a destructive action with no warning on it").toBe(true);
    await button.click();
    expect(modals.at(-1)!.contentEl.allText()).toContain(
      `This device is at version ${ahead} and the server is at`,
    );
    expect(button.label).toBe("Yes, rejoin");
    expect(first.plugin.paired, "the first press unpaired the vault").toBe(true);

    await button.click();
    await synced(first.plugin);

    // What only this device held is on the server again, as a second device
    // joining from scratch shows, and so is what the backup already had.
    const second = await load();
    await second.plugin.pair(keyOf(first.plugin), "phone");
    await synced(second.plugin);
    await until(
      "both notes to arrive",
      () =>
        second.app.vault.adapter.text("before.md") !== undefined &&
        second.app.vault.adapter.text("after.md") !== undefined,
    );
    expect(second.app.vault.adapter.text("after.md")).toBe("written after the backup\n");
    expect(second.app.vault.adapter.text("before.md")).toBe("in the backup\n");
  }, 300_000);

  it("refuses a rejoin on a device that is not ahead, and keeps syncing", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "one\n");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await expect(plugin.rebase()).rejects.toThrow(/nothing to rebase/);

    // Refused before anything was touched: the index is still there, so the
    // next pass has nothing to re-upload.
    app.vault.adapter.seed("second.md", "two\n");
    await plugin.syncNow();
    const report = plugin.currentState;
    expect(report.kind).toBe("synced");
    expect(plugin.paired).toBe(true);
  }, 300_000);
});

/**
 * A recovery key on screen is not a recovery key somebody has (R02).
 *
 * Starting a vault writes the root to disk, shows it, claims the server, and
 * then replaces the root with this device's own credential. F02 moved the
 * display in front of the claim, which was the important half. What it did not
 * change is that showing it and carrying straight on is not a handoff:
 * registration retires the only copy of a key nothing can reissue, and
 * returning from a callback is not evidence that anybody read the screen.
 *
 * Two things make it a stage. The pairing waits for the callback, so a surface
 * that asks for confirmation holds the vault's claim until it has one; and
 * because nothing is claimed while it waits, an abandoned pairing leaves the
 * root on disk where the panel finds it and offers it again.
 */
describe("handing over the first recovery key", () => {
  it("does not claim the vault until the key has been taken", async () => {
    await fresh();
    const { plugin } = await load();

    let release: (() => void) | undefined;
    const offered = deferred<string>();
    let shown = "";
    const pairing = plugin
      .pairFirst(server.setup, "laptop", async (key: string) => {
        shown = key;
        offered.resolve(key);
        await new Promise<void>((go) => {
          release = go;
        });
      })
      .catch(() => undefined);

    // Wait for the key to be offered.
    await offered.promise;
    expect(shown, "no key was offered before the claim").toMatch(/^basalt3_/);

    // Still waiting, so nothing has been registered: the config holds the root
    // and no device credential.
    await nextTurn();
    expect(
      plugin.pendingFirstPairing(),
      "the pairing went ahead before anybody said they had the key",
    ).toBe(shown);

    release?.();
    await pairing;
  }, 60_000);

  /**
   * The abandoned case, which is what a reload in the middle looks like.
   *
   * Nothing was claimed, so the config still holds the root, and the root is
   * the recovery key. The panel offers it rather than leaving somebody with a
   * key they were shown once and a vault they cannot open.
   */
  it("can still produce the key after an interrupted pairing", async () => {
    await fresh();
    const { plugin } = await load();

    const offered = deferred<string>();
    let shown = "";
    void plugin
      .pairFirst(server.setup, "laptop", async (key: string) => {
        shown = key;
        offered.resolve(key);
        await new Promise<void>(() => {}); // the panel was closed
      })
      .catch(() => undefined);
    await offered.promise;

    const again = plugin.pendingFirstPairing();
    expect(again, "an interrupted pairing left no way back to the key").toBeDefined();
    expect(again, "the key offered afterwards is not the one that was shown").toBe(shown);
    expect(() => parsePairing(again!)).not.toThrow();
  }, 60_000);

  /** A finished pairing holds no root, so there is nothing to offer. */
  it("offers nothing once the device has its own credential", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin);
    expect(
      plugin.pendingFirstPairing(),
      "a paired device is still holding the vault's root",
    ).toBeUndefined();
  }, 60_000);
});

/**
 * A restore is reported sent only when the server has said so (R09).
 *
 * The check was "is this path in the report's list of failures", and those
 * lists are display samples: sorted, de-duplicated and cut to five, because a
 * notice naming four hundred files is not a notice. Absence from a sample is
 * not evidence of anything. A pass with six failures reported the sixth as
 * sent, and a path that was merely blocked was never in either list at all.
 */
describe("what a restore is allowed to claim", () => {
  it("does not report sent for the sixth failure of a pass", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin);
    const held = plugin as unknown as {
      client?: {
        engine: { serverHasOurs(p: string): boolean };
        history(p: string): Promise<unknown[]>;
      };
    };
    await until("the client to exist", () => held.client !== undefined);

    // A real note with a real version to restore, so the restore succeeds and
    // the code actually reaches the decision under test.
    await app.vault.adapter.write("z.md", "the version to restore\n", { mtime: 5000 });
    await plugin.syncNow();
    await until("z.md to be acknowledged", () => held.client!.engine.serverHasOurs("z.md"));
    await app.vault.adapter.remove("z.md");
    await plugin.syncNow();

    const versions = (await held.client!.history("z.md")) as Array<{
      path: string;
      uid: number;
      deleted?: boolean;
    }>;
    // The newest is the deletion; what restores is the version before it.
    const version = versions.find((v) => v.uid > 0 && v.deleted !== true);
    expect(version, "the server holds no version of z.md to restore").toBeDefined();

    // A report shaped exactly as the engine produces one: more failures than
    // the sample holds, and the restored path is not among the five shown.
    // `z.md` sorts after all of them, so it is exactly the one the display
    // cannot show.
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      conflicted: 0,
      deletedLocally: 0,
      deletedRemotely: 0,
      restored: 1,
      foldersCreated: 0,
      unchanged: 0,
      waiting: 0,
      retrying: 6,
      retryingPaths: ["a.md", "b.md", "c.md", "d.md", "e.md"],
      skipped: 0,
      skippedPaths: [],
      ignored: 0,
      blocked: 0,
      inTheWay: [],
      needsAttention: [],
      chunksSent: 0,
      bytesSent: 0,
      reusedChunks: 0,
      heldBack: 0,
      heldBackPaths: [],
    };
    const client = held.client as unknown as { settle: () => Promise<SyncReport> };
    client.settle = async () => report;
    // And the engine must not have acknowledged the restored content, which is
    // the fact the decision turns on.
    (
      held.client as unknown as { engine: { serverHasOurs: (p: string) => boolean } }
    ).engine.serverHasOurs = () => false;

    const out = await (
      plugin as unknown as {
        restoreAndSend: (v: unknown) => Promise<{ sent: boolean; why?: string }>;
      }
    ).restoreAndSend.call(plugin, version);

    expect(
      out.sent,
      `a restore the server never acknowledged was reported as sent: ${JSON.stringify(out)}`,
    ).toBe(false);
    expect(out.why, "it did not say why").toBeTruthy();
  }, 90_000);

  /**
   * And the affirmative side: a note the server really has is reported sent,
   * so the check above is not simply refusing everything.
   */
  it("reports a note the server holds as sent", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin);
    await app.vault.adapter.write("kept.md", "the contents\n", { mtime: 5000 });
    const held = plugin as unknown as {
      client?: { engine: { serverHasOurs(p: string): boolean } };
    };
    await until("the client to exist", () => held.client !== undefined);
    await plugin.syncNow();
    await until("the note to be acknowledged", () => held.client!.engine.serverHasOurs("kept.md"));
    expect(
      held.client!.engine.serverHasOurs("kept.md"),
      "the note never reached the server, so this proves nothing",
    ).toBe(true);
  }, 60_000);
});

/**
 * A pairing that finishes after the plugin is gone must not restart it (R10).
 *
 * F23 guarded the invite branch. The recovery-key branch and the first-pairing
 * branch call `start()` after their registration returns without asking again,
 * and both had recovery paths that read the disk, which is another await, and
 * then started a loop from whatever they found. Unloading during any of that
 * left a retired plugin syncing.
 *
 * The credential the registration created is real either way; what must not
 * happen is a loop for a vault somebody has just put down.
 */
describe("a pairing that outlives the plugin", () => {
  /**
   * Unloaded in the window the review named: after the device credential has
   * been saved and before the registration returns.
   *
   * Earlier than that and `saveDuringRun` refuses the save, which is a guard
   * that already existed. This is the gap after it.
   */
  function unloadAfterCredentialSaved(plugin: Testable): void {
    const save = plugin.saveData.bind(plugin);
    plugin.saveData = async (data: unknown) => {
      await save(data);
      const record = data as { deviceId?: unknown } | null;
      if (record !== null && typeof record === "object" && record.deviceId !== undefined) {
        plugin.saveData = save;
        plugin.onunload();
      }
    };
  }

  it("does not start a loop after unload, pairing with a recovery key", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin);
    const key = keyOf(first.plugin);

    const second = await load();
    unloadAfterCredentialSaved(second.plugin);
    const out = await second.plugin.pair(key, "second").catch((err: Error) => err);

    expect(
      (second.plugin as unknown as { client?: unknown }).client,
      "an unloaded plugin was started by a pairing that finished after it",
    ).toBeUndefined();
    // And it says what happened rather than looking like an ordinary failure:
    // the row may be on the server.
    expect(out instanceof Error ? out.message : "", "it finished quietly").toMatch(
      /unlinked|no longer|revoke/i,
    );
  }, 90_000);

  it("does not start a loop after unload, starting a vault", async () => {
    await fresh();
    const { plugin } = await load();
    unloadAfterCredentialSaved(plugin);

    let shown = "";
    const out = await plugin
      .pairFirst(server.setup, "laptop", (k: string) => {
        shown = k;
      })
      .catch((err: Error) => err);

    expect(
      (plugin as unknown as { client?: unknown }).client,
      "an unloaded plugin was started by a pairing that finished after it",
    ).toBeUndefined();
    // The key has to reach somebody: the vault was claimed, and nothing else
    // holds it.
    const said = out instanceof Error ? out.message : "";
    expect(`${shown}|${said}`, "the recovery key was not offered anywhere").toMatch(/basalt3_/);
  }, 90_000);
});

/**
 * Rotation waits for the new key to be taken, exactly as first pairing does
 * (R24).
 *
 * The panel's rotation callback set the key, re-rendered, and returned, so the
 * request went out immediately. `rotateVault` documents its callback as the
 * step that makes everything after it survivable and awaits it; a callback
 * that returns before anybody has read the screen satisfies the type and not
 * the obligation.
 *
 * Rotation is the worse of the two to get wrong. It retires the key that was
 * written down, so a reload between the candidate appearing and somebody
 * copying it leaves a vault with no way back at all.
 */
describe("handing over a replacement recovery key", () => {
  it("does not send the rotation until the key has been taken", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin);
    const key = keyOf(plugin);

    let release: (() => void) | undefined;
    const offered = deferred<string>();
    let shown = "";
    const rotating = plugin
      .rotate(key, async (candidate: string) => {
        shown = candidate;
        offered.resolve(candidate);
        await new Promise<void>((go) => {
          release = go;
        });
      })
      .catch((err: Error) => err);

    await offered.promise;
    expect(shown, "no candidate was offered").toMatch(/^basalt3_/);

    // Still waiting, so the vault must still answer to the *old* key. That is
    // the direct observation: rotation retires it, and a device credential
    // keeps working either way, so asking the vault anything as a device
    // proves nothing at all.
    const { Registrar } = await import("../core/client.ts");
    const { parsePairing } = await import("../core/pairing.ts");
    const old = parsePairing(key);
    const stillOpens = await Registrar.open({
      url: old.url,
      vaultId: old.vaultId,
      device: "probe",
      secret: old.secret,
      timeoutMs: 10_000,
    })
      .then((r) => {
        r.close();
        return true;
      })
      .catch(() => false);
    expect(
      stillOpens,
      "the old recovery key had already been retired, so the rotation went out before " +
        "anybody said they had the new one",
    ).toBe(true);

    release?.();
    const out = await rotating;
    expect(out instanceof Error ? out.message : "rotated").toBeTruthy();
  }, 90_000);
});

describe("compact sync menu", () => {
  it("opens quick actions and pauses and resumes the live client", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const { Menu } = await import("./stub.ts");
    plugin.ribbonIcons[0]!.callback();
    expect(Menu.latest!.items.map((item) => item.label)).toContain("Sync activity");
    expect(Menu.latest!.items.map((item) => item.label)).toContain("Review conflicts");
    await Menu.latest!.items.find((item) => item.label === "Pause sync")!.click();
    await until("paused", () => plugin.currentState.kind === "paused");
    await until("pause drained", () => !(plugin as unknown as { pausing?: Promise<void> }).pausing);
    plugin.ribbonIcons[0]!.callback();
    await Menu.latest!.items.find((item) => item.label === "Resume sync")!.click();
    await synced(plugin);
  });
});

it("unload waits for a pause that is still draining writes", async () => {
  const { plugin } = await load();
  const pending = deferred<void>();
  const state = plugin as unknown as {
    config: unknown;
    client: { close(): Promise<void> };
    togglePause(): Promise<void>;
  };
  state.config = {};
  state.client = { close: () => pending.promise };
  const pause = state.togglePause();
  plugin.onunload();
  let drained = false;
  void plugin.closing?.then(() => {
    drained = true;
  });
  await nextTurn();
  expect(drained).toBe(false);
  pending.resolve();
  await pause;
  await plugin.closing;
  expect(drained).toBe(true);
});
