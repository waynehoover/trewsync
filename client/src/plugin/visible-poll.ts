export type VisiblePoll = (() => void) & { refresh(): void };

/** One request at a time, with immediate invalidation and no hidden-webview timer. */
export function pollWhileVisible(
  refresh: () => Promise<void>,
  intervalMs: number | (() => number | undefined),
  isVisible?: () => boolean,
): VisiblePoll {
  const doc = globalThis.document;
  let stopped = false;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
    if (interval !== undefined) timer = setTimeout(run, interval);
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
    clearTimeout(timer);
    if (visible()) run();
  };
  if (!isVisible) doc?.addEventListener("visibilitychange", changed);
  run();
  return Object.assign(
    () => {
      stopped = true;
      clearTimeout(timer);
      if (!isVisible) doc?.removeEventListener("visibilitychange", changed);
    },
    { refresh: changed },
  );
}
