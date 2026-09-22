import type { TransferActivity } from "../core/transfer.ts";

/** Wire bytes have no known total: compression and reuse change what travels. */
export function describeTransfer(activity: TransferActivity): string {
  const uploading = activity.direction === "upload";
  const subject = activity.path ?? `${activity.files} files`;
  const action = `${uploading ? "Uploading" : "Downloading"} ${subject}…`;
  if (activity.bytes === 0) return action;
  let value = activity.bytes;
  const units = ["B", "KB", "MB", "GB"];
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${action} ${Math.round(value * 10) / 10} ${units[unit]} ${uploading ? "sent" : "received"}.`;
}
