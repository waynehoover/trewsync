/**
 * Fault injection across every seam, rather than one ordering per test.
 *
 * The seven verification rounds found the same defect four times in the lock
 * and about ten times across the preservation paths, and the reason fits in one
 * sentence: fixing one ordering and testing that ordering has repeatedly left
 * another ordering broken.
 *
 * Each of those fixes came with a regression test, and each test named one
 * hook. The hook next to it got nothing. So this does not take a scenario and
 * an ordering; it takes a scenario and runs it against *every* registered
 * seam, with a competing writer firing inside each one in turn. New seam,
 * every existing scenario runs through it, without anybody remembering to.
 *
 * What it checks is not "the outcome is the one this test expected". It is
 * rule 1, stated so a machine can check it: a version somebody wrote is still
 * somewhere, and somewhere anybody can find. Both halves matter. A note parked
 * under a name no listing shows and no status mentions is not much better than
 * a deleted one (R46, R50), so "present on the disk" is only half a pass.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { releaseAllSeams, seams, type Seam } from "../core/seam.ts";
import type { ExpectedContent, Replaced } from "../core/vault.ts";
import { NodeVault } from "../cli/vault.ts";
import { removeTree } from "../core/test-server.ts";

const enc = new TextEncoder();

/** The vault a permutation runs against, fresh for each one. */
export interface Ground {
  readonly dir: string;
  readonly vault: NodeVault;
  /**
   * Writes a note the way an editor does, outside the sync engine entirely.
   *
   * Outside on purpose. The competitor in every one of these defects was a
   * person's editor, which has never heard of this vault object, and routing
   * it through the adapter would be testing the adapter against itself.
   *
   * Through a temporary and a rename, which is how an editor that does not
   * want to lose your work on a full disk saves, Obsidian included. It is also
   * the harder case for this client: the inode changes, so anything deciding
   * "is this still the file I looked at" by identity sees a different file,
   * and anything deciding by name sees the same one.
   */
  save(path: string, body: string): Promise<void>;
  /**
   * Writes it the other way, in place, keeping the inode.
   *
   * The two are genuinely different competitors and the client answers them
   * differently, so a scenario that means one should not get the other by
   * accident.
   */
  saveInPlace(path: string, body: string): Promise<void>;
  /**
   * Somewhere for a scenario to carry what its setup learned into its run.
   *
   * Fresh for every permutation, because a permutation that inherited the one
   * before it would be testing a vault nobody built. Used by the scenarios
   * that need a *stale* observation: `retireName` takes the identity of the
   * file its caller looked at, and half its behaviour is only reachable when
   * what is at the name is no longer that file.
   */
  readonly state: Record<string, unknown>;
}

export interface Scenario {
  readonly name: string;
  /** The state the operation is decided against. */
  setup(g: Ground): Promise<void>;
  /** The operation under test. Throwing is a legitimate outcome, and recorded. */
  run(g: Ground): Promise<Replaced | void>;
  /**
   * What the competitor does inside the seam, writing `token` into the vault.
   *
   * Whatever it writes must survive, wherever it ends up. That is the whole
   * assertion, and it is the same one at every seam.
   */
  interfere(g: Ground, token: string): Promise<void>;
  /**
   * Whether the competitor saves over the note's own content.
   *
   * The rule this checks is that *this client* does not destroy a version.
   * A person saving over their own note destroys the previous one, and that is
   * their business. The crash sweep asks after both versions, so it has to
   * know which scenarios have a competitor that supersedes rather than
   * collides; the first draft did not, and reported the person's own
   * overwrite as a lost note.
   */
  readonly supersedes?: boolean;
}

/** One scenario at one seam, and what came of it. */
export interface Outcome {
  readonly scenario: string;
  readonly seam: string;
  /** Empty when the permutation held. Each entry is a sentence about a loss. */
  readonly faults: string[];
  /** Whether the operation refused. Refusing is safe; it is not a fault. */
  readonly refused: string | undefined;
  /** Whether the competitor actually got to run. A seam not reached proves nothing. */
  readonly fired: boolean;
}

/** Content ids, for an adapter that is being called without the engine. */
export const contentIds: Pick<ExpectedContent, "idOf">["idOf"] = async (bytes) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Buffer.from(digest).toString("hex");
};

export async function expecting(body: string): Promise<ExpectedContent> {
  return { contentId: await contentIds(enc.encode(body)), idOf: contentIds };
}

