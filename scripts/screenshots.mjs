#!/usr/bin/env node
// Capture the real plugin UI in a running desktop Obsidian, using sample data.
// Live vault writes go through Obsidian's adapter, invoked by its CLI.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, mkdir, access, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "client/package.json"));
const scenes = [
  "panel",
  "pairing",
  "join",
  "join-confirm",
  "setup",
  "invite",
  "server",
  "devices",
  "deleted",
  "deleted-empty",
  "deleted-error",
  "deleted-older-empty",
  "changes",
  "activity",
  "conflicts",
  "preview",
  "attachment-history",
  "settings",
  "status",
  "loading",
  "uploading",
  "downloading",
];
const options = new Map();
for (const [i, arg] of process.argv.slice(2).entries()) {
  if (arg === "--help") {
    console.log(`Usage: node scripts/screenshots.mjs --vault NAME [--scene NAME] [--theme light|dark]
  [--device desktop|phone] [--output DIRECTORY] [--server-version VERSION]

Use an open test vault in desktop Obsidian with its CLI enabled.
Requires installed client dependencies. Writes docs/assets/screenshots/*.png.
Defaults: all scenes, both themes. Scenes: ${scenes.join(", ")}.
Phone previews use a narrow desktop window and Obsidian's mobile CSS;
they check layout, not the Android/iOS runtime. Use --output for review captures.
The status bar and desktop Settings window are desktop-only scenes.
The temporary preview plugin never connects to a server or reads your notes.
Server information uses "dev" unless --server-version names the matching release.
It restores the theme, window bounds and clipboard, and removes itself afterward.`);
    process.exit(0);
  }
  if (i % 2 === 0) {
    if (!["--vault", "--scene", "--theme", "--device", "--output", "--server-version"].includes(arg))
      throw new Error(`Unknown option: ${arg}`);
    const value = process.argv[i + 3];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options.set(arg, value);
  }
}
const vault = options.get("--vault");
if (!vault) throw new Error("Specify an open test vault with --vault NAME. See --help.");
const themes = options.has("--theme") ? [options.get("--theme")] : ["light", "dark"];
const device = options.get("--device") ?? "desktop";
const availableScenes =
  device === "phone" ? scenes.filter((s) => !["status", "settings"].includes(s)) : scenes;
const chosenScenes = options.has("--scene") ? [options.get("--scene")] : availableScenes;
if (
  chosenScenes.some((s) => !availableScenes.includes(s)) ||
  themes.some((t) => !["light", "dark"].includes(t)) ||
  !["desktop", "phone"].includes(device)
) {
  throw new Error("Unknown scene or theme. See --help.");
}
const id = "telimus-release-screenshots";
const scratch = await mkdtemp(join(tmpdir(), "telimus-screenshots-"));
const out = options.has("--output")
  ? resolve(options.get("--output"))
  : join(root, "docs/assets/screenshots");
