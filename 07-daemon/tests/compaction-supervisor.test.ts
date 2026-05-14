/**
 * End-of-turn compaction supervisor.
 *
 * Pins:
 *   - under threshold: no fire, both deps untouched.
 *   - over threshold: runSessionEnd awaits BEFORE spawnRestart fires.
 *   - idempotency: the second call after a fire bucket-ins as
 *     'already-compacted' even when the signal is still hot.
 *   - restart failure surfaces as reason='restart-failed' but the
 *     state still flips so we do not stack a second attempt on top
 *     of a half-distilled session.
 *   - contextTokensFromUsage rolls input + cache_creation + cache_
 *     read into the same sum the existing context-tokens reader uses.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  contextTokensFromUsage,
  maybeCompactOnTurnEnd,
  type CompactionSupervisorState,
} from '../src/lex/compaction-supervisor.js';

function freshState(): CompactionSupervisorState {
  return { compactedAt: 0 };
}

describe('contextTokensFromUsage', () => {
  it('sums input + cache_creation + cache_read', () => {
    expect(
      contextTokensFromUsage({
        input_tokens: 1_000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 9_000,
      }),
    ).toBe(10_500);
  });

  it('returns 0 for null / undefined / missing fields', () => {
    expect(contextTokensFromUsage(null)).toBe(0);
    expect(contextTokensFromUsage(undefined)).toBe(0);
    expect(contextTokensFromUsage({})).toBe(0);
  });
});

describe('maybeCompactOnTurnEnd', () => {
  it('does not fire below the 75% threshold', async () => {
    const runSessionEnd = vi.fn(async () => undefined);
    const spawnRestart = vi.fn(async () => ({ ok: true }));
    const r = await maybeCompactOnTurnEnd(
      { contextTokens: 100_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        state: freshState(),
      },
    );
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('under-threshold');
    expect(runSessionEnd).not.toHaveBeenCalled();
    expect(spawnRestart).not.toHaveBeenCalled();
  });

  it('fires at the 75% threshold and runs session-end BEFORE spawn-restart', async () => {
    const order: string[] = [];
    const runSessionEnd = vi.fn(async () => {
      order.push('session-end');
    });
    const spawnRestart = vi.fn(async () => {
      order.push('spawn-restart');
      return { ok: true as const, new_session_id: 'cc-new' };
    });
    const state = freshState();
    const r = await maybeCompactOnTurnEnd(
      { contextTokens: 150_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        state,
      },
    );
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('fired');
    expect(r.new_session_id).toBe('cc-new');
    expect(order).toEqual(['session-end', 'spawn-restart']);
    expect(state.compactedAt).toBeGreaterThan(0);
  });

  it('flips compactedAt BEFORE awaiting session-end so a re-entrant trailing turn no-ops', async () => {
    const state = freshState();
    let captured = 0;
    const runSessionEnd = vi.fn(async () => {
      captured = state.compactedAt;
    });
    const spawnRestart = vi.fn(async () => ({ ok: true }));
    await maybeCompactOnTurnEnd(
      { contextTokens: 160_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        state,
      },
    );
    expect(captured).toBeGreaterThan(0);
  });

  it('subsequent calls return already-compacted without firing again', async () => {
    const runSessionEnd = vi.fn(async () => undefined);
    const spawnRestart = vi.fn(async () => ({ ok: true }));
    const state = freshState();
    await maybeCompactOnTurnEnd(
      { contextTokens: 200_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        state,
      },
    );
    const r = await maybeCompactOnTurnEnd(
      { contextTokens: 200_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        state,
      },
    );
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('already-compacted');
    expect(runSessionEnd).toHaveBeenCalledTimes(1);
    expect(spawnRestart).toHaveBeenCalledTimes(1);
  });

  it('surfaces restart-failed when spawnRestart returns ok=false but keeps compactedAt set', async () => {
    const state = freshState();
    const runSessionEnd = vi.fn(async () => undefined);
    const spawnRestart = vi.fn(async () => ({
      ok: false as const,
      error: 'no anchor handle',
    }));
    const r = await maybeCompactOnTurnEnd(
      { contextTokens: 160_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        state,
      },
    );
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('restart-failed');
    expect(r.error).toBe('no anchor handle');
    expect(state.compactedAt).toBeGreaterThan(0);
  });

  it('does not throw when session-end pipeline rejects; continues to spawn-restart', async () => {
    const runSessionEnd = vi.fn(async () => {
      throw new Error('distill down');
    });
    const spawnRestart = vi.fn(async () => ({
      ok: true as const,
      new_session_id: 'cc-new',
    }));
    const r = await maybeCompactOnTurnEnd(
      { contextTokens: 160_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        state: freshState(),
      },
    );
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('fired');
    expect(spawnRestart).toHaveBeenCalledTimes(1);
  });

  it('honours a caller-supplied ratio override', async () => {
    const runSessionEnd = vi.fn(async () => undefined);
    const spawnRestart = vi.fn(async () => ({ ok: true }));
    const r = await maybeCompactOnTurnEnd(
      { contextTokens: 100_000 },
      {
        runSessionEnd,
        spawnRestart,
        modelMaxTokens: 200_000,
        ratio: 0.4,
        state: freshState(),
      },
    );
    expect(r.fired).toBe(true);
  });
});
