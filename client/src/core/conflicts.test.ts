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
  it.each(["original", "copy", "edited"] as const)(
    "keeps the chosen %s version",
    async (choice) => {
      const { vault, review } = await fixture();
      await resolveConflict(vault, review, choice, "combined\n");
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
      await expect(resolveConflict(vault, review, "copy")).rejects.toThrow(/changed/);
      expect(vault.snapshot()).toEqual(before);
    },
  );
  it("preserves an edit inside the replacement window and retains the reviewed copy", async () => {
    const { vault, review } = await fixture();
    vault.midReplace = async (path) => {
      vault.midReplace = undefined;
      await vault.edit(path, "concurrent edit\n");
    };
    await expect(resolveConflict(vault, review, "copy")).rejects.toThrow(/Both versions/);
    expect(Object.values(vault.snapshot())).toContain("concurrent edit\n");
    expect(vault.text(pair.copy)).toBe("copy\n");
  });
  it("preserves a copy edited in the deletion window", async () => {
    const { vault, review } = await fixture();
    vault.midReplace = async (path) => {
      vault.midReplace = undefined;
      await vault.edit(path, "last-second edit\n");
    };
    await expect(resolveConflict(vault, review, "original")).rejects.toThrow(/preserved/);
    expect(Object.values(vault.snapshot())).toContain("last-second edit\n");
    expect(vault.text(pair.original)).toBe("original\n");
  });
});
