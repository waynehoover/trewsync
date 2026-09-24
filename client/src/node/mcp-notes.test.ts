import { createHash } from "node:crypto";
import { mkdtemp, rm, open, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { NodeVault } from "./vault.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm), open: vi.fn(actual.open) };
});

const enc = new TextEncoder();
const dec = new TextDecoder();
const times = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };
const digest = async (bytes: Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex");
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trew-mcp-notes-"));
});
afterEach(async () => {
  vi.mocked(rm).mockRestore();
  vi.mocked(open).mockRestore();
  await rm(root, { recursive: true, force: true });
});

// The unsafe control for the MCP transaction. The engine calls replace with
// an ancestor it has reconciled; an agent's current digest proves no such
// history exists. A service must preserve the unsent input independently.
it("shows why a current digest cannot replace a before-image", async () => {
  const vault = new NodeVault(root);
  const original = enc.encode(
    "# Daily\n\nUNSENT: call the school about the trip\n\n- [ ] Book tickets\n",
  );
  const proposed = enc.encode("# Daily\n\n- [x] Book tickets\n");
  expect(await vault.create("Daily.md", original, times)).toBe(true);
  await vault.flush();
  const base = await digest(await vault.read("Daily.md"));
  await vault.replace("Daily.md", { contentId: base, idOf: digest }, proposed, times, "kept.md");
  await vault.flush();
  expect(await vault.read("Daily.md")).toEqual(proposed);

  const reader = new NodeVault(root, { observeOnly: true });
  const copies = await Promise.all(
    (await reader.list()).filter((entry) => !entry.folder).map((entry) => reader.read(entry.path)),
  );
  expect(copies.map((bytes) => dec.decode(bytes)).join("\n")).not.toContain(
    "UNSENT: call the school about the trip",
  );
});

it("preserves the unsent before-image through the note transaction and restart", async () => {
  const { mutateNote } = await import("./mcp-notes.ts");
  const vault = new NodeVault(root);
  const original = enc.encode("UNSENT: call the school about the trip\r\n- [ ] Book tickets\r\n");
  await vault.create("Daily.md", original, times);
  await vault.flush();
  const result = await mutateNote(
    vault,
    {
      kind: "append",
      path: "Daily.md",
      base: await digest(original),
      text: "\r\nBooked the hotel.\r\n",
    },
    () => {},
    "laptop",
  );
  expect(result.applied).toBe(true);
  expect(result.beforeImage, "the unsent source has an independent durable name").toBeTypeOf(
    "string",
  );
  const fresh = new NodeVault(root, { observeOnly: true });
  expect(await fresh.read(result.beforeImage!)).toEqual(original);
  expect(await fresh.read("Daily.md")).toEqual(
    new Uint8Array(Buffer.concat([original, enc.encode("\r\nBooked the hotel.\r\n")])),
  );
});

import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import { backupOf, mutateNote, NOTE_BYTES, type NoteMutation } from "./mcp-notes.ts";
import { midReplace } from "./vault.ts";
import { releaseAllSeams } from "../core/seam.ts";

