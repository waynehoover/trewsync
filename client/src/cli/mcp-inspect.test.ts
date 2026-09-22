import { expect, it } from "vitest";
import type { Client } from "../core/client.ts";
import { compareText, deliveryStatus } from "./mcp-inspect.ts";
import { deferred } from "../core/test-async.ts";

it("reconstructs exact line bytes across insertions, removals, CRLF and missing final newlines", () => {
  const texts = [
    "",
    "one\n",
    "one\r\ntwo",
    "\ufeffone\n\nthree\n",
    "three\ntwo\none\n",
    "one\ntwo\nthree\n",
  ];
  for (const before of texts)
    for (const after of texts) {
      const diff = compareText(before, after);
      const lines = before.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      for (const row of [...diff.changes].reverse()) {
        expect(lines.slice(row.fromLine - 1, row.fromLine - 1 + row.oldLines).join("")).toBe(
          row.old,
        );
        lines.splice(row.fromLine - 1, row.oldLines, row.new);
      }
      expect(lines.join("")).toBe(after);
    }
});
it("uses a deterministic broad hunk for comparisons exceeding the work cap", () => {
  const before = Array.from({ length: 2000 }, (_, i) => `old ${i}\n`).join("");
  const after = Array.from({ length: 2000 }, (_, i) => `new ${i}\n`).join("");
  const result = compareText(before, after);
  expect(result).toEqual({
    coarse: true,
    changes: [{ fromLine: 1, toLine: 1, old: before, new: after, oldLines: 2000, newLines: 2000 }],
  });
  expect(compareText(before, after)).toEqual(result);
});
it.each(["generation", "cursor", "connection", "readiness"])(
  "never confirms receipt when %s changes during the device query",
  async (kind) => {
    const pending = deferred<{ devices: object[]; maxDevices: number; invites: object[] }>();
    const state = {
      serverCursor: 10,
      deliveryReady: true,
      transport: { isClosed: false },
      devices: () => pending.promise,
    };
    let generation = 0;
    const call = deliveryStatus(state as unknown as Client, () => generation);
    if (kind === "generation") generation++;
    if (kind === "cursor") state.serverCursor++;
    if (kind === "connection") state.transport.isClosed = true;
    if (kind === "readiness") state.deliveryReady = false;
    pending.resolve({
      devices: [{ name: "phone", applied: 10, online: true, lastSeen: 1 }],
      maxDevices: 10,
      invites: [],
    });
    expect(await call).toMatchObject({ localReady: false, devices: [{ state: "unconfirmed" }] });
  },
);
