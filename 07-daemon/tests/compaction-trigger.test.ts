/**
 * Mid-session compaction trigger detector.
 *
 * Strict cold-restart spec: trigger at >= 75% context fill, never
 * mid-sentence (the supervisor only calls this at end-of-turn). The
 * detector is pure so we can hammer the edges without standing up a
 * Lex session.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPACTION_RATIO,
  shouldTriggerCompaction,
} from '../src/lex/compaction-trigger.js';

describe('shouldTriggerCompaction', () => {
  it('does not fire below the default 75% threshold', () => {
    const r = shouldTriggerCompaction({
      contextTokens: 100_000,
      modelMaxTokens: 200_000,
    });
    expect(r.compactionDue).toBe(false);
    expect(r.reason).toBe('under-threshold');
    expect(r.observedRatio).toBeCloseTo(0.5, 2);
    expect(r.thresholdRatio).toBe(DEFAULT_COMPACTION_RATIO);
  });

  it('fires exactly at the 75% boundary', () => {
    const r = shouldTriggerCompaction({
      contextTokens: 150_000,
      modelMaxTokens: 200_000,
    });
    expect(r.compactionDue).toBe(true);
    expect(r.reason).toBe('over-threshold');
    expect(r.observedRatio).toBeCloseTo(0.75, 2);
  });

  it('fires comfortably past the threshold and clamps the observed ratio at 1', () => {
    const r = shouldTriggerCompaction({
      contextTokens: 250_000,
      modelMaxTokens: 200_000,
    });
    expect(r.compactionDue).toBe(true);
    expect(r.observedRatio).toBe(1);
  });

  it('honours a caller-supplied threshold ratio', () => {
    const r = shouldTriggerCompaction({
      contextTokens: 100_000,
      modelMaxTokens: 200_000,
      ratio: 0.4,
    });
    expect(r.compactionDue).toBe(true);
    expect(r.thresholdRatio).toBe(0.4);
  });

  it('rejects invalid inputs (negative tokens, zero max, ratio out of range, NaN)', () => {
    expect(
      shouldTriggerCompaction({
        contextTokens: -1,
        modelMaxTokens: 200_000,
      }).reason,
    ).toBe('invalid-input');
    expect(
      shouldTriggerCompaction({
        contextTokens: 100,
        modelMaxTokens: 0,
      }).reason,
    ).toBe('invalid-input');
    expect(
      shouldTriggerCompaction({
        contextTokens: 100,
        modelMaxTokens: 200_000,
        ratio: 1.5,
      }).reason,
    ).toBe('invalid-input');
    expect(
      shouldTriggerCompaction({
        contextTokens: Number.NaN,
        modelMaxTokens: 200_000,
      }).reason,
    ).toBe('invalid-input');
  });

  it('always returns compactionDue=false for invalid inputs', () => {
    const r = shouldTriggerCompaction({
      contextTokens: Number.POSITIVE_INFINITY,
      modelMaxTokens: 200_000,
    });
    expect(r.compactionDue).toBe(false);
  });
});
