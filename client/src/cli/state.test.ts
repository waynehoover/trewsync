/**
 * The vault's state directory under contention and under failure.
 *
 *  Two processes on one vault each loaded the index,
 * decided from it, and wrote notes, config and index over each other from
 * state the other never saw; and an unlink removed the config before the
 * index, so a failure in between left a vault that read as unpaired while an
 * index from the old pairing waited to be loaded by the next one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer, until } from "../core/test-server.ts";
import { run, type Console } from "./cli.ts";
import { configPath, indexPath, loadConfig, saveConfig } from "./config.ts";
import { STATE_DIR } from "./config.ts";
import { alive, currentHolder, lockPath, lockVault } from "./lock.ts";

/**
 * `saveConfig` and `loadConfig`, failing when a test says so. The CLI imports
 * the same module, so a failure injected here is a failure it meets exactly
 * where it would.
 *
 * The second one is a disk that writes and will not read back, which is a
 * stranger failure than a full disk and the one that decides whether the
 * advice after a half-finished pairing is safe. `breakLoadsAfterSaves` is set
 * to the save count at the start of a test, so reads before the write go
 * through and every read after it fails.
 */
let failSavesAfter = Infinity;
let breakLoadsAfterSaves = Infinity;
let saves = 0;
vi.mock("./config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.ts")>();
  return {
    ...actual,
    saveConfig: async (vault: string, config: Parameters<typeof actual.saveConfig>[1]) => {
      saves++;
      if (saves > failSavesAfter) throw new Error("the disk is full, as it were");
      return actual.saveConfig(vault, config);
    },
    loadConfig: async (vault: string) => {
      if (saves > breakLoadsAfterSaves) throw new Error("the disk will not read, as it were");
      return actual.loadConfig(vault);
    },
  };
});

class Run {
  code = -1;
  out: string[] = [];
  err: string[] = [];
  get all(): string {
    return this.out.join("\n") + "\n" + this.err.join("\n");
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.out.join("\n")) as Record<string, unknown>;
  }
}

async function cli(...argv: string[]): Promise<Run> {
  const r = new Run();
  const io: Console = { out: (l) => r.out.push(l), err: (l) => r.err.push(l) };
  r.code = await run(argv, io);
  return r;
}

it("pairs using the documented standard-input form without exposing the invite in arguments", async () => {
  const a = await paired();
  const issued = await cli("invite", "--dir", a, "--json");
  expect(issued.code, issued.all).toBe(0);
  const b = await vaultDir("stdin");
  const input = Readable.from([Buffer.from(String(issued.json()["invite"]) + "\n")]);
  const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(input as typeof process.stdin);
  try {
    const paired = await cli("pair", "-", "--dir", b, "--read-only", "--json");
    expect(paired.code, paired.all).toBe(0);
    expect((await loadConfig(b))?.readOnly).toBe(true);
    await writeFile(join(a, "From stdin.md"), "The invite arrived through a private pipe.\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await readFile(join(b, "From stdin.md"), "utf8")).toBe(
      "The invite arrived through a private pipe.\n",
    );
  } finally {
    stdin.mockRestore();
  }
}, 60_000);

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer | undefined;
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  failSavesAfter = Infinity;
  breakLoadsAfterSaves = Infinity;
  saves = 0;
  for (const c of children.splice(0)) {
    // A child killed by a signal has no exit code, only a signal.
    if (c.exitCode === null && c.signalCode === null) {
      const ended = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");
      await ended;
    }
  }
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
  server = undefined;
});

async function vaultDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `telimus-state-${name}-`));
  dirs.push(dir);
  return dir;
}

async function paired(name = "a"): Promise<string> {
  return (await pairedWithKey(name)).dir;
}

/**
 * The same, and the recovery key `init` printed.
 *
 * Kept by the caller because nothing reprints it: a paired device holds its
 * own credential and not the vault's root, which is what makes revoking one
 * device mean anything.
 */
async function pairedWithKey(name = "a"): Promise<{ dir: string; recoveryKey: string }> {
  server = new TestServer();
  await server.start();
  const dir = await vaultDir(name);
  const init = await cli("init", server.setup, "--dir", dir, "--device", name, "--json");
  expect(init.code, init.all).toBe(0);
  return { dir, recoveryKey: init.json()["recoveryKey"] as string };
}

