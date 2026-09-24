#!/usr/bin/env node
// node in-vault.mjs VAULT FILE.js [ARG]: runs the async body in FILE.js inside
// the named open vault through the obsidian CLI, with `plugin` bound to Trew
// and `arg` to ARG, guarded on the vault's name, and prints its JSON result.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [vault, file, arg] = process.argv.slice(2);
const here = new URL(".", import.meta.url).pathname;
const marker = join(here, `eval-${process.pid}-${Date.now()}.json`);
const body = readFileSync(file, "utf8");
const code = `void (async()=>{const fs=require("fs");try{
  if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error("CLI selected "+app.vault.getName());
  const plugin=app.plugins.plugins["trew-sync"]; const arg=${JSON.stringify(arg ?? null)};
  const result=await (async()=>{${body}\n})();
  fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ok:true,result:result??null}));
}catch(err){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ok:false,error:String(err&&err.stack||err)}));}})()`;
const out = execFileSync("obsidian", [`vault=${vault}`, "eval", `code=${code}`], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
if (/^(?:Error|Evaluation error):/m.test(out)) {
  console.error(out.trim());
  process.exit(1);
}
const until = Date.now() + 180_000;
while (!existsSync(marker)) {
  if (Date.now() > until) {
    console.error("timed out");
    process.exit(1);
  }
  await delay(100);
}
const r = JSON.parse(readFileSync(marker, "utf8"));
console.log(JSON.stringify(r.ok ? r.result : { error: r.error }, null, 2));
process.exit(r.ok ? 0 : 1);
