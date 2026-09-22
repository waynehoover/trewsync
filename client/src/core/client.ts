import type { SyncPreview } from "./preview.ts";
import {
  reviewConflict,
  resolveConflict,
  type ConflictPair,
  type ConflictReview,
  type ConflictChoice,
} from "./conflicts.ts";
import type { Activity } from "./activity.ts";
/**
 * A connected client, which is everything both shells have in common.
 *
 * The plugin and the headless CLI each assemble a vault, an index store, a
 * transport and an engine, wait for the backlog, sync until settled, and
 * reconnect when the connection goes. That is not shell-specific work, and the
 * two shells doing it separately is two chances to get the reconnect wrong in
 * one of them.
 *
 * So it is here, and a shell is left with what a shell should be: reading
 * arguments or drawing a status bar, and nothing that decides anything.
 *
 * The transport deliberately does not reconnect itself, because a client that
 * exits wants to fail where a client that stays wants to wait. Both kinds are
 * below: `Client` is one connection, and `runForever` is the loop.
 */

import type { TransferActivity } from "./transfer.ts";
import {
  Engine,
  checkEntryShape,
  combinePasses,
  contentId,
  mustBeOurs,
  placeBeside,
  type RepairReport,
  type SyncOptions,
  type SyncReport,
} from "./engine.ts";
import {
  Backoff,
  ConnectionError,
  ProtocolError,
  Transport,
  type DeviceRow,
  type InviteRow,
  type RegistrarLimits,
  type ServerLimits,
  type SocketLike,
  type WireEntry,
} from "./transport.ts";
import { MemoryIndexStore, type FileStat, type IndexStore, type Vault } from "./vault.ts";
import { validateStoredState } from "./stored-state.ts";
import {
  authToken,
  base64urlEncode,
  deriveRootKeys,
  deviceAuthToken,
  generateDataKey,
  generateDeviceSecret,
  openPath,
  randomBytes,
  sealPath,
  sealSecret,
  unsealSecret,
  unwrapDataKey,
  wrapDataKey,
  type RootKeys,
  type Schedule,
} from "./crypto.ts";
import {
  generateInviteId,
  INVITE_KEY_LENGTH,
  deviceCredential,
  formatInvite,
  generateDeviceId,
  type DeviceConfig,
  type Invite,
} from "./pairing.ts";
import { firstFreeName, splitName } from "./paths.ts";

export interface ClientOptions {
  readonly vault: Vault;
  readonly store: IndexStore;
  /** The vault's data key, which every content key derives from. See EngineOptions. */
  readonly dataKey: Uint8Array;
  /** WebSocket URL of the server. */
  readonly url: string;
  /** This device's row in the vault's device list. */
  readonly deviceId: string;
  /** This device's own auth key, derived from its own secret. */
  readonly token: string;
  readonly vaultId: string;
  readonly device: string;
  readonly timeoutMs?: number;
  /** Whether to hold back a file written moments ago. See EngineOptions. */
  readonly coalesceWrites?: boolean;
  /**
   * Ask each pass to report where it spent its time (`SyncReport.phases`).
   *
   * Off everywhere that ships. See `EngineOptions.timing` and
   * docs/open-work.md for the question the numbers exist to settle.
   */
  readonly timing?: boolean;
  /** Whether two edits to one note may be merged. Default true (I30). */
  readonly merge?: boolean;
  /** Whether this device may send anything to the server. Default false (I29). */
  readonly readOnly?: boolean;
  readonly log?: (message: string, ...rest: unknown[]) => void;
  readonly onActivity?: (activity: Activity) => void;
  readonly confirmFirstSync?: (preview: SyncPreview) => Promise<boolean>;
  readonly confirmDeletions?: (preview: SyncPreview) => Promise<boolean>;
  readonly activePath?: () => string | undefined;
  /** The path being worked on, and undefined when a pass ends. */
  readonly onProgress?: (path: string | undefined) => void;
  readonly onTransfer?: (activity: TransferActivity | undefined) => void;
  /** Authenticated history loading, before connect() permits syncing. Cursors are not file counts. */
  readonly onCatchUp?: (at: { local: number; server: number }) => void;
  /**
   * Called with the report of every pass, whatever started it.
   *
   * A pass can start from the ticker, from a batch arriving, from the
   * watcher, from a shell asking, or from `settle`, and a shell that wants
   * to say what the vault looks like had to hook each of those separately
   * and missed some. One place, every pass. A pass that threw reports
   * nothing here; the error goes to whoever asked for it.
   */
  readonly onPass?: (report: SyncReport) => void;
  /** The serial pass is starting, including its initial filesystem scan. */
  readonly onSyncStart?: () => void;
  /**
   * A pass that failed outright, rather than a file within one (F16).
   *
   * `sync` swallows exceptions on purpose, because most of its callers are
   * event handlers with nothing useful to do with one: a ticker, an arriving
   * batch, a file the host says was saved. What it used to do with the
   * exception was log it if a logger happened to be configured, and nothing
   * else, so a device that connected and then failed every pass showed the
   * status of the last pass that worked. Silence there is the status rule in
   * docs/design.md read backwards.
   *
   * A whole pass, not a path: `onPass` already carries the paths that are
   * retrying or written off, and this is for the case where there is no
   * report at all.
   */
  readonly onSyncFailed?: (err: Error) => void;
  /** Injectable for tests, and for a platform whose WebSocket is not global. */
  /**
   * Connect to read, and never to write (F08).
   *
   * `history`, `deleted`, `devices` and `status` ask the server a question and
   * print the answer. They construct this client, and this client used to
   * schedule a sync the moment a batch arrived, so a command that was only
   * meant to look downloaded notes and saved an index behind whatever else was
   * running: those commands do not take the vault lock, precisely because
   * looking is not writing, and that stopped being true here.
   *
   * With this set nothing schedules a pass and `sync` refuses, so the only way
   * to write is for a caller to have said so with a command that locks the
   * vault. Batches are still accepted, because the answers to those questions
   * come off the same connection and a client that ignored them would report a
   * stale cursor.
   */
  readonly inspect?: boolean;
  readonly socketFactory?: (url: string) => SocketLike;
}

/**
 * How long to wait after a batch arrives before fetching what it named.
 *
 * Yield one event-loop turn so events delivered together share a pass, with
 * no fixed latency window on either end of a saved edit.
 */
export const SYNC_EVENT_DELAY_MS = 0;

export interface LocalMutationContext {
  readonly vault: Vault;
  changed(path: string): void;
}

export interface LocalMutationControl {
  readonly signal?: AbortSignal;
  readonly waitMs?: number;
}

export class LocalMutationError extends Error {
  constructor(
    readonly code: "busy" | "cancelled" | "read_only" | "not_ready" | "stopping",
    message: string,
  ) {
    super(message);
  }
}

/** One connection, from hello to close. */
export class Client {
  readonly engine: Engine;
  readonly transport: Transport;
  private uploadTransport: Transport | undefined;
  private limits: ServerLimits | undefined;
  private soonTimer: ReturnType<typeof setTimeout> | undefined;
  private uploadTimer: ReturnType<typeof setTimeout> | undefined;
  private nextUploadAt: number | undefined;
  private reportedCursor: number | undefined;
  private confirmedPass = false;
  private watching = false;
  private caughtUp = false;
  /** When the last batch arrived, for the catch-up wait in `connect`. */
  private lastBatchAt = Date.now();
  private readonly backlogWaiters = new Set<() => void>();
  private endedWith: Error | undefined;
  private notifyEnded: ((cause: Error) => void) | undefined;

  /**
   * Where this client's files are.
   *
   * Exposed so a shell can ask the same vault the pass used what it is still
   * holding, rather than building a second one and scanning the disk again to
   * find out (R46, R50).
   */
  get vault(): ClientOptions["vault"] {
    return this.opts.vault;
  }

  constructor(private readonly opts: ClientOptions) {
    let engine!: Engine;
    this.transport = new Transport(opts.url, {
      onBatch: async (batch) => {
        this.lastBatchAt = Date.now();
        this.backlogChanged();
        await engine.acceptBatch(batch);
        this.reportCatchUp();
        // Accepting a batch records what the server has; it does not
        // fetch it. Without this the download waited for the next tick,
        // so a note written on one device took up to thirty seconds to
        // appear on another that was connected and idle the whole time.
        // Measured on a phone: 0.2 s, 9.2 s, 14.2 s, and one that had
        // not arrived after half a minute.
        //
        // An empty batch is this device's own write coming back, and
        // there is nothing to fetch for it.
        //
        // Not at all when this client is only here to look (F08). Nothing
        // below the engine distinguishes a pass somebody asked for from one an
        // arrival scheduled, so an inspection command that happened to be
        // connected while a note arrived wrote it to disk.
        if (batch.entries.length > 0 && opts.inspect !== true) this.soon();
      },
      onCaughtUp: () => {
        this.caughtUp = true;
        this.backlogChanged();
      },
      onClosed: (cause) => {
        this.uploadTransport?.close();
        this.endedWith = cause;
        this.backlogChanged();
        this.notifyEnded?.(cause);
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
    });
    engine = new Engine({
      vault: opts.vault,
      store: opts.store,
      dataKey: opts.dataKey,
      transport: this.transport,
      withUploadTransport: (work) => this.withUploadTransport(work),
      releaseUploadTransport: () => this.releaseUploadTransport(),
      device: opts.device,
      vaultId: opts.vaultId,
      deviceId: opts.deviceId,
      token: opts.token,
      ...(opts.coalesceWrites !== undefined ? { coalesceWrites: opts.coalesceWrites } : {}),
      ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
      ...(opts.merge !== undefined ? { merge: opts.merge } : {}),
      ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.confirmFirstSync ? { confirmFirstSync: opts.confirmFirstSync } : {}),
      ...(opts.confirmDeletions ? { confirmDeletions: opts.confirmDeletions } : {}),
      ...(opts.onActivity !== undefined ? { onActivity: opts.onActivity } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.onTransfer !== undefined ? { onTransfer: opts.onTransfer } : {}),
      ...(opts.activePath !== undefined ? { activePath: opts.activePath } : {}),
    });
    this.engine = engine;
  }

