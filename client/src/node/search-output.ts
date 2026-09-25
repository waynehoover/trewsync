/**
 * What `trew search` prints for a person: one line per match, grep's shape,
 * `path:line:column: the line`, with the match picked out in colour only when
 * the output is a terminal, and every character of note text a terminal would
 * act on spelled out first (terminal.ts). Context lines are `path-line- text`,
 * and groups of them are separated by `--`, as grep separates them.
 */

import type { SearchMatch, SearchMode } from "../core/transport.ts";
import { STYLE, printable } from "./terminal.ts";

/** The most characters a match's line is cut to before it is shown. */
const LEAD_UNITS = 256;
const TEXT_UNITS = 1024;

/**
 * Where the match starts in `m.text` and how long it is, in UTF-16 code
 * units, or undefined when it cannot be placed.
 *
 * The server sends the line from at most 256 units before the match, moved
 * forward a unit when that would split a surrogate pair, so the match starts
 * at one of two offsets; the one whose text is the query, compared without
 * case as the search was, is it. A content match is as many characters long
 * as the query, since the case fold the search compares by maps one character
 * to one; a tag's runs to the end of the tag.
 */
export function matchSpan(
  m: SearchMatch,
  query: string,
  mode: SearchMode,
): { start: number; end: number } | undefined {
  if (m.kind === "filename" || m.line === 0) return undefined;
  const lead = Math.max(0, m.column - 1 - LEAD_UNITS);
  const candidates = [m.column - 1 - lead, m.column - 2 - lead].filter(
    (s) => s >= 0 && s < m.text.length,
  );
  if (candidates.length === 0) return undefined;
  const span = (start: number): { start: number; end: number } => {
    if (m.kind === "tag" || mode === "tag") {
      let end = start + 1;
      while (end < m.text.length && !/[\s,;:"'`()[\]{}<>|]/u.test(m.text[end]!)) end++;
      return { start, end };
    }
    let end = start;
    for (let n = [...query].length; n > 0 && end < m.text.length; n--) {
      end += m.text.codePointAt(end)! > 0xffff ? 2 : 1;
    }
    return { start, end };
  };
  const folded = query.toLowerCase();
  for (const start of candidates) {
    const s = span(start);
    if (m.kind === "tag" || mode === "tag") {
      if (m.text[start] === "#" || m.text.slice(start).toLowerCase().startsWith(folded)) return s;
      continue;
    }
    if (m.text.slice(s.start, s.end).toLowerCase() === folded) return s;
  }
  return span(candidates[0]!);
}

/** The line of one match, as it is printed. */
export function matchLine(m: SearchMatch, query: string, mode: SearchMode, color: boolean): string {
  const path = color ? `${STYLE.path}${printable(m.path)}${STYLE.reset}` : printable(m.path);
  if (m.kind === "filename" || m.line === 0) return `${path}  (the file name matches)`;
  const where = `${m.line}:${m.column}`;
  const at = color ? `${STYLE.line}${where}${STYLE.reset}` : where;
  // A carriage return before the newline stays at the end of its line, as
  // the note holds it; it is the line's ending, not something to show.
  const text = m.text.endsWith("\r") ? m.text.slice(0, -1) : m.text;
  let shown: string;
  const span = color ? matchSpan({ ...m, text }, query, mode) : undefined;
  if (span !== undefined) {
    shown =
      printable(text.slice(0, span.start)) +
      STYLE.match +
      printable(text.slice(span.start, span.end)) +
      STYLE.reset +
      printable(text.slice(span.end));
  } else {
    shown = printable(text);
  }
  // Said where the line was cut: the server sends at most 256 units before a
  // match and 1,024 in all.
  const cutBefore = m.column - 1 > LEAD_UNITS;
  const cutAfter = m.clipped && m.text.length >= TEXT_UNITS - 1;
  return `${path}:${at}: ${cutBefore ? "\u2026" : ""}${shown}${cutAfter ? "\u2026" : ""}`;
}

/** A context line, before or after a match, as it is printed. */
export function contextLine(path: string, line: number, text: string, color: boolean): string {
  const shownPath = color ? `${STYLE.path}${printable(path)}${STYLE.reset}` : printable(path);
  const body = text.endsWith("\r") ? text.slice(0, -1) : text;
  return body === "" ? `${shownPath}-${line}-` : `${shownPath}-${line}- ${printable(body)}`;
}

/** Every line one match prints, its context included. */
export function renderMatch(
  m: SearchMatch,
  query: string,
  mode: SearchMode,
  color: boolean,
): string[] {
  const out: string[] = [];
  m.before.forEach((text, i) => {
    out.push(contextLine(m.path, m.line - m.before.length + i, text, color));
  });
  out.push(matchLine(m, query, mode, color));
  m.after.forEach((text, i) => {
    out.push(contextLine(m.path, m.line + 1 + i, text, color));
  });
  return out;
}
