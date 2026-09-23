import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcp } from "./mcp-test.ts";
import { run } from "./cli.ts";
import { TestServer, removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";

let server: TestServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.cleanup();
  while (dirs.length) await removeTree(dirs.pop()!);
});

it("the packaged entrypoint flushes a large JSON preview before exiting through a pipe", async () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const buildDir = await mkdtemp(join(tmpdir(), "trew-bin-output-"));
  dirs.push(buildDir);
  const bundle = await buildMcp(buildDir);
  server = new TestServer();
  await server.start();
  const vault = await mkdtemp(join(tmpdir(), "trew-bin-vault-"));
  dirs.push(vault);
  const init = await run(["init", server.setup, "--dir", vault], { out: () => {}, err: () => {} });
  expect(init).toBe(0);
  const count = 1500;
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      writeFile(join(vault, `${String(i).padStart(4, "0")}-${"long-note-name".repeat(15)}.md`), ""),
    ),
  );
  const child = spawn(process.execPath, [bundle, "preview", "--dir", vault, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const chunks: Buffer[] = [];
  try {
    // Keep the pipe paused until output exists, exercising real backpressure
    // rather than an in-process Console that accepts every byte synchronously.
    await within(once(child.stdout, "readable"), "preview output", 15000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdout.resume();
    const [code] = await within(closed, "CLI exit", 15000);
    expect(code, Buffer.concat(errors).toString("utf8")).toBe(0);
    const text = Buffer.concat(chunks).toString("utf8");
    let preview: { files: unknown[]; counts: { upload: number } } | undefined;
    expect(() => {
      preview = JSON.parse(text);
    }, `CLI returned only ${text.length} output bytes`).not.toThrow();
    expect(preview!.files).toHaveLength(count);
    expect(preview!.counts.upload).toBe(count);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});
