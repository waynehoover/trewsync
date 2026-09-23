/**
 * Phone races: an agent writing through the server's MCP tools while a phone
 * edits the same note offline (PLAN.md M5 task 12, section 4.6).
 *
 * Ported from Basalt's `mcp.stress.ts` (basalt:client/src/stress/
 * mcp.stress.ts:380-507), whose TypeScript agent ran inside a device; here
 * the agent is a real trewd's HTTP tools, and the devices are two headless
 * clients, a laptop that stays connected and a phone that goes offline. To
 * the phone an agent's edit is an ordinary remote version, so the engine
 * merges it or keeps both exactly as it does a second laptop's; there is no
 * new machinery, and these hold that.
 *
 * What is asserted is retained bytes (rule 10), on a freshly paired third
 * device as well as on both of the others: no committed content lost; two
 * edits of the same text kept as both versions, the phone's where it was and
 * the agent's in a conflict copy; a merge only where the engine merges, which
 * is edits that do not touch; and an agent's edit either applied or refused
 * as stale with the note untouched, never written over what it did not read.
 * Every agent write's displaced version reads back as its exact former bytes,
 * before and after a default purge.
 */

import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Client } from "../core/client.ts";
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import { audit, mint, notesIn, writeNotes, type Agent } from "./agent.ts";
import { device, reopen, settle, tidy, type Device } from "./harness.ts";

beforeAll(async () => {
  await serverBinary();
}, 300_000);
afterAll(async () => await cleanupBinary());

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];
afterEach(async () => await tidy(open, dirs, server));

const BASELINE = "PREEXISTING BRANCH\nOriginal first line.\nOriginal second line.\nClosing line.\n";

/** A conflict copy of note.md, named after the device that kept it. */
const COPY = /^note \(Conflicted copy phone \d{12}\)\.md$/;

interface Race {
  readonly agent: Agent;
  readonly laptop: Device;
  /** The phone's directory; it is offline when the race starts. */
  readonly phoneDir: string;
  /** Reconnects the phone and syncs every device until nothing changes. */
  converge(): Promise<Device>;
}

/**
 * A vault with note.md at BASELINE on a laptop and a phone, and the phone
 * gone offline. The agent's token is labelled as Claude Code's would be.
 */
async function race(): Promise<Race> {
  server = new TestServer();
  server.extraArgs = ["-mcp"];
  await server.start();
  const agent = await mint(server, "Claude on Mac", dirs);
  const laptop = await device(server, "laptop", dirs, open);
  await writeNotes(laptop.dir, { "note.md": BASELINE });
  await settle([laptop]);
  const phone = await device(server, "phone", dirs, open);
  await settle([phone]);
  expect(await notesIn(phone.dir)).toEqual({ "note.md": BASELINE });
  await phone.c.close();
  return {
    agent,
    laptop,
    phoneDir: phone.dir,
    async converge() {
      const back = await reopen(server, "phone", phone.dir, open);
      await settle([back, laptop], 6);
      return back;
    },
  };
}

/**
 * The notes every device holds, the laptop, the phone and a freshly paired
 * third, which must be the same notes and exactly `want`. A path matching
 * COPY stands for the one conflict copy, whose name has a timestamp in it.
 * And the server's log holds the agent's one write, and no other: a refusal
 * records nothing.
 */
async function everyDeviceHolds(
  r: Race,
  phone: Device,
  want: Record<string, string>,
): Promise<void> {
  const fresh = await device(server, "witness", dirs, open);
  await settle([fresh], 2);
  for (const d of [r.laptop, phone, fresh]) {
    const got = await notesIn(d.dir);
    const named: Record<string, string> = {};
    for (const [path, text] of Object.entries(got)) named[COPY.test(path) ? "COPY" : path] = text;
    expect(named, d.dir).toEqual(want);
  }
  expect((await audit(server)).map((o) => o.outcome)).toEqual(["committed"]);
}

