import { describe, expect, it } from "vitest";

import { bytesForPeople, coveredBy, linkpathOf, neededBy, resolveServerOnly } from "./on-demand.ts";

describe("which server-only file a note's link means", () => {
  const paths = [
    "Projects/plan.pdf",
    "attachments/photo.png",
    "Archive/attachments/photo.png",
    "a/b/c.png",
  ];
  it("matches the path as written, relative to the note, then the shortest ending in it", () => {
    expect(resolveServerOnly("Projects/plan.pdf", "x.md", paths)).toBe("Projects/plan.pdf");
    expect(resolveServerOnly("../b/c.png", "a/d/note.md", paths)).toBe("a/b/c.png");
    expect(resolveServerOnly("photo.png", "anywhere.md", paths)).toBe("attachments/photo.png");
    expect(resolveServerOnly("plan.pdf#page=3", "x.md", paths)).toBe("Projects/plan.pdf");
    expect(resolveServerOnly("plan.pdf|the plan", "x.md", paths)).toBe("Projects/plan.pdf");
    expect(resolveServerOnly("nothing.png", "x.md", paths)).toBeUndefined();
    expect(resolveServerOnly("../../c.png", "a/note.md", paths)).toBeUndefined();
  });

  it("strips what is not the name", () => {
    expect(linkpathOf("my%20file.png#x|alias")).toBe("my file.png");
  });
});

describe("what opening a note fetches", () => {
  it("is each embed and link it makes to a file the server holds and this device does not", () => {
    const serverOnly = new Map([
      ["att/a.png", 5],
      ["att/b.pdf", 5],
    ]);
    const cache = {
      embeds: [{ link: "a.png" }, { link: "here.png" }],
      links: [{ link: "b.pdf#page=2" }, { link: "a.png" }, { link: "Another note" }],
    };
    expect(neededBy("n.md", cache, serverOnly, (l) => l === "here.png").sort()).toEqual([
      "att/a.png",
      "att/b.pdf",
    ]);
    expect(neededBy("n.md", null, serverOnly, () => false)).toEqual([]);
  });
});

describe("what the setting covers", () => {
  it("is files at the threshold or over, never text, never a setting", () => {
    expect(coveredBy(1_000, "a.png", 1_000)).toBe(true);
    expect(coveredBy(1_000, "a.png", 999)).toBe(false);
    expect(coveredBy(0, "a.png", 0)).toBe(true);
    expect(coveredBy(0, "note.md", 5_000_000)).toBe(false);
    expect(coveredBy(0, "board.canvas", 5_000_000)).toBe(false);
    expect(coveredBy(0, ".obsidian/plugins/x/data.json", 5_000_000)).toBe(false);
    expect(coveredBy(undefined, "a.png", 5_000_000)).toBe(false);
    expect(bytesForPeople(1_800_000_000)).toBe("1.8 GB");
  });
});
