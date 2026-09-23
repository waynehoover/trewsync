/**
 * The Windows naming rule, checked against the `windows` section of
 * `protocol-fixtures.json`, which `scripts/protocol-vectors.py` writes from
 * Microsoft's rules rather than from this implementation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WINDOWS_RESERVED_NAMES, describeWindowsRefusal, windowsRefusal } from "./windows-names.ts";

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol-fixtures.json"), "utf8"),
) as {
  windows: { reserved: string[]; cases: { name: string; path: string; reason: string | null }[] };
};

describe("names Windows cannot hold", () => {
  it("reserves exactly the names the reference reserves", () => {
    expect([...WINDOWS_RESERVED_NAMES]).toEqual(fixtures.windows.reserved);
  });

  it("gives every case the reference's verdict and reason", () => {
    expect(fixtures.windows.cases.length).toBeGreaterThan(15);
    for (const c of fixtures.windows.cases) {
      expect(windowsRefusal(c.path), c.name).toBe(c.reason ?? undefined);
    }
  });

  it("explains every reason in words a person can act on", () => {
    for (const reason of ["character", "trailing", "reserved"] as const) {
      expect(describeWindowsRefusal(reason).length).toBeGreaterThan(20);
    }
  });

  it("catches a corrupted vector", () => {
    const c = fixtures.windows.cases.find((x) => x.reason === null)!;
    expect(windowsRefusal(c.path)).not.toBe("reserved");
  });
});
