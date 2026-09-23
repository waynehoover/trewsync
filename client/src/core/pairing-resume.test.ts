/**
 * Finishing a pairing that is already pending (plan/protocol.md, "Invite
 * redemption": on a lost reply the client keeps the pending pairing and retries
 * with the same `deviceId` and `token`).
 *
 * A first attempt that never reached the server, or that the server refused,
 * has registered nothing, and leaves nothing saved (redemption.test.ts). A
 * resume is different: an earlier attempt with this very pairing may have been
 * committed with its answer lost, so only a refusal no retry changes may remove
 * it. A server that cannot be reached, or that answers `busy` or `internal`,
 * says nothing about whether the row exists, and forgetting then throws away
 * the only copy of a credential the server may hold, for an invite that is now
 * spent.
 */

import { describe, expect, it } from "vitest";

import { PairingInterrupted, pairWithInvite, type PairingStore } from "./client.ts";
import { FakeSocket } from "./fake-socket.ts";
import { generateDeviceId, generateDeviceToken, type DeviceConfig } from "./pairing.ts";
import { ConnectionError, ProtocolError } from "./transport.ts";

/** A pending pairing, as a shell finds it on disk. */
function pendingAt(url: string) {
  return {
    url,
    vaultId: "default",
    device: "phone",
    invite: "AAAAAAAAAAAAAAAAAAAAAA",
    deviceId: generateDeviceId(),
    deviceToken: generateDeviceToken(),
  };
}

/** A store that records what was done to it, in order. */
function recording(): { store: PairingStore; log: string[]; saved: DeviceConfig[] } {
  const log: string[] = [];
  const saved: DeviceConfig[] = [];
  return {
    log,
    saved,
    store: {
      save: async (config) => {
        log.push("invite" in config ? "save pending" : "save device");
        saved.push(config);
      },
      forget: async () => {
        log.push("forget");
      },
    },
  };
}

/** A socket that opens, and answers the hello with `frame`. */
function answering(frame: Record<string, unknown>): FakeSocket {
  const socket = new FakeSocket();
  socket.autoReply = (sent, s) => {
    if (sent["op"] === "hello") s.reply(frame);
  };
  setTimeout(() => socket.open(), 0);
  return socket;
}

/** A socket that never opens: the server is not there. */
function unreachable(): FakeSocket {
  const socket = new FakeSocket();
  setTimeout(() => socket.onerror?.(undefined), 0);
  return socket;
}

const busy = { res: "err", code: "busy", msg: "shutting down", retryable: true };
const internal = { res: "err", code: "internal", msg: "disk trouble", retryable: true };
const auth = { res: "err", code: "auth", msg: "that invite does not open this vault" };

describe("finishing a pending pairing", () => {
  it("keeps it when the server cannot be reached", async () => {
    const pending = pendingAt("ws://resume.test");
    const { store, log } = recording();
    const attempt = pairWithInvite(pending, store, {
      resuming: true,
      socketFactory: () => unreachable(),
      timeoutMs: 2000,
    });
    await expect(attempt).rejects.toBeInstanceOf(PairingInterrupted);
    await expect(attempt).rejects.toBeInstanceOf(ConnectionError);
    expect(log, "an earlier attempt may have registered this row").toEqual(["save pending"]);
  });

  for (const [code, frame] of [
    ["busy", busy],
    ["internal", internal],
  ] as const) {
    it(`keeps it when the server answers ${code}`, async () => {
      const pending = pendingAt("ws://resume.test");
      const { store, log } = recording();
      const attempt = pairWithInvite(pending, store, {
        resuming: true,
        socketFactory: () => answering(frame),
        timeoutMs: 2000,
      });
      const err = await attempt.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PairingInterrupted);
      expect((err as PairingInterrupted).pending.deviceId).toBe(pending.deviceId);
      expect((err as Error).message).toContain(code === "busy" ? "shutting down" : "disk trouble");
      expect(log).toEqual(["save pending"]);
    });
  }

  it("removes it when the server refuses it for good", async () => {
    const pending = pendingAt("ws://resume.test");
    const { store, log } = recording();
    const attempt = pairWithInvite(pending, store, {
      resuming: true,
      socketFactory: () => answering(auth),
      timeoutMs: 2000,
    });
    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe("auth");
    expect(log, "no retry changes an auth refusal, and it writes nothing").toEqual([
      "save pending",
      "forget",
    ]);
  });
});

describe("a first attempt", () => {
  it("still leaves nothing saved when the server was never reached", async () => {
    const pending = pendingAt("ws://first.test");
    const { store, log } = recording();
    const attempt = pairWithInvite(pending, store, {
      socketFactory: () => unreachable(),
      timeoutMs: 2000,
    });
    await expect(attempt).rejects.toBeInstanceOf(ConnectionError);
    await expect(attempt).rejects.not.toBeInstanceOf(PairingInterrupted);
    expect(log, "nothing was sent, so nothing can have committed").toEqual([
      "save pending",
      "forget",
    ]);
  });

  it("keeps it when the server answers busy, so the pairing can be finished later", async () => {
    const pending = pendingAt("ws://first.test");
    const { store, log } = recording();
    const attempt = pairWithInvite(pending, store, {
      socketFactory: () => answering(busy),
      timeoutMs: 2000,
    });
    await expect(attempt).rejects.toBeInstanceOf(PairingInterrupted);
    expect(log).toEqual(["save pending"]);
  });
});
