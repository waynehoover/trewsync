import { afterEach, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli.ts";
import { validateUsage } from "./usage.ts";
import { cli } from "./mcp-test.ts";
import { saveConfig } from "./config.ts";
import { removeTree } from "../core/test-server.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTree(root);
});
async function paired(readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "trew-http-cli-"));
  roots.push(root);
  await saveConfig(root, {
    url: "ws://127.0.0.1:1",
    vaultId: "test",
    device: "test",
    secret: new Uint8Array(32).fill(7),
    readOnly,
  });
  return root;
}
it("parses an optional listener and repeated exact origins without consuming the next flag", () => {
  const args = parseArgs([
    "mcp",
    "--listen",
    "--allow-origin",
    "https://one.example",
    "--allow-origin",
    "https://two.example",
    "--writable",
  ]);
  validateUsage(args);
  expect(args).toMatchObject({
    mcpListen: "127.0.0.1:3010",
    mcpWritable: true,
    mcpOrigins: ["https://one.example", "https://two.example"],
  });
});
it.each([
  ["mcp", "--writable"],
  ["mcp", "--allow-origin", "https://app.example"],
  ["sync", "--listen"],
  ["sync", "--writable"],
  ["mcp-token", "--allow-origin", "https://app.example"],
  ["mcp", "--listen", "--writable", "--read-only"],
  ["mcp", "--listen", "0.0.0.0:3010"],
  ["mcp", "--listen", "[::]:3010"],
  ["mcp", "--listen", "[0:0:0:0:0:0:0:0]:3010"],
  ["mcp", "--listen", "[::ffff:0:0]:3010"],
  ["mcp", "--listen", "localhost:0"],
  ["mcp", "--listen", "127.0.0.1:65536"],
  ["mcp", "--listen", "--allow-origin", "https://app.example/path"],
])("refuses invalid HTTP usage before touching vault state: %j", async (...argv) => {
  expect((await cli(...argv, "--dir", "/nonexistent-trew-http-test-vault")).code).toBe(2);
});
it("requires a credential before starting HTTP", async () => {
  const result = await cli("mcp", "--listen", "--dir", await paired());
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain("mcp-token");
});
it("cannot make a persisted read-only device writable", async () => {
  const result = await cli("mcp", "--listen", "--writable", "--dir", await paired(true));
  expect(result.code).toBe(2);
  expect(result.out).toBe("");
  expect(result.err).toContain("read-only");
});
