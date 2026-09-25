import type { Modal } from "obsidian";

/**
 * Opening a question where the person will see it: in Obsidian's main window.
 *
 * Obsidian draws a modal in whichever window is `activeWindow` when `open`
 * runs. On desktop 1.13 that is often not the main one, because Settings now
 * opens in a window of its own by default (`settingsPopoutWindow`), and it is
 * `activeWindow` for as long as it has focus. Pairing from the Settings tab
 * therefore drew "Review your first sync" inside the Settings window, which
 * sits wholly within the main window's bounds: one click back into the notes
 * and the review was behind the main window, the pass still waiting on it and
 * the status bar saying "Syncing notes." for good (seen 2026-09-24, Obsidian
 * 1.13.7 on a Mac). Closing Settings then took the review with it.
 *
 * So a review opens in the main window, and the main window is brought in
 * front of the popout that had focus, since that popout would otherwise cover
 * it. A popout closing no longer takes the question with it either.
 *
 * `activeWindow` is Obsidian's own global, and there is no API for choosing a
 * modal's window. It is pointed at the main window for the length of `open`
 * and put back, in case the focus change below does not happen (Obsidian
 * itself is not the focused application, for one) and Obsidian's own
 * bookkeeping still believes the popout is in front. Everywhere without
 * windows, mobile and the tests that do not set any up, this is plain `open`.
 */
interface Host {
  window?: HostWindow;
  activeWindow?: HostWindow;
  activeDocument?: unknown;
}

interface HostWindow {
  document?: unknown;
  /** Electron's handle on the native window, on desktop. */
  electronWindow?: { focus?(): void; isMinimized?(): boolean; restore?(): void };
}

const host = globalThis as unknown as Host;

/** Opens `modal` in the main window, and returns the window it was opened in. */
export function openInMainWindow(modal: Modal): unknown {
  const main = host.window;
  const active = host.activeWindow;
  if (main === undefined || active === undefined || active === main) {
    modal.open();
    return active ?? main;
  }
  const activeDocument = host.activeDocument;
  host.activeWindow = main;
  host.activeDocument = main.document;
  try {
    modal.open();
  } finally {
    // Only if nothing moved it meanwhile.
    if (host.activeWindow === main) {
      host.activeWindow = active;
      host.activeDocument = activeDocument;
    }
  }
  bringForward(main);
  return main;
}

/** Whether `win` is still the main window, and has not gone. */
export function isMainWindow(win: unknown): boolean {
  const main = host.window;
  return main === undefined || win === main || win === undefined;
}

/** Brings the main window in front of any popout, when there are windows. */
export function focusMainWindow(): void {
  const main = host.window;
  if (main !== undefined && host.activeWindow !== undefined && host.activeWindow !== main) {
    bringForward(main);
  }
}

function bringForward(main: HostWindow): void {
  const native = main.electronWindow;
  try {
    if (native?.isMinimized?.()) native.restore?.();
    native?.focus?.();
  } catch {
    // A window that cannot be focused is still the one the review is in; the
    // status bar says what is waiting, and opens it again when clicked.
  }
}
