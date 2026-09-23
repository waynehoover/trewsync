import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import TrewPlugin from "./main.ts";
import { App, built, modals, notices, resetStub, type Plugin as StubPlugin } from "./stub.ts";
import { Client, type DeletedList } from "../core/client.ts";
import { TestServer } from "../core/test-server.ts";
import { nextTurn, receiveCommitted, within } from "../core/test-async.ts";

type TestPlugin = TrewPlugin & StubPlugin;
const plugins: TestPlugin[] = [];
let server: TestServer | undefined;

beforeEach(() => {
  resetStub();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const plugin of plugins.splice(0)) {
    plugin.onunload();
    await plugin.closing;
  }
  await server?.cleanup();
  server = undefined;
  vi.restoreAllMocks();
});

async function load() {
  const app = new App();
  const plugin = new TrewPlugin(
    app as unknown as ObsidianApp,
    {
      id: "trew-sync",
      dir: ".obsidian/plugins/trew-sync",
    } as PluginManifest,
  ) as TestPlugin;
  (plugin as unknown as { confirmSync(): Promise<boolean> }).confirmSync = async () => true;
  plugins.push(plugin);
  await plugin.onload();
  return { app, plugin };
}

async function synced(plugin: TestPlugin) {
  if (plugin.currentState.kind === "synced") return;
  await within(
    new Promise<void>((resolve) => {
      const stop = plugin.watchState((state) => {
        if (state.kind === "synced") {
          stop();
          resolve();
        }
      });
    }),
    "plugin to sync",
    15000,
  );
}

const client = (plugin: TestPlugin) => (plugin as unknown as { client: Client }).client;
const button = (label: string) =>
  built
    .flatMap((row) => row.buttons)
    .reverse()
    .find((b) => b.label === label);

it("restores the selected deletion's content when a peer has since reused its name", async () => {
  server = new TestServer();
  await server.start();
  const a = await load();
  a.app.vault.adapter.seed("Note.md", "the deleted note\n");
  const key = await a.plugin.pairFirst(server.setup, "laptop");
  await synced(a.plugin);
  const b = await load();
  await b.plugin.pair(key, "phone");
  await synced(b.plugin);

  await a.app.vault.adapter.remove("Note.md");
  await a.plugin.syncNow();
  await receiveCommitted(client(b.plugin).transport);
  await b.plugin.syncNow();
  const deletion = (await b.plugin.deletedNotes()).notes.find((note) => note.path === "Note.md")!;
  expect(deletion).toBeDefined();

  a.app.vault.adapter.seed("Note.md", "a different new note\n", Date.now() + 1000);
  await a.plugin.syncNow();
  await receiveCommitted(client(b.plugin).transport);
  await b.plugin.syncNow();
  expect(b.app.vault.adapter.text("Note.md")).toBe("a different new note\n");

  const restored = await b.plugin.recover(deletion);
  expect(restored.path).not.toBe("Note.md");
  expect(b.app.vault.adapter.text("Note.md")).toBe("a different new note\n");
  expect(b.app.vault.adapter.text(restored.path)).toBe("the deleted note\n");
  expect(restored.sent).toBe(true);
  await receiveCommitted(client(a.plugin).transport);
  await a.plugin.syncNow();
  expect(a.app.vault.adapter.text(restored.path)).toBe("the deleted note\n");
});

const deleted = (uid: number, path: string): DeletedList["notes"][number] => ({
  uid,
  path,
  mtime: 1000,
  ctime: 1000,
  size: 0,
  folder: false,
  deleted: true,
  device: "phone",
  chunks: 0,
  contentId: "-empty-",
  restorable: uid - 1,
});

