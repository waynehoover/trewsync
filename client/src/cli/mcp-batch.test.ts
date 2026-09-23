import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "../core/test-server.ts";
import { releaseAllSeams } from "../core/seam.ts";
import { NodeVault, midTrash } from "./vault.ts";
import { backupOf, mutateNote, noteDigest, type NoteMutation } from "./mcp-notes.ts";

let root: string;
let vault: NodeVault;
const enc = new TextEncoder();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trew-mcp-batch-"));
  vault = new NodeVault(root);
});
afterEach(async () => {
  releaseAllSeams();
  vi.restoreAllMocks();
  await removeTree(root);
});
async function seed(path: string, text: string) {
  await writeFile(join(root, path), text);
  return noteDigest(enc.encode(text));
}
it("deletes only after independently preserving the exact unsent source", async () => {
  const base = await seed("note.md", "UNSENT original\r\n");
  const result = await mutateNote(
    vault,
    { kind: "delete", path: "note.md", base } as unknown as NoteMutation,
    () => {},
  );
  expect(result).toMatchObject({ applied: true, durable: true });
  expect(await vault.exists("note.md")).toBe(false);
  expect(await readFile(join(root, result.beforeImage!), "utf8")).toBe("UNSENT original\r\n");
});
it("does not report a racing save at the deleted name as an ordinary deletion", async () => {
  const base = await seed("note.md", "approved source");
  midTrash.parked = async () => {
    await writeFile(join(root, "note.md"), "independent save");
  };
  const result = await mutateNote(
    vault,
    { kind: "delete", path: "note.md", base } as unknown as NoteMutation,
    () => {},
  );
  expect(result).toMatchObject({ applied: false, error: { code: "race" } });
  expect(await readFile(join(root, "note.md"), "utf8")).toBe("independent save");
  expect(await readFile(join(root, result.beforeImage!), "utf8")).toBe("approved source");
});
it.each(["create", "readback", "flush"])(
  "leaves a delete source unchanged when backup %s fails",
  async (fault) => {
    const base = await seed("note.md", "UNSENT source");
    if (fault === "create")
      vi.spyOn(vault, "create").mockRejectedValueOnce(new Error("backup creation failed"));
    if (fault === "flush")
      vi.spyOn(vault, "flush").mockRejectedValueOnce(new Error("directory flush failed"));
    if (fault === "readback") {
      const read = vault.readSnapshot.bind(vault);
      vi.spyOn(vault, "readSnapshot").mockImplementation(async (path, cap, options) => {
        if (backupOf(path)) await writeFile(join(root, path), "corrupt backup");
        return read(path, cap, options);
      });
    }
    const result = await mutateNote(
      vault,
      { kind: "delete", path: "note.md", base } as unknown as NoteMutation,
      () => {},
    );
    expect(result.applied).toBe(false);
    expect(result.error).toBeDefined();
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("UNSENT source");
    expect(result.preserved).toHaveLength(1);
  },
);

import { applyBatch } from "./mcp-batch.ts";

it("preserves every before-image before touching the first original in a batch", async () => {
  const a = await seed("a.md", "UNSENT A");
  const b = await seed("b.md", "UNSENT B");
  const create = vault.create.bind(vault);
  vi.spyOn(vault, "create").mockImplementation(async (path, bytes, times) => {
    if (backupOf(path) === "b.md") throw new Error("second backup refused");
    return create(path, bytes, times);
  });
  const result = await applyBatch(
    vault,
    [
      { kind: "append", path: "a.md", base: a, text: " changed" },
      { kind: "append", path: "b.md", base: b, text: " changed" },
    ],
    () => {},
  );
  expect(result.complete).toBe(false);
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("UNSENT A");
  expect(await readFile(join(root, "b.md"), "utf8")).toBe("UNSENT B");
  expect(result.results[0]!.beforeImage).toBeDefined();
});
it("validates every base before creating any batch recovery files", async () => {
  const a = await seed("a.md", "A");
  await seed("b.md", "B");
  const create = vi.spyOn(vault, "create");
  const result = await applyBatch(
    vault,
    [
      { kind: "append", path: "a.md", base: a, text: " changed" },
      { kind: "delete", path: "b.md", base: "a".repeat(64) },
    ],
    () => {},
  );
  expect(result.error?.code).toBe("stale");
  expect(create).not.toHaveBeenCalled();
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("A");
});
it("rechecks all originals after the last batch backup before publishing anything", async () => {
  const a = await seed("a.md", "A");
  const b = await seed("b.md", "B");
  const { midNoteMutation } = await import("./mcp-notes.ts");
  midNoteMutation.backupDurable = async (path) => {
    if (path === "b.md") await writeFile(join(root, "b.md"), "newer B");
  };
  const result = await applyBatch(
    vault,
    [
      { kind: "append", path: "a.md", base: a, text: " changed" },
      { kind: "append", path: "b.md", base: b, text: " changed" },
    ],
    () => {},
  );
  expect(result.error?.code).toBe("stale");
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("A");
  expect(await readFile(join(root, "b.md"), "utf8")).toBe("newer B");
});
it("retains honest per-file outcomes and all before-images after partial publication", async () => {
  const bases = await Promise.all([seed("a.md", "A"), seed("b.md", "B"), seed("c.md", "C")]);
  const { midNoteMutation } = await import("./mcp-notes.ts");
  midNoteMutation.durable = async (path) => {
    if (path === "a.md") await writeFile(join(root, "b.md"), "newer B");
  };
  const result = await applyBatch(
    vault,
    ["a", "b", "c"].map((name, index) => ({
      kind: "append",
      path: `${name}.md`,
      base: bases[index]!,
      text: " changed",
    })),
    () => {},
  );
  expect(result.complete).toBe(false);
  expect(result.results).toHaveLength(3);
  expect(result.results[0]).toMatchObject({ applied: true, durable: true });
  expect(result.results[1]).toMatchObject({ applied: false, error: { code: "stale" } });
  expect(result.results[2]).toMatchObject({ applied: false });
  for (let i = 0; i < 3; i++)
    expect(await readFile(join(root, result.results[i]!.beforeImage!), "utf8")).toBe(
      ["A", "B", "C"][i],
    );
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("A changed");
  expect(await readFile(join(root, "b.md"), "utf8")).toBe("newer B");
  expect(await readFile(join(root, "c.md"), "utf8")).toBe("C");
});

it("rechecks a no-op base while the rest of its batch is being preserved", async () => {
  const a = await seed("a.md", "A");
  const b = await seed("b.md", "#present");
  const { midNoteMutation } = await import("./mcp-notes.ts");
  midNoteMutation.backupDurable = async () => {
    await writeFile(join(root, "b.md"), "tag removed");
  };
  const result = await applyBatch(
    vault,
    [
      { kind: "append", path: "a.md", base: a, text: " changed" },
      { kind: "spans", path: "b.md", base: b, edits: [] },
    ],
    () => {},
  );
  expect(result.error?.code).toBe("stale");
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("A");
  expect(await readFile(join(root, "b.md"), "utf8")).toBe("tag removed");
});
