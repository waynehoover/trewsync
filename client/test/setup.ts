import { installTimers } from "../src/core/timers.ts";

/**
 * `window` for tests, which run in Node.
 *
 * In Obsidian the plugin calls timers on `window` (`window.setTimeout`), as the
 * community directory's review asks. Node has no `window`, so tests get a
 * stand-in: an event target, as a window is, whose timers are the global ones
 * looked up at each call, so `vi.useFakeTimers` reaches them too. Reloading it
 * does nothing, as the absent window did; a test that cares replaces it.
 */
if (typeof window === "undefined") {
  (globalThis as { window?: unknown }).window = withTimers(
    Object.assign(new EventTarget(), { location: { reload: () => undefined } }),
  );
}

/**
 * A stand-in window for a test that replaces `window`, with the timers the
 * plugin calls on it, forwarded to the global ones at the moment of the call.
 */
export function withTimers<T extends object>(
  win: T,
): T & Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval"> {
  return Object.assign(win, {
    setTimeout: ((...args: Parameters<typeof setTimeout>) =>
      setTimeout(...args)) as unknown as Window["setTimeout"],
    clearTimeout: ((id?: number) => clearTimeout(id)) as Window["clearTimeout"],
    setInterval: ((...args: Parameters<typeof setInterval>) =>
      setInterval(...args)) as unknown as Window["setInterval"],
    clearInterval: ((id?: number) => clearInterval(id)) as Window["clearInterval"],
  });
}

/**
 * The sync engine's timers (src/core/timers.ts) are the global ones in tests,
 * looked up at each call so fake timers apply.
 */
installTimers({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
});
