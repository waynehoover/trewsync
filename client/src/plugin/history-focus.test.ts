import { afterEach, expect, it } from "vitest";
import { deferred, nextTurn } from "../core/test-async.ts";
import type { Version } from "../core/client.ts";
import { HistoryModal, type HistorySource } from "./history.ts";
import { App, FakeEl, resetStub } from "./stub.ts";
const opened: HistoryModal[] = [];
afterEach(() => {
  for (const modal of opened.splice(0)) modal.close();
  resetStub();
});
const version = (uid: number): Version => ({
  uid,
  path: "Note.md",
  size: 4,
  ctime: 1,
  mtime: uid,
  folder: false,
  deleted: false,
  device: "Laptop",
  chunks: 1,
  contentId: `content-${uid}`,
});
async function fixture() {
  const page = deferred<Version[]>();
  let first = true;
  const source: HistorySource = {
    history: async () => {
      if (first) {
        first = false;
        return Array.from({ length: 20 }, (_, i) => version(40 - i));
      }
      return page.promise;
    },
    contentAt: async () => "note",
    currentText: async () => "note",
    restoreVersion: async () => ({ path: "copy.md", sent: true }),
  };
  const modal = new HistoryModal(new App() as never, source, "Note.md");
  opened.push(modal);
  modal.open();
  await nextTurn();
  const more = (modal.contentEl as unknown as FakeEl).querySelector(".telimus-history-button")!;
  more.focus();
  more.fire("click");
  const loading = (modal as unknown as { paging: Promise<void> }).paging;
  return { modal, page, more, loading };
}
it("retains the loading control's focus and moves to the first new history version", async () => {
  const { page, more, loading } = await fixture();
  expect(FakeEl.activeElement).toBe(more);
  page.resolve([version(20), version(19)]);
  await loading;
  expect(FakeEl.activeElement?.getAttribute("data-version")).toBe("20");
});
it("does not steal focus if the reader moves elsewhere during pagination", async () => {
  const { page, loading } = await fixture();
  const other = new FakeEl("button");
  other.focus();
  page.resolve([version(20)]);
  await loading;
  expect(FakeEl.activeElement).toBe(other);
});
it("keeps retry focused after a page request fails", async () => {
  const { page, loading } = await fixture();
  page.reject(new Error("offline"));
  await loading;
  expect(FakeEl.activeElement?.text).toBe("Try again");
});
it("returns focus to an existing version when the final history page is empty", async () => {
  const { page, loading } = await fixture();
  page.resolve([]);
  await loading;
  expect(FakeEl.activeElement?.getAttribute("data-version")).toBe("21");
});