/** The CLI as a separate process, which is the only way two of them contend. */
function telimus(...argv: string[]): ChildProcess & { stderrText: () => string } {
  const child = spawn("bun", ["src/cli/bin.ts", ...argv], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { stderrText: () => string };
  const err: string[] = [];
  child.stderr!.on("data", (b: Buffer) => err.push(b.toString()));
  child.stdout!.on("data", () => {});
  child.stderrText = () => err.join("");
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<number>((r) => {
    if (child.exitCode !== null) r(child.exitCode);
    else child.once("exit", (code) => r(code ?? -1));
  });

/**
 * F02, the CLI half. The key has to be printed before the step that erases it.
 *
 * `init` writes the root, claims the vault, registers this device, and the
 * registration replaces the root on disk with a device credential. Printing
 * the key after all that meant the window between the replacement and the
 * print held the only copy of it in a local variable, and a kill there left a
 * working device on a vault nobody could ever recover.
 */
/**
 * F26. A rebase reports the same outcome to a person and to a script.
 *
 * The JSON branch returned zero unconditionally while the text branch called
 * `exitCodeFor`, so an incomplete replay was a failure interactively and a
 * success in automation: exactly the difference a cron job cannot see.
 */
/**
 * F27. Cursors matching is not the same as nothing to send.
 *
 * `status` read the persisted index and the server's cursor. With the two
 * equal and the pending set empty it printed "up to date with the server"
 * without looking at the disk at all, so a note edited after a successful
 * sync sat there while the status said everything was current. That is the
 * one thing the status rule in docs/design.md forbids.
 */
describe("what status knows about this device (F27)", () => {
  it("does not claim everything is current with an unsent edit on the disk", async () => {
    const dir = await paired("statusedit");
    await writeFile(join(dir, "note.md"), "first");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // The settled wording, which no longer says "up to date": that would be a
    // claim about content, and the comparison is of sizes and timestamps
    // (R25). This is the string the edit below has to displace.
    const settled = await cli("status", "--dir", dir);
    expect(settled.all).toContain("nothing here looks changed");

    // Typed after the pass, which is the whole of it.
    await writeFile(join(dir, "note.md"), "and a paragraph nobody has sent");
    const after = await cli("status", "--dir", dir);
    expect(after.all, `status called an unsent edit settled:\n${after.all}`).not.toContain(
      "nothing here looks changed",
    );
    expect(after.all).toMatch(/1 not yet sent from here/);

    // And the machine-readable answer carries the same fact.
    const asJson = await cli("status", "--dir", dir, "--json");
    expect(asJson.json()["unsent"]).toBe(1);

    // A new note counts too, and so does one that was removed.
    await writeFile(join(dir, "fresh.md"), "brand new");
    expect((await cli("status", "--dir", dir, "--json")).json()["unsent"]).toBe(2);
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    expect((await cli("status", "--dir", dir, "--json")).json()["unsent"]).toBe(0);
    await rm(join(dir, "fresh.md"));
    expect((await cli("status", "--dir", dir, "--json")).json()["unsent"]).toBe(1);
  }, 300_000);
});

/**
 * Secrets that never touch the command line (I12).
 *
 * A recovery key typed as an argument is in the shell's history and in
 * `/proc` for every process on the machine while the command runs. Fine for a
 * one-off on a laptop you own, wrong for a script or a shared box. The
 * argument still works, because taking it away would make the common case
 * worse for no gain.
 */
describe("where a secret can come from (I12)", () => {
  it("reads the recovery key from a file, and writes a new one to a file only you can read", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("keyfile");
    const out = join(await vaultDir("keyout"), "key.txt");

    // The setup string from a file, and the generated key to one.
    const setupFile = join(dir, "setup.txt");
    await writeFile(setupFile, `${server.setup}\n`);
    const init = await cli("init", "--key-file", setupFile, "--key-out", out, "--dir", dir);
    expect(init.code, init.all).toBe(0);

    const written = (await readFile(out, "utf8")).trim();
    expect(written, "the key file holds no key").toMatch(/^basalt3_/);
    // And it is the key the command printed, not some other one.
    expect(init.all).toContain(written);
    // Readable by nobody else.
    expect((await stat(out)).mode & 0o077, "the key file is readable by others").toBe(0);

    // That key, back in from a file, to rotate with.
    const rotated = await cli("rotate", "--key-file", out, "--dir", dir, "--json");
    expect(rotated.code, rotated.all).toBe(0);
    expect(rotated.json()["recoveryKey"]).not.toBe(written);
  }, 300_000);

  it("refuses an empty key file rather than treating it as no key at all", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("emptykey");
    const empty = join(dir, "empty.txt");
    await writeFile(empty, "   \n");
    const r = await cli("init", "--key-file", empty, "--dir", dir);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/is empty/);
  }, 300_000);

  it("will not take the same secret twice, from a file and an argument", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("bothkeys");
    const f = join(dir, "setup.txt");
    await writeFile(f, `${server.setup}\n`);
    const r = await cli("init", server.setup, "--key-file", f, "--dir", dir);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/not both/);
  }, 300_000);
});

describe("what a rebase exits with (F26)", () => {
  it("gives JSON and text the same status when a path cannot be replayed", async () => {
    // A server that refuses anything over a few bytes, so the replay after
    // the rebase has a path it cannot finish.
    server = new TestServer();
    server.extraArgs = ["-max-file", "32"];
    await server.start();

    // Two devices of one vault, in the same state, because a rebase changes
    // the state it was asked about: running one and then the other on a
    // single vault compares a replay against a refusal.
    const first = await vaultDir("rebasetext");
    const started = await cli("init", server.setup, "--dir", first, "--device", "a", "--json");
    expect(started.code, started.all).toBe(0);
    const key = started.json()["recoveryKey"] as string;

    const second = await vaultDir("rebasejson");
    expect((await cli("pair", key, "--dir", second, "--device", "b")).code).toBe(0);

    // One note each side knows about, then a backup, then more history. The
    // restore puts the server back before the second note, which is exactly
    // the state `rebase` exists for: the devices hold versions it does not.
    // Without that a rebase refuses before it replays anything, and both
    // formats then exit the same way for the wrong reason.
    await writeFile(join(first, "one.md"), "first");
    expect((await cli("sync", "--dir", first)).code).toBe(0);
    expect((await cli("sync", "--dir", second)).code).toBe(0);
    const backup = await vaultDir("rebasebackup");
    await server.cli("backup", "-to", backup);
    await writeFile(join(first, "two.md"), "second");
    expect((await cli("sync", "--dir", first)).code).toBe(0);
    expect((await cli("sync", "--dir", second)).code).toBe(0);

    const dataDir = server.dataDir;

    // And a note on each device the restored server will refuse, so the
    // replay is incomplete rather than clean.
    await writeFile(join(first, "big.md"), "x".repeat(4096));
    await writeFile(join(second, "big.md"), "x".repeat(4096));

    const restore = async (): Promise<void> => {
      await server!.whileStopped(async () => {
        await rm(dataDir, { recursive: true, force: true });
        await cp(backup, dataDir, { recursive: true });
      });
    };

    await restore();
    const text = await cli("rebase", "--backup-taken", "--dir", first);
    // The first rebase pushes its history back, so the server is no longer
    // behind the second device. Put it back, or the second run measures a
    // refusal rather than a replay.
    await restore();
    const asJson = await cli("rebase", "--backup-taken", "--dir", second, "--json");

    expect(
      asJson.code,
      `text exited ${text.code} and json exited ${asJson.code}:\n${asJson.all}`,
    ).toBe(text.code);
    expect(text.code, `the oversized note was replayed cleanly:\n${text.all}`).toBe(1);
    // And the machine-readable answer says so in its own field too.
    expect(asJson.json()["ok"], `ok disagreed with the exit code:\n${asJson.all}`).toBe(false);
  }, 300_000);
});

