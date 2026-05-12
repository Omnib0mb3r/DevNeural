/**
 * Smart-compact evaluator (SMART-COMPACT.md trigger logic).
 *
 * Pure function: given a snapshot (ctx_pct, last commit / tool / phase),
 * decide whether to fire compact, inject a wrap-and-commit prompt, or
 * wait. Reasons map to the audit log vocab.
 */
import { describe, expect, it } from 'vitest';
import { evaluateTrigger } from '../src/lex/smart-compact.js';

const BASE = {
  threshold: 60,
  bandHalf: 5,
  hardCeiling: 90,
  stopWindowMs: 30_000,
  now: 1_000_000,
};

describe('evaluateTrigger', () => {
  it('returns wait when ctx_pct is below the window', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 40,
      lastCommitMs: null,
      lastToolMs: null,
      phase: 'idle',
    });
    expect(r.action).toBe('wait');
    expect(r.reason).toBe('below-window');
  });

  it('fires when ctx_pct is in window and phase is idle', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 60,
      lastCommitMs: null,
      lastToolMs: null,
      phase: 'idle',
    });
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('window-open');
  });

  it('fires when ctx_pct in window and recent commit', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 58,
      lastCommitMs: BASE.now - 10_000,
      lastToolMs: BASE.now - 5_000,
      phase: 'thinking',
    });
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('window-open');
  });

  it('fires when ctx_pct in window and no tool call in last 30s', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 62,
      lastCommitMs: null,
      lastToolMs: BASE.now - 40_000,
      phase: 'thinking',
    });
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('window-open');
  });

  it('waits when in window but no stop point (recent tool, phase thinking, no commit)', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 60,
      lastCommitMs: null,
      lastToolMs: BASE.now - 5_000,
      phase: 'thinking',
    });
    expect(r.action).toBe('wait');
    expect(r.reason).toBe('no-stop');
  });

  it('phase permission counts as a stop point (awaiting-prompt)', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 60,
      lastCommitMs: null,
      lastToolMs: BASE.now - 5_000,
      phase: 'permission',
    });
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('window-open');
  });

  it('returns wrap when ctx_pct passes the window without a stop', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 72,
      lastCommitMs: null,
      lastToolMs: BASE.now - 5_000,
      phase: 'thinking',
    });
    expect(r.action).toBe('wrap');
    expect(r.reason).toBe('forced-no-stop');
  });

  it('returns fire with reason hard-ceiling at >= 90 percent regardless of stop point', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 92,
      lastCommitMs: null,
      lastToolMs: BASE.now - 1000,
      phase: 'thinking',
    });
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('hard-ceiling');
  });

  it('hard-ceiling beats wrap when both would otherwise apply', () => {
    const r = evaluateTrigger({
      ...BASE,
      ctxPct: 95,
      lastCommitMs: null,
      lastToolMs: BASE.now - 5_000,
      phase: 'thinking',
    });
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('hard-ceiling');
  });

  it('window bounds respect bandHalf', () => {
    const inLow = evaluateTrigger({
      ...BASE,
      ctxPct: 55,
      lastCommitMs: null,
      lastToolMs: null,
      phase: 'idle',
    });
    const justBelow = evaluateTrigger({
      ...BASE,
      ctxPct: 54.9,
      lastCommitMs: null,
      lastToolMs: null,
      phase: 'idle',
    });
    expect(inLow.action).toBe('fire');
    expect(justBelow.action).toBe('wait');
    expect(justBelow.reason).toBe('below-window');
  });
});
