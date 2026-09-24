#!/usr/bin/env node
// M2 acceptance: two plugin instances in two fresh scratch vaults and one
// headless client pair from invites against a local trew serve, converge, keep
// both sides of a conflict, restore a deleted note, and surface a refused path.
//
// Every write into an open vault goes through Obsidian (the CLI's create and
// delete, or app.vault.adapter inside an eval). Vault folders are written
// directly only before Obsidian has opened them.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.argv[2];
const run = process.argv[3] ?? "1";
const here = new URL(".", import.meta.url).pathname;
const trewBin = join(here, "..", "trew");
const cli = join(repo, "client/dist/trew.mjs");
const pluginDir = join(repo, "client/dist/plugin");
const port = 3411;
const data = join(here, `data-${run}`);
const headless = join(here, `headless-${run}`);
const names = { a: `trew-accept-${run}a`, b: `trew-accept-${run}b` };
const vaults = { a: join(homedir(), names.a), b: join(homedir(), names.b) };
const evidence = [];
const log = (step, detail) => {
  const line = { step, ...detail };
  evidence.push(line);
  console.log(JSON.stringify(line));
};

function obsidian(args) {
  return execFileSync("obsidian", args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

let evalN = 0;
/** Runs an async body in a vault, with a vault-name guard, and returns its JSON result. */
async function inVault(vault, body, timeoutMs = 60_000) {
  const marker = join(here, `eval-${++evalN}.json`);
  const code = `void (async()=>{const fs=require("fs");try{
    if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error("CLI selected "+app.vault.getName());
    const plugin=app.plugins.plugins["trew-sync"];
    const result=await (async()=>{${body}})();
    fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ok:true,result:result??null}));
  }catch(err){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ok:false,error:String(err&&err.stack||err)}));}})()`;
  const out = obsidian([`vault=${vault}`, "eval", `code=${code}`]);
  if (/^(?:Error|Evaluation error):/m.test(out)) throw new Error(out.trim());
  const until = Date.now() + timeoutMs;
  while (!existsSync(marker)) {
    if (Date.now() > until) throw new Error(`eval ${evalN} in ${vault} timed out`);
    await delay(100);
  }
  const r = JSON.parse(readFileSync(marker, "utf8"));
  if (!r.ok) throw new Error(`in ${vault}: ${r.error}`);
  return r.result;
}

async function waitFor(what, fn, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await delay(1000);
  }
}

function trew(...args) {
  return execFileSync("node", [cli, ...args, "--dir", headless], { encoding: "utf8", timeout: 120_000 });
}
/** The same, keeping the exit status: sync and status exit non-zero while something needs attention. */
function trewStatus(...args) {
  try {
    return { status: 0, out: trew(...args) };
  } catch (err) {
    if (typeof err.status !== "number") throw err;
    return { status: err.status, out: String(err.stdout) + String(err.stderr) };
  }
}

/** Path to SHA-256 of every synced file under a folder, skipping dot-prefixed names. */
function inventory(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).normalize("NFC")] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const same = (x, y) => JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());

async function syncAll() {
  for (const v of ["a", "b"]) await inVault(names[v], "await plugin.syncNow();", 120_000);
  trewStatus("sync");
  for (const v of ["a", "b"]) await inVault(names[v], "await plugin.syncNow();", 120_000);
}

async function converged(label) {
  return waitFor(`${label}: all three to converge`, async () => {
    await syncAll();
    const a = inventory(vaults.a), b = inventory(vaults.b), h = inventory(headless);
    return same(a, b) && same(a, h) ? a : false;
  }, 180_000);
}