it("keeps newer deletions on screen after one from an older page is restored", async () => {
  // Pages accumulate rather than replace (R083-17), so there is no route back
  // to lose: what "Show older" adds sits under what was already there, and the
  // search field filters all of it. Restoring one row takes that row out and
  // leaves the rest, without asking the server again.
  const { plugin } = await load();
  const newest = deleted(100, "Newer.md");
  const older = deleted(10, "Older.md");
  let asked = 0;
  plugin.deletedNotes = async (_limit, before) => {
    asked++;
    return before === undefined
      ? { notes: [newest], more: true, oldest: newest.uid }
      : { notes: [older], more: false, oldest: older.uid };
  };
  plugin.recover = async () => ({ path: older.path, sent: true });
  plugin.commands.find((command) => command.id === "recover-deleted")!.callback!();
  await nextTurn();
  const modal = modals.at(-1)!;
  const older_ = button("Show older")!;
  built.length = 0;
  await older_.click();
  expect(built.map((row) => row.name)).toContain("Older.md");
  expect(
    built.map((row) => row.name),
    "the older page replaced the newer one",
  ).toContain("Newer.md");

  // By label: a row with more than one restorable sibling also carries a
  // Choose button for the bulk path, so the first button is not the one.
  const restore = built
    .find((row) => row.name === "Older.md")!
    .buttons.find((b) => b.label === "Restore")!;
  built.length = 0;
  await restore.click();
  const after = built.map((row) => row.name);
  expect(after).not.toContain("Older.md");
  expect(after, "restoring one deletion dropped the others").toContain("Newer.md");
  expect(asked, "the list was refetched, which would discard the loaded pages").toBe(2);
  modal.close();
});

it("restores a chosen set together, in one sync", async () => {
  // Recovering a deleted folder was one press and one whole-vault reconcile
  // per note (Codex-11). A hundred notes was a hundred of each, on a phone,
  // one-handed, after something had already gone wrong.
  const { plugin } = await load();
  const gone = [deleted(30, "Folder/a.md"), deleted(20, "Folder/b.md"), deleted(10, "Other.md")];
  plugin.deletedNotes = async () => ({ notes: gone, more: false });
  const restored: string[] = [];
  let syncs = 0;
  plugin.recoverMany = async (versions) => {
    syncs++;
    for (const v of versions) restored.push(v.path);
    return versions.map((v) => ({ path: v.path, sent: true }));
  };
  plugin.commands.find((command) => command.id === "recover-deleted")!.callback!();
  await nextTurn();
  const modal = modals.at(-1)!;

  // Two of the three, chosen by name.
  for (const name of ["Folder/a.md", "Folder/b.md"]) {
    await built
      .find((row) => row.name === name)!
      .buttons.find((b) => b.label === "Choose")!
      .click();
  }
  const go = button("Restore 2")!;
  built.length = 0;
  await go.click();

  expect(restored).toEqual(["Folder/a.md", "Folder/b.md"]);
  expect(syncs, "each note was restored and synced on its own").toBe(1);
  // The two that came back are gone from the list and the third is not.
  const after = built.map((row) => row.name);
  expect(after).not.toContain("Folder/a.md");
  expect(after).not.toContain("Folder/b.md");
  expect(after).toContain("Other.md");
  modal.close();
});

it("says how many of a chosen set could not be restored", async () => {
  // All three counts, always. "Restored 40" without "and 2 could not be" is
  // the comfortable half of the story, and the other half is the one somebody
  // has to act on.
  const { plugin } = await load();
  const gone = [deleted(30, "a.md"), deleted(20, "b.md")];
  plugin.deletedNotes = async () => ({ notes: gone, more: false });
  plugin.recoverMany = async (versions) =>
    versions.map((v) =>
      v.path === "b.md"
        ? { path: v.path, sent: false, willRetry: false as const, why: "its history was purged" }
        : { path: v.path, sent: true },
    );
  plugin.commands.find((command) => command.id === "recover-deleted")!.callback!();
  await nextTurn();
  const modal = modals.at(-1)!;
  await button("Choose all shown")!.click();
  notices.length = 0;
  await button("Restore 2")!.click();

  const said = notices.map((n) => n.message).join(" ");
  expect(said).toContain("Restored 1 of 2");
  expect(said).toContain("1 could not be restored");
  expect(said).toContain("its history was purged");
  // The one that failed stays, so it can be tried again.
  expect(built.map((row) => row.name)).toContain("b.md");
  modal.close();
});

it("lets a deleted-note lookup retry after the connection recovers", async () => {
  const { plugin } = await load();
  let calls = 0;
  plugin.deletedNotes = async () => {
    if (++calls === 1) throw new Error("Connection lost");
    return { notes: [deleted(20, "Recovered connection.md")], more: false };
  };
  plugin.commands.find((command) => command.id === "recover-deleted")!.callback!();
  await nextTurn();
  const modal = modals.at(-1)!;
  expect(modal.contentEl.allText()).toContain("Connection lost");
  expect(button("Try again")).toBeDefined();
  const retry = button("Try again")!;
  built.length = 0;
  await retry.click();
  expect(built.map((row) => row.name)).toContain("Recovered connection.md");
  modal.close();
});
