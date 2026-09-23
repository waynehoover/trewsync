/**
 * An agent's write, seen from a device (PLAN.md M5 task 8).
 *
 * The server's MCP tools write versions whose device name is the token's
 * label, and to a device an agent's edit is an ordinary remote version
 * (PLAN.md section 4.6). So when a phone edited the same sentence while it was
 * offline, its engine keeps both: the phone's own words stay where they are,
 * and the agent's go beside them in a conflict copy, byte for byte. The
 * server's history names the agent by its label.
 *
 * The copy's name is the engine's convention, and that convention names it
 * after the device that kept it, not after the author of what is in it
 * (`conflictCopyPath(path, this.opts.device, ...)`, and plugin/main.test.ts:
 * "b has to keep both and name the copy after itself"). PLAN.md section 2.4
 * expected `(Conflicted copy Claude on Mac ...)`; that needs the engine to
 * carry the incoming version's device into its remote state, a change to the
 * plugin's naming for every conflict, which is the owner's to decide. The
 * name is pinned here as it is, so that a change to it is a decision someone
 * sees.
 *
 * Against the real server with `-mcp`, a token minted through its control
 * socket, and the agent's calls made over HTTP as any MCP client makes them.
 */

import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => await cleanupBinary());

let server: TestServer | undefined;
const open: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (open.length) open.pop()!.close();
  while (dirs.length) await removeTree(dirs.pop()!);
  await server?.cleanup();
  server = undefined;
});

/** One MCP tool call, stateless at 2025-11-25, and its envelope. */
async function tool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ trusted: Record<string, unknown>; untrusted: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server!.port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: {
      isError?: boolean;
      structuredContent: {
        trusted: Record<string, unknown>;
        untrusted_content: Record<string, unknown>;
      };
    };
  };
  const env = body.result.structuredContent;
  expect(body.result.isError, JSON.stringify(env)).toBeFalsy();
  return { trusted: env.trusted, untrusted: env.untrusted_content };
}

describe("an agent's edit on a device", () => {
  it("keeps the agent's edit beside the phone's, and the history names the agent", async () => {
    server = new TestServer();
    server.extraArgs = ["-mcp"];
    await server.start();
    const scratch = await mkdtemp(join(tmpdir(), "trew-agent-"));
    dirs.push(scratch);
    const keyFile = join(scratch, "agent.key");
    await server.cli(
      "mcp-token",
      "-label",
      "Claude on Mac",
      "-scope",
      "write",
      "-key-out",
      keyFile,
    );
    const token = (await readFile(keyFile, "utf8")).trim();

    const dir = await mkdtemp(join(tmpdir(), "trew-phone-"));
    dirs.push(dir);
    const creds = await server.deviceCredentials("phone");
    const phone = () => {
      const c = new Client({
        vault: new NodeVault(dir),
        store: new JsonIndexStore(join(dir, ".trew", "index.json")),
        url: server!.wsUrl,
        ...creds,
        vaultId: "default",
        device: "phone",
        timeoutMs: 20_000,
        coalesceWrites: false,
      });
      open.push(c);
      return c;
    };

    const original = "# Note\n\nThe original sentence.\n";
    await writeFile(join(dir, "note.md"), original);
    const first = phone();
    await first.connect();
    await first.settle({}, 8);
    first.close();

    // The phone is offline. The agent reads the note and changes the
    // sentence; the phone changes the same sentence another way.
    const read = await tool(token, "read_note", { path: "note.md" });
    expect(read.untrusted["content"]).toBe(original);
    const agents = "# Note\n\nThe agent's rewritten sentence.\n";
    await tool(token, "edit_note", {
      path: "note.md",
      base: read.trusted["uid"],
      epoch: read.trusted["epoch"],
      edits: [{ old: "The original sentence.", new: "The agent's rewritten sentence." }],
    });
    const phones = "# Note\n\nThe phone's own sentence.\n";
    await writeFile(join(dir, "note.md"), phones);

    const again = phone();
    await again.connect();
    await again.settle({}, 8);

    const names = await readdir(dir);
    const copies = names.filter((n) => n.includes("Conflicted copy"));
    expect(copies, names.join(", ")).toHaveLength(1);
    // Named after the device that kept it; see the note at the top.
    expect(copies[0]).toMatch(/^note \(Conflicted copy phone \d{12}\)\.md$/);
    // Both texts survive, the phone's where it was and the agent's in the
    // copy (rule 10: the bytes, not agreement).
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe(phones);
    expect(await readFile(join(dir, copies[0]!), "utf8")).toBe(agents);

    // And the server's history names the agent by its label, beside the
    // phone's two versions, and the copy the phone uploaded is the agent's
    // version kept, with the agent's bytes.
    const history = await tool(token, "note_history", { path: "note.md" });
    const devices = (history.untrusted["versions"] as { device: string }[]).map((v) => v.device);
    expect(devices).toEqual(["phone", "Claude on Mac", "phone"]);
    expect(await server.cli("cat", "-path", copies[0]!)).toBe(agents);
  }, 120_000);
});
