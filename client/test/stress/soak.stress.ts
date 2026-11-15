/**
 * The soak's short mode, in the stress suite (PLAN.md M5 done-when, "a day of
 * real use on a scratch vault has produced no unexplained conflict copy").
 *
 * The same run as `bun run soak --claude` makes over an hour, compressed
 * into a little over a minute and with the scripted agent in place of
 * `claude -p`, so it costs nothing and needs no credentials: a real trewd with
 * MCP, a laptop in `trew sync --watch`, a phone that is offline between
 * `trew sync` runs, both people editing on a schedule and the agent writing
 * through the tools, then a witness, `verify -deep`, the loss checks and an
 * explanation for every conflict copy (soak.ts). What the long run found is
 * in docs/development.md, "The soak".
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { cleanupBinary, removeTree, serverBinary } from "../core/test-server.ts";
import { cleanupCliBundle, cliBundle, runSoak, SHORT } from "./soak.ts";

beforeAll(async () => {
  await serverBinary();
  await cliBundle();
}, 300_000);
afterAll(async () => {
  await cleanupCliBundle();
  await cleanupBinary();
});

it("a compressed day leaves no unexplained conflict copy, no lost version and one state", async () => {
  const out = await mkdtemp(join(tmpdir(), "trew-soak-report-"));
  try {
    const report = await runSoak({ ...SHORT, sessions: 8, out, log: () => {} });
    // Not a run that tested nothing: people edited, the phone came and went,
    // and the agent committed writes.
    expect(report.deviceEdits.byDevice["laptop"] ?? 0).toBeGreaterThan(10);
    expect(report.deviceEdits.byDevice["phone"] ?? 0).toBeGreaterThan(5);
    expect(report.phoneSyncs).toBeGreaterThan(4);
    expect(report.agentOps.total).toBeGreaterThan(3);
    for (const c of report.copies) expect(c.explained, `${c.copy}: ${c.explanation}`).toBe(true);
    expect(report.witness.differences).toEqual([]);
    expect(report.loss.lost).toEqual([]);
    expect(report.loss.unseenOverwrites).toEqual([]);
    expect(report.loss.missingFromLive).toEqual([]);
    expect(report.verifyDeep).toMatch(/ 0 faults/);
    expect(report.problems).toEqual([]);
  } finally {
    await removeTree(out);
  }
}, 600_000);
