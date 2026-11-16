export type VisiblePoll = (() => void) & { refresh(): void };

/** One request at a time, with immediate invalidation and no hidden-webview timer. */
export function pollWhileVisible(
  refresh: () => Promise<void>,
  intervalMs: number | (() => number | undefined),
  isVisible?: () => boolean,
): VisiblePoll {
  const doc = typeof document === "undefined" ? undefined : document;
  let stopped = false;
  let running = false;
  let again = false;
  let timer: number | undefined;
  const visible = () => !stopped && (isVisible ? isVisible() : doc?.visibilityState !== "hidden");
  const schedule = () => {
    running = false;
    if (!visible()) return;
    if (again) {
      again = false;
      run();
      return;
    }
    const interval = typeof intervalMs === "function" ? intervalMs() : intervalMs;
    if (interval !== undefined) timer = window.setTimeout(run, interval);
  };
  const run = () => {
    if (!visible()) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void Promise.resolve()
      .then(() => {
        if (visible()) return refresh();
      })
      .then(schedule, schedule);
  };
  const changed = () => {
    window.clearTimeout(timer);
    if (visible()) run();
  };
  if (!isVisible) doc?.addEventListener("visibilitychange", changed);
  run();
  return Object.assign(
    () => {
      stopped = true;
      window.clearTimeout(timer);
      if (!isVisible) doc?.removeEventListener("visibilitychange", changed);
    },
    { refresh: changed },
  );
}
