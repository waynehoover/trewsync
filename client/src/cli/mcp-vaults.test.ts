import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli.ts";
import { validateUsage } from "./usage.ts";
import { mcpVaultRoots } from "./mcp-vaults.ts";
import { removeTree } from "../core/test-server.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTree(root);
});
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "telimus-vault-roots-"));
  roots.push(dir);
  return dir;
}
it("parses repeatable named vaults without changing single-vault defaults", () => {
  const args = parseArgs(["mcp", "--vault", "personal=/srv/personal", "--vault", "work=/srv/work"]);
  validateUsage(args);
  expect(args.mcpVaults).toEqual(["personal=/srv/personal", "work=/srv/work"]);
});
it("canonicalizes explicitly configured roots before acquiring any vault lock", async () => {
  const dir = await root();
  await mkdir(join(dir, "actual"));
  await symlink(join(dir, "actual"), join(dir, "alias"));
  expect(
    await mcpVaultRoots({ ...parseArgs(["mcp"]), mcpVaults: [`notes=${join(dir, "alias")}`] }),
  ).toEqual([{ id: "notes", dir: await realpath(join(dir, "actual")) }]);
});
it.each(["duplicate", "alias", "nested", "invalid-name", "relative", "too-many"])(
  "refuses %s vault roots before starting sessions",
  async (kind) => {
    const dir = await root();
    await mkdir(join(dir, "nested"));
    await symlink(dir, join(dir, "alias"));
    const values =
      kind === "duplicate"
        ? [`notes=${dir}`, `notes=${join(dir, "nested")}`]
        : kind === "alias"
          ? [`one=${dir}`, `two=${join(dir, "alias")}`]
          : kind === "nested"
            ? [`one=${dir}`, `two=${join(dir, "nested")}`]
            : kind === "invalid-name"
              ? [`../escape=${dir}`]
              : kind === "relative"
                ? ["notes=relative/path"]
                : Array.from({ length: 11 }, (_, i) => `v${i}=${dir}`);
    await expect(mcpVaultRoots({ ...parseArgs(["mcp"]), mcpVaults: values })).rejects.toThrow();
  },
);
it.each([
  ["sync", "--vault", "notes=/srv/notes"],
  ["mcp", "--dir", "/srv/notes", "--vault", "notes=/srv/notes"],
])("rejects ambiguous or irrelevant vault flags: %j", (...argv) => {
  expect(() => validateUsage(parseArgs(argv))).toThrow();
});

it("releases already acquired locks if a later vault is busy", async () => {
  const a = await root(),
    b = await root();
  const sorted = [a, b].sort();
  const { lockVault } = await import("./lock.ts");
  const { withMcpLocks } = await import("./mcp-vaults.ts");
  const release = await lockVault(sorted[1]!, "other process");
  try {
    await expect(
      withMcpLocks(
        sorted.map((dir, i) => ({ id: `v${i}`, dir })),
        async () => {
          throw new Error("must not enter work");
        },
      ),
    ).rejects.toThrow(/lock|held|running|another/i);
    await (
      await lockVault(sorted[0]!, "released earlier root")
    )();
  } finally {
    await release();
  }
});
