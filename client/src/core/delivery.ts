import type { DeviceRow } from "./transport.ts";

/** Delivery is a live device's completed checkpoint, not its connection time. */
export function receivedLatest(device: DeviceRow, cursor: number): boolean {
  return device.online && device.applied !== null && device.applied >= cursor;
}

export function describeDelivery(device: DeviceRow, cursor: number): string {
  if (!device.online && device.lastSeen === 0) return "Never connected";
  if (!device.online) return "Offline · delivery unconfirmed";
  if (receivedLatest(device, cursor)) return "Received latest changes";
  return device.applied === null
    ? "Connected · delivery unconfirmed"
    : "Waiting for latest changes";
}

export function deliverySummary(
  devices: readonly DeviceRow[],
  thisDevice: string,
  cursor: number,
): string {
  const others = devices.filter((d) => d.id !== thisDevice);
  if (others.length === 0) return "";
  if (others.length === 1) {
    const d = others[0]!;
    const name = d.name || "your other device";
    if (receivedLatest(d, cursor)) return `Latest changes received on ${name}.`;
    return `Waiting for ${name}.${d.online ? "" : " Open Obsidian there to sync."}`;
  }
  const received = others.filter((d) => receivedLatest(d, cursor)).length;
  return `Latest changes received on ${received} of ${others.length} other devices.`;
}