  /** One temporary wire per engine sync, with no independent index or file writer. */
  private async withUploadTransport<T>(work: (transport: Transport) => Promise<T>): Promise<T> {
    if (this.closing || this.transport.isClosed)
      throw new ConnectionError("this client has closed");
    if (this.uploadTransport && !this.uploadTransport.isClosed) {
      try {
        return await this.completeUpload(work, this.uploadTransport);
      } catch (err) {
        this.releaseUploadTransport();
        throw err;
      }
    }
    const transport = new Transport(this.opts.url, {
      // The main connection alone authenticates/applies metadata to the engine.
      // The auxiliary stream is checked for framing/continuity and discarded.
      onBatch: () => {},
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.socketFactory ? { socketFactory: this.opts.socketFactory } : {}),
    });
    this.uploadTransport = transport;
    try {
      await transport.connect();
      const cursor = this.engine.status().cursor;
      const limits = await transport.hello({
        vault: this.opts.vaultId,
        deviceId: this.opts.deviceId,
        token: this.opts.token,
        device: this.opts.device,
        cursor,
      });
      if (limits.cursor < cursor)
        throw new ProtocolError("cursor", "upload server is behind this device");
      for (const key of [
        "perFileMax",
        "chunkMax",
        "maxChunks",
        "maxBatchBytes",
        "maxFetchBytes",
      ] as const) {
        if (limits[key] !== this.limits?.[key])
          throw new Error("upload server limits changed; reconnect sync");
      }
      if (this.closing || this.transport.isClosed)
        throw new ConnectionError("this client has closed");
      return await this.completeUpload(work, transport);
    } catch (err) {
      this.releaseUploadTransport();
      throw err;
    }
  }

  private releaseUploadTransport(): void {
    this.uploadTransport?.close();
    this.uploadTransport = undefined;
  }

  private async completeUpload<T>(
    work: (transport: Transport) => Promise<T>,
    transport: Transport,
  ): Promise<T> {
    const result = await work(transport);
    // Broadcasts precede the auxiliary ACK. A later pong on the main wire
    // covers them too, including authenticated metadata still being decoded.
    // Without this barrier an older main frame could arrive after q.commit
    // and replace its newly acknowledged head with an older revision.
    await this.transport.ping();
    await this.transport.drainReceived();
    return result;
  }

  /**
   * One operation at a time on the wire.
   *
   * Not because replies could be confused with one another: every request
   * carries an id and the transport keeps a map of what is outstanding, so two
   * questions in flight resolve into their own slots. That was the original
   * reason, it no longer applies, and the queue is still needed.
   *
   * What it protects is the state either side of the wire. A pass reads the
   * vault, decides, writes and saves an index; a restore fetches a version
   * and writes it into the same vault; a rebase rewrites the cursor. Two of
   * those interleaving is two callers deciding from the same starting state
   * and one of them acting on a vault the other has already changed. Somebody
   * browsing deleted notes while the background sync ticks is exactly that,
   * and it is ordinary rather than rare.
   *
   * The granularity is one engine pass, not one settle, so a question does
   * not wait behind eight of them.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(work: () => Promise<T>): Promise<T> {
    // Runs on both paths: one caller's failure must not stop the next.
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private initiallySettled = false;
  private pendingMutations = 0;
  private readonly cancelMutations = new Set<() => void>();

  get writeReady(): boolean {
    return (
      this.initiallySettled &&
      this.limits !== undefined &&
      !this.closing &&
      !this.endedWith &&
      !this.transport.isClosed &&
      !this.opts.inspect &&
      !this.opts.readOnly
    );
  }

  /**
   * An agent's base must be checked after the pass ahead of it finishes. An
   * offline callback also races the old client's drain during reconnect, so
   * only a settled connection may admit work.
   */
  mutateLocal<T>(
    work: (context: LocalMutationContext) => Promise<T>,
    control: LocalMutationControl = {},
  ): Promise<T> {
    const waitMs = control.waitMs ?? 5000;
    if (
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 5000 ||
      this.pendingMutations >= 16
    ) {
      return Promise.reject(new LocalMutationError("busy", "the local mutation queue is full"));
    }
    this.pendingMutations++;
    const deadline = Date.now() + waitMs;
    const touched = new Set<string>();
    let started = false;
    let expired: LocalMutationError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let yes!: (value: T) => void;
    let no!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    const dispose = (): void => {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", cancelled);
      this.cancelMutations.delete(stopped);
    };
    const expire = (error: LocalMutationError): void => {
      if (started || expired) return;
      expired = error;
      dispose();
      no(error);
    };
    const cancelled = (): void =>
      expire(new LocalMutationError("cancelled", "cancelled before the local write started"));
    const stopped = (): void =>
      expire(new LocalMutationError("stopping", "the client is stopping"));
    this.cancelMutations.add(stopped);
    control.signal?.addEventListener("abort", cancelled, { once: true });
    if (control.signal?.aborted) cancelled();
    if (!expired)
      timer = setTimeout(
        () =>
          expire(
            new LocalMutationError(
              "busy",
              "the local write did not start before its queue deadline",
            ),
          ),
        waitMs,
      );

    const slot = this.serial(async () => {
      if (expired) throw expired;
      if (this.closing) throw new LocalMutationError("stopping", "the client is stopping");
      if (this.opts.inspect || this.opts.readOnly)
        throw new LocalMutationError("read_only", "this client does not permit local agent writes");
      if (!this.writeReady)
        throw new LocalMutationError(
          "not_ready",
          "wait for the initial sync and a live connection before editing",
        );
      if (control.signal?.aborted)
        throw new LocalMutationError("cancelled", "cancelled before the local write started");
      if (Date.now() >= deadline)
        throw new LocalMutationError(
          "busy",
          "the local write did not start before its queue deadline",
        );
      started = true;
      dispose();
      try {
        return await work({
          vault: this.opts.vault,
          changed: (path) => {
            touched.add(path);
          },
        });
      } finally {
        for (const path of touched) this.noteChanged(path);
      }
    });
    // Expiry answers promptly but keeps its admission until the skipped slot
    // drains. Otherwise a stalled upload can accumulate unlimited dead jobs.
    void slot.then(yes, no).finally(() => {
      dispose();
      this.pendingMutations--;
      if (touched.size > 0 && !this.closing && !this.endedWith && !this.transport.isClosed)
        void this.sync();
    });
    return result;
  }

  /**
   * The newest uid the server is known to hold: what `ready` announced at
   * hello, raised by every batch since, because a batch is the server
   * handing over a uid it holds. `caught-up` is no use for this, being sent
   * once per connection when the backlog drains.
   *
   * Not the hello number alone. The panel prints this beside the local
   * cursor so that a server withholding versions can be seen (I11), and on
   * a connection that stays up for days the hello number is frozen: a vault
   * paired when it was empty went on reporting a server holding nothing
   * however much it went on to hold.
   */
  get serverCursor(): number {
    return Math.max(this.limits?.cursor ?? 0, this.transport.appliedCursor);
  }

  /** False while local work is running, refused, or newer metadata is unapplied. */
  get deliveryReady(): boolean {
    return !this.closing && this.confirmedPass && this.reportedCursor === this.serverCursor;
  }

  /**
   * What the server said about itself at hello, or undefined before one.
   *
   * The caps in here are the engine's business and it takes them directly.
   * What a caller wants this for is the two facts nothing else carries: which
   * protocol this connection settled on, and which build is on the other end.
   * The panel shows both, because "up to date, cursor 66" says nothing about
   * what it is up to date with.
   */
  get serverLimits(): ServerLimits | undefined {
    return this.limits;
  }

  /** The keys in use, which are the data key's and are known from `ready` onwards. */
  get keys(): Schedule {
    return this.engine.vaultKeys;
  }

  /**
   * Connects, says hello, and waits for the backlog.
   *
   * The wait is not optional for anything that then syncs. A pass that runs
   * before catch-up finishes sees a vault the server already has files for,
   * decides they are local-only, and uploads the lot.
   *
   * `waitForBacklog: false` is for the two callers that ask a question and
   * close: `telimus status` and the cursor probe in `telimus rebase`. Both want
   * `ready.cursor`, which is the server's own number and is already here when
   * `start` returns, and a device weeks behind was paying minutes of unsealing
   * and MAC checking to print one line (R1). Closing straight after is what
   * makes it cheap on the other end too: the server stops streaming. Nothing
   * that syncs may pass it.
   */
  async connect(opts: { waitForBacklog?: boolean } = {}): Promise<ServerLimits> {
    await this.transport.connect();
    this.lastBatchAt = Date.now();
    this.limits = await this.engine.start();
    if (opts.waitForBacklog === false) return this.limits;
    this.reportCatchUp();

    // An inactivity bound, not a total one. A device that has been away for
    // a while has a long backlog, and over a slow link the whole of it can
    // take longer than the timeout while batches arrive steadily the entire
    // time. Bounding the total made that device reconnect into the same
    // backlog for ever; what a timeout is for is a server that has stopped
    // talking, and that is measured from the last thing it said.
    await this.waitForBacklog();
    return this.limits;
  }

  private backlogChanged(): void {
    for (const changed of this.backlogWaiters) changed();
  }

  /** Wake on a batch, catch-up, or disconnect; only inactivity needs a timer. */
  private waitForBacklog(): Promise<void> {
    const timeout = this.opts.timeoutMs ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        clearTimeout(timer);
        const remaining = timeout - (Date.now() - this.lastBatchAt);
        if (!this.caughtUp && !this.endedWith && remaining > 0) {
          timer = setTimeout(changed, remaining);
          return;
        }
        this.backlogWaiters.delete(changed);
        if (this.endedWith) reject(this.endedWith);
        else if (this.caughtUp) resolve();
        else reject(new Error("the server never finished sending what it already had"));
      };
      this.backlogWaiters.add(changed);
      changed();
    });
  }

  private reportCatchUp(): void {
    if (!this.limits || this.caughtUp || this.closing || this.transport.isClosed) return;
    this.opts.onCatchUp?.({ local: this.engine.status().cursor, server: this.serverCursor });
  }

  /**
   * Syncs until a pass finds nothing left to do, and reports the total.
   *
   * The passes are added together rather than the last one returned, because
   * the last pass is by construction the one that found nothing: returning it
   * would tell every successful sync that it had done no work. That was a real
   * bug, caught by the first end-to-end test that read the output.
   */
  async settle(opts: SyncOptions = {}, maxPasses = 8): Promise<SyncReport> {
    // Each pass queues separately, so a recovery question asked halfway
    // through waits for one pass rather than for all of them.
    let pass = await this.pass(opts);
    let total = pass;
    for (let i = 0; i < maxPasses && didSomething(pass); i++) {
      pass = await this.pass(opts);
      total = combinePasses(total, pass);
    }
    this.initiallySettled = true;
    return total;
  }

  private pass(opts: SyncOptions, onStart?: () => void): Promise<SyncReport> {
    return this.serial(async () => {
      // Inside the queue slot, so "this pass has begun" means the vault is
      // about to be read rather than that a promise exists. `sync` uses it to
      // stop handing this pass to callers whose news arrived after the read
      // (I05).
      onStart?.();
      // A closed client starts no pass. `close` drains the queue, and a
      // settle between two passes may not be in the queue: it could continue
      // after the drain, run a pass against the closed transport, and save
      // the index that unlink had just removed.
      if (this.closing) throw new ConnectionError("this client has been closed");
      this.confirmedPass = false;
      this.opts.onSyncStart?.();
      const report = await this.engine.sync(opts);
      if (report.appliedCursor !== undefined && report.appliedCursor !== this.reportedCursor) {
        await this.transport.applied(report.appliedCursor);
        this.reportedCursor = report.appliedCursor;
      }
      this.confirmedPass = report.appliedCursor !== undefined;
      this.nextUploadAt = report.nextUploadAt;
      this.scheduleUpload();
      this.opts.onPass?.(report);
      return report;
    });
  }

  /**
   * Waits for everything queued on the wire to finish, including work queued
   * while waiting.
   *
   * `runUntilClosed` used to resolve the moment the transport closed, while a
   * pass started by the ticker or the watcher could still be writing the
   * vault and the index. `runForever` then built a new client that loaded
   * the index the old engine was about to overwrite. Two engines on one
   * index is the state the single-flight rule exists to prevent.
   */
  private async drain(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (this.queue !== seen) {
      seen = this.queue;
      await seen;
    }
  }

  /**
   * Keeps syncing until the connection ends, and resolves with the reason.
   *
   * The watcher says when to look and the timer is the backstop for a platform
   * where watching does not work. A healthy filesystem watcher may refresh a
   * cached listing for ordinary edits. The periodic pass and explicit content
   * verification force a full scan; recovery inventory is always read afresh.
   */
  async runUntilClosed(tickMs = 30_000): Promise<Error> {
    if (this.endedWith) return this.endedWith;
    this.watching = true;
    this.scheduleUpload();
    const stop = this.opts.vault.watch?.((path) => {
      this.noteChanged(path);
      void this.sync();
    });
    // A sync with nothing to do sends nothing, so a settled vault is a
    // silent connection, and the server closes a silent one after five
    // minutes. Observed against a real server: a vault that had finished
    // syncing dropped its connection every five minutes for ever, each time
    // reconnecting and replaying the handshake to discover it was already up
    // to date. Nothing was lost and nothing said why.
    //
    // One frame every half minute is cheaper than that, and it is also how a
    // device finds out promptly that a connection has died under it.
    const ticker = setInterval(() => {
      void this.sync({ forceFullScan: true }).then(() => this.keepalive());
    }, tickMs);
    let cause: Error;
    try {
      cause = await new Promise<Error>((resolve) => {
        this.notifyEnded = resolve;
      });
    } finally {
      this.watching = false;
      this.clearUploadTimer();
      clearInterval(ticker);
      stop?.();
    }
    // Nothing else starts a pass now, and the one that may be running gets
    // to finish writing before this client is reported gone.
    await this.drain();
    return cause;
  }

  /**
   * Says something, so the connection is not idle.
   *
   * Failures are swallowed: a ping that cannot be sent means the connection
   * has already gone, which the run loop is about to be told by the read side.
   * Reporting it here would report it twice.
   */
  private async keepalive(): Promise<void> {
    try {
      await this.serial(() => this.transport.ping());
    } catch {
      /* the connection is gone; the loop around this will hear about it */
    }
  }

  /** Probe an idle connection without inserting a text frame into an upload. */
  probe(): Promise<void> {
    // Between `want` and its final body the server accepts only binary frames.
    // Use the same queue as sync and keepalive; the short timeout starts only
    // once the active exchange has finished.
    return this.serial(() => this.transport.probe());
  }

  /**
   * Syncs shortly, coalescing a run of arrivals into one pass.
   *
   * Catch-up is many batches in a row and a pass per batch would be a pass
   * per batch for nothing: they all want the same thing, which is one pass
   * once they have stopped coming. Short enough that it still reads as
   * immediate to somebody watching two devices.
   */
  private soon(): void {
    // Initial sync belongs to the caller after connect finishes. A partial
    // backlog cannot safely decide which files exist only on this device.
    if (!this.caughtUp || this.soonTimer !== undefined) return;
    this.soonTimer = setTimeout(() => {
      // Retain the scheduled marker until this snapshot finishes checking.
      // Per-entry crypto may still be working through frames already on the
      // socket; scanning between those entries repeats the same vault walk.
      void this.transport.drainReceived().then(
        () => {
          this.soonTimer = undefined;
          if (!this.closing) void this.sync();
        },
        () => {
          this.soonTimer = undefined;
        },
      );
    }, SYNC_EVENT_DELAY_MS);
  }

  private clearUploadTimer(): void {
    clearTimeout(this.uploadTimer);
    this.uploadTimer = undefined;
  }

  /** One deadline, re-evaluated by each pass; never a poll of the whole vault. */
  private scheduleUpload(): void {
    this.clearUploadTimer();
    if (
      !this.watching ||
      this.closing ||
      this.transport.isClosed ||
      this.nextUploadAt === undefined
    )
      return;
    this.uploadTimer = setTimeout(
      () => {
        this.uploadTimer = undefined;
        if (this.watching && !this.closing && !this.transport.isClosed) void this.sync();
      },
      Math.max(0, this.nextUploadAt - Date.now()),
    );
  }

  /**
   * A pass that is already going to happen, if one is (I05).
   *
   * The engine coalesces inside itself: a pass running when another is asked
   * for sets `again` and loops once more. What it cannot see is the queue
   * above it, where several triggers each wait their turn and then each run a
   * whole pass. A watcher, a ticker and an arriving batch inside one second is
   * ordinary, and it produced three passes over the same settled vault.
   *
   * So a pass that has not started yet is a pass the next trigger can join.
   * Not one that has started: it read the vault before whatever prompted this
   * caller happened, and returning it would report on a state older than the
   * question.
   */
  private queued: Promise<SyncReport | undefined> | undefined;

  /**
   * A sync whose failure does not become an unhandled rejection.
   *
   * Public because a shell with its own reason to sync needs it: the plugin
   * hears about a saved file from Obsidian rather than from a watcher.
   * Failures are logged rather than thrown, because the caller is an event
   * handler and there is nothing useful for it to do with an exception.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncReport | undefined> {
    // Refused rather than ignored. A caller that asks an inspection client to
    // sync has made a mistake about which client it is holding, and doing
    // nothing quietly would leave it reporting an empty pass as a real one.
    if (this.opts.inspect === true) {
      throw new Error(
        "this client is connected to read, not to sync: an inspection command cannot write to " +
          "the vault, because it does not hold the lock that makes writing safe",
      );
    }
    // Joined rather than queued behind, when one is already waiting to start
    // (I05). Options are compared as a whole: a caller that has turned the
    // write debounce off is asking a different question from one that has not
    // and must not be given the other's answer.
    const key = JSON.stringify(opts);
    if (this.queued !== undefined && this.queuedKey === key) return this.queued;

    const run = (async (): Promise<SyncReport | undefined> => {
      try {
        // Cleared the moment the pass begins rather than when it ends. From
        // then on it has read the vault, so a trigger arriving later would be
        // given an answer about a state older than its own news.
        return await this.pass(opts, () => {
          if (this.queued === run) {
            this.queued = undefined;
            this.queuedKey = undefined;
          }
        });
      } catch (err) {
        this.opts.log?.("sync failed", (err as Error).message);
        this.opts.onSyncFailed?.(err as Error);
        return undefined;
      }
    })();
    this.queued = run;
    this.queuedKey = key;
    return run;
  }

  private queuedKey: string | undefined;

  /**
   * Records a rename the host reported, once nothing else is touching the
   * index.
   *
   * `Engine.noteRename` rewrites entries synchronously, and a shell that
   * called it directly did so between the awaits of whatever pass was
   * running: the pass had an entry in hand for the old name, the rename
   * moved it, and the pass went on to upload under the old name while the
   * new one held a stale copy. Queued like a pass, it lands between them.
   */
  noteRename(from: string, to: string): Promise<void> {
    return this.serial(async () => this.engine.noteRename(from, to));
  }

  noteChanged(path: string): void {
    this.engine.noteChanged(path);
  }

  /* ------------------------------------------------------------ *
   * Recovery
   * ------------------------------------------------------------ */

  /**
   * Every version of one note, newest first.
   *
   * The path is sealed on the way out and the answer's paths are unsealed on
   * the way back, so the server takes no part in any of it beyond looking up
   * a key in a table.
   */
  async history(path: string, opts: { before?: number; limit?: number } = {}): Promise<Version[]> {
    const sealed = await sealPath(this.keys, path);
    const entries = await this.serial(() => this.transport.history(sealed, opts));
    await this.recoveryIsOurs(entries);
    this.recoveryIsAboutThisPath(entries, sealed, path, opts.before);
    // The names these versions were moved from, so a rename does not end a
    // note's history (Codex-06). Unsealed together rather than one at a time,
    // and only where there is one to unseal.
    const from = await Promise.all(
      entries.map((e) => (e.prev ? openPath(this.keys, e.prev) : undefined)),
    );
    return entries.map((e, i) => this.asVersion(e, path, from[i]));
  }

  /**
   * Refuses a history answer that is not about the note that was asked for
   * (F10).
   *
   * The signature check above says this vault's key wrote every entry. It
   * does not say they are entries of *this* note, and the answer was then
   * relabelled with the path the caller asked for: a valid signed entry for
   * `other.md` came back as a version of `requested.md`, and restoring it
   * wrote one note's contents over another's name. Nothing later catches
   * that. The chunk list matches its own entry perfectly, because it is a
   * real entry; it is simply somebody else's.
   *
   * Path sealing is deterministic, so the comparison is exact: one note has
   * one sealed name, and an entry that does not carry it is not a version of
   * it. Ordering and the `before` bound are checked here too, because a
   * caller paging backwards trusts both and neither was ever tested.
   */
  private recoveryIsAboutThisPath(
    entries: readonly WireEntry[],
    sealed: string,
    path: string,
    before: number | undefined,
  ): void {
    let last: number | undefined;
    for (const e of entries) {
      if (e.path !== sealed) {
        throw new Error(
          `the server answered a history request for ${path} with a version of some other ` +
            "note, and it is not shown",
        );
      }
      if (before !== undefined && e.uid >= before) {
        throw new Error(
          `the server answered a history request for versions of ${path} older than ${before} ` +
            `with version ${e.uid}, and it is not shown`,
        );
      }
      if (last !== undefined && e.uid >= last) {
        throw new Error(
          `the server answered a history request for ${path} with versions out of order ` +
            `(${e.uid} after ${last}), and it is not shown`,
        );
      }
      last = e.uid;
    }
  }

  /**
   * Refuses a recovery list holding an entry this vault's key did not sign.
   *
   * The same check the sync path runs on every batch entry, which for a while
   * recovery did not run at all; `mustBeOurs` in the engine holds the
   * reason. What is added here is the tail of the sentence: nothing forged is
   * acted on, and nothing forged is put in front of somebody either.
   *
   * Both of the sync path's checks, not one. A signature says who wrote an
   * entry and not that the entry makes sense, and the two are separate
   * failures: an entry declaring 500 bytes and naming no chunks is signed by
   * this vault's key and restores as an empty file, which is a note lost to a
   * recovery tool. `acceptBatch` has always refused that shape.
   */
  private async recoveryIsOurs(entries: readonly WireEntry[]): Promise<void> {
    await mustBeOurs(this.keys, entries, ", and it is not shown");
    for (const e of entries) checkEntryShape(e);
  }

  /**
   * Every note whose newest version is a deletion, newest first.
   *
   * This is the list somebody reads when they know a note is gone and cannot
   * remember what it was called, which is why the paths are unsealed here
   * rather than left for the caller.
   */
  /**
   * Sends the server bodies it has lost, writing no version (I14).
   *
   * What `telimus verify` finds and nothing could previously fix: a chunk the
   * disk rotted and the server quarantined, or one a restore left behind. Every
   * device that wants that version downloads for ever, and no ordinary pass
   * repairs it, because a device whose copy has not changed is correct to
   * consider it synced.
   *
   * Serialised with the passes, like every other request here, so a repair
   * cannot run inside a sync and offer bodies for an index the pass is halfway
   * through rewriting.
   */
  async repair(): Promise<RepairReport> {
    return this.serial(() => this.engine.repair());
  }

  async deleted(limit?: number, before?: number): Promise<DeletedList> {
    const answer = await this.serial(() => this.transport.deleted(limit, before));
    await this.recoveryIsOurs(answer.entries);
    const notes: Deletion[] = [];
    let last: number | undefined;
    for (const e of answer.entries) {
      // The same ordering check history makes, for the same reason: a caller
      // paging backwards trusts it, and a page that does not respect `before`
      // is a loop that never advances (F21, F10).
      if (before !== undefined && before > 0 && e.uid >= before) {
        throw new Error(
          `the server answered a request for deletions older than ${before} with version ` +
            `${e.uid}, and it is not shown`,
        );
      }
      if (last !== undefined && e.uid >= last) {
        throw new Error(
          `the server answered with deletions out of order (${e.uid} after ${last}), and they ` +
            "are not shown",
        );
      }
      last = e.uid;
      notes.push({
        ...this.asVersion(e, await openPath(this.keys, e.path)),
        // Zero means purge has taken every version that had content.
        // The note is still listed, and there is nothing to bring back.
        restorable: e.restorable ?? 0,
      });
    }
    // The cursor for the next page: the oldest uid this one holds. Undefined
    // when the list is empty, because there is nothing to page from.
    return { notes, more: answer.more, ...(last !== undefined ? { oldest: last } : {}) };
  }

  /**
   * The bytes of one version, without writing anything.
   *
   * What a history view needs and what restore cannot give it: somebody
   * deciding whether to put a version back has to read it first, and reading
   * it must not be the act of restoring it.
   *
   * Queued for the same reason restore is: reassembling a version is several
   * requests and a sync starting in the middle of them would collide.
   */
  async contentAt(version: Version): Promise<Uint8Array> {
    if (version.deleted || version.folder) return new Uint8Array(0);
    return this.serial(() => this.engine.contentOf(version.uid, version.contentId, version.size));
  }

  // MCP supplies an observing scan because the writer's list can reap staging
  // and normalize disk spellings, even when the caller only asks for a preview.
  preview(stats?: FileStat[]): Promise<SyncPreview> {
    return this.serial(() => this.engine.preview(stats));
  }

  reviewConflict(pair: ConflictPair): Promise<ConflictReview> {
    return this.serial(() => reviewConflict(this.opts.vault, pair));
  }

  resolveConflict(review: ConflictReview, choice: ConflictChoice, edited?: string): Promise<void> {
    return this.serial(async () => {
      if (this.closing) throw new Error("This client is closed.");
      if (this.opts.readOnly)
        throw new Error("Turn off receive-only mode before resolving conflicts.");
      await resolveConflict(this.opts.vault, review, choice, edited);
      this.engine.noteChanged(review.original);
      this.engine.noteChanged(review.copy);
      try {
        this.opts.onActivity?.({
          at: Date.now(),
          action: "resolved",
          path: review.original,
          copy: review.copy,
        });
      } catch {
        /* optional observer */
      }
    });
  }

  /** Restore beside any existing file; ordinary sync publishes the new copy. */
  async restore(version: Version, to?: string): Promise<{ path: string; bytes: number }> {
    // Keep both the fetch and the local publication in the queue. Closing a
    // client must wait for its last filesystem write before the caller can
    // unlink, release the CLI lock, or start another writer on this vault.
    return this.serial(async () => {
      if (this.closing) throw new Error("this client is closed");
      if (version.deleted) {
        throw new Error(
          `version ${version.uid} of ${version.path} is the deletion itself, not a version to restore`,
        );
      }
      if (version.folder) {
        const at = to ?? version.path;
        await this.opts.vault.mkdir(at);
        return { path: at, bytes: 0 };
      }

      // The signed history entry's chunk list is what `get` must answer with.
      const content = await this.engine.contentOf(version.uid, version.contentId, version.size);
      const wanted = to ?? version.path;
      const vault = this.opts.vault;
      const exists = (p: string) => vault.exists(p);
      const times = { mtime: version.mtime, ctime: version.ctime };
      // Never over what is there, and never in the gap between looking and
      // writing either. Repeated restores get distinct copy names.
      const at = await placeBeside(
        async () =>
          (await exists(wanted))
            ? firstFreeName(restoredCopyPath(wanted, version), exists)
            : wanted,
        content,
        times,
        vault,
      );
      return { path: at, bytes: content.length };
    });
  }

  /**
   * The newest version of a path that had content, or undefined.
   *
   * Not queued itself: it is a call to `history`, which is. Queuing here as
   * well would be a lock waiting for itself.
   */
  async newestContentVersion(path: string): Promise<Version | undefined> {
    return this.findVersion(path, (v) => !v.deleted);
  }

  /**
   * The newest version of a path that satisfies `match`, paging as far back as
   * it has to.
   *
   * A single page used to be all anybody looked at: fifty versions for the
   * newest with content, five hundred for a version by uid. A note edited
   * more often than that, or deleted and re-created enough times, had older
   * versions that `telimus history` would list and `telimus restore --uid`
   * would then say did not exist. Recovery is the one place that answer must
   * not be a page size.
   *
   * `pageSize` is a parameter so a test can make the paging happen with a
   * handful of versions rather than hundreds.
   */
  async findVersion(
    path: string,
    match: (v: Version) => boolean,
    pageSize = 100,
  ): Promise<Version | undefined> {
    let before: number | undefined;
    for (;;) {
      const page = await this.history(
        path,
        before === undefined ? { limit: pageSize } : { before, limit: pageSize },
      );
      const found = page.find(match);
      if (found) return found;
      if (page.length < pageSize) return undefined;
      const next = page[page.length - 1]!.uid;
      // Each page has to reach further back than the last (F10). `history`
      // refuses a page that is out of order or ignores `before`, which leaves
      // one shape it cannot see from inside a single answer: a server that
      // returns a well-formed page and then the same well-formed page again,
      // for ever. Paging is the only loop here that a server controls the
      // number of turns of.
      if (before !== undefined && next >= before) {
        throw new Error(
          `the server is not paging back through the versions of ${path}: it answered a ` +
            `request for versions older than ${before} with a page ending at ${next}`,
        );
      }
      before = next;
    }
  }

  private asVersion(e: WireEntry, path: string, previousPath?: string): Version {
    return {
      uid: e.uid,
      path,
      ...(previousPath !== undefined && previousPath !== path ? { previousPath } : {}),
      size: e.size,
      ctime: e.ctime,
      mtime: e.mtime,
      folder: e.folder,
      deleted: e.deleted,
      device: e.device,
      chunks: e.chunks.length,
      contentId: contentId(e.chunks),
    };
  }

  /* ------------------------------------------------------------ *
   * Adding a device
   * ------------------------------------------------------------ */

  /**
   * Issues a single-use invite for another device.
   *
   * The vault's data key goes to the server sealed under a fresh key the
   * server never sees, under a fresh identifier it cannot guess, for `ttlMs`
   * (the server's default and cap apply when this is absent or over). What
   * comes back is the string to hand over and the moment it stops working, in
   * server milliseconds. The string is the only copy of the invite key;
   * nothing here keeps it.
   *
   * This is how a device is added, and the recovery key is not. A device holds
   * the data key and its own credential and no root, so an invite is the most
   * a device can give away, and it is exactly enough: the redeeming device
   * gets the data key and a row of its own, and nothing that could register a
   * third device or rewrap the vault. The recovery key stays written down for
   * the day every device is gone.
   */
  async invite(ttlMs?: number): Promise<{ invite: string; expiresAt: number }> {
    // Not `randomBytes` straight: an id whose base64url starts with `-` is a
    // word the command line reads as an option, and `telimus uninvite` could
    // not cancel one.
    const id = generateInviteId();
    const key = randomBytes(INVITE_KEY_LENGTH);
    const sealed = await sealSecret(key, this.opts.dataKey);
    const expiresAt = await this.serial(() =>
      this.transport.invite({
        invite: base64urlEncode(id),
        sealed,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      }),
    );
    const invite: Invite = { url: this.opts.url, vaultId: this.opts.vaultId, id, key };
    return { invite: formatInvite(invite), expiresAt };
  }

  /* ------------------------------------------------------------ *
   * The device list
   * ------------------------------------------------------------ */

  /**
   * Every device that may reach this vault, and the cap on how many there
   * may be.
   *
   * A device's operation, not a registrar's: the list is what somebody reads
   * to answer "what is still connected to my notes", and a registrar reads
   * nothing.
   */
  async devices(): Promise<{
    devices: DeviceRow[];
    maxDevices: number;
    invites: InviteRow[];
  }> {
    return this.serial(() => this.transport.devices());
  }

  /**
   * Cancels an invite that is still outstanding, so the string somebody is
   * holding stops working before it expires.
   *
   * The companion to being able to see one. An invite is a standing authority
   * to register a device, and before this the only ways to retire one were to
   * wait out the hour or to rotate the vault, which retires the recovery key
   * with it: neither is an answer to "I issued that on the laptop I just
   * lost".
   *
   * An identifier that is unknown, expired or already redeemed is one refusal,
   * saying which of the three to nobody, because saying more would tell
   * somebody guessing identifiers that they had found a real one.
   */
  async uninvite(invite: string): Promise<void> {
    return this.serial(() => this.transport.uninvite(invite));
  }

  /**
   * Removes a device's row and closes every session it has open.
   *
   * Both, in that order, and the reply means both: a row removed while the
   * revoked device holds an authenticated connection is a revocation it does
   * not notice, because nothing on a live session is re-checked.
   *
   * A device may revoke another and may revoke itself. Revoking the last one
   * is refused without `allowLast`, because what it leaves is a vault only the
   * recovery key can reach.
   *
   * What this does **not** do is un-read what that device already read: it
   * still holds the vault's data key and can decrypt every note it had synced.
   * A device that was stolen rather than merely lost wants a rotation as well.
   * Every surface that offers this has to say so; the honesty is the feature.
   */
  async revoke(
    deviceId: string,
    opts: { allowLast?: boolean } = {},
  ): Promise<{ deviceId: string; self: boolean }> {
    return this.serial(() =>
      this.transport.revoke({
        deviceId,
        ...(opts.allowLast !== undefined ? { allowLast: opts.allowLast } : {}),
      }),
    );
  }

  /**
   * Changes this device's own label, and only its own.
   *
   * The name is what the device list, a note's history and a conflict copy's
   * filename are read by, and until protocol 5 it was chosen once at pairing
   * and fixed: a typo or a repurposed laptop meant unlinking and pairing
   * again, which makes a new row and loses the old one's history of who wrote
   * what.
   *
   * **The server first, and the caller writes the local copy after.** The two
   * cannot be made atomic across a network and a disk, so the order is chosen
   * rather than accidental: the device list is what another person reads and
   * what this device cannot fix while offline, and a local name that has moved
   * ahead of the server's is a device writing conflict copies under a label
   * the list does not know. The other way round leaves the server's list wrong
   * with nothing prompting a retry.
   *
   * The engine's own `device` is not touched here. It is read at every conflict
   * copy, so changing it under a pass in flight would name two copies of one
   * divergence differently; the shells save the config and the next pass picks
   * it up.
   *
   * Existing conflict copies keep the old name. They are notes on disk, and
   * rule 1 does not rewrite notes to tidy a label.
   */
  async rename(name: string): Promise<string> {
    return this.serial(() => this.transport.rename(name));
  }

  /** This device's own row id, so a caller can tell itself out of the list. */
  get deviceId(): string {
    return this.opts.deviceId;
  }

  /**
   * Closes the connection and resolves once nothing of this client is still
   * running.
   *
   * The transport is closed first, so a pass in flight fails its remaining
   * wire work quickly and records it for retry rather than waiting out a
   * timeout. Then that pass is waited for, because it may still be writing
   * files and the index, and whoever called this is about to reuse both.
   */
  private closing = false;

  async close(): Promise<void> {
    this.closing = true;
    for (const cancel of this.cancelMutations) cancel();
    this.clearUploadTimer();
    // Or a pass fires against a closed transport after the caller has
    // finished with this client, which in a test is a leak and in a plugin
    // is a sync running after the vault was unlinked.
    if (this.soonTimer !== undefined) {
      clearTimeout(this.soonTimer);
      this.soonTimer = undefined;
    }
    this.transport.close();
    this.uploadTransport?.close();
    await this.drain();
  }
}

