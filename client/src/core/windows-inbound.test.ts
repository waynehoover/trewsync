/**
 * A name Windows cannot hold, arriving on a device that runs on Windows
 * (PLAN.md section 4.12).
 *
 * The server accepts `a:b.md`, `CON.md` and `x.md ` because every other
 * platform can hold them, so a note made under one of those names on a Mac
 * reaches a Windows device like any other. Written there, it fails, and a
 * write that fails is filed for retry and fails again on every pass for ever,
 * with the note never arriving and nothing saying why. What it has to be is a
 * stranded path with its reason (section 4.9), the same thing a name the
 * protocol refuses is: not written, not fetched, not retried, and never
 * reported back to the server as a deletion.
 *
 * Every case comes from the `windows` section of `protocol-fixtures.json`,
 * plus one path per reserved name and per forbidden character from the same
 * section, so the list here cannot drift from the one the rule is checked
 * against.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { FakeSocket, engineOnFakeSocket, settle } from "./fake-socket.ts";
import type { WireEntry } from "./transport.ts";
import { MemoryIndexStore, MemoryVault, type Times } from "./vault.ts";
import { describeWindowsRefusal, windowsRefusal, type WindowsRefusal } from "./windows-names.ts";

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol-fixtures.json"), "utf8"),
) as {
  windows: { reserved: string[]; cases: { name: string; path: string; reason: string | null }[] };
};

/** One path and what Windows says about it. */
interface Case {
  readonly path: string;
  readonly reason: WindowsRefusal | null;
}

/**
 * The fixture's cases, then every reserved name and every forbidden character
 * on its own. Each set in a folder of its own, so no two of them are one name
 * to a disk that folds case, and so the server's collision rule has nothing to
 * say about any of them.
 */
const CASES: readonly Case[] = [
  ...fixtures.windows.cases.map((c) => ({
    path: c.path,
    reason: c.reason as WindowsRefusal | null,
  })),
  ...fixtures.windows.reserved.map((name) => ({
    path: `reserved/${name}.txt`,
    reason: "reserved" as const,
  })),
  ...[...'<>:"|?*'].map((c, i) => ({ path: `chars/${i} ${c}.md`, reason: "character" as const })),
  { path: "ends/a trailing dot.", reason: "trailing" },
  { path: "ends/a trailing space ", reason: "trailing" },
  { path: "ends/a folder ending in a space /x.md", reason: "trailing" },
];

const REFUSED = CASES.filter((c) => c.reason !== null);
const WRITABLE = CASES.filter((c) => c.reason === null);

const enc = new TextEncoder();

/** The text each path is written with, so a landed file can be checked by content. */
const textOf = (path: string) => `the note filed as ${JSON.stringify(path)}\n`;

/** Each case as a peer's write, with real content behind each. */
async function entriesFor(
  cases: readonly Case[],
  bodies: Map<string, Uint8Array>,
): Promise<WireEntry[]> {
  const out: WireEntry[] = [];
  for (const [i, c] of cases.entries()) {
    const raw = enc.encode(textOf(c.path));
    const name = await chunkName(raw);
    bodies.set(name, raw);
    out.push({
      uid: i + 1,
      path: c.path,
      size: raw.length,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [name],
      device: "mac",
    });
  }
  return out;
}

/** A server that serves every body it was told about, and records what was asked for. */
function serving(socket: FakeSocket, bodies: Map<string, Uint8Array>, asked: string[]): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      const names = frame["chunks"] as string[];
      asked.push(...names);
      s.bodies(...names.map((n) => bodies.get(n)!));
    } else if (frame["op"] === "ping") s.raw({ res: "pong" });
  };
}

async function accepted(engine: { status(): { pending: number } }, n: number): Promise<void> {
  for (let i = 0; i < 400 && engine.status().pending < n; i++) await settle();
}

/** Every path any upload frame this socket sent names. */
function uploaded(socket: FakeSocket): string[] {
  const out: string[] = [];
  for (const frame of socket.sentText) {
    if (frame["op"] === "put") out.push(frame["path"] as string);
    if (frame["op"] === "putmany") {
      for (const e of frame["entries"] as { path: string }[]) out.push(e.path);
    }
  }
  return out;
}

/**
 * A memory vault that refuses the names a Windows volume refuses, by throwing
 * from the write. That failure is what the engine used to file for retry and
 * meet again on every pass. Windows answers a trailing dot or space
 * differently, by filing the note under another name (platform-probe.ts);
 * refusing is the simpler model, and with the refusal made on the way in
 * neither answer is ever asked for.
 */
class WindowsDisk extends MemoryVault {
  private static refuse(path: string): void {
    if (windowsRefusal(path) === undefined) return;
    const err = new Error(`EINVAL: invalid argument, open '${path}'`) as Error & { code: string };
    err.code = "EINVAL";
    throw err;
  }

  override async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    WindowsDisk.refuse(path);
    await super.write(path, bytes, times);
  }

  override async mkdir(path: string): Promise<void> {
    WindowsDisk.refuse(path);
    await super.mkdir(path);
  }
}

