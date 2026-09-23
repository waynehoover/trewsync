import { afterEach, expect, it, vi } from "vitest";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import TrewPlugin from "./main.ts";
import { App, notices, resetStub } from "./stub.ts";
import { TestServer } from "../core/test-server.ts";
import { nextTurn, within } from "../core/test-async.ts";

let server: TestServer | undefined;
let plugin: TrewPlugin | undefined;
afterEach(async () => {
  plugin?.onunload();
  await plugin?.closing;
  await server?.cleanup();
  vi.restoreAllMocks();
});
async function stateIs(kind: string) {
  if (plugin!.currentState.kind === kind) return;
  await within(
    new Promise<void>((resolve) => {
      const stop = plugin!.watchState((state) => {
        if (state.kind === kind) {
          stop();
          resolve();
        }
      });
    }),
    kind,
    15000,
  );
}

it("a retired reconnect loop must not erase the replacement loop's wake handle", async () => {
  resetStub();
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  server = new TestServer();
  await server.start();
  const app = new App();
  plugin = new TrewPlugin(
    app as unknown as ObsidianApp,
    {
      id: "trew-review",
      dir: ".obsidian/plugins/trew-review",
    } as PluginManifest,
  );
  await plugin.onload();
  // The first device, from the invite the server wrote on an empty store.
  await plugin.pair(await server.firstInvite(), "review-device");
  await stateIs("synced");
  const state = plugin as unknown as { wakeLoop?: () => void };
  const oldWake = state.wakeLoop!;
  await server.stop();
  await stateIs("offline");
  await server.start();
  await plugin.changeServerAddress(server.wsUrl);
  await stateIs("synced");
  const newWake = state.wakeLoop!;
  expect(typeof newWake).toBe("function");
  expect(newWake).not.toBe(oldWake);

  // Expire only the retired run's real backoff without waiting for its timer.
  oldWake();
  await nextTurn();
  try {
    const port = server.port;
    await server.stop();
    await stateIs("offline");
    await server.start(port);
    notices.length = 0;
    await plugin.syncNow();
    expect(notices.some(({ message }) => message === "Trew: reconnecting…")).toBe(true);
    expect(state.wakeLoop).toBe(newWake);
    await stateIs("synced");
  } finally {
    newWake();
  }
});