/**
 * An agent write's displaced version, read back by uid as its exact former
 * bytes, then again after a default purge (PLAN.md section 7), which runs
 * with the server stopped.
 */
async function beforeImage(agent: Agent, path: string, uid: number, former: string): Promise<void> {
  const read = async (): Promise<string> =>
    (await agent.ok("read_note", { path, uid, maxLines: 1000 })).untrusted["content"] as string;
  expect(await read()).toBe(former);
  await server.whileStopped(async () => {
    await server.cli("purge", "-confirm", "default", "-no-backup-check");
  });
  expect(await read()).toBe(former);
}

/** The rows an agent's committed write names: each path, its uid and the one it displaced. */
function wrote(reply: { trusted: Record<string, unknown>; untrusted: Record<string, unknown> }) {
  expect(reply.trusted["committed"]).toBe(true);
  const entries = reply.untrusted["entries"] as {
    path: string;
    uid: number;
    previousUid: number | null;
  }[];
  return entries;
}

async function agentEdit(agent: Agent, old: string, replacement: string) {
  const read = await agent.read("note.md");
  expect(read.content).toBe(BASELINE);
  const reply = await agent.ok("edit_note", {
    path: "note.md",
    base: read.uid,
    epoch: read.epoch,
    edits: [{ old, new: replacement }],
  });
  const [row] = wrote(reply);
  expect(row!.previousUid).toBe(read.uid);
  return row!;
}

async function phoneWrites(r: Race, text: string): Promise<void> {
  await writeFile(join(r.phoneDir, "note.md"), text);
}