/**
 * What the server is still holding that the vault is not.
 *
 * `more` rather than just a list, because the answer is bounded and a truncated
 * list that does not say so is one somebody reads and concludes their note is
 * gone.
 */
export interface DeletedList {
  readonly notes: Deletion[];
  readonly more: boolean;
  /**
   * The oldest uid on this page, to ask for the one before it (F21).
   *
   * Undefined for an empty page, because there is nothing to page from. The
   * list was capped with no way past the cap, and both clients tried to get
   * past it anyway: the panel doubled the limit it asked for and the CLI told
   * people to raise `--limit`. Both stop working at the cap, and neither said
   * so.
   */
  readonly oldest?: number;
}

/**
 * A deleted note, and whether anything survives to bring it back.
 *
 * The two are separate facts. Purge keeps only the newest version per path, and
 * for a deleted note that is the deletion record, so a note can be listed here
 * with its content gone. Saying "all still recoverable" over this list without
 * looking tells somebody their note is safe when it is not.
 */
export interface Deletion extends Version {
  /** The newest version with content, or 0 when there is none left. */
  readonly restorable: number;
}

/** One version of one note, as recovery talks about it. */
export interface Version {
  readonly uid: number;
  /** Plaintext, unsealed by whoever asked. */
  readonly path: string;
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly folder: boolean;
  /** True for the record of a deletion, which is a version like any other. */
  readonly deleted: boolean;
  /** The device that wrote it. */
  readonly device: string;
  /** How many chunks it is stored in. Zero for a folder, a deletion, or empty. */
  readonly chunks: number;
  /**
   * The chunk list as the signed entry named it, in the engine's content id
   * form. What a restore holds `get` to, so the server cannot answer with
   * another file's chunks.
   */
  readonly contentId: string;
  /**
   * The name this version was moved from, where it carries one (Codex-06).
   *
   * A rename travels as one signed operation, so this is authenticated with
   * the rest of the entry. History matches one exact sealed path, so without
   * it a note renamed today has a history that starts today, however many
   * months of it the server is still holding under the old name.
   *
   * Unsealed here, because it is a sealed path on the wire like any other.
   */
  readonly previousPath?: string;
}

