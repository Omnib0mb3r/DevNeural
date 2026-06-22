/**
 * Calibrated confidence gate (DRIVE-QUEUE 5c). Pins the confidence tag
 * (hedging down, citations up) and the below-threshold -> verify hook
 * wired to the fact-validator (SHA exists, count matches).
 */
import { describe, expect, it } from 'vitest';
import {
  tagConfidence,
  shouldVerify,
  gateClaim,
} from '../src/lex/confidence-gate.js';

describe('tagConfidence', () => {
  it('drops confidence on hedging language', () => {
    const hedged = tagConfidence('I think the suite probably passes');
    expect(hedged.confidence).toBeLessThan(0.5);
    expect(hedged.signals).toContain('hedging');
  });
  it('raises confidence on a cited SHA / file:line', () => {
    const cited = tagConfidence('HEAD is bb7b720 per src/store/index-db.ts:42');
    expect(cited.confidence).toBeGreaterThan(0.7);
    expect(cited.signals).toContain('cites-sha');
  });
});

describe('shouldVerify', () => {
  it('verifies below the threshold, asserts at/above', () => {
    expect(shouldVerify(0.5, 0.7)).toBe(true);
    expect(shouldVerify(0.8, 0.7)).toBe(false);
  });
});

describe('gateClaim', () => {
  it('asserts directly when confidence is high', () => {
    const r = gateClaim('HEAD bb7b720 confirmed at src/x.ts:10');
    expect(r.action).toBe('assert');
    expect(r.needsVerify).toBe(false);
  });

  it('routes a low-confidence SHA claim to verify and runs the validator', () => {
    const r = gateClaim('I think HEAD is abc1234', {
      validators: { shaExists: (s) => s === 'abc1234' },
    });
    expect(r.action).toBe('verify');
    expect(r.needsVerify).toBe(true);
    const sha = r.checks.find((c) => c.kind === 'sha')!;
    expect(sha.ok).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('marks verified=false when the cited SHA does not exist', () => {
    const r = gateClaim('probably HEAD deadbeef', {
      validators: { shaExists: () => false },
    });
    expect(r.verified).toBe(false);
    expect(r.checks[0]!.detail).toMatch(/not found/i);
  });

  it('verifies a count claim against the fact-validator', () => {
    const ok = gateClaim('maybe 1388 tests pass', {
      validators: { countOf: (s) => (s === 'tests' ? 1388 : null) },
    });
    expect(ok.verified).toBe(true);
    const bad = gateClaim('maybe 1300 tests pass', {
      validators: { countOf: () => 1388 },
    });
    expect(bad.verified).toBe(false);
    expect(bad.checks[0]!.detail).toMatch(/mismatch/i);
  });

  it('verified=null when a low-confidence claim carries nothing checkable', () => {
    const r = gateClaim('I think it works', {});
    expect(r.needsVerify).toBe(true);
    expect(r.checks).toEqual([]);
    expect(r.verified).toBeNull();
  });
});
