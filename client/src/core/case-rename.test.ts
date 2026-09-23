/**
 * A rename that changed only case, arriving on a disk that folds case.
 *
 * One device renames `Note.md` to `NOTE.md` and the move reaches the server as
 * one entry, `NOTE.md` with `prev: "Note.md"`. On a receiving disk that folds
 * case, as macOS's and Windows's do, those two names are one file: the device
 * already holds the note, and what it owes is a new spelling for it, with no
 * fetch, nothing kept aside and no separate deletion.
 *
 * Applied as an ordinary download of a path this device never held, it went
 * wrong in a way that lost nothing and spread. The write of `NOTE.md` found a
 * file there it had no baseline for, the old note under its old spelling, and
 * kept it aside as a conflict copy; the deletion of `Note.md` then removed the
 * file just written, because it was the same file; the next round landed
 * `NOTE.md` again from the copy; and the copy went up to every other device.
 * Every case-only rename made a conflict copy on each such receiver. Found by
 * the headless client's clash test on macOS (cli/clash.test.ts).
 *
 * The property is where the bytes are, under which name, on each disk, and
 * that nothing else is: no copy, nothing in the trash.
 */

import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { NodeVault } from "../cli/vault.ts";
import { plainDigest } from "./digest.ts";
import { Engine, type SyncReport } from "./engine.ts";
import { receiveCommitted } from "./test-async.ts";
import { TestServer, cleanupBinary, removeTree, serverBinary, until } from "./test-server.ts";
import { Transport } from "./transport.ts";
import {
  MemoryIndexStore,
  MemoryVault,
  type ExpectedContent,
  type FileStat,
  type Replaced,
  type Times,
  type Vault,
} from "./vault.ts";

/**
 * A memory vault that files names the way a case-folding, case-preserving
 * disk does: one file per name folded, held under the spelling it was made
 * with, found under any spelling, and given a new spelling only by being
 * renamed or moved aside and made again, which is what a real adapter's
 * preserving write does to it.
 *
 * Files only, which is all these cases need; a folder keeps the exact-match
 * behaviour of the vault underneath.
 */
class CaseFoldingVault extends MemoryVault {
  private static folded(path: string): string {
    return path.normalize("NFC").toLowerCase();
  }

  /** The spelling this disk holds a file under, if it holds one by any spelling. */
  private spelling(path: string): string | undefined {
    const key = CaseFoldingVault.folded(path);
    return this.paths().find((p) => CaseFoldingVault.folded(p) === key);
  }

  /** Moves a file to a spelling of the same name, the way `mv` does on this disk. */
  async respell(to: string): Promise<void> {
    const from = this.spelling(to);
    if (from === undefined || from === to) return;
    const bytes = await super.read(from);
    const was = (await super.stat(from))!;
    await super.remove(from);
    await super.write(to, bytes, { mtime: was.mtime, ctime: was.ctime });
  }

  override async read(path: string): Promise<Uint8Array> {
    return super.read(this.spelling(path) ?? path);
  }

  override async stat(path: string): Promise<FileStat | undefined> {
    return super.stat(this.spelling(path) ?? path);
  }

  override async exists(path: string): Promise<boolean> {
    return super.exists(this.spelling(path) ?? path);
  }

  /** An overwrite keeps the name the file already has, as on a real disk. */
  override async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    await super.write(this.spelling(path) ?? path, bytes, times);
  }

  override async create(path: string, bytes: Uint8Array, times: Times): Promise<boolean> {
    if (this.spelling(path) !== undefined) return false;
    return super.create(path, bytes, times);
  }

  override async remove(path: string): Promise<void> {
    await super.remove(this.spelling(path) ?? path);
  }

  /**
   * Moves whatever is at the name aside and makes the file again under the
   * spelling asked for, which is what the adapters do: the rename aside finds
   * the file by any spelling, and the write that follows names it anew.
   */
  override async replace(
    path: string,
    expect: ExpectedContent | undefined,
    bytes: Uint8Array,
    times: Times,
    keepAt: string,
  ): Promise<Replaced> {
    await this.respell(path);
    return super.replace(path, expect, bytes, times, keepAt);
  }

  override async removeExpecting(
    path: string,
    expect: ExpectedContent | undefined,
    keepAt: string,
  ): Promise<Replaced> {
    await this.respell(path);
    return super.removeExpecting(path, expect, keepAt);
  }

  override contentDigest = async (path: string): Promise<string | undefined> => {
    const at = this.spelling(path);
    return at === undefined ? undefined : plainDigest(await super.read(at));
  };

  /** One file, whichever spelling each name uses; a name not here is no file at all. */
  async sameFile(a: string, b: string): Promise<boolean> {
    const x = this.spelling(a);
    return x !== undefined && x === this.spelling(b);
  }

  canonical(path: string): string {
    return CaseFoldingVault.folded(path);
  }
}

