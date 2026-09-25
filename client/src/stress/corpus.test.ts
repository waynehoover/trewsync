import { createHash } from "node:crypto";

import { foldPath } from "../core/paths.ts";
import { pathReason } from "../core/path-policy.ts";
import { corpusFolders, makeCorpus, type Corpus } from "./corpus.ts";

const digest = (c: Corpus): string => {
  const h = createHash("sha256");
  c.files.forEach((f, i) => {
    h.update(f.path);
    h.update("\0");
    h.update(c.bytes(i));
  });
  return h.digest("hex");
};

const text = (c: Corpus, i: number): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(c.bytes(i));

describe("the realistic corpus", () => {
  const corpus = makeCorpus({ seed: 7, files: 3000 });

  it("is the same bytes from the same seed, and different bytes from another", () => {
    expect(digest(makeCorpus({ seed: 7, files: 3000 }))).toBe(digest(corpus));
    expect(digest(makeCorpus({ seed: 8, files: 3000 }))).not.toBe(digest(corpus));
    // File by file: one file regenerates without the rest.
    expect(
      Buffer.from(corpus.bytes(1234)).equals(
        Buffer.from(makeCorpus({ seed: 7, files: 3000 }).bytes(1234)),
      ),
    ).toBe(true);
  });

  it("names only paths the server accepts, none folding together or onto a folder", () => {
    const seen = new Map<string, string>();
    for (const f of corpus.files) {
      expect(pathReason(f.path), f.path).toBeUndefined();
      const key = foldPath(f.path);
      expect(seen.get(key), `${f.path} folds onto ${seen.get(key)}`).toBeUndefined();
      seen.set(key, f.path);
    }
    for (const folder of corpusFolders(corpus)) {
      expect(seen.get(foldPath(folder)), `a file folds onto folder ${folder}`).toBeUndefined();
    }
    // Every folder spelled one way: two spellings of one folder would be two
    // folders on the server and one on this disk.
    const spellings = new Map<string, Set<string>>();
    for (const folder of corpusFolders(corpus)) {
      const key = foldPath(folder);
      spellings.set(key, (spellings.get(key) ?? new Set()).add(folder));
    }
    for (const [key, set] of spellings) expect(set.size, key).toBe(1);
  });

  it("has what a real vault has in its names", () => {
    const paths = corpus.files.map((f) => f.path);
    expect(paths.some((p) => /[^\x00-\x7f]/.test(p))).toBe(true);
    expect(paths.some((p) => /\p{Script=Han}/u.test(p))).toBe(true);
    expect(paths.some((p) => /\p{Extended_Pictographic}/u.test(p))).toBe(true);
    expect(paths.some((p) => p.includes(" "))).toBe(true);
    expect(paths.some((p) => /[A-Z]{3,}/.test(p))).toBe(true);
    expect(paths.every((p) => p === p.normalize("NFC"))).toBe(true);
    expect(corpusFolders(corpus).some((f) => f.split("/").length >= 3)).toBe(true);
    // Nothing Obsidian refuses in a file name.
    expect(paths.some((p) => /[*"\\<>:|?#^[\]]/.test(p))).toBe(false);
  });

  it("has what a real vault has in its files", () => {
    const kinds = corpus.files.map((f) => f.kind);
    const attachments = kinds.filter((k) => k === "attachment").length;
    expect(attachments).toBeGreaterThan(30);
    expect(attachments).toBeLessThan(200);
    expect(kinds.includes("canvas")).toBe(true);
    const notes = corpus.files.map((f, i) => [f, i] as const).filter(([f]) => f.kind === "note");
    const bodies = notes.map(([, i]) => text(corpus, i));
    expect(
      bodies.filter((b) => b.replace(/^\ufeff/, "").startsWith("---\n")).length,
    ).toBeGreaterThan(notes.length / 3);
    expect(bodies.some((b) => b.includes("\r\n"))).toBe(true);
    expect(bodies.some((b) => b.charCodeAt(0) === 0xfeff)).toBe(true);
    const sizes = bodies.map((b) => b.length).sort((a, b) => a - b);
    expect(sizes[Math.floor(sizes.length / 2)]).toBeGreaterThan(500);
    expect(sizes[sizes.length - 1]).toBeGreaterThan(20 * sizes[Math.floor(sizes.length / 2)]!);
    // Links name notes that exist.
    const names = new Set(
      notes.map(([f]) => f.path.slice(f.path.lastIndexOf("/") + 1).replace(/\.md$/, "")),
    );
    const links = bodies.flatMap((b) => [...b.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]!));
    expect(links.length).toBeGreaterThan(notes.length);
    const embeds = new Set(
      corpus.files.filter((f) => f.kind === "attachment").map((f) => f.path.split("/").pop()!),
    );
    for (const l of links) expect(names.has(l) || embeds.has(l), l).toBe(true);
  });

  it("knows what a search for its needle, its tags and its names must find", () => {
    const facts = corpus.facts();
    const holding = corpus.files
      .map((_, i) => i)
      .filter((i) => text(corpus, i).includes(facts.needle.text));
    expect(holding.map((i) => corpus.files[i]!.path)).toEqual([facts.needle.path]);
    expect(facts.tagged.get("recipe")).toBeGreaterThan(10);
    expect(corpus.files.filter((f) => f.path.includes(facts.nameFragment)).length).toBeGreaterThan(
      10,
    );
  });
});