/** `cases` arriving in one batch on a fresh device, and the pass that follows. */
async function arrive(windows: boolean, cases: readonly Case[], store = new MemoryIndexStore()) {
  const rig = await engineOnFakeSocket(
    {},
    { windows, store, ...(windows ? { vault: new WindowsDisk() } : {}) },
  );
  const bodies = new Map<string, Uint8Array>();
  const asked: string[] = [];
  serving(rig.socket, bodies, asked);
  const entries = await entriesFor(cases, bodies);
  rig.socket.raw({ op: "batch", from: 1, to: entries.length, entries });
  await accepted(rig.engine, entries.length);
  const report = await rig.engine.sync({ coalesceWrites: false });
  return { ...rig, bodies, asked, entries, report };
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * The refused cases in fives, because a report names at most five stranded
 * paths (`LISTED_PATHS`) and says how many more there are. Five at a time,
 * every one of them is named, with its reason.
 */
const FIVES: Case[][] = [];
for (let at = 0; at < REFUSED.length; at += 5) FIVES.push(REFUSED.slice(at, at + 5));

describe("a name Windows cannot hold, on Windows", () => {
  it("covers every kind the rule refuses, and names that only look like one", () => {
    const kinds = new Set(REFUSED.map((c) => c.reason));
    expect([...kinds].sort()).toEqual(["character", "reserved", "trailing"]);
    expect(WRITABLE.length).toBeGreaterThan(3);
    for (const name of fixtures.windows.reserved) {
      expect(REFUSED.some((c) => c.path === `reserved/${name}.txt`)).toBe(true);
    }
  });

  it.each(FIVES.map((five) => [five.map((c) => JSON.stringify(c.path)).join(", "), five]))(
    "strands %s, each with its reason",
    async (_, five) => {
      const { report, vault, asked, socket } = await arrive(true, five);
      expect([...report.needsAttention].sort(byPath), "the stranded list").toEqual(
        five.map((c) => ({ path: c.path, why: describeWindowsRefusal(c.reason!) })).sort(byPath),
      );
      expect(report.skipped).toBe(five.length);
      // Not a write error filed for retry, which is what it was.
      expect(report.retrying).toBe(0);
      expect(report.downloaded).toBe(0);
      expect(vault.paths(), "a refused name was written").toEqual([]);
      expect(asked, "a body was fetched for a name with nowhere to go").toEqual([]);
      expect(uploaded(socket), "something went back to the server").toEqual([]);
    },
  );

  it("lands the names Windows can hold beside them, and sends nothing back", async () => {
    const { report, vault, asked, entries, socket } = await arrive(true, CASES);
    const refused = new Set(REFUSED.map((c) => c.path));

    expect(report.skipped).toBe(REFUSED.length);
    for (const c of REFUSED) expect(vault.text(c.path), `${c.path} was written`).toBeUndefined();
    for (const { path, why } of report.needsAttention) {
      const c = REFUSED.find((x) => x.path === path);
      expect(c, `${path} is on the stranded list`).toBeDefined();
      expect(why, path).toBe(describeWindowsRefusal(c!.reason!));
    }
    expect(report.retryingPaths.filter((p) => refused.has(p))).toEqual([]);

    for (const c of WRITABLE) expect(vault.text(c.path), c.path).toBe(textOf(c.path));
    expect(report.downloaded).toBe(WRITABLE.length);

    const refusedChunks = new Set(
      entries.filter((e) => refused.has(e.path)).flatMap((e) => e.chunks),
    );
    expect(asked.filter((n) => refusedChunks.has(n))).toEqual([]);

    // Nothing about a refused name went back to the server, a deletion least
    // of all: a note this device cannot hold is still a note everywhere else.
    expect(uploaded(socket).filter((p) => refused.has(p))).toEqual([]);
  });

  it("says the same on the next pass, rather than trying again", async () => {
    const { engine, asked, socket } = await arrive(true, REFUSED);
    const again = await engine.sync({ coalesceWrites: false });
    expect(again.skipped).toBe(REFUSED.length);
    expect(again.retrying).toBe(0);
    expect(again.needsAttention).toHaveLength(5);
    expect(asked, "the next pass fetched").toEqual([]);
    expect(uploaded(socket)).toEqual([]);
  });

  it("is still stranded, with its reason, after a restart", async () => {
    // The refusal is decided from the name on each pass, and the version it is
    // about persists in the state file, so a restart says what it said.
    const store = new MemoryIndexStore();
    const first = await arrive(true, REFUSED, store);
    expect(first.report.skipped).toBe(REFUSED.length);
    first.socket.close();

    const again = await engineOnFakeSocket(
      { cursor: REFUSED.length },
      { windows: true, store, vault: new WindowsDisk() },
    );
    serving(again.socket, first.bodies, []);
    const after = await again.engine.sync({ coalesceWrites: false });
    expect(after.skipped).toBe(REFUSED.length);
    expect(after.retrying).toBe(0);
    expect(after.needsAttention).toEqual(first.report.needsAttention);
    expect(again.vault.paths()).toEqual([]);
  });

  it("is blocked in the preview a first sync shows", async () => {
    const rig = await engineOnFakeSocket({}, { windows: true, vault: new WindowsDisk() });
    const bodies = new Map<string, Uint8Array>();
    serving(rig.socket, bodies, []);
    const entries = await entriesFor(CASES, bodies);
    rig.socket.raw({ op: "batch", from: 1, to: entries.length, entries });
    await accepted(rig.engine, entries.length);
    const preview = await rig.engine.preview();
    const action = new Map(preview.files.map((f) => [f.path, f.action]));
    for (const c of REFUSED) expect(action.get(c.path), c.path).toBe("blocked");
    for (const c of WRITABLE) expect(action.get(c.path), c.path).toBe("download");
  });
});

describe("the same names, anywhere but Windows", () => {
  it("sync like any other note", async () => {
    const { report, vault } = await arrive(false, CASES);
    for (const c of CASES) expect(vault.text(c.path), c.path).toBe(textOf(c.path));
    expect(report.downloaded).toBe(CASES.length);
    expect(report.skipped).toBe(0);
    expect(report.needsAttention).toEqual([]);
  });
});
