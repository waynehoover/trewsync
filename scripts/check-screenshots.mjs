#!/usr/bin/env node
// Reject empty or truncated gallery captures before they reach a release.
import { readdir, readFile } from "node:fs/promises";

const directory = new URL("../docs/assets/screenshots/", import.meta.url);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let checked = 0;
let failed = false;
for (const name of (await readdir(directory)).sort()) {
  if (!name.endsWith(".png")) continue;
  const png = await readFile(new URL(name, directory));
  if (
    png.length < 45 ||
    !png.subarray(0, 8).equals(signature) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR" ||
    png.readUInt32BE(16) === 0 ||
    png.readUInt32BE(20) === 0 ||
    png.readUInt32BE(png.length - 12) !== 0 ||
    png.toString("ascii", png.length - 8, png.length - 4) !== "IEND"
  ) {
    console.error(`Invalid PNG screenshot: ${name}`);
    failed = true;
  }
  checked++;
}
if (checked === 0) throw new Error("No gallery screenshots found");
if (failed) process.exitCode = 1;
else console.log(`Checked ${checked} PNG screenshots`);
