/**
 * A structural check for YAML, for gating a merged `.base` or `.yaml`.
 *
 * Not a parser, and deliberately not one. A gate is asked one question about a
 * merged document, "could this still be read", and answering it with a full
 * YAML implementation would put a second parser's disagreements with
 * Obsidian's between a person and their file. What is here is the subset of
 * YAML's rules that a line-wise merge of two edits can actually break, checked
 * the way the merge broke them: by line.
 *
 * The three that a merge produces, in the order they cost the most:
 *
 *   - **A duplicate key.** Two devices add a view called `Table` to the same
 *     base and the merge keeps both. Obsidian reads one and silently drops the
 *     other, so the edit that lost is gone with nothing to say it ever
 *     arrived. This is the canvas comma of YAML: every other check passes.
 *   - **An indentation that belongs to no open block.** Two devices reindent
 *     around the same place and the merge lands a line four spaces in where
 *     the levels are zero and two. YAML refuses the document outright.
 *   - **A tab in the indentation.** One device's editor writes tabs. YAML
 *     forbids a tab as indentation anywhere, so a merge that pulls one line
 *     into an indented block makes a file nothing will open.
 *
 * Everything a merge does not produce is out of scope and deliberately
 * accepted: anchors, tags, multiple documents, flow collections spanning
 * lines, and every question about whether a scalar means what it says. This
 * gate says no to a document that is definitely broken, never to one it merely
 * does not understand, because a false no costs a conflict copy for a file
 * that was fine.
 *
 * It does not manage that perfectly, which is why `validityGateFor` abstains
 * when this already refuses one of the three inputs. A document shape this
 * reads wrongly would otherwise turn every concurrent edit of that one file
 * into a conflict copy for as long as the file exists, and the person holding
 * it would have no way to tell why. Refusing a merge is only defensible when
 * the unmerged sides pass.
 *
 * Block scalars (`key: |`, `key: >`) are skipped wholesale: their body is
 * text, not structure, and reading its indentation as YAML's would refuse a
 * perfectly ordinary embedded snippet.
 */
export function parsesAsYaml(text: string): boolean {
  /** Open block levels, outermost first, each with the keys seen at it. */
  const open: { indent: number; keys: Set<string> }[] = [];
  /** Indentation of the `|` or `>` whose body is being skipped, if any. */
  let scalarAt: number | undefined;
  /**
   * Whether the line before this one can have children.
   *
   * A key with a value cannot: `d: 1` followed by a deeper line is not a
   * nested block, it is the same scalar continued, and a continuation may not
   * contain `: `. That distinction is the whole of the second rule below, so
   * without it a merge that lands a key at an indentation belonging to no
   * block reads as an ordinary nesting and passes.
   */
  let mayOpen = true;
  /** Unclosed `[` or `{` carried in from an earlier line. */
  let flow = 0;
  /** A quote a previous line opened and did not close. */
  let openQuote = "";

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;

    const indent = line.length - line.replace(/^[ \t]*/, "").length;
    const lead = line.slice(0, indent);

    if (scalarAt !== undefined) {
      // The body of a block scalar is every following line indented past the
      // key that opened it. The first line that is not ends it, and has to be
      // judged as structure.
      if (indent > scalarAt) continue;
      scalarAt = undefined;
    }

    // Still inside a flow collection or a quoted scalar that an earlier line
    // opened. Those may run over as many lines as they like and may contain
    // anything, including a tab and including `: `, so the line is carried
    // rather than read as structure: judging `with a: colon"` as a mapping key
    // refused an ordinary quoted sentence.
    if (flow > 0 || openQuote !== "") {
      ({ flow, openQuote } = carryOver(line, flow, openQuote));
      continue;
    }

    if (lead.includes("\t")) return false;

    const body = line.slice(indent);
    if (body.startsWith("#")) continue;
    // A document marker resets everything, including which keys have been
    // seen: the same key in two documents is two keys.
    if (body === "---" || body === "..." || body.startsWith("--- ")) {
      open.length = 0;
      mayOpen = true;
      continue;
    }

    // A sequence entry is a member of its parent block, not a key in it, and
    // `- key: value` opens a fresh mapping whose indentation is the dash's
    // plus the space after it. Treating the entry itself as a key would call
    // two entries with the same first field a duplicate.
    const dash = /^-(\s+|$)/.exec(body);
    if (dash) {
      const where = settle(open, indent, mayOpen);
      if (where === "nowhere") return false;
      const rest = body.slice(dash[0].length);
      if (rest === "" || rest.startsWith("#")) {
        mayOpen = true;
        continue;
      }
      ({ flow, openQuote } = carryOver(rest, 0, ""));
      const inner = indent + dash[0].length;
      open.push({ indent: inner, keys: new Set() });
      const key = keyOf(rest);
      if (key !== undefined) open[open.length - 1]!.keys.add(key);
      // `- key: |` and a bare `- |` both open one. The second has no key, so
      // requiring one read the whole literal block as structure.
      if (opensBlockScalar(rest)) scalarAt = inner;
      mayOpen = key !== undefined && valueOf(rest) === "";
      continue;
    }

    const where = settle(open, indent, mayOpen);
    if (where === "nowhere") return false;
    if (where === "continued") {
      // A plain scalar carried onto the next line. YAML allows that, and does
      // not allow it to contain `: `, which is exactly what a merge drops in.
      if (keyOf(body) !== undefined) return false;
      ({ flow, openQuote } = carryOver(body, 0, ""));
      continue;
    }

    ({ flow, openQuote } = carryOver(body, 0, ""));

    const key = keyOf(body);
    if (key === undefined) {
      mayOpen = false;
      continue; // a plain scalar, or a flow collection on its own line
    }
    const level = open[open.length - 1]!;
    if (level.keys.has(key)) return false;
    level.keys.add(key);
    if (opensBlockScalar(body)) scalarAt = indent;
    mayOpen = valueOf(body) === "";
  }
  return true;
}