afterEach(() => {
  vi.restoreAllMocks();
  releaseAllSeams();
});
async function seeded(
  text = "# Daily\r\n\r\n- [ ] Book tickets\r\n- [ ] Pack bags\r\n\r\nUNSENT: call the school\r\n",
) {
  const vault = new NodeVault(root);
  const bytes = enc.encode(text);
  await vault.create("Daily.md", bytes, times);
  await vault.flush();
  const changed: string[] = [];
  const run = (request: NoteMutation) =>
    mutateNote(vault, request, (path) => changed.push(path), "laptop");
  return { vault, bytes, base: await digest(bytes), run, changed };
}
async function survivors(): Promise<Record<string, string>> {
  const reader = new NodeVault(root, { observeOnly: true });
  const contents: Record<string, string> = {};
  for (const entry of await reader.list()) {
    if (!entry.folder) contents[entry.path] = dec.decode(await reader.read(entry.path));
  }
  return contents;
}
it("prepends exact bytes without moving the BOM or losing unsent CRLF content", async () => {
  const { base, run, vault, bytes } = await seeded("\ufeffUNSENT original\r\n");
  const result = await run({
    kind: "prepend",
    path: "Daily.md",
    base,
    text: "Heading\r\n",
  } as NoteMutation);
  expect(result).toMatchObject({ applied: true, durable: true });
  expect(await vault.read("Daily.md")).toEqual(enc.encode("\ufeffHeading\r\nUNSENT original\r\n"));
  expect(await vault.read(result.beforeImage!)).toEqual(bytes);
  expect(
    await run({ kind: "prepend", path: "Daily.md", base, text: "Heading\r\n" } as NoteMutation),
  ).toMatchObject({ applied: false, error: { code: "stale" } });
});
it("changes two exact tasks together while preserving every unrelated byte", async () => {
  const input =
    "\ufeff---\r\ntags: [daily]\r\n---\r\n[[Family]] cafe\u0301 😀\r\n- [ ] Book tickets\r\n- [ ] Pack bags\r\nUNSENT end\r\n";
  const { vault, base, run, bytes, changed } = await seeded(input);
  const edits = [
    { old: "- [ ] Pack bags", new: "- [x] Pack bags" },
    { old: "- [ ] Book tickets", new: "- [x] Book tickets" },
  ];
  const result = await run({ kind: "edit", path: "Daily.md", base, edits });
  expect(result).toMatchObject({ applied: true, durable: true, sync: { state: "pending" } });
  expect(await vault.read("Daily.md")).toEqual(
    enc.encode(
      input
        .replace("- [ ] Pack bags", "- [x] Pack bags")
        .replace("- [ ] Book tickets", "- [x] Book tickets"),
    ),
  );
  expect(await vault.read(result.beforeImage!)).toEqual(bytes);
  expect(changed).toContain("Daily.md");
  expect(changed).toContain(result.beforeImage);
});
it("keeps explicitly removed unsent prose in the before-image", async () => {
  const { base, run } = await seeded();
  const result = await run({
    kind: "edit",
    path: "Daily.md",
    base,
    edits: [{ old: "UNSENT: call the school\r\n", new: "" }],
  });
  expect(result.applied).toBe(true);
  const copies = await survivors();
  expect(copies["Daily.md"]).not.toContain("UNSENT:");
  expect(copies[result.beforeImage!]).toContain("UNSENT: call the school");
});
it.each([
  {
    edits: [
      { old: "- [ ] Book tickets", new: "done" },
      { old: "missing", new: "lost" },
    ],
    code: "no_match",
  },
  { edits: [{ old: "[ ]", new: "[x]" }], code: "ambiguous_edit" },
  {
    edits: [
      { old: "Book tickets", new: "Booked" },
      { old: "tickets", new: "seats" },
    ],
    code: "overlapping_edits",
  },
  { edits: [{ old: "", new: "blank" }], code: "invalid_edits" },
  { edits: [], code: "invalid_edits" },
  {
    edits: Array.from({ length: 33 }, () => ({ old: "Book", new: "done" })),
    code: "invalid_edits",
  },
  { edits: [{ old: "Book", new: "x".repeat(8193) }], code: "input_too_large" },
  { edits: [{ old: "Book", new: "\ud800" }], code: "invalid_text" },
])("validates every edit before writing: $code", async ({ edits, code }) => {
  const { base, run, vault, bytes, changed } = await seeded();
  const result = await run({ kind: "edit", path: "Daily.md", base, edits });
  expect(result).toMatchObject({ applied: false, error: { code } });
  expect(await vault.read("Daily.md")).toEqual(bytes);
  expect(changed).toEqual([]);
  expect(Object.keys(await survivors())).toEqual(["Daily.md"]);
});
it("counts overlapping occurrences of an old span", async () => {
  const { base, run } = await seeded("aaaa");
  expect(
    await run({ kind: "edit", path: "Daily.md", base, edits: [{ old: "aaa", new: "b" }] }),
  ).toMatchObject({ applied: false, error: { code: "ambiguous_edit" } });
});
it("rejects an aggregate edit budget even with individually valid replacements", async () => {
  const { base, run, changed } = await seeded(
    Array.from({ length: 9 }, (_, i) => `unique-${i}`).join("\n"),
  );
  const edits = Array.from({ length: 9 }, (_, i) => ({
    old: `unique-${i}`,
    new: "x".repeat(8192),
  }));
  expect(await run({ kind: "edit", path: "Daily.md", base, edits })).toMatchObject({
    applied: false,
    error: { code: "input_too_large" },
  });
  expect(changed).toEqual([]);
});
it("refuses a stale base even if the newer note has the same size and mtime", async () => {
  const { base, run } = await seeded("before");
  await writeFile(join(root, "Daily.md"), "edited");
  await utimes(join(root, "Daily.md"), times.mtime / 1000, times.mtime / 1000);
  const result = await run({ kind: "append", path: "Daily.md", base, text: " suffix" });
  expect(result).toMatchObject({ applied: false, error: { code: "stale" } });
  expect(result.base).toBeUndefined();
  expect(await survivors()).toEqual({ "Daily.md": "edited" });
});
it("does not append twice when the first response was lost", async () => {
  const { base, run } = await seeded("source");
  const request: NoteMutation = {
    kind: "append",
    path: "Daily.md",
    base,
    text: "\r\nexact suffix",
  };
  expect(await run(request)).toMatchObject({ applied: true, durable: true });
  expect(await run(request)).toMatchObject({ applied: false, error: { code: "stale" } });
  const files = await survivors();
  expect(files["Daily.md"]).toBe("source\r\nexact suffix");
  expect(Object.keys(files)).toHaveLength(2);
});
it("appends the supplied bytes without inventing a newline", async () => {
  const { base, run } = await seeded("source");
  expect((await run({ kind: "append", path: "Daily.md", base, text: "suffix" })).applied).toBe(
    true,
  );
  expect((await survivors())["Daily.md"]).toBe("sourcesuffix");
});
it("does not create a missing append target", async () => {
  const vault = new NodeVault(root);
  const result = await mutateNote(
    vault,
    { kind: "append", path: "missing.md", base: "a".repeat(64), text: "text" },
    () => {},
    "laptop",
  );
  expect(result).toMatchObject({ applied: false, error: { code: "not_found_local" } });
  expect(await readdir(root)).toEqual([]);
});
it.each(["base", "source", "suffix", "oversized"])(
  "refuses invalid %s before writing",
  async (kind) => {
    const { vault, base, run, changed } = await seeded(
      kind === "oversized" ? "x".repeat(NOTE_BYTES) : "original",
    );
    if (kind === "source") await writeFile(join(root, "Daily.md"), Buffer.from([0xff, 0xfe]));
    const actualBase =
      kind === "source" ? await digest(await readFile(join(root, "Daily.md"))) : base;
    const result = await run({
      kind: "append",
      path: "Daily.md",
      base: kind === "base" ? "no" : actualBase,
      text: kind === "suffix" ? "\udfff" : "suffix",
    });
    expect(result.applied).toBe(false);
    expect(result.error).toBeDefined();
    expect(changed).toEqual([]);
    expect(await vault.exists("Daily.md")).toBe(true);
  },
);
it("reports a no-op without a backup, flush, or timestamp change", async () => {
  const { vault, base, run, changed } = await seeded("unchanged");
  const before = await vault.stat("Daily.md");
  const flush = vi.spyOn(vault, "flush");
  expect(
    await run({
      kind: "edit",
      path: "Daily.md",
      base,
      edits: [{ old: "unchanged", new: "unchanged" }],
    }),
  ).toMatchObject({ applied: false, noop: true, base });
  expect(flush).not.toHaveBeenCalled();
  expect(changed).toEqual([]);
  expect(await vault.stat("Daily.md")).toEqual(before);
});
it.each(["create", "readback", "flush"])(
  "leaves the source alone when backup %s fails",
  async (failure) => {
    const { vault, base, run, bytes, changed } = await seeded();
    const create = vault.create.bind(vault);
    if (failure === "create")
      vi.spyOn(vault, "create").mockImplementation(async (path, content, stamp) => {
        if (!backupOf(path)) return create(path, content, stamp);
        await writeFile(join(root, path), content.slice(0, 7));
        throw new Error("partial exclusive fallback");
      });
    if (failure === "readback") {
      const read = vault.readSnapshot.bind(vault);
      vi.spyOn(vault, "readSnapshot").mockImplementation(async (path, max) => {
        if (backupOf(path)) await writeFile(join(root, path), "corrupt backup");
        return read(path, max);
      });
    }
    if (failure === "flush")
      vi.spyOn(vault, "flush").mockRejectedValueOnce(new Error("directory fsync failed"));
    const result = await run({ kind: "append", path: "Daily.md", base, text: "new" });
    expect(result).toMatchObject({ applied: false, durable: false });
    expect(result.error).toBeDefined();
    expect(await vault.read("Daily.md")).toEqual(bytes);
    expect(result.beforeImage).toBeUndefined();
    expect(result.preserved).toHaveLength(1);
    expect(changed).toContain(result.preserved[0]);
    expect(changed).not.toContain("Daily.md");
    expect(await vault.exists(result.preserved[0]!)).toBe(true);
  },
);
it("reads and flushes the verified backup before starting replacement", async () => {
  const { vault, base, run, bytes } = await seeded();
  const events: string[] = [];
  const read = vault.readSnapshot.bind(vault);
  const flush = vault.flush.bind(vault);
  vi.spyOn(vault, "readSnapshot").mockImplementation(async (path, max) => {
    const result = await read(path, max);
    events.push(backupOf(path) ? "read backup" : "read source");
    return result;
  });
  vi.spyOn(vault, "flush").mockImplementation(async () => {
    events.push("flush");
    await flush();
  });
  midReplace.staged = async () => {
    expect(events).toContain("read backup");
    expect(events.indexOf("read backup")).toBeLessThan(events.indexOf("flush"));
    expect(events.lastIndexOf("read source")).toBeGreaterThan(events.indexOf("flush"));
    expect(Object.values(await survivors())).toContain(dec.decode(bytes));
  };
  expect(await run({ kind: "append", path: "Daily.md", base, text: "new" })).toMatchObject({
    applied: true,
    durable: true,
  });
});
it("keeps the backup and refuses if the source changes during backup preparation", async () => {
  const { vault, base, run, bytes } = await seeded();
  const flush = vault.flush.bind(vault);
  vi.spyOn(vault, "flush").mockImplementationOnce(async () => {
    await flush();
    await writeFile(join(root, "Daily.md"), "newer local version");
  });
  const result = await run({ kind: "append", path: "Daily.md", base, text: "proposed" });
  expect(result).toMatchObject({ applied: false, error: { code: "stale" } });
  expect((await survivors())["Daily.md"]).toBe("newer local version");
  expect(await vault.read(result.beforeImage!)).toEqual(bytes);
});
it.each(["staged", "nameFree"])("reads every surviving branch after a %s race", async (seam) => {
  const { base, run, bytes } = await seeded("UNSENT original");
  midReplace[seam as "staged" | "nameFree"] = async () => {
    await writeFile(join(root, "Daily.md"), "independent local branch");
  };
  const result = await run({ kind: "append", path: "Daily.md", base, text: " plus proposed" });
  expect(result.error?.code).toBe("race");
  expect(result.durable).toBe(true);
  expect(result.applied).toBe(seam === "staged");
  const all = await survivors();
  expect(Object.values(all)).toContain(dec.decode(bytes));
  expect(Object.values(all)).toContain("independent local branch");
  expect(Object.values(all)).toContain("UNSENT original plus proposed");
  for (const path of result.preserved) expect(all[path]).toBeDefined();
});
it.each(["throw after publish", "flush after publish"])(
  "reports actual partial publication on %s",
  async (failure) => {
    const { vault, base, run, bytes } = await seeded("original");
    if (failure === "throw after publish") {
      const replace = vault.replace.bind(vault);
      vi.spyOn(vault, "replace").mockImplementation(async (...args) => {
        await replace(...args);
        throw new Error("after publishing");
      });
    } else {
      const flush = vault.flush.bind(vault);
      let count = 0;
      vi.spyOn(vault, "flush").mockImplementation(async () => {
        if (++count > 1) throw new Error("publication directory flush");
        await flush();
      });
    }
    const result = await run({ kind: "append", path: "Daily.md", base, text: " suffix" });
    expect(result).toMatchObject({ applied: true, durable: false });
    expect(result.error).toBeDefined();
    expect(await vault.read(result.beforeImage!)).toEqual(bytes);
    expect(await vault.read("Daily.md")).toEqual(enc.encode("original suffix"));
  },
);
it("claims another backup name without replacing an occupied candidate", async () => {
  const { vault, base, run } = await seeded("original");
  const create = vault.create.bind(vault);
  let occupied: string | undefined;
  vi.spyOn(vault, "create").mockImplementation(async (path, bytes, stamp) => {
    if (!occupied && backupOf(path)) {
      occupied = path;
      await create(path, enc.encode("someone else"), stamp);
      return false;
    }
    return create(path, bytes, stamp);
  });
  const result = await run({ kind: "append", path: "Daily.md", base, text: "suffix" });
  expect(result.applied).toBe(true);
  expect(result.beforeImage).not.toBe(occupied);
  expect(await vault.read(occupied!)).toEqual(enc.encode("someone else"));
});
it.each(["edit", "append", "create"])("reserves backup names from %s", async (kind) => {
  const path = "Daily (MCP backup 20260915T120000Z abcdef0123456789).md";
  const { run, base, changed } = await seeded();
  const request =
    kind === "edit"
      ? { kind: "edit" as const, path, base, edits: [{ old: "a", new: "b" }] }
      : kind === "append"
        ? { kind: "append" as const, path, base, text: "text" }
        : { kind: "create" as const, path, content: "text" };
  expect(await run(request)).toMatchObject({ applied: false, error: { code: "reserved_backup" } });
  expect(changed).toEqual([]);
});
it.each(["drawing.excalidraw.md", "config.json", ".obsidian/secret.md"])(
  "refuses unsupported or excluded mutation %s",
  async (path) => {
    const { run, changed } = await seeded();
    const result = await run({ kind: "create", path, content: "text" });
    expect(result.applied).toBe(false);
    expect(result.error).toBeDefined();
    expect(changed).toEqual([]);
  },
);
it("creates and verifies once, then refuses a retry at the same destination", async () => {
  const { run, vault } = await seeded();
  const request: NoteMutation = { kind: "create", path: "New/note.txt", content: "\ufeffnew\r\n" };
  const result = await run(request);
  expect(result).toMatchObject({ applied: true, durable: true });
  expect(result.beforeImage).toBeUndefined();
  expect(await vault.read(request.path)).toEqual(enc.encode(request.content));
  expect(await run(request)).toMatchObject({ applied: false, error: { code: "exists" } });
});
it("retains and identifies partial exclusive creation instead of retrying over it", async () => {
  const { vault, run, changed } = await seeded();
  const create = vault.create.bind(vault);
  vi.spyOn(vault, "create").mockImplementation(async (path, bytes, stamp) => {
    if (path === "new.md") {
      await writeFile(join(root, path), bytes.slice(0, 3));
      throw new Error("partial fallback");
    }
    return create(path, bytes, stamp);
  });
  const result = await run({ kind: "create", path: "new.md", content: "complete new content" });
  expect(result).toMatchObject({ applied: "unknown", durable: false });
  expect(result.error).toBeDefined();
  const all = await survivors();
  expect(all["new.md"]).toBe("com");
  expect(Object.values(all)).toContain("complete new content");
  expect(changed).toContain("new.md");
});

