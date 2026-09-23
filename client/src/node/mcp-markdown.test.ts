import { expect, it } from "vitest";
import { applySourceEdits, changeTags, tagOccurrences, tagPattern } from "./mcp-markdown.ts";

const update = (source: string, input: Parameters<typeof changeTags>[1]) =>
  applySourceEdits(source, changeTags(source, input).edits);

it("edits only the tags value and retains unrelated YAML, BOM, CRLF, body and comments", () => {
  const before =
    '\ufeff---\r\ntitle:  "Keep these spaces" # title comment\r\ntags: [old, Keep] # tag comment\r\nother: &value {x: 1}\r\ncopy: *value\r\n---\r\nUNSENT café 😀\r\n';
  expect(update(before, { operation: "add", tags: ["new"] })).toBe(
    before.replace("[old, Keep]", '["old","Keep","new"]'),
  );
  expect(update(before, { operation: "remove", tags: ["OLD"] })).toBe(
    before.replace("[old, Keep]", '["Keep"]'),
  );
});
it("retains comments within a block tags list when removing a tag", () => {
  const before =
    "---\ntitle:  unchanged\ntags:\n  - old # first\n  # middle\n  - keep\nnext: unchanged\n---\nUNSENT\n";
  const after = update(before, { operation: "remove", tags: ["old"] });
  expect(after).toBe(
    '---\ntitle:  unchanged\ntags:\n  ["keep"]\n  # first\n  # middle\nnext: unchanged\n---\nUNSENT\n',
  );
  expect(tagOccurrences(after).map((x) => x.tag)).toEqual(["keep"]);
});
it.each([
  ["\ufeffBody\r\n", '\ufeff---\r\ntags: ["new"]\r\n---\r\nBody\r\n'],
  ["---\ntitle: raw\n---", '---\ntitle: raw\ntags: ["new"]\n---'],
  ["---\ntags:\n# keep\n---\nbody", '---\ntags: ["new"]\n# keep\n---\nbody'],
])("adds frontmatter tags without rewriting the rest: %s", (before, after) => {
  expect(update(before, { operation: "add", tags: ["new"] })).toBe(after);
});
it("does not touch code, comments, link destinations, escapes or numeric hashtags", () => {
  const source =
    "#keep #工作/当前 #😀\n`#ignore` ``#ignore ` nested``\n\\#ignore 123#ignore #123\n<!-- #ignore\n#ignore -->\n%% #ignore %%\n[[note#ignore]] [note](note#ignore)\n````\n```\n#ignore\n````\n~~~\n#ignore\n~~~\n    #ignore\n";
  expect(tagOccurrences(source).map((item) => item.tag)).toEqual(["keep", "工作/当前", "😀"]);
  expect(update(source, { operation: "remove", patterns: ["*"] })).toBe(
    source.replace("#keep #工作/当前 #😀", "  "),
  );
});
it.each([
  "[link](https://example.test/a(b)#old)\nUNSENT\n",
  "[link]: https://example.test/a(b)#old\nUNSENT\n",
  "<https://example.test/a(b)#old>\nUNSENT\n",
])("never removes a URL fragment while changing tags: %s", (source) => {
  expect(tagOccurrences(source)).toEqual([]);
  expect(update(source, { operation: "remove", tags: ["old"] })).toBe(source);
});
it.each(["`%%`\n#old\n", "```\n%%\n```\n#old\n"])(
  "does not start a comment from code: %s",
  (source) => {
    expect(tagOccurrences(source).map((item) => item.tag)).toEqual(["old"]);
    expect(update(source, { operation: "rename", oldTag: "old", newTag: "new" })).toBe(
      source.replace("#old", "#new"),
    );
  },
);
it("matches nested tags by segment and preserves unselected descendants", () => {
  const source = "#old #OLD/child #older #keep\n";
  expect(update(source, { operation: "remove", tags: ["old"] })).toBe(" #OLD/child #older #keep\n");
  expect(update(source, { operation: "remove", tags: ["old"], includeChildren: true })).toBe(
    "  #older #keep\n",
  );
  expect(
    update(source, { operation: "rename", oldTag: "old", newTag: "new", includeChildren: true }),
  ).toBe("#new #new/child #older #keep\n");
});
it("matches Unicode-normalized parents without leaving a combining mark in a renamed child", () => {
  expect(
    update("#cafe\u0301/child\n", {
      operation: "rename",
      oldTag: "café",
      newTag: "new",
      includeChildren: true,
    }),
  ).toBe("#new/child\n");
});
it("uses bounded wildcard selection without treating regex syntax as a glob", () => {
  expect(tagPattern("proj*/done", "Project/done")).toBe(true);
  expect(tagPattern("project/*", "project/a/b")).toBe(true);
  expect(tagPattern("project/*", "other/a")).toBe(false);
  expect(() => tagPattern("(a+)+$", "a")).toThrow();
  expect(() => tagPattern("**", "a")).toThrow();
});
it("preserves the body byte-for-byte when adding inline tags at either end", () => {
  const source = "\ufeff---\r\ntitle: unchanged\r\n---\r\nUNSENT";
  expect(
    update(source, {
      operation: "add",
      tags: ["New_Tag"],
      location: "content",
      position: "start",
      normalization: "kebab",
    }),
  ).toBe(source.replace("UNSENT", "#new-tag\r\nUNSENT"));
  expect(update(source, { operation: "add", tags: ["new"], location: "content" })).toBe(
    source + "\r\n#new\r\n",
  );
});
it("refuses an inline addition hidden inside an unterminated fenced block", () => {
  expect(() =>
    update("body\n```\ncode\n", { operation: "add", tags: ["new"], location: "content" }),
  ).toThrow(/inside code/);
});
it("checks the requested tag location even when another location already contains that tag", () => {
  expect(() =>
    update("---\ntags: [new]\n---\n```\ncode\n", {
      operation: "add",
      tags: ["new"],
      location: "content",
    }),
  ).toThrow(/inside code/);
});
it("recognizes whole emoji sequences instead of amputating their modifiers", () => {
  const source = "#👨‍👩‍👧‍👦 #👍🏽\n";
  expect(tagOccurrences(source).map((item) => item.tag)).toEqual(["👨‍👩‍👧‍👦", "👍🏽"]);
  expect(update(source, { operation: "remove", tags: ["👨", "👍"] })).toBe(source);
  expect(update(source, { operation: "rename", oldTag: "👍🏽", newTag: "done" })).toBe("#👨‍👩‍👧‍👦 #done\n");
});
it.each([
  "---\ntags: [broken\n---\nbody",
  "---\ntags: [a]\ntags: [b]\n---\nbody",
  "---\ntags: &tags [a]\ncopy: *tags\n---\nbody",
  "---\nother: &tags [a]\ntags: *tags\n---\nbody",
  "---\ntags: {other: a}\n---\nbody",
  "---\ntags: [true]\n---\nbody",
  "---\ntitle: no closing delimiter",
])(
  "refuses ambiguous or unsupported frontmatter without generating a replacement: %s",
  (source) => {
    expect(() => changeTags(source, { operation: "add", tags: ["new"] })).toThrow();
  },
);
it("does not create edits for an existing case-insensitive tag", () => {
  expect(
    changeTags("---\ntags: [Work]\n---\nbody", { operation: "add", tags: ["work"] }).edits,
  ).toEqual([]);
});
it("validates every exact span before returning changed content", () => {
  expect(() =>
    applySourceEdits("UNSENT keep", [{ start: 0, end: 6, old: "WRONG!", text: "lost" }]),
  ).toThrow(/differ/);
  expect(() =>
    applySourceEdits("UNSENT keep", [
      { start: 0, end: 6, old: "UNSENT", text: "one" },
      { start: 3, end: 6, old: "ENT", text: "two" },
    ]),
  ).toThrow(/overlap/);
});