describe("an agent and an offline phone, the same note", () => {
  it("disjoint edits merge into one note holding both", async () => {
    const r = await race();
    const row = await agentEdit(r.agent, "Original first line.", "AGENT COMMIT");
    await phoneWrites(r, BASELINE.replace("Original second line.", "PHONE BRANCH"));
    const phone = await r.converge();
    await everyDeviceHolds(r, phone, {
      "note.md": "PREEXISTING BRANCH\nAGENT COMMIT\nPHONE BRANCH\nClosing line.\n",
    });
    await beforeImage(r.agent, "note.md", row.previousUid!, BASELINE);
  });

  it("overlapping edits keep both versions, the phone's in place and the agent's in a copy", async () => {
    const r = await race();
    const row = await agentEdit(r.agent, "Original first line.", "AGENT COMMIT");
    const phones = BASELINE.replace("Original first line.", "PHONE BRANCH");
    await phoneWrites(r, phones);
    const phone = await r.converge();
    await everyDeviceHolds(r, phone, {
      "note.md": phones,
      COPY: BASELINE.replace("Original first line.", "AGENT COMMIT"),
    });
    await beforeImage(r.agent, "note.md", row.previousUid!, BASELINE);
  });

  it("an append and a replacement elsewhere in the note merge", async () => {
    const r = await race();
    const read = await r.agent.read("note.md");
    const [row] = wrote(
      await r.agent.ok("append_note", {
        path: "note.md",
        base: read.uid,
        epoch: read.epoch,
        text: "AGENT APPEND\n",
      }),
    );
    await phoneWrites(r, BASELINE.replace("Original second line.", "PHONE BRANCH"));
    const phone = await r.converge();
    await everyDeviceHolds(r, phone, {
      "note.md":
        "PREEXISTING BRANCH\nOriginal first line.\nPHONE BRANCH\nClosing line.\nAGENT APPEND\n",
    });
    await beforeImage(r.agent, "note.md", row!.previousUid!, BASELINE);
  });

  it("the phone's deletion does not take the agent's edit with it", async () => {
    const r = await race();
    const row = await agentEdit(r.agent, "Original first line.", "AGENT COMMIT");
    await rm(join(r.phoneDir, "note.md"));
    const phone = await r.converge();
    await everyDeviceHolds(r, phone, {
      "note.md": BASELINE.replace("Original first line.", "AGENT COMMIT"),
    });
    await beforeImage(r.agent, "note.md", row.previousUid!, BASELINE);
  });

  it("the agent's deletion does not take the phone's edit with it", async () => {
    const r = await race();
    const read = await r.agent.read("note.md");
    const { apply } = await r.agent.preview("delete_note", {
      path: "note.md",
      base: read.uid,
      epoch: read.epoch,
    });
    const [row] = wrote(await r.agent.ok("delete_note", apply));
    expect(row).toMatchObject({ path: "note.md", kind: "deletion", previousUid: read.uid });
    const phones = BASELINE.replace("Original second line.", "PHONE BRANCH");
    await phoneWrites(r, phones);
    const phone = await r.converge();
    await everyDeviceHolds(r, phone, { "note.md": phones });
    await beforeImage(r.agent, "note.md", read.uid, BASELINE);
  });

  it("the phone's rename keeps its edit at the new name and the agent's at the old", async () => {
    const r = await race();
    const row = await agentEdit(r.agent, "Original first line.", "AGENT COMMIT");
    const phones = BASELINE.replace("Original second line.", "PHONE BRANCH");
    await rename(join(r.phoneDir, "note.md"), join(r.phoneDir, "moved.md"));
    await writeFile(join(r.phoneDir, "moved.md"), phones);
    const phone = await r.converge();
    await everyDeviceHolds(r, phone, {
      "moved.md": phones,
      "note.md": BASELINE.replace("Original first line.", "AGENT COMMIT"),
    });
    await beforeImage(r.agent, "note.md", row.previousUid!, BASELINE);
  });

  it("a phone offline through the agent's append catches up with both", async () => {
    const r = await race();
    const read = await r.agent.read("note.md");
    const [row] = wrote(
      await r.agent.ok("append_note", {
        path: "note.md",
        base: read.uid,
        epoch: read.epoch,
        text: "ACKNOWLEDGED MCP APPEND\n",
      }),
    );
    // Delivered to the device that is connected, while the phone is away.
    await settle([r.laptop], 2);
    expect(await notesIn(r.laptop.dir)).toEqual({
      "note.md": `${BASELINE}ACKNOWLEDGED MCP APPEND\n`,
    });
    await phoneWrites(r, BASELINE.replace("Original second line.", "OFFLINE PHONE EDIT"));
    const phone = await r.converge();
    await everyDeviceHolds(r, phone, {
      "note.md":
        "PREEXISTING BRANCH\nOriginal first line.\nOFFLINE PHONE EDIT\nClosing line.\nACKNOWLEDGED MCP APPEND\n",
    });
    await beforeImage(r.agent, "note.md", row!.previousUid!, BASELINE);
  });

  it("an agent edit prepared before the phone's is refused as stale, and applied once read again", async () => {
    const r = await race();
    const read = await r.agent.read("note.md");
    const phones = BASELINE.replace("Original first line.", "PHONE BRANCH");
    await phoneWrites(r, phones);
    const phone = await r.converge();
    const edit = {
      path: "note.md",
      base: read.uid,
      epoch: read.epoch,
      edits: [{ old: "Original second line.", new: "AGENT COMMIT" }],
    };
    const stale = await r.agent.call("edit_note", edit);
    expect(stale.isError).toBe(true);
    expect(stale.trusted).toMatchObject({ committed: false, error: { code: "stale" } });
    const current = await r.agent.read("note.md");
    expect(current.content).toBe(phones);
    expect((stale.trusted["error"] as { currentUid: number }).currentUid).toBe(current.uid);
    const [row] = wrote(await r.agent.ok("edit_note", { ...edit, base: current.uid }));
    await settle([phone, r.laptop], 3);
    await everyDeviceHolds(r, phone, {
      "note.md": phones.replace("Original second line.", "AGENT COMMIT"),
    });
    await beforeImage(r.agent, "note.md", row!.previousUid!, phones);
  });
});
