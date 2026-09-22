import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticateMcp, readMcpToken } from "./mcp-token.ts";
import { saveConfig } from "./config.ts";
import { NodeVault, writeDurably } from "./vault.ts";
import { McpReader } from "./mcp-read.ts";
import { cli } from "./mcp-test.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("./vault.ts", async (original) => {
  const actual = await original<typeof import("./vault.ts")>();
  return { ...actual, writeDurably: vi.fn(actual.writeDurably) };
});
let root: string;
let token: string;
let path: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "telimus-mcp-auth-"));
  await saveConfig(root, {
    url: "ws://127.0.0.1:1",
    vaultId: "default",
    device: "test",
    secret: new Uint8Array(32).fill(7),
  });
  path = join(root, ".telimus/mcp-token.json");
  const issued = await cli("mcp-token", "--dir", root);
  expect(issued.code, issued.err).toBe(0);
  token = issued.out;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await rm(root, { recursive: true, force: true });
});

it.each([
  undefined,
  "",
  "Basic abc",
  "Bearer " + "a".repeat(42),
  "Bearer " + "a".repeat(44),
  "Bearer " + "!".repeat(43),
])("refuses malformed authorization before reading credential state (%s)", async (header) => {
  vi.mocked(open).mockClear();
  await expect(authenticateMcp(root, header)).rejects.toMatchObject({
    status: 401,
    message: "unauthorized",
  });
  expect(open).not.toHaveBeenCalled();
});
it("rejects a well-formed wrong token and rechecks the hash after rotation and revocation", async () => {
  const before = await authenticateMcp(root, `Bearer ${token}`);
  expect(before.hash).toBe(createHash("sha256").update(token).digest("hex"));
  await expect(authenticateMcp(root, "Bearer " + "a".repeat(43))).rejects.toMatchObject({
    status: 401,
  });
  const rotated = await cli("mcp-token", "--dir", root);
  expect(rotated.code, rotated.err).toBe(0);
  await expect(authenticateMcp(root, `Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
  expect((await authenticateMcp(root, `Bearer ${rotated.out}`)).hash).not.toBe(before.hash);
  expect((await cli("mcp-token", "--dir", root, "--revoke")).code).toBe(0);
  await expect(authenticateMcp(root, `Bearer ${rotated.out}`)).rejects.toMatchObject({
    status: 401,
  });
});
it.each(["not json", "null", "[]", '{"hash":"short","id":"short","issued":1}', " ".repeat(1025)])(
  "refuses malformed or oversized credential state (%#)",
  async (content) => {
    await writeFile(path, content);
    await expect(authenticateMcp(root, `Bearer ${token}`)).rejects.toMatchObject({
      status: 503,
      message: "unavailable",
    });
  },
);
it.each(["EACCES", "EIO"])("refuses %s without exposing file details", async (code) => {
  vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error(`${path}: ${token}`), { code }));
  await expect(authenticateMcp(root, `Bearer ${token}`)).rejects.toMatchObject({
    status: 503,
    message: "unavailable",
  });
});
it("keeps the credential outside note reads by name, leaf alias and ancestor alias", async () => {
  await symlink(path, join(root, "credential.md"));
  await symlink(join(root, ".telimus"), join(root, "public"));
  await symlink(path, join(root, ".telimus/alias.md"));
  const reader = new McpReader(new NodeVault(root, { observeOnly: true }));
  for (const name of [".telimus/alias.md", "credential.md", "public/alias.md"])
    await expect(reader.read({ path: name })).rejects.toThrow(/excluded|link/);
  expect((await reader.list({})).entries).toEqual([]);
});
it.each(["leaf", "state"])("does not read a credential through a %s symlink", async (kind) => {
  if (kind === "leaf") {
    await rename(path, join(root, "saved"));
    await symlink(join(root, "saved"), path);
  } else {
    await rename(join(root, ".telimus"), join(root, "saved"));
    await symlink(join(root, "saved"), join(root, ".telimus"));
  }
  await expect(readMcpToken(root)).rejects.toMatchObject({ status: 503 });
});
it("does not issue or rotate through staging outside the vault", async () => {
  const outside = await mkdtemp(join(tmpdir(), "telimus-mcp-stage-"));
  try {
    const before = await readFile(path);
    await rm(join(root, ".telimus/tmp"), { recursive: true, force: true });
    await symlink(outside, join(root, ".telimus/tmp"));
    const result = await cli("mcp-token", "--dir", root);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it("prints no credential after a durable-write failure", async () => {
  const before = await readFile(path);
  vi.mocked(writeDurably).mockRejectedValueOnce(new Error("injected credential flush failure"));
  const result = await cli("mcp-token", "--dir", root);
  expect(result.code).not.toBe(0);
  expect(result.out).toBe("");
  expect(await readFile(path)).toEqual(before);
});
it("keeps the old credential when flushing the staged hash fails", async () => {
  const before = await readFile(path);
  const actualOpen = vi.mocked(open).getMockImplementation()!;
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle = await actualOpen(...args);
    vi.spyOn(handle, "sync").mockRejectedValueOnce(
      Object.assign(new Error("injected staged flush failure"), { code: "EIO" }),
    );
    return handle;
  });
  const result = await cli("mcp-token", "--dir", root);
  expect(result.code).not.toBe(0);
  expect(result.out).toBe("");
  expect(await readFile(path)).toEqual(before);
});
it("prints no credential if flushing its published directory fails", async () => {
  const actualOpen = vi.mocked(open).getMockImplementation()!;
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await actualOpen(...args);
    if (String(args[0]) === join(root, ".telimus"))
      vi.spyOn(handle, "sync").mockRejectedValueOnce(
        Object.assign(new Error("injected directory flush failure"), { code: "EIO" }),
      );
    return handle;
  });
  const result = await cli("mcp-token", "--dir", root);
  expect(result.code).not.toBe(0);
  expect(result.out).toBe("");
});
it("reads the published credential back before printing it", async () => {
  const write = vi.mocked(writeDurably).getMockImplementation()!;
  vi.mocked(writeDurably).mockImplementationOnce(async (...args) => {
    await write(...args);
    await writeFile(path, "corrupt published credential");
  });
  const result = await cli("mcp-token", "--dir", root);
  expect(result.code).not.toBe(0);
  expect(result.out).toBe("");
  expect(result.err).not.toContain("corrupt published credential");
});
it("does not print or accept a credential path that became a directory", async () => {
  await rm(path);
  await mkdir(path);
  const issued = await cli("mcp-token", "--dir", root);
  expect(issued.code).not.toBe(0);
  expect(issued.out).toBe("");
  await expect(readMcpToken(root)).rejects.toMatchObject({ status: 503 });
});
