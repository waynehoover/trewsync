import { fromMarkdown } from "mdast-util-from-markdown";
import { isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";
import { NoteError, sourceEdit, applySourceEdits, type SourceEdit } from "./mcp-notes.ts";
export { sourceEdit, applySourceEdits, type SourceEdit } from "./mcp-notes.ts";

export interface TagOccurrence {
  tag: string;
  start: number;
  end: number;
  location: "frontmatter" | "content";
}
export interface TagChange {
  operation: "add" | "remove" | "rename";
  tags?: readonly string[] | undefined;
  patterns?: readonly string[] | undefined;
  oldTag?: string | undefined;
  newTag?: string | undefined;
  location?: "frontmatter" | "content" | "both" | undefined;
  includeChildren?: boolean | undefined;
  position?: "start" | "end" | undefined;
  normalization?: "preserve" | "lowercase" | "kebab" | undefined;
}

export function validateTag(input: string): string {
  const tag = input.replace(/^#/u, "");
  if (
    !tag.length ||
    Buffer.byteLength(tag) > 200 ||
    !/^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d_/-]+$/u.test(tag) ||
    !/[\p{L}\p{M}\p{Extended_Pictographic}_-]/u.test(tag) ||
    tag.startsWith("/") ||
    tag.endsWith("/") ||
    tag.includes("//")
  ) {
    throw new NoteError(
      "invalid_tag",
      "tags must be at most 200 bytes, contain a non-number, and use letters, numbers, emoji, _, -, or nested / segments",
    );
  }
  return tag;
}
const fold = (value: string) => value.normalize("NFC").toLowerCase();

export function matchesTag(candidate: string, selected: string, children = false): boolean {
  return (
    fold(candidate) === fold(selected) ||
    (children && fold(candidate).startsWith(fold(selected) + "/"))
  );
}
export function tagPattern(pattern: string, value: string): boolean {
  if (
    !pattern.length ||
    Buffer.byteLength(pattern) > 200 ||
    pattern.includes("**") ||
    !/^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d_/*-]+$/u.test(pattern)
  ) {
    throw new NoteError("invalid_tag", "tag patterns use at most 200 bytes and single * wildcards");
  }
  // A bounded glob avoids turning a vault-wide tag operation into an unbounded regex.
  const target = fold(value),
    wanted = fold(pattern.replace(/^#/u, ""));
  let p = 0,
    t = 0,
    star = -1,
    retry = 0;
  while (t < target.length) {
    if (wanted[p] === target[t]) {
      p++;
      t++;
    } else if (wanted[p] === "*") {
      star = p++;
      retry = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++retry;
    } else return false;
  }
  while (wanted[p] === "*") p++;
  return p === wanted.length;
}

export function frontmatter(source: string) {
  const bom = source.startsWith("\ufeff") ? 1 : 0;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const opening = /^---[ \t]*\r?\n/u.exec(source.slice(bom));
  if (!opening) return { bom, newline, start: bom, end: bom, body: bom, present: false };
  const start = bom + opening[0].length;
  const closing = /^---[ \t]*(?:\r?\n|$)/mu.exec(source.slice(start));
  if (!closing)
    throw new NoteError(
      "invalid_frontmatter",
      "the opening frontmatter delimiter has no closing delimiter",
    );
  const end = start + closing.index;
  return { bom, newline, start, end, body: end + closing[0].length, present: true };
}

function frontTags(source: string) {
  const frame = frontmatter(source);
  if (!frame.present) return { frame, node: undefined, tags: [] as TagOccurrence[] };
  const document = parseDocument(source.slice(frame.start, frame.end), {
    keepSourceTokens: true,
    prettyErrors: false,
    logLevel: "silent",
  });
  if (
    document.errors.length ||
    document.warnings.length ||
    (document.contents !== null && !isMap(document.contents))
  ) {
    throw new NoteError("invalid_frontmatter", "frontmatter must be an unambiguous YAML mapping");
  }
  const node = document.get("tags", true) as YamlNode | undefined;
  if (node === undefined) return { frame, node, tags: [] as TagOccurrence[] };
  const nodes = isSeq(node) ? node.items : [node];
  const tags: TagOccurrence[] = [];
  if ((isScalar(node) || isSeq(node)) && node.anchor) {
    throw new NoteError(
      "invalid_frontmatter",
      "an anchored tags property needs an explicit note edit",
    );
  }
  for (const item of nodes) {
    if (
      !isScalar(item) ||
      item.anchor ||
      !item.range ||
      (item.value !== null && typeof item.value !== "string")
    ) {
      throw new NoteError(
        "invalid_frontmatter",
        "tags must be a string or a list of strings without aliases or anchors",
      );
    }
    const values =
      item.value === null
        ? []
        : String(item.value)
            .split(/[\s,]+/u)
            .filter(Boolean);
    for (const value of values)
      tags.push({
        tag: validateTag(value),
        start: frame.start + item.range[0],
        end: frame.start + item.range[1],
        location: "frontmatter",
      });
  }
  return { frame, node, tags };
}

interface MarkdownNode {
  type: string;
  position?:
    { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
  children?: MarkdownNode[] | undefined;
}

function intervals(ranges: { start: number; end: number }[]) {
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function markdownHidden(
  source: string,
  start = 0,
  protectLinks = false,
): { start: number; end: number }[] {
  const hidden: { start: number; end: number }[] = [];
  const visit = (node: MarkdownNode): void => {
    if (
      [
        "code",
        "inlineCode",
        "html",
        ...(protectLinks ? ["link", "image", "definition"] : []),
      ].includes(node.type)
    ) {
      const a = node.position?.start.offset,
        b = node.position?.end.offset;
      if (a !== undefined && b !== undefined) hidden.push({ start: a + start, end: b + start });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(source.slice(start)));
  const protectedRanges = intervals(hidden);
  let index = 0;
  for (let at = source.indexOf("%%", start); at >= 0;) {
    // A literal %% inside a code example must not hide tags after that example.
    while (index < protectedRanges.length && protectedRanges[index]!.end <= at) index++;
    if (protectedRanges[index] && at >= protectedRanges[index]!.start) {
      at = source.indexOf("%%", at + 2);
      continue;
    }
    const close = source.indexOf("%%", at + 2);
    const end = close < 0 ? source.length : close + 2;
    hidden.push({ start: at, end });
    at = source.indexOf("%%", end);
  }
  return intervals(hidden);
}

export function inlineTags(source: string, start = frontmatter(source).body): TagOccurrence[] {
  // A regex that stopped at the first ')' treated URL fragments in balanced
  // Markdown destinations as tags and removed part of the URL during deletion.
  const hidden = markdownHidden(source, start, true);
  for (const match of source.slice(start).matchAll(/!?\[\[[^\]\n]*\]\]/gu)) {
    hidden.push({ start: start + match.index, end: start + match.index + match[0].length });
  }
  const blocked = intervals(hidden);
  let index = 0;
  const found: TagOccurrence[] = [];
  const pattern =
    /(^|[^\p{L}\p{M}\p{N}_/#\\])#([\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d_/-]+)/gu;
  for (const match of source.slice(start).matchAll(pattern)) {
    const at = start + match.index + match[1]!.length;
    while (index < blocked.length && blocked[index]!.end <= at) index++;
    if (blocked[index] && at >= blocked[index]!.start) continue;
    try {
      found.push({
        tag: validateTag(match[2]!),
        start: at,
        end: at + match[2]!.length + 1,
        location: "content",
      });
    } catch {
      /* A hashtag that Obsidian cannot recognize is ordinary text. */
    }
  }
  return found;
}

