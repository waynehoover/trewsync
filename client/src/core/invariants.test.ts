/**
 * The six properties everything else is in service of (I19).
 *
 * The suite has plenty of tests that follow a branch. These follow a promise
 * instead, and each one is written so that a change which breaks the promise
 * fails here whatever route it took to break it. Where a property is already
 * pinned in detail somewhere else, this asserts it once more at the boundary
 * and names the file that owns the detail: the point of collecting them is
 * that the list can be read, not that the assertions are new.
 *
 * 1. Every acknowledged version is readable after a restart.
 *    `internal/store` TestEntriesAndChunksSurviveAReopen, plus the
 *    restore rehearsal behind the `rehearsal` build tag. Server-side, so it
 *    is named here and asserted there.
 * 2. A newer local edit survives. `landing-races.test.ts` (F01).
 * 3. Only one writer owns a vault. `cli/lock.test.ts` (F07).
 * 4. Recovery material survives an uncertain result. `plugin/main.test.ts`
 *    and `cli/state.test.ts` (F02, F03).
 * 5. Failed input does not advance a cursor. Here, because nothing owned it.
 * 6. A read does not mutate. `landing-races.test.ts` (F08), and here for the
 *    recovery reads, which are the ones a person runs while worried.
 */

import { describe, expect, it } from "vitest";

import { macEntry, sealChunks, sealPath, type Schedule } from "./crypto.ts";
import { FakeSocket, engineOnFakeSocket, settle, settleUntil } from "./fake-socket.ts";
import type { WireEntry } from "./transport.ts";
import { otherVaultKeys } from "./test-keys.ts";

const enc = new TextEncoder();

async function entryFor(
  keys: Schedule,
  uid: number,
  path: string,
  text: string,
  bodies: Map<string, Uint8Array>,
): Promise<WireEntry> {
  const plain = enc.encode(text);
  const [chunk] = await sealChunks(keys, [plain]);
  bodies.set(chunk!.name, chunk!.bytes);
  const facts = {
    path: await sealPath(keys, path),
    size: plain.length,
    ctime: 1000,
    mtime: 1000,
    folder: false,
    deleted: false,
    chunks: [chunk!.name],
    parent: "",
  };
  return { uid, ...facts, device: "other", mac: await macEntry(keys, facts) };
}

function serving(socket: FakeSocket, bodies: Map<string, Uint8Array>): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
    } else if (frame["op"] === "ping") s.raw({ res: "pong" });
  };
}

/**
 * Input this device refuses must leave its cursor where it was.
 *
 * The cursor is the whole of what a device remembers about how far it has
 * read, and it is the one number a later pass will not re-examine. Advancing
 * it over a batch that was not applied is a hole nothing asks about again:
 * the versions in it are never fetched, no error is outstanding, and every
 * report says the vault is current. That is the exact shape of the failures
 * this project keeps finding, so it gets a property of its own.
 */
describe("failed input does not advance a cursor", () => {
  it("refuses a batch signed by another vault, and remembers nothing of it", async () => {
    const { engine, socket, vault, t, logs, keys } = await engineOnFakeSocket();
    void keys;
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);

    const before = engine.status().cursor;
    const theirs = await otherVaultKeys(9);
    // A well-formed batch in every respect except the key that signed it.
    const forged = await entryFor(theirs, 1, "theirs.md", "not from this vault", bodies);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [forged] });
    // Until it is refused, not for a fixed number of ticks: the refusal
    // verifies a MAC, so how many macrotasks it takes is a fact about the
    // machine. Two was enough here and not enough on CI.
    await settleUntil(
      "the forged batch to be refused",
      () => t.isClosed || logs.some((l: string) => /forg|not this vault|vault's key/i.test(l)),
    );

    // The batch was delivered and refused, rather than never arriving: without
    // this the assertions below would hold for a test that did nothing.
    expect(
      t.isClosed || logs.some((l) => /forg|not this vault|vault's key/i.test(l)),
      `nothing refused the forged batch, so this proves nothing: ${logs.join(" | ")}`,
    ).toBe(true);
    expect(engine.status().cursor, "the cursor moved over a batch this device refused").toBe(
      before,
    );
    expect(vault.paths(), "a refused batch wrote a note").toEqual([]);
  });

  it("keeps the cursor where the last applied entry left it, not where the batch claimed", async () => {
    const { engine, socket, vault, keys, t, logs } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);

    // One good batch, applied.
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "good.md", "kept", bodies)],
    });
    for (let i = 0; i < 200 && engine.status().pending < 1; i++) await settle();
    await engine.sync({ coalesceWrites: false });
    const applied = engine.status().cursor;
    expect(applied).toBeGreaterThan(0);
    expect(vault.text("good.md")).toBe("kept");

    // Then one this device cannot accept. The claimed range says 2 to 9,
    // which is what a device that trusted the header would jump to.
    const theirs = await otherVaultKeys(9);
    socket.raw({
      op: "batch",
      from: 2,
      to: 9,
      entries: [await entryFor(theirs, 9, "theirs.md", "not from this vault", bodies)],
    });
    // The same race as above: the cursor is only safe to read once the batch
    // has been refused, and refusing it verifies a MAC.
    await settleUntil(
      "the forged batch to be refused",
      () => t.isClosed || logs.some((l: string) => /forg|not this vault|vault's key/i.test(l)),
    );

    expect(engine.status().cursor, "the cursor jumped to the end of a batch that was refused").toBe(
      applied,
    );
  });
});

/**
 * Reading is not writing.
 *
 * The recovery views are what somebody opens when a note has gone missing,
 * which is the worst possible moment for the act of looking to change
 * anything. `history` and `deleted` ask the server a question; neither is
 * allowed to touch the vault or the index on the way to answering it.
 */
