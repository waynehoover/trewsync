import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "../core/test-server.ts";
import { releaseAllSeams } from "../core/seam.ts";
import { NodeVault } from "./vault.ts";
import { backupOf } from "./mcp-notes.ts";
import { previewOperation, applyOperation, type VaultOperation } from "./mcp-operations.ts";
let root: string, vault: NodeVault, observer: NodeVault;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trew-mcp-operations-"));
  vault = new NodeVault(root);
  observer = new NodeVault(root, { observeOnly: true });
});
afterEach(async () => {
  releaseAllSeams();
  vi.restoreAllMocks();
  await removeTree(root);
});
async function seed(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}
it("previews exact tag spans and applies them with every original preserved", async () => {
  await seed(
    "a.md",
    "---\r\nkeep:  yes # comment\r\ntags: [old]\r\n---\r\nUNSENT A #old/child\r\n",
  );
  await seed("b.md", "UNSENT B #old\n`#old`\n");
  const op: VaultOperation = {
    kind: "tags",
    change: { operation: "rename", oldTag: "old", newTag: "new", includeChildren: true },
  };
  const preview = await previewOperation(observer, op);
  expect(preview.changes).toHaveLength(2);
  expect(preview.changes[0]!.edits.some((edit) => edit.old.includes("old"))).toBe(true);
  const result = await applyOperation(vault, observer, op, preview.changes, () => {}, "laptop");
  expect(result.complete).toBe(true);
  expect(await readFile(join(root, "a.md"), "utf8")).toBe(
    '---\r\nkeep:  yes # comment\r\ntags: ["new"]\r\n---\r\nUNSENT A #new/child\r\n',
  );
  expect(await readFile(join(root, "b.md"), "utf8")).toBe("UNSENT B #new\n`#old`\n");
  for (const row of result.results)
    expect(await readFile(join(root, row.beforeImage!), "utf8")).toContain("UNSENT");
});
it("refuses changed plans, new affected notes and stale bases before any write", async () => {
  await seed("a.md", "#old UNSENT");
  const op: VaultOperation = {
    kind: "tags",
    change: { operation: "rename", oldTag: "old", newTag: "new" },
  };
  const preview = await previewOperation(observer, op);
  await seed("b.md", "#old new arrival");
  const create = vi.spyOn(vault, "create");
  const result = await applyOperation(vault, observer, op, preview.changes, () => {}, "laptop");
  expect(result.error?.code).toBe("plan_changed");
  expect(create).not.toHaveBeenCalled();
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("#old UNSENT");
});
it("moves after updating exact backlinks and outbound relative destinations", async () => {
  await seed("Project/A.md", "UNSENT A [B](B.md)\n");
  await seed("Project/B.md", "B\n");
  await seed("Index.md", '[[Project/A|label]] [A](Project/A.md "title")\n');
  const op: VaultOperation = { kind: "move", path: "Project/A.md", to: "Archive/A.md" };
  const preview = await previewOperation(observer, op);
  expect(preview.changes).toHaveLength(2);
  const result = await applyOperation(vault, observer, op, preview.changes, () => {}, "laptop");
  expect(result.complete).toBe(true);
  expect(await vault.exists("Project/A.md")).toBe(false);
  expect(await readFile(join(root, "Archive/A.md"), "utf8")).toBe(
    "UNSENT A [B](../Project/B.md)\n",
  );
  expect(await readFile(join(root, "Index.md"), "utf8")).toBe(
    '[[Archive/A|label]] [A](Archive/A.md "title")\n',
  );
  const source = result.results.find((row) => row.path === "Project/A.md")!;
  expect(await readFile(join(root, source.beforeImage!), "utf8")).toBe("UNSENT A [B](B.md)\n");
});
it("keeps the source and all before-images if a backlink application fails after destination creation", async () => {
  await seed("A.md", "UNSENT A");
  await seed("Index.md", "[[A]]");
  const op: VaultOperation = { kind: "move", path: "A.md", to: "B.md" };
  const preview = await previewOperation(observer, op);
  const { midNoteMutation } = await import("./mcp-notes.ts");
  midNoteMutation.durable = async (path) => {
    if (path === "B.md") await writeFile(join(root, "Index.md"), "new local link save");
  };
  const result = await applyOperation(vault, observer, op, preview.changes, () => {}, "laptop");
  expect(result.complete).toBe(false);
  expect(await readFile(join(root, "A.md"), "utf8")).toBe("UNSENT A");
  expect(await readFile(join(root, "B.md"), "utf8")).toBe("UNSENT A");
  expect(await readFile(join(root, "Index.md"), "utf8")).toBe("new local link save");
  expect(result.results.find((row) => row.path === "A.md")?.beforeImage).toBeDefined();
});
it("does not offer immutable recovery copies in a vault-wide tag plan", async () => {
  await seed("a.md", "#old");
  await seed("a (MCP backup 20260915T000000Z abcdef12).md", "#old original");
  const preview = await previewOperation(observer, {
    kind: "tags",
    change: { operation: "rename", oldTag: "old", newTag: "new" },
  });
  expect(preview.changes.map((row) => row.path)).toEqual(["a.md"]);
  expect(preview.changes.some((row) => backupOf(row.path))).toBe(false);
});

