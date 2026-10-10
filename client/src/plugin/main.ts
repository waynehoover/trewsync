import { SyncPreviewModal } from "./preview.ts";
import { focusMainWindow, isMainWindow, openInMainWindow } from "./main-window.ts";
import type { SyncPreview } from "../core/preview.ts";
import { ActivityLog, ActivityModal } from "./activity.ts";
import { ConflictsModal } from "./conflicts.ts";
import { conflictOriginal, reviewConflict, type ConflictPair } from "../core/conflicts.ts";
/** Obsidian plugin: lifecycle, platform adapter, and sync/recovery interfaces. */

/*!
 * Bundled dependency: fflate
 * Copyright (c) 2026 Arjun Barrett, https://github.com/101arrowz/fflate
 * Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
 *
 * Bundled dependency: diff-match-patch
 * Copyright 2018 The diff-match-patch Authors, https://github.com/google/diff-match-patch
 * Licensed under the Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  Modal,
  Menu,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingGroup,
  requireApiVersion,
  setIcon,
  type ButtonComponent,
  type MarkdownView,
  type TAbstractFile,
  type TextComponent,
} from "obsidian";

import {
  HistoryModal,
  describeRestore,
  when,
  type HistorySource,
  type Restored,
} from "./history.ts";

import {
  Client,
  PairingInterrupted,
  SYNC_EVENT_DELAY_MS,
  adviseAfterPairing,
  attentionLines,
  isFatal,
  needsAttention,
  pairWithInvite,
  rebaseCursors,
  refuseUnlessAhead,
  retryWait,
  whatTheDiskHolds,
  runForever,
  summarise,
  credentialsFor,
  type ClientOptions,
  type DeletedList,
  type Deletion,
  type DeviceRow,
  type InviteRow,
  type PairingRemains,
  type PairingStore,
  type Version,
} from "../core/client.ts";
import { watchResume } from "./resume.ts";
import { watchDelivery } from "./delivery.ts";
import { ScreenAwake } from "./screen-awake.ts";
import type { TransferActivity } from "../core/transfer.ts";
import { describeTransfer } from "./transfer.ts";
import { SUPPORT_TABLE, platformStanding } from "./platform-notice.ts";
import { describeDelivery } from "../core/delivery.ts";
import {
  REJOIN_ADVICE,
  type RepairReport,
  type SettingsScope,
  type SyncReport,
} from "../core/engine.ts";
import {
  DEFAULT_VAULT,
  decodeConfig,
  deviceCredential,
  encodeConfig,
  isIgnorableName,
  isPendingPairing,
  joinDestination,
  normaliseUrl,
  parseInvite,
  startPairing,
  type DeviceConfig,
  type PendingPairing,
} from "../core/pairing.ts";
import { Backoff, ProtocolError, Transport } from "../core/transport.ts";
import { DISPLACED_LOG, type Displaced, type Inventory } from "../core/displaced.ts";
import { firstFreeName } from "../core/paths.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";
import { backUpSettings, createProfile, isProfileName, profileRootOf } from "./settings.ts";
import { indexLogPath } from "../core/index-journal-store.ts";
import { timedVault } from "../core/vault.ts";
import type { JournalSaveCost, JournalStoreOptions } from "../core/index-journal-store.ts";
import { INVITE_ACTION, inviteQrImage } from "./invite-qr.ts";
import { checkFirstSync, MergeConfirmationRequired } from "./first-sync.ts";
import {
  IN_KEYCHAIN,
  IN_KEYCHAIN_PENDING,
  TOKEN_IN,
  WRITTEN_AT,
  appStartOf,
  keepInKeychain,
  keychainOf,
  removeFromKeychain,
  secretIdFor,
  secretsForDevice,
  tokenInKeychain,
} from "./keychain.ts";

/**
 * Where the plugin's running commentary goes: the developer console, at the
 * level Obsidian's directory asks plugins to keep it at. The panel and the
 * notices carry everything a person has to act on; this is for the one
 * attaching a debugger.
 */
const log = (message: string, ...rest: unknown[]): void =>
  console.debug("TrewSync:", message, ...rest);

/**
 * Where an unloaded instance of this plugin leaves the close it started, for
 * the next instance on the same app to wait for (T10).
 *
 * On the app, as `appStartOf` keeps the start id, because disabling and
 * enabling a plugin (the Settings toggle, an update through BRAT, a hot
 * reload) evaluates this module again and keeps the app. The old instance's
 * close drains the pass it was in, which goes on landing files after
 * `onunload` has returned, and the new instance started at once: two engines
 * on one vault, each landing what the other was landing. Toggled after 20 of
 * 120 notes had arrived, the vault held 220 notes, 100 of them conflict
 * copies. An unlink still being finished was a pairing the next instance
 * could read before the unlink had removed it.
 */
const CLOSING = Symbol.for("trew.closing");

/**
 * The size and times a file event carries, or undefined for a folder.
 * Structural, as `vault.ts` reads the index, rather than `instanceof TFile`.
 */
function statOfEvent(file: TAbstractFile): { size: number; mtime: number } | undefined {
  const stat = (file as { stat?: { size?: unknown; mtime?: unknown } }).stat;
  return stat && typeof stat.size === "number" && typeof stat.mtime === "number"
    ? { size: stat.size, mtime: stat.mtime }
    : undefined;
}

/** Every close an earlier instance of this plugin started on this app. */
function closingOn(app: object): Promise<void> {
  const held = (app as Record<symbol, unknown>)[CLOSING];
  return held instanceof Promise ? (held as Promise<void>) : Promise.resolve();
}

