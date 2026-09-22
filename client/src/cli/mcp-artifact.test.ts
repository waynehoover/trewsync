import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";
import { smokeMcpArtifact, smokeHttpArtifact } from "./mcp-artifact-test.ts";

it("the actual production configuration builds an isolated single-file MCP and keeps the SDK out of the plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "telimus-mcp-production-"));
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
    expect(plugin).not.toMatch(/modelcontextprotocol|McpServer|StdioServerTransport/);
    const artifact = join(installation, "telimus.mjs");
    await copyFile(join(staging, "dist/telimus.mjs"), artifact);
    // Remove build inputs from the installation's entire ancestry before launch.
    await removeTree(join(root, "staging"));
    expect(await readdir(installation)).toEqual(["telimus.mjs"]);
    const measured = await smokeMcpArtifact(artifact, process.execPath, join(source, ".."));
    const http = await smokeHttpArtifact(artifact, process.execPath, join(source, ".."));
    console.info({
      ...measured,
      httpInitializationMs: http.initializationMs,
      cliBytes: (await readFile(artifact)).length,
      pluginBytes: Buffer.byteLength(plugin),
    });
  } finally {
    await removeTree(root);
  }
});
