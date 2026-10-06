import { describe, expect, it } from "vitest";
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

/**
 * T11. Every incoming deletion writes a record before the note is moved aside
 * to be identified, and the record is dead once the note is in the trash. The
 * plugin's log could not be tidied at all, so a quiet pass read it back and
 * stat'ed every deletion this device had ever applied: 3 stats before 200
 * deletions, 203 after, about 2 ms each on a phone, for ever.
 */
describe("the record of every deletion this device has applied", () => {
  /** Records of notes moved aside to be identified and long since trashed. */
  function deletions(count: number): string {
    let text = "";
    for (let i = 0; i < count; i++) {
      const at = `Notes/.trew-tmp-${i}/note-${i}.md`;
      const d = { at, from: `Notes/note-${i}.md`, why: "moved aside to be identified", when: i };
      text += `\n${JSON.stringify(d)}\n`;
    }
    return text;
  }
  const statsOfRecords = (adapter: FakeAdapter) =>
    adapter.calls.filter((c) => c.op === "stat" && c.path.includes("/.trew-tmp-")).length;

  it("is emptied once every record in it is dead, and checked", async () => {
    const adapter = new FakeAdapter();
    adapter.seed(log, deletions(200));
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      displacedLog: log,
    });
    await vault.list();
    expect(statsOfRecords(adapter)).toBe(200);
    expect(adapter.text(log)).toBe("");
    expect(vault.recovery.complete).toBe(true);

    adapter.calls.length = 0;
    await vault.list();
    expect(statsOfRecords(adapter), "a quiet pass still looked for every deletion").toBe(0);
  });

  it("is looked at once per session while a live record keeps it from being emptied", async () => {
    const adapter = new FakeAdapter();
    adapter.seed(log, deletions(200) + `\n${JSON.stringify(record)}\n`);
    adapter.seed(kept, "an unsent edit\n");
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      displacedLog: log,
    });
    await vault.list();
    expect(statsOfRecords(adapter)).toBe(201);
    expect(vault.stranded).toEqual([kept]);

    adapter.calls.length = 0;
    await vault.list();
    expect(statsOfRecords(adapter), "a quiet pass still looked for every deletion").toBe(1);
    expect(vault.stranded).toEqual([kept]);
    expect(adapter.text(kept)).toBe("an unsent edit\n");
  });

  it("is not emptied of a record written after it was read", async () => {
    const adapter = new FakeAdapter();
    adapter.seed(log, deletions(3));
    const late = { at: "Notes/.trew-tmp-late/late.md", from: "Notes/late.md", why: "w", when: 9 };
    let reads = 0;
    adapter.fault = (op, path) => {
      // The second read of the log is the one inside the emptying: a record
      // lands between the ledger reading the log and emptying it.
      if (op === "read" && path === log && ++reads === 2) {
        adapter.seed(log, `${adapter.text(log)}\n${JSON.stringify(late)}\n`);
      }
      return undefined;
    };
    adapter.seed(late.at, "on its way to the trash");
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian", undefined, {
      displacedLog: log,
    });
    await vault.list();
    expect(adapter.text(log)).toContain(JSON.stringify(late));
    adapter.fault = undefined;
    await vault.list();
    expect(vault.stranded).toEqual([late.at]);
  });
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