it("reports the independent branch stranded by a failed preservation claim", async () => {
  const { midPreserve } = await import("./vault.ts");
  const { run, base } = await seeded("original unsent");
  midReplace.staged = async () => {
    await writeFile(join(root, "Daily.md"), "independent branch stranded");
  };
  midPreserve.beforeClaim = async () => {
    throw new Error("no recovery destination available");
  };
  const result = await run({ kind: "append", path: "Daily.md", base, text: " with agent edit" });
  expect(result.error).toBeDefined();
  const reader = new NodeVault(root, { observeOnly: true });
  await reader.list();
  expect(reader.displaced).toHaveLength(1);
  const stranded = reader.displaced[0]!.at;
  expect(await readFile(join(root, stranded), "utf8")).toBe("independent branch stranded");
  expect(result.preserved).toContain(stranded);
});

it("reports a preserved branch even when staging cleanup overrides the adapter result", async () => {
  const { run, base } = await seeded("original unsent");
  midReplace.staged = async () => {
    await writeFile(join(root, "Daily.md"), "independent branch");
  };
  const realRm = vi.mocked(rm).getMockImplementation()!;
  let fault = false;
  vi.mocked(rm).mockImplementation(async (...args) => {
    if (!fault && /\/\.trew\/tmp\/replace\.[a-f0-9]+$/u.test(String(args[0]))) {
      fault = true;
      throw Object.assign(new Error("staging cleanup failed"), { code: "EIO" });
    }
    return realRm(...args);
  });
  const result = await run({ kind: "append", path: "Daily.md", base, text: " with agent edit" });
  expect(fault).toBe(true);
  expect(result).toMatchObject({ applied: true, durable: false });
  const all = await survivors();
  const independent = Object.keys(all).find((path) => all[path] === "independent branch");
  expect(independent).toBeDefined();
  expect(result.preserved).toContain(independent);
});

