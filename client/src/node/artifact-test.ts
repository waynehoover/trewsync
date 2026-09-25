/**
 * The shipped `trew.mjs`, run on its own, pairing and syncing both ways.
 *
 * Used by `artifact.test.ts`, on a fresh production build copied into an empty
 * directory, and by `scripts/pack-check.sh`, on the file the npm tarball
 * installs. The artifact is given nothing of this repository: on macOS it runs
 * under sandbox-exec with the repository denied, with an empty `NODE_PATH`, so
 * a dependency that did not bundle fails here instead of on somebody's
 * machine. This was the non-MCP half of the retired `mcp-artifact-test.ts`
 * (docs/development.md, "Retiring trew mcp").
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TestServer, removeTree } from "../core/test-server.ts";
import { run } from "./cli.ts";

const exec = promisify(execFile);

/** One in-process CLI run, for the second device, which is not under test. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [],
    err: string[] = [];
  const code = await run(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

export async function smokeArtifact(
  artifact: string,
  runtime: string,
  denyRead?: string,
): Promise<{ syncMs: number }> {
  const server = new TestServer();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "trew-artifact-")));
  const shipped = join(scratch, "shipped");
  const other = join(scratch, "other");
  let prefix: string[] = [runtime];
  if (denyRead && process.platform === "darwin") {
    const profile = join(scratch, "sandbox.sb");
    await writeFile(
      profile,
      `(version 1)\n(allow default)\n(deny file-read* (subpath ${JSON.stringify(denyRead)}))\n`,
    );
    prefix = ["/usr/bin/sandbox-exec", "-f", profile, runtime];
  }
  const artifactRun = async (...argv: string[]) => {
    try {
      const { stdout } = await exec(prefix[0]!, [...prefix.slice(1), artifact, ...argv], {
        cwd: scratch,
        env: { PATH: process.env.PATH ?? "", NODE_PATH: "", HOME: scratch },
        timeout: 60_000,
      });
      return stdout;
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      throw new Error(
        `the artifact failed on ${argv[0]}: ${String(error)}\n${failed.stdout ?? ""}\n${failed.stderr ?? ""}`,
      );
    }
  };
  try {
    await server.start();
    // A byte-order mark, frontmatter, CRLF and LF in one note, so a bundle
    // that mangled any of them on the way up or down is caught here.
    const bom = String.fromCharCode(0xfeff);
    const original = `${bom}---\r\ntags: [artifact]\r\n---\r\nUNSENT ARTIFACT MARKER\r\n- [ ] exact task\n`;
    await mkdir(shipped);
    await mkdir(other);
    await writeFile(join(shipped, "note.md"), original);

    // The shipped file pairs from the first invite and uploads.
    await artifactRun("pair", await server.firstInvite(), "--dir", shipped, "--device", "shipped");
    const started = performance.now();
    await artifactRun("sync", "--dir", shipped);
    const syncMs = Math.round((performance.now() - started) * 10) / 10;

    // A second device, from an invite the shipped file mints over the wire,
    // receives exactly the bytes the shipped file sent.
    const invite = JSON.parse(await artifactRun("invite", "--dir", shipped, "--json")) as {
      invite: string;
    };
    const paired = await cli("pair", invite.invite, "--dir", other, "--device", "other");
    assert.equal(paired.code, 0, paired.err);
    const first = await cli("sync", "--dir", other);
    assert.equal(first.code, 0, first.err);
    assert.equal(await readFile(join(other, "note.md"), "utf8"), original);

    // And the shipped file downloads what the other device changed.
    const edited = original.replace("[ ]", "[x]");
    await writeFile(join(other, "note.md"), edited);
    const second = await cli("sync", "--dir", other);
    assert.equal(second.code, 0, second.err);
    await artifactRun("sync", "--dir", shipped);
    assert.equal(await readFile(join(shipped, "note.md"), "utf8"), edited);

    // Exit 0, or `artifactRun` throws: in step with the server, nothing waiting.
    await artifactRun("status", "--dir", shipped);
    return { syncMs };
  } finally {
    try {
      await server.cleanup();
    } finally {
      await removeTree(scratch);
    }
  }
}