const ready = join(scratch, "ready");
let installed = false;
let interrupted;
const interrupt = (signal) => {
  interrupted = new Error(`Interrupted by ${signal}`);
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

function evaluate(code) {
  const result = execFileSync("obsidian", [`vault=${vault}`, "eval", `code=${code}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (/^(?:Error|Evaluation error):/m.test(result)) throw new Error(result.trim());
}

// CLI eval can return before an async function finishes. A marker written by
// that function establishes completion; a successful CLI exit alone does not.
async function waitFor(path, cleanup = false) {
  for (let i = 0; i < 200; i++) {
    if (interrupted && !cleanup) throw interrupted;
    try {
      throw new Error(await readFile(path + ".error", "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    try {
      await access(path);
      return;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

try {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const serverVersion = options.get("--server-version") ?? "dev";
  const { build } = require("esbuild");
  await build({
    entryPoints: [join(root, "scripts/screenshots/fixture.ts")],
    bundle: true,
    platform: "browser",
    format: "cjs",
    external: ["obsidian", "electron", "fs"],
    outfile: join(scratch, "main.js"),
    define: { __SCREENSHOT_SERVER_VERSION__: JSON.stringify(serverVersion) },
    plugins: [
      {
        name: "preview-exports",
        setup(build) {
          // Keep preview-only entry points out of the shipped plugin API.
          build.onLoad({ filter: /\/plugin\/main\.ts$/ }, async (args) => ({
            contents:
              (await readFile(args.path, "utf8")) +
              "\nexport { TelimusPanel, TelimusModal, RecoverModal, paintStatus };\n",
            loader: "ts",
          }));
        },
      },
    ],
  });
  const previewManifest = {
    ...manifest,
    id,
    description: "Temporary screenshot fixture",
    isDesktopOnly: true,
  };
  if (interrupted) throw interrupted;
  evaluate(`void (async()=>{try{
    if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error("CLI selected the wrong vault");
    const fs=require("fs"),dir=app.vault.configDir+"/plugins/"+${JSON.stringify(id)};
    if(await app.vault.adapter.exists(dir))throw new Error("Preview plugin already exists; remove it from the test vault before rerunning");
    await app.vault.adapter.mkdir(dir);
    fs.writeFileSync(${JSON.stringify(join(scratch, "installed"))},"");
    await app.vault.adapter.write(dir+"/main.js",fs.readFileSync(${JSON.stringify(join(scratch, "main.js"))},"utf8"));
    await app.vault.adapter.write(dir+"/manifest.json",${JSON.stringify(JSON.stringify(previewManifest))});
    await app.vault.adapter.write(dir+"/styles.css",fs.readFileSync(${JSON.stringify(join(root, "client/styles.css"))},"utf8"));
    await app.plugins.loadManifests();await app.plugins.enablePlugin(${JSON.stringify(id)});
    if(!app.plugins.plugins[${JSON.stringify(id)}])throw new Error("Preview did not load");
    fs.writeFileSync(${JSON.stringify(ready)},"");
  }catch(err){require("fs").writeFileSync(${JSON.stringify(ready + ".error")},String(err.stack??err));}})()`);
  await waitFor(ready);
  installed = true;
  await mkdir(out, { recursive: true });
  for (const scene of chosenScenes)
    for (const theme of themes) {
      if (interrupted) throw interrupted;
      const name = `${scene}${device === "phone" ? "-phone" : ""}${theme === "dark" ? "-dark" : ""}.png`;
      const staged = join(scratch, name);
      evaluate(
        `void app.plugins.plugins[${JSON.stringify(id)}].capture(${JSON.stringify(scene)},${JSON.stringify(theme)},${JSON.stringify(staged)},${JSON.stringify(device)})`,
      );
      try {
        await waitFor(staged);
      } catch (err) {
        try {
          await copyFile(staged, join(out, name.replace(".png", ".failed.png")));
        } catch {}
        throw err;
      }
      // Only replace a previous screenshot after the new capture succeeded.
      await copyFile(staged, join(out, name));
      console.log(`Captured ${name}`);
    }
} finally {
  try {
    await access(join(scratch, "installed"));
    installed = true;
  } catch {}
  if (installed) {
    const cleaned = join(scratch, "cleaned");
    evaluate(`void (async()=>{try{
      const id=${JSON.stringify(id)},preview=app.plugins.plugins[id];
      if(preview?.pending)await preview.pending;
      await app.plugins.disablePlugin(id);
      await app.vault.adapter.rmdir(app.vault.configDir+"/plugins/"+id,true);
      await app.plugins.loadManifests();require("fs").writeFileSync(${JSON.stringify(cleaned)},"");
    }catch(err){require("fs").writeFileSync(${JSON.stringify(cleaned + ".error")},String(err.stack??err));}})()`);
    await waitFor(cleaned, true);
  }
  await rm(scratch, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