/**
 * What a line leaves open: brackets it did not close, and a quote it did not
 * end. A line that leaves either open carries the next line with it.
 */
function carryOver(
  text: string,
  flow: number,
  openQuote: string,
): { flow: number; openQuote: string } {
  let quote = openQuote;
  for (let at = 0; at < text.length; at++) {
    const ch = text[at]!;
    if (quote) {
      if (ch === "\\" && quote === '"') at++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") flow++;
    else if (ch === "]" || ch === "}") flow = Math.max(0, flow - 1);
    // A comment outside a flow collection runs to the end of the line, and
    // whatever is in it is not structure.
    else if (ch === "#" && flow === 0 && (at === 0 || /\s/.test(text[at - 1]!))) break;
  }
  return { flow, openQuote: quote };
}

/**
 * Brings the open levels to the one this line belongs to, and says what the
 * line's indentation makes it.
 *
 * Deeper than the innermost open level is a child block when the line before
 * could have one, and a continued scalar when it could not. Equal to an open
 * level is a sibling, and closes everything inside it. Anything else is the
 * merge artefact: an indentation no block on the stack has, which is neither.
 */
function settle(
  open: { indent: number; keys: Set<string> }[],
  indent: number,
  mayOpen: boolean,
): "here" | "continued" | "nowhere" {
  const innermost = open[open.length - 1];
  if (innermost === undefined || indent > innermost.indent) {
    if (!mayOpen && innermost !== undefined) return "continued";
    open.push({ indent, keys: new Set() });
    return "here";
  }
  while (open.length > 1 && indent < open[open.length - 1]!.indent) open.pop();
  return indent === open[open.length - 1]!.indent ? "here" : "nowhere";
}

/**
 * The mapping key a line starts with, or undefined if it does not start one.
 *
 * The colon has to be followed by a space or end the line, because `12:30` and
 * `https://example.org` are scalars and calling either a key would invent
 * duplicates out of a list of times. Quoted keys are unwrapped so `"a"` and
 * `a` are the same key, which is what a reader does with them.
 */
function keyOf(body: string): string | undefined {
  let at = 0;
  let quote = "";
  for (; at < body.length; at++) {
    const ch = body[at]!;
    if (quote) {
      if (ch === "\\" && quote === '"') at++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Only a quote that opens the line can wrap a key; one in the middle is
      // part of a scalar.
      if (at !== 0) return undefined;
      quote = ch;
      continue;
    }
    if (ch === ":" && (at + 1 === body.length || body[at + 1] === " ")) break;
    if (ch === "[" || ch === "{" || ch === "#") return undefined;
  }
  if (quote) return undefined; // an unterminated quote is not a key we can name
  if (at >= body.length) return undefined;
  const key = body.slice(0, at).trim();
  if (key === "") return undefined;
  const wrapped =
    (key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"));
  return wrapped && key.length >= 2 ? key.slice(1, -1) : key;
}

/**
 * What follows a key's colon on the same line, trimmed. Empty opens a block.
 *
 * A trailing comment is not a value, and neither is an anchor or a tag on its
 * own: `views: # the views`, `a: &anchor` and `a: !!map` all still open the
 * block that follows them. Read as values they made the next, more indented
 * line a continued scalar, and a continued scalar may not contain `: `, so an
 * ordinary commented base was refused on every merge.
 */
function valueOf(body: string): string {
  const at = body.indexOf(": ");
  const after = at >= 0 ? body.slice(at + 2) : body.endsWith(":") ? "" : body;
  let value = stripComment(after).trim();
  // An anchor and a tag are decoration on whatever comes next, in either
  // order, and either may be the whole of the line.
  for (let i = 0; i < 2; i++) {
    const decoration = /^(?:&[^\s]+|![^\s]*)(?:\s+|$)/.exec(value);
    if (!decoration) break;
    value = value.slice(decoration[0].length).trim();
  }
  return value;
}

/**
 * The line without a trailing comment, where one can be told apart from a `#`
 * inside a quoted scalar. A `#` only starts a comment after whitespace.
 */
function stripComment(text: string): string {
  let quote = "";
  for (let at = 0; at < text.length; at++) {
    const ch = text[at]!;
    if (quote) {
      if (ch === "\\" && quote === '"') at++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (at === 0 || /\s/.test(text[at - 1]!))) return text.slice(0, at);
  }
  return text;
}

/**
 * Whether `key: |` or `key: >` opens a literal block whose body is text.
 *
 * The two indicators after the character come in either order (`|2-` and `|-2`
 * are both real), so both are accepted rather than only the one order.
 */
function opensBlockScalar(body: string): boolean {
  return /^[|>](?:[+-]\d*|\d*[+-]?)$/.test(valueOf(body));
}
