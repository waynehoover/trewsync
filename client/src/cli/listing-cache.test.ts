import { EventEmitter } from "node:events";
import {
  access,
  mkdtemp,
  mkdir,
  rename,
  rm,
  stat,
  lstat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JsonIndexStore, NodeVault, TEMP_MARK } from "./vault.ts";
import { Client } from "../core/client.ts";
import { TestServer } from "../core/test-server.ts";
import { testWrapped } from "../core/test-keys.ts";
import { deferred, receiveCommitted, within } from "../core/test-async.ts";

const watching = vi.hoisted(() => ({
  notify: undefined as ((event: string, filename: string | null) => void) | undefined,
  watcher: undefined as EventEmitter | undefined,
}));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    watch: (_root: string, _options: unknown, notify: typeof watching.notify) => {
      watching.notify = notify;
      const watcher = new EventEmitter();
      watching.watcher = watcher;
      return Object.assign(watcher, { close: () => watcher.emit("close") });
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, access: vi.fn(fs.access), stat: vi.fn(fs.stat), lstat: vi.fn(fs.lstat) };
});

let root: string;
let stop: (() => void) | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "telimus-list-cache-"));
  await mkdir(join(root, "notes"));
  await Promise.all(
    ["one.md", "two.md", "three.md"].map((name) => writeFile(join(root, "notes", name), name)),
  );
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function watched() {
  const vault = new NodeVault(root);
  stop = vault.watch(() => {});
  await vault.list();
  vi.mocked(stat).mockClear();
  vi.mocked(lstat).mockClear();
  return vault;
}

it("refreshes only the edited file between authoritative scans", async () => {
  const vault = await watched();
  await writeFile(join(root, "notes/one.md"), "the edited note");
  watching.notify!("change", "notes/one.md");
  const listed = await vault.list();
  expect(listed.find((entry) => entry.path === "notes/one.md")?.size).toBe(15);
  expect(vi.mocked(stat).mock.calls).toHaveLength(0);
  expect(vi.mocked(lstat).mock.calls.filter(([path]) => String(path).endsWith(".md"))).toHaveLength(
    1,
  );
  vi.mocked(lstat).mockClear();
  await vault.list();
  expect(vi.mocked(stat).mock.calls).toHaveLength(0);
  expect(vi.mocked(lstat).mock.calls.filter(([path]) => String(path).endsWith(".md"))).toHaveLength(
    0,
  );
});

it("fully scans without a watcher and after it stops", async () => {
  const vault = new NodeVault(root);
  await vault.list();
  await writeFile(join(root, "new.md"), "new");
  expect((await vault.list()).map((entry) => entry.path)).toContain("new.md");
  stop = vault.watch(() => {});
  await vault.list();
  stop();
  await writeFile(join(root, "after-stop.md"), "after");
  expect((await vault.list()).map((entry) => entry.path)).toContain("after-stop.md");
});

it("recovers missed events on forced and periodic full scans", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const vault = await watched();
  await writeFile(join(root, "missed.md"), "one");
  expect((await vault.list({ forceFull: true })).map((entry) => entry.path)).toContain("missed.md");
  await writeFile(join(root, "another.md"), "two");
  now.mockReturnValue(130_001);
  expect((await vault.list()).map((entry) => entry.path)).toContain("another.md");
});

it.each(["rename", "missing filename", "watcher error", "watcher close"])(
  "fully scans after %s",
  async (event) => {
    const vault = await watched();
    await rename(join(root, "notes"), join(root, "moved"));
    if (event === "watcher error") watching.watcher!.emit("error", new Error("watch failed"));
    else if (event === "watcher close") watching.watcher!.emit("close");
    else
      watching.notify!(
        event === "rename" ? "rename" : "change",
        event === "rename" ? "notes" : null,
      );
    const paths = (await vault.list()).map((entry) => entry.path);
    expect(paths).toContain("moved/one.md");
    expect(paths).not.toContain("notes/one.md");
  },
);

it("does not treat an unreadable changed file as deleted", async () => {
  const vault = await watched();
  watching.notify!("change", "notes/one.md");
  vi.mocked(lstat).mockRejectedValueOnce(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
  );
  await expect(vault.list()).rejects.toThrow("permission denied");
  expect((await vault.list()).map((entry) => entry.path)).toContain("notes/one.md");
});

it("refreshes a structural change reported as a content event", async () => {
  const vault = await watched();
  await rm(join(root, "notes/one.md"));
  watching.notify!("change", "notes/one.md");
  expect((await vault.list()).map((entry) => entry.path)).not.toContain("notes/one.md");
  await writeFile(join(root, "new.md"), "new");
  watching.notify!("change", "new.md");
  expect((await vault.list()).map((entry) => entry.path)).toContain("new.md");
});

