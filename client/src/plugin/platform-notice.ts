/**
 * What the plugin says, for as long as it runs, on a platform its tests do not
 * reach (PLAN.md section 4.12).
 *
 * The plugin pairs on Windows and on iOS rather than refusing to, and says so
 * where it cannot be missed or dismissed: a row at the top of the panel and a
 * word in the status bar, not a toast that is gone in twenty seconds. Each
 * names what is untested, so "unsupported" is something a person can weigh
 * rather than a label, and links to the support table in the README, which is
 * where a platform moves to supported once the M3 acceptance steps have run
 * on a real device.
 *
 * iOS is "untested" and Windows "unsupported" for a reason that is in the
 * text: iOS runs the same mobile adapter Android does, which is tested, and
 * nothing in the suites has ever run on Windows.
 */

/** The README's support table, which both notices link to. */
export const SUPPORT_TABLE = "https://github.com/waynehoover/trew#platforms";

export interface PlatformStanding {
  /** A word or two for the status bar and the ribbon: always on screen, so short. */
  readonly short: string;
  /** The panel row's name. */
  readonly title: string;
  /** What is untested, in sentences, for the panel row and the tooltip. */
  readonly detail: string;
}

/** The part of Obsidian's `Platform` this reads, so a test can pass its own. */
export interface PlatformFlags {
  readonly isIosApp: boolean;
  readonly isWin: boolean;
}

/**
 * The notice for this platform, or undefined on one the tests cover.
 *
 * iOS first, for the reason `platformWord` gives in main.ts: Obsidian's
 * declarations say an iPhone or iPad can claim to be a Mac, and asking the
 * desktop flags first is how a platform check gets that wrong.
 */
export function platformStanding(p: PlatformFlags): PlatformStanding | undefined {
  if (p.isIosApp) {
    return {
      short: "iOS untested",
      title: "iOS is untested",
      detail:
        "TrewSync runs the same code here as on Android, where it is tested, but no test has run " +
        "on an iPhone or iPad. Untested: iOS suspending Obsidian in the background, vaults " +
        "kept in iCloud Drive, and the iOS file system.",
    };
  }
  if (p.isWin) {
    return {
      short: "Windows unsupported",
      title: "Windows is not supported",
      detail:
        "None of TrewSync's tests run on Windows. Untested: file locking, path length limits, how " +
        "Windows compares names, and the file watcher. A note whose name Windows cannot hold, " +
        "such as CON or a name with a colon, is listed as needing attention rather than synced.",
    };
  }
  return undefined;
}
