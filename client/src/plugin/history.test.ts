/**
 * The version history modal, against a real server.
 *
 * Sync's history is what somebody coming from it will expect, so this checks the
 * behaviours that matter rather than the markup: the list is newest first, the
 * pane shows the version you picked, the diff compares against what is on disk,
 * a restore never overwrites, and paging asks for what it does not already have.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deferred, nextTurn } from "../core/test-async.ts";

import { Client } from "../core/client.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "../core/test-server.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";
import { App, notices } from "./stub.ts";
import type { Version } from "../core/client.ts";
import { HistoryModal, PAGE, diffLines, type HistorySource } from "./history.ts";

let server: TestServer;
const clients: Client[] = [];

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

afterEach(async () => {
  while (clients.length) clients.pop()!.close();
  if (server) await server.cleanup();
  notices.length = 0;
});

/** One device, plus the source the modal talks to. */
async function device(): Promise<{ adapter: FakeAdapter; client: Client; source: HistorySource }> {
  server = new TestServer();
  await server.start();
  const adapter = new FakeAdapter();
  const client = new Client({
    vault: new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian"),
    store: new ObsidianIndexStore(adapter, ".obsidian/plugins/trew/index.json"),
    url: server.wsUrl,
    ...(await server.deviceCredentials("laptop")),
    vaultId: "default",
    device: "laptop",
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  clients.push(client);
  await client.connect();

  const source: HistorySource = {
    history: (path, opts) => client.history(path, opts),
    contentAt: async (v) => new TextDecoder().decode(await client.contentAt(v)),
    restoreVersion: async (v) => ({ path: (await client.restore(v)).path, sent: true }),
    currentText: async (path) => adapter.text(path),
  };
  return { adapter, client, source };
}

/** One version, with only the fields a test cares about filled in. */
function version(uid: number, path: string, over: Partial<Version> = {}): Version {
  return {
    uid,
    path,
    size: 4,
    ctime: 1000,
    mtime: 1000 + uid,
    folder: false,
    deleted: false,
    device: "a",
    chunks: 1,
    contentId: `c${uid}`,
    ...over,
  };
}

it("follows a rename back into the note's earlier history", async () => {
  // History matched one exact path, so a note renamed today had a history
  // that started today, however many months of it the server was still
  // holding under the old name (Codex-06).
  const asked: { path: string; before?: number }[] = [];
  const source: HistorySource = {
    history: async (path, opts) => {
      asked.push({ path, ...(opts.before !== undefined ? { before: opts.before } : {}) });
      if (path === "Now.md") {
        // A short page, so paging is exhausted under this name, and the
        // oldest of them carries the rename.
        return [version(30, "Now.md"), version(20, "Now.md", { previousPath: "Then.md" })];
      }
      return [version(10, "Then.md")];
    },
    contentAt: async () => "text\n",
    restoreVersion: async () => ({ path: "Now.md", sent: true }),
    currentText: async () => "text\n",
  };
  const modal = new HistoryModal(new App() as never, source, "Now.md");
  const work = modal as unknown as { load(): Promise<void> };
  modal.onOpen();
  await work.load();
  // Not exhausted, because there is an earlier name to read.
  await work.load();

  expect(asked[0]).toEqual({ path: "Now.md" });
  // Bounded by the rename's own version, so a name reused for something else
  // later cannot be pulled into this note's history.
  expect(asked.at(-1)).toEqual({ path: "Then.md", before: 20 });
  const shown = (modal.contentEl as unknown as { allText(): string }).allText();
  expect(shown, "the earlier name was not labelled").toContain("as Then.md");
  modal.onClose();
});

/** Writes a note and syncs, once per revision, so the server holds a history. */
async function revisions(
  adapter: FakeAdapter,
  client: Client,
  path: string,
  texts: string[],
): Promise<void> {
  let at = 0;
  for (const text of texts) {
    // mtime advanced explicitly. The fake adapter's clock does not move on
    // its own, and the engine rehashes on a changed stat, so without this a
    // same-length revision is correctly seen as no change at all.
    await adapter.write(path, text, { mtime: 2_000_000 + ++at * 60_000, ctime: 2_000_000 });
    await client.settle({ coalesceWrites: false });
  }
}

describe("version history", () => {
  it("lists every version of a note, newest first", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["one\n", "one\ntwo\n", "one\ntwo\nthree\n"]);

    const versions = await source.history("note.md", { limit: PAGE });
    expect(versions.length).toBe(3);
    // Newest first is what the sidebar renders in order, so it is the list
    // that has to be sorted, not the view.
    expect(versions[0]!.uid).toBeGreaterThan(versions[1]!.uid);
    expect(versions[1]!.uid).toBeGreaterThan(versions[2]!.uid);

    // And each one reads back as what was written at the time.
    expect(await source.contentAt(versions[0]!)).toBe("one\ntwo\nthree\n");
    expect(await source.contentAt(versions[2]!)).toBe("one\n");
  });

  it("restores an old version without overwriting the note that is there", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["first\n", "second\n"]);

    const versions = await source.history("note.md", { limit: PAGE });
    const oldest = versions[versions.length - 1]!;
    const done = await source.restoreVersion(oldest);

    // The point of the whole thing: the note you have open is untouched.
    expect(done.path).not.toBe("note.md");
    expect(adapter.text("note.md")).toBe("second\n");
    expect(adapter.text(done.path)).toBe("first\n");
  });

  it("shows the version you picked, and a diff against what is on disk", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["alpha\nbravo\n", "alpha\nbravo\ncharlie\n"]);

    const versions = await source.history("note.md", { limit: PAGE });
    const older = await source.contentAt(versions[1]!);
    const now = (await source.currentText("note.md"))!;
    const diff = diffLines(older, now);

    expect(diff).toContain("+ charlie");
    expect(diff).not.toContain("- alpha");
    // Identical inputs must say so rather than rendering an empty box that
    // reads as "failed to load".
    expect(diffLines(now, now)).toMatch(/No difference/);
  });

  it("pages backwards from the oldest version it already holds", async () => {
    const { adapter, client, source } = await device();
    const texts = Array.from({ length: PAGE + 5 }, (_, i) => `revision ${i}\n`.repeat(i + 1));
    await revisions(adapter, client, "note.md", texts);

    const first = await source.history("note.md", { limit: PAGE });
    expect(first.length).toBe(PAGE);
    const next = await source.history("note.md", {
      limit: PAGE,
      before: first[first.length - 1]!.uid,
    });

    expect(next.length).toBe(5);
    // No overlap, or the sidebar would show the same version twice and
    // "load more" would appear to do nothing.
    const seen = new Set(first.map((v) => v.uid));
    expect(next.every((v) => !seen.has(v.uid))).toBe(true);
  });

  it("says so rather than showing an empty list when there is no history", async () => {
    const { source } = await device();
    const modal = new HistoryModal(new App() as never, source, "never-existed.md");
    modal.open();
    await until("the empty history response", () => /no history/i.test(rendered(modal)));

    expect(rendered(modal)).toMatch(/no history/i);
  });

  it("renders the versions and offers a restore for the one selected", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["one\n", "one\ntwo\n"]);

    const modal = new HistoryModal(new App() as never, source, "note.md");
    modal.open();
    await until("the newest version text", () => rendered(modal).includes("one\ntwo\n"));

    // Opens on the newest version, so the pane is never dead space and the
    // common case takes no clicks. "Select a version to see it." as the
    // opening state is what this replaced.
    expect(rows(modal).length).toBe(2);
    expect(rendered(modal)).not.toMatch(/Select a version/);
    expect(rendered(modal)).toContain("one\ntwo\n");
    expect(rendered(modal)).toContain("Restore");

    rows(modal)[1]!.click();
    await until("the selected version text", () => !rendered(modal).includes("Loading…"));
    const text = rendered(modal);
    expect(text).toContain("Restore");
    expect(text).toContain("one\n");
  });
});

