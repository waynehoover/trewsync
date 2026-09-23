import { afterEach, expect, it } from "vitest";
import { readFile, writeFile, rename, rm, utimes, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "../core/client.ts";
import { TestServer } from "../core/test-server.ts";
import { ProtocolError } from "../core/transport.ts";
import { deferred, within, receiveCommitted } from "../core/test-async.ts";
import { device, reopen, fingerprint, differences, settle, tidy, type Device } from "./harness.ts";
let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];
afterEach(async () => tidy(open, dirs, server));
async function setup(
  count: number,
  initial = "Original first line.\nOriginal second line.\nOriginal third line.\n",
) {
  server = new TestServer();
  await server.start();
  const a = await device(server, "a", dirs, open);
  await writeFile(join(a.dir, "note.md"), initial);
  await settle([a]);
  const all = [a];
  for (let i = 1; i < count; i++) {
    const d = await device(server, String.fromCharCode(97 + i), dirs, open);
    await settle([d]);
    all.push(d);
  }
  return all;
}
async function assertCopies(all: Device[], markers: string[]) {
  for (const d of all) {
    const contents = await Promise.all(
      [...(await fingerprint(d.dir)).keys()].map((p) => readFile(join(d.dir, p), "utf8")),
    );
    for (const marker of markers)
      expect(contents.join("\n"), `missing ${marker}`).toContain(marker);
    expect(differences(await fingerprint(all[0]!.dir), await fingerprint(d.dir))).toEqual([]);
  }
}

it("continuous competing writes yield a waiting report instead of hanging", async () => {
  const [a] = await setup(1);
  await writeFile(join(a!.dir, "note.md"), "still being edited\n");
  let attempts = 0;
  a!.c.transport.putMany = async (entries) => {
    attempts++;
    return {
      results: entries.map(() => ({
        uid: 0,
        error: new ProtocolError("stale", "competing write"),
      })),
      uploaded: 0,
      bytes: 0,
    };
  };
  const report = await within(a!.c.engine.sync(), "a bounded reconciliation call");
  // It gives up before the round cap, rather than running it out (R083-01).
  // A stale refusal now means "ask the server what it holds and decide again",
  // which is what breaks the case where the head this device is missing is its
  // own; a peer that keeps winning is a different thing, and after a few tries
  // running the eight rounds out changes nothing except how hard this device
  // works. So it becomes an ordinary backed-off retry that says why.
  expect(attempts).toBeGreaterThan(1);
  expect(attempts).toBeLessThan(8);
  // Retrying, not waiting, and the difference is the point of stopping (rule
  // 7). "Waiting" is a path the next round of this sync will look at again;
  // once this device has asked the server and been refused anyway, the next
  // look is a scheduled one, and saying "waiting" about it would be a panel
  // that never stops saying something is about to happen.
  expect(report.retrying).toBeGreaterThan(0);
  expect(report.appliedCursor).toBeUndefined();
  expect(report.nextUploadAt).toBeDefined();
  // And the retry is not scheduled for now, which is the loop it replaces.
  expect(report.nextUploadAt!).toBeGreaterThan(Date.now());
});

