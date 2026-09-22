import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Client, type ClientOptions } from "./client.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer, serverBinary, cleanupBinary } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";
import { deferred, nextTurn, within } from "./test-async.ts";

const SECRET = new Uint8Array(32).fill(27);
let wrapped: string;
let server: TestServer;
const clients: Client[] = [];
const releases: (() => void)[] = [];
beforeAll(async () => {
  await serverBinary();
  wrapped = await testWrapped(SECRET);
}, 180_000);
afterAll(cleanupBinary);
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  await server?.cleanup();
});
async function ready(extra: Partial<ClientOptions> = {}, settle = true) {
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault();
  const client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(SECRET, wrapped)),
    vaultId: "default",
    device: "agent",
    timeoutMs: 20_000,
    coalesceWrites: false,
    ...extra,
  });
  clients.push(client);
  await client.connect();
  if (settle) await client.settle();
  return { client, vault };
}
async function blockedPass(client: Client, vault: MemoryVault) {
  const entered = deferred();
  const release = deferred();
  releases.push(() => release.resolve());
  const list = vault.list.bind(vault);
  vi.spyOn(vault, "list").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return list();
  });
  const pass = client.sync({ forceFullScan: true });
  await within(entered.promise, "the pass to reach the filesystem");
  return { release, pass };
}
it("starts a local mutation only after the running sync pass", async () => {
  const { client, vault } = await ready();
  const { release, pass } = await blockedPass(client, vault);
  let ran = false;
  const mutation = client.mutateLocal(async () => {
    ran = true;
    return "done";
  });
  await nextTurn();
  expect(ran).toBe(false);
  release.resolve();
  await pass;
  expect(await mutation).toBe("done");
});
it.each(["cancel", "deadline"])("does not run a %s refused request later", async (kind) => {
  const { client, vault } = await ready();
  const { release, pass } = await blockedPass(client, vault);
  const controller = new AbortController();
  let ran = false;
  const mutation = client.mutateLocal(
    async () => {
      ran = true;
    },
    {
      signal: controller.signal,
      waitMs: kind === "deadline" ? 1 : 5000,
    },
  );
  if (kind === "cancel") controller.abort();
  await expect(mutation).rejects.toMatchObject({ code: kind === "cancel" ? "cancelled" : "busy" });
  release.resolve();
  await pass;
  await client.settle();
  expect(ran).toBe(false);
});
it.each(["readOnly", "inspect", "initial", "closed"])(
  "refuses %s before entering the callback",
  async (mode) => {
    const { client } = await ready(
      {
        ...(mode === "readOnly" ? { readOnly: true } : {}),
        ...(mode === "inspect" ? { inspect: true } : {}),
      },
      mode !== "initial" && mode !== "inspect",
    );
    if (mode === "closed") await client.close();
    let ran = false;
    await expect(
      client.mutateLocal(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(ran).toBe(false);
  },
);
it("refuses queued work when closing while draining the admitted write", async () => {
  const { client } = await ready();
  const started = deferred();
  const release = deferred();
  releases.push(() => release.resolve());
  const first = client.mutateLocal(async () => {
    started.resolve();
    await release.promise;
    return "saved";
  });
  await started.promise;
  let ran = false;
  const pending = client.mutateLocal(async () => {
    ran = true;
  });
  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  await expect(pending).rejects.toMatchObject({ code: "stopping" });
  await nextTurn();
  expect(closed).toBe(false);
  expect(ran).toBe(false);
  release.resolve();
  expect(await first).toBe("saved");
  await closing;
});
it("bounds expired admissions until their queue slots are discarded", async () => {
  const { client, vault } = await ready();
  const { release, pass } = await blockedPass(client, vault);
  let ran = false;
  for (let i = 0; i < 16; i++) {
    await expect(
      client.mutateLocal(
        async () => {
          ran = true;
        },
        { waitMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "busy" });
  }
  await expect(
    client.mutateLocal(async () => {
      ran = true;
    }),
  ).rejects.toMatchObject({ code: "busy" });
  release.resolve();
  await pass;
  await client.settle();
  expect(await client.mutateLocal(async () => "admitted again")).toBe("admitted again");
  expect(ran).toBe(false);
});
it("allows watcher work to queue during a mutation and recovers after a failed callback", async () => {
  const { client, vault } = await ready();
  const started = deferred();
  const release = deferred();
  releases.push(() => release.resolve());
  const mutation = client.mutateLocal(async ({ changed }) => {
    changed("unsent.md");
    await vault.edit("unsent.md", "kept despite a later error\n");
    started.resolve();
    await release.promise;
    throw new Error("after publication");
  });
  const refused = expect(mutation).rejects.toThrow("after publication");
  await started.promise;
  client.noteChanged("watcher.md");
  const watcher = client.sync();
  release.resolve();
  await refused;
  await watcher;
  await client.settle();
  expect((await client.history("unsent.md")).length).toBe(1);
});

it("finishes an admitted transaction even when its request is cancelled", async () => {
  const { client, vault } = await ready();
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  releases.push(() => release.resolve());
  const mutation = client.mutateLocal(
    async ({ changed }) => {
      started.resolve();
      await release.promise;
      changed("accepted.md");
      await vault.edit("accepted.md", "complete\n");
      return "complete";
    },
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort();
  release.resolve();
  expect(await mutation).toBe("complete");
  await client.settle();
  expect((await client.history("accepted.md")).length).toBe(1);
});
it("drains the admitted write before reconnect starts another engine on its store", async () => {
  const { runForever } = await import("./client.ts");
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault();
  const store = new MemoryIndexStore();
  const firstReady = deferred<Client>();
  const secondReady = deferred<Client>();
  const gone = deferred();
  let candidate: Client | undefined;
  let connections = 0;
  let running = true;
  let wake = () => {};
  const loop = runForever(
    {
      vault,
      store,
      url: server.wsUrl,
      ...(await server.deviceCredentials(SECRET, wrapped)),
      vaultId: "default",
      device: "agent",
      coalesceWrites: false,
      timeoutMs: 20_000,
    },
    {
      keepGoing: () => running,
      onWaiting: (value) => {
        wake = value;
      },
      onConnecting: (client) => {
        connections++;
        candidate = client;
      },
      onClient: (client) => {
        if (!client) gone.resolve();
      },
      onSynced: () => {
        if (connections === 1) firstReady.resolve(candidate!);
        else secondReady.resolve(candidate!);
      },
      sleep: async () => {},
    },
  );
  const entered = deferred();
  const release = deferred();
  releases.push(() => release.resolve());
  try {
    const first = await within(firstReady.promise, "initial settle");
    const transaction = first.mutateLocal(async ({ changed }) => {
      entered.resolve();
      await release.promise;
      changed("during-drop.md");
      await vault.edit("during-drop.md", "admitted before disconnect\n");
      return "saved";
    });
    await entered.promise;
    first.transport.close();
    expect(first.transport.isClosed).toBe(true);
    await nextTurn();
    expect(connections).toBe(1);
    release.resolve();
    expect(await transaction).toBe("saved");
    await within(gone.promise, "old connection to end after draining");
    const second = await within(secondReady.promise, "reconnect after the old write drained");
    expect(connections).toBe(2);
    expect((await second.history("during-drop.md")).length).toBe(1);
    const version = (await second.history("during-drop.md"))[0]!;
    expect(new TextDecoder().decode(await second.contentAt(version))).toBe(
      "admitted before disconnect\n",
    );
  } finally {
    running = false;
    release.resolve();
    wake();
    await candidate?.close();
    await loop;
  }
});
