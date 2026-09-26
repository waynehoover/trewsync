/**
 * Two engines, two vaults, one real server.
 *
 * This is the test the whole client exists to pass, and the one rule 10 of
 * docs/design.md warns about: it records a conflict test that asserted the two
 * devices *agreed*, and passed while one side's edit had silently vanished.
 * Agreement is not the property. Not losing an edit is.
 *
 * So the assertions here are about edits, by name, and where they ended up. The
 * vaults are in memory and everything else is real: real chunking, real framing,
 * a real WebSocket, a real Go server writing real SQLite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { deferred, receiveCommitted } from "./test-async.ts";

import {
  Engine,
  OWN_LIMITS,
  answeredVersion,
  boundedBy,
  contentId,
  refuseIfBehind,
  type SyncReport,
} from "./engine.ts";
import { chunkBytes, sizesFor } from "./chunk.ts";
import { NAME_WINDOW, chunkName, chunkNames } from "./digest.ts";
import { decodeFrame } from "./frame.ts";
import { ConnectionError, LOCAL_MAX_CHUNK_BYTES, ProtocolError, Transport } from "./transport.ts";
import { engineOnFakeSocket, settleUntil } from "./fake-socket.ts";
import { MemoryIndexStore, MemoryVault, type FileStat, type Times } from "./vault.ts";
import { conflictCopyPath } from "./merge.ts";
import { firstFreeName, ignoredHereError, neverSync } from "./paths.ts";
import type { IndexEntry } from "./index-state.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/** One device: an in-memory vault, an index, a transport and an engine. */
class Device {
  readonly store = new MemoryIndexStore();
  transport!: Transport;
  engine!: Engine;
  /** Every batch this device has been handed, for asserting on the wire. */
  readonly batches: { from: number; to: number; entries: unknown[] }[] = [];
  caughtUp = false;
  clock = 1_000_000;
  /**
   * How far the clock moves per reading.
   *
   * Sixty seconds by default, so the size-scaled write debounce never decides
   * when a sync may happen. A test that is about a computed deadline sets it
   * to zero, so the deadline can be compared against the reading it was
   * computed from rather than against a moving target.
   */
  step = 60_000;

  constructor(
    readonly name: string,
    /** Injectable, for a vault that misbehaves in a particular way. */
    readonly vault: MemoryVault = new MemoryVault(),
  ) {}

  /** How many batches carried entries, which is how many times a peer wrote. */
  get batchesWithEntries(): number {
    return this.batches.filter((b) => b.entries.length > 0).length;
  }

  async connect(server: TestServer, log?: (message: string) => void): Promise<void> {
    this.caughtUp = false;
    this.transport = new Transport(server.wsUrl, {
      onBatch: async (b) => {
        this.batches.push(b);
        await this.engine.acceptBatch(b);
      },
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
      // A clock the test advances, so the size-scaled write debounce does
      // not decide when a sync may happen.
      now: () => (this.clock += this.step),
      ...(log ? { log } : {}),
    });
    await this.transport.connect();
    await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
  }

  /** Syncs until nothing more changes, which is what a settled device looks like. */
  async settle(rounds = 4): Promise<SyncReport> {
    let last = await this.engine.sync();
    for (let i = 1; i < rounds; i++) {
      // Let anything the server relayed arrive before deciding again.
      await receiveCommitted(this.transport);
      last = await this.engine.sync();
    }
    return last;
  }

  close(): void {
    this.transport?.close();
  }
}

let server: TestServer;
const devices: Device[] = [];

async function fresh(): Promise<TestServer> {
  server = new TestServer();
  await server.start();
  return server;
}

async function device(
  name: string,
  log?: (message: string) => void,
  vault?: MemoryVault,
): Promise<Device> {
  const d = new Device(name, vault);
  devices.push(d);
  await d.connect(server, log);
  return d;
}

/** A vault whose read of one path waits until the test says go. */
class GatedVault extends MemoryVault {
  gate: Promise<void> = Promise.resolve();
  gatePath = "";
  onRead?: () => void;
  override async read(path: string): Promise<Uint8Array> {
    if (path === this.gatePath) {
      this.onRead?.();
      await this.gate;
    }
    return super.read(path);
  }
}

/**
 * A vault that is edited the instant the engine finishes looking at a path.
 *
 * `stat` answers with the shape it found and *then* writes, so the caller
 * gets a true reading of the file as it was and the file is different by the
 * time the caller acts on it. That is the F01 window made deterministic: no
 * timing, no sleeps, and exactly the ordering a person saving in the editor
 * produces while the other side of a merge is on the wire.
 */
class EditsAfterLooking extends MemoryVault {
  armed = "";
  text_ = "";
  override async stat(path: string): Promise<FileStat | undefined> {
    const was = await super.stat(path);
    if (this.armed !== "" && path === this.armed) {
      this.armed = "";
      await this.write(path, new TextEncoder().encode(this.text_), { mtime: 99_000, ctime: 1000 });
    }
    return was;
  }
}

/**
 * A memory vault told to leave one folder alone, the way `--ignore` and the
 * plugin's skip list tell the real ones: the name is not listed and a write
 * under it is refused as ignored rather than as a failure.
 */
class SkippingVault extends MemoryVault {
  constructor(private readonly skip: string) {
    super();
  }
  private skipped(path: string): boolean {
    return path.split("/").includes(this.skip);
  }
  override async list(): Promise<FileStat[]> {
    return (await super.list()).filter((stat) => !this.skipped(stat.path));
  }
  override async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    if (this.skipped(path)) throw ignoredHereError(`not writing under ${this.skip}: ${path}`);
    return super.write(path, bytes, times);
  }
  override async mkdir(path: string): Promise<void> {
    if (this.skipped(path)) throw ignoredHereError(`not writing under ${this.skip}: ${path}`);
    return super.mkdir(path);
  }
}

/** A memory vault that folds case on remove, the way APFS and NTFS do. */
class FoldingVault extends MemoryVault {
  override async remove(path: string): Promise<void> {
    const lower = path.toLowerCase();
    for (const p of this.paths()) if (p.toLowerCase() === lower) await super.remove(p);
  }
  async sameFile(a: string, b: string): Promise<boolean> {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/**
 * A memory vault that files names the way a folding disk does: one file per
 * case-folded, NFC-normalised name, so writing `note.md` over `Note.md`
 * replaces it, and reading either spelling finds it.
 */
class AliasingVault extends MemoryVault {
  private fold(path: string): string {
    return path.normalize("NFC").toLowerCase();
  }
  private spelledAs(path: string): string | undefined {
    const key = this.fold(path);
    return this.paths().find((p) => this.fold(p) === key);
  }
  override async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    const there = this.spelledAs(path);
    if (there !== undefined && there !== path) await super.remove(there);
    await super.write(path, bytes, times);
  }
  override async read(path: string): Promise<Uint8Array> {
    return super.read(this.spelledAs(path) ?? path);
  }
  override async exists(path: string): Promise<boolean> {
    return this.spelledAs(path) !== undefined || super.exists(path);
  }
  override async remove(path: string): Promise<void> {
    const there = this.spelledAs(path);
    if (there !== undefined) await super.remove(there);
  }
  async sameFile(a: string, b: string): Promise<boolean> {
    return this.fold(a) === this.fold(b);
  }
}

/**
 * A memory vault on a disk that keeps case apart, the way ext4 does, and says
 * so. A plain `MemoryVault` cannot say, and the engine then folds everything,
 * which is the safe fallback and not what Linux does.
 */
class CaseKeepingVault extends MemoryVault {
  canonical(path: string): string {
    return path.normalize("NFC");
  }
  async sameFile(a: string, b: string): Promise<boolean> {
    return a === b;
  }
}

/**
 * A memory vault where the first free name a caller finds is taken by somebody
 * else before the caller writes to it. What an editor saving, or another
 * process, does in the gap between `exists` and `write`.
 */
class RacyVault extends MemoryVault {
  /** Paths whose free name gets taken behind the caller's back. */
  raceOn = (path: string) => path.includes("Conflicted copy") || path.includes("(restored");
  raced: string[] = [];
  override async exists(path: string): Promise<boolean> {
    const was = await super.exists(path);
    if (!was && this.raceOn(path) && this.raced.length === 0) {
      this.raced.push(path);
      // Reported free, and then taken, before the caller can act on it.
      await super.write(path, new TextEncoder().encode(`somebody else's ${path}\n`), {
        mtime: 1,
        ctime: 1,
      });
    }
    return was;
  }
}

/**
 * A memory vault told to leave one folder alone, the way `--ignore` tells a
 * headless client to. It refuses the write with the code the engine reads.
 */
class IgnoringVault extends MemoryVault {
  constructor(private readonly folder: string) {
    super();
  }
  private refuse(path: string): void {
    if (path.split("/").includes(this.folder)) {
      throw ignoredHereError(`not writing under a name this device does not sync: ${path}`);
    }
  }
  override async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    this.refuse(path);
    await super.write(path, bytes, times);
  }
  // The folder too, as a real vault does: both shells answer the ignore list
  // in `resolve`, which every write goes through whatever it is writing.
  override async mkdir(path: string): Promise<void> {
    this.refuse(path);
    await super.mkdir(path);
  }
}

/** A memory vault that will not open certain files, with a code nothing retries. */
class RefusingVault extends MemoryVault {
  readonly refuse = new Set<string>();
  override async read(path: string): Promise<Uint8Array> {
    if (this.refuse.has(path)) throw neverSync(`this vault will not open ${path}`);
    return super.read(path);
  }
}

/** Everything both devices hold, joined, for asking whether a text survived anywhere. */
function everywhere(...ds: Device[]): string {
  return ds.flatMap((d) => Object.values(d.vault.snapshot())).join("\n---\n");
}

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  if (server) await server.cleanup();
});

/** Syncs both devices repeatedly until each has seen the other's work. */
/**
 * Two files of megabytes are the same bytes, and where they differ if not.
 *
 * `toEqual` walks a typed array through its generic deep equality one element
 * at a time, and on a 9 MiB file that takes more than the 2 GB heap Node gets
 * on a CI runner: the worker died of it and took the rest of this file with
 * it. A byte comparison says the same thing, and a failure still says where.
 */
function expectSameBytes(got: Uint8Array, want: Uint8Array, message?: string): void {
  const prefix = message ? `${message}: ` : "";
  expect(got.length, `${prefix}the length`).toBe(want.length);
  if (
    Buffer.from(got.buffer, got.byteOffset, got.byteLength).equals(
      Buffer.from(want.buffer, want.byteOffset, want.byteLength),
    )
  )
    return;
  let at = 0;
  while (got[at] === want[at]) at++;
  expect.fail(
    `${prefix}the bytes differ first at offset ${at}: ${got[at]} where ${want[at]} was expected`,
  );
}

async function convergeBoth(a: Device, b: Device, rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await a.engine.sync();
    await receiveCommitted(b.transport);
    await b.engine.sync();
    await receiveCommitted(a.transport);
  }
  await a.engine.sync();
  await receiveCommitted(b.transport);
  await b.engine.sync();
}

describe("one device", () => {
  it("uploads what is in the vault and says what it sent", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("notes/one.md", "# One\n\nSome content.\n");
    await a.vault.edit("notes/two.md", "# Two\n\nOther content.\n");

    const report = await a.engine.sync();
    // Three, not two: the folder the notes live in is an entry of its own,
    // which is how a device that has never seen the vault learns the
    // structure rather than inferring it from paths.
    expect(report.uploaded).toBe(3);
    expect(report.foldersCreated).toBe(0);
    expect(report.chunksSent).toBeGreaterThan(0);
    expect(report.bytesSent).toBeGreaterThan(0);

    // The server agrees that what it stored can be served.
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 120_000);

  it("uploads nothing on a second pass", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "content");
    await a.engine.sync();

    const second = await a.engine.sync();
    expect(second.uploaded).toBe(0);
    expect(second.chunksSent).toBe(0);
    expect(second.bytesSent).toBe(0);
  }, 120_000);

  it("sends only the chunks an edit changed", async () => {
    await fresh();
    const a = await device("a");
    let text = "";
    for (let i = 0; i < 2000; i++) text += `Line ${i} of a long note with several words.\n`;
    await a.vault.edit("long.md", text);
    const first = await a.engine.sync();

    const at = text.indexOf("\n", Math.floor(text.length / 3)) + 1;
    await a.vault.edit("long.md", text.slice(0, at) + "An inserted line.\n" + text.slice(at));
    const second = await a.engine.sync();

    expect(second.uploaded).toBe(1);
    expect(second.chunksSent).toBeLessThanOrEqual(3);
    // The ratio rather than two absolute figures. What the design claims is
    // that an edit costs a fraction of the file, and that claim should not
    // have to be restated every time a chunk size changes.
    expect(
      second.bytesSent * 8,
      `the first sync sent ${first.bytesSent} bytes and one edit cost ${second.bytesSent}`,
    ).toBeLessThan(first.bytesSent);
  }, 120_000);

  it("sends nothing for a second file with the same content", async () => {
    await fresh();
    const a = await device("a");
    const content = "# Shared\n\nThe very same words.\n";
    await a.vault.edit("a.md", content);
    await a.engine.sync();

    await a.vault.edit("b.md", content);
    const second = await a.engine.sync();
    expect(second.uploaded).toBe(1);
    expect(second.chunksSent).toBe(0);
  }, 120_000);

  it("keeps its index across a restart and re-uploads nothing", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "content");
    await a.engine.sync();
    const cursorBefore = a.engine.status().cursor;
    a.close();

    // Same vault, same index store, new engine and connection.
    const again = new Device("a");
    devices.push(again);
    Object.assign(again, { vault: a.vault, store: a.store });
    await again.connect(server);
    const report = await again.engine.sync();

    expect(report.uploaded).toBe(0);
    expect(report.chunksSent).toBe(0);
    expect(again.engine.status().cursor).toBe(cursorBefore);
  }, 120_000);
});

describe("two devices", () => {
  it("carries a file from one to the other", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("notes/hello.md", "# Hello\n\nFrom device a.\n");
    await convergeBoth(a, b);

    expect(b.vault.text("notes/hello.md")).toBe("# Hello\n\nFrom device a.\n");
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
  }, 180_000);

  it("carries a vault of several files both ways", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    for (let i = 0; i < 5; i++) await a.vault.edit(`from-a/${i}.md`, `written on a, number ${i}\n`);
    for (let i = 0; i < 5; i++) await b.vault.edit(`from-b/${i}.md`, `written on b, number ${i}\n`);

    await convergeBoth(a, b, 6);

    // Every edit, by name, on both sides. Not "the two agree".
    for (let i = 0; i < 5; i++) {
      expect(a.vault.text(`from-b/${i}.md`), `a is missing b's file ${i}`).toBe(
        `written on b, number ${i}\n`,
      );
      expect(b.vault.text(`from-a/${i}.md`), `b is missing a's file ${i}`).toBe(
        `written on a, number ${i}\n`,
      );
    }
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  }, 240_000);

  it("carries an edit to a file both devices already have", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "first version\n");
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe("first version\n");

    await a.vault.edit("note.md", "second version\n");
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe("second version\n");
  }, 240_000);
});

describe("an acknowledgement lost after the server committed the write", () => {
  /**
   * The one head a device is never told (R083-01).
   *
   * The server broadcasts a device's own commit back to it as an empty batch:
   * the cursor advance without the payload, because the device already has the
   * bytes. So if the connection drops between that echo and the reply to the
   * `putmany`, the device saves a cursor above an entry it will never be shown.
   * Catch-up starts above it, `remote` keeps the version before it, and every
   * upload of that path is refused as out of date, including every later edit.
   *
   * Reproduced exactly there: the real reply is taken from the wire and thrown
   * away after the echo has been applied, which is what a socket closing in
   * that window looks like from inside the engine.
   */
  it("does not strand the path as stale forever", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "first version\n");
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe("first version\n");

    // The write whose acknowledgement is lost.
    await a.vault.edit("note.md", "second version\n");
    const putMany = a.transport.putMany.bind(a.transport);
    let dropped = 0;
    a.transport.putMany = async (...args) => {
      await putMany(...args);
      // The commit is in the server's log, so it has already been broadcast.
      // Applying the echo here is what moves this device's cursor past an
      // entry no later catch-up will carry.
      await receiveCommitted(a.transport);
      dropped++;
      throw new ConnectionError("the connection dropped before the reply arrived");
    };
    await a.engine.sync().catch(() => undefined);
    a.transport.putMany = putMany;
    expect(dropped, "the test did not reach the window it is about").toBe(1);

    // What the bug looked like from here: A's own version 2 is on the server,
    // A does not know it, and A is about to be refused for ever.
    await convergeBoth(a, b, 6);
    expect(b.vault.text("note.md"), "b never received the committed write").toBe(
      "second version\n",
    );

    // And the part that made it permanent rather than a hiccup: the *next*
    // edit is refused too, because it is still based on version 1.
    await a.vault.edit("note.md", "third version\n");
    await convergeBoth(a, b, 6);
    expect(b.vault.text("note.md"), "b never received the edit after the lost ack").toBe(
      "third version\n",
    );
    expect(a.vault.text("note.md")).toBe("third version\n");
  }, 240_000);

  /**
   * A sync that ends still wanting another round must not ask for one now
   * (R083-02).
   *
   * The client turns `nextUploadAt` into its next timer, so zero means the
   * whole vault is listed and re-decided as fast as the disk allows, for as
   * long as whatever is setting `again` keeps setting it. A second between
   * rounds is imperceptible to a person and is the difference between catching
   * up and spinning.
   */
  it("asks again on a floor rather than immediately", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "first version\n");
    await a.settle();

    // Something changing under the pass, every pass, which is the shape of the
    // problem: an editor saving continuously, or a peer writing the path this
    // device is uploading. Eight rounds later `sync` gives up and says when to
    // come back.
    let saves = 0;
    const list = a.vault.list.bind(a.vault);
    a.vault.list = async () => {
      const was = await list();
      if (saves < 40) {
        saves++;
        await a.vault.edit("note.md", `version ${saves}\n`);
        a.engine.noteChanged("note.md");
      }
      return was;
    };
    // A clock that does not move, so the deadline can be compared with the
    // reading it was computed from rather than with a moving target.
    a.step = 0;
    const now = a.clock;
    const report = await a.engine.sync();
    a.vault.list = list;
    a.step = 60_000;

    expect(saves, "nothing kept the pass coming back, so this proves nothing").toBeGreaterThan(1);
    expect(report.nextUploadAt, "a sync that wants another round said nothing").toBeDefined();
    expect(report.nextUploadAt!, "a retry scheduled for now is a hot loop").toBe(now + 1000);
  }, 240_000);
});