let server;
try {
  for (const d of [data, headless, vaults.a, vaults.b]) {
    if (existsSync(d)) throw new Error(`${d} already exists; remove it first`);
  }
  mkdirSync(data, { recursive: true });
  mkdirSync(headless, { recursive: true });

  // Both vaults prepared while Obsidian has never seen them.
  for (const v of ["a", "b"]) {
    const plugins = join(vaults[v], ".obsidian/plugins/trew-sync");
    mkdirSync(plugins, { recursive: true });
    for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(pluginDir, f), join(plugins, f));
    writeFileSync(join(vaults[v], ".obsidian/community-plugins.json"), JSON.stringify(["trew-sync"]));
  }
  writeFileSync(join(vaults.a, "Seed.md"), "# Seed\n\nWritten before vault A was paired.\n");

  server = spawn(trewBin, ["serve", "-localhost", "-addr", `127.0.0.1:${port}`, "-data", data], { stdio: ["ignore", "pipe", "pipe"] });
  const serverLog = [];
  server.stdout.on("data", (b) => serverLog.push(String(b)));
  server.stderr.on("data", (b) => serverLog.push(String(b)));
  const firstInvite = await waitFor("first-invite", () => existsSync(join(data, "first-invite")) && readFileSync(join(data, "first-invite"), "utf8").trim());
  log("server", { version: execFileSync(trewBin, ["version"], { encoding: "utf8" }).trim(), firstInvite: firstInvite.slice(0, 12) + "..." });

  // Open both through Obsidian's own IPC, from the scratch vault.
  for (const v of ["a", "b"]) {
    await inVault("telimus-scratch-vault", `require("electron").ipcRenderer.sendSync("vault-open", ${JSON.stringify(vaults[v])}, false); return true;`);
    await waitFor(`vault ${v} to answer`, () => inVault(names[v], "return app.vault.getName();", 10_000));
    await inVault(names[v], `
      if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
      if (!app.plugins.plugins["trew-sync"]) await app.plugins.enablePluginAndSave("trew-sync");
      return !!app.plugins.plugins["trew-sync"];`);
    const loaded = await waitFor(`the plugin in ${v}`, () => inVault(names[v], `return !!app.plugins.plugins["trew-sync"] && app.plugins.plugins["trew-sync"].manifest.version;`));
    log("plugin loaded", { vault: names[v], version: loaded });
  }

  // Pairing: A from the server's first invite, B and the headless client from invites A makes.
  await inVault(names.a, `await plugin.pair(${JSON.stringify(firstInvite)}, "Accept A", true); return plugin.paired;`, 120_000);
  await waitFor("A synced", () => inVault(names.a, `return plugin.currentState.kind === "synced" && plugin.currentState;`));
  const forB = await inVault(names.a, "return (await plugin.createInvite()).invite;");
  await inVault(names.b, `await plugin.pair(${JSON.stringify(forB)}, "Accept B", false); return plugin.paired;`, 120_000);
  const forH = await inVault(names.a, "return (await plugin.createInvite()).invite;");
  log("pair headless", { out: execFileSync("node", [cli, "pair", forH, "--dir", headless, "--device", "accept-headless"], { encoding: "utf8", timeout: 120_000 }).trim().split("\n").slice(-2) });
  trew("sync");
  await waitFor("Seed.md in B", () => existsSync(join(vaults.b, "Seed.md")));
  log("paired", { devices: JSON.parse(trew("devices", "--json")) });

  // Edits from all three.
  obsidian([`vault=${names.a}`, "create", "path=From A.md", "content=Written in vault A through Obsidian.\n"]);
  obsidian([`vault=${names.b}`, "create", "path=Notes/From B.md", "content=Written in vault B through Obsidian.\n"]);
  writeFileSync(join(headless, "From headless.md"), "Written on disk by the headless client.\n");
  const inv1 = await converged("edits");
  log("converged", { files: Object.keys(inv1).sort() });

  // A conflict: the headless client edits offline while A and B edit the same line.
  obsidian([`vault=${names.a}`, "create", "path=Shared.md", "content=line one\nthe contested line\nline three\n"]);
  await converged("shared note");
  const theirs = "line one\nthe contested line, as vault A has it\nline three\n";
  const mine = "line one\nthe contested line, as the headless client has it\nline three\n";
  writeFileSync(join(headless, "Shared.md"), mine);
  await inVault(names.a, `const f=app.vault.getAbstractFileByPath("Shared.md"); await app.vault.modify(f, ${JSON.stringify(theirs)}); return true;`);
  await inVault(names.a, "await plugin.syncNow(); return true;", 120_000);
  await waitFor("A's edit in B", async () => {
    await inVault(names.b, "await plugin.syncNow();", 120_000);
    return read(vaults.b, "Shared.md") === theirs;
  });
  const inv2 = await converged("conflict");
  const texts = Object.keys(inv2).filter((p) => p.startsWith("Shared")).map((p) => [p, read(vaults.b, p)]);
  const both = texts.some(([, t]) => t === theirs) && texts.some(([, t]) => t === mine);
  log("conflict", { files: texts.map(([p]) => p), bothSidesKept: both });
  if (!both) throw new Error("a side of the conflict was lost: " + JSON.stringify(texts));

  // Delete in A, restore from B's deleted list.
  const deletedText = read(vaults.a, "Notes/From B.md");
  obsidian([`vault=${names.a}`, "delete", "path=Notes/From B.md", "permanent"]);
  await waitFor("the delete to reach B and the headless client", async () => {
    await syncAll();
    return !existsSync(join(vaults.b, "Notes/From B.md")) && !existsSync(join(headless, "Notes/From B.md"));
  });
  const restored = await inVault(names.b, `
    const list = await plugin.deletedNotes();
    const d = list.notes.find((n) => n.path === "Notes/From B.md");
    if (!d) throw new Error("not in the deleted list: " + JSON.stringify(list.notes.map((n) => n.path)));
    return await plugin.recover(d);`, 120_000);
  const inv3 = await converged("restore");
  const back = Object.keys(inv3).filter((p) => read(vaults.a, p) === deletedText);
  log("restore", { restored, sameBytesAt: back });
  if (back.length === 0) throw new Error("the restored note did not come back byte for byte");

  // Refused paths. A control character on disk for the headless client, and a
  // path over 1,024 bytes written into vault A through Obsidian.
  const control = "Bad\u0001name.md";
  writeFileSync(join(headless, control), "a control character in the name\n");
  const synced = trewStatus("sync");
  const human = trewStatus("status");
  const status = trewStatus("status", "--json");
  log("refused (headless)", { syncExit: synced.status, syncOut: synced.out.slice(-400), statusExit: human.status, status: human.out.slice(0, 800), json: status.out.slice(0, 800) });
  // macOS caps an absolute path at 1,024 bytes, so a path over the server's
  // 1,024 cannot exist on this disk; the plugin gets a control character too.
  const long = "Bad\u0002 plugin name.md";
  await inVault(names.a, `await app.vault.adapter.write(${JSON.stringify(long)}, "a control character in a plugin note's name\\n"); return true;`);
  const issues = await waitFor("A to name the refused path", async () => {
    const s = await inVault(names.a, "await plugin.syncNow(); return plugin.currentState;", 120_000);
    return s.kind === "synced" && (s.issues ?? []).some((i) => i.path === long) && s;
  });
  log("refused (plugin)", { refused: issues.refused, issues: issues.issues });
  if (!existsSync(join(vaults.a, long))) throw new Error("the refused long path is gone from disk");
  if (!existsSync(join(headless, control))) throw new Error("the refused control-character file is gone from disk");

  const stats = execFileSync(trewBin, ["stats", "-data", data, "-json"], { encoding: "utf8" });
  log("server stats", { stats: JSON.parse(stats) });
  log("done", { ok: true });
} catch (err) {
  log("failed", { error: String(err && err.stack || err) });
  process.exitCode = 1;
} finally {
  writeFileSync(join(here, `evidence-${run}.json`), JSON.stringify(evidence, null, 2));
  server?.kill("SIGTERM");
  // The windows closed, the vaults left registered and on disk for inspection.
  for (const v of ["a", "b"]) {
    try {
      obsidian([`vault=${names[v]}`, "eval", `code=require("electron").remote.getCurrentWindow().close()`]);
    } catch {}
  }
}
