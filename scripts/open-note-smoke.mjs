#!/usr/bin/env node
// Exercise actual Obsidian editors using a temporary plugin and disposable notes.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [flag, vault, mode, ...extra] = process.argv.slice(2);
if (flag !== "--vault" || !vault || (mode && mode !== "--native-writes") || extra.length) {
  console.log(
    'Usage: node scripts/open-note-smoke.mjs --vault "Test vault" [--native-writes]\n' +
      "Use an open, unpaired test vault with the Obsidian CLI enabled. Tests split\n" +
      "editors, cursor stability, unsaved typing and undo. Trashes its temporary\n" +
      "notes and removes the test plugin afterward. Does not connect to a server.\n" +
      "--native-writes compares the same editors using Obsidian Vault.modify.",
  );
  process.exit(flag === "--help" ? 0 : 1);
}
const scratch = await mkdtemp(join(tmpdir(), "trew-open-note-"));
const resultPath = join(scratch, "result.json");
const ownedPath = join(scratch, "owned");
const id = `trew-open-note-smoke-${randomUUID()}`;
const require = createRequire(join(root, "client/package.json"));
let installed = false;

function evaluate(code) {
  const output = execFileSync("obsidian", [`vault=${vault}`, "eval", `code=${code}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (/^(?:Error|Evaluation error):/m.test(output)) throw new Error(output.trim());
  return output;
}

// The CLI returns before async eval completes. Observe a completion file, not
// a guessed sleep; start watching before invoking the code that creates it.
async function completion(path, start) {
  let watcher;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const inspect = async () => {
        try {
          resolve(JSON.parse(await readFile(path, "utf8")));
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) reject(error);
        }
      };
      watcher = watch(scratch, inspect);
      timer = setTimeout(() => reject(new Error(`Timed out: ${path}`)), 30_000);
      start();
      void inspect();
    });
  } finally {
    watcher?.close();
    clearTimeout(timer);
  }
}

try {
  const { build } = require("esbuild");
  await build({
    entryPoints: [join(root, "scripts/open-note/fixture.ts")],
    bundle: true,
    platform: "browser",
    format: "cjs",
    external: ["obsidian", "fs"],
    outfile: join(scratch, "main.js"),
    define: {
      RESULT_PATH: JSON.stringify(resultPath),
      NATIVE_WRITES: String(mode === "--native-writes"),
    },
  });
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify({
      id,
      name: "TrewSync editor check",
      version: "0.0.0",
      minAppVersion: "1.6.0",
      description: "Temporary native editor regression test.",
      author: "TrewSync",
      isDesktopOnly: true,
    }),
  );
  const preflight = evaluate(`JSON.stringify({name:app.vault.getName(),
    state:app.plugins.plugins["trew-sync"]?.currentState?.kind,
    existing:!!app.plugins.manifests[${JSON.stringify(id)}]})`);
  const state = JSON.parse(preflight.slice(preflight.indexOf("{")));
  if (state.name !== vault || state.existing || (state.state && state.state !== "unpaired"))
    throw new Error("Use an unpaired test vault without an existing smoke-test plugin.");
  installed = true;
  const result = await completion(resultPath, () =>
    evaluate(`void (async()=>{
    const fs=require("fs"), dir=app.vault.configDir+"/plugins/"+${JSON.stringify(id)};
    if(await app.vault.adapter.exists(dir)) throw new Error("The temporary plugin folder already exists");
    await app.vault.adapter.mkdir(dir);
    fs.writeFileSync(${JSON.stringify(ownedPath)},dir);
    for(const name of ["main.js","manifest.json"])
      await app.vault.adapter.write(dir+"/"+name,fs.readFileSync(${JSON.stringify(scratch)}+"/"+name,"utf8"));
    await app.plugins.loadManifests(); await app.plugins.enablePlugin(${JSON.stringify(id)});
    if(!app.plugins.plugins[${JSON.stringify(id)}]) throw new Error("The native smoke plugin did not load");
  })().catch(error=>require("fs").writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:false,error:String(error)})));`),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  if (installed && existsSync(ownedPath)) {
    const cleanupPath = join(scratch, "cleanup.json");
    const cleanup = await completion(cleanupPath, () =>
      evaluate(`void (async()=>{
      const id=${JSON.stringify(id)}, dir=app.vault.configDir+"/plugins/"+id;
      await app.plugins.disablePlugin(id);
      if(await app.vault.adapter.exists(dir)) await app.vault.adapter.rmdir(dir,true);
      await app.plugins.loadManifests();
      require("fs").writeFileSync(${JSON.stringify(cleanupPath)},JSON.stringify({ok:true}));
    })().catch(error=>require("fs").writeFileSync(${JSON.stringify(cleanupPath)},JSON.stringify({ok:false,error:String(error)})));`),
    );
    if (!cleanup.ok) throw new Error(cleanup.error);
  }
  await rm(scratch, { recursive: true, force: true });
}
