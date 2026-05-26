/**
 * Smart-compact policy module (Fix 41 Stage 2).
 *
 * Pins the new Lex-facing wrapper evaluateTriggerForAnchor + the
 * stop-point classifier. The legacy evaluateTrigger contract is
 * exercised through the existing smart-compact-evaluate.test.ts and
 * smart-compact-routes.test.ts suites; this file focuses on the new
 * surface that consumes the /state endpoint shape.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateTrigger,
  evaluateTriggerForAnchor,
  policyDefaults,
  WRAP_AND_COMMIT_PROMPT,
  type PolicyState,
} from '../src/lex/smart-compact-policy.js';

describe('policyDefaults', () => {
  it('returns the documented defaults when no override is supplied', () => {
    const d = policyDefaults();
    expect(d.threshold).toBe(60);
    expect(d.bandHalf).toBe(5);
    expect(d.hardCeiling).toBe(90);
    expect(d.stopWindowMs).toBe(30_000);
  });

  it('allows per-field overrides without disturbing the others', () => {
    const d = policyDefaults({ threshold: 70, hardCeiling: 95 });
    expect(d.threshold).toBe(70);
    expect(d.hardCeiling).toBe(95);
    expect(d.bandHalf).toBe(5);
    expect(d.stopWindowMs).toBe(30_000);
  });
});

describe('WRAP_AND_COMMIT_PROMPT re-export', () => {
  it('still contains the canonical wrap prompt text so callers can grep on it', () => {
    expect(WRAP_AND_COMMIT_PROMPT).toMatch(/Wrap your current work/);
    expect(WRAP_AND_COMMIT_PROMPT).toMatch(/context refresh/);
  });
});

describe('evaluateTrigger (legacy contract still intact)', () => {
  it('hard ceiling fires regardless of stop point', () => {
    const r = evaluateTrigger({
      ctxPct: 92,
      threshold: 60,
      bandHalf: 5,
      hardCeiling: 90,
      stopWindowMs: 30_000,
      now: 1_000_000,
      lastCommitMs: null,
      lastToolMs: 999_900,
      phase: 'tool',
    });
    expect(r).toEqual({ action: 'fire', reason: 'hard-ceiling' });
  });

  it('below-window stays at wait', () => {
    const r = evaluateTrigger({
      ctxPct: 50,
      threshold: 60,
      bandHalf: 5,
      hardCeiling: 90,
      stopWindowMs: 30_000,
      now: 1_000_000,
      lastCommitMs: null,
      lastToolMs: null,
      phase: 'unknown',
    });
    expect(r).toEqual({ action: 'wait', reason: 'below-window' });
  });

  it('inside window + stop = fire(window-open)', () => {
    const r = evaluateTrigger({
      ctxPct: 60,
      threshold: 60,
      bandHalf: 5,
      hardCeiling: 90,
      stopWindowMs: 30_000,
      now: 1_000_000,
      lastCommitMs: 999_990, // 10ms ago
      lastToolMs: 999_990,
      phase: 'tool',
    });
    expect(r).toEqual({ action: 'fire', reason: 'window-open' });
  });

  it('inside window + no stop = wait(no-stop)', () => {
    const r = evaluateTrigger({
      ctxPct: 60,
      threshold: 60,
      bandHalf: 5,
      hardCeiling: 90,
      stopWindowMs: 30_000,
      now: 1_000_000,
      lastCommitMs: 500_000, // old commit
      lastToolMs: 999_990, // 10ms ago - mid-tool
      phase: 'tool',
    });
    expect(r).toEqual({ action: 'wait', reason: 'no-stop' });
  });

  it('above window + below ceiling = wrap(forced-no-stop)', () => {
    const r = evaluateTrigger({
      ctxPct: 70,
      threshold: 60,
      bandHalf: 5,
      hardCeiling: 90,
      stopWindowMs: 30_000,
      now: 1_000_000,
      lastCommitMs: 999_990,
      lastToolMs: 999_990,
      phase: 'tool',
    });
    expect(r).toEqual({ action: 'wrap', reason: 'forced-no-stop' });
  });
});

describe('evaluateTriggerForAnchor (Fix 41 Stage 2)', () => {
  const D = policyDefaults();
  const now = 1_000_000;

  it('null ctx_pct stays at wait/below-window with stop_point=n/a', () => {
    const state: PolicyState = {
      ctx_pct: null,
      last_commit_ms: null,
      last_tool_ms: null,
    };
    const r = evaluateTriggerForAnchor(state, D, { now });
    expect(r.action).toBe('wait');
    expect(r.reason).toBe('below-window');
    expect(r.stop_point).toBe('n/a');
  });

  it('below-window verdict carries stop_point=n/a (outside the band)', () => {
    const r = evaluateTriggerForAnchor(
      { ctx_pct: 30, last_commit_ms: now - 100, last_tool_ms: null },
      D,
      { now },
    );
    expect(r.action).toBe('wait');
    expect(r.reason).toBe('below-window');
    expect(r.stop_point).toBe('n/a');
  });

  it('hard-ceiling verdict carries stop_point=n/a', () => {
    const r = evaluateTriggerForAnchor(
      { ctx_pct: 91, last_commit_ms: null, last_tool_ms: now - 5 },
      D,
      { now, phase: 'tool' },
    );
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('hard-ceiling');
    expect(r.stop_point).toBe('n/a');
  });

  it('inside band + recent commit -> stop_point=recent_commit', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: now - 5_000,
        last_tool_ms: now - 5,
      },
      D,
      { now, phase: 'tool' },
    );
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('window-open');
    expect(r.stop_point).toBe('recent_commit');
  });

  it('inside band + idle tool (no commit) -> stop_point=idle_tool', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: null,
        last_tool_ms: now - 60_000, // older than 30s window
      },
      D,
      { now, phase: 'tool' },
    );
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('window-open');
    expect(r.stop_point).toBe('idle_tool');
  });

  it('inside band + last_tool_ms null -> stop_point=idle_tool (treats no tool as idle)', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: null,
        last_tool_ms: null,
      },
      D,
      { now, phase: 'tool' },
    );
    expect(r.action).toBe('fire');
    expect(r.stop_point).toBe('idle_tool');
  });

  it('inside band + idle phase (no commit, recent tool) -> stop_point=idle_phase', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: null,
        last_tool_ms: now - 5, // recent tool
      },
      D,
      { now, phase: 'idle' },
    );
    expect(r.action).toBe('fire');
    expect(r.stop_point).toBe('idle_phase');
  });

  it('inside band + no stop signals -> wait(no-stop) with stop_point=none', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: now - 10 * 60 * 1000, // 10 min old
        last_tool_ms: now - 5, // recent tool
      },
      D,
      { now, phase: 'tool' },
    );
    expect(r.action).toBe('wait');
    expect(r.reason).toBe('no-stop');
    expect(r.stop_point).toBe('none');
  });

  it('recent_commit wins priority over idle_tool when both are true', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: now - 5_000,
        last_tool_ms: null,
      },
      D,
      { now, phase: 'tool' },
    );
    expect(r.stop_point).toBe('recent_commit');
  });

  it('idle_tool wins priority over idle_phase when commit is null', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: null,
        last_tool_ms: now - 60_000,
      },
      D,
      { now, phase: 'idle' },
    );
    expect(r.stop_point).toBe('idle_tool');
  });

  it('above-window verdict (wrap) carries stop_point=n/a', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 70,
        last_commit_ms: now - 5,
        last_tool_ms: now - 5,
      },
      D,
      { now, phase: 'tool' },
    );
    expect(r.action).toBe('wrap');
    expect(r.reason).toBe('forced-no-stop');
    expect(r.stop_point).toBe('n/a');
  });

  it('phase defaults to unknown when not supplied (avoids stop_phase short-cut)', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 60,
        last_commit_ms: now - 5_000_000, // old commit
        last_tool_ms: now - 5, // recent tool
      },
      D,
      { now },
    );
    /* No recent commit, no idle tool, phase!=idle/permission -> wait(no-stop). */
    expect(r.action).toBe('wait');
    expect(r.reason).toBe('no-stop');
    expect(r.stop_point).toBe('none');
  });

  it('respects per-call defaults override (e.g. tighter band)', () => {
    const r = evaluateTriggerForAnchor(
      {
        ctx_pct: 58,
        last_commit_ms: now - 1_000,
        last_tool_ms: null,
      },
      policyDefaults({ threshold: 70 }),
      { now, phase: 'tool' },
    );
    /* Window is [65, 75] under the override; 58 is below. */
    expect(r.action).toBe('wait');
    expect(r.reason).toBe('below-window');
  });
});