/** One device: a vault, an index, a transport and an engine. */
class Device {
  readonly store = new MemoryIndexStore();
  transport!: Transport;
  engine!: Engine;
  caughtUp = false;
  clock = 1_000_000;
  /** Every report this device's passes produced. */
  readonly reports: SyncReport[] = [];

  constructor(
    readonly name: string,
    readonly vault: Vault,
  ) {}

  async connect(server: TestServer): Promise<void> {
    this.caughtUp = false;
    this.transport = new Transport(server.wsUrl, {
      onBatch: (b) => this.engine.acceptBatch(b),
      onCaughtUp: () => {
        this.caughtUp = true;
      },
      timeoutMs: 20_000,
    });
    this.engine = new Engine({
      vault: this.vault,
      store: this.store,
      transport: this.transport,
      device: this.name,
      vaultId: "default",
      ...(await server.deviceCredentials(this.name)),
      // A clock that moves a minute a reading, so the write debounce never
      // decides when a sync may happen.
      now: () => (this.clock += 60_000),
    });
    await this.transport.connect();
    await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
  }

  async sync(): Promise<void> {
    await receiveCommitted(this.transport);
    this.reports.push(await this.engine.sync());
  }

  close(): void {
    this.transport?.close();
  }
}

let server: TestServer;
const devices: Device[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  if (server) await server.cleanup();
  while (dirs.length) await removeTree(dirs.pop()!);
});

async function two(make: () => Vault | Promise<Vault>): Promise<[Device, Device]> {
  server = new TestServer();
  await server.start();
  const out: Device[] = [];
  for (const name of ["a", "b"]) {
    const d = new Device(name, await make());
    devices.push(d);
    await d.connect(server);
    out.push(d);
  }
  return out as [Device, Device];
}

/** Both devices, a few rounds each, so each has heard what the other did. */
async function syncBoth(a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
}

/** Every conflict any pass on this device reported. */
const conflicts = (d: Device) => d.reports.reduce((n, r) => n + r.conflicted, 0);

/** The newest version of a path the server holds, as its history lists it. */
async function newest(d: Device, path: string) {
  const [head] = await d.transport.history(path, { limit: 1 });
  return head;
}