it("invalidates cached listings for adapter writes without waiting for watcher delivery", async () => {
  const vault = await watched();
  await vault.write("adapter.md", new TextEncoder().encode("saved"), {
    mtime: Date.now(),
    ctime: Date.now(),
  });
  expect((await vault.list()).find((entry) => entry.path === "adapter.md")?.size).toBe(5);
});

it("retains an edit delivered while its previous stat is in flight", async () => {
  const vault = await watched();
  const captured = deferred();
  const release = deferred();
  const actual = vi.mocked(lstat).getMockImplementation()!;
  vi.mocked(lstat).mockImplementationOnce(async (...args) => {
    const result = await actual(...args);
    captured.resolve();
    await release.promise;
    return result;
  });
  watching.notify!("change", "notes/one.md");
  const listing = vault.list();
  await captured.promise;
  await writeFile(join(root, "notes/one.md"), "a newer edit during the stat");
  watching.notify!("change", "notes/one.md");
  release.resolve();
  await listing;
  expect((await vault.list()).find((entry) => entry.path === "notes/one.md")?.size).toBe(28);
});

it("falls back if a directory moves during a cached stat", async () => {
  const vault = await watched();
  const actual = vi.mocked(lstat).getMockImplementation()!;
  vi.mocked(lstat).mockImplementationOnce(async (...args) => {
    const result = await actual(...args);
    await rename(join(root, "notes"), join(root, "moved"));
    watching.notify!("rename", "notes");
    return result;
  });
  watching.notify!("change", "notes/one.md");
  const paths = (await vault.list()).map((entry) => entry.path);
  expect(paths).toContain("moved/one.md");
  expect(paths).not.toContain("notes/one.md");
});

it("keeps unrecorded preserved versions in every recovery inventory", async () => {
  const vault = await watched();
  const parked = `notes/one.md${TEMP_MARK}keep-test`;
  await writeFile(join(root, parked), "preserved original");
  watching.notify!("rename", parked);
  await vault.list();
  expect(vault.stranded).toContain(parked);
  await vault.list();
  expect(vault.stranded).toContain(parked);
  await rm(join(root, parked));
  await vault.list();
  expect(vault.stranded).not.toContain(parked);
});

it("keeps observe-only inventories authoritative even with a watcher", async () => {
  const vault = new NodeVault(root, { observeOnly: true });
  stop = vault.watch(() => {});
  await vault.list();
  await writeFile(join(root, "missed.md"), "unreported event");
  expect((await vault.list()).map((entry) => entry.path)).toContain("missed.md");
});

it("reports a child beneath a file as absent without hiding access errors", async () => {
  const vault = new NodeVault(root);
  await writeFile(join(root, "parent"), "This parent is a file.");
  await expect(vault.exists("parent/child.md")).resolves.toBe(false);
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  vi.mocked(access).mockRejectedValueOnce(denied);
  await expect(vault.exists("notes/one.md")).rejects.toBe(denied);
});

it("does not retry an old deletion after a restored note's watcher event is missed", async () => {
  const server = new TestServer();
  let client: Client | undefined;
  try {
    await server.start();
    const vault = new NodeVault(root);
    const secret = new Uint8Array(32).fill(91);
    client = new Client({
      vault,
      store: new JsonIndexStore(join(root, ".telimus/index.json")),
      url: server.wsUrl,
      ...(await server.deviceCredentials(secret, await testWrapped(secret), "writer")),
      vaultId: "default",
      device: "writer",
      coalesceWrites: false,
      inspect: true,
    });
    await client.connect();
    // Disable Client's automatic passes, then exercise the real engine
    // explicitly. Otherwise a background pass can consume the injected
    // failure before the pass whose report this test asserts.
    const engine = client.engine;
    await engine.sync({ coalesceWrites: false });
    await receiveCommitted(client.transport);
    const notified = deferred();
    stop = vault.watch((path) => {
      client!.noteChanged(path);
      notified.resolve();
    });
    await vault.list();
    const path = "notes/one.md";
    await rm(join(root, path));
    watching.notify!("rename", path);
    // Deliver the original event before injecting the failure. A late dirty
    // event would legitimately make the engine retry inside that first call.
    await within(notified.promise, "the original deletion watcher event");
    vi.spyOn(client.transport, "putMany").mockRejectedValueOnce(
      new Error("temporarily unavailable"),
    );
    const failed = await engine.sync({ coalesceWrites: false });
    expect(failed.retrying).toBe(1);
    expect(failed.deletedRemotely).toBe(0);

    const restored = "Restored before the retry, with a new paragraph.\n";
    await writeFile(join(root, path), restored);
    // No watcher notification for the restore. Retry becomes due before the
    // authoritative listing's 30-second deadline.
    vi.spyOn(Date, "now").mockReturnValue(failed.nextUploadAt!);
    const retried = await engine.sync({ coalesceWrites: false });
    expect(retried.deletedRemotely).toBe(0);
    const versions = await client.history(path);
    expect(versions.every((version) => !version.deleted)).toBe(true);
    expect(new TextDecoder().decode(await client.contentAt(versions[0]!))).toBe(restored);
    expect(new TextDecoder().decode(await vault.read(path))).toBe(restored);
  } finally {
    stop?.();
    stop = undefined;
    await client?.close();
    await server.cleanup();
  }
});