function rendered(modal: HistoryModal): string {
  return (modal.contentEl as unknown as { allText(): string }).allText();
}

/** The clickable version rows, in the order they are drawn. */
function rows(modal: HistoryModal): { click(): void }[] {
  const found: { click(): void }[] = [];
  walk(modal.contentEl as unknown as FakeNode, (el) => {
    // The exact class token, not a substring: the header and details divs
    // inside each row are `modal-sidebar-list-item-header` and
    // `-details`, and a substring match counts every row three times.
    if (el.cls.split(" ").includes("modal-sidebar-list-item")) {
      found.push({ click: () => el.fire("click") });
    }
  });
  return found;
}

interface FakeNode {
  cls: string;
  tag: string;
  children: FakeNode[];
  fire(event: string): void;
  allText(): string;
}

function walk(node: FakeNode, visit: (n: FakeNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

/**
 * styles.css colours additions and removals. It can only do that if the diff is
 * made of elements carrying those classes, and for a while it was not: the diff
 * went into the <pre> as one run of text, both rules matched nothing, and every
 * diff rendered in a single colour. Nothing failed, it just looked wrong, which
 * is why this asserts on the markup and not on the text.
 */
it("marks up added and removed lines so the stylesheet can colour them", async () => {
  const { adapter, client, source } = await device();
  await revisions(adapter, client, "note.md", ["one\ntwo\n", "one\nthree\n"]);

  const modal = new HistoryModal(new App() as never, source, "note.md");
  modal.open();
  await until("the newest version text", () => rendered(modal).includes("one\nthree\n"));

  // The oldest version, against what is on disk now.
  rows(modal)[1]!.click();
  await until("the older version text", () => rendered(modal).includes("one\ntwo\n"));
  const toggle = buttons(modal).find((b) => b.text.includes("Show changes"));
  expect(toggle, "no toggle to switch to the diff").toBeDefined();
  toggle!.click();
  await until("the version diff", () => classesIn(modal).has("trew-added"));

  const classes = classesIn(modal);
  expect(classes).toContain("trew-removed");
  expect(classes).toContain("trew-added");
});

/** Every class token present anywhere under the modal. */
function classesIn(modal: HistoryModal): Set<string> {
  const found = new Set<string>();
  walk(modal.contentEl as unknown as FakeNode, (el) => {
    for (const c of el.cls.split(" ")) if (c !== "") found.add(c);
  });
  return found;
}

/** The modal's buttons, as text plus a click. */
function buttons(modal: HistoryModal): { text: string; click(): void }[] {
  const found: { text: string; click(): void }[] = [];
  walk(modal.contentEl as unknown as FakeNode, (el) => {
    if (el.tag === "button") found.push({ text: el.allText(), click: () => el.fire("click") });
  });
  return found;
}

describe("history on a slow connection", () => {
  const version: Version = {
    uid: 1,
    path: "note.md",
    contentId: "v1",
    size: 4,
    ctime: 0,
    mtime: 1,
    folder: false,
    deleted: false,
    device: "phone",
    chunks: 1,
  };
  function fixture() {
    const source = {
      history: vi.fn(async () => [version]),
      contentAt: vi.fn(async () => "old\n"),
      currentText: vi.fn(async () => "new\n"),
      restoreVersion: vi.fn(async () => ({ path: "restored.md", sent: true })),
    };
    const modal = new HistoryModal(new App() as never, source, "note.md");
    const work = modal as unknown as {
      choose(v: Version): Promise<void>;
      load(): Promise<void>;
      restore(v: Version): Promise<void>;
    };
    return { modal, source, work };
  }

  it("reuses the selected download but compares with the latest local edit", async () => {
    const { modal, source } = fixture();
    modal.open();
    await nextTurn();
    buttons(modal)
      .find((b) => b.text === "Show changes")!
      .click();
    await nextTurn();
    expect(rendered(modal)).toContain("+ new");
    buttons(modal)
      .find((b) => b.text === "Show text")!
      .click();
    await nextTurn();
    source.currentText.mockResolvedValue("edited again\n");
    buttons(modal)
      .find((b) => b.text === "Show changes")!
      .click();
    await nextTurn();
    expect(rendered(modal)).toContain("+ edited again");
    expect(source.contentAt).toHaveBeenCalledTimes(1);
    expect(source.currentText).toHaveBeenCalledTimes(2);
    modal.close();
  });

  it("shares a download when the same version is selected twice", async () => {
    const { modal, source, work } = fixture();
    const content = deferred<string>();
    source.contentAt.mockReturnValue(content.promise);
    modal.open();
    await nextTurn();
    const again = work.choose(version);
    content.resolve("exact downloaded text\n");
    await again;
    expect(rendered(modal)).toContain("exact downloaded text\n");
    expect(source.contentAt).toHaveBeenCalledTimes(1);
    modal.close();
  });

  it("does not fetch a preview after the history window has closed", async () => {
    const { modal, source, work } = fixture();
    const page = deferred<Version[]>();
    source.history.mockReturnValue(page.promise);
    modal.open();
    expect(rendered(modal)).toContain("Loading history…");
    const loading = work.load();
    modal.close();
    page.resolve([version]);
    await loading;
    expect(source.contentAt).not.toHaveBeenCalled();
    expect(rendered(modal)).toBe("");
  });

  it("discards a preview that finishes after closing", async () => {
    const { modal, source, work } = fixture();
    const content = deferred<string>();
    source.contentAt.mockReturnValue(content.promise);
    modal.open();
    await nextTurn();
    const reading = work.choose(version);
    modal.close();
    content.resolve("private version contents\n");
    await reading;
    expect(rendered(modal)).toBe("");
  });

  it("restores once when Restore is tapped repeatedly", async () => {
    const { modal, source, work } = fixture();
    modal.open();
    await nextTurn();
    const done = deferred<{ path: string; sent: boolean }>();
    source.restoreVersion.mockReturnValue(done.promise);
    const first = work.restore(version);
    const second = work.restore(version);
    expect(rendered(modal)).toContain("Restoring…");
    done.resolve({ path: "restored.md", sent: true });
    await Promise.all([first, second]);
    expect(source.restoreVersion).toHaveBeenCalledTimes(1);
    expect(notices.filter((n) => n.message.startsWith("Restored"))).toHaveLength(1);
  });

  it("allows a failed restore and a failed preview to be retried", async () => {
    const { modal, source, work } = fixture();
    source.contentAt.mockRejectedValueOnce(new Error("offline"));
    modal.open();
    await nextTurn();
    expect(rendered(modal)).toContain("Could not read this version");
    await work.choose(version);
    expect(rendered(modal)).toContain("old\n");
    source.restoreVersion.mockRejectedValueOnce(new Error("offline"));
    await work.restore(version);
    expect(buttons(modal).some((b) => b.text === "Restore")).toBe(true);
    await work.restore(version);
    expect(source.restoreVersion).toHaveBeenCalledTimes(2);
  });
});

/**
 * The modal has to say which note it belongs to. It calls setTitle, but
 * mod-sidebar-layout collapses the modal header to nothing, so for a while the
 * title was set and never drawn: the window named no note at all.
 */
it("names the note whose history it is showing", async () => {
  const { adapter, client, source } = await device();
  await revisions(adapter, client, "Projects/note.md", ["one\n"]);

  const modal = new HistoryModal(new App() as never, source, "Projects/note.md");
  modal.open();

  // In the body, not just in titleEl, because titleEl is the part that does
  // not render.
  expect(rendered(modal)).toContain("Projects/note.md");
});

/**
 * `diffLines` was a set difference of the two line lists, so
 * anything a set cannot see, a duplicate removed or two paragraphs swapped,
 * came out as "No difference", and somebody deciding whether to restore was
 * told two versions were the same when they were not.
 */
describe("the line diff", () => {
  it("shows a removed duplicate paragraph", () => {
    const diff = diffLines("a\nb\na\n", "a\nb\n");
    expect(diff).not.toMatch(/No difference/);
    expect(diff).toBe("- a");
  });

  it("shows two paragraphs that swapped places", () => {
    const diff = diffLines("one\ntwo\n", "two\none\n");
    expect(diff).not.toMatch(/No difference/);
    expect(diff).toContain("- one");
    expect(diff).toContain("+ one");
    // The whole swapped region, not the one line that strictly had to move.
    // Semantic cleanup groups a rewritten stretch into what came out and
    // what went in, which is what a pane that hides unchanged lines needs:
    // the alternative reads as a stutter with invisible context between the
    // halves. Minimality is not the property here, seeing the change is.
    expect(diff).toBe("- one\n- two\n+ two\n+ one");
  });

  it("still shows an appended line as the one addition", () => {
    expect(diffLines("alpha\nbravo\n", "alpha\nbravo\ncharlie\n")).toBe("+ charlie");
    expect(diffLines("same\n", "same\n")).toMatch(/No difference/);
  });
});

/**
 * Reading a version is a round trip and two clicks start two.
 * The one that finished last used to win the pane, so the list said B, Restore
 * restored B, and the text on screen was A.
 */
describe("selections that finish out of order", () => {
  const version = (uid: number): Version => ({
    uid,
    path: "note.md",
    contentId: `content-${uid}`,
    size: 1,
    ctime: 0,
    mtime: 1_700_000_000_000 + uid,
    folder: false,
    deleted: false,
    device: "d",
    chunks: 1,
  });

  /** A source whose reads finish when the test says. */
  function controlled(pages: Version[][]) {
    const pending = new Map<number, (text: string) => void>();
    let historyCalls = 0;
    const source: HistorySource = {
      history: async () => {
        historyCalls++;
        return pages.shift() ?? [];
      },
      contentAt: (v) =>
        new Promise<string>((resolve) => {
          pending.set(v.uid, resolve);
        }),
      restoreVersion: async (v) => ({ path: `restored ${v.uid}`, sent: true }),
      currentText: async () => "",
    };
    return {
      source,
      finish: (uid: number) => pending.get(uid)!(`text of ${uid}`),
      reading: (uid: number) => pending.has(uid),
      calls: () => historyCalls,
    };
  }

  it("shows the version chosen last, whichever read finished last", async () => {
    const a = version(2);
    const b = version(1);
    const { source, finish, reading } = controlled([[a, b]]);
    const modal = new HistoryModal(new App() as never, source, "note.md");
    const choices = vi.spyOn(
      modal as unknown as { choose(version: Version): Promise<void> },
      "choose",
    );
    modal.open();
    await until("the first content request", () => reading(2));
    // The modal opened on A and is waiting for its text. Pick B.
    rows(modal)[1]!.click();
    await until("the second content request", () => reading(1));
    // B answers first, then A, deliberately reversed.
    finish(1);
    await choices.mock.results[1]!.value;
    expect(rendered(modal)).toContain("text of 1");
    finish(2);
    await choices.mock.results[0]!.value;
    const text = rendered(modal);
    expect(text, "the slower read for A overwrote B's pane").toContain("text of 1");
    expect(text).not.toContain("text of 2");
  });

  it("asks for a page once however many times Load more is pressed", async () => {
    const first = Array.from({ length: PAGE }, (_, i) => version(100 - i));
    const second = [version(5)];
    const { source, finish, calls, reading } = controlled([first, second]);
    const modal = new HistoryModal(new App() as never, source, "note.md");
    modal.open();
    await until("the newest content request", () => reading(100));
    finish(100);
    await until("the newest content response", () => rendered(modal).includes("text of 100"));
    expect(calls()).toBe(1);

    const more = () => buttons(modal).find((b) => b.text.includes("Load more"));
    expect(more(), "no Load more button for a full first page").toBeDefined();
    const loadMore = more()!;
    loadMore.click();
    loadMore.click();
    await until("the second history page", () => rows(modal).length === PAGE + 1);
    expect(calls(), "two presses became two requests for the same page").toBe(2);
    expect(rows(modal).length).toBe(PAGE + 1);
  });
});

/**
 * P-D7 in the 0.3.0 review. A page that could not be fetched used to set
 * `exhausted`, which is what removes Load more, so an offline moment while the
 * modal was opening left a window with nothing in it and no way to ask again.
 * Closing and reopening is not a recovery, it is a workaround somebody has to
 * be told about.
 */
describe("a history page that does not arrive (P-D7)", () => {
  it("can be asked for again", async () => {
    let fail = true;
    const version: Version = {
      uid: 7,
      path: "note.md",
      contentId: "c7",
      size: 1,
      ctime: 0,
      mtime: 1_700_000_000_000,
      folder: false,
      deleted: false,
      device: "laptop",
      chunks: 1,
    };
    const source: HistorySource = {
      history: async () => {
        if (fail) throw new Error("the server could not be reached");
        return [version];
      },
      contentAt: async () => "the text",
      restoreVersion: async () => ({ path: "note.md", sent: true }),
      currentText: async () => "",
    };

    const modal = new HistoryModal(new App() as never, source, "note.md");
    modal.open();
    await until("the history error", () => rendered(modal).includes("could not be read"));

    // Not "the server holds no history for this note": that is an answer,
    // and no answer was given.
    expect(rendered(modal)).toMatch(/could not be read/);
    const again = () => buttons(modal).find((b) => b.text.includes("Try again"));
    expect(again(), "no way to ask again after a failed page").toBeDefined();

    fail = false;
    again()!.click();
    await until("the retried history response", () => rendered(modal).includes("the text"));
    expect(rows(modal).length).toBe(1);
    expect(rendered(modal)).toContain("the text");
    expect(rendered(modal)).not.toMatch(/could not be read/);
  });
});

describe("bounded, accessible previews", () => {
  const version: Version = {
    uid: 1,
    path: "note.md",
    contentId: "v1",
    size: 4,
    ctime: 0,
    mtime: 1,
    folder: false,
    deleted: false,
    device: "phone",
    chunks: 1,
  };
  it.each([
    { path: "book.pdf", size: 1000 },
    { path: "large.md", size: 1024 * 1024 },
  ])("does not fetch $path for a text preview", async (meta) => {
    const source = {
      history: async () => [{ ...version, ...meta }],
      contentAt: vi.fn(async () => "bytes"),
      currentText: async () => "",
      restoreVersion: async () => ({ path: meta.path, sent: true }),
    };
    const modal = new HistoryModal(new App() as never, source, meta.path);
    modal.open();
    await nextTurn();
    expect(source.contentAt).not.toHaveBeenCalled();
    expect(rendered(modal)).toMatch(/Restore a copy/);
    modal.close();
  });
  it("provides focusable version buttons and arrow navigation", async () => {
    const source = {
      history: async () => [version, { ...version, uid: 2 }],
      contentAt: async (v: Version) => `version ${v.uid}`,
      currentText: async () => "",
      restoreVersion: async () => ({ path: "note.md", sent: true }),
    };
    const modal = new HistoryModal(new App() as never, source, "note.md");
    modal.open();
    await nextTurn();
    const list = (modal.contentEl as unknown as import("./stub.ts").FakeEl).querySelectorAll(
      '[data-version="1"]',
    );
    expect(list[0]?.tag).toBe("button");
    list[0]!.focus();
    list[0]!.fire("keydown", { key: "ArrowDown", preventDefault() {} });
    await nextTurn();
    expect(rendered(modal)).toContain("version 2");
    modal.close();
  });
});

/**
 * "Undo this change", for a version an agent's operation wrote (PLAN.md
 * section 4.5, M5 task 7), against the real server with `-mcp`: the agent
 * writes through the HTTP tools under a token minted on the server, and the
 * device undoes it from the panel over protocol 2. Restore stays what it
 * was, a write that replaces nothing, and is offered beside the undo.
 */
describe("undoing an agent's change from the history panel", () => {
  /** One MCP tool call, stateless at 2025-11-25, and its envelope. */
  async function tool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; structuredContent: { trusted: Record<string, unknown> } };
    };
    expect(body.result.isError, JSON.stringify(body.result)).toBeFalsy();
    return body.result.structuredContent.trusted;
  }

  /**
   * A device on a server with `-mcp`, a note it wrote, and the agent's edit of
   * that note, which the device then holds.
   */
  async function agentEdited(): Promise<{
    adapter: FakeAdapter;
    client: Client;
    source: HistorySource;
  }> {
    server = new TestServer();
    server.extraArgs = ["-mcp"];
    await server.start();
    const keyFile = join(server.dataDir, "agent.key");
    await server.cli(
      "mcp-token",
      "-label",
      "Claude on Mac",
      "-scope",
      "write",
      "-key-out",
      keyFile,
    );
    const token = (await readFile(keyFile, "utf8")).trim();

    const adapter = new FakeAdapter();
    const client = new Client({
      vault: new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian"),
      store: new ObsidianIndexStore(adapter, ".obsidian/plugins/trew/index.json"),
      url: server.wsUrl,
      ...(await server.deviceCredentials("laptop")),
      vaultId: "default",
      device: "laptop",
      timeoutMs: 20_000,
      coalesceWrites: false,
    });
    clients.push(client);
    await client.connect();
    await revisions(adapter, client, "note.md", ["the words before the agent\n"]);

    const read = await tool(token, "read_note", { path: "note.md" });
    await tool(token, "edit_note", {
      path: "note.md",
      base: read["uid"],
      epoch: read["epoch"],
      edits: [{ old: "before the agent", new: "the agent wrote" }],
    });
    // The server broadcasts the agent's version before it answers the tool,
    // but the device's socket may not have read that frame when the answer
    // arrives, and one settle then finds nothing to apply. Under the full
    // gate's load that happened (M5.5): settle until the version lands, with
    // a deadline, then hold the bytes.
    const deadline = Date.now() + 15_000;
    do {
      await client.settle({ coalesceWrites: false });
    } while (adapter.text("note.md") !== "the words the agent wrote\n" && Date.now() < deadline);
    expect(adapter.text("note.md")).toBe("the words the agent wrote\n");

    const source: HistorySource = {
      history: (path, opts) => client.history(path, opts),
      contentAt: async (v) => new TextDecoder().decode(await client.contentAt(v)),
      restoreVersion: async (v) => ({ path: (await client.restore(v)).path, sent: true }),
      currentText: async (path) => adapter.text(path),
      undoOperation: (v, opts) => client.undo(v.operation!.id, opts),
    };
    return { adapter, client, source };
  }

  it("undoes the agent's edit to the exact former bytes, beside a Restore that is unchanged", async () => {
    const { adapter, client, source } = await agentEdited();
    const [agents, mine] = await source.history("note.md", { limit: PAGE });
    expect(agents!.operation).toMatchObject({ tool: "edit_note", kind: "mcp" });
    expect(agents!.operation!.undoneBy).toBeUndefined();
    expect(agents!.device).toBe("Claude on Mac");
    expect(mine!.operation, "a version the device synced names no operation").toBeUndefined();

    const modal = new HistoryModal(new App() as never, source, "note.md");
    modal.open();
    await until("the agent's version and its undo", () =>
      rendered(modal).includes("Undo this change"),
    );
    expect(rendered(modal)).toContain("Written by the agent “Claude on Mac” (edit_note).");
    expect(buttons(modal).some((b) => b.text === "Restore")).toBe(true);

    // The device's own version has a Restore and no undo.
    rows(modal)[1]!.click();
    await until("the device's version", () => rendered(modal).includes("the words before"));
    expect(buttons(modal).some((b) => b.text === "Undo this change")).toBe(false);
    expect(buttons(modal).some((b) => b.text === "Restore")).toBe(true);

    rows(modal)[0]!.click();
    await until("the agent's version again", () => rendered(modal).includes("Undo this change"));
    buttons(modal)
      .find((b) => b.text === "Undo this change")!
      .click();
    await until(
      "the undo on disk",
      () => adapter.text("note.md") === "the words before the agent\n",
    );
    expect(notices.map((n) => n.message)).toContain(
      "TrewSync: Undid the change. The note is as it was before it.",
    );
    // No copy: an undo puts the note back where it is, replacing the agent's.
    expect(adapter.filePaths().filter((p) => p.endsWith(".md"))).toEqual(["note.md"]);

    const after = await client.history("note.md", { limit: PAGE });
    expect(after[0]!.operation).toMatchObject({ tool: "undo", kind: "device" });
    expect(after[0]!.device).toBe("laptop");
    expect(after[1]!.operation?.undoneBy).toBe(after[0]!.operation!.id);
    expect(await client.contentAt(after[0]!)).toEqual(
      new TextEncoder().encode("the words before the agent\n"),
    );
  });

  it("counts an edit on this device that was not sent yet as a change since", async () => {
    const { adapter, client } = await agentEdited();
    const [agents] = await client.history("note.md", { limit: PAGE });
    // Written to disk and not synced: the undo sends it first, so the server
    // refuses the undo rather than commit it over words it had not seen.
    await adapter.write("note.md", "typed here, not yet sent\n", {
      mtime: 9_000_000,
      ctime: 2_000_000,
    });
    await expect(client.undo(agents!.operation!.id)).rejects.toMatchObject({ code: "stale" });
    expect(adapter.text("note.md")).toBe("typed here, not yet sent\n");
    const [head] = await client.history("note.md", { limit: PAGE });
    expect(head!.device).toBe("laptop");
    expect(await client.contentAt(head!)).toEqual(
      new TextEncoder().encode("typed here, not yet sent\n"),
    );
  });

  it("refuses when the note changed since, changes nothing, and then writes the copy", async () => {
    const { adapter, client, source } = await agentEdited();
    await revisions(adapter, client, "note.md", ["the person's own words since\n"]);

    const modal = new HistoryModal(new App() as never, source, "note.md");
    modal.open();
    await until("the person's version", () => rendered(modal).includes("own words since"));
    expect(buttons(modal).some((b) => b.text === "Undo this change")).toBe(false);
    rows(modal)[1]!.click();
    await until("the agent's version", () => rendered(modal).includes("Undo this change"));
    buttons(modal)
      .find((b) => b.text === "Undo this change")!
      .click();
    await until("the refusal", () => rendered(modal).includes("Not undone"));
    // Who changed it, from the server's refusal.
    expect(rendered(modal)).toMatch(/stale: .*note\.md.*laptop/s);
    expect(adapter.text("note.md")).toBe("the person's own words since\n");
    const before = await client.history("note.md", { limit: PAGE });
    expect(before[1]!.operation?.undoneBy).toBeUndefined();

    buttons(modal)
      .find((b) => b.text.startsWith("Keep both"))!
      .click();
    const original = before.at(-1)!;
    const copy = `note (restored ${original.uid}).md`;
    await until("the copy on disk", () => adapter.text(copy) !== undefined);
    expect(adapter.text(copy)).toBe("the words before the agent\n");
    expect(adapter.text("note.md")).toBe("the person's own words since\n");
    expect(notices.map((n) => n.message)).toContain(
      `TrewSync: Wrote the earlier version beside the note, as ${copy}. Nothing else was changed.`,
    );
  });
});
