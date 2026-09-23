import { receiveCommitted } from "../core/test-async.ts";
/**
 * Folder deletions between two Obsidian vaults, through a real server
 * (docs/design.md, "Folders").
 *
 * The plugin's half of the rule is removing an empty folder, which neither of
 * Obsidian's adapters can be asked to do: desktop `rmdir` refuses a folder
 * unless told to recurse, and mobile `rmdir` recurses whatever it is told
 * (read out of 1.13.7, and modelled in `fake.ts`). So these check both
 * platforms, and they check the things a person would find afterwards:
 * which notes are where, what reached the trash, and whether anything was
 * left behind under a hidden name.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

class Device {
  readonly adapter = new FakeAdapter();
  client!: Client;

  constructor(
    readonly name: string,
    mobile: boolean,
  ) {
    this.adapter.mobile = mobile;
  }

  async connect(server: TestServer): Promise<void> {
    this.client = new Client({
      vault: new ObsidianVault(asVault(new FakeVaultIndex(this.adapter)), ".obsidian"),
      store: new ObsidianIndexStore(this.adapter, ".obsidian/plugins/trew/index.json"),
      url: server.wsUrl,
      ...(await server.deviceCredentials(this.name)),
      vaultId: "default",
      device: this.name,
      timeoutMs: 20_000,
      coalesceWrites: false,
    });
    await this.client.connect();
    // The plugin forwards Obsidian's rename events; the fake's rename is the
    // adapter's, so it is forwarded here for the one path that moved.
    this.adapter.afterRename = (from, to) => {
      if (!from.includes(".trew-tmp-") && !to.includes(".trew-tmp-")) {
        void this.client.noteRename(from, to);
      }
    };
  }

  close(): void {
    this.client?.close();
  }

  /** The folders a person sees: not the config folder, the trash or anything hidden. */
  folders(): string[] {
    return this.adapter
      .everything()
      .filter((p) => !this.adapter.filePaths().includes(p))
      .filter((p) => !p.split("/").some((part) => part.startsWith(".")))
      .sort();
  }

  /** The notes a person sees, with their text. */
  notes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.adapter.filePaths()) {
      if (p.split("/").some((part) => part.startsWith("."))) continue;
      out[p] = this.adapter.text(p)!;
    }
    return out;
  }

  /** Anything this client left under one of its hidden names. */
  litter(): string[] {
    return this.adapter.everything().filter((p) => p.includes(".trew-tmp-"));
  }
}

let server: TestServer;
const devices: Device[] = [];

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  if (server) await server.cleanup();
});

async function two(mobile: boolean): Promise<[Device, Device]> {
  server = new TestServer();
  await server.start();
  const out: Device[] = [];
  for (const name of ["mac", "phone"]) {
    const d = new Device(name, name === "phone" && mobile);
    devices.push(d);
    await d.connect(server);
    out.push(d);
  }
  return out as [Device, Device];
}

async function converge(a: Device, b: Device, rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await a.client.settle();
    await receiveCommitted(b.client.transport);
    await b.client.settle();
    await receiveCommitted(a.client.transport);
  }
}

describe.each([
  ["desktop", false],
  ["mobile", true],
] as const)("a folder deleted on another device, on %s", (_platform, mobile) => {
  it("is removed once empty, with its note in the trash and nothing else", async () => {
    const [mac, phone] = await two(mobile);
    mac.adapter.seed("Projects/plan.md", "the plan\n");
    await mac.adapter.mkdir("Projects/Empty");
    await converge(mac, phone);
    expect(phone.folders()).toEqual(["Projects", "Projects/Empty"]);

    await mac.adapter.remove("Projects/plan.md");
    await mac.adapter.rmdir("Projects", true);
    await converge(mac, phone);

    expect(phone.folders(), "the folder stayed on the phone").toEqual([]);
    expect(phone.notes()).toEqual({});
    // The note went where every incoming deletion goes. The folders did not
    // go there, and nothing was left behind under a hidden name.
    expect(phone.adapter.text(".trash/plan.md")).toBe("the plan\n");
    expect(phone.adapter.everything().filter((p) => p.startsWith(".trash/"))).toEqual([
      ".trash/plan.md",
    ]);
    expect(phone.litter()).toEqual([]);
    expect(mac.folders()).toEqual([]);
  }, 300_000);

  /**
   * Somebody saves a note into the folder in the instant it is being removed:
   * after the plugin looked and found it empty, before it moved it aside.
   * The folder is kept with the note in it, goes back on the server, and the
   * note reaches the device that deleted the folder.
   */
  it("keeps a note saved into the folder as it is removed", async () => {
    const [mac, phone] = await two(mobile);
    await mac.adapter.mkdir("Inbox");
    await converge(mac, phone);
    expect(phone.folders()).toEqual(["Inbox"]);

    let saved = false;
    phone.adapter.beforeRename = (from) => {
      if (from === "Inbox" && !saved) {
        saved = true;
        phone.adapter.seed("Inbox/just saved.md", "saved at the last moment\n");
      }
    };
    await mac.adapter.rmdir("Inbox", true);
    await converge(mac, phone);

    expect(saved, "the removal never moved the folder aside").toBe(true);
    for (const d of [mac, phone]) {
      expect(d.notes(), `${d.name} lost the note`).toEqual({
        "Inbox/just saved.md": "saved at the last moment\n",
      });
      expect(d.folders(), d.name).toEqual(["Inbox"]);
      expect(d.litter(), d.name).toEqual([]);
    }
  }, 300_000);

  /**
   * A folder rename, reported the way Obsidian reports one: the adapter moves
   * the folder with everything in it. The other device ends with the new name
   * only.
   */
  it("leaves no ghost of a renamed folder", async () => {
    const [mac, phone] = await two(mobile);
    mac.adapter.seed("Projects Old/a.md", "a\n");
    mac.adapter.seed("Projects Old/sub/b.md", "b\n");
    await converge(mac, phone);

    await mac.adapter.rename("Projects Old", "Projects New");
    await converge(mac, phone);

    for (const d of [mac, phone]) {
      expect(d.folders(), `${d.name} keeps the old name`).toEqual([
        "Projects New",
        "Projects New/sub",
      ]);
      expect(d.notes(), d.name).toEqual({
        "Projects New/a.md": "a\n",
        "Projects New/sub/b.md": "b\n",
      });
      expect(d.litter(), d.name).toEqual([]);
    }
  }, 300_000);
});
