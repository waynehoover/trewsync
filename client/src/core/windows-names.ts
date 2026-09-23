/**
 * Names Windows cannot hold, for the plugin on Windows (PLAN.md section 4.12).
 *
 * The server accepts these paths, because they are valid on every platform
 * the product supports. A Windows device refuses them on the way in, and the
 * refusal becomes a stranded path with its reason (PLAN.md section 4.9): a
 * note named `a:b.md` made on a Mac must arrive as something a person can see
 * and act on, never as a write error retried for ever.
 *
 * Checked against the `windows` section of `protocol-fixtures.json`, which
 * `scripts/protocol-vectors.py` writes from Microsoft's naming rules.
 */

/**
 * The reserved device names, with or without an extension. COM0, LPT0 and the
 * superscript digits are on Microsoft's list too.
 */
export const WINDOWS_RESERVED_NAMES: readonly string[] = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...[..."0123456789\u00b9\u00b2\u00b3"].map((d) => `COM${d}`),
  ...[..."0123456789\u00b9\u00b2\u00b3"].map((d) => `LPT${d}`),
];

/** Why Windows cannot hold a path, in the order checked per segment. */
export type WindowsRefusal = "character" | "trailing" | "reserved";

const RESERVED = new Set(WINDOWS_RESERVED_NAMES);

/** Upper case for a to z only, so no Unicode rule is involved. */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

/** Why Windows cannot hold `path`, or `undefined` when it can. */
export function windowsRefusal(path: string): WindowsRefusal | undefined {
  for (const segment of path.split("/")) {
    if (/[<>:"|?*]/.test(segment)) return "character";
    if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing";
    const stem = segment.split(".", 1)[0]!.replace(/ +$/, "");
    if (RESERVED.has(asciiUpper(stem))) return "reserved";
  }
  return undefined;
}

/** A sentence for the stranded list, naming what Windows objects to. */
export function describeWindowsRefusal(reason: WindowsRefusal): string {
  switch (reason) {
    case "character":
      return 'Windows does not allow < > : " | ? * in a file or folder name';
    case "trailing":
      return "Windows does not allow a file or folder name to end with a dot or a space";
    case "reserved":
      return "Windows reserves this name for a device (CON, PRN, AUX, NUL, COM and LPT names)";
  }
}
