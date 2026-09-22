/**
 * One telimus per vault, decided by the kernel rather than by this program.
 *
 * Automatic stale-lock takeover was attempted five times and four of those
 * handed one vault to two writers (R03, R20, R34, R40, R44/R49). Every attempt
 * was a different arrangement of the same missing primitive: "the holder is
 * dead, so I may have it" is a conclusion drawn from an observation, and
 * between the observation and the act the holder can be alive again. Nothing
 * in POSIX closes that, so `telimus unlock` was made a person's job instead.
 *
 * That was the conservative answer, not the destination. The way out is not a
 * better staleness protocol; it is not having staleness, which is what an
 * exclusion the kernel drops on process exit gives. There is nothing to
 * detect, nothing to time out, and nothing to decide.
 *
 * `docs/compared.md` used to say this had to wait for Node to grow a portable
 * file lock. Measured, that is wrong. Both supported platforms already offer
 * one from stock Node with no native addon and no build step, and both were
 * probed with a `SIGKILL`ed holder before a line of this was written:
 *
 *   - **macOS**: `open()` with `O_EXLOCK`, which takes a `flock`-style lock as
 *     part of the open. A second open refuses with `EAGAIN`. Node does not
 *     name the flag, so it is spelled as the number macOS's `<sys/fcntl.h>`
 *     gives it.
 *   - **Linux**: an abstract Unix socket, whose name lives in a kernel
 *     namespace rather than on a filesystem, so there is no file to be left
 *     behind. A second bind refuses with `EADDRINUSE`.
 *
 * Two mechanisms is a liability of its own, and the answer to it is that they
 * are asked the same question and answer it the same way: took it, or somebody
 * else has it. Everything above this file sees one interface, and neither
 * implementation has a staleness rule to get wrong.
 *
 * What neither covers is a holder on another machine. A kernel is one machine,
 * so a vault on a disk two machines can reach is outside all of this, and the
 * lock file's `host` is still what answers it.
 */

import { createHash } from "node:crypto";
import { constants, open as openFd, rm, type FileHandle } from "node:fs/promises";
import net from "node:net";
import { platform } from "node:process";
import { join } from "node:path";

/**
 * `O_EXLOCK`, from macOS's `<sys/fcntl.h>`.
 *
 * Node does not put this in `fs.constants`, so it is written down here with
 * where it came from. It is part of the platform's stable ABI rather than
 * something that moves, and `selfTest` proves it still means what this says
 * before anything relies on it, which is the real protection.
 */
const O_EXLOCK = 0x0020;

/** Somebody else has it. Not an error: the ordinary answer to a busy vault. */
export const BUSY = Symbol("another process holds this vault");

/**
 * Every exclusion this process is holding, kept alive on purpose.
 *
 * Not bookkeeping. A `FileHandle` is closed by a finalizer when it becomes
 * unreachable, so an exclusion whose only reference was the closure inside a
 * release function the caller happened to discard could be *collected*, and
 * collecting it drops the lock while the process is still running and still
 * writing. Bun's own warning about a handle being garbage collected is what
 * found this, in a probe that ignored the return value of `lockVault` -- which
 * is a thing a caller is allowed to do.
 *
 * So the lifetime of a lock is the lifetime of the process, which is the whole
 * property this file exists to provide, and it must not depend on anybody
 * keeping a variable alive.
 */
const held = new Set<unknown>();

/**
 * A local exclusion, held until released or until the process dies.
 *
 * "Local" is the whole scope. A kernel answers for one machine, so this says
 * nothing about a second machine reaching the same disk.
 */
export interface Exclusion {
  /** What took it, for a diagnostic that has to say how this was decided. */
  readonly how: string;
  release(): Promise<void>;
}

export interface Mechanism {
  readonly how: string;
  /**
   * Takes the exclusion for `vault`, or returns `BUSY`.
   *
   * `at` is a path inside the vault's state folder that the mechanism may use.
   * Whether it does is its own business: one of these locks a file and the
   * other does not touch the filesystem at all.
   */
  take(vault: string, at: string): Promise<Exclusion | typeof BUSY>;
}

/**
 * `O_EXLOCK` on a file of its own, beside the lock rather than on it.
 *
 * Locking the holder file directly was tried first and is worse. `O_CREAT`
 * makes an empty file and the holder is written after, so there is an instant
 * where the lock exists and names nobody -- which is the exact window an
 * earlier version of this module was wrong in, and which `lock.test.ts` still
 * asserts against. Keeping the kernel's file separate leaves the holder file
 * published whole or not at all, and means nothing ever reads this one.
 */