/** Adds a close to what the next instance on this app waits for. */
function leaveClosing(app: object, closing: Promise<void>): void {
  const all = Promise.all([closingOn(app), closing]).then(() => undefined);
  Object.defineProperty(app, CLOSING, {
    value: all,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

/** What the status bar is saying, which is also what the modal shows. */
export type State =
  | { kind: "unpaired" }
  /**
   * A pairing whose redemption went out and has not been answered
   * (plan/protocol.md, "Invite redemption"). Not paired and not unpaired: the
   * credential is saved and whether the server registered it is what is not
   * yet known, so it is finished rather than started over. `retryAt` is set
   * while it waits after an attempt that got no answer, and `why` says what
   * that attempt ran into.
   */
  | { kind: "pairing"; why?: string; retryAt?: number }
  | { kind: "connecting" }
  | { kind: "loading"; local: number; server: number }
  /**
   * Settled, with what the last pass found.
   *
   * `refused` is how many files the vault holds that will not sync until a
   * person does something: written off for good, or blocked by a name that
   * is a file here and a folder elsewhere. A vault with one such file used to
   * show the same glyph as a clean one, which is rule 7 with the two
   * conditions that matter most collapsed.
   */
  | {
      kind: "synced";
      summary: string;
      at: number;
      refused: number;
      /**
       * How many versions this client took off a note and could not put back.
       *
       * Different from `refused` and reported apart from it: a refused file is
       * one that is not syncing and is still where its author left it, and one
       * of these is a note that exists only under a name Obsidian does not
       * show. Nothing in this plugin used to say so at all (R46).
       */
      waiting: number;
      /**
       * Files this device has not synced yet and expects to, with a deadline.
       *
       * Its own number, not folded into `refused` and not left out (rule 7,
       * Codex-03). `needsAttention` counts what a person has to act on, and a
       * file backing off after a failed upload is not that; but it is not
       * finished either, and the glyph said it was. A vault with a note
       * retrying showed the same tick as a vault with nothing left to do.
       */
      pending?: number | undefined;
      /**
       * When the next attempt at `pending` is due, if anything is.
       *
       * Because "3 files are waiting" and "3 files are waiting, next try in
       * four minutes" are different amounts of help, and the second is what
       * stops somebody power-cycling their phone.
       */
      pendingAt?: number | undefined;
      /**
       * What is written off and why, and what is being retried, by name.
       *
       * Kept on the state rather than only in a notice. A refusal used to be a
       * sentence on screen for twenty seconds and a number afterwards, and the
       * guide told people to look in the panel for a reason the panel did not
       * have (Codex-03).
       */
      issues?: readonly { path: string; why: string }[] | undefined;
      retryingPaths?: readonly string[] | undefined;
      /**
       * Set when this device cannot say what is waiting (RR2).
       *
       * Different from `waiting: 0`, and the difference is the whole reason
       * the field exists: the plugin's only record of a note it hid is a log
       * in its own folder, and a log it cannot read produces an empty list
       * that reads exactly like a clean vault.
       */
      recoveryUnknown?: string | undefined;
    }
  /** Preparation or transfer activity; saving still has to finish. */
  | { kind: "syncing"; path?: string; transfer?: TransferActivity; since: number }
  /**
   * A pass is waiting for somebody to answer a review, and will not move
   * until they do.
   *
   * Its own state, not "syncing": a Mac paired again from the Settings window
   * sat at "Syncing notes." for good while the first-sync review it was
   * waiting on was hidden behind the main window (2026-09-24). The status bar
   * says what is being waited for, and clicking it opens the review again.
   */
  | { kind: "review"; heading: string }
  /**
   * The last pass did not finish, and this is why.
   *
   * Not `synced`, whose glyph says the vault is as the server has it, and
   * not `stopped`, which says waiting will not help. The next pass may well
   * succeed; this one did not, and saying so is the honest state.
   */
  | { kind: "failed"; why: string; at: number }
  /**
   * `refused` is whether the failure was a handshake that never completed
   * with a server this plugin has never reached, which is when the origin
   * advice in the panel applies. A connection that was up and went is
   * ordinary network loss and the origin is known to be fine.
   */
  | { kind: "offline"; why: string; retryAt: number; refused: boolean }
  /**
   * Stopped, and whether there is a recovery to offer for it.
   *
   * `rejoin` is set for a refusal that has a button behind it: the server is
   * behind this device, which is what a restore from an older backup looks
   * like. The panel showed the reason and nothing else, and the reason pointed
   * at docs/server.md, which is not somewhere a phone goes at the moment its
   * notes have stopped syncing.
   *
   * `pair-again` is the other: the server refuses this device's own
   * credential, which is what revoking it does. The only way on is a new
   * pairing, and the panel draws that instead of the paired panel, whose
   * every action needs the credential that was refused. See `recoveryFor`.
   */
  | { kind: "paused" }
  | { kind: "stopped"; why: string; recovery?: "rejoin" | "pair-again" };

/** A review a pass is waiting on: what it asks, and where it was last drawn. */
interface PendingReview {
  readonly preview: SyncPreview;
  readonly heading: string;
  /** Resolves the pass's question, once; later calls change nothing. */
  readonly answer: (proceed: boolean) => void;
  modal: SyncPreviewModal | undefined;
  /** The window `modal` was opened in, from `openInMainWindow`. */
  shownIn: unknown;
}

export default class TrewPlugin extends Plugin {
  private config: DeviceConfig | undefined;
  /** The connected client, or undefined between connections. */
  private client: Client | undefined;
  /**
   * The client of the current run from the moment it exists, connected or
   * not. `client` is set only once the handshake has succeeded, and a vault
   * unlinked during a slow handshake had no handle on the connection being
   * made with its old credential. This is that handle.
   */
  private live: Client | undefined;
  /**
   * When the first file event of the current batch arrived, while a run is
   * being measured. Undefined between passes. See `timingLog`.
   */
  measuringFrom: number | undefined;
  /**
   * The vault adapter the running client is using, or none.
   *
   * The displaced-version ledger lives on it, and getting a stranded note back
   * has to go through the same adapter that put it there: it is the only thing
   * that knows the hidden name and the only thing that writes through Obsidian.
   */
  private liveVault: ObsidianVault | undefined;
  private state: State = { kind: "unpaired" };
  private statusEl: HTMLElement | undefined;
  private ribbonEl: HTMLElement | undefined;
  private running = false;
  private paused = false;
  private pausing: Promise<void> | undefined;
  private activityLog: ActivityLog | undefined;
  private readonly syncPrompts = new Set<() => void>();

  /**
   * Which run is the current one. Bumped by every start, by unlink and by
   * unload, so a run that has been superseded can tell, and says nothing
   * when it has.
   */
  private generation = 0;
  private editingConnection = false;
  private unlinking: Promise<void> | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private workingTimer: ReturnType<typeof setTimeout> | undefined;
  private workingPath: string | undefined;
  private workingTransfer: TransferActivity | undefined;
  private workingSince: number | undefined;
  private manualSync: Promise<void> | undefined;
  private previewing: Promise<void> | undefined;
  private previewModal: SyncPreviewModal | undefined;

  /**
   * Why the saved settings could not be read, while that is the case.
   *
   * Rule 2: an unreadable config is not an unpaired vault. The panel used to
   * branch on `paired` alone and offer the pairing form over a file it could
   * not read, and pairing writes a new credential over the old one, after
   * which the device row this vault already has is stranded: the file may
   * hold the only copy of that row's token.
   */
  private unreadable: string | undefined;
  /**
   * The keychain id `data.json` points at, while it points at one.
   *
   * Set when a config is read or written with its token in the keychain, and
   * cleared when the token goes back to `data.json` or the pairing goes. It is
   * how a new pairing, an unlink or a refused redemption finds the secret the
   * old one left, so a credential that opens nothing any more does not stay in
   * the keychain after the file that named it has moved on.
   */
  private secretInUse: string | undefined;
  /**
   * The keychain id whose token is known to have reached the keychain's
   * storage: `getSecret` gave it back at a start of the app other than the
   * one that wrote it, answering from what that start loaded. Only then may
   * `data.json` go without the token (rule 3).
   */
  private secretStored: string | undefined;
  /** The pending marker `data.json` holds, while it holds one: the id, and the start that wrote it. */
  private secretPending: { id: string; writtenAt: string } | undefined;
  /**
   * Secrets for this device under the vault's old name, adopted after a
   * rename on a desktop, to remove once the token is saved under the new one.
   */
  private secretsAdopted: string[] = [];
  /** Whether this pairing has ever completed a handshake since the plugin loaded. */
  private everConnected = false;
  /** The pairing in progress, so a second press cannot start another. */
  private pairing: Promise<unknown> | undefined;
  /**
   * Why the last pairing did not finish, while the panel is offering another.
   *
   * A pairing refused while it was being finished in the background has
   * nobody waiting on it to tell: the panel is where the reason goes, above
   * the form that tries again, and a notice says it once.
   */
  private failedPairing: string | undefined;
  /** What the notices have already said, so they say it once. */
  private announced = { attention: "", waiting: "", unknown: "", settings: 0 };
  /**
   * The notice `stop` put up, which has no timeout, and the reason it gave.
   *
   * Taken down by `setState` once the state is no longer that stop. It used
   * to stay up until somebody dismissed it: a phone revoked and paired again
   * showed "TrewSync has stopped: this device was revoked" minutes later, beside
   * "TrewSync: up to date" (M3's fourth finding).
   */
  private stoppedNotice: { notice: Notice; why: string } | undefined;
  /** What `onunload` started and could not wait for, for anything that can. */
  closing: Promise<void> | undefined;
  /**
   * Renames Obsidian reported while there was no client to tell, oldest
   * first, for the next one (T14). Only for this instance's life: a rename
   * made just before the plugin is unloaded, with no connection in between,
   * still travels as a deletion and a new file.
   */
  private readonly renamesWaiting: [string, string][] = [];
  /**
   * Every config save or index reset in flight, so `unlink` cannot be overtaken by one.
   *
   * All of them, not the newest. Two reconnects inside one unlink window
   * start two saves, and holding only the second left the first free to land
   * its pairing on top of the null that unlink had just written (R10).
   */
  private readonly settling = new Set<Promise<void>>();

  /** Ends the reconnect loop's backoff wait, when there is one to end (I05). */
  private wakeLoop: (() => void) | undefined;
  private stopResume: (() => void) | undefined;
  private resuming: Promise<void> | undefined;
  /** Phones only: the screen stays on while a long pass runs. */
  private awake: ScreenAwake | undefined;
  private readonly panelClosers = new Set<() => void>();

  watchUnload(close: () => void): () => void {
    this.panelClosers.add(close);
    return () => {
      this.panelClosers.delete(close);
    };
  }

  override async onload(): Promise<void> {
    // Nothing of this instance exists until an earlier one on this app has
    // finished closing: not a command, not a read of `data.json`, not a pass
    // (T10). Usually there is none, and this costs nothing.
    const mine = this.generation;
    await closingOn(this.app);
    if (mine !== this.generation) return;
    this.stopResume = watchResume(() => this.resume());
    // Android pauses Obsidian when the screen turns off, and the sync socket
    // goes with it, so a first sync longer than the screen timeout was cut
    // off again and again (screen-awake.ts).
    if (Platform.isMobileApp)
      this.awake = new ScreenAwake(
        typeof navigator === "undefined" ? undefined : navigator.wakeLock,
        typeof document === "undefined" ? undefined : document,
      );
    // Obsidian mobile has no status bar, and the declaration says so:
    // addStatusBarItem is "not available on mobile". The ribbon is on both,
    // so the state goes there too: its tooltip is the same sentence, and it
    // is the thing somebody taps when they want to know.
    if (!Platform.isMobileApp) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.setAttribute("role", "button");
      this.statusEl.setAttribute("tabindex", "0");
      this.registerDomEvent(this.statusEl, "click", (event) => this.showMenu(event));
      this.registerDomEvent(this.statusEl, "keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.showMenu();
        }
      });
    }
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "TrewSync", (event) => this.showMenu(event));
    this.ribbonEl.addClass("trew-sync-ribbon");
    // Settings is where somebody looks for a plugin's interface, and Obsidian
    // draws the gear there only for a plugin that registers a tab. Without
    // this the panel existed on the ribbon, the status bar and the command
    // palette, and Settings said TrewSync had no interface at all.
    this.addSettingTab(new TrewSettingTab(this));

    this.addCommand({
      id: "preview-sync",
      name: "Preview sync",
      callback: () => void this.openPreview(),
    });
    this.addCommand({
      id: "activity",
      name: "Show sync activity",
      callback: () => this.openActivity(),
    });
    this.addCommand({
      id: "review-conflicts",
      name: "Review conflicts",
      callback: () => this.openConflicts(),
    });
    this.addCommand({
      id: "pause-resume",
      name: "Pause or resume sync",
      callback: () => void this.togglePause(),
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "verify-contents",
      name: "Verify vault contents",
      callback: () => void this.syncNow(true),
    });
    this.addCommand({
      id: "show-status",
      name: "Show status",
      callback: () => new TrewModal(this).open(),
    });
    this.addCommand({
      id: "recover-deleted",
      name: "Recover a deleted note",
      callback: () => new RecoverModal(this).open(),
    });
    this.addCommand({
      id: "apply-settings",
      name: "Apply synced settings and reload",
      callback: () => this.applySettingsNow(),
    });
    this.addCommand({
      id: "create-settings-profile",
      name: "Create a settings profile for this device",
      callback: () => new ProfileModal(this).open(),
    });
    this.addCommand({
      id: "version-history",
      name: "Show version history",
      // Checking rather than callback, so the command does not appear in
      // the palette while nothing is open for it to act on.
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openHistory(file.path);
        return true;
      },
    });

    // Where somebody already looks for this: Obsidian Sync puts version
    // history on the file menu, so this goes in the same place.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!("extension" in file)) return;
        menu.addItem((item) =>
          item
            .setTitle("TrewSync: version history")
            .setIcon("history")
            .onClick(() => this.openHistory(file.path)),
        );
      }),
    );

    // The same two operations without the UI, registered the way Obsidian
    // registers its own `sync:history` and `history:restore`.
    //
    // Guarded because this arrived in Obsidian 1.12.2 and the rest of what
    // this plugin needs is older. Calling a method that is not there throws
    // inside onload, which stops registration where it stands: everything
    // after it never happens and the plugin half exists, with nothing saying
    // why. Seen exactly that on a phone running a stale build.
    //
    // A block rather than an early return, because returning would skip the
    // vault event registration below and leave an older Obsidian syncing
    // only on the timer. The first version of this guard did exactly that.
    //
    // Two checks. `requireApiVersion` is the one the community directory's
    // review reads: it refuses any API newer than `minAppVersion` unless it
    // sits behind that call, and it refuses a comment that disables it too.
    // `typeof` stays because it is the one that asks the object itself, and a
    // build can report a version without carrying everything it promises.
    if (requireApiVersion("1.12.2") && typeof this.registerCliHandler === "function") {
      this.registerCliHandler(
        "trew:history",
        "List TrewSync version history for a note",
        { path: { value: "<path>", description: "Vault path" } },
        async (flags) => this.cliHistory(String(flags["path"] ?? "")),
      );
      this.registerCliHandler(
        "trew:restore",
        "Restore a TrewSync version",
        {
          path: { value: "<path>", description: "Vault path" },
          uid: { value: "<n>", description: "Version uid", required: true },
        },
        async (flags) => this.cliRestore(String(flags["path"] ?? ""), Number(flags["uid"])),
      );
    }

    // Obsidian's own events, rather than a watcher. They are what the
    // platform gives, they work on mobile, and they say when to look rather
    // than what changed: the scan is what decides, and it re-reads the vault
    // every time, so a missed event costs latency and never correctness.
    //
    // Registered inside onLayoutReady because Obsidian's own docs say to:
    // "If you do not wish to receive create events on vault load, register
    // your event handler inside Workspace.onLayoutReady". Otherwise opening
    // a vault fires a create for every file in it. The coalescing below
    // would collapse them into one sync, so this is about not doing
    // thousands of pointless things rather than about correctness. The
    // callback runs immediately if the layout is already up.
    this.app.workspace.onLayoutReady(() => {
      // Except this client's own writes, which the engine accounts for itself
      // (P-3). Obsidian reports a file renamed into place when its watcher
      // gets to it, and a write in place, a removal or a new folder from
      // inside the call; each was taken for news, marked the file changed and
      // asked for another round, which read and hashed again every file the
      // pass had just written and read back: 12 to 14 ms a file on a phone.
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!this.liveVault?.ownCreate(file.path, statOfEvent(file))) this.nudge(file.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (!this.liveVault?.ownChange(file.path)) this.nudge(file.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (!this.liveVault?.ownChange(file.path)) this.nudge(file.path);
        }),
      );
      // The old path is the whole point of this event. A rename that
      // arrives as a delete plus an add still moves the file, but it
      // retires the old path as a deletion, and the list of deleted notes
      // is then mostly phantoms of files that still exist under another
      // name. The engine turns the pair into one operation, and until
      // this line existed nothing ever told it one had happened.
      //
      // Through the client rather than straight to the engine, so it
      // waits for the pass in flight rather than moving an entry that
      // pass has in hand.
      //
      // Not for a rename this client is making itself, such as moving the
      // old bytes of an attachment aside before writing the new ones. The
      // engine decided that one and was told the note stayed where it was.
      //
      // And kept when there is no client to tell: while the first catch-up
      // loads, while offline, while paused (T14). Sent as a deletion and a
      // new file instead, the note's history was out of reach of its new
      // name and Browse deleted listed a note that was still there.
      this.registerEvent(
        this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          if (!this.liveVault?.ownRename(oldPath, file.path)) {
            if (this.client) void this.client.noteRename(oldPath, file.path);
            else this.renamesWaiting.push([oldPath, file.path]);
          }
          this.nudge();
        }),
      );
    });

    try {
      this.activityLog = new ActivityLog(
        this.app.vault.adapter,
        `${this.pluginDir()}/activity.json`,
      );
      await this.activityLog.load();
      const config = await this.readConfig();
      this.config = config === undefined ? undefined : await this.moveTokenToKeychain(config);
    } catch (err) {
      // Rule 2: an unreadable config is not an unpaired vault. Starting
      // over would write a new credential over one that may be the only
      // copy of a live row's token.
      this.unreadable = (err as Error).message;
      this.setState({ kind: "stopped", why: this.unreadable });
      new Notice(`TrewSync: ${this.unreadable}`, 10_000);
    }

    // A link opens the form, filled in, and never pairs by itself: the panel
    // shows where the invite points and nothing changes until somebody
    // presses Pair. Anybody who can put a link in front of somebody can send
    // one of these, which is the reason (plan/research/README.md section 5).
    this.registerObsidianProtocolHandler(INVITE_ACTION, (params) => {
      try {
        this.refuseUnlessPairable();
        const invite = params["invite"]?.trim() ?? "";
        try {
          parseInvite(invite);
        } catch (err) {
          throw new Error(
            `This invite link is invalid: ${(err as Error).message}. Create a new invite on a ` +
              `paired device, or with trewd invite on the server.`,
          );
        }
        new TrewModal(this, invite).open();
      } catch (err) {
        new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
      }
    });

    if (this.unreadable !== undefined) return;
    // A pending pairing starts too: the run loop finishes it before anything
    // connects as the device it names.
    if (this.config) this.start();
    else this.setState({ kind: "unpaired" });
  }

  /**
   * Obsidian's unload is synchronous, so the close cannot be awaited here.
   *
   * It is started, and held in `closing` for anything that can wait. What
   * the generation bump guarantees is that the run being closed writes no
   * state and shows no notice from here on. The pass it may be finishing
   * still writes the index, and that is the one write that must complete:
   * an index behind its notes is safe, an index cut off mid-write is not.
   */
  override onunload(): void {
    this.previewModal?.close();
    this.previewModal = undefined;
    for (const close of this.panelClosers) close();
    this.panelClosers.clear();
    // A plugin that is not running has nothing left to say about why it stopped.
    this.stoppedNotice?.notice.hide();
    this.stoppedNotice = undefined;
    this.stopResume?.();
    this.stopResume = undefined;
    this.awake?.dispose();
    this.awake = undefined;
    this.running = false;
    this.generation++;
    this.clearTimers();
    // After `running` is false, so the loop wakes into a decision to stop
    // rather than into another attempt (I05).
    this.wakeLoop?.();
    this.wakeLoop = undefined;
    const { live, client } = this.retireClients();
    this.closing = Promise.all([
      live?.close(),
      client?.close(),
      this.unlinking,
      this.pausing,
      ...this.settling,
      this.activityLog?.flush(),
    ])
      .then(() => undefined)
      .catch(() => undefined);
    // And for the next instance of this plugin, which Obsidian may load into
    // the same app before this close has finished (T10).
    leaveClosing(this.app, this.closing);
  }

  /* ------------------------------------------------------------ *
   * Running
   * ------------------------------------------------------------ */

  private openPreview(): Promise<void> {
    if (this.previewing) {
      if (this.previewModal?.isClosed) this.previewModal.open();
      return this.previewing;
    }
    const client = this.client;
    if (!client) {
      new Notice(this.whyNoClient());
      return Promise.resolve();
    }
    this.previewModal?.close();
    const modal = new SyncPreviewModal(this.app);
    this.previewModal = modal;
    modal.open();
    const generation = this.generation;
    const detach = this.watchUnload(() => modal.close());
    const prepare = async () => {
      try {
        const preview = await client.preview();
        if (this.client === client && this.generation === generation) modal.showPreview(preview);
        else modal.close();
      } catch (error) {
        if (this.client === client && this.generation === generation)
          modal.showError(`Could not preview sync: ${(error as Error).message}`);
        else modal.close();
      } finally {
        detach();
      }
    };
    const work = prepare();
    this.previewing = work;
    void work.then(() => {
      if (this.previewing === work) this.previewing = undefined;
    });
    return work;
  }

  private async confirmSync(
    preview: SyncPreview,
    heading: string,
    current: () => boolean,
  ): Promise<boolean> {
    if (!current()) return false;
    // One review at a time: a pass asks one question and waits for it. One
    // left over from a run that has ended is answered no, never yes.
    this.review?.answer(false);
    let answer!: (proceed: boolean) => void;
    const answered = new Promise<boolean>((resolve) => (answer = resolve));
    const review: PendingReview = {
      preview,
      heading,
      modal: undefined,
      shownIn: undefined,
      answer: (proceed) => {
        if (this.review === review) this.review = undefined;
        answer(proceed);
      },
    };
    this.review = review;
    const close = () => {
      review.modal?.close();
      review.answer(false);
    };
    this.syncPrompts.add(close);
    const detach = this.watchUnload(close);
    try {
      // Before the review is drawn, so the status bar already says what the
      // vault is waiting for if the review is somehow not in front.
      this.setState({ kind: "review", heading });
      this.showReview();
      const proceed = await answered;
      if (proceed && current()) this.setState({ kind: "syncing", since: Date.now() });
      if (!proceed && current()) {
        // Said out loud, because the two ways of getting here do not look
        // alike (R083-15, rule 7). One is a button labelled "Pause sync"; the
        // other is Escape or the close button, which a person reads as "not
        // now" and which used to stop sync with nothing on screen to say so.
        // Whichever it was, this names the state and how to leave it.
        new Notice(
          "Sync is paused until you review these changes. " +
            "Choose Resume sync from the TrewSync menu to continue.",
          10_000,
        );
        void this.togglePause();
      }
      return proceed && current();
    } finally {
      if (this.review === review) this.review = undefined;
      this.syncPrompts.delete(close);
      detach();
    }
  }

  /**
   * The review a pass is waiting on, while one is.
   *
   * Held here rather than only by its modal, so that the review outlives
   * wherever it was drawn: the status bar, the ribbon, Sync now and the panel
   * all open it again, and a modal that is closed without Continue is the
   * only thing that answers it, and answers no.
   */
  private review: PendingReview | undefined;

  /**
   * Puts the pending review in front of the person, in the main window.
   *
   * Drawn again when it is not open there, for instance because it was drawn
   * in a window that has since gone behind or away. The copy it replaces is
   * withdrawn without answering, so moving it is never read as a choice.
   */
  showReview(): void {
    const review = this.review;
    if (!review) return;
    const shown = review.modal;
    // Open, attached to a document, and in the main window. A modal whose
    // window went without Obsidian closing it is none of those, and is the
    // review that used to wait on nobody.
    const onScreen =
      shown !== undefined &&
      !shown.isClosed &&
      (shown.containerEl as { isConnected?: boolean } | undefined)?.isConnected !== false &&
      isMainWindow(review.shownIn);
    if (onScreen) {
      focusMainWindow();
      return;
    }
    shown?.withdraw();
    const modal = new SyncPreviewModal(this.app, review.preview, review.heading);
    review.modal = modal;
    modal.ask((proceed) => {
      if (review.modal === modal) review.answer(proceed);
    });
    review.shownIn = openInMainWindow(modal);
  }

  private openActivity(): void {
    if (this.activityLog)
      new ActivityModal(
        this.app,
        this.activityLog,
        (path) => this.openExisting(path),
        (close) => this.watchUnload(close),
      ).open();
  }

  private openExisting(path: string): void {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      new Notice("This file has moved or was deleted. Look in version history or deleted notes.");
      return;
    }
    void this.app.workspace.getLeaf().openFile(file);
  }

  private conflictPairs(): ConflictPair[] {
    return this.app.vault.getFiles().flatMap((file) => {
      const original = conflictOriginal(file.path);
      return original ? [{ original, copy: file.path }] : [];
    });
  }

  private openConflicts(): void {
    new ConflictsModal(this.app, {
      pairs: () => this.conflictPairs(),
      open: (path) => this.openExisting(path),
      review: (pair) => {
        if (!this.client)
          return reviewConflict(new ObsidianVault(this.app.vault, this.app.vault.configDir), pair);
        return this.client.reviewConflict(pair);
      },
      resolve: async (review, choice, edited) => {
        const client = this.client;
        if (!client) throw new Error(this.whyNoClient());
        await client.resolveConflict(review, choice, edited);
        await this.activityLog?.flush();
        await this.syncNow();
      },
    }).open();
  }

  private showMenu(event?: MouseEvent): void {
    // Straight to it: while a review is waiting it is the one thing that
    // moves this vault on, and the status bar says so.
    if (this.review) {
      this.showReview();
      return;
    }
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Sync now")
        .setIcon("refresh-cw")
        .setDisabled(this.paused)
        .onClick(() => void this.syncNow()),
    );
    menu.addItem((item) =>
      item
        .setTitle("Preview sync")
        .setIcon("list-checks")
        .onClick(() => void this.openPreview()),
    );
    menu.addItem((item) =>
      item
        .setTitle("Sync activity")
        .setIcon("list")
        .onClick(() => this.openActivity()),
    );
    const conflicts = this.conflictPairs().length;
    menu.addItem((item) =>
      item
        .setTitle(`Review conflicts${conflicts ? ` (${conflicts})` : ""}`)
        .setIcon("files")
        .onClick(() => this.openConflicts()),
    );
    const file = this.app.workspace.getActiveFile();
    menu.addItem((item) =>
      item
        .setTitle("Version history")
        .setIcon("history")
        .setDisabled(!file)
        .onClick(() => {
          if (file) this.openHistory(file.path);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Browse deleted")
        .setIcon("trash-2")
        .onClick(() => new RecoverModal(this).open()),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(this.paused ? "Resume sync" : "Pause sync")
        .setIcon(this.paused ? "play" : "pause")
        .setDisabled(!this.config || (!this.paused && !!this.pausing))
        .onClick(() => void this.togglePause()),
    );
    menu.addItem((item) =>
      item
        .setTitle("Sync settings")
        .setIcon("settings")
        .onClick(() => new TrewModal(this).open()),
    );
    if (event) menu.showAtMouseEvent(event);
    else {
      const rect = this.statusEl?.getBoundingClientRect();
      menu.showAtPosition({ x: rect?.left ?? 0, y: rect?.top ?? 0 });
    }
  }

  private async togglePause(): Promise<void> {
    const config = this.config;
    if (!config) return;
    if (this.paused) {
      const mine = this.generation;
      await this.pausing;
      if (mine !== this.generation || this.config !== config || !this.paused) return;
      this.paused = false;
      this.start();
      return;
    }
    if (this.pausing) return;
    this.paused = true;
    this.running = false;
    this.generation++;
    this.clearTimers();
    this.wakeLoop?.();
    const { live, client } = this.retireClients();
    // Resume must wait for the entire pause, including the activity write.
    // Clear the flag before resolving so start() can accept the queued resume.
    const closing = Promise.all([live?.close(), client?.close()])
      .then(() => this.activityLog?.flush())
      .finally(() => {
        if (this.pausing === closing) this.pausing = undefined;
      });
    this.pausing = closing;
    this.setState({ kind: "paused" });
    await closing;
  }

  private start(): void {
    const config = this.config;
    if (!config || this.running || this.paused || this.pausing) return;
    this.running = true;
    this.everConnected = false;
    this.announced = { attention: "", waiting: "", unknown: "", settings: 0 };
    // Every run is numbered, and only the newest one may speak. A single
    // boolean was not enough: unlinking cleared it, pairing again set it,
    // and the *previous* run woke from its backoff, read the new run's
    // flag, and carried on with the old pairing's credential. It
    // reconnected, was refused, and its refusal put "TrewSync has stopped: not
    // authorised for this vault" on screen while the real client was
    // syncing perfectly well behind it.
    const mine = ++this.generation;
    this.setState({ kind: "connecting" });

    void (async () => {
      // Anything thrown while assembling the client lands here, and this
      // is the only place it can be seen. Without the catch below it
      // becomes an unhandled rejection and the plugin simply never syncs,
      // with a status bar still saying "connecting".
      try {
        await this.runLoop(config, mine);
      } catch (err) {
        if (mine === this.generation) this.stop(err as Error);
      }
      if (mine === this.generation) this.running = false;
    })();
  }

  /** Check a resumed socket before trusting its apparent connected state. */
  private resume(): void {
    if (!this.running || this.resuming) return;
    const mine = this.generation;
    const client = this.client;
    if (!client) {
      this.wakeLoop?.();
      return;
    }
    const work = (async () => {
      try {
        await client.probe();
        if (mine === this.generation && this.client === client) await client.sync();
      } catch {
        // probe closes an unresponsive transport. The loop drains any writes
        // before reconnecting; waking it does not create a second writer.
        if (mine === this.generation) this.wakeLoop?.();
      }
    })();
    this.resuming = work;
    void work.finally(() => {
      if (this.resuming === work) this.resuming = undefined;
    });
  }

  /**
   * Finishes a pairing that is still pending, checks there is something to
   * connect with, then runs the loop.
   *
   * There is one credential and no list of candidates to try. A paired device
   * holds one credential for one row, and either it opens the vault or nothing
   * on this phone does. Trying a second would mean a device with a way in that
   * revoking the first cannot close.
   *
   * A pending pairing is not that check failing: it holds a credential, and
   * whether the server registered it is what is not known yet, so it is
   * finished first (`finishPairing`) and only then connected with.
   *
   * The check after that is not a step that can be resumed, it is a refusal.
   * A config that holds no credential is one nothing here wrote, and there is
   * nothing this can do about it that a person cannot see: it stops with
   * `deviceCredential`'s words, which name what is missing and say to pair
   * again with an invite. Retrying it forever instead would sit there saying
   * "connecting" about a connection nothing was going to make
   * (plan/research/basalt-lessons.md section 6, item 7).
   */
  private async runLoop(config: DeviceConfig, mine: number): Promise<void> {
    const current = () => mine === this.generation;
    if (isPendingPairing(config)) {
      const finished = await this.finishPairing(config, mine);
      if (finished === undefined || !current()) return;
      config = finished;
    }
    try {
      deviceCredential(config);
    } catch (err) {
      // A token that went to a keychain this vault cannot reach is not a
      // config nothing wrote: it is a copy, a rename or a lost entry, and the
      // way on is a new pairing, which the stop offers.
      const lost = tokenNotHere.get(config);
      if (current()) this.stop(lost !== undefined ? new TokenNotHere(lost) : (err as Error));
      return;
    }
    const refusal = await this.runOnce(config, mine);
    if (!current() || refusal === undefined) return;
    this.stop(refusal);
  }

  /**
   * Finishes a pairing whose redemption went out and heard nothing, in the
   * background and with backoff (plan/protocol.md, "Invite redemption").
   *
   * Calling `pairWithInvite` again with the saved pending pairing is the
   * retry: the same device id and token, which the server answers `redeemed`
   * again if it registered them, even after the invite has expired. What each
   * outcome leaves:
   *
   *  - **`redeemed`**: the finished device is saved in place of the pending
   *    pairing, read back (rule 4), and returned for the loop to connect with.
   *  - **a refusal**, anything the server says trying again cannot change: the
   *    server registered nothing under this credential, so the pending pairing
   *    is removed, proven gone, and the panel says why and offers pairing
   *    again (`dropRefusedPairing`).
   *  - **anything else** is kept and tried again after a wait: no answer, a
   *    retryable refusal such as `busy`, or a server that could not be reached
   *    at all. That last one is the difference from a first attempt, which
   *    `pairWithInvite` forgets when nothing was sent: a pending pairing on
   *    disk is one whose redemption went out in some earlier attempt, and it
   *    may have committed. Forgetting it because the server is not reachable
   *    *now* would throw away the only copy of a registered row's token. So the
   *    store handed over here does not forget, and this decides instead.
   *
   * Resolves undefined when the pairing was refused, or when this run was
   * retired (unlink, unload, pause), which the backoff wait wakes for.
   */
  private async finishPairing(
    pending: PendingPairing,
    mine: number,
  ): Promise<DeviceConfig | undefined> {
    const current = () => this.running && mine === this.generation;
    const backoff = new Backoff();
    const store: PairingStore = {
      // The same save a pairing from the panel makes, so a pending pairing a
      // crash left beside an earlier pairing's index is finished without it.
      save: (config) => this.savePairing(mine, config),
      // Decided below, by what the refusal was. See the comment above.
      forget: async () => {},
    };
    while (current()) {
      this.setState({ kind: "pairing" });
      try {
        const device = await pairWithInvite(pending, store, { log });
        if (!current()) return undefined;
        this.config = device;
        this.failedPairing = undefined;
        return device;
      } catch (err) {
        if (!current()) return undefined;
        const error = err instanceof Error ? err : new Error(String(err));
        if (isFatal(error)) {
          await this.dropRefusedPairing(error, mine);
          return undefined;
        }
        backoff.fail();
        const wait = retryWait(error, backoff.delay());
        this.setState({ kind: "pairing", why: error.message, retryAt: Date.now() + wait });
        await this.backoffWait(wait, mine);
      }
    }
    return undefined;
  }

  /**
   * Waits out a backoff, unless the run is retired or somebody asks sooner.
   *
   * The same handle the reconnect loop uses (I05): `quiet`, `onunload` and a
   * pause wake it into a decision to stop, and Sync now wakes it into another
   * attempt.
   */
  private backoffWait(ms: number, mine: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        clearTimeout(timer);
        if (this.wakeLoop === wake) this.wakeLoop = undefined;
        resolve();
      };
      timer = setTimeout(wake, ms);
      if (mine === this.generation) this.wakeLoop = wake;
    });
  }

  /**
   * Removes a pending pairing the server refused for good, and says why.
   *
   * Nothing is left saved after a refusal (plan/protocol.md, "Invite
   * redemption"): a refusal writes nothing on the server, so the credential
   * saved here opens nothing, and a config holding it would be finished again
   * on every load only to be refused again. Removed through the same guarded
   * writer every pairing save goes through, and read back.
   */
  private async dropRefusedPairing(refusal: Error, mine: number): Promise<void> {
    try {
      await this.forgetDuringRun(mine);
    } catch (err) {
      if (mine !== this.generation) return;
      // Kept on disk, and the next load will be refused the same way. Stopped
      // rather than unpaired, because the pairing form would write over it.
      this.setState({
        kind: "stopped",
        why:
          `the pairing was refused (${refusal.message}), and the pairing saved in ` +
          `${this.dataPath} could not be removed: ${(err as Error).message}`,
      });
      return;
    }
    if (mine !== this.generation) return;
    this.config = undefined;
    this.failedPairing =
      `The pairing could not be finished: ${refusal.message}. ` +
      adviseAfterPairing({ remains: { kind: "nothing" }, surface: "panel", where: this.dataPath });
    this.setState({ kind: "unpaired" });
    new Notice(`TrewSync: ${this.failedPairing}`, 20_000);
  }

  /** One `runForever`, resolving with the refusal that ended it, if one did. */
  private async runOnce(config: DeviceConfig, mine: number): Promise<Error | undefined> {
    const current = () => mine === this.generation;
    let fatal: Error | undefined;
    await runForever(await this.clientOptions(config, mine), {
      onConnecting: (client) => {
        if (current()) {
          this.live = client;
          this.setState({ kind: "connecting" });
        } else void client.close();
      },
      onClient: (client) => {
        if (!current()) return;
        this.client = client;
        if (!client) return;
        // Renames made while there was no client, in the order they were
        // made, and ahead of the settle that follows this: the client queues
        // them before its first pass (T14).
        for (const [from, to] of this.renamesWaiting.splice(0)) void client.noteRename(from, to);
        this.everConnected = true;
        this.setState({ kind: "syncing", since: Date.now() });
        // Nothing to write back. The pairing that made this device settled
        // everything about its credential before it ever connected, and a
        // connection proves only what it says it proves.
      },
      onDisconnected: (cause, retryIn) => {
        if (!current()) return;
        this.working(undefined);
        this.setState({
          kind: "offline",
          why: cause.message,
          retryAt: Date.now() + retryIn,
          refused: false,
        });
      },
      onUnreachable: (cause, retryIn) => {
        if (!current()) return;
        this.working(undefined);
        this.setState({
          kind: "offline",
          why: cause.message,
          retryAt: Date.now() + retryIn,
          refused: !this.everConnected,
        });
      },
      onFatal: (cause) => {
        fatal = cause;
      },
      keepGoing: () => this.running && current(),
      // Ends the backoff wait rather than letting it run down (I05).
      // Obsidian disabling a plugin used to leave a timer and a closure alive
      // for whatever was left of a five-minute retry, because the loop asked
      // whether to keep going before the sleep and after it and did nothing
      // in between.
      onWaiting: (wake) => {
        if (current()) this.wakeLoop = wake;
      },
    });
    // An old backoff can finish after a settings change starts another run.
    // Its cleanup must leave the replacement run's reconnect handle intact.
    if (current()) {
      this.wakeLoop = undefined;
      this.live = undefined;
    }
    return fatal;
  }

  /**
   * A refusal that would be repeated word for word forever: a bad token, or
   * a cursor the server says is impossible. Retrying is a loop that never
   * ends and never says why.
   *
   * On a pairing that has never connected, the likeliest cause is the
   * pairing itself, and the one thing that fixes that is offered by name.
   *
   * The notice has no timeout, and one is up at a time: `setState` takes it
   * down when the state stops being this one.
   */
  private stop(cause: Error): void {
    this.working(undefined);
    const recovery = recoveryFor(cause);
    this.setState({
      kind: "stopped",
      why: cause.message,
      ...(recovery !== undefined ? { recovery } : {}),
    });
    this.stoppedNotice?.notice.hide();
    const notice = new Notice(
      recovery === "rejoin"
        ? `TrewSync has stopped: ${cause.message}. ${REJOIN_ADVICE}`
        : recovery === "pair-again"
          ? this.everConnected || cause instanceof TokenNotHere
            ? `TrewSync has stopped: ${cause.message}. ${PAIR_AGAIN_ADVICE}`
            : `TrewSync could not join this vault: ${cause.message}. If the invite was for another ` +
              `vault, or this device was revoked, open the TrewSync panel and pair it again with a ` +
              `new invite. This device's notes are kept.`
          : this.everConnected
            ? `TrewSync has stopped: ${cause.message}`
            : `TrewSync could not join this vault: ${cause.message}. ` +
              `If the invite was for another vault, or this device was revoked, unlink this vault ` +
              `from the TrewSync panel and pair it again with a new invite.`,
      0,
    );
    this.stoppedNotice = { notice, why: cause.message };
  }

  /**
   * Shows what is being worked on, without drowning the last real result.
   *
   * A pass over a settled vault visits every path and does nothing to any of
   * them, so reporting each one would replace a useful summary with a blur.
   * Fast passes keep the last result. Sustained work is shown even if no
   * individual path takes long, with text updates limited to five per second.
   */
  private working(path: string | undefined): void {
    this.workingPath = path;
    if (path === undefined) {
      this.workingTransfer = undefined;
      clearTimeout(this.workingTimer);
      this.workingTimer = undefined;
      this.workingSince = undefined;
      return;
    }
    this.scheduleWorking();
  }

  private scheduleWorking(): void {
    this.workingSince ??= Date.now();
    if (this.workingTimer !== undefined) return;
    this.workingTimer = setTimeout(() => {
      this.workingTimer = undefined;
      // The pass that asked is waiting on the answer, so it is not syncing,
      // whatever it said on its way to asking.
      if (this.review) return;
      this.setState({
        kind: "syncing",
        ...(this.workingPath ? { path: this.workingPath } : {}),
        ...(this.workingTransfer ? { transfer: this.workingTransfer } : {}),
        since: this.workingSince!,
      });
    }, 200);
  }

  private clearTimers(): void {
    if (this.nudgeTimer !== undefined) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    this.working(undefined);
  }

  private async clientOptions(config: DeviceConfig, mine: number): Promise<ClientOptions> {
    const current = () => mine === this.generation;
    const configDir = this.app.vault.configDir;
    // Held, because the pass callbacks below read what it stranded. The report
    // cannot carry that: a displaced version is something the adapter did, and
    // the engine is told only that a path was kept.
    const settings = this.settingsScope(config);
    const vault = new ObsidianVault(this.app.vault, configDir, log, {
      displacedLog: `${this.pluginDir()}/${DISPLACED_LOG}`,
      ...(config.ignore?.length ? { ignore: config.ignore } : {}),
      ...(settings !== undefined ? { settings: true } : {}),
    });
    // Whether this run is being measured, asked once. See `timingLog`.
    const timingLog = this.timingLog();
    const measuring = await this.app.vault.adapter.exists(timingLog).catch(() => false);
    const filesystemMs: Record<string, { ms: number; calls: number }> = {};
    let journal: JournalSaveCost | undefined;

    // Also held here, so the recovery surface can read the ledger and put a
    // hidden version back without a pass having to hand it over (Codex-08).
    this.liveVault = vault;
    return {
      vault: measuring ? timedVault(vault, filesystemMs) : vault,
      ...(measuring ? { timing: true } : {}),
      activePath: () => this.app.workspace.getActiveFile()?.path,
      store: this.indexStore(
        measuring
          ? {
              onSave: (cost) => {
                journal = cost;
              },
            }
          : {},
      ),
      // Which row this device connects as and which token proves it, worked
      // out in core so that both shells cannot answer it differently.
      ...credentialsFor(config),
      // A name Windows cannot hold arrives as a stranded path with its reason
      // rather than as a write that fails for ever (PLAN.md section 4.12).
      ...(Platform.isWin ? { windows: true } : {}),
      ...(settings !== undefined ? { settings } : {}),
      confirmFirstSync: (preview) => this.confirmSync(preview, "Review your first sync", current),
      confirmDeletions: (preview) => this.confirmSync(preview, "Review folder deletions", current),
      onActivity: (event) => {
        if (current()) this.activityLog?.add(event);
      },
      onSyncStart: () => {
        if (!current()) return;
        this.working(undefined);
        this.scheduleWorking();
      },
      onProgress: (path) => {
        if (!current()) return;
        // An undefined path ends file transfer, but flushing and saving the
        // index are still work. Only onPass/onSyncFailed end the busy state.
        this.workingPath = path;
        this.scheduleWorking();
      },
      onTransfer: (activity) => {
        if (!current() || this.workingSince === undefined) return;
        this.workingTransfer = activity;
        this.workingPath = activity?.path;
        this.scheduleWorking();
      },
      onCatchUp: (at) => {
        if (!current()) return;
        this.everConnected = true;
        this.setState({ kind: "loading", ...at });
      },
      // Every pass, from one place, whatever started it. The ticker and an
      // arriving batch start passes this shell never sees begin, and a
      // status set only by the passes it asked for stuck on "Working on X"
      // after any of the others.
      onPass: (report) => {
        if (!current()) return;
        // Appended after the state below, and deliberately not awaited: the
        // write is one more filesystem call and charging it to the pass it
        // describes would be the measurement measuring itself.
        if (measuring && report.phases) {
          const line = {
            at: Date.now(),
            waitedMs:
              this.measuringFrom === undefined ? null : performance.now() - this.measuringFrom,
            ...report.phases,
            filesystemMs,
            journal: journal ?? null,
            unchanged: report.unchanged,
            uploaded: report.uploaded,
            downloaded: report.downloaded,
            merged: report.merged,
            conflicted: report.conflicted,
            chunksSent: report.chunksSent,
            reusedChunks: report.reusedChunks,
          };
          // Serialised before the collectors are cleared, not after. `line`
          // holds a reference to `filesystemMs` rather than a copy, so
          // emptying it first produced a line that always said `{}`.
          const text = `${JSON.stringify(line)}\n`;
          this.measuringFrom = undefined;
          journal = undefined;
          for (const op of Object.keys(filesystemMs)) delete filesystemMs[op];
          void this.app.vault.adapter.append(timingLog, text).catch(() => undefined);
        }
        this.working(undefined);
        this.setState({
          kind: "synced",
          summary: summarise(report),
          at: Date.now(),
          // The same pair the exit code is built from and the same pair the
          // needs-attention list holds, through the one helper, so the glyph,
          // the sentence and the notice cannot start counting different things.
          refused: needsAttention(report),
          pending: report.retrying,
          ...(report.nextUploadAt !== undefined ? { pendingAt: report.nextUploadAt } : {}),
          waiting: vault.stranded.length,
          recoveryUnknown: vault.recovery.complete ? undefined : vault.recovery.why,
          // Kept, so the reason survives the notice that showed it. A refusal
          // used to exist for twenty seconds and then be a number.
          issues: report.needsAttention ?? [],
          retryingPaths: report.retryingPaths ?? [],
        });
        this.announce(report, vault.displaced, vault.recovery);
        void this.activityLog?.flush();
      },
      // A pass that failed outright, from wherever it was started (F16).
      //
      // The ticker and an arriving batch start passes this shell never sees
      // begin, and their exceptions were swallowed, so a device that
      // connected and then failed every pass went on showing the status of
      // the last one that worked. `onPass` never fires for those, so nothing
      // moved the status at all.
      onSyncFailed: (err) => {
        if (!current()) return;
        this.passFailed(err.message);
      },
      // The engine's running commentary, which had nowhere to go.
      //
      // These are the lines that say why something did not sync: a file
      // written off for good, a path that is a file here and a folder
      // there, a retry and its reason, a platform that cannot stream. With
      // no log they went nowhere, so a vault with one file missing looked
      // exactly like a vault with none missing, and the only way to find
      // out was to attach a debugger.
      log,
    };
  }

  /**
   * This plugin's own folder, under Obsidian's config directory.
   *
   * `manifest.dir` is optional in the API. Interpolating it without looking
   * produces the literal path "undefined/index.json" at the vault root, which
   * is a perfectly ordinary folder as far as the never-sync list is concerned.
   * So it is checked, and a folder outside the config directory stops the
   * plugin rather than being used.
   */
  private pluginDir(): string {
    const configDir = this.app.vault.configDir;
    const dir = this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`;
    if (dir !== configDir && !dir.startsWith(`${configDir}/`)) {
      throw new Error(
        `refusing to run: this plugin is installed at ${dir}, which is outside ${configDir}, ` +
          `so its index would sync to every other device`,
      );
    }
    return dir;
  }

  /**
   * Where the index goes: inside this plugin's own folder.
   *
   * That folder is under Obsidian's config directory, which never syncs, and
   * an index that synced would sync to itself and be overwritten by every
   * other device in turn.
   */
  private indexStore(opts: JournalStoreOptions = {}): ObsidianIndexStore {
    return new ObsidianIndexStore(this.app.vault.adapter, `${this.pluginDir()}/index.json`, opts);
  }

  /**
   * Where a measured run writes its lines, and the switch that turns one on.
   *
   * The file's existence is the switch. Creating it is `adb push` of an empty
   * file, reading it is `adb pull`, and turning it off is deleting it. There
   * is no setting and no `data.json` key: a key would have to survive the
   * read-back `saveVerified` does, and a settings row would be a permanent
   * surface for a question asked once (docs/open-work.md).
   *
   * Costs one `exists` per client start when absent, and nothing after that.
   */
  private timingLog(): string {
    return `${this.pluginDir()}/pass-timings.ndjson`;
  }

  /** Where Obsidian keeps this plugin's settings, for a message that names it. */
  get dataPath(): string {
    try {
      return `${this.pluginDir()}/data.json`;
    } catch {
      return `${this.manifest.dir ?? "this plugin's folder"}/data.json`;
    }
  }

  /**
   * Asks the live client to look, soon.
   *
   * Coalesced, because saving one file produces several events and copying a
   * folder in produces one per file. Without this the engine would start a
   * pass per event and spend the copy re-scanning.
   */
  private nudge(path?: string): void {
    // The first event of a batch, which is the one somebody was waiting on.
    // Several saves coalesce into one pass, so the last would understate the
    // wait and an average would describe nobody.
    if (this.measuringFrom === undefined) this.measuringFrom = performance.now();
    if (path !== undefined) this.client?.noteChanged(path);
    // Bound the wait from the first event. Resetting on every event let a
    // busy vault postpone syncing indefinitely until the fallback poll.
    if (!this.client || this.nudgeTimer !== undefined) return;
    const mine = this.generation;
    // Plain setTimeout rather than window's. Obsidian runs in a renderer
    // where both exist, and the plain one also exists everywhere this can be
    // tested, which is the difference between a tested nudge and an
    // untested one.
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      if (mine !== this.generation) return;
      void this.client?.sync().then((report) => {
        // The state is set by onPass when the pass finished. When it did
        // not, nothing else would clear "Working on X".
        if (report === undefined && mine === this.generation) {
          this.passFailed("the last pass did not finish; the developer console has the reason");
        }
      });
    }, SYNC_EVENT_DELAY_MS);
  }

  /**
   * Offers the server every body this device holds, for the ones it has lost
   * (I14).
   *
   * The same operation as `trew repair`, and it is here for the reason
   * `rejoin` is: the documented alternative for a plugin device was nothing at
   * all. A phone can perfectly well be the last machine holding a body the
   * server no longer has, and it has no shell to run the CLI in.
   *
   * Writes no version, so there is no generation dance around it: a repair
   * changes nothing about this vault's state and cannot leave a stale result
   * speaking for a vault that has since been unlinked. The panel disables the
   * button while it runs, which is the whole of the concurrency here.
   */
  async repair(): Promise<RepairReport> {
    const client = this.client;
    if (!client) throw new Error(this.whyNoClient());
    return client.repair();
  }

  /**
   * Renames this device, on the server and then here, and restarts the loop.
   *
   * The order is `client.rename`'s: the server first, because the device list
   * is what another person reads and what this device cannot repair while
   * offline, and a local name that ran ahead would have this device writing
   * conflict copies under a label the vault does not know.
   *
   * The restart is the part that is easy to leave out. The engine is handed
   * `device` when it is built and says it in every hello, which is the name
   * the server records on this device's versions and so the name every
   * conflict copy of them carries, and it reads it again for each copy of
   * what is on this disk. A config saved under a running loop renames the
   * device list and nothing else: the next copy still carries the old name,
   * and it does until Obsidian is restarted. That is a rename that half
   * worked and said it worked.
   *
   * A reconnect costs a handshake, once, for something done rarely. The
   * alternative is threading a mutable name through the engine so a pass in
   * flight can change what it calls this device halfway, which is worse: two
   * copies of one divergence would be named differently.
   */
  async renameDevice(name: string): Promise<string> {
    if (this.unlinking) throw new Error("This vault is being unlinked.");
    if (this.editingConnection) throw new Error("Another settings change is in progress.");
    this.editingConnection = true;
    try {
      const client = this.client;
      if (!client) throw new Error(this.whyNoClient());
      const config = this.config;
      if (!config) throw new Error("this vault is not paired yet.");
      const mine = this.generation;

      const said = await client.rename(name);
      try {
        await this.saveDuringRun(mine, { ...config, device: said });
      } catch (err) {
        // Both halves. "Renamed" and "written down here" are different facts and
        // the visible consequence of the second failing is conflict copies that
        // still say the old name, which is not something to discover from a
        // filename later.
        throw new Error(
          `the device list now says ${said}, and this device could not write it down: ` +
            `${(err as Error).message}. Conflict copies made here will still say ` +
            `${config.device} until this is done again.`,
        );
      }
      if (mine !== this.generation)
        throw new Error("the pairing changed while renaming this device");
      this.config = { ...config, device: said };

      // `quiet` and then `start`, which is what rebase does and for a related
      // reason: a run that is merely disconnected reconnects, and a pass
      // in flight is still writing under the old name. `stop` is not the way to
      // do this, because it puts "TrewSync has stopped" and a cause on screen, and
      // nothing here has gone wrong.
      await this.quiet();
      if (this.generation === mine + 1) this.start();
      return said;
    } finally {
      this.editingConnection = false;
    }
  }

  /** Move this pairing to a new address without resetting its sync history. */
  async changeServerAddress(address: string): Promise<void> {
    if (this.unlinking) throw new Error("This vault is being unlinked.");
    if (this.editingConnection) throw new Error("Another settings change is in progress.");
    this.editingConnection = true;
    try {
      const config = this.config;
      if (!config || !this.paired) throw new Error("this vault is not paired yet.");
      const next = { ...config, url: normaliseUrl(address) };
      if (next.url === config.url) return;
      let mine = this.generation;
      const stillCurrent = () => mine === this.generation && this.config === config;

      // Connect with the existing device credential. This connection applies
      // no changes, so an incorrect address cannot replace the pairing or index.
      await proveConnects(next, 15_000);
      if (!stillCurrent()) throw new Error("the pairing changed while checking the server address");

      mine++;
      await this.quiet();
      if (!stillCurrent()) throw new Error("the pairing changed while updating the server address");
      try {
        // Unlink waits for a save already in flight; a retired run cannot start one.
        await this.saveDuringRun(mine, next);
      } catch (err) {
        if (mine === this.generation) {
          this.setState({
            kind: "stopped",
            why: `the server address could not be saved and verified: ${(err as Error).message}. Reopen Obsidian to reload the saved settings`,
          });
        }
        throw err;
      }
      if (!stillCurrent()) throw new Error("the pairing changed while saving the server address");
      this.config = next;
      this.start();
    } finally {
      this.editingConnection = false;
    }
  }

  /** The folder and file names this device leaves alone, beyond the dot rule. */
  get ignoredNames(): readonly string[] {
    return this.config?.ignore ?? [];
  }

  /**
   * Changes what this device skips, and restarts sync under the new list.
   *
   * Per device and never sent anywhere (R083-13): a phone can leave a folder
   * of attachments alone while the desktop keeps it, which is what Obsidian
   * Sync and LiveSync both offer and what a person with a large media folder
   * has otherwise no way to ask for here.
   *
   * The restart is not decoration. The ignore set is read when the vault
   * adapter is built, so a list changed under a running client would be a
   * client listing one set of files and reporting against another.
   *
   * Adding a name does not delete anything. What was already synced stays on
   * the server and on every other device; this device stops listing it, and
   * the pass counts it as `ignored`, which is out of the exit code and out of
   * the attention list. Removing a name puts it back in the listing, and the
   * next pass reconciles it like any other path.
   */
  async setIgnoredNames(names: readonly string[]): Promise<void> {
    if (this.unlinking) throw new Error("This vault is being unlinked.");
    if (this.editingConnection) throw new Error("Another settings change is in progress.");
    this.editingConnection = true;
    try {
      const config = this.config;
      if (!config || !this.paired) throw new Error("this vault is not paired yet.");
      const wanted = [...new Set(names.map((name) => name.trim()))].filter((name) =>
        isIgnorableName(name),
      );
      wanted.sort();
      if (JSON.stringify(wanted) === JSON.stringify([...(config.ignore ?? [])].sort())) return;
      const next: DeviceConfig = { ...config, ignore: wanted };
      const mine = this.generation + 1;
      await this.quiet();
      if (this.generation !== mine || this.config !== config) {
        throw new Error("the pairing changed while saving what this device skips");
      }
      try {
        await this.saveDuringRun(mine, next);
      } catch (err) {
        if (mine === this.generation) {
          this.setState({
            kind: "stopped",
            why: `what this device skips could not be saved: ${(err as Error).message}. Reopen Obsidian to reload the saved settings`,
          });
        }
        throw err;
      }
      // Again, after the save, the way `changeServerAddress` does. An unlink
      // started while the save was in flight has already taken the generation,
      // removed the index and written the config away; starting here would run
      // a client against a vault that no longer exists while the panel says
      // this device is unpaired.
      if (this.unlinking || this.generation !== mine || this.config !== config) {
        throw new Error("the pairing changed while saving what this device skips");
      }
      this.config = next;
      this.start();
    } finally {
      this.editingConnection = false;
    }
  }

  /**
   * What this device syncs of its settings (plan/settings-sync.md): nothing
   * unless turned on here, and nothing from a settings folder whose name
   * settings sync cannot use.
   */
  private settingsScope(config: DeviceConfig): SettingsScope | undefined {
    const root = this.settingsRoot;
    if (config.settings !== true || root === undefined) return undefined;
    return { root, ...(config.settingsFirstChoice ? { firstChoice: config.settingsFirstChoice } : {}) };
  }

  /** Whether this device syncs its Obsidian settings, as saved. */
  get syncsSettings(): boolean {
    return this.config?.settings === true;
  }

  /** The settings folder this device runs, when settings sync can use it. */
  get settingsRoot(): string | undefined {
    return profileRootOf(this.app.vault.configDir);
  }

  /** Settings changes from other devices waiting for Apply and reload, as of the last pass. */
  get settingsHeld(): number {
    return this.announced.settings;
  }

  /**
   * Turns settings sync on or off for this device, and restarts sync under
   * it, as `setIgnoredNames` does for what this device skips: the vault
   * adapter is built knowing whether it lists the settings folder.
   *
   * Turning it on keeps a copy of this device's settings first, read back
   * before anything else happens (rule 3): where the server's settings are
   * chosen, they replace these with no copy beside them, and the person who
   * chose that may still want one setting back. Returns where the copy is.
   */
  async setSettingsSync(on: boolean, firstChoice?: "server" | "device"): Promise<string | undefined> {
    if (this.unlinking) throw new Error("This vault is being unlinked.");
    if (this.editingConnection) throw new Error("Another settings change is in progress.");
    this.editingConnection = true;
    try {
      const config = this.config;
      if (!config || !this.paired) throw new Error("this vault is not paired yet.");
      const root = this.settingsRoot;
      if (on && root === undefined) {
        throw new Error(
          `settings sync cannot use this device's settings folder, ${this.app.vault.configDir}. ` +
            "It syncs .obsidian, or .obsidian- and a name in lower case letters, digits and dashes.",
        );
      }
      const next: DeviceConfig = on
        ? { ...config, settings: true, ...(firstChoice ? { settingsFirstChoice: firstChoice } : {}) }
        : { ...config, settings: false };
      if (
        (config.settings === true) === on &&
        (!on || firstChoice === undefined || firstChoice === config.settingsFirstChoice)
      ) {
        return undefined;
      }
      const mine = this.generation + 1;
      await this.quiet();
      if (this.generation !== mine || this.config !== config) {
        throw new Error("the pairing changed while changing settings sync");
      }
      let backup: string | undefined;
      if (on && root !== undefined) {
        try {
          const kept = await backUpSettings(this.app.vault.adapter, root, this.pluginDir(), new Date());
          backup = kept.files > 0 ? kept.folder : undefined;
        } catch (err) {
          // Nothing changed, so sync goes on as it was.
          this.start();
          throw new Error(
            `settings sync was not turned on: this device's settings could not be copied first (${(err as Error).message})`,
          );
        }
      }
      try {
        await this.saveDuringRun(mine, next);
      } catch (err) {
        if (mine === this.generation) {
          this.setState({
            kind: "stopped",
            why: `settings sync could not be saved: ${(err as Error).message}. Reopen Obsidian to reload the saved settings`,
          });
        }
        throw err;
      }
      if (this.unlinking || this.generation !== mine || this.config !== config) {
        throw new Error("the pairing changed while changing settings sync");
      }
      this.config = next;
      this.announced.settings = 0;
      this.start();
      return backup;
    } finally {
      this.editingConnection = false;
    }
  }

  /**
   * Writes the settings changes waiting here, then reloads Obsidian so it
   * reads them (plan/settings-sync.md, section 4). Open notes are saved
   * first, because a reload does not wait for a note's pending save. The
   * engine that starts after the reload checks each applied setting is still
   * what was written, and puts it back if Obsidian wrote its old one over it.
   */
  async applySettings(): Promise<void> {
    const client = this.client;
    if (!client) throw new Error(this.whyNoClient());
    await this.saveOpenEditors();
    await client.settle({ applySettings: true, coalesceWrites: false });
    await this.quiet();
    reloadObsidian();
  }

  /** `applySettings`, from a command or a notice, with any failure said. */
  applySettingsNow(): void {
    void this.applySettings().catch((err: unknown) => {
      new Notice(`TrewSync: the settings were not applied: ${(err as Error).message}`, 10_000);
    });
  }

  /**
   * Makes `.obsidian-<name>` a copy of the settings folder this device runs,
   * plugins and this plugin included, for this device to run instead, which
   * is how a phone keeps settings apart from the desktops'
   * (plan/settings-sync.md, section 2). Sync stops first, so the index copied
   * is the one the copy carries on from, and stays stopped: the next thing
   * to happen is Obsidian relaunching into the new folder.
   */
  async createSettingsProfile(name: string): Promise<string> {
    if (!isProfileName(name)) {
      throw new Error(
        "a profile name is 1 to 32 lower case letters, digits and dashes, starting with a letter or digit",
      );
    }
    if (this.unlinking) throw new Error("This vault is being unlinked.");
    if (this.editingConnection) throw new Error("Another settings change is in progress.");
    this.editingConnection = true;
    try {
      const from = this.app.vault.configDir.replace(/^\/+|\/+$/g, "");
      const to = `.obsidian-${name}`;
      if (from === to) throw new Error(`this device already runs ${to}`);
      await this.quiet();
      const index = `${this.pluginDir()}/index.json`;
      try {
        await createProfile(this.app.vault.adapter, from, to, [index, indexLogPath(index)]);
      } catch (err) {
        this.start();
        throw err;
      }
      this.setState({
        kind: "stopped",
        why:
          `sync is paused until Obsidian runs ${to}. Open Settings, Files and links, ` +
          `Override config folder, enter ${to} and tap Relaunch`,
      });
      return to;
    } finally {
      this.editingConnection = false;
    }
  }

  /** Syncs on demand, and says so, because a command with no feedback is a guess. */
  syncNow(verifyContents = false): Promise<void> {
    if (this.manualSync) {
      return verifyContents ? this.manualSync.then(() => this.syncNow(true)) : this.manualSync;
    }
    const work = this.syncOnDemand(verifyContents);
    this.manualSync = work;
    void work.then(
      () => {
        if (this.manualSync === work) this.manualSync = undefined;
      },
      () => {
        if (this.manualSync === work) this.manualSync = undefined;
      },
    );
    return work;
  }

  private async syncOnDemand(verifyContents = false): Promise<void> {
    // A pass is already waiting, on a question only a person can answer.
    if (this.review) {
      this.showReview();
      return;
    }
    if (!this.config) {
      new Notice("TrewSync: this vault is not paired yet.");
      new TrewModal(this).open();
      return;
    }
    // The same for a device the server has refused: the panel is where the way
    // back is, and a sync that cannot happen is not something to try.
    if (offersPairAgain(this.state)) {
      new Notice(`TrewSync: ${this.whyNoClient()}`);
      new TrewModal(this).open();
      return;
    }
    if (this.paused) {
      await this.togglePause();
      return;
    }
    const client = this.client;
    if (!client) {
      if (this.running && this.state.kind === "offline" && this.wakeLoop) {
        this.setState({ kind: "connecting" });
        this.wakeLoop();
        new Notice("TrewSync: reconnecting…");
        return;
      }
      // The same for a pairing waiting out its backoff: somebody who has just
      // fixed the network should not have to wait five minutes to find out.
      if (
        this.running &&
        this.state.kind === "pairing" &&
        this.state.retryAt !== undefined &&
        this.wakeLoop
      ) {
        this.setState({ kind: "pairing" });
        this.wakeLoop();
        new Notice("TrewSync: trying to finish the pairing again…");
        return;
      }
      new Notice(`TrewSync: ${this.whyNoClient()}`);
      return;
    }
    // Numbered like every other run. A pass takes as long as it takes, and
    // unlinking during one used to leave its result speaking for a vault
    // that is no longer paired: a summary notice over an unpaired panel, or
    // `failed` painted over `unpaired` when the closed client rejected.
    const mine = this.generation;
    // The write debounce is off for this one. It exists so that somebody
    // typing does not cause a push per keystroke, and the person who just
    // chose "sync now" has said otherwise. Reporting "up to date" while
    // their last paragraph sits unsent is the status rule 7 forbids.
    let report: SyncReport;
    this.setState({ kind: "syncing", since: Date.now() });
    try {
      await this.saveOpenEditors();
      if (mine !== this.generation || this.client !== client) return;
      report = await client.settle({ coalesceWrites: false, verifyContents, retryFailures: true });
    } catch (err) {
      if (mine !== this.generation) return;
      // Both callers discarded this promise, so a pass that threw was a
      // person pressing a button and nothing happening.
      this.passFailed((err as Error).message);
      new Notice(`TrewSync: sync failed: ${(err as Error).message}`, 10_000);
      return;
    }
    if (mine !== this.generation) return;
    // The state was set by onPass, once per pass. This is the feedback the
    // command owes.
    new Notice(`TrewSync: ${summarise(report)}`);
  }

  /**
   * Saves every open editor, so what was typed inside the autosave delay is
   * on the disk for whatever is about to read it.
   *
   * The editor's autosave has its own delay. A manual sync must include those
   * buffers, not just the previous version already on disk, and so must an
   * undo, which sends this device's changes first and then writes into the
   * very notes the editors may be holding (T15). A save that fails fails the
   * caller: the unsent text is still only in the editor.
   */
  private async saveOpenEditors(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      // Deferred background tabs have no editor or save method. A leaf can
      // also change views while an earlier editor is being saved.
      const view = leaf.view as Partial<MarkdownView>;
      if (typeof view.save === "function") await view.save();
    }
  }

  private passFailed(why: string): void {
    this.activityLog?.add({ at: Date.now(), action: "error" });
    void this.activityLog?.flush();
    this.working(undefined);
    this.setState({ kind: "failed", why, at: Date.now() });
  }

  /**
   * Why there is no connection to use, in the words that fit the state.
   *
   * "It will sync as soon as it reconnects" was shown while stopped, which is
   * the one state in which it will not.
   */
  private whyNoClient(): string {
    switch (this.state.kind) {
      case "paused":
        return "Sync is paused. Resume it from the TrewSync menu.";
      case "stopped":
        return this.state.recovery === "pair-again"
          ? `TrewSync has stopped: ${this.state.why}. ${PAIR_AGAIN_ADVICE}`
          : `TrewSync has stopped: ${this.state.why}. It will not reconnect until that is fixed.`;
      case "connecting":
        return "still connecting to the server.";
      case "loading":
        return "loading sync history. Keep Obsidian open; your notes will sync next.";
      case "pairing":
        return "this vault's pairing has not finished yet. TrewSync is finishing it and will sync once it has.";
      case "unpaired":
        return "this vault is not paired yet.";
      default:
        return "not connected. It will sync as soon as it reconnects.";
    }
  }

  /**
   * Tells the user about the things that need a person.
   *
   * A conflict is an event and is announced each time it happens. A file
   * written off, or one blocked by a name that is a file here and a folder
   * there, is a state: it is true on every pass until somebody acts, and a
   * notice on every pass for it taught people to dismiss notices, which is
   * how the one that matters gets dismissed too. Those are announced when
   * the count or the names change and not otherwise.
   */
  private announce(
    report: SyncReport,
    waiting: readonly Displaced[] = [],
    recovery: Inventory = { waiting: [], complete: true },
  ): void {
    // Before the list, because it is the one that says the list may be short.
    // Keyed on the reason so a persistent fault is announced once.
    if (!recovery.complete) {
      const why = recovery.why ?? "the record could not be established";
      if (why !== this.announced.unknown) {
        this.announced.unknown = why;
        new Notice(
          `TrewSync cannot tell whether any notes are waiting to be recovered: ${why}. ` +
            `Notes may be sitting in a hidden folder with nothing pointing at them.`,
          30_000,
        );
      }
    } else {
      this.announced.unknown = "";
    }
    // First, because it is the only one of these that means a note is not
    // where its author left it. Keyed on the paths rather than the count, for
    // the reason the attention notice is: one rescued in the same pass as
    // another appears leaves the number where it was, and the new one would
    // go unannounced for as long as they matched.
    const waitingKey = waiting.map((d) => `${d.at} ${d.from}`).join("\n");
    if (waitingKey !== this.announced.waiting) {
      this.announced.waiting = waitingKey;
      if (waiting.length > 0) {
        const first = waiting[0]!;
        const rest = waiting.length - 1;
        new Notice(
          `TrewSync kept ${waiting.length} ${waiting.length === 1 ? "version" : "versions"} ` +
            `somewhere Obsidian does not show. ${first.from} is at ${first.at}` +
            `${rest > 0 ? `, and ${rest} more` : ""}. ${first.why}.`,
          30_000,
        );
      }
    }
    if (report.conflicted > 0) {
      const n = report.conflicted;
      const notice = new Notice(
        `TrewSync kept both versions of ${n} ${n === 1 ? "file" : "files"}. ` +
          `Tap here, or run "Review conflicts", to compare and choose.`,
        10_000,
      );
      // The review already existed, and the notice used to send people
      // hunting the file explorer for "Conflicted copy" instead. A tap on a
      // notice also dismisses it, which is what should happen here.
      // `messageEl` arrived in Obsidian 1.8.7; before it the text alone says
      // where to go.
      if (requireApiVersion("1.8.7"))
        notice.messageEl.addEventListener("click", () => this.openConflicts());
    }
    // A state, so said when the count changes and not on every pass.
    if (report.settingsHeld !== this.announced.settings) {
      this.announced.settings = report.settingsHeld;
      const n = report.settingsHeld;
      if (n > 0) {
        const notice = new Notice(
          `TrewSync: ${n} ${n === 1 ? "setting" : "settings"} from another device ` +
            `${n === 1 ? "is" : "are"} waiting. Tap here, or run "Apply synced settings and reload", ` +
            "to use them. Obsidian reloads to apply settings.",
          15_000,
        );
        if (requireApiVersion("1.8.7"))
          notice.messageEl.addEventListener("click", () => this.applySettingsNow());
      }
    }
    // One notice where there were two, for the reason on the report's
    // `needsAttention`: "written off" and "blocked by a name" are two of our
    // categories and one of a person's, and it was the two notices that made
    // somebody learn the difference before they could act. What differs is the
    // reason, and the reason is now what the notice carries.
    //
    // Keyed on which files and which reasons, not how many (N2). One file
    // fixed in the same pass as another starts failing leaves the count where
    // it was, and the new failure went unannounced for as long as the numbers
    // matched: the glyph said something was wrong and nothing ever said what.
    //
    // `?? []` because the type promises the list and a hand-built report may
    // not keep it: announcing must never throw over the notice it owes.
    const attention = report.needsAttention ?? [];
    const count = needsAttention(report);
    const key =
      count === 0 ? "" : `${count}:${attention.map((a) => `${a.path} ${a.why}`).join("\n")}`;
    if (key !== this.announced.attention) {
      this.announced.attention = key;
      if (count > 0) {
        // Named, because a count is not something anybody can act on. The
        // list is bounded, so `attentionLines` says when it is not the whole
        // of it. A report that named nothing still says the count.
        const detail = attentionLines(report).join(" ");
        new Notice(
          `TrewSync cannot sync ${count} file(s).${detail === "" ? "" : ` ${detail}`}`,
          20_000,
        );
      }
    }
  }

  /* ------------------------------------------------------------ *
   * Pairing
   * ------------------------------------------------------------ */

  private async readConfig(): Promise<DeviceConfig | undefined> {
    const raw: unknown = await this.loadData();
    // Obsidian returns null for a missing data.json, but undefined after a
    // failed read or JSON parse. The latter must not permit a new pairing.
    if (raw === undefined) throw new Error(`Obsidian could not read ${this.dataPath}`);
    if (raw === null) return undefined;
    const where = "the TrewSync plugin's saved settings";
    this.secretPending = undefined;
    this.secretsAdopted = [];
    const marker = typeof raw === "object" ? (raw as Record<string, unknown>)[TOKEN_IN] : undefined;
    if (marker === IN_KEYCHAIN_PENDING) {
      // The token is in the file, and a copy in the keychain that no start
      // has yet been seen to load. The file's is the one that counts.
      const record = raw as Record<string, unknown>;
      const config = decodeConfig(raw, where);
      if (config.deviceId !== undefined && config.deviceToken !== undefined) {
        const id = secretIdFor(this.vaultName(), config.deviceId);
        const writtenAt = record[WRITTEN_AT];
        this.secretInUse = id;
        this.secretPending = { id, writtenAt: typeof writtenAt === "string" ? writtenAt : "" };
        // Written under the vault's old name, if it has been renamed since;
        // the same token, so the copy is this device's, and it goes once the
        // token is saved under the new name.
        this.secretsAdopted = this.renamedFrom(config.deviceId, id).filter(
          (old) => this.keychainToken(old) === config.deviceToken,
        );
      }
      return config;
    }
    if (marker !== IN_KEYCHAIN) return decodeConfig(raw, where);
    return this.withKeychainToken(raw as Record<string, unknown>, where);
  }

  /**
   * A saved config whose token is in the keychain, with the token put back.
   *
   * The id is worked out from this vault's name and the saved device id, not
   * read from the file, so a copy of the vault names the secret its own name
   * gives it and finds nothing (PLAN.md section 2.3). On a desktop the keychain
   * is the vault's own, and a copy finds nothing whatever it is called.
   *
   * Nothing found is not an unreadable file and not an unpaired vault (rule
   * 2). The config is kept without its token, and without the invite of a
   * pairing still being finished, since that cannot be finished with a
   * credential that is not here. `runLoop` stops on it and the panel offers a
   * new pairing, which writes over this one only once it is saved and read
   * back. Every note stays where it is.
   */
  private withKeychainToken(raw: Record<string, unknown>, where: string): DeviceConfig {
    const record: Record<string, unknown> = { ...raw };
    delete record[TOKEN_IN];
    const deviceId = record["deviceId"];
    const keychain = keychainOf(this.app);
    const id = typeof deviceId === "string" ? secretIdFor(this.vaultName(), deviceId) : undefined;
    const token =
      keychain !== undefined && id !== undefined ? tokenInKeychain(keychain, id) : undefined;
    if (record["deviceToken"] === undefined && token !== undefined) record["deviceToken"] = token;
    // Renamed, where the keychain is the vault's own: the token is under the
    // old name, and nothing but this vault can have put it there (see
    // `renamedFrom`). Taken only when every such secret agrees on it.
    let stranded: string[] = [];
    if (record["deviceToken"] === undefined && typeof deviceId === "string" && id !== undefined) {
      stranded = keychain === undefined ? [] : secretsForDevice(keychain, deviceId, id);
      const adoptable = this.renamedFrom(deviceId, id);
      const tokens = new Set(adoptable.map((old) => this.keychainToken(old)));
      if (adoptable.length > 0 && tokens.size === 1) {
        record["deviceToken"] = [...tokens][0];
        this.secretsAdopted = adoptable;
      }
    }
    if (record["deviceToken"] !== undefined) {
      const config = decodeConfig(record, where);
      if (token !== undefined) {
        this.secretInUse = id;
        // Loaded by this start of the app, or put there by the start that
        // made this record, which wrote it only once a start had loaded it.
        this.secretStored = id;
      }
      return config;
    }
    delete record["invite"];
    const config = decodeConfig(record, where);
    const device = typeof record["device"] === "string" ? record["device"] : "this device";
    tokenNotHere.set(
      config,
      keychain === undefined
        ? "this device's token was kept in Obsidian's keychain, and this Obsidian has none"
        : stranded.length > 0
          ? `this device's token is not in Obsidian's keychain under this vault's name. The ` +
            `keychain holds ${stranded.join(", ")} for this device under another vault's ` +
            "name, which is what renaming a vault leaves, and a copy of one on this device too. " +
            "Pair this vault again; then, if it was renamed, revoke the device " +
            `"${device}" from another device's list of devices and remove ` +
            `${stranded.join(", ")} in Settings, Keychain`
          : "this device's token is not in Obsidian's keychain on this device. That is what a " +
            "copy of the vault, a vault that was renamed or a keychain that was cleared looks like",
    );
    return config;
  }

  /**
   * Secrets for this device under another vault name that may be taken as
   * this vault's: on a desktop, where the keychain is the vault's own
   * (keychain.ts), so the only way one got there is this vault under an
   * earlier name. Never on a phone, where every vault shares the keychain and
   * a copy of this vault would find the original's secret the same way and
   * connect as it.
   */
  private renamedFrom(deviceId: string, id: string): string[] {
    const keychain = keychainOf(this.app);
    if (keychain === undefined || Platform.isMobileApp) return [];
    return secretsForDevice(keychain, deviceId, id);
  }

  /** The token a keychain id holds here, or undefined. */
  private keychainToken(id: string): string | undefined {
    const keychain = keychainOf(this.app);
    return keychain === undefined ? undefined : tokenInKeychain(keychain, id);
  }

  /** The vault's name, which scopes its secret in a keychain every vault may share. */
  private vaultName(): string {
    return this.app.vault.getName();
  }

  /**
   * Whether a pairing may be made now, and if not, why not.
   *
   * Pairing again would write a new credential over the one this vault holds,
   * and that credential may be the only copy of a live row's token. That holds
   * for a config that is there, for one that is there but unreadable, for a
   * pairing still being finished in the background, and while a pairing is
   * being made from the panel: two presses of the button used to make two
   * credentials, the second winning on disk while the first was the one
   * running.
   *
   * The one paired vault that may pair again is one the server has refused
   * for good (`pair-again`): its credential opens nothing now, so writing
   * the new pairing over it strands nothing this device could still use.
   */
  private refuseUnlessPairable(): void {
    if (this.unlinking) throw new Error("This vault is being unlinked.");
    if (this.unreadable !== undefined) {
      throw new Error(
        `the saved settings at ${this.dataPath} could not be read (${this.unreadable}), ` +
          `and pairing over them would replace the credential they hold. Fix or move that file, then reload the plugin.`,
      );
    }
    if (this.pendingPairing !== undefined) {
      throw new Error(
        "this vault has a pairing that is still being finished. Wait for it, or unlink this " +
          "vault in the TrewSync panel to give it up and pair again.",
      );
    }
    if (this.paired && !offersPairAgain(this.state)) {
      throw new Error("this vault is already paired");
    }
    if (this.pairing) throw new Error("a pairing is already in progress");
  }

  /** Runs one pairing at a time. */
  private async onePairing<T>(work: () => Promise<T>): Promise<T> {
    this.refuseUnlessPairable();
    const run = work();
    this.pairing = run;
    try {
      return await run;
    } finally {
      this.pairing = undefined;
    }
  }

  /**
   * Where a pairing's progress is kept: this plugin's data.json, through the
   * guarded writer every config save goes through.
   *
   * `save` writes and reads back (rule 4), and refuses once this run has been
   * retired, so an unlink or an unload cannot be overtaken by a pairing still
   * in flight (R10). `forget` removes the saved config and reads the file back
   * to prove it gone.
   */
  private pairingStore(mine: number): PairingStore {
    return {
      save: (config) => this.savePairing(mine, config),
      forget: () => this.forgetDuringRun(mine),
    };
  }

  /**
   * Saves a pairing, and after a pending one, removes any index beside it.
   *
   * An index beside a pending pairing is always another pairing's: nothing
   * syncs until the pending one is finished, so nothing has written an index
   * for it. Pairing again over a revoked pairing leaves exactly that for a
   * moment, because the new pairing is written first and the old index removed
   * after it (rule 3: nothing goes before what replaces it is on disk, read
   * back). A crash in that moment, finished on the next load, would otherwise
   * carry on from the revoked pairing's cursor: every deletion made while this
   * device could not hear of it would land on notes it still holds, after a
   * merge that said such files may come back. So the index goes here, on every
   * save of a pending pairing and before its redemption is sent, and a failure
   * to remove it is a failure to save.
   */
  private async savePairing(mine: number, config: DeviceConfig): Promise<void> {
    await this.saveDuringRun(mine, config);
    if (!isPendingPairing(config)) return;
    if (mine !== this.generation) throw new Error("this vault is no longer paired");
    try {
      await this.trackStateWrite(this.indexStore().remove());
    } catch (err) {
      throw new Error(
        `the index a previous pairing left in ${this.pluginDir()} could not be removed: ` +
          (err as Error).message,
      );
    }
  }

  /**
   * Joins a vault by redeeming an invite.
   *
   * Every device pairs this way, the first one included: `trewd serve` writes
   * the first device's invite to `first-invite` in its data folder, `trewd
   * invite` on the server makes more, and a paired device's panel mints them
   * over the wire. What comes back is this device's own row and the token for
   * it, and nothing else that authenticates, which is what makes revoking this
   * phone on its own mean anything.
   *
   * The order is `pairWithInvite`'s (plan/protocol.md, "Invite redemption"):
   * the pending pairing, with the id and token this device will connect as,
   * is saved and read back before anything is sent. So:
   *
   *  - a server that cannot be reached, or one that refuses, leaves nothing
   *    saved and the vault as unpaired as it was;
   *  - a redemption that went out and heard nothing leaves the pending pairing
   *    on disk, and the run loop finishes it with the same credential, which
   *    the server answers `redeemed` again if it did register it;
   *  - `redeemed` replaces it with the finished device, and the loop starts.
   *
   * The files already in this vault are checked first, before anything is
   * saved or sent, because an invite is spent by the redemption and combining
   * a populated vault is a choice somebody makes (`checkFirstSync`).
   *
   * A device the server has refused for good pairs again through here too,
   * and it is what unlinking and pairing did in two steps, in an order that
   * removes nothing first: the merge is confirmed, what is left of the refused
   * run is retired, the new pending pairing is written over the old one and
   * read back, and only then is the old index removed (`savePairing`). A
   * refusal or an unreachable server leaves the vault unpaired, since the
   * pairing it held opened nothing any more; no note is touched either way.
   */
  async pair(
    inviteText: string,
    device: string,
    mergeConfirmed = false,
    /**
     * Names this device will never sync, chosen before it starts (Codex-05).
     *
     * Here rather than only in the paired panel because the download starts
     * the moment pairing finishes: somebody adding a phone to a vault with
     * several gigabytes of attachments had to race it to the settings screen.
     * The list is written with the pairing, so the first pass already honours
     * it and the bytes are never asked for.
     */
    ignore: readonly string[] = [],
  ): Promise<void> {
    await this.onePairing(async () => {
      const name = deviceName(device);
      const skip = [...new Set(ignore.map((n) => n.trim()))].filter(isIgnorableName).sort();
      // Only ever a pairing the server refused: `onePairing` lets no other
      // paired vault this far.
      const replacing = this.paired ? this.config : undefined;
      let mine = this.generation;
      // Read before anything else is looked at, so a string that is not an
      // invite, a Basalt string among them, is refused in its own words.
      const invite = parseInvite(inviteText);
      await checkFirstSync(this.app.vault.adapter, this.app.vault.configDir, mergeConfirmed);
      if (mine !== this.generation)
        throw new Error("Pairing was cancelled while checking local files.");
      if (replacing !== undefined) mine = await this.retireRefusedPairing(replacing);
      this.failedPairing = undefined;
      const pending = startPairing(invite, name, skip.length > 0 ? { ignore: skip } : {});
      let paired: DeviceConfig;
      try {
        paired = await pairWithInvite(pending, this.pairingStore(mine), { log });
      } catch (err) {
        throw await this.pairingDidNotFinish(err as Error, mine);
      }
      // Checked again after the save, because the save is itself an await: a
      // config that landed for a retired run is one `unlink` has waited for
      // and is about to remove, and starting a loop on it would put the
      // pairing back (F23, R10).
      if (mine !== this.generation) {
        throw this.retiredPairing(await whatTheDiskHolds(() => this.readConfig()));
      }
      this.config = paired;
      this.start();
    });
  }

  /**
   * Retires what is left of a pairing the server refused, before pairing
   * again over it, and returns the generation the new pairing writes under.
   *
   * The refused run has already ended, but `quiet` is what makes sure: a save
   * in flight is waited for, and nothing of the old run can write after it.
   * Refused if anything else changed the pairing meanwhile, the way a settings
   * change is (`setIgnoredNames`), so an unlink that started during the wait
   * is never written over.
   */
  private async retireRefusedPairing(refused: DeviceConfig): Promise<number> {
    const mine = this.generation + 1;
    await this.quiet();
    if (
      this.unlinking !== undefined ||
      this.generation !== mine ||
      this.config !== refused ||
      !offersPairAgain(this.state)
    ) {
      throw new Error("Pairing was cancelled: this vault's pairing changed while it was waiting.");
    }
    this.paused = false;
    return mine;
  }

  /**
   * What a pairing that did not finish leaves, and the error that says so.
   *
   * Answered from what the disk holds rather than from which step threw (rule
   * 4), through the counsellor `trew pair` takes its words from too:
   *
   *  - **pending**: the redemption went out and heard nothing, so the pairing
   *    is kept and the run loop finishes it with the same credential.
   *  - **credential**: the finished device reached the disk and a step after
   *    it failed; the row is real and this is its only token, so it is kept
   *    and started.
   *  - **unreadable**: nothing is known, and the file may hold the only copy
   *    of a registered row's token, so the plugin stops and refuses to pair
   *    over it, exactly as it does for a data.json it cannot read at load
   *    (rule 2).
   *  - **nothing**: refused, or the server was never reached. Nothing is
   *    saved, the invite was not spent by this attempt, and the panel says so
   *    above the form that tries again. A pairing that was replacing one the
   *    server refused leaves the vault unpaired: the new pending pairing was
   *    written over the old one, and is gone again.
   *
   * Nothing is started or stopped for a run that has been retired while this
   * was asking the disk: `unlink` has waited for it and is about to remove
   * what it finds (R10). What it says then is `retiredPairing`'s, because an
   * empty disk after an unlink is not evidence that nothing was registered.
   */
  private async pairingDidNotFinish(err: Error, mine: number): Promise<Error> {
    const remains = await whatTheDiskHolds(() => this.readConfig());
    // A run retired while this was in flight, by an unlink or an unload, is
    // answered in its own words: what the disk holds is what the retirement
    // left, not what the server said.
    if (mine !== this.generation) return this.retiredPairing(remains);
    const advice = adviseAfterPairing({ remains, surface: "panel", where: this.dataPath });
    if (remains.kind === "pending" || remains.kind === "credential") {
      this.config = remains.config;
      this.start();
    } else if (remains.kind === "unreadable") {
      this.unreadable = remains.why;
      this.setState({
        kind: "stopped",
        why: `${this.dataPath} could not be read: ${remains.why}`,
      });
    } else {
      this.failedPairing = `The pairing did not finish: ${err.message}. ${advice}`;
      if (this.config !== undefined) {
        this.config = undefined;
        this.setState({ kind: "unpaired" });
      }
    }
    // A lost reply says so itself, in words that already carry its cause; the
    // counsellor's version of the same sentence would only repeat it.
    if (err instanceof PairingInterrupted && remains.kind === "pending") {
      return new Error(
        `${err.message} TrewSync is finishing it now, and keeps trying until it has.`,
      );
    }
    return new Error(`${err.message}. ${advice}`);
  }

  /**
   * What a pairing retired under it says, from what the disk holds and
   * whether an unlink is what retired it.
   *
   * An unlink in progress counts as an empty disk whatever the disk says at
   * this moment, because it is about to remove the pending pairing: reading
   * the file a moment before the unlink writes it would otherwise report as
   * saved a pairing that is about to be gone.
   */
  private retiredPairing(remains: PairingRemains): Error {
    return retiredPairing(
      this.unlinking !== undefined ? { kind: "nothing" } : remains,
      this.dataPath,
    );
  }

  /* ------------------------------------------------------------ *
   * Recovery
   * ------------------------------------------------------------ */

  /**
   * Notes the server still holds and this vault does not.
   *
   * Needs a connection, and says so rather than showing an empty list. "There
   * is nothing to recover" and "I could not ask" are different answers, and
   * confusing them in a recovery tool is the worst place to do it.
   */
  async deletedNotes(limit?: number, before?: number): Promise<DeletedList> {
    if (!this.client)
      throw new Error(`${this.whyNoClient()} There is no way to ask what the server has.`);
    return this.client.deleted(limit, before);
  }

  /**
   * Puts a note back, never over the top of something already there.
   *
   * What the deleted list hands over is the *deletion*, which is a version
   * like any other and has no content in it. What has to be restored is the
   * version before it, so that is looked up here rather than assumed.
   */
  async recover(deletion: Version): Promise<Restored> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is nothing to restore from.`);
    // The list may stay open while a peer recreates this name. Recover the
    // selected deletion, not content uploaded after it.
    const version = await client.findVersion(
      deletion.path,
      (version) => version.uid < deletion.uid && !version.deleted && !version.folder,
    );
    if (!version) {
      throw new Error(
        `the server no longer holds content from before this deletion of ${deletion.path}`,
      );
    }
    return this.restoreAndSend(version);
  }

  /**
   * Every version this device took off a name and could not put back.
   *
   * Read from the live vault's ledger, which is where the record is: the
   * hidden file is not in Obsidian's index, so nothing else can walk for it.
   * Incomplete is kept apart from empty, because a log that will not parse and
   * a vault with nothing stranded look identical from a count (rule 2).
   */
  async displacedVersions(): Promise<Inventory> {
    const vault = this.vaultForRecovery();
    // The running client's copy has already listed, so its answer is current
    // and free. Without one the ledger has to be read, and reading it means
    // listing: recovering a note has to work on a device whose sync is paused
    // or stopped, which is exactly when somebody reaches for it.
    if (vault !== this.liveVault) await vault.list();
    return vault.recovery;
  }

  /**
   * An adapter that can reach the displaced ledger, running or not.
   *
   * The same one the client uses where there is a client, because it has the
   * inventory already; a fresh one otherwise, pointed at the same log. Both
   * write through Obsidian, which is the part that matters.
   */
  private vaultForRecovery(): ObsidianVault {
    if (this.liveVault) return this.liveVault;
    return new ObsidianVault(this.app.vault, this.app.vault.configDir, undefined, {
      displacedLog: `${this.pluginDir()}/${DISPLACED_LOG}`,
    });
  }

  /**
   * Puts a hidden version back where Obsidian can see it (Codex-08).
   *
   * When preservation cannot place a visible copy it parks the bytes under a
   * name Obsidian does not list, says so once, and afterwards the panel could
   * only report that this had happened somewhere. Getting those bytes back
   * meant a file manager or a terminal, on a device that may have neither, for
   * what is sometimes the only surviving copy of somebody's note.
   *
   * Beside, never over: the visible name is the first free one, so a recovery
   * cannot displace the thing that displaced it. The hidden copy is left where
   * it is. Removing it would be the one destructive step in a recovery path,
   * and there is no version of "it worked" worth taking that risk for; the
   * ledger keeps naming it until somebody deletes it themselves.
   */
  async recoverDisplaced(version: Displaced): Promise<string> {
    const vault = this.vaultForRecovery();
    const bytes = await vault.readDisplaced(version.at);
    const target = await firstFreeName(version.from, (path: string) => vault.exists(path));
    const now = Date.now();
    if (!(await vault.create(target, bytes, { mtime: now, ctime: now }))) {
      throw new Error(`something is already at ${target}`);
    }
    await vault.flush?.();
    // Sent like any other new note, and not waited on: the bytes are visible
    // and durable now, which is the whole of what was asked for.
    this.nudge(target);
    return target;
  }

  /**
   * Restores several deletions, and syncs once at the end (Codex-11).
   *
   * Recovering a deleted folder was one button per note, and each of those
   * reconciled the whole vault before the next could start. A hundred notes
   * was a hundred taps and a hundred passes, on a phone, one-handed, after
   * something had already gone wrong.
   *
   * The two halves stay apart for the reason `restoreAndSend` keeps them
   * apart: every restore that lands is durable the moment it returns, whatever
   * the sync afterwards does. So each one is placed first, and the sync is
   * asked once, and then each path is asked separately whether the server has
   * it. A restore that could not be placed at all is its own answer and does
   * not stop the others.
   */
  async recoverMany(deletions: readonly Version[]): Promise<Restored[]> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is nothing to restore from.`);
    const mine = this.generation;

    const placed: { at: string; failed?: undefined }[] = [];
    const out: (Restored | undefined)[] = deletions.map(() => undefined);
    for (let i = 0; i < deletions.length; i++) {
      const deletion = deletions[i]!;
      try {
        const version = await client.findVersion(
          deletion.path,
          (v) => v.uid < deletion.uid && !v.deleted && !v.folder,
        );
        if (!version) {
          throw new Error(
            `the server no longer holds content from before this deletion of ${deletion.path}`,
          );
        }
        const done = await client.restore(version);
        placed.push({ at: done.path });
        out[i] = { path: done.path, sent: false, willRetry: true, why: "not sent yet" };
      } catch (err) {
        out[i] = {
          path: deletion.path,
          sent: false,
          willRetry: false,
          why: (err as Error).message,
        };
      }
    }
    if (placed.length === 0) return out.map((r) => r!);

    // One pass for all of them, which is the whole point.
    let failure: string | undefined;
    try {
      await client.settle({ coalesceWrites: false });
    } catch (err) {
      failure =
        mine !== this.generation ? "this vault is no longer paired" : (err as Error).message;
    }
    for (let i = 0; i < out.length; i++) {
      const done = out[i]!;
      if (done.willRetry === false) continue; // never placed
      if (client.engine.serverHasOurs(done.path)) {
        out[i] = { path: done.path, sent: true };
      } else if (failure !== undefined) {
        out[i] = {
          path: done.path,
          sent: false,
          ...(mine !== this.generation ? { willRetry: false } : {}),
          why: failure,
        };
      } else {
        out[i] = {
          path: done.path,
          sent: false,
          willRetry: true,
          why: "it has not been acknowledged by the server yet, and will be tried again",
        };
      }
    }
    return out.map((r) => r!);
  }

  /**
   * Restores a version, then sends it, and keeps the two outcomes apart.
   *
   * The restore is local and durable the moment it returns. The send is a
   * sync, and a sync can fail for every ordinary reason. Reporting the pair
   * as one failure told somebody their restore had failed when the note was
   * on their disk, and a second attempt found the name occupied and made a
   * second copy beside the first.
   */
  private async restoreAndSend(version: Version): Promise<Restored> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is nothing to restore from.`);
    const mine = this.generation;
    const done = await client.restore(version);
    let report;
    try {
      // Sent now rather than at the next pass, so the other devices get it
      // without anybody having to know that they would not have.
      report = await client.settle({ coalesceWrites: false });
    } catch (err) {
      // "It will be sent when the next sync succeeds" is only true while
      // there is a next sync. Unlinked mid-restore there is not one, and the
      // note is on this device and nowhere else, which is what it says.
      if (mine !== this.generation) {
        return {
          path: done.path,
          sent: false,
          willRetry: false,
          why: "this vault is no longer paired",
        };
      }
      return { path: done.path, sent: false, why: (err as Error).message };
    }
    // A pass that resolved is not a path that went (F15).
    //
    // `settle` resolves for a vault that is retrying or has written a path
    // off, so ignoring its report reported the restored note as sent to the
    // other devices when its upload had failed and been queued, or refused
    // for good. The restore itself is durable either way, which is the whole
    // reason these two outcomes are kept apart; saying the second happened
    // because the first did is the same conflation from the other side.
    //
    // Only this path. Another note failing elsewhere in the vault says
    // nothing about this one, and marking the restore unsent for it would
    // send somebody looking in the wrong place.
    // Asked about this path, not looked for in a list (R09).
    //
    // `skippedPaths` and `retryingPaths` are display samples: sorted,
    // de-duplicated and cut to five, because a notice naming four hundred
    // files is not a notice. Absence from a sample is not evidence of
    // anything, and a pass with six failures reported the sixth as sent. A
    // path that is merely blocked, or one in a pass that still has waiting
    // work, was never in either list to begin with.
    //
    // So the question is put the other way round and answered affirmatively:
    // is the server holding what this device holds for this path. Only
    // `synced` writes that, and only where the server has acknowledged a
    // version.
    if (client.engine.serverHasOurs(done.path)) {
      // No staleness check on this side on purpose: the upload happened, so
      // "sent to your other devices" is true whatever became of the pairing
      // afterwards, and saying otherwise would be the same lie reversed.
      return { path: done.path, sent: true };
    }

    // Not acknowledged. The samples are used only to say *why*, which is what
    // they are good for, and there is an answer for the case where they say
    // nothing at all.
    if (report.skippedPaths.includes(done.path)) {
      return {
        path: done.path,
        sent: false,
        willRetry: false,
        why: "the server refused it, so it is on this device only",
      };
    }
    if (report.inTheWay.some((t) => t.path === done.path)) {
      return {
        path: done.path,
        sent: false,
        willRetry: false,
        why: "another file is in the way of that name, so it is on this device only",
      };
    }
    return {
      path: done.path,
      sent: false,
      willRetry: true,
      why: "it has not been acknowledged by the server yet, and will be tried again",
    };
  }

  /**
   * Opens the history of one note.
   *
   * Refuses rather than opening an empty modal when there is no connection.
   * "Nothing to show" and "I could not ask" are different answers, and a
   * recovery tool is the worst place to confuse them.
   */
  openHistory(path: string): void {
    if (!this.client) {
      new Notice(`TrewSync: ${this.whyNoClient()} There is no history to show.`, 8_000);
      return;
    }
    new HistoryModal(this.app, this.historySource(), path).open();
  }

  /** What HistoryModal needs, which is five calls and no plugin internals. */
  historySource(): HistorySource {
    return {
      history: async (path, opts) => {
        if (!this.client) throw new Error(this.whyNoClient());
        return this.client.history(path, opts);
      },
      contentAt: async (version) => {
        if (!this.client) throw new Error(this.whyNoClient());
        return new TextDecoder().decode(await this.client.contentAt(version));
      },
      // The outcome, not a sentence: the modal says it with the same
      // describeRestore every other restore surface uses.
      restoreVersion: (version) => this.restoreAndSend(version),
      // The operation behind the version, undone by the server as one
      // operation (protocol 2). Unlike a restore it replaces what the
      // operation wrote, and only while nothing has changed it since.
      undoOperation: async (version, opts) => {
        if (!this.client) throw new Error(this.whyNoClient());
        if (version.operation === undefined)
          throw new Error(
            "this version was not written by an operation, so there is nothing to undo",
          );
        const id = version.operation.id;
        // What is in an open editor is among this device's changes, which
        // the undo sends first (T15).
        await this.saveOpenEditors();
        if (!this.client) throw new Error(this.whyNoClient());
        return this.client.undo(id, opts);
      },
      currentText: async (path, maxBytes) => {
        // The note can go between the look and the read: somebody deleting
        // it while its history is loading. That is a diff against nothing,
        // not a version that could not be read.
        try {
          const stat = await this.app.vault.adapter.stat(path);
          if (maxBytes !== undefined && stat && stat.size > maxBytes)
            throw new Error(
              "The current note is too large to compare here. Restore a copy to compare it.",
            );
          return await this.app.vault.adapter.read(path);
        } catch (err) {
          if (await this.app.vault.adapter.exists(path)) throw err;
          return undefined;
        }
      },
    };
  }

  /**
   * The command-line pair. Everything is answered in the channel, because a
   * handler that throws answers with a stack trace, and "not connected" is
   * not an exceptional condition for a sync client.
   */
  private async cliHistory(path: string): Promise<string> {
    if (!path) return "Which note? trew:history needs a path.";
    if (!this.client) return `TrewSync is ${this.whyNoClient()}`;
    try {
      const versions = await this.client.history(path, { limit: 50 });
      if (versions.length === 0) return `No history found for ${path}.`;
      return versions
        .map((v) => `${v.uid}\t${new Date(v.mtime).toISOString()}\t${v.size} B\t${v.device}`)
        .join("\n");
    } catch (err) {
      return `TrewSync could not ask: ${(err as Error).message}`;
    }
  }

  private async cliRestore(path: string, uid: number): Promise<string> {
    if (!path) return "Which note? trew:restore needs a path.";
    if (!Number.isInteger(uid) || uid <= 0) return "Which version? trew:restore needs a uid.";
    if (!this.client) return `TrewSync is ${this.whyNoClient()}`;
    try {
      // Paged as far back as it has to go. One page of two hundred used to
      // be all that was looked at, and a version older than that was one
      // trew:history would list and this would then say did not exist.
      const version = await this.client.findVersion(path, (v) => v.uid === uid);
      if (!version) return `No version ${uid} of ${path}.`;
      return describeRestore(version, await this.restoreAndSend(version));
    } catch (err) {
      return `TrewSync could not restore: ${(err as Error).message}`;
    }
  }

  /**
   * Every device that may reach this vault, and every invite that could still
   * add one.
   *
   * Needs a connection, and says so rather than showing an empty list. "There
   * are no other devices" and "I could not ask" are different answers, and
   * this is the list somebody reads before deciding which one to cut off.
   *
   * The invites are part of the same answer. A row is a device that was added
   * and an outstanding invite is one about to be, and until they were listed a
   * string issued on a device somebody had just lost stayed invisible until
   * somebody redeemed it, for up to an hour. What an invite row carries is its
   * id, its label and its expiry, never anything that redeems it.
   */
  async devices(): Promise<{
    devices: DeviceRow[];
    invites: InviteRow[];
    thisDevice: string;
  }> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to ask what is paired.`);
    return { ...(await client.devices()), thisDevice: client.deviceId };
  }

  get deliveryReady(): boolean {
    return this.client?.deliveryReady ?? false;
  }

  /**
   * A single-use invite for another device, from the live connection.
   *
   * Needs a connection, because the server has to store it, and says so rather
   * than handing over a string that would be refused.
   *
   * This is how a device is added: the string is a `trew1i_` invite carrying
   * this server's address, this vault and a one-time token, and the redemption
   * registers the new device's own row, so what appears in the list below is a
   * device that can be revoked on its own. It lasts an hour unless it is used
   * or cancelled first, and revoking this device cancels it too.
   */
  async createInvite(
    opts: { ttlMs?: number; label?: string } = {},
  ): Promise<{ invite: string; id: string; expiresAt: number | null }> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to register an invite.`);
    return client.invite(opts);
  }

  /**
   * Cancels an outstanding invite, so the string stops working before it
   * expires.
   *
   * The companion to being able to see one. Otherwise the only way to retire
   * an invite issued on a device that has just been lost is to wait out its
   * hour, or to revoke that device, which cancels the invites it issued.
   * Takes the invite's id from the device list.
   */
  async uninvite(invite: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to cancel an invite.`);
    return client.uninvite(invite);
  }

  /**
   * Stops one device connecting, and closes whatever it has open.
   *
   * What revoking does not do is un-read anything: the notes that device has
   * already synced stay on it, readable there, in plaintext. It stops receiving
   * anything new and stops writing, and the panel says so beside the button.
   *
   * Any device may be revoked, the last one included, and no flag is needed
   * for that: a vault with no devices gets one back from `trewd invite` on the
   * server, and nothing a device holds is needed for it.
   */
  async revoke(deviceId: string): Promise<{ self: boolean }> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to revoke a device.`);
    const { self } = await client.revoke(deviceId);
    if (self) {
      // Revoking this device is what unlinking is, from the server's side.
      // The connection is already closing behind the reply, so the run is
      // retired here rather than left to discover it by being refused, and
      // the panel offers what a device revoked from elsewhere is offered.
      await this.quiet();
      this.setState({
        kind: "stopped",
        why: "this device was revoked and may no longer sync this vault",
        recovery: "pair-again",
      });
    }
    return { self };
  }

  /** This device's own row id, so the panel can tell it out of the list. */
  get deviceId(): string | undefined {
    return this.config?.deviceId;
  }

  /* ------------------------------------------------------------ *
   * Rejoining a restored server
   * ------------------------------------------------------------ */

  /**
   * Where this device and the server each are, asked of the server directly.
   *
   * `cursors()` below reads a live connection, and the device that needs these
   * two numbers is the one the server has refused: it has no live connection
   * and never will until this is dealt with. So this makes its own, carrying no
   * index, which is the only kind the server will talk to. Nothing is written.
   */
  async rejoinCursors(): Promise<{ local: number; server: number }> {
    const config = this.config;
    if (!config || !this.paired) throw new Error("this vault is not paired yet.");
    return rebaseCursors(await this.clientOptions(config, this.generation));
  }

  /**
   * Rejoins a server that has lost history this device already applied.
   *
   * It exists because the documented alternative for a plugin device was to
   * unlink and pair again. Re-pairing throws away the index too, but it also throws away
   * the merge base: every note comes back as an ancestor-less new version, and
   * the next edit made on two devices at once cannot merge, so a restore was
   * followed by a conflict-copy storm on precisely the devices least able to
   * clean one up. A rebase keeps the pairing, so the ancestors the server
   * agrees with survive.
   *
   * Nothing is deleted, here or on the server: what both sides hold identically
   * is agreed again, what only this device holds goes up as new versions, and
   * where the two disagree both are kept.
   *
   * In this order, and each step waited for. First the two cursors, from a
   * connection that writes nothing, so a rebase that is not the answer is
   * refused before anything has been touched. Then quiet: the run is retired
   * and its clients closed, because the pass in flight ends by saving the index
   * this is about to remove and two engines on one index is the state the
   * single-flight rule exists to prevent. Then the index, both copies, proven
   * gone. Only then the server.
   *
   * Whatever happens after the index goes, the loop is started again: from that
   * moment this device has no record of what it had synced, and the only way it
   * gets one back is by reaching the server.
   */
  async rebase(): Promise<SyncReport> {
    if (this.unlinking) throw new Error("This vault is being unlinked.");
    if (this.editingConnection) throw new Error("Another settings change is in progress.");
    this.editingConnection = true;
    try {
      const config = this.config;
      if (!config) throw new Error("this vault is not paired yet.");
      if (this.pairing) throw new Error("a pairing is already in progress");
      let mine = this.generation;
      const current = () => mine === this.generation && this.config === config;
      const requireCurrent = () => {
        if (!current()) throw new Error("the pairing changed while rejoining the server");
      };
      refuseUnlessAhead(await this.rejoinCursors());
      requireCurrent();

      mine++;
      await this.quiet();
      requireCurrent();
      this.setState({ kind: "connecting" });

      try {
        // Unlink must wait for an already-started reset, or this operation
        // could remove the index of a new pairing after unlink has returned.
        await this.trackStateWrite(this.indexStore().remove());
        requireCurrent();
        const options = await this.clientOptions(config, mine);
        requireCurrent();
        const client = new Client(options);
        // The recovery client has the same lifecycle as the normal loop:
        // unlink and unload can close it, including during its handshake.
        this.live = client;
        try {
          await client.connect();
          requireCurrent();
          return await client.settle({ coalesceWrites: false });
        } finally {
          await client.close();
          if (this.live === client) this.live = undefined;
        }
      } finally {
        if (current()) this.start();
      }
    } finally {
      this.editingConnection = false;
    }
  }

  /**
   * Stops everything this plugin has running, and waits for it.
   *
   * What `unlink` does before it touches a file, and what `rebase` and a
   * rename need for the same reason: a run that is merely disconnected
   * reconnects, a pass in flight is still writing the index, a pairing being
   * finished is still going to write `data.json`, and a save already past its
   * generation check is still going to write it too. The bumped generation is
   * what stops another starting.
   */
  private async quiet(): Promise<void> {
    this.generation++;
    this.running = false;
    this.clearTimers();
    this.wakeLoop?.();
    this.wakeLoop = undefined;
    const { live, client } = this.retireClients();
    await live?.close();
    await client?.close();
    await this.pausing;
    // Their callers report failures. Shutdown needs completion, including a
    // failed write, so unlink can perform and verify its own cleanup next.
    await Promise.allSettled([...this.settling]);
  }

  /**
   * A config write made while something long-running is in flight, which
   * `unlink` can wait for and a retired run cannot make.
   *
   * R10, in the shape pairing gives it. The write in flight past a generation
   * check is the save that records this device's credential, made in the
   * middle of a redemption that may already have reached the server. The
   * hazard is that unlinking writes `null` over the pairing, and a save that
   * lands after it puts the pairing back, so memory says unpaired, the file
   * says paired, and the next start syncs a vault the person removed.
   *
   * Two halves, because either alone leaves a window. The write is registered
   * where `unlink` waits for it, and it refuses outright once its run has been
   * retired, which is what stops one that had not started yet.
   */
  private saveDuringRun(mine: number, config: DeviceConfig): Promise<void> {
    if (mine !== this.generation) {
      // Not an error to report: this run has been replaced or unlinked, and
      // what it belongs to should stop rather than finish writing.
      return Promise.reject(new Error("this vault is no longer paired"));
    }
    return this.trackStateWrite(this.saveVerified(config));
  }

  /**
   * Removes a pairing that was refused or never reached the server, the same
   * way: registered where `unlink` waits for it, refused once its run has been
   * retired.
   */
  private forgetDuringRun(mine: number): Promise<void> {
    if (mine !== this.generation) {
      return Promise.reject(new Error("this vault is no longer paired"));
    }
    return this.trackStateWrite(this.forgetVerified());
  }

  /** Let unlink/unload drain a state write that has already started. */
  private trackStateWrite(writing: Promise<void>): Promise<void> {
    this.settling.add(writing);
    void writing.catch(() => undefined).finally(() => this.settling.delete(writing));
    return writing;
  }

  /**
   * Writes the pairing and reads it back before believing it.
   *
   * Rule 4: verify the outcome, not the exit code. The one write that cannot
   * afford to be taken on trust is the pending pairing, because the redemption
   * goes out on the strength of it: a credential the server registers and this
   * device never wrote down is a row nothing can connect as. `decodeConfig`
   * refuses a half-written config, so a torn write is caught here rather than
   * on the next start. What is written is exactly `encodeConfig`'s keys, and
   * `invite` only while the pairing is pending.
   */
  private async saveVerified(config: DeviceConfig): Promise<void> {
    const wanted = JSON.stringify(encodeConfig(config));
    const { record, secret } = this.recordFor(config);
    const previous = this.secretInUse;
    const adopted = this.secretsAdopted;
    await this.saveData(record);
    let back: DeviceConfig | undefined;
    try {
      back = await this.readConfig();
    } catch (err) {
      throw new Error(`${this.dataPath} could not be read back: ${(err as Error).message}`);
    }
    // The token read back from wherever the record says it is, so this one
    // comparison covers both halves: the file, and the keychain it points at.
    if (back === undefined || JSON.stringify(encodeConfig(back)) !== wanted) {
      throw new Error(`${this.dataPath} did not read back as it was written`);
    }
    this.secretInUse = secret;
    // Only now, with what replaces it saved and read back (rule 3): the
    // secret of the pairing this one replaced, a device the server refused or
    // a copy's lost entry, opens nothing this vault still uses. Nor does the
    // one a rename left under the old name, once the token is saved here: in
    // `data.json`, since a secret this start wrote is only ever pending.
    if (previous !== undefined && previous !== secret) this.dropSecret(previous);
    this.secretsAdopted = [];
    for (const old of adopted) if (old !== secret && old !== previous) this.dropSecret(old);
  }

  /**
   * What `data.json` holds for a config, and the keychain id its token went
   * to, if it went to one.
   *
   * The token leaves the file only once the keychain's copy is known to be in
   * its storage (`secretStored`), which no call in the start that wrote it can
   * show: `getSecret` answers from memory, and the write behind `setSecret` is
   * not awaited (keychain.ts). Until then the keychain is written and read
   * back (rule 4) and the file keeps the token beside a pending marker naming
   * this start, so a kill before the keychain's write lands leaves the token
   * where it was (rule 3). `settleToken` finishes it on a later start. A
   * keychain that refuses or does not read back leaves the token in the file,
   * as on an Obsidian with no keychain, and the plugin says so once.
   */
  private recordFor(config: DeviceConfig): {
    record: Record<string, string>;
    secret: string | undefined;
  } {
    const record = encodeConfig(config);
    const keychain = keychainOf(this.app);
    if (keychain === undefined || !config.deviceId || !config.deviceToken) {
      return { record, secret: undefined };
    }
    const id = secretIdFor(this.vaultName(), config.deviceId);
    if (this.secretStored === id && tokenInKeychain(keychain, id) === config.deviceToken) {
      const { deviceToken: _token, ...rest } = record;
      return { record: { ...rest, [TOKEN_IN]: IN_KEYCHAIN }, secret: id };
    }
    const refused = keepInKeychain(keychain, id, config.deviceToken);
    if (refused !== undefined) {
      this.keychainRefused(refused);
      return { record, secret: undefined };
    }
    return {
      record: { ...record, [TOKEN_IN]: IN_KEYCHAIN_PENDING, [WRITTEN_AT]: appStartOf(this.app) },
      secret: id,
    };
  }

  /** Said once per load: the token stays in `data.json`, and why. */
  private toldKeychainRefused = false;
  private keychainRefused(why: string): void {
    console.warn("TrewSync: keeping this device's token in data.json:", why);
    if (this.toldKeychainRefused) return;
    this.toldKeychainRefused = true;
    new Notice(
      `TrewSync: this device's token stays in ${this.dataPath}, because ${why}. It syncs as ` +
        `before; a copy of this vault's ${this.app.vault.configDir} folder carries the token ` +
        "with it until the keychain works.",
      15_000,
    );
  }

  /**
   * Removes a secret this vault no longer points at.
   *
   * After the file that named it has moved on, so a failure here strands a
   * credential in the keychain and loses nothing: it is said, with the id to
   * remove by hand in Settings, Keychain.
   */
  private dropSecret(id: string): void {
    const keychain = keychainOf(this.app);
    if (keychain === undefined) return;
    try {
      removeFromKeychain(keychain, id);
    } catch (err) {
      new Notice(
        `TrewSync could not remove ${id} from Obsidian's keychain (${(err as Error).message}). ` +
          "It opens nothing this vault uses now; remove it in Settings, Keychain.",
        15_000,
      );
    }
  }

  /** Removes the saved pairing, and reads the file back to prove it gone (rule 4). */
  private async forgetVerified(): Promise<void> {
    await this.saveData(null);
    let back: DeviceConfig | undefined;
    try {
      back = await this.readConfig();
    } catch (err) {
      throw new Error(`${this.dataPath} could not be read back: ${(err as Error).message}`);
    }
    if (back !== undefined) throw new Error(`${this.dataPath} still holds a pairing`);
    this.forgetSecret();
  }

  /** The keychain half of forgetting a pairing, after the file half is proven. */
  private forgetSecret(): void {
    const id = this.secretInUse;
    this.secretInUse = undefined;
    if (id !== undefined) this.dropSecret(id);
  }

  /**
   * Moves a token that `data.json` still holds into the keychain, at load, in
   * two steps across two starts of the app (rule 3).
   *
   * A token only in the file is written to the keychain and read back, and the
   * file is rewritten with the token still in it and a pending marker naming
   * this start. A pending marker from an earlier start is the second step:
   * `getSecret` now answers from the storage this start loaded, so a match
   * proves the keychain's copy survived a restart, and only then is the file
   * rewritten without the token. A pending marker whose secret did not survive
   * (the app was killed before its write landed) is written again. A pending
   * marker from this same start, which a reload of the plugin meets, proves
   * nothing yet and is left alone.
   *
   * `saveVerified` reads each write back (rule 4). A keychain that fails its
   * read-back leaves the token in the file and says so. A save that fails part
   * way leaves either the old file or the new one, and the config is read
   * again to find out which.
   */
  private async moveTokenToKeychain(config: DeviceConfig): Promise<DeviceConfig | undefined> {
    const keychain = keychainOf(this.app);
    if (config.deviceToken === undefined || keychain === undefined || !config.deviceId) {
      return config;
    }
    const pending = this.secretPending;
    const id = secretIdFor(this.vaultName(), config.deviceId);
    if (pending === undefined && this.secretStored === id && this.secretsAdopted.length === 0) {
      // In the keychain, and loaded from its storage: nothing to do.
      return config;
    }
    if (pending !== undefined && pending.id === id && pending.writtenAt === appStartOf(this.app)) {
      return config;
    }
    if (pending !== undefined && tokenInKeychain(keychain, id) === config.deviceToken) {
      this.secretStored = id;
    }
    try {
      await this.trackStateWrite(this.saveVerified(config));
      return config;
    } catch (err) {
      new Notice(
        `TrewSync could not move this device's token into Obsidian's keychain: ` +
          `${(err as Error).message}.`,
        15_000,
      );
      return this.readConfig();
    }
  }

  /**
   * Where this device and the server each are, for a panel that shows both.
   *
   * The two numbers are what makes "behind and nothing arriving" visible.
   * docs/design.md says the protocol cannot detect a server withholding
   * versions; a person looking at these two lines can.
   */
  cursors(): { local: number; server: number } | undefined {
    const client = this.connectedClient();
    if (!client) return undefined;
    return { local: client.engine.status().cursor, server: client.serverCursor };
  }

  /** A completed handshake is connected even while the initial history is loading. */
  private connectedClient(): Client | undefined {
    const client = this.client ?? this.live;
    return client?.serverLimits && !client.transport.isClosed ? client : undefined;
  }

  /**
   * What this device is talking to, as far as it knows.
   *
   * Two halves with two lifetimes, which is why they come back together. The
   * address is the pairing's and is known whether or not anything is
   * connected; the protocol and the build are the server's own account of
   * itself, arrive in `ready`, and are gone again the moment the connection
   * is. Nothing here is asked for specially: it is what the client already
   * holds.
   */
  connection(): Connection | undefined {
    const url = this.config?.url;
    if (url === undefined) return undefined;
    const limits = this.connectedClient()?.serverLimits;
    return {
      url,
      ...(limits !== undefined
        ? { server: { proto: limits.proto, version: limits.serverVersion } }
        : {}),
    };
  }

  /**
   * Forgets the pairing. Every note stays where it is, on both ends.
   *
   * The index goes with it, and that is not tidiness. It records what this
   * device believes it has already synced. Left behind, the next pairing
   * starts from it: a cursor into a server that may be a different server, and
   * entries claiming files are up to date when nothing has been checked. The
   * device would skip uploading notes it had never sent.
   *
   * In this order, and each step waited for. First quiet: the run is
   * retired and its client closed, which waits for the pass in flight,
   * because that pass ends by saving the index this is about to remove.
   * Then the index, both copies, proven gone. Then the pairing on disk, and
   * only then the pairing in memory, so that at every step what the file
   * says and what this object says agree. A step that fails leaves the
   * vault paired and stopped, says so, and can be tried again.
   */
  async unlink(): Promise<void> {
    if (this.unlinking) return this.unlinking;
    this.unlinking = this.unlinkVault();
    try {
      await this.unlinking;
    } finally {
      this.unlinking = undefined;
    }
  }

  private async unlinkVault(): Promise<void> {
    // Retires every run in flight, closes their clients, and waits for every
    // settle save that is already past its generation check, because each of
    // those is a write to the same file this is about to empty. See `quiet`.
    await this.quiet();

    try {
      await this.indexStore().remove();
    } catch (err) {
      throw this.unlinkFailed(`the index could not be removed: ${(err as Error).message}`);
    }
    try {
      await this.saveData(null);
      if ((await this.readConfig()) !== undefined) {
        throw new Error("the pairing was not cleared when read back");
      }
    } catch (err) {
      throw this.unlinkFailed(
        `the pairing could not be removed from ${this.dataPath}: ${(err as Error).message}`,
      );
    }
    // Last, once nothing names it: the token goes from the keychain too.
    this.forgetSecret();
    this.config = undefined;
    this.paused = false;
    this.failedPairing = undefined;
    this.setState({ kind: "unpaired" });
  }

  /** Takes the clients off the plugin, so nothing reaches for them again. */
  private retireClients(): { live: Client | undefined; client: Client | undefined } {
    this.previewModal?.close();
    this.previewModal = undefined;
    this.previewing = undefined;
    for (const close of this.syncPrompts) close();
    this.syncPrompts.clear();
    const taken = { live: this.live, client: this.client };
    this.live = undefined;
    this.client = undefined;
    return taken;
  }

  private unlinkFailed(why: string): Error {
    // Still paired, on disk and here, and no longer running: stopped is
    // the honest state, and the panel still offers Unlink to try again.
    this.setState({ kind: "stopped", why: `unlink did not finish, ${why}. Try again` });
    return new Error(`unlink did not finish: ${why}`);
  }

  /* ------------------------------------------------------------ *
   * Saying what is happening
   * ------------------------------------------------------------ */

  private setState(state: State): void {
    this.state = state;
    this.awake?.set(state.kind === "loading" || state.kind === "syncing");
    // A notice saying TrewSync has stopped is true until the state says otherwise,
    // and no longer: pairing again, unlinking and every recovery leave through
    // here.
    const told = this.stoppedNotice;
    if (told !== undefined && (state.kind !== "stopped" || state.why !== told.why)) {
      told.notice.hide();
      this.stoppedNotice = undefined;
    }
    if (this.statusEl) paintStatus(this.statusEl, state);
    // Where a phone can see it. `aria-label` is what Obsidian renders as a
    // ribbon tooltip, and it is also what a screen reader reads out.
    if (this.ribbonEl) {
      const glyph = iconFor(state);
      if (this.ribbonEl.getAttribute("data-trew-icon") !== glyph) {
        setIcon(this.ribbonEl, glyph);
        this.ribbonEl.setAttribute("data-trew-icon", glyph);
      }
      this.ribbonEl.removeClass("trew-attention", "trew-working");
      const tone = toneFor(state);
      if (tone) this.ribbonEl.addClass(tone);
      // With the platform's standing, because on a phone this is the status
      // bar: iOS has none (PLAN.md section 4.12).
      const standing = platformStanding(Platform);
      this.ribbonEl.setAttribute(
        "aria-label",
        `TrewSync: ${longStatus(state)}${standing ? ` ${standing.title}.` : ""}`,
      );
    }
    this.announceOnAPhone(state);
    for (const listener of this.listeners) listener(state);
  }

  /** The condition a Notice has already been shown for, so it is shown once. */
  private toldOnAPhone: "attention" | "offline" | undefined;
  private lastToldOnAPhone = 0;

  /**
   * Puts the two states a phone most needs where a phone can see them (R083-16).
   *
   * There is no status bar on mobile: `addStatusBarItem` is documented as
   * unavailable there, so on Android the whole of the state is the ribbon
   * glyph and an `aria-label` that renders as a tooltip nobody taps. "Some
   * files need attention" and "not connected" are exactly the two a person
   * needs to be told rather than to go looking for, and both were invisible
   * until they opened the panel.
   *
   * On the transition, and once. A Notice per pass would be the plugin talking
   * over the person; a Notice when nothing has changed says nothing. The flag
   * clears when the condition does, so the next occurrence is announced again.
   */
  private announceOnAPhone(state: State): void {
    if (!Platform.isMobileApp) return;
    const now =
      state.kind === "offline"
        ? "offline"
        : state.kind === "synced" && (state.refused > 0 || state.waiting > 0)
          ? "attention"
          : undefined;
    if (now === this.toldOnAPhone) return;
    this.toldOnAPhone = now;
    if (now === undefined) return;
    // And not more than once every few minutes. A phone's radio drops and
    // comes back on its own, and a Notice per drop is a plugin talking over
    // somebody who is trying to write. The state is on the ribbon either way;
    // this is the interruption, and an interruption that repeats stops being
    // read.
    const at = Date.now();
    if (at - this.lastToldOnAPhone < PHONE_NOTICE_GAP_MS) return;
    this.lastToldOnAPhone = at;
    new Notice(`TrewSync: ${longStatus(state)} Tap the TrewSync icon for details.`, 10_000);
  }

  private readonly listeners = new Set<(state: State) => void>();

  /** Lets the modal follow along while it is open. */
  watchState(listener: (state: State) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  get currentState(): State {
    return this.state;
  }

  /**
   * Whether this vault has a finished device credential and can sync.
   *
   * Not "a config exists". A pairing is saved to disk before its redemption
   * is sent, deliberately, so a reply lost on the way back can be finished
   * rather than stranding a row; the config at that point holds a credential
   * the server may or may not have registered. Counting that as paired would
   * draw the whole synced interface (Sync, invites, the device list) over a
   * vault that has not been told it may connect.
   */
  get paired(): boolean {
    return this.config !== undefined && !isPendingPairing(this.config);
  }

  /**
   * The pairing being finished, while there is one: not paired and not
   * unpaired, and the panel draws it as neither.
   */
  get pendingPairing(): PendingPairing | undefined {
    return this.config !== undefined && isPendingPairing(this.config) ? this.config : undefined;
  }

  /** Why the last pairing did not finish, while the panel is offering another. */
  get pairingFailure(): string | undefined {
    return this.failedPairing;
  }

  /** Why the saved settings cannot be used, while that is so. */
  get configProblem(): string | undefined {
    return this.unreadable;
  }

  get deviceName(): string {
    return this.config?.device ?? "";
  }
}

