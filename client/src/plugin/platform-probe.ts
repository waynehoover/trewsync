/**
 * A self-check of this device's filesystem against the rules TrewSync syncs by.
 *
 * Adapted from LiteSync's platform probe (github.com/KJoner/litesync,
 * src/diagnostics/platform-probe.ts, MIT licence, copyright 2026 KJoner). Its
 * idea is the valuable part: a phone cannot run the test suite, so the only way
 * to know what an Android or iOS filesystem does with two names is to ask it,
 * through Obsidian's own adapter, on the device. Rewritten against this
 * project's rules (`fold`, `pathReason`, `windowsRefusal`), in English, with
 * cases LiteSync lacked, and with its trailing-dot and trailing-space cases
 * fixed: those built `trailing.md` and `trailing md`, so neither ever tested a
 * trailing dot or space.
 *
 * Every write happens under one freshly named folder inside the plugin's own
 * directory, which is dot-prefixed and never syncs, and the folder is removed
 * afterwards. No note in the vault is touched.
 *
 * The verdict is not "the device equals the rule". A rule stricter than the
 * device is safe: it refuses a little more than it has to. A device stricter
 * than the rule is where notes are at risk: two names the rule calls different
 * that the disk calls one file overwrite each other, and a name the rule
 * accepts that the disk cannot create fails to write. A report that marked the
 * safe direction red would bury the one line that matters.
 */

import type { DataAdapter } from "obsidian";

import { fold } from "../core/fold.ts";
import { pathReason } from "../core/path-policy.ts";
import { windowsRefusal } from "../core/windows-names.ts";

/** How a case came out: safe, limited (syncs restricted, nothing lost), or unsafe. */
export type Verdict = "safe" | "limited" | "unsafe";

/** One case of the probe. */
export interface ProbeResult {
  readonly name: string;
  /** What this device did. */
  readonly actual: boolean;
  /** What the rules predict. */
  readonly expected: boolean;
  readonly verdict: Verdict;
  readonly note?: string;
}

/** What the probe found on this device. */
export interface ProbeReport {
  readonly platform: string;
  readonly appVersion: string;
  readonly pluginVersion: string;
  readonly results: readonly ProbeResult[];
  readonly hasUnsafe: boolean;
  readonly hasLimited: boolean;
}

/** What the probe needs, passed in so it can run against a fake adapter in tests. */
export interface ProbeOptions {
  readonly adapter: DataAdapter;
  /** The plugin's own directory, `.obsidian/plugins/<id>`, which never syncs. */
  readonly pluginDir: string;
  /** Whether Windows' naming rules apply on this device. */
  readonly windows: boolean;
  /** A short description of the device, such as "Android / mobile". */
  readonly platform: string;
  readonly appVersion: string;
  readonly pluginVersion: string;
  /** Random suffix for the scratch folder; tests pass a fixed one. */
  readonly nonce?: string;
}

const MARKER = new TextEncoder().encode("trew-probe");

async function remove(adapter: DataAdapter, path: string): Promise<void> {
  try {
    if ((await adapter.stat(path)) !== null) await adapter.remove(path);
  } catch {
    // Cleanup failing does not change what was observed; the folder is
    // removed as a whole at the end.
  }
}

/** Whether this device holds `a` and `b` as one file: write one, read the other. */
async function sameFile(adapter: DataAdapter, dir: string, a: string, b: string): Promise<boolean> {
  const pa = `${dir}/${a}`;
  const pb = `${dir}/${b}`;
  try {
    await adapter.writeBinary(pa, MARKER.slice().buffer);
    if ((await adapter.stat(pb)) === null) return false;
    const read = new Uint8Array(await adapter.readBinary(pb));
    return read.length === MARKER.length && read.every((x, i) => x === MARKER[i]);
  } catch {
    return false;
  } finally {
    await remove(adapter, pa);
    await remove(adapter, pb);
  }
}

