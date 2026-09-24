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
 * The copy is named after the author of the bytes it holds, which is the
 * agent (decided 2026-09-23): `note (Conflicted copy Claude on Mac <stamp>).md`,
 * where it used to carry the phone's name, the device that kept it. A label is
 * whatever the operator typed, so one with characters a filename cannot hold
 * and one longer than a copy's name carries are driven through the same
 * phone, on a real disk, and each copy is read back from the server by its
 * name, which proves the server took that name too.
 *
 * Against the real server with `-mcp`, tokens minted through its control
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

/** A write token with this label, minted through the server's control socket. */
async function mint(label: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "trew-agent-"));
  dirs.push(scratch);
  const keyFile = join(scratch, "agent.key");
  await server!.cli("mcp-token", "-label", label, "-scope", "write", "-key-out", keyFile);
  return (await readFile(keyFile, "utf8")).trim();
}

/**
 * Each note, the label of the agent that edits it, and the author its copy is
 * named after: the label as given, one with a slash and a colon made safe,
 * and one cut to the 32 characters a copy's name carries.
 */
const agents = [
  { path: "note.md", label: "Claude on Mac", author: "Claude on Mac" },
  { path: "slash.md", label: "Claude/Mac: work", author: "Claude-Mac- work" },
  {
    path: "long.md",
    label: "Claude on the office Mac mini, the one by the window",
    author: "Claude on the office Mac mini, t",
  },
];

describe("an agent's edit on a device", () => {
  it("keeps the agent's edit beside the phone's, named after the agent", async () => {
    server = new TestServer();
    server.extraArgs = ["-mcp"];
    await server.start();
    const tokens = new Map<string, string>();
    for (const a of agents) tokens.set(a.path, await mint(a.label));

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
    for (const a of agents) await writeFile(join(dir, a.path), original);
    const first = phone();
    await first.connect();
    await first.settle({}, 8);
    first.close();

    // The phone is offline. Each agent reads its note and changes the
    // sentence; the phone changes the same sentence another way.
    const agentsText = "# Note\n\nThe agent's rewritten sentence.\n";
    const phones = "# Note\n\nThe phone's own sentence.\n";
    for (const a of agents) {
      const token = tokens.get(a.path)!;
      const read = await tool(token, "read_note", { path: a.path });
      expect(read.untrusted["content"]).toBe(original);
      await tool(token, "edit_note", {
        path: a.path,
        base: read.trusted["uid"],
        epoch: read.trusted["epoch"],
        edits: [{ old: "The original sentence.", new: "The agent's rewritten sentence." }],
      });
      await writeFile(join(dir, a.path), phones);
    }

    const again = phone();
    await again.connect();
    await again.settle({}, 8);

    const names = await readdir(dir);
    const copies = names.filter((n) => n.includes("Conflicted copy"));
    expect(copies, names.join(", ")).toHaveLength(agents.length);
    for (const a of agents) {
      const stem = a.path.slice(0, -".md".length);
      const copy = copies.find((n) => n.startsWith(`${stem} (`));
      expect(copy, `no copy of ${a.path} in ${names.join(", ")}`).toBeDefined();
      // Named after the agent, whose words are in it, and not the phone.
      const named = /^(.+) \(Conflicted copy (.+) \d{12}\)\.md$/.exec(copy!);
      expect(named?.[1], copy).toBe(stem);
      expect(named?.[2], copy).toBe(a.author);
      // Both texts survive, the phone's where it was and the agent's in the
      // copy (rule 10: the bytes, not agreement).
      expect(await readFile(join(dir, a.path), "utf8")).toBe(phones);
      expect(await readFile(join(dir, copy!), "utf8")).toBe(agentsText);
      // And the phone uploaded it: the server took the name and holds the
      // agent's bytes under it.
      expect(await server.cli("cat", "-path", copy!)).toBe(agentsText);
    }

    // The server's history names the agent by its label, beside the phone's
    // two versions.
    const history = await tool(tokens.get("note.md")!, "note_history", { path: "note.md" });
    const devices = (history.untrusted["versions"] as { device: string }[]).map((v) => v.device);
    expect(devices).toEqual(["phone", "Claude on Mac", "phone"]);
  }, 120_000);
});