/**
 * Copies to the clipboard where there is one, and says so either way.
 *
 * Not every place this runs has a clipboard: mobile webviews and pages
 * outside a secure context do not. A button that silently does nothing is
 * worse than one that says the string is on screen to copy by hand, which it
 * always is.
 */
async function copyToClipboard(text: string, said: string): Promise<void> {
  const clipboard: Clipboard | undefined =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  try {
    if (!clipboard) throw new Error("no clipboard here");
    await clipboard.writeText(text);
    new Notice(said);
  } catch {
    new Notice("This device has no clipboard. The string is shown in the panel, to copy by hand.");
  }
}

/**
 * Proves a device credential opens its vault at an address, and applies
 * nothing.
 *
 * One hello and a close. The cursor is zero, because nothing here applies
 * anything and a cursor is only ever refused for being ahead of the server, so
 * this cannot fail for a reason that is not about the address or the
 * credential it is testing. What moving to a new address needs before it
 * writes the address down: a wrong one must not replace a pairing that works.
 */
async function proveConnects(config: DeviceConfig, timeoutMs: number): Promise<void> {
  const who = credentialsFor(config);
  const transport = new Transport(who.url, { onBatch: () => {}, timeoutMs, log });
  try {
    await transport.connect();
    await transport.hello({
      vault: who.vaultId,
      deviceId: who.deviceId,
      token: who.token,
      device: who.device,
      cursor: 0,
    });
  } finally {
    transport.close();
  }
}

