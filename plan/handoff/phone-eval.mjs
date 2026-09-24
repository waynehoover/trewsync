#!/usr/bin/env node
// node phone-eval.mjs FILE.js [ARG]: runs the async body in FILE.js inside
// Obsidian on the phone over the WebView's DevTools socket (adb forward to
// 127.0.0.1:9333), with `plugin` bound to Trew and `arg` to ARG, guarded on
// the vault's name, and prints its JSON result.
import { readFileSync } from "node:fs";
const [file, arg] = process.argv.slice(2);
const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const expression = `(async()=>{
  if(app.vault.getName()!=="Trew M3")throw new Error("wrong vault: "+app.vault.getName());
  const plugin=app.plugins.plugins["trew-sync"]; const arg=${JSON.stringify(arg ?? null)};
  return JSON.stringify(await (async()=>{${readFileSync(file, "utf8")}\n})() ?? null);
})()`;
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
const reply = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }; });
ws.close();
const res = reply.result;
if (res?.exceptionDetails) { console.error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)); process.exit(1); }
console.log(JSON.stringify(JSON.parse(res.result.value), null, 2));
