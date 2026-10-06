/**
 * The record of versions this client could not put back.
 *
 * The bytes always survived. What did not was the knowledge: a scan could see
 * a parked file and had no way to say which note it came off or why, and the
 * plugin could not see it at all because its displaced versions go into a
 * hidden folder Obsidian does not list (R46).
 *
 * So the properties here are about the record surviving what the note survived:
 * a restart, a torn write, an unreadable log, and a person putting the version
 * back by hand.
 */

import { describe, expect, it } from "vitest";

import { DisplacedLedger, type Displaced, type DisplacedFiles } from "./displaced.ts";

/** A log in memory, with the disk it describes beside it. */
class Files implements DisplacedFiles {
  text: string | undefined;
  readonly onDisk = new Set<string>();
  /** Set to make every read fail, which is not the same as an empty log. */
  unreadable = false;
  rewrites = 0;

  async read(): Promise<string | undefined> {
    if (this.unreadable) throw new Error("the log cannot be read");
    return this.text;
  }
  async append(line: string): Promise<void> {
    this.text = (this.text ?? "") + line;
  }
  async rewrite(text: string): Promise<void> {
    this.rewrites++;
    this.text = text;
  }
  async stillThere(at: string): Promise<boolean> {
    return this.onDisk.has(at);
  }
}

const record = (at: string, from = "note.md"): Displaced => ({
  at,
  from,
  why: "the conflict name was taken",
  when: 1,
});

