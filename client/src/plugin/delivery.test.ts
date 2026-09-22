import { afterEach, expect, it, vi } from "vitest";
import { watchDelivery } from "./delivery.ts";
import { deferred } from "../core/test-async.ts";
import type { DeviceRow } from "../core/transport.ts";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", doc);
  const listeners = new Set<() => void>();
  const peer = { id: "phone", name: "Phone", online: true, applied: 2 };
  const source = {
    currentState: { kind: "synced" },
    deliveryReady: true,
    cursor: 2,
    cursors() {
      return { local: this.cursor, server: this.cursor };
    },
    devices: vi.fn(async () => ({ devices: [{ ...peer } as DeviceRow], thisDevice: "mac" })),
    watchState(listener: () => void) {
      listeners.add(listener);
      listener();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    peer,
    doc,
    update: () => {
      for (const listener of listeners) listener();
    },
  };
}
it("shares delivery requests, slows settled polling, and checks immediately after a new local checkpoint", async () => {
  const { source, peer, update } = fixture();
  const a = vi.fn(),
    b = vi.fn();
  stops.push(watchDelivery(source, a), watchDelivery(source, b));
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).toHaveBeenCalledTimes(1);
  expect(a).toHaveBeenLastCalledWith("Latest changes received on Phone.");
  await vi.advanceTimersByTimeAsync(9999);
  expect(source.devices).toHaveBeenCalledTimes(1);
  source.cursor = 3;
  update();
  expect(a).toHaveBeenLastCalledWith("Device delivery unconfirmed.");
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenLastCalledWith("Waiting for Phone.");
  peer.applied = 3;
  // A second while a peer is online and behind, which is the busy cadence.
  await vi.advanceTimersByTimeAsync(999);
  expect(source.devices).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(source.devices).toHaveBeenCalledTimes(3);
  expect(a).toHaveBeenLastCalledWith("Latest changes received on Phone.");
});
it("never publishes a stale delivery response, and has no hidden or unsynced polling", async () => {
  const { source, update, doc } = fixture();
  const pending = deferred<Awaited<ReturnType<typeof source.devices>>>();
  source.devices.mockImplementationOnce(() => pending.promise);
  const say = vi.fn();
  stops.push(watchDelivery(source, say));
  await vi.advanceTimersByTimeAsync(0);
  source.currentState.kind = "syncing";
  update();
  pending.resolve({
    devices: [{ id: "phone", name: "Phone", online: true, applied: 2 } as DeviceRow],
    thisDevice: "mac",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(say).not.toHaveBeenCalledWith("Latest changes received on Phone.");
  expect(vi.getTimerCount()).toBe(0);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  source.currentState.kind = "synced";
  update();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(source.devices).toHaveBeenCalledTimes(1);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).toHaveBeenCalledTimes(2);
});
it("drains a closing panel's request before a reopened panel asks again", async () => {
  const { source } = fixture();
  const pending = deferred<Awaited<ReturnType<typeof source.devices>>>();
  source.devices.mockImplementationOnce(() => pending.promise);
  const close = watchDelivery(source, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  close();
  const say = vi.fn();
  stops.push(watchDelivery(source, say));
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).toHaveBeenCalledTimes(1);
  pending.resolve({ devices: [], thisDevice: "mac" });
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).toHaveBeenCalledTimes(2);
  expect(say).toHaveBeenLastCalledWith("Latest changes received on Phone.");
  stops.pop()!();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps polling for a visible popout when another settings window is hidden", async () => {
  const { source, doc } = fixture();
  doc.visibilityState = "hidden";
  const popout = Object.assign(new EventTarget(), { visibilityState: "visible" });
  stops.push(watchDelivery(source, vi.fn(), doc as unknown as Document));
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).not.toHaveBeenCalled();
  const close = watchDelivery(source, vi.fn(), popout as unknown as Document);
  stops.push(close);
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).toHaveBeenCalledTimes(1);
  close();
  expect(vi.getTimerCount()).toBe(0);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(source.devices).toHaveBeenCalledTimes(2);
});