/**
 * What a pairing left when its run was retired under it, by an unlink or an
 * unload, from what the disk holds afterwards.
 *
 * Not the counsellor's words for an empty disk, which say nothing was
 * registered: an unlink removes the pending pairing whatever the server did
 * with the redemption, so an empty disk here says nothing about the server,
 * and a row the redemption registered is one nothing can connect as. An
 * unload leaves the disk alone, and the next load takes it from there.
 */
function retiredPairing(remains: PairingRemains, where: string): Error {
  switch (remains.kind) {
    case "nothing":
      return new Error(
        "this vault was unlinked while it was being paired. If the invite had already gone " +
          "out, the server may have registered this device: its row is then in the device " +
          "list as a device that never connected, and another device can revoke it.",
      );
    case "pending":
      return new Error(
        "TrewSync stopped before this pairing finished. It is saved, and the next time TrewSync " +
          "loads it finishes the pairing with the same credential.",
      );
    case "credential":
      return new Error(
        "TrewSync stopped before this pairing finished here. It is saved, and the next time " +
          "TrewSync loads it connects as this device.",
      );
    default:
      return new Error(adviseAfterPairing({ remains, surface: "panel", where }));
  }
}

/** Keep mobile keyboards from capitalizing or correcting addresses and invites. */
function literalInput(field: TextComponent, address = false): void {
  field.inputEl.setAttribute("autocapitalize", "none");
  field.inputEl.setAttribute("autocorrect", "off");
  field.inputEl.setAttribute("autocomplete", "off");
  field.inputEl.spellcheck = false;
  if (address) field.inputEl.inputMode = "url";
}