describe("the displaced-version ledger", () => {
  it("says what is waiting, and what it came off", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    const ledger = new DisplacedLedger(files);
    await ledger.record(record("note.md..keep1", "Daily/2026-09-07.md"));

    const waiting = await ledger.waiting();
    expect(waiting).toHaveLength(1);
    // The whole reason this exists rather than a walk: a path is not an
    // explanation, and `note.md..keep1` on its own sends somebody opening
    // files to find out which note it is.
    expect(waiting[0]!.from).toBe("Daily/2026-09-07.md");
    expect(waiting[0]!.why).toContain("conflict name");
  });

  it("survives a restart, because the record is on the disk and not in the object", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    await new DisplacedLedger(files).record(record("note.md..keep1"));

    // A different object over the same files, which is what the next `trew
    // sync` is. Nothing is carried over in memory.
    const afterRestart = await new DisplacedLedger(files).waiting();
    expect(afterRestart.map((d) => d.at)).toEqual(["note.md..keep1"]);
  });

  it("forgets a version once somebody has put it somewhere", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    const ledger = new DisplacedLedger(files);
    await ledger.record(record("note.md..keep1"));
    expect(await ledger.waiting()).toHaveLength(1);

    // Renamed, moved back, deleted: whichever it was, the file is not there
    // and there is nothing left to report. This is the only way the list ever
    // gets shorter, because nothing else can say a person has finished.
    files.onDisk.delete("note.md..keep1");
    expect(await ledger.waiting()).toEqual([]);
  });

  it("describes the version that is there now, when one name is displaced twice", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    const ledger = new DisplacedLedger(files);
    await ledger.record({ ...record("note.md..keep1"), why: "the first reason", when: 1 });
    await ledger.record({ ...record("note.md..keep1"), why: "the second reason", when: 2 });

    const waiting = await ledger.waiting();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.why).toBe("the second reason");
  });

  it("keeps the records before a torn last line", async () => {
    // What a crash mid-append leaves. The records before it name notes and
    // are good; throwing over the broken one would lose all of them, which is
    // the failure this module exists to prevent, arriving through its own log.
    const files = new Files();
    files.onDisk.add("a..keep");
    files.onDisk.add("b..keep");
    files.text =
      `${JSON.stringify(record("a..keep", "a.md"))}\n` +
      `${JSON.stringify(record("b..keep", "b.md"))}\n` +
      `{"at":"c..keep","fro`;

    const waiting = await new DisplacedLedger(files).waiting();
    expect(waiting.map((d) => d.at)).toEqual(["a..keep", "b..keep"]);
  });

  it("reports an unreadable log as unknown, not as nothing waiting", async () => {
    // Rule 2, and RR2. An empty list because the log could not be opened reads
    // exactly like a clean vault, and for the plugin the log is the only
    // source there is, so that empty list was the whole answer. It now travels
    // with the reason attached and callers have to render one or the other.
    const files = new Files();
    files.unreadable = true;
    const said: string[] = [];
    const out = await new DisplacedLedger(files, (m) => said.push(m)).inventory();

    expect(out.waiting).toEqual([]);
    expect(out.complete, "an unreadable log was reported as a complete inventory").toBe(false);
    expect(out.why).toContain("could not be read");
    expect(said.join(" ")).toContain("could not be read");
  });

  it("reports a torn line as unknown, because it named something", async () => {
    const files = new Files();
    files.onDisk.add("a..keep");
    files.text = `${JSON.stringify(record("a..keep", "a.md"))}\n{"at":"b..keep","fro`;
    const out = await new DisplacedLedger(files).inventory();

    expect(out.waiting.map((d) => d.at)).toEqual(["a..keep"]);
    // The records before the tear are good and are reported. The tear is not
    // nothing: whatever that line named is not in the list beside it.
    expect(out.complete).toBe(false);
  });

  it("says it failed to record, and stays incomplete afterwards", async () => {
    // The return value is what a caller about to hide a note checks (RR2): the
    // record is the only thing that will know where the note went, so a caller
    // that cannot write one must not hide it. And the failure is sticky,
    // because no later scan can rediscover a note this process hid and never
    // named.
    const files = new Files();
    files.append = async () => {
      throw new Error("the disk is full");
    };
    const said: string[] = [];
    const ledger = new DisplacedLedger(files, (m) => said.push(m));

    await expect(ledger.record(record("note.md..keep1"))).resolves.toBe(false);
    expect(said.join(" ")).toContain("could not write down");

    // Even once the disk comes back, this process cannot claim to know.
    files.append = async (line) => {
      files.text = (files.text ?? "") + line;
    };
    const out = await ledger.inventory();
    expect(out.complete, "a failed record left the inventory claiming to be whole").toBe(false);
    expect(out.why).toContain("could not be written down");
  });

  it("does not throw out of the failure path it is called from", async () => {
    // `record` is also called after something has already gone wrong with
    // somebody's note. A bookkeeping error replacing that error would hide
    // what actually happened to it.
    const files = new Files();
    files.append = async () => {
      throw new Error("the disk is full");
    };
    await expect(new DisplacedLedger(files).record(record("note.md..keep1"))).resolves.toBe(false);
  });

  it("does not compact when the shell cannot replace the log safely", async () => {
    // RR3. The plugin writes in place, so a short compaction leaves a log
    // holding half a record and an inventory of nothing, while the notes those
    // records named are still hidden. A shell that cannot replace the whole
    // file or none of it does not offer `rewrite`, and then nothing compacts.
    // A shell that does not offer it at all, which is how the plugin declares
    // that it cannot do this safely.
    const files = new Files();
    const cannotRewrite: DisplacedFiles = {
      read: () => files.read(),
      append: (line) => files.append(line),
      stillThere: (at) => files.stillThere(at),
    };
    const ledger = new DisplacedLedger(cannotRewrite);
    for (let i = 0; i < 40; i++) await ledger.record(record(`gone-${i}..keep`));
    files.onDisk.add("here..keep");
    await ledger.record(record("here..keep"));

    expect((await ledger.inventory()).waiting.map((d) => d.at)).toEqual(["here..keep"]);
    expect(files.rewrites, "the log was rewritten by a shell that cannot do it safely").toBe(0);
    // The log keeps every record and the answer is filtered on read, which is
    // the trade: an unbounded count of a rare event, against losing the lot.
    // Blank lines are the framing that stops a torn tail swallowing the record
    // after it (RR6), and are skipped on read.
    expect(files.text!.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(41);
  });

  it("tidies the log rather than growing it for ever", async () => {
    const files = new Files();
    const ledger = new DisplacedLedger(files);
    // Forty displaced and then resolved, which is a vault somebody has been
    // using for years rather than an unusual one.
    for (let i = 0; i < 40; i++) await ledger.record(record(`gone-${i}..keep`));
    files.onDisk.add("here..keep");
    await ledger.record(record("here..keep"));

    expect(await ledger.waiting()).toHaveLength(1);
    expect(files.rewrites, "the log was never tidied").toBeGreaterThan(0);
    expect(files.text!.trim().split("\n")).toHaveLength(1);
  });

  it("keeps a line it cannot read through a tidy, so the next inventory is not whole either", async () => {
    // T08. The tidy wrote back the live records only, so the torn line went
    // with the dead ones and the next inventory called itself complete, the
    // one before it having said it was not, with nothing resolved between.
    const files = new Files();
    for (let i = 0; i < 40; i++) {
      files.text = `${files.text ?? ""}\n${JSON.stringify(record(`gone-${i}..keep`))}\n`;
    }
    files.onDisk.add("here..keep");
    files.text += `\n${JSON.stringify(record("here..keep"))}\n`;
    files.text += `\n{"at":"hidden..keep","fro`;
    const ledger = new DisplacedLedger(files);

    const first = await ledger.inventory();
    expect(first.complete).toBe(false);
    expect(files.rewrites, "the log was never tidied").toBeGreaterThan(0);
    const second = await ledger.inventory();
    expect(second.complete, "a tidy erased the line that cannot be read").toBe(false);
    expect(second.waiting.map((d) => d.at)).toEqual(["here..keep"]);
  });

  /**
   * T11. In the plugin every incoming deletion writes a record, and the log
   * could not be tidied there at all, so a phone read it back and looked on
   * the disk for every deletion it had ever applied, on every pass.
   */
  describe("for a shell that can only empty the log", () => {
    function emptyOnly(files: Files): { files: DisplacedFiles; cleared: string[] } {
      const cleared: string[] = [];
      return {
        cleared,
        files: {
          read: () => files.read(),
          append: (line) => files.append(line),
          stillThere: (at) => files.stillThere(at),
          clear: async (was) => {
            if (files.text !== was) return false;
            cleared.push(was);
            files.text = "";
            return true;
          },
        },
      };
    }

    it("empties it once every record in it is dead, and not before", async () => {
      const files = new Files();
      const shell = emptyOnly(files);
      const ledger = new DisplacedLedger(shell.files);
      await ledger.record(record("a..keep"));
      files.onDisk.add("b..keep");
      await ledger.record(record("b..keep"));

      expect((await ledger.waiting()).map((d) => d.at)).toEqual(["b..keep"]);
      expect(shell.cleared, "emptied while a record was live").toEqual([]);

      files.onDisk.delete("b..keep");
      expect(await ledger.waiting()).toEqual([]);
      expect(shell.cleared).toHaveLength(1);
      expect(files.text).toBe("");
    });

    it("does not empty a log with a line it cannot read", async () => {
      const files = new Files();
      const shell = emptyOnly(files);
      files.text = `\n${JSON.stringify(record("gone..keep"))}\n\n{"at":"hid`;
      const out = await new DisplacedLedger(shell.files).inventory();
      expect(out.complete).toBe(false);
      expect(shell.cleared).toEqual([]);
    });

    it("does not empty it of a record younger than a minute, whose note may be on its way", async () => {
      // The record is written before the note is moved (RR2): for a moment
      // it names a file that is not there yet, and emptying the log in that
      // moment hid the note with nothing knowing where.
      const files = new Files();
      const shell = emptyOnly(files);
      let now = 1_000_000;
      const ledger = new DisplacedLedger(shell.files, undefined, () => now);
      await ledger.record({ ...record("moving..keep"), when: now });

      expect(await ledger.waiting()).toEqual([]);
      expect(shell.cleared, "the record of a note on its way was emptied away").toEqual([]);
      files.onDisk.add("moving..keep");
      expect((await ledger.waiting()).map((d) => d.at)).toEqual(["moving..keep"]);

      files.onDisk.delete("moving..keep");
      now += 61_000;
      expect(await ledger.waiting()).toEqual([]);
      expect(shell.cleared).toHaveLength(1);
    });
  });

  it("looks on the disk once for a record it has seen gone, and every time for the rest", async () => {
    const files = new Files();
    const looked: string[] = [];
    const cannotTidy: DisplacedFiles = {
      read: () => files.read(),
      append: (line) => files.append(line),
      stillThere: async (at) => {
        looked.push(at);
        if (at === "unsure..keep") throw new Error("EIO");
        return files.stillThere(at);
      },
    };
    const ledger = new DisplacedLedger(cannotTidy);
    for (let i = 0; i < 10; i++) await ledger.record(record(`gone-${i}..keep`));
    files.onDisk.add("here..keep");
    await ledger.record(record("here..keep"));
    await ledger.record(record("unsure..keep"));

    const first = await ledger.waiting();
    expect(looked).toHaveLength(12);
    looked.length = 0;
    const second = await ledger.waiting();
    // The live one and the one that could not be checked, which counts as
    // there and is asked about again.
    expect(looked.sort()).toEqual(["here..keep", "unsure..keep"]);
    expect(second.map((d) => d.at).sort()).toEqual(first.map((d) => d.at).sort());
    expect(second.map((d) => d.at).sort()).toEqual(["here..keep", "unsure..keep"]);

    // A record written again at a name seen gone is a new record, and looked for.
    files.onDisk.add("gone-3..keep");
    await ledger.record({ ...record("gone-3..keep"), when: 2 });
    expect((await ledger.waiting()).map((d) => d.at)).toContain("gone-3..keep");
  });
});
