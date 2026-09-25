/**
 * The first-sync review, on a desktop where Settings is a window of its own.
 *
 * Seen 2026-09-24 in Obsidian 1.13.7 on a Mac: a vault that held notes was
 * paired again from Settings, the merge was confirmed, and the vault then sat
 * at "syncing" for good. The pass was waiting on "Review your first sync", and
 * no review was on screen. The same pairing on a Pixel showed it.
 *
 * Obsidian 1.13 opens Settings in its own window by default
 * (`settingsPopoutWindow`), and a modal is drawn in whichever window is
 * `activeWindow` when it opens. Pairing from Settings makes that the Settings
 * window, so the review was drawn inside it, and Settings sits entirely inside
 * the main window's bounds: the moment somebody clicked back into their notes
 * the review was behind the main window, still waiting, with the status bar
 * saying "Syncing notes." about a pass that would never move on its own.
 *
 * The stub's `Modal.open` records `activeWindow` the way Obsidian's does, so
 * these tests put two fake windows in place and say which one has focus.
 */

import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import {
  App,
  FakeSecretStorage,
  Menu,
  type Modal,
  built,
  modals,
  notices,
  resetStub,
} from "./stub.ts";
import TrewPlugin from "./main.ts";
import { SyncPreviewModal } from "./preview.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

type Testable = TrewPlugin & {
  onload(): Promise<void>;
  onunload(): void;
  closing: Promise<void> | undefined;
  statusBarItems: { fire(event: string, value?: unknown): void; attributes: Map<string, string> }[];
};

/** A window as far as the plugin can tell: a document, and a native window to focus. */
interface FakeWindow {
  name: string;
  document: object;
  closed: boolean;
  focused: number;
  electronWindow: { focus(): void };
}

function fakeWindow(name: string): FakeWindow {
  const win: FakeWindow = {
    name,
    document: {},
    closed: false,
    focused: 0,
    electronWindow: {
      focus: () => {
        win.focused++;
        // What Obsidian's own focus listener does for the main window.
        (globalThis as { activeWindow?: unknown }).activeWindow = win;
      },
    },
  };
  return win;
}

const host = globalThis as { window?: unknown; activeWindow?: unknown; activeDocument?: unknown };
let saved: { window: unknown; activeWindow: unknown; activeDocument: unknown };
let server: TestServer;
const loaded: Testable[] = [];

beforeEach(async () => {
  resetStub();
  saved = {
    window: host.window,
    activeWindow: host.activeWindow,
    activeDocument: host.activeDocument,
  };
  server = new TestServer();
  await server.start();
});

afterEach(async () => {
  host.window = saved.window;
  host.activeWindow = saved.activeWindow;
  host.activeDocument = saved.activeDocument;
  const closing: Promise<void>[] = [];
  while (loaded.length) {
    const p = loaded.pop()!;
    p.onunload();
    if (p.closing) closing.push(p.closing);
  }
  await Promise.all(closing);
  await server.cleanup();
});

async function load(keychain = new FakeSecretStorage()): Promise<{ plugin: Testable; app: App }> {
  const app = new App({ secretStorage: keychain });
  const plugin = new TrewPlugin(
    app as unknown as ObsidianApp,
    {
      id: "trew",
      dir: ".obsidian/plugins/trew",
    } as unknown as PluginManifest,
  ) as unknown as Testable;
  loaded.push(plugin);
  await plugin.onload();
  return { plugin, app };
}

