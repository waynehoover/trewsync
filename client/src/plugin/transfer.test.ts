import { expect, it } from "vitest";
import { describeReceived } from "./transfer.ts";

it("counts files, and gives one large file's bytes while the count stands still", () => {
  const batch = { direction: "download", files: 6, bytes: 900 } as const;
  const large = { direction: "download", files: 1, path: "talk.mp4", bytes: 12_400_000 } as const;
  expect(describeReceived({ done: 3, total: 6 })).toBe("Downloading 3 of 6 files.");
  expect(describeReceived({ done: 3, total: 6 }, batch)).toBe("Downloading 3 of 6 files.");
  expect(describeReceived({ done: 5, total: 6 }, large)).toBe(
    "Downloading 5 of 6 files. talk.mp4: 12.4 MB received.",
  );
});