/**
 * Configs read without their token because the keychain did not have it, and
 * why, for the stop that follows (`withKeychainToken`).
 *
 * Keyed by the object rather than kept on the plugin, because the config that
 * reaches `runLoop` is the one that was read: a later read, or a new pairing,
 * is a different object and carries nothing from this one.
 */
const tokenNotHere = new WeakMap<DeviceConfig, string>();

/**
 * The stop for a vault whose token belongs to a keychain it cannot reach.
 *
 * Its own class so `recoveryFor` can offer a new pairing for it: the panel
 * draws the pairing form in place of the paired panel, whose every row needs
 * the token that is not here.
 */
class TokenNotHere extends Error {}

function offersRejoin(state: State): boolean {
  return state.kind === "stopped" && state.recovery === "rejoin";
}

/** Whether the panel should offer a new pairing in place of the paired panel. */
function offersPairAgain(state: State): boolean {
  return state.kind === "stopped" && state.recovery === "pair-again";
}

/**
 * The recovery a refusal has a way out for, if any.
 *
 * `pair-again` for the server refusing this device's own credential for good:
 * `auth`, which a revoke sends a connected device and every later hello gets,
 * and `nodevice`, which a request gets when the row went while its connection
 * was open. The server says only "not authorised" at a hello, deliberately, so
 * a device revoked while it was offline and one whose row the server never had
 * look alike; either way the credential this device holds opens nothing, and
 * a new pairing is the only thing that changes that.
 */