const openLock: Mechanism = {
  how: "O_EXLOCK",
  async take(_vault, at) {
    let handle: FileHandle;
    try {
      handle = await openFd(
        at,
        constants.O_CREAT | constants.O_RDWR | O_EXLOCK | constants.O_NONBLOCK,
        0o600,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EAGAIN is the refusal this is for. EWOULDBLOCK is the same number on
      // every platform that has both, and is spelled either way depending on
      // libc, so both are named rather than assumed to be one.
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return BUSY;
      throw err;
    }
    held.add(handle);
    return {
      how: openLock.how,
      // Closing the descriptor is what drops the lock. So is dying, which is
      // the entire point of using this rather than a protocol.
      release: async () => {
        held.delete(handle);
        await handle.close().catch(() => undefined);
      },
    };
  },
};

/**
 * An abstract Unix socket, named after the vault.
 *
 * Abstract rather than a socket file: the name lives in a kernel namespace and
 * has no directory entry, so a killed holder leaves nothing behind to be
 * mistaken for a live one. A socket *file* would have exactly the staleness
 * problem this is here to avoid.
 *
 * Named from whatever string the caller passes, which must therefore be the
 * vault's *resolved* path: this name is the entire exclusion, so two ways of
 * saying one vault have to produce one name. `takeLocally` resolves it, and
 * before it did, a symlink to a vault and a trailing slash each got a name of
 * their own and each admitted a second writer. Hashed because `sun_path` is
 * 108 bytes and a vault path is not bounded by that.
 */
const abstractSocket: Mechanism = {
  how: "abstract socket",
  async take(vault) {
    const name = `\0telimus.${createHash("sha256").update(vault).digest("hex").slice(0, 32)}`;
    const server = net.createServer();
    // It must not hold the process open. The command finishing is a perfectly
    // good reason for the vault to become free.
    server.unref();
    const taken = await new Promise<boolean | Error>((done) => {
      server.once("error", (err: NodeJS.ErrnoException) =>
        done(err.code === "EADDRINUSE" ? false : err),
      );
      server.listen(name, () => done(true));
    });
    if (taken instanceof Error) throw taken;
    if (!taken) return BUSY;
    held.add(server);
    return {
      how: abstractSocket.how,
      release: async () => {
        held.delete(server);
        await new Promise<void>((done) => {
          server.close(() => done());
        });
      },
    };
  },
};

/**
 * The mechanism for this platform, or undefined where there is not one.
 *
 * Undefined is a real answer and the caller has to handle it: everything falls
 * back to the file-only protocol and to `telimus unlock`, which is slower to
 * recover and is not wrong.
 */
export function mechanismFor(os: string = platform): Mechanism | undefined {
  if (pretendThereIsNone.on) return undefined;
  if (os === "darwin") return openLock;
  if (os === "linux") return abstractSocket;
  return undefined;
}

/**
 * Makes this platform look like one with no kernel exclusion.
 *
 * For tests, and not only for convenience. The file-only protocol is what runs
 * on an unsupported platform and on a filesystem where the mechanism does not
 * hold, so it is real code with real users and it has to stay tested; without
 * this, every test of it would silently exercise the kernel path instead and
 * pass for the wrong reason.
 */
export const pretendThereIsNone = { on: false };

/**
 * Proves the mechanism really excludes, here, now, on this vault's filesystem.
 *
 * Not ceremony. `O_EXLOCK` is advisory and a filesystem may ignore it -- which
 * is exactly what a network mount does, and a network mount is the case where
 * believing it would be worst. The consequence of a mechanism that quietly
 * does not exclude is not a missed optimisation: the protocol above treats
 * holding it as proof that no other local process is inside, and would then
 * write over a live holder's record. So it is checked rather than assumed
 * (rule 4), against a name in the vault's own state folder so the answer is
 * about the filesystem the vault is really on.
 *
 * The probe runs inside one process, which is enough for both mechanisms:
 * `flock` is per open file description and an abstract socket name is bound
 * once, so a second attempt from here refuses exactly as another process
 * would.
 */
export async function selfTest(m: Mechanism, stateDir: string): Promise<boolean> {
  // A fresh name per probe, and this is not tidiness. The first version named
  // it after the pid, so two acquisitions in one process probed the *same*
  // name at the same time, the second saw the first's probe and reported that
  // the filesystem does not lock. Both then fell back to the file, and two
  // callers came back holding one vault -- the defect this whole file exists
  // to remove, reintroduced by the check for it.
  const id = createHash("sha256")
    .update(`${process.pid}.${Math.random()}`)
    .digest("hex")
    .slice(0, 16);
  const probe = join(stateDir, `exclusion-probe.${id}`);
  const vault = `${probe}#probe`;
  let first: Exclusion | typeof BUSY;
  try {
    first = await m.take(vault, probe);
  } catch {
    return false;
  }
  if (first === BUSY) return false;
  try {
    const second = await m.take(vault, probe).catch(() => BUSY);
    return second === BUSY;
  } finally {
    await first.release();
    // Only `O_EXLOCK` leaves a file, and only the one it just made.
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

/**
 * The same, once per state folder for the life of the process.
 *
 * It answers a question about a filesystem, and a filesystem does not change
 * under a running command. Cached by the promise rather than the result so
 * that concurrent acquisitions share one probe instead of racing several.
 */
const proven = new Map<string, Promise<boolean>>();

export function provenFor(m: Mechanism, stateDir: string): Promise<boolean> {
  const key = `${m.how}\u0000${stateDir}`;
  let answer = proven.get(key);
  if (answer === undefined) {
    answer = selfTest(m, stateDir);
    proven.set(key, answer);
  }
  return answer;
}

/** Forgets what was proven, for a test that changes the filesystem underneath. */
export function forgetProven(): void {
  proven.clear();
}
