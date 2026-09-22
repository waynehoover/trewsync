import { parse, preprocess, postprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";
import { posix } from "node:path";
import { frontmatter, markdownHidden } from "./mcp-markdown.ts";
import { NoteError, sourceEdit, type SourceEdit } from "./mcp-notes.ts";

export interface LinkChange {
  path: string;
  from: string;
  to?: string | undefined;
  inventory: readonly string[];
  canonical: (path: string) => string;
}
interface LinkSpan {
  start: number;
  end: number;
  wholeStart: number;
  wholeEnd: number;
  url: string;
  wiki: boolean;
  fragmentAt?: number | undefined;
}
function escaped(source: string, at: number): boolean {
  let count = 0;
  while (at > 0 && source[--at] === "\\") count++;
  return count % 2 === 1;
}

export function changeLinks(
  source: string,
  change: LinkChange,
): { edits: SourceEdit[]; ambiguous: number } {
  const body = frontmatter(source).body;
  const hidden = markdownHidden(source, body);
  const blocked = (start: number, end: number) =>
    hidden.some((range) => start < range.end && end > range.start);
  const spans: LinkSpan[] = [];
  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(source.slice(body), undefined, true)),
  );
  const owners: { start: { offset: number }; end: { offset: number } }[] = [];
  let current: LinkSpan | undefined;
  for (const [direction, token] of events) {
    const owner = ["link", "image", "definition"].includes(token.type);
    const destination = ["resourceDestinationString", "definitionDestinationString"].includes(
      token.type,
    );
    if (direction === "enter") {
      if (owner) owners.push(token);
      if (destination) {
        const enclosing = owners.at(-1);
        const start = token.start.offset + body,
          end = token.end.offset + body;
        if (enclosing && !blocked(start, end)) {
          current = {
            start,
            end,
            wholeStart: enclosing.start.offset + body,
            wholeEnd: enclosing.end.offset + body,
            url: decodeString(source.slice(start, end)),
            wiki: false,
          };
          spans.push(current);
        }
      } else if (current && current.fragmentAt === undefined) {
        const start = token.start.offset + body;
        const raw = source.slice(start, token.end.offset + body);
        if (token.type === "data" && raw.includes("#"))
          current.fragmentAt = start + raw.indexOf("#");
        else if (
          ["characterReference", "characterEscape"].includes(token.type) &&
          decodeString(raw) === "#"
        )
          current.fragmentAt = start;
      }
    } else {
      if (destination) current = undefined;
      if (owner) owners.pop();
    }
  }
  const markdown = [...spans];
  for (const match of source.slice(body).matchAll(/!?\[\[([^\]\n]*?)\]\]/gu)) {
    const at = body + match.index;
    const end = at + match[0].length;
    if (
      escaped(source, at) ||
      blocked(at, end) ||
      markdown.some((span) => at < span.wholeEnd && end > span.wholeStart)
    )
      continue;
    const start = at + (match[0].startsWith("!") ? 3 : 2);
    const url = match[1]!.split("|")[0]!;
    spans.push({ start, end: start + url.length, wholeStart: at, wholeEnd: end, url, wiki: true });
  }
  const resolver = (inventory: readonly string[]) => {
    const paths = new Map<string, Set<string>>(),
      short = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, path: string) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(path);
    };
    for (const path of inventory)
      for (const name of new Set([path, path.replace(/\.(md|txt)$/iu, "")])) {
        add(paths, change.canonical(name), path);
        add(short, change.canonical(posix.basename(name)), path);
      }
    return (name: string, wiki: boolean, owner: string): string[] => {
      if (!name || /^[a-z][a-z0-9+.-]*:/iu.test(name) || name.startsWith("//")) return [];
      const candidates = new Set<string>();
      const add = (name: string) => {
        for (const path of paths.get(change.canonical(posix.normalize(name))) ?? [])
          candidates.add(path);
      };
      if (name.startsWith("/")) add(name.slice(1));
      else if (wiki) {
        add(name);
        add(posix.join(posix.dirname(owner), name));
        if (!name.includes("/"))
          for (const path of short.get(change.canonical(name)) ?? []) candidates.add(path);
      } else add(posix.join(posix.dirname(owner), name));
      return [...candidates];
    };
  };
  const resolve = resolver(change.inventory);
  const after = resolver(
    change.to === undefined
      ? change.inventory
      : [
          ...change.inventory.filter(
            (path) => change.canonical(path) !== change.canonical(change.from),
          ),
          change.to,
        ],
  );
  const edits: SourceEdit[] = [];
  let ambiguous = 0;
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const hash = span.url.indexOf("#");
    const encoded = hash < 0 ? span.url : span.url.slice(0, hash);
    let name: string;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    const candidates = resolve(name, span.wiki, change.path);
    const wasMissing = candidates.length === 0;
    const sourceMatch = candidates.some(
      (path) => change.canonical(path) === change.canonical(change.from),
    );
    const outbound =
      change.to !== undefined && change.canonical(change.path) === change.canonical(change.from);
    if (
      wasMissing &&
      outbound &&
      !span.wiki &&
      name &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(name) &&
      !name.startsWith("/")
    ) {
      const previous = posix.normalize(posix.join(posix.dirname(change.path), name));
      if (previous !== ".." && !previous.startsWith("../")) candidates.push(previous);
    }
    if (!sourceMatch && !outbound) continue;
    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguous++;
      continue;
    }
    if (sourceMatch && change.to === undefined) {
      edits.push(
        sourceEdit(
          source,
          span.wholeStart,
          span.wholeEnd,
          `~~${source.slice(span.wholeStart, span.wholeEnd)}~~`,
        ),
      );
      continue;
    }
    const destination = sourceMatch ? change.to! : candidates[0]!;
    const owner = outbound ? change.to! : change.path;
    const reference = (target: string) =>
      span.wiki
        ? target
        : name.startsWith("/")
          ? "/" + target
          : posix.relative(posix.dirname(owner), target);
    let target = destination;
    if (!/\.(md|txt)$/iu.test(name)) {
      const shortened = target.replace(/\.(md|txt)$/iu, "");
      const found = after(reference(shortened), span.wiki, owner);
      if (found.length === 1 && change.canonical(found[0]!) === change.canonical(destination))
        target = shortened;
    }
    target = reference(target);
    const resolved = after(target, span.wiki, owner);
    if (
      !wasMissing &&
      (resolved.length !== 1 || change.canonical(resolved[0]!) !== change.canonical(destination))
    )
      throw new NoteError(
        "ambiguous_link",
        "the generated destination would not identify the intended note; choose an unambiguous destination",
      );
    const escapedTarget = span.wiki
      ? target.replace(/[%#|\[\]\r\n]/gu, (char) => encodeURIComponent(char))
      : target
          .split("/")
          .map((part) =>
            encodeURIComponent(part).replace(
              /[!'()*]/gu,
              (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
            ),
          )
          .join("/");
    const raw = source.slice(span.start, span.end);
    const fragment =
      hash < 0
        ? ""
        : span.fragmentAt !== undefined
          ? source.slice(span.fragmentAt, span.end)
          : span.wiki
            ? raw.slice(raw.indexOf("#"))
            : span.url.slice(hash);
    const text = escapedTarget + fragment;
    if (text !== raw) edits.push(sourceEdit(source, span.start, span.end, text));
  }
  const disjoint = edits.filter(
    (edit) =>
      !edits.some(
        (other) =>
          other !== edit &&
          other.start <= edit.start &&
          other.end >= edit.end &&
          (other.start < edit.start || other.end > edit.end),
      ),
  );
  return { edits: disjoint, ambiguous };
}
