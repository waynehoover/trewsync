/**
 * A real `cmd/trewd` for tests to talk to.
 *
 * Not a mock and not a fixture in the usual sense: it builds the Go binary and
 * runs it. Imported by the test files rather than living in one of them, because
 * two of them need it and a second copy would drift.
 *
 * This file is only ever imported from tests, so nothing it pulls in reaches a
 * shipped bundle.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { deferred, within } from "./test-async.ts";
import { base64urlEncode } from "./digest.ts";
import { parseInviteString } from "./invite-string.ts";
import { generateDeviceId, generateDeviceToken } from "./pairing.ts";
import { Transport } from "./transport.ts";

const run = promisify(execFile);
const GO_DIR = new URL("../../..", import.meta.url).pathname;

let built: Promise<string> | undefined;
let buildDir: string | undefined;

/**
 * The server binary, built once.
 *
 * `vitest.global-setup.ts` builds it before any worker starts and names it in
 * the environment, which is the ordinary path. The fallback below builds one
 * here, for a file run outside that setup.
 *
 * Built rather than assumed present either way: a test that silently skips
 * because it could not find the server is a test that reports success for
 * having done nothing.
 */
export function serverBinary(): Promise<string> {
  const shared = process.env["TREW_TEST_BINARY"];
  if (shared) return Promise.resolve(shared);
  built ??= (async () => {
    buildDir = await mkdtemp(join(tmpdir(), "trew-bin-"));
    const binary = join(buildDir, "trewd");
    await run("go", ["build", "-o", binary, "./cmd/trewd"], {
      cwd: GO_DIR,
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    return binary;
  })();
  return built;
}

/**
 * Removes a binary this file built.
 *
 * Never the shared one: it belongs to the whole run, and a file that deleted it
 * on its way out would break every other file still using it. That is not
 * hypothetical, it is what happens when several files run at once.
 */
export async function cleanupBinary(): Promise<void> {
  if (process.env["TREW_TEST_BINARY"]) return;
  if (buildDir) await removeTree(buildDir);
  buildDir = undefined;
  built = undefined;
}

/**
 * Removes a directory tree, retrying the races a parallel suite creates.
 *
 * `rm` lists a directory and then removes it, and with twenty-one test files
 * running at once against the same /tmp it can find the tree repopulated in
 * between and throw ENOTEMPTY. Every teardown goes through here so the next one
 * written gets the retries without anybody remembering to ask.
 *
 * The retries are counted rather than done by `rm` itself, because the question
 * worth answering was whether something of ours was still writing after a
 * command returned. That would be a real durability bug and retries would hide
 * it. Measured over six full runs, with TREW_RM_STATS set:
 *
 *   1836 removes, 1834 on the first attempt, 2 on the second, 0 failures
 *
 * Two in eighteen hundred, and never more than one retry. A write of ours still
 * in flight would not clear that fast or that reliably; a directory listing
 * losing a race with another test's does. That matches the code, where save()
 * is awaited, a sync is awaited before close(), close() is synchronous, and
 * neither the CLI nor the engine leaves work running.
 *
 * Keep the counting. It is what turns "the suite went green" into knowing why.
 */
const RETRYABLE = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EMFILE", "ENFILE"]);

export async function removeTree(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      // No built-in retries: this loop is doing them, so that it can say
      // how often the race actually happens rather than absorbing it
      // silently. Set TREW_RM_STATS to a file to find out.
      await rm(path, { recursive: true, force: true });
      note(`${attempt}\t${path}`);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= 8) {
        note(`FAILED after ${attempt} on ${code}\t${path}`);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

/** Appends one line per remove when asked, so the retries can be counted. */
function note(line: string): void {
  const file = process.env["TREW_RM_STATS"];
  if (file) appendFileSync(file, `${line}\n`);
}

/** One server, on its own port, with its own data directory. */
export class TestServer {
  private proc: ChildProcess | undefined;
  dataDir = "";
  port = 0;
  readonly stderr: string[] = [];

  /**
   * Starts a server, retrying if the port turned out to be taken.
   *
   * Ports come from the operating system rather than from a random number,
   * because several test files run at once and each starts servers. A random
   * port in a range collides eventually, and when it does the failure lands on
   * whichever test happened to be running: a suite that fails somewhere
   * different each time is a suite people stop believing.
   *
   * There is still a gap between releasing the port and binding it, so this
   * retries rather than pretending the gap is closed.
   */
  /**
   * Starts the server, optionally back on the port it had.
   *
   * The port matters when a test restarts a server its clients are still
   * pointed at, which is what recovering from a crash looks like from a
   * device: the same address, the same data directory, a new process.
   */
  /**
   * Extra flags for `serve`, for a test that needs a server with a different
   * limit. Set before `start`.
   */
  extraArgs: string[] = [];

  /**
   * A build of the server to run instead of the shared one, for a test that
   * needs a build of its own: the crash matrix's, made with `-tags
   * crashmatrix` (cmd/trewd/testseam.go). Set before `start`.
   */
  binary: string | undefined;

  /**
   * Environment added to the server's own at the next `start`, such as the
   * crash build's TREW_TEST_SEAM. The server's stdin is empty, so a write
   * held at that seam stays there until the process is killed.
   */
  env: Record<string, string> = {};

  async start(samePort?: number): Promise<void> {
    let last: Error | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.startOnce(samePort);
        return;
      } catch (err) {
        last = err as Error;
        await this.stop();
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw new Error(`server would not start after four attempts: ${last?.message}`);
  }

  private async startOnce(fixedPort?: number): Promise<void> {
    const binary = this.binary ?? (await serverBinary());
    if (!this.dataDir) this.dataDir = await mkdtemp(join(tmpdir(), "trew-data-"));
    this.port = fixedPort ?? (await freePort());
    this.stderr.length = 0;
    // `-url` so every invite this server mints, the first one included, names
    // the address the tests dial rather than a wss:// address with no TLS in
    // front of it.
    this.proc = spawn(
      binary,
      [
        "serve",
        "-data",
        this.dataDir,
        "-addr",
        `127.0.0.1:${this.port}`,
        "-url",
        `ws://127.0.0.1:${this.port}`,
        ...this.extraArgs,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // A seam only when this server was given one, never from the runner.
        env: { ...process.env, TREW_TEST_SEAM: undefined, ...this.env },
      },
    );
    this.proc.stderr?.on("data", (b: Buffer) => this.stderr.push(b.toString()));

    // The banner is printed only after the listener is bound. Use that event
    // instead of opening a health connection every 50 ms during startup.
    const listening = deferred();
    const proc = this.proc;
    let banner = "";
    const output = (data: Buffer) => {
      banner += data.toString();
      if (/^trewd .* listening on /m.test(banner)) listening.resolve();
    };
    const exited = (code: number | null) =>
      listening.reject(new Error(`server exited with ${code}: ${this.stderr.join("")}`));
    const failed = (error: Error) => listening.reject(error);
    proc.stdout!.on("data", output);
    proc.once("exit", exited);
    proc.once("error", failed);
    try {
      await within(listening.promise, "the test server to listen", 30_000);
    } finally {
      proc.stdout!.off("data", output);
      proc.off("exit", exited);
      proc.off("error", failed);
    }
    const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`server health check failed: ${res.status}`);
  }

  /**
   * Stops the server, runs something that needs the directory to itself, and
   * starts again on the same port.
   *
   * `purge` and `backup` take the data directory's exclusive lock, so they
   * cannot run against a live server, which is the whole point of the lock.
   * The port is kept because a client's stored config names it, and a test
   * that had to re-pair afterwards would be testing the re-pairing.
   */
  async whileStopped(fn: () => Promise<void>): Promise<void> {
    const port = this.port;
    await this.stop();
    try {
      await fn();
    } finally {
      await this.startOnce(port);
    }
  }

  /**
   * A fresh invite for this server's vault, minted by `trewd invite` through
   * the running server's control socket, exactly as an operator mints one.
   *
   * `ttl` is the command's own flag, a Go duration such as `1h` or `0` for an
   * invite that never expires; absent is the server's default of an hour.
   */
  async invite(opts: { ttl?: string; label?: string } = {}): Promise<string> {
    const out = await this.cli(
      "invite",
      ...(opts.ttl !== undefined ? ["-ttl", opts.ttl] : []),
      ...(opts.label !== undefined ? ["-label", opts.label] : []),
    );
    const found = /trew1i_[A-Za-z0-9_-]+/.exec(out);
    if (!found) throw new Error(`trewd invite printed no invite: ${out}`);
    return found[0];
  }

  /** Where `serve` wrote the first device's invite, on a store with no devices. */
  get firstInvitePath(): string {
    return join(this.dataDir, "first-invite");
  }

  /** The first device's invite, as `serve` wrote it: the first line of the file. */
  async firstInvite(): Promise<string> {
    const text = await readFile(this.firstInvitePath, "utf8");
    const line = text.split("\n").find((l) => l.trim() !== "");
    if (line === undefined) throw new Error(`${this.firstInvitePath} holds no invite`);
    return line.trim();
  }

  /**
   * Adds a device to the vault and returns what its hello needs.
   *
   * Every test that connects goes through here, because a hello has to name a
   * row that exists. It pairs the way a device does: an invite minted with
   * `trewd invite`, then a redemption carrying a fresh id and a fresh 32-byte
   * token (plan/protocol.md, "Invite redemption"). Doing it in one place is
   * what keeps two dozen test files from each having their own idea of how a
   * device comes to exist, which is how a harness ends up testing a server
   * that does not exist.
   */
  async deviceCredentials(device = "test"): Promise<{ deviceId: string; token: string }> {
    const invite = parseInviteString(await this.invite());
    const deviceId = generateDeviceId();
    const token = generateDeviceToken();
    const transport = new Transport(invite.url, { onBatch: () => {}, timeoutMs: 15_000 });
    try {
      await transport.connect();
      await transport.redeem({
        vault: invite.vault,
        device,
        invite: base64urlEncode(invite.token),
        deviceId,
        token,
      });
    } finally {
      transport.close();
    }
    return { deviceId, token };
  }

  async stop(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      const ended = new Promise<void>((resolve) => this.proc!.once("exit", () => resolve()));
      this.proc.kill("SIGTERM");
      try {
        await within(ended, "the test server to exit");
      } catch (error) {
        this.proc.kill("SIGKILL");
        await within(ended, "the test server to exit after SIGKILL");
        throw error;
      }
    }
    this.proc = undefined;
  }

  /**
   * Kills the server outright, the way a power cut does.
   *
   * `stop` sends SIGTERM and the server shuts down: it finishes what it holds
   * and closes the store. That is not the case durability rule 1 is about. An
   * ack means the body and the entry are both committed, and the only way to
   * find out whether that is true is to take the process away without asking.
   */
  async kill(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      const ended = new Promise<void>((resolve) => this.proc!.once("exit", () => resolve()));
      this.proc.kill("SIGKILL");
      await within(ended, "the test server to exit");
    }
    this.proc = undefined;
  }

  /** How many versions this server has committed, read from its own log. */
  committed(): number {
    return (this.stderr.join("").match(/msg=committed/g) ?? []).length;
  }

  async cleanup(): Promise<void> {
    await this.stop();
    if (this.dataDir) await removeTree(this.dataDir);
  }

  /**
   * Runs a maintenance subcommand against this server's data directory.
   *
   * `-data DIR` goes straight after the subcommand's name rather than at the
   * end. Go's flag package stops at the first positional argument, so behind
   * an id, as in `cli("uninvite", id)` or `cli("revoke", id)`, it was read as
   * two more positional arguments and the command refused for having three.
   * Flags are read in any order, so every other subcommand is unaffected.
   */
  async cli(...args: string[]): Promise<string> {
    const binary = await serverBinary();
    const [command, ...rest] = args;
    const { stdout } = await run(
      binary,
      command === undefined ? ["-data", this.dataDir] : [command, "-data", this.dataDir, ...rest],
    );
    return stdout;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }
}

/** Waits for a condition rather than sleeping a guessed interval. */
export async function until(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A port nothing is listening on, chosen by the operating system.
 *
 * Binding to port 0 and reading back what was assigned, then letting go of it.
 * Not race-free, which is why `start` retries, but far better than picking a
 * number and hoping: with several test files running at once, hoping fails
 * regularly and blames whichever test was unlucky.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
    });
  });
}