describe("a device told to skip part of the vault", () => {
  /**
   * An exclusion is a decision, not a delay.
   *
   * A path this device was configured to skip never becomes a path it will
   * apply, so counting it as outstanding meant `applied` was never sent again:
   * every other device said "Waiting for Phone" for the life of the vault, and
   * polled the server every second to keep saying it (Codex-10). "Waiting" and
   * "not coming" are different answers and the first one was wrong.
   */
  it("still tells the other devices how far it has got", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("notes/keep.md", "this one syncs everywhere\n");
    await a.vault.edit("Attachments/big.md", "this one is skipped on b\n");
    await convergeBoth(a, b, 6);

    // A third device configured the way `--ignore` and the plugin's skip list
    // configure one: the vault refuses to write under that name, and the
    // engine counts it as ignored rather than as a failure.
    const c = await device("c", undefined, new SkippingVault("Attachments"));
    await c.settle();
    await a.vault.edit("Attachments/another.md", "and so is this one\n");
    await a.settle();
    await receiveCommitted(c.transport);
    const report = await c.settle();

    expect(report.ignored, "nothing was actually skipped, so this proves nothing").toBeGreaterThan(
      0,
    );
    expect(c.vault.text("notes/keep.md"), "the rest of the vault did not arrive").toBe(
      "this one syncs everywhere\n",
    );
    expect(
      report.appliedCursor,
      "a device that skips a folder never told anyone where it had got to",
    ).toBeDefined();
  }, 240_000);
});

describe("a big file edited on the other device", () => {
  /**
   * The receiver already holds almost all of it.
   *
   * Chunk names are hashes of the raw bytes, so a name the receiver's own
   * index lists is a body the receiver can make from its own disk. Editing one paragraph of a large attachment renames one
   * chunk and leaves the rest alone; downloading all of it again is the whole
   * of what a person on a phone connection would feel.
   */
  it("makes the unchanged chunks itself instead of downloading them", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    // Big enough to be chunked into many pieces, and incompressible, so the
    // chunk boundaries are content-defined rather than an artefact of a
    // repeating pattern.
    const size = 4 * 1024 * 1024;
    const original = new Uint8Array(size);
    let seed = 12345;
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      original[i] = seed & 0xff;
    }
    await a.vault.write("big.bin", original, { mtime: 1000, ctime: 1000 });
    await convergeBoth(a, b, 6);
    expectSameBytes(await b.vault.read("big.bin"), original);

    // One region changed on A, which renames the chunks covering it and
    // leaves every other chunk exactly as it was.
    const edited = new Uint8Array(original);
    edited.set(new Uint8Array(4096).fill(7), size / 2);
    await a.vault.write("big.bin", edited, { mtime: 2000, ctime: 1000 });
    await a.settle();

    // What B asks the server for, from here on.
    let askedFor = 0;
    const fetch = b.transport.fetch.bind(b.transport);
    b.transport.fetch = async (names, onBytes) => {
      askedFor += names.length;
      return fetch(names, onBytes);
    };
    await receiveCommitted(b.transport);
    const report = await b.engine.sync();
    b.transport.fetch = fetch;

    expectSameBytes(await b.vault.read("big.bin"), edited, "b did not end up with a's edit");
    expect(report.reusedChunks, "nothing was reused").toBeGreaterThan(0);
    // The property: the fetch is proportional to what changed, not to the
    // file. A whole-file download would ask for every chunk it has.
    expect(askedFor, `asked for ${askedFor} chunks and reused ${report.reusedChunks}`).toBeLessThan(
      report.reusedChunks,
    );
  }, 240_000);

  /**
   * Too large to hold, on a vault that cannot stream.
   *
   * The reuse is optional there: the file is neither streamed nor read whole,
   * so every chunk has to come from the server. It used to return before
   * fetching them, so the chunks the two versions share were asked for by
   * nobody and the landing failed on every pass with "the server did not
   * send" them. A phone whose streaming had failed once, or any vault with no
   * `readBlocks`, could not take a new version of a large attachment again.
   */
  it("fetches what it cannot make, when the file is too large to read whole", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    expect("readBlocks" in b.vault, "this vault streams, so it proves nothing").toBe(false);

    const size = 9 * 1024 * 1024;
    const original = new Uint8Array(size);
    let seed = 54321;
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      original[i] = seed & 0xff;
    }
    await a.vault.write("big.bin", original, { mtime: 1000, ctime: 1000 });
    await convergeBoth(a, b, 6);
    expectSameBytes(await b.vault.read("big.bin"), original);

    const edited = new Uint8Array(original);
    edited.set(new Uint8Array(4096).fill(7), size / 2);
    await a.vault.write("big.bin", edited, { mtime: 2000, ctime: 1000 });
    await convergeBoth(a, b, 6);

    expectSameBytes(await b.vault.read("big.bin"), edited, "b did not end up with a's edit");
  }, 240_000);
});

describe("concurrent edits, which is where notes get lost", () => {
  it("keeps both edits when a stale refusal overtakes metadata verification", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    const base = "The original sentence.\n";
    const onA = "A's completely different sentence.\n";
    const onB = "B's entirely other sentence.\n";
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);
    await a.vault.edit("note.md", onA);
    await b.vault.edit("note.md", onB);

    // The frame arrived before the ack, but the engine has not finished
    // accepting it. Hold precisely that boundary.
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((r) => (release = r));
    const accept = a.engine.acceptBatch.bind(a.engine);
    a.engine.acceptBatch = async (batch) => {
      if (batch.entries.length > 0) {
        entered = true;
        await gate;
      }
      await accept(batch);
    };
    let pass: Promise<SyncReport> | undefined;
    try {
      await b.engine.sync();
      await until("a to start verifying b's edit", () => entered);
      let refused = false;
      let draining = false;
      const drain = a.transport.drainReceived.bind(a.transport);
      a.transport.drainReceived = async () => {
        draining = true;
        await drain();
      };
      const putMany = a.transport.putMany.bind(a.transport);
      a.transport.putMany = async (...args) => {
        const reply = await putMany(...args);
        refused ||= reply.results.some((result) => result.error?.code === "stale");
        return reply;
      };
      pass = a.engine.sync();
      await until("a's reply to reach the metadata barrier", () => draining);
      // The pong follows the refusal while metadata verification stays gated.
      await a.transport.ping();
      release();
      await pass;
      expect(refused).toBe(true);
    } finally {
      release();
      await pass;
    }
    await convergeBoth(a, b, 6);
    for (const d of [a, b]) {
      const copies = Object.values(d.vault.snapshot());
      expect(copies, `${d.name} lost A's edit`).toContain(onA);
      expect(copies, `${d.name} lost B's edit`).toContain(onB);
    }
  }, 240_000);

  it("records the merged note's byte length and its real timestamp", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    // Accented and multi-byte, so the UTF-16 count and the byte count differ:
    // `text.length` is code units and a file's size is bytes (R083-20).
    const base = ["# Notes é 🌋", "", "First paragraph.", "", "Second paragraph."].join("\n");
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);

    await a.vault.edit("note.md", base.replace("First paragraph.", "First paragraph, on A é."));
    await b.vault.edit("note.md", base.replace("Second paragraph.", "Second paragraph, on B 🌋."));
    // B publishes, A receives it, and A's next pass is the merge.
    await b.settle();
    await receiveCommitted(a.transport);
    const report = await a.engine.sync();
    expect(report.merged, "the pass under test did not merge").toBeGreaterThan(0);

    const text = a.vault.text("note.md") ?? "";
    expect(text).toContain("on A");
    expect(text).toContain("on B");

    // What the index wrote down about the file it has just written, against
    // the file. These two are what `needsRehash` compares a later stat with,
    // so a wrong size or a wrong timestamp is a note read, chunked and named
    // again on the very next pass to discover that nothing had changed.
    const stat = (await a.vault.stat("note.md"))!;
    const stored = (await a.store.load())!.entries["note.md"] as {
      size: number;
      mtime: number;
    };
    expect(stored.size, "the index recorded UTF-16 code units as a byte count").toBe(
      new TextEncoder().encode(text).length,
    );
    expect(stored.size).toBe(stat.size);
    expect(stored.mtime, "the index recorded a second clock reading, not the write").toBe(
      Math.ceil(stat.mtime),
    );
  }, 240_000);

  it("merges edits to different parts of one note, keeping both", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe(base);

    // Both edit, neither having seen the other.
    await a.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );

    await convergeBoth(a, b, 6);

    // The property that matters: both edits exist, on both devices.
    for (const d of [a, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
    }
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  }, 240_000);

  it("keeps both versions when the same line was rewritten twice", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
    await convergeBoth(a, b);

    await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
    await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");

    await convergeBoth(a, b, 6);

    // Neither version is anywhere lost. One of them is under a conflict
    // copy's name, and which does not matter; that both survive does.
    for (const d of [a, b]) {
      const all = Object.values(d.vault.snapshot()).join("\n---\n");
      expect(all, `${d.name} lost A's version`).toContain("A's completely different sentence");
      expect(all, `${d.name} lost B's version`).toContain("B's entirely other sentence");
    }

    // And a conflict copy exists, so somebody can see there was a conflict.
    const copies = a.vault.paths().filter((p) => p.includes("Conflicted copy"));
    expect(copies.length).toBeGreaterThan(0);

    // Named after whoever wrote what is in it (2026-09-23). A sent first, so
    // B kept A's words beside its own, and the copy says A on both devices,
    // not B, which made it.
    for (const d of [a, b]) {
      const held = d.vault
        .paths()
        .filter((p) => p.includes("Conflicted copy"))
        .map((p) => [p, d.vault.text(p)] as const);
      expect(held, `${d.name} holds ${JSON.stringify(held)}`).toHaveLength(1);
      expect(held[0]![1]).toBe("# Note\n\nA's completely different sentence.\n");
      expect(held[0]![0]).toMatch(/^note \(Conflicted copy a \d{12}\)\.md$/);
      expect(d.vault.text("note.md")).toBe("# Note\n\nB's entirely other sentence.\n");
    }
  }, 240_000);

  it("keeps both when an attachment changed on both sides", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const bytes = (seed: number) => {
      const out = new Uint8Array(4096);
      for (let i = 0; i < out.length; i++) out[i] = (Math.imul(i + seed, 2654435761) >>> 24) & 0xff;
      return out;
    };
    await a.vault.write("file.bin", bytes(1), { mtime: 1000, ctime: 1000 });
    await convergeBoth(a, b);

    await a.vault.write("file.bin", bytes(2), { mtime: 2000, ctime: 1000 });
    await b.vault.write("file.bin", bytes(3), { mtime: 2001, ctime: 1000 });
    await convergeBoth(a, b, 6);

    // Binary cannot be merged, so both must exist rather than one winning.
    for (const d of [a, b]) {
      const copies = d.vault.paths().filter((p) => p.includes("Conflicted copy"));
      expect(copies.length, `${d.name} has no conflict copy`).toBeGreaterThan(0);
    }
  }, 240_000);

  /**
   * The other device commits between this device's decision and its flush.
   *
   * A pass decides every path first and sends the outbox at the end, and
   * batches arrive on the transport's own chain the whole time. So A can
   * decide "upload P, the server is unchanged", B's version of P can arrive,
   * and A's flush then put its own version on top and record it as synced.
   * B sees a clean download of a version built on its own and takes it over
   * its edit, and nothing anywhere says conflict.
   */
  it("keeps the other device's edit when it landed mid-pass", async () => {
    await fresh();
    const av = new GatedVault();
    const a = await device("a", undefined, av);
    const b = await device("b");

    await av.edit("P.md", "the original sentence\n");
    await av.edit("zz-gate.md", "g0\n");
    await convergeBoth(a, b);
    expect(b.vault.text("P.md")).toBe("the original sentence\n");

    // Both rewrite the same line, so a merge would have to keep both.
    await av.edit("P.md", "A's completely different sentence\n");
    await b.vault.edit("P.md", "B's entirely other sentence\n");

    // A's pass decides P and then blocks reading zz-gate.md, which sorts
    // last, so its outbox is not flushed until the test lets go.
    let release!: () => void;
    av.gatePath = "zz-gate.md";
    av.gate = new Promise<void>((r) => (release = r));
    await av.edit("zz-gate.md", "g1\n");
    const seenBefore = a.batchesWithEntries;
    const reading = deferred();
    av.onRead = reading.resolve;
    const aPass = a.engine.sync();
    await reading.promise;

    // B commits while A is mid-pass, and A receives the batch.
    const bReport = await b.engine.sync();
    expect(bReport.uploaded).toBe(1);
    await until("a to receive b's version", () => a.batchesWithEntries > seenBefore);
    await receiveCommitted(a.transport);

    release();
    const aReport = await aPass;

    await convergeBoth(a, b, 6);
    // The property that matters: both edits still exist somewhere, on both
    // devices, as a merge or as a conflict copy.
    for (const d of [a, b]) {
      const all = everywhere(d);
      expect(all, `${d.name} lost B's edit`).toContain("B's entirely other sentence");
      expect(all, `${d.name} lost A's edit`).toContain("A's completely different sentence");
    }
    // And A's own pass did not call P a clean upload. It says so one way or
    // the other: held for another pass, or already merged or kept both.
    expect(aReport.waiting + aReport.merged + aReport.conflicted).toBeGreaterThan(0);
  }, 240_000);
});

/**
 * A case-only rename arriving in a pass that also downloads many other files.
 *
 * `applyDeletes` refuses a deletion that would remove a file this pass wrote,
 * which is what keeps `Note.md` to `NOTE.md` from deleting the note on a
 * filesystem that folds case. The list of writes was cleared just before the
 * final fill, but a full inbox is filled part way through the loop, so the
 * writes from that earlier fill were forgotten by the time the deletes ran.
 *
 * The rename is reported, the way the plugin reports one, so it travels as a
 * single move. Under protocol 1 that is the only way a case-only rename can
 * reach the server at all: a create of `NOTE.md` beside a live `Note.md` is a
 * collision, and only a move whose two names fold alike is always allowed
 * (plan/protocol.md, "Paths"). A rename nobody reported is the describe after
 * this one.
 */
describe("a case-only rename on a receiving device", () => {
  async function scenario(others: number): Promise<{ b: Device; report: SyncReport }> {
    await fresh();
    const a = await device("a", undefined, new FoldingVault());
    const logs: string[] = [];
    const b = await device("b", (m) => logs.push(m), new FoldingVault());

    await a.vault.edit("Note.md", "the only copy of this text\n");
    for (let i = 0; i < others; i++) {
      await a.vault.edit(`n${String(i).padStart(3, "0")}.md`, `v1 ${i}\n`);
    }
    await convergeBoth(a, b);
    expect(b.vault.text("Note.md")).toBe("the only copy of this text\n");

    // A renames Note.md to NOTE.md, case only, and edits every other file.
    const bytes = await a.vault.read("Note.md");
    await a.vault.remove("Note.md");
    await a.vault.write("NOTE.md", bytes, { mtime: 2000, ctime: 1000 });
    a.engine.noteRename("Note.md", "NOTE.md");
    for (let i = 0; i < others; i++) {
      await a.vault.edit(`n${String(i).padStart(3, "0")}.md`, `v2 ${i}\n`);
    }
    const sent = await a.settle();
    // Not refused: the move is the one write of the new name the server takes.
    expect(sent.skippedPaths, JSON.stringify(sent.needsAttention)).toEqual([]);
    await receiveCommitted(b.transport);

    const report = await b.engine.sync();
    return { b, report };
  }

  it("keeps the note when the pass is small", async () => {
    const { b, report } = await scenario(10);
    expect(report.deletedLocally).toBe(0);
    expect(b.vault.text("NOTE.md")).toBe("the only copy of this text\n");
  }, 240_000);

  it("keeps the note when the pass holds more than one batch of downloads", async () => {
    const { b, report } = await scenario(300);
    // The property: the text is still on device b, under either spelling.
    const held = b.vault.paths().filter((p) => p.toLowerCase() === "note.md");
    expect(held, `b holds ${held.join(",")}; deletedLocally=${report.deletedLocally}`).not.toEqual(
      [],
    );
    expect(report.deletedLocally).toBe(0);
  }, 240_000);
});

