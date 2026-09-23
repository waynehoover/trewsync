/**
 * An agent on a real trewd's MCP endpoint, for the stress suite.
 *
 * The agent side of the crash matrix and the phone races (PLAN.md M5 tasks
 * 9 and 12) is the server's own tools over HTTP, as any MCP client calls
 * them: a write token minted through the running server's control socket,
 * and one stateless `tools/call` per request. What a tool answered is kept
 * byte for byte, because a replayed reply has to be the recorded one.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { removeTree, until, type TestServer } from "../core/test-server.ts";
import { fingerprint } from "./harness.ts";

const run = promisify(execFile);
const GO_DIR = new URL("../../..", import.meta.url).pathname;

/** A tool's result: the envelope exactly as the reply carried it, and its halves. */
export interface ToolReply {
  readonly raw: string;
  readonly isError: boolean;
  readonly trusted: Record<string, unknown>;
  readonly untrusted: Record<string, unknown>;
}

/** A write token on one server, and the calls made with it. */
export class Agent {
  constructor(
    private readonly server: TestServer,
    readonly token: string,
    readonly id: string,
  ) {}

  /**
   * One tools/call. Rejects when no reply came, which is how a killed server
   * answers, and when the endpoint refused the request itself (a revoked
   * token's 401): neither is a tool's result.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    const res = await fetch(`http://127.0.0.1:${this.server.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status}: ${text}`);
    const body = JSON.parse(text) as {
      result?: { isError?: boolean; content: { text: string }[] };
    };
    const raw = body.result?.content[0]?.text;
    if (raw === undefined) throw new Error(`${name}: not a tool result: ${text}`);
    const env = JSON.parse(raw) as {
      trusted: Record<string, unknown>;
      untrusted_content: Record<string, unknown>;
    };
    return {
      raw,
      isError: body.result?.isError === true,
      trusted: env.trusted,
      untrusted: env.untrusted_content,
    };
  }

  /** A call that must succeed. */
  async ok(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    const r = await this.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.raw}`);
    return r;
  }

  /** A note's head: its uid, the epoch the uid belongs to, and its bytes. */
  async read(path: string): Promise<{ uid: number; epoch: string; content: string }> {
    const r = await this.ok("read_note", { path, maxLines: 1000 });
    return {
      uid: r.trusted["uid"] as number,
      epoch: r.trusted["epoch"] as string,
      content: r.untrusted["content"] as string,
    };
  }

  /**
   * A preview, and the arguments of its apply: the same arguments with the
   * changes, head and epoch it reported, as the preview's instructions say.
   */
  async preview(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ apply: Record<string, unknown>; changes: PlannedChange[] }> {
    const p = await this.ok(name, args);
    if (p.trusted["phase"] !== "preview") throw new Error(`${name} did not preview: ${p.raw}`);
    const changes = p.untrusted["changes"] as PlannedChange[];
    return {
      apply: { ...args, changes, head: p.trusted["head"], epoch: p.trusted["epoch"] },
      changes,
    };
  }
}

/** A planned change, as a preview shows it (plan/mcp-tools.md, "Preview and apply"). */
export interface PlannedChange {
  path: string;
  base: number;
  action: "edit" | "move" | "delete";
  to?: string;
  edits: { start: number; end: number; old: string; text: string }[];
}

/**
 * The notes a plan leaves, applied by the test to the notes it was planned
 * over: each change's edits, whose offsets are UTF-16 code units as a
 * JavaScript string's are, and a move's new path. What a write that
 * committed must have written, worked out without the server.
 */
export function applyPlan(
  notes: Record<string, string>,
  changes: PlannedChange[],
): Record<string, string> {
  const out = { ...notes };
  for (const c of changes) {
    const before = out[c.path];
    if (before === undefined)
      throw new Error(`the plan changes ${c.path}, which the test never wrote`);
    let text = before;
    for (const e of [...c.edits].sort((x, y) => y.start - x.start)) {
      if (text.slice(e.start, e.end) !== e.old)
        throw new Error(`${c.path}: the plan's edit is not over ${e.old}`);
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
    }
    switch (c.action) {
      case "edit":
        out[c.path] = text;
        break;
      case "move":
        delete out[c.path];
        out[c.to!] = text;
        break;
      case "delete":
        delete out[c.path];
        break;
    }
  }
  return out;
}

