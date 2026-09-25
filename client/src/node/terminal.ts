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
