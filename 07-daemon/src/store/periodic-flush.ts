/* Periodic vector-store flush safety net (2026-07-16 operator audit).
 *
 * The vector stores flushed only on shutdown, on the backup /flush
 * handshake, and on signal-coalescer passes. During active capture
 * the /system diagnostics therefore showed raw_chunks "dirty" for
 * unbounded stretches, which reads as a fault ("why does brain
 * diagnostic show dirty and why isn't that fixed"). Dirty is normal -
 * it means in-memory vectors not yet rewritten to the .vec snapshot
 * (the append-only meta sidecar already gives between-flush
 * durability) - but the unsaved window should be BOUNDED, not
 * open-ended. This tick flushes at most once per interval, only when
 * something is actually dirty, and never throws.
 */

export const DEFAULT_VECTOR_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export interface PeriodicFlushDeps {
  /** True when any vector store has unflushed writes. */
  isDirty: () => boolean;
  /** Flush all stores (Store.flush). */
  flush: () => Promise<void>;
  log?: (msg: string) => void;
}

export async function periodicFlushTick(
  deps: PeriodicFlushDeps,
): Promise<'flushed' | 'clean' | 'failed'> {
  try {
    if (!deps.isDirty()) return 'clean';
    await deps.flush();
    deps.log?.('[vector-flush] periodic flush completed (dirty -> clean)');
    return 'flushed';
  } catch (err) {
    deps.log?.(
      `[vector-flush] periodic flush failed: ${(err as Error).message}`,
    );
    return 'failed';
  }
}

/** Start the interval; returns a stop function. The timer is unref'd
 * so it can never hold the daemon open during shutdown. */
export function startPeriodicVectorFlush(
  deps: PeriodicFlushDeps,
  intervalMs: number = DEFAULT_VECTOR_FLUSH_INTERVAL_MS,
): () => void {
  const t = setInterval(() => {
    void periodicFlushTick(deps);
  }, intervalMs);
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    (t as unknown as { unref: () => void }).unref();
  }
  return () => clearInterval(t);
}
