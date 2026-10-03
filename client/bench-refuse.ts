/**
 * Names the benchmarks refuse beyond their own lists: the real vault and the
 * tailnet of whoever runs them, which the repository should not publish.
 *
 * One per line in `bench-refuse.local` beside this file, which is gitignored.
 * Without it the lists still refuse every generic name, and the phone
 * benchmarks still refuse any path outside their own vault.
 */
import { readFileSync } from "node:fs";

export const LOCAL_REFUSALS: readonly string[] = (() => {
  try {
    return readFileSync(new URL("./bench-refuse.local", import.meta.url), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
})();
