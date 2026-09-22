import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.ts";
import { lockVault } from "./lock.ts";
import { NodeVault, TEMP_MARK } from "./vault.ts";
import { DISPLACED_LOG } from "../core/displaced.ts";
import { TestServer, removeTree } from "../core/test-server.ts";
import { Transport } from "../core/transport.ts";
import { nextTurn, receiveCommitted } from "../core/test-async.ts";

let server: TestServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.cleanup();
  while (dirs.length) await removeTree(dirs.pop()!);
});

async function cli(dir: string, ...args: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await run([...args, "--dir", dir, "--json"], {
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  });
  return { code, text: output.join("\n"), errors: errors.join("\n") };
}

async function setup() {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  server = new TestServer();
  await server.start();
  const dir = await mkdtemp(join(tmpdir(), "telimus-inspection-"));
  dirs.push(dir);
  const init = await cli(dir, "init", server.setup);
  expect(init.code, init.text + init.errors).toBe(0);
  return { dir, key: JSON.parse(init.text).recoveryKey as string };
}

it("preview leaves staging and the recovery ledger untouched while a writer holds the vault", async () => {
  const { dir } = await setup();
  await writeFile(join(dir, "note.md"), "A local note waiting to upload.\n");
  const staging = join(dir, ".telimus", "tmp");
  await mkdir(staging, { recursive: true });
  const temp = join(staging, `${TEMP_MARK}old`);
  await writeFile(temp, "staged download");
  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  await utimes(temp, old, old);
  const ledger = join(dir, ".telimus", DISPLACED_LOG);
  const records =
    JSON.stringify({
      at: ".telimus/tmp/preserved.resolved",
      from: "note.md",
      why: "Previously recovered",
      when: 1,
    }) + "\n";
  await writeFile(ledger, records);
  const before = (await readdir(staging)).sort();
  const release = await lockVault(dir, "telimus sync --watch");
  try {
    const result = await cli(dir, "preview");
    expect(result.code, result.text + result.errors).toBe(0);
    expect(JSON.parse(result.text).counts.upload).toBe(1);
    expect(await readFile(ledger, "utf8"), "preview rewrote the recovery ledger").toBe(records);
    expect((await readdir(staging)).sort(), "preview reaped a staged file").toEqual(before);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("A local note waiting to upload.\n");
  } finally {
    await release();
  }
});

it("repair never schedules ordinary sync when a peer edit arrives while it resends", async () => {
  const { dir, key } = await setup();
  await writeFile(join(dir, "note.md"), "Original text.\n");
  expect((await cli(dir, "sync")).code).toBe(0);
  const peer = await mkdtemp(join(tmpdir(), "telimus-inspection-peer-"));
  dirs.push(peer);
  expect((await cli(peer, "pair", key)).code).toBe(0);
  expect((await cli(peer, "sync")).code).toBe(0);

  const resend = Transport.prototype.resend;
  vi.spyOn(Transport.prototype, "resend").mockImplementationOnce(async function (
    this: Transport,
    names,
    bodyOf,
  ) {
    await writeFile(join(peer, "note.md"), "The peer's newer text.\n");
    expect((await cli(peer, "sync")).code).toBe(0);
    await receiveCommitted(this);
    await nextTurn();
    return resend.call(this, names, bodyOf);
  });
  const list = vi.spyOn(NodeVault.prototype, "list");
  const release = await lockVault(dir, "telimus sync --watch");
  try {
    const result = await cli(dir, "repair");
    expect(result.code, result.text + result.errors).toBe(0);
    const localScans = list.mock.contexts.filter(
      (vault) => (vault as unknown as { root: string }).root === dir,
    );
    expect(localScans, "repair started a sync pass without holding the writer lock").toHaveLength(
      0,
    );
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("Original text.\n");
  } finally {
    await release();
  }
});
