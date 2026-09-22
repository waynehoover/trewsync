import { afterEach, expect, it, vi } from "vitest";
import { ActivityLog, ActivityModal } from "./activity.ts";
import { App, built, FakeEl, resetStub } from "./stub.ts";
import { FakeAdapter } from "./fake.ts";
import { nextTurn } from "../core/test-async.ts";
const opened: ActivityModal[] = [];
afterEach(() => {
  for (const modal of opened.splice(0)) modal.close();
  vi.unstubAllGlobals();
  resetStub();
});
const visible = (modal: ActivityModal) =>
  built.filter((row) => (modal.contentEl as unknown as FakeEl).contains(row.settingEl));
it("adds live activity without rebuilding search controls or the previously visible row", async () => {
  const log = new ActivityLog(new FakeAdapter(), "activity.json");
  log.add({ at: 1, action: "downloaded", path: "Before.md" });
  const modal = new ActivityModal(new App() as never, log, () => {});
  opened.push(modal);
  modal.open();
  const prior = visible(modal).find((row) => row.name === "Before.md")!;
  const search = visible(modal).find((row) => row.name === "Recent activity")!.texts[0]!;
  search.type(".md");
  log.add({ at: 2000, action: "uploaded", path: "After.md" });
  await nextTurn();
  expect(visible(modal).map((row) => row.name)).toContain("After.md");
  expect(visible(modal).find((row) => row.name === "Before.md")).toBe(prior);
  expect(visible(modal).find((row) => row.name === "Recent activity")!.texts[0]).toBe(search);
  expect(search.getValue()).toBe(".md");
  modal.close();
  log.add({ at: 3000, action: "error" });
  await nextTurn();
  expect((modal.contentEl as unknown as FakeEl).allText()).toBe("");
});

it("coalesces an event burst into one frame, keeps the log bounded, and cancels after close", () => {
  let frame: FrameRequestCallback | undefined;
  const request = vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const log = new ActivityLog(new FakeAdapter(), "activity.json");
  const modal = new ActivityModal(new App() as never, log, () => {});
  opened.push(modal);
  modal.open();
  for (let i = 0; i < 350; i++) log.add({ at: i, action: "uploaded", path: `Note${i}.md` });
  expect(request).toHaveBeenCalledTimes(1);
  expect(log.events).toHaveLength(300);
  frame!(0);
  expect(visible(modal).filter((row) => row.name.endsWith(".md"))).toHaveLength(300);
  log.add({ at: 400, action: "error" });
  modal.close();
  expect(cancel).toHaveBeenCalledTimes(1);
  frame!(0);
  expect((modal.contentEl as unknown as FakeEl).allText()).toBe("");
});
it("defers hidden activity rendering until visible and removes its listener when closed", async () => {
  const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  vi.stubGlobal("document", doc);
  const log = new ActivityLog(new FakeAdapter(), "activity.json");
  const modal = new ActivityModal(new App() as never, log, () => {});
  opened.push(modal);
  modal.open();
  log.add({ at: 1, action: "uploaded", path: "Later.md" });
  await nextTurn();
  expect(visible(modal).map((row) => row.name)).not.toContain("Later.md");
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await nextTurn();
  expect(visible(modal).map((row) => row.name)).toContain("Later.md");
  modal.close();
  expect((log as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
});
