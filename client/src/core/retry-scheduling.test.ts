import { afterEach, expect, it, vi } from "vitest";
import { engineOnFakeSocket } from "./fake-socket.ts";

afterEach(() => vi.restoreAllMocks());

async function failingRead() {
  const rig = await engineOnFakeSocket();
  let unavailable = true;
  const read = rig.vault.read.bind(rig.vault);
  const reads = vi.spyOn(rig.vault, "read").mockImplementation(async (path) => {
    if (unavailable) throw new Error("temporarily unavailable");
    return read(path);
  });
  let uid = 0;
  rig.socket.autoReply = (frame, socket) => {
    if (frame.op === "putmany")
      socket.reply({
        res: "acks",
        results: (frame.entries as unknown[]).map(() => ({ uid: ++uid })),
      });
  };
  await rig.vault.edit("note.md", "Keep this saved paragraph.\n");
  return {
    ...rig,
    reads,
    repair: () => {
      unavailable = false;
    },
  };
}

it("reports a transient retry deadline and retains it during automatic backoff", async () => {
  const rig = await failingRead();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    const first = await rig.engine.sync();
    expect(first.retrying).toBe(1);
    expect(first.nextUploadAt).toBe(1_010_000);
    clock.mockReturnValue(1_001_000);
    const waiting = await rig.engine.sync({ coalesceWrites: false });
    expect(waiting.nextUploadAt).toBe(1_010_000);
    expect(rig.reads).toHaveBeenCalledTimes(1);
    rig.repair();
    clock.mockReturnValue(1_010_000);
    const retried = await rig.engine.sync();
    expect(retried.uploaded).toBe(1);
    expect(retried.retrying).toBe(0);
    expect(retried.nextUploadAt).toBeUndefined();
    expect(rig.vault.text("note.md")).toBe("Keep this saved paragraph.\n");
  } finally {
    rig.t.close();
  }
});

it.each([{ retryFailures: true }, { verifyContents: true }])(
  "an explicit retry reads a repaired file immediately: %j",
  async (options) => {
    const rig = await failingRead();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await rig.engine.sync();
      rig.repair();
      const result = await rig.engine.sync(options);
      expect(result.uploaded).toBe(1);
      expect(result.retrying).toBe(0);
      expect(rig.reads).toHaveBeenCalledTimes(2);
      expect(rig.vault.text("note.md")).toBe("Keep this saved paragraph.\n");
    } finally {
      rig.t.close();
    }
  },
);

it("keeps increasing automatic backoff if a manual retry also fails", async () => {
  const rig = await failingRead();
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    await rig.engine.sync();
    const result = await rig.engine.sync({ retryFailures: true });
    expect(result.retrying).toBe(1);
    expect(result.nextUploadAt).toBe(1_020_000);
    await rig.engine.sync();
    expect(rig.reads).toHaveBeenCalledTimes(2);
  } finally {
    rig.t.close();
  }
});

it("a new file event retries that file without waking unrelated failures", async () => {
  const rig = await failingRead();
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    await rig.vault.edit("other.md", "Also preserve me.");
    await rig.engine.sync();
    rig.repair();
    await rig.vault.edit("note.md", "New edit after the failure.\n");
    rig.engine.noteChanged("note.md");
    const result = await rig.engine.sync();
    expect(result.uploaded).toBe(1);
    expect(result.retryingPaths).toEqual(["other.md"]);
    expect(rig.vault.text("note.md")).toBe("New edit after the failure.\n");
    expect(rig.vault.text("other.md")).toBe("Also preserve me.");
  } finally {
    rig.t.close();
  }
});

it("manual retry does not override a permanent size refusal", async () => {
  const rig = await engineOnFakeSocket({ perFileMax: 8 });
  try {
    await rig.vault.edit("note.md", "A larger note must be kept intact.");
    const read = vi.spyOn(rig.vault, "read");
    expect((await rig.engine.sync()).skipped).toBe(1);
    const result = await rig.engine.sync({ retryFailures: true });
    expect(result.skipped).toBe(1);
    expect(result.retrying).toBe(0);
    expect(result.nextUploadAt).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(rig.vault.text("note.md")).toBe("A larger note must be kept intact.");
  } finally {
    rig.t.close();
  }
});
