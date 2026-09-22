/**
 * Replacing a vault's secret, as one state machine both shells run (I02).
 *
 * The CLI and the plugin each had their own copy of this: the same generate,
 * the same request, the same probe, the same three-way reading of what came
 * back. Two copies of a decision about a credential is where the two surfaces
 * drift, and they had: the CLI printed the candidate key before the request
 * and the plugin returned it afterwards, so a lost reply cost the plugin
 * nothing and cost the CLI the vault (F03).
 *
 * What is shared is the part with a right answer. What is not shared is how
 * either surface tells somebody: a panel puts the key on screen and a terminal
 * prints it, and neither belongs in here.
 *
 * ## The obligation this carries, so no caller has to remember it
 *
 * The server commits, closes every other registrar and only then replies. A
 * socket that drops in between leaves a vault whose new root exists nowhere
 * but in this process, and there is nowhere on a device to stage a root
 * because not holding one is the point. So the durable copy is the one on the
 * person's paper, and `onCandidate` is called *before* the request goes out.
 * It is not optional and it is not a notification: it is the step that makes
 * the rest survivable, and everything after it is allowed to fail.
 */

import { ProtocolError } from "./transport.ts";
import { Registrar } from "./client.ts";
import { formatPairing, parsePairing } from "./pairing.ts";
import { generateSecret } from "./crypto.ts";

/** Where a vault's secret is being replaced from and to. */
export interface RotationRequest {
  readonly url: string;
  readonly vaultId: string;
  readonly device: string;
  /** The vault's current recovery key, which no device holds. */
  readonly recoveryKey: string;
  /** This device's copy of the data key, which rotation rewraps and never changes. */
  readonly dataKey: Uint8Array;
  readonly timeoutMs?: number | undefined;
}

/**
 * What became of it, and what the caller must do about each.
 *
 * `unknown` is the one that matters and the one a boolean cannot express. The
 * reply was lost and the probe could not reach the server, so the vault may or
 * may not have the new secret, and the only safe advice is to keep both keys.
 * A surface that flattened this into success or failure would tell somebody to
 * cross out the key that opens their vault.
 */
export type Rotation =
  /**
   * The server took it. The new key is the vault's.
   *
   * `confirmedBy` is how that is known, and the two are not the same news. A
   * reply is the ordinary case. A probe means the reply was lost and this
   * asked afterwards, which is worth saying out loud: somebody watching a
   * command appear to fail and then succeed deserves to know the key they
   * were shown is the live one.
   */
  | {
      readonly kind: "committed";
      readonly recoveryKey: string;
      readonly confirmedBy: "reply" | "probe";
    }
  /** Somebody rotated first. Nothing committed and the candidate is not the vault's. */
  | { readonly kind: "refused"; readonly why: string }
  /** Answered, and it did not commit. The old key still opens the vault. */
  | { readonly kind: "notCommitted"; readonly why: string }
  /** No answer and no way to find out. Both keys are live until one is tried. */
  | { readonly kind: "unknown"; readonly recoveryKey: string; readonly why: string };

/**
 * Runs a rotation and reports which of the four happened.
 *
 * `onCandidate` is called with the new recovery key before anything is sent,
 * and its promise is awaited: a surface that writes it somewhere durable gets
 * to finish doing so before the vault can change under it.
 */
export async function rotateVault(
  req: RotationRequest,
  onCandidate: (recoveryKey: string) => void | Promise<void>,
): Promise<Rotation> {
  const old = parsePairing(req.recoveryKey);
  if (old.vaultId !== req.vaultId) {
    throw new Error(
      `that recovery key is for vault "${old.vaultId}" and this one is paired with ` +
        `"${req.vaultId}", so it would replace the secret of a vault this device is not on`,
    );
  }

  const secret = generateSecret();
  const recoveryKey = formatPairing({ url: req.url, vaultId: req.vaultId, secret });
  // Before the request, and awaited. See the note at the top of this file:
  // this is the whole of the durability, not a notification about it.
  await onCandidate(recoveryKey);

  const registrar = await Registrar.open({
    url: req.url,
    vaultId: req.vaultId,
    device: req.device,
    secret: old.secret,
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
  });
  try {
    await registrar.rotate(secret, req.dataKey);
  } catch (err) {
    registrar.close();
    if (err instanceof ProtocolError && err.code === "rotated") {
      // Answered, and refused: somebody rotated first, so nothing committed
      // and the candidate is not the vault's. Said plainly, because a key that
      // opens nothing written down in place of one that does is worse than
      // either on its own.
      return {
        kind: "refused",
        why:
          "the vault was rotated by somebody else first, so this rotation was refused and the " +
          "key above is not the vault's. Cross it out. The recovery key you used has been " +
          "retired too.",
      };
    }
    // No reply, and nothing here can tell a rotation that committed from one
    // that did not. So ask: the new root opens a registrar session if and only
    // if the server took it.
    const committed = await didRotate(req, secret).catch(() => undefined);
    if (committed === true) return { kind: "committed", recoveryKey, confirmedBy: "probe" };
    if (committed === false) {
      return {
        kind: "notCommitted",
        why: `the rotation was not answered and did not commit: ${(err as Error).message}`,
      };
    }
    return {
      kind: "unknown",
      recoveryKey,
      why:
        `the rotation was not answered and the server could not be reached to find out whether ` +
        `it committed: ${(err as Error).message}`,
    };
  }
  registrar.close();
  return { kind: "committed", recoveryKey, confirmedBy: "reply" };
}

/**
 * Whether a root secret opens this vault, which is whether a rotation to it
 * committed.
 *
 * Only `auth` says "this is not the vault's credential". Anything else is the
 * network or the server, and answering "it did not commit" to those would have
 * somebody cross out the key that opens their vault.
 */
async function didRotate(req: RotationRequest, secret: Uint8Array): Promise<boolean> {
  try {
    const probe = await Registrar.open({
      url: req.url,
      vaultId: req.vaultId,
      device: req.device,
      secret,
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    });
    probe.close();
    return true;
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "auth") return false;
    throw err;
  }
}
