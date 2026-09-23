/**
 * Joining a vault with an invite, end to end: `pairWithInvite` against the
 * real server (plan/protocol.md, "Invite redemption").
 *
 * The order is the design. The joining device makes its id and token and saves
 * them, with the invite, as a pending pairing before a byte goes to the server;
 * `redeemed` replaces that with the finished device, which holds no invite; a
 * refusal, or a server never reached, removes it, so nothing is left saved; and
 * a reply that never came keeps it, because the server may have committed, and
 * the same id and token are answered `redeemed` again if it did, even after the
 * invite has expired. Every case below says what was on disk at each moment, by
 * recording each save and forget in one sequence with what crossed the wire.
 *
 * Also here, from files deleted with the encryption: `invite.test.ts`, whose
 * device-issued invite now carries a token instead of a sealed data key, and
 * `rotation.test.ts`'s one surviving check, a reply naming another device.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  Client,
  PairingInterrupted,
  credentialsFor,
  pairWithInvite,
  type PairingStore,
} from "./client.ts";
import { base64urlEncode, randomBytes } from "./digest.ts";
import { FakeSocket, settle } from "./fake-socket.ts";
import type { InviteString } from "./invite-string.ts";
import {
  finishedPairing,
  isPendingPairing,
  parseInvite,
  startPairing,
  type DeviceConfig,
  type PendingPairing,
} from "./pairing.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { ConnectionError, ProtocolError, type SocketLike } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer | undefined;
const open: Client[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  if (server) await server.cleanup();
  server = undefined;
});

type Frame = Record<string, unknown>;
type Event =
  | { readonly kind: "save"; readonly config: DeviceConfig }
  | { readonly kind: "forget" }
  | { readonly kind: "connect" }
  | { readonly kind: "send"; readonly frame: Frame }
  | { readonly kind: "receive"; readonly frame: Frame }
  | { readonly kind: "dropped"; readonly frame: Frame };

/** Frames a wire should keep from where they were going, and then hang up. */
interface Drops {
  /** A frame from the server that never reaches the device. */
  readonly incoming?: (frame: Frame) => boolean;
  /** A frame from the device that never reaches the server. */
  readonly outgoing?: (frame: Frame) => boolean;
}

/**
 * One sequence of what the device saved, forgot, sent and heard, and the
 * `PairingStore` and socket factory that write it.
 *
 * The store holds what a disk would: a copy of the last config saved, or
 * nothing after a forget, so `held` is what a shell would find on restart.
 */
class Recorder {
  readonly events: Event[] = [];
  held: DeviceConfig | undefined;

  readonly store: PairingStore = {
    save: async (config) => {
      const copy = JSON.parse(JSON.stringify(config)) as DeviceConfig;
      this.events.push({ kind: "save", config: copy });
      this.held = copy;
    },
    forget: async () => {
      this.events.push({ kind: "forget" });
      this.held = undefined;
    },
  };

  /** The real WebSocket, recorded, with the given frames dropped. */
  socketFactory(drops: Drops = {}): (url: string) => SocketLike {
    return (url) => {
      this.events.push({ kind: "connect" });
      return new Wire(url, this.events, drops);
    };
  }

  /** The sequence as kinds, which is the order the design is about. */
  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }

  saves(): DeviceConfig[] {
    return this.events.flatMap((e) => (e.kind === "save" ? [e.config] : []));
  }
}

/**
 * The platform's WebSocket, reporting what crosses it and able to lose one
 * frame the way a dying connection does: the frame goes nowhere, and the
 * connection closes.
 */
class Wire implements SocketLike {
  binaryType = "arraybuffer";
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  private readonly ws: WebSocket;

  constructor(
    url: string,
    private readonly events: Event[],
    private readonly drops: Drops,
  ) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = (ev) => this.onopen?.(ev);
    this.ws.onerror = (ev) => this.onerror?.(ev);
    this.ws.onclose = (ev) => this.onclose?.({ code: ev.code, reason: ev.reason });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const frame = JSON.parse(ev.data) as Frame;
        if (this.drops.incoming?.(frame)) {
          this.events.push({ kind: "dropped", frame });
          this.ws.close();
          return;
        }
        this.events.push({ kind: "receive", frame });
      }
      this.onmessage?.({ data: ev.data });
    };
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (typeof data === "string") {
      const frame = JSON.parse(data) as Frame;
      if (this.drops.outgoing?.(frame)) {
        this.events.push({ kind: "dropped", frame });
        this.ws.close();
        return;
      }
      this.events.push({ kind: "send", frame });
    }
    this.ws.send(data as string);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

