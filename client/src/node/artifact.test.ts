import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";
import { build } from "esbuild";
import { smokeArtifact } from "./artifact-test.ts";

/**
 * The release's own build configuration, run in a staging copy, and the file it
 * makes copied alone into an empty directory with its build inputs deleted, then
 * run: paired, synced both ways, under the repository denied on macOS. Neither
 * bundle carries an MCP server: the server's `/mcp` is the only MCP (PLAN.md
 * M2 task 10), and the oracle sources the Go port was checked against are not
 * reachable from either entry point.
 */
it("the actual production configuration builds a single-file client that syncs on its own, with no MCP in either bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "trew-production-"));
  const source = fileURLToPath(new URL("../..", import.meta.url));
  const staging = join(root, "staging", "client");
  const installation = join(root, "installation");
  await mkdir(staging, { recursive: true });
  await mkdir(installation);
  try {
    for (const file of ["package.json", "esbuild.config.mjs", "styles.css"])
      await copyFile(join(source, file), join(staging, file));
    await copyFile(join(source, "../manifest.json"), join(staging, "../manifest.json"));
    for (const dir of ["src", "node_modules"]) await symlink(join(source, dir), join(staging, dir));
    const child = spawn(process.execPath, ["esbuild.config.mjs", "production"], {
      cwd: staging,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      expect((await within(closed, "fresh production build", 30000))[0], stderr).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    const plugin = await readFile(join(staging, "dist/plugin/main.js"), "utf8");
    const cli = await readFile(join(staging, "dist/trew.mjs"), "utf8");
    // The SDK, the tool names the retired host registered, its credential
    // file, and refusal codes only the oracle sources hold. The same pattern
    // is required to match the oracle sources bundled on their own, so it
    // cannot pass by matching nothing.
    const mcp =
      /modelcontextprotocol|McpServer|StdioServerTransport|"edit_note"|"search_notes"|mcp-token\.json|overlapping_edits|reserved_backup|scan_incomplete|same_destination/;
    const oracle = await build({
      entryPoints: [fileURLToPath(new URL("./mcp-operations.ts", import.meta.url))],
      bundle: true,
      minify: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    expect(oracle.outputFiles[0]!.text).toMatch(mcp);
    for (const bundle of [plugin, cli]) expect(bundle).not.toMatch(mcp);
    const artifact = join(installation, "trew.mjs");
    await copyFile(join(staging, "dist/trew.mjs"), artifact);
    // Remove build inputs from the installation's entire ancestry before launch.
    await removeTree(join(root, "staging"));
    expect(await readdir(installation)).toEqual(["trew.mjs"]);
    const measured = await smokeArtifact(artifact, process.execPath, join(source, ".."));
    console.info({
      ...measured,
      cliBytes: Buffer.byteLength(cli),
      pluginBytes: Buffer.byteLength(plugin),
    });
  } finally {
    await removeTree(root);
  }
});
