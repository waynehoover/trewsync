/**
 * Note text, made safe for a terminal.
 *
 * `trew search` prints lines out of notes, and a note is untrusted: anything
 * that reached the server as note bytes can hold an escape sequence, and an
 * escape sequence printed raw is an instruction to the terminal, not text. It
 * can recolour the screen, move the cursor over earlier output so a result
 * reads as something else, set the window title, or, on some terminals, write
 * to the clipboard or ask the terminal to answer back into the shell's input.
 * So nothing a note holds reaches the terminal as a control character: every
 * one is spelled out, visibly, as `\u{1b}`, which leaves the rest of a
 * sequence as plain, harmless text and shows the reader that the note holds
 * something odd rather than hiding it.
 *
 * Which characters: C0 controls but the tab (U+0000 to U+001F), DEL, the C1
 * controls (U+0080 to U+009F, which include CSI and OSC as single
 * characters), the line and paragraph separators, and the bidirectional
 * embeddings, overrides and isolates, which reorder what follows them on the
 * screen and can make a line read as another (the "Trojan Source" trick).
 */

const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/** `text` with every character a terminal would act on spelled out. */
export function printable(text: string): string {
  return text.replace(UNSAFE, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}

/**
 * The same characters, escaped the way JSON escapes a character, for output a
 * script reads: `JSON.stringify` escapes C0 controls already and leaves C1
 * controls and the bidirectional marks raw, which a terminal showing the JSON
 * would still act on. The result parses to exactly the same value.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

/** SGR sequences this program writes itself, only ever to a terminal. */
export const STYLE = {
  match: "\u001b[1;31m",
  path: "\u001b[35m",
  line: "\u001b[32m",
  reset: "\u001b[0m",
} as const;

/** One of the STYLE sequences, exactly, or one character `printable` spells out. */
const STYLED_OR_UNSAFE = new RegExp(
  `${Object.values(STYLE)
    .map((s) => s.replace(/[[\]]/g, "\\$&"))
    .join("|")}|${UNSAFE.source}`,
  "gu",
);

/**
 * A line on its way out, as the terminal may see it (T20).
 *
 * Every line the CLI prints passes through here once, because the names in
 * them come from places nobody here controls: files on this disk, paths
 * another device or an agent wrote, device names. Only `search` and part of
 * `status` used to spell anything out, and the server refuses only C0
 * controls and DEL in a name, so a peer's one-byte CSI or a direction override
 * reached the terminal from `sync`, `preview`, `deleted`, `history` and
 * `devices` as an instruction.
 *
 * A line is one line: a newline inside one is spelled out too, so a name
 * cannot print a line of its own. With `style`, which is only ever set for a
 * terminal that may be sent colour, the exact sequences in STYLE go through
 * as they are, since those are this program's own; nothing else does. Text
 * that went through here already comes out the same, so it is safe to escape
 * twice, and JSON from `safeJson` holds nothing this would change.
 */
export function forTerminal(line: string, style: boolean): string {
  if (!style) return printable(line);
  return line.replace(STYLED_OR_UNSAFE, (m) =>
    m.length > 1 ? m : `\\u{${m.codePointAt(0)!.toString(16)}}`,
  );
}