/** A server with one device on it, connected, to list devices from. */
async function vaultWithADevice(): Promise<{ server: TestServer; laptop: Client }> {
  server = new TestServer();
  await server.start();
  const laptop = new Client({
    vault: new MemoryVault(),
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    vaultId: "default",
    device: "laptop",
    ...(await server.deviceCredentials("laptop")),
    timeoutMs: 15_000,
  });
  open.push(laptop);
  await laptop.connect();
  return { server, laptop };
}

/** Connects as a finished device: the proof that a credential is one. */
async function connectAs(device: DeviceConfig): Promise<Client> {
  const client = new Client({
    vault: new MemoryVault(),
    store: new MemoryIndexStore(),
    ...credentialsFor(device),
    timeoutMs: 15_000,
  });
  open.push(client);
  await client.connect();
  return client;
}

/** Waits until the wall clock has passed `when`. */
async function until(when: number): Promise<void> {
  const wait = when - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** What a pairing threw, for a case that expects it to throw. */
async function failure(pairing: Promise<unknown>): Promise<Error> {
  try {
    await pairing;
  } catch (err) {
    return err as Error;
  }
  throw new Error("the pairing was expected to fail and did not");
}

const OPTIONS = { timeoutMs: 15_000 };

describe("redeeming an invite against the real server", () => {
  it("saves the pending pairing before anything reaches the server, and the device after", async () => {
    const { server, laptop } = await vaultWithADevice();
    const invite = parseInvite(await server.invite());
    const rec = new Recorder();
    const pending = startPairing(invite, "phone");
    const device = await pairWithInvite(pending, rec.store, {
      ...OPTIONS,
      socketFactory: rec.socketFactory(),
    });

    // Saved first, then the socket, then the hello: a crash anywhere after
    // the save leaves a pairing that can be finished, never a row on the
    // server whose credential nobody holds.
    expect(rec.kinds().filter((k) => k !== "receive")).toEqual(["save", "connect", "send", "save"]);
    expect(rec.saves()[0]).toEqual(pending);
    const hello = rec.events.find((e) => e.kind === "send")!;
    expect(hello.kind === "send" && hello.frame).toMatchObject({
      op: "hello",
      vault: "default",
      device: "phone",
      invite: pending.invite,
      deviceId: pending.deviceId,
      token: pending.deviceToken,
    });
    expect(
      rec.events.some((e) => e.kind === "receive" && e.frame["res"] === "redeemed"),
      "the server never said redeemed",
    ).toBe(true);

    // `redeemed` replaced it with the finished device, which holds no invite.
    expect(device).toEqual(finishedPairing(pending));
    expect("invite" in device).toBe(false);
    expect(isPendingPairing(rec.held!)).toBe(false);
    expect(rec.held).toEqual(device);
    expect(rec.kinds()).not.toContain("forget");

    // And the credential is one: this is what a device is.
    const phone = await connectAs(device);
    expect(phone.transport.isClosed).toBe(false);
    const row = (await laptop.devices()).devices.find((d) => d.id === pending.deviceId);
    expect(row?.name).toBe("phone");
  });

  it("pairs from a paired device's invite, which names this vault and expires", async () => {
    const { server, laptop } = await vaultWithADevice();
    const before = Date.now();
    const minted = await laptop.invite();
    expect(minted.invite).toMatch(/^trew1i_/);
    const parsed = parseInvite(minted.invite);
    expect(parsed.url).toBe(server.wsUrl);
    expect(parsed.vault).toBe("default");
    // Future, and within the hour an invite lasts by default.
    expect(minted.expiresAt).toBeGreaterThan(before);
    expect(minted.expiresAt!).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

    // The id a listing names it by is not the token, and nothing listed
    // carries the token: the listing reaches every paired device.
    const token = base64urlEncode(parsed.token);
    expect(minted.id).not.toBe(token);
    const listing = await laptop.devices();
    expect(listing.invites.map((i) => i.invite)).toContain(minted.id);
    expect(JSON.stringify(listing)).not.toContain(token);

    const rec = new Recorder();
    const device = await pairWithInvite(startPairing(parsed, "phone"), rec.store, OPTIONS);
    // A row of its own, under its own id and name, which has not connected yet.
    const row = (await laptop.devices()).devices.find((d) => d.id === device.deviceId);
    expect(row, "redeeming the invite registered no device").toBeDefined();
    expect(row!.name).toBe("phone");
    expect(row!.lastSeen).toBe(0);
    expect(rec.held).toEqual(device);
    await connectAs(device);
    // Spent, so it has left the listing.
    expect((await laptop.devices()).invites.map((i) => i.invite)).not.toContain(minted.id);
  });

  /**
   * A refusal writes nothing on the server and never spends the invite, so
   * the pending pairing is removed too: nothing is left saved after a refusal.
   * One refusal for every reason, with one message, so a probe cannot tell an
   * unknown invite from a spent, cancelled or expired one.
   */
  it("forgets the pairing, and leaves nothing saved, for an invite that is spent, unknown, cancelled or expired", async () => {
    const { server, laptop } = await vaultWithADevice();

    // Spent, by a device that redeemed it first.
    const spentInvite = parseInvite(await server.invite());
    const first = await pairWithInvite(
      startPairing(spentInvite, "phone"),
      new Recorder().store,
      OPTIONS,
    );

    // Unknown: well formed, for this server and vault, and never issued.
    const unknown: InviteString = { token: randomBytes(16), url: server.wsUrl, vault: "default" };

    // Cancelled with `trewd uninvite` on the server, by the id it lists.
    const cancelled = parseInvite(await server.invite({ label: "to cancel" }));
    const listed = JSON.parse(await server.cli("devices", "-json")) as {
      invites: { invite: string; label: string }[];
    };
    const id = listed.invites.find((i) => i.label === "to cancel")?.invite;
    expect(id, "the invite to cancel is not listed").toBeDefined();
    expect(await server.cli("uninvite", id!)).toMatch(/Cancelled invite/);

    // Expired, with the shortest lifetime the command takes.
    const mintedAt = Date.now();
    const expired = parseInvite(await server.invite({ ttl: "2s" }));
    await until(mintedAt + 2_500);

    // The first redemption added one device, and only one.
    const before = (await laptop.devices()).devices;
    expect(before.map((d) => d.name).sort()).toEqual(["laptop", "phone"]);
    expect(before.map((d) => d.id)).toContain(first.deviceId);
    const devicesBefore = before.map((d) => d.id).sort();

    const messages: string[] = [];
    for (const [why, invite] of [
      ["spent", spentInvite],
      ["unknown", unknown],
      ["cancelled", cancelled],
      ["expired", expired],
    ] as const) {
      const rec = new Recorder();
      const pending = startPairing(invite, "tablet");
      const err = await failure(
        pairWithInvite(pending, rec.store, { ...OPTIONS, socketFactory: rec.socketFactory() }),
      );
      expect(err, why).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code, why).toBe("auth");
      expect(err, why).not.toBeInstanceOf(PairingInterrupted);
      expect(rec.saves(), why).toEqual([pending]);
      expect(rec.kinds().at(-1), `${why}: the pairing was not forgotten`).toBe("forget");
      expect(rec.held, `${why}: something was left saved after a refusal`).toBeUndefined();
      messages.push(err.message);
    }
    expect(new Set(messages).size, `four refusals, told apart: ${messages.join(" / ")}`).toBe(1);

    // And a refusal writes nothing: the vault holds the devices it held.
    expect((await laptop.devices()).devices.map((d) => d.id).sort()).toEqual(devicesBefore);
  });

  it("forgets the pairing when the server cannot be reached, and the invite still works", async () => {
    server = new TestServer();
    await server.start();
    const invite = parseInvite(await server.invite());
    const port = server.port;
    await server.stop();

    const rec = new Recorder();
    const err = await failure(
      pairWithInvite(startPairing(invite, "phone"), rec.store, {
        timeoutMs: 5_000,
        socketFactory: rec.socketFactory(),
      }),
    );
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err, "a connection that never opened was taken for a lost reply").not.toBeInstanceOf(
      PairingInterrupted,
    );
    // It tried, sent nothing, and removed what it saved.
    expect(rec.kinds()).toEqual(["save", "connect", "forget"]);
    expect(rec.held).toBeUndefined();

    // Nothing was sent, so nothing was spent: back up, the same invite pairs.
    await server.start(port);
    const again = new Recorder();
    const device = await pairWithInvite(startPairing(invite, "phone"), again.store, OPTIONS);
    await connectAs(device);
    expect(again.held).toEqual(device);
  });
});

