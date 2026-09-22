import { expect, it, vi } from "vitest";
import { App, FakeEl, built } from "./stub.ts";
import { ConflictsModal } from "./conflicts.ts";
import { deferred, nextTurn } from "../core/test-async.ts";
import { MemoryVault } from "../core/vault.ts";
import { reviewConflict, resolveConflict } from "../core/conflicts.ts";

it("keeps combined text when resolution fails and when the comparison refreshes", async () => {
  built.length = 0;
  const pair = { original: "Note.md", copy: "Note (Conflicted copy phone 202609101200).md" };
  const file = (path: string, text: string) => ({
    path,
    text,
    digest: text,
    stat: { path, mtime: 1, ctime: 1, size: text.length, folder: false },
  });
  const pending = deferred<void>();
  const source = {
    pairs: () => [pair],
    open: () => {},
    review: async () => ({
      ...pair,
      current: file(pair.original, "original"),
      preserved: file(pair.copy, "copy"),
    }),
    resolve: vi.fn(() => pending.promise),
  };
  const modal = new ConflictsModal(new App() as never, source);
  modal.open();
  await (modal as unknown as { choose(input: typeof pair): Promise<void> }).choose(pair);
  const content = modal.contentEl as unknown as FakeEl;
  const editor = content.querySelector("textarea")!;
  editor.value = "my combined text";
  editor.fire("input");
  const save = built
    .flatMap((row) => row.buttons)
    .find((button) => button.label === "Save combined version")!;
  await save.click();
  expect(editor.disabled).toBe(true);
  pending.reject(new Error("One file changed. Refresh the comparison."));
  await nextTurn();
  expect(source.resolve).toHaveBeenCalledWith(expect.anything(), "edited", "my combined text");
  expect(editor.disabled).toBe(false);
  expect(content.querySelector("textarea")!.value).toBe("my combined text");
  await built
    .flatMap((row) => row.buttons)
    .find((button) => button.label === "Refresh")!
    .click();
  await nextTurn();
  expect(content.querySelector("textarea")!.value).toBe("my combined text");
  modal.close();
});

it("locks the combined editor until the submitted version has been saved", async () => {
  built.length = 0;
  const pair = { original: "Note.md", copy: "Note (Conflicted copy phone 202609101200).md" };
  const vault = new MemoryVault();
  await vault.edit(pair.original, "original");
  await vault.edit(pair.copy, "copy");
  const pending = deferred<void>();
  const written = deferred<void>();
  const modal = new ConflictsModal(new App() as never, {
    pairs: () => (vault.text(pair.copy) === undefined ? [] : [pair]),
    open: () => {},
    review: () => reviewConflict(vault, pair),
    resolve: async (review, choice, edited) => {
      await pending.promise;
      await resolveConflict(vault, review, choice, edited);
      written.resolve();
    },
  });
  modal.open();
  await (modal as unknown as { choose(input: typeof pair): Promise<void> }).choose(pair);
  const content = modal.contentEl as unknown as FakeEl;
  const editor = content.querySelector("textarea")!;
  editor.value = "my complete combined note\n";
  editor.fire("input");
  await built
    .flatMap((row) => row.buttons)
    .find((button) => button.label === "Save combined version")!
    .click();
  expect(editor.disabled).toBe(true);
  expect(vault.text(pair.original)).toBe("original");
  pending.resolve();
  await written.promise;
  await nextTurn();
  expect(vault.text(pair.original)).toBe("my complete combined note\n");
  expect(vault.text(pair.copy)).toBeUndefined();
  expect(content.querySelector("textarea")).toBeUndefined();
  modal.close();
});

it.each([false, true])(
  "marks an incomplete comparison only when it is shortened: %s",
  async (large) => {
    built.length = 0;
    const pair = { original: "Note.md", copy: "Note (Conflicted copy phone 202609101200).md" };
    const vault = new MemoryVault();
    await vault.edit(pair.original, "old line\n".repeat(large ? 12000 : 1) + "OLD DECISION\n");
    await vault.edit(
      pair.copy,
      "new line\n".repeat(large ? 12000 : 1) + "NEW IMPORTANT DECISION\n",
    );
    const modal = new ConflictsModal(new App() as never, {
      pairs: () => [pair],
      open: () => {},
      review: () => reviewConflict(vault, pair),
      resolve: async () => {},
    });
    modal.open();
    await (modal as unknown as { choose(input: typeof pair): Promise<void> }).choose(pair);
    const content = modal.contentEl as unknown as FakeEl;
    const preview = content.querySelector("pre")!;
    const instructions = content
      .querySelectorAll("p")
      .map((node) => node.text)
      .join("\n");
    if (large) {
      expect(preview.text.length).toBe(128 * 1024);
      expect(preview.text).not.toContain("NEW IMPORTANT DECISION");
      expect(instructions).toContain("Comparison shortened.");
      expect(instructions).toContain("Open both files to review all changes");
    } else {
      expect(preview.text).toContain("NEW IMPORTANT DECISION");
      expect(instructions).not.toContain("Comparison shortened.");
    }
    modal.close();
  },
);