/**
 * A case-only rename nothing reported, found by the scan: every rename the
 * headless client makes, since it learns of renames only by scanning, and any
 * the plugin was not told of.
 *
 * The scan sees a synced `Note.md` gone and a new `NOTE.md`. Sent as that, a
 * deletion and a create, the create is refused as a `collision` with the live
 * `Note.md`, the deletion commits, and every other device applies it, while
 * the renaming device writes the new name off: the note on one device,
 * stranded, and on no other device and not on the server (rule 3). Found
 * moving these tests to protocol 1, where it was pinned before it was fixed.
 * The pass now reads the pair as the rename it is and sends one move, which a
 * protocol 1 server always takes for a case-only rename (plan/protocol.md,
 * "Paths", collision rule 1).
 *
 * Checked on three devices: the one that renames, one whose disk folds case,
 * as a Mac's does, and one whose disk keeps case apart, as Linux's does. The
 * property is where the bytes end up on each of them, under which name.
 */
describe("a case-only rename found by a scan", () => {
  async function three(): Promise<{ a: Device; b: Device; c: Device }> {
    await fresh();
    const a = await device("a", undefined, new CaseKeepingVault());
    const b = await device("b", undefined, new AliasingVault());
    const c = await device("c", undefined, new CaseKeepingVault());
    return { a, b, c };
  }

  /** Every device syncs, each after hearing what the others committed. */
  async function syncAll(...ds: Device[]): Promise<void> {
    for (let round = 0; round < 3; round++) {
      for (const d of ds) {
        await receiveCommitted(d.transport);
        await d.engine.sync();
      }
    }
  }

  /** Every file each device holds, by name, with its text. */
  const files = (d: Device) => d.vault.snapshot();

  /** What the entries that reached `d` said about `path`. */
  const arrivals = (d: Device, path: string) =>
    d.batches
      .flatMap((b) => b.entries as { path: string; prev?: string; deleted?: boolean }[])
      .filter((e) => e.path === path);

  it("sends a note's new name as one move, so its bytes are everywhere under it", async () => {
    const { a, b, c } = await three();
    const text = "the only copy of this text\n";
    await a.vault.edit("Note.md", text);
    await syncAll(a, b, c);
    for (const d of [b, c]) expect(files(d), d.name).toEqual({ "Note.md": text });

    // Renamed on disk, and nothing tells the engine.
    const bytes = await a.vault.read("Note.md");
    await a.vault.remove("Note.md");
    await a.vault.write("NOTE.md", bytes, { mtime: 2000, ctime: 1000 });
    const sent = await a.settle();
    expect(sent.skippedPaths, `stranded: ${JSON.stringify(sent.needsAttention)}`).toEqual([]);
    await syncAll(a, b, c);

    for (const d of [a, b, c]) {
      expect(files(d), `${d.name} does not hold the note under its new name`).toEqual({
        "NOTE.md": text,
      });
    }
    // One move on the wire, from the old name, and no deletion beside it.
    expect(arrivals(c, "NOTE.md").map((e) => e.prev)).toEqual(["Note.md"]);
    expect(arrivals(c, "Note.md").filter((e) => e.deleted)).toEqual([]);
    expect(await server.cli("cat", "-path", "NOTE.md")).toBe(text);
    await expect(server.cli("cat", "-path", "Note.md")).rejects.toThrow(/deleted or renamed/);
  }, 240_000);

  it("carries an edit made with the rename, in the same move", async () => {
    const { a, b, c } = await three();
    await a.vault.edit("Note.md", "the only copy of this text\n");
    await syncAll(a, b, c);

    const edited = "the only copy of this text, and a line added while renaming it\n";
    await a.vault.remove("Note.md");
    await a.vault.edit("NOTE.md", edited, 3000);
    const sent = await a.settle();
    expect(sent.skippedPaths, `stranded: ${JSON.stringify(sent.needsAttention)}`).toEqual([]);
    await syncAll(a, b, c);

    for (const d of [a, b, c]) {
      expect(files(d), `${d.name} does not hold the edited note`).toEqual({ "NOTE.md": edited });
    }
    expect(arrivals(c, "NOTE.md").map((e) => e.prev)).toEqual(["Note.md"]);
    expect(await server.cli("cat", "-path", "NOTE.md")).toBe(edited);
    await expect(server.cli("cat", "-path", "Note.md")).rejects.toThrow(/deleted or renamed/);
  }, 240_000);

  it("moves a folder whose case changed, and every file beneath it", async () => {
    const { a, b, c } = await three();
    const before = { "Dir/a.md": "first file\n", "Dir/sub/b.md": "second file\n" };
    for (const [path, text] of Object.entries(before)) await a.vault.edit(path, text);
    await syncAll(a, b, c);
    for (const d of [b, c]) expect(files(d), d.name).toEqual(before);

    // The folder renamed on disk, case only, the way a file manager does it:
    // everything beneath goes with it and nothing tells the engine.
    const after: Record<string, string> = {};
    const held = new Map<string, Uint8Array>();
    for (const path of Object.keys(before)) held.set(path, await a.vault.read(path));
    for (const path of Object.keys(before)) await a.vault.remove(path);
    await a.vault.remove("Dir/sub");
    await a.vault.remove("Dir");
    for (const [path, bytes] of held) {
      const moved = path.replace(/^Dir\//, "dir/");
      await a.vault.write(moved, bytes, { mtime: 2000, ctime: 1000 });
      after[moved] = before[path as keyof typeof before];
    }
    const sent = await a.settle();
    expect(sent.skippedPaths, `stranded: ${JSON.stringify(sent.needsAttention)}`).toEqual([]);
    await syncAll(a, b, c);

    for (const d of [a, b, c]) {
      expect(files(d), `${d.name} does not hold the files under the new name`).toEqual(after);
    }
    // Each file travelled as a move from its old name.
    for (const path of Object.keys(after)) {
      expect(arrivals(c, path).map((e) => e.prev)).toEqual([path.replace(/^dir\//, "Dir/")]);
      expect(await server.cli("cat", "-path", path)).toBe(after[path]);
    }
    await expect(server.cli("cat", "-path", "Dir/a.md")).rejects.toThrow(/deleted or renamed/);
    // And the folders are this spelling on the server too, so a note made
    // under the folder afterwards is taken rather than refused as a clash
    // with the old spelling.
    await a.vault.edit("dir/sub/new.md", "made after the rename\n", 4000);
    const later = await a.settle();
    expect(later.skippedPaths, `stranded: ${JSON.stringify(later.needsAttention)}`).toEqual([]);
    expect(await server.cli("cat", "-path", "dir/sub/new.md")).toBe("made after the rename\n");
  }, 240_000);

  /**
   * The same folder rename, reported the way Obsidian reports one: one event,
   * for the folder. Its files always moved; its own entry went up as a new
   * folder beside the old spelling, which never goes away because folder
   * deletions do not travel, and was refused as a collision and left stranded.
   * A folder whose name changed only in case now goes up as a move too.
   */
  it("moves a reported folder rename that changed only case, folder entry and all", async () => {
    const { a, b, c } = await three();
    await a.vault.edit("Dir/a.md", "first file\n");
    await syncAll(a, b, c);

    const bytes = await a.vault.read("Dir/a.md");
    await a.vault.remove("Dir/a.md");
    await a.vault.remove("Dir");
    await a.vault.write("dir/a.md", bytes, { mtime: 2000, ctime: 1000 });
    a.engine.noteRename("Dir", "dir");
    const sent = await a.settle();
    expect(sent.skippedPaths, `stranded: ${JSON.stringify(sent.needsAttention)}`).toEqual([]);
    await syncAll(a, b, c);

    for (const d of [a, b, c]) expect(files(d), d.name).toEqual({ "dir/a.md": "first file\n" });
    // The folder's own entry travelled as a move from the old spelling.
    expect(arrivals(c, "dir").map((e) => e.prev)).toEqual(["Dir"]);
    expect(await server.cli("cat", "-path", "dir/a.md")).toBe("first file\n");
  }, 240_000);
});

/**
 * C-D1 in the 0.3.0 review. `wouldUndoAWrite` asks the vault, and where the
 * vault cannot answer it falls back to comparing the spellings. That keeps the
 * note, which is the right side to err on, and on a vault that does hold both
 * spellings apart it never converges: the deletion is refused on every pass,
 * for ever, and the report said nothing at all about it.
 *
 * The rename is reported, so it travels as the one move a protocol 1 server
 * takes for a case-only rename (see the describe above).
 */
describe("a case-only rename onto a vault that cannot say what one file is (C-D1)", () => {
  it("says so, rather than repeating a clean pass for ever", async () => {
    await fresh();
    const a = await device("a", undefined, new FoldingVault());
    // No sameFile and no folding: two spellings really are two files here.
    const b = await device("b", undefined, new MemoryVault());

    await a.vault.edit("Note.md", "the only copy of this text\n");
    await convergeBoth(a, b);
    expect(b.vault.text("Note.md")).toBe("the only copy of this text\n");

    const bytes = await a.vault.read("Note.md");
    await a.vault.remove("Note.md");
    await a.vault.write("NOTE.md", bytes, { mtime: 2000, ctime: 1000 });
    a.engine.noteRename("Note.md", "NOTE.md");
    await a.settle();
    await receiveCommitted(b.transport);

    const report = await b.engine.sync();
    // The note is kept, both times: nothing here is allowed to lose it.
    expect(b.vault.text("NOTE.md")).toBe("the only copy of this text\n");
    expect(report.deletedLocally).toBe(0);
    // And the refusal is said out loud. A silent refusal is a vault that
    // never settles reporting that it has settled, which is rule 7.
    expect(report.blocked, "the refusal was silent").toBeGreaterThan(0);
    expect(report.inTheWay.map((w) => w.path)).toContain("Note.md");

    // What the count was warning about. This vault holds both spellings, so
    // the next pass finds the old one with no entry behind it and sends it
    // back up as a note of its own, which in Basalt undid the rename for
    // every device. Protocol 1 refuses that upload as a collision with the
    // live NOTE.md, so the rename stands everywhere and the old spelling is
    // named on this device as the one to deal with. Both files are still
    // here: the refusal is of the upload, not of anything on disk.
    const again = await b.engine.sync();
    expect(again.uploaded, "the old spelling went back up as a note of its own").toBe(0);
    expect(again.skippedPaths).toContain("Note.md");
    expect(again.needsAttention.find((n) => n.path === "Note.md")?.why ?? "").toMatch(
      /^collision: /,
    );
    expect(b.vault.paths().sort()).toEqual(["NOTE.md", "Note.md"]);
    expect(b.vault.text("Note.md")).toBe("the only copy of this text\n");
    await expect(server.cli("cat", "-path", "Note.md")).rejects.toThrow(/deleted or renamed/);
    expect(await server.cli("cat", "-path", "NOTE.md")).toBe("the only copy of this text\n");
  }, 240_000);
});

/**
 * A conflict copy is the only surviving record of one side of a divergence, so
 * overwriting one is the same failure the copy exists to prevent, one level up.
 *
 * The name carries the time only to the minute, so two conflicts on one path
 * from one device inside the same minute produced the same name and the second
 * write replaced the first. Two passes inside a minute is ordinary: the write
 * debounce is measured in tens of seconds.
 */
describe("naming a copy beside a note", () => {
  const none = async () => false;
  const only =
    (...taken: string[]) =>
    async (p: string) =>
      taken.includes(p);

  it("uses the name it was given when nothing is there", async () => {
    expect(await firstFreeName("note (Conflicted copy a 202608281705).md", none)).toBe(
      "note (Conflicted copy a 202608281705).md",
    );
  });

  it("numbers past a name already in use rather than writing over it", async () => {
    const base = "note (Conflicted copy a 202608281705).md";
    expect(await firstFreeName(base, only(base))).toBe(
      "note (Conflicted copy a 202608281705) 2.md",
    );
  });

  it("keeps numbering while the numbered ones are taken too", async () => {
    const base = "note (Conflicted copy a 202608281705).md";
    const taken = only(
      base,
      "note (Conflicted copy a 202608281705) 2.md",
      "note (Conflicted copy a 202608281705) 3.md",
    );
    expect(await firstFreeName(base, taken)).toBe("note (Conflicted copy a 202608281705) 4.md");
  });

  it("keeps the extension where the name has one, and adds none where it does not", async () => {
    expect(await firstFreeName("a/b/note.md", only("a/b/note.md"))).toBe("a/b/note 2.md");
    // A dot in a folder name is not an extension on the file.
    expect(await firstFreeName("a.b/note", only("a.b/note"))).toBe("a.b/note 2");
  });

  it("refuses rather than inventing a name when a thousand are taken", async () => {
    await expect(firstFreeName("note.md", async () => true)).rejects.toThrow(/unused name/);
  });

  /**
   * Found by the soak (docs/development.md, "The soak"). Two devices name
   * copies alike: after the author of the bytes, to the minute. The laptop
   * had kept its own text of the day's note in `Daily (Conflicted copy laptop
   * T).md` and sent it; the phone, offline, had written the day's note too,
   * and in the same minute kept the laptop's text in a copy of exactly that
   * name, because only its own disk was asked whether the name was free.
   * The laptop's copy then arrived at a path the phone was using, and was
   * kept as a copy of a copy, `Daily (Conflicted copy laptop T) (Conflicted
   * copy laptop T).md`: nothing lost, and a conflict copy that no two edits of
   * one text explain. A name the server already holds for another file is
   * taken, whether or not it has reached this disk yet.
   */
  it("numbers past a copy's name the server holds that has not reached this disk", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");
    // The phone's clock stands still, so the name its copy takes is known.
    b.step = 0;
    const taken = conflictCopyPath("note.md", "a", new Date(b.clock));

    await b.vault.edit("note.md", "the phone's own note\n");
    await a.vault.edit("note.md", "the laptop's note\n");
    await a.vault.edit(taken, "the laptop's copy, from a conflict of its own\n");
    await a.settle();
    // Both of the laptop's files are in the phone's remote index before its
    // pass decides anything, as they are after any reconnection.
    await receiveCommitted(b.transport);
    await convergeBoth(a, b);

    const second = taken.replace(/\.md$/, " 2.md");
    for (const d of [a, b]) {
      expect(d.vault.paths().sort(), d.name).toEqual([second, taken, "note.md"].sort());
      expect(d.vault.text("note.md"), d.name).toBe("the phone's own note\n");
      expect(d.vault.text(taken), d.name).toBe("the laptop's copy, from a conflict of its own\n");
      expect(d.vault.text(second), d.name).toBe("the laptop's note\n");
    }
  }, 120_000);
});

/**
 * An extension is a claim, not a fact. A `.md` holding bytes that are not UTF-8
 * used to decode with replacement characters, merge cleanly, and get written
 * back with those replacements standing in for bytes neither side had touched:
 * a file altered by a sync that reported success.
 *
 * The edits below are at opposite ends and do not collide, so the merge
 * succeeds. That is the case that mattered: a merge that refuses never writes
 * anything, and it is the clean merge that quietly rewrote the middle.
 */
describe("a text file that is not text", () => {
  it("does not rewrite bytes neither side edited", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    // 0xFF and 0xFE are valid nowhere in UTF-8, and are what a Latin-1 note
    // or a mis-labelled attachment looks like.
    const note = (head: string, tail: string) =>
      new Uint8Array([
        ...new TextEncoder().encode(`${head}\n`),
        0xff,
        0xfe,
        ...new TextEncoder().encode(`\n${tail}\n`),
      ]);

    await a.vault.write("note.md", note("start", "end"), { mtime: 1000, ctime: 1000 });
    await convergeBoth(a, b);

    // Opposite ends, so there is nothing to collide and the merge is clean.
    await a.vault.write("note.md", note("START HERE", "end"), { mtime: 2000, ctime: 1000 });
    await b.vault.write("note.md", note("start", "END HERE"), { mtime: 2000, ctime: 1000 });
    await convergeBoth(a, b);

    for (const d of [a, b]) {
      for (const path of d.vault.paths()) {
        const bytes = await d.vault.read(path);
        // EF BF BD is U+FFFD, the replacement character. Its presence
        // means bytes that were on disk were decoded away and written
        // back as something else.
        const rewritten = [...bytes].some(
          (byte, i) => byte === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd,
        );
        expect(rewritten, `${d.name}:${path} came back with replacement characters`).toBe(false);
      }
    }
  });
});

describe("deletions", () => {
  it("carries a delete from one device to the other", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("doomed.md", "not for long\n");
    await convergeBoth(a, b);
    expect(b.vault.text("doomed.md")).toBe("not for long\n");

    await a.vault.remove("doomed.md");
    await convergeBoth(a, b, 6);

    expect(a.vault.text("doomed.md")).toBeUndefined();
    expect(b.vault.text("doomed.md")).toBeUndefined();
  }, 240_000);

  /**
   * A deletion can be repeated. An edit that is gone from the device that made
   * it and from the server cannot be recovered. So the edit wins.
   */
  it("keeps a file deleted on one device but edited on the other", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("contested.md", "original\n");
    await convergeBoth(a, b);

    await a.vault.remove("contested.md");
    await b.vault.edit("contested.md", "edited, and worth keeping\n");
    await convergeBoth(a, b, 6);

    expect(b.vault.text("contested.md"), "the edit was deleted").toBe(
      "edited, and worth keeping\n",
    );
    expect(a.vault.text("contested.md"), "the edit did not come back").toBe(
      "edited, and worth keeping\n",
    );
  }, 240_000);
});

