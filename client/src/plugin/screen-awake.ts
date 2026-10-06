/**
 * Keeps a phone's screen on while a long pass runs.
 *
 * Android pauses Obsidian when the screen turns off, and the sync socket goes
 * with it: on a Pixel 9a the server saw the connection end seven seconds
 * after the screen did (2026-10-06). A first sync of a few thousand notes
 * takes minutes on a phone and the usual screen timeout is one, so a first
 * sync was cut off again and again, resuming only when somebody picked the
 * phone up.
 *
 * Only a pass that has already run for a while takes the lock, so the short
 * passes that follow every save never touch it. The system drops the lock
 * whenever the app is hidden; it is taken again when the app comes back while
 * the pass is still running. Where there is no Wake Lock API, nothing happens,
 * which is what always happened.
 */
export class ScreenAwake {
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the pass has run for `delayMs`, until it ends. */
  private long = false;
  private lock: WakeLockSentinel | undefined;
  private asking = false;
  private readonly onVisibility = () => {
    if (this.doc?.visibilityState !== "hidden") void this.take();
  };

  constructor(
    private readonly wakeLock: Pick<WakeLock, "request"> | undefined,
    private readonly doc: Document | undefined,
    private readonly delayMs = 2000,
  ) {
    doc?.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Whether a pass is running. Repeating the same answer changes nothing. */
  set(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.long = false;
    if (busy) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.long = true;
        void this.take();
      }, this.delayMs);
    } else {
      void this.release();
    }
  }

  dispose(): void {
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.set(false);
  }

  private async take(): Promise<void> {
    if (!this.wakeLock || !this.long || this.asking) return;
    if (this.lock && !this.lock.released) return;
    // A hidden page is refused the lock; it is asked for again on return.
    if (this.doc?.visibilityState === "hidden") return;
    this.asking = true;
    try {
      const lock = await this.wakeLock.request("screen");
      // The pass may have ended while the request was answered.
      if (!this.long) {
        await lock.release();
        return;
      }
      this.lock = lock;
    } catch {
      // Refused (a battery saver, a policy, a hidden page): sync carries on
      // exactly as it did before there was a lock to ask for.
    } finally {
      this.asking = false;
    }
  }

  private async release(): Promise<void> {
    const lock = this.lock;
    this.lock = undefined;
    if (lock && !lock.released) {
      try {
        await lock.release();
      } catch {
        // Already gone with the page; nothing is held either way.
      }
    }
  }
}