/**
 * A reply that never came: the connection closed after the redemption went
 * out. Whether the server committed is exactly what the device does not know,
 * so it keeps the pending pairing, and retrying with the same id and token
 * settles it either way (plan/protocol.md, "Invite redemption", step 2).
 */
describe("a redemption whose reply was lost", () => {
  /** Pairs with the `redeemed` reply kept from the device: committed, unheard. */
  async function lostAfterCommit(invite: InviteString) {
    const rec = new Recorder();
    const pending = startPairing(invite, "phone");
    const err = await failure(
      pairWithInvite(pending, rec.store, {
        ...OPTIONS,
        socketFactory: rec.socketFactory({ incoming: (f) => f["res"] === "redeemed" }),
      }),
    );
    expect(err).toBeInstanceOf(PairingInterrupted);
    expect((err as PairingInterrupted).pending).toEqual(pending);
    // The server said redeemed and the device never heard it.
    expect(rec.events.some((e) => e.kind === "dropped" && e.frame["res"] === "redeemed")).toBe(
      true,
    );
    // Kept, exactly: no forget, and no finished device saved over it.
    expect(rec.kinds()).not.toContain("forget");
    expect(rec.saves()).toEqual([pending]);
    expect(rec.held).toEqual(pending);
    return { rec, pending };
  }

  it("keeps the pairing when the server committed, and the retry is answered redeemed", async () => {
    const { server, laptop } = await vaultWithADevice();
    const { rec, pending } = await lostAfterCommit(parseInvite(await server.invite()));
    // It did commit: the row is there, under the id the device holds.
    expect((await laptop.devices()).devices.map((d) => d.id)).toContain(pending.deviceId);

    const kept = rec.held as PendingPairing;
    const device = await pairWithInvite(kept, rec.store, OPTIONS);
    expect(device.deviceId).toBe(pending.deviceId);
    expect(device.deviceToken).toBe(pending.deviceToken);
    expect(rec.held).toEqual(finishedPairing(pending));
    // One row for the one device, not a second from the retry.
    expect((await laptop.devices()).devices.filter((d) => d.name === "phone")).toHaveLength(1);
    await connectAs(device);
  });

  it("is answered redeemed on retry even after the invite has expired in between", async () => {
    const { server, laptop } = await vaultWithADevice();
    const mintedAt = Date.now();
    const invite = parseInvite(await server.invite({ ttl: "2s" }));
    const { rec, pending } = await lostAfterCommit(invite);
    await until(mintedAt + 2_500);

    // The invite itself no longer works: a fresh pairing from it is refused.
    const stranger = new Recorder();
    const refused = await failure(
      pairWithInvite(startPairing(invite, "tablet"), stranger.store, OPTIONS),
    );
    expect((refused as ProtocolError).code).toBe("auth");
    expect(stranger.held).toBeUndefined();

    // The retry is not a fresh pairing: the redemption it repeats did not
    // expire, and the same id and token are recognised as that one.
    const device = await pairWithInvite(rec.held as PendingPairing, rec.store, OPTIONS);
    expect(device).toEqual(finishedPairing(pending));
    expect(rec.held).toEqual(device);
    expect((await laptop.devices()).devices.filter((d) => d.name === "phone")).toHaveLength(1);
    await connectAs(device);
  });

  /** Pairs with the hello kept from the server: sent, never received. */
  async function lostBeforeCommit(invite: InviteString) {
    const rec = new Recorder();
    const pending = startPairing(invite, "phone");
    const err = await failure(
      pairWithInvite(pending, rec.store, {
        ...OPTIONS,
        socketFactory: rec.socketFactory({ outgoing: (f) => f["op"] === "hello" }),
      }),
    );
    // To the device this is the same as a reply lost after a commit: the
    // connection opened, the redemption went, and nothing came back.
    expect(err).toBeInstanceOf(PairingInterrupted);
    expect(rec.kinds()).toEqual(["save", "connect", "dropped"]);
    expect(rec.held).toEqual(pending);
    return { rec, pending };
  }

  it("keeps the pairing when the server never saw it, and the retry redeems while the invite works", async () => {
    const { server, laptop } = await vaultWithADevice();
    const { rec, pending } = await lostBeforeCommit(
      parseInvite(await server.invite({ label: "for the phone" })),
    );
    // Nothing was committed: no row, and the invite is still outstanding.
    // By its label, since the one serve wrote for a first device is too.
    const outstanding = async () =>
      (await laptop.devices()).invites.some((i) => i.label === "for the phone");
    const listing = await laptop.devices();
    expect(listing.devices.map((d) => d.id)).not.toContain(pending.deviceId);
    expect(await outstanding(), "the invite was spent by a hello that never arrived").toBe(true);

    const device = await pairWithInvite(rec.held as PendingPairing, rec.store, OPTIONS);
    expect(device).toEqual(finishedPairing(pending));
    expect(rec.held).toEqual(device);
    expect(await outstanding(), "the retry did not spend the invite").toBe(false);
    await connectAs(device);
  });

  it("keeps the pairing when the server never saw it, and the retry is refused once the invite stopped working", async () => {
    const { server, laptop } = await vaultWithADevice();
    const mintedAt = Date.now();
    const { rec, pending } = await lostBeforeCommit(
      parseInvite(await server.invite({ ttl: "2s" })),
    );
    await until(mintedAt + 2_500);

    // Nothing to recognise and nothing left to redeem: refused, and so the
    // pairing is forgotten, as after any refusal.
    const err = await failure(pairWithInvite(rec.held as PendingPairing, rec.store, OPTIONS));
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe("auth");
    expect(rec.kinds().at(-1)).toBe("forget");
    expect(rec.held).toBeUndefined();
    expect((await laptop.devices()).devices.map((d) => d.id)).not.toContain(pending.deviceId);
  });
});