describe("folders and renames", () => {
  /**
   * Deleting an empty folder and having it come straight back.
   *
   * A folder the server holds and this device does not was read as one that
   * had arrived from elsewhere, so it was created. That is right for a folder
   * this device has never seen and wrong for one it removed a second ago: the
   * folder reappeared on the very device somebody deleted it on, which is not
   * "a folder deletion is not propagated", it is the deletion being undone.
   */
  it("does not put back a folder this device removed", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.mkdir("Archive");
    await a.vault.edit("Archive/note.md", "something\n");
    await convergeBoth(a, b);
    expect(b.vault.text("Archive/note.md")).toBe("something\n");

    // Empty it and remove it, the way somebody tidying up would.
    await a.vault.remove("Archive/note.md");
    await convergeBoth(a, b);
    await a.vault.remove("Archive");
    expect(await a.vault.exists("Archive")).toBe(false);

    await a.engine.sync();
    await a.engine.sync();
    expect(await a.vault.exists("Archive"), "the folder came back").toBe(false);
  }, 240_000);

  /**
   * The same folder, held by both devices before they ever paired.
   *
   * Neither device created it for the other, so neither took the path that
   * records a folder as synced. The comparison that should have done it
   * instead was between the scan's "" and the batch's "-empty-", which never
   * agree, so the folder never got a synctime and read as one this device had
   * never seen. Removing it then brought it back, every pass.
   */
  it("does not put back a folder both devices already had", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("dir/a.md", "from a\n");
    await a.settle();

    const b = new Device("b");
    devices.push(b);
    await b.vault.edit("dir/b.md", "from b\n"); // b has dir/ before pairing
    await b.connect(server);
    await convergeBoth(a, b);
    expect(b.vault.text("dir/a.md")).toBe("from a\n");

    // b empties the folder and removes it.
    await b.vault.remove("dir/a.md");
    await b.vault.remove("dir/b.md");
    await b.vault.remove("dir");
    const r = await b.engine.sync();
    expect(r.deletedRemotely).toBe(2);
    const again = await b.engine.sync();
    expect(r.foldersCreated + again.foldersCreated, "the folder b just removed was put back").toBe(
      0,
    );
    expect(await b.vault.exists("dir")).toBe(false);
  }, 240_000);

  it("creates a folder the other device made", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.mkdir("some/deep/folder");
    await a.vault.edit("some/deep/folder/note.md", "inside\n");
    await convergeBoth(a, b);

    expect(b.vault.text("some/deep/folder/note.md")).toBe("inside\n");
  }, 240_000);

  it("carries a rename as a rename, not a delete and an add", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("before.md", "the same content throughout\n");
    await convergeBoth(a, b);

    // As the vault would report it: the file moved, and the engine is told.
    const bytes = await a.vault.read("before.md");
    await a.vault.remove("before.md");
    await a.vault.write("after.md", bytes, { mtime: 2000, ctime: 1000 });
    a.engine.noteRename("before.md", "after.md");

    const report = await a.engine.sync();
    // Nothing new to send: the content is already there, so the rename costs
    // metadata and no chunks at all.
    expect(report.chunksSent).toBe(0);

    await convergeBoth(a, b, 6);
    expect(b.vault.text("after.md")).toBe("the same content throughout\n");
    expect(b.vault.text("before.md")).toBeUndefined();

    // And the device that did the renaming does not get the old name back.
    //
    // This assertion was the missing half. Telling the engine about a rename
    // removed the old path from the index, and an index with no entry for a
    // path the server still has content at reads as "new on the server", so
    // the very next pass downloaded the file the person had just moved. Every
    // move in Obsidian left a copy behind, and checking only the receiving
    // device could never see it.
    expect(a.vault.text("before.md"), "the moved file came back").toBeUndefined();
    expect(a.vault.text("after.md")).toBe("the same content throughout\n");
  }, 240_000);

  /**
   * Obsidian reports a folder rename as one event, for the folder. Every
   * file beneath it has moved without a word, and the engine used to move
   * only the entry it was told about, so each file went over as new at its
   * new path and deleted at its old one.
   */
  it("carries a folder rename as a rename of everything inside it", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const files = ["dir/one.md", "dir/two.md", "dir/sub/three.md"];
    for (const f of files) await a.vault.edit(f, `content of ${f}\n`);
    await convergeBoth(a, b);
    expect(b.vault.text("dir/sub/three.md")).toBe("content of dir/sub/three.md\n");

    // As the vault would do it, then the one event Obsidian fires.
    for (const f of files) {
      const bytes = await a.vault.read(f);
      await a.vault.remove(f);
      await a.vault.write(f.replace(/^dir\//, "moved/"), bytes, { mtime: 2000, ctime: 1000 });
    }
    await a.vault.remove("dir/sub");
    await a.vault.remove("dir");
    a.engine.noteRename("dir", "moved");

    const before = b.batches.length;
    await a.engine.sync();
    await receiveCommitted(b.transport);
    // Each file travelled as a rename, which is the `prev` field on the wire.
    const renames = b.batches
      .slice(before)
      .flatMap((batch) => batch.entries as { prev?: string; folder: boolean }[])
      .filter((e) => !e.folder && e.prev);
    expect(renames.length).toBe(files.length);

    await convergeBoth(a, b, 6);
    for (const d of [a, b]) {
      for (const f of files) {
        expect(d.vault.text(f.replace(/^dir\//, "moved/")), `${d.name} lacks the moved ${f}`).toBe(
          `content of ${f}\n`,
        );
        expect(d.vault.text(f), `${d.name} got ${f} back`).toBeUndefined();
      }
    }
  }, 240_000);
});

/**
 * Two notes whose names differ only by case, where one disk files them as one.
 *
 * In Basalt the server took both, and the question was what a disk that folds
 * case did with two distinct paths it files as a single name: writing the
 * second replaced the first, both were recorded as synced, and the next scan
 * reported the first deleted to every device. That receiving side is still
 * guarded, and is tested against a server that sends both anyway
 * (inbound.test.ts, "two aliases of one file arriving in different fills").
 *
 * A protocol 1 server refuses the second as a `collision` (PLAN.md section
 * 4.1), so against a real one the question moves to the device that wrote
 * them: the refused note stays on its disk, is named with the server's
 * reason, and goes through once somebody renames it.
 */
describe("two notes the receiving disk cannot hold apart", () => {
  it("refuses the second of two names that differ only by case, and keeps both", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b", undefined, new AliasingVault());
    const first = "Note.md";
    const second = "note.md";

    await a.vault.edit(first, `the ${first} text\n`);
    await a.vault.edit(second, `the ${second} text\n`);
    const sent = await a.settle();

    // Exactly one of the two is written off, with the server's reason, which
    // names the one it collides with.
    const refused = sent.skippedPaths.filter((p) => p === first || p === second);
    expect(refused, JSON.stringify(sent.needsAttention)).toHaveLength(1);
    const lost = refused[0]!;
    const kept = lost === first ? second : first;
    const why = sent.needsAttention.find((n) => n.path === lost)?.why ?? "";
    expect(why).toMatch(/^collision: /);
    expect(why).toContain(`"${kept}"`);

    await receiveCommitted(b.transport);
    const report = await b.engine.sync();
    // Only the one the server holds reached b, and nothing is in its way.
    expect(report.blocked).toBe(0);
    expect(b.vault.snapshot()).toEqual({ [kept]: `the ${kept} text\n` });

    // The property: the device that has both still has both, whatever b did.
    await convergeBoth(a, b, 4);
    expect(a.vault.text(first), `a lost ${first}`).toBe(`the ${first} text\n`);
    expect(a.vault.text(second), `a lost ${second}`).toBe(`the ${second} text\n`);

    // Renaming the refused one on the device that has both clears it, and
    // both arrive.
    const bytes = await a.vault.read(lost);
    await a.vault.remove(lost);
    await a.vault.write("renamed.md", bytes, { mtime: 3000, ctime: 3000 });
    a.engine.noteRename(lost, "renamed.md");
    await convergeBoth(a, b, 6);
    expect(b.vault.text(kept)).toBe(`the ${kept} text\n`);
    expect(b.vault.text("renamed.md")).toBe(`the ${lost} text\n`);
    expect((await a.engine.sync()).skippedPaths, "the rename left a refusal behind").toEqual([]);
  }, 240_000);

  // The pair that used to be here, `café.md` in NFC against the same name in
  // NFD, is not two names. It is one name spelled two ways, and refusing it
  // named two strings nobody can tell apart and never cleared, because there
  // was nothing for a person to rename. It is folded at the wire, a protocol
  // 1 server refuses the NFD spelling outright, and the test for the fold is
  // below, under "one name a peer spells in another normal form". Case stays
  // here: `Note.md` and `note.md` are two names a person chose between, and a
  // disk that folds them really can only hold one.

  it("still lets a case-only rename through", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b", undefined, new AliasingVault());
    await a.vault.edit("Note.md", "the note\n");
    await convergeBoth(a, b);
    const bytes = await a.vault.read("Note.md");
    await a.vault.remove("Note.md");
    await a.vault.write("NOTE.md", bytes, { mtime: 2000, ctime: 1000 });
    a.engine.noteRename("Note.md", "NOTE.md");
    await convergeBoth(a, b, 6);
    expect(b.vault.text("NOTE.md")).toBe("the note\n");
    expect(b.vault.paths()).toEqual(["NOTE.md"]);
  }, 240_000);
});

/**
 * A path the server holds in a Unicode normal form no current client
 * produces, which is every accented name a Mac running a client older than
 * the NFC rule ever uploaded to a Basalt server.
 *
 * A protocol 1 server refuses such a path at the put (`nfc`, plan/protocol.md,
 * "Paths"), and a device joins TrewSync by pairing fresh rather than inheriting a
 * Basalt history, so a TrewSync server never holds one. The engine still files a
 * name off the wire under its NFC spelling, because that is the one place a
 * path from the wire becomes an identity here, and two checks are cheaper than
 * one recovery (PLAN.md section 4.1). So these cases are played by a server
 * that does hold one, on a fake socket, and what they pin is that the fold
 * makes one note of it: never two notes a person cannot tell apart, and never
 * a deletion or an edit sent under a name the server does not have.
 *
 * Folded here rather than left alone, because the alternative was measured:
 * the device wrote the note under its NFC name, found a name the index did not
 * know, uploaded it as a second note, and then had both spellings on the
 * server for ever, reporting `blocked: 1` on every pass and naming two strings
 * a person cannot tell apart. That is verbatim the failure normalising was
 * added to prevent.
 *
 * What the device owes the server afterwards is a rename, not an upload, and
 * `prev` is how a rename travels: one entry, no bodies, because the chunks are
 * already there.
 */
describe("one name a peer spells in another normal form", () => {
  const NFC = "caf\u00e9.md";
  const NFD = "cafe\u0301.md";

  /** A version of a file as a server lists it, with its body served. */
  async function version(
    uid: number,
    path: string,
    text: string,
    bodies: Map<string, Uint8Array>,
    over: { prev?: string } = {},
  ) {
    const raw = new TextEncoder().encode(text);
    const name = await chunkName(raw);
    bodies.set(name, raw);
    return {
      uid,
      path,
      size: raw.length,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [name],
      device: "old",
      ...over,
    };
  }

  /**
   * A device on a server that already holds `history`, which serves every
   * body it holds and takes every write, recording each entry it was sent.
   */
  async function onServerHolding(
    history: Record<string, unknown>[],
    bodies: Map<string, Uint8Array>,
  ) {
    const rig = await engineOnFakeSocket({}, { vault: new CaseKeepingVault() });
    let uid = history.length;
    const written: Record<string, unknown>[] = [];
    rig.socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch") {
        s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      } else if (frame["op"] === "putmany") {
        // Every chunk is one it already holds: these writes are renames and
        // deletions of content it served.
        const entries = frame["entries"] as Record<string, unknown>[];
        written.push(...entries);
        s.reply({ res: "acks", results: entries.map(() => ({ uid: ++uid })) });
      } else if (frame["op"] === "put") {
        written.push(frame);
        s.reply({ res: "have", uid: ++uid });
      } else if (frame["op"] === "applied") {
        s.reply({ res: "applied", cursor: frame["applied"] });
      } else if (frame["op"] === "ping") {
        s.raw({ res: "pong" });
      }
    };
    rig.socket.raw({ op: "batch", from: 1, to: history.length, entries: history });
    await settleUntil("the history to be taken", () => rig.engine.status().cursor === uid);
    return { ...rig, written };
  }

  it("is the same file, and the correction travels as a rename", async () => {
    const bodies = new Map<string, Uint8Array>();
    const old = await version(1, NFD, "from the old client\n", bodies);
    const now = await onServerHolding([old], bodies);

    // This device's own keyspace is NFC, so the note has to land on the NFC
    // name and stay one note.
    let report!: SyncReport;
    for (let i = 0; i < 4; i++) report = await now.engine.sync({ coalesceWrites: false });
    expect(report.blocked, `blocked: ${JSON.stringify(report.inTheWay)}`).toBe(0);
    expect(now.vault.paths()).toEqual([NFC]);
    expect(now.vault.text(NFC)).toBe("from the old client\n");

    // And it went back as a rename rather than as a second note: one entry,
    // from the server's spelling to this device's, naming the chunks the
    // server already has, and not one body sent.
    const renames = now.written.filter((e) => (e["meta"] as { prev?: string }).prev);
    expect(renames, JSON.stringify(now.written)).toHaveLength(1);
    expect(renames[0]).toMatchObject({ path: NFC, meta: { prev: NFD }, chunks: old.chunks });
    expect(now.written, "the note went up a second time").toHaveLength(1);
    expect(now.socket.sentBinary).toEqual([]);

    // Rule 10: the property is not that this device is quiet, it is that the
    // vault ends up holding one note. A third device reading that history,
    // the version and then the rename, gets one file, not two.
    const later = await onServerHolding(
      [old, { ...old, uid: 2, path: NFC, prev: NFD, device: "now" }],
      bodies,
    );
    let theirs!: SyncReport;
    for (let i = 0; i < 4; i++) theirs = await later.engine.sync({ coalesceWrites: false });
    expect(theirs.blocked, `blocked: ${JSON.stringify(theirs.inTheWay)}`).toBe(0);
    expect(later.vault.paths()).toEqual([NFC]);
    expect(later.vault.text(NFC)).toBe("from the old client\n");
  });

  it("folds every segment, so a note under an NFD folder lands once", async () => {
    const bodies = new Map<string, Uint8Array>();
    const folder = {
      uid: 1,
      path: "Note\u0301s",
      size: 0,
      ctime: 1000,
      mtime: 1000,
      folder: true,
      deleted: false,
      chunks: [],
      device: "old",
    };
    const file = await version(2, "Note\u0301s/cafe\u0301.md", "in a folder\n", bodies);
    const now = await onServerHolding([folder, file], bodies);

    let report!: SyncReport;
    for (let i = 0; i < 4; i++) report = await now.engine.sync({ coalesceWrites: false });
    expect(report.blocked, `blocked: ${JSON.stringify(report.inTheWay)}`).toBe(0);
    expect(now.vault.paths()).toEqual(["Not\u00e9s/caf\u00e9.md"]);
    expect(now.vault.text("Not\u00e9s/caf\u00e9.md")).toBe("in a folder\n");
  });

  it("deletes the note the server has, not a name it has never heard of", async () => {
    const bodies = new Map<string, Uint8Array>();
    const now = await onServerHolding([await version(1, NFD, "to be deleted\n", bodies)], bodies);
    await now.engine.sync({ coalesceWrites: false });
    expect(now.vault.paths(), "the note did not arrive").toEqual([NFC]);

    // Deleted before this device has told the server which name it uses. A
    // deletion sent under a name the server never had deletes nothing, and
    // the note comes back to life on every other device.
    const before = now.written.length;
    await now.vault.remove(NFC);
    for (let i = 0; i < 4; i++) await now.engine.sync({ coalesceWrites: false });

    // Rule 10: the property is which note the server was told to delete, not
    // whether a device running this code happened to agree.
    const deletions = now.written
      .slice(before)
      .filter((e) => (e["meta"] as { deleted?: boolean }).deleted);
    expect(deletions.length, JSON.stringify(now.written)).toBeGreaterThan(0);
    for (const d of deletions) {
      expect(d["path"], "the deletion did not name the path the server holds").toBe(NFD);
    }
    expect(now.vault.paths()).toEqual([]);
  });

  it("carries an edit back under the name the server already has", async () => {
    const bodies = new Map<string, Uint8Array>();
    const now = await onServerHolding([await version(1, NFD, "first\n", bodies)], bodies);
    for (let i = 0; i < 4; i++) await now.engine.sync({ coalesceWrites: false });
    expect(now.vault.snapshot()).toEqual({ [NFC]: "first\n" });
    // The correction has gone by now, as the rename above: the server's name
    // for the note is this device's spelling from uid 2, which is the uid
    // this fake gives the first write after its one-version history.
    expect(now.written).toHaveLength(1);
    expect(now.written[0]).toMatchObject({ path: NFC, meta: { prev: NFD }, base: 0, prevBase: 1 });

    // The edit's body is new, so the server asks for it.
    now.socket.autoReply = ((reply) => (frame, s) => {
      if (frame["op"] === "putmany") {
        const entries = frame["entries"] as { chunks: string[] }[];
        const missing = entries.flatMap((e) => e.chunks).filter((n) => !bodies.has(n));
        if (missing.length > 0) {
          now.written.push(...(entries as unknown as Record<string, unknown>[]));
          s.reply({ res: "want", chunks: missing });
          setTimeout(
            () => s.reply({ res: "acks", results: entries.map((_, i) => ({ uid: 10 + i })) }),
            20,
          );
          return;
        }
      }
      reply?.(frame, s);
    })(now.socket.autoReply);

    const before = now.written.length;
    await now.vault.edit(NFC, "second\n", 9_000_000);
    let mine!: SyncReport;
    for (let i = 0; i < 4; i++) mine = await now.engine.sync({ coalesceWrites: false });
    expect(mine.blocked).toBe(0);
    expect(now.vault.snapshot()).toEqual({ [NFC]: "second\n" });

    // One write carries the edit, and it is written on top of the version the
    // server holds, under the name the server holds it by, never as a second
    // note with a name of its own beside it.
    const edits = now.written.slice(before);
    expect(edits, JSON.stringify(edits)).toHaveLength(1);
    expect(edits[0]).toMatchObject({ path: NFC, base: 2 });
    expect("prev" in (edits[0]!["meta"] as object), "the edit was sent as a second rename").toBe(
      false,
    );
    // And the one body that went up is the edit's.
    const sent = now.socket.sentBinary.map((f) =>
      new TextDecoder().decode(decodeFrame(f, LOCAL_MAX_CHUNK_BYTES)),
    );
    expect(sent).toEqual(["second\n"]);
  });
});

