import { beforeEach, describe, expect, it } from "vitest";

import {
  App,
  built,
  modals,
  notices,
  resetStub,
  type ButtonComponent,
  type FakeEl,
} from "./stub.ts";
import { RestoreTimeModal, fromLocalInput, localInputValue, summarise } from "./restore-time.ts";
import { ProtocolError, type RestoreAsk, type RestoreResult } from "../core/transport.ts";
import type { App as ObsidianApp } from "obsidian";

beforeEach(() => {
  resetStub();
  modals.length = 0;
});

/** The buttons in the newest modal now, in the order they were built. */
function buttons(): ButtonComponent[] {
  const inModal = new Set<FakeEl>();
  const visit = (n: FakeEl): void => {
    inModal.add(n);
    for (const c of n.children) visit(c);
  };
  visit(modals.at(-1)!.contentEl);
  return built
    .filter((st) => inModal.has(st.settingEl))
    .flatMap((st) => st.buttons)
    .filter((b) => !b.disabled);
}

const press = async (label: string): Promise<void> => {
  const b = buttons().find((x) => x.label === label);
  if (!b)
    throw new Error(
      `no ${label} button among ${buttons()
        .map((x) => x.label)
        .join(", ")}`,
    );
  await b.click();
};

const plan = (over: Partial<RestoreResult> = {}): RestoreResult => ({
  folder: "Projects",
  toUid: 7,
  at: 1_000,
  head: 12,
  restore: 2,
  remove: 1,
  removeFolder: 0,
  unchanged: 0,
  more: 0,
  steps: [
    { action: "remove", path: "Projects/new.md", after: 11 },
    { action: "restore", path: "Projects/plan.md", before: 5, after: 10 },
    { action: "restore", path: "Projects/gone.md", before: 6, after: 9 },
  ],
  keptMovedIn: [],
  ...over,
});

describe("restoring to an earlier time, in the modal", () => {
  it("previews the time asked, applies exactly that preview, and undoes it", async () => {
    const asked: RestoreAsk[] = [];
    const undone: string[] = [];
    const day = 24 * 60 * 60 * 1000;
    new RestoreTimeModal(
      new App() as unknown as ObsidianApp,
      "Projects",
      {
        restore: async (ask) => {
          asked.push(ask);
          return "at" in ask ? plan() : plan({ opId: "op1", committedAt: 2_000 });
        },
        undo: async (opId) => void undone.push(opId),
      },
      50_000 + day,
    ).open();

    await press("Preview");
    expect(asked).toEqual([{ at: 50_000, folder: "Projects" }]);
    expect(modals.at(-1)!.contentEl.allText()).toContain("2 files put back, 1 made since removed.");
    expect(modals.at(-1)!.contentEl.allText()).toContain("Projects/new.md: removed, made since");

    await press("Restore");
    expect(asked[1]).toEqual({ uid: 7, head: 12, folder: "Projects" });
    expect(notices.at(-1)?.message).toContain("restored");

    await press("Undo");
    expect(undone).toEqual(["op1"]);
    expect(buttons().map((b) => b.label)).toEqual(["Preview"]);
  });

  it("says to preview again when the vault moved since the preview", async () => {
    new RestoreTimeModal(new App() as unknown as ObsidianApp, "", {
      restore: async (ask) => {
        if ("at" in ask) return plan({ folder: "" });
        throw new ProtocolError("stale", "plan_changed: previewed at uid 12");
      },
      undo: async () => {},
    }).open();
    await press("Preview");
    await press("Restore");
    expect(modals.at(-1)!.contentEl.allText()).toContain(
      "changed since the preview. Preview again.",
    );
    expect(buttons().map((b) => b.label)).toEqual(["Preview"]);
  });

  it("offers nothing to apply when nothing would change", async () => {
    new RestoreTimeModal(new App() as unknown as ObsidianApp, "", {
      restore: async () => plan({ restore: 0, remove: 0, steps: [] }),
      undo: async () => {},
    }).open();
    await press("Preview");
    expect(buttons()).toEqual([]);
    expect(summarise(plan({ restore: 0, remove: 0 }))).toMatch(/^Nothing to change/);
  });

  it("reads and writes the time input in local time", () => {
    const ms = new Date(2026, 9, 20, 15, 7).getTime();
    expect(localInputValue(ms)).toBe("2026-10-20T15:07");
    expect(fromLocalInput("2026-10-20T15:07")).toBe(ms);
    expect(fromLocalInput("")).toBe("Choose a date and a time.");
    expect(fromLocalInput("Tuesday")).toBe("Choose a date and a time.");
  });
});

describe("a preview that answers an earlier question", () => {
  /**
   * The folder changed while the preview was being asked for. Shown, its
   * Restore would apply the old folder's uid and head under the new inputs.
   * Found by review, 2026-10-23.
   */
  it("is dropped, and Restore is not offered for it", async () => {
    let answer: (r: RestoreResult) => void = () => {};
    new RestoreTimeModal(new App() as unknown as ObsidianApp, "Projects", {
      restore: () => new Promise((r) => (answer = r)),
      undo: async () => {},
    }).open();
    const asking = press("Preview");
    const folder = built.find((st) => st.name === "Folder")!.texts[0]!;
    folder.type("Archive");
    answer(plan());
    await asking;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(buttons().map((b) => b.label)).toEqual(["Preview"]);
  });
});
