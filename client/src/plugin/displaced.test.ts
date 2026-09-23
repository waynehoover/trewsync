import { expect, it } from "vitest";
import { ObsidianVault } from "./vault.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";

const log = ".obsidian/plugins/trew-sync/displaced.log";
const kept = "Notes/.trew-tmp-review/Note.md";
const record = { at: kept, from: "Notes/Note.md", when: 1, why: "A save raced a deletion" };

/** Desktop Obsidian's exists returns false on access errors; stat propagates them. */
function unreadable(adapter: FakeAdapter, path: string) {
  const exists = adapter.exists.bind(adapter);
  const stat = adapter.stat.bind(adapter);
  adapter.exists = async (at) => (at === path ? false : exists(at));
  adapter.stat = async (at) => {
    if (at === path) throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
    return stat(at);
  };
}

it("reports unreadable recovery records instead of an empty recovery inventory", async () => {
  const adapter = new FakeAdapter();
  adapter.seed(log, JSON.stringify(record) + "\n");
  adapter.seed(kept, "an unsent edit\n");
  unreadable(adapter, log);
  const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
    displacedLog: log,
  });
  await vault.list();
  expect(vault.recovery.complete).toBe(false);
  expect(vault.recovery.why).toContain("EACCES");
  expect(adapter.text(kept)).toBe("an unsent edit\n");
  expect(adapter.text(log)).toBe(JSON.stringify(record) + "\n");
});

it("keeps a recorded hidden version visible in recovery when its directory cannot be checked", async () => {
  const adapter = new FakeAdapter();
  adapter.seed(log, JSON.stringify(record) + "\n");
  adapter.seed(kept, "an unsent edit\n");
  unreadable(adapter, kept);
  const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
    displacedLog: log,
  });
  await vault.list();
  expect(vault.stranded).toEqual([kept]);
  expect(adapter.text(kept)).toBe("an unsent edit\n");
  expect(adapter.text(log)).toBe(JSON.stringify(record) + "\n");
});