/**
 * Whether this device can create a file at exactly `name` and read it back.
 *
 * "Exactly" is checked by listing the folder, because a write can succeed
 * under a different name: Windows strips a trailing dot or space, and HFS+
 * rewrites a name into NFD. Reading the name back would pass in both cases,
 * since the same rewriting applies to the read; only the listing shows the
 * name the disk actually keeps.
 */
async function canCreate(adapter: DataAdapter, dir: string, name: string): Promise<boolean> {
  const path = `${dir}/${name}`;
  const parent = path.slice(0, path.lastIndexOf("/"));
  try {
    if (parent !== dir && (await adapter.stat(parent)) === null) await adapter.mkdir(parent);
    await adapter.writeBinary(path, MARKER.slice().buffer);
    const read = new Uint8Array(await adapter.readBinary(path));
    if (read.length !== MARKER.length) return false;
    return (await adapter.list(parent)).files.includes(path);
  } catch {
    return false;
  } finally {
    await remove(adapter, path);
    if (parent !== dir) {
      try {
        await adapter.rmdir(parent, true);
      } catch {
        // Removed with the probe folder at the end.
      }
    }
  }
}

function collisionResult(name: string, actual: boolean, expected: boolean): ProbeResult {
  if (actual && !expected) {
    return {
      name,
      actual,
      expected,
      verdict: "unsafe",
      note:
        "This device holds these two names as one file and the rules call them two, so two " +
        "notes with these names would overwrite each other. Please report this.",
    };
  }
  if (!actual && expected) {
    return {
      name,
      actual,
      expected,
      verdict: "safe",
      note: "The rules are stricter than this device: they refuse the second name, which loses nothing.",
    };
  }
  return { name, actual, expected, verdict: "safe" };
}

function creatableResult(name: string, actual: boolean, expected: boolean): ProbeResult {
  if (expected && !actual) {
    return {
      name,
      actual,
      expected,
      verdict: "unsafe",
      note:
        "The rules accept this name and this device cannot create it, so a note with it " +
        "would fail to arrive here. Please report this.",
    };
  }
  if (actual && !expected) {
    return {
      name,
      actual,
      expected,
      verdict: "limited",
      note:
        "This device can hold the name and the rules refuse it, so such a note stays on " +
        "the device that made it, listed with the reason. Nothing is lost.",
    };
  }
  return { name, actual, expected, verdict: "safe" };
}

function behaviourResult(
  name: string,
  actual: boolean,
  expected: boolean,
  note: string,
): ProbeResult {
  return actual === expected
    ? { name, actual, expected, verdict: "safe" }
    : { name, actual, expected, verdict: "unsafe", note };
}