it("rejects supplied edits that would remove prose outside the semantic operation", async () => {
  await seed("a.md", "#old UNSENT prose");
  const operation: VaultOperation = {
    kind: "tags",
    paths: ["a.md"],
    change: { operation: "remove", tags: ["old"] },
  };
  const preview = await previewOperation(observer, operation);
  preview.changes[0]!.edits[0]!.end = 17;
  preview.changes[0]!.edits[0]!.old = "#old UNSENT prose";
  const create = vi.spyOn(vault, "create");
  expect(
    await applyOperation(vault, observer, operation, preview.changes, () => {}, "laptop"),
  ).toMatchObject({ complete: false, error: { code: "plan_changed" } });
  expect(create).not.toHaveBeenCalled();
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("#old UNSENT prose");
});
it("does not overwrite a move destination occupied during exclusive creation", async () => {
  await seed("a.md", "UNSENT A");
  await seed("Index.md", "[[a]]");
  const operation: VaultOperation = { kind: "move", path: "a.md", to: "b.md" };
  const preview = await previewOperation(observer, operation);
  const create = vault.create.bind(vault);
  vi.spyOn(vault, "create").mockImplementation(async (path, bytes, times) => {
    if (path === "b.md") await writeFile(join(root, path), "independent destination");
    return create(path, bytes, times);
  });
  const result = await applyOperation(
    vault,
    observer,
    operation,
    preview.changes,
    () => {},
    "laptop",
  );
  expect(result).toMatchObject({ complete: false, error: { code: "exists" } });
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("UNSENT A");
  expect(await readFile(join(root, "Index.md"), "utf8")).toBe("[[a]]");
  expect(await readFile(join(root, "b.md"), "utf8")).toBe("independent destination");
  for (const row of result.results.filter((row) => row.path !== "b.md"))
    expect(row.beforeImage).toBeDefined();
});
it("refuses a global operation if a note cannot be decoded instead of silently skipping it", async () => {
  await seed("a.md", "#old");
  await writeFile(join(root, "b.md"), Buffer.from([255]));
  const create = vi.spyOn(vault, "create");
  await expect(
    previewOperation(observer, {
      kind: "tags",
      change: { operation: "rename", oldTag: "old", newTag: "new" },
    }),
  ).rejects.toMatchObject({ code: "invalid_utf8" });
  expect(create).not.toHaveBeenCalled();
});
it.each([".trew/secret.md", "../outside.md", "a (MCP backup 20260915T000000Z abcdef12).md"])(
  "refuses namespace mutations of %s",
  async (path) => {
    await seed("a.md", "original");
    await expect(
      previewOperation(observer, { kind: "move", path: "a.md", to: path }),
    ).rejects.toBeDefined();
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("original");
  },
);
import { createDirectory } from "./mcp-operations.ts";
it("reports a created but unflushed directory without claiming durability", async () => {
  vi.spyOn(vault, "flush").mockRejectedValueOnce(new Error("fsync failed"));
  const result = await createDirectory(vault, "New/Folder", () => {});
  expect(result).toMatchObject({ applied: true, durable: false, error: { code: "io_error" } });
  expect((await vault.checkPath("New/Folder", { kind: "directory" })).exists).toBe(true);
});
it("treats an existing directory as a no-op and refuses files or excluded locations", async () => {
  await mkdir(join(root, "existing"));
  await seed("file.md", "keep");
  expect(await createDirectory(vault, "existing", () => {})).toMatchObject({
    applied: false,
    noop: true,
  });
  expect(await createDirectory(vault, "file.md", () => {})).toMatchObject({
    applied: false,
    error: { code: "not_regular_file" },
  });
  expect(await createDirectory(vault, ".trew/new", () => {})).toMatchObject({
    applied: false,
    error: { code: "excluded_path" },
  });
  expect(await readFile(join(root, "file.md"), "utf8")).toBe("keep");
});
it("bounds encoded paths before any batch writes, including control character expansion", async () => {
  const paths = Array.from({ length: 32 }, (_, i) => `${i}${"\u0001".repeat(100)}.md`);
  const create = vi.spyOn(vault, "create");
  await expect(
    previewOperation(observer, {
      kind: "tags",
      paths,
      change: { operation: "add", tags: ["tag"] },
    }),
  ).rejects.toMatchObject({ code: "batch_too_large" });
  expect(create).not.toHaveBeenCalled();
});