/**
 * The conflict copy is the only surviving record of one side
 * of a divergence, and its name was chosen with `exists` and then written
 * with an ordinary replacing write. A file appearing in between was replaced.
 */
describe("a conflict copy whose name is taken in the gap", () => {
  it("goes under the next name rather than over what appeared", async () => {
    await fresh();
    const a = await device("a");
    const racy = new RacyVault();
    const b = await device("b", undefined, racy);

    await a.vault.edit("note.md", "the original\n");
    await convergeBoth(a, b);
    await a.vault.edit("note.md", "A's rewrite\n");
    await b.vault.edit("note.md", "B's rewrite\n");
    await a.settle();
    await receiveCommitted(b.transport);

    const report = await b.engine.sync();
    expect(report.conflicted).toBe(1);
    expect(racy.raced.length).toBeGreaterThan(0);
    // What appeared in the gap is untouched, and the incoming version is
    // somewhere beside it.
    for (const taken of racy.raced) {
      expect(b.vault.text(taken)).toBe(`somebody else's ${taken}\n`);
    }
    const all = everywhere(b);
    expect(all).toContain("A's rewrite");
    expect(all).toContain("B's rewrite");
  }, 240_000);
});

/**
 * A merge whose ancestor the server no longer holds.
 *
 * One catch used to cover the ancestor fetch, the local read, the incoming
 * fetch and the decoding, so every one of those failures became a conflict
 * copy labelled "not valid UTF-8". A purged ancestor is the case that happens
 * in practice: `trewd purge` keeps the newest version of each path, and a
 * device that was away holds a base the server has since let go of.
 */
/**
 * F01, on the merge path.
 *
 * A merge reads the local file, then fetches the other side, then writes the
 * result. The fetch is a network round trip and the editor is in use through
 * it, so the text being written can be a merge of a version that is no longer
 * on this disk. Writing it drops whatever replaced it, with `merged 1` in the
 * report.
 */
describe("a note edited while the other side of its merge is in flight (F01)", () => {
  it("keeps both rather than writing a merge of a version that is gone", async () => {
    await fresh();
    const a = await device("a");
    const racy = new EditsAfterLooking();
    const b = await device("b", undefined, racy);

    const base = "# Note\n\nFirst paragraph.\n\nSecond paragraph.\n";
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe(base);

    // Both sides edit a different paragraph, which is an ordinary clean merge.
    await a.vault.edit("note.md", base.replace("First paragraph.", "First, from a."));
    await a.settle();
    await receiveCommitted(b.transport);
    await b.vault.edit("note.md", base.replace("Second paragraph.", "Second, from b."));

    // And the editor saves again the moment the merge has read the file.
    racy.text_ = base.replace("Second paragraph.", "Third, typed during the merge.");
    racy.armed = "note.md";

    const report = await b.engine.sync();

    expect(
      b.vault.text("note.md"),
      "the merge overwrote an edit made while the other side was on the wire",
    ).toContain("Third, typed during the merge.");
    expect(report.merged, "a merge that was not written was counted as one").toBe(0);
    expect(report.conflicted).toBe(1);
    // And a's paragraph is not lost either: it is beside the note.
    expect(everywhere(b)).toContain("First, from a.");
  }, 240_000);
});

describe("a merge against an ancestor that has been purged", () => {
  it("keeps both and says why, rather than blaming the encoding", async () => {
    await fresh();
    const a = await device("a");
    const logs: { message: string; rest: unknown[] }[] = [];
    const log = (message: string, ...rest: unknown[]) => void logs.push({ message, rest });
    const b = await device("b", log);

    const base = "# Note\n\nFirst paragraph.\n\nSecond paragraph.\n";
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe(base);

    // a moves on and syncs; b edits the other paragraph but does not sync.
    await a.vault.edit("note.md", base.replace("First paragraph.", "First, from a."));
    await a.settle();
    await receiveCommitted(b.transport);
    await b.vault.edit("note.md", base.replace("Second paragraph.", "Second, from b."));

    // The server forgets everything but the newest version of each path,
    // which takes b's merge base with it.
    a.close();
    b.close();
    await server.whileStopped(async () => {
      await server.cli("purge", "-vault", "default", "-confirm", "default", "-no-backup-check");
    });
    await b.connect(server, log);

    const report = await b.engine.sync();
    expect(report.conflicted).toBe(1);
    expect(report.retrying).toBe(0);
    const kept = logs.find((l) => l.message === "kept both");
    const why = String((kept?.rest[1] as { why?: string } | undefined)?.why ?? "");
    expect(why, "the reason given").toMatch(/purged/);
    expect(why).not.toMatch(/UTF-8/);

    // The property: both edits are on b, the local one in place.
    const all = everywhere(b);
    expect(all).toContain("First, from a.");
    expect(b.vault.text("note.md")).toContain("Second, from b.");
  }, 240_000);
});

describe("the content identity", () => {
  it("distinguishes an empty file from one that never synced", () => {
    // The index reads `synchash === ""` as "never synced". Without a marker
    // for it, an empty note that had synced perfectly well would read as one
    // that never had, and every pass would treat it as new.
    expect(contentId([])).not.toBe("");
    expect(contentId([])).toBe("-empty-");
    expect(contentId(["a", "b"])).toBe("a,b");
  });

  it("round trips an empty note between two devices", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("empty.md", "");
    await convergeBoth(a, b);
    expect(b.vault.text("empty.md")).toBe("");

    // And settles: a second pass must not decide it is new again.
    const report = await b.engine.sync();
    expect(report.uploaded).toBe(0);
    expect(report.downloaded).toBe(0);
  }, 240_000);
});

describe("a file that can never sync", () => {
  it("is skipped rather than retried forever", async () => {
    await fresh();
    const a = await device("a");

    // A path the server refuses: over its length bound. Retrying it would
    // fail identically forever and hide everything else in the log.
    const tooLong = "x".repeat(5000) + ".md";
    await a.vault.edit(tooLong, "content");
    await a.vault.edit("fine.md", "content");

    const first = await a.engine.sync();
    expect(first.uploaded).toBeGreaterThanOrEqual(1);
    expect(first.skipped + first.retrying).toBeGreaterThanOrEqual(1);

    // The good file synced regardless: one bad path must not stall the rest.
    expect(a.engine.status().files).toBeGreaterThanOrEqual(1);
    const second = await a.engine.sync();
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe("the guards the happy path hides", () => {
  it("reads no files at all on a pass where nothing changed", async () => {
    // The index's content cache is what keeps a routine scan to one stat per
    // file. Correctness does not depend on it, which is why nothing else
    // here notices when it stops working, and a vault of four thousand notes
    // very much does.
    await fresh();
    const a = await device("a");
    for (let i = 0; i < 5; i++) await a.vault.edit(`note${i}.md`, `content ${i}`);
    await a.engine.sync();

    const before = a.vault.reads;
    await a.engine.sync();
    expect(a.vault.reads - before, "an unchanged pass re-read the vault").toBe(0);
  }, 120_000);

  it("writes its index, so a restart is not a rebuild", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "content");
    await a.engine.sync();
    expect(a.store.saves).toBeGreaterThan(0);
  }, 120_000);

  /**
   * A device whose index is gone but whose vault matches the server.
   *
   * Every file decides "nothing", and the ancestor has to move anyway, or the
   * device has no common ancestor for anything and the next concurrent edit
   * conflicts where it should have merged. A lost afternoon rather than a lost
   * note, and still wrong.
   *
   * What this verifies is that the rebuilt device does not re-upload the vault
   * and that the edits both survive. It does *not* isolate the ancestor
   * recovery: with that removed the assertions still hold, because the other
   * device merges and the result comes back. A case that pins the recovery
   * itself would have to make the rebuilt device the one that merges, and
   * ordering two devices that precisely is not something these tests can do
   * yet.
   */
  it("recovers the ancestor for files that already agree", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);

    // A restarts having lost its index entirely. The vault is untouched.
    a.close();
    const rebuilt = new Device("a");
    devices.push(rebuilt);
    Object.assign(rebuilt, { vault: a.vault, store: new MemoryIndexStore() });
    await rebuilt.connect(server);
    const recovery = await rebuilt.engine.sync();
    expect(recovery.uploaded, "a rebuilt index re-uploaded the vault").toBe(0);

    // Now both edit different parts. This can only merge if the rebuilt
    // device worked out its ancestor from the agreement.
    await rebuilt.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );
    await convergeBoth(rebuilt, b, 6);

    for (const d of [rebuilt, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
    }
  }, 240_000);

  /**
   * A device that was not part of the conflict still ends up with both
   * versions.
   *
   * This one passes with the conflict copy's upload removed, and the reason is
   * worth writing down rather than leaving as a puzzle: the copy is a new file
   * in the vault, so the very next scan finds it and uploads it like any other
   * new file. The scan is the backstop. The explicit upload only makes it
   * happen a round earlier, and the test below is the one that shows why a
   * round earlier matters.
   */
  it("carries both versions to a device that was not part of the conflict", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
    await convergeBoth(a, b);

    await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
    await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");
    await convergeBoth(a, b, 6);

    // C arrives afterwards, having seen none of it.
    const c = await device("c");
    await c.settle(6);

    const all = Object.values(c.vault.snapshot()).join("\n---\n");
    expect(all, "c never received A's version").toContain("A's completely different sentence");
    expect(all, "c never received B's version").toContain("B's entirely other sentence");
  }, 300_000);

  /**
   * The device that detected the conflict sends both versions before it can
   * stop.
   *
   * The scan is the backstop for the conflict copy, and a backstop that needs
   * another pass is not one for the case that matters: B notices the conflict,
   * writes the copy, and then the laptop lid closes. If the copy has not
   * already left, the only place A's own text still exists is A, and A is about
   * to download B's version over it.
   *
   * So B syncs exactly once here and then goes away for good. Everything A
   * recovers, it recovers from what that single pass uploaded.
   */
  it("gets both versions off the device before it stops syncing", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
    await convergeBoth(a, b);

    await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
    await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");

    // A publishes first, so it is B that finds the conflict.
    await a.engine.sync();
    await receiveCommitted(b.transport);
    const report = await b.engine.sync();
    expect(report.conflicted, "B was meant to be the one that conflicted").toBe(1);

    // And B is gone. One pass, no second chance.
    b.close();
    await receiveCommitted(a.transport);

    await a.settle(6);

    const all = Object.values(a.vault.snapshot()).join("\n---\n");
    expect(all, "A lost its own version").toContain("A's completely different sentence");
    expect(all, "A never received B's version").toContain("B's entirely other sentence");
  }, 300_000);

  /**
   * Two devices that independently arrive at the same content have synced,
   * and the index has to say so.
   *
   * The same note typed twice, or restored from the same backup twice. Nothing
   * is transferred, so it is tempting to call it a no-op. It is not: if the
   * ancestor does not move to the content both sides hold, the next pair of
   * edits merges against a version neither device has ever had, which is a
   * conflict reported for two edits that never overlapped.
   *
   * Nothing else in this file pins that down, because everywhere else the
   * ancestor was already recorded by whichever transfer put the content there.
   * Here there was no transfer.
   */
  it("records the ancestor when both devices already agree", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    // Typed on both, neither having seen the other. Byte for byte the same.
    await a.vault.edit("note.md", base);
    await b.vault.edit("note.md", base);
    await convergeBoth(a, b, 6);

    // Now the edits that must merge rather than collide.
    await a.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );
    await convergeBoth(a, b, 6);

    for (const d of [a, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
      expect(
        d.vault.paths().filter((x) => x.includes("Conflicted copy")),
        `${d.name} conflicted`,
      ).toEqual([]);
    }
  }, 300_000);

  /**
   * A download records the ancestor itself, rather than leaving it for the
   * next pass to notice.
   *
   * Once a file has been downloaded, local and remote agree, so the pass above
   * would set the ancestor on the following scan anyway. That makes the two
   * mechanisms cover for each other, and cover is not the same as either one
   * being tested. This closes the window between them: B downloads and the
   * user edits straight away, so there is no following scan in which both
   * sides still agree.
   */
  it("records the ancestor on the download itself", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await a.vault.edit("note.md", base);
    await a.engine.sync();
    await receiveCommitted(b.transport);

    await b.engine.sync();
    expect(b.vault.text("note.md"), "B was meant to have downloaded it by now").toBe(base);

    // Edited before any pass in which local and remote still agree.
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );
    await a.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await convergeBoth(a, b, 6);

    for (const d of [a, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
      expect(
        d.vault.paths().filter((x) => x.includes("Conflicted copy")),
        `${d.name} conflicted`,
      ).toEqual([]);
    }
  }, 300_000);

  it("runs one pass at a time however often it is asked", async () => {
    // Two passes deciding about the same file from the same index is how a
    // file gets uploaded twice or downloaded over itself.
    await fresh();
    const a = await device("a");
    for (let i = 0; i < 8; i++) await a.vault.edit(`note${i}.md`, `content ${i}`);

    const [first, second, third] = await Promise.all([
      a.engine.sync(),
      a.engine.sync(),
      a.engine.sync(),
    ]);

    // The later calls set a flag and return nothing rather than starting a
    // second pass, so the total is the work done once.
    const uploaded = first.uploaded + second.uploaded + third.uploaded;
    expect(uploaded).toBe(8);
    const settled = await a.engine.sync();
    expect(settled.uploaded).toBe(0);
  }, 120_000);
});

