/**
 * `trew search`, end to end: a real server, a paired directory on a real disk,
 * notes synced to the server, and the command driven as a person drives it,
 * to a terminal and to a pipe, and as a script drives it, with --json.
 *
 * The note text it prints is untrusted, so one note here is written to take
 * over a terminal: escape sequences that clear the screen, set the window
 * title and recolour what follows, a C1 control that is CSI on its own, a
 * carriage return that would overwrite the line, a bell, and a bidirectional
 * override. None of it may reach the terminal as anything but visible text.
 */

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { run, type Console } from "./cli.ts";
import { matchSpan, matchLine } from "./search-output.ts";
import { STYLE, forTerminal, printable, safeJson } from "./terminal.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

class Run {
  readonly out: string[] = [];
  readonly err: string[] = [];
  code = -1;
  get stdout(): string {
    return this.out.join("\n");
  }
  get stderr(): string {
    return this.err.join("\n");
  }
  get all(): string {
    return this.stdout + "\n" + this.stderr;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.stdout) as Record<string, unknown>;
  }
}

async function cliWith(color: boolean, ...argv: string[]): Promise<Run> {
  const r = new Run();
  const io: Console = { out: (l) => r.out.push(l), err: (l) => r.err.push(l), color };
  r.code = await run(argv, io);
  return r;
}

const cli = (...argv: string[]) => cliWith(false, ...argv);

let server: TestServer | undefined;
const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
  server = undefined;
});

/**
 * A server, and a directory paired to it as its first device holding these
 * notes, synced. `prepare` is given the server's data directory before it
 * starts.
 */
async function vaultWith(
  notes: Record<string, string>,
  extraArgs: string[] = [],
  prepare?: (dataDir: string) => Promise<void>,
): Promise<string> {
  server = new TestServer();
  server.extraArgs = extraArgs;
  if (prepare) {
    server.dataDir = await mkdtemp(join(tmpdir(), "trew-data-"));
    await prepare(server.dataDir);
  }
  await server.start();
  const dir = await mkdtemp(join(tmpdir(), "trew-search-"));
  dirs.push(dir);
  const paired = await cli("pair", await server.firstInvite(), "--dir", dir, "--device", "a");
  expect(paired.code, paired.all).toBe(0);
  for (const [path, text] of Object.entries(notes)) {
    const at = join(dir, path);
    await mkdir(join(at, ".."), { recursive: true });
    await writeFile(at, text);
  }
  const synced = await cli("sync", "--dir", dir);
  expect(synced.code, synced.all).toBe(0);
  return dir;
}

/**
 * Leaves a server no way to make its search index, so it serves without one:
 * `search.db` is a directory, which no database opens, and setting it aside
 * as `search.db.broken` is refused because a non-empty directory holds that
 * name already.
 */
async function noIndexCanBeMade(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "search.db", "x"), { recursive: true });
  await mkdir(join(dataDir, "search.db.broken", "x"), { recursive: true });
}

const ESC = "\x1b";
const BEL = "\x07";
const CSI = String.fromCodePoint(0x9b);
const RLO = String.fromCodePoint(0x202e);
const LSEP = String.fromCodePoint(0x2028);

/** Every character a terminal acts on, other than the ones this program writes to colour. */
function hostile(s: string): string[] {
  const found: string[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      (c < 0x20 && c !== 0x09) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    ) {
      found.push(c.toString(16));
    }
  }
  return found;
}

/** The note that tries to drive the terminal. */
const TRAP =
  `harmless first line\n` +
  `a harbour ${ESC}[2J${ESC}]0;owned${BEL}${ESC}[31mred${CSI}1m carriage\rreturn ${RLO}desrever ${LSEP}end\n`;

