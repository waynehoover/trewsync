/**
 * The Obsidian community directory's review, run here before it runs there.
 *
 * The directory re-reviews every release with `eslint-plugin-obsidianmd`'s
 * `recommended` config, and an error makes that release uninstallable. So the
 * same config runs over the same code, unchanged, and `bun run lint` fails on
 * any error it finds. Warnings pass there with a written reason, and pass here;
 * the reasons are the ledger in docs/development.md.
 *
 * What it reads is the plugin bundle's own source: every file under
 * `src/plugin` and `src/core` that `src/plugin/main.ts` imports, directly or
 * through another, type-only imports included. The rest of those two folders is
 * tests and the scaffolding tests stand on, and the headless client's half of
 * `core`. None of it ships in the plugin, and the review is about what ships.
 *
 * It runs from the repository root (`bun run lint` changes there), because the
 * plugin reads `manifest.json` from the working directory: `minAppVersion` is
 * what `no-unsupported-api` checks against, and without it that rule, the one
 * that decides whether an older Obsidian can load the plugin at all, turns
 * itself off: the plugin logs that it found no manifest and the lint passes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import ts from "typescript";

const here = import.meta.dirname;

/**
 * Files under `src/plugin` and `src/core` that the plugin bundle never
 * imports, and why each exists. Tests (`*.test.ts`) are excluded by name.
 *
 * Checked below against what `main.ts` actually reaches, so this cannot go
 * stale in the direction that matters: the day the plugin starts importing one
 * of these, linting refuses to run until it is taken off this list.
 */
const notInTheBundle = {
  "src/core/chunk-fixtures.ts": "builds and checks chunk-fixtures.json, for its test",
  "src/core/chunk-fixtures.run.ts": "the command that writes chunk-fixtures.json",
  "src/core/fake-socket.ts": "an in-memory socket the engine tests drive",
  "src/core/latency.ts": "a slow link for slow-link.test.ts and bench-sync.ts",
  "src/core/merge.fuzz.ts": "the merge fuzzer, for its test",
  "src/core/merge.fuzz.run.ts": "the command that runs the merge fuzzer at length",
  "src/core/outcome.ts": "the headless client's exit outcomes (src/node only)",
  "src/core/seam.ts": "fault-injection seams for the Node vault and the stress suite",
  "src/core/test-async.ts": "waiting helpers for tests",
  "src/core/test-server.ts": "builds and runs a real trew for tests",
  "src/plugin/fake.ts": "an in-memory DataAdapter for tests",
  "src/plugin/stub.ts": "the obsidian module at runtime, for tests",
  "src/plugin/panel-shots.ts": "the panel walk behind panel-shots.test.ts",
  "src/plugin/platform-probe.ts": "the device filesystem probe, not wired into main.ts yet",
};

/** Every relative module `entry` reaches, as paths relative to `here`. */
function reachableFrom(entry) {
  const seen = new Set();
  const pending = [resolve(here, entry)];
  while (pending.length > 0) {
    const file = pending.pop();
    const rel = relative(here, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    // preProcessFile reads static, type-only and dynamic imports alike, and
    // skips comments, which a regular expression would not.
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const target = resolve(dirname(file), fileName);
      if (!existsSync(target)) throw new Error(`${rel} imports ${fileName}, which is not there`);
      pending.push(target);
    }
  }
  return seen;
}

const shipped = reachableFrom("src/plugin/main.ts");
if (shipped.size < 30 || !shipped.has("src/core/engine.ts")) {
  throw new Error(
    `the plugin bundle reaches only ${shipped.size} files; the import walk is broken`,
  );
}
for (const file of shipped) {
  if (!/^src\/(plugin|core)\/[^/]+\.ts$/.test(file) || file.endsWith(".test.ts")) {
    throw new Error(`the plugin bundle imports ${file}, which this lint does not read`);
  }
}
for (const file of Object.keys(notInTheBundle)) {
  if (!existsSync(join(here, file))) {
    throw new Error(`${file} is listed as not shipped and is gone`);
  }
  if (shipped.has(file)) {
    throw new Error(`the plugin bundle imports ${file} now; take it off notInTheBundle`);
  }
}
// An unlisted file the bundle does not reach would simply be linted, which is
// only stricter. Refused anyway, so that every file left out has a reason
// written beside it rather than a guess about which list it belongs on.
for (const dir of ["src/plugin", "src/core"]) {
  for (const name of readdirSync(join(here, dir))) {
    const file = `${dir}/${name}`;
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    if (!shipped.has(file) && !(file in notInTheBundle)) {
      throw new Error(`${file} is not in the plugin bundle; add it to notInTheBundle with why`);
    }
  }
}

const manifest = join(process.cwd(), "manifest.json");
if (!existsSync(manifest) || resolve(process.cwd()) !== resolve(here, "..")) {
  throw new Error("run this from the repository root, where manifest.json is: bun run lint does");
}

export default defineConfig([
  {
    basePath: here,
    files: ["src/plugin/**/*.ts", "src/core/**/*.ts"],
    ignores: ["**/*.test.ts", ...Object.keys(notInTheBundle)],
    extends: [obsidianmd.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: here,
      },
    },
  },
]);