/**
 * A pass that throws on its way out leaves its queues full.
 *
 * Nothing in the loop can do that today: every path is inside a try that records
 * the failure and carries on, and the only throwing steps left (listing, pruning,
 * saving) sit outside the window where anything is queued. The guard is here
 * because the consequence is quiet rather than loud: those writes would commit
 * during the *next* pass and increment a report nobody reads, so the pass that
 * did the work would report none, and `settle` would stop with edits unsent.
 *
 * Discarding is safe. Nothing queued was acknowledged, so no entry is marked
 * synced, and reconciliation queues the same work again.
 */
describe("a pass that ended early", () => {
  it("discards what it queued rather than committing it against the next report", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.write("real.md", new TextEncoder().encode("a real note"), {
      mtime: 1000,
      ctime: 1000,
    });
    await a.settle();

    // What a thrown pass would leave behind. If the guard goes, this commits
    // during the next pass and its uid lands on nothing.
    let committed = false;
    const engine = a.engine as unknown as { outbox: unknown[]; inbox: unknown[] };
    engine.outbox.push({
      path: "left-over.md",
      size: 0,
      entry: { path: "left-over", meta: { size: 0, ctime: 0, mtime: 0, folder: true }, names: [] },
      bodyOf: async () => new Uint8Array(0),
      commit: () => {
        committed = true;
      },
    });

    const report = await a.engine.sync();

    expect(committed, "a write left by a dead pass was committed by the next one").toBe(false);
    expect(engine.outbox).toHaveLength(0);
    expect(report.uploaded).toBe(0);
  });
});

describe("what the index forgets", () => {
  /**
   * `entries` was pruned and `remote` was not, so a vault kept the server's
   * word about every path it had ever deleted, for ever, in a file rewritten
   * on every sync. Measured before the fix: six hundred deleted notes left a
   * 59 KB index that only ever grew.
   */
  it("does not keep a record of every note ever deleted", async () => {
    await fresh();
    const a = await device("a");

    for (let i = 0; i < 40; i++) await a.vault.edit(`note-${i}.md`, `body ${i}\n`);
    await a.settle();
    expect(await remoteCount(a)).toBe(40);

    for (let i = 0; i < 40; i++) await a.vault.remove(`note-${i}.md`);
    await a.settle();
    expect(await remoteCount(a), "the index kept a tombstone per deleted note").toBe(0);
    expect(await entryCount(a)).toBe(0);
  }, 300_000);

  /**
   * The whole risk of forgetting. A deletion this device has applied must
   * stay applied: if dropping the record let the file come back, the prune
   * would be undoing somebody's deletion on every pass.
   */
  it("does not let a deletion undo itself once forgotten", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("gone.md", "here for now\n");
    await convergeBoth(a, b);
    expect(b.vault.text("gone.md")).toBe("here for now\n");

    await a.vault.remove("gone.md");
    await convergeBoth(a, b, 6);
    expect(await remoteCount(a)).toBe(0);

    // Several more passes, long after the record was dropped.
    await convergeBoth(a, b, 6);
    expect(a.vault.paths()).not.toContain("gone.md");
    expect(b.vault.paths()).not.toContain("gone.md");
  }, 300_000);

  /**
   * A device that was away when the deletion happened still learns about it,
   * because that comes from the server's batches rather than from anybody's
   * local index.
   */
  it("still tells a device that was not there", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("gone.md", "here for now\n");
    await a.settle();
    await a.vault.remove("gone.md");
    await a.settle();
    expect(await remoteCount(a)).toBe(0);

    const late = await device("late");
    await late.settle(6);
    expect(late.vault.paths()).not.toContain("gone.md");
  }, 300_000);

  /**
   * Work still outstanding is not something to forget.
   *
   * Applying an incoming deletion can fail on a real device: a locked file is
   * the ordinary case. The path stays on the inbound work list, and the
   * server's word about it is what the retry will act on. Dropping that
   * record would leave a work item nothing could ever resolve, and a file
   * that stays on this device after being deleted everywhere else.
   */
  it("keeps what it needs while a deletion has not been applied yet", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("locked.md", "cannot be removed just now\n");
    await convergeBoth(a, b);
    expect(b.vault.text("locked.md")).toBeDefined();

    // B is told to delete it and cannot, this once.
    b.vault.failRemoveOnce = "locked.md";
    await a.vault.remove("locked.md");
    await a.settle();
    await receiveCommitted(b.transport);
    // One pass, not a settle: a settle would retry within the same call and
    // the window being tested would close before it could be looked at.
    await b.engine.sync();

    // The file is still there, so the work is not done, and the record of
    // what to do must have survived.
    expect(b.vault.paths(), "the removal was meant to fail").toContain("locked.md");
    expect(await remoteCount(b), "B forgot what it still had to do").toBeGreaterThan(0);

    // And the retry finishes the job.
    await convergeBoth(a, b, 8);
    expect(b.vault.paths()).not.toContain("locked.md");
  }, 300_000);

  /** A path used again after being deleted is a new file, and syncs like one. */
  it("handles a path used again after it was forgotten", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("reused.md", "the first note\n");
    await convergeBoth(a, b);
    await a.vault.remove("reused.md");
    await convergeBoth(a, b, 6);
    expect(await remoteCount(a)).toBe(0);

    await a.vault.edit("reused.md", "a completely different note\n");
    await convergeBoth(a, b, 6);
    expect(b.vault.text("reused.md")).toBe("a completely different note\n");
  }, 300_000);
});

describe("a file that could not sync, and then could", () => {
  /**
   * A permanent refusal stops the retries, which is right: a file the server
   * will reject for the same reason every time is noise that hides everything
   * else. But "permanent" describes the *file*, not the path, and a file can
   * be changed.
   *
   * Somebody whose note is refused for being too large shortens it, and
   * nothing happens, because the path was written off. The only way back was
   * to restart the application, and nothing said so.
   *
   * The refusal used here is an over-long name, which shortening the file does
   * not fix, so it is refused again. That is the correct outcome and not the
   * property being tested: what is tested is that it was tried at all, and the
   * log is where an attempt is observable.
   */
  it("tries again once the file has changed", async () => {
    await fresh();
    const said: string[] = [];
    const a = await device("a", (m) => said.push(m));

    // One filename past the server's limit: the cheapest permanent refusal
    // that lands on exactly one path. A deep path would refuse every folder
    // above it too.
    const tooLong = `${"x".repeat(5000)}.md`;
    await a.vault.edit(tooLong, "refused", 1_000);
    await a.vault.edit("fine.md", "accepted", 1_000);

    const refused = await a.settle();
    expect(refused.skipped, `report was ${JSON.stringify(refused)}`).toBe(1);
    expect(said.filter((m) => m === "skipped for good").length).toBe(1);

    // Unchanged, so it stays written off rather than being asked again.
    await a.settle();
    expect(said.filter((m) => m === "skipped for good").length).toBe(1);
    expect(said.filter((m) => m.startsWith("skipped file changed")).length).toBe(0);

    // Now the file changes.
    await a.vault.edit(tooLong, "different content entirely", 2_000);
    await a.settle();
    expect(
      said.filter((m) => m.startsWith("skipped file changed")).length,
      "a changed file was never tried again",
    ).toBe(1);
    // Tried, and refused again, which is the honest outcome for a name that
    // is still too long.
    expect(said.filter((m) => m === "skipped for good").length).toBe(2);
  }, 300_000);
});

/** How many paths the persisted index still has the server's word about. */
async function remoteCount(d: Device): Promise<number> {
  const state = await d.store.load();
  return state ? Object.keys(state.remote).length : 0;
}

async function entryCount(d: Device): Promise<number> {
  const state = await d.store.load();
  return state ? Object.keys(state.entries).length : 0;
}

describe("what a large attachment costs to send", () => {
  /**
   * A put used to take every chunk of a file at once, so a 256 MiB attachment,
   * which is the size the server advertises it will take, meant twice that
   * live: the file and a copy of it for the wire. Measured rather than
   * guessed, and on a phone that is not a spike but the end of the process.
   *
   * The names still have to be known before the put is sent, so the file is
   * chunked and named in full either way. What changed is that a vault that
   * can read a file in blocks and ranges is never asked for the whole of it:
   * the file is read once to cut and name it, a chunk at a time, and a chunk
   * the server wants is read back from the disk and hashed again before it
   * goes, framed as it is sent. Basalt sealed the chunk a second time here;
   * protocol 1 has nothing to seal, so the check is the hash.
   */
  /**
   * Windowing must change nothing but the time. If the names differed from
   * what naming each chunk on its own produces, a file would go up under names
   * no other device agrees with, and every one of them would download it
   * again for ever.
   */
  it("names a file the same whatever window it is named in", async () => {
    // Comfortably more than one window. Content-defined chunking on random
    // bytes gives a count that varies run to run, so a file sized to land
    // near the window boundary makes this test flaky rather than wrong.
    const big = new Uint8Array(24 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
    }
    const pieces = [...chunkBytes(big, sizesFor(big.length, false), false)].map((c) => c.bytes);
    expect(pieces.length, "the test file is too small to have windows at all").toBeGreaterThan(
      NAME_WINDOW * 2,
    );

    const oneByOne: string[] = [];
    for (const piece of pieces) oneByOne.push(await chunkName(piece));
    for (const window of [1, 3, NAME_WINDOW, pieces.length * 2]) {
      expect(await chunkNames(pieces, window), `window ${window}`).toEqual(oneByOne);
    }
  });

  /**
   * The server refuses an oversized file at the put, which is correct and far
   * too late: by then the client has read it, chunked it and named it, and
   * preparing a file costs several times its own size in memory. A file just
   * over the limit therefore cost the most memory of anything in the vault in
   * order to produce an error its size alone predicted.
   */
  it("refuses a file over the server's limit without reading it", async () => {
    await fresh();
    const a = await device("a");

    const limit = a.engine.limits?.perFileMax ?? 0;
    expect(limit, "the server advertised no file limit").toBeGreaterThan(0);

    // Counted rather than inferred: the property is that the bytes are
    // never fetched, and the vault is the only thing that knows.
    let reads = 0;
    const realRead = a.vault.read.bind(a.vault);
    a.vault.read = async (path: string) => {
      reads++;
      return realRead(path);
    };

    await a.vault.write("huge.bin", new Uint8Array(limit + 1), { mtime: 1000, ctime: 1000 });
    const report = await a.engine.sync();

    expect(reads, "the oversized file was read anyway").toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.uploaded).toBe(0);

    // Written off, not retried: a file does not get smaller by trying again.
    const again = await a.engine.sync();
    expect(again.skipped).toBe(1);
    expect(reads).toBe(0);

    // And undone the moment it changes, so trimming an attachment syncs it.
    await a.vault.write("huge.bin", new Uint8Array(16), { mtime: 2000, ctime: 1000 });
    const third = await a.engine.sync();
    expect(third.uploaded).toBe(1);
    expect(reads).toBeGreaterThan(0);
  });

  /**
   * A streamed file and a held file must produce identical names, or the two
   * adapters would disagree about what a file is called: the headless client
   * streams, the plugin cannot, and a vault synced by both would store every
   * large file twice and never recognise either copy.
   */
  it("names a streamed file exactly as a held one", async () => {
    const { chunkBytes, chunkStream, sizesFor } = await import("./chunk.ts");

    const bytes = new Uint8Array(9 * 1024 * 1024);
    for (let at = 0; at < bytes.length; at += 65536) {
      crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, bytes.length)));
    }
    const sizes = sizesFor(bytes.length, false);

    const held = await chunkNames([...chunkBytes(bytes, sizes, false)].map((c) => c.bytes));

    async function* blocks(size: number) {
      for (let at = 0; at < bytes.length; at += size) {
        yield bytes.slice(at, Math.min(at + size, bytes.length));
      }
    }

    // Block size must not change the answer either. The chunker cuts on
    // content, so a boundary that moved with the read size would be a
    // rolling hash that was not rolling.
    for (const blockSize of [4096, 64 * 1024, 1024 * 1024, bytes.length]) {
      const streamed: string[] = [];
      const spans: number[] = [];
      for await (const piece of chunkStream(blocks(blockSize), sizes, false)) {
        streamed.push(await chunkName(piece.bytes));
        spans.push(piece.offset);
      }
      expect(streamed, `block size ${blockSize}`).toEqual(held);
      // And the offsets have to be right, because a wanted chunk is read
      // back by range and would otherwise be different bytes.
      expect(spans[0]).toBe(0);
    }
  });

  /**
   * A memory vault that can hand a file out in blocks and ranges, the way the
   * headless client's disk can, and says how much of a file it was ever asked
   * for at once.
   */
  class StreamingVault extends MemoryVault {
    /** Whole-file reads, by path. */
    readonly wholeReads = new Map<string, number>();
    /** The ranges read back, as [start, end]. */
    readonly ranges: [number, number][] = [];
    /** The most bytes any one read handed out. */
    widest = 0;

    override async read(path: string): Promise<Uint8Array> {
      this.wholeReads.set(path, (this.wholeReads.get(path) ?? 0) + 1);
      return super.read(path);
    }
    async *readBlocks(path: string, blockSize = 64 * 1024): AsyncIterable<Uint8Array> {
      const bytes = await super.read(path);
      for (let at = 0; at < bytes.length; at += blockSize) {
        const block = bytes.slice(at, Math.min(at + blockSize, bytes.length));
        this.widest = Math.max(this.widest, block.length);
        yield block;
      }
    }
    async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
      const range = (await super.read(path)).slice(start, end);
      this.ranges.push([start, end]);
      this.widest = Math.max(this.widest, range.length);
      return range;
    }
  }

  it("does not hold a copy of the whole file", async () => {
    await fresh();
    const said: string[] = [];
    const vault = new StreamingVault();
    const a = await device(
      "a",
      (m: string, ...r: unknown[]) => said.push(m + " " + r.map(String).join(" ")),
      vault,
    );

    // Incompressible, so the frames are the size of the file rather than of a
    // run-length encoding of it, and over the size a file is held whole.
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
    }
    await vault.write("attachment.bin", big, { mtime: 1000, ctime: 1000 });

    const report = await a.engine.sync();
    expect(report.uploaded, said.join(" | ")).toBe(1);
    expect(report.chunksSent, "a 12 MiB attachment came out as one chunk").toBeGreaterThan(1);

    // The property: the file was never in hand as one buffer. It was cut and
    // named from blocks, and each body that went up was read back by range,
    // one chunk at a time, and only for the chunks the server asked for.
    expect(vault.wholeReads.get("attachment.bin") ?? 0, "the whole file was read at once").toBe(0);
    expect(vault.ranges.length, "the bodies were not read back by range").toBe(report.chunksSent);
    expect(vault.widest, "a read handed out more than one chunk").toBeLessThanOrEqual(
      LOCAL_MAX_CHUNK_BYTES,
    );
    // And every byte of it went up once: the ranges tile the file.
    const covered = [...vault.ranges].sort((x, y) => x[0] - y[0]);
    expect(covered[0]![0]).toBe(0);
    for (let i = 1; i < covered.length; i++) expect(covered[i]![0]).toBe(covered[i - 1]![1]);
    expect(covered.at(-1)![1]).toBe(big.length);

    // And it arrives intact, which is the thing reading it back could break:
    // each range has to be byte for byte the chunk that was named, or the
    // server refuses the body against the name it asked for.
    const b = await device("b");
    await b.settle(6);
    const got = await b.vault.read("attachment.bin");
    expect(got.length).toBe(big.length);
    expect(Buffer.from(got).equals(Buffer.from(big)), "the attachment came back different").toBe(
      true,
    );
  }, 300_000);

  /** A note is held while it is sent, because reading it twice saves nothing. */
  it("still sends a small file from the bytes it named", async () => {
    await fresh();
    const vault = new StreamingVault();
    const a = await device("a", undefined, vault);
    await vault.edit("note.md", "a note, which is what almost every file is\n");
    // One pass, because Device.settle returns the last of several and the
    // last one is by construction the one with nothing left to do.
    const report = await a.engine.sync();
    expect(report.uploaded).toBe(1);
    // Under the streaming threshold, so no range was read back for it.
    expect(vault.ranges).toEqual([]);

    const b = await device("b");
    await b.settle(4);
    expect(b.vault.text("note.md")).toBe("a note, which is what almost every file is\n");
  }, 300_000);
});

/**
 * Large files, of both kinds, through the real server.
 *
 * The chunk-size bug that made a max-size chunk exceed the ceiling only bit on
 * data that does not compress, and every large-file test in this project used
 * data that did. These use both: bytes from the random source, which is what a
 * photo or a video is, and prose, which is what a long note is.
 */
