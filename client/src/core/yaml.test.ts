import { describe, expect, it } from "vitest";

import { looksLikeText, looksLikeYaml } from "./chunk.ts";
import { validityGateFor } from "./engine.ts";
import { parsesAsYaml } from "./yaml.ts";

/** An Obsidian Base, roughly as the application writes one. */
function base(views: string): string {
  return [
    "filters:",
    "  and:",
    '    - file.hasTag("book")',
    "properties:",
    "  note.rating:",
    "    displayName: Rating",
    "views:",
    views,
  ].join("\n");
}

describe("parsesAsYaml", () => {
  it("accepts the documents a base is made of", () => {
    const good = [
      base(["  - type: table", "    name: All", "    order:", "      - file.name"].join("\n")),
      "",
      "# just a comment\n",
      "a: 1\nb: 2\n",
      "list:\n  - one\n  - two\n",
      // Two sequence entries whose first field has the same name are two
      // entries, not a duplicate key. This is the shape every base has.
      "views:\n  - name: A\n    type: table\n  - name: B\n    type: table\n",
      // A colon that is not a key separator.
      "when: 12:30\nurl: https://example.org/a\n",
      // Quoted keys, and a quoted value holding a colon.
      '"a b": 1\ntitle: "x: y"\n',
      // Flow collections on one line.
      "order: [file.name, note.rating]\nmap: {a: 1, b: 2}\n",
      // A block scalar whose body is indented like anything at all, including
      // with tabs, as long as it stays inside the block.
      "query: |\n  SELECT *\n      FROM x\n  \t-- a tab inside a literal block is fine\nnext: 1\n",
      // A key with a trailing comment still opens the block under it. This is
      // the shape a hand-edited base is most likely to have.
      "views: # the views\n  - name: A\n    type: table\n",
      // So do an anchor and a tag, in either order, and either alone.
      "a: &anchor\n  b: 1\nc: !!map\n  d: 2\ne: !tag &x\n  f: 3\n",
      // A quoted scalar running over a line, with a colon in it.
      'title: "some text\n  with a: colon in it"\nnext: 1\n',
      // A flow mapping over two lines, whose continuation looks like a key.
      "order: {a: 1,\n  b: 2}\nnext: 1\n",
      // Block scalar indicators in either order.
      "a: |2-\n  x\nb: |-2\n  y\nc: 1\n",
      // A bare literal block as a sequence item, which has no key at all.
      "steps:\n  - |\n    a: not a key\n    b: nor this\n  - second\n",
      // A document marker resets the keys, so the same key twice is fine.
      "a: 1\n---\na: 2\n",
      // Deeper nesting and a full dedent back to the root.
      "a:\n  b:\n    c: 1\nd: 2\n",
      // An empty sequence entry, and a comment at an odd indentation.
      "a:\n  -\n  - x\n      # trailing note\n",
    ];
    for (const text of good) expect(parsesAsYaml(text), JSON.stringify(text)).toBe(true);
  });

  it("refuses the three things a line-wise merge produces", () => {
    // A duplicate key: both devices added a view named the same way, and a
    // reader keeps one and drops the other with nothing to say so.
    expect(parsesAsYaml("views:\n  name: A\n  type: table\n  name: B\n")).toBe(false);
    // At the root, too.
    expect(parsesAsYaml("filters:\n  and: []\nfilters:\n  or: []\n")).toBe(false);
    // An indentation belonging to no open block: zero and two are open, and
    // the merge landed a line at four.
    expect(parsesAsYaml("a:\n  b: 1\nc:\n  d: 1\n      e: 1\nf: 1\n")).toBe(false);
    // A tab in the indentation, which YAML forbids outright.
    expect(parsesAsYaml("a:\n\tb: 1\n")).toBe(false);
  });

  it("says nothing about what it does not understand", () => {
    // A false refusal costs a conflict copy for a file that was fine, so
    // anything a merge does not produce is accepted rather than guessed at.
    const tolerated = [
      "a: &anchor 1\nb: *anchor\n",
      "!!map\na: 1\n",
      "? complex key\n: value\n",
      "a: [1,\n  2]\n",
      "%YAML 1.2\n---\na: 1\n",
    ];
    for (const text of tolerated) expect(parsesAsYaml(text), JSON.stringify(text)).toBe(true);
  });
});

describe("the gate abstains rather than refusing what it cannot read", () => {
  it("is not applied when a side already fails it", () => {
    // A document shape this reads wrongly would otherwise turn every
    // concurrent edit of that one file into a conflict copy for as long as the
    // file existed, and nothing would say why.
    const broken = "a:\n\tb: 1\n";
    expect(parsesAsYaml(broken)).toBe(false);
    expect(validityGateFor("Books.base", broken, broken, broken)).toBeUndefined();
    expect(validityGateFor("Books.base", "a: 1\n", broken, "a: 1\n")).toBeUndefined();
    expect(validityGateFor("Books.base", "a: 1\n", "a: 2\n", "a: 3\n")).toBeDefined();
  });
});

describe("bases are notes", () => {
  it("chunks, merges and previews a .base as text", () => {
    expect(looksLikeText("Books.base")).toBe(true);
    expect(looksLikeText("Books.BASE")).toBe(true);
    expect(looksLikeYaml("Books.base")).toBe(true);
  });

  it("is the gate the engine actually asks for, on a base", () => {
    // The wiring, which is the part that goes untested: the gate can be
    // correct and asked of nothing.
    const gate = validityGateFor("Books.base", "views:\n", "views:\n", "views:\n");
    expect(gate, "no gate for a .base, so a merge can duplicate a view name").toBeDefined();
    expect(gate!(base("  - name: A\n    type: table"))).toBe(true);
    expect(gate!("views:\n  name: A\n  name: B\n")).toBe(false);
    // And the other YAML extensions, which had no gate either.
    for (const path of ["config.yaml", "config.yml"]) {
      expect(validityGateFor(path, "", "", ""), path).toBeDefined();
    }
  });
});