function recoveryFor(cause: Error): "rejoin" | "pair-again" | undefined {
  if (cause instanceof TokenNotHere) return "pair-again";
  if (!(cause instanceof ProtocolError)) return undefined;
  if (cause.code === "cursor") return "rejoin";
  if (cause.fatal && (cause.code === "auth" || cause.code === "nodevice")) return "pair-again";
  return undefined;
}

/**
 * What a device the server has refused for good is told, beside the refusal.
 *
 * The finding it answers (M3's second) was a phone told to pair again with a
 * new invite and shown nothing to pair with: the way on was Manage this vault,
 * then Unlink. The panel draws the pairing form itself now, so this points at
 * the panel and says the one thing somebody wants to know first.
 */
const PAIR_AGAIN_ADVICE =
  "This device's notes are kept, here and on the server. Open the TrewSync panel to pair it again.";

/**
 * The name this device goes by, from what was typed or from the suggestion.
 *
 * Two devices left blank used to both be "obsidian", and their conflict
 * copies were told apart only by the number `firstFreeName` appended. The
 * copies were never lost, but a name that says which device wrote it is the
 * point of having one in the filename, so a blank gets a suggestion. Shown in
 * the panel, editable nowhere afterwards, because there is no settings screen.
 */
function deviceName(typed: string): string {
  const name = typed.trim();
  return name === "" ? suggestedDeviceName() : name;
}

/**
 * A name to offer for this device: what kind of machine it is, and a short
 * random tail.
 *
 * The pairing form has always had a name field and never had anything in it,
 * so the honest thing to do with an empty field was leave it empty, and an
 * empty one became `obsidian-3f2a`. A device list read from inside Obsidian,
 * every row of which says Obsidian, identifies nothing. The CLI has had the
 * better answer since it existed, the hostname and a tail (`deviceNameFor` in
 * cli/cli.ts), and this is as near as a plugin gets: a phone has no hostname
 * and the mobile bundle has no `os` module, but `Platform` says what kind of
 * machine this is.
 *
 * The tail is the CLI's own two random bytes, and it is there whatever the
 * platform word is, because two Macs are both "mac" and the name is what tells
 * two conflict copies apart and what somebody reads in the device list before
 * revoking a row. Typing a name replaces the whole suggestion, tail included,
 * exactly as `--device` does.
 */