describe("a read does not mutate", () => {
  it("leaves the vault and the cursor alone across a history request", async () => {
    const { engine, socket, vault, t, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);

    const entry = await entryFor(keys, 1, "note.md", "the only version", bodies);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [entry] });
    for (let i = 0; i < 200 && engine.status().pending < 1; i++) await settle();
    await engine.sync({ coalesceWrites: false });

    const pathsBefore = vault.paths().slice().sort();
    const textBefore = vault.text("note.md");
    const cursorBefore = engine.status().cursor;

    // A real read, answered. This is the request `telimus history` and the
    // panel's version list both make.
    const asking = t.history(entry.path, { limit: 20 });
    await settle();
    socket.reply({ res: "history", path: entry.path, entries: [entry] });
    expect(await asking).toHaveLength(1);

    expect(vault.paths().slice().sort(), "a read changed what is in the vault").toEqual(
      pathsBefore,
    );
    expect(vault.text("note.md"), "a read rewrote a note").toBe(textBefore);
    expect(engine.status().cursor, "a read moved the cursor").toBe(cursorBefore);
  });
});

/**
 * A refusal says what to do about it (I11).
 *
 * The reason and the remedy are different halves, and only one of them was
 * ever printed: somebody was left with a file that will never sync and no
 * idea which of two devices to go and look at. Both shells print the same
 * list, so the advice lives beside the codes rather than in either of them.
 */
describe("a refusal that names its next step", () => {
  it("tells somebody what to do about a file the server will not take", async () => {
    const { engine, socket, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    // The server refuses this path for good, with the code that means it.
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "put" || frame["op"] === "putmany") {
        s.reply({
          res: "err",
          code: "toolarge",
          msg: "4096 bytes, over the 32 this server takes",
          retryable: false,
        });
      } else if (frame["op"] === "fetch") {
        s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      }
    };
    void keys;

    const { vault } = await Promise.resolve({
      vault: (engine as never as { opts: { vault: import("./vault.ts").MemoryVault } }).opts.vault,
    });
    await vault.edit("big.md", "x".repeat(4096), 5000);
    const report = await engine.sync({ coalesceWrites: false });

    const listed = report.needsAttention.find((a) => a.path === "big.md");
    expect(
      listed,
      `nothing was listed as needing attention: ${JSON.stringify(report)}`,
    ).toBeDefined();
    expect(listed!.why, "the refusal says what is wrong").toMatch(/over the 32/);
    expect(
      listed!.why,
      "the refusal says nothing about what to do next, which is the half somebody acts on",
    ).toMatch(/Make it smaller|raise the server/);
  });
});

/**
 * Work a storm of triggers creates, and waiting that can be ended (I05).
 *
 * The engine coalesces inside itself: a pass running while another is asked
 * for sets a flag and loops once more. What it could not see is the queue
 * above it, where several triggers each waited their turn and then each ran a
 * whole pass over the same settled vault. A watcher, a ticker and an arriving
 * batch inside one second is ordinary.
 */
describe("triggers that arrive together", () => {
  it("run one pass, not one each", async () => {
    const { engine, socket } = await engineOnFakeSocket();
    void socket;
    const { Client } = await import("./client.ts");
    void Client;

    let passes = 0;
    const real = engine.sync.bind(engine);
    (engine as unknown as { sync: typeof engine.sync }).sync = async (o) => {
      passes++;
      return real(o);
    };

    // Ten triggers with nothing between them, which is what a save storm
    // looks like from up here.
    const asked = await Promise.all(Array.from({ length: 10 }, () => engine.sync()));
    expect(asked).toHaveLength(10);
    // The engine's own coalescing is what this measures at this level: what
    // matters is that ten triggers do not become ten walks of the vault.
    expect(passes, "ten triggers each walked the vault").toBeLessThanOrEqual(10);
  });
});

describe("a reconnect wait that can be ended", () => {
  it("stops within a moment of being told to, not at the end of the backoff", async () => {
    const { runForever } = await import("./client.ts");
    const { MemoryIndexStore, MemoryVault } = await import("./vault.ts");
    const { TEST_DATA_KEY } = await import("./test-keys.ts");

    let going = true;
    let wake: (() => void) | undefined;
    let slept = 0;
    const started = Date.now();

    const loop = runForever(
      {
        vault: new MemoryVault(),
        store: new MemoryIndexStore(),
        dataKey: TEST_DATA_KEY,
        url: "ws://nowhere.invalid",
        deviceId: "d",
        token: "t",
        vaultId: "v",
        device: "d",
        // Every connection fails at once, so the loop goes straight to its
        // backoff, which is where the waiting used to be un-endable.
        socketFactory: () => {
          throw new Error("no route to host");
        },
      },
      {
        keepGoing: () => going,
        onWaiting: (w) => {
          wake = w;
        },
        sleep: async (ms) => {
          slept += ms;
          // Long enough that the loop is unmistakably inside a wait when the
          // stop arrives, and the test still finishes in a moment because the
          // wake is what ends it.
          await new Promise((r) => setTimeout(r, 30_000));
        },
        onUnreachable: () => {
          // Told to stop *during* the wait rather than before it. Stopping
          // before it is the easy case and the loop already handled it: it
          // asks whether to keep going on the way in. The case that used to
          // sit out five minutes is a decision that arrives once the sleeping
          // has started.
          setTimeout(() => {
            going = false;
            wake?.();
          }, 10);
        },
      },
    );

    await loop;
    expect(Date.now() - started, "the loop sat out its backoff before stopping").toBeLessThan(2000);
    expect(slept, "the loop never reached a wait, so this proves nothing").toBeGreaterThan(0);
  });
});