/**
 * Where a restore goes when the path is already occupied.
 *
 * Same shape as a conflict copy and the same reason: the thing you already have
 * is never overwritten by something arriving from elsewhere. Somebody restoring
 * a note from last week onto a note they have been editing today should end up
 * with both.
 */
export function restoredCopyPath(path: string, version: Version): string {
  const { stem, ext } = splitName(path);
  return `${stem} (restored ${version.uid})${ext}`;
}

/** What a long-running client tells whoever is watching it. */
export interface ForeverHooks {
  /** After each settle, whether or not it did anything. */
  onSynced?(report: SyncReport, serverCursor: number): void;
  /**
   * A client that is about to connect, before it has.
   *
   * `onClient` fires only once the handshake has succeeded, which is right
   * for a shell that reads success into it, and too late for one that needs
   * to stop the attempt: a vault unlinked or a plugin unloaded during a slow
   * handshake had no handle on the client doing it, so the connection went
   * on to succeed and the loop went on to sync. This hands the shell the
   * client while it can still be closed.
   */
  onConnecting?(client: Client): void;
  /**
   * The live client, each time a new one connects, and undefined when it goes.
   *
   * For a shell that has its own reason to sync: the plugin gets file events
   * from Obsidian and wants to act on them, and it cannot without a handle on
   * whichever client is currently connected.
   */
  onClient?(client: Client | undefined): void;
  /**
   * A way to end the backoff wait immediately (I05).
   *
   * Called once, with a function that wakes the loop out of whatever it is
   * waiting through. A shell that has just been told to stop calls it after
   * setting `keepGoing` to false, and the loop returns rather than sleeping
   * out the rest of a five-minute retry. Optional: without it the loop still
   * checks `keepGoing` every second, which is prompt enough for a person and
   * not for a test.
   */
  onWaiting?(wake: () => void): void;
  /** The connection ended, and how long until the next attempt. */
  onDisconnected?(cause: Error, retryInMs: number): void;
  /** A connection could not be made, and how long until the next attempt. */
  onUnreachable?(cause: Error, retryInMs: number): void;
  /**
   * Something that will fail identically forever, so the loop has stopped.
   *
   * A bad token or an impossible cursor. Retrying those is a loop that never
   * ends and never tells anybody why.
   */
  onFatal?(cause: Error): void;
  /** Whether to keep going. Lets a shell stop the loop without an exception. */
  keepGoing?(): boolean;
  /** How the loop waits between attempts. Injectable so a test need not. */
  sleep?(ms: number): Promise<void>;
}

