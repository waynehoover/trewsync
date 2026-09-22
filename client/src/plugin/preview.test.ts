/**
 * What the first-sync review says, and does not say.
 *
 * This modal is the one moment somebody is asked to approve what is about to
 * happen to their notes, so what it shows has to be worth reading. It is also
 * the surface that pauses sync when it is dismissed, which makes an
 * uninformative one actively costly.
 */

import { describe, expect, it } from "vitest";

import { App, built } from "./stub.ts";
import { SyncPreviewModal } from "./preview.ts";
import type { SyncPreview } from "../core/preview.ts";

const preview = (files: SyncPreview["files"]): SyncPreview => ({ cursor: 1, files });

function shown(p: SyncPreview): { text: string; summaries: string[] } {
  const modal = new SyncPreviewModal(new App() as never, p, "Review your first sync");
  modal.onOpen();
  const el = modal.contentEl as unknown as {
    allText(): string;
    children: { tag: string; children: { tag: string; text: string }[] }[];
  };
  const summaries: string[] = [];
  const walk = (node: { tag: string; text?: string; children?: unknown[] }): void => {
    if (node.tag === "summary" && node.text) summaries.push(node.text);
    for (const child of (node.children ?? []) as { tag: string; text?: string }[]) walk(child);
  };
  walk(el as unknown as { tag: string; children: unknown[] });
  return { text: el.allText(), summaries };
}

describe("a first sync with nothing to do", () => {
  it("says so, instead of offering a chevron with nothing behind it", () => {
    // Pairing a device to a vault it already holds a copy of. Every file
    // matches, so the details list is empty; it used to be drawn anyway, and
    // opening it showed an empty box. Reported from a phone doing exactly
    // this against a 500-note vault.
    const { text, summaries } = shown(
      preview([
        { path: "a.md", action: "unchanged" },
        { path: "b.md", action: "unchanged" },
      ]),
    );
    expect(summaries, "a disclosure was offered with nothing in it").toEqual([]);
    expect(text).toContain("every file here already matches the server");
  });

  it("tells an empty vault apart from a matching one", () => {
    // Different situations and different things to be reassured about: one is
    // "you have nothing yet", the other is "you already have all of it".
    expect(shown(preview([])).text).toContain("nothing here and nothing on the server");
  });
});

describe("a first sync with work in it", () => {
  it("still lists the files, and says how many", () => {
    built.length = 0;
    const { summaries } = shown(
      preview([
        { path: "a.md", action: "download" },
        { path: "b.md", action: "unchanged" },
        { path: "c.md", action: "upload" },
      ]),
    );
    expect(summaries).toEqual(["File details (2)"]);
    // The rows themselves, from what the modal built: a Setting keeps its
    // name outside the element text the stub concatenates.
    const rows = built.map((row) => row.name);
    expect(rows).toContain("a.md");
    expect(rows).toContain("c.md");
    // The matching one is counted above, not listed as a change.
    expect(rows).not.toContain("b.md");
  });
});
