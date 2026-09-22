import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  symlink,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NodeVault } from "./vault.ts";
import { McpReader, pageNote, PAGE_TEXT_BYTES } from "./mcp-read.ts";
import { noteDigest } from "./mcp-notes.ts";
import { deferred, nextTurn, within } from "../core/test-async.ts";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
let root: string;
let reader: McpReader;
const enc = new TextEncoder();
// APFS cannot hold both Unicode spellings. This seam leaves real files and
// real enumeration in place while allowing the same collision on macOS.
const normalForm = (name: string): string => name.normalize("NFC").replaceAll("~", "");
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "telimus-mcp-read-")));
  reader = new McpReader(new NodeVault(root, { observeOnly: true }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reader.drain();
  await rm(root, { recursive: true, force: true });
});
async function put(path: string, text: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}
it("searches parsed tags without matching code, comments, or ordinary prose", async () => {
  await put("real.md", "---\r\ntags: [Project/Active]\r\n---\r\nbody\r\n");
  await put("inline.md", "#project/active\n");
  await put(
    "prose.md",
    "project/active\n`#project/active`\n<!-- #project/active -->\n````\n```\n#project/active\n````\n",
  );
  const found = await reader.search({ query: "project/active", mode: "tag" } as Parameters<
    McpReader["search"]
  >[0]);
  expect(found.matches.map((row) => row.path)).toEqual(["inline.md", "real.md"]);
  expect(found.complete).toBe(true);
});
it("paginates filename matches independently from content and binds the search mode", async () => {
  await put("a-needle.md", "no content match");
  await put("b-needle.md", "no content match");
  await put("c.md", "needle");
  const input = { query: "needle", mode: "filename", limit: 1 } as Parameters<
    McpReader["search"]
  >[0];
  const first = await reader.search(input);
  expect(first.matches.map((row) => row.path)).toEqual(["a-needle.md"]);
  const second = await reader.search({ ...input, cursor: first.nextCursor! });
  expect(second.matches.map((row) => row.path)).toEqual(["b-needle.md"]);
  await expect(
    reader.search({ ...input, mode: "content", cursor: first.nextCursor! } as Parameters<
      McpReader["search"]
    >[0]),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
});
it("finds nested tags by default and can restrict tag search to the exact parent", async () => {
  await put("child.md", "#project/active\n");
  await put("parent.md", "#Project\n");
  await put("prefix.md", "#projectile\n");
  const input = { query: "project", mode: "tag" } as Parameters<McpReader["search"]>[0];
  expect((await reader.search(input)).matches.map((row) => row.path)).toEqual([
    "child.md",
    "parent.md",
  ]);
  expect(
    (
      await reader.search({ ...input, includeChildren: false } as Parameters<
        McpReader["search"]
      >[0])
    ).matches.map((row) => row.path),
  ).toEqual(["parent.md"]);
});
it("keeps filename hits when combined search cannot decode the note body", async () => {
  await writeFile(join(root, "unreadable-needle.md"), Buffer.from([0xff]));
  const result = await reader.search({ query: "needle", mode: "both" });
  expect(result.matches.map((row) => row.path)).toEqual(["unreadable-needle.md"]);
  expect(result.skipped.count).toBe(1);
  expect(result.complete).toBe(false);
});
it("does not return duplicate scalar-tag coordinates that pagination cannot resume", async () => {
  await put("note.md", "---\ntags: old old\n---\n");
  const result = await reader.search({ query: "old", mode: "tag", limit: 1 });
  expect(result.matches).toHaveLength(1);
  expect(result.nextCursor).toBeNull();
  expect(result.complete).toBe(true);
});
it("reads and lists through a root alias while refusing child links", async () => {
  await put("real/note.md", "inside the aliased root");
  await put("outside/note.md", "outside the aliased root");
  await symlink(join(root, "real"), join(root, "alias"));
  await symlink(join(root, "outside"), join(root, "real/linked"));
  reader = new McpReader(new NodeVault(join(root, "alias"), { observeOnly: true }));
  expect((await reader.read({ path: "note.md" })).content).toBe("inside the aliased root");
  expect((await reader.list({})).entries.map((entry) => entry.path)).toEqual(["note.md"]);
  await expect(reader.read({ path: "linked/note.md" })).rejects.toThrow(/link/);
});
it("accepts its own continuation when a legal path needs extensive JSON escaping", async () => {
  // Linux permits this path, but macOS's shorter absolute-path limit prevents
  // constructing it here. The inventory is the only substituted operation.
  const folder = Array.from({ length: 16 }, () => "\u0001".repeat(200)).join("/");
  const paths = [`${folder}/a.md`, `${folder}/b.md`];
  paths.forEach((path) => reader.vault.assertPathPolicy(path));
  vi.spyOn(reader.vault, "list").mockResolvedValue(
    paths.map((path) => ({ path, folder: false, size: 6, mtime: 1, ctime: 1 })),
  );
  const first = await reader.list({ limit: 1 });
  const second = await reader.list({ limit: 1, after: first.nextAfter! });
  expect(first.entries[0]!.path).toBe(paths[0]);
  expect(second.entries[0]!.path).toBe(paths[1]);
  expect(second.nextAfter).toBeNull();
});
it("lists a directory with a backup-shaped name as an ordinary folder", async () => {
  const folder = "my folder (MCP backup 20260915T120000Z abcdef0123456789).md";
  await put(`${folder}/note.md`, "ordinary note");
  const listed = await reader.list({});
  expect(listed.entries.find((entry) => entry.path === folder)).toMatchObject({ kind: "folder" });
  expect(listed.omitted.backups).toBe(0);
});
it("does not list outside metadata after a directory is replaced during enumeration", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "telimus-mcp-outside-")));
  try {
    await put("folder/inside.md", "inside");
    await writeFile(join(outside, "outside-private-title.md"), "secret");
    const original = vi.mocked(readdir).getMockImplementation()!;
    let swapped = false;
    vi.mocked(readdir).mockImplementation(async (...args) => {
      const entries = await original(...args);
      if (
        !swapped &&
        String(args[0]) === root &&
        (args[1] as { withFileTypes?: boolean })?.withFileTypes
      ) {
        swapped = true;
        await rename(join(root, "folder"), join(root, "saved"));
        await symlink(outside, join(root, "folder"));
      }
      return entries;
    });
    await expect(reader.list({})).rejects.toMatchObject({ code: "changed_during_read" });
    expect(swapped).toBe(true);
    expect(await readFile(join(outside, "outside-private-title.md"), "utf8")).toBe("secret");
    expect(await readFile(join(root, "saved/inside.md"), "utf8")).toBe("inside");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it("drains sibling walks after a refusal before the next reader enters the inventory", async () => {
  await put("a/note.md", "first");
  await put("b/note.md", "second");
  const blocked = deferred();
  const release = deferred();
  const original = vi.mocked(readdir).getMockImplementation()!;
  let inventories = 0;
  let fault = true;
  vi.mocked(readdir).mockImplementation(async (...args) => {
    const typed = (args[1] as { withFileTypes?: boolean })?.withFileTypes;
    if (typed && String(args[0]) === root) inventories++;
    if (typed && String(args[0]) === join(root, "a") && fault) {
      fault = false;
      throw Object.assign(new Error("unreadable child"), { code: "EACCES" });
    }
    if (typed && String(args[0]) === join(root, "b") && inventories === 1) {
      blocked.resolve();
      await release.promise;
    }
    return original(...args);
  });
  const first = reader.list({});
  const refused = expect(first).rejects.toThrow(/unreadable child/);
  let finished = false;
  void first.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    await within(blocked.promise, "the sibling inventory to block");
    const second = reader.list({});
    await nextTurn();
    expect(finished).toBe(false);
    expect(inventories).toBe(1);
    release.resolve();
    await refused;
    expect((await second).entries.filter((entry) => entry.kind === "note")).toHaveLength(2);
  } finally {
    release.resolve();
    await refused;
  }
});
it("makes progress when escaping search context would otherwise consume the entire page", async () => {
  const long = "\u0001".repeat(2048);
  await put("note.md", [long, long, long, "needle" + long, long, long, long].join("\n"));
  const result = await reader.search({ query: "needle", contextLines: 3 });
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]!.clipped).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.matches))).toBeLessThanOrEqual(PAGE_TEXT_BYTES);
  expect(result.nextCursor).toBeNull();
});
it("returns complete-source bases and preserves BOM and CRLF across pages", async () => {
  const source = "\ufeff---\r\ntitle: Daily\r\n---\r\n\r\n- [ ] Task\r\n";
  await put("note.md", source);
  const first = await reader.read({ path: "note.md", maxLines: 2 });
  const second = await reader.read({
    path: "note.md",
    startLine: first.nextLine!,
    maxLines: 2,
    base: first.base,
  });
  const third = await reader.read({
    path: "note.md",
    startLine: second.nextLine!,
    base: first.base,
  });
  expect(first.content + second.content + third.content).toBe(source);
  expect(first.base).toBe(noteDigest(enc.encode(source)));
  expect(third.complete).toBe(true);
  await put("note.md", source + "changed");
  await expect(
    reader.read({ path: "note.md", startLine: 3, base: first.base }),
  ).rejects.toMatchObject({ code: "stale" });
});
it("refuses a line larger than the page budget instead of returning a stuck continuation", () => {
  expect(() =>
    pageNote(enc.encode("x".repeat(PAGE_TEXT_BYTES + 1)), "note.md", { path: "note.md" }),
  ).toThrow(/line/);
});
it("pages by bytes even when the line-count limit has room", async () => {
  const source = ("x".repeat(1023) + "\n").repeat(1024);
  await put("note.md", source);
  const first = await reader.read({ path: "note.md", maxLines: 1000 });
  expect(first.content.length).toBe(PAGE_TEXT_BYTES);
  expect(first.nextLine).toBe(65);
  expect(first.size).toBe(1024 * 1024);
});
it("lists attachments, hides backups explicitly and keeps folder boundaries", async () => {
  await put("Daily/a.md", "a");
  await put("Daily/b.pdf", "PDF");
  await put("Dailyish/c.md", "outside");
  await put("Daily/a (MCP backup 20260915T120000Z abcdef0123456789).md", "backup");
  const first = await reader.list({ folder: "Daily", limit: 1 });
  expect(first.entries.map((row) => row.path)).toEqual(["Daily/a.md"]);
  expect(first.omitted.backups).toBe(1);
  const second = await reader.list({ folder: "Daily", limit: 1, after: first.nextAfter! });
  expect(second.entries[0]).toMatchObject({ path: "Daily/b.pdf", kind: "attachment" });
  expect(second.nextAfter).toBeNull();
  const all = await reader.list({ folder: "Daily", includeBackups: true });
  expect(all.entries.find((row) => row.kind === "backup")?.backupOf).toBe("Daily/a.md");
  await expect(reader.list({ folder: "Dailyish", after: first.nextAfter! })).rejects.toMatchObject({
    code: "invalid_cursor",
  });
});
it("continues through later hits after an early page fills", async () => {
  await put("a.md", "needle needle\nneedle\n");
  await put("b.md", "later needle\n");
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const result = await reader.search({
      query: "needle",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...result.matches.map((row) => `${row.path}:${row.line}:${row.column}`));
    if (!result.nextCursor) {
      expect(result.complete).toBe(true);
      break;
    }
    expect(result.nextCursor).not.toBe(cursor);
    cursor = result.nextCursor;
  }
  expect(seen).toEqual(["a.md:1:1", "a.md:1:8", "a.md:2:1", "b.md:1:7"]);
});
it("searches literal syntax and multiline literals without interpreting a regex", async () => {
  await put("note.md", "Literal [a-z]+?\nsecond line\n");
  expect((await reader.search({ query: "[a-z]+?" })).matches).toHaveLength(1);
  expect((await reader.search({ query: "+?\nsecond" })).matches[0]).toMatchObject({
    line: 1,
    column: 14,
  });
});
it("reports unreadable or unsupported content without calling the search complete", async () => {
  await put("bad.md", "valid until replaced");
  await writeFile(join(root, "bad.md"), Buffer.from([0xff]));
  await put("file.pdf", "needle");
  await put("good.md", "needle");
  const result = await reader.search({ query: "needle" });
  expect(result.matches.map((row) => row.path)).toEqual(["good.md"]);
  expect(result.omitted.unsupported).toBe(1);
  expect(result.skipped.count).toBe(1);
  expect(result.complete).toBe(false);
  expect(result.nextCursor).toBeNull();
});
it("keeps ignored aliases and links out of named reads and listings", async () => {
  const vault = new NodeVault(root, { observeOnly: true, configDir: "Settings" });
  reader = new McpReader(vault);
  await put("settings/secret.md", "credential");
  await put("note.md", "visible");
  await symlink(join(root, "settings/secret.md"), join(root, "alias.md"));
  expect((await reader.list({})).entries.map((row) => row.path)).toEqual(["note.md"]);
  await expect(reader.read({ path: "settings/secret.md" })).rejects.toThrow(/excluded/);
  await expect(reader.read({ path: "alias.md" })).rejects.toThrow(/link/);
  expect(await readFile(join(root, "settings/secret.md"), "utf8")).toBe("credential");
});
it("serializes eight concurrent walks and gives the same pages as sequential reads", async () => {
  for (let i = 0; i < 12; i++) await put(`note-${i}.md`, `needle ${i}`);
  const list = await reader.list({});
  const search = await reader.search({ query: "needle" });
  const strip = (value: Record<string, unknown>) => ({ ...value, observedAt: 0 });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      i % 2 ? reader.search({ query: "needle" }) : reader.list({}),
    ),
  );
  results.forEach((value, i) => expect(strip(value)).toEqual(strip(i % 2 ? search : list)));
});
it("stops a cancelled search before reading another note", async () => {
  await put("a.md", "needle");
  await put("b.md", "needle");
  const controller = new AbortController();
  const read = reader.vault.readSnapshot.bind(reader.vault);
  const spy = vi.spyOn(reader.vault, "readSnapshot").mockImplementation(async (...args) => {
    const result = await read(...args);
    controller.abort();
    return result;
  });
  await expect(reader.search({ query: "needle" }, controller.signal)).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(spy).toHaveBeenCalledTimes(1);
});