/**
 * Guarantee 16 in plan/strip-ledger.md: the reply names the row the server
 * wrote, and a device keeping a credential for a row that is not its own is
 * refused at every hello from then on with nothing to say why. Only a lying or
 * broken server sends this, so it is a fake one.
 */
describe("a redeemed reply naming another device", () => {
  it("is refused before any credential is kept", async () => {
    const socket = new FakeSocket();
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "hello") s.reply({ res: "redeemed", deviceId: "somebody-else" });
    };
    const rec = new Recorder();
    const pending = startPairing(
      { token: new Uint8Array(16).fill(3), url: "ws://test", vault: "v" },
      "phone",
    );
    const pairing = pairWithInvite(pending, rec.store, {
      timeoutMs: 2000,
      socketFactory: () => socket,
    });
    for (let i = 0; i < 200 && socket.onopen === null; i++) await settle();
    socket.open();

    const err = await failure(pairing);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe("protostate");
    expect(err.message).toContain(
      `a redeemed naming device "somebody-else", which is not the ${JSON.stringify(pending.deviceId)}`,
    );
    // The hello went out asking for this device's own row.
    expect(socket.sentText.find((m) => m["op"] === "hello")?.["deviceId"]).toBe(pending.deviceId);
    // Nothing kept: the pending pairing is gone, and no finished device was
    // ever saved.
    expect(rec.kinds()).toEqual(["save", "forget"]);
    expect(rec.saves().every((c) => isPendingPairing(c))).toBe(true);
    expect(rec.held).toBeUndefined();
  });
});
