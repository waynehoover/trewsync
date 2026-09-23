import { describe, expect, it } from "vitest";
import { FakeAdapter } from "./fake.ts";
import { checkFirstSync } from "./first-sync.ts";

describe("first-sync file check", () => {
  it("allows an empty notes vault with configuration, trash and empty folders", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("Settings/plugins/trew/data.json", "credentials");
    adapter.seed(".trash/old.md", "deleted note");
    adapter.seed(".obsidian/workspace.json", "{}");
    adapter.seed(".git/config", "git settings");
    await adapter.mkdir("Attachments");
    await expect(checkFirstSync(adapter, "Settings")).resolves.toBeUndefined();
    expect(adapter.text("Settings/plugins/trew/data.json")).toBe("credentials");
  });

  it.each(["Notes/deep/note.md", "Attachments/report.pdf", "README"])(
    "requires confirmation for the existing file %s without modifying it",
    async (path) => {
      const adapter = new FakeAdapter();
      adapter.seed(path, "existing contents");
      await expect(checkFirstSync(adapter, ".obsidian")).rejects.toThrow(/Confirm merging/);
      expect(adapter.text(path)).toBe("existing contents");
      await expect(checkFirstSync(adapter, ".obsidian", true)).resolves.toBeUndefined();
      expect(adapter.text(path)).toBe("existing contents");
    },
  );
});