describe("large files", () => {
  /** Incompressible, in pieces because getRandomValues has a cap. */
  const noise = (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes);
    for (let at = 0; at < out.length; at += 65536) {
      crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, out.length)));
    }
    return out;
  };

  /** Prose, which compresses, and is what a long note actually is. */
  const prose = (bytes: number): string => {
    const words = "the quick brown fox jumps over a lazy dog while nobody watches".split(" ");
    let out = "";
    let i = 0;
    while (out.length < bytes) {
      out += words[i++ % words.length] + (i % 12 === 0 ? "\n" : " ");
    }
    return out.slice(0, bytes);
  };

  it("carries an attachment that does not compress", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const bytes = noise(9 * 1024 * 1024);
    await a.vault.write("photo.raw", bytes, { mtime: 1000, ctime: 1000 });

    const sent = await a.engine.sync();
    expect(sent.uploaded, `report was ${JSON.stringify(sent)}`).toBe(1);
    expect(sent.chunksSent, "9 MiB arrived as one chunk").toBeGreaterThan(4);

    await convergeBoth(a, b, 6);
    const got = await b.vault.read("photo.raw");
    expect(got.length).toBe(bytes.length);
    expect(Buffer.from(got).equals(Buffer.from(bytes)), "the attachment came back different").toBe(
      true,
    );
  }, 300_000);

  it("carries a note far larger than a note usually is", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const text = prose(6 * 1024 * 1024);
    await a.vault.edit("long.md", text);

    const sent = await a.engine.sync();
    expect(sent.uploaded, `report was ${JSON.stringify(sent)}`).toBe(1);

    await convergeBoth(a, b, 8);
    expect(b.vault.text("long.md")?.length).toBe(text.length);
    expect(b.vault.text("long.md")).toBe(text);
  }, 300_000);

  /**
   * The reason for chunking at all. An edit in the middle of a large file
   * should cost a chunk, not the file.
   */
  it("sends a chunk rather than the file when a large note changes", async () => {
    await fresh();
    const a = await device("a");
    const text = prose(4 * 1024 * 1024);
    await a.vault.edit("long.md", text);
    await a.settle();

    const middle = Math.floor(text.length / 2);
    await a.vault.edit(
      "long.md",
      text.slice(0, middle) + "an inserted sentence. " + text.slice(middle),
      2_000_000,
    );
    const again = await a.engine.sync();

    expect(again.uploaded).toBe(1);
    expect(
      again.bytesSent,
      `an edit to a 4 MiB note cost ${again.bytesSent} bytes across ${again.chunksSent} chunks`,
    ).toBeLessThan(64 * 1024);
  }, 300_000);

  /** An attachment edited in the middle is the same claim, without deflate. */
  it("sends a chunk rather than the file when a large attachment changes", async () => {
    await fresh();
    const a = await device("a");
    const bytes = noise(8 * 1024 * 1024);
    await a.vault.write("clip.raw", bytes, { mtime: 1000, ctime: 1000 });
    await a.settle();

    const edited = bytes.slice();
    edited.set(noise(1024), Math.floor(edited.length / 2));
    await a.vault.write("clip.raw", edited, { mtime: 2000, ctime: 1000 });
    const again = await a.engine.sync();

    expect(again.uploaded).toBe(1);
    expect(
      again.bytesSent,
      `changing 1 KiB of an 8 MiB attachment cost ${again.bytesSent} bytes`,
    ).toBeLessThan(4 * 1024 * 1024);
  }, 300_000);
});

/**
 * What the client refuses to be told by the server it is talking to.
 *
 * Everything the engine acts on arrives from the server and is the server's
 * word: the path, `size`, `deleted`, `folder` and the chunk list. Protocol 1
 * carries no writer authenticity (PLAN.md section 3.6), so a device takes that
 * word about who wrote an entry; what it does not take is an entry that
 * contradicts itself. These are the invariants the protocol doc already states
 * and the client was not checking on the way in.
 *
 * `docs/protocol.md`: "a file declaring a size names at least one chunk, since a
 * size with no chunks is byte-identical on the wire to an empty note." That was
 * assigned to the server and never mirrored here, so one frame emptied a note:
 * chunkNamesOf("-empty-") is [], nothing was fetched, and the zero-length
 * assembly was written straight over the file. Through `write`, not `remove`, so
 * there was no trash copy either, and the emptied note then propagated to every
 * peer as an ordinary edit.
 *
 * A writer's bug does this as readily as a hostile server, and a corrupt row
 * reproduces it exactly, which is why these are refused rather than trusted.
 *
 * Basalt's version of this group opened with three refusals of entries whose
 * authenticator was missing, forged, or did not cover the fields as they
 * arrived (plan/strip-ledger.md, engine.test.ts:2628, :2656, :2682). Protocol 1
 * has no authenticator, so they went with it.
 */
