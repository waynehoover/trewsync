import { describe, expect, it } from "vitest";

import { bytesForPeople, coveredBy, linkpathOf, neededBy, resolveLink } from "./on-demand.ts";

describe("which file a note's link means, as Obsidian 1.14 resolves it", () => {
  const paths = [
    "Projects/plan.pdf",
    "attachments/photo.png",
    "Archive/attachments/photo.png",
    "a/b/c.png",
  ];
  it("matches the path as written, relative to the note, then the shortest ending in it", () => {
    expect(resolveLink("Projects/plan.pdf", "x.md", paths)).toBe("Projects/plan.pdf");
    expect(resolveLink("../b/c.png", "a/d/note.md", paths)).toBe("a/b/c.png");
    expect(resolveLink("photo.png", "anywhere.md", paths)).toBe("attachments/photo.png");
    expect(resolveLink("plan.pdf#page=3", "x.md", paths)).toBe("Projects/plan.pdf");
    expect(resolveLink("plan.pdf|the plan", "x.md", paths)).toBe("Projects/plan.pdf");
    expect(resolveLink("nothing.png", "x.md", paths)).toBeUndefined();
    // Climbing out of the vault falls through to the name, as in Obsidian.
    expect(resolveLink("../../c.png", "a/note.md", paths)).toBe("a/b/c.png");
  });

  it("prefers the one under the note's folder, ignores case, and reads ./", () => {
    const files = ["att/photo.png", "Projects/assets/photo.png", "photo2.png"];
    expect(resolveLink("photo.png", "Projects/n.md", files)).toBe("Projects/assets/photo.png");
    expect(resolveLink("photo.png", "Other/n.md", files)).toBe("att/photo.png");
    expect(resolveLink("PHOTO.PNG", "Projects/n.md", files)).toBe("Projects/assets/photo.png");
    expect(resolveLink("./photo2.png", "n.md", files)).toBe("photo2.png");
    expect(resolveLink("/att/photo.png", "Projects/n.md", files)).toBe("att/photo.png");
    expect(resolveLink("/photo.png", "Projects/n.md", files)).toBeUndefined();
    expect(resolveLink("Some note", "n.md", ["Some note.md"])).toBe("Some note.md");
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
    expect(neededBy("n.md", cache, serverOnly, ["here.png", "Another note.md"]).sort()).toEqual([
      "att/a.png",
      "att/b.pdf",
    ]);
    expect(neededBy("n.md", null, serverOnly, [])).toEqual([]);
  });

  it("is the one the link means, even when another file of that name is here", () => {
    const serverOnly = new Map([["Projects/assets/photo.png", 5]]);
    const cache = { embeds: [{ link: "photo.png" }] };
    expect(neededBy("Projects/n.md", cache, serverOnly, ["att/photo.png"])).toEqual([
      "Projects/assets/photo.png",
    ]);
    // A note Obsidian made of the name on a tap does not stand in for it.
    const made = new Map([["big.png", 5]]);
    expect(neededBy("n.md", { embeds: [{ link: "big.png" }] }, made, ["big.png.md"])).toEqual([
      "big.png",
    ]);
    // Nor does a file here that the link means, which is left alone.
    expect(neededBy("Other/n.md", cache, serverOnly, ["att/photo.png"])).toEqual([]);
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