it("allows inspecting a text drawing without authorizing its mutation", async () => {
  const drawing = "---\nexcalidraw-plugin: parsed\n---\n# Drawing\n";
  await put("sketch.excalidraw.md", drawing);
  expect((await reader.read({ path: "sketch.excalidraw.md" })).content).toBe(drawing);
});

it("reports ambiguous notes omitted by the inventory as an incomplete search", async () => {
  reader = new McpReader(new NodeVault(root, { observeOnly: true, normalForm }));
  await put("cafe.md", "needle in the first spelling");
  await put("cafe~.md", "needle in the second spelling");
  expect((await reader.list({})).ambiguousCount).toBe(1);
  const result = await reader.search({ query: "needle" });
  expect(result).toMatchObject({
    matches: [],
    scanned: 0,
    complete: false,
    nextCursor: null,
    skipped: { count: 1, items: [{ path: "cafe.md", why: "ambiguous_path" }], truncated: false },
  });
  expect(await readFile(join(root, "cafe.md"), "utf8")).toBe("needle in the first spelling");
  expect(await readFile(join(root, "cafe~.md"), "utf8")).toBe("needle in the second spelling");
});
it.each(["folder", "folder.pdf", "folder (MCP backup 20260915T120000Z abcdef0123456789).md"])(
  "reports an ambiguous subtree even when its name %s resembles an omitted file",
  async (folder) => {
    reader = new McpReader(new NodeVault(root, { observeOnly: true, normalForm }));
    await put(`${folder}/note.md`, "needle in the first folder");
    await put(`${folder}~/note.md`, "needle in the second folder");
    const result = await reader.search({ query: "needle" });
    expect(result).toMatchObject({
      matches: [],
      scanned: 0,
      complete: false,
      nextCursor: null,
      skipped: { count: 1, items: [{ path: folder, why: "ambiguous_path" }] },
    });
  },
);
it("keeps ambiguity outside the search folder and excluded paths out of coverage", async () => {
  reader = new McpReader(
    new NodeVault(root, { observeOnly: true, normalForm, configDir: "Private" }),
  );
  await put("Daily/note.md", "needle");
  await put("Daily/note (MCP backup 20260915T120000Z abcdef0123456789).md", "needle in backup");
  await put("Daily/Private/secret.md", "needle in excluded state");
  await put("Daily/Private/secret~.md", "needle in excluded state");
  await put("Dailyish/cafe.md", "needle outside the folder");
  await put("Dailyish/cafe~.md", "needle outside the folder");
  const result = await reader.search({ query: "needle", folder: "Daily" });
  expect(result.matches.map((row) => row.path)).toEqual(["Daily/note.md"]);
  expect(result.skipped.count).toBe(0);
  expect(result.omitted.backups).toBe(1);
  expect(result.complete).toBe(true);
});
it("keeps an ambiguous omission visible on every continuation page", async () => {
  reader = new McpReader(new NodeVault(root, { observeOnly: true, normalForm }));
  await put("a.md", "unsearchable needle");
  await put("a~.md", "another unsearchable needle");
  await put("z.md", "needle needle");
  const first = await reader.search({ query: "needle", limit: 1 });
  expect(first.nextCursor).not.toBeNull();
  expect(first.matches[0]?.column).toBe(1);
  expect(first.skipped.count).toBe(1);
  const last = await reader.search({ query: "needle", limit: 1, cursor: first.nextCursor! });
  expect(last.matches[0]?.column).toBe(8);
  expect(last.nextCursor).toBeNull();
  expect(last.complete).toBe(false);
  expect(last.skipped).toMatchObject({
    count: 1,
    items: [{ path: "a.md", why: "ambiguous_path" }],
  });
});
it("bounds ambiguity samples while retaining the total alongside failed reads", async () => {
  reader = new McpReader(new NodeVault(root, { observeOnly: true, normalForm }));
  for (let i = 0; i < 21; i++) {
    await put(`note-${i}.md`, "needle in the first spelling");
    await put(`note-${i}~.md`, "needle in the second spelling");
  }
  await writeFile(join(root, "bad.md"), Buffer.from([0xff]));
  const result = await reader.search({ query: "needle" });
  expect(result.skipped.count).toBe(22);
  expect(result.skipped.items).toHaveLength(20);
  expect(result.skipped.items.every((entry) => entry.why === "ambiguous_path")).toBe(true);
  expect(result.skipped.truncated).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.scanned).toBe(1);
});
