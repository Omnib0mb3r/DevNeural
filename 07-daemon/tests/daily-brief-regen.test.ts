/**
 * Daily-brief staleness regeneration (2026-07-16 operator audit:
 * "dashboard brief is still stale, and refresh button does nothing").
 *
 * The whats-new digest only regenerated on the weekly lint cycle, so
 * the brief sat stale for days. The daily-brief route now regenerates
 * the digest (cheap file aggregation, no LLM) whenever it is missing
 * or older than the threshold; this pins the decision helper.
 */
import { describe, expect, it } from 'vitest';
import {
  shouldRegenerateWhatsNew,
  WHATS_NEW_REGEN_THRESHOLD_HOURS,
} from '../src/dashboard/daily-brief.js';

describe('shouldRegenerateWhatsNew', () => {
  it('regenerates when the digest file is missing (age null)', () => {
    expect(shouldRegenerateWhatsNew(null)).toBe(true);
  });

  it('regenerates past the threshold and not before it', () => {
    expect(shouldRegenerateWhatsNew(30)).toBe(true);
    expect(shouldRegenerateWhatsNew(2)).toBe(false);
    expect(shouldRegenerateWhatsNew(23.9)).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(shouldRegenerateWhatsNew(5, 4)).toBe(true);
    expect(shouldRegenerateWhatsNew(3, 4)).toBe(false);
  });

  it('defaults to a 24h threshold', () => {
    expect(WHATS_NEW_REGEN_THRESHOLD_HOURS).toBe(24);
  });
});