function suggestedDeviceName(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const tail = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${platformWord()}-${tail}`;
}

/**
 * One word for the machine, out of `Platform`.
 *
 * The mobile flags come first, and that ordering is the whole of what is
 * subtle here: `obsidian.d.ts` says `isMacOS` is true on "a device that
 * pretends to be one (like iPhones and iPads)", so an iPad checked in the
 * other order would call itself a Mac. The last word is a fallback that a
 * real Obsidian never reaches, since every host it runs on claims one of the
 * five above.
 */
function platformWord(): string {
  if (Platform.isAndroidApp) return "android";
  if (Platform.isIosApp) return Platform.isTablet ? "ipad" : "iphone";
  if (Platform.isMacOS) return "mac";
  if (Platform.isWin) return "windows";
  if (Platform.isLinux) return "linux";
  return "obsidian";
}

/**
 * The first line of the recovery list: what can come back and what cannot.
 *
 * Counted apart. Every row used to be called recoverable, including the ones
 * drawn a few lines down as purged, and a list that says "all recoverable"
 * over a note whose content is gone tells somebody their note is safe when it
 * is not. The truncation wording is for the same reason: a short list that
 * looks complete is one somebody reads and concludes their note is gone.
 */
export function describeDeleted(list: DeletedList): string {
  const purged = list.notes.filter((n) => n.restorable === 0).length;
  const restorable = list.notes.length - purged;
  const parts: string[] = [];
  if (restorable > 0) {
    parts.push(
      `${restorable} ${restorable === 1 ? "note is" : "notes are"} recoverable. ` +
        `Restoring puts one back and sends it to your other devices.`,
    );
  }
  if (purged > 0) {
    parts.push(
      `${purged} ${purged === 1 ? "note is" : "notes are"} listed but cannot be restored: ` +
        `${purged === 1 ? "its" : "their"} history has been purged.`,
    );
  }
  if (list.more) {
    parts.push(
      `The server has older deletions than the ${list.notes.length} shown here; ` +
        `Show older lists more of them.`,
    );
  }
  return parts.join(" ");
}

/** One compact status glyph, with the plugin name and details in its tooltip. */
function paintStatus(el: HTMLElement, state: State): void {
  const icon =
    el.querySelector<HTMLElement>(".trew-status-icon") ??
    el.createSpan({ cls: "trew-status-icon" });
  icon.setAttribute("aria-hidden", "true");
  const glyph = iconFor(state);
  if (icon.getAttribute("data-trew-icon") !== glyph) {
    setIcon(icon, glyph);
    icon.setAttribute("data-trew-icon", glyph);
  }
  // Only when there is one. The settled state has no tone, and addClass with
  // an empty string throws: "The token provided must not be empty", which
  // arrives as a sync error about a DOMTokenList and says nothing about the
  // status bar it came from.
  const tone = toneFor(state);
  if (el.getAttribute("data-trew-tone") !== tone) {
    el.removeClass("trew-attention", "trew-working");
    if (tone !== "") el.addClass(tone);
    el.setAttribute("data-trew-tone", tone);
  }
  // A word beside the glyph for as long as this runs where the tests do not
  // (PLAN.md section 4.12), whatever the sync state: a glyph alone cannot say
  // "unsupported", and a tooltip is only read by somebody already looking.
  const standing = platformStanding(Platform);
  const word = el.querySelector<HTMLElement>(".trew-status-platform");
  if (standing === undefined) word?.remove();
  else (word ?? el.createSpan({ cls: "trew-status-platform" })).setText(standing.short);
  // Both, because Obsidian styles aria-label as its own tooltip and a plain
  // title is what shows if it ever stops.
  const tip = `TrewSync: ${longStatus(state)}${standing ? ` ${standing.title}.` : ""}`;
  el.setAttribute("aria-label", tip);
  el.setAttribute("title", tip);
}

/**
 * Which glyph. Settled and working are different glyphs and not the same
 * one spinning or not, because a spin is not something a glance can see.
 * Settled with files that need a person is not the synced cloud either.
 */
function iconFor(state: State): string {
  switch (state.kind) {
    case "paused":
      return "pause";
    case "unpaired":
      return "link";
    // Working while an attempt is out, and the offline glyph while it waits
    // on one that got no answer: the same two things the reconnect loop's
    // states say.
    case "pairing":
      return state.retryAt === undefined ? "refresh-cw" : "cloud-off";
    case "connecting":
    case "loading":
    case "syncing":
      return "refresh-cw";
    case "review":
      return "list-checks";
    case "synced":
      if (state.refused > 0 || state.waiting > 0 || state.recoveryUnknown !== undefined) {
        return "alert-circle";
      }
      // Not a tick. Something is still owed and will be tried again, which is
      // neither "done" nor "somebody has to look at this" (Codex-03).
      return (state.pending ?? 0) > 0 ? "refresh-cw" : "cloud-check";
    case "offline":
      return "cloud-off";
    case "failed":
    case "stopped":
      return "alert-triangle";
  }
}

function toneFor(state: State): string {
  switch (state.kind) {
    case "stopped":
    case "failed":
      return "trew-attention";
    // No tone. These used --text-faint, which measures 2.57:1 against the
    // status bar in dark and 2.12:1 in light, under the 3:1 that a UI icon
    // needs to be made out. Offline in particular is the state that means
    // notes are not reaching the server, and it was the least legible thing
    // on the screen. Untinted, they inherit the status bar's own colour and
    // sit at the same weight as every item beside them; the glyph is what
    // tells them apart.
    case "offline":
    case "paused":
    case "unpaired":
      return "";
    case "pairing":
      return state.retryAt === undefined ? "trew-working" : "";
    case "connecting":
    case "loading":
    case "syncing":
      return "trew-working";
    // Somebody has to act, and nothing happens until they do.
    case "review":
      return "trew-attention";
    case "synced":
      return state.refused > 0 || state.waiting > 0 || state.recoveryUnknown !== undefined
        ? "trew-attention"
        : "";
  }
}

/** The panel's own document, which is where the long form of all of this lives. */
/**
 * The shortest gap between two of the Notices a phone gets about its own sync
 * state.
 *
 * There is no status bar on mobile, so a Notice is the only way to say
 * "offline" or "some files need attention" to somebody who has not opened the
 * panel. It is also the most intrusive thing this plugin can do, and a radio
 * that drops and returns every few seconds would otherwise produce one per
 * drop. Five minutes is long enough that the second one means something.
 */
const PHONE_NOTICE_GAP_MS = 5 * 60_000;

/**
 * How many outstanding paths the panel names before it stops being a message.
 *
 * The engine caps its own lists at five for the same reason, and this matches
 * it: a wall of four hundred identical sentences is not a list somebody reads.
 * Whatever is not shown is counted and said.
 */
const LISTED_IN_PANEL = 5;

const DOCS = "https://github.com/waynehoover/trewsync/blob/main/docs/plugin.md";

/**
 * Native settings groups on current Obsidian; flat rows on older releases.
 *
 * Behind both checks for the reason the command line handlers are: the version
 * is what the directory's review recognises, and `typeof` is what asks.
 */
function settingGroup(host: HTMLElement): HTMLElement {
  return requireApiVersion("1.11.0") && typeof SettingGroup === "function"
    ? new SettingGroup(host).listEl
    : host.createDiv();
}

/** A native row, with a short description only when the action needs context. */
function row(host: HTMLElement, name: string, description = ""): Setting {
  const setting = new Setting(host).setName(name);
  if (description) setting.setDesc(description);
  return setting;
}

/**
 * A paragraph that is filled later, and takes no room until it is.
 *
 * An empty `<p>` still occupies a line. With a description under every row
 * that went unnoticed; with rows that are a label and a control, the reserved
 * space under "Add another device" was visibly wider than the gap under every
 * other row, and it was two paragraphs waiting for an invite that did not
 * exist yet. `say` is the only way to fill one, so a caller cannot set the
 * text and forget to reveal it.
 */
function later(host: HTMLElement, cls: string): HTMLElement {
  const el = host.createEl("p", { cls });
  el.hide();
  return el;
}

/** Fills a `later` paragraph and reveals it, or empties and hides it again. */
function say(el: HTMLElement, text: string): void {
  el.setText(text);
  el.toggle(text !== "");
}

/**
 * How many deletions a page of the recovery list holds.
 *
 * Small enough to read and large enough that paging is rare. The server caps
 * what it will return whatever this says; the point of a fixed size is that
 * the cursor does the walking rather than an ever-growing request (F21).
 */
const PAGE_SIZE = 50;

/** A link out to `DOCS`, which is the panel's answer to "but why". */
function docsLink(el: HTMLElement, text: string): void {
  el.createEl("a", { text }).setAttribute("href", DOCS);
}

/** Shared settings and modal content. Recovery notices remain visible when needed. */
class TrewPanel {
  private closed = false;
  private unwatch: (() => void) | undefined;
  private stopDelivery: (() => void) | undefined;
  private renderGeneration = 0;
  private unwatchUnload: () => void;

  /**
   * `host` is where it draws and `dismiss` is what "I am done here" means,
   * which is the whole of the difference between the two places it appears.
   * In the modal that closes it; in the settings tab there is nothing to
   * close, so the tab hands it a function that does nothing and the panel
   * does not have to know which one it is in.
   */
  constructor(
    private readonly plugin: TrewPlugin,
    private readonly host: HTMLElement,
    private readonly dismiss: () => void,
    private incomingInvite?: string,
  ) {
    this.unwatchUnload = plugin.watchUnload(() => this.teardown());
  }

  /**
   * Forgets the invite a link brought, and anything typed into the form, once
   * a pairing holds this vault.
   *
   * An invite fills the field for the pairing it arrived for and no other. The
   * panel a QR opened stayed open on a phone through its pairing, its
   * revocation and an unlink, and the form the unlink drew was filled in with
   * that first invite, long since spent (M3's third finding). Called whenever
   * a pairing is being finished or is in use, which is every way one reaches
   * the disk, the background finish of an interrupted one included.
   */
  private forgetInvite(): void {
    this.incomingInvite = undefined;
    this.joinDraft = undefined;
  }

  teardown(): void {
    this.unwatchUnload();
    this.closed = true;
    this.renderGeneration++;
    this.stopDelivery?.();
    // Nothing here holds a pairing waiting on the panel: the populated-vault
    // confirmation is a panel step that runs no pairing until Continue, so
    // closing the panel on it leaves nothing pending (R40's rule, that every
    // wait answers on every way out of it, holds by having no wait).
    this.joinDraft = undefined;
    this.confirmMerge = false;
    this.unwatch?.();
    this.host.empty();
  }

  render(): void {
    // A pending settings request may finish after its modal or tab was closed.
    if (this.closed) return;
    this.renderGeneration++;
    this.stopDelivery?.();
    this.unwatch?.();
    this.host.empty();

    this.host.addClass("trew-panel");
    const contentEl = this.host;
    // First, and on every screen the panel draws, paired or not: the notice
    // lasts as long as the plugin runs on the platform (PLAN.md section 4.12).
    this.renderPlatformStanding(contentEl);

    const problem = this.plugin.configProblem;
    if (problem !== undefined) {
      this.renderUnreadable(contentEl, problem);
      this.watchShape();
      return;
    }
    // A pairing being finished is neither of the two screens below. The form
    // would write a second credential over one the server may already have
    // registered, and the paired panel would offer syncing, invites and a
    // device list to a vault that has not been told it may connect.
    const pending = this.plugin.pendingPairing;
    if (pending !== undefined) {
      this.forgetInvite();
      this.renderFinishing(contentEl, pending);
      return;
    }
    if (!this.plugin.paired) {
      this.renderPairing(contentEl);
      this.watchShape();
      return;
    }
    // A device the server refuses gets the way back and nothing else. Every row
    // of the paired panel needs the credential that was refused, and a phone
    // told to pair again used to be shown all of them and no invite field: the
    // way on was Manage this vault, then Unlink (M3's second finding).
    if (offersPairAgain(this.plugin.currentState)) {
      this.renderPairing(contentEl, true);
      this.watchShape();
      return;
    }
    this.forgetInvite();

    const primary = settingGroup(contentEl);
    const sync = row(primary, "Sync status");
    const status = sync.descEl;
    // What is outstanding, by name and with its reason, under the status line.
    //
    // These reasons used to exist for the twenty seconds a notice was on
    // screen and then be a number, while the guide told people to look in the
    // panel for them (Codex-03). A person who put their phone down during a
    // sync had no way back to what it had said.
    const outstanding = contentEl.createDiv("trew-outstanding");
    status.addClass("trew-sync-status");
    this.renderDelivery(sync.infoEl);
    status.setAttribute("role", "status");
    let syncButton!: ButtonComponent;
    sync.addButton((b) => {
      syncButton = b;
      b.setButtonText("Sync now").onClick(async () => {
        await this.plugin.syncNow();
      });
    });

    const addDevice = contentEl.createEl("details", { cls: "trew-add-device" });
    addDevice.createEl("summary", { text: "Add another device" });
    this.renderInvite(settingGroup(addDevice));

    // The two cursors and what answered them, behind a disclosure.
    //
    // Three paragraphs of numbers at the top of the panel is what this was, and
    // they are the answer to "why is it not working" rather than to "is it
    // working": the status line above says the second. So they fold away.
    //
    // The summary keeps I11's point rather than burying it. That finding is why
    // both cursors are shown at all, so being behind has to be visible without
    // opening anything: the summary says how far behind, and the section starts
    // open when it is.
    const server = contentEl.createEl("details", { cls: "trew-server" });
    const serverSummary = server.createEl("summary");
    const cursors = later(server, "trew-advice");
    const connection = later(server, "trew-advice");
    const connectionWarning = later(server, "trew-advice");
    this.renderServerAddress(settingGroup(server));
    const advice = later(primary, "trew-advice");
    // Which rows this pass drew, so that a panel left open when the state
    // changes under it grows the recovery it now needs. Everything else here
    // is text a listener can update; a row is not, and a panel that was open
    // when the server was restored would otherwise say "stopped" beside no way
    // out until it was closed and opened again.
    // What shape this pass drew, so a panel left open when the vault changes
    // under it is redrawn rather than patched.
    //
    // This used to watch one thing, whether a rejoin row was needed. Unlinking
    // from another surface therefore left every paired row on screen with "Not
    // paired." above them: Sync, Add another device, Manage this vault and a
    // Browse deleted that opened a recovery modal against a vault with no
    // credential. Reported from the settings tab, which is the surface most
    // likely to be sitting open while something else does the unlinking.
    this.watchShape(() => {
      const state = this.plugin.currentState;
      status.setText(longStatus(state));
      this.renderOutstanding(outstanding, state);
      const busy =
        state.kind === "connecting" || state.kind === "loading" || state.kind === "syncing";
      syncButton.setDisabled(busy).setButtonText(
        state.kind === "paused"
          ? "Resume sync"
          : // Sync now opens the review a pass is waiting on.
            state.kind === "review"
            ? "Review changes"
            : state.kind === "offline"
              ? "Reconnect"
              : state.kind === "connecting"
                ? "Connecting…"
                : state.kind === "loading"
                  ? "Loading…"
                  : state.kind === "syncing"
                    ? "Syncing…"
                    : "Sync now",
      );
      // Both cursors, so "behind and nothing arriving" is something a person
      // can see (I11).
      const at = this.plugin.cursors();
      say(cursors, at === undefined ? "" : `Local cursor ${at.local}, server cursor ${at.server}.`);
      const behind = at === undefined ? 0 : Math.max(0, at.server - at.local);
      const showBehind = behind > 0 && state.kind !== "loading";
      serverSummary.setText(showBehind ? `Server · ${behind} behind` : "Server");
      // Opened, not just labelled, the first time it matters: a section that
      // says "42 behind" and stays shut is I11's defect wearing a summary.
      if (showBehind) server.setAttribute("open", "true");
      const to = this.plugin.connection();
      say(connection, to === undefined ? "" : describeConnection(to));
      say(connectionWarning, to?.url.startsWith("ws://") ? connectionDetail(to) : "");
      say(advice, originAdvice(state));
    });

    // Only while it is the answer to something, and never inside the
    // disclosure below: a device the server has refused has to say so, and
    // offer the way out, without anybody opening anything first.
    if (offersRejoin(this.plugin.currentState)) this.renderRejoin(primary);

    row(primary, "Recover a deleted note", "Restore a copy.").addButton((b) =>
      b.setButtonText("Browse deleted").onClick(() => {
        // Checked at the press as well as by the shape watcher above, because
        // a panel can be looked at for a while: a click that arrives after the
        // vault was unlinked elsewhere used to open a recovery modal with no
        // credential behind it, which then failed inside the modal. A sentence
        // where the modal would have been, which is what `syncNow` and
        // `createInvite` already do.
        if (!this.plugin.paired) {
          new Notice("TrewSync: this vault is not paired yet. There is nothing to recover.");
          return;
        }
        this.dismiss();
        new RecoverModal(this.plugin).open();
      }),
    );

    // Everything rare, behind one press. Named for what is inside rather than
    // "Advanced", which says nothing and reads as a dare.
    const manage = contentEl.createEl("details", { cls: "trew-manage" });
    manage.createEl("summary", { text: "Manage this vault" });
    const management = settingGroup(manage);
    this.renderThisDeviceName(management);
    this.renderStranded(management);
    this.renderIgnored(management);
    this.renderSettingsSync(management);
    this.renderDevices(management);

    // Beside the device list rather than under recovery, because it is a thing
    // done to the server and not to this vault, and it is here at all for the
    // reason rejoin is: the documented alternative for a plugin device was
    // nothing. A phone may hold the only remaining copy of a body the server
    // has lost, and it has no shell to run `trew repair` in (I14).
    row(
      management,
      "Send back what the server has lost",
      "Repair missing server content using notes on this device.",
    ).addButton((b) =>
      b.setButtonText("Send").onClick(async () => {
        b.setDisabled(true).setButtonText("Sending");
        try {
          const out = await this.plugin.repair();
          // Both halves of the answer, always. "Sent 3" without "and this
          // device cannot reach the rest" is the comfortable half of a story
          // whose other half decides whether to go and find another machine.
          const parts: string[] = [];
          parts.push(
            out.stored > 0
              ? `Sent ${out.stored} back.`
              : "The server already had everything this device can offer.",
          );
          if (out.stillMissing > 0) {
            parts.push(`${out.stillMissing} would not store; check the server's disk.`);
          }
          if (out.failed.length > 0) {
            parts.push(`${out.failed.length} could not be read here.`);
          }
          parts.push(
            "Do this on your other devices too. Anything still missing is history this " +
              "device never had.",
          );
          new Notice(`TrewSync: ${parts.join(" ")}`, 15_000);
        } catch (err) {
          new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
        } finally {
          b.setDisabled(false).setButtonText("Send");
        }
      }),
    );

    row(
      management,
      "Unlink this vault",
      "Stop syncing on this device. Local and server notes are kept.",
    ).addButton((b) =>
      b
        .setButtonText("Unlink")
        .setWarning()
        .onClick(async () => {
          try {
            await this.plugin.unlink();
          } catch (err) {
            new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
          }
          this.render();
        }),
    );

    docsLink(contentEl.createEl("p", { cls: "trew-advice" }), "TrewSync documentation");
  }

  /**
   * A row saying this platform is unsupported or untested, and what that
   * leaves untested, on Windows and iOS only (PLAN.md section 4.12).
   *
   * Not dismissable, deliberately: the decision was to pair on these platforms
   * with a notice that lasts, rather than to refuse, and a notice somebody can
   * close is a toast with extra steps.
   */
  private renderPlatformStanding(host: HTMLElement): void {
    const standing = platformStanding(Platform);
    if (standing === undefined) return;
    const setting = row(settingGroup(host), standing.title, standing.detail);
    setting.settingEl.addClass("trew-platform-standing");
    setting.descEl.createEl("br");
    setting.descEl
      .createEl("a", { text: "Which platforms TrewSync supports" })
      .setAttribute("href", SUPPORT_TABLE);
  }

  /**
   * The paths this device has not synced, with what it says about each.
   *
   * Two kinds, kept apart, because they need different things from a person
   * (rule 7): a written-off path is one somebody has to look at, and a
   * retrying one is one to leave alone until the deadline. Rebuilt in place on
   * every state change rather than redrawn as rows, so a panel left open
   * follows the vault.
   */
  private renderOutstanding(host: HTMLElement, state: State): void {
    host.empty();
    if (state.kind !== "synced") return;
    const issues = state.issues ?? [];
    const retrying = state.retryingPaths ?? [];
    if (issues.length === 0 && retrying.length === 0) return;

    if (issues.length > 0) {
      const list = host.createEl("ul", { cls: "trew-outstanding-list" });
      for (const issue of issues.slice(0, LISTED_IN_PANEL)) {
        list.createEl("li", { text: `${issue.path}: ${issue.why}` });
      }
      // Said, rather than left to a count that does not add up. The engine
      // caps its own list, so the panel showing five of forty has to say so.
      const more = state.refused - Math.min(issues.length, LISTED_IN_PANEL);
      if (more > 0) {
        host.createEl("p", {
          cls: "trew-advice",
          text: `And ${more} more not listed here. Sync activity has the full record.`,
        });
      }
    }

    if (retrying.length > 0) {
      const when =
        state.pendingAt === undefined
          ? ""
          : ` Next attempt ${new Date(state.pendingAt).toLocaleTimeString()}.`;
      const count = state.pending ?? retrying.length;
      host.createEl("p", {
        cls: "trew-advice",
        text:
          `${count} ${count === 1 ? "file is" : "files are"} waiting to be sent again: ` +
          `${retrying.slice(0, LISTED_IN_PANEL).join(", ")}.${when}`,
      });
    }
  }

  /** Form fields survive ordinary updates; a different pairing redraws every surface. */
  private watchShape(update: () => void = () => {}): void {
    const shape = () =>
      JSON.stringify([
        this.plugin.configProblem !== undefined,
        this.plugin.paired,
        this.plugin.pendingPairing !== undefined,
        this.plugin.pairingFailure,
        offersRejoin(this.plugin.currentState),
        offersPairAgain(this.plugin.currentState),
      ]);
    const drawn = shape();
    this.unwatch = this.plugin.watchState(() => {
      if (shape() !== drawn) this.render();
      else update();
    });
  }

  private renderServerAddress(contentEl: HTMLElement): void {
    let address!: TextComponent;
    const setting = row(
      contentEl,
      "Server address",
      "Update this if your server moves to a new address.",
    );
    const said = later(contentEl, "trew-advice");
    setting
      .addText((text) => {
        address = text;
        text.setPlaceholder("wss://sync.example.com").setValue(this.plugin.connection()?.url ?? "");
        literalInput(text, true);
        text.inputEl.setAttribute("aria-label", "Server address");
      })
      .addButton((button) =>
        button.setButtonText("Save").onClick(async () => {
          button.setDisabled(true).setButtonText("Checking…");
          say(said, "");
          try {
            await this.plugin.changeServerAddress(address.getValue());
            new Notice("TrewSync: server address saved.");
            this.render();
          } catch (err) {
            say(said, (err as Error).message);
          } finally {
            button.setDisabled(false).setButtonText("Save");
          }
        }),
      );
  }

  /** Load devices on demand; explain revocation at the confirmation step. */
  private renderDevices(contentEl: HTMLElement): void {
    // Declared here and created below the setting that fills them, for the
    // same reason renderInvite does it: created first, the rows rendered
    // above the "Devices" row and the list appeared to belong to whatever
    // sat above it. Found by taking a screenshot of the panel, twice now,
    // which is a better reviewer of layout than a test.
    let list!: HTMLElement;
    let said!: HTMLElement;
    let loading = false;
    let refresh!: ButtonComponent;
    const show = async () => {
      if (loading) return;
      loading = true;
      refresh.setDisabled(true);
      say(said, "");
      let answer: {
        devices: DeviceRow[];
        invites: InviteRow[];
        thisDevice: string;
      };
      try {
        answer = await this.plugin.devices();
      } catch (err) {
        say(said, (err as Error).message);
        return;
      } finally {
        loading = false;
        refresh.setDisabled(false);
      }
      list.empty();
      // Every row can be revoked, the last one included, which reading the
      // list at all means is this device. The way back into a vault with no
      // devices is `trewd invite` on the server, and the confirmation says so
      // on that row rather than the panel hiding the button.
      const last = answer.devices.length === 1;
      heading.setDesc(
        `${answer.devices.length} ${answer.devices.length === 1 ? "device" : "devices"}`,
      );
      const names = new Map<string, number>();
      for (const device of answer.devices) {
        const name = device.name || "Unnamed device";
        names.set(name, (names.get(name) ?? 0) + 1);
      }
      for (const device of answer.devices) {
        const mine = device.id === answer.thisDevice;
        // Flagged rather than left as a blank, because a row nothing has ever
        // connected under is the reclaimable one: a pairing that reached the
        // server and never finished here leaves exactly that.
        const cursor = this.plugin.cursors()?.server;
        const seen =
          cursor === undefined ? "Delivery unconfirmed" : describeDelivery(device, cursor);
        const name = device.name || "Unnamed device";
        const row = new Setting(list)
          .setName(`${name}${mine ? " (this device)" : ""}`)
          // Keep identical names distinguishable before a destructive action.
          .setDesc(names.get(name)! > 1 ? `${seen} · ID ${device.id}` : seen);
        let confirmed = false;
        row.addButton((b) =>
          b
            .setButtonText(mine ? "Unlink from the server" : "Revoke")
            .setWarning()
            .onClick(async () => {
              if (!confirmed) {
                confirmed = true;
                b.setButtonText("Yes, revoke");
                // What revoking does not do, said before it is done: nothing
                // a device already synced is taken back, and without
                // end-to-end encryption what it holds is readable as it is.
                say(
                  said,
                  `${mine ? "This device" : `"${name}"`} will stop syncing. Revoking does not ` +
                    `un-read anything: the notes already on ${mine ? "it" : "that device"} stay ` +
                    `readable there, in plaintext.` +
                    (last
                      ? " It is the vault's last device, so adding one back takes an invite " +
                        "from trewd invite on the server."
                      : "") +
                    " Press again to revoke.",
                );
                return;
              }
              try {
                await this.plugin.revoke(device.id);
                new Notice("Device revoked. Existing notes on that device are kept.", 10_000);
                this.render();
              } catch (err) {
                say(said, (err as Error).message);
              }
            }),
        );
      }
      // The invites under the rows, because they are the same question: a row
      // is a device that was added and an outstanding invite is one about to
      // be. Its id, its label and its expiry, and never the string itself:
      // the listing carries nothing that redeems (plan/protocol.md, "Devices
      // and invites"), and what the id is for is saying which invite to cancel.
      for (const invite of answer.invites) {
        const expiry =
          invite.expiresAt === null ? "Does not expire" : `Expires ${when(invite.expiresAt)}`;
        const row = new Setting(list)
          .setName(
            invite.label === "" ? "Outstanding invite" : `Outstanding invite: ${invite.label}`,
          )
          .setDesc(`${expiry} · ID ${invite.invite}`);
        row.addButton((b) =>
          b
            .setButtonText("Cancel")
            .setWarning()
            .onClick(async () => {
              try {
                await this.plugin.uninvite(invite.invite);
                new Notice("Invite cancelled. It can no longer add a device.", 10_000);
                this.render();
              } catch (err) {
                say(said, (err as Error).message);
              }
            }),
        );
      }
    };

    const heading = row(
      contentEl,
      "Devices",
      "View connected devices and manage their access.",
    ).addButton((b) => {
      refresh = b;
      b.setButtonText("Show devices").onClick(show);
    });

    list = contentEl.createDiv();
    said = later(contentEl, "trew-advice");
  }

  /** Share delivery checks across open settings surfaces without rebuilding controls. */
  private renderDelivery(host: HTMLElement): void {
    const line = later(host, "setting-item-description trew-delivery");
    line.setAttribute("aria-live", "polite");
    this.stopDelivery = watchDelivery(
      this.plugin,
      (message) => {
        if (line.textContent !== message) say(line, message);
      },
      // Undefined is watchDelivery's default, the global document.
      typeof line.ownerDocument?.addEventListener === "function" ? line.ownerDocument : undefined,
    );
  }

  /** Show the QR and a selectable pairing code, with Copy beside the code. */
  private renderInvite(contentEl: HTMLElement): void {
    let currentInvite = "";
    let codeField!: TextComponent;
    row(
      contentEl,
      "Add another device",
      "Create a one-time invite. Expires in one hour.",
    ).addButton((b) =>
      b.setButtonText("Create invite").onClick(async () => {
        try {
          const issued = await this.plugin.createInvite();
          currentInvite = issued.invite;
          codeField.setValue(issued.invite);
          codeField.inputEl.scrollLeft = 0;
          codeRow.settingEl.show();
          let scanAdvice = "Copy the invite into TrewSync on the new device.";
          try {
            qr.setAttribute("src", inviteQrImage(issued.invite));
            qr.show();
            scanAdvice =
              "Scan with your phone's camera. TrewSync must be installed and enabled in Obsidian.";
          } catch {
            // Long server addresses can exceed QR capacity. Copy still works.
            qr.hide();
          }
          say(
            expiry,
            issued.expiresAt === null
              ? `${scanAdvice} It does not expire, so cancel it from the device list once it is used.`
              : `${scanAdvice} Expires at ${when(issued.expiresAt)}.`,
          );
          await copyToClipboard(
            issued.invite,
            "Copied. Paste it into TrewSync on the other device.",
          );
        } catch (err) {
          new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
        }
      }),
    );

    const qr = contentEl.createEl("img", { cls: "trew-invite-qr" });
    qr.setAttribute("alt", "Scan to open this invite in Obsidian");
    qr.hide();
    const expiry = later(contentEl, "trew-advice");
    const codeRow = row(
      contentEl,
      "Pairing code",
      "Paste this into the Invite field of TrewSync on your other device.",
    );
    codeRow.settingEl.addClass("trew-invite-code");
    codeRow.settingEl.hide();
    codeRow
      .addText((text) => {
        codeField = text;
        text.inputEl.setAttribute("readonly", "");
        text.inputEl.setAttribute("aria-label", "Pairing code");
        text.inputEl.addEventListener("focus", () => text.inputEl.select());
      })
      .addButton((button) => {
        button.setButtonText("Copy");
        button.buttonEl.setAttribute("aria-label", "Copy pairing code");
        button.onClick(async () => {
          if (currentInvite === "") return;
          await copyToClipboard(
            currentInvite,
            "Copied. Paste it into TrewSync on the other device.",
          );
        });
      });
  }

  /**
   * The way back from a server that has lost history this device applied.
   *
   * Two presses, and the first one is not destructive: it asks the server where
   * it is and puts both numbers on screen, which is also how somebody finds out
   * that this is not their problem. The confirmation is worth more on a phone
   * than anywhere: a button is one tap from a thumb.
   */
  private renderRejoin(contentEl: HTMLElement): void {
    const said = later(contentEl, "trew-advice");
    let confirmed = false;
    row(
      contentEl,
      "Rejoin this server",
      "The server has older history. Back it up before rejoining; local notes are kept.",
    ).addButton((b) =>
      b
        .setButtonText("Rejoin")
        .setWarning()
        .onClick(async () => {
          try {
            if (!confirmed) {
              const at = await this.plugin.rejoinCursors();
              refuseUnlessAhead(at);
              confirmed = true;
              b.setButtonText("Yes, rejoin");
              say(
                said,
                `This device is at version ${at.local} and the server is at ${at.server}. ` +
                  `Take a backup of the server first (trewd backup). Press again to rejoin.`,
              );
              return;
            }
            say(said, "Rejoining. This sends everything only this device holds.");
            const report = await this.plugin.rebase();
            say(
              said,
              `Rejoined the server: ${summarise(report)}. Nothing was deleted, and where the ` +
                `two sides disagreed both versions were kept.`,
            );
            new Notice(`TrewSync rejoined the server: ${summarise(report)}`, 10_000);
            this.render();
          } catch (err) {
            say(said, "");
            new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
          }
        }),
    );
  }

  /**
   * This device's own name, changeable, which it was not until protocol 5.
   *
   * The name is what the device list, a note's history and every conflict copy
   * are read by, and it was chosen once at pairing and then fixed: a typo or a
   * laptop that became something else meant unlinking and pairing again, which
   * makes a new row and detaches the old one's history of who wrote what.
   *
   * Under Manage rather than on the front of the panel, with the device list it
   * changes, because it is a thing done once and not a thing done often.
   *
   * The server first and the config after, which is the order `client.rename`
   * explains. If the save fails the sentence says both halves, because "renamed"
   * and "written down here" are different facts and the visible consequence of
   * the second failing is conflict copies that still carry the old name.
   */
  private renderThisDeviceName(contentEl: HTMLElement): void {
    let field: TextComponent | undefined;
    const setting = row(
      contentEl,
      "This device's name",
      "Shown in the device list and future sync activity.",
    );
    setting.addText((t) => {
      t.setPlaceholder("laptop");
      t.inputEl.setAttribute("aria-label", "This device's name");
      t.setValue(this.plugin.deviceName ?? "");
      field = t;
    });
    setting.addButton((b) =>
      b.setButtonText("Rename").onClick(async () => {
        const wanted = (field?.getValue() ?? "").trim();
        if (wanted === "") {
          new Notice("A device name cannot be empty.");
          return;
        }
        if (wanted === this.plugin.deviceName) {
          new Notice("That is already this device's name.");
          return;
        }
        b.setDisabled(true).setButtonText("Renaming");
        try {
          const said = await this.plugin.renameDevice(wanted);
          new Notice(`This device is now ${said} in the device list.`);
          this.render();
        } catch (err) {
          new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
          b.setDisabled(false).setButtonText("Rename");
        }
      }),
    );
  }

  /**
   * What this device skips, and a way to change it (R083-13).
   *
   * A list of names with a Remove each, and one field to add another, rather
   * than a text area of comma-separated anything. The names are somebody's
   * folders and the failure mode of free text is a typo that silently syncs
   * the folder they asked to skip; a name that is already on the list is
   * visible, and one that is not was never accepted.
   */
  /**
   * Settings sync, for this device (plan/settings-sync.md): off unless turned
   * on here, and with its folder named, because the folder is what decides
   * which devices share settings.
   */
  private renderSettingsSync(contentEl: HTMLElement): void {
    const root = this.plugin.settingsRoot;
    const folder = this.plugin.app.vault.configDir;
    if (root === undefined) {
      row(
        contentEl,
        "Sync settings",
        `Not available: this device's settings folder is ${folder}, and settings sync uses .obsidian, ` +
          "or .obsidian- and a name in lower case letters, digits and dashes.",
      );
      return;
    }
    const on = this.plugin.syncsSettings;
    const held = this.plugin.settingsHeld;
    const setting = row(
      contentEl,
      "Sync settings",
      on
        ? `On. Obsidian's settings, themes and CSS snippets in ${root} sync with every device that uses ${root}. ` +
            `Changes from them wait until you apply them, which reloads Obsidian.` +
            (held > 0 ? ` ${held} waiting now.` : "")
        : `Off. Turn on to sync Obsidian's settings, themes and CSS snippets in ${root} with every device ` +
            "that uses the same folder. Plugins do not sync yet.",
    );
    if (on && held > 0) {
      setting.addButton((b) =>
        b
          .setButtonText("Apply and reload")
          .setCta()
          .onClick(() => this.plugin.applySettingsNow()),
      );
    }
    setting.addButton((b) =>
      b.setButtonText(on ? "Turn off" : "Turn on").onClick(async () => {
        if (!on) {
          this.dismiss();
          new SettingsSyncModal(this.plugin).open();
          return;
        }
        b.setDisabled(true).setButtonText("Saving");
        try {
          await this.plugin.setSettingsSync(false);
          this.render();
        } catch (err) {
          new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
          b.setDisabled(false).setButtonText("Turn off");
        }
      }),
    );
    row(
      contentEl,
      "Settings profile",
      // The profile with no name after it is the one Obsidian makes.
      root.includes("-")
        ? `This device uses ${root}, and shares settings with every device that uses ${root}.`
        : `This device uses ${root}, the settings folder desktops usually share. To keep this device's ` +
            "settings apart, a phone's for example, give it a profile of its own.",
    ).addButton((b) =>
      b.setButtonText("Create a profile").onClick(() => {
        this.dismiss();
        new ProfileModal(this.plugin).open();
      }),
    );
  }

  private renderIgnored(contentEl: HTMLElement): void {
    const names = this.plugin.ignoredNames;
    const setting = row(
      contentEl,
      "Skip these on this device",
      names.length === 0
        ? "Nothing beyond hidden folders and Obsidian's own. This device only; other devices keep syncing them."
        : `Not synced here: ${names.join(", ")}. This device only; other devices keep syncing them.`,
    );
    let field: TextComponent | undefined;
    setting.addText((t) => {
      t.setPlaceholder("Attachments");
      t.inputEl.setAttribute("aria-label", "A folder or file name to skip on this device");
      field = t;
    });
    const change = async (wanted: readonly string[], button: ButtonComponent, was: string) => {
      button.setDisabled(true).setButtonText("Saving");
      try {
        await this.plugin.setIgnoredNames(wanted);
        this.render();
      } catch (err) {
        new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
        button.setDisabled(false).setButtonText(was);
      }
    };
    setting.addButton((b) =>
      b.setButtonText("Skip").onClick(async () => {
        const wanted = (field?.getValue() ?? "").trim();
        if (!isIgnorableName(wanted)) {
          new Notice("TrewSync: give one folder or file name, with no slashes in it.");
          return;
        }
        if (names.includes(wanted)) {
          new Notice(`TrewSync: ${wanted} is already skipped on this device.`);
          return;
        }
        await change([...names, wanted], b, "Skip");
      }),
    );
    for (const name of names) {
      row(
        contentEl,
        name,
        "Skipped on this device. Removing it syncs it again from the next pass.",
      ).addButton((b) =>
        b.setButtonText("Sync it").onClick(async () => {
          await change(
            names.filter((other) => other !== name),
            b,
            "Sync it",
          );
        }),
      );
    }
  }

  /**
   * A way back to the versions this device could not leave visible (Codex-08).
   *
   * The panel said these existed and stopped there, so getting them back meant
   * a file manager or a terminal, on a phone that has neither, for what is
   * sometimes the only surviving copy of a note. The row is drawn even when
   * the inventory is empty *and incomplete*, because "nothing is stranded" and
   * "I cannot tell you what is stranded" are different answers (rule 2).
   */
  private renderStranded(contentEl: HTMLElement): void {
    // From the state, which the pass already put there, rather than from a
    // fresh read: the row is drawn on every panel render and the modal is the
    // thing that goes and looks.
    const state = this.plugin.currentState;
    const waiting = state.kind === "synced" ? state.waiting : 0;
    const unknown = state.kind === "synced" ? state.recoveryUnknown : undefined;
    if (waiting === 0 && unknown === undefined) return;
    row(
      contentEl,
      "Versions kept out of sight",
      unknown === undefined
        ? `${waiting} ${waiting === 1 ? "version is" : "versions are"} under a name Obsidian does not show.`
        : `TrewSync cannot tell what is waiting: ${unknown}`,
    ).addButton((b) =>
      b.setButtonText("Look").onClick(() => {
        this.dismiss();
        new StrandedModal(this.plugin).open();
      }),
    );
  }

  /**
   * A config that is there and cannot be read gets no pairing form.
   *
   * Pairing writes a new credential over the old one, and the old one may be
   * the only copy of a live row's token. The only safe offers are the reason
   * and the path.
   */
  private renderUnreadable(contentEl: HTMLElement, problem: string): void {
    contentEl.createEl("p", { text: `TrewSync has stopped: ${problem}` });
    contentEl.createEl("p", {
      text:
        `Pairing again would replace the credential in ${this.plugin.dataPath}, so nothing here ` +
        `offers to. Fix or move that file, then reload the plugin.`,
    });
  }

  /**
   * One field, "Invite", and one button, "Pair".
   *
   * This screen has been rebuilt several times and always for the same
   * reason: it asked somebody to choose between kinds of string before it
   * would draw a form, when the string in their clipboard had already made
   * the choice. There is one kind now. Every device pairs from an invite, the
   * first one included: `trewd serve` writes the first device's invite to
   * `first-invite` in its data folder, `trewd invite` on the server prints
   * more, and a paired device's panel mints them.
   *
   * The line under the field says where the invite points before anything
   * can be pressed (R083-05): an unpaired vault pointed at somebody else's
   * server uploads itself there on the first sync, and an invite that arrived
   * through `obsidian://trew?invite=...` was filled in by whoever sent the
   * link. A string that is not an invite, a Basalt one included, gets the
   * reason it cannot be read, and the button stays disabled.
   *
   * The two things somebody might still want are behind *More options*, with
   * working defaults in place: a device name suggested from the platform, and
   * the skip list, which stays on this screen rather than moving to the paired
   * panel because pairing starts the download immediately and a phone joining
   * a vault of attachments has to be able to say no before that (Codex-05).
   *
   * `again` is the same form for a device the server has refused, led by what
   * happened and what it leaves: `pair` writes the new pairing over the
   * refused one and removes the old index after it, which is what unlinking
   * did as a separate step, and the merge is confirmed first as for any vault
   * that holds notes.
   */
  private renderPairing(host: HTMLElement, again = false): void {
    // And what it skipped, once, before the first draw: a phone that left a
    // large attachments folder alone would otherwise download all of it the
    // moment it paired again (Codex-05's reason for the list being here).
    if (again && !this.joinSkipSeeded) {
      this.joinSkip = [...this.plugin.ignoredNames];
      this.joinSkipSeeded = true;
    }
    if (this.confirmMerge && this.joinDraft) {
      const draft = this.joinDraft;
      new Setting(host).setName("Confirm merge").setHeading();
      host.createEl("p", {
        text: "This vault already contains files. They will be combined with your synced vault.",
      });
      host.createEl("p", {
        cls: "trew-advice",
        text:
          "Files moved or deleted on another device may reappear. " +
          "Conflicting edits may create copies.",
      });
      let cancel!: ButtonComponent;
      new Setting(host)
        .addButton((b) => {
          cancel = b;
          b.setButtonText("Cancel").onClick(() => {
            this.confirmMerge = false;
            this.render();
          });
        })
        .addButton((b) =>
          b
            .setButtonText("Continue")
            .setCta()
            .onClick(async () => {
              b.setDisabled(true);
              cancel.setDisabled(true);
              try {
                await this.pairFromPanel(draft.invite, draft.device, this.joinSkip, true);
              } finally {
                b.setDisabled(false);
                cancel.setDisabled(false);
              }
            }),
        );
      return;
    }

    if (again) {
      // What happened, what it leaves, and what to do, in that order and
      // before anything else: somebody whose phone has just stopped syncing
      // wants to know first whether their notes are still there.
      const state = this.plugin.currentState;
      const said = state.kind === "stopped" ? ` The server said: ${state.why}.` : "";
      new Setting(host).setName("Pair this device again").setHeading();
      host
        .createEl("p", {
          cls: "trew-advice",
          text:
            "This device can no longer sync: the server refuses its pairing, which is what " +
            `revoking it does.${said}`,
        })
        .setAttribute("role", "alert");
      host.createEl("p", {
        cls: "trew-advice",
        text:
          "Its notes stay where they are, on this device and on the server. Pair it again " +
          "with a new invite and it syncs as a new device.",
      });
    } else {
      new Setting(host).setName("Set up sync").setHeading();
    }
    // Why the last pairing did not finish, above the form that tries again.
    // A pairing refused while it was being finished in the background has no
    // other place to say so for longer than a notice lasts.
    const failed = this.plugin.pairingFailure;
    if (failed !== undefined) {
      host.createEl("p", { cls: "trew-advice", text: failed }).setAttribute("role", "alert");
    }
    const contentEl = settingGroup(host);

    let inviteField: TextComponent | undefined;
    row(
      contentEl,
      "Invite",
      again
        ? "Paste a new invite from a paired device's TrewSync panel, or make one with trewd invite " +
            "on the server."
        : "Paste an invite from a paired device's TrewSync panel. For the first device, use the one " +
            "trewd serve wrote to first-invite in its data folder, or make one with trewd invite on " +
            "the server.",
    ).addText((t) => {
      t.setPlaceholder("trew1i_...");
      t.inputEl.setAttribute("aria-label", "Invite");
      literalInput(t);
      const value = this.joinDraft?.invite ?? this.incomingInvite;
      if (value !== undefined) t.setValue(value);
      t.onChange(() => showDestination());
      inviteField = t;
    });

    // Where this invite goes, before it goes there (R083-05).
    const destination = contentEl.createEl("p", { cls: "trew-advice" });
    destination.setAttribute("role", "status");
    let goButton: ButtonComponent | undefined;

    const showDestination = () => {
      const value = inviteField?.getValue().trim() ?? "";
      let readable = false;
      if (value === "") {
        destination.setText("Paste an invite to see which server and vault it joins.");
      } else {
        try {
          const to = joinDestination(value);
          readable = true;
          // The vault is named only when somebody named it. Almost every
          // invite carries "default", which is the value assumed when a
          // string carries none, so naming it back reads as a placeholder
          // that leaked rather than as the confirmation this line is for.
          const named = to.vaultId !== DEFAULT_VAULT;
          destination.setText(
            named
              ? `Joins vault "${to.vaultId}" at ${to.url}. Check that this is your server.`
              : `Joins ${to.url}. Check that this is your server.`,
          );
        } catch (err) {
          // The codec's own reason, or `parseInvite`'s for a Basalt string:
          // one kind of string can go in this field, so a refusal names what
          // is wrong with it rather than guessing what else it might be.
          destination.setText(`Cannot read that: ${(err as Error).message}`);
        }
      }
      goButton?.setDisabled(!readable);
    };

    new Setting(contentEl).addButton((b) => {
      goButton = b;
      b.setButtonText("Pair")
        .setCta()
        .onClick(async () => {
          const value = inviteField?.getValue() ?? "";
          b.setDisabled(true);
          try {
            await this.pairFromPanel(value, device(), skipping());
          } finally {
            showDestination();
          }
        });
    });

    // More options, collapsed, because both have answers that work.
    //
    // A device name is suggested from the platform and is only ever a label in
    // the device list. A skip list is empty for almost everybody. Neither is a
    // decision most people have to make, and a screen that asks anyway is a
    // screen that says all four of these matter equally.
    //
    // Below the group rather than inside it, like the paired panel's
    // disclosures: a disclosure among the rows sat outside their padding and
    // drew a row border under its own summary, which only a screenshot showed.
    const more = host.createEl("details", { cls: "trew-more-options" });
    more.createEl("summary", { text: "More options" });
    const moreEl = settingGroup(more);

    let deviceField: TextComponent | undefined;
    const device = () => deviceField?.getValue() ?? "";

    // A suggestion in the field, not a placeholder behind it. A placeholder is
    // not a value, so the honest thing to do with the field was leave it
    // alone, and every device ended up named after the app rather than after
    // itself. What is offered is what will be used, and it can be typed over.
    row(moreEl, "Device name", "Shown in the device list and future sync activity.").addText(
      (t) => {
        t.setPlaceholder("laptop");
        t.inputEl.setAttribute("aria-label", "Device name");
        // Pairing again keeps the name this device already had: it is the same
        // machine, and its conflict copies should go on saying so.
        const kept = again ? this.plugin.deviceName : "";
        t.setValue(this.joinDraft?.device ?? (kept !== "" ? kept : suggestedDeviceName()));
        deviceField = t;
      },
    );

    this.renderJoinSkip(moreEl);
    const skipping = () => this.joinSkip;

    showDestination();

    docsLink(host.createEl("p", { cls: "trew-advice" }), "How pairing works");
  }

  /**
   * A pairing whose redemption went out and has not been answered.
   *
   * Neither the form nor the paired panel. The pending pairing on disk holds
   * the credential the server may already have registered, so what this
   * offers is the state, a way to try now rather than at the end of the
   * backoff, and a way to give up, which says what giving up may leave on the
   * server.
   */
  private renderFinishing(host: HTMLElement, pending: PendingPairing): void {
    new Setting(host).setName("Finishing pairing").setHeading();
    const group = settingGroup(host);
    const status = row(group, "Pairing status");
    status.descEl.addClass("trew-sync-status");
    status.descEl.setAttribute("role", "status");
    status.descEl.setText(longStatus(this.plugin.currentState));
    status.addButton((b) =>
      b.setButtonText("Try now").onClick(async () => {
        await this.plugin.syncNow();
      }),
    );
    const named = pending.vaultId !== DEFAULT_VAULT;
    group.createEl("p", {
      cls: "trew-advice",
      text: named
        ? `Joining vault "${pending.vaultId}" at ${pending.url}.`
        : `Joining ${pending.url}.`,
    });
    group.createEl("p", {
      cls: "trew-advice",
      text: adviseAfterPairing({
        remains: { kind: "pending", config: pending },
        surface: "panel",
        where: this.plugin.dataPath,
      }),
    });
    row(
      group,
      "Unlink this vault",
      "Give up this pairing. If the server did register it, the row stays in the device list " +
        "as a device that never connected, and another device can revoke it.",
    ).addButton((b) =>
      b
        .setButtonText("Unlink")
        .setWarning()
        .onClick(async () => {
          try {
            await this.plugin.unlink();
          } catch (err) {
            new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
          }
          this.render();
        }),
    );
    this.watchShape(() => {
      status.descEl.setText(longStatus(this.plugin.currentState));
    });
  }

  /**
   * Names chosen on the pairing screen, before anything is downloaded.
   *
   * Held on the panel rather than in the config, because there is no config
   * yet: this is the answer to "what should this device sync" asked at the one
   * moment it can still prevent a download rather than undo one.
   */
  private joinSkip: string[] = [];
  /** Whether `joinSkip` has been filled from a refused pairing's own list. */
  private joinSkipSeeded = false;

  /**
   * The skip list, on the pairing screen.
   *
   * A field and a row per chosen name, the same shape `renderIgnored` has for
   * a paired vault, so the control somebody meets at setup is the control they
   * meet again in the settings.
   */
  private renderJoinSkip(contentEl: HTMLElement): void {
    const setting = row(
      contentEl,
      "Skip on this device",
      this.joinSkip.length === 0
        ? "Optional. A folder or file name this device should never sync, such as a large attachments folder."
        : `Not synced here: ${this.joinSkip.join(", ")}. Other devices keep syncing them.`,
    );
    let field: TextComponent | undefined;
    setting.addText((t) => {
      t.setPlaceholder("Attachments");
      t.inputEl.setAttribute("aria-label", "A folder or file name to skip on this device");
      field = t;
    });
    setting.addButton((b) =>
      b.setButtonText("Skip").onClick(() => {
        const wanted = (field?.getValue() ?? "").trim();
        if (!isIgnorableName(wanted)) {
          new Notice("TrewSync: give one folder or file name, with no slashes in it.");
          return;
        }
        if (!this.joinSkip.includes(wanted)) this.joinSkip.push(wanted);
        this.render();
      }),
    );
    for (const name of this.joinSkip) {
      row(contentEl, name, "Will not be synced to this device.").addButton((b) =>
        b.setButtonText("Sync it").onClick(() => {
          this.joinSkip = this.joinSkip.filter((other) => other !== name);
          this.render();
        }),
      );
    }
  }

  private joinDraft: { invite: string; device: string } | undefined;
  private confirmMerge = false;

  /** Confirmation is a panel step; it never leaves a pairing request waiting. */
  private async pairFromPanel(
    invite: string,
    device: string,
    ignore: readonly string[] = this.joinSkip,
    mergeConfirmed = false,
  ): Promise<void> {
    if (this.closed) return;
    this.joinDraft = { invite, device };
    try {
      await this.plugin.pair(invite, device, mergeConfirmed, ignore);
      // Spent: the next form this panel draws starts empty.
      this.forgetInvite();
      this.confirmMerge = false;
      new Notice("Paired. TrewSync is connecting.");
      this.render();
    } catch (err) {
      if (this.closed) return;
      if (err instanceof MergeConfirmationRequired) {
        this.confirmMerge = true;
        this.render();
      } else {
        new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
        // Redrawn, so the reason stays on the panel after the notice has
        // gone, and a pairing kept to finish is drawn as the state it is in.
        this.confirmMerge = false;
        this.render();
      }
    }
  }
}

