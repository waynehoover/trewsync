/**
 * The crash matrix: a real trewd killed inside an agent's write (PLAN.md M5
 * task 9).
 *
 * The server is the crash build of trewd (cmd/trewd/testseam.go), which holds
 * a write at the seam TREW_TEST_SEAM names and does nothing else differently.
 * Each case is one tool at one seam: a laptop writes the notes, the agent
 * prepares its write, the server is restarted armed at the seam, the write is
 * sent with an idempotency key, and when the server says the write is held
 * there it is killed with SIGKILL, with the agent's request still waiting for
 * its reply. Then it is started again on the same directory, unarmed, and:
 *
 *   - `verify -deep` passes: every entry's every body is present and matches
 *     its name, so nothing dangles;
 *   - the version is all there or not there at all, and which is exactly the
 *     seam's: absent before the commit, present after it;
 *   - the log holds one operation for the key or none, as the entries do,
 *     and it names the uids the vault's heads are;
 *   - a freshly paired headless client downloads exactly the notes that
 *     outcome leaves, byte for byte;
 *   - the agent's retry with the same key is one discoverable result: the
 *     recorded reply if it committed, a commit if it did not, the same bytes
 *     on every retry after that, never a second operation, and
 *     lookup_operation finds it by the opId the retry names;
 *   - the laptop, connected when the server died, and a second fresh client
 *     then hold exactly the notes the write leaves.
 *
 * The seams are internal/mcp's: `uploading`, with some of a write's bodies
 * durable and the rest not written (only for a write of several); `bodies`,
 * every body durable and nothing committed; `committed`, inside the commit
 * lock with nothing broadcast; `broadcast`, after it and before the reply.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Client } from "../core/client.ts";
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import {
  applyPlan,
  audit,
  cleanupCrashBinary,
  crashBinary,
  heldAt,
  mint,
  notesIn,
  verifiedDeep,
  writeNotes,
  type Agent,
} from "./agent.ts";
import { device, reopen, settle, tidy } from "./harness.ts";

let crash: string;
beforeAll(async () => {
  await serverBinary();
  crash = await crashBinary();
}, 300_000);
afterAll(async () => {
  await cleanupCrashBinary();
  await cleanupBinary();
});

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];
afterEach(async () => await tidy(open, dirs, server));

type Notes = Record<string, string>;

/** One tool's write, as the matrix makes it. */
interface Write {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** The notes once it has committed. */
  readonly after: Notes;
}

interface Case {
  readonly name: string;
  readonly seed: Notes;
  /** The seams it is killed at; `uploading` only where it stores several bodies. */
  readonly seams: readonly string[];
  /** Prepares the write from the agent's own reads and previews. */
  prepare(agent: Agent, seed: Notes): Promise<Write>;
}

const AROUND_THE_COMMIT = ["bodies", "committed", "broadcast"] as const;
const EVERY_SEAM = ["uploading", ...AROUND_THE_COMMIT] as const;

/** 300 KiB of distinct lines: a note of many chunks, so its upload has a middle. */
const LARGE = Array.from(
  { length: 6000 },
  (_, i) => `line ${i} of the large note, ${(i * 2654435761) % 1000003}\n`,
).join("");

const CASES: Case[] = [
  {
    name: "create_note into a new folder",
    seed: { "existing.md": "an existing note\n" },
    seams: AROUND_THE_COMMIT,
    async prepare(agent, seed) {
      const { epoch } = await agent.read("existing.md");
      return {
        tool: "create_note",
        args: { path: "new/plan.md", content: "CRASH CREATE\n", epoch, idempotencyKey: "k-create" },
        after: { ...seed, "new/plan.md": "CRASH CREATE\n" },
      };
    },
  },
  {
    name: "create_note of a note of many chunks",
    seed: { "existing.md": "an existing note\n" },
    seams: ["uploading"],
    async prepare(agent, seed) {
      const { epoch } = await agent.read("existing.md");
      return {
        tool: "create_note",
        args: { path: "large.md", content: LARGE, epoch, idempotencyKey: "k-large" },
        after: { ...seed, "large.md": LARGE },
      };
    },
  },
  {
    name: "edit_note",
    seed: { "note.md": "first line\nsecond line\n" },
    seams: AROUND_THE_COMMIT,
    async prepare(agent, seed) {
      const { uid, epoch } = await agent.read("note.md");
      return {
        tool: "edit_note",
        args: {
          path: "note.md",
          base: uid,
          epoch,
          edits: [{ old: "first line", new: "CRASH EDIT" }],
          idempotencyKey: "k-edit",
        },
        after: { ...seed, "note.md": "CRASH EDIT\nsecond line\n" },
      };
    },
  },
  {
    name: "append_note",
    seed: { "log.md": "start\n" },
    seams: AROUND_THE_COMMIT,
    async prepare(agent, seed) {
      const { uid, epoch } = await agent.read("log.md");
      return {
        tool: "append_note",
        args: {
          path: "log.md",
          base: uid,
          epoch,
          text: "CRASH APPEND\n",
          idempotencyKey: "k-append",
        },
        after: { ...seed, "log.md": "start\nCRASH APPEND\n" },
      };
    },
  },
  {
    name: "move_note with two backlinks, into a new folder",
    seed: {
      "topic.md": "# Topic\n",
      "one.md": "see [[topic]]\n",
      "two.md": "also [the topic](topic.md)\n",
    },
    seams: EVERY_SEAM,
    async prepare(agent, seed) {
      const { uid, epoch } = await agent.read("topic.md");
      const { apply, changes } = await agent.preview("move_note", {
        path: "topic.md",
        base: uid,
        to: "archive/subject.md",
        epoch,
        idempotencyKey: "k-move",
      });
      const after = applyPlan(seed, changes);
      // The plan is what the test expects of a move: the note at its new
      // path, and both backlinks pointing there.
      expect(after).toEqual({
        "archive/subject.md": "# Topic\n",
        "one.md": "see [[archive/subject]]\n",
        "two.md": "also [the topic](archive/subject.md)\n",
      });
      return { tool: "move_note", args: apply, after };
    },
  },
  {
    name: "add_tags over three notes",
    seed: { "a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n" },
    seams: EVERY_SEAM,
    async prepare(agent, seed) {
      const { apply, changes } = await agent.preview("add_tags", {
        paths: ["a.md", "b.md", "c.md"],
        tags: ["crash"],
        idempotencyKey: "k-tags",
      });
      const after = applyPlan(seed, changes);
      for (const [path, body] of Object.entries(seed)) {
        expect(after[path]).toBe(`---\ntags: ["crash"]\n---\n${body}`);
      }
      return { tool: "add_tags", args: apply, after };
    },
  },
];