/** Runs every case, cleans up, and returns what it found. */
export async function runPlatformProbe(opts: ProbeOptions): Promise<ProbeReport> {
  const { adapter } = opts;
  const dir = `${opts.pluginDir}/probe-${opts.nonce ?? Math.random().toString(36).slice(2, 10)}`;
  await adapter.mkdir(dir);
  const results: ProbeResult[] = [];
  const accepts = (name: string) =>
    pathReason(name) === undefined && (!opts.windows || windowsRefusal(name) === undefined);
  try {
    for (const [label, a, b] of [
      ["Names that differ only by case", "Note.md", "note.md"],
      ["The same name in NFC and in NFD", "caf\u00e9.md", "cafe\u0301.md"],
      ["Sharp s and ss", "Stra\u00dfe.md", "STRASSE.md"],
      ["Dotted capital I and i with a dot above", "\u0130.md", "i\u0307.md"],
    ] as const) {
      results.push(collisionResult(label, await sameFile(adapter, dir, a, b), fold(a) === fold(b)));
    }
    for (const [label, name] of [
      ["A name ending in a dot", "trailing."],
      ["A name ending in a space", "trailing "],
      ["A folder ending in a dot", "dot./x.md"],
      ["The reserved name CON", "CON.md"],
      ["The reserved name nul in lower case", "nul"],
      ["The reserved name COM1", "COM1.txt"],
      ["A colon", "a:b.md"],
      ["A question mark", "a?b.md"],
      ["An asterisk", "a*b.md"],
      ["A pipe", "a|b.md"],
      ["A double quote", 'a"b.md'],
      ["Angle brackets", "a<b>.md"],
      ["A non-breaking space", "a\u00a0b.md"],
      ["A 255-byte name", "a".repeat(252) + ".md"],
      ["A 256-byte name", "a".repeat(253) + ".md"],
    ] as const) {
      results.push(creatableResult(label, await canCreate(adapter, dir, name), accepts(name)));
    }

    // Renaming onto an existing name must refuse rather than overwrite: the
    // plugin's preserving replace depends on it (client/src/plugin/vault.ts).
    const from = `${dir}/rename-a.md`;
    const onto = `${dir}/rename-b.md`;
    await adapter.writeBinary(from, MARKER.slice().buffer);
    await adapter.writeBinary(onto, new Uint8Array([1]).buffer);
    let refused = false;
    try {
      await adapter.rename(from, onto);
    } catch {
      refused = true;
    }
    results.push(
      behaviourResult(
        "Renaming onto an existing file refuses",
        refused,
        true,
        "This device's adapter renamed over an existing file instead of refusing, which the " +
          "plugin's preserving replace does not expect. Please report this.",
      ),
    );
    await remove(adapter, from);
    await remove(adapter, onto);

    // Renaming into an empty slot keeps the whole file: how a download lands.
    const staged = `${dir}/staged.md`;
    const slot = `${dir}/slot.md`;
    await adapter.writeBinary(staged, MARKER.slice().buffer);
    let kept = false;
    try {
      await adapter.rename(staged, slot);
      kept = new Uint8Array(await adapter.readBinary(slot)).length === MARKER.length;
    } catch {
      kept = false;
    }
    results.push(
      behaviourResult(
        "Renaming into an empty name keeps the whole file",
        kept,
        true,
        "A rename into an empty name did not keep the file whole on this device. Please report this.",
      ),
    );
  } finally {
    try {
      await adapter.rmdir(dir, true);
    } catch {
      // Left behind in the plugin's own directory, which never syncs.
    }
  }
  return {
    platform: opts.platform,
    appVersion: opts.appVersion,
    pluginVersion: opts.pluginVersion,
    results,
    hasUnsafe: results.some((r) => r.verdict === "unsafe"),
    hasLimited: results.some((r) => r.verdict === "limited"),
  };
}

/** The report as Markdown a person can paste into an issue. */
export function renderProbeReport(report: ProbeReport): string {
  const yes = (b: boolean) => (b ? "yes" : "no");
  const lines = [
    "# TrewSync platform self-check",
    "",
    `- Device: **${report.platform}**`,
    `- Obsidian: ${report.appVersion}`,
    `- Plugin: ${report.pluginVersion}`,
    "",
    report.hasUnsafe
      ? "> **Something on this device is stricter than the rules** (marked unsafe below). " +
        "Notes can be at risk here: please report this page."
      : report.hasLimited
        ? "> Nothing unsafe. Some names are limited: they stay on the device that made them, with the reason shown."
        : "> Nothing to report: the rules match this device or are stricter than it.",
    "",
    "| Case | This device | The rules | Verdict |",
    "| --- | --- | --- | --- |",
    ...report.results.map(
      (r) => `| ${r.name} | ${yes(r.actual)} | ${yes(r.expected)} | ${r.verdict} |`,
    ),
  ];
  const notes = report.results.filter((r) => r.note !== undefined);
  if (notes.length > 0) {
    lines.push("", "## Notes", "", ...notes.map((r) => `- **${r.name}**: ${r.note}`));
  }
  lines.push(
    "",
    "This checks one device. Two phones of the same make can have different filesystems " +
      "(internal storage, an SD card), so the result is not a claim about any other device.",
  );
  return lines.join("\n") + "\n";
}