/**
 * The panel as a modal, which is what the ribbon, the status bar and the
 * command palette open.
 */
class TrewModal extends Modal {
  private panel: TrewPanel | undefined;

  constructor(
    private readonly plugin: TrewPlugin,
    private readonly incomingInvite?: string,
  ) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.setTitle("TrewSync");
    this.modalEl.addClass("mod-trew-panel");
    this.panel = new TrewPanel(
      this.plugin,
      this.contentEl,
      () => this.close(),
      this.incomingInvite,
    );
    this.panel.render();
  }

  override onClose(): void {
    this.panel?.teardown();
    this.panel = undefined;
  }
}

/**
 * The same panel, under Settings.
 *
 * This file used to say a settings tab was refused because there are no
 * options to put in one, and that is still true: nothing below is a
 * preference. What it got wrong is what the tab is for. Obsidian shows a
 * plugin's gear in Settings only if it registers one, so refusing the tab
 * meant Settings had no TrewSync entry at all, and somebody looking for the
 * plugin's interface in the one place every other plugin keeps it found
 * nothing and concluded there was none. That is a discoverability bug
 * wearing a principle's clothes.
 *
 * So: the same panel, drawn into the tab, with no options added to earn the
 * place. `display` and `hide` are called every time the tab is opened and
 * left, which is exactly the render and teardown the modal already does.
 */
class TrewSettingTab extends PluginSettingTab {
  private panel: TrewPanel | undefined;

  constructor(private readonly plugin: TrewPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    // Nothing to close: leaving the tab is the person's own business, and a
    // panel that closed Settings out from under them would be a surprise.
    this.panel?.teardown();
    this.panel = new TrewPanel(this.plugin, this.containerEl, () => {});
    this.panel.render();
  }

  override hide(): void {
    this.panel?.teardown();
    this.panel = undefined;
  }
}

/**
 * What the server still has and this vault does not.
 *
 * The only interface to the safety net. Deliberately a list of notes and a
 * button each, with no options: recovery is something somebody reaches for once
 * in a bad afternoon, and it should not be a thing to learn.
 */
class RecoverModal extends Modal {
  private closed = false;
  private rendering: Promise<void> | undefined;
  private readonly restoring = new Set<number>();
  /**
   * Which deletions are picked out for a bulk restore, by uid.
   *
   * A button per row rather than a checkbox, because the stub and Obsidian
   * both give a button a phone-sized tap target and neither gives a checkbox
   * one. Recovering a deleted folder was one press and one whole-vault sync
   * per note (Codex-11).
   */
  private readonly picked = new Set<number>();
  /**
   * Every deletion fetched so far, newest first.
   *
   * Kept rather than replaced, because the filter below has to have something
   * to filter. "Show older" used to swap one page of fifty for the next, so a
   * person looking for one name among three hundred deletions read fifty
   * names, pressed a button, and lost the fifty they had just read (R083-17).
   */
  private readonly loaded: Deletion[] = [];
  /** Whether the server said there are older deletions than the ones held. */
  private more = false;
  /** The oldest uid held, which is what asks for the page before it. */
  private oldest: number | undefined;
  private query = "";
  private failure: string | undefined;

  constructor(private readonly plugin: TrewPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.setTitle("Deleted notes");
    this.modalEl.addClass("mod-trew-panel");
    this.contentEl.addClass("trew-panel");
    void this.render();
  }

  override onClose(): void {
    this.closed = true;
    this.listEl = undefined;
    this.contentEl.empty();
  }

  /** Fetches the next page, then redraws. Never two fetches at once. */
  private render(before?: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.rendering) return this.rendering;
    this.rendering = this.fetchPage(before).finally(() => {
      this.rendering = undefined;
    });
    return this.rendering;
  }

  private async fetchPage(before: number | undefined): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { cls: "trew-advice", text: "Loading deleted notes…" });

    let deleted: DeletedList;
    try {
      deleted = await this.plugin.deletedNotes(PAGE_SIZE, before);
    } catch (err) {
      if (this.closed) return;
      // Not an empty list. "There is nothing to recover" and "I could not
      // ask" are different answers and this is the worst place to confuse
      // them.
      this.failure = `Cannot ask the server: ${(err as Error).message}`;
      this.draw();
      return;
    }
    if (this.closed) return;

    this.failure = undefined;
    const held = new Set(this.loaded.map((note) => note.uid));
    for (const note of deleted.notes) if (!held.has(note.uid)) this.loaded.push(note);
    this.loaded.sort((a, b) => b.uid - a.uid);
    this.more = deleted.more;
    // Only from a page that had something in it: an empty answer names no uid
    // to page from, and taking `undefined` here would ask for the newest page
    // again on the next press.
    if (deleted.oldest !== undefined) {
      this.oldest =
        this.oldest === undefined ? deleted.oldest : Math.min(this.oldest, deleted.oldest);
    }
    this.draw();
  }

  private draw(): void {
    if (this.closed) return;
    const { contentEl } = this;
    contentEl.empty();
    this.listEl = undefined;

    if (this.failure !== undefined) {
      contentEl.createEl("p", { cls: "trew-advice", text: this.failure });
      new Setting(contentEl).addButton((button) =>
        button.setButtonText("Try again").onClick(() => this.render(this.oldest)),
      );
      if (this.loaded.length === 0) return;
    }

    if (this.loaded.length === 0) {
      contentEl.createEl("p", { cls: "trew-advice", text: "No deleted notes to restore." });
      return;
    }

    // The same control the activity log has, for the same reason: the useful
    // question is "which one was called something like this", and the answer
    // was a page at a time of unfiltered names.
    new Setting(contentEl).setName("Deleted notes").addSearch((input) => {
      input.inputEl.setAttribute("aria-label", "Find a deleted note by filename");
      input
        .setPlaceholder("Find a file…")
        .setValue(this.query)
        .onChange((value) => {
          this.query = value;
          this.list();
        });
    });

    // The filter redraws this and only this, so the field it is typed into
    // survives the keystroke and keeps the caret.
    this.listEl = contentEl.createDiv("trew-deleted-list");
    this.list();
  }

  private listEl: HTMLElement | undefined;
  /** Whether a bulk restore is running, so a second press cannot start one. */
  private bulk = false;

  private list(): void {
    const listEl = this.listEl;
    if (this.closed || listEl === undefined) return;
    listEl.empty();

    const needle = this.query.trim().toLocaleLowerCase();
    const shown = needle
      ? this.loaded.filter((note) => note.path.toLocaleLowerCase().includes(needle))
      : this.loaded;

    listEl.createEl("p", {
      cls: "trew-advice",
      text: describeDeleted({ notes: shown, more: this.more && !needle }),
    });

    if (this.more && this.oldest !== undefined) {
      // A page, not a bigger ask (F21). This doubled the limit it requested,
      // which stops working at the server's cap: at a thousand deletions the
      // button fetched the same capped page for ever and said nothing. The
      // cursor is the oldest uid held, so the next one starts below it however
      // many there are.
      const next = this.oldest;
      row(
        listEl,
        "Show older",
        needle
          ? "Only the deletions already loaded are searched. Show older loads more of them."
          : "The server has more deletions than are listed here.",
      ).addButton((b) => b.setButtonText("Show older").onClick(() => this.render(next)));
    }

    if (shown.length === 0) {
      listEl.createEl("p", {
        cls: "trew-advice",
        text: needle ? "No deleted note matches that." : "No deleted notes to restore.",
      });
      return;
    }

    const restorable = shown.filter((note) => note.restorable > 0);
    const chosen = restorable.filter((note) => this.picked.has(note.uid));
    if (restorable.length > 1) {
      const pick = row(
        listEl,
        chosen.length === 0
          ? "Restore several at once"
          : `${chosen.length} chosen of ${restorable.length}`,
        chosen.length === 0
          ? "Choose notes below, then restore them together in one sync."
          : "Restored together, into names nothing already occupies.",
      );
      pick.addButton((b) =>
        b
          .setButtonText(chosen.length === restorable.length ? "Choose none" : "Choose all shown")
          .onClick(() => {
            if (chosen.length === restorable.length) {
              for (const note of restorable) this.picked.delete(note.uid);
            } else {
              for (const note of restorable) this.picked.add(note.uid);
            }
            this.list();
          }),
      );
      if (chosen.length > 0) {
        pick.addButton((b) =>
          b
            .setButtonText(`Restore ${chosen.length}`)
            .setCta()
            .onClick(async () => {
              if (this.closed || this.bulk) return;
              this.bulk = true;
              b.setDisabled(true).setButtonText("Restoring…");
              try {
                const done = await this.plugin.recoverMany(chosen);
                const sent = done.filter((r) => r.sent).length;
                const kept = done.filter((r) => !r.sent && r.willRetry !== false).length;
                const lost = done.filter((r) => r.willRetry === false);
                // All three counts, always. "Restored 40" without "and 2
                // could not be" is the comfortable half of the story.
                const parts = [`Restored ${sent + kept} of ${chosen.length}.`];
                if (kept > 0) parts.push(`${kept} not yet sent to your other devices.`);
                if (lost.length > 0) {
                  parts.push(`${lost.length} could not be restored: ${lost[0]!.why}`);
                }
                new Notice(`TrewSync: ${parts.join(" ")}`, 15_000);
                for (const note of chosen) {
                  if (lost.some((r) => r.path === note.path)) continue;
                  this.picked.delete(note.uid);
                  const at = this.loaded.findIndex((held) => held.uid === note.uid);
                  if (at >= 0) this.loaded.splice(at, 1);
                }
                this.list();
              } catch (err) {
                new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
              } finally {
                this.bulk = false;
              }
            }),
        );
      }
    }

    for (const version of shown) {
      const deletedAt = when(version.mtime);
      if (version.restorable === 0) {
        // Purge can retain a deletion after its recoverable content is gone.
        // Follow the server's restorable count, since some history survives
        // purge as evidence of moves or deletions.
        new Setting(listEl)
          .setName(version.path)
          .setDesc(
            `Deleted ${deletedAt}. Its history has been purged, so there is nothing to restore.`,
          );
        continue;
      }
      const setting = new Setting(listEl)
        .setName(version.path)
        .setDesc(`Deleted ${deletedAt} on ${version.device}`);
      if (restorable.length > 1) {
        setting.addButton((b) =>
          b.setButtonText(this.picked.has(version.uid) ? "Chosen" : "Choose").onClick(() => {
            if (!this.picked.delete(version.uid)) this.picked.add(version.uid);
            this.list();
          }),
        );
      }
      setting.addButton((b) =>
        b
          .setButtonText("Restore")
          .setCta()
          .onClick(async () => {
            if (this.closed || this.restoring.has(version.uid)) return;
            this.restoring.add(version.uid);
            b.setDisabled(true).setButtonText("Restoring…");
            try {
              const done = await this.plugin.recover(version);
              new Notice(describeRestore(version, done), done.sent ? undefined : 10_000);
              // Restored, so it is no longer a deletion to offer. Dropped
              // here rather than by refetching, which would throw away every
              // older page that had been loaded.
              const at = this.loaded.findIndex((note) => note.uid === version.uid);
              if (at >= 0) this.loaded.splice(at, 1);
              this.list();
            } catch (err) {
              new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
            } finally {
              this.restoring.delete(version.uid);
              b.setDisabled(false).setButtonText("Restore");
            }
          }),
      );
    }
  }
}

/**
 * The versions this device parked where Obsidian cannot see them.
 *
 * A preserving write moves whatever is at a name aside before writing over it,
 * and where it cannot place the displaced bytes beside the note it parks them
 * under a hidden name and writes a record. That record was the end of the
 * story: the panel could say it had happened and nothing could act on it.
 *
 * Deliberately one button per row and nothing else. Somebody opening this has
 * already lost something once.
 */
/**
 * Turning settings sync on: what it does, and whose settings win the first
 * time, which is the one decision it needs (plan/settings-sync.md, section 4).
 */
class SettingsSyncModal extends Modal {
  constructor(private readonly plugin: TrewPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    const root = this.plugin.settingsRoot ?? this.plugin.app.vault.configDir;
    this.setTitle("Sync settings");
    this.modalEl.addClass("mod-trew-panel");
    const { contentEl } = this;
    contentEl.addClass("trew-panel");
    contentEl.createEl("p", {
      text:
        `Obsidian's settings, themes and CSS snippets in ${root} will sync with every device whose ` +
        `settings folder is also ${root}. Plugins do not sync yet.`,
    });
    contentEl.createEl("p", {
      text: "When another device changes a setting, this one waits for you to apply it, which reloads Obsidian.",
    });
    contentEl.createEl("p", {
      text:
        "If the server already has settings for this folder from another device, which should this device " +
        "use the first time? A copy of this device's settings as they are now is kept either way.",
    });
    const choices = new Setting(contentEl);
    choices.addButton((b) =>
      b
        .setButtonText("Use the server's")
        .setCta()
        .onClick(() => void this.choose("server")),
    );
    choices.addButton((b) => b.setButtonText("Keep this device's").onClick(() => void this.choose("device")));
  }

  private async choose(choice: "server" | "device"): Promise<void> {
    try {
      const backup = await this.plugin.setSettingsSync(true, choice);
      new Notice(
        `TrewSync: settings sync is on.${backup ? ` This device's settings as they were are kept in ${backup}.` : ""}`,
        10_000,
      );
      this.close();
    } catch (err) {
      new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * A settings profile of this device's own, made from the one it runs, and
 * then the one step only a person can take: pointing Obsidian at it.
 */
class ProfileModal extends Modal {
  constructor(private readonly plugin: TrewPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.setTitle("Create a settings profile");
    this.modalEl.addClass("mod-trew-panel");
    const { contentEl } = this;
    contentEl.addClass("trew-panel");
    contentEl.createEl("p", {
      text:
        "A profile is a settings folder of its own. Devices that use the same profile share settings when " +
        "settings sync is on; a phone usually gets one apart from the desktops. The new profile starts as a " +
        "copy of this device's settings and plugins.",
    });
    let name = Platform.isMobile ? "mobile" : "desktop";
    new Setting(contentEl)
      .setName("Name")
      .setDesc("Use lower case letters, digits and dashes.")
      .addText((t) => {
        t.setValue(name).onChange((value) => {
          name = value.trim();
        });
        t.inputEl.setAttribute("aria-label", "Profile name");
      });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Create")
        .setCta()
        .onClick(async () => {
          b.setDisabled(true).setButtonText("Copying");
          try {
            const folder = await this.plugin.createSettingsProfile(name);
            contentEl.empty();
            contentEl.createEl("p", {
              text:
                `Created ${folder}. Now open Settings, Files and links, Override config folder, enter ${folder} ` +
                "and tap Relaunch. TrewSync is paused until Obsidian runs it.",
            });
          } catch (err) {
            new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
            b.setDisabled(false).setButtonText("Create");
          }
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Obsidian's own "Reload app without saving", which is all it does
 * (plan/settings-sync.md, spike results). Behind typeof, like every browser
 * global here, because the tests run without one.
 */
function reloadObsidian(): void {
  if (typeof window !== "undefined") window.location.reload();
}

class StrandedModal extends Modal {
  private closed = false;
  private readonly working = new Set<string>();

  constructor(private readonly plugin: TrewPlugin) {
    super(plugin.app);
  }

  private inventory: Inventory | undefined;

  override onOpen(): void {
    this.setTitle("Versions kept out of sight");
    this.modalEl.addClass("mod-trew-panel");
    this.contentEl.addClass("trew-panel");
    this.contentEl.createEl("p", { cls: "trew-advice", text: "Looking…" });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.inventory = await this.plugin.displacedVersions();
    } catch (err) {
      // Rule 2 again, one level up: "I could not look" is not "there is
      // nothing there", and this is the worst screen to confuse them on.
      this.inventory = { waiting: [], complete: false, why: (err as Error).message };
    }
    this.draw();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private draw(): void {
    if (this.closed) return;
    const { contentEl } = this;
    contentEl.empty();
    const inventory = this.inventory;
    if (inventory === undefined) return;

    if (!inventory.complete) {
      // Never folded into the list. An incomplete inventory reads exactly like
      // an empty one, and the difference is whether anything is missing.
      contentEl.createEl("p", {
        cls: "trew-advice",
        text: `This list may be incomplete: ${inventory.why}`,
      });
    }
    if (inventory.waiting.length === 0) {
      contentEl.createEl("p", {
        cls: "trew-advice",
        text: inventory.complete
          ? "Nothing is waiting. Every version this device took off a name was put back."
          : "Nothing is listed, and the record above says why that may not mean nothing is there.",
      });
      return;
    }

    contentEl.createEl("p", {
      cls: "trew-advice",
      text:
        "These are versions TrewSync took off a name and could not put back beside it. " +
        "Recovering one writes a visible copy next to the note it came from. The hidden " +
        "copy is left where it is.",
    });

    for (const version of inventory.waiting) {
      new Setting(contentEl)
        .setName(version.from)
        .setDesc(`Kept ${when(version.when)} at ${version.at}. ${version.why}`)
        .addButton((b) =>
          b
            .setButtonText("Recover a visible copy")
            .setCta()
            .onClick(async () => {
              if (this.closed || this.working.has(version.at)) return;
              this.working.add(version.at);
              b.setDisabled(true).setButtonText("Recovering…");
              try {
                const at = await this.plugin.recoverDisplaced(version);
                new Notice(
                  `TrewSync: recovered to ${at}. The hidden copy is still at ${version.at}.`,
                  15_000,
                );
                await this.load();
              } catch (err) {
                new Notice(`TrewSync: ${(err as Error).message}`, 10_000);
                b.setDisabled(false).setButtonText("Recover a visible copy");
              } finally {
                this.working.delete(version.at);
              }
            }),
        );
    }
  }
}

/**
 * What to tell somebody whose handshake never completes, and nothing otherwise.
 *
 * The server refuses a browser origin it does not know, and the only thing
 * that knows this device's origin is this device. The desktop one is in the
 * built-in list; the mobile ones are Capacitor's documented defaults and have
 * never been checked against a device, so a phone that has never got through
 * should be able to say what to add rather than leaving somebody to guess. A
 * connection that was up and went is not that: the origin was fine, the
 * network is not.
 */
function originAdvice(state: State): string {
  if (state.kind !== "offline" || !state.refused) return "";
  const from = origin();
  return (
    `If it never connects, this device's origin is ${from}. ` +
    `A server that does not know it refuses the connection, and logs the same thing. ` +
    `Restart it with -allow-origin ${from}`
  );
}

/**
 * This device's browser origin, which is what a server checks a plugin against.
 *
 * `app://obsidian.md` on desktop, and something Capacitor chooses on a phone.
 * Read rather than assumed, because the assumption is the thing that might be
 * wrong.
 */
function origin(): string {
  return (typeof location === "undefined" ? undefined : location.origin) ?? "unknown";
}

/**
 * The time of day, without seconds. A status line is read at a glance and
 * "1:00:37 PM" is not read any differently from "1:00 PM"; the history modal
 * has always printed it this way.
 */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * What this device syncs with: the address, the protocol and the build.
 *
 * @see TrewPlugin.connection
 */
export interface Connection {
  /** Where this device pairs to, from the saved config. */
  readonly url: string;
  /** What the server said at hello. Absent until there has been one. */
  readonly server?: { readonly proto: number; readonly version: string } | undefined;
}

/**
 * One line for what the panel is talking to.
 *
 * Four facts and no more, because each is one somebody is missing when sync is
 * not working and none of them costs a request: the address this device
 * actually holds, whether that hop has TLS in front of it, the protocol the
 * two ends settled on, and the build on the other end. The last two come from
 * `ready` and are absent until there has been one, and the line says so rather
 * than leaving a gap: a build that is missing because nothing is connected
 * reads exactly like a server that did not say, and they are different states
 * (rule 2, at the width of a sentence).
 *
 * The scheme is the whole of what is known about the hop, and it is a complete
 * test because `normaliseUrl` stores one of exactly two. `wss://` means
 * something in front of the server terminated TLS, which is the arrangement
 * server.md describes, and `ws://` means nothing did. The second is a warning
 * with nothing to soften it: the notes travel in plaintext between devices and
 * the server, so on that hop they are as exposed as the device credential.
 * `connectionDetail` says so in one line; which network can see it is in
 * docs/plugin.md.
 */
export function describeConnection(at: Connection): string {
  return at.server === undefined
    ? `Not connected to ${at.url}.`
    : `Connected to ${at.url}. Protocol ${at.server.proto}, trewd ${at.server.version}.`;
}

/**
 * Whether the connection is protected, in one line.
 *
 * Shown in the connection details, which is somewhere somebody has gone
 * looking for a fact rather than for an explanation, in a panel whose last row
 * is a link to the guide.
 *
 * `panel-shots.test.ts` guards this line as one of the things "paid for in
 * incidents". What it says is the opposite of what Basalt's said: Basalt could
 * tell somebody on a plain hop that their notes were still sealed and only the
 * credential was exposed. TrewSync has no end-to-end encryption, so a hop without
 * TLS exposes the notes themselves as well as the device credential, and a
 * line that named only the credential would understate it.
 *
 * Nothing at all when the hop is protected: explaining TLS to somebody who
 * already has it is a lecture with a happier ending.
 */
export function connectionDetail(at: Connection): string {
  return at.url.startsWith("wss://")
    ? ""
    : "No TLS on this hop: your notes and the device credential both cross it in the clear.";
}

/** A fragment placed where a sentence starts. A leading digit is left alone. */
function opens(fragment: string): string {
  return fragment.charAt(0).toUpperCase() + fragment.slice(1);
}

function longStatus(state: State): string {
  switch (state.kind) {
    case "paused":
      return "Sync is paused on this device until you resume it or restart Obsidian.";
    case "unpaired":
      return "Not paired.";
    case "pairing":
      return state.retryAt === undefined
        ? "Finishing the pairing with the server."
        : // Without its own full stop, which the reason for a lost reply ends with.
          `Finishing the pairing: ${(state.why ?? "the last attempt did not finish").replace(/\.$/, "")}. ` +
            `Trying again at ${clock(state.retryAt)}.`;
    case "connecting":
      return "Connecting.";
    case "loading": {
      const percent =
        state.server > 0 ? Math.min(100, Math.floor((100 * state.local) / state.server)) : 100;
      return `Loading sync history… ${percent}%. Keep Obsidian open.`;
    }
    case "syncing":
      if (state.transfer) return describeTransfer(state.transfer);
      return state.path === undefined ? "Syncing notes." : `Working on ${state.path}.`;
    case "review":
      // "Review your first sync" and "Review folder deletions" both read as
      // the thing being waited for once lowercased.
      return (
        `Waiting for you to ${state.heading.charAt(0).toLowerCase()}${state.heading.slice(1)}. ` +
        "Nothing syncs until you choose Continue sync or Pause sync."
      );
    case "synced": {
      // `summarise` returns a fragment because three of its four callers put
      // it after a colon. This is the fourth, and it opens a sentence: the
      // tooltip, and the panel's first line above two proper ones.
      const done = opens(state.summary);
      const parts = [`${done}, as of ${clock(state.at)}.`];
      if (state.refused > 0) {
        parts.push(
          `${state.refused} ${state.refused === 1 ? "file needs" : "files need"} attention.`,
        );
      }
      // Its own sentence, because it is its own problem: these are notes that
      // exist only under a name Obsidian does not show, and folding them into
      // the attention count would hide the one thing a person has to go and
      // rescue by hand.
      if (state.waiting > 0) {
        parts.push(
          `${state.waiting} ${state.waiting === 1 ? "version was" : "versions were"} kept ` +
            `somewhere Obsidian does not show.`,
        );
      }
      // Last, and unconditional on the count, because it is the sentence that
      // says the count may be wrong.
      if (state.recoveryUnknown !== undefined) {
        parts.push(`TrewSync cannot tell what is waiting: ${state.recoveryUnknown}.`);
      }
      return parts.join(" ");
    }
    case "failed":
      return `Last sync failed at ${clock(state.at)}: ${state.why}. It will try again.`;
    case "offline":
      return `Offline: ${state.why}. Trying again shortly.`;
    case "stopped":
      return state.recovery === "rejoin"
        ? `Stopped: ${state.why} ${REJOIN_ADVICE}`
        : `Stopped: ${state.why}. This will not fix itself by waiting.`;
  }
}
