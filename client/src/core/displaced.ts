/**
 * A record of every version this client took off a name and could not put back.
 *
 * Preservation moves the bytes aside before it writes, and sometimes there is
 * nowhere to put them: the conflict name is taken, the directory is not
 * writable, the disk filled up. The bytes survive, under a name nothing lists.
 * That is safe and it is useless on its own, because a note nobody can find is
 * not much better than a deleted one (R46).
 *
 * The headless client used to answer this by walking the vault and recognising
 * parked names. That works and it is not enough:
 *
 *   - It can say a file is there and not what it is. Somebody looking at
 *     `note.md..trew-tmp-keep3f9c` has to guess which note it came off and
 *     why it is not at its name.
 *   - The plugin cannot do it at all in the place it matters. Its displaced
 *     versions go into a hidden folder, and it never implemented the walk, so
 *     the Obsidian client -- which is the product -- reported nothing.
 *   - It is rediscovery rather than a record. The bytes survive a restart; the
 *     knowledge of what happened to them did not.
 *
 * So the fact is written down when it happens, and the scan reconciles against
 * it rather than replacing it. Both shells write the same records and both
 * read them, so "what is waiting" has one answer.
 *
 * The shape is `JournalFiles`: a small interface the shell implements and
 * everything hard above it. Append-only lines, because that is the only shape
 * that is one implementation on both a Node filesystem and Obsidian's adapter,
 * and because a record of a note that could not be saved is a poor thing to
 * lose to a partial write.
 */

/** One version that is somewhere nothing lists. */
export interface Displaced {
  /** Where the bytes are now, as a vault-relative path. */
  readonly at: string;
  /** The note they came off, as a vault-relative path. */
  readonly from: string;
  /** Why they are not at that name, in a sentence a person can read. */
  readonly why: string;
  /** Milliseconds since the epoch. */
  readonly when: number;
}

/**
 * What a shell must provide. Deliberately small: everything hard is above it.
 *
 * `append` must place bytes at the end and nowhere else. `stillThere` answers
 * about the disk rather than about the log, because the log is a record of
 * what happened and the disk is the question being asked (rule 4).
 */
export interface DisplacedFiles {
  read(): Promise<string | undefined>;
  append(line: string): Promise<void>;
  /**
   * Replaces the whole log, and **only** where the shell can do it without a
   * moment in which neither the old text nor the new one is on the disk.
   *
   * Optional, and a shell that cannot leaves it out rather than doing its best
   * (RR3). The plugin's `DataAdapter.write` truncates in place, so a short
   * write left a log holding `{"at":".` and an inventory of nothing, with the
   * hidden notes those records named still sitting there. That is the same
   * objection to using `Vault.process()` without a verified backup when replacing
   * notes, and it applies at least as much to the record of where the notes
   * went: it is the only thing that knows.
   *
   * Without it the log grows. Each record is a couple of hundred bytes and one
   * is written per version that could not be placed, which is a rare event by
   * construction, so an unbounded count of a rare thing is the cheaper end of
   * this trade.
   */
  rewrite?(text: string): Promise<void>;
  /** Whether something is still at this vault-relative path. */
  stillThere(at: string): Promise<boolean>;
}

/**
 * What is waiting, and whether that is the whole of it.
 *
 * Two fields rather than one list, because "nothing is waiting" and "this
 * could not be established" are different answers, and reporting the second as
 * the first is a clean vault with somebody's note in a hidden folder (RR2,
 * rule 2). Everything that renders this has to say which one it got.
 */
export interface Inventory {
  readonly waiting: readonly Displaced[];
  /** False when something is known to be missing from `waiting`. */
  readonly complete: boolean;
  /** Why it is incomplete, for the person who has to go and look. */
  readonly why?: string;
}

/**
 * When the log has enough dead records to be worth rewriting.
 *
 * A vault that strands one version a year would otherwise carry every resolved
 * record for ever. Rewriting is a whole-file write and the log is tiny, so the
 * only reason not to do it on every read is that a read happens on every scan.
 */
const COMPACT_AT = 32;

export class DisplacedLedger {
  private readonly files: DisplacedFiles;
  private readonly say: (message: string) => void;

  constructor(files: DisplacedFiles, log: (message: string) => void = () => undefined) {
    this.files = files;
    this.say = log;
  }

  /**
   * Whether anything is known to be missing from this log.
   *
   * Sticky for the life of the object. A failed append is a note this process
   * put somewhere and cannot name afterwards, and no later scan can rediscover
   * that fact: the only honest thing left is to stop claiming the inventory is
   * the whole of it.
   */
  private missing: string | undefined;

  /**
   * Writes down that a version is somewhere nothing lists, and says whether it
   * managed to.
   *
   * Never throws, and the return value is the point (RR2). A caller about to
   * hide a note must not hide it when this fails, because the record is the
   * only thing that will know where it went. A caller writing this down
   * *after* something has already gone wrong cannot un-fail it, and takes the
   * false answer with the incompleteness noted instead.
   */
  async record(d: Displaced): Promise<boolean> {
    const line = JSON.stringify(d);
    try {
      // A newline in front as well as behind (RR6).
      //
      // An append that was cut short leaves a line with no newline on the end,
      // and the next record written after it lands on that same line: one
      // malformed object made of two halves, which parses as neither. The
      // append reported success, so a caller that had been told to hide a note
      // only if its record was written hid it against a record nobody can
      // read. Leading with a newline puts every record on a line of its own
      // whatever came before, so the damaged fragment stays damaged and alone
      // and this one is readable beside it. Empty lines are skipped on read,
      // so the cost is one byte at the top of the file.
      await this.files.append(`\n${line}\n`);
    } catch (err) {
      this.say(`could not write down that ${d.at} is waiting: ${(err as Error).message}`);
      this.missing = `${d.from} was displaced to ${d.at} and could not be written down`;
      return false;
    }

    // And then check that it can be read, rather than that the write returned
    // (rule 4). This is the one place in the client where the answer is used
    // as permission to hide somebody's note, so "the call did not throw" is
    // not a strong enough thing to know: a short write that still returns, a
    // filesystem that reordered, an adapter whose append went somewhere else.
    // Reading the whole log back costs one read on a path taken only when a
    // version could not be placed, which is rare by construction.
    if (!(await this.readableNow(line))) {
      this.say(`wrote down that ${d.at} is waiting and could not read it back`);
      this.missing = `${d.from} was displaced to ${d.at} and the record cannot be read back`;
      return false;
    }
    return true;
  }

