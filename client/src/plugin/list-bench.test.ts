/**
 * What listing the vault costs the plugin, as it grows.
 *
 * Not an assertion, a measurement, and it lives here because the module alias
 * that gives `obsidian` a runtime is the test config's. Skipped unless asked
 * for: `BENCH_LIST=1 bunx vitest run src/plugin/list-bench.test.ts`.
 *
 * It exists because the phase breakdown says listing is about half of a quiet
 * pass on both a laptop and a phone, which was a surprise: the plugin's
 * `list()` reads Obsidian's own index rather than walking a directory, so the
 * cost is per-item CPU and is measurable here without a phone in the room.
 */

import { expect, it } from "vitest";

import { ObsidianVault } from "./vault.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";
import { noteBody, pathFor } from "../../bench-corpus.ts";

const asked = process.env["BENCH_LIST"] === "1";

it.runIf(asked)(
  "reports what list() costs at each size",
  async () => {
    const lines: string[] = [];
    for (const size of (process.env["BENCH_SIZES"] ?? "10000,50000").split(",").map(Number)) {
      const adapter = new FakeAdapter();
      for (let i = 0; i < size; i++) adapter.seed(pathFor(i), noteBody(i));
      const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
      await vault.list();
      await vault.list();
      const times: number[] = [];
      for (let i = 0; i < 9; i++) {
        const at = performance.now();
        const out = await vault.list();
        times.push(performance.now() - at);
        expect(out.length, "the listing lost files").toBeGreaterThanOrEqual(size);
      }
      times.sort((a, b) => a - b);
      const said = `${size} notes: list() p50 ${times[4]!.toFixed(1)} ms`;
      console.log(said);
      lines.push(said);
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env["BENCH_OUT"] ?? "list-bench.txt", lines.join("\n") + "\n");
  },
  600_000,
);