/**
 * How many times the same failure may end a connection before the loop
 * stops and says so.
 *
 * A batch the engine cannot apply ends the session, the loop reconnects, the
 * server sends the same batch, and round it goes for ever with nothing said
 * . Three identical failures in a row are not a network; they are a
 * wall, and the person is told where it is.
 */
export const IDENTICAL_FAILURES_BEFORE_STOPPING = 3;

/**
 * Syncs, then keeps syncing, reconnecting for as long as it is worth it.
 *
 * A network that comes and goes is the normal case for a laptop rather than an
 * error, so a dropped connection waits and tries again. `Backoff` is Obsidian's,
 * with its jitter: several devices attached to a server that restarts would
 * otherwise all return at the same instant, fail together, and come back
 * together.
 *
 * Resolves when a fatal refusal arrives or `keepGoing` says to stop.
 */
export async function runForever(opts: ClientOptions, hooks: ForeverHooks = {}): Promise<void> {
  const backoff = new Backoff(0, 300_000, 5_000, true);

  /**
   * The backoff wait, which `stop` can end (I05).
   *
   * A dropped connection backs off to five minutes, and unloading the plugin
   * or unlinking the vault used to wait out whatever was left of it: the loop
   * asked `keepGoing` before the sleep and after it, and did nothing at all
   * in between. Obsidian disabling a plugin therefore left a timer and a
   * closure alive for up to five minutes, and a test for it had to sleep for
   * real.
   *
   * `keepGoing` is polled as well as awaited, because it is the interface
   * shells already implement and nothing should have to grow an abort signal
   * to be shut down promptly. A second is short enough that nobody notices
   * and long enough that a five-minute wait is not three hundred wakeups.
   */
  let wakeUp: (() => void) | undefined;
  let wakeRequested = false;
  const wait = async (ms: number): Promise<void> => {
    if (!(hooks.keepGoing?.() ?? true)) return;
    if (wakeRequested) {
      wakeRequested = false;
      return;
    }
    await new Promise<void>((go) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wakeRequested = false;
        wakeUp = undefined;
        go();
      };
      wakeUp = finish;
      // One sleep, raced against the wake. Slicing it to poll `keepGoing`
      // was the first attempt and it hangs: a test injects a sleeper that
      // returns instantly, the wall clock never advances, and the slicing
      // loop spins for ever. The sleeper is the clock here, and code that
      // assumes otherwise is code that only works against a real one.
      if (hooks.sleep) void hooks.sleep(ms).then(finish);
      else timer = setTimeout(finish, ms);
    });
  };
  // Handed out so a shell can end the wait the instant it decides to stop.
  // Without it the loop still checks `keepGoing` either side of the wait, as
  // it always did; what it cannot then do is cut a five-minute backoff short.
  hooks.onWaiting?.(() => {
    backoff.success();
    wakeRequested = true;
    wakeUp?.();
  });
  let lastFailure = "";
  let repeats = 0;

  while (hooks.keepGoing?.() ?? true) {
    let client: Client | undefined;
    let cause: Error | undefined;
    let reachedTheServer = false;

    try {
      client = new Client(opts);
      hooks.onConnecting?.(client);
      await client.connect();
      reachedTheServer = true;
      // Asked again here, not only at the top of the loop. A shell that
      // said stop during the handshake has nothing else to say it with,
      // and a settle on a vault somebody has just unlinked is exactly the
      // sync they were trying to prevent.
      if (!(hooks.keepGoing?.() ?? true)) return;
      hooks.onClient?.(client);
      // Settled first, then reported. Written as one line before, with the
      // settle as the hook's argument, which meant a shell that passed no
      // `onSynced` never had the settle run at all: an optional call skips
      // its arguments, and the first sync waited for the ticker.
      const report = await client.settle();
      // Only here, because connecting is not progress.
      //
      // This used to reset the moment the handshake finished, which is the
      // same as saying a server that answers is a server that works. For a
      // day my own server answered every time and then refused the first
      // batch and closed the socket, so the loop reconnected, was refused,
      // reset the backoff to zero, and came back three seconds later. Twenty
      // two thousand times, at a five minute ceiling it never once reached.
      //
      // Settling is the smallest thing that means the session was worth
      // having: this device reconciled against the server and neither refused
      // the other. A drop after that is a network, and the next attempt should
      // be quick. A drop before it repeats, and the wait should grow.
      backoff.success();
      hooks.onSynced?.(report, client.serverCursor);
      cause = await client.runUntilClosed();
    } catch (err) {
      cause = err as Error;
    } finally {
      hooks.onClient?.(undefined);
      // Awaited: the next client loads the index this one may still be
      // writing, and two engines on one index is the state the
      // single-flight rule exists to prevent.
      await client?.close();
    }

    if (cause && isFatal(cause)) {
      hooks.onFatal?.(cause);
      return;
    }
    // The same failure, word for word, on consecutive connections is not a
    // network coming and going; it is something the server sends every time
    // and this device cannot take, and retrying it is a loop that never ends
    // and never tells anybody why. A dropped connection is excused,
    // because that is what a network does, and so is a refusal the server
    // marked retryable, because `busy` on a full vault is the same words
    // every time and is still meant to be waited out. What is left is this
    // device's own failure to apply what it was sent.
    if (cause && !(cause instanceof ConnectionError) && !(cause instanceof ProtocolError)) {
      repeats = cause.message === lastFailure ? repeats + 1 : 1;
      lastFailure = cause.message;
      if (repeats >= IDENTICAL_FAILURES_BEFORE_STOPPING) {
        hooks.onFatal?.(
          new Error(
            `${cause.message}. This has failed ${repeats} times in a row with this device at cursor ` +
              `${client?.engine.status().cursor ?? 0}, so waiting will not help; ` +
              `docs/server.md says how to recover from an entry no device can apply`,
          ),
        );
        return;
      }
    } else {
      repeats = 0;
      lastFailure = "";
    }
    if (!(hooks.keepGoing?.() ?? true)) return;

    backoff.fail();
    const why = cause ?? new Error("the connection ended");
    const delay = retryWait(why, backoff.delay());
    if (reachedTheServer) hooks.onDisconnected?.(why, delay);
    else hooks.onUnreachable?.(why, delay);
    await wait(delay);
  }
}

