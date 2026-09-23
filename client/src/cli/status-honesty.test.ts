/**
 * `trew status` does not say "up to date" about files it never looked at
 * (R12).
 *
 * Two ways it did. A vault with no index returned zero unsent without scanning
 * anything, and that is the ordinary state immediately after pairing and
 * before the first sync: every note on the disk is unsent, and the status said
 * everything was current. A scan that failed also returned zero, under a
 * comment saying that guessing at zero would be exactly the claim this exists
 * to prevent.
 *
 * And the scan itself was not a scan. `list` reaps the temporary files a
 * crashed run left behind and re-spells names into their normal form, both of
 * which are writes, from a command that takes no lock and may be running
 * beside a watcher.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const NEWLINE = "\n";

import { STATE_DIR, saveConfig } from "./config.ts";
import { NodeVault, TEMP_MARK } from "./vault.ts";
import { generateDeviceToken } from "../core/pairing.ts";
import { run } from "./cli.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function pairedVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trew-status-"));
  dirs.push(dir);
  await saveConfig(dir, {
    url: "ws://127.0.0.1:1#nothing",
    vaultId: "default",
    device: "d",
    deviceId: "d1",
    deviceToken: generateDeviceToken(),
  });
  return dir;
}

/** Runs `trew status --json` and returns what it printed. */
async function status(dir: string): Promise<{ unsent: number | string; stranded: string[] }> {
  const out: string[] = [];
  await run(["status", "--dir", dir, "--json", "--timeout", "300"], {
    out: (l) => out.push(l),
    err: () => {},
  });
  return JSON.parse(out.join("")) as { unsent: number | string; stranded: string[] };
}

/** The same, as a person reads it. */
async function statusText(dir: string): Promise<string> {
  const out: string[] = [];
  await run(["status", "--dir", dir, "--timeout", "300"], {
    out: (l) => out.push(l),
    err: () => {},
  });
  return out.join(NEWLINE);
}

describe("a vault paired and never synced", () => {
  it("counts its notes as unsent rather than answering zero", async () => {
    const dir = await pairedVault();
    await writeFile(join(dir, "one.md"), "written before the first sync\n");
    await writeFile(join(dir, "two.md"), "and another\n");

    const said = await status(dir);
    expect(
      said.unsent,
      "a vault with no index reported nothing unsent, which is what it says " +
        "immediately after pairing",
    ).toBe(2);
  });
});

describe("a vault that cannot be read", () => {
  it("says unknown rather than zero", async () => {
    const dir = await pairedVault();
    // A directory the walk cannot enter. Running as root defeats this, and
    // then there is nothing to test.
    const shut = join(dir, "shut");
    await mkdir(shut);
    await (await import("node:fs/promises")).chmod(shut, 0o000);
    dirs.push(shut);

    const said = await status(dir);
    await (await import("node:fs/promises")).chmod(shut, 0o700).catch(() => {});
    if (said.unsent !== "unknown") {
      expect(process.getuid?.(), "the scan succeeded, so this proves nothing").toBe(0);
      return;
    }
    expect(said.unsent).toBe("unknown");
  });
});

describe("the scan status makes", () => {
  it("writes nothing: no reaping, no re-spelling", async () => {
    const dir = await pairedVault();
    await writeFile(join(dir, "note.md"), "a note\n");
    // A temporary from a crashed run, old enough that an ordinary scan would
    // reap it.
    const staging = join(dir, STATE_DIR, "tmp");
    await mkdir(staging, { recursive: true });
    const debris = join(staging, `${TEMP_MARK}stale`);
    await writeFile(debris, "left behind");
    const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    await (await import("node:fs/promises")).utimes(debris, old, old);

    const before = (await readdir(staging)).sort();
    await status(dir);
    expect(
      (await readdir(staging)).sort(),
      "an inspection command reaped a temporary file",
    ).toEqual(before);

    // And the observing vault really does leave names alone, while an
    // ordinary one still tidies. Without this the assertion above would pass
    // for a scan that never ran.
    const watching = new NodeVault(dir, { observeOnly: true });
    await watching.list();
    expect((await readdir(staging)).sort(), "an observing scan reaped a temporary file").toEqual(
      before,
    );

    const ordinary = new NodeVault(dir);
    await ordinary.list();
    expect(
      (await readdir(staging)).length,
      "an ordinary scan no longer reaps, so the observing one proves nothing",
    ).toBe(0);
  });
});

/**
 * The two formats agree about what happened (R25).
 *
 * They did not: text returned failure when the local scan could not run and
 * JSON returned success for the same vault in the same state, so a cron job
 * and a person looking at the same command were told different things.
 */
