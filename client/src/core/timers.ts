/**
 * The timers the sync engine runs on, supplied by whoever runs it.
 *
 * `core` is shared by the plugin and the headless client. In Obsidian a timer
 * belongs on `window` (the community directory's review asks for it, so that
 * closing a popout cannot cancel one); Node has no `window`. So each host
 * installs its own before it constructs a client: the plugin `window`'s, the
 * headless client Node's, the tests the global ones.
 */

export interface Timers {
  setTimeout(fn: () => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms?: number): unknown;
  clearInterval(handle: unknown): void;
}

/** A timer as the engine holds it; only the host it came from reads it. */
declare const timerHandle: unique symbol;
export type TimerHandle = { readonly [timerHandle]: true };

let host: Timers | undefined;

export function installTimers(timers: Timers): void {
  host = timers;
}

function timers(): Timers {
  if (host === undefined) {
    throw new Error("no timers installed: call installTimers before starting a client");
  }
  return host;
}

export const setTimeout = (fn: () => void, ms?: number): TimerHandle =>
  timers().setTimeout(fn, ms) as TimerHandle;
export const clearTimeout = (handle: TimerHandle | undefined): void => {
  if (handle !== undefined) timers().clearTimeout(handle);
};
export const setInterval = (fn: () => void, ms?: number): TimerHandle =>
  timers().setInterval(fn, ms) as TimerHandle;
export const clearInterval = (handle: TimerHandle | undefined): void => {
  if (handle !== undefined) timers().clearInterval(handle);
};
