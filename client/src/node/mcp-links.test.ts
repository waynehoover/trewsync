import { expect, it } from "vitest";
import { changeLinks, type LinkChange } from "./mcp-links.ts";
import { applySourceEdits } from "./mcp-notes.ts";
function moved(source: string, input: Partial<LinkChange> = {}) {
  const result = changeLinks(source, {
    path: "Index.md",
    from: "Old.md",
    to: "Folder/New.md",
    inventory: ["Index.md", "Old.md"],
    canonical: (path) => path.normalize("NFC").toLowerCase(),
    ...input,
  });
  return { ...result, source: applySourceEdits(source, result.edits) };
}
it("changes only destination spans, leaving labels, titles, aliases and anchors exact", () => {
  const input =
    '\ufeff[Old.md](Old.md "Old.md")\r\n![[Old#Section|Old]] [[Old.md#^block]]\r\nUNSENT body\r\n';
  expect(moved(input).source).toBe(
    '\ufeff[Old.md](Folder/New.md "Old.md")\r\n![[Folder/New#Section|Old]] [[Folder/New.md#^block]]\r\nUNSENT body\r\n',
  );
});
it("keeps code, comments, frontmatter and escaped wikilinks byte exact", () => {
  const input =
    '---\nproperty: "[[Old]]"\n---\n`[[Old]]`\n```md\n[Old](Old.md)\n```\n<!-- [[Old]] -->\n%% [[Old]] %%\n\\[[Old]] [[Old]]';
  expect(moved(input).source).toBe(input.slice(0, -7) + "[[Folder/New]]");
});
it.each([
  { from: "Old(Note).md", raw: "Old\\(Note\\).md" },
  { from: "Old Note.md", raw: "Old&#32;Note.md" },
  { from: "Old Note.md", raw: "<Old Note.md>" },
  { from: "Old Note.md", raw: "Old%20Note.md" },
])(
  "resolves escaped and encoded Markdown destinations without changing syntax: $raw",
  ({ from, raw }) => {
    const result = moved(`[label [nested]](${raw} 'title')`, { from, inventory: [from] });
    expect(result.source).toBe(
      `[label [nested]](${raw.startsWith("<") ? "<Folder/New.md>" : "Folder/New.md"} 'title')`,
    );
  },
);
it("updates reference definitions and images, preserving reference names and titles", () => {
  expect(moved('[Old][old]\n![Old][old]\n\n[old]: Old.md "Old.md"\n').source).toBe(
    '[Old][old]\n![Old][old]\n\n[old]: Folder/New.md "Old.md"\n',
  );
});
it("reports ambiguous short links instead of choosing a note", () => {
  const result = moved("[[Old]] [[One/Old]]", {
    from: "One/Old.md",
    inventory: ["One/Old.md", "Two/Old.md"],
  });
  expect(result).toMatchObject({ source: "[[Old]] [[Folder/New]]", ambiguous: 1 });
});
it("retargets outgoing relative notes and attachments from the moved location", () => {
  const result = moved("[B](B.md#Heading) ![](images/x.png) [[B]]", {
    path: "Project/A.md",
    from: "Project/A.md",
    to: "Archive/A.md",
    inventory: ["Project/A.md", "Project/B.md", "Project/images/x.png"],
  });
  expect(result.source).toBe(
    "[B](../Project/B.md#Heading) ![](../Project/images/x.png) [[Project/B]]",
  );
});
it("encodes syntax characters in new destinations and preserves fragment-only self links", () => {
  expect(
    moved("[note](Old.md#Heading) [[Old]] [self](#Section)", { to: "New (copy)#name.md" }).source,
  ).toBe("[note](New%20%28copy%29%23name.md#Heading) [[New (copy)%23name]] [self](#Section)");
});
it("can mark a deleted backlink broken using exact destination edits", () => {
  expect(moved("[[Old|label]] [text](Old.md)", { to: undefined }).source).toBe(
    "~~[[Old|label]]~~ ~~[text](Old.md)~~",
  );
});

it.each(["[see `Old`](Old.md)", "[a `[`](Old.md)", "[![Old](Old.md)](Other.md)"])(
  "retains link syntax when a label contains code or an image: %s",
  (source) => {
    expect(moved(source).source).toBe(source.replace("(Old.md)", "(Folder/New.md)"));
  },
);
it.each(["Old&#32;Note.md#A&#32;B", "Old&#32;Note.md&#35;A&#32;B"])(
  "preserves the raw fragment after character references: %s",
  (url) => {
    const result = moved(`[x](${url})`, { from: "Old Note.md", inventory: ["Old Note.md"] });
    expect(result.source).toBe(`[x](Folder/New.md${url.includes("&#35;") ? "&#35;" : "#"}A&#32;B)`);
  },
);

it("keeps the destination extension when dropping it would identify two notes", () => {
  expect(
    moved("[[Old]] [old](Old)", { to: "New.txt", inventory: ["Old.md", "New.md"] }).source,
  ).toBe("[[New.txt]] [old](New.txt)");
});
it("keeps missing relative Markdown targets pointing at their original locations", () => {
  expect(
    moved("[planned](Future.md) ![](images/future.png)", {
      path: "Project/A.md",
      from: "Project/A.md",
      to: "Archive/A.md",
      inventory: ["Project/A.md"],
    }).source,
  ).toBe("[planned](../Project/Future.md) ![](../Project/images/future.png)");
});