export function tagOccurrences(source: string): TagOccurrence[] {
  const fm = frontTags(source);
  return [...fm.tags, ...inlineTags(source, fm.frame.body)];
}

function comments(token: unknown, start: number, end: number): string[] {
  if (!token || typeof token !== "object") return [];
  const value = token as Record<string, unknown>;
  if (
    value.type === "comment" &&
    typeof value.offset === "number" &&
    value.offset >= start &&
    value.offset < end &&
    typeof value.source === "string"
  )
    return [value.source];
  return Object.values(value).flatMap((child) =>
    Array.isArray(child)
      ? child.flatMap((item) => comments(item, start, end))
      : comments(child, start, end),
  );
}

export function changeTags(
  source: string,
  input: TagChange,
): { edits: SourceEdit[]; changed: string[] } {
  const normalize = (value: string): string => {
    const tag = validateTag(value);
    if (input.normalization === "lowercase") return fold(tag);
    if (input.normalization === "kebab")
      return tag
        .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1-$2")
        .replace(/_+/gu, "-")
        .toLowerCase();
    return tag;
  };
  const tags = (input.tags ?? []).map(normalize);
  if (tags.length > 100 || (input.patterns?.length ?? 0) > 100)
    throw new NoteError("invalid_tag", "at most 100 tags or patterns may be supplied");
  const patterns = input.patterns ?? [];
  patterns.forEach((pattern) => tagPattern(pattern, ""));
  if (input.operation === "add" && !tags.length)
    throw new NoteError("invalid_tag", "supply tags to add");
  if (input.operation === "remove" && !tags.length && !patterns.length)
    throw new NoteError("invalid_tag", "supply tags or patterns to remove");
  const old = input.operation === "rename" ? validateTag(input.oldTag ?? "") : "";
  const next = input.operation === "rename" ? normalize(input.newTag ?? "") : "";
  const changed = new Set<string>();
  const transform = (tag: string): string | null => {
    if (input.operation === "rename" && matchesTag(tag, old, input.includeChildren)) {
      changed.add(tag);
      const children = tag.split("/").slice(old.split("/").length);
      return validateTag(next + (children.length ? "/" + children.join("/") : ""));
    }
    if (
      input.operation === "remove" &&
      (tags.some((value) => matchesTag(tag, value, input.includeChildren)) ||
        patterns.some((pattern) => tagPattern(pattern, tag)))
    ) {
      changed.add(tag);
      return null;
    }
    return tag;
  };
  const location = input.location ?? (input.operation === "add" ? "frontmatter" : "both");
  const fm = frontTags(source);
  const edits: SourceEdit[] = [];
  if (location !== "content") {
    const after = fm.tags
      .map((item) => transform(item.tag))
      .filter((value): value is string => value !== null);
    if (input.operation === "add")
      for (const tag of tags) {
        if (!after.some((value) => matchesTag(value, tag))) {
          after.push(tag);
          changed.add(tag);
        }
      }
    if (JSON.stringify(after) !== JSON.stringify(fm.tags.map((item) => item.tag))) {
      const value = JSON.stringify(after);
      if (!fm.frame.present)
        edits.push(
          sourceEdit(
            source,
            fm.frame.bom,
            fm.frame.bom,
            `---${fm.frame.newline}tags: ${value}${fm.frame.newline}---${fm.frame.newline}`,
          ),
        );
      else if (!fm.node)
        edits.push(
          sourceEdit(source, fm.frame.end, fm.frame.end, `tags: ${value}${fm.frame.newline}`),
        );
      else {
        const range = fm.node.range;
        if (!range)
          throw new NoteError("invalid_frontmatter", "the tags source range is unavailable");
        const a = fm.frame.start + range[0],
          b = fm.frame.start + range[1];
        // Serializing the whole frontmatter rewrites unrelated properties. Only
        // the tags value changes; comments within a block list stay beside it.
        const kept = comments(fm.node.srcToken, range[0], range[1]);
        const indent = source.slice(source.lastIndexOf("\n", a - 1) + 1, a).match(/^[ \t]*/u)![0];
        const suffix =
          (kept.length
            ? fm.frame.newline + kept.map((line) => indent + line).join(fm.frame.newline)
            : "") + (/\r?\n$/u.test(source.slice(a, b)) ? fm.frame.newline : "");
        edits.push(sourceEdit(source, a, b, (a === b ? " " : "") + value + suffix));
      }
    }
  }
  if (location !== "frontmatter") {
    const occurrences = inlineTags(source, fm.frame.body);
    if (input.operation === "add") {
      const added = tags.filter((tag) => !occurrences.some((item) => matchesTag(item.tag, tag)));
      if (added.length) {
        added.forEach((tag) => changed.add(tag));
        const text = added.map((tag) => `#${tag}`).join(" ") + fm.frame.newline;
        const at = input.position === "start" ? fm.frame.body : source.length;
        edits.push(
          sourceEdit(
            source,
            at,
            at,
            (at > fm.frame.body && !source.endsWith("\n") ? fm.frame.newline : "") + text,
          ),
        );
      }
    } else
      for (const item of occurrences) {
        const value = transform(item.tag);
        if (value !== item.tag)
          edits.push(sourceEdit(source, item.start, item.end, value === null ? "" : `#${value}`));
      }
  }
  const result = applySourceEdits(source, edits);
  const actual = tagOccurrences(result);
  if (
    input.operation === "add" &&
    tags.some((tag) =>
      ["frontmatter", "content"].some(
        (place) =>
          (location === "both" || location === place) &&
          !actual.some((item) => item.location === place && matchesTag(item.tag, tag)),
      ),
    )
  ) {
    throw new NoteError(
      "invalid_tag_location",
      "the insertion would place tags inside code or a comment; choose another position",
    );
  }
  return { edits, changed: [...changed] };
}