  /** Whether the log now contains this exact record, as a line of its own. */
  private async readableNow(line: string): Promise<boolean> {
    try {
      const text = await this.files.read();
      if (text === undefined) return false;
      return text.split("\n").some((l) => l.trim() === line);
    } catch {
      // Unreadable now is unreadable later, and later is when somebody is
      // looking for their note.
      return false;
    }
  }

  /**
   * What is really waiting, reconciled against the disk.
   *
   * A record whose file is gone is dropped: somebody moved it back, or renamed
   * it, or decided they did not want it, and none of those need reporting for
   * ever. Dropping it is the only way this list ever gets shorter, because
   * there is no moment at which anything else can say a person is finished
   * with a preserved note.
   *
   * Order is oldest first, and duplicates by path are collapsed to the newest
   * record: the same name can be displaced twice, and the second time is the
   * one that describes the bytes now there.
   *
   * `tidy` is false for a caller that is only asking. `status` takes no lock
   * and may run beside a watcher, so its scan reaps nothing and re-spells
   * nothing (R12); rewriting this log would have been the one write it still
   * made, and a question is not a reason to change anything. The answer is the
   * same either way: what is dropped from the answer is dropped whether or not
   * the file is rewritten.
   */
  async waiting(tidy = true): Promise<readonly Displaced[]> {
    return (await this.inventory(tidy)).waiting;
  }

  /**
   * The same, with whether it can be trusted to be the whole of it.
   *
   * Everything that reports to a person should ask for this one. The
   * difference between the two answers is a vault that looks clean and is not
   * (RR2), and a caller handed a bare array has no way to tell.
   */
  async inventory(tidy = true): Promise<Inventory> {
    const read = await this.parse();
    const newest = new Map<string, Displaced>();
    for (const d of read.records) newest.set(d.at, d);

    const live: Displaced[] = [];
    let dead = 0;
    for (const d of newest.values()) {
      if (await this.files.stillThere(d.at).catch(() => true)) live.push(d);
      else dead++;
    }
    // Counted against the whole log rather than against the live records: a
    // log of a thousand resolved entries and one live one is what this is for.
    if (
      tidy &&
      (read.records.length - live.length >= COMPACT_AT || (dead > 0 && live.length === 0))
    ) {
      await this.compact(live);
    }
    live.sort((a, b) => a.when - b.when);
    const why = read.why ?? this.missing;
    return why === undefined
      ? { waiting: live, complete: true }
      : { waiting: live, complete: false, why };
  }

  private async compact(live: readonly Displaced[]): Promise<void> {
    const rewrite = this.files.rewrite?.bind(this.files);
    // A shell that cannot replace the log safely does not replace it (RR3).
    if (rewrite === undefined) return;
    try {
      await rewrite(live.map((d) => `${JSON.stringify(d)}\n`).join(""));
    } catch (err) {
      // The log keeps its dead records, which costs a longer file and nothing
      // else: `waiting` filters them every time. True only because `rewrite`
      // is all-or-nothing where it exists at all.
      this.say(`could not tidy the displaced-version log: ${(err as Error).message}`);
    }
  }

  private async parse(): Promise<{ records: Displaced[]; why?: string }> {
    let text: string | undefined;
    try {
      text = await this.files.read();
    } catch (err) {
      // Rule 2: unreadable is not empty. Returning an empty list here reported
      // a clean vault to somebody whose note was in a hidden folder, which is
      // this module's own failure mode arriving through this module (RR2). The
      // emptiness now travels with the reason attached, and everything that
      // renders it has to say which answer it got.
      const why = `the record of displaced versions could not be read (${(err as Error).message})`;
      this.say(why);
      return { records: [], why };
    }
    if (text === undefined || text.length === 0) return { records: [] };
    const out: Displaced[] = [];
    let torn: string | undefined;
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const d = parseLine(line);
      if (d !== undefined) out.push(d);
      // A torn last line is what a crash mid-append leaves, and the records
      // before it are good. Skipped rather than thrown on, and counted rather
      // than passed over in silence: a line that cannot be read named
      // something, and whatever it named is not in the list beside it.
      else torn = "the record of displaced versions has a line that cannot be read";
    }
    return torn === undefined ? { records: out } : { records: out, why: torn };
  }
}

function parseLine(line: string): Displaced | undefined {
  try {
    const raw = JSON.parse(line) as Partial<Displaced>;
    if (typeof raw.at !== "string" || raw.at.length === 0) return undefined;
    return {
      at: raw.at,
      from: typeof raw.from === "string" ? raw.from : "an unknown note",
      why: typeof raw.why === "string" ? raw.why : "it could not be placed",
      when: typeof raw.when === "number" ? raw.when : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * The name both shells give this log.
 *
 * One name rather than two, because somebody looking for it after a crash
 * should not have to know which client wrote it, and because a support answer
 * that says "look in `.trew`" is worth more than one that says "it depends".
 */
export const DISPLACED_LOG = "displaced.log";
