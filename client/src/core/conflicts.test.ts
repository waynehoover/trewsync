import { describe, expect, it } from "vitest";
import { MemoryVault } from "./vault.ts";
import { conflictOriginal, reviewConflict, resolveConflict } from "./conflicts.ts";

const pair = { original: "Note.md", copy: "Note (Conflicted copy phone 202609101200).md" };
async function fixture() {
  const vault = new MemoryVault();
  await vault.edit(pair.original, "original\n");
  await vault.edit(pair.copy, "copy\n");
  return { vault, review: await reviewConflict(vault, pair) };
}

describe("reviewed conflicts", () => {
  it("discovers numbered copies without confusing restored versions", () => {
    expect(conflictOriginal("n (Conflicted copy phone 202609101200) 2.md")).toBe("n.md");
    expect(conflictOriginal("n (restored 42).md")).toBeUndefined();
    expect(conflictOriginal("README (Conflicted copy phone.v2 202609101200)")).toBe("README");
  });
  it("reads a copy named after any author, and nothing new as one", () => {
    // Copies are named after whoever wrote their bytes: an agent's label with
    // spaces, one a sanitiser shortened, one with brackets of its own.
    expect(conflictOriginal("n (Conflicted copy Claude on Mac 202609230941).md")).toBe("n.md");
    expect(conflictOriginal("a/n (Conflicted copy Claude-Mac- work 202609230941) 2.md")).toBe(
      "a/n.md",
    );
    expect(conflictOriginal("n (Conflicted copy Claude (work) 202609230941).md")).toBe("n.md");
    // The shape is what it was: no author, a short stamp or a slash is not one.
    expect(conflictOriginal("n (Conflicted copy  202609230941).md")).toBeUndefined();
    expect(conflictOriginal("n (Conflicted copy Mac 2026092309).md")).toBeUndefined();
    expect(conflictOriginal("n (Conflicted copy a/b 202609230941).md")).toBeUndefined();
  });
  it.each(["original", "copy", "edited"] as const)(
    "keeps the chosen %s version",
    async (choice) => {
      const { vault, review } = await fixture();
      await resolveConflict(vault, "laptop", review, choice, "combined\n");
      expect(vault.text(pair.original)).toBe(choice === "edited" ? "combined\n" : `${choice}\n`);
      expect(await vault.exists(pair.copy)).toBe(false);
    },
  );
  it.each([pair.original, pair.copy])(
    "refuses a changed %s before touching either file",
    async (path) => {
      const { vault, review } = await fixture();
      await vault.edit(path, "new edit\n");
      const before = vault.snapshot();
      await expect(resolveConflict(vault, "laptop", review, "copy")).rejects.toThrow(/changed/);
      expect(vault.snapshot()).toEqual(before);
    },
  );
  it("preserves an edit inside the replacement window and retains the reviewed copy", async () => {
    const { vault, review } = await fixture();
    vault.midReplace = async (path) => {
      vault.midReplace = undefined;
      await vault.edit(path, "concurrent edit\n");
    };
    await expect(resolveConflict(vault, "laptop", review, "copy")).rejects.toThrow(/Both versions/);
    expect(Object.values(vault.snapshot())).toContain("concurrent edit\n");
    expect(vault.text(pair.copy)).toBe("copy\n");
    // The edit was typed here, so its copy carries this device's name.
    const kept = vault.paths().filter((p) => vault.text(p) === "concurrent edit\n");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^Note \(Conflicted copy laptop \d{12}\)\.md$/);
  });
  it("preserves a copy edited in the deletion window", async () => {
    const { vault, review } = await fixture();
    vault.midReplace = async (path) => {
      vault.midReplace = undefined;
      await vault.edit(path, "last-second edit\n");
    };
    await expect(resolveConflict(vault, "laptop", review, "original")).rejects.toThrow(/preserved/);
    expect(Object.values(vault.snapshot())).toContain("last-second edit\n");
    expect(vault.text(pair.original)).toBe("original\n");
    const kept = vault.paths().filter((p) => vault.text(p) === "last-second edit\n");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(
      /^Note \(Conflicted copy phone 202609101200\) \(Conflicted copy laptop \d{12}\)\.md$/,
    );
  });
});
