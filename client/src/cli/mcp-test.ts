import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";

export async function buildMcp(dir: string, entry = "./bin.ts"): Promise<string> {
  const bundle = join(dir, "telimus.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile: bundle,
    platform: "node",
    target: "node22",
    format: "esm",
    bundle: true,
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __mcpCreateRequire } from "node:module"; const require = __mcpCreateRequire(import.meta.url);',
    },
  });
  return bundle;
}
export async function cli(...argv: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const code = await run(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
export async function openMcp(bundle: string, dir: string, flags: string[] = [], modern = false) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle, "mcp", ...(flags.includes("--vault") ? [] : ["--dir", dir]), ...flags],
    stderr: "pipe",
  });
  const client = new Client(
    { name: "telimus-test", version: "1" },
    modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`${String(error)}\n${stderr}`);
  }
  return {
    client,
    transport,
    stderr: () => stderr,
    async close() {
      await client.close();
    },
  };
}
export async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  if (!("structuredContent" in result) || !result.structuredContent)
    throw new Error(JSON.stringify(result));
  return result.structuredContent;
}