describe("what init prints, and when (F02)", () => {
  it("prints the recovery key before it registers the device", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("initorder");
    // The order the lines were produced in, which is the whole property: the
    // key has to be out before the config on disk stops holding the root.
    const init = await cli("init", server.setup, "--dir", dir, "--device", "a");
    expect(init.code, init.all).toBe(0);

    const printed = init.out.join("\n");
    const key = printed.match(/basalt3_[A-Za-z0-9_-]+/)?.[0];
    expect(key, `no recovery key was printed at all: ${init.all}`).toBeDefined();
    const keyAt = printed.indexOf(key!);
    const startedAt = printed.indexOf("Started the vault");
    expect(startedAt, "init never reported success").toBeGreaterThan(-1);
    expect(
      keyAt,
      "the key was printed after the registration that had already erased it from disk",
    ).toBeLessThan(startedAt);

    // And the disk is in the state that makes revoking mean something.
    const held = await loadConfig(dir);
    expect(held?.deviceId).toBeDefined();
    expect(held?.secret, "a paired device kept the vault's root").toBeUndefined();
  }, 300_000);
});

/**
 * A version this client could not put back reaches the exit code, not only the
 * text of one command (R46, R50).
 *
 * It was reported by `status` and nothing else, and `wrong` did not include
 * it, so `status --json` answered `ok: true` and exited 0 over a vault holding
 * the only copy of an unsent edit. A green exit is how a cron job never finds
 * out, and this is a fact that does not clear itself: it waits for a person to
 * look at two files and decide.
 *
 * Against a real server, because with an unreachable one every status is
 * already not-ok and the assertion would hold whatever this code did.
 */
