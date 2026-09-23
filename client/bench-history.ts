/** Metadata catch-up with many revisions of one path. Run with bun or Node's
 * --experimental-transform-types. Real server/fsync, in-memory client vaults. */
import { Client } from "./src/core/client.ts";
import { MemoryVault, MemoryIndexStore } from "./src/core/vault.ts";
import { TestServer, cleanupBinary } from "./src/core/test-server.ts";
import { testWrapped } from "./src/core/test-keys.ts";
const count = Number(process.env["TREW_BENCH_HISTORY"] ?? 1000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid history count");
const server = new TestServer();
const clients: Client[] = [];
try {
  await server.start();
  const secret = new Uint8Array(32).fill(67),
    wrapped = await testWrapped(secret);
  const device = async (name: string) => {
    const vault = new MemoryVault();
    const client = new Client({
      vault,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      vaultId: "default",
      device: name,
      inspect: true,
      coalesceWrites: false,
      ...(await server.deviceCredentials(secret, wrapped, name)),
    });
    clients.push(client);
    return { client, vault };
  };
  const a = await device("writer");
  await a.client.connect();
  for (let i = 0; i < count; i++) {
    await a.vault.edit("history.md", `# Revision ${i}\n`);
    a.client.noteChanged("history.md");
    await a.client.engine.sync({ coalesceWrites: false });
  }
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const b = await device(`reader-${i}`),
      start = performance.now();
    await b.client.connect();
    const metadata = performance.now() - start;
    await b.client.engine.sync();
    if (b.vault.text("history.md") !== `# Revision ${count - 1}\n`)
      throw new Error("The newest revision did not arrive");
    samples.push({
      metadataMs: Math.round(metadata),
      completeMs: Math.round(performance.now() - start),
    });
    await b.client.close();
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        protocol: 7,
        historyEntries: count,
        currentFiles: 1,
        samples,
        exactContentVerified: true,
        environment: "loopback; real Go server; in-memory client vaults",
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await server.cleanup();
  await cleanupBinary();
}