/**
 * Every file in the vault, including the places a version is parked.
 *
 * `.trew` and `.trash` are walked, unlike the harness's `fingerprint`, and
 * that is the point: the whole question is whether a displaced version reached
 * one of them.
 */
async function everything(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (at: string): Promise<void> => {
    let items;
    try {
      items = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(at, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) {
        try {
          out.set(relative(dir, full), await readFile(full, "utf8"));
        } catch {
          // Unreadable is not absent, but for this purpose it is not findable
          // either: it goes in as a path holding nothing a person can read.
          out.set(relative(dir, full), "");
        }
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * Runs one scenario at one seam and says what it cost.
 *
 * The vault is fresh, because a permutation that inherited the wreckage of the
 * one before it would report the earlier fault again at every later seam and
 * bury the seam that actually broke.
 */
export async function permute(scenario: Scenario, it: Seam): Promise<Outcome> {
  const dir = await mkdtemp(join(tmpdir(), "trew-faults-"));
  const faults: string[] = [];
  let refused: string | undefined;
  let fired = false;
  const token = `interloper-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const vault = new NodeVault(dir);
    const g: Ground = {
      dir,
      vault,
      save: async (path, body) => {
        const full = join(dir, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(`${full}.editor-swap`, body);
        await rename(`${full}.editor-swap`, full);
      },
      saveInPlace: async (path, body) => {
        const full = join(dir, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, body);
      },
      state: {},
    };
    await scenario.setup(g);

    // Once. A seam inside a retry loop would otherwise have the competitor
    // write on every turn, and what is being tested is one interleaving.
    let done = false;
    const release = it.hold(async () => {
      if (done) return;
      done = true;
      fired = true;
      await scenario.interfere(g, token);
    });

    let result: Replaced | void = undefined;
    try {
      result = await scenario.run(g);
    } catch (err) {
      refused = (err as Error).message;
    } finally {
      release();
    }

    if (!fired) return { scenario: scenario.name, seam: it.name, faults, refused, fired };

    // Half one: is it still here at all? This is rule 1, and nothing below
    // matters if this fails.
    const tree = await everything(dir);
    const holding = [...tree].filter(([, body]) => body.includes(token)).map(([at]) => at);
    if (holding.length === 0) {
      faults.push(`the version written at this seam is gone from the vault entirely`);
      return { scenario: scenario.name, seam: it.name, faults, refused, fired };
    }

    // Half two: can anybody find it? A scan is what refreshes `stranded`, and
    // it is what `status` does, so this asks the same question a person does.
    await vault.list().catch(() => undefined);
    const reported = new Set<string>(vault.stranded);
    const kept = (result as Replaced | undefined)?.keptAt;
    if (kept !== undefined) reported.add(kept);

    const findable = holding.some((at) => {
      // At a name a listing shows: the note's own path, or a conflict copy.
      // Anything under `.trew` is this client's own bookkeeping and is only
      // findable if something says where it is.
      if (!at.startsWith(".trew/") && !isParked(at)) return true;
      return reported.has(at);
    });
    if (!findable) {
      faults.push(
        `the version written at this seam is at ${holding.join(", ")}, which no listing ` +
          `shows and nothing reports (stranded: ${[...reported].join(", ") || "nothing"})`,
      );
    }
  } finally {
    releaseAllSeams();
    await removeTree(dir).catch(() => undefined);
  }
  return { scenario: scenario.name, seam: it.name, faults, refused, fired };
}

/** Whether a path is one of the marks preservation parks a version under. */
function isParked(at: string): boolean {
  return at.includes(".trew-tmp-");
}

/**
 * One scenario against every seam there is.
 *
 * Returns every outcome rather than throwing on the first, because the useful
 * report is "these three seams lose it" rather than "the first one does".
 */
export async function sweep(scenario: Scenario): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const it of seams()) out.push(await permute(scenario, it));
  return out;
}

/** The failures in a sweep, as something an assertion can print. */
export function losses(outcomes: readonly Outcome[]): string[] {
  return outcomes
    .filter((o) => o.faults.length > 0)
    .map((o) => `${o.scenario} at ${o.seam}: ${o.faults.join("; ")}`);
}

/**
 * The same sweep, with the process dying inside the seam instead of pausing.
 *
 * A paused seam exercises the ordering; it never exercises the second half of
 * an operation simply not happening. Every repair in this client that lives in
 * a `finally` is skipped by a SIGKILL, and no test had ever skipped one.
 *
 * What is checked afterwards is checked by a *new* vault object on the same
 * directory, because that is what the next `trew sync` is: the question is
 * not what the dead process knew but what its successor can find.
 */
export async function crashSweep(scenario: Scenario, seamName: string): Promise<Outcome> {
  const dir = await mkdtemp(join(tmpdir(), "trew-crash-"));
  // Outside the vault, so the vault's own walk never sees it and so a killed
  // child can still leave a mark. See `faults-child.ts`.
  const signals = await mkdtemp(join(tmpdir(), "trew-crash-signal-"));
  const faults: string[] = [];
  const token = `interloper-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const child = spawn(
      process.execPath.includes("bun") ? process.execPath : "bun",
      [
        "run",
        fileURLToPath(new URL("./faults-child.ts", import.meta.url)),
        dir,
        scenario.name,
        seamName,
        token,
        signals,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let complaint = "";
    child.stderr.on("data", (b: Buffer) => (complaint += b.toString()));
    const ended = await new Promise<{ code: number | null; signal: string | null; err?: Error }>(
      (done) => {
        child.on("error", (err) => done({ code: null, signal: null, err }));
        child.on("exit", (code, signal) => done({ code, signal }));
      },
    );
    // A child that could not run is not a passing permutation, and this is the
    // shape a vacuous test takes here: the token never appears, `fired` is
    // false, and the sweep reports nothing wrong for ever. Only two endings
    // are legitimate -- killed by the signal it asked for, or exited zero
    // because the seam was never reached.
    if (ended.err !== undefined) {
      throw new Error(`the crash child could not start: ${ended.err.message}`);
    }
    if (ended.signal !== "SIGKILL" && ended.code !== 0) {
      throw new Error(
        `the crash child failed (code ${ended.code}, signal ${ended.signal}): ` +
          `${complaint.trim() || "it said nothing"}`,
      );
    }

    // From the child's own signals, never from the bytes under test (RR4).
    //
    // This used to ask whether the token was anywhere in the vault, which is
    // the same question the preservation check below asks. A run that lost the
    // version therefore reported "the seam was never reached" and no fault,
    // and the sweep needs only one reached seam per scenario, so a real loss
    // could sit behind a sibling seam that did fire.
    const reached = existsSync(join(signals, "reached"));
    const wrote = existsSync(join(signals, "wrote"));
    if (!reached) {
      return { scenario: scenario.name, seam: seamName, faults, refused: undefined, fired: false };
    }
    if (!wrote) {
      // The seam ran and the competitor's own write did not finish. Nothing
      // was promised to survive, so there is nothing to have lost; it is also
      // not a permutation that tested anything, so it is not counted as one.
      return { scenario: scenario.name, seam: seamName, faults, refused: undefined, fired: false };
    }
    const fired = true;

    // A child that was killed is one whose seam ran to the end. A child that
    // signalled and then exited zero got past its own SIGKILL, which means
    // the seam did not do what this file says it does.
    if (ended.signal !== "SIGKILL") {
      faults.push(
        `the child reached the seam and wrote, then exited with code ${ended.code} instead ` +
          `of dying in it, so nothing about a crash was tested`,
      );
    }

    const tree = await everything(dir);

    const vault = new NodeVault(dir);
    await vault.list().catch(() => undefined);
    const reported = new Set<string>(vault.stranded);

    // Both of them. The competitor's version is the obvious one; the version
    // this device already had is just as unrecoverable if the crash took it,
    // and only the restart sweep can lose that one, because only a crash skips
    // the step that puts it back.
    const wanted: [string, string][] = [["the version written at this seam", token]];
    if (scenario.supersedes !== true) {
      wanted.push(["the version this device already had", "keepsake-mine"]);
    }
    for (const [what, mark] of wanted) {
      const holding = [...tree].filter(([, body]) => body.includes(mark)).map(([at]) => at);
      if (holding.length === 0) {
        faults.push(`${what} is gone from the vault entirely`);
        continue;
      }
      const findable = holding.some(
        (at) => (!at.startsWith(".trew/") && !isParked(at)) || reported.has(at),
      );
      if (!findable) {
        faults.push(
          `${what} is at ${holding.join(", ")}, which no listing shows and nothing ` +
            `reports after a restart (stranded: ${[...reported].join(", ") || "nothing"})`,
        );
      }
    }
    return { scenario: scenario.name, seam: seamName, faults, refused: undefined, fired };
  } finally {
    await removeTree(dir).catch(() => undefined);
    await removeTree(signals).catch(() => undefined);
  }
}
