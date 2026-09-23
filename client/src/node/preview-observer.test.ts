import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Client } from "../core/client.ts";
import { deferred, nextTurn, within } from "../core/test-async.ts";
import { TestServer } from "../core/test-server.ts";
import { MemoryIndexStore } from "../core/vault.ts";
import { NodeVault, STALE_TEMP_MS } from "./vault.ts";

let root: string;
let server: TestServer;
let client: Client;
let writer: NodeVault;
let reader: NodeVault;
const releases: (() => void)[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "trew-preview-observer-")));
  server = new TestServer();
  await server.start();
  writer = new NodeVault(root);
  reader = new NodeVault(root, { observeOnly: true });
  client = new Client({
    vault: writer,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials()),
    vaultId: "default",
    device: "preview",
    inspect: true,
  });
  await client.connect();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await client?.close();
  vi.restoreAllMocks();
  await server?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});

it("uses observed stats without reaping staging or normalizing a note's disk spelling", async () => {
  const nfd = "cafe\u0301.md";
  const stage = join(root, ".trew", "tmp");
  await mkdir(stage, { recursive: true });
  const leftover = join(stage, "replace.abandoned");
  await writeFile(leftover, "a crashed staged write");
  const old = new Date(Date.now() - STALE_TEMP_MS - 60_000);
  await utimes(leftover, old, old);
  await writeFile(join(root, nfd), "not uploaded yet\n");
  const names = await readdir(root);
  const staged = await readdir(stage);
  const observed = await reader.list({ forceFull: true, checked: true });
  const listing = vi.spyOn(writer, "list");

  const preview = await client.preview(observed);

  expect.soft(preview.files).toEqual([{ path: nfd.normalize("NFC"), action: "upload" }]);
  expect.soft(await readdir(stage), "preview removed a staged file").toEqual(staged);
  expect.soft(await readdir(root), "preview changed a filename").toEqual(names);
  expect.soft(writer.reaped).toBe(0);
  expect(listing).not.toHaveBeenCalled();
  expect(await readFile(leftover, "utf8")).toBe("a crashed staged write");
  expect(await readFile(join(root, nfd), "utf8")).toBe("not uploaded yet\n");
});

it("honors an empty observed inventory instead of falling back to the writer's files", async () => {
  await writeFile(join(root, "unobserved.md"), "not in this estimate\n");
  const listing = vi.spyOn(writer, "list");

  const preview = await client.preview([]);

  expect.soft(preview.files).toEqual([]);
  expect(listing).not.toHaveBeenCalled();
});

it("keeps observed previews behind the client's current serial operation", async () => {
  const entered = deferred();
  const release = deferred();
  releases.push(() => release.resolve());
  const list = writer.list.bind(writer);
  vi.spyOn(writer, "list").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return list();
  });
  const estimate = vi.spyOn(client.engine, "preview");
  const first = client.preview();
  await within(entered.promise, "the first preview to enter the adapter");
  const second = client.preview([]);
  await nextTurn();
  expect(estimate).toHaveBeenCalledTimes(1);
  release.resolve();
  await first;
  expect((await second).files).toEqual([]);
  expect(estimate).toHaveBeenCalledTimes(2);
  expect(estimate).toHaveBeenLastCalledWith([]);
});