it.each([
  "folder\nname/Daily.md",
  "note\rname.md",
  "line\u2028separator.md",
  "paragraph\u2029separator.md",
])("keeps a backup read-only even with line terminators in %j", async (path) => {
  const { run, vault } = await seeded();
  await run({ kind: "create", path, content: "original" });
  const first = await run({
    kind: "append",
    path,
    base: await digest(enc.encode("original")),
    text: " next",
  });
  expect(first.applied).toBe(true);
  const backup = first.beforeImage!;
  const second = await run({
    kind: "append",
    path: backup,
    base: await digest(enc.encode("original")),
    text: " corrupt recovery",
  });
  expect(second).toMatchObject({ applied: false, error: { code: "reserved_backup" } });
  expect(await vault.read(backup)).toEqual(enc.encode("original"));
  expect(backupOf(backup)).toBe(path);
});

it("flushes an independent saved branch before reporting the race durable", async () => {
  const { base, run } = await seeded("original unsent");
  let tracking = false;
  const synced: number[] = [];
  const realOpen = vi.mocked(open).getMockImplementation()!;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      const stat = await handle.stat();
      await sync();
      if (tracking && stat.isFile()) synced.push(stat.ino);
    };
    return handle;
  });
  midReplace.staged = async () => {
    await writeFile(join(root, "Daily.md"), "independent branch");
    tracking = true;
  };
  const result = await run({ kind: "append", path: "Daily.md", base, text: " with agent edit" });
  expect(result.durable).toBe(true);
  expect(result.preserved).toHaveLength(1);
  const kept = await lstat(join(root, result.preserved[0]!));
  expect(synced).toContain(kept.ino);
  // Saved on this disk, not by the agent: named after this device, the author
  // of what it holds, where it used to say "MCP".
  expect(result.preserved[0]).toMatch(/^Daily \(Conflicted copy laptop \d{12}\)\.md$/);
  expect((await survivors())[result.preserved[0]!]).toBe("independent branch");
});

it("reports uncertainty if flushing the independent preserved branch fails", async () => {
  const { base, run } = await seeded("original unsent");
  const realOpen = vi.mocked(open).getMockImplementation()!;
  let failed = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]).includes(" (Conflicted copy laptop "))
      handle.sync = async () => {
        failed = true;
        throw new Error("preserved file fsync failed");
      };
    return handle;
  });
  midReplace.staged = async () => {
    await writeFile(join(root, "Daily.md"), "independent branch");
  };
  const result = await run({ kind: "append", path: "Daily.md", base, text: " plus proposed" });
  expect(failed).toBe(true);
  expect(result).toMatchObject({ applied: true, durable: false });
  expect(result.error).toBeDefined();
  const files = await survivors();
  expect(Object.values(files)).toContain("original unsent");
  expect(Object.values(files)).toContain("original unsent plus proposed");
  expect(files[result.preserved[0]!]).toBe("independent branch");
});
