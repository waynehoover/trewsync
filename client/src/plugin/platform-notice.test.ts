/**
 * The standing notice for Windows and iOS (PLAN.md section 4.12), as text.
 * Where it is drawn is in main.test.ts, "on a platform the tests do not reach".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SUPPORT_TABLE, platformStanding } from "./platform-notice.ts";

describe("the platform notice", () => {
  it("calls Windows unsupported and iOS untested, and says nothing elsewhere", () => {
    expect(platformStanding({ isWin: true, isIosApp: false })?.title).toBe(
      "Windows is not supported",
    );
    expect(platformStanding({ isWin: false, isIosApp: true })?.title).toBe("iOS is untested");
    expect(platformStanding({ isWin: false, isIosApp: false })).toBeUndefined();
  });

  it("names what is untested, rather than only that something is", () => {
    for (const flags of [
      { isWin: true, isIosApp: false },
      { isWin: false, isIosApp: true },
    ]) {
      expect(platformStanding(flags)!.detail).toMatch(/Untested: [^.]+, [^.]+/);
    }
  });

  it("links a support table the README has", () => {
    // The anchor GitHub makes of the heading, so the link lands on the table.
    const readme = readFileSync(join(import.meta.dirname, "..", "..", "..", "README.md"), "utf8");
    expect(SUPPORT_TABLE).toMatch(/#platforms$/);
    expect(readme).toMatch(/^### Platforms$/m);
    const table = readme.split(/^### Platforms$/m)[1]!;
    expect(table).toMatch(/^\| iOS \| Untested \|/m);
    expect(table).toMatch(/^\| Windows \| Not supported \|/m);
  });
});