describe("a batch that contradicts itself", () => {
  let server: TestServer;
  let a: Device;

  afterEach(async () => {
    a?.transport?.close();
    if (server) await server.cleanup();
  });

  /** One device holding one synced note. */
  async function synced(): Promise<{ path: string; before: Uint8Array }> {
    server = new TestServer();
    await server.start();
    a = new Device("a");
    await a.connect(server);

    const path = "Notes/keep.md";
    const before = new TextEncoder().encode("a paragraph worth keeping\n");
    await a.vault.write(path, before, { mtime: a.clock, ctime: a.clock });
    await a.engine.sync();
    expect(await a.vault.read(path)).toEqual(before);
    return { path, before };
  }

  /** A chunk name of the right shape, so the check a case is about is the one that fires. */
  const someChunk = "c".repeat(64);

  it("refuses a size with no chunks, rather than emptying the note", async () => {
    const { path, before } = await synced();
    const uid = 1_000_000;

    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          {
            uid,
            path,
            size: before.length,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: false,
            chunks: [],
            device: "b",
          },
        ],
      }),
    ).rejects.toThrow(/declares \d+ bytes and names no chunks/);

    // And the note is still there. A refusal that already wrote is not one.
    expect(await a.vault.read(path)).toEqual(before);
  });

  it("refuses chunks on an entry that says it is a deletion", async () => {
    const { path } = await synced();
    const uid = 1_000_000;
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          {
            uid,
            path,
            size: 0,
            ctime: 0,
            mtime: a.clock,
            folder: false,
            deleted: true,
            chunks: [someChunk],
            device: "b",
          },
        ],
      }),
    ).rejects.toThrow(/is a deletion and names 1 chunks/);
  });

  it("refuses chunks on an entry that says it is a folder", async () => {
    const { path } = await synced();
    const uid = 1_000_000;
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          {
            uid,
            path,
            size: 0,
            ctime: 0,
            mtime: a.clock,
            folder: true,
            deleted: false,
            chunks: [someChunk],
            device: "b",
          },
        ],
      }),
    ).rejects.toThrow(/is a folder and names 1 chunks/);
  });

  /**
   * The substitution the arrival check cannot see: a chunk list that is
   * internally consistent and belongs to a different file. Every chunk hashes
   * to its name, because every chunk is real; nothing binds one to the file it
   * was cut from. What catches it is that the bytes do not add up to the size
   * the entry declares, and the declared size is a count of the bytes that
   * were chunked rather than a stat, so that comparison is exact.
   */
  it("refuses a chunk list belonging to another file", async () => {
    const { path, before } = await synced();

    const other = "Notes/other.md";
    await a.vault.write(other, new TextEncoder().encode("a different length entirely, longer\n"), {
      mtime: a.clock,
      ctime: a.clock,
    });
    await a.engine.sync();

    const stored = await a.store.load();
    const otherChunks = (stored?.entries[other] as { chunks?: string[] } | undefined)?.chunks ?? [];
    expect(otherChunks.length, "the other note should have chunks to steal").toBeGreaterThan(0);

    const uid = 1_000_000;
    await a.engine.acceptBatch({
      from: uid,
      to: uid,
      entries: [
        {
          uid,
          path,
          // The size of the file being overwritten, with the chunks of
          // the one being substituted in.
          size: before.length,
          ctime: 0,
          mtime: a.clock + 5000,
          folder: false,
          deleted: false,
          chunks: [...otherChunks],
          device: "b",
        },
      ],
    });

    await a.engine.sync();

    // The note is untouched. A refusal that already wrote is not a refusal.
    expect(await a.vault.read(path)).toEqual(before);
  });

  /**
   * A batch is one unit. Applied entry by entry, everything before a failure
   * stayed, `save()` persisted it, and `deleteLocal` needs no server to act on
   * it later: a deletion followed by an entry the engine refused landed the
   * deletion while the session died looking like a misconfiguration.
   *
   * The later entry used to be one sealed under another vault's key, which
   * protocol 1 cannot express. It is an entry that contradicts itself instead,
   * a refusal that stands on its own (hazard 5 in plan/strip-ledger.md), and
   * the rejection is matched to it so the case cannot pass on some other
   * failure while the deletion in front goes unexamined.
   */
  it("applies nothing from a batch whose later entry contradicts itself", async () => {
    const { path, before } = await synced();
    const uid = 1_000_000;

    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid + 1,
        entries: [
          // A well-formed deletion of the synced note, which on its own would
          // be applied.
          {
            uid,
            path,
            size: 0,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: true,
            chunks: [],
            device: "b",
          },
          {
            uid: uid + 1,
            path: "Notes/theirs.md",
            size: 0,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: true,
            deleted: true,
            chunks: [],
            device: "b",
          },
        ],
      }),
    ).rejects.toThrow(/is both a folder and a deletion/);

    // The deletion in front of it must not survive the refusal.
    await a.engine.sync();
    expect(await a.vault.read(path)).toEqual(before);
    expect(a.engine.status().pending, "the refused batch left work behind").toBe(0);
  });

  it("still accepts an ordinary empty note, which is a size of zero and no chunks", async () => {
    const { path } = await synced();
    const uid = 1_000_000;
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          {
            uid,
            path,
            size: 0,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: false,
            chunks: [],
            device: "b",
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Missing has to mean this device's own ceiling, never no ceiling.
 *
 * `numberOf()` maps an absent field to 0, and both inbound guards used to read
 * `if (max > 0)`, so a server that simply left `perFileMax` and `maxChunks` out
 * of `ready` turned off the only bounds on inbound work. A corrupt row does the
 * same thing, which is what the guards were written for in the first place.
 */
describe("bounds taken from the party they exist to bound", () => {
  it("falls back to this device's ceiling rather than to none", () => {
    expect(boundedBy(0, 100)).toBe(100);
  });

  it("takes the server's when it is tighter", () => {
    expect(boundedBy(50, 100)).toBe(50);
  });

  it("refuses to be talked upwards", () => {
    expect(boundedBy(1_000_000, 100)).toBe(100);
  });

  it("has ceilings at the protocol's own maxima", () => {
    expect(OWN_LIMITS.perFileMax).toBe(256 * 1024 * 1024);
    expect(OWN_LIMITS.maxChunks).toBe(65536);
  });

  /**
   * The outbound half of the same rule, which was left behind when the inbound
   * half was converted.
   *
   * `assemble` reads its ceiling through `boundedBy`; the pre-check in
   * `reconcile` read the server's raw number and gated on `> 0`. Against a
   * server advertising `perFileMax: 0` that guard was simply off, so this
   * device would read, chunk and name a file no server anywhere will store,
   * which on a phone is the end of the process rather than a wasted pass.
   */
  it("refuses an outbound file over this device's ceiling when the server names none", async () => {
    class Huge extends MemoryVault {
      override async list() {
        return [
          {
            path: "huge.bin",
            folder: false,
            mtime: 1000,
            ctime: 1000,
            size: OWN_LIMITS.perFileMax + 1,
          },
        ];
      }
      override async read(): Promise<Uint8Array> {
        throw new Error("read a file the size pre-check should already have refused");
      }
    }
    const { engine } = await engineOnFakeSocket({ perFileMax: 0 }, { vault: new Huge() });
    const report = await engine.sync();
    expect(report.uploaded).toBe(0);
    expect(report.retrying, "refused for a reason no retry changes").toBe(0);
    expect(report.skipped).toBe(1);
  });
});

/**
 * A server behind its own clients is a restored backup or the wrong vault, and
 * the client used to sync against it happily, reporting "up to date" because the
 * status line clamped the gap at zero.
 */
describe("a server that is behind this device", () => {
  it("is refused", () => {
    expect(() => refuseIfBehind(5, 9)).toThrow(/restored backup or the wrong vault/);
  });

  /**
   * The refusal used to end at the diagnosis, and the recovery lived in
   * docs/server.md. The person reading this is looking at a vault that has
   * stopped syncing, on a phone as often as not; an error string is the only
   * UI they have. Both ways back are named, and the cost of them, because
   * either resets the merge base.
   *
   * Basalt's first way back was `trew rebase --backup-taken`, which the
   * headless client no longer has: a restore through `trewd backup` starts a
   * new epoch, the server replays the vault, and nothing is asked of the
   * device, so what is left to recover from here is a data directory copied
   * back behind the server's back, and the refusal says that too.
   */
  it("names both recoveries, and what they cost", () => {
    let thrown: unknown;
    try {
      refuseIfBehind(5, 9);
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as Error).message;
    expect(message).toContain("Rejoin this server");
    expect(message).toMatch(/pair it again with a new invite/);
    expect(message).toMatch(/new epoch/);
    expect(message).toMatch(/conflict copies instead of merging/);
    expect(message, "the recovery pushed the numbers out of the refusal").toMatch(/5.*9|9.*5/);
  });

  /**
   * Carried under the server's own code for this, so a shell has one thing to
   * recognise however the refusal arrived, and so `runForever` stops on it.
   * As a plain Error it was retried three times and then reported under a
   * message about an entry no device can apply, which is a different fault
   * with a different fix.
   */
  it("is a fatal protocol refusal, under the code the server uses", () => {
    let thrown: unknown;
    try {
      refuseIfBehind(5, 9);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe("cursor");
    expect((thrown as ProtocolError).fatal, "a refusal no retry can help was retryable").toBe(true);
  });

  it("is fine when level, which is the ordinary case", () => {
    expect(() => refuseIfBehind(9, 9)).not.toThrow();
  });

  it("is fine when ahead, which is every sync with something to fetch", () => {
    expect(() => refuseIfBehind(90, 9)).not.toThrow();
  });

  it("is fine for a device that has never synced", () => {
    expect(() => refuseIfBehind(0, 0)).not.toThrow();
  });
});

/**
 * A move should not put the file back on the wire.
 *
 * Chunk names are hashes of the raw bytes, so moving a file costs the sender
 * nothing: the server already holds every chunk and only metadata travels. The
 * receiver had no such luck and downloaded the whole file back, under a name it
 * was already storing the identical bytes under. Moving one folder of
 * attachments re-pulled all of it, on every other device.
 *
 * Proved the only way that leaves no doubt: every chunk body is deleted from the
 * server before the receiving device syncs, so a single byte off the wire would
 * fail the test rather than merely be slower.
 */
describe("a move is not a download", () => {
  let server: TestServer;
  let a: Device;
  let b: Device;

  afterEach(async () => {
    a?.transport?.close();
    b?.transport?.close();
    if (server) await server.cleanup();
  });

  it("applies from bytes the device already holds, with the server emptied", async () => {
    server = new TestServer();
    await server.start();
    a = new Device("a");
    b = new Device("b");
    await a.connect(server);
    await b.connect(server);

    const body = new TextEncoder().encode("a paragraph worth moving.\n".repeat(400));
    await a.vault.write("Notes/big.md", body, { mtime: a.clock, ctime: a.clock });
    await convergeBoth(a, b);
    expect(await b.vault.read("Notes/big.md")).toEqual(body);

    // The move, as a delete of the old path and a write of the new one,
    // which is what a filesystem scan sees.
    await a.vault.remove("Notes/big.md");
    await a.vault.write("Archive/big.md", body, { mtime: a.clock + 1000, ctime: a.clock + 1000 });
    await a.engine.sync();
    await receiveCommitted(b.transport);

    // Now the server cannot serve a single byte of it.
    const { rm, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const chunks = join(server.dataDir, "chunks");
    for (const vault of await readdir(chunks)) {
      await rm(join(chunks, vault), { recursive: true, force: true });
    }

    await b.engine.sync();

    expect(await b.vault.read("Archive/big.md"), "the move needed the wire after all").toEqual(
      body,
    );
  }, 300_000);
});

/**
 * The index must never be durable ahead of the notes it names.
 *
 * A vault write used to make the file and its directory entry durable before it
 * returned. Flushing the directory once per pass instead of once per file is
 * 10.7 s against 6.1 s for two thousand files, and it moves when the name
 * becomes durable, so the ordering stops being incidental and has to be stated:
 * everything the pass wrote is made durable, and only then is the index written.
 *
 * Get it backwards and a crash leaves an index naming notes that are not there,
 * which the index would then believe on the next pass. That is rule 3 wearing a
 * different hat, and it is the whole reason the deferral is safe.
 */
describe("what is made durable, and in what order", () => {
  let server: TestServer;
  let a: Device;

  afterEach(async () => {
    a?.transport?.close();
    if (server) await server.cleanup();
  });

  it("flushes the vault before it writes the index", async () => {
    server = new TestServer();
    await server.start();
    a = new Device("a");

    const order: string[] = [];
    const vault = a.vault as unknown as { flush?: () => Promise<void> };
    vault.flush = async () => {
      order.push("vault flushed");
    };
    const store = a.store as unknown as { save(s: unknown): Promise<void> };
    const realSave = store.save.bind(store);
    store.save = async (state: unknown) => {
      order.push("index written");
      await realSave(state);
    };

    await a.connect(server);
    await a.vault.write("note.md", new TextEncoder().encode("hello\n"), {
      mtime: a.clock,
      ctime: a.clock,
    });
    await a.engine.sync();

    expect(order.length, "neither happened").toBeGreaterThan(0);
    expect(order[0], `order was ${order.join(", ")}`).toBe("vault flushed");
    expect(order).toContain("index written");
    // And every pass, not just the first: a pass that wrote nothing still
    // has nothing outstanding only because the flush said so.
    expect(order.filter((o) => o === "vault flushed").length).toBe(
      order.filter((o) => o === "index written").length,
    );
  }, 300_000);
});

/**
 * The index round trips through its stored form.
 *
 * A vault's chunk names were written to disk three times: as the list, joined
 * as `hash`, and usually a third time as `synchash`. The stored form leaves out
 * whatever it can derive, and an entry has to come back identical or the index
 * is lying about what is on disk.
 *
 * The case that has to survive is the one where those fields genuinely differ:
 * a file edited since its last sync, where `hash` is the new content and
 * `synchash` is the merge base. Collapsing them would not save space, it would
 * lose the ancestor.
 */
describe("what the index leaves out, and puts back", () => {
  let server: TestServer;
  let a: Device;

  afterEach(async () => {
    a?.transport?.close();
    if (server) await server.cleanup();
  });

  it("comes back the same, for a settled file and an edited one", async () => {
    server = new TestServer();
    await server.start();
    a = new Device("a");
    await a.connect(server);

    const enc = new TextEncoder();
    await a.vault.write("settled.md", enc.encode("one\n"), { mtime: a.clock, ctime: a.clock });
    await a.vault.write("edited.md", enc.encode("one\n"), { mtime: a.clock, ctime: a.clock });
    await a.engine.sync();

    // A completed sync always leaves the two agreeing, so the case where they
    // differ is made directly: an entry scanned since its last sync, whose
    // synchash is still the ancestor. That is the state a merge reads.
    const entries = (a.engine as unknown as { entries: Map<string, IndexEntry> }).entries;
    const edited = entries.get("edited.md")!;
    edited.synchash = "an-older-content-id";
    // And one with no chunk list at all, which is what an unscanned file looks
    // like and the case where `hash` cannot be derived.
    entries.get("settled.md")!.chunks = [];

    const held = (d: Device) =>
      new Map(
        [...(d.engine as unknown as { entries: Map<string, unknown> }).entries].map(([k, v]) => [
          k,
          JSON.stringify(v),
        ]),
      );
    await (a.engine as unknown as { save(): Promise<void> })["save"]();
    const before = held(a);
    const differ = [
      ...(a.engine as unknown as { entries: Map<string, { hash: string; synchash: string }> })
        .entries,
    ].filter(([, e]) => e.hash !== e.synchash);
    expect(
      differ.length,
      "no entry where the two hashes differ, so the hard case is untested",
    ).toBeGreaterThan(0);

    // A second engine over the same index must see exactly what the first held.
    const b = new Device("a");
    (b as unknown as { store: unknown }).store = a.store;
    await b.connect(server);
    const after = held(b);
    b.transport.close();

    expect(after.size, "the reloaded index is empty").toBe(before.size);
    for (const [path, want] of before) {
      expect(after.get(path), `${path} did not survive the round trip`).toBe(want);
    }
  }, 300_000);
});

/**
 * N4. `--ignore` is a decision, not a failure, and the two counters say so.
 * What `status()` said was neither: it had no `ignored` field at all, so a
 * programmatic caller could not see the decision, and the path stayed on the
 * inbound work list for ever, so what the caller did see was work
 * outstanding on a folder that was never going to arrive. Rule 7.
 */
describe("what status says about a folder this device ignores (N4)", () => {
  it("counts it as ignored and owes no work for it", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b", undefined, new IgnoringVault("Drafts"));

    await a.vault.edit("Drafts/plan.md", "not for the other one\n");
    await a.vault.edit("keep.md", "for everybody\n");
    await convergeBoth(a, b);

    const status = b.engine.status();
    expect(status.ignored, "an ignored path is not visible to a caller").toBe(2);
    expect(status.pending, "an ignored path was left owing work for ever").toBe(0);
    expect(status.skipped, "a decision was filed as a failure").toBe(0);
    // And the rest of the vault arrived, which is the other half of it.
    expect(b.vault.text("keep.md")).toBe("for everybody\n");
    expect(b.vault.text("Drafts/plan.md")).toBeUndefined();
  }, 60_000);

  it("owes no work for an ignored path after a single pass", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b", undefined, new IgnoringVault("Drafts"));

    // Only ignored content, so one pass on b settles everything else. The
    // multi-pass test above cannot see this: its second pass drops the path
    // through the reconcile loop, hiding that the first pass left it owing.
    await a.vault.edit("Drafts/plan.md", "not for the other one\n");
    await a.settle();
    await receiveCommitted(b.transport);

    await b.engine.sync();

    const status = b.engine.status();
    // Two: the folder and the file under it, which the vault refuses
    // separately, as the multi-pass test above pins.
    expect(status.ignored, "an ignored path is not counted").toBe(2);
    expect(status.pending, "an ignored path was left owing work after one pass").toBe(0);
  }, 60_000);
});

/**
 * N2. The count is not an identity. A pass that writes off a different file
 * than the pass before it is a different report, and a shell that has only
 * the number cannot tell: it says nothing, and the person is left with a
 * glyph that says something is wrong and nothing that says what.
 */
describe("which files a pass wrote off, not just how many (N2)", () => {
  it("names them, so a swapped failure is a different report", async () => {
    await fresh();
    const vault = new RefusingVault();
    const a = await device("a", undefined, vault);

    vault.refuse.add("one.md");
    await vault.edit("one.md", "cannot be opened\n");
    await vault.edit("two.md", "fine\n");
    const first = await a.engine.sync();
    expect(first.skipped).toBe(1);
    expect(first.skippedPaths).toEqual(["one.md"]);

    // Taken out of the vault, which is what stops a written-off path being
    // counted. One pass to see it has gone.
    await vault.remove("one.md");
    await a.engine.sync();

    // And now a different file will not open. One before, one now.
    vault.refuse.add("two.md");
    await vault.edit("two.md", "and now this one will not\n");
    const second = await a.engine.sync();
    expect(second.skipped, "the count did not move, which is the point").toBe(1);
    expect(second.skippedPaths).toEqual(["two.md"]);
  }, 60_000);
});

/**
 * A file written off for good is written off for this vault's state, not for
 * the life of the process. Nothing pinned that, and reading the code invites
 * the opposite conclusion: the comparison is against the index entry, which
 * looks like something only a successful sync updates. It is not, because
 * `observe` stamps every entry from the listing at the top of every pass, so
 * the fingerprint tracks the disk.
 *
 * The property somebody actually depends on: they are told a file cannot sync,
 * they fix it, and the next pass takes it.
 */
describe("a written-off file that somebody has since fixed", () => {
  it("is tried again, and syncs", async () => {
    await fresh();
    const vault = new RefusingVault();
    const a = await device("a", undefined, vault);

    vault.refuse.add("one.md");
    await vault.edit("one.md", "cannot be opened\n");
    expect((await a.engine.sync()).skipped, "not written off in the first place").toBe(1);

    // Fixed: it opens now, and the file on disk has changed.
    vault.refuse.delete("one.md");
    await vault.edit("one.md", "opens now\n");

    const second = await a.engine.sync();
    expect(second.skipped, "still written off after being fixed").toBe(0);
    expect(second.uploaded, "the repaired file never went up").toBe(1);
  }, 60_000);
});

/**
 * Two notes that differ only by case, one written on each device.
 *
 * The describe above hands a folding disk two notes another device already
 * holds. Here each device writes one: `Note.md` where the disk keeps case
 * apart, `note.md` where it does not. The arriving one must not land on top of
 * the note that device wrote. Rule 10: the property is that both texts
 * survive, not that the two devices agree.
 *
 * In Basalt the server held both, so the device that keeps case apart ended
 * up with both. A protocol 1 server takes whichever arrives first and refuses
 * the other as a `collision` (PLAN.md section 4.1), so each text survives on
 * the device that wrote it, and the refused one is named there, with the
 * server's reason, beside the one in its way.
 */
describe("two notes that differ only by case, one written on each device", () => {
  it("keeps the folding device's own note and both texts survive", async () => {
    await fresh();
    const linux = await device("linux", undefined, new CaseKeepingVault());
    const mac = await device("mac", undefined, new AliasingVault());

    await linux.vault.edit("Note.md", "written on linux\n");
    await mac.vault.edit("note.md", "written on the mac\n");
    // Linux syncs first in every round, so its spelling is the one the
    // server takes.
    await convergeBoth(linux, mac, 4);
    const report = await mac.engine.sync();

    // The Mac's note is untouched, and nothing it holds was replaced.
    expect(mac.vault.text("note.md")).toBe("written on the mac\n");
    expect(mac.vault.paths()).toEqual(["note.md"]);
    // The Linux text is on the device that wrote it and on the server; the
    // Mac's never reached either, because the server refused it.
    expect(linux.vault.snapshot()).toEqual({ "Note.md": "written on linux\n" });
    expect(await server.cli("cat", "-path", "Note.md")).toBe("written on linux\n");
    await expect(server.cli("cat", "-path", "note.md")).rejects.toThrow(/has never held/);
    // And the Mac says so, naming the file in the way, every pass until a
    // person renames one of them...
    expect(report.blocked).toBe(1);
    expect(report.inTheWay).toEqual([{ path: "Note.md", blockedBy: "note.md" }]);
    // ...and naming its own note as the one the server would not take.
    expect(report.skippedPaths).toEqual(["note.md"]);
    // The four maps are untouched and the one list a person reads is built
    // from them, with the sentence rather than the category. Both surfaces
    // print this and neither invents its own words for it any more.
    expect(report.needsAttention).toHaveLength(2);
    expect(report.needsAttention[0]).toEqual({
      path: "Note.md",
      why:
        '"note.md" is a file here and a folder on another device. ' +
        "Rename one of them, on whichever device meant the other thing.",
    });
    const refused = report.needsAttention[1]!;
    expect(refused.path).toBe("note.md");
    expect(refused.why).toMatch(/^collision: /);
    expect(refused.why).toContain('"Note.md"');
    expect(refused.why).toMatch(/Rename one of the two\.$/);
  }, 240_000);
});

/**
 * The one list, built from the four maps, over a real server.
 *
 * `blocked`, `skipped` and the inbound refusals folded into `skipped` are three
 * of our categories and one of a person's: every one of them means "this path
 * is not syncing and waiting will not fix it", and what differs is the reason.
 * Rule 7 asked for one list and the reasons are what it carries, so this checks
 * that a path written off arrives in it with a sentence somebody can act on,
 * not with a category name.
 *
 * The counters and the maps are asserted alongside, because the verdict on this
 * was to simplify what is printed and leave the model alone: each of the four
 * came from its own incident and they carry different exit-code semantics.
 */
describe("what needs attention, as one list with reasons", () => {
  it("carries a sentence for a file the vault will never open", async () => {
    await fresh();
    const refusing = new RefusingVault();
    const a = await device("a", undefined, refusing);
    await a.vault.edit("fine.md", "fine\n");
    await a.vault.edit("cursed.md", "nope\n");
    refusing.refuse.add("cursed.md");

    const report = await a.settle(4);

    // The category is still there, with its counter and its exit-code meaning.
    expect(report.skipped).toBeGreaterThan(0);
    expect(report.skippedPaths).toContain("cursed.md");
    // And so is the sentence, against the path, in the one list.
    const said = report.needsAttention.find((n) => n.path === "cursed.md");
    expect(said, `needsAttention: ${JSON.stringify(report.needsAttention)}`).toBeDefined();
    expect(said!.why).toMatch(/cursed\.md/);
    // A reason, not a category name: nothing in the list should read as one of
    // the four buckets, because that is the distinction rule 7 says not to make
    // a person learn.
    expect(said!.why).not.toMatch(/^(skipped|blocked|ignored|refused)$/i);
    // The file that was fine still synced. One refusal is not a stopped vault.
    expect(report.needsAttention.some((n) => n.path === "fine.md")).toBe(false);
  }, 240_000);
});

/**
 * An Excalidraw drawing is `name.excalidraw.md`, so it merges as prose.
 *
 * The engine picks the `stillValid` predicate by path, and `looksLikeJson` was
 * the whole of that decision: a `.canvas` was checked and a drawing was not,
 * although a drawing's body is a JSON scene in a fenced block that breaks in
 * exactly the same way. `core/excalidraw.ts` has the mechanism and
 * `excalidraw.test.ts` has the corpus: 744 of 4,882 clean merges of an empty
 * drawing two devices both drew on produce a scene the plugin refuses to open,
 * with every other check reporting success.
 *
 * Here is the wiring, end to end, over a real server. Take the
 * `looksLikeExcalidraw` branch out of `engine.ts` and this fails with a merged
 * drawing that will not open, which is the branch the corpus cannot see.
 */
describe("an Excalidraw drawing two devices both drew on", () => {
  /** A drawing as the plugin writes one: the scene tab-indented under a json fence. */
  const drawing = (elements: unknown[]): string =>
    [
      "---",
      "",
      "excalidraw-plugin: parsed",
      "tags: [excalidraw]",
      "",
      "---",
      "# Excalidraw Data",
      "",
      "%%",
      "## Drawing",
      "```json",
      JSON.stringify(
        {
          type: "excalidraw",
          version: 2,
          source: "trew-test",
          elements,
          appState: {},
          files: {},
        },
        null,
        "\t",
      ),
      "```",
      "%%",
      "",
    ].join("\n");

  const shape = (id: string, x: number) => ({
    id,
    type: "rectangle",
    x,
    y: 40,
    width: 180,
    height: 90,
    strokeColor: "#1e1e1e",
    seed: 1,
    version: 2,
    isDeleted: false,
  });

  /** The plugin's own reader: find the scene, parse it, require an elements array. */
  const opens = (text: string): boolean => {
    const found = /\n##? Drawing\n[^`]*```json\n([\s\S]*?)```\n/.exec(text);
    if (found === null) return false;
    const scene = found[1]!;
    try {
      const parsed = JSON.parse(scene.substring(0, scene.lastIndexOf("}") + 1));
      return Array.isArray((parsed as { elements?: unknown }).elements);
    } catch {
      return false;
    }
  };

  it("keeps both drawings rather than merging one that will not open", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const path = "Drawings/Plan.excalidraw.md";
    await a.vault.edit(path, drawing([]));
    await convergeBoth(a, b);
    expect(b.vault.text(path)).toBe(drawing([]));

    // Each device draws its first shape, which is the edit that turns one line
    // into many on both sides.
    await a.vault.edit(path, drawing([shape("from-a", 10)]));
    await a.settle();
    await receiveCommitted(b.transport);
    await b.vault.edit(path, drawing([shape("from-b", 500)]));

    const report = await b.engine.sync();
    expect(report.conflicted, `report: ${JSON.stringify(report)}`).toBe(1);
    expect(report.merged).toBe(0);

    // Rule 10: the property is not that the two devices agree, it is that
    // neither drawing was lost and that everything b now holds opens.
    const all = everywhere(b);
    expect(all).toContain("from-a");
    expect(all).toContain("from-b");
    for (const [name, text] of Object.entries(b.vault.snapshot())) {
      expect(opens(text), `${name} will not open:\n${text}`).toBe(true);
    }
  }, 240_000);
});

/**
 * The one condition in the read-only reconcile that its own tests cannot reach.
 *
 * A device that cannot send is a device whose `remote` map nothing commits to,
 * so the version it answered is always still the version the server has, and
 * every read-only test takes the same branch. Recording a hash from one version
 * against another version's uid would be a lie about what has been dealt with,
 * and the branch that refuses to is only asked about here.
 */
describe("the version a held-back write answered", () => {
  const remote = { uid: 7, hash: "sha-of-seven" };

  it("is the version, when that is still the version", () => {
    expect(answeredVersion(7, remote)).toEqual({ uid: 7, hash: "sha-of-seven" });
  });

  it("is nothing when the write answered no version", () => {
    // A conflict copy is a new path, so there is no server version it replies
    // to, and there is nothing to record as dealt with.
    expect(answeredVersion(undefined, remote)).toBeUndefined();
    expect(answeredVersion(undefined, undefined)).toBeUndefined();
  });

  it("is nothing when the server has moved on since the decision", () => {
    // uid 8 has not been dealt with. Recording 7 as the ancestor with 8's hash
    // would say it had, and the next pass would not merge it.
    expect(answeredVersion(7, { uid: 8, hash: "sha-of-eight" })).toBeUndefined();
  });

  it("is nothing when the path has no server version at all", () => {
    expect(answeredVersion(7, undefined)).toBeUndefined();
  });
});