describe("a case-only rename, on a memory vault that folds case", () => {
  const text = "the only copy of this text\n";

  async function renamed(how: "reported" | "scanned", edited?: string) {
    const [a, b] = await two(() => new CaseFoldingVault());
    const av = a.vault as CaseFoldingVault;
    const bv = b.vault as CaseFoldingVault;
    await av.edit("Note.md", text);
    await syncBoth(a, b);
    expect(bv.snapshot()).toEqual({ "Note.md": text });

    await av.respell("NOTE.md");
    if (edited !== undefined) await av.edit("NOTE.md", edited, 5_000_000);
    if (how === "reported") a.engine.noteRename("Note.md", "NOTE.md");
    await syncBoth(a, b);
    return { a, b, av, bv };
  }

  it.each(["reported", "scanned"] as const)(
    "gives the note its new spelling on the receiver, rename %s, with nothing kept aside",
    async (how) => {
      const { a, b, av, bv } = await renamed(how);
      for (const [d, v] of [
        [a, av],
        [b, bv],
      ] as const) {
        expect(v.snapshot(), `${d.name} holds something besides the renamed note`).toEqual({
          "NOTE.md": text,
        });
        expect(conflicts(d), `${d.name} made a conflict copy of a rename`).toBe(0);
      }
      // History names the move, and the old name is retired rather than
      // deleted a second time.
      expect((await newest(b, "NOTE.md"))?.prev).toBe("Note.md");
      await expect(server.cli("cat", "-path", "Note.md")).rejects.toThrow(/deleted or renamed/);
      expect(await server.cli("cat", "-path", "NOTE.md")).toBe(text);
    },
    240_000,
  );

  it("writes an edit made with the rename over the file it recognises", async () => {
    const edited = "the only copy of this text, edited as it was renamed\n";
    const { a, b, av, bv } = await renamed("scanned", edited);
    for (const [d, v] of [
      [a, av],
      [b, bv],
    ] as const) {
      expect(v.snapshot(), `${d.name} does not hold the edited note alone`).toEqual({
        "NOTE.md": edited,
      });
      expect(conflicts(d), `${d.name} made a conflict copy of a rename`).toBe(0);
    }
    expect((await newest(b, "NOTE.md"))?.prev).toBe("Note.md");
    expect(await server.cli("cat", "-path", "NOTE.md")).toBe(edited);
  }, 240_000);
});

/** Whether a directory's filesystem folds case, asked rather than assumed. */
async function foldsCase(dir: string): Promise<boolean> {
  await writeFile(join(dir, "CaseProbe.tmp"), "probe");
  try {
    await stat(join(dir, "caseprobe.tmp"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(join(dir, "CaseProbe.tmp"), { force: true });
  }
}

/** Every file under a vault, with its text, and apart from what the client keeps for itself. */
async function onDisk(dir: string, under = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(join(dir, under), { withFileTypes: true })) {
    const path = under ? `${under}/${e.name}` : e.name;
    if (under === "" && e.name.startsWith(".")) continue;
    if (e.isDirectory()) Object.assign(out, await onDisk(dir, path));
    else out[path] = await readFile(join(dir, path), "utf8");
  }
  return out;
}

/** What the vault's trash holds, which a deletion moves a note into. */
async function trashed(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, ".trash"), { recursive: true })).map(String);
  } catch {
    return [];
  }
}

const scratch = await mkdtemp(join(tmpdir(), "trew-case-"));
const diskFolds = await foldsCase(scratch);
await rm(scratch, { recursive: true, force: true });

describe("a case-only rename, on a disk that folds case", () => {
  // Only meaningful where the disk folds: on one that keeps case apart the
  // two names are two files, and deleting the old one is right. Skipped there
  // rather than asserted either way, as the headless client's own tests do.
  it.skipIf(!diskFolds)(
    "moves the note to its new spelling on both disks, with nothing kept or trashed",
    async () => {
      const made: string[] = [];
      const [a, b] = await two(async () => {
        const dir = await mkdtemp(join(tmpdir(), "trew-case-vault-"));
        dirs.push(dir);
        made.push(dir);
        return new NodeVault(dir);
      });
      const [aDir, bDir] = made as [string, string];
      const text = "the only copy of this text\n";
      await writeFile(join(aDir, "Note.md"), text);
      await syncBoth(a, b);
      expect(await onDisk(bDir)).toEqual({ "Note.md": text });

      // Renamed on disk, as a person does it in a file manager or a shell.
      await rename(join(aDir, "Note.md"), join(aDir, "NOTE.md"));
      await syncBoth(a, b);

      for (const [d, dir] of [
        [a, aDir],
        [b, bDir],
      ] as const) {
        expect(await onDisk(dir), `${d.name} holds something besides the renamed note`).toEqual({
          "NOTE.md": text,
        });
        expect(await trashed(dir), `${d.name} put the note in its trash`).toEqual([]);
        expect(conflicts(d), `${d.name} made a conflict copy of a rename`).toBe(0);
      }
      expect((await newest(b, "NOTE.md"))?.prev).toBe("Note.md");
    },
    240_000,
  );
});
