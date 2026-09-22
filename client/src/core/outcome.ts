/**
 * What a pass came to, in one vocabulary both shells speak (I04).
 *
 * The report has always carried the facts. What it did not carry was a
 * conclusion, so every consumer drew its own: the CLI's exit code counted
 * three fields, the panel's glyph counted a different two, the JSON output
 * had no conclusion at all, and a restore decided "sent" from a promise that
 * had resolved. Four readings of one pass, each defensible on its own and
 * none of them the same, which is how `ok: true` and exit 1 ended up on the
 * same command (F26) and how a queued upload was reported as sent (F15).
 *
 * Six outcomes, ordered worst first, because a pass can be several of these
 * at once and something has to decide which one a person is told about. The
 * order is by what it costs to be wrong about: a connection that is not there
 * hides everything else, a pass that did not finish says nothing about the
 * files in it, a path that will be retried is temporary, a path that is
 * refused is not, a conflict is work that succeeded and needs a person, and
 * synchronised is the absence of all of them.
 *
 * Deliberately not an error type. A conflict is not a failure, and neither is
 * a retry; collapsing them into "something went wrong" is what the counters
 * were separated to prevent.
 */

import type { SyncReport } from "./engine.ts";

export type Outcome =
  /** No connection, so nothing about the vault is known. */
  | { readonly kind: "offline"; readonly why: string }
  /** Connected, and the pass itself did not finish. No per-path detail. */
  | { readonly kind: "passFailed"; readonly why: string }
  /** Named paths this device will try again on its own. */
  | { readonly kind: "retrying"; readonly paths: readonly string[] }
  /** Named paths that will not succeed without somebody doing something. */
  | { readonly kind: "refused"; readonly paths: readonly string[] }
  /**
   * The pass finished, and this device cannot say what is waiting to be
   * recovered (RR5).
   *
   * Its own kind rather than a flag on `synced`, because the whole point is
   * that it is not synced as far as anybody can tell: a note may be sitting
   * where no listing shows it. `status` worked this out for itself and `sync`
   * did not, so one exited 1 and the other exited 0 on the same vault, which
   * is two commands disagreeing about one fact and exactly what this shared
   * vocabulary exists to stop.
   */
  | { readonly kind: "recoveryUnknown"; readonly why: string }
  /** Preserved versions remain at hidden paths until somebody recovers them. */
  | { readonly kind: "recoveryNeeded"; readonly paths: readonly string[] }
  /** Both versions of something are on this disk, waiting to be looked at. */
  | { readonly kind: "conflicted"; readonly count: number }
  /** Everything this device knows about is where it should be. */
  | { readonly kind: "synced" };

/**
 * The conclusion of one pass.
 *
 * `failure` is what `Client.sync` caught, when it caught something: a pass
 * that threw has no report worth reading, and a report from a pass that never
 * finished would be a partial count read as a total.
 */
export function outcomeOf(
  report: SyncReport | undefined,
  failure?: { readonly offline?: boolean; readonly why: string },
  /**
   * What the adapter could establish about versions it displaced and could not
   * place, when it can establish anything (RR5).
   *
   * Optional, because an adapter that cannot strand a version has no opinion,
   * and absent is not the same as incomplete.
   */
  recovery?: {
    readonly complete: boolean;
    readonly why?: string;
    readonly waiting?: readonly { readonly at: string }[];
  },
  /** An adapter can discover retained versions that predate its ledger. */
  stranded: readonly string[] = [],
): Outcome {
  if (failure !== undefined) {
    return failure.offline === true
      ? { kind: "offline", why: failure.why }
      : { kind: "passFailed", why: failure.why };
  }
  if (report === undefined) {
    return { kind: "passFailed", why: "the pass did not report a result" };
  }
  // Retrying before refused, because a path that will be tried again is the
  // one a person should wait on rather than act on, and telling them to go and
  // fix something while the vault is about to fix itself is the worse mistake.
  if (report.retrying > 0) return { kind: "retrying", paths: report.retryingPaths };
  // `blocked` belongs here rather than with retrying: a name that is a file on
  // one device and a folder on another never resolves itself.
  if (report.skipped > 0 || report.blocked > 0) {
    return {
      kind: "refused",
      paths: [...report.skippedPaths, ...report.inTheWay.map((t) => t.path)],
    };
  }
  // After the four that name something to do, and before the two that exit
  // zero. It has to beat `conflicted`, which is an ordinary outcome of using
  // two devices and reports success: a vault with both a conflict copy and an
  // unreadable recovery record must not come back as a clean pass.
  if (recovery !== undefined && !recovery.complete) {
    return {
      kind: "recoveryUnknown",
      why: recovery.why ?? "what is waiting to be recovered could not be established",
    };
  }
  const hidden = [...new Set([...stranded, ...(recovery?.waiting ?? []).map((entry) => entry.at)])];
  if (hidden.length > 0) return { kind: "recoveryNeeded", paths: hidden };
  if (report.conflicted > 0) return { kind: "conflicted", count: report.conflicted };
  return { kind: "synced" };
}

/**
 * The exit status for an outcome, and the whole of the contract.
 *
 * Two values, not six. A shell script asks "did this finish", and a code per
 * outcome would make every caller enumerate them to answer that; the outcome
 * itself is in the JSON for anything that wants more. Documented in
 * client/README.md, because an exit code nobody wrote down is one nobody can
 * depend on.
 *
 * A conflict is zero. Both versions are on the disk, which is the engine doing
 * its job, and a cron job that treated it as a failure would alert on ordinary
 * use of two devices.
 */
export function exitCodeOf(outcome: Outcome): number {
  switch (outcome.kind) {
    case "offline":
    case "passFailed":
    case "retrying":
    case "refused":
    case "recoveryUnknown":
    case "recoveryNeeded":
      return 1;
    case "conflicted":
    case "synced":
      return 0;
  }
}

/** One line for a person, in the words each outcome deserves. */
export function describeOutcome(outcome: Outcome): string {
  switch (outcome.kind) {
    case "offline":
      return `cannot reach the server: ${outcome.why}`;
    case "passFailed":
      return `the pass did not finish: ${outcome.why}`;
    case "retrying":
      return outcome.paths.length === 0
        ? "some files could not be sent yet, and will be tried again"
        : `${outcome.paths.length} not sent yet, and will be tried again: ${outcome.paths.join(", ")}`;
    case "refused":
      return outcome.paths.length === 0
        ? "some files need a person before they can sync"
        : `${outcome.paths.length} need a person: ${outcome.paths.join(", ")}`;
    case "recoveryUnknown":
      return `everything sent and received, but ${outcome.why}, so a version may be waiting where nothing lists it`;
    case "recoveryNeeded":
      return outcome.paths.length === 1
        ? "1 preserved version needs recovery"
        : `${outcome.paths.length} preserved versions need recovery`;
    case "conflicted":
      return `${outcome.count} kept both versions, which are both on this device`;
    case "synced":
      return "everything is where it should be";
  }
}