it("five offline writers preserve disjoint edits after the first writer exits", async () => {
  const initial = Array.from({ length: 5 }, (_, i) => `Original line ${i}.`);
  const all = await setup(5, initial.join("\n") + "\n");
  const markers = initial.map((_, i) => `INDEPENDENT EDIT ${i}`);
  await Promise.all(
    all.map(async (d, i) => {
      const lines = [...initial];
      lines[i] = markers[i]!;
      await writeFile(join(d.dir, "note.md"), lines.join("\n") + "\n");
    }),
  );
  await all[0]!.c.settle();
  all[0]!.c.close();
  const remaining = all.slice(1);
  await Promise.all(remaining.map((d) => d.c.settle({}, 16)));
  await settle(remaining, 12);
  const reader = await device(server, "fresh-reader", dirs, open);
  await settle([reader]);
  await assertCopies([...remaining, reader], markers);
  for (const d of [...remaining, reader]) expect((await fingerprint(d.dir)).size).toBe(1);
});
it("three simultaneous conflicting writers and a fresh reader keep all three edits", async () => {
  const all = await setup(3);
  const markers = ["ALPHA NEW DRAFT", "BRAVO DIFFERENT REWRITE", "CHARLIE ANOTHER REVISION"];
  await Promise.all(
    all.map((d, i) =>
      writeFile(
        join(d.dir, "note.md"),
        markers[i] + "\nOriginal second line.\nOriginal third line.\n",
      ),
    ),
  );
  await Promise.all(all.map((d) => d.c.settle({}, 16)));
  await settle(all, 12);
  const reader = await device(server, "reader", dirs, open);
  await settle([reader]);
  all.push(reader);
  await assertCopies(all, markers);
});
it.each(["\n", "\r\n"])(
  "merging a UTF-8 BOM note with %j line endings avoids false copies",
  async (eol) => {
    const note = (text: string) => text.replaceAll("\n", eol);
    const all = await setup(
      2,
      note("\uFEFFOriginal first line.\nOriginal second line.\nOriginal third line.\n"),
    );
    await writeFile(
      join(all[0]!.dir, "note.md"),
      note("\uFEFFALPHA FIRST\nOriginal second line.\nOriginal third line.\n"),
    );
    await writeFile(
      join(all[1]!.dir, "note.md"),
      note("\uFEFFOriginal first line.\nBRAVO SECOND\nOriginal third line.\n"),
    );
    await settle(all, 8);
    await assertCopies(all, ["ALPHA FIRST", "BRAVO SECOND"]);
    for (const d of all) expect([...(await fingerprint(d.dir)).keys()]).toEqual(["note.md"]);
    for (const d of all)
      expect(await readFile(join(d.dir, "note.md"), "utf8")).toBe(
        note("\uFEFFALPHA FIRST\nBRAVO SECOND\nOriginal third line.\n"),
      );
  },
);
it("an equal-length replacement retaining mtime is not falsely reported synced", async () => {
  const [a, b] = await setup(2);
  const path = join(a!.dir, "note.md");
  await writeFile(path, "BEFORE\n");
  await utimes(path, 1600000000, 1600000000);
  await settle([a!, b!]);
  await writeFile(path, "AFTERS\n");
  await utimes(path, 1600000000, 1600000000);
  await settle([a!, b!]);
  expect(await readFile(join(b!.dir, "note.md"), "utf8")).toBe("AFTERS\n");
});
it("three disjoint edits made offline converge without conflict copies", async () => {
  let all = await setup(3);
  all.forEach((d) => d.c.close());
  const markers = ["ALPHA FIRST", "BRAVO SECOND", "CHARLIE THIRD"];
  for (let i = 0; i < all.length; i++) {
    const lines = ["Original first line.", "Original second line.", "Original third line."];
    lines[i] = markers[i]!;
    await writeFile(join(all[i]!.dir, "note.md"), lines.join("\n") + "\n");
  }
  all = await Promise.all(
    all.map((d, i) => reopen(server, String.fromCharCode(97 + i), d.dir, open)),
  );
  await Promise.all(all.map((d) => d.c.settle({}, 16)));
  await settle(all, 12);
  await assertCopies(all, markers);
  for (const d of all) expect((await fingerprint(d.dir)).size).toBe(1);
});
it("offline edit survives a concurrent rename and deletion on two other clients", async () => {
  const all = await setup(3);
  await rename(join(all[0]!.dir, "note.md"), join(all[0]!.dir, "moved.md"));
  await rm(join(all[1]!.dir, "note.md"));
  await writeFile(join(all[2]!.dir, "note.md"), "CHARLIE EDIT MUST SURVIVE\n");
  await Promise.all(all.map((d) => d.c.settle({}, 16)));
  await settle(all, 12);
  await assertCopies(all, ["CHARLIE EDIT MUST SURVIVE"]);
});
it("a rename does not retire an edit its source received meanwhile", async () => {
  const [a, b] = await setup(2);
  await rename(join(a!.dir, "note.md"), join(a!.dir, "moved.md"));
  await a!.c.noteRename("note.md", "moved.md");
  await writeFile(join(b!.dir, "note.md"), "BRAVO NEW SOURCE EDIT\n");
  await b!.c.settle();
  await receiveCommitted(a!.c.transport);
  await settle([a!, b!], 8);
  await assertCopies([a!, b!], ["BRAVO NEW SOURCE EDIT", "Original first line."]);
  for (const d of [a!, b!]) {
    expect(await readFile(join(d.dir, "note.md"), "utf8")).toContain("BRAVO NEW SOURCE EDIT");
    expect(await readFile(join(d.dir, "moved.md"), "utf8")).toContain("Original first line.");
  }
});
it("purge preserves a moved note and permits reusing its old name after restart", async () => {
  const [a] = await setup(1, "original content\n");
  await rename(join(a!.dir, "note.md"), join(a!.dir, "moved.md"));
  await a!.c.noteRename("note.md", "moved.md");
  await settle([a!]);
  await writeFile(join(a!.dir, "moved.md"), "current content at the new name\n");
  await settle([a!]);
  const before = await device(server, "before-purge", dirs, open);
  await settle([before]);
  expect([...(await fingerprint(before.dir)).keys()]).toEqual(["moved.md"]);
  await Promise.all(open.map((client) => client.close()));
  const backup = await mkdtemp(join(tmpdir(), "trew-purge-preservation-"));
  dirs.push(backup);
  await server.whileStopped(async () => {
    await server.cli("backup", "-to", join(backup, "snapshot"));
    await server.cli("purge", "-confirm", "default", "-backup", join(backup, "snapshot"));
  });
  const resumed = await reopen(server, "a", a!.dir, open);
  const fresh = await device(server, "after-purge", dirs, open);
  await settle([resumed, fresh]);
  for (const d of [resumed, fresh]) {
    expect([...(await fingerprint(d.dir)).keys()]).toEqual(["moved.md"]);
    expect(await readFile(join(d.dir, "moved.md"), "utf8")).toBe(
      "current content at the new name\n",
    );
  }
  await writeFile(join(resumed.dir, "note.md"), "a new note using the old name\n");
  await settle([resumed, fresh]);
  for (const d of [resumed, fresh]) {
    expect(await readFile(join(d.dir, "note.md"), "utf8")).toBe("a new note using the old name\n");
    expect(await readFile(join(d.dir, "moved.md"), "utf8")).toBe(
      "current content at the new name\n",
    );
  }
});
it("deterministic three stale uploads preserve every independent edit", async () => {
  const all = await setup(3);
  const markers = ["ALPHA FIRST", "BRAVO SECOND", "CHARLIE THIRD"];
  const entered = all.map(() => deferred<void>());
  const release = all.map(() => deferred<void>());
  const acknowledged = all.map(() => deferred<void>());
  const finish = all.map(() => deferred<void>());
  for (let i = 0; i < all.length; i++) {
    const d = all[i]!;
    const lines = ["Original first line.", "Original second line.", "Original third line."];
    lines[i] = markers[i]!;
    await writeFile(join(d.dir, "note.md"), lines.join("\n") + "\n");
    const original = d.c.transport.putMany.bind(d.c.transport);
    let first = true;
    d.c.transport.putMany = async (...args) => {
      if (!first) return original(...args);
      first = false;
      entered[i]!.resolve();
      await release[i]!.promise;
      const result = await original(...args);
      acknowledged[i]!.resolve();
      await finish[i]!.promise;
      return result;
    };
  }
  const passes = all.map((d) => d.c.settle({}, 0));
  const complete = Promise.all(passes);
  // Observe failures immediately, even while the ordering gates are closed.
  void complete.catch(() => undefined);
  try {
    await within(Promise.all(entered.map((d) => d.promise)), "three writes were prepared");
    release[1]!.resolve();
    await within(acknowledged[1]!.promise, "B's first acknowledgement");
    finish[1]!.resolve();
    await within(passes[1]!, "B recorded its acknowledgement");
    for (const i of [2, 0]) {
      release[i]!.resolve();
      await within(acknowledged[i]!.promise, `writer ${i}'s first acknowledgement`);
    }
    // All initial writes are complete on the wire; C and A have not recorded
    // their acknowledgements yet. Make their queued fan-out observable first.
    await within(
      Promise.all([0, 2].map((i) => receiveCommitted(all[i]!.c.transport))),
      "initial fan-out reached A and C",
    );
  } finally {
    release.forEach((d) => d.resolve());
    finish.forEach((d) => d.resolve());
    await within(Promise.allSettled(passes), "initial passes finished");
  }
  await complete;
  await settle(all, 12);
  // Delivery and byte-for-byte convergence alone miss this defect. History
  // still contains the edit that disappeared from all current working copies.
  for (const d of all) {
    expect(d.c.deliveryReady).toBe(true);
    expect(differences(await fingerprint(all[0]!.dir), await fingerprint(d.dir))).toEqual([]);
  }
  const history = await all[0]!.c.history("note.md", { limit: 100 });
  const historical = await Promise.all(
    history.map(async (v) => new TextDecoder().decode(await all[0]!.c.contentAt(v))),
  );
  expect(historical.join("\n")).toContain("BRAVO SECOND");
  await assertCopies(all, markers);
});
