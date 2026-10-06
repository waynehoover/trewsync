import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { TestServer, removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";

/** The CLI bundled from source the way the release builds it, into `dir`. */
async function buildCli(dir: string): Promise<string> {
  const bundle = join(dir, "trew.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./bin.ts", import.meta.url))],
    outfile: bundle,
    platform: "node",
    target: "node22",
    format: "esm",
    bundle: true,
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __trewRequire } from "node:module"; const require = __trewRequire(import.meta.url);',
    },
  });
  return bundle;
}

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
  const bundle = await buildCli(buildDir);
  server = new TestServer();
  await server.start();
  const vault = await mkdtemp(join(tmpdir(), "trew-bin-vault-"));
  dirs.push(vault);
  const first = await run(["pair", await server.firstInvite(), "--dir", vault], {
    out: () => {},
    err: () => {},
  });
  expect(first).toBe(0);
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

/**
 * T21. Ctrl-C is the documented way to stop `trew sync --watch`, and SIGTERM
 * is how a service manager stops it. Both killed the process where it stood,
 * so its lock record stayed behind naming a pid that was gone; once something
 * else was given that pid, after a reboot most likely, the vault refused every
 * command. Asked to stop, it now stops the way a finished command does: the
 * connection closes, the pass in flight finishes its writes, the lock is
 * released, and then it ends by the same signal, as it always did.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  it(`a watcher stopped by ${signal} lets the vault go, and still ends by the signal (T21)`, async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const buildDir = await mkdtemp(join(tmpdir(), "trew-bin-signal-"));
    dirs.push(buildDir);
    const bundle = await buildCli(buildDir);
    server = new TestServer();
    await server.start();
    const vault = await mkdtemp(join(tmpdir(), "trew-bin-vault-"));
    dirs.push(vault);
    const paired = await run(["pair", await server.firstInvite(), "--dir", vault], {
      out: () => {},
      err: () => {},
    });
    expect(paired).toBe(0);
    await writeFile(join(vault, "note.md"), "a note\n");

    const child = spawn(process.execPath, [bundle, "sync", "--watch", "--dir", vault], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let stderr = "";
    const watching = new Promise<void>((resolve) => {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.includes("Watching for changes")) resolve();
      });
    });
    child.stdout.resume();
    try {
      await within(watching, "the watcher to settle", 30_000);
      const lock = join(vault, ".trew", "lock");
      expect(JSON.parse(await readFile(lock, "utf8")).pid).toBe(child.pid);
      child.kill(signal);
      const [code, by] = await within(closed, `the watcher to stop on ${signal}`, 30_000);
      await expect(readFile(lock, "utf8"), "the stopped watcher left its lock").rejects.toThrow(
        /ENOENT/,
      );
      // Ended by the signal, so a shell or a service manager reads it the
      // way it read it before.
      expect({ code, by }, stderr).toEqual({ code: null, by: signal });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }, 120_000);
}
