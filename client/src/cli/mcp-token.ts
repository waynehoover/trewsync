import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Args, Console } from "./cli.ts";
import { loadConfig, STATE_DIR } from "./config.ts";
import { refuseOutsideVaultAt, syncDirectory, writeDurably } from "./vault.ts";

export interface McpTokenRecord {
  hash: string;
  id: string;
  issued: number;
}
export class McpCredentialError extends Error {
  constructor(readonly status: 401 | 503) {
    super(status === 401 ? "unauthorized" : "unavailable");
  }
}
export const mcpTokenPath = (vault: string) => join(vault, STATE_DIR, "mcp-token.json");

async function stateDirectory(vault: string): Promise<void> {
  const info = await lstat(join(vault, STATE_DIR));
  if (!info.isDirectory()) throw new Error("MCP credential state must be a regular directory");
}

export async function readMcpToken(vault: string): Promise<McpTokenRecord> {
  try {
    await stateDirectory(vault);
    const file = await open(
      mcpTokenPath(vault),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024) throw new Error("invalid credential file");
      const buffer = Buffer.alloc(1025);
      let used = 0;
      while (used < buffer.length) {
        const read = await file.read(buffer, used, buffer.length - used, null);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      if (used > 1024) throw new Error("invalid credential file");
      const record: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)),
      );
      if (
        !record ||
        typeof record !== "object" ||
        Object.keys(record).sort().join(",") !== "hash,id,issued" ||
        !("hash" in record) ||
        typeof record.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.hash) ||
        !("id" in record) ||
        record.id !== record.hash.slice(0, 8) ||
        !("issued" in record) ||
        typeof record.issued !== "number" ||
        !Number.isSafeInteger(record.issued) ||
        record.issued < 0
      )
        throw new Error("invalid credential file");
      return record as McpTokenRecord;
    } finally {
      await file.close();
    }
  } catch (error) {
    // A broken credential is not an invitation to open the port (rule 2).
    // Keep filesystem and parser details off the HTTP response and its logs.
    throw new McpCredentialError((error as NodeJS.ErrnoException).code === "ENOENT" ? 401 : 503);
  }
}

export async function authenticateMcp(
  vault: string,
  authorization: string | undefined,
  observed?: (hash: string | undefined) => void,
): Promise<McpTokenRecord> {
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
    throw new McpCredentialError(401);
  let record: McpTokenRecord;
  try {
    record = await readMcpToken(vault);
  } catch (error) {
    if (error instanceof McpCredentialError && error.status === 401) observed?.(undefined);
    throw error;
  }
  // An old key is usually the first request after rotation. Retire its session
  // before refusing it, so queued work cannot outlive an observed revocation.
  observed?.(record.hash);
  const offered = createHash("sha256").update(authorization.slice(7)).digest();
  if (!timingSafeEqual(offered, Buffer.from(record.hash, "hex"))) throw new McpCredentialError(401);
  return record;
}

export async function cmdMcpToken(
  args: Args,
  io: Console,
  writeKeyOut: (path: string, key: string) => Promise<void>,
): Promise<number> {
  if (!(await loadConfig(args.dir))) throw new Error(`${args.dir} is not paired`);
  await stateDirectory(args.dir);
  const file = mcpTokenPath(args.dir);
  await refuseOutsideVaultAt(args.dir, file);
  if (args.mcpRevoke) {
    await rm(file, { force: true });
    await syncDirectory(join(args.dir, STATE_DIR));
    io.err("MCP credential revoked");
    return 0;
  }
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const record: McpTokenRecord = { hash, id: hash.slice(0, 8), issued: Date.now() };
  if (args.keyOut !== undefined) {
    const root = await realpath(args.dir);
    const output = join(await realpath(dirname(resolve(args.keyOut))), basename(args.keyOut));
    const fromRoot = relative(root, output);
    // A credential saved as a note is available to the very agent it admits.
    // Resolve the parent too, so an outside alias cannot publish it in the vault.
    if (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith("../"))
      throw new Error("MCP --key-out must be outside the vault");
    // Claim the output first. An occupied key file must not rotate a working
    // service to a credential the owner never received.
    await writeKeyOut(args.keyOut, token);
    if ((await readFile(args.keyOut, "utf8")) !== `${token}\n`)
      throw new Error("MCP key output could not be verified; credential not rotated");
  }
  const stageIn = join(args.dir, STATE_DIR, "tmp");
  await refuseOutsideVaultAt(args.dir, join(stageIn, "probe"));
  await writeDurably(file, Buffer.from(JSON.stringify(record) + "\n"), true, {
    mode: 0o600,
    stageIn,
  });
  const checked = await readMcpToken(args.dir);
  if (checked.hash !== hash || checked.id !== record.id || checked.issued !== record.issued)
    throw new Error("MCP credential changed during verification; issue a new credential");
  io.err(`MCP credential ${record.id}`);
  if (args.keyOut === undefined) io.out(token);
  else io.out(`MCP credential ${record.id} saved to ${args.keyOut}`);
  return 0;
}
