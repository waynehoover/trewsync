import type { DeviceRow } from "../core/transport.ts";
import { deliverySummary, receivedLatest } from "../core/delivery.ts";
import { pollWhileVisible, type VisiblePoll } from "./visible-poll.ts";

interface Source {
  readonly currentState: { kind: string };
  readonly deliveryReady: boolean;
  cursors(): { local: number; server: number } | undefined;
  devices(): Promise<{ devices: DeviceRow[]; thisDevice: string }>;
  watchState(listener: () => void): () => void;
}

const monitors = new WeakMap<Source, DeliveryMonitor>();

/** All open settings surfaces for one plugin share a single delivery request. */
export function watchDelivery(
  source: Source,
  listener: (message: string) => void,
  doc = globalThis.document,
): () => void {
  let monitor = monitors.get(source);
  if (!monitor) {
    monitor = new DeliveryMonitor(source);
    monitors.set(source, monitor);
  }
  return monitor.watch(listener, doc);
}

class DeliveryMonitor {
  private readonly listeners = new Map<(message: string) => void, Document | undefined>();
  private visible = () =>
    [...this.listeners.values()].some((doc) => doc?.visibilityState !== "hidden");
  private poll: VisiblePoll | undefined;
  private unwatch: (() => void) | undefined;
  private message = "Device delivery unconfirmed.";
  private interval: number | undefined;
  private key = "";
  private revision = 0;
  private request: Promise<Awaited<ReturnType<Source["devices"]>>> | undefined;
  constructor(private readonly source: Source) {}

  watch(listener: (message: string) => void, doc: Document | undefined): () => void {
    const wasVisible = this.visible();
    this.listeners.set(listener, doc);
    const changed = () => this.poll?.refresh();
    doc?.addEventListener("visibilitychange", changed);
    if (this.listeners.size === 1) {
      this.message = "Device delivery unconfirmed.";
      this.key = this.snapshot();
      this.poll = pollWhileVisible(
        () => this.refresh(),
        () => this.interval,
        this.visible,
      );
      this.unwatch = this.source.watchState(() => {
        const key = this.snapshot();
        if (key === this.key) return;
        this.key = key;
        this.revision++;
        this.say("Device delivery unconfirmed.");
        this.poll?.refresh();
      });
    }
    if (!wasVisible && this.listeners.size > 1) this.poll?.refresh();
    listener(this.message);
    return () => {
      this.listeners.delete(listener);
      doc?.removeEventListener("visibilitychange", changed);
      if (!this.visible()) this.poll?.refresh();
      if (!this.listeners.size) {
        this.revision++;
        this.poll?.();
        this.poll = undefined;
        this.unwatch?.();
        this.unwatch = undefined;
      }
    };
  }

  private snapshot(): string {
    return JSON.stringify([
      this.source.currentState.kind,
      this.source.deliveryReady,
      this.source.cursors(),
    ]);
  }
  private say(message: string): void {
    if (this.message === message) return;
    this.message = message;
    for (const listener of this.listeners.keys()) listener(message);
  }
  private async refresh(): Promise<void> {
    const source = this.source;
    if (source.currentState.kind !== "synced") {
      this.interval = undefined;
      this.say("Device delivery unconfirmed.");
      return;
    }
    if (!source.deliveryReady) {
      this.interval = 250;
      this.say("Waiting for this device to finish syncing.");
      return;
    }
    // A surface may close and reopen while its last request is still draining.
    // Wait for that request, then obtain a fresh checkpoint without overlap.
    if (this.request) {
      await this.request.catch(() => undefined);
      this.poll?.refresh();
      return;
    }
    const revision = this.revision;
    const key = this.snapshot();
    try {
      this.request = source.devices();
      const answer = await this.request;
      if (!this.listeners.size || revision !== this.revision || key !== this.snapshot()) {
        this.poll?.refresh();
        return;
      }
      const cursor = source.cursors()?.server;
      if (cursor === undefined) {
        this.interval = 2000;
        this.say("Device delivery unconfirmed.");
        return;
      }
      const pending = answer.devices.filter(
        (device) => device.id !== answer.thisDevice && !receivedLatest(device, cursor),
      );
      // A second, not a quarter of one (R083-19). Every tick is a `devices`
      // request on the same socket the sync uses, and each answer costs the
      // server two queries and a scan of the hub. Four times a second was
      // four times the cost for a line that reads the same to a person, and
      // it ran for as long as a peer was online and behind, which on a phone
      // link is exactly when the socket is worth leaving alone.
      this.interval = pending.some((device) => device.online)
        ? 1000
        : pending.length
          ? 2000
          : 10_000;
      this.say(deliverySummary(answer.devices, answer.thisDevice, cursor));
    } catch {
      this.interval = 2000;
      if (this.listeners.size && revision === this.revision)
        this.say("Device delivery unavailable.");
    } finally {
      this.request = undefined;
    }
  }
}