describe("the exit status", () => {
  it("is the same in both formats when the vault cannot be read", async () => {
    const dir = await pairedVault();
    const shut = join(dir, "shut");
    await mkdir(shut);
    await (await import("node:fs/promises")).chmod(shut, 0o000);
    dirs.push(shut);

    const codes: Record<string, number> = {};
    for (const json of [false, true]) {
      const args = ["status", "--dir", dir, "--timeout", "300", ...(json ? ["--json"] : [])];
      codes[json ? "json" : "text"] = await run(args, { out: () => {}, err: () => {} });
    }
    await (await import("node:fs/promises")).chmod(shut, 0o700).catch(() => {});

    if (codes["text"] === 0 && codes["json"] === 0) {
      expect(process.getuid?.(), "the scan succeeded, so this proves nothing").toBe(0);
      return;
    }
    expect(
      codes["json"],
      `text exited ${codes["text"]} and json exited ${codes["json"]} for one vault`,
    ).toBe(codes["text"]);
  });

  /**
   * And the count says what it is. Hashing every note is what a sync does;
   * this compares sizes and timestamps, so an edit that keeps both is
   * invisible and the number is an estimate.
   */
  it("says what the unsent count was decided from", async () => {
    const dir = await pairedVault();
    await writeFile(join(dir, "one.md"), "a note\n");
    const said = (await status(dir)) as { unsent: number | string; unsentFrom?: string };
    expect(said.unsentFrom, "the basis of the count is not stated").toBe("size and timestamp");
  });

  it("does not call a vault up to date on the strength of timestamps", async () => {
    const dir = await pairedVault();
    const out: string[] = [];
    await run(["status", "--dir", dir, "--timeout", "300"], {
      out: (l) => out.push(l),
      err: () => {},
    });
    const text = out.join("\n");
    if (!text.includes("state")) return; // could not reach a server; nothing to judge
    expect(
      text,
      "status claimed the vault is up to date from a comparison of sizes and timestamps",
    ).not.toMatch(/up to date with the server/);
  });
});

/**
 * A version this client took off the disk and could not put back (R35).
 *
 * `respell.` came off the reaper's allowlist because it can name the only copy
 * of an unsent edit, and taking it off means nothing removes it ever. That is
 * the right thing to do with the file and the wrong thing to do silently: a
 * note nobody can find is not much better than one that was deleted. So the
 * scan counts what it declines to remove, and status says so in both formats,
 * because a cron job and a person have to be told the same thing.
 */
describe("a preserved version waiting in staging", () => {
  it("is reported rather than left for somebody to notice", async () => {
    const dir = await pairedVault();
    const staging = join(dir, STATE_DIR, "tmp");
    await mkdir(staging, { recursive: true });
    // Exactly what an interrupted normalization leaves.
    await writeFile(join(staging, "preserved.9f2cab0134ee71bd"), "the unsent edit\n");

    const said = await status(dir);
    expect(said.stranded, "the only copy of an edit was sitting there unmentioned").toEqual([
      join(STATE_DIR, "tmp", "preserved.9f2cab0134ee71bd"),
    ]);
    // And the text says where, not which directory it used to be (R50).
    const text = await statusText(dir);
    expect(text).toMatch(/kept +1 version\(s\) this client could not put back/);
    expect(text).toContain(join(dir, STATE_DIR, "tmp", "preserved.9f2cab0134ee71bd"));
  });

  /**
   * R50. The one that is not in staging at all.
   *
   * A failed preservation claim leaves the displaced version beside the note
   * it came from, and `status` printed `.trew/tmp` for every entry because
   * that used to be the only place one could be. Somebody following that path
   * found an empty directory while their only unsent edit sat under `notes/`,
   * where the ordinary listing deliberately hides it.
   */
  it("names a version parked beside its note, wherever that is", async () => {
    const dir = await pairedVault();
    await mkdir(join(dir, "notes"), { recursive: true });
    const at = join("notes", `note.md.${TEMP_MARK}keep12345678`);
    await writeFile(join(dir, at), "the unsent edit\n");

    expect((await status(dir)).stranded).toEqual([at]);
    const text = await statusText(dir);
    expect(text, "the text sends somebody to a directory the bytes are not in").toContain(
      join(dir, at),
    );
    expect(text).not.toMatch(/could not put back, in /);
  });

  /** And both kinds at once, which is one list and one convention. */
  it("names both a staged version and one beside a note", async () => {
    const dir = await pairedVault();
    await mkdir(join(dir, STATE_DIR, "tmp"), { recursive: true });
    await writeFile(join(dir, STATE_DIR, "tmp", "preserved.aaaa1111"), "one\n");
    await mkdir(join(dir, "notes"), { recursive: true });
    const beside = join("notes", `other.md.${TEMP_MARK}keepbbbb2222`);
    await writeFile(join(dir, beside), "two\n");

    const said = await status(dir);
    expect([...said.stranded].sort()).toEqual(
      [join(STATE_DIR, "tmp", "preserved.aaaa1111"), beside].sort(),
    );
    const text = await statusText(dir);
    for (const each of said.stranded) expect(text).toContain(join(dir, each));
  });

  it("says nothing about an ordinary vault", async () => {
    const dir = await pairedVault();
    await writeFile(join(dir, "note.md"), "a note\n");

    expect((await status(dir)).stranded).toEqual([]);
    expect(await statusText(dir)).not.toMatch(/could not put back/);
  });

  /**
   * And not about this code's own debris, which is a copy of something the
   * server holds. Reporting that would train somebody to ignore the line.
   */
  it("says nothing about a staged download left by a crash", async () => {
    const dir = await pairedVault();
    const staging = join(dir, STATE_DIR, "tmp");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "replace.4d1e7a3055ff20ac"), "an incoming version\n");

    expect((await status(dir)).stranded).toEqual([]);
  });
});
