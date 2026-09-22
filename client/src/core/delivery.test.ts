import { describe, expect, it } from "vitest";
import { deliverySummary, describeDelivery } from "./delivery.ts";
import type { DeviceRow } from "./transport.ts";

const phone: DeviceRow = {
  id: "phone",
  name: "Phone",
  createdAt: 1,
  lastSeen: 2,
  online: true,
  applied: 10,
};

describe("device delivery wording", () => {
  it("distinguishes connected, waiting, received, and offline", () => {
    expect(describeDelivery(phone, 10)).toBe("Received latest changes");
    expect(describeDelivery(phone, 11)).toBe("Waiting for latest changes");
    expect(describeDelivery({ ...phone, applied: null }, 10)).toBe(
      "Connected · delivery unconfirmed",
    );
    expect(describeDelivery({ ...phone, online: false, applied: null }, 10)).toBe(
      "Offline · delivery unconfirmed",
    );
  });
  it("counts only other devices that confirmed the latest checkpoint", () => {
    expect(deliverySummary([phone], "phone", 10)).toBe("");
    expect(deliverySummary([phone], "mac", 10)).toBe("Latest changes received on Phone.");
    expect(deliverySummary([phone], "mac", 11)).toBe("Waiting for Phone.");
    expect(deliverySummary([{ ...phone, online: false, applied: null }], "mac", 10)).toBe(
      "Waiting for Phone. Open Obsidian there to sync.",
    );
  });
});
