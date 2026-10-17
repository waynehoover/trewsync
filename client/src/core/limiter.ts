/**
 * A counting gate: at most `limit` calls are inside `fn` at once.
 *
 * Waiters are a queue rather than a poll, so nothing spins and the order they
 * were asked in is the order they run in. A rejection releases the slot the
 * same as a return does, which matters because a caller may let the first
 * failure end its work and the rest of the workers have to be able to finish.
 */
export function limiter(limit: number): <R>(fn: () => Promise<R>) => Promise<R> {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    running--;
    waiting.shift()?.();
  };
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (running >= limit) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