it.each([false, true])(
  "keeps previously synced ignored files without blocking unrelated edits (restored path forces rescan: %s)",
  async (restoreMissed) => {
    const server = new TestServer();
    let client: Client | undefined;
    try {
      await writeFile(join(root, "a-restored.md"), "Original restored note\n");
      await writeFile(join(root, "public.md"), "Original public note\n");
      await server.start();
      const secret = new Uint8Array(32).fill(163);
      const opts = {
        url: server.wsUrl,
        vaultId: "default",
        device: "writer",
        ...(await server.deviceCredentials(secret, await testWrapped(secret), "writer")),
        coalesceWrites: false,
        inspect: true,
      };
      const store = () => new JsonIndexStore(join(root, ".telimus/index.json"));
      client = new Client({ ...opts, vault: new NodeVault(root), store: store() });
      await client.connect();
      await client.settle();
      await client.close();

      const vault = new NodeVault(root, { alsoIgnore: ["notes"] });
      client = new Client({ ...opts, vault, store: store() });
      await client.connect();
      await writeFile(join(root, "public.md"), "Unrelated edit still uploads\n");
      if (restoreMissed) {
        stop = vault.watch(() => {});
        await rm(join(root, "a-restored.md"));
        await vault.list();
        await writeFile(join(root, "a-restored.md"), "Restored without a watcher notification\n");
      }
      const report = await client.settle();
      expect(report.deletedRemotely).toBe(0);
      expect(report.ignored).toBeGreaterThan(0);
      const latest = async (path: string) => {
        const versions = await client!.history(path);
        expect(versions.every((version) => !version.deleted)).toBe(true);
        return new TextDecoder().decode(await client!.contentAt(versions[0]!));
      };
      expect(await latest("public.md")).toBe("Unrelated edit still uploads\n");
      expect(await latest("notes/one.md")).toBe("one.md");
      expect(new TextDecoder().decode(await vault.read("public.md"))).toBe(
        "Unrelated edit still uploads\n",
      );
      expect(await latest("a-restored.md")).toBe(
        restoreMissed ? "Restored without a watcher notification\n" : "Original restored note\n",
      );
      // Ignore affects this device's sync scope, not the files it already has.
      expect(await readFile(join(root, "notes/one.md"), "utf8")).toBe("one.md");
    } finally {
      stop?.();
      stop = undefined;
      await client?.close();
      await server.cleanup();
    }
  },
);

it("still aborts reconciliation when an omitted synced path cannot be checked", async () => {
  const server = new TestServer();
  let client: Client | undefined;
  try {
    await server.start();
    const vault = new NodeVault(root);
    const secret = new Uint8Array(32).fill(164);
    client = new Client({
      vault,
      store: new JsonIndexStore(join(root, ".telimus/index.json")),
      url: server.wsUrl,
      vaultId: "default",
      device: "writer",
      ...(await server.deviceCredentials(secret, await testWrapped(secret), "writer")),
      coalesceWrites: false,
      inspect: true,
    });
    await client.connect();
    await client.settle();
    await rm(join(root, "notes/one.md"));
    await writeFile(join(root, "notes/two.md"), "Edit must survive an unreadable presence check");
    const denied = Object.assign(new Error("presence is unreadable"), { code: "EACCES" });
    vi.spyOn(vault, "exists").mockRejectedValueOnce(denied);
    await expect(client.settle()).rejects.toBe(denied);
    const versions = await client.history("notes/one.md");
    expect(versions.every((version) => !version.deleted)).toBe(true);
    expect(new TextDecoder().decode(await client.contentAt(versions[0]!))).toBe("one.md");
    expect(await readFile(join(root, "notes/two.md"), "utf8")).toBe(
      "Edit must survive an unreadable presence check",
    );
  } finally {
    await client?.close();
    await server.cleanup();
  }
});