const minted = /Id ([A-Za-z0-9_-]+), fingerprint/;

/** A token minted through the running server, `write` scope unless asked otherwise. */
export async function mint(
  server: TestServer,
  label: string,
  dirs: string[],
  scope: "read" | "write" = "write",
): Promise<Agent> {
  const scratch = await mkdtemp(join(tmpdir(), "trew-agent-"));
  dirs.push(scratch);
  const keyFile = join(scratch, "agent.key");
  const out = await server.cli("mcp-token", "-label", label, "-scope", scope, "-key-out", keyFile);
  const id = minted.exec(out)?.[1];
  if (id === undefined) throw new Error(`trewd mcp-token printed no id: ${out}`);
  return new Agent(server, (await readFile(keyFile, "utf8")).trim(), id);
}

/** An operation as `trewd audit -json` lists it. */
export interface AuditOp {
  id: string;
  tool: string;
  outcome: string;
  idempotencyKey?: string;
  paths: { role: string; path: string; beforeUid: number | null; afterUid: number }[];
}

/** Every operation the store recorded, through the running server. */
export async function audit(server: TestServer): Promise<AuditOp[]> {
  return (JSON.parse(await server.cli("audit", "-json")) as { operations: AuditOp[] }).operations;
}

/**
 * `trewd verify -deep`, which fails for an entry whose every body is not
 * present and matching its name: a dangling entry. `cli` rejects on the
 * command's failure; the count is checked too, because a pass over nothing
 * proves nothing.
 */
export async function verifiedDeep(server: TestServer): Promise<void> {
  const out = await server.cli("verify", "-deep");
  if (!/ 0 faults/.test(out) || /checked 0 entries/.test(out))
    throw new Error(`verify -deep: ${out}`);
}

/** Every note in a device's directory and its bytes, as the person sees them. */
export async function notesIn(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of [...(await fingerprint(dir)).keys()].sort()) {
    out[path] = await readFile(join(dir, path), "utf8");
  }
  return out;
}

/** Writes notes into a device's directory, as an editor would. */
export async function writeNotes(dir: string, notes: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(notes)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

/** The line the crash build writes when a write reaches its seam (cmd/trewd/testseam.go). */
const HELD = "trewd test seam: holding at ";

/**
 * Waits until `count` writes have been held at `point` since the server
 * last started, as its stderr says.
 */
export async function heldAt(server: TestServer, point: string, count = 1): Promise<void> {
  const mark = `${HELD}${point}\n`;
  await until(
    `a write held at the ${point} seam`,
    () => server.stderr.join("").split(mark).length - 1 >= count,
    30_000,
  );
}

let crashBuild: Promise<{ binary: string; dir: string }> | undefined;

/**
 * The crash build of trewd, built once per file: `-tags crashmatrix`,
 * which compiles in the hold TREW_TEST_SEAM arms (cmd/trewd/testseam.go),
 * and which nothing but these tests builds.
 */
export function crashBinary(): Promise<string> {
  crashBuild ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "trew-crash-bin-"));
    const binary = join(dir, "trewd");
    await run("go", ["build", "-tags", "crashmatrix", "-o", binary, "./cmd/trewd"], {
      cwd: GO_DIR,
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    return { binary, dir };
  })();
  return crashBuild.then((b) => b.binary);
}

/** Removes the crash build. */
export async function cleanupCrashBinary(): Promise<void> {
  if (crashBuild) await removeTree((await crashBuild).dir);
  crashBuild = undefined;
}