describe("trew search", () => {
  it("finds literal text in the server's notes, one line per match, grep's shape", async () => {
    const dir = await vaultWith(
      {
        "Notes/a.md": "first line\nthe Harbour at dawn\n",
        "Notes/b.md": "nothing to see\n",
        "c.md": "harbour, harbour\n",
      },
      [],
      noIndexCanBeMade,
    );
    const r = await cli("search", "harbour", "--dir", dir);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toEqual([
      "Notes/a.md:2:5: the Harbour at dawn",
      "c.md:1:1: harbour, harbour",
      "c.md:1:10: harbour, harbour",
    ]);
    // Not a TTY: not one escape sequence, and nothing said about the search
    // on standard output.
    expect(r.out.flatMap(hostile)).toEqual([]);
    // A server that could make no search index says every note was read.
    expect(r.stderr).toMatch(/search index was not used \(this server keeps no search index\)/);
    expect(r.stderr).toMatch(/nothing is missed/);

    const exact = await cli("search", "Harbour", "--case-sensitive", "--dir", dir);
    expect(exact.out).toEqual(["Notes/a.md:2:5: the Harbour at dawn"]);

    const inFolder = await cli("search", "harbour", "--folder", "Notes", "--dir", dir);
    expect(inFolder.out).toEqual(["Notes/a.md:2:5: the Harbour at dawn"]);

    const context = await cli("search", "harbour", "--context", "1", "--dir", dir);
    // The line after a note's last newline is a line, and empty.
    expect(context.out).toEqual([
      "Notes/a.md-1- first line",
      "Notes/a.md:2:5: the Harbour at dawn",
      "Notes/a.md-3-",
      "--",
      "c.md:1:1: harbour, harbour",
      "c.md-2-",
      "--",
      "c.md:1:10: harbour, harbour",
      "c.md-2-",
    ]);

    const names = await cli("search", "b.md", "--mode", "filename", "--dir", dir);
    expect(names.code, names.all).toBe(0);
    expect(names.out).toEqual(["Notes/b.md  (the file name matches)"]);

    const none = await cli("search", "lighthouse", "--dir", dir);
    expect(none.code, none.all).toBe(0);
    expect(none.out).toEqual([]);
    expect(none.stderr).toMatch(/^No matches\./);
  }, 60_000);

  it("highlights the match only on a terminal", async () => {
    const dir = await vaultWith({ "a.md": "the Harbour at dawn\n" });
    const tty = await cliWith(true, "search", "harbour", "--dir", dir);
    expect(tty.code, tty.all).toBe(0);
    expect(tty.out).toEqual([
      `${ESC}[35ma.md${ESC}[0m:${ESC}[32m1:5${ESC}[0m: the ${ESC}[1;31mHarbour${ESC}[0m at dawn`,
    ]);
    const pipe = await cliWith(false, "search", "harbour", "--dir", dir);
    expect(pipe.out).toEqual(["a.md:1:5: the Harbour at dawn"]);
    // --json is for scripts, and never coloured.
    const json = await cliWith(true, "search", "harbour", "--dir", dir, "--json");
    expect(json.stdout).not.toContain(ESC);
  }, 60_000);

  it("spells out every control character and escape sequence a note holds", async () => {
    const dir = await vaultWith({ "trap.md": TRAP, [`odd${RLO}name.md`]: "harbour\n" });
    for (const color of [false, true]) {
      const r = await cliWith(color, "search", "harbour", "--dir", dir);
      expect(r.code, r.all).toBe(0);
      expect(r.out).toHaveLength(2);
      // The only escape sequences left are the ones this program wrote to
      // colour the output, on a terminal only.
      const own = r.out.map((l) => l.replaceAll(/\x1b\[(?:0|1;31|35|32)m/g, ""));
      expect(own.flatMap(hostile), r.stdout).toEqual([]);
      expect(r.err.flatMap(hostile), r.stderr).toEqual([]);
      const line = r.out.find((l) => l.includes("trap.md"))!;
      expect(line).toContain("\\u{1b}[2J\\u{1b}]0;owned\\u{7}\\u{1b}[31mred\\u{9b}1m");
      expect(line).toContain("carriage\\u{d}return \\u{202e}desrever \\u{2028}end");
      expect(
        r.out.find((l) => l.includes("name.md")),
        r.stdout,
      ).toContain("odd\\u{202e}name.md");
    }
    // --json carries the text exactly as the note holds it, and still sends
    // the terminal nothing it would act on.
    const json = await cli("search", "harbour", "--dir", dir, "--json");
    expect(json.code, json.all).toBe(0);
    expect(hostile(json.stdout)).toEqual([]);
    const parsed = json.json() as { matches: { path: string; text: string }[] };
    const trap = parsed.matches.find((m) => m.path === "trap.md")!;
    expect(trap.text).toBe(TRAP.split("\n")[1]);
    expect(parsed.matches.some((m) => m.path === `odd${RLO}name.md`)).toBe(true);
  }, 60_000);

  it("pages with --limit, says more follow, continues with --after, and shows them all with --all", async () => {
    const dir = await vaultWith({
      "a.md": "hit\nhit\n",
      "b.md": "hit\n",
      "c.md": "hit hit\n",
    });
    const first = await cli("search", "hit", "--limit", "2", "--dir", dir);
    expect(first.code, first.all).toBe(0);
    expect(first.out).toEqual(["a.md:1:1: hit", "a.md:2:1: hit"]);
    const cursor = /--after (\S+) the next one/.exec(first.stderr)?.[1];
    expect(cursor, first.stderr).toBeDefined();
    expect(first.stderr).toMatch(
      /More matches may follow: this is the first page\. trew search --all/,
    );

    const next = await cli("search", "hit", "--limit", "2", "--after", cursor!, "--dir", dir);
    expect(next.out).toEqual(["b.md:1:1: hit", "c.md:1:1: hit hit"]);

    const all = await cli("search", "hit", "--limit", "2", "--all", "--dir", dir);
    expect(all.code, all.all).toBe(0);
    expect(all.out).toEqual([
      "a.md:1:1: hit",
      "a.md:2:1: hit",
      "b.md:1:1: hit",
      "c.md:1:1: hit hit",
      "c.md:1:5: hit hit",
    ]);
    expect(all.stderr).not.toMatch(/More matches/);

    const json = await cli("search", "hit", "--limit", "2", "--json", "--dir", dir);
    const page = json.json();
    expect(page["complete"]).toBe(false);
    expect(typeof page["nextAfter"]).toBe("string");
    expect((page["matches"] as unknown[]).length).toBe(2);
    const everything = (
      await cli("search", "hit", "--limit", "2", "--all", "--json", "--dir", dir)
    ).json();
    expect(everything).toMatchObject({ ok: true, complete: true, nextAfter: null, pages: 3 });
    expect((everything["matches"] as unknown[]).length).toBe(5);

    // A cursor from another search is refused in words, and exits 1.
    const wrong = await cli("search", "other", "--after", cursor!, "--dir", dir);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/belongs to another search/);
  }, 60_000);

  it("exits 1 and names each note it could not search", async () => {
    // Over the 1 MiB a note is read up to: synced, and not searchable.
    const big = "harbour\n" + "x".repeat(1 << 20);
    const dir = await vaultWith({ "big.md": big, "small.md": "harbour\n" });
    const r = await cli("search", "harbour", "--dir", dir);
    expect(r.code, r.all).toBe(1);
    expect(r.out).toEqual(["small.md:1:1: harbour"]);
    expect(r.stderr).toMatch(
      /1 note could not be searched, so a match may be missing:\n {2}big\.md: note_too_large/,
    );
    const json = await cli("search", "harbour", "--dir", dir, "--json");
    expect(json.code).toBe(1);
    expect(json.json()).toMatchObject({
      ok: false,
      complete: false,
      skipped: [{ path: "big.md", why: "note_too_large" }],
    });
  }, 60_000);

  it("refuses what is not a search before connecting, with exit 2", async () => {
    for (const argv of [
      ["search"],
      ["search", "a", "--limit", "201"],
      ["search", "a", "--mode", "regex"],
      ["search", "a", "--context", "4"],
      ["search", "a", "b"],
      ["history", "a.md", "--mode", "tag"],
      ["deleted", "--all"],
    ]) {
      const r = await cli(...argv, "--dir", tmpdir());
      expect(r.code, `${argv.join(" ")}: ${r.all}`).toBe(2);
    }
  });

  it("says what the server refused about the query", async () => {
    const dir = await vaultWith({ "a.md": "text\n" });
    const tag = await cli("search", "not a tag!", "--mode", "tag", "--dir", dir);
    expect(tag.code).toBe(1);
    expect(tag.stderr).toMatch(/^trew: invalid_tag: /);
    const folder = await cli("search", "text", "--folder", ".hidden", "--dir", dir);
    expect(folder.code).toBe(1);
    expect(folder.stderr).toMatch(/dotprefix/);
  }, 60_000);

  it("uses the index every server keeps, without -mcp, and finds the same", async () => {
    const dir = await vaultWith({
      "a.md": "the lighthouse\n",
      "b.md": "nothing\n",
      "c.md": "LIGHTHOUSE keeper\n",
    });
    let r = await cli("search", "lighthouse", "--dir", dir, "--json");
    for (let i = 0; i < 200 && !(r.json()["index"] as { usable: boolean }).usable; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      r = await cli("search", "lighthouse", "--dir", dir, "--json");
    }
    expect(r.json()).toMatchObject({ ok: true, complete: true, index: { usable: true } });
    const human = await cli("search", "lighthouse", "--dir", dir);
    expect(human.out).toEqual(["a.md:1:5: the lighthouse", "c.md:1:1: LIGHTHOUSE keeper"]);
    expect(human.stderr).not.toMatch(/index was not used/);
  }, 60_000);
});

