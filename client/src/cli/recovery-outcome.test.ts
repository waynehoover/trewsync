import { afterEach, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.ts";
import { DISPLACED_LOG } from "../core/displaced.ts";
import { TestServer, removeTree } from "../core/test-server.ts";

let server: TestServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.cleanup();
  if (dir) await removeTree(dir);
});

async function cli(...args: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await run([...args, "--dir", dir!], {
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  });
  return { code, text: output.join("\n"), errors: errors.join("\n") };
}

it.each([false, true])(
  "a hidden preserved edit keeps sync unsuccessful until recovered (JSON: %s)",
  async (json) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    server = new TestServer();
    await server.start();
    dir = await mkdtemp(join(tmpdir(), "trew-recovery-outcome-"));
    expect((await cli("init", server.setup, "--json")).code).toBe(0);
    await writeFile(join(dir, "note.md"), "Visible agreed version.\n");
    expect((await cli("sync")).code).toBe(0);
    const at = ".trew/tmp/preserved.unsent-edit";
    const text = "Only this hidden version has the unsent edit.\n";
    await mkdir(join(dir, ".trew", "tmp"), { recursive: true });
    await writeFile(join(dir, at), text);
    // The inventory is complete and readable; its unresolved record is the issue.
    await writeFile(
      join(dir, ".trew", DISPLACED_LOG),
      JSON.stringify({
        at,
        from: "note.md",
        why: "The edit could not be placed",
        when: 1,
      }) + "\n",
    );

    expect((await cli("status", "--json")).code).toBe(1);
    const sync = await cli("sync", ...(json ? ["--json"] : []));
    expect(sync.code, sync.text + sync.errors).toBe(1);
    if (json)
      expect(JSON.parse(sync.text)).toMatchObject({
        ok: false,
        outcome: { kind: "recoveryNeeded", paths: [at] },
        stranded: [at],
      });
    else {
      expect(sync.text).toContain("needs recovery");
      expect(sync.text).not.toContain("Everything here matches the server");
    }
    const restored = await cli("restore", "note.md", "--json");
    expect(restored.code).toBe(1);
    expect(JSON.parse(restored.text)).toMatchObject({
      ok: false,
      restored: true,
      sent: true,
      outcome: { kind: "recoveryNeeded", paths: [at] },
    });
    expect(await readFile(join(dir, at), "utf8")).toBe(text);

    await rename(join(dir, at), join(dir, "Recovered edit.md"));
    const recovered = await cli("sync", "--json");
    expect(recovered.code, recovered.text + recovered.errors).toBe(0);
    expect(JSON.parse(recovered.text)).toMatchObject({ ok: true, stranded: [] });
    expect(await readFile(join(dir, "Recovered edit.md"), "utf8")).toBe(text);
  },
);

it.each([false, true])(
  "unreadable staging cannot clear recovery status or discard records (ledger: %s)",
  async (recorded) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    server = new TestServer();
    await server.start();
    dir = await mkdtemp(join(tmpdir(), "trew-recovery-unreadable-"));
    expect((await cli("init", server.setup, "--json")).code).toBe(0);
    await writeFile(join(dir, "note.md"), "Visible agreed version.\n");
    expect((await cli("sync")).code).toBe(0);
    const staging = join(dir, ".trew", "tmp");
    const at = ".trew/tmp/preserved.unsent-edit";
    const text = "Only this hidden version has the unsent edit.\n";
    await mkdir(staging, { recursive: true });
    await writeFile(join(dir, at), text);
    const ledger = join(dir, ".trew", DISPLACED_LOG);
    const record =
      JSON.stringify({ at, from: "note.md", why: "Could not place the edit", when: 1 }) + "\n";
    if (recorded) await writeFile(ledger, record);
    await chmod(staging, 0o000);
    let sync;
    let status;
    try {
      sync = await cli("sync", "--json");
      status = await cli("status", "--json");
    } finally {
      await chmod(staging, 0o700);
    }
    expect(sync.code, sync.text + sync.errors).toBe(1);
    expect(JSON.parse(sync.text)).toMatchObject({
      ok: false,
      outcome: { kind: "recoveryUnknown" },
    });
    expect(status.code, status.text + status.errors).toBe(1);
    expect(JSON.parse(status.text)).toMatchObject({ ok: false, recoveryComplete: false });
    if (recorded)
      expect(await readFile(ledger, "utf8"), "the retained version's record was discarded").toBe(
        record,
      );
    expect(await readFile(join(dir, at), "utf8")).toBe(text);
  },
);
