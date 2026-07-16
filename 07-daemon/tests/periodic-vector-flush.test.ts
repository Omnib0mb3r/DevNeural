/**
 * Periodic vector-store flush (2026-07-16 operator audit).
 *
 * The vector stores only flushed on shutdown, on the backup /flush
 * handshake, and on signal-coalescer passes - so /system diagnostics
 * showed raw_chunks "dirty" for unbounded stretches during active
 * capture and the operator read it as a fault. This safety net
 * bounds the unsaved window: a dirty-gated tick that flushes at most
 * every interval and never throws.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  periodicFlushTick,
  startPeriodicVectorFlush,
  DEFAULT_VECTOR_FLUSH_INTERVAL_MS,
} from '../src/store/periodic-flush.js';

describe('periodicFlushTick', () => {
  it('flushes when the store reports dirty', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const r = await periodicFlushTick({ isDirty: () => true, flush });
    expect(r).toBe('flushed');
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('skips when everything is clean', async () => {
    const flush = vi.fn();
    const r = await periodicFlushTick({ isDirty: () => false, flush });
    expect(r).toBe('clean');
    expect(flush).not.toHaveBeenCalled();
  });

  it('never throws: a failing flush resolves failed and logs', async () => {
    const logs: string[] = [];
    const r = await periodicFlushTick({
      isDirty: () => true,
      flush: async () => {
        throw new Error('disk full');
      },
      log: (m) => logs.push(m),
    });
    expect(r).toBe('failed');
    expect(logs.join(' ')).toContain('disk full');
  });

  it('never throws: a throwing isDirty resolves failed', async () => {
    const r = await periodicFlushTick({
      isDirty: () => {
        throw new Error('stats broke');
      },
      flush: async () => undefined,
    });
    expect(r).toBe('failed');
  });
});

describe('startPeriodicVectorFlush', () => {
  it('ticks on the interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn().mockResolvedValue(undefined);
      const stop = startPeriodicVectorFlush(
        { isDirty: () => true, flush },
        1_000,
      );
      await vi.advanceTimersByTimeAsync(3_100);
      expect(flush.mock.calls.length).toBeGreaterThanOrEqual(3);
      stop();
      const calls = flush.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(flush.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('default interval bounds the unsaved window to five minutes', () => {
    expect(DEFAULT_VECTOR_FLUSH_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