describe("the terminal", () => {
  it("spells out controls, keeps tabs and ordinary text", () => {
    expect(printable(`a\tb${ESC}[0m${BEL}\r\n${CSI}${RLO}\u00e9`)).toBe(
      "a\tb\\u{1b}[0m\\u{7}\\u{d}\\u{a}\\u{9b}\\u{202e}" + String.fromCodePoint(0xe9),
    );
  });

  /**
   * T20. The door every printed line goes through: everything a terminal acts
   * on is spelled out, newlines included, and only this program's own colour
   * sequences go through, and only when colour was asked for.
   */
  it("lets this program's colours through on the way out, and nothing else (T20)", () => {
    const ours = `${STYLE.match}needle${STYLE.reset}`;
    const theirs = `${ESC}]0;title${BEL}${CSI}2J${RLO}\n`;
    expect(forTerminal(ours + theirs, true)).toBe(
      ours + "\\u{1b}]0;title\\u{7}\\u{9b}2J\\u{202e}\\u{a}",
    );
    // No colour asked for: the colour sequences are spelled out as well.
    expect(forTerminal(ours, false)).toBe("\\u{1b}[1;31mneedle\\u{1b}[0m");
    // A sequence that only looks like ours is not ours.
    expect(forTerminal(`${ESC}[1;32m`, true)).toBe("\\u{1b}[1;32m");
    // And it is safe to apply twice, since what it writes is plain text.
    for (const style of [true, false]) {
      const once = forTerminal(ours + theirs + "\ta", style);
      expect(forTerminal(once, style)).toBe(once);
    }
  });

  it("escapes C1 controls and bidirectional marks in JSON, which still parses to the same", () => {
    const value = { text: `${CSI}${RLO}${LSEP}${ESC}` };
    const s = safeJson(value);
    expect(hostile(s)).toEqual([]);
    expect(JSON.parse(s)).toEqual(value);
  });

  it("places the match in a line cut 256 units before it, and one cut inside a surrogate pair", () => {
    const pad = "x".repeat(300);
    const m = {
      path: "a.md",
      uid: 1,
      line: 1,
      column: 301,
      text: pad.slice(44) + "Needle after",
      before: [],
      after: [],
      clipped: true,
    };
    expect(matchSpan(m, "needle", "content")).toEqual({ start: 256, end: 262 });
    const face = String.fromCodePoint(0x1f600);
    const shifted = { ...m, text: pad.slice(45) + "Needle after" };
    expect(matchSpan(shifted, "needle", "content")).toEqual({ start: 255, end: 261 });
    expect(matchSpan({ ...m, column: 3, text: `${face}Needle` }, "needle", "content")).toEqual({
      start: 2,
      end: 8,
    });
    expect(matchLine(m, "needle", "content", false)).toBe(`a.md:1:301: \u2026${m.text}`);
  });
});
