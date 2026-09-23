import { describe, expect, it } from "vitest";
import { ActivityLog } from "./activity.ts";
import { FakeAdapter } from "./fake.ts";

const path = ".obsidian/plugins/trew/activity.json";
describe("local activity log", () => {
  it("retains a bounded log after restart and exports no filenames", async () => {
    const adapter = new FakeAdapter();
    const log = new ActivityLog(adapter, path);
    for (let i = 0; i < 350; i++) log.add({ at: i, action: "uploaded", path: `Private/${i}.md` });
    await log.flush();
    const again = new ActivityLog(adapter, path);
    await again.load();
    expect(again.events).toHaveLength(300);
    expect(again.events[0]?.at).toBe(50);
    expect(again.diagnostics()).not.toContain("Private");
    expect(again.diagnostics()).not.toContain("path");
  });
  it("reports corrupt logs and leaves them untouched until cleared", async () => {
    const adapter = new FakeAdapter();
    adapter.seed(path, "broken JSON");
    const log = new ActivityLog(adapter, path);
    await log.load();
    expect(log.problem).toMatch(/could not be read/);
    log.add({ at: 1, action: "error" });
    await log.flush();
    expect(adapter.text(path)).toBe("broken JSON");
    await log.clear();
    expect(log.problem).toBeUndefined();
    expect(adapter.text(path)).toBe("[]");
  });
  it("discards unknown fields from persisted entries", async () => {
    const adapter = new FakeAdapter();
    adapter.seed(path, JSON.stringify([{ at: 1, action: "error", secret: "never display this" }]));
    const log = new ActivityLog(adapter, path);
    await log.load();
    expect(log.events).toEqual([{ at: 1, action: "error" }]);
  });
});
