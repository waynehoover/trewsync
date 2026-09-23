import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { saveConfig } from "./config.ts";
import { generateDeviceId, generateDeviceToken } from "../core/pairing.ts";
import { cli } from "./mcp-test.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory(paired = true) {
  const root = await mkdtemp(join(tmpdir(), "trew-mcp-token-"));
  roots.push(root);
  if (paired)
    await saveConfig(root, {
      url: "ws://127.0.0.1:1",
      vaultId: "private-vault",
      device: "test",
      deviceId: generateDeviceId(),
      deviceToken: generateDeviceToken(),
    });
  return root;
}
it("issues an independent bearer once and stores only its verified hash at 0600", async () => {
  const root = await directory();
  const issued = await cli("mcp-token", "--dir", root);
  expect(issued.code, issued.err).toBe(0);
  expect(issued.out).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const file = join(root, ".trew/mcp-token.json");
  const text = await readFile(file, "utf8");
  const hash = createHash("sha256").update(issued.out).digest("hex");
  expect(JSON.parse(text)).toEqual({ hash, id: hash.slice(0, 8), issued: expect.any(Number) });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(text).not.toContain(issued.out);
  expect(issued.err).toContain(hash.slice(0, 8));
  expect(issued.err).not.toContain(hash);
  expect(issued.err).not.toContain(issued.out);
});
it("refuses an unpaired directory without creating state", async () => {
  const root = await directory(false);
  const result = await cli("mcp-token", "--dir", root);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("not paired");
  expect(result.out).toBe("");
  expect(await readdir(root)).toEqual([]);
});
it("writes --key-out privately without echoing the key and refuses to overwrite it", async () => {
  const root = await directory();
  const key = join(await directory(false), "key-output");
  const result = await cli("mcp-token", "--dir", root, "--key-out", key);
  expect(result.code, result.err).toBe(0);
  const token = (await readFile(key, "utf8")).trim();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await stat(key)).mode & 0o777).toBe(0o600);
  expect(result.out + result.err).not.toContain(token);
  expect(result.out + result.err).toContain(key);
  const before = await readFile(join(root, ".trew/mcp-token.json"));
  expect((await cli("mcp-token", "--dir", root, "--key-out", key)).code).not.toBe(0);
  expect(await readFile(join(root, ".trew/mcp-token.json"))).toEqual(before);
  expect((await readFile(key, "utf8")).trim()).toBe(token);
});
it.each([false, true])(
  "keeps key output outside the vault, including a root alias (%s)",
  async (alias) => {
    const root = await directory();
    const outside = await directory(false);
    await symlink(root, join(outside, "vault-alias"));
    const key = join(alias ? join(outside, "vault-alias") : root, "agent-key.txt");
    const first = await cli("mcp-token", "--dir", root);
    expect(first.code, first.err).toBe(0);
    const before = await readFile(join(root, ".trew/mcp-token.json"));
    const result = await cli("mcp-token", "--dir", root, "--key-out", key);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("outside the vault");
    await expect(readFile(key)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".trew/mcp-token.json"))).toEqual(before);
  },
);
it("rotates and revokes without taking the running vault owner lock", async () => {
  const root = await directory();
  const { lockVault } = await import("./lock.ts");
  const release = await lockVault(root, "mcp");
  try {
    const first = await cli("mcp-token", "--dir", root);
    const next = await cli("mcp-token", "--dir", root);
    expect(first.code, first.err).toBe(0);
    expect(next.code, next.err).toBe(0);
    expect(next.out).not.toBe(first.out);
    expect((await cli("mcp-token", "--dir", root, "--revoke")).code).toBe(0);
    await expect(readFile(join(root, ".trew/mcp-token.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await release();
  }
});
it("refuses issuance flags during revocation without changing the credential", async () => {
  const root = await directory();
  await writeFile(join(root, ".trew/mcp-token.json"), "existing credential");
  const result = await cli("mcp-token", "--dir", root, "--revoke", "--key-out", join(root, "key"));
  expect(result.code).toBe(2);
  expect(await readFile(join(root, ".trew/mcp-token.json"), "utf8")).toBe("existing credential");
});