/**
 * Whether trying again could ever help.
 *
 * "Closed by this device" is not a failure, it is this client shutting down, and
 * treating it as fatal would stop a loop that was asked to stop anyway. A
 * refusal the server marked as not retryable will be repeated word for word
 * forever; one it marked retryable, `busy` on a restart above all, is the
 * connection ending for a reason a retry outlives.
 */
export function isFatal(cause: Error): boolean {
  return cause instanceof ProtocolError && cause.fatal;
}

/**
 * How long to wait before the next attempt: the backoff, or longer if the
 * server said so.
 *
 * `retryAfterMs` travels with `busy`. A device refused for the vault's device
 * limit is told thirty seconds, because the other devices' sessions have to
 * go away first; one refused for a shutdown is told five, because the server
 * is about to be back. Neither is a reason to wait less than the backoff
 * already would, so the longer of the two wins.
 */
export function retryWait(cause: Error, backoffMs: number): number {
  const hint = cause instanceof ProtocolError ? cause.retryAfterMs : undefined;
  return Math.max(backoffMs, hint ?? 0);
}

/**
 * A fresh data key for a vault about to be claimed, wrapped under its root so
 * the server can store it.
 *
 * Made once, on the one attempt there is. It used to be staged in the device
 * config, because the claim was retried from disk and a fresh candidate per
 * attempt could bind the vault to one key while the device went on offering
 * another. Nothing retries a claim from disk any more: a claim that commits
 * with its reply lost is recovered by pairing with the recovery key, and the
 * server hands that session the key the claim already bound.
 */
export async function wrappedForClaim(keys: RootKeys): Promise<string> {
  return wrapDataKey(keys.wrap, generateDataKey());
}

/* ---------------------------------------------------------------- *
 * The registrar, and becoming a device
 * ---------------------------------------------------------------- */

/**
 * A connection holding the vault's own credential, which is the recovery key.
 *
 * It may register a device, rotate the vault's secret and administer the
 * device list: read it, and take a row off it, including the last row. It may
 * do nothing else: no entries, no history, no catch-up, and nothing that reads
 * or writes a note. That is the server's shape rather than a promise this
 * class keeps, and it is the whole of the privilege separation per-device
 * credentials are made of. See docs/protocol.md, "Authentication".
 *
 * The device list is here because two things need it. Emptying the vault is
 * the recovery key's alone, since it is the one revocation nothing on a device
 * can undo, and a vault whose every row is a pairing that crashed refuses
 * every registration until somebody prunes it, with no device left to prune
 * it from.
 *
 * A separate class from `Client` on purpose. One object that was sometimes a
 * device and sometimes a registrar would have every caller asking which, and
 * the one place that must never get it wrong is the one that decides whether
 * a credential may sync.
 */
export class Registrar {
  private constructor(
    readonly transport: Transport,
    readonly limits: RegistrarLimits,
    private readonly root: RootKeys,
  ) {}

