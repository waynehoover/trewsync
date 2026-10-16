import type { TransferActivity } from "../core/transfer.ts";

/** Wire bytes have no known total: compression and reuse change what travels. */
export function describeTransfer(activity: TransferActivity): string {
  const uploading = activity.direction === "upload";
  const subject = activity.path ?? `${activity.files} files`;
  const action = `${uploading ? "Uploading" : "Downloading"} ${subject}…`;
  if (activity.bytes === 0) return action;
  return `${action} ${size(activity.bytes)} ${uploading ? "sent" : "received"}.`;
}

/**
 * A pass's incoming files as a count. One large file on its own is a batch of
 * its own, and its bytes are what moves while the count stands still.
 */
export function describeReceived(
  at: { done: number; total: number },
  activity?: TransferActivity,
): string {
  const count = `Downloading ${at.done.toLocaleString()} of ${at.total.toLocaleString()} files`;
  if (activity?.direction === "download" && activity.path !== undefined && activity.bytes > 0) {
    return `${count}. ${activity.path}: ${size(activity.bytes)} received.`;
  }
  return `${count}.`;
}

function size(bytes: number): string {
  let value = bytes;
  const units = ["B", "KB", "MB", "GB"];
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}
