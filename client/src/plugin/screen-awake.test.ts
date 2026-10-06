import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenAwake } from "./screen-awake.ts";

/** A Wake Lock API that records what it was asked for, and a page that can hide. */
function phone(options: { refuse?: boolean } = {}) {
  const locks: { released: boolean; release(): Promise<void> }[] = [];
  const wakeLock = {
    request: vi.fn(async (_type: "screen") => {
      if (options.refuse) throw new DOMException("refused", "NotAllowedError");
      const lock = {
        released: false,
        type: "screen" as const,
        async release() {
          lock.released = true;
        },
      };
      locks.push(lock);
      return lock as unknown as WakeLockSentinel;
    }),
  };
  let onVisibility: (() => void) | undefined;
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => (onVisibility = fn),
    removeEventListener: () => (onVisibility = undefined),
  };
  const held = () => locks.filter((l) => !l.released).length;
  /** What Android does: hiding the app drops the lock, showing it says so. */
  const hide = () => {
    doc.visibilityState = "hidden";
    for (const l of locks) l.released = true;
    onVisibility?.();
  };
  const show = () => {
    doc.visibilityState = "visible";
    onVisibility?.();
  };
  return { wakeLock, doc: doc as unknown as Document, locks, held, hide, show };
}

describe("keeping the screen on during a long pass", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("leaves a short pass alone", async () => {
    const p = phone();
    const awake = new ScreenAwake(p.wakeLock, p.doc, 2000);
    awake.set(true);
    await vi.advanceTimersByTimeAsync(1500);
    awake.set(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.wakeLock.request).not.toHaveBeenCalled();
  });

  it("holds the screen on once a pass runs long, and lets go when it ends", async () => {
    const p = phone();
    const awake = new ScreenAwake(p.wakeLock, p.doc, 2000);
    awake.set(true);
    // A pass reports progress many times; only the first start counts.
    awake.set(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.held()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.wakeLock.request).toHaveBeenCalledTimes(1);
    awake.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.held()).toBe(0);
  });

  it("takes the lock again when the app comes back mid-pass, and not after it", async () => {
    const p = phone();
    const awake = new ScreenAwake(p.wakeLock, p.doc, 2000);
    awake.set(true);
    await vi.advanceTimersByTimeAsync(2000);
    p.hide();
    expect(p.held()).toBe(0);
    p.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.held()).toBe(1);

    awake.set(false);
    await vi.advanceTimersByTimeAsync(0);
    p.hide();
    p.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.held()).toBe(0);
    expect(p.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it("does not ask while hidden, and asks on return if the pass went long meanwhile", async () => {
    const p = phone();
    const awake = new ScreenAwake(p.wakeLock, p.doc, 2000);
    p.hide();
    awake.set(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.wakeLock.request).not.toHaveBeenCalled();
    p.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.held()).toBe(1);
  });

  it("releases a lock that is granted after the pass has already ended", async () => {
    const p = phone();
    let grant: (() => void) | undefined;
    const slow = {
      request: vi.fn(
        () =>
          new Promise<WakeLockSentinel>((resolve) => {
            grant = () => resolve(p.wakeLock.request("screen") as unknown as WakeLockSentinel);
          }),
      ),
    };
    const awake = new ScreenAwake(slow as never, p.doc, 2000);
    awake.set(true);
    await vi.advanceTimersByTimeAsync(2000);
    awake.set(false);
    grant!();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.locks.length).toBe(1);
    expect(p.held()).toBe(0);
  });

  it("carries on without a lock where there is no API or it is refused", async () => {
    const none = new ScreenAwake(undefined, undefined, 2000);
    none.set(true);
    await vi.advanceTimersByTimeAsync(5000);
    none.set(false);

    const p = phone({ refuse: true });
    const refused = new ScreenAwake(p.wakeLock, p.doc, 2000);
    refused.set(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.wakeLock.request).toHaveBeenCalledTimes(1);
    expect(p.held()).toBe(0);
    refused.dispose();
  });

  it("lets go when the plugin unloads mid-pass", async () => {
    const p = phone();
    const awake = new ScreenAwake(p.wakeLock, p.doc, 2000);
    awake.set(true);
    await vi.advanceTimersByTimeAsync(2000);
    awake.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.held()).toBe(0);
    p.hide();
    p.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.wakeLock.request).toHaveBeenCalledTimes(1);
  });
});