describe("a real trewd killed inside an agent's write", () => {
  it.each(CASES.flatMap((c) => c.seams.map((seam) => ({ c, seam, name: c.name }))))(
    "$name, killed at $seam, is all there or not there, and one result on retry",
    async ({ c, seam }) => {
      server = new TestServer();
      server.binary = crash;
      server.extraArgs = ["-mcp"];
      await server.start();
      const port = server.port;
      const agent = await mint(server, "Claude on Mac", dirs);
      const laptop = await device(server, "laptop", dirs, open);
      await writeNotes(laptop.dir, c.seed);
      await settle([laptop]);
      expect(await notesIn(laptop.dir)).toEqual(c.seed);
      await laptop.c.close();

      // Armed at the seam. The laptop is connected while the write is held
      // and the server dies under it.
      await server.stop();
      server.env = { TREW_TEST_SEAM: seam };
      await server.start(port);
      const connected = await reopen(server, "laptop", laptop.dir, open);
      await settle([connected], 1);
      const write = await c.prepare(agent, c.seed);
      const sent = agent.call(write.tool, write.args).then(
        (reply) => ({ reply }),
        (error: unknown) => ({ error }),
      );
      await heldAt(server, seam);
      await server.kill();
      const lost = await sent;
      expect("error" in lost, "a server killed before its reply replied").toBe(true);
      await connected.c.close();

      server.env = {};
      await server.start(port);
      const committed = seam === "committed" || seam === "broadcast";
      const key = write.args["idempotencyKey"] as string;

      // All there with every body, or not there; nothing dangles.
      await verifiedDeep(server);
      const ops = await audit(server);
      const keyed = ops.filter((o) => o.idempotencyKey === key);
      expect(ops).toHaveLength(keyed.length);
      expect(keyed).toHaveLength(committed ? 1 : 0);
      const witness = await device(server, "witness", dirs, open);
      await settle([witness], 2);
      expect(await notesIn(witness.dir)).toEqual(committed ? write.after : c.seed);
      // The log names the versions the vault holds.
      for (const p of keyed[0]?.paths ?? []) {
        if (p.role !== "write") continue;
        const history = await agent.ok("note_history", { path: p.path, limit: 1 });
        const versions = history.untrusted["versions"] as { uid: number }[];
        expect(versions[0]?.uid, p.path).toBe(p.afterUid);
      }

      // The unknown outcome, resolved by the key: one result, the same bytes
      // every time it is asked, and one operation.
      const first = await agent.ok(write.tool, write.args);
      const again = await agent.ok(write.tool, write.args);
      expect(again.raw).toBe(first.raw);
      expect(first.trusted["committed"]).toBe(true);
      const opId = first.trusted["opId"] as string;
      if (committed) expect(opId).toBe(keyed[0]!.id);
      const after = await audit(server);
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(opId);
      expect(after[0]!.idempotencyKey).toBe(key);
      const entries = first.untrusted["entries"] as { path: string; uid: number }[];
      expect(entries.map((e) => [e.path, e.uid]).sort()).toEqual(
        after[0]!.paths
          .filter((p) => p.role === "write")
          .map((p) => [p.path, p.afterUid])
          .sort(),
      );
      const look = await agent.ok("lookup_operation", { opId });
      expect(look.trusted).toMatchObject({
        found: true,
        outcome: "committed",
        idempotencyKey: key,
      });

      // Every device holds exactly what the write leaves: the witness, the
      // laptop that was connected when the server died, and a new one.
      await settle([witness], 2);
      const back = await reopen(server, "laptop", laptop.dir, open);
      const fresh = await device(server, "fresh", dirs, open);
      await settle([back, fresh], 2);
      for (const d of [witness, back, fresh]) expect(await notesIn(d.dir)).toEqual(write.after);
      await verifiedDeep(server);
    },
  );
});
