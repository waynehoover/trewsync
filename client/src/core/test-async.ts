import type { Transport } from "./transport.ts";

/** Let queued microtasks run while an explicit test gate remains closed. */
export const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** An explicit handoff for tests that hold an operation inside a race window. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * Call after a peer's write has been acknowledged. Its broadcast is already
 * queued ahead of this pong; then wait for metadata authentication to finish.
 */
export async function receiveCommitted(transport: Transport): Promise<void> {
  await transport.ping();
  await transport.drainReceived();
}

/** A failure deadline, cancelled as soon as the observed operation finishes. */
export async function within<T>(work: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
