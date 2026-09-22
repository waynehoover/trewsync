import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../core/test-async.ts";
import { pollWhileVisible } from "./visible-poll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function documentAt(initial: "visible" | "hidden") {
  const doc = Object.assign(new EventTarget(), { visibilityState: initial });
  vi.stubGlobal("document", doc);
  return (state: "visible" | "hidden") => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
}

describe("visible panel polling", () => {
  it("does not start a queued request after an immediate close", async () => {
    vi.useFakeTimers();
    documentAt("visible");
    const refresh = vi.fn(async () => {});
    const stop = pollWhileVisible(refresh, 1000);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("has no timer or requests while hidden, and refreshes immediately on return", async () => {
    vi.useFakeTimers();
    const show = documentAt("hidden");
    const refresh = vi.fn(async () => {});
    const stop = pollWhileVisible(refresh, 1000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
    show("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    show("hidden");
    expect(vi.getTimerCount()).toBe(0);
    show("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    show("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not overlap slow requests or rearm after closing", async () => {
    vi.useFakeTimers();
    const show = documentAt("visible");
    const pending = deferred();
    const refresh = vi.fn(() => pending.promise);
    const stop = pollWhileVisible(refresh, 1000);
    await vi.advanceTimersByTimeAsync(0);
    show("hidden");
    show("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can retry a failed request without starting a tight loop", async () => {
    vi.useFakeTimers();
    documentAt("visible");
    const refresh = vi.fn(async () => {
      throw new Error("offline");
    });
    const stop = pollWhileVisible(refresh, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });
});