  /**
   * Opens one, with the root secret the caller holds.
   *
   * `claim` binds an unclaimed vault and is sent only while the caller still
   * holds the server's first-run token; see `wrappedForClaim`.
   */
  static async open(opts: {
    url: string;
    vaultId: string;
    device: string;
    secret: Uint8Array;
    /** The server's first-run token, while the vault is still being claimed. */
    bootstrap?: string | undefined;
    claim?: { auth: string; wrapped: string } | undefined;
    timeoutMs?: number | undefined;
    socketFactory?: ((url: string) => SocketLike) | undefined;
    log?: ((message: string, ...rest: unknown[]) => void) | undefined;
  }): Promise<Registrar> {
    const root = await deriveRootKeys(opts.secret);
    const transport = new Transport(opts.url, {
      onBatch: () => {
        // A registrar is in no vault's fan-out, so this is unreachable
        // against any server that keeps the protocol. Present because the
        // transport requires a handler, and doing nothing is right: there is
        // no engine here and no keys to open an entry with.
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    });
    try {
      await transport.connect();
      const limits = await transport.helloAsRegistrar({
        vault: opts.vaultId,
        device: opts.device,
        // The bootstrap while there is one, and what the root derives once
        // the vault has been claimed.
        token: opts.bootstrap ?? authToken(root),
        ...(opts.claim !== undefined ? { claim: opts.claim } : {}),
      });
      return new Registrar(transport, limits, root);
    } catch (err) {
      transport.close();
      throw err;
    }
  }

  /**
   * Registers a device row and returns the vault's data key, unwrapped.
   *
   * The unwrapping happens here because this session is the one that can: it
   * holds the root, and the wrapping key derives from it. That is the whole
   * mechanism by which a device ends up holding the data key without ever
   * holding the root, and it is also the check on what came back: a wrapping
   * the server invented does not open under this root, so a key no other
   * device on the vault derives cannot be installed by being handed over.
   */
  async register(args: {
    deviceId: string;
    deviceSecret: Uint8Array;
    name: string;
  }): Promise<{ dataKey: Uint8Array; wrapped: string }> {
    const { wrapped } = await this.transport.register({
      deviceId: args.deviceId,
      auth: await deviceAuthToken(args.deviceSecret),
      name: args.name,
    });
    return { dataKey: await unwrapDataKey(this.root.wrap, wrapped), wrapped };
  }

  /**
   * Gives the vault a new root secret, keeping its history and every device.
   *
   * The data key does not change: it is unwrapped under the old root and
   * wrapped again under the new one, and the server swaps the auth hash and
   * the blob together. **No device row is touched and every device goes on
   * syncing across a rotation**, which is the expensive half of what per-device
   * credentials removed: a rotation that evicted every device is how a leaked
   * key goes unrotated.
   *
   * The data key comes from the caller rather than from a wrapping, because a
   * registrar is handed no wrapping at hello and the caller has the key
   * already: it is a paired device on this vault, and holding the data key is
   * what being one means.
   */
  async rotate(newSecret: Uint8Array, dataKey: Uint8Array): Promise<{ rewrapped: string }> {
    const fresh = await deriveRootKeys(newSecret);
    const rewrapped = await wrapDataKey(fresh.wrap, dataKey);
    await this.transport.rotate({ auth: authToken(fresh), wrapped: rewrapped });
    return { rewrapped };
  }

  /**
   * Every device that may reach this vault, and the cap on how many there may
   * be.
   *
   * The same op a device sends, and the same answer. It is the access list
   * rather than the vault's content, it carries no key material, and the
   * recovery key needs it to be able to act: revoking takes an id.
   */
  async devices(): Promise<{
    devices: DeviceRow[];
    maxDevices: number;
    invites: InviteRow[];
  }> {
    return this.transport.devices();
  }

  /**
   * Cancels an outstanding invite. The recovery key's, on the same reasoning
   * as the device list: an invite is who may reach the vault, not what it
   * holds, and on a vault whose devices are gone this is the only credential
   * left to retire one with.
   */
  async uninvite(invite: string): Promise<void> {
    return this.transport.uninvite(invite);
  }

  /**
   * Removes a device's row and closes every session it has open.
   *
   * `allowLast` is why this is here. A device is refused it, because emptying
   * the vault is the one revocation nothing on a device can undo: what it
   * leaves is a vault only the recovery key opens, so it is the recovery key's
   * to do. The server still asks for the word, which is the confirmation, now
   * asked of the credential that can undo the answer.
   *
   * It does not un-read what that device already read, here any more than
   * anywhere else, and a device that was stolen wants a rotation as well.
   */
  async revoke(
    deviceId: string,
    opts: { allowLast?: boolean } = {},
  ): Promise<{ deviceId: string; self: boolean }> {
    return this.transport.revoke({
      deviceId,
      ...(opts.allowLast !== undefined ? { allowLast: opts.allowLast } : {}),
    });
  }

  close(): void {
    this.transport.close();
  }
}

/** Where a device is joining from, and what it holds to join with. */
export interface JoiningVault {
  /** WebSocket URL of the server, without the path. */
  readonly url: string;
  readonly vaultId: string;
  /** This device's local name, which becomes the label on its row. */
  readonly device: string;
  /**
   * The vault's root secret: a recovery key somebody pasted, or the one this
   * device has just made for a vault it is starting.
   */
  readonly secret: Uint8Array;
  /**
   * Whether the device being registered may send anything to the server (I29).
   *
   * Carried through registration rather than written afterwards, because the
   * config this produces *replaces* whatever was on disk: setting it at `init`
   * and letting registration rebuild the file dropped it silently, and the
   * spread that set it bypassed the excess-property check that would have
   * said so.
   */
  readonly readOnly?: boolean;
  /**
   * Names this device will never sync, chosen before it starts (Codex-05).
   *
   * Carried through registration for the same reason `readOnly` is: the config
   * this produces *replaces* whatever was on disk, so a list written
   * beforehand and left to registration to preserve is a list that vanishes.
   */
  readonly ignore?: readonly string[];
  /**
   * The server's first-run token, present only while this device is claiming
   * an unclaimed vault. The claim rides on the registrar hello below, so it is
   * spent by the same exchange that registers this device's row.
   */
  readonly bootstrap?: string | undefined;
}

/**
 * Registers this device against a vault it holds the root of, and returns the
 * config of a device that holds no root.
 *
 * The two ways in are `telimus init` and the panel's "start a new vault", which
 * arrive with a bootstrap token and a secret nobody has seen yet, and `telimus
 * pair RECOVERY-KEY` and the panel's pairing form, which arrive with a secret
 * somebody pasted. Both end in the same place, which is the point: a row on
 * the vault, the credential for it, the data key, and no root.
 *
 * One save, and its placement is the whole of the crash story. `save` must
 * write durably and read back before returning (rule 4, verify the outcome and
 * not the exit code), and it is called *after* the registration has committed
 * and *before* anything else can fail. What a crash leaves:
 *
 *  - **Before the registration.** Nothing here has written anything. A vault
 *    being started still has its root on disk from before the claim, which is
 *    the only copy of the recovery key and is why it is written there; a
 *    pairing has the key in somebody's hand already.
 *  - **Between the registration and the save.** One row on the server that
 *    nobody holds the credential for. It shows in `telimus devices` as a device
 *    that has never connected and goes with `telimus revoke`, which is exactly
 *    the failure the invite path has and is documented with.
 *  - **After the save.** A finished device. The connection below only confirms
 *    it, so failing there costs a retry and no state.
 *
 * There is deliberately no resumable half-state. The root and the device
 * credential never sit on disk together, so a stolen laptop cannot re-derive
 * the vault's credential and register itself again, and there is no shape a
 * config can be in that some later command has to recognise and finish.
 *
 * The first two crash points are walked against a real server in
 * cli/state.test.ts, "a vault that was started and never joined ": the
 * refusal that hands the recovery key back and pairs again with it, notes and
 * all, and the row a failed save leaves for `telimus revoke` to take.
 */
export async function registerAsDevice(
  joining: JoiningVault,
  save: (device: DeviceConfig) => Promise<void>,
  opts: {
    timeoutMs?: number | undefined;
    socketFactory?: ((url: string) => SocketLike) | undefined;
    log?: ((message: string, ...rest: unknown[]) => void) | undefined;
    /**
     * Called the moment the server has accepted the registration, before
     * anything else can fail.
     *
     * For the callers that have to tell the two failures apart: a pairing that
     * never registered leaves the vault exactly as unpaired as it found it,
     * because a recovery key that turns out to be wrong should cost nothing,
     * and one that did register has a row on the server to say so.
     */
    onRegistered?: (() => void) | undefined;
  } = {},
): Promise<DeviceConfig> {
  const root = await deriveRootKeys(joining.secret);
  const deviceId = generateDeviceId();
  const deviceSecret = generateDeviceSecret();

  const registrar = await Registrar.open({
    url: joining.url,
    vaultId: joining.vaultId,
    device: joining.device,
    secret: joining.secret,
    ...(joining.bootstrap !== undefined
      ? {
          bootstrap: joining.bootstrap,
          claim: { auth: authToken(root), wrapped: await wrappedForClaim(root) },
        }
      : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  let dataKey: Uint8Array;
  try {
    ({ dataKey } = await registrar.register({
      deviceId,
      deviceSecret,
      name: joining.device,
    }));
  } finally {
    registrar.close();
  }
  opts.onRegistered?.();

  const device: DeviceConfig = {
    url: joining.url,
    vaultId: joining.vaultId,
    device: joining.device,
    deviceId,
    deviceSecret,
    dataKey,
    ...(joining.readOnly === true ? { readOnly: true } : {}),
    ...(joining.ignore?.length ? { ignore: joining.ignore } : {}),
  };
  await save(device);

  // Use the row. A hello that is answered `ready` is the row existing, this
  // key opening it, and the server willing to serve this vault, all proven by
  // the one thing that has to be true afterwards. It comes after the save, so
  // a device whose confirmation failed still has a credential on disk to try
  // again with rather than a row it has forgotten the key to.
  await proveDeviceConnects(device, opts);
  opts.log?.("registered a per-device credential", { deviceId });
  return device;
}

/**
 * What is on the disk where a device's credential should be, after a
 * registration that did not finish.
 *
 * Four states and not two, because rule 2 is what reading it is for: an
 * unreadable config is not an absent one. A config that was written and cannot
 * be read back holds a credential that may be the only copy of a live row's
 * key, and calling that nothing is how advice comes to destroy a row this
 * device could have used.
 */
export type PairingRemains =
  /** A credential for a row: this device is finished bar the confirmation. */
  | { readonly kind: "credential"; readonly config: DeviceConfig }
  /** The vault's root and no credential: a vault started here and not joined. */
  | { readonly kind: "root"; readonly config: DeviceConfig }
  /** Nothing at all, which is also what an unpaired vault looks like. */
  | { readonly kind: "nothing" }
  /** Something is there and will not read, so nothing here is known. */
  | { readonly kind: "unreadable"; readonly why: string };

/**
 * Reads what is left, keeping absent and unreadable apart (rule 2).
 *
 * `read` is the surface's own reader: `loadConfig` in the CLI, `readConfig` in
 * the plugin. Both return undefined for a config that is not there and throw
 * for one that is there and will not decode, which is the distinction this
 * turns into a state instead of the `.catch(() => undefined)` that flattened
 * the two.
 */
export async function whatTheDiskHolds(
  read: () => Promise<DeviceConfig | undefined>,
): Promise<PairingRemains> {
  let held: DeviceConfig | undefined;
  try {
    held = await read();
  } catch (err) {
    return { kind: "unreadable", why: (err as Error).message };
  }
  if (held?.deviceId !== undefined) return { kind: "credential", config: held };
  // Anything else that decoded holds the root and nothing else: `decodeConfig`
  // refuses a config with neither, so there is no third shape to be in. The
  // config comes back with the state because the caller that has to keep it,
  // the panel, would otherwise read the same file a second time to get it.
  if (held !== undefined) return { kind: "root", config: held };
  return { kind: "nothing" };
}

/**
 * What to do next when registering this device did not finish: one counsellor
 * for `telimus init`, `telimus pair` and both of the panel's pairing paths.
 *
 * It answers from what the disk says rather than from which step threw (rule
 * 4), because that is the only thing that tells the states apart, and it is
 * one function because four copies of these words is how three of them come to
 * be missing a sentence. `init`'s copy was: it printed the recovery key and
 * said "unlink here, and pair with that key", which is right and incomplete.
 * A registration may already have committed, so pairing again registers a
 * *second* row, leaving an unused registration behind. `pair`'s copy said so;
 * `init`'s did not.
 *
 * What each state is owed:
 *
 *  - **credential**: the row is real and this is the only copy of its key, so
 *    what was written stays and syncing finishes it.
 *  - **root** and **nothing**: no credential here, so a row on the server may
 *    be one nothing can connect as. Naming it is the whole point.
 *  - **unreadable**: nothing is known, so nothing is advised. A `saveConfig`
 *    that succeeded with a read-back that then failed lands here holding a
 *    perfectly good credential, and "revoke the row and pair again" would
 *    throw away a row this device could have used. It takes a disk that writes
 *    and will not read back, which is exactly the disk that makes the advice
 *    wrong, so the refusal says what is unknown instead of guessing.
 *
 * Whether a row exists cannot be read off a config, and saying so is the
 * honest part. `registered` is one way only: true means the server was seen to
 * accept the registration, false means it may still have committed with the
 * reply lost. So a row "was" or "may have been" registered, and never was not.
 *
 * The way back is pair-again-then-revoke rather than revoke-then-pair-again,
 * because the stranded row is often the vault's only one, and revoking the
 * last row takes `--allow-last` and the recovery key. Pairing first makes it
 * an ordinary revocation from an ordinary device.
 *
 * cli/state.test.ts walks these against a real server, and plugin/main.test.ts
 * walks the panel's two paths.
 */
export function adviseAfterRegistering(what: {
  readonly remains: PairingRemains;
  /** Whether the server was seen to accept the registration. */
  readonly registered: boolean;
  /** Which shell is speaking, so it names commands that exist there. */
  readonly surface: "cli" | "panel";
  /** Where the config lives, in that shell's words. */
  readonly where: string;
}): string {
  const { remains, registered, surface, where } = what;
  const cli = surface === "cli";
  switch (remains.kind) {
    case "credential":
      return cli
        ? `This device is registered with the vault and ${where} holds its credential; ` +
            `run telimus sync here to finish, or telimus unlink to start again.`
        : `This device is registered with the vault; Telimus will connect as it on the next attempt.`;
    case "unreadable":
      return (
        `${where} could not be read (${remains.why}), so what this device holds is not known and ` +
        `nothing should be revoked on the strength of it: a credential that was written and ` +
        `cannot be read back is still the only copy of its row's key. Fix that first, ` +
        (cli
          ? `then telimus status here says whether this device has one.`
          : `then reload the plugin, which says whether this device has one.`)
      );
    default: {
      const wayBack =
        remains.kind !== "root"
          ? "Pair again"
          : cli
            ? "Run telimus unlink here and telimus pair with the recovery key"
            : "Unlink this vault and pair again with the recovery key on the panel";
      return (
        `A device row ${registered ? "was" : "may have been"} registered with the vault and its ` +
        `credential is not here, so nothing can connect as that device. ${wayBack}, then ` +
        (cli
          ? `telimus devices lists that row as never connected and telimus revoke ID removes it.`
          : `the device list shows that row as never connected, with Revoke beside it.`)
      );
    }
  }
}
/**
 * One hello as the device, and nothing after it.
 *
 * `waitForBacklog` is not on offer: this connection exists to find out whether
 * the credential works, and a device joining after months away would otherwise
 * sit through its whole backlog twice, once here and once when the command it
 * was actually running connects.
 */
export async function proveDeviceConnects(
  config: DeviceConfig,
  opts: {
    timeoutMs?: number | undefined;
    socketFactory?: ((url: string) => SocketLike) | undefined;
    log?: ((message: string, ...rest: unknown[]) => void) | undefined;
  } = {},
): Promise<void> {
  const { deviceId, deviceSecret } = deviceCredential(config);
  const transport = new Transport(config.url, {
    onBatch: () => {},
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  try {
    await transport.connect();
    await transport.hello({
      vault: config.vaultId,
      deviceId,
      token: await deviceAuthToken(deviceSecret),
      device: config.device,
      // Zero, because nothing here applies anything. A cursor is only ever
      // refused for being ahead of the server, so zero cannot be refused and
      // this connection cannot fail for a reason that is not about the
      // credential it is testing.
      cursor: 0,
    });
  } finally {
    transport.close();
  }
}

/**
 * Redeems an invite: one connection that hands over the invite, asks for a
 * device row, takes the vault's data key, and closes.
 *
 * What comes back is everything a paired device is: a row of its own, the
 * credential for it, and the data key. No root, which is the point. A device
 * added this way cannot register a third, cannot rewrap the vault and cannot
 * show anybody the recovery key, so revoking it means something.
 *
 * The id and the secret are made here and sent in the same frame as the
 * invite, because the server registers the row in the same transaction that
 * spends it. There is no separate `register` to make: a device holds no root,
 * so the device that issued this invite could not have made the row, and this
 * connection holds nothing else the server would accept one under.
 *
 * **Nothing is written to disk before this runs, and everything after it.**
 * The other order was considered and is worse. Saving the id and the secret
 * first would mean a crash between the save and the reply leaves a device
 * holding a credential for a row it cannot use, because the data key it needs
 * is in a reply that never arrived and the invite that carried it is spent:
 * that device is stuck, and the retry with a fresh invite registers a second
 * row and strands the first. This way a crash costs a row nobody holds the key
 * to, which is visible in `telimus devices` as a device that has never
 * connected and is removed with `telimus revoke`, and the local vault is left
 * exactly as unpaired as it was found, so the retry is the ordinary path.
 *
 * The caller saves what this returns, durably, and reads it back before it
 * relies on it (rule 4). Until it does, the only copy of the data key on this
 * machine is in this process.
 */
export async function redeemInvite(
  invite: Invite,
  device: string,
  opts: {
    timeoutMs?: number | undefined;
    socketFactory?: ((url: string) => SocketLike) | undefined;
    log?: ((message: string, ...rest: unknown[]) => void) | undefined;
  } = {},
): Promise<{ deviceId: string; deviceSecret: Uint8Array; dataKey: Uint8Array }> {
  const deviceId = generateDeviceId();
  const deviceSecret = generateDeviceSecret();
  const transport = new Transport(invite.url, {
    onBatch: () => {
      // A redeeming connection joins no vault's fan-out, so this is
      // unreachable against any server that keeps the protocol. Present
      // because the transport requires a handler, and doing nothing is right:
      // there is no engine here and, until the reply lands, no key to open an
      // entry with.
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  try {
    await transport.connect();
    const redeemed = await transport.redeem({
      vault: invite.vaultId,
      device,
      invite: base64urlEncode(invite.id),
      deviceId,
      auth: await deviceAuthToken(deviceSecret),
      name: device,
    });
    // Unsealed with the key that travelled in the string and never to the
    // server, so a server holding every invite it was ever handed holds blobs
    // it cannot open. A wrong key fails here rather than later as content that
    // will not decrypt.
    return { deviceId, deviceSecret, dataKey: await unsealSecret(invite.key, redeemed.sealed) };
  } finally {
    transport.close();
  }
}

/**
 * The half of a client's options that says who this device is.
 *
 * Which row it connects as, which key proves it, and the data key it reads and
 * writes content with. Both shells worked the equivalent out for themselves
 * once, from the same stored config, and the two copies were the
 * highest-consequence drift point in the client.
 *
 * It refuses a config that holds no credential rather than falling back to the
 * root. A device that can fall back to the root is a device revoking cannot
 * stop. `deviceCredential` is where the refusal is worded.
 */
export function credentialsFor(
  config: DeviceConfig,
): Promise<Pick<ClientOptions, "dataKey" | "url" | "token" | "deviceId" | "vaultId" | "device">> {
  const { deviceId, deviceSecret, dataKey } = deviceCredential(config);
  return deviceAuthToken(deviceSecret).then((token) => ({
    dataKey,
    url: config.url,
    token,
    deviceId,
    vaultId: config.vaultId,
    device: config.device,
  }));
}

/** The shapes a shell needs to show a device list, re-exported for the same reason. */
export type { DeviceRow, InviteRow, RegistrarLimits } from "./transport.ts";

/**
 * Where this device and the server each are, for deciding whether a rebase is
 * the answer.
 *
 * The server's number is asked for from a connection that carries no index and
 * so cannot be refused for being ahead, which is the whole difficulty: the
 * device that needs this is the one the server will not talk to. The backlog is
 * not waited for either, because with an empty index the backlog is the whole
 * vault and this connection is closed the moment the number is out of the
 * handshake.
 *
 * This device's number comes from the store in `opts`, so the two shells cannot
 * disagree about which index they are comparing.
 */
export async function rebaseCursors(
  opts: ClientOptions,
): Promise<{ local: number; server: number }> {
  const local = validateStoredState(await opts.store.load())?.cursor ?? 0;
  const probe = new Client({ ...opts, store: new MemoryIndexStore() });
  try {
    await probe.connect({ waitForBacklog: false });
    return { local, server: probe.serverCursor };
  } finally {
    await probe.close();
  }
}

/**
 * Refuses a rebase that is not the answer to anything.
 *
 * A rebase forgets what this device believed it had synced, and the only thing
 * that makes that safe is being ahead of the server: everything both sides hold
 * identically is agreed again, and what only this device holds goes up as new
 * versions. A device that is not ahead has nothing to rejoin from, and throwing
 * away its index would re-upload the vault for no reason.
 *
 * One function rather than one comparison per shell, because the panel and the
 * command line must not disagree about when this is allowed.
 */
export function refuseUnlessAhead(at: { local: number; server: number }): void {
  if (at.local > at.server) return;
  throw new Error(
    `this device is not ahead of the server (${at.local} against ${at.server}), ` +
      `so there is nothing to rebase: an ordinary sync is enough`,
  );
}

/**
 * Whether a pass did anything that could produce more work.
 *
 * `waiting` is not on the list, and used to be. A waiting file is one whose
 * write debounce has not run out, which lasts several seconds; counting it here
 * had `settle` re-stat the whole vault eight times at 60 ms intervals to find
 * the same file still waiting, and then return anyway. The follow-on work that
 * is real is handled inside a pass by `again`, which reruns while there is
 * something to do rather than while there is something to wait for.
 */
export function didSomething(r: SyncReport): boolean {
  return (
    r.uploaded +
      r.downloaded +
      r.merged +
      r.conflicted +
      r.deletedLocally +
      r.deletedRemotely +
      r.restored +
      r.foldersCreated >
    0
  );
}

/**
 * A one-line summary for a status bar, which has room for one line.
 *
 * Every counter the report has, because the plugin paints this string into
 * its state and nothing else of the pass reaches the panel. `waiting` was
 * left out, so a file still inside its write debounce, which lasts several
 * seconds, produced "up to date" while a save was owed: rule 7, and the kind
 * of lie a person acts on by closing the laptop. `foldersCreated` was left
 * out with it, and a pass that only made folders said nothing at all.
 */
export function summarise(r: SyncReport): string {
  const bits: string[] = [];
  const add = (n: number, many: string, one = many) => {
    if (n > 0) bits.push(`${n} ${n === 1 ? one : many}`);
  };
  add(r.uploaded, "sent");
  add(r.downloaded, "received");
  add(r.merged, "merged");
  add(r.conflicted, "conflicted");
  add(r.deletedLocally + r.deletedRemotely, "deleted");
  add(r.restored, "restored");
  add(r.foldersCreated, "folders", "folder");
  add(r.waiting, "waiting");
  add(r.retrying, "retrying");
  // One phrase where there were three. "stuck", "ignored" and "in the way"
  // were three words for two ideas, and neither the CLI nor a person had the
  // same three: see `needsAttention` on the report. `ignored` keeps its own
  // phrase because it is not a problem, and it is the one that must not
  // disappear.
  add(needsAttention(r), "need attention", "needs attention");
  add(r.ignored, "ignored");
  return bits.length === 0 ? "up to date" : bits.join(", ");
}

/**
 * How many paths are waiting on a person.
 *
 * `blocked` and `skipped` and nothing else, which is the same pair the exit
 * code is built from and the same pair the panel's glyph turns on: a path this
 * device is set to ignore is the configuration working (R2) and is counted and
 * printed apart from these.
 *
 * The count rather than `needsAttention.length`, because that list is bounded
 * and this is the truth: one file where a folder belongs blocks a subtree, and
 * a headline that said five when four hundred are stuck would be rule 7 again
 * one level down.
 */
export function needsAttention(r: SyncReport): number {
  return r.skipped + r.blocked;
}

/**
 * The needs-attention list as lines, for whichever surface is printing it.
 *
 * One renderer, because the CLI and the panel had grown separate vocabularies
 * for the same counters: "cannot sync and will not be retried" against
 * "stuck", "waiting on a name two things claim" against "in the way". Two
 * shells of one engine describing one vault two ways is the same defect as two
 * adapters answering one question two ways, and the fix is the same one.
 *
 * One line per reason with its paths in front, rather than a line per path.
 * The reason is the actionable half and it is usually shared: one file where a
 * folder belongs blocks every path beneath it, and four hundred copies of one
 * sentence is a wall rather than a message.
 *
 * `indent` because the CLI prints into a column and a notice does not.
 */
export function attentionLines(r: SyncReport, indent = ""): string[] {
  const listed = r.needsAttention ?? [];
  const byReason = new Map<string, string[]>();
  // `?? []` for the same reason the plugin's `announce` has one: the type
  // promises the list and a report built by hand may not keep it, and this is
  // on the path of the notice that says a file is stuck. Falling over while
  // reporting a refusal loses the refusal (plugin/main.test.ts, "announces the
  // count when a report names no paths").
  for (const { path, why } of listed) {
    const paths = byReason.get(why);
    if (paths) paths.push(path);
    else byReason.set(why, [path]);
  }
  const lines: string[] = [];
  for (const [why, paths] of byReason) lines.push(`${indent}${paths.sort().join(", ")}: ${why}`);
  // The list is bounded and the count is not, so the difference is said rather
  // than left for somebody to notice that the numbers do not add up.
  const rest = needsAttention(r) - listed.length;
  if (rest > 0) lines.push(`${indent}and ${rest} more.`);
  return lines;
}