describe("a version the client could not put back", () => {
  it("makes an otherwise settled vault report that it is not", async () => {
    const dir = await paired("stranded");
    await writeFile(join(dir, "note.md"), "an ordinary note\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // Settled first, so the difference below is the stranded version alone.
    const settled = await cli("status", "--dir", dir, "--json");
    expect(settled.code, settled.all).toBe(0);
    expect(settled.json()["ok"]).toBe(true);

    await mkdir(join(dir, STATE_DIR, "tmp"), { recursive: true });
    await writeFile(
      join(dir, STATE_DIR, "tmp", "preserved.aaaa1111"),
      "the only copy of an edit\n",
    );

    const after = await cli("status", "--dir", dir, "--json");
    expect(
      after.json()["ok"],
      "a vault holding the only copy of an edit reported itself fine",
    ).toBe(false);
    expect(after.code, "and exited 0, which is how a cron job never finds out").toBe(1);
    expect(after.json()["stranded"]).toEqual([join(STATE_DIR, "tmp", "preserved.aaaa1111")]);

    // And the text names the path rather than a directory.
    const text = await cli("status", "--dir", dir);
    expect(text.all).toContain(join(dir, STATE_DIR, "tmp", "preserved.aaaa1111"));
  }, 120_000);
});

describe("the vault lock", () => {
  it("refuses a second holder and names the first", async () => {
    const dir = await vaultDir("lock");
    const release = await lockVault(dir, "telimus sync");
    await expect(lockVault(dir, "telimus restore")).rejects.toThrow(
      new RegExp(`telimus sync \\(pid ${process.pid} on `),
    );
    await release();
    // Released, so nobody holds it in between and the next holder gets it.
    expect(await currentHolder(dir)).toBeUndefined();
    await (
      await lockVault(dir, "telimus restore")
    )();
  });

  it("takes over a lock whose holder on this host is dead", async () => {
    const dir = await vaultDir("stale");
    await mkdir(join(dir, ".telimus"), { recursive: true });
    // A pid nothing is running under. Found by asking, not assumed.
    let dead = 2 ** 22 - 7;
    while (alive(dead)) dead--;
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: dead,
        host: (await import("node:os")).hostname(),
        command: "telimus sync",
        since: 1,
      }),
    );
    // Taken over, and by the kernel's answer rather than by this program's
    // opinion of a pid (I27). Five attempts to do it from a file each handed
    // one vault to two writers; the exclusion the kernel drops on exit has no
    // staleness to get wrong.
    const release = await lockVault(dir, "telimus sync");
    expect(await currentHolder(dir)).toMatchObject({ pid: process.pid });
    await release();
  });

  it("believes a holder on another host, which it cannot check", async () => {
    const dir = await vaultDir("remote");
    await mkdir(join(dir, ".telimus"), { recursive: true });
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: 1,
        host: "some-other-machine",
        command: "telimus sync --watch",
        since: 1,
      }),
    );
    await expect(lockVault(dir, "telimus sync")).rejects.toThrow(/some-other-machine/);
  });

  it("keeps two real processes from syncing one vault at once", async () => {
    const dir = await paired("two");
    await writeFile(join(dir, "note.md"), "a note\n");

    const watcher = telimus("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );

    const second = telimus("sync", "--dir", dir);
    expect(await exited(second)).toBe(1);
    expect(second.stderrText()).toMatch(/another telimus is using this vault: telimus sync/);
    expect(second.stderrText()).toMatch(new RegExp(`pid ${watcher.pid} on`));

    // Stopped without cleaning up, as a kill or a crash would leave it.
    const ended = exited(watcher);
    watcher.kill("SIGKILL");
    await ended;
    // The lock is still on the disk, naming the process that died with it.
    // `currentHolder` says who the file names and deliberately not whether
    // they are running: this client no longer has an opinion on that, because
    // forming one and acting on it is what went wrong five times.
    expect(await currentHolder(dir)).toMatchObject({ pid: watcher.pid });

    // The next one takes it, because the kernel let go of the exclusion when
    // the watcher died (I27). The record left in the file is debris and is
    // replaced. `telimus unlock` is still there for a holder on another
    // machine, and is no longer between a crashed cron job and the next run.
    const third = await cli("sync", "--dir", dir, "--json");
    expect(third.code, third.all).toBe(0);
    expect(await currentHolder(dir), "the vault is still held afterwards").toBeUndefined();
  }, 120_000);

  it("frees the vault when a watcher is killed, with nobody typing anything", async () => {
    // I27, end to end and with real processes, which is the only way this
    // property means anything: the kernel releases the exclusion when the
    // holder dies, so the next command simply works.
    //
    // Before this, the same schedule needed `telimus unlock` in between, and
    // the five attempts to avoid that each handed one vault to two writers.
    const dir = await paired("kernel");
    await writeFile(join(dir, "note.md"), "a note\n");

    const watcher = telimus("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );
    // Held, and a second telimus is turned away while it runs.
    const second = await cli("sync", "--dir", dir);
    expect(second.code, second.all).toBe(1);
    expect(second.all).toMatch(/another telimus is using this vault/);

    // Killed outright, as a crash or an OOM would.
    const ended = exited(watcher);
    watcher.kill("SIGKILL");
    await ended;

    const after = await cli("sync", "--dir", dir, "--json");
    expect(after.code, `a killed watcher left the vault wedged: ${after.all}`).toBe(0);
    expect(after.all).not.toMatch(/telimus unlock/);
    expect(await currentHolder(dir), "the vault is still held afterwards").toBeUndefined();
  }, 120_000);

  it("refuses to unlock a vault whose holder is running", async () => {
    const dir = await paired("held");
    const watcher = telimus("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );

    const refused = await cli("unlock", "--dir", dir);
    expect(refused.code, refused.all).toBe(1);
    expect(refused.all).toMatch(new RegExp(`pid ${watcher.pid} is still running`));
    // And the watcher still holds it, which is the point of refusing.
    expect(await currentHolder(dir)).toMatchObject({ pid: watcher.pid });

    const ended = exited(watcher);
    watcher.kill("SIGKILL");
    await ended;
  }, 120_000);

  it("lets a reading command through while a watcher holds the vault", async () => {
    const dir = await paired("read");
    const watcher = telimus("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );
    const status = await cli("status", "--dir", dir, "--json");
    expect(status.code, status.all).toBe(0);
  }, 120_000);
});

/**
 * `sync` and `status` on one vault, giving one answer.
 *
 * They are two readings of the same facts and a cron job runs one of them, so
 * a fact that changes one exit code and not the other is a fact automation
 * cannot see. This is the shape rule 7 is about, and it went wrong the moment
 * a new fact was added: `status` learned that an unreadable recovery record is
 * not a clean vault and `sync` did not (RR5).
 */
describe("the two ways of asking how a vault is", () => {
  it("includes the live recovery inventory in watcher reports", async () => {
    const dir = await paired("watch-recovery");
    await writeFile(join(dir, "note.md"), "the ordinary note\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    const at = join(STATE_DIR, "tmp", "preserved.aaaa1111");
    await mkdir(join(dir, STATE_DIR, "tmp"), { recursive: true });
    await writeFile(join(dir, at), "the retained edit\n");
    await writeFile(join(dir, STATE_DIR, "displaced.log"), '{"at":"unfinished');
    const watcher = telimus("sync", "--watch", "--dir", dir, "--json");
    let output = "";
    watcher.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await until("the watcher's first report", () => output.includes("\n"), 30_000);
    const first = JSON.parse(output.split("\n")[0]!) as {
      ok: boolean;
      outcome: { kind: string };
      stranded: string[];
      recoveryUnknown: string | null;
    };
    expect(first.ok, output).toBe(false);
    expect(first.outcome.kind).toBe("recoveryUnknown");
    expect(first.stranded).toContain(at);
    expect(first.recoveryUnknown).toMatch(/cannot be read/);
    expect(await readFile(join(dir, at), "utf8")).toBe("the retained edit\n");
  }, 60_000);

  it("agree when the record of what is waiting cannot be read", async () => {
    const dir = await paired("agree");
    await writeFile(join(dir, "note.md"), "a note\n");
    // Clean first, so the difference below is the torn record and nothing else.
    const clean = await cli("sync", "--dir", dir, "--json");
    expect(clean.code, clean.all).toBe(0);
    expect((await cli("status", "--dir", dir, "--json")).code).toBe(0);

    // What a crash mid-append leaves: a line that names something and cannot
    // be read, so what it named is not in the list beside it.
    await writeFile(join(dir, STATE_DIR, "displaced.log"), '{"at":"note.md..telimus-tmp-keep0a1');

    const synced = await cli("sync", "--dir", dir, "--json");
    const status = await cli("status", "--dir", dir, "--json");
    const syncJson = JSON.parse(synced.out.at(-1)!) as { ok: boolean; outcome: { kind: string } };
    const statusJson = JSON.parse(status.out.at(-1)!) as { ok: boolean };

    expect(
      { sync: synced.code, status: status.code },
      `sync exited ${synced.code} and status exited ${status.code} on one vault`,
    ).toEqual({ sync: 1, status: 1 });
    expect({ sync: syncJson.ok, status: statusJson.ok }).toEqual({ sync: false, status: false });
    // And it says which of the two unhappy things it is, rather than looking
    // like a transfer that failed.
    expect(syncJson.outcome.kind).toBe("recoveryUnknown");
  }, 120_000);
});

/**
 * A device that holds a copy and originates nothing (I29).
 *
 * The case this exists for is not a bug in the sync engine. A scan of a mount
 * that came up empty, a path typo, a half-restored disk: each is an *ordinary
 * local change*, and ordinary local changes propagate, so a mirror can delete
 * notes on every device by being wrong about what is on its own disk. A device
 * without the capability cannot make that mistake.
 */
describe("a read-only device", () => {
  it("applies what the server has and sends nothing back", async () => {
    const a = await paired("ro-writer");
    await writeFile(join(a, "from-the-server.md"), "written elsewhere\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    // A second device on the same vault, read-only from the start.
    const b = await vaultDir("ro-mirror");
    const invite = JSON.parse((await cli("invite", "--dir", a, "--json")).out.at(-1)!) as {
      invite: string;
    };
    expect((await cli("pair", invite.invite, "--dir", b, "--read-only")).code).toBe(0);
    expect((await cli("sync", "--dir", b, "--json")).code).toBe(0);
    // It received the note, because a mirror is still a copy.
    expect(await readFile(join(b, "from-the-server.md"), "utf8")).toBe("written elsewhere\n");

    // Now it changes locally, the way a broken mount or a stray editor would.
    await writeFile(join(b, "invented-here.md"), "this must not travel\n");
    await rm(join(b, "from-the-server.md"));

    const mirrored = await cli("sync", "--dir", b, "--json");
    expect(mirrored.code, mirrored.all).toBe(0);
    const report = JSON.parse(mirrored.out.at(-1)!) as { heldBack: number; uploaded: number };
    expect(report.uploaded).toBe(0);
    expect(report.heldBack, "the local changes were not counted as held back").toBeGreaterThan(0);

    // And the writer still has everything, which is the whole point: the
    // mirror's deletion did not become everybody's deletion.
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect(await readFile(join(a, "from-the-server.md"), "utf8")).toBe("written elsewhere\n");
    expect(existsSync(join(a, "invented-here.md"))).toBe(false);
  }, 120_000);

  it("does not keep making the same conflict copy, pass after pass", async () => {
    // RR7, the reviewer's reproduction. `conflict` normally records that a
    // remote version has been dealt with by uploading the local one against
    // its uid; a mirror does not upload, so nothing recorded it and every pass
    // decided the same conflict again and wrote another copy. Eleven files
    // after one command, twenty after the next, nineteen of them holding the
    // same incoming body.
    const a = await paired("rr7-writer");
    await writeFile(join(a, "note.md"), "the original\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const b = await vaultDir("rr7-mirror");
    const invite = JSON.parse((await cli("invite", "--dir", a, "--json")).out.at(-1)!) as {
      invite: string;
    };
    expect((await cli("pair", invite.invite, "--dir", b, "--read-only")).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    // Both sides edit it, and only the writer's edit reaches the server.
    await writeFile(join(a, "note.md"), "the original, changed by the writer\n");
    await writeFile(join(b, "note.md"), "the original, changed on the mirror\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const count = async (): Promise<number> =>
      (await readdir(b)).filter((n) => n.endsWith(".md")).length;

    const first = await cli("sync", "--dir", b, "--json", "--no-merge");
    expect(first.code, first.all).toBe(0);
    const afterFirst = await count();
    expect(afterFirst, "the incoming version was not kept beside the local edit").toBe(2);

    // And again, and again. Nothing has changed on either side, so nothing
    // more should appear.
    for (let i = 0; i < 3; i++) {
      const again = await cli("sync", "--dir", b, "--json", "--no-merge");
      expect(again.code, again.all).toBe(0);
      const r = JSON.parse(again.out.at(-1)!) as { conflicted: number; uploaded: number };
      expect(r.uploaded, "a read-only device sent something").toBe(0);
      expect(r.conflicted, `pass ${i + 2} conflicted again`).toBe(0);
    }
    expect(await count(), "repeated passes kept adding copies").toBe(afterFirst);

    // The mirror's own edit is still there, unsent, and the writer's version
    // is beside it.
    const bodies = await Promise.all(
      (await readdir(b)).filter((n) => n.endsWith(".md")).map((n) => readFile(join(b, n), "utf8")),
    );
    expect(bodies.join("\n")).toContain("changed on the mirror");
    expect(bodies.join("\n")).toContain("changed by the writer");
    // And the writer never saw any of it.
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await readdir(a)).filter((n) => n.endsWith(".md"))).toEqual(["note.md"]);
  }, 120_000);

  it("does not merge the same remote version again on every pass", async () => {
    // RR9, and the reason RR7's test did not catch it: every sync in it passes
    // `--no-merge`, so the branch this is about was never entered. The fix went
    // into `conflict` and the successful-merge path was left relying on the
    // upload to move the ancestor, which on a mirror does not happen. Nine
    // merges reported on the first pass and nine on the next, with nothing
    // changed in between.
    //
    // Three paragraphs, because a merge has to succeed here rather than turn
    // into a conflict copy: the two sides edit different ones.
    const a = await paired("rr9-writer");
    const original = "first paragraph\n\nsecond paragraph\n\nthird paragraph\n";
    await writeFile(join(a, "note.md"), original);
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const b = await vaultDir("rr9-mirror");
    const invite = JSON.parse((await cli("invite", "--dir", a, "--json")).out.at(-1)!) as {
      invite: string;
    };
    expect((await cli("pair", invite.invite, "--dir", b, "--read-only")).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await readFile(join(b, "note.md"), "utf8")).toBe(original);

    // The mirror edits the first paragraph, the writer the third, and only the
    // writer's edit reaches the server.
    await writeFile(
      join(b, "note.md"),
      original.replace("first paragraph", "first paragraph, from the mirror"),
    );
    await writeFile(
      join(a, "note.md"),
      original.replace("third paragraph", "third paragraph, from the writer"),
    );
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    // Merging on, which is the default and the whole point of this case.
    const pass = async (): Promise<{
      merged: number;
      uploaded: number;
      conflicted: number;
      heldBack: number;
    }> => {
      const r = await cli("sync", "--dir", b, "--json");
      expect(r.code, r.all).toBe(0);
      return JSON.parse(r.out.at(-1)!) as {
        merged: number;
        uploaded: number;
        conflicted: number;
        heldBack: number;
      };
    };

    const first = await pass();
    expect(first.merged, "the merge did not happen at all").toBeGreaterThan(0);
    expect(first.uploaded, "a read-only device sent something").toBe(0);

    // Both edits are in the one file, which is what a successful merge means.
    const merged = await readFile(join(b, "note.md"), "utf8");
    expect(merged).toContain("from the mirror");
    expect(merged).toContain("from the writer");
    expect((await readdir(b)).filter((n) => n.endsWith(".md"))).toEqual(["note.md"]);

    // And now nothing has changed on either side, so there is nothing to merge.
    for (let i = 0; i < 3; i++) {
      const again = await pass();
      expect(again.uploaded, "a read-only device sent something").toBe(0);
      expect(again.merged, `pass ${i + 2} merged the same version again`).toBe(0);
      expect(again.conflicted, `pass ${i + 2} wrote a conflict copy`).toBe(0);
      // The local edit is still this device's and still cannot be sent, so it
      // is held back, which is a state and not an event.
      expect(again.heldBack, `pass ${i + 2} forgot the local edit is unsent`).toBeGreaterThan(0);
      expect(await readFile(join(b, "note.md"), "utf8"), `pass ${i + 2} rewrote the note`).toBe(
        merged,
      );
    }
    expect((await readdir(b)).filter((n) => n.endsWith(".md"))).toEqual(["note.md"]);

    // A later server version is still processed, and the merge still keeps
    // both sides: settling the ancestor must not mean going deaf.
    await writeFile(
      join(a, "note.md"),
      original
        .replace("third paragraph", "third paragraph, from the writer")
        .replace("second paragraph", "second paragraph, later"),
    );
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const later = await pass();
    expect(later.merged, "a later server version was ignored").toBeGreaterThan(0);
    expect(later.uploaded).toBe(0);
    const after = await readFile(join(b, "note.md"), "utf8");
    expect(after).toContain("from the mirror");
    expect(after).toContain("second paragraph, later");
    expect((await readdir(b)).filter((n) => n.endsWith(".md"))).toEqual(["note.md"]);

    // Which settles too.
    const settled = await pass();
    expect(settled.merged, "the later version merged again on the next pass").toBe(0);

    // The writer never received any of it.
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect(await readFile(join(a, "note.md"), "utf8")).not.toContain("from the mirror");
  }, 120_000);

  it("stays read-only without the flag, because it is in the config", async () => {
    // The reason it is not a flag alone. A cron line that loses an argument
    // would otherwise turn a mirror into a writer, and nobody would find out
    // until it had deleted something everywhere.
    const a = await paired("ro-sticky-writer");
    const b = await vaultDir("ro-sticky");
    const invite = JSON.parse((await cli("invite", "--dir", a, "--json")).out.at(-1)!) as {
      invite: string;
    };
    expect((await cli("pair", invite.invite, "--dir", b, "--read-only")).code).toBe(0);

    await writeFile(join(b, "still-must-not-travel.md"), "x\n");
    // No --read-only this time.
    const out = await cli("sync", "--dir", b, "--json");
    expect(out.code, out.all).toBe(0);
    const report = JSON.parse(out.out.at(-1)!) as { heldBack: number; uploaded: number };
    expect(report.uploaded, "the flag was forgotten and the mirror uploaded").toBe(0);
    expect(report.heldBack).toBeGreaterThan(0);
  }, 120_000);
});

/**
 * Turning merging off (I30).
 *
 * Obsidian's own headless client has `--conflict-strategy merge|conflict` and
 * this had no equivalent: it always merged when it safely could, and somebody
 * who would rather look at two files had no way to say so. Merging is the only
 * thing this client does that produces content neither device wrote, and while
 * it refuses everything it cannot do safely, "refuses to guess" and "does not
 * guess" are different promises to be able to make.
 *
 * Nothing is lost either way. Off means every case that would have merged
 * keeps both versions, which is what merging already falls back to.
 */
describe("a device with merging turned off", () => {
  /** Two devices on one vault, both able to write. */
  async function pair2(name: string): Promise<{ a: string; b: string }> {
    const a = await paired(name);
    const b = await vaultDir(`${name}-b`);
    const invite = JSON.parse((await cli("invite", "--dir", a, "--json")).out.at(-1)!) as {
      invite: string;
    };
    expect((await cli("pair", invite.invite, "--dir", b)).code).toBe(0);
    return { a, b };
  }

  /** Both devices edit one note in different places, then both sync. */
  async function bothEdit(a: string, b: string, extra: string[]): Promise<string[]> {
    const base = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await writeFile(join(a, "note.md"), base);
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    await writeFile(join(a, "note.md"), base.replace("line 0", "line 0, changed by A"));
    await writeFile(join(b, "note.md"), base.replace("line 11", "line 11, changed by B"));
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    await cli("sync", "--dir", b, ...extra);
    return (await readdir(b)).filter((n) => n.endsWith(".md")).sort();
  }

  it("merges by default, which is what the client is for", async () => {
    const { a, b } = await pair2("merge-on");
    const files = await bothEdit(a, b, []);
    expect(files, `expected one merged note, got ${files.join(", ")}`).toEqual(["note.md"]);
    const merged = await readFile(join(b, "note.md"), "utf8");
    expect(merged).toContain("changed by A");
    expect(merged).toContain("changed by B");
  }, 120_000);

  it("keeps both versions instead, when told to", async () => {
    const { a, b } = await pair2("merge-off");
    const files = await bothEdit(a, b, ["--no-merge"]);
    expect(files.length, `expected two files, got ${files.join(", ")}`).toBe(2);
    // Both edits survive, in two files rather than one.
    const all = (await Promise.all(files.map((f) => readFile(join(b, f), "utf8")))).join("\n");
    expect(all).toContain("changed by A");
    expect(all).toContain("changed by B");
  }, 120_000);
});

/**
 * Restore's two answers, which have to be the one answer (RR8).
 *
 * The exit code learned about unresolved recovery and the JSON's `ok` did not,
 * so a restore on a vault whose displaced-version log cannot be read returned
 * exit 1 beside `ok: true`. Automation's reading of that depended on which of
 * the two fields it happened to look at, which is the shape rule 7 is about.
 */
describe("restore, on a vault that cannot say what is waiting", () => {
  it("agrees with its own exit code, and still says the note came back", async () => {
    const dir = await paired("rr8");
    await writeFile(join(dir, "note.md"), "the original\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    await rm(join(dir, "note.md"));
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // A record cut short by a crash: the log names something and cannot say
    // what, so this device cannot establish what is waiting.
    await writeFile(join(dir, STATE_DIR, "displaced.log"), '{"at":"note.md..telimus-tmp-keep0a1');

    const out = await cli("restore", "note.md", "--dir", dir, "--json");
    const json = JSON.parse(out.out.at(-1)!) as {
      ok: boolean;
      restored: boolean;
      outcome: { kind: string };
      path: string;
      recoveryUnknown: string | null;
    };

    expect({ ok: json.ok, code: out.code }, "the JSON and the exit code disagree").toEqual({
      ok: false,
      code: 1,
    });
    // And it still says the restore itself worked, which is the part somebody
    // is actually asking about.
    expect(json.restored).toBe(true);
    expect(json.outcome.kind).toBe("recoveryUnknown");
    expect(json.recoveryUnknown).toContain("cannot be read");
    // The bytes are really there.
    expect(await readFile(join(dir, json.path), "utf8")).toBe("the original\n");
  }, 120_000);
});

describe("unlinking as one transition", () => {
  it("removes the index before the config, and leaves the vault paired if it cannot", async () => {
    const dir = await paired("unlink");
    await writeFile(join(dir, "note.md"), "a note\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // The index cannot be removed: something is in its way.
    await rm(indexPath(dir));
    await mkdir(join(indexPath(dir), "occupied"), { recursive: true });
    const attempt = await cli("unlink", "--dir", dir);
    expect(attempt.code).toBe(1);
    // Still paired, which is the state that refuses to pair again.
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"deviceSecret"/);
    expect((await cli("init", server!.setup, "--dir", dir)).code).toBe(1);

    await rm(indexPath(dir), { recursive: true });
    const done = await cli("unlink", "--dir", dir, "--json");
    expect(done.code, done.all).toBe(0);
    await expect(stat(configPath(dir))).rejects.toThrow();
    await expect(stat(indexPath(dir))).rejects.toThrow();
  }, 120_000);

  it("refuses to pair over an index left by an unfinished unlink", async () => {
    const { dir, recoveryKey: pairing } = await pairedWithKey("orphan");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    // The old order's failure state: config gone, index still there.
    await rm(configPath(dir));

    const init = await cli("init", server!.setup, "--dir", dir);
    expect(init.code).toBe(1);
    expect(init.all).toMatch(/still holds an index/);
    const pair = await cli("pair", pairing, "--dir", dir);
    expect(pair.code).toBe(1);
    expect(pair.all).toMatch(/still holds an index/);

    // Unlink clears it, and then pairing is allowed.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", pairing, "--dir", dir, "--device", "again", "--json");
    expect(again.code, again.all).toBe(0);
  }, 120_000);

  it("refuses to unlink while another process is syncing the vault", async () => {
    const dir = await paired("busy");
    const watcher = telimus("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );
    const attempt = await cli("unlink", "--dir", dir);
    expect(attempt.code).toBe(1);
    expect(attempt.all).toMatch(/another telimus is using this vault/);
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"deviceSecret"/);
  }, 120_000);
});

/**
 * at the CLI. The index on disk is valid JSON and nothing
 * else, and both `sync` and `status` used to read numbers out of it.
 */
describe("an index that is valid JSON and wrong", () => {
  it("is refused by sync and status alike, with the field named", async () => {
    const dir = await paired("badindex");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    const index = JSON.parse(await readFile(indexPath(dir), "utf8")) as Record<string, unknown>;
    await writeFile(indexPath(dir), JSON.stringify({ ...index, pending: "soon" }));

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code).toBe(1);
    expect(sync.all).toMatch(/pending is not a list/);
    expect(sync.all).toMatch(/Remove the index and sync again/);
    const status = await cli("status", "--dir", dir);
    expect(status.code).toBe(1);
    expect(status.all).toMatch(/pending is not a list/);
  }, 120_000);
});

/**
 * at the place protocol 4 leaves it.
 *
 * A vault is claimed by the hello that starts it, and the config holding the
 * root is written and read back before that hello goes out for exactly this
 * reason: the claim commits, its reply is lost, and the only copy of the
 * vault's recovery key is the one on this disk. Nothing resumes from the
 * config, retries the spent token or falls back to the key the root derives,
 * so the answer has to be complete without any of that: every command refuses
 * such a config, prints the
 * recovery key back out of it, and pairing again with that key joins the vault
 * that was claimed, with every note still on it.
 *
 * A vault that could be claimed and then not got back into would be the worst
 * failure this project has, so it is tested end to end rather than by the
 * words of the refusal alone.
 */
describe("a vault that was started and never joined", () => {
  /**
   * Puts a vault back into the state a lost reply leaves: claimed on the
   * server, and a config on disk that still holds the root and has no device
   * row of its own.
   *
   * Written out rather than kept from before, because `init` gets all the way
   * to a registered device now: this is the state it would have been left in
   * had the registration failed after the claim committed.
   */
  async function startedNotJoined(dir: string, recoveryKey: string): Promise<void> {
    const { parsePairing } = await import("../core/pairing.ts");
    const config = (await loadConfig(dir))!;
    await saveConfig(dir, {
      url: config.url,
      vaultId: config.vaultId,
      device: config.device,
      secret: parsePairing(recoveryKey).secret,
    });
  }

  it("refuses, hands the recovery key back, and pairs again with it", async () => {
    const { dir, recoveryKey } = await pairedWithKey("lost");
    await writeFile(join(dir, "note.md"), "kept\n");
    await cli("sync", "--dir", dir);
    await startedNotJoined(dir, recoveryKey);

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code, sync.all).toBe(1);
    expect(sync.all).toMatch(/never registered itself/);
    // The key itself, not advice to find it somewhere: this config is the only
    // place it exists, and a refusal that does not print it is a lost vault.
    expect(sync.all).toContain(recoveryKey);
    expect(sync.all).toMatch(/unlink this vault and pair again/);
    // And nothing was written on the way past. The root is still there to be
    // read out again by the next command that refuses.
    expect((await loadConfig(dir))!.secret, "the root was dropped by a refusal").toBeDefined();

    // The way back the refusal names, all the way to the notes.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", recoveryKey, "--dir", dir, "--json");
    expect(again.code, again.all).toBe(0);
    const after = (await loadConfig(dir))!;
    expect(after.secret, "the recovery key was kept after pairing").toBeUndefined();
    expect(after.deviceId).toBeDefined();
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("kept\n");
  }, 180_000);

  /**
   * The other half of the same disk failure, on the pairing path rather than
   * the starting one. A registration commits and its credential does not reach
   * the disk, so the vault has a row nothing holds the key to. That is the
   * orphan the invite path already leaves when a reply is lost, and the
   * refusal has to name it: an unnamed registration is one nobody can
   * account for later.
   */
  it("names the row it left behind when a pairing could not save its credential", async () => {
    const { dir, recoveryKey } = await pairedWithKey("orphan");
    const second = await vaultDir("second");

    failSavesAfter = saves; // the very next save fails, which is the credential
    const attempt = await cli("pair", recoveryKey, "--dir", second);
    expect(attempt.code, attempt.all).toBe(1);
    expect(attempt.all).toMatch(/nothing can connect as/);
    expect(attempt.all).toMatch(/telimus revoke/);
    // Nothing here claims to be paired, because nothing here can connect.
    failSavesAfter = Infinity;
    expect(await loadConfig(second)).toBeUndefined();

    // And the row the refusal names is really there, and really goes.
    const listed = await cli("devices", "--dir", dir, "--json");
    const rows = listed.json()["devices"] as { id: string; lastSeen: number }[];
    const orphan = rows.find((d) => d.lastSeen === 0);
    expect(orphan, listed.all).toBeDefined();
    expect((await cli("revoke", orphan!.id, "--dir", dir)).code).toBe(0);
  }, 180_000);

  /**
   * The init half of the same failure, and the sentence it was missing.
   *
   * `init` claims the vault, registers this device's row and then saves the
   * credential. When that save fails it printed the recovery key, which is
   * right, and said "unlink here, and pair with that key", which is right and
   * incomplete: the row is already on the server and nothing holds its key, so
   * pairing again registers a *second* row without explaining the first.
   * `pair` said so and `init` did not, which is
   * what one shared counsellor is for; see `adviseAfterRegistering`.
   *
   * Walked to the end rather than asserted as a sentence (rule 11): the row is
   * really there, it has really never connected, and the order the words give
   * really takes it off.
   */
  it("names the row a failed init left, and the way back it names works", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("initorphan");
    // The root is saved, the claim and the registration commit, and the save
    // that would record this device's credential fails.
    failSavesAfter = 1;
    const init = await cli("init", server.setup, "--dir", dir, "--device", "first");
    expect(init.code, init.all).toBe(1);
    expect(init.all).toMatch(/Write this recovery key down now/);
    const printed = init.err.join("\n").match(/(basalt3_[A-Za-z0-9_-]+)/)![1]!;
    expect(init.all).toMatch(/device row was registered/);
    expect(init.all).toMatch(/never connected/);
    expect(init.all).toMatch(/telimus revoke/);
    failSavesAfter = Infinity;

    // The row is really there, and has really never connected. Only the
    // recovery key can ask: the vault has no device that can.
    const look = await vaultDir("look");
    const listed = await cli("devices", "--recovery-key", printed, "--dir", look, "--json");
    expect(listed.code, listed.all).toBe(0);
    const stranded = listed.json()["devices"] as { id: string; lastSeen: number }[];
    expect(
      stranded.map((d) => d.lastSeen),
      listed.all,
    ).toEqual([0]);

    // And the way back, in the order the message gives it: pair again, then
    // revoke the row that never connected. That order and not the other one,
    // because the stranded row is this vault's only row and revoking the last
    // one takes --allow-last and the recovery key.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", printed, "--dir", dir, "--device", "second", "--json");
    expect(again.code, again.all).toBe(0);
    const now = await cli("devices", "--dir", dir, "--json");
    const mine = now.json()["thisDevice"] as string;
    const rows = now.json()["devices"] as { id: string; lastSeen: number }[];
    const orphan = rows.find((d) => d.id !== mine);
    expect(orphan?.lastSeen, now.all).toBe(0);
    expect((await cli("revoke", orphan!.id, "--dir", dir)).code).toBe(0);
    const left = await cli("devices", "--dir", dir, "--json");
    expect((left.json()["devices"] as unknown[]).length, left.all).toBe(1);
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
  }, 180_000);

  /**
   * The mirror image of the orphan above, and the reason the advice is read
   * off the disk in four states rather than two.
   *
   * A disk that writes and will not read back saves the credential, fails the
   * read-back, and then fails the read the catch does as well. Both reads
   * being gone is what makes it dangerous: the row is live and its only key is
   * on this disk, so "that row is one nothing can connect as, revoke it" would
   * destroy a row this device could have used. Rule 2, in the place where
   * absent and unreadable have different consequences.
   */
  it("will not send somebody revoking a row when the disk refuses to say what is here", async () => {
    const { dir, recoveryKey } = await pairedWithKey("writeonly");
    expect(dir).toBeDefined();
    const second = await vaultDir("writeonly-2");

    breakLoadsAfterSaves = saves;
    const attempt = await cli("pair", recoveryKey, "--dir", second, "--device", "two");
    expect(attempt.code, attempt.all).toBe(1);
    expect(attempt.all).toMatch(/could not be read/);
    expect(attempt.all).toMatch(/not known/);
    // The row must not be named for revoking, because it is this device's.
    expect(attempt.all).not.toMatch(/telimus revoke/);
    expect(attempt.all).not.toMatch(/never connected/);

    // And the credential really was written: with the disk reading again this
    // device connects as the row the advice would have told somebody to take
    // away.
    breakLoadsAfterSaves = Infinity;
    expect((await loadConfig(second))!.deviceId).toBeDefined();
    expect((await cli("sync", "--dir", second)).code).toBe(0);
  }, 180_000);

  it("says the same thing to status, without blaming the server", async () => {
    const { dir, recoveryKey } = await pairedWithKey("status");
    await startedNotJoined(dir, recoveryKey);
    const s = await cli("status", "--dir", dir, "--json");
    expect(s.code, s.all).toBe(1);
    const answer = s.json()["server"] as Record<string, unknown>;
    // Rule 7. Nothing was asked of the server, so it is neither reachable nor
    // refused, and calling it refused sends somebody after an outage that is
    // not happening.
    expect(answer["reachable"], s.all).toBe(false);
    expect(answer["refused"], s.all).toBe(false);
    expect(String(answer["error"])).toMatch(/never registered itself/);
  }, 120_000);

  it("fails init honestly when the claim succeeds and the registration is not saved", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("init");
    // The root is saved, the claim goes out and commits, and the save that
    // would record this device's credential fails.
    failSavesAfter = 1;
    const init = await cli("init", server.setup, "--dir", dir, "--device", "init");
    expect(init.code).toBe(1);
    expect(init.all).toMatch(/could not register itself/);
    // The recovery key is printed anyway, because at that moment the secret in
    // this config is the only copy of it on this machine.
    expect(init.all).toMatch(/Write this recovery key down now/);
    const printed = init.err.join("\n").match(/(basalt3_[A-Za-z0-9_-]+)/)![1]!;
    expect((await loadConfig(dir))!.secret, "init threw the root away").toBeDefined();

    failSavesAfter = Infinity;
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", printed, "--dir", dir, "--json");
    expect(again.code, again.all).toBe(0);
    expect((await loadConfig(dir))!.secret).toBeUndefined();
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
  }, 180_000);
});