async function until(what: string, cond: () => boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The review a pass is waiting on, if one is on screen anywhere. */
const openReview = (): (Modal & SyncPreviewModal) | undefined =>
  modals.find(
    (m): m is Modal & SyncPreviewModal => m instanceof SyncPreviewModal && m.isOpen && !m.isClosed,
  );

/** What Obsidian does to a window's modals when that window goes: `pagehide` closes them. */
function closeWindow(win: FakeWindow): void {
  win.closed = true;
  for (const modal of modals) if (modal.isOpen && modal.win === win) modal.close();
  if (host.activeWindow === win) host.activeWindow = host.window;
}

const press = async (label: string): Promise<void> => {
  const button = [...built]
    .reverse()
    .flatMap((s) => s.buttons)
    .find((b) => b.label === label);
  if (!button) throw new Error(`no ${label} button`);
  await button.click();
};

/**
 * A vault on the server already, from another device, and this Mac holding a
 * note of its own and a copy of one of the server's, as a vault being paired
 * again does.
 */
async function vaultAndMac(): Promise<{
  laptop: { plugin: Testable; app: App };
  mac: { plugin: Testable; app: App };
  main: FakeWindow;
  settings: FakeWindow;
}> {
  const laptop = await load();
  laptop.app.vault.adapter.seed("Shared.md", "From the laptop\n");
  await laptop.plugin.pair(await server.firstInvite(), "laptop", true);
  await until("the laptop to sync", () => laptop.plugin.currentState.kind === "synced");
  const invite = (await laptop.plugin.createInvite()).invite;
  const mac = await load();
  mac.app.vault.adapter.seed("Local.md", "Only on the Mac\n");
  mac.app.vault.adapter.seed("Shared.md", "From the laptop\n");
  // Settings is its own window, and it has focus: the Pair button is in it.
  const main = fakeWindow("main");
  const settings = fakeWindow("settings");
  host.window = main;
  host.activeWindow = settings;
  await mac.plugin.pair(invite, "mac", true);
  return { laptop, mac, main, settings };
}

const status = (p: Testable) => p.statusBarItems[0]?.attributes.get("aria-label") ?? "";

describe("the first-sync review, paired from a Settings window", () => {
  it("is drawn in the main window, and says it is waiting, not syncing", async () => {
    const { mac, main, settings } = await vaultAndMac();
    await until("the review", () => openReview() !== undefined);
    const review = openReview()!;
    // Somebody clicks back into their notes, and the Settings window, which
    // sits inside the main window's bounds, drops behind it.
    host.activeWindow = main;

    expect(review.win === settings, "drawn in Settings, which clicking the main window hides").toBe(
      false,
    );
    expect(review.win).toBe(main);
    expect(main.focused, "the main window was not brought forward over Settings").toBeGreaterThan(
      0,
    );
    // Never "syncing" about a pass that will not move until somebody answers.
    await new Promise((r) => setTimeout(r, 400));
    expect(mac.plugin.currentState.kind).toBe("review");
    expect(status(mac.plugin)).toMatch(/review/i);
    expect(status(mac.plugin)).not.toMatch(/Syncing notes/);
  }, 300_000);

  it("stays waiting when Settings is closed, and a dismissal is never approval", async () => {
    const { laptop, mac, settings } = await vaultAndMac();
    await until("the review", () => openReview() !== undefined);
    closeWindow(settings);
    // Closing Settings is not an answer to a question asked somewhere else.
    expect(openReview(), "closing Settings took the review with it").toBeDefined();
    expect(mac.plugin.currentState.kind).toBe("review");

    // Escape, or the close button: sync pauses and says so.
    openReview()!.close();
    await until("the pause", () => mac.plugin.currentState.kind === "paused");
    expect(notices.some((n) => /paused until you review/.test(n.message))).toBe(true);
    await laptop.plugin.syncNow();
    expect(
      laptop.app.vault.adapter.text("Local.md"),
      "a dismissed review was read as approval",
    ).toBe(undefined);
    expect(mac.app.vault.adapter.text("Local.md")).toBe("Only on the Mac\n");

    // The way back is from the status bar: resuming asks again, in the main
    // window, and Continue is what lets the notes through.
    await mac.plugin.syncNow();
    await until("the review again", () => openReview() !== undefined);
    expect(openReview()!.win).toBe(host.window);
    await press("Continue sync");
    await until("the Mac to sync", () => mac.plugin.currentState.kind === "synced");
    await laptop.plugin.syncNow();
    await until(
      "the Mac's note to reach the laptop",
      () => laptop.app.vault.adapter.text("Local.md") === "Only on the Mac\n",
    );
    expect(mac.app.vault.adapter.text("Shared.md")).toBe("From the laptop\n");
    expect(laptop.app.vault.adapter.text("Shared.md")).toBe("From the laptop\n");
  }, 300_000);

  it("is opened again from the status bar while it is waiting", async () => {
    const { mac, main } = await vaultAndMac();
    await until("the review", () => openReview() !== undefined);
    await until("the waiting state", () => mac.plugin.currentState.kind === "review");
    // Its document went without Obsidian closing it, which is the review that
    // used to wait on nobody: no answer, and nothing on screen to give one.
    const lost = openReview()!;
    lost.containerEl.isConnected = false;
    Menu.latest = undefined;
    mac.plugin.statusBarItems[0]!.fire("click", {});
    // Straight to the review, the one thing this vault is waiting on.
    expect(Menu.latest, "the status bar offered a menu instead of the review").toBeUndefined();
    const again = openReview()!;
    expect(again, "the review was not drawn again").not.toBe(lost);
    expect(again.win).toBe(main);
    // Moving it was not an answer: the pass is still waiting.
    expect(mac.plugin.currentState.kind).toBe("review");
    expect(mac.app.vault.adapter.text("Local.md")).toBe("Only on the Mac\n");
    await press("Continue sync");
    await until("the Mac to sync", () => mac.plugin.currentState.kind === "synced");
    expect(mac.app.vault.adapter.text("Local.md")).toBe("Only on the Mac\n");
  }, 300_000);
});
