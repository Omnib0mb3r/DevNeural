/**
 * Haiku voice talk-layer scaffold (pillar 3, sliver V1).
 *
 * Pins the flag + model config the rest of the pillar builds on. Default
 * OFF; model defaults to Anthropic Haiku, env-overridable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useVoiceHaiku,
  voiceHaikuConfig,
  VOICE_HAIKU_MODEL,
  daypartOf,
  buildLocalContext,
  localContextBlock,
} from '../src/voice/voice-haiku.js';

let priorFlag: string | undefined;

beforeEach(() => {
  priorFlag = process.env.DEVNEURAL_VOICE_HAIKU;
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = priorFlag;
});

describe('voice-haiku config', () => {
  it('is OFF by default', () => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
    expect(useVoiceHaiku()).toBe(false);
    expect(voiceHaikuConfig().enabled).toBe(false);
  });

  it('is ON when the flag is exactly "1"', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    expect(useVoiceHaiku()).toBe(true);
    expect(voiceHaikuConfig().enabled).toBe(true);
  });

  it('treats any non-"1" value as off', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = 'true';
    expect(useVoiceHaiku()).toBe(false);
  });

  it('defaults the talk-layer model to Anthropic Haiku', () => {
    expect(VOICE_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(voiceHaikuConfig().model).toBe('claude-haiku-4-5-20251001');
  });
});

/**
 * Local-context clock (2026-07-14). The fast-lane glue/bridge model and
 * the deterministic canned greeting fallback both need to know the
 * daemon's real local time so quick replies (especially greetings) are
 * time-aware instead of context-blind. daypartOf is pure so the boundary
 * hours are exact and don't depend on mocking the system clock.
 */
describe('daypartOf (coarse daypart boundaries)', () => {
  it('late night: 21:00-04:59', () => {
    expect(daypartOf(0)).toBe('late night');
    expect(daypartOf(4)).toBe('late night');
    expect(daypartOf(21)).toBe('late night');
    expect(daypartOf(23)).toBe('late night');
  });

  it('early morning: 05:00-06:59', () => {
    expect(daypartOf(5)).toBe('early morning');
    expect(daypartOf(6)).toBe('early morning');
  });

  it('morning: 07:00-11:59', () => {
    expect(daypartOf(7)).toBe('morning');
    expect(daypartOf(11)).toBe('morning');
  });

  it('afternoon: 12:00-16:59', () => {
    expect(daypartOf(12)).toBe('afternoon');
    expect(daypartOf(16)).toBe('afternoon');
  });

  it('evening: 17:00-20:59', () => {
    expect(daypartOf(17)).toBe('evening');
    expect(daypartOf(20)).toBe('evening');
  });

  it('exact boundary transitions', () => {
    expect(daypartOf(4)).toBe('late night');
    expect(daypartOf(5)).toBe('early morning');
    expect(daypartOf(6)).toBe('early morning');
    expect(daypartOf(7)).toBe('morning');
    expect(daypartOf(11)).toBe('morning');
    expect(daypartOf(12)).toBe('afternoon');
    expect(daypartOf(16)).toBe('afternoon');
    expect(daypartOf(17)).toBe('evening');
    expect(daypartOf(20)).toBe('evening');
    expect(daypartOf(21)).toBe('late night');
  });
});

describe('buildLocalContext / localContextBlock', () => {
  it('derives hour, minute, weekday, date, and daypart from the given clock', () => {
    /* 2026-07-14 is a Tuesday. */
    const now = new Date(2026, 6, 14, 9, 5, 0);
    const ctx = buildLocalContext(now);
    expect(ctx.hour).toBe(9);
    expect(ctx.minute).toBe(5);
    expect(ctx.weekday).toBe('Tuesday');
    expect(ctx.dateLabel).toBe('July 14, 2026');
    expect(ctx.daypart).toBe('morning');
    expect(ctx.timeLabel).toBe('09:05');
  });

  it('zero-pads the time label', () => {
    const ctx = buildLocalContext(new Date(2026, 0, 1, 5, 3, 0));
    expect(ctx.timeLabel).toBe('05:03');
  });

  it('the prompt block states the real time and instructs trusting the clock over the user', () => {
    const now = new Date(2026, 6, 14, 23, 30, 0);
    const block = localContextBlock(now);
    expect(block).toContain('LOCAL CONTEXT');
    expect(block).toContain('23:30');
    expect(block).toContain('Tuesday');
    expect(block).toContain('July 14, 2026');
    expect(block).toContain('late night');
    expect(block.toLowerCase()).toContain('gently correct');
  });

  it('defaults to the real clock when no Date is given', () => {
    const block = localContextBlock();
    expect(block).toContain('LOCAL CONTEXT');
  });
});
